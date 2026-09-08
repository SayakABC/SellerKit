// vite.config.mjs — UI 岛工程构建配置
// 关键点：base 必须为 './'。产物经 sk-plugin:// iframe（特权只读协议）加载，
// 绝对路径 /assets/… 会 404；相对引用 './assets/…' 才能命中。
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // UI 岛工程自包含：阻断 vite 向上查找宿主根 postcss.config.js / tailwind（会带入无关警告与处理）
  css: { postcss: { plugins: [] } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // UI 岛包含 manifest + dist，产物体积建议保持在 2MB 内（宿主对包入口目录有上限约束）
  },
});
