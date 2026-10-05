// 「拿货单导出 xlsx」handler 冒烟（宿主层，真 handler + 真 exceljs，不启动界面）。
//
//   npm run purchase:xlsx:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/purchase-xlsx-smoke.cjs
//   # 环境里有 ELECTRON_RUN_AS_NODE=1（CI/沙箱常见）时：env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/purchase-xlsx-smoke.cjs
//
// 为什么要有这个脚本（2026-10-05）：
//   `purchase-export-excel` 的**调用点**此前零覆盖 —— `scripts/` 下没有任何脚本 require 过
//   `purchase-handlers`。而它当时与「拣货单导出」**共享同一个真 bug**：
//   `wb.addImage({ filename })` 忘给 `extension` ⇒ 写出 `xl/media/image1.undefined` +
//   `<Default ContentType="image/undefined"/>` ⇒ **包结构不合法**，Excel 提示"需要修复"并丢图。
//   修法已抽进 `electron/xlsx-image.ts`（`picking:xlsx:smoke` 覆盖了那个纯函数），
//   但"这个 handler 到底有没有真的调它、行有没有对、金额有没有算错"**只能在调用点验**。
//
// 与 `picking:xlsx:smoke.cjs` 的分工：
//   · `picking-xlsx-smoke`  = 纯生成层（`buildPickingWorkbook` / `splitBySupplier` / `safeSheetName`）
//   · 本脚本                = **handler 调用点**（入参清洗 / 金额口径 / 查图 / 嵌图 / 落盘 / 取消分支）
//
// 覆盖的不变量：
//   · 入参护栏：非对象 payload / items 非数组 → `invalid payload`；洗完没行 → `没有可导出的行`；
//   · **取消保存 → 一个字节都不写**（不是"写了再删"）；
//   · 金额口径：`单价 = priceCents/100`；`金额 = 数量 × 单价`（两位）；`priceCents===0` → 留空；
//     `qty===0` → 实拿数量与金额都留空（0 件 ≠ 尚未填数）；
//   · 查图只在 `款编码 且 款色` 都非空时发生（空款色照常导表，只是没图）；
//   · **嵌图走 filePath 源 → 媒体扩展名跟着内容**（内容是 PNG、文件名却是 `.jpg` 的那张必须是 `imageN.png`，
//     这正是"忘给 extension"那条 bug 的指纹；base64 源恒为 jpeg，所以扩展名是 png 就证明走的是文件源分支）；
//   · 单张坏图（内容认不出）**不阻断整表导出**，只是那一行没图；
//   · 产物 `[Content_Types].xml` 有 `image/png` 且**没有 `undefined`**；有 drawing 部件（否则 Excel 不显示图）；
//   · `defaultName` 里的 `\ / : * ? " < > |` 被替换成 `_`，扩展名固定 `.xlsx`；
//   · `payload.items` 超 500 行时**截前 500**（剪的是入参，不是洗后的行）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const realElectron = require('electron');

// 早退护栏：`ELECTRON_RUN_AS_NODE=1` 时 `require('electron')` 只是个字符串路径 ——
// 那时 `Module._load` 的替身会把一个字符串喂给 `ipc-util`，报的是不知所云的
// "Cannot read properties of undefined (reading 'handle')"。这里直接说清怎么跑。
// （顺带：本脚本虽然不需要 nativeImage，但 require 链里有 better-sqlite3（Electron ABI），
//  所以**必须**真 Electron，不能退回系统 Node —— 见 AGENTS.md「冒烟一律用 electron」。）
if (!process.versions || !process.versions.electron || !realElectron || !realElectron.ipcMain) {
  console.error(
    '\u2717 本冒烟必须用**真 Electron** 运行（require 链里有 better-sqlite3，Electron ABI）。\n' +
      '  npm run purchase:xlsx:smoke\n' +
      '  若环境里带 ELECTRON_RUN_AS_NODE=1（CI/沙箱常见），去掉它再跑：\n' +
      '  env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/purchase-xlsx-smoke.cjs',
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-purchase-xlsx-'));

/* ---- electron 替身：只换四件（ipcMain / dialog / BrowserWindow / app），其余保持真实 ---- */
const handlers = new Map();
const saveDialogOpts = [];
let savePath = '';
let saveCanceled = false;

const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  on: () => {},
  removeHandler: (channel) => handlers.delete(channel),
};
const fakeDialog = {
  // 真实签名是 (window, options) 或 (options) —— 这里按"最后一个参数是 options"取
  showSaveDialog: async (...args) => {
    saveDialogOpts.push(args[args.length - 1]);
    return saveCanceled ? { canceled: true, filePath: undefined } : { canceled: false, filePath: savePath };
  },
};
const fakeBrowserWindow = {
  // 无窗口 → handler 走 `showSaveDialog(dialogOpts)` 单参分支（真实场景：冒烟/无焦点窗口）
  getFocusedWindow: () => null,
  getAllWindows: () => [],
};
const fakeApp = { getPath: () => dir };

const fakeElectron = new Proxy(realElectron, {
  get(target, prop) {
    if (prop === 'ipcMain') return fakeIpcMain;
    if (prop === 'dialog') return fakeDialog;
    if (prop === 'BrowserWindow') return fakeBrowserWindow;
    if (prop === 'app') return fakeApp;
    return target[prop];
  },
});
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, [request, ...rest]);
};

