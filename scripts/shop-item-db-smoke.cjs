// 店铺商品采集（pl_shop_items）数据层冒烟（不启动 Electron 界面）。
//
//   npm run shop-item:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/shop-item-db-smoke.cjs
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI**（149）编译，vitest 跑在系统 Node（127），
// require 时直接抛 ABI 不匹配。故 DB 层统一走冒烟（与 shop-db-smoke / product-db-smoke 同一理由）。
//
// 覆盖 AE_SHOP_ITEM_SYNC_PLAN P1 的核心不变量：
//   · 落库幂等：同一 (shop_id, store_key, item_id) 再采 = 覆盖更新，不插第二行
//   · 店铺匹配按证据强度：归一 URL → storeId(=platform_shop_id)；不到就落未登记桶，
//     **不自动建店、不按同名自动落库**（shopSku 口径 4 / G6：自动命中永不自动落库）
//   · URL 匹配两侧同口径归一：用户贴的地址与页面采集的 URL 差协议 / www / 尾斜杠 /
//     index.html / query 都能对上（审查 P1「精确匹配大面积失配」的修正）
//   · 唯一键含 store_key：两家未登记店采到同一商品不互相覆盖（审查 P1 修正）
//   · 收养：店铺登记后，未登记桶里同身份（店名 / 归一 URL / storeId）的行搬进该店；
//     该店已有同 item_id 的行时不撞 UNIQUE(shop_id, store_key, item_id)
//   · summary 用 EXISTS 不用 JOIN：一个商品有多条 confirmed 映射行（spec 维度）时
//     采集数不被算重；未登记桶单独成行、confirmed 只认 confirmed 映射
// 每个用例自带 reset()：避免上一条的种子数据让下一条"新增"报重复键，产生假失败。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-shop-item-smoke-'));

