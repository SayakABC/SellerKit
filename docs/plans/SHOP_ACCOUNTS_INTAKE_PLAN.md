# 店铺账号管家 UI 岛 → 宿主内建（「店铺管理」菜单）

> **状态**：🟢 已完成（2026-10-14；门禁与守卫结果见 `docs/notes/2026-10-30-shop-account-merge-and-status.md` §3–4 与 CHANGELOG 同日条目。范围外遗留：市场仓下架待用户确认）
> **生成日期**：2026-10-14
> **目标**：把 `ui-plugins/shop-accounts`（店铺账号管家 UI 岛，**10,000+ 行** Vue/Pinia 源码）整体搬回宿主，成为内建业务模块，入口挂在侧边栏新的一级菜单 **「店铺管理」** 下。
> **依据**：`AGENTS.md` §1.2/§1.3/§1.5、`docs/archive/plans/PLUGIN_TRIAGE_PLAN.md`（反向：这次是**回收**而非下记）、`scripts/lib/module-roots.cjs`（`isUndocked` 判定）

---

## 0. 结论先行（为什么要这么做 / 风险边界）

| 项 | 结论 |
|---|---|
| **数据是否迁移** | **零迁移**。岛与内建共用同一套宿主数据层（`electron/*-db.ts` + `ipc.*` 通道），岛只是把 `ipc.xxx` 换成桥调用；搬回内建是换回同一批函数 |
| **用户配置是否继承** | **自动继承**。存储命名空间仍为 `modules.shop-accounts` 与 `modules.shop-accounts-mail`（`useModuleStorage` 同键同形），视图模式/分组维度/邮件轮询偏好无需搬运 |
| **id 释放方向** | 反向：岛让出 id ⇒ `ui-plugins/shop-accounts` 必须删除，否则 `isUndocked()` 为真，`vite.config.ts` 会把 `shop-accounts` 从 registry 里**硬拦**掉，模块永远打包不进去 |
| **邮件正文 `sk-mail://` iframe** | 更安全：宿主渲染页**没有 CSP meta**（岛有自己的 meta CSP），两层 CSP 交集风险直接消失 |
| **Toast** | 删除岛内自渲染队列 + `ToastHost.vue`，统一走宿主 `toast()` 服务（宿主已在 AppShell 挂 `ToastHost`） |

### 设计决策（本计划的两个"非显然"选择，留痕备查）

1. **「店铺管理」= 侧边栏二级导航，不是一个新的业务模块**
   现有侧栏是**一级扁平**列表（`enabledModuleMetas` 直接渲染，见 `src/core/AppShell.vue`），没有任何分组能力。
   最小侵入做法：给 `ModuleMeta` 加可选 `parent`，新增 `NAV_GROUPS`（`src/core/nav.ts`）声明一级分组，AppShell 把 `parent` 命中的 meta 渲染成缩进子项。
   不做"父模块 + 跨模块跳转"那套（会产生一个没有自己内容的中转页）。

2. **设置页改为模块级设置贡献**
   原先由 `manifest.settings` 贡献为 `<id>:settings` 分类（`getIslandSettingCategories`）。
   内建后走同一队列的**另一条入口**：`src/modules/<id>/settings.ts` 导出 `settingPanels`。
   差一步基建 —— `vite.config.ts` 目前只为 `extensions/<id>/src/settings.ts` 生成 loader，**需把生成范围扩到 `src/modules` 根**（2 行改动，形状完全一致）。

### 不在本次范围（明确划出）

- **宿主 `DB_OPS` 的 `shop-accounts` / `shop` / `mail` / `secrets` 能力域保留不删**。它是权限面治理，与"UI 搬回宿主"是两个关注面；回收需连带改 `tests/pluginTriage.spec.ts` 的自证锚点，单独一轮做。
- **市场仓（独立 git 仓 `SayakABC/SellerKitPlugin`）的推送**。对外可见动作，删 zip + 摘 catalog 条目后是否 push 需用户确认（见 §6）。
- 岛内部的分页签（账号套装 / 企业 / 邮件 / 店铺登记）**保持原样**，本轮不拆成多个一级入口。

