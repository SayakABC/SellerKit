// 「拣货」投影冒烟（DB 层，不启动界面）。
//
//   npm run picking:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/picking-db-smoke.cjs
//
// 为什么单独一个：`pickingRows` 是**跨四张表**的只读投影（oi_orders + 识别链 + 产品/供应商 + 三层回落取图），
// 它的错都是静默的 —— 少 JOIN 一次就"图全空"、筛错条件就"待拣单不见了"，界面照样渲染。
//
// 覆盖的不变量：
//   · **未发货只认机械事实**（`ship_time` 空 且 `status<>'shipped'`）→ 已发货的不进列表；
//     `includeShipped` 打开时照收；
//   · 关闭单**照收**（它是 101/153 的常态，但"关闭不该拣"属算账口径，由渲染层剔 —— 本层不许偷偷筛掉）；
//   · 无日期的行**照收**（"没日期"不能当"太老"）；
//   · **图三层回落**（覆盖图 > 订单图 > 款主图），逐 item 独立；
//   · 款色码/供应商的 JOIN 与 `shippingRows` 同口径；缺 `suppliers` 表时**降级不抛**；
//   · 店铺过滤 / 上限钳制 / 元信息；
//   · **映射带颜色**（D4）：`spec` 承载颜色 → 归款写进款色 → 投影的「有效颜色」回落款色；
//     含三条易假绿的判据：**带色行优先于 `*` 行**、**映射写入后回填存量订单**、
//     **回填不覆盖已有归款结论**（人工/识别优先），以及"缺省 `spec` 时行为不变"的回归。
// 库文件落在临时目录，不污染真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-picking-smoke-'));

