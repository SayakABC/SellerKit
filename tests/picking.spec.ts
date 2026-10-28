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
import {
  aggregatePicking,
  groupByColor,
  ignoreKey,
  pendingOf,
  pendingRollup,
  takenKey,
  type PickingGroup,
  type PickingRow,
} from '../src/lib/picking';
import { settleQtyKey, skuKey } from '../src/lib/orderCost';

const infoBlock = (qty: number) => `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:${qty} piece)`;

function row(over: Partial<PickingRow> = {}): PickingRow {
  return {
    id: 1,
    orderNo: 'O1',
    shop: '店A',
    orderTime: '', // 默认无日期（照收）；日期口径由专门的范围用例显式给
    styleCode: 'S1',
    styleName: '', // 默认空（识别链降级时整组都可能为空）；款名口径由专门用例给
    styleColor: '红',
    // 默认 0 = 老订单（无款色身份）⇒ 已拿按文本兜底；身份匹配的用例显式给 id
    styleColorId: 0,
    color: '黑',
    size: 'L',
    itemId: 'ITEM1',
    supplierId: 7,
    supplierName: '厂A',
    imagePath: '/tmp/a.jpg',
    shipped: false,
    bizStatus: '等待发货',
    // 成本三档默认全空（这样"取不到价"的用例不用一个个显式清空）；
    // 成本相关用例按需给 `costCents` / `actualCostCents` / `productCostCents`。
    actualCostCents: null,
    costCents: null,
    productCostCents: null,
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

  it('款名取组内**第一个非空**（供拿货单明细预填；整组都空时留空串，不编名字）', () => {
    const s = aggregatePicking([row({ id: 1 }), row({ id: 2, orderNo: 'O2', styleName: '某款' })]);
    expect(s.groups[0].styleName).toBe('某款');
    const none = aggregatePicking([row({ id: 3 })]);
    expect(none.groups[0].styleName).toBe('');
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

// S3（2026-10-05）/ C2（2026-10-21）：进价三档 + 预估金额 + 按厂家分组。
//
// 钉住的仍是**口径**：
//   · 单价按**行**取，三档次序 **实际进价 > 进价预估 > 产品当前价**（0/空一律当"没有"）；
//     拣货是"要花多少钱"的经营估算，所以比利润页多一档产品当前价（利润页只认行上两个快照）；
//   · 金额 = Σ(件数 × 单价)，**逐行**累加（不是"件数合计 × 某一价"）；
//   · 取不到价 → 该行**不计入金额**并累到件数（`noPricePieces`），**绝不按 0 算**
//     （按 0 算会让"估算偏低"和"真的便宜"长得一模一样，是查不出来的错）；
//   · 按厂家分组：有厂家的在前（件数降序）、未指定的整组排最后；组里引用的是**同一个 group 对象**。
describe('aggregatePicking：进价与预估金额', () => {
  it('三档都没有 → 单价 null、金额 0、件数进"无进价"（**不按 0 算**）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })]);
    expect(s.groups[0].unitPrice).toBeNull();
    expect(s.groups[0].amount).toBe(0);
    expect(s.groups[0].noPricePieces).toBe(3);
    expect(s.groups[0].pricedPieces).toBe(0);
    expect(s.amount).toBe(0);
    expect(s.noPricePieces).toBe(3);
    expect(s.noPriceGroups).toBe(1);
  });

  it('进价取行上的预估：金额 = 件数 × 单价', () => {
    const s = aggregatePicking(
      [
        row({ orderTime: '2026-09-20 10:00:00', costCents: 1250, rawFields: { 商品信息: infoBlock(3) } }),
      ],
      { today: '2026-09-29' },
    );
    const g = s.groups[0];
    expect(g.unitPrice).toBe(12.5);
    expect(g.amount).toBe(37.5); // 3 × 12.5
    expect(g.pricedPieces).toBe(3);
    expect(g.noPricePieces).toBe(0);
    expect(s.amount).toBe(37.5);
  });

  it('三档次序：实际进价 > 进价预估 > 产品当前价（三档都有 → 实际赢）', () => {
    const s = aggregatePicking([
      row({ actualCostCents: 2000, costCents: 1500, productCostCents: 900 }),
    ]);
    expect(s.groups[0].unitPrice).toBe(20);
    expect(s.groups[0].noPricePieces).toBe(0);
  });

  it('没有实际进价 → 用预估（不被产品当前价顶掉）', () => {
    const s = aggregatePicking([row({ costCents: 1500, productCostCents: 900 })]);
    expect(s.groups[0].unitPrice).toBe(15);
  });

  it('行上两档都空 → 回落产品当前价（还没钉过预估的老行）', () => {
    const s = aggregatePicking([row({ productCostCents: 900 })]);
    expect(s.groups[0].unitPrice).toBe(9);
    expect(s.groups[0].noPricePieces).toBe(0);
  });

  it('0 不算有值：实际 0 → 用预估；预估 0 → 用产品价（0 不是"免费"）', () => {
    const a = aggregatePicking([row({ actualCostCents: 0, costCents: 1500, productCostCents: 900 })]);
    expect(a.groups[0].unitPrice).toBe(15);
    const b = aggregatePicking([row({ actualCostCents: 0, costCents: 0, productCostCents: 900 })]);
    expect(b.groups[0].unitPrice).toBe(9);
  });

  it('同款不同行的价可以不同 → **逐行**取价后相加（不是"件数合计 × 一个价"）', () => {
    // 两行各 2 件：一行 10 元、一行 12 元 → 20 + 24 = 44（按均价或按最新价都不是 44）
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 2, orderNo: 'O2', costCents: 1200, rawFields: { 商品信息: infoBlock(2) } }),
    ]);
    const g = s.groups[0];
    expect(g.pieces).toBe(4);
    expect(g.amount).toBe(44);
    expect(g.unitPrice).toBe(11); // 加权均价 44 / 4
  });

  it('未被拣的行（关闭单 / 超窗）不进金额 —— 与件数同口径，否则"金额"和"件数"对不上', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', orderTime: '2026-09-25 10:00:00', costCents: 1000, rawFields: { 商品信息: infoBlock(1) } }),
        row({ id: 2, orderNo: 'O2', orderTime: '2026-09-25 10:00:00', bizStatus: '订单关闭', costCents: 1000, rawFields: { 商品信息: infoBlock(1) } }),
        row({ id: 3, orderNo: 'O3', orderTime: '2026-07-01 10:00:00', costCents: 1000, rawFields: { 商品信息: infoBlock(1) } }),
      ],
      { today: '2026-09-29' },
    );
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].pieces).toBe(1);
    expect(s.amount).toBe(10);
    expect(s.noPricePieces).toBe(0); // 被剔除的行**不该**被算成"无进价"
  });

  it('未识别款但行上有价 → 仍有价（价钉在行上，不看款识别）', () => {
    const s = aggregatePicking([row({ styleCode: '', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } })]);
    expect(s.groups[0].unitPrice).toBe(10);
    expect(s.groups[0].noPricePieces).toBe(0);
    expect(s.noPriceGroups).toBe(0);
  });

  it('混合：一行有价一行无价 → 金额只含有价那行，缺价件数照报', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 2, orderNo: 'O2', styleCode: 'S2', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
    ]);
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
        row({ id: 1, orderNo: 'O1', supplierId: 7, supplierName: '厂A', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 2, orderNo: 'O2', supplierId: 7, supplierName: '厂A', color: '白', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 3, orderNo: 'O3', supplierId: 0, supplierName: '', styleCode: 'S2', costCents: 200, rawFields: { 商品信息: infoBlock(5) } }),
      ],
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

