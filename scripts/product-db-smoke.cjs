// 产品库数据层冒烟（不启动 Electron 界面）。
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI**（NODE_MODULE_VERSION 149）编译，
// 而 vitest 跑在系统 Node 上（127），require 时直接抛 ABI 不匹配 —— 故 DB 层不用单测覆盖，
// 与 order-db / ae-db / purchase-db 保持一致，统一走本冒烟 + 手动流程回归。
//
//   npm run product:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/product-db-smoke.cjs
//
// 覆盖 product-db 的写入契约：编码唯一性（冲突必须抛错，不得静默改名/覆盖 —— 编码是订单/采购/
// 成本三域的关联键）、状态白名单兜底、厂家名派生（只存 supplier_id，避免同一语义两个写入者）、
// 过滤分页、删除、汇总。库文件落在临时目录，不污染真实 userData。
//
// 每个用例自带 reset()：用例之间不留数据，避免「上一条的 SKU-001 撞了下一条的新增」这类
// 假失败掩盖真实缺陷。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-product-smoke-'));

const { dbQuery, initDb, closeDb, dbRun } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));

initDb(path.join(dir, 'smoke.db'));
pdb.ensureProductSchema();
// 厂家权威表在采购域；此处建最小同构表，用于验证「名称由 supplier_id 派生」
dbRun(`CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
)`);

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

/** 全量入参（upsert 是全量提交语义） */
const input = (over = {}) => ({
  id: 0,
  code: 'SKU-001',
  name: '示例产品',
  supplierId: 0,
  category: '家居',
  status: 'active',
  note: '',
  ...over,
});

const reset = () => {
  dbRun('DELETE FROM pl_products');
  dbRun('DELETE FROM suppliers');
};

const query = (payload = {}) =>
  pdb.listProducts({ offset: 0, limit: 50, search: '', status: '', supplierId: 0, ...payload });

console.log('\n产品库数据层冒烟（pl_products）\n' + '\u2500'.repeat(64));

// ---- 编码唯一性 ----
check('新增返回 created=true，可按编码回查', () => {
  reset();
  const r = pdb.upsertProduct(input());
  assert.strictEqual(r.created, true);
  assert.ok(r.id > 0, 'id 应为正整数');
  assert.strictEqual(pdb.getProduct(r.id).code, 'SKU-001');
});

check('重复编码抛错，且不覆盖既有记录', () => {
  reset();
  pdb.upsertProduct(input());
  assert.throws(() => pdb.upsertProduct(input({ name: '另一个名字' })), /编码已存在/);
  assert.strictEqual(query().rows[0].name, '示例产品', '既有记录被改动了');
});

check('改自身编码不误判为冲突', () => {
  reset();
  const b = pdb.upsertProduct(input({ code: 'SKU-B' }));
  const r = pdb.upsertProduct(input({ id: b.id, code: 'SKU-B2', name: '改名' }));
  assert.strictEqual(r.created, false);
  assert.strictEqual(pdb.getProduct(b.id).code, 'SKU-B2');
});

check('更新不存在的 id 抛错（不静默新增）', () => {
  reset();
  assert.throws(() => pdb.upsertProduct(input({ id: 99999 })), /不存在/);
});

check('空编码抛错', () => {
  reset();
  assert.throws(() => pdb.upsertProduct(input({ code: '   ' })), /编码不能为空/);
});

// ---- 状态白名单 ----
check('非法状态兜底 active', () => {
  reset();
  const r = pdb.upsertProduct(input({ status: 'whatever' }));
  assert.strictEqual(pdb.getProduct(r.id).status, 'active');
});

check('合法状态被保留', () => {
  reset();
  const r = pdb.upsertProduct(input({ status: 'archived' }));
  assert.strictEqual(pdb.getProduct(r.id).status, 'archived');
});

// ---- 过滤与分页 ----
reset();
pdb.upsertProduct(input({ code: 'A-100', name: '花瓶', category: '家居' }));
pdb.upsertProduct(input({ code: 'A-200', name: '花盆', category: '园艺', status: 'archived' }));
pdb.upsertProduct(input({ code: 'B-300', name: '台灯', category: '家居' }));

check('按编码升序返回，总数正确', () => {
  const r = query();
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(
    r.rows.map((x) => x.code),
    ['A-100', 'A-200', 'B-300']
  );
});

