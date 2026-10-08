// preload ↔ 主进程「载荷形状」端到端冒烟（**真 preload + 真 handler**，不联网、不需凭据）。
//
//   npm run ipc:shape:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/preload-ipc-shape-smoke.cjs
//   # 受限/沙箱环境（起不了 Chromium sandbox）加：--no-sandbox --disable-gpu
//
// 覆盖两族通道（判据同形：**渲染层按声明调用 → 载荷真的过到主进程 → 回来的是真值**）：
//   ① 图片族（orderImageThumb / ThumbBatch / ReadImage / ReadLocalImage）—— 原始动机，见下；
//   ② `orderSkuRollup`（核对页的「本页汇总」）—— 同为裸数组入参、包装在 preload 里，同一类风险。
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
    // product 域一并加载：⑦ 段要验「认款顺手采纳款主图」这条真链路（复制文件 + 登记 pl_images）
    require(path.join(ROOT, 'dist', 'electron', 'product-handlers.js'));
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

    section('⑥ 本页汇总（order-sku-rollup）：裸数组 → { rows } 的包装必须真的过到主进程');
    // 与 ① 同一类风险：渲染层按声明传**裸数组**（`src/types.ts` 的 `orderSkuRollup(rows)`），
    // 包装成 `{ rows }` 发生在 preload 里，而主进程 handler 读的是 `payload.rows`。
    // 包装写歪（少一层 / 换个键名）的症状是**成功但空**：返回 0 个产品、0 家供应商，
    // 一条报错都没有 —— 核对页的指标格安静地显示 0，看着像"还没配映射"。
    const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
    const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
    pdb.ensureProductSchema();
    pdb.ensureSkuSchema();
    sdb.ensureShopSchema();
    const shopId = sdb.upsertShop({
      id: 0, platform: 'amazon', name: '店铺1', site: '', shopSetId: 0,
      status: 'active', openedAt: '', note: '',
    }).id;
    sdb.mapName({ raw: '店1', refId: shopId, ignored: false });
    const pid = pdb.upsertProduct({
      id: 0, code: 'SHAPE-1', name: '形状款', supplierId: 7, category: '', status: 'active', note: '',
    }).id;
    pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId: 'SHAPE-ITEM', productId: pid }]);

    invokes.length = 0;
    const r6 = await exposed.orderSkuRollup([{ shop: '店1', itemId: 'SHAPE-ITEM' }]);
    check('orderSkuRollup(裸数组) → 1 个产品 / 1 家供应商（形状不匹配时会静默回 0）',
      r6?.success === true && r6?.data?.products === 1 && r6?.data?.suppliers === 1,
      `success=${r6?.success} data=${JSON.stringify(r6?.data)}`);
    check('发出去的载荷就是主进程能消费的形状（rows 非空且带 shop / itemId）',
      Array.isArray(invokes.at(-1)?.[1]?.rows) &&
        invokes.at(-1)[1].rows.length === 1 &&
        invokes.at(-1)[1].rows[0].shop === '店1' &&
        invokes.at(-1)[1].rows[0].itemId === 'SHAPE-ITEM',
      JSON.stringify(invokes.at(-1)?.[1]));
    // 反面：同一个店、没配过映射的商品 → 0/0（证明上面那个"1"不是恒真读数）
    const r6b = await exposed.orderSkuRollup([{ shop: '店1', itemId: 'NOT-MAPPED' }]);
    check('未配映射的商品 → 0 个产品 / 0 家供应商（证明上一个「1」不是恒真）',
      r6b?.success === true && r6b?.data?.products === 0 && r6b?.data?.suppliers === 0,
      `success=${r6b?.success} data=${JSON.stringify(r6b?.data)}`);

    section('⑦ 认款顺手采纳订单图为款主图（真 handler：复制文件 + 登记 pl_images + 写 image_id）');
    // 前一段（product:sku:smoke）只守"挑哪个款、挑哪张图"的挑选逻辑；**换图这件事真的发生了吗**
    // 只能在真 handler 上验：复制文件、算指纹、登记 pl_images、写 pl_products.image_id 四步
    // 任一步漏了，界面上都只是"款还是没图"，一条错都不报。
    const { dbGet, dbRun } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
    const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
    odb.ensureOrderSchema();

    // 素材：一张真 PNG 落进**订单图缓存目录**（与线上同形态：oi_images.local_path 指向它）
    const orderImgPath = path.join(tmpDir, 'order-images', 'adopt-src.png');
    makeRealPng(orderImgPath);
    const oiImgId = dbRun(
      `INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
      ['fp-adopt-shape', 'ufp-adopt-shape', '', orderImgPath],
    ).lastInsertRowid;
    dbRun(`INSERT INTO oi_orders (image_id, order_no, shop, raw_fields) VALUES (?,?,?,?)`, [
      oiImgId, 'SHAPE-ORD-1', '店1', JSON.stringify({ 商品ID: 'SHAPE-ADOPT' }),
    ]);
    const adoptPid = pdb.upsertProduct({
      id: 0, code: 'SHAPE-ADOPT', name: '待采纳款', supplierId: 0,
      category: '', status: 'active', note: '',
    }).id;
    const imageIdOf = (pid) => Number(dbGet(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]).image_id);
    check('前提：这个款还没有主图（否则下面测的是别的事）', imageIdOf(adoptPid) === 0);

    const r7 = await exposed.productSkuMap({
      rows: [{ platform: 'amazon', shopId, itemId: 'SHAPE-ADOPT', productId: adoptPid }],
    });
    check('productSkuMap 回执报出 adopted = 1（界面靠这个数说人话）',
      r7?.success === true && r7?.data?.adopted === 1,
      `success=${r7?.success} data=${JSON.stringify(r7?.data)}`);
    const adoptedImageId = imageIdOf(adoptPid);
    check('款主图真的写进 pl_products.image_id（不是只在返回值里数了个数）',
      adoptedImageId > 0, `image_id=${adoptedImageId}`);
    const imgRow = dbGet(`SELECT local_path, source FROM pl_images WHERE id = ?`, [adoptedImageId]);
    const copiedPath = imgRow ? String(imgRow.local_path) : '';
    check('pl_images 登记了这张图，且落盘在 product-images 目录（源图在 order-images，孤图清理会删它）',
      !!imgRow &&
        copiedPath.indexOf(path.join(tmpDir, 'product-images')) === 0 &&
        fs.existsSync(copiedPath),
      `local_path=${copiedPath} source=${imgRow ? imgRow.source : '(无行)'}`);
    check('复制出来的是**同一份内容**（按内容去重，指纹即文件名）',
      !!imgRow && fs.existsSync(copiedPath) &&
        fs.readFileSync(copiedPath).equals(fs.readFileSync(orderImgPath)));

    // 反面：这个款已经有主图了 —— 再认一次不许换掉它（只补空、不覆盖）
    const r7b = await exposed.productSkuMap({
      rows: [{ platform: 'amazon', shopId, itemId: 'SHAPE-ADOPT', productId: adoptPid }],
    });
    const afterId = imageIdOf(adoptPid);
    check('已有主图的款再认一次 → adopted=0 且 image_id 一个字节没动（不覆盖人的决定）',
      r7b?.data?.adopted === 0 && afterId === adoptedImageId,
      `adopted=${r7b?.data?.adopted} image_id=${afterId}（应为 ${adoptedImageId}）`);
    section('⑧ 反向过滤：product-sku-list 带 productId（产品侧「已关联商品」的取数）');
    // 风险与 ⑥ 同形：渲染层声明里新加了 `productId`，而 preload 若没把它透传出去，主进程就按
    // **不过滤**处理 —— 于是每一款点开都显示"全库的映射"，看着像"这款关联了几十条商品"，
    // 一条错都不报。所以这里既断言结果，也断言**发出去的载荷带上了它**。
    const otherPid = pdb.upsertProduct({
      id: 0, code: 'SHAPE-2', name: '形状款二', supplierId: 0, category: '', status: 'active', note: '',
    }).id;
    pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId: 'SHAPE-ITEM-2', productId: otherPid }]);

    const allMaps = await exposed.productSkuList({ limit: 200 });
    const mineMaps = await exposed.productSkuList({ productId: pid, limit: 200 });
    check('productSkuList({productId}) 只回这一款的行',
      mineMaps?.success === true &&
        mineMaps?.data?.total === 1 &&
        mineMaps?.data?.rows?.length === 1 &&
        mineMaps?.data?.rows?.[0]?.itemId === 'SHAPE-ITEM' &&
        mineMaps?.data?.rows?.every((x) => x.productId === pid),
      `total=${mineMaps?.data?.total} items=${(mineMaps?.data?.rows ?? []).map((r) => r.itemId).join(',')}`);
    check('发出去的载荷真的带上了 productId（preload 漏传 = 静默不过滤）',
      invokes.at(-1)?.[1]?.productId === pid,
      JSON.stringify(invokes.at(-1)?.[1]));
    check('不带 productId 时两款的行都在（证明上一个「1」不是恒真读数）',
      allMaps?.data?.total >= 2 && allMaps?.data?.total > mineMaps?.data?.total,
      `all=${allMaps?.data?.total} mine=${mineMaps?.data?.total}`);
    const otherMaps = await exposed.productSkuList({ productId: otherPid, limit: 200 });
    check('换一个款 → 只回它自己的那一行（反过来证明过滤方向没写反）',
      otherMaps?.data?.total === 1 && otherMaps?.data?.rows?.[0]?.itemId === 'SHAPE-ITEM-2',
      `total=${otherMaps?.data?.total} items=${(otherMaps?.data?.rows ?? []).map((r) => r.itemId).join(',')}`);
  } catch (e) {
    check(`冒烟自身异常：${e && e.message}`, false, e && e.stack ? String(e.stack).split('\n')[1] : '');
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 显式退出（better-sqlite3 / 事件循环可能留着句柄）
  process.exit(failed ? 1 : 0);
});
