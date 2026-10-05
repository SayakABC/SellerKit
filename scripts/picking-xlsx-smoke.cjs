// 「拣货单带图 xlsx」生成冒烟（宿主层，不启动界面）。
//
//   npm run picking:xlsx:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/picking-xlsx-smoke.cjs
//
// 为什么单独一个、且**必须跑真 Electron**：
//   带图导出的风险全在"图**真的**进没进 zip"和"行**真的**分到了对的表里" ——
//   这两条在假桥冒烟里**结构上验不到**（那边主进程根本没跑，只能断言"传了什么过去"）。
//   而 exceljs 的嵌图失败是**静默**的：图宽算错、文件不存在、**忘给 extension**，
//   全都只是"图没了"，导出照样成功、打开照样有张能用的表 —— 于是没人会发现。
//   所以这里把产物当 zip 拆开，既数 `xl/media/` 的条数，也**看媒体部件的扩展名**。
//
// ---- 本脚本抓到的第一个真 bug（2026-10-05，拿货单导出同源）----
//   `wb.addImage({ filename })` **不给 `extension`** 时，exceljs 写出的是
//   `xl/media/image1.undefined` + `[Content_Types].xml` 里 `<Default ContentType="image/undefined"/>`
//   （`Extension` 属性直接空掉）。按 OPC 规范**每个 part 都必须有内容类型** ⇒ 包结构不合法，
//   Excel 会提示"需要修复"并丢掉图。而这一切在导出成功的返回值里**看不出来**。
//
// 覆盖的不变量：
//   · `splitBySupplier`：按厂家切表且**保持传入顺序**；未指定厂家（''）**不会**混进任何厂家的表；
//   · `safeSheetName`：Excel 表名限制（≤31 字符、不含 `[]:*?/\`），空 → 兜底名；
//   · xlsx 是合法 zip（PK 魔数）且**真的有 `xl/media/image*.jpeg`**（每个有图的行一张）；
//   · **一个厂家一张 sheet**，且各表的数值来自**各自的行**（不是同一批数据复制两份）；
//   · 每张表末尾有「合计」行，且合计 = 本表各行的和；
//   · 无进价的行**留空**（读回来必须是 null，不是 0）；
//   · 文件源（拿货单那条链）的**扩展名按内容推**：内容是 PNG 但文件名是 `.jpg` → 媒体名必须是 `.png`；
//     内容是 WebP → `.webp`；内容认不出 → 不嵌图也不抛。
//
// 图用仓库自带的真图（`build/icon.png`、`build/icons/png/64x64.png`）—— 造假文件会让
// "按原始比例算显示高度"这条路径永远测不到。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-picking-xlsx-'));

const xlsx = require(path.join(ROOT, 'dist', 'electron', 'picking-xlsx.js'));
const ximg = require(path.join(ROOT, 'dist', 'electron', 'xlsx-image.js'));
const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));

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

// 一份 PNG（内容）故意命名为 `.jpg` —— 存量真实数据里就有"内容是 WebP、名字是 .jpg"的图，
// 扩展名必须按**内容**推，不能按文件名推。
const PNG_FILE = path.join(ROOT, 'build', 'icon.png');
const PNG_AS_JPG = path.join(dir, 'tricky.jpg');
const PNG_B = path.join(dir, 'b.png');
fs.copyFileSync(PNG_FILE, PNG_AS_JPG);
fs.copyFileSync(path.join(ROOT, 'build', 'icons', 'png', '64x64.png'), PNG_B);
// 假 WebP：只造文件头（RIFF....WEBP）—— 本用例验的是"扩展名跟着**内容**走"，不是解码
const FAKE_WEBP = path.join(dir, 'fake.webp');
fs.writeFileSync(
  FAKE_WEBP,
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 7)]),
);
const NOT_IMAGE = path.join(dir, 'plain.txt');
fs.writeFileSync(NOT_IMAGE, '这不是图片');
const MISSING = path.join(dir, 'not-here.png');

/** 渲染层产出的图（base64 分支）：1×1 的 JPEG，宽高由渲染层给出 */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const IMG = { base64: TINY_JPEG_BASE64, width: 160, height: 160 };

/** 一行导出的构造器（默认有价、有图） */
const row = (over = {}) => ({
  supplierName: '厂A',
  styleCode: 'S1',
  color: '黑',
  size: 'L',
  pieces: 1,
  orders: 1,
  unitPrice: 10,
  amount: 10,
  gaps: '',
  image: IMG,
  ...over,
});

