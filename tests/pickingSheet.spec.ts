// 「复制给厂家」清单图的纯模型用例（`src/lib/pickingSheet.ts`）。
//
// 钉住三件事：
//  ① 金额字面口径 —— `—` 与 `¥0.00` 是两件事（缺价 ≠ 不要钱），全缺/部分缺的措辞不同；
//  ② 模型与屏上/xlsx **同源** —— 行内容取自 `pendingOf`/`groupByColor`，角标格式 = `sizeQtyBadge`，
//     合计 = `pendingRollup`（这里用**写死的期望串**钉住，免得"同源"退化成"同错"）；
//  ③ 没有待拿的行 → `null`（不产生一张空图发出去）。
// ⚠️ 用例一律用**显式 `today`**（或 orderTime 留空），别让断言随系统日期漂移。
import { describe, expect, it } from 'vitest';
import { aggregatePicking, type PickingGroup, type PickingRow } from '../src/lib/picking';
import { amountText, centsMoney, money, noPriceNote, sheetImageModelOf, sheetModelOf, sheetTextOf } from '../src/lib/pickingSheet';

const infoBlock = (qty: number) => `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:${qty} piece)`;

function row(over: Partial<PickingRow> = {}): PickingRow {
  return {
    id: 1,
    orderNo: 'O1',
    shop: '店A',
    orderTime: '',
    styleCode: 'S1',
    styleName: '款一',
    styleColor: '红',
    styleColorId: 0,
    color: '黑',
    size: 'L',
    itemId: 'ITEM1',
    supplierId: 7,
    supplierName: '厂A',
    imagePath: '/tmp/a.jpg',
    shipped: false,
    bizStatus: '等待发货',
    actualCostCents: null,
    costCents: null,
    productCostCents: null,
    rawFields: { 商品信息: infoBlock(1) },
    ...over,
  };
}

const META = { supplierId: 7, supplierName: '厂A', date: '2026-10-10' };

describe('pickingSheet：金额展示口径', () => {
  it('money：两位小数（NaN / 脏值按 0，不抛）', () => {
    expect(money(9.5)).toBe('9.50');
    expect(money(20)).toBe('20.00');
    expect(money(Number.NaN)).toBe('0.00');
  });

  it('centsMoney：分 → 元（单据口径；NaN / 脏值按 0，不抛）', () => {
    expect(centsMoney(50000)).toBe('500.00'); // 包价单 500.00 元
    expect(centsMoney(12000)).toBe('120.00');
    expect(centsMoney(5550)).toBe('55.50');
    expect(centsMoney(0)).toBe('0.00');
    expect(centsMoney(Number.NaN)).toBe('0.00');
    expect(centsMoney(undefined)).toBe('0.00');
  });

  it('amountText：有价写 ¥、**全缺价写 —**（0 元 ≠ 不知道多少钱）；部分缺价照写金额', () => {
    expect(amountText(20, 0, 2)).toBe('¥20.00');
    expect(amountText(0, 2, 2)).toBe('—'); // 一件价都没查到
    expect(amountText(0, 3, 2)).toBe('—'); // 缺价件数比总件数还多（脏数据）也不写 0
    expect(amountText(24, 2, 4)).toBe('¥24.00'); // 部分缺价：金额只含有价件，照写
  });

  it('noPriceNote：无缺价不出现；全缺说「全部」，部分缺说「不含」', () => {
    expect(noPriceNote(0, 2)).toBe('');
    expect(noPriceNote(2, 2)).toBe('（2 件全部无进价）');
    expect(noPriceNote(2, 4)).toBe('（不含 2 件无进价）');
  });
});

