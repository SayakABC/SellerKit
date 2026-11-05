# 「货与成本」工作台重构方案（左产品 / 右商品池）

> **状态**：🟢 **S0–S5 已完成**（2026-10-08），S5 收工（门禁全量 + 文档计数同步）。
> **读者**：架构 / 开发者 / 产品
> **前身**：`archive/plans/PRODUCT_SKU_LINKING_PLAN.md`（已裁定「加法路线」）；本文走「整页左右分栏重构」那一条。
> **落点**：界面 = `src/modules/goods/**`；数据层 = `electron/product-db.ts` / `electron/product-handlers.ts`（**仅加一个查询参数**）
> **前置阅读**：`features/PRODUCT_LIBRARY.md` · `decisions/ADR-002-master-data-layer.md` · `notes/2026-10-05-repo-hard-constraints.md` · `notes/2026-10-30-goods-ux-refactor.md`

---

## 0. 一句话结论

把「产品」与「映射与关联」两个页签**合并成一个左右分栏的工作台**：左栏是**自己的款**（含行展开：SKU + 已关联商品），右栏是**店铺商品池**（待关联队列 / 已建立映射）。

**这是重写，不是加功能** —— 两个成熟表格页会被改成两栏中的窄列。三条纪律：

1. **数据层几乎不动**（只给 `productId` 加一个反向过滤参数，复用 `idx_pl_shop_sku_product`）；
2. **三条硬约束一条都不丢**（款编码仍是必填锚点 / 队列仍是实时聚合非缓存 / 仍不做硬删）；
3. **既有 72 条界面断言语义一条都不放松** —— DOM 会变，但 `data-act` 名保持稳定（§8 迁移表），逐条重挂而非删。

---

## 1. 已拍板的三项（本轮决策）

| # | 问题 | 决策 | 对本方案的影响 |
| --- | --- | --- | --- |
| 1 | 走加法路线，还是整页左右分栏重构？ | **重构** | 合并「产品」+「映射与关联」为两栏工作台；供应商页签保留独立 |
| 2 | P1 只做「弹层显示主图」，还是连对比模式一起做？ | **连对比模式一起做** | 对比模式作为一等公民进 S3 |
| 3 | 「已关联商品」落在编辑抽屉，还是产品列表行展开？ | **产品列表行展开** | 行展开 = SKU 子表 + 已关联商品（只读）；是 `productId` 反向过滤的消费方 |

---

## 2. 目标形态

### 2.1 页面结构

左栏 `pane-products`（~40%）= 产品紧凑列表 + 行展开（SKU / 已关联商品 / 供应商·类目·备注 / 编辑·删除）；右栏 `pane-pool`（~60%）= 分段控件（**待关联队列** / **已建立映射**）的商品池。`tab` 由 3 个变 2 个（**建档与关联** / **供应商**）。指标条与起点引导条已于 2026-10-08 撤除（见 §11）。

### 2.2 两种关联动线（分栏带来的新能力）

| 动线 | 触发 | 说明 |
| --- | --- | --- |
| **A. 弹层选产品**（现有） | 右栏行「关联…」 | 打开 `ProductPicker`（**加上产品主图**）；批量 = 勾选多行 → 「批量关联选中 N 项」 |
| **B. 直连**（新增，分栏独有） | 左栏点选一款 → 右栏勾选行 → 「关联到 `<款编码>`」 | 只替用户把 `productId` 填好，仍走 `product-sku-map`（单事务） |
| **C. 对比模式**（新增） | 右栏行「对比」 | 全屏弹层：左 = 候选产品大图（`←/→` 切换），右 = 该商品大图；`空格` 确认关联、`Esc` 关闭 |

> ⚠️ 动线 B 不新增写路径 —— 只替用户填 `productId`，仍走 `product-sku-map`。

---

## 3. 三条硬约束在重构中如何保住（+ 第 4、5 条）

