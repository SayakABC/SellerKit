// src/core/plugin/host.ts
// Host API 渲染层 trusted 实现（Phase 2：收敛渲染层六域）。
// 依赖方向：core/services（ipc 服务层）+ core/network（默认 axios 实例），不直接触 window.electronAPI。
// 说明：本实现是"宿主能力面"的 trusted 实现，供插件上下文注入；
//       插件侧拿到的是接口端口（HostApi），权限门（Phase 3+）在桥层二次拦截。

import { writeClipboard } from '@/core/services/clipboard';
import { selectExcelFile, selectTemplateFile } from '@/core/services/dialog';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { useModuleStorage } from '@/core/services/storage';
import http from '@/core/network/request';
import type { DialogOptions, FilePayload, HostApi, PluginHttpOptions } from './sdk';

/** 当前应用的平台与版本信息（版本异步拉取一次，缓存于 getter 闭包） */
function createEnv(): HostApi['env'] {
  let version = '';
  void ipc
    .getAppVersion()
    .then((r) => {
      if (r.success && r.data) version = r.data;
    })
    .catch(() => {});
  return {
    isMac: ipc.platform === 'darwin',
    platform: ipc.platform,
    get version() {
      return version;
    },
  };
}

/** 解包 IPC 结果：失败转异常（插件侧统一 try/catch，避免吞错） */
async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '宿主调用失败');
  return r.data as T;
}

