// dist/views/rates.js
// 运价表页：运价来源 / 导入更新 / 换 sheet / 分节结构 / 逐国价卡明细 / 告警。
//
// 这是"数据可变更"需求的落点：Excel 换版后不必改代码，在这里重新导入即可。
// 归一化后的运价表存在本岛配置里（modules.shipping-rate），所以源文件移动/删除后依然能算。

import { notify } from '../bridge.js';
import { onClick, refresh, renderRegion, state } from '../app.js';
import {
  CATEGORY_LABELS,
  MODE_LABELS,
  currencyText,
  esc,
  gramsText,
  money,
  rangeText,
} from '../lib.js';
import * as store from '../store.js';

/** 保存/恢复滚动位置 —— 展开某国价卡时不该把用户弹回列表顶部 */
function withScroll(root, fn) {
  const box = root.querySelector('#rates-body');
  const top = box ? box.scrollTop : 0;
  fn();
  const after = root.querySelector('#rates-body');
  if (after) after.scrollTop = top;
}

/** sheet 名 → 体检结果（没有体检数据时为空表，界面退化为只显示名字） */
function candidateMap() {
  const m = new Map();
  (store.S.candidates || []).forEach((c) => {
    if (c && c.sheetName) m.set(c.sheetName, c);
  });
  return m;
}

/** 下拉项文案：体检过就带上国家数，"非报价单"的表也要显式标出来，免得用户逐个试 */
function sheetLabel(name, cands) {
  const c = cands.get(name);
  if (!c) return name;
  return c.countries > 0 ? `${name}（${c.countries} 国）` : `${name}（非报价单）`;
}

/**
 * 还没有运价表时的引导。
 *
 * 报价单是一本 21 张 sheet 的工作簿，自动选表未必总对（用户可能就想用另一条线路），
 * 所以这里除了"导入"还必须给出**手动指定**的通路；
 * 导入失败后 `candidates` 里带着每张表体检结果，用户能直接看到"哪些表可用、各有多少国家"，
 * 而不是被一句"结构无法识别"堵死。
 */
function emptyPanel() {
  const s = store.S;
  const cands = candidateMap();
  const usable = store.usableCandidates();
  const tried = s.lastFile
    ? `<div class="muted small">上次选择「${esc(s.lastFile.fileName)}」：已体检 ${s.sheetNames.length} 张工作表${
        usable.length
          ? `，其中 ${usable.length} 张可用`
          : '，没有任何一张是报价单结构'
      }。</div>`
    : '';
  const picks = usable.length
    ? `<div class="bar">${usable
        .map(
          (c) =>
            `<button class="btn" data-act="useSheet" data-sheet="${esc(c.sheetName)}">用「${esc(
              c.sheetName,
            )}」 · ${c.countries} 国</button>`,
        )
        .join('')}</div>`
    : '';
  const manual =
    s.lastFile && s.sheetNames.length > 1
      ? `<div class="bar">
           <label class="field">
             <span class="field-label">手动指定工作表</span>
             <select class="input" id="sheet">
               <option value="">选择…</option>
               ${s.sheetNames
                 .map((n) => `<option value="${esc(n)}">${esc(sheetLabel(n, cands))}</option>`)
                 .join('')}
             </select>
           </label>
         </div>`
      : '';
  return `
  <div class="panel">
    <div class="panel-title">运价来源</div>
    <div class="empty">
      <div class="empty-title">还没有运价表</div>
      <div class="muted small">
        选择物流报价单 Excel：会自动找出报价单所在的工作表（优先「无忧物流-标准」），
        挑不准时可在下方手动指定。解析与计价都在宿主完成，数据只在本地。
      </div>
      <button class="btn btn-primary" data-act="import">导入运价表</button>
      ${tried}
      ${picks}
      ${manual}
    </div>
  </div>`;
}

