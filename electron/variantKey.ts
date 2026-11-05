// electron/variantKey.ts
// **变体键**的纯函数层（零依赖：只 import ./shopName 的 `toNameKey`；不碰 better-sqlite3）。
//
// 为什么单独成文件（与 `shopName.ts` / `shopSku.ts` 同一理由）：`electron/*-db.ts` 因 better-sqlite3
// 的 Electron ABI 在系统 Node 下 load 不进来，只能走 `scripts/*-db-smoke.cjs`。而"两个订单行是不是
// 同一件实物"是这条链路上**唯一有正确性风险**的判定，摘成纯模块后才能被 vitest 直接覆盖。
//
// 键 = `(店铺, 商品ID, 平台色原文)` —— 平台在下单那一刻就记下来的**确定性等价类**：
// 同键 = 同一件实物。它不需要图像、不需要推理、不需要建档。
//
// 两条纪律（都由真库取证，见 `docs/notes/2026-10-30-order-purchase-grid.md` §1.2）：
//   1. **色只做「剥不可见字符 + 折叠空白」**，不折大小写、不映射标准色、不认识"像不像颜色"。
//      `Color:1` 同时出现在 7 个不同 listing（瑜伽裤 / 棉袄 / 雨衣 / 印花外套）—— 语义不可信，
//      但它在该 listing 内稳定指向"那一个 SKU"，所以只能当键，永不当色名。
//   2. **商品ID 与店铺名同口径**（复用 `toNameKey`）：平台 ID 是精确标识，猜错一次就是把两件
//      实物的账并到一起。不做模糊匹配。
//
// 为什么店铺在键里：本仓 2026-10-20 已裁定映射身份 = `(店铺 id, 商品ID)`
// （`docs/notes/2026-10-30-shop-identity-and-mapping.md`）。真库现况 37 个商品ID **无一跨店**
// （`GROUP BY 商品ID HAVING COUNT(DISTINCT shop) > 1` 为 0 行），所以带上店铺今天的代价是零，
// 而少了它会与既有映射身份形成两套口径。店铺原文为空时**仍成键**（该段为空串）——
// 那种行本来就没有店铺可分，键不会因此把两件东西并错；`assignShopToOrders` 补上店铺后会重算。

import { toNameKey } from './shopName';

/**
 * 段分隔符：`\u0000` 不会出现在任何文本字段里，用它拼复合键不会与真实内容撞车。
 * 与 `shopSku.ts` 的 `SEP` 同值、各自独立（两处拼的是不同的键，共用一个常量会让人以为有关联）。
 */
const SEP = '\u0000';

/**
 * 段内归一：`toNameKey` + **剥掉分隔符本身**。
 *
 * 剥 `\u0000` 不是洁癖：不剥的话 `item='b\0c'` 会拼出 `a\0b\0c\0d`，与"店铺 `a\0b` + 商品 `c`"
 * 得到**同一个键** —— 两件不同实物静默并成一件，而且永远查不出来。平台数据里不会有 NUL，
 * 但粘进报表的脏字符不受我们控制，键的拼接不能依赖"输入是干净的"。
 */
function normSegment(raw: unknown): string {
  return toNameKey(raw).split(SEP).join('');
}

/** 色段的归一键（与店铺名/商品ID 同口径；`''` 是合法的"报表没给色"） */
export function variantColorKey(raw: unknown): string {
  return normSegment(raw);
}

export interface VariantKeyParts {
  /** 店铺原文（`oi_orders.shop`）；空串合法 */
  shopKey: string;
  /** 商品ID 原文（`raw_fields.产品ID`） */
  itemKey: string;
  /** 平台色原文（`产品属性:Color:5` 里的 `5`）；空串合法 */
  colorKey: string;
  /**
   * **图键**（`podImageKey.imageKeyOf(url)` 的产物）。**只有色名塌陷的链接才给**。
   *
   * 为什么需要第 4 段：真库 7/71 链接里同一色名下挂着多张不同的图（`Color` 全写
   * `Picture color`），涉及 50 个槽位 —— 3 段键会把它们并成一件实物，绑图案时
   * 5–12 个图案被并成 1 个，**静默错印**。
   *
   * 为什么不给所有行都加：给了就改变了存量 75 行的键（那是 M3 T3-6 的定向重算范围，
   * 且只对塌陷链接）。**空/缺省 ⇒ 仍拼 3 段键，与本函数改造前逐字节相同**。
   */
  imageKey?: string;
}

