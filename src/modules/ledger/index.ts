import LedgerView from './LedgerView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数全部经 `src/core/services/ipc`（ledger 域），分摊只有 `src/lib/ledger.ts` 一份实现。
const definition: ModuleDefinition = {
  meta,
  view: LedgerView,
};

export default definition;