function sourcePanel() {
  const s = store.S;
  if (!store.hasTable()) return emptyPanel();
  const src = s.source || {};
  const st = s.table.stats;
  const cands = candidateMap();
  const curs = st.currencies || [];
  const nonCny = curs.filter((c) => c !== 'CNY');
  return `
  <div class="panel">
    <div class="panel-title">运价来源</div>
    <div class="kv">
      <div class="kv-k">源文件</div><div class="kv-v" title="${esc(src.filePath || '')}">${esc(src.fileName || '—')}</div>
      <div class="kv-k">工作表</div><div class="kv-v">${esc(src.sheetName || s.table.sheetName || '—')}</div>
      <div class="kv-k">生效日</div><div class="kv-v">${esc(src.effectiveFrom || '—')}</div>
      <div class="kv-k">覆盖范围</div>
      <div class="kv-v">
        <b>${st.countries}</b> 个国家/地区 ·
        <b>${st.cards}</b> 张价卡（按KG ${st.perKgCards} / 首重续重 ${st.firstStepCards}）·
        <b>${st.sections}</b> 个分节
      </div>
      <div class="kv-k">报价币种</div>
      <div class="kv-v">${esc(curs.map(currencyText).join(' / ') || '未标注')}</div>
    </div>
    ${
      nonCny.length
        ? `<div class="notice">
             <b>这张工作表有 ${nonCny.length} 种非人民币报价（${esc(nonCny.map(currencyText).join(' / '))}）。</b>
             本版没有汇率来源，这些线路在运费查询页会明确拒算而不是按人民币估算 ——
             按人民币直接算会差出数倍，且金额看起来完全正常。需要换算请切回人民币报价的线路。
           </div>`
        : ''
    }
    <div class="bar">
      <button class="btn btn-primary" data-act="import">导入 / 更新运价表</button>
      ${
        s.sheetNames.length > 1
          ? `<label class="field">
               <span class="field-label">切换工作表</span>
               <select class="input" id="sheet">
                 ${s.sheetNames
                   .map(
                     (n) =>
                       `<option value="${esc(n)}"${n === (src.sheetName || s.table.sheetName) ? ' selected' : ''}>${esc(
                         sheetLabel(n, cands),
                       )}</option>`,
                   )
                   .join('')}
               </select>
             </label>`
          : ''
      }
      <span class="grow"></span>
    </div>
    <div class="muted small hint">
      这份文件里有 ${s.sheetNames.length} 张工作表，切换到别的线路是<b>整表替换</b>而非合并；
      Excel 数值变更后重新导入即可覆盖（运价表存在宿主快照里、按生效日留档，
      源文件移动或删除都不影响已有报价，「算钱」页也读同一份）。
    </div>
  </div>`;
}

function warningsPanel() {
  if (!store.hasTable()) return '';
  const w = store.S.table.warnings || [];
  if (!w.length) return '';
  return `
  <div class="panel">
    <div class="panel-title">解析告警 <span class="chip is-bad">${w.length}</span></div>
    <ul class="warn-list">
      ${w.slice(0, 50).map((x) => `<li>${esc(x)}</li>`).join('')}
    </ul>
    ${w.length > 50 ? `<div class="muted small">另有 ${w.length - 50} 条未显示</div>` : ''}
  </div>`;
}

function sectionsPanel() {
  if (!store.hasTable()) return '';
  const rows = store.S.table.sections || [];
  return `
  <div class="panel">
    <div class="panel-title">
      分节结构
      <span class="muted small">报价单把 ${rows.length} 段列结构不同的价卡拼在同一张 sheet 上，已逐段归一化</span>
    </div>
    <table class="grid compact">
      <thead><tr><th class="num">分节</th><th class="num">表头行</th><th class="num">国家数</th><th>包含类别</th><th>币种</th><th class="num">最低计费</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (s) => `<tr>
              <td class="num">${s.sec}</td>
              <td class="num muted">${s.headerRow}</td>
              <td class="num">${s.countryCount}</td>
              <td class="small">${esc(
                (s.categories || []).map((c) => CATEGORY_LABELS[c] || c).join(' / ') || '—',
              )}</td>
              <td class="small nowrap">${esc(currencyText(s.currency))}${
                s.currency && s.currency !== 'CNY'
                  ? '<span class="tag">未换算</span>'
                  : ''
              }</td>
              <td class="num small muted">${s.minChargeG > 0 ? esc(gramsText(s.minChargeG)) : '—'}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

/** 单个国家的价卡明细（展开时插入到该行下方） */
function cardRows(c) {
  return c.cards
    .map((card) => {
      const detail =
        card.mode === 'firstStep'
          ? `首重 ${money(card.firstFee)} 元/包 + 续重 ${money(card.stepFee)} 元/${card.stepG || 500}g`
          : `配送 ${money(card.ratePerKg)} 元/KG + 挂号 ${money(card.registerFee)} 元/包`;
      // 币种与最低计费重量都只在"偏离本域默认口径"时才打标签：
      // 满屏的「人民币」只是噪声，而「美元」与「10g 起计」是会让金额对不上的两个因素。
      // ⚠️ 升级前导入的旧运价表没有这两个字段 → 判空跳过，不显示成"未标注"造成误报。
      const curTag =
        card.currency && card.currency !== 'CNY'
          ? `<span class="tag">${esc(currencyText(card.currency))} 未换算</span>`
          : '';
      const minTag = card.minChargeG > 0 ? `<span class="tag">${esc(gramsText(card.minChargeG))} 起计</span>` : '';
      return `<tr class="sub">
        <td></td>
        <td colspan="2" class="small nowrap">${esc(
          (card.categories || []).map((x) => CATEGORY_LABELS[x] || x).join(' / '),
        )}${card.variant ? `<span class="tag">${esc(card.variant)}</span>` : ''}${curTag}</td>
        <td class="small muted nowrap">${esc(rangeText(card.minG, card.maxG))}${minTag}</td>
        <td class="small muted nowrap">${esc(MODE_LABELS[card.mode] || card.mode)}</td>
        <td class="small muted">${esc(detail)}</td>
        <td class="small muted nowrap">第 ${card.sec} 节</td>
      </tr>`;
    })
    .join('');
}

function countryTable() {
  const st = state('rates');
  const expanded = st.expanded || (st.expanded = new Set());
  const q = (st.filter || '').trim().toLowerCase();
  let list = store.countriesSorted();
  if (q) {
    list = list.filter(
      (c) =>
        c.nameCn.toLowerCase().includes(q) ||
        c.nameEn.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q),
    );
  }
  if (!list.length) return `<div class="empty small">没有匹配的国家</div>`;
  return `
  <table class="grid">
    <thead>
      <tr><th></th><th>国家/地区</th><th>Code</th><th class="num">价卡数</th><th colspan="3">主要档位</th></tr>
    </thead>
    <tbody>
      ${list
        .map((c) => {
          const open = expanded.has(c.nameCn);
          const head = `<tr class="row-head${open ? ' is-open' : ''}" data-act="toggle" data-name="${esc(c.nameCn)}">
            <td class="caret">${open ? '▾' : '▸'}</td>
            <td class="nowrap">${esc(c.nameCn)}</td>
            <td class="mono muted nowrap">${esc(c.code || '—')}</td>
            <td class="num">${c.cards.length}</td>
            <td colspan="3" class="small muted">${esc(
              c.cards
                .slice(0, 4)
                .map((x) => rangeText(x.minG, x.maxG))
                .join('、'),
            )}${c.cards.length > 4 ? ` 等 ${c.cards.length} 档` : ''}</td>
          </tr>`;
          return open ? head + cardRows(c) : head;
        })
        .join('')}
    </tbody>
  </table>`;
}

