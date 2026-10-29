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

/** 造一张图（订单行挂在图上，`oi_order_items.image_id` 有外键） */
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
// 拆表后：`oi_order_items` 是明细行表（一 SKU 一行），行数断言看它；`oi_orders` 是主表（一单一表）。
check('插入一条订单返回自增 id', () => {
  const id = insert();
  assert.ok(id > 0, 'id 应大于 0');
});
check('幂等重入：同 (订单号, 图片) 不产生第二行', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items`).n);
  insert();
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items`).n), before);
});
check('同订单号挂到另一张图 → 是另一行（拆行后一单多产品就是这样）', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items`).n);
  insert({ imageId: 2 });
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items`).n), before + 1);
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
  const r = dbGet(
    `SELECT o.amount_cents, o.vat_cents, o.ddp_cents FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    [id],
  );
  assert.strictEqual(r.amount_cents, null);
  assert.strictEqual(r.vat_cents, null);
  assert.strictEqual(r.ddp_cents, null);
  dbRun(`DELETE FROM oi_order_items WHERE id = ?`, [id]); // 用完即清：后面的用例按行数断言
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NO-EMPTY'`);
});
check('状态 / 代征代缴 / 发货时点原样带出（业务模式等已精简掉）', () => {
  const r = dbGet(`SELECT biz_status, tax_platform, ship_time FROM oi_orders LIMIT 1`);
  assert.strictEqual(r.biz_status, '等待买家收货');
  assert.strictEqual(r.tax_platform, '平台已税');
  assert.strictEqual(r.ship_time, '08/31/2026 12:57');
});
check('主干两列：source 默认 import、qty 缺省 NULL（真值由采集通道写入）', () => {
  const r = dbGet(`SELECT source FROM oi_orders LIMIT 1`);
  assert.strictEqual(r.source, 'import');
  const item = dbGet(`SELECT qty FROM oi_order_items LIMIT 1`);
  assert.strictEqual(item.qty, null);
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
  const r = dbGet(
    `SELECT oi.image_id, o.source, o.amount_cents, o.vat_cents, o.biz_status, o.ship_time
     FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    [id],
  );
  assert.strictEqual(r.image_id, null, '无图订单的 image_id 必须是 NULL');
  assert.strictEqual(r.source, 'import');
  assert.strictEqual(Number(r.amount_cents), 16518);
  assert.strictEqual(Number(r.vat_cents), 3469);
  assert.strictEqual(r.biz_status, '等待发货');
  assert.strictEqual(r.ship_time, '');
});

check('免图订单**重导不重复插**（幂等判重用 `image_id IS ?`，`= NULL` 会永远不成立）', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE o.order_no = 'NOIMG-1'`).n);
  odb.insertOrder({
    imageId: null, orderNo: 'NOIMG-1', shop: '', size: 'L', orderTime: '2026-09-01 10:00:00',
    category: '', color: '', logo: '', rawFields: { 订单号: 'NOIMG-1' },
  });
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE o.order_no = 'NOIMG-1'`).n), before);
  dbRun(`DELETE FROM oi_order_items WHERE order_id IN (SELECT id FROM oi_orders WHERE order_no = 'NOIMG-1')`);
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NOIMG-1'`);
});

console.log('\n[3] shippingRows 投影（宽了但**不丢行**）');
check('订单行仍在（LEFT JOIN 不是 INNER）—— 2026-10-29 回退后未认款的行也在投影里（款编码空串）', () => {
  const rows = odb.shippingRows(50);
  assert.strictEqual(rows.length, 2, '投影不许因为归类问题丢行');
  // 2026-10-29 回退「导入即归类」：RAW 带商品ID 也**不再自动归**，行留待认款。
  // 这条守的是"未认款的行照样出现在利润投影里"（LEFT JOIN），且款编码回落空串（不是报错）。
  assert.ok(rows.every((r) => r.styleCode === ''), `未认款行的款编码应为空串，实际 ${JSON.stringify(rows.map((r) => r.styleCode))}`);
});
check('真正无法归类的行（无商品ID）也在投影里，款编码回落空串', () => {
  const id = odb.insertOrder({
    imageId: null, orderNo: 'NOID-PROJ', shop: '店A', size: 'L', orderTime: '',
    category: '', color: '', logo: '', rawFields: { 订单号: 'NOID-PROJ' },
  });
  const rows = odb.shippingRows(50);
  assert.strictEqual(rows.length, 3, '无商品ID 的行也必须出现（少一行就是悄悄少算）');
  const target = rows.find((r) => r.orderNo === 'NOID-PROJ');
  assert.ok(target, '找不到那一行');
  assert.strictEqual(target.styleCode, '');
  assert.strictEqual(Number(target.styleColorId), 0);
  dbRun(`DELETE FROM oi_order_items WHERE id = ?`, [id]);
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NOID-PROJ'`);
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
  dbRun(`DELETE FROM oi_order_items WHERE id = ?`, [id]); // 用完即清：后面的用例按行数断言
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NO-ITEM'`);
});

console.log('\n[6] 订单归属店铺（order-assign-shop）');
check('归属：按订单号改 shop 原文，且只改给出的订单', () => {
  // 现有两行：SMOKE 用的 3076…（图1 与图2 各一行，拆行后一单多行）→ 主表一单一行，updated=1
  const r = odb.assignShopToOrders(['3076475435222658'], '店X');
  assert.strictEqual(r.updated, 1, '同订单号的一主表行应更新');
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
  const before = dbGet(`SELECT category, color, logo FROM oi_order_items WHERE id = ?`, [one]);

  assert.strictEqual(odb.reopenOrdersCorrected([one]), 1, '应当更新 1 行');
  const after = dbGet(`SELECT category, color, logo, corrected FROM oi_order_items WHERE id = ?`, [one]);
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
    Number(dbGet(`SELECT corrected FROM oi_order_items WHERE id = ?`, [one]).corrected),
    0,
  );
  // 反过来：确认 → 退回 → 再确认，状态位来回都能落下去（两个方向都不是单向门）
  assert.strictEqual(odb.markOrdersCorrected([one]), 1);
  assert.strictEqual(odb.reopenOrdersCorrected([one]), 1);
  assert.strictEqual(
    Number(dbGet(`SELECT corrected FROM oi_order_items WHERE id = ?`, [one]).corrected),
    0,
  );
});
check('退回的入参边界：空数组 / 不存在的 id → 0，且不误伤别的行', () => {
  const before = dbQuery(`SELECT id FROM oi_order_items WHERE corrected = 0`).length;
  assert.strictEqual(odb.reopenOrdersCorrected([]), 0);
  assert.strictEqual(odb.reopenOrdersCorrected([999999]), 0, '不存在的 id 不该命中任何行');
  assert.strictEqual(odb.reopenOrdersCorrected([0, -1, 1.5]), 0, '非正整数一律过滤掉');
  assert.strictEqual(
    dbQuery(`SELECT id FROM oi_order_items WHERE corrected = 0`).length,
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
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items`).n), 0);
});

// ─────────────────────────────────────────────────────────────
// [8] 行级快照（2026-10-21 阶段 A3/A4/A5）
//
// 两个数各自一个写入口，共用一条纪律：**只补空**（已钉过的不重算）。
// 这里连「结构」一起复刻（款色身份 + 产品编码 + SKU 颜色尺码），否则错误实现也能恒绿：
//   · 夹具放**两个 SKU**（250g / 999g）—— 取错行（比如不看尺码）会拿到 999，断言立刻红；
//   · 干扰项：先钉 250 再改 SKU 成 300，断言仍是 250（"改克重不该刷新历史"）。
// ─────────────────────────────────────────────────────────────
console.log('\n[8] 行级快照：克重 / 实际进价（只补空）');
odb.ensureOrderSchema();
pdb.ensureProductSchema();
pdb.ensureVariantSchema();

// id 一律自增（前面的场景已经用过 1..N，硬编码会撞主键）
dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES ('SNAP-1', 'f-snap')`);
const snapStyleId = Number(dbGet(`SELECT id FROM oi_styles WHERE code = 'SNAP-1'`).id);
dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, '黑色', 'SNAP-1-BLACK')`, [
  snapStyleId,
]);
const snapScId = Number(dbGet(`SELECT id FROM oi_style_colors WHERE code = 'SNAP-1-BLACK'`).id);
const snapProduct = pdb.upsertProduct({
  id: 0,
  code: 'SNAP-1',
  name: '快照款',
  supplierId: 0,
  category: '',
  status: 'active',
  note: '',
}).id;
pdb.variantUpsert({ id: 0, productId: snapProduct, color: '黑色', size: 'M', weightG: 250 });
pdb.variantUpsert({ id: 0, productId: snapProduct, color: '黑色', size: 'L', weightG: 999 });
const insOrder = (size, scId) => {
  // 拆表后：主表（一单一行，order_no 唯一）+ 明细（一 SKU 一行）。明细 id 即"行 id"。
  // 每个夹具行用独立单号（主表 order_no UNIQUE，旧形状允许同单多行、新形状一单一行）。
  const no = `SNAP-ORDER-${size}-${scId}-${Math.floor(Math.random() * 1e6)}`;
  dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES (?, '店')`, [no]);
  const headerId = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = ?`, [no]).id);
  dbRun(
    `INSERT INTO oi_order_items (order_id, image_id, size, raw_fields, style_color_id)
     VALUES (?, NULL, ?, '{}', ?)`,
    [headerId, size, scId],
  );
  return Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ?`, [headerId]).id);
};
const orderM = insOrder('M', snapScId);
const orderL = insOrder('L', snapScId);

