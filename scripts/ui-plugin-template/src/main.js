import './style.css';

/**
 * UI 岛入口：页面在宿主 iframe（sk-plugin://<id>/…）内独立 JS realm 运行。
 * 宿主注入桥 runtime：window.__sk（详见 PLUGIN_DEVELOPMENT.md「UI 岛」章节）。
 * 能力调用一律走 __sk，不直连 window.electronAPI；权限门按 manifest capabilities 判定。
 */

const app = document.querySelector('#app');
const $ = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

function mountDemo() {
  app.innerHTML = '';
  app.appendChild($(
    `<main class="card">
       <h1>__PLUGIN_ID__ · UI 岛</h1>
       <p class="sub">经 <code>sk-plugin://</code> 只读服务加载；能力调用均过权限门（manifest 已声明 storage）。</p>
       <section class="facts">
         <div class="fact"><span class="k">origin</span><span class="v" id="f-origin">…</span></div>
         <div class="fact"><span class="k">桥握手</span><span class="v" id="f-boot">等待…</span></div>
         <div class="fact"><span class="k">主题令牌</span><span class="v" id="f-theme">…</span></div>
         <div class="fact"><span class="k">计数</span><span class="v" id="f-count">0</span></div>
       </section>
       <div class="actions">
         <button id="btn-save" type="button">Storage 存计数</button>
         <button id="btn-toast" type="button">Toast 宿主</button>
         <button id="btn-log" type="button">写宿主日志</button>
         <button id="btn-bus" type="button">事件→宿主</button>
         <button id="btn-clip" type="button" class="deny">越权·剪贴板</button>
       </div>
       <p class="note" id="note">等待桥就绪…</p>
     </main>`
  ));

  document.getElementById('f-origin').textContent = window.location.origin || '(about:blank)';
}

const sk = window.__sk;
if (!sk) {
  const note = document.querySelector('#note');
  if (note) note.textContent = '未检测到 window.__sk（非 iframe 岛环境）';
} else {
  mountDemo();

  const els = {
    boot: document.getElementById('f-boot'),
    theme: document.getElementById('f-theme'),
    count: document.getElementById('f-count'),
    note: document.getElementById('note'),
  };
  const setNote = (msg) => { els.note.textContent = msg; };

  // 1) 桥握手：宿主授权后回调（无参；manifest/env 经 sk.manifest / sk.env getter 读取）
  sk.onReady(async () => {
    const m = sk.manifest; // { id, displayName, version }，boot 前为空对象、握手后填充
    els.boot.textContent = `ready · v${m.version || '?'} · ${m.displayName || ''}`;
    els.theme.textContent = getComputedStyle(document.documentElement).getPropertyValue('--wb-bg').trim() || '(注入前)';
    setNote('桥已就绪。点击按钮体验：storage / toast / log / bus；越权按钮预期被拒并写审计。');

    // 2) 自身命名空间 key 级存储（manifest 已声明 storage；own ns 无需列入 namespaces）
    const key = 'demoCount';
    const stored = await sk.storage.load(key).catch(() => undefined);
    els.count.textContent = String(stored ?? 0);

    document.getElementById('btn-save').addEventListener('click', async () => {
      const cur = Number(els.count.textContent || 0) + 1;
      await sk.storage.save(key, cur);
      els.count.textContent = String(cur);
      setNote(`sk.storage.save(${key}, ${cur}) → 落 electron-store modules.<id>`);
    });

    document.getElementById('btn-toast').addEventListener('click', () => {
      sk.host.ui.notify({ kind: 'info', text: `来自 UI 岛 ${m.displayName || '?'} 的 toast` });
      setNote('sk.host.ui.notify({ kind: "info", text }) → 宿主 toast');
    });

    document.getElementById('btn-log').addEventListener('click', () => {
      sk.log.info('UI 岛日志演示');
      setNote('已向宿主写一条 info 日志');
    });

    // 事件发布：宿主总线广播（自身订阅匹配 → 回显触发下面的通配订阅回调）
    document.getElementById('btn-bus').addEventListener('click', () => {
      sk.bus.emit('plugin:__PLUGIN_ID__:ping', { at: Date.now() });
      setNote('已 publish: plugin:__PLUGIN_ID__:ping（等待回显）');
    });

    // 越权演示：writeText 在桥面白名单内、但 manifest 未声明 clipboard → 权限门拒绝 + 审计
    document.getElementById('btn-clip').addEventListener('click', async () => {
      try {
        await sk.host.clipboard.writeText('x');
        setNote('clipboard.writeText 竟然成功了？（不应发生）');
      } catch (e) {
        setNote(`越权被拒 ✓ → ${e instanceof Error ? e.message : String(e)}（可到「设置 → 插件」审计环查看）`);
      }
    });
  });

  // 3) 宿主侧事件通配订阅（尾部 * 前缀匹配，按 plugin:<id>:* 前缀约定）。
  //    回调签名 cb(payload, meta)；meta = { sourcePlugin, origin }（不含 eventType）
  sk.bus.on('plugin:__PLUGIN_ID__:*', (payload, meta) => {
    setNote(`收到宿主事件（source: ${meta?.sourcePlugin ?? '?'}）payload=${JSON.stringify(payload)}`);
  });
}