const { initDb, closeDb, dbRun, dbGet, dbQuery } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const sidb = require(path.join(ROOT, 'dist', 'electron', 'shop-item-db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));

initDb(path.join(dir, 'smoke.db'));
sdb.ensureShopSchema();
sidb.ensureShopItemSchema();
pdb.ensureProductSchema();
pdb.ensureSkuSchema(); // summary 的 confirmed 计数要读 pl_shop_sku

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

const reset = () => {
  // ⚠️ `pl_shop_store_keys`（收养记忆）必须一起清：它记的是「桶键 → 店 id」，
  //    而 `sk_shops` 被清空后那些 id 全成悬空。漏清 ⇒ 上一条用例的记忆**跨用例泄漏**，
  //    后面的用例拿到一个本不该存在的记忆（症状：某条「认不出的桶不许乱塞」的断言变异打不红）。
  for (const t of ['pl_shop_items', 'pl_shop_sku', 'sk_shops', 'sk_name_map', 'pl_shop_store_keys']) {
    dbRun(`DELETE FROM ${t}`);
  }
};

/** 采集帧（ae-shop-item/v1） */
const frame = (store, items) => ({ schema: 'ae-shop-item/v1', store, items });
/** 单条采集商品（itemId 必填；其余缺省即空） */
const item = (over = {}) => ({
  itemId: '1005001234567890',
  title: '测试商品',
  imageUrl: 'https://ae01.alicdn.com/kf/S1234.jpg',
  priceText: 'US $9.99',
  ...over,
});
/** 店铺全量入参（upsert 是全量提交语义） */
const shopInput = (over = {}) => ({
  id: 0,
  platform: 'ae',
  name: '深圳优选店',
  platformShopId: '',
  shopUrl: '',
  site: 'RU',
  status: 'active',
  openedAt: '',
  note: '',
  ...over,
});
/** 插一条映射行（认款写路径由 product:sku:smoke 覆盖，这里直接播种） */
const seedMapping = (shopId, itemId, spec, status, productId = 0) => {
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status) VALUES (?,?,?,?,?,?)`,
    ['ae', shopId, itemId, spec, productId, status],
  );
};

// -------------------------------------------------------------------------- 落库

check('合法帧落库：3 条全插；同一帧再采 = 覆盖更新（不插第二行）', () => {
  reset();
  const f = frame({ url: 'https://shop.example.com/store/1' }, [
    item({ itemId: 'A1' }),
    item({ itemId: 'A2' }),
    item({ itemId: 'A3' }),
  ]);
  const r1 = sidb.upsertShopItems(f);
  assert.strictEqual(r1.inserted, 3);
  assert.strictEqual(r1.updated, 0);
  assert.strictEqual(r1.received, 3);
  const r2 = sidb.upsertShopItems(frame({ url: 'https://shop.example.com/store/1' }, [item({ itemId: 'A1', title: '改过的标题' })]));
  assert.strictEqual(r2.updated, 1);
  assert.strictEqual(r2.inserted, 0);
  const rows = sidb.listShopItems({}).rows;
  assert.strictEqual(rows.length, 3, '再采不能插出第二行');
  const a1 = rows.find((r) => r.itemId === 'A1');
  assert.strictEqual(a1.title, '改过的标题', 'upsert 要覆盖旧快照');
});

check('缺 itemId 跳过：空串 / 纯空白 / 非字符串都进 skipped，不影响其余', () => {
  reset();
  const r = sidb.upsertShopItems(
    frame({}, [item({ itemId: 'B1' }), item({ itemId: '' }), item({ itemId: '   ' }), item({ itemId: 12345 })]),
  );
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.skipped, 3, '空串/纯空白/非字符串共 3 条应被跳过');
});

check('SKU 矩阵规范化：props 两种形式都解析成 {color,size,price,imageUrl}（口径 = 订单侧 parseSkuProps）', () => {
  reset();
  sidb.upsertShopItems(
    frame({}, [
      item({
        itemId: 'M1',
        skus: [
          { props: 'Color:Black;Size:L', price: 'US $9.99', imageUrl: 'https://ae01.alicdn.com/kf/Sblack_L.jpg' }, // 形式一：kv + 色图
          { props: 'Red+M+China', price: 'US $10.50' }, // 形式二：+ 分隔（尺码/发货地按形态认）
          { color: '藏蓝', size: 'XL', price: 'US $11.00' }, // 显式字段优先于 props
          { props: '', price: '' }, // 全空 → 整行跳过（空行占位只会让人以为漏采）
          'not-an-object', // 非对象 → 跳过
        ],
      }),
    ]),
  );
  const row = sidb.listShopItems({}).rows.find((x) => x.itemId === 'M1');
  const skus = JSON.parse(row.skuJson);
  assert.strictEqual(skus.length, 3, '全空与非对象的两条应被跳过');
  assert.deepStrictEqual(skus[0], {
    color: 'Black',
    size: 'L',
    price: 'US $9.99',
    imageUrl: 'https://ae01.alicdn.com/kf/Sblack_L.jpg',
  });
  // 没采到色图 = 空串（"不存在"与"零"分开；向导据此不拿主图冒充色图）
  assert.deepStrictEqual(skus[1], { color: 'Red', size: 'M', price: 'US $10.50', imageUrl: '' });
  assert.deepStrictEqual(skus[2], { color: '藏蓝', size: 'XL', price: 'US $11.00', imageUrl: '' });
});

// ---- 尺码归一（2026-10-17）----
//
// 真库取证：546 条 SKU 里 78 条的尺码带卖家写的**修饰**，只有三种形态 ——
//   体重区间 `XL 60-65kg` / 版型前缀 `Asian size XXXL` / 全角括号补注 `XS（old）`。
// 原样落库 ⇒ 矩阵列头一个码占四列（12 列里 8 列其实是重复的码），用户会以为采到了八种尺码。
// 剥的是**修饰**不是整行：真丢掉这 78 条，那 4 个商品的矩阵会凭空少几十个组合。
//
// 归一入口如今只有一条：采集落库 ⇒ `normalizeIngestSku` → `normalizeSkuSize`。
// 原来"人在矩阵里手改 ⇒ 原样保留"的第二条入口已于 2026-10-23 撤除 —— 采集段只认款、
// SKU 矩阵降为只读，矩阵的唯一维护面是产品编辑抽屉（写的是产品 SKU，不回写采集快照）。

check('尺码归一：采集来的三种修饰全剥掉；罕见的正当码一个都不许动', () => {
  reset();
  sidb.upsertShopItems(
    frame({}, [
      item({
        itemId: 'SIZE1',
        skus: [
          { color: 'a', size: 'XL 60-65kg' }, // 体重区间（真库 28 条）
          { color: 'a', size: 'S 35-40kg' },
          { color: 'a', size: '7XL 105-115kg' },
          { color: 'a', size: 'Asian size XXXL' }, // 版型前缀（真库 36 条）
          { color: 'a', size: 'Asian size 4XL' },
          { color: 'a', size: 'XS（old）' }, // 括号补注（真库 14 条，全角括号）
          // 对照三条：正当但少见的码 —— 黑名单式"校验像不像尺码"会误伤它们
          { color: 'a', size: '70B' },
          { color: 'a', size: 'S (2-3 years)' }, // 括号里含数字 = 童装年龄段，剥了会并变体
          { color: 'a', size: '均码' },
        ],
      }),
    ]),
  );
  const sizes = JSON.parse(sidb.listShopItems({ search: 'SIZE1' }).rows[0].skuJson).map((s) => s.size);
  assert.deepStrictEqual(
    sizes,
    ['XL', 'S', '7XL', 'XXXL', '4XL', 'XS', '70B', 'S (2-3 years)', '均码'],
    '剥完必须逐条对位（顺序也不能变：矩阵列序 = 首次出现序）',
  );
});

// 下面三条钉「两个采集层级互不毁数据」（2026-10-15 修）：
// 列表帧没有 SKU、详情帧（「采 SKU」）没有标题/图/价 —— 覆盖口径必须是「只覆盖非空」，
// 否则后跑的那次会把另一次采到的字段静默清空。⭐ 第二条是反向的（全店重采清 SKU），
// 第三条防"有值就一律不覆盖"的坏实现 —— 少它前两条在任何实现下都可能恒绿。

check('两个采集层级互不毁数据①：详情帧（只有 SKU）不清空列表帧的标题/图/价', () => {
  reset();
  const store = { name: '层级店' };
  sidb.upsertShopItems(
    frame(store, [item({ itemId: 'M2', title: '列表采到的标题', priceText: 'US $1.00', imageUrl: 'https://img.example/x.jpg' })]),
  );
  // 详情帧的**生产形状**：只有 itemId + skus（没有 title/imageUrl/priceText 三个键）
  const r = sidb.upsertShopItems(frame(store, [{ itemId: 'M2', skus: [{ props: 'Color:Black;Size:L', price: 'US $1.20' }] }]));
  assert.strictEqual(r.updated, 1);
  const row = sidb.listShopItems({ search: 'M2' }).rows[0];
  assert.strictEqual(row.title, '列表采到的标题', '详情帧没带标题 ⇒ 旧标题必须留着（全字段覆盖会清成空串）');
  assert.strictEqual(row.priceText, 'US $1.00', '售价同理');
  assert.strictEqual(row.imageUrl, 'https://img.example/x.jpg', '主图同理');
  assert.strictEqual(JSON.parse(row.skuJson).length, 1, '这一遍真带了 SKU，必须写进去');
});

check('两个采集层级互不毁数据②：列表重采（帧里 SKU 空）不清空已采到的 SKU 矩阵', () => {
  reset();
  const store = { name: '层级店2' };
  sidb.upsertShopItems(frame(store, [item({ itemId: 'M3', skus: [{ props: 'Color:Black;Size:L' }] })]));
  const before = JSON.parse(sidb.listShopItems({ search: 'M3' }).rows[0].skuJson);
  assert.strictEqual(before.length, 1, '前提：先把 SKU 采进来');
  sidb.upsertShopItems(frame(store, [item({ itemId: 'M3', title: '重采的新标题' })]));
  const row = sidb.listShopItems({ search: 'M3' }).rows[0];
  assert.deepStrictEqual(JSON.parse(row.skuJson), before, '列表帧 skus=[] ⇒ SKU 矩阵必须留着（全店重采曾会把它清成 []）');
  assert.strictEqual(row.title, '重采的新标题', '非空新值照常覆盖 —— 是"空值不覆盖"不是"一律不覆盖"');
});

check('两个采集层级互不毁数据③：详情帧带新 SKU ⇒ 覆盖旧矩阵（守卫不是"有 SKU 就不动"）', () => {
  reset();
  const store = { name: '层级店3' };
  sidb.upsertShopItems(frame(store, [item({ itemId: 'M4', skus: [{ props: 'Color:Black;Size:L' }] })]));
  sidb.upsertShopItems(frame(store, [{ itemId: 'M4', skus: [{ props: 'Color:Red;Size:M' }] }]));
  const skus = JSON.parse(sidb.listShopItems({ search: 'M4' }).rows[0].skuJson);
  assert.strictEqual(skus.length, 1);
  assert.strictEqual(skus[0].color, 'Red', '新 SKU 必须覆盖旧的（防"有值就跳过"的坏实现）');
});

// -------------------------------------------------------------------------- 店铺匹配

check('URL 归一匹配：协议 / www / 尾斜杠 / index.html / query 差异都能对上', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ shopUrl: 'https://www.Example.com/store/123' }));
  // 地址落**两列**（2026-10-16 拆分）：匹配键归一，原文原样 —— 直接读库，不经读取面
  const raw = dbGet(`SELECT shop_url, shop_url_raw FROM sk_shops WHERE id = ?`, [shop.id]);
  assert.strictEqual(raw.shop_url, 'example.com/store/123', '匹配键必须仍是归一形（协议与 www 剥掉）');
  assert.strictEqual(
    raw.shop_url_raw,
    'https://www.Example.com/store/123',
    '原文必须原样留着（2026-10-16 之前被同一函数剥掉协议 ⇒ 两处「打开店铺」全报"链接地址无效"）',
  );
  // 采集帧带的是页面地址：http、无 www、带 index.html 与 query
  sidb.upsertShopItems(frame({ url: 'http://example.com/store/123/index.html?spm=xxx#frag' }, [item({ itemId: 'C1' })]));
  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 1, '不同形 URL 应归一到同一家店');
  assert.strictEqual(rows[0].shopId, shop.id);
  assert.strictEqual(rows[0].storeKey, '');
});

// -------------------------------------------------------------------------- 店铺地址：原文 vs 匹配键
//
// 一列一个角色（2026-10-16）：`shop_url` = 采集帧的匹配键，`shop_url_raw` = 界面里的地址原文。
// 用户现场：在「店铺登记」里填 `https://…` 保存后被剥成 `…`，回到「货与成本 › 待关联采集商品」
// 点「打开店铺」报**链接地址无效** —— 根因是同一个函数既当匹配键又当展示值。
// 下面四条钉的就是这个拆分：原文（可打开）与键（可匹配）各自成立，且**永远同源**。

/** 直接读库里的两列（不经读取面 —— 读取面只给原文，验证不了键） */
const urlCols = (id) => dbGet(`SELECT shop_url, shop_url_raw FROM sk_shops WHERE id = ?`, [id]);

check('地址：原文保留 `http://`（用户填 http 不该被改成 https），读取面给的就是原文', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: 'http 店', shopUrl: 'http://plain.example.com/store/9' }));
  assert.strictEqual(urlCols(shop.id).shop_url_raw, 'http://plain.example.com/store/9', '原文一字不改');
  assert.strictEqual(urlCols(shop.id).shop_url, 'plain.example.com/store/9', '键照旧归一');
  assert.strictEqual(sdb.getShop(shop.id).shopUrl, 'http://plain.example.com/store/9', '读取面（列表/详情）给原文');
});

check('地址：没写协议 ⇒ 补 https（原文与键同源）；裸域名不再落一个"打不开的键"', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '裸域名店', shopUrl: '  example.com/store/7  ' }));
  const c = urlCols(shop.id);
  assert.strictEqual(c.shop_url_raw, 'https://example.com/store/7', '裸域名补 https 前缀（可打开）');
  assert.strictEqual(c.shop_url, 'example.com/store/7', '键从**规整后的原文**派生，两侧同源');
  assert.ok(
    sdb.getShop(shop.id).shopUrl.startsWith('https://'),
    '读取面给的值必须能过 open-external 的 http(s) 判据 —— 这条就是用户报的"链接地址无效"',
  );
});

