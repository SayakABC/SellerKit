// dist/views/detail.js
// 「订单明细」：分页查询已归类订单，支持搜索 / 状态筛选 / 缩略图 / 发货状态切换 / 删除 / 导出。
// 缩略图由宿主按本地缓存生成（imageThumbBatch），岛内不直接访问文件系统。

import { oi } from '../api.js';
import { notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num, fmtTime, confirm, guard } from '../util.js';

const S = () => state('detail');

const PAGE_SIZE = 50;

async function load(s) {
  const r = await oi('list', {
    offset: (s.page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
    search: s.search || '',
    corrected: s.corrected === 'all' ? undefined : s.corrected === 'yes',
    status: s.status === 'all' ? undefined : s.status,
  });
  s.rows = (r && r.rows) || [];
  s.total = Number((r && r.total) || 0);
}

/** 分页条 HTML */
function pagerHtml(s) {
  const pages = Math.max(1, Math.ceil(s.total / PAGE_SIZE));
  return `
    <div class="bar">
      <button class="btn" data-act="prev" ${s.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="muted small">第 ${s.page} / ${pages} 页 · 共 ${num(s.total)} 条</span>
      <button class="btn" data-act="next" ${s.page >= pages ? 'disabled' : ''}>下一页</button>
      <span class="grow"></span>
      <span class="muted small">每页 ${PAGE_SIZE} 条</span>
    </div>`;
}

/** 异步回填缩略图（失败静默：缩略图缺失不影响主流程） */
async function fillThumbs(root, rows) {
  const paths = rows.map((r) => r.localPath).filter(Boolean);
  if (!paths.length) return;
  try {
    const map = await oi('imageThumbBatch', { items: paths });
    rows.forEach((r) => {
      if (!r.localPath) return;
      const url = map && map[r.localPath];
      const img = root.querySelector(`[data-thumb="${r.id}"]`);
      if (img && url) img.src = url;
    });
  } catch (e) {
    /* 缩略图失败不影响主流程 */
  }
}

export default {
  id: 'detail',
  title: '订单明细',
  order: 30,

  async enter() {
    const s = S();
    if (!s.page) s.page = 1;
    if (!s.search) s.search = '';
    if (!s.corrected) s.corrected = 'all';
    if (!s.status) s.status = 'all';
    await oi('ensure');
    await load(s);
  },

  render() {
    const s = S();
    const rows = s.rows || [];
    return `
      <div class="panel">
        <div class="panel-title">筛选</div>
        <div class="bar">
          <input class="input" id="dtSearch" placeholder="搜索订单号 / 店铺 / 品类 / 颜色" value="${esc(s.search)}" style="flex:1 1 240px" />
          <select class="input" id="dtCorrected" style="width:140px">
            <option value="all"${s.corrected === 'all' ? ' selected' : ''}>全部核对状态</option>
            <option value="no"${s.corrected === 'no' ? ' selected' : ''}>待核对</option>
            <option value="yes"${s.corrected === 'yes' ? ' selected' : ''}>已核对</option>
          </select>
          <select class="input" id="dtStatus" style="width:140px">
            <option value="all"${s.status === 'all' ? ' selected' : ''}>全部发货状态</option>
            <option value="pending"${s.status === 'pending' ? ' selected' : ''}>待发货</option>
            <option value="shipped"${s.status === 'shipped' ? ' selected' : ''}>已发货</option>
          </select>
          <button class="btn is-primary" data-act="search">查询</button>
          <button class="btn" data-act="reload">刷新</button>
          <button class="btn" data-act="export">导出 Excel</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">明细</div>
        <div class="table-wrap">
          ${
            rows.length
              ? `<table class="table">
            <thead>
              <tr>
                <th style="width:56px">图</th><th>订单号</th><th>店铺</th><th>品类</th><th>颜色</th>
                <th>尺码</th><th>Logo</th><th>款编码</th><th>下单时间</th><th>发货</th><th style="width:150px">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr>
                    <td><img data-thumb="${esc(r.id)}" class="thumb" alt="" src="" /></td>
                    <td>${esc(r.orderNo || '')}</td>
                    <td>${esc(r.shop || '')}</td>
                    <td>${esc(r.category || '')}</td>
                    <td>${esc(r.color || '')}</td>
                    <td>${esc(r.size || '')}</td>
                    <td>${esc(r.logo || '')}</td>
                    <td>${esc(r.styleCode || '')}</td>
                    <td class="small">${esc(fmtTime(r.orderTime))}</td>
                    <td>${r.status === 'shipped' ? '<span class="chip is-ok">已发货</span>' : '<span class="chip">待发货</span>'}</td>
                    <td>
                      <button class="btn" data-act="toggle-status" data-id="${esc(r.id)}" data-val="${r.status === 'shipped' ? 'pending' : 'shipped'}">${r.status === 'shipped' ? '改待发货' : '改已发货'}</button>
                      <button class="btn is-danger" data-act="del" data-id="${esc(r.id)}">删除</button>
                    </td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : '<div class="empty">暂无订单数据</div>'
          }
        </div>
        ${pagerHtml(s)}
      </div>`;
  },

  mount(root) {
    const s = S();
    fillThumbs(root, s.rows || []);

    onClick(root, async (act, el) => {
      try {
        if (act === 'search') {
          s.search = (root.querySelector('#dtSearch') || {}).value || '';
          s.corrected = (root.querySelector('#dtCorrected') || {}).value || 'all';
          s.status = (root.querySelector('#dtStatus') || {}).value || 'all';
          s.page = 1;
          await load(s);
          refresh();
        } else if (act === 'reload') {
          await load(s);
          refresh();
        } else if (act === 'prev') {
          s.page = Math.max(1, s.page - 1);
          await load(s);
          refresh();
        } else if (act === 'next') {
          s.page += 1;
          await load(s);
          refresh();
        } else if (act === 'toggle-status') {
          await guard(async () => {
            await oi('updateStatus', { id: Number(el.dataset.id), status: el.dataset.val });
            await load(s);
            refresh();
          }, el);
        } else if (act === 'del') {
          if (!(await confirm('确认删除该订单记录？'))) return;
          await oi('delete', { id: Number(el.dataset.id) });
          notify('已删除', 'success');
          await load(s);
          refresh();
        } else if (act === 'export') {
          const r = await oi('list', { offset: 0, limit: 5000, search: s.search || '' });
          const rows = (r && r.rows) || [];
          if (!rows.length) return notify('暂无数据可导出', 'warn');
          const head = ['订单号', '店铺', '品类', '颜色', '尺码', 'Logo', '款编码', '下单时间', '发货状态'];
          const body = rows.map((x) => [
            x.orderNo || '',
            x.shop || '',
            x.category || '',
            x.color || '',
            x.size || '',
            x.logo || '',
            x.styleCode || '',
            fmtTime(x.orderTime),
            x.status === 'shipped' ? '已发货' : '待发货',
          ]);
          await oi('exportWorkbook', {
            fileName: `订单明细_${new Date().toISOString().slice(0, 10)}.xlsx`,
            sheets: [{ name: '订单明细', rows: [head, ...body] }],
          });
          notify('导出完成', 'success');
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
