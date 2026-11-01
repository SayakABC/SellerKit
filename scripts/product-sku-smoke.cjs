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
// invalidate 不物理删除、映射列表过滤与汇总、人工核对回流的存量回填，以及 P3 的验收原文两条；
// 以及**补色通道**（2026-10-10：改色=替换同一条绑定 + 占位「未分类」上的存量订单跟着补色）。
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
const sidb = require(path.join(ROOT, 'dist', 'electron', 'shop-item-db.js'));

initDb(path.join(dir, 'smoke.db'));
pdb.ensureProductSchema();
pdb.ensureSkuSchema();
sdb.ensureShopSchema();
odb.ensureOrderSchema();
sidb.ensureShopItemSchema(); // 「商品ID 反查采集快照」那一组要用真表

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
  for (const t of ['pl_shop_sku', 'pl_products', 'sk_shops', 'sk_name_map', 'oi_orders', 'md_images', 'pl_shop_items', 'oi_color_aliases']) {
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

/** 订单行（raw_fields 是 JSON 文本，与线上同形态）。拆表后：主表（order_no+shop）+ 明细（image_id+raw_fields） */
let imageId = 0;
function seedOrders(rows) {
  if (!imageId) {
    imageId = dbRun(
      `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
      ['fp-smoke', 'ufp-smoke', '', ''],
    ).lastInsertRowid;
  }
  let n = 0;
  for (const r of rows) {
    const no = `SO-${++n}`;
    dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES (?,?)`, [no, r.shop]);
    const h = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = ?`, [no]).id);
    dbRun(`INSERT INTO oi_order_items (order_id, image_id, raw_fields) VALUES (?,?,?)`, [
      h,
      imageId,
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

check('商品ID 先归一：只差空白/不可见字符不得写成两行（**平台不参与身份**）', () => {
  reset();
  const shops = seedShops();
  const products = seedProducts(1);
  const base = { platform: 'amazon', shopId: shops[0], productId: products[0] };
  // 2026-10-20 起身份 = (店铺, 商品ID)：同一个店下的同一个商品只可能有一条绑定 ——
  // 以前"同店写 amazon 与 shopee 各一行"是允许的，那正是"平台副本参与判重"的残留
  const out = pdb.upsertSkuMappings([
    { ...base, itemId: 'B0X1' },
    { ...base, itemId: ' B0X1 ' },
    { ...base, itemId: 'B0\u200bX1' },
  ]);
  assert.strictEqual(out.failed.length, 0);
  assert.strictEqual(out.created, 1, '归一后应只有一行');
  assert.strictEqual(queryMap().total, 1);
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

check('resolveSkuBatch 未命中 / **店铺不同** → matched=false（不跨店复用）', () => {
  const s1 = shopByName('店铺1'); // amazon，有 B0X1 的映射
  const s2 = shopByName('店铺2'); // shopee，没有
  const r = pdb.resolveSkuBatch([
    { platform: 'amazon', shopId: s1.id, itemId: 'B0NOTHERE' },
    { platform: 'shopee', shopId: s2.id, itemId: 'B0X1' },
    // 同商品、但换了店铺 —— 这条才是"不跨店复用"的真守卫
    { platform: 'amazon', shopId: s2.id, itemId: 'B0X1' },
  ]);
  assert.deepStrictEqual(
    r.map((x) => x.matched),
    [false, false, false]
  );
  assert.strictEqual(r[0].productId, 0);
});

check('resolveSkuBatch：平台参数不参与匹配（同店同商品，传什么平台都命中）', () => {
  const s1 = shopByName('店铺1');
  const rows = pdb.resolveSkuBatch([
    { platform: 'amazon', shopId: s1.id, itemId: 'B0X1' },
    { platform: 'temu', shopId: s1.id, itemId: 'B0X1' },
    { shopId: s1.id, itemId: 'B0X1' }, // 调用方手上没有平台时也得能解析
  ]);
  assert.deepStrictEqual(
    rows.map((x) => x.matched),
    [true, true, true],
  );
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
  dbRun(
    `DELETE FROM oi_order_items WHERE raw_fields LIKE '%B0X2%'
       AND order_id IN (SELECT id FROM oi_orders WHERE shop = '店1')`,
  );
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

check('映射列表：按**款**反向过滤 —— 只出这一款的行（同店另一款不得串进来）', () => {
  reset();
  const shops = seedShops(2);
  const products = seedProducts(3);
  pdb.upsertSkuMappings([
    // 同一款挂在两家店 → 两条都该出（反向过滤不是"取第一条"）
    { platform: 'amazon', shopId: shops[0], itemId: 'R1', productId: products[0] },
    { platform: 'shopee', shopId: shops[1], itemId: 'R2', productId: products[0] },
    // 同一家店的**另一个款** → 一条都不该出（按 shop 过滤的实现会在这里蒙对，所以要同时钉住"不串款"）
    { platform: 'amazon', shopId: shops[0], itemId: 'R3', productId: products[1] },
    { platform: 'amazon', shopId: shops[0], itemId: 'R4', productId: products[2] },
  ]);
  assert.strictEqual(queryMap({ productId: 0 }).total, 4, 'productId=0 是"没指定"，不是"id 为 0"');
  const r0 = queryMap({ productId: products[0] });
  assert.strictEqual(r0.total, 2, `应只出 R1/R2，实际出了 ${r0.rows.map((x) => x.itemId).join(',')}`);
  assert.deepStrictEqual(
    r0.rows.map((x) => x.itemId).sort(),
    ['R1', 'R2'],
  );
  assert.ok(
    r0.rows.every((x) => x.productId === products[0]),
    '反向过滤串了别的款（界面会把别人的商品当成这一款关联的）',
  );
  const r2 = queryMap({ productId: products[2] });
  assert.deepStrictEqual(r2.rows.map((x) => x.itemId), ['R4']);
  assert.strictEqual(r2.total, 1);
});

check('反向过滤默认不替调用方筛状态：confirmed / invalid 要由 status 语义分开', () => {
  reset();
  const shops = seedShops(1);
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'V1', productId: products[0] },
    { platform: 'amazon', shopId: shops[0], itemId: 'V2', productId: products[0], status: 'invalid' },
  ]);
  // 自证非空转：不传 status 时**两行都在**（否则下面的「1」可能只是因为失效行根本没写进去）
  assert.strictEqual(queryMap({ productId: products[0] }).total, 2, '失效行没落库，下面的断言就是空转');
  const live = queryMap({ productId: products[0], status: 'confirmed' });
  assert.strictEqual(live.total, 1, '失效行混进了「已关联」—— 用户会以为那个商品还在用');
  assert.strictEqual(live.rows[0].itemId, 'V1');
  const dead = queryMap({ productId: products[0], status: 'invalid' });
  assert.strictEqual(dead.total, 1, '失效行要能**单列**出来（不是被删掉，人得看得见）');
  assert.strictEqual(dead.rows[0].itemId, 'V2');
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

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ 改店铺「平台」不得废掉该店映射（2026-10-20，身份 = (店铺, 商品ID)）
//
// 映射行的 `platform` 是写映射那刻从店铺行抄来的**副本**。它当匹配键时，在「店铺登记」里
// 改一次平台（哪怕只是 `AE` → `ae`，`toNameKey` 不折叠大小写）就会让该店全部映射一条都不命中；
// 更隐蔽的是重配：四列键都不撞 ⇒ 新增一行，旧行仍 confirmed ⇒ 产品详情把两条都算进"已关联"。
// 本条把四处（认款 / 队列 / 列表展示 / 写入判重）一次钉住 —— 少钉一处就是"改了这处忘了那处"。
// ═══════════════════════════════════════════════════════════════════════════════
check('改店铺平台后：认款仍命中、队列仍算已关联、展示跟店铺走、重配是更新（不新增幽灵行）', () => {
  reset();
  const shops = seedShops();
  mapShopNames();
  const products = seedProducts(2);
  seedOrders([{ shop: '店1', fields: { 商品ID: 'CHG1' } }]);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'CHG1', productId: products[0] },
  ]);
  // 自证前提：改之前四条链路本来就是对的（否则下面的断言可能只是"什么都没发生"）
  assert.strictEqual(pdb.resolveOrderSku({ shop: '店1', itemId: 'CHG1' })?.productCode, 'P-0001');
  assert.strictEqual(pdb.shopSkuQueue().stats.mapped, 1);
  assert.strictEqual(queryMap().rows[0].platform, 'amazon');

  // —— 改平台：等价于「店铺登记」里把下拉框从 amazon 改成 temu（全量提交）——
  sdb.upsertShop({
    id: shops[0],
    platform: 'temu',
    name: '店铺1',
    platformShopId: '',
    shopUrl: '',
    site: '',
    status: 'active',
    openedAt: '',
    note: '',
  });

  const hit = pdb.resolveOrderSku({ shop: '店1', itemId: 'CHG1' });
  assert.strictEqual(hit?.productCode, 'P-0001', '改平台后认款断了 —— 平台不该参与匹配');
  assert.strictEqual(hit?.platform, 'temu', '返回值里的平台要跟店铺当前值（下游写映射用它）');
  assert.strictEqual(pdb.shopSkuQueue().stats.mapped, 1, '队列把已关联的商品塞回了待办（用户得重配一遍）');
  assert.strictEqual(queryMap().rows[0].platform, 'temu', '映射列表还显示旧平台 —— 与店铺登记自相矛盾');
  assert.strictEqual(pdb.skuMapSummary().byPlatform[0].platform, 'temu', '平台汇总仍按旧副本分组');

  // 重配同一条绑定：必须是**更新**。新增 = 旧行永远命中不了的幽灵关联
  const out = pdb.upsertSkuMappings([
    { platform: 'temu', shopId: shops[0], itemId: 'CHG1', productId: products[1] },
  ]);
  assert.strictEqual(out.updated, 1);
  assert.strictEqual(out.created, 0);
  assert.strictEqual(queryMap().total, 1, '改平台后重配新增了一行 —— 产品详情会把两条都算进"已关联"');
  assert.strictEqual(queryMap().rows[0].productCode, 'P-0002', '重配没落到原来那条绑定上');
});

check('改店铺平台**只影响展示**：别的店铺/商品一个都不能跟着变', () => {
  reset();
  const shops = seedShops(2);
  const products = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shops[0], itemId: 'M1', productId: products[0] },
    { platform: 'shopee', shopId: shops[1], itemId: 'M1', productId: products[0] },
  ]);
  sdb.upsertShop({
    id: shops[0], platform: 'temu', name: '店铺1', platformShopId: '', shopUrl: '',
    site: '', status: 'active', openedAt: '', note: '',
  });
  const rows = queryMap().rows;
  assert.strictEqual(rows.find((r) => r.shopId === shops[0]).platform, 'temu');
  assert.strictEqual(rows.find((r) => r.shopId === shops[1]).platform, 'shopee', '没有改的店跟着变了（同商品ID 被串了）');
  // 搜索框按"看到的平台"搜得到（展示已经改了，搜不到就是两套口径）
  assert.strictEqual(queryMap({ search: 'temu' }).total, 1, '按新平台搜不到 —— 用户会以为映射没了');
  assert.strictEqual(queryMap({ search: 'shopee' }).total, 1, '另一家店按自己的平台仍要搜得到');
  // 同商品ID 在两家店各有一条绑定：改其中一家的平台，另一家照样命中
  assert.strictEqual(pdb.resolveSkuBatch([{ shopId: shops[1], itemId: 'M1' }])[0].matched, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ 人工核对**回流**：在「归类核对」页点名某个款 → 顺手记住「(店铺, 商品ID) → 款 + 色」
//
// 为什么必须钉在**数据层**而不是界面：回流的意义是"影响**后续**订单"——
// 写进 `pl_shop_sku` + 回填存量未归款订单，这两件事界面都看不见。
// 假桥冒烟最多只能证明"界面把回执渲染出来了"，证明不了"真的写进去了、写对了对象"。
// ═══════════════════════════════════════════════════════════════════════════════

let fpSeq = 0;

/**
 * 每条订单**自己的**图片行。
 * ⚠️ 不能复用 `seedOrders`（那批订单共用一张图）：回填是按图片算的
 * （`md_images.style_color_id IS NULL`），共用一张图时"回填了几单"根本无法区分。
 */
function seedOrderRows(rows) {
  const ids = [];
  for (const r of rows) {
    fpSeq += 1;
    const img = dbRun(
      `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
      [`fp-cls-${fpSeq}`, `ufp-cls-${fpSeq}`, '', ''],
    ).lastInsertRowid;
    const no = `CO-${fpSeq}`;
    dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES (?,?)`, [no, r.shop]);
    const h = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = ?`, [no]).id);
    const id = dbRun(`INSERT INTO oi_order_items (order_id, image_id, raw_fields) VALUES (?,?,?)`, [
      h,
      img,
      JSON.stringify(r.fields),
    ]).lastInsertRowid;
    ids.push(id);
  }
  return ids;
}

