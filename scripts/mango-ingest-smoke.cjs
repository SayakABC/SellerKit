// 芒果订单入库全链路冒烟（M1 / T1-7）：**从扩展推来的那一帧**一路走到 `oi_orders` / `oi_order_items`
// / `md_images` / `sk_sync_log`，判据全落在库上，不看中间变量。
//
//   npm run mango:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/mango-ingest-smoke.cjs
//
// 为什么不用 vitest：这条链路的每一环都压着 better-sqlite3（按 Electron 的 Node ABI 编译），
// 与 order-db / ae-db / shop-db 一致，DB 层统一走 Electron 冒烟。
//
// 为什么必须有这一个冒烟（纯函数层已由 `tests/mangoIngest.spec.ts` 覆盖了映射）：
// 映射对 ≠ 落库对。这一层真正会**静默错**的是四件只有连库才看得见的事：
//   ① 帧里的四列（`pay_time` / `shop_auth_id` / `deal_deadline` / `timeout_at`）有没有真的写进去
//      —— 少写一列，界面上的倒计时/时效风险就永远是空的，而没有任何报错；
//   ② 行上的 `variant_key` 有没有带上**图键**（色名塌陷的唯一判别证据）。键塌了，图案会绑到
//      同链接的另一个色上，且订单本身看起来完全正常；
//   ③ 重推一帧会不会翻倍（扩展重试是常态：页面停留、闹钟重跑）—— 翻倍的话"今天 8 单"会变成 16 单；
//   ④ **抓 0 条**与**今天没单**能不能分开。两者在订单表里都只是"没有新行"，唯一能分开的地方
//      就是 `sk_sync_log` 有没有留痕、留了什么 reason。
//
// 网络：图片下载被打了桩（`http-client.downloadFile`），本冒烟**不联网**、不需要凭据。
//      桩按 URL 生成不同字节 ⇒ 内容指纹不同、`md_images` 正常落多行；同一 URL 第二次同步
//      会先被 URL 指纹命中，连桩都不会被调用（这正是幂等用例要断言的）。
// 磁盘：库与图片都落在临时目录（`app.setPath('userData', …)`），不碰真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mango-ingest-smoke-'));

// ⚠️ 必须在任何业务模块之前改 userData：`IMAGE_DIR()` 每次都读 `app.getPath('userData')`，
// 落图是真的写文件 —— 不改的话会往用户的真实图库里灌测试图。
const { app } = require('electron');
app.setPath('userData', tmpDir);

// 真实 HTTP 端到端（T1-3 的判据是"curl 打到 /mango/ingest 返回 {ok:true}，错 token 返回 401"）。
// 端口/token 都是**模块加载时**从环境变量读的，所以必须赶在 require ae-receiver 之前设好。
const http = require('http');
const HTTP_PORT = 46200 + Math.floor(Math.random() * 700);
const HTTP_TOKEN = 'mango-smoke-token';
process.env.AE_RECEIVER_PORT = String(HTTP_PORT);
process.env.AE_RECEIVER_TOKEN = HTTP_TOKEN;

// ⚠️ 下载桩必须在 require `order-image-land` **之前**打：
// 它在模块加载时 `const { downloadFile } = require('./http-client')` 就把函数抓走了，
// 之后再改 `http-client.downloadFile` 对它无效（这个坑踩过一次：桩"没生效"，冒烟真的联网下载了）。
const httpClient = require(path.join(ROOT, 'dist', 'electron', 'http-client.js'));
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const downloadCalls = [];
httpClient.downloadFile = async (url, destPath) => {
  downloadCalls.push(String(url));
  // 字节里混入 URL ⇒ 不同图有不同内容指纹（否则同内容会被两级去重折成一行，测不出"两张图"）
  const body = Buffer.concat([PNG_HEAD, Buffer.from(String(url), 'utf8')]);
  fs.writeFileSync(destPath, body);
  return { ok: true, status: 200, size: body.length };
};

