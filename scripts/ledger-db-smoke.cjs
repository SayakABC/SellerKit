// 记账域数据层冒烟（不启动 Electron 界面）。
//
//   npm run ledger:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/ledger-db-smoke.cjs
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI** 编译，vitest 跑在系统 Node，
// require 时直接抛 ABI 不匹配。故 DB 层统一走冒烟；分摊算法与往来算式另在
// `tests/ledger.spec.ts`（22 例）/ `tests/partyLedger.spec.ts`（19 例）里覆盖。
//
// 这里守的是**只有真库才能验证**的那部分：
//   · `period` 是 SQLite **生成列**（不是 JS 算出来的）—— 写入方无法给错月，索引可用
//   · 分摊守恒断言 `Σ分摊 == 条目金额` 会真的**回滚整个事务**（不是"返回失败但写了一半"）
//   · 公共条目缺分摊 / 分摊重复店铺 / 门店不存在 → 一律拒
//   · 按店铺筛选走**分摊行**（公共支出摊到该店的部分也算该店成本，只按 shop_id 筛会整块漏掉）
//   · 结算三件套：方向不符拒 · 超额拒 · 一条只能被一张**有效**单结（唯一索引兜底）
//   · 撤销结算后条目恢复可结（结算行 `active=0` 而不是删除 —— 删了就没痕迹，留着内联 UNIQUE 又会永远结不了）
//   · 已结算条目改金额/方向/归属一律拒（否则结算单与它结的条目对不上账），改备注允许
//   · 合并相关人：未结算条目改挂、已结算条目留在原处、合并后原人未结清为 0
//   · 汇总恒等式 `Σ各店结余 == 总收入 − 总支出`，且四项体检均为 0
//   · 往来台账的 SQL 口径与 JS 侧（partyLedger.ts）同构 —— 用固定期望值逐项钉住

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-ledger-smoke-'));

const { initDb, closeDb, dbRun, dbQuery } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const ldb = require(path.join(ROOT, 'dist', 'electron', 'ledger-db.js'));

initDb(path.join(dir, 'smoke.db'));
sdb.ensureShopSchema();
ldb.ensureLedgerSchema();

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

/** 清空业务数据（保留表结构与已播种科目） */
const reset = () => {
  for (const t of [
    'bk_settlement_lines',
    'bk_settlements',
    'bk_allocations',
    'bk_entries',
    'bk_transfers',
    'bk_op_log',
    'sk_shops',
  ]) {
    dbRun(`DELETE FROM ${t}`);
  }
  dbRun(`DELETE FROM bk_parties`);
  dbRun(`DELETE FROM bk_categories WHERE builtin = 0`);
};

/** 造店铺：A 正常、B 无开业日、C 已退店（仍可摊）、D 期间之后才开业、E 已停用、F 已封店 */
const seedShops = () => {
  const ins = (name, status, openedAt) =>
    dbRun(`INSERT INTO sk_shops (platform, name, name_key, status, opened_at) VALUES ('ae', ?, ?, ?, ?)`, [
      name,
      name,
      status,
      openedAt,
    ]).lastInsertRowid;
  return {
    A: ins('店A', 'active', '2026-01-01'),
    B: ins('店B', 'active', ''),
    C: ins('店C', 'exited', ''),
    D: ins('店D', 'active', '2026-11-01'),
    E: ins('店E', 'archived', ''),
    F: ins('店F', 'banned', ''),
  };
};

const party = (name, kind = 'supplier') => ldb.upsertParty({ name, kind }).id;

// ---------------------------------------------------------------------------
console.log('\n[1] 建表 / 迁移 / 预置科目');
// ---------------------------------------------------------------------------

check('ensureLedgerSchema 幂等：连跑 3 次不报错，科目不重复播种', () => {
  reset();
  ldb.ensureLedgerSchema();
  ldb.ensureLedgerSchema();
  const cats = ldb.listCategories(undefined, true);
  assert.strictEqual(cats.length, 12, `科目应为 12 条，实际 ${cats.length}`);
  assert.strictEqual(cats.filter((c) => c.kind === 'expense').length, 10);
  assert.strictEqual(cats.filter((c) => c.kind === 'income').length, 2);
  assert.ok(cats.every((c) => c.builtin), '预置科目应全部标记 builtin');
});

check('builtin 科目改名后不会被重新播种（否则账目被拆成两条）', () => {
  const target = ldb.listCategories('expense').find((c) => c.name === '采购货款');
  ldb.upsertCategory({ id: target.id, kind: 'expense', name: '进货成本' });
  ldb.ensureLedgerSchema();
  const names = ldb.listCategories('expense', true).map((c) => c.name);
  assert.ok(names.includes('进货成本'), '改名应生效');
  assert.ok(!names.includes('采购货款'), '原名称不应被重新插入');
  assert.strictEqual(ldb.listCategories(undefined, true).length, 12);
});

check('科目不允许改收/支类型（否则历史条目会整批换边）', () => {
  const cat = ldb.listCategories('expense')[0];
  assert.throws(() => ldb.upsertCategory({ id: cat.id, kind: 'income', name: cat.name }), /收\/支类型/);
});

// ---------------------------------------------------------------------------
console.log('\n[2] 相关人');
// ---------------------------------------------------------------------------

check('新建 / 同名拒绝 / 名字只差空白也算同名', () => {
  reset();
  const id = party('张三');
  assert.ok(id > 0);
  assert.throws(() => ldb.upsertParty({ name: '张三' }), /已存在同名/);
  assert.throws(() => ldb.upsertParty({ name: '  张三  ' }), /已存在同名/);
  assert.throws(() => ldb.upsertParty({ name: '   ' }), /不能为空|空白/);
});

check('相关人必填：partyId = 0 / 负数一律拒（结构上还有 CHECK 兜底）', () => {
  reset();
  const shops = seedShops();
  for (const bad of [0, -1]) {
    assert.throws(
      () =>
        ldb.upsertEntry({
          bizDate: '2026-10-05',
          kind: 'expense',
          scope: 'shop',
          shopId: shops.A,
          partyId: bad,
          amountCents: 100,
        }),
      /相关人/,
    );
  }
});

// ---------------------------------------------------------------------------
console.log('\n[3] 条目：专属 / 公共 / 守恒断言');
// ---------------------------------------------------------------------------

check('专属店条目自动生成单行全额分摊，period 由生成列派生', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 12345,
  });
  assert.strictEqual(r.allocations, 1);
  const detail = ldb.getEntry(r.id);
  assert.strictEqual(detail.amountCents, 12345);
  assert.strictEqual(detail.period, '2026-10', 'period 必须由 SQLite 生成列派生');
  assert.deepStrictEqual(
    detail.allocations.map((a) => [a.shopId, a.amountCents]),
    [[shops.A, 12345]],
  );
});

check('公共条目：分摊合计必须等于金额，差 1 分也拒且整笔不落库', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const before = dbQuery(`SELECT COUNT(*) AS n FROM bk_entries`)[0].n;
  assert.throws(
    () =>
      ldb.upsertEntry({
        bizDate: '2026-10-10',
        kind: 'expense',
        scope: 'shared',
        partyId: p,
        amountCents: 2000,
        basis: 'equal',
        allocations: [
          { shopId: shops.A, amountCents: 1000 },
          { shopId: shops.B, amountCents: 999 },
        ],
      }),
    /分摊合计/,
  );
  const after = dbQuery(`SELECT COUNT(*) AS n FROM bk_entries`)[0].n;
  assert.strictEqual(after, before, '守恒断言失败必须整笔回滚，不能留下半条记录');
});

check('公共条目缺分摊 / 分摊店铺重复 / 店铺不存在 → 拒', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const base = { bizDate: '2026-10-10', kind: 'expense', scope: 'shared', partyId: p, amountCents: 100 };
  assert.throws(() => ldb.upsertEntry({ ...base, allocations: [] }), /分摊明细/);
  assert.throws(
    () =>
      ldb.upsertEntry({
        ...base,
        allocations: [
          { shopId: shops.A, amountCents: 50 },
          { shopId: shops.A, amountCents: 50 },
        ],
      }),
    /重复/,
  );
  assert.throws(() => ldb.upsertEntry({ ...base, allocations: [{ shopId: 99999, amountCents: 100 }] }), /不存在/);
});

check('非法日期被拒（格式对但日子不存在也不行）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  assert.throws(
    () =>
      ldb.upsertEntry({
        bizDate: '2026-02-30',
        kind: 'expense',
        scope: 'shop',
        shopId: shops.A,
        partyId: p,
        amountCents: 100,
      }),
    /真实存在的日期/,
  );
});

