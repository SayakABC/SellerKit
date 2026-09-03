import type { ModuleMeta } from '@/core/types';

// 最小业务模块示例 —— 证明「新增一个模块 = 建文件夹 + 在 modules.config.ts 登记」
// 行为完全独立，仅依赖 core 基础能力层（storage / toast），不触碰其他模块。
export const meta: ModuleMeta = {
  id: 'quick-note',
  name: '便签',
  icon: 'note',
  order: 2,
};
