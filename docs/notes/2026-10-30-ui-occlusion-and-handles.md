# 遮挡、指针手柄与总览四数：19 条结论（蒸馏自 2 篇，2026-10-22 ~ 2026-10-24）

> **蒸馏笔记**：由 2 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 看上去最像原因的两个，都不是

**结论**：用户一句「现在这个页面根本没办法操作」——没有报错、没有白屏、冒烟全绿。这类"看着好好的但用不了"只能靠**真机探针**找。两个最像原因的怀疑（被遮挡、被压扁）实测都不成立 ⇒ 问题不在"看不见"，而在**事件根本不进代码**。

**取证**：

| 怀疑 | 实测 | 结论 |
| --- | --- | --- |
| 有元素盖住了控件 | `elementFromPoint` 扫 136 个可见控件的中心点，**0 处被盖** | 否 |
| 矩阵被压成一条缝 | `spec 144 / table 370 / 可见 10 行`，与上一轮一致 | 否 |

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 2. 拖色的手柄被自己排除了

**结论**：`onChipDown` 里写的是 `closest('input,button')` —— 想表达"输入框和按钮优先"。但**色图恰好裹在 `<button class="mx-thumb-btn">` 里**（那个按钮是为了点开看大图）。后果：**凡是有色图的颜色，整条都拖不动**，只剩没采到图的空色块能拖。修法：只排除 `input/textarea/select`（色名要能选中文字）和 `[data-act$="-del"]`（✕ 是独立动作）。点击 vs 拖动仍由 6px 阈值区分。

**取证**：为什么一直没被发现 —— 产品抽屉里的款色**没有色图**（渲染成 `span.wb-thumb--empty`），截图、冒烟、真鼠标探针拖的都是那种空色块 —— 全是绿的。而**向导与采集弹层每行都有图**（向导还回落到商品主图），那里一条都拖不动。用户很可能就站在那儿。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 3. 拖完顺手弹出全屏大图

**结论**：拖动松手后浏览器会补发一次 `click`，落点若在色图上就是 `openViewer` —— 那层 `.wb-mask` 是 `position: fixed` 盖**整个窗口**。用户的观感是"页面被锁住了"。修法：`endDrag` 里记 `swallowClick`，根元素 `@click.capture` 吞掉拖动后的第一次 click（`setTimeout(0)` 摘钩，与格子里 `suppressClick` 同一套时序）。

**取证**：`.wb-mask` 的 `position: fixed` 覆盖整个窗口；`endDrag` 的 `swallowClick` + 根元素 `@click.capture` + `setTimeout(0)` 摘钩。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 4. 滚轮滚过就把克重改了

**结论**：克重框原来是 `type="number"`。40 个格、每个格一个 number 框，占了半张表 —— 用户想往下滚两行，指针停在哪个格上，那个格的克重就被滚轮改了。修法：`type="text"` + `inputmode="numeric"`（归一仍走 `normWeightG`）。顺带省下 12px 的上下箭头宽度。**不要改回 number**。

**取证**：40 个格各一个 number 框；改后 `type="text"` + `inputmode="numeric"`，归一仍走 `normWeightG`，省下 12px 箭头宽度。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 5. 向导的「建档并关联」跟着内容滚

**结论**：`ShopItemWizard` 把 `.wb-dialog__foot` 放在了 `.wb-dialog__body` **里面**。档案 + 矩阵把内容顶到两屏高，动作条（这个抽屉唯一的出口）首屏完全不可见。修法：移到 body 外面，成为抽屉的第三段（`flex-shrink: 0` 常驻底部）。

**取证**：`.wb-dialog__foot` 原嵌套在 `.wb-dialog__body` 内；内容两屏高；修后为抽屉第三段且 `flex-shrink: 0`。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 6. 松手在窗口外 ⇒ 幽灵拖动

**结论**：拖到窗口外松手时 `pointerup` 可能压根不派发（窗口已不聚焦），`chipDrag` 就留着。之后鼠标一进组件、只要移动超过 6px，界面自己进"拖动中"（色块整片变灰虚线），再随便点一下就真做了一次合并 —— 表现为"页面自己乱动"。修法：`window` 的 `blur` 与 `document` 的 `visibilitychange` 主动 `abortDrag()`（丢弃，不判落点）。

