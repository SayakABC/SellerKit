// src/lib/dataHealth.ts
// 「待补清单」的判定层（**纯函数、无 IO**）。
//
// ── 为什么要有它（2026-10-19）──────────────────────────────────────────
// 前三轮改码（商品ID 认店 / 按图定色 / 克重去掉颜色条件）接通之后，剩下的问题不再是代码，
// 而是**数据还欠着什么**。可这些缺口散在三处：
//   · 订单没认款 / 颜色还是「未分类」→「发货台 › 归类核对」
//   · 认到的款在产品库里没有 / 尺码对不上 / SKU 没填克重 →「基础数据 › 产品管理」
//   · 款没填进价 →「基础数据 › 进价」
// 用户要回答"我现在最该补哪一样"，得自己跑三个页面数三遍。这一层把它们收成一张清单。
//
// ── 三条硬规矩（都是本仓踩过的同类问题）────────────────────────────────
// ① **不新开一套口径**：输入全部来自既有取数口（订单主干投影 / 产品列表 / SKU 列表 /
//    进价表），与各自页面上的数字同源。这里只做"分组 + 排序 + 说人话"，不重算业务。
// ② **数字与明细是同一份数据**：`n` 由 `items` 累加得出，绝不另写一条 COUNT。
//    否则会出现"标题说 47 单、下面只列了 12 行"，整页都不可信。
// ③ **不跨类相加**：单位不同（单 / 个 SKU / 款），加起来没有意义
//    （同 `MasterDataView` 组徽标那条"别把组内各项的数加起来"）。界面只报"还欠几类"。
//
// ── 口径边界（写出来，免得下一个人以为少算）────────────────────────────
//   · 订单看**全部**，不限今天那批。发货台总览卡的缺口只算今天导入的那批 ——
//     两个数字会不一样，那是**口径不同，不是谁错了**；界面各自都标了口径。
//   · 店名未归一**不在这里**：它已经是「基础数据 › 店铺登记」的徽标，且取数要走
//     `shopApi.summary()`（另一条链）。同一件事摆两个地方，改一处忘一处。
//   · 运价表缺失**不在这里**：那是"有没有配"，不是"哪一行没填"，没有明细可列。

import { canonSizeKey } from './orderCost';

/**
 * 款色表里"颜色还没定"的占位值。
 *
 * ⚠️ 这个字面量与主进程 `electron/order-db.ts` 的 `MAPPED_FALLBACK_COLOR` **必须一致**
 *    （两个进程各一份，跨进程共享常量的代价比这行注释大）。钉住它的是
 *    `tests/dataHealth.spec.ts` 里那条源码级断言：读主进程文件比对字面量，
 *    改了一边不改另一边会直接红。
 */
export const UNCLASSIFIED_COLOR = '未分类';

/** 订单行：只取判缺口要用的字段（`UnifiedOrderRow` 的子集，便于单测造样本） */
export interface HealthOrder {
  shop?: string;
  /** 识别链结果（`oi_images.style_color_id → oi_style_colors → oi_styles`）；未识别为空串 */
  styleCode?: string;
  /** 款色名（`oi_style_colors.color`）；`未分类` = 色还没定 */
  styleColor?: string;
  /** 订单上的平台色名（`oi_order_items.color`）—— 只用于让人认出是哪一行 */
  color?: string;
  size?: string;
  itemId?: string;
}

export interface HealthProduct {
  id: number;
  code: string;
  name: string;
  /** `active` / `archived` */
  status?: string;
}

export interface HealthVariant {
  productId: number;
  size?: string;
  color?: string;
  /** 0 = 未填 */
  weightG?: number;
  status?: string;
}

export interface HealthInput {
  orders: HealthOrder[];
  products: HealthProduct[];
  variants: HealthVariant[];
  /** 有进价的款编码（产品表 `pl_products.cost_cents > 0`；C2 起成本唯一真源是产品表） */
  pricedCodes: string[];
}

