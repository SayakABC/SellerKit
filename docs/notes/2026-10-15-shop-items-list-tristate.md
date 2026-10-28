# 「店铺商品」一片空白的真因：preload 把缺省的 shopId 压成 0（三态参数不许压扁）

2026-10-15 · 修复 + 通道层守卫 · 通用教训：**缺省 ≠ 0**

## 结论

用户报的「采集到 8 条、列表却空白」有**两个独立缺陷**叠在一起。广播桥
（`2026-10-15-ae-items-ingested-broadcast.md`）修的是"采集后已打开页面零点击可见"；
但真让 8 行消失的是**读链自己**：

`electron/preload.ts` 的 `shopItemsList` 把缺省 `shopId` 归一成 `0` ——
`Number(payload?.shopId) || 0` —— 而 `0` 在数据层是**「未登记桶」过滤条件**
（`listShopItems`：`shopId < 0 → shop_id = 0`；有限 ≥0 → 精确等于；`undefined` → 不过滤）。
「货与成本 › 店铺商品」的调用点（`src/modules/goods/useSkuPool.ts:488`）**本来就不传 shopId
（= 看全部）**，被压成桶过滤 ⇒ **已归店的 8 行（`shop_id=4`）手动刷新也一条都不显示**。
所以「重启过了还是看不到」与广播结论不矛盾 —— 坏的是两条不同的链。

## 修法与契约

- 契约 = **三态**：缺省（不过滤）/ ≤0（未登记桶）/ >0（指定店）。preload 原样透传：
  `shopId: Number.isFinite(Number(payload?.shopId)) ? Number(payload?.shopId) : undefined`。
- `shopItemsImport` 刻意**不**改（`|| 0` 保持）：它缺省的语义 = 用户下拉里显式选的
  「未登记桶」（见 `importManualItems` 文档）—— **同一个字段名在两个通道里语义不同，
  各自对齐各自的下游**。
- ⭐ 通用教训：`Number(x) || 0` 这类"归一"把**缺省、0、负数**三种语义压成一个。
  凡参数下游是"缺省 = 特殊行为"的（不过滤 / 全表 / 第一个），preload 只许透传、不许补缺省。
  （同族前例：`2026-10-04-preload-payload-shape.md` —— 形状错了是静默失效。）

## 守卫（通道层）

`npm run ipc:shape:smoke` ⑩（真 preload + 假 ipcMain + 真库）：

1. 发出去的载荷 `shopId === undefined`（压 0 的写法立刻红）；
2. 不过滤时看到全部（≥2 行）；3. 点名店只回该店（逐行 shopId 匹配）；
4. 未登记桶回 0；5. 全新库（DROP 店铺表后）也不抛错（连 fresh-db 守卫一起钉）。

真机复验：真实 userData 克隆 + CDP 驱动 → 8 行全出 + 状态条「已采 8 个商品（已认款 1）」。

## 关联

- `2026-10-15-ae-items-ingested-broadcast.md`（同日另一半：广播桥；该文结论「坏的是可见性」已就地追记）。
- `2026-10-15-fresh-db-sk-shops-guard.md`（同轮修的全新库缺表）·
  `2026-10-15-shop-item-partial-frame-merge.md`（同轮修的"只覆盖非空"）。
- `2026-10-04-preload-payload-shape.md`（同族：preload 静默改形状）。
