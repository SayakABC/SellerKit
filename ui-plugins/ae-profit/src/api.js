// src/api.js — 岛侧宿主服务适配层。
// 作用：把受控桥（window.__sk.host.*）包装成与内建插件同名的服务函数，
//      使 extensions/ae-profit 的 Vue 源码可零改动复用（vite alias 将 @/core/services/* 指向本文件）。
// 纪律：一律走桥，不直连 window.electronAPI / 裸 IPC（AGENTS 红线 16）；
//      能力需在 manifest.json 的 capabilities 中显式声明，否则权限门拒绝并写入审计。

const DOMAIN_AE = 'ae';
const DOMAIN_PURCHASE = 'purchase';

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

// —— 利润追踪业务域（ae） ——

/** 建库/迁移（幂等） */
export function aeDbEnsure() {
  return dbCall(DOMAIN_AE, 'ensure');
}

/** 收单状态：订单总数 / 最后入库时间 */
export function aeReceiverStatus() {
  return dbCall(DOMAIN_AE, 'receiverStatus');
}

/** 订单汇总（收入/成本/毛利/净利） */
export function aeSummary() {
  return dbCall(DOMAIN_AE, 'summary');
}

/** 订单明细分页查询 */
export function aeOrderList(payload) {
  return dbCall(DOMAIN_AE, 'orderList', payload);
}

/** 利润引擎统计（趋势/分类/爆品） */
export function aeProfitStats(payload) {
  return dbCall(DOMAIN_AE, 'profitStats', payload);
}

/** 成本表列表 */
export function aeCostMapList() {
  return dbCall(DOMAIN_AE, 'costMapList');
}

/** 成本表全量替换导入（源：拿货对账快照） */
export function aeCostMapImport(items) {
  return dbCall(DOMAIN_AE, 'costMapImport', { items });
}

/** 汇率列表 */
export function aeRateList() {
  return dbCall(DOMAIN_AE, 'rateList');
}

/** 汇率写入/更新 */
export function aeRateUpsert(fromCurrency, rateToCny) {
  return dbCall(DOMAIN_AE, 'rateUpsert', { fromCurrency, rateToCny });
}

/**
 * 拿货对账 → 利润追踪单向只读成本快照。
 * @returns {Promise<{success: boolean, data?: {count: number, items: Array<{styleCode: string, styleName: string, unitPriceCents: number, sampleCount: number, lastBizDate: string}>}, error?: string}>}
 */
export function purchaseCostSnapshot() {
  return dbCall(DOMAIN_PURCHASE, 'costSnapshot');
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
