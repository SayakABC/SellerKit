// src/lib/mangoStatus.ts
// 芒果订单状态原文 → **发货台口径**的分桶（唯一实现）。
//
// 为什么不复用 `orderCost.bucketOfStatus`：那是**利润/拣货**口径（4 桶：
// `completed` / `intransit` / `closed` / `unknown`），它把"等卖家发货"和"已发货在途"
// 一起算成 `intransit` —— 对利润没问题（都没结束），对发货台是致命的：
// 「今天要发几单」会把已经在路上的单一起数进去，数字永远偏大，且看起来完全正常。
// 两个口径服务两个问题，混用必然有一边错。**发货台/待办只认本文件**。
//
// 分桶只做一件判断：**这单现在轮到我动手了吗**。
//   · `pending`   等我发货   ← 发货台唯一关心的桶
//   · `shipped`   已发出，等买家/在途（不用我动）
//   · `finished`  已结束
//   · `cancelled` 已关闭/取消/退款
//   · `unknown`   认不出（**绝不落进 `pending`**：把认不出的当"要发货"会让清单里出现
//                 永远不会消失的行；当"不用管"最坏是漏一单，人能靠"未知状态"计数发现）
//
// 匹配**宽松**（子串命中，不要求全等）：芒果在不同页面/版本里给的中文不一样
// （`等待卖家发货` / `待发货` / `待卖家发货`），全等匹配等于把版本差异变成静默漏单。
// 顺序敏感：先判"已结束/已取消"，再判"待发"，最后"已发" ——
// 「等待买家收货」里有"待"、也有"收货"，按倒序会误判成 `pending`。

export type MangoBucket = 'pending' | 'shipped' | 'finished' | 'cancelled' | 'unknown';

/** 分桶 → 给用户看的词（界面别自己写第二份文案） */
export const MANGO_BUCKET_LABELS: Record<MangoBucket, string> = {
  pending: '待发货',
  shipped: '已发货',
  finished: '已完成',
  cancelled: '已取消',
  unknown: '未知状态',
};

/** 规则表（**顺序就是优先级**，从上往下第一个命中的生效） */
const RULES: { bucket: MangoBucket; re: RegExp }[] = [
  // 1. 已结束/已取消优先：这一类的行绝不该出现在"今天要发"里
  {
    bucket: 'cancelled',
    re: /取消|关闭|撤销|作废|退款|退单|cancel|closed|refund|dispute/i,
  },
  {
    bucket: 'finished',
    re: /已完成|完成|交易成功|已收货|已签收|已送达|complete|finish|delivered/i,
  },
  // 2. 等我发货（**发货台唯一关心的桶**）
  {
    bucket: 'pending',
    re: /等待卖家发货|待卖家发货|等待发货|待发货|待处理|未发货|待出库|wait_seller_send|wait_seller_ship|wait_ship/i,
  },
  // 3. 已经发出去了
  {
    bucket: 'shipped',
    re: /部分发货|已发货|已出库|已交运|已揽收|运输中|在途|待收货|等待买家收货|shipped|intransit|in_transit|wait_buyer|part_send|send_goods/i,
  },
];

/**
 * 状态原文 → 分桶。空值/认不出 → `unknown`。
 *
 * @param raw 芒果 `cnOrderStatus`（中文原文）或 `orderStatus`（平台英文码）
 */
export function mangoBucketOf(raw: unknown): MangoBucket {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!s) return 'unknown';
  for (const r of RULES) if (r.re.test(s)) return r.bucket;
  return 'unknown';
}

/** 这单现在是不是等我发货（`pending` 的唯一判定入口，界面别自己写 `=== '待发货'`） */
export function isWaitingShip(raw: unknown): boolean {
  return mangoBucketOf(raw) === 'pending';
}

/** 展示标签 */
export function mangoStatusLabel(raw: unknown): string {
  return MANGO_BUCKET_LABELS[mangoBucketOf(raw)];
}
