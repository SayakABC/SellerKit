// electron/orderMoney.ts
// 订单「钱 / 状态 / 时点」的**纯函数层**（零依赖：不碰 better-sqlite3 / electron）。
//
// 为什么单独成文件（与 `shopName.ts` / `shopSku.ts` 同理由）：`*-db.ts` 依赖 Electron 的 Node ABI，
// 进不了 vitest；而"金额怎么从 `CN￥ 1,234.56` 解析出来"是这条链上唯一有正确性风险的东西，
// 摘成零依赖模块后才能被 `tests/orderMoney.spec.ts` 直接覆盖。
//
// 口径（真实报表实证 2026-09-29：`订单数据.xlsx` 1722 行 / 47 列）：
//   1. 金额单元格形如 `CN￥ 199.87`（带币种前缀，可能带千分位逗号）；空 → **null，不是 0**
//      —— 0 与"没有这个数"必须分开，否则"缺税"会被算成"零税"，利润凭空变大；
//   2. 金额一律存**分**（整数）：与 `ae_cost_map.unit_price_cents` / `purchase_orders.total_cents` 同口径，
//      避免浮点累加误差；
//   3. 该报表有 4 列**全为空**（买家实付金额 / 预计RST / 供货价 / 托管商家折扣）→ 不提取、不入库；
//   4. 金额列之间**没有稳定等式**（实测三种常见关系最高只命中 493/1722 = 29%）→ 一律逐列如实提取，
//      **不做派生、不靠推算**（少存一列以后就得重导）。
//
// 列名族：与其它域同口径（宽松匹配，别写死单一列名 —— 换一家平台导出就会变）。

/** 金额单元格解析结果 */
export interface MoneyCell {
  /** 分（整数）。认不出返回 null */
  cents: number;
  /** 币种前缀原文（如 `CN￥` / `US$`）；无前缀为 '' */
  currency: string;
}

/** 从一行 raw_fields 提取出的「钱 / 状态 / 时点」字段（列不存在 = null / 空串，**不猜**） */
export interface OrderMoneyFields {
  /** 订单金额（买家视角总额；含买家付的运费） */
  amountCents: number | null;
  /** 预计增值税 */
  vatCents: number | null;
  /** DDP 关税 */
  ddpCents: number | null;
  /** 订单状态原文（`交易完成` / `订单关闭` / `等待买家收货` …） */
  bizStatus: string;
  /** 「平台是否代征代缴」原文 —— **存原文不存布尔**：空 = 不知道，与"非代征"必须区分 */
  taxPlatformRaw: string;
  shipTime: string;
}

/** 各字段的列名族（按顺序取第一个命中的列） */
const MONEY_KEYS = {
  amountCents: [/^订单金额/, /订单总额/, /买家支付金额/],
  vatCents: [/预计增值税/, /增值税/],
  ddpCents: [/DDP\s*关税/i, /关税/],
} as const;

const TEXT_KEYS = {
  bizStatus: [/^订单状态/, /^状态$/],
  taxPlatformRaw: [/代征代缴/],
  shipTime: [/^发货时间/, /^已发货时间/],
} as const;

/** 按列名族取原始值（找不到返回 ''） */
function pickRaw(rawFields: Record<string, string>, family: readonly RegExp[]): string {
  if (!rawFields) return '';
  for (const re of family) {
    for (const [k, v] of Object.entries(rawFields)) {
      if (re.test(k)) return typeof v === 'string' ? v.trim() : '';
    }
  }
  return '';
}

/**
 * 解析金额单元格：`CN￥ 1,234.56` → `{ cents: 123456, currency: 'CN￥' }`。
 * @returns null = 空 / 认不出（**不要**折成 0）
 */
export function parseMoneyCell(raw: unknown): MoneyCell | null {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!s) return null;
  // 币种前缀 = 数字之前的非数字部分（`CN￥` / `US$` / `¥` …）
  const m = /^([^\d\s-]*)\s*(-?[\d,]+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const num = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  return { cents: Math.round(num * 100), currency: m[1] ?? '' };
}

/** 从整行 raw_fields 提取「钱 / 状态 / 时点」（缺列即 null / ''，不猜、不补默认值） */
export function extractOrderMoney(rawFields: Record<string, string>): OrderMoneyFields {
  const money = (family: readonly RegExp[]): MoneyCell | null =>
    parseMoneyCell(pickRaw(rawFields, family));
  const amount = money(MONEY_KEYS.amountCents);
  return {
    amountCents: amount?.cents ?? null,
    vatCents: money(MONEY_KEYS.vatCents)?.cents ?? null,
    ddpCents: money(MONEY_KEYS.ddpCents)?.cents ?? null,
    bizStatus: pickRaw(rawFields, TEXT_KEYS.bizStatus),
    taxPlatformRaw: pickRaw(rawFields, TEXT_KEYS.taxPlatformRaw),
    shipTime: pickRaw(rawFields, TEXT_KEYS.shipTime),
  };
}

// ⚠️ 本层只**解析原文**（金额/状态/时点怎么从单元格里取出来）。
// 「状态怎么分桶」「税由谁承担」属**算账口径**，放在渲染层纯函数 `src/lib/orderCost.ts`
// （`bucketOfStatus` / `taxBearerOf`）—— 那里才是消费方，主进程再抄一份必然漂移。