/* ---- 素材：真图 + 一张"内容是 PNG、名字是 .jpg"的存量形态 + 一张非图 ---- */
const PNG_AS_JPG = path.join(dir, 'tricky.jpg'); // 内容 PNG，名字 .jpg（存量真实形态）
fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), PNG_AS_JPG);
const REAL_PNG = path.join(dir, 'real.png');
fs.copyFileSync(path.join(ROOT, 'build', 'icons', 'png', '64x64.png'), REAL_PNG);
const NOT_IMAGE = path.join(dir, 'plain.txt');
fs.writeFileSync(NOT_IMAGE, '这不是图片');

// 真 handler（注册进 fakeIpcMain）+ 真 order-db（只把"查图"这一个口换成可控映射）
require(path.join(ROOT, 'dist', 'electron', 'purchase-handlers.js'));
const orderDb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));

/** 款色 → 本地图路径（`purchase-handlers` 里的 `orderDb` 与本模块是**同一个 exports 对象**，改属性即可生效） */
const IMG_MAP = {
  'S1|黑': PNG_AS_JPG,
  'S2|白': REAL_PNG,
  'S4|灰': NOT_IMAGE, // 命中但内容不是图 → 这一行没图，整表照常导出
};
orderDb.findStyleColorImagePath = (code, color) => IMG_MAP[`${String(code)}|${String(color)}`] ?? null;

const call = (payload) => handlers.get('purchase-export-excel')(null, payload);

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}
function section(t) {
  console.log('\n' + t);
}

/** 一行业务数据（默认：有价、有量、有款色 ⇒ 会去查图） */
const item = (over = {}) => ({
  styleCode: 'S1',
  styleName: '黑T',
  color: '黑',
  size: 'L',
  suggestionQty: 3,
  qty: 5,
  priceCents: 1250,
  ...over,
});

const HEAD = ['图片', '款编码', '款式名', '款色', '尺码', '建议数量', '实拿数量', '单价(元)', '金额(元)'];

