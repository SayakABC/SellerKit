// dist/util.js
// DOM/渲染小工具：转义、元素构造、表格渲染、模态框、数字/日期格式化。
// 岛内无框架，所有视图共用这套极简渲染原语。

/** HTML 转义（所有用户输入进入 innerHTML 前必须经过） */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 取容器内元素（替代 each view 里的重复 querySelector） */
export function qs(root, sel) {
  return root.querySelector(sel);
}

/** 渲染列表到容器：无数据时渲染空态 */
export function renderList(el, html, emptyText = '暂无数据') {
  el.innerHTML = html || `<div class="empty">${esc(emptyText)}</div>`;
}

/** 千分位/两位小数格式化 */
export function num(v, digits = 0) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * 金额格式化：入参是**分**（宿主所有 `*Cents` 字段的口径），输出「元」的千分位两位小数。
 *
 * ⚠️ 不要拿它去格式化已经换算成元的数字 —— 它自己会先除以 100。
 * 旧实现是 `num(v, 2)`（按分当元直接格式化），拿货单金额、付款金额、对账差额
 * 全部被放大 100 倍显示，且不报错。所有调用点传的都是 *Cents。
 */
export function money(cents) {
  const n = Number(cents);
  return num((Number.isFinite(n) ? n : 0) / 100, 2);
}

/** ISO 时间 → YYYY-MM-DD HH:mm */
export function fmtTime(v) {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成批次号：YYYYMMDD-HHMMSS */
export function newBatchNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 打开模态框
 * @param {object} opts { title, bodyHtml, okText, cancelText, width }
 * @returns {Promise<{ok:boolean, root:HTMLElement}>} 点击确定 ok=true；用户可自行读取 root 内表单值
 */
export function modal({ title = '', bodyHtml = '', okText = '确定', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn is-primary" data-act="ok">${esc(okText)}</button>
        </div>
      </div>`;
    const close = (ok) => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve({ ok, root: mask });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    mask.addEventListener('click', (e) => {
      const act = e.target.getAttribute?.('data-act');
      if (act === 'ok') close(true);
      else if (act === 'cancel' || e.target === mask) close(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
  });
}

/** 简易确认框（危险操作二次确认） */
export async function confirm(text, okText = '确定') {
  const r = await modal({ title: '请确认', bodyHtml: `<div>${esc(text)}</div>`, okText });
  return r.ok;
}

/** 包裹异步操作：统一失败提示 + 返回 undefined（视图无需各自 try/catch） */
export async function guard(fn, el) {
  const { notify } = await import('./bridge.js');
  if (el) el.disabled = true;
  try {
    return await fn();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'error');
    return undefined;
  } finally {
    if (el) el.disabled = false;
  }
}