---

## 1. 现状盘点（取证）

| 事实 | 取证 |
|---|---|
| 岛源码 ~11,037 行，含 13 个组件 + 2 个 Pinia store | `wc -l ui-plugins/shop-accounts/src/**` |
| 岛源码**原本就是内建 Vue 源码**，靠 7 个桥接桩文件伪装成宿主服务 | 岛工程 vite.config.mjs 的 alias（该岛已随内迁删除，留档 `/tmp/sellerkit-retire/shop-accounts-island-2026-10-14.tgz`）：`@/core/services/ipc\|clipboard\|toast\|storage`、`@/types` → `src/api.js` 等 |
| 宿主 `ipc.ts` **已具备**全部所需函数（30 个 shop/company/mail op） | `grep -E "export (async )?function (shopAccount\|company\|shop\|mail)" src/core/services/ipc.ts` |
| 宿主 `src/types.ts` 已具备全部所需类型（`ShopAccount*`、`Mail*`、`Shop*`） | `grep -n "ShopAccountItem\|MailMessageItem" src/types.ts` |
| 直接依赖桥层的文件只有 3 个：`App.vue`、`SettingsView.vue`、`ShopAccountsView.vue` | `grep -rn "bridge.js" 岛 src/`（岛目录已删） |
| 直接依赖 `@/core/services/ipc` 的有 2 个 store + 1 个组件，已指向宿主路径 | 同上（alias 让它们在岛内解析到 `api.js`） |
| 另有 2 个组件直接 `import ... from '../api.js'`：`CompanyManageView.vue`、`ShopRegistryView.vue` | 需改写为 `@/core/services/ipc` |
| `ShopAccountsView.vue` 的 `openHostSettingsPanel` **导入后未被使用** | `grep -rn "openHostSettingsPanel" 岛 src/`（岛目录已删） 只有 import 行 |
| 侧栏无分组能力；`ModuleMeta` 有 `navHidden` 但无层级字段 | `src/core/types.ts` |

---

## 2. 执行步骤（按此顺序，每步可独立验证）

### S1 · 本计划文档 ✅

### S2 · 源码落地 `src/modules/shop-accounts/`（桥 → 真实宿主服务）

- 复制 `ShopAccountsView.vue`、`store.ts`、`mailStore.ts`、`icons.ts`、`components/**`（13 个）到 `src/modules/shop-accounts/`
- **丢弃** 7 个桥接/入口桩：`api.js`、`bridge.js`、`storage.js`、`toast.js`、`theme.js`、`types.js`、`main.js`、`settings.js`、`App.vue`、`style.css`、`ToastHost.vue`
- 改写 import：
  - 相对路径 `api.js`（岛内写作 ../api.js）→ `@/core/services/ipc`（`CompanyManageView.vue` 7 个 company op、`ShopRegistryView.vue` 8 个 shop op）
  - `@/core/services/{ipc,toast,storage,clipboard}`、`@/types` **保持原样**（现在解析到真身）
  - 相对路径 `bridge.js`（岛内写作 ./bridge.js）→ 删；`ShopAccountsView.vue` 内未使用的 `openHostSettingsPanel` 一并删
- 删除 `useIslandToasts` / `pushToast` 相关引用（`toast()` 直连宿主服务，签名一致：`toast(msg, kind)` + `.success/.error/.info`）
- **验证**：`npx vue-tsc --noEmit` 对该模块零报错

### S3 · 模块登记与设置贡献

- `src/modules/shop-accounts/meta.ts`：`id: 'shop-accounts'`、`name: '店铺账号管家'`、`icon: 'key'`、`parent: 'shop'`、`order: 1`
- `src/modules/shop-accounts/index.ts`：`ModuleDefinition { meta, view: ShopAccountsView }`
- `src/modules/shop-accounts/settings.ts`：导出 `settingPanels`（安全设置 `SecuritySettings` + 邮件设置 `MailSettingsPanel`，沿用原 `SettingsView.vue` 的组合与布局契约）
- `vite.config.ts`：`settingsPanelLoaders` 的生成条件由 `roots[id] === 'extensions'` 放宽为「任一模块根 + `settings.ts` 存在」
- `modules.config.json`：`standard` / `pro` / `enabledModules` 三处登记 `shop-accounts`，`_comment` 里"已下记的模块"移除该行并补回收说明