check('地址：编辑改/清空 ⇒ 两列同步（清空后不留幽灵键，采集不会再误配到这家店）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '改址店', shopUrl: 'https://a.example.com/store/1' }));
  assert.strictEqual(shop.created, true);
  // 改地址（全量提交语义：整行回传）
  sdb.upsertShop(shopInput({ id: shop.id, name: '改址店', shopUrl: 'https://b.example.com/store/2' }));
  assert.deepStrictEqual(
    urlCols(shop.id),
    { shop_url: 'b.example.com/store/2', shop_url_raw: 'https://b.example.com/store/2' },
    '两列都要跟着改（只改一列 ⇒ 展示与实际匹配分叉）',
  );
  // 清空地址
  sdb.upsertShop(shopInput({ id: shop.id, name: '改址店', shopUrl: '' }));
  assert.deepStrictEqual(urlCols(shop.id), { shop_url: '', shop_url_raw: '' }, '清空后两列都空');
  assert.strictEqual(sdb.getShop(shop.id).shopUrl, '', '读取面也回到空（界面据此把「打开」换成「没填地址」）');
});

// ---- 老库迁移见文件末尾（换库会打断本段后续用例的 reset()，故单开一段放在收尾前）----


check('storeId 匹配：帧无 URL 时按 storeId = platform_shop_id 命中', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: 'storeId 店', platformShopId: 'S-777' }));
  sidb.upsertShopItems(frame({ storeId: 'S-777' }, [item({ itemId: 'D1' })]));
  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shopId, shop.id);
});

// ⚠️ 这条用例 2026-10-17 改过一次：原文断言「同名不自动落库（shop_id=0）」，
//    但那天给 `matchShopByStore` 加了**第 3 级证据（店名全等）**—— 用户实测「采集的商品
//    没归到已登记的店，把店铺名称改成和采到的一致才归位」，店名匹配就此成为口径的一部分
//    （仍是"只认已登记过的店"，不自动建店）。口径变了，断言没跟着改 ⇒ 一直红着。
//    现在钉的是**改后的**纪律：同名且已登记 ⇒ 归该店；同名但**没登记过** ⇒ 落未登记桶
//    （不自动建店这一条由下一条用例守住）。
check('店名匹配（第 3 级）：帧只有店名、与已登记店全等 → 归该店（URL/storeId 都空也认）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '同名店' }));
  sidb.upsertShopItems(frame({ name: '同名店' }, [item({ itemId: 'E1' })]));
  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 1, '店名全等 + 该店已登记 ⇒ 应归到该店');
  assert.strictEqual(rows[0].shopId, shop.id);
  assert.strictEqual(rows[0].storeKey, '', '归店后 store_key 是规范形态（空串）');
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 0, '未登记桶不该留副本（不留两行）');
});

check('不自动建店：店名没有任何已登记店对应 → 仍落未登记桶（store_key = 展示名）', () => {
  reset();
  sidb.upsertShopItems(frame({ name: '没登记过的店' }, [item({ itemId: 'E2' })]));
  const rows = sidb.listShopItems({ shopId: -1 }).rows;
  assert.strictEqual(rows.length, 1, '认不出的店名不得凭空建店（G6），落未登记桶并保留展示名');
  assert.strictEqual(rows[0].shopId, 0);
  assert.strictEqual(rows[0].storeKey, '没登记过的店', 'store_key 就是展示名（登记后据此收养/命中）');
});

// --------------------------------------------------------------------------
// 商品ID 反查店铺（2026-10-19）——治「商品ID 明明在手上，却只按店名认店」
//
// 真库形状：用户把店名填进「平台店铺ID」、URL 数字也填错 ⇒ matchShopByStore 四级全落空。
// 而 pl_shop_items 的键就是 (shop_id, store_key, item_id)：**商品ID 自己就能反证店**。
// 纪律：唯一命中才用；多店/店已删 ⇒ 仍旧落桶（宁可让人归一，也不乱挂）。
// --------------------------------------------------------------------------

check('商品ID 反查：帧不带任何店铺身份，但该商品曾在已登记店采到 → 归那家店（不进未登记桶）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '反查店' }));
  // ① 先用**能认出店**的帧采一次（店名全等 ⇒ 第 3 级命中），库里留下 (shop_id, item_id)
  sidb.upsertShopItems(frame({ name: '反查店' }, [item({ itemId: 'R1', title: '第一次' })]));
  assert.strictEqual(sidb.listShopItems({ shopId: shop.id }).rows.length, 1, '前提：第一次要归店');
  // ② 扩展这次没采到 store（真实发生：详情帧只带 items）
  sidb.upsertShopItems(frame({}, [item({ itemId: 'R1', title: '第二次' }), item({ itemId: 'R2', title: '新增的' })]));
  const inShop = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(inShop.length, 2, '同帧里已采过的商品反查出店 ⇒ 新商品跟着归该店');
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 0, '未登记桶不许留副本（否则同一款存两行）');
  assert.strictEqual(inShop.find((r) => r.itemId === 'R1').title, '第二次', '反查命中的行仍走覆盖更新');
  assert.strictEqual(inShop.every((r) => r.storeKey === ''), true, '归店后 store_key 是规范形态（空串）');
});

check('商品ID 反查：同一商品ID 命中两家已登记店 = 歧义 ⇒ 落未登记桶，绝不挑一个', () => {
  reset();
  const a = sdb.upsertShop(shopInput({ name: '店甲' }));
  const b = sdb.upsertShop(shopInput({ name: '店乙' }));
  // 直接播种"同一 itemId 在两家店都采到过"（历史重复行的真实形状）
  for (const shop of [a, b]) {
    dbRun(
      `INSERT INTO pl_shop_items (shop_id, store_key, item_id, title, sku_json) VALUES (?, '', 'R9', '', '')`,
      [shop.id],
    );
  }
  sidb.upsertShopItems(frame({}, [item({ itemId: 'R9' })]));
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 1, '歧义必须回落未登记桶（不猜是哪家）');
  assert.strictEqual(sidb.listShopItems({ shopId: a.id }).rows.length, 1, '原有两行不动（不是新增，是原样）');
});

check('商品ID 反查：店被删后不得命中（悬空 shop_id 比未登记桶更难查）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '要删的店' }));
  sidb.upsertShopItems(frame({ name: '要删的店' }, [item({ itemId: 'R3' })]));
  dbRun(`DELETE FROM sk_shops WHERE id = ?`, [shop.id]);
  sidb.upsertShopItems(frame({}, [item({ itemId: 'R3' })]));
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 1, 'JOIN sk_shops 要挡住已删店');
});

// --------------------------------------------------------------------------
// 收养记忆（2026-10-18）——治「收养只跑一次，登记后再采又落未登记桶」
//
// 复刻的报障形状：用户登记店时把**店名**填进了「平台店铺ID」、URL 数字也填错 ⇒
// matchShopByStore 的 1、2 两级恒落空；收养只在「保存店铺」那一次动作里跑 ⇒ 之后再采
// 每次都落未登记桶，同一款在两个桶各存一行（真库实测九店 40 条 / 未登记桶 63 条、交集 40）。
// --------------------------------------------------------------------------

check('记忆命中：URL 与 storeId 都填错、只靠店名那次登记的记忆 → 之后的帧直接归该店', () => {
  reset();
  // ⚠️ 顺序是复刻的关键：**先采、后登记**（真实报障就是这个顺序）。若先建店，
  //    第 3 级店名匹配当场生效，第一采就归店了，根本走不到"落桶→收养→再采"这条路。
  // ① 店还没登记时采一次 → 落未登记桶
  sidb.upsertShopItems(frame({ name: '记忆店' }, [item({ itemId: 'M1', title: '采到的' })]));
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 1, '前提：店未登记时先落未登记桶');
  // ② 用户登记该店；URL / storeId **故意填错**（模拟真库九店那种填法）⇒ 1、2 两级从此恒落空
  const shop = sdb.upsertShop(shopInput({ name: '记忆店', shopUrl: 'https://wrong.example.com/store/1', platformShopId: 'WRONG-ID' }));
  const adopted = sidb.adoptShopItemsForShop(shop.id, { name: '记忆店', url: 'https://wrong.example.com/store/1', storeId: 'WRONG-ID' });
  assert.strictEqual(adopted.adopted, 1, '登记时收养那一条');
  // ③ **不再保存店铺**，直接再采一次（URL/storeId 仍然填错，1、2 两级仍落空）
  sidb.upsertShopItems(frame({ name: '记忆店' }, [item({ itemId: 'M2', title: '第二次采的' })]));
  const inShop = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(inShop.length, 2, '第二次采的也要归该店（靠记忆），不能又落回未登记桶');
  assert.deepStrictEqual(
    inShop.map((r) => r.itemId).sort(),
    ['M1', 'M2'],
    '未登记桶不该留副本 —— 这正是「同一款存两行」的来源',
  );
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 0, '未登记桶已空');
});

