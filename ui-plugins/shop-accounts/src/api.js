// src/api.js — 岛侧宿主服务适配层。
// 作用：把受控桥（window.__sk.host.*）包装成与内建插件同名的服务函数，使本岛的 Vue 源码
//      沿用内建插件写法（vite alias 将 @/core/services/ipc|clipboard|toast 指向本文件）。
// 来源：源码原为内建视图插件包 extensions/shop-accounts/src，2026-09-16 迁入本岛并删除原目录。
// 纪律：一律走桥（src/bridge.js），能力需在 manifest.json 的 capabilities 中显式声明。
//
// 返回体统一收敛为宿主 IPC 服务的 { success, data, error } 形状，
// 与 src/core/services/ipc.ts 的 ApiResult<T> 语义一致（源码按此判定分支）。

import { dbCall, mailCall, onBus, copyText as bridgeCopy } from './bridge.js';
import { pushToast } from './toast.js';

/** 把桥调用（成功返回值 / 失败抛错）收敛为 ApiResult */
async function wrap(run) {
  try {
    const data = await run();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------ 店铺套 ------------------------------ */

export function shopAccountDbEnsure() {
  return wrap(() => dbCall('ensure'));
}

export function shopAccountList(payload) {
  return wrap(() => dbCall('list', payload));
}

export function shopAccountGet(id) {
  return wrap(() => dbCall('get', { id: Number(id) || 0 }));
}

export function shopAccountSummary() {
  return wrap(() => dbCall('summary'));
}

export function shopAccountSecurity() {
  return wrap(() => dbCall('security'));
}

export function shopAccountUpsert(payload) {
  return wrap(() => dbCall('upsert', payload));
}

export function shopAccountDelete(id) {
  return wrap(() => dbCall('delete', { id: Number(id) || 0 }));
}

export function shopAccountReveal(id, field) {
  return wrap(() => dbCall('reveal', { id: Number(id) || 0, field }));
}

export function shopAccountBatchUpdate(payload) {
  return wrap(() => dbCall('batchUpdate', payload));
}

/* ------------------------------ 邮件 ------------------------------ */

export function mailDbEnsure() {
  return wrap(() => mailCall('ensure'));
}

export function mailStats() {
  return wrap(() => mailCall('stats'));
}

export function mailProviderList() {
  return wrap(() => mailCall('providers'));
}

export function mailAccountList() {
  return wrap(() => mailCall('accountList'));
}

export function mailAccountUpsert(payload) {
  return wrap(() => mailCall('accountUpsert', payload));
}

export function mailAccountDelete(id) {
  return wrap(() => mailCall('accountDelete', { id: Number(id) || 0 }));
}

export function mailAccountTest(payload) {
  return wrap(() => mailCall('accountTest', payload));
}

export function mailSyncNow(accountId) {
  return wrap(() =>
    mailCall('syncNow', accountId == null ? null : { accountId: Number(accountId) || 0 }),
  );
}

export function mailSyncCancel(accountId) {
  return wrap(() => mailCall('syncCancel', { accountId: Number(accountId) || 0 }));
}

export function mailMessagesList(payload) {
  return wrap(() => mailCall('messagesList', payload));
}

export function mailMessageGet(id) {
  return wrap(() => mailCall('messageGet', { id: Number(id) || 0 }));
}

export function mailMessageRead(payload) {
  return wrap(() => mailCall('messageRead', payload));
}

export function mailBodyFetch(messageId, accountId) {
  return wrap(() =>
    mailCall('bodyFetch', {
      messageId: Number(messageId) || 0,
      accountId: accountId == null ? undefined : Number(accountId) || 0,
    }),
  );
}

export function mailAttachmentSave(messageId, attachmentId) {
  return wrap(() =>
    mailCall('attachmentSave', {
      messageId: Number(messageId) || 0,
      attachmentId: Number(attachmentId) || 0,
    }),
  );
}

export function mailAttachmentPreview(messageId, attachmentId) {
  return wrap(() =>
    mailCall('attachmentPreview', {
      messageId: Number(messageId) || 0,
      attachmentId: Number(attachmentId) || 0,
    }),
  );
}

export function mailAttachmentOpen(messageId, attachmentId) {
  return wrap(() =>
    mailCall('attachmentOpen', {
      messageId: Number(messageId) || 0,
      attachmentId: Number(attachmentId) || 0,
    }),
  );
}

export function mailFoldersList(accountId) {
  return wrap(() => mailCall('foldersList', { accountId: Number(accountId) || 0 }));
}

export function mailCacheStatus() {
  return wrap(() => mailCall('cacheStatus'));
}

export function mailCacheClear() {
  return wrap(() => mailCall('cacheClear'));
}

export function mailCacheOpen() {
  return wrap(() => mailCall('cacheOpen'));
}

export function mailFtsStatus() {
  return wrap(() => mailCall('ftsStatus'));
}

export function mailFtsRebuild() {
  return wrap(() => mailCall('ftsRebuild'));
}

export function mailPurge(payload) {
  return wrap(() => mailCall('purge', payload));
}

/**
 * 订阅邮件同步事件（主进程 → 宿主渲染层 → 插件总线 → 本岛）。
 * 宿主侧转发见 src/core/components/UiIslandView.vue；无桥时返回空退订函数。
 */
export function onMailSyncEvent(cb) {
  return onBus('mail-sync-event', (payload) => cb(payload));
}

/* ------------------------------ 企业管理 ------------------------------ */
// 企业基本信息 + 企业下跨境合规资料（欧代 / 土代 / 德国包装法）。
// 走 db 能力域的 shop-accounts 域，op 由宿主 DB_OPS 白名单登记。

export function companyDbEnsure() {
  return wrap(() => dbCall('companyEnsure'));
}

export function companyList(payload) {
  return wrap(() => dbCall('companyList', payload));
}

export function companyGet(id) {
  return wrap(() => dbCall('companyGet', { id: Number(id) || 0 }));
}

export function companySummary() {
  return wrap(() => dbCall('companySummary'));
}

export function companyUpsert(payload) {
  return wrap(() => dbCall('companyUpsert', payload));
}

export function companyDelete(id) {
  return wrap(() => dbCall('companyDelete', { id: Number(id) || 0 }));
}

export function companyProfileUpsert(payload) {
  return wrap(() => dbCall('companyProfileUpsert', payload));
}

export function companyProfileDelete(id) {
  return wrap(() => dbCall('companyProfileDelete', { id: Number(id) || 0 }));
}

/* ------------------------------ 通用宿主服务 ------------------------------ */

/** 写入剪贴板（对应 @/core/services/clipboard 的 writeClipboard） */
export async function writeClipboard(text) {
  try {
    await bridgeCopy(text);
    return true;
  } catch (e) {
    pushToast(e instanceof Error ? e.message : String(e), 'error');
    return false;
  }
}

/** 宿主 Toast（对应 @/core/services/toast）——岛内自渲染，不依赖宿主 ui.notify。
 *  契约与宿主一致：toast 本身可调用 toast(text, kind)，并挂 success/error/info 便捷方法。 */
export function toast(text, kind = 'info') {
  pushToast(text, kind);
}
toast.success = (text) => pushToast(text, 'success');
toast.error = (text) => pushToast(text, 'error');
toast.info = (text) => pushToast(text, 'info');
