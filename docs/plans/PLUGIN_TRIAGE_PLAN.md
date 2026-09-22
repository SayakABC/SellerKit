# 内置插件盘点与处置方案（PLUGIN_TRIAGE_PLAN）

> **状态**：🟡 执行中 —— T1（`order-insight`）✅、T3（`excel-copy`）✅ 已完成；T2 用户决定**先保留**；T4/T5 待办
> **生成日期**：2026-09-21（2026-09-22 更新执行记录）
> **依据**：`docs/baseline/PROJECT_BASELINE.md`、`AGENTS.md` §1.8/§1.9/红线 23、`docs/reviews/CODE_REVIEW_REPORT.md`（P1-5）、`docs/plans/REMEDIATION_PLAN.md`（R1-5 先例）、`docs/features/PROFIT_TRACKER.md` §10 D1'
> **目标**：清理无用内置插件，把有用内置插件转为市场分发的 UI 岛

---

## 0. 执行记录

| 日期 | 动作 | 结果 |
|---|---|---|
| 2026-09-21 | **T1 完成**：`order-insight` 从 `standard` / `pro` 下记 | `modules.config.json` 已移除；构建产物不再含该 chunk；`registry.generated.ts` 只剩 `excel-copy` + `quick-note`；id 已释放，市场安装的同名岛可正常注册 |
| 2026-09-21 | 岛侧功能补齐（配置继承） | `order-insight` 岛 **1.0.1 → 1.1.0**：新增命名空间级 `store`（与内建 `useModuleStorage('order-insight')` 同源）、列映射与分组维度双向读写、设置页新增「列映射」面板、修 `ready()` 握手时序、修 `DEFAULT_ENGINE.model` 拼写 |
| 2026-09-21 | 新增结构守卫 | `tests/pluginTriage.spec.ts`（10 例）：预设 ∩ 岛 id = ∅、注册表不含岛 id、岛的 db op 调用 ⊆ manifest 声明、`manifest.name` = 目录名 |
| 2026-09-21 | 发布 | `market-out/order-insight-1.1.0.zip`（37.5 KB，sha256 `b2a33e65…`），catalog 已更新 |
| 2026-09-22 | **岛 1.1.0 → 1.2.0**：内建版剩余能力全部补齐（下方缺口表清零）+ 修 4 处静默失效 | 发布 `market-out/order-insight-1.2.0.zip`（47.5 KB，sha256 `e17e54d6…`），catalog 已更新 |
| 2026-09-22 | 新增反向守卫 | `tests/pluginTriage.spec.ts` 由 10 例增至 19 例：缺口 op 必须被岛源码**真实调用**、对账必须读宿主真实字段名、`reclassify` 调用必须带 `fingerprint`（均已验证"回退即变红"） |
| 2026-09-22 | **T3 完成**：`excel-copy` 从 `minimal` / `standard` / `pro` **三个**预设下记（它是 `minimal` 的唯一成员） | `registry.generated.ts` 只剩 `quick-note`；注册表已无 `excel-copy`，id 释放 |
| 2026-09-22 | 宿主新增 `excel-copy` db 能力域 | `src/core/plugin/host.ts` 新增 7 个 op：`parseExcel` / `parseExcelBuffer` / `applyRules` / `readTextFile` / `readDefaultTemplate` / `checkFileExists` / `saveTemplateFile`（全部带消毒与条数上限） |
| 2026-09-22 | 新建岛 `ui-plugins/excel-copy` 1.0.0 | 原生 ESM、**无构建步骤**、零 npm 依赖；2 个页签（复制工作台 / 设置·模板配置|字段规则|显示列）；与内建共用 `modules.excel-copy` → 模板 / 规则 / 显示列 / 记录使用状态**自动继承** |
| 2026-09-22 | 守卫泛化 + 新增 excel-copy 断言 | 由 19 例增至 **27 例**：op 守卫改为「按 api.js 解析 helper→域」逐域校验（自动覆盖全部 5 个岛）；新增「宿主该域每个 op 必须被岛真实调用」「岛内不得出现 `eval`/`new Function`」「必须走宿主 `applyRules`」「不得引 xlsx」「命名空间必须是 `excel-copy`」「模板保存必须连 name 落库」 |
| 2026-09-22 | 发布 | `market-out/excel-copy-1.0.0.zip`（34.3 KB，sha256 `4d743159…`），catalog 已更新（6 个插件） |
| 2026-09-22 | 顺带修掉 2 个连带缺陷 | ① `vite.config.ts` 生成 `settingsPanelLoaders` 时空列表把闭合括号一起注释掉 → **只要构建不含 extensions 视图包就编译失败**（下记 excel-copy 后必然触发）；② `profiles` 取值用 `\|\|` 使"空预设"无法表达（会静默回落到 `enabledModules`），改为 `??` |
| — | T2 / T4 / T5 | `quick-note` 用户已决定**先保留**（不变）；脚手架归位与文档回写见 §5 T4 / T5 |