check('记忆只认「已登记过的店」：记忆键没有对应店实体时不得落库（防悬空 shop_id）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '会删的店' }));
  sidb.adoptShopItemsForShop(shop.id, { name: '会删的店' });
  dbRun(`DELETE FROM sk_shops WHERE id = ?`, [shop.id]); // 用户把这家店删了
  sidb.upsertShopItems(frame({ name: '会删的店' }, [item({ itemId: 'M3' })]));
  assert.strictEqual(
    sidb.listShopItems({ shopId: -1 }).rows.length,
    1,
    '店被删后记忆必须失效（JOIN sk_shops 兜住）：落未登记桶，好过写一个悬空 shop_id 认不了款',
  );
});

check('记忆只经「登记」这条路产生（不许被 v2 迁移的回填兜住）', () => {
  reset();
  // ⚠️ 先把本域版本记成"最新"：v2 迁移只跑未应用的版本，版本记满后它**不会**执行 ⇒
  //    此刻记忆表是空的，下面这条只可能由 adoptShopItemsForShop 写入。
  //    （不这么做的话，上一条用例即使摘掉登记时的写入，迁移回填也会照样把它点亮 ⇒ 恒绿）
  sidb.ensureShopItemSchema();
  dbRun(`UPDATE sk_schema_migrations SET version = 999 WHERE key = 'shop-item.main'`);
  // 先采（店未登记）→ 未登记桶
  sidb.upsertShopItems(frame({ name: '登记路店' }, [item({ itemId: 'R1' })]));
  const shop = sdb.upsertShop(shopInput({ name: '登记路店', shopUrl: 'https://nope.example.com/x', platformShopId: 'NOPE' }));
  sidb.adoptShopItemsForShop(shop.id, { name: '登记路店' });
  const mem = dbGet(`SELECT shop_id FROM pl_shop_store_keys WHERE store_key = ?`, ['登记路店']);
  assert.ok(mem, '登记那一刻必须把桶键写进记忆表 —— 这是「之后再采也归这家店」的唯一来源');
  assert.strictEqual(Number(mem.shop_id), shop.id);
});

check('重复行合并（v2 迁移）：未登记桶 × 已登记店的同款只留一行，字段取非空、采集时间取较新', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '合并店' }));
  // 造报障形状：已登记店有一行（老采集、无 SKU），未登记桶有同款一行（后采、带 SKU）
  const sku = [{ color: 'Black', size: 'L', price: 'US $9.99', imageUrl: 'https://ae01.alicdn.com/kf/M.jpg' }];
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, title, image_url, price_text, sku_json, scraped_at)
     VALUES (?, '', 'DUP1', '', '', '', '[]', ?)`,
    [shop.id, 1000],
  );
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, title, image_url, sku_json, scraped_at)
     VALUES (0, '合并店', 'DUP1', '新采的标题', 'https://ae01.alicdn.com/kf/D.jpg', ?, ?)`,
    [JSON.stringify(sku), 2000],
  );
  // 另有一款只存在于未登记桶（该店还没有）⇒ 应被**搬进**该店而不是删掉
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, title, sku_json, scraped_at)
     VALUES (0, '合并店', 'ONLY1', '只在这桶的', '[]', 2000)`,
  );
  // 跑 v2 迁移（数据在、版本未记 = 真实升级路径）
  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'shop-item.main'`);
  sidb.ensureShopItemSchema();

  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 2, '同款重复行合并后只有两行（DUP1 + ONLY1）');
  const dup = rows.find((r) => r.itemId === 'DUP1');
  assert.strictEqual(dup.title, '新采的标题', '未登记那行更新（后采的才是最新事实），已登记那行的空标题被补上');
  assert.strictEqual(JSON.parse(dup.skuJson).length, 1, '已登记行原本是 []（只有列表信息），SKU 从后采那行补齐');
  assert.strictEqual(Number(dup.scrapedAt), 2000, 'scraped_at 取较新者');
  assert.strictEqual(
    rows.filter((r) => r.itemId === 'DUP1').length,
    1,
    '同款不得留两行（用户看到「待关联采集商品」里同一个商品出现两次就是这么来的）',
  );
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 0, '认得出的桶被搬空');
});

check('重复行合并（v2 迁移）：认不出的桶一律不动（店没登记 ≠ 可以乱塞进某家店）', () => {
  reset();
  // ⭐ 造出**恰好能揭穿"兜底给某个店 id"这类实现**的形状：库里先有别的店、且它的 id
  //   恰好等于夹具自增出来的下一个 id。若实现写成"认不出就塞给 1 号店 / 兜底某店"，
  //   在**没有 1 号店**的库里会全程落空而看起来"正确"（变异打不红）。
  //   这里显式建一家真实存在的店，并让它成为唯一可能被误挂的目标。
  const victim = sdb.upsertShop(shopInput({ name: '完全无关的店' }));
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, title, scraped_at)
     VALUES (0, '某家没登记的店', 'U1', '该留在这', 1)`,
  );
  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'shop-item.main'`);
  sidb.ensureShopItemSchema();
  const rows = sidb.listShopItems({ shopId: -1 }).rows;
  assert.strictEqual(rows.length, 1, '认不出的桶必须原样留着（界面提示「店铺未登记」是正确提示）');
  assert.strictEqual(rows[0].storeKey, '某家没登记的店');
  assert.strictEqual(
    sidb.listShopItems({ shopId: victim.id }).rows.length,
    0,
    '绝不能把认不出的桶塞进某家已登记的店（那是把两家的货混在一起，且不可逆）',
  );
});

// --------------------------------------------------------------------------
// 已采清单（去重真源头，2026-10-18）
// --------------------------------------------------------------------------

check('已采清单：只列「采到过 SKU 矩阵」的款（列表轻采的行不算 —— 否则永远拿不到 SKU）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '清单店', platformShopId: 'L-1' }));
  // WITH_SKU：详情帧（带矩阵）；LIST_ONLY：只有列表帧（sku_json='[]'）
  sidb.upsertShopItems(frame({ storeId: 'L-1' }, [
    item({ itemId: 'WITH_SKU', skus: [{ color: 'Black', size: 'L', price: 'US $1', imageUrl: '' }] }),
  ]));
  sidb.upsertShopItems(frame({ storeId: 'L-1' }, [item({ itemId: 'LIST_ONLY' })]));
  const r = sidb.listScrapedItemIds({ storeId: 'L-1' });
  assert.strictEqual(r.shopId, shop.id);
  assert.deepStrictEqual(
    r.itemIds,
    ['WITH_SKU'],
    '列表轻采的行（sku_json=[]）不算「采过」—— 扩展跳过它就永远采不到 SKU 矩阵（静默丢数据）',
  );
});

check('已采清单：与落库同一套匹配口径（店没登记时查未登记桶，别让它返回空）', () => {
  reset();
  sidb.upsertShopItems(frame({ name: '未登记X店' }, [
    item({ itemId: 'U2', skus: [{ color: 'a', size: 'M', price: 'US $2', imageUrl: '' }] }),
  ]));
  const r = sidb.listScrapedItemIds({ name: '未登记X店' });
  assert.strictEqual(r.shopId, 0, '店没登记 = 落未登记桶');
  assert.deepStrictEqual(r.itemIds, ['U2'], '未登记桶里采过的也要能查到，否则这类用户永远去不了重');
});

check('已采清单：匹配不上的店返回空而不是抛错（扩展不能因此崩）', () => {
  reset();
  const r = sidb.listScrapedItemIds({ name: '完全不存在的店' });
  assert.strictEqual(r.itemIds.length, 0);
  assert.strictEqual(r.storeKey, '完全不存在的店', 'store_key 仍回显（扩展可据此判断"没归到店"）');
});