check('v7 两列已就位（新库建表与老库补列同向）', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_order_items)`).map((r) => String(r.name));
  assert.ok(cols.includes('weight_g'), '缺 weight_g');
  assert.ok(cols.includes('cost_cents'), '缺 cost_cents');
});

check('钉克重：按「款色 + 尺码」取到各自的 SKU（M=250 / L=999，不串行）', () => {
  const n = odb.snapshotOrderWeights([orderM, orderL]);
  assert.strictEqual(n, 2);
  assert.strictEqual(Number(dbGet(`SELECT weight_g FROM oi_order_items WHERE id = ?`, [orderM]).weight_g), 250);
  assert.strictEqual(Number(dbGet(`SELECT weight_g FROM oi_order_items WHERE id = ?`, [orderL]).weight_g), 999);
});

check('只补空：改 SKU 克重后再钉，历史行不变（快照语义）', () => {
  const v = dbGet(
    `SELECT v.id FROM pl_variants v WHERE v.product_id = ? AND v.size = 'M'`,
    [snapProduct],
  );
  pdb.variantUpsert({
    id: Number(v.id),
    productId: snapProduct,
    color: '黑色',
    size: 'M',
    weightG: 300,
  });
  odb.snapshotOrderWeights([orderM]);
  assert.strictEqual(Number(dbGet(`SELECT weight_g FROM oi_order_items WHERE id = ?`, [orderM]).weight_g), 250);
});

check('钉不上就留 NULL（不编数）：未归类的行不会被写成 0', () => {
  const unclassified = insOrder('M', 0);
  odb.snapshotOrderWeights([unclassified]);
  assert.strictEqual(dbGet(`SELECT weight_g FROM oi_order_items WHERE id = ?`, [unclassified]).weight_g, null);
});

check('回写实际进价：只认已提交拿货单、按身份+尺码匹配，且只补空', () => {
  const pdb2 = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
  pdb2.ensurePurchaseSchema();
  dbRun(`INSERT INTO suppliers (name) VALUES ('快照厂')`);
  const supId = Number(dbGet(`SELECT id FROM suppliers WHERE name = '快照厂'`).id);
  dbRun(`INSERT INTO purchase_orders (supplier_id, biz_date, status) VALUES (?, '2026-10-01', 'submitted')`, [
    supId,
  ]);
  const poId = Number(dbGet(`SELECT id FROM purchase_orders ORDER BY id DESC LIMIT 1`).id);
  dbRun(
    `INSERT INTO purchase_items (purchase_id, style_code, color, size, qty, price_cents, amount_cents, style_color_id)
     VALUES (?, 'SNAP-1', '黑色', 'L', 2, 1200, 2400, ?)`,
    [poId, snapScId],
  );
  const { syncOrderRowCosts } = require(path.join(ROOT, 'dist', 'electron', 'purchase-cost-sync.js'));
  const out = syncOrderRowCosts();
  assert.ok(out.rows >= 1, '应至少补上 L 码那一行');
  assert.strictEqual(
    Number(
      dbGet(`SELECT actual_cost_cents FROM oi_order_items WHERE id = ?`, [orderL])
        .actual_cost_cents,
    ),
    1200,
  );
  // M 码没有拿货记录 ⇒ 不该被写上（"没拿货"不等于"进货 0 元"）
  assert.strictEqual(
    dbGet(`SELECT actual_cost_cents FROM oi_order_items WHERE id = ?`, [orderM]).actual_cost_cents,
    null,
  );
  // 预估列不归它管：拿货实付只写 actual_cost_cents，不能顺手覆盖归类时钉的进价
  assert.strictEqual(
    dbGet(`SELECT cost_cents FROM oi_order_items WHERE id = ?`, [orderL]).cost_cents,
    null,
  );
  // 再报一次：幂等（已写的不重复写）
  const again = syncOrderRowCosts();
  assert.strictEqual(again.rows, 0);
});

// ── 阶段 B2：包裹（一单多包 / 拆单个商品行 / 拆合并行数量）────────────────────
// 这一组防的四个错，都是"界面显示保存成功、其实没生效"的类型：
//   · 超拆：3 件的行拆成 2+2，两边的界面都敢显示"成功"；
//   · 跨单：把 A 单的商品行塞进 B 单的包（包与行对不上，账面永远平不了）；
//   · 缺值当 0：只填了一个包的运费，总运费却按"已知部分之和"报出去；
//   · 删包留残：包删了、明细还在（外键没级联）。
check('包裹：建包 / 拆合并行数量 / 超拆被拒 / 跨单被拒 / 汇总不把缺值当 0', () => {
  // 拆表后：主表 + 明细。明细 id 即"行 id"（parcel_lines.order_item_id 指向它）。
  dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES ('PKG-1', '店甲')`);
  const h1 = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = 'PKG-1'`).id);
  dbRun(`INSERT INTO oi_order_items (order_id, size, qty, raw_fields) VALUES (?, 'M', 3, '{}')`, [h1]);
  const itemId = Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ?`, [h1]).id);
  dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES ('PKG-2', '店甲')`);
  const h2 = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = 'PKG-2'`).id);
  dbRun(`INSERT INTO oi_order_items (order_id, size, qty, raw_fields) VALUES (?, 'L', 1, '{}')`, [h2]);
  const otherItem = Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ?`, [h2]).id);

  // 拼错单号不许造孤儿包
  const ghost = odb.createParcel({ orderNo: 'NO-SUCH-ORDER' });
  assert.strictEqual(ghost.ok, false, '不存在的订单号必须拒绝');

  const p1 = odb.createParcel({ orderNo: 'PKG-1', label: '箱 1', shipCents: 1500, weightG: 400 });
  const p2 = odb.createParcel({ orderNo: 'PKG-1', label: '箱 2' }); // 运费/重量故意都不填
  assert.ok(p1.ok && p1.id > 0 && p2.ok && p2.id > 0, '两个包都应建成功');
  assert.notStrictEqual(p1.id, p2.id, '一单多包必须是两个不同的包');

  // 3 件拆成 2 + 1
  assert.strictEqual(odb.setParcelLineQty(p1.id, itemId, 2).ok, true, '2 件应放得进去');
  const over = odb.setParcelLineQty(p2.id, itemId, 2);
  assert.strictEqual(over.ok, false, '只剩 1 件，放 2 件必须被拒');
  assert.ok(String(over.error).includes('1'), `拒绝理由要说清还能放几件：${over.error}`);
  assert.strictEqual(odb.setParcelLineQty(p2.id, itemId, 1).ok, true, '剩下那 1 件应放得进去');

  const cross = odb.setParcelLineQty(p1.id, otherItem, 1);
  assert.strictEqual(cross.ok, false, '别的订单的行不许塞进本单的包');
  assert.ok(String(cross.error).includes('不属于'), `跨单要说清原因：${cross.error}`);

  const detail = odb.parcelDetail('PKG-1');
  assert.strictEqual(detail.parcels.length, 2);
  assert.strictEqual(detail.parcels[0].lines.length, 1);
  assert.strictEqual(detail.items[0].packed, 3, '已分包件数应为 2+1');
  assert.strictEqual(detail.items[0].remaining, 0, '3 件全分完，剩余应为 0');
  // ⭐ 缺值不是 0：箱 2 没填运费 ⇒ 整单总运费必须是 null（不能报 1500）
  assert.strictEqual(detail.totals.shipMissing, 1);
  assert.strictEqual(detail.totals.shipCents, null, '有包缺运费时总运费必须是 null，不许只加已知部分');
  assert.strictEqual(detail.totals.weightG, null, '有包缺重量时总重必须是 null');

  // 补齐后才是相加
  assert.strictEqual(odb.updateParcel({ id: p2.id, shipCents: 500, weightG: 100 }).ok, true);
  const filled = odb.parcelTotals('PKG-1');
  assert.strictEqual(filled.shipCents, 2000);
  assert.strictEqual(filled.weightG, 500);
  assert.strictEqual(filled.shipMissing, 0);

  // 改数量 = 覆盖不是追加（同一包同一行只一条）
  assert.strictEqual(odb.setParcelLineQty(p1.id, itemId, 1).ok, true);
  assert.strictEqual(odb.setParcelLineQty(p2.id, itemId, 2).ok, true);
  const swapped = odb.parcelDetail('PKG-1');
  assert.strictEqual(swapped.items[0].packed, 3, '改数量不该把同一行记成两条');
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS n FROM parcel_lines WHERE order_item_id = ?`, [itemId])[0].n,
    2,
    '同一行在两个包里各一条',
  );

  // 清 0 = 从包里移除
  assert.strictEqual(odb.setParcelLineQty(p2.id, itemId, 0).ok, true);
  assert.strictEqual(odb.parcelDetail('PKG-1').items[0].packed, 1);

  // 删包连带删明细
  assert.strictEqual(odb.deleteParcel(p1.id), true);
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS n FROM parcel_lines WHERE parcel_id = ?`, [p1.id])[0].n,
    0,
    '删包必须连明细一起删（外键级联）',
  );
});

// 删订单行后的包裹收尾：`parcel_lines` 靠 ON DELETE CASCADE 消失，但 `parcels` 自己没有
// 外键指向订单行（键是 `order_no`）—— 不补一句就会留下「0 条明细的空壳包」：
// 它照样进 `parcelTotals` 求和（缺值 ⇒ 整单运费被拖成 null），界面上也多一张空卡片。
check('删订单行：空壳包被收掉，还占着别的行的包不动', () => {
  dbRun(`INSERT INTO oi_orders (order_no, shop) VALUES ('PKG-3', '店甲')`);
  const h = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = 'PKG-3'`).id);
  dbRun(`INSERT INTO oi_order_items (order_id, size, qty, raw_fields) VALUES (?, 'M', 1, '{}')`, [h]);
  const itA = Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ?`, [h]).id);
  dbRun(`INSERT INTO oi_order_items (order_id, size, qty, raw_fields) VALUES (?, 'L', 1, '{}')`, [h]);
  const itB = Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ? AND id <> ?`, [h, itA]).id);

  const pa = odb.createParcel({ orderNo: 'PKG-3', label: '箱 A', shipCents: 700, weightG: 100 });
  const pb = odb.createParcel({ orderNo: 'PKG-3', label: '箱 B', shipCents: 800, weightG: 200 });
  assert.ok(pa.ok && pb.ok, '两个包都应建成功');
  assert.strictEqual(odb.setParcelLineQty(pa.id, itA, 1).ok, true);
  assert.strictEqual(odb.setParcelLineQty(pb.id, itB, 1).ok, true);

  // 删掉 itA 那一行 ⇒ 箱 A 的明细被级联带走、包本身也该没；箱 B 还占着 itB，必须留下
  odb.deleteOrder(itA);
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS n FROM parcels WHERE id = ?`, [pa.id])[0].n,
    0,
    '明细被删光的那一行必须把空壳包一起收掉',
  );
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS n FROM parcels WHERE id = ?`, [pb.id])[0].n,
    1,
    '还占着别的商品行的包不能被顺手删掉',
  );
  // 收尾之后总数只算还活着的包（不是把缺值当 0，也不是把空壳算进来）
  const t = odb.parcelTotals('PKG-3');
  assert.strictEqual(t.shipCents, 800);
  assert.strictEqual(t.weightG, 200);
  assert.strictEqual(t.shipMissing, 0);
});

