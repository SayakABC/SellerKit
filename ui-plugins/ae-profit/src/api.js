// src/api.js — 岛侧宿主服务适配层。
// 作用：把受控桥（window.__sk.host.*）包装成与内建插件同名的服务函数，
//      使本岛的 Vue 源码沿用内建插件的写法（vite alias 将 @/core/services/* 指向本文件）。
// 来源：源码原为内建视图插件包 extensions/ae-profit/src，已于 2026-09-16 迁入本岛并删除原目录。
// 纪律：一律走桥，不直连 window.electronAPI / 裸 IPC（AGENTS 红线 16）；
//      能力需在 manifest.json 的 capabilities 中显式声明，否则权限门拒绝并写入审计。
//
// ⚠️ 1.1.0（2026-09-30，C9 收编）起本岛只剩**接收端状态**：`summary` / `orderList` /
//    `profitStats` / `costMap*` / `rate*` / `purchase.costSnapshot` 六个 op 随「利润统计 / 订单明细 /
//    成本与汇率」一起移除（那些页已并入宿主「算钱」）。**删 op 必须同步删 manifest 的声明** ——
//    `tests/pluginTriage.spec.ts` 双向守卫：声明了不调用、或调用了没声明，都会红。

const DOMAIN_AE = 'ae';

/** 取桥；未就绪返回 null（纯浏览器预览场景） */
function bridge() {
  return typeof window !== 'undefined' && window.__sk ? window.__sk : null;
}

/**
 * 业务库调用：统一收敛为宿主 IPC 服务的 { success, data, error } 形状。
 * @param {string} domain 业务域（manifest db.domains 内声明）
 * @param {string} op 语义化操作（manifest db.actions 内声明）
 * @param {unknown} payload 操作参数（宿主侧二次校验并夹取范围）
 */
async function dbCall(domain, op, payload) {
  const sk = bridge();
  if (!sk) {
    return { success: false, error: '未连接宿主桥：请在 SellerKit 插件市场安装后从侧栏打开' };
  }
  try {
    const data = await sk.host.db.call(domain, op, payload === undefined ? null : payload);
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// —— 采集接收端（ae）——

/** 建库/迁移（幂等） */
export function aeDbEnsure() {
  return dbCall(DOMAIN_AE, 'ensure');
}

/** 收单状态：订单总数 / 最后入库时间 */
export function aeReceiverStatus() {
  return dbCall(DOMAIN_AE, 'receiverStatus');
}

/**
 * 写入剪贴板。
 * @param {string} text
 * @returns {Promise<boolean>} 是否成功
 */
export async function writeClipboard(text) {
  const sk = bridge();
  if (!sk) return false;
  try {
    await sk.host.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}

function notify(kind, text) {
  const sk = bridge();
  if (!sk) {
    // 纯浏览器预览：退化为控制台输出，不静默吞掉
    console.log(`[ae-profit] ${kind}: ${text}`);
    return;
  }
  sk.host.ui.notify({ kind, text: String(text) });
}

/** 宿主 Toast（success/error/info） */
export const toast = {
  success: (text) => notify('success', text),
  error: (text) => notify('error', text),
  info: (text) => notify('info', text),
};
