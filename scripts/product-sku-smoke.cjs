// 「店铺商品ID → 产品」映射数据层冒烟（不启动 Electron 界面）。
//
// 为什么不用 vitest：同 product-db-smoke —— better-sqlite3 按 **Electron 的 Node ABI**（149）编译，
// vitest 跑在系统 Node（127）上，require 直接抛 ABI 不匹配。纯函数部分（键归一 / 队列聚合 / 匹配）
// 由 `tests/shopSku.spec.ts` 覆盖，本脚本只管 SQL 层。
//
//   npm run product:sku:smoke
//
// 覆盖：建表幂等、批量关联（行级失败不整批回滚）、商品ID/平台归一后同键、店铺与产品存在性校验、
// 待关联队列的实时聚合（含「删订单后立刻少一组」这条证明它不是缓存表）、resolve 只认 confirmed、
// invalidate 不物理删除、映射列表过滤与汇总，以及 P3 的验收原文两条。
//
// 夹具用**真实结构**（走 shop-db / order-db 的 ensure + 各自 upsert 接口），不手搓同构小表 ——
// 结构被抹平的夹具会让依赖该结构的错误实现恒绿。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-sku-smoke-'));

const { initDb, closeDb, dbRun, dbGet, dbQuery } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));

initDb(path.join(dir, 'smoke.db'));
pdb.ensureProductSchema();
pdb.ensureSkuSchema();
sdb.ensureShopSchema();
odb.ensureOrderSchema();

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

// ---- 夹具 ----

const PLATFORMS = ['amazon', 'shopee', 'temu', 'aliexpress', 'lazada'];

function reset() {
  for (const t of ['pl_shop_sku', 'pl_products', 'sk_shops', 'sk_name_map', 'oi_orders', 'oi_images']) {
    dbRun(`DELETE FROM ${t}`);
  }
  imageId = 0; // 图片行被清了，缓存 id 会变成外键悬空值
}

/** 建 N 家店（真实走 shop-db，故 name_key 等派生列与线上一致） */
function seedShops(n = 5) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const r = sdb.upsertShop({
      id: 0,
      platform: PLATFORMS[i - 1] || 'amazon',
      name: `店铺${i}`,
      site: '',
      shopSetId: 0,
      status: 'active',
      openedAt: '',
      note: '',
    });
    ids.push(r.id);
  }
  return ids;
}

/** 把店铺原文「店N」人工归一到第 N 家店（模拟 S1 登记页的采纳动作） */
function mapShopNames(n = 5) {
  const shops = sdb.listShops({ offset: 0, limit: 50, search: '', platform: '', status: '' }).rows;
  for (let i = 1; i <= n; i++) {
    const shop = shops.find((s) => s.name === `店铺${i}`);
    sdb.mapName({ raw: `店${i}`, refId: shop.id, ignored: false });
  }
}

/**
 * 按**名字**取店铺。
 * ⚠️ 不能拿 `listShops()` 的下标当 `seedShops()` 的返回值用：前者按 `platform ASC, name ASC`
 * 排序，后者是插入序（amazon/shopee/temu/aliexpress/lazada）—— 两者不是一回事。
 * 用下标会让断言"因为取错了对象而通过/失败"，且失败信息完全指向错误方向（"靠位置取值"的同类坑）。
 */
function shopByName(name) {
  const rows = sdb.listShops({ offset: 0, limit: 200, search: '', platform: '', status: '' }).rows;
  const hit = rows.find((s) => s.name === name);
  assert.ok(hit, `夹具缺店铺：${name}`);
  return hit;
}

/** 按编码取产品（同上，别用下标） */
function productByCode(code) {
  const r = pdb.listProducts({ offset: 0, limit: 200, search: code, status: '', supplierId: 0 });
  const hit = r.rows.find((x) => x.code === code);
  assert.ok(hit, `夹具缺产品：${code}`);
  return hit;
}

function seedProducts(n, prefix = 'P') {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const r = pdb.upsertProduct({
      id: 0,
      code: `${prefix}-${String(i).padStart(4, '0')}`,
      name: `产品${i}`,
      supplierId: 0,
      category: '',
      status: 'active',
      note: '',
    });
    ids.push(r.id);
  }
  return ids;
}