| # | 约束 | 重构中的处理 |
| --- | --- | --- |
| 1 | **款编码是跨域锚点**：必填、编辑态只读、批量不可改 | 行展开不放编码编辑；编辑仍走抽屉、`readonly` 保留；新形态「新建产品」入口必须带编码 |
| 2 | **队列是实时聚合、不是缓存表** | 右栏两个**互斥视图**（队列 / 已映射）原样保留；不合并、不给已关联行置灰留池里（否则池子无限增长） |
| 3 | **不做硬删，用「标失效」** | 右栏映射操作仍是 改绑 / 标失效 / 恢复；左栏行展开「已关联商品」**只读**，不提供「解除」 |
| 4 | **`itemImagePool` 三层回落口径**（覆盖图 → 订单识别图 → 款主图） | 右栏取图仍走同一份；⚠️ 队列行必须用 **`itemKey`**、映射行用 `itemId` |
| 5 | **表格全宽取舍被放弃** | 用**列裁剪 + 行展开**补偿（§7）；设**窗口宽度下限**（§9-1） |

---

## 4. 数据层改动（最小面）

**只加一个查询参数**，不新增表、不新增 IPC 通道：

| 层 | 文件 | 改动 |
| --- | --- | --- |
| DB | `electron/product-db.ts` | `SkuMapQuery` 加 `productId?: number`（`:641-647`）；`listSkuMappings` 的 WHERE 加 `AND m.product_id = @productId`（`productId > 0` 时）；复用 `idx_pl_shop_sku_product`（`:717`） |
| 主进程 | `electron/product-handlers.ts` | `product-sku-list`（`:225-234`）透传 `productId: toId(payload?.productId)` |
| preload | `electron/preload.ts` | `product-sku-list` 入参加 `productId?`（`:934`） |
| 渲染层类型 | `src/core/services/ipc.ts` | 声明加 `productId?: number` |
| 渲染层 API | `src/modules/goods/api.ts` | `skuList` 入参加 `productId?: number`（`:105`） |

> ✅ **通道名不变** ⇒ `npm run verify`（IPC 契约）不受影响；也不新增 preload 分支。
> ⚠️ **口径要点**：反向过滤**必须带 `status` 语义** —— 「已关联商品」默认只列 `confirmed`，`invalid` 单列或过滤掉，不把失效映射混进来当"已关联"。

---

## 5. 分阶段计划（S0 → S5）

每阶段独立可跑、独立可回退；**每阶段结束都跑一遍全量门禁**。

