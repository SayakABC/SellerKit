import ExcelCopyView from './ExcelCopyView.vue';
import { useExcelCopyStore } from './store';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义：注册表动态 import 后得到的默认导出。
// - view：模块主视图
// - commands：暴露给 ⌘K 命令面板的动作（复用 store 已有公共方法，行为不变）
// - deactivate：切离模块时关闭可能打开的弹窗（资源释放示例）
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
  deactivate: () => {
    const s = useExcelCopyStore();
    s.showTemplateManager = false;
    s.showRuleManager = false;
  },
};

export default definition;
