// 「店铺商品ID → 产品」映射纯函数层单测（electron/shopSku.ts）。
//
// 为什么这个文件能被 vitest 跑而 `electron/product-db.ts` 不能：本模块只依赖 `./shopName`，
// 不 require better-sqlite3（`electron/db.ts` 会按 Electron ABI 加载原生模块，系统 Node 下抛
// NODE_MODULE_VERSION 149 vs 127）。故"什么算同一个商品ID""怎么聚合队列""哪条算已关联"
// 这三条唯一有正确性风险的逻辑在这里被测，DB 层只留 SQL，由 `npm run product:smoke` 覆盖。
//
// 断言的立足点（沿用 shopName.spec 的做法）：**漏关联是安全的（进队列等人确认），
// 错关联是不可逆的（两个产品的账并到一起）**。所以每条"应命中/应合并"都配一条反向断言 ——
// 防止哪天把口径改宽（折叠大小写、按前缀探测、拿空平台硬塞）而用例照样全绿。

import { describe, expect, it } from 'vitest';
import {
  aggregateQueue,
  buildQueueView,
  extractSkuFields,
  mappingKey,
  pickField,
  toSkuKey,
  type SkuOrderRow,
} from '../electron/shopSku';

const row = (shop: string, fields: Record<string, string>): SkuOrderRow => ({
  shop,
  rawFields: fields,
});

describe('toSkuKey：商品ID 与店铺名同一套归一口径', () => {
  it('去首尾空白、剥不可见字符、折叠全角空格', () => {
    expect(toSkuKey('  B0X1  ')).toBe('B0X1');
    expect(toSkuKey('B0\u200bX1')).toBe('B0X1');
    expect(toSkuKey('\ufeffB0X1')).toBe('B0X1');
    expect(toSkuKey('B0\u3000X1')).toBe('B0 X1');
  });

  it('不折叠大小写 —— 平台商品ID 是精确标识', () => {
    expect(toSkuKey('b0x1')).not.toBe(toSkuKey('B0X1'));
  });

  it('空 / 纯空白 / 非字符串 → 空键', () => {
    expect(toSkuKey('')).toBe('');
    expect(toSkuKey('   ')).toBe('');
    expect(toSkuKey(null)).toBe('');
    expect(toSkuKey(42)).toBe('');
  });
});

describe('mappingKey：复合键不撞车', () => {
  it('同平台同店同商品 → 同键（商品ID 与平台都走归一）', () => {
    expect(mappingKey('amazon', 3, 'B0X1')).toBe(mappingKey('amazon', 3, ' B0X1 '));
    // 平台的写入口有两处（sk_shops.platform / pl_shop_sku.platform），只 trim 的一侧会与折叠空白的一侧对不上
    expect(mappingKey('shopee  tw', 3, 'B0X1')).toBe(mappingKey('shopee tw', 3, 'B0X1'));
    expect(mappingKey(' shopee tw ', 3, 'B0X1')).toBe(mappingKey('shopee tw', 3, 'B0X1'));
  });

  it('平台 / 店铺 / 商品 任一不同 → 不同键', () => {
    expect(mappingKey('amazon', 3, 'B0X1')).not.toBe(mappingKey('shopee', 3, 'B0X1'));
    expect(mappingKey('amazon', 3, 'B0X1')).not.toBe(mappingKey('amazon', 4, 'B0X1'));
    expect(mappingKey('amazon', 3, 'B0X1')).not.toBe(mappingKey('amazon', 3, 'B0X2'));
  });

  it('分隔符防撞：空平台 + 店铺 12 不与「平台 1 + 店铺 2」同键', () => {
    expect(mappingKey('', 12, 'A')).not.toBe(mappingKey('1', 2, 'A'));
  });

  it('分隔符必须是文本里不可能出现的字符（带连字符的平台/商品ID 不得撞键）', () => {
    // 分隔符若用 '-'：`'a' + 1 + '2-b'` 与 `'a-1' + 2 + 'b'` 都拼成 "a-1-2-b" —— 两个不同
    // 的 (店, 商品) 共用一个映射，症状是"关联到了别的商品"且完全查不出原因。
    // 平台名带连字符（shopee-tw）与商品ID 带连字符都是现实写法，故这条必须钉住。
    expect(mappingKey('a', 1, '2-b')).not.toBe(mappingKey('a-1', 2, 'b'));
  });
});

