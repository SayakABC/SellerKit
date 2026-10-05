// src/core/settings/panels.ts
// **宿主自有**的设置面板贡献（与插件包 `extensions/<id>/src/settings.ts` 同一队列、同一形状）。
//
// 为什么要有这个文件（而不是把面板硬编码进 `SettingsModal.vue`）：
//   `AGENTS.md` §1.5 要求"基础分类固定两个（通用 / 插件），其余一律由**设置贡献**动态生成"。
//   宿主自有的设置（如「识别」引擎与密钥）既不是"通用"也不该藏在某个可卸载的业务岛里，
//   所以它按同一套贡献形状注册 —— 由 `vite.config.ts` 生成 loader（键 `core`），
//   `SettingsModal` 照常消费，**不需要改 SettingsModal**。
//
// 新增一条宿主设置：写一个面板组件 + 在下面数组里加一项（别再往 SettingsModal 里塞硬编码分类）。

import type { SettingPanelDef } from '@/core/plugin/sdk';
import RecognitionSettings from './RecognitionSettings.vue';

/** 设置分类贡献（按 order 升序渲染；general=0、这里 10、插件面板默认 100、plugins=999） */
export const settingPanels: SettingPanelDef[] = [
  {
    categoryId: 'recognition',
    categoryName: '识别',
    icon: 'sparkles',
    order: 10,
    tabs: [{ tabId: 'engine', label: '识别引擎', component: RecognitionSettings }],
  },
];