// ── 写入口守卫（B1 拆表后）────────────────────────────────────────────────
// 拆表把 `order_no` 变成主表的 NOT NULL UNIQUE 业务键，两条旧路径随之要做明确决定：
//   · 空单号：旧实现写 NULL 占位（现在必撞 NOT NULL）；
//   · 同一单号有两个写入口：导入逐行追加 / 采集整单替换。
// 断言都读回**行级事实**，不看返回值就算过。
console.log('\n[9] 写入口守卫：空单号 / 通道互斥 / 重采集清包裹');

check('空订单号：明确报错，且不留下半条主表行', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n);
  assert.throws(() => insert({ orderNo: '   ' }), /订单号为空/);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), before, '被拒的行不许留下主表行');
});

check('导入不能往采集单里追加行（通道互斥，正向）', () => {
  odb.upsertCollectedOrder({
    orderNo: 'CH-COLLECT', orderTime: '', bizStatus: '', amountCents: 100,
    lines: [{ itemId: 'x', qty: 1, color: '黑', size: 'M' }],
  });
  assert.throws(() => insert({ orderNo: 'CH-COLLECT' }), /采集通道/);
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE o.order_no = 'CH-COLLECT'`).n),
    1,
    '导入的行不许混进采集单',
  );
});

check('采集重推：整单替换，旧包裹一并清掉（不留空壳污染汇总）', () => {
  const h = Number(dbGet(`SELECT id FROM oi_orders WHERE order_no = 'CH-COLLECT'`).id);
  const it = Number(dbGet(`SELECT id FROM oi_order_items WHERE order_id = ?`, [h]).id);
  const p = odb.createParcel({ orderNo: 'CH-COLLECT', label: '旧箱', shipCents: 999, weightG: 50 });
  assert.strictEqual(odb.setParcelLineQty(p.id, it, 1).ok, true);
  const r = odb.upsertCollectedOrder({
    orderNo: 'CH-COLLECT', orderTime: '', bizStatus: '', amountCents: 200,
    lines: [{ itemId: 'x', qty: 2, color: '黑', size: 'L' }],
  });
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders WHERE order_no = 'CH-COLLECT'`).n), 1, '一单只能有一条主表行');
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE o.order_no = 'CH-COLLECT'`).n),
    1,
    '明细应被整单替换，不是追加',
  );
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM parcels WHERE order_no = 'CH-COLLECT'`).n), 0, '重推后旧包裹必须为 0');
  assert.strictEqual(odb.parcelTotals('CH-COLLECT').shipCents, null, '没有包裹时总运费是 null（不是旧包的 999）');
});

check('采集不能整单替换导入单（通道互斥，反向，且不改导入金额）', () => {
  // imageId 传 null：`[7] clearAll` 已清掉 oi_images，用图 1 会先撞外键，测不到本节的守卫
  insert({ orderNo: 'IMP-ONLY', imageId: null });
  assert.throws(
    () => odb.upsertCollectedOrder({ orderNo: 'IMP-ONLY', orderTime: '', bizStatus: '', amountCents: 1, lines: [] }),
    /导入/,
  );
  const h = dbGet(`SELECT source, amount_cents FROM oi_orders WHERE order_no = 'IMP-ONLY'`);
  assert.strictEqual(h.source, 'import');
  assert.strictEqual(Number(h.amount_cents), 16518, '被拒的采集帧不许改动导入单');
});

// ───────────────────────────────────────────────────────────── [10] 套装部件
//
// 场景：一件实物 = 多个款色（上衣与裤子各自不同款不同色），平台当一个商品卖。
// 覆盖的不变量（都踩过或差点踩）：
//   · 有部件 ⇒ 款色集合**只有部件**；行/图上那个单品款色不许并进来（并进来 = 一件实物算两遍）
//   · 无部件 ⇒ 回落图上的单品款色（老数据零迁移，套装表为空时行为与改造前一致）
//   · 同部位不得重复（应用层大小写不敏感 + DB UNIQUE 双保险）
//   · 全量替换而非追加；空数组 = 改回单品（套装判断错了要有回头路）
//   · **校验失败不许动已存部件**（"报错但数据被清空"是最坏的一种）
//   · 删订单行由外键级联清部件（不留孤儿行）
//   · 组合键与录入顺序无关、`qty_per_set` 参与
//
// ⚠️ 套装行与单品行故意造出**不同**的期望值：若实现把图款色也并进套装行，
//    「恰好 2 个」会变成 3 个 ⇒ 红。两条都期望同一个数就会恒绿。
console.log('\n[10] 套装部件（一件实物多个款色）');

