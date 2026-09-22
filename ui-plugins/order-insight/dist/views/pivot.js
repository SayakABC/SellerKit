// dist/views/pivot.js
// 「透视统计」：按维度聚合已入库订单（品类 / 颜色 / 尺码 / 店铺 / Logo），支持款色矩阵与导出。
// 聚合在宿主 SQL 侧完成（groupStats），岛内只做展示与矩阵转置。

import { oi, loadConfig, saveConfig } from '../api.js';
import { notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num } from '../util.js';

const S = () => state('pivot');

const DIMENSIONS = [
  { id: 'category', label: '品类' },
  { id: 'color', label: '颜色' },
  { id: 'size', label: '尺码' },
  { id: 'shop', label: '店铺' },
  { id: 'logo', label: 'Logo' },
];

function rowsOf(r) {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.rows)) return r.rows;
  return [];
}

/** 拉取聚合结果 */
async function load(s) {
  s.rows = rowsOf(await oi('groupStats', { dimensions: s.dims }));
  s.total = (s.rows || []).reduce((a, b) => a + (Number(b.count) || 0), 0);
}

/** 矩阵视图：第一维度为行、第二维度为列，单元格为计数 */
function matrixHtml(s) {
  const [rk, ck] = s.dims;
  const rows = s.rows || [];
  const rKeys = [...new Set(rows.map((r) => String(r[rk] ?? '未识别')))];
  const cKeys = [...new Set(rows.map((r) => String(r[ck] ?? '未识别')))];
  const map = new Map();
  rows.forEach((r) => {
    const k = `${String(r[rk] ?? '未识别')}||${String(r[ck] ?? '未识别')}`;
    map.set(k, (map.get(k) || 0) + (Number(r.count) || 0));
  });
  const head = `<tr><th>${esc(DIMENSIONS.find((d) => d.id === rk).label)} \\ ${esc(
    DIMENSIONS.find((d) => d.id === ck).label,
  )}</th>${cKeys.map((c) => `<th>${esc(c)}</th>`).join('')}<th>合计</th></tr>`;
  const body = rKeys
    .map((rkName) => {
      const cells = cKeys.map((c) => `<td>${num(map.get(`${rkName}||${c}`) || 0)}</td>`).join('');
      const sum = cKeys.reduce((a, c) => a + (map.get(`${rkName}||${c}`) || 0), 0);
      return `<tr><td>${esc(rkName)}</td>${cells}<td><b>${num(sum)}</b></td></tr>`;
    })
    .join('');
  return `<table class="table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** 明细表视图：任意维度组合，通用列渲染 */
function tableHtml(s) {
  const rows = s.rows || [];
  const keys = s.dims.slice();
  const head = `<tr>${keys.map((k) => `<th>${esc(DIMENSIONS.find((d) => d.id === k).label)}</th>`).join('')}<th>数量</th><th>占比</th></tr>`;
  const body = rows
    .map((r) => {
      const c = Number(r.count) || 0;
      const pct = s.total ? ((c / s.total) * 100).toFixed(1) : '0.0';
      return `<tr>${keys.map((k) => `<td>${esc(r[k] ?? '未识别')}</td>`).join('')}<td>${num(c)}</td><td>${pct}%</td></tr>`;
    })
    .join('');
  return `<table class="table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export default {
  id: 'pivot',
  title: '透视统计',
  order: 20,

  async enter() {
    const s = S();
    if (!s.dims) {
      // 维度优先继承已保存配置：内建版存 groupDimensions（值即 category/color/... 与岛 id 同构），
      // 过滤掉岛不支持的维度；没有可用配置时回落到默认两维矩阵。
      const cfg = await loadConfig();
      const saved = Array.isArray(cfg.groupDimensions)
        ? cfg.groupDimensions.filter((d) => DIMENSIONS.some((x) => x.id === d))
        : [];
      s.dims = saved.length ? saved.slice(0, 3) : ['category', 'color'];
    }
    await oi('ensure');
    await load(s);
  },

  render() {
    const s = S();
    const rows = s.rows || [];
    return `
      <div class="panel">
        <div class="panel-title">统计维度 <span class="chip">合计 ${num(s.total)}</span></div>
        <div class="bar">
          ${DIMENSIONS.map(
            (d) => `<label class="chip${s.dims.includes(d.id) ? ' is-ok' : ''}" style="cursor:pointer">
              <input type="checkbox" data-dim="${d.id}" ${s.dims.includes(d.id) ? 'checked' : ''} /> ${esc(d.label)}
            </label>`,
          ).join('')}
          <span class="grow"></span>
          <button class="btn" data-act="reload">刷新</button>
          <button class="btn" data-act="export">导出 Excel</button>
        </div>
        <div class="small muted" style="margin-top:6px">勾选 2 个维度时以矩阵呈现（首维度为行），1 个或 3 个以上以列表呈现。</div>
      </div>
      <div class="panel">
        <div class="panel-title">聚合结果</div>
        <div class="table-wrap">
          ${
            rows.length
              ? s.dims.length === 2
                ? matrixHtml(s)
                : tableHtml(s)
              : '<div class="empty">暂无数据，请先在「导入与识别」完成识别</div>'
          }
        </div>
      </div>`;
  },

  mount(root) {
    const s = S();
    root.querySelectorAll('[data-dim]').forEach((el) => {
      el.addEventListener('change', async () => {
        const id = el.dataset.dim;
        const next = el.checked ? s.dims.concat([id]) : s.dims.filter((d) => d !== id);
        if (!next.length || next.length > 3) {
          el.checked = !el.checked;
          return notify('维度数量需为 1 ~ 3', 'warn');
        }
        s.dims = next;
        await saveConfig({ groupDimensions: next }); // 与内建 groupDimensions 同键名，双向互通
        await load(s);
        refresh();
      });
    });

    onClick(root, async (act) => {
      try {
        if (act === 'reload') {
          await load(s);
          refresh();
        } else if (act === 'export') {
          const rows = s.rows || [];
          if (!rows.length) return notify('暂无数据可导出', 'warn');
          const head = s.dims.map((k) => DIMENSIONS.find((d) => d.id === k).label).concat(['数量']);
          const body = rows.map((r) => s.dims.map((k) => String(r[k] ?? '未识别')).concat([Number(r.count) || 0]));
          const r = await oi('exportWorkbook', {
            fileName: `订单归类统计_${new Date().toISOString().slice(0, 10)}.xlsx`,
            sheets: [{ name: '统计', rows: [head, ...body] }],
          });
          notify(`已导出：${(r && (r.path || r.filePath)) || '完成'}`, 'success');
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
