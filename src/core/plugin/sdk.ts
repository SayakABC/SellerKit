// src/core/plugin/sdk.ts
// 插件 SDK 形态（Phase 2：SDK + Host API 收敛）。
// 目标对齐 PLUGIN_ARCHITECTURE §7/§8：面向插件开发者的编程面。
// 约束：进程无关的纯类型 + 轻量组合器（definePlugin），不依赖 Vue / Electron / 业务模块；
//       仅依赖 core 内核类型（types/eventBus），后续整体平移 packages/sdk。
// 说明：当前内建插件仍以 ModuleDefinition 形态经 adapter 激活，本文件提供的 SDK 形态
//       供插件（及未来外置插件）逐步换用 ctx.host.*，旧通道保留兼容别名。

import type { EventBus } from './eventBus';
import { PluginEvents } from './eventBus';
import type {
  CommandContribSpec,
  ContributionType,
  PluginManifest,
  SettingContribSpec,
  ViewContribSpec,
} from './types';

export { PluginEvents };

/** 带前缀的插件日志器（宿主在创建 ctx 时注入，打印带 [plugin:<id>] 前缀） */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 插件 HTTP 请求选项（渲染层实现基于 core/network 的默认 axios 实例） */
export interface PluginHttpOptions {
  timeout?: number;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 打开文件对话框的选项（渲染层收敛现有 selectExcel/selectTemplate/selectDirectory） */
export type DialogKind = 'excel' | 'template' | 'directory';

export interface DialogOptions {
  kind: DialogKind;
}

/** 文件对话框结果（kind=directory 仅返回路径；excel/template 附带内容载荷） */
export interface FilePayload {
  kind: DialogKind;
  filePath: string;
  data?: ArrayBuffer;
  content?: string;
}

/**
 * Host API（能力面）：宿主暴露给插件的能力端口。
 * Phase 2 只收敛渲染层六域（storage/clipboard/http/dialog/ui/env）；
 * db/excel/fs 等主进程域到 Phase 3 与权限门一起引入。
 */
export interface HostApi {
  /** 命名空间持久化：→ modules.<ns>（复用 electron-store 命名空间，模块互不污染） */
  storage: {
    load<T = unknown>(ns: string): Promise<T | undefined>;
    save<T>(ns: string, v: T): Promise<void>;
    clear(ns: string): Promise<void>;
  };
  clipboard: {
    /** 写剪贴板；失败 reject（不吞错），由插件侧 try/catch 处理 */
    writeText(text: string): Promise<void>;
  };
  /** 网络请求（渲染层经 IPC adapter → Electron net，规避 CORS）；成功返回响应体 data */
  http: {
    get<T = unknown>(url: string, opts?: PluginHttpOptions): Promise<T>;
    post<T = unknown>(url: string, body?: unknown, opts?: PluginHttpOptions): Promise<T>;
  };
  dialog: {
    openFile(opts: DialogOptions): Promise<FilePayload | null>;
  };
  /** UI 能力：打开设置（可定位）与轻提示 */
  ui: {
    openSettings(category?: string, tab?: string): void;
    notify(o: { kind: 'success' | 'error' | 'info'; text: string }): void;
  };
  env: {
    isMac: boolean;
    platform: string;
    version: string;
  };
}

/** 动态贡献注册便捷层：自动拼接 <plugin>.<localId> 全局 id，返回注销函数 */
export interface ContributionRegistrar {
  register<T = unknown>(type: ContributionType, id: string, spec: T): () => void;
  registerCommand(spec: CommandContribSpec): () => void;
  registerView(spec: ViewContribSpec): () => void;
  registerSetting(spec: SettingContribSpec): () => void;
}

/** 插件命名空间存储：key 级 API（底层落 modules.<pluginId>，key 为对象字段） */
export interface PluginKeyValueStorage {
  load<T = unknown>(key: string): Promise<T | undefined>;
  save<T>(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

/** 插件上下文：宿主在 activate/deactivate 时构造注入（信任级别见 §9 分级模型） */
export interface PluginContext {
  manifest: PluginManifest;
  /** 0=内建可信；1=本机外置；2=第三方（沙箱）——当前内建恒为 0 */
  trustLevel: 0 | 1 | 2;
  /** 事件总线：经桥转发；插件间仅以事件通信 */
  bus: EventBus;
  /** 动态注册贡献点；注册进宿主注册表并随 deactivate 自动注销 */
  contributions: ContributionRegistrar;
  /** 宿主能力面（§7），已按 manifest 能力收敛 */
  host: HostApi;
  /** 插件专属命名空间持久化（modules.<pluginId>），key 为对象字段 */
  storage: PluginKeyValueStorage;
  log: PluginLogger;
  /** deactivate/卸载时中止（释放长任务/定时器） */
  abort: AbortSignal;
}

/** 插件生命周期钩子（SDK 形态；与 ModuleLifecycle 同语义，ctx 由宿主注入） */
export interface PluginLifecycle {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

/** 插件模块（SDK 形态） */
export interface PluginModule {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

/**
 * definePlugin：组合 manifest 与生命周期，产出 SDK 形态插件模块。
 * 内建模块当前经 BuiltinPluginAdapter 激活（ModuleDefinition 兼容别名，旧通道保留）；
 * 本函数面向 SDK 编程模型（§8），供新插件与未来外置插件书写入口。
 */
export function definePlugin(manifest: PluginManifest, lifecycle: PluginLifecycle): PluginModule {
  return { manifest, ...lifecycle };
}

/**
 * 设置页面板 Tab：携带 Vue 组件引用。
 * 仅宿主侧随包分发的视图插件（trustLevel 0 / kind=view）可用；后台/Worker 插件无组件能力。
 */
export interface SettingTabDef {
  /** Tab id（open-settings dispatch 的 tab 定位值） */
  tabId: string;
  label: string;
  /** Vue 组件（默认 export 的 SFC） */
  component: unknown;
}

/** 设置页分类面板贡献（随宿主分发视图插件的注册式设置面板；SettingsModal 分类导航按贡献生成） */
export interface SettingPanelDef {
  /** 设置分类 id（SettingsModal 分类导航 key；open-settings dispatch 的 category） */
  categoryId: string;
  categoryName: string;
  icon?: string;
  /** 分类排序（越小越靠前；general=0、插件面板默认 100、plugins=999） */
  order?: number;
  /** Tab 列表：长度 >1 渲染二级 Tab 条；=1 时直接渲染该组件（无 Tab 条） */
  tabs: SettingTabDef[];
}

/** 插件包设置入口模块（registry 的 settingsPanelLoaders 指向该模块，default 导出本结构） */
export interface PluginSettingsModule {
  settingPanels: SettingPanelDef[];
}
