// src/modules/order-insight/store.ts
// 「订单归类」模块状态与处理管线：
//   导入 Excel → 逐行：URL 指纹查重 → 下载主图（主进程落盘+内容指纹）→ 指纹查重
//   → 未命中：读图 → AI 识别 → 结果入库 → 订单入库 → 分组统计 → 界面/导出。
// 数据持久化：配置走 useModuleStorage('order-insight')（electron-store）；
//             订单/指纹库走 SQLite（主进程 order-db，渲染层仅经语义化 IPC 访问）。

import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import { useModuleStorage } from '@/core/services/storage';
import { ipc } from '@/core/services/ipc';
import { selectExcelFile } from '@/core/services/dialog';
import { parseExcelBuffer } from '@/core/services/excel';
import { toast } from '@/core/services/toast';
import { createVisionEngine, type VisionEngineConfig } from '@/core/ai';
import {
  classifyResult,
  detectImageColumn,
  detectOrderNoColumn,
  detectOrderTimeColumn,
  detectShopColumn,
  detectSizeColumn,
  normalizeCategory,
  normalizeColor,
} from '@/lib/orderClassifier';
import { pivotRows, dimensionId, fieldLabel, orderStatusLabel, DATE_BUCKET_LABEL, MEASURE_OP_LABEL, type PivotDimension, type PivotMeasure } from '@/lib/aggregator';
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import { detectMultiProductColumns, expandOrderRows } from '@/lib/orderRowSplitter';
import type {
  GroupStat,
  OrderImageRecord,
  OrderRecord,
  OrderQueueRow,
  OrderQueueStats,
  StyleRecord,
  StyleImportItem,
  OrderUpdateInput,
  OrderStatus,
  OrderUpdateStatusInput,
} from '@/types';

const MODULE_ID = 'order-insight';

/** 模块持久化配置（命名空间隔离，含引擎与列配置） */
export interface OrderInsightConfig {
  engine: VisionEngineConfig;
  /** 主图列名 */
  imageColumn: string;
  /** 订单号列名（可空） */
  orderNoColumn: string;
  /** 店铺列名（可空） */
  shopColumn: string;
  /** 尺寸列名（可空） */
  sizeColumn: string;
  /** 下单时间列名（可空） */
  orderTimeColumn: string;
  /** 分组维度（category/color/shop 子集） */
  groupDimensions: string[];
  /** 透视汇总：分组维度（可多选，含日期桶） */
  pivotDimensions: PivotDimension[];
  /** 透视汇总：度量（计数 + 数值聚合） */
  pivotMeasures: PivotMeasure[];
}

const DEFAULT_CONFIG: OrderInsightConfig = {
  engine: { provider: 'qwen', baseUrl: '', model: '', apiKey: '', temperature: 0.1 },
  imageColumn: '',
  orderNoColumn: '',
  shopColumn: '',
  sizeColumn: '',
  orderTimeColumn: '',
  groupDimensions: ['color', 'category'],
  pivotDimensions: [{ field: 'category' }, { field: 'color' }],
  pivotMeasures: [{ id: 'count', field: '', op: 'count', alias: '数量' }],
};

const storage = useModuleStorage<OrderInsightConfig>(MODULE_ID);

