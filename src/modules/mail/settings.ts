// src/modules/mail/settings.ts
// 「邮件」设置贡献（宿主设置中心分类 `mail:settings`）。
//
// 2026-10-17：邮件独立成一级模块时，这个分类从 `shop-accounts:settings` 的第二个页签
// 搬成独立分类 —— 理由与拆模块同一条：设置与功能同处一个名字下，用户不需要猜
// "收件箱的轮询间隔为什么在账号管家里面"。
//
// ⚠️ 迁移的边界：**设置数据的存储键没变**（`modules.shop-accounts-mail`，见 mailStore.ts），
//    变的只是"在设置中心里挂在哪"。所以老用户打开新分类，看到的仍是他上次设的轮询间隔。
// ⚠️ `MailSettingsPanel` 的 `embedded` 缺省为 true，而 SettingsModal 渲染 tab 组件时显式传
//    `:embedded="true"`，故此处不需要额外包裹卡片外壳（与 2026-10-14 那次一致）。
import type { SettingPanelDef } from '@/core/plugin/sdk';
import MailSettingsPanel from './MailSettingsPanel.vue';

export const settingPanels: SettingPanelDef[] = [
  {
    categoryId: 'mail:settings',
    categoryName: '邮件',
    icon: 'inbox',
    // 排在「账号管家」(order 50) 之后：两个都是"资料类"设置，靠近放。
    order: 55,
    tabs: [{ tabId: 'inbox', label: '收件箱', component: MailSettingsPanel }],
  },
];
