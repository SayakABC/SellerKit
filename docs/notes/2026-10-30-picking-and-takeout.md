# 拣货与拿货：32 条结论（蒸馏自 4 篇，2026-10-05 ~ 2026-10-17）

> **蒸馏笔记**：由 4 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-picking-and-takeout.md`（其余三篇同法，路径见文末清单）

## 1. 带图 xlsx 的四类症状速览

**结论**：S3 拣货单升级（`docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §6）要产出一份**能直接发厂家**的带图 xlsx，做完发现三个 bug —— 前两个**同样存在于既有的拿货单导出**，第三个是**冒烟脚本的假绿**。四条症状 / 根因 / 判据：

| # | 症状 | 根因 | 判据 / 纪律 |
| --- | --- | --- | --- |
| ① | Excel 提示"需要修复"并丢图；`xl/media/image1.undefined` | exceljs `addImage({ filename })` **不给 `extension`** | 扩展名**按文件内容推**（不是按文件名），并显式传 `extension`；包结构合法性要**读回 `[Content_Types].xml` 验** |
| ② | 主进程拿不到图（既转不了码也拿不到宽高） | **Electron `nativeImage` 解不了 WebP** | 图**归渲染层编码**（Chromium 有 WebP 解码），主进程只收 base64 + 尺寸 |
| ③ | 冒烟报"失败"，**退出码却是 0** | `process.exit(1)` 之后再跟 `process.exit(0)` | **同一段流程只调一次 `process.exit`**；`process.exitCode = 1` 在 Electron 下**不退出** |
| ④ | 一件价都没查到，界面写 `预估 ¥0.00` | 把"未知"表达成 0 | 并列金额的地方走**同一对函数**：全缺 → `—` +「N 件全部无进价」；部分缺才叫"不含" |

**取证**：三条都有可复制的取证，见 §2 / §4 / §6。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 2. exceljs 忘给 `extension` ⇒ 包结构不合法，而返回值里看不出来

**结论**：exceljs `addImage({ filename })` **不给 `extension`** ⇒ 产出 `xl/media/image1.undefined` ⇒ OPC 要求每个 part 都有内容类型 ⇒ 包不合法 ⇒ Excel 走修复流程、**图被丢掉**（用户只看到"格式有点问题"，不会知道图没了）。扩展名必须**按文件内容推**（不是按文件名）并显式传 `extension`；包结构合法性要**读回 `[Content_Types].xml` 验**。

**取证**（`scripts/picking-xlsx-smoke.cjs` 的断言输出）：

```
✗ xl/media 条数应为 2，实际 3（xl/media/, xl/media/image2.undefined, xl/media/image1.undefined）
```

读回 `[Content_Types].xml` 看到的是 `<Default ContentType="image/undefined"/>` —— **连 `Extension` 属性都是空的**。

⚠️ 关键点：**这个 bug 在"导出成功"的返回值里完全看不出来** —— `wb.xlsx.writeFile()` 正常返回，`fs.writeFileSync` 正常返回，函数返回 `{ filePath, rows, images }` 里 `images` 还是对的（因为图确实被 `addImage` 登记了）。只有**读回 zip 看部件名**才能发现。

修法（`electron/xlsx-image.ts`）：

```ts
const fmt = sniffImageFormat(head);       // 按**内容**嗅探（PNG/JPEG 文件头）
if (!fmt) return null;                    // 认不出内容类型 → 嵌进去也是打不开的图
addImageArg = { filename: p, extension: fmt };   // ⚠️ extension 必须给
```

同源修复：`electron/purchase-handlers.ts` 原先自己抄了一份 `imageSizeOf` + 同样的 `addImage({ filename })` ⇒ **既有的拿货单导出**一并改为共用 `embedCellImage`。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 3. 为什么按内容推而不是按文件名

**结论**：存量图里有"**内容是 PNG、名字是 `.jpg`**"的（当初保存时按订单给的扩展名落盘）。按名字推 ⇒ 写 `xl/media/image1.jpg` 但内容不是 JPEG ⇒ 又是打不开的图。

