// dist/app.js
// 应用外壳：视图注册 / 标签导航 / 视图切换 / 重绘 / 事件代理。
// 视图契约：{ id, title, order?, enter?(): Promise<void>, render(): string, mount?(root): void }
// 数据流：视图私有状态放 app.store[id]（state(id)），变更后调用 refresh() 重绘当前视图。

import { notify } from './bridge.js';
import { esc } from './lib.js';

/** @type {Array<{id:string,title:string,order?:number}>} */
const views = [];

/** 注册一个视图（main.js 侧统一注册，顺序由 order 决定） */
export function registerView(view) {
  views.push(view);
}

/** 已注册视图（按 order 升序） */
export function getViews() {
  return views.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** 全局应用状态 */
export const app = {
  tabsEl: null,
  viewEl: null,
  tab: '',
  store: Object.create(null),
  connected: false,
};

/** 取某视图的私有状态对象（不存在则创建） */
export function state(id) {
  if (!app.store[id]) app.store[id] = {};
  return app.store[id];
}

/** 重绘当前视图（数据变更后调用） */
export function refresh() {
  draw();
}

/** 切换视图（enter 负责拉数据，失败仅提示不阻断） */
export async function activate(id) {
  const v = getViews().find((x) => x.id === id);
  if (!v) return;
  // 先让离开的视图解绑（document 级监听是全局副作用，不摘掉会跨视图生效）
  const prev = getViews().find((x) => x.id === app.tab);
  if (prev && prev !== v && typeof prev.leave === 'function') {
    try {
      prev.leave();
    } catch (e) {
      console.warn('[app] view leave failed:', e);
    }
  }
  app.tab = id;
  renderTabs();
  if (typeof v.enter === 'function') {
    try {
      await v.enter();
    } catch (e) {
      notify(`加载失败：${(e && e.message) || String(e)}`, 'error');
    }
  }
  draw();
}

/** 渲染顶部标签栏 */
export function renderTabs() {
  if (!app.tabsEl) return;
  app.tabsEl.innerHTML = getViews()
    .map(
      (v) =>
        `<button class="tab${v.id === app.tab ? ' is-active' : ''}" data-tab="${esc(v.id)}">${esc(v.title)}</button>`,
    )
    .join('');
}

/** 绘制当前视图 */
export function draw() {
  const v = getViews().find((x) => x.id === app.tab);
  if (!v || !app.viewEl) return;
  // 关键：每次绘制都换一个**新的挂载点**，而不是改写 app.viewEl.innerHTML。
  // 点击代理是绑在「挂载点」上的，若挂载点恒为 app.viewEl，监听器会随每次 refresh() 累加 ——
  // 同一个点击被回调 N 次（重复发 IPC、重复弹窗、重复写库），且没有任何报错。
  // 换成一次性容器后，旧容器连同其监听器一起被 replaceChildren 回收。
  const holder = document.createElement('div');
  holder.className = 'view-holder';
  // render/mount 抛错必须收敛：直接抛出去会让 activate() 变成无人接的 rejected
  // promise（页签高亮切了、内容留在旧页，界面毫无反馈——"点了没反应"）。
  try {
    holder.innerHTML = v.render();
  } catch (e) {
    console.error('[app] view render failed:', e);
    notify(`页面渲染失败：${(e && e.message) || e}`, 'error');
    holder.innerHTML = `<div class="empty"><div class="empty-title">页面渲染失败</div><div class="muted small">${esc(
      String((e && e.message) || e),
    )}</div></div>`;
  }
  app.viewEl.replaceChildren(holder);
  try {
    if (typeof v.mount === 'function') v.mount(holder);
  } catch (e) {
    console.error('[app] view mount failed:', e);
    notify(`页面初始化失败：${(e && e.message) || e}`, 'error');
  }
}

/**
 * 局部重绘：只换某个子容器（如查询结果区），不动工具栏。
 *
 * 为什么需要它：克重 / 过滤词是**输入框**，若走整体 draw() 会随每次按键重建 DOM，
 * 光标与输入法组合态全部丢失（表现为"打字打不进去"）。
 * 局部重绘对**同一个已存在的元素**改 innerHTML 是安全的 —— 事件代理挂在
 * holder 上（本函数不动 holder），所以不会产生监听器累加。
 *
 * @param {HTMLElement} root 当前挂载点
 * @param {string} selector 子容器选择器（如 '#results'）
 * @param {string} html 新内容
 */
export function renderRegion(root, selector, html) {
  const el = root && root.querySelector ? root.querySelector(selector) : null;
  if (!el) return false;
  el.innerHTML = html;
  return true;
}

/**
 * 点击代理：容器内任意命中 selector 的元素点击后回调 `handler(act, el, event)`。
 *
 * 默认只代理 `[data-act]`。视图若还有别的「点击目标」属性，必须把 selector 显式传入 ——
 * 否则那些按钮**点了没反应**且不报错（closest 匹配不到就直接 return）。
 *
 * handler 通常是 async（要等宿主返回）。事件监听不会接住 async 回调的 rejection ——
 * 不管它就是一条静默的 unhandled rejection（界面无任何反馈），这里统一收敛成一条告警。
 */
export function onClick(root, handler, selector = '[data-act]') {
  root.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest(selector) : null;
    if (!el || !root.contains(el)) return;
    Promise.resolve(handler(el.dataset.act || '', el, e)).catch((err) => {
      notify(`操作失败：${(err && err.message) || err}`, 'error');
    });
  });
}
