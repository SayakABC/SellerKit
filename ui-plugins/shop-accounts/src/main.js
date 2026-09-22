// src/main.js — 岛入口：挂载店铺账号管家主视图。
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css';
import App from './App.vue';
import { watchTheme } from './theme.js';

createApp(App).use(createPinia()).mount('#app');

// 主题令牌由宿主在 boot/切换时以内联样式注入，color-scheme 需岛内自行跟随
watchTheme();
