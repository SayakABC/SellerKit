// 「拣货单」纯计算层的契约用例。
//
// 钉住的是**口径**而不是实现：
//   · 件数走 `orderCost.resolveQty`（结算商品行真值 → 报表块 `商品数量` → 按 1 件并**标缺**）；
//   · 分组键走 `orderCost.skuKey`（缺色/缺码/未识别款**各自成组**，不合并、不丢行）；
//   · 缺口**逐组计数**（缺图 / 缺件数 / 缺供应商 / 未识别款）—— 拣货单漏一行就是少发一件货；
//   · 范围（默认"未发货 · 近 30 天"）：**已终结（关闭/已完成）剔除**、超窗剔除、**无日期照收**，三者都计数；
//     日期认多种写法（`2026-09-10 12:00:00` 与 `08/30/2026 07:00`）—— 这是 SQL 字符串比较做不到的。
//   · 排序确定（件数降序 → 键升序），结果不随输入顺序漂移。
// ⚠️ 用例一律用**显式 `today`**（或把 orderTime 留空），别让断言随系统日期漂移。
import { describe, expect, it } from 'vitest';
import { aggregatePicking, type PickingRow } from '../src/lib/picking';
import { settleQtyKey, skuKey, type CostInterval } from '../src/lib/orderCost';

const infoBlock = (qty: number) => `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:${qty} piece)`;

function row(over: Partial<PickingRow> = {}): PickingRow {
  return {
    id: 1,
    orderNo: 'O1',
    shop: '店A',
    orderTime: '', // 默认无日期（照收）；日期口径由专门的范围用例显式给
    styleCode: 'S1',
    styleColor: '红',
    color: '黑',
    size: 'L',
    itemId: 'ITEM1',
    supplierId: 7,
    supplierName: '厂A',
    imagePath: '/tmp/a.jpg',
    shipped: false,
    bizStatus: '等待发货',
    rawFields: { 商品信息: infoBlock(1) },
    ...over,
  };
}

describe('aggregatePicking：分组与件数', () => {
  it('同款同色同码合成一组：件数求和、订单数去重、行数分开计', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 2, orderNo: 'O2', rawFields: { 商品信息: infoBlock(3) } }),
      row({ id: 3, orderNo: 'O2' }), // 同单的第二行（拆行后的另一件）
    ]);
    expect(s.groups).toHaveLength(1);
    const g = s.groups[0];
    expect(g.key).toBe('S1 · 黑 · L');
    expect(g.rows).toBe(3);
    expect(g.pieces).toBe(6); // 2 + 3 + 1
    expect(g.orders).toBe(2); // O1 / O2
    expect(g.orderNos).toEqual(['O1', 'O2']);
    expect(s.rows).toBe(3);
    expect(s.pieces).toBe(6);
    expect(s.orders).toBe(2);
  });

  it('不同色/码/款各自成组；缺色、缺码、未识别款**也各自成组**（不丢行）', () => {
    const s = aggregatePicking([
      row({ id: 1 }),
      row({ id: 2, orderNo: 'O2', color: '白' }),
      row({ id: 3, orderNo: 'O3', color: '', size: 'M' }),
      row({ id: 4, orderNo: 'O4', color: '黑', size: '' }),
      row({ id: 5, orderNo: 'O5', styleCode: '', color: '黑', size: 'L' }),
    ]);
    expect(s.groups.map((g) => g.key).sort()).toEqual([
      'S1 · 黑 · L',
      'S1 · 白 · L',
      'S1 · (无颜色) · M',
      'S1 · 黑 · (无尺码)',
      '(未识别款) · 黑 · L',
    ].sort());
    expect(s.groups.reduce((n, g) => n + g.rows, 0)).toBe(5);
    expect(s.missingStyle).toBe(1);
  });

  it('排序：件数降序 → 键升序（不随输入顺序漂移）', () => {
    const a = aggregatePicking([
      row({ id: 1, orderNo: 'O1' }),
      row({ id: 2, orderNo: 'O2', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
    ]);
    const b = aggregatePicking([
      row({ id: 2, orderNo: 'O2', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
      row({ id: 1, orderNo: 'O1' }),
    ]);
    expect(a.groups.map((g) => g.key)).toEqual(b.groups.map((g) => g.key));
    expect(a.groups[0].key).toBe('S1 · 白 · L');
  });
});

describe('aggregatePicking：件数口径与利润页同源', () => {
  it('结算商品行真值优先（一行时）；报表块的件数被它盖过', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })], {
      settleQty: { [settleQtyKey('O1', 'ITEM1')]: { lines: 1, qty: 2 } },
    });
    expect(s.groups[0].pieces).toBe(2);
    expect(s.missingQty).toBe(0);
  });

  it('结算里同商品多 SKU（lines>1）→ 不可复用 → 回落报表值', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(2) } })], {
      settleQty: { [settleQtyKey('O1', 'ITEM1')]: { lines: 2, qty: 4 } },
    });
    expect(s.groups[0].pieces).toBe(2);
  });

  it('两处都取不到件数 → 按 1 件计入件数**并计数**（missingQty，不静默）', () => {
    const s = aggregatePicking([row({ rawFields: { 收货国家: '美国' } }), row({ id: 2, orderNo: 'O2', rawFields: {} })]);
    expect(s.groups[0].pieces).toBe(2);
    expect(s.groups[0].missingQty).toBe(2);
    expect(s.missingQty).toBe(2);
  });
});