**取证**：存量图中存在"内容是 PNG、名字是 `.jpg`"的样本。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 4. Electron `nativeImage` 解不了 WebP ⇒ 图必须由渲染层编码

**结论**：主进程在 WebP 上**既转不了码也拿不到宽高**，只能把 webp 原件塞进 xlsx；旧版 Office / WPS 显示不出来 —— 与"发厂家"的用途直接冲突。修法是分层，而不是在主进程里硬解：

```
渲染层  <img> → canvas → toDataURL('image/jpeg', 0.85) → { base64, width, height }
主进程  embedCellImage(wb, ws, row, { base64, width, height })
```

- 渲染层 = Chromium，**自带 WebP 解码**；`src/lib/pickingExport.ts` 的 `domToJpeg` **永不 reject**（单张坏图不阻断导出），JPEG 无透明通道 ⇒ **先铺白底**再画。
- 顺带的好处：主进程**不再需要"按渲染层给的路径读任意文件"**（少一个路径穿越面）。

**取证**（真 Electron + `env -u ELECTRON_RUN_AS_NODE`，对 4 张真实订单图跑）：

```
nativeImage.createFromPath('/…/img-3.webp')   → isEmpty() = true
nativeImage.createFromBuffer(buf, {width:1})  → isEmpty() = true
```

而**真实订单图 8/9 张内容是 WebP**（文件名 `.webp`，另有一张"内容是 webp、名字是 `.jpg`"）。

⚠️ 环境坑：本机 shell 里 `ELECTRON_RUN_AS_NODE=1` 常驻时 `nativeImage` 是 `undefined`，跑真 Electron 探针要 `env -u ELECTRON_RUN_AS_NODE`。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 5. 冒烟"失败"却以退出码 0 结束（跨脚本假绿）

**结论**：`process.exit(1)` 之后再跟 `process.exit(0)` ⇒ 红的被报成绿。**纪律：同一段流程里只调一次 `process.exit`**，写成单点。

**取证**（`scripts/picking-xlsx-smoke.cjs` 的变异副本，把 `sheets.length` 断言从 2 改成 3）：

```
✗ 拣货单 xlsx 冒烟失败：1 项
✓ 拣货单 xlsx 冒烟全部通过          ← 两行都打印了
exit code = 0                       ← 红的被报成绿
```

原写法：

```js
if (failed > 0) { console.log(`✗ …失败：${failed} 项`); process.exit(1); }
console.log('✓ …全部通过');
process.exit(0);                    // ← 这一行照样执行，退出码 0
```

正确写法（单点退出）：

```js
console.log('');
if (failed > 0) console.log(`✗ …冒烟失败：${failed} 项`);
else console.log('✓ …冒烟全部通过');
process.exit(failed > 0 ? 1 : 0);   // 唯一的退出点
```

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 6. `process.exit` / `exitCode` 的定性探针（真 Electron，两模式都测）

**结论**：四种写法的实测结果：

| 写法 | 结果 |
| --- | --- |
| `process.exit(1)` 在**顶层同步**代码里 | `exit=1`（正常，进程真的终止） |
| `process.exit(1)` 在**异步续体**里 | `exit=1` |
| `if (...) exit(1)` 之后**再跟** `exit(0)` | **`exit=0`** —— 两次 log 都打印 |
| `process.exitCode = 1`（不调 `exit`） | **不退出**（事件循环不空，实测挂住） |

**取证**：上表为上表四种写法的实跑结果。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 7. 存量风险（本轮未清）：一批 DB 冒烟仍是"再 exit(0)"结构

