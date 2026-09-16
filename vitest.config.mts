import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// 单元测试覆盖两类目标：
//   1. src/lib/ 纯函数层——无 DOM、无 IPC、无副作用；
//   2. electron/ipc-util.ts 的 IPC 注册契约——用 vi.mock 假 ipcMain，不启动 Electron。
// 两者都不需要 vue 插件，也不需要 jsdom，故 environment 用 node，跑得又快又稳。
// 组件 / Pinia store / 主进程业务逻辑 / 插件沙箱仍走手工冒烟（scripts/*-smoke.*）与手动流程回归。
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
