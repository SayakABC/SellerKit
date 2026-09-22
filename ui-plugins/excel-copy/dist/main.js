// dist/main.js
// 入口：等待宿主桥就绪 → 注册全部视图 → 渲染标签栏 → 激活首个视图。
// 与宿主的唯一耦合点是 dist/bridge.js（window.__sk），其余为纯前端。

import { ready } from './bridge.js';
import { activate, app, getViews, registerView, renderTabs } from './app.js';

import copy from './views/copy.js';
import settings from './views/settings.js';

[copy, settings].forEach(registerView);

async function boot() {
  app.tabsEl = document.getElementById('tabs');
  app.viewEl = document.getElementById('view');
  const connEl = document.getElementById('conn');

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
  const first = getViews()[0];
  if (first) await activate(first.id);
}

boot();