**结论**：⚠️ **存量风险（本轮未清）**：`scripts/*.cjs` 的一批 DB 冒烟（`picking-db` / `order-db` / `ae-cost` / `style-authority` / `schema-migration` / `shop-db` / `ship-rate-db` …）多是同款 `if(failed){…exit(1)} … exit(0)` 写法。它们的引导脚本（`npm run x:smoke` → `electron scripts/x.cjs`）**退出码在 node 模式下确认真实透传**，所以作为门禁暂时有效；但**"后来又 exit(0)"这个结构本身没清**，一次重构就可能把红变成绿。

**取证**：上列脚本名与引导命令 `npm run x:smoke` → `electron scripts/x.cjs`。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 8. 「未知」不能写成 0（截图复核发现的表达失真）

**结论**：一件价都查不到时，段标题与顶部指标写的是 `预估 ¥0.00` —— 读起来是"这批货不值钱"，而事实是"还不知道多少钱"。**0 有两种含义（真的不要钱 / 没查到价），写 0 会让"估算偏低"和"真的很便宜"长得一模一样。** 这是**拍图拍出来的**（冒烟全绿：断言只钉了正例"有价的段写 ¥60.00"，没钉"全无价时不许写 ¥0.00"）。

修法：并列金额的地方**走同一对函数**（`src/modules/picking/PickingView.vue`）：

```ts
function amountText(amount: number, noPricePieces: number, pieces: number): string {
  if (noPricePieces > 0 && noPricePieces >= pieces) return '—';   // 全缺 → 不写 0
  return `¥${money(amount)}`;
}
function noPriceNote(noPricePieces: number, pieces: number): string {
  if (noPricePieces <= 0) return '';
  return noPricePieces >= pieces
    ? `（${noPricePieces} 件全部无进价）`   // 全缺：说"全部"
    : `（不含 ${noPricePieces} 件无进价）`;  // 部分缺：才叫"不含"
}
```

**取证**：冒烟断言只钉了正例"有价的段写 ¥60.00"。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 9. 导出侧同一条纪律：无价的行金额写 `undefined`，不写 0

**结论**：同一条纪律在**导出**侧也一样：无价的行金额写 `undefined`（Excel 里留空），**不写 0**（`picking:xlsx:smoke` 有断言：读回来必须是 `null`）。

**取证**：`picking:xlsx:smoke` 断言读回来必须是 `null`。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 10. 「口径不搬」原则：渲染层算口径 + 编码图，主进程只画表

**结论**：导出链的最终形态是 **「渲染层算口径 + 编码图，主进程只画表」**：

- 进价复用 `orderCost.pickUnitCost`（款级成本区间，按**该行的下单日期**取当时生效的那条）+ 同一份 `round2` ⇒ 拣货页与「算钱」页不会出现"同一条订单两种成本"。
- `electron/picking-xlsx.ts` **不 import 任何 `*-db`**，只吃"已经算好的行"。
- ⇒ 结构上不可能出现"屏幕上的数与导出的数不一致"。

**取证**：`electron/picking-xlsx.ts` 不 import 任何 `*-db`。

**源**：`2026-10-05-picking-export-with-images`（2026-10-05）

---

## 11. 【历史记录】「生成拣货单」并进「拿货」：六步 → 五步

**结论**：【历史记录】**第 3 步「生成拣货单」取消，拣货清单住进「拿货」页**。理由只有一条：清单按「厂家 / 款 × 色 × 码 / 图 / 进价」汇总，而"拿货"要的正是这张单 —— 原第 3 步生成完清单，第 5 步拿货**又得从头理一遍**（拿货页只有款色码，图与进价一概没有），同一件事在两个步骤里各算一次、口径还不同（清单是"未发货 · 近 30 天"，缺口表是"全部订单"）。合并后一条链：**要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账。** 页签从七个收成**六个**（总览 + 五步：导入 / 归类 / 算钱 / 拿货 / 对账）。

**取证**：用户实报后的连续处置（2026-10-10）。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 12. 【历史记录】`SHIPPING_TAB_NAMES` 里是"删一项"，不是"改个名"