async function main() {
  console.log('拿货单导出 xlsx 冒烟（handler 调用点）\n');

  const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
  const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));

  section('准备');
  await check('`purchase-export-excel` 已注册（此前整条调用点零覆盖）', () => {
    assert.strictEqual(typeof handlers.get('purchase-export-excel'), 'function');
  });

  section('① 入参护栏');
  await check('not a plain object → invalid payload', async () => {
    assert.strictEqual((await call(null)).error, 'invalid payload');
    assert.strictEqual((await call('x')).error, 'invalid payload');
    assert.strictEqual((await call([])).error, 'invalid payload');
  });
  await check('items 不是数组 → invalid payload', async () => {
    assert.strictEqual((await call({ items: 'x' })).error, 'invalid payload');
    assert.strictEqual((await call({ items: undefined })).error, 'invalid payload');
  });
  await check('洗完一行不剩（既无款编码也无款名）→ 没有可导出的行', async () => {
    const r = await call({ items: [{}, { styleCode: '', styleName: '' }, { color: '黑', qty: 3 }] });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, '没有可导出的行');
  });

  section('② 取消保存：一个字节都不写');
  saveCanceled = true;
  savePath = path.join(dir, 'should-not-exist.xlsx');
  await check('取消 → {success:false, error:"__canceled__"}', async () => {
    const r = await call({ items: [item()] });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, '__canceled__');
  });
  await check('取消时输出目录里**一个 .xlsx 都没多出来**（不是"先写了再删"、也不是写到某个默认路径）', () => {
    const xlsxFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.xlsx'));
    assert.deepStrictEqual(xlsxFiles, [], `不该有任何产物，实际 ${xlsxFiles.join(', ')}`);
  });
  saveCanceled = false;

  section('③ 正常导出：落盘 + 文件名清洗');
  const OUT = path.join(dir, 'purchase.xlsx');
  savePath = OUT;
  saveDialogOpts.length = 0;
  const HAPPY = [
    item({ styleCode: 'S1', styleName: '黑T', color: '黑', size: 'L', suggestionQty: 3, qty: 5, priceCents: 1250 }),
    item({ styleCode: 'S2', styleName: '白T', color: '白', size: 'M', suggestionQty: 0, qty: 2, priceCents: 0 }),
    item({ styleCode: 'S3', styleName: '灰裤', color: '', size: 'XL', suggestionQty: 1, qty: 1, priceCents: 500 }),
    item({ styleCode: 'S4', styleName: '蓝衣', color: '灰', size: 'S', suggestionQty: 2, qty: 0, priceCents: 500 }),
    item({ styleCode: '', styleName: '只填了款名', color: '黑', size: '', suggestionQty: 0, qty: 1, priceCents: 800 }),
  ];
  const res = await call({ items: HAPPY, defaultName: '拿货单:日报/2026*10?' });
  await check('返回 {success:true, data.filePath}', () => {
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.filePath, OUT);
  });
  await check('文件真的落盘且是合法 zip（PK 魔数）', () => {
    assert.ok(fs.existsSync(OUT));
    const buf = fs.readFileSync(OUT);
    assert.strictEqual(buf.slice(0, 2).toString('latin1'), 'PK');
    assert.ok(buf.length > 2000, `字节数太小（${buf.length}）`);
  });
  await check('defaultName 里的 \\ / : * ? " < > | 全被换成 _，扩展名固定 .xlsx', () => {
    const opts = saveDialogOpts.at(-1);
    assert.ok(opts && opts.defaultPath, 'showSaveDialog 没被调用');
    assert.strictEqual(path.basename(opts.defaultPath), '拿货单_日报_2026_10_.xlsx');
  });

  const buf = fs.readFileSync(OUT);
  const zip = await JSZip.loadAsync(buf);
  // ⚠️ zip 里 `xl/media/` 是**目录项**，不过滤会把它当成一张图数进去
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));

  section('④ 表结构');
  await check('只有一张工作表，名字是「拿货单」', async () => {
    const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.strictEqual(sheets.length, 1, `工作表数应为 1，实际 ${sheets.length}`);
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    assert.ok(/name="拿货单"/.test(wbXml), 'workbook.xml 里没有「拿货单」');
  });

  section('⑤ 嵌图：filePath 源 ⇒ 扩展名跟着**内容**');
  const media = names.filter((n) => /^xl\/media\//.test(n));
  await check('媒体条数 = 查图命中"真图"的行数（S1 + S2 = 2）', () => {
    assert.strictEqual(media.length, 2, `xl/media 条数应为 2，实际 ${media.length}（${media.join(', ')}）`);
  });
  await check('媒体名是 imageN.png —— **内容是 PNG、文件名却叫 .jpg** 的那张也必须是 png', () => {
    assert.ok(
      media.every((n) => /\.png$/.test(n)),
      `媒体部件名应为 imageN.png，实际 ${media.join(', ')}`,
    );
  });
  await check('没有 imageN.undefined（"忘给 extension"那条真 bug 的指纹）', () => {
    assert.ok(!media.some((n) => /undefined/.test(n)), media.join(', '));
  });
  await check('扩展名是 png 就证明走的是**文件源**分支（base64 源恒为 jpeg）', () => {
    // 反证：若 handler 改成传 base64，这里会全是 .jpeg
    assert.ok(media.length > 0 && media.every((n) => /\.png$/.test(n)));
  });
  await check('有 drawing 部件（缺了图不会被 Excel 显示）', () => {
    assert.ok(names.some((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n)));
  });
  await check('[Content_Types].xml 声明 image/png 且不含 undefined（包结构合法性）', async () => {
    const ct = await zip.file('[Content_Types].xml').async('string');
    assert.ok(/ContentType="image\/png"/.test(ct), `没有 image/png：${ct.slice(0, 300)}`);
    assert.ok(!/undefined/.test(ct), `出现 undefined：${ct.slice(0, 300)}`);
  });

  section('⑥ 读回数值（口径一个都不能错）');
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  const ws = back.getWorksheet('拿货单');
  const cell = (r, c) => ws.getRow(r).getCell(c).value;
  await check('表头就是 HEAD（9 列）', () => {
    HEAD.forEach((h, i) => assert.strictEqual(cell(1, i + 1), h, `第 ${i + 1} 列表头`));
  });
  await check('行数 = 表头 + 5（空行被滤掉、只填款名的行要留下）', () => {
    assert.strictEqual(ws.rowCount, 6, `rowCount=${ws.rowCount}`);
  });
  await check('S1：单价 = 分/100、金额 = 数量 × 单价、建议/实拿数量原样', () => {
    assert.strictEqual(cell(2, 2), 'S1');
    assert.strictEqual(cell(2, 4), '黑');
    assert.strictEqual(cell(2, 5), 'L');
    assert.strictEqual(cell(2, 6), 3, '建议数量');
    assert.strictEqual(cell(2, 7), 5, '实拿数量');
    assert.strictEqual(cell(2, 8), 12.5, '单价');
    assert.strictEqual(cell(2, 9), 62.5, '金额');
  });
  await check('priceCents=0 → 单价/金额都**留空**（不是 0.00 —— 0 会被读成"这件免费"）', () => {
    assert.strictEqual(cell(3, 7), 2, '实拿数量照常有');
    assert.strictEqual(cell(3, 8), null, '单价应为空');
    assert.strictEqual(cell(3, 9), null, '金额应为空');
  });
  await check('款色为空的行照常导出（只是不去查图）', () => {
    assert.strictEqual(cell(4, 2), 'S3');
    assert.ok(!cell(4, 4), `款色应为空，实际 ${JSON.stringify(cell(4, 4))}`);
    assert.strictEqual(cell(4, 8), 5, '单价');
    assert.strictEqual(cell(4, 9), 5, '金额');
  });
  await check('qty=0 → 实拿数量与金额都留空（0 件 ≠ 尚未填数）', () => {
    assert.strictEqual(cell(5, 7), null, '实拿数量应为空');
    assert.strictEqual(cell(5, 8), 5, '单价照常');
    assert.strictEqual(cell(5, 9), null, '金额应为空');
  });
  await check('只填款名的行不丢（filter 认款名）——且它没有图（无款编码就不查图）', () => {
    assert.strictEqual(cell(6, 3), '只填了款名');
    assert.ok(!cell(6, 2), '款编码应为空');
  });
  await check('有图的行设了行高（证明布局真的应用了，不只是"加了张图"）', () => {
    const h2 = ws.getRow(2).height;
    const h4 = ws.getRow(4).height; // 无图那行
    assert.ok(typeof h2 === 'number' && h2 > 0, `有图行应有行高，实际 ${JSON.stringify(h2)}`);
    assert.ok(!h4 || h4 <= 0, `无图行不该被设高，实际 ${JSON.stringify(h4)}`);
  });

  section('⑦ 500 行上限（剪的是入参，不是洗后的行）');
  const OUT2 = path.join(dir, 'cap.xlsx');
  savePath = OUT2;
  const many = [];
  for (let i = 0; i < 501; i++) many.push({ styleCode: 'C' + i, qty: 1, priceCents: 100 });
  await call({ items: many });
  const back2 = new ExcelJS.Workbook();
  await back2.xlsx.load(fs.readFileSync(OUT2));
  const ws2 = back2.getWorksheet('拿货单');
  await check('超 500 行只导前 500（表头 + 500）', () => {
    assert.strictEqual(ws2.rowCount, 501, `rowCount=${ws2.rowCount}`);
  });
  await check('被截掉的是第 501 行：C499 是末行、C500 不在表里', () => {
    assert.strictEqual(ws2.getRow(501).getCell(2).value, 'C499');
    let hasC500 = false;
    for (let r = 2; r <= ws2.rowCount; r++) if (ws2.getRow(r).getCell(2).value === 'C500') hasC500 = true;
    assert.strictEqual(hasC500, false, 'C500（第 501 行）不该出现在表里');
  });

  console.log('');
  if (failed > 0) console.log(`\u2717 拿货单导出 xlsx 冒烟失败：${failed} 项`);
  else console.log('\u2713 拿货单导出 xlsx 冒烟全部通过');
  // ⚠️ **只允许一处 `process.exit`**：在同一段流程里先 exit(1) 再 exit(0) 会让两次 log 都打印
  // 而退出码是 0（真 Electron 实测，2026-10-05）—— 失败的冒烟报"红"却以成功退出，门禁假绿。
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log(`\u2717 冒烟自身异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