**下记 ≠ 删除。** 宿主侧 `electron/order-db.ts` 与 db 能力域 `order-insight` / `purchase` 原样保留（岛照常调用）；
`extensions/order-insight/` 源码暂留作算法参考，仅是不再进构建。

### 岛的功能缺口：已清零（2026-09-22，1.2.0）

内建版有、岛曾缺失的 op —— 宿主 `DB_OPS` 一直就绪，缺的只是岛侧交互：

| op | 内建对应功能 | 1.2.0 岛内入口 |
|---|---|---|
| `purchase.orderGet` / `purchase.orderUpdate` | 拿货单查看与编辑 | 拿货单 → 「查看 / 编辑」→ 自管 DOM 的模态（明细行可增删、岛内实时算合计，落库由宿主按同一公式复核） |
| `purchase.priceHistory` | 供应商价格历史 | 编辑器内「取最近价」按钮 + 填完款色自动回填（仅在该行尚未定价时触发，不覆盖手输） |
| `purchase.ignoreRemove` | 待拿货缺口「取消忽略」 | 缺口页新增「已忽略（无需补货）」表 + 取消忽略 |
| `purchase.shopAllocation` / `shopAllocationDetail` | 店铺分摊对账 | 对账页新增「店铺」子视图 + 逐店展开明细 |
| `order-insight.styleAssign` | 款式手工指派（纠正流程里重挂款式） | 数据纠正页新增「款编码」下拉（仅显式改指**另一个**款时才调用） |
| `order-insight.imageFind` / `readLocalImage` / `imageThumb` | 单张指纹查重 / 本地读图 / 单张缩略图 | **不补**：岛用 `imageThumbBatch` 合并调用，属实现差异非缺陷 |

顺带补齐与内建 `reconRange` 同语义的**对账时间窗筛选**（全部 / 今天 / 本月 / 本年 / 自定义），作用于厂商与店铺两个视图。

### 接线时修掉的 4 处「静默失效」

这四条都不是"缺按钮"，而是**不报错但结果错**的类型，是本轮最有价值的产出（已写入 `PROJECT_BASELINE.md` §11.12 作为冻结契约）：

1. **子页签点了没反应** —— `app.js#onClick` 只代理 `[data-act]`，而子页签用的是 `data-sub`。
   结果「拿货对账」的 5 个子页签里除首个（供应商）外全部不可达。修：`onClick` 支持显式 selector，
   `stockin.js` 传入 `[data-act], [data-sub], [data-recon-view], [data-range]`。
2. **同一个点击被回调 N 次** —— `draw()` 把 `mount` 的挂载点固定成 `app.viewEl`，每次 `refresh()` 都会再挂一个点击监听器，
   表现为重复写库 / 重复弹窗（新功能交互密度高，必然踩中）。修：每次绘制 `replaceChildren` 一个新的 `.view-holder`。
3. **金额放大 100 倍** —— `util.js#money(v)` 原实现是 `num(v, 2)`，而所有调用点传的都是 **分**（宿主 `*Cents` 口径）。
   拿货单金额、付款金额、对账差额全部显示为真实值的 100 倍。修：`money(cents)` 内置 ÷100。
4. **对账表恒显示 0 / reclassify 是空操作** ——
   ① 对账行按宿主并不存在的 `payableCents` / `name` 读取（真实字段是 `purchaseCents` / `paidCents` / `refundCents` / `balanceCents`）；
   ② 数据纠正的 `oi('update')` 漏传 `fingerprint` / `features`，而宿主分支条件是 `input.reclassify && input.fingerprint`
   —— 只传 `reclassify: true` 等于什么都没做，界面却提示「已重新归类」。

