// vite.config.mjs — 利润追踪 UI 岛构建配置
// base 必须 './'：产物经 sk-plugin:// iframe 加载，绝对路径会 404。
// 与脚手架模板的差异：本岛复用内建插件的 Vue 源码，面板使用 Tailwind 原子类，
// 因此保留 postcss 管线（本地 tailwind.config.cjs + postcss.config.cjs）。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  root: r('.'),
  plugins: [vue()],
  resolve: {
    alias: {
      // 复用内建插件源码：宿主服务(@/core/services/*)统一换成本岛桥实现（见 src/api.js）
      '@/core/services/ipc': r('./src/api.js'),
      '@/core/services/clipboard': r('./src/api.js'),
      '@/core/services/toast': r('./src/api.js'),
      // 类型专用桩：源码为 TS，import type 会在构建期被擦除，此处仅提供可解析目标
      '@/types': r('./src/types.js'),
      '@/core/types': r('./src/types.js'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
