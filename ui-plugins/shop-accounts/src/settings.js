// src/settings.js — 岛设置页入口（宿主设置中心承载）。
//
// 背景（2026-09-18）：设置从岛内页签搬到宿主设置中心——manifest.settings.entry 指向本页产物
// （./dist/settings.html），宿主 SettingsModal 以 iframe 岛加载，与主视图共用同一 __sk 受控桥
// （同一 capability 白名单，无新增权限）。本入口只挂载设置面板，不渲染业务视图。

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import SettingsView from './SettingsView.vue';
import { watchTheme } from './theme.js';

createApp(SettingsView).use(createPinia()).mount('#app');

// 主题令牌由宿主在 boot/切换时以内联样式注入，color-scheme 需岛内自行跟随
watchTheme();