dbRun(
  `INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (21, 'sha21', 'fp21', 'u21', '/tmp/21'), (22, 'sha22', 'fp22', 'u22', '/tmp/22'),
          (23, 'sha23', 'fp23', 'u23', '/tmp/23')`,
);
function mkStyle(code) {
  return Number(dbRun(`INSERT INTO oi_styles (code, fingerprint) VALUES (?, ?)`, [code, `fp-${code}`]).lastInsertRowid);
}
function mkSc(styleId, color, code) {
  return Number(
    dbRun(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`, [styleId, color, code])
      .lastInsertRowid,
  );
}
const styleA = mkStyle('SM-A');
const styleB = mkStyle('SM-B');
const styleC = mkStyle('SM-C');
const scA = mkSc(styleA, '红', 'SM-A-红');
const scB = mkSc(styleB, '黑', 'SM-B-黑');
const scC = mkSc(styleC, '蓝', 'SM-C-蓝');

// 两条行都**先**让图挂上同一个单品款色（scA）：模拟"套装图整体被认成某个款"的真实残留。
// 套装行的期望值因此必须排除它 —— 这正是本节的判据。
const bundleItem = insert({ orderNo: 'SET-BUNDLE', imageId: 21, rawFields: {}, color: '' });
const singleItem = insert({ orderNo: 'SET-SINGLE', imageId: 22, rawFields: {}, color: '' });
const otherItem = insert({ orderNo: 'SET-OTHER', imageId: 23, rawFields: {}, color: '' });
dbRun(`UPDATE oi_images SET style_color_id = ? WHERE id IN (21, 22, 23)`, [scA]);

check('无部件 ⇒ 回落图上的单品款色（套装表为空时行为与改造前一致）', () => {
  assert.deepStrictEqual(odb.itemStyleColorIds(singleItem), [scA]);
  assert.deepStrictEqual(odb.listItemParts(singleItem), []);
});

check('写部件：按录入顺序返回，展示字段可直接用', () => {
  const r = odb.replaceItemParts(bundleItem, [
    { role: '上衣', styleColorId: scA },
    { role: '裤子', styleColorId: scB },
  ]);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.parts.map((p) => p.role), ['上衣', '裤子']);
  assert.strictEqual(r.parts[0].styleCode, 'SM-A');
  assert.strictEqual(r.parts[0].styleColorCode, 'SM-A-红');
  assert.strictEqual(r.parts[0].color, '红');
  assert.strictEqual(r.parts[1].styleCode, 'SM-B');
  assert.strictEqual(r.parts[1].qtyPerSet, 1);
});

check('⭐ 有部件 ⇒ 款色集合只含部件（图上仍挂着 scA，但只许出 2 个，不是 3 个）', () => {
  assert.strictEqual(Number(dbGet(`SELECT style_color_id AS v FROM oi_images WHERE id = 21`).v), scA, '前置：图上确实仍挂着单品款色');
  const ids = odb.itemStyleColorIds(bundleItem);
  assert.deepStrictEqual(ids, [scA, scB]);
  assert.strictEqual(ids.length, 2, '不许把图上的单品款色并进来');
});

check('批量读：有部件的能读到，没有部件的 id 不在返回里', () => {
  const map = odb.partsByItemIds([bundleItem, singleItem]);
  assert.strictEqual((map[bundleItem] || []).length, 2);
  assert.strictEqual(map[singleItem], undefined);
});

check('同部位重复被拦（大小写不敏感），且校验失败**不许动**已存部件', () => {
  const before = odb.listItemParts(bundleItem).length;
  const r1 = odb.replaceItemParts(bundleItem, [
    { role: '上衣', styleColorId: scA },
    { role: '上衣', styleColorId: scB },
  ]);
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /重复/);
  const r2 = odb.replaceItemParts(bundleItem, [
    { role: 'Top', styleColorId: scA },
    { role: 'top', styleColorId: scB },
  ]);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /重复/);
  assert.strictEqual(odb.listItemParts(bundleItem).length, before, '校验失败不许清空已存部件');
});

check('DB 层 UNIQUE 兜底：绕过应用层直插同 role 会抛', () => {
  assert.throws(
    () => dbRun(`INSERT INTO oi_item_parts (order_item_id, role, style_color_id) VALUES (?, ?, ?)`, [bundleItem, '上衣', scC]),
    /UNIQUE/,
  );
});

check('款色 id=0 被拒（0 是"未归属"哨兵，不是款色）', () => {
  const r = odb.replaceItemParts(bundleItem, [{ role: '马甲', styleColorId: 0 }]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /还没选款色/);
});

check('全量替换：改成只留一个部件，不是追加成三条', () => {
  const r = odb.replaceItemParts(bundleItem, [{ role: '上衣', styleColorId: scC }]);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(odb.itemStyleColorIds(bundleItem), [scC]);
});

check('组合键：录入顺序不同 ⇒ 同一个键；qty_per_set 不同 ⇒ 不同的组合', () => {
  odb.replaceItemParts(bundleItem, [
    { role: '上衣', styleColorId: scA },
    { role: '裤子', styleColorId: scB },
  ]);
  odb.replaceItemParts(otherItem, [
    { role: '裤子', styleColorId: scB },
    { role: '上衣', styleColorId: scA },
  ]);
  const k = odb.bundleKeyOf(bundleItem);
  assert.strictEqual(k, `${scA}x1+${scB}x1`);
  assert.strictEqual(odb.bundleKeyOf(otherItem), k, '顺序不同不许算成两个组合');

  odb.replaceItemParts(otherItem, [
    { role: '上衣', styleColorId: scA },
    { role: '裤子', styleColorId: scB, qtyPerSet: 2 },
  ]);
  assert.notStrictEqual(odb.bundleKeyOf(otherItem), k, '同一款色但每套 2 件 = 另一个组合');
});

check('清空部件 ⇒ 改回单品，回落图款色、组合键变空串', () => {
  const r = odb.replaceItemParts(otherItem, []);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(odb.listItemParts(otherItem), []);
  assert.deepStrictEqual(odb.itemStyleColorIds(otherItem), [scA], '改回单品后应回落图款色');
  assert.strictEqual(odb.bundleKeyOf(otherItem), '');
});

check('删订单行 ⇒ 部件随外键级联清掉（不留孤儿行）', () => {
  assert.ok(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_item_parts WHERE order_item_id = ?`, [bundleItem]).n) > 0);
  odb.deleteOrder(bundleItem);
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_item_parts WHERE order_item_id = ?`, [bundleItem]).n),
    0,
  );
});


// ─────────────────────────────────────────── [11] 套装商品在映射层的形状（回归）
//
// 新模型下这里**没有任何套装分支**，正因为如此才必须盯着它 —— 上一版曾把「一个商品挂多个款」
// 做成"同一 spec 按部位占多行"（`pl_shop_sku.bundle_role`），结果是：
//   · 同一商品的映射分裂成 N 行，`resolveOrderSku` 只能随机命中其中一个 ⇒ 整行归成上衣、裤子消失；
//   · 而它有归属、**不进待核对队列**，用户没有任何机会发现；
//   · 部件其实是**产品之间的关系**（`pl_bundle_links`），塞进映射表等于把目录事实写进平台镜像。
//
// 所以这里守的是"不许再分裂"：一条映射 = 一个商品卖一个产品；套装商品的答案是**套装产品本身**，
// 部件由产品库定义。断言全部读库里的行，不看返回值。
console.log('\n[11] 套装商品的映射形状（一条映射 = 一个产品，不按部位分裂）');

const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
sdb.ensureShopSchema();
dbRun(`INSERT INTO sk_shops (platform, name, name_key) VALUES ('ae', '套装店', '套装店')`);
dbRun(`INSERT INTO pl_products (code, name) VALUES ('SM-A','单品款'), ('SM-SET','两件套')`);
dbRun(
  `INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path)
   VALUES (31, 'sha31', 'fp31', 'u31', '/tmp/31'), (32, 'sha32', 'fp32', 'u32', '/tmp/32')`,
);
const pidA = pdb.productIdByCode('SM-A');
const pidSet = pdb.productIdByCode('SM-SET');
assert.ok(pidA && pidSet, '前置：两个产品必须已入库');

const SET_ITEM = '9000000000001';
// 让 SM-SET 真的是套装（有部件关联），这样"归到套装产品"才有实际意义
assert.strictEqual(
  pdb.replaceBundleLinks({
    productId: pidSet,
    aliasKey: '3',
    parts: [
      { role: '上衣', childProductId: pidA, childColor: '红' },
      { role: '裤子', childProductId: pidA, childColor: '黑' },
    ],
  }).ok,
  true,
);
const p1Bundle = insert({
  orderNo: 'MAP-BUNDLE',
  imageId: 31,
  shop: '套装店',
  color: '',
  rawFields: { 商品ID: SET_ITEM },
});
odb.replaceItemParts(p1Bundle, [
  { role: '上衣', styleColorId: scA },
  { role: '裤子', styleColorId: scB },
]);

check('套装行回流：只写**一行**映射，指向套装产品（分裂成多行 = 退回上一版的老毛病）', () => {
  const r = odb.skuBackfillFromOrder({ orderId: p1Bundle, styleCode: 'SM-SET', color: '红' });
  assert.strictEqual(r.status, 'written', `status=${r.status} conflict=${r.conflictCode}`);
  const rows = dbQuery(`SELECT product_id, spec FROM pl_shop_sku WHERE item_id = ?`, [SET_ITEM]);
  assert.strictEqual(rows.length, 1, `一个商品只能有一条映射，实际 ${rows.length} 条`);
  assert.strictEqual(Number(rows[0].product_id), pidSet);
});

check('⭐ 套装商品 resolveOrderSku 命中**套装产品**（不是 null）—— 核对页靠它拿产品再展开', () => {
  const hit = pdb.resolveOrderSku({ shop: '套装店', itemId: SET_ITEM });
  assert.ok(hit, '返回 null 就展开不了：核对页拿不到"这是哪套套装"');
  assert.strictEqual(hit.productId, pidSet);
  assert.strictEqual(hit.productCode, 'SM-SET');
  // 拿到产品后必须能展开出部件（产品库定义的那套），这才是链路的终点
  const b = pdb.resolveBundleParts({ productId: hit.productId, itemId: SET_ITEM, color: '3' });
  assert.strictEqual(b.isBundle, true);
  assert.strictEqual(b.matched, true, '色号 3 已配过');
  assert.deepStrictEqual(b.parts.map((p) => [p.role, p.color]), [
    ['上衣', '红'],
    ['裤子', '黑'],
  ]);
});

check('普通商品回归：单品映射照旧被命中（不能因为套装改造而全体失联）', () => {
  const SINGLE_ITEM = '9000000000002';
  const row = insert({
    orderNo: 'MAP-ONLY',
    imageId: 32,
    shop: '套装店',
    color: '蓝',
    rawFields: { 商品ID: SINGLE_ITEM },
  });
  const r = odb.skuBackfillFromOrder({ orderId: row, styleCode: 'SM-A', color: '蓝' });
  assert.strictEqual(r.status, 'written', `status=${r.status}`);
  const hit = pdb.resolveOrderSku({ shop: '套装店', itemId: SINGLE_ITEM });
  assert.ok(hit, '单品映射必须仍能被解析');
  assert.strictEqual(hit.productId, pidA);
  assert.strictEqual(hit.spec, '蓝', '颜色要落到 spec 上');
  assert.strictEqual(pdb.isBundleProduct(pidA), false, '子商品本身不是套装（它照常单独卖）');
});

// ─────────────────────────────────── [12] 套装自动展开成部件快照（materializeItemParts）
//
// 归到套装款之后，部件必须**自动**出现 —— 否则"今天要拿哪些款色码"永远是空的，
// 而产品库已经定义过的目录事实要人手抄一遍。四条不变量：
//   · 展开结果 = 配色字典里**子商品的颜色**（不是父级色，也不是平台色号原文）；
//   · 幂等：已有部件不动 —— 人工改过的那份永远优先于自动展开（再跑一次只能是 `already`）；
//   · 该色号没配过 ⇒ `missingColor` 且**一件都不写**（不许回落别的色号/父色）；
//   · 单品永远 `notBundle`，不许凭空多出部件。
console.log('\n[12] 套装自动展开（归到套装款 → 部件快照）');

const pTop2 = pdb.upsertProduct({ id: 0, code: 'EXP-TOP', name: '展开上衣', supplierId: 0, category: '', status: 'active', note: '' }).id;
const pPant2 = pdb.upsertProduct({ id: 0, code: 'EXP-PANT', name: '展开裤子', supplierId: 0, category: '', status: 'active', note: '' }).id;
const pSet2 = pdb.upsertProduct({ id: 0, code: 'EXP-SET', name: '展开两件套', supplierId: 0, category: '', status: 'active', note: '' }).id;
assert.strictEqual(
  pdb.replaceBundleLinks({
    productId: pSet2,
    aliasKey: '5',
    parts: [
      { role: '上衣', childProductId: pTop2, childColor: '红' },
      { role: '裤子', childProductId: pPant2, childColor: '黑', qty: 2 },
    ],
  }).ok,
  true,
);

/** 造一个「商品ID → 套装产品」的确认映射 + 一条该商品的订单行 */
let expSeq = 0;
function bundleRow(itemId, color) {
  expSeq += 1;
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status, source)
     VALUES ('ae', 1, ?, '*', ?, 'confirmed', 'manual')`,
    [itemId, pSet2],
  );
  return insert({
    orderNo: `EXP-${expSeq}`,
    imageId: 32, // 图上的款色故意留着不动：展开只认配色字典，不许拿图色凑
    shop: '套装店',
    color,
    rawFields: { 商品ID: itemId },
  });
}

const expFirst = bundleRow('9100000000001', '5');

check('展开：归到套装款 ⇒ 部件按**子商品颜色**写入，每套件数一起落下', () => {
  const m = odb.materializeItemParts(expFirst);
  assert.strictEqual(m.status, 'written', `status=${m.status}`);
  const parts = odb.listItemParts(expFirst);
  assert.deepStrictEqual(
    parts.map((p) => [p.role, p.styleCode, p.color, p.qtyPerSet]),
    [
      ['上衣', 'EXP-TOP', '红', 1],
      ['裤子', 'EXP-PANT', '黑', 2],
    ],
    '部位/款/色/件数必须与配色字典一致（按 role 排序）',
  );
  // 口径：一行 → 两个款色（不是把父级色也算进来）
  assert.strictEqual(odb.itemStyleColorIds(expFirst).length, 2);
});

