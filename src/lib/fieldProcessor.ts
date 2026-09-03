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
export function applyFieldProcessor(
  records: RecordItem[],
  headers: string[],
  rules: ProcessingRule[],
): ProcessResult {
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

  for (const record of records) {
    for (const rule of enabledRules) {
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
          case 'jsExpression':
            result = processJsExpression(record.fields, rule);
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
    const num = parseFloat(val.replace(/[^0-9.\-]/g, ''));
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

function processJsExpression(
  fields: Record<string, string>,
  rule: ProcessingRule,
): string | null {
  const code = rule.config.code;
  if (!code) return null;

  // 安全沙箱：冻结 fields 副本 + strict mode 阻止污染全局
  const sandbox = Object.freeze({ ...fields });
  const fn = new Function('fields', `"use strict"; return (${code})`);
  const result = fn(sandbox);
  return result !== null && result !== undefined ? String(result) : null;
}