**结论**：【历史记录】**`SHIPPING_TAB_NAMES` 里是"删一项"，不是"改个名"** —— 这是本轮最需要记的一条：页签名是**真入口名**（在 `uxEntryNames` 守卫的 `known` 集合里），留着 `picking: '生成拣货单'` 会让悬空名守卫把一个**点不到的名字**当成合法入口。守卫语义：删掉的功能名要连豁免/锚点一起清（该 spec 的自证非空转锚点同步从「生成拣货单」改钉「拿货」）。

**取证**：`uxEntryNames` 守卫的 `known` 集合；锚点从「生成拣货单」改钉「拿货」。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 13. 【历史记录】不复制 `PickingView`，整页复用

**结论**：【历史记录】**不复制 PickingView**：「要拿什么」= 整页复用 `src/modules/picking/PickingView.vue`（代码里以 `@/` 别名引入；`embedded auto row-action` + `:refresh-token`），「拿货」页只加行动区与忽略清单。同一件事两处摆，迟早两套口径（2026-10-05 岛内「拣货」页签发布前撤回就是这个理由）。

**取证**：`@/` 别名引入；`embedded auto row-action` + `:refresh-token`。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 14. 【历史记录】三条必须逐字对齐的口径（分叉都是静默故障）

**结论**：【历史记录】三条必须逐字对齐的口径：

- `takenKey(styleCode,color,size)` / `ignoreKey(styleCode,color)`（`src/lib/picking.ts`）与主进程 `electron/purchase-db.ts#outstanding()` 的行粒度**逐字一致**（`|` 拼接原样字符串）。拼法分叉的症状是"明明拿了，清单还说没拿"，两边都看不出错。
- `remaining = max(0, pieces − taken)`：多拿了是"拿多了"，不是"还差负数"。
- 款名唯一来源 = `pl_products.name`（`oi_styles.name` **这列不存在**），join 键 `code`，用 `tableExists('pl_products')` 守卫（别把"产品库还没建"报成"拣货域坏了"）。

**取证**：`src/lib/picking.ts` 与 `electron/purchase-db.ts#outstanding()`。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 15. 【历史记录】图角标 = 尺码 × 还要拿的件数

**结论**：【历史记录】**图角标 = 尺码 × 还要拿的件数**，与导出 xlsx 上烧的角标**同源**（图是直接发厂家的：写成需求数，厂家会照需求发）。已拿完 / 已忽略不画角标 —— 图上写 0 会读成"拿 0 件"。界面形态重设计后，该结论**只对导出 xlsx 成立**（见 §19）。

**取证**：同源角标；已拿完 / 已忽略不画。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 16. 【历史记录】一键开单只收所选厂家

**结论**：【历史记录】**一键开单只收所选厂家**（一张拿货单只能挂一个厂家，混着发会把单开给错的厂，而"单里有别家的货"在那张单上看不出来）；单价留 0 + `suggestionQty = 还差`（进价是估算，实拿价去编辑器填 —— 把估算价当已付钱落库，对账永远对不上）。后续入口改为段尾按钮，"只收本厂"不变。

**取证**：`suggestionQty = 还差`；单价留 0。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 17. 【历史记录】并入记录改了哪些文件

**结论**：【历史记录】本轮改动的文件清单：

| 文件 | 改动 |
| --- | --- |
| `src/modules/today/TodayView.vue` | `TABS` 去 `picking`，编号顺移（3 算钱 / 4 拿货 / 5 对账）；流程卡去掉 `flow-picking`（`picking.sku` 只是总览上的一个数字） |
| `src/modules/today/flowCtx.ts` | `SHIPPING_TAB_NAMES` 删 `picking` 项（页签名唯一真源；见 §12） |
| `src/modules/today/tabs/PurchasePanel.vue` | 两子视图（`.wb-seg`）：要拿什么（内嵌 `PickingView` + 行动区）/ 拿了什么；原「待拿货缺口」表格视图整块删除（指标计数保留） |
| `src/modules/picking/PickingView.vue` | 需求/已拿/还差 三列 + 图角标 + 「还要拿」指标 + 行尾忽略/取消忽略（`rowAction`）+ 状态三态（已忽略 > 已拿完 > 齐/缺） |
| `src/lib/picking.ts` | `takenKey`/`ignoreKey`；`PickingScope.taken/ignored`；`PickingGroup.styleName/taken/remaining/ignored`；`PickingSummary.takenPieces/remainingPieces/remainingGroups` |
| `src/modules/today/tabs/PickingPanel.vue` | **删除**（`D` staged） |
| `electron/picking-db.ts` | 投影补 `styleName`（`LEFT JOIN pl_products`，见 §14） |

