// electron/ae-db.ts
// 「速卖通订单采集 / 成本衔接」数据访问层（基于 electron/db.ts 公共层）。
//
// 本域职责（2026-10-15 清理后）：
//   - 采集入站订单**不落本域表**：`upsertOrderBatch` 读 `ae_rates` 把整帧折算为 CNY 分后，
//     经 `order-db.upsertCollectedOrder` 写订单主干 `oi_orders`（C1 合并：唯一订单主干）；
//   - ae_rates        外币→CNY 汇率（成本/收入 CNY 计价需它）；
//   - ae_settle_lines 平台「订单明细」导出的结算切片，靠 `order_no` 与订单域对齐。
//
// ⚠️ 2026-10-21（C2）退役 `ae_cost_map`：成本改为产品行「当前进价」+ 订单明细行
//    「进价（预估）/ 实际进价」两个字段，本域不再建这张表。存量库的表由
//    `order.main` v10 删除 —— **必须排在 v9（从旧价目表回填预估）之后**。
//    v1 迁移保留（冻结）：只服务"升级时库里还留着旧主键形状"的历史库。
//
// ⚠️ 2026-10-15 删除弃表：`ae_orders` / `ae_order_lines` / `ae_fees`（旧采集落库，C1 合并后零写入）
//    及其读取入口 `listOrders` / `getAeSummary` 与利润引擎 `ae-engine.ts` —— 均无存活消费者
//    （订单明细/利润统计页已并入宿主「算钱」，口径在渲染层 `src/lib/orderCost.ts` 组合）。
//
// 协议字段与 schema 权威定义：docs/features/PROFIT_TRACKER.md §5/§6；金额语义见 §4（收入侧/费用侧分列，不预摊）。
// schema 兼容：ae-order/v1（旧帧，顶层 platformFee/logisticsFee/refundAmount → fees 科目）与
//              ae-order/v2（结构化 fees 数组，见 AeIngestFee）。

export {};

import {
  initDb,
  dbMigrate,
  dbGet,
  dbRun,
  dbQuery,
  dbTransaction,
  migrate,
  type MigrationStep,
} from './db';
import {
  AE_DEDUCTION_CATEGORIES,
  lineIncomeShares,
  orderIncomeCcy,
  parseSkuProps,
  toCentsCny,
} from './aeMoney';
import { upsertCollectedOrder } from './order-db';

/** 利润基准币：外币经 `ae_rates` 折算到它；本币恒 1:1 */
const BASE_CURRENCY = 'CNY';

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/** 费用科目 key（宽松白名单：未知科目同样入库，仅前端字典缺失 label） */
export type AeFeeCategory =
  | 'platform_commission' // 平台佣金
  | 'logistics_fee' // 物流费-卖家承担
  | 'payment_channel' // 支付通道费
  | 'refund' // 退款/纠纷调整（收入扣减类）
  | (string & {}); // 未来科目：宽容接收，不在此枚举也能入库

/** 订单级费用条目（v2 帧 fee 数组元素；条目内未知字段宽容保留） */
export interface AeIngestFee {
  category?: string;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface AeIngestLine {
  productId?: string;
  skuId?: string;
  /** 商品标题（可含款号等描述） */
  title?: string;
  skuProps?: string;
  /** M1 成本衔接键：扩展详情采集的「商家编码/货号」（= 采购款编码时即可命中成本表） */
  styleCode?: string;
  qty?: number;
  unitPrice?: number;
  goodsAmount?: number;
  [key: string]: unknown;
}

/**
 * 扩展/CSV 推入的单条订单（JSON 帧内对象，snake→camel）。
 * v1 兼容：platformFee/logisticsFee/refundAmount 顶层便捷字段会被映射为 fees 科目行。
 * 宽容：未知字段一律保留（进 raw_json 快照），主程序不因新字段拒绝旧版本协同。
 */
export interface AeIngestOrder {
  orderId: string;
  shopName?: string;
  site?: string;
  orderTime?: string;
  status?: string;
  currency?: string;
  goodsAmount?: number;
  shippingIncome?: number;
  /** 数据来源（extension / csv / curl 调试） */
  source?: string;
  /** v1 兼容便捷费用字段（sanitize 阶段映射进 fees，不再落独立列） */
  platformFee?: number;
  logisticsFee?: number;
  refundAmount?: number;
  fees?: AeIngestFee[];
  lines?: AeIngestLine[];
  [key: string]: unknown;
}

export interface AeUpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  /**
   * 本批里**因缺汇率**而金额落 NULL 的订单数（外币帧在 `ae_rates` 查不到）。
   *
   * 为什么要单独回一个数：缺汇率时 `amount_cents` 只能是 NULL（`null` = "算不出来"，
   * 不能写 0 —— 0 会让"缺收入"看起来像"收入为零"）。但那样**入站回执只说 `ok:true`**，
   * 扩展/用户以为整批都收好了，实际有一半订单永远算不出利润（本仓「静默失败三件套」）。
   * 有了这个计数，接收端能把"这批有 N 单缺汇率"说出口，指路去「成本与汇率」补一条即可重推。
   */
  rateMissing: number;
}