- **S0 — 骨架与开关** ✅（2026-10-08）：新增 `GoodsWorkbenchView.vue`（两栏外壳：`data-act="goods-workbench"` / `pane-products` / `pane-pool`），`GoodsView.vue` 用 `GOODS_LAYOUT: 'workbench' | 'tabs'` 选渲染哪套（**回退 = 改一个常量**）。两栏先各挂现有组件。守卫：`goods:ui` 加「两栏同时存在」断言。**两处回改（实测）**：① 右栏**懒挂载**（外壳 `pool` 属性为真才挂），否则 `SkuMappingView` 挂载即扫队列导致 `mappedQueue === null` 三态永不出现；② **页签仍 3 个**（合并留 S4）。⛔ 2026-10-08 续三后三态契约与引导条连 `flow.ts` 撤除，懒挂载**理由变**为"不付没人看的全量聚合"，仍保留。变异复核 3 条。
- **S1 — 左栏产品（含行展开）** ✅（2026-10-08）：新增 `ProductPane.vue`：紧凑列表（☑/图/款编码/款式名/`n·缺 m`/状态）+ **行展开**（`detail-skus` 内联改克重 / `detail-links` 已关联只读 / 供应商·类目·备注 / 编辑·删除）。数据层落 §4 的 `productId` 过滤。**不新增表、不新增通道**。**回改（实测）**：① 列表逻辑抽成 `useProductList.ts` 两形态共用（避免抄 400 行 + 回退路径漂移）；② `detail-links` **一次拉全（含失效）再按状态分渲染**，只花一次 IPC。变异复核 5 条。守卫：`product:sku:smoke` 43→45、`ipc:shape:smoke` 22→26、`goods:ui` 76→85。
- **S2 — 右栏商品池** ✅（2026-10-08）：新增 `PoolPane.vue`：把 `SkuMappingView` 两个互斥视图迁进来（分段控件与 `data-act` 名原样保留），列裁剪见 §7-2（队列 9→7、已映射 9→6）。取图逻辑整段照搬。**回改**：池逻辑抽成 `useSkuPool.ts` 两形态共用（同 S1 理由）。顺手接页级刷新进右栏、删零消费者的 `changed` emit。变异复核 3 条。`goods:ui` 77→80（既有 77 条全重挂通过，因列裁剪未动 `data-act` 名）。
- **S3 — 关联动线（直连 + 对比模式）** ✅（2026-10-08）：`ProductPicker` 每行加产品缩略图；左栏选款 → 右栏出现 `relate-to-selected`（含款编码）；新增 `CompareModal.vue`（左=候选产品独立取图、右=商品图，键盘 `←/→/空格/Esc`），**零新 IPC**。守卫 `goods:ui` 80→105。**回改/追加**：① `commitMap`/`queueWriteRows` 抽出，三处写映射收敛成一条路径（避免失败语义第二套）；② 「当前款」用 `ProductPane.expandedId`（用户真展开过的行）而非 `useProductList.selectedId`（它会替用户预选第一款）；③ 夹具加 `__smokeReset`。变异复核 5 条。
- **S4 — 收口** ✅（2026-10-08）：页签 3→2（「建档与关联」/「供应商」）；旧组件 `ProductListView.vue`/`SkuMappingView.vue` **保留在仓库**（回退路径）但不渲染。**回改/追加**：① `TABS` 按 `GOODS_LAYOUT` 分叉（否则回退形态会退到渲染不出产品列表的页面）；② 删 `pool` 懒挂载开关（合并页签后池栏恒可见，恒真参数即死参数）；③ 补 §9-1 窄视口守卫（`goods:ui` runner 两遍：宽 1440 / 窄 1000，判据 `grid-template-columns` 轨道个数）。⛔ 指标条/引导条/页签徽标已于 §11 续三整体撤除。变异复核 4 条。
- **S5 — 收工**：门禁全量（§10）+ 每条新断言变异复核（§8-3）+ `CHANGELOG` / 笔记 / `README` 索引 / `PROJECT_BASELINE` 计数同步。

---

## 6. 与提案的差异（照做 vs 不照做）

| 提案条目 | 本方案 | 理由 |
| --- | --- | --- |
| 单界面左右分栏 | ✅ 照做 | 用户拍板 |
| 左 = 产品列表并展开 | ✅ 照做 | 决策 3 |
| 右 = 待关联商品池 | ✅ 照做，但**保留"已建立映射"半边** | 队列非缓存（§3-2）；已关联不能留池里 |
| 对比模式 | ✅ 照做 | 用户拍板 |
| 关联方式②「选中产品→点商品直连」 | ✅ 照做（批量直连按钮） | 分栏才成立 |
| **卡片网格**替换表格 | 🚫 不照做 | 装不下 缺克重/供应商/类目/状态，难排序/分页/批量/导入导出 |
| **拖拽**关联 | 🚫 不照做 | 宽表+分页之上拖拽成本高、可访问性差 |
| **合成状态图标** | 🚫 不照做 | 把"缺SKU/缺关联"压成一个颜色，看不出缺哪；保留两个正交可点指标 |
| 新建产品弹窗（无编码） | ⛔ 不照做 | 漏了跨域锚点（§3-1）；「新建」仍走抽屉 |
| **× 硬解除关联** | ⛔ 不照做 | 与"不做硬删"冲突；用「标失效」 |
| 悬停放大（跟随鼠标） | 🔸 暂不做 | 「点开看原图」已满足；对比模式已隐含"能看清" |

---

## 7. 列裁剪对照（表格全宽 → 栏内窄列）

### 7-1 左栏产品（10 列 → 6 列 + 行展开）

| 原列 | 去向 |
| --- | --- |
| ☑ 勾选框 | **保留**（批量编辑/删除） |
| 图 | 保留 |
| 款编码 | 保留（mono） |
| 款式名 | 保留（flex + ellipsis） |
| 供应商 / 类目 | 🔽 移入**行展开** |
| SKU 数 / 缺克重 | 🔽 并入「`n` · 缺 `m`」一格（`m>0` 标警示色） |
| 状态 | 保留（窄标签） |
| 操作 | 🔽 移入**行展开** |

