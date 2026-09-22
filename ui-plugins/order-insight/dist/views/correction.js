// dist/views/correction.js
// 「数据纠正」：列出待核对订单，支持逐行改品类 / 颜色 / Logo / 款编码并重新匹配款式，确认无误后置 corrected。
//
// 两条宿主 op 的配合顺序（与内建 store.saveCorrection 一致，不可颠倒）：
//   1. oi('update', { …, fingerprint, features, reclassify: true })
//      —— 宿主据 fingerprint+features 重算归属款/款色；**必须带 fingerprint 与 features**，
//         宿主的重归类分支条件是 `input.reclassify && input.fingerprint`，
//         只传 reclassify 而不传指纹是个静默空操作（旧版此处即漏传，已修）。
//   2. oi('styleAssign', { orderId, styleId, color, fingerprint })
//      —— 仅当用户在下拉里显式指定了目标款、且与当前归属不同才调用；
//         它把订单图片挂到目标款并把指纹记入该款，使后续自动识别命中同一款编码。

import { oi } from '../api.js';
import { notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num, fmtTime, confirm, guard } from '../util.js';

const S = () => state('correction');

const LIMIT = 100;

function rowsOf(r) {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.rows)) return r.rows;
  if (r && Array.isArray(r.styles)) return r.styles;
  return [];
}

function codeOf(r) {
  return r.code || r.styleCode || r.style_code || '';
}

function nameOf(r) {
  return r.name || r.styleName || r.displayName || '';
}

async function load(s) {
  const r = await oi('list', { offset: 0, limit: LIMIT, corrected: false, search: s.search || '' });
  s.rows = (r && r.rows) || [];
  s.total = Number((r && r.total) || 0);
}

/** 款式列表（款编码 select 的数据源） */
async function loadStyles(s) {
  s.styles = rowsOf(await oi('styleList'));
}

/** 款编码 → 款 id 的索引（纠正行按 order.styleCode 反查当前归属款） */
function styleIndex(s) {
  if (!s._styleIndex || s._styleIndexFor !== s.styles) {
    const m = new Map();
    for (const x of s.styles || []) {
      const code = String(codeOf(x));
      if (code && !m.has(code)) m.set(code, Number(x.id));
    }
    s._styleIndex = m;
    s._styleIndexFor = s.styles;
  }
  return s._styleIndex;
}

function styleIdOf(s, styleCode) {
  const code = String(styleCode || '');
  if (!code) return 0;
  return styleIndex(s).get(code) || 0;
}

/** 单行的款编码下拉 */
function styleSelectHtml(s, r) {
  const styles = s.styles || [];
  if (!styles.length) return '<span class="muted small">产品库为空</span>';
  const curId = styleIdOf(s, r.styleCode);
  const cur = r.styleCode ? `（当前 ${esc(r.styleCode)}）` : '（未归类）';
  return `<select class="input" data-style="${esc(r.id)}" title="手动指定该订单归属的款编码；保持「自动匹配」则只按指纹重新归类">
    <option value="0"${curId ? '' : ' selected'}>自动匹配${cur}</option>
    ${styles
      .map((x) => {
        const id = Number(x.id);
        const code = codeOf(x);
        const name = nameOf(x);
        return `<option value="${esc(id)}"${id === curId ? ' selected' : ''}>${esc(code)}${name ? ' · ' + esc(name) : ''}</option>`;
      })
      .join('')}
  </select>`;
}