// ---- 表结构 ----

/**
 * 成本行在「无生效日信息」时的基准日。
 * 取一个早于任何真实业务日期的哨兵值：迁移存量行时用它，保证迁移瞬间**所有历史订单仍命中同一行**
 * （毛利结果不变）。若改用 last_biz_date，早于该日的订单会落空 → 毛利出现回归。见 P4a / D5。
 */
const COST_LEGACY_FROM = '0000-01-01';

/**
 * **冻结的旧表 DDL** —— 只被 v1 迁移（`migrateCostMapIntervals`）用来重建历史库的旧形状。
 * 新库不再建这张表（C2 退役，见文件头）；**不要**把它加回 `SCHEMA`。
 *
 * 成本表 DDL（P4a / D5 改造后）：从「每 style_code 一行、覆盖式」改为
 * 「多行 + 生效区间」。主键含 `source`，使**同 (style_code, effective_from) 上
 * manual 与 purchase 可并存**，由读取侧按「manual 优先」择一。
 */
const COST_MAP_DDL = `CREATE TABLE IF NOT EXISTS ae_cost_map (
    style_code TEXT NOT NULL,
    effective_from TEXT NOT NULL DEFAULT '${COST_LEGACY_FROM}',
    source TEXT NOT NULL DEFAULT 'purchase',
    style_name TEXT NOT NULL DEFAULT '',
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_biz_date TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (style_code, effective_from, source)
  )`;