describe('sheetModelOf：发厂清单模型', () => {
  /**
   * 厂A：S1·黑（L 还差 2 / M 拿完，有价 10 元）；S2·白（XL 还差 2，**无价**）
   * 厂B：S3·蓝（L 还差 3 + XL 还差 2，有价 4 元）
   * 两家同场 ⇒ "按厂家精确筛"这条判据才有可观测的对照面。
   */
  function fixture(): PickingGroup[] {
    return aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 3, orderNo: 'O3', styleCode: 'S2', styleName: '', color: '白', size: 'XL', imagePath: '', rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 4, orderNo: 'O4', styleCode: 'S3', color: '蓝', size: 'L', supplierId: 8, supplierName: '厂B', costCents: 400, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 5, orderNo: 'O5', styleCode: 'S3', color: '蓝', size: 'XL', supplierId: 8, supplierName: '厂B', costCents: 400, rawFields: { 商品信息: infoBlock(2) } }),
      ],
      {
        taken: { 'S1|黑|L': 1, 'S1|黑|M': 2 },
      },
    ).groups;
  }

  it('没有待拿的行 → null：空入参 / 全忽略 / 全拿完（不发出空图）', () => {
    expect(sheetModelOf(null, META)).toBeNull();
    expect(sheetModelOf([], META)).toBeNull();
    const ignored = aggregatePicking([row()], { ignored: new Set(['S1|黑']) }).groups;
    expect(sheetModelOf(ignored, META)).toBeNull();
    const done = aggregatePicking([row()], { taken: { 'S1|黑|L': 1 } }).groups;
    expect(sheetModelOf(done, META)).toBeNull();
  });

  it('按厂家精确筛：只成型本厂的行，别家的不进来（含 supplierId = 0 的精确匹配）', () => {
    const g = fixture();
    const a = sheetModelOf(g, META)!;
    expect(a.lines.map((l) => l.key)).toEqual(['S1 · 黑', 'S2 · 白']);
    const b = sheetModelOf(g, { supplierId: 8, supplierName: '厂B', date: '2026-10-10' })!;
    expect(b.lines.map((l) => l.key)).toEqual(['S3 · 蓝']);
    // 未指定厂家（id 0）也是一档：只有 id 0 的行进它
    const none = aggregatePicking([row({ supplierId: 0, supplierName: '' })]).groups;
    expect(sheetModelOf(none, { supplierId: 0, supplierName: '', date: '2026-10-10' })!.lines).toHaveLength(1);
    expect(sheetModelOf(g, { supplierId: 0, supplierName: '', date: '2026-10-10' })).toBeNull();
  });

  it('行内容：款色键（内部身份）/ 对外展示名（**不含款编码**）/ 款名 / 图片路径；件数 = 还差合计', () => {
    const m = sheetModelOf(fixture(), META)!;
    const s1 = m.lines[0];
    expect(s1.key).toBe('S1 · 黑'); // 内部身份照旧（排序/去重用）
    expect(s1.label).toBe('款一 · 黑'); // 对外文案：款编码不进 label（卡上/清单图/文字清单同口径）
    expect(s1.styleName).toBe('款一');
    expect(s1.localPath).toBe('/tmp/a.jpg');
    expect(s1.pieces).toBe(2); // L 还差 2；M 拿完了，不进
    const s2 = m.lines[1];
    expect(s2.label).toBe('白'); // 缺款名只写颜色，不把款编码编出去
    expect(s2.localPath).toBe(''); // 无图门店照发（图是给厂家看的，不是必要条件）
    expect(s2.pieces).toBe(2);
  });

  it('sizesText：只列**还差 > 0** 的码，格式 = `码×件`（与 xlsx 烧进图的角标同一实现）', () => {
    const m = sheetModelOf(fixture(), META)!;
    expect(m.lines[0].sizesText).toBe('L×2'); // M 拿完 → 不出现（拿完了不用再报）
    const b = sheetModelOf(fixture(), { supplierId: 8, supplierName: '厂B', date: '2026-10-10' })!;
    expect(b.lines[0].sizesText).toBe('L×3  XL×2'); // 多码两空格相接，按码序排
    // 缺码用 `?` 占位（与 sizeQtyBadge 同一套词），不吞行
    const blank = aggregatePicking([row({ size: '' })]).groups;
    expect(sheetModelOf(blank, META)!.lines[0].sizesText).toBe('?×1');
  });

  it('单价/小计：有价 `¥`、整款无价 `—`（不写 ≈¥0.00）；行小计 = Σ 各码还差 × 该码取到的价', () => {
    const m = sheetModelOf(fixture(), META)!;
    expect(m.lines[0].unitPriceText).toBe('¥10.00');
    expect(m.lines[0].amountText).toBe('≈¥20.00'); // 2 件 × 10
    expect(m.lines[1].unitPriceText).toBe('—');
    expect(m.lines[1].amountText).toBe('—'); // 全无价 → 不写 ≈¥0.00

    // 同款两码的价可以不同（L 行钉 10 元、M 行钉 12 元）——
    // 行小计是「Σ 各码还差 × 该码的价」= 2×10 + 2×12 = 44，**不是**"还差合计 × 均价"（4×10.8=43.2）：
    // 这条断言专门分辨这两种实现（屏上/xlsx 同此口径）。
    const mixed = aggregatePicking(
      [
        row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
        row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1200, rawFields: { 商品信息: infoBlock(2) } }),
      ],
      { days: 0, taken: { 'S1|黑|L': 1 } },
    ).groups;
    const line = sheetModelOf(mixed, META)!.lines[0];
    expect(line.unitPriceText).toBe('¥10.80'); // 展示用均价 = 有价需求的加权均价
    expect(line.amountText).toBe('≈¥44.00');
  });

  it('footer：与 pendingRollup 同源（款色 / 件数 / 预估 + 缺价说明）', () => {
    const m = sheetModelOf(fixture(), META)!;
    expect(m.footer).toBe('共 2 款色 · 4 件 · 预估 ¥20.00（不含 2 件无进价）');
    const b = sheetModelOf(fixture(), { supplierId: 8, supplierName: '厂B', date: '2026-10-10' })!;
    expect(b.footer).toBe('共 1 款色 · 5 件 · 预估 ¥20.00');
    // 全无价：金额写 `—`、说明写「全部」
    const none = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })]).groups;
    expect(sheetModelOf(none, META)!.footer).toBe('共 1 款色 · 3 件 · 预估 —（3 件全部无进价）');
  });

  it('title：`拿货单 · 厂家 · 日期`；厂家为空（未指定厂家）时说人话不空着', () => {
    expect(sheetModelOf(fixture(), META)!.title).toBe('拿货单 · 厂A · 2026-10-10');
    const none = aggregatePicking([row({ supplierId: 0, supplierName: '' })]).groups;
    expect(sheetModelOf(none, { supplierId: 0, supplierName: '', date: '2026-10-10' })!.title).toBe(
      '拿货单 · 未指定厂家 · 2026-10-10',
    );
  });

  it('行序确定：与输入顺序无关（件数降序 → 键升序，复用 groupByColor 的排序）', () => {
    const rev = aggregatePicking(
      [
        row({ id: 3, orderNo: 'O3', styleCode: 'S2', color: '白', size: 'XL', costCents: 100, rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
        row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
      ],
      { taken: { 'S1|黑|M': 2 } },
    ).groups;
    expect(sheetModelOf(rev, META)!.lines.map((l) => l.key)).toEqual(['S1 · 黑', 'S2 · 白']);
  });
});

