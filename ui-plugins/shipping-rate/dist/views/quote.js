// dist/views/quote.js
// 运费查询页：输入实际克重 → 逐国列出实际运费（按金额升序）。
//
// 重绘策略（本页有输入框，这套策略是硬要求）：
//   · 克重 / 过滤词是 input 事件 → 只 renderRegion('#results') 局部重绘，保住光标与输入法组合态；
//   · 类别 / 变体 / 取整是按钮或 select → 允许整体 refresh()。
//   若一把梭全走整体 refresh()，症状是"克重框里打字打不进去"，且不报任何错。

import { copy, notify } from '../bridge.js';
import { onClick, refresh, renderRegion, state } from '../app.js';
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  MODE_LABELS,
  ROUNDING_LABELS,
  allCopyText,
  breakdownText,
  currencyText,
  esc,
  gramsText,
  money,
  rangeText,
  rowCopyText,
} from '../lib.js';
import * as store from '../store.js';

/** 按克重重新问宿主要一遍全表报价，然后只重绘结果区 */
let timer = null;
function scheduleRequote(root) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void requote(root);
  }, 220);
}

async function requote(root) {
  const st = state('quote');
  st.busy = true;
  renderResults(root);
  await store.refreshQuote();
  st.busy = false;
  renderResults(root);
}

/** 运价表里出现过的全部变体（当前只有乌克兰的非普货：其他仓 / 香港仓） */
function allVariants() {
  const set = new Set();
  for (const c of store.S.table ? store.S.table.countries : []) {
    for (const card of c.cards) if (card.variant) set.add(card.variant);
  }
  return [...set].sort();
}

function toolbar() {
  const s = store.S;
  const variants = allVariants();
  const segs = CATEGORY_OPTIONS.map(
    (o) =>
      `<button class="seg-btn${s.category === o.value ? ' is-active' : ''}" data-act="cat" data-cat="${esc(o.value)}">${esc(o.label)}</button>`,
  ).join('');
  return `
  <div class="panel toolbar">
    <label class="field">
      <span class="field-label">实际克重</span>
      <span class="field-inline">
        <input class="input w-92" id="weight" type="number" min="1" step="1" value="${esc(s.weight || '')}" />
        <span class="muted small">g</span>
      </span>
    </label>
    <div class="field">
      <span class="field-label">计费类别</span>
      <div class="seg">${segs}</div>
    </div>
    ${
      variants.length
        ? `<label class="field">
             <span class="field-label">仓库变体</span>
             <select class="input" id="variant">
               <option value="">不限</option>
               ${variants
                 .map(
                   (v) =>
                     `<option value="${esc(v)}"${s.variant === v ? ' selected' : ''}>${esc(v)}</option>`,
                 )
                 .join('')}
             </select>
           </label>`
        : ''
    }
    <label class="field">
      <span class="field-label">取整</span>
      <select class="input" id="rounding">
        ${Object.keys(ROUNDING_LABELS)
          .map(
            (k) =>
              `<option value="${esc(k)}"${s.rounding === k ? ' selected' : ''}>${esc(ROUNDING_LABELS[k])}</option>`,
          )
          .join('')}
      </select>
    </label>
    <label class="field grow">
      <span class="field-label">筛选</span>
      <input class="input grow" id="filter" type="search" placeholder="国家 / 英文名 / Code" value="${esc(s.filter)}" />
    </label>
    <button class="btn" data-act="copyAll"${store.S.results.some((r) => r.ok) ? '' : ' disabled'}>复制全部</button>
  </div>`;
}

/** 无运价表时的空状态 */
function emptyState() {
  return `
  <div class="empty">
    <div class="empty-title">还没有运价表</div>
    <div class="muted small">
      导入物流报价单 Excel：自动识别报价单所在的工作表（优先「无忧物流-标准」），
      之后输入实际克重即可算出到每个国家的运费。
    </div>
    <button class="btn btn-primary" data-act="import">导入运价表</button>
  </div>`;
}

function summaryHtml() {
  const s = store.S;
  const stats = store.resultStats();
  const shown = store.filteredResults().length;
  const stale = s.resultWeight !== s.weight;
  return `
  <div class="summary">
    <span class="chip">共 <b>${stats.total}</b> 国</span>
    <span class="chip is-ok">有价 <b>${stats.ok}</b></span>
    ${stats.noPrice ? `<span class="chip is-bad">该克重无价 <b>${stats.noPrice}</b></span>` : ''}
    ${stats.refused ? `<span class="chip is-bad">未接汇率 <b>${stats.refused}</b></span>` : ''}
    ${s.filter.trim() ? `<span class="chip">筛出 <b>${shown}</b></span>` : ''}
    <span class="muted small">
      ${esc(gramsText(s.weight))} · ${esc(
        (CATEGORY_OPTIONS.find((o) => o.value === s.category) || {}).label || s.category,
      )} · ${esc(ROUNDING_LABELS[s.rounding] || s.rounding)}
      ${stale ? ' · 结果对应上一次克重' : ''}
      ${state('quote').busy ? ' · 计算中…' : ''}
    </span>
  </div>`;
}

/**
 * 全表都算不出价、且原因都是"未接汇率"时的提示。
 *
 * 没有它，用户切到按美元报价的线路（超级经济 / 无忧物流-特惠）会看到「有价 0」，
 * 第一反应是"克重记错了"或"这表坏了" —— 实际是那条线路的报价币种不是人民币。
 */