**行展开新增**：`detail-skus`（SKU 表）+ `detail-links`（已关联商品，只读）。

### 7-2 右栏商品池（9 列 → 7 列）

| 原列 | 去向 |
| --- | --- |
| ☑ 勾选框 | 保留 |
| 店铺 | 保留 |
| 平台 | 🔽 折成店铺格内小标签 |
| 图 / 商品ID / 商品标题 / 订单行 | 保留 |
| 状态 | 🔽 **折进行态**（未归一行整行浅底 + 操作列禁用并说明原因） |
| 操作 | 保留（`关联…` / `对比`） |

**已建立映射视图**（9→6）：图 / 商品ID / 店铺 / 关联产品 / 状态 / 操作（平台折入店铺、来源与更新时间移入 `title`）。

---

## 8. 守卫策略

### 8-1 选择器稳定契约（**尽量不改名**）

`goods:ui` 的 72 条断言钉在 `data-act` 上。重构时**保留下列名称**，只新增、不改名：

- **保留（原样）**：`stats` · `metric-*` · `guide` · `guide-step-*` · `guide-next` · `guide-go` · `active-filters` · `chip-*` · `clear-filters` · `selection-bar` · `product-table` · `p-*`(code/name/supplier/category/sku/status) · `missing-weight-cell` · `sub-queue` · `sub-mapped` · `queue-table` · `mapped-table` · `row-relate` · `row-rebind` · `row-invalidate` · `row-restore` · `map-stats` · `map-failures` · `map-refresh` · `queue-batch` · `q-thumb` · `thumb-set` · `thumb-clear` · `img-viewer` · `viewer-close`
- **新增**：`goods-workbench` · `pane-products` · `pane-pool` · `row-expand` · `row-detail` · `detail-skus` · `detail-links` · `detail-link` · `detail-links-invalid` · `relate-to-selected` · `row-compare` · `compare-modal` · `compare-prev/next/confirm/close` · `compare-side-left/right` · `compare-product-img` · `compare-product-empty` · `compare-item-img` · `compare-item-empty` · `pick-thumb` · `pick-thumb-empty`

**必须迁移的（改名，逐条登记，S4 均已落地）**：`tab-products`/`tab-mappings` → `tab-workbench`（两个页签合并；旧名消失由反向守卫钉住）。⛔ ~~`metric-mapped` 点击目标~~ 指标条已撤除，不再适用。

### 8-2 新增/重挂断言（要点）

| 改动 | 脚本 | 断言要点 |
| --- | --- | --- |
| S0 两栏 | `goods:ui` | `pane-products` 与 `pane-pool` **同时在** DOM |
| S1 行展开 | `goods:ui` | 点 `row-expand` → `row-detail` 出现；`detail-skus` 有 SKU 行；改克重后出参**带该行全部现有字段**（防"只传 weightG 清空颜色/尺码"） |
| S1 已关联只读 | `goods:ui` | `detail-links` 渲染该款映射；**无**「解除/删除」按钮 |
| S1 `productId` 过滤 | `product:sku:smoke` · `ipc:shape:smoke` | 只返回该款；不跨店铺串数据；`invalid` 不混入"已关联" |
| S2 队列非缓存 | `goods:ui` | 队列里**不渲染**已关联行 |
| S3 弹层带图 | `goods:ui` | `pick-thumb` 每行有图；取图失败渲染空占位不整列空掉 |
| S3 直连 | `goods:ui` | 假桥收到的 `productSkuMap.rows[].productId` = 左栏选中款（**非第一个**） |
| S3 对比模式 | `goods:ui` | 开→左右各一图；`←/→` 换候选；`空格` 触发 `productSkuMap`；`Esc` 关闭；候选图独立取自选中产品 |

### 8-3 变异清单（每条新断言必须能变红，之后复原）

1. `productId` 过滤 → 改成不过滤（应报"跨款/全表返回"）
2. 已关联区 → 把 `invalid` 也算作已关联（应报"失效混入"）
3. 行展开 → 打开时不加载 SKU（应报"SKU 子表空"）
4. 直连 → 写死 `productId = 第一行`（应报"不是选中那款"）
5. 对比模式 → 候选图改用 `itemImagePool` 产品层（应报"左侧无图"）
6. 队列 → 渲染已关联行（应报"池里出现已关联"）
7. 弹层图 → 取图失败整列空掉（应报"失败即空列"）

