import MailView from './MailView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数全部经 `mailStore`（它再走 core/services/ipc 的 mail-* 通道），本页零新 IPC。
const definition: ModuleDefinition = {
  meta,
  view: MailView,
};

export default definition;