// 2026-10-10：「已拿 / 还差 / 已忽略」—— 拣货单问的是"**还要**拿什么"。
//
// 钉住的是**键的粒度**（这是唯一能把这件事做错的地方）：
//   · 已拿（`taken`）按 **款 × 色 × 码** —— 与 `purchase-db.outstanding()` 的行粒度一致；
//     粒度粗一档（只按款色）会把 XL 的货算到 L 头上，而且不报错；
//   · 已忽略（`ignored`）按 **款 × 色**（整组生效，尺码不参与）—— 与 `purchase_ignore` 表一致；
//   · **不是"两个都不要"**：忽略是"这款色不用补"，已拿是"这几件已经拿过了"，两件事各算各的。
//
// 另一条同样重要：**不传这两个选项时输出与本改造前逐字一致**（`taken 0 / remaining = pieces /
// ignored false`）。拣货单是照它干活的东西，默认口径漂一点就是少发/多发一件货。
describe('aggregatePicking：已拿 / 还差 / 已忽略', () => {
  it('键的口径就是「款|色|码」与「款|色」（与宿主 outstanding() 的行粒度同源，不许改拼接符）', () => {
    expect(takenKey('S1', '黑', 'L')).toBe('S1|黑|L');
    expect(ignoreKey('S1', '黑')).toBe('S1|黑');
    // 缺值也不能塌成同一个键（'' 与 undefined 拼出来必须一样，且不与有值的撞）
    expect(takenKey('S1', '', '')).toBe('S1||');
    expect(ignoreKey('S1', '')).not.toBe(ignoreKey('S1', '黑'));
  });

  it('不传 taken / ignored 时与改造前逐字一致：已拿 0、还差 = 需求、未忽略', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 2, orderNo: 'O2', rawFields: { 商品信息: infoBlock(3) } }),
    ]);
    expect(s.groups[0].taken).toBe(0);
    expect(s.groups[0].remaining).toBe(5);
    expect(s.groups[0].ignored).toBe(false);
    expect(s.takenPieces).toBe(0);
    expect(s.remainingPieces).toBe(5);
    expect(s.remainingGroups).toBe(1);
  });

  it('已拿按**款色码**扣：同款同色的**另一个尺码**不受影响', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', rawFields: { 商品信息: infoBlock(6) } }),
        row({ id: 2, orderNo: 'O2', size: 'XL', rawFields: { 商品信息: infoBlock(4) } }),
      ],
      { taken: { 'S1|黑|L': 4 } },
    );
    const L = s.groups.find((g) => g.key === 'S1 · 黑 · L')!;
    const XL = s.groups.find((g) => g.key === 'S1 · 黑 · XL')!;
    expect([L.taken, L.remaining]).toEqual([4, 2]);
    expect([XL.taken, XL.remaining]).toEqual([0, 4]); // 粒度写粗一档时这里会变成 4/0
    expect(s.takenPieces).toBe(4);
    expect(s.remainingPieces).toBe(6);
  });

  it('已拿只认**同款同色**：款不同 / 色不同都不串味', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1' }),
        row({ id: 2, orderNo: 'O2', styleCode: 'S2' }),
        row({ id: 3, orderNo: 'O3', color: '白' }),
      ],
      { taken: { 'S1|黑|L': 1 } },
    );
    // ⚠️ 断言按**键取组**而不是按下标：组的排列由"件数降序 → 键升序"另外管（上面有专门用例），
    //    在这里再钉一次顺序，会让这条用例将来因为排序策略调整而误红。
    const takenOf = (key: string) => s.groups.find((g) => g.key === key)!.taken;
    expect(takenOf('S1 · 黑 · L')).toBe(1);
    expect(takenOf('S2 · 黑 · L')).toBe(0);
    expect(takenOf('S1 · 白 · L')).toBe(0);
  });

  it('已拿多于需求 → 还差**夹到 0**，不出负数（拿了 8 件但只需要 6 件是真的会发生）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(6) } })], { taken: { 'S1|黑|L': 8 } });
    expect(s.groups[0].taken).toBe(8); // 已拿照实报（那 8 件确实是拿过的）
    expect(s.groups[0].remaining).toBe(0); // 但"还要拿"不能是 -2
    expect(s.remainingGroups).toBe(0);
  });

  // ⚠️ 2026-10-20 用户实报"已提交的拿货单在清单上全是待拿"：根因是拿**色名**当匹配键，
  //    而色名被归色改写（`未分类` → `10`）。下面三条钉住"身份优先、文本兜底、互不双算"。
  it('身份优先：色名改过（款色 id 相同）仍然算已拿 —— 拿色名当键的实现在这里必红', () => {
    // 订单行：色行 id=12、当前色名 '10'；拿货明细记的是同一 id（开单时写下的身份）
    const s = aggregatePicking([row({ styleColorId: 12, color: '10' })], { taken: { '#12|L': 3 } });
    expect(s.groups[0].taken).toBe(3);
    expect(s.groups[0].remaining).toBe(0);
  });

  it('文本兜底：老明细（id=0）按「款|色|码」仍能匹配上 —— 只看 id 的实现在这里必红', () => {
    const s = aggregatePicking([row({ styleColorId: 12, color: '10' })], { taken: { 'S1|10|L': 2 } });
    expect(s.groups[0].taken).toBe(2);
  });

  it('身份与文本**不双算**：两拨不同单据行才相加（同一行被两边命中就会漏货）', () => {
    // 一个 id 键 2 件 + 一条老文本明细 3 件 = 5 件已拿（是两拨行，合计才对）
    const s = aggregatePicking([row({ styleColorId: 12, color: '10', rawFields: { 商品信息: infoBlock(6) } })], {
      taken: { '#12|L': 2, 'S1|10|L': 3 },
    });
    expect(s.groups[0].taken).toBe(5);
    expect(s.groups[0].remaining).toBe(1);
    // 未归类（id=0）的行只走文本键：id 键那 2 件不属于它
    const u = aggregatePicking([row({ styleColorId: 0, color: '10' })], { taken: { '#12|L': 2 } });
    expect(u.groups[0].taken).toBe(0);
  });

  it('未归类行按**商品ID** 聚合成 `unclassifiedItems`（件数照收，但要让界面能标出来并给修复入口）', () => {
    const s = aggregatePicking([
      // 同一个商品的两行（不同尺码）→ 合成一条，件数相加
      row({ id: 1, orderNo: 'O1', itemId: 'ITEM9', styleCode: '', styleColorId: 0, color: 'Picture color', size: 'L' }),
      row({ id: 2, orderNo: 'O2', itemId: 'ITEM9', styleCode: '', styleColorId: 0, color: 'Picture color', size: 'XL', rawFields: { 商品信息: infoBlock(2) } }),
      // 另一个商品、另一家店
      row({ id: 3, orderNo: 'O3', itemId: 'ITEM8', shop: '店B', styleCode: '', styleColorId: 0, size: 'M' }),
      // 已归类的行不进这张表
      row({ id: 4, orderNo: 'O4', itemId: 'ITEM7', styleColorId: 33 }),
    ]);
    expect(s.unclassifiedItems.map((x) => [x.itemId, x.pieces, x.rows])).toEqual([
      ['ITEM9', 3, 2], // 1 + 2 件
      ['ITEM8', 1, 1],
    ]);
    expect(s.unclassifiedItems[0].shops).toEqual(['店A']);
    expect(s.unclassifiedItems[1].shops).toEqual(['店B']);
    // 未归类照样进总件数（"漏货比脏数据贵"）：3 + 1，加上已归类的 1 件 = 5
    expect(s.pieces).toBe(5);
    // 没有未归类行时是空数组（不是 undefined —— 界面 `v-if` 才能直接判长度）
    expect(aggregatePicking([row({ styleColorId: 33 })]).unclassifiedItems).toEqual([]);
  });

  it('忽略按**款色**整组生效：同款同色的所有尺码一起被忽略', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L' }),
        row({ id: 2, orderNo: 'O2', size: 'XL' }),
        row({ id: 3, orderNo: 'O3', color: '白' }),
      ],
      { ignored: new Set(['S1|黑']) },
    );
    // 同样按键取组（见上一条用例的说明）
    const ignoredOf = (key: string) => s.groups.find((g) => g.key === key)!.ignored;
    expect(ignoredOf('S1 · 黑 · L')).toBe(true);
    expect(ignoredOf('S1 · 黑 · XL')).toBe(true);
    expect(ignoredOf('S1 · 白 · L')).toBe(false); // 只忽略「黑」，白的不受影响
  });

  it('被忽略的组**不进** remainingGroups（"还要拿"是可执行口径），但**仍计入** remainingPieces（总需求还差多少）', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', color: '白', rawFields: { 商品信息: infoBlock(5) } }),
      ],
      { ignored: new Set(['S1|黑']) },
    );
    expect(s.remainingGroups).toBe(1); // 只有「白」那一组还要拿
    expect(s.remainingPieces).toBe(8); // 3 + 5：两个数各说一件事，别互相替
  });

  it('忽略 + 已拿同时命中同一组：两件事各算各的（不是二选一）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(6) } })], {
      taken: { 'S1|黑|L': 4 },
      ignored: new Set(['S1|黑']),
    });
    expect(s.groups[0]).toMatchObject({ taken: 4, remaining: 2, ignored: true });
    expect(s.remainingGroups).toBe(0);
  });

  it('已拿不影响件数 / 金额 / 缺价件数（金额是"这批货值多少"，不是"还剩多少没拿"）', () => {
    const s = aggregatePicking([row({ costCents: 1000, rawFields: { 商品信息: infoBlock(3) } })], {
      taken: { 'S1|黑|L': 2 },
    });
    expect(s.groups[0].pieces).toBe(3);
    expect(s.groups[0].amount).toBe(30);
    expect(s.amount).toBe(30);
    expect(s.noPricePieces).toBe(0);
  });

  it('形状不对的入参当"没有"（不是对象 / 不是 Set）—— 只影响这一列，清单本身照出', () => {
    for (const bad of [null, undefined, [], 'x', 7]) {
      const s = aggregatePicking([row()], { taken: bad as never, ignored: bad as never });
      expect(s.groups).toHaveLength(1);
      expect(s.groups[0].taken).toBe(0);
      expect(s.groups[0].ignored).toBe(false);
    }
  });

  it('taken 的值非数字 / 负数 → 按 0 处理（脏数据不该造出"已拿 -3 件"）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(4) } })], {
      taken: { 'S1|黑|L': 'abc' as never, 'S1|白|L': -5 },
    });
    expect(s.groups[0].taken).toBe(0);
    expect(s.groups[0].remaining).toBe(4);
  });
});