**取证**：见上表。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 18. 【历史记录】守卫的确定性（数量以当轮跑出的为准）

**结论**：【历史记录】当轮门禁数字：`npm run today:ui` **149 → 164**；`npm run picking:ui` **50 → 60**；`picking:smoke` 19 项全绿；`vitest run` 36 文件 / **663 用例**（`tests/picking.spec.ts` 32 → 44）。**零新 IPC**（`npm run verify` 一字未变）；全部 `data-act` 名未动 ⇒ 既有断言原样重挂。

**取证**：上列命令与数字。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 19. 【历史记录】后续（同日，已发生）：界面形态被重设计取代

**结论**：【历史记录】用户当天再看这页："拿货 tab 界面一条一条的实在太多了" ⇒ 清单与拿货页**再次重设计**：行粒度 款色码 → **款色**（尺码折成 `L×2` chips，屏上不再画图角标、导出仍按码烧）、页级指标条与"先选厂家"行动区撤掉（开单按钮钉厂家段尾、数字就地给）。**结论 11–14 不受影响**；§15 的"角标写还差"现在只对导出 xlsx 成立；§16 的"只收本厂"不变但入口改为段尾按钮。当前形态见 [`2026-10-10-purchase-tab-rework.md`](2026-10-30-ui-nav-and-tabs.md)。

**取证**：用户原话"拿货 tab 界面一条一条的实在太多了"。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）

---

## 20. 【历史记录】两条写夹具的纪律（本轮各现形一次）

**结论**：【历史记录】**非零夹具是反向断言的前提**：`purchaseOutstanding` 桩必须给**非零 taken**，否则 `remaining === pieces`，"还差列 / 图角标"两条断言在"实现根本没接线"时也全绿（空转断言，靠"把实现改坏一遍"自检才现形）。配套补反向夹具 `__noTaken`（造"一件没拿过"）与 `__ignore`（造"已忽略"，且**挑有图的那款** —— 拿没图的组当样本，角标本来就没得挂）。**`waitFor` 超时会中断整份脚本** ⇒ 新等待一律 `tryWait`（超时不当异常，断言自己给结论）。

**取证**：`__noTaken` / `__ignore` 两个反向夹具。

**源**：`2026-10-10-picking-merged-into-purchase`（2026-10-10）、`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 21. 【历史记录】拣货单取数只看四件事，与"归类核对做到哪"无关

**结论**：【历史记录】拣货单的取数只看四件事：`未发货`（宿主机械筛）· `非已终结`（`bucketOfStatus` 关/完成）· `天数窗`（默认近 30 天，`lib/picking` 的 `cutoffDate`）· `店铺`。**它不读"归类核对到什么状态"** —— 归类只决定清单里的款 × 色 × 码对不对，不决定行会不会进清单。所以"品类/款都核对完了却还是空的"是**两个不相干的问题**，别顺着归类去查。

⚠️ 同日晚的后续：入口表述已变 —— 清单现在「拿货 › 要拿什么」**进页即自动生成**；取数口径（未发货 / 非已终结 / 天数窗 / 店铺）与本节两条夹具纪律不变。

**取证**：用户实报「归类核对做完，点生成拣货单还是提示扫了 9 行都被排除了」。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 22. 【历史记录】9 行被排除的真因是天数窗（46 天 > 30 天）

**结论**：【历史记录】那 9 行的真因是**天数窗**：下单日全是 `2026-08-25`，距当天 46 天 > 30 天 ⇒ `excludedOld = 9`、`excludedFinished = 0`。放宽办法：`更多 → 天数窗` 调大（**`0` = 不限**）。

**取证**：

```bash
# 真库在 seller-kit；`.../SellerKit/sellerkit.db` 是 0 字节的空壳（读它会得出"库里什么都没有"的错结论）
sqlite3 -header -column "$HOME/Library/Application Support/seller-kit/sellerkit.db" \
  "SELECT id, order_no, order_time, status, biz_status, ship_time FROM oi_orders
   WHERE ship_time = '' AND status <> 'shipped' ORDER BY id DESC;"
