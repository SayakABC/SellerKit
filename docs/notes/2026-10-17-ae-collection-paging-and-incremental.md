# 整店采集两个真因：翻页判据看了分页器（63 采到 40）+ 跨轮次没有去重台账

> 涉**两仓**：`SellerKitExtensions`（全部修复，扩展 0.3.0 → **0.4.0**）+ SellerKit（**零代码改动**，仅本文档与 CHANGELOG）。
> 宿主侧协议字段未动（`ae-shop-item/v1` 未变），接收链路零改动。

## 结论（下次开工要记得的）

1. ⭐⭐ **换页成功的判据只能看商品卡片，不能看分页器属性**。实测速卖通店铺 `all-items` 页：点页码后
   `currentpage` 在 **~800ms 内**就翻到新页，而新一页的卡片**此刻还没渲染**（DOM 里 **0** 张卡，
   1500ms 后才有 23 张）。旧判据把 `currentpage/totalpage` 算进列表签名 ⇒ 在空列表上采集（采到 0 条），
   随后 `pageNo >= totalpage` 判定「走完」⇒ **整页商品静默丢失还报告「全部完成」**。
   这就是「店铺 63 件只采到 40 条」的真因（第 1 页 40 张 + 第 2 页 23 张，第 2 页被整页吃掉）。
2. ⭐⭐ **现有两道防线，任一道存在都不漏采，别只留一道**（两条互为兜底）：
   ① 换页等待的条件是「**有卡片**且卡片集合变了」；② `settleList()` 等卡片数连续 3 次采样不变
   （列表是分批渲染的，第一次采到卡片时可能只是半截）。合成一条变异（两道都拆）才打得红。
3. ⭐ **停在第 N 页点「采集本店全部」必须先回列表第 1 页**：就地开跑 = 前面几页这轮根本不扫，
   而「扫到 0 条新货」会被当成「店里没新货」——静默漏采。（`startWalk` 只在 `currentpage <= 1` 时就地跑，
   无分页器即视为第 1 页。）
4. ⭐⭐ **跨轮次去重靠独立台账 `aeWalkSeen`，不能靠走位台账 `aeWalk`**：`aeWalk` 在 `phase='done'`
   后不再续用 ⇒ 上一版**第二次点采集会把整店重跑一遍**（列表全翻 + 每款详情页重开一次）。
   新台账 `{ <storeId>: { <itemId>: {at, skus} } }`，新一轮走位开始时灌进 `aeWalk.ledger`
   （`status='done'`）⇒ SKU 阶段自动跳过、列表阶段只推新增。
5. ⭐ **只有 `status==='done'` 才入已采台账**：上次失败的款必须下一轮重采（「来过」≠「采到」，
   把失败记成已采 = 那批货永久丢）。
6. **列表阶段照翻全部页是必须的**（不翻就发现不了新上架的货），省不掉的是 SKU 阶段（逐款开详情页）。
   所以「第二次点采集」= 列表全扫一遍（快）+ SKU 只走新增（慢的那步省了）。
7. 出口不能只有增量：**「整店重采（忽略已采集）」**（`WALK_START` 带 `force:true`）与
   **「清除本店采集记录」**（popup 直写 storage）都要有，否则用户想刷新价格时无路可走。

## 取证

- 真机（克隆 Chrome profile + CDP，店铺 `store/1105668759`）：
  页面自报 `63 items`；第 1 页 DOM 40 张卡、第 2 页 23 张；分页器 `currentpage=1 totalpage=2`（**分页器是对的**）。
  点「2」后 800ms：`currentpage=2`、`cards=0`；1500ms：`cards=23`。
- 修复后把 `content.js` 带桩注入同一真页面跑列表阶段（导航用 `cfg.nav` 捕获，不真开 63 个详情页）：
  `items=63 / rows=63 / failed=0`，帧 `[40, 23]`，`queue` 63 条且去重后仍是 63。
- 增量真机：塞入 40 条 seen 后第二轮 `carried=40`，本轮只推剩下那批（不再推已采的）。
- 回归：扩展仓库 `npm test` **24/24**（新增 6 条：延迟渲染翻页 / 空页判 stalled / 停在第 2 页先回第 1 页 /
  跨轮增量 / force 全量 / 失败款重采）。
- 变异复核（仓库副本逐条打红后复原）：拆「有卡片」判据 → 红；拆「必须在第 1 页」→ 红；
  不载 seen → 红；flushSeen 记失败款 → 红；列表不看已采全推 → 红；**两道翻页防线一起拆** → 红。
  ⚠️ 单拆 `settleList` 或单把签名改回含页码**都不红**（被另一道兜住）——所以这两条用例守的是最终行为，
  不是某一处实现，改代码时要一起看。

## 部署（本机生效路径，2026-10-17 复核）

- Chrome **直接从仓库目录加载**：`~/Library/Application Support/Google/Chrome/Default/Secure Preferences`
  里 `"path":"/Users/ck/work/work/ai/SellerKitExtensions/extensions/ae-profit"`。
  ⇒ 改完在 `chrome://extensions` 点「重新加载」即生效，**没有拷贝步骤**
  （`~/Library/Application Support/Google/Chrome/Default/UnpackedExtensions/` 是旧拷贝位，当前为空）。

相关：`docs/notes/2026-10-16-ae-walk-store-collection.md`（走位状态机）、
`docs/notes/2026-10-15-ae-storefront-collection.md`（商品ID 双空间）、
`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`。
