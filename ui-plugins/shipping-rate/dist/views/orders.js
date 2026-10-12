// dist/views/orders.js
// 按订单试算页：订单（收货国家 + 款色码）× **产品库 SKU 克重** × 运价表 → 逐单实际运费。
//
// 数据流（本页**零算术**，与 quote 同策略）：
//   「试算」→ 宿主自取最近订单（最小投影）→ 提取 收货国家/款色码 → 联产品库 SKU 克重 → 逐单计价。
// 拒算必须逐单给原因（缺重量 / 没国家 / 表没该国 / 无价 / 未接汇率），不静默丢行。
//
// ⚠️ 1.3.0（2026-10-01）：**「导入商品信息（商品ID 克重）」这条链已删**（用户领域裁定：
//    克重是 SKU 属性，商品ID 上没有克重）。克重唯一来源 = 产品库 `pl_variants.weight_g`，
//    在宿主「货与成本」按 SKU 维护；本页只读、不再有导入按钮。

import { notify } from '../bridge.js';
import { onClick, refresh, renderRegion, state } from '../app.js';
import { esc, gramsText, money } from '../lib.js';
import * as api from '../api.js';
import * as store from '../store.js';

/** 结果表最多渲染的行数（其余折叠为"还有 N 条"，防止千行表格卡死 iframe） */
const MAX_RENDER_ROWS = 300;

let timer = null;
function scheduleRender(root) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    renderResults(root);
  }, 150);
}

function st() {
  return state('orders');
}

/** 克重来源说明（**没有导入按钮**：克重属 SKU，在宿主「货与成本」维护） */
function weightsPanel() {
  return `
  <div class="panel">
    <div class="panel-title">克重从哪来</div>
    <div class="small muted">
      每件货的克重取**产品库的 SKU 克重**（款 × 色 × 码，同一款不同颜色/尺码可以不同）——
      在宿主侧栏「货与成本」里维护，本页只读。没维护的 SKU 会在下方逐单标「缺重量」。
    </div>
  </div>`;
}

/** 逐单结果面板 */
function resultsPanel() {
  const s = st();
  if (!store.hasTable()) {
    return `
    <div class="panel">
      <div class="empty">
        <div class="empty-title">还没有运价表</div>
        <div class="muted small">先在「运费查询」页导入物流报价单 Excel，再来按订单试算。</div>
        <button class="btn btn-primary" data-act="importTable">导入运价表</button>
      </div>
    </div>`;
  }
  return `
  <div class="panel">
    <div class="panel-title">
      按订单试算
      <span class="muted small">逐单取「收货国家 + 款色码」，联产品库 SKU 克重后按运价表计价；数量暂按 1 件/单计</span>
    </div>
    <div class="bar">
      <button class="btn btn-primary" data-act="quoteOrders"${s.busy ? ' disabled' : ''}>试算最近 ${s.limit} 单</button>
      <label class="field grow">
        <span class="field-label">筛选</span>
        <input class="input grow" id="orderFilter" type="search" placeholder="订单号 / 国家 / 商品ID" value="${esc(s.filter)}" />
      </label>
    </div>
    <div id="orderResults">${resultsHtml()}</div>
  </div>`;
}

function summaryHtml() {
  const s = st();
  const sum = s.summary;
  if (!sum) return '';
  return `
  <div class="summary">
    <span class="chip">共 <b>${sum.total}</b> 单</span>
    <span class="chip is-ok">有价 <b>${sum.ok}</b></span>
    ${sum.noWeight ? `<span class="chip is-bad">缺重量 <b>${sum.noWeight}</b></span>` : ''}
    ${sum.noCountry ? `<span class="chip is-bad">无国家 <b>${sum.noCountry}</b></span>` : ''}
    ${sum.unknownCountry ? `<span class="chip is-bad">表没该国 <b>${sum.unknownCountry}</b></span>` : ''}
    ${sum.noPrice ? `<span class="chip is-bad">该克重无价 <b>${sum.noPrice}</b></span>` : ''}
    ${sum.refused ? `<span class="chip is-bad">未接汇率 <b>${sum.refused}</b></span>` : ''}
    ${s.busy ? '<span class="muted small">计算中…</span>' : ''}
  </div>`;
}

