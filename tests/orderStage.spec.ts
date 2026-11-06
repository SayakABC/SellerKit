// 「每张订单准备到哪一档」的契约用例（2026-11-05）。
//
// 这一层回答的是用户原话：「准备完成，就代表这个订单已经完成了准备」—— 所以它必须给出
// **每张单一个档**，而不是"整批走到第几步"。钉的是关系，不是实现：
//
//   · 四档之和 + `unknown` === 待发货单数（与 `shippingPulse.pending` 同一个数）；
//   · 每张单**恰好**落一档（木桶：明细行里最差的那一行说了算）；
//   · 读不到覆盖度 ⇒ `unknown`，**绝不**默认 `ready`（默认完成会让用户当天少发一批货）；
//   · 在平台上已经发货的单**不在队列里**（不是"第五档"，是自动离队）。
//
// ⚠️ 每条正向用例都配一条**变异**（把判据改坏，断言必须变红）—— 见文件末尾 `变异` 段。
//    "用例全绿"不等于"守卫有效"：`ready` 恒真、`noImage` 判定删掉，正向用例照样能绿。
import { describe, expect, it } from 'vitest';
import {
  ORDER_STAGE_ACTION,
  ORDER_STAGE_LABEL,
  ORDER_STAGE_ORDER,
  emptyStageCounts,
  orderStages,
  stageLineLabel,
  stageTotal,
  type OrderStage,
} from '../src/lib/orderStage';
import { shippingPulse, type PulseRow } from '../src/lib/shippingPulse';
import { planCoverage } from '../src/lib/orderCoverage';
import { takenKey } from '../src/lib/picking';

/** 现在（固定值：不传 `now` 的断言会随运行时刻漂） */
const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime();

/** 一行订单（默认：待发货、有图、已归类、1 件、30 天后到截止） */
function row(over: Partial<PulseRow> = {}): PulseRow {
  return {
    id: 1,
    orderNo: 'O1',
    bizStatus: '等待卖家发货',
    dealDeadline: '2026-12-05 12:00:00',
    imageId: 7,
    localPath: '/img/1.png',
    qty: 1,
    shop: '店A',
    styleCode: 'S1',
    styleColor: '黑',
    color: '黑',
    size: 'L',
    styleColorId: 11,
    ...over,
  };
}

const plan = (rows: PulseRow[] | null | undefined, opts: Parameters<typeof orderStages>[1] = {}) =>
  orderStages(rows, { now: NOW, ...opts });

/** 一档有几单 */
const countOf = (rows: PulseRow[], stage: OrderStage): number => plan(rows).counts[stage];

describe('订单档：四档 + 判不出来', () => {
  it('有图有款色、货也够 ⇒ 已备齐', () => {
    const p = plan([row({ id: 1, qty: 2 })], { covered: { '1': 2 } });
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]!.stage).toBe('ready');
    expect(p.orders[0]!.gap).toBe(0);
    expect(p.counts.ready).toBe(1);
  });

  it('没行图 ⇒ 缺图（即便货已经拿齐：印不了，拿货再齐也没用）', () => {
    const p = plan([row({ id: 1, imageId: 0, qty: 1 })], { covered: { '1': 1 } });
    expect(p.orders[0]!.stage).toBe('noImage');
    expect(p.orders[0]!.lines[0]!.stage).toBe('noImage');
  });

  it('有图但没归到款色 ⇒ 待归类（这时"货够不够"根本没到判的时候）', () => {
    const p = plan([row({ id: 1, styleColorId: 0 })], { covered: { '1': 1 } });
    expect(p.orders[0]!.stage).toBe('unclassified');
  });

  it('图款齐但拿的不够 ⇒ 待拿货，且还差件数是 qty − 已拿', () => {
    const p = plan([row({ id: 1, qty: 3 })], { covered: { '1': 1 } });
    expect(p.orders[0]!.stage).toBe('waitingStock');
    expect(p.orders[0]!.gap).toBe(2);
    expect(p.orders[0]!.lines[0]!.gap).toBe(2);
  });

  it('一件都没拿 ⇒ 待拿货（不是"待核对"：0 是**读到了**的结果，不是读不到）', () => {
    const p = plan([row({ id: 1, qty: 2 })], { covered: {} });
    expect(p.orders[0]!.stage).toBe('waitingStock');
    expect(p.orders[0]!.gap).toBe(2);
  });
});

