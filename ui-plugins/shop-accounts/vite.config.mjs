// vite.config.mjs — 店铺账号管家 UI 岛构建配置
// base 必须 './'：产物经 sk-plugin:// iframe 加载，绝对路径会 404。
// 本岛复用原内建插件（extensions/shop-accounts）的 Vue 源码，宿主服务（@/core/services/*）
// 统一换成本岛桥实现（见 src/api.js / src/storage.js）。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  root: r('.'),
  plugins: [vue()],
  // UI 岛工程自包含：阻断 vite 向上查找宿主根 postcss/tailwind 配置
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      '@/core/services/ipc': r('./src/api.js'),
      '@/core/services/clipboard': r('./src/api.js'),
      '@/core/services/toast': r('./src/api.js'),
      '@/core/services/storage': r('./src/storage.js'),
      // 类型专用桩：源码为 TS，import type 在构建期被擦除，此处仅提供可解析目标
      '@/types': r('./src/types.js'),
      '@/core/types': r('./src/types.js'),
      '@/core/plugin/sdk': r('./src/types.js'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    // 多入口：index = 主视图岛（manifest.entry）；settings = 设置页岛（manifest.settings.entry，
    // 由宿主设置中心 iframe 承载）。两者共用同一套 src 与受控桥。
    rollupOptions: {
      input: {
        index: r('./index.html'),
        settings: r('./settings.html'),
      },
    },
  },
});