function currencyNotice() {
  const stats = store.resultStats();
  if (stats.ok > 0 || !stats.refused || stats.noPrice) return '';
  const cur = store.S.table && store.S.table.stats ? store.S.table.stats.currencies : [];
  return `
  <div class="notice">
    <b>当前工作表的报价币种是 ${esc(cur.map(currencyText).join(' / ') || '非人民币')}</b>，
    本版尚未接入汇率，因此不给出金额（按人民币直接算会差出数倍，且看不出错）。
    计费口径、档位、最低计费重量都已在下方逐国列出，可切回人民币线路查看实际运费。
  </div>`;
}

function rowsHtml() {
  const rows = store.filteredResults();
  if (!rows.length) {
    return `<div class="empty small">${store.hasTable() ? '没有匹配的国家' : ''}</div>`;
  }
  const body = rows
    .map((r, i) => {
      if (!r.ok) {
        // 拒算行（未接汇率）没有 candidates —— 那种情况不该说"该国可用档位"，
        // 因为档位本来就有，只是币种没换算
        const ranges = (r.candidates || []).map((c) => rangeText(c.minG, c.maxG)).join('、');
        const cur = r.card ? `<span class="tag">${esc(currencyText(r.card.currency))}</span>` : '';
        return `<tr class="row-fail">
          <td class="num">${i + 1}</td>
          <td class="nowrap">${esc(r.nameCn)}${cur}</td>
          <td class="mono muted nowrap">${esc(r.code || '—')}</td>
          <td colspan="5" class="muted small">${esc(r.reason)}${ranges ? ` · 该国可用档位：${esc(ranges)}` : ''}</td>
          <td></td>
        </tr>`;
      }
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="nowrap">${esc(r.nameCn)}${r.variant ? `<span class="tag">${esc(r.variant)}</span>` : ''}</td>
        <td class="mono muted nowrap">${esc(r.code || '—')}</td>
        <td class="nowrap">${esc(CATEGORY_LABELS[r.category] || r.category || '—')}</td>
        <td class="small muted nowrap">${esc(rangeText(r.card.minG, r.card.maxG))}${
          r.card.minChargeG > 0 ? `<span class="tag">${esc(gramsText(r.card.minChargeG))} 起计</span>` : ''
        }</td>
        <td class="small muted">${esc(MODE_LABELS[r.card.mode] || r.card.mode)}</td>
        <td class="small muted">${esc(breakdownText(r))}</td>
        <td class="num strong">${money(r.fee)}</td>
        <td class="act"><button class="icon-btn" title="复制本行" data-act="copyRow" data-i="${i}">复制</button></td>
      </tr>`;
    })
    .join('');
  return `
  <table class="grid">
    <thead>
      <tr>
        <th class="num">#</th><th>国家/地区</th><th>Code</th><th>类别</th>
        <th>档位</th><th>模式</th><th>费用构成</th><th class="num">运费(元)</th><th></th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function resultsHtml() {
  if (!store.hasTable()) return emptyState();
  if (!(store.S.weight > 0)) {
    return `<div class="empty small">请输入大于 0 的克重</div>`;
  }
  return currencyNotice() + summaryHtml() + rowsHtml();
}

/** 只重绘结果区（保持工具栏里的输入框焦点） */
function renderResults(root) {
  renderRegion(root, '#results', resultsHtml());
}

/** 点击 `.seg-btn` 用的是 data-act="cat"，故代理选择器需同时覆盖 data-act（默认已覆盖） */
export default {
  id: 'quote',
  title: '运费查询',
  order: 1,

  async enter() {
    // 仅当结果与当前克重不一致时才算一次（init() 通常已经算过了）
    if (store.hasTable() && store.S.resultWeight !== store.S.weight) {
      await store.refreshQuote();
    }
  },

  render() {
    return `
      <div class="page">
        ${toolbar()}
        <div class="panel result-panel">
          <div id="results" class="results">${resultsHtml()}</div>
        </div>
      </div>`;
  },

  mount(root) {
    const st = state('quote');
    st.busy = false;

    // —— 输入类：局部重绘，保焦点 ——
    const weightEl = root.querySelector('#weight');
    if (weightEl) {
      weightEl.addEventListener('input', () => {
        store.setWeight(weightEl.value);
        scheduleRequote(root);
      });
    }
    const filterEl = root.querySelector('#filter');
    if (filterEl) {
      filterEl.addEventListener('input', () => {
        store.setFilter(filterEl.value);
        renderResults(root); // 纯前端过滤，不需要 IPC，也不必防抖
      });
    }

    // —— 下拉类：值变化后需要重算，允许整体重绘（注意 refresh() 后 root 已失效）——
    const onSelect = (sel, apply) => {
      const el = root.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', async () => {
        apply(el.value);
        await store.refreshQuote();
        refresh();
      });
    };
    onSelect('#variant', store.setVariant);
    onSelect('#rounding', store.setRounding);

    // —— 点击代理 ——
    // ⚠️ 凡是走 refresh() 的分支都必须**立刻 return**：refresh() 会换掉挂载点，
    //    继续用 root 只是在往一个已脱离文档的节点上写东西（静默无效）。
    onClick(root, async (act, el) => {
      if (act === 'import') {
        if (await store.importByDialog()) refresh();
        return;
      }
      if (act === 'cat') {
        store.setCategory(el.dataset.cat || 'auto');
        await store.refreshQuote();
        refresh();
        return;
      }
      if (act === 'copyAll') {
        const rows = store.filteredResults();
        await copy(allCopyText(rows, store.S.weight));
        notify(`已复制 ${rows.filter((r) => r.ok).length} 行报价`, 'success');
        return;
      }
      if (act === 'copyRow') {
        // 索引相对于**当前渲染的这一份**列表（filteredResults 是确定性的，重算一致）
        const row = store.filteredResults()[Number(el.dataset.i)];
        if (!row) return;
        await copy(rowCopyText(row, store.S.weight));
        notify('已复制该行', 'success');
      }
    });
  },
};
