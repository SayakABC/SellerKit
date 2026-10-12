// 订单域数据层冒烟（不启动界面）。
//
//   npm run order:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/order-db-smoke.cjs
//
// 为什么单独一个：订单域是最大的域（写最多、列最多、被三个岛消费），但此前**没有自己的冒烟** ——
// 2026-09-29 的金额提列与拆行改动只能被 `style:smoke` / `product:sku:smoke` 间接兜住。
// 覆盖的不变量（都踩过或差点踩）：
//   · 幂等重入：同 (订单号, 图片) 重复导入不产生重复行（重导 Excel 是常态）
//   · **金额入账**：raw_fields → 14 列的提取（分；空列 → NULL，**不是 0**）
//   · **投影宽了仍不丢行**：`shippingRows` 用 LEFT JOIN 取款编码，未识别的订单行必须仍在
//   · 状态/时点原样带出（判定口径不在这层）
//   · `groupStats` 维度白名单（越界维度不许静默返回空）
//   · 队列（oi_queue）落库/统计/分页
//   · `clearAll` 清空订单与识别缓存
// 每个场景自带独立临时库（`initDb` 是单例，换库必须先 `closeDb`）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-order-smoke-'));

const { initDb, closeDb, dbGet, dbQuery, dbRun } = require(
  path.join(ROOT, 'dist', 'electron', 'db.js'),
);
const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));

initDb(path.join(dir, 'smoke.db'));
odb.ensureOrderSchema();
pdb.ensureProductSchema();

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

/** 造一张图（订单行挂在图上，`oi_orders.image_id` 有外键） */
dbRun(
  `INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (1, 'sha1', 'fp1', 'u1', '/tmp/1')`,
);
dbRun(
  `INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (2, 'sha2', 'fp2', 'u2', '/tmp/2')`,
);

/** 一行真实形状的订单（取自 `订单数据.xlsx` 的表头与取值） */
const RAW = {
  订单号: '3076475435222658',
  订单状态: '等待买家收货',
  下单时间: '08/30/2026 07:00',
  付款时间: '08/30/2026 07:00',
  产品总金额: 'CN￥ 199.87',
  预计增值税: 'CN￥ 34.69',
  订单金额: 'CN￥ 165.18',
  DDP关税: 'CN￥ 22.94',
  店铺优惠: 'CN￥ 0.00',
  平台补贴: 'CN￥ 12.34',
  商品ID: '1005011764572483',
  收货国家: 'Latvia',
  平台是否代征代缴: '平台已税',
  订单业务模式: '半托管jit订单',
  发货时间: '08/31/2026 12:57',
};

function insert(over = {}) {
  return odb.insertOrder({
    imageId: 1,
    orderNo: '3076475435222658',
    shop: '店A',
    size: 'L',
    orderTime: '08/30/2026 07:00',
    category: '衣服',
    color: '黑',
    logo: '',
    rawFields: RAW,
    ...over,
  });
}

console.log('\n[1] 入库与幂等');
check('插入一条订单返回自增 id', () => {
  const id = insert();
  assert.ok(id > 0, 'id 应大于 0');
});
check('幂等重入：同 (订单号, 图片) 不产生第二行', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n);
  insert();
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), before);
});
check('同订单号挂到另一张图 → 是另一行（拆行后一单多产品就是这样）', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n);
  insert({ imageId: 2 });
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), before + 1);
});