const { initDb, closeDb, dbGet, dbQuery, dbRun } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
const pick = require(path.join(ROOT, 'dist', 'electron', 'picking-db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const sidb = require(path.join(ROOT, 'dist', 'electron', 'shop-item-db.js'));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

initDb(path.join(dir, 'smoke.db'));
odb.ensureOrderSchema();
pdb.ensureProductSchema();
pdb.ensureVariantSchema();
sdb.ensureShopSchema();
// 覆盖图（取图第①层）落在**采集行自己的** `pl_shop_items.image_id`（R1 起不再有 `pl_item_images`），
// 而 `setItemImage` 要求该商品 ID 已有采集行 —— 所以这里必须建真结构的采集表。
sidb.ensureShopItemSchema();
// 一家**已归一**的店铺：识别链（`autoAssignByMap` → `resolveOrderSku`）要求店铺能落到 `sk_shops.id`，
// 否则「店铺没归一」直接返回 null（那是设计如此，不是 bug）
const shop = sdb.upsertShop({
  id: 0,
  platform: 'aliexpress',
  name: '店A',
  platformShopId: '',
  site: '',
  status: 'active',
  openedAt: '',
  note: '',
});

/** 相对今天的日期（避免写死日期后随时间失效） */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 订单图片（`oi_order_items.image_id` 有外键）
dbRun(
  `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (1, 'sha1', 'fp1', 'u1', '/tmp/order-1.jpg')`,
);
dbRun(
  `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (2, 'sha2', 'fp2', 'u2', '/tmp/order-2.jpg')`,
);
// 占位图：识别图记录在、但文件还没下来（`local_path` 空）→ 取图的第②层应**落空**并继续回落第③层
dbRun(
  `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (3, 'sha3', 'fp3', 'u3', '')`,
);
// 另一张占位图：给「三层都没有」那条用。**故意不复用图 3** —— 让两个不同商品共用一张图
// 在真实数据里不会发生（图按内容指纹去重），共用会让"后进的那行改判先归好的行"这类
// 断言混淆来源。同商品多色共用主图是真的，那种场景在 [7] 用独立的图专门验。
dbRun(
  `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (4, 'sha4', 'fp4', 'u4', '')`,
);

let seq = 0;
/** 一行订单（未发货；`imageId` 决定订单图，`itemId` 决定取图回落） */
function order(over = {}) {
  seq += 1;
  const itemId = over.itemId ?? 'IT-100';
  return odb.insertOrder({
    imageId: over.imageId ?? 1,
    orderNo: over.orderNo ?? `O-${seq}`,
    shop: over.shop ?? '店A',
    size: over.size ?? 'L',
    orderTime: over.orderTime ?? `${daysAgo(1)} 10:00:00`,
    category: '衣服',
    color: over.color ?? '黑',
    logo: '',
    rawFields: {
      商品ID: itemId,
      收货国家: 'United States',
      商品信息: `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:1 piece)`,
      ...(over.rawFields ?? {}),
    },
    ...(over.rec ?? {}),
  });
}
/** 直接把一行的机械字段改成"已发货"（insertOrder 不写 ship_time/status，故用 SQL 置位）
 *  拆表后：`ship_time` 在主表、`status` 在明细。 */
function markShipped(orderNo) {
  const st = `${daysAgo(1)} 12:00:00`;
  dbRun(`UPDATE oi_orders SET ship_time = ? WHERE order_no = ?`, [st, orderNo]);
  dbRun(
    `UPDATE oi_order_items SET status = 'shipped' WHERE order_id = (SELECT id FROM oi_orders WHERE order_no = ?)`,
    [orderNo],
  );
}

console.log('\n[1] 未发货筛选：只认机械事实');

check('未发货的行进列表；`ship_time` 有值或 status=shipped 的不进', () => {
  const a = order({ orderNo: 'A-NEW' });
  const b = order({ orderNo: 'B-SHIPPED' });
  markShipped('B-SHIPPED');
  const r = pick.pickingRows({});
  const nos = r.rows.map((x) => x.orderNo);
  assert.ok(nos.includes('A-NEW'), `应含 A-NEW，实为 ${nos.join(',')}`);
  assert.ok(!nos.includes('B-SHIPPED'), '已发货的行不该进默认列表');
  assert.ok(!r.rows.find((x) => x.orderNo === 'B-SHIPPED')?.shipped, '默认列表里不该有 shipped=true 的行');
  assert.ok(a > 0 && b > 0);
});

check('includeShipped 打开 → 已发货的也回，且 `shipped` 标 true', () => {
  const r = pick.pickingRows({ includeShipped: true });
  const hit = r.rows.find((x) => x.orderNo === 'B-SHIPPED');
  assert.ok(hit, '打开后应能看到已发货的行');
  assert.strictEqual(hit.shipped, true);
  const other = r.rows.find((x) => x.orderNo === 'A-NEW');
  assert.strictEqual(other.shipped, false);
});

console.log('\n[2] 关闭单与无日期：本层**不许**偷偷筛掉（口径在渲染层）');

check('状态为"订单关闭"的行照收（关闭单实测发货时间为空，只有渲染层按状态原文判定）', () => {
  order({ orderNo: 'C-CLOSED', rawFields: { 订单状态: '订单关闭' } });
  const r = pick.pickingRows({});
  const hit = r.rows.find((x) => x.orderNo === 'C-CLOSED');
  assert.ok(hit, '本层要把它交出去（由渲染层剔并计数），不能在这里丢掉');
  assert.strictEqual(hit.bizStatus, '订单关闭');
});

check('没有下单日期的行照收（"没日期"≠"太老"）', () => {
  order({ orderNo: 'D-UNDATED', orderTime: '' });
  const r = pick.pickingRows({});
  const hit = r.rows.find((x) => x.orderNo === 'D-UNDATED');
  assert.ok(hit, '无日期的行必须回得来');
  assert.strictEqual(hit.orderTime, '');
});

console.log('\n[3] 图：三层回落（覆盖图 > 订单图 > 款主图）');

check('① 覆盖图优先：采集行的 `pl_shop_items.image_id` 命中时用覆盖图（哪怕订单图存在）', () => {
  // 覆盖图必须挂在**采集行**上（R1：唯一的图片引用是 image_id），先造一行真采集快照。
  sidb.upsertShopItems({ schema: 'ae-shop-item/v1', store: {}, items: [{ itemId: 'IT-100', title: '覆盖图款' }] });
  const img = pdb.upsertImageRecord({ fingerprint: 'fp-cover-100', localPath: '/tmp/override-100.jpg' });
  pdb.setItemImage({ itemId: 'IT-100', imageId: img.imageId });
  order({ orderNo: 'E-COVER', itemId: 'IT-100', imageId: 1 });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'E-COVER');
  assert.strictEqual(hit.imagePath, '/tmp/override-100.jpg');
});

check('② 无覆盖图 → 用订单识别图（`oi_orders.image_id` → `md_images.local_path`）', () => {
  order({ orderNo: 'F-ORDER', itemId: 'IT-200', imageId: 2 });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'F-ORDER');
  assert.strictEqual(hit.imagePath, '/tmp/order-2.jpg');
});

