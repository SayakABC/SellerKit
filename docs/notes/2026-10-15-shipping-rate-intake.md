# 「无忧物流运费」UI 岛回收为内建「基础数据 › 物流运费」：真正的工作是把 6 个 op 抽成单源服务

> 日期：2026-10-15 · 旧计划（岛时代，留档）：`docs/plans/SHIPPING_RATE_ISLAND_PLAN.md`
> 岛：`ui-plugins/shipping-rate`（手写 ESM 岛，`dist/` 即源码、无构建步骤，14 文件，1.3.1）→ 内建 `src/modules/shop-accounts/`
> 前作：`docs/notes/2026-10-14-shop-accounts-intake.md`（同一回收模式的第一例）

## 1. 发生了什么

用户要求把运费岛也并进「基础数据」。与 shop-accounts 同模式，但**这次的痛点不在桥桩，而在"两份实现"**：

- **实现抽单源**：岛时代 6 个 op（`parseRateSheet` / `rateCurrent` / `rateAdopt` / `quote` / `quoteOrders` / `quoteProducts`）住在 `src/core/plugin/host.ts` 的 `DB_OPS['shipping-rate']` 里，供 iframe 岛经 `window.__sk` 调。内建页面要**直接**调同一份逻辑，若在页面里另写一遍，档位/取整/类别优先级任何一处漂移都会让同一份报价单算出两个数（**静默错价**，本仓反复强调的红线）。故抽 `src/core/services/shipRateOps.ts` 作为唯一实现，`host.ts` 该域改为**薄委托**（只服务市场里已装旧岛的用户）。
- **页面落地**：`shipRateFormat.ts`（展示格式化）+ `shipRateStore.ts`（Pinia store）+ 5 个组件（`ShippingRatePane` 四页签 shell + `ShipRateQuote/Rates/Orders/ProductsTab`）。`MasterDataView.vue` 的资料种类由 6 项增至 **7 项**，新增「物流运费」；`icons.ts` 补 `ship` 图标路径。
- **冒烟重写**：`scripts/shipping-rate-ui-smoke.mjs` 从"岛 dist 站点"整体改为"宿主 build 产物站点"（骨架与两遍视口沿用）。
- **岛下架**：`git rm -r ui-plugins/shipping-rate`（14 文件全在 git 跟踪下，可从历史恢复）；`.gitignore` 里那条岛专用的反忽略行 `!ui-plugins/shipping-rate/dist/` 同步删除（留着会让 `tests/pluginTriage.spec.ts` 的「dist/ 未被忽略」守卫读到一条指向已删目录的规则）。

## 2. 关键结论（下次还会用到的）

- **存储命名空间刻意沿用 `shipping-rate`**：`useModuleStorage('shipping-rate')`（不是改成 `shop-accounts`）。空间键未变 ⇒ 升级后旧岛存下的查询偏好（克重 / 类别 / 变体 / 进位方式 + `lastFile` / `sheetNames` / `candidates`）**无缝接续**，不必迁移也不必清空。回收时最容易顺手"改成更整齐的名字"，那会让所有老用户丢偏好。
- **`ui-plugins/` 的规模表看不出岛被删了**：baseline 口径 `find … -name dist -prune` 把手写岛的源码整体排除，而手写岛的源码**就在 `dist/`**。故下架 shipping-rate 后该行数值（8 文件 / 509 行）**不变**——不是没删，是从不上它。已在 baseline 就地标注，别让下一个读者误判成"下架没生效"。
- **旧守卫的断言对象随架构改变**：`tests/pluginTriage.spec.ts` 原先断言 `hostDomainBlock('shipping-rate')` 含 `importSheet.importRateSheet`。抽服务后调用链多了一层（host → shipRateOps → importSheet），该断言**必然变红**。不是删了事，而是改成**顺着三层链逐层查**（每层不许自己解析、全链不许回落取第一张 sheet）。删掉断言会让"两份实现"这道防线凭空消失。
- **`pluginManifest.spec.ts` 的三元组不够用了**：原 ISLANDS 是 `[岛id, manifest, 一个db动作]`，断言里拿 `domain: id` 顶替真实域名。换锚到 `ae-profit` 后立刻暴露——**它的 db 域是 `ae` 不是 `ae-profit`，且它根本没声明 storage**。改为五元组显式携带真实域名与命名空间（`null` = 未声明，该组用例跳过），不再靠"id==域"的巧合。
- **夹具 sheet 数别写死**：冒烟里原断言 `sheetNames.length === 8`，实跑打点才发现 `tests/fixtures/shipping-rate.xlsx` 是 **9 张**（多一张「无忧物流-海运大件专线」）。改为按**真实 sheet 名称集合**断言（每张都在 + 数量相等），换夹具时不会静默错位。

## 3. 守卫（改锚点）