async function main() {
  console.log('拣货单带图 xlsx 冒烟\n');

  await check('splitBySupplier：按厂家切段且保持传入顺序', () => {
    const parts = xlsx.splitBySupplier([
      row({ supplierName: '厂A' }),
      row({ supplierName: '厂B', color: '白' }),
      row({ supplierName: '厂A', color: '灰' }),
      row({ supplierName: '' }),
    ]);
    assert.deepStrictEqual(parts.map((p) => p.supplierName), ['厂A', '厂B', '']);
    assert.deepStrictEqual(parts.map((p) => p.rows.length), [2, 1, 1]);
  });

  await check('splitBySupplier：未指定厂家自成一表，不混进任何厂家', () => {
    const parts = xlsx.splitBySupplier([row({ supplierName: '厂A' }), row({ supplierName: '', color: '白' })]);
    assert.strictEqual(parts.length, 2);
    assert.ok(parts[0].rows.every((r) => r.supplierName === '厂A'));
    assert.ok(parts[1].rows.every((r) => r.supplierName === ''));
  });

  await check('safeSheetName：剥掉 Excel 非法字符并截到 31 字符；空 → 兜底名', () => {
    assert.strictEqual(xlsx.safeSheetName('厂/甲:乙*丙?丁[戊]己\\庚'), '厂_甲_乙_丙_丁_戊_己_庚');
    assert.strictEqual(xlsx.safeSheetName('长'.repeat(40)).length, 31);
    assert.strictEqual(xlsx.safeSheetName('   '), '未指定厂家');
  });

  // ---- 真正的工作簿：厂A 两行（有价、有图）+ 未指定一行（无价、无图）----
  const buf = await xlsx.buildPickingWorkbook([
    row({ styleCode: 'S1', pieces: 17, orders: 3, unitPrice: 12.5, amount: 212.5, image: IMG }),
    row({ styleCode: 'S2', color: '白', pieces: 4, orders: 1, unitPrice: 10, amount: 40, image: IMG }),
    row({ supplierName: '', styleCode: 'S9', pieces: 41, orders: 2, unitPrice: null, amount: null, gaps: '无进价 · 未识别款', image: null }),
  ]);

  await check('产物是合法 zip（PK 魔数）', () => {
    assert.ok(Buffer.isBuffer(buf), '返回的必须是 Buffer');
    assert.strictEqual(buf.slice(0, 2).toString('latin1'), 'PK');
    assert.ok(buf.length > 2000, `字节数太小（${buf.length}）`);
  });

  const zip = await JSZip.loadAsync(buf);
  // ⚠️ zip 里 `xl/media/` 是**目录项**，也会出现在条目列表里 —— 不过滤就会把"1 张图"数成 2
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));

  await check('一个厂家一张 sheet（厂A + 未指定厂家 = 2 张）', async () => {
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    assert.ok(/name="厂A"/.test(wbXml), 'workbook.xml 里没有「厂A」');
    assert.ok(/name="未指定厂家"/.test(wbXml), 'workbook.xml 里没有「未指定厂家」');
    const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.strictEqual(sheets.length, 2, `工作表数应为 2，实际 ${sheets.length}`);
  });

  await check('嵌图媒体**扩展名必须跟着内容**（jpeg）—— 忘给 extension 会写成 image1.undefined', () => {
    const media = names.filter((n) => /^xl\/media\//.test(n));
    assert.strictEqual(media.length, 2, `xl/media 条数应为 2，实际 ${media.length}（${media.join(', ')}）`);
    assert.ok(
      media.every((n) => /\.jpeg$/.test(n)),
      `媒体部件名应为 imageN.jpeg，实际 ${media.join(', ')}`,
    );
    assert.ok(names.some((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n)), '缺 drawing 部件 —— 图不会被 Excel 显示');
  });

  await check('[Content_Types].xml 给 image/jpeg 声明了内容类型（包结构合法性）', async () => {
    const ct = await zip.file('[Content_Types].xml').async('string');
    assert.ok(/ContentType="image\/jpeg"/.test(ct), `内容类型里没有 image/jpeg：${ct.slice(0, 400)}`);
    assert.ok(!/undefined/.test(ct), `内容类型里出现了 undefined：${ct.slice(0, 400)}`);
  });

  // ---- 读回来验数值（比在 XML 里正则扫数字准：'' 与 0、共享字符串下标都会骗过字符串匹配）----
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  const sheetNames = back.worksheets.map((w) => w.name);
  const wsA = back.getWorksheet('厂A');
  const wsN = back.getWorksheet('未指定厂家');

  await check('读回来的表名与顺序 = 厂A、未指定厂家', () => {
    assert.deepStrictEqual(sheetNames, ['厂A', '未指定厂家']);
  });

  await check('各表的数来自**各自的行**（不是同一批复制两份）', () => {
    // 列：1 图片 2 款编码 3 款色 4 尺码 5 件数 6 订单数 7 进价 8 金额 9 缺什么
    assert.strictEqual(wsA.getRow(2).getCell(2).value, 'S1');
    assert.strictEqual(wsA.getRow(2).getCell(5).value, 17);
    assert.strictEqual(wsA.getRow(2).getCell(7).value, 12.5);
    assert.strictEqual(wsA.getRow(2).getCell(8).value, 212.5);
    assert.strictEqual(wsA.getRow(3).getCell(5).value, 4);
    assert.strictEqual(wsN.getRow(2).getCell(2).value, 'S9');
    assert.strictEqual(wsN.getRow(2).getCell(5).value, 41);
    assert.notStrictEqual(wsN.getRow(2).getCell(2).value, 'S1', '未指定厂家的表里不该出现厂A 的款');
  });

  await check('无进价的行**留空**（读回来是 null，不是 0 —— 0 会被当成"这件免费"）', () => {
    assert.strictEqual(wsN.getRow(2).getCell(7).value, null, '进价列应为空');
    assert.strictEqual(wsN.getRow(2).getCell(8).value, null, '金额列应为空');
    assert.ok(/无进价/.test(String(wsN.getRow(2).getCell(9).value)), '「缺什么」列要说清为什么没数');
  });

  await check('每张表末尾有「合计」行，且合计 = 本表各行之和', () => {
    for (const [ws, pieces, amount] of [
      [wsA, 17 + 4, 212.5 + 40],
      [wsN, 41, null],
    ]) {
      const last = ws.getRow(ws.rowCount);
      assert.strictEqual(last.getCell(2).value, '合计', `${ws.name} 末行不是合计行`);
      assert.strictEqual(last.getCell(5).value, pieces, `${ws.name} 合计件数`);
      assert.strictEqual(last.getCell(8).value, amount, `${ws.name} 合计金额`);
    }
  });

  await check('有图的行才有媒体部件：一行没图 → media 条数随之减少', async () => {
    const b2 = await xlsx.buildPickingWorkbook([row({ image: IMG }), row({ color: '白', image: null })]);
    const z2 = await JSZip.loadAsync(b2);
    const media = Object.keys(z2.files).filter((n) => /^xl\/media\//.test(n) && !n.endsWith('/'));
    assert.strictEqual(media.length, 1, `应只嵌 1 张，实际 ${media.length}`);
  });

  // ---- 文件源（拿货单导出的那条链）：扩展名按内容推 ----
  // ⚠️ 这里断言的是 `wb.media[i].extension` —— 就是 exceljs 写 `xl/media/imageN.<extension>` 与
  //    `[Content_Types].xml` 的 `Extension` 时用的那个值。不给 extension 时它是 `undefined`，
  //    而包结构就此不合法（这正是本脚本抓到的那个 bug）。
  await check('文件源：内容是 PNG 但**文件名是 .jpg** → 扩展名按内容推（png），不是按文件名', () => {
    const h = embedFile(PNG_AS_JPG);
    assert.ok(h !== null, '应当嵌图成功');
    assert.deepStrictEqual(bufExt(), ['png'], `实际 ${JSON.stringify(bufExt())}`);
  });

  await check('文件源：内容是 WebP → 扩展名 webp（Office 2021+ 能显示，不假装成 jpeg）', () => {
    embedFile(FAKE_WEBP);
    assert.deepStrictEqual(bufExt(), ['webp'], `实际 ${JSON.stringify(bufExt())}`);
  });

  await check('文件源：认不出内容 / 文件不存在 → **不嵌图也不抛**（单张坏图不阻断导出）', () => {
    assert.strictEqual(embedFile(NOT_IMAGE), null);
    assert.deepStrictEqual(bufExt(), []);
    assert.strictEqual(embedFile(MISSING), null);
    assert.deepStrictEqual(bufExt(), []);
    assert.strictEqual(embedFile(''), null);
    assert.strictEqual(embedFile(null), null);
  });

  console.log('');
  if (failed > 0) console.log(`\u2717 拣货单 xlsx 冒烟失败：${failed} 项`);
  else console.log('\u2713 拣货单 xlsx 冒烟全部通过');
  // ⚠️ **只允许一处 `process.exit`**。实测（2026-10-05，真 Electron 浏览器进程）：
  // 在 `if (failed>0) { console.log(...); process.exit(1); }` 之后再跟 `console.log('全部通过'); process.exit(0);`
  // 时，**两次 log 都会打印、退出码是 0** —— 失败的冒烟报"红"却以成功退出，门禁假绿。
  // 同一个 `process.exit(1)` 放在顶层同步代码里是正常终止的（探针验过），所以这不是"exit 不能用"，
  // 而是"不要在同一段流程里调第二次 exit"；顺带：`process.exitCode = 1` 在 Electron 下**不会退出**
  // （事件循环不空，实测挂住），必须显式 exit。
  process.exit(failed > 0 ? 1 : 0);
}

// ---- 文件源用例的助手：每次都拿一个**全新的**工作簿，免得媒体在用例之间累加 ----
let _wb = null;
let _ws = null;
function bufWb() {
  _wb = new ExcelJS.Workbook();
  _ws = _wb.addWorksheet('t');
  return _wb;
}
function bufExt() {
  return (_wb && _wb.media ? _wb.media : []).map((m) => String(m.extension));
}
function embedFile(p) {
  bufWb();
  return ximg.embedCellImage(_wb, _ws, 2, p ? { filePath: p } : null, { width: 72, colOff: 0 });
}

main().catch((err) => {
  console.log(`\u2717 冒烟自身异常：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
