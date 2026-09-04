// extensions/excel-copy/src/settings.ts
// TV模版插件的设置面板贡献入口（随宿主分发视图插件 → 宿主注册式渲染，SettingsModal 分类导航按此生成）。
// 依赖说明：组件与 store 同处于本插件包 src/，经相对路径引用；宿主类型经 @/core/plugin/sdk 引用。
import type { PluginSettingsModule } from '@/core/plugin/sdk';
import TemplateManager from './components/TemplateManager.vue';
import FieldRuleManager from './components/FieldRuleManager.vue';
import ColumnSelector from './components/ColumnSelector.vue';

export const settingPanels: PluginSettingsModule['settingPanels'] = [
  {
    categoryId: 'excel',
    categoryName: 'TV模版',
    icon: 'table',
    order: 10,
    tabs: [
      { tabId: 'template', label: '模板配置', component: TemplateManager },
      { tabId: 'rules', label: '字段规则', component: FieldRuleManager },
      { tabId: 'columns', label: '显示列', component: ColumnSelector },
    ],
  },
];

export default { settingPanels };