check('store 缺省：整帧落未登记桶，store_key 为空', () => {
  reset();
  sidb.upsertShopItems(frame({}, [item({ itemId: 'F1' })]));
  const rows = sidb.listShopItems({ shopId: -1 }).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shopId, 0);
  assert.strictEqual(rows[0].storeKey, '');
});

check('唯一键含 store_key：两家未登记店采同一商品各留一行，不互相覆盖', () => {
  reset();
  sidb.upsertShopItems(frame({ name: '甲店' }, [item({ itemId: 'G1', title: '甲店看到的' })]));
  sidb.upsertShopItems(frame({ name: '乙店' }, [item({ itemId: 'G1', title: '乙店看到的' })]));
  const rows = sidb.listShopItems({}).rows;
  assert.strictEqual(rows.length, 2, '不同 store_key 的同名商品不得互相覆盖（审查 P1）');
  // 注意：.sort() 按 UTF-16 码元排，「乙」(U+4E59) 在「甲」(U+7532) 前 —— 两侧都排
  assert.deepStrictEqual(
    rows.map((r) => r.storeKey).sort(),
    ['甲店', '乙店'].sort(),
  );
  assert.deepStrictEqual(
    rows.map((r) => r.title).sort(),
    ['乙店看到的', '甲店看到的'].sort(),
  );
});

// -------------------------------------------------------------------------- 收养

check('收养：登记后未登记桶里同身份的行搬进该店', () => {
  reset();
  // 先采集（店未登记）→ 落未登记桶，store_key = 帧里的店名
  sidb.upsertShopItems(frame({ name: '待登记店' }, [item({ itemId: 'H1' })]));
  // 用户登记该店（shop-upsert handler 的顺序：upsertShop → adoptShopItemsForShop）
  const shop = sdb.upsertShop(shopInput({ name: '待登记店' }));
  const adopted = sidb.adoptShopItemsForShop(shop.id, { name: '待登记店' });
  assert.strictEqual(adopted.adopted, 1);
  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 1, '登记后不应还显示"未登记"');
  assert.strictEqual(rows[0].shopId, shop.id);
  assert.strictEqual(rows[0].storeKey, '', "登记后 store_key 归一为 ''");
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 0, '未登记桶应被搬空');
});

check('收养不撞键：该店已有同 item_id 的行时，未登记桶那条被跳过', () => {
  reset();
  // ① 店未登记时采集 → 落未登记桶（store_key = 帧里的店名）
  sidb.upsertShopItems(frame({ name: 'I店' }, [item({ itemId: 'I1', title: '旧采集' })]));
  // ② 登记该店（带 URL，让后续采集帧能按 URL 命中）
  const shop = sdb.upsertShop(shopInput({ name: 'I店', shopUrl: 'https://i.example.com' }));
  // ③ 登记后重新采集 → 落该店规范行（shop_id=店, store_key=''）
  sidb.upsertShopItems(frame({ url: 'https://i.example.com' }, [item({ itemId: 'I1', title: '新采集' })]));
  // ④ 收养：店名键能命中未登记桶那条，但同 item_id 规范行已存在 → 必须跳过
  const adopted = sidb.adoptShopItemsForShop(shop.id, { name: 'I店', url: 'https://i.example.com' });
  assert.strictEqual(adopted.adopted, 0, '已有同 item_id 行，未登记桶那条应被跳过');
  const rows = sidb.listShopItems({ shopId: shop.id }).rows;
  assert.strictEqual(rows.length, 1, '不能撞 UNIQUE(shop_id, store_key, item_id) 插出两行');
  assert.strictEqual(rows[0].title, '新采集', '保留登记后新采的规范行');
});

// -------------------------------------------------------------------------- 汇总 / 列表

check('summary：一个商品多条 confirmed 映射行不把采集数算重（EXISTS 不用 JOIN）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '汇总店', platformShopId: 'J-777' }));
  // 帧带 storeId 才能归到该店（空 storeId = 未登记桶）
  sidb.upsertShopItems(frame({ storeId: 'J-777' }, [item({ itemId: 'J1' }), item({ itemId: 'J2' })]));
  // J1 有两条 confirmed 映射（spec 维度，生产上一期恒 '*'，这里造极端形状）
  seedMapping(shop.id, 'J1', '*', 'confirmed');
  seedMapping(shop.id, 'J1', 'S', 'confirmed');
  // J2 只有 pending 映射 → 不算已认款
  seedMapping(shop.id, 'J2', '*', 'pending');
  const sum = sidb.shopItemsSummary();
  const row = sum.find((r) => r.shopId === shop.id);
  assert.ok(row, '汇总应有该店');
  assert.strictEqual(row.total, 2, 'JOIN 会把 J1 算成 2 个 → total 虚高');
  assert.strictEqual(row.confirmed, 1, '只有 J1 算已认款（两条映射仍是同一个商品）');
  assert.ok(row.lastScrapedAt > 0);
});

check('summary：未登记桶单独成行，confirmed=0', () => {
  reset();
  sidb.upsertShopItems(frame({ name: '未登记店' }, [item({ itemId: 'K1' })]));
  const sum = sidb.shopItemsSummary();
  const row = sum.find((r) => r.shopId === 0);
  assert.ok(row, '未登记桶应单独成行');
  assert.strictEqual(row.storeKey, '未登记店');
  assert.strictEqual(row.total, 1);
  assert.strictEqual(row.confirmed, 0);
});

check('list：分页 / 搜索 / 未登记过滤', () => {
  reset();
  for (let i = 1; i <= 3; i++) sidb.upsertShopItems(frame({}, [item({ itemId: `L${i}`, title: `商品${i}` })]));
  sidb.upsertShopItems(frame({}, [item({ itemId: 'LX', title: '其它' })]));
  const p1 = sidb.listShopItems({ page: 0, pageSize: 2 });
  assert.strictEqual(p1.total, 4);
  assert.strictEqual(p1.rows.length, 2);
  const p2 = sidb.listShopItems({ page: 1, pageSize: 2 });
  assert.strictEqual(p2.rows.length, 2);
  assert.strictEqual(sidb.listShopItems({ page: 2, pageSize: 2 }).rows.length, 0);
  const searched = sidb.listShopItems({ search: '商品1' });
  assert.strictEqual(searched.total, 1, '标题 LIKE 搜索');
  assert.strictEqual(sidb.listShopItems({ search: 'L2' }).total, 1, 'item_id LIKE 搜索');
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).rows.length, 4, 'shopId<0 = 只看未登记');
  assert.strictEqual(sidb.listShopItems({ shopId: NaN }).rows.length, 4, 'shopId=NaN 视为不过滤（不得绑进 SQL）');
});

// --------------------------------------------------------------------------
// 按款筛（2026-10-23）——产品编辑「从采集商品导入矩阵」的数据源
//
// 「这条采集行**现在**认的是哪个款」与列表的 mappedProductId / summary 的 confirmed
// 用的是**同一条**判据：最新一条 confirmed 映射。这里钉三件事：
//   ① 只返回当前认到该款的行（未认款的、认到别款的不出现）；
//   ② 改绑之后**旧款不再筛出它**（历史 confirmed 行还在，但"现在"认的是新家）；
//   ③ total 与 rows 同口径（COUNT 漏掉 JOIN 时 total 会数成全表）。
// 少了 ②，产品侧导入会把"以前认过、现在已经改绑走"的采集商品也列出来 —— 静默多导数据。
// --------------------------------------------------------------------------

const newProduct = (code) =>
  pdb.upsertProduct({ id: 0, code, name: code, supplierId: 0, category: '', status: 'active', note: '' }).id;

check('按款筛：只列当前认到该款的采集行；未认款/认到别款/pending 都不出现，total 同口径', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '按款筛店', platformShopId: 'P-1' }));
  sidb.upsertShopItems(
    frame({ storeId: 'P-1' }, [item({ itemId: 'PI-A' }), item({ itemId: 'PI-B' }), item({ itemId: 'PI-NONE' }), item({ itemId: 'PI-PEND' })]),
  );
  const p1 = newProduct('PF-1');
  const p2 = newProduct('PF-2');
  seedMapping(shop.id, 'PI-A', '*', 'confirmed', p1);
  seedMapping(shop.id, 'PI-B', '*', 'confirmed', p2);
  seedMapping(shop.id, 'PI-PEND', '*', 'pending', p1);
  const r = sidb.listShopItems({ productId: p1 });
  assert.deepStrictEqual(
    r.rows.map((x) => x.itemId),
    ['PI-A'],
    '只列当前认到款一的（PI-B 认的是款二、PI-NONE 没认款、PI-PEND 只是 pending）',
  );
  assert.strictEqual(r.total, 1, 'total 必须与 rows 同口径（COUNT 漏 JOIN 会数成 4）');
  assert.strictEqual(Number(r.rows[0].mappedProductId), p1);
  assert.strictEqual(r.rows[0].mappedProductCode, 'PF-1', '行上带出当前款编码（界面不用再发 N 次请求）');
});