---

## 1. 结论摘要

当前随宿主分发的"内置插件"**只有 3 个**：`excel-copy` / `quick-note` / `order-insight`。三者的实际状态都不理想：

- **1 个已"死"**：`order-insight` 内建包占了 id，导致**市场已安装的同名 UI 岛永远注册不进去**（红线 23 的典型形态）。
- **1 个是 demo**：`quick-note` 源码 124 行，`meta.ts` 自述"最小业务模块示例"。
- **1 个用户已主动停用**：`excel-copy` 记录在 `plugins.disabled`，且配置为空壳（0 条记录）。

另有**两个放错位置的脚手架**（`sk-hello` / `_template`）和**一个与脚手架模板重复的市场样例**（`sk-ui-starter`）。

### 处置矩阵

| id | 位置 | 形态 | 判定 | 处置 | 优先级 |
|---|---|---|---|---|---|
| `order-insight` | `extensions/order-insight` | 扩展包·L0 | **ID 冲突，功能已被岛覆盖** | **下记内建 → 让已装的 UI 岛生效** | **P0** |
| `quick-note` | `src/modules/quick-note` | 内建·L0 | 自述 demo，无真实数据 | 删除，或转为 UI 岛示例 | P1 |
| `excel-copy` | `extensions/excel-copy` | 扩展包·L0 | 已停用、数据空壳 | **下记内建 + 转 UI 岛（已完成，见 §0/§7）** | P1 |
| `sk-hello` | `extensions/sk-hello` | 脚手架·示例 | 放置错误（不被构建收录） | 移到 `scripts/` | P2 |
| `_template` | `extensions/_template` | 脚手架·模板 | 放置错误，**但被构建脚本硬编码依赖** | 移到 `scripts/templates/` + 重指向 | P2 |
| `sk-ui-starter` | `ui-plugins/sk-ui-starter` | 市场 UI 岛 | 与 `scripts/ui-plugin-template` 内容重复 | 下架或明确为"样例岛" | P2 |

---

## 2. 盘点范围与判定规则

仓库里叫"插件"的目录有**三类**，判定标志与 App 内侧栏徽标一一对应（`AGENTS.md` §1.9 + `PluginCenter.vue` `badgeFor()`）：

| 类别 | 目录 | 判定标志 | App 徽标 | 分发 |
|---|---|---|---|---|
| 内建业务模块 | `src/modules/<id>/` | 存在 `meta.ts` | **内建 · L0** | 随宿主 |
| 随宿主视图插件包 | `extensions/<id>/` | 存在 `src/meta.ts`，manifest `kind: 'view'` | **扩展包 · L0** | 随宿主 |
| 市场 UI 岛 | `ui-plugins/<id>/` | manifest `kind: 'ui'`，`entry: './dist/index.html'` | **外置 · 视图** | 市场 zip |
| （L2 后台插件） | `<userData>/plugins/` | manifest 无 `kind`，`entry: './index.js'` | **外置 · L2** | 市场 zip |

> `extensions/` 下**没有 `src/meta.ts`** 的目录（`_template` / `sk-hello`）是第 4 类的脚手架，**不被 registry 收录、不随包分发**——放在这里属于位置错误。

---

## 3. 完整盘点表

### A. 随宿主分发的内置插件（3 个，构成 App 里的"内置"）

| id | 显示名 | 源码 | 源码规模 | 形态 | 使用证据 | 状态 |
|---|---|---|---|---|---|---|
| `excel-copy` | TV模版 | `extensions/excel-copy/src` | 1,853 行 / 13 文件 | 扩展包·L0 | `plugins.disabled` **含它**；`records` 0 条、`templateConfigs` 仅 1 条默认模板；配置与遗留扁平 key 双份存在 | ⚠️ 已停用 |
| `quick-note` | 便签 | `src/modules/quick-note` | 124 行 / 3 文件 | 内建·L0 | `app-shell.lastActiveModuleId = quick-note`，但 `notes: []` | ⚠️ demo |
| `order-insight` | 订单归类 | `extensions/order-insight/src` | **5,464 行 / 20 文件** | 扩展包·L0 | `modules['order-insight']` 有完整识别配置（provider/model/列映射/分组维度/透视维度） | 🔴 ID 冲突 |

