// preload ↔ 主进程「图片通道」载荷形状端到端冒烟（**真 preload + 真 handler**，不联网、不需凭据）。
//
//   npm run ipc:shape:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/preload-ipc-shape-smoke.cjs
//   # 受限/沙箱环境（起不了 Chromium sandbox）加：--no-sandbox --disable-gpu
//
// 为什么值得单独一个冒烟：`npm run verify`（check-ipc-contract.mjs）只核**通道名**三方一致，
// 看不见**载荷形状**。而形状错了的后果恰好是最难查的一种 —— **静默**：
//   `orderImageThumbBatch` 的渲染层契约是裸数组（`src/types.ts`），preload 却只读 `payload.items`，
//   于是 4 个内置调用点（产品页主图列 / 映射与关联的商品ID图 / 编辑抽屉主图预览 / 拣货单商品图）
//   一律发出 `{items: []}` → 主进程返回空数组 → 界面全是空占位、**console 一条错都不报**
//   （调用方的 `catch` 也只兜异常，兜不住"成功但空"）。2026-10-04 实测确认。
//
// 做法：进程内**替换 `ipcMain.handle` / `ipcRenderer.invoke`**，让二者直接对穿（真 IPC 的语义等价物），
// 其余 electron 成员（nativeImage / app / dialog…）保持真实 —— 缩略图要真解码，不能打桩。
// 断言分三层，缺一层都会恒绿：
//   ① 按声明形状调用必须拿到非空 dataUrl（正面）；
//   ② 不存在的路径必须是 null（反面，证明"非空"不是恒真）；
//   ③ 单发上限内的批量必须**逐项对上号**（顺序 + 数量，证明没有静默丢项/错位）。
// 上限之外（一页 >40 张）由渲染层包装函数拆批，见 `tests/thumbBatchChunk.spec.ts`。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const realElectron = require('electron');
const { app, nativeImage } = realElectron;

// 早退护栏：`ELECTRON_RUN_AS_NODE=1`（或从纯 Node 直接 run 这个文件）时 electron 只是个字符串路径，
// `app` 会是 undefined —— 那时下面第一句 `app.setPath` 会报 "Cannot read properties of undefined"，
// 看起来像脚本写错了。这里明说怎么跑，别让下一个人去猜。
if (!process.versions || !process.versions.electron || !app) {
  console.error(
    '✗ 本冒烟必须用**真 Electron** 运行（要 nativeImage 真解码图片）。\n' +
      '  npm run ipc:shape:smoke\n' +
      '  若环境里带 ELECTRON_RUN_AS_NODE=1（CI/沙箱常见），去掉它再跑：\n' +
      '  env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/preload-ipc-shape-smoke.cjs',
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ipc-shape-smoke-'));
app.setPath('userData', tmpDir);

/* ---- electron 模块替身：只换三件，其余保持真实 ---- */
const handlers = new Map();
const invokes = [];
const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  on: () => {},
  removeHandler: (channel) => handlers.delete(channel),
};
const fakeIpcRenderer = {
  invoke: (channel, payload) => {
    invokes.push([channel, payload]);
    const h = handlers.get(channel);
    if (!h) return Promise.reject(new Error(`no handler for ${channel}`));
    return Promise.resolve(h(null, payload));
  },
  on: () => {},
  send: () => {},
  removeAllListeners: () => {},
};
let exposed = null;
const fakeContextBridge = {
  exposeInMainWorld: (_key, api) => {
    exposed = api;
  },
};

const electronProxy = new Proxy(realElectron, {
  get(target, prop) {
    if (prop === 'ipcMain') return fakeIpcMain;
    if (prop === 'ipcRenderer') return fakeIpcRenderer;
    if (prop === 'contextBridge') return fakeContextBridge;
    return target[prop];
  },
});
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronProxy;
  return origLoad.apply(this, [request, ...rest]);
};

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
}
function section(t) {
  console.log('\n' + t);
}

/**
 * 造一张**真实尺寸**的 PNG（不引外部素材）。
 * ⚠️ 1×1 的 PNG 会被 Chromium 判成 empty（`nativeImage.createFromBuffer` 解不出内容）——
 *    拿它当素材会让"缩略图通道坏了"与"素材太小"长得一模一样，属夹具陷阱。
 * 做法：按 BGRA 原始位图建图（需显式给 width/height）后 `toPNG()`，得到真 PNG 字节。
 */
function makeRealPng(dest) {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = 0x40; // B
    raw[i + 1] = 0x80; // G
    raw[i + 2] = 0xc0; // R
    raw[i + 3] = 0xff; // A
  }
  const img = nativeImage.createFromBuffer(raw, { width: w, height: h });
  if (img.isEmpty()) throw new Error('素材构造失败：nativeImage 解不出原始位图');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, img.toPNG());
  return fs.readFileSync(dest);
}

