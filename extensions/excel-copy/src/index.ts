import ExcelCopyView from './ExcelCopyView.vue';
import { setClipboardHost, useExcelCopyStore } from './store';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';
import type { PluginContext } from '@/core/plugin/sdk';

// 模块定义：注册表动态 import 后得到的默认导出。
// - view：模块主视图
// - commands：暴露给 ⌘K 命令面板的动作（复用 store 已有公共方法，行为不变）
// - activate(ctx)：Phase 2 示范 —— 插件管理器注入 ctx，宿主能力面（ctx.host）在此交接给 store，
//   剪贴板写入路径随之收敛到 ctx.host.clipboard（未激活/回退仍走旧通道兼容别名）
// - deactivate：切离模块时解除 host 绑定并关闭可能打开的弹窗（资源释放示例）
const definition: ModuleDefinition = {
  meta,
  view: ExcelCopyView,
  commands: [
    {
      id: 'import-excel',
      title: '导入 Excel 文件',
      shortcut: '⌘O',
      run: () => useExcelCopyStore().selectExcelFile(),
    },
    {
      id: 'reprocess-rules',
      title: '重新执行字段规则',
      run: () => useExcelCopyStore().reprocessRules(),
    },
    {
      id: 'reset-all',
      title: '重置所有使用状态',
      run: () => useExcelCopyStore().resetAll(),
    },
  ],
  activate: (ctx: PluginContext) => {
    setClipboardHost(ctx.host);
  },
  deactivate: () => {
    setClipboardHost(null);
    const s = useExcelCopyStore();
    s.showTemplateManager = false;
    s.showRuleManager = false;
  },
};

export default definition;