check('关键字命中编码', () => {
  assert.deepStrictEqual(
    query({ search: 'A-2' }).rows.map((x) => x.code),
    ['A-200']
  );
});

check('关键字命中名称', () => {
  assert.deepStrictEqual(
    query({ search: '台灯' }).rows.map((x) => x.code),
    ['B-300']
  );
});

check('状态过滤只返回该状态', () => {
  assert.deepStrictEqual(
    query({ status: 'archived' }).rows.map((x) => x.code),
    ['A-200']
  );
});

check('分页 total 为过滤后总数，不受 limit 影响', () => {
  const r = query({ limit: 2 });
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.total, 3);
});

// ---- 厂家名派生 ----
check('supplier_id 经 suppliers 表派生名称', () => {
  reset();
  const s = dbRun(`INSERT INTO suppliers (name) VALUES (?)`, ['东莞家具厂']);
  const r = pdb.upsertProduct(input({ supplierId: s.lastInsertRowid }));
  const row = pdb.getProduct(r.id);
  assert.strictEqual(row.supplierId, s.lastInsertRowid);
  assert.strictEqual(row.supplierName, '东莞家具厂');
});

check('未关联厂家为空名，并计入 summary.withoutSupplier', () => {
  reset();
  const r = pdb.upsertProduct(input({ supplierId: 0 }));
  assert.strictEqual(pdb.getProduct(r.id).supplierName, '');
  assert.strictEqual(pdb.productSummary().withoutSupplier, 1);
});

check('按厂家过滤', () => {
  reset();
  const s = dbRun(`INSERT INTO suppliers (name) VALUES (?)`, ['深圳灯饰厂']);
  pdb.upsertProduct(input({ code: 'C-1', supplierId: s.lastInsertRowid }));
  pdb.upsertProduct(input({ code: 'C-2', supplierId: 0 }));
  assert.deepStrictEqual(
    query({ supplierId: s.lastInsertRowid }).rows.map((x) => x.code),
    ['C-1']
  );
});

// ---- 删除 ----
check('删除后回查为 null', () => {
  reset();
  const r = pdb.upsertProduct(input({ code: 'D-1' }));
  assert.strictEqual(pdb.deleteProduct(r.id).deleted, true);
  assert.strictEqual(pdb.getProduct(r.id), null);
});

check('非法 id 返回 deleted=false（不抛错）', () => {
  reset();
  assert.strictEqual(pdb.deleteProduct(0).deleted, false);
  assert.strictEqual(pdb.deleteProduct(99999).deleted, false);
});

// ---- 批量编辑（部分 patch：undefined 字段不修改）----
check('batchUpdateProducts：只改传入的字段，未传字段保持原值', () => {
  reset();
  const a = pdb.upsertProduct(input({ code: 'BU-1', name: '甲', category: '家居', note: '旧注' })).id;
  const b = pdb.upsertProduct(input({ code: 'BU-2', name: '乙', category: '园艺', status: 'archived', note: '旧注' })).id;
  const r = pdb.batchUpdateProducts({ ids: [a, b], category: '服饰' });
  assert.strictEqual(r.updated, 2);
  const pa = pdb.getProduct(a);
  const pb = pdb.getProduct(b);
  assert.strictEqual(pa.category, '服饰');
  assert.strictEqual(pb.category, '服饰');
  // 未传的 status / note / supplierId 不动
  assert.strictEqual(pa.status, 'active');
  assert.strictEqual(pb.status, 'archived');
  assert.strictEqual(pa.note, '旧注');
  assert.strictEqual(pb.note, '旧注');
});

check('batchUpdateProducts：supplierId=0 清空关联；空串清空类目；状态非法兜底 active', () => {
  reset();
  const r = pdb.upsertProduct(input({ code: 'BU-3', category: '家居', status: 'archived' })).id;
  pdb.batchUpdateProducts({ ids: [r], category: '', status: 'nope' });
  const row = pdb.getProduct(r);
  assert.strictEqual(row.category, '');
  assert.strictEqual(row.status, 'active');
});