> `order-insight` 的 `store.ts`（1,426 行）与 `stock-in/store.ts`（828 行）长期占据"仓库最大文件"榜前列。

### B. `extensions/` 下的脚手架（不被构建收录）

| id | 文件 | 规模 | 真实身份 | 谁在用它 |
|---|---|---|---|---|
| `sk-hello` | `index.js` + `manifest.json` | 66 行 | Phase 3 外置（L2）插件示例 | `scripts/plugins-install-demo.js` 硬编码复制它到 `<userData>/plugins/` |
| `_template` | `index.js` + `manifest.json` | 50 行 | `npm run plugins:create` 的 **L2 模板**（`__PLUGIN_ID__` 占位） | `scripts/plugin-create.js` 的 `TEMPLATE_BG` 硬编码指向 |

### C. 市场 UI 岛（`ui-plugins/`，独立分发）

| id | 版本 | 源码规模 | 已装版本 | 评估 |
|---|---|---|---|---|
| `shop-accounts` | 1.4.3 | 9,979 行 / 29 文件 | 1.4.1（待更新） | ✅ **生产级主力**：账号库/企业管理/收件箱，Vite+Vue3+Pinia，含 `manifest.settings` |
| `ae-profit` | 1.0.1 | 1,783 行 / 9 文件 | 1.0.1 | ✅ 有效（`docs/features/PROFIT_TRACKER.md` 三端方案展示端） |
| `order-insight` | 1.0.1 | dist 2,450 行 / 16 文件（**无 `src/`，dist 即源码，无构建步骤**） | 1.0.1 | 🔴 **已装但注册被静默跳过**（见 F1） |
| `sk-ui-starter` | 0.1.0 | 189 行 / 2 文件 | 0.1.0 | ⚠️ 与 `scripts/ui-plugin-template`（同为 189 行 / 2 文件）内容重复 |

> 另有 `scripts/poc-ui-hello/`（开发期种子 UI 包，dev 模式自动同步为 `<userData>/plugins/sk-ui-hello`，manifest 自述"勿发布"）。

---

## 4. 关键发现

### F1 🔴 `order-insight` 双实现 + ID 冲突 → 已装的岛是个死件

链路（`src/core/plugin/managerDiscover.ts`）：

1. `discover()` 遍历 `enabledModuleMetas`（来自 `modules.config.json` 的 `standard` profile，含 `order-insight`）→ 往 `records` 写入一条 **builtin** 记录，占用 id `order-insight`。
2. `discoverExternal()` → `registerUiIsland()`：**若 `records.has(p.id)` 则直接 `return`**，只留一条 `console.warn`：

   ```
   [plugin] UI 岛 "order-insight" 与内建插件同名，已跳过注册（内建不可被覆盖）。
   请从 modules.config.json 的 profiles 中移除该 id 后重启宿主。
   ```

3. 结果：`<userData>/plugins/order-insight/`（1.0.1）**装上了、市场显示"已安装"，但永远不会出现在侧栏**，且没有任何用户可见提示。

这正是 `AGENTS.md` 红线 23 描述的形态，也是 `PROFIT_TRACKER.md` §10 D1' 给 `ae-profit` 定下的规矩（"不得再进入任何默认打包预设，否则市场安装版不生效"）——**`order-insight` 的外置化只做了一半：岛建好了，内建没下记。**

### F2 ✅ 数据是共用的，所以下记内建**不会丢数据**（但配置要迁）

| | 内建 `extensions/order-insight` | 岛 `ui-plugins/order-insight` |
|---|---|---|
| 订单/指纹/队列/款式 | `ipc.order*()` 语义 IPC → `electron/order-db.ts` | `db` 能力域 `order-insight`（37 ops）→ `DB_OPS` → **同一批 order-db 函数** |
| 拿货对账 | `extensions/order-insight/src/stock-in/store.ts` | `db` 能力域 `purchase`（24 ops） |
| AI 密钥 | `ipc.orderApiKeySet/Get` | 同一 secrets |
| **配置**（provider/model/列映射/分组维度/透视维度） | **electron-store** `modules.order-insight` | 岛自己的 `storage` 命名空间 prefs |

