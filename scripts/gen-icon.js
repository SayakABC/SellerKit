#!/usr/bin/env node
'use strict';

/**
 * 生成应用图标产物。
 *
 * 唯一几何来源：brand/*.svg（1024 视口的应用图标 / 64 视口的托盘模板图）。
 * 本脚本只负责「把 SVG 按目标尺寸光栅化 + 打包成各平台图标格式」，
 * 不在这里重画任何形状 —— 改 logo 只改 SVG，然后跑 npm run icons。
 *
 * 历史：本文件原本是手写的 Electron 默认占位图生成器（蓝底白圆环，
 * dist<=90 白 / <=110 深蓝 / 其余亮蓝）。它每跑一次就会把品牌图标
 * 覆盖回占位图，是回退陷阱，故整份替换。
 *
 * 渲染依赖：本机 Chrome / Chromium（headless）。没有任何 npm 图像库依赖，
 * 用 CDP 的 Page.captureScreenshot({ omitBackground: true }) 拿透明 PNG ——
 * 圆角方底的四角必须透明，否则深色 Dock / 菜单栏会带白角。
 *
 * 托盘模板图为什么必须单独出一份：
 *   macOS 的 createTray() 用 setTemplateImage(true)，系统**只按 alpha 渲染剪影**、忽略 RGB。
 *   彩色应用图标带整块不透明底板 ⇒ 剪影退化成一个实心圆角方块，S 完全看不见。
 *   故 brand/logo-tray-template.svg 去掉底板与靛色模块、只留透明底单色 S 轮廓，
 *   并保留腰部断口（模块在单色下会填满断口，概念会丢）。
 *
 * 产物：
 *   build/icons/png/{16..1024}x*.png   全尺寸应用图标位图
 *   build/icon.png                     256×256，Windows 托盘（extraResources → icon.png）
 *   build/tray-template.png            18×18，macOS 菜单栏模板图（1x）
 *   build/tray-template@2x.png         36×36，同图 2x（nativeImage 按 @2x 自动合并）
 *   build/icons/mac/icon.icns          macOS（iconutil）
 *   build/icons/win/icon.ico           Windows（PNG 压缩条目，Vista+）
 *
 * 用法：npm run icons
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRAND = path.join(ROOT, 'brand');
const PNG_DIR = path.join(ROOT, 'build', 'icons', 'png');
const TRAY = path.join(ROOT, 'build', 'icon.png');
const TRAY_1X = path.join(ROOT, 'build', 'tray-template.png');
const TRAY_2X = path.join(ROOT, 'build', 'tray-template@2x.png');
const ICNS = path.join(ROOT, 'build', 'icons', 'mac', 'icon.icns');
const ICO = path.join(ROOT, 'build', 'icons', 'win', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICONSET = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
};

// 服务端只暴露这两份矢量源；渲染规格里 src 必须与此处键名一致。
const SOURCES = {
  'logo-appicon.svg': path.join(BRAND, 'logo-appicon.svg'),
  'logo-tray-template.svg': path.join(BRAND, 'logo-tray-template.svg'),
};
const RENDER_SPECS = [
  { src: 'logo-appicon.svg', sizes: SIZES, out: (size) => pngPath(size) },
  {
    src: 'logo-tray-template.svg',
    sizes: [18, 36],
    out: (size) => (size === 18 ? TRAY_1X : TRAY_2X),
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngPath = (size) => path.join(PNG_DIR, `${size}x${size}.png`);

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return '';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/__render.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><style>' +
          'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
          'img{display:block;margin:0}</style></head><body>' +
          '<img id="i" src="/logo-appicon.svg" alt=""></body></html>'
      );
      return;
    }
    const name = p.replace(/^\//, '');
    if (SOURCES[name]) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(fs.readFileSync(SOURCES[name]));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 通过 CDP 逐规格 / 逐尺寸渲染：改 img 源与尺寸 + 视口尺寸，截一张 N×N 的透明 PNG */
