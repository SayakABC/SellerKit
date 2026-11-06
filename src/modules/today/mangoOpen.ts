// src/modules/today/mangoOpen.ts
// 「去芒果把单抓回来」这个动作的**唯一实现**（T2-5，2026-11-05 扩成两个列表）。
//
// 为什么要有它：空态（0 单）光说"没有单"是不够的 —— 用户看完还是不知道下一步做什么，
// 只能自己开浏览器、登芒果、找到待发货列表、再点采集。这条路径每多一步，早上就多一次放弃。
// 所以空态给一个按钮，点了直接把**那个页面**打开（Chrome 优先，扩展装在那里）。
//
// 三个约定：
//   ① **打开的是筛选后的列表页**，不是芒果首页 —— 首页还要再找菜单，等于没帮上忙；
//   ② URL 里的筛选段（`status/正常/normal` / `status/已发货/delivered`）决定打开哪个列表。
//      改错它，打开的就是另一个列表，而用户看到的仍然是"芒果"，不会察觉错了；
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
 * 芒果店长的**已发货**列表（筛选段 `status/已发货/delivered`）。
 *
 * 来源：用户 2026-11-06 从浏览器地址栏直接提供，**不是猜的**。
 * 此前 S2 之所以没做这个入口，就是因为这一段的段名没有实证 —— 见
 * `docs/notes/2026-11-02-mango-frame-contract.md`。现在有了。
 *
 * 两处仍然**没有实证**（第一次真跑必须核对，见下方 `openMangoShipped` 的注释）：
 *   ① 这个页面是否也调 `/erp/order/data/search.json`（扩展的 hook 只认这一个路径）；
 *   ② 如果调，`phase` 参数是不是 `order`（扩展只抓 `phase` 为空或 `order` 的请求）。
 * 任一条不成立，扩展在那一页**抓不到任何东西，而且不报错**。
 *
 * 编码形态：这里是**百分号编码**（`%E5%B7%B2...` = 已发货），与上一条的原样中文不同 ——
 * 因为两个字符串分别来自"此前实测可用"与"本次用户提供的原文"，两种形态浏览器都认。
 * **别为了统一去改其中一个**：改错了不报错，只是悄悄打开另一个列表。
 */
export const MANGO_SHIPPED_URL =
  'https://www.mangoerp.com/erp/#/erp/order/shipment/search/status/%E5%B7%B2%E5%8F%91%E8%B4%A7/delivered';

/**
 * 打开一个芒果列表页。成功返回 `true`（便于冒烟断言"点了真发了 IPC"）；
 * 失败已经把原因 toast 出来，调用方不必再提示一遍。
 *
 * 抽成一份的原因：两个入口的失败处理必须**说得一样清楚**（`.success` 为假 / 抛异常 / 系统拒绝
 * 三种都要有话说）。各写一份的下场是其中一个漏掉某条分支，而漏掉的那条恰好是"没反应"。
 */
async function openMangoPage(url: string, what: string): Promise<boolean> {
  try {
    const r = await openExternal(url);
    if (r.success) return true;
    toast(`没能打开芒果${what}页面：${r.error || '系统拒绝了这次打开'}`, 'error');
    return false;
  } catch (e: unknown) {
    toast(`没能打开芒果${what}页面：${e instanceof Error ? e.message : '未知错误'}`, 'error');
    return false;
  }
}

/** 打开芒果待发货页（`order/list`，采集入口用它）。 */
export function openMangoPending(): Promise<boolean> {
  return openMangoPage(MANGO_PENDING_URL, '待发货');
}

/**
 * 打开芒果**已发货**页（`order/shipment`，收发货回执入口用它）。
 *
 * 注意它**不负责收数据**：采集是扩展在那一页自动做的（和待发货页同一个机制）。
 * 这个函数只解决"用户得先到那一页"这一步。
 */
export function openMangoShipped(): Promise<boolean> {
  return openMangoPage(MANGO_SHIPPED_URL, '已发货');
}
