// 主数据域（S0a / R1）冒烟：唯一图片仓 + 颜色 / 尺码字典（不启动界面）。
//
//   npm run images:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/master-data-db-smoke.cjs
//
// 为什么必须真 Electron：
//   · `landImageBytes` 的落盘目录是 `app.getPath('userData')/images`，纯 Node 里没有 `app`；
//   · better-sqlite3 按 **Electron 的 Node ABI** 编译，系统 Node 上 require 直接抛（与其它 DB 冒烟同一理由）。
//
// 覆盖的不变量（每一条都对应一次"静默写脏"的真实故障）：
//   · 一张图一份字节：内容 SHA-256 唯一，文件只落**唯一的** `images/` 目录（旧实现两套目录 + 两表 id 撞车）
//   · 两级去重：URL 规范化指纹 → 内容指纹。同图不同 URL 必须复用同一行 ——
//     这是「按图找到款色」的命入口（方案 §8），复用了才能"一张图只有一个色结论"
//   · 唯一落盘入口的拒绝路径：空 / 非图片（按文件头判断，不看扩展名）/ 超 10MB
//   · `registerImageRow` 只登记不落盘；同指纹复用**且不改既有行**（不改路径、不改来源）
//   · 颜色/尺码字典：精确匹配（**不猜**）、trim、大小写不敏感、别名归一；
//     `未分类` 与平台数字色（`1`..`15`）**不入**字典（"还没定色"不是主数据，方案 §5）
//   · 播种是幂等的：第二次 ensure 不重复写；`md_*` 被清空（reset-dev-data）后种子自己回来
//   · 平台色别名：`product_id=0` 全局 / `>0` 款级；唯一键覆盖不插第二行；删款级不误删全局

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const realElectron = require('electron');
const { app } = realElectron;