check('金额必须为正整数分（0 / 负 / 小数都拒，方向只由 kind 表达）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  for (const bad of [0, -100, 1.5]) {
    assert.throws(
      () =>
        ldb.upsertEntry({
          bizDate: '2026-10-05',
          kind: 'expense',
          scope: 'shop',
          shopId: shops.A,
          partyId: p,
          amountCents: bad,
        }),
      /金额/,
    );
  }
});

check('重算幂等：分摊没变就不重写（updated_at 不虚动）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    basis: 'equal',
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  const before = dbQuery(`SELECT updated_at FROM bk_entries WHERE id = ?`, [r.id])[0].updated_at;
  const first = dbQuery(`SELECT COUNT(*) AS n FROM bk_allocations WHERE entry_id = ?`, [r.id])[0].n;
  ldb.upsertEntry({
    id: r.id,
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  const after = dbQuery(`SELECT updated_at FROM bk_entries WHERE id = ?`, [r.id])[0].updated_at;
  assert.strictEqual(after, before, 'updated_at 不该因为"重算了一次"而变');
  assert.strictEqual(dbQuery(`SELECT COUNT(*) AS n FROM bk_allocations WHERE entry_id = ?`, [r.id])[0].n, first);
  assert.strictEqual(first, 2);
});

check('更新时只改备注不传分摊：沿用现值；金额改了就要求重新分摊', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  ldb.upsertEntry({ id: r.id, note: '只改备注' });
  assert.strictEqual(ldb.getEntry(r.id).note, '只改备注');
  assert.strictEqual(ldb.getEntry(r.id).allocations.length, 2);
  assert.throws(() => ldb.upsertEntry({ id: r.id, amountCents: 3000 }), /重新分摊/);
});

check('金额改了并重传分摊：旧行**被替换**（不叠加），合计按新金额守恒，ratio 跟着更新', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    basis: 'manual',
    allocations: [
      { shopId: shops.A, amountCents: 1000, ratioBp: 5000 },
      { shopId: shops.B, amountCents: 1000, ratioBp: 5000 },
    ],
  });
  ldb.upsertEntry({
    id: r.id,
    amountCents: 1500,
    basis: 'manual',
    allocations: [
      { shopId: shops.A, amountCents: 1000, ratioBp: 6667 },
      { shopId: shops.B, amountCents: 500, ratioBp: 3333 },
    ],
  });
  const rows = dbQuery(
    `SELECT shop_id, amount_cents, ratio_bp FROM bk_allocations WHERE entry_id = ? ORDER BY shop_id ASC`,
    [r.id],
  );
  assert.strictEqual(rows.length, 2, '重算必须替换掉旧分摊行，不是再插一批');
  assert.deepStrictEqual(
    rows.map((x) => [Number(x.shop_id), Number(x.amount_cents), Number(x.ratio_bp)]),
    [
      [shops.A, 1000, 6667],
      [shops.B, 500, 3333],
    ],
  );
  assert.strictEqual(
    rows.reduce((s, x) => s + Number(x.amount_cents), 0),
    Number(dbQuery(`SELECT amount_cents FROM bk_entries WHERE id = ?`, [r.id])[0].amount_cents),
    '旧行残留会让合计翻倍，落库侧守恒断言应挡住（这里断言替换后确实相等）',
  );
});

check('改店铺集合再重传：被移出的店铺不留分摊行（旧行不能变成"幽灵归属"）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  ldb.upsertEntry({
    id: r.id,
    allocations: [
      { shopId: shops.A, amountCents: 1200 },
      { shopId: shops.C, amountCents: 800 },
    ],
  });
  const ids = dbQuery(`SELECT shop_id FROM bk_allocations WHERE entry_id = ? ORDER BY shop_id ASC`, [r.id]).map(
    (x) => Number(x.shop_id),
  );
  assert.deepStrictEqual(ids, [shops.A, shops.C], '被移出的 B 不应还留着一行');
  const bRows = dbQuery(
    `SELECT COUNT(*) AS n FROM bk_allocations WHERE entry_id = ? AND shop_id = ?`,
    [r.id, shops.B],
  )[0].n;
  assert.strictEqual(Number(bRows), 0);
});

// ---------------------------------------------------------------------------
console.log('\n[4] 汇总与体检');
// ---------------------------------------------------------------------------

check('Σ各店结余 == 总收入 − 总支出；四项体检全为 0', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const q = party('李四', 'staff');
  ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 1000,
  });
  ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  ldb.upsertEntry({
    bizDate: '2026-10-12',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    partyId: q,
    amountCents: 5000,
  });

  const s = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(s.incomeCents, 5000);
  assert.strictEqual(s.expenseCents, 3000);
  assert.strictEqual(s.balanceCents, 2000);
  // 公共金额现在按方向拆：这里是纯支出侧的公共条目
  assert.strictEqual(s.sharedExpenseCents, 2000);
  assert.strictEqual(s.sharedIncomeCents, 0);
  const shopSum = s.byShop.reduce((acc, x) => acc + x.balanceCents, 0);
  assert.strictEqual(shopSum, s.incomeCents - s.expenseCents, 'Σ各店结余必须等于总收支差');
  assert.deepStrictEqual(
    s.byShop.map((x) => [x.shopName, x.incomeCents, x.expenseCents, x.balanceCents]),
    [
      ['店A', 5000, 2000, 3000],
      ['店B', 0, 1000, -1000],
    ],
  );
  assert.deepStrictEqual(s.integrity, {
    allocationGapCents: 0,
    partyGapCents: 0,
    publicPoolCents: 0,
    brokenEntries: [],
    missingPartyEntries: [],
  });
});

check('按店铺筛选走分摊行：公共支出摊到该店的部分也算该店', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    allocations: [
      { shopId: shops.A, amountCents: 1200 },
      { shopId: shops.B, amountCents: 800 },
    ],
  });
  const rowsB = ldb.listEntries({ shopId: shops.B });
  assert.strictEqual(rowsB.length, 1, '店B 应该看得到这条公共支出');
  assert.strictEqual(rowsB[0].scope, 'shared');
  assert.strictEqual(ldb.listEntries({ shopId: shops.C }).length, 0);
});

check('作废条目不计入汇总（作废不是删除，分摊行仍留库）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 1000,
  });
  ldb.voidEntry(r.id, '记错了');
  const s = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(s.expenseCents, 0);
  assert.strictEqual(s.integrity.allocationGapCents, 0, '作废后分摊行仍在，体检口径必须一样按 active 过滤');
  assert.strictEqual(ldb.listEntries({ includeVoid: true }).length, 1);
  assert.strictEqual(ldb.listEntries({}).length, 0);
});

check('作废必须填原因', () => {
  reset();
  const shops = seedShops();
  const r = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: party('张三'),
    amountCents: 100,
  });
  assert.throws(() => ldb.voidEntry(r.id, '  '), /原因/);
});

check('作废可恢复：合计与相关人往来回到作废前同值，作废原因被清', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 1000,
  });

  const beforeExpense = ldb.ledgerSummary({ period: '2026-10' }).expenseCents;
  const beforeNet = ldb.partyLedger({ partyId: p })[0].netCents;

  ldb.voidEntry(r.id, '记错了');
  // 先确认"作废真的改了两个数" —— 否则下面的"回到同值"在任何实现下都恒真
  assert.strictEqual(ldb.ledgerSummary({ period: '2026-10' }).expenseCents, 0);
  assert.notStrictEqual(
    ldb.partyLedger({ partyId: p })[0].netCents,
    beforeNet,
    '作废必须真的把这条从相关人往来里去掉，否则恢复用例是空的',
  );

  assert.deepStrictEqual(ldb.restoreEntry(r.id), { id: r.id, restored: true });
  assert.strictEqual(
    ldb.ledgerSummary({ period: '2026-10' }).expenseCents,
    beforeExpense,
    '恢复后合计必须回到作废前**同值**（不是"多了一些"）',
  );
  assert.strictEqual(ldb.partyLedger({ partyId: p })[0].netCents, beforeNet, '恢复后相关人往来回到作废前同值');
  const back = ldb.getEntry(r.id);
  assert.strictEqual(back.status, 'active');
  assert.strictEqual(back.voidReason, '', '恢复要清掉作废原因，否则明细里还写着「作废：记错了」');

  // 对有效条目再恢复 = no-op：不能因为重复点就多算一次
  assert.deepStrictEqual(ldb.restoreEntry(r.id), { id: r.id, restored: false });
  assert.strictEqual(ldb.ledgerSummary({ period: '2026-10' }).expenseCents, beforeExpense);
  assert.throws(() => ldb.restoreEntry(999999), /不存在/);
});