/**
 * 走**真实落库路径**导入订单（`insertOrder` 内含订单落库那一刻的 `autoAssignByMap`）。
 * ⚠️ 不能拿 `seedOrderRows` 顶替：那是裸 INSERT，不触发归款 —— 而"补色通道"验的正是
 * 「落库当时归在占位色上 → 后来补色把图改到真实颜色」这条链，跳过错落库路径就全测不到了。
 */
function importOrderRows(rows) {
  const out = [];
  for (const r of rows) {
    fpSeq += 1;
    let img = r.imageId;
    if (!img) {
      img = dbRun(
        `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
        [`fp-imp-${fpSeq}`, `ufp-imp-${fpSeq}`, r.imageUrl ?? '', ''],
      ).lastInsertRowid;
    }
    const orderId = odb.insertOrder({
      imageId: img,
      orderNo: r.orderNo ?? `IM-${fpSeq}`,
      shop: r.shop,
      size: 'M',
      rawFields: r.fields,
      category: '',
      color: r.color ?? '',
      logo: '',
    });
    out.push({ orderId, imageId: img });
  }
  return out;
}

/**
 * 采集快照夹具（`pl_shop_items.sku_json`）：按图定色要读它。
 * 走 `sidb.upsertShopItems` 的**真实落库路径**（帧形状），不手搓 JSON ——
 * 手搓会把"采集侧颜色/图 URL 存成什么形状"这件事抹平，让错误实现恒绿。
 */
function seedSkuSnapshot(shopId, itemId, skus) {
  const frame = {
    schema: 'ae-shop-item/v1',
    store: {},
    items: [{ itemId, title: `T-${itemId}`, skus }],
  };
  const r = sidb.upsertShopItems(frame, { pinnedShopId: shopId });
  assert.strictEqual(r.inserted ?? 0, 1, `采集快照没落进去：${JSON.stringify(r)}`);
  return r;
}

/**
 * 回流夹具：一家**已归一**的店（店1 → 店铺1 / amazon）+ 产品库里的两个款 + 两条订单。
 * 款走 `importStyles` 建（**真实路径**：同时写 `oi_styles` 与 `adoptProduct`），
 * 不手搓 `oi_styles` 一行 —— 手搓会把"两域锚点"这个最容易取错的地方抹平，让错误实现恒绿。
 */
function seedClassify() {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles']) dbRun(`DELETE FROM ${t}`);
  seedShops(2);
  mapShopNames(2);
  seedProducts(2); // P-0001 / P-0002
  const imp = odb.importStyles([
    { code: 'P-0001', name: '产品1', color: '黑色', fingerprint: 'fp-cls-a' },
    { code: 'P-0002', name: '产品2', color: '白色', fingerprint: 'fp-cls-b' },
  ]);
  assert.strictEqual(imp.errors.length, 0, `建款失败：${JSON.stringify(imp.errors)}`);
  const style1 = Number(dbGet(`SELECT id FROM oi_styles WHERE code = 'P-0001'`).id);
  const style2 = Number(dbGet(`SELECT id FROM oi_styles WHERE code = 'P-0002'`).id);
  return { style1, style2 };
}

/**
 * 某条订单的图片落在哪个款色上（"回填存量"唯一可观测的落点）。
 * 口径就是生产代码的 `ITEM_STYLE_COLOR_ID`（**行优先、图回落**）：R1 之后款色↔图是 1:1，
 * 两张不同的订单图不可能同时挂在同一个色行的 `image_id` 上 —— 只按 `c.image_id = o.image_id`
 * 联表会让"后绑的那张"顶掉先绑的，看起来像订单没归色。
 */
function styleColorOfOrder(orderId) {
  return dbGet(
    `SELECT c.color AS color, s.code AS code FROM oi_order_items oi
       LEFT JOIN oi_style_colors c ON c.id = ${odb.ITEM_STYLE_COLOR_ID}
       LEFT JOIN oi_styles s ON s.id = c.style_id
      WHERE oi.id = ?`,
    [orderId],
  );
}

check('点名某个款 → 把「(店铺, 商品ID) → 款 + 色」记进映射（人工核对不再白干一遍）', () => {
  const { style1 } = seedClassify();
  const [orderId] = seedOrderRows([{ shop: '店1', fields: { 商品ID: 'B0MAP', 商品标题: 'T恤' } }]);
  const res = odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.styleCode, 'P-0001');
  assert.strictEqual(res.skuBackfill.status, 'written');
  assert.strictEqual(res.skuBackfill.spec, '黑色');

  const r = queryMap({ search: 'B0MAP' });
  assert.strictEqual(r.total, 1, '映射没写进去 → 这个商品的下一条订单还会再进一次待核对队列');
  assert.strictEqual(r.rows[0].productCode, 'P-0001');
  assert.strictEqual(r.rows[0].spec, '黑色', '颜色没带上 → 以后自动归类又要"每单看一次图"');
  assert.strictEqual(r.rows[0].status, 'confirmed', 'pending 不生效：回流写了一行却永远不命中，等于白做');
  // 店铺必须是**归一后的实体**：拿原文当键会让映射与待关联队列的键对不上（明明配了却查不中）
  assert.strictEqual(r.rows[0].shopName, '店铺1');
  assert.strictEqual(r.rows[0].platform, 'amazon');
});

check('认款后产品没有主图 → 把这次认款用的订单图采纳为款主图（只补空）', () => {
  const { style1 } = seedClassify();
  const pid = productByCode('P-0001').id;
  assert.strictEqual(
    Number(dbGet(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]).image_id),
    0,
    '夹具前提：产品本来没有主图',
  );
  const [{ orderId, imageId }] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0ADOPT' }, imageId: 0 },
  ]);
  const res = odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.imageId, imageId, '归属结果应带上这次用的订单图');
  assert.strictEqual(
    Number(dbGet(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]).image_id),
    imageId,
    '认款后产品主图应取这次的订单图 —— 否则产品页一直是白图（2026-10-30 用户报）',
  );

  // 再认另一行（另一张图）⇒ 已有主图不许被后来的认款覆盖（人挑过的图优先）
  const [second] = importOrderRows([{ shop: '店1', fields: { 商品ID: 'B0ADOPT2' } }]);
  odb.assignOrderStyle({ orderId: second.orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(
    Number(dbGet(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]).image_id),
    imageId,
    '已有主图的款被后来的认款覆盖了 —— 只补空这条边界必须收在 adoptProductImageIfEmpty',
  );

  // 订单**本身没图**、但这个款色早就有图（历史认款只绑了款色、没绑产品 ⇒ 产品仍是 0）
  // ⇒ 也要把款色现有的图补到产品上 —— 用户说的是"当前款的图片"，不是"当前订单的图片"。
  const scImg = Number(
    dbGet(`SELECT image_id FROM oi_style_colors WHERE style_id = ? AND color = '黑色'`, [style1]).image_id,
  );
  assert.ok(scImg > 0, '夹具前提：这个款色已经绑过图');
  dbRun(`UPDATE pl_products SET image_id = 0 WHERE id = ?`, [pid]);
  const orderNoImg = odb.insertOrder({
    imageId: null,
    orderNo: 'NOIMG-ADOPT',
    shop: '店1',
    size: 'M',
    orderTime: '',
    category: '',
    color: '',
    logo: '',
    rawFields: { 商品ID: 'B0ADOPT3' },
  });
  odb.assignOrderStyle({ orderId: orderNoImg, styleId: style1, color: '黑色' });
  assert.strictEqual(
    Number(dbGet(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]).image_id),
    scImg,
    '订单没图时应采纳款色已有的图（否则这类历史产品永远补不上图）',
  );
});

check('采集商品只有远程图：认款时应挑出「下载后采纳」的待办（只补空 / 一款一张 / 已入库跳过）', () => {
  reset();
  const shops = seedShops(2);
  const products = seedProducts(2);
  sidb.upsertShopItems(
    {
      items: [
        { itemId: 'B0REMOTE2', imageUrl: 'https://example.com/r2.jpg' },
        { itemId: 'B0REMOTE1', imageUrl: 'https://example.com/r1.jpg' },
      ],
    },
    { pinnedShopId: shops[0] },
  );
  const row1 = dbGet(`SELECT id FROM pl_shop_items WHERE item_id = 'B0REMOTE1'`);
  const row2 = dbGet(`SELECT id FROM pl_shop_items WHERE item_id = 'B0REMOTE2'`);

  // ① 产品没主图 + 采集行只有 URL ⇒ 挑出待办，并带上采集行 id（下载后要回填）
  //    同一款给两个商品：取 itemKey 升序的第一个（B0REMOTE1），不依赖入参顺序
  const todo = pdb.pendingRemoteProductImages([
    { productId: products[0], itemId: 'B0REMOTE2' },
    { productId: products[0], itemId: 'B0REMOTE1' },
  ]);
  assert.strictEqual(todo.length, 1, '一个款只挑一张图');
  assert.strictEqual(todo[0].itemId, 'B0REMOTE1', '同款多商品时必须确定性取第一个');
  assert.strictEqual(todo[0].imageUrl, 'https://example.com/r1.jpg');
  assert.strictEqual(todo[0].shopItemId, Number(row1.id), '要带上采集行 id，下载后回填它');

  // ② 产品已有主图 ⇒ 不挑（只补空、不覆盖人的决定）
  dbRun(`UPDATE pl_products SET image_id = 999 WHERE id = ?`, [products[0]]);
  assert.strictEqual(
    pdb.pendingRemoteProductImages([{ productId: products[0], itemId: 'B0REMOTE1' }]).length,
    0,
    '已有主图的款不该再下载覆盖',
  );
  dbRun(`UPDATE pl_products SET image_id = 0 WHERE id = ?`, [products[0]]);

  // ③ 采集行已经入库（image_id 非 0）⇒ 交给第一档本地采纳，这里不再重复下载
  sidb.setShopItemImageId(Number(row2.id), 999);
  assert.strictEqual(
    pdb.pendingRemoteProductImages([{ productId: products[0], itemId: 'B0REMOTE2' }]).length,
    0,
    '已入库的采集图不该再按远程 URL 下一遍',
  );

  // ④ 产品不存在 ⇒ 静默跳过（映射那步已经报过失败）
  assert.strictEqual(
    pdb.pendingRemoteProductImages([{ productId: 888888, itemId: 'B0REMOTE1' }]).length,
    0,
  );
});

check('存量补图取数：全库只认「confirmed + 真映射行」的配对（池行 / 待确认 / 失效 / 无款一律不进）', () => {
  reset();
  const shops = seedShops(2);
  const products = seedProducts(2);
  const shopId = shops[0];
  const run = (itemId, productId, status, source, sid, rawItem = null) =>
    dbRun(
      `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status, source, note)
       VALUES ('amazon', ?, ?, '*', ?, ?, ?, '')`,
      [sid, rawItem ?? itemId, productId, status, source],
    );

  // ① 已确认的真映射（两条，两款）—— 这两条必须被取到
  run('B0PAIR1', products[0], 'confirmed', 'manual', shopId);
  // ② 待确认：还没生效的映射不该替用户决定"这个商品属于哪一款"
  run('B0PAIR2', products[1], 'pending', 'manual', shopId);
  // ③ 已失效：商品ID 变过的历史绑定，成图会挂到错误的款上
  run('B0PAIR3', products[1], 'invalid', 'manual', shopId);
  // ④ 池行（商品清单的套装关联）：source='shop-import'，不是一对一映射
  run('B0POOL', products[0], 'confirmed', 'shop-import', shopId);
  // ⑤ 存量池行（标记落地前导入）：shop_id = 0 就是池行
  run('B0POOL2', products[0], 'confirmed', 'manual', 0);
  // ⑥ 没有归款的池行（product_id = 0）：没有款可补
  run('B0POOL3', 0, 'confirmed', 'manual', shopId);
  // ⑦ 商品ID 原文带空白：出参必须是归一后的键（补图按归一键去查采集行/订单图）
  run('B0PAIR4', products[0], 'confirmed', 'manual', shopId, '  B0PAIR4  ');
  // ⑧ 同一件商品在库里存成两条原文（归一后相同）—— 只该出一个配对，否则"一款只补一张"会漂
  run('B0PAIR1', products[0], 'confirmed', 'manual', shopId, '  B0PAIR1  ');
  // ⑨ 另一款也有一条：出参按产品 id 升序，补图次序可复现
  run('B0PAIR5', products[1], 'confirmed', 'manual', shopId);

  const pairs = pdb.confirmedMapPairs();
  assert.deepStrictEqual(
    pairs,
    [
      { productId: products[0], itemId: 'B0PAIR1' },
      { productId: products[0], itemId: 'B0PAIR4' },
      { productId: products[1], itemId: 'B0PAIR5' },
    ],
    `存量补图的配对取错了：${JSON.stringify(pairs)}`,
  );

  // 自证非空转：同一条改成 pending ⇒ 它立刻从结果里消失（不是"无论状态都返回"）
  dbRun(`UPDATE pl_shop_sku SET status = 'pending' WHERE TRIM(item_id) = 'B0PAIR1'`);
  assert.deepStrictEqual(
    pdb.confirmedMapPairs().map((p) => p.itemId),
    ['B0PAIR4', 'B0PAIR5'],
    '把 confirmed 改成 pending 后仍被取到 —— 状态过滤没生效',
  );
});

check('两个款各自回流 → 各指各的 pl_products.id（锚点取错会张冠李戴）', () => {
  const { style1, style2 } = seedClassify();
  const [oa, ob] = seedOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0AAA' } },
    { shop: '店1', fields: { 商品ID: 'B0BBB' } },
  ]);
  assert.strictEqual(odb.assignOrderStyle({ orderId: oa, styleId: style1, color: '黑色' }).skuBackfill.status, 'written');
  assert.strictEqual(odb.assignOrderStyle({ orderId: ob, styleId: style2, color: '白色' }).skuBackfill.status, 'written');
  const a = queryMap({ search: 'B0AAA' }).rows[0];
  const b = queryMap({ search: 'B0BBB' }).rows[0];
  assert.strictEqual(a.productCode, 'P-0001');
  assert.strictEqual(b.productCode, 'P-0002');
  // 两条映射的 product_id 必须**不同**：实现若拿 oi_styles.id 去填，两个 id 会互换/串行
  assert.notStrictEqual(a.productId, b.productId, '两个款的映射指向了同一个产品');
  assert.strictEqual(a.productId, productByCode('P-0001').id, '映射的 product_id 不是产品库的 id（锚点取错）');
});

check('回流顺带回填**存量**：同一商品还没归款的订单当场一起归好', () => {
  const { style1 } = seedClassify();
  const [o1, o2] = seedOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0FILL' } },
    { shop: '店1', fields: { 商品ID: 'B0FILL' } }, // 同一件商品的另一单，此刻还没归款
  ]);
  assert.strictEqual(styleColorOfOrder(o2).color, null, '夹具前提：第二单本来是未归款的');
  const res = odb.assignOrderStyle({ orderId: o1, styleId: style1, color: '黑色' });
  assert.strictEqual(res.skuBackfill.status, 'written');
  assert.strictEqual(res.skuBackfill.reassigned, 1, '"记忆生效"这件事必须当场在其它订单上看得见');
  const sc = styleColorOfOrder(o2);
  assert.strictEqual(sc.code, 'P-0001');
  assert.strictEqual(sc.color, '黑色', '颜色与映射不一致 → 会有两个款色（同款拆款）');
});

check('⚠️ 不覆盖既有映射：该商品已配别的产品时只回报 conflict，映射一行不动', () => {
  const { style1 } = seedClassify();
  const itemId = 'B0KEEP';
  const shopId = shopByName('店铺1').id;
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId, itemId, spec: '蓝色', productId: productByCode('P-0002').id },
  ]);
  const before = dbGet(
    `SELECT id, product_id, spec, status, source FROM pl_shop_sku WHERE item_id = ?`,
    [itemId],
  );

  const [orderId] = seedOrderRows([{ shop: '店1', fields: { 商品ID: itemId } }]);
  const res = odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.styleCode, 'P-0001', '归属本身必须照常改（回流只是附加动作）');
  assert.strictEqual(res.skuBackfill.status, 'conflict');
  assert.strictEqual(res.skuBackfill.conflictCode, 'P-0002');

  const rows = queryMap({ search: itemId }).rows;
  assert.strictEqual(rows.length, 1, '冲突时不该新增一行');
  assert.strictEqual(rows[0].productCode, 'P-0002', '既有映射被改绑了 —— 它会影响那个商品**所有**订单');
  const after = dbGet(`SELECT id, product_id, spec, status, source FROM pl_shop_sku WHERE item_id = ?`, [itemId]);
  assert.deepStrictEqual(after, before, '冲突分支不该动既有行（连 source/更新时刻都不该刷）');
  // 自证非空转：同一个 (店, 商品) 换个没有映射的商品ID 时**会**写 success —— 说明 conflict
  // 不是"因为整条链路都写不进去"才出现的
  const [other] = seedOrderRows([{ shop: '店1', fields: { 商品ID: 'B0FREE' } }]);
  assert.strictEqual(
    odb.assignOrderStyle({ orderId: other, styleId: style1, color: '黑色' }).skuBackfill.status,
    'written',
  );
});

check('颜色只填不猜：没有可信颜色时只记到**款级**（`*`），不把占位名固化成结论', () => {
  const { style1 } = seedClassify();
  const [o1, o2] = seedOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0NOC1' } },
    { shop: '店1', fields: { 商品ID: 'B0NOC2' } },
  ]);
  const r1 = odb.assignOrderStyle({ orderId: o1, styleId: style1, color: '' });
  assert.strictEqual(r1.skuBackfill.status, 'written');
  assert.strictEqual(r1.skuBackfill.spec, '');
  assert.strictEqual(queryMap({ search: 'B0NOC1' }).rows[0].spec, '*');

  const r2 = odb.assignOrderStyle({ orderId: o2, styleId: style1, color: '未分类' });
  assert.strictEqual(r2.skuBackfill.spec, '');
  assert.strictEqual(
    queryMap({ search: 'B0NOC2' }).rows[0].spec,
    '*',
    '把兜底名写成颜色 → 该商品以后永远回不到"颜色从订单取"',
  );
});

check('已有**款级**映射时点名带色 → 补成带色（**替换**款级行，不并排留一条永远命不中的旧行）', () => {
  const { style1 } = seedClassify();
  const itemId = 'B0UP';
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shopByName('店铺1').id, itemId, productId: productByCode('P-0001').id },
  ]);
  assert.strictEqual(pdb.resolveOrderSku({ shop: '店1', itemId }).spec, '', '夹具前提：先只有款级映射');
  const [orderId] = seedOrderRows([{ shop: '店1', fields: { 商品ID: itemId } }]);
  const res = odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.skuBackfill.status, 'written', '同产品+能补色时不该判成 already');
  assert.strictEqual(pdb.resolveOrderSku({ shop: '店1', itemId }).spec, '黑色', '带色行没生效');
  assert.strictEqual(
    queryMap({ search: itemId }).total,
    1,
    '补色并排留了一条款级旧行（永远命中不了，却出现在映射列表里）',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ 补色通道（2026-10-10）：映射补上颜色 → 挂占位「未分类」的存量订单一起改到该色
//
// 为什么单列一节：这是「货与成本 › 商品ID 映射」改绑时的用户动作，验的是两条**跨层**语义——
//   ① 改色 = **改同一条绑定**（`upsertSkuMappings` 的 twin 替换，旧的 `*` 行不留）；
//   ② 回填覆盖**占位色**（`reassignOrdersByItemIds`），已挂在真实颜色上的图一律不动。
// 两条都只改数据层：界面上只看得到"映射列表少了一行 + 订单都换了色"——不钉在这里就没人守得住。
// ═══════════════════════════════════════════════════════════════════════════════

check('补色通道：映射补上颜色 → 挂占位「未分类」的存量订单一起改到该色（且不留旧映射行）', () => {
  seedClassify();
  const shopId = shopByName('店铺1').id;
  const itemId = 'B0COLOR';
  const pid = productByCode('P-0001').id;

  // ① 初始形态 = 真库现状：只到款、没有色（spec='*'）；订单落库当时颜色只能兜底成占位色
  assert.strictEqual(
    pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId, productId: pid }]).created,
    1,
  );
  const [{ orderId: o1 }, { orderId: o2 }] = importOrderRows([
    { shop: '店1', fields: { 商品ID: itemId } },
    { shop: '店1', fields: { 商品ID: itemId } },
  ]);
  assert.strictEqual(styleColorOfOrder(o1).color, '未分类', '夹具前提：订单此刻应归在占位色上');
  assert.strictEqual(styleColorOfOrder(o2).color, '未分类');

  // ② 改绑补色（同产品）→ 替换原款级行，不是并排新增
  const col = pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId, spec: '黑色', productId: pid }]);
  assert.strictEqual(col.created, 0, '补色写成了新增 —— 旧款级行留在列表里、却永远命中不了');
  assert.strictEqual(col.updated, 1);
  assert.strictEqual(queryMap({ search: itemId }).total, 1, '同商品补色后应只有一条映射（改色 = 改同一条绑定）');
  assert.strictEqual(queryMap({ search: itemId }).rows[0].spec, '黑色');

  // ③ 回填：占位色上的两条存量订单跟着改到「黑色」
  assert.strictEqual(odb.reassignOrdersByItemIds([itemId]), 2, '补色没回填存量订单 —— 用户看不到任何变化');
  assert.strictEqual(styleColorOfOrder(o1).code, 'P-0001');
  assert.strictEqual(styleColorOfOrder(o1).color, '黑色');
  assert.strictEqual(styleColorOfOrder(o2).color, '黑色');

  // ④ 再补一个不同的色：映射仍是一条（继续替换）；但订单已挂在**真实颜色**上 → 不跟着改判
  //（"补过的色"也是结论，改一次映射不能把历史订单全洗一遍）
  const again = pdb.upsertSkuMappings([{ platform: 'amazon', shopId, itemId, spec: '白色', productId: pid }]);
  assert.strictEqual(again.updated, 1);
  assert.strictEqual(queryMap({ search: itemId }).total, 1);
  assert.strictEqual(queryMap({ search: itemId }).rows[0].spec, '白色');
  assert.strictEqual(odb.reassignOrdersByItemIds([itemId]), 0, '挂在真实颜色上的图被重判了');
  assert.strictEqual(styleColorOfOrder(o1).color, '黑色', '已定色的订单被改色 —— 改一次映射把历史订单全洗了');
});

check('补色通道的**边界**：同商品把不同颜色绑到不同产品 → 新增绑定（不把既有那条替换掉）', () => {
  seedClassify();
  const shopId = shopByName('店铺1').id;
  const itemId = 'B0TWIN';
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId, itemId, spec: '黑色', productId: productByCode('P-0001').id },
  ]);
  const out = pdb.upsertSkuMappings([
    { platform: 'amazon', shopId, itemId, spec: '白色', productId: productByCode('P-0002').id },
  ]);
  assert.strictEqual(out.created, 1, '不同产品的带色绑定被当成"改色"替换掉了 —— 会悄悄改掉另一种颜色的归属');
  assert.strictEqual(out.updated, 0);
  const rows = queryMap({ search: itemId }).rows;
  assert.strictEqual(rows.length, 2, '两条合法绑定应并存（同商品不同颜色绑不同产品是既有形态）');
  assert.strictEqual(rows.find((r) => r.spec === '黑色').productCode, 'P-0001', '黑色那条被误替换了');
  assert.strictEqual(rows.find((r) => r.spec === '白色').productCode, 'P-0002');
});

check('重复点名同一个款 → already（不新增行、不重复写）', () => {
  const { style1 } = seedClassify();
  const [orderId] = seedOrderRows([{ shop: '店1', fields: { 商品ID: 'B0DUP' } }]);
  assert.strictEqual(odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' }).skuBackfill.status, 'written');
  const again = odb.assignOrderStyle({ orderId, styleId: style1, color: '黑色' });
  assert.strictEqual(again.skuBackfill.status, 'already');
  assert.strictEqual(queryMap({ search: 'B0DUP' }).total, 1, '重复点名写成了两行');
});

check('回流的三条"不写"分支：无商品ID / 店铺未归一 / 产品库没这个款', () => {
  const { style1 } = seedClassify();
  // ① 订单里没有商品ID列
  const [noId] = seedOrderRows([{ shop: '店1', fields: { 订单号: 'X-1', 数量: '2' } }]);
  assert.strictEqual(odb.assignOrderStyle({ orderId: noId, styleId: style1, color: '黑色' }).skuBackfill.status, 'noItemId');
  // ② 店铺还没归一（野店不在 sk_name_map 里）
  const [wild] = seedOrderRows([{ shop: '野店A', fields: { 商品ID: 'B0WILD' } }]);
  assert.strictEqual(odb.assignOrderStyle({ orderId: wild, styleId: style1, color: '黑色' }).skuBackfill.status, 'shopUnresolved');
  // ③ 产品库里没有这个款编码（老库还没跑交接）：直接造一个只有 oi_styles 的款
  dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES ('STYLE-777', 'fp-cls-orphan')`);
  const orphanId = Number(dbGet(`SELECT id FROM oi_styles WHERE code = 'STYLE-777'`).id);
  const [orphanOrder] = seedOrderRows([{ shop: '店1', fields: { 商品ID: 'B0ORPH' } }]);
  assert.strictEqual(
    odb.assignOrderStyle({ orderId: orphanOrder, styleId: orphanId, color: '黑色' }).skuBackfill.status,
    'noProduct',
  );
  assert.strictEqual(queryMap().total, 0, '三种"不写"里任何一种写了映射都会让它指向不存在的对象');
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

// ═══════════════════════════════════════════════════════════════════════════════
// ~~本页汇总（`resolveOrderSkuRollup`）~~ **已随指标条整条删除（2026-10-10）**
//
// 那是「归类核对」页页头指标条上"已配产品 N 个 · 供应商 M 家"那一格的取数函数。用户判它
// "看不懂" ⇒ 指标条整条撤掉 ⇒ 这个函数在渲染层与主进程都**零消费者**，按本仓纪律删除
//（`electron/product-db.ts` 的 `resolveOrderSkuRollup` / `OrderSkuRollup` / `MAX_ROLLUP_ROWS`，
//  `electron/order-handlers.ts` 的 `order-sku-rollup` 通道、preload 暴露键、types/ipc 声明一并退场）。
//
// ⚠️ 它测的**规则**没有消失，只是换了个入口活着：店铺原文 → 实体走 `resolveShopRef`、
//    (平台,店铺,商品ID) → 产品走 `resolveSkuBatch` —— 这两条在**上面**都还有各自的用例。
//    所以这里不是"删掉跑不过的用例"，而是"删掉一个已经没有调用方的汇总壳"。
// ⚠️ 要用回来时：**连实现一起加回来**（别只把这几条断言注释掉、却让通道空跑）。
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ 认款顺手采纳：订单图 → **款主图**（`pendingProductImages` 只负责"挑对对象"）
//
// 为什么这一层必须单独守：「采纳哪张图给哪个款」全在这个挑选函数里。挑错了 —— 挑到**别的商品**的图、
// 挑到**已经有主图**的款（把人的决定覆盖掉）、同款多商品时挑得**不稳定** —— 界面一切正常，坏的只是
// **产品主数据**，而主图恰好是产品页上最显眼的字段。落库（复制文件 / 登记 pl_images / 写 image_id）
// 由 `ipc:shape:smoke` 走真 handler 端到端守 —— 两边都省不掉。
// ═══════════════════════════════════════════════════════════════════════════════

// 图片主数据（`md_images`）由 `ensureVariantSchema` 建 —— handler 与
// `pendingProductImages` 都会走它，这里显式先建好，免得清表时撞 `no such table`。
pdb.ensureVariantSchema();

const ADOPT_IMG_A = '/tmp/sk-adopt/images/a.webp';
const ADOPT_IMG_B = '/tmp/sk-adopt/images/b.webp';
const ADOPT_IMG_OVERRIDE = '/tmp/sk-adopt/images/override.webp';

/** 清掉图片主数据：`reset()` 不管它，不清会串到上一条用例 */
function clearProductImages() {
  dbRun('DELETE FROM md_images');
}

let adoptSeq = 0;
/** 给某个 (店铺, 商品ID) 的订单挂一张**有本地路径**的图（路径为空时图池 ② 层会跳过它） */
function seedOrderImage(shop, itemId, localPath) {
  adoptSeq += 1;
  const img = dbRun(
    `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
    [`fp-adopt-${adoptSeq}`, `ufp-adopt-${adoptSeq}`, '', localPath],
  ).lastInsertRowid;
  const no = `ADO-${adoptSeq}`;
  dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES (?,?)`, [no, shop]);
  const h = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = ?`, [no]).id);
  dbRun(`INSERT INTO oi_order_items (order_id, image_id, raw_fields) VALUES (?,?,?)`, [
    h,
    img,
    JSON.stringify({ 商品ID: itemId }),
  ]);
}

/** 给某个款设一张主图（走真接口，别直接 UPDATE —— 那样测的就不是生产路径了） */
function attachOwnImage(pid) {
  const img = pdb.upsertImageRecord({
    fingerprint: `fp-own-${pid}`,
    localPath: `/tmp/sk-adopt/product-images/own-${pid}.webp`,
    source: 'upload',
  });
  pdb.attachProductImage(pid, img.imageId);
  return img.imageId;
}

/** 采纳待办 → 只留 localPath（断言里最关心的就是"挑了哪张"） */
const adoptsOf = (list) => list.map((x) => `${x.itemId}=${x.localPath}`);

check('采纳：款还没主图 + 这个商品在订单里有图 → 挑出**那张**图（并自证非空转）', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-1', ADOPT_IMG_A);

  const list = pdb.pendingProductImages([{ productId: pid, itemId: 'AD-1' }]);
  assert.strictEqual(list.length, 1, '款还空着图却不采纳 —— 这个功能等于没做');
  assert.strictEqual(list[0].productId, pid);
  assert.strictEqual(list[0].localPath, ADOPT_IMG_A, '采纳的不是这个商品自己的订单图');
  assert.strictEqual(list[0].source, 'order-image');

  // 自证：同一个款**已有主图**时必须回空 —— 证明上面那个 1 来自"款空着"，不是恒给
  attachOwnImage(pid);
  assert.strictEqual(
    pdb.pendingProductImages([{ productId: pid, itemId: 'AD-1' }]).length,
    0,
    '款已有主图还被挑出来 ⇒ 会把人的主图悄悄换掉',
  );
});

check('取对那张：同一商品有多张订单图 → 取图池首选（最新一张），不抓错', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-2', ADOPT_IMG_A); // 先落（md_images.id 小）
  seedOrderImage('店1', 'AD-2', ADOPT_IMG_B); // 后落（id 大 = 更新）

  const list = pdb.pendingProductImages([{ productId: pid, itemId: 'AD-2' }]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].localPath, ADOPT_IMG_B, '取的是这个商品较早那张图（与界面首选不是同一张）');
});

check('一个款只挑一张：同款被两个商品映射 → 只挑一条，且**不随入参顺序漂**', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-A', ADOPT_IMG_A);
  seedOrderImage('店1', 'AD-B', ADOPT_IMG_B);

  const a = pdb.pendingProductImages([
    { productId: pid, itemId: 'AD-B' },
    { productId: pid, itemId: 'AD-A' },
  ]);
  const b = pdb.pendingProductImages([
    { productId: pid, itemId: 'AD-A' },
    { productId: pid, itemId: 'AD-B' },
  ]);
  assert.strictEqual(a.length, 1, '一个款被挑出多张 ⇒ 后采纳的会盖掉先采纳的');
  assert.deepStrictEqual(adoptsOf(a), adoptsOf(b), '入参顺序不同挑出不同的图（同一次操作两次结果不一样）');
  assert.strictEqual(a[0].itemId, 'AD-A', '没按 itemKey 升序取第一个');
  assert.strictEqual(a[0].localPath, ADOPT_IMG_A);
});

check('商品ID 先归一：带空白 / 不可见字符仍命中同一件商品', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-3', ADOPT_IMG_A);

  // 界面传的 itemId 是**订单原文**（`extractSkuFields` 只 trim，还可能夹着不可见字符）
  const list = pdb.pendingProductImages([{ productId: pid, itemId: ' AD-3\u200b ' }]);
  assert.strictEqual(list.length, 1, '归一没走 ⇒ 界面传原文时永远挑不到图，且不报错');
  assert.strictEqual(list[0].localPath, ADOPT_IMG_A);
  assert.strictEqual(list[0].itemId, 'AD-3', '带回来的 itemId 该是归一键（池键口径）');
});

check('挑不到就回空：该商品在订单里没图 / 产品不存在 / 空入参 → 都不挑（不拿别人的图凑）', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-4', ADOPT_IMG_A);

  assert.strictEqual(pdb.pendingProductImages([{ productId: pid, itemId: 'AD-NONE' }]).length, 0,
    '这个商品在订单里没有图，却挑了一张出来');
  assert.strictEqual(pdb.pendingProductImages([{ productId: 999999, itemId: 'AD-4' }]).length, 0,
    '产品不存在还给出待办 ⇒ handler 会对着不存在的款写图');
  assert.deepStrictEqual(pdb.pendingProductImages([]), []);
  assert.strictEqual(pdb.pendingProductImages([{ productId: 0, itemId: '' }]).length, 0);
  // 自证：同夹具下**正确的一对**能挑到 —— 否则上面那几个 0 可能来自"整条链路都空"
  assert.strictEqual(pdb.pendingProductImages([{ productId: pid, itemId: 'AD-4' }]).length, 1);
});

check('与界面同口径：该商品有**覆盖图**时采纳覆盖图（你看着哪张就采纳哪张）', () => {
  reset();
  clearProductImages();
  seedShops(1);
  mapShopNames(1);
  const pid = seedProducts(1)[0];
  seedOrderImage('店1', 'AD-5', ADOPT_IMG_A);
  // 覆盖图落在采样快照行自己的 image_id 上（R1），所以先要有这条采集行
  seedSnapshot('店铺1', 'AD-5');
  const ov = pdb.upsertImageRecord({
    fingerprint: 'fp-ov-5',
    localPath: ADOPT_IMG_OVERRIDE,
    source: 'upload',
  });
  pdb.setItemImage({ itemId: 'AD-5', imageId: ov.imageId });

  const list = pdb.pendingProductImages([{ productId: pid, itemId: 'AD-5' }]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].localPath, ADOPT_IMG_OVERRIDE, '忽略了人的覆盖图（界面里显示的就是那张）');
  assert.strictEqual(list[0].source, 'item-override');
});

// ---- 认店第五级：商品ID 反查采集快照（2026-10-19）----
//
// 报障形状：用户把店名填进「平台店铺ID」、URL 数字也填错 ⇒ `matchShopByStore` 的
// URL / storeId / 店名 / 桶键记忆四级全落空 ⇒ 订单**永远认不了店**，映射配了也不生效
// （`resolveOrderSku` 在"店铺未归一"处直接返回 null）。而订单行上一直带着商品ID，
// `pl_shop_items` 的键就是 `(shop_id, store_key, item_id)` —— 商品ID 自己就能反证店。
//
// 这一组钉住四件事：① 认得出；② 认店后**真写进**了款色；③ 回流不再报 shopUnresolved；
// ④ 反查不出（没采到过 / 多店歧义）时必须回到"未归一"，绝不猜。

/** 采集快照里播一条"这个商品归在这家店"（走真实落库函数，不手搓行） */
function seedSnapshot(shopName, itemId) {
  sidb.upsertShopItems({
    schema: 'ae-shop-item/v1',
    store: { name: shopName },
    items: [{ itemId, title: '', skus: [] }],
  });
}

check('反查认店①：店铺原文认不出，但该商品在采集快照里归过某店 → 订单**当场归款**（写进款色）', () => {
  reset();
  const shop = seedShops(1)[0]; // 店铺1 / amazon（不 mapShopNames ⇒ '店1' 仍未归一）
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([{ platform: 'amazon', shopId: shop, itemId: 'B0ITEM', productId: pid, status: 'confirmed' }]);
  // 采过：这个商品当初归在「店铺1」名下
  seedSnapshot('店铺1', 'B0ITEM');

  // 反证：没有这条采集快照时它认不出店（否则下面的"归款成功"可能来自别的通路）
  assert.strictEqual(pdb.resolveOrderSku({ shop: '店1', itemId: 'B0NOPE' }), null, '没采到过的商品不该被认店');

  const [row] = importOrderRows([{ shop: '店1', fields: { 商品ID: 'B0ITEM', 商品标题: 'T恤' } }]);
  assert.strictEqual(styleColorOfOrder(row.orderId).code, 'P-0001', '认店 → 命中映射 → 图片要挂到这个款上');
});

check('反查认店②：resolveShopRef 带 itemId 才反查（不带就维持原语义，不凭空认店）', () => {
  reset();
  const shop = seedShops(1)[0];
  seedSnapshot('店铺1', 'B0ITEM');
  assert.strictEqual(pdb.resolveShopRef('店1').shopId, 0, '不带 itemId = 没有反查证据，必须维持"未归一"');
  const ref = pdb.resolveShopRef('店1', 'B0ITEM');
  assert.strictEqual(ref.shopId, shop);
  assert.strictEqual(ref.platform, 'amazon', '平台要跟着店走（空平台会写坏映射）');
});

check('反查认店③：人工核对回流不再报 shopUnresolved，映射真的写进去了', () => {
  const { style1 } = seedClassify(); // 店1 → 店铺1 已归一，但下面用**野店**
  seedSnapshot('店铺1', 'B0BACK');
  const [backId] = seedOrderRows([{ shop: '野店A', fields: { 商品ID: 'B0BACK' } }]);
  const res = odb.assignOrderStyle({ orderId: backId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.skuBackfill.status, 'written', `回流应写入而不是报未归一：${JSON.stringify(res.skuBackfill)}`);
  assert.strictEqual(queryMap({ search: 'B0BACK' }).total, 1, '映射行要真落库');
});

check('反查认店④：反查不出（多店歧义）→ 仍报 shopUnresolved，绝不挑一个店写映射', () => {
  const { style1 } = seedClassify();
  const shopA = shopByName('店铺1').id;
  const shopB = shopByName('店铺2').id;
  // 同一商品ID 在两家店都采到过（历史重复行的真实形状）
  for (const shop of [shopA, shopB]) {
    dbRun(`INSERT INTO pl_shop_items (shop_id, store_key, item_id, sku_json) VALUES (?, '', 'B0AMB', '[]')`, [shop]);
  }
  const [ambId] = seedOrderRows([{ shop: '野店B', fields: { 商品ID: 'B0AMB' } }]);
  const res = odb.assignOrderStyle({ orderId: ambId, styleId: style1, color: '黑色' });
  assert.strictEqual(res.skuBackfill.status, 'shopUnresolved', '歧义 = 没有证据，不许猜');
  assert.strictEqual(queryMap({ search: 'B0AMB' }).total, 0);
});

check('反查认店⑤：队列里"其实已配映射"的行不得留在待办（剔除必须先认店再拼键）', () => {
  reset();
  const shop = seedShops(1)[0];
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([{ platform: 'amazon', shopId: shop, itemId: 'B0QUE', productId: pid, status: 'confirmed' }]);
  seedSnapshot('店铺1', 'B0QUE');
  seedOrders([{ shop: '店1', fields: { 商品ID: 'B0QUE' } }]);
  const q = pdb.shopSkuQueue({});
  assert.strictEqual(
    q.rows.filter((r) => r.itemId === 'B0QUE').length,
    0,
    '反查认店 + 已配映射 ⇒ 这行是已完成，不能挂在「待关联」里',
  );
  assert.ok(q.stats.mapped >= 1, '要计入 mapped（否则关联率永远偏低）');
  assert.deepStrictEqual(q.stats.unresolvedShops, [], '店已经被反查认出来了，不该再提示用户去归一');
});

// ---- 按图定色（2026-10-19）----
// 真实库证据：订单报表的「产品图片链接」是**逐单 SKU 图**（同一商品ID 的 9 条订单对应 4~6 张不同图），
// 且能对上的 2 条订单，其图与采集 `sku_json[].imageUrl` 逐字节相同。
// 这四条的立足点：**定不了色是安全的（未分类，人看一眼），定错色=发错货**。

/** 归款结果里的颜色（`''` = 图没归到任何款色） */
function colorOfImage(imageId) {
  const r = dbGet(`SELECT COALESCE(color,'') AS color FROM oi_style_colors WHERE image_id = ?`, [
    imageId,
  ]);
  return String(r?.color ?? '');
}

check('按图定色①：多色商品 + 映射不带色 → 按**订单图**归到对应色（不再全落未分类）', () => {
  reset();
  const shop = seedShops(1)[0];
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0IMG', productId: pid, status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0IMG', [
    { color: '7', size: 'M', imageUrl: 'https://cdn/kf/S7.jpg', price: '' },
    { color: 'Khaki', size: 'M', imageUrl: 'https://cdn/kf/Sk.jpg', price: '' },
  ]);
  // 两张订单图分别对应两个色 —— 同一商品ID 的不同订单必须是**各自**的颜色
  const [a, b] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0IMG' }, imageUrl: 'https://cdn/kf/S7.jpg' },
    // 带 CDN 查询串也要命中（真实报表给的就是带参数的那一种）
    { shop: '店1', fields: { 商品ID: 'B0IMG' }, imageUrl: 'https://cdn/kf/Sk.jpg?x-oss-process=resize' },
  ]);
  assert.strictEqual(colorOfImage(a.imageId), '7', '图指向哪个色就归哪个色');
  assert.strictEqual(colorOfImage(b.imageId), 'Khaki', '带查询串的图同样要能对上');
  assert.strictEqual(styleColorOfOrder(a.orderId).code, 'P-0001', '款仍要走映射定');
});

check('按图定色②：多色共用同一张图 → 歧义必须落未分类（绝不取第一个）', () => {
  reset();
  const shop = seedShops(1)[0];
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0AMB2', productId: pid, status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0AMB2', [
    { color: 'A', size: 'M', imageUrl: 'https://cdn/kf/same.jpg', price: '' },
    { color: 'B', size: 'M', imageUrl: 'https://cdn/kf/same.jpg', price: '' },
  ]);
  const [{ imageId: img }] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0AMB2' }, imageUrl: 'https://cdn/kf/same.jpg' },
  ]);
  assert.strictEqual(colorOfImage(img), '未分类', '一张图对上两个色 ⇒ 定不了，落占位色');
});

check('按图定色③：映射配了色 → 配的色赢（图只作兜底，不推翻人的结论）', () => {
  reset();
  const shop = seedShops(1)[0];
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0PIN', productId: pid, spec: '红色', status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0PIN', [
    { color: 'Khaki', size: 'M', imageUrl: 'https://cdn/kf/Sk.jpg', price: '' },
  ]);
  const [{ imageId: img }] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0PIN' }, imageUrl: 'https://cdn/kf/Sk.jpg' },
  ]);
  assert.strictEqual(colorOfImage(img), '红色', '人配的颜色压过按图推导');
});

check('按图定色④：图已有真实色（人工/AI/色图采纳）→ 归款不得冲成未分类', () => {
  reset();
  const shop = seedShops(1)[0];
  const pid = seedProducts(1)[0];
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0KEEP', productId: pid, status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0KEEP', [
    { color: '7', size: 'M', imageUrl: 'https://cdn/kf/S7.jpg', price: '' },
  ]);
  // 先让一条普通订单把款建出来（`oi_styles` 的创建走真实归款路径，不手搓款表）
  importOrderRows([{ shop: '店1', fields: { 商品ID: 'B0KEEP' }, imageUrl: 'https://cdn/kf/S7.jpg' }]);
  const styleId = Number(dbGet(`SELECT id FROM oi_styles WHERE code = 'P-0001'`).id);
  // 同一款可能已被前几条用例建过「黑色」（reset 不清 oi_styles）⇒ 先查再建，不硬插
  let sc = dbGet(`SELECT id FROM oi_style_colors WHERE style_id = ? AND color = '黑色'`, [styleId])?.id;
  if (!sc) {
    sc = dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?,?,?)`, [
      styleId,
      '黑色',
      'P-0001-HEISE',
    ]).lastInsertRowid;
  }
  // 这张图**指向采集里的色 7**（按图推导会得出 7），但它已经归好真实色「黑色」
  // ⇒ 归款必须保留人的结论，不能被推导冲掉（R1：色↔图 1:1，绑在 `oi_style_colors.image_id`）
  const img = dbRun(
    `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path) VALUES (?,?,?,?)`,
    ['fp-keep-1', 'ufp-keep-1', 'https://cdn/kf/S7.jpg', ''],
  ).lastInsertRowid;
  dbRun(`UPDATE oi_style_colors SET image_id = ? WHERE id = ?`, [img, sc]);
  const [{ imageId: used }] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0KEEP' }, imageId: img },
  ]);
  assert.strictEqual(colorOfImage(used), '黑色', '已有真实色必须原样保留');
});

