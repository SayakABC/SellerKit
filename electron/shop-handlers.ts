// electron/shop-handlers.ts
// 「店铺」主数据渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
// 视图侧为内建「基础数据 › 店铺」与「货品档案」的店铺选择器；数据层留在宿主（ADR-002 C3）。
//   shop-db-ensure  幂等建表（视图首次激活时调用）
//   shop-list       列表（关键字 / 平台 / 状态过滤 + 分页；只列有店名的行）
//   shop-get        单条详情
//   shop-upsert     新增 / 更新（**局部更新**：缺省 = 不动；同平台同名冲突即报错）
//   shop-summary    汇总（店铺数 / 按平台 / 按状态 + 两处历史文本的归一进度）
//   shop-unmapped   未归一的历史店铺名（实时聚合 oi_orders / purchase_sources）
//   shop-gate       门 1（店铺归一）：**订单里**出现过、还没归成店铺实体的店名 + 订单行数
//   shop-map        归一指派 / 标记忽略
//   shop-unmap      撤销归一
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。
// ⚠️ 店铺域只写店铺列（店名 / 地址 / 状态…）；邮箱、企业、工具账号、凭证属「店铺账号」域 ——
//    本文件**不得**碰它们，否则「货品档案」里改一次店铺名就会把账号信息清空。

export {};

import {
  ensureShopSchema,
  listShops,
  getShop,
  upsertShop,
  shopSummary,
  listUnmapped,
  shopNormalizeGate,
  mapName,
  unmapName,
  SHOP_STATUSES,
  NAME_MAP_KINDS,
  type ShopUpsertInput,
} from './shop-db';
import { handle } from './ipc-util';
import { adoptShopItemsForShop } from './shop-item-db';

const MAX = {
  platform: 40,
  name: 200,
  platformShopId: 100,
  shopUrl: 500,
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

/** 可选字段：`undefined`（键缺失 / 非字符串）= 保持原值；字符串照常截断（'' = 清空） */
function optStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

/** 解析正整数 id（非法返回 0） */
function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}

/** 归一类型白名单（非法 → 'shop'） */
function coerceKind(v: unknown): string {
  const s = str(v, MAX.kind).trim();
  return (NAME_MAP_KINDS as readonly string[]).includes(s) ? s : 'shop';
}

/** 店铺入参消毒：结构白名单 + 长度约束（局部更新语义：缺省即「保持原值」） */
function sanitizeShop(payload: any): ShopUpsertInput {
  return {
    id: toId(payload?.id),
    platform: optStr(payload?.platform, MAX.platform)?.trim(),
    name: optStr(payload?.name, MAX.name)?.trim(),
    platformShopId: optStr(payload?.platformShopId, MAX.platformShopId)?.trim(),
    shopUrl: optStr(payload?.shopUrl, MAX.shopUrl)?.trim(),
    site: optStr(payload?.site, MAX.site)?.trim(),
    // 状态非白名单即按「未传」处理（不把非法值静默写成 active 之外的值）
    status:
      payload?.status === undefined
        ? undefined
        : (SHOP_STATUSES as readonly string[]).includes(str(payload.status, MAX.status).trim())
          ? str(payload.status, MAX.status).trim()
          : undefined,
    score:
      typeof payload?.score === 'number' &&
      Number.isFinite(payload.score) &&
      payload.score >= 0
        ? Math.min(payload.score, 2147483647)
        : undefined,
    openedAt: optStr(payload?.openedAt, MAX.openedAt)?.trim(),
    note: optStr(payload?.note, MAX.note),
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
  });
});

handle('shop-get', (payload: any) => {
  ensureShopSchema();
  return getShop(toId(payload?.id));
});

handle('shop-upsert', (payload: any) => {
  ensureShopSchema();
  const input = sanitizeShop(payload);
  const result = upsertShop(input);
  // 收养：采集可能发生在登记之前（那些行落 shop_id=0 + store_key=展示名）；
  // 登记后不收养，用户看到的就是"我登记了还不归位"。三个身份键任一相等即同一家店
  // （店名键在跨平台同名时有歧义，但两条路都是用户自己的店，且错配在认款队列可发现）。
  // 用**合并后**的行去收养：局部更新时入参可能只带了其中一两个键。
  // ⚠️ 这里传的是**地址原文**：`adoptShopItemsForShop` 内部会归一（未登记行的 store_key 存的
  //    就是归一键），两边同口径 —— 外面别自己再归一一次（会与 raw 派生键的口径分叉）。
  const merged = getShop(result.id);
  if (merged) {
    adoptShopItemsForShop(result.id, {
      name: merged.name,
      url: merged.shopUrl,
      storeId: merged.platformShopId,
    });
  }
  return result;
});

handle('shop-summary', () => {
  ensureShopSchema();
  return shopSummary();
});

handle('shop-unmapped', () => {
  ensureShopSchema();
  return listUnmapped();
});

// 门 1：派生，不存档（每次调用按当前库重算）。`ensureOrderSchema` 不在这里跑 ——
// 本函数对"订单表还没建"的情况返回空门（见 `shopNormalizeGate`），
// 而为了一个只读的判断去建别域的表，会让"打开基础数据"顺手改订单库的形状。
handle('shop-gate', () => {
  ensureShopSchema();
  return shopNormalizeGate();
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