describe('木桶：订单档 = 明细行里最差的那一档', () => {
  it('一单三行（差货 / 缺图 / 齐）⇒ 订单落缺图，卡住行数 = 2，且卡住的行排在前面', () => {
    const p = plan(
      [
        row({ id: 11, orderNo: 'A', qty: 2 }),
        row({ id: 12, orderNo: 'A', qty: 1, imageId: 0 }),
        row({ id: 13, orderNo: 'A', qty: 1 }),
      ],
      { covered: { '11': 0, '13': 1 } }
    );
    const a = p.orders[0]!;
    expect(a.orderNo).toBe('A');
    expect(a.pieces).toBe(4);
    // 还差 = 2（行 11 一件没拿）+ 1（行 12 没拿，缺图的行也照样要货）+ 0（行 13 齐了）
    expect(a.gap).toBe(3);
    expect(a.blocked).toBe(2);
    expect(a.stage).toBe('noImage');
    // 卡住的行在前：12（noImage）→ 11（waitingStock）→ 13（ready）
    expect(a.lines.map((l) => l.orderItemId)).toEqual([12, 11, 13]);
  });

  it('一行的缺口"读不到"不会把订单说成已备齐，也不会盖过另一行确定的差货', () => {
    // 12 有行身份但没有覆盖度（无归属台账也没有）⇒ covered 0，确实差货；
    // 这里的重点是：`id = 0` 的行落 unknown，而它**不该**让整单变成 ready。
    const p = plan([row({ id: 0, qty: 1 })], { covered: {} });
    expect(p.orders[0]!.stage).toBe('unknown');
    expect(p.orders[0]!.lines[0]!.covered).toBeNull();
    // 缺口算不出来 ⇒ 界面上的"还差 N 件"是偏小的，必须能说出来
    expect(p.orders[0]!.gapUnknown).toBe(true);
  });

  it('同一单里一行确定差货 + 一行读不到 ⇒ 仍然是待拿货（确定的结论不被"不知道"降级）', () => {
    const p = plan(
      [
        row({ id: 21, orderNo: 'B', qty: 1 }),
        row({ id: 0, orderNo: 'B', qty: 1 }),
      ],
      { covered: {} }
    );
    expect(p.orders[0]!.stage).toBe('waitingStock');
    expect(p.orders[0]!.gapUnknown).toBe(true);
  });
});

describe('不变式：四档之和 = 待发货单数', () => {
  const rows = [
    row({ id: 1, orderNo: 'A', qty: 1 }), // ready
    row({ id: 2, orderNo: 'B', imageId: 0 }), // noImage
    row({ id: 3, orderNo: 'C', styleColorId: 0 }), // unclassified
    row({ id: 4, orderNo: 'D', qty: 3 }), // waitingStock
    row({ id: 5, orderNo: 'E', bizStatus: '已发货' }), // 已发出 ⇒ 不在队列里
    row({ id: 6, orderNo: 'F', bizStatus: '已关闭' }), // 已关闭 ⇒ 不在队列里
    row({ id: 7, orderNo: 'G' }), // 与 A 同档，验证计数不是"按档去重单号"
  ];

  it('四张待发货单各落一档，合计 = pending（已发出/已关闭的不算）', () => {
    const p = plan(rows, { covered: { '1': 1, '7': 1 } });
    expect(p.counts).toEqual({
      noImage: 1,
      unclassified: 1,
      waitingStock: 1,
      ready: 2,
      unknown: 0,
    });
    expect(stageTotal(p.counts)).toBe(5);
    expect(stageTotal(p.counts)).toBe(shippingPulse(rows, { now: NOW }).pending);
  });

  it('每张单恰好出现一次（不会因为多行重复计数）', () => {
    const p = plan(
      [row({ id: 1, orderNo: 'A' }), row({ id: 2, orderNo: 'A' }), row({ id: 3, orderNo: 'B' })],
      { covered: { '1': 1, '2': 1, '3': 1 } }
    );
    expect(p.orders.map((o) => o.orderNo)).toEqual(['A', 'B']);
    expect(stageTotal(p.counts)).toBe(2);
  });

  it('`emptyStageCounts` 的键与订单档一一对应（加一档忘了加计数会在这里红）', () => {
    const keys = Object.keys(emptyStageCounts()).sort();
    const stages: OrderStage[] = ([...ORDER_STAGE_ORDER, 'unknown'] as OrderStage[]).sort();
    expect(keys).toEqual(stages);
  });
});

describe('读不到覆盖度 ⇒ 待核对（绝不默认已备齐）', () => {
  it('`coverageKnown: false` 时，图款都齐的单也落 unknown', () => {
    const p = plan([row({ id: 1, qty: 1 })], { coverageKnown: false });
    expect(p.coverageKnown).toBe(false);
    expect(p.orders[0]!.stage).toBe('unknown');
    expect(p.orders[0]!.lines[0]!.covered).toBeNull();
    expect(p.counts.ready).toBe(0);
  });

  it('图 / 款这两档不受覆盖度影响（它们不依赖拿货记录）', () => {
    const p = plan([row({ id: 1, imageId: 0 }), row({ id: 2, orderNo: 'O2', styleColorId: 0 })], {
      coverageKnown: false,
    });
    expect(p.counts.noImage).toBe(1);
    expect(p.counts.unclassified).toBe(1);
  });
});