function filteredRows() {
  const s = st();
  const kw = (s.filter || '').trim().toLowerCase();
  let rows = s.rows || [];
  if (kw) {
    rows = rows.filter(
      (r) =>
        String(r.orderNo || '').toLowerCase().includes(kw) ||
        String(r.countryRaw || '').toLowerCase().includes(kw) ||
        String(r.nameCn || '').toLowerCase().includes(kw) ||
        String(r.itemId || '').toLowerCase().includes(kw),
    );
  }
  return rows;
}

function rowsHtml() {
  const s = st();
  const rows = filteredRows();
  // ⚠️ render() 先于 mount() 执行，首次进页时 s.rows 可能还没被 mount 初始化
  if (!rows.length) return `<div class="empty small">${(s.rows || []).length ? '没有匹配的订单' : '点上方按钮开始试算'}</div>`;
  const shown = rows.slice(0, MAX_RENDER_ROWS);
  const body = shown
    .map((r, i) => {
      const country = r.ok ? `${esc(r.nameCn)}` : `${esc(r.countryRaw || '—')}`;
      const feeCell = r.ok
        ? `<td class="num strong">${money(r.fee)}</td>`
        : `<td colspan="1" class="muted small">${esc(r.reason)}</td>`;
      return `<tr${r.ok ? '' : ' class="row-fail"'}>
        <td class="num">${i + 1}</td>
        <td class="mono small nowrap">${esc(r.orderNo || '—')}</td>
        <td class="small nowrap">${country}${r.ok && r.countryRaw && r.countryRaw !== r.nameCn ? `<span class="tag">${esc(r.countryRaw)}</span>` : ''}</td>
        <td class="mono small nowrap">${esc(r.itemId || '—')}</td>
        <td class="small muted nowrap">${r.weightG > 0 ? esc(gramsText(r.weightG)) : '—'}</td>
        <td class="small muted nowrap mono">${esc(r.ok ? r.code : '—')}</td>
        ${feeCell}
      </tr>`;
    })
    .join('');
  return `
  <table class="grid compact">
    <thead>
      <tr><th class="num">#</th><th>订单号</th><th>国家/地区</th><th>商品ID</th><th>重量</th><th>Code</th><th>运费(元) / 原因</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
  ${rows.length > MAX_RENDER_ROWS ? `<div class="hint muted small">只渲染前 ${MAX_RENDER_ROWS} 条，共 ${rows.length} 条匹配（可用筛选缩小范围）。</div>` : ''}`;
}

function resultsHtml() {
  return summaryHtml() + rowsHtml();
}

function renderResults(root) {
  renderRegion(root, '#orderResults', resultsHtml());
}

export default {
  id: 'orders',
  title: '按订单试算',
  order: 2,

  // 进页无需预取：克重在产品库（宿主「货与成本」维护），试算时由宿主按款色码现取

  render() {
    return `<div class="page">${weightsPanel()}${resultsPanel()}</div>`;
  },

  mount(root) {
    const s = st();
    s.busy = !!s.busy;
    s.rows = s.rows || [];
    s.limit = s.limit || 500;

    const filterEl = root.querySelector('#orderFilter');
    if (filterEl) {
      filterEl.addEventListener('input', () => {
        s.filter = filterEl.value;
        scheduleRender(root);
      });
    }

    onClick(root, async (act) => {
      if (act === 'importTable') {
        if (await store.importByDialog()) refresh();
        return;
      }
      if (act === 'quoteOrders') {
        if (!store.hasTable()) return;
        s.busy = true;
        renderResults(root);
        try {
          const r = await api.quoteOrders({ limit: s.limit });
          s.rows = r.rows || [];
          s.summary = r.summary || null;
        } finally {
          s.busy = false;
          refresh();
        }
        return;
      }
    });
  },
};
