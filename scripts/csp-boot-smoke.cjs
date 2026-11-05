// 主窗口 CSP 启动冒烟（S1 的验收）：真 Electron + **真构建产物** + 真 preload。
//
//   npm run csp:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/csp-boot-smoke.cjs
//   # 受限/沙箱环境加：--no-sandbox --disable-gpu
//
// 为什么需要它：CSP 的破坏方式全是**静默**的 —— 脚本被拦不会抛异常，只是页面不渲染、
// 主题初值不生效、岛/邮件正文整块空白。`npm run build` 成功与这些毫无关系。
// 本脚本断言四件事，缺一条就说明 CSP 加错了：
//   ① 应用真的挂起来了（#app 有子节点）      —— 拦掉 script-src 'self' 里的模块脚本就会红
//   ② theme-init.js 执行了（html[data-theme] 有值）—— 这条专门守"内联脚本外置"没被改回内联
//   ③ 页面里 eval 被禁（EvalError）          —— 这条守 CSP 的核心目的本身
//   ④ preload 仍正常（window.electronAPI 是对象）—— 守"加 CSP 顺手把 preload 打坏"
//
// 反向判据（防恒绿）：③ 若 CSP 被删掉，`eval` 会正常返回而不是抛错 ⇒ 必红。
// 不用"页面无 CSP 违规日志"当判据：那需要监听 console，噪音大且不稳定。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'dist', 'renderer', 'index.html');
const PRELOAD = path.join(ROOT, 'dist', 'electron', 'preload.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-csp-smoke-'));
app.setPath('userData', tmpDir);

// 必须在 app ready **之前** require：该模块顶层就调用 registerSchemesAsPrivileged
// （之后才注册的 scheme 拿不到 standard/secure 特权，frame 会加载失败 —— 那样本脚本的
// 「frame-src 放行」断言会变成"没被 CSP 拦，但也根本没加载"的假绿）。
const { initPluginUiProtocol } = require(path.join(ROOT, 'dist', 'electron', 'plugin-ui-protocol.js'));