# → 9 行，order_time 全 2026-08-25，biz_status 全为 ''
```

- 归类**是**生效的：`oi_orders.image_id → oi_images.style_color_id → oi_style_colors.style_id → oi_styles.code` 9 行都挂上了款（`SUST-011/016/012/001/009`、`STYPE-001`）。
- 纯层复现（等形状夹具跑 `aggregatePicking`）：`days=30 → scanned 9 / groups 0 / excludedOld 9`；`days=60 或 0 → rows 9 / groups 4`。
- UI 证据：条件条上写着 `超窗剔除 9 行`，`已排除已终结` 那一格**没出现**（= 0）——两个数分项就在同一行上。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 23. 【历史记录】空态文案要按实际生效的口径分开，并把"下一步"做成真按钮

**结论**：【历史记录】界面上"为什么空"原先只有一句「都被『已终结 / 超窗』排除了」，**不说到底哪个**；而它给的两个动作（调天数窗 / 勾"连已发货"）**各自只对一半场景有效** ⇒ 用户照做一次没变化，只能认为坏了。本轮把文案按**实际生效的口径**分开、把"下一步"做成真按钮，并让改条件即重算（见 CHANGELOG）。

**取证**：见 CHANGELOG 对应条目。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 24. 【历史记录】「已终结」这一层对没有状态列的报表是空转的

**结论**：【历史记录】「已终结」这一层对没有状态列的报表是空转的：`biz_status` 只从列名族 `^订单状态` / `^状态$` 提取（`electron/orderMoney.ts` 的 `TEXT_KEYS`）。用户这批报表的列只有 `店铺名 / 尺寸 / 订单号 / 下单时间 / 产品信息 / 产品数量 / 产品图片链接 / 产品ID` ⇒ `biz_status` 恒空 ⇒ `bucketOfStatus('') = 'unknown'` ⇒ 关闭单**照样进拣货单**（只是这次被天数窗挡了）。反过来不会误剔 —— 没这列就判不出终结。

**取证**：`electron/orderMoney.ts` 的 `TEXT_KEYS`；用户报表列名如上。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 25. 【历史记录】`pickingRows` 的上限是静默的（LIMIT 2000）

**结论**：【历史记录】`pickingRows` 的上限是静默的：`ORDER BY id DESC LIMIT 2000`，`meta.limit` 回了但视图没用 ⇒ 超过 2000 行时最旧那批**无声消失**，把天数窗调大也补不回来、计数里也看不到（违反本仓"不许静默"）。

**取证**：`ORDER BY id DESC LIMIT 2000`；`meta.limit` 回了但视图没用。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 26. 【历史记录】`oi_style_colors.color` 的占位值 `未分类` 在拣货投影里是个真颜色

**结论**：【历史记录】`oi_style_colors.color` 的占位值 `未分类` 在别处被当"没有颜色"处理（`order-db.ts` 的 `MAPPED_FALLBACK_COLOR`：写映射时回落款级 `'*'`），但拣货投影里它是个**真颜色**（`color = style_color || 订单原文色`）⇒ 清单键显示 `S1 · 未分类 · XL`，而"真的没色"那支显示 `(无颜色)` —— 同一件事两种写法；且 `未分类` 不会命中 `pl_variants` 的色卡 ⇒ 这些行拿不到 SKU 克重。

**取证**：`order-db.ts` 的 `MAPPED_FALLBACK_COLOR`；键显示 `S1 · 未分类 · XL` 对 `(无颜色)`。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 27. 【历史记录】一个原因一个反向夹具（超窗那一支此前从未被验过）

**结论**：【历史记录】**超窗那一支此前从未被验过**：`picking-ui-smoke` 的假桥只有 `__onlyFinished` 一个"全被剔除"的夹具，而用户实报的恰恰是另一支。补夹具 = 补 `__onlyOld`（一行 400 天前）——**一个原因一个反向夹具**，否则"两种原因合并写"这种错永远测不出来。

**取证**：`__onlyFinished` 只有一支；补 `__onlyOld`（一行 400 天前）。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 28. 【历史记录】`waitFor` 超时会中断整份脚本 ⇒ 新增等待一律 `tryWait`

**结论**：【历史记录】**`waitFor` 超时会中断整份脚本**：抛到最外层 catch ⇒ 后面几十条断言全不跑，报出来的失败条数与真实失败数无关。新增等待一律走 `tryWait`（超时不当异常，断言自己给结论）。

**取证**：抛到最外层 catch ⇒ 后面几十条断言全不跑。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 29. 【历史记录】扫描型守卫会拦新写的话术 ⇒ 按真名写，而不是加豁免

**结论**：【历史记录】扫描型守卫（`tests/uxEntryNames.spec.ts` 的悬空入口名）**会拦新写的话术**：本轮文案里 `去「今天 › 导入订单」` 被判悬空（那不是任何入口的真名），改成 `去「今天」页的「导入订单」页签` —— 页签名来自 `SHIPPING_TAB_NAMES`，是**真入口**，按真名写而不是加豁免。

**取证**：`tests/uxEntryNames.spec.ts` 判 `去「今天 › 导入订单」` 悬空。

**源**：`2026-10-10-picking-scope-and-empty-state`（2026-10-10）

---

## 30. 【历史记录】摘掉左导航的「拣货」：删的是入口，不是功能

**结论**：【历史记录】`picking` 退出模块清单（`modules.config.json` 三处），`src/modules/picking/{meta,index}.ts` 删除，`PickingView.vue` 原样留给「今天 › 拿货 › 要拿什么」。同一份清单**只有一个入口**了。它的假桥冒烟 `picking:ui` 随之退役，但**验收面没有变窄**：真生成在主进程的那条链（`pickingExportExcel` 出参 / 图已转 JPEG / 无价行金额 `null`）与「只改条件不点按钮也重算」搬进了 `today:ui`。

为什么不是"再留一个入口"：清单功能 2026-10-10 就并进了「拿货」，独立页从那天起就是**第二条路**：两处都能出同一份单，口径却又各有取数入口。`AGENTS.md` 的「入口唯一」判的是"删掉它闭环还成立吗" —— 成立（拿货页里一条不少），所以它属于**可删的冗余入口**，而不是主干。

功能面核对（删完后用户还能做什么，逐条对过 `PickingView.vue`）：

| 动作 | 内嵌后的落点 |
| --- | --- |
| 生成/重算清单 | `auto` 进页即生成；改条件（天数窗 / 店铺 / 含已发货）自动重算 |
| 导出带图 xlsx | 精简条 `data-act="export"`（与页头那颗是同一实现） |
| 天数窗 / 店铺 / 含已发货 | 精简条「更多」展开 |
| 复制给厂家清单图、按厂家开单、忽略/取消忽略 | 汇总条与卡片行动作（**只有内嵌形态才给**，本来就依赖宿主） |

**取证**：

- 注册表不再含它：`src/registry.generated.ts` 的 `enabledModuleMetas` / `moduleViewLoaders` 均无 `picking`（`npm run build` 生成，构建期裁剪 ⇒ 侧边栏与 ⌘K 都不会出现）。
- 没有代码还在跳它：全仓 `'picking'` 只剩两处**注释**（`src/modules/today/tabs/ImportPanel.vue` 的历史说明、`scripts/today-ui-smoke.mjs` 的"不许出现模块 id 字面量"反向守卫）。
- 门禁：`vue-tsc` / `tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `build` / 全量 `vitest` / `today:ui` 全绿。`picking:smoke`（`electron/picking-db.ts` 投影）与 `picking:xlsx:smoke`（主进程画表）**一行没改，照跑**。

