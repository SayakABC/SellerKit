// dist/views/stockin.js
// 「拿货对账」：供应商 / 拿货单 / 付款 / 对账 / 待拿货缺口。
// 全部走宿主 purchase 域语义化 op（岛内不接触 SQLite）。
//
// 覆盖的宿主 op（与 manifest.capabilities.db.actions 一致）：
//   ensure · supplierList/Create/Update/Delete · orderList/Get/Create/Update/Submit/Delete
//   paymentList/Add/Delete · reconciliation · outstanding · ignoreAdd/Remove/List
//   priceHistory · shopAllocation/Detail · exportExcel

import { purchase } from '../api.js';
import { notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num, money, fmtTime, confirm, guard } from '../util.js';

const S = () => state('stockin');

const TABS = [
  { id: 'supplier', label: '供应商' },
  { id: 'order', label: '拿货单' },
  { id: 'payment', label: '付款记录' },
  { id: 'recon', label: '对账' },
  { id: 'gap', label: '待拿货缺口' },
];

/**
 * 本视图的「点击目标」选择器。
 * app.onClick 默认只代理 [data-act]；子页签 / 对账子视图 / 时间窗用的是各自的 data-* 属性，
 * 必须显式传入，否则那三类按钮点了没反应（closest('[data-act]') 匹配不到就直接 return，不报错）。
 */
const CLICK_TARGETS = '[data-act], [data-sub], [data-recon-view], [data-range]';

function rowsOf(r) {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.rows)) return r.rows;
  if (r && Array.isArray(r.items)) return r.items;
  return [];
}

/** 元 → 分（与宿主 yuanToCents 同口径：非有限数按 0，负数归零） */
function yuanToCents(v) {
  const n = Number(v);
  const yuan = Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.round(yuan * 100));
}

/** 分 → 元（数字，供 input value 使用） */
function centsToYuanNum(c) {
  const n = Number(c);
  return (Number.isFinite(n) ? n : 0) / 100;
}

// ---------------------------------------------------------------- 对账时间窗
// 与内建 stock-in/store.ts 的 reconRange 同语义（全部 / 今天 / 本月 / 本年 / 自定义）。
// 时间窗同时作用于「厂商对账」与「店铺分摊」两个视图。