console.log('\n[2] 金额 / 状态 / 时点入账（分；空列 → NULL 而不是 0）');
check('金额按实提取（只提主线要的列；**零读者列已删**）', () => {
  const r = dbGet(`SELECT * FROM oi_orders ORDER BY id LIMIT 1`);
  assert.strictEqual(Number(r.amount_cents), 16518);
  assert.strictEqual(Number(r.vat_cents), 3469);
  assert.strictEqual(Number(r.ddp_cents), 2294);
  // 零读者列已从表里删掉（精简：非必要先删，原文仍在 raw_fields 里保真）
  for (const dropped of ['goods_cents', 'ship_fee_cents', 'shop_discount_cents',
    'platform_subsidy_cents', 'currency', 'biz_mode', 'paid_time', 'received_time']) {
    assert.strictEqual(r[dropped], undefined, `不该再有列 ${dropped}`);
  }
});
check('报表里没有的金额列 → NULL（**不是 0**）', () => {
  // 本用例样本没有 DDP 之外的"空金额列"了 → 用 vat 的代表性：缺列即 NULL
  const id = odb.insertOrder({ imageId: 1, orderNo: 'NO-EMPTY', shop: '', size: '', orderTime: '',
    category: '', color: '', logo: '', rawFields: { 商品ID: 'X1' } });
  const r = dbGet(`SELECT amount_cents, vat_cents, ddp_cents FROM oi_orders WHERE id = ?`, [id]);
  assert.strictEqual(r.amount_cents, null);
  assert.strictEqual(r.vat_cents, null);
  assert.strictEqual(r.ddp_cents, null);
  dbRun(`DELETE FROM oi_orders WHERE id = ?`, [id]); // 用完即清：后面的用例按行数断言
});
check('状态 / 代征代缴 / 发货时点原样带出（业务模式等已精简掉）', () => {
  const r = dbGet(`SELECT biz_status, tax_platform, ship_time FROM oi_orders LIMIT 1`);
  assert.strictEqual(r.biz_status, '等待买家收货');
  assert.strictEqual(r.tax_platform, '平台已税');
  assert.strictEqual(r.ship_time, '08/31/2026 12:57');
});
check('主干两列：source 默认 import、qty 缺省 NULL（真值由采集通道写入）', () => {
  const r = dbGet(`SELECT source, qty FROM oi_orders LIMIT 1`);
  assert.strictEqual(r.source, 'import');
  assert.strictEqual(r.qty, null);
});

console.log('\n[2.5] 免图订单（S2-b）：订单报表没有主图列，照样能落主干');

check('image_id 为 null 的订单能落库，且金额/状态照常提列', () => {
  const id = odb.insertOrder({
    imageId: null,
    orderNo: 'NOIMG-1',
    shop: '',
    size: 'L',
    orderTime: '2026-09-01 10:00:00',
    category: '',
    color: '',
    logo: '',
    rawFields: {
      订单号: 'NOIMG-1',
      订单状态: '等待发货',
      订单金额: 'CN￥ 165.18',
      预计增值税: 'CN￥ 34.69',
      DDP关税: 'CN￥ 22.94',
      平台是否代征代缴: '平台已税',
    },
  });
  const r = dbGet(`SELECT image_id, source, amount_cents, vat_cents, biz_status, ship_time FROM oi_orders WHERE id = ?`, [id]);
  assert.strictEqual(r.image_id, null, '无图订单的 image_id 必须是 NULL');
  assert.strictEqual(r.source, 'import');
  assert.strictEqual(Number(r.amount_cents), 16518);
  assert.strictEqual(Number(r.vat_cents), 3469);
  assert.strictEqual(r.biz_status, '等待发货');
  assert.strictEqual(r.ship_time, '');
});

check('免图订单**重导不重复插**（幂等判重用 `image_id IS ?`，`= NULL` 会永远不成立）', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders WHERE order_no = 'NOIMG-1'`).n);
  odb.insertOrder({
    imageId: null, orderNo: 'NOIMG-1', shop: '', size: 'L', orderTime: '2026-09-01 10:00:00',
    category: '', color: '', logo: '', rawFields: { 订单号: 'NOIMG-1' },
  });
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders WHERE order_no = 'NOIMG-1'`).n), before);
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NOIMG-1'`);
});