// ─────────────── 款色折叠层（2026-10-10 界面重设计：款色一行、尺码并排） ───────────────
// 折叠的是**展示**，不是口径：每个尺码格仍带着自己那三个数（需求/已拿/还差），
// 忽略/已拿/开单的粒度一个都没变 —— 这里逐条把"折叠后没丢事"钉住。

describe('groupByColor：款色折叠', () => {
  it('同款同色各尺码合成一行：尺码并排、三个数各是各的（不被平均掉）', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', rawFields: { 商品信息: infoBlock(6) } }),
        row({ id: 2, orderNo: 'O2', size: 'XL', rawFields: { 商品信息: infoBlock(4) } }),
      ],
      { taken: { 'S1|黑|L': 4 } },
    );
    const rows = groupByColor(s.groups);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.key).toBe('S1 · 黑');
    expect(r.sizes).toEqual([
      { size: 'L', pieces: 6, taken: 4, remaining: 2 },
      { size: 'XL', pieces: 4, taken: 0, remaining: 4 },
    ]);
    expect([r.pieces, r.taken, r.remaining]).toEqual([10, 4, 6]);
  });

  it('尺码格排序与输入顺序无关：字母码 XS→XXXL、数字码按数值、无尺码排最后', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', size: 'L' }),
      row({ id: 2, orderNo: 'O2', size: 'S' }),
      row({ id: 3, orderNo: 'O3', size: 'M' }),
      row({ id: 4, orderNo: 'O4', size: '40' }),
      row({ id: 5, orderNo: 'O5', size: '38' }),
      row({ id: 6, orderNo: 'O6', size: '' }),
    ]);
    expect(groupByColor(s.groups)[0].sizes.map((c) => c.size)).toEqual(['S', 'M', 'L', '38', '40', '']);
  });

  it('缺哪段标哪段：未识别款 / 无颜色的行也各自成款色行（不丢行）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1' }),
      row({ id: 2, orderNo: 'O2', styleCode: '' }),
      row({ id: 3, orderNo: 'O3', color: '' }),
    ]);
    expect(groupByColor(s.groups).map((r) => r.key).sort()).toEqual([
      'S1 · 黑',
      'S1 · (无颜色)',
      '(未识别款) · 黑',
    ].sort());
  });

  it('图 / 款名取首个非空、供应商取首个非 0（与 aggregatePicking 组内回落同一手法）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', size: 'L', imagePath: '', styleName: '', supplierId: 0, supplierName: '' }),
      row({ id: 2, orderNo: 'O2', size: 'M', imagePath: '/tmp/b.jpg', styleName: '款一', supplierId: 7, supplierName: '厂A' }),
    ]);
    const r = groupByColor(s.groups)[0];
    expect(r.imagePath).toBe('/tmp/b.jpg');
    expect(r.styleName).toBe('款一');
    expect([r.supplierId, r.supplierName]).toEqual([7, '厂A']);
  });

  it('涉及订单数按**并集**去重：同单跨码只算一单', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', size: 'L' }),
      row({ id: 2, orderNo: 'O1', size: 'M' }),
    ]);
    expect(groupByColor(s.groups)[0].orders).toBe(1);
  });

  it('orderNos：各码订单号的并集、升序去重（界面"涉及 N 个订单"展开后列的就是它）', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O2', size: 'L' }),
      row({ id: 2, orderNo: 'O1', size: 'M' }),
      row({ id: 3, orderNo: 'O1', size: 'M' }), // 同单同码再来一行 → 仍是一个号
      row({ id: 4, orderNo: 'O3', size: 'L' }),
    ]);
    const r = groupByColor(s.groups)[0];
    expect(r.orderNos).toEqual(['O1', 'O2', 'O3']);
    expect(r.orders).toBe(3); // 两个数必须一致（一个是另一个的长度，分叉就是有一处算错了）
  });

  it('缺口逐码求和（折叠不丢"缺"）；忽略整款色一致', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', imagePath: '' }),
        row({ id: 2, orderNo: 'O2', size: 'M', rawFields: {} }), // 无商品信息块 → 件数按 1 并标缺
        row({ id: 3, orderNo: 'O3', size: 'M', supplierId: 0, supplierName: '' }),
      ],
      { ignored: new Set(['S1|黑']) },
    );
    const r = groupByColor(s.groups)[0];
    expect(r.missingImage).toBe(1);
    expect(r.missingQty).toBe(1);
    expect(r.ignored).toBe(true);
  });

  it('进价 = 有价需求件的加权均价；还差金额**只含有价的还差件**，缺价件另报（不按 0 蒙）', () => {
    // 同款两码的价可以不同（一行钉了 10 元、一行钉了 12 元）——
    // 这也是"同一款色的各码单价可以不同"的真实来源。
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1200, rawFields: { 商品信息: infoBlock(2) } }),
      ],
      { days: 0, taken: { 'S1|黑|L': 1 } },
    );
    const r = groupByColor(s.groups)[0];
    expect(r.unitPrice).toBe(10.8); // (3×10 + 2×12) / 5
    expect(r.pendingAmount).toBe(44); // L 还差 2 × 10 + M 还差 2 × 12
    expect(r.pendingNoPricePieces).toBe(0);
  });

  it('一件价都没有 → unitPrice null、还差金额 0 且件数全进 pendingNoPricePieces（0 元 ≠ 不知道多少钱）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })]);
    const r = groupByColor(s.groups)[0];
    expect(r.unitPrice).toBeNull();
    expect(r.pendingAmount).toBe(0);
    expect(r.pendingNoPricePieces).toBe(3);
    expect(r.noPricePieces).toBe(3);
  });

  it('排序与 aggregatePicking 同规则：需求件数降序 → 键升序', () => {
    const s = aggregatePicking([
      row({ id: 1, orderNo: 'O1', color: '白', rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 2, orderNo: 'O2', color: '黑', rawFields: { 商品信息: infoBlock(5) } }),
      row({ id: 3, orderNo: 'O3', color: '蓝', rawFields: { 商品信息: infoBlock(2) } }),
    ]);
    expect(groupByColor(s.groups).map((r) => r.key)).toEqual(['S1 · 黑', 'S1 · 白', 'S1 · 蓝']);
  });

  it('形状不对的入参当"没有"（不是数组 / null）', () => {
    for (const bad of [null, undefined, 'x']) {
      expect(groupByColor(bad as never)).toEqual([]);
    }
  });
});