check('③ 无订单图 → 回落款主图（`pl_shop_sku` 映射 → `pl_products.image_id`）', () => {
  const pid = pdb.upsertProduct({
    code: 'STYLE-P1',
    name: '款P1',
    category: '衣服',
    supplierId: 0,
    status: 'active',
    note: '',
  });
  const img = pdb.upsertImageRecord({ fingerprint: 'fp-prod-P1', localPath: '/tmp/product-P1.jpg' });
  pdb.attachProductImage(pid.id, img.imageId);
  // platform 必须显式给（`resolveOrderSku` 按 platform+shop_id+item_id 精确查；岛侧也是这么传的）
  const mapOut = pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-300', productId: pid.id, status: 'confirmed' },
  ]);
  assert.strictEqual(mapOut.failed.length, 0, `映射不该失败：${JSON.stringify(mapOut.failed)}`);
  order({ orderNo: 'G-PRODUCT', itemId: 'IT-300', imageId: 3 });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'G-PRODUCT');
  assert.strictEqual(hit.imagePath, '/tmp/product-P1.jpg');
});

check('三层都没有 → imagePath 为空串（界面标「缺图」，不静默）', () => {
  order({ orderNo: 'H-NOIMG', itemId: 'IT-999', imageId: 4 });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'H-NOIMG');
  assert.strictEqual(hit.imagePath, '');
});

console.log('\n[4] 款色码 / 供应商 JOIN（与 shippingRows 同口径）');

check('识别链给出款编码与款色（映射命中 → 款/款色 JOIN 带得出来）', () => {
  const rows = pick.pickingRows({}).rows;
  const mapped = rows.find((x) => x.orderNo === 'G-PRODUCT');
  assert.strictEqual(mapped.styleCode, 'STYLE-P1', '映射命中的行应带出产品编码');
  assert.ok(mapped.styleColor, '款色也应带出来（autoAssignByMap 建的款色）');
  const unmapped = rows.find((x) => x.orderNo === 'A-NEW');
  // 2026-10-29 回退「导入即按变体键自动归类」之后，**没有人工映射的行留在待认款**
  //（`style_color_id = 0`），由人在认款界面认。所以这里钉的是：待认款的行不许借映射款，
  // 也不许凭空长出一个款（投影如实反映"还没认"）—— 而那正是认款界面要能看到的名单。
  assert.strictEqual(unmapped.styleCode, '', '没映射的行应是待认款，不能借映射款');
  assert.strictEqual(unmapped.styleColor, '', '待认款的行没有款色');
  assert.strictEqual(unmapped.color, '黑', '颜色/尺码取订单自身字段');
  assert.strictEqual(unmapped.size, 'L');
});

check('供应商未配置时 id=0、名为空（不抛 `no such table`）', () => {
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'A-NEW');
  assert.strictEqual(hit.supplierId, 0);
  assert.strictEqual(hit.supplierName, '');
});

console.log('\n[5] 店铺过滤 / 上限 / 元信息');

check('店铺过滤：只回该店铺的行', () => {
  order({ orderNo: 'I-SHOPB', shop: '店B' });
  const r = pick.pickingRows({ shop: '店B' });
  assert.ok(r.rows.length >= 1);
  assert.ok(r.rows.every((x) => x.shop === '店B'), '过滤后不该混进别的店铺');
  assert.ok(!r.rows.some((x) => x.orderNo === 'A-NEW'), '店A 的行不该出现');
});

