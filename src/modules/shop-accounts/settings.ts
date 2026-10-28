// src/modules/shop-accounts/settings.ts
// 「账号管家」设置贡献（宿主设置中心分类 `shop-accounts:settings`）。
//
// 来源：2026-10-14 该功能由 UI 岛回收为内建模块，设置内容随之从「岛产物 settings.html + iframe 岛」
// 改为**宿主组件**（不再需要 iframe / 受控桥）。安全设置（本机加密可用性 / 隐私模式）与岛内版本
// 是**同一份实现**。
//
// ⚠️ 2026-10-17：原第二个页签「邮件收件箱」随「邮件」独立成一级模块搬去 `mail:settings`
//    （见 `src/modules/mail/settings.ts`）。这里只剩安全设置 —— 本分类管的是**账号库在这台机器上的
//    存储安全**，与收件箱的轮询/缓存无关，两者本就不该挂在同一个名字下。
// ⚠️ 分类 id 仍是 `shop-accounts:settings`：模块 id 是存储/路由键（同 meta.ts 的说明），不改。
import type { SettingPanelDef } from '@/core/plugin/sdk';
import SecuritySettings from './components/SecuritySettings.vue';

export const settingPanels: SettingPanelDef[] = [
  {
    categoryId: 'shop-accounts:settings',
    categoryName: '账号管家',
    icon: 'key',
    order: 50,
    tabs: [{ tabId: 'security', label: '安全设置', component: SecuritySettings }],
  },
];
