// 货与成本 · **店铺实体域**的数据访问层。
//
// 与 `api.ts` 同一分工（薄 `ipc.*` 适配 + `unwrap`），**单开一个文件**的理由：
//   `api.ts` 覆盖的是「产品主数据 + 商品ID 映射」两域（`product*` / `shopProduct*`，落在
//   `pl_products` / `pl_variants` / `pl_shop_sku`）；店铺**实体**域落在另外两张表
//   （`sk_shops` / `sk_name_map`，主进程 `electron/shop-db.ts`）、另一批通道。混在一个文件里，
//   "这一页到底碰几张表、哪张是权威"就读不出来了。
//
// 这一域原先只由市场分发的 UI 岛「店铺账号管家」驱动（渲染层是岛，数据层一直在宿主）。
// 2026-10-08 起「店名归一」收进内建（见 `docs/plans/GOODS_UX_REFACTOR_PLAN.md` R1 / UX-G6），
// 于是宿主渲染层也要能调 —— 本文件就是那个消费面。**数据层一行未动**。
import * as ipc from '@/core/services/ipc';
import { unwrapAsync } from './unwrapApi';
import type {
  NameMapKind,
  ShopListItem,
  ShopStatus,
  ShopSummary,
  ShopUpsertInput,
  UnmappedShopRow,
} from '@/types';

const unwrap = unwrapAsync;

/* ============================================================================
   建表 / 读取
   ============================================================================ */

/**
 * 幂等建表（`sk_shops` / `sk_name_map`）。
 * 与「产品」侧同一个纪律：必须在**任何读取之前** await 一次 —— 列表查询假定表已存在。
 */
export const ensure = (): Promise<{ ok: boolean }> => unwrap(ipc.shopDbEnsure());

export const list = (payload?: {
  search?: string;
  platform?: string;
  status?: ShopStatus | '';
  offset?: number;
  limit?: number;
}): Promise<{ rows: ShopListItem[]; total: number }> => unwrap(ipc.shopList(payload));

/** 汇总：店铺侧（家数 / 按平台 / 按状态）+ 两处历史文本的归一进度 */
export const summary = (): Promise<ShopSummary> => unwrap(ipc.shopSummary());

/** 未归一的历史店铺名（**实时聚合**两处文本，不是缓存名单） */
export const unmapped = (): Promise<UnmappedShopRow[]> => unwrap(ipc.shopUnmapped());

/* ============================================================================
   写入
   ============================================================================ */

/**
 * 新增 / 更新店铺（**局部更新**语义：`undefined = 保持`，`'' = 清空`）。
 *
 * 2026-10-22 物理合并后店铺行上还有邮箱 / 企业 / 工具 / 凭证，全量提交会把它们静默清空 ——
 * 故这里只收店铺自身字段，且缺的字段一律保持原值。调用方是店铺选择器等只改店铺属性的入口；
 * 账号 / 企业 / 工具关联的修改走 `shopAccountUpsert`（合并编辑器）。
 */
export const upsert = (payload: ShopUpsertInput): Promise<{ id: number; created: boolean }> =>
  unwrap(ipc.shopUpsert(payload));

/** 归一指派 / 标记忽略。**人显式选的那一个**（`refId`）或"忽略"（`ignored`），没有自动分支。 */
export const map = (payload: {
  raw: string;
  refId?: number;
  ignored?: boolean;
  kind?: NameMapKind;
  note?: string;
}): Promise<{ key: string; refId: number; ignored: boolean }> => unwrap(ipc.shopMap(payload));

/* ============================================================================
   平台词表（`sk_shops.platform`）
   ============================================================================ */

/**
 * 店铺平台取值 —— 与 `ui-plugins/shop-accounts/src/store.ts` 的 `SHOP_PLATFORM_OPTIONS`
 * **逐字同源**（那套小写代码是 `sk_shops` 建表以来的存量值，不能换成展示名）。
 *
 * ⚠️ 为什么不能从历史数据里推：订单 / 采购两处文本**都没有平台字段** ⇒ 平台无法推导，
 * 只能在登记店铺时由人指定。"同名店铺可以合法地同时存在于不同平台"，猜一个就等于把两家店并掉。
 */
export const SHOP_PLATFORM_OPTIONS: { value: string; label: string }[] = [
  { value: 'ae', label: '速卖通（ae）' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'shopee', label: 'Shopee' },
  { value: 'temu', label: 'Temu' },
  { value: 'lazada', label: 'Lazada' },
  { value: 'other', label: '其它' },
];