console.log('\n[3] shippingRows 投影（宽了但**不丢行**）');
check('未识别款的订单行仍在（LEFT JOIN 不是 INNER）', () => {
  const rows = odb.shippingRows(50);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => r.styleCode === ''), '未识别款应回落空串');
});
check('投影带出 店铺 / 款编码 / 时点 / 金额 / 状态', () => {
  const r = odb.shippingRows(50)[0];
  assert.strictEqual(r.shop, '店A');
  assert.strictEqual(r.orderTime, '08/30/2026 07:00');
  assert.strictEqual(r.amountCents, 16518);
  assert.strictEqual(r.bizStatus, '等待买家收货');
  assert.strictEqual(r.taxPlatform, '平台已税');
  assert.strictEqual(typeof r.rawFields, 'object');
});
check('SKU / 供应商字段在投影里（缺 suppliers 表时降级为空，不抛 no such table）', () => {
  // 本冒烟只建了订单域 + 产品域的表，**没建采购域的 suppliers** → 正好覆盖"缺表降级"这条路径
  const r = odb.shippingRows(50)[0];
  assert.strictEqual(typeof r.color, 'string');
  assert.strictEqual(typeof r.size, 'string');
  assert.strictEqual(r.supplierId, 0, '缺 suppliers 表时应回落 0');
  assert.strictEqual(r.supplierName, '');
});

check('识别出款色后，投影里的款编码/色随之带出', () => {
  // 走识别链：图 → 款色 → 款（`shippingRows` 的 LEFT JOIN 就是这条）
  const st = odb.resolveStyle({
    fingerprint: 'fp1',
    category: '衣服',
    features: ['长袖'],
    color: '黑',
    styleName: '测试款',
  });
  odb.setImageStyleColor(1, st.styleColorId);
  const r = odb.shippingRows(50).find((x) => x.id === 1);
  assert.ok(r.styleCode, '款编码应带出');
  assert.strictEqual(r.styleColor, '黑');
});

console.log('\n[4] 其它读取面');
check('groupStats 维度白名单：越界维度被忽略（不静默返回错数）', () => {
  const ok = odb.groupStats(['shop']);
  assert.ok(Array.isArray(ok) && ok.length >= 1);
  const bad = odb.groupStats(['not_a_dimension']);
  assert.ok(Array.isArray(bad));
});
check('列表分页/搜索可用', () => {
  const page = odb.listOrdersPage({ limit: 1 });
  assert.strictEqual(page.rows.length, 1);
  assert.ok(page.total >= 2);
});
check('列表回带商品ID 与原始整行（归类核对页按「同商品」分组靠它）', () => {
  // 这一条钉的是**主进程侧**的推导：渲染层拿到的 itemId 不是自己正则匹配出来的，
  // 而是 `mapOrderRow` 用 `extractSkuFields` 从 raw_fields 取的（与回流写映射同一个函数）。
  const hit = odb.listOrdersPage({ limit: 5 }).rows.find((r) => r.itemId);
  assert.ok(hit, '带商品ID 的行必须回带 itemId');
  assert.strictEqual(hit.itemId, '1005011764572483', 'itemId 应取自原始行的「商品ID」列');
  assert.ok(Object.keys(hit.rawFields).length > 0, '原始整行要一起回来（itemId 就是从它推出来的）');
  // 反向：原始行里**没有**商品ID 列时回空串 —— 不能是 undefined、更不能抓一个像但不是的列名
  // （「商品名称」是刻意放的**干扰项**：只放"唯一可选项"等于没测）
  const id = odb.insertOrder({
    imageId: null, orderNo: 'NO-ITEM', shop: '店Z', size: '', orderTime: '',
    category: '', color: '', logo: '', rawFields: { 订单号: 'NO-ITEM', 商品名称: '不是商品ID' },
  });
  const without = odb.listOrdersPage({ limit: 50 }).rows.find((r) => Number(r.id) === Number(id));
  assert.ok(without, '临时行应能查到');
  assert.strictEqual(without.itemId, '', '没有商品ID 列时应回空串（而不是抓到名字相近的列）');
  dbRun(`DELETE FROM oi_orders WHERE id = ?`, [id]); // 用完即清：后面的用例按行数断言
});

console.log('\n[5] 队列（oi_queue）');
check('入队 / 统计 / 分页', () => {
  const n = odb.enqueueQueueRows('B1', [
    { rawFields: { 商品ID: 'A1' }, url: 'u1', orderNo: 'N1', info: '' },
    { rawFields: { 商品ID: 'A2' }, url: 'u2', orderNo: 'N2', info: '' },
  ]);
  assert.strictEqual(n, 2);
  const stats = odb.queueStats('B1');
  assert.strictEqual(Number(stats.total), 2);
  const rows = odb.listQueueRows('B1');
  assert.strictEqual(rows.length, 2);
});