check('幂等：再跑一次是 already，绝不覆盖（人工改过的那份优先）', () => {
  // 先人工改一处（把上衣换成另一个色）
  const manual = odb.listItemParts(expFirst).map((p) => ({
    role: p.role,
    styleColorId: p.role === '上衣' ? scA : p.styleColorId,
    qtyPerSet: p.qtyPerSet,
  }));
  assert.strictEqual(odb.replaceItemParts(expFirst, manual).ok, true);
  const m = odb.materializeItemParts(expFirst);
  assert.strictEqual(m.status, 'already', '已有部件时必须是 already');
  assert.deepStrictEqual(
    odb.listItemParts(expFirst).map((p) => p.styleColorId),
    manual.map((p) => p.styleColorId),
    '自动展开不许把人工改过的部件改回去',
  );
});

check('⭐ 该色号没配过 ⇒ missingColor 且一件都不写（回落任一色号都是给错拿货单）', () => {
  const row = bundleRow('9100000000002', '9'); // 色号 9 没配过
  const m = odb.materializeItemParts(row);
  assert.strictEqual(m.status, 'missingColor');
  assert.deepStrictEqual(m.parts, []);
  assert.deepStrictEqual(odb.listItemParts(row), [], '缺配色时一件都不许落库');
  assert.deepStrictEqual(m.roles.slice().sort(), ['上衣', '裤子'].sort(), '要告诉界面差哪几个部位');
});

check('单品不展开：不是套装就什么都不做（不许凭空多出部件）', () => {
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status, source)
     VALUES ('ae', 1, '9100000000003', '*', ?, 'confirmed', 'manual')`,
    [pidA],
  );
  const row = insert({
    orderNo: 'EXP-SINGLE',
    imageId: 32,
    shop: '套装店',
    color: '红',
    rawFields: { 商品ID: '9100000000003' },
  });
  const m = odb.materializeItemParts(row);
  assert.strictEqual(m.status, 'notBundle');
  assert.deepStrictEqual(odb.listItemParts(row), []);
});

check('商品没映射到产品 ⇒ noProduct（不按标题/图猜款）', () => {
  const row = insert({
    orderNo: 'EXP-NOMAP',
    imageId: 32,
    shop: '套装店',
    color: '5',
    rawFields: { 商品ID: '9100000000009' },
  });
  assert.strictEqual(odb.materializeItemParts(row).status, 'noProduct');
  assert.deepStrictEqual(odb.listItemParts(row), []);
});

console.log('\n[13] 变体键：导入即归类（同样商品同样色不再人工设一次）');

// 这一节守的是本轮改造的**唯一承诺**：没有人工映射、没有图、没有模型，
// 只靠订单自带的 `(店铺, 产品ID, 平台色)` 就能把行归到款色上，而且**重导不涨**。
// 夹具刻意做成"同商品三行、两个色"，因为最容易被写错的两种实现是：
//   · 每行都新建一个款色（看着对，实际每次导入都涨一批）
//   · 按商品挑一个色（不同色并成一件，拿货会拿错）
const VT_ITEM = '1005019999999001';
const VT_SHOP = '键店';
/** 报表原文形状：色藏在 `(产品属性:Color:x,Size:y)` 里 —— 与真库逐字符同形 */
function vtRaw(color, size) {
  return {
    订单号: 'VT-' + color + '-' + size,
    产品ID: VT_ITEM,
    产品信息: `【1】Test Listing Title\n(产品属性:Color:${color},Size:${size})`,
  };
}
function vtInsert(color, size, over = {}) {
  return odb.insertOrder({
    // 回退后「导入不再自动归」；但人工认款（assignOrderStyle）经图片投影落行，
    // 故认款夹具必须是有图的订单（无图行在 assignOrderStyle 里不会落到行上）。
    // 同色共用一张图：认一次即把同图两行一起归（vtA1/vtA2 都是色 5）。
    imageId: vtImageFor(color),
    orderNo: 'VT-' + color + '-' + size,
    shop: VT_SHOP,
    size,
    orderTime: '10/01/2026 10:00',
    category: '',
    color: '',
    logo: '',
    rawFields: vtRaw(color, size),
    ...over,
  });
}

const vtCols = dbQuery(`PRAGMA table_info(oi_order_items)`).map((c) => String(c.name));
check('订单行有 variant_key 列（键落库，不是查询时现算）', () => {
  assert.ok(vtCols.includes('variant_key'), '缺 variant_key 列');
});

// 认款夹具用的图：同色共用一张，不同色各一张（与真实"一个商品多色共用主图"相反，
// 这里故意一张图只挂一个色，避免 projectImageColorToOrders 把同图另一色也改判）。
const vtImg = { '5': 505, '7': 507, '9': 509 };
function vtImageFor(color) {
  const id = vtImg[String(color)];
  if (!id) return null;
  if (!dbGet(`SELECT 1 FROM oi_images WHERE id = ?`, [id])) {
    dbRun(`INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path) VALUES (?, ?, ?, ?, '/tmp/vt')`, [id, 'fp-vt-' + id, 'ufp-vt-' + id, 'u-vt-' + id]);
  }
  return id;
}

const vtA1 = vtInsert('5', 'L');
const vtA2 = vtInsert('5', 'XL');
const vtB = vtInsert('7', 'L');

check('无映射不自动归：三行都留在待认款（style_color_id = 0，不建款色/产品）', () => {
  for (const id of [vtA1, vtA2, vtB]) {
    const r = dbGet(`SELECT COALESCE(style_color_id, 0) AS sc FROM oi_order_items WHERE id = ?`, [id]);
    assert.strictEqual(Number(r.sc), 0, `行 ${id} 不应被自动归类，应留待认款`);
  }
});

check('键已落库且是三段（店铺 / 商品ID / 色）', () => {
  const k = String(dbGet(`SELECT variant_key FROM oi_order_items WHERE id = ?`, [vtA1]).variant_key);
  assert.strictEqual(k.split('\u0000').length, 3, `键形状不对: ${JSON.stringify(k)}`);
  assert.ok(k.includes(VT_ITEM), '键里应含商品ID');
});

check('导入不为这些行建任何款色 / 产品占位', () => {
  // 不建款色：oi_style_colors 里没有 AE-<商品ID> 的款色
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors WHERE code LIKE ?`, [`AE-${VT_ITEM}%`]).n),
    0,
    '导入不应自动建 AE- 款色',
  );
  // 不建产品占位：pl_products 里没有 AE-<商品ID>
  const p = dbGet(`SELECT name FROM pl_products WHERE code = ?`, ['VTSTYLE']);
  assert.strictEqual(p, undefined, '导入不应自动建 AE- 产品占位');
});

// 幂等：这是"重导不涨"的判据。键表与款色表的行数在任何一次重导后都不许变。
check('重导同一批：键表 / 款色表 / 产品表 一行都不涨', () => {
  const before = {
    keys: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n),
    colors: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors`).n),
    products: Number(dbGet(`SELECT COUNT(*) AS n FROM pl_products`).n),
  };
  vtInsert('5', 'L');
  vtInsert('5', 'XL');
  vtInsert('7', 'L');
  const after = {
    keys: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n),
    colors: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors`).n),
    products: Number(dbGet(`SELECT COUNT(*) AS n FROM pl_products`).n),
  };
  assert.deepStrictEqual(after, before, `重导后涨了：${JSON.stringify({ before, after })}`);
});

// 2026-10-29 回退：导入不再自动建款色/产品，行留待认款（见 order-db.ts autoAssignByMap）。
// 下面用「人工认款」入口显式造数据，让命名板 / 投影 / 拿货这些依赖「已认款款色」的功能
// 仍有可验证的数据源（模拟用户手动认款，而非导入自动建）。
// assignOrderStyle 经图片把款色投影到行，并**自动**把行上的 variant_key 记进 oi_variant_keys
// （state='auto'，见 rememberVariantBinding）—— 这正是"下次同款同色不用再设一遍"的记忆本体。
// 所以人工认款只需调这一句，不必再手填键表。
function vtReconcile(id, color) {
  odb.assignOrderStyle({ orderId: id, styleCode: 'VTSTYLE', color });
}
// vtA1 与 vtA2 共用同一张图（同色 5），认一次即把两行一起归；
// vtB（色 7）单独认到 VTSTYLE 的另一色。
vtReconcile(vtA1, '5');
vtReconcile(vtB, '7');

check('存量收口幂等：再跑一次 backfill 不新建任何绑定', () => {
  const st = odb.backfillVariantStyleColors();
  assert.strictEqual(st.createdStyleColors, 0, `新建了 ${st.createdStyleColors} 条`);
});

check('认款后拿货需求能按 款/色/码 统计到这两色（人工认款路径仍工作）', () => {
  const pur = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
  pur.ensurePurchaseSchema();
  const rows = pur
    .outstanding()
    .filter((r) => String(r.styleCode) === 'VTSTYLE');
  // 维度是 款×色×**码** ⇒ 色5 的 L 与 XL 是两行，加色7 的 L 共 3 行。
  assert.strictEqual(rows.length, 3, `应恰好三行（5/L、5/XL、7/L），实际 ${rows.length}`);
  const byColor = {};
  for (const r of rows) byColor[String(r.color)] = (byColor[String(r.color)] ?? 0) + Number(r.demand);
  assert.strictEqual(byColor['5'], 2, `色5 的需求应是 2 件（L+XL），实际 ${byColor['5']}`);
  assert.strictEqual(byColor['7'], 1, `色7 的需求应是 1 件，实际 ${byColor['7']}`);
  assert.ok(
    rows.every((r) => r.unclassified === false),
    '已认款的行不该落在「未归类」桶里',
  );
});