const SCHEMA = [
  // ---- 汇率（成本 CNY 计价需外币→CNY） ----
  // `ae_rates`：一行 = 一个外币币种 → CNY 的**当前**汇率（PK `from_currency`）。
  // 归属 ae 域（`electron/ae-db.ts`）；写 = 启动种子（`seedDefaultRates`）+ 设置页 `setAeRate`；
  // 读 = 采集入站折算（`upsertOrderBatch`，缺汇率即金额 NULL）与「算钱」页汇率列表。
  // 只留当前值、不存历史版本 —— 历史成本以订单行落库的 `cost_cents` 为准。
  // ⚠️ 这里**不再有** `ae_cost_map`（C2 退役）：新库不该再长出这张表；
  //    存量库由 `order.main` v10 删除（顺序见文件头）。
  `CREATE TABLE IF NOT EXISTS ae_rates (
    -- 用途：外币→CNY 当前汇率（ae 域/成本折算）。写 = 启动种子 + 设置页；读 = 采集折算与「算钱」页。只存当前值。
    from_currency TEXT PRIMARY KEY,
    rate_to_cny REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // ---- 「结算明细」导入（2026-09-29）----
  // 来源：AE 后台导出的「订单明细」Excel（真实样本 2 表 / 200 单 / 412 行）。与浏览器扩展采集的订单帧
  // （现落订单主干 `oi_orders`）是**两条源**：扩展推的是采集帧，本表是平台导出的**结算切片**，
  // 靠 `order_no` 与订单域对齐。
  //
  // 粒度：一张表装两个切片，靠 `line_type` + `item_id` 区分 —— **商品级行**（`item_id` 非空，一行=一个商品）
  // 与**订单级行**（`item_id` 空）。实测口径：订单级行的 `成交金额` 是**整单**（含买家付的运费那部分），
  // 商品行的只是**商品部分**（样例 87.15 vs 114.52；全表合计 7833.61 vs 29407.01）→
  // **两类行不能相加**，订单口径一律取订单级行（见 `settleOrders`）。
  //
  // 费用按 JSON 存（科目 → 分）：科目会增减（实测已八项 + 各自"退回"），科目化后加科目**零 ALTER**。
  //
  // 生命周期：写 = 仅 `importSettleLines`（「结算明细」导入，幂等键 `UNIQUE(order_no,item_id,sku_id)`）；
  // 读 = `settleOrders`（按订单聚合）与结算统计；与订单域只靠 `order_no` **软对齐**，无外键。
  `CREATE TABLE IF NOT EXISTS ae_settle_lines (
    -- 用途：AE 平台结算明细切片（商品级行 + 订单级行两种，靠 order_no 与订单域软对齐；两类行不可相加）。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL,
    item_id TEXT NOT NULL DEFAULT '',
    sku_id TEXT NOT NULL DEFAULT '',
    line_type TEXT NOT NULL DEFAULT 'item',
    qty INTEGER NOT NULL DEFAULT 1,
    currency TEXT NOT NULL DEFAULT '',
    settle_status TEXT NOT NULL DEFAULT '',
    pending_reason TEXT NOT NULL DEFAULT '',
    expected_payout_at TEXT NOT NULL DEFAULT '',
    pay_time TEXT NOT NULL DEFAULT '',
    ship_time TEXT NOT NULL DEFAULT '',
    receive_time TEXT NOT NULL DEFAULT '',
    biz_mode TEXT NOT NULL DEFAULT '',
    deal_cents INTEGER NOT NULL DEFAULT 0,
    pending_amount_cents INTEGER NOT NULL DEFAULT 0,
    payout_cents INTEGER NOT NULL DEFAULT 0,
    net_income_cents INTEGER NOT NULL DEFAULT 0,
    split_cents INTEGER NOT NULL DEFAULT 0,
    refund_in_cents INTEGER NOT NULL DEFAULT 0,
    refund_after_cents INTEGER NOT NULL DEFAULT 0,
    fee_cents TEXT NOT NULL DEFAULT '{}',
    fee_refund_cents TEXT NOT NULL DEFAULT '{}',
    imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(order_no, item_id, sku_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ae_settle_order ON ae_settle_lines(order_no)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_settle_status ON ae_settle_lines(settle_status)`,
];

/** 幂等初始化：迁移 + 建表/索引 + 默认汇率种子（应用启动 / 首次使用自动调用） */
export function ensureAeSchema(): void {
  initDb();
  // house convention：**自定义迁移先跑，再 dbMigrate(SCHEMA)** ——
  // 存量库的 ae_cost_map 可能是旧主键形状（`CREATE TABLE IF NOT EXISTS` 对它无动作）必须先重建；
  // 重建会连带换掉挂在旧表上的索引，故索引交给末尾的 dbMigrate 建（该索引随表退役已删）。
  migrate('ae.main', aeMigrationSteps());
  dbMigrate(SCHEMA);
  seedDefaultRates();
}

/** `ae_*` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`） */
function aeMigrationSteps(): MigrationStep[] {
  return [
    // v1 保留（冻结）：未跑过 v1 的历史库可能还留着旧主键形状；重建后立即由 order.main v10 删掉。
    { version: 1, name: 'ae_cost_map 改「多行 + 生效区间」复合主键', up: migrateCostMapIntervals },
    // v2（ae_order_lines 补 style_code）随该表一并删除：表已弃用，补列无意义。
    // v3：删除 C1 合并后零写入的旧采集表（采集入口早已改写 `oi_orders`）。
    { version: 3, name: '删弃表 ae_orders / ae_order_lines / ae_fees', up: dropLegacyOrderTables },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════════
// 「结算明细」（ae_settle_lines）：AE 后台导出的订单明细 → 幂等落库 + 按订单聚合
// ═══════════════════════════════════════════════════════════════════════════════════
//
// 解析在渲染层（`src/lib/settleImport.ts`，含两条等式校验），本层只负责**归一 + 落库 + 聚合**。
// 归一策略与 `upsertSkuMappings` 一致：能存的照存，**行级错误逐行记 failed**，不整批回滚。

/** 结算明细行（渲染层解析后送来；形状与 `src/lib/settleImport.ts` 的 `SettleLine` 对应，两端各自声明） */
export interface AeSettleLineInput {
  orderNo: string;
  itemId?: string;
  skuId?: string;
  qty?: number;
  currency?: string;
  settleStatus?: string;
  pendingReason?: string;
  expectedPayoutAt?: string;
  payTime?: string;
  shipTime?: string;
  receiveTime?: string;
  bizMode?: string;
  dealCents?: number;
  pendingAmountCents?: number;
  payoutCents?: number;
  netIncomeCents?: number;
  splitCents?: number;
  refundInCents?: number;
  refundAfterCents?: number;
  feeCents?: Record<string, number>;
  feeRefundCents?: Record<string, number>;
}

export interface AeSettleOrderRow {
  orderNo: string;
  settleStatus: string;
  pendingReason: string;
  dealCents: number;
  netIncomeCents: number;
  splitCents: number;
  /** 费用合计（八类之和，分） */
  feeSumCents: number;
  /** 该单的商品行数 */
  itemLines: number;
  /**
   * 商品行**件数明细**（只含 `item_id <> ''` 的行）：`lines` = 该 (订单,商品) 的商品行数。
   * 消费侧（订单利润页）只在 `lines === 1` 时把 `qty` 当成"这一件的件数"用 —— 多行 = 同一商品的
   * 不同 SKU，把合计给到每一行会翻倍（见 `src/lib/orderCost.ts` 的件数优先级）。
   */
  items: { itemId: string; lines: number; qty: number }[];
  /** 汇总取自哪类行：`order` = 订单级行（权威，含买家付的运费那部分）；`items` = 无订单级行时退化为商品行求和 */
  from: 'order' | 'items';
}

function settleText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function settleInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function settleFeeJson(v: unknown): string {
  if (!v || typeof v !== 'object') return '{}';
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(val);
    if (Number.isFinite(n) && n !== 0) out[settleText(k, 40)] = Math.trunc(n);
  }
  return JSON.stringify(out);
}

function parseFeeJson(text: unknown): Record<string, number> {
  try {
    const v = JSON.parse(String(text ?? '{}'));
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * 落库（幂等）：键 = `(order_no, item_id, sku_id)`；已存在则整行更新。
 * 行级错误逐行记 `failed`（**不整批回滚**）——与 `upsertSkuMappings` / `importProducts` 同策略。
 */
export function upsertSettleLines(rows: AeSettleLineInput[]): {
  created: number;
  updated: number;
  failed: { orderNo: string; message: string }[];
} {
  ensureAeSchema();
  const list = Array.isArray(rows) ? rows : [];
  const out = { created: 0, updated: 0, failed: [] as { orderNo: string; message: string }[] };

  dbTransaction(() => {
    for (const r of list) {
      const orderNo = settleText(r?.orderNo, 64);
      try {
        if (!orderNo) throw new Error('订单号为空');
        const itemId = settleText(r?.itemId, 64);
        const skuId = settleText(r?.skuId, 64);
        // 行类型**由 item_id 是否为空决定**（不信任入参自报的 lineType，避免"标错类型 → 聚合重复计入"）
        const lineType = itemId ? 'item' : 'order';
        const values = [
          orderNo,
          itemId,
          skuId,
          lineType,
          Math.max(1, settleInt(r?.qty) || 1),
          settleText(r?.currency, 12),
          settleText(r?.settleStatus, 40),
          settleText(r?.pendingReason, 60),
          settleText(r?.expectedPayoutAt, 40),
          settleText(r?.payTime, 40),
          settleText(r?.shipTime, 40),
          settleText(r?.receiveTime, 40),
          settleText(r?.bizMode, 12),
          settleInt(r?.dealCents),
          settleInt(r?.pendingAmountCents),
          settleInt(r?.payoutCents),
          settleInt(r?.netIncomeCents),
          settleInt(r?.splitCents),
          settleInt(r?.refundInCents),
          settleInt(r?.refundAfterCents),
          settleFeeJson(r?.feeCents),
          settleFeeJson(r?.feeRefundCents),
        ];
        const existed = dbGet<{ id: number }>(
          `SELECT id FROM ae_settle_lines WHERE order_no = ? AND item_id = ? AND sku_id = ?`,
          [orderNo, itemId, skuId],
        );
        dbRun(
          `INSERT INTO ae_settle_lines
             (order_no, item_id, sku_id, line_type, qty, currency, settle_status, pending_reason,
              expected_payout_at, pay_time, ship_time, receive_time, biz_mode, deal_cents,
              pending_amount_cents, payout_cents, net_income_cents, split_cents,
              refund_in_cents, refund_after_cents, fee_cents, fee_refund_cents)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(order_no, item_id, sku_id) DO UPDATE SET
             line_type = excluded.line_type, qty = excluded.qty, currency = excluded.currency,
             settle_status = excluded.settle_status, pending_reason = excluded.pending_reason,
             expected_payout_at = excluded.expected_payout_at, pay_time = excluded.pay_time,
             ship_time = excluded.ship_time, receive_time = excluded.receive_time,
             biz_mode = excluded.biz_mode, deal_cents = excluded.deal_cents,
             pending_amount_cents = excluded.pending_amount_cents, payout_cents = excluded.payout_cents,
             net_income_cents = excluded.net_income_cents, split_cents = excluded.split_cents,
             refund_in_cents = excluded.refund_in_cents, refund_after_cents = excluded.refund_after_cents,
             fee_cents = excluded.fee_cents, fee_refund_cents = excluded.fee_refund_cents,
             imported_at = datetime('now','localtime')`,
          values,
        );
        if (existed) out.updated++;
        else out.created++;
      } catch (e) {
        out.failed.push({
          orderNo: orderNo || '(空)',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  return out;
}

/**
 * 按订单聚合（供利润页的**精准轨**）：
 *   · **优先取订单级行**（`item_id` 为空）—— 它的 `成交金额`/`净收入` 是**整单**口径（含买家付的运费那部分），
 *     实测与商品行合计相差数倍（87.15 vs 114.52；全表 7833.61 vs 29407.01）→ **两类行绝不可相加**；
 *   · 没有订单级行时才退化为商品行求和，并把 `from` 标成 `items`（让调用方知道口径不同）。
 * 顺带给出**商品行件数明细**（`items`）：件数是拣货口径的真值，但它按 (订单,商品) 聚合 ——
 * 同商品多 SKU 时合计对每一行都不可复用，故**把行数一并交出去**，由消费侧决定敢不敢用。
 * @param orderNos 订单号列表（上限 2000，超出截断）
 */
export function settleOrders(orderNos: string[]): AeSettleOrderRow[] {
  ensureAeSchema();
  const nos = [...new Set((Array.isArray(orderNos) ? orderNos : []).map((x) => settleText(x, 64)))]
    .filter(Boolean)
    .slice(0, 2000);
  if (!nos.length) return [];

  const rows = dbQuery<Record<string, unknown>>(
    `SELECT order_no, item_id, settle_status, pending_reason, deal_cents, net_income_cents,
            split_cents, qty, fee_cents
     FROM ae_settle_lines WHERE order_no IN (${nos.map(() => '?').join(',')})`,
    nos,
  );
  const byOrder = new Map<string, AeSettleOrderRow>();
  for (const r of rows) {
    const orderNo = String(r.order_no ?? '');
    const itemId = String(r.item_id ?? '');
    const feeSum = Object.values(parseFeeJson(r.fee_cents)).reduce((a, b) => a + settleInt(b), 0);
    const cur = byOrder.get(orderNo) ?? {
      orderNo,
      settleStatus: '',
      pendingReason: '',
      dealCents: 0,
      netIncomeCents: 0,
      splitCents: 0,
      feeSumCents: 0,
      itemLines: 0,
      items: [] as { itemId: string; lines: number; qty: number }[],
      from: 'items' as const,
    };
    if (itemId) {
      cur.itemLines++;
      const qty = settleInt(r.qty);
      const it = cur.items.find((x) => x.itemId === itemId);
      if (it) {
        it.lines++;
        it.qty += qty;
      } else {
        cur.items.push({ itemId, lines: 1, qty });
      }
    } else {
      // 订单级行：整单口径，覆盖式取（权威）
      cur.settleStatus = String(r.settle_status ?? '');
      cur.pendingReason = String(r.pending_reason ?? '');
      cur.dealCents = settleInt(r.deal_cents);
      cur.netIncomeCents = settleInt(r.net_income_cents);
      cur.splitCents = settleInt(r.split_cents);
      cur.feeSumCents = feeSum;
      cur.from = 'order';
    }
    if (cur.from === 'items') {
      // 没有订单级行（或还没扫到）：退化求和
      cur.dealCents += settleInt(r.deal_cents);
      cur.netIncomeCents += settleInt(r.net_income_cents);
      cur.splitCents += settleInt(r.split_cents);
      cur.feeSumCents += feeSum;
      if (!cur.settleStatus) {
        cur.settleStatus = String(r.settle_status ?? '');
        cur.pendingReason = String(r.pending_reason ?? '');
      }
    }
    byOrder.set(orderNo, cur);
  }
  return [...byOrder.values()];
}

/** 结算明细概览（导入结果/诊断展示） */
export function settleStats(): {
  lines: number;
  orders: number;
  itemLines: number;
  orderLines: number;
  pendingOrders: number;
  settledOrders: number;
  lastImportedAt: string;
} {
  ensureAeSchema();
  const total = num2(dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ae_settle_lines`)?.c);
  const itemLines = num2(
    dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ae_settle_lines WHERE item_id <> ''`)?.c,
  );
  const orderLines = num2(
    dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ae_settle_lines WHERE item_id = ''`)?.c,
  );
  const orders = num2(
    dbGet<{ c: number }>(`SELECT COUNT(DISTINCT order_no) AS c FROM ae_settle_lines`)?.c,
  );
  const settledOrders = num2(
    dbGet<{ c: number }>(
      `SELECT COUNT(DISTINCT order_no) AS c FROM ae_settle_lines WHERE settle_status LIKE '%已结算%'`,
    )?.c,
  );
  const last = dbGet<{ t: string }>(
    `SELECT MAX(imported_at) AS t FROM ae_settle_lines`,
  );
  return {
    lines: total,
    orders,
    itemLines,
    orderLines,
    pendingOrders: Math.max(0, orders - settledOrders),
    settledOrders,
    lastImportedAt: String(last?.t ?? ''),
  };
}

function num2(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 旧库增量（P4a / D5）：ae_cost_map 旧形状为 `style_code TEXT PRIMARY KEY`（一款一行），
 * 新形状为 `(style_code, effective_from, source)` 复合主键（一款多行、带生效区间）。
 * SQLite 不支持改主键 → 走「rename → create → copy → drop」，整体在事务内，失败自动回滚。
 *
 * 存量行补 `effective_from = COST_LEGACY_FROM`（不是 `last_biz_date`）—— 理由见该常量注释：
 * 补成 last_biz_date 会让早于该日的订单取不到成本，属于回归。
 *
 * 幂等判定：`effective_from` 列是否存在。新库（表不存在）直接跳过。
 */
function migrateCostMapIntervals(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(ae_cost_map)`);
  if (cols.length === 0 || cols.some((c) => c.name === 'effective_from')) return;
  dbTransaction(() => {
    dbRun(`DROP TABLE IF EXISTS ae_cost_map_legacy_struct`);
    dbRun(`ALTER TABLE ae_cost_map RENAME TO ae_cost_map_legacy_struct`);
    dbRun(COST_MAP_DDL);
    dbRun(
      `INSERT INTO ae_cost_map (style_code, effective_from, source, style_name, unit_price_cents, sample_count, last_biz_date, updated_at)
       SELECT style_code, ?, source, style_name, unit_price_cents, sample_count, last_biz_date, updated_at
       FROM ae_cost_map_legacy_struct`,
      [COST_LEGACY_FROM],
    );
    dbRun(`DROP TABLE ae_cost_map_legacy_struct`);
  });
}

/**
 * 删除弃表（2026-10-15，C1 合并收尾）：`ae_orders` / `ae_order_lines` / `ae_fees` 是旧「扩展推送」
 * 采集路径的落库表，采集入口早已改写订单主干 `oi_orders`，三表**零写入**且读取入口（listOrders /
 * getAeSummary / ae-engine）已一并删除 —— 存量库里的残留数据（迁移前采集的历史单）确认丢弃。
 * `IF EXISTS` 幂等：新库本就没建过这些表。
 */
function dropLegacyOrderTables(): void {
  dbRun(`DROP TABLE IF EXISTS ae_fees`);
  dbRun(`DROP TABLE IF EXISTS ae_order_lines`);
  dbRun(`DROP TABLE IF EXISTS ae_orders`);
}

/**
 * 常用结算币种默认参考汇率（1 外币 = X CNY）。
 * CNY 为利润统计基准币：恒 1:1（引擎对 CNY 订单免查表），此处仅用于界面可见/种子占位；
 * 其余默认值仅供引擎起步参考，用户可在「成本与汇率」页手动修正。
 */
const DEFAULT_RATES: Record<string, number> = { CNY: 1, USD: 7.2, EUR: 7.8, GBP: 9.2, RUB: 0.085 };
function seedDefaultRates(): void {
  for (const [ccy, rate] of Object.entries(DEFAULT_RATES)) {
    dbRun(`INSERT OR IGNORE INTO ae_rates (from_currency, rate_to_cny) VALUES (?, ?)`, [ccy, rate]);
  }
}

// ---- 字段规整与校验 ----

const MAX_STR = {
  orderId: 40, shopName: 200, site: 20, orderTime: 40, status: 60, currency: 8,
  productId: 64, skuId: 64, title: 300, skuProps: 300, styleCode: 64,
  category: 60, source: 20,
};
const MAX_MONEY = 1e9;
const MAX_QTY = 1e6;
const MAX_LINES = 100;
const MAX_FEES = 100;
/** raw 快照长度上限（单条帧；接收端 body 已限 1MB/批 100，此处保险） */
const MAX_RAW_JSON = 64 * 1024;

/** v1 顶层费用字段 → 费用科目 key 映射（迁移路径，v1/v2 帧均转科目行入库） */
const LEGACY_FEE_MAP: Record<string, string> = {
  platformFee: 'platform_commission',
  logisticsFee: 'logistics_fee',
  refundAmount: 'refund',
};

function clipStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, max).trim();
}

/** 金额规整：仅接受有限数字，保留两位小数；非法返回 null（调用方跳过或记 0） */
function normMoney(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (Math.abs(v) > MAX_MONEY) return null;
  return Math.round(v * 100) / 100;
}

function normQty(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1 || n > MAX_QTY) return null;
  return n;
}

/**
 * 单条订单 schema 校验与规整（宽容模式）：
 *  - 必填仅 orderId；核心字符串/金额字段做长度/有限数校验并规整；
 *  - 未知字段不拒绝：原样保留（整帧快照进 raw_json），
 *  - v1 顶层费用字段 → fees 科目行；v2 fees 数组逐条规整（未知科目照收）。
 * @returns { order|null, error? } 非法返回 { order: null, error }
 */
export function sanitizeIngestOrder(input: unknown): { order: AeIngestOrder | null; error?: string } {
  if (!input || typeof input !== 'object') return { order: null, error: '订单必须是对象' };
  const o = input as Record<string, unknown>;
  const orderId = clipStr(o.orderId, MAX_STR.orderId);
  if (!orderId) return { order: null, error: '缺少 orderId' };

  const currency = clipStr(o.currency, MAX_STR.currency).toUpperCase() || 'USD';

  // 核心金额：商品金额 / 买家付运费（收入侧窄列）；非法则整单拒绝
  const goodsAmount = normMoney(o.goodsAmount);
  if (o.goodsAmount !== undefined && o.goodsAmount !== null && goodsAmount === null) {
    return { order: null, error: '金额字段 goodsAmount 非法' };
  }
  const shippingIncome = normMoney(o.shippingIncome);
  if (o.shippingIncome !== undefined && o.shippingIncome !== null && shippingIncome === null) {
    return { order: null, error: '金额字段 shippingIncome 非法' };
  }

  // 费用：v2 fees 数组 + v1 顶层映射；非法金额跳过该条费用（不整单失败），容忍演进
  const fees: AeIngestFee[] = [];
  if (Array.isArray(o.fees)) {
    if (o.fees.length > MAX_FEES) return { order: null, error: `fees 条数超上限（≤${MAX_FEES}）` };
    for (const raw of o.fees as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const amount = normMoney(r.amount);
      if (amount === null) continue;
      const category = clipStr(r.category, MAX_STR.category);
      if (!category) continue;
      fees.push({ ...r, category, amount, currency: clipStr(r.currency, MAX_STR.currency).toUpperCase() || currency });
    }
  }
  for (const [key, cat] of Object.entries(LEGACY_FEE_MAP)) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    const n = normMoney(v);
    if (n === null) return { order: null, error: `金额字段 ${key} 非法` };
    fees.push({ category: cat, amount: n, currency });
  }

  // SKU 行：非法行跳过；条目内未知字段宽容保留
  const lines: AeIngestLine[] = [];
  if (o.lines !== undefined && o.lines !== null) {
    if (!Array.isArray(o.lines) || o.lines.length > MAX_LINES) return { order: null, error: 'lines 必须是 ≤100 的数组' };
    for (const raw of o.lines as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const qty = normQty(r.qty);
      const unitPrice = normMoney(r.unitPrice);
      const lineGoods = normMoney(r.goodsAmount);
      if (qty === null || unitPrice === null || lineGoods === null) continue;
      lines.push({
        ...r,
        productId: clipStr(r.productId, MAX_STR.productId),
        skuId: clipStr(r.skuId, MAX_STR.skuId),
        title: clipStr(r.title, MAX_STR.title),
        skuProps: clipStr(r.skuProps, MAX_STR.skuProps),
        styleCode: clipStr(r.styleCode, MAX_STR.styleCode),
        qty,
        unitPrice,
        goodsAmount: lineGoods,
      });
    }
  }

  // 宽容快照：保留原始对象全部字段，仅覆盖规整后的核心值
  const order: Record<string, unknown> = { ...o };
  order.orderId = orderId;
  order.currency = currency;
  order.shopName = clipStr(o.shopName, MAX_STR.shopName);
  order.site = clipStr(o.site, MAX_STR.site);
  order.orderTime = clipStr(o.orderTime, MAX_STR.orderTime);
  order.status = clipStr(o.status, MAX_STR.status);
  order.goodsAmount = goodsAmount ?? 0;
  order.shippingIncome = shippingIncome ?? 0;
  order.fees = fees;
  order.lines = lines;

  return { order: order as AeIngestOrder };
}

// ---- 入库 ----

/** 批量幂等 upsert：存在 order_id 则更新（含 SKU 行/费用科目整批替换），否则插入。整体走事务。 */
export function upsertOrderBatch(orders: AeIngestOrder[]): AeUpsertResult {
  if (!orders.length) return { inserted: 0, updated: 0, skipped: 0, rateMissing: 0 };
  ensureAeSchema(); // 直接调用本函数的场景（冒烟/脚本）也要保证汇率表在（默认汇率只种缺的）
  // 汇率（采集帧是原币；主干一律 CNY 分）
  const rates = new Map<string, number>();
  for (const r of dbQuery<Record<string, unknown>>(`SELECT from_currency, rate_to_cny FROM ae_rates`)) {
    const ccy = String(r.from_currency ?? '');
    const v = num(r.rate_to_cny);
    if (ccy && v > 0) rates.set(ccy, v);
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let rateMissing = 0;
  for (const o of orders) {
    try {
      const currency = String(o.currency ?? '') || 'USD';
      const rate = currency === BASE_CURRENCY ? 1 : (rates.get(currency) ?? 0);
      const missingRate = !rate; // 缺汇率 → 金额只能是 NULL（写 0 会把"算不出"伪装成"收入为零"）
      // 整单收入 = （商品金额 + 买家付运费）× 汇率 —— **不扣退款**：
      // 退款/费用的真值源是「结算明细」（`ae_settle_lines`），采集帧的费用科目实测为空，
      // 在订单侧再扣一次会得到两套净额口径（同一批货两个数）。
      const amountCents = rate
        ? toCentsCny(orderIncomeCcy({ goodsAmount: o.goodsAmount, shippingIncome: o.shippingIncome }), rate)
        : null;
      const lines = (Array.isArray(o.lines) ? o.lines : []).map((l) => {
        const props = parseSkuProps((l as Record<string, unknown>)?.skuProps);
        return {
          itemId: String((l as Record<string, unknown>)?.productId ?? '').slice(0, 64),
          qty: Math.max(1, Math.round(Number((l as Record<string, unknown>)?.qty) || 1)),
          color: props.color.slice(0, 64),
          size: props.size.slice(0, 64),
        };
      });
      const res = upsertCollectedOrder({
        orderNo: String(o.orderId ?? ''),
        orderTime: String(o.orderTime ?? ''),
        bizStatus: String(o.status ?? ''),
        shop: String(o.shopName ?? ''),
        amountCents,
        // 保真：整帧原文放进 raw_fields（**加前缀**，免得与报表列名族相撞）
        rawFields: { 采集帧: JSON.stringify(o).slice(0, 20000) },
        lines,
      });
      if (res.replaced) updated += 1;
      else inserted += 1;
      // 只在**真的落了库**之后才计入 —— 被校验挡掉的行（`skipped`）不是"缺汇率的订单"，
      // 否则回执会把"一条坏帧"和"一条算不出钱的单"混成一个数（两种处置办法完全不同）。
      if (missingRate) rateMissing += 1;
    } catch (err: any) {
      // 回执只带 skipped 计数、没有原因；通道互斥这类校验会在这里挡单，
      // 至少留一条主进程日志，别让"整单没进来"变成纯静默。
      console.warn(`[ae-db] 订单 ${String(o.orderId ?? '')} 未入库：`, err?.message || err);
      skipped += 1;
    }
  }
  return { inserted, updated, skipped, rateMissing };
}

// ---- 查询 ----

function num(v: unknown): number {
  return v !== undefined && v !== null ? Number(v) : 0;
}

// ---- 汇率（ae_rates） ----

/** 汇率行（渲染层类型同构，勿拆字段） */
export interface AeRateItem {
  fromCurrency: string;
  /** 1 fromCurrency = rateToCny CNY */
  rateToCny: number;
  updatedAt: string;
}

/** 汇率全量 */
export function rateList(): AeRateItem[] {
  return dbQuery<Record<string, unknown>>(`SELECT from_currency, rate_to_cny, updated_at FROM ae_rates ORDER BY from_currency`).map((r) => ({
    fromCurrency: String(r.from_currency ?? ''),
    rateToCny: num(r.rate_to_cny),
    updatedAt: String(r.updated_at ?? ''),
  }));
}

/** 汇率 upsert（利润引擎换算入口，UI 可修正默认参考值） */
export function rateUpsert(fromCurrency: string, rateToCny: number): void {
  const ccy = clipStr(fromCurrency, MAX_STR.currency).toUpperCase();
  const rate = Number.isFinite(rateToCny) && rateToCny > 0 ? rateToCny : 0;
  if (!ccy || rate <= 0) return;
  dbRun(
    `INSERT INTO ae_rates (from_currency, rate_to_cny, updated_at) VALUES (?,?,datetime('now','localtime'))
     ON CONFLICT(from_currency) DO UPDATE SET rate_to_cny=excluded.rate_to_cny, updated_at=excluded.updated_at`,
    [ccy, rate],
  );
}

/** 汇率 map（引擎一次性读入：currency → rateToCny） */
export function rateMap(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dbQuery<Record<string, unknown>>(`SELECT from_currency, rate_to_cny FROM ae_rates`)) {
    m.set(String(r.from_currency ?? ''), num(r.rate_to_cny));
  }
  return m;
}
