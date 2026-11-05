/**
 * fieldProcessor.ts — 字段处理规则引擎
 *
 * 对 Excel 解析后的记录执行用户定义的规则，生成衍生字段。
 * 所有处理器是纯函数，不依赖 DOM 或 Node API。
 */
import type { RecordItem, ProcessingRule } from '../types';

/** 时长解析结果 */
interface Duration {
  value: number;
  unit: 'hours' | 'days' | 'weeks' | 'months';
}

// ============================================================
// 公开入口
// ============================================================

export interface ProcessResult {
  records: RecordItem[];
  newHeaders: string[];
  errors: { ruleId: string; message: string }[];
}

/**
 * 对所有记录执行已启用的规则，返回新记录和新增的列名
 * @param records - 原始记录数组（会被原地修改）
 * @param headers - 当前列名
 * @param rules - 已启用的规则（按 order 升序执行）
 * @returns 处理结果
 */
/** 单批送隔离窗口的记录数：太大则单次 IPC 载荷过大，太小则往返次数多 */
const EVAL_BATCH_SIZE = 500;

/** `jsExpression` 的求值器形状（隔离窗口返回「每行结果 + 每行错误」） */
export interface JsExpressionEvaluator {
  (
    rule: { id: string; code: string },
    fields: Record<string, string>[],
  ): Promise<{
    values: (string | null)[];
    errors: { index: number; message: string }[];
    /** 窗口累计的 CSP 违规次数（可选：注入实现不必提供） */
    cspViolations?: number;
  }>;
}

/**
 * 求值器注入点。
 * - 生产：不注入，懒取 `ipc.ruleEvalBatch`（主进程转交隔离窗口执行）；
 * - 测试/离线：注入本地实现，避免 vitest 依赖 Electron。
 *
 * 为什么不在本地用 `new Function` 兜底：那等于把 2026-11-04 审查里
 * 「插件经 jsExpression 拿到主窗口全量能力」的洞原样装回来。窗口起不来就明确报错。
 */
let injectedEvaluator: JsExpressionEvaluator | null = null;

export function setJsExpressionEvaluator(fn: JsExpressionEvaluator | null): void {
  injectedEvaluator = fn;
}

async function resolveEvaluator(): Promise<JsExpressionEvaluator> {
  if (injectedEvaluator) return injectedEvaluator;
  const { ruleEvalBatch } = await import('@/core/services/ipc');
  const viaIpc: JsExpressionEvaluator = async (rule, fields) => {
    const r = await ruleEvalBatch({ rule, fields });
    if (!r.success) throw new Error(r.error || '规则求值失败');
    return r.data ?? { values: [], errors: [], cspViolations: 0 }; // data 缺失时按"无结果"处理（不写字段）
  };
  injectedEvaluator = viaIpc;
  return viaIpc;
}

/**
 * 对所有记录执行已启用的规则，返回新记录和新增的列名。
 *
 * **按规则外提、记录内循环**（原实现是记录外层）：两者等价的前提是「行与行之间无依赖」——
 * 规则只经 `record.fields[targetField]` 传递，行内自洽。这样 `jsExpression` 能整批
 * 送隔离窗口（一次 IPC 跑 500 行），而不是每行往返一次。
 *
 * @param records - 原始记录数组（会被原地修改）
 * @param headers - 当前列名
 * @param rules - 规则全集（未启用的被过滤，按 order 升序执行）
 */
export async function applyFieldProcessor(
  records: RecordItem[],
  headers: string[],
  rules: ProcessingRule[],
): Promise<ProcessResult> {
  const errors: { ruleId: string; message: string }[] = [];
  const newHeaders: string[] = [];

  const enabledRules = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.order - b.order);

  // 收集所有目标字段名
  for (const rule of enabledRules) {
    if (!newHeaders.includes(rule.targetField)) {
      newHeaders.push(rule.targetField);
    }
  }

  for (const rule of enabledRules) {
    if (rule.type === 'jsExpression') {
      await runJsExpressionRule(records, rule, errors);
      continue;
    }
    for (const record of records) {
      try {
        let result: string | null = null;

        switch (rule.type) {
          case 'dateOffset':
            result = processDateOffset(record.fields, rule);
            break;
          case 'template':
            result = processTemplateConcat(record.fields, rule);
            break;
          case 'math':
            result = processMath(record.fields, rule);
            break;
        }

        if (result !== null) {
          record.fields[rule.targetField] = result;
        }
      } catch (e: any) {
        errors.push({ ruleId: rule.id, message: e.message });
      }
    }
  }

  return { records, newHeaders, errors };
}

