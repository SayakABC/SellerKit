// src/modules/mail/mailStore.ts
// 「集中邮件收件箱」状态：账号接入 + 邮件列表/详情 + 同步触发 + 本地偏好。
// 自动收信的**定时器在主进程**（electron/mail-scheduler.ts）：本 store 只负责把
// 「间隔」这一项用户设置下发过去，并消费同步事件刷新列表 —— 不再自己 setInterval。
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
  mailTodoList,
  mailTodoDismiss,
  mailTodoRestore,
  mailAutoSyncConfig,
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
  MailTodoItem,
} from '@/types';

/** 收件箱本地偏好（持久化于 modules.shop-accounts-mail） */
export interface MailPrefs {
  /**
   * 自动收信间隔（分钟；0 = 关闭）。
   * 本值是**唯一权威**：变更即下发给主进程（mail-auto-sync-config），由主进程排程。
   */
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
const EMPTY_STATS: MailStats = {
  accounts: 0,
  messages: 0,
  unread: 0,
  lastSyncedAt: '',
  folders: [],
};

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
  /**
   * 待办（三类：罚单 / 纠纷·仲裁 / 订单关闭，按订单号合并）。
   * **判定规则不在渲染层**：主进程 `mail-triage.ts` 一处实现，这里只是展示用的快照。
   * 因此它随「同步收尾 / 打开邮件页」刷新，不随关键词、未读、文件夹筛选变化 ——
   * 那三项是"看哪些邮件"，待办是"哪些单要处理"，两个问题。
   */
  const todos = ref<MailTodoItem[]>([]);
  /** 参与判定的邮件封数与无法归属封数（诚实展示缺口，不静默吞） */
  const todoMeta = ref({ mails: 0, unattributed: 0 });
  const todoLoading = ref(false);
  /** 正在划掉/恢复的那条待办 key（防连点：同一时刻只发一个请求） */
  const todoBusyKey = ref('');
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
  /** 关键词搜索防抖 */
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 账号态（prefs / providers / accounts）的加载单飞：失败后置空以便重试 */
  let accountStatePromise: Promise<boolean> | null = null;