**取证**：`pointerup` 在窗口外可能不派发；移动超过 6px 即进入"拖动中"；`blur` / `visibilitychange` 各挂一次 `abortDrag()`。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 7. 这一轮新加的三条守卫（`goods:ui`）

**结论**：三条守卫各自钉一件事：克重框不是 number、每个可见控件的中心点命中自己、从色图上按住能拖。

**取证**：

1. **克重框 `type !== 'number'`** —— 只断言 type。合成 `WheelEvent` 改不动 number 框的值，断言 value 是恒真的假守卫。
2. **命中测试**：SKU 区每个可见控件的中心点必须命中它自己或其后代。必须排除 `el.closest('details:not([open])')` —— Chromium 用 `content-visibility` 折叠 `<details>`，里面的控件**仍有布局尺寸**但不可见、不可点。不排掉就是 5 条假阳性。
3. **从色图上按住能拖**（`is-src=true`）—— 只有向导里守得住，因为只有那里真挂着色图。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 8. 两个"探针自己骗人"的坑

**结论**：

- **合成 `PointerEvent` 派发后同步读 class，永远是旧值**：Vue 的 DOM 更新是异步的。第一版探针没 `await settle` 就断言 `is-src`，报 `false` —— 和"修复没生效"长得一模一样，差点让我去改已经正确的代码。**先怀疑探针的时序，再怀疑产品代码。**
- 上一轮也踩过同类：`td.scrollWidth`、`.mx-cell__on`、`table.scrollWidth` 三条几何断言恒真。判据必须落在**会随 bug 变化**的那个量上。

**取证**：第一版探针未 `await settle` 即断言 `is-src`，输出 `false`，与"修复没生效"无法区分。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 9. 留给下一次的

**结论**：

- 行头色名按钮 = **整行开关**（点一下整行 SKU 全取消）。误触代价大，但目前没有撤销机制；真要动，得先有"改动的 undo"，否则只是把易用性问题换成"批量操作变难用"。
- 常用色仍是固定 10 词，不可自定义。

**取证**：行头色名按钮的整行开关语义；常用色固定 10 词。

**源**：`2026-10-24-pointer-handles-and-occlusion`（2026-10-24）

## 10. 总览 = 一格数，不是三段说明

**结论**（2026-10-22，用户裁定「总览里的功能暂时没什么意义，先去掉，改成展示今天要发多少单 / 多少件 / 已拿多少 / 还差多少」）：流程卡与订单 / 待拣 / 缺口三张卡全撤 —— 页签栏本来就排好了 1-2-3-4 且带「当前步」标记；那些卡只是把同一件事讲第二遍。

**取证**：`flow` / `card-orders` / `card-picking` / `card-gaps` 全部撤除（反向断言见 §18）；「当前步」标记在页签栏（`.td-tab.is-now`）。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 11. 四个数只能有一处实现

**结论**：四个数**只能有一处实现**：`src/lib/dailyShip.ts` 的 `dailyShip()`（纯函数 + 11 例单测）。面板只摆放，容器只喂数据。

**取证**：`src/lib/dailyShip.ts` 的 `dailyShip()`；`tests/dailyShip.spec.ts` 11 例。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 12. 已拿 + 还差 ≡ 件数

**结论**：**已拿 + 还差 ≡ 件数**。这是这一屏唯一能自证的地方 —— 账对不上，四个数就都不被信任。实现方式：逐 SKU `min(需求, 台账)`，不是逐行扣、也不让 `taken` 溢出需求。

**取证**：逐 SKU `min(需求, 台账)`；夹具实测四个数 = 2 单 / 3 件 / 已拿 1 / 还差 2（守卫见 §18）。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 13. 「已拿」的准确度被数据模型封顶

**结论**：「已拿」的准确度被**数据模型封顶**：`purchase_items` **没有 `order_no`**，所以"这一单拿了多少件"根本不存在，只有"这款色码历史上一共拿了多少件"。于是总览的已拿 = 今天的这批 × 款色码累计台账 ⇒ 同款前几天拿过时会被算进今天（最多算到需求为止）。**知情地接受这个近似**，并写在界面上（口径小字），比给一个假装精确的数好。

**取证**：`purchase_items` 表无 `order_no` 列；口径小字随四个数一起渲染。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 14. 订单/明细表里没有"已拿"这一列