check('上限钳制：limit 超范围被夹到 1..5000，meta 回报实际值', () => {
  assert.strictEqual(pick.pickingRows({ limit: 99999 }).meta.limit, 5000);
  assert.strictEqual(pick.pickingRows({ limit: 0 }).meta.limit, 1);
  assert.strictEqual(pick.pickingRows({ limit: 'x' }).meta.limit, 2000); // 非数 → 默认
});

check('meta.rows = 返回行数，且不超过上限（界面按它说清"这批是怎么来的"）', () => {
  const r = pick.pickingRows({ limit: 3 });
  assert.strictEqual(r.meta.rows, r.rows.length);
  assert.ok(r.rows.length <= 3, `上限 3 时不该回 ${r.rows.length} 行`);
  assert.strictEqual(pick.pickingRows({ limit: 3 }).meta.limit, 3);
});

check('脏 raw_fields（不是合法 JSON）不毁整批：该行仍回，rawFields 为空对象（件数按 1 件并标缺）', () => {
  const id = order({ orderNo: 'J-DIRTY' });
  dbRun(`UPDATE oi_order_items SET raw_fields = 'not-json' WHERE id = ?`, [id]);
  const r = pick.pickingRows({});
  const hit = r.rows.find((x) => x.orderNo === 'J-DIRTY');
  assert.ok(hit, '脏行也必须回得来（不能让一条脏数据毁掉整批）');
  assert.deepStrictEqual(hit.rawFields, {});
  assert.strictEqual(pick.pickingRows({}).rows.length, r.rows.length);
});

console.log('\n[6] 映射带颜色（D4）：颜色从"每单看图"变成"配一次、后面全自动"');

check('映射配了色 → 归款把色落到款色，拣货投影的「有效颜色」取到它（订单侧无颜色）', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (10, 'sha10', 'fp10', 'u10', '/tmp/order-10.jpg')`,
  );
  const pid = pdb.upsertProduct({
    code: 'STYLE-C1',
    name: '款C1',
    category: '衣服',
    supplierId: 0,
    status: 'active',
    note: '',
  });
  const m = pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-COLOR', productId: pid.id, spec: '黑色', status: 'confirmed' },
  ]);
  assert.strictEqual(m.failed.length, 0, `映射不该失败：${JSON.stringify(m.failed)}`);
  // 订单侧**没有**颜色（真实芒果待发货单就是这样：该列恒空）
  order({ orderNo: 'K-COLOR', itemId: 'IT-COLOR', imageId: 10, color: '' });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'K-COLOR');
  assert.strictEqual(hit.styleCode, 'STYLE-C1', '款编码应由映射带出');
  assert.strictEqual(hit.styleColor, '黑色', '款色应为映射配的颜色');
  assert.strictEqual(hit.color, '黑色', '有效颜色应回落款色（订单侧是空的）');
});

check('同店同商品ID 两条（`*` 与带色）→ 带色那条优先', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (11, 'sha11', 'fp11', 'u11', '/tmp/order-11.jpg')`,
  );
  const a = pdb.upsertProduct({ code: 'STYLE-C2A', name: '款C2A', category: '衣服', supplierId: 0, status: 'active', note: '' });
  const b = pdb.upsertProduct({ code: 'STYLE-C2B', name: '款C2B', category: '衣服', supplierId: 0, status: 'active', note: '' });
  pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-PRIO', productId: a.id, status: 'confirmed' },
  ]);
  pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-PRIO', productId: b.id, spec: '红色', status: 'confirmed' },
  ]);
  order({ orderNo: 'M-PRIO', itemId: 'IT-PRIO', imageId: 11 });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'M-PRIO');
  assert.strictEqual(hit.styleCode, 'STYLE-C2B', '应取带色那条（配了色却不生效 = 最难查的一类）');
  assert.strictEqual(hit.color, '红色');
});