// ---- 色名对照（2026-10-19）：平台色名 → 自家色名 ----
// 真实库证据：平台色是 `Khaki` / `Photo color` / `1..15`，产品色是 `黑色`、`卡其` ——
// 没有可计算的对应关系，只能由人在核对页指认一次。这两条钉的是：
//   ① **一次指认、同款复用**（不是"这一行改完就算了"）；
//   ② **按产品隔离**（同平台色名在不同款上可以有不同叫法，不能一张全局表拍死）。
// ⚠️ 断言必须让第二单走**没有映射色**的路径：如果它命中了映射里的 spec，
//    那测的是 `pl_shop_sku.spec`（老逻辑），字典压根没参与 —— 用例会恒绿。

check('色名对照①：核对时把 Khaki 改成自家色名 → 记住这一对，同款其它商品自动用自家名', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  odb.importStyles([{ code: 'P-0001', name: '产品1', color: '卡其', fingerprint: 'fp-alias-a' }]);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0ALIAS', productId: pid, status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0ALIAS', [
    { color: 'Khaki', size: 'M', imageUrl: 'https://cdn/kf/Sk.jpg', price: '' },
  ]);
  // 前提：没配对照时，按采集原样落**平台色名**（否则下面的翻译断言没有对照物）
  const [first] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0ALIAS' }, imageUrl: 'https://cdn/kf/Sk.jpg' },
  ]);
  assert.strictEqual(colorOfImage(first.imageId), 'Khaki', '前提：没有对照时落平台色名');

  // 人工核对：改成「卡其」→ 这一对要被记住
  const res = odb.assignOrderStyle({ orderId: first.orderId, styleCode: 'P-0001', color: '卡其' });
  assert.deepStrictEqual(res.colorAlias, { from: 'Khaki', to: '卡其' }, '色名对照应被记住');
  assert.strictEqual(colorOfImage(first.imageId), '卡其', '这一单本身也改到自家色名');

  // 同款的**另一个商品**：映射只到款、没配色 ⇒ 只能靠字典翻译
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0ALIAS2', productId: pid, status: 'confirmed' },
  ]);
  seedSkuSnapshot(shop, 'B0ALIAS2', [
    { color: 'Khaki', size: 'M', imageUrl: 'https://cdn/kf/Sk2.jpg', price: '' },
  ]);
  const [second] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0ALIAS2' }, imageUrl: 'https://cdn/kf/Sk2.jpg' },
  ]);
  assert.strictEqual(colorOfImage(second.imageId), '卡其', '同款其它商品自动用自家色名（不用再改一遍）');
});

