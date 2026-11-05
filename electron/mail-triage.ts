// electron/mail-triage.ts
// 「邮件 · 待办」的**数据层**：把命中规则的邮件按订单号收敛成一条待办。
//
// 判定与单号解析在 mail-triage-rules.ts（纯函数，可被单元测试直接引用）；
// 本文件只做 SQL 粗筛 + 归并 + 排序，并重新导出纯函数。
//
// 为什么需要待办（2026-11-04，本机 31 天 1423 封速卖通邮件实测）：
//   96% 是订单流水通知（新订单 / 风控通过 / 未付款关单 / 确认收货），
//   真正带期限或已产生损失的是三类：**罚单、纠纷·仲裁结论、订单关闭**，
//   而它们散落在上千封 "订单307…" 开头的通知里，肉眼必然漏。
//
// 无派生表：待办读时计算（1423 行里命中 ~40 行），不落库 ⇒ 不存在"原始邮件被 purge 后
// 待办表还在"的漂移。代价是每次重算，实测 <20ms。
//
// 唯一落库的是**用户手工划掉的记号**（`sk_mail_todo_dismissed`）：那是"人已经处理过了"
// 这个**事实**，邮件里没有、也算不出来，只能记。它只当覆盖层，不复制待办字段。

import { getDb } from './db';
import { ensureMailSchema } from './mail-db';
import {
  classifyMailTodo,
  extractOrderNo,
  isTodoSuppressed,
  type MailTodoEvent,
  type MailTodoKind,
  type MailTodoSeverity,
} from './mail-triage-rules';

export {
  classifyMailTodo,
  extractOrderNo,
  isTodoSuppressed,
  type MailTodoEvent,
  type MailTodoKind,
  type MailTodoSeverity,
};

/** 一条待办 = 一个订单（同一单多封相关邮件合并成一条） */
export interface MailTodoItem {
  /** 平台订单号；解析不出时为 `#<messageId>`（保证 key 唯一，不用空串） */
  orderNo: string;
  /** 订单号的真实来源：主题 / 正文；都没取到时为 'none' */
  orderNoSource: 'subject' | 'body' | 'none';
  /** 最新一条事件的类型与状态 */
  kind: MailTodoKind;
  label: string;
  severity: MailTodoSeverity;
  /** 最新一条事件（点击打开它） */
  messageId: number;
  subject: string;
  receivedAt: string;
  accountId: number;
  accountEmail: string;
  /** 同单全部相关事件（时间正序，含最新那条） */
  events: MailTodoEvent[];
  /** 已被用户手工划掉（且划掉之后没有新邮件） */
  dismissed: boolean;
  /** 划掉时间（ISO）；未划掉为空串 */
  dismissedAt: string;
  /**
   * 划掉之后同单又来了新邮件 ⇒ 本条**已自动浮出**。
   * 存在的意义是让"我刚划掉它怎么又回来了"有解释：不是划掉失效，是事情有新进展。
   */
  resurfaced: boolean;
}

export interface MailTodoResult {
  /** 全部（含已划掉），已划掉的排在最后 */
  items: MailTodoItem[];
  /** 还需要看的条数 = items 里未划掉的（= 旧语义的 orders） */
  orders: number;
  /** 被划掉的条数 */
  dismissed: number;
  /** 参与判定的邮件封数（含被合并的历史事件） */
  mails: number;
  /** 主题无单号且正文未缓存而无法归属的封数（诚实暴露缺口，不静默丢） */
  unattributed: number;
}

/**
 * SQL 粗筛：只捞可能命中的行（1423 → ~40），判定仍在 JS 里做 —— 规则只此一份。
 * LIKE 列表必须覆盖规则表里的每一类：**宽了没关系**（多捞的会被 classifyMailTodo 判掉），
 * 窄了就是静默丢一整类待办。
 */
const SQL_CANDIDATES = `
  SELECT m.id, m.account_id, a.email AS account_email, m.subject, m.received_at,
         b.html_body
    FROM sk_mail_messages m
    JOIN sk_mail_accounts a ON a.id = m.account_id
    LEFT JOIN sk_mail_bodies b ON b.message_id = m.id
   WHERE (m.subject LIKE '%罚单%'
       OR m.subject LIKE '%纠纷%'
       OR m.subject LIKE '%仲裁%'
       OR m.subject LIKE '%Resolution for Order%'
       OR m.subject LIKE '%关闭%'
       OR m.subject LIKE '%未发货%')
`;

const SEVERITY_ORDER: Record<MailTodoSeverity, number> = { 3: 0, 2: 1, 1: 2 };

/** 划掉记号的一次性快照（一行一单，量级不超过待办条数） */
function loadDismissals(): Map<string, { lastMessageId: number; dismissedAt: string }> {
  const rows = getDb()
    .prepare(`SELECT todo_key, last_message_id, dismissed_at FROM sk_mail_todo_dismissed`)
    .all() as Record<string, any>[];
  const map = new Map<string, { lastMessageId: number; dismissedAt: string }>();
  for (const r of rows) {
    map.set(String(r.todo_key || ''), {
      lastMessageId: Number(r.last_message_id) || 0,
      dismissedAt: String(r.dismissed_at || ''),
    });
  }
  return map;
}

