# SellerKit 插件化架构方案（PLUGIN_ARCHITECTURE）

> 状态：**Phase 1（内核）/ Phase 2（SDK + Host API）/ Phase 3（权限门 + 外置插件目录/动态加载）/ Phase 4（强化隔离：Worker 计算沙箱 + 桥协议）已落地**；外置插件现以「Level 2 Worker 沙箱」执行（详见 §9）；iframe UI 沙箱经 §11 决策裁剪为未来方向（外置插件当前为后台贡献型、无视图）。
> 目标：在现有「构建期模块化（REFACTOR_PLAN Phase 0，已完成）」之上，演进为以 Core / Plugin SDK / Host API / Plugins 四层分离的插件化架构：运行时插件发现、贡献点注册、事件驱动、权限门控与分级沙箱。
> 关联文档：`AGENTS.md`（编码基线，实现到对应阶段时同步更新）、`docs/baseline/REFACTOR_PLAN.md`（前一阶段方案，已完成）（`PROJECT_OVERVIEW.md` 已于 R4-1 删除）
> 适用范围：本文档描述**目标架构与实现路径**；每个 Phase 落地后需回写 `AGENTS.md` 的新红线与模式说明。

---

## 〇、读前必读：哪些章节是「目标态」而非现状

本文档同时承载**已落地的实现**与**未采纳的方向性设计**，两类内容混排极易误读（D-11 / R4-4）。
判定规则：**实际代码结构以 [`AGENTS.md`](../../AGENTS.md) 为准**，本文档只提供设计动机与演进路径。

| 章节                                           | 性质                           | 现状                                                                                                                                 |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| §一 背景与目标 / §二 设计原则                  | 背景                           | —                                                                                                                                    |
| §三 目标架构（分层）                           | **部分落地**                   | 四层分离已实现，但落在**单仓**（`src/core/plugin/` + `extensions/` + `ui-plugins/`），非 pnpm 多包                                   |
| **§四 Monorepo 目录结构（pnpm workspaces）**   | ⚠️ **目标态，未采纳**          | 当前为单仓；见该节顶部标注                                                                                                           |
| §五 核心组件设计（packages/core）              | **已落地**（路径非 packages/） | 实现在 `src/core/plugin/`：`di` / `eventBus` / `contributions` / `lifecycle` / `security` / `sandbox` / `gatedHost` / `host` / `sdk` |
| §六 插件注册机制 / §七 Host API / §九 安全模型 | **已落地**                     | 对应 `externalManifest` / `host` / `security` + `gatedHost` + `sandbox`                                                              |
| §八 插件 SDK 编程模型（packages/sdk）          | **已落地**（路径非 packages/） | 实现在 `src/core/plugin/sdk.ts` 与 `sdk` 导出面                                                                                      |
| §十 映射表 / §十一 决策 / §十二 里程碑         | 记录                           | —                                                                                                                                    |
| §十三 红线                                     | 已并入 AGENTS.md               | 基线以 `AGENTS.md` §3 为准（沙箱相关为其红线 20–22）                                                                                 |
| §十四 风险与开放问题                           | 记录                           | —                                                                                                                                    |
| §十五 外置富 UI 插件（UI 岛）                  | **P1–P3 已落地**               | 见该节自身状态行                                                                                                                     |

> 一句话：**读 §四 / §五 / §八 的目录与 import 路径时，请替换为 `AGENTS.md` 中的单仓路径。**

---

## 一、背景与目标

### 现状基线（Phase 0 已完成）

- **模块体系**：构建期静态裁剪。`modules.config.json`（profiles: minimal/standard/pro）→ `vite.config.ts` 生成 `src/registry.generated.ts`（`enabledModuleMetas` + `moduleViewLoaders`）→ `AppShell.vue` 消费；模块 = `meta.ts`（`ModuleMeta`）+ `index.ts`（`ModuleDefinition { meta, view, commands?, activate?, deactivate? }`）。
- **IPC 面**：`window.electronAPI`（preload 结构白名单消毒 + 主进程入参二次校验 + 限额），渲染层统一经 `src/core/services/ipc.ts` 类型安全封装；模块禁止直连。
- **持久化**：`useModuleStorage(ns)` → electron-store `modules.<ns>` 命名空间隔离。
- **网络**：渲染层 axios（IPC adapter）→ `net-request` IPC → 主进程 `electron/http-client.ts`（Electron net，协议/方法白名单）。

### 差距分析（插件化要补的能力）

| 维度     | 现状                                  | 目标                                                                        |
| -------- | ------------------------------------- | --------------------------------------------------------------------------- |
| 发现     | 构建期 `modules.config.json` 静态登记 | 运行时扫描内建注册表 + `userData/plugins/` 外置目录                         |
| 生命周期 | 仅视图级 `activate/deactivate`        | `installed → validated → loaded → active → inactive → uninstalled` + 失败态 |
| 激活     | 构建期全部静态 import                 | `activationEvents` 懒激活                                                   |
| 依赖     | 无                                    | manifest `dependencies`（semver + optional）                                |
| 通信     | 模块零互通                            | 事件总线（类型安全、payload 可序列化）                                      |
| 扩展     | 仅 `commands/views` 两个口            | 统一贡献点注册表（commands/views/settings/menus/statusBar/…）               |
| 隔离     | 模块间静态不 import                   | DI 容器 + 权限门 + 分级沙箱（Level 0/1/2）                                  |
| 卸载     | 无（构建期裁剪替代）                  | 运行时启停 / 卸载（内建插件可停用）                                         |

### 目标

1. Core 只保留 DI 容器、事件总线、生命周期管理、贡献点注册表（进程无关纯 TS 内核）。
2. Plugin SDK 独立成包，成为插件开发者唯一依赖与唯一编程模型。
3. Host API 把 `electronAPI` 领域收敛为白名单能力面，插件只经桥访问。
4. 一切业务功能皆插件；内建插件（现有三模块）与外置插件走同一条管线。

---

## 二、设计原则与约束

| 原则           | 说明                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| 增量式、分阶段 | 每 Phase 独立可验证、可回滚；不一次性重排，始终保证现有功能可用                 |
| 依赖单向       | `Plugin → SDK → Host/Core`；`Core 永不 import Plugin`；Plugin 之间零静态依赖    |
| 通信去耦合     | 插件间只经事件总线 / 贡献点 / 共享数据服务通信，禁止直接 import                 |
| 行为零改动优先 | 迁移 Phase 只搬代码、换注册方式，不重写业务逻辑                                 |
| 权限最小化     | manifest 显式声明 capability，安装确认 + 运行时权限门双校验                     |
| 复用既有安全面 | 权限门叠加在现有 preload 消毒与主进程校验**之上**，任何一层不得放宽             |
| 声明优先       | 能声明式（manifest `contributes`）就不写 JS；动态能力收敛到 activate 内显式注册 |

**延续 REFACTOR_PLAN 已锁定决策**（不推翻，仅演进）：模块命名空间隔离、`modules.config.json` 为内建插件单一事实源、构建期裁剪保留（内建插件仍可裁剪）、左侧导航 + ⌘K + 设置页机制保留。

---

## 三、目标架构（分层）

```
┌──────────────────────────────────────────────────────────────────┐
│  Host 进程模型（沿用现有三进程，职责不变）                            │
│  main(trusted)  preload(bridge,消毒)   renderer(trusted UI host)  │
├──────────────────────────────────────────────────────────────────┤
│  packages/core（进程无关内核，无 Electron/Vue 依赖）                │
│  DI Container │ EventBus │ ContributionRegistry │ Lifecycle        │
│  PluginManager(discover/load/activate/…) │ PermissionGate         │
├──────────────────────────────────────────────────────────────────┤
│  Host API（能力面）                                                 │
│  host-main：db 族 / fs / http / clipboard / 插件存储与安装器        │
│  host-renderer：storage / toast / settings 定位 / 主题 / UI 容器    │
│    └─ 桥（bridge）：沙箱插件 ↔ 宿主的唯一通道，逐调用过权限门         │
├──────────────────────────────────────────────────────────────────┤
│  packages/sdk（@sellerkit/plugin-sdk）                             │
│  definePlugin() │ PluginContext │ HostApi 类型 │ contribution 类型  │
├──────────────────────────────────────────────────────────────────┤
│  plugins/（一切业务皆插件）                                          │
│  builtin：excel-copy / order-insight / quick-note（随 host 分发）  │
│  external：userData/plugins/<id>/（运行时安装/卸载）                 │
└──────────────────────────────────────────────────────────────────┘
```

**铁律**

1. Core 不 import 任何 Plugin；Plugin 只 import SDK。
2. Plugin 之间零静态依赖；跨插件仅事件/贡献点/数据服务。
3. 插件不得直连 `window.electronAPI` / IPC —— 只能经 Host API 代理（权限门在代理内）。
4. 沙箱层不豁免白名单：主进程仍是最高信任边界。

