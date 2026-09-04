// extensions/order-insight/src/settings.ts
// 订单归类插件的设置面板贡献入口（单面板、无二级 Tab 条，直接渲染引擎设置组件）。
import type { PluginSettingsModule } from '@/core/plugin/sdk';
import EngineSettings from './components/EngineSettings.vue';

export const settingPanels: PluginSettingsModule['settingPanels'] = [
  {
    categoryId: 'order-insight',
    categoryName: '订单归类',
    icon: 'sparkles',
    order: 20,
    tabs: [{ tabId: 'engine', label: '引擎设置', component: EngineSettings }],
  },
];

export default { settingPanels };
