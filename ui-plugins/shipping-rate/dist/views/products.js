// dist/views/products.js
// 按产品试算页：产品库（款编码 + SKU 克重）× 选定目的国 → 逐 SKU 实际运费。
//
// 数据流（本页**零算术**，与 quote / orders 同策略）：
//   「试算」→ 宿主自取产品库（pl_products + pl_variants 克重，分页拉全）→
//             目的国按点名解析一次 → 逐 SKU 计价。
// 重量锚点是产品库 SKU 子表（编辑产品时维护的克重），与「按订单试算」用的
// 速卖通商品信息重量表（pl_item_weights）是**两条独立数据源**，不混用：
// 订单页回答"这些已成交的订单运费多少"，本页回答"我的产品发到某国每件运费多少"。
// 拒算必须逐行给原因（未维护克重 / 无价 / 未接汇率），不静默丢行。

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
  return state('products');
}

/** 试算面板：目的国下拉 + 产品筛选 + 试算按钮 */
function panel() {
  const s = st();
  if (!store.hasTable()) {
    return `
    <div class="panel">
      <div class="empty">
        <div class="empty-title">还没有运价表</div>
        <div class="muted small">先在「运费查询」页导入物流报价单 Excel，再来按产品试算。</div>
        <button class="btn btn-primary" data-act="importTable">导入运价表</button>
      </div>
    </div>`;
  }
  const countries = store.countriesSorted();
  const opts = countries
    .map(
      (c) =>
        `<option value="${esc(c.nameCn)}"${s.country === c.nameCn ? ' selected' : ''}>${esc(
          c.nameCn,
        )}（${esc(c.code)}）</option>`,
    )
    .join('');
  return `
  <div class="panel">
    <div class="panel-title">
      按产品试算
      <span class="muted small">重量取产品库 SKU 克重（编辑产品时维护）；每个 SKU 一行，数量按 1 件/件计</span>
    </div>
    <div class="bar">
      <label class="field">
        <span class="field-label">目的国/地区</span>
        <select class="input" id="prodCountry">${opts || '<option value="">（运价表没有国家）</option>'}</select>
      </label>
      <label class="field grow">
        <span class="field-label">筛选</span>
        <input class="input grow" id="prodFilter" type="search" placeholder="款编码 / 名称 / SKU" value="${esc(s.filter)}" />
      </label>
      <button class="btn btn-primary" data-act="quoteProducts"${s.busy ? ' disabled' : ''}>试算全部产品</button>
    </div>
    <div class="hint muted small">未维护克重的 SKU 会单独成行提示（去「产品库」编辑补克重）；计算口径与「运费查询」页共用（普货/非普/大包 · 取整方式）。</div>
    <div id="prodResults">${resultsHtml()}</div>
  </div>`;
}

function summaryHtml() {
  const s = st();
  const sum = s.summary;
  if (!sum) return '';
  return `
  <div class="summary">
    <span class="chip">共 <b>${sum.total}</b> 个 SKU</span>
    <span class="chip is-ok">有价 <b>${sum.ok}</b></span>
    ${sum.noWeight ? `<span class="chip is-bad">缺克重 <b>${sum.noWeight}</b></span>` : ''}
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
        String(r.code || '').toLowerCase().includes(kw) ||
        String(r.name || '').toLowerCase().includes(kw) ||
        String(r.skuLabel || '').toLowerCase().includes(kw),
    );
  }
  return rows;
}

function rowsHtml() {
  const s = st();
  const rows = filteredRows();
  // ⚠️ render() 先于 mount() 执行，首次进页时 s.rows 可能还没被 mount 初始化
  if (!rows.length) return `<div class="empty small">${(s.rows || []).length ? '没有匹配的产品' : '选好目的国后点「试算全部产品」'}</div>`;
  const shown = rows.slice(0, MAX_RENDER_ROWS);
  const body = shown
    .map((r, i) => {
      const feeCell = r.ok
        ? `<td class="num strong">${money(r.fee)}</td>`
        : `<td colspan="1" class="muted small">${esc(r.reason)}</td>`;
      return `<tr${r.ok ? '' : ' class="row-fail"'}>
        <td class="num">${i + 1}</td>
        <td class="mono small nowrap">${esc(r.code || '—')}</td>
        <td class="small">${esc(r.name || '—')}</td>
        <td class="small muted nowrap">${esc(r.skuLabel || '—')}</td>
        <td class="small muted nowrap">${r.weightG > 0 ? esc(gramsText(r.weightG)) : '—'}</td>
        ${feeCell}
      </tr>`;
    })
    .join('');
  return `
  <table class="grid compact">
    <thead>
      <tr><th class="num">#</th><th>款编码</th><th>名称</th><th>SKU</th><th>克重</th><th>运费(元) / 原因</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
  ${rows.length > MAX_RENDER_ROWS ? `<div class="hint muted small">只渲染前 ${MAX_RENDER_ROWS} 条，共 ${rows.length} 条匹配（可用筛选缩小范围）。</div>` : ''}`;
}

function resultsHtml() {
  return summaryHtml() + rowsHtml();
}

function renderResults(root) {
  renderRegion(root, '#prodResults', resultsHtml());
}

export default {
  id: 'products',
  title: '按产品试算',
  order: 3,

  render() {
    return `<div class="page">${panel()}</div>`;
  },

  mount(root) {
    const s = st();
    s.busy = !!s.busy;
    s.rows = s.rows || [];

    const countryEl = root.querySelector('#prodCountry');
    if (countryEl) {
      // 默认选中上次用过的国（无记录则选第一项，不静默提交）
      if (!s.country && countryEl.options.length) s.country = countryEl.options[0].value;
      countryEl.addEventListener('change', () => {
        s.country = countryEl.value;
      });
    }

    const filterEl = root.querySelector('#prodFilter');
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
      if (act === 'quoteProducts') {
        if (!store.hasTable()) return;
        if (!s.country) {
          notify('请先选择目的国家/地区', 'warn');
          return;
        }
        s.busy = true;
        renderResults(root);
        try {
          // 计价口径与「运费查询」页共用同一份配置（普货/非普/大包 · 取整方式）；运价表由宿主自取
          const r = await api.quoteProducts(s.country, {
            rounding: store.S.rounding,
          });
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
