// electron/mail-triage-rules.ts
// 「邮件 · 待办」的**纯判定层**：主题 → 待办类型，主题/正文 → 订单号。
//
// 为什么单独成文件（2026-11-04）：
//   渲染层工程（tsconfig.json）把 tests/** 也纳入编译，单元测试要直接引用这些纯函数；
//   若它们和 `listMailTodos`（要 better-sqlite3 / electron/db.ts）同处一个模块，
//   一次 `import` 就会把 db.ts 拖进渲染层工程 —— 那边是 ESM，db.ts 的
//   `import Database = require(...)` 直接报 TS1202，而且 vitest 跑在 node 下
//   加载 Electron ABI 的原生模块会 ERR_DLOPEN。拆开后：**本文件零 import**。
//
// 三条铁律（照 AGENTS.md）：
//   1. **判定只认主题**：正文是 HTML 模板，改版即失效且无法回溯；主题是平台的稳定契约。
//   2. **规则表顺序有意义**：未付款关单必须被显式排除，否则会落到通用"关闭"上。
//   3. **正文取单号只认"订单"前缀**：正文里还有 CaseNo / Service No / 物流号，
//      同样是 15–16 位纯数字，取"第一个长数字"会稳定抓错且不报错。

/** 待办类型：罚单 / 纠纷仲裁 / 订单关闭 */
export type MailTodoKind = 'penalty' | 'dispute' | 'closed';

/**
 * 紧急度（只有三档）：
 *   3 = 有申诉期或正在等卖家举证，过窗口就没救
 *   2 = 已成事实但要核对（扣款 / 退款 / 客诉结论）
 *   1 = 已了结，仅作知会（协议取消）
 */
export type MailTodoSeverity = 1 | 2 | 3;

/** 单封邮件的判定结果 */
export interface MailTodoEvent {
  messageId: number;
  /** 状态短句，UI 直接显示（"罚单待申诉（有申诉期）"） */
  label: string;
  kind: MailTodoKind;
  severity: MailTodoSeverity;
  receivedAt: string;
  subject: string;
}

/**
 * 主题判定表。**顺序有意义**：
 *   罚单先分"还能申诉"和"已经判了"；卖家未发货关单要早于通用"关闭"；
 *   未付款关单必须**显式排除**（label 为空），不能让它落到通用"关闭"规则上。
 * 每条措辞都取自平台真实邮件（2026-11-04 本机 1423 封样本）。
 */
interface TodoRule {
  test: RegExp;
  kind: MailTodoKind;
  label: string;
  severity: MailTodoSeverity;
}

const RULES: TodoRule[] = [
  { test: /申诉失败|举证不成立|处罚已执行/, kind: 'penalty', label: '罚单申诉未通过（已处罚）', severity: 2 },
  { test: /罚单/, kind: 'penalty', label: '罚单待申诉（有申诉期）', severity: 3 },
  { test: /卖家未发货/, kind: 'closed', label: '卖家未发货被关单', severity: 2 },
  // label 为空 = 显式排除项；不是"忘了写"
  { test: /未付款/, kind: 'closed', label: '', severity: 1 },
  { test: /纠纷处理结果/, kind: 'dispute', label: '纠纷已出结果', severity: 2 },
  { test: /仲裁/, kind: 'dispute', label: '仲裁判决', severity: 2 },
  { test: /resolution\s+for\s+order/i, kind: 'dispute', label: '客诉请求已处理', severity: 2 },
  { test: /关闭/, kind: 'closed', label: '订单已关闭（协议取消）', severity: 1 },
];

/**
 * 判一封邮件是否属于待办。
 * @returns null = 不进待办（含"买家未付款自动关单"这类明确无关的）
 */
export function classifyMailTodo(subject: string): MailTodoEvent | null {
  const s = String(subject || '');
  if (!s) return null;
  for (const rule of RULES) {
    if (!rule.test.test(s)) continue;
    if (!rule.label) return null;
    return {
      messageId: 0,
      label: rule.label,
      kind: rule.kind,
      severity: rule.severity,
      receivedAt: '',
      subject: s,
    };
  }
  return null;
}

/**
 * 手工划掉的记号是否压住这条待办。
 *
 * 判据 = 当前最新那封的 id **不超过**划掉时的水位线（用 `<=` 不是 `<`）：
 * 划掉那一刻看到的就是水位线那封，它当然要被压住；只有比它更大的 id（= 划掉之后才到的邮件）
 * 才会浮出。这条判据是整件事里最容易写反的一处 —— 写成 `<` 会让"划掉的那封自己"反而漏出来，
 * 写成"永久压住"则会把罚单升级、纠纷判决这类后续进展静默吞掉。
 *
 * @param markMessageId 划掉时最新邮件的 id（0 = 脏数据 / 旧记号，压不住任何真实邮件）
 * @param latestMessageId 当前这条待办最新邮件的 id
 */
export function isTodoSuppressed(markMessageId: number, latestMessageId: number): boolean {
  const mark = Math.max(0, Math.trunc(Number(markMessageId) || 0));
  const latest = Math.max(0, Math.trunc(Number(latestMessageId) || 0));
  return latest <= mark;
}

/** 15–16 位订单号；前后不能再接数字（避免从 17 位串里截一段） */
const ORDER_NO = /(?<!\d)(\d{15,16})(?!\d)/;
/** 带业务前缀的订单号（主题/正文通用） */
const ORDER_NO_WITH_LABEL = /(?:订单号|订单|order\s*(?:id|no\.?|number)?)\s*[：:#]?\s*(\d{15,16})(?!\d)/i;

/** HTML → 纯文本：标签直接删掉（不插空格），避免数字被标签切成两段 */
function htmlToPlain(html: string): string {
  return String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

/**
 * 抽订单号：主题带前缀 → 主题裸号（主题是平台写的标题，整串只有一个号）→ 正文带前缀。
 *
 * 正文这一步**只认带"订单/order"前缀的数字，不取裸号**：正文里还有
 * `#CaseNo:1143809062350955#`（客服单号）、`Service No.`、物流单号，与订单号一样是
 * 15–16 位纯数字。取"第一个长数字"会稳定抓错，而且**看起来完全正常**（长度对、不报错）。
 * 用前缀做结构性约束比维护"哪些编号要剔除"的黑名单可靠：平台多一个字段就多一种噪声，
 * 而"订单号必然跟在'订单'后面"是它的语义契约。
 */
export function extractOrderNo(
  subject: string,
  html: string = '',
): { orderNo: string; source: 'subject' | 'body' | 'none' } {
  const s = String(subject || '');
  const withLabel = s.match(ORDER_NO_WITH_LABEL);
  if (withLabel) return { orderNo: withLabel[1], source: 'subject' };
  const bare = s.match(ORDER_NO);
  if (bare) return { orderNo: bare[1], source: 'subject' };

  if (html) {
    const fromBody = htmlToPlain(html).match(ORDER_NO_WITH_LABEL);
    if (fromBody) return { orderNo: fromBody[1], source: 'body' };
  }
  return { orderNo: '', source: 'none' };
}
