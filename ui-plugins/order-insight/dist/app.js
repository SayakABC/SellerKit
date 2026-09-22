// dist/app.js
// 应用外壳：视图注册 / 标签导航 / 视图切换 / 重绘 / 忙碌态 / 事件代理。
// 视图契约：{ id, title, order?, enter?(): Promise<void>, render(): string, mount?(root: HTMLElement): void }
// 数据流：视图状态放 app.store[id]（state(id)），变更后调用 refresh() 重绘当前视图。

import { notify } from './bridge.js';
import { esc } from './util.js';

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
  busyText: '',
  connected: false,
};

/** 取某视图的私有状态对象（不存在则创建） */
export function state(id) {
  if (!app.store[id]) app.store[id] = {};
  return app.store[id];
}

/** 设置/清除忙碌提示并立即重绘 */
export function setBusy(text) {
  app.busyText = text || '';
  draw();
}

/** 重绘当前视图（数据变更后调用） */
export function refresh() {
  draw();
}

/** 切换视图（enter 负责拉数据，失败仅提示不阻断） */
export async function activate(id) {
  const v = getViews().find((x) => x.id === id);
  if (!v) return;
  app.tab = id;
  renderTabs();
  if (typeof v.enter === 'function') {
    app.busyText = '加载中…';
    try {
      await v.enter();
    } catch (e) {
      notify(`加载失败：${e && e.message ? e.message : String(e)}`, 'error');
    }
    app.busyText = '';
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

/** 绘制当前视图（忙碌条 + 视图 HTML + mount 绑定） */
export function draw() {
  const v = getViews().find((x) => x.id === app.tab);
  if (!v || !app.viewEl) return;
  const busy = app.busyText ? `<div class="panel small">${esc(app.busyText)}</div>` : '';
  // 关键：每次绘制都换一个**新的挂载点**，而不是改写 app.viewEl.innerHTML。
  // 视图的点击代理是绑在「挂载点」上的（mount(root) 里的 onClick(root, …)），
  // 若挂载点恒为 app.viewEl，监听器会随每次 refresh() 累加 ——
  // 同一个点击被回调 N 次（重复写库、重复弹窗、撤销栈错乱），且没有任何报错。
  // 换成一次性容器后，旧容器连同其监听器一起被 replaceChildren 回收。
  const holder = document.createElement('div');
  holder.className = 'view-holder';
  holder.innerHTML = busy + v.render();
  app.viewEl.replaceChildren(holder);
  if (typeof v.mount === 'function') v.mount(holder);
}

/**
 * 点击代理：容器内任意命中 selector 的元素点击后回调（携带 data-id / data-val）。
 *
 * 默认只代理 `[data-act]`。视图若还有别的「点击目标」属性（如子页签 data-sub、
 * 时间窗 data-range），必须把 selector 显式传给本函数 —— 否则那些按钮**点了没反应**
 * 且不报错（closest('[data-act]') 匹配不到就直接 return）。别指望它自动识别任意 data-*。
 *
 * @param {HTMLElement} root 挂载点（draw() 每次新建，监听器随旧容器回收）
 * @param {(act: string, el: HTMLElement, e: Event) => void} handler
 * @param {string} selector 命中即回调的选择器
 * @returns {void}
 */
export function onClick(root, handler, selector = '[data-act]') {
  root.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest(selector) : null;
    if (!el || !root.contains(el)) return;
    handler(el.dataset.act || '', el, e);
  });
}

/** input/select/textarea 变更代理：按 id 直接回调 */
export function onChange(root, map) {
  Object.keys(map).forEach((id) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => map[id](el.value));
  });
}