/** 业务库白名单：domain → op → 宿主 IPC 调用（禁止放行任意 SQL） */
const DB_OPS: Record<string, Record<string, (payload: any) => Promise<unknown>>> = {
  'shop-accounts': {
    ensure: () => unwrap(ipc.shopAccountDbEnsure()),
    list: (p) => unwrap(ipc.shopAccountList(p && typeof p === 'object' ? p : undefined)),
    get: (p) => unwrap(ipc.shopAccountGet({ id: Number(p?.id) || 0 })),
    summary: () => unwrap(ipc.shopAccountSummary()),
    security: () => unwrap(ipc.shopAccountSecurity()),
    upsert: (p) => unwrap(ipc.shopAccountUpsert(p)),
    delete: (p) => unwrap(ipc.shopAccountDelete({ id: Number(p?.id) || 0 })),
    reveal: (p) => unwrap(ipc.shopAccountReveal({ id: Number(p?.id) || 0, field: p?.field })),
    batchUpdate: (p) => unwrap(ipc.shopAccountBatchUpdate(p)),
  },

  // 「订单归类」业务域：视觉指纹与订单明细持久化（语义化操作，禁止任意 SQL）
  'order-insight': {
    ensure: () => unwrap(ipc.orderDbEnsure()),
    imageFind: (p) => unwrap(ipc.orderImageFind(String(p?.fingerprint ?? ''))),
    imageSave: (p) => unwrap(ipc.orderImageSave(p)),
    insert: (p) => unwrap(ipc.orderInsert(p)),
    groupStats: (p) => unwrap(ipc.orderGroupStats(Array.isArray(p?.dimensions) ? p.dimensions : [])),
    list: (p) => unwrap(ipc.orderList(p && typeof p === 'object' ? p : {})),
    clear: () => unwrap(ipc.orderClear()),
    downloadImage: (p) => unwrap(ipc.orderDownloadImage(String(p?.url ?? ''))),
    readImage: (p) => unwrap(ipc.orderReadImage(String(p?.localPath ?? ''))),
    readLocalImage: (p) => unwrap(ipc.orderReadLocalImage(String(p?.localPath ?? ''))),
    imageThumb: (p) => unwrap(ipc.orderImageThumb({ localPath: String(p?.localPath ?? '') })),
    imageThumbBatch: (p) => unwrap(ipc.orderImageThumbBatch(Array.isArray(p?.items) ? p.items : [])),
    cleanupOrphanImages: () => unwrap(ipc.orderCleanupOrphanImages()),
    apiKeySet: (p) => unwrap(ipc.orderApiKeySet(String(p?.apiKey ?? ''))),
    // Excel 读取/写出在宿主完成（岛内不打包 xlsx 依赖，岛侧只传/收 JSON）
    parseExcel: async (p) => {
      const r = await ipc.importExcelByPath(String(p?.filePath ?? ''));
      if (!r.success || !r.data) throw new Error(r.error || '读取 Excel 失败');
      const { parseExcelBuffer } = await import('@/core/services/excel');
      const parsed = parseExcelBuffer(r.data.data);
      return { headers: parsed.headers, records: parsed.records ?? [] };
    },
    exportWorkbook: async (p) => {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const sheets = Array.isArray(p?.sheets) ? p.sheets : [];
      for (const s of sheets) {
        const rows = Array.isArray(s?.rows) ? s.rows : [];
        if (!rows.length) continue;
        const name = String(s?.name || 'Sheet').slice(0, 31);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
      }
      const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      return unwrap(ipc.orderExportExcel(buffer, String(p?.fileName || '导出.xlsx')));
    },
    // 视觉识别（Key 只入不出：岛侧传引擎配置不含密钥，宿主从加密存储补齐后发起调用）
    analyze: async (p) => {
      const keyResult = await ipc.orderApiKeyGet();
      const apiKey = keyResult.success && keyResult.data ? String(keyResult.data.apiKey || '') : '';
      if (!apiKey) throw new Error('未配置视觉模型 API Key，请先在「识别设置」中填写并保存');
      const { createVisionEngine } = await import('@/core/ai');
      const provider = String(p?.provider ?? 'custom');
      const engine = createVisionEngine({
        provider: (provider === 'qwen' || provider === 'openai' ? provider : 'custom') as 'qwen' | 'openai' | 'custom',
        baseUrl: String(p?.baseUrl ?? ''),
        model: String(p?.model ?? ''),
        temperature: Number.isFinite(Number(p?.temperature)) ? Number(p.temperature) : 0.1,
        apiKey,
      });
      return engine.analyze(String(p?.dataUrl ?? ''));
    },
    // 处理队列（oi_queue）：批次生命周期 + 断点续跑
    queueEnqueue: (p) => unwrap(ipc.orderQueueEnqueue(p)),
    queueStats: (p) => unwrap(ipc.orderQueueStats(p && typeof p === 'object' ? p : {})),
    queueList: (p) => unwrap(ipc.orderQueueList(p && typeof p === 'object' ? p : {})),
    queueGet: (p) => unwrap(ipc.orderQueueGet(Number(p?.id) || 0)),
    queueNextPending: (p) => unwrap(ipc.orderQueueNextPending(p && typeof p === 'object' ? p : {})),
    queueSetResult: (p) => unwrap(ipc.orderQueueSetResult(p)),
    queuePatch: (p) => unwrap(ipc.orderQueuePatch(p)),
    queueRetryErrors: (p) => unwrap(ipc.orderQueueRetryErrors(p && typeof p === 'object' ? p : {})),
    queuePurgeDone: (p) => unwrap(ipc.orderQueuePurgeDone(p && typeof p === 'object' ? p : {})),
    queueLastActive: () => unwrap(ipc.orderQueueLastActive()),
    // 款式库（oi_styles）：指纹归并命名
    styleResolve: (p) => unwrap(ipc.orderStyleResolve(p)),
    styleList: () => unwrap(ipc.orderStyleList()),
    styleDelete: (p) => unwrap(ipc.orderStyleDelete({ id: Number(p?.id) || 0 })),
    styleAssign: (p) => unwrap(ipc.orderStyleAssign(p)),
    styleRename: (p) => unwrap(ipc.orderStyleRename(p)),
    styleImport: (p) => unwrap(ipc.orderStyleImport({ styles: Array.isArray(p?.styles) ? p.styles : [] })),
    // 订单维护
    update: (p) => unwrap(ipc.orderUpdate(p)),
    updateStatus: (p) => unwrap(ipc.orderUpdateStatus(p)),
    delete: (p) => unwrap(ipc.orderDelete({ id: Number(p?.id) || 0 })),
    markCorrected: (p) => unwrap(ipc.orderMarkCorrected(p)),
  },

  // 「拿货对账」业务域：供应商 / 拿货单 / 付款 / 对账 / 待拿货缺口
  purchase: {
    ensure: () => unwrap(ipc.purchaseDbEnsure()),
    supplierList: () => unwrap(ipc.purchaseSupplierList()),
    supplierCreate: (p) => unwrap(ipc.purchaseSupplierCreate(p)),
    supplierUpdate: (p) => unwrap(ipc.purchaseSupplierUpdate(p)),
    supplierDelete: (p) => unwrap(ipc.purchaseSupplierDelete({ id: Number(p?.id) || 0 })),
    orderList: () => unwrap(ipc.purchaseOrderList()),
    orderGet: (p) => unwrap(ipc.purchaseOrderGet({ id: Number(p?.id) || 0 })),
    orderCreate: (p) => unwrap(ipc.purchaseOrderCreate(p)),
    orderUpdate: (p) => unwrap(ipc.purchaseOrderUpdate(p)),
    orderSubmit: (p) => unwrap(ipc.purchaseOrderSubmit({ id: Number(p?.id) || 0 })),
    orderDelete: (p) => unwrap(ipc.purchaseOrderDelete({ id: Number(p?.id) || 0 })),
    paymentList: (p) => unwrap(ipc.purchasePaymentList(p && typeof p === 'object' ? p : {})),
    paymentAdd: (p) => unwrap(ipc.purchasePaymentAdd(p)),
    paymentDelete: (p) => unwrap(ipc.purchasePaymentDelete({ id: Number(p?.id) || 0 })),
    reconciliation: (p) => unwrap(ipc.purchaseReconciliation(p && typeof p === 'object' ? p : {})),
    outstanding: () => unwrap(ipc.purchaseOutstanding()),
    ignoreAdd: (p) => unwrap(ipc.purchaseIgnoreAdd(p)),
    ignoreRemove: (p) => unwrap(ipc.purchaseIgnoreRemove(p)),
    ignoreList: () => unwrap(ipc.purchaseIgnoreList()),
    priceHistory: (p) => unwrap(ipc.purchasePriceHistory(p && typeof p === 'object' ? p : {})),
    shopAllocation: (p) => unwrap(ipc.purchaseShopAllocation(p && typeof p === 'object' ? p : {})),
    shopAllocationDetail: (p) => unwrap(ipc.purchaseShopAllocationDetail(p && typeof p === 'object' ? p : {})),
    exportExcel: (p) => unwrap(ipc.purchaseExportExcel(p)),
    // D3 单向通道：向「利润追踪」导出只读拿货成本快照
    costSnapshot: () => unwrap(ipc.purchaseCostSnapshot()),
  },

  // 「利润追踪」业务域：AE 订单明细 / 利润引擎 / 成本衔接 / 汇率（只读为主，写入仅语义化操作）
  ae: {
    ensure: () => unwrap(ipc.aeDbEnsure()),
    receiverStatus: () => unwrap(ipc.aeReceiverStatus()),
    orderList: (p) =>
      unwrap(
        ipc.aeOrderList({
          offset: Number.isFinite(Number(p?.offset)) ? Math.max(0, Math.trunc(Number(p.offset))) : 0,
          limit: Math.min(Math.max(Number(p?.limit) || 50, 1), 200),
          search: typeof p?.search === 'string' ? p.search.slice(0, 120) : '',
        }),
      ),
    summary: () => unwrap(ipc.aeSummary()),
    profitStats: (p) =>
      unwrap(
        ipc.aeProfitStats({
          granularity: p?.granularity === 'day' ? 'day' : 'month',
          rangeDays: (() => {
            const n = Number(p?.rangeDays);
            if (!Number.isFinite(n)) return 90;
            return Math.min(Math.max(Math.trunc(n), 1), 1095);
          })(),
        }),
      ),
    costMapList: () => unwrap(ipc.aeCostMapList()),
    costMapImport: (p) =>
      unwrap(
        ipc.aeCostMapImport({
          items: (Array.isArray(p?.items) ? p.items : []).slice(0, 5000).map((it: any) => ({
            styleCode: String(it?.styleCode ?? '').slice(0, 64),
            styleName: it?.styleName == null ? '' : String(it.styleName).slice(0, 200),
            unitPriceCents: Number.isFinite(Number(it?.unitPriceCents)) ? Math.trunc(Number(it.unitPriceCents)) : 0,
            sampleCount: Number.isFinite(Number(it?.sampleCount)) ? Math.trunc(Number(it.sampleCount)) : 0,
            lastBizDate: it?.lastBizDate == null ? '' : String(it.lastBizDate).slice(0, 32),
          })),
        }),
      ),
    rateList: () => unwrap(ipc.aeRateList()),
    rateUpsert: (p) =>
      unwrap(
        ipc.aeRateUpsert({
          fromCurrency: String(p?.fromCurrency ?? '').toUpperCase().slice(0, 8),
          rateToCny: Number.isFinite(Number(p?.rateToCny)) ? Number(p.rateToCny) : 0,
        }),
      ),
  },
};