**结论**：业务数据在 SQLite，两边共用，下记内建不丢数据；唯一需要搬的是 `electron-store` 里那份**识别配置**，否则识别设置要重填。

### F3 `src/lib/` 有 6/7 被这两个扩展包"独享"

| lib 模块 | 调用方 |
|---|---|
| `templateEngine` / `fieldProcessor` | **仅** `extensions/excel-copy/src/store.ts` |
| `orderClassifier` / `orderRowSplitter` | `extensions/order-insight/src/store.ts`（+ `orderClassifier` 被 `src/core/ai/openaiCompatible.ts` 引用） |
| `styleMatcher` / `aggregator` | `extensions/order-insight/*` |
| `excelParser` | `src/core/services/excel.ts`（宿主侧） |

即：**`src/lib/` 的存在主要就是为这两个内置插件服务**。两者都外置化后，`src/lib/` 可大幅瘦身（岛要自带纯函数，`ui-plugins/order-insight/dist/lib.js` 已是这个模式的先例）。

### F4 脚手架位置错误 + 两个 UI 岛样例重复

- `sk-hello` / `_template` 实际运行位置应是 `<userData>/plugins/`，放 `extensions/` 下既不被收录、又和真插件包混淆（基线文档自己也点出了这个语义冲突）。
- **但二者都是构建脚本的活依赖**：`scripts/plugin-create.js:20` 的 `TEMPLATE_BG` 指向 `extensions/_template`；`scripts/plugins-install-demo.js:15` 的 `SOURCE` 指向 `extensions/sk-hello`。清理必须同步重指向，否则 `npm run plugins:create` / `plugins:demo:install` 直接坏掉。
- UI 岛模板其实在 `scripts/ui-plugin-template`（`plugin-create.js` 的 `TEMPLATE_UI`），与 `ui-plugins/sk-ui-starter` 内容重复。

### F5 文档已多处漂移（清理前后都应回写）

| 位置 | 现写 | 实际 |
|---|---|---|
| `README.md` 核心能力表 | `shop-accounts` = 视图插件包（`extensions/`） | 已是市场 UI 岛（`ui-plugins/`） |
| `PROJECT_BASELINE.md` §2 | `extensions/ae-profit` 迁移残留仍在 | **已删除**（R1-5 完成，commit `ad7471d`） |
| `PROJECT_BASELINE.md` §3 | `ui-plugins/shop-accounts` 1,261 行 | 9,979 行（旧口径只算了 dist） |
| `AGENTS.md` §1.9 表格"当前实例" | `extensions` 列含 `shop-accounts` | `extensions/` 下已无该目录 |
| `AGENTS.md` §1.8 | 未提红线 23 已被 `order-insight` 实际触发 | 需补实例 |

---

## 5. 分项处置方案

### T1 · `order-insight` 下记内建，让 UI 岛生效（P0，最高价值）

**前置：等价性核对（强制，沿用 R1-5 先例）**

先证明岛不是"阉割版"，再删内建。按页签逐项核对：

| 岛 view | 内建对应 | 核对要点 |
|---|---|---|
| `overview.js` | `OrderInsightView.vue` + `StepsBar.vue` | 列映射、多产品行展开（`splitter.js`）、入队、断点续跑、缺图补链接 |
| `pivot.js` | `PivotPanel.vue` | 2 维度自动转款色矩阵、导出 |
| `detail.js` | `OrderDetailTable.vue` + `OrderThumb.vue` | 分页、发货状态切换、删除、缩略图 |
| `correction.js` | `CorrectionView.vue` + `CorrectionRow.vue` | reclassify 自动重挂款式、逐条/全部确认 |
| `library.js` | `ProductLibraryView.vue` | 改名/删除、Excel 批量导入（指纹列） |
| `stockin.js` | `stock-in/*`（Purchase/Recon/Payment/Supplier） | 供应商/拿货单/付款/对账/缺口（含忽略） |
| `settings.js` | `EngineSettings.vue` | provider/baseUrl/model/temperature、API Key 只写不读、孤儿图片清理 |

**动作**