- `tests/pluginManifest.spec.ts`：岛清单 −shipping-rate，改钉 `excel-copy` + `ae-profit`；顺带修掉"拿岛 id 兼作域名/命名空间"的隐含假设（见 §2）。
- `tests/pluginTriage.spec.ts`：删除依赖岛源码的 6 条断言（op 被岛调用 / 禁 eval / 不引 xlsx / 不自算费率 / bridge 命名空间 / 导入走 prefer），改为 6 条**三层链**断言。**变异复核**：① 让 host.ts 混入 `xlsx`（自解析）→ 1 条红；② 让 shipRateOps 不调 importSheet（自己解析）→ 2 条红；还原后全绿。
- `tests/uiIslandThemeTokens.spec.ts` / `pluginTriage` 的 `noBuild` 守卫：手写岛只剩 `excel-copy`，注释同步。
- `scripts/check-doc-links.mjs`：`ui-plugins/shipping-rate/**` 的 7 个 token 进 `DELIBERATELY_MISSING`（历史陈述，改指现存文件则句子不成立）。⚠️ `docs/README.md` 里那条**活导航**不豁免、已改指本笔记 —— 它现在还指引人去看岛 README，是真会被人点开的。

## 4. 门禁结果（2026-10-15 实跑）

`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅ · `verify:docs` ✅（本笔记登记后）· `vitest run` ✅ · `build` ✅ · `shipping-rate:ui` ✅（31 项 × 宽/窄两遍）。

冒烟里三条真值钉的是**独立算出来的**数，不是照抄实现：100g 最便宜哈萨克斯坦 `8.50`（45×0.1+4）、次便宜马来西亚 `9.80`；**改 350g 后首行换人**（KZ 只有 ≤150g 档，装不下 350g → 马来西亚 150g–500g 档 `16.05`）。这条尤其重要：写死"350g 还是 KZ 8.50"会恒红，而只写"最便宜那行"则两者都绿、等于没验。

## 5. 遗留

- ~~**市场仓下架**待用户确认~~ —— **已于同日处置**，见 §6。
- ~~宿主薄委托故意保留~~ —— **已于同日删除**，见 §6。

## 6. 二次收口（2026-10-15 同日，用户明确答复后）

用户原话：**「老用户市场里的旧岛不需要能用，都删除掉，这个项目还没上线」**。

§1 保留薄委托的前提是"老用户市场里已装旧岛"——这个前提不成立（岛从未推送上线，zip 只在本机
`market-out/` 打包过）。于是把整条通路拿掉：

| 层 | 处置 |
|---|---|
| `host.ts` `DB_OPS['shipping-rate']` | **整域删除**（5 op）+ 删随之未用的 `shipRateOps` import |
| 市场 `catalog.json` | 去掉 `shipping-rate` 与 `shop-accounts` 两条（后者 10-14 已回收，同样该撤） |
| 市场 `*.zip` | `shipping-rate-*.zip` 8 个 + `shop-accounts-*.zip` 全部删除（**先 `cp -cR` 备份到 `/tmp/market-out.bak.*`**） |
| `OrderCostView.vue` | 删读旧岛 storage 键 `table` 的回落分支 |
| `tests/pluginTriage.spec.ts` | §3 的三层链断言**改为反向守卫**（见下） |

**三处刻意没删**（都是"删了会拆掉有价值的东西"）：

1. **`rateAdopt`** —— 它不是岛通路，是**用户数据迁移**（把早期留在 storage 里的运价表一次性交给
   宿主快照）。删了 ⇒ 早期用户的表永远迁不上来。
2. **`computeOrderCosts` 的 `rateTable` 入参与其单表回退分支** —— 分支本身合法，
   `tests/orderCost.spec.ts` 有 20+ 处传入、还专门钉着"快照优先于单表"。只把生产调用点改成恒传 `null`。
3. **storage 命名空间 `shipping-rate`** —— 现在只存**查询偏好**（克重/类别/变体/取整），仍在读写，
   与岛无关。

### 守卫：从"查链条"改成"钉不存在"

原三层链断言（`① op 委托服务 → ② 服务调 importSheet → ③ 不得回落取第一张 sheet`）在域删除后
前两条失去断言对象。**不删、改造**为：

- `host.ts` 不得再有 `shipping-rate` 域；
- 市场 catalog 不得再有 `shipping-rate` / `shop-accounts`；
- 保留 `importSheet` 单源与"不回落取第一张 sheet"两条（它们的对象还在）。

**为什么必须留**：这个域一旦被加回来，症状**不是报错**，是同一份报价单算出两个数（静默错价）；
而且它长得"很合理"（薄委托 + 一段注释解释"为什么为老用户保留"），review 时极易放过。
反向守卫比"查解析只有一份实现"更靠上游 —— 后者挡不住有人新写一整个平行实现。

**变异复核**：把域加回 `DB_OPS` ⇒ 目标守卫红；catalog 加回条目 ⇒ 红。（首次变异时插入点算错、
域被插到了 `DB_OPS` 外面，守卫因 `hostDomainBlock` 返回空而**假绿**——插入点必须落在对象内。）

### 顺带修的真 bug：「运费查询」页表格区一片空白

用户同时报"运费查询页面当前的样式不对"。**冒烟 31 项全绿、DOM 里 184 国表格完好，页面却只剩空白**。
根因见 §7。
## 7. 「运费查询」页空白：DOM 完好 ≠ 用户看得见

### 症状

冒烟全绿（31 项，184 国表格、费用构成、金额全对），`--dump-dom` 里表格**完整存在**，
但截图上工具条之下**一整块空白**，什么也没有。用户描述为"样式不对"。

### 诊断（关键：不猜，去量）

新建 `scripts/shipping-rate-ui-shot.mjs`（一次性取证工具，不是门禁）：截图 + 把关键节点的
`getBoundingClientRect()` 与可见性样式写进 `#probe`，`--dump-dom` 后读出来。量到的事实串成一条因果链：