function plainText() {
  return `<div class="empty small">还没有运价表</div>`;
}

export default {
  id: 'rates',
  title: '运价表',
  order: 2,

  render() {
    const st = state('rates');
    if (!st.expanded) st.expanded = new Set();
    return `
    <div class="page">
      ${sourcePanel()}
      ${warningsPanel()}
      ${sectionsPanel()}
      <div class="panel result-panel">
        <div class="panel-title">
          国家运价
          <input class="input grow" id="rfilter" type="search" placeholder="筛选国家 / 英文名 / Code" value="${esc(st.filter || '')}" />
        </div>
        <div id="rates-body" class="rates-body">
          ${store.hasTable() ? countryTable() : plainText()}
        </div>
      </div>
    </div>`;
  },

  mount(root) {
    const st = state('rates');

    const filterEl = root.querySelector('#rfilter');
    if (filterEl) {
      filterEl.addEventListener('input', () => {
        st.filter = filterEl.value;
        withScroll(root, () => renderRegion(root, '#rates-body', countryTable()));
      });
    }

    const sheetEl = root.querySelector('#sheet');
    if (sheetEl) {
      sheetEl.addEventListener('change', async () => {
        const name = sheetEl.value;
        if (!name) return;
        // 没有运价表时（导入失败的引导页），"手动指定"针对的是**刚打开的那个文件**；
        // 此时 S.source 可能还指向更早的另一份文件，必须显式把 lastFile 的路径传下去。
        const path = store.hasTable() ? '' : (store.S.lastFile && store.S.lastFile.filePath) || '';
        await store.switchSheet(name, path);
        // 成功与失败都要重绘：失败时候选/来源面板的状态也变了
        refresh();
      });
    }

    onClick(root, async (act, el) => {
      if (act === 'toggle') {
        const name = el.dataset.name || '';
        if (st.expanded.has(name)) st.expanded.delete(name);
        else st.expanded.add(name);
        withScroll(root, () => renderRegion(root, '#rates-body', countryTable()));
        return;
      }
      if (act === 'import') {
        // 传"当前来源的 sheet 名"当**提示**（不是点名）：换版后 sheet 改名也能自动落到可用表上
        if (await store.importByDialog(store.S.source && store.S.source.sheetName)) refresh();
        return;
      }
      if (act === 'useSheet') {
        // 导入失败后从候选里手动指定：明确针对 lastFile，不碰 S.source
        const filePath = (store.S.lastFile && store.S.lastFile.filePath) || '';
        await store.switchSheet(el.dataset.sheet || '', filePath);
        refresh();
        return;
      }
    });
  },
};
