// 「总览 · 今天要发」四个数的契约用例（2026-10-22）。
//
// 钉的是**关系**，不是某个实现：
//   · `已拿 + 还差 === 件数` 恒成立（这一屏唯一能自证的地方：账对不上，四个数就都不被信任）；
//   · 已拿按**款色码**从台账扣，且**逐 SKU 夹到需求以内**（同款两行、台账比需求多时不许出现
//     "已拿 3 / 还差 −1"或"已拿 3 / 共 2 件"）；
//   · 已终结（关闭/完成）的行**剔掉并计数**，不当成"要发的货"；
//   · 件数走 `resolveQty`（明细 qty → 报表 `商品数量` → 按 1 件并计入 `assumedQty`）；
//   · 未识别款的行照收件数（漏掉就是悄悄少算），只是扣不到已拿。
import { describe, expect, it } from 'vitest';
import { dailyShip, type DailyShipRow } from '../src/lib/dailyShip';
import { takenKey } from '../src/lib/picking';

/** 报表块形态的件数（`resolveQty` 认得的那一段） */
const reportQty = (qty: number) => `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:${qty} piece)`;

function row(over: Partial<DailyShipRow> = {}): DailyShipRow {
  return {
    orderNo: 'O1',
    qty: null,
    rawFields: { 商品信息: reportQty(1) },
    styleCode: 'S1',
    styleColor: '黑',
    color: '黑',
    size: 'L',
    bizStatus: '等待发货',
    ...over,
  };
}

/** 台账（键 = `takenKey(款, 色, 码)`，与宿主 `purchase-taken` 同一函数拼） */
function ledger(entries: [string, string, string, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, color, size, qty] of entries) {
    const k = takenKey(code, color, size);
    out[k] = (out[k] ?? 0) + qty;
  }
  return out;
}

