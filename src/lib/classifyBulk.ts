// 「归类核对」的**批量单位**：把待核对的行按「商品」分组，以及"给它定这个款之后颜色取哪个"。
//
// 为什么单独放 lib（纯函数区）而不是留在 `ClassifyPanel.vue` 里：
//   ① 这是**两处都要用**的规则 —— 行内「同商品 ×N」徽标、批量定款弹层的分组，必须是同一个键。
//      各写一份的典型症状：徽标说这 3 行同商品，批量弹层却把它们拆成 3 组（或者反过来）。
//   ② 它没有副作用（不读库、不碰 DOM），可以在 `tests/classifyBulk.spec.ts` 里直接钉住
//      —— 真库里"同一商品的 5 行"不是随时能造出来的夹具。

import type { OrderRecord } from '@/types';

/**
 * 分组键 = **店铺原文 + 商品ID**。商品ID 由主进程给（`OrderRecord.itemId`），这里不自己推 ——
 * 它与回流写映射时用的是同一个 `extractSkuFields`，推两遍就会出现"徽标说同商品、回流按另一个键记"。
 *
 * 没有商品ID ⇒ **空串**（调用方据此判断"这行不参与分组"，而不是把它当成一个独立商品：
 * "没有商品ID"与"单独一个商品"在界面上必须长得不一样）。
 *
 * ⚠️ 已知的**欠算**：这里用的是店铺**原文**，而回流用的是归一后的店铺实体。同一家店在报表里
 *    写法不同（多一个空格/全角括号）时，这里会当成两个商品（徽标少算）。刻意不修：要修就得把
 *    店铺归一下沉到渲染层（那是 `sk_name_map` 的事，两处各判一次必分叉）。徽标是**提示**不是承诺，
 *    少算只会让人多核对一次，不会把两件商品混成一件。
 */
export function productKeyOf(o: Pick<OrderRecord, 'shop' | 'itemId'>): string {
  const itemId = String(o.itemId ?? '').trim();
  if (!itemId) return '';
  return `${String(o.shop ?? '').trim()}\u0000${itemId}`;
}

/** 一个商品的批量单位（批量定款弹层里的一张卡片） */
export interface BulkGroup {
  /** `productKeyOf` 的结果；没有商品ID 的行用 `#<id>` 单独成组（批量时仍要能给它定款） */
  key: string;
  shop: string;
  itemId: string;
  /** 这一组的行（顺序 = 列表里的顺序） */
  rows: OrderRecord[];
  /** 组内草稿款（全部一致时给这个款，不一致给空串 —— 空串 ≠ "没有款"） */
  styleCode: string;
}

/**
 * 把选中的行按商品分组（保持**首次出现**的顺序 —— 表格是从上往下看的，分组顺序必须跟着它，
 * 否则用户勾了 3 行却在一屏里找不到第三行）。
 *
 * ⚠️ 没有商品ID 的行**各自成组**（key 用 `#<id>`）：它们没法证明"同一个商品"，
 *    合在一起就是把不相关的两件商品按同一个款落库 —— 那是最坏的一种错（还查不出来）。
 */
export function groupByProduct(rows: OrderRecord[], styleOf: (o: OrderRecord) => string): BulkGroup[] {
  const map = new Map<string, BulkGroup>();
  for (const o of rows) {
    const pk = productKeyOf(o);
    const key = pk || `#${Number(o.id ?? 0)}`;
    let g = map.get(key);
    if (!g) {
      g = { key, shop: String(o.shop ?? ''), itemId: String(o.itemId ?? '').trim(), rows: [], styleCode: '' };
      map.set(key, g);
    }
    g.rows.push(o);
  }
  for (const g of map.values()) {
    const codes = new Set(g.rows.map((o) => String(styleOf(o) ?? '').trim()));
    g.styleCode = codes.size === 1 ? [...codes][0] : '';
  }
  return [...map.values()];
}

/**
 * 分组 + 该组的订单图（图由调用方从已取到的缩略图里贴 —— 弹层不自己去取订单图，
 * 那会让"批量弹层一打开就发一轮 IPC"这件事没人看得见）。
 */
export interface BulkGroupView extends BulkGroup {
  images: string[];
}

/**
 * 给"这一行 + 这个款"挑一个颜色 —— 批量定款时**不逐个问人**的那一半。
 *
 * 优先级（与行内 `initialColor` 同源，但**用途不同**，别合并：那条回答"编辑时该预选哪个"，
 * 这条回答"批量时要不要替他把颜色也填上"）：
 *   ① 图片记住的颜色（`styleColor`，宿主存在 `oi_images.style_color_id`，是"以图为准"的结论）；
 *   ② 订单自己的颜色列（上一轮人工留下的值）；
 *   ③ 该款**只有一个颜色** ⇒ 用它（只有一个候选时不存在选择歧义，"问他"纯属多余）；
 *   ④ 其余 ⇒ `''`（**不猜**：让这行留在列表里，等他自己选）。
 *
 * ⚠️ 前三支都必须在 `palette` 里才作数。硬把不在色卡里的色塞进去，等于给这个款造一个
 *    "只有这一单有"的款色 —— 下游取图/算钱全按款色匹配，那些行会静默对不上。
 * ⚠️ `palette` 为空（这个款还没录颜色）⇒ 返回订单原色（自由输入那一支的口径，与行内一致）。
 */
export function pickColorFor(
  o: Pick<OrderRecord, 'color' | 'styleColor'>,
  palette: string[]
): string {
  const remembered = String(o.styleColor ?? '').trim();
  const own = String(o.color ?? '').trim();
  if (!palette.length) return own || remembered;
  if (remembered && palette.includes(remembered)) return remembered;
  if (own && palette.includes(own)) return own;
  if (palette.length === 1) return palette[0];
  return '';
}