```
.srq            内容高 8036px   ← 根容器只有 display:flex，没有高度约束
.srp__body         高  773px   ← 真正可用的高度
.srq__results      高 7966px   ← 被内容撑高（.wb-panel 是 flex column）
  .wb-panel__body  高 3982px   ← 两个各平分（flex:1 1 0%）
  .wb-panel__body  高 3982px   ← 其中表格那份
  srq__summary     高 3982px   ← ⭐ 只有一行标签的行
table-wrap        y = 4153px   ← 视口只有 913px ⇒ 完全在屏幕外
docScrollH = 913              ← 祖先 overflow:hidden ⇒ 文档也不滚
```

### 根因一句话

**`flex: 1` 只在祖先给出确定高度时才是"伸缩"，否则是"平分内容"。**

宿主 `.wb-panel__body { flex: 1 }`（`src/styles/index.css`）本身没错，前提是祖先链给到确定高度；
四个页签的根容器都漏了 `flex:1 + min-height:0` ⇒ 面板被内容撑到 8000px ⇒ 内部 body 平分 ⇒
summary（row 布局 + `align-items:center`）那行"共 184 国"的标签被垂直居中到 y≈2162，
而视口 913 ⇒ **整个可见区全是那 3982px 的空白**。

### 修法（契约抄 `CostPane.vue` 的 `.ct`）

```css
.<page> { flex: 1; min-height: 0; }      /* 根：接受祖先给的确定高度 */
.<fixed> { flex-shrink: 0; }             /* 工具条/信息卡：不参与伸缩 */
.<results> { flex: 1; min-height: 0; }   /* 唯一可伸缩的面板 */
.<summary> { flex: 0 0 auto; }           /* ⭐ 收回：它只有一行高 */
.<table-body> { flex: 1 1 auto; min-height: 0; overflow: hidden; }  /* 表格容器自己滚 */
```

修后：`srq` 798px · `results` 728px · `summary` **18px** · 表格容器 `clientH=708 / scrollH=7946`（内部滚动）。

### 为什么冒烟没抓到（这才是重点）

原 `isShown(el)` = `getClientRects().length > 0 && display !== 'none'` ——
**元素在视口外 4.5 倍高的地方照样判"可见"**。这类"DOM 在、用户看不见"的故障，
文本类断言（`has('哈萨克斯坦')` / 行数 / 金额）**一条都不会红**。

补的 4 条几何断言：

| 断言 | 钉的是什么 |
|---|---|
| `heightOf(summary) < 120` | 一行标签不该被 flex 撑成几千 px（断裂的第一症状） |
| `inViewport(firstRow)` | 首行必须落在视口内（`r.bottom > 0 && r.top < innerHeight`） |
| `heightOf(results) <= innerHeight` | 面板不该比视口高（表格要滚，不要撑高整页） |
| `wrap.scrollHeight > wrap.clientHeight` | 表格容器真的可滚（不是被裁掉） |

**变异复核**：退回修复前的样式 ⇒ 4 条全红，且 detail 精确复现原始数字
（`h=3982px` / `top=4188 bottom=4231` / `h=7966` / `scrollH=7946 clientH=7946`）；还原后全绿（36 项）。

### 工具本身的两条纪律

- **假桥从冒烟脚本里切出来**（按标记定位模板串），不复制粘贴 ⇒ 截出来的就是冒烟在跑的那条链，
  不会出现"截图脚本另造一份桩、看到的东西不是生产形状"。
- **注入脚本的注释里不能有反引号**（模板串提前闭合）。本次又踩了一次：
  变异跑出来是 `SyntaxError: Unexpected identifier 'flex'`，而 `node --check` 对这类脚本不充分。

### 通用结论

- ⭐⭐ **"DOM 断言全绿"不等于"页面能用"**。凡是渲染大面积内容的面板，都要有一条
  "关键元素在视口内 + 容器可滚"的几何断言；这类判据只能在真浏览器里跑。
- ⭐⭐ **`flex:1` 的前提是祖先的确定高度**。漏了 `min-height:0` / `flex-shrink:0` 时，
  它不是"没生效"，而是**把内容平分**——平分到几千像素时，一行标签被居中到屏幕外，
  症状是"整页空白"，与"渲染失败"看起来一模一样。
- ⭐ **一个页面有多个同类区块时，按同一病因一次全修**（本次四个页签同病，只修了用户点到的那个
  就会在其余三个上复现）。