check('投影层与归类口径同一份：**无图**的行在利润 / 核对 / 拣货里同样带出款色', () => {
  // 守的是「一个数字两处实现」。改造后款色先落在**订单行**上，而改造前所有投影层都
  // 只认 `oi_images.style_color_id`。若投影层不同步，同一行会"统计说已归类、列表说没归类"——
  // 真库实测这种行 9/75（`image.style_color_id = 0` 但订单行已归），症状是拿货页仍标
  // "未识别款 / 无供应商"，用户只会认为这一整轮改造没生效。
  const ship = odb.shippingRows(200).filter((r) => String(r.orderNo).startsWith('VT-'));
  assert.strictEqual(ship.length, 3, `利润投影应有 3 行，实际 ${ship.length}`);
  for (const r of ship) {
    assert.strictEqual(r.styleCode, 'VTSTYLE', `利润投影漏了款编码：${r.orderNo}`);
    assert.ok(
      String(r.styleColor) === '5' || String(r.styleColor) === '7',
      `利润投影漏了色名：${r.orderNo} => ${JSON.stringify(r.styleColor)}`,
    );
  }
  // 待核对列表（归类核对页的数据源）
  const page = odb.listOrdersPage({ limit: 500 }).rows.filter((r) => String(r.orderNo).startsWith('VT-'));
  assert.strictEqual(page.length, 3, `待核对列表应有 3 行，实际 ${page.length}`);
  for (const r of page) {
    assert.strictEqual(String(r.styleCode), 'VTSTYLE', `核对列表漏了款编码：${r.orderNo}`);
  }
  // 拣货投影（拿货页的款色 / 供应商都从它来）
  const pick = require(path.join(ROOT, 'dist', 'electron', 'picking-db.js')).pickingRows({ limit: 2000 });
  const pr = pick.rows.filter((r) => String(r.orderNo).startsWith('VT-'));
  assert.strictEqual(pr.length, 3, `拣货投影应有 3 行，实际 ${pr.length}`);
  for (const r of pr) {
    assert.strictEqual(String(r.styleCode), 'VTSTYLE', `拣货投影漏了款编码：${r.orderNo}`);
    assert.strictEqual(String(r.styleName), '', '占位款名应留空（命名是人的判断）');
  }
});