describe('件数与已拿：与待发货清单同一套口径', () => {
  it('件数缺失按 1 计，并标 assumedQty（不许让它看起来像个确定的数）', () => {
    const p = plan([row({ id: 1, qty: null })], { covered: { '1': 1 } });
    expect(p.orders[0]!.pieces).toBe(1);
    expect(p.orders[0]!.lines[0]!.assumedQty).toBe(true);
    expect(p.orders[0]!.stage).toBe('ready');
  });

  it('件数只认一处：`qty` 列给了就以它为准，不再去报表原文里解析（否则同一行两个件数）', () => {
    // 报表原文写着 9 件，而采集写进来的 qty = 2 —— 若有人让 `resolveQty` 去解析 rawFields，
    // 这里会变成 9，"还差"凭空多出 7 件。
    const p = plan([{ ...row({ id: 1, qty: 2 }), rawFields: { 数量: '9' } }], { covered: {} });
    expect(p.orders[0]!.lines[0]!.qty).toBe(2);
    expect(p.orders[0]!.gap).toBe(2);
  });

  it('无归属台账按款色码摊过来时标 estimated（那是推算，不是事实）', () => {
    const pool = { [takenKey('S1', '黑', 'L')]: 1 };
    const p = plan([row({ id: 1, qty: 1 })], { covered: {}, pool });
    expect(p.orders[0]!.stage).toBe('ready');
    expect(p.orders[0]!.lines[0]!.estimated).toBe(true);
  });

  it('未识别款的行不摊池子（空键会把同色同码的不同商品并成一格）', () => {
    const pool = { [takenKey('', '', '')]: 5 };
    const p = plan([row({ id: 1, qty: 1, styleColorId: 0 })], { covered: {}, pool });
    expect(p.orders[0]!.stage).toBe('unclassified');
    expect(p.orders[0]!.lines[0]!.covered).toBe(0);
  });
});

describe('顺序与展示', () => {
  it('订单按最晚发货时间排，没有截止期的垫底（不知道 ≠ 不着急）', () => {
    const p = plan([
      row({ id: 1, orderNo: 'SOON', dealDeadline: '2026-11-05 18:00:00' }),
      row({ id: 2, orderNo: 'LATE', dealDeadline: '2026-12-05 12:00:00' }),
      row({ id: 3, orderNo: 'NONE', dealDeadline: '' }),
    ]);
    expect(p.orders.map((o) => o.orderNo)).toEqual(['SOON', 'LATE', 'NONE']);
    expect(Number.isNaN(p.orders[2]!.remainMs)).toBe(true);
  });

  it('同一单多行截止期不一致时取更急的那个（显示坏数据比替它圆谎有用）', () => {
    const p = plan([
      row({ id: 1, orderNo: 'A', dealDeadline: '2026-12-05 12:00:00' }),
      row({ id: 2, orderNo: 'A', dealDeadline: '2026-11-05 13:00:00' }),
    ]);
    expect(p.orders[0]!.deadlineRaw).toBe('2026-11-05 13:00:00');
    expect(p.orders[0]!.risk).toBe(true);
    expect(p.orders[0]!.overdue).toBe(false);
  });

  it('没有单号的行也出现在清单里（按行 id 归组，不静默吞掉）', () => {
    const p = plan([row({ id: 9, orderNo: '' })]);
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]!.orderNo).toBe('');
  });

  it('四档都有界面词与动作词，且分组顺序不含 unknown', () => {
    for (const s of ORDER_STAGE_ORDER) {
      expect(ORDER_STAGE_LABEL[s]).toBeTruthy();
      expect(ORDER_STAGE_ACTION[s]).toBeTruthy();
    }
    expect(ORDER_STAGE_ORDER).not.toContain('unknown');
    expect(ORDER_STAGE_LABEL.unknown).toBeTruthy();
  });

  it('明细行的一句话写清 款/色/码 × 件数 与还差几件', () => {
    const p = plan([row({ id: 1, orderNo: 'A', qty: 3 })], { covered: { '1': 1 } });
    const text = stageLineLabel(p.orders[0]!.lines[0]!);
    expect(text).toContain('S1 · 黑 · L');
    expect(text).toContain('× 3');
    expect(text).toContain('还差 2');
  });

  it('空输入不炸，返回四个 0', () => {
    const p = plan([]);
    expect(p.orders).toEqual([]);
    expect(stageTotal(p.counts)).toBe(0);
    expect(plan(undefined).orders).toEqual([]);
  });
});