/**
 * 拼变体键。**没有商品ID 就不成键**（返回 `''`）——那是唯一不可缺的一段：
 * 少了它，一个店铺的全部无色订单会并成同一件实物。
 *
 * 段数：3 段（常规）或 4 段（色名塌陷，末段是图键）。**只有非空图键才追加第 4 段**，
 * 否则 `['a','b',''].join(SEP)` 会拼出 `a\0b\0` 与 `a\0b` 两种尾巴 —— 同一个槽位两个键。
 */
export function variantKeyOf(parts: VariantKeyParts): string {
  const item = normSegment(parts?.itemKey);
  if (!item) return '';
  const segs = [normSegment(parts?.shopKey), item, normSegment(parts?.colorKey)];
  const img = normSegment(parts?.imageKey);
  if (img) segs.push(img);
  return segs.join(SEP);
}

/**
 * 拆键（展示 / 排障用；非法输入返回全空串，不抛错——查询路径不该因脏键崩）。
 *
 * 接受 3 段与 4 段。**其他长度一律视为脏键**（返回全空）：2 段是"少了色"的半截键，
 * 5 段是脏文本里带了 NUL —— 两者都说明这一行不是本函数写出来的，按空处理，
 * 让调用方走"未绑定"路径，而不是猜一个解释。
 */
export function splitVariantKey(key: unknown): Required<VariantKeyParts> {
  const empty = { shopKey: '', itemKey: '', colorKey: '', imageKey: '' };
  const s = typeof key === 'string' ? key : '';
  if (!s) return empty;
  const p = s.split(SEP);
  if (p.length < 3 || p.length > 4) return empty;
  return {
    shopKey: p[0] ?? '',
    itemKey: p[1] ?? '',
    colorKey: p[2] ?? '',
    imageKey: p[3] ?? '',
  };
}

/**
 * 自动建款时的**款编码**：由商品ID 推出，一个 listing 一个款。
 *
 * 为什么不用 `nextStyleCode()`（`STYLE-014` 那种自增）：自增编码只保证"这次不撞"，
 * 不保证"下次还是它" —— 重导同一份报表、或先导 A 店再导 B 店，同一件货会拿到两个编码，
 * 于是款又裂成两个（正是这轮要消灭的现象）。由商品ID 推出的编码是**幂等**的：
 * `ensureStyleByCode` 第二次拿到同一个款。
 *
 * 编码里不放颜色：款是 listing 级（默认 1 listing = 1 款），颜色是款色那层的事。
 * 非法字符折成 `_`（编码会进 `oi_style_colors.code`，那里对字符没有限制，但人要看）。
 */
export function provisionalStyleCode(itemKey: unknown): string {
  const raw = normSegment(itemKey);
  if (!raw) return '';
  // 非法字符**逐个转义**成 `-<十六进制码位>`，而不是统统折成 `_`：
  // 折成 `_` 会让 `ab/cd` 与 `ab_cd` 得到同一个编码 ⇒ 两件货落进同一个款（错并，且查不出来）。
  // 转义是**单射**的（每个非法字符独占自己的转义串，`-` 自身也被转义，所以能唯一还原），
  // 于是"不同商品ID ⇒ 不同款编码"在脏数据上也成立。平台商品ID 是纯数字，这条只在脏数据上生效。
  const safe = raw.replace(/[^0-9A-Za-z]/g, (ch) => '-' + (ch.codePointAt(0) ?? 0).toString(16));
  return `AE-${safe}`.slice(0, 80);
}