check('恢复的两条拒收：被有效结算单占用 / 分摊合计与金额不一致', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const mk = () =>
    ldb.upsertEntry({
      bizDate: '2026-10-05',
      kind: 'expense',
      scope: 'shop',
      shopId: shops.A,
      partyId: p,
      amountCents: 1000,
    });

  // ① 被有效结算单占用：公开接口走不到这个态（voidEntry 会先拒），只能直接改库造出来 ——
  //    守卫仍要守，因为它是"结算单语义被改写"的最后一道闸。
  const occupied = mk();
  ldb.createSettlement({ partyId: p, settleDate: '2026-10-20', direction: 'pay', entryIds: [occupied.id] });
  dbRun(`UPDATE bk_entries SET status = 'void', void_reason = '库里被改动' WHERE id = ?`, [occupied.id]);
  assert.throws(() => ldb.restoreEntry(occupied.id), /结算单 #\d+ 占用/);

  // ② 分摊合计 ≠ 金额：说明作废期间分摊行被改过，恢复会让守恒断言失效，只能重记
  const broken = mk();
  ldb.voidEntry(broken.id, '记错了');
  dbRun(`UPDATE bk_allocations SET amount_cents = amount_cents - 1 WHERE entry_id = ?`, [broken.id]);
  assert.throws(() => ldb.restoreEntry(broken.id), /不一致/);
  assert.strictEqual(ldb.getEntry(broken.id).status, 'void', '拒收必须整笔回滚，不能改了一半');
});

check('eligibleShops：退店仍参与分摊；停用/封店与"期间之后才开业"排除且给出原因', () => {
  reset();
  seedShops();
  const { eligible, excluded } = ldb.eligibleShops('2026-10');
  assert.deepStrictEqual(eligible.map((x) => x.name), ['店A', '店B', '店C'], '退店（店C）必须还在可摊名单里');
  const byName = Object.fromEntries(excluded.map((x) => [x.name, x.reason]));
  assert.strictEqual(byName['店C'], undefined, '退店不能出现在排除清单里');
  assert.strictEqual(byName['店E'], 'inactive');
  assert.strictEqual(byName['店F'], 'inactive');
  assert.strictEqual(byName['店D'], 'not-open-yet');
});

check('名字解析：退店算 ok（能摊），停用 / 封店算 archived（不能摊），原始状态一并给出', () => {
  reset();
  seedShops();
  const r = ldb.resolveImportNames({ shop: ['店C', '店E', '店F', '无此店'] });
  assert.strictEqual(r.shop['店C'].state, 'ok');
  assert.strictEqual(r.shop['店C'].status, 'exited');
  assert.strictEqual(r.shop['店E'].state, 'archived');
  assert.strictEqual(r.shop['店E'].status, 'archived');
  assert.strictEqual(r.shop['店F'].state, 'archived');
  assert.strictEqual(r.shop['店F'].status, 'banned');
  assert.strictEqual(r.shop['无此店'].state, 'missing');
});

// ---------------------------------------------------------------------------
console.log('\n[5] 往来与结算');
// ---------------------------------------------------------------------------

const seedLedgerForParty = () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const e1 = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 1000,
  }).id;
  const e2 = ldb.upsertEntry({
    bizDate: '2026-10-06',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 2000,
  }).id;
  return { shops, partyId: p, e1, e2 };
};

check('往来五个数：应付 3000 → 净 −3000、未结清 −3000', () => {
  const { partyId } = seedLedgerForParty();
  const row = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(row.receivableCents, 0);
  assert.strictEqual(row.payableCents, 3000);
  assert.strictEqual(row.netCents, -3000);
  assert.strictEqual(row.settledNetCents, 0);
  assert.strictEqual(row.unsettledCents, -3000);
});

check('方向与条目类型不符被拦（拿收入条目做「我付给对方」，两边都会算错）', () => {
  const { partyId, e1 } = seedLedgerForParty();
  assert.throws(
    () => ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'receive', entryIds: [e1] }),
    /只能结算收入条目/,
  );
});

check('结清后再结被拒（条目已被占用）', () => {
  const { partyId, e1, e2 } = seedLedgerForParty();
  ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  ldb.createSettlement({ partyId, settleDate: '2026-10-21', direction: 'pay', entryIds: [e2] });
  assert.strictEqual(ldb.partyLedger({ partyId })[0].unsettledCents, 0);
  assert.throws(
    () => ldb.createSettlement({ partyId, settleDate: '2026-10-22', direction: 'pay', entryIds: [e1] }),
    /已结算过/,
  );
});

check('超额拦截：库被改脏（已结算条目金额被直接改小）时拒绝继续结算', () => {
  const { partyId, e1, e2 } = seedLedgerForParty();
  ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] }); // 付 1000
  // 绕过 API 把已结算条目从 1000 改成 999（真实来源：有人直接改库 / 老版本 bug 留下的脏数据）
  dbRun(`UPDATE bk_entries SET amount_cents = 999 WHERE id = ?`, [e1]);
  // 此时 净往来 = −(999+2000) = −2999、已结算 = 1000 → 未结清 −1999，
  // 而 e2 是 2000 → 超额 1 分。这类"眼睛看不出来"的差额必须在这里拦住（RK-05）。
  assert.throws(
    () => ldb.createSettlement({ partyId, settleDate: '2026-10-21', direction: 'pay', entryIds: [e2] }),
    /超出该方向未结清/,
  );
});

check('结算金额由服务端求和（前端不传金额），并冲减往来', () => {
  const { partyId, e1, e2 } = seedLedgerForParty();
  const r = ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1, e2] });
  assert.strictEqual(r.amountCents, 3000);
  assert.strictEqual(r.entryCount, 2);
  const row = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(row.settledNetCents, 3000);
  assert.strictEqual(row.unsettledCents, 0, '欠 3000 付 3000 必须结清（符号口径见 partyLedger.ts）');
});

check('幂等：同一条目不能被两张有效结算单占用', () => {
  const { partyId, e1, e2 } = seedLedgerForParty();
  ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  assert.throws(
    () => ldb.createSettlement({ partyId, settleDate: '2026-10-21', direction: 'pay', entryIds: [e1, e2] }),
    /已结算过/,
  );
});

check('已结算条目改金额/方向/归属一律拒，改备注允许', () => {
  const { partyId, e1, shops } = seedLedgerForParty();
  ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  assert.throws(() => ldb.upsertEntry({ id: e1, amountCents: 9999 }), /已被结算单/);
  assert.throws(() => ldb.upsertEntry({ id: e1, kind: 'income' }), /已被结算单/);
  assert.throws(() => ldb.upsertEntry({ id: e1, partyId: party('王五') }), /已被结算单/);
  assert.throws(() => ldb.upsertEntry({ id: e1, scope: 'shared' }), /已被结算单/);
  const okRes = ldb.upsertEntry({ id: e1, note: '补个备注' });
  assert.strictEqual(okRes.settledLocked, true);
  assert.strictEqual(ldb.getEntry(e1).note, '补个备注');
  assert.throws(() => ldb.voidEntry(e1, '想删掉'), /先撤销结算/);
  assert.ok(shops.A > 0);
});

check('撤销结算：作废 + 结算行失活，条目恢复可结（不是永远结不了）', () => {
  const { partyId, e1 } = seedLedgerForParty();
  const s = ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  assert.strictEqual(ldb.partyLedger({ partyId })[0].unsettledCents, -2000);
  ldb.voidSettlement(s.id, '金额记错了');
  assert.strictEqual(ldb.partyLedger({ partyId })[0].unsettledCents, -3000, '撤销后余额必须回到未结状态');
  assert.strictEqual(ldb.getEntry(e1).settled, false);
  // 重新结算同一条条目：部分唯一索引（active=1）必须放行
  const again = ldb.createSettlement({ partyId, settleDate: '2026-10-22', direction: 'pay', entryIds: [e1] });
  assert.strictEqual(again.amountCents, 1000);
  assert.strictEqual(ldb.partyLedger({ partyId })[0].unsettledCents, -2000);
});

check('撤销结算必须填原因', () => {
  const { partyId, e1 } = seedLedgerForParty();
  const s = ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  assert.throws(() => ldb.voidSettlement(s.id, ''), /原因/);
});

