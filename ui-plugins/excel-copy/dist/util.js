// dist/util.js
// DOM/渲染小工具：转义、元素构造、模态框、以及模板渲染/预览。
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

/** 渲染列表到容器：无数据时渲染空态 */
export function renderList(el, html, emptyText = '暂无数据') {
  el.innerHTML = html || `<div class="empty">${esc(emptyText)}</div>`;
}

/** 截断长文本 */
export function truncate(str, len = 30) {
  const s = String(str ?? '');
  return s.length > len ? `${s.slice(0, len)}...` : s;
}

/**
 * 模板替换（语义对齐宿主内建版的 `renderTemplate`）。
 * 缺失字段替换为 [字段缺失: xxx] 而不是空串 —— 让"漏填"在复制结果里可见，
 * 避免用户把残缺文本发出去还以为是数据问题。
 *
 * ⚠️ 岛自带本副本：宿主侧原有一份同语义实现（`templateEngine`），随 excel-copy 下记为岛后
 * 失去全部消费者，已于 2026-10-05 的孤儿代码清理中删除 —— **本文件是当前唯一实现**。
 */
export function renderTemplate(template, fields) {
  return String(template ?? '').replace(/\{\{(.+?)\}\}/g, (_m, key) => {
    const k = String(key).trim();
    const v = (fields || {})[k];
    return v === undefined || v === null ? `[字段缺失: ${k}]` : String(v);
  });
}

/**
 * 预览用：返回带高亮的 HTML + 是否有缺失字段。
 * 模板先整体转义，再把占位符替换成 <span> —— 顺序不能反，否则字段值里的
 * `<script>` 会被当标签插入（字段值来自 Excel，是外部输入）。
 */
export function previewTemplate(template, fields) {
  let hasMissing = false;
  const html = esc(template).replace(/\{\{(.+?)\}\}/g, (_m, key) => {
    const k = String(key).trim();
    const v = (fields || {})[k];
    if (v === undefined || v === null) {
      hasMissing = true;
      return `<span class="missing">[字段缺失: ${esc(k)}]</span>`;
    }
    return `<span class="ph">${esc(v)}</span>`;
  });
  return { html, hasMissing };
}

/** 提取模板里的占位符名（去重） */
export function extractPlaceholders(template) {
  const matches = String(template ?? '').match(/\{\{(.+?)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
}

/**
 * 打开模态框
 * @param {object} opts { title, bodyHtml, okText, cancelText }
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