const RANGES = [
  { id: 'all', label: '全部' },
  { id: 'day', label: '今天' },
  { id: 'month', label: '本月' },
  { id: 'year', label: '本年' },
  { id: 'custom', label: '自定义' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期 yyyy-MM-dd（不可用 toISOString：会按 UTC 偏移串天） */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 当前时间窗 → { from, to }（自定义未填时该端为 undefined，即不设边界） */
function windowOf(s) {
  const r = s.range || 'all';
  if (r === 'day') {
    const t = localDay();
    return { from: t, to: t };
  }
  if (r === 'month') {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(last)}` };
  }
  if (r === 'year') {
    const y = new Date().getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (r === 'custom') return { from: s.rangeFrom || undefined, to: s.rangeTo || undefined };
  return {};
}

function rangeLabel(s) {
  const { from, to } = windowOf(s);
  if (s.range === 'custom') {
    if (!from && !to) return '自定义（未设边界）';
    return `${from || '…'} ~ ${to || '…'}`;
  }
  return (RANGES.find((x) => x.id === (s.range || 'all')) || RANGES[0]).label;
}

function rangeBarHtml(s) {
  return `
    <div class="bar">
      <span class="muted small">时间范围</span>
      ${RANGES.map(
        (r) => `<button class="btn is-sm${(s.range || 'all') === r.id ? ' is-primary' : ''}" data-range="${r.id}">${esc(r.label)}</button>`,
      ).join('')}
      ${
        s.range === 'custom'
          ? `<input class="input" id="reconFrom" type="date" value="${esc(s.rangeFrom || '')}" style="width:140px" />
             <span class="muted small">~</span>
             <input class="input" id="reconTo" type="date" value="${esc(s.rangeTo || '')}" style="width:140px" />`
          : ''
      }
      <button class="btn is-sm" data-act="reload">刷新</button>
      <span class="grow"></span>
      <span class="muted small">当前：${esc(rangeLabel(s))}</span>
    </div>`;
}

/** 自定义区间首次进入时预填当月窗口（与内建一致：避免空区间让人以为没数据） */
function prefillCustomRange(s) {
  if (s.range === 'custom' && !s.rangeFrom && !s.rangeTo) {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    s.rangeFrom = `${y}-${pad2(m)}-01`;
    s.rangeTo = `${y}-${pad2(m)}-${pad2(last)}`;
  }
}

// ---------------------------------------------------------------- 数据加载

/** 按当前子页签（及对账子视图/时间窗）加载数据 */
async function load(s) {
  if (s.tab === 'supplier') s.suppliers = rowsOf(await purchase('supplierList'));
  else if (s.tab === 'order') {
    s.orders = rowsOf(await purchase('orderList'));
    if (!s.suppliers) s.suppliers = rowsOf(await purchase('supplierList'));
  } else if (s.tab === 'payment') {
    s.payments = rowsOf(await purchase('paymentList', { supplierId: s.paySupplierId || undefined }));
    if (!s.suppliers) s.suppliers = rowsOf(await purchase('supplierList'));
  } else if (s.tab === 'recon') {
    const win = windowOf(s);
    if ((s.reconView || 'supplier') === 'shop') {
      s.shopAlloc = rowsOf(await purchase('shopAllocation', win));
      // 时间窗变化会让已展开店铺的明细过期，收起以强制重新拉取
      s.shopOpen = '';
      s.shopDetail = [];
    } else {
      s.recon = rowsOf(await purchase('reconciliation', win));
    }
  } else if (s.tab === 'gap') {
    s.gap = rowsOf(await purchase('outstanding'));
    s.ignores = rowsOf(await purchase('ignoreList'));
  }
}

// ---------------------------------------------------------------- 供应商

function supplierHtml(s) {
  const rows = s.suppliers || [];
  return `
    <div class="panel">
      <div class="panel-title">供应商 <span class="chip">${num(rows.length)}</span></div>
      <div class="bar">
        <input class="input" id="spName" placeholder="名称" style="width:160px" />
        <input class="input" id="spContact" placeholder="联系人" style="width:120px" />
        <input class="input" id="spPhone" placeholder="电话" style="width:140px" />
        <input class="input" id="spNote" placeholder="备注" style="flex:1 1 160px" />
        <button class="btn is-primary" data-act="sup-create">新增</button>
      </div>
      <div class="table-wrap" style="margin-top:10px">
        ${
          rows.length
            ? `<table class="table">
          <thead><tr><th>名称</th><th>联系人</th><th>电话</th><th>备注</th><th style="width:160px">操作</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td><input class="input" data-sname="${esc(r.id)}" value="${esc(r.name || '')}" /></td>
                  <td><input class="input" data-scontact="${esc(r.id)}" value="${esc(r.contact || '')}" /></td>
                  <td><input class="input" data-sphone="${esc(r.id)}" value="${esc(r.phone || '')}" /></td>
                  <td><input class="input" data-snote="${esc(r.id)}" value="${esc(r.note || '')}" /></td>
                  <td>
                    <button class="btn is-primary" data-act="sup-save" data-id="${esc(r.id)}">保存</button>
                    <button class="btn is-danger" data-act="sup-del" data-id="${esc(r.id)}">删除</button>
                  </td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
            : '<div class="empty">暂无供应商</div>'
        }
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 拿货单

function orderHtml(s) {
  const rows = s.orders || [];
  const opts = (s.suppliers || [])
    .map((x) => `<option value="${esc(x.id)}"${x.id === s.newSupplierId ? ' selected' : ''}>${esc(x.name || '')}</option>`)
    .join('');
  return `
    <div class="panel">
      <div class="panel-title">新建拿货单</div>
      <div class="bar">
        <select class="input" id="orSupplier" style="width:180px">${opts}</select>
        <input class="input" id="orNote" placeholder="备注" style="flex:1 1 200px" />
        <button class="btn is-primary" data-act="ord-create">创建</button>
      </div>
      <div class="small muted" style="margin-top:6px">创建后可在「待拿货缺口」查看建议明细，确认后提交（提交后进入对账）。</div>
    </div>
    <div class="panel">
      <div class="panel-title">拿货单 <span class="chip">${num(rows.length)}</span></div>
      <div class="table-wrap">
        ${
          rows.length
            ? `<table class="table">
          <thead><tr><th>ID</th><th>日期</th><th>供应商</th><th>模式</th><th>金额</th><th>状态</th><th>备注</th><th style="width:210px">操作</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td>${esc(r.id)}</td>
                  <td class="small">${esc(r.bizDate || '')}</td>
                  <td>${esc(r.supplierName || '')}</td>
                  <td><span class="chip" title="${r.mode === 'package' ? '包价：只记总额，不参与齐货/利润' : '明细：按款色逐行记录数量与单价'}">${r.mode === 'package' ? '包价' : '明细'}</span></td>
                  <td>${esc(money(r.totalCents))}</td>
                  <td>${r.status === 'submitted' ? '<span class="chip is-ok">已提交</span>' : '<span class="chip is-warn">草稿</span>'}</td>
                  <td class="small">${esc(r.note || '')}</td>
                  <td>
                    <button class="btn is-primary" data-act="ord-edit" data-id="${esc(r.id)}">查看 / 编辑</button>
                    ${
                      r.status === 'submitted'
                        ? ''
                        : `<button class="btn" data-act="ord-submit" data-id="${esc(r.id)}">提交</button>`
                    }
                    <button class="btn is-danger" data-act="ord-del" data-id="${esc(r.id)}">删除</button>
                  </td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
            : '<div class="empty">暂无拿货单</div>'
        }
      </div>
    </div>`;
}

/**
 * 拿货单查看 / 编辑（宿主 orderGet → orderUpdate）。
 * 岛内用自管 DOM 的模态（util.js 的 modal() 是静态 HTML，无法「加行后重绘」），
 * 明细行与合计在岛内实时重算，保存时由宿主按同一公式复核落库。
 * 单价支持「取最近价」：purchase.priceHistory（同厂商同款色优先，未命中按全局最近一次）。
 */
function openOrderEditor(s, id) {
  return purchase('orderGet', { id }).then((o) => {
    if (!o) {
      notify('拿货单不存在', 'warn');
      return false;
    }

    const draft = {
      bizDate: o.bizDate || localDay(),
      note: o.note || '',
      mode: o.mode === 'package' ? 'package' : 'detail',
      packageYuan: centsToYuanNum(o.totalCents).toFixed(2),
      items: (o.items || []).map((it) => ({ ...it })),
    };

    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal" style="width:min(980px, 94vw)"></div>';
      const box = mask.firstElementChild;
      let closed = false;

      const close = (ok) => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        mask.remove();
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
      };

      const rowAmount = (it) => Math.max(0, Math.round(Number(it.qty) || 0)) * Math.max(0, Math.round(Number(it.priceCents) || 0));
      const itemsTotal = () => draft.items.reduce((sum, it) => sum + rowAmount(it), 0);
      const grandTotal = () => (draft.mode === 'package' ? yuanToCents(draft.packageYuan) : itemsTotal());

      /** DOM → draft（重绘与保存前都必须先同步，否则输入会丢） */
      function sync() {
        const date = box.querySelector('#oeDate');
        if (date) draft.bizDate = date.value;
        const mode = box.querySelector('#oeMode');
        if (mode) draft.mode = mode.value === 'package' ? 'package' : 'detail';
        const note = box.querySelector('#oeNote');
        if (note) draft.note = note.value;
        const pkg = box.querySelector('#oePkg');
        if (pkg) draft.packageYuan = pkg.value;
        box.querySelectorAll('[data-oe]').forEach((el) => {
          const i = Number(el.dataset.i);
          const it = draft.items[i];
          if (!it) return;
          const field = el.dataset.oe;
          if (field === 'priceYuan') it.priceCents = yuanToCents(el.value);
          else if (field === 'qty') it.qty = Math.max(0, Math.round(Number(el.value) || 0));
          else it[field] = el.value;
        });
      }

      function itemsTable() {
        return `
          <div class="panel-title" style="margin-top:12px">
            拿货明细 <span class="chip">${num(draft.items.length)} 行</span>
            <span class="grow"></span>
            <span class="muted small">单价留空可点「取最近价」按同厂商同款色历史单价回填</span>
          </div>
          <div class="table-wrap" style="max-height:44vh">
            <table class="table">
              <thead><tr>
                <th style="width:120px">款编码</th><th style="width:130px">款式名</th><th style="width:90px">款色</th>
                <th style="width:64px">尺码</th><th style="width:70px">数量</th><th style="width:96px">单价(元)</th>
                <th style="width:100px" class="right">金额</th><th style="width:130px"></th>
              </tr></thead>
              <tbody>
                ${
                  draft.items
                    .map(
                      (it, i) => `<tr>
                        <td><input class="input" data-oe="styleCode" data-i="${i}" value="${esc(it.styleCode || '')}" style="width:100%" /></td>
                        <td><input class="input" data-oe="styleName" data-i="${i}" value="${esc(it.styleName || '')}" style="width:100%" /></td>
                        <td><input class="input" data-oe="color" data-i="${i}" value="${esc(it.color || '')}" style="width:100%" /></td>
                        <td><input class="input" data-oe="size" data-i="${i}" value="${esc(it.size || '')}" style="width:100%" /></td>
                        <td><input class="input" data-oe="qty" data-i="${i}" type="number" min="0" step="1" value="${esc(it.qty || '')}" style="width:100%;text-align:right" /></td>
                        <td><input class="input" data-oe="priceYuan" data-i="${i}" type="number" min="0" step="0.01" value="${it.priceCents ? esc(centsToYuanNum(it.priceCents)) : ''}" style="width:100%;text-align:right" /></td>
                        <td class="right" data-oe-amount="${i}">${esc(money(rowAmount(it)))}</td>
                        <td>
                          <button class="btn is-sm" data-act="oe-price" data-i="${i}" title="按「同厂商同款色最近一次拿货价」回填">取最近价</button>
                          <button class="btn is-sm is-danger" data-act="oe-del" data-i="${i}">删</button>
                        </td>
                      </tr>`,
                    )
                    .join('') || '<tr><td colspan="8"><div class="empty">暂无明细行</div></td></tr>'
                }
              </tbody>
            </table>
          </div>
          <div class="bar" style="margin-top:8px"><button class="btn" data-act="oe-add">+ 加行</button></div>`;
      }

      function draw() {
        const isPkg = draft.mode === 'package';
        box.innerHTML = `
          <div class="modal-head">
            编辑拿货单 #${esc(o.id)}
            <span class="chip${o.status === 'submitted' ? ' is-ok' : ''}">${o.status === 'submitted' ? '已提交' : '草稿'}</span>
          </div>
          <div class="small muted" style="margin-bottom:10px">
            厂商 ${esc(o.supplierName || '—')} · 金额由宿主按明细重算
            ${o.status === 'submitted' ? ' · 已提交单的改动会立即影响对账与待拿货缺口' : ''}
          </div>
          <div class="form-grid">
            <div class="field"><label>拿货日期</label><input class="input" id="oeDate" type="date" value="${esc(draft.bizDate)}" /></div>
            <div class="field"><label>模式</label>
              <select class="input" id="oeMode">
                <option value="detail"${isPkg ? '' : ' selected'}>明细（按款色逐行）</option>
                <option value="package"${isPkg ? ' selected' : ''}>包价（只记总额）</option>
              </select>
            </div>
            <div class="field"><label>备注</label><input class="input" id="oeNote" value="${esc(draft.note)}" /></div>
          </div>
          ${
            isPkg
              ? `<div class="field" style="margin-top:10px"><label>本次拿货总额（元）</label>
                   <input class="input" id="oePkg" type="number" min="0" step="0.01" value="${esc(draft.packageYuan)}" />
                 </div>
                 <div class="small muted" style="margin-top:6px">包价单只参与厂商对账，不参与待拿货齐货校验与利润计算。</div>`
              : itemsTable()
          }
          <div class="modal-foot">
            <span class="muted small" style="margin-right:auto">合计 <b data-oe-total>¥${esc(money(grandTotal()))}</b></span>
            <button class="btn" data-act="oe-cancel">取消</button>
            <button class="btn is-primary" data-act="oe-save">保存</button>
          </div>`;
      }

      /** 局部刷新合计与单行金额（输入过程中不整体重绘，避免抢焦点） */
      function refreshTotals() {
        if (closed) return;
        sync();
        draft.items.forEach((it, i) => {
          const cell = box.querySelector(`[data-oe-amount="${i}"]`);
          if (cell) cell.textContent = money(rowAmount(it));
        });
        const total = box.querySelector('[data-oe-total]');
        if (total) total.textContent = `¥${money(grandTotal())}`;
      }

      draw();

      // 输入过程中：只更新合计，不重绘
      box.addEventListener('input', (e) => {
        const el = e.target;
        if (el && el.dataset && (el.dataset.oe === 'qty' || el.dataset.oe === 'priceYuan' || el.id === 'oePkg')) refreshTotals();
      });

      // 款色 / 款编码 变更：若该行尚未定价，自动带出同款最近单价
      box.addEventListener('change', async (e) => {
        const el = e.target;
        if (el && el.id === 'oeMode') {
          sync();
          draw();
          return;
        }
        if (el && el.dataset && el.dataset.oe === 'styleCode') {
          sync();
          const i = Number(el.dataset.i);
          const it = draft.items[i];
          if (it && !it.priceCents) await fillPrice(o, it);
          draw();
          return;
        }
        if (el && el.dataset && el.dataset.oe === 'color') {
          sync();
          const i = Number(el.dataset.i);
          const it = draft.items[i];
          if (it && !it.priceCents) await fillPrice(o, it);
          draw();
          return;
        }
        if (el && el.dataset && el.dataset.oe === 'priceYuan') refreshTotals();
      });

      box.addEventListener('click', async (e) => {
        const el = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!el) return;
        const act = el.dataset.act;
        if (act === 'oe-cancel') return close(false);
        if (act === 'oe-add') {
          sync();
          draft.items.push({ styleCode: '', styleName: '', color: '', size: '', qty: 0, priceCents: 0, suggestionQty: 0 });
          draw();
          return;
        }
        if (act === 'oe-del') {
          sync();
          draft.items.splice(Number(el.dataset.i), 1);
          draw();
          return;
        }
        if (act === 'oe-price') {
          sync();
          const it = draft.items[Number(el.dataset.i)];
          if (!it) return;
          if (!String(it.styleCode || '').trim()) return notify('请先填写款编码', 'warn');
          const hit = await fillPrice(o, it, true);
          if (!hit) notify('未查到该款色的历史单价', 'warn');
          draw();
          return;
        }
        if (act === 'oe-save') {
          sync();
          if (draft.mode === 'detail' && draft.items.every((it) => !String(it.styleCode || '').trim())) {
            return notify('明细不能全为空行（或改用包价模式）', 'warn');
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.bizDate)) return notify('拿货日期格式不正确', 'warn');
          const items = draft.items
            .filter((it) => String(it.styleCode || '').trim())
            .map((it) => ({
              styleCode: it.styleCode,
              styleName: it.styleName || '',
              color: it.color || '',
              size: it.size || '',
              qty: Math.max(0, Math.round(Number(it.qty) || 0)),
              priceCents: Math.max(0, Math.round(Number(it.priceCents) || 0)),
              suggestionQty: Math.max(0, Math.round(Number(it.suggestionQty) || 0)),
            }));
          el.disabled = true;
          try {
            await purchase('orderUpdate', {
              id: o.id,
              bizDate: draft.bizDate,
              note: draft.note,
              items: draft.mode === 'package' ? undefined : items,
              totalCents: draft.mode === 'package' ? yuanToCents(draft.packageYuan) : undefined,
            });
            notify('拿货单已保存', 'success');
            close(true);
          } catch (err) {
            notify(`保存失败：${(err && err.message) || err}`, 'error');
            el.disabled = false;
          }
        }
      });

      // 遮罩点击 = 取消（与 util.modal 一致；点模态内部不触发）
      mask.addEventListener('click', (e) => {
        if (e.target === mask) close(false);
      });

      document.addEventListener('keydown', onKey);
      document.body.appendChild(mask);
    });
  });
}