**源**：`2026-10-17-picking-menu-removed`（2026-10-17）

---

## 31. 【历史记录】看着像死代码、但必须留着的东西

**结论**：【历史记录】

- **`PickingView.vue` 的 `!embedded` 那一支**（页头 + `goImport()` 里的 `switchModule('today')`）：生产上恒为 `embedded`，确实不可达。留着的理由是它是这个组件的**自洽形态**（换宿主/再挂独立页时不用重写），且删它要连带拆页头里那三颗按钮的样式与 `wb-head` 契约 —— 收益只有"少 30 行 DOM"。已在文件头注明"生产恒为 `embedded`"，避免下一个人以为还能导航到它。
- **`pickingRows` / `pickingExportExcel` 两条 IPC 通道**：仍是「今天」总览卡（待拣）与拿货页的取数口，消费方没减少，只是不再有第二个页面调。
- **`src/lib/picking*.ts` 四个纯函数文件**：口径单源，`today:ui` 与 `picking:smoke` 都钉着它们。

**取证**：见上三条。

**源**：`2026-10-17-picking-menu-removed`（2026-10-17）

---

## 32. 【历史记录】下次做同类"摘菜单"时的五步顺序

**结论**：【历史记录】

1. `modules.config.json` 三处一起删（`profiles.*` 与 `enabledModules`）——只删一处会出现"预设里有、兜底没有"的漂移；
2. 删模块壳（`meta.ts` / `index.ts`），**留视图**；
3. **搜一遍 `moduleId` 跳转**：`switchModule('<id>')` / `openModule('<id>'…)` / `ImportNextStep.moduleId` —— 跳到一个不存在的 id 不会报错，`activeComp` 的 `?? TABS[0]` 会静默落到第一个页签；
4. 处置它独占的冒烟：**先把"入口还在但宿主变了"的断言搬到新入口，再退役脚本**（顺序反了就会丢断言，而丢掉的正是最难查的那类静默失败）；
5. 文档三件套：`CHANGELOG` 的 `[Unreleased]`、本条笔记 + `docs/notes/README.md` 索引、`docs/baseline/PROJECT_BASELINE.md` 里那条冒烟行改成**退役记录**（别直接删行 —— 历史要能查）。

**取证**：见五步中的符号与文件路径。

**源**：`2026-10-17-picking-menu-removed`（2026-10-17）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-05-picking-export-with-images.md` | 2026-10-05 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 |
| `2026-10-10-picking-merged-into-purchase.md` | 2026-10-10 | §11 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 / §20 |
| `2026-10-10-picking-scope-and-empty-state.md` | 2026-10-10 | §20 / §21 / §22 / §23 / §24 / §25 / §26 / §27 / §28 / §29 |
| `2026-10-17-picking-menu-removed.md` | 2026-10-17 | §30 / §31 / §32 |

（标题号与文内交叉引用沿用原编号语义：§11–§14 即原并入记录的第 1–4 条，§15–§16 即原第 5–6 条。）

---

**关联索引（原笔记自带，未并入正文）**

- 计划与执行记录：`docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §6 S3 执行记录；变更史 `CHANGELOG.md` `[Unreleased]` 的 S3 条。
- 同族笔记：`2026-10-01-ui-style-system-audit.md`（无头截图器怎么来）、`2026-10-03-hint-is-not-an-entry.md`（「全零不是正确表达」）、`2026-10-05-daily-flow-card.md`（注入脚本注释不能含反引号）。