check('按款筛：改绑后旧款不再筛出这一行（"历史认过"不等于"现在认的是它"）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '改绑店', platformShopId: 'P-2' }));
  sidb.upsertShopItems(frame({ storeId: 'P-2' }, [item({ itemId: 'RE-1' })]));
  const p1 = newProduct('PF-3');
  const p2 = newProduct('PF-4');
  seedMapping(shop.id, 'RE-1', '*', 'confirmed', p1); // 历史：认过款一
  seedMapping(shop.id, 'RE-1', '*', 'confirmed', p2); // 当前：改绑到款二（后写的 id 更大）
  assert.strictEqual(
    sidb.listShopItems({ productId: p1 }).total,
    0,
    '旧款不该再筛出它（否则改绑后两款的导入列表里都出现同一行）',
  );
  const cur = sidb.listShopItems({ productId: p2 });
  assert.strictEqual(cur.total, 1);
  assert.strictEqual(cur.rows[0].mappedProductCode, 'PF-4');
});

check('按款筛：0 / NaN 视为不过滤（不把非法值绑进 SQL）', () => {
  reset();
  sidb.upsertShopItems(frame({}, [item({ itemId: 'NF-1' })]));
  assert.strictEqual(sidb.listShopItems({ productId: 0 }).total, 1, '0 = 不过滤');
  assert.strictEqual(sidb.listShopItems({ productId: NaN }).total, 1, 'NaN = 不过滤（绑定会直接抛）');
});

// -------------------------------------------------------------------------- 手贴商品ID导入（保底通道；审查 P1-1）
//
// 钉的是「**人点名的店铺必须赢**」：sk_shops.shop_url 与 platform_shop_id 都是**可选**字段，
// P0 之前登记的店两个都空 ⇒ 走「取店实体 → 反查 url/storeId/name → matchShopByStore」那条路
// 必然落空 ⇒ 行被写进 shop_id=0 未登记桶，而回执照样"已接收 N 条"（界面说做了、数据没到地方）。
//
// ⭐ 夹具纪律：下面第一条的店**绝不给它补地址、也不补平台店铺ID** —— 生产里老店就是两个都空，
// 补上就等于把这条用例关掉（P1-1 一直没被守住，就是这么漏的）。

/** 只有店名的老店（生产里最常见的形状：没地址、没平台店铺ID） */
const nameOnlyShop = (name) =>
  sdb.upsertShop(shopInput({ name, platformShopId: '', shopUrl: '' }));
const itemsOf = (itemId) => sidb.listShopItems({ search: itemId }).rows;

check('手贴导入：点名到「只有店名」的店 ⇒ 落在该店下，不掉进未登记桶（审查 P1-1）', () => {
  reset();
  const shop = nameOnlyShop('我的店A');
  assert.strictEqual(shop.shopUrl || '', '', '夹具必须是"没地址的老店"形状 —— 补了地址这条用例就恒绿');
  assert.strictEqual(shop.platformShopId || '', '', '同理，平台店铺ID 也不许补');
  const r = sidb.importManualItems(shop.id, ['999000111', '999000222']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.inserted, 2, '两条都该新增');
  const rows = itemsOf('999000111');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].shopId, shop.id, '点名了店就必须落这家店 —— 落 0 = 掉进未登记桶');
  assert.strictEqual(rows[0].storeKey, '', '已归属店铺的行 store_key 是规范形态（空）');
  assert.strictEqual(rows[0].source, 'manual', '手贴的行在表上要分得开');
  assert.strictEqual(sidb.listShopItems({ shopId: -1 }).total, 0, '未登记桶里不该出现手贴行');
  // 界面按汇总分组显示 ⇒ 汇总口径也必须跟着对，否则"列表对了、状态条还是老样子"
  const sum = sidb.shopItemsSummary();
  assert.ok(sum.some((s) => s.shopId === shop.id && s.total === 2), '汇总里该店应有 2 条');
  assert.ok(!sum.some((s) => s.shopId === 0), '不该冒出未登记桶');
});

check('手贴导入：点名到有地址的店 ⇒ 同样落该店（pin 不会把本来就对的改坏）', () => {
  reset();
  const shop = sdb.upsertShop(shopInput({ name: '有址店', shopUrl: 'https://has-url.example.com' }));
  const r = sidb.importManualItems(shop.id, ['888000111']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(itemsOf('888000111')[0].shopId, shop.id);
});

check('手贴导入幂等：同店同 ID 再贴 = 更新不新增；空ID 计 skipped 不静默吞', () => {
  reset();
  const shop = nameOnlyShop('幂等店');
  const a = sidb.importManualItems(shop.id, ['777000111']);
  assert.strictEqual(a.inserted, 1);
  const b = sidb.importManualItems(shop.id, ['777000111']);
  assert.strictEqual(b.inserted, 0, '同一 (shop_id, store_key, item_id) 再贴 = 覆盖更新');
  assert.strictEqual(b.updated, 1);
  assert.strictEqual(itemsOf('777000111').length, 1);
  const c = sidb.importManualItems(shop.id, ['', '   ', '777000333']);
  assert.strictEqual(c.skipped, 2, '空ID / 空白ID 要算 skipped 并回给界面，不能静默吞');
  assert.strictEqual(c.inserted, 1);
});

check('手贴导入：点名到不存在的店 ⇒ ok=false 且一行都不许落（点名是严格的，不静默落桶）', () => {
  reset();
  const r = sidb.importManualItems(999999, ['666000111', '666000222']);
  assert.strictEqual(r.ok, false, '下拉里选到的店已被删 ⇒ 必须报错，不能回落未登记桶');
  assert.ok(r.error && r.error.includes('999999'), '错误要带 id，界面说得清是哪一步');
  assert.strictEqual(sidb.listShopItems({}).total, 0, '失败时一行都不能落');
});

check('手贴导入：shopId=0（下拉里显式选的「未登记桶」）⇒ 落桶语义不变', () => {
  reset();
  const r = sidb.importManualItems(0, ['555000111']);
  assert.strictEqual(r.ok, true);
  const row = itemsOf('555000111')[0];
  assert.strictEqual(row.shopId, 0);
  assert.strictEqual(row.storeKey, '', '未登记桶也没有可展示的身份 ⇒ 归一名为空，不拿店名冒充');
  assert.strictEqual(row.source, 'manual');
});

// -------------------------------------------------------------------------- 全新库守卫（sk_shops 从未被建过）
//
// 「店铺商品」页的读链**只经本文件**（店铺域自己的 ensureShopSchema 只在 shop-handlers 各入口调用），
// 而本文件的读路径 LEFT JOIN sk_shops、匹配路径 SELECT ... FROM sk_shops —— 全新库第一站就是这一页时
// 直接报 `no such table: sk_shops`（2026-10-15 真实用户现场）。修法 = 每个入口先 ensureSchema()
// 把店铺域顺带拉起（表由 owner 建、DDL 只留一份）。
//
// ⭐ 夹具纪律：**先把表真的 DROP 掉**，不能只保证「表里没数据」—— 空表照样能 JOIN，断言会恒绿。

check('全新库：sk_shops 不存在时 listShopItems 不炸（自行建起来，返回空）', () => {
  reset();
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`DROP TABLE IF EXISTS sk_name_map`);
  const r = sidb.listShopItems({});
  assert.strictEqual(r.total, 0, '全新库列表应为空（能返回就说明没炸）');
  const t = dbGet(`SELECT name FROM sqlite_master WHERE type='table' AND name='sk_shops'`);
  assert.ok(t, '读一次就该把 sk_shops 建起来（否则下一次带证据的采集/读又会炸）');
});

