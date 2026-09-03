// 模块契约类型定义
//
// 业务模块分为两层文件，保证「侧栏渲染」与「视图加载」解耦：
// - meta.ts   导出轻量元信息 meta（id/name/icon/order），被用于左侧导航，体积可忽略
// - index.ts  默认导出 ModuleDefinition（含视图与可选的命令/生命周期），由注册表在模块激活时才动态 import

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
  /** true 时不出现在左侧导航与 ⌘K 切换列表（仍打包、仍可被跨模块跳转激活），如模块已有宿主入口的场景 */
  navHidden?: boolean;
}

/** 模块命令：供 ⌘K 命令面板调用（Phase 2 接入） */
export interface ModuleCommand {
  id: string;
  /** 命令面板中显示的标题 */
  title: string;
  /** 仅展示用的快捷键提示，不绑定全局事件 */
  shortcut?: string;
  run: () => void | Promise<void>;
}

/** 模块激活 / 停用生命周期钩子（Phase 2 接入） */
export interface ModuleLifecycle {
  /** 模块被切换到前台时调用（视图挂载后） */
  activate?: () => void | Promise<void>;
  /** 模块被切离前台时调用（视图卸载前），用于释放资源、关闭弹窗等 */
  deactivate?: () => void | Promise<void>;
}

/** 模块定义：注册表动态 import 后得到的默认导出 */
export interface ModuleDefinition extends ModuleLifecycle {
  meta: ModuleMeta;
  /** 模块主视图组件 */
  view: unknown;
  /** 该模块暴露给命令面板的命令（可选） */
  commands?: ModuleCommand[];
}
