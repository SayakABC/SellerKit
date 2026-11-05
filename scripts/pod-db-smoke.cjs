// 「图案」域冒烟（DB 层，不启动界面）。
//
//   npm run pod:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/pod-db-smoke.cjs
//
// 为什么单独一个：本域的错误全部是**静默**的 —— 变体键拼错一点，560 个槽位与订单行
// 一个都匹配不上、而两边各自看起来都正常；到货写两次，账上多一批货、看板上的余量却完全合理。
// 这些都不会抛异常、也不会在界面上露馅，只能靠这里的断言。
//
// 覆盖的不变量：
//   · 槽位从 SKU JSON 摊出来，**键与 `variantKey.ts` 逐字节同构**（3 段 / 塌陷 4 段）；
//   · 塌陷链接（同色多名图）**必须带图键**，否则 5~12 个图案被并成 1 个（静默错印）；
//   · 绑定台账 UPSERT 幂等 / 解绑 / 空键拒绝 / 上限 200；
//   · 图案编码唯一、`undefined` ≠ `''`（不改 vs 清空）；
//   · 建批**不加余量**、到货**幂等**；
//   · 印花 FIFO 分批次、不足**整批拒绝**（不扣一半）；
//   · 盘点写带符号流水、余量视图随流水变；
//   · 绑定索引只含"图案仍存在"的绑定。
// 库文件落在临时目录，不污染真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-pod-smoke-'));

const { initDb, closeDb, dbGet, dbQuery, dbRun } = require(
  path.join(ROOT, 'dist', 'electron', 'db.js')
);
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const sidb = require(path.join(ROOT, 'dist', 'electron', 'shop-item-db.js'));
const pod = require(path.join(ROOT, 'dist', 'electron', 'pod-db.js'));
const vk = require(path.join(ROOT, 'dist', 'electron', 'variantKey.js'));
const pik = require(path.join(ROOT, 'dist', 'electron', 'podImageKey.js'));

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
pod.ensurePodSchema();

const shop = sdb.upsertShop({
  id: 0,
  platform: 'aliexpress',
  name: '店 甲',
  platformShopId: '',
  site: '',
  status: 'active',
  openedAt: '',
  note: '',
});
const shopKey = String(
  dbGet(`SELECT COALESCE(NULLIF(trim(name_key),''), name) AS k FROM sk_shops WHERE id = ?`, [
    shop.id,
  ]).k
);

// 采集快照（槽位的**唯一**来源）：`skus` 里的 color + imageUrl 决定槽位与图键。
sidb.upsertShopItems(
  {
    schema: 'ae-shop-item/v1',
    store: {},
    items: [
      // 常规：一个色一张图
      {
        itemId: 'IT-1',
        title: '上衣',
        skus: [
          { color: '黑', size: 'L', price: '9.9', imageUrl: 'https://ae01.alicdn.com/kf/S1.jpg' },
        ],
      },
      // 两个色各一张图 → 两个槽位，都不算塌陷
      {
        itemId: 'IT-2',
        title: '裤子',
        skus: [
          { color: '黑', size: 'M', price: '9.9', imageUrl: 'https://ae01.alicdn.com/kf/S2.jpg' },
          { color: '白', size: 'M', price: '9.9', imageUrl: 'https://ae01.alicdn.com/kf/S3.jpg' },
        ],
      },
      // **塌陷**：同一色名「Picture color」下挂两张不同的图 → 应拆成两个 4 段键
      {
        itemId: 'IT-3',
        title: '印花外套',
        skus: [
          {
            color: 'Picture color',
            size: 'M',
            price: '9.9',
            imageUrl: 'https://ae01.alicdn.com/kf/S4.jpg',
          },
          {
            color: 'Picture color',
            size: 'L',
            price: '9.9',
            imageUrl: 'https://ae01.alicdn.com/kf/S5.jpg',
          },
        ],
      },
      // 报表没给色（只有尺码）→ 色段空串，仍是合法槽位
      {
        itemId: 'IT-4',
        title: '无色的款',
        skus: [{ size: 'XL', price: '9.9', imageUrl: 'https://ae01.alicdn.com/kf/S6.jpg' }],
      },
    ],
  },
  { pinnedShopId: shop.id }
);

console.log('\n[1] schema 自检：八表两视图齐');