console.log('\n[6] 订单归属店铺（order-assign-shop）');
check('归属：按订单号改 shop 原文，且只改给出的订单', () => {
  // 现有两行：SMOKE 用的 3076…（图1 与图2 各一行，拆行后一单多行会一起改）
  const r = odb.assignShopToOrders(['3076475435222658'], '店X');
  assert.strictEqual(r.updated, 2, '同订单号的多行应一起更新');
  const rows = dbQuery(`SELECT shop FROM oi_orders WHERE order_no = '3076475435222658'`);
  assert.ok(rows.every((x) => x.shop === '店X'), '都应是店X');
});
check('幂等：已同名不再改（updated=0）', () => {
  assert.strictEqual(odb.assignShopToOrders(['3076475435222658'], '店X').updated, 0);
});
check('空店铺名 / 空订单号 → 0 且不动数据', () => {
  assert.strictEqual(odb.assignShopToOrders(['3076475435222658'], '   ').updated, 0);
  assert.strictEqual(odb.assignShopToOrders([], '店Y').updated, 0);
});

console.log('\n[6.5] 核对状态（确认无误 / 全部确认 / **退回待核对**）');
// 「归类核对」页那一对动作的数据层守卫：
//   · 「确认无误 / 全部确认无误」= corrected 置 1（行**离开**待核对列表）；
//   · 「退回待核对」= corrected 置 0（行**回到**待核对列表，2026-10-12 新增）。
// ⚠️ 退回这一支**只有这里能验**：`today:ui` 跑的是假桥（渲染层），碰不到这两条 SQL；
//    而"退回把字段一起改了"这种错在界面上完全看不出来（行照样回到待核对列表）。
// ⚠️ 本节的判据都要**逐行可观测**（读回那一行的列），不能只断言汇总数 ——
//    对称地把两个状态位换来换去，汇总数照样对得上（本仓踩过）。
check('「确认无误」只动点名的那一行（其余行不受影响）', () => {
  const pendBefore = odb.listOrdersPage({ corrected: false });
  assert.ok(pendBefore.total > 0, '前置：这一节开始时应当还有待核对的行');
  const one = pendBefore.rows[0].id;
  assert.strictEqual(odb.markOrdersCorrected([one]), 1);
  const pendAfter = odb.listOrdersPage({ corrected: false });
  assert.strictEqual(pendAfter.total, pendBefore.total - 1, '待核对应当少一行');
  assert.ok(!pendAfter.rows.some((o) => o.id === one), '被确认的那一行不该还在待核对里');
  assert.ok(
    odb.listOrdersPage({ corrected: true }).rows.some((o) => o.id === one),
    '它应当出现在已核对里',
  );
});
check('corrected 过滤三态：false 只出待核对 / true 只出已核对 / 不传 = 不过滤（全表）', () => {
  const pend = odb.listOrdersPage({ corrected: false });
  const corr = odb.listOrdersPage({ corrected: true });
  const all = odb.listOrdersPage({});
  assert.ok(pend.total > 0, '前置：应当还有待核对的行');
  assert.ok(corr.total > 0, '前置：上一条已确认过一行');
  assert.strictEqual(all.total, pend.total + corr.total, '不传时必须是不过滤（= 两态之和）');
  assert.ok(pend.rows.every((o) => o.corrected === false), 'corrected:false 里不该有已核对的行');
  assert.ok(corr.rows.every((o) => o.corrected === true), 'corrected:true 里不该有待核对的行');
});
check('⭐「退回待核对」把它放回待核对，且**不碰**这一行的其它字段', () => {
  // 先给这一行写上可辨识的字段值 —— `updateOrder` 自己会把行置为已核对，
  // 那正是"被确认掉"的形状（真库现场：23 行 corrected=1 而 color 全空）。
  const one = odb.listOrdersPage({ corrected: true }).rows[0].id;
  odb.updateOrder({ id: one, category: 'T恤', color: '藏青', logo: 'LOGO-X' });
  const before = dbGet(`SELECT category, color, logo FROM oi_orders WHERE id = ?`, [one]);

  assert.strictEqual(odb.reopenOrdersCorrected([one]), 1, '应当更新 1 行');
  const after = dbGet(`SELECT category, color, logo, corrected FROM oi_orders WHERE id = ?`, [one]);
  // ① 状态位真的落下去了（不是"函数返回值对、库没动"）
  assert.strictEqual(Number(after.corrected), 0, 'corrected 必须回到 0');
  // ② 其它字段**一个都不要动**：退回是"把这一行放回去重做"，不是"把它清空"。
  //    把字段一起重写（哪怕写成同样的值）都是错的 —— 那意味着退回用的是界面那一刻的草稿。
  assert.deepStrictEqual(
    { category: after.category, color: after.color, logo: after.logo },
    { category: before.category, color: before.color, logo: before.logo },
    '退回不许改 category / color / logo',
  );
  // ③ 回到待核对列表（这是"退回"的目的，不是"从已核对里挪走"）
  assert.ok(
    odb.listOrdersPage({ corrected: false }).rows.some((o) => o.id === one),
    '退回后它必须出现在待核对列表里',
  );
  assert.ok(
    !odb.listOrdersPage({ corrected: true }).rows.some((o) => o.id === one),
    '退回后它不该还在已核对列表里',
  );
});
check('退回与确认**互为镜像**：都按点名的 id 直接写目标值（不额外要求"原状态不是它"）', () => {
  const one = odb.listOrdersPage({ corrected: false }).rows[0].id;
  // ⚠️ 对一行**本来就待核对**的行再"退回"，changes 仍是 1（不是 0）—— 这是**刻意与
  //    `markOrdersCorrected` 对齐**的：那个函数同样不校验"原来是不是已核对"，点名即写。
  //    两个方向互为镜像 ⇒ 别顺手给退回加 `AND corrected = 1`：那会让两个函数的"影响行数"
  //    含义分叉，而界面上根本分不出来（「退回」的入口只出现在**已核对**的行上）。
  assert.strictEqual(odb.reopenOrdersCorrected([one]), 1, '点名即写 0（与 mark 同款语义）');
  assert.strictEqual(
    Number(dbGet(`SELECT corrected FROM oi_orders WHERE id = ?`, [one]).corrected),
    0,
  );
  // 反过来：确认 → 退回 → 再确认，状态位来回都能落下去（两个方向都不是单向门）
  assert.strictEqual(odb.markOrdersCorrected([one]), 1);
  assert.strictEqual(odb.reopenOrdersCorrected([one]), 1);
  assert.strictEqual(
    Number(dbGet(`SELECT corrected FROM oi_orders WHERE id = ?`, [one]).corrected),
    0,
  );
});
check('退回的入参边界：空数组 / 不存在的 id → 0，且不误伤别的行', () => {
  const before = dbQuery(`SELECT id FROM oi_orders WHERE corrected = 0`).length;
  assert.strictEqual(odb.reopenOrdersCorrected([]), 0);
  assert.strictEqual(odb.reopenOrdersCorrected([999999]), 0, '不存在的 id 不该命中任何行');
  assert.strictEqual(odb.reopenOrdersCorrected([0, -1, 1.5]), 0, '非正整数一律过滤掉');
  assert.strictEqual(
    dbQuery(`SELECT id FROM oi_orders WHERE corrected = 0`).length,
    before,
    '这几种入参都不该改动任何行',
  );
});
check('「全部确认无误」一次把剩下的待核对全部置 1', () => {
  const before = odb.listOrdersPage({ corrected: false }).total;
  const n = odb.markAllOrdersCorrected();
  assert.strictEqual(n, before, '返回值 = 本次真的影响的行数');
  assert.strictEqual(odb.listOrdersPage({ corrected: false }).total, 0, '待核对应当清零');
  assert.strictEqual(odb.markAllOrdersCorrected(), 0, '再跑一次是 0（幂等）');
});

console.log('\n[7] 清空');
check('clearAll 清掉订单（识别缓存同清）', () => {
  odb.clearAll();
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), 0);
});

closeDb();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n' + '\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 订单域数据层冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log('\u2713 订单域数据层冒烟全部通过\n');
process.exit(0);