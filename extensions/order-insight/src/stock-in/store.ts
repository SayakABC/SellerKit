// extensions/order-insight/src/stock-in/store.ts
// 「拿货对账」（内嵌于 order-insight 的 stock-in Tab）状态：厂商 / 拿货单 / 付款 / 对账汇总 / 待拿货缺口（实时差量）。
// 金额统一以"分"整数存储；界面展示用「元」输入，进出经 yuanToCents / centsToYuan 转换。

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { selectExcelFile } from '@/core/services/dialog';
import type {
  Supplier,
  PurchaseOrder,
  PurchaseItem,
  Payment,
  ReconciliationRow,
  OutstandingRow,
  IgnoreRow,
  PurchaseSourceRow,
  ShopAllocationRow,
  ShopAllocationDetailRow,
} from '@/types';

// ---- 金额工具（元 ↔ 分） ----
export function yuanToCents(yuan: number): number {
  return Math.max(0, Math.round((Number.isFinite(yuan) ? yuan : 0) * 100));
}
export function centsToYuan(cents: number): string {
  return ((Number.isFinite(cents) ? cents : 0) / 100).toFixed(2);
}

/** 从数据统计跳转带来的来源订单行（当前筛选/归类的订单明细，含店铺与尺码），
 * 既用于生成拿货单草稿明细（按款色码聚合），也作为来源快照锁定店铺归属。 */
export type StockInSourceRow = PurchaseSourceRow;

/** 父级 OrderInsightView → StockInView 的进入意图：n 为自增序号（重复动作也能触发消费）；
 * sub 定位内部子 Tab；draftRows 为「生成拿货单」来源订单行（缺省则仅切 Tab）。 */
export interface StockInIntent {
  n: number;
  sub?: 'purchase' | 'recon';
  draftRows?: PurchaseSourceRow[];
}

/** 缺口「档口」分配键：款编码（同款所有款色/尺码默认一起去同一档口拿，可逐款改） */
export function planKeyOf(r: { styleCode: string }): string {
  return r.styleCode.trim();
}

/** 按款色码聚合来源订单行 → 草稿明细行（建议数量=合计件数） */
function aggregateSources(sources: StockInSourceRow[]): PurchaseItem[] {
  const map = new Map<string, PurchaseItem>();
  for (const s of sources) {
    const code = s.styleCode.trim();
    const color = s.color || '';
    const size = s.size || '';
    if (!code) continue;
    const key = `${code}\u0000${color}\u0000${size}`;
    const hit = map.get(key);
    if (hit) {
      hit.qty += Math.max(0, Math.round(s.qty || 0));
      hit.suggestionQty = hit.qty;
    } else {
      map.set(key, {
        styleCode: code,
        styleName: s.styleName || '',
        color,
        size,
        qty: Math.max(0, Math.round(s.qty || 0)),
        priceCents: 0,
        amountCents: 0,
        suggestionQty: Math.max(0, Math.round(s.qty || 0)),
      });
    }
  }
  return [...map.values()];
}

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthFrom(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
}

