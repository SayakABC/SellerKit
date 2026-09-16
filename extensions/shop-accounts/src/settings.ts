// extensions/shop-accounts/src/settings.ts
// 「店铺账号管家」设置面板贡献入口（设置 → 账号安全）。
import type { PluginSettingsModule } from '@/core/plugin/sdk';
import SecuritySettings from './components/SecuritySettings.vue';
import MailSettingsPanel from './components/MailSettingsPanel.vue';

export const settingPanels: PluginSettingsModule['settingPanels'] = [
  {
    categoryId: 'shop-accounts',
    categoryName: '店铺账号',
    icon: 'key',
    order: 30,
    tabs: [
      { tabId: 'security', label: '存储与安全', component: SecuritySettings },
      { tabId: 'mail', label: '邮件收件箱', component: MailSettingsPanel },
    ],
  },
];

export default { settingPanels };
