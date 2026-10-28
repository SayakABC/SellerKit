// 记账页的取数与筛选状态（视图与弹层共用一份）。
//
// 为什么要抽出来：明细页的筛选条与「记一笔」弹层都要读同一批主数据（科目 / 相关人 / 店铺），
// 且保存后必须让**列表与本期合计一起刷新**。分散在组件 ref 里最容易出现"存了但列表还是旧的"。
import { computed, reactive, ref } from 'vue';
import { useModuleStorage } from '@/core/services/storage';
import { localDayKey } from '@/lib/localDay';
import type {
  LedgerCategoryRow,
  LedgerEntryFilter,
  LedgerEntryRow,
  LedgerPartyRow,
  LedgerScope,
  LedgerSummary,
  LedgerKind,
  ShopListItem,
} from '@/types';
import * as api from './api';

const STORAGE_KEY = 'ledger';

/** 记账页的四个视图（明细 / 往来 / 单店 / 汇总）。切换不算筛选，不触发取数 —— 各页自己加载。 */
export type LedgerTab = 'detail' | 'parties' | 'shop' | 'summary';

const LEDGER_TABS: readonly LedgerTab[] = ['detail', 'parties', 'shop', 'summary'];

/**
 * 「全部日期」的哨兵值。
 *
 * 为什么不是空串：空串是"这个字段没传"的默认形状，主进程与假桥都把
 * `period: ''` 当"不过滤"，一旦偏好文件里的月份丢了/写坏了，界面会**静默**变成全部期间，
 * 而用户以为自己在看本月 —— 这是最难发现的一类（数字全对，只是范围错了）。
 * 用一个不可能与 `YYYY-MM` 撞车的 `'all'`，坏值就只会落回本月这一种结果。
 */
export const ALL_PERIOD = 'all';

/** 跨会话保留的界面偏好（命名空间 `ledger`，见 AGENTS.md §1.4 与基线 §6） */
export interface LedgerPrefs {
  tab?: LedgerTab;
  /** `YYYY-MM`，或 `ALL_PERIOD`（全部日期）；其它值一律回落本月 */
  month?: string;
  kind?: '' | LedgerKind;
  shopId?: number;
  categoryId?: number;
  partyId?: number;
  scope?: '' | LedgerScope;
  settleStatus?: '' | 'settled' | 'unsettled';
  includeVoid?: boolean;
  /** 单店视图看的是哪家店（与明细页的 `shopId` 筛选分开：一个是"筛账"，一个是"看店"） */
  shopViewId?: number;
  /** 「记一笔」记住上次选的相关人（收入/支出各一个）—— 必填字段的摩擦靠这个降下来 */
  lastParty?: { income: number; expense: number };
}

export type SettleFilter = '' | 'settled' | 'unsettled';