function monthEnd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())}`;
}

function yearFrom(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function yearEnd(): string {
  return `${new Date().getFullYear()}-12-31`;
}

/** 对账时间窗口：all 全部 / day 今天 / month 本月 / year 本年 / custom 自定义起止 */
type ReconRange = 'all' | 'day' | 'month' | 'year' | 'custom';

const RECON_RANGE_LABEL: Record<ReconRange, string> = {
  all: '全部',
  day: '今天',
  month: '本月',
  year: '本年',
  custom: '自定义',
};

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.round(n)) : 0;
}

export const useStockInStore = defineStore('stock-in', () => {
  // ---- 数据 ----
  const suppliers = ref<Supplier[]>([]);
  const orders = ref<PurchaseOrder[]>([]);
  const payments = ref<Payment[]>([]);
  const recon = ref<ReconciliationRow[]>([]);
  const outstanding = ref<OutstandingRow[]>([]);
  const ignores = ref<IgnoreRow[]>([]);
  /** 缺口「档口」分配：key = 款编码 → 计划拿货档口 id（当天规划，不持久化；刷新后未手选过的自动按历史建议） */
  const planSupplier = ref<Record<string, number>>({});
  const shopAlloc = ref<ShopAllocationRow[]>([]);
  const shopAllocLoading = ref(false);
  const loaded = ref(false);
  const loading = ref(false);
  const generating = ref(false);

  // ---- 对账时间筛选（全部/今天/本月/本年/自定义） ----
  const reconRange = ref<ReconRange>('all');
  /** 自定义区间（仅 reconRange === 'custom' 时生效），格式 yyyy-MM-dd */
  const reconCustomFrom = ref('');
  const reconCustomTo = ref('');
  const reconFrom = computed(() => {
    switch (reconRange.value) {
      case 'day':
        return localToday();
      case 'month':
        return monthFrom();
      case 'year':
        return yearFrom();
      case 'custom':
        return reconCustomFrom.value || undefined;
      default:
        return undefined;
    }
  });
  const reconTo = computed(() => {
    switch (reconRange.value) {
      case 'day':
        return localToday();
      case 'month':
        return monthEnd();
      case 'year':
        return yearEnd();
      case 'custom':
        return reconCustomTo.value || undefined;
      default:
        return undefined;
    }
  });
  /** 当前窗口展示文案（差额核对面板等） */
  const reconLabel = computed(() => {
    if (reconRange.value === 'custom' && reconCustomFrom.value && reconCustomTo.value) {
      return `${reconCustomFrom.value} ~ ${reconCustomTo.value}`;
    }
    return RECON_RANGE_LABEL[reconRange.value];
  });

  // ---- 拿货单编辑态（新建草稿 / 编辑已有） ----
  const editing = ref<PurchaseOrder | null>(null);
  const draftItems = ref<PurchaseItem[]>([]);
  const draftSupplierId = ref<number>(0);
  const draftBizDate = ref<string>(localToday());
  const draftNote = ref<string>('');
  const draftMode = ref<'detail' | 'package'>('detail');
  const draftPackageTotalYuan = ref<string>('0');
  /** 本次草稿的来源订单快照（新建时锁定店铺归属；编辑已有单不重置） */
  const draftSources = ref<PurchaseSourceRow[]>([]);
  const saving = ref(false);
  const submitting = ref(false);

  // ---- 弹窗 ----
  const supplierModalOpen = ref(false);
  const paymentModalOpen = ref(false);
  const paySupplierId = ref<number>(0);
  const payDefaultType = ref<'payment' | 'refund'>('payment');

  // ---- 计算 ----
  const editingTotalCents = computed(() =>
    draftItems.value.reduce((s, it) => s + (it.qty || 0) * (it.priceCents || 0), 0),
  );
  const editingSupplierName = computed(
    () => suppliers.value.find((s) => s.id === draftSupplierId.value)?.name ?? '',
  );
  /** 各款最近一次从哪个档口拿货（同款多款色按同一档口记忆；拿货单按日期倒序；submitted 优先，草稿兜底） */
  const recentSupplierOf = computed(() => {
    const map = new Map<string, number>();
    const scan = (status: 'submitted' | 'draft') => {
      for (const o of orders.value) {
        if (o.status !== status) continue;
        for (const it of o.items) {
          const code = it.styleCode.trim();
          if (!code || map.has(code)) continue;
          map.set(code, o.supplierId);
        }
      }
    };
    scan('submitted');
    scan('draft');
    return map;
  });
  const selectedRecon = computed(() => {
    const rows = recon.value;
    return rows;
  });

  // ---- 初始化 ----
  async function ensure() {
    const r = await ipc.purchaseDbEnsure();
    if (!r.success) toast(`数据库初始化失败: ${r.error}`, 'error');
  }

  async function refreshAll() {
    loading.value = true;
    try {
      await ensure();
      const [sup, ord, pay, oust, ign, rec] = await Promise.all([
        ipc.purchaseSupplierList(),
        ipc.purchaseOrderList(),
        ipc.purchasePaymentList(),
        ipc.purchaseOutstanding(),
        ipc.purchaseIgnoreList(),
        ipc.purchaseReconciliation({ from: reconFrom.value, to: reconTo.value }),
      ]);
      if (sup.success) suppliers.value = sup.data ?? [];
      if (ord.success) orders.value = ord.data ?? [];
      if (pay.success) payments.value = pay.data ?? [];
      if (oust.success) outstanding.value = oust.data ?? [];
      if (ign.success) ignores.value = ign.data ?? [];
      if (rec.success) recon.value = rec.data ?? [];
      loaded.value = true;
      initOutstandingPlan();
    } finally {
      loading.value = false;
    }
  }

  async function ensureLoaded() {
    if (loaded.value) return;
    await refreshAll();
  }

  /** 缺口表刷新后，为尚未分配档口的款补上默认建议（最近拿货档口；用户已选的不覆盖） */
  function initOutstandingPlan(): void {
    const rec = recentSupplierOf.value;
    const next = { ...planSupplier.value };
    let changed = false;
    for (const r of outstanding.value) {
      const key = planKeyOf(r);
      if (next[key] !== undefined) continue;
      next[key] = rec.get(key) ?? 0;
      changed = true;
    }
    if (changed) planSupplier.value = next;
  }

  // ---- 厂商 ----
  async function createSupplier(name: string, phone: string, note: string) {
    const r = await ipc.purchaseSupplierCreate({ name, phone, note });
    if (!r.success) {
      toast(r.error || '新建厂商失败', 'error');
      return false;
    }
    await refreshAll();
    toast(`厂商「${name}」已创建`, 'success');
    return true;
  }

  async function updateSupplier(id: number, phone: string, note: string) {
    const r = await ipc.purchaseSupplierUpdate({ id, phone, note });
    if (!r.success) {
      toast(r.error || '更新厂商失败', 'error');
      return false;
    }
    await refreshAll();
    toast('厂商已更新', 'success');
    return true;
  }

  async function deleteSupplier(id: number, name: string) {
    if (!window.confirm(`确认删除厂商「${name}」？已有拿货单或付款记录时无法删除。`)) return;
    const r = await ipc.purchaseSupplierDelete({ id });
    if (!r.success) {
      toast(r.error || '删除失败', 'error');
      return;
    }
    await refreshAll();
    toast('厂商已删除', 'success');
  }

  // ---- 拿货单草稿 ----
  /** 新建拿货单草稿：从数据统计跳转（sources 携带店铺/尺码）或待拿货缺口生成明细（款色码粒度） */
  async function newDraft(supplierId?: number, sources?: StockInSourceRow[]) {
    editing.value = null;
    draftMode.value = 'detail';
    draftSupplierId.value = supplierId ?? 0;
    draftBizDate.value = localToday();
    draftNote.value = '';
    draftPackageTotalYuan.value = '0';
    draftSources.value = sources && sources.length > 0 ? sources.map((s) => ({ ...s })) : [];
    let rows: PurchaseItem[];
    if (draftSources.value.length > 0) {
      rows = aggregateSources(draftSources.value);
    } else {
      // 缺口按档口批量拆单已升级为 generateBySupplier()；这里保留两条路径：
      // 1) 从数据统计跳转（sources）在上方分支处理；
      // 2) 手动「新建拿货单」= 空白单（不预填缺口），或按指定档口从缺口拉该档口的款。
      const targetId = supplierId && supplierId > 0 ? supplierId : 0;
      const candidates =
        targetId > 0
          ? outstanding.value.filter((r) => planSupplier.value[planKeyOf(r)] === targetId)
          : [];
      if (targetId > 0 && candidates.length === 0) {
        toast('该档口还没有分配款：请在缺口表把要去它家拿的款选好「档口」', 'info');
        draftItems.value = [];
        return;
      }
      rows = candidates.map((r) => ({
        styleCode: r.styleCode.trim(),
        styleName: r.styleName || '',
        color: (r.color || '').trim(),
        size: (r.size || '').trim(),
        qty: r.missing,
        priceCents: 0,
        amountCents: 0,
        suggestionQty: r.missing,
      }));
    }
    // 预填最近单价（同款衣服自动填价：优先当前厂商，未命中或未选厂商时按款色全局记忆）
    await Promise.all(
      rows.map(async (row) => {
        const r = await ipc.purchasePriceHistory({
          supplierId: draftSupplierId.value,
          styleCode: row.styleCode,
          color: row.color,
        });
        if (r.success) row.priceCents = r.data?.priceCents ?? 0;
      }),
    );
    draftItems.value = rows;
  }

  /** 一键按档口拆单：把缺口表中已分配档口的款，按档口各生成一张拿货单草稿
   * （数量=缺口建议值，单价自动带出该档口的历史价）；未分配档口的款不生成。
   * 生成后自动打开第一张草稿便于核对/提交。 */
  async function generateBySupplier(): Promise<void> {
    if (editing.value) {
      toast('请先取消右侧编辑，再按档口生成拿货单', 'info');
      return;
    }
    const groups = new Map<number, OutstandingRow[]>();
    let unassigned = 0;
    for (const r of outstanding.value) {
      const sid = planSupplier.value[planKeyOf(r)] ?? 0;
      if (sid <= 0) {
        unassigned += 1;
        continue;
      }
      const arr = groups.get(sid);
      if (arr) arr.push(r);
      else groups.set(sid, [r]);
    }
    if (groups.size === 0) {
      toast('缺口表还没有分配档口的款：请先给每款选好「档口」', 'info');
      return;
    }
    const nameOf = (sid: number) => suppliers.value.find((s) => s.id === sid)?.name ?? '档口#' + sid;
    const entries = [...groups.entries()];
    const summary = entries.map(([sid, rows]) => `${nameOf(sid)}（${rows.length} 项）`).join('、');
    const tip = unassigned > 0 ? `\n另有 ${unassigned} 项未指定档口，本次不会生成。` : '';
    const ok = window.confirm(
      `将按档口拆成 ${entries.length} 张拿货单草稿：\n${summary}${tip}\n数量=缺口建议，单价自动带历史价；生成后可在下方记录逐张编辑/导出/提交。确认生成？`,
    );
    if (!ok) return;
    generating.value = true;
    try {
      const created: number[] = [];
      for (const [sid, rows] of entries) {
        const items: PurchaseItem[] = [];
        for (const r of rows) {
          const styleCode = r.styleCode.trim();
          const color = (r.color || '').trim();
          const item: PurchaseItem = {
            styleCode,
            styleName: r.styleName || '',
            color,
            size: (r.size || '').trim(),
            qty: r.missing,
            priceCents: 0,
            amountCents: 0,
            suggestionQty: r.missing,
          };
          const p = await ipc.purchasePriceHistory({ supplierId: sid, styleCode, color });
          if (p.success) item.priceCents = p.data?.priceCents ?? 0;
          items.push(item);
        }
        const r = await ipc.purchaseOrderCreate({
          supplierId: sid,
          bizDate: localToday(),
          mode: 'detail',
          note: '',
          items,
        });
        if (!r.success || !r.data) {
          toast(`「${nameOf(sid)}」生成失败：${r.success ? '返回数据缺失' : r.error}`, 'error');
          continue;
        }
        created.push(r.data.id);
      }
      await refreshAll();
      if (created.length > 0) {
        toast(`已按档口生成 ${created.length} 张拿货单草稿（在下方记录中逐一编辑/提交）`, 'success');
        await editOrder(created[0]);
      }
    } finally {
      generating.value = false;
    }
  }

  /** 输入款编码/款色后自动带出同款衣服最近单价（仅当该行尚未定价时） */
  async function autoFillPrice(item: PurchaseItem) {
    const code = item.styleCode.trim();
    if (!code || item.priceCents > 0) return;
    const r = await ipc.purchasePriceHistory({
      supplierId: draftSupplierId.value,
      styleCode: code,
      color: item.color.trim(),
    });
    if (r.success && r.data?.priceCents && item.priceCents === 0) {
      item.priceCents = r.data.priceCents;
    }
  }

  /** 载入已有拿货单进入编辑态 */
  async function editOrder(id: number) {
    const r = await ipc.purchaseOrderGet({ id });
    if (!r.success || !r.data) {
      toast(r.error || '加载拿货单失败', 'error');
      return;
    }
    const o = r.data;
    editing.value = o;
    draftSources.value = [];
    draftMode.value = o.mode;
    draftSupplierId.value = o.supplierId;
    draftBizDate.value = o.bizDate;
    draftNote.value = o.note;
    draftItems.value = o.items.map((it) => ({ ...it }));
    draftPackageTotalYuan.value = (o.totalCents / 100).toFixed(2);
  }

  function addDraftRow() {
    draftItems.value.push({
      styleCode: '',
      styleName: '',
      color: '',
      size: '',
      qty: 0,
      priceCents: 0,
      amountCents: 0,
      suggestionQty: 0,
    });
  }

  function removeDraftRow(idx: number) {
    draftItems.value.splice(idx, 1);
  }

  /** 保存草稿（新建或更新；金额由主进程重算）。返回是否保存成功（失败时已 toast）。 */
  async function saveDraft(opts: { silent?: boolean } = {}): Promise<boolean> {
    if (draftSupplierId.value <= 0) {
      toast('请先选择厂商', 'error');
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftBizDate.value)) {
      toast('日期格式不正确', 'error');
      return false;
    }
    if (draftMode.value === 'detail' && draftItems.value.every((it) => !it.styleCode.trim())) {
      toast('拿货明细为空', 'error');
      return false;
    }
    saving.value = true;
    try {
      const items = draftItems.value
        .filter((it) => it.styleCode.trim() && it.qty > 0)
        .map((it) => ({ ...it, amountCents: (it.qty || 0) * (it.priceCents || 0) }));
      const totalCents =
        draftMode.value === 'package' ? yuanToCents(Number(draftPackageTotalYuan.value)) : undefined;
      if (editing.value) {
        const r = await ipc.purchaseOrderUpdate({ id: editing.value.id, bizDate: draftBizDate.value, note: draftNote.value, items, totalCents });
        if (!r.success) {
          toast(r.error || '保存失败', 'error');
          return false;
        }
      } else {
        const r = await ipc.purchaseOrderCreate({
          supplierId: draftSupplierId.value,
          bizDate: draftBizDate.value,
          mode: draftMode.value,
          note: draftNote.value,
          items,
          totalCents,
          sources: draftSources.value.length ? draftSources.value : undefined,
        });
        if (!r.success) {
          toast(r.error || '保存失败', 'error');
          return false;
        }
        draftSources.value = [];
      }
      await refreshAll();
      if (!opts.silent) toast('已保存（草稿）', 'success');
      return true;
    } finally {
      saving.value = false;
    }
  }

  /** 提交拿货单：先把编辑面板当前内容写库，再置为已提交；未拿全的款色自动保留在待拿货 */
  async function submitDraft() {
    if (!editing.value) {
      toast('请先保存草稿再提交', 'info');
      return;
    }
    submitting.value = true;
    try {
      // 关键：直接提交时先把编辑面板最新明细落库（静默保存），避免“编辑后提交丢更新”
      const ok = await saveDraft({ silent: true });
      if (!ok) return; // 校验/保存失败已 toast，中止提交
      const r = await ipc.purchaseOrderSubmit({ id: editing.value.id });
      if (!r.success) {
        toast(r.error || '提交失败', 'error');
        return;
      }
      await refreshAll();
      toast('拿货单已提交', 'success');
      const leftover = outstanding.value.length;
      if (leftover > 0) {
        toast(`有 ${leftover} 项未拿全，已保留到待拿货清单`, 'info');
      }
      editing.value = null;
      draftItems.value = [];
      draftSources.value = [];
    } finally {
      submitting.value = false;
    }
  }

  /** 直接提交拿货单（列表操作；未保存的草稿请先保存） */
  async function submitOrder(id: number) {
    submitting.value = true;
    try {
      const r = await ipc.purchaseOrderSubmit({ id });
      if (!r.success) {
        toast(r.error || '提交失败', 'error');
        return;
      }
      await refreshAll();
      toast('拿货单已提交', 'success');
      const leftover = outstanding.value.length;
      if (leftover > 0) toast(`有 ${leftover} 项未拿全，已保留到待拿货清单`, 'info');
      if (editing.value?.id === id) {
        editing.value = null;
        draftItems.value = [];
        draftSources.value = [];
      }
    } finally {
      submitting.value = false;
    }
  }

  /** 取消编辑：清空编辑态（草稿已保存的仍在列表中，未保存的丢弃） */
  function cancelDraft() {
    editing.value = null;
    draftItems.value = [];
    draftNote.value = '';
    draftSources.value = [];
  }

  async function deleteOrder(order: PurchaseOrder) {
    const tip =
      order.status === 'submitted'
        ? `删除后该单已拿数量将回滚，差额回到待拿货清单。`
        : '';
    if (!window.confirm(`确认删除 ${order.bizDate} 的拿货单（${order.supplierName}）？${tip}`)) return;
    const r = await ipc.purchaseOrderDelete({ id: order.id });
    if (!r.success) {
      toast(r.error || '删除失败', 'error');
      return;
    }
    if (editing.value?.id === order.id) {
      editing.value = null;
      draftItems.value = [];
      draftSources.value = [];
    }
    await refreshAll();
    toast('拿货单已删除', 'success');
  }

  // ---- 待拿货缺口 ----
  async function addIgnore(row: OutstandingRow, reason: string) {
    const r = await ipc.purchaseIgnoreAdd({
      styleCode: row.styleCode,
      color: row.color,
      reason,
    });
    if (!r.success) {
      toast(r.error || '操作失败', 'error');
      return;
    }
    await refreshAll();
    toast(`${row.styleCode}${row.color ? ' ' + row.color : ''} 已标记无需补货`, 'success');
  }

  async function removeIgnore(row: IgnoreRow) {
    const r = await ipc.purchaseIgnoreRemove({ styleCode: row.styleCode, color: row.color });
    if (!r.success) {
      toast(r.error || '操作失败', 'error');
      return;
    }
    await refreshAll();
  }

  // ---- 付款 ----
  async function addPayment(input: {
    supplierId: number;
    payDate: string;
    type: 'payment' | 'refund';
    yuan: number;
    method: string;
    note: string;
  }) {
    const amountCents = yuanToCents(input.yuan);
    if (amountCents <= 0) {
      toast('金额必须大于 0', 'error');
      return false;
    }
    const r = await ipc.purchasePaymentAdd({
      supplierId: input.supplierId,
      payDate: input.payDate,
      type: input.type,
      amountCents,
      method: input.method,
      note: input.note,
    });
    if (!r.success) {
      toast(r.error || '记款失败', 'error');
      return false;
    }
    await refreshAll();
    toast(input.type === 'refund' ? '退款已记录' : '付款已记录', 'success');
    return true;
  }

  async function deletePayment(p: Payment) {
    if (!window.confirm(`确认删除 ${p.supplierName} 的${p.type === 'refund' ? '退款' : '付款'}记录？`)) return;
    const r = await ipc.purchasePaymentDelete({ id: p.id });
    if (!r.success) {
      toast(r.error || '删除失败', 'error');
      return;
    }
    await refreshAll();
  }

  // ---- 店铺对账（拿货成本按来源订单拆分到店铺） ----
  /** 刷新店铺对账汇总（按当前对账时间窗） */
  async function loadShopAllocation() {
    shopAllocLoading.value = true;
    try {
      const r = await ipc.purchaseShopAllocation({ from: reconFrom.value, to: reconTo.value });
      if (r.success) shopAlloc.value = r.data ?? [];
    } finally {
      shopAllocLoading.value = false;
    }
  }

  /** 拉取指定店铺的对账明细行 */
  async function fetchShopDetail(shop: string): Promise<ShopAllocationDetailRow[]> {
    const r = await ipc.purchaseShopAllocationDetail({ shop, from: reconFrom.value, to: reconTo.value });
    return r.success ? (r.data ?? []) : [];
  }

  // ---- 拿货单 Excel 导出 / 导入回填 ----
  /** 导出拿货单（款色 + 建议数量 + 实拿数量 + 单价，款编码+款色自动嵌入款色图），现场填写后导回 */
  async function exportOrderExcel(order: PurchaseOrder) {
    try {
      // order.items 来自响应式列表（Vue reactive Proxy），contextBridge/IPC 结构化克隆无法处理代理对象，
      // 会抛 "An object could not be cloned."，必须先转成普通对象副本。
      const items: PurchaseItem[] = JSON.parse(JSON.stringify(order.items ?? []));
      const saved = await ipc.purchaseExportExcel({
        items,
        defaultName: `拿货单-${order.supplierName || '档口'}-${order.bizDate || ''}`,
      });
      if (!saved.success) {
        // 用户在保存对话框点了取消，属正常操作，不提示失败
        if (saved.error === '__canceled__') return;
        throw new Error(saved.error || '导出失败');
      }
      toast('已导出拿货单（含款色图）到 ' + saved.data?.filePath, 'success');
    } catch (e: unknown) {
      toast('导出失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
    }
  }

  /** 导入现场填写的拿货单：按 款编码+款色 匹配回填实拿数量与单价 */
  async function importOrderExcel() {
    if (!editing.value) {
      toast('请先进入拿货单编辑（新建或编辑）再导入', 'info');
      return;
    }
    const file = await selectExcelFile();
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(file.data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('Excel 中没有工作表');
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      let hit = 0;
      draftItems.value = draftItems.value.map((it) => {
        const row = rows.find(
          (r) =>
            String(r['款编码'] ?? '').trim() === it.styleCode.trim() &&
            String(r['款色'] ?? '').trim() === it.color.trim() &&
            String(r['尺码'] ?? '').trim() === (it.size || '').trim(),
        );
        if (!row) return it;
        const qty = toNum(row['实拿数量']);
        const priceCents = yuanToCents(Number(row['单价(元)']));
        hit += 1;
        return {
          ...it,
          qty,
          priceCents,
          amountCents: qty * priceCents,
        };
      });
      toast(hit > 0 ? `已回填 ${hit} 行（未匹配行保持原值）` : '未匹配到任何行（请检查款编码/款色/尺码列）', hit > 0 ? 'success' : 'error');
    } catch (e: unknown) {
      toast('导入失败: ' + (e instanceof Error ? e.message : '未知错误'), 'error');
    }
  }

  return {
    // state
    suppliers,
    orders,
    payments,
    recon,
    outstanding,
    ignores,
    planSupplier,
    shopAlloc,
    shopAllocLoading,
    loaded,
    loading,
    generating,
    reconRange,
    reconCustomFrom,
    reconCustomTo,
    reconFrom,
    reconTo,
    reconLabel,
    editing,
    draftItems,
    draftSupplierId,
    draftBizDate,
    draftNote,
    draftMode,
    draftPackageTotalYuan,
    draftSources,
    saving,
    submitting,
    supplierModalOpen,
    paymentModalOpen,
    paySupplierId,
    payDefaultType,
    // computed
    editingTotalCents,
    editingSupplierName,
    recentSupplierOf,
    selectedRecon,
    // actions
    ensure,
    refreshAll,
    ensureLoaded,
    createSupplier,
    updateSupplier,
    deleteSupplier,
    newDraft,
    generateBySupplier,
    autoFillPrice,
    editOrder,
    addDraftRow,
    removeDraftRow,
    saveDraft,
    submitDraft,
    submitOrder,
    cancelDraft,
    deleteOrder,
    addIgnore,
    removeIgnore,
    addPayment,
    deletePayment,
    loadShopAllocation,
    fetchShopDetail,
    exportOrderExcel,
    importOrderExcel,
  };
});