check('batchUpdateProducts：空 ids / 无字段 / 不存在的厂家 各自抛错', () => {
  reset();
  assert.throws(() => pdb.batchUpdateProducts({ ids: [], category: 'x' }), /选择/);
  assert.throws(() => pdb.batchUpdateProducts({ ids: [1, 2] }), /至少/);
  assert.throws(
    () => pdb.batchUpdateProducts({ ids: [1], supplierId: 999999 }),
    /厂家不存在/,
  );
  // 供应商表未就绪时降级放行（跨域表不在本域管辖）
});

// ---- 汇总 ----
check('总数与状态分布', () => {
  reset();
  pdb.upsertProduct(input({ code: 'E-1' }));
  pdb.upsertProduct(input({ code: 'E-2', status: 'archived' }));
  const s = pdb.productSummary();
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.byStatus.find((x) => x.status === 'active').count, 1);
  assert.strictEqual(s.byStatus.find((x) => x.status === 'archived').count, 1);
});

// ---- 批量导入（P2 验收场景）----
// 验收原文：「导入 500 行含 10 行错误的文件：490 入库、10 行可在界面重试」。
// 这里钉的是库层最容易写错的一点：**行级错误必须在本函数内被 catch 住，不能冒泡出事务** ——
// 一旦冒泡，500 行里有 1 个空编码就会整批回滚（用户看到"导入失败"，一行都没进去）。
check('500 行含 10 行错误：490 入库、10 行逐行报错、不做整批回滚', () => {
  reset();
  const rows = [];
  for (let i = 1; i <= 500; i++) {
    // 第 5 / 55 / 105 … 行（共 10 行）留空编码，模拟用户表的常见脏数据
    const bad = i % 50 === 5;
    rows.push({
      rowNo: i,
      code: bad ? '' : `P-${String(i).padStart(4, '0')}`,
      name: `产品${i}`,
      supplierId: 0,
      category: '家居',
      status: 'active',
      note: '',
    });
  }
  const out = pdb.importProducts(rows, 'insertOnly');
  assert.strictEqual(out.created, 490, `期望 490 行入库，实际 ${out.created}`);
  assert.strictEqual(out.updated, 0);
  assert.strictEqual(out.failed.length, 10);
  assert.deepStrictEqual(
    out.failed.map((f) => f.rowNo),
    [5, 55, 105, 155, 205, 255, 305, 355, 405, 455],
  );
  assert.ok(
    out.failed.every((f) => /款编码为空/.test(f.message)),
    '失败原因应逐行写明，界面要靠它提示用户改哪一列',
  );
  assert.strictEqual(query({ limit: 1000 }).total, 490, '入库总数应为 490（不是 500，也不是 0）');
});

check('修正后的 10 行重试可入库（界面「返回修改」再导一次）', () => {
  // 承上：只清失败行的编码，重新提交这 10 行 —— 这是界面上的「重试」路径
  const retry = [5, 55, 105, 155, 205, 255, 305, 355, 405, 455].map((i) => ({
    rowNo: i,
    code: `P-${String(i).padStart(4, '0')}`,
    name: `产品${i}`,
    supplierId: 0,
    category: '家居',
    status: 'active',
    note: '',
  }));
  const out = pdb.importProducts(retry, 'insertOnly');
  assert.strictEqual(out.created, 10);
  assert.strictEqual(out.failed.length, 0);
  assert.strictEqual(query({ limit: 1000 }).total, 500);
});

check('insertOnly 下编码已存在记为该行失败，不覆盖既有记录', () => {
  reset();
  pdb.upsertProduct(input({ code: 'P-0001', name: '原件' }));
  const out = pdb.importProducts(
    [{ rowNo: 1, code: 'P-0001', name: '导入件', supplierId: 0, category: '', status: 'active', note: '' }],
    'insertOnly',
  );
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.failed.length, 1);
  assert.ok(/已存在/.test(out.failed[0].message));
  assert.strictEqual(query().rows[0].name, '原件', '既有记录被导入了，编码唯一性失守');
});

check('upsert 模式下同一编码重复出现：先建后更，total 不翻倍', () => {
  reset();
  const out = pdb.importProducts(
    [
      { rowNo: 1, code: 'P-0002', name: '第一次', supplierId: 0, category: '', status: 'active', note: '' },
      { rowNo: 2, code: 'P-0002', name: '第二次', supplierId: 0, category: '', status: 'active', note: '' },
    ],
    'upsert',
  );
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.updated, 1);
  assert.strictEqual(query().total, 1);
  assert.strictEqual(query().rows[0].name, '第二次');
});