check('全新库：带店铺证据的采集帧不炸，落未登记桶（此时没有店可认）', () => {
  reset();
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`DROP TABLE IF EXISTS sk_name_map`);
  const r = sidb.upsertShopItems(frame({ url: 'https://fresh.example.com/store/9' }, [item({ itemId: 'N1' })]));
  assert.strictEqual(r.inserted, 1);
  const row = sidb.listShopItems({ search: 'N1' }).rows[0];
  assert.strictEqual(row.shopId, 0, '全新库没有任何店 ⇒ 落未登记桶');
});

check('全新库：getShopItemRow 不炸（图片下载回填的单行读取走同一条 JOIN）', () => {
  reset();
  const ins = dbRun(`INSERT INTO pl_shop_items (shop_id, store_key, item_id, title) VALUES (0,'','N2','回填图')`);
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`DROP TABLE IF EXISTS sk_name_map`);
  const row = sidb.getShopItemRow(Number(ins.lastInsertRowid));
  assert.ok(row, '行还在就该读得到（sk_shops 缺失不能把这一行也带走）');
  assert.strictEqual(row.itemId, 'N2');
});

// -------------------------------------------------------------------------- 色图采纳（P4 §8.8）
//
// 落点与订单归款（autoAssignByMap）是同一条：ensureStyleByCode + ensureStyleColor +
// setImageStyleColor。这里钉住的是**只补空**的两条边界与"守卫不是一律跳过"的反向用例
// （少最后一条，前两条"跳过"会在任何实现下恒绿）。

const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const oil = require(path.join(ROOT, 'dist', 'electron', 'order-image-land.js'));
const { tableExists } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
odb.ensureOrderSchema();
pdb.ensureVariantSchema(); // 图片主数据（md_images）由它建；断言「色图没落进产品表的旧落点」要在同一张表上做对照
assert.strictEqual(tableExists('pl_images'), false, 'R1 之后只该有一张图片表（md_images）');

/** 色图用例的复位：识别池全清（款 / 款色 / 图互不共享；子表先删，别让外键挡住） */
const resetRecog = () => {
  for (const t of ['md_images', 'oi_style_colors', 'oi_style_fingerprints', 'oi_styles']) {
    dbRun(`DELETE FROM ${t}`);
  }
};

// 1×1 PNG（sniffImageFormat 只认文件头，故尾部再拼一段唯一尾巴即可得到"另一张图"：
//    不同内容指纹 + 仍然是合法图片头 —— 夹具要有**多张**图才能验"色→图 1:1"）。
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const imgBuf = (tag) => Buffer.concat([PNG_1PX, Buffer.from('//' + tag)]);

// ⭐ 夹具必须是**生产形状**：色图的 id 要经 `landOrderImageBytes` 这条**生产同一条**落库函数
// 拿到（写 md_images），而不是"手工插一行 md_images"。后者只复刻了"函数期望的形状"，
// 于是 handler 即便传回 pl_images 的 id，下面这些断言照样全绿 —— 审查 P0-1 就是这么漏掉的。
/** 落一张已入库的图（走生产同一条落库函数），返回 md_images 的 id */
const insertImg = (tag) =>
  oil.landOrderImageBytes(imgBuf(tag), {
    urlFingerprint: 'u-' + tag,
    sourceUrl: 'https://ae01.alicdn.com/' + tag + '.jpg',
  }).imageId;
/**
 * 这张图当前绑在哪个款色上（`null` = 没绑）。
 * R1：归属从「图行的 `style_color_id`」搬到「色行的 `image_id`」（1:1），所以反过来查色行。
 */
const styleColorOf = (imageId) => {
  const r = dbGet(`SELECT id FROM oi_style_colors WHERE image_id = ? LIMIT 1`, [imageId]);
  return r ? Number(r.id) : null;
};

check('色图采纳：新图绑到新色（bound=true；oi_style_colors.image_id 真落库）', () => {
  resetRecog();
  const img = insertImg('fp-a');
  const r = odb.adoptStyleColorImageByCode('STYLE-A', '黑', img);
  assert.deepStrictEqual(r, { bound: true });
  assert.ok(styleColorOf(img) > 0, '绑上后色行的 image_id 应有值（不能只返回 true 不写库）');
});

check('色图采纳只补空（图侧）：同一张图再绑任何色都不动它', () => {
  resetRecog();
  const img = insertImg('fp-b');
  assert.strictEqual(odb.adoptStyleColorImageByCode('STYLE-B', '黑', img).bound, true);
  const before = styleColorOf(img);
  const r2 = odb.adoptStyleColorImageByCode('STYLE-B', '白', img);
  assert.deepStrictEqual(r2, { bound: false, reason: 'image-bound' });
  assert.strictEqual(styleColorOf(img), before, '图侧已绑 ⇒ 不因第二次采纳改判');
});

check('色图采纳只补空（色侧）：目标色已有图时，后来者不换图', () => {
  resetRecog();
  const img1 = insertImg('fp-c1');
  const img2 = insertImg('fp-c2');
  assert.strictEqual(odb.adoptStyleColorImageByCode('STYLE-C', '黑', img1).bound, true);
  const before = styleColorOf(img1);
  const r2 = odb.adoptStyleColorImageByCode('STYLE-C', '黑', img2);
  assert.deepStrictEqual(r2, { bound: false, reason: 'color-bound' });
  assert.strictEqual(styleColorOf(img1), before, '色→图 1:1：先绑的那张不因第二张被换掉');
  assert.strictEqual(styleColorOf(img2), null, '没绑上的图不该留下半绑定状态');
});

check('色图采纳：换一个没绑过图的色照样绑得上（守卫不是"一律跳过"）', () => {
  resetRecog();
  const img1 = insertImg('fp-d1');
  const img2 = insertImg('fp-d2');
  odb.adoptStyleColorImageByCode('STYLE-D', '黑', img1);
  const r = odb.adoptStyleColorImageByCode('STYLE-D', '白', img2);
  assert.strictEqual(r.bound, true, '没绑过图的色必须能绑 —— 否则上面两条"跳过"会是恒绿');
  assert.notStrictEqual(styleColorOf(img2), styleColorOf(img1), '两个色各绑各的图');
});

check('色图采纳：空色名 / 空编码 / imageId=0 直接不绑（不抛、不留绑定）', () => {
  resetRecog();
  const img = insertImg('fp-e');
  assert.deepStrictEqual(odb.adoptStyleColorImageByCode('', '黑', img), { bound: false });
  assert.deepStrictEqual(odb.adoptStyleColorImageByCode('STYLE-E', '', img), { bound: false });
  assert.deepStrictEqual(odb.adoptStyleColorImageByCode('STYLE-E', '黑', 0), { bound: false });
  assert.strictEqual(styleColorOf(img), null, '无效入参不该留下任何绑定');
});

// ---- 下面三条钉的是「色图落在哪张表」以及由此成立的**按图找色闭环** ----
//
// 色图的全部价值 = 订单导入后能按图找到颜色（归类核对 / 拣货单 / 拿货单都走
// `oi_order_items.image_id → md_images.style_color_id`）。而"按图找色"的唯一入口是
// `order-download-image` 里的**内容指纹命中**（命中即复用那一行，连带它的 styleColorId）。
// 色图只要落错表（pl_images），这条查询就永远看不到它 ⇒ 闭环一次都不闭，而回执照样报 bound:true。
// 所以这里不能只验"adopt 返回什么"，必须验"落库函数把 id 落在哪张表 + 订单侧能不能命中"。

check('色图落点 = 唯一图片仓 md_images：生产落库函数返回的 id 在 md_images 里、指纹与字节一致', () => {
  resetRecog();
  const landed = oil.landOrderImageBytes(imgBuf('fp-land'), {
    urlFingerprint: 'u-land',
    sourceUrl: 'https://ae01.alicdn.com/land.jpg',
  });
  const row = dbGet(`SELECT fingerprint FROM md_images WHERE id = ?`, [landed.imageId]);
  assert.ok(row, '落库函数返回的 id 必须能在 md_images 查到 —— 落在别的表 = 按图找色永不命中');
  const fp = require('crypto').createHash('sha256').update(imgBuf('fp-land')).digest('hex');
  assert.strictEqual(row.fingerprint, fp, '内容指纹必须与字节一致（订单导入按它命中）');
  // R1：产品图与订单图共用这一张表（旧 `pl_images` 已退役），所以"落错表"这个分叉不可能再出现
  assert.strictEqual(tableExists('pl_images'), false, '不该再有第二张图片表');
});

