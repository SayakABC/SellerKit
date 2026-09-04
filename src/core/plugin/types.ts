// src/core/plugin/types.ts
// 插件体系核心类型（Phase 1：内建插件宿主侧；Phase 3：权限门 + 外置插件）
// 约束：进程无关纯类型定义，不依赖 Vue / Electron / 业务模块类型，便于后续平移至 packages/core。

/** 插件生命周期状态（参考 PLUGIN_ARCHITECTURE §5.4） */
export type PluginState =
  | 'installed'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'disabled'
  | 'error'
  | 'uninstalled';

/** 懒激活声明；命中前仅注册静态贡献（侧栏/⌘K 可见），命中才 activate() */
export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onView:${string}`
  | `onEvent:${string}`
  | `onSettings:${string}`;

/** 插件来源：内建（随宿主分发，Level 0 可信） / 外置（用户目录安装，Level 1，权限门受限） */
export type PluginSource = 'builtin' | 'external';

/**
 * 受权限门约束的能力域（§9 分级模型）。
 * 外置插件必须在此声明要使用的能力；未声明的调用会被门拒绝并写入审计日志。
 * 说明：ui/env 为轻量/只读能力，默认放行，不设门。
 */
export type CapabilityId = 'storage' | 'http' | 'clipboard' | 'dialog';

/** 单个能力声明（manifest.capabilities 元素） */
export interface PluginCapability {
  /** 能力域（见 CapabilityId） */
  id: CapabilityId;
  /** 动作白名单；省略 = 该域全部动作放行（如 clipboard.write / dialog.openFile 等） */
  actions?: string[];
  /** storage 命名空间白名单；省略 = 仅放行插件自身命名空间 modules.<pluginId> */
  namespaces?: string[];
  /** http 允许的 URL 前缀白名单；省略 = 禁止任何请求；支持尾部 * 通配（如 https://api.example.com/*） */
  allow?: string[];
}

/** 插件声明式元信息（manifest v1 子集；Phase 1 由内建模块 meta 生成） */
export interface PluginManifest {
  /** 全局唯一 kebab-case id（内建插件 = 模块 id） */
  name: string;
  displayName: string;
  version: string;
  /** Host API 版本契约；Phase 1 固定为项目版本语义 */
  engines: { sellerkit: string };
  /** 懒激活声明：onStartup = 宿主启动即激活（内建插件默认） */
  activationEvents: ActivationEvent[];
  /** 静态声明贡献（视图/设置等）；带函数的能力（命令）在 activate 内动态注册 */
  contributes?: Partial<Record<ContributionType, unknown[]>>;
  /** 外置插件展示信息（内建忽略） */
  description?: string;
  author?: string;
  /** 外置插件入口文件（相对插件目录，默认 ./index.js） */
  entry?: string;
  /** 能力声明；内建插件（Level 0）恒放行，外置插件（Level 1）缺省 = 全部拒绝 */
  capabilities?: PluginCapability[];
}

/** 贡献点类型（宿主定义的扩展槽位） */
export type ContributionType =
  | 'commands'
  | 'views'
  | 'settings'
  | 'menus'
  | 'statusBar'
  | 'themes'
  | 'contextMenus'
  | 'dataProviders';

/** 视图贡献：宿主左侧导航 + 视图切换消费（对应现有 ModuleMeta/侧栏渲染） */
export interface ViewContribSpec {
  /** 插件作用域内本地 id；全局 id 由注册表拼接 <plugin>.<id> */
  id: string;
  title: string;
  icon?: string;
  order?: number;
  /** true 时不出现在侧栏与 ⌘K 切换列表（仍可被跨模块跳转激活），对应 ModuleMeta.navHidden */
  navHidden?: boolean;
  /** host=Vue 组件直渲（Level 0 内建）；webview/declared 留给 Phase 3+ 外置插件 */
  container: 'host' | 'webview' | 'declared';
}

/** 命令贡献：供 ⌘K 命令面板消费（结构对齐 ModuleCommand，注册时以 spec 承载） */
export interface CommandContribSpec {
  id: string;
  title: string;
  /** ⌘K 分组显示顺序（升序，缺省 0；同值按注册序稳定） */
  order?: number;
  /** 仅展示用快捷键提示，不绑定全局事件 */
  shortcut?: string;
  run: () => void | Promise<void>;
}

/** 设置项贡献：Phase 2 接入 SettingsModal */
export interface SettingContribSpec {
  id: string;
  category: string;
  tab?: string;
  key: string;
  /** 分类/分组内显示顺序（升序，缺省 0） */
  order?: number;
  type: 'string' | 'number' | 'boolean' | 'select' | 'list';
  label: string;
  default?: unknown;
  options?: { label: string; value: string }[];
}

/** 注册表中的一条贡献 */
export interface Contribution<S = unknown> {
  type: ContributionType;
  /** 宿主填充（来源插件 id），不可伪造 */
  plugin: string;
  /** 全局唯一 id：<plugin>.<localId>，冲突由注册表拒绝 */
  id: string;
  spec: S;
}
