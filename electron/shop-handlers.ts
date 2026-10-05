// electron/shop-handlers.ts
// 「店铺」主数据渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
// 视图侧为市场分发的 UI 岛 `ui-plugins/shop-accounts`（店铺登记子页）；数据层留在宿主（ADR-002 C3）。
//   shop-db-ensure  幂等建表（视图首次激活时调用）
//   shop-list       列表（关键字 / 平台 / 状态过滤 + 分页）
//   shop-get        单条详情
//   shop-upsert     新增 / 更新（全量提交；同平台同名冲突即报错）
//   shop-summary    汇总（店铺数 / 按平台 / 按状态 + 三处历史文本的归一进度）
//   shop-unmapped   未归一的历史店铺名（实时聚合 oi_orders / purchase_sources / ae_orders）
//   shop-map        归一指派 / 标记忽略
//   shop-unmap      撤销归一
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import {
  ensureShopSchema,
  listShops,
  getShop,
  upsertShop,
  shopSummary,
  listUnmapped,
  mapName,
  unmapName,
  SHOP_STATUSES,
  NAME_MAP_KINDS,
  type ShopUpsertInput,
} from './shop-db';
import { handle } from './ipc-util';

const MAX = {
  platform: 40,
  name: 200,
  platformShopId: 100,
  site: 40,
  status: 20,
  openedAt: 40,
  note: 2000,
  search: 200,
  kind: 20,
} as const;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}

/** 状态白名单（非法 → 'active'；与 shop-db 的 normStatus 同口径） */
function coerceStatus(v: unknown): string {
  const s = str(v, MAX.status).trim();
  return (SHOP_STATUSES as readonly string[]).includes(s) ? s : 'active';
}

/** 归一类型白名单（非法 → 'shop'） */
function coerceKind(v: unknown): string {
  const s = str(v, MAX.kind).trim();
  return (NAME_MAP_KINDS as readonly string[]).includes(s) ? s : 'shop';
}

/** 店铺入参消毒：结构白名单 + 长度约束（全量提交语义，缺省即空） */
function sanitizeShop(payload: any): ShopUpsertInput {
  return {
    id: toId(payload?.id),
    platform: str(payload?.platform, MAX.platform).trim(),
    name: str(payload?.name, MAX.name).trim(),
    platformShopId: str(payload?.platformShopId, MAX.platformShopId).trim(),
    site: str(payload?.site, MAX.site).trim(),
    shopSetId: toId(payload?.shopSetId),
    status: coerceStatus(payload?.status),
    openedAt: str(payload?.openedAt, MAX.openedAt).trim(),
    note: str(payload?.note, MAX.note),
  };
}

handle('shop-db-ensure', (): { ok: boolean } => {
  ensureShopSchema();
  return { ok: true };
});

handle('shop-list', (payload: any) => {
  ensureShopSchema();
  const platform = str(payload?.platform, MAX.platform).trim();
  const status = str(payload?.status, MAX.status).trim();
  return listShops({
    offset: Number(payload?.offset) || 0,
    limit: Number(payload?.limit) || 50,
    search: str(payload?.search, MAX.search).trim(),
    platform,
    status: (SHOP_STATUSES as readonly string[]).includes(status) ? status : '',
    // 只看某个账号套装名下的店铺（店铺套编辑抽屉用）；0 = 不过滤
    shopSetId: toId(payload?.shopSetId),
  });
});

handle('shop-get', (payload: any) => {
  ensureShopSchema();
  return getShop(toId(payload?.id));
});

handle('shop-upsert', (payload: any) => {
  ensureShopSchema();
  return upsertShop(sanitizeShop(payload));
});

handle('shop-summary', () => {
  ensureShopSchema();
  return shopSummary();
});

handle('shop-unmapped', () => {
  ensureShopSchema();
  return listUnmapped();
});

// 归一指派 / 标记忽略。**写入方唯一是这里**（`source='manual'`）—— 见 shop-db.ts 头注口径 3。
handle('shop-map', (payload: any) => {
  ensureShopSchema();
  return mapName({
    raw: str(payload?.raw, MAX.name),
    refId: toId(payload?.refId),
    ignored: payload?.ignored === true,
    kind: coerceKind(payload?.kind),
    note: str(payload?.note, MAX.note),
  });
});

handle('shop-unmap', (payload: any) => {
  ensureShopSchema();
  return unmapName({ raw: str(payload?.raw, MAX.name), kind: coerceKind(payload?.kind) });
});
