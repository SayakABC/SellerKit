// electron/colorAlias.ts
/**
 * 「平台色名 → 我的色名」的归一与查表（**纯函数**，无 db 依赖，可单测）。
 *
 * 为什么需要：订单/采集里的颜色是**平台侧字符串**，真库实测是 `Khaki`、`Photo color`、
 * 以及 `1..15` 这种纯编号；而款色库里要的是**自家色名**（`卡其`、`黑色`）。
 * 两者之间没有任何可计算的对应关系（数字色名连语义都没有），只能由人指认一次、之后复用。
 * 指认入口就是既有的**归类核对**：用户把 `Khaki` 改成 `卡其` 保存，系统记住这一对。
 *
 * 键的粒度 = **产品**（`pl_products.id`），三个候选都想过：
 *   · 平台级（`Khaki → 卡其`）：最省力，但同一平台色名在不同款上未必是同一个自家名，
 *     配错的影响面是**全店**；
 *   · 商品级：最安全，但同款的多件商品要各配一遍（真实库里同款常有 3~9 个商品ID）；
 *   · 产品级：同一款衣服的 `Khaki` 就是同一个色 —— 配一次覆盖该款全部商品与订单。
 * 选它是因为"同款同色名"是业务事实，"同平台同色名同义"只是大概率的巧合。
 *
 * ⚠️ 键里**不含店铺/平台**：同一款可能同时在几家店卖，色名写法一致时没必要配两遍；
 * 真出现"这家店的 Khaki 是卡其、那家是驼色"，说明是**两个不同的产品**（不同货），
 * 本来就该是两个 `product_id`。
 */

/** 全角 ASCII（`！`~`～`）→ 半角。`Ｋｈａｋｉ` 与 `Khaki` 必须同键，否则"改了没生效"。 */
const FULLWIDTH = /[\uFF01-\uFF5E]/g;

function toHalfWidth(s: string): string {
  return s.replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 色名比对键：**折叠大小写与空白**，全角转半角。
 *
 * 为什么折叠空白：平台侧同一色写成 `Photo color` / `Photo  color` 都会出现，
 * 差一个空格就是两个键，用户要在核对页改两次（第二次还会以为是没保存）。
 * 为什么折叠大小写：`Khaki` / `khaki` 是同一个词，没有区分语义。
 *
 * ⚠️ 不做任何"像不像颜色"的判断：`1`、`70B`、`均码` 都原样成键 ——
 * 归一化只负责"同一串文本的不同写法"，语义判断归人（同 `normalizeSkuSize` 的纪律）。
 */
export function colorAliasKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return toHalfWidth(raw).replace(/\s+/g, '').trim().toLowerCase();
}

/** `oi_color_aliases` 的最小投影（查表只需要这两列，不必拖整行） */
export interface ColorAliasRow {
  product_id: number;
  /** 已按 `colorAliasKey` 归一 */
  alias_key: string;
  color: string;
}

/** 命中的自家色名；未命中返回 `''`（**不是**原文 —— 调用方要能区分"没配过"和"配成了原文"） */
export function pickColorAlias(
  rows: readonly ColorAliasRow[] | null | undefined,
  productId: unknown,
  raw: unknown,
): string {
  const key = colorAliasKey(raw);
  const pid = Number(productId) || 0;
  if (!key || pid <= 0 || !rows?.length) return '';
  for (const r of rows) {
    if ((Number(r.product_id) || 0) !== pid) continue;
    if (r.alias_key !== key) continue;
    const color = String(r.color ?? '').trim();
    if (color) return color;
  }
  return '';
}

/**
 * 平台色名 → 自家色名；**没配过就原样返回**（`''` 进 `''` 出）。
 *
 * 调用方拿到的永远是"能直接落库的色名"：要么是用户认过的自家名，要么是原来那串
 * 平台名（保持"没配就不动"的现状，绝不因为查不到就丢成未分类）。
 */
export function translateColor(
  rows: readonly ColorAliasRow[] | null | undefined,
  productId: unknown,
  raw: unknown,
): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return '';
  return pickColorAlias(rows, productId, v) || v;
}
