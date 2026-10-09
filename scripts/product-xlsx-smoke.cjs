// 「产品库带图 xlsx」往返冒烟（宿主层，不启动界面）。
//
//   npm run product:xlsx:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/product-xlsx-smoke.cjs
//
// 为什么单独一个、且**必须跑真 Electron**：
//   这条链上两个最容易"看着成功、其实错了"的位置都在主进程：
//     ① **写**：图没嵌进去。exceljs 的嵌图失败是**静默**的（文件不存在、内容认不出、
//        忘给 extension → 写出 `xl/media/image1.undefined` 这种不合法的包），
//        导出照样成功、文件照样打开，只是图没了 —— 返回值里看不出来；
//     ② **读**：图归错了行。Excel 的嵌入图是**浮动对象**，按顺序配（第 1 张配第 1 行）
//        会把插行/删行造成的错位全部吃掉且不报错，表现为"图进来了但配错了款"。
//   所以本脚本做两件事：把产物当 zip 拆开数 `xl/media/`，以及**逐行比对字节**（不是比对张数）。
//
// ⚠️ 比对用的是**两张不同的图**：只用一张图的话，"第 2 行的图和第 3 行装反了"永远测不出来。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-product-xlsx-'));

const px = require(path.join(ROOT, 'dist', 'electron', 'product-xlsx.js'));
const ExcelJS = require(path.join(ROOT, 'node_modules', 'exceljs'));
const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}\n      ${err && err.message ? err.message : String(err)}`);
  }
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const PNG_A = path.join(ROOT, 'build', 'icon.png'); // 1898 B
const PNG_B = path.join(ROOT, 'build', 'icons', 'png', '64x64.png'); // 1793 B
const SHA_A = sha(fs.readFileSync(PNG_A));
const SHA_B = sha(fs.readFileSync(PNG_B));

/** 与 `src/lib/productImport.ts` 的 `PRODUCT_EXPORT_HEADERS` 一致（这里写死，改表头时两边都要动） */
const HEADERS = ['款编码', '款式名', '供应商', '图片', '颜色', '尺码', '克重', '状态', '备注'];
const IMAGE_COL = 3;

const row = (code, name, size, imagePath) => ({
  cells: [code, name, '甲', '', '红', size, '120', '启用', ''],
  imagePath: imagePath || '',
});

/** 收集抽出来的字节（真冒烟不落盘：这里要断言的正是"哪一行拿到了哪张图"） */
function collector() {
  const landed = [];
  return {
    landed,
    land: (bytes) => {
      const imageId = 100 + landed.length;
      landed.push({ imageId, bytes });
      return { imageId, localPath: `/fake/${sha(bytes)}.png` };
    },
  };
}

console.log('\n产品库带图 xlsx 往返冒烟（product-xlsx）\n' + '\u2500'.repeat(64));

// ── ① 生成 ───────────────────────────────────────────────────────────────────
async function main() {
let built = null;
await check('生成：3 行数据、其中 2 行带图 → 返回 embedded=2 / imagesFailed=0', async () => {
  built = await px.buildProductWorkbook({
    sheetName: '产品库',
    headers: HEADERS,
    rows: [
      row('P-001', '收纳箱', 'M', PNG_A),
      row('P-002', '收纳袋', 'L', ''), // 没图
      row('P-003', '挂钩', 'S', PNG_B),
    ],
    imageColumn: IMAGE_COL,
  });
  assert.strictEqual(built.embedded, 2, `期望嵌 2 张，实际 ${built.embedded}`);
  assert.strictEqual(built.imagesFailed, 0);
});

await check('产物是合法 zip，且 xl/media 正好 2 个部件（不是 0，也不是 3）', async () => {
  const zip = await JSZip.loadAsync(built.buffer);
  // ⚠️ zip 里 `xl/media/` 是**目录项**，也会出现在条目列表里 —— 不过滤会把"1 张"数成 2
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));
  assert.ok(names.some((n) => n === 'xl/workbook.xml'), 'zip 里应有 xl/workbook.xml');
  const media = names.filter((n) => /^xl\/media\//.test(n));
  assert.strictEqual(media.length, 2, `xl/media 条数应为 2，实际 ${media.length}（${media.join(', ')}）`);
  assert.ok(
    media.every((n) => /\.png$/.test(n)),
    `媒体部件名应按**内容**推扩展名（.png），实际 ${media.join(', ')}`,
  );
});

await check('[Content_Types].xml 给 png 声明了内容类型（少写这处 = 包不合法、Excel 提示修复并丢图）', async () => {
  const zip = await JSZip.loadAsync(built.buffer);
  const ct = await zip.file('[Content_Types].xml').async('string');
  assert.ok(/image\/png/.test(ct), `[Content_Types].xml 应含 image/png，实际：${ct.slice(0, 200)}`);
  assert.ok(!/image\/undefined/.test(ct), '出现了 image/undefined —— 嵌图时没给 extension');
});

await check('模板（只有表头、没有数据行）→ 一张图都不嵌', async () => {
  const t = await px.buildProductWorkbook({
    sheetName: '导入模板',
    headers: HEADERS,
    rows: [],
    imageColumn: IMAGE_COL,
  });
  assert.strictEqual(t.embedded, 0);
  assert.strictEqual(t.imagesFailed, 0);
  const zip = await JSZip.loadAsync(t.buffer);
  const media = Object.keys(zip.files).filter((n) => !n.endsWith('/') && /^xl\/media\//.test(n));
  assert.strictEqual(media.length, 0, `模板不该有图，实际 ${media.length}`);
});

// ── ② 往返（读回来）──────────────────────────────────────────────────────────
await check('⭐ 往返：图按**行号**归位，且逐行字节与源图**完全一致**（装反了必须红）', async () => {
  const c = collector();
  const r = await px.extractEmbeddedImages(built.buffer, {
    sheetName: '产品库',
    headerRow: 1,
    land: c.land,
  });
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(Object.keys(r.byRow).sort(), ['2', '4'], '图应落在 Excel 第 2、4 行');
  assert.deepStrictEqual(r.skips, []);
  // 第 2 行（第 1 个数据行）= 图 A；第 4 行（第 3 个数据行）= 图 B
  assert.strictEqual(sha(c.landed[0].bytes), SHA_A, '第 2 行拿到的不是 icon.png');
  assert.strictEqual(sha(c.landed[1].bytes), SHA_B, '第 4 行拿到的不是 64x64.png');
  assert.notStrictEqual(SHA_A, SHA_B, '夹具本身失效：两张图内容一样，交换也测不出来');
});

await check('没图的行**不进** byRow（不会顺手把下一张图顶上去）', async () => {
  const c = collector();
  const r = await px.extractEmbeddedImages(built.buffer, {
    sheetName: '产品库',
    headerRow: 1,
    land: c.land,
  });
  assert.ok(!('3' in r.byRow), '第 3 行没有图，却出现在结果里');
  assert.strictEqual(r.byRow['3'], undefined);
});

await check('抽出的是**原始字节**，不是被重编码过的图（否则每次导入都是新指纹、缓存越滚越大）', async () => {
  const c = collector();
  await px.extractEmbeddedImages(built.buffer, { sheetName: '产品库', headerRow: 1, land: c.land });
  assert.strictEqual(c.landed[0].bytes.length, fs.statSync(PNG_A).size);
});

await check('无图的工作簿：不抛、total=0、byRow 空、skips 空（"这份文件没图"是正常情况）', async () => {
  const plain = await px.buildProductWorkbook({
    sheetName: '产品库',
    headers: HEADERS,
    rows: [row('P-001', '收纳箱', 'M', '')],
    imageColumn: IMAGE_COL,
  });
  const r = await px.extractEmbeddedImages(plain.buffer, {
    sheetName: '产品库',
    headerRow: 1,
    land: collector().land,
  });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.byRow, {});
  assert.deepStrictEqual(r.skips, []);
});

// ── ③ 错位与边界（这几条才是"图配错了款"的真正守卫）─────────────────────────
/** 手搓一张表：把图放在指定锚点行上（`row` 是 0 基，与 exceljs 的 `nativeRow` 同一套编号） */
async function handMade(places, headerRow = 1) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  for (let i = 0; i <= 4; i++) {
    ws.addRow(i === headerRow - 1 ? HEADERS : [`P-00${i}`, `名${i}`, '', '', '', '', '', '', '']);
  }
  ws.getColumn(IMAGE_COL + 1).width = 16;
  for (const p of places) {
    const id = wb.addImage({ filename: p.file, extension: 'png' });
    // ⚠️ 必须给 `ext`：只给 `tl:{col,row}` 时 exceljs 会走"按列宽换算锚点"那条路，
    //    而列宽没设过就会读到 undefined（`Cannot read properties of undefined (reading 'width')`）。
    //    真实导出路径（`xlsx-image.embedCellImage`）给的就是 `ext`，这里与它对齐。
    ws.addImage(id, { tl: { col: IMAGE_COL, row: p.row }, ext: { width: 96, height: 96 } });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

await check('⭐ 图锚在**表头行**上（用户把 logo 贴在表头）→ 报"没有归位"，且**不**贴给第一个数据行', async () => {
  const buf = await handMade([{ file: PNG_B, row: 0 }], 1);
  const c = collector();
  const r = await px.extractEmbeddedImages(buf, { sheetName: 'S', headerRow: 1, land: c.land });
  assert.deepStrictEqual(r.byRow, {}, '表头行的图被贴给了某个数据行');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.skips.length, 1);
  assert.ok(/没有归位/.test(r.skips[0].reason), r.skips[0].reason);
  assert.strictEqual(r.skips[0].rowNo, 1, '报的行号应是锚点所在行（1）');
});

await check('表头不在第一行时：锚在表头**以上**的行也一律不归位（按传入的 headerRow 判，不写死 1）', async () => {
  // 表头在第 2 行（nativeRow 1）；第 1 行也插了图 → 属于"表头及以上"
  const buf = await handMade([{ file: PNG_A, row: 0 }, { file: PNG_B, row: 2 }], 2);
  const c = collector();
  const r = await px.extractEmbeddedImages(buf, { sheetName: 'S', headerRow: 2, land: c.land });
  assert.deepStrictEqual(Object.keys(r.byRow), ['3'], '数据行从表头的下一行（第 3 行）开始');
  assert.strictEqual(sha(c.landed[0].bytes), SHA_B);
  assert.strictEqual(r.skips.length, 1);
  assert.strictEqual(r.skips[0].rowNo, 1);
});

await check('⭐ 同一行插了两张图 → 只留**第一张**（内容断言），第二张明确报出来', async () => {
  const buf = await handMade([{ file: PNG_A, row: 2 }, { file: PNG_B, row: 2 }], 1);
  const c = collector();
  const r = await px.extractEmbeddedImages(buf, { sheetName: 'S', headerRow: 1, land: c.land });
  assert.deepStrictEqual(Object.keys(r.byRow), ['3']);
  assert.strictEqual(sha(c.landed[0].bytes), SHA_A, '留下的应是先插入的那张');
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.skips.length, 1);
  assert.strictEqual(r.skips[0].rowNo, 3);
  assert.ok(/不止一张/.test(r.skips[0].reason), r.skips[0].reason);
});

await check('工作表名不存在 → **抛错**（不许静默返回空：那会变成"导入成功但一张图都没有"）', async () => {
  await assert.rejects(
    () => px.extractEmbeddedImages(built.buffer, { sheetName: '不存在的表', headerRow: 1, land: collector().land }),
    /没有名为/,
  );
});

await check('超过 max → 截断并说明还剩多少（不是静默少导几张）', async () => {
  const buf = await handMade([{ file: PNG_A, row: 1 }, { file: PNG_B, row: 3 }], 1);
  const c = collector();
  const r = await px.extractEmbeddedImages(buf, { sheetName: 'S', headerRow: 1, max: 1, land: c.land });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(Object.keys(r.byRow).length, 1);
  assert.ok(r.skips.some((s) => /只处理了前 1 张/.test(s.reason)), JSON.stringify(r.skips));
});

await check('单张图落盘失败（land 抛）→ 其余行照常归位，这一行报出来', async () => {
  const buf = await handMade([{ file: PNG_A, row: 1 }, { file: PNG_B, row: 2 }], 1);
  let n = 0;
  const r = await px.extractEmbeddedImages(buf, {
    sheetName: 'S',
    headerRow: 1,
    land: (bytes) => {
      n++;
      if (n === 1) throw new Error('磁盘满了');
      return { imageId: 7, localPath: '/fake/7.png' };
    },
  });
  assert.deepStrictEqual(Object.keys(r.byRow), ['3'], '第一张失败不该带走第二张');
  assert.strictEqual(r.byRow['3'].imageId, 7);
  assert.ok(r.skips.some((s) => /磁盘满了/.test(s.reason)), JSON.stringify(r.skips));
});

}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
// ⚠️ 全部用例必须**逐个 await**：`check()` 收的是 async 回调，漏掉 await 会让进程
//    在用例跑完之前就走到这里，然后打出一个"✅ 全部通过"的**假绿**（本轮踩到过一次）。
main()
  .catch((e) => {
    failed++;
    console.log(`  \u2717 冒烟自身抛错：${e && e.message ? e.message : String(e)}`);
  })
  .finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\u2500'.repeat(64));
    console.log(failed === 0 ? '\u2705 全部通过' : `\u274c ${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
  });