app.whenReady().then(async () => {
  try {
    const { initDb } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
    initDb(path.join(tmpDir, 'ipc-shape-smoke.db'));

    // 真 preload（取它暴露给渲染层的 API）+ 真 handler
    require(path.join(ROOT, 'dist', 'electron', 'preload.js'));
    require(path.join(ROOT, 'dist', 'electron', 'order-handlers.js'));
    assert.ok(exposed, 'preload 没有 exposeInMainWorld');

    section('准备素材（真实 PNG，落进图片缓存目录）');
    const imgDir = path.join(tmpDir, 'product-images');
    const pngPath = path.join(imgDir, 'probe-a.png');
    const pngBuf = makeRealPng(pngPath);
    const missingPath = path.join(imgDir, 'not-exist.png');
    check(`素材就绪（${pngBuf.length} 字节的 PNG）`, pngBuf.length > 100);
    check('缩略图批通道已注册', typeof handlers.get('order-image-thumb-batch') === 'function');

    section('① 渲染层按声明契约（裸数组）调用 —— 这正是被静默吞掉的那条路径');
    const r1 = await exposed.orderImageThumbBatch([{ localPath: pngPath, maxEdge: 160 }]);
    const u1 = r1?.data?.dataUrls?.[0];
    check(
      'orderImageThumbBatch(裸数组) → 非空 dataUrl（形状不匹配时会静默回空数组）',
      !!u1 && u1.startsWith('data:image/'),
      `success=${r1?.success} dataUrls=${JSON.stringify(r1?.data?.dataUrls)?.slice(0, 80)}`,
    );
    check(
      '发出去的载荷就是主进程能消费的形状（items 非空）',
      Array.isArray(invokes.at(-1)?.[1]?.items) && invokes.at(-1)[1].items.length === 1,
      JSON.stringify(invokes.at(-1)?.[1]),
    );

    section('② 反面：不存在/越权的路径必须是 null（证明"非空"不是恒真）');
    const r2 = await exposed.orderImageThumbBatch([{ localPath: missingPath }]);
    check('缺失文件 → null（不是空数组、也不是 200/占位图）', r2?.data?.dataUrls?.[0] === null,
      JSON.stringify(r2?.data?.dataUrls));
    const r2b = await exposed.orderImageThumbBatch([{ localPath: '/etc/hosts' }]);
    check('缓存目录白名单外的路径 → null', r2b?.data?.dataUrls?.[0] === null,
      JSON.stringify(r2b?.data?.dataUrls));

    section('③ 单发上限（40）内的批量必须逐项对上号（顺序 / 数量，不许静默丢项错位）');
    const bulk = [];
    for (let i = 0; i < 40; i++) bulk.push(i % 2 === 0 ? { localPath: pngPath } : { localPath: missingPath });
    const r3 = await exposed.orderImageThumbBatch(bulk);
    const urls3 = r3?.data?.dataUrls ?? [];
    const okCount = urls3.filter((x) => typeof x === 'string' && x.startsWith('data:image/')).length;
    check('40 项 → 40 个结果', urls3.length === 40, `len=${urls3.length}`);
    check('顺序逐项一致：偶数位有图（20 张）、奇数位为 null（20 张）',
      urls3.length === 40 && urls3.every((x, i) => (i % 2 === 0 ? typeof x === 'string' : x === null)),
      `okCount=${okCount}`);
    // 上限之外由**渲染层包装函数拆批**（`src/core/services/ipc.ts` 的 orderImageThumbBatch）——
    // 那条路径在渲染层，主进程冒烟看不见，由 `tests/thumbBatchChunk.spec.ts` 守。
    const r3b = await exposed.orderImageThumbBatch(bulk.concat([{ localPath: pngPath }]));
    check('超出 40 的部分由 preload 截断（**不是**渲染层的职责边界，此处只钉现状）',
      (r3b?.data?.dataUrls ?? []).length === 40, `len=${(r3b?.data?.dataUrls ?? []).length}`);

    section('④ 另外三条图片通道（同族，一并钉住形状）');
    const single = await exposed.orderImageThumb({ localPath: pngPath, maxEdge: 160 });
    check('orderImageThumb({ localPath, maxEdge }) → dataUrl',
      !!single?.data?.dataUrl && single.data.dataUrl.startsWith('data:image/'),
      `success=${single?.success} err=${single?.error || ''}`);
    const read = await exposed.orderReadImage(pngPath);
    check('orderReadImage(localPath) → { mime, dataUrl }',
      !!read?.data?.dataUrl && !!read?.data?.mime, `mime=${read?.data?.mime}`);
    const readLocal = await exposed.orderReadLocalImage(pngPath);
    // `order-read-local-image` 只读**用户经对话框选过的文件**（`isUserFileAllowed` 白名单，
    // 见 main.ts 的 initApprovedUserFiles）——本冒烟没走对话框，所以这里要的结果就是**拒绝**。
    // 断言"拒绝"而不是"能读"：既钉形状，又钉住这条越权防线（缓存的图也不许当用户文件读）。
    check('orderReadLocalImage(localPath) 对非白名单文件一律拒绝',
      readLocal?.success === false && readLocal?.error === 'path not allowed',
      `success=${readLocal?.success} err=${readLocal?.error}`);

    section('⑤ 兼容形状：{ items } 仍可用（岛侧老调用方按这个传）');
    invokes.length = 0;
    const r5 = await exposed.orderImageThumbBatch({ items: [{ localPath: pngPath }] });
    check('{ items: [...] } 也能出图', r5?.data?.dataUrls?.[0]?.startsWith('data:image/') === true,
      JSON.stringify(r5?.data?.dataUrls)?.slice(0, 60));
  } catch (e) {
    check(`冒烟自身异常：${e && e.message}`, false, e && e.stack ? String(e.stack).split('\n')[1] : '');
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 显式退出（better-sqlite3 / 事件循环可能留着句柄）
  process.exit(failed ? 1 : 0);
});