---

## 9. 风险与回退

1. **窗口宽度**：两栏在窄窗口互相挤压。定**软下限 ~1180px**：低于此两栏改**上下堆叠**（左在上），各给 `min-width` 与横向滚动兜底。守卫：`goods:ui` 跑两遍（宽→并排；窄→堆叠），断言**两栏都在**而非"有一个消失"。
2. **回退**：`GOODS_LAYOUT` 常量（S0 建立）。旧组件**不删**。回退 = 改一个常量。
3. **不做的事**（防范围蔓延）：不改 `flow.ts` 判据（已撤除）/ 不改队列聚合口径 / 不改 `itemImagePool` 三层回落 / 不新增 IPC 通道 / 不动供应商页签 / 不做拖拽 / 不做卡片网格。
4. **守卫 churn 是主要成本**：DOM 一改，72 条按 DOM 定位的断言要重挂。**逐条重挂并登记"这 N 条换了选择器、语义未变"** —— 不允许"删掉跑不过的那几条"。

---

## 10. 门禁（逐条单看退出码）

`tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `verify`（IPC 契约）· `verify:docs`（无悬空引用）· `build` · `vitest run` · `product:sku:smoke` · `ipc:shape:smoke` · `goods:ui`。

⚠️ 本仓硬约束（`notes/2026-10-05-repo-hard-constraints.md`）：**改界面先 `build`**（`*:ui` 读 `dist/`）；**DB 冒烟前先 `tsc`**（跑 `dist/`）；electron 冒烟一律 `env -u ELECTRON_RUN_AS_NODE ... --no-sandbox --disable-gpu`。

---

## 11. 变更记录（摘要）

- **2026-10-10**：①「进价」页整页重设计（信息架构：左 340px 行动区 / 右款级进价表；`cost-echo` 回显防挂错款；`startsWith` 挡板防"还没输完就报错"；单位挂 `data-act` 外）。守卫 `goods:ui` +19（总数 242→261）。详见 `docs/notes/2026-10-30-goods-ux-refactor.md`。② 用户口径收紧：主表撤「SKU 数·缺 m」「进价」两列（8→6）；款名改弹性列+两行折行；展开区撤只读 SKU 清单（改三层卡片）。⚠️ **撤列 ≠ 撤能力**（缺克重→工具栏「问题件」筛选；进价→「进价」页签；SKU 增删改→「编辑」抽屉）。守卫 `goods:ui` +2（227→242）。详见 `docs/notes/2026-10-30-goods-list-and-pool.md`。
- **2026-10-08 续六**：S4 完成，页签 3→2、`TABS` 按形态分叉、删 `pool` 懒挂载开关、补窄视口守卫（`goods:ui` 105→110）。
- **2026-10-08 续五**：S3 完成，三条关联动线零新 IPC，`CompareModal` + `useSkuPool` 收敛写路径（`goods:ui` 80→105）。
- **2026-10-08 续四**：S2 完成，`PoolPane` 裁列、`useSkuPool` 共用（`goods:ui` 77→80）。
- **2026-10-08 续三**：**用户验收减负** —— 指标条/起点引导条/页签徽标整块删除（零消费者即删）；「缺克重/未关联供应商」入口搬进左栏工具栏 `filter-issue`（否则变死能力）；`useProductList.intent` 换内部单一真源 `issueFilter`。`goods:ui` 85→77 + 3 条反向守卫。
- **2026-10-08 续二**：S1 完成，左栏换 `ProductPane` + 数据层 `productId` 反向过滤零新通道（`product:sku:smoke` 43→45、`ipc:shape:smoke` 22→26、`goods:ui` 76→85）。
- **2026-10-08 续**：S0 完成，`GoodsWorkbenchView.vue` + `GOODS_LAYOUT` 常量（`goods:ui` +4）。
- **2026-10-08**：初版。用户拍板走**整页左右分栏重构**（Q1）· **连对比模式一起做**（Q2）· 「已关联商品」落 **行展开**（Q3）。