/** 订单行（raw_fields 是 JSON 文本，与线上同形态） */
let imageId = 0;
function seedOrders(rows) {
  if (!imageId) {
    imageId = dbRun(
      `INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
      ['fp-smoke', 'ufp-smoke', '', ''],
    ).lastInsertRowid;
  }
  let n = 0;
  for (const r of rows) {
    dbRun(`INSERT INTO oi_orders (image_id, order_no, shop, raw_fields) VALUES (?,?,?,?)`, [
      imageId,
      `SO-${++n}`,
      r.shop,
      JSON.stringify(r.fields),
    ]);
  }
}

const skuRow = (over = {}) => ({
  platform: 'amazon',
  shopId: 1,
  itemId: 'B0X1',
  productId: 1,
  ...over,
});

const queryMap = (payload = {}) =>
  pdb.listSkuMappings({ offset: 0, limit: 100, search: '', status: '', shopId: 0, ...payload });

console.log('\n店铺商品ID → 产品映射冒烟（pl_shop_sku）\n' + '\u2500'.repeat(64));

// ---- 建表 ----
check('ensureSkuSchema 幂等（连调两次不抛错）', () => {
  pdb.ensureSkuSchema();
  pdb.ensureSkuSchema();
  const n = dbGet(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'pl_shop_sku'`);
  assert.strictEqual(Number(n.c), 1);
});

// ---- 批量关联 ----
check('批量关联写入成功，可按店铺/商品回查，并派生出产品编码与店名', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(2);
  const out = pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'B0AAAA', productId: products[0] },
    { platform: 'shopee', shopId: shops[1], itemId: 'B0BBBB', productId: products[1] },
  ]);
  assert.strictEqual(out.created, 2);
  assert.strictEqual(out.failed.length, 0);
  const r = queryMap();
  assert.strictEqual(r.total, 2);
  const a = r.rows.find((x) => x.itemId === 'B0AAAA');
  assert.strictEqual(a.productCode, 'P-0001');
  assert.strictEqual(a.productName, '产品1');
  assert.strictEqual(a.shopName, '店铺1');
  assert.strictEqual(a.spec, '*', '一期 spec 恒 *');
  assert.strictEqual(a.source, 'manual');
});

check('同一 (平台,店铺,商品,规格) 重复关联 → 更新而非新增（四列 UNIQUE 生效）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(2);
  const row = { platform: 'amazon', shopId: shops[0], itemId: 'B0X1', productId: products[0] };
  assert.strictEqual(pdb.upsertSkuMappings([row]).created, 1);
  const out = pdb.upsertSkuMappings([{ ...row, productId: products[1] }]);
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.updated, 1);
  const r = queryMap();
  assert.strictEqual(r.total, 1, '同键写成了两行 —— 精确命中会立刻歧义');
  assert.strictEqual(r.rows[0].productCode, 'P-0002');
});

check('商品ID 与平台先归一：只差空白/不可见字符不得写成两行', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  const base = { platform: 'amazon', shopId: shops[0], productId: products[0] };
  const out = pdb.upsertSkuMappings([
    { ...base, itemId: 'B0X1' },
    { ...base, itemId: ' B0X1 ' },
    { ...base, itemId: 'B0\u200bX1' },
    { ...base, platform: ' shopee ', itemId: 'B0X1' },
  ]);
  assert.strictEqual(out.failed.length, 0);
  assert.strictEqual(out.created, 2, '归一后应只有两行：amazon 一行 + shopee 一行');
  assert.strictEqual(queryMap().total, 2);
});

check('店铺不存在 → 该行失败，其余行照常入库（不做整批回滚）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  const out = pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: 999999, itemId: 'B0BAD', productId: products[0] },
    { platform: 'amazon', shopId: shops[0], itemId: 'B0OK', productId: products[0] },
  ]);
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.failed.length, 1);
  assert.ok(/店铺不存在/.test(out.failed[0].message));
  assert.strictEqual(queryMap().total, 1);
});

check('产品不存在 → 该行失败（否则界面显示"已关联"而实际指向空产品）', () => {
  reset();
  const shops = seedShops();
  const out = pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'B0NO', productId: 888888 },
  ]);
  assert.strictEqual(out.created, 0);
  assert.ok(/产品不存在/.test(out.failed[0].message));
});

check('商品ID 为空 / 店铺未选 → 失败（不写成空键共用一行）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  const out = pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: '   ', productId: products[0] },
    { platform: 'amazon', shopId: 0, itemId: 'B0X1', productId: products[0] },
  ]);
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.failed.length, 2);
  assert.ok(out.failed.some((f) => /商品ID不能为空/.test(f.message)));
  assert.ok(out.failed.some((f) => /请选择店铺/.test(f.message)));
  assert.strictEqual(queryMap().total, 0);
});