describe('aggregatePicking：缺口逐组计数', () => {
  it('缺图 / 缺供应商 / 未识别款逐项计数；组内任一行有图就用它', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', imagePath: '', supplierId: 0, supplierName: '' }),
      row({ id: 2, orderNo: 'O2', imagePath: '/tmp/b.jpg', supplierId: 7, supplierName: '厂A' }),
    ]);
    const g = s.groups[0];
    expect(g.missingImage).toBe(1);
    expect(g.imagePath).toBe('/tmp/b.jpg');
    expect(g.missingSupplier).toBe(1);
    expect(g.supplierId).toBe(7);
    expect(g.supplierName).toBe('厂A');
    expect(s.missingImage).toBe(1);
    expect(s.missingSupplier).toBe(1);
  });

  it('多渠道拿货（同 SKU 两个供应商）→ 名字都列出（界面据此提示"分不了单"）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', supplierId: 7, supplierName: '厂A' }),
      row({ id: 2, orderNo: 'O2', supplierId: 9, supplierName: '厂B' }),
    ]);
    expect(s.groups[0].supplierNames).toEqual(['厂A', '厂B']);
    expect(s.groups[0].supplierId).toBe(7); // 主供应商 = 首个非 0（按输入顺序，仅展示用）
  });

  it('行里都没图 → 组 imagePath 为空（界面标"缺图"，不静默）', () => {
    const s = aggregatePicking([row({ imagePath: '' })]);
    expect(s.groups[0].imagePath).toBe('');
    expect(s.groups[0].missingImage).toBe(1);
  });

  it('店铺去重列出（按店铺分单/核对用）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', shop: '店A' }),
      row({ id: 2, orderNo: 'O2', shop: '店B' }),
      row({ id: 3, orderNo: 'O3', shop: '店A' }),
    ]);
    expect(s.groups[0].shops).toEqual(['店A', '店B']);
  });

  it('已发货的行照常进组，但计数报出（默认范围不该有 —— 混进来要看得见）', () => {
    const s = aggregatePicking([row({ shipped: true }), row({ id: 2, orderNo: 'O2' })]);
    expect(s.groups[0].rows).toBe(2);
    expect(s.shippedRows).toBe(1);
  });
});