check('结算只改往来状态，不生成收支（否则支出会翻倍）', () => {
  const { partyId, e1, e2 } = seedLedgerForParty();
  const before = ldb.ledgerSummary({ period: '2026-10' });
  ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1, e2] });
  const after = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(after.incomeCents, before.incomeCents);
  assert.strictEqual(after.expenseCents, before.expenseCents, '结算不该让支出变大');
  assert.strictEqual(after.entryCount, before.entryCount, '结算不该新增条目');
});

// ---- 互抵结清（2026-10-27）----
// 一张单同时核销收入与支出，只走差额。守的是"两侧各减各的毛额"：
// 只减净额会让另一个方向留下假余额，用户会被引导去再付一次已经抵掉的钱。
const seedOffsetForParty = (payCents = 1000, receiveCents = 400) => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const exp = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: payCents,
  }).id;
  const inc = ldb.upsertEntry({
    bizDate: '2026-10-06',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: receiveCents,
  }).id;
  return { shops, partyId: p, exp, inc };
};

check('互抵结清：毛额 1400、实付 600，两个方向同时归零', () => {
  const { partyId, exp, inc } = seedOffsetForParty(1000, 400);
  const before = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(before.unsettledPayableCents, 1000);
  assert.strictEqual(before.unsettledReceivableCents, 400);
  assert.strictEqual(before.unsettledCents, -600);

  const r = ldb.createSettlement({
    partyId,
    settleDate: '2026-10-20',
    direction: 'offset',
    entryIds: [exp, inc],
  });
  assert.strictEqual(r.amountCents, 1400, '单据记毛额（行和），对账断言才成立');
  assert.strictEqual(r.cashCents, 600, '实付 = 支出 1000 − 收入 400');
  assert.strictEqual(r.entryCount, 2);

  const after = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(after.unsettledPayableCents, 0, '应付方向必须归零');
  assert.strictEqual(after.unsettledReceivableCents, 0, '应收方向也必须归零（只减净额会留下 400 假余额）');
  assert.strictEqual(after.unsettledCents, 0);
  assert.strictEqual(after.settledNetCents, 600);
});

check('互抵：收支相同完全对冲时实付 0，两个方向同时归零', () => {
  const { partyId, exp, inc } = seedOffsetForParty(1000, 1000);
  const r = ldb.createSettlement({
    partyId,
    settleDate: '2026-10-20',
    direction: 'offset',
    entryIds: [exp, inc],
  });
  assert.strictEqual(r.amountCents, 2000);
  assert.strictEqual(r.cashCents, 0, '一分钱都不用走');
  const row = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(row.unsettledCents, 0);
  assert.strictEqual(row.unsettledPayableCents, 0);
  assert.strictEqual(row.unsettledReceivableCents, 0);
});

check('互抵：只勾单方向被拒（那不是互抵，是普通结算）', () => {
  const { partyId, exp } = seedOffsetForParty(1000, 400);
  assert.throws(
    () => ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'offset', entryIds: [exp] }),
    /必须同时勾选收入与支出条目/,
  );
});

check('互抵后撤销：两边余额一起回来，条目可重新结算', () => {
  const { partyId, exp, inc } = seedOffsetForParty(1000, 400);
  const s = ldb.createSettlement({
    partyId,
    settleDate: '2026-10-20',
    direction: 'offset',
    entryIds: [exp, inc],
  });
  assert.strictEqual(ldb.partyLedger({ partyId })[0].unsettledPayableCents, 0);
  ldb.voidSettlement(s.id, '抵错了');
  const row = ldb.partyLedger({ partyId })[0];
  assert.strictEqual(row.unsettledPayableCents, 1000);
  assert.strictEqual(row.unsettledReceivableCents, 400);
});

check('listSettlements 同时给出毛额与实付（一个看"抵了多少"，一个看"该打多少钱"）', () => {
  const { partyId, exp, inc } = seedOffsetForParty(1000, 400);
  const s = ldb.createSettlement({
    partyId,
    settleDate: '2026-10-20',
    direction: 'offset',
    entryIds: [exp, inc],
  });
  const row = ldb.listSettlements(partyId).find((x) => x.id === s.id);
  assert.strictEqual(row.direction, 'offset');
  assert.strictEqual(row.amountCents, 1400);
  assert.strictEqual(row.payCents, 1000);
  assert.strictEqual(row.receiveCents, 400);
  assert.strictEqual(row.cashCents, 600);
});

check('普通单的 payCents/receiveCents 与金额一致（余额改法对存量数据等价）', () => {
  const { partyId, e1 } = seedLedgerForParty();
  const s = ldb.createSettlement({ partyId, settleDate: '2026-10-20', direction: 'pay', entryIds: [e1] });
  const row = ldb.listSettlements(partyId).find((x) => x.id === s.id);
  assert.strictEqual(row.amountCents, 1000);
  assert.strictEqual(row.payCents, 1000);
  assert.strictEqual(row.receiveCents, 0);
  assert.strictEqual(row.cashCents, 1000);
});