// ---- SKU 子表（pl_variants）与产品图片（pl_images / pl_item_images）----
// 最小同构表：订单域的 oi_orders / oi_images（itemImagePool 的第②层回落要扫它们）
dbRun(`CREATE TABLE IF NOT EXISTS oi_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER,
  raw_fields TEXT
)`);
dbRun(`CREATE TABLE IF NOT EXISTS oi_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  local_path TEXT NOT NULL
)`);
// 第③层回落（映射 → 款主图）需要 pl_shop_sku 存在
pdb.ensureSkuSchema();
pdb.ensureVariantSchema();

const vInput = (over = {}) => ({
  id: 0,
  productId: 0,
  code: '',
  name: '红色 M 码',
  weightG: 250,
  status: 'active',
  ...over,
});

const cleanVariants = () => {
  dbRun('DELETE FROM pl_variants');
  dbRun('DELETE FROM pl_images');
  dbRun('DELETE FROM pl_item_images');
  dbRun('DELETE FROM pl_products');
  dbRun('DELETE FROM oi_orders');
  dbRun('DELETE FROM oi_images');
};

check('ensureProductSchema 幂等重跑不炸，且 image_id 列存在（老库 ALTER 补列的判定基础）', () => {
  pdb.ensureProductSchema();
  const cols = dbRun(`SELECT 1 FROM pragma_table_info('pl_products') WHERE name = 'image_id'`);
  assert.ok(cols, 'pl_products 应有 image_id 列');
});

check('variantUpsert：新增 created=true，克重四舍五入取整', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const r = pdb.variantUpsert(vInput({ productId: pid, weightG: 250.6 }));
  assert.ok(r.created);
  const rows = pdb.variantList([pid]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].weightG, 251);
  assert.strictEqual(rows[0].productId, pid);
});

check('同款下重名 SKU 抛错；不同款同名合法', () => {
  cleanVariants();
  const p1 = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const p2 = pdb.upsertProduct(input({ code: 'V-002' })).id;
  pdb.variantUpsert(vInput({ productId: p1, name: '红色 M' }));
  assert.throws(() => pdb.variantUpsert(vInput({ productId: p1, name: '红色 M' })), /同名/);
  pdb.variantUpsert(vInput({ productId: p2, name: '红色 M' }));
});

check('SKU 编码全局唯一（撞码抛错）；空编码可并存多条（部分唯一索引）', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  pdb.variantUpsert(vInput({ productId: pid, name: 'A', code: 'SKU-A' }));
  assert.throws(() => pdb.variantUpsert(vInput({ productId: pid, name: 'B', code: 'SKU-A' })), /已被占用/);
  pdb.variantUpsert(vInput({ productId: pid, name: 'C', code: '' }));
  pdb.variantUpsert(vInput({ productId: pid, name: 'D', code: '' }));
  assert.strictEqual(pdb.variantList([pid]).length, 3);
});

check('SKU 入参校验：颜色尺码空 / 克重负数 / 产品不存在 各自抛错', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  assert.throws(() => pdb.variantUpsert(vInput({ productId: pid, name: '   ' })), /颜色和尺码/);
  assert.throws(() => pdb.variantUpsert(vInput({ productId: pid, weightG: -5 })), /克重/);
  assert.throws(() => pdb.variantUpsert(vInput({ productId: 999999 })), /产品/);
});

check('ensureVariantSchema 幂等重跑不炸，且 color/size 列存在（老库 ALTER 补列的判定基础）', () => {
  pdb.ensureVariantSchema();
  const cols = dbRun(`SELECT 1 FROM pragma_table_info('pl_variants') WHERE name = 'color'`);
  assert.ok(cols, 'pl_variants 应有 color 列');
  const cols2 = dbRun(`SELECT 1 FROM pragma_table_info('pl_variants') WHERE name = 'size'`);
  assert.ok(cols2, 'pl_variants 应有 size 列');
});

check('variantUpsert：color+size 成对时 name 自动生成为 "颜色 尺码" 并落库', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const r = pdb.variantUpsert(
    vInput({ productId: pid, name: '随便填也会被覆盖', color: '黑色', size: 'XL', weightG: 300 }),
  );
  assert.ok(r.created);
  const row = pdb.variantList([pid])[0];
  assert.strictEqual(row.name, '黑色 XL');
  assert.strictEqual(row.color, '黑色');
  assert.strictEqual(row.size, 'XL');
  assert.strictEqual(row.weightG, 300);
});