**结论**：`oi_order_items` 的 `status` 全是 `pending`（72 行）—— 它是"这行发货没有"，不是"这行拿货没有"。`parcels` / `parcel_lines` 记的是**分包**（`order_item_id` + `qty`），也不是拿货。⇒ "已拿"只有 `purchase_items`（已提交拿货单明细）一个来源，而它按 `style_color_id|style_code + color + size` 聚合，**没有订单号**。

**取证**：

```bash
sqlite3 -readonly "~/Library/Application Support/seller-kit/sellerkit.db" \
  "PRAGMA table_info(oi_order_items);"
# id, order_id, image_id, size, raw_fields, category, color, logo, material,
# status, corrected, qty, style_color_id, weight_g, cost_cents, actual_cost_cents, created_at
```

`electron/purchase-db.ts` 的 `takenLedger()` 就是这条聚合 SQL。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 15. 不能拿「缺口」当「已拿」

**结论**：`outstanding()` 末尾 `missing <= 0` 就丢行 ⇒ 拿齐的款色在缺口里**根本不返回**。拿它算已拿，等于"刚拿完"显示成"一件没拿"（2026-10-17 用户实报过）⇒ 必须读台账 `purchase-taken`（`TakenRow`）。

**取证**：`outstanding()` 末尾 `missing <= 0` 丢行；台账读取口为 `purchase-taken`（`TakenRow`）。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 16. 未识别款的行照收件数、不扣已拿

**结论**：`outstanding()` 对未归类行恒 `have = 0`。总览跟它同口径：空款编码拼出来的键会把"同色同码的不同商品"并成一格，凭空扣出一批已拿 —— 那是"漏货式"的静默错（货没到，界面说到了）。件数照收（漏掉才是悄悄少算货）。

**取证**：`outstanding()` 对未归类行恒 `have = 0`；空款编码键会跨商品并格。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 17. 连带影响：一并还清的技术债

**结论**：`ShippingSummary` 删掉 `picking` 与 `gaps.{weight,cost,rate}` / `gapTotal`：它们唯一的读者是被撤掉的「钱算得准吗」卡。⇒ 每次刷新**少跑 3 次 IPC**（`pickingRows` / 产品库克重+价目 / 运价快照）。留着就是"每次刷新白算一遍没人看的数"。`flow` 留在 `TodayView` 里：页签左侧的「当前步」标记（`.td-tab.is-now`）读它 —— 删了页签就只剩一排没有主次的按钮。

**取证**：删字段后每次刷新少跑 3 次 IPC（`pickingRows` / 产品库克重+价目 / 运价快照）；`flow` 的读者是 `.td-tab.is-now`。

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 18. 守卫：五条断言 + 一处夹具必须跟着改

**结论**：五条断言全部做过变异复核；夹具有一处**必须**跟着改 —— `IMPORTED.styleColor` 由「红」改成「黑」，与台账 `TAKEN` 同色名。不改的话已拿恒为 0（键对不上），断言看着能跑，却把"键对不上"这个真 bug 掩盖成"这件本来就没拿"。

**取证**（`scripts/today-ui-smoke.mjs`）：

| 断言 | 变异（改坏哪里） | 结果 |
| --- | --- | --- |
| 四个数 = 2 单 / 3 件 / 已拿 1 / 还差 2 | 容器不把台账喂给 `dailyShip`（`{taken:{}}`） | ✅ 变红（已拿 0 / 还差 3） |
| 进度条 = 已拿/件数（1/3 ≈ 33%） | 同上 | ✅ 变红（fill 0%） |
| 反向：`flow` / `card-orders` / `card-picking` / `card-gaps` 都不许回来 | 把任一卡加回去 | 红 |
| 空态不摆一排 0、也不挂口径小字 | 去掉 `v-if="daily.orders"` | 红 |
| 刷新后四格数字回来 | 空态把面板替换成回不来的 DOM | 红（等待超时） |

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

## 19. 复现

**结论**：这一屏的复现只需两条命令。

**取证**：

```bash
npx vitest run tests/dailyShip.spec.ts     # 11 例
npm run today:ui                            # 全绿
```

**源**：`2026-10-22-overview-four-numbers`（2026-10-22）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-24-pointer-handles-and-occlusion.md` | 2026-10-24 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 |
| `2026-10-22-overview-four-numbers.md` | 2026-10-22 | §10 / §11 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 |
