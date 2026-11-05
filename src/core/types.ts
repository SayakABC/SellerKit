// 模块契约类型定义
//
// 业务模块分为两层文件，保证「侧栏渲染」与「视图加载」解耦：
// - meta.ts   导出轻量元信息 meta（id/name/icon/order），被用于左侧导航，体积可忽略
// - index.ts  默认导出 ModuleDefinition（含视图与可选的命令/生命周期），由注册表在模块激活时才动态 import
//
// Phase 2：ModuleDefinition/ModuleLifecycle 作为 SDK（definePlugin）的兼容别名保留。
// 钩子的 ctx 由插件管理器注入（HostApi 等能力面见 plugin/sdk），仅 type import，无运行时依赖。

import type { PluginContext } from './plugin/sdk';

export type ModuleIcon =
  | 'table'
  | 'tool'
  | 'box'
  | 'chart'
  | 'sparkles'
  | 'settings'
  | (string & {});

export interface ModuleMeta {
  id: string;
  name: string;
  icon?: ModuleIcon;
  order?: number;
  /**
   * 所属侧栏一级分组 id（见 `src/core/nav.ts` 的 `NAV_GROUPS`）。
   * 有值时不作为一级入口平铺，而是渲染为该分组下的缩进子项；
   * 分组 id 未登记时按"无分组"处理（不会让入口消失）。
   */
  parent?: string;
  /**
   * 本模块有**二级菜单**（侧栏里点进来后展开若干缩进项）。
   *
   * ⚠️ 这里**只放一个布尔**，不放菜单内容 —— 内容由模块在运行时上报（`services/subNav.ts`），
   * 因为项名旁边的徽标（未归一的店名数 / 缺进价的款数）是算出来的实时值，抄进 meta 就是两处维护。
   * 这个布尔唯一的用途：**模块还没打开过**时侧栏也画得出展开箭头（否则第一次见它的人
   * 不知道里面还有东西）。真正渲染子项要求模块已激活并上报过。
   */
  subNav?: boolean;
  /** true 时不出现在左侧导航与 ⌘K 切换列表（仍打包、仍可被跨模块跳转激活），如模块已有宿主入口的场景 */
  navHidden?: boolean;
}

/** 模块命令：供 ⌘K 命令面板调用（Phase 2 接入） */
export interface ModuleCommand {
  id: string;
  /** 命令面板中显示的标题 */
  title: string;
  /** ⌘K 分组显示顺序（升序，缺省 0；同值按注册序稳定） */
  order?: number;
  /** 仅展示用的快捷键提示，不绑定全局事件 */
  shortcut?: string;
  run: () => void | Promise<void>;
}

/** 模块激活 / 停用生命周期钩子（Phase 2 接入；ctx 兼容别名，旧无参钩子形态仍可用） */
export interface ModuleLifecycle {
  /** 模块被切换到前台时调用（视图挂载后）；ctx 由插件管理器注入（SDK 优先，无参旧形态兼容） */
  activate?: (ctx: PluginContext) => void | Promise<void>;
  /** 模块被切离前台时调用（视图卸载前），用于释放资源、关闭弹窗等 */
  deactivate?: (ctx: PluginContext) => void | Promise<void>;
}

/** 模块定义：注册表动态 import 后得到的默认导出 */
export interface ModuleDefinition extends ModuleLifecycle {
  meta: ModuleMeta;
  /** 模块主视图组件 */
  view: unknown;
  /** 该模块暴露给命令面板的命令（可选） */
  commands?: ModuleCommand[];
}
