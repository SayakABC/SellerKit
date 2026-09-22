// dist/views/library.js
// 「产品库」：款式（款编码 / 款色）维护 —— 改名、删除、Excel 批量导入（含指纹列）、导出。
// 指纹由岛内 lib.js 归一化生成（品类 + 排序特征），与主进程 resolveStyle 同一算法。

import { oi } from '../api.js';
import { openFile, notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num, confirm, guard } from '../util.js';

const S = () => state('library');

function rowsOf(r) {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.rows)) return r.rows;
  if (r && Array.isArray(r.styles)) return r.styles;
  return [];
}

/** 款式行字段兜底：不同版本键名不同（code/styleCode） */
function codeOf(r) {
  return r.code || r.styleCode || r.style_code || '';
}
function nameOf(r) {
  return r.name || r.styleName || r.displayName || '';
}
function countOf(r) {
  return Number(r.orderCount ?? r.count ?? r.orders ?? 0) || 0;
}

async function load(s) {
  s.rows = rowsOf(await oi('styleList'));
}

/** 按关键字猜测列名 */
function guess(headers, keys) {
  return headers.find((h) => keys.some((k) => String(h).toLowerCase().includes(k))) || '';
}

export default {
  id: 'library',
  title: '产品库',
  order: 50,

  async enter() {
    const s = S();
    await oi('ensure');
    if (!s.rows) await load(s);
  },

  render() {
    const s = S();
    const rows = s.rows || [];
    const opt = (cur) =>
      `<option value="">— 不使用 —</option>` +
      (s.headers || []).map((h) => `<option value="${esc(h)}"${h === cur ? ' selected' : ''}>${esc(h)}</option>`).join('');

    return `
      <div class="panel">
        <div class="panel-title">款式列表 <span class="chip">${num(rows.length)} 款</span></div>
        <div class="bar">
          <input class="input" id="lbSearch" placeholder="搜索款编码 / 名称" value="${esc(s.search || '')}" style="flex:1 1 240px" />
          <button class="btn" data-act="reload">刷新</button>
          <button class="btn" data-act="export">导出 Excel</button>
        </div>
        <div class="table-wrap" style="margin-top:10px">
          ${
            rows.length
              ? `<table class="table">
            <thead><tr><th>款编码</th><th>展示名</th><th>颜色</th><th>订单数</th><th style="width:180px">操作</th></tr></thead>
            <tbody>
              ${rows
                .filter((r) => {
                  const q = String(s.search || '').trim().toLowerCase();
                  if (!q) return true;
                  return `${codeOf(r)} ${nameOf(r)}`.toLowerCase().includes(q);
                })
                .map(
                  (r) => `<tr>
                    <td>${esc(codeOf(r))}</td>
                    <td><input class="input" data-name="${esc(r.id)}" value="${esc(nameOf(r))}" /></td>
                    <td>${esc(r.color || '')}</td>
                    <td>${num(countOf(r))}</td>
                    <td>
                      <button class="btn is-primary" data-act="rename" data-id="${esc(r.id)}" data-val="${esc(codeOf(r))}">改名</button>
                      <button class="btn is-danger" data-act="del" data-id="${esc(r.id)}">删除</button>
                    </td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : '<div class="empty">产品库为空</div>'
          }
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Excel 批量导入</div>
        <div class="bar">
          <button class="btn" data-act="pick">选择 Excel</button>
          <span class="muted small" style="flex:1 1 auto">${s.filePath ? esc(s.filePath) : '未选择文件'}</span>
          ${s.filePath ? '<button class="btn is-primary" data-act="parse">解析</button>' : ''}
        </div>
        ${
          (s.headers || []).length
            ? `<div class="form-grid" style="margin-top:10px">
                <div class="field"><label>款编码列</label><select class="input" id="lbCode">${opt(s.cols.code)}</select></div>
                <div class="field"><label>名称列</label><select class="input" id="lbName">${opt(s.cols.name)}</select></div>
                <div class="field"><label>颜色列</label><select class="input" id="lbColor">${opt(s.cols.color)}</select></div>
                <div class="field"><label>指纹列（品类+特征，可选）</label><select class="input" id="lbFp">${opt(s.cols.fingerprint)}</select></div>
              </div>
              <div class="bar" style="margin-top:10px">
                <button class="btn is-primary" data-act="import">导入款式</button>
                <span class="muted small">共 ${num((s.records || []).length)} 行</span>
              </div>`
            : ''
        }
      </div>`;
  },

  mount(root) {
    const s = S();
    const search = root.querySelector('#lbSearch');
    if (search) search.addEventListener('input', () => { s.search = search.value; refresh(); });

    onClick(root, async (act, el) => {
      try {
        if (act === 'reload') {
          await load(s);
          refresh();
        } else if (act === 'rename') {
          const id = Number(el.dataset.id);
          const input = root.querySelector(`[data-name="${id}"]`);
          await guard(async () => {
            await oi('styleRename', { code: el.dataset.val, name: (input && input.value) || '' });
            notify('已更新展示名', 'success');
            await load(s);
            refresh();
          }, el);
        } else if (act === 'del') {
          if (!(await confirm('删除该款式？订单记录会保留，仅解除归属。'))) return;
          await oi('styleDelete', { id: Number(el.dataset.id) });
          notify('已删除', 'success');
          await load(s);
          refresh();
        } else if (act === 'export') {
          const rows = s.rows || [];
          if (!rows.length) return notify('暂无数据', 'warn');
          const body = rows.map((r) => [codeOf(r), nameOf(r), r.color || '', countOf(r)]);
          await oi('exportWorkbook', {
            fileName: `产品库_${new Date().toISOString().slice(0, 10)}.xlsx`,
            sheets: [{ name: '产品库', rows: [['款编码', '展示名', '颜色', '订单数'], ...body] }],
          });
          notify('导出完成', 'success');
        } else if (act === 'pick') {
          const file = await openFile('excel');
          if (!file || !file.filePath) return;
          s.filePath = file.filePath;
          s.headers = [];
          refresh();
        } else if (act === 'parse') {
          const r = await oi('parseExcel', { filePath: s.filePath });
          s.headers = r.headers || [];
          s.records = r.records || [];
          s.cols = {
            code: guess(s.headers, ['款编码', '款号', 'code']),
            name: guess(s.headers, ['名称', '款式', 'name']),
            color: guess(s.headers, ['颜色', 'color']),
            fingerprint: guess(s.headers, ['指纹', 'fingerprint']),
          };
          refresh();
        } else if (act === 'import') {
          s.cols = {
            code: (root.querySelector('#lbCode') || {}).value || '',
            name: (root.querySelector('#lbName') || {}).value || '',
            color: (root.querySelector('#lbColor') || {}).value || '',
            fingerprint: (root.querySelector('#lbFp') || {}).value || '',
          };
          if (!s.cols.code) return notify('请选择「款编码列」', 'warn');
          const styles = (s.records || [])
            .map((f) => ({
              code: String(f[s.cols.code] || '').trim(),
              name: String(f[s.cols.name] || '').trim(),
              color: String(f[s.cols.color] || '').trim(),
              fingerprint: String(f[s.cols.fingerprint] || '').trim(),
              extraFingerprints: [],
            }))
            .filter((x) => x.code);
          if (!styles.length) return notify('未解析到有效款式行', 'warn');
          const r = await oi('styleImport', { styles });
          notify(`导入完成：新增 ${num(r && r.created)} · 更新 ${num(r && r.updated)}`, 'success');
          await load(s);
          refresh();
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