/** URL 规范化（与主进程指纹逻辑一致：仅 origin+pathname） */
function normalizeUrlForFingerprint(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** 渲染层用 WebCrypto 计算 SHA-256（URL 规范化指纹的本地查重前置） */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const useOrderInsightStore = defineStore(MODULE_ID, () => {
  // ---- 状态 ----
  const config = ref<OrderInsightConfig>(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  const headers = ref<string[]>([]);
  /** 当前批次号 */
  const queueBatchNo = ref('');
  /** 当前批次队列统计（概览角标/进度用） */
  const queueCounts = ref<OrderQueueStats>({ total: 0, pending: 0, done: 0, error: 0, missing: 0 });
  /** 失败清单预览（服务端按 status='error' 分页拉取，不再整批镜像后过滤） */
  const queueErrorRows = ref<OrderQueueRow[]>([]);
  /** 失败清单总数（服务端 COUNT，供"其余 N 条"展示） */
  const queueErrorTotal = ref(0);
  /** 缺图待补预览（服务端 missingOnly：url 为空且未完成的行，含批次内首轮未识别行） */
  const queueMissingRows = ref<Array<{ id: number; orderNo: string; info: string }>>([]);
  /** 缺图待补总数（服务端 COUNT，供"共 N 条"展示） */
  const queueMissingTotal = ref(0);
  /** 全量订单镜像（orders）是否已过期：纠正/标记/删除/发货等行级操作后置位，
   *  进入「数据汇总」概览（透视/导出依赖全量镜像）时按需全量刷新 */
  const ordersDirty = ref(false);
  /** 是否存在上次遗留批次（重启后恢复提示用，识别完成清空） */
  const hasLegacyQueue = ref(false);
  /** 多产品拆行探测到的「产品信息」列（仅本次导入有效，用于缺图列表展示摘要） */
  const infoColumn = ref('');
  const processing = ref(false);
  /** 用户/短路请求停止当前识别流程（runProcess 在每个批次间隙检查） */
  const cancelRequested = ref(false);
  /** 上次识别流程是否被用户停止或自动短路（供 View 决定是否自动跳转「数据纠正」Tab） */
  const lastRunCancelled = ref(false);
  /** 订单总数（列表分页回传；仅统计用，不参与行渲染） */
  const orderTotal = ref(0);
  /** 订单同步上限：超过时告警（统计/汇总可能不全），避免无界拉取 */
  const ORDER_SYNC_CAP = 20000;
  const ORDER_PAGE_SIZE = 1000;
  /** 队列失败/缺图清单预览窗口（其余条数用服务端 total 展示） */
  const QUEUE_PREVIEW_LIMIT = 50;
  /** 数据纠正 Tab 每页行数（服务端分页） */
  const CORR_PAGE_SIZE = 20;
  /** 订单明细 Tab 每页行数（服务端分页） */
  const DETAIL_PAGE_SIZE = 50;
  /** 同因连续失败自动短路阈值（API Key 无效/网络不可达等整批失败场景及时止损） */
  const STOP_AFTER_CONSECUTIVE_SAME_ERROR = 10;
  /** 缩略图合批：单次批量 IPC 往返上限 */
  const THUMB_BATCH_MAX = 40;
  /** 缩略图合批：收集窗口（一帧；窗口内同屏可见图合并一次 IPC，消除逐张单发） */
  const THUMB_BATCH_FLUSH_MS = 16;
  const progress = ref({ total: 0, done: 0, failed: 0, missing: 0, localHit: 0, aiHit: 0, current: '' });
  /** 本次识别流程的失败明细（url + 错误），供界面展示/复制，便于区分"个别图片问题"与"整体配置问题" */
  const failLogs = ref<{ url: string; error: string }[]>([]);
  /** 产品库导入中（逐行图片识别耗时）：true 时导入按钮 loading；importTip 为进度提示 */
  const importing = ref(false);
  const importTip = ref('');
  /** 识别流程完成计数：每次 runProcess 结束 +1，供 View 监听后自动跳转「数据纠正」 */
  const processTicks = ref(0);
  const orders = ref<OrderRecord[]>([]);
  /** 订单状态筛选：all=全部 / pending=未发货 / shipped=已发货（仅作用于数据汇总与导出） */
  const statusFilter = ref<OrderStatus | 'all'>('all');
  const groups = ref<GroupStat[]>([]);
  const styles = ref<StyleRecord[]>([]);
  const imageDataCache = ref(new Map<string, string>()); // localPath -> 原图 dataUrl（LRU 上限，避免只增不清）
  const imageThumbCache = ref(new Map<string, string>()); // `localPath|maxEdge` -> 缩略图 dataUrl（渲染层 LRU 去重同图多引用）
  const IMAGE_DATA_CACHE_MAX = 80;
  const IMAGE_THUMB_CACHE_MAX = 400;
  /** 识别引擎 API Key：仅运行时持有，经主进程 safeStorage 加密落盘；不随 config 明文持久化 */
  const apiKey = ref('');

  // ---- 初始化 / 持久化 ----
  async function loadState() {
    try {
      const saved = await storage.load();
      // API Key 安全化（P2）：旧版明文存 config.engine.apiKey → 迁入主进程加密存储后剥离明文；
      // 新版密钥只存系统钥匙串侧（order-api-key-get），config 不再携带。
      const legacyKey = String(
        (saved as { engine?: { apiKey?: unknown } } | undefined)?.engine?.apiKey ?? '',
      ).trim();
      let secured = '';
      const secRes = await ipc.orderApiKeyGet();
      if (secRes.success) secured = String(secRes.data?.apiKey ?? '');
      if (legacyKey && !secured) {
        // 一次迁移（旧版本首次升级）：写入加密存储并保留运行时值
        await ipc.orderApiKeySet(legacyKey);
        apiKey.value = legacyKey;
      } else {
        apiKey.value = secured;
      }
      if (saved) {
        config.value = {
          ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
          ...saved,
          engine: { ...DEFAULT_CONFIG.engine, ...(saved.engine ?? {}), apiKey: '' },
          groupDimensions:
            Array.isArray(saved.groupDimensions) && saved.groupDimensions.length
              ? saved.groupDimensions
              : DEFAULT_CONFIG.groupDimensions,
          pivotDimensions: Array.isArray(saved.pivotDimensions)
            ? saved.pivotDimensions
            : DEFAULT_CONFIG.pivotDimensions,
          pivotMeasures: Array.isArray(saved.pivotMeasures)
            ? saved.pivotMeasures
            : DEFAULT_CONFIG.pivotMeasures,
        };
        // 旧版残留明文 key 时立即落盘清理（config 中 apiKey 已剥离为空）
        if (legacyKey) saveState();
      }
    } catch (e) {
      console.error('load order-insight config failed:', e);
    }
  }

  function saveState() {
    // 深拷贝后再存，避免把不可克隆/运行时残留值（如引擎实例引用）带入 IPC；
    // 同时剥离 engine.apiKey：安全敏感凭据只走 order-api-key-set（safeStorage 加密），不落明文 store
    const out = JSON.parse(JSON.stringify(config.value)) as OrderInsightConfig;
    out.engine.apiKey = '';
    storage.scheduleSave(out);
  }

  /** 合成运行时引擎配置：apiKey 从加密存储的运行时值注入（config.engine 恒不持有明文） */
  function engineConfig(): VisionEngineConfig {
    return { ...config.value.engine, apiKey: apiKey.value };
  }

  /** 保存引擎 API Key：safeStorage 加密落盘（主进程）；空串 = 清除 */
  async function setApiKey(key: string) {
    const k = (key ?? '').trim();
    const r = await ipc.orderApiKeySet(k);
    if (!r.success) {
      toast('保存 API Key 失败: ' + (r.error || '未知错误'), 'error');
      return false;
    }
    apiKey.value = k;
    return true;
  }

  // ---- 待识别队列（SQLite oi_queue）----
  /** order-queue-list 分页返回兼容：新版主进程 { rows, total }；旧版直接返回数组时包裹为 { rows, total } */
  function normalizeQueuePage(
    res: { success: boolean; data?: unknown },
  ): { rows: OrderQueueRow[]; total: number } {
    const d = res.data;
    if (d && typeof d === 'object' && !Array.isArray(d) && Array.isArray((d as { rows?: unknown }).rows)) {
      const rows = (d as { rows: OrderQueueRow[] }).rows;
      return { rows, total: Number((d as { total?: unknown }).total ?? rows.length) };
    }
    if (Array.isArray(d)) return { rows: d as OrderQueueRow[], total: d.length };
    return { rows: [], total: 0 };
  }

  /** 拉取当前批次队列统计与失败/缺图预览（导入后/处理后/恢复时刷新）。
   *  失败/缺图清单由主进程按 status/missingOnly 分页返回（各取前 QUEUE_PREVIEW_LIMIT 条 + 总数），
   *  不再把整批（旧逻辑上限 500 行）拉到渲染层镜像后过滤。 */
  async function refreshQueue() {
    if (!queueBatchNo.value) {
      queueCounts.value = { total: 0, pending: 0, done: 0, error: 0, missing: 0 };
      queueErrorRows.value = [];
      queueErrorTotal.value = 0;
      queueMissingRows.value = [];
      queueMissingTotal.value = 0;
      return;
    }
    try {
      const [e, m, s] = await Promise.all([
        ipc.orderQueueList(toRaw({ batchNo: queueBatchNo.value, status: 'error', limit: QUEUE_PREVIEW_LIMIT })),
        ipc.orderQueueList(toRaw({ batchNo: queueBatchNo.value, missingOnly: true, limit: QUEUE_PREVIEW_LIMIT })),
        ipc.orderQueueStats(toRaw({ batchNo: queueBatchNo.value })),
      ]);
      const err = normalizeQueuePage(e);
      queueErrorRows.value = err.rows;
      queueErrorTotal.value = err.total;
      const mis = normalizeQueuePage(m);
      // 概览缺图清单仅消费 id/orderNo/info（模板与旧 missingRows 一致）
      queueMissingRows.value = mis.rows.map((r) => ({ id: r.id, orderNo: r.orderNo, info: r.info }));
      queueMissingTotal.value = mis.total;
      if (s.success && s.data) queueCounts.value = s.data;
    } catch (e: unknown) {
      console.warn('[order-insight] refreshQueue failed:', e);
    }
  }

  // ---- 纠正 / 明细：服务端分页浏览 ----
  // 主进程按 offset/limit + corrected/search 返回 { rows, total }；渲染层不再持有全量镜像翻页，
  // 行级操作后仅刷新当前页与汇总计数（见 lightSync），全量订单镜像留给「数据汇总」按需同步。
  /** order-list 返回兼容：新版 { rows, total }；旧版直接返回数组时包裹 */
  function normalizeOrderPage(res: { success: boolean; data?: unknown }): {
    rows: OrderRecord[];
    total: number;
  } {
    const d = res.data;
    if (d && typeof d === 'object' && !Array.isArray(d) && Array.isArray((d as { rows?: unknown }).rows)) {
      const rows = (d as { rows: OrderRecord[] }).rows;
      return { rows, total: Number((d as { total?: unknown }).total ?? rows.length) };
    }
    if (Array.isArray(d)) return { rows: d as OrderRecord[], total: d.length };
    return { rows: [], total: 0 };
  }

  /** 数据纠正 Tab（corrected=false 待核对订单）当前页与总数 */
  const pendingRows = ref<OrderRecord[]>([]);
  const pendingTotal = ref(0);
  const pendingSearch = ref('');
  const pendingPageNo = ref(1);
  const pendingLoading = ref(false);
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadPendingPage(pageNo: number = pendingPageNo.value) {
    let page = Math.max(Number(pageNo) || 1, 1);
    pendingLoading.value = true;
    try {
      for (;;) {
        const r = await ipc.orderList(
          toRaw({
            offset: (page - 1) * CORR_PAGE_SIZE,
            limit: CORR_PAGE_SIZE,
            corrected: false,
            search: pendingSearch.value.trim() || undefined,
          }),
        );
        const d = normalizeOrderPage(r);
        if (d.rows.length || d.total === 0 || page <= 1) {
          pendingRows.value = d.rows;
          pendingTotal.value = d.total;
          pendingPageNo.value = page;
          break;
        }
        // 行被删除/确认后当前页可能已空 → 回退到最后有数据的页
        page = Math.max(1, Math.ceil(d.total / CORR_PAGE_SIZE));
      }
    } catch (e: unknown) {
      console.warn('[order-insight] loadPendingPage failed:', e);
    } finally {
      pendingLoading.value = false;
    }
  }

  /** 纠正 Tab 搜索输入（防抖 300ms 后回第 1 页查询） */
  function setPendingSearch(q: string) {
    pendingSearch.value = (q ?? '').trim();
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => loadPendingPage(1), 300);
  }

  /** 订单明细 Tab（全部订单，可关键字搜索）当前页与总数 */
  const detailRows = ref<OrderRecord[]>([]);
  const detailTotal = ref(0);
  const detailSearch = ref('');
  const detailPageNo = ref(1);
  const detailLoading = ref(false);
  let detailTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadDetailPage(pageNo: number = detailPageNo.value) {
    let page = Math.max(Number(pageNo) || 1, 1);
    detailLoading.value = true;
    try {
      for (;;) {
        const r = await ipc.orderList(
          toRaw({
            offset: (page - 1) * DETAIL_PAGE_SIZE,
            limit: DETAIL_PAGE_SIZE,
            search: detailSearch.value.trim() || undefined,
          }),
        );
        const d = normalizeOrderPage(r);
        if (d.rows.length || d.total === 0 || page <= 1) {
          detailRows.value = d.rows;
          detailTotal.value = d.total;
          detailPageNo.value = page;
          break;
        }
        // 行被删除后当前页可能已空 → 回退到最后有数据的页
        page = Math.max(1, Math.ceil(d.total / DETAIL_PAGE_SIZE));
      }
    } catch (e: unknown) {
      console.warn('[order-insight] loadDetailPage failed:', e);
    } finally {
      detailLoading.value = false;
    }
  }

  /** 明细 Tab 搜索输入（防抖 300ms 后回第 1 页查询） */
  function setDetailSearch(q: string) {
    detailSearch.value = (q ?? '').trim();
    if (detailTimer) clearTimeout(detailTimer);
    detailTimer = setTimeout(() => loadDetailPage(1), 300);
  }

  /** 进入模块/启动时：若存在上次遗留的未处理批次（失败/缺图/待处理）则自动恢复，保证重启不丢 */
  async function restoreLastQueue() {
    try {
      const r = await ipc.orderQueueLastActive();
      if (!r.success || !r.data) return;
      queueBatchNo.value = r.data.batchNo;
      hasLegacyQueue.value = true;
      await refreshQueue();
    } catch (e: unknown) {
      console.warn('[order-insight] restoreLastQueue failed:', e);
    }
  }

  // ---- 导入 ----
  async function importExcel() {
    if (processing.value) {
      toast('识别进行中，请先点击「停止」结束本轮后再上传新文件', 'error');
      return;
    }
    try {
      const sel = await selectExcelFile();
      if (!sel) return;
      const parsed = parseExcelBuffer(sel.data);
      headers.value = parsed.headers;
      const rawRows = parsed.records.map((r) => r.fields ?? {});
      // 自动探测列（未配置或已不存在时）：主图 + 订单号/店铺/尺寸/下单时间列
      const detectColumns: Array<[keyof Pick<OrderInsightConfig, 'imageColumn' | 'orderNoColumn' | 'shopColumn' | 'sizeColumn' | 'orderTimeColumn'>, (h: string[]) => string]> = [
        ['imageColumn', detectImageColumn],
        ['orderNoColumn', detectOrderNoColumn],
        ['shopColumn', detectShopColumn],
        ['sizeColumn', detectSizeColumn],
        ['orderTimeColumn', detectOrderTimeColumn],
      ];
      let changed = false;
      for (const [key, detect] of detectColumns) {
        const cur = config.value[key] ?? '';
        if (!cur || !headers.value.includes(cur)) {
          (config.value[key] as string) = detect(headers.value);
          changed = true;
        }
      }
      if (changed) saveState();
      // 一订单多产品拆行：按「产品数量」列展开为产品级记录；缺图产品保留空图片记录待补图
      const mpc = detectMultiProductColumns(headers.value, rawRows, {
        imageColumn: config.value.imageColumn,
        sizeColumn: config.value.sizeColumn,
      });
      const expanded = expandOrderRows(rawRows, mpc);
      if (!expanded.rows.length) {
        toast('导入失败：未解析到数据行，请确认 Excel 首行为表头且包含数据', 'error');
        return;
      }
      infoColumn.value = mpc?.info ?? '';
      // 上次批次仍有未完成记录（待处理/失败/缺图）时，先确认再开新批次，避免静默丢弃旧批次待办
      const old = queueCounts.value;
      if (queueBatchNo.value && (old.pending > 0 || old.error > 0 || old.missing > 0)) {
        const unfinished = old.pending + old.error + old.missing;
        const ok = window.confirm(
          `上次批次还有 ${unfinished} 条未完成记录（待处理 ${old.pending} / 失败 ${old.error} / 缺图 ${old.missing}）。\n` +
            '导入新订单后旧批次未完成记录不再显示；建议先重试/补图处理完再导入。\n确认导入新数据？',
        );
        if (!ok) return;
      }
      // 新批次：把解析出的全部行整批写入持久化队列（SQLite oi_queue）。
      // 识别失败/缺图的行保留在队列，重启不丢、可增量重试；成功行处理完自动清理。
      const batchNo = 'b' + Date.now();
      const imageCol = config.value.imageColumn;
      const orderNoCol = config.value.orderNoColumn;
      const rows = expanded.rows.map((r) => ({
        rawFields: toRaw(r) as Record<string, string>,
        url: imageCol ? (r[imageCol] ?? '').trim() : '',
        orderNo: orderNoCol ? (r[orderNoCol] ?? '') : '',
        info: (r[infoColumn.value] ?? '').slice(0, 300),
      }));
      const en = await ipc.orderQueueEnqueue(toRaw({ batchNo, rows }));
      if (!en.success) throw new Error(en.error || '写入识别队列失败');
      // 入队成功后才切换当前批次（入队失败则保持旧批次可继续重试）
      queueBatchNo.value = batchNo;
      hasLegacyQueue.value = false;
      await refreshQueue();
      await refreshStats();
      let tip = '已导入 ' + queueCounts.value.total + ' 条记录（已入待识别队列）';
      if (expanded.expanded > 0) tip += '，含 ' + expanded.expanded + ' 个多产品订单已拆分';
      if (expanded.missingImageCount > 0) tip += '，其中 ' + expanded.missingImageCount + ' 条缺图（概览底部可补图）';
      toast(tip, expanded.missingImageCount > 0 ? 'info' : 'success');
    } catch (e: unknown) {
      toast('导入失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
    }
  }

  // ---- 处理管线 ----
  async function runProcess() {
    if (processing.value) return;
    if (!apiKey.value) {
      toast('请先到 设置 → 订单归类 配置 API Key', 'error');
      return;
    }
    if (!queueBatchNo.value) {
      toast('请先导入订单 Excel', 'error');
      return;
    }
    // 快照本批号：识别循环全程只消费该批次；即使队列中途被切换也不会串处理别的批次
    const runBatchNo = queueBatchNo.value;
    cancelRequested.value = false;
    lastRunCancelled.value = false;
    // 统计本次待处理规模（含上次失败待重试行）
    await refreshQueue();
    const stats = queueCounts.value;
    const total = stats.pending + stats.error;
    if (total === 0) {
      toast('当前批次没有待处理的记录，请先导入订单 Excel', 'info');
      return;
    }
    // 失败行转回待处理（error → pending，累计失败次数保留在队列行上）
    await ipc.orderQueueRetryErrors(toRaw({ batchNo: runBatchNo }));
    const engine = createVisionEngine(engineConfig());
    processing.value = true;
    failLogs.value = [];
    progress.value = { total, done: 0, failed: 0, missing: 0, localHit: 0, aiHit: 0, current: '' };
    try {
      // 从队列分批消费待处理行（缺图行在首轮转 missing 保留待办，补图后自动回 pending）
      let afterId = 0;
      let lastErr = '';
      let sameErrCount = 0;
      /** 熔断原因（同因连续失败自动短路时记录，用于 toast 区分「自动停止」与「手动停止」） */
      let circuitReason = '';
      outer: for (;;) {
        const batch = await ipc.orderQueueNextPending(
          toRaw({ batchNo: runBatchNo, afterId, limit: 20 }),
        );
        const rows = batch.success && batch.data ? batch.data : [];
        if (!rows.length) break;
        afterId = rows[rows.length - 1].id;
        for (const q of rows) {
          // 取消/停止：剩余行保持原状（留在队列），可随时继续处理
          if (cancelRequested.value) break outer;
          const url = (q.url ?? '').trim();
          if (!url) {
            progress.value.missing += 1;
            await ipc.orderQueueSetResult(toRaw({ id: q.id, status: 'missing' }));
            continue;
          }
          progress.value.current = '处理 ' + url.slice(0, 48) + '…';
          try {
            // processOne 返回识别来源：local=本地指纹匹配命中(未调 AI) / ai=实际 AI 识别
            const source = await processOne(q.rawFields, url, engine);
            await ipc.orderQueueSetResult(toRaw({ id: q.id, status: 'done' }));
            progress.value.done += 1;
            if (source === 'local') progress.value.localHit += 1;
            else progress.value.aiHit += 1;
            // 成功即重置同因计数器（个别偶发失败不影响继续）
            lastErr = '';
            sameErrCount = 0;
          } catch (e: unknown) {
            progress.value.failed += 1;
            const err = e instanceof Error ? e.message : '未知错误';
            await ipc.orderQueueSetResult(toRaw({ id: q.id, status: 'error', error: err }));
            failLogs.value.push({ url, error: err });
            if (failLogs.value.length > 50) failLogs.value.shift(); // 只保留最近 50 条，避免超长
            console.error('process order row failed:', url, e);
            // 同因连续失败自动短路：大概率是 API Key 无效 / 网络不可达等整体性配置问题
            if (err === lastErr) sameErrCount += 1;
            else {
              lastErr = err;
              sameErrCount = 1;
            }
            if (sameErrCount >= STOP_AFTER_CONSECUTIVE_SAME_ERROR) {
              cancelRequested.value = true;
              circuitReason = err;
              console.warn(
                `[order-insight] 连续 ${sameErrCount} 条相同错误已自动停止，最后错误：${err}`,
              );
              break outer;
            }
          }
        }
      }
      const stopped = cancelRequested.value;
      // 清理本批次成功行（释放空间）；失败/缺图行保留为待办，可随时重试
      await ipc.orderQueuePurgeDone(toRaw({ batchNo: runBatchNo }));
      hasLegacyQueue.value = false;
      await refreshQueue();
      await refreshStats();
      let msg: string;
      let toastType: 'success' | 'info' | 'error' = 'success';
      if (stopped) {
        lastRunCancelled.value = true;
        if (circuitReason) {
          // 自动熔断：整体性配置问题（API Key 无效/网络不可达等），提示排查方向
          msg =
            '自动停止：连续 ' + STOP_AFTER_CONSECUTIVE_SAME_ERROR + ' 条相同错误（' + circuitReason +
            '）。成功 ' + progress.value.done + '，失败 ' + progress.value.failed +
            '，缺图 ' + progress.value.missing +
            ' 条。请检查 API Key / 网络后重试，其余仍在队列';
          toastType = 'error';
        } else {
          msg =
            '已停止：成功 ' + progress.value.done + '，失败 ' + progress.value.failed +
            '，缺图 ' + progress.value.missing +
            ' 条（已处理结果保留，其余仍在队列可随时继续）';
          toastType = 'info';
        }
      } else {
        msg = '处理完成：成功 ' + progress.value.done + '，失败 ' + progress.value.failed;
        if (progress.value.missing > 0) msg += '，缺图 ' + progress.value.missing + ' 条（概览底部补图后重新处理）';
        // 成功中区分识别来源：本地指纹匹配命中（未调 AI）与 AI 识别
        if (progress.value.localHit > 0 || progress.value.aiHit > 0) {
          msg += '（本地匹配 ' + progress.value.localHit + ' 条 / AI 识别 ' + progress.value.aiHit + ' 条）';
        }
        if (progress.value.failed > 0) msg += '（失败明细见概览页，可复制后排查）';
        toastType = progress.value.failed > 0 ? 'error' : progress.value.missing > 0 ? 'info' : 'success';
      }
      toast(msg, toastType);
    } catch (e: unknown) {
      // 队列/IPC 级意外异常（行级业务失败已在上方逐行 catch，不会走到这）：
      // 兜底提示中断原因，已处理结果保留，可重新点击继续处理剩余队列
      const msg = e instanceof Error ? e.message : '未知错误';
      console.error('[order-insight] runProcess interrupted:', e);
      toast('识别流程中断: ' + msg + '（已处理结果保留，可重新点击继续）', 'error');
    } finally {
      processing.value = false;
      progress.value.current = '';
      cancelRequested.value = false;
      // 识别流程结束信号：View 监听后仅在「有成功识别且未被停止」时自动定位「数据纠正」Tab
      processTicks.value += 1;
    }
  }

  /** 单条订单：查重 → 下载 → 识别（命中缓存则跳过识别）→ 入库 */
  async function processOne(
    row: Record<string, string>,
    url: string,
    engine: ReturnType<typeof createVisionEngine>,
  ) {
    // 1) URL 规范化指纹查重（免下载）
    const urlFp = await sha256Hex(normalizeUrlForFingerprint(url));
    const found = await ipc.orderImageFind(urlFp);
    let img: OrderImageRecord | null = found.success && found.data ? found.data : null;
    if (!img) {
      // 2) 下载（主进程落盘 + 内容指纹 + 指纹库写入）
      const dl = await ipc.orderDownloadImage(url);
      if (!dl.success || !dl.data) throw new Error(dl.error || '图片下载失败');
      img = dl.data;
    }
    if (!img.id) throw new Error('图片记录缺少 id');

    // 3) 识别（已有 done 结果则直接复用——本地命中；pending/error 需调 AI 重新识别）
    let result: Record<string, unknown> | undefined = img.result;
    let source: 'local' | 'ai' = 'local';
    // 本地直判：图片已归属款色 → 本地库即可确定款编码，识别与款式匹配全部跳过。
    // 覆盖：同 URL 图片重复出现、识别失败(error/pending)后经数据纠正归并过等场景——杜绝重复调 AI。
    if (!img.styleColorId) {
      if (img.status !== 'done' || !img.result) {
        source = 'ai';
        const read = await ipc.orderReadImage(img.localPath);
        if (!read.success || !read.data) throw new Error(read.error || '读取图片失败');
        const rec = await engine.analyze(read.data.dataUrl);
        result = rec as unknown as Record<string, unknown>;
        const saved = await ipc.orderImageSave({
          id: img.id,
          status: 'done',
          resultJson: JSON.stringify(rec),
        });
        if (!saved.success) throw new Error(saved.error || '保存识别结果失败');
      }
    }

    // 4) 归一化 + 订单入库
    const norm = classifyResult({
      category: String(result?.category ?? ''),
      color: String(result?.color ?? ''),
      logo: String(result?.logo ?? ''),
      styleName: String(result?.styleName ?? ''),
    });
    // 4.5) 款式匹配/落库（图片未归属款色时）：识别结果(新识别或缓存) → 款式指纹 → 款编码/款色
    //      幂等：主进程按指纹查款，命中复用；颜色经归一化后查/建款色。
    if (!img.styleColorId) {
      const features = Array.isArray(result?.features)
        ? (result.features as unknown[]).map((f) => String(f ?? '')).filter(Boolean)
        : [];
      const fp = buildStyleFingerprint(norm.category, features);
      if (fp) {
        const resolved = await ipc.orderStyleResolve({
          imageId: img.id,
          fingerprint: fp,
          category: norm.category,
          features,
          color: norm.color,
          styleName: norm.styleName,
        });
        if (!resolved.success) console.warn('款式匹配失败:', resolved.error);
      }
    }
    const order = await ipc.orderInsert({
      imageId: img.id,
      orderNo: row[config.value.orderNoColumn] ?? '',
      shop: row[config.value.shopColumn] ?? '',
      size: row[config.value.sizeColumn] ?? '',
      orderTime: row[config.value.orderTimeColumn] ?? '',
      // row 来自队列行的 rawFields（IPC 返回的普通对象，无需脱壳；保留 toRaw 以防响应式包裹）
      rawFields: toRaw(row),
      category: norm.category,
      color: norm.color,
      logo: norm.logo,
    });
    if (!order.success) throw new Error(order.error || '订单入库失败');
    return source;
  }

  // ---- 统计 / 列表 / 图片 ----
  /** 轻量汇总刷新：分组统计 + 产品库 + 订单总数/待纠正数（不拉全量订单镜像；行级操作后用） */
  async function loadAggregates() {
    try {
      const [g, s, all, pend] = await Promise.all([
        ipc.orderGroupStats(toRaw(config.value.groupDimensions)),
        ipc.orderStyleList(),
        ipc.orderList({ limit: 1 }),
        ipc.orderList({ corrected: false, limit: 1 }),
      ]);
      if (g.success && g.data) groups.value = g.data;
      if (s.success && s.data) styles.value = s.data;
      const allD = normalizeOrderPage(all);
      if (all.success) orderTotal.value = allD.total;
      const pendD = normalizeOrderPage(pend);
      if (pend.success) pendingTotal.value = pendD.total;
    } catch (e: unknown) {
      console.warn('[order-insight] loadAggregates failed:', e);
    }
  }

  /** 行级操作后的轻量同步：队列统计/预览 + 汇总计数 + 纠正/明细当前页。
   *  不再触发全量订单镜像同步；镜像由进入「数据汇总」概览时按 ordersDirty 全量刷新。 */
  async function lightSync() {
    await Promise.all([
      refreshQueue(),
      loadAggregates(),
      loadPendingPage().catch(() => {}),
      loadDetailPage().catch(() => {}),
    ]);
  }

  /** 全量统计刷新（启动 / 导入完成 / 识别完成 / 进入「数据汇总」时按需调用）：
   *  轻量计数（loadAggregates）+ 全量订单镜像同步（orders 供透视/导出/已归类统计）。
   *  注意：纠正/明细等行级操作不调本函数，只走 lightSync，避免每次保存都整批拉订单。 */
  async function refreshStats() {
    await loadAggregates();
    try {
      // 订单列表分页拉取：首屏 + 循环翻页直至总数，消除原先「最多 500 条」截断；
      // 列表已不含 raw_fields 大字段，分页成本低；超过 ORDER_SYNC_CAP 时告警兜底。
      const first = await ipc.orderList({ limit: ORDER_PAGE_SIZE });
      const data = first.data as unknown;
      if (first.success && data && typeof data === 'object' && Array.isArray((data as { rows?: unknown }).rows)) {
        const rows = [...((data as { rows: OrderRecord[] }).rows ?? [])];
        const total = Number((data as { total?: number }).total ?? rows.length);
        orderTotal.value = total;
        for (let offset = rows.length; offset < total && offset < ORDER_SYNC_CAP; offset += ORDER_PAGE_SIZE) {
          const page = await ipc.orderList({ offset, limit: ORDER_PAGE_SIZE });
          const pageData = page.data as unknown;
          if (page.success && pageData && Array.isArray((pageData as { rows?: unknown }).rows)) {
            rows.push(...((pageData as { rows: OrderRecord[] }).rows ?? []));
          } else break;
        }
        orders.value = rows;
        if (total > ORDER_SYNC_CAP) {
          console.warn(`[order-insight] 订单量 ${total} 超过同步上限 ${ORDER_SYNC_CAP}，汇总/导出可能不完整`);
        }
      } else if (Array.isArray(data)) {
        // 旧版主进程兼容：直接返回数组
        const legacy = data as unknown as OrderRecord[];
        orders.value = legacy;
        orderTotal.value = legacy.length;
      }
      ordersDirty.value = false; // 全量镜像已与主进程一致
    } catch (e: unknown) {
      // IPC 通道不可用（如主进程未重启仍为旧代码）时降级，避免初始化中断
      console.warn('[order-insight] refreshStats failed:', e);
    }
  }

  /** 刷新产品库列表 */
  async function refreshStyles() {
    try {
      const r = await ipc.orderStyleList();
      if (r.success && r.data) styles.value = r.data;
    } catch (e: unknown) {
      console.warn('[order-insight] refreshStyles failed:', e);
    }
  }

  /**
   * 数据纠正：更新订单字段；改款/改色时传 reclassify=true 并按新指纹重新归类。
   * targetStyleId 指定手动归并目标款编码（>0 时不自动 reclassify，图片直接挂到该款式，
   * 并把订单指纹记入该款式，使后续自动识别命中同一款编码）；
   * styleName 变化时同步更新款编码展示名（不参与匹配）。
   */
  /** 保存纠正字段并归类/归并。返回 { ok } + 本次归属款编码（供行内即时反馈"已归类/已归并为 XX"）。 */
  async function updateOrderFields(
    input: OrderUpdateInput,
  ): Promise<{ ok: boolean; styleCode?: string; styleColorCode?: string }> {
    const raw = toRaw(input) as OrderUpdateInput;
    // 脱壳：features 可能来自响应式 order（Vue Proxy），contextBridge 结构化克隆发生在 preload 消毒之前，
    // Proxy 数组无法克隆会报 "An object could not be cloned."，此处先转成普通数组。
    const payload: OrderUpdateInput = {
      id: raw.id,
      category: raw.category ?? '',
      color: raw.color ?? '',
      logo: raw.logo ?? '',
      fingerprint: raw.fingerprint,
      features: Array.isArray(raw.features) ? raw.features.map((f) => String(f ?? '')) : [],
      reclassify: raw.reclassify === true,
    };
    const r = await ipc.orderUpdate(payload);
    if (!r.success) {
      toast('保存失败: ' + (r.error || '未知错误'), 'error');
      return { ok: false };
    }
    let styleCode = r.data?.styleCode ?? '';
    let styleColorCode = r.data?.styleColorCode ?? '';
    // 手动归并：把订单图片挂到用户指定的款编码，并把指纹记入该款式（未来自动识别命中同一款）
    if (raw.targetStyleId) {
      const target = styles.value.find((s) => s.id === raw.targetStyleId);
      const assign = await ipc.orderStyleAssign(
        toRaw({
          orderId: raw.id,
          styleId: raw.targetStyleId,
          color: payload.color,
          fingerprint: payload.fingerprint ?? '',
        }),
      );
      if (assign.success && assign.data?.styleCode) {
        styleCode = assign.data.styleCode;
      } else {
        toast('归并到款式失败: ' + (assign.error || '未知错误'), 'error');
      }
    }
    // 款式名称变化 → 同步到款编码展示名（手动归并时改目标款，否则改当前归属款）
    if (raw.styleName !== undefined && raw.styleName.trim()) {
      const currentCode = orders.value.find((x) => x.id === raw.id)?.styleCode ?? '';
      const targetCode = raw.targetStyleId
        ? (styles.value.find((s) => s.id === raw.targetStyleId)?.code ?? '')
        : (styleCode || currentCode);
      if (targetCode) {
        const renamed = await ipc.orderStyleRename(toRaw({ code: targetCode, name: raw.styleName }));
        if (!renamed.success) toast('款式名称保存失败: ' + (renamed.error || '未知错误'), 'error');
      }
    }
    ordersDirty.value = true; // 字段/归属变化影响透视与导出 → 进「数据汇总」时全量同步
    await lightSync();
    toast(styleCode ? `已保存，当前归属 ${styleCode}` : '已保存', 'success');
    return { ok: true, styleCode, styleColorCode };
  }

  /** 批量标记订单已核对（corrected=1）：「确认无误」/「全部确认无误」用。
   * 不修改任何识别字段，仅使订单离开数据纠正的待核对列表。返回实际更新的行数。 */
  async function markOrdersCorrected(ids: number[]) {
    const list = [...new Set(ids)].filter((n): n is number => Number.isInteger(n) && n > 0);
    if (!list.length) return 0;
    const r = await ipc.orderMarkCorrected(list);
    if (!r.success) {
      toast('标记失败: ' + (r.error || '未知错误'), 'error');
      return 0;
    }
    ordersDirty.value = true;
    await lightSync();
    return r.data?.updated ?? 0;
  }

  /** 全部确认无误：主进程一次 UPDATE 标记整批 corrected=1。
   * 避免把数万行 id 经 IPC 传回主进程再拼 IN(...)。 */
  async function markAllCorrected() {
    const r = await ipc.orderMarkCorrected({ all: true });
    if (!r.success) {
      toast('标记失败: ' + (r.error || '未知错误'), 'error');
      return 0;
    }
    ordersDirty.value = true;
    await lightSync();
    toast(`已确认全部 ${r.data?.updated ?? 0} 条待核对订单`, 'success');
    return r.data?.updated ?? 0;
  }

  /** 清理未被数据库引用的孤儿图片文件（重置数据/批次覆盖/换图后残留）；返回 { deleted, freedBytes } 或 null(失败) */
  async function cleanupOrphanImages() {
    const r = await ipc.orderCleanupOrphanImages();
    if (!r.success) {
      toast('清理失败: ' + (r.error || '未知错误'), 'error');
      return null;
    }
    return r.data ?? { deleted: 0, freedBytes: 0 };
  }

  /** 数据汇总的订单状态筛选 */
  function setStatusFilter(s: OrderStatus | 'all') {
    statusFilter.value = s;
  }

  /** 缺图记录补图：校验链接后写回队列（主进程同步回写 URL+原始行并把行转回 pending），随后重跑「图片识别」即可处理。
   *  缺图清单本身由 refreshQueue 按 missingOnly 服务端分页拉取（queueMissingRows），不再本地镜像过滤 */
  async function setMissingImageUrl(id: number, url: string): Promise<boolean> {
    const u = (url ?? '').trim();
    if (!/^https?:\/\//i.test(u)) {
      toast('图片链接需以 http(s):// 开头', 'error');
      return false;
    }
    // 队列列表不带 raw_fields（瘦身），补图需要原始整行 → 按 id 取全量行再补写
    const g = await ipc.orderQueueGet(id);
    if (!g.success || !g.data) {
      toast('补图失败：记录不存在（可能已处理完成）', 'error');
      return false;
    }
    const q = g.data;
    const col = config.value.imageColumn;
    const rawFields = { ...(q.rawFields ?? {}) };
    if (col) rawFields[col] = u;
    const r = await ipc.orderQueuePatch(toRaw({ id, url: u, rawFields }));
    if (!r.success) {
      toast('补图失败: ' + (r.error || '未知错误'), 'error');
      return false;
    }
    await refreshQueue();
    toast('已补图，点击「② 图片识别」重新处理', 'success');
    return true;
  }

  /** 订单明细：删除订单（仅删订单行，图片识别指纹保留可复用） */
  async function deleteOrder(id: number) {
    const r = await ipc.orderDelete(toRaw({ id }));
    if (!r.success) {
      toast('删除失败: ' + (r.error || '未知错误'), 'error');
      return false;
    }
    orders.value = orders.value.filter((x) => x.id !== id);
    detailRows.value = detailRows.value.filter((x) => x.id !== id);
    pendingRows.value = pendingRows.value.filter((x) => x.id !== id);
    ordersDirty.value = true;
    await lightSync();
    toast('已删除订单', 'success');
    return true;
  }

  /** 产品库：删除款编码（级联删款色；图片解除归属保留识别结果；订单保留但款编码变空） */
  async function deleteStyle(id: number) {
    const r = await ipc.orderStyleDelete(toRaw({ id }));
    if (!r.success) {
      toast('删除失败: ' + (r.error || '未知错误'), 'error');
      return false;
    }
    styles.value = styles.value.filter((x) => x.id !== id);
    ordersDirty.value = true; // 镜像内该款订单 style_code 待置空 → 进「数据汇总」时全量同步
    await lightSync();
    toast('已删除款编码', 'success');
    return true;
  }

  /** 订单明细：切换发货状态（未发货 ⇄ 已发货） */
  async function setOrderStatus(id: number, status: OrderStatus) {
    const payload: OrderUpdateStatusInput = { id, status };
    const r = await ipc.orderUpdateStatus(toRaw(payload));
    if (!r.success) {
      toast('状态更新失败: ' + (r.error || '未知错误'), 'error');
      return false;
    }
    // 本地即时更新避免表格闪烁，再轻量同步（镜像 status 置 dirty，进「数据汇总」时全量刷新）
    const o = orders.value.find((x) => x.id === id);
    if (o) o.status = status;
    const d = detailRows.value.find((x) => x.id === id);
    if (d) d.status = status;
    const p = pendingRows.value.find((x) => x.id === id);
    if (p) p.status = status;
    ordersDirty.value = true;
    await lightSync();
    toast(status === 'shipped' ? '已标记为已发货' : '已标记为未发货', 'success');
    return true;
  }

  /** LRU 写入：命中先删再插，超上限淘汰最早项（缓存只增不清的兜底） */
  function cacheSetLru(cache: Map<string, string>, key: string, val: string, max: number) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, val);
    if (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }

  /** 读取原图 base64（带 LRU 缓存，重复展示不重复 IPC；全图仅大图预览场景用） */
  async function getImageDataUrl(localPath?: string): Promise<string> {
    if (!localPath) return '';
    const cached = imageDataCache.value.get(localPath);
    if (cached !== undefined) {
      imageDataCache.value.delete(localPath);
      imageDataCache.value.set(localPath, cached);
      return cached;
    }
    const r = await ipc.orderReadImage(localPath);
    if (!r.success || !r.data) return '';
    cacheSetLru(imageDataCache.value, localPath, r.data.dataUrl, IMAGE_DATA_CACHE_MAX);
    return r.data.dataUrl;
  }

  // ---- 缩略图合批读取（P1④）：同帧内多张可见图合并为一次 IPC 往返 ----
  // 未命中缓存的请求先入批队列，收集窗口（1 帧）到点后统一走 order-image-thumb-batch；
  // 命中渲染层 LRU 的直接返回；批量通道异常/单项无效时降级逐张单发，保证功能不退化。
  interface ThumbJob {
    path: string;
    maxEdge: number;
    resolve: (dataUrl: string) => void;
  }
  let thumbJobs: ThumbJob[] = [];
  let thumbFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /** 合批窗口到点后真正发一次批量 IPC（仅由定时器触发，避免重入） */
  async function flushThumbBatch() {
    if (thumbJobs.length === 0) return;
    const jobs = thumbJobs;
    thumbJobs = [];
    // 超上限时分块批量请求，保持与 jobs 顺序对齐（命中项写入缓存，null 项逐张单发兜底）
    const chunks: { localPath: string; maxEdge?: number }[][] = [];
    for (let i = 0; i < jobs.length; i += THUMB_BATCH_MAX) {
      chunks.push(jobs.slice(i, i + THUMB_BATCH_MAX).map((j) => ({ localPath: j.path, maxEdge: j.maxEdge })));
    }
    const dataUrls: (string | null)[] = [];
    for (const chunk of chunks) {
      try {
        const r = await ipc.orderImageThumbBatch(chunk);
        if (r.success && Array.isArray(r.data?.dataUrls)) dataUrls.push(...r.data.dataUrls);
        else dataUrls.push(...chunk.map(() => null)); // 批量失败 → 逐张降级
      } catch {
        dataUrls.push(...chunk.map(() => null)); // 批量通道异常 → 逐张降级
      }
    }
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const hit = dataUrls && i < dataUrls.length ? dataUrls[i] : '';
      if (!hit) {
        // 批量缺失（单项无效或通道降级）：单发兜底，保证该图仍可正常展示
        try {
          const single = await ipc.orderImageThumb({ localPath: job.path, maxEdge: job.maxEdge });
          if (single.success && single.data) {
            cacheSetLru(imageThumbCache.value, job.path + '|' + job.maxEdge, single.data.dataUrl, IMAGE_THUMB_CACHE_MAX);
            job.resolve(single.data.dataUrl);
            continue;
          }
        } catch { /* 单发也失败 → 空串占位 */ }
        job.resolve('');
        continue;
      }
      cacheSetLru(imageThumbCache.value, job.path + '|' + job.maxEdge, hit, IMAGE_THUMB_CACHE_MAX);
      job.resolve(hit);
    }
  }

  /** 读取展示级缩略图（渲染层 LRU + 同帧合批 IPC；表格/封面/产品库等小尺寸展示统一走这里） */
  async function getThumbDataUrl(localPath?: string, maxEdge = 160): Promise<string> {
    if (!localPath) return '';
    const key = localPath + '|' + maxEdge;
    const cached = imageThumbCache.value.get(key);
    if (cached !== undefined) {
      imageThumbCache.value.delete(key);
      imageThumbCache.value.set(key, cached); // 触碰 LRU
      return cached;
    }
    // 未命中：入批队列等待同帧合批；窗口内重复 key 由主进程 thumbCache 兜底命中
    return new Promise<string>((resolve) => {
      thumbJobs.push({ path: localPath, maxEdge, resolve });
      if (thumbFlushTimer === undefined) {
        thumbFlushTimer = setTimeout(() => {
          thumbFlushTimer = undefined;
          void flushThumbBatch();
        }, THUMB_BATCH_FLUSH_MS);
      }
    });
  }

  /** 请求停止当前识别流程（批次间隙生效，正在处理的单条会完成） */
  function requestCancel() {
    if (!processing.value) return;
    cancelRequested.value = true;
    toast('正在停止…将处理完当前记录后停下，剩余记录保留在队列', 'info');
  }

  // ---- 数据透视汇总 ----
  /** 度量表头显示名 */
  function measureLabel(m: PivotMeasure): string {
    if (m.op === 'count') return '数量';
    return (m.alias || fieldLabel(m.field)) + '(' + MEASURE_OP_LABEL[m.op] + ')';
  }

  /** 按订单状态筛选后的订单子集（数据汇总/导出用；订单明细 Tab 始终显示全部） */
  const filteredOrders = computed(() => {
    if (statusFilter.value === 'all') return orders.value;
    return orders.value.filter((o) => (o.status ?? 'pending') === statusFilter.value);
  });

  /** 透视汇总结果（按已选维度/度量即时计算，脱壳避免响应式代理干扰） */
  // 按维度组合键字典序排序：保证同维度值相邻，界面与导出的合并单元格才成立
  const pivotResult = computed(() =>
    pivotRows(toRaw(filteredOrders.value) as OrderRecord[], {
      dimensions: config.value.pivotDimensions,
      measures: config.value.pivotMeasures,
      sort: 'key',
    }),
  );

  // ---- 导出 Excel（渲染层生成 buffer → IPC 保存对话框落盘）----
  async function exportExcel() {
    if (!orders.value.length && !groups.value.length) {
      toast('暂无可导出的数据', 'error');
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const summary = groups.value.map((g) => ({
        ...g,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), '归类汇总');
      const detail = orders.value.map((o) => ({
        订单号: o.orderNo,
        店铺: o.shop,
        下单时间: o.orderTime ?? '',
        尺寸: o.size,
        款编码: o.styleCode ?? '',
        款式名: o.styleName ?? '',
        款色: o.styleColor ?? '',
        款式: o.category,
        颜色: o.color,
        logo: o.logo,
        发货状态: orderStatusLabel(o.status ?? 'pending'),
        导入时间: o.createdAt,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), '订单明细');
      // 汇总（透视）表：维度列 + 度量列 + 合计行
      if (config.value.pivotDimensions.length && pivotResult.value.length) {
        const dimCols = config.value.pivotDimensions.map(
          (d) => fieldLabel(d.field) + (d.bucket ? '(' + DATE_BUCKET_LABEL[d.bucket] + ')' : ''),
        );
        const mCols = config.value.pivotMeasures.map((m) => measureLabel(m));
        const rows = pivotResult.value.map((r) => {
          const obj: Record<string, string | number> = {};
          config.value.pivotDimensions.forEach((d, i) => {
            obj[dimCols[i]] = r.dims[dimensionId(d)] || '(空)';
          });
          config.value.pivotMeasures.forEach((m, i) => {
            obj[mCols[i]] = r.measures[m.id] ?? 0;
          });
          return obj;
        });
        const [total] = pivotRows(toRaw(filteredOrders.value) as OrderRecord[], {
          dimensions: [],
          measures: config.value.pivotMeasures,
        });
        const totalObj: Record<string, string | number> = {};
        dimCols.forEach((c, i) => {
          totalObj[c] = i === 0 ? '合计' : '';
        });
        mCols.forEach((c, i) => {
          totalObj[c] = total?.measures[config.value.pivotMeasures[i].id] ?? 0;
        });
        const totalRowIndex = rows.length;
        rows.push(totalObj);
        // 维度列层级合并（合计行不参与）：列 c 仅在 0..c 列组合值（前缀）相同时才合并，
        // 实现「同为 A 合并 → A 中 B 合并 → A 中 B 中 C 合并」的透视表层级效果
        const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
        dimCols.forEach((_, c) => {
          const prefixOf = (i: number) =>
            dimCols
              .slice(0, c + 1)
              .map((col) => String(rows[i][col] ?? ''))
              .join('\u0000');
          let start = 0;
          for (let r = 1; r <= totalRowIndex; r++) {
            const prev = prefixOf(r - 1);
            const cur = r < totalRowIndex ? prefixOf(r) : null;
            if (cur === null || cur !== prev) {
              if (r - 1 > start) {
                // json_to_sheet 首行为表头，数据从第 2 行（索引 1）开始，故行号 +1
                merges.push({ s: { r: start + 1, c }, e: { r: r - 1 + 1, c } });
              }
              start = r;
            }
          }
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        if (merges.length) ws['!merges'] = merges;
        XLSX.utils.book_append_sheet(wb, ws, '数据汇总');
      }
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const saved = await ipc.orderExportExcel(
        buf as ArrayBuffer,
        '订单归类汇总-' + new Date().toISOString().slice(0, 10) + '.xlsx',
      );
      if (!saved.success) throw new Error(saved.error || '导出失败');
      toast('已导出到 ' + saved.data?.filePath, 'success');
    } catch (e: unknown) {
      toast('导出失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
    }
  }

  // ---- 产品库：下载导入模板 / Excel 批量导入 ----

  /** 生成产品库导入模板（含示例行与填写说明），经保存对话框落盘 */
  async function downloadProductTemplate() {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const sample = [
        { 款编码: 'STYLE-001', 款式名: '短袖T恤·圆领·条纹', 品类: '短袖T恤', 特征: '圆领、条纹', 颜色: '黑色', 图片: '', 指纹: '' },
        { 款编码: 'STYLE-001', 款式名: '', 品类: '', 特征: '', 颜色: '白色', 图片: '', 指纹: '' },
        { 款编码: '', 款式名: '', 品类: '卫衣', 特征: '连帽、口袋', 颜色: '灰色', 图片: 'https://example.com/hoodie.jpg', 指纹: '' },
      ];
      const ws = XLSX.utils.json_to_sheet(sample);
      ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 44 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, ws, '产品库');
      const note = [
        ['产品库导入模板说明'],
        [''],
        ['1. 每行一个「款色」：款编码 + 颜色 决定唯一款色；同一款多个颜色写多行（款编码相同）。'],
        ['2. 推荐填「图片」列（图片 URL 或本地绝对路径）：导入时用与订单识别相同的 AI 引擎识别图片并生成款式指纹，'],
        ['   订单导入后识别同一款商品图会自动命中该款编码，无需手动归并；未配置 API Key 时忽略图片列。'],
        ['3. 不填图片时用「品类」+「特征」手填生成款式指纹：订单识别按同一规则生成指纹并匹配，'],
        ['   填法与识别结果一致即可自动命中已有款编码。'],
        ['4. 「品类」「颜色」会按识别同规则归一化（如「T恤」→「短袖T恤」）；「特征」多个时用 、 或 , 分隔（示例：圆领、条纹）。'],
        ['5. 「指纹」可选（高级）：填写与识别算法一致的指纹字符串；不填则按「品类+特征」或「图片识别」自动生成。'],
        ['6. 「款编码」可选：留空自动生成（STYLE-002…）；已存在则视为更新该款式（更新款式名、追加缺失颜色），'],
        ['   并把本次生成的指纹记入该款式的附加指纹，使订单识别也能命中已有款编码。'],
        ['7. 「款式名」可选，留空自动组合「品类+特征」或使用图片识别结果；「颜色」必填。'],
        ['8. 示例行可删除；导入时从第 2 行起逐行处理，失败行给出原因、不影响其他行。'],
        [''],
        ['列说明：款编码 / 款式名 / 品类 / 特征 / 颜色 / 图片 / 指纹'],
      ];
      const ns = XLSX.utils.aoa_to_sheet(note);
      ns['!cols'] = [{ wch: 90 }];
      XLSX.utils.book_append_sheet(wb, ns, '说明');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const saved = await ipc.orderExportExcel(buf as ArrayBuffer, '产品库导入模板.xlsx');
      if (!saved.success) throw new Error(saved.error || '保存失败');
      toast('模板已保存到 ' + saved.data?.filePath, 'success');
    } catch (e: unknown) {
      toast('模板下载失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
    }
  }

  /** 读取产品库导入「图片」列的图片：URL 走下载缓存（复用订单同图链路），本地路径走新 IPC；返回 dataUrl 与图片记录 id（供回写识别结果） */
  async function readImageForImport(raw: string): Promise<{ dataUrl: string; imageId?: number; reuse?: Record<string, unknown> } | null> {
    try {
      if (/^https?:\/\//i.test(raw)) {
        const dl = await ipc.orderDownloadImage(raw);
        if (!dl.success || !dl.data?.localPath) return null;
        // 该 URL 图片已被识别过（如订单导入时）：直接复用结果，保证与订单识别指纹完全一致
        if (dl.data.status === 'done' && dl.data.result) {
          return { dataUrl: '', imageId: dl.data.id, reuse: dl.data.result as Record<string, unknown> };
        }
        const read = await ipc.orderReadImage(dl.data.localPath);
        if (!read.success || !read.data) return null;
        return { dataUrl: read.data.dataUrl, imageId: dl.data.id };
      }
      const read = await ipc.orderReadLocalImage(raw);
      if (!read.success || !read.data) return null;
      return { dataUrl: read.data.dataUrl };
    } catch {
      return null;
    }
  }

  /** 产品库 Excel 导入：解析 → （有图时）同一识别引擎生成指纹 → IPC 批量导入 → 刷新列表；返回结果供组件展示失败明细 */
  async function importProductStylesExcel(): Promise<{ imported: number; errors: { row: number; message: string }[] } | null> {
    try {
      const sel = await selectExcelFile();
      if (!sel) return null;
      const parsed = parseExcelBuffer(sel.data);
      const headers = parsed.headers;
      const colIdx = (names: string[]) => headers.findIndex((h) => names.includes(h));
      const iCode = colIdx(['款编码', '款编号']);
      const iName = colIdx(['款式名', '款名']);
      const iCat = colIdx(['品类', '类别']);
      const iFeat = colIdx(['特征', '款式特征']);
      const iColor = colIdx(['颜色', '款色']);
      const iFp = colIdx(['指纹', '指纹信息']);
      const iImg = colIdx(['图片', '主图', '图片地址', '图片URL', '图片 url']);
      const at = (fields: Record<string, string>, i: number) => (i >= 0 ? String(fields[headers[i]] ?? '').trim() : '');
      // 识别引擎：配置了 API Key 才启用图片识别；否则降级为手填字段生成指纹
      const engine = apiKey.value ? createVisionEngine(engineConfig()) : null;
      const items: StyleImportItem[] = [];
      const errors: { row: number; message: string }[] = [];
      let recognized = 0;
      importing.value = true;
      try {
        for (const [idx, rec] of parsed.records.entries()) {
          const row = idx + 2;
          importTip.value = `正在处理第 ${row - 1}/${parsed.records.length} 行…`;
          const code = at(rec.fields, iCode);
          const name = at(rec.fields, iName);
          const category = at(rec.fields, iCat);
          const features = at(rec.fields, iFeat)
            .split(/[、，,;；/\\|\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const color = at(rec.fields, iColor);
          const userFp = at(rec.fields, iFp);
          const imgRaw = at(rec.fields, iImg);
          // 手填路径先归一化（与识别同规则），使手填品类/颜色尽量贴近识别白名单
          let categoryN = normalizeCategory(category);
          let colorN = normalizeColor(color);
          let featureN = features.map((s) => s).filter(Boolean);
          let fingerprint = buildStyleFingerprint(categoryN, featureN);
          let aiName = '';
          // 图片识别（与订单识别同一引擎+提示词+归一化+指纹算法 → 指纹同源，订单识别必然命中）
          if (imgRaw && engine) {
            const img = await readImageForImport(imgRaw);
            if (img) {
              const recv = img.reuse ?? (await engine.analyze(img.dataUrl));
              const norm = classifyResult({
                category: String(recv.category ?? ''),
                color: String(recv.color ?? ''),
                logo: '',
                styleName: String(recv.styleName ?? ''),
              });
              const aiFeatures = Array.isArray(recv.features) ? (recv.features as unknown[]).map((f) => String(f ?? '')).filter(Boolean) : [];
              const recvFp = buildStyleFingerprint(norm.category, aiFeatures);
              if (recvFp) {
                recognized += 1;
                fingerprint = recvFp;
                categoryN = norm.category || categoryN;
                colorN = colorN || norm.color;
                featureN = aiFeatures.length ? aiFeatures : featureN;
                aiName = norm.styleName || '';
                // 识别结果回写图片记录：订单导入遇相同 URL 直接复用该结果，识别链路与指纹保持一致
                if (img.imageId) {
                  await ipc.orderImageSave({ id: img.imageId, status: 'done', resultJson: JSON.stringify(recv) });
                }
              }
            }
          }
          if (!fingerprint) {
            errors.push({ row, message: '缺少指纹：请填写「品类/特征」「指纹」列，或「图片」列（图片识别需先配置 API Key）' });
            continue;
          }
          const extraFingerprints = [...new Set(
            [...(userFp && userFp !== fingerprint ? [userFp] : [])].filter(Boolean),
          )];
          items.push({
            code: code || undefined,
            name: name || aiName,
            color: colorN,
            fingerprint,
            extraFingerprints,
          });
        }
      } finally {
        importing.value = false;
        importTip.value = '';
      }
      if (!items.length) {
        toast('Excel 中没有可导入的数据行（请从第 2 行起填写）', 'error');
        return null;
      }
      const r = await ipc.orderStyleImport({ styles: items });
      if (!r.success) throw new Error(r.error || '导入失败');
      await refreshStyles();
      const res = r.data ?? { imported: 0, errors: [] };
      const merged = { imported: res.imported, errors: [...(res.errors ?? []), ...errors] };
      if (merged.imported > 0) {
        let msg = `产品库导入完成：成功 ${merged.imported} 行${merged.errors.length ? `，失败 ${merged.errors.length} 行` : ''}`;
        if (recognized > 0) msg += `，其中 ${recognized} 行经图片识别生成指纹（订单导入后可直接命中）`;
        else if (engine) msg += '（未启用图片识别：无图片列或图片识别失败）';
        toast(msg, merged.errors.length ? 'info' : 'success');
      } else if (merged.errors.length) {
        toast(`产品库导入失败 ${merged.errors.length} 行`, 'error');
      }
      return merged;
    } catch (e: unknown) {
      toast('产品库导入失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
      return null;
    }
  }

  return {
    config,
    apiKey,
    setApiKey,
    headers,
    queueBatchNo,
    queueCounts,
    queueErrorRows,
    queueErrorTotal,
    queueMissingRows,
    queueMissingTotal,
    hasLegacyQueue,
    refreshQueue,
    restoreLastQueue,
    infoColumn,
    processing,
    progress,
    failLogs,
    processTicks,
    orderTotal,
    lastRunCancelled,
    requestCancel,
    orders,
    ordersDirty,
    groups,
    styles,
    loadState,
    saveState,
    importExcel,
    runProcess,
    refreshStats,
    refreshStyles,
    loadAggregates,
    updateOrderFields,
    markOrdersCorrected,
    markAllCorrected,
    setOrderStatus,
    deleteOrder,
    deleteStyle,
    cleanupOrphanImages,
    // 纠正/明细：服务端分页浏览
    pendingRows,
    pendingTotal,
    pendingSearch,
    pendingPageNo,
    pendingLoading,
    loadPendingPage,
    setPendingSearch,
    detailRows,
    detailTotal,
    detailSearch,
    detailPageNo,
    detailLoading,
    loadDetailPage,
    setDetailSearch,
    getImageDataUrl,
    getThumbDataUrl,
    exportExcel,
    downloadProductTemplate,
    importProductStylesExcel,
    importing,
    importTip,
    pivotResult,
    statusFilter,
    filteredOrders,
    setStatusFilter,
    setMissingImageUrl,
  };
});
