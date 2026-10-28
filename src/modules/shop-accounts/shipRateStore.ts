// src/modules/shop-accounts/shipRateStore.ts
// 「物流运费」资料项的状态层（2026-10-15 由 UI 岛 dist/store.js 迁入，无框架 store → Pinia）。
//
// 迁入时**行为保持不变**的部分（都是踩过的坑，别当普通代码重构掉）：
//   · 运价表**不落盘、不回传**：真源是宿主快照 `sr_rate_snapshots`（M6 运价表回迁），
//     本 store 的 table 只是取来渲染的只读副本；
//   · 落盘的只有**纯界面状态**（查询偏好 + 上次打开的文件与其体检结果）；
//   · 旧版岛私有 storage 里的 `table` / `source` 两个键：首启一次性迁移（rateAdopt，
//     宿主按内容 sha256 去重）后**显式写 null 抹掉** —— 留着只会在下次排查时误导人；
//   · `lastFile` 与 `source` 必须分开：前者是"刚打开过的文件"（导入失败后手动指定
//     工作表要针对它），后者是"当前运价表出自哪个文件"（可能更早）。
//
// 防抖落盘用 core/services/storage 的 useModuleStorage（500ms），关键动作后 flush 一次。
// 命名空间 **shipping-rate** 与岛时代逐字相同（storage 自身命名空间）⇒ 老用户偏好零迁移。

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useModuleStorage } from '@/core/services/storage';
import { selectExcelFile } from '@/core/services/dialog';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import type { Category, RateTable, Rounding, SheetScanCandidate } from '@/lib/shipRate';
import type { QuoteRow } from '@/lib/shipRateQuote';
import type { OrderQuoteRow, OrderQuoteSummary } from '@/lib/shipRateOrders';
import type { ProductQuoteRow, ProductQuoteSummary } from '@/lib/shipRateProducts';
import {
  parseRateSheet,
  quote,
  quoteOrders,
  quoteProducts,
  rateAdopt,
  rateCurrent,
  type RateSnapshotView,
} from '@/core/services/shipRateOps';
import { baseName, allCopyText, rowCopyText } from './shipRateFormat';

/** 默认克重（报价单小包最常见的起步档） */
export const DEFAULT_WEIGHT = 100;

/** 计费类别偏好（含 auto） */
export type CategoryPref = Category | 'auto';

/** 持久化的界面状态（modules.shipping-rate；**不含运价表本身**） */
interface ShipRatePrefs {
  sheetNames?: string[];
  lastFile?: { filePath: string; fileName: string } | null;
  candidates?: SheetScanCandidate[];
  weight?: number;
  category?: CategoryPref;
  variant?: string;
  rounding?: Rounding;
  /** 旧版岛私有存储的遗留键（M6 前存表的地方）；只读一次用于迁移，随后置 null */
  table?: unknown;
  source?: unknown;
}

const isCategoryPref = (v: unknown): v is CategoryPref =>
  v === 'auto' || v === 'general' || v === 'special' || v === 'bulk';

