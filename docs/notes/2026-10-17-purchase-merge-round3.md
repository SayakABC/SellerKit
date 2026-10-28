# 2026-10-17 拿货页第三轮：撤「按订单」页签 · 三区并一种卡 · 行与发厂清单瘦身 · 卡底吸底

用户四条口径（原话见 CHANGELOG 同日条目）：页签该不该留 / 三区不协调 / 卡片信息局促（款编码不上卡）/ 卡底动作固定。

## 结论（下次开工还得记得的）

1. **「按订单」视图是纯重复，撤掉是对的**：每张拿货单在厂家卡"已开单"行上本就有同一套
   `data-act="pu-*-${单号}"` 四动作。宫格视图唯一独有的是「新建空白单」⇒ 收进概览条右侧。
   以后不要再往"单子列表"方向加东西 —— 单子管理只有一个入口：厂家卡。
2. **三态只靠排序 + 瘦卡表达**：`PickingView` 的 `orderedCards` 按 `ZONE_RANK`（pending 0 / skip 1 / done 2）
   稳定排序进**一个** `pu-grid`；分区信息只在 `data-zone` 属性上（冒烟按它断言顺序）。
   没有分区标题 —— 想恢复"区"就得同时恢复三种视觉语言，别走回头路。
3. **款编码的"对外/对内"分工**：`data-key`（= `款编码 · 颜色`）只是内部身份（拖拽定位 / 冒烟锚点）；
   界面显示走 `rowName()`（款名 → 颜色 → 未识别款），发厂内容走 `pickingSheet` 的 `SheetLine.label`
   （同样不含款编码）。**清单图 / 文字清单 / 卡上行**三处永远不该再出现款编码；
   导出带图 xlsx 是内部作业表，款编码照旧保留（别"顺手统一"把它也删了）。
4. **卡底吸底 = `.pu-scard__bottom { margin-top: auto }`**：待拿卡把"已开单 + 三个动作"包在这一块里。
   冒烟有几何守卫（底块下缘与卡下缘差 ≤ 12px —— **卡盒模型的地板**：padding-bottom 10 + border 1 = 11px，
   量的是 border-box；原 ≤2px 是拿卡下缘当内容盒下缘用，恒红）。改行结构时别把 bottom 块拆回卡身流式排。
5. **已拿卡不折叠了**：单子行直接排在瘦卡上（含提交/导出/删除）。"折叠省视场"的旧方案
   靠 toggle 双向断言守着，那些断言已随视图删掉，别照旧清单跑。

## 守卫落点（改行为前先读）

- `scripts/today-ui-smoke.mjs` step('purchase')：`data-zone` 序钉死、行上反向守卫
  （无 S1/无 `.pu-srow__amount`/无「无进价」）、文字清单全文无款编码、吸底几何、
  新单四动作同卡、`!card('pu-sub')`。
- `tests/pickingSheet.spec.ts`：`label` 反款编码 + 文字清单「款名 · 颜色：尺码×件数」格式。
- `tests/uxEntryNames.spec.ts`：「按订单」豁免已撤 —— 文案再写它直接红。

## 顺手缝掉的缝

- 上一轮拖拽通道 `product-move-supplier` 漏契约②：`productMoveSupplier` 补进 `types.ts`
  （`ElectronAPI` + `ProductMoveSupplierInput`）。教训重申：契约四处（handlers/preload/types/ipc.ts），
  verify 只拦②、vue-tsc 只拦③，漏 ② 只有 verify 能抓。
- 概览条的厂家下拉选完会还原成 0（冒烟新加还原步）：`createFromPick` 断言按夹具起点走，
  残留选中态会让"默认不预选"守卫后续轮次假绿。

## 假桥返回活引用 = 响应式静默失效（本轮最贵的一课）

现象：忽略 S2·白 后行能进「暂不拿」区、忽略清单里也有它，灰条上的**原因**却永远不出现。
三处证据互相矛盾：宿主 `ignores` 是新的（页级清单 2 条）、PickingView 的 prop 是旧的
（`ignoreReasons` 只有 S9）、而 PickingView **自己取的那份**忽略清单又是新的（所以行会移走）。

根因：假桥 `purchaseIgnoreList` 把 `window.__ignores` **本尊**当 data 返回（真 IPC 结构化克隆，
每次新数组）。于是：首次 load 后宿主 `ignores.value` 与 `window.__ignores` 是**同一个数组对象**；
冒烟忽略时假桥对它裸 push（不触发响应式）；bump 重取后 `ignores.value = 同一引用`，被 Vue 的
`hasChanged` 判成"没变"——赋值成为空操作，`ignoreReasonMap` 计算属性永不重算。
「页面其他 ref 变了 ⇒ 组件重渲染 ⇒ 模板里 `JSON.stringify(ignores)` 恰好把活数组的新内容打出来」
让 hostIg 证据看起来"宿主是新的"，计算属性却还拿着旧缓存——这就是矛盾的来源。

修法与守卫：假桥一律 `data: window.__x.slice()`（复刻 IPC 克隆语义）；已在
`purchaseIgnoreList` 处写明。判据侧不用改——「灰条带原因」这条断言本身就是抓这个的。
排查成本高（三层证据互相打架）⇒ 下次假桥加新通道，返回数组先问一句"克隆了吗"。
