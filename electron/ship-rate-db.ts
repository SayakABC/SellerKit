// electron/ship-rate-db.ts
// 「运价表快照」数据访问层（宿主中立层）。
//
// 为什么需要它（2026-09-29）：运价表原先只以**当前那一份**存在运费岛的私有 storage 里，
// 报价单一更新，**历史订单的预测运费就跟着变** —— 预测要能复算，就必须留下"当时那份表"。
// 做法同 `ae_cost_map` 的生效区间：一次导入 = 一条快照，算账时按订单日期取"当时生效的那份"。
//
// 两个设计决定：
//   1. **只存归一化后的整张表**（`payload`，JSON）：运价表的形状本来就由 `src/lib/shipRate.ts`
//      归一化后才进存储，这里再拆列就成了第二套形状，只会漂移；
//   2. **按内容去重**（`content_key` = payload 摘要 UNIQUE）：同一张表反复导入只留一条，
//      否则每次点"导入"都堆一行，历史列表几周后就没法看了。
//
// 安全边界：本层只允许主进程内部使用；渲染层/岛经语义化 IPC 访问。

export {};

import { createHash } from 'crypto';
import { dbMigrate, dbRun, dbGet, dbQuery, dbTransaction } from './db';

/** 运价表快照行 */
export interface RateSnapshotRow {
  id: number;
  /** 生效日（yyyy-mm-dd）—— 导入当日；算账时按 `effective_from <= 订单日` 取最近一条 */
  effectiveFrom: string;
  sourceFile: string;
  sheetName: string;
  countries: number;
  cards: number;
  importedAt: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sr_rate_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT NOT NULL,
    source_file TEXT NOT NULL DEFAULT '',
    sheet_name TEXT NOT NULL DEFAULT '',
    countries INTEGER NOT NULL DEFAULT 0,
    cards INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    content_key TEXT NOT NULL UNIQUE,
    imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sr_rate_from ON sr_rate_snapshots(effective_from)`,
];

/** 幂等初始化（首次激活 / 每个 handler 入口调用）。将来本域若有演进步骤，在这里接 `migrate('ship-rate', …)`。 */
export function ensureShipRateSchema(): void {
  dbMigrate(SCHEMA);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 今天（yyyy-mm-dd，本地时区）—— 与 `orderCost.dateKey` 同口径 */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 落一条快照（按内容去重：同一张表反复导入只留一条）。
 * @param payload 归一化后的整张运价表（`RateTable`）
 * @returns created=false 表示内容已存在（幂等放行，不算错误）
 */
export function saveRateSnapshot(input: {
  table?: unknown;
  sourceFile?: unknown;
  sheetName?: unknown;
  effectiveFrom?: unknown;
}): { id: number; created: boolean; effectiveFrom: string } {
  ensureShipRateSchema(); // 入口自带建表（与 product-db 的 sku 系列同惯例，调用方无需记得先 ensure）
  const table = input?.table;
  if (!table || typeof table !== 'object') throw new Error('运价表缺失或结构不对');
  const payload = JSON.stringify(table);
  const key = sha256(payload);
  // 生效日：默认导入当日；显式传则以传入为准（将来若要"补录历史报价单"就有入口）
  const explicit = str(input?.effectiveFrom, 10).trim();
  const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(explicit) ? explicit : today();
  const sourceFile = str(input?.sourceFile, 500);
  const sheetName = str(input?.sheetName, 200);
  const stats = (table as { stats?: { countries?: unknown; cards?: unknown } }).stats ?? {};
  const countries = num(stats.countries);
  const cards = num(stats.cards);

  const existing = dbGet<{ id: number; effective_from: string }>(
    `SELECT id, effective_from FROM sr_rate_snapshots WHERE content_key = ?`,
    [key],
  );
  if (existing) {
    return { id: num(existing.id), created: false, effectiveFrom: String(existing.effective_from) };
  }
  const info = dbTransaction(() =>
    dbRun(
      `INSERT INTO sr_rate_snapshots
         (effective_from, source_file, sheet_name, countries, cards, payload, content_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [effectiveFrom, sourceFile, sheetName, countries, cards, payload, key],
    ),
  );
  return { id: Number(info.lastInsertRowid), created: true, effectiveFrom };
}

/** 快照列表（**不含 payload**：列表页/选择器不需要整张表，别把它拖过 IPC） */
export function listRateSnapshots(limit = 50): RateSnapshotRow[] {
  ensureShipRateSchema();
  const n = Math.min(Math.max(num(limit) || 50, 1), 200);
  return dbQuery<Record<string, unknown>>(
    `SELECT id, effective_from, source_file, sheet_name, countries, cards, imported_at
     FROM sr_rate_snapshots ORDER BY effective_from DESC, id DESC LIMIT ?`,
    [n],
  ).map((r) => ({
    id: num(r.id),
    effectiveFrom: String(r.effective_from ?? ''),
    sourceFile: String(r.source_file ?? ''),
    sheetName: String(r.sheet_name ?? ''),
    countries: num(r.countries),
    cards: num(r.cards),
    importedAt: String(r.imported_at ?? ''),
  }));
}

/**
 * 取"按日期算账要用"的快照（**含 payload**）：
 *   · 最近一份全部快照 —— 订单日期早于所有快照时用它（同 `ae_cost_map` 的回落规则：
 *     宁可用"当时已知的最早那份"，也不判成缺运价表）；
 *   · 以及每份快照的生效日，交给渲染层的纯函数按订单日期选（选择口径只留一份）。
 * @returns `[]` = 一条快照都没有 —— 调用方按"还没有运价表"处理。
 *   （M6 运价表回迁后宿主是唯一真源；渲染层「算钱」页对**已升级但还没迁过来的老库**
 *     保留一个版本期的读回退 —— 见 `src/modules/order-cost/OrderCostView.vue`。）
 */
export function rateSnapshotsForCalc(limit = 50): {
  id: number;
  effectiveFrom: string;
  sourceFile: string;
  sheetName: string;
  table: unknown;
}[] {
  ensureShipRateSchema();
  const n = Math.min(Math.max(num(limit) || 50, 1), 200);
  return dbQuery<Record<string, unknown>>(
    `SELECT id, effective_from, source_file, sheet_name, payload
     FROM sr_rate_snapshots ORDER BY effective_from DESC, id DESC LIMIT ?`,
    [n],
  ).map((r) => {
    let table: unknown = null;
    try {
      table = JSON.parse(String(r.payload ?? 'null'));
    } catch {
      table = null; // 坏 payload 降级为 null：调用方按"没这份表"处理，不炸整批
    }
    return {
      id: num(r.id),
      effectiveFrom: String(r.effective_from ?? ''),
      sourceFile: String(r.source_file ?? ''),
      sheetName: String(r.sheet_name ?? ''),
      table,
    };
  });
}