describe('pendingOf / pendingRollup：待拿口径（按钮件数与开单明细的唯一判据）', () => {
  /** 造一个拿得出手的组：款 S1 黑 L / M 两码（L 还差 2、M 拿完），款 S2 黑 L（忽略），S3 白 L（另一厂家） */
  function fixture(): PickingGroup[] {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', size: 'M', rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 3, orderNo: 'O3', styleCode: 'S2' }),
        row({ id: 4, orderNo: 'O4', styleCode: 'S3', color: '白', supplierId: 8, supplierName: '厂B' }),
      ],
      { taken: { 'S1|黑|L': 1, 'S1|黑|M': 2 }, ignored: new Set(['S2|黑']) },
    );
    return s.groups;
  }

  it('待拿 = 还差 > 0 且未被忽略（拿完的不进、忽略的不进）', () => {
    const keys = pendingOf(fixture())
      .map((g) => g.key)
      .sort();
    expect(keys).toEqual(['S1 · 黑 · L', 'S3 · 白 · L']);
  });

  it('按厂家精确筛：只回该厂家的待拿项（含 supplierId = 0 的精确匹配）', () => {
    expect(pendingOf(fixture(), 7).map((g) => g.key)).toEqual(['S1 · 黑 · L']);
    expect(pendingOf(fixture(), 8).map((g) => g.key)).toEqual(['S3 · 白 · L']);
    expect(pendingOf(fixture(), 0)).toEqual([]);
  });

  it('形状不对的入参当"没有"；不传厂家 = 不限厂家', () => {
    expect(pendingOf(null)).toEqual([]);
    expect(pendingOf(fixture()).length).toBe(2);
  });

  it('款色合计：款色数 / 件数 / 预估金额（只含有价的还差件）/ 缺价件数', () => {
    const s = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', styleCode: 'S2', color: '白', rawFields: { 商品信息: infoBlock(4) } }),
      ],
      { taken: { 'S1|黑|L': 1 }, ignored: new Set(['S1|黑']) },
    );
    const rows = groupByColor(s.groups);
    // S1 被忽略 → 整行不进；S2 无价 → 件数照报、金额不含它
    expect(pendingRollup(rows)).toEqual({ colors: 1, pieces: 4, amount: 0, noPricePieces: 4 });
  });

  it('一件待拿都没有 → 全 0（顶部那格就该消失）', () => {
    const s = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })], { taken: { 'S1|黑|L': 3 } });
    expect(pendingRollup(groupByColor(s.groups))).toEqual({ colors: 0, pieces: 0, amount: 0, noPricePieces: 0 });
    expect(pendingRollup(null)).toEqual({ colors: 0, pieces: 0, amount: 0, noPricePieces: 0 });
  });
});