describe('aggregatePicking：边界', () => {
  it('空输入 / null 不炸，全为零', () => {
    for (const input of [[], null]) {
      const s = aggregatePicking(input);
      expect(s.groups).toEqual([]);
      expect(s.rows).toBe(0);
      expect(s.pieces).toBe(0);
      expect(s.orders).toBe(0);
      expect(s.missingImage + s.missingQty + s.missingSupplier + s.missingStyle).toBe(0);
    }
  });

  it('订单号为空的行：件数照算、不计入"涉及订单数"（去重集合认不出它）', () => {
    const s = aggregatePicking([row({ orderNo: '' }), row({ id: 2, orderNo: 'O1' })]);
    expect(s.groups[0].pieces).toBe(2);
    expect(s.groups[0].orderNos).toEqual(['O1']);
    expect(s.orders).toBe(1);
  });

  it('分组键与利润页的 SKU 维度**同一份实现**（`skuKey`）', () => {
    const s = aggregatePicking([row({ color: '', size: '' })]);
    expect(s.groups[0].key).toBe(skuKey({ styleCode: 'S1', color: '', size: '' }));
  });
});
describe('aggregatePicking：范围（未发货 · 近 30 天）', () => {
  const TODAY = '2026-09-29';

  it('已终结（关闭 / 已完成）剔除并计数 —— 单已经没了，拣了白拣', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', bizStatus: '订单关闭' }),
        row({ id: 2, orderNo: 'O2', bizStatus: '交易完成' }),
        row({ id: 3, orderNo: 'O3', bizStatus: '等待发货' }),
      ],
      { today: TODAY },
    );
    expect(s.excludedFinished).toBe(2);
    expect(s.rows).toBe(1);
    expect(s.scanned).toBe(3);
    expect(s.groups[0].orderNos).toEqual(['O3']);
  });

  it('超出天数窗剔除并计数；窗内照收', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', orderTime: '2026-09-20 10:00:00' }), // 9 天前 → 窗内
        row({ id: 2, orderNo: 'O2', orderTime: '2026-07-01 10:00:00' }), // 90 天前 → 剔除
      ],
      { today: TODAY, days: 30 },
    );
    expect(s.excludedOld).toBe(1);
    expect(s.rows).toBe(1);
    expect(s.groups[0].orderNos).toEqual(['O1']);
    expect(s.days).toBe(30);
  });

  it('**两种日期写法都认**（`2026-09-10 12:00:00` 与 `08/30/2026 07:00`）—— SQL 字符串比较会丢掉后者', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', orderTime: '2026-09-10 12:00:00' }),
        row({ id: 2, orderNo: 'O2', orderTime: '08/30/2026 07:00' }),
      ],
      { today: TODAY, days: 30 },
    );
    expect(s.excludedOld).toBe(0);
    expect(s.rows).toBe(2);
  });

  it('没有下单日期的行**照收**并计数（"没日期"不等于"太老" —— 排除它等于静默丢行）', () => {
    const s = aggregatePicking([row({ orderTime: '' })], { today: TODAY, days: 30 });
    expect(s.rows).toBe(1);
    expect(s.undated).toBe(1);
    expect(s.excludedOld).toBe(0);
  });

  it('days <= 0 → 不限天数（全部照收）', () => {
    const s = aggregatePicking([row({ orderTime: '2020-01-01 00:00:00' })], { today: TODAY, days: 0 });
    expect(s.rows).toBe(1);
    expect(s.excludedOld).toBe(0);
  });

  it('默认天数窗 = 30（不传 days 时也一样）', () => {
    const s = aggregatePicking([row()], { today: TODAY });
    expect(s.days).toBe(30);
  });

  it('被剔除的行**不进任何组**（合计与明细对得上：rows + 剔除 + 无日期 = scanned）', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', bizStatus: '订单关闭' }),
        row({ id: 2, orderNo: 'O2', orderTime: '2026-01-01 00:00:00' }),
        row({ id: 3, orderNo: 'O3', orderTime: '' }),
        row({ id: 4, orderNo: 'O4', orderTime: '2026-09-25 00:00:00' }),
      ],
      { today: TODAY, days: 30 },
    );
    expect(s.scanned).toBe(4);
    expect(s.excludedFinished + s.excludedOld + s.rows).toBe(4);
    expect(s.groups.reduce((n, g) => n + g.rows, 0)).toBe(s.rows);
  });
});

