# 「待关联采集商品」面板改造：段名、只列未认款、行内 SKU 编辑与删除

**结论（先看这段）**

1. **同一实体只在一个段里维护**。采集快照（`pl_shop_items`）与认款映射（`pl_shop_sku`）是两套
   互不联动的数据，但**认款这件事写的就是映射行** ⇒ 第三段改名「**待关联采集商品**」且**恒只列未认款**
   （渲染层恒传 `onlyUnconfirmed: true`，服务端过滤）。已认款的采集商品只在「已建立映射」里出现。
   原先同一商品在两段同屏出现，是用户报的"页面不协调"的根因之一。
2. **徽标口径 = 待办数，状态条 = 全库事实**。分段徽标报 `total - confirmed`（未认款数），
   与列表口径一致（否则用户看到"徽标 3、表里 2 行"只会以为漏了数据）；采集状态条仍报全库
   （已采 N 个 / 已认款 M），它回答的是"采了多少"这一事实，不随当前段过滤。
3. **改 / 删一律按行 id**，不按 `item_id`。`pl_shop_items` 的唯一键是
   **`(shop_id, store_key, item_id)` 三元组**：同店重复采集是**同一行 UPDATE**（幂等，只覆盖非空字段；
   见 `docs/notes/2026-10-15-shop-item-partial-frame-merge.md`），而同一 `item_id` 在**两家店 /
   未登记桶下各是一行** ⇒ 按 `item_id` 删会误删别家那份。
4. **人工改 SKU 矩阵不动 `scraped_at` / `raw_json`**：人工修改不能冒充"重新采过"（状态条的
   "最近采集"会说假话）。重新采集时按"只覆盖非空"规则**会**覆盖人工修改 —— 这一点写在确认弹层与
   编辑器里，不靠用户猜。
5. **全量提交必须原样带回 `imageUrl`（色图）**：`sku_json` 每行 `{color,size,price,imageUrl}`，
   提交时漏传 = 静默清空色图（建款向导"每色采纳"的输入随之消失，且不报错）。
   行级消毒复用采集那条 `normalizeIngestSku`（color/size/price 全空的行跳过），不新写一套。

## 面板最终形态（代码口径）

| 项 | 实现 |
| --- | --- |
| 三段控件 | `sub-queue` 待关联队列 / `sub-mapped` 已建立映射 / `sub-items` **待关联采集商品**（`data-act` 名一个不动） |
| items 表列 | 勾选 / 图 / **商品ID**（`nowrap` + 省略号 + `title` 全文，16 位 ID 折行会把整列撑高）/ **SKU**（色码文本「黑/L、4/M」+「改」或「补」）/ 采集时间 / 状态 —— **售价列撤掉** |
| 状态列 | 两态：未认款（默认）/ 店铺未登记（整行浅底 + 禁用 + 「去登记」出口）+ **行内「删除」** |
| 工具条 | 直连（分栏）/ 批量关联 / 新建款并关联 / 清空选择 / 手贴商品ID / 打开店铺 / 计数；**没有**「只看未认款」勾选框（改为恒开） |
| 空态 | 「采集的都认款完了」+ 指向「已建立映射」（不再是一张空表） |

## 取证

```bash
npm run build && npm run goods:ui     # 主流程三遍：310 条 PASS
npx vitest run                        # 39 文件 699 例
env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/preload-ipc-shape-smoke.cjs
                                      # ⑪ 段：改矩阵 / 删行 / 不动 scraped_at / 映射不联动删（55 项）
```

**变异复核（证明新断言不是空转）**：把 `useSkuPool.ts` 的 `onlyUnconfirmed: true` 改回 `false`
→ `npm run build` → `goods:ui` **立刻红两条核心断言**：

```
FAIL 切到「待关联采集商品」段：只剩未认款两行（7002 已认款…） | rows=[7001, B0XYZ1234, 7003]
FAIL ⭐ 已认款的 7002 不在本段出现（同一商品只在一个段里维护…） | B=still-here
```

（后续 item-wizard 步随之级联红 —— 那一段依赖"段里只有一行可勾选"的原点态，属预期。）
还原后 `git diff` 无残留、重建后全绿。

## 复发坑（这次又踩到的）

- ⭐⭐ **断言查的那张表只在某个分段下才在 DOM 里**：`mappedRow()` 查的是 `mapped-table`，
  而 items 段的断言里顺手断言"已认款的出现在映射表" ⇒ 不切段就是恒 `missing`。
  **跨段落断言前必须先切到那个段**（切完记得切回来，否则后续步骤的前置态变了）。
- ⭐⭐ **`table-layout: fixed` 下列宽由 `thead` 决定**：状态列实测 150px，而 CSS 写的是
  `width: 108px` —— 因为选择器只写了 `td.gd-c-ops`，`th` 没命中。**列宽选择器必须同时命中 th 与 td**
  （去掉元素限定符 `.gd-items .gd-c-ops` 即可）。这类"声明没生效"只能靠几何取证（`getBoundingClientRect`），
  看 CSS 源码怎么看都对。
- ⚠️ **注入脚本的注释里不能有反引号**（模板串提前闭合，`node --check` 报 `Unexpected identifier`）。
  这条本仓已记过一次，本次又踩 —— 写注释时用「」而不是反引号。
- ⚠️ **文案改了要过 `tests/uxEntryNames.spec.ts`**：空态新文案"认款了的采集商品在「已建立映射」里维护"
  让扫描型守卫报悬空入口名。该守卫是**三选一**判定（宿主模块名 / 岛 displayName / `ALLOWED_NON_ENTRY`），
  同页分段控件走第三类且**必须逐条写理由**（已补「已建立映射」，与「待关联队列」同例）。