check('按图找色闭环：色图采纳后，订单导入**同内容不同 URL** 的图复用同一行并继承款色', () => {
  resetRecog();
  // ① 采集侧：把色图采纳为 STYLE-CL / 黑 的绑定图
  const colorImg = oil.landOrderImageBytes(imgBuf('fp-closure'), {
    urlFingerprint: 'u-shop-color',
    sourceUrl: 'https://ae01.alicdn.com/shop-color.jpg',
  });
  assert.strictEqual(odb.adoptStyleColorImageByCode('STYLE-CL', '黑', colorImg.imageId).bound, true);
  const boundSc = styleColorOf(colorImg.imageId);
  assert.ok(boundSc > 0, '色图自己要先绑上');
  // ② 订单侧：同一张图、另一个 URL（带签名参数）—— 走的是同一条落库函数
  const orderImg = oil.landOrderImageBytes(imgBuf('fp-closure'), {
    urlFingerprint: 'u-order-xyz',
    sourceUrl: 'https://ae01.alicdn.com/order.jpg?sign=abc',
  });
  assert.strictEqual(orderImg.reused, true, '同图不同 URL 必须复用既有行（不再落新行）');
  assert.strictEqual(orderImg.imageId, colorImg.imageId, '复用的是色图那一行');
  assert.strictEqual(styleColorOf(orderImg.imageId), boundSc, '订单按图拿到的那一行必须带着款色 —— 这就是按图找色');
});

check('反例：不存在的 imageId 给色图采纳 ⇒ 不绑成功，且不产生任何绑定', () => {
  resetRecog();
  const snapshot = () => dbGet(`SELECT COUNT(*) AS n, COALESCE(SUM(image_id), 0) AS s FROM oi_style_colors`);
  const before = snapshot();
  const r = odb.adoptStyleColorImageByCode('STYLE-NEG', '黑', 999999);
  assert.strictEqual(r.bound, false, '库里没有这张图 ⇒ 绝不能报成功');
  assert.deepStrictEqual(snapshot(), before, '没绑上就不许留下半个款色行/绑定');
});

// -------------------------------------------------------------------------- 老库迁移（店铺地址两列，已退役）
//
// **本段「建老形状旧库 → 跑 ensureShopSchema」的用例已随「未正式发布、无存量库」退役（2026-10-30）**：
// `electron/shop-db.ts` 里整表合并与地址两列（`platform_shop_id` / `shop_url` / `shop_url_raw`）的
// 补列 + 回填步骤都已删除（见该文件头「迁移（shop.main）」段）。现在 `SCHEMA` 把新库一次建到当前
// 形状，对老形状**不再承诺升级** —— 留着旧夹具等于测一个不存在的分支，而且它会在
// `uq_sk_shops_email` 索引上先撞 `no such column: email`（红得莫名其妙，不是它想验的东西）。
// 地址两列的**当前语义**（匹配键 vs 可打开原文 / 裸域名补 https / 清空 / 读取面回落）由前面那组
// URL 用例覆盖；补列机制本身由 `shop:smoke` 的 `shop.columns` 用例覆盖。

// -------------------------------------------------------------------------- 存量回填（尺码归一 v1）
//
// 「迁移只做一次」在本仓有前科：凡是靠"建旧形状的库 → 跑迁移"的用例，回填都在进分支那一次完成，
// 之后断言"没被改写"必然恒绿。本域的迁移是**版本化**的
// （`migrate('shop-item.main', …)`），所以夹具能直接造出"数据已在、版本未记"的形状 ——
// 这比造老表结构更贴近真实升级路径（老库就是"有数据、没这个版本的记录"）。

function staleSkuDb(rows) {
  closeDb();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-sku-size-backfill-'));
  initDb(path.join(d, 'stale.db'));
  sidb.ensureShopItemSchema(); // 建表 + 首次迁移（空表上跑，等于把版本记成 1）
  for (const r of rows) {
    dbRun(
      `INSERT INTO pl_shop_items (shop_id, store_key, item_id, sku_json, scraped_at, created_at, updated_at)
       VALUES (0, '', ?, ?, ?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')`,
      [r.itemId, JSON.stringify(r.skus), r.scrapedAt],
    );
  }
  // 模拟"升级前的老库"：数据已经在，但这条迁移从没跑过
  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'shop-item.main'`);
  sidb.ensureShopItemSchema();
  const read = (itemId) => dbGet(`SELECT sku_json, scraped_at, updated_at FROM pl_shop_items WHERE item_id = ?`, [itemId]);
  return { read, versions: () => dbGet(`SELECT version FROM sk_schema_migrations WHERE key = 'shop-item.main'`) };
}

check('存量回填：已落库的脏尺码一次校正；**不动抓取时间与更新时间**（不是重采、也不是人改过）', () => {
  const db = staleSkuDb([
    {
      itemId: 'OLD1',
      scrapedAt: 1750000000000,
      skus: [
        { color: 'printing 04', size: 'XS（old）', price: '', imageUrl: 'https://ae01.alicdn.com/kf/Sa.jpg' },
        { color: 'printing 04', size: 'Asian size XXXL', price: '', imageUrl: 'https://ae01.alicdn.com/kf/Sa.jpg' },
        { color: 'printing 05', size: 'XL 60-65kg', price: '', imageUrl: '' },
        { color: 'printing 05', size: '70B', price: '', imageUrl: '' },
      ],
    },
    // 损坏的历史值：解析不了必须原样留着（静默清成 [] = 删数据）
    { itemId: 'OLD2', scrapedAt: 1, skus: [{ color: 'x', size: 'M' }] },
  ]);
  dbRun(`UPDATE pl_shop_items SET sku_json = 'not-json' WHERE item_id = 'OLD2'`);

  const row = db.read('OLD1');
  const sizes = JSON.parse(row.sku_json).map((s) => s.size);
  assert.deepStrictEqual(sizes, ['XS', 'XXXL', 'XL', '70B'], '三类修饰都归一到干净的码，罕见的 70B 不动');
  assert.strictEqual(
    JSON.parse(row.sku_json)[0].imageUrl,
    'https://ae01.alicdn.com/kf/Sa.jpg',
    '重申写 sku_json 时其他字段必须原样带回（漏传 = 静默清空色图）',
  );
  assert.strictEqual(Number(row.scraped_at), 1750000000000, 'scraped_at 不许动（"最近采集"状态条靠它说话）');
  assert.strictEqual(row.updated_at, '2020-01-01 00:00:00', 'updated_at 也不许动（这是口径修正，不是人改过）');
  assert.strictEqual(db.read('OLD2').sku_json, 'not-json', '解析不了的行原样保留');
  // 断言「版本已记」这个**性质**而不是具体数字：本域迁移是版本化追加的，写死 1
  // 会让每加一个版本这两条用例都假红（"某一轮测试总数"同理，不是常量）。
  assert.ok(Number(db.versions().version) >= 1, '回填后版本必须已记（否则下次进来又跑一遍）');
});

check('存量回填只做一次：版本已记 ⇒ 之后落进来的脏值不再被自动改写', () => {
  const db = staleSkuDb([{ itemId: 'OLD3', scrapedAt: 5, skus: [{ color: 'a', size: 'L 50-60kg' }] }]);
  assert.strictEqual(JSON.parse(db.read('OLD3').sku_json)[0].size, 'L', '前提：第一遍确实回填了');
  // 再塞一条脏值（模拟"迁移已跑过之后，库里又有了脏数据"—— 只可能来自损坏或人工写入）
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, sku_json, scraped_at)
     VALUES (0, '', 'OLD4', ?, 6)`,
    [JSON.stringify([{ color: 'a', size: 'M 40-50kg' }])],
  );
  sidb.ensureShopItemSchema(); // 版本已记 ⇒ 这些迁移都不该再跑
  assert.strictEqual(
    JSON.parse(db.read('OLD4').sku_json)[0].size,
    'M 40-50kg',
    '版本已记的库不许再回填 —— 否则每次打开页面都在悄悄改库里的值',
  );
  assert.ok(Number(db.versions().version) >= 1, '版本仍在（没被谁重置成 0）');
});

// -------------------------------------------------------------------------- 收尾

closeDb();
console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