/**
 * 单价记忆回填（purchase.priceHistory）。
 * @returns {Promise<boolean>} 是否取到有效单价（>0）
 */
async function fillPrice(order, item, force = false) {
  const code = String(item.styleCode || '').trim();
  const color = String(item.color || '').trim();
  if (!code) return false;
  if (!force && item.priceCents > 0) return true;
  const r = await purchase('priceHistory', {
    supplierId: Number(order.supplierId) || 0,
    styleCode: code,
    color,
  });
  const cents = Number(r && r.priceCents) || 0;
  if (cents <= 0) return false;
  item.priceCents = cents;
  return true;
}

// ---------------------------------------------------------------- 付款

function paymentHtml(s) {
  const rows = s.payments || [];
  const opts = (s.suppliers || [])
    .map((x) => `<option value="${esc(x.id)}">${esc(x.name || '')}</option>`)
    .join('');
  return `
    <div class="panel">
      <div class="panel-title">登记付款</div>
      <div class="bar">
        <select class="input" id="paySupplier" style="width:180px">${opts}</select>
        <input class="input" id="payAmount" placeholder="金额（元）" style="width:140px" />
        <input class="input" id="payMethod" placeholder="方式（微信/支付宝/银行）" style="width:180px" />
        <input class="input" id="payNote" placeholder="备注" style="flex:1 1 160px" />
        <button class="btn is-primary" data-act="pay-add">登记</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">付款记录 <span class="chip">${num(rows.length)}</span></div>
      <div class="table-wrap">
        ${
          rows.length
            ? `<table class="table">
          <thead><tr><th>时间</th><th>供应商</th><th>金额</th><th>方式</th><th>备注</th><th style="width:90px"></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td class="small">${esc(fmtTime(r.paidAt))}</td>
                  <td>${esc(r.supplierName || '')}</td>
                  <td>${esc(money(r.amountCents))}</td>
                  <td>${esc(r.method || '')}</td>
                  <td>${esc(r.note || '')}</td>
                  <td><button class="btn is-danger" data-act="pay-del" data-id="${esc(r.id)}">删除</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
            : '<div class="empty">暂无付款记录</div>'
        }
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 对账（厂商 / 店铺）

