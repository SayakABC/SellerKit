// electron/shop-item-handlers.ts
// 「店铺商品快照」渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
//   shop-items-list      店铺商品段列表（按店铺 / 搜索 / 分页 / 按款筛）
//   shop-items-summary   每家店采集数 / 已认款数 / 最近采集时间
//   shop-items-import    手贴商品ID导入（保底通道：列表页选择器全落空时的退路）
//   shop-items-delete    删一条采集行（按行 id；不联动删认款映射）
import { handle } from './ipc-util';
import {
  deleteShopItem,
  importManualItems,
  listShopItems,
  shopItemsSummary,
  ensureShopItemSchema,
} from './shop-item-db';

handle('shop-items-list', (payload: any) => {
  ensureShopItemSchema();
  // shopId 缺省 = 不过滤店铺；NaN 必须显式转 undefined（typeof NaN === 'number' 会混进 SQL 绑定）
  const shopIdRaw = Number(payload?.shopId);
  const productIdRaw = Number(payload?.productId);
  return listShopItems({
    shopId: Number.isFinite(shopIdRaw) ? shopIdRaw : undefined,
    search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
    page: Number(payload?.page) || 0,
    pageSize: Number(payload?.pageSize) || 50,
    // 只看未认款：服务端过滤，别让渲染层把分页页掏空
    onlyUnconfirmed: payload?.onlyUnconfirmed === true,
    // 按款筛只在给了正数 id 时生效（0 = 没指定，不是"未认款的款"）
    productId: Number.isFinite(productIdRaw) && productIdRaw > 0 ? productIdRaw : undefined,
  });
});

handle('shop-items-summary', () => {
  ensureShopItemSchema();
  return shopItemsSummary();
});

/**
 * 手贴商品ID导入。ids 由渲染层按行/逗号/空白拆分后传来（拆分口径在渲染层，
 * 主进程只做消毒 + 落库）；空行/非字符串计 skipped 并回给调用方展示，不静默吞。
 */
handle('shop-items-import', (payload: any) => {
  const shopId = Number(payload?.shopId);
  const r = importManualItems(Number.isFinite(shopId) ? shopId : 0, Array.isArray(payload?.ids) ? payload.ids : []);
  // 点名落空（店已被删）必须报错上行：返回 skipped 会让界面报"已接收 N 条"，而一行都没落对地方
  if (!r.ok) throw new Error(r.error || '导入失败');
  return r;
});

/**
 * 删一条采集行。按**行 id** 删（唯一键是 shop_id+store_key+item_id 三元组，
 * 同一个商品ID 在多家店下各是一行）；不联动删 pl_shop_sku 认款映射。
 */
handle('shop-items-delete', (payload: any) => {
  ensureShopItemSchema();
  const id = Number(payload?.id);
  if (!Number.isFinite(id) || id <= 0) throw new Error('缺少要删除的采集行 id');
  const removed = deleteShopItem(id);
  if (!removed) throw new Error('采集行不存在或已被删除');
  return { removed: true };
});
