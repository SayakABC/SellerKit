// src/modules/today/mangoOpen.ts
// 「去芒果把单抓回来」这个动作的**唯一实现**（T2-5）。
//
// 为什么要有它：空态（0 单）光说"没有单"是不够的 —— 用户看完还是不知道下一步做什么，
// 只能自己开浏览器、登芒果、找到待发货列表、再点采集。这条路径每多一步，早上就多一次放弃。
// 所以空态给一个按钮，点了直接把**那个页面**打开（Chrome 优先，扩展装在那里）。
//
// 三个约定：
//   ① **打开的是「待发货」筛选页**，不是芒果首页 —— 首页还要再找菜单，等于没帮上忙；
//   ② URL 里的「正常/normal」是芒果的**状态筛选段**（扩展就是在这个筛选下抓的）。
//      改了它，打开的就是另一个列表，而用户看到的仍然是"芒果"，不会察觉错了；
//   ③ 打开失败**必须说出来**：这一步失败的唯一表现就是"没反应"，不给原因等于让人再点几次。
import { openExternal } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';

/**
 * 芒果店长的待发货列表（筛选段 `status/正常/normal`）。
 *
 * ⚠️ 与扩展侧抓取用的筛选**同源**（`SellerKitExtensions` 的 mango 采集）；M5 的开机调度
 * 也要打开同一个地址 —— 那时把它挪到主进程共用，别各写一份（写歪了不会报错，只会抓到另一个列表）。
 */
export const MANGO_PENDING_URL = 'https://www.mangoerp.com/erp/#/erp/order/list/search/status/正常/normal';

/**
 * 打开芒果待发货页。成功返回 `true`（便于冒烟断言"点了真发了 IPC"）；
 * 失败已经把原因 toast 出来，调用方不必再提示一遍。
 */
export async function openMangoPending(): Promise<boolean> {
  try {
    const r = await openExternal(MANGO_PENDING_URL);
    if (r.success) return true;
    toast(`没能打开芒果待发货页面：${r.error || '系统拒绝了这次打开'}`, 'error');
    return false;
  } catch (e: unknown) {
    toast(`没能打开芒果待发货页面：${e instanceof Error ? e.message : '未知错误'}`, 'error');
    return false;
  }
}