describe('sheetImageModelOf：发出去的图只画"要拿什么"（2026-11-02 用户要求）', () => {
  /**
   * 判据的三条都写成**"整张图模型的序列化文本里不许出现"**，而不是逐字段查：
   * 图是画布逐字 `fillText` 出来的，渲染层的取数面就是这份模型 —— 只要模型里没有这些串，
   * 图上就画不出来。逐字段断言会漏掉"换个字段名又把它加回去"这种改法。
   */
  function imgModel() {
    const g = aggregatePicking([
      row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
      row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
      row({ id: 3, orderNo: 'O3', styleCode: 'S2', styleName: '款二', color: '白', size: 'XL', imagePath: '', rawFields: { 商品信息: infoBlock(2) } }),
    ], { taken: { 'S1|黑|L': 1 } }).groups;
    return sheetImageModelOf(sheetModelOf(g, META)!);
  }

  it('款名、款编码、厂家名、金额 —— 一条都不许进图（序列化后逐串查）', () => {
    const blob = JSON.stringify(imgModel());
    expect(blob).not.toContain('¥'); // 单价 / 小计 / 合计金额
    expect(blob).not.toContain('预估');
    expect(blob).not.toContain('款一'); // 自家商品标题
    expect(blob).not.toContain('款二');
    expect(blob).not.toContain('厂A'); // 图就发给这一家，标题不再挂名
    expect(blob).not.toContain('S1'); // 款编码是内部身份，一直不上图
    expect(blob).not.toContain('S2');
  });

  it('行上只剩「颜色 + 尺码×件数 + 件数」，口径与文字清单同源（不另算一遍）', () => {
    const img = imgModel();
    expect(img.rows).toHaveLength(2);
    expect(img.rows[0]).toEqual({
      colorText: '黑',
      hasColor: true,
      localPath: '/tmp/a.jpg',
      sizesText: 'M×2  L×2', // 两码都还差；按码序排（`sizeOrder`，与屏上/xlsx 同一份）
      pieces: 4,
    });
    expect(img.rows[1].colorText).toBe('白');
    expect(img.rows[1].localPath).toBe(''); // 无图照发：渲染层画「缺图」占位
  });

  it('缺色写「未标色」并标 hasColor=false（渲染层据此走告警色，不画成正常行）', () => {
    const g = aggregatePicking([row({ color: '', styleName: '款一' })]).groups;
    const img = sheetImageModelOf(sheetModelOf(g, META)!);
    expect(img.rows[0].colorText).toBe('未标色');
    expect(img.rows[0].hasColor).toBe(false);
    expect(JSON.stringify(img)).not.toContain('款一'); // 缺色时**不回落款名**（否则等于把款名加回图）
  });

  it('标题 / 日期 / 落款：`拿货单` + 日期 + `共 N 款色 · M 件`（落款不含金额）', () => {
    const img = imgModel();
    expect(img.title).toBe('拿货单');
    expect(img.date).toBe('2026-10-10');
    expect(img.hint).toBe('按图备货 · L×2 = L 码拿 2 件');
    expect(img.footer).toBe('共 2 款色 · 6 件');
  });
});