export default {
  id: 'correction',
  title: '数据纠正',
  order: 40,

  async enter() {
    const s = S();
    if (s.search === undefined) s.search = '';
    await oi('ensure');
    await Promise.all([load(s), loadStyles(s)]);
  },

  render() {
    const s = S();
    const rows = s.rows || [];
    return `
      <div class="panel">
        <div class="panel-title">待纠正订单 <span class="chip is-warn">${num(s.total)}</span></div>
        <div class="bar">
          <input class="input" id="crSearch" placeholder="搜索订单号 / 品类 / 颜色" value="${esc(s.search)}" style="flex:1 1 240px" />
          <button class="btn is-primary" data-act="search">查询</button>
          <button class="btn" data-act="reload">刷新</button>
          <span class="grow"></span>
          <button class="btn is-primary" data-act="all-ok">全部确认无误</button>
        </div>
        <div class="small muted" style="margin-top:6px">
          改字段后点「保存」：宿主按新字段与指纹重新匹配款式（reclassify）；
          「款编码」下拉手动指定时会额外把该订单图片归并到指定款（styleAssign），后续同款自动识别即命中该款编码。
        </div>
      </div>
      <div class="panel">
        <div class="table-wrap">
          ${
            rows.length
              ? `<table class="table">
            <thead>
              <tr><th>订单号</th><th>品类</th><th>颜色</th><th>Logo</th><th>尺码</th><th style="min-width:190px">款编码</th><th>下单时间</th><th style="width:170px">操作</th></tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr>
                    <td>${esc(r.orderNo || '')}</td>
                    <td><input class="input" data-cat="${esc(r.id)}" value="${esc(r.category || '')}" /></td>
                    <td><input class="input" data-color="${esc(r.id)}" value="${esc(r.color || '')}" /></td>
                    <td><input class="input" data-logo="${esc(r.id)}" value="${esc(r.logo || '')}" /></td>
                    <td>${esc(r.size || '')}</td>
                    <td>${styleSelectHtml(s, r)}</td>
                    <td class="small">${esc(fmtTime(r.orderTime))}</td>
                    <td>
                      <button class="btn is-primary" data-act="save" data-id="${esc(r.id)}">保存</button>
                      <button class="btn" data-act="ok" data-id="${esc(r.id)}">确认无误</button>
                    </td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : '<div class="empty">没有待纠正的订单</div>'
          }
        </div>
      </div>`;
  },

  mount(root) {
    const s = S();
    onClick(root, async (act, el) => {
      try {
        if (act === 'search') {
          s.search = (root.querySelector('#crSearch') || {}).value || '';
          await load(s);
          refresh();
        } else if (act === 'reload') {
          await Promise.all([load(s), loadStyles(s)]);
          refresh();
        } else if (act === 'save') {
          const id = Number(el.dataset.id);
          const row = (s.rows || []).find((x) => Number(x.id) === id);
          if (!row) return notify('该行已不在当前列表中，请刷新', 'warn');
          const category = (root.querySelector(`[data-cat="${id}"]`) || {}).value || '';
          const color = (root.querySelector(`[data-color="${id}"]`) || {}).value || '';
          const logo = (root.querySelector(`[data-logo="${id}"]`) || {}).value || '';
          const sel = root.querySelector(`[data-style="${id}"]`);
          const targetStyleId = Number((sel && sel.value) || 0);
          const curStyleId = styleIdOf(s, row.styleCode);
          const fingerprint = row.fingerprint || '';

          await guard(async () => {
            // 1) 按新字段 + 指纹重新归类（reclassify 依赖 fingerprint，务必带上）
            const res = await oi('update', {
              id,
              category,
              color,
              logo,
              fingerprint,
              features: Array.isArray(row.features) ? row.features : [],
              reclassify: true,
            });
            let styleCode = (res && res.styleCode) || '';

            // 2) 用户显式指定了另一个款 → 手动归并（图片挂到目标款 + 指纹记入该款）
            if (targetStyleId > 0 && targetStyleId !== curStyleId) {
              const assigned = await oi('styleAssign', {
                orderId: id,
                styleId: targetStyleId,
                color,
                fingerprint,
              });
              if (assigned && assigned.styleCode) styleCode = assigned.styleCode;
            }

            notify(styleCode ? `已保存，当前归属 ${styleCode}` : '已保存', 'success');
            await load(s);
            refresh();
          }, el);
        } else if (act === 'ok') {
          await guard(async () => {
            await oi('markCorrected', { ids: [Number(el.dataset.id)] });
            await load(s);
            refresh();
          }, el);
        } else if (act === 'all-ok') {
          if (!(await confirm(`确认将当前全部待纠正订单（${num(s.total)} 条）标记为已核对？`))) return;
          await oi('markCorrected', { all: true });
          notify('已全部标记为已核对', 'success');
          await load(s);
          refresh();
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
