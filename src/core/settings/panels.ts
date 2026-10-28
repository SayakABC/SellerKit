// src/core/settings/panels.ts
// **宿主自有**的设置面板贡献（与插件包 `extensions/<id>/src/settings.ts` 同一队列、同一形状）。
//
// 为什么留着这个文件（而不是把面板硬编码进 `SettingsModal.vue`）：
//   `AGENTS.md` §1.5 要求"基础分类固定两个（通用 / 插件），其余一律由**设置贡献**动态生成"。
//   宿主自有的设置（不属于任何业务模块，也不该藏在某个可卸载的业务岛里）走这个出口。
//   目前**一条都没有**，但 `vite.config.ts` 按"文件是否存在"生成 `core` loader ——
//   删文件会让生成器少一个键，将来再加还得改构建；留一个空数组是最低成本的稳定形状。
//
// ⚠️ **2026-10-28 删掉了唯一一条贡献「识别 › 识别引擎」**（`RecognitionSettings.vue`）：
//   它配的是云端 VLM 的 provider / model / API Key，而那条识别链自 2026-10-05 起零调用方，
//   用户已决定不接云端模型（判断见 `docs/notes/2026-10-28-classify-local-vision-direction.md`）。
//   留着它的唯一效果是"用户填了 Key、没有任何地方会用它"。
//
// 新增一条宿主设置：写一个面板组件 + 在下面数组里加一项（别再往 SettingsModal 里塞硬编码分类）。

import type { SettingPanelDef } from '@/core/plugin/sdk';

/** 设置分类贡献（按 order 升序渲染；general=0、插件面板默认 100、plugins=999） */
export const settingPanels: SettingPanelDef[] = [];
