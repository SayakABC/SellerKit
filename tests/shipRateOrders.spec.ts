// shipRateOrders 单测 —— 按订单算运费的数据衔接层。
//
// 三块纯函数，各自对应一类"静默算错"的失效方式：
//   resolveCountry（订单国名 → 运价表国家行）—— 国名对不上会**整单拒算**或更糟：算到别国头上；
//   quoteOrders（逐单批量计价）             —— 拒算分类错了会把"数据没打通"伪装成"没运价"。
// 计价口径本身（pickCard/computeFee/拒算）由 shipRate.spec.ts 钉住，本文件只测衔接与分类。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import {
  buildCountryIndex,
  extractShipping,
  quoteOrders,
  resolveCountry,
  type OrderShippingRow,
} from '../src/lib/shipRateOrders';
import { normalizeRateSheet, type RateTable } from '../src/lib/shipRate';
import { quoteAll } from '../src/lib/shipRateQuote';

// 真实报价单夹具（与 shipRate.spec.ts 同源）：resolveCountry 的"实表能对上"必须拿真表验证
const SHEET = '无忧物流-标准';
function rateTable(): RateTable {
  const buf = readFileSync(new URL('./fixtures/shipping-rate.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  return normalizeRateSheet(
    XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: '' }) as unknown[][],
    SHEET
  );
}

// ─────────────────────────────────────────────────────────── resolveCountry