  const unread = computed(() => stats.value.unread);
  /** 要动手的待办（severity ≥ 2，且没被手工划掉）：常驻列表顶部 */
  const todoActions = computed(() => todos.value.filter((t) => t.severity >= 2 && !t.dismissed));
  /** 只需知会的（协议取消这类已了结的）：折在"更多"里，不占注意力 */
  const todoInfo = computed(() => todos.value.filter((t) => t.severity < 2 && !t.dismissed));
  /** 被手工划掉的：默认不显示，但**必须能撤销** —— 划错了否则就永远找不回来了 */
  const todoDismissed = computed(() => todos.value.filter((t) => t.dismissed));
  const hasAccount = computed(() => accounts.value.length > 0);
  const isSyncing = computed(() => syncingIds.value.length > 0);
  const accountOptions = computed(() =>
    accounts.value.map((a) => ({ id: a.id, email: a.email, status: a.status }))
  );
  const selectedMessage = computed(
    () => messages.value.find((m) => m.id === selectedId.value) || null
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
    const domain =
      at >= 0
        ? email
            .slice(at + 1)
            .trim()
            .toLowerCase()
        : '';
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

  /**
   * 拉待办快照。只按「邮箱」收敛，**不叠加关键词 / 只看未读 / 文件夹** ——
   * 那三项回答的是"我要看哪些邮件"，待办回答的是"哪些单要处理"。
   * @param opts.silent 后台刷新（同步收尾）不弹错：用户没主动点，报错只是噪音
   */
  async function loadTodos(opts: { silent?: boolean } = {}): Promise<void> {
    todoLoading.value = true;
    try {
      const result = await mailTodoList({
        accountIds: accountFilter.value ? [accountFilter.value] : undefined,
      });
      if (!result.success) {
        if (!opts.silent) toast(result.error || '读取待办失败', 'error');
        return;
      }
      todos.value = result.data?.items || [];
      todoMeta.value = {
        mails: result.data?.mails || 0,
        unattributed: result.data?.unattributed || 0,
      };
    } catch (e: unknown) {
      if (!opts.silent) toast(`读取待办失败: ${normalizeError(e)}`, 'error');
    } finally {
      todoLoading.value = false;
    }
  }

  /**
   * 手工划掉一条待办（"这单我处理过了"）。
   *
   * 传的 `messageId` 是**这条待办当前最新的那封**：主进程拿它当水位线，之后同单再来新邮件
   * 会自动浮出。所以划掉 ≠ 屏蔽该订单 —— 罚单升级、纠纷判决这类后续进展不会被吞掉。
   * 落库后**重新拉一次待办**而不是本地 ±1：分组/计数/排序全在主进程，本地改状态迟早对不上。
   *
   * @returns 真的划掉了为 true（调用方据此决定"要不要自动跳到下一条"——
   *          失败还跳，用户会以为划成功、其实那条还在）
   */
  async function dismissTodo(t: MailTodoItem): Promise<boolean> {
    if (todoBusyKey.value) return false;
    todoBusyKey.value = t.orderNo;
    try {
      const result = await mailTodoDismiss({
        key: t.orderNo,
        messageId: t.messageId,
        kind: t.kind,
      });
      if (!result.success) {
        toast(result.error || '划掉失败', 'error');
        return false;
      }
      await loadTodos({ silent: true });
      return true;
    } catch (e: unknown) {
      toast(`划掉失败: ${normalizeError(e)}`, 'error');
      return false;
    } finally {
      todoBusyKey.value = '';
    }
  }

  /** 撤销划掉（划错了 / 要重新跟进） */
  async function restoreTodo(t: MailTodoItem): Promise<boolean> {
    if (todoBusyKey.value) return false;
    todoBusyKey.value = t.orderNo;
    try {
      const result = await mailTodoRestore({ key: t.orderNo });
      if (!result.success) {
        toast(result.error || '恢复失败', 'error');
        return false;
      }
      await loadTodos({ silent: true });
      return true;
    } catch (e: unknown) {
      toast(`恢复失败: ${normalizeError(e)}`, 'error');
      return false;
    } finally {
      todoBusyKey.value = '';
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
      // 期间用户已经换了一封（连按 ↑↓ / 连点时间线）：**丢弃这次结果**。
      // 不判的话后到的旧响应会盖掉新选中那封 —— 界面上表现为"点 A 显示 B"，
      // 而且没有任何报错，是最难复现的一类错位。
      if (selectedId.value !== id) return;
      detail.value = result.data || null;
      // 打开即标记本地已读（IMAP 只读，服务端 flag 改不了，只能本地兜底）
      if (detail.value && !detail.value.read) void markRead([id], true, { silent: true });
    } catch (e: unknown) {
      toast(`读取邮件正文失败: ${normalizeError(e)}`, 'error');
    } finally {
      if (selectedId.value === id) loadingDetail.value = false;
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
    opts: { silent?: boolean; accountId?: number; all?: boolean } = {}
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
  async function fetchBodyOnDemand(
    messageId: number,
    accountId?: number
  ): Promise<MailMessageDetail | null> {
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
    attachmentId: number
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
    await Promise.all([loadAccounts(), loadStats(), loadTodos({ silent: true })]);
    unsubscribe = onMailSyncEvent(handleSyncEvent);
    // 自动收信的定时器在**主进程**（见 electron/mail-scheduler.ts）：这里只把用户设置推给它。
    // 2026-11-04 前这里是 `startPolling()`（渲染层 setInterval），只在邮件页挂载时存在 ——
    // 冷启动后不进本页就永远不收信，正是"不会自动接收邮件"的原因。
    void pushAutoSyncConfig();
  }

  /** 释放事件订阅（模块停用时调用） */
  function dispose(): void {
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
    void loadTodos({ silent: true });
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

  /**
   * 把「自动收信间隔」下发给主进程。
   *
   * 用户设置（`prefs.pollMinutes`）是**唯一权威**；主进程只执行 + 缓存，
   * 冷启动时会先按缓存排程（见 electron/mail-scheduler.ts）。
   * 下发失败不回滚设置（本地仍记着用户的选择，下次打开页面会再推一次）。
   */
  async function pushAutoSyncConfig(): Promise<void> {
    try {
      const result = await mailAutoSyncConfig(prefs.value.pollMinutes);
      if (!result.success) console.warn('[mail] 下发自动收信间隔失败：', result.error);
    } catch (e: unknown) {
      console.warn('[mail] 下发自动收信间隔失败：', normalizeError(e));
    }
  }

  async function setPrefs(patch: Partial<MailPrefs>): Promise<void> {
    prefs.value = { ...prefs.value, ...patch };
    await storage.save({ prefs: prefs.value });
    // 间隔变了就立刻让主进程重排定时器（否则用户要等到下次重启才生效）
    if (patch.pollMinutes !== undefined) void pushAutoSyncConfig();
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

  // 待办只随「邮箱」变：未读/文件夹/关键词是"看哪些邮件"，不影响"哪些单要处理"
  watch(accountFilter, () => {
    void loadTodos({ silent: true });
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
    todos,
    todoMeta,
    todoLoading,
    todoBusyKey,
    todoActions,
    todoInfo,
    todoDismissed,
    loadTodos,
    dismissTodo,
    restoreTodo,
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