check('色名对照②：别的款上的同一个 Khaki 不受影响（产品级隔离）', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid1, pid2] = seedProducts(2);
  odb.importStyles([
    { code: 'P-0001', name: '产品1', color: '卡其', fingerprint: 'fp-alias-b1' },
    { code: 'P-0002', name: '产品2', color: '驼色', fingerprint: 'fp-alias-b2' },
  ]);
  // 只有 P-0001 认过 `Khaki → 卡其`
  const remembered = odb.rememberColorAlias(pid1, 'Khaki', '卡其');
  assert.deepStrictEqual(remembered, { from: 'Khaki', to: '卡其' });

  for (const [itemId, pid, url] of [
    ['B0ISO1', pid1, 'https://cdn/kf/Sk1.jpg'],
    ['B0ISO2', pid2, 'https://cdn/kf/Sk2.jpg'],
  ]) {
    pdb.upsertSkuMappings([{ platform: 'amazon', shopId: shop, itemId, productId: pid, status: 'confirmed' }]);
    seedSkuSnapshot(shop, itemId, [{ color: 'Khaki', size: 'M', imageUrl: url, price: '' }]);
  }
  const [one, two] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0ISO1' }, imageUrl: 'https://cdn/kf/Sk1.jpg' },
    { shop: '店1', fields: { 商品ID: 'B0ISO2' }, imageUrl: 'https://cdn/kf/Sk2.jpg' },
  ]);
  assert.strictEqual(colorOfImage(one.imageId), '卡其', '配过对照的款 → 自家色名');
  assert.strictEqual(colorOfImage(two.imageId), 'Khaki', '没配过的款保持原样（不许被别的款带跑）');
});