check('podSchemaReport 的八张表 / 两条视图全部存在（缺表就问"迁移没跑到"，不是"功能没做"）', () => {
  const r = pod.podSchemaReport();
  assert.deepStrictEqual(r.missing, [], `缺：${r.missing.join(',')}`);
  assert.deepStrictEqual(
    r.tables.sort(),
    [
      'pod_pattern_images',
      'pod_pattern_merge_items',
      'pod_pattern_merges',
      'pod_patterns',
      'pod_sheet_batches',
      'pod_sheet_ledger',
      // 2026-11-03：款色 → 图案（认图案的身份；原来的"图指纹"退成兜底）
      'pod_style_color_patterns',
      'pod_variant_patterns',
    ].sort()
  );
  assert.deepStrictEqual(r.views.sort(), ['pod_binding_worklist', 'pod_pattern_balance'].sort());
});

console.log('\n[2] 工作清单：槽位摊平 + 键同构 + 塌陷判定');

check('槽位数 = SKU 组合数（1 + 2 + 2 + 1 = 6），塌陷 2 个', () => {
  const st = pod.podWorklistStats();
  assert.strictEqual(st.total, 6, `应 6 个槽位，实为 ${st.total}`);
  assert.strictEqual(st.collapsed, 2, `塌陷应 2 个，实为 ${st.collapsed}`);
  assert.strictEqual(st.bound, 0);
  assert.strictEqual(st.unbound, 6);
});

check(
  '常规槽位的键 == variantKeyOf(店铺 name_key, 商品ID, 色名) —— **逐字节同构**（否则订单永远匹配不上）',
  () => {
    const rows = pod.podWorklist({ filter: 'all', pageSize: 200 }).rows;
    const it1 = rows.find((r) => r.itemId === 'IT-1');
    assert.ok(it1, 'IT-1 的槽位应存在');
    const expect = vk.variantKeyOf({ shopKey, itemKey: 'IT-1', colorKey: '黑' });
    assert.strictEqual(it1.variantKey, expect, '键与 variantKeyOf 不一致');
    assert.strictEqual(it1.imageKey, '', '非塌陷槽位不该有图键');
    assert.strictEqual(vk.splitVariantKey(it1.variantKey).imageKey, '');
  }
);

check('塌陷槽位：4 段键，图键 == imageKeyOf(色图 url)，且两个槽位**不是同一个键**', () => {
  const rows = pod.podWorklist({ filter: 'collapsed', pageSize: 200 }).rows;
  assert.strictEqual(rows.length, 2, `塌陷槽位应 2 个，实为 ${rows.length}`);
  const keys = new Set(rows.map((r) => r.variantKey));
  assert.strictEqual(keys.size, 2, '两个塌陷槽位的键被并成了一个（静默错印的来源）');
  for (const r of rows) {
    assert.strictEqual(r.imgsInName, 2);
    assert.ok(r.imageKey, '塌陷槽位必须带图键');
    assert.strictEqual(r.imageKey, pik.imageKeyOf(r.imageUrl), '图键与 imageKeyOf 不一致');
    const parts = vk.splitVariantKey(r.variantKey);
    assert.strictEqual(parts.imageKey, r.imageKey);
    assert.strictEqual(parts.itemKey, 'IT-3');
    // 色段只做「剥不可见字符 + 折叠空白」，**不折大小写**（`Picture color` 归一后仍是它自己）
    assert.strictEqual(parts.colorKey, vk.variantColorKey(r.color));
  }
});

check(
  '视图带出 `image_url`（绑定台要能看见「同名色不同图」的差别，只给图键等于让人凭记忆挑）',
  () => {
    const rows = pod.podWorklist({ filter: 'all', pageSize: 200 }).rows;
    assert.ok(
      rows.every((r) => typeof r.imageUrl === 'string'),
      'imageUrl 字段不该缺'
    );
    assert.ok(
      rows.find((r) => r.itemId === 'IT-3').imageUrl.includes('/kf/S4.jpg') ||
        rows.find((r) => r.itemId === 'IT-3').imageUrl.includes('/kf/S5.jpg')
    );
  }
);

check('无色名槽位照样成键（色段为空串），不会被丢掉', () => {
  const rows = pod.podWorklist({ filter: 'all', pageSize: 200 }).rows;
  const it4 = rows.find((r) => r.itemId === 'IT-4');
  assert.ok(it4, '无色槽位应存在');
  assert.strictEqual(it4.color, '');
  assert.strictEqual(vk.splitVariantKey(it4.variantKey).colorKey, '');
});