describe('dailyShip：单 / 件 / 已拿 / 还差', () => {
  it('空输入 → 四个 0（不是 NaN，也不抛）', () => {
    const r = dailyShip([], {});
    expect(r).toMatchObject({ orders: 0, rows: 0, pieces: 0, taken: 0, remaining: 0 });
    expect(dailyShip(null)).toMatchObject({ pieces: 0, remaining: 0 });
  });

  it('按订单号去重：同一单两行 → 1 单 / 2 件', () => {
    const r = dailyShip([row({ size: 'L' }), row({ size: 'XL' })]);
    expect(r.orders).toBe(1);
    expect(r.pieces).toBe(2);
    expect(r.rows).toBe(2);
  });

  it('没有件数的地方按 1 件兜底，并**报出来**（不静默）', () => {
    const r = dailyShip([row({ rawFields: {} }), row({ orderNo: 'O2', rawFields: {} })]);
    expect(r.pieces).toBe(2);
    expect(r.assumedQty).toBe(2);
  });

  it('明细 qty 优先于报表解析（采集行的 qty 不能被报表里的数字盖掉）', () => {
    const r = dailyShip([row({ qty: 3, rawFields: { 商品信息: reportQty(1) } })]);
    expect(r.pieces).toBe(3);
    expect(r.assumedQty).toBe(0);
  });

  it('已终结（关闭/完成）的行剔掉并计数 —— 单没了，不发货', () => {
    const r = dailyShip([
      row({ orderNo: 'O1', bizStatus: '等待发货' }),
      row({ orderNo: 'O2', bizStatus: '订单关闭' }),
      row({ orderNo: 'O3', bizStatus: '交易成功' }),
    ]);
    expect(r.orders).toBe(1);
    expect(r.pieces).toBe(1);
    expect(r.excludedFinished).toBe(2);
  });

  it('台账按款色码扣：已拿 1 / 还差 = 件数 − 1（恒等式）', () => {
    const r = dailyShip([row({ qty: 3 })], { taken: ledger([['S1', '黑', 'L', 1]]) });
    expect(r).toMatchObject({ pieces: 3, taken: 1, remaining: 2 });
    expect(r.taken + r.remaining).toBe(r.pieces);
  });

  it('同一 SKU 拆两行时**按组扣一次**，不是逐行各扣一次（逐行加会把已拿乘上行数）', () => {
    // 两行同款色码各 1 件 = 需求 2；台账 1 件 ⇒ 只该扣 1 件
    const r = dailyShip([row({ qty: 1 }), row({ qty: 1 })], { taken: ledger([['S1', '黑', 'L', 1]]) });
    expect(r).toMatchObject({ pieces: 2, taken: 1, remaining: 1 });
  });

  it('台账多于需求时夹到需求以内（多拿了不是"还差负数"，也不是"已拿超过总数"）', () => {
    const r = dailyShip([row({ qty: 2 })], { taken: ledger([['S1', '黑', 'L', 5]]) });
    expect(r).toMatchObject({ pieces: 2, taken: 2, remaining: 0 });
  });

  it('未识别款的行照收件数（漏掉=少算货），但**不扣已拿**（空款编码会把不同商品并成一格）', () => {
    const r = dailyShip(
      [row({ orderNo: 'O1', styleCode: '', styleColor: '', color: '白', size: 'M', qty: 2 })],
      // 台账里**故意**放一条空款编码的记录：实现若按空串键去扣，这里就会变成已拿 2
      { taken: ledger([['', '白', 'M', 2]]) },
    );
    expect(r).toMatchObject({ orders: 1, pieces: 2, taken: 0, remaining: 2 });
  });

  it('有效色 = 款色优先、回落原文色（与拣货投影同序，否则台账键永远对不上）', () => {
    // 款色说"黑"、原文色是"5" ⇒ 台账按"黑"记的才对得上
    const r = dailyShip([row({ styleColor: '黑', color: '5', qty: 1 })], {
      taken: ledger([['S1', '黑', 'L', 1]]),
    });
    expect(r.taken).toBe(1);
    // 反过来：款色为空 ⇒ 用原文色
    const r2 = dailyShip([row({ styleColor: '', color: '5', qty: 1 })], {
      taken: ledger([['S1', '5', 'L', 1]]),
    });
    expect(r2.taken).toBe(1);
  });

  it('没有台账（一件没拿）→ 已拿 0、还差 = 件数（缺省与传空对象同行为）', () => {
    const a = dailyShip([row({ qty: 4 })]);
    const b = dailyShip([row({ qty: 4 })], { taken: null });
    expect(a).toMatchObject({ taken: 0, remaining: 4 });
    expect(b).toEqual(a);
  });

  // ---- 以下 3 例钉 2026-10-22 起的**逐行精确**口径（`covered`）----
  // 之前只能按款色码整批摊：两行同款色码时，"已拿"只能按总量算，说不清是哪一行拿的。

  it('逐行精确：同款色码两行，只有一行被拿货单指到 ⇒ 已拿 1 件（不是两行各算一次）', () => {
    const r = dailyShip(
      [
        row({ id: 1, orderNo: 'O1', qty: 1 }),
        row({ id: 2, orderNo: 'O2', qty: 1 }),
      ],
      { covered: { '2': 1 } },
    );
    expect(r).toMatchObject({ orders: 2, pieces: 2, taken: 1, remaining: 1 });
    expect(r.taken + r.remaining).toBe(r.pieces);
  });

  it('精确 + 无归属池子**不重复**：已按行归属的那件不再从池子里扣一次', () => {
    const r = dailyShip([row({ id: 1, qty: 1 })], {
      covered: { '1': 1 },
      pool: ledger([['S1', '黑', 'L', 1]]),
    });
    expect(r).toMatchObject({ pieces: 1, taken: 1, remaining: 0 });
  });

  it('有推算成分时 `estimated` 报出来（界面要说"含历史拿货，按总量估算"）', () => {
    const exact = dailyShip([row({ id: 1, qty: 1 })], { covered: { '1': 1 } });
    expect(exact.estimated).toBe(false);
    const guess = dailyShip([row({ id: 2, qty: 1 })], { pool: ledger([['S1', '黑', 'L', 1]]) });
    expect(guess.estimated).toBe(true);
  });
});