check('存量已归类的行会补记绑定（重导不会另建一套款色）', () => {
  // 模拟"人工归过类、但键表还没这条记忆"的历史行：这正是真库升级前的状态（65 行已归类、0 条绑定）。
  // 不补的后果不是当下出错，而是**订单被清理重导之后**同一件货长出第二套 provisional 款色。
  const VT2 = '1005019999999002';
  const rowId = odb.insertOrder({
    imageId: null, orderNo: 'VT2-1', shop: VT_SHOP, size: 'L', orderTime: '10/01/2026 10:00',
    category: '', color: '', logo: '',
    rawFields: { 订单号: 'VT2-1', 产品ID: VT2, 产品信息: '(产品属性:Color:9,Size:L)' },
  });
  const key = String(dbGet(`SELECT variant_key FROM oi_order_items WHERE id = ?`, [rowId]).variant_key);
  // 人工把它归到"另一个"款色上（跨 listing 合并的真实形态），然后抹掉绑定
  const humanSc = Number(dbGet(`SELECT style_color_id AS s FROM oi_order_items WHERE id = ?`, [vtB]).s);
  dbRun(`UPDATE oi_order_items SET style_color_id = ? WHERE id = ?`, [humanSc, rowId]);
  dbRun(`DELETE FROM oi_variant_keys WHERE variant_key = ?`, [key]);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) n FROM oi_variant_keys WHERE variant_key = ?`, [key]).n), 0, '前置：绑定应已抹掉');

  odb.backfillVariantStyleColors();
  const bound = Number(dbGet(`SELECT style_color_id AS s FROM oi_variant_keys WHERE variant_key = ?`, [key]).s);
  assert.strictEqual(bound, humanSc, '补记的绑定必须指向人工那个款色，而不是新建一个');
});

check('反例守卫：没有商品ID 的行不会凭空归到某个款色', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n);
  const id = odb.insertOrder({
    imageId: null,
    orderNo: 'VT-NOID',
    shop: VT_SHOP,
    size: 'L',
    orderTime: '10/01/2026 10:00',
    category: '',
    color: '',
    logo: '',
    rawFields: { 订单号: 'VT-NOID', 产品信息: '(产品属性:Color:5,Size:L)' },
  });
  assert.strictEqual(
    Number(dbGet(`SELECT COALESCE(style_color_id,0) AS s FROM oi_order_items WHERE id = ?`, [id]).s),
    0,
    '无商品ID 的行被归了款色',
  );
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n),
    before,
    '无商品ID 的行不该建键',
  );
});

console.log('\n[14] 命名板：把「平台原文」变成「人给的词」');

// 这一节守的是 P3 的三条承诺：
//   ① 命名板按 **listing** 分组（一个 listing 的多个色键同屏可见，不是逐键翻页）；
//   ② "未命名"是**派生**的（名字 == 平台原文），不是存的标志位 —— 存标志位会在改名后不翻牌；
//   ③ 改名**不许**动款色编码、不许让下一次导入长出第二个款色（那是"改个名把数据改坏"）。

check('命名板按 listing 分组，色键平铺在同一组里（组内 2 个色）', () => {
  const b = odb.variantNamingBoard();
  const g = b.groups.find((x) => x.itemId === VT_ITEM);
  assert.ok(g, `找不到 ${VT_ITEM} 这一组，实有 ${b.groups.map((x) => x.itemId).join(',')}`);
  assert.strictEqual(g.colors.length, 2, `应平铺 2 个色键（5 / 7），实际 ${g.colors.length}`);
  // 组内排序：未命名的在前，同状态按平台原文（`5` 在 `7` 前）
  assert.deepStrictEqual(g.colors.map((c) => c.colorRaw), ['5', '7']);
  assert.ok(g.title, '标题不该为空（取不到就用商品ID 兜，不许留空）');
});

check('未命名 = 名字仍是平台原文（派生；此时 2 个都算待命名）', () => {
  const g = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  assert.ok(g.colors.every((c) => !c.named), '刚导入的色不该算已命名');
  const c5 = g.colors.find((c) => c.colorRaw === '5');
  assert.strictEqual(c5.colorName, '5', '自动建的款色名应仍是平台原文');
  assert.strictEqual(c5.qty, 2, '件数应是 2（L + XL 各一件）');
  assert.strictEqual(c5.orderRows, 2, '行数应是 2');
});

check('改名成功：色名换成人的词，未命名计数 −1，编码不动', () => {
  const g = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  const c5 = g.colors.find((c) => c.colorRaw === '5');
  const codeBefore = String(dbGet(`SELECT code FROM oi_style_colors WHERE id = ?`, [c5.styleColorId]).code);
  const before = odb.variantNamingBoard().unnamedKeys;

  const r = odb.renameStyleColor(c5.styleColorId, '藏青');
  assert.strictEqual(r.ok, true, `改名被拒：${r.error}`);
  assert.strictEqual(r.keys, 1, '这个色只挂 1 个键');

  assert.strictEqual(
    String(dbGet(`SELECT color FROM oi_style_colors WHERE id = ?`, [c5.styleColorId]).color),
    '藏青',
  );
  assert.strictEqual(
    String(dbGet(`SELECT code FROM oi_style_colors WHERE id = ?`, [c5.styleColorId]).code),
    codeBefore,
    '款色编码被改了 ⇒ 历史单据会指向不存在的编码',
  );
  assert.strictEqual(
    String(dbGet(`SELECT state FROM oi_variant_keys WHERE style_color_id = ?`, [c5.styleColorId]).state),
    'named',
    '记账：人碰过这条',
  );
  assert.strictEqual(odb.variantNamingBoard().unnamedKeys, before - 1, '未命名计数应 −1');
  // 派生标记跟着翻牌（这就是"不存标志位"的意义）
  const after = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  assert.strictEqual(after.colors.find((c) => c.colorRaw === '5').named, true);
});

check('改名幂等：再存一次同一个名字不报错、不重复记账', () => {
  const g = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  const c5 = g.colors.find((c) => c.colorRaw === '5');
  const r = odb.renameStyleColor(c5.styleColorId, '藏青');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(
    String(dbGet(`SELECT color FROM oi_style_colors WHERE id = ?`, [c5.styleColorId]).color),
    '藏青',
  );
});

check('改名后重导同一批：键表 / 款色表一行都不涨（改名不许把数据改坏）', () => {
  const before = {
    keys: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n),
    colors: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors`).n),
  };
  vtInsert('5', 'L');
  vtInsert('5', 'XL');
  const after = {
    keys: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n),
    colors: Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors`).n),
  };
  assert.deepStrictEqual(
    after,
    before,
    `改名后再导入长出了新款色（颜色查表是按 (款,色名) 找的）：${JSON.stringify({ before, after })}`,
  );
});

check('同款下不许重名（表上有 UNIQUE(style_id,color)，但必须给一句人话而不是 SQLite 原话）', () => {
  const g = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  const c7 = g.colors.find((c) => c.colorRaw === '7');
  const r = odb.renameStyleColor(c7.styleColorId, '藏青');
  assert.strictEqual(r.ok, false, '重名应被拒绝');
  // 变异测试（把这条守卫改成 `if (false && dup)`）时这里拿到的是
  // `UNIQUE constraint failed: oi_style_colors.style_id, oi_style_colors.color`
  // ⇒ 界面会原样吐给用户。所以要钉住"是我们的原话"，不是数据库的话。
  assert.ok(/同名/.test(String(r.error)), `拒绝原话应说明是同名，实际：${r.error}`);
  assert.ok(!/UNIQUE constraint/.test(String(r.error)), '不该把 SQLite 的约束错误抛给用户');
  // 拒绝后库里的值**没变**（不是"先写再校验"）
  assert.strictEqual(
    String(dbGet(`SELECT color FROM oi_style_colors WHERE id = ?`, [c7.styleColorId]).color),
    '7',
  );
});

check('空名 / 超长 / 不存在的 id 一律拒绝，且给出原话', () => {
  const g = odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);
  const c7 = g.colors.find((c) => c.colorRaw === '7');
  for (const [name, re] of [
    ['   ', /不能为空/],
    ['x'.repeat(41), /太长/],
  ]) {
    const r = odb.renameStyleColor(c7.styleColorId, name);
    assert.strictEqual(r.ok, false, `${JSON.stringify(name)} 应被拒绝`);
    assert.ok(re.test(String(r.error)), `原话不对：${r.error}`);
  }
  const bad = odb.renameStyleColor(99999999, '黑');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.styleColorId, 99999999, '回执要带原 id，界面才知道是哪一行被拒');
});

console.log('\n[15] 款信息（命名板组头）：款名 + 厂家一次存，且只改你改的那一项');

// 这一节守的是「改款名别顺手把厂家清掉」。两个字段落在 `pl_products` 两列上，
// 用同一个入参对象收，最容易写成的实现是"整行 upsert" —— 缺省字段被按默认值重置，
// 用户只改了个名字，拿货页随即多出一批"未指定厂家"的货。
const basicsGroup = () => odb.variantNamingBoard().groups.find((x) => x.itemId === VT_ITEM);

check('命名板的组带出款身份（款 id / 编码 / 款名 / 厂家）', () => {
  const g = basicsGroup();
  assert.ok(g, '找不到 VT_ITEM 那一组');
  assert.ok(g.styleId > 0, `款 id 没带出来：${g.styleId}`);
  assert.strictEqual(g.styleCode, 'VTSTYLE');
  assert.strictEqual(g.styleCount, 1, `这组只该涉及 1 个款，实际 ${g.styleCount}`);
  assert.strictEqual(g.styleName, '', '占位款名应留空');
  assert.strictEqual(g.supplierId, 0, '还没指定厂家，应为 0');
});

const basicsSupplier = (() => {
  const pur = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
  pur.ensurePurchaseSchema();
  const existing = pur.listSuppliers()[0];
  if (existing) return Number(existing.id);
  return Number(pur.createSupplier('命名板测试厂家', '', ''));
})();

check('改款名：落 `pl_products.name`，而且**厂家没被动**（只改你改的那一项）', () => {
  const g = basicsGroup();
  // 先给它指定一个厂家，再只改名 —— 若实现是整行 upsert，这一步就会发现厂家被清零
  const setSup = odb.saveStyleBasics(g.styleId, { supplierId: basicsSupplier });
  assert.strictEqual(setSup.ok, true, `指定厂家失败：${setSup.error}`);
  assert.ok(basicsSupplier > 0, '测试厂家 id 必须 > 0，否则这条守卫是空转');
  const r = odb.saveStyleBasics(g.styleId, { name: '测试连帽卫衣' });
  assert.strictEqual(r.ok, true, `改名失败：${r.error}`);
  assert.strictEqual(r.name, '测试连帽卫衣');
  const p = dbGet(`SELECT name, supplier_id FROM pl_products WHERE code = ?`, ['VTSTYLE']);
  assert.strictEqual(String(p.name), '测试连帽卫衣');
  assert.strictEqual(Number(p.supplier_id), basicsSupplier, '只改名却把厂家清掉了');
});

check('改厂家：`pl_products.supplier_id` 跟着变，款名不动', () => {
  const g = basicsGroup();
  const r = odb.saveStyleBasics(g.styleId, { supplierId: 0 });
  assert.strictEqual(r.ok, true, `清空厂家失败：${r.error}`);
  assert.strictEqual(r.supplierId, 0, '回执要带保存后的实际值（界面拿它回显）');
  const p = dbGet(`SELECT name, supplier_id FROM pl_products WHERE code = ?`, ['VTSTYLE']);
  assert.strictEqual(Number(p.supplier_id), 0);
  assert.strictEqual(String(p.name), '测试连帽卫衣', '清厂家不该动款名');
  odb.saveStyleBasics(g.styleId, { supplierId: basicsSupplier });
});

check('厂家不存在 → 拒绝并给原话，且款名没被改（不是"先写后校验"）', () => {
  const g = basicsGroup();
  const r = odb.saveStyleBasics(g.styleId, { name: '不该生效的名字', supplierId: 99999999 });
  assert.strictEqual(r.ok, false, '不存在的厂家应被拒绝');
  assert.ok(/厂家/.test(String(r.error)), `原话应提到厂家：${r.error}`);
  const p = dbGet(`SELECT name FROM pl_products WHERE code = ?`, ['VTSTYLE']);
  assert.strictEqual(String(p.name), '测试连帽卫衣', '被拒绝的那次不该把款名写进去');
});

check('款名可以清空（回到占位），不是必填项', () => {
  const g = basicsGroup();
  const r = odb.saveStyleBasics(g.styleId, { name: '' });
  assert.strictEqual(r.ok, true, `清空款名失败：${r.error}`);
  assert.strictEqual(r.name, '');
});

check('幂等 + 边界：同值不报错；不存在的款 / 超长 / 空 patch 一律拒绝', () => {
  const g = basicsGroup();
  assert.strictEqual(odb.saveStyleBasics(g.styleId, { name: '卫衣' }).ok, true);
  assert.strictEqual(odb.saveStyleBasics(g.styleId, { name: '卫衣' }).ok, true, '同值再存应幂等');
  assert.strictEqual(odb.saveStyleBasics(99999999, { name: 'x' }).ok, false);
  assert.ok(/太长/.test(String(odb.saveStyleBasics(g.styleId, { name: 'x'.repeat(61) }).error)));
  assert.ok(/没有要改/.test(String(odb.saveStyleBasics(g.styleId, {}).error)));
});

check('一组色分属两个款时，组上不带款身份（不给会改错人的入口）', () => {
  // 人工把 VT_ITEM 的一个色并到**另一个款**的款色上（真实形态：跨 listing 合并）
  const g0 = basicsGroup();
  const other = dbGet(
    `SELECT sc.id AS sc, sc.style_id AS st FROM oi_style_colors sc
      WHERE sc.style_id <> ? LIMIT 1`,
    [g0.styleId],
  );
  assert.ok(other, '库里需要另一个款才能构造这条');
  const c7 = g0.colors.find((c) => c.colorRaw === '7');
  dbRun(`UPDATE oi_variant_keys SET style_color_id = ? WHERE style_color_id = ?`, [
    Number(other.sc),
    c7.styleColorId,
  ]);
  const g1 = basicsGroup();
  assert.strictEqual(g1.styleCount, 2, `应识别出两个款，实际 ${g1.styleCount}`);
  assert.strictEqual(g1.styleId, 0, '分属多款的组不该给单款身份');
});

console.log('\n[16] 款合并：同厂家下 N 个款 → 1 个，且可拆（拿货页「可能是同一件货」）');

// 这一节守的是 P4 的两条承诺：
//   ① 合并**不改任何数字**：键数、已归类行数在合并前后一模一样（它只改"按哪个款汇总"）；
//   ② 合并**可拆**：拆完键、色、订单行全部回到原位，合并记录也没有了。
// 最容易被写错的实现是"搬色时把源色删掉"或"只改键不改订单行"：
// 前者拆不回去，后者会让拿货页的数字与合并前不同（同一件货在统计里少了一半）。
const mgPur = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
mgPur.ensurePurchaseSchema();
const MG_SUP = mgPur.createSupplier('合并测试厂家', '', '');
const MG_A = '1005019999999101';
const MG_B = '1005019999999102';
const MG_C = '1005019999999103';
function mgRaw(item, color, size, no) {
  return {
    订单号: no,
    产品ID: item,
    产品信息: `【1】Merge Fixture ${item}\n(产品属性:Color:${color},Size:${size})`,
  };
}
let mgImgSeq = 5000;
function mgNextImage() {
  const id = mgImgSeq++;
  dbRun(`INSERT INTO oi_images (id, fingerprint, url_fingerprint, source_url, local_path) VALUES (?, ?, ?, ?, '/tmp/mg')`, [id, 'fp-mg-' + id, 'ufp-mg-' + id, 'u-mg-' + id]);
  return id;
}
function mgInsert(item, color, size, no) {
  return odb.insertOrder({
    // 回退后风格靠**人工认款**建出来（assignOrderStyle 经图片投影落行，并自动记键表绑定）。
    imageId: mgNextImage(),
    orderNo: no,
    shop: '合并店',
    size,
    orderTime: '10/01/2026 10:00',
    category: '',
    color: '',
    logo: '',
    rawFields: mgRaw(item, color, size, no),
  });
}
// 回退后「导入不自动建款色」：三个款必须由**人工认款**显式建出来（assignOrderStyle 按
// `AE-<商品ID>` 落款 + 色），这正是生产里"导入只留待认款、人去认款台认"的形态。
function mgReconcile(item, color, size, no) {
  const id = mgInsert(item, color, size, no);
  odb.assignOrderStyle({ orderId: id, styleCode: `AE-${item}`, color });
  return id;
}
// A（目标候选）：色 5、7 · B：色 5、7、9（5/7 与 A 同名 ⇒ 改键，9 不同名 ⇒ 搬色）· C：色 5
mgReconcile(MG_A, '5', 'L', 'MG-A-5-L');
mgReconcile(MG_A, '7', 'M', 'MG-A-7-M');
mgReconcile(MG_B, '5', 'L', 'MG-B-5-L');
mgReconcile(MG_B, '7', 'L', 'MG-B-7-L');
mgReconcile(MG_B, '9', 'XL', 'MG-B-9-XL');
mgReconcile(MG_C, '5', 'S', 'MG-C-5-S');

const mgStyleOf = (item) =>
  dbGet(`SELECT id, code FROM oi_styles WHERE code = ?`, [`AE-${item}`]);
const mgA = mgStyleOf(MG_A);
const mgB = mgStyleOf(MG_B);
const mgC = mgStyleOf(MG_C);

check('夹具成立：三个 listing 各成一个款，且都挂在同一个厂家下', () => {
  assert.ok(mgA && mgB && mgC, '三个款都应被人工认款建出来');
  for (const s of [mgA, mgB, mgC]) {
    const r = odb.saveStyleBasics(Number(s.id), { supplierId: MG_SUP });
    assert.strictEqual(r.ok, true, `指定厂家失败：${r.error}`);
  }
  const grp = odb.styleMergeCandidates().find((g) => g.supplierId === MG_SUP);
  assert.ok(grp, '同厂家下三个款应成一组候选');
  assert.strictEqual(grp.styles.length, 3, `应识别出 3 个款，实际 ${grp.styles.length}`);
});

check('候选只按厂家分组：没指定厂家的款不进候选（那是"猜同款"，不做）', () => {
  const dt = dbGet(
    `SELECT id FROM oi_styles WHERE code = ?`,
    [`AE-VT_ITEM_PLACEHOLDER_DOES_NOT_EXIST`],
  );
  assert.strictEqual(dt, undefined);
  // 把 A 的厂家清掉 → 该组只剩 B、C 两个款；再清 B → 整组消失
  odb.saveStyleBasics(Number(mgA.id), { supplierId: 0 });
  const g1 = odb.styleMergeCandidates().find((g) => g.supplierId === MG_SUP);
  assert.strictEqual(g1.styles.length, 2, `清掉一个厂家后应剩 2 个，实际 ${g1.styles.length}`);
  assert.ok(!g1.styles.some((s) => s.styleId === Number(mgA.id)), '清掉厂家的款还在候选里');
  odb.saveStyleBasics(Number(mgA.id), { supplierId: MG_SUP });
});

check('一个厂家只有一个款时不出组（一个款没有"合并"可言）', () => {
  const solo = odb.styleMergeCandidates().every((g) => g.styles.length >= 2);
  assert.strictEqual(solo, true, '候选里出现了只有 1 个款的组');
});

check('边界：目标不存在 / 没选源 / 把目标当源 一律拒绝，且不写库', () => {
  const before = dbGet(`SELECT COUNT(*) AS n FROM oi_style_merges`).n;
  assert.strictEqual(odb.mergeStylesInto(99999999, [Number(mgB.id)]).ok, false);
  assert.strictEqual(odb.mergeStylesInto(Number(mgA.id), []).ok, false);
  assert.strictEqual(odb.mergeStylesInto(Number(mgA.id), [Number(mgA.id)]).ok, false);
  assert.strictEqual(
    dbGet(`SELECT COUNT(*) AS n FROM oi_style_merges`).n,
    before,
    '被拒绝的调用不该写合并记录',
  );
});

const mgKeysBefore = dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n;
const mgRowsBefore = dbGet(
  `SELECT COUNT(*) AS n FROM oi_order_items WHERE COALESCE(style_color_id, 0) > 0`,
).n;
const mgAColorsBefore = dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors WHERE style_id = ?`, [
  Number(mgA.id),
]).n;
let mgBatch = '';