console.log('\n[3] 绑定台账：UPSERT 幂等 / 解绑 / 空键与上限');

const p1 = pod.podPatternCreate({
  code: 'P-1',
  name: '图案一',
  artworkImageId: 1,
  previewImageId: 2,
});
assert.ok(p1.id > 0 && p1.created);

check('绑一个槽位 → stats.bound 增加、清单回带图案编码', () => {
  const row = pod
    .podWorklist({ filter: 'unbound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  pod.podBindSlots({
    patternId: p1.id,
    slots: [{ variantKey: row.variantKey, imageKey: row.imageKey, skuCode: 'IT-1' }],
  });
  const after = pod
    .podWorklist({ filter: 'bound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  assert.ok(after, '绑定后应出现在 filter=bound 里');
  assert.strictEqual(after.patternId, p1.id);
  assert.strictEqual(after.patternCode, 'P-1');
  assert.strictEqual(pod.podWorklistStats().bound, 1);
});

check('同一键再绑一次是幂等（不抛主键冲突、不重复计数）', () => {
  const row = pod
    .podWorklist({ filter: 'bound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  const r = pod.podBindSlots({ patternId: p1.id, slots: [{ variantKey: row.variantKey }] });
  assert.strictEqual(r.bound, 1);
  assert.strictEqual(pod.podWorklistStats().bound, 1);
});

check('重绑到另一个图案 = 改判（ON CONFLICT UPDATE），不是新增第二条', () => {
  const p2 = pod.podPatternCreate({ code: 'P-2', name: '图案二' });
  const row = pod
    .podWorklist({ filter: 'bound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  pod.podBindSlots({ patternId: p2.id, slots: [{ variantKey: row.variantKey }] });
  const after = pod
    .podWorklist({ filter: 'bound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  assert.strictEqual(after.patternId, p2.id);
  assert.strictEqual(pod.podWorklistStats().bound, 1);
});

check('空键被拒绝（空串会与别的脏行撞成一条，界面表现为"绑了但订单还是没图案"）', () => {
  assert.throws(
    () => pod.podBindSlots({ patternId: p1.id, slots: [{ variantKey: '' }] }),
    /槽位键为空/
  );
});

check('一次超过 200 个被拒绝（`POD_BIND_MAX`）', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ variantKey: `k${i}` }));
  assert.throws(() => pod.podBindSlots({ patternId: p1.id, slots: many }), /最多绑定 200/);
});

check('解绑删除台账行；解绑不存在的键回 removed:0（幂等）', () => {
  const row = pod
    .podWorklist({ filter: 'bound', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-1');
  assert.strictEqual(pod.podUnbindSlots([row.variantKey]).removed, 1);
  assert.strictEqual(pod.podUnbindSlots([row.variantKey]).removed, 0);
  assert.strictEqual(pod.podWorklistStats().bound, 0);
});

console.log('\n[4] 图案主数据：编码唯一、undefined ≠ 空串');

check('图案编码重复被拒绝（唯一索引 + 人话报错）', () => {
  assert.throws(() => pod.podPatternCreate({ code: 'P-1', name: '重码' }), /编码|已存在/);
  assert.throws(() => pod.podPatternCreate({ code: '' }), /编码不能为空/);
});

check('更新只改传入的字段：只传 name 时图稿 id 保持原值', () => {
  const r = pod.podPatternUpdate({ id: p1.id, name: '改名了' });
  assert.ok(r.changed >= 0);
  const row = pod.podPatternList({}).find((p) => p.id === p1.id);
  assert.strictEqual(row.name, '改名了');
  assert.strictEqual(row.artworkImageId, 1, '没传的字段被清空了（undefined ≠ 0 的语义丢了）');
});

check('传空串 = 清空该字段（undefined 与空串必须能分开）', () => {
  pod.podPatternUpdate({ id: p1.id, name: '' });
  const row = pod.podPatternList({}).find((p) => p.id === p1.id);
  assert.strictEqual(row.name, '');
  assert.strictEqual(row.artworkImageId, 1);
});

check('图案清单带出余量（没报过单的图案余量 0，不因"还没买纸"从看板上消失）', () => {
  const list = pod.podPatternList({});
  assert.ok(list.length >= 2);
  for (const p of list) assert.strictEqual(p.remainingPieces, 0);
});

console.log('\n[5] 批次与到货：建批不加余量、到货幂等');

check('建批（不传 arrive）→ 余量仍是 0（货没到就不许拿它报单）', () => {
  const b = pod.podBatchCreate({
    patternId: p1.id,
    sheets: 10,
    piecesPerSheet: 10,
    orderedAt: '2026-01-01',
  });
  assert.ok(b.batchId > 0);
  assert.strictEqual(b.arrivedPieces, 0);
  const row = pod.podBalanceRows().find((x) => x.patternId === p1.id);
  assert.strictEqual(row.remainingPieces, 0);
});

check('到货 → 余量 = 张数 × 每张件数；同一批再点到货是幂等（arrived:false，余量不变）', () => {
  const list = pod.podBatchList({ patternId: p1.id });
  const first = list[list.length - 1];
  const a = pod.podBatchArrive(first.id);
  assert.strictEqual(a.arrived, true);
  assert.strictEqual(a.arrivedPieces, 100);
  assert.strictEqual(pod.podBalanceRows().find((x) => x.patternId === p1.id).remainingPieces, 100);
  const again = pod.podBatchArrive(first.id);
  assert.strictEqual(again.arrived, false, '到货不幂等 = 点两下账上多一批货');
  assert.strictEqual(again.arrivedPieces, 0);
  assert.strictEqual(pod.podBalanceRows().find((x) => x.patternId === p1.id).remainingPieces, 100);
});

check('`arrive:true` 建批顺手到货；张数/每张件数为 0 或负数被拒绝', () => {
  const b = pod.podBatchCreate({
    patternId: p1.id,
    sheets: 5,
    piecesPerSheet: 10,
    orderedAt: '2026-02-01',
    arrive: true,
  });
  assert.strictEqual(b.arrivedPieces, 50);
  assert.throws(
    () => pod.podBatchCreate({ patternId: p1.id, sheets: 0, piecesPerSheet: 10 }),
    /张数必须大于 0/
  );
  assert.throws(
    () => pod.podBatchCreate({ patternId: p1.id, sheets: 5, piecesPerSheet: 0 }),
    /每张件数必须大于 0/
  );
});

console.log('\n[6] 印花：FIFO 分批次 + 不足整批拒绝');

check('印花 120 件 → 先扣第一批 100、再扣第二批 20（FIFO，不是随便挑一批）', () => {
  const r = pod.podPrint({ patternId: p1.id, pieces: 120 });
  assert.strictEqual(r.printed, 120);
  assert.strictEqual(r.allocations.length, 2);
  const first = pod
    .podBatchList({ patternId: p1.id })
    .slice()
    .sort((a, b) => (a.orderedAt < b.orderedAt ? -1 : 1))[0];
  assert.strictEqual(r.allocations[0].batchId, first.id, '应优先扣最早报单的那批');
  assert.strictEqual(r.allocations[0].pieces, 100);
  assert.strictEqual(pod.podBalanceRows().find((x) => x.patternId === p1.id).remainingPieces, 30);
});

check('余量不足 → **整批拒绝**并报「还差 N 件」，一件都没扣', () => {
  assert.throws(() => pod.podPrint({ patternId: p1.id, pieces: 40 }), /还差 10 件/);
  assert.strictEqual(pod.podBalanceRows().find((x) => x.patternId === p1.id).remainingPieces, 30);
});

check('印花件数 ≤ 0 / 超过上限被拒绝（不是静默按 0 处理）', () => {
  assert.throws(() => pod.podPrint({ patternId: p1.id, pieces: 0 }), /必须大于 0/);
  assert.throws(() => pod.podPrint({ patternId: p1.id, pieces: 999999 }), /上限/);
});

console.log('\n[7] 盘点：带符号流水，余量视图跟着变');

check('盘点 -10 → 余量 20；盘点是流水（旧行不改），批次总量仍是 150', () => {
  const list = pod.podBatchList({ patternId: p1.id });
  const second = list.slice().sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))[0];
  const r = pod.podAdjust({ batchId: second.id, deltaPieces: -10, note: '盘点少了' });
  assert.strictEqual(r.adjusted, -10);
  assert.strictEqual(pod.podBalanceRows().find((x) => x.patternId === p1.id).remainingPieces, 20);
  const total = pod.podBatchList({ patternId: p1.id }).reduce((s, b) => s + b.totalPieces, 0);
  assert.strictEqual(total, 150, '批次总量是报单事实，不该被盘点改掉');
});

check('盘点差值为 0 → adjusted:0，不写流水（一次 0 的调整只会让流水更难读）', () => {
  const list = pod.podBatchList({ patternId: p1.id });
  const r = pod.podAdjust({ batchId: list[0].id, deltaPieces: 0 });
  assert.strictEqual(r.adjusted, 0);
});

console.log('\n[8] 绑定索引：只含"图案仍存在"的绑定');

check('podBindingIndex 回 Map<键, patternId>，且与 worklist 的 bound 一致', () => {
  const row = pod
    .podWorklist({ filter: 'all', pageSize: 200 })
    .rows.find((r) => r.itemId === 'IT-2');
  pod.podBindSlots({ patternId: p1.id, slots: [{ variantKey: row.variantKey }] });
  const idx = pod.podBindingIndex();
  assert.ok(idx instanceof Map);
  assert.strictEqual(idx.get(row.variantKey), p1.id);
  assert.strictEqual(idx.size, pod.podWorklistStats().bound);
});

console.log('\n[9] 按图片认图案：一张图只能有一个主人');

/** 64 位十六进制（真实值是 `md_images.fingerprint` 的 SHA-256；这里只要形状合法且互不相同） */
const hex = (c) => c.repeat(64);

const p9 = pod.podPatternCreate({
  code: 'P-9',
  name: '按图认的图案',
  images: [{ fingerprint: hex('a') }],
});
const p10 = pod.podPatternCreate({ code: 'P-10', name: '另一个图案' });

check('新建图案时就挂上识别图（同一事务；否则会出现"图案建好了、卡片上一张图都没有"）', () => {
  assert.strictEqual(p9.created, true);
  assert.strictEqual(p9.linked, 1);
  const row = pod.podPatternList({}).find((p) => p.id === p9.id);
  assert.ok(row, '新建的图案应出现在清单里');
  assert.strictEqual(row.imageCount, 1);
  assert.deepStrictEqual(row.imageFingerprints, [hex('a')]);
});

check('podImageLink 追加识别图：linked 计数、moved 为 0（没抢别人的图）', () => {
  const r = pod.podImageLink({
    patternId: p9.id,
    images: [{ fingerprint: hex('b') }],
    source: 'image',
  });
  assert.deepStrictEqual([r.linked, r.moved, r.patternId], [1, 0, p9.id]);
  assert.strictEqual(pod.podPatternList({}).find((p) => p.id === p9.id).imageCount, 2);
});

check('同一张图重复挂到**同一个**图案：不报错、也不算 moved（幂等）', () => {
  const r = pod.podImageLink({ patternId: p9.id, images: [{ fingerprint: hex('b') }] });
  assert.deepStrictEqual([r.linked, r.moved], [1, 0]);
  assert.strictEqual(pod.podPatternList({}).find((p) => p.id === p9.id).imageCount, 2);
});

check(
  '同一张图挂到**第二个**图案 = 改指过去（moved:1），原图案只剩另一张 —— 结构上不可能"一张图两个主人"',
  () => {
    const r = pod.podImageLink({ patternId: p10.id, images: [{ fingerprint: hex('b') }] });
    assert.strictEqual(r.moved, 1, '挪走别人的图必须回报 moved（静默改指会让人以为系统乱动）');
    assert.strictEqual(pod.podPatternList({}).find((p) => p.id === p9.id).imageCount, 1);
    assert.strictEqual(pod.podPatternList({}).find((p) => p.id === p10.id).imageCount, 1);
    assert.strictEqual(pod.podImageIndex().get(hex('b')), p10.id);
  }
);

check('非法指纹被拒绝（它是这张表的唯一身份，写进脏值等于"同一张图"再也对不上）', () => {
  assert.throws(
    () => pod.podImageLink({ patternId: p9.id, images: [{ fingerprint: 'not-a-fingerprint' }] }),
    /图片指纹格式不对/
  );
  assert.throws(() => pod.podImageLink({ patternId: p9.id, images: [] }), /没有选图片/);
});

check('取消挂图：removed:1，再取消一次是 0（幂等）', () => {
  assert.strictEqual(pod.podImageUnlink([hex('a')]).removed, 1);
  assert.strictEqual(pod.podImageUnlink([hex('a')]).removed, 0);
  assert.strictEqual(pod.podPatternList({}).find((p) => p.id === p9.id).imageCount, 0);
});

check('podImageIndex 是 Map<指纹, 图案>，与挂图表逐条一致', () => {
  const idx = pod.podImageIndex();
  assert.ok(idx instanceof Map);
  assert.strictEqual(idx.get(hex('b')), p10.id);
  const rows = dbQuery('SELECT fingerprint FROM pod_pattern_images');
  assert.strictEqual(idx.size, rows.length, '索引条数与挂图表不一致（有行被漏读或多读）');
});

console.log('\n[10] 合并图案：N→1 搬三样（识别图 / 颜色绑定 / 花纸批次）+ 可按批次撤销');

const p11 = pod.podPatternCreate({
  code: 'P-11',
  name: '保留这个',
  images: [{ fingerprint: hex('e') }],
});
const p12 = pod.podPatternCreate({
  code: 'P-12',
  name: '并进来的一',
  images: [{ fingerprint: hex('f') }, { fingerprint: hex('1') }],
});
const p13 = pod.podPatternCreate({
  code: 'P-13',
  name: '并进来的二',
  images: [{ fingerprint: hex('2') }],
});

// 两个源各自带一个颜色绑定 + 一批已到货的花纸（合并后余量必须落到目标图案上）
const slot12 = pod
  .podWorklist({ filter: 'all', pageSize: 200 })
  .rows.find((r) => r.itemId === 'IT-2');
const slot13 = pod
  .podWorklist({ filter: 'all', pageSize: 200 })
  .rows.find((r) => r.itemId === 'IT-4');
assert.ok(slot12 && slot13, '合并场景需要两个槽位夹具');
pod.podBindSlots({ patternId: p12.id, slots: [{ variantKey: slot12.variantKey }] });
pod.podBindSlots({ patternId: p13.id, slots: [{ variantKey: slot13.variantKey }] });
const b12 = pod.podBatchCreate({
  patternId: p12.id,
  sheets: 5,
  piecesPerSheet: 10,
  orderedAt: '2026-03-01',
  arrive: true,
});
const b13 = pod.podBatchCreate({
  patternId: p13.id,
  sheets: 3,
  piecesPerSheet: 10,
  orderedAt: '2026-03-02',
  arrive: true,
});
assert.deepStrictEqual([b12.arrivedPieces, b13.arrivedPieces], [50, 30]);

const merged = pod.podPatternMerge({ targetId: p11.id, sourceIds: [p12.id, p13.id] });

check('合并返回三样各搬了多少（搬少一样就会留下"合并了但某处还指着旧图案"的暗账）', () => {
  assert.strictEqual(merged.ok, true, merged.error);
  assert.ok(merged.batchId, '撤销键必须是"一次 N→1 一个批次"');
  assert.strictEqual(merged.targetPatternId, p11.id);
  assert.deepStrictEqual([merged.movedImages, merged.movedSlots, merged.movedBatches], [3, 2, 2]);
});

check('合并后：源图案从清单里消失（行还在，用于撤销），目标图案拿到图 + 颜色 + 余量', () => {
  const codes = pod.podPatternList({}).map((p) => p.code);
  assert.ok(
    !codes.includes('P-12') && !codes.includes('P-13'),
    `源图案不该再出现在清单里：${codes.join(',')}`
  );
  const tgt = pod.podPatternList({}).find((p) => p.id === p11.id);
  assert.ok(tgt, '目标图案应还在清单里');
  assert.strictEqual(tgt.imageCount, 4, '目标原有 1 张 + 源的 3 张');
  assert.strictEqual(tgt.boundSlots, 2);
  assert.strictEqual(tgt.remainingPieces, 80, '两批到货 50 + 30 应跟着搬到目标图案');
});

check('合并后绑定索引 / 指纹索引 / 余量看板都指向目标（没有一处还指着源）', () => {
  assert.strictEqual(pod.podBindingIndex().get(slot12.variantKey), p11.id);
  assert.strictEqual(pod.podBindingIndex().get(slot13.variantKey), p11.id);
  assert.strictEqual(pod.podImageIndex().get(hex('f')), p11.id);
  assert.strictEqual(pod.podImageIndex().get(hex('2')), p11.id);
  const balanceCodes = pod.podBalanceRows().map((r) => r.code);
  assert.ok(
    !balanceCodes.includes('P-12') && !balanceCodes.includes('P-13'),
    `余量看板仍有源图案：${balanceCodes.join(',')}`
  );
});

check('合并历史带出批次号 / 目标 / 源编码 / 三样数量（撤销入口就靠它）', () => {
  const h = pod.podPatternMergeHistory();
  const rec = h.find((r) => r.batchId === merged.batchId);
  assert.ok(rec, '刚做的合并应出现在历史里');
  assert.strictEqual(rec.targetCode, 'P-11');
  assert.deepStrictEqual(rec.sources.map((s) => s.code).sort(), ['P-12', 'P-13']);
  assert.deepStrictEqual([rec.movedImages, rec.movedSlots, rec.movedBatches], [3, 2, 2]);
});

check('已经并过的源不能再并（否则第二次合并会搬走已经属于目标的东西）', () => {
  const again = pod.podPatternMerge({ targetId: p11.id, sourceIds: [p12.id] });
  assert.strictEqual(again.ok, false);
  assert.ok(/并过/.test(again.error), `报错要说清"已经并过"：${again.error}`);
});

check('非法合并参数给的是人话（不是抛异常），且一件都没搬', () => {
  const noTarget = pod.podPatternMerge({ targetId: 0, sourceIds: [p12.id] });
  assert.ok(/保留/.test(noTarget.error), noTarget.error);
  const noSource = pod.podPatternMerge({ targetId: p11.id, sourceIds: [] });
  assert.ok(/并进来/.test(noSource.error), noSource.error);
  const ghost = pod.podPatternMerge({ targetId: 999999, sourceIds: [p12.id] });
  assert.ok(/不存在/.test(ghost.error), ghost.error);
});

check('已合并的图案拒绝挂新图 / 报单 / 改主数据（都指回"先撤销合并"）', () => {
  assert.throws(
    () => pod.podImageLink({ patternId: p12.id, images: [{ fingerprint: hex('3') }] }),
    /已经并到别的图案/
  );
  assert.throws(
    () => pod.podBatchCreate({ patternId: p12.id, sheets: 1, piecesPerSheet: 10 }),
    /已经并到别的图案/
  );
  assert.throws(() => pod.podPatternUpdate({ id: p12.id, name: '偷偷改名' }), /先撤销合并再改/);
});

// 撤销前先把一张源图挪到别处：撤销必须**跳过**它（硬搬会把别人认好的图抢回去）
pod.podImageLink({ patternId: p9.id, images: [{ fingerprint: hex('1') }] });
const undone = pod.podPatternMergeUndo(merged.batchId);

check('撤销按批次逐条搬回；已被改到别处的图跳过并计数（不硬搬）', () => {
  assert.strictEqual(undone.ok, true, undone.error);
  assert.strictEqual(undone.restored, 6, '共 7 条明细，其中 1 张图已被挪走');
  assert.strictEqual(undone.skipped, 1);
  assert.strictEqual(pod.podImageIndex().get(hex('1')), p9.id, '被挪走的图必须留在新主人家');
});

check('撤销后源图案回到清单、图/颜色/余量都搬回去了', () => {
  const codes = pod.podPatternList({}).map((p) => p.code);
  assert.ok(
    codes.includes('P-12') && codes.includes('P-13'),
    `撤销后源图案应回到清单：${codes.join(',')}`
  );
  assert.strictEqual(pod.podImageIndex().get(hex('f')), p12.id);
  assert.strictEqual(pod.podBindingIndex().get(slot12.variantKey), p12.id);
  const bal = pod.podBalanceRows();
  assert.strictEqual(bal.find((r) => r.code === 'P-12').remainingPieces, 50);
  assert.strictEqual(bal.find((r) => r.code === 'P-13').remainingPieces, 30);
  assert.strictEqual(
    bal.find((r) => r.code === 'P-11').remainingPieces,
    0,
    '目标图案的余量应回到合并前'
  );
});

check('撤销后这次合并从历史里消失；再撤一次给的是人话（不是静默成功）', () => {
  assert.strictEqual(
    pod.podPatternMergeHistory().filter((r) => r.batchId === merged.batchId).length,
    0
  );
  const again = pod.podPatternMergeUndo(merged.batchId);
  assert.strictEqual(again.ok, false);
  assert.ok(/不在了|撤销过/.test(again.error), again.error);
  const empty = pod.podPatternMergeUndo('');
  assert.ok(/没有指定/.test(empty.error), empty.error);
});

console.log('\n[11] 款色 → 图案：认图案的身份（优先于图片指纹）');

// 款色这一级只认 id（`oi_style_colors.id`），本库**不校验它存不存在** —— 写它的是归类那条链路。
// 所以夹具直接给一串 id 反而是对的：这一级不该因为"分类还没跑过"就拒绝写入。
const scA = 9101;
const scB = 9102;
const p20 = pod.podPatternCreate({ code: 'P-20', name: '按款色认的' });
const p21 = pod.podPatternCreate({ code: 'P-21', name: '同款另一个色认到它' });

check('只给款色、不给图也能认（用户举的例子：同一朵花的第二个颜色，它的 SKU 图还没拿到）', () => {
  const r = pod.podImageLink({ patternId: p20.id, images: [], styleColorIds: [scA, scB] });
  assert.deepStrictEqual([r.linked, r.styleColors, r.patternId], [0, 2, p20.id]);
  const idx = pod.podStyleColorIndex();
  assert.strictEqual(idx.get(scA), p20.id);
  assert.strictEqual(idx.get(scB), p20.id);
});

check('同一个款色认到第二个图案 = 改指过去（movedStyleColors:1，库里仍只有一行）', () => {
  const r = pod.podImageLink({ patternId: p21.id, images: [], styleColorIds: [scA] });
  assert.strictEqual(r.movedStyleColors, 1, '改指必须回报，否则用户以为"两个图案都认了"');
  assert.strictEqual(pod.podStyleColorIndex().get(scA), p21.id);
  const rows = dbQuery('SELECT COUNT(*) AS n FROM pod_style_color_patterns WHERE style_color_id = ?', [scA]);
  assert.strictEqual(
    Number(rows[0].n),
    1,
    '主键就是款色 ⇒ "一个款色同时属于两朵花"在结构上不可能（那会变成报单算两遍）'
  );
});

check('撤销认领能只按款色撤（removedStyleColors），再撤一次是 0（幂等）', () => {
  const r1 = pod.podImageUnlink([], [scA]);
  assert.deepStrictEqual([r1.removed, r1.removedStyleColors], [0, 1]);
  assert.strictEqual(pod.podStyleColorIndex().has(scA), false);
  assert.strictEqual(pod.podImageUnlink([], [scA]).removedStyleColors, 0);
});

check('既不选图也不选款色 ⇒ 报"没有选图片或颜色"（含旧文案"没有选图片"，不静默成功）', () => {
  assert.throws(
    () => pod.podImageLink({ patternId: p20.id, images: [], styleColorIds: [] }),
    /没有选图片或颜色/
  );
});

const p22 = pod.podPatternCreate({ code: 'P-22', name: '合并目标（带款色）' });
const p23 = pod.podPatternCreate({ code: 'P-23', name: '合并源（带款色）' });
pod.podImageLink({ patternId: p22.id, images: [], styleColorIds: [9201] });
pod.podImageLink({ patternId: p23.id, images: [], styleColorIds: [9202, 9203] });
const mergedSc = pod.podPatternMerge({ targetId: p22.id, sourceIds: [p23.id] });

check('合并时款色一起搬（漏搬 = 识别图看着都对、下次同款却认不出）', () => {
  assert.strictEqual(mergedSc.ok, true, mergedSc.error);
  assert.strictEqual(mergedSc.movedStyleColors, 2, '源图案的两个款色都要落到目标上');
  const idx = pod.podStyleColorIndex();
  assert.deepStrictEqual([idx.get(9202), idx.get(9203)], [p22.id, p22.id]);
});

check('撤销合并把款色搬回源图案（不是留在目标上）', () => {
  const u = pod.podPatternMergeUndo(mergedSc.batchId);
  assert.strictEqual(u.ok, true, u.error);
  const idx = pod.podStyleColorIndex();
  assert.deepStrictEqual([idx.get(9201), idx.get(9202), idx.get(9203)], [p22.id, p23.id, p23.id]);
});

console.log('');
if (failed > 0) {
  console.log(`\u2717 图案域冒烟失败：${failed} 项`);
  closeDb();
  process.exit(1);
}
console.log('\u2713 图案域冒烟全部通过');
closeDb();
// 显式退出：无 GUI 环境下 Electron 不显式退出会崩退（stderr 一屏 GPU/sandbox 报错，退出码 SIGTRAP）
process.exit(0);