/** 邮件白名单（只读 IMAP 语义；凭据与账号维护由宿主完成） */
const MAIL_OPS: Record<string, (payload: any) => Promise<unknown>> = {
  ensure: () => unwrap(ipc.mailDbEnsure()),
  stats: () => unwrap(ipc.mailStats()),
  accountList: () => unwrap(ipc.mailAccountList()),
  accountUpsert: (p) => unwrap(ipc.mailAccountUpsert(p)),
  accountDelete: (p) => unwrap(ipc.mailAccountDelete({ id: Number(p?.id) || 0 })),
  accountTest: (p) => unwrap(ipc.mailAccountTest(p)),
  syncNow: (p) => unwrap(ipc.mailSyncNow(p?.accountId == null ? undefined : { accountId: Number(p.accountId) || 0 })),
  syncCancel: (p) => unwrap(ipc.mailSyncCancel({ accountId: Number(p?.accountId) || 0 })),
  syncState: () => unwrap(ipc.mailSyncState()),
  messagesList: (p) => unwrap(ipc.mailMessagesList(p && typeof p === 'object' ? p : undefined)),
  messageGet: (p) => unwrap(ipc.mailMessageGet({ id: Number(p?.id) || 0 })),
  messageRead: (p) => unwrap(ipc.mailMessageRead(p)),
  bodyFetch: (p) =>
    unwrap(
      ipc.mailBodyFetch({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        accountId: p?.accountId == null ? undefined : Number(p.accountId) || 0,
      }),
    ),
  attachmentSave: (p) =>
    unwrap(
      ipc.mailAttachmentSave({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      }),
    ),
  attachmentPreview: (p) =>
    unwrap(
      ipc.mailAttachmentPreview({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      }),
    ),
  attachmentOpen: (p) =>
    unwrap(
      ipc.mailAttachmentOpen({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      }),
    ),
  foldersList: (p) => unwrap(ipc.mailFoldersList({ accountId: Number(p?.accountId) || 0 })),
  cacheStatus: () => unwrap(ipc.mailCacheStatus()),
  cacheClear: () => unwrap(ipc.mailCacheClear()),
  cacheOpen: () => unwrap(ipc.mailCacheOpen()),
  ftsStatus: () => unwrap(ipc.mailFtsStatus()),
  ftsRebuild: () => unwrap(ipc.mailFtsRebuild()),
  purge: (p) => unwrap(ipc.mailPurge(p && typeof p === 'object' ? p : undefined)),
  providers: () => unwrap(ipc.mailProviderList()),
};

