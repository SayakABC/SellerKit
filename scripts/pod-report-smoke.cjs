// 「花纸报单 zip」导出冒烟（DB + 产物层，不启动界面）。
//
//   npm run pod:report:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/pod-report-smoke.cjs
//
// 为什么单独一个：T4-3 的两条判据（① 解压后图片张数 == 清单行数 ② 图稿与预览图不同）
// 在代码返回值里**看不出来** —— zip 生成成功、清单也正常，错只错在"打进 zip 的是哪张图"。
// 那是红线 7：把模特预览图交给花纸商制版，整批报废，而且**不会报错**。
//
// 覆盖的不变量：
//   · `图稿/` 里的文件数 == 清单数据行数（缺图稿的行仍留在清单里，但不占图片名额）；
//   · **打进 zip 的字节 == `artwork_image_id` 指向的那张**（不是 preview）；
//   · 缺图稿的行：清单里标「（缺）」+ 备注写"先去传图稿"，`missingArtwork` 回给界面；
//   · 净需件 0 的行**不进报单**（主进程再滤一次，防止渲染层误传"够料"的行）；
//   · 图案编码里的 `/` 不能原样进 zip 条目名（会被解成子目录 / 解不出来）；
//   · 清单第 1 行是"哪天的、每张多少件"，第 2 行是警告（未绑件数 / 缺图稿），
//     第 3 行才是表头 —— 打开第一眼就知道这份单是**偏少的**；
//   · 合计行 = 各数据行的和；
//   · 没有净需件 > 0 的行时**抛错**（导出一份空单比不导出更糟：看起来做完了）。
//
// 图用仓库自带的真图（`build/icon.png` / `build/icons/png/64x64.png`）：两张字节不同，
// 于是"图稿 vs 预览图"这条断言才有意义（拿同一张图两头都填，永远测不出传错）。
// 库文件落在临时目录，不污染真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-pod-report-'));

const { initDb, closeDb } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const mdb = require(path.join(ROOT, 'dist', 'electron', 'master-data-db.js'));
const pod = require(path.join(ROOT, 'dist', 'electron', 'pod-db.js'));
const report = require(path.join(ROOT, 'dist', 'electron', 'pod-report.js'));
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

const ART_FILE = path.join(ROOT, 'build', 'icon.png');
const PREVIEW_FILE = path.join(ROOT, 'build', 'icons', 'png', '64x64.png');
const ART_BYTES = fs.readFileSync(ART_FILE);
const PREVIEW_BYTES = fs.readFileSync(PREVIEW_FILE);

initDb(path.join(dir, 'smoke.db'));
mdb.ensureMasterDataSchema();
pod.ensurePodSchema();

// 两张**内容不同**的图（同一张图两头都填，下一条红线断言就会永远通过 —— 等于没测）
const art = mdb.registerImageRow({
  fingerprint: 'smoke-artwork-fp',
  localPath: ART_FILE,
  source: 'upload',
});
const preview = mdb.registerImageRow({
  fingerprint: 'smoke-preview-fp',
  localPath: PREVIEW_FILE,
  source: 'upload',
});
assert.notDeepStrictEqual(ART_BYTES, PREVIEW_BYTES, '两张夹具图必须字节不同，否则红线 7 的断言无效');

const p1 = pod.podPatternCreate({ code: 'P001', name: '小猫', artworkImageId: art.imageId, previewImageId: preview.imageId });
const p2 = pod.podPatternCreate({ code: 'P002', name: '还没传图稿', previewImageId: preview.imageId });
const p3 = pod.podPatternCreate({ code: 'P00/4', name: '编码里带斜杠', artworkImageId: art.imageId });
const p4 = pod.podPatternCreate({ code: 'P003', name: '余量够，不用报', artworkImageId: art.imageId });

function rowOf(p, need, remaining) {
  return {
    patternId: p.id,
    code: p.code,
    name: p.name,
    artworkImageId: p.artworkImageId,
    previewImageId: p.previewImageId,
    needPieces: need,
    remainingPieces: remaining,
    netNeed: Math.max(0, need - remaining),
    sheets: Math.ceil(Math.max(0, need - remaining) / 10),
  };
}