1. 完成上表逐项核对；**发现缺项就把缺项补进岛**，而不是保留内建。
2. 迁移识别配置：把 `electron-store` 的 `modules.order-insight` 导出为岛的 prefs 初始值（或写一次性迁移提示）。
3. `modules.config.json`：从 `profiles.minimal/standard/pro` **全部移除 `order-insight`**（当前三处：`standard`、`pro` 含它；`minimal` 不含）。
4. `git rm -r extensions/order-insight`。
5. `npm run build` → 确认 `registry.generated.ts` 不再有 `order-insight` 条目。
6. 重启宿主 → 市场已装的岛应成功注册。

**验收**

- `PluginCenter` 出现 `order-insight`，徽标为 **外置 · 视图**（不再是 扩展包 · L0）。
- 侧栏出现入口；原先的"扩展包"条目消失；两个设置分类（`order-insight` 的设置面板）合并为一个。
- 打开岛能读到既有订单/指纹/款式数据（同一 SQLite）。
- `vue-tsc` / `tsc -p tsconfig.electron.json` / `vitest` / `verify` / `eslint` 全绿。

**风险与回退**：岛缺功能 → 代码在 git 历史中，`git revert` + 恢复 profile 登记即可；数据在 SQLite 未动。

---

### T2 · `quick-note`（P1，待拍板）

`meta.ts` 自述："最小业务模块示例 —— 证明「新增一个模块 = 建文件夹 + 在 modules.config.json 登记」"。124 行、`notes: []`。

| 选项 | 动作 | 代价 |
|---|---|---|
| **A. 删除**（推荐） | 删 `src/modules/quick-note/` + 从 `profiles.standard`/`pro` 移除 | **副作用**：`src/modules/` 变空 → `scripts/lib/module-roots.cjs` 的 `modules` 根失去实例（机制仍在，但基线文档 §2/§4 需改写；「内建模块」这条路径将无活样例） |
| B. 转为 UI 岛示例 | 迁到 `ui-plugins/`（可顺带取代内容重复的 `sk-ui-starter`） | 岛无 `icon` 字段，侧栏图标会固定成 `box` |
| C. 保留 | 不动 | 继续作为机制样例维护 |

> 若选 A，建议同时把"内建模块 SOP"的活样例改由文档承载，或明确 `src/modules/` 为"预留路径、当前无实例"。

---

### T3 · `excel-copy`（P1，待拍板）

它是最老的模块，`README.md` 称其为产品核心（"核心是「Excel 数据 → 模板化文本 → 一键复制」"），但**用户已在插件中心把它停用**，且数据是空壳（0 条记录、1 条默认模板）。注意它同时是**旧扁平 key**（`records`/`templateConfigs`/`processingRules`）的唯一读写方——`AGENTS.md` §1.4 明确要求"勿新增扁平 key"。

| 选项 | 动作 | 工作量 |
|---|---|---|
| **A. 保留内置** | 不动 | 0 |
| **B. 转 UI 岛**（若确认在用） | ① 岛内自带 `templateEngine`/`fieldProcessor`（纯函数，可直接拷）；② Excel 解析走宿主已有的 `db.parseExcel` / `exportWorkbook`（`order-insight` 岛已验证该路径）；③ 剪贴板走 `clipboard` 能力域（注意动作名是 `write`）；④ 设置面板迁到 `manifest.settings`（`shop-accounts` 已验证该机制）；⑤ 旧扁平 key 数据需一次迁移 | 中等：约 1,853 行移植 + 权限声明 + 配置迁移 |
| **C. 删除** | 删包 + 从 profile 移除 | 需处理 `src/lib/templateEngine.ts` / `fieldProcessor.ts` 失去唯一消费者（可一并删） |

> **判据建议**：若"Excel→模板→复制"仍是主业务链路，选 B；若已被 `order-insight` / `ae-profit` 取代，选 C。**这一条我不替你决定**——`plugins.disabled` 里它是被停用的，但可能只是试过启停按钮。

---

### T4 · 脚手架归位（P2）

1. `git mv extensions/_template scripts/templates/l2-plugin`
2. `git mv extensions/sk-hello scripts/templates/l2-demo`
3. 改 `scripts/plugin-create.js:20` → `TEMPLATE_BG = path.join(ROOT, 'scripts', 'templates', 'l2-plugin')`
4. 改 `scripts/plugins-install-demo.js:15` → `SOURCE = path.resolve(__dirname, 'templates', 'l2-demo')`
5. `npm run plugins:create test-x` 与 `npm run plugins:demo:install` 各跑一次验证不坏
6. 顺带处置 `ui-plugins/sk-ui-starter`：与 `scripts/ui-plugin-template` 重复 → 从市场下架，或保留但 README 标明"样例岛，供参照非脚手架"