/**
 * 创建 HostApi 渲染层 trusted 实现。
 * storage 收敛为命名空间持久化（modules.<ns>，复用 useModuleStorage 底层 IPC）；
 * db/mail 收敛为"白名单 domain + op"（不放行任意 SQL / 不接触凭据）。
 */
export function createHostApi(): HostApi {
  const env = createEnv();

  const host: HostApi = {
    storage: {
      async load<T>(ns: string): Promise<T | undefined> {
        // 底层存储按命名空间返回 Partial 对象；宿主层显式收窄为 T（命名空间即记录对象）
        const data = await useModuleStorage(ns).load();
        return data === null || data === undefined ? undefined : (data as unknown as T);
      },
      async save<T>(ns: string, v: T): Promise<void> {
        await useModuleStorage(ns).save(v as Record<string, unknown>);
      },
      async clear(ns: string): Promise<void> {
        await useModuleStorage(ns).clear();
      },
    },
    clipboard: {
      async writeText(text: string): Promise<void> {
        const ok = await writeClipboard(text);
        if (!ok) throw new Error('clipboard write rejected by host');
      },
    },
    http: {
      async get<T>(url: string, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.get<T>(url, opts);
        return res.data as T;
      },
      async post<T>(url: string, body?: unknown, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.post<T>(url, body, opts);
        return res.data as T;
      },
    },
    dialog: {
      async openFile(opts: DialogOptions): Promise<FilePayload | null> {
        if (opts.kind === 'excel') {
          const f = await selectExcelFile();
          if (!f) return null;
          return { kind: 'excel', filePath: f.filePath, data: f.data };
        }
        if (opts.kind === 'template') {
          const f = await selectTemplateFile();
          if (!f) return null;
          return { kind: 'template', filePath: f.filePath, content: f.content };
        }
        const r = await ipc.selectDirectory();
        if (!r.success || !r.data) return null;
        return { kind: 'directory', filePath: r.data };
      },
    },
    ui: {
      openSettings(category?: string, tab?: string): void {
        // 对接 AppShell 已监听的 open-settings 事件，沿用现有"dispatch 事件定位设置"机制
        window.dispatchEvent(new CustomEvent('open-settings', { detail: { category, tab } }));
      },
      notify(o: { kind: 'success' | 'error' | 'info'; text: string }): void {
        toast(o.text, o.kind);
      },
    },
    db: {
      async call<T>(domain: string, op: string, payload?: unknown): Promise<T> {
        const handler = DB_OPS[String(domain || '')]?.[String(op || '')];
        if (!handler) throw new Error(`db 操作未登记: ${String(domain)}.${String(op)}`);
        return (await handler(payload)) as T;
      },
    },
    secrets: {
      // 只暴露"宿主安全存储是否可用"；密文本体永不经过插件（读写经 db 的宿主业务操作完成）
      async status(): Promise<{ secureStorage: boolean }> {
        const r = await ipc.shopAccountSecurity();
        return { secureStorage: !!r.success && !!r.data?.secureStorage };
      },
    },
    mail: {
      async call<T>(op: string, payload?: unknown): Promise<T> {
        const handler = MAIL_OPS[String(op || '')];
        if (!handler) throw new Error(`mail 操作未登记: ${String(op)}`);
        return (await handler(payload)) as T;
      },
    },
    env,
  };

  return host;
}