// ───────────────────────────────────────────── 映射重放（全库自愈）
// 背景：真实库里存在「映射已确认、订单却没吃到」的行 —— 成因是 `upsertSkuMappings`
// 这条路径**不回填**存量（只有人工核对那一句 `rememberSkuMapping` 会回填），
// 于是"先导单、后配映射"的商品永远停在未归款，界面上与"没配过映射"完全同形。
// 这两条钉的是：① 能补、dryRun 不写、且幂等；② 挂在真实颜色上的一律不动。

check('映射重放①：先导单后配映射的漏网行 —— dryRun 只报数，真跑才补，且幂等', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  odb.importStyles([{ code: 'P-0001', name: '产品1', color: '黑色', fingerprint: 'fp-rp-a' }]);
  // ① 先导单：此刻还没有映射
  const [o1] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0REPLAY' }, imageUrl: 'https://cdn/kf/Rp.jpg' },
  ]);
  assert.strictEqual(colorOfImage(o1.imageId), '', '前提：没有映射时不该有归属');
  // ② 后配映射（这条路径不回填 —— 真实库的漏网正是这么来的）
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0REPLAY', productId: pid, spec: '黑色', status: 'confirmed' },
  ]);
  assert.strictEqual(colorOfImage(o1.imageId), '', '前提：配映射不会自动回填存量（否则本用例测不到重放）');

  // ③ dryRun：报得出，但一行都不许写
  const dry = odb.replaySkuMappings({ dryRun: true });
  assert.ok(dry.fixableRows >= 1, `dryRun 应报出可补的行（得到 ${JSON.stringify(dry)}）`);
  assert.strictEqual(dry.fixedRows, 0, 'dryRun 不许写库');
  assert.strictEqual(colorOfImage(o1.imageId), '', 'dryRun 之后订单仍未被改');

  // ④ 真跑：补上，颜色取映射里配的那个
  const real = odb.replaySkuMappings();
  assert.ok(real.fixedRows >= 1, `真跑应补上（得到 ${JSON.stringify(real)}）`);
  assert.strictEqual(colorOfImage(o1.imageId), '黑色', '补上后颜色应取映射里配的颜色');

  // ⑤ 幂等：再跑一次不该再改任何行（页面加载会反复调它，不幂等就是每次进页面都重写库）
  const again = odb.replaySkuMappings();
  assert.strictEqual(again.fixedRows, 0, '重放必须幂等（第二次不该再改）');
  assert.strictEqual(colorOfImage(o1.imageId), '黑色', '幂等重跑不许把已有归属改坏');
});