check('同款下重复颜色尺码组合抛错（不同文案）；跨款同组合合法', () => {
  cleanVariants();
  const p1 = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const p2 = pdb.upsertProduct(input({ code: 'V-002' })).id;
  pdb.variantUpsert(vInput({ productId: p1, color: '白色', size: 'M' }));
  assert.throws(
    () => pdb.variantUpsert(vInput({ productId: p1, color: '白色', size: 'M' })),
    /相同颜色尺码/,
  );
  pdb.variantUpsert(vInput({ productId: p2, color: '白色', size: 'M' }));
});

check('颜色尺码只填其一（不成对）抛错；仅名称（老数据路径）仍合法', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  assert.throws(() => pdb.variantUpsert(vInput({ productId: pid, color: '红色' })), /成对/);
  assert.throws(() => pdb.variantUpsert(vInput({ productId: pid, size: 'M' })), /成对/);
  const r = pdb.variantUpsert(vInput({ productId: pid, name: '老数据自由文本' }));
  const row = pdb.variantList([pid]).find((x) => x.id === r.id);
  assert.strictEqual(row.name, '老数据自由文本');
  assert.strictEqual(row.color, '');
  assert.strictEqual(row.size, '');
});

check('更新 SKU：补上颜色尺码后 name 重写为新组合；仍受组合唯一约束', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const a = pdb.variantUpsert(vInput({ productId: pid, name: '旧名' })).id;
  pdb.variantUpsert(vInput({ productId: pid, color: '蓝色', size: 'L' }));
  assert.throws(
    () => pdb.variantUpsert(vInput({ id: a, productId: pid, name: '', color: '蓝色', size: 'L' })),
    /相同颜色尺码/,
  );
  pdb.variantUpsert(vInput({ id: a, productId: pid, name: '', color: '蓝色', size: 'XL' }));
  const row = pdb.variantList([pid]).find((x) => x.id === a);
  assert.strictEqual(row.name, '蓝色 XL');
});

check('variantList 按 productIds 批量归并，product_id,id 升序；variantDelete 物理删除', () => {
  cleanVariants();
  const p1 = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const p2 = pdb.upsertProduct(input({ code: 'V-002' })).id;
  const a = pdb.variantUpsert(vInput({ productId: p1, name: 'A' })).id;
  pdb.variantUpsert(vInput({ productId: p1, name: 'B' }));
  pdb.variantUpsert(vInput({ productId: p2, name: 'C' }));
  const rows = pdb.variantList([p2, p1]);
  assert.deepStrictEqual(rows.map((r) => r.productId), [p1, p1, p2]);
  assert.strictEqual(rows[0].id, a);
  pdb.variantDelete(a);
  assert.strictEqual(pdb.variantList([p1]).length, 1);
});

check('upsertImageRecord 同指纹复用既有行（内容级去重）', () => {
  cleanVariants();
  const a = pdb.upsertImageRecord({ fingerprint: 'fp-1', localPath: '/x/a.png' });
  const b = pdb.upsertImageRecord({ fingerprint: 'fp-1', localPath: '/x/a.png' });
  assert.ok(a.imageId > 0 && b.reused && !a.reused && b.imageId === a.imageId);
});

check('attachProductImage 后 listProducts 带 imagePath；detach 后归零', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const { imageId } = pdb.upsertImageRecord({ fingerprint: 'fp-2', localPath: '/cache/x.jpg' });
  pdb.attachProductImage(pid, imageId);
  const row = pdb.listProducts({ limit: 10 }).rows.find((r) => r.id === pid);
  assert.strictEqual(row.imageId, imageId);
  assert.strictEqual(row.imagePath, '/cache/x.jpg');
  pdb.detachProductImage(pid);
  assert.strictEqual(pdb.getProduct(pid).imageId, 0);
  assert.strictEqual(pdb.getProduct(pid).imagePath, '');
});

check('attach 目标产品/图片不存在各自抛错', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  assert.throws(() => pdb.attachProductImage(999999, 1), /产品/);
  assert.throws(() => pdb.attachProductImage(pid, 999999), /图片/);
});