check('先导订单、后配映射 → 回填存量订单（不必把 Excel 重导一遍）', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (12, 'sha12', 'fp12', 'u12', '/tmp/order-12.jpg')`,
  );
  order({ orderNo: 'N-BACKFILL', itemId: 'IT-BF', imageId: 12 }); // 此刻还没有映射
  const before = pick.pickingRows({}).rows.find((x) => x.orderNo === 'N-BACKFILL');
  // 配映射前：**待认款**（`style_color_id = 0`）。2026-10-29 回退「导入即归类」之后
  // 导入不再自动建临时款，所以这里必须是空的 —— 把"有临时款"当常态是旧世界的口径。
  assert.strictEqual(before.styleCode, '', '配映射前应是待认款（导入不再自动建临时款）');
  const pid = pdb.upsertProduct({ code: 'STYLE-BF', name: '款BF', category: '衣服', supplierId: 0, status: 'active', note: '' });
  pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-BF', productId: pid.id, spec: '白色', status: 'confirmed' },
  ]);
  // ⚠️ 这一条是「映射能把待认款的行认下来」的**唯一**守卫：回退后行上是 0（待认款），
  //    候选判据（`guessedScSql`）必须把 0 当候选；否则用户配完映射看不到任何变化。
  const n = odb.reassignOrdersByItemIds(['IT-BF']);
  assert.strictEqual(n, 1, '应回填 1 行');
  const after = pick.pickingRows({}).rows.find((x) => x.orderNo === 'N-BACKFILL');
  assert.strictEqual(after.styleCode, 'STYLE-BF');
  assert.strictEqual(after.color, '白色');
});

check('人命名过的色不被映射改判（回填的另一半：只认"猜的"结论，不推翻人的判定）', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (15, 'sha15', 'fp15', 'u15', '/tmp/order-15.jpg')`,
  );
  const rowId = order({ orderNo: 'Q-HUMAN', itemId: 'IT-HUMAN', imageId: 15, color: '黑' });
  // 回退后导入不再自动建款色 ⇒ 这里走**认款界面**的那条写路径把这一行认下来
  //（本用例保护的就是"人认过的结论"不被映射推翻，所以先得有一个人的结论）。
  odb.assignOrderStyle({ orderId: rowId, styleCode: 'TMP-HUMAN', color: '黑' });
  const sc = dbGet(`SELECT COALESCE(style_color_id, 0) AS id FROM oi_order_items WHERE id = ?`, [rowId]);
  assert.ok(sc && Number(sc.id) > 0, '认款后行上必须有款色');
  // 命名：色名从订单原文 `黑` 改成 `玄黑`（命名板/核对页都走这个函数，同时把键标成 named）
  const renamed = odb.renameStyleColor(Number(sc.id), '玄黑');
  assert.ok(renamed.ok, `命名应成功：${JSON.stringify(renamed)}`);
  const pid = pdb.upsertProduct({ code: 'STYLE-HUMAN', name: '款H', category: '衣服', supplierId: 0, status: 'active', note: '' });
  pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-HUMAN', productId: pid.id, spec: '白色', status: 'confirmed' },
  ]);
  const n = odb.reassignOrdersByItemIds(['IT-HUMAN']);
  assert.strictEqual(n, 0, '人命名过的结论不该被映射改判');
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'Q-HUMAN');
  assert.strictEqual(hit.styleColor, '玄黑', '人工色名必须还在');
  assert.notStrictEqual(hit.styleCode, 'STYLE-HUMAN');
});

check('回填不碰已定色的图（人工/识别结论/补过的色都算数 —— 改一次映射不会把历史订单全改判）', () => {
  const n = odb.reassignOrdersByItemIds(['IT-BF']);
  assert.strictEqual(n, 0, '图 12 已定色，不该被重判');
});

check('重导同一份报表不把人工色名改回映射色（映射分支也过"人认过的不动"这道闸门）', () => {
  // Q-HUMAN 已被命名成「玄黑」。同一份订单再进一次（幂等重入会**再跑一遍归款**）——
  // 这条路径不经过 `reassignCore` 的候选判据，只靠 `autoAssignByMap` 自己的闸门拦。
  order({ orderNo: 'Q-HUMAN', itemId: 'IT-HUMAN', imageId: 15, color: '黑' });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'Q-HUMAN');
  assert.strictEqual(hit.styleColor, '玄黑', '重导把人工色名冲成了映射里的「白色」');
  assert.strictEqual(pick.pickingRows({}).rows.filter((x) => x.orderNo === 'Q-HUMAN').length, 1, '重导不该插重复行');
});