export const useShipRateStore = defineStore('shipping-rate', () => {
  const storage = useModuleStorage<ShipRatePrefs>('shipping-rate');

  // ── 运价表（宿主快照的只读副本，只为渲染；不落盘、不回传） ──────────────
  const table = ref<RateTable | null>(null);
  /** 来源信息（由宿主快照给出） */
  const source = ref<{ filePath: string; fileName: string; sheetName: string; effectiveFrom: string } | null>(null);
  /** 该 Excel 内全部 sheet 名（换 sheet 用） */
  const sheetNames = ref<string[]>([]);
  /** 上次**打开过**的文件（不论解析成功与否）—— 手动指定工作表针对它 */
  const lastFile = ref<{ filePath: string; fileName: string } | null>(null);
  /** 上次体检的全部 sheet（含不可用的，各带国家数与原因） */
  const candidates = ref<SheetScanCandidate[]>([]);

  // ── 查询偏好（持久化） ──────────────
  const weight = ref<number>(DEFAULT_WEIGHT);
  const category = ref<CategoryPref>('auto');
  const variant = ref<string>('');
  const rounding = ref<Rounding>('round');

  // ── 临时部分（不落盘） ──────────────
  const results = ref<QuoteRow[]>([]);
  const filter = ref<string>('');
  /** 结果是否针对当前克重（false 时表格显示的是旧结果，避免误读） */
  const resultWeight = ref<number>(0);
  const isLoading = ref(false);
  const ready = ref(false);
  /** 各页签的试算结果（orders / products 两个批量页） */
  const orderRows = ref<OrderQuoteRow[]>([]);
  const orderSummary = ref<OrderQuoteSummary | null>(null);
  const productRows = ref<ProductQuoteRow[]>([]);
  const productSummary = ref<ProductQuoteSummary | null>(null);
  const productCountry = ref<string>('');
  const busyOrders = ref(false);
  const busyProducts = ref(false);

  /** 是否已有可用运价表 */
  const hasTable = computed(() => !!(table.value && table.value.countries && table.value.countries.length));

  /** 运价表里的国家（按中文名排序） */
  const countriesSorted = computed(() => {
    const list = hasTable.value ? (table.value as RateTable).countries.slice() : [];
    return list.sort((a, b) => a.nameCn.localeCompare(b.nameCn, 'zh-Hans-CN'));
  });

  /** 体检结果里真正能用的那几张（候选按钮只展示这些） */
  const usableCandidates = computed(() => (candidates.value || []).filter((c) => c && c.countries > 0));

  /** 结果表按过滤词筛选（匹配中文名 / 英文名 / Code） */
  const filteredResults = computed(() => {
    const q = filter.value.trim().toLowerCase();
    if (!q) return results.value;
    return results.value.filter(
      (r) =>
        String(r.nameCn).toLowerCase().includes(q) ||
        String(r.nameEn).toLowerCase().includes(q) ||
        String(r.code).toLowerCase().includes(q),
    );
  });

  /**
   * 有价 / 无价统计（结果页摘要用）。
   * ⚠️ 无价必须分两种报：**档位不覆盖**（`card` 为 null）与**该线路不是人民币报价**
   * （`card` 非 null但宿主拒算）。合成一句"该克重无价"会让用户以为是自己克重输错了。
   */
  const resultStats = computed(() => {
    const total = results.value.length;
    const ok = results.value.filter((r) => r.ok).length;
    const refused = results.value.filter((r) => !r.ok && r.card).length;
    return { total, ok, refused, noPrice: total - ok - refused };
  });

  // ── 持久化 ──────────────

  function collect(): ShipRatePrefs {
    return {
      sheetNames: sheetNames.value,
      lastFile: lastFile.value,
      candidates: candidates.value,
      weight: weight.value,
      category: category.value,
      variant: variant.value,
      rounding: rounding.value,
    };
  }

  function scheduleSave(): void {
    storage.scheduleSave(collect());
  }

  /** 立即落盘（关键动作后调用，避免用户操作完立刻关窗丢数据） */
  async function flush(): Promise<void> {
    await storage.save(collect());
  }

  /** 旧的岛内运价表（只读一次，用于首次迁移；迁完置空） */
  let legacyTable: unknown = null;
  let legacySource: { filePath?: string; sheetName?: string } | null = null;

  /** 读取持久化状态（含全新安装的默认值兜底；旧 table/source 只记下来用于迁移） */
  async function loadState(): Promise<void> {
    const d = (await storage.load()) || {};
    sheetNames.value = Array.isArray(d.sheetNames) ? d.sheetNames : [];
    lastFile.value =
      d.lastFile && typeof d.lastFile === 'object' && d.lastFile.filePath ? d.lastFile : null;
    candidates.value = Array.isArray(d.candidates) ? d.candidates : [];
    const w = Number(d.weight);
    weight.value = Number.isFinite(w) && w > 0 ? Math.round(w) : DEFAULT_WEIGHT;
    category.value = isCategoryPref(d.category) ? d.category : 'auto';
    variant.value = typeof d.variant === 'string' ? d.variant : '';
    rounding.value = d.rounding === 'ceil' ? 'ceil' : 'round';
    // 旧的岛内运价表：只用于一次性迁移，不直接当状态用
    legacyTable = d.table && typeof d.table === 'object' && Array.isArray((d.table as RateTable).countries) && (d.table as RateTable).countries.length ? d.table : null;
    legacySource = d.source && typeof d.source === 'object' ? (d.source as { filePath?: string; sheetName?: string }) : null;
  }

  function adoptSnapshot(snap: RateSnapshotView | null): void {
    table.value = snap && Array.isArray(snap.table.countries) ? snap.table : null;
    source.value = snap
      ? {
          filePath: String(snap.sourceFile || ''),
          fileName: baseName(String(snap.sourceFile || '')),
          sheetName: String(snap.sheetName || ''),
          effectiveFrom: String(snap.effectiveFrom || ''),
        }
      : null;
  }

  /** 从宿主取"当前运价表"（唯一真源）；首次运行顺带把旧的岛内表迁移上去 */
  async function syncTableFromHost(): Promise<void> {
    try {
      let cur = await rateCurrent();
      if (!cur && legacyTable) {
        // 升级路径：把留在岛存储里的那张表**一次性**交给宿主（宿主按内容去重，重入安全）
        await rateAdopt(legacyTable, legacySource || {});
        cur = await rateCurrent();
      }
      adoptSnapshot(cur);
      // 迁移成功（或宿主本来就有表）→ 抹掉岛内那份陈旧副本：留着只会在下次排查时误导人
      if (table.value && legacyTable) {
        await storage.save({ ...collect(), table: null, source: null });
        legacyTable = null;
        legacySource = null;
      }
    } catch (e) {
      toast(`读取运价表失败：${(e as Error).message}`, 'error');
    }
  }

  // ── 查询动作 ──────────────

  function setWeight(g: number | string): void {
    const n = Number(g);
    weight.value = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    scheduleSave();
  }

  function setCategory(c: string): void {
    category.value = isCategoryPref(c) ? c : 'auto';
    scheduleSave();
  }

  function setVariant(v: string): void {
    variant.value = typeof v === 'string' ? v : '';
    scheduleSave();
  }

  function setRounding(r: string): void {
    rounding.value = r === 'ceil' ? 'ceil' : 'round';
    scheduleSave();
  }

  function setFilter(q: string): void {
    filter.value = String(q ?? '');
  }

  function setProductCountry(c: string): void {
    productCountry.value = c;
  }

  /** 按当前条件重新问宿主要一遍全表报价 */
  async function refreshQuote(): Promise<void> {
    if (!hasTable.value || !(weight.value > 0)) {
      results.value = [];
      resultWeight.value = 0;
      return;
    }
    try {
      const r = await quote(weight.value, {
        category: category.value,
        variant: variant.value,
        rounding: rounding.value,
      });
      results.value = r.results;
      resultWeight.value = r.grams;
    } catch (e) {
      results.value = [];
      toast(`计算失败：${(e as Error).message}`, 'error');
    }
  }

  /** 复制全部有价行 */
  async function copyAll(): Promise<void> {
    const rows = filteredResults.value;
    await writeClipboard(allCopyText(rows, weight.value));
    toast(`已复制 ${rows.filter((r) => r.ok).length} 行报价`, 'success');
  }

  /** 复制单行 */
  async function copyRow(index: number): Promise<void> {
    const row = filteredResults.value[index];
    if (!row) return;
    await writeClipboard(rowCopyText(row, weight.value));
    toast('已复制该行', 'success');
  }

  // ── 导入 / 换表 ──────────────

  /**
   * 导入 / 更新运价表。
   *
   * 覆盖语义：整表替换（不是合并）。换版时旧国家若已下架就该消失，
   * 合并会让用户看到一份"历史累积的幽灵价"。
   *
   * ⚠️ 这里传的是 `prefer`（名称提示）而**不是** `sheetName`（显式点名）：
   *    运营商报价单是一本 21 张 sheet 的工作簿，目标表在第 10 张；
   *    点名"上次那张"会在换版改名时直接失败，传提示则能自动落到可用的表上。
   */
  async function importByDialog(): Promise<boolean> {
    const sel = await selectExcelFile();
    if (!sel) return false;

    isLoading.value = true;
    try {
      const r = await parseRateSheet(sel.filePath, {
        prefer: (source.value && source.value.sheetName) || '',
      });
      const fileName = baseName(sel.filePath || '');
      // 体检结果先落状态：即使解析失败，界面也要能列出"试过哪些、各有多少国家"
      lastFile.value = { filePath: sel.filePath, fileName };
      sheetNames.value = r.sheetNames;
      candidates.value = r.candidates as SheetScanCandidate[];

      if (!r.table || !Array.isArray((r.table as RateTable).countries) || !(r.table as RateTable).countries.length) {
        const usable = usableCandidates.value;
        const detail = usable.length
          ? `可用工作表：${usable.map((c) => `${c.sheetName}（${c.countries} 国）`).join('、')}（可在下方手动指定）`
          : '该文件里没有任何含「运达国家/地区」表头的工作表';
        toast(`「${fileName}」没解析出运价：已体检 ${sheetNames.value.length} 张工作表，${detail}`, 'error');
        return false;
      }

      const before = table.value && table.value.stats ? table.value.stats.countries : 0;
      // 解析在宿主完成、**并已由宿主留档为快照** —— 这里只把"当前那份"取回来渲染
      await syncTableFromHost();
      await refreshQuote();
      await flush();
      const st = table.value && table.value.stats ? table.value.stats : null;
      const after = st ? st.countries : 0;
      const delta = before && before !== after ? `（原 ${before} 国 → 现 ${after} 国）` : '';
      // 多张 sheet 时说明"是我替你挑的"，否则用户会以为是文件里只有这一张
      const lead = r.picked === 'auto' && sheetNames.value.length > 1 ? `已自动选择「${r.sheetName}」：` : '运价表已更新：';
      toast(`${lead}${after} 国 / ${st ? st.cards : 0} 张价卡${delta}`, 'success');
      return true;
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, 'error');
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * 只换工作表（用已记住的文件路径重导，不再弹一次对话框）。
   *
   * @param sheetName 目标 sheet —— **显式点名**，宿主不会改判到别的表
   * @param filePath 指定源文件；默认用当前运价表的来源文件。
   *   导入失败后从候选列表手动指定时必须传 lastFile 的路径：那次导入没有形成运价表，
   *   source 可能仍指向更早的另一个文件。
   */
  async function switchSheet(sheetName: string, filePath?: string): Promise<boolean> {
    const path = filePath || (source.value && source.value.filePath) || (lastFile.value && lastFile.value.filePath) || '';
    if (!sheetName || !path) {
      toast('没有记住源文件路径，请用「导入 / 更新运价表」重新选择', 'error');
      return false;
    }
    isLoading.value = true;
    try {
      const r = await parseRateSheet(path, { sheetName });
      sheetNames.value = Array.isArray(r.sheetNames) ? r.sheetNames : sheetNames.value;
      candidates.value = (Array.isArray(r.candidates) ? r.candidates : candidates.value) as SheetScanCandidate[];
      if (!r.table || !Array.isArray((r.table as RateTable).countries) || !(r.table as RateTable).countries.length) {
        const why = ((r.table as RateTable | null)?.warnings?.[0]) || '该 sheet 不是报价单结构';
        toast(`「${sheetName}」没解析出运价：${why}`, 'error');
        return false;
      }
      const fileName = (source.value && source.value.fileName) || (lastFile.value && lastFile.value.fileName) || baseName(path);
      // 与 importByDialog 同：解析已由宿主留档，只取回"当前那份"渲染
      await syncTableFromHost();
      await refreshQuote();
      await flush();
      const after = table.value && table.value.stats ? table.value.stats.countries : 0;
      toast(`已切换到「${r.sheetName || sheetName}」：${after} 国（源文件 ${fileName || '—'}）`, 'success');
      return true;
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, 'error');
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  // ── 批量试算 ──────────────

  /** 按订单试算（克重联产品库 SKU 表，数量暂按 1 件/单计） */
  async function runQuoteOrders(limit = 500): Promise<void> {
    if (!hasTable.value) return;
    busyOrders.value = true;
    try {
      const r = await quoteOrders({ limit, rounding: rounding.value, category: category.value });
      orderRows.value = r.rows;
      orderSummary.value = r.summary;
    } catch (e) {
      orderRows.value = [];
      orderSummary.value = null;
      toast(`试算失败：${(e as Error).message}`, 'error');
    } finally {
      busyOrders.value = false;
    }
  }

  /** 按产品试算（计价口径与运费查询共用：类别 / 取整） */
  async function runQuoteProducts(): Promise<void> {
    if (!hasTable.value) return;
    if (!productCountry.value) {
      toast('请先选择目的国家/地区', 'error');
      return;
    }
    busyProducts.value = true;
    try {
      const r = await quoteProducts(productCountry.value, {
        rounding: rounding.value,
        category: category.value,
      });
      productRows.value = r.rows;
      productSummary.value = r.summary;
    } catch (e) {
      productRows.value = [];
      productSummary.value = null;
      toast(`试算失败：${(e as Error).message}`, 'error');
    } finally {
      busyProducts.value = false;
    }
  }

  // ── 启动 ──────────────

  /** 初始化：读配置 → 取宿主当前运价表 → 按已存偏好算一次（失败不阻断，页要能打开） */
  async function init(): Promise<void> {
    isLoading.value = true;
    try {
      await loadState();
      await resync();
    } catch (e) {
      console.error('[shipping-rate] init failed:', e);
    } finally {
      isLoading.value = false;
      ready.value = true;
    }
  }

  /**
   * 重复进入本资料项时刷新（不重读持久化偏好）。
   *
   * 为什么不直接再跑 init()：偏好是**防抖落盘**的（500ms），用户改完取整口径
   * 半秒内切走再回来，init() 会把内存里的新值用storage 里的旧值覆盖掉 ——
   * 界面看着"自己退回旧设置"，且没有任何提示。偏好进内存后就以内存为准，
   * 重复进入只刷新**宿主侧**的运价表快照与报价结果。
   */
  async function resync(): Promise<void> {
    await syncTableFromHost();
    if (hasTable.value) await refreshQuote();
  }

  return {
    // 状态
    table, source, sheetNames, lastFile, candidates,
    weight, category, variant, rounding,
    results, filter, resultWeight, isLoading, ready,
    orderRows, orderSummary, productRows, productSummary, productCountry,
    busyOrders, busyProducts,
    // 派生
    hasTable, countriesSorted, usableCandidates, filteredResults, resultStats,
    // 动作
    setWeight, setCategory, setVariant, setRounding, setFilter, setProductCountry,
    refreshQuote, copyAll, copyRow,
    importByDialog, switchSheet,
    runQuoteOrders, runQuoteProducts,
    init, resync,
  };
});