// 渲染层算好的行（主进程只校验 + 打包，不重算）
const rows = [
  { ...rowOf({ id: p1.id, code: 'P001', name: '小猫', artworkImageId: art.imageId, previewImageId: preview.imageId }, 120, 20) },
  { ...rowOf({ id: p2.id, code: 'P002', name: '还没传图稿', artworkImageId: 0, previewImageId: preview.imageId }, 30, 0) },
  { ...rowOf({ id: p3.id, code: 'P00/4', name: '编码里带斜杠', artworkImageId: art.imageId, previewImageId: 0 }, 5, 0) },
  // 净需件 0（余量够）—— 必须被丢掉，不许进报单
  { ...rowOf({ id: p4.id, code: 'P003', name: '余量够，不用报', artworkImageId: art.imageId, previewImageId: 0 }, 5, 5) },
];

let out;
const filesOf = async (buf) => {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files)
    .filter((k) => !zip.files[k].dir)
    .sort();
};

(async () => {
  out = await report.buildPodReportZip({
    rows,
    date: '2026-11-01',
    piecesPerSheet: 10,
    unboundPieces: 5,
    unboundRows: 1,
    assumedRows: 1,
  });

  console.log('\n[1] zip 结构：图稿张数、缺图稿、净需件 0 的行');

  await check('zip 能被解回来（自己写的格式自己读回来不算验，这里用 jszip 读）', async () => {
    const files = await filesOf(out.zip);
    assert.deepStrictEqual(files, ['图稿/P001.png', '图稿/P00_4.png', '清单.xlsx'].sort());
  });

  await check('图片张数 == 净需件 > 0 且有图稿的行数（缺图稿的行不占名额、但仍在清单里）', () => {
    assert.strictEqual(out.images, 2, `应 2 张图，实为 ${out.images}`);
    assert.strictEqual(out.rows, 3, `清单应 3 行（P003 净需件 0 已丢弃），实为 ${out.rows}`);
    assert.deepStrictEqual(out.missingArtwork, ['P002']);
  });

  await check('图案编码里的 `/` 不能原样进 zip 条目名（否则解成子目录 / 解不出来）', async () => {
    const files = await filesOf(out.zip);
    assert.ok(files.includes('图稿/P00_4.png'), `实际：${files.join(' | ')}`);
    assert.ok(!files.some((f) => f.includes('P00/4')), '斜杠原样漏进了条目名');
  });

  console.log('\n[2] 红线 7：打进 zip 的是图稿，不是预览图');

  await check('图稿条目的字节 == artwork_image_id 指向的那张（且 ≠ preview 那张）', async () => {
    const zip = await JSZip.loadAsync(out.zip);
    const bytes = await zip.file('图稿/P001.png').async('nodebuffer');
    assert.deepStrictEqual(Buffer.from(bytes), ART_BYTES, '打进 zip 的不是图稿');
    assert.notDeepStrictEqual(Buffer.from(bytes), PREVIEW_BYTES, '打进 zip 的是预览图 —— 整批会报废');
  });

  console.log('\n[3] 清单内容：标题 / 警告 / 表头 / 数据行 / 合计');

  // 清单从 zip 里读回来（不是从 `buildPodReportWorkbook` 的返回值读 —— 那等于自己验自己）
  const zippedBook = await (await JSZip.loadAsync(out.zip)).file('清单.xlsx').async('nodebuffer');
  const ws = new ExcelJS.Workbook();
  await ws.xlsx.load(zippedBook);
  const sheet = ws.getWorksheet('报单');
  const cell = (addr) => {
    const v = sheet.getCell(addr).value;
    return v && typeof v === 'object' && 'richText' in v ? v.richText.map((t) => t.text).join('') : v;
  };

  await check('第 1 行说清"哪天的、每张多少件"（表头之上，合并 1~8 列）', () => {
    const t = String(cell('A1') ?? '');
    assert.ok(t.includes('2026-11-01'), `标题里没有日期：${t}`);
    assert.ok(t.includes('每张 10 件'), `标题里没有每张件数：${t}`);
  });

  await check('第 2 行是警告：未绑件数 + 缺图稿（不写这一行，这份单会被当成"齐了"）', () => {
    const t = String(cell('A2') ?? '');
    assert.ok(t.includes('还有 5 件待发没绑图案'), `未绑件数没写：${t}`);
    assert.ok(t.includes('1 个图案有需求但没有图稿'), `缺图稿没写：${t}`);
    assert.ok(t.includes('按 1 件计'), `件数按 1 计的行数没写：${t}`);
  });

  await check('第 3 行表头八列齐全（与界面口径逐字一致）', () => {
    const heads = ['图案编码', '图案名', '待印件', '余量', '净需件', '报单张数', '图稿', '备注'];
    assert.deepStrictEqual(
      heads.map((_, i) => String(cell(`${String.fromCharCode(65 + i)}3`) ?? '')),
      heads,
    );
  });

  await check('数据行：净需件 = 待印件 − 余量，张数 = ceil(净需件 / 每张件数)', () => {
    assert.strictEqual(String(cell('A4')), 'P001');
    assert.strictEqual(Number(cell('C4')), 120);
    assert.strictEqual(Number(cell('D4')), 20);
    assert.strictEqual(Number(cell('E4')), 100);
    assert.strictEqual(Number(cell('F4')), 10);
    assert.strictEqual(String(cell('G4')), '图稿/P001.png');
  });

  await check('缺图稿的行：图稿列写「（缺）」、备注告诉人先去补图（不拿预览图兜底）', () => {
    const rowNo = 5;
    assert.strictEqual(String(cell(`A${rowNo}`)), 'P002');
    assert.strictEqual(String(cell(`G${rowNo}`)), '（缺）');
    const note = String(cell(`H${rowNo}`) ?? '');
    assert.ok(note.includes('缺图稿'), `备注没写缺图稿：${note}`);
    assert.ok(note.includes('预览图不能制版'), `备注没点明预览图不能制版：${note}`);
  });

  await check('净需件 0 的行不在清单里（否则"够料"的图案会被再买一次花纸）', () => {
    const codes = [4, 5, 6].map((r) => String(cell(`A${r}`)));
    assert.deepStrictEqual(codes, ['P001', 'P002', 'P00/4']);
  });

  await check('合计行 = 数据行之和（老板/花纸商第一眼看的就是"一共几张"）', () => {
    const t = String(cell('A7') ?? '');
    assert.strictEqual(t, '合计');
    assert.strictEqual(Number(cell('C7')), 155, '待印件合计错');
    assert.strictEqual(Number(cell('E7')), 135, '净需件合计错');
    assert.strictEqual(Number(cell('F7')), 14, '报单张数合计错');
  });

  console.log('\n[4] 空单拒绝');

  await check('净需件全为 0 时抛错（导出一份空单比不导出更糟：看起来做完了）', async () => {
    await assert.rejects(
      () =>
        report.buildPodReportZip({
          rows: [rowOf({ id: p4.id, code: 'P003', name: '够料', artworkImageId: art.imageId }, 5, 5)],
          date: '2026-11-01',
          piecesPerSheet: 10,
        }),
      /没有需要报单的图案/,
    );
  });

  await check('`rows` 不是数组 / 缺日期时不抛，按今天兜底（但绝对不能因此放过空单）', async () => {
    await assert.rejects(
      () => report.buildPodReportZip({ rows: null, date: '2026-11-01', piecesPerSheet: 10 }),
      /没有需要报单的图案/,
    );
  });

  closeDb();
  console.log(failed ? `\n\u274c 报单导出冒烟：${failed} 项失败` : '\n\u2705 报单导出冒烟全部通过');
  process.exit(failed ? 1 : 0);
})();