// ---- 解析 ----
check('resolveSkuBatch 命中返回产品编码与名称', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'B0X1', productId: products[0] },
  ]);
  const [hit] = pdb.resolveSkuBatch([{ platform: 'amazon', shopId: shops[0], itemId: 'B0X1' }]);
  assert.strictEqual(hit.matched, true);
  assert.strictEqual(hit.productCode, 'P-0001');
  assert.strictEqual(hit.productName, '产品1');
});

check('resolveSkuBatch 未命中 / 平台或店铺不同 → matched=false（不跨店复用）', () => {
  const s1 = shopByName('店铺1'); // amazon，有 B0X1 的映射
  const s2 = shopByName('店铺2'); // shopee，没有
  const r = pdb.resolveSkuBatch([
    { platform: 'amazon', shopId: s1.id, itemId: 'B0NOTHERE' },
    { platform: 'shopee', shopId: s2.id, itemId: 'B0X1' },
    // 同平台同商品、但换了店铺 —— 这条才是"不跨店复用"的真守卫
    { platform: 'amazon', shopId: s2.id, itemId: 'B0X1' },
  ]);
  assert.deepStrictEqual(
    r.map((x) => x.matched),
    [false, false, false]
  );
  assert.strictEqual(r[0].productId, 0);
});

check('resolveSkuBatch 入参方也走归一：多一个空格仍命中', () => {
  const s1 = shopByName('店铺1');
  const [hit] = pdb.resolveSkuBatch([{ platform: 'amazon', shopId: s1.id, itemId: ' B0X1 ' }]);
  assert.strictEqual(hit.matched, true);
});

check('只有 confirmed 才算命中：pending 不命中（没确认的映射不得替人下结论）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    {
      platform: 'amazon',
      shopId: shops[0],
      itemId: 'B0PEND',
      productId: products[0],
      status: 'pending',
    },
  ]);
  const [hit] = pdb.resolveSkuBatch([{ platform: 'amazon', shopId: shops[0], itemId: 'B0PEND' }]);
  assert.strictEqual(hit.matched, false);
  assert.strictEqual(queryMap().total, 1, 'pending 行本身要留在表里（等人确认）');
});

check('invalidate 标失效后不命中，但行**仍在**（不物理删除）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'B0INV', productId: products[0] },
  ]);
  const id = queryMap().rows[0].id;
  assert.strictEqual(pdb.invalidateSkuMapping(id).changed, true);
  const [hit] = pdb.resolveSkuBatch([{ platform: 'amazon', shopId: shops[0], itemId: 'B0INV' }]);
  assert.strictEqual(hit.matched, false);
  assert.strictEqual(queryMap().total, 1);
  assert.strictEqual(queryMap({ status: 'invalid' }).rows[0].itemId, 'B0INV');
});

check('失效后可恢复：重新关联同键 → status 回到 confirmed 且计数为 updated', () => {
  const out = pdb.upsertSkuMappings([
    {
      platform: 'amazon',
      shopId: shopByName('店铺1').id,
      itemId: 'B0INV',
      productId: productByCode('P-0001').id,
    },
  ]);
  assert.strictEqual(out.updated, 1);
  assert.strictEqual(out.created, 0);
  const [hit] = pdb.resolveSkuBatch([
    { platform: 'amazon', shopId: shopByName('店铺1').id, itemId: 'B0INV' },
  ]);
  assert.strictEqual(hit.matched, true);
});

// ---- 待关联队列 ----
check('队列按 (店铺, 商品ID) 聚合，覆盖行数正确，已关联的不进队列', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  mapShopNames(1); // 只归一「店1」—— 店2 保持未归一，用来验阻塞分支
  seedOrders([
    { shop: '店1', fields: { 商品ID: 'B0X1', 商品标题: 'T恤' } },
    { shop: '店1', fields: { 商品ID: 'B0X1', 商品标题: 'T恤' } },
    { shop: '店1', fields: { 商品ID: 'B0X2' } },
    { shop: '店2', fields: { 商品ID: 'B0X1' } },
  ]);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'B0X1', productId: products[0] },
  ]);

  const q = pdb.shopSkuQueue();
  assert.strictEqual(q.stats.withItemId, 4);
  assert.strictEqual(q.stats.withoutItemId, 0);
  assert.strictEqual(q.stats.groups, 3, '店1×B0X1 / 店1×B0X2 / 店2×B0X1');
  assert.strictEqual(q.stats.mapped, 1, '店1×B0X1 已关联');
  assert.strictEqual(q.rows.length, 2);
  assert.strictEqual(q.stats.unmapped + q.stats.shopUnresolved + q.stats.mapped, q.stats.groups);
  // 店2 未归一 → 阻塞项；店1×B0X2 可关联
  const blocked = q.rows.find((r) => r.shopKey === '店2');
  assert.strictEqual(blocked.status, 'shopUnresolved');
  assert.strictEqual(blocked.shopId, 0);
  const ready = q.rows.find((r) => r.itemId === 'B0X2');
  assert.strictEqual(ready.status, 'unmapped');
  assert.strictEqual(ready.platform, 'amazon');
  assert.strictEqual(ready.orderCount, 1);
});