/**
 * 一条 `jsExpression` 规则：分批送求值器，写回目标字段。
 *
 * 失败语义（有意为之）：某批编译失败 / 窗口故障 ⇒ 记一条错误并**结束这条规则**，
 * 但继续执行后续规则 —— 与改造前「单条规则抛错不影响其他规则」一致；也避免
 * 一条坏规则让整份导入全废。
 */
async function runJsExpressionRule(
  records: RecordItem[],
  rule: ProcessingRule,
  errors: { ruleId: string; message: string }[],
): Promise<void> {
  const code = rule.config?.code;
  if (!code) return; // 原实现：无 code 时不写字段（不是写空串）
  const evaluator = await resolveEvaluator();

  for (let start = 0; start < records.length; start += EVAL_BATCH_SIZE) {
    const slice = records.slice(start, start + EVAL_BATCH_SIZE);
    // 显式浅拷贝再送出（旧实现是 `Object.freeze({ ...fields })`，同款语义）：
    // 求值侧会冻结入参，若直接传原对象引用，回写时就会 "object is not extensible"。
    // 真实 IPC 路径下结构化克隆本来就会产生副本，但**不能依赖它** —— 本地注入实现没有克隆，
    // 依赖隐式语义会让同一份代码在两种环境下表现不同（首版就是这样红的）。
    const fields = slice.map((r) => ({ ...(r.fields ?? {}) }));
    let res: { values: (string | null)[]; errors: { index: number; message: string }[] };
    try {
      res = await evaluator({ id: rule.id, code }, fields as Record<string, string>[]);
    } catch (e: any) {
      errors.push({ ruleId: rule.id, message: e?.message || String(e) });
      return;
    }
    for (let i = 0; i < slice.length; i++) {
      const v = res.values?.[i];
      if (v !== null && v !== undefined) slice[i].fields[rule.targetField] = v;
    }
    for (const e of res.errors ?? []) {
      errors.push({ ruleId: rule.id, message: `第 ${start + e.index + 1} 行：${e.message}` });
    }
  }
}


/**
 * 计算两条规则配置的哈希值，用于检测规则变更
 */
export function computeRulesHash(rules: ProcessingRule[]): string {
  const relevant = rules.map((r) => ({
    id: r.id,
    enabled: r.enabled,
    targetField: r.targetField,
    type: r.type,
    config: r.config,
    order: r.order,
  }));
  return JSON.stringify(relevant);
}

// ============================================================
// dateOffset — 日期偏移计算
// ============================================================

function processDateOffset(
  fields: Record<string, string>,
  rule: ProcessingRule,
): string | null {
  const { sourceField, packageField, outputFormat } = rule.config;
  if (!sourceField || !packageField) return null;

  const dateStr = fields[sourceField];
  const durationStr = fields[packageField];
  if (!dateStr || !durationStr) return null;

  const baseDate = parseDate(dateStr);
  if (!baseDate) return null;

  const duration = parseDuration(durationStr);
  if (!duration) return null;

  const resultDate = addDuration(baseDate, duration);

  return formatDate(resultDate, outputFormat || 'YYYY-MM-DD HH:mm');
}

/** 尝试多种格式解析日期字符串 */
function parseDate(str: string): Date | null {
  // 尝试 ISO / "YYYY-MM-DD HH:mm" / "YYYY/MM/DD"
  const cleaned = str.trim();
  const date = new Date(cleaned);
  if (!isNaN(date.getTime())) return date;

  // 尝试 "YYYY-MM-DD HH:mm:ss" 格式（Safari 兼容）
  const match = cleaned.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match) {
    return new Date(
      parseInt(match[1]),
      parseInt(match[2]) - 1,
      parseInt(match[3]),
      parseInt(match[4] || '0'),
      parseInt(match[5] || '0'),
      parseInt(match[6] || '0'),
    );
  }

  return null;
}

/** 解析时长字符串，如 "24 Hours"、"3 Days"、"1 Week"、"2 Months" */
function parseDuration(str: string): Duration | null {
  const cleaned = str.trim().toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d|weeks?|w|months?|m|minutes?|mins?)$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unitStr = match[2];

  if (unitStr.startsWith('hour') || unitStr.startsWith('hr') || unitStr === 'h') {
    return { value, unit: 'hours' };
  }
  if (unitStr.startsWith('day') || unitStr === 'd') {
    return { value, unit: 'days' };
  }
  if (unitStr.startsWith('week') || unitStr === 'w') {
    return { value, unit: 'weeks' };
  }
  if (unitStr.startsWith('month')) {
    return { value, unit: 'months' };
  }
  if (unitStr.startsWith('minute') || unitStr.startsWith('min')) {
    return { value, unit: 'hours' }; // 统一转为小时
  }

  return null;
}