check('未配颜色的映射（spec 缺省）行为不变 —— 颜色回落订单原文，不会凭空多出色', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (13, 'sha13', 'fp13', 'u13', '/tmp/order-13.jpg')`,
  );
  const pid = pdb.upsertProduct({ code: 'STYLE-C3', name: '款C3', category: '衣服', supplierId: 0, status: 'active', note: '' });
  pdb.upsertSkuMappings([
    { platform: 'aliexpress', shopId: shop.id, itemId: 'IT-OLDWAY', productId: pid.id, status: 'confirmed' },
  ]);
  order({ orderNo: 'P-OLDWAY', itemId: 'IT-OLDWAY', imageId: 13, color: '藏青' });
  const hit = pick.pickingRows({}).rows.find((x) => x.orderNo === 'P-OLDWAY');
  assert.strictEqual(hit.styleCode, 'STYLE-C3');
  assert.strictEqual(hit.color, '藏青', '映射没配色 → 用订单原文色（一期行为不变）');
});

console.log('\n[7] 图 ↔ 款色 1:1（R1）：一张图只有一个色结论，行上的款色列才是权威');

check('同一张图被两行共用：认款后两行读同一个结论，墙上只挂一个款色（不再是"图行持色"）', () => {
  dbRun(
    `INSERT INTO md_images (id, fingerprint, url_fingerprint, source_url, local_path)
     VALUES (16, 'sha16', 'fp16', 'u16', '/tmp/order-16.jpg')`,
  );
  // 真库取证（方案 §8）：`(店铺,商品ID,图片) 58 组 ⇔ (店铺,商品ID,Color) 58 组`，
  // **图片 → 多色 = 0**。所以 R1 把「图」收成一个款色的代表图（1:1）：
  // 一张图只能回答一次"我是什么色"。同一 listing 多色各归各的（S0b 的"映射图片优先"）
  // 是另一刀，本轮不做。
  const rf = (c) => ({ 商品信息: `【1】 某款 (产品属性:Color:${c}、Size:L)\n(商品数量:1 piece)` });
  const rowA = order({ orderNo: 'R-SHARE-A', itemId: 'IT-SHARE', imageId: 16, color: '黑', rawFields: rf('黑') });
  order({ orderNo: 'R-SHARE-B', itemId: 'IT-SHARE', imageId: 16, color: '白', rawFields: rf('白') });
  // 人工认款（按行归款 = 这张图整片改成 X，`setImageStyleColor` 的全量投影语义）
  odb.assignOrderStyle({ orderId: rowA, styleCode: 'STYLE-SHARE', color: '黑' });
  const rows = pick.pickingRows({}).rows;
  const a = rows.find((x) => x.orderNo === 'R-SHARE-A');
  const b = rows.find((x) => x.orderNo === 'R-SHARE-B');
  assert.strictEqual(a.styleColor, '黑', '认款的那行读到自己的结论');
  assert.strictEqual(a.styleCode, 'STYLE-SHARE');
  // 图只有一个答案 ⇒ 共用这张图的另一行也跟着读「黑」。这是 1:1 的**可预期结果**，
  // 不是"后进改判"回归（真库里不存在"一图多色"，那种情形由 S0b 的图片优先映射解决）。
  assert.strictEqual(b.styleColor, '黑', '同一张图的行读同一个结论（图 1:1）');
  // 直接对库验 1:1（不借投影的间接效应）：这张图最多挂一个款色
  const bound = dbQuery(`SELECT id FROM oi_style_colors WHERE image_id = 16`);
  assert.strictEqual(bound.length, 1, '一张图只许挂一个款色（R1：款色代表图 1:1）');
});

console.log('');
if (failed > 0) {
  console.log(`\u2717 拣货投影冒烟失败：${failed} 项`);
  closeDb();
  process.exit(1);
}
console.log('\u2713 拣货投影冒烟全部通过');
closeDb();
// 显式退出：不显式退出时 Electron 在无 GUI 环境里崩退（stderr 一屏 GPU/sandbox 报错，退出码 SIGTRAP）
process.exit(0);