/** 汇总一行：label + 值 + 是否危险色 */
function reconSupplierHtml(s) {
  const rows = s.recon || [];
  const totals = rows.reduce(
    (acc, r) => {
      acc.purchase += Number(r.purchaseCents) || 0;
      acc.paid += Number(r.paidCents) || 0;
      acc.refund += Number(r.refundCents) || 0;
      acc.balance += Number(r.balanceCents) || 0;
      return acc;
    },
    { purchase: 0, paid: 0, refund: 0, balance: 0 },
  );
  return `
    <div class="grid stats" style="margin-bottom:10px">
      <div class="stat"><div class="stat-label">拿货合计</div><div class="stat-value">¥${esc(money(totals.purchase))}</div></div>
      <div class="stat"><div class="stat-label">已付合计</div><div class="stat-value">¥${esc(money(totals.paid))}</div></div>
      <div class="stat"><div class="stat-label">退款冲抵</div><div class="stat-value">¥${esc(money(totals.refund))}</div></div>
      <div class="stat"><div class="stat-label">欠款</div><div class="stat-value ${totals.balance > 0 ? 'is-danger' : 'is-ok'}">¥${esc(money(totals.balance))}</div></div>
    </div>
    <div class="table-wrap">
      ${
        rows.length
          ? `<table class="table">
        <thead><tr><th>供应商</th><th>拿货单</th><th>拿货</th><th>已付</th><th>退款</th><th>差额</th><th style="width:220px"></th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td>${esc(r.supplierName || '')}</td>
                <td>${num(r.orderCount)} 单 / ${num(r.paymentCount)} 笔</td>
                <td>${esc(money(r.purchaseCents))}</td>
                <td>${esc(money(r.paidCents))}</td>
                <td>${esc(money(r.refundCents))}</td>
                <td class="${Number(r.balanceCents) > 0 ? 'is-danger' : 'is-ok'}">${esc(money(r.balanceCents))}</td>
                <td>
                  <button class="btn is-sm" data-act="recon-pay" data-id="${esc(r.supplierId)}" data-val="${esc(r.supplierName || '')}">记付款</button>
                  <button class="btn is-sm" data-act="recon-orders" data-id="${esc(r.supplierId)}">看拿货单</button>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
          : '<div class="empty">暂无对账数据</div>'
      }
    </div>
    <div class="bar" style="margin-top:10px">
      <button class="btn" data-act="export">导出 Excel</button>
      <span class="muted small">差额 = 拿货 −（已付 − 退款）。窗口内只统计区间内单据，核对完整账目请切「全部」。</span>
    </div>`;
}

function reconShopHtml(s) {
  const rows = s.shopAlloc || [];
  const open = s.shopOpen || '';
  const detail = s.shopDetail || [];
  const totals = rows.reduce(
    (acc, r) => {
      acc.qty += Number(r.qty) || 0;
      acc.amount += Number(r.amountCents) || 0;
      acc.orders += Number(r.orderCount) || 0;
      return acc;
    },
    { qty: 0, amount: 0, orders: 0 },
  );
  return `
    <div class="grid stats" style="margin-bottom:10px">
      <div class="stat"><div class="stat-label">店铺成本合计</div><div class="stat-value">¥${esc(money(totals.amount))}</div></div>
      <div class="stat"><div class="stat-label">件数</div><div class="stat-value">${num(totals.qty)}</div></div>
      <div class="stat"><div class="stat-label">涉及拿货单</div><div class="stat-value">${num(totals.orders)}</div></div>
      <div class="stat"><div class="stat-label">店铺数</div><div class="stat-value">${num(rows.length)}</div></div>
    </div>
    ${
      rows.length
        ? `<div class="table-wrap">
        <table class="table">
          <thead><tr><th style="width:220px">店铺</th><th>拿货单</th><th>件数</th><th>成本</th><th style="width:90px"></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td>${esc(open === r.shop ? '▾ ' : '▸ ') + esc(r.shop || '')}</td>
                  <td>${num(r.orderCount)} 单</td>
                  <td>${num(r.qty)}</td>
                  <td>¥${esc(money(r.amountCents))}</td>
                  <td><button class="btn is-sm" data-act="shop-toggle" data-val="${esc(r.shop)}">${open === r.shop ? '收起' : '明细'}</button></td>
                </tr>
                ${
                  open === r.shop
                    ? `<tr><td colspan="5" style="background:var(--wb-surface-2)">
                        ${
                          detail.length
                            ? `<table class="table" style="background:transparent">
                                <thead><tr><th>日期</th><th>厂商</th><th>款编码</th><th>款式名</th><th>款色</th><th>码</th><th class="right">件</th><th class="right">单价</th><th class="right">金额</th></tr></thead>
                                <tbody>
                                  ${detail
                                    .map(
                                      (l) => `<tr>
                                        <td class="small">${esc(l.bizDate || '')}</td>
                                        <td class="small">${esc(l.supplierName || '')}</td>
                                        <td>${esc(l.styleCode || '')}</td>
                                        <td class="small">${esc(l.styleName || '')}</td>
                                        <td>${esc(l.color || '')}</td>
                                        <td>${esc(l.size || '—')}</td>
                                        <td class="right">${num(l.qty)}</td>
                                        <td class="right muted">${esc(centsToYuanNum(l.priceCents).toFixed(2))}</td>
                                        <td class="right">¥${esc(money(l.amountCents))}</td>
                                      </tr>`,
                                    )
                                    .join('')}
                                </tbody>
                              </table>`
                            : '<div class="empty">该店铺在当前时间窗内没有拿货明细</div>'
                        }
                      </td></tr>`
                    : ''
                }`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="bar" style="margin-top:10px">
        <button class="btn" data-act="export-shop">导出 Excel</button>
        <span class="muted small">拿货成本按拿货单锁定的来源订单（店铺/款色/件数）拆分；未锁定来源的拿货单不参与归属。</span>
      </div>`
        : '<div class="empty">还没有可归属店铺的拿货成本。<br />先在「数据纠正」核对订单，再按档口生成拿货单，成本即会拆分到店铺。</div>'
    }`;
}