---

> ⚠️ **本节为目标态设计，尚未采纳。** 当前实现是**单仓**：内核在 `src/core/plugin/`、
> 随宿主分发的视图插件包在 `extensions/<id>/`、市场分发的 UI 岛在 `ui-plugins/<id>/`，
> 主程序仍在仓库根目录（无 `apps/`、无 `pnpm-workspace.yaml`）。
> **规则以 `AGENTS.md` 为准**；本节列出的是「若未来拆包，目录怎么排」的设计稿——
> 其中的 `@sellerkit/plugin-sdk` 等包名**在当前代码里并不存在**，实际 import 路径见 §八 的标注。

```
SellerKit/
├── pnpm-workspace.yaml
├── apps/sellerkit/                     # Electron 壳 + 打包入口（现有 package.json 迁移目标）
│   ├── electron/                       # 现有 electron/* 平移（main/preload/http-client 等）
│   └── vite.config.ts
├── packages/
│   ├── core/                           # 纯 TS 内核（见 §5），渲染/主进程双端复用
│   │   └── src/{di,events,contributions,lifecycle,plugin-manager,security}/…
│   ├── sdk/                            # @sellerkit/plugin-sdk（见 §8）
│   ├── host-main/                      # 主进程宿主能力实现（db/fs/http/存储/安装器）
│   ├── host-renderer/                  # 渲染层宿主（AppShell/UI 容器/Worker/iframe 桥）
│   └── ui/                             # --wb-* 令牌与共享基元（由 core/components 抽出）
├── plugins/                            # 业务插件（独立包；内建插件仍随 host 分发）
│   ├── excel-copy/   { src/, manifest.json, package.json }
│   ├── order-insight/
│   ├── quick-note/
│   └── _template/                      # create-plugin 脚手架模板
├── modules.config.json                   # 保留：内建插件集合（含 profile 裁剪语义）
└── scripts/select-build.js             # 语义不变：选择「内建插件集合」打包
```

**迁移中间态**：落地期间 `electron/` 与 `src/`（core/modules/lib）原地保留，按 Phase 平移；目录重排**只发生在对应 Phase 的验收关卡内**，不提前制造 churn。

---

## 五、核心组件设计（packages/core）

> 路径说明：**组件设计已落地，但不在 `packages/core`**，而在 `src/core/plugin/`
> （`di.ts` / `eventBus.ts` / `contributions.ts` / `lifecycle.ts` / `security.ts` / `sandbox.ts` /
> `gatedHost.ts` / `host.ts` / `sdk.ts`，以及 R3-3 拆分出的 `manager*.ts`）。
> 本节的设计描述与代码一一对应，仅目录名未采纳。

### 5.1 DI 容器

- 自研轻量实现（优先）：无第三方运行时依赖、可 tree-shake、显式 token 便于权限映射；若实现复杂度超预期再评估 `tsyringe`，决策点记录于 §14。
- 插件不直接持有服务实现类，只经接口端口（`HostApi`）访问，便于替换与 mock。

```ts
// packages/core/src/di/container.ts
export type Token<T = unknown> = symbol | string | (abstract new (...args: any[]) => T);

export interface ServiceDefinition<T = unknown> {
  token: Token<T>;
  useClass?: new (...args: any[]) => T;
  useValue?: T;
  useFactory?: (c: Container) => T;
  /** 权限作用域标识（与 manifest capability 关联，见 §9） */
  scope?: string;
}

export interface Container {
  register<T>(def: ServiceDefinition<T>): void;
  resolve<T>(token: Token<T>): T; // 循环依赖检测：检测到抛错并 toast
  has(token: Token<unknown>): boolean;
  dispose(): void;
}

export const createContainer = (): Container => {
  /* Phase 1 实现 */
};
```

### 5.2 事件总线

- 插件间唯一通信通道；payload 必须可结构化克隆（跨 Worker/iframe 透传的前提）。
- `meta` 由宿主填充（`sourcePlugin` 不可伪造），用于审计与权限门。

```ts
// packages/core/src/events/bus.ts
export type EventType = string & { __event?: never };

export interface EventMeta {
  sourcePlugin: string;
  origin: 'host' | 'plugin';
  /** true 表示本次传播经历了结构化克隆（跨沙箱），参数将被序列化校验 */
  serialized: boolean;
}

export type EventHandler<E = unknown> = (payload: E, meta: EventMeta) => void | Promise<void>;

export interface EventBus {
  on<E extends string>(type: E, h: EventHandler<unknown>): () => void; // 返回 off
  once<E extends string>(type: E, h: EventHandler<unknown>): () => void;
  emit<E extends string>(type: E, payload: unknown, meta?: Partial<EventMeta>): Promise<void>;
}

export const Events = {
  OrderCorrected: 'order:corrected',
  OrderImported: 'order:imported',
  SupplierChanged: 'purchase:supplier-changed',
  SettingsChanged: 'host:settings-changed',
} as const;
// 事件名与 payload 类型契约收敛到 SDK 的 events.ts，双方按类型常量对接，不强依赖对方模块类型
```

> **通配符订阅（T9，已落地）**：`on()` 支持 type 尾部 `*` glob——`'plugin:*'` 订阅全部 `plugin:` 前缀事件、`'order:*'` 订阅全部订单域事件；emit 时先命中精确集合、再按注册序对「通配 pattern 集」前缀比对（精确订阅优先），单个监听器抛错不中断其它。宿主实现于 `eventBus.ts`（`meta.eventType` 携带实际事件名）；Worker 端 `sandboxRuntime.ts` 内联等价 pattern 判定做本地路由（双端一致，见 AGENTS.md 红线 20）。通配订阅同样携带宿主填充的 `meta`（来源不可伪造），约定只读 payload/meta、不得在订阅内反向 emit（防环）；冒烟覆盖见 `scripts/sandbox-smoke.mjs`。

### 5.3 贡献点注册表

- 宿主定义贡献点契约（类型 + 校验器 + 消费点），插件注册贡献（静态来自 manifest、动态来自 activate）。
- `id` 一律插件作用域化：`<plugin-name>.<local-id>`，冲突由注册表拒绝。

```ts
// packages/core/src/contributions/types.ts
export type ContributionType =
  | 'commands'
  | 'views'
  | 'settings'
  | 'menus'
  | 'statusBar'
  | 'themes'
  | 'contextMenus'
  | 'dataProviders';

export interface Contribution<C = unknown> {
  type: ContributionType;
  plugin: string; // 宿主填充
  id: string; // 全局唯一：<plugin>.<local>
  spec: C;
}

export interface ContributionRegistry {
  register<C>(c: Contribution<C>): () => void; // 返回注销函数；插件 deactivate 自动全量注销
  get<T extends ContributionType>(type: T, id: string): Contribution | undefined;
  list<T extends ContributionType>(type: T): Contribution[];
}

// 内置贡献点契约（核心几种）
export interface CommandContrib {
  id: string;
  title: string;
  category?: string; // ⌘K 分组
  icon?: ModuleIcon;
  order?: number; // ⌘K 显示顺序（升序，缺省 0；同值按注册序稳定）
  when?: string; // 预留简单条件（v1 不实现求值器则忽略）
  run: (args?: unknown) => void | Promise<void>;
}

export interface ViewContrib {
  id: string;
  title: string;
  icon?: ModuleIcon;
  order?: number;
  navHidden?: boolean; // 兼容 ModuleMeta.navHidden
  /** host=Vue 组件(Level 0/1 可信)；webview=iframe 沙箱入口(Level 1+)；declared=宿主声明式渲染 */
  container: 'host' | 'webview' | 'declared';
  component?: unknown; // container='host' 时的 Vue 组件
  entry?: string; // container='webview'：插件产出入口
  schema?: unknown; // container='declared'：表单/表格描述（Phase 2 定义）
}

export interface SettingContrib {
  id: string;
  category: string; // 映射 SettingsModal categories（general/excel/…）
  tab?: string;
  key: string; // 命名空间自动前缀，禁止裸 key
  order?: number; // 分类/分组内显示顺序（升序，缺省 0）
  type: 'string' | 'number' | 'boolean' | 'select' | 'list';
  label: string;
  default?: unknown;
  options?: { label: string; value: string }[];
}
```

**宿主消费点映射（现有 UI 不换皮）**

- `commands` → ⌘K 命令面板（现 `ModuleDefinition.commands`）
- `views` → 侧边栏导航 + 视图切换（现 `enabledModuleMetas` / `moduleViewLoaders`）
- `settings` → `SettingsModal`（沿用 categories/Tab 与 `open-settings` 事件定位）
- `menus/statusBar/themes` → 按需扩展，Phase 2 定义消费点