export function useLedger() {
  const storage = useModuleStorage<LedgerPrefs>(STORAGE_KEY);

  const today = localDayKey();
  const tab = ref<LedgerTab>('detail');
  const month = ref(today.slice(0, 7));
  const kind = ref<'' | LedgerKind>('');
  const shopId = ref(0);
  const categoryId = ref(0);
  const partyId = ref(0);
  const scope = ref<'' | LedgerScope>('');
  const settleStatus = ref<SettleFilter>('');
  const includeVoid = ref(false);
  const keyword = ref('');
  const shopViewId = ref(0);

  const rows = ref<LedgerEntryRow[]>([]);
  const summary = ref<LedgerSummary | null>(null);
  const categories = ref<LedgerCategoryRow[]>([]);
  const parties = ref<LedgerPartyRow[]>([]);
  const shops = ref<ShopListItem[]>([]);
  const lastParty = reactive<{ income: number; expense: number }>({ income: 0, expense: 0 });

  const loading = ref(false);
  const error = ref('');
  /** 主数据（科目 / 相关人 / 店铺）读取失败：与列表错误分开，否则 `load()` 一清就把原因洗掉 */
  const masterError = ref('');
  let prefsLoaded = false;

  const prefs = computed<LedgerPrefs>(() => ({
    tab: tab.value,
    month: month.value,
    kind: kind.value,
    shopId: shopId.value,
    categoryId: categoryId.value,
    partyId: partyId.value,
    scope: scope.value,
    settleStatus: settleStatus.value,
    includeVoid: includeVoid.value,
    shopViewId: shopViewId.value,
    lastParty: { income: lastParty.income, expense: lastParty.expense },
  }));

  function persist(): void {
    if (!prefsLoaded) return;
    storage.scheduleSave(prefs.value);
  }

  function monthLabel(): string {
    if (month.value === ALL_PERIOD) return '全部日期';
    const [y, m] = month.value.split('-');
    return `${y}年${Number(m)}月`;
  }

  const isAllPeriod = computed(() => month.value === ALL_PERIOD);

  /**
   * 切到「全部日期」：不筛选月份，明细列出库里的全部条目。
   *
   * 只有**明细**页有这个概念（列表 + 合计都是流量，跨月相加有意义）。
   * 单店 / 汇总页按月做归集与营收占比，全期间会让"占比"的分母失去意义，
   * 所以那两页在全部期间下会自己提示"请选具体月份"（见 ShopView / SummaryView）。
   */
  function setAllPeriod(): void {
    if (month.value === ALL_PERIOD) return;
    month.value = ALL_PERIOD;
    persist();
    void load();
  }

  function shiftMonth(delta: number): void {
    // 全部期间下按 ‹ › 等于"从本月开始翻"；不判就会 split 出 NaN 并**静默**写成 `NaN-NaN`
    // （`${NaN}-${NaN}` 是合法字符串，regex 拦不住，主进程按它查只会返回空列表）
    const base = month.value === ALL_PERIOD ? localDayKey().slice(0, 7) : month.value;
    const [y, m] = base.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    month.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    persist();
    void load();
  }

  function resetFilters(): void {
    kind.value = '';
    shopId.value = 0;
    categoryId.value = 0;
    partyId.value = 0;
    scope.value = '';
    settleStatus.value = '';
    includeVoid.value = false;
    keyword.value = '';
    persist();
    void load();
  }

  const filter = computed<LedgerEntryFilter>(() => ({
    // 全部日期 = **不传** period（主进程见 period 为空即不过滤）。
    // 不能传 `ALL_PERIOD`：主进程只做 slice 不校验格式，会拼成 `e.period = 'all'` 而查不到任何行，
    // 结果是"点了全部反而一片空白"，还没有任何报错。
    period: month.value === ALL_PERIOD ? undefined : month.value,
    kind: kind.value || undefined,
    shopId: shopId.value || undefined,
    categoryId: categoryId.value || undefined,
    partyId: partyId.value || undefined,
    scope: scope.value || undefined,
    settleStatus: settleStatus.value || undefined,
    includeVoid: includeVoid.value,
    keyword: keyword.value.trim() || undefined,
    limit: 1000,
  }));

  /** 主数据（科目 / 相关人 / 店铺）：改完任意一项都要重取，否则下拉里还是旧的 */
  async function loadMasterData(): Promise<void> {
    // 店铺失败**不降级成空数组**：空数组会渲染成"没有店铺"，把"读不到"伪装成"没有数据"，
    // 用户会照着空态去基础数据重复建店（审查 P1-10）。
    const [cats, ps, sh] = await Promise.all([api.categories(undefined, true), api.parties(true), api.shops()]);
    categories.value = cats;
    parties.value = ps;
    shops.value = sh;
  }

  async function reloadMasterData(): Promise<void> {
    try {
      await loadMasterData();
      masterError.value = '';
    } catch (e: unknown) {
      masterError.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** 筛选变更的统一出口：落盘 + 取数。少一处 persist 就会出现"筛了但重启即丢" */
  function applyFilter(): void {
    persist();
    void load();
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const [list, sum] = await Promise.all([
        api.entries(filter.value),
        // 全部日期传 `''`（= 全期间汇总），与「往来」页对账用的是同一个口径
        api.summary(month.value === ALL_PERIOD ? '' : month.value),
      ]);
      rows.value = list;
      summary.value = sum;
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
      rows.value = [];
      summary.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function init(): Promise<void> {
    try {
      await api.ensure();
    } catch {
      // 建表失败由后面的取数报出来（这里吞掉只会隐藏真正的原因）
    }
    const saved = await storage.load();
    if (saved) {
      // 旧版本只存过 detail / parties；未知值一律回落明细，不做硬失败
      tab.value = saved.tab && LEDGER_TABS.includes(saved.tab) ? saved.tab : 'detail';
      // `all` 与 `YYYY-MM` 都是合法值，其余（含历史坏数据）回落本月
      if (saved.month === ALL_PERIOD || (saved.month && /^\d{4}-\d{2}$/.test(saved.month))) {
        month.value = saved.month;
      }
      kind.value = saved.kind ?? '';
      shopId.value = Number(saved.shopId) || 0;
      categoryId.value = Number(saved.categoryId) || 0;
      partyId.value = Number(saved.partyId) || 0;
      scope.value = saved.scope ?? '';
      settleStatus.value = saved.settleStatus ?? '';
      includeVoid.value = saved.includeVoid === true;
      shopViewId.value = Number(saved.shopViewId) || 0;
      lastParty.income = Number(saved.lastParty?.income) || 0;
      lastParty.expense = Number(saved.lastParty?.expense) || 0;
    }
    prefsLoaded = true;
    await reloadMasterData();
    await load();
  }

  function rememberParty(k: LedgerKind, id: number): void {
    lastParty[k] = id;
    persist();
  }

  return {
    tab,
    month,
    monthLabel,
    isAllPeriod,
    setAllPeriod,
    shiftMonth,
    kind,
    shopId,
    categoryId,
    partyId,
    scope,
    settleStatus,
    includeVoid,
    keyword,
    shopViewId,
    rows,
    summary,
    categories,
    parties,
    shops,
    lastParty,
    loading,
    error,
    masterError,
    init,
    load,
    loadMasterData,
    reloadMasterData,
    applyFilter,
    resetFilters,
    rememberParty,
    persist,
  };
}