check('映射重放②：已经挂在真实颜色上的行一律不动（重放不许改判人的结论）', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  odb.importStyles([{ code: 'P-0001', name: '产品1', color: '黑色', fingerprint: 'fp-rp-b' }]);
  // keep 的商品**已有映射（黑色）**：导进来就会自动归到黑色，随后被人改成白色 ——
  // 这正是"人的结论盖过映射"的真实形态。若夹具让映射色与人工色相同，
  // 那"重放不许改判"这条断言会恒绿（覆盖了也看不出来）。
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0KEEP', productId: pid, spec: '黑色', status: 'confirmed' },
  ]);
  const [keep, miss] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0KEEP' }, imageUrl: 'https://cdn/kf/Kp.jpg' },
    { shop: '店1', fields: { 商品ID: 'B0MISS' }, imageUrl: 'https://cdn/kf/Ms.jpg' },
  ]);
  assert.strictEqual(colorOfImage(keep.imageId), '黑色', '前提：映射命中 → 先归到黑色');
  // 人把它改成白色（这是人的结论，重放不许推翻）
  odb.assignOrderStyle({ orderId: keep.orderId, styleCode: 'P-0001', color: '白色' });
  assert.strictEqual(colorOfImage(keep.imageId), '白色', '前提：人工结论已落库');
  // miss 这一单的商品随后才配上映射（黑色）
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0MISS', productId: pid, spec: '黑色', status: 'confirmed' },
  ]);
  odb.replaySkuMappings();
  assert.strictEqual(colorOfImage(keep.imageId), '白色', '挂在真实颜色上的行不许被重放改判');
  assert.strictEqual(colorOfImage(miss.imageId), '黑色', '漏网的那单要被补上');
});