describe('extractSkuFields：列名族探测', () => {
  it('命中商品ID 列名族（商品ID / 产品ID / SKU / 货号）', () => {
    expect(extractSkuFields({ 商品ID: 'A1' }).itemId).toBe('A1');
    expect(extractSkuFields({ '产品 ID': 'A2' }).itemId).toBe('A2');
    expect(extractSkuFields({ SKU: 'A3' }).itemId).toBe('A3');
    expect(extractSkuFields({ 货号: 'A4' }).itemId).toBe('A4');
  });

  it('取标题仅用于展示，不参与匹配', () => {
    expect(extractSkuFields({ 商品ID: 'A1', 商品标题: '一件T恤' }).title).toBe('一件T恤');
    expect(extractSkuFields({ 商品ID: 'A1', 产品名称: '一条裤子' }).title).toBe('一条裤子');
  });

  it('**不得**把非ID列当成商品ID（数量 / 订单号 / 规格）', () => {
    const r = extractSkuFields({ 数量: '3', 订单号: 'SO-1', 规格: '红色/M' });
    expect(r.itemId).toBe('');
    expect(extractSkuFields({}).itemId).toBe('');
    expect(extractSkuFields(null).itemId).toBe('');
  });

  it('列名族命中但值为空 → 不算命中（继续找下一族）', () => {
    expect(pickField({ 商品ID: '   ', SKU: 'B9' }, [/商品\s*ID/i, /SKU/i]).value).toBe('B9');
  });
});

describe('aggregateQueue：按 (店铺, 商品ID) 聚合', () => {
  it('同一店同一商品的多行合并计数，展示原文取最短形态', () => {
    const r = aggregateQueue([
      row('店A ', { 商品ID: 'X1' }),
      row('店A', { 商品ID: 'X1' }),
      row('店A', { 商品ID: 'X1' }),
    ]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ shopKey: '店A', shopRaw: '店A', itemId: 'X1', orderCount: 3 });
    expect(r.withItemId).toBe(3);
    expect(r.withoutItemId).toBe(0);
  });

  it('店铺不同 / 商品ID 不同 → 分组不同（不跨店合并）', () => {
    const r = aggregateQueue([
      row('店A', { 商品ID: 'X1' }),
      row('店B', { 商品ID: 'X1' }),
      row('店A', { 商品ID: 'X2' }),
    ]);
    expect(r.groups).toHaveLength(3);
    expect(r.groups.every((g) => g.orderCount === 1)).toBe(true);
  });

  it('无商品ID / 无店铺的行不计入队列但必须计数（防无声丢行）', () => {
    const r = aggregateQueue([
      row('店A', { 商品ID: 'X1' }),
      row('店A', { 数量: '1' }),
      row('', { 商品ID: 'X9' }),
      row('店A', { SKU: '  ' }),
    ]);
    expect(r.groups).toHaveLength(1);
    expect(r.withItemId).toBe(1);
    expect(r.withoutItemId).toBe(3);
  });

  it('标题取同组最长的一条（越长的越可能是完整标题）', () => {
    const r = aggregateQueue([
      row('店A', { 商品ID: 'X1', 商品标题: 'T恤' }),
      row('店A', { 商品ID: 'X1', 商品标题: '纯棉短袖T恤 白色' }),
    ]);
    expect(r.groups[0].title).toBe('纯棉短袖T恤 白色');
  });

  it('排序与插入顺序无关：订单数降序 → 商品ID 升序', () => {
    const a = aggregateQueue([
      row('店B', { 商品ID: 'X2' }),
      row('店A', { 商品ID: 'X1' }),
      row('店A', { 商品ID: 'X1' }),
    ]);
    const b = aggregateQueue([
      row('店A', { 商品ID: 'X1' }),
      row('店A', { 商品ID: 'X1' }),
      row('店B', { 商品ID: 'X2' }),
    ]);
    expect(a.groups.map((g) => g.itemId)).toEqual(['X1', 'X2']);
    expect(b.groups.map((g) => g.itemId)).toEqual(a.groups.map((g) => g.itemId));
  });

  it('超过扫描上限即截断并**明确置位**（不静默只算一部分）', () => {
    const r = aggregateQueue(
      [row('店A', { 商品ID: 'X1' }), row('店A', { 商品ID: 'X2' }), row('店A', { 商品ID: 'X3' })],
      2,
    );
    expect(r.truncated).toBe(true);
    expect(r.groups).toHaveLength(2);
  });
});