check('迁移 v2：老库的 CHECK 放开 offset，老数据与子表外键引用都不动', () => {
  reset();
  // 造一个"老形状"：direction 只认 pay/receive（迁移前的真实结构）
  dbRun(`DROP TABLE bk_settlement_lines`);
  dbRun(`DROP TABLE bk_settlements`);
  dbRun(`CREATE TABLE bk_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    settle_date TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('pay','receive')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    void_reason TEXT NOT NULL DEFAULT '',
    voided_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  dbRun(`CREATE TABLE bk_settlement_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id INTEGER NOT NULL REFERENCES bk_settlements(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL REFERENCES bk_entries(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    active INTEGER NOT NULL DEFAULT 1
  )`);
  dbRun(
    `INSERT INTO bk_settlements (party_id, settle_date, direction, amount_cents)
     VALUES (1, '2026-10-01', 'pay', 500)`,
  );
  const oldId = dbQuery(`SELECT MAX(id) AS m FROM bk_settlements`)[0].m;
  // 老库上 offset 必须被 CHECK 拦下 —— 否则这条用例证明不了迁移真的起了作用
  assert.throws(
    () =>
      dbRun(
        `INSERT INTO bk_settlements (party_id, settle_date, direction, amount_cents)
         VALUES (1, '2026-10-02', 'offset', 600)`,
      ),
    /CHECK/,
  );

  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'ledger.main'`);
  ldb.ensureLedgerSchema();

  const shape = dbQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bk_settlements'`)[0].sql;
  assert.ok(shape.includes("'offset'"), '新形状必须放开 offset');
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS n FROM bk_settlements WHERE id = ?`, [oldId])[0].n,
    1,
    '老数据必须原样还在',
  );
  const lineShape = dbQuery(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='bk_settlement_lines'`,
  )[0].sql;
  assert.ok(
    lineShape.includes('REFERENCES bk_settlements'),
    '子表外键必须仍指向 bk_settlements（被 RENAME 改写成 rebuild 表名就成了脏 schema）',
  );
  assert.ok(
    dbQuery(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_bk_settle_party'`).length > 0,
    '索引随老表被 DROP，迁移末尾必须补回来',
  );
  const ins = dbRun(
    `INSERT INTO bk_settlements (party_id, settle_date, direction, amount_cents)
     VALUES (1, '2026-10-02', 'offset', 600)`,
  );
  assert.ok(ins.lastInsertRowid > oldId, 'AUTOINCREMENT 序列要按最大 id 重置，不能复用已发出的 id');
  assert.strictEqual(dbQuery(`SELECT COUNT(*) AS n FROM bk_settlements`)[0].n, 2);
});

check('迁移 v3：老库（bk_parties 无 merged_to）加列成功，老数据不动、也不瞎猜历史合并', () => {
  reset();
  ldb.upsertParty({ name: '老库甲' });
  ldb.upsertParty({ name: '老库乙', archived: true });
  // 造"老形状"：把 bk_parties 换回没有 merged_to 的表（列里没数据，所以重建不会丢东西）
  dbRun(`ALTER TABLE bk_parties RENAME TO bk_parties_old`);
  dbRun(`CREATE TABLE bk_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other'
      CHECK (kind IN ('supplier','staff','landlord','platform','other')),
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (name_key)
  )`);
  dbRun(`INSERT INTO bk_parties (id, name, name_key, kind, archived) SELECT id, name, name_key, kind, archived FROM bk_parties_old`);
  dbRun(`DROP TABLE bk_parties_old`);
  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'ledger.main'`);

  ldb.ensureLedgerSchema();

  const cols = dbQuery(`PRAGMA table_info(bk_parties)`).map((c) => c.name);
  assert.ok(cols.includes('merged_to'), 'v3 必须把 merged_to 加回来');
  const rows = ldb.listParties({ includeArchived: true });
  assert.strictEqual(rows.length, 2, '老数据必须原样还在');
  assert.ok(
    rows.every((r) => r.mergedTo === 0),
    '历史合并痕迹不猜：老库里 archived=1 可能只是手动停用，猜成"已并入某人"比不显示更难查',
  );
});

check('合并写 merged_to、重新启用时清掉（「已并入」不会粘在一个在用的人身上）', () => {
  reset();
  const a = ldb.upsertParty({ name: '甲' }).id;
  const b = ldb.upsertParty({ name: '乙' }).id;
  ldb.mergeParty({ fromId: a, toId: b });

  const merged = ldb.listParties({ includeArchived: true }).find((r) => r.id === a);
  assert.strictEqual(merged.archived, true);
  assert.strictEqual(merged.mergedTo, b, '合并必须记下"并到谁"，否则界面只能写含混的「已停用」');
  assert.strictEqual(
    ldb.partyLedger({ includeArchived: true, partyId: a })[0].mergedTo,
    b,
    '台账也要带这个字段（同一个判据两处显示，不能一边有一边没有）',
  );

  // 手动停用的人：archived=1 但 merged_to 必须是 0（两种状态不能混）
  const c = ldb.upsertParty({ name: '丙' }).id;
  dbRun(`UPDATE bk_parties SET archived = 1 WHERE id = ?`, [c]);
  const manual = ldb.listParties({ includeArchived: true }).find((r) => r.id === c);
  assert.strictEqual(manual.archived, true);
  assert.strictEqual(manual.mergedTo, 0, '手动停用不能被显示成「已并入」');

  // 重新启用：merged_to 必须清掉，否则"在用的人"头上还挂着「已并入 → 乙」
  ldb.upsertParty({ id: a, name: '甲', archived: false });
  const back = ldb.listParties({ includeArchived: true }).find((r) => r.id === a);
  assert.strictEqual(back.archived, false);
  assert.strictEqual(back.mergedTo, 0, '启用后必须清 merged_to，否则界面会同时说"在用"和"已并入"');
});

check('导入报错用的是 Excel 行号（不是这批的第几条）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  // 第 7 行（表头在第 1 行）才是坏行：只提交它一条 ⇒ 批内序号是 1，而用户看到的是 7
  assert.throws(
    () =>
      ldb.batchCreateEntries([
        { rowNo: 7, bizDate: '2026-10-05', kind: 'expense', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 100 },
        { rowNo: 9, bizDate: '2026-10-05', kind: '', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 100 },
      ]),
    /第 9 行：没有收\/支方向/,
    '报了"第 2 行"就等于把人指到别人的那一行上',
  );
  // 不带 rowNo 的调用方（老界面 / 直接调用）仍按批内序号报，不能退化成 NaN
  assert.throws(
    () =>
      ldb.batchCreateEntries([
        { bizDate: '2026-10-05', kind: 'expense', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 100 },
        { bizDate: '2026-10-05', kind: '', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 100 },
      ]),
    /第 2 行：/,
  );
});

check('批量作废（撤销导入）：整批一个事务，一条被结算单占用则整批回滚', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const ids = ldb
    .batchCreateEntries([
      { rowNo: 2, bizDate: '2026-10-05', kind: 'expense', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 100 },
      { rowNo: 3, bizDate: '2026-10-05', kind: 'expense', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 200 },
      { rowNo: 4, bizDate: '2026-10-05', kind: 'income', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 300 },
    ])
    .ids;
  assert.strictEqual(ldb.ledgerSummary({ period: '2026-10' }).expenseCents, 300);
  assert.deepStrictEqual(ldb.voidEntries([ids[0], ids[1]], '撤销本次导入').voided, 2);
  assert.strictEqual(ldb.ledgerSummary({ period: '2026-10' }).expenseCents, 0, '整批作废后支出归零');
  assert.strictEqual(ldb.getEntry(ids[2]).status, 'active', '没在 ids 里的那条不能跟着作废');

  // 已结算的那条不可作废 ⇒ 整批回滚（成功一半比全失败更难收拾）
  const e = ldb.upsertEntry({ bizDate: '2026-10-06', kind: 'expense', scope: 'shop', shopId: shops.A, partyId: p, amountCents: 500 });
  ldb.createSettlement({ partyId: p, settleDate: '2026-10-20', direction: 'pay', entryIds: [e.id] });
  assert.throws(() => ldb.voidEntries([ids[2], e.id], '撤销本次导入'), /条目 #\d+：.*占用/);
  assert.strictEqual(ldb.getEntry(ids[2]).status, 'active', '第二条被拒时，第一条也不能留下来被作废');
  assert.throws(() => ldb.voidEntries([ids[2]], '   '), /原因/);
});

// ---------------------------------------------------------------------------
console.log('\n[6] 合并相关人（结算后统一变更相关人的安全路径）');
// ---------------------------------------------------------------------------

check('合并：未结算条目改挂新、已结算条目留原处、原人未结清归零', () => {
  reset();
  const shops = seedShops();
  const from = party('张三');
  const to = party('李四', 'staff');
  const settledEntry = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: from,
    amountCents: 1000,
  }).id;
  const openEntry = ldb.upsertEntry({
    bizDate: '2026-10-06',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: from,
    amountCents: 2000,
  }).id;
  ldb.createSettlement({ partyId: from, settleDate: '2026-10-10', direction: 'pay', entryIds: [settledEntry] });

  const r = ldb.mergeParty({ fromId: from, toId: to });
  assert.strictEqual(r.movedEntries, 1, '只该改挂未结算的那一条');
  assert.strictEqual(r.transferredCents, 0, '正常合并没有残额，不该凭空写一笔结转');

  assert.strictEqual(ldb.getEntry(openEntry).partyId, to, '未结算条目应改挂');
  assert.strictEqual(ldb.getEntry(settledEntry).partyId, from, '已结算条目必须留在原处（换了人结算单就对不上）');

  const fromRow = ldb.partyLedger({ includeArchived: true, partyId: from })[0];
  assert.strictEqual(fromRow.archived, true, '原人应停用而不是删除');
  assert.strictEqual(fromRow.unsettledCents, 0, '合并后原人未结清必须为 0');

  const toRow = ldb.partyLedger({ partyId: to })[0];
  assert.strictEqual(toRow.payableCents, 2000, '承接的余额应体现在新人的往来里');
});

check('合并拒绝：合并到自己 / 目标已停用', () => {
  reset();
  const a = party('张三');
  const b = party('李四');
  assert.throws(() => ldb.mergeParty({ fromId: a, toId: a }), /不能合并到自己/);
  ldb.upsertParty({ id: b, name: '李四', archived: true });
  assert.throws(() => ldb.mergeParty({ fromId: a, toId: b }), /已停用/);
});

check('停用相关人：新条目不可选，历史条目"改备注"仍可保存（不能变成不能碰）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 100,
  });
  ldb.upsertParty({ id: p, name: '张三', archived: true });
  // 换到已停用的人：拒
  assert.throws(
    () =>
      ldb.upsertEntry({
        bizDate: '2026-10-06',
        kind: 'expense',
        scope: 'shop',
        shopId: shops.A,
        partyId: p,
        amountCents: 100,
      }),
    /已停用/,
  );
  // 相关人没改动：允许
  const ok = ldb.upsertEntry({ id: r.id, note: '离职前最后一笔' });
  assert.strictEqual(ok.id, r.id);
  assert.strictEqual(ldb.getEntry(r.id).partyArchived, true);
});

// ---------------------------------------------------------------------------
console.log('\n[7] 台账口径（与 src/lib/partyLedger.ts 同构）');
// ---------------------------------------------------------------------------

check('收支混合的一个人：五个数与 JS 口径逐个对得上', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 5000,
  });
  ldb.upsertEntry({
    bizDate: '2026-10-06',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 2000,
  });
  const row = ldb.partyLedger({ partyId: p })[0];
  // JS 侧 partyBalance([income 5000, expense 2000], []) 的结果
  assert.strictEqual(row.receivableCents, 5000);
  assert.strictEqual(row.payableCents, 2000);
  assert.strictEqual(row.netCents, 3000);
  assert.strictEqual(row.settledNetCents, 0);
  assert.strictEqual(row.unsettledCents, 3000);

  // 对方付我 3000 → 未结清 0（if 实现写成 net − settledNet，这里会是 6000）
  ldb.createSettlement({
    partyId: p,
    settleDate: '2026-10-20',
    direction: 'receive',
    entryIds: ldb.listEntries({ kind: 'income' }).map((e) => e.id),
  });
  const after = ldb.partyLedger({ partyId: p })[0];
  assert.strictEqual(after.settledNetCents, -5000);
  assert.strictEqual(after.unsettledReceivableCents, 0, '应收方向已结清');
  assert.strictEqual(after.unsettledPayableCents, 2000, '应付方向不受另一个方向结算的影响');
  assert.strictEqual(after.unsettledCents, -2000, '净额 = 应收0 − 应付2000');
});

check('混方向：应收 5000 / 应付 3000 时两笔分别能结（只按净额 2000 判会误拦该付的那笔）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const inc = ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 5000,
  }).id;
  const exp = ldb.upsertEntry({
    bizDate: '2026-10-06',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 3000,
  }).id;

  const row = ldb.partyLedger({ partyId: p })[0];
  assert.strictEqual(row.netCents, 2000, '净额只有 2000');
  assert.strictEqual(row.unsettledPayableCents, 3000, '但应付方向仍有 3000 可结');
  assert.strictEqual(row.unsettledReceivableCents, 5000);

  const paid = ldb.createSettlement({ partyId: p, settleDate: '2026-10-20', direction: 'pay', entryIds: [exp] });
  assert.strictEqual(paid.amountCents, 3000, '付 3000 必须成功（这正是只按净额判会误拦的那笔）');
  const got = ldb.createSettlement({ partyId: p, settleDate: '2026-10-21', direction: 'receive', entryIds: [inc] });
  assert.strictEqual(got.amountCents, 5000);
  assert.strictEqual(ldb.partyLedger({ partyId: p })[0].unsettledCents, 0);
});

// ---------------------------------------------------------------------------
console.log('\n[8] 批量变更相关人（三路）/ 单店取数 / 汇总体检');
// ---------------------------------------------------------------------------

/**
 * 「变更相关人」现场：张三 5 条有效支出 + 1 条已作废，李四为目标人，老供应商已停用。
 *   u1 未结算 1000 ／ u2 未结算 500（"没被选中"的对照）
 *   s1 已结算 2000，独占结算单 SA
 *   s2 已结算 300，与 t1(700) 同属结算单 SB —— SB 被作废时 t1 会被"牵连"恢复成未结算
 *   eVoid 已作废（只允许出现在 preview 的 voidIds 里，绝不允许进入改挂）
 * 张三未结清 = 净 −4500 + 已结算净额 +3000 = −1500（只剩 u1 + u2）。
 */
const seedRepatch = () => {
  reset();
  const shops = seedShops();
  const from = party('张三');
  const to = party('李四');
  const dead = party('老供应商');
  ldb.upsertParty({ id: dead, name: '老供应商', archived: true });
  const mk = (bizDate, amountCents) =>
    ldb.upsertEntry({ bizDate, kind: 'expense', scope: 'shop', shopId: shops.A, partyId: from, amountCents }).id;
  const u1 = mk('2026-10-05', 1000);
  const u2 = mk('2026-10-05', 500);
  const s1 = mk('2026-10-06', 2000);
  const s2 = mk('2026-10-06', 300);
  const t1 = mk('2026-10-06', 700);
  const sa = ldb.createSettlement({ partyId: from, settleDate: '2026-10-20', direction: 'pay', entryIds: [s1] });
  const sb = ldb.createSettlement({ partyId: from, settleDate: '2026-10-21', direction: 'pay', entryIds: [s2, t1] });
  const eVoid = mk('2026-10-08', 700);
  ldb.voidEntry(eVoid, '记错了');
  return { shops, from, to, dead, u1, u2, s1, s2, t1, sa: sa.id, sb: sb.id, eVoid };
};

const owner = (id) => ldb.getEntry(id).partyId;
const transfers = () => dbQuery(`SELECT COUNT(*) AS n FROM bk_transfers`)[0].n;

check('preview：未结算/已结算分开计数，两条路各给一个"原人改挂后剩多少"（不能是同一个数）', () => {
  const { from, u1, u2, s2, sb } = seedRepatch();
  const pv = ldb.repatchPreview({ entryIds: [u1, s2] });
  assert.strictEqual(pv.unsettledCount, 1);
  assert.strictEqual(pv.unsettledCents, 1000);
  assert.strictEqual(pv.settledCount, 1);
  assert.strictEqual(pv.settledCents, 300);
  assert.strictEqual(pv.recommended, 'move-unsettled', '有已结算条目时不能推荐 A 路');

  const imp = pv.fromParties.find((r) => r.partyId === from);
  assert.strictEqual(imp.selectedCount, 2);
  assert.strictEqual(imp.selectedCents, 1300);
  assert.strictEqual(imp.selectedSettledCount, 1);
  assert.strictEqual(imp.selectedSettledCents, 300);
  assert.strictEqual(imp.unsettledCents, -1500, '张三改挂前的未结清 = u1 + u2');
  // B 路只带走 u1(1000)：u2 还在途
  assert.strictEqual(imp.afterMoveCents, -500);
  // C 路作废 SB：s2 跟着走，但同单的 t1(700) 被恢复成未结算留在张三名下
  assert.strictEqual(imp.afterVoidMoveCents, -1200);
  assert.notStrictEqual(imp.afterMoveCents, imp.afterVoidMoveCents, '两条路的后果必须能区分开');
  assert.strictEqual(pv.collateralEntryCount, 1, '作废 SB 会牵连 1 条没被选中的账');
  const st = pv.settlements.find((s) => s.id === sb);
  assert.strictEqual(st.entryCount, 2);
  assert.strictEqual(st.selectedCount, 1);
  assert.strictEqual(st.amountCents, 1000, '结算金额由数据层给，界面不自己加');
  assert.strictEqual(owner(u2), from, '没被选中的条目不该出现在预览里也不该被算进影响');
});

check('preview 把"不存在"与"已作废"分成两个清单（混成一个就不知道该提示用户哪一句）', () => {
  const { u1, s1, eVoid } = seedRepatch();
  const pv = ldb.repatchPreview({ entryIds: [u1, s1, eVoid, 999999] });
  assert.deepStrictEqual(pv.missingIds, [999999]);
  assert.deepStrictEqual(pv.voidIds, [eVoid]);
  assert.strictEqual(pv.entries.length, 2, '有效条目才进改挂清单');
  assert.throws(() => ldb.repatchPreview({ entryIds: [] }), /至少选择一条/);
});

check('A 路 move-all：只在全未结算时放行，余额随条目一起过去', () => {
  const { from, to, u1, u2 } = seedRepatch();
  const r = ldb.repatchEntries({ entryIds: [u1, u2], toPartyId: to, mode: 'move-all' });
  assert.strictEqual(r.movedCount, 2);
  assert.strictEqual(r.movedCents, 1500);
  assert.strictEqual(r.keptSettledCount, 0);
  assert.strictEqual(owner(u1), to);
  assert.strictEqual(owner(u2), to);
  assert.strictEqual(ldb.partyBalanceOf(to).unsettledCents, -1500, '新人的未结清接住了这笔钱');
  assert.strictEqual(ldb.partyBalanceOf(from).unsettledCents, 0, '原人在途清零（余额跟着条目走，不是靠结转）');
  assert.strictEqual(ldb.listSettlements(from).filter((s) => s.status === 'active').length, 2, '两张旧单不受影响');
});

check('A 路遇已结算条目整笔拒绝，且一个字节都没改（事务回滚，不是"改了一半"）', () => {
  const { from, to, u1, s1 } = seedRepatch();
  assert.throws(
    () => ldb.repatchEntries({ entryIds: [u1, s1], toPartyId: to, mode: 'move-all' }),
    /已结算条目不能直接改挂/,
  );
  assert.strictEqual(owner(u1), from, '同事务里的 u1 必须跟着回滚');
  assert.strictEqual(owner(s1), from);
  assert.strictEqual(transfers(), 0);
});

check('B 路只改挂未结算：已结算的留在原人与原单，且全程不写 bk_transfers', () => {
  const { from, to, u1, s2, sb } = seedRepatch();
  const r = ldb.repatchEntries({ entryIds: [u1, s2], toPartyId: to, mode: 'move-unsettled' });
  assert.strictEqual(r.movedCount, 1);
  assert.strictEqual(r.movedCents, 1000);
  assert.strictEqual(r.keptSettledCount, 1);
  assert.strictEqual(r.keptSettledCents, 300);
  assert.strictEqual(r.voidedSettlements.length, 0);
  assert.strictEqual(owner(u1), to);
  assert.strictEqual(owner(s2), from, '已结算的条目留在原人（改挂会让结算单与历史对不上）');
  assert.strictEqual(transfers(), 0, '常规 repatch 完全不碰 bk_transfers：余额随条目走，再写一笔结转等于算两遍');
  const left = r.fromParties.find((x) => x.partyId === from);
  assert.strictEqual(left.movedCount, 1);
  assert.strictEqual(left.movedCents, 1000);
  assert.strictEqual(left.remainingUnsettledCents, -500, '原人还剩 u2 的 500 未结清');
  const still = ldb.listSettlements(from).find((s) => s.id === sb);
  assert.strictEqual(still.status, 'active');
  assert.strictEqual(still.amountCents, 1000, 'B 路不能顺手改动任何结算单');
});

check('B 路在"全都已结算"时拒绝并指向 C 路（静默改挂 = 悄悄把已结的钱挪走）', () => {
  const { to, s1 } = seedRepatch();
  assert.throws(
    () => ldb.repatchEntries({ entryIds: [s1], toPartyId: to, mode: 'move-unsettled' }),
    /都已被结算.*撤销结算后改挂/s,
  );
});

check('C 路缺原因被拦；填了原因则作废结算单、条目恢复未结算后改挂', () => {
  const { from, to, u1, s1, sb, sa } = seedRepatch();
  assert.throws(
    () => ldb.repatchEntries({ entryIds: [s1], toPartyId: to, mode: 'void-then-move', reason: '   ' }),
    /必须填写原因/,
  );
  assert.strictEqual(owner(s1), from, '被拦下时不能已经改挂');
  assert.strictEqual(ldb.listSettlements(from).filter((s) => s.status === 'active').length, 2);

  const r = ldb.repatchEntries({
    entryIds: [u1, s1],
    toPartyId: to,
    mode: 'void-then-move',
    reason: '对接人换了，旧结算单作废重结',
  });
  assert.strictEqual(r.voidedSettlements.length, 1);
  assert.strictEqual(r.voidedSettlements[0].id, sa);
  assert.strictEqual(r.voidedSettlements[0].entryCount, 1);
  assert.strictEqual(r.voidedSettlements[0].amountCents, 2000);
  assert.strictEqual(r.movedCount, 2);
  assert.strictEqual(r.movedCents, 3000);
  assert.strictEqual(owner(u1), to);
  assert.strictEqual(owner(s1), to);
  assert.strictEqual(ldb.listSettlements(to).length, 0, 'C 路只作废旧单，不会顺手替新人造一张');
  const voided = ldb.listSettlements(from).find((s) => s.id === sa);
  assert.strictEqual(voided.status, 'void');
  assert.strictEqual(voided.voidReason, '对接人换了，旧结算单作废重结');
  assert.strictEqual(voided.entryCount, 0, '结算行随作废一起失活（条目不再显示已结）');
  assert.strictEqual(ldb.listSettlements(from).find((s) => s.id === sb).status, 'active', '没牵涉进去的单不受影响');
});

check('C 路连带披露：作废只结了选中条目的同单账，会牵连它恢复未结算且不跟着改挂', () => {
  const { from, to, s2, t1, sb } = seedRepatch();
  const r = ldb.repatchEntries({ entryIds: [s2], toPartyId: to, mode: 'void-then-move', reason: '重结' });
  assert.strictEqual(r.voidedSettlements[0].id, sb);
  assert.strictEqual(r.voidedSettlements[0].entryCount, 2, '回传的条数 = 这张单结了几条，不是本次选中几条');
  assert.strictEqual(r.movedCount, 1);
  assert.strictEqual(owner(s2), to);
  assert.strictEqual(owner(t1), from, '没被选中的那条只解结、不改挂');
  // 恢复未结算是真的（能再结一次），不是只把结算单标记作废而条目仍显示已结
  const again = ldb.createSettlement({ partyId: from, settleDate: '2026-10-25', direction: 'pay', entryIds: [t1] });
  assert.strictEqual(again.amountCents, 700);
  assert.strictEqual(ldb.partyBalanceOf(from).unsettledCents, -1500, 'u1 + u2 仍在途（t1 已重新结掉）');
});

check('目标人与路径的非法入参各自拒在门口（不静默改判、不留半截改动）', () => {
  const { from, to, dead, u1, eVoid } = seedRepatch();
  assert.throws(() => ldb.repatchEntries({ entryIds: [u1], toPartyId: 0, mode: 'move-all' }), /选择要改挂到的相关人/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [u1], toPartyId: 999999, mode: 'move-all' }), /目标相关人不存在/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [u1], toPartyId: dead, mode: 'move-all' }), /已停用/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [u1], toPartyId: from, mode: 'move-all' }), /已经都属于该相关人/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [u1], toPartyId: to, mode: 'whatever' }), /缺少有效路径/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [eVoid], toPartyId: to, mode: 'move-all' }), /已作废条目不能变更相关人/);
  assert.throws(() => ldb.repatchEntries({ entryIds: [999999], toPartyId: to, mode: 'move-all' }), /条条目不存在/);
  assert.strictEqual(owner(u1), from, '以上任何一次拒绝都不该留下半截改动');
});

check('单店取数：三卡 = 专属 + 本店公摊，且与汇总 byShop 同源同数', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const cat = ldb.listCategories('expense')[0];
  ldb.upsertEntry({
    bizDate: '2026-10-05',
    kind: 'expense',
    scope: 'shop',
    shopId: shops.A,
    categoryId: cat.id,
    partyId: p,
    amountCents: 133050,
  });
  ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    categoryId: cat.id,
    partyId: p,
    amountCents: 200000,
    allocations: [
      { shopId: shops.A, amountCents: 120000, ratioBp: 6000 },
      { shopId: shops.B, amountCents: 80000, ratioBp: 4000 },
    ],
  });
  const inc = ldb.listCategories('income')[0];
  ldb.upsertEntry({
    bizDate: '2026-10-15',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    categoryId: inc.id,
    partyId: p,
    amountCents: 500000,
  });

  const bd = ldb.shopBreakdown({ shopId: shops.A, period: '2026-10' });
  assert.strictEqual(bd.shopName, '店A');
  assert.strictEqual(bd.directExpenseCents, 133050);
  assert.strictEqual(bd.sharedExpenseCents, 120000, '公共条目摊到本店的部分要算进这家店的支出');
  assert.strictEqual(bd.expenseCents, 253050);
  assert.strictEqual(bd.incomeCents, 500000);
  assert.strictEqual(bd.balanceCents, 500000 - 253050);

  const catRow = bd.byCategory.find((c) => c.categoryId === cat.id && c.kind === 'expense');
  assert.strictEqual(catRow.directCents, 133050);
  assert.strictEqual(catRow.sharedCents, 120000);
  assert.strictEqual(catRow.amountCents, 253050);
  assert.strictEqual(bd.sharedEntries.length, 1);
  assert.strictEqual(bd.sharedEntries[0].entryCents, 200000, '整笔金额要和摊入金额并排给出');
  assert.strictEqual(bd.sharedEntries[0].amountCents, 120000);
  assert.strictEqual(bd.sharedEntries[0].ratioBp, 6000);

  // 同一件事只能有一处实现：单店页与汇总页必须落在同一组数上
  const sum = ldb.ledgerSummary({ period: '2026-10' });
  const row = sum.byShop.find((s) => s.shopId === shops.A);
  assert.strictEqual(row.directExpenseCents, bd.directExpenseCents);
  assert.strictEqual(row.sharedExpenseCents, bd.sharedExpenseCents);
  assert.strictEqual(row.incomeCents, bd.incomeCents);
  assert.strictEqual(row.balanceCents, bd.balanceCents);
  assert.strictEqual(row.sharedEntryCount, 1);

  // 四项体检恒 0，且 Σ各店结余 == 总收入 − 总支出
  assert.strictEqual(sum.integrity.allocationGapCents, 0);
  assert.strictEqual(sum.integrity.partyGapCents, 0);
  assert.strictEqual(sum.integrity.publicPoolCents, 0);
  assert.strictEqual(sum.integrity.brokenEntries.length, 0);
  assert.strictEqual(
    sum.byShop.reduce((s, r) => s + r.balanceCents, 0),
    sum.incomeCents - sum.expenseCents,
  );
});

check('单店取数：作废条目不计入、空月份给全 0、非法入参直接拒', () => {
  const { shops, u1 } = seedRepatch();
  const withVoid = ldb.shopBreakdown({ shopId: shops.A, period: '2026-10' });
  assert.strictEqual(withVoid.expenseCents, 4500, '五条有效条目合计 4500，已作废那条 700 不算');
  ldb.voidEntry(u1, '重记');
  assert.strictEqual(ldb.shopBreakdown({ shopId: shops.A, period: '2026-10' }).expenseCents, 3500);

  const empty = ldb.shopBreakdown({ shopId: shops.B, period: '2026-10' });
  assert.strictEqual(empty.incomeCents, 0);
  assert.strictEqual(empty.expenseCents, 0);
  assert.strictEqual(empty.balanceCents, 0);
  assert.deepStrictEqual(empty.byCategory, []);
  assert.deepStrictEqual(empty.sharedEntries, []);
  assert.strictEqual(ldb.shopBreakdown({ shopId: shops.A, period: '2026-09' }).expenseCents, 0);

  assert.throws(() => ldb.shopBreakdown({ shopId: 0, period: '2026-10' }), /选择店铺/);
  assert.throws(() => ldb.shopBreakdown({ shopId: 999999, period: '2026-10' }), /店铺不存在/);
});

check('体检能变红：人为制造漏摊，三项数各自报出对应的差额（不能互相顶包）', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 2000,
    allocations: [
      { shopId: shops.A, amountCents: 1000 },
      { shopId: shops.B, amountCents: 1000 },
    ],
  });
  // 绕过写入口直接删一行分摊（模拟历史坏数据）
  dbRun(`DELETE FROM bk_allocations WHERE entry_id = ? AND shop_id = ?`, [r.id, shops.B]);
  const sum = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(sum.integrity.allocationGapCents, -1000, '分摊合计比条目金额少 1000');
  assert.strictEqual(sum.integrity.publicPoolCents, -1000, '店B 少摊 1000，公共池就悬着 1000');
  assert.deepStrictEqual(sum.integrity.brokenEntries, [{ entryId: r.id, amountCents: 2000, allocatedCents: 1000 }]);
  // 漏摊只打在店铺轴上：相关人净往来仍等于 总收入 − 总支出
  assert.strictEqual(sum.integrity.partyGapCents, 0);
  // 漏摊在店铺轴上的表现：店B 连一行分摊都没有 → 汇总里整家店消失（不是显示 0）
  assert.strictEqual(sum.byShop.length, 1);
  assert.strictEqual(sum.byShop[0].sharedExpenseCents, 1000);
  assert.strictEqual(sum.sharedExpenseCents, 2000, '条目侧的公共金额仍是全额，缺的是分摊行');
  assert.strictEqual(sum.sharedIncomeCents, 0);
});

check('体检③ 能变红：条目挂在不存在的相关人上时 partyGap 非 0，并给出具体条目', () => {
  reset();
  const shops = seedShops();
  const p = party('张三');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-10',
    kind: 'income',
    scope: 'shop',
    shopId: shops.A,
    partyId: p,
    amountCents: 5000,
  });
  // 绕过删人保护直接删行（模拟手改库 / 旧数据悬空）：这才是这个体检项**本该**抓到的情形。
  // 旧实现里 Σ净往来 与「总收入 − 总支出」是同一个 bk_entries 表达式的两种拼法，相减恒为 0。
  dbRun(`DELETE FROM bk_parties WHERE id = ?`, [p]);
  const sum = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(sum.integrity.partyGapCents, -5000, '台账少了一笔收入，差额正好是它的金额（取负）');
  assert.deepStrictEqual(sum.integrity.missingPartyEntries, [{ entryId: r.id, amountCents: 5000 }]);
});

// ---------------------------------------------------------------------------
console.log('\n[12] 批量导入（自动建人 / 科目）');
// ---------------------------------------------------------------------------

/** 导入一行：只有名字、没有 id（界面就是这么送的：partyId=0 + partyName） */
const importRow = (over = {}) => ({
  id: 0,
  bizDate: '2026-10-03',
  kind: 'expense',
  scope: 'shop',
  shopId: 0,
  partyId: 0,
  categoryId: 0,
  amountCents: 100,
  ...over,
});

check('名字缺失自动新建相关人/科目；同一批里同名只建一个，并如实返回新建清单', () => {
  reset();
  const shops = seedShops();
  const res = ldb.batchCreateEntries([
    importRow({ shopId: shops.A, partyName: '新房东', categoryName: '水电', amountCents: 100 }),
    importRow({ shopId: shops.A, partyName: '新房东', categoryName: '水电', amountCents: 200 }),
    importRow({ shopId: shops.C, partyName: '新房东', categoryName: '水电', amountCents: 300 }),
  ]);
  assert.strictEqual(res.created, 3);
  assert.deepStrictEqual(res.createdParties, ['新房东'], '同名三行只能建一个相关人');
  assert.deepStrictEqual(res.createdCategories, ['水电'], '同名科目只能建一个');

  const parties = ldb.listParties({}).filter((p) => p.name === '新房东');
  assert.strictEqual(parties.length, 1);
  assert.strictEqual(parties[0].kind, 'other', '文件里没有"这个人是什么身份"，不许猜成房东/供应商');
  const cats = ldb.listCategories('expense', true).filter((c) => c.name === '水电');
  assert.strictEqual(cats.length, 1);
  assert.strictEqual(cats[0].kind, 'expense');

  // 三笔都挂在同一个新建 id 上（不是每行各建一个）
  const rows = ldb.listEntries({ period: '2026-10' });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(new Set(rows.map((r) => r.partyId)).size, 1);
  assert.strictEqual(rows[0].partyId, parties[0].id);
});

check('第二行坏 → 整批退回：连第一行新建的相关人也不留下', () => {
  reset();
  const shops = seedShops();
  assert.throws(
    () =>
      ldb.batchCreateEntries([
        importRow({ shopId: shops.A, partyName: '临时甲' }),
        importRow({ shopId: shops.A, partyName: '临时乙', bizDate: '' }),
      ]),
    /第 2 行/,
  );
  assert.strictEqual(
    ldb.listParties({ includeArchived: true }).filter((p) => p.name.startsWith('临时')).length,
    0,
    '批事务回滚必须把自动新建的相关人也带走',
  );
  assert.strictEqual(ldb.listEntries({ period: '2026-10' }).length, 0);
});

check('名字命中已停用的人 / 科目 → 报错带行号，不静默启用、也不另建一个同名', () => {
  reset();
  const shops = seedShops();
  const pid = party('老王');
  ldb.upsertParty({ id: pid, name: '老王', archived: true });
  assert.throws(
    () => ldb.batchCreateEntries([importRow({ shopId: shops.A, partyName: '老王' })]),
    /第 1 行：相关人「老王」已停用/,
  );
  assert.strictEqual(ldb.listParties({ includeArchived: true }).filter((p) => p.name === '老王').length, 1);
  assert.strictEqual(ldb.listEntries({ period: '2026-10' }).length, 0);
});

check('按营收占比的公共条目能摊到退店的店（退店不是"不算了"）', () => {
  reset();
  const shops = seedShops();
  const p = party('房东');
  const r = ldb.upsertEntry({
    bizDate: '2026-10-20',
    kind: 'expense',
    scope: 'shared',
    partyId: p,
    amountCents: 999,
    basis: 'equal',
    allocations: [
      { shopId: shops.A, amountCents: 333 },
      { shopId: shops.B, amountCents: 333 },
      { shopId: shops.C, amountCents: 333 },
    ],
  });
  const detail = ldb.getEntry(r.id);
  assert.deepStrictEqual(detail.allocations.map((a) => a.shopId).sort(), [shops.A, shops.B, shops.C].sort());
  const sum = ldb.ledgerSummary({ period: '2026-10' });
  assert.strictEqual(sum.integrity.publicPoolCents, 0, '退店那 333 分也要落在店铺轴上，不能悬在公共池');
  assert.ok(sum.byShop.some((s) => s.shopId === shops.C), '汇总的店铺轴里必须有退店的店');
});

// ---------------------------------------------------------------------------
try {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 记账数据层冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log(`\u2713 记账数据层冒烟全部通过\n`);
// 显式退出：不写的话进程靠 Electron 在无 GUI 环境里崩退（退出码是 SIGTRAP），看起来像冒烟失败。
process.exit(0);
