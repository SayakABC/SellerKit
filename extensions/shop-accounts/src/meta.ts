// extensions/shop-accounts/src/meta.ts
// 「店铺账号管家」模块元信息：id 与目录名一致（kebab-case），name 为用户可见名。

import type { ModuleMeta } from '@/core/types';

export const meta: ModuleMeta = {
  id: 'shop-accounts',
  name: '店铺账号管家',
  icon: 'key',
  order: 5,
};
