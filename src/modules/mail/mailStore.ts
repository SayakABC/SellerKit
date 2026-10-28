// src/modules/mail/mailStore.ts
// 「集中邮件收件箱」状态：账号接入 + 邮件列表/详情 + 同步触发 + 定时轮询 + 本地偏好。
// 依赖：core/services/ipc（mail-* 语义化封装）——所有持久化/网络能力均在主进程，
// 本 store 不持有任何凭据（IMAP 授权码只进不出，见 AGENTS.md §1.8 / 红线 16）。
//
// 与主 store 的关系：账号库（`shop-accounts/store.ts`）以「店铺」为单位（2026-10-22 物理合并后 sk_shops
// 一行 = 店铺和/或账号），本 store 以「邮箱」为单位，二者通过 sk_mail_accounts.shop_id 关联；
// 持久化命名空间隔离（shop-accounts-mail），互不覆盖。
//
// ⚠️ 2026-10-17：本文件原在 `src/modules/shop-accounts/mailStore.ts`，随「邮件」独立成一级模块
//   一并迁到 `src/modules/mail/`。**命名空间仍是 `shop-accounts-mail`、设置分类仍是旧的**
//   （见 settings.ts 注释）—— 模块 id 是存储键，不是用户可见名，改它等于让老用户的本地缓存失踪。
//   账号库（`shop-accounts/components/AccountsPanel.vue`）仍 import 本 store 读「邮箱接入态」：
//   那是**账号的属性**，不是邮件的属性，所以留在账号行上，不跟着界面搬家。

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  mailDbEnsure,
  mailAccountList,
  mailAccountUpsert,
  mailAccountDelete,
  mailAccountTest,
  mailSyncNow,
  mailSyncCancel,
  mailMessagesList,
  mailMessageGet,
  mailMessageRead,
  mailBodyFetch,
  mailAttachmentSave,
  mailAttachmentPreview,
  mailAttachmentOpen,
  mailFoldersList,
  mailCacheStatus,
  mailCacheClear,
  mailCacheOpen,
  mailFtsStatus,
  mailFtsRebuild,
  mailPurge,
  mailStats,
  mailProviderList,
  onMailSyncEvent,
} from '@/core/services/ipc';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';
import type {
  MailAccountItem,
  MailAccountUpsertInput,
  MailAttachmentPreview,
  MailCacheStatus,
  MailConnectionTestResult,
  MailFtsStatus,
  MailMessageDetail,
  MailMessageItem,
  MailProviderPresetView,
  MailRemoteFolder,
  MailStats,
  MailSyncEvent,
} from '@/types';

/** 收件箱本地偏好（持久化于 modules.shop-accounts-mail） */
export interface MailPrefs {
  /** 自动轮询间隔（分钟；0 = 关闭自动轮询） */
  pollMinutes: number;
  /** 新建接入时的默认同步/保留窗口（天） */
  defaultSyncDays: number;
  /** 新建接入时的默认单封正文缓存上限（KB） */
  defaultMaxBodyKb: number;
  /** 列表每页条数 */
  pageSize: number;
}

const STORAGE_NAMESPACE = 'shop-accounts-mail';
const DEFAULT_PREFS: MailPrefs = {
  pollMinutes: 10,
  defaultSyncDays: 30,
  defaultMaxBodyKb: 200,
  pageSize: 100,
};
const EMPTY_STATS: MailStats = { accounts: 0, messages: 0, unread: 0, lastSyncedAt: '', folders: [] };

function normalizeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 正整数收敛（非法/越界回落默认值） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const useMailStore = defineStore('shop-accounts-mail', () => {
  const storage = useModuleStorage<{ prefs: MailPrefs }>(STORAGE_NAMESPACE);

  const ready = ref(false);
  const loading = ref(false);

  const accounts = ref<MailAccountItem[]>([]);
  const providers = ref<MailProviderPresetView[]>([]);
  const stats = ref<MailStats>({ ...EMPTY_STATS });

  const messages = ref<MailMessageItem[]>([]);
  const total = ref(0);
  const keyword = ref('');
  const unreadOnly = ref(false);
  /** 文件夹筛选（M3-3）：空串 = 全部文件夹；值来自 stats.folders */
  const folderFilter = ref('');
  /** 0 = 全部账号 */
  const accountFilter = ref(0);
  const selectedId = ref(0);
  const detail = ref<MailMessageDetail | null>(null);
  const loadingDetail = ref(false);

  /** 附件预览结果（M3-1：图片内联；命中本地缓存不触网） */
  const attachmentPreview = ref<MailAttachmentPreview | null>(null);
  /** 附件缓存 / 全文索引状态（设置页展示） */
  const cacheStatus = ref<MailCacheStatus | null>(null);
  const ftsStatus = ref<MailFtsStatus | null>(null);

  /** 正在同步中的账号 id（来自 mail-sync-event） */
  const syncingIds = ref<number[]>([]);
  const lastEvent = ref<MailSyncEvent | null>(null);

  /** 「接入邮箱」抽屉目标店铺；null = 关闭（2026-10-22 物理合并后邮箱账号挂在店铺行上） */
  const accessShopId = ref<number | null>(null);

  const prefs = ref<MailPrefs>({ ...DEFAULT_PREFS });

  let unsubscribe: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 关键词搜索防抖 */
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 账号态（prefs / providers / accounts）的加载单飞：失败后置空以便重试 */
  let accountStatePromise: Promise<boolean> | null = null;

  const unread = computed(() => stats.value.unread);
  const hasAccount = computed(() => accounts.value.length > 0);
  const isSyncing = computed(() => syncingIds.value.length > 0);
  const accountOptions = computed(() =>
    accounts.value.map((a) => ({ id: a.id, email: a.email, status: a.status })),
  );
  const selectedMessage = computed(
    () => messages.value.find((m) => m.id === selectedId.value) || null,
  );
  /** 账号 id → 账号（列表行展示邮箱用） */
  const accountById = computed(() => {
    const map = new Map<number, MailAccountItem>();
    for (const a of accounts.value) map.set(a.id, a);
    return map;
  });

  /** 店铺 id → 已接入邮箱账号（账号库列表据此区分「已接入 / 未接入」） */
  const mailByShop = computed(() => {
    const map = new Map<number, MailAccountItem>();
    for (const a of accounts.value) {
      const sid = Number(a.shopId) || 0;
      if (sid > 0) map.set(sid, a);
    }
    return map;
  });

  /**
   * 查询某店铺是否已接入邮箱
   * @param shopId 店铺 id
   * @returns 已接入返回账号，未接入返回 null
   */
  function mailAccessOf(shopId: number): MailAccountItem | null {
    return mailByShop.value.get(Number(shopId) || 0) || null;
  }

  /** 按邮箱地址推断服务商（用于接入抽屉默认值） */
  function detectProviderId(email: string): string {
    const at = String(email || '').lastIndexOf('@');
    const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
    const hit = providers.value.find((p) => p.domains.includes(domain));
    return hit ? hit.id : 'custom';
  }

  function providerById(id: string): MailProviderPresetView | undefined {
    return providers.value.find((p) => p.id === id);
  }

  async function loadPrefs(): Promise<void> {
    const saved = await storage.load();
    const p = saved?.prefs;
    prefs.value = {
      pollMinutes: clampInt(p?.pollMinutes, 0, 1440, DEFAULT_PREFS.pollMinutes),
      defaultSyncDays: clampInt(p?.defaultSyncDays, 1, 365, DEFAULT_PREFS.defaultSyncDays),
      defaultMaxBodyKb: clampInt(p?.defaultMaxBodyKb, 16, 4096, DEFAULT_PREFS.defaultMaxBodyKb),
      pageSize: clampInt(p?.pageSize, 20, 500, DEFAULT_PREFS.pageSize),
    };
  }

  async function loadAccounts(): Promise<void> {
    const result = await mailAccountList();
    if (!result.success) {
      toast(result.error || '读取邮箱账号失败', 'error');
      return;
    }
    accounts.value = result.data || [];
  }

  async function loadStats(): Promise<void> {
    const result = await mailStats();
    if (!result.success) return;
    stats.value = result.data || { ...EMPTY_STATS };
  }

  /**
   * 确保「服务商预设 + 账号清单 + 偏好」已就绪（不含轮询与同步事件）。
   * 「基础数据」的账号行在冷启动时就要判断各店的接入态，不能要求用户先打开一次「邮件」页；
   * 单飞 + 失败可重试，避免每行都重复建库/拉账号。
   * @returns 成功为 true（失败已 toast）
   */
  function ensureAccountState(): Promise<boolean> {
    if (accountStatePromise) return accountStatePromise;
    accountStatePromise = (async () => {
      await loadPrefs();
      const ensure = await mailDbEnsure();
      if (!ensure.success) {
        toast(ensure.error || '邮件库初始化失败', 'error');
        return false;
      }
      const providerResult = await mailProviderList();
      if (providerResult.success) providers.value = providerResult.data || [];
      await loadAccounts();
      return true;
    })()
      .catch((e: unknown) => {
        toast(`读取邮箱状态失败: ${normalizeError(e)}`, 'error');
        return false;
      })
      .then((ok) => {
        if (!ok) accountStatePromise = null;
        return ok;
      });
    return accountStatePromise;
  }

  async function loadMessages(): Promise<void> {
    loading.value = true;
    try {
      const result = await mailMessagesList({
        accountIds: accountFilter.value ? [accountFilter.value] : undefined,
        keyword: keyword.value.trim() || undefined,
        unreadOnly: unreadOnly.value || undefined,
        folders: folderFilter.value ? [folderFilter.value] : undefined,
        limit: prefs.value.pageSize,
      });
      if (!result.success) {
        toast(result.error || '读取邮件失败', 'error');
        return;
      }
      messages.value = result.data?.items || [];
      total.value = result.data?.total || 0;
      if (selectedId.value && !messages.value.some((m) => m.id === selectedId.value)) {
        selectedId.value = 0;
        detail.value = null;
      }
    } catch (e: unknown) {
      toast(`读取邮件失败: ${normalizeError(e)}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  async function openMessage(id: number): Promise<void> {
    selectedId.value = id;
    detail.value = null;
    attachmentPreview.value = null;
    loadingDetail.value = true;
    try {
      const result = await mailMessageGet(id);
      if (!result.success) {
        toast(result.error || '读取邮件正文失败', 'error');
        return;
      }
      detail.value = result.data || null;
      // 打开即标记本地已读（IMAP 只读，服务端 flag 改不了，只能本地兜底）
      if (detail.value && !detail.value.read) void markRead([id], true, { silent: true });
    } catch (e: unknown) {
      toast(`读取邮件正文失败: ${normalizeError(e)}`, 'error');
    } finally {
      loadingDetail.value = false;
    }
  }

  /**
   * 本地已读 / 未读标记。
   * 同步/列表/角标口径统一用 `read`（服务端 seen 或本地 read_at 取或），
   * 因此这里只更新本地列表行与统计，不重查列表（保留滚动位置与选中态）。
   * @param ids 邮件 id 列表；为空且 scope='account' 时按账号批量
   * @param read true=已读；false=恢复未读
   * @param opts.silent 静默（打开邮件时自动标记，不打扰用户）
   */
  async function markRead(
    ids: number[],
    read: boolean,
    opts: { silent?: boolean; accountId?: number; all?: boolean } = {},
  ): Promise<boolean> {
    const payload = ids.length
      ? { ids, read }
      : { accountId: opts.accountId || 0, all: opts.all === true, read };
    try {
      const result = await mailMessageRead(payload);
      if (!result.success) {
        if (!opts.silent) toast(result.error || '标记失败', 'error');
        return false;
      }
      const idSet = new Set(ids);
      const now = new Date().toISOString();
      for (const m of messages.value) {
        if (!idSet.has(m.id)) continue;
        // 服务端已读的邮件无法标回未读，本地字段保持同步即可
        m.read = read || m.seen;
        m.readAt = read ? now : '';
      }
      if (detail.value && idSet.has(detail.value.id)) {
        detail.value.read = read || detail.value.seen;
        detail.value.readAt = read ? now : '';
      }
      // 后端返回最新未读总数，避免为了刷新角标再查一次列表
      if (result.data) stats.value = { ...stats.value, unread: Number(result.data.unread) || 0 };
      else void loadStats();
      if (!opts.silent) {
        const changed = Number(result.data?.changed) || 0;
        toast(read ? `已标记 ${changed} 封为已读` : `已恢复 ${changed} 封为未读`, 'success');
      }
      // 「只看未读」下标记为已读的邮件应从列表消失
      if (unreadOnly.value && read) void loadMessages();
      return true;
    } catch (e: unknown) {
      if (!opts.silent) toast(`标记失败: ${normalizeError(e)}`, 'error');
      return false;
    }
  }

  /** 当前筛选范围内的邮件全部标记已读（"全部已读"按钮） */
  async function markAllRead(): Promise<void> {
    const accountId = accountFilter.value || undefined;
    await markRead([], true, { accountId: accountId || 0, all: !accountId });
    await loadMessages();
  }

  /**
   * 按需补拉正文（M2-1）
   * 同步时为超大邮件只缓存了预览，用户点开时按 UID 现拉原文解析入库。
   * @returns 成功返回最新详情；失败返回 null（已 toast）
   */
  async function fetchBodyOnDemand(messageId: number, accountId?: number): Promise<MailMessageDetail | null> {
    loadingDetail.value = true;
    try {
      const result = await mailBodyFetch(messageId, accountId);
      if (!result.success) {
        toast(result.error || '拉取完整正文失败', 'error');
        return null;
      }
      if (!result.data) {
        toast('邮件不存在（可能已被清理）', 'error');
        return null;
      }
      detail.value = result.data;
      return result.data;
    } catch (e: unknown) {
      toast(`拉取完整正文失败: ${normalizeError(e)}`, 'error');
      return null;
    } finally {
      loadingDetail.value = false;
    }
  }

  /**
   * 附件另存（M2-2）
   * 弹系统保存对话框（默认文件名=附件名），确认后落盘；用户取消属正常流程，不报错。
   * @returns 保存成功返回文件路径；取消或失败返回 null（失败已 toast）
   */
  async function saveAttachment(messageId: number, attachmentId: number): Promise<string | null> {
    try {
      const result = await mailAttachmentSave(messageId, attachmentId);
      if (!result.success) {
        toast(result.error || '下载附件失败', 'error');
        return null;
      }
      if (result.data?.canceled) return null;
      toast(`已保存：${result.data?.path || '附件'}`, 'success');
      return result.data?.path || null;
    } catch (e: unknown) {
      toast(`下载附件失败: ${normalizeError(e)}`, 'error');
      return null;
    }
  }

  /** 附件预览标志位：正在预览的附件 id（0 = 无） */
  const previewingAttachmentId = ref(0);

  /**
   * 附件预览（M3-1）
   * 命中本地缓存时直接读盘（不触网）；图片返回 data URL 供内联预览，
   * 非图片/超大附件返回 previewable=false，由界面提示改用「打开」。
   * @returns 预览结果；失败返回 null（已 toast）
   */
  async function previewAttachment(
    messageId: number,
    attachmentId: number,
  ): Promise<MailAttachmentPreview | null> {
    previewingAttachmentId.value = attachmentId;
    try {
      const result = await mailAttachmentPreview(messageId, attachmentId);
      if (!result.success) {
        toast(result.error || '预览附件失败', 'error');
        return null;
      }
      attachmentPreview.value = result.data || null;
      if (result.data && !result.data.previewable) {
        toast('该附件不支持内联预览，已缓存到本地，可用「打开」调用系统应用', 'info');
      }
      return result.data || null;
    } catch (e: unknown) {
      toast(`预览附件失败: ${normalizeError(e)}`, 'error');
      return null;
    } finally {
      previewingAttachmentId.value = 0;
    }
  }

  /** 关闭附件预览区 */
  function closeAttachmentPreview(): void {
    attachmentPreview.value = null;
  }

  /** 附件用系统默认应用打开（M3-1） */
  async function openAttachment(messageId: number, attachmentId: number): Promise<void> {
    try {
      const result = await mailAttachmentOpen(messageId, attachmentId);
      if (!result.success) {
        toast(result.error || '打开附件失败', 'error');
        return;
      }
      toast('已调用系统应用打开附件', 'success');
    } catch (e: unknown) {
      toast(`打开附件失败: ${normalizeError(e)}`, 'error');
    }
  }

  /** 拉取服务端文件夹列表（M3-3：设置页勾选同步目录，会建立一次只读连接） */
  async function loadRemoteFolders(accountId: number): Promise<MailRemoteFolder[] | null> {
    try {
      const result = await mailFoldersList(accountId);
      if (!result.success) {
        toast(result.error || '读取文件夹列表失败', 'error');
        return null;
      }
      return result.data || [];
    } catch (e: unknown) {
      toast(`读取文件夹列表失败: ${normalizeError(e)}`, 'error');
      return null;
    }
  }

  /** 读取附件缓存占用（M3-1） */
  async function loadCacheStatus(): Promise<void> {
    const result = await mailCacheStatus();
    if (!result.success) return;
    cacheStatus.value = result.data || null;
  }

  /** 清空附件缓存（M3-1） */
  async function clearCache(): Promise<void> {
    const result = await mailCacheClear();
    if (!result.success) {
      toast(result.error || '清空缓存失败', 'error');
      return;
    }
    toast(`已清空 ${result.data?.removed ?? 0} 个缓存文件`, 'success');
    await loadCacheStatus();
  }

  /** 打开附件缓存目录 */
  async function openCacheDir(): Promise<void> {
    const result = await mailCacheOpen();
    if (!result.success) toast(result.error || '打开缓存目录失败', 'error');
  }

  /** 读取全文索引状态（M3-2） */
  async function loadFtsStatus(): Promise<void> {
    const result = await mailFtsStatus();
    if (!result.success) return;
    ftsStatus.value = result.data || null;
  }

  /** 重建全文索引（M3-2） */
  async function rebuildFts(): Promise<void> {
    const result = await mailFtsRebuild();
    if (!result.success) {
      toast(result.error || '重建索引失败', 'error');
      return;
    }
    toast(`已重建 ${result.data?.indexed ?? 0}/${result.data?.total ?? 0} 封邮件的索引`, 'success');
    await loadFtsStatus();
  }

  /**
   * 首次进入收件箱时调用：建表 + 拉取服务商预设 + 账号 + 统计 + 订阅同步事件 + 启动轮询。
   * 幂等（ready 后直接返回）。
   */
  async function ensureReady(): Promise<void> {
    if (ready.value) return;
    ready.value = true;
    if (!(await ensureAccountState())) return;
    await Promise.all([loadAccounts(), loadStats()]);
    unsubscribe = onMailSyncEvent(handleSyncEvent);
    startPolling();
  }

  /** 释放定时器与事件订阅（模块停用时调用） */
  function dispose(): void {
    stopPolling();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    ready.value = false;
  }

  function handleSyncEvent(event: MailSyncEvent): void {
    lastEvent.value = event;
    if (event.type === 'status' && event.status === 'syncing') {
      if (!syncingIds.value.includes(event.accountId)) {
        syncingIds.value = [...syncingIds.value, event.accountId];
      }
      return;
    }
    if (event.type === 'progress') return;
    syncingIds.value = syncingIds.value.filter((id) => id !== event.accountId);
    if (event.type === 'error') {
      toast(`「${event.email}」同步失败: ${event.message || '未知错误'}`, 'error');
    }
    void loadAccounts();
    void loadStats();
    void loadMessages();
  }

  /** 触发同步（省略 accountId = 全部启用账号） */
  async function syncNow(accountId?: number): Promise<void> {
    const result = await mailSyncNow(accountId);
    if (!result.success) {
      toast(result.error || '同步失败', 'error');
      return;
    }
    const queued = result.data?.queued || [];
    if (!queued.length) toast('没有可同步的邮箱（未接入或已停用）', 'info');
  }

  /** 取消同步（下一批边界生效） */
  async function cancelSync(accountId: number): Promise<void> {
    const result = await mailSyncCancel(accountId);
    if (!result.success) {
      toast(result.error || '取消同步失败', 'error');
      return;
    }
    syncingIds.value = syncingIds.value.filter((id) => id !== accountId);
  }

  /**
   * 接入/更新邮箱（授权码经主进程加密落库，写后不回读）
   * @returns 账号 id；失败返回 null（已 toast）
   */
  async function saveAccount(payload: MailAccountUpsertInput): Promise<number | null> {
    try {
      const result = await mailAccountUpsert(payload);
      if (!result.success) {
        toast(result.error || '接入失败', 'error');
        return null;
      }
      toast('已保存邮箱接入配置', 'success');
      await Promise.all([loadAccounts(), loadStats()]);
      return result.data?.id ?? null;
    } catch (e: unknown) {
      toast(`接入失败: ${normalizeError(e)}`, 'error');
      return null;
    }
  }

  /** 取消接入（连带删除该邮箱已缓存邮件） */
  async function removeAccount(id: number): Promise<void> {
    try {
      const result = await mailAccountDelete(id);
      if (!result.success) {
        toast(result.error || '取消接入失败', 'error');
        return;
      }
      toast('已取消接入并清理缓存', 'success');
      if (accountFilter.value === id) accountFilter.value = 0;
      selectedId.value = 0;
      detail.value = null;
      await Promise.all([loadAccounts(), loadStats(), loadMessages()]);
    } catch (e: unknown) {
      toast(`取消接入失败: ${normalizeError(e)}`, 'error');
    }
  }

  /** 连接测试（只读打开 INBOX 后即登出，不落库） */
  async function testConnection(payload: {
    email: string;
    authPassword: string;
    providerId?: string;
    host?: string;
    port?: number;
    secure?: boolean;
  }): Promise<MailConnectionTestResult | null> {
    const result = await mailAccountTest(payload);
    if (!result.success) {
      toast(result.error || '连接测试失败', 'error');
      return null;
    }
    if (!result.data?.ok) {
      toast(result.data?.error || '连接失败', 'error');
    }
    return result.data || null;
  }

  /** 手动清理窗口外邮件（默认按各账号 syncDays） */
  async function purge(days?: number): Promise<void> {
    const result = await mailPurge(days ? { days } : {});
    if (!result.success) {
      toast(result.error || '清理失败', 'error');
      return;
    }
    toast(`已清理 ${result.data?.deleted ?? 0} 封过期邮件`, 'success');
    await Promise.all([loadStats(), loadMessages()]);
  }

  function startPolling(): void {
    stopPolling();
    const minutes = prefs.value.pollMinutes;
    if (!minutes) return;
    pollTimer = setInterval(() => {
      if (!hasAccount.value) return;
      if (syncingIds.value.length) return;
      void syncNow();
    }, minutes * 60_000);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function setPrefs(patch: Partial<MailPrefs>): Promise<void> {
    prefs.value = { ...prefs.value, ...patch };
    await storage.save({ prefs: prefs.value });
    if (patch.pollMinutes !== undefined) startPolling();
  }

  function openAccess(shopId: number): void {
    accessShopId.value = shopId;
  }

  function closeAccess(): void {
    accessShopId.value = null;
  }

  watch([accountFilter, unreadOnly, folderFilter], () => {
    void loadMessages();
  });

  watch(keyword, () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadMessages(), 300);
  });

  watch(prefs, () => {
    void storage.scheduleSave({ prefs: prefs.value });
  });

  return {
    ready,
    loading,
    accounts,
    providers,
    stats,
    messages,
    total,
    keyword,
    unreadOnly,
    folderFilter,
    accountFilter,
    selectedId,
    detail,
    loadingDetail,
    attachmentPreview,
    previewingAttachmentId,
    cacheStatus,
    ftsStatus,
    syncingIds,
    lastEvent,
    accessShopId,
    prefs,
    unread,
    hasAccount,
    isSyncing,
    accountOptions,
    accountById,
    mailByShop,
    mailAccessOf,
    selectedMessage,
    ensureReady,
    ensureAccountState,
    dispose,
    loadAccounts,
    loadStats,
    loadMessages,
    openMessage,
    markRead,
    markAllRead,
    fetchBodyOnDemand,
    saveAttachment,
    previewAttachment,
    closeAttachmentPreview,
    openAttachment,
    loadRemoteFolders,
    loadCacheStatus,
    clearCache,
    openCacheDir,
    loadFtsStatus,
    rebuildFts,
    syncNow,
    cancelSync,
    saveAccount,
    removeAccount,
    testConnection,
    purge,
    setPrefs,
    startPolling,
    stopPolling,
    openAccess,
    closeAccess,
    detectProviderId,
    providerById,
  };
});

/** 供 index.ts 的 activate/deactivate 直接调用（无需先拿组件实例） */
export function ensureMailInbox(): Promise<void> {
  return useMailStore().ensureReady();
}

/** 停用时释放定时器与订阅 */
export function disposeMailInbox(): void {
  useMailStore().dispose();
}