const { initDb, closeDb, dbRun, dbQuery, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const orderDb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const shopDb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const mangoSync = require(path.join(ROOT, 'dist', 'electron', 'mango-sync.js'));
const aeReceiver = require(path.join(ROOT, 'dist', 'electron', 'ae-receiver.js'));
const { imageKeyOf } = require(path.join(ROOT, 'dist', 'electron', 'podImageKey.js'));

const FIXTURE = require(path.join(
  ROOT,
  '..', 'SellerKitExtensions', 'tests', 'fixtures', 'mango-search.sample.json',
));

let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : String(err)}`);
  }
}
function section(text) {
  console.log(`\n${text}`);
}

// ───────────────────────────────────────────────────────── 工具
/** 深拷贝一帧（用例之间互不污染） */
function frameOf(index) {
  return JSON.parse(JSON.stringify(FIXTURE.data.list[index]));
}
/** 造一帧扩展风格的 payload（`source` 里的统计是扩展的实际上报位置） */
function payload(orders, src) {
  return {
    schema: 'mango-order/v1',
    orders,
    collectedAt: new Date().toISOString(),
    source: {
      pageUrl: 'https://www.mangoerp.com/erp/order/list',
      apiUrl: 'https://www.mangoerp.com/erp/order/data/search.json',
      phase: 'order',
      status: 'normal',
      totalItems: orders.length,
      fetched: orders.length,
      partial: false,
      stopReason: '',
      ...(src || {}),
    },
  };
}
const DTFMT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function orderRow(orderNo) {
  return dbGet(`SELECT * FROM oi_orders WHERE order_no = ?`, [orderNo]);
}
function itemRows(orderNo) {
  return dbQuery(
    `SELECT i.* FROM oi_order_items i JOIN oi_orders o ON o.id = i.order_id
      WHERE o.order_no = ? ORDER BY i.id`,
    [orderNo],
  );
}
function lastLog() {
  return dbGet(`SELECT * FROM sk_sync_log WHERE kind = 'mango' ORDER BY id DESC LIMIT 1`);
}
function logCount() {
  return Number(dbGet(`SELECT COUNT(*) AS n FROM sk_sync_log`).n);
}
function mdImageCount() {
  return Number(dbGet(`SELECT COUNT(*) AS n FROM md_images`).n);
}
function orderCount() {
  return Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n);
}

// ───────────────────────────────────────────── HTTP 客户端（loopback，不走系统代理）
function request(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(data.length);
    }
    if (token !== undefined) headers['X-Ae-Token'] = token;
    const req = http.request(
      { host: '127.0.0.1', port: HTTP_PORT, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}
/** 等接收器真的在 listen：`startAeReceiver()` 是同步返回的，bind 是异步的 */
async function waitReceiverReady(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await request('GET', '/ae/ping', null);
      if (r.status === 200) return true;
    } catch {
      /* 还没起来，接着试 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

initDb(path.join(tmpDir, 'mango-smoke.db'));

(async () => {
  // ===================================================================================
  // 一、真实帧（夹具＝2026-11-01 抓包原文）走完全链路
  // ===================================================================================
  section('[1] 真实帧入库：四列齐 / 变体键含图键 / 图落地 / 日志留痕');

  const orders = [frameOf(0), frameOf(1)];
  const no0 = String(orders[0].orderId);
  const no1 = String(orders[1].orderId);
  const img0 = imageKeyOf(orders[0].orderItemList[0].productImgUrl);
  let firstResult = null;

  await check('两单全部入库（fetched / total / inserted 都对得上）', async () => {
    firstResult = await mangoSync.ingestMangoOrders(payload(orders));
    assert.strictEqual(firstResult.ok, true, `ok 应为 true，实际回执：${JSON.stringify(firstResult)}`);
    assert.strictEqual(firstResult.fetched, 2);
    assert.strictEqual(firstResult.totalItems, 2);
    assert.strictEqual(firstResult.inserted, 2, '两单都该是新插入');
    assert.strictEqual(firstResult.updated, 0);
    assert.strictEqual(firstResult.skipped, 0);
    assert.strictEqual(orderCount(), 2);
  });

  await check('订单级四列都写进去了（不是 DEFAULT 的空串）', async () => {
    // 两单的实付不同（127.48 / 94.07）—— 用各自的期望值，别把第一单的数当通例
    const expectAmount = new Map([[no0, 12748], [no1, 9407]]);
    for (const no of [no0, no1]) {
      const r = orderRow(no);
      assert.ok(r, `订单 ${no} 不在库里`);
      for (const col of ['pay_time', 'deal_deadline', 'timeout_at']) {
        assert.ok(
          DTFMT.test(String(r[col] ?? '')),
          `${no} 的 ${col} 不是 yyyy-mm-dd hh:mm:ss：${JSON.stringify(r[col])}`,
        );
      }
      assert.strictEqual(String(r.shop_auth_id), '32958002', `${no} 的 shop_auth_id 没落库`);
      assert.strictEqual(String(r.source), 'collect', '采集来的一律 source=collect');
      assert.strictEqual(String(r.biz_status), '等待卖家发货', '状态要存芒果中文原文');
      assert.strictEqual(Number(r.amount_cents), expectAmount.get(no), `${no} 的实付分不对`);
    }
  });

  await check('明细落 item_id / sku_code / 带图键的 variant_key', async () => {
    const rows = itemRows(no0);
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(String(r.item_id), '1005012742360018', '商品ID 必须有独立列');
    assert.strictEqual(String(r.sku_code), '12000059187655796', '平台 SKU 码要并列存');
    assert.strictEqual(String(r.color), '6');
    assert.strictEqual(String(r.size), 'M');
    const parts = String(r.variant_key).split('\u0000');
    assert.strictEqual(parts.length, 4, `变体键应有 4 段（含图键），实际：${JSON.stringify(r.variant_key)}`);
    assert.strictEqual(parts[3], img0, `第 4 段应是图键 ${img0}`);
    assert.strictEqual(Number(r.qty), 1);
  });

  await check('图真的落了盘并登记 md_images（行上的 image_id 指向它）', async () => {
    const r = itemRows(no0)[0];
    const id = Number(r.image_id);
    assert.ok(id > 0, `image_id 应为已落地的图片主键，实际 ${JSON.stringify(r.image_id)}`);
    const img = dbGet(`SELECT * FROM md_images WHERE id = ?`, [id]);
    assert.ok(img, `md_images 里没有 id=${id}`);
    assert.ok(
      fs.existsSync(String(img.local_path)),
      `图片文件不存在：${img.local_path}（userData 是否指到了临时目录？）`,
    );
    assert.strictEqual(firstResult.missingImage, 0, '两单的图都该下成功，不该有缺图计数');
    assert.deepStrictEqual(downloadCalls.length, 2, '两张不同的图各下一次');
  });

  await check('sk_sync_log 有且只有一行，计数与回执一致', async () => {
    assert.strictEqual(logCount(), 1, '一次同步 = 一条日志');
    const l = lastLog();
    assert.strictEqual(Number(l.fetched), 2);
    assert.strictEqual(Number(l.total_items), 2);
    assert.strictEqual(Number(l.inserted), 2);
    assert.strictEqual(Number(l.partial), 0);
    assert.strictEqual(String(l.reason), '', '一切正常时 reason 应为空（红条由它驱动）');
    const detail = JSON.parse(String(l.detail_json));
    assert.strictEqual(Number(detail.imageFetched), 2, 'detail 里要能看出"这次下了几张图"');
  });

  // ===================================================================================
  // 二、幂等：扩展重推同一帧是常态（页面停留 / 闹钟重跑）
  // ===================================================================================
  section('[2] 重推同一帧：行不翻倍、图不重复落盘');

  await check('重推 = 整单替换（updated=2、订单数不变、明细行数不变）', async () => {
    const before = { orders: orderCount(), items: itemRows(no0).length, imgs: mdImageCount() };
    const callsBefore = downloadCalls.length;
    const r = await mangoSync.ingestMangoOrders(payload(orders));
    assert.strictEqual(r.inserted, 0, '重推不该再算插入');
    assert.strictEqual(r.updated, 2, '重推应算更新');
    assert.strictEqual(orderCount(), before.orders);
    assert.strictEqual(itemRows(no0).length, before.items);
    assert.strictEqual(mdImageCount(), before.imgs, 'md_images 不该长出重复图（URL 指纹应先命中）');
    assert.strictEqual(
      downloadCalls.length, callsBefore,
      '同一张图第二次同步连下载都不该发生（URL 指纹命中就返回）',
    );
    assert.strictEqual(logCount(), 2, '每次同步都要留一条日志（含重推）');
  });

  await check('重推后变体键不变（键是写入时算死的，不从别处现算）', async () => {
    const r = itemRows(no0)[0];
    assert.strictEqual(String(r.variant_key).split('\u0000')[3], img0);
  });

  // ===================================================================================
  // 三、红线 1：抓 0 条 ≠ 今天没单
  // ===================================================================================
  section('[3] 抓 0 条 vs 今天没单：唯一能分开的地方是日志');

  await check('orders 空但芒果说共 12 单 → ok=false，日志给出可行动的原因', async () => {
    const r = await mangoSync.ingestMangoOrders(
      payload([], { totalItems: 12, fetched: 0, status: 'normal' }),
    );
    assert.strictEqual(r.ok, false, '一单没抓到却是"成功"，界面就只能显示"今天没有订单"');
    assert.strictEqual(orderCount(), 2, '不该凭空写单');
    const l = lastLog();
    assert.strictEqual(Number(l.fetched), 0);
    assert.strictEqual(Number(l.total_items), 12, '芒果说的总数必须落库，否则事后无法对账');
    assert.ok(String(l.reason).length > 0, 'reason 是界面红条的唯一来源，不能空');
    assert.ok(
      String(l.reason).includes('12'),
      `reason 里要带上芒果说的总数，实际：${String(l.reason)}`,
    );
  });

  await check('orders 空且芒果也说 0 单 → ok=true，但**照样留痕**', async () => {
    const before = logCount();
    const r = await mangoSync.ingestMangoOrders(payload([], { totalItems: 0, fetched: 0 }));
    assert.strictEqual(r.ok, true, '真的没单不该报错');
    assert.strictEqual(logCount(), before + 1, '抓 0 条也要有一条日志（否则与登录过期无法区分）');
    assert.ok(String(lastLog().reason).length > 0, '"今天没单"与"没抓到"要各留各的说法');
  });

  // ===================================================================================
  // 四、跳过必须带原因 / 行数不缩水
  // ===================================================================================
  section('[4] 坏帧与残帧：跳过带原因 + 残帧不删历史行');

  await check('缺 orderId 的帧 → skipped 计数 + skips 里有原因', async () => {
    const bad = frameOf(0);
    bad.orderId = '';
    const r = await mangoSync.ingestMangoOrders(payload([bad]));
    assert.strictEqual(r.skipped, 1, '被挡的帧要计数');
    assert.strictEqual(r.inserted + r.updated, 0);
    assert.strictEqual(r.skips.length, 1, '跳过必须逐条进 skips（只回数字等于什么都没说）');
    assert.ok(String(r.skips[0].reason).length > 0, `skips 里必须有原因：${JSON.stringify(r.skips)}`);
  });

  await check('先 2 行、再推只 1 行的同单 → 拒绝覆盖，2 行原样保留', async () => {
    const two = frameOf(0);
    two.orderId = 'C-SHRINK';
    const base = two.orderItemList[0];
    two.orderItemList = [
      { ...base, skuCode: 'SHRINK-A', attrMap: { ...base.attrMap, Size: 'M' } },
      { ...base, skuCode: 'SHRINK-B', attrMap: { ...base.attrMap, Size: 'L' } },
    ];
    const r1 = await mangoSync.ingestMangoOrders(payload([two]));
    assert.strictEqual(r1.inserted, 1);
    assert.strictEqual(itemRows('C-SHRINK').length, 2);

    const cut = JSON.parse(JSON.stringify(two));
    cut.orderItemList = [cut.orderItemList[0]];
    const r2 = await mangoSync.ingestMangoOrders(payload([cut]));
    assert.strictEqual(
      itemRows('C-SHRINK').length, 2,
      '残帧把历史行删掉了 —— 这是"静默丢件"，比报错严重得多',
    );
    assert.strictEqual(r2.skipped, 1, '拒绝覆盖要计数');
    assert.ok(
      String(r2.skips[0] && r2.skips[0].reason).includes('行'),
      `原因要说清是行数问题：${JSON.stringify(r2.skips)}`,
    );
  });

  // ===================================================================================
  // 五、店铺 authId 学习（T1-4）：名字只用于第一次，之后靠 authId
  // ===================================================================================
  section('[5] 店铺认亲：名字命中一次 → 学到 authId → 改名后仍认得出');

  await check('没建店之前：两单落未登记桶（订单照进，shop 留芒果原文）', async () => {
    assert.strictEqual(
      firstResult.shopUnmatched, 2,
      `没有店铺登记时该报未登记，实际：${JSON.stringify(firstResult.shopUnmatched)}`,
    );
    assert.strictEqual(
      String(orderRow(no0).shop), '十店',
      '未命中时必须保留芒果原文，否则「店铺归一」页看不到这家没登记的店',
    );
  });

  await check('建同名店后名字命中：未登记归零 + authId 补写到店铺行', async () => {
    const shop = shopDb.upsertShop({ id: 0, name: '十店', platform: 'ae', status: 'active' });
    assert.ok(shop.id > 0);

    const r = await mangoSync.ingestMangoOrders(payload(orders));
    assert.strictEqual(r.updated, 2);
    assert.strictEqual(
      r.shopUnmatched, 0,
      `同名店已存在却仍算未登记 —— 名字匹配没生效（按到的名字：${String(orderRow(no0).shop)}）`,
    );
    assert.strictEqual(
      String(dbGet(`SELECT erp_shop_id FROM sk_shops WHERE id = ?`, [shop.id]).erp_shop_id),
      '32958002',
      'authId 应被补写到店铺行（下次不再靠名字）',
    );
    assert.ok(
      r.learned.some((s) => String(s).includes('32958002')),
      `learned 里要记下这次学到的绑定：${JSON.stringify(r.learned)}`,
    );
  });

  await check('店铺改名后仍然认得出（证明走的是 authId 而不是名字）', async () => {
    const shop = dbGet(`SELECT id FROM sk_shops WHERE name = '十店'`);
    shopDb.upsertShop({ id: Number(shop.id), name: '十号店', platform: 'ae', status: 'active' });
    const r = await mangoSync.ingestMangoOrders(payload(orders));
    assert.strictEqual(r.updated, 2);
    assert.strictEqual(
      r.shopUnmatched, 0,
      '芒果里还叫"十店"、库里已改名成"十号店" —— 掉进未登记桶说明匹配还在按名字',
    );
    assert.strictEqual(
      String(orderRow(no0).shop), '十号店',
      'authId 命中就该写库里的规范名（订单上的店名要跟着店铺走，不跟芒果 alias 走）',
    );
    assert.deepStrictEqual(r.learned, [], '已经绑过就不该再"学到"一次（learned 空 = 走的是 erp 路径）');
  });

  // ===================================================================================
  // 六、色名塌陷：唯一判别证据是图 URL
  // ===================================================================================
  section('[6] 同链接同色名不同图：variant_key 必须分得开');

  await check('两行同名色（Picture color）靠图键分开；同图不同码仍是同一个变体', async () => {
    const o = frameOf(0);
    o.orderId = 'C-COLLAPSE';
    const base = o.orderItemList[0];
    const mk = (sku, size, url) => ({
      ...base,
      skuCode: sku,
      attrMap: { 'Ships From': 'China Mainland', Size: size, Color: 'Picture color' },
      productImgUrl: url,
      productBigImgUrl: url,
    });
    const urlA = 'https://ae-pic-a1.aliexpress-media.com/kf/Abc111aaa.jpg';
    const urlB = 'https://ae-pic-a1.aliexpress-media.com/kf/Zzz999bbb.jpg';
    o.orderItemList = [
      mk('COL-A-M', 'M', urlA),
      mk('COL-B-M', 'M', urlB),
      mk('COL-A-L', 'L', urlA),
    ];
    await mangoSync.ingestMangoOrders(payload([o]));

    const rows = itemRows('C-COLLAPSE');
    assert.strictEqual(rows.length, 3, '三行都是不同 skuCode，都不该被帧内去重合并');
    const keys = rows.map((r) => String(r.variant_key));
    assert.ok(keys.every((k) => k.split('\u0000').length === 4), `每行都该带图键：${JSON.stringify(keys)}`);
    assert.strictEqual(
      new Set(keys).size, 2,
      `同色名不同图必须分成两个变体，实际只有 ${new Set(keys).size} 种：${JSON.stringify(keys)}`,
    );
    assert.strictEqual(keys[0], keys[2], '同一张图 + 同色名 ⇒ 同一个变体（差别只在 size 列）');
    assert.notStrictEqual(keys[0], keys[1], '图不同 ⇒ 变体必须不同（否则图案会印到另一个色上）');
  });

  // ===================================================================================
  // 七、真实 HTTP：扩展打的就是这条路由（T1-3 的判据）
  // ===================================================================================
  section('[7] POST /mango/ingest（真发 HTTP，不经函数直调）');

  await check('接收器起得来（ping 200）', async () => {
    assert.strictEqual(aeReceiver.startAeReceiver(), true, 'startAeReceiver 应返回 true');
    assert.ok(await waitReceiverReady(), `接收器没能在 127.0.0.1:${HTTP_PORT} 上监听`);
  });

  await check('错 token → 401（防线没被芒果这条新路由绕开）', async () => {
    const r = await request('POST', '/mango/ingest', payload([frameOf(0)]), 'wrong-token');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json && r.json.ok, false, `回执应是 ok:false：${r.raw}`);
  });

  await check('schema 不对 → 400（老扩展推错帧不会被当成订单吞掉）', async () => {
    const r = await request('POST', '/mango/ingest', { schema: 'ae-order/v1', orders: [] }, HTTP_TOKEN);
    assert.strictEqual(r.status, 400, `实际 ${r.status}：${r.raw}`);
    assert.ok(String(r.json && r.json.error).includes('schema'), `错误要说清是 schema：${r.raw}`);
  });

  await check('真实帧 → 200 {ok:true}，且订单真的落库', async () => {
    const o = frameOf(0);
    o.orderId = 'C-HTTP';
    const before = orderCount();
    const r = await request('POST', '/mango/ingest', payload([o]), HTTP_TOKEN);
    assert.strictEqual(r.status, 200, `实际 ${r.status}：${r.raw}`);
    assert.strictEqual(r.json.ok, true, `回执：${r.raw}`);
    assert.strictEqual(r.json.inserted, 1, `回执：${r.raw}`);
    assert.strictEqual(orderCount(), before + 1);
    assert.ok(orderRow('C-HTTP'), 'HTTP 进来的单没落库');
  });

  await check('抓 0 条但芒果说有单 → HTTP 200 但体内 ok:false（扩展要能看到"没抓到"）', async () => {
    const r = await request(
      'POST', '/mango/ingest', payload([], { totalItems: 7, fetched: 0 }), HTTP_TOKEN,
    );
    assert.strictEqual(r.status, 200, '这不是 HTTP 错误（帧是合法的），是业务失败');
    assert.strictEqual(r.json.ok, false, `回执：${r.raw}`);
    assert.strictEqual(r.json.totalItems, 7);
  });

  // ===================================================================================
  // 收尾
  // ===================================================================================
  console.log('');
  if (failed > 0) {
    console.log(`\u2717 芒果入库冒烟失败：${failed} 项`);
    closeDb();
    process.exit(1);
  }
  console.log(`\u2713 芒果入库冒烟全部通过（${passed} 项）`);
  closeDb();
  // 显式退出：不写的话进程靠 Electron 在无 GUI 环境里崩退（退出码是 SIGTRAP），看起来像冒烟失败。
  process.exit(0);
})();