// S3（2026-10-05）：进价 / 预估金额 + 按厂家分组。
//
// 钉住的仍是**口径**：
//   · 单价必须来自 `orderCost.pickUnitCost`（与「算钱」页同一份实现）——按**该行的下单日期**取当时生效的区间；
//   · 金额 = Σ(件数 × 单价)，**逐行**累加（不是"件数合计 × 某一价"）——同款跨成本区间时后者会挑错价；
//   · 取不到价 → 该行**不计入金额**并累到件数（`noPricePieces`），**绝不按 0 算**
//     （按 0 算会让"估算偏低"和"真的便宜"长得一模一样，是查不出来的错）；
//   · 按厂家分组：有厂家的在前（件数降序）、未指定的整组排最后；组里引用的是**同一个 group 对象**。
const cost = (styleCode: string, effectiveFrom: string, unitPrice: number, source = 'purchase'): CostInterval => ({
  styleCode,
  effectiveFrom,
  unitPrice,
  source,
});

describe('aggregatePicking：进价与预估金额', () => {
  it('取不到成本 → 单价 null、金额 0、件数进"无进价"（**不按 0 算**）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })]);
    expect(s.groups[0].unitPrice).toBeNull();
    expect(s.groups[0].amount).toBe(0);
    expect(s.groups[0].noPricePieces).toBe(3);
    expect(s.groups[0].pricedPieces).toBe(0);
    expect(s.amount).toBe(0);
    expect(s.noPricePieces).toBe(3);
    expect(s.noPriceGroups).toBe(1);
  });

  it('有成本 → 单价取当时生效的那条，金额 = 件数 × 单价', () => {
    const s = aggregatePicking([row({ orderTime: '2026-09-20 10:00:00', rawFields: { 商品信息: infoBlock(3) } })], {
      today: '2026-09-29',
      costs: [cost('S1', '2026-09-01', 12.5)],
    });
    const g = s.groups[0];
    expect(g.unitPrice).toBe(12.5);
    expect(g.amount).toBe(37.5); // 3 × 12.5
    expect(g.pricedPieces).toBe(3);
    expect(g.noPricePieces).toBe(0);
    expect(s.amount).toBe(37.5);
  });

  it('同款跨成本生效区间 → **逐行**取价后相加（不是"件数合计 × 一个价"）', () => {
    // 9-10 的单价 10 元，9-20 的单价 12 元；两组各 2 件 → 20 + 24 = 44（若按均价或按最新价都不是 44）
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', orderTime: '2026-09-10 10:00:00', rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 2, orderNo: 'O2', orderTime: '2026-09-20 10:00:00', rawFields: { 商品信息: infoBlock(2) } }),
      ],
      { today: '2026-09-29', costs: [cost('S1', '2026-09-01', 10), cost('S1', '2026-09-15', 12)] },
    );
    const g = s.groups[0];
    expect(g.pieces).toBe(4);
    expect(g.amount).toBe(44);
    expect(g.unitPrice).toBe(11); // 加权均价 44 / 4
  });

  it('未被拣的行（关闭单 / 超窗）不进金额 —— 与件数同口径，否则"金额"和"件数"对不上', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', orderTime: '2026-09-25 10:00:00', rawFields: { 商品信息: infoBlock(1) } }),
        row({ id: 2, orderNo: 'O2', orderTime: '2026-09-25 10:00:00', bizStatus: '订单关闭', rawFields: { 商品信息: infoBlock(1) } }),
        row({ id: 3, orderNo: 'O3', orderTime: '2026-07-01 10:00:00', rawFields: { 商品信息: infoBlock(1) } }),
      ],
      { today: '2026-09-29', costs: [cost('S1', '2026-09-01', 10)] },
    );
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].pieces).toBe(1);
    expect(s.amount).toBe(10);
    expect(s.noPricePieces).toBe(0); // 被剔除的行**不该**被算成"无进价"
  });

  it('未识别款（款编码为空）→ 取不到价，标"无进价"', () => {
    const s = aggregatePicking([row({ styleCode: '', rawFields: { 商品信息: infoBlock(2) } })], {
      costs: [cost('S1', '2026-09-01', 10)],
    });
    expect(s.groups[0].unitPrice).toBeNull();
    expect(s.noPricePieces).toBe(2);
    expect(s.noPriceGroups).toBe(1);
  });

  it('混合：一款有价一款无价 → 金额只含有价那款，缺价件数照报', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 2, orderNo: 'O2', styleCode: 'S2', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
      ],
      { costs: [cost('S1', '2026-01-01', 10)] },
    );
    expect(s.amount).toBe(20); // 只含 S1 的 2 件
    expect(s.noPricePieces).toBe(5); // S2 的 5 件没价
    expect(s.noPriceGroups).toBe(1);
    expect(s.pieces).toBe(7); // 件数仍是全部
  });
});