describe('sheetTextOf：一键复制的纯文字清单（微信粘贴）', () => {
  it('四段式：标题（厂家 + 日期）→ 每行「款名 · 颜色：尺码×件数 · 件数」（**无款编码**）→ 合计行', () => {
    const m = sheetModelOf(
      aggregatePicking(
        [
          row({ id: 1, orderNo: 'O1', size: 'L', costCents: 1000, rawFields: { 商品信息: infoBlock(3) } }),
          row({ id: 2, orderNo: 'O2', size: 'M', costCents: 1000, rawFields: { 商品信息: infoBlock(2) } }),
          row({ id: 3, orderNo: 'O3', styleCode: 'S2', styleName: '款二', color: '白', size: 'XL', imagePath: '', rawFields: { 商品信息: infoBlock(2) } }),
        ],
        { taken: { 'S1|黑|L': 1 } },
      ).groups,
      META,
    )!;
    expect(sheetTextOf(m)).toBe(
      '拿货单 · 厂A · 2026-10-10\n' +
        '款一 · 黑：M×2  L×2 · 4 件\n' +
        '款二 · 白：XL×2 · 2 件\n' +
        '共 2 款色 · 6 件 · 预估 ¥40.00（不含 2 件无进价）',
    );
  });

  it('数字与模型同源：改 taken / 行上价后文字跟着变（不在这里另算一遍）', () => {
    const base = aggregatePicking([row({ costCents: 1000, rawFields: { 商品信息: infoBlock(3) } })]).groups;
    expect(sheetTextOf(sheetModelOf(base, META)!)).toContain('款一 · 黑：L×3 · 3 件');
    const taken = aggregatePicking([row({ costCents: 1000, rawFields: { 商品信息: infoBlock(3) } })], {
      taken: { 'S1|黑|L': 1 },
    }).groups;
    expect(sheetTextOf(sheetModelOf(taken, META)!)).toContain('款一 · 黑：L×2 · 2 件');
    // 全拿完 → 模型 null（调用方据此不复制，而不是复制一份空清单）
    const done = aggregatePicking([row({ rawFields: { 商品信息: infoBlock(3) } })], {
      taken: { 'S1|黑|L': 3 },
    }).groups;
    expect(sheetModelOf(done, META)).toBeNull();
  });

  it('缺款名的行只写颜色（款编码不外发 —— 不编一个名字出去）', () => {
    const g = aggregatePicking([row({ styleName: '', rawFields: { 商品信息: infoBlock(2) } })]).groups;
    expect(sheetTextOf(sheetModelOf(g, META)!)).toContain('黑：L×2 · 2 件');
  });
});
