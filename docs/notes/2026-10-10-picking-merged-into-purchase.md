# 「生成拣货单」并进「拿货」：六步 → 五步，以及"删页签 ≠ 改名"这条守卫语义

**结论**（2026-10-10，用户实报后的连续处置）：

1. **第 3 步「生成拣货单」取消，拣货清单住进「拿货」页**。理由只有一条：清单按
   「厂家 / 款 × 色 × 码 / 图 / 进价」汇总，而"拿货"要的正是这张单 —— 原第 3 步生成完清单，
   第 5 步拿货**又得从头理一遍**（拿货页只有款色码，图与进价一概没有），同一件事在两个步骤里
   各算一次、口径还不同（清单是"未发货 · 近 30 天"，缺口表是"全部订单"）。
   合并后一条链：**要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账。**
   页签从七个收成**六个**（总览 + 五步：导入 / 归类 / 算钱 / 拿货 / 对账）。
2. **`SHIPPING_TAB_NAMES` 里是"删一项"，不是"改个名"** —— 这是本轮最需要记的一条：
   页签名是**真入口名**（在 `uxEntryNames` 守卫的 `known` 集合里），留着 `picking: '生成拣货单'`
   会让悬空名守卫把一个**点不到的名字**当成合法入口。守卫语义：删掉的功能名要连豁免/锚点一起清
   （该 spec 的自证非空转锚点同步从「生成拣货单」改钉「拿货」）。
3. **不复制 PickingView**：「要拿什么」= 整页复用 `src/modules/picking/PickingView.vue`
   （代码里以 `@/` 别名引入；`embedded auto row-action` + `:refresh-token`），「拿货」页只加行动区与忽略清单。
   同一件事两处摆，迟早两套口径（2026-10-05 岛内「拣货」页签发布前撤回就是这个理由）。
4. **三条必须逐字对齐的口径**（分叉都是静默故障）：
   - `takenKey(styleCode,color,size)` / `ignoreKey(styleCode,color)`（`src/lib/picking.ts`）
     与主进程 `electron/purchase-db.ts#outstanding()` 的行粒度**逐字一致**（`|` 拼接原样字符串）。
     拼法分叉的症状是"明明拿了，清单还说没拿"，两边都看不出错。
   - `remaining = max(0, pieces − taken)`：多拿了是"拿多了"，不是"还差负数"。
   - 款名唯一来源 = `pl_products.name`（`oi_styles.name` **这列不存在**），join 键 `code`，
     用 `tableExists('pl_products')` 守卫（别把"产品库还没建"报成"拣货域坏了"）。
5. **图角标 = 尺码 × 还要拿的件数**，与导出 xlsx 上烧的角标**同源**（图是直接发厂家的：
   写成需求数，厂家会照需求发）。已拿完 / 已忽略不画角标 —— 图上写 0 会读成"拿 0 件"。
6. **一键开单只收所选厂家**（一张拿货单只能挂一个厂家，混着发会把单开给错的厂，而"单里有别家的货"
   在那张单上看不出来）；单价留 0 + `suggestionQty = 还差`（进价是估算，实拿价去编辑器填 ——
   把估算价当已付钱落库，对账永远对不上）。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/modules/today/TodayView.vue` | `TABS` 去 `picking`，编号顺移（3 算钱 / 4 拿货 / 5 对账）；流程卡去掉 `flow-picking`（`picking.sku` 只是总览上的一个数字） |
| `src/modules/today/flowCtx.ts` | `SHIPPING_TAB_NAMES` 删 `picking` 项（页签名唯一真源；见结论 2） |
| `src/modules/today/tabs/PurchasePanel.vue` | 两子视图（`.wb-seg`）：要拿什么（内嵌 `PickingView` + 行动区）/ 拿了什么；原「待拿货缺口」表格视图整块删除（指标计数保留） |
| `src/modules/picking/PickingView.vue` | 需求/已拿/还差 三列 + 图角标 + 「还要拿」指标 + 行尾忽略/取消忽略（`rowAction`）+ 状态三态（已忽略 > 已拿完 > 齐/缺） |
| `src/lib/picking.ts` | `takenKey`/`ignoreKey`；`PickingScope.taken/ignored`；`PickingGroup.styleName/taken/remaining/ignored`；`PickingSummary.takenPieces/remainingPieces/remainingGroups` |
| `src/modules/today/tabs/PickingPanel.vue` | **删除**（`D` staged） |
| `electron/picking-db.ts` | 投影补 `styleName`（`LEFT JOIN pl_products`，见结论 4） |

## 守卫的确定性（数量以当轮跑出的为准）

- `npm run today:ui` **149 → 164**；`npm run picking:ui` **50 → 60**；`picking:smoke` 19 项全绿；
  `vitest run` 36 文件 / **663 用例**（`tests/picking.spec.ts` 32 → 44）。
- **零新 IPC**（`npm run verify` 一字未变）；全部 `data-act` 名未动 ⇒ 既有断言原样重挂。

## 两条写夹具时的纪律（本轮各现形一次）

- **非零夹具是反向断言的前提**：`purchaseOutstanding` 桩必须给**非零 taken**，否则
  `remaining === pieces`，"还差列 / 图角标"两条断言在"实现根本没接线"时也全绿（空转断言，
  靠"把实现改坏一遍"自检才现形）。配套补反向夹具 `__noTaken`（造"一件没拿过"）与
  `__ignore`（造"已忽略"，且**挑有图的那款** —— 拿没图的组当样本，角标本来就没得挂）。
- **`waitFor` 超时会中断整份脚本** ⇒ 新等待一律 `tryWait`（超时不当异常，断言自己给结论）。

## 后续（同日，已发生）：界面形态被重设计取代

用户当天再看这页："拿货 tab 界面一条一条的实在太多了" ⇒ 清单与拿货页**再次重设计**：行粒度
款色码 → **款色**（尺码折成 `L×2` chips，屏上不再画图角标、导出仍按码烧）、页级指标条与
"先选厂家"行动区撤掉（开单按钮钉厂家段尾、数字就地给）。**结论 1–4 不受影响**；结论 5 的
"角标写还差"现在只对导出 xlsx 成立；结论 6 的"只收本厂"不变但入口改为段尾按钮。
当前形态见 [`2026-10-10-purchase-tab-rework.md`](2026-10-10-purchase-tab-rework.md)。