### S4 · 「店铺管理」二级导航

- `src/core/types.ts`：`ModuleMeta` 增加 `parent?: string`
- `src/core/nav.ts`（新）：`NAV_GROUPS = [{ id:'shop', name:'店铺管理', icon:'shop', order:5 }]`
- `AppShell.vue`：侧栏改为渲染 `navTree`（顶层项 = 无 parent 的 meta + 有子项的 group）；group 可展开/收起（状态进 `app-shell` 命名空间）；子项缩进渲染、命中联动 active 态（group 在任一子项激活时保持展开）
- `iconSvg()` 增加 `shop` 图标
- **验证**：`npm run build` 后 registry 含该 id；人工起 dev 点开子项

### S5 · 岛下架与守卫修复

- 删除 `ui-plugins/shop-accounts/`（`git rm -r`，含从未入库的文件要单独核对 `git ls-files`）
- 本机安装副本 `<userData>/plugins/shop-accounts` → 先备份再移废纸篓
- 修受影响的测试自证锚点：`tests/pluginManifest.spec.ts`（静态 import 该岛 manifest）、`tests/islandMailFrameCsp.spec.ts`（「扫到了嵌正文的岛」锚点）、`tests/pluginSettingsIsland.spec.ts`、`tests/uiIslandThemeTokens.spec.ts`（如需）
- **验证**：`npx vitest run` 全绿

### S6 · 门禁（逐条单看退出码）

```
npx tsc -p tsconfig.electron.json
npx vue-tsc --noEmit
npm run verify
npm run verify:docs
npx vitest run
npm run build
npm run plugins:island:smoke   # 剩余 3 个岛须照常可用
```

### S7 · 文档回写

- `docs/baseline/PROJECT_BASELINE.md`：UI 岛清单 −1、内建模块 +1、质量门禁表数字
- `CHANGELOG.md` `[Unreleased]`
- `docs/notes/2026-10-30-shop-account-merge-and-status.md` + `docs/notes/README.md` 索引登记一行
- 本计划 §0 状态置 🟢

---

## 3. 验收标准

1. `npm run build` 后 `src/registry.generated.ts` 含 `shop-accounts`，且 `ui-plugins/` 下已无该目录
2. 侧边栏出现「店铺管理」一级项，展开后可见「店铺账号管家」，点击后首屏渲染（不再是"等待桥握手"）
3. 设置 › 「账号管家」分类可打开（模块级设置贡献）
4. 原有数据照常读写（`sk_shop_accounts` 等表不动），旧用户的视图偏好自动生效
5. 门禁全绿，其余 3 个岛不受影响

## 4. 回滚路径

岛源码在进入本次改动前已在 git 中（含未跟踪文件需 `tar` 留档）。回滚 = `git checkout` 本计划的变更 + 恢复 `ui-plugins/shop-accounts` 目录即可，数据库无任何写操作。

## 5. 已知风险

| 风险 | 判据/处置 |
|---|---|
| 岛 TS 源码在宿主 `strict` 下报错 | `vue-tsc` 会点名；逐处修，不改 tsconfig |
| 岛 `style.css` 里有宿主没有的样式规则 | 已比对：宿主 `src/styles/index.css` 已含等价的控件主题化 + 滚动条 + `.wb-input`；丢弃安全 |
| `window.confirm`（删除确认）在宿主渲染层的行为 | 渲染进程原生 `confirm` 可用（`prompt` 才不支持） |
| `<userData>/plugins/shop-accounts` 残留导致"看着还装着一个不能用的岛" | S5 移废纸篓；即便残留，内建先占 id、岛被 `registerUiIsland` 静默跳过，不产生双入口 |