/** 给日期增加时长 */
function addDuration(date: Date, duration: Duration): Date {
  const result = new Date(date);

  switch (duration.unit) {
    case 'hours':
      result.setHours(result.getHours() + duration.value);
      break;
    case 'days':
      result.setDate(result.getDate() + duration.value);
      break;
    case 'weeks':
      result.setDate(result.getDate() + duration.value * 7);
      break;
    case 'months':
      result.setMonth(result.getMonth() + duration.value);
      break;
  }

  return result;
}

/** 格式化日期为指定格式 */
function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0');

  return format
    .replace('YYYY', date.getFullYear().toString())
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

// ============================================================
// template — 模板拼接（复用类似模板引擎的 {{字段}} 语法）
// ============================================================

function processTemplateConcat(
  fields: Record<string, string>,
  rule: ProcessingRule,
): string {
  const tmpl = rule.config.template || '';
  return tmpl.replace(/\{\{(.+?)\}\}/g, (_match, key: string) => {
    const trimmedKey = key.trim();
    return fields[trimmedKey] ?? `[字段缺失: ${trimmedKey}]`;
  });
}

// ============================================================
// math — 四则运算
// ============================================================

function processMath(
  fields: Record<string, string>,
  rule: ProcessingRule,
): string | null {
  const expr = rule.config.expression;
  if (!expr) return null;

  // 替换 ${var} 为字段值
  const resolved = expr.replace(/\$\{(.+?)\}/g, (_match, key: string) => {
    const trimmedKey = key.trim();
    const val = fields[trimmedKey];
    if (val === undefined || val === null) throw new Error(`字段缺失: ${trimmedKey}`);
    const num = parseFloat(val.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) throw new Error(`字段 "${trimmedKey}" 的值 "${val}" 无法转换为数字`);
    return num.toString();
  });

  const result = safeEval(resolved);
  return result !== null ? result.toString() : null;
}

/** 安全四则运算解析器 — 支持 + - * / 和括号 */
function safeEval(expr: string): number | null {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return null;
  let pos = 0;

  function peek(): string | null {
    return pos < tokens.length ? tokens[pos] : null;
  }

  function consume(): string {
    return tokens[pos++];
  }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseMulDiv();
      if (op === '+') left += right;
      else left -= right;
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parseAtom();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const right = parseAtom();
      if (op === '*') left *= right;
      else if (right === 0) throw new Error('除零错误');
      else left /= right;
    }
    return left;
  }

  function parseAtom(): number {
    const t = peek();
    if (t === '(') {
      consume(); // '('
      const val = parseAddSub();
      if (peek() !== ')') throw new Error('缺少闭合括号');
      consume(); // ')'
      return val;
    }
    if (t === '-') {
      consume();
      return -parseAtom();
    }
    const num = parseFloat(consume());
    if (isNaN(num)) throw new Error(`无法解析表达式: ${expr}`);
    return num;
  }

  const result = parseAddSub();
  if (pos < tokens.length) throw new Error(`表达式解析不完整: ${expr}`);
  return result;
}

/** 将表达式拆分为 token 数组 */
function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  const re = /\s*([+\-*/()]|[0-9]+(?:\.[0-9]+)?)\s*/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = re.exec(expr)) !== null) {
    if (match.index !== lastIndex) throw new Error(`无法解析的字符: "${expr.slice(lastIndex, match.index)}"`);
    tokens.push(match[1]);
    lastIndex = re.lastIndex;
  }

  if (lastIndex < expr.length) throw new Error(`无法解析的字符: "${expr.slice(lastIndex)}"`);
  return tokens;
}

// ============================================================
// jsExpression — 自定义 JS 表达式
// ============================================================
//
// 实现已移出本文件（2026-11-04）：本地那份 `new Function` 跑在**主窗口**，
// 而主窗口是唯一持有完整 `window.electronAPI` 的上下文 —— 市场分发的 UI 岛可经
// `excel-copy.applyRules` 把任意 code 送到这里执行，等于把「声明 db 能力」放大成
// 「读写白名单文件 + 读全部业务数据 + 无限制外带」。
//
// 现在由 `runJsExpressionRule` 送 `electron/rule-eval-window.ts` 的隔离窗口求值：
// 该窗口无 electronAPI、CSP `connect-src 'none'`、单次 2s 超时。
// **不要**为了省事在这里加回 `new Function` / `eval` —— 主窗口随后收紧到
// `script-src 'self'`（index.html），加回来会直接 EvalError。

