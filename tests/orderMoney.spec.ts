// 订单「钱 / 状态 / 时点」解析层的契约用例。
//
// 钉住的是**口径**（都来自真实报表实证 2026-09-29）：
//   · 金额存分、带币种前缀、千分位；**空 = null，绝不折成 0**（0 会把"缺税"算成"零税"）；
//   · 金额列之间没有稳定等式 → 逐列如实取，不做派生（少存一列以后就得重导）；
//   · 状态与税的原文本层只**原样带出**，怎么分桶/谁承担在 `src/lib/orderCost.ts` 判定
//     （判定属算账口径，那边才是消费方 —— 两侧各写一份必然漂移）。
import { describe, expect, it } from 'vitest';
import { extractOrderMoney, parseMoneyCell } from '../electron/orderMoney';

describe('parseMoneyCell', () => {
  it('带币种前缀与小数', () => {
    expect(parseMoneyCell('CN￥ 199.87')).toEqual({ cents: 19987, currency: 'CN￥' });
  });

  it('千分位逗号', () => {
    expect(parseMoneyCell('CN￥ 1,234.56')).toEqual({ cents: 123456, currency: 'CN￥' });
    expect(parseMoneyCell('US$ 12,000')).toEqual({ cents: 1200000, currency: 'US$' });
  });

  it('无前缀的纯数字也认（别的平台导出可能不带币种）', () => {
    expect(parseMoneyCell('99.5')).toEqual({ cents: 9950, currency: '' });
    expect(parseMoneyCell(5)).toEqual({ cents: 500, currency: '' });
  });

  it('负数认得出（退款/冲销）', () => {
    expect(parseMoneyCell('-12.34')?.cents).toBe(-1234);
  });

  it('空 / 认不出 → null（**不是 0**）', () => {
    expect(parseMoneyCell('')).toBeNull();
    expect(parseMoneyCell('   ')).toBeNull();
    expect(parseMoneyCell(null)).toBeNull();
    expect(parseMoneyCell(undefined)).toBeNull();
    expect(parseMoneyCell('待定')).toBeNull();
    expect(parseMoneyCell('CN￥')).toBeNull();
  });

  it('保留两位以内的精度（四舍五入到分）', () => {
    expect(parseMoneyCell('0.005')?.cents).toBe(1);
    expect(parseMoneyCell('0.004')?.cents).toBe(0);
  });
});

describe('extractOrderMoney', () => {
  // 取自真实报表第一行（含 4 个全空列）
  const row: Record<string, string> = {
    订单号: '3076475435222658',
    订单状态: '等待买家收货',
    下单时间: '08/30/2026 07:00',
    付款时间: '08/30/2026 07:00',
    供货价: '',
    产品总金额: 'CN￥ 199.87',
    物流费用: '',
    预计增值税: 'CN￥ 34.69',
    平台是否代征代缴: '平台已税',
    预计RST: '',
    订单金额: 'CN￥ 165.18',
    买家实付金额: '',
    DDP关税: 'CN￥ 22.94',
    店铺优惠: 'CN￥ 0.00',
    托管商家折扣: '',
    平台补贴: '',
    商品ID: '1005011764572483',
    确认收货时间: '',
    发货时间: '08/31/2026 12:57',
    订单业务模式: '半托管jit订单',
  };

  it('**只提主线要的列**（金额/税/代征代缴/状态/发货时点），逐列如实（分）', () => {
    const m = extractOrderMoney(row);
    expect(m.amountCents).toBe(16518);
    expect(m.vatCents).toBe(3469);
    expect(m.ddpCents).toBe(2294);
    expect(m.taxPlatformRaw).toBe('平台已税');
    expect(m.bizStatus).toBe('等待买家收货');
    expect(m.shipTime).toBe('08/31/2026 12:57');
  });

  it('**不再提取**零读者列（货值/买家运费/店铺优惠/平台补贴/币种/业务模式/付款·收货时点）\n'
    + '   —— 它们的原文仍在 `raw_fields` 里保真，需要时随时能加回来', () => {
    const m = extractOrderMoney(row) as unknown as Record<string, unknown>;
    for (const dropped of [
      'goodsCents', 'shipFeeCents', 'shopDiscountCents', 'platformSubsidyCents',
      'currency', 'bizMode', 'paidTime', 'receivedTime',
    ]) {
      expect(m[dropped], `不该再有 ${dropped}`).toBeUndefined();
    }
  });

  it('列名族宽松：换一家平台的导出名也能认（增值税）', () => {
    const m = extractOrderMoney({ 增值税: '1.00', 状态: '交易完成' });
    expect(m.vatCents).toBe(100);
    expect(m.bizStatus).toBe('交易完成');
  });

  it('空行 / 缺列不炸，全部落 null / 空串', () => {
    const m = extractOrderMoney({});
    expect(m.amountCents).toBeNull();
    expect(m.vatCents).toBeNull();
    expect(m.bizStatus).toBe('');
    expect(m.shipTime).toBe('');
  });
});