> **排序约定（§11 T8，已落地）**：`commands/views/settings` 一律支持 `order?: number`，消费点按升序渲染、缺省 0、同值按注册序稳定，不依赖注册先后语义。落地现状：`views` 沿 ModuleMeta.order 排序（`sortedMetas`）；`commands` 已在 ⌘K 消费点排序（`pluginManager.getActiveCommands` / `getPluginCommands` 按 order 升序，内建命令与沙箱命令均透传 order）；`settings` 的 order 随 spec 透传（`registerSetting` → `register-contribution`），待 T1 设置渲染器消费。

### 5.4 生命周期管理

状态机 + `activationEvents` 懒激活。现 `ModuleLifecycle.activate/deactivate` 升级为完整管线：

```ts
// packages/core/src/lifecycle/plugin.ts
export type PluginState =
  | 'installed'
  | 'validated'
  | 'dependency-error'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'disabled'
  | 'error'
  | 'uninstalled';

export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onView:${string}`
  | `onEvent:${string}`
  | `onSettings:${string}`;

export interface PluginModule {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

export interface PluginManager {
  discover(): Promise<void>; // builtin registry + userData/plugins
  installFromDir(dir: string): Promise<{ id: string } | { error: string }>;
  activate(id: string, reason: ActivationEvent): Promise<void>;
  deactivate(id: string, reason: string): Promise<void>;
  enable(id: string): Promise<void>; // disabled → 重新加入生命周期
  disable(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  onStateChange(h: (id: string, s: PluginState) => void): () => void;
}
```

**懒激活语义**：`activationEvents` 命中前，仅注册静态贡献（侧栏/⌘K 可见可点、data 不加载）；命中才 `activate()`。activate 超时（15s）→ 熔断置 `error` 并 toast（延续现有异常处理纪律）。

### 5.5 插件上下文与桥

```ts
// packages/core/src/plugin/context.ts
export interface PluginContext {
  manifest: PluginManifest;
  trustLevel: 0 | 1 | 2; // 见 §9 分级信任
  bus: EventBus; // 经桥转发（序列化校验）
  contributions: ContributionRegistry; // 动态注册/注销
  host: HostApi; // 能力面（§7），已套权限门
  storage: {
    load<T>(key: string): Promise<T | undefined>;
    save<T>(key: string, v: T): Promise<void>;
  };
  log: Logger; // 前缀 + 级别过滤 + 环形上限
  abort: AbortSignal; // deactivate/卸载时中止
}
```

---

## 六、插件注册机制

### 6.1 manifest.json（schema v1）

```jsonc
{
  "name": "sk.purchase-recon", // 全局唯一 kebab id；内建插件沿用现有模块 id
  "displayName": "拿货对账",
  "version": "1.2.0", // semver
  "description": "厂商/拿货单/付款/对账一体化",
  "author": "sellerkit",
  "icon": "assets/icon.png", // 市场/安装 UI 元信息（§11 T4 预留，目录分发暂不消费）
  "screenshots": ["assets/screenshot-1.png"], // 同上（预留）
  "homepage": "https://github.com/xxx/sk.order-insight", // 同上（预留）
  "repository": "https://github.com/xxx/sk.order-insight", // 同上（预留）
  "engines": { "sellerkit": "^1.0.0" }, // Host API 版本契约
  "entry": "dist/index.js", // activate 入口（桥加载）
  "activationEvents": ["onStartup"],
  "capabilities": [
    // 权限声明（最小权限，安装确认）
    { "id": "storage", "namespaces": ["purchase", "app-shell"] },
    { "id": "db", "scopes": ["order:read", "purchase:*"] },
    { "id": "http", "allow": ["https://api.example.com/*"] },
    { "id": "clipboard", "actions": ["write"] },
  ],
  "contributes": {
    "views": [{ "id": "purchase-recon", "title": "拿货对账", "icon": "box", "container": "host" }],
    "settings": [
      {
        "key": "supplier.phone",
        "category": "general",
        "type": "string",
        "label": "厂商电话默认值",
      },
    ],
  },
  "dependencies": [
    // 可选依赖缺失仅告警；必需依赖缺失置 dependency-error
    { "name": "sk.product-lib", "version": ">=1.0.0", "optional": false },
  ],
}
```

### 6.2 发现路径

1. **内建**：`modules.config.json`（构建期裁剪语义保留）→ 生成"内建插件清单" → `PluginManager.discover()` 静态注册。
2. **外置**：`userData/plugins/<name>/manifest.json + dist/`，启动与"刷新插件"时扫描（目录 mtime 变化触发）。

### 6.3 校验顺序（install/load 时）

`manifest schema 校验 → engines 兼容 → capabilities 语法校验 → 依赖解析（拓扑 + semver）→ 冲突检查（contribution id / 命名空间占用）`，任一步失败进对应错误态并给出可读原因（UI 提示，不静默）。

---

## 七、Host API（能力面定义）

按领域把 `electronAPI` 收敛为接口端口；渲染层 trusted 实现仍走 `core/services/ipc.ts`。插件侧拿到的是**代理对象**，每次调用过权限门：

```ts
// packages/sdk/src/host-api.ts
export interface HostApi {
  storage: {
    load<T>(ns: string): Promise<T | undefined>;      // → modules.<ns>（复用 electron-store 命名空间）
    save<T>(ns: string, v: T): Promise<void>;         // scheduleSave 语义由实现层保证
  };
  db: {
    order: { list(req: OrderListReq): Promise<OrderPage>; update(req: OrderUpdateInput): Promise<unknown> };
    purchase: { supplierList(): Promise<Supplier[]>; reconciliation(req?: { from?: string; to?: string }): Promise<ReconciliationRow[]> };
    // 只暴露白名单方法；SQL/裸连接不可达（延续现有 db.ts/order-db.ts/purchase-db.ts 封装）
  };
  clipboard: { writeText(t: string): Promise<void> };
  http: { get<T>(url: string, opts?: HttpOptions): Promise<T>; post<T>(...): Promise<T> };  // 域名受 capability 约束
  dialog: { openFile(opts: DialogOptions): Promise<FilePayload | undefined> };
  excel: { export(buffer: ArrayBuffer, defaultName?: string): Promise<{ filePath: string }> };
  ui: { openSettings(category?: string, tab?: string): void; notify(o: { kind: 'success'|'error'|'info'; text: string }): void };
  env: { isMac: boolean; version: string; platform: string };
}
```

**阶段拆分（已按落地修正）**：Phase 2 收敛 `storage/clipboard/http/dialog/ui/env` 六域 + `ctx.storage`（现渲染层能力，已落地）；原计划的 `db/excel/fs` 等主进程域（db 族 / excel 导出 / fs 文件能力）经 **§11 T5 决策标注暂缓引入，未随 Phase 3 实现**——当前能力面以渲染层六域为限（excel 仅以 `dialog.openFile({ kind: 'excel' })` 存在）。待确有插件调用场景时再按本契约评估主进程域实现与权限门映射，避免一次改面过大。

---

## 八、插件 SDK 编程模型（packages/sdk）

> 路径说明：**已落地，但不在 `packages/sdk`**，实际入口是
> `src/core/plugin/sdk.ts`（类型）与 `src/core/plugin/index.ts`（导出面）。
> 下方代码块中的 `@sellerkit/plugin-sdk` 是目标态包名，**当前不存在**；
> 插件侧实际通过宿主注入的 `ctx` 使用 SDK，外置插件不 import 任何宿主模块。

```ts
// packages/sdk/src/index.ts（目标态路径）
export { definePlugin } from './define';
export type { PluginContext, PluginManifest, HostApi, HostApiResult } from './types';
export * from './events'; // Events 常量与 payload 契约

// plugins/order-insight/src/index.ts —— 开发者视角
import { definePlugin, Events } from '@sellerkit/plugin-sdk';
import manifest from '../manifest.json';
import OrderInsightView from './OrderInsightView.vue';

export default definePlugin(manifest, {
  async activate(ctx) {
    ctx.contributions.register({
      type: 'views',
      id: 'main', // 全局 id = sk.order-insight.main
      spec: { title: '订单洞察', icon: 'chart', container: 'host', component: OrderInsightView },
    });
    ctx.contributions.register({
      type: 'commands',
      id: 'goto-stock-in',
      spec: { title: '去拿货对账', run: () => ctx.host.ui.openSettings('excel') },
    });
    ctx.bus.on(Events.OrderImported, async (p) => {
      /* 刷新统计，不 import 别的插件 */
    });
  },
  deactivate(ctx) {
    /* 释放监听/弹窗/定时器 */
  },
});
```

SDK 原则：**类型即文档**；SDK 只依赖 `packages/core` 的类型层与少量 runtime，绝不依赖 host UI 或主进程实现。

### 8.1 开发工具链（create-plugin，已落地·单仓档，见 §11 T6）

插件开发者体验依赖脚手架：目标形态 `pnpm create @sellerkit/plugin <id>`，生成 `manifest.json + index.ts（含示例 activate/deactivate）+ 示例 View.vue + tsconfig.json`。分两档落地（对齐单仓收敛现实与 §11 T2 目录分发）：

- **单仓档（已落地；模板目录 2026-09-22 归位）**：`scripts/templates/l2-plugin/` 脚手架目录（manifest.json + index.js，含命令 order 与通配订阅示例）+ `scripts/plugin-create.js`——`npm run plugins:create <kebab-id>`（复制目录 + 替换 `__PLUGIN_ID__` 占位符，支持 `--install` 直装 `<userData>/plugins/<id>`）；生成物对齐外置插件目录分发约束——`manifest.name` = 目录名、entry 为单文件 ESM `./index.js`、`capabilities` 显式声明。
- **独立包档（未来）**：待 `@sellerkit/plugin-sdk` 独立成包（§四 monorepo 化）后，脚手架升格为独立 CLI 包（`create-@sellerkit/plugin`），示例类型从 SDK 包引用。

---

## 九、安全模型

### 9.1 分级信任（UI 沙箱的现实取舍）

| 级别    | 来源                                                       | 加载方式                                                                                                                                                                                                    | UI 能力                                    | 说明                                                                        |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Level 0 | 内建（随宿主分发、构建期裁剪）                             | 静态 import（现状）                                                                                                                                                                                         | Vue 组件直渲                               | 与现有一致，无额外限制                                                      |
| Level 1 | —（Phase 3 过渡形态，已废弃）                              | 主线程 Blob `import()` + 权限门（legacy `externalLoader`）                                                                                                                                                  | —                                          | `trustLevel: 0\|1\|2` 枚举保留 1 仅为历史兼容；代码不再走此路径             |
| Level 2 | 本机外置、手动安装（`<userData>/plugins`，Phase 4 已落地） | **Worker 沙箱**：`sandboxRuntime.ts` 以 `?raw` 注入 Blob module worker（独立 JS realm），插件源码在 Worker 内 `import(blobUrl)` 求值；宿主侧 `sandbox.ts`（主线程）经 `createGatedHostApi` 权限门逐调用判定 | 无视图（后台贡献型：命令进 ⌘K / 设置贡献） | 无法直达 `window.electronAPI`/DOM/localStorage；可停用/卸载；崩溃有超时熔断 |

> 设计注记：桌面插件（同 VS Code/Obsidian）对富 UI 完整 JS 沙箱成本高；UI 越受限越安全。内建插件保持 Level 0 直接加载（延续现可信模型），**外置一律进 Level 2 Worker 计算沙箱**：插件源码不与宿主共享 realm，宿主侧只暴露经权限门包装的桥代理。计算沙箱在 Phase 4 已落地并回写 AGENTS.md §1.8；iframe UI 沙箱（Electron 中用 iframe+自定义协议而非 `<webview>`）经 §11 T3 决策暂缓——外置插件当前无视图。

### 9.2 权限门

`插件调用 HostApi.xxx → PermissionGate.check(capability, scope, namespace, url…) → 通过才落 IPC`。

- 三级匹配：方法 → scope → namespace/域名；
- 拒绝行为：记录审计事件 + 返回可读错误（插件可见）**而非静默吞掉**；
- 权限门位于现有 preload 消毒**之上**——任何层级不改宽既有白名单（红线 11/§1.7 语义延续到插件域）。

### 9.3 隔离与限额

| 项   | 策略                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行 | 外置插件在 **module Worker（Blob）内 `import(blobUrl)` 求值**，与宿主不共享 JS realm；Worker 中无 `window`/DOM/`electronAPI`/`localStorage`                           |
| 数据 | storage 命名空间 `plugin.<name>.*`（实际落 electron-store `modules.<pluginId>`）；`capabilities.storage.namespaces` 之外拒绝；插件自身命名空间经 `ctx.storage` 恒放行 |
| 网络 | `capabilities.http.allow` 域名白名单 ∩ `http-client.ts` 协议/方法白名单（沿用 §1.7）                                                                                  |
| 消息 | 桥消息 ≤1MB（调用方约定）；IPC 沿用现有 ≤10MB / 15s 超时；`request()` 超时仅在 `timeoutMs > 0` 生效                                                                   |
| 鉴权 | boot 时下发一次性随机 token，此后双向消息必须携带；不符即静默丢弃（Worker 内伪造/串台防护）                                                                           |
| 激活 | 15s 超时熔断；事件订阅 on 计数上限（500）；命令/设置贡献注册类型受限（`views` 拒绝、命令走 `registerCommand`、设置仅 `settings`）                                     |
| 日志 | 插件 log 环形缓冲 + 前缀 + 级别上限，可审计                                                                                                                           |
| 卸载 | 先 `deactivate()` → 注销贡献点 → 释放命名空间句柄 → 物理删除目录；激活失败/Worker 崩溃走 `handleSandboxCrash`：记录 error → 清理贡献 → `deactivateRecord`             |

### 9.4 Worker 沙箱桥协议（Phase 4 落地摘要）

实现文件：`src/core/plugin/sandboxRuntime.ts`（Worker 端运行时，`@ts-nocheck` 纯 JS）+ `src/core/plugin/sandbox.ts`（宿主端桥）。**两端 MSG 常量与载荷必须一一对应**（AGENTS.md 红线 20），改动需两处同步并跑冒烟（`npm run plugins:sandbox:smoke` → `scripts/sandbox-smoke.mjs`）。

- 消息面：
  - 宿主 → Worker：`boot / run-command / event / deactivate / abort`
  - Worker → 宿主：`activated / boot-error / deactivated / command-result / call / log / register-command / unregister-command / register-contribution / unregister-contribution / subscribe / unsubscribe / publish`（另 `call-result` 为宿主对 `call` 的应答）
- 关联规则：宿主请求（`boot/run-command/deactivate`）携带 `payload.rid`，Worker 应答时回显；插件 → 宿主能力调用经 `call { payload.id, domain, method, args }`，宿主回 `call-result { id, ok, value|error }` 由 id 关联待决 Promise；`event/abort/log` 单向无需应答。
- 鉴权：boot 信封携带一次性随机 token，运行时校验后建立会话；此后**所有**双向消息必须带同一 token，Worker 内伪造/串台一律静默丢弃；boot 幂等（重复 boot 报错）。
- 能力代理（Worker 内 `ctx.host.*` / `ctx.storage` / `ctx.bus` / `ctx.contributions` / `ctx.log` / `ctx.abort`）：全部经跨桥消息转宿主主线程；**权限判定与审计只发生在宿主侧**（`createGatedHostApi`），Worker 不可自证可信；`registerContribution` 限制 `settings` 类型、命令走 `registerCommand`、`views`/`registerView` 直接拒绝（外置插件为后台贡献型）。
- 运行时自包含约束：`sandboxRuntime.ts` 经 `?raw` 注入 Blob module worker 执行，必须保持纯 JS（无 import/TS 语法、末尾 `export {}` 空导出标模块、无 Vite alias），插件源码经 Worker 内 `import(blobUrl)` 求值。
- 生命周期：激活/停用均有超时；激活失败回滚已注册贡献并销毁 sandbox；Worker crash 由宿主 `onCrash` 捕获 → 状态机清理。

---

## 十、现有架构 ↔ 目标架构映射表（迁移对照）

| 现有                                                   | 目标                                                  | 落地 Phase                              |
| ------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| `ModuleMeta` / `ModuleDefinition`（src/core/types.ts） | SDK `PluginManifest` + `definePlugin()`               | 1（adapter 桥接，类型保留别名）/ 2 移除 |
| `registry.generated.ts`（静态注册表）                  | `PluginManager.discover()` 数据源                     | 1                                       |
| `ModuleLifecycle.activate/deactivate`                  | `PluginLifecycle.activate/deactivate`（同语义）       | 1                                       |
| `ModuleDefinition.commands`                            | `contributes.commands` / 动态注册                     | 1                                       |
| `core/services/ipc.ts` 的 electronAPI                  | Host services（host-renderer/host-main）              | 2                                       |
| `useModuleStorage(ns)`                                 | `ctx.host.storage` + capability 校验                  | 2                                       |
| SettingsModal categories/open-settings                 | `SettingContrib` → 设置页注册表                       | 2                                       |
| `electron/*-handlers.ts` / db.ts 族                    | host-main 服务 + 权限门                               | 3                                       |
| modules.config.json profiles                           | 内建插件集合（保留裁剪）                              | 全期                                    |
| `window.electronAPI` 消毒/白名单                       | 桥 + PermissionGate + preload 消毒（叠加）            | 3+                                      |
| 无                                                     | activationEvents / dependencies / 启停卸载 / 分级沙箱 | 3 / 4                                   |

---

## 十一、已对齐决策与待定项

**已对齐（本方案锁定）**

- Core 自研轻量 DI（无第三方运行时依赖，已落地 `di.ts` ~70 行：懒实例化 + 循环依赖检测 + 重复 token 拒绝 + dispose）。判据收紧为「先写接口与单测（循环依赖/懒加载/重复 token/dispose），自研超 300 行仍不可控即切 tsyringe」，见 §14 决策点 D1。
- 事件总线 payload 必须可结构化克隆；插件 ID 即事件审计源。
- 贡献点 id 全局 `plugin.local`，冲突拒绝而非覆盖。
- 内建插件保持 Level 0（不沙箱，延续可信分发）；**外置插件一律 Level 2 Worker 沙箱**（Level 1 主线程受限形态为 Phase 3 过渡，已废弃）。
- 迁移不改现有 UI 骨架（侧栏/⌘K/设置页/主题令牌），只换"谁提供数据"。

**待定（实现到对应 Phase 时裁决）**

- T1：设置项 `declared` schema 的字段集与 SettingsModal 渲染器的最终形态（外置设置贡献经 `registerSetting` → `register-contribution { type: 'settings' }` 直传 spec，宿主端当前做最小形状校验）。
- T2（已裁决）：外置插件分发格式 = **目录**（`<userData>/plugins/<kebab-id>/`，manifest + 单文件 ESM 入口）；安装方式 `npm run plugins:demo:install` 复制 + AppShell 启动扫描，暂不做安装确认 UI。
- T3（已裁决）：Level 2 沙箱**不提供声明式 UI 面**——外置插件为后台贡献型（命令进 ⌘K / 设置贡献），Worker 计算沙箱于 Phase 4 落地；iframe UI 沙箱整体暂缓，为未来方向（见 §14）。
- T4：插件市场与签名/更新器是否立项（Phase 4 未，维持本机自装）；§6.1 已预留 `icon/screenshots/homepage/repository` 市场元信息字段（字段只增不消费，立项时才启用校验与展示）。
- T5（已裁决）：`db/excel/fs` 等主进程域能力面**暂缓引入**（§7 原计划随 Phase 3 引入，实际未实现）——当前外置插件能力面为渲染层六域 + `ctx.storage`，excel 仅经 `dialog.openFile({ kind: 'excel' })`；何时需要：先由业务侧提出具体调用场景，再按 §7 契约补主进程域实现与权限门映射。
- T6（已落地·单仓档）：开发工具链 create-plugin（§8.1）——`scripts/templates/l2-plugin/`（原 `extensions/_template/`，2026-09-22 归位）+ `scripts/plugin-create.js`，命令 `npm run plugins:create <kebab-id>`（支持 `--install` 直装 `<userData>/plugins/`）；生成物对齐 T2 目录分发约束。独立 CLI 包档待 SDK 成包（monorepo）后升格；暂不预研 npm 发布。
- T7（待裁决）：插件间请求-响应 API——`ctx.api.expose('plugin.method', fn)` / `ctx.api.call('plugin.method', args)`（事件总线只适合广播/通知，稳定 API 面用请求-响应）。设计要点：方法 id 全局命名空间（冲突拒绝）；call 需可序列化返回/错误传播与超时；外置插件跨沙箱调用需扩展桥消息面（`call` 出站 + 宿主中转为对目标插件的 `run-api`）并把"公开方法"本身视为调用授权面；trustLevel 差异（L2 调用 L0 内建）需宿主裁定。涉及桥协议红线 20，**等待真实跨插件调用场景再启动**，不提前铺面。
- T8（已落地）：贡献点统一排序——`commands/views/settings` 一律支持 `order?: number`（§5.3）。`commands` 已在 ⌘K 消费点升序（`pluginManager.getActiveCommands/getPluginCommands`，内建 + 沙箱命令均透传 order）；`settings` order 随 spec 透传、待 T1 设置渲染器消费。
- T9（已落地）：事件总线通配符订阅 `'plugin:*'`/`'order:*'`（§5.2）——type 尾部 `*` 前缀匹配、emit 精确优先；宿主 `eventBus.ts` 通用实现（`meta.eventType`）+ Worker `sandboxRuntime.ts` 内联判定本地路由；冒烟覆盖（`scripts/sandbox-smoke.mjs`）。
- T10（已裁决，机制 A）：**外置视图插件落地形态 = 随宿主分发视图插件**——excel-copy / order-insight 迁 `extensions/<id>/src`（源码随宿主编译、registry 双根收录），保留完整 Vue 视图/数据/设置能力；安装/卸载=增删 `extensions/<id>/` 目录（构建期收录，受 `MODULE_IDS`/profile 裁剪）；运行时按包启停（持久化停用集）闭环"随时停用/启用"。真·运行时 dist 加载（独立构建产物 + 运行时主线程 island，随时安装第三方视图插件）列为下阶段候选（可行形态已细化为 **iframe 运行时岛 + 自带 vue/pinia**，规避“vue/pinia 双实例与宿主单例桥”决策——见 §十五）。

---

## 十二、里程碑路线（每阶段可独立交付）

| Phase                                                      | 范围                                                                                                                                                                                                                                                                                                                   | 产出                                                                                                                                                                                                                                                                                                                                                                                                                                              | 验收（回归点）                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0（已完成）**                                            | 构建期模块化                                                                                                                                                                                                                                                                                                           | REFACTOR_PLAN                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                              |
| **1（已完成）**                                            | 插件内核落地 `src/core/plugin/`（pluginManager + 贡献点注册表 + 生命周期状态机）；AppShell/侧栏/⌘K 改由注册表驱动；三内建模块以插件身份注册                                                                                                                                                                            | core/plugin + 消费点改造                                                                                                                                                                                                                                                                                                                                                                                                                          | 三模块功能逐一手动回归；build/vue-tsc 通过；UI 无感                                                                                                                                                                                                            |
| **2（已完成）**                                            | SDK（`plugin/sdk.ts`：ctx/host/storage/contributions）+ HostApi 六域收敛；excel-copy 示范迁移到模块态                                                                                                                                                                                                                  | sdk + 迁移示范                                                                                                                                                                                                                                                                                                                                                                                                                                    | vue-tsc/build 通过；既有设置页/持久化行为一致                                                                                                                                                                                                                  |
| **3（已完成）**                                            | 权限门（`security.ts` 能力判定 + 审计环 + `gatedHost.ts` Level 1 包装）；外置插件目录 `<userData>/plugins` 扫描/读取/卸载 IPC（`electron/plugins-handlers.ts`）；manifest 严格校验（`externalManifest.ts`）；管理 UI（设置→插件 `PluginCenter.vue`）；示例插件 `scripts/templates/l2-demo`（原 `extensions/sk-hello`） | 运行时管理器 + 设置插件面板 + 审计展示                                                                                                                                                                                                                                                                                                                                                                                                            | 手动安装示例插件（`npm run plugins:demo:install`）→ ⌘K 命令可用；越权（dialog/跨命名空间）被拒并在审计区展示；内建插件零回归。注：Phase 4 已用 Worker 沙箱取代主线程 Blob 加载（`externalLoader.ts` 精简为纯 discovery，`loadExternalPluginLifecycle` 移除）   |
| **4 强化隔离（Worker 沙箱已完成；UI 沙箱经 T3 决策暂缓）** | Worker 计算沙箱（`sandboxRuntime.ts` 运行时 + `sandbox.ts` 宿主桥 + token 鉴权/rid 关联 + 崩溃熔断）+ 管理面板信任级徽标；**裁剪** iframe UI 沙箱（外置插件=后台贡献型、无视图）                                                                                                                                       | 沙箱桥 + 审计 UI                                                                                                                                                                                                                                                                                                                                                                                                                                  | 外置插件在独立 Worker realm 执行，无法直达 `window.electronAPI`/DOM/localStorage；越权调用在宿主主线程被权限门拒绝并写审计；boot→命令→跨桥调用→停用全链路经 Node vm 冒烟（`scripts/sandbox-smoke.mjs`，`npm run plugins:sandbox:smoke`）+ 手动 `sk-hello` 回归 |
| **5（已完成，机制 A：随宿主分发视图插件）**                | 把两大视图模块外挂化并**保留完整视图能力**：`src/modules/excel-copy                                                                                                                                                                                                                                                    | order-insight`迁至`extensions/<id>/src`+`manifest.json`（`kind: view`）；registry 生成器双根解析（src/modules ↔ extensions/<id>/src）+ 生成 `pluginPackageInfos`/`settingsPanelLoaders`；设置面板贡献化（插件包 `settings.ts` → SettingsModal 分类/内容注册式，去 4 硬 import）；运行时按包启停（`pluginManager.setPluginEnabled/applyDisabled`+`plugins` 命名空间持久化 + PluginCenter 内建行启停按钮）；`tsconfig.json` include 纳入 extensions | 插件包结构 + 启停 + 贡献化设置面板                                                                                                                                                                                                                             | 两插件视图/数据/设置零回归；停用即侧栏/⌘K/设置分类消失且视图不可激活；quick-note（src/modules 对照组）正常；vite build + tsc 通过 |

每个 Phase 结束动作：更新 `AGENTS.md`（新红线/新模式）→ 全量 `npm run build` → 手工回归矩阵 → 提交（git）。

---

## 十三、红线（实现后并入 AGENTS.md；沙箱相关已并入其红线 20–22）

1. 禁止 Plugin import 其它 Plugin / Core；只允许 `@sellerkit/plugin-sdk`。
2. 禁止插件直连 `window.electronAPI`/IPC：一律 `ctx.host.*`（权限门）。
3. 禁止未声明 capability 即调用对应 Host API；`capabilities` 只增不减（向后兼容）。
4. 禁止插件使用裸扁平 storage key：一律 `plugin.<name>.<key>`（延续命名空间隔离红线）。
5. 禁止修改 Core 与宿主之间的桥协议而不升 `engines.sellerkit` 主版本。
6. 新贡献点类型必须先有宿主消费点与契约校验，禁止"注册了没人消费"的空洞扩展点。
7. 沙箱不豁免安全面：桥、preload 消毒、主进程校验三层缺一不可。
8. 禁止两端桥协议常量不同步（`sandboxRuntime.ts` ↔ `sandbox.ts` 的 MSG 与载荷/rid/id/token 关联），改动两处同步 + 冒烟（AGENTS.md 红线 20）。
9. 禁止破坏 Worker 运行时自包含性（`?raw` 注入 Blob module worker：纯 JS、无 import/TS、单 `export {}`、不触 window/DOM/electronAPI）（AGENTS.md 红线 21）。
10. 禁止外置插件绕过沙箱回退主线程 `import()`/`eval` 执行；宿主侧权限门判定不得移入 Worker（AGENTS.md 红线 22）。

---

## 十四、风险与开放问题

| 风险/问题              | 说明与缓解                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 DI 自研 vs tsyringe | 自研已落地（`di.ts` ~70 行，懒实例化 + 循环依赖检测 + 重复 token 拒绝 + dispose）。判据收紧：先写接口与单测（循环依赖/懒加载/重复 token/dispose），自研超 300 行仍不可控即切 tsyringe，仅 Core 内部换实现，SDK 类型不变 |
| UI 沙箱容器选型        | iframe + 自定义协议（srv 同源）候选；`<webview>` 官方已不推荐。经 §11 T3 决策整体暂缓：Phase 4 落地 Worker 计算沙箱，外置插件为后台贡献型无视图；若未来引入外置 UI，再启动 iframe POC（方案已细化，见 §十五）           |
| 懒激活与首屏           | `onStartup` 内建插件保持同步激活，外置默认事件驱动；避免启动竞态（discover 完成前 UI 只显示占位）                                                                                                                       |
| 事件 payload 序列化    | 所有跨插件事件假定序列化；v1 直接在 trusted 层中转做深拷贝校验                                                                                                                                                          |
| 内建插件与外置同管线   | 同管线保证能力一致；差异只在 trustLevel 与发现路径                                                                                                                                                                      |
| 大文件/二进制传输      | 不鼓励走事件/桥；二进制经宿主专属方法（现有 orderImageThumbBatch 合批思路）扩展                                                                                                                                         |
| 与 AGENTS.md 的关系    | 本文件是**方向性计划**；每 Phase 验收时把锁定模式写回 AGENTS.md，避免双头文档漂移                                                                                                                                       |

---

## 十五、外置富 UI 插件运行时方案（T10 下阶段候选）

> 状态：**P1/P2 核心 + P3 工具链已落地（2026-09-07）**：P1 = 桥 + token 握手 + 权限门复用 + storage/ui/log/bus + 主题令牌注入 + 侧栏/⌘K 视图岛登记；P2 = PluginCenter 市场全链路（安装/更新/卸载）+ 内建/UI 岛启停 + 信任徽标（外置·视图 与 L2 Worker 区分）；P3 = `create-ui-plugin` 模板 + `publish-plugin` UI 包支持 + demo 试点（sk-ui-starter，**该样例岛已于 2026-09-24 删除**；模板另行保留在 `scripts/ui-plugin-template`），验证结论见 §15.6。剩余：能力/大小阈值等见 §15.7（安装确认 UI 已降级为可选增强，不阻塞，见 §15.7）。目标形态：外置插件从插件市场下载安装/卸载/更新，**含完整 Vue 视图**；与 §9 L2 Worker 后台插件（sk-hello 型）并行共存，互不影响。相比 §11 T10 原“运行时主线程 island”（需 vue/pinia 双实例与宿主单例桥决策），本方案采用 **iframe 运行时岛 + 插件自带运行时**，规避双实例问题。开发态 UI 岛演示入口：~~dev 启动自动播种 `scripts/poc-ui-hello/` → 侧栏「UI 岛 Hello」（kind: ui，order 120 置尾）~~ —— **2026-09-24 已移除**：该种子 demo（`sk-ui-hello`）连同播种链路一并删除；要起 demo 岛请用 `npm run plugins:create:ui <id>`（模板 `scripts/ui-plugin-template`）或安装市场在架岛。

### 15.1 目标与边界

- 富 UI 外置插件 = 预构建静态站点包（自带 vue/pinia），在独立 iframe（独立 JS realm）中执行；宿主仅提供三样：自定义协议资源服务、postMessage 桥、权限门。
- 不触碰现有一切形态：L2 Worker 后台插件、随宿主分发视图插件（excel-copy / order-insight）、构建期模块裁剪均保持现状。
- 能力面沿用 HostApi 六域 + `ctx.storage` + 事件总线；一切调用经桥 + `gatedHost` 权限门判定与审计（语义对齐 AGENTS.md 红线 16/17）。
- 插件包内**不引用宿主源码**：无 `@/` 导入、无 `window.electronAPI`、无 Node；视觉靠宿主注入 `--wb-*` 令牌。

### 15.2 包形态与分发

```
<id>-<version>.zip
├── manifest.json      # entry: "./dist/index.html"
└── dist/              # vite build 产物（多 chunk 可用：assets 相对引用）
    ├── index.html
    └── assets/*.js | *.css
```

- `manifest` 新增 `kind: "ui"` 标识；渲染层 schema（`externalManifest.ts`）放行 entry 指向 html / dist 目录。
- zip 下载/解压/校验沿用现有市场链路（sha256 → yauzl 安全解压防 `..`/symlink → `name == id` → 落盘 `<userData>/plugins/<id>/`），仅目录结构校验分支需扩展。

### 15.3 加载与隔离

1. **主进程**：`protocol.handle` 注册特权 scheme `sk-plugin://`（standard/secure/CORS、只读 GET、路径穿越校验、正确 MIME + 注入 CSP 头），根映射 `<userData>/plugins/`。
2. **AppShell**：新增“运行时视图容器”——现有内容区按 `activeModuleId` + 静态视图贡献渲染，为其增加一类 runtime source；激活时挂载
   `<iframe sandbox="allow-scripts allow-forms allow-same-origin" src="sk-plugin://<id>/dist/index.html">`。
3. **桥**：iframe 端 `plugin-ui-runtime.js`（宿主注入或随包）与宿主端 `iframeHostBridge.ts` 建立 postMessage 会话——一次性 token 握手 + `rid/id` 请求关联（纪律对齐 AGENTS.md 红线 20：双端消息面/常量同步，改一处必须两处同步并跑冒烟）；宿主侧逐调用过 `gatedHost` 权限门。
4. **主题**：宿主将 `--wb-*` 令牌拷贝注入 iframe 文档（两套主题都注入），视觉与宿主一致。
   另需下发 `theme.mode`（`light|dark`）：`color-scheme` **不是**设计令牌、无法随 `--wb-*` 传递，
   运行时把它写到 iframe `<html>` 的内联样式上（内联优先级高于岛内样式表，能覆盖岛里写死的
   `color-scheme: light`）。缺这一步时深色主题下岛内**原生控件**（日期选择器/下拉/滚动条/复选框）
   仍是浅色 →「岛内样式跟宿主主题不一致」（2026-09-22 修，见 AGENTS.md §1.6）。

### 15.4 信任与安全模型

| 项         | 说明                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信任级别   | 新增“外置 · 视图”徽标，与 L2 Worker 区分；iframe 内视图代码与宿主渲染代码同 realm 等效信任，安全依赖：iframe sandbox + 包内 CSP + 协议只读/穿越校验 + 能力全经权限门 + 安装确认 |
| 安装确认   | 市场安装时向用户展示 capabilities（storage 命名空间 / http URL 前缀 / clipboard 等）确认后才落盘，写入审计                                                                      |
| 不可触达   | iframe 内无 `window.electronAPI` / Node / fs；`localStorage`/cookie 依赖不可靠 → 持久化一律 `ctx.storage`                                                                       |
| 双防线放宽 | 入口大小上限按资源类型分层（建议单资源 ≤16MB、目录 ≤32MB）：主进程 `electron/plugins-handlers.ts` 与渲染层 `externalManifest.ts` 两处同步（AGENTS.md 红线 18/19）               |

### 15.5 改动清单

| 模块                                                                    | 改动                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `electron/main.ts` + 新增协议 handler                                   | 注册 `sk-plugin://` 特权协议（只读文件服务 + 穿越校验） |
| `electron/plugins-handlers.ts`                                          | entry 支持 html/dir 形态 + 大小分层阈值                 |
| `src/core/plugin/externalManifest.ts`                                   | schema 放行 `kind:"ui"`、entry 指向 html、可选 ui 字段  |
| `src/core/plugin/externalLoader.ts`                                     | 识别 UI 包 → 登记为视图岛记录（不走 Worker 沙箱）       |
| 新增 `iframeHostBridge.ts`（宿主）/ `plugin-ui-runtime.js`（iframe 端） | 桥双端（token/rid 关联 + 消息面同步纪律）               |
| `src/core/plugin/pluginManager.ts`                                      | 视图岛贡献注册/销毁；启停与停用集持久化复用             |
| `src/core/AppShell.vue`                                                 | 运行时视图容器（iframe）渲染；侧栏并入运行时视图贡献    |
| `src/core/components/PluginCenter.vue` + 市场链路                       | UI 包安装结构校验分支 + 信任徽标 + 安装确认             |
| `scripts/publish-plugin.js` + 脚手架                                    | UI 包“先构建后打包”；新增 `create-ui-plugin` 模板       |

### 15.6 分阶段（每阶段可独立验证）

| 阶段 | 范围                                                                                                                                                                                                                               | 验收                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P0   | ✅ 已完成：`sk-plugin://` 特权协议 + iframe 加载 demo UI 包（静态站点，结构等同 vite 产物）                                                                                                                                        | 跨源协议加载 / 相对 css·js·svg 资源 / CSP / sandbox / DOM 交互跑通（结论见下表）                               |
| P1   | ✅ 核心已完成：桥 + token 握手 + 权限门复用；`storage / ui / log` 打通 + bus 双向；主题令牌注入；侧栏 + ⌘K 视图岛登记                                                                                                              | 岛内能力调用成功、越权被拒并审计（结论见下表）；P2 项（PluginCenter 管理 UI/启停卸载）已落地（见 P2 行）       |
| P2   | ✅ 核心已完成：PluginCenter 管理 UI（市场安装/更新 + 内建与 UI 岛启停 + 卸载二次确认）+ 信任徽标（外置·视图 / 外置·L2 / L0 三态）；UI 岛并入管理面板与停用集（overview `kind:'ui'`、合成 state 广播、正显示岛被停用/卸载自动回落） | 市场全链路可用（结论见下表）；安装确认 UI（capabilities 预览）非安全缺口，已降级为可选增强（触发条件见 §15.7） |
| P3   | ✅ 已完成：`create-ui-plugin` 模板 + `publish-plugin` 支持 UI 包 + demo 试点（`ui-plugins/sk-ui-starter`，**2026-09-24 已删除**：与 `scripts/ui-plugin-template` 内容重复，见 `docs/plans/PLUGIN_TRIAGE_PLAN.md` §7-4）            | 发布 → 安装 → 启用 → 停用 → 卸载端到端走通（工具链/静态验证结论见下；GUI 冒烟待人工复核）                      |

> ⚠️ **2026-09-24 变更（读下方 P0/P1/P2 结论前必读）**：P0 起用于验证的开发期种子 demo **`sk-ui-hello`（UI 岛 Hello）已删除** ——
> 种子包 `scripts/poc-ui-hello/`、`plugin-ui-protocol.ts` 的 `UI_POC_ID` / `seedDevPocPackage()` / `ensurePocPackageSeeded()`
> 与 `main.ts` 的播种调用一并移除，dev 启动**不再自动播种**任何 UI 岛（否则删掉插件下次 `npm run dev` 又会回来）。
> 下方 P0/P1/P2 结论是**当时的历史记录**，其中以「UI 岛 Hello」为对象的手工冒烟步骤已不可复现；
> 要重跑同类冒烟，请先用 `npm run plugins:create:ui <id>` 生成临时岛（模板 `scripts/ui-plugin-template`）或安装市场在架岛。

**P0 验证结论（2026-09-07 回写）**

- 交付物：`electron/plugin-ui-protocol.ts`（特权协议服务）；dev 启动自动播种 demo（`ensurePocPackageSeeded` 同步 `scripts/poc-ui-hello/` → `<userData>/plugins/sk-ui-hello`，先于窗口创建）；宿主 iframe 预览（P0 为 dev-only 占位，P1 已并入正式双通道 `UiIslandView.vue` 渲染，见 P1 结论）；demo 静态站点包（manifest `kind:"ui"` + `dist/` 相对引用资源）。
- ✅ 技术路线成立：`sk-plugin://`（standard/secure/corsEnabled/stream）只读服务根映射 `<userData>/plugins/<id>/`，逐段拒绝 `..`/反斜杠/空字节 + realpath 二次防 symlink 逃逸 + 目录回退 `index.html` + 扩展名→MIME + 注入 CSP + 单资源 ≤16MB；宿主 iframe `sandbox="allow-scripts allow-forms allow-same-origin"` 加载后，相对 css/js/svg 资源、页面内 CSP、ESM 脚本与 DOM 交互全部正常，跨源隔离成立（iframe origin = `sk-plugin://sk-ui-hello`）。
- ⚠️ 设计修正（UI 包与 L2 Worker 解耦）：UI 形态包（entry 为 html 的静态站点）**禁止进 L2 Worker 注册/激活路径**——否则 PluginCenter 渲染「激活」按钮 → Worker `import()` HTML 抛 `Unexpected token '<'`。落地：`PluginManifest.kind?: 'ui'`（types.ts）→ schema 归一化保留（externalManifest.ts）→ `discoverExternalPlugins` 拆出 `ui[]` 前置过滤（externalLoader.ts）→ pluginManager 双守卫（`registerExternal` 跳过 UI 包 / `activateExternal` 明确报错）。L2 Worker 后台插件（`./index.js` 入口）注册/激活路径零改动。
- ➡️ 确认 §15.3 判断：iframe 与宿主跨源、JS 无法直读宿主 → 主题令牌注入与 `ctx.host` 调用必须经 P1 postMessage 桥（token 握手 + rid/id 关联 + gatedHost 权限门）；demo 暂用自身 CSS 令牌自洽渲染。
- 备注：vite 多 chunk 构建产物加载与 `create-ui-plugin` 模板验证归 P3（P0 手写产物已覆盖相对引用/多资源/无宿主依赖三要素）。

**P1 验证结论（2026-09-07 回写）**

- 交付物：`electron/plugin-ui-runtime.js`（iframe 端纯 JS 桥：`window.__sk` 的 host/storage/bus/log/env/manifest 域 + 一次性 token 握手 + `SUB_TOKEN` + DOM-ready 握手）；`src/core/plugin/uiBridgeHost.ts`（宿主桥：`UI_MSG` 常量、`e.origin===expectedOrigin` + `e.source===iframe.contentWindow` 双校验、`CALLS` 白名单（域/方法/元数）转发至已过权限门的 `hostApi`、`collectWbThemeVars()` 注入 `--wb-*` 令牌）；`plugin-ui-protocol.ts` 对 `.html` 响应尾部注入同源 `<script src="sk-plugin://<id>/__sk__/runtime.js">`（桥版本宿主控制，保留路径不映射插件文件）；`UiIslandView.vue`（宿主视图容器：`@load` 挂桥、连接态、宿主→岛 ping、`data-theme` MutationObserver）+ `AppShell.vue` 双通道渲染（`activeIslandId` → UiIslandView，`pm.activate` 对岛返回 `{view:null}`）；`pluginManager` 独立轨道 `uiIslands` Map（**不进 PluginRecord/contributions 生命周期**，规避 removeByPlugin 连带；P2 起启停复用统一停用集 `disabled`，见 P2 结论）+ `sortedMetas` 置尾（order 120）→ 侧栏 + ⌘K 均见「UI 岛 Hello」；demo 升 v0.2.0（`capabilities:[{id:'storage',namespaces:['sk-ui-hello']}]`，页面含 Storage/Toast/Log/事件→宿主/越权·剪贴板/越权·对话框 按钮 + 状态行，CSS 已切 `--wb-*` 令牌）。
- ✅ 编译验证（本次会话执行）：`vue-tsc --noEmit -p tsconfig.json`（渲染层 + extensions 插件包）与 `tsc --noEmit -p tsconfig.electron.json`（主进程）均零错误。
- 手工 GUI 冒烟路径（`npm run dev`，供人工复核）：dev 启动自动同步种子 → 侧栏末位「UI 岛 Hello」→ 进入 UiIslandView（iframe `sk-plugin://sk-ui-hello/dist/index.html`）→ 页内状态行显示桥已连接/token 握手成功；依次验证：① Storage 按钮 → 命名空间内写读回显成功；② Toast → 宿主右上角 toast；③ 事件→宿主 → 宿主订阅 `${pluginId}:*` 收到并 toast；④ 宿主侧「宿主→岛事件」按钮 → 岛内 `sk:host-ping` 状态行 +1；⑤ 越权·剪贴板/对话框 → 岛内捕获 `PluginPermissionError` 标红 denied，宿主「设置 → 插件」审计环可查两条拒绝；⑥ 深浅主题切换 → 岛内 `--wb-*` 令牌经 MutationObserver 跟随。

**P2 验证结论（2026-09-07 回写）**

- 交付物：`pluginManager.ts`——`overview()` 并入 UI 岛（source `external` + `kind:'ui'` + trustLevel 2，行 state 合成 loaded/disabled）；启停复用统一停用集 `disabled`（`setPluginEnabled` 岛分支增删 + 合成 state 广播、`activate` 对停用岛拒绝、`sortedMetas`/`isEnabled` 读点判定）→ 侧栏/⌘K/管理面板三处一致；`uninstallExternal` 岛分支（移除登记与停用标记 → IPC 删目录 → 合成 inactive 广播）；`registerUiIsland` 幂等 + **同 id 版本变更重建 manifest/权限门面**（市场更新即时生效）；`notifyHostState` 仅广播宿主状态监听（无 bus 事件，沙箱插件不可感知伪生命周期）。`AppShell.vue`——`onStateChange` 首行 `pm.isUiIsland(id) → refreshMetas()`（注册/启停即时刷新侧栏）；新增 `!pm.has(id)` 分支：卸载后刷新侧栏，若正显示被卸载的岛则 `backFromIsland()`；停用正显示的岛沿用 prev=active 回落（含无可用入口时清 `activeIslandId`）。`PluginCenter.vue`——已安装列表 UI 岛行（徽标「外置 · 视图」warning 软色 + 「iframe 岛」chip + 启停/卸载按钮 + 卸载二次确认；状态文案「已注册 / 已停用(自)」）；Worker 沙箱 chip 改为仅 L2（`kind !== 'ui'`）；市场安装/更新后按 `manager.isUiIsland(id)` 区分 toast（UI 形态包提示侧栏入口就绪）；`toggleBuiltin` 更名 `togglePlugin` 覆盖内建 + 岛。
- ✅ 编译验证（本次会话执行）：`vue-tsc --noEmit -p tsconfig.json` 与 `tsc --noEmit -p tsconfig.electron.json` 均零错误。
- 手工 GUI 冒烟路径（`npm run dev`，供人工复核）：设置 → 插件 → 已安装列表出现「sk-ui-hello · 外置 · 视图 · iframe 岛 · 已注册」（带 storage 能力 chip，越权按钮文案空能力区正常）；① 停用 → 侧栏「UI 岛 Hello」即时消失；若正显示该岛则自动回落到首模块；② 启用 → 侧栏入口恢复；③ 重启 → 停用状态保持（侧栏无该岛、列表显「已停用(自)」）；④ 卸载（二次确认）→ 列表行消失 + `<userData>/plugins/sk-ui-hello` 目录删除；⑤ 市场 tab 若有 UI 形态包 → 安装后侧栏即时出现、版本/能力行内可见、更新按钮可用；⑥ 停用后再次启动应用前经侧栏/⌘K 尝试进入 → toast「已停用」提示。

**P3 验证结论（2026-09-07 回写）**

- 交付物（脚手架）：`scripts/plugin-create.js` 新增 `--ui` 分支（`npm run plugins:create:ui <kebab-id>` → 生成 `ui-plugins/<kebab-id>/` vite 工程，`--install` 仅复制 manifest+dist 到运行时目录）；模板 `scripts/ui-plugin-template/`（`manifest.json` kind `"ui"` + entry `./dist/index.html` + storage capability 占位、`package.json`、`vite.config.mjs`（`base:'./'` + `css.postcss` 空插件阻断宿主 tailwind 向上查找）、`index.html` 自设 CSP、`src/main.js` `window.__sk` 桥演示（onReady/storage/toast/log/bus/越权·剪贴板预期被拒）、`src/style.css` `--wb-*` 令牌消费）。
- 交付物（发布）：`scripts/publish-plugin.js` 支持 UI 包——`kind:"ui"` 判定（拒绝 view/module 等不可市场分发形态）；entry 指向 HTML 且产物必须存在；产物缺失时 `--build` 自动 `npm run build`（先构建后打包）否则报错引导；打包范围仅 `manifest.json + entry 子树`（vite 工程根 dev 入口不混入；通用排除 node_modules/.git + UI 工程 src/package.json 等）；catalog 条目写入 `kind:"ui"`。渲染层/主进程放行：`MarketPluginInfo.kind?: 'extension'|'ui'`（types.ts）、主进程 `sanitizeItem` 白名单放行、`marketClient` 摊平携带、PluginCenter 市场条目「UI 岛」徽标（warning 软色，安装前可见）。
- ✅ 命令行验证（本次会话执行）：① `plugin-create.js --ui sk-ui-starter` → 工程生成（占位符替换正确）；② 宿主 vite 实建 → `dist/` 产出、`index.html` 资源为 `./assets/…` 相对引用（sk-plugin:// 前提）；③ `publish-plugin.js --dir ui-plugins/sk-ui-starter -o market-out` → kind 识别 `ui`、zip 仅 `manifest.json + dist/**`（7 文件）、catalog 条目带 `kind:"ui"`；④ 缺失产物报错分支（工程+package.json 无 build → 通用「entry 不存在」；有 build script 无 `--build` → 引导「先 npm run build」）；⑤ `--build` 自动路径（rm -rf dist → 自动重建再打包）；⑥ zip sha256/目录与主进程 sanitize 语义相容（catalog 放行 kind）。模板构建已消除宿主 tailwind postcss 噪音。
- 手工 GUI 冒烟路径（`npm run dev`，供人工复核）：`node scripts/plugin-create.js --ui sk-ui-hello2 --install`（先 `npm run build`）→ 重启应用侧栏出现新岛（kind ui）→ 「设置 → 插件」启停/卸载新岛正常；或将 `scripts/ui-plugin-template` 复制成临时工程、构建后发布到本地市场 → 市场列表条目带「UI 岛」徽标 → 安装后侧栏入口即时出现。（原示例 `ui-plugins/sk-ui-starter` 已于 2026-09-24 删除。）

### 15.7 风险与待决策

- **excel-copy（TV模版）不宜直迁首期**：它深度依赖宿主 `@/lib/templateEngine`、`@/core/services/excel` 与主进程 Excel 解析，市场化前需先把宿主依赖收敛为“桥能力”（excel 解析做成宿主桥方法），属后续专项；首期试点选新轻量 demo。
- 待决策：信任级别命名与徽标文案；UI 岛双防线大小阈值（§15.4 建议单资源 ≤16MB / 目录 ≤32MB）是否随协议分层落地待评估。
- **可选增强（非必须，不构成安全缺口）**：安装确认 UI（市场安装前 capabilities 预览：storage 命名空间 / http URL 前缀 / clipboard 等展示 + 确认）。判断依据：安全底线已由**强制代码隔离**（L2 Worker 沙箱 / UI 岛 iframe 独立 realm）+ **权限门逐次判定**（manifest 未声明即拒 + `auditDenied` 事后审计，PluginCenter「已安装」页可见）+ **主进程防线**（sanitizeItem / sha256 / zip-slip / manifest 一致性）闭环，恶意插件即使被安装也无法越权；capabilities 真实值安装后由落盘 manifest 解析展示，**不依赖 catalog**。该 UI 仅补齐"装前知情/信任决策"，属 UX 层。**触发条件（满足任一再做）**：① 市场对外开放、出现第三方作者（来源不再可信）；② 出现申请高危能力（shell / 剪贴板写 / 任意 http 前缀）的插件；③ 对外发布需合规审查或收到"装完才知道要权限"反馈。落地形态（届时约半小时级）：`publish-plugin.js` catalog 条目带 capabilities（从 manifest 提取）→ `MarketPluginInfo.capabilities` + 主进程 `sanitizeItem` 白名单净化（可选：安装时比对 catalog 声明与 zip 内 manifest 一致性，防少报）→ PluginCenter 市场行「安装/更新」先弹确认面板（capability→人话映射 + 敏感度标记，无声明显示"未声明→受限能力全拒"低风险）→ 确认后落盘。