/** 点「去补」跳到哪一屏（`switchModule` 的 action；空串 = 不跳） */
export type HealthTarget = 'classify' | 'goods';

export interface HealthItem {
  /** 稳定身份（同一缺口每次算出来都一样；界面 `:key` 用它） */
  key: string;
  /** 主文案：用户认得的东西（款编码 / 店铺 / 商品ID） */
  title: string;
  /** 次文案：差在哪、差多少 */
  detail: string;
  /** 影响量（单位见 `HealthCheck.unit`） */
  n: number;
}

export interface HealthCheck {
  id: 'unconfirmed' | 'noColor' | 'styleNotBuilt' | 'sizeMissing' | 'weightMissing' | 'costMissing';
  title: string;
  /** 单位（单 / 个 SKU / 款）—— 跨类不相加，所以每一类必须自己说清单位 */
  unit: string;
  /** 不补会怎样（一句话，别写"影响数据质量"这种空话） */
  why: string;
  /** 去哪补（真实入口名，`uxEntryNames` 会核对每一段） */
  where: string;
  /** 「去补」按钮文案 */
  action: string;
  target: HealthTarget;
  items: HealthItem[];
  /** = Σ items[].n（**唯一来源**，不另算） */
  n: number;
}

/** 按数量降序、同数量按名字排 —— 让"最该先补的那一类"排在最上面 */
function sortItems(items: HealthItem[]): HealthItem[] {
  return items.sort((a, b) => b.n - a.n || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

/** `Map` 累加器（同一 key 合并成一条明细，`n` 相加） */
function bump<T extends { n: number }>(map: Map<string, T>, key: string, make: () => T, add: number): void {
  const hit = map.get(key);
  if (hit) hit.n += add;
  else {
    const item = make();
    item.n = add;
    map.set(key, item);
  }
}

const upper = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/**
 * 把四路输入折成一张待补清单。
 *
 * 六类检查的**顺序即严重度**：认不出款 → 认错色 → 款不存在 → 尺码对不上 → 没克重 → 没进价。
 * 前四类会让"货发错/发不出"，后两类只是"钱算不准"，所以排在后面。
 */
export function buildDataHealth(input: HealthInput): HealthCheck[] {
  const orders = Array.isArray(input?.orders) ? input.orders : [];
  const products = Array.isArray(input?.products) ? input.products : [];
  const variants = Array.isArray(input?.variants) ? input.variants : [];
  const priced = new Set((input?.pricedCodes ?? []).map(upper).filter(Boolean));

  // 款编码 → 产品（产品库的 code 唯一；这里仍按"只认精确码"处理，
  // 不做模糊匹配 —— 把 SUST-1 认成 SUST-10 会让整个清单指向错的款）
  const productByCode = new Map<string, HealthProduct>();
  for (const p of products) {
    const code = upper(p?.code);
    if (code) productByCode.set(code, p);
  }

  // 产品 → 在售尺码集合（归档变体不算：用户已经不用它了，
  // 拿它当"有这个码"会让清单一直显示"齐了"，而实际发不了货）
  const sizesByProduct = new Map<number, Set<string>>();
  // 产品 → 在售 SKU 数与缺克重数
  const weightByProduct = new Map<number, { total: number; missing: number }>();
  for (const v of variants) {
    const pid = Number(v?.productId) || 0;
    if (!pid) continue;
    if (String(v?.status ?? 'active') === 'archived') continue;
    const sz = canonSizeKey(v?.size);
    if (sz) {
      const set = sizesByProduct.get(pid) ?? new Set<string>();
      set.add(sz);
      sizesByProduct.set(pid, set);
    }
    const w = weightByProduct.get(pid) ?? { total: 0, missing: 0 };
    w.total += 1;
    if (!(Number(v?.weightG) > 0)) w.missing += 1;
    weightByProduct.set(pid, w);
  }

  const unconfirmed = new Map<string, HealthItem>();
  const noColor = new Map<string, HealthItem>();
  /** 款 → 该款「未分类」订单上出现过的平台色名（明细文案在循环外拼，见 ③ 后面的收尾） */
  const noColorColors = new Map<string, string[]>();
  const styleNotBuilt = new Map<string, HealthItem>();
  const sizeMissing = new Map<string, HealthItem>();

  for (const o of orders) {
    if (!o) continue;
    const code = String(o.styleCode ?? '').trim();
    const shop = String(o.shop ?? '').trim();
    const itemId = String(o.itemId ?? '').trim();

    // ① 连款都没认出来：按"店铺 + 商品ID"归组 —— 这正是用户去补的那一行
    //   （归类核对里按图片/商品ID 一行一行处理）。
    if (!code) {
      const key = `${shop}\u0001${itemId}`;
      bump(unconfirmed, key, () => ({
        key,
        title: shop || '未知店铺',
        detail: itemId ? `商品ID ${itemId}` : '没有商品ID',
        n: 0,
      }), 1);
      continue;
    }

    // ② 认了款，但产品库里没有这个款编码（真实库里有 `STYPE-001` 这种录错的码）：
    //   拣货、成本、克重**全都取不到它**，而且一条错都不报 —— 这是最安静的一类。
    const product = productByCode.get(upper(code));
    if (!product) {
      const key = upper(code);
      bump(styleNotBuilt, key, () => ({
        key,
        title: code,
        detail: '产品库里没有这个款编码（可能录错了，也可能还没建档）',
        n: 0,
      }), 1);
      continue;
    }

    // ③ 款认到了，颜色还挂在「未分类」上：拣货单只能写「未分类」，发货容易配错色
    if (String(o.styleColor ?? '').trim() === UNCLASSIFIED_COLOR) {
      const key = upper(code);
      bump(noColor, key, () => ({
        key,
        title: product.code || code,
        detail: '',
        n: 0,
      }), 1);
      // 同一款可能来自多个平台色名（真实库同款常见 3~9 个商品ID、色名各不相同）：
      // 都写出来，用户才知道"这一款要认几个色"。
      // ⚠️ 按**等值**去重，不用 `includes` —— 色名之间会互为子串（`K` 与 `Khaki`），
      //    用子串判断会把后一个色悄悄吞掉，而清单看起来"只缺一个色"。
      const list = noColorColors.get(key) ?? [];
      const platformColor = String(o.color ?? '').trim();
      if (platformColor && !list.includes(platformColor)) list.push(platformColor);
      noColorColors.set(key, list);
    }

    // ④ 尺码对不上：产品里没有这个码 ⇒ 拿货按不到它、克重也查不到。
    //   码会先过 `canonSizeKey`（`XXXL` 与 `3XL` 是同一个码，别在这里制造假缺口）。
    const sz = canonSizeKey(o.size);
    if (sz) {
      const roster = sizesByProduct.get(Number(product.id)) ?? new Set<string>();
      if (!roster.has(sz)) {
        const key = `${upper(code)}\u0001${sz}`;
        bump(sizeMissing, key, () => ({
          key,
          title: `${product.code || code} · ${String(o.size ?? '').trim() || sz}`,
          detail: roster.size
            ? `这款的 SKU 里没有 ${String(o.size ?? '').trim() || sz} 码`
            : '这款还没有任何 SKU（先建 SKU，再谈补码）',
          n: 0,
        }), 1);
      }
    }
  }

  // ③ 的明细文案在**循环外**拼：色名是逐行收集的，边循环边改同一条字符串容易写成
  //   "上一个色覆盖下一个色"（试过，用 `includes` 去重时 `K` 与 `Khaki` 会互相吃掉）。
  for (const [key, colors] of noColorColors) {
    const hit = noColor.get(key);
    if (!hit) continue;
    hit.detail = colors.length ? `订单上的颜色：${colors.join(' / ')}` : '订单上没有颜色';
  }

  // ⑤ SKU 没填克重：按款归组，报"缺几个 / 共几个"。
  //   单位是**个 SKU**，不是"行"也不是"款" —— 产品列表的「缺克重」筛选报的是**款**，
  //   两者不同口径，所以这里必须把单位写出来（否则用户会以为有一处算错了）。
  const weightMissing: HealthItem[] = [];
  for (const p of products) {
    const w = weightByProduct.get(Number(p?.id));
    if (!w || !w.missing) continue;
    weightMissing.push({
      key: `w\u0001${upper(p.code)}`,
      title: [p.code, p.name].filter(Boolean).join(' '),
      detail: `共 ${w.total} 个 SKU，缺 ${w.missing} 个`,
      n: w.missing,
    });
  }

  // ⑥ 款没填进价：口径与「基础数据 › 进价」的徽标**逐字对齐**（产品库 − 有进价的款，
  //   不看启用/停用）—— 两处报同一个数，用户才不会觉得哪边漏了。
  const costMissing: HealthItem[] = [];
  for (const p of products) {
    const code = upper(p?.code);
    if (!code || priced.has(code)) continue;
    costMissing.push({
      key: `c\u0001${code}`,
      title: [p.code, p.name].filter(Boolean).join(' '),
      detail: '没有填进价',
      n: 1,
    });
  }

  const checks: HealthCheck[] = [
    {
      id: 'unconfirmed',
      title: '订单没认到款',
      unit: '单',
      why: '认不出款就算不出成本，也进不了拣货单',
      where: '「发货台 › 归类核对」',
      action: '去认款',
      target: 'classify',
      items: sortItems([...unconfirmed.values()]),
      n: 0,
    },
    {
      id: 'noColor',
      title: '订单颜色还是「未分类」',
      unit: '单',
      why: '颜色没定，拣货单只能写「未分类」，发货容易配错色',
      where: '「发货台 › 归类核对」',
      action: '去定色',
      target: 'classify',
      items: sortItems([...noColor.values()]),
      n: 0,
    },
    {
      id: 'styleNotBuilt',
      title: '认到的款在产品库里没有',
      unit: '单',
      why: '这个款编码在产品库里不存在，拣货和成本都取不到它，也不会报错',
      where: '「产品管理 › 款与商品」',
      action: '去建档',
      target: 'goods',
      items: sortItems([...styleNotBuilt.values()]),
      n: 0,
    },
    {
      id: 'sizeMissing',
      title: '订单尺码在产品里没有',
      unit: '单',
      why: '这个码在产品里没有，拿货按不到它，克重也查不到',
      where: '「产品管理 › 款与商品」',
      action: '去补 SKU',
      target: 'goods',
      items: sortItems([...sizeMissing.values()]),
      n: 0,
    },
    {
      id: 'weightMissing',
      title: 'SKU 没填克重',
      unit: '个 SKU',
      why: '缺克重算不出运费，这一单的利润会偏高',
      where: '「产品管理 › 款与商品」',
      action: '去补克重',
      target: 'goods',
      items: sortItems(weightMissing),
      n: 0,
    },
    {
      id: 'costMissing',
      title: '款没填进价',
      unit: '款',
      why: '没有进价就算不出成本，毛利会偏高',
      where: '「基础数据 › 产品管理」（用「只看缺进价」筛选）',
      action: '去填进价',
      target: 'goods',
      items: sortItems(costMissing),
      n: 0,
    },
  ];

  // `n` 一律从明细累加（规矩②）—— 任何一处另写 COUNT 都会让标题与列表对不上
  for (const c of checks) c.n = c.items.reduce((sum, it) => sum + it.n, 0);
  return checks;
}

/** 还欠几类（**不相加数量**，只数"有几类不为空"） */
export function pendingKinds(checks: HealthCheck[]): number {
  return (checks ?? []).filter((c) => c.n > 0).length;
}