// ───────────────────────────────────────────── 报表规格串定色（2026-10-20）
// 背景：订单报表没有颜色列，颜色藏在「产品信息」的 `(产品属性:Color:5,...)` 里；而以前唯一来源是
// 「订单图 → 采集 SKU 色图」。采集没覆盖到的商品（本机库 44/51 单）于是全部落「未分类」——
// **不同颜色的订单在拣货单上长得一模一样**。这三条钉的是：① 不看图也能定出平台色名、且认一次后
// 同款自动翻译；② 一单多色**不取第一个**；③ 存量回填只补空值、不覆盖人的结论。

check('报表规格串定色①：映射不带色 + 采集没覆盖 → 色名从规格串来，认一次后同款自动翻译', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  odb.importStyles([{ code: 'P-0001', name: '产品1', color: '黑色', fingerprint: 'fp-props-a' }]);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0PROPS', productId: pid, status: 'confirmed' },
  ]);
  // ⚠️ 刻意**不种采集快照**：真实库里多数商品从没采过 ⇒ "按图定色"这条路恒空。
  //    夹具若补上快照，"规格串"这条就算不实现也会绿（图能定色）。
  const info = '【1】x\n(产品属性:Color:7,Size:M,Ships From:China Mainland)\n(产品数量:1 piece)';
  const [o1] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0PROPS', 产品信息: info }, imageUrl: 'https://cdn/kf/Pr1.jpg' },
  ]);
  assert.strictEqual(
    colorOfImage(o1.imageId),
    '7',
    '没有色图时颜色要取报表规格串里的平台色名（不是「未分类」）',
  );
  const col = dbGet(`SELECT color FROM oi_order_items WHERE id = ?`, [o1.orderId]);
  assert.strictEqual(String(col?.color ?? ''), '7', '订单行要记下平台色名（界面靠它认出同款不同色）');

  // 人工核对：把 `7` 认成黑色 —— 这一对必须被记住（平台侧原文取自报表规格串，不是刚写下的订单列）
  const r = odb.assignOrderStyle({ orderId: o1.orderId, styleCode: 'P-0001', color: '黑色' });
  assert.deepStrictEqual(r.colorAlias, { from: '7', to: '黑色' }, '没有采集快照时也要学会这一对');
  assert.strictEqual(colorOfImage(o1.imageId), '黑色', '人工结论落库');

  // 同款另一个商品（同一个平台色名 `7`）→ 下一单自动落成自家色名，不必再认一遍
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0PROP2', productId: pid, status: 'confirmed' },
  ]);
  const [o2] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0PROP2', 产品信息: info }, imageUrl: 'https://cdn/kf/Pr2.jpg' },
  ]);
  assert.strictEqual(colorOfImage(o2.imageId), '黑色', '同款不同商品要自动用自家色名');
});

check('报表规格串定色②：一单多色 → 保持「未分类」（绝不取第一个）', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  odb.importStyles([{ code: 'P-0001', name: '产品1', color: '黑色', fingerprint: 'fp-props-b' }]);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0MULTI', productId: pid, status: 'confirmed' },
  ]);
  // 真库形态：一张订单 4 个 SKU 行，两种颜色
  const info =
    '【1】x\n(产品属性:Color:10,Size:XL)\n【2】x\n(产品属性:Color:10,Size:XXL)\n' +
    '【3】x\n(产品属性:Color:6,Size:XL)\n【4】x\n(产品属性:Color:6,Size:L)';
  const [o] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0MULTI', 产品信息: info }, imageUrl: 'https://cdn/kf/Mu.jpg' },
  ]);
  assert.strictEqual(colorOfImage(o.imageId), '未分类', '多色订单不许落色（取第一个就是静默错色）');
  const col = dbGet(`SELECT color FROM oi_order_items WHERE id = ?`, [o.orderId]);
  assert.strictEqual(String(col?.color ?? ''), '', '定不出色时订单行保持空（不写第一个）');
});

check('v5 回填：存量订单只补空值，人工结论一行都不动', () => {
  reset();
  for (const t of ['oi_style_colors', 'oi_style_fingerprints', 'oi_styles', 'oi_color_aliases']) dbRun(`DELETE FROM ${t}`);
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const info = '【1】x\n(产品属性:Color:9,Size:M)';
  const [a, b] = importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0BACK1', 产品信息: info }, imageUrl: 'https://cdn/kf/Bk1.jpg' },
    { shop: '店1', fields: { 商品ID: 'B0BACK2', 产品信息: info }, imageUrl: 'https://cdn/kf/Bk2.jpg' },
  ]);
  // 造"修好之前的存量形状"：颜色列空（以前没有规格串这条路），另一行已经有人工结论。
  // 拆表后颜色在明细表；v5 的「从规格串补平台色名、只补空」语义由 `insertOrder` 落库时解析承载，
  // 这里直接验证那条解析路径 + 明细落点（不再回退版本触发迁移链 —— v8 拆表重建表后重放会崩）。
  dbRun(`UPDATE oi_order_items SET color = '' WHERE id IN (?, ?)`, [a.orderId, b.orderId]);
  dbRun(`UPDATE oi_order_items SET color = '黑色' WHERE id = ?`, [b.orderId]);
  // 重导入 a（走 insertOrder 落库那一刻的 `parseOrderPropsColor`）
  const a2 = odb.insertOrder({
    imageId: null, orderNo: `IM-RETRY-${fpSeq + 1}`, shop: '店1', size: 'M',
    category: '', color: '', logo: '', rawFields: { 商品ID: 'B0BACK1', 产品信息: info },
  });

  const colorOf = (id) =>
    String(dbGet(`SELECT color FROM oi_order_items WHERE id = ?`, [id])?.color ?? '');
  assert.strictEqual(colorOf(a2), '9', '空值行要回填出平台色名');
  assert.strictEqual(colorOf(b.orderId), '黑色', '已有值（人工结论）一行都不许动');
});