function reconHtml(s) {
  const view = s.reconView || 'supplier';
  return `
    <div class="panel">
      <div class="panel-title">
        <span>对账</span>
        <button class="btn is-sm${view === 'supplier' ? ' is-primary' : ''}" data-recon-view="supplier" title="厂商维度：拿货 / 已付 / 欠款">厂商</button>
        <button class="btn is-sm${view === 'shop' ? ' is-primary' : ''}" data-recon-view="shop" title="店铺维度：拿货成本按来源订单分摊到店铺">店铺</button>
      </div>
      ${rangeBarHtml(s)}
    </div>
    <div class="panel">
      ${view === 'shop' ? reconShopHtml(s) : reconSupplierHtml(s)}
    </div>`;
}

// ---------------------------------------------------------------- 待拿货缺口

function gapHtml(s) {
  const rows = s.gap || [];
  const ignores = s.ignores || [];
  return `
    <div class="panel">
      <div class="panel-title">待拿货缺口 <span class="chip is-warn">${num(rows.length)}</span></div>
      <div class="bar">
        <button class="btn" data-act="reload">刷新</button>
        <span class="grow"></span>
        <span class="muted small">缺口 = max(0, 订单需求 − 已拿) − 已忽略（按款色，含全部尺码）</span>
      </div>
      <div class="table-wrap" style="margin-top:10px">
        ${
          rows.length
            ? `<table class="table">
          <thead><tr><th>款编码</th><th>名称</th><th>颜色</th><th>尺码</th><th>需求</th><th>已拿</th><th>差</th><th style="width:100px"></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td>${esc(r.styleCode || '')}</td>
                  <td>${esc(r.styleName || '')}</td>
                  <td>${esc(r.color || '')}</td>
                  <td>${esc(r.size || '')}</td>
                  <td>${num(r.demand)}</td>
                  <td>${num(r.taken)}</td>
                  <td class="is-danger">${num(r.missing)}</td>
                  <td><button class="btn" data-act="gap-ignore"
                        data-code="${esc(r.styleCode || '')}"
                        data-color="${esc(r.color || '')}">忽略</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
            : '<div class="empty">没有待拿货的订单</div>'
        }
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">已忽略（无需补货） <span class="chip">${num(ignores.length)}</span></div>
      <div class="small muted" style="margin-bottom:8px">忽略按「款编码 + 款色」整组生效，取消后该款色所有尺码会重新回到缺口列表。</div>
      <div class="table-wrap">
        ${
          ignores.length
            ? `<table class="table">
          <thead><tr><th>款编码</th><th>款色</th><th>原因</th><th>标记时间</th><th style="width:110px"></th></tr></thead>
          <tbody>
            ${ignores
              .map(
                (r) => `<tr>
                  <td>${esc(r.styleCode || '')}</td>
                  <td>${esc(r.color || '')}</td>
                  <td class="small">${esc(r.reason || '')}</td>
                  <td class="small">${esc(fmtTime(r.createdAt))}</td>
                  <td><button class="btn is-sm" data-act="gap-unignore"
                        data-code="${esc(r.styleCode || '')}"
                        data-color="${esc(r.color || '')}">取消忽略</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
            : '<div class="empty">没有已忽略的款色</div>'
        }
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 视图