describe('resolveCountry · 订单国名 → 运价表国家行', () => {
  const index = buildCountryIndex(rateTable());

  it('ISO 码 / 英文名（大小写与空白不敏感）/ 中文名都能精确命中', () => {
    expect(resolveCountry(index, 'US')?.nameCn).toBeTruthy();
    expect(resolveCountry(index, 'united states')?.nameEn).toBeTruthy();
    expect(resolveCountry(index, '美国')).toBeTruthy();
    expect(resolveCountry(index, '俄罗斯')).toBeTruthy();
  });

  it('全角字符与标点：ＵＳＡ、U.S.A 都落到同一国', () => {
    const hit = resolveCountry(index, 'ＵＳＡ') ?? resolveCountry(index, 'U.S.A');
    expect(hit).toBeTruthy();
  });

  it('别名表：South Korea 这类速卖通拼法（报价单写 Korea）', () => {
    expect(resolveCountry(index, 'South Korea')).toBeTruthy();
  });

  it('别名表（前缀包含覆盖不到的短拼法）：UK / USA', () => {
    // UK 只有 2 字符，前缀包含被禁用 —— 只能靠别名表命中
    expect(resolveCountry(index, 'UK')?.nameCn).toBeTruthy();
    expect(resolveCountry(index, 'ＵＳＡ')?.nameCn).toBeTruthy();
  });

  it('前缀包含（≥4 字才启用）：精确与别名都不命中的带注记写法', () => {
    // 精确（'unitedstatesofamerica' 不在索引）与别名都不命中，只能靠 n.includes(k)
    expect(resolveCountry(index, 'United States of America')).toBeTruthy();
    expect(resolveCountry(index, 'Russian Federation')).toBeTruthy();
  });

  it('对不上就 null（空串 / 乱写）—— 不静默猜', () => {
    expect(resolveCountry(index, '')).toBeNull();
    expect(resolveCountry(index, '火星')).toBeNull();
    expect(resolveCountry(index, 'ab')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────── extractShipping

describe('extractShipping · raw_fields 字段提取', () => {
  it('标准键名直接命中', () => {
    const r = extractShipping({ 收货国家: 'United States', 商品ID: '1001', 数量: '2' });
    expect(r).toEqual({ country: 'United States', itemId: '1001' });
  });

  it('键名变体逐级回落（收货人国家 / 国家 / SKU）', () => {
    expect(extractShipping({ 收货人国家: '巴西', 商品ID: '1' }).country).toBe('巴西');
    expect(extractShipping({ 国家: '法国' }).country).toBe('法国');
    expect(extractShipping({ SKU: 'X9' }).itemId).toBe('X9');
  });

  it('「国家」放在兜底位：有「收货国家」时绝不撞上别的含国字列', () => {
    expect(extractShipping({ 国家别名表: 'A', 收货国家: 'B' }).country).toBe('B');
  });

  it('缺失返回空串（不抛错，由 quoteOrders 分口径拒算）', () => {
    expect(extractShipping({})).toEqual({ country: '', itemId: '' });
  });
});

// ─────────────────────────────────────────────────────────── quoteOrders

/** 最小合成运价表：一张 CNY 卡（100–2000g）+ 一张 USD 卡（0–2000g）+ 大包卡 */
function tinyTable(): RateTable {
  return {
    sheetName: 'tiny',
    countries: [
      {
        code: 'US',
        nameCn: '美国',
        nameEn: 'United States',
        cards: [
          {
            minG: 0,
            maxG: 2000,
            categories: ['general'],
            mode: 'perKg',
            ratePerKg: 80,
            registerFee: 8,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'CNY',
            minChargeG: 10,
          },
        ],
      },
      {
        code: 'GB',
        nameCn: '英国',
        nameEn: 'United Kingdom',
        cards: [
          {
            minG: 0,
            maxG: 2000,
            categories: ['any'],
            mode: 'perKg',
            ratePerKg: 66.2,
            registerFee: 19.2,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'USD',
            minChargeG: 0,
          },
        ],
      },
      {
        code: 'RU',
        nameCn: '俄罗斯',
        nameEn: 'Russia',
        cards: [
          {
            minG: 2001,
            maxG: 30000,
            categories: ['bulk'],
            mode: 'perKg',
            ratePerKg: 44,
            registerFee: 0,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'CNY',
            minChargeG: 0,
          },
        ],
      },
    ],
    sections: [],
    stats: {
      sections: 1,
      countries: 3,
      cards: 3,
      perKgCards: 3,
      firstStepCards: 0,
      currencies: ['CNY', 'USD'],
    },
    warnings: [],
  };
}

const row = (over: Partial<OrderShippingRow>): OrderShippingRow => ({
  id: 1,
  orderNo: 'SO-1',
  country: 'United States',
  itemId: '1001',
  weightG: 500,
  ...over,
});

describe('quoteOrders · 逐单计价与拒算分类', () => {
  it('正常单：重量 × 1（数量恒按 1 件，见 extractShipping 注释）', () => {
    const { rows, summary } = quoteOrders(tinyTable(), [row({})]);
    expect(summary.ok).toBe(1);
    // 80 元/KG × 500g + 挂号 8 = 48
    expect(rows[0].fee).toBe(48);
    expect(rows[0].nameCn).toBe('美国');
  });

  it('最低计费重量生效：350g 商品遇 10g 起计无感，但 5g 会抬到 10g', () => {
    const { rows } = quoteOrders(tinyTable(), [row({ weightG: 5 })]);
    expect(rows[0].fee).toBeCloseTo(80 * (10 / 1000) + 8, 2);
  });

  it('缺克重单独成类，不冒充"无价"（与商品ID 无关：克重在 SKU 上、按款色码取）', () => {
    const { rows, summary } = quoteOrders(tinyTable(), [
      row({ weightG: null }),
      row({ weightG: null, orderNo: 'SO-2' }),
    ]);
    expect(summary.noWeight).toBe(2);
    expect(rows.every((x) => x.reason.includes('克重'))).toBe(true);
  });

  it('有克重但没商品ID 仍照常计价（克重不从商品ID 取，缺ID 不该拦）', () => {
    const { rows, summary } = quoteOrders(tinyTable(), [row({ itemId: '' })]);
    expect(summary.ok).toBe(1);
    // 80 元/KG × 500g + 挂号 8 = 48
    expect(rows[0].fee).toBe(48);
  });

  it('无国家 / 表没该国 分开计数，且 reasonClass 与行一一绑定', () => {
    const { rows, summary } = quoteOrders(tinyTable(), [
      row({ country: '', orderNo: 'A' }),
      row({ country: '火星', orderNo: 'B' }),
    ]);
    expect(summary.noCountry).toBe(1);
    expect(summary.unknownCountry).toBe(1);
    // 分类必须钉在行上：对称交换计数器/文案的变异在此现形
    expect(rows[0].reasonClass).toBe('noCountry');
    expect(rows[1].reasonClass).toBe('unknownCountry');
    expect(rows[1].reason).toContain('火星');
  });

  it('重量段无价 / 非本币拒算 分开计数（GBP 走 USD 卡），reasonClass 绑定到行', () => {
    const { rows, summary } = quoteOrders(tinyTable(), [
      row({ country: 'US', weightG: 999999 }), // 超出全部档位
      row({ country: 'United Kingdom', weightG: 500 }), // USD 卡 → 拒算
    ]);
    expect(summary.noPrice).toBe(1);
    expect(summary.refused).toBe(1);
    expect(rows[0].reasonClass).toBe('noPrice');
    expect(rows[1].reasonClass).toBe('refused');
  });

  it('缺重量的 reasonClass = noWeight（不冒充"无价"）', () => {
    const { rows } = quoteOrders(tinyTable(), [
      row({ weightG: null }),
      row({ weightG: null, orderNo: 'SO-2' }),
    ]);
    expect(rows[0].reasonClass).toBe('noWeight');
    expect(rows[1].reasonClass).toBe('noWeight');
  });

  it('混合批次：summary 各类互斥且 Σ = total', () => {
    const { summary } = quoteOrders(tinyTable(), [
      row({}),
      row({ weightG: null }),
      row({ country: '' }),
      row({ country: '火星' }),
      row({ country: 'US', weightG: 999999 }),
      row({ country: 'United Kingdom' }),
    ]);
    expect(summary.total).toBe(6);
    const Σ =
      summary.ok +
      summary.noWeight +
      summary.noCountry +
      summary.unknownCountry +
      summary.noPrice +
      summary.refused;
    expect(Σ).toBe(summary.total);
  });

  it('真实报价单（无忧物流-标准）上逐单试算：美国 500g 有价且与单点计价一致', () => {
    const t = rateTable();
    const { rows } = quoteOrders(t, [row({ country: 'United States', weightG: 500 })]);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].fee).toBeGreaterThan(0);
    // 与 shipRateQuote 的单点口径互证：同一张表同一克重 quoteAll 的美国结果应一致
    const all = quoteAll(t, 500, {});
    expect(all.find((x) => x.code === rows[0].code)?.fee).toBe(rows[0].fee);
  });
});