if (!process.versions || !process.versions.electron || !app) {
  console.error(
    '✗ 本冒烟必须用**真 Electron** 运行（落盘目录取自 app.getPath("userData")）。\n' +
      '  npm run images:smoke\n' +
      '  若环境里带 ELECTRON_RUN_AS_NODE=1（CI/沙箱常见），去掉它再跑：\n' +
      '  env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/master-data-db-smoke.cjs',
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-master-data-smoke-'));
app.setPath('userData', tmpDir);

const { initDb, closeDb, dbRun, dbGet, dbQuery, tableExists } = require(
  path.join(ROOT, 'dist', 'electron', 'db.js'),
);
const md = require(path.join(ROOT, 'dist', 'electron', 'master-data-db.js'));

initDb(path.join(tmpDir, 'smoke.db'));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : String(err)}`);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const countOf = (table) => Number(dbGet(`SELECT COUNT(*) AS n FROM ${table}`).n);
const columnsOf = (table) => dbQuery(`PRAGMA table_info(${table})`).map((r) => String(r.name));

/** 只过 `sniffImageFormat` 的文件头（本冒烟不启动界面、不解码像素，够用且不依赖真图） */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JUNK = Buffer.from('not-an-image-at-all');
const imgA = Buffer.concat([PNG_SIG, Buffer.from('a'.repeat(40))]);
const imgB = Buffer.concat([PNG_SIG, Buffer.from('b'.repeat(40))]);
const fpA = sha256(imgA);
const fpB = sha256(imgB);

/** [0] 记录下来的种子行数（[8] 的自愈断言拿它比，避免写死词表长度） */
let seedColors = 0;
let seedSizes = 0;

// ────────────────────────────────────────────────────────── [0] 建表 + 播种
console.log('\n[0] 建表与种子字典');
check('ensureMasterDataSchema 一次建出四张表（图片 / 颜色 / 尺码 / 平台色别名）', () => {
  md.ensureMasterDataSchema();
  for (const t of ['md_images', 'md_colors', 'md_sizes', 'md_color_aliases']) {
    assert.ok(tableExists(t), `缺表 ${t}`);
  }
  // md_images 只存"这张图是什么字节"，不存归属（归属写业务表）—— 旧表上的识别流水线字段
  // （status / result_json / error / style_color_id）一个都不该回来，否则"图行持色"会复活。
  const cols = columnsOf('md_images');
  for (const gone of ['status', 'result_json', 'error', 'style_color_id']) {
    assert.ok(!cols.includes(gone), `md_images 不该有列 ${gone}`);
  }
  assert.ok(md.masterDataReady(), 'masterDataReady 应为 true');
});

check('落盘目录只有唯一一个 `images/`（旧的两套目录 order-images/ + product-images/ 已退役）', () => {
  const dir = md.IMAGE_DIR();
  assert.strictEqual(path.basename(dir), 'images', `落盘目录名不对：${dir}`);
  assert.ok(dir.indexOf(tmpDir) === 0, '落盘目录必须在 userData 下（备份/孤图清理认它）');
});

check('种子：颜色 / 尺码按词表播种，且**不建占位色**（未分类、平台数字色不进字典）', () => {
  // 期望值取"首次 ensure 之后的实际行数"，而不是源码里那个数组的长度：种子词表会增删，
  // 写死数字只会让这条断言在下次加色名时变红（那时它想验的东西其实没坏）。
  seedColors = countOf('md_colors');
  seedSizes = countOf('md_sizes');
  assert.ok(seedColors >= 20, `颜色种子太少（词表被删空？）：${seedColors}`);
  assert.ok(seedSizes >= 10, `尺码种子太少（词表被删空？）：${seedSizes}`);
  for (const placeholder of ['未分类', '1', '2', '5', '15', '']) {
    assert.strictEqual(
      md.resolveColorId(placeholder),
      0,
      `占位色 ${JSON.stringify(placeholder)} 不该进 md_colors（那是"还没定色"的证据）`,
    );
  }
  // 确定的色名必须在（否则"定色"下拉是空的）
  assert.ok(md.resolveColorId('黑色') > 0, '种子缺「黑色」');
  assert.ok(md.resolveColorId('藏青') > 0, '种子缺「藏青」');
});

// ────────────────────────────────────────────────────────── [1] 落盘 + 两级去重
console.log('\n[1] landImageBytes：一张图一份字节 + 两级去重');
let idA = 0;
let idB = 0;
check('首次落盘：文件名 = 内容 SHA-256，扩展名按文件头（不按调用方给的 URL 尾巴）', () => {
  const landed = md.landImageBytes(imgA, {
    sourceUrl: 'https://cdn.example.com/a.png?sign=1&t=2',
    source: 'shop-item',
  });
  idA = Number(landed.imageId);
  assert.ok(idA > 0, 'imageId 必须 > 0');
  assert.strictEqual(landed.reused, false, '首次落盘不该标 reused');
  assert.strictEqual(landed.fingerprint, fpA, '指纹应是内容 SHA-256');
  assert.strictEqual(
    path.basename(landed.localPath),
    `${fpA}.png`,
    '文件名应为「内容指纹 + 按文件头判定的扩展名」',
  );
  assert.ok(landed.localPath.indexOf(path.join(tmpDir, 'images')) === 0, '必须落在唯一的 images/');
  assert.ok(fs.existsSync(landed.localPath), '字节必须真的落盘');
  const row = md.findImageByFingerprint(fpA);
  assert.strictEqual(Number(row.id), idA);
  assert.strictEqual(row.source, 'shop-item', '来源标记要落库（排查"图从哪条链路进来"）');
  assert.strictEqual(md.imageIdExists(idA), true);
  assert.strictEqual(md.imageLocalPath(idA), landed.localPath);
});

check('第①级去重（URL 规范化指纹）：同一张图的第二个签名 URL 不落第二行、不写第二份字节', () => {
  const before = countOf('md_images');
  const landed = md.landImageBytes(imgA, {
    sourceUrl: 'https://cdn.example.com/a.png?sign=999&t=888',
    source: 'order-image',
  });
  assert.strictEqual(landed.reused, true, 'URL 指纹命中必须标 reused');
  assert.strictEqual(Number(landed.imageId), idA, 'URL 命中必须复用同一行');
  assert.strictEqual(countOf('md_images'), before, 'URL 命中不许插第二行');
  const row = md.findImageByFingerprint(fpA);
  assert.strictEqual(row.source, 'shop-item', '命中路径不许改既有行的来源（"谁先落谁说话"）');
});

check('第②级去重（内容指纹）：同字节不同 URL 也复用同一行（"按图找色"的命入口）', () => {
  const before = countOf('md_images');
  const landed = md.landImageBytes(imgA, { sourceUrl: 'https://cdn.other.com/renamed-a.png' });
  assert.strictEqual(landed.reused, true, '内容指纹命中必须标 reused');
  assert.strictEqual(Number(landed.imageId), idA, '同字节必须复用同一行（否则一张图两个色结论）');
  assert.strictEqual(countOf('md_images'), before, '内容命中不许插第二行');
});

check('不同字节 + 不同 URL → 新行；两张图各一份文件（目录里总共 2 个文件）', () => {
  const landed = md.landImageBytes(imgB, { sourceUrl: 'https://cdn.example.com/b.png', source: 'order-image' });
  idB = Number(landed.imageId);
  assert.strictEqual(landed.reused, false);
  assert.ok(idB > 0 && idB !== idA, '不同图必须是不同 id');
  assert.strictEqual(countOf('md_images'), 2);
  const files = fs.readdirSync(md.IMAGE_DIR()).sort();
  assert.deepStrictEqual(files, [`${fpA}.png`, `${fpB}.png`].sort(), `目录里不该有别的文件：${files}`);
});

// ────────────────────────────────────────────────────────── [2] 拒绝路径
console.log('\n[2] landImageBytes 的拒绝路径（宁可不落，别把垃圾入库）');
check('空内容 / 非图片（按文件头判断，不看扩展名）/ 超过 10MB 一律抛，且不留下任何行或文件', () => {
  const rowsBefore = countOf('md_images');
  const filesBefore = fs.readdirSync(md.IMAGE_DIR()).length;
  assert.throws(() => md.landImageBytes(Buffer.alloc(0), {}), /图片内容为空/);
  assert.throws(() => md.landImageBytes(JUNK, {}), /不是受支持的图片格式/);
  // 伪装成图片的文本（扩展名对不对都不算数：只看文件头）
  assert.throws(() => md.landImageBytes(JUNK, { sourceUrl: 'https://cdn.example.com/fake.png' }), /不是受支持的图片格式/);
  // 上限先于格式判断（超限的 buffer 连嗅探都不做）
  assert.throws(
    () => md.landImageBytes(Buffer.alloc(md.MAX_IMAGE_BYTES + 1), {}),
    /超过 10MB 上限/,
  );
  assert.strictEqual(countOf('md_images'), rowsBefore, '拒绝路径不许留下图片行');
  assert.strictEqual(fs.readdirSync(md.IMAGE_DIR()).length, filesBefore, '拒绝路径不许留下文件');
  assert.strictEqual(md.MAX_IMAGE_BYTES, 10 * 1024 * 1024);
});

// ────────────────────────────────────────────────────────── [3] 登记 / 读接口
console.log('\n[3] registerImageRow（只登记）与读接口');
let idManual = 0;
check('已落盘的图：登记不覆盖既有行（同指纹 → 复用、路径保持第一次那条）', () => {
  const before = countOf('md_images');
  const out = md.registerImageRow({
    fingerprint: fpB,
    localPath: path.join(tmpDir, 'images', 'some-other-path.png'),
    source: 'upload',
  });
  assert.strictEqual(out.reused, true, '同指纹必须复用');
  assert.strictEqual(Number(out.imageId), idB);
  assert.strictEqual(countOf('md_images'), before, '不许插第二行');
  assert.strictEqual(
    md.imageLocalPath(idB),
    path.join(md.IMAGE_DIR(), `${fpB}.png`),
    '复用不许改既有行的 local_path（否则同一行指向两个文件）',
  );
});

check('新指纹登记：只写行、不落盘（二进制落盘只有 landImageBytes 一个入口）', () => {
  const localPath = path.join(md.IMAGE_DIR(), 'manual-upload.png');
  const out = md.registerImageRow({ fingerprint: 'fp-manual-1', localPath, sourceUrl: 'https://x/y.png' });
  idManual = Number(out.imageId);
  assert.strictEqual(out.reused, false);
  assert.ok(idManual > idB, '新行 id 应大于历史最大 id');
  assert.strictEqual(fs.existsSync(localPath), false, 'registerImageRow 不许自己写文件');
  const row = md.findImageByFingerprint('fp-manual-1');
  assert.strictEqual(row.source, 'upload', '默认来源是 upload');
  assert.strictEqual(row.localPath, localPath);
});

check('空指纹 / 空路径直接拒（"登记了一张不存在的图"是最难查的静默脏数据）', () => {
  const before = countOf('md_images');
  assert.throws(() => md.registerImageRow({ fingerprint: '  ', localPath: '/tmp/x.png' }), /不能为空/);
  assert.throws(() => md.registerImageRow({ fingerprint: 'fp-x', localPath: '' }), /不能为空/);
  assert.strictEqual(countOf('md_images'), before);
});

check('批量 / 全量读接口：imageLocalPathMap 逐项对上号，allImageLocalPaths 覆盖全部已登记路径', () => {
  const map = md.imageLocalPathMap([idA, idB, idManual, 0, -3, 999]);
  assert.strictEqual(map.get(idA), md.imageLocalPath(idA));
  assert.strictEqual(map.get(idB), md.imageLocalPath(idB));
  assert.strictEqual(map.get(idManual), md.imageLocalPath(idManual));
  assert.strictEqual(map.has(0), false, '0 不是合法图片 id，不许出现在映射里');
  assert.strictEqual(map.has(999), false, '不存在的 id 只能缺项，不能编一个空串进去');
  assert.strictEqual(map.size, 3);

  const all = md.allImageLocalPaths();
  assert.strictEqual(all.length, 3, 'allImageLocalPaths 必须覆盖全部已登记路径（孤图清理靠它）');
  assert.ok(all.includes(md.imageLocalPath(idA)));
});

check('缺行/非法 id 的读接口一律降级（不抛）：imageRowById / colorById / colorNameOf / sizeNameOf', () => {
  assert.strictEqual(md.imageRowById(0), undefined);
  assert.strictEqual(md.imageRowById(999), undefined);
  assert.strictEqual(md.imageRowById(idA).id, idA);
  assert.strictEqual(md.colorNameOf(0), '');
  assert.strictEqual(md.colorNameOf(999), '');
  assert.strictEqual(md.colorById(999), undefined);
  assert.strictEqual(md.sizeNameOf(999), '');
});

// ────────────────────────────────────────────────────────── [4] URL 指纹
console.log('\n[4] fingerprintUrl：同一张图不同签名参数必须归一');
check('协议 + 主机 + 路径相同、query 不同 → 同一指纹；路径不同 → 不同指纹', () => {
  const a = md.fingerprintUrl('https://cdn.example.com/a.png?sign=1&t=2');
  const b = md.fingerprintUrl('https://cdn.example.com/a.png?sign=9');
  const c = md.fingerprintUrl('https://cdn.example.com/b.png?sign=1');
  assert.strictEqual(a, b, 'query（签名/时间戳）不参与指纹 —— 否则同一张图每次导入都落一行');
  assert.notStrictEqual(a, c, '路径不同必须是不同图');
  // 与 landImageBytes 内部算的是同一份（落库的 url_fingerprint 就是它）
  assert.strictEqual(
    String(md.findImageByUrlFingerprint(a).fingerprint),
    fpA,
    '按 URL 指纹应能查回同一行（第①级去重的查询入口）',
  );
});

check('非法 URL 退回整串哈希（不抛、且稳定）', () => {
  const h1 = md.fingerprintUrl('not-a-url');
  const h2 = md.fingerprintUrl('not-a-url');
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1, sha256(Buffer.from('not-a-url')));
  assert.strictEqual(md.fingerprintUrl(''), sha256(Buffer.from('')));
});

// ────────────────────────────────────────────────────────── [5] 颜色字典
console.log('\n[5] 颜色字典：精确匹配不猜 + 新建幂等');
check('resolveColorId 精确匹配、trim 后匹配；近义色名**不许**互猜（黑色 ≠ 黑）', () => {
  assert.ok(md.resolveColorId('黑色') > 0);
  assert.strictEqual(md.resolveColorId('  黑色  '), md.resolveColorId('黑色'), '两侧空白要 trim');
  assert.strictEqual(md.resolveColorId('黑'), 0, '「黑」不是字典里的行 —— 要新建或走别名，不能猜成「黑色」');
  assert.strictEqual(md.resolveColorId('BLACK'), 0, '颜色名大小写敏感（中文词表，没有英文同义）');
  assert.strictEqual(md.resolveColorId(null), 0);
  assert.strictEqual(md.resolveColorId(undefined), 0);
});

check('ensureColorId：首次新建、再跑幂等；空名抛错；色值随行落库', () => {
  const first = md.ensureColorId('自定义色', '#123456');
  assert.strictEqual(first.created, true, '首次应新建');
  assert.ok(first.id > 0);
  const again = md.ensureColorId('  自定义色  ');
  assert.strictEqual(again.created, false, '同色名不许插第二行');
  assert.strictEqual(again.id, first.id);
  assert.strictEqual(md.colorById(first.id).hex, '#123456');
  assert.throws(() => md.ensureColorId('   '), /颜色名不能为空/);
  // 种子色也走同一条路：命中即返回既有 id
  const seed = md.ensureColorId('黑色');
  assert.strictEqual(seed.created, false);
  assert.strictEqual(seed.id, md.resolveColorId('黑色'));
});

check('colorList 只回启用中的行、且按 sort_order 排（下拉顺序稳定）', () => {
  const list = md.colorList();
  assert.ok(list.length >= 28);
  assert.ok(list.every((c) => c.status !== 'disabled'));
  const orders = list.map((c) => c.sortOrder);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepStrictEqual(orders, sorted, 'colorList 必须按 sort_order 升序');
  assert.strictEqual(list[0].name, '黑色', '种子第一行是「黑色」');
});

// ────────────────────────────────────────────────────────── [6] 尺码字典
console.log('\n[6] 尺码字典：别名归一 + 大小写不敏感');
check('resolveSizeId 认别名（XXL→2XL、XXXL→3XL、F→均码），且大小写不敏感', () => {
  assert.strictEqual(md.resolveSizeId('XXL'), md.resolveSizeId('2XL'));
  assert.strictEqual(md.resolveSizeId('xxxl'), md.resolveSizeId('3XL'), '别名大小写不敏感');
  assert.strictEqual(md.resolveSizeId('f'), md.resolveSizeId('均码'));
  assert.strictEqual(md.resolveSizeId('M'), md.resolveSizeId('m'));
  assert.strictEqual(md.resolveSizeId('6XL'), 0, '字典里没有的码不许猜成 5XL');
  assert.strictEqual(md.resolveSizeId(''), 0);
});

check('canonicalSizeName 归一成标准码名；ensureSizeId 新建/幂等', () => {
  assert.strictEqual(md.canonicalSizeName('XXL'), '2XL');
  assert.strictEqual(md.canonicalSizeName('F'), '均码');
  assert.strictEqual(md.canonicalSizeName('未知码'), '未知码', '认不出的码回原文，不吞掉');
  const first = md.ensureSizeId('6XL', 'S-5XL');
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.name, '6XL');
  const again = md.ensureSizeId('6XL');
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.id, first.id);
  // 走近别名时不许新建：命中既有行（否则 2XL / XXL 会各占一行）
  const byAlias = md.ensureSizeId('XXXXL');
  assert.strictEqual(byAlias.created, false);
  assert.strictEqual(byAlias.id, md.resolveSizeId('4XL'));
  assert.strictEqual(byAlias.name, '4XL');
  assert.throws(() => md.ensureSizeId('  '), /尺码不能为空/);
});

// ────────────────────────────────────────────────────────── [7] 平台色别名
console.log('\n[7] 平台色别名（全局 vs 款级，先款级再全局）');
check('写别名：全局 product_id=0 可写；同键改目标色是**覆盖**不是插第二行', () => {
  const black = md.resolveColorId('黑色');
  const navy = md.resolveColorId('藏青');
  md.setColorAlias({ aliasKey: '5', aliasRaw: '5', colorId: black });
  const list = md.colorAliasList(0);
  assert.strictEqual(list.length, 1, '全局别名只该有 1 行');
  assert.strictEqual(list[0].productId, 0);
  assert.strictEqual(list[0].aliasKey, '5');
  assert.strictEqual(list[0].colorId, black);

  md.setColorAlias({ aliasKey: '5', aliasRaw: '5(黑)', colorId: navy });
  const list2 = md.colorAliasList(0);
  assert.strictEqual(list2.length, 1, '唯一键 (product_id, alias_key) 必须挡住第二行');
  assert.strictEqual(list2[0].colorId, navy, '同键应覆盖目标色');
  assert.strictEqual(list2[0].aliasRaw, '5(黑)', '原文标签也要跟着更新');
});

check('款级别名：productId>0 同时看到款级 + 全局；查全局不串入别款的覆盖', () => {
  const black = md.resolveColorId('黑色');
  const navy = md.resolveColorId('藏青');
  // 款 7 把平台色 5 覆盖成黑色（同一平台码在不同款可以是不同色 —— 这正是"先款级"的原因）
  md.setColorAlias({ productId: 7, aliasKey: '5', aliasRaw: '5', colorId: black });
  const forSeven = md.colorAliasList(7);
  assert.ok(
    forSeven.some((a) => a.productId === 7 && a.aliasKey === '5' && a.colorId === black),
    '款 7 应看到自己的覆盖',
  );
  assert.ok(
    forSeven.some((a) => a.productId === 0 && a.aliasKey === '5' && a.colorId === navy),
    '款 7 也应看到全局行（款级只是覆盖，不是屏蔽）',
  );
  const forOther = md.colorAliasList(8);
  assert.ok(
    !forOther.some((a) => a.productId === 7),
    '款 8 不许看到款 7 的覆盖（款级别名是专款专用的）',
  );
  assert.ok(forOther.some((a) => a.productId === 0), '但全局行对所有款都可见');
});

check('拒绝写不存在的目标色；删款级别名不误删全局行', () => {
  assert.throws(() => md.setColorAlias({ aliasKey: '9', colorId: 0 }), /目标颜色不存在/);
  assert.throws(() => md.setColorAlias({ aliasKey: '9', colorId: 999 }), /目标颜色不存在/);
  assert.throws(() => md.setColorAlias({ aliasKey: '   ', colorId: 1 }), /别名不能为空/);

  const removed = md.deleteColorAlias(7, '5');
  assert.strictEqual(removed.removed, 1, '款级行应被删掉');
  const globalRows = md.colorAliasList(0).filter((a) => a.aliasKey === '5');
  assert.strictEqual(globalRows.length, 1, '删款级不许连全局一起删');
  assert.strictEqual(md.deleteColorAlias(7, '5').removed, 0, '再删一次是空操作（幂等）');
});

// ────────────────────────────────────────────────────────── [8] 播种语义
console.log('\n[8] 播种：幂等早退 + 清库后自愈');
check('第二次 ensure 不重复写字典（否则每次启动都写 38 行 WAL）；也不动用户新建的色', () => {
  const colors = countOf('md_colors');
  const sizes = countOf('md_sizes');
  const customId = md.resolveColorId('自定义色');
  assert.ok(customId > 0);
  md.ensureMasterDataSchema();
  md.ensureMasterDataSchema();
  assert.strictEqual(countOf('md_colors'), colors);
  assert.strictEqual(countOf('md_sizes'), sizes);
  assert.strictEqual(md.resolveColorId('自定义色'), customId, '早退不许清掉用户色');
});

check('`md_*` 被清空（reset-dev-data）后种子自己回来 —— 否则用户看到的是"下拉空了"而不是"库被重置过"', () => {
  dbRun(`DELETE FROM md_colors`);
  dbRun(`DELETE FROM md_sizes`);
  assert.strictEqual(countOf('md_colors'), 0);
  md.ensureMasterDataSchema();
  assert.strictEqual(
    countOf('md_colors'),
    seedColors,
    `颜色种子没回来（清库前后应恰好是词表长度）：${countOf('md_colors')} vs ${seedColors}`,
  );
  assert.strictEqual(
    countOf('md_sizes'),
    seedSizes,
    `尺码种子没回来：${countOf('md_sizes')} vs ${seedSizes}`,
  );
  assert.ok(md.resolveColorId('黑色') > 0);
  assert.ok(md.resolveSizeId('M') > 0);
  // 别名的 color_id 是 ON DELETE CASCADE：颜色行没了，别名必须先被级联删掉，
  // 不许留成指向不存在颜色的悬空引用（否则"平台色 5 → 某色"会在下次查询时静默错解）。
  assert.strictEqual(countOf('md_color_aliases'), 0, '清颜色后别名应被级联删除');
  const dangling = Number(
    dbGet(
      `SELECT COUNT(*) AS n FROM md_color_aliases a
       WHERE a.color_id NOT IN (SELECT id FROM md_colors)`,
    ).n,
  );
  assert.strictEqual(dangling, 0, '别名不许残留悬空的 color_id');
});

// ────────────────────────────────────────────────────────── [9] 旧图表搬迁（一次性）
//
// R1 原定"旧图零迁移"（按「未正式发布、无存量库」），2026-10-30 真库实测有 113 张图 +
// 92 条「图 → 款色」绑定 ⇒ 改成"搬完再拆"。本段就是那段逻辑的回归钉：
// 旧表是**唯一**数据源，搬家顺序错了（先 DROP / 先建列）就会静默丢数据。
console.log('\n[9] 旧图表搬迁（oi_images / pl_images → md_images）');
check('旧图落进唯一 images/ 目录，订单行与产品行的引用改成本地图 id', () => {
  const { migrateLegacyImages, remapOrderItemImages } = require(
    path.join(ROOT, 'dist', 'electron', 'legacy-image-migration.js'),
  );

  const legacyDir = path.join(tmpDir, 'legacy-images');
  fs.mkdirSync(legacyDir, { recursive: true });
  const mkImage = (tag) => Buffer.concat([PNG_SIG, Buffer.from(tag.repeat(20))]);
  const imgShared = mkImage('shared');
  const imgProduct = mkImage('product');
  const imgColorOld = mkImage('color-old');
  const imgColorNew = mkImage('color-new');
  const imgDangling = mkImage('dangling');
  const writeLegacy = (buf) => {
    const p = path.join(legacyDir, `${sha256(buf)}.png`);
    fs.writeFileSync(p, buf);
    return p;
  };
  const pShared = writeLegacy(imgShared);
  const pProduct = writeLegacy(imgProduct);
  const pOld = writeLegacy(imgColorOld);
  const pNew = writeLegacy(imgColorNew);
  const pDangling = writeLegacy(imgDangling);

  // 旧形状夹具（列只取迁移真会读的那几个；识别流水线字段刻意不建 —— 那些已退役）
  dbRun(`CREATE TABLE oi_images (
    id INTEGER PRIMARY KEY, fingerprint TEXT, url_fingerprint TEXT DEFAULT '',
    source_url TEXT DEFAULT '', local_path TEXT, style_color_id INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT ''
  )`);
  dbRun(`CREATE TABLE pl_images (
    id INTEGER PRIMARY KEY, fingerprint TEXT, local_path TEXT
  )`);
  dbRun(`CREATE TABLE oi_style_colors (
    id INTEGER PRIMARY KEY, style_id INTEGER, color TEXT, code TEXT
  )`);
  dbRun(`CREATE TABLE oi_order_items (id INTEGER PRIMARY KEY, image_id INTEGER)`);
  dbRun(`CREATE TABLE pl_products (id INTEGER PRIMARY KEY, image_id INTEGER)`);

  for (let i = 1; i <= 3; i += 1) {
    dbRun(`INSERT INTO oi_style_colors (id, style_id, color, code) VALUES (?,?,?,?)`, [
      i, 1, `色${i}`, `SC-${i}`,
    ]);
  }
  // 501/502：**同内容不同 URL** —— 落盘必须收敛到同一行（这是"按图找色"的前提）
  dbRun(`INSERT INTO oi_images (id, url_fingerprint, local_path) VALUES (501, 'u-501', ?)`, [pShared]);
  dbRun(`INSERT INTO oi_images (id, url_fingerprint, local_path) VALUES (502, 'u-502', ?)`, [pShared]);
  // 503/504：同一个色挂了两张图（真库 8 个色各挂 2–4 张）→ 取 updated_at 最新的一张
  dbRun(`INSERT INTO oi_images (id, local_path, style_color_id, updated_at) VALUES (503, ?, 1, '2026-10-20')`, [pOld]);
  dbRun(`INSERT INTO oi_images (id, local_path, style_color_id, updated_at) VALUES (504, ?, 1, '2026-10-29')`, [pNew]);
  // 505：指向不存在的款色（脏绑定）→ 跳过，不能因此把整次搬迁搞挂
  dbRun(`INSERT INTO oi_images (id, local_path, style_color_id, updated_at) VALUES (505, ?, 999, '2026-10-30')`, [pDangling]);
  dbRun(`INSERT INTO pl_images (id, local_path) VALUES (601, ?)`, [pProduct]);
  dbRun(`INSERT INTO oi_order_items (id, image_id) VALUES (1, 501), (2, 502)`);
  dbRun(`INSERT INTO pl_products (id, image_id) VALUES (1, 601)`);

  const mdBefore = countOf('md_images');
  const r = migrateLegacyImages();
  // 订单行要等 `oi_order_items` 重建（去外键）之后才改写 —— 与生产链路同一顺序
  remapOrderItemImages(r);
  const mdShared = Number(dbGet(`SELECT id FROM md_images WHERE fingerprint = ?`, [sha256(imgShared)]).id);
  const mdProduct = Number(dbGet(`SELECT id FROM md_images WHERE fingerprint = ?`, [sha256(imgProduct)]).id);
  const mdNew = Number(dbGet(`SELECT id FROM md_images WHERE fingerprint = ?`, [sha256(imgColorNew)]).id);

  assert.ok(mdShared > 0 && mdProduct > 0 && mdNew > 0, '三张代表图都应登记进 md_images');
  assert.strictEqual(countOf('md_images') - mdBefore, 5, '6 行旧图 → 5 行（其中两行同内容合并）');
  assert.strictEqual(r.landed, 6, `landed 应覆盖每一次旧行（含复用）：${r.landed}`);
  assert.strictEqual(r.skipped, 0);

  const landedPath = String(dbGet(`SELECT local_path FROM md_images WHERE id = ?`, [mdShared]).local_path);
  assert.ok(landedPath.indexOf(path.join(tmpDir, 'images')) === 0, `必须落在唯一的 images/：${landedPath}`);
  assert.ok(fs.existsSync(landedPath), '落盘文件应真实存在（不是只写库）');

  const orderIds = dbQuery(`SELECT image_id FROM oi_order_items ORDER BY id`).map((x) => Number(x.image_id));
  assert.deepStrictEqual(orderIds, [mdShared, mdShared], '两行订单图都改成本地图 id（同内容收敛到一张）');
  assert.strictEqual(r.remappedOrderItems, 2);
  assert.strictEqual(Number(dbGet(`SELECT image_id FROM pl_products WHERE id = 1`).image_id), mdProduct);

  assert.deepStrictEqual(
    r.bindings.map((b) => ({ sc: b.styleColorId, img: b.imageId })),
    [{ sc: 1, img: mdNew }],
    '一个色只留一张代表图，取 updated_at 最新的那张',
  );
  assert.strictEqual(r.droppedBindings, 1, '同色第二张图应记入"省掉"（旧图保留为普通图片）');
  assert.strictEqual(r.danglingBindings, 1, '指向不存在款色的绑定要跳过并计数');

  // 幂等：再跑一次不新增图片行（旧表还在时才可能重跑）
  const mdAgain = countOf('md_images');
  const r2 = migrateLegacyImages();
  remapOrderItemImages(r2);
  assert.strictEqual(countOf('md_images'), mdAgain, '重跑不许再落第二份字节');
  assert.strictEqual(r2.remappedOrderItems, 0, '已改写的引用不该再命中旧 id');
});

// ────────────────────────────────────────────────────────── [10] 颜色合并
//
// 2026-10-30 用户口径：「存在相同的颜色，只是名称不一样，要支持颜色合并」。
// 合并必须**真正改写业务数据**（款色 / SKU / 别名都归到保留色），不是只记一条别名 ——
// 这条冒烟就是那段改写的回归钉：三域各造一行，验"改指 / 删行 / 只补空 / code 不动"。
//
// 用**新的库文件**：上面 [9] 为了验旧图搬迁建了几张"旧形状"的 oi_* 表，
// 与真实 schema 不兼容（`CREATE TABLE IF NOT EXISTS` 不会补列），不能在同一库里跑合并。
console.log('\n[10] 颜色合并（跨域改写）');
closeDb();
initDb(path.join(tmpDir, 'merge.db'));
const orderDb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const productDb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
const colorMerge = require(path.join(ROOT, 'dist', 'electron', 'color-merge.js'));
orderDb.ensureOrderSchema();
productDb.ensureProductSchema();
// SKU 子表（pl_variants）在**另一个**入口 `ensureVariantSchema` 建（与 ensureProductSchema 同挂载点）
productDb.ensureVariantSchema();

const srcColorId = md.ensureColorId('深蓝').id;
const tgtColorId = md.ensureColorId('藏青').id;
assert.ok(srcColorId > 0 && tgtColorId > 0 && srcColorId !== tgtColorId, '两个色都得在字典里');
// 字典级平台色别名先指向源色 —— 合并后必须改指保留色（否则下次导入还落回源色）
md.setColorAlias({ aliasKey: 'dye-blue', aliasRaw: 'DYE BLUE', colorId: srcColorId });

check('颜色板：字典 ∪ 业务表色名，带用量；数字色号标 numeric（只能当源）', () => {
  // 款色：款 1 有两种色（源 + 保留），款 2 只有源色 ⇒ 源的 styles = 2
  dbRun(`INSERT INTO oi_styles (id, code, fingerprint) VALUES (1,'S1','fp-s1'),(2,'S2','fp-s2')`);
  dbRun(`INSERT INTO oi_style_colors (id, style_id, color, code, image_id) VALUES
    (11,1,'深蓝','SC-11',222),
    (12,1,'藏青','SC-12',0),
    (13,2,'深蓝','SC-13',0)`);
  // 订单行：21 指源色（同款已有保留色 ⇒ 应改指 12）、22 指款 2 的源色（款 2 会改名）、
  // 23 指保留色（不该被碰）
  dbRun(`INSERT INTO oi_orders (id, order_no) VALUES (1,'O-1')`);
  dbRun(`INSERT INTO oi_order_items (id, order_id, raw_fields, style_color_id) VALUES
    (21,1,'{}',11),(22,1,'{}',13),(23,1,'{}',12)`);
  dbRun(`INSERT INTO oi_variant_keys (variant_key, style_color_id) VALUES ('k1',11),('k2',13)`);
  dbRun(`INSERT INTO oi_item_parts (order_item_id, role, style_color_id) VALUES (21,'上衣',11)`);
  dbRun(`INSERT INTO oi_color_aliases (product_id, alias_key, alias_raw, color) VALUES (7,'5','5','深蓝')`);
  // SKU：产品 1 已有「藏青 M」（保留行，克重/编码都空）⇒ 源行**并掉**；
  //      产品 1 的「深蓝 L」没有撞名 ⇒ **改名**；产品 2 的平台数字色「5」是只用来验 numeric 的
  dbRun(`INSERT INTO pl_variants (id, product_id, code, name, color, size, weight_g) VALUES
    (31,1,'','藏青 M','藏青','M',0),
    (32,1,'SRC-1','深蓝 M','深蓝','M',150),
    (33,1,'SRC-2','深蓝 L','深蓝','L',0),
    (34,2,'','5 M','5','M',0)`);

  const board = colorMerge.colorBoard().rows;
  const byName = new Map(board.map((r) => [r.name, r]));
  assert.ok(byName.has('深蓝') && byName.has('藏青'), '颜色板必须列出业务表里的色名（不只字典）');
  assert.strictEqual(byName.get('深蓝').styles, 2, '深蓝用在 2 个款上');
  assert.strictEqual(byName.get('深蓝').skus, 2, '深蓝有 2 个 SKU');
  assert.strictEqual(byName.get('深蓝').orders, 2, '指向深蓝的订单行有 2 条');
  assert.ok(byName.get('深蓝').colorId > 0, '深蓝已进字典');
  assert.strictEqual(byName.get('5').numeric, true, '数字色号必须标 numeric（界面禁止它当保留名）');
  assert.strictEqual(byName.get('5').inDict, false, '数字色号不在字典里');
});

check('合并：改指 / 改名 / 删行 / 只补空 一次到位，code 一律不动', () => {
  const out = colorMerge.mergeColors('深蓝', '藏青');
  assert.strictEqual(out.source, '深蓝');
  assert.strictEqual(out.target, '藏青');
  assert.strictEqual(out.dictRemoved, 1, '源色应从字典删掉');
  assert.strictEqual(out.styleMerged, 1, '同款已有保留色 ⇒ 并掉 1 行');
  assert.strictEqual(out.styleRenamed, 1, '款 2 没有保留色 ⇒ 改名 1 行');
  assert.strictEqual(out.orders, 1, '只有指向源色的那一行订单被改指');
  assert.strictEqual(out.keys, 1);
  assert.strictEqual(out.parts, 1);
  assert.strictEqual(out.skusMerged, 1);
  assert.strictEqual(out.skusRenamed, 1);
  // 1 条既有别名改指 + 1 条新记的全局别名（源 → 保留）
  assert.strictEqual(out.aliases, 2);
});

check('合并后：业务表不再有源色，引用全部落到保留色，code 原样', () => {
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors WHERE color = '深蓝'`).n),
    0,
    '款色里不该再有源色',
  );
  assert.strictEqual(
    String(dbGet(`SELECT color FROM oi_style_colors WHERE id = 13`).color),
    '藏青',
    '没有撞名的款色是改名（code 不变）',
  );
  assert.strictEqual(String(dbGet(`SELECT code FROM oi_style_colors WHERE id = 13`).code), 'SC-13');
  // 并掉的那行：代表图只补空（保留行原来是 0 ⇒ 拿源的 222），code 不动
  const keep = dbGet(`SELECT image_id, code FROM oi_style_colors WHERE id = 12`);
  assert.strictEqual(Number(keep.image_id), 222, '保留行的空图应补上源色的图');
  assert.strictEqual(String(keep.code), 'SC-12', '保留行的 code 不许被改');
  // 引用改指
  assert.deepStrictEqual(
    dbQuery(`SELECT id, style_color_id FROM oi_order_items ORDER BY id`).map((r) => [Number(r.id), Number(r.style_color_id)]),
    [[21, 12], [22, 13], [23, 12]],
  );
  assert.strictEqual(Number(dbGet(`SELECT style_color_id FROM oi_variant_keys WHERE variant_key = 'k1'`).style_color_id), 12);
  assert.strictEqual(Number(dbGet(`SELECT style_color_id FROM oi_item_parts WHERE role = '上衣'`).style_color_id), 12);
  assert.strictEqual(String(dbGet(`SELECT color FROM oi_color_aliases WHERE product_id = 7 AND alias_key = '5'`).color), '藏青');
  // 字典：源色行已删，既有别名改指保留色，另新增一条 源 → 保留
  assert.strictEqual(md.resolveColorId('深蓝'), 0, '源色不该还能解析出 id');
  const aliases = md.colorAliasList(0);
  assert.ok(aliases.some((a) => a.aliasKey === 'dye-blue' && a.colorId === tgtColorId), '既有别名应改指保留色');
  assert.ok(aliases.some((a) => a.aliasKey === '深蓝' && a.colorId === tgtColorId), '应新记一条「深蓝 → 藏青」别名');
  assert.ok(!aliases.some((a) => a.colorId === srcColorId), '不许再有指向源色的别名（ON DELETE CASCADE 兜住）');
  // SKU：撞名并掉（克重/编码只补空），没撞名的改名，code 不动
  const skuKeep = dbGet(`SELECT weight_g, code, name FROM pl_variants WHERE id = 31`);
  assert.strictEqual(Number(skuKeep.weight_g), 150, '保留行的空克重应拿源行的');
  assert.strictEqual(String(skuKeep.code), 'SRC-1', '保留行的空编码应拿源行的（先删源行再写码，否则唯一键冲突）');
  assert.strictEqual(String(skuKeep.name), '藏青 M', '名字不变');
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM pl_variants WHERE id = 32`).n), 0, '源 SKU 应删除');
  const renamed = dbGet(`SELECT color, name, code FROM pl_variants WHERE id = 33`);
  assert.strictEqual(String(renamed.color), '藏青');
  assert.strictEqual(String(renamed.name), '藏青 L', 'name 要跟着色名改（否则同名唯一键与色列漂移）');
  assert.strictEqual(String(renamed.code), 'SRC-2', 'code 不动');
});

check('数字色号可以当源并进真色；合并后再查颜色板，源色已消失', () => {
  const out = colorMerge.mergeColors('5', '藏青');
  assert.strictEqual(out.skusRenamed, 1, '数字色号只有一个 SKU，直接改名');
  assert.strictEqual(String(dbGet(`SELECT name, color FROM pl_variants WHERE id = 34`).color), '藏青');
  assert.ok(!colorMerge.colorBoard().rows.some((r) => r.name === '深蓝'), '合并完颜色板上不该再有源色');
  assert.ok(!colorMerge.colorBoard().rows.some((r) => r.name === '5'), '数字色号并完后也不该还在');
});

check('拒绝路径：空名 / 同一个色 / 数字保留名 / 源不存在 —— 一律在写之前抛', () => {
  assert.throws(() => colorMerge.mergeColors('', '藏青'), /源颜色不能为空/);
  assert.throws(() => colorMerge.mergeColors('藏青', '  '), /保留颜色不能为空/);
  assert.throws(() => colorMerge.mergeColors('藏青', '藏青'), /同一个颜色/);
  assert.throws(() => colorMerge.mergeColors('藏青', '12'), /数字色号不能作为保留色名/);
  assert.throws(() => colorMerge.mergeColors('从不存在的色', '藏青'), /不存在/);
  assert.throws(() => colorMerge.mergeColors('深蓝', '藏青'), /不存在/, '已并过的源色不能再并一次');
});

closeDb();
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n' + '\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 主数据域冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log('\u2713 主数据域冒烟全部通过\n');
process.exit(0);