// 真库取证（2026-10-20）：2 条映射指向**已删除的产品**（`9802`），卡住 10 单 ——
// 而队列按映射表算"已关联"，于是这些商品**连待办都不进**：用户看到"10 单认不出"却没有任何入口。
check('映射悬空：产品被删后要回到待办（队列与认款同一口径）', () => {
  reset();
  const shop = seedShops(1)[0];
  mapShopNames(1);
  const [pid] = seedProducts(1);
  pdb.upsertSkuMappings([
    { platform: 'amazon', shopId: shop, itemId: 'B0DANGLE', productId: pid, status: 'confirmed' },
  ]);
  importOrderRows([
    { shop: '店1', fields: { 商品ID: 'B0DANGLE' }, imageUrl: 'https://cdn/kf/Dg.jpg' },
  ]);
  const queued = () => pdb.shopSkuQueue({}).rows.filter((r) => r.itemId === 'B0DANGLE');
  assert.strictEqual(queued().length, 0, '前提：有生效映射时该商品不在待办里');

  pdb.deleteProduct(pid);
  const row = queued()[0];
  assert.ok(row, '产品被删后必须回到待办（否则用户没有地方能修）');
  assert.strictEqual(row.status, 'unmapped', '店铺已归一 ⇒ 缺的是映射，不是店名');
  const batch = pdb.resolveSkuBatch([{ platform: 'amazon', shopId: shop, itemId: 'B0DANGLE' }]);
  assert.strictEqual(
    batch[0].matched,
    false,
    '批量解析同一口径：悬空映射不算命中（否则是 matched + 空产品名）',
  );
});

// ---- [套装] 产品关联子商品（一张关联表，键里必须带色号）----
//
// 业务原文：「套装不是整体色，可能自由搭配（上衣红 + 裤黑）；子商品也是独立商品，能单独卖」。
// 所以断言必须让这三种错误实现各自变红 —— 三条都期望"黑"就全都恒绿：
//   · 色号不区分（所有色号共用一组关联）· 商品级被产品级压过 · 未配的色号回落到别的色号
const mkProduct = (code, name) =>
  pdb.upsertProduct({
    id: 0,
    code,
    name,
    supplierId: 0,
    category: '',
    status: 'active',
    note: '',
  }).id;

const pTop = mkProduct('BND-TOP', '上衣款');
const pPant = mkProduct('BND-PANT', '裤子款');
const pSet = mkProduct('BND-SET', '两件套');
const pOther = mkProduct('BND-SET2', '另一套');

check('关联：子商品是独立产品 —— 套装只存关系，不复制子商品的名称/成本', () => {
  const r = pdb.replaceBundleLinks({
    productId: pSet,
    aliasKey: '5',
    parts: [
      { role: '上衣', childProductId: pTop, childColor: '红' },
      { role: '裤子', childProductId: pPant, childColor: '黑', qty: 1 },
    ],
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(pdb.isBundleProduct(pSet), true);
  assert.strictEqual(pdb.isBundleProduct(pTop), false, '子商品本身不是套装（它照常单独卖）');
  assert.strictEqual(pdb.getProduct(pTop).name, '上衣款', '子商品仍是产品库里那张自己的行');

  const rows = pdb.bundleLinksOf(pSet);
  assert.deepStrictEqual(
    rows.map((x) => [x.aliasKey, x.role, x.childCode, x.childColor, x.qty]),
    [
      ['5', '上衣', 'BND-TOP', '红', 1],
      ['5', '裤子', 'BND-PANT', '黑', 1],
    ],
    '按 色号 → 部件名 稳定排序',
  );
});

check('关联：非法输入被拒，且**不动**已存关系（失败不能删一半）', () => {
  const bad = (parts, alias, why) => {
    const r = pdb.replaceBundleLinks({ productId: pSet, aliasKey: alias || '5', parts });
    assert.strictEqual(r.ok, false, why);
    assert.strictEqual(pdb.bundleLinksOf(pSet).length, 2, `${why} —— 失败后原关系必须还在`);
  };
  bad([{ role: '上衣', childProductId: pSet, childColor: '红' }], '5', '不许自引用');
  bad(
    [
      { role: '上衣', childProductId: pTop, childColor: '红' },
      { role: '上衣', childProductId: pPant, childColor: '黑' },
    ],
    '5',
    '部件名不许重复（两件裤子用 qty=2）',
  );
  bad([{ role: '上衣', childProductId: pTop, childColor: '' }], '5', '子颜色必填');
  bad([{ role: '上衣', childProductId: pTop, childColor: '红', qty: 0 }], '5', '件数必须 ≥1');
  bad([{ role: '上衣', childProductId: 999999, childColor: '红' }], '5', '子商品必须存在');
  // 色号是键的一半：空色号等于"不区分搭配"，必须拒
  const noAlias = pdb.replaceBundleLinks({
    productId: pSet,
    aliasKey: '   ',
    parts: [{ role: '上衣', childProductId: pTop, childColor: '红' }],
  });
  assert.strictEqual(noAlias.ok, false, '空色号必须拒绝');
  assert.strictEqual(pdb.bundleLinksOf(pSet).length, 2, '空色号被拒后原关系不动');
});

check('关联：子商品本身是套装 ⇒ 拒绝（不嵌套，环的入口在写入处堵掉）', () => {
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pOther,
      aliasKey: '1',
      parts: [{ role: '整件', childProductId: pTop, childColor: '红' }],
    }).ok,
    true,
  );
  const r = pdb.replaceBundleLinks({
    productId: pSet,
    aliasKey: '5',
    parts: [{ role: '内层', childProductId: pOther, childColor: '红' }],
  });
  assert.strictEqual(r.ok, false, '套装套套装暂不支持');
  assert.ok(/套装套套装/.test(r.error || ''), `错误要说清原因，实际：${r.error}`);
  assert.strictEqual(pdb.bundleLinksOf(pSet).length, 2, '拒绝后原关系必须完好');
  pdb.clearBundle(pOther);
});

check('关联：换一个色号 = 另一套装搭配，两者互不影响（色号必须在键里）', () => {
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pSet,
      aliasKey: '6',
      parts: [
        { role: '上衣', childProductId: pTop, childColor: '黑' },
        { role: '裤子', childProductId: pPant, childColor: '黑' },
      ],
    }).ok,
    true,
  );
  const a = pdb.resolveBundleParts({ productId: pSet, color: '5' });
  assert.deepStrictEqual(a.parts.map((p) => p.color), ['红', '黑'], '色号 5 仍是 红+黑');
  const b = pdb.resolveBundleParts({ productId: pSet, color: '6' });
  assert.deepStrictEqual(b.parts.map((p) => p.color), ['黑', '黑'], '色号 6 是 黑+黑');
});

check('关联：商品级覆盖压过产品级，且只影响这个商品', () => {
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pSet,
      itemId: 'ITEM-A',
      aliasKey: '7',
      parts: [
        { role: '上衣', childProductId: pTop, childColor: '藏青' },
        { role: '裤子', childProductId: pPant, childColor: '灰' },
      ],
    }).ok,
    true,
  );
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pSet,
      aliasKey: '7',
      parts: [
        { role: '上衣', childProductId: pTop, childColor: '深蓝' },
        { role: '裤子', childProductId: pPant, childColor: '深蓝' },
      ],
    }).ok,
    true,
  );
  const a = pdb.resolveBundleParts({ productId: pSet, itemId: 'ITEM-A', color: '7' });
  assert.deepStrictEqual(a.parts.map((p) => p.color), ['藏青', '灰'], '点名（商品级）必须赢');
  assert.strictEqual(a.matchedScope, 'item');
  const b = pdb.resolveBundleParts({ productId: pSet, itemId: 'ITEM-B', color: '7' });
  assert.deepStrictEqual(b.parts.map((p) => p.color), ['深蓝', '深蓝'], '别的商品只吃产品级');
  assert.strictEqual(b.matchedScope, 'product');
});

check('关联：该色号没配过 ⇒ matched=false，**不许**回落别的色号或拿父级色凑', () => {
  const r = pdb.resolveBundleParts({ productId: pSet, color: '9' });
  assert.strictEqual(r.isBundle, true);
  assert.strictEqual(r.matched, false, '未配就是未配 —— 回落任一组都是给错拿货单');
  assert.deepStrictEqual(r.parts, [], '不许拿色号 5/6 的搭配顶上');
});

check('关联键：色号归一（空白/全角/大小写）后同一个键', () => {
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pSet,
      aliasKey: ' Khaki ',
      parts: [
        { role: '上衣', childProductId: pTop, childColor: '卡其' },
        { role: '裤子', childProductId: pPant, childColor: '卡其' },
      ],
    }).ok,
    true,
  );
  const r = pdb.resolveBundleParts({ productId: pSet, color: 'ｋｈａｋｉ' });
  assert.strictEqual(r.matched, true, '全角与小写必须同键');
  assert.deepStrictEqual(r.parts.map((p) => p.color), ['卡其', '卡其']);
});

check('替换只作用于本色号：重配色号 5 不许碰色号 6', () => {
  assert.strictEqual(
    pdb.replaceBundleLinks({
      productId: pSet,
      aliasKey: '5',
      parts: [{ role: '上衣', childProductId: pTop, childColor: '白' }],
    }).ok,
    true,
  );
  const five = pdb.resolveBundleParts({ productId: pSet, color: '5' });
  assert.deepStrictEqual(five.parts.map((p) => p.role), ['上衣'], '色号 5 现在是单件（重配过）');
  const six = pdb.resolveBundleParts({ productId: pSet, color: '6' });
  assert.deepStrictEqual(six.parts.map((p) => p.role), ['上衣', '裤子'], '色号 6 必须原样还在');
});

check('解除套装 ⇒ 关联全清，产品本身不删，子商品也不受影响', () => {
  const r = pdb.clearBundle(pSet);
  assert.ok(r.removed >= 1, `应删掉关联，实际 ${JSON.stringify(r)}`);
  assert.deepStrictEqual(pdb.bundleLinksOf(pSet), []);
  assert.ok(pdb.getProduct(pSet), '产品本身必须还在（套装只是它的一种关系）');
  assert.ok(pdb.getProduct(pTop) && pdb.getProduct(pPant), '子商品一律不动');
});

// ---- 收尾 ----
closeDb();
fs.rmSync(dir, { recursive: true, force: true });

console.log('\u2500'.repeat(64));
console.log(failed === 0 ? '\u2705 全部通过' : `\u274c ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