describe('buildQueueView：归类与已关联剔除', () => {
  const shopsById = new Map([
    [3, { name: '店铺3', platform: 'amazon' }],
    [4, { name: '店铺4', platform: 'shopee' }],
  ]);

  it('店铺已人工归一 + 有生效映射 → 不进队列，计入 stats.mapped', () => {
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set([mappingKey('amazon', 3, 'X1')]),
    });
    expect(r.rows).toHaveLength(0);
    expect(r.stats.mapped).toBe(1);
  });

  it('已归一但无映射 → unmapped，带上店铺名与平台', () => {
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
    });
    expect(r.rows[0]).toMatchObject({
      status: 'unmapped',
      shopId: 3,
      shopName: '店铺3',
      platform: 'amazon',
      autoShopId: 0,
    });
    expect(r.stats.unmapped).toBe(1);
  });

  it('店铺尚未归一 → shopUnresolved，**不允许**写映射（不拿空平台硬塞）', () => {
    const r = buildQueueView({
      orders: [row('店C', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map(),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
    });
    expect(r.rows[0]).toMatchObject({ status: 'shopUnresolved', shopId: 0, platform: '' });
    expect(r.stats.shopUnresolved).toBe(1);
  });

  it('自动命中只作建议（autoShopId），绝不因此视为已归一', () => {
    const r = buildQueueView({
      orders: [row('店C', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map(),
      autoShopByKey: new Map([['店C', { id: 4, name: '店铺4', platform: 'shopee' }]]),
      shopsById,
      mappedKeys: new Set(),
    });
    expect(r.rows[0]).toMatchObject({
      status: 'shopUnresolved',
      shopId: 0,
      autoShopId: 4,
      autoShopPlatform: 'shopee',
    });
  });

  it('人工归一优先：已归一的行不再给建议（避免两个来源的答案打架）', () => {
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map([['店A', { id: 4, name: '店铺4', platform: 'shopee' }]]),
      shopsById,
      mappedKeys: new Set(),
    });
    expect(r.rows[0]).toMatchObject({ shopId: 3, autoShopId: 0, autoShopName: '' });
  });

  it('映射按「店铺维度」判定：换一家店不复用另一家店的映射', () => {
    const r = buildQueueView({
      orders: [row('店B', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店B', 4]]),
      autoShopByKey: new Map(),
      shopsById,
      // 映射只存在于 amazon/3 下 —— shopee/4 必须仍然进队列
      mappedKeys: new Set([mappingKey('amazon', 3, 'X1')]),
    });
    expect(r.rows).toHaveLength(1);
    expect(r.stats.mapped).toBe(0);
  });

  it('stats 对账：unmapped + shopUnresolved + mapped = 聚合组数', () => {
    const r = buildQueueView({
      orders: [
        row('店A', { 商品ID: 'X1' }),
        row('店B', { 商品ID: 'X2' }),
        row('店C', { 商品ID: 'X3' }),
      ],
      manualShopIdByKey: new Map([
        ['店A', 3],
        ['店B', 4],
      ]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set([mappingKey('amazon', 3, 'X1')]),
    });
    const s = r.stats;
    expect(s.unmapped + s.shopUnresolved + s.mapped).toBe(s.groups);
    expect(s.groups).toBe(3);
    expect([s.unmapped, s.shopUnresolved, s.mapped]).toEqual([1, 1, 1]);
  });

  it('limit 只截断返回行，不影响 stats 的分类计数；且截断必须从**队首**取', () => {
    const r = buildQueueView({
      orders: [
        row('店C', { 商品ID: 'X2' }),
        row('店A', { 商品ID: 'X1' }),
        row('店A', { 商品ID: 'X1' }),
      ],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
      limit: 1,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.stats.shown).toBe(1);
    expect(r.stats.groups).toBe(2);
    expect(r.stats.unmapped).toBe(1);
    expect(r.stats.shopUnresolved).toBe(1);
    // 队首 = 订单行数最多的那一组（X1 有 2 行）。取尾部（`slice(-limit)`）会把最该处理的丢掉，
    // 而单看行数仍然"返回了 limit 行"，看起来完全正常。
    expect(r.rows[0].itemId).toBe('X1');
    expect(r.rows[0].orderCount).toBe(2);
  });
});