describe('aggregatePicking：按厂家分组', () => {
  it('有厂家的在前（件数降序），**未指定的整组排最后**（它是待补项，不是可执行项）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', color: '灰', supplierId: 0, supplierName: '', rawFields: { 商品信息: infoBlock(9) } }),
      row({ id: 2, orderNo: 'O2', supplierId: 7, supplierName: '厂A', rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 3, orderNo: 'O3', supplierId: 9, supplierName: '厂B', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
    ]);
    expect(s.groups).toHaveLength(3); // 三个不同 SKU，才不会在分组前就被合成一组
    expect(s.suppliers.map((x) => x.supplierName)).toEqual(['厂B', '厂A', '']);
    expect(s.suppliers.map((x) => x.supplierId)).toEqual([9, 7, 0]);
    expect(s.suppliers[2].pieces).toBe(9); // 未指定那组虽然有 9 件，也不排到前面
  });

  it('组里引用的是**同一个 group 对象**（两处显示同一个数，不会分叉）', () => {
    const s = aggregatePicking([row({ supplierId: 7, supplierName: '厂A' })]);
    expect(s.suppliers[0].groups[0]).toBe(s.groups[0]);
  });

  it('分组的件数/金额/缺价件数合计 = 明细的合计（对不上就是分组的账算错了）', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', supplierId: 7, supplierName: '厂A', rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 2, orderNo: 'O2', supplierId: 7, supplierName: '厂A', color: '白', rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 3, orderNo: 'O3', supplierId: 0, supplierName: '', styleCode: 'S2', rawFields: { 商品信息: infoBlock(5) } }),
      ],
      { costs: [cost('S1', '2026-01-01', 10), cost('S2', '2026-01-01', 2)] },
    );
    const sum = (k: 'pieces' | 'rows' | 'amount' | 'noPricePieces') =>
      s.suppliers.reduce((n, x) => n + x[k], 0);
    expect(sum('pieces')).toBe(s.pieces);
    expect(sum('rows')).toBe(s.rows);
    expect(sum('amount')).toBe(s.amount);
    expect(sum('noPricePieces')).toBe(s.noPricePieces);
    expect(sum('amount')).toBe(2 * 10 + 3 * 10 + 5 * 2); // 60
  });

  it('一个厂家都没有 → 只有一组（supplierId 0），不是空数组', () => {
    const s = aggregatePicking([row({ supplierId: 0, supplierName: '' })]);
    expect(s.suppliers).toHaveLength(1);
    expect(s.suppliers[0].supplierId).toBe(0);
    expect(s.suppliers[0].groups).toHaveLength(1);
  });

  it('空输入 → suppliers 为空数组（不炸）', () => {
    expect(aggregatePicking([]).suppliers).toEqual([]);
    expect(aggregatePicking(null).suppliers).toEqual([]);
  });
});