check('itemImagePool 三层回落：覆盖图 > 订单图 > 款主图，逐 item 独立判定', () => {
  cleanVariants();
  const pid = pdb.upsertProduct(input({ code: 'V-001' })).id;
  const g1 = pdb.upsertImageRecord({ fingerprint: 'fp-ov', localPath: '/cache/ov.jpg' }).imageId;
  const g3 = pdb.upsertImageRecord({ fingerprint: 'fp-pr', localPath: '/cache/pr.jpg' }).imageId;

  // 订单域图（oi_images 表）：一条带商品ID 的订单，挂订单图 id=77
  dbRun(`INSERT INTO oi_images (id, fingerprint, local_path) VALUES (77, 'fp-77', '/cache/o77.jpg')`);
  dbRun(
    `INSERT INTO oi_orders (image_id, raw_fields) VALUES (77, ?)`,
    [JSON.stringify({ 商品ID: ' IT-100 ' })], // 故意带空白 → 应归一成 IT-100
  );
  // 款主图：商品ID → 产品 → 主图
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, product_id, status) VALUES ('ae', 1, 'IT-100', ?, 'confirmed')`,
    [pid],
  );
  pdb.attachProductImage(pid, g3);
  // 覆盖图
  pdb.setItemImage({ itemId: 'IT-200', imageId: g1 });

  const pool = pdb.itemImagePool(['IT-100', 'IT-200', 'IT-300']);
  const e100 = pool.get('IT-100');
  assert.strictEqual(e100.override, null, 'IT-100 没有覆盖图');
  assert.strictEqual(e100.order.length, 1, 'IT-100 命中一张订单图');
  assert.strictEqual(e100.order[0].imageId, 77);
  assert.strictEqual(e100.product.imageId, g3, 'IT-100 回落到款主图');
  const e200 = pool.get('IT-200');
  assert.strictEqual(e200.override.imageId, g1, 'IT-200 覆盖图最高优先');
  assert.strictEqual(e200.order.length, 0);
  const e300 = pool.get('IT-300');
  assert.strictEqual(e300.override, null);
  assert.strictEqual(e300.order.length, 0);
  assert.strictEqual(e300.product, null);
});

check('clearItemImage 删除覆盖行；item_id 按归一键存储（原文带空白也能命中）', () => {
  cleanVariants();
  const g = pdb.upsertImageRecord({ fingerprint: 'fp-9', localPath: '/cache/9.jpg' }).imageId;
  pdb.setItemImage({ itemId: '  IT\u200b-9  ', imageId: g });
  const pool = pdb.itemImagePool(['IT-9']);
  assert.strictEqual(pool.get('IT-9').override.imageId, g, '零宽/空白应被归一掉');
  const r = pdb.clearItemImage('IT-9');
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(pdb.itemImagePool(['IT-9']).get('IT-9').override, null);
});

console.log('\n[N] 「商品ID 克重」链已删（2026-10-01 用户领域裁定）：表没了、函数没了');

check('pl_item_weights 不存在（克重只属于 SKU：pl_variants.weight_g）', () => {
  assert.strictEqual(require(path.join(ROOT, 'dist', 'electron', 'db.js')).tableExists('pl_item_weights'), false);
});
check('导出的接口里不再有 importItemWeights / getItemWeights / itemWeightStats', () => {
  for (const fn of ['importItemWeights', 'getItemWeights', 'itemWeightStats', 'ensureItemWeightSchema']) {
    assert.strictEqual(typeof pdb[fn], 'undefined', `${fn} 应已删除`);
  }
});
check('SKU 克重仍按款色码可读写（唯一来源没受影响）', () => {
  const pid = pdb.upsertProduct({ code: 'W-1', name: '款W1', category: '衣服', supplierId: 0, status: 'active', note: '' });
  pdb.variantUpsert({ id: 0, productId: pid.id, code: '', name: '黑 L', color: '黑', size: 'L', weightG: 320, status: 'active' });
  const rows = pdb.variantList([pid.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].weightG), 320);
});

// ---- 收尾 ----
closeDb();
fs.rmSync(dir, { recursive: true, force: true });

console.log('\u2500'.repeat(64));
console.log(failed === 0 ? '\u2705 全部通过' : `\u274c ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