// ── 变异（把判据改坏，下面这些断言必须变红）────────────────────────────────
//
// 这是"用例全绿 ≠ 守卫有效"的解药：`ready` 恒真时，上面所有正向用例里
// "ready" 那几条仍然会绿（它们本来就期望 ready）。所以这里直接钉住**反向**结论。
describe('变异守卫：把判据改坏必须红', () => {
  it('把"没图"当已备齐 ⇒ 这条会红（`noImage` 判定不许被删掉）', () => {
    const p = plan([row({ id: 1, imageId: 0, qty: 1 })], { covered: { '1': 1 } });
    expect(p.counts.ready).not.toBe(1);
    expect(p.counts.noImage).toBe(1);
  });

  it('把"读不到覆盖度"当 0 件已拿 ⇒ 这条会红（它会变成待拿货而不是待核对）', () => {
    const p = plan([row({ id: 1, qty: 1 })], { coverageKnown: false });
    expect(p.orders[0]!.stage).not.toBe('waitingStock');
    expect(p.orders[0]!.lines[0]!.covered).toBeNull();
  });

  it('把"已发出"也算进队列 ⇒ 合计会 ≠ pending（这条同时是"它该自动离队"的守卫）', () => {
    const rows = [row({ id: 1 }), row({ id: 2, orderNo: 'O2', bizStatus: '已发货' })];
    const p = plan(rows, { covered: { '1': 1, '2': 1 } });
    expect(stageTotal(p.counts)).toBe(1);
    expect(stageTotal(p.counts)).toBe(shippingPulse(rows, { now: NOW }).pending);
    expect(shippingPulse(rows, { now: NOW }).pending).toBe(1);
  });
});

describe('RK-2 交叉断言：订单屏与拿货页「按单核对」对同一批行必须同结论', () => {
  // 为什么要这一条（方案 §5 RK-2）：两处都在回答"这单货齐了没"，
  // 但**入口不同**——订单屏读 `orderStages`（今天待发货），拿货页读 `planCoverage`
  // （跨天未发货，时间窗更宽）。口径唯一的做法不是让后者改读前者（那会把窗口
  // 窄化成"今天"、历史单凭空消失），而是钉住"喂同一批行时必须给出同一个结论"。
  // 一旦有人给某一侧换掉件数口径（`qty` vs 报表列 vs 按 1 兜底），两边立刻分叉 ⇒ 这里红。
  const rows = [
    row({ id: 1, orderNo: 'A', qty: 2 }),
    row({ id: 2, orderNo: 'A', qty: 1, styleColor: '白' }), // 同一单的第二行：两行都齐才算齐
    row({ id: 3, orderNo: 'B', qty: 3 }),
  ];

  it('同一批行：两层的单集合一致，且每张「已备齐」单的每一行都已足量', () => {
    const covered = { '1': 2, '2': 1, '3': 3 };
    const p = plan(rows, { covered });
    const cov = planCoverage(rows, { covered });

    // ① 单集合一致（谁也没少收一张）
    const covNodes = [...new Set(cov.rows.map((r) => r.orderNo))].sort();
    expect(covNodes).toEqual(p.orders.map((o) => o.orderNo).sort());

    // ② 每张 ready 单的**每一行**都能在 planCoverage 里找到"已足量"的对应行
    //    （订单档 = 木桶最差那行 ⇒ 有任意一行没齐，它就不可能是 ready）
    const byId = new Map(cov.rows.map((r) => [r.orderItemId, r]));
    for (const o of p.orders.filter((x) => x.stage === 'ready')) {
      expect(o.lines.length).toBeGreaterThan(0);
      for (const l of o.lines) {
        const c = byId.get(l.orderItemId);
        expect(c).toBeTruthy();
        expect(c!.covered).toBe(c!.qty); // 足量（不是"差 0 件但 covered 少 1"这类擦边）
      }
    }
    expect(p.counts.ready).toBe(2); // A、B 都齐
  });

  it('把某单的一行少给 1 件 ⇒ 两层同时改口（漂移会立刻暴露）', () => {
    const covered = { '1': 2, '2': 1, '3': 2 }; // B 差 1 件
    const p = plan(rows, { covered });
    const cov = planCoverage(rows, { covered });

    const bOrder = p.orders.find((o) => o.orderNo === 'B')!;
    expect(bOrder.stage).toBe('waitingStock');
    expect(bOrder.gap).toBe(1);

    const bRows = cov.rows.filter((r) => r.orderNo === 'B');
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.qty - bRows[0]!.covered).toBe(bOrder.gap); // 同一个缺口数，两处算一次
  });
});