const results = [];
function record(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    console.error(`✗ 找不到构建产物 ${INDEX} —— 先跑 npm run build`);
    app.exit(1);
    return;
  }
  if (!fs.existsSync(PRELOAD)) {
    console.error(`✗ 找不到 preload ${PRELOAD} —— 先跑 tsc -p tsconfig.electron.json`);
    app.exit(1);
    return;
  }

  const consoleErrors = [];

  // 造一个最小 UI 岛（真目录 + 真 index.html），让 sk-plugin:// 的 frame **真的能加载**。
  // 没有这一步的话，"没被 CSP 拦"与"协议压根没注册"在日志上无法区分（假绿）。
  //
  // 探测页必须**主动回报**（postMessage），不能靠 iframe 的 load 事件：
  // CSP 拦掉 frame 时 Chromium 仍会触发 load（加载的是错误页），
  // 于是"onload 触发了"根本不能证明加载成功 —— 第一版断言就是这么恒绿的。
  // 回报脚本必须是外部文件：该页 CSP 是 `script-src 'self'`，内联脚本会被自己拦掉。
  const probePluginDir = path.join(tmpDir, 'plugins', 'csp-probe');
  fs.mkdirSync(probePluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(probePluginDir, 'index.html'),
    '<!doctype html><html><body><div id="probe">csp-probe ok</div>' +
      '<script src="./probe.js"></script></body></html>',
    'utf8',
  );
  fs.writeFileSync(
    path.join(probePluginDir, 'probe.js'),
    "parent.postMessage('csp-probe-loaded', '*');\n",
    'utf8',
  );
  initPluginUiProtocol();

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    const text = String(e?.message ?? '');
    if (text) consoleErrors.push(text);
  });

  try {
    console.log('主窗口 CSP 启动冒烟');
    await win.loadFile(INDEX);
    // 给 Vue 挂载与首屏数据一个窗口（这里不连真库，IPC 失败由渲染层兜住）
    await new Promise((r) => setTimeout(r, 2500));

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const app = document.getElementById('app');
      let evalBlocked = false;
      let evalError = '';
      try {
        // eslint-disable-next-line no-eval
        const v = eval('1 + 1');
        evalBlocked = v !== 2; // 真被拦会抛；能算出 2 就说明 CSP 没生效
      } catch (e) {
        evalBlocked = true;
        evalError = e && e.name ? e.name : String(e);
      }
      return {
        appChildren: app ? app.children.length : -1,
        htmlLength: document.body ? document.body.innerHTML.length : 0,
        theme: document.documentElement.getAttribute('data-theme') || '',
        hasBridge: typeof window.electronAPI === 'object' && window.electronAPI !== null,
        evalBlocked,
        evalError,
        cspMeta: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
        frameProbe: await new Promise((resolve) => {
          // 这条断言守的是「主窗口加了 CSP 之后岛没被打死」，不是「frame-src 放行了 sk-plugin:」。
          // 2026-11-04 实测（本脚本的变异版本）：把 frame-src 里的 sk-plugin: 删掉、
          // 只留 default-src 'self'，sk-plugin:// 的 iframe 依然加载并执行脚本 ——
          // frame-src 对已注册的自定义 scheme 不构成实际拦截。所以别把这条守卫写成
          // "有 frame-src 才绿"：那依赖一个不存在的拦截行为，改天 Chromium 收紧就会变成误导。
          // 岛的真实安全边界是 iframe 跨源 + 岛文档自己的 CSP + 桥的 origin 校验。
          //
          // 判据用「探测页主动 postMessage」而不是 iframe 的 load 事件：CSP 真拦掉时
          // load 也会触发（加载的是错误页），第一版就是因此恒绿的。
          let settled = false;
          const done = (r) => {
            if (settled) return;
            settled = true;
            resolve(r);
          };
          window.addEventListener('message', (e) => {
            if (e.data === 'csp-probe-loaded') done({ loaded: true });
          });
          const f = document.createElement('iframe');
          f.style.display = 'none';
          f.src = 'sk-plugin://csp-probe/';
          document.body.appendChild(f);
          setTimeout(() => done({ loaded: false, reason: '3s 内未收到探测页回报' }), 3000);
        }),
      };
    })()`);

    record('应用挂载（#app 有子节点）', probe.appChildren > 0, `children=${probe.appChildren} bodyLen=${probe.htmlLength}`);
    record('首屏主题脚本执行（html[data-theme]）', probe.theme === 'dark' || probe.theme === 'light', `theme=${probe.theme || '(空)'}`);
    record('页面内 eval 被 CSP 禁用', probe.evalBlocked === true, probe.evalError || 'eval 仍可用');
    record('preload 桥正常（window.electronAPI）', probe.hasBridge === true);
    record('CSP meta 存在', probe.cspMeta === true);
    record(
      'UI 岛 iframe 能在主窗口 CSP 下加载（sk-plugin:// 真加载并执行脚本）',
      probe.frameProbe?.loaded === true,
      probe.frameProbe?.loaded === true ? '' : probe.frameProbe?.reason || '未知',
    );
    // CSP 拦 frame 时会留下这条；即便 onload 因别的原因没触发，也能给出准确原因
    const frameRefused = consoleErrors.find((m) => /frame-src/i.test(m) && /refus/i.test(m));
    if (frameRefused) record('控制台无 frame-src 违规', false, frameRefused.slice(0, 200));

    if (results.some((r) => !r) && consoleErrors.length) {
      console.log('\n  页面控制台（前 10 条，排障用）：');
      consoleErrors.slice(0, 10).forEach((m) => console.log('    · ' + m.slice(0, 200)));
    }

    const failed = results.filter((r) => !r).length;
    console.log('\n' + (failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`));
    win.destroy();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('SMOKE_THREW:', err && err.stack ? err.stack : err);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
    app.exit(2);
  }
});