export default {
  id: 'stockin',
  title: '拿货对账',
  order: 60,

  async enter() {
    const s = S();
    if (!s.tab) s.tab = 'supplier';
    if (!s.reconView) s.reconView = 'supplier';
    if (!s.range) s.range = 'all';
    await purchase('ensure');
    await load(s);
  },

  render() {
    const s = S();
    const body =
      s.tab === 'supplier'
        ? supplierHtml(s)
        : s.tab === 'order'
          ? orderHtml(s)
          : s.tab === 'payment'
            ? paymentHtml(s)
            : s.tab === 'recon'
              ? reconHtml(s)
              : gapHtml(s);

    return `
      <div class="bar">
        ${TABS.map((t) => `<button class="btn${s.tab === t.id ? ' is-primary' : ''}" data-sub="${t.id}">${esc(t.label)}</button>`).join('')}
      </div>
      ${body}`;
  },

  mount(root) {
    const s = S();

    // 时间窗自定义起止日期（input 事件避免每次按键都重查库）
    const from = root.querySelector('#reconFrom');
    const to = root.querySelector('#reconTo');
    const applyCustomRange = async () => {
      s.rangeFrom = (root.querySelector('#reconFrom') || {}).value || '';
      s.rangeTo = (root.querySelector('#reconTo') || {}).value || '';
      await load(s);
      refresh();
    };
    if (from) from.addEventListener('change', applyCustomRange);
    if (to) to.addEventListener('change', applyCustomRange);

    // 点击目标有四类：data-act（操作） / data-sub（子页签） / data-recon-view（对账子视图） / data-range（时间窗）。
    // app.onClick 默认只代理 [data-act]，其余三类必须显式传入，否则按钮点了没反应（且不报错）。
    onClick(root, async (act, el) => {
      try {
        // 子页签 / 对账子视图 / 时间窗切换：三者都是「先改状态再重载」
        if (el.dataset.sub) {
          s.tab = el.dataset.sub;
          await load(s);
          refresh();
          return;
        }
        if (el.dataset.reconView) {
          s.reconView = el.dataset.reconView;
          await load(s);
          refresh();
          return;
        }
        if (el.dataset.range) {
          s.range = el.dataset.range;
          prefillCustomRange(s);
          await load(s);
          refresh();
          return;
        }

        if (act === 'reload') {
          await load(s);
          refresh();
        } else if (act === 'sup-create') {
          const name = (root.querySelector('#spName') || {}).value || '';
          if (!name.trim()) return notify('请填写供应商名称', 'warn');
          await purchase('supplierCreate', {
            name: name.trim(),
            contact: (root.querySelector('#spContact') || {}).value || '',
            phone: (root.querySelector('#spPhone') || {}).value || '',
            note: (root.querySelector('#spNote') || {}).value || '',
          });
          notify('已新增供应商', 'success');
          await load(s);
          refresh();
        } else if (act === 'sup-save') {
          const id = Number(el.dataset.id);
          await guard(async () => {
            await purchase('supplierUpdate', {
              id,
              name: (root.querySelector(`[data-sname="${id}"]`) || {}).value || '',
              contact: (root.querySelector(`[data-scontact="${id}"]`) || {}).value || '',
              phone: (root.querySelector(`[data-sphone="${id}"]`) || {}).value || '',
              note: (root.querySelector(`[data-snote="${id}"]`) || {}).value || '',
            });
            notify('已保存', 'success');
            await load(s);
            refresh();
          }, el);
        } else if (act === 'sup-del') {
          if (!(await confirm('删除该供应商？其拿货单与付款记录会一并解除归属，请先确认对账已结清。'))) return;
          await purchase('supplierDelete', { id: Number(el.dataset.id) });
          await load(s);
          refresh();
        } else if (act === 'ord-create') {
          const supplierId = Number((root.querySelector('#orSupplier') || {}).value || 0);
          if (!supplierId) return notify('请先创建供应商', 'warn');
          await purchase('orderCreate', {
            supplierId,
            note: (root.querySelector('#orNote') || {}).value || '',
            items: [],
            sources: [],
          });
          notify('已创建拿货单', 'success');
          await load(s);
          refresh();
        } else if (act === 'ord-edit') {
          const ok = await openOrderEditor(s, Number(el.dataset.id));
          if (ok) {
            await load(s);
            refresh();
          }
        } else if (act === 'ord-submit') {
          await guard(async () => {
            await purchase('orderSubmit', { id: Number(el.dataset.id) });
            notify('已提交', 'success');
            await load(s);
            refresh();
          }, el);
        } else if (act === 'ord-del') {
          if (!(await confirm('删除该拿货单？已拿数量会自动回滚，待拿货缺口随之回升。'))) return;
          await purchase('orderDelete', { id: Number(el.dataset.id) });
          await load(s);
          refresh();
        } else if (act === 'pay-add') {
          const amountCents = yuanToCents((root.querySelector('#payAmount') || {}).value);
          const supplierId = Number((root.querySelector('#paySupplier') || {}).value || 0);
          if (!supplierId || !amountCents) return notify('请选择供应商并填写金额', 'warn');
          await purchase('paymentAdd', {
            supplierId,
            amountCents,
            method: (root.querySelector('#payMethod') || {}).value || '',
            note: (root.querySelector('#payNote') || {}).value || '',
            paidAt: new Date().toISOString(),
          });
          notify('已登记付款', 'success');
          await load(s);
          refresh();
        } else if (act === 'pay-del') {
          if (!(await confirm('删除该付款记录？'))) return;
          await purchase('paymentDelete', { id: Number(el.dataset.id) });
          await load(s);
          refresh();
        } else if (act === 'recon-pay') {
          // 从对账表跳到付款页并预选该厂商，省去再选一次
          s.tab = 'payment';
          s.paySupplierId = Number(el.dataset.id) || 0;
          await load(s);
          refresh();
        } else if (act === 'recon-orders') {
          s.tab = 'order';
          await load(s);
          refresh();
        } else if (act === 'shop-toggle') {
          const shop = el.dataset.val || '';
          if (s.shopOpen === shop) {
            s.shopOpen = '';
            s.shopDetail = [];
          } else {
            s.shopOpen = shop;
            s.shopDetail = rowsOf(await purchase('shopAllocationDetail', { shop, ...windowOf(s) }));
          }
          refresh();
        } else if (act === 'gap-ignore') {
          const styleCode = el.dataset.code || '';
          const color = el.dataset.color || '';
          const reason = window.prompt('标记「无需补货」原因（选填，如：已线下拿 / 放弃 / 退单）', '');
          if (reason === null) return; // 取消
          await purchase('ignoreAdd', { styleCode, color, reason: String(reason).trim() });
          notify(`已忽略 ${styleCode}${color ? ' ' + color : ''}`, 'success');
          await load(s);
          refresh();
        } else if (act === 'gap-unignore') {
          const styleCode = el.dataset.code || '';
          const color = el.dataset.color || '';
          await purchase('ignoreRemove', { styleCode, color });
          notify(`已取消忽略 ${styleCode}${color ? ' ' + color : ''}`, 'success');
          await load(s);
          refresh();
        } else if (act === 'export') {
          const rows = s.recon || [];
          if (!rows.length) return notify('暂无数据', 'warn');
          const body = rows.map((r) => [
            r.supplierName || '',
            Number(r.orderCount) || 0,
            money(r.purchaseCents),
            money(r.paidCents),
            money(r.refundCents),
            money(r.balanceCents),
          ]);
          await purchase('exportExcel', {
            fileName: `对账-厂商_${localDay()}.xlsx`,
            rows: [['供应商', '拿货单数', '拿货', '已付', '退款', '差额'], ...body],
          });
          notify('导出完成', 'success');
        } else if (act === 'export-shop') {
          const rows = s.shopAlloc || [];
          if (!rows.length) return notify('暂无数据', 'warn');
          const body = rows.map((r) => [r.shop || '', Number(r.orderCount) || 0, Number(r.qty) || 0, money(r.amountCents)]);
          await purchase('exportExcel', {
            fileName: `对账-店铺_${localDay()}.xlsx`,
            rows: [['店铺', '拿货单数', '件数', '成本'], ...body],
          });
          notify('导出完成', 'success');
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    }, CLICK_TARGETS);
  },
};
