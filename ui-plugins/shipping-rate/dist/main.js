// dist/main.js
// 入口：等待宿主桥就绪 → 初始化状态 → 注册视图 → 渲染标签栏 → 激活首个视图。
// 与宿主的唯一耦合点是 dist/bridge.js（window.__sk），其余为纯前端。

import { ready } from './bridge.js';
import { activate, app, getViews, registerView, renderTabs } from './app.js';
import { init } from './store.js';

import quote from './views/quote.js';
import rates from './views/rates.js';
import orders from './views/orders.js';
import products from './views/products.js';

[quote, rates, orders, products].forEach(registerView);

async function boot() {
  app.tabsEl = document.getElementById('tabs');
  app.viewEl = document.getElementById('view');
  const connEl = document.getElementById('conn');

  // 真正 await 握手（bridge.ready 内部对 __sk.ready 做了 Promise.race + 超时兜底）
  app.connected = await ready();
  if (connEl) {
    connEl.textContent = app.connected ? '已连接宿主' : '未连接宿主';
    connEl.className = `conn ${app.connected ? 'is-on' : 'is-off'}`;
  }

  // 标签栏点击由外层容器代理（标签重绘后无需重新绑定）
  if (app.tabsEl) {
    app.tabsEl.addEventListener('click', (e) => {
      const el = e.target.closest ? e.target.closest('[data-tab]') : null;
      if (el) activate(el.dataset.tab);
    });
  }

  renderTabs();
  // 先把运价表从配置里读出来（含首屏报价），再激活视图 ——
  // 否则首屏会先闪一下"还没有运价表"，且 enter() 里的补算逻辑要再跑一次。
  if (app.connected) await init();

  const first = getViews()[0];
  if (first) await activate(first.id);
}

boot();