/** 待办 key 的长度上限：订单号 16 位、`#<messageId>` 十几位，64 足够且能挡住异常入参 */
const TODO_KEY_MAX = 64;

/**
 * 手工划掉一条待办。
 * @param messageId 划掉那一刻**最新事件**的邮件 id —— 之后同单再来新邮件（id 更大）会自动浮出，
 *   所以划掉不会永久吞掉后续进展（罚单升级、纠纷判决这类必须重新看见）。
 */
export function dismissMailTodo(
  todoKey: string,
  messageId: number,
  kind: string = '',
): { dismissed: true; key: string } {
  ensureMailSchema();
  const key = String(todoKey || '')
    .trim()
    .slice(0, TODO_KEY_MAX);
  if (!key) throw new Error('invalid todo key');
  getDb()
    .prepare(
      `INSERT INTO sk_mail_todo_dismissed (todo_key, last_message_id, kind, dismissed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(todo_key) DO UPDATE SET
         last_message_id = excluded.last_message_id,
         kind = excluded.kind,
         dismissed_at = excluded.dismissed_at`,
    )
    .run(
      key,
      Math.max(0, Math.trunc(Number(messageId) || 0)),
      String(kind || '').slice(0, 24),
      new Date().toISOString(),
    );
  return { dismissed: true, key };
}

/** 撤销划掉（划错了 / 要重新跟进） */
export function restoreMailTodo(todoKey: string): { restored: number } {
  ensureMailSchema();
  const key = String(todoKey || '')
    .trim()
    .slice(0, TODO_KEY_MAX);
  if (!key) throw new Error('invalid todo key');
  const info = getDb().prepare(`DELETE FROM sk_mail_todo_dismissed WHERE todo_key = ?`).run(key);
  return { restored: Number(info?.changes) || 0 };
}

/**
 * 归集待办（读时计算，无副作用）。
 * @param accountIds 只算这些邮箱（空 = 全部）
 */
export function listMailTodos(accountIds: number[] = []): MailTodoResult {
  ensureMailSchema();
  const ids = accountIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const params: Record<string, any> = {};
  let sql = SQL_CANDIDATES;
  if (ids.length) {
    sql += ` AND m.account_id IN (${ids.map((_, i) => `@a${i}`).join(',')})`;
    ids.forEach((id, i) => {
      params[`a${i}`] = id;
    });
  }
  sql += ` ORDER BY m.received_at ASC, m.id ASC`;

  const rows = getDb().prepare(sql).all(params) as Record<string, any>[];

  interface Bucket {
    orderNo: string;
    source: 'subject' | 'body' | 'none';
    accountId: number;
    accountEmail: string;
    events: MailTodoEvent[];
  }
  const buckets = new Map<string, Bucket>();
  let mails = 0;
  let unattributed = 0;

  for (const row of rows) {
    const subject = String(row.subject || '');
    const base = classifyMailTodo(subject);
    if (!base) continue;
    mails += 1;

    const { orderNo, source } = extractOrderNo(subject, row.html_body);
    // 取不到单号：不合并、不丢弃，用 #id 单独成条（并计入缺口统计）
    const key = orderNo || `#${row.id}`;
    if (!orderNo) unattributed += 1;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        orderNo,
        source,
        accountId: Number(row.account_id) || 0,
        accountEmail: String(row.account_email || ''),
        events: [],
      };
      buckets.set(key, bucket);
    }
    bucket.events.push({
      ...base,
      messageId: Number(row.id) || 0,
      receivedAt: String(row.received_at || ''),
    });
  }

  const items: MailTodoItem[] = [];
  const dismissals = loadDismissals();
  for (const [key, bucket] of buckets) {
    // 事件已按 received_at 升序（SQL 排过），最后一条即最新
    const latest = bucket.events[bucket.events.length - 1];
    const mark = dismissals.get(bucket.orderNo || key);
    // 划掉只覆盖"划掉那一刻之前的事件"：之后的新邮件（id 更大）⇒ 浮出并标 resurfaced
    const overshadowed = !!mark && isTodoSuppressed(mark.lastMessageId, latest.messageId);
    items.push({
      orderNo: bucket.orderNo || key,
      orderNoSource: bucket.source,
      kind: latest.kind,
      label: latest.label,
      severity: latest.severity,
      messageId: latest.messageId,
      subject: latest.subject,
      receivedAt: latest.receivedAt,
      accountId: bucket.accountId,
      accountEmail: bucket.accountEmail,
      events: bucket.events,
      dismissed: overshadowed,
      dismissedAt: overshadowed ? mark!.dismissedAt : '',
      resurfaced: !!mark && !overshadowed,
    });
  }

  items.sort(
    (a, b) =>
      // 划掉的沉到最后：上面的分组/计数都按"未划掉"算，顺序跟着同一个判据走
      Number(a.dismissed) - Number(b.dismissed) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      String(b.receivedAt).localeCompare(String(a.receivedAt)),
  );

  const dismissedCount = items.filter((it) => it.dismissed).length;
  return {
    items,
    orders: items.length - dismissedCount,
    dismissed: dismissedCount,
    mails,
    unattributed,
  };
}
