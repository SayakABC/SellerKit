import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// 单元测试只覆盖「纯函数层」（src/lib）：无 DOM、无 IPC、无副作用，
// 因此不需要 vue 插件、不需要 jsdom 环境，跑得又快又稳。
// 组件/集成层面的验证仍走手工冒烟脚本（scripts/*-smoke.*）与手动流程回归。
export default defineConfig({
  resolve: {
    alias: {
      // 与 tsconfig.json 的 paths 保持一致：src/lib 内部用 '@/types'
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // 夹具里的日期断言依赖本地时区行为（parseDate 走 new Date + setDate），
    // 固定时区可避免 CI/他机因 TZ 不同而漂移
    env: { TZ: 'Asia/Shanghai' },
    reporters: ['default'],
  },
});