### T5 · 文档回写（P2）

- `README.md`：核心能力表按新形态改写（`shop-accounts` → 市场岛；`order-insight` → 市场岛；`quick-note`/`excel-copy` 按 T2/T3 结论）
- `docs/baseline/PROJECT_BASELINE.md`：§2 目录职责、§3 规模表、§4 注册表与 UI 岛清单、§6 命名空间清单
- `AGENTS.md`：§1.8 补红线 23 的实例、§1.9 表格"当前实例"列
- `docs/README.md`：本文件入索引

---

## 6. 建议执行顺序

| 批次 | 内容 | 风险 | 前置 |
|---|---|---|---|
| **批次 1** | T1 `order-insight` 下记（等价性核对 → 下记 → 重建 → 验证） | 中（功能覆盖） | 等价性核对完成 |
| **批次 2** | T4 脚手架归位 + 脚本重指向 | 低（但必须同步改脚本） | — |
| **批次 3** | T2 / T3 按拍板结果执行 | 中 | 用户决策 |
| **批次 4** | T5 文档回写 + 基线刷新 | 低 | 前三批完成 |

---

## 7. 决策记录（2026-09-21，已拍板）

| # | 议题 | 决定 | 状态 |
|---|---|---|---|
| 1 | `excel-copy` | **转为 UI 岛** | ✅ 已完成：岛 1.0.0 已发布（`market-out/excel-copy-1.0.0.zip`），内建包已从 `minimal`/`standard`/`pro` 三处下记，id 已释放 |
| 2 | `quick-note` | **先保留** | ✅ 维持现状（`src/modules/` 保留活样例，`module-roots.cjs` 的 modules 根不悬空） |
| 3 | `order-insight` | **下记内建，达到"市场安装可用 + 功能完善"** | ✅ 下记已完成（1.1.0 发布）；内建能力缺口已于 1.2.0 **全部补齐并清零**（见 §0） |

### 术语：什么叫「下记内建」

指**把某个 id 从 `modules.config.json` 的构建预设里移除**，使其不再随宿主分发、由市场安装的 UI 岛接管。

具体三步（缺一不可）：

1. **移出预设** —— `profiles.standard` / `profiles.pro` 中删掉该 id（本例 `order-insight`）。`vite.config.ts` 读该清单生成 `src/registry.generated.ts`，因此下记后构建产物里不再有对应 chunk；
2. **释放 id** —— 下记是**必要前提**：`managerDiscover.discover()` 先按预设把 id 写进 `records`，随后 `registerUiIsland()` 见 `records.has(id)` 就 `return`（只留一条 console.warn）。所以只要预设里还留着该 id，从市场装的同名岛就**永远注册不上**（"装了、显示已安装、没有入口"）——即 AGENTS 红线 23；
3. **决定残留去向** —— 宿主侧数据层（`electron/<x>-db.ts`、`db` 能力域、IPC 通道）通常**保留**（岛要调用）；前端源码（`extensions/<id>/`）视情况删除或留档。

与「删除」的区别：下记只解除"随宿主分发 + 占用 id"，不动数据、不动宿主侧能力，**可逆**（把 id 加回预设即回到内建形态）。

---

## 8. 附：本次盘点用到的取证命令

```bash
# 谁被构建收录（唯一权威）
cat src/registry.generated.ts

# 各插件形态与规模
ls src/modules extensions ui-plugins

# 已装到宿主的插件 + 启停状态
ls "$HOME/Library/Application Support/seller-kit/plugins"
node -e "const c=require('$HOME/Library/Application Support/seller-kit/config.json');console.log(c.modules.plugins)"

# ID 冲突判定
sed -n '105,130p' src/core/plugin/managerDiscover.ts

# 数据是否共用
grep -n "store.ts" extensions/order-insight/src/store.ts   # ipc.order*
sed -n '/const DB_OPS/,/^};/p' src/core/plugin/host.ts     # db 域 order-insight
```