check('队列：店铺未归一时**不允许**写映射（写时被店铺校验拦下）', () => {
  const out = pdb.upsertSkuMappings([
    { platform: '', shopId: 0, itemId: 'B0X1', productId: 1 },
  ]);
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.failed.length, 1);
});

check('队列是**实时**的：删掉订单后立刻少一组（证明不是缓存表）', () => {
  const before = pdb.shopSkuQueue();
  dbRun(`DELETE FROM oi_orders WHERE shop = '店1' AND raw_fields LIKE '%B0X2%'`);
  const after = pdb.shopSkuQueue();
  assert.strictEqual(before.stats.groups, 3);
  assert.strictEqual(after.stats.groups, 2, '删了订单队列没变 → 说明算的是一张会放陈的缓存表');
});

check('队列：没有商品ID 的订单行必须计数报出（防无声丢行）', () => {
  reset();
  seedShops();
  mapShopNames();
  seedOrders([
    { shop: '店1', fields: { 商品ID: 'B0Y1' } },
    { shop: '店1', fields: { 数量: '3', 订单号: 'SO-X' } },
  ]);
  const q = pdb.shopSkuQueue();
  assert.strictEqual(q.stats.withItemId, 1);
  assert.strictEqual(q.stats.withoutItemId, 1);
});

check('队列给出未归一店铺清单（界面要靠它提示"先去登记哪些店"）', () => {
  reset();
  seedShops();
  mapShopNames();
  seedOrders([
    { shop: '店1', fields: { 商品ID: 'B0Z1' } },
    { shop: '野店A', fields: { 商品ID: 'B0Z2' } },
    { shop: '野店B', fields: { 商品ID: 'B0Z3' } },
  ]);
  const q = pdb.shopSkuQueue();
  assert.deepStrictEqual(q.stats.unresolvedShops, ['野店A', '野店B']);
});

check('队列：同名唯一命中只作建议（autoShopId），不因此视为已归一', () => {
  reset();
  seedShops();
  // 不调用 mapShopNames：sk_name_map 为空，但 sk_shops 里有「店铺1」
  seedOrders([{ shop: '店铺1', fields: { 商品ID: 'B0AUTO' } }]);
  const q = pdb.shopSkuQueue();
  assert.strictEqual(q.rows[0].status, 'shopUnresolved');
  assert.strictEqual(q.rows[0].shopId, 0);
  assert.ok(q.rows[0].autoShopId > 0, '同名唯一命中应给出建议店铺 id');
  assert.strictEqual(q.rows[0].autoShopPlatform, 'amazon');
});

// ---- 列表与汇总 ----
check('映射列表：按状态 / 店铺过滤，total 为过滤后总数', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(2);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'F1', productId: products[0] },
    { platform: 'amazon', shopId: shops[1], itemId: 'F2', productId: products[0] },
    { platform: 'amazon', shopId: shops[0], itemId: 'F3', productId: products[1], status: 'pending' },
  ]);
  assert.strictEqual(queryMap().total, 3);
  assert.strictEqual(queryMap({ status: 'pending' }).rows.map((r) => r.itemId).join(','), 'F3');
  assert.strictEqual(queryMap({ shopId: shops[0] }).total, 2);
  assert.strictEqual(queryMap({ search: 'F2' }).total, 1);
  assert.strictEqual(queryMap({ limit: 1 }).rows.length, 1);
  assert.strictEqual(queryMap({ limit: 1 }).total, 3);
});

