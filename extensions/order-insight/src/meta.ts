// extensions/order-insight/src/meta.ts
// 「订单归类」模块元信息：id 与目录名一致（kebab-case），name 为用户可见名。

import type { ModuleMeta } from '@/core/types';

export const meta: ModuleMeta = {
  id: 'order-insight',
  name: '订单归类',
  icon: 'box',
  order: 3,
};
