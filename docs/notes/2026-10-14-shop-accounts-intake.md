# 「店铺账号管家」UI 岛回收为内建模块：用户说"放到店铺管理菜单下"，真正的工作是换掉它的 7 个桥桩

> 日期：2026-10-14 · 计划：`docs/plans/SHOP_ACCOUNTS_INTAKE_PLAN.md`（含两条设计决策的完整论证）
> 岛：`ui-plugins/shop-accounts`（vite + Vue3 + Pinia 工程岛，源码 ~11,037 行，1.5.2）→ 内建 `src/modules/shop-accounts/`

## 1. 发生了什么

用户要求把店铺账号管家岛移到宿主内、挂在「店铺管理」菜单下。执行按计划 S1–S7 全部完成：

- **源码落地**：视图 + 2 个 Pinia store + 13 个组件迁入 `src/modules/shop-accounts/`；**丢弃 11 个桥接/入口桩**（`api.js`/`bridge.js`/`storage.js`/`toast.js`/`theme.js`/`types.js`/`main.js`/`settings.js`/`App.vue`/`style.css`/`ToastHost.vue`）——岛的 alias 把 `@/core/services/ipc|toast|storage|clipboard`、`@/types` 劫持到自己的桩文件，**源码本来就写的宿主路径**，进宿主后 `@/` 解析到真身，只有 3 个文件真用了相对路径桥（`CompanyManageView`/`ShopRegistryView` → `ipc.ts`；`ShopAccountsView` 的 `openHostSettingsPanel` 是**导入后未使用的死代码**，一并删）。
- **二级导航**：`ModuleMeta` 增可选 `parent`；新建 `src/core/nav.ts`（`NAV_GROUPS`，「店铺管理」）；AppShell 侧栏改渲染 `navTree`，分组可展开/收起（状态进 `app-shell` 命名空间），子项缩进 + active 联动。刻意**不做**"父模块 + 跨模块跳转"（那会产生一个没有自己内容的中转页）。
- **设置贡献换入口**：`vite.config.ts` 的 `settingsPanelLoaders` 生成条件由 `roots[id] === 'extensions'` 放宽为「任一模块根下存在 `settings.ts`」；`src/modules/shop-accounts/settings.ts` 导出 `settingPanels`（安全设置 + 邮件设置），宿主设置中心分类照常出现。
- **岛下架**：`git rm -r ui-plugins/shop-accounts`（目录内从未入库的文件先 `tar` 留档 `/tmp/sellerkit-retire/shop-accounts-island-2026-10-14.tgz`）；本机 `<userData>/plugins/shop-accounts` 副本备份后移废纸篓。**市场仓（独立 git 仓）的 zip 与 catalog 条目未动**——对外动作待用户确认（范围外，见计划 §0）。

## 2. 关键结论（下次还会用到的）

- **数据与配置零迁移**：岛与内建共用同一套 `electron/*-db.ts` + `ipc.*` 通道；存储命名空间 `modules.shop-accounts` / `modules.shop-accounts-mail` 同键同形，旧用户视图偏好自动生效。迁移的真实工作量在**权限与生命周期面**（桥握手、CSP、Toast 队列、manifest 声明），不在数据。
- **id 反向释放是硬前提**：`scripts/lib/module-roots.cjs` 的 `isUndocked()` 只要岛目录在，就把同名 id 从 registry 硬拦掉。先删岛目录再 build，顺序不能反。
- **安全面只赚不赔**：`sk-mail://` 正文 iframe 原需「宿主响应头 `UI_CSP` + 岛 meta CSP」两层交集；宿主渲染页没有 meta CSP ⇒ 风险直接消失一层。`tests/islandMailFrameCsp.spec.ts` 改钉宿主 `index.html` + 内建模块（守卫语义不变：凡嵌正文的文档，其 CSP 必须放行 `frame-src sk-mail:`）。
- **类型顺带补齐**：`ShopAccountUpsertInput` 补 `companyId`（岛内凭 alias 绕过了宿主类型，编辑企业归属其实写不进去）、`shopList` 补 `shopSetId` 过滤参数——都是岛"想要但宿主类型面没有"的字段，回收后类型门禁第一次覆盖到它们。

## 3. 守卫（新增 + 改锚点）

- 新增 `tests/shopAccountsIntake.spec.ts`：内建结构守卫（meta `parent: 'shop'` / 模块目录存在 / settings 贡献 / 桥桩不存在 / modules.config 登记）。**变异复核**：改坏 `parent`、改坏 store 导出名、mkdir 空岛目录逐条打红后还原。
- 改自证锚点：`tests/pluginManifest.spec.ts`（岛清单 −shop-accounts，改钉 excel-copy + shipping-rate；⚠️ 2026-10-15 shipping-rate 也回收为内建，该清单再次改为 excel-copy + ae-profit，见 `2026-10-15-shipping-rate-intake.md` §3）、`tests/islandMailFrameCsp.spec.ts`（见上）、`tests/uxEntryNames.spec.ts`（岛名锚点改钉剩余岛，模块内文案清一遍"岛/宿主桥"措辞）。

## 4. 门禁结果（2026-10-14 实跑）

`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅ · `vitest run` **38 文件 695 例** ✅ · `build` ✅（registry 含 `shop-accounts`）· `verify:docs` ✅（本笔记登记后）。剩余岛冒烟见 CHANGELOG 同日条目。

## 5. 遗留

- 市场仓下架（删 zip + catalog）待用户确认后另行执行。
- 岛内 4 个页签（账号套装/企业/邮件/店铺登记）维持一体，未拆分；单文件 1000+ 行的技术债随迁入宿主（基线 §6 已有记录）。