async function renderAll(chromeBin, port, userDataDir) {
  const url = `http://127.0.0.1:${port}/__render.html`;
  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: 'ignore' }
  );

  try {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await sleep(100);
    if (!fs.existsSync(portFile))
      throw new Error('Chrome 未写出 DevToolsActivePort，headless 启动失败');

    const debugPort = Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page' && t.url.includes('__render.html'));
    if (!page) {
      throw new Error(
        `CDP 里找不到渲染页面 target；现有 target：` +
          JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url })))
      );
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(`CDP evaluate 失败: ${JSON.stringify(r.result.exceptionDetails)}`);
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // 圆角方底的四角必须透明。实测只给 captureScreenshot({ omitBackground:true })
    // 在 headless=new 下仍输出 RGB（sips -g hasAlpha = no）⇒ 四角被合成成白角，
    // 深色 Dock / 菜单栏会露出白方块。这里把默认背景显式覆盖为全透明才生效。
    await send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    for (let i = 0; i < 60; i += 1) {
      if (
        await evaluate("document.readyState==='complete' && document.getElementById('i').complete")
      )
        break;
      await sleep(100);
    }

    const out = {};
    for (const spec of RENDER_SPECS) {
      const wanted = `/${spec.src}`;
      // 首份源已写在渲染页 HTML 里，不要重复赋值 —— 重设 img.src 会触发重新栅格化，
      // 让同一份 SVG 产出与历史不一致的字节（图标产物必须可复现）。
      const current = await evaluate("document.getElementById('i').getAttribute('src')");
      if (current !== wanted) {
        // 换源后必须等新图真正解码完，否则截到的是上一份 SVG。
        await evaluate(`(()=>{document.getElementById('i').src='${wanted}';return true;})()`);
        let loaded = false;
        for (let i = 0; i < 60; i += 1) {
          if (
            await evaluate(
              `(()=>{const i=document.getElementById('i');` +
                `return i.complete && i.naturalWidth>0 && i.getAttribute('src')==='${wanted}';})()`
            )
          ) {
            loaded = true;
            break;
          }
          await sleep(100);
        }
        if (!loaded) throw new Error(`SVG 源加载超时: ${spec.src}`);
      }

      for (const size of spec.sizes) {
        await send('Emulation.setDeviceMetricsOverride', {
          width: size,
          height: size,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluate(
          `(()=>{const i=document.getElementById('i');i.style.width='${size}px';` +
            `i.style.height='${size}px';document.body.style.width='${size}px';` +
            `document.body.style.height='${size}px';return i.naturalWidth;})()`
        );
        await sleep(80);
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          omitBackground: true,
          captureBeyondViewport: false,
        });
        if (!shot.result || !shot.result.data) {
          throw new Error(
            `${spec.src} ${size}x${size} 截图失败: ${JSON.stringify(shot.error || {})}`
          );
        }
        const buf = Buffer.from(shot.result.data, 'base64');
        if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          throw new Error(`${spec.src} ${size}x${size} 截图不是 PNG`);
        }
        const dest = spec.out(size);
        fs.writeFileSync(dest, buf);
        out[dest] = buf;
      }
    }
    ws.close();
    return out;
  } finally {
    chrome.kill('SIGKILL');
  }
}

/** ICO = ICONDIR + N 条 ICONDIRENTRY + 依次拼接的 PNG（Vista+ 支持 PNG 压缩条目） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const b = 16 * i;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0;
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  for (const src of Object.values(SOURCES)) {
    if (!fs.existsSync(src)) throw new Error(`找不到 SVG 源: ${src}`);
  }
  for (const dir of [PNG_DIR, path.dirname(ICNS), path.dirname(ICO)]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const chromeBin = findChrome();
  if (!chromeBin) {
    throw new Error(
      '找不到 Chrome / Chromium。图标产物已随仓库入库，平时无需重生成；\n' +
        '需要重生成时请在本机安装 Chrome 后再跑 npm run icons。'
    );
  }

  const { server, port } = await startServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-icons-'));
  try {
    const pngs = await renderAll(chromeBin, port, path.join(tmp, 'chrome-profile'));

    fs.copyFileSync(pngPath(256), TRAY);

    const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: pngs[pngPath(size)] })));
    fs.writeFileSync(ICO, ico);

    const iconutil = spawnSync('which', ['iconutil'], { encoding: 'utf8' });
    if (iconutil.status === 0 && iconutil.stdout.trim()) {
      const iconset = path.join(tmp, 'icon.iconset');
      fs.mkdirSync(iconset);
      for (const [name, size] of Object.entries(ICONSET)) {
        fs.copyFileSync(pngPath(size), path.join(iconset, name));
      }
      const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`iconutil 失败: ${r.stderr || r.stdout}`);
    } else {
      // 非 macOS 保留已有 icns，不静默产出缺失文件
      if (!fs.existsSync(ICNS))
        throw new Error('非 macOS 环境无法生成 icon.icns，且仓库里没有现成文件');
      console.log('[warn] 非 macOS：跳过 icon.icns 重建，保留现有文件');
    }

    console.log(`图标已生成（源：brand/*.svg，渲染：${chromeBin}）`);
    for (const size of SIZES)
      console.log(
        `  ${String(size).padStart(4)}x${String(size).padEnd(4)} ${pngs[pngPath(size)].length} bytes`
      );
    console.log(`  build/icon.png                  ${fs.statSync(TRAY).size} bytes`);
    console.log(`  build/tray-template.png         ${fs.statSync(TRAY_1X).size} bytes (18x18)`);
    console.log(`  build/tray-template@2x.png      ${fs.statSync(TRAY_2X).size} bytes (36x36)`);
    console.log(`  build/icons/mac/icon.icns       ${fs.statSync(ICNS).size} bytes`);
    console.log(`  build/icons/win/icon.ico        ${fs.statSync(ICO).size} bytes`);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[gen-icon] ${e.message}`);
  process.exit(1);
});