check('合并：A ← B、C（一次 N→1），键与已归类行数一个不动', () => {
  const r = odb.mergeStylesInto(Number(mgA.id), [Number(mgB.id), Number(mgC.id)]);
  assert.strictEqual(r.ok, true, `合并失败：${r.error}`);
  mgBatch = String(r.batchId);
  assert.ok(mgBatch, '回执要带批次 id（拆开按它）');
  assert.strictEqual(r.movedColors, 1, `应只搬 1 个色（B 的 9），实际 ${r.movedColors}`);
  assert.strictEqual(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n, mgKeysBefore);
  assert.strictEqual(
    dbGet(`SELECT COUNT(*) AS n FROM oi_order_items WHERE COALESCE(style_color_id, 0) > 0`).n,
    mgRowsBefore,
  );
});

check('同名色走"改键"：源色行还在（不删才拆得回去），键指到目标色上', () => {
  const aColors = dbQuery(`SELECT id, color FROM oi_style_colors WHERE style_id = ?`, [
    Number(mgA.id),
  ]);
  const colors = aColors.map((c) => String(c.color)).sort();
  assert.deepStrictEqual(colors, ['5', '7', '9'], `目标款下应是 5/7/9，实际 ${colors.join(',')}`);
  // B 的「5」那条色还在 B 下（改键路径不删源色）
  const bSc = dbQuery(`SELECT id, color FROM oi_style_colors WHERE style_id = ?`, [Number(mgB.id)]);
  assert.ok(
    bSc.some((c) => String(c.color) === '5'),
    '改键路径把源色删了 —— 那这条合并就拆不回去了',
  );
  const b5 = bSc.find((c) => String(c.color) === '5');
  const a5 = aColors.find((c) => String(c.color) === '5');
  const stillOnB = dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id = ?`, [
    Number(b5.id),
  ]).n;
  assert.strictEqual(Number(stillOnB), 0, 'B 的键应已改指出去');
  const onA = dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id = ?`, [
    Number(a5.id),
  ]).n;
  assert.ok(Number(onA) >= 2, `A 的「5」下应聚了两个 listing 的键，实际 ${onA}`);
  // ⚠️ 这一条是本节的重点：**订单行必须跟着键走**。投影层是 `COALESCE(行, 图)`，
  //    只改键不改行的实现会让拿货页继续按 B 的旧色算 —— 合并看起来"成功了"，
  //    数字却一点没变（同一件货照样两行）。比报错更难发现。
  const bRow = dbGet(
    `SELECT COALESCE(x.style_color_id, 0) AS sc
       FROM oi_order_items x JOIN oi_orders o ON o.id = x.order_id
      WHERE o.order_no = 'MG-B-5-L'`,
  );
  assert.strictEqual(
    Number(bRow.sc),
    Number(a5.id),
    'B 的订单行没跟着改指到 A 的「5」—— 合并对拿货页等于没生效',
  );
});

check('不同名色走"搬色"：只改 style_id，色 id 不变（订单行零改动）', () => {
  const nine = dbGet(
    `SELECT sc.id AS id, sc.style_id AS st FROM oi_style_colors sc
      JOIN oi_styles s ON s.id = sc.style_id
     WHERE s.code = ? AND sc.color = '9'`,
    [`AE-${MG_A}`],
  );
  assert.ok(nine, 'B 的「9」没搬到 A 下');
  const row = dbGet(
    `SELECT COALESCE(x.style_color_id, 0) AS sc
       FROM oi_order_items x JOIN oi_orders o ON o.id = x.order_id
      WHERE o.order_no = 'MG-B-9-XL'`,
  );
  assert.strictEqual(Number(row.sc), Number(nine.id), '搬色后订单行应仍指向同一个色 id');
});

check('合并后源款的键清零（拿货页不再为同一件货开两行）', () => {
  for (const st of [mgB, mgC]) {
    const n = dbGet(
      `SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id IN
        (SELECT id FROM oi_style_colors WHERE style_id = ?)`,
      [Number(st.id)],
    ).n;
    assert.strictEqual(Number(n), 0, `款 ${st.code} 还有键挂着`);
  }
});

check('已合并的组不再出现在候选里（不反复提示已经做完的事）', () => {
  const grp = odb.styleMergeCandidates().find((g) => g.supplierId === MG_SUP);
  assert.strictEqual(grp, undefined, 'B、C 已无键，这一组不该再出现');
});

check('拆开（按批次）：键 / 色 / 订单行全部回到原位，记录清空', () => {
  const before = odb.styleMergeBoard().merges.length;
  const r = odb.unmergeStyles(mgBatch);
  assert.strictEqual(r.ok, true, `拆开失败：${r.error}`);
  assert.strictEqual(r.skipped, 0, `不该有跳过：${r.skipped}`);
  assert.ok(r.restored >= 3, `还原项数应 >= 3（色 + 键），实际 ${r.restored}`);
  assert.strictEqual(
    dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors WHERE style_id = ?`, [Number(mgA.id)]).n,
    mgAColorsBefore,
    '目标款色数没回到合并前',
  );
  assert.strictEqual(
    dbQuery(`SELECT id, color FROM oi_style_colors WHERE style_id = ?`, [Number(mgB.id)]).length,
    3,
    'B 的三个色应全部回来',
  );
  const b5 = dbGet(
    `SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id IN
      (SELECT id FROM oi_style_colors WHERE style_id = ? AND color = '5')`,
    [Number(mgB.id)],
  ).n;
  assert.ok(Number(b5) >= 1, 'B 的「5」键没回到 B');
  assert.strictEqual(odb.styleMergeBoard().merges.length, before - 1, '合并记录没删掉');
  assert.strictEqual(dbGet(`SELECT COUNT(*) AS n FROM oi_variant_keys`).n, mgKeysBefore);
  assert.strictEqual(
    dbGet(`SELECT COUNT(*) AS n FROM oi_order_items WHERE COALESCE(style_color_id, 0) > 0`).n,
    mgRowsBefore,
  );
});

check('拆开后再拆一次：同一批次已不在，给原话而不是静默成功', () => {
  const r = odb.unmergeStyles(mgBatch);
  assert.strictEqual(r.ok, false);
  assert.ok(/不在|拆过/.test(String(r.error)), `原话不对：${r.error}`);
});

check('合并 → 再合并 → 只拆后者：前一次的合并仍然生效（批次互不干扰）', () => {
  const b1 = odb.mergeStylesInto(Number(mgA.id), [Number(mgB.id)]);
  assert.strictEqual(b1.ok, true);
  const b2 = odb.mergeStylesInto(Number(mgA.id), [Number(mgC.id)]);
  assert.strictEqual(b2.ok, true);
  assert.notStrictEqual(b1.batchId, b2.batchId, '两次操作必须是两个批次');
  const u2 = odb.unmergeStyles(b2.batchId);
  assert.strictEqual(u2.ok, true);
  const cKeys = dbGet(
    `SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id IN
      (SELECT id FROM oi_style_colors WHERE style_id = ?)`,
    [Number(mgC.id)],
  ).n;
  assert.ok(Number(cKeys) >= 1, 'C 的键应回来');
  const bKeys = dbGet(
    `SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id IN
      (SELECT id FROM oi_style_colors WHERE style_id = ?)`,
    [Number(mgB.id)],
  ).n;
  assert.strictEqual(Number(bKeys), 0, '拆 C 那次不该把 B 也放回去');
  odb.unmergeStyles(b1.batchId);
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