check('映射汇总：总数 / 状态分布 / 按店铺（店铺被删也留行，不隐藏）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'S1', productId: products[0] },
    { platform: 'shopee', shopId: shops[1], itemId: 'S2', productId: products[0] },
    { platform: 'shopee', shopId: shops[1], itemId: 'S3', productId: products[0], status: 'invalid' },
  ]);
  const s = pdb.skuMapSummary();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.byStatus.find((x) => x.status === 'confirmed').count, 2);
  assert.strictEqual(s.byStatus.find((x) => x.status === 'invalid').count, 1);
  assert.strictEqual(s.byShop.length, 2);
  assert.strictEqual(s.byShop[0].count, 2);
  assert.strictEqual(s.byShop[0].shopName, '店铺2');

  const before = pdb.skuMapSummary().total;
  dbRun(`DELETE FROM sk_shops WHERE id = ?`, [shops[1]]);
  const after = pdb.skuMapSummary();
  assert.strictEqual(after.total, before, '映射行不该因店铺被删而消失');
  assert.strictEqual(after.byShop.find((x) => x.shopId === shops[1]).shopName, '');
});

// ---- P3 验收原文 ----
// 验收原文①：「导入 1000 行陌生订单 → 全部进待关联队列、无丢行」
check('验收①：1000 行陌生订单 → 1000 组全部进队列，无丢行', () => {
  reset();
  seedShops(5);
  mapShopNames(5);
  const rows = [];
  for (let s = 1; s <= 5; s++) {
    for (let i = 1; i <= 200; i++) {
      rows.push({ shop: `店${s}`, fields: { 商品ID: `IT-${s}-${i}`, 商品标题: `商品${s}-${i}` } });
    }
  }
  seedOrders(rows);
  const q = pdb.shopSkuQueue({ limit: 5000 });
  assert.strictEqual(q.stats.withItemId, 1000);
  assert.strictEqual(q.stats.withoutItemId, 0, '不许有行掉出统计');
  assert.strictEqual(q.stats.groups, 1000);
  assert.strictEqual(q.stats.unmapped, 1000);
  assert.strictEqual(q.stats.shopUnresolved, 0);
  assert.strictEqual(q.rows.length, 1000);
  assert.strictEqual(q.stats.truncated, false);
});

// 验收原文②：「批量确认后二次导入 1000 行 → 100% 自动命中」
check('验收②：批量确认后同一批 1000 个商品 100% 命中', () => {
  // 承上：店与订单都还在（不 reset），只是还没关联任何商品
  const shops = sdb
    .listShops({ offset: 0, limit: 50, search: '', platform: '', status: '' })
    .rows.sort((a, b) => (a.name < b.name ? -1 : 1));
  assert.strictEqual(shops.length, 5, '承上用例的 5 家店应仍在');
  const products = seedProducts(20, 'V');

  // 每个商品分配到一个产品上（20 个产品轮转）。**平台取店铺实体自己的平台** ——
  // 映射键是 (平台,店铺,商品)，平台写错会让"确认过却仍不进映射"变成查不出的悬案。
  const rows = [];
  for (let s = 1; s <= 5; s++) {
    const shop = shops[s - 1];
    for (let i = 1; i <= 200; i++) {
      rows.push({
        platform: shop.platform,
        shopId: shop.id,
        itemId: `IT-${s}-${i}`,
        productId: products[(s * 200 + i) % products.length],
      });
    }
  }
  const out = pdb.upsertSkuMappings(rows);
  assert.strictEqual(out.failed.length, 0, `批量确认不该有失败行：${JSON.stringify(out.failed.slice(0, 3))}`);
  assert.strictEqual(out.created, 1000);
  const q = pdb.shopSkuQueue({ limit: 5000 });
  assert.strictEqual(q.stats.groups, 1000);
  assert.strictEqual(q.stats.mapped, 1000, '确认过的商品必须全部退出队列');
  assert.strictEqual(q.rows.length, 0);

  // 二次「导入」等价于对同一批 (平台,店铺,商品) 再解一次
  const keys = rows.map((r) => ({ platform: r.platform, shopId: r.shopId, itemId: r.itemId }));
  const resolved = pdb.resolveSkuBatch(keys);
  const hit = resolved.filter((r) => r.matched).length;
  assert.strictEqual(hit, 1000, `期望 1000 命中，实际 ${hit}`);
  assert.ok(resolved.every((r) => r.productCode), '命中必须带出产品编码，否则界面无法显示');
});

// ---- 收尾 ----
closeDb();
fs.rmSync(dir, { recursive: true, force: true });

console.log('\u2500'.repeat(64));
console.log(failed === 0 ? '\u2705 全部通过' : `\u274c ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
