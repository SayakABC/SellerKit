// preload ↔ 主进程「载荷形状」端到端冒烟（**真 preload + 真 handler**，不联网、不需凭据）。
//
//   npm run ipc:shape:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/preload-ipc-shape-smoke.cjs
//   # 受限/沙箱环境（起不了 Chromium sandbox）加：--no-sandbox --disable-gpu
//
// 覆盖**图片族通道**（orderImageThumb / ThumbBatch / ReadImage / ReadLocalImage）+ **剪贴板图片通道**
// （write-clipboard-image，「复制给厂家」）+ **拿货单行图通道**（purchase-style-images，按款色查本地图）
// + **店铺商品列表通道**（shop-items-list / shop-items-import：shopId 三态透传 + productId 按款筛透传
//   + 全新库守卫）
// + **店铺商品人工维护通道**（shop-items-delete：行 id 定位、删快照不联动删映射）；
// 判据同形：**渲染层按声明调用 → 载荷真的过到主进程 → 回来的是真值**。
// （曾经还覆盖 `orderSkuRollup`（核对页「本页汇总」），那条通道随页头指标条一起删了，见 ⑥ 段的说明。）
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
const { app, nativeImage, clipboard, ClipboardItem } = realElectron;

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
    // 剪贴板两条通道的 handler 住在独立文件（main.ts 是应用入口，冒烟不能加载它 —— 会起窗口）
    require(path.join(ROOT, 'dist', 'electron', 'clipboard-handlers.js'));
    // product 域一并加载：⑦ 段要验「认款顺手采纳款主图」这条真链路（复制文件 + 登记 pl_images）
    require(path.join(ROOT, 'dist', 'electron', 'product-handlers.js'));
    // purchase 域：⑨ 段验「拿货单行图」按款色查图这条真链路
    require(path.join(ROOT, 'dist', 'electron', 'purchase-handlers.js'));
    // shop-item 域：⑩ 段验「店铺商品列表」shopId 三态透传 + 全新库 sk_shops 守卫（真 handler + 真库）
    require(path.join(ROOT, 'dist', 'electron', 'shop-item-handlers.js'));
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

    // 夹具：一家归一后的店铺 + 一个产品 + 一条映射。**后面两段都要用这套**（`shopId` / `pid`
    // 被 ⑥ 与 ⑦ 引用），所以夹具留在这里、段号不再有它自己的那一段。
    // ⚠️ 这一段**曾经**是「⑥ 本页汇总（order-sku-rollup）」：那条通道随「归类核对」页页头的指标条
    //    一起删掉了（2026-10-10，用户判指标条"看不懂" ⇒ 零消费者即删）。删的是**那三条断言**，
    //    不是夹具 —— 连夹具一起删会让下面两段跟着废掉，那是把无关的东西一并拆了。
    const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
    const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
    pdb.ensureProductSchema();
    pdb.ensureSkuSchema();
    sdb.ensureShopSchema();
    const shopId = sdb.upsertShop({
      id: 0, platform: 'amazon', name: '店铺1', site: '',
      status: 'active', openedAt: '', note: '',
    }).id;
    sdb.mapName({ raw: '店1', refId: shopId, ignored: false });
    const pid = pdb.upsertProduct({
      id: 0, code: 'SHAPE-1', name: '形状款', supplierId: 7, category: '', status: 'active', note: '',
    }).id;
    pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId: 'SHAPE-ITEM', productId: pid }]);

    section('⑥ 认款顺手采纳订单图为款主图（真 handler：复制文件 + 登记 pl_images + 写 image_id）');
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
    // 2026-10-21（B1 拆表）：订单图挂在**明细行**（`oi_order_items.image_id`），主表只留一单一份的字段
    const adoptOrderId = dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES (?,?)`, [
      'SHAPE-ORD-1', '店1',
    ]).lastInsertRowid;
    dbRun(`INSERT INTO oi_order_items (order_id, image_id, raw_fields) VALUES (?,?,?)`, [
      adoptOrderId, oiImgId, JSON.stringify({ 商品ID: 'SHAPE-ADOPT' }),
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
    section('⑦ 反向过滤：product-sku-list 带 productId（产品侧「已关联商品」的取数）');
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

    section('⑧ 写图片剪贴板（真系统剪贴板，读回验证）——「复制给厂家」的最后一跳');
    // 为什么在这里守：Electron 44 移除了 clipboard.writeImage（升级实测，改用 ClipboardItem + Blob），
    // 而 tsc / verify 全拦不住 —— require('electron') 是 any，通道名三方一致也照样过；只有真写一次
    // 系统剪贴板才会暴露（2026-10-10 线上症状：「复制失败：写入剪贴板失败」）。
    // 判据不止 success（那可能只是"发起了"）：**读回来**，且内容对得上（非空转）。
    let savedPng = null;
    let savedText = '';
    try {
      savedText = await clipboard.readText();
      if (await clipboard.has('image/png')) {
        const items = await clipboard.read();
        const t = items[0] && (await items[0].getType('image/png'));
        if (t && t.size > 0) savedPng = Buffer.from(await t.arrayBuffer());
      }
    } catch {
      // 读侧失败不阻断（还原退化为写回空文本）
    }
    // 基态清空：hasPng 的"真"必须由**这次写入**造成 —— 不清的话上次运行/人手动复制的图
    // 会让断言蒙对（写实现退化成 writeText 也绿）。
    clipboard.clear();

    const du = 'data:image/png;base64,' + pngBuf.toString('base64');
    const rc = await exposed.writeClipboardImage(du);
    check('writeClipboardImage(真 PNG dataURL) → success:true',
      rc?.success === true, `success=${rc?.success} err=${rc?.error || ''}`);
    const hasPng = await clipboard.has('image/png');
    check('系统剪贴板真的有 image/png（只报 success 可能是空转）', hasPng === true);
    let backSize = null;
    try {
      const items = await clipboard.read();
      const t = items[0] && (await items[0].getType('image/png'));
      if (t && t.size > 0) backSize = nativeImage.createFromBuffer(Buffer.from(await t.arrayBuffer())).getSize();
    } catch {
      // 读不回则 backSize 保持 null，下一条断言自然红
    }
    check('读回的图就是发出去的那张（64×64，内容级非空转）',
      backSize && backSize.width === 64 && backSize.height === 64,
      `readBack=${JSON.stringify(backSize)}`);

    const rcBad = await exposed.writeClipboardImage('data:text/plain;base64,aGk=');
    check('非 PNG dataURL → 拒绝且理由明确（不是"写入剪贴板失败"这类兜底）',
      rcBad?.success === false && rcBad?.error === 'invalid image payload',
      `success=${rcBad?.success} err=${rcBad?.error}`);
    const rcBig = await exposed.writeClipboardImage('data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024));
    check('超 8MB 上限 → 拒绝（image too large）',
      rcBig?.success === false && rcBig?.error === 'image too large',
      `success=${rcBig?.success} err=${rcBig?.error}`);

    // 文本通道同批改过（Electron 44 的 writeText 也变成 async）—— 一并读回验证：
    // 图片修好了、文本在升级里静默坏掉（"发起即成功"，错误落进 unhandled rejection）属同类隐患。
    const txt = 'sk-smoke-剪贴板文本';
    const rt = await exposed.writeClipboard(txt);
    check('writeClipboard(文本) → success:true', rt?.success === true, `success=${rt?.success} err=${rt?.error}`);
    const backText = await clipboard.readText();
    check('读回的文本就是写进去的那句（非空转）', backText === txt, `readBack=${JSON.stringify(backText)}`);

    // 还原原剪贴板（别给跑冒烟的人留下测试残留）
    try {
      if (savedPng) {
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([savedPng], { type: 'image/png' }) })]);
      } else {
        await clipboard.writeText(savedText);
      }
    } catch {
      // 还原失败可接受（不影响断言结果）
    }

    section('⑨ 拿货单行图：purchase-style-images 按「款色 + 尺码」批量查图（真 handler + 真库 JOIN）');
    // 风险与 ① 同形：这条通道的渲染层契约是 `{ items: [{styleCode, color, size}] }`，preload 若没把 items
    // 透传出去（或截断/丢项/**把 size 丢了**），主进程就只能按款色挑"最新一张" → 同一款的多行
    // 全显示同一张图（2026-10-11 用户报的"拿货单明细的图片都是一样的"）；漏掉 items 更糟 ——
    // 回来一串 null，**每行都显示"缺图"**，一条错都不报（界面上只是"这个款没有图"）。
    const siA = dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES (?,?)`, ['SHAPE-S1', 'fp-shape-si-s1']).lastInsertRowid;
    const siB = dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES (?,?)`, ['SHAPE-S2', 'fp-shape-si-s2']).lastInsertRowid;
    const scA = dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?,?,?)`, [siA, '黑', 'SHAPE-S1-黑']).lastInsertRowid;
    dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?,?,?)`, [siA, '白', 'SHAPE-S1-白']);
    const scB = dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?,?,?)`, [siB, '蓝', 'SHAPE-S2-蓝']).lastInsertRowid;
    const siImgB = path.join(tmpDir, 'order-images', 'style-b.png');
    makeRealPng(siImgB);
    dbRun(`INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, style_color_id) VALUES (?,?,?,?,?)`,
      ['fp-shape-si-a', 'ufp-si-a', '', orderImgPath, scA]);
    dbRun(`INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, style_color_id) VALUES (?,?,?,?,?)`,
      ['fp-shape-si-b', 'ufp-si-b', '', siImgB, scB]);

    invokes.length = 0;
    const rs = await exposed.purchaseStyleImages({
      items: [
        { styleCode: 'SHAPE-S1', color: '黑' }, // 有图
        { styleCode: 'SHAPE-S2', color: '蓝' }, // 有图（另一张）
        { styleCode: 'SHAPE-S1', color: '白' }, // 查得到款色但没有图
        { styleCode: '', color: '黑' }, // 空款编码：守卫必须直接给 null，不白查
        { styleCode: 'SHAPE-S9', color: '黑' }, // 款不存在
      ],
    });
    const sp = rs?.data?.paths ?? [];
    check('命中 / 没图 / 空款编码 / 款不存在 逐项对位（顺序 + 数量，不许静默丢项错位）',
      rs?.success === true && sp.length === 5 &&
        sp[0] === orderImgPath && sp[1] === siImgB && sp[2] === null && sp[3] === null && sp[4] === null,
      `success=${rs?.success} paths=${JSON.stringify(sp)}`);
    check('发出去的载荷真的带着 5 项 items（preload 漏传 = 每行都显示缺图且不报错）',
      invokes.at(-1)?.[1]?.items?.length === 5,
      JSON.stringify(invokes.at(-1)?.[1]));
    const rsEmpty = await exposed.purchaseStyleImages({ items: [] });
    check('空清单 → 空 paths（不报错、不编造）',
      rsEmpty?.success === true && (rsEmpty?.data?.paths ?? []).length === 0,
      `success=${rsEmpty?.success} data=${JSON.stringify(rsEmpty?.data)}`);
    const rsCap = await exposed.purchaseStyleImages({
      items: Array.from({ length: 501 }, () => ({ styleCode: 'SHAPE-S1', color: '黑' })),
    });
    check('超出 500 的部分由 preload 截断（上限之外的拆批是渲染层的事，此处只钉现状）',
      (rsCap?.data?.paths ?? []).length === 500, `len=${(rsCap?.data?.paths ?? []).length}`);

    // ---- 「款色 + 尺码」取图（2026-10-11，用户报"拿货单明细的图片都是一样的"）----
    // 真形状：订单 Excel 解析出来的图挂在**订单行**上（oi_order_items.image_id → oi_images.local_path），
    // 而拿货单明细行的粒度是「款色 × 尺码」（= outstanding 的聚合键 = purchase_items 唯一键）
    // ⇒ 取图必须带上尺码，否则同一款的多行全落到"该款色最新那张"。
    // 这里造的就是最小区分场景：同款同色，L 行挂一张、M 行挂另一张。
    const siC = dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES (?,?)`, ['SHAPE-S3', 'fp-shape-si-s3']).lastInsertRowid;
    const scC = dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?,?,?)`, [siC, '灰', 'SHAPE-S3-灰']).lastInsertRowid;
    const szL = path.join(tmpDir, 'order-images', 'size-l.png');
    const szM = path.join(tmpDir, 'order-images', 'size-m.png');
    makeRealPng(szL);
    makeRealPng(szM);
    const idL = dbRun(`INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, style_color_id) VALUES (?,?,?,?,?)`,
      ['fp-shape-si-sl', 'ufp-si-sl', '', szL, scC]).lastInsertRowid;
    const idM = dbRun(`INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, style_color_id) VALUES (?,?,?,?,?)`,
      ['fp-shape-si-sm', 'ufp-si-sm', '', szM, scC]).lastInsertRowid;
    for (const [imgId, no, size] of [[idL, 'SI-SIZE-L', 'L'], [idM, 'SI-SIZE-M', 'M']]) {
      const ordId = dbRun(`INSERT INTO oi_orders (order_no) VALUES (?)`, [no]).lastInsertRowid;
      dbRun(`INSERT INTO oi_order_items (order_id, image_id, size, raw_fields) VALUES (?,?,?,?)`, [
        ordId, imgId, size, '{}',
      ]);
    }

    invokes.length = 0;
    const rsSize = await exposed.purchaseStyleImages({
      items: [
        { styleCode: 'SHAPE-S3', color: '灰', size: 'L' },
        { styleCode: 'SHAPE-S3', color: '灰', size: 'M' },
      ],
    });
    const spSize = rsSize?.data?.paths ?? [];
    check('同款同色、只差尺码 → 各取各那件的图（只按款色取会两行拿到同一张）',
      rsSize?.success === true && spSize.length === 2 && spSize[0] === szL && spSize[1] === szM,
      `paths=${JSON.stringify(spSize)} want=[${szL}, ${szM}]`);
    check('载荷把尺码也透传下去了（preload 漏传 size ⇒ 主进程只能按款色挑，同款全同一张）',
      invokes.at(-1)?.[1]?.items?.length === 2 &&
        invokes.at(-1)[1].items.every((it) => it.size === 'L' || it.size === 'M'),
      JSON.stringify(invokes.at(-1)?.[1]));
    const rsFallback = await exposed.purchaseStyleImages({
      items: [{ styleCode: 'SHAPE-S3', color: '灰', size: 'XXXL' }],
    });
    check('该尺码没有订单行（手工加的行）→ 回落款色级最新图，不是"缺图"',
      rsFallback?.data?.paths?.[0] === szM, JSON.stringify(rsFallback?.data?.paths));

    section('⑩ 店铺商品列表：shopId 三态透传（缺省 = 不过滤）+ 全新库 sk_shops 守卫');
    // 两个已实测的静默缺陷，这里各钉一组：
    // ① preload 曾把缺省 shopId 压成 0 ⇒ 主进程按「未登记桶」过滤 ⇒ 匹配到店的采集行一条都不显示
    //    （2026-10-15 用户现场：扩展报"采到 8 条"，列表全空、console 一条错都没有）。
    //    判据必须含「发出去的载荷里 shopId 是 undefined」—— 只断言"能查到行"会被
    //    "夹具恰好全落桶里"骗绿（旧 e2e 就是这么漏的）。
    // ② 全新库第一站点「店铺商品」曾报 no such table: sk_shops（读链 LEFT JOIN 店铺域从未初始化）。
    sdb.ensureShopSchema();
    const siShopId = sdb.upsertShop({
      id: 0, platform: 'ae', name: '形状采集店', site: '',
      status: 'active', openedAt: '', note: '',
    }).id;
    const imp = await exposed.shopItemsImport({ shopId: siShopId, ids: ['SHAPE-SI-1', 'SHAPE-SI-2'] });
    check('手贴导入两条（真链路：handler → importManualItems → 落该店）',
      imp?.success === true && imp?.data?.inserted === 2,
      `success=${imp?.success} data=${JSON.stringify(imp?.data)}`);

    invokes.length = 0;
    const listNoFilter = await exposed.shopItemsList({});
    check('缺省 shopId 在载荷里是 undefined（不是 0）—— 压成 0 时主进程只翻未登记桶',
      invokes.at(-1)?.[1]?.shopId === undefined, JSON.stringify(invokes.at(-1)?.[1]));
    check('缺省 shopId → 不过滤：店下的行要出现在列表里（旧代码这里 total=0）',
      listNoFilter?.success === true && (listNoFilter?.data?.total ?? 0) >= 2,
      `success=${listNoFilter?.success} total=${listNoFilter?.data?.total}`);

    const listShop = await exposed.shopItemsList({ shopId: siShopId });
    check('指定店 → 只回该店的行',
      listShop?.data?.total === 2 && (listShop?.data?.rows ?? []).every((r) => r.shopId === siShopId),
      `total=${listShop?.data?.total}`);
    const listBucket = await exposed.shopItemsList({ shopId: -1 });
    check('shopId=-1（未登记桶）→ 0 条（这两条落在店下，不在桶里）',
      listBucket?.data?.total === 0, `total=${listBucket?.data?.total}`);

    // 全新库守卫（handler 层，与 shop-item:smoke 的同一条各守一层）：删掉店铺域两张表再读
    dbRun(`DROP TABLE IF EXISTS sk_shops`);
    dbRun(`DROP TABLE IF EXISTS sk_name_map`);
    const listFresh = await exposed.shopItemsList({});
    check('全新库（sk_shops 被删）点「店铺商品」不再报错，且行还在',
      listFresh?.success === true && (listFresh?.data?.total ?? 0) >= 2,
      `success=${listFresh?.success} error=${listFresh?.error || ''} total=${listFresh?.data?.total}`);

    section('⑪ 店铺商品人工维护：删采集行（真 handler + 真库）');
    // 2026-10-16 用户口径：表上加删除；2026-10-23 起 SKU 矩阵的唯一维护面是产品编辑抽屉，
    // 采集段只剩认款，所以写路径这里只验删除：
    //   · 唯一键是 (shop_id, store_key, item_id) 三元组 ⇒ 同一店重复采集幂等更新；
    //     同一商品ID 在桶里/店下各是一行 ⇒ 删除必须按**行 id** 定位；
    //   · 删快照行**不联动删** pl_shop_sku 映射（快照存"店里有什么"、映射存"人的决定"）。
    // 夹具店（⑩ 末把 sk_shops 删了 ⇒ 这里的 ensureSchema 已把它重建为空，重新建一家）
    const siShop2 = sdb.upsertShop({
      id: 0, platform: 'ae', name: '形状维护店', site: '',
      status: 'active', openedAt: '', note: '',
    }).id;
    const impSku = await exposed.shopItemsImport({ shopId: siShop2, ids: ['SHAPE-SKU-1', 'SHAPE-SKU-2'] });
    check('夹具：再导两条进这家店（同店重复导入是更新不是新增）',
      impSku?.success === true && impSku?.data?.inserted === 2,
      `success=${impSku?.success} data=${JSON.stringify(impSku?.data)}`);
    const listAll = await exposed.shopItemsList({});
    const rowSku1 = (listAll?.data?.rows ?? []).find((r) => r.itemId === 'SHAPE-SKU-1');
    const rowSku2 = (listAll?.data?.rows ?? []).find((r) => r.itemId === 'SHAPE-SKU-2');
    check('两条都落在这家店下且各有一个行 id（后面的删除按它定位）',
      !!rowSku1 && !!rowSku2 && rowSku1.shopId === siShop2 && rowSku2.shopId === siShop2,
      `id1=${rowSku1?.id} id2=${rowSku2?.id}`);

    // 先给 SHAPE-SKU-1 建一条认款映射（删快照后它必须还在）
    pdb.upsertSkuMappings([{ platform: 'ae', shopId: siShop2, itemId: 'SHAPE-SKU-1', productId: pid }]);
    const mapBefore = dbGet(`SELECT COUNT(*) AS c FROM pl_shop_sku WHERE item_id = ?`, ['SHAPE-SKU-1']);
    check('前提：这一行已有一条认款映射（否则"删后映射还在"是空转断言）',
      Number(mapBefore?.c) >= 1, `mapRows=${mapBefore?.c}`);

    // 「产品编辑 › 从采集商品导入 SKU 矩阵」的取数口（2026-10-23）：按款筛。
    // 两条都钉在载荷上：① >0 时 productId 必须过到主进程（缺了只能拿全库快照，客户端再筛会漏分页）；
    // ② 0 / 缺省压成 undefined —— 主进程的 0 语义是"不过滤"，压成 0 就与"认到 0 号款"分不开。
    invokes.length = 0;
    const listByProduct = await exposed.shopItemsList({ productId: pid });
    check('按款筛：productId 原样透传（不是只在渲染层筛）',
      invokes.at(-1)?.[1]?.productId === pid, JSON.stringify(invokes.at(-1)?.[1]));
    check('按款筛：只回当前认到这一款的采集行（同店另一条未认款，不得出现）',
      listByProduct?.success === true &&
        listByProduct?.data?.total === 1 &&
        listByProduct?.data?.rows?.[0]?.itemId === 'SHAPE-SKU-1' &&
        listByProduct?.data?.rows?.[0]?.mappedProductId === pid,
      `success=${listByProduct?.success} data=${JSON.stringify(listByProduct?.data)}`);

    invokes.length = 0;
    await exposed.shopItemsList({ productId: 0 });
    check('productId=0 在载荷里是 undefined（0 不是"没认款的款"，是"不筛"）',
      invokes.at(-1)?.[1]?.productId === undefined, JSON.stringify(invokes.at(-1)?.[1]));
    // 删 SHAPE-SKU-1：快照行没了、映射行还在
    const del = await exposed.shopItemsDelete({ id: rowSku1.id });
    check('删采集行成功（按行 id）', del?.success === true && del?.data?.removed === true,
      `success=${del?.success} data=${JSON.stringify(del?.data)}`);
    const afterDel = await exposed.shopItemsList({});
    check('删完这一行消失、另一行还在（按 item_id 删会误删别家那份）',
      !(afterDel?.data?.rows ?? []).some((r) => r.id === rowSku1.id) &&
        (afterDel?.data?.rows ?? []).some((r) => r.itemId === 'SHAPE-SKU-2'),
      `rows=${JSON.stringify((afterDel?.data?.rows ?? []).map((r) => r.itemId))}`);
    const mapLeft = dbGet(`SELECT COUNT(*) AS c FROM pl_shop_sku WHERE item_id = ?`, ['SHAPE-SKU-1']);
    check('⭐ 删快照行不联动删认款映射（快照存"店里有什么"、映射存"人的决定"，两套不互写）',
      Number(mapLeft?.c) >= 1, `mapRows=${mapLeft?.c}`);
    const delMissing = await exposed.shopItemsDelete({ id: rowSku1.id }).catch((e) => ({ success: false, error: String(e) }));
    check('删不存在的行 → 报错上行（行可能刚被重采/删掉，不能假装删了）',
      delMissing?.success === false, `success=${delMissing?.success} err=${delMissing?.error || ''}`);

    // ── ⑫ 记账批量导入：名字必须活着穿过 preload 白名单 ──────────────────
    // 为什么要有这一段：`sanitizeLedgerImportEntries` 是**字段白名单**，漏一个字段就是静默丢弃 ——
    // 主进程收到 `partyId: 0` 且没有名字，报的是「第 1 行：没有资金相关人」，而
    // 直接测 `batchCreateEntries`（`ledger:smoke` 就是这么做的）永远看不见这一层。
    section('⑫ 记账批量导入：partyName / categoryName 穿过 preload 白名单（漏一个就是静默丢失）');
    const ldb = require(path.join(ROOT, 'dist', 'electron', 'ledger-db.js'));
    require(path.join(ROOT, 'dist', 'electron', 'ledger-handlers.js'));
    ldb.ensureLedgerSchema();
    dbRun(
      `INSERT INTO sk_shops (platform, name, name_key, status, opened_at) VALUES ('ae', ?, ?, 'active', '2026-01-01')`,
      ['白名单店', '白名单店'],
    );
    const wlShop = dbGet(`SELECT id FROM sk_shops WHERE name_key = ?`, ['白名单店']);
    const wlImp = await exposed.ledgerEntryBatchCreate({
      entries: [{
        bizDate: '2026-10-03', kind: 'expense', scope: 'shop', shopId: Number(wlShop.id),
        partyId: 0, partyName: '白名单房东', categoryId: 0, categoryName: '白名单科目', amountCents: 12345,
      }],
    }).catch((e) => ({ success: false, error: String(e) }));
    check('批导入成功（名字被白名单丢掉时这里必报「第 1 行：没有资金相关人」）',
      wlImp?.success === true, JSON.stringify(wlImp?.error || wlImp?.data));
    const wlParties = ldb.listParties({}).filter((p) => p.name === '白名单房东');
    check('相关人按文件里的名字建出来了（且只有一条）', wlParties.length === 1, `count=${wlParties.length}`);
    const wlCats = ldb.listCategories('expense', true).filter((c) => c.name === '白名单科目');
    check('科目按文件里的名字建出来了（收/支方向取这一行的方向）',
      wlCats.length === 1 && wlCats[0].kind === 'expense', JSON.stringify(wlCats));
    check('主进程如实返回新建清单（界面据此念出"多出了哪些名字"）',
      JSON.stringify(wlImp?.data?.createdParties) === '["白名单房东"]' &&
        JSON.stringify(wlImp?.data?.createdCategories) === '["白名单科目"]',
      JSON.stringify({ p: wlImp?.data?.createdParties, c: wlImp?.data?.createdCategories }));
    check('条目真的挂在新建的相关人上（不是落成 party_id=0）',
      (wlImp?.data?.ids ?? []).length === 1 && wlParties.length === 1,
      JSON.stringify(wlImp?.data?.ids));
  } catch (e) {
    check(`冒烟自身异常：${e && e.message}`, false, e && e.stack ? String(e.stack).split('\n')[1] : '');
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 显式退出（better-sqlite3 / 事件循环可能留着句柄）
  process.exit(failed ? 1 : 0);
});
