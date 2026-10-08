// 「货与成本」页签的**标识与显示名**（唯一来源）。
//
// 为什么单独一个文件：页签名是用户**真的点得到的入口名** —— 文案里写「去「店铺登记」把门店认下来」
// 与写「去「货与成本」」是同一类承诺（都得能对上屏幕上真有的东西）。名字只在这里写一遍、
// `GoodsView` 的页签表按 id 取它，于是"改页签名"不会变成两处各写一遍然后悄悄漂开。
//
// ⚠️ 与 `src/modules/today/flowCtx.ts` 的 `SHIPPING_TAB_NAMES` 是**同类东西**，但两页的处置不同：
//    · 那边：悬空入口名守卫（`tests/uxEntryNames.spec.ts`）直接读它当**合法入口**（known）；
//    · 本页：页签名当前走那个测试文件里的 `ALLOWED_NON_ENTRY` 豁免 —— 判据是"用户已经在这一页上，
//      只是被指到同页另一个页签"，与「供应商」「待关联队列」同例。
//    ⭐ 但**豁免不等于那个入口存在**（这正是 2026-10-08 的 D1 死锁：文案让用户"先到店铺登记"，
//      而登记功能当时根本不在软件里）。所以存在性另有守卫，写在 `scripts/goods-ui-smoke.mjs`：
//      每个页签都要能点开、并渲染出**真的内容**（不是"页签在、点开一片空白"）。
export type GoodsTabId =
  | 'workbench'
  | 'products'
  | 'shop-products'
  | 'mappings'
  | 'registry'
  | 'suppliers';

/**
 * 页签 id → 用户可见名。
 * ⚠️ 六个 id 都在表里，但**同时出现在屏幕上的只有一部分**（页签表按页面形态分叉，见 `GoodsView`）：
 * `'workbench'` 形态 = 建档与关联 / 店铺登记 / 供应商；`'tabs'` 回退形态 = 产品 /（商品清单）/
 * 映射与关联 / 店铺登记 / 供应商。所以**别拿这张表当"页签都在"的判据**。
 */
export const GOODS_TAB_LABEL: Record<GoodsTabId, string> = {
  workbench: '建档与关联',
  products: '产品',
  'shop-products': '商品清单',
  mappings: '映射与关联',
  registry: '店铺登记',
  suppliers: '供应商',
};

/**
 * 「店铺未归一」那几行的出口页签。
 *
 * 队列提示条上的「现在登记」与行内的「去登记」**都**跳它，用具名常量而不是两处各写一个
 * 裸 `'registry'` —— 漏改一处就是"按钮点了没反应"，那是这一页里最难查的一类毛病
 * （页签 id 是 `data-act="tab-registry"` 拼出来的，字符串错一个字母同样静默点空）。
 */
export const GOODS_TAB_REGISTRY: GoodsTabId = 'registry';
