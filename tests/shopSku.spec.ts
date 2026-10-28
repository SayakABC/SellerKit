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
  bindingKey,
  buildQueueView,
  extractSkuFields,
  normImageUrl,
  pickField,
  skuColorsByImage,
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

describe('bindingKey：映射身份 = (店铺, 商品ID)', () => {
  it('同店同商品 → 同键（商品ID 走归一）', () => {
    expect(bindingKey(3, 'B0X1')).toBe(bindingKey(3, ' B0X1 '));
    expect(bindingKey(3, 'B0X1')).toBe(bindingKey('3', 'B0X1')); // 入参来自 SQL / 表单，类型不稳定
  });

  it('店铺 / 商品 任一不同 → 不同键（不跨店复用）', () => {
    expect(bindingKey(3, 'B0X1')).not.toBe(bindingKey(4, 'B0X1'));
    expect(bindingKey(3, 'B0X1')).not.toBe(bindingKey(3, 'B0X2'));
  });

  it('⭐ 平台**不在**键里：同一 (店, 商品) 只有一个身份（这是 2026-10-20 的设计）', () => {
    // 平台是店铺行的属性，映射表那列只是写入时的副本。副本当键 ⇒ 店铺登记里改一次平台，
    // 该店全部映射一条都不命中，用户只能全量重配。故本函数**不收平台参数**（类型层面就不给机会）；
    // 行为侧的守卫在下面「队列：改过平台仍算已关联」那条。
    expect(bindingKey.length).toBe(2);
  });

  it('分隔符必须是文本里不可能出现的字符（带连字符的商品ID 不得撞键）', () => {
    // 分隔符若用 '-'：`'' + 1 + '2-b'` 与 `'' + 2 + 'b'` 这类拼接会撞成同一个串 —— 两个不同
    // 的 (店, 商品) 共用一个映射，症状是"关联到了别的商品"且完全查不出原因。
    expect(bindingKey(1, '2-b')).not.toBe(bindingKey(2, 'b'));
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

  it('itemKey 是**归一后**的商品ID，itemId 保留原文 —— 查图必须用前者', () => {
    // 为什么这条要单独守：队列的图走 `itemImagePool`，而它的池键是**归一后**的商品ID。
    // 这两个字段在界面上长得几乎一样（全角空格肉眼不可辨），一旦图那侧误用 `itemId`，
    // 症状是"整列的图都不见了"却**不报错** —— 看起来像订单里本来就没有图。
    const r = aggregateQueue([row('店A', { 商品ID: 'B0X1\u3000\u3000A' })]);
    expect(r.groups[0].itemId).toBe('B0X1\u3000\u3000A'); // 原文（只去了首尾空白）
    expect(r.groups[0].itemKey).toBe('B0X1 A'); // 归一：全角空格折叠成半角单空格
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
      mappedKeys: new Set([bindingKey(3, 'X1')]),
    });
    expect(r.rows).toHaveLength(0);
    expect(r.stats.mapped).toBe(1);
  });

  it('⭐ 店铺改过平台仍算已关联（键里没有平台）—— 改平台不该让人重配一遍', () => {
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      // 店铺已改成 temu，而映射行是当年在 amazon 下写的：键若含平台，这里就查不中 ⇒
      // 该商品被当成"未关联"重新塞回待办（用户必须先发现、再全量重配）
      shopsById: new Map([[3, { name: '店铺3', platform: 'temu' }]]),
      mappedKeys: new Set([bindingKey(3, 'X1')]),
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

  it('itemKey 一路透传到队列行 —— 界面拿它查图（拿 itemId 会静默查不到）', () => {
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'B0X1\u3000A' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
    });
    expect(r.rows[0].itemId).toBe('B0X1\u3000A'); // 原文（界面展示用）
    expect(r.rows[0].itemKey).toBe('B0X1 A'); // 归一键（查图用）
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
      mappedKeys: new Set([bindingKey(3, 'X1')]),
    });
    expect(r.rows).toHaveLength(1);
    expect(r.stats.mapped).toBe(0);
  });

  it('店铺原文认不出、但商品ID 能反查采集快照 → 按已认店处理（不再报"店铺未归一"）', () => {
    const r = buildQueueView({
      orders: [row('Shop1105671703 Store', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map(),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
      resolveShopByItemId: (itemId) => (itemId === 'X1' ? 4 : 0),
    });
    expect(r.rows[0]).toMatchObject({
      status: 'unmapped',
      shopId: 4,
      shopName: '店铺4',
      platform: 'shopee',
      autoShopId: 0,
    });
    expect(r.stats.shopUnresolved).toBe(0);
  });

  it('反查认店后若已有该店生效映射 → 计入 mapped，**不得**留在待办里', () => {
    // 这条是"事后修补"实现抓不住的：剔除发生在 buildQueueView 内部，必须先认店再拼 bindingKey
    const r = buildQueueView({
      orders: [row('Shop1105671703 Store', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map(),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set([bindingKey(4, 'X1')]),
      resolveShopByItemId: () => 4,
    });
    expect(r.rows).toHaveLength(0);
    expect(r.stats.mapped).toBe(1);
  });

  it('人工归一优先：原文已归一就不再走反查（两个来源不许打架，也不白查）', () => {
    let asked = 0;
    const r = buildQueueView({
      orders: [row('店A', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map([['店A', 3]]),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
      resolveShopByItemId: () => {
        asked += 1;
        return 4;
      },
    });
    expect(asked).toBe(0);
    expect(r.rows[0].shopId).toBe(3);
  });

  it('反查不出（0 = 没采到过 / 多店歧义）→ 仍报 shopUnresolved，绝不猜一个店', () => {
    const r = buildQueueView({
      orders: [row('店C', { 商品ID: 'X1' })],
      manualShopIdByKey: new Map(),
      autoShopByKey: new Map(),
      shopsById,
      mappedKeys: new Set(),
      resolveShopByItemId: () => 0,
    });
    expect(r.rows[0]).toMatchObject({ status: 'shopUnresolved', shopId: 0, platform: '' });
    expect(r.stats.shopUnresolved).toBe(1);
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
      mappedKeys: new Set([bindingKey(3, 'X1')]),
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

// 按图定色（2026-10-19）：订单报表的「产品图片链接」= 逐单 SKU 图（真实库验过：
// 同一商品ID 的 9 条订单对应 4~6 张不同图），故图能反查颜色。
// 立足点同前：**定不了色是安全的（回落未分类，人看一眼），定错色是不可逆的（发错货）**。
describe('normImageUrl：只剥"不属于图本身"的部分', () => {
  it('剥查询串 / 锚点 / 尺寸后缀', () => {
    const base = 'https://ae-pic-a1.aliexpress-media.com/kf/Scb31.jpg';
    expect(normImageUrl(`${base}?x-oss-process=image/resize,w_220`)).toBe(base);
    expect(normImageUrl(`${base}#frag`)).toBe(base);
    // CDN 缩略图形态：`原图.jpg_220x220.jpg`
    expect(normImageUrl(`${base}_220x220.jpg`)).toBe(base);
    expect(normImageUrl(`  ${base}  `)).toBe(base);
  });

  it('不折大小写 —— 图床文件名大小写敏感，折叠会造假命中', () => {
    expect(normImageUrl('https://x/kf/Abc.jpg')).not.toBe(normImageUrl('https://x/kf/abc.jpg'));
  });

  it('空 / 非字符串 → 空串', () => {
    expect(normImageUrl('')).toBe('');
    expect(normImageUrl('   ')).toBe('');
    expect(normImageUrl(null)).toBe('');
    expect(normImageUrl(undefined)).toBe('');
    expect(normImageUrl(123)).toBe('');
  });
});

describe('skuColorsByImage：一张图 → 颜色（歧义必须暴露，不能取第一个）', () => {
  const rows = [
    { color: '7', imageUrl: 'https://x/kf/S7.jpg' },
    { color: '7', imageUrl: 'https://x/kf/S7.jpg' }, // 同色多码共用一张图 —— 常态
    { color: 'Khaki', imageUrl: 'https://x/kf/Sk.jpg' },
    { color: '', imageUrl: 'https://x/kf/S7.jpg' }, // 无色行不参与
    { color: '*', imageUrl: 'https://x/kf/S7.jpg' }, // 未指定色哨兵不是颜色
  ];

  it('同色多行去重成一条；带查询串也能命中', () => {
    expect(skuColorsByImage(rows, 'https://x/kf/S7.jpg')).toEqual(['7']);
    expect(skuColorsByImage(rows, 'https://x/kf/S7.jpg?x-oss-process=resize')).toEqual(['7']);
    expect(skuColorsByImage(rows, 'https://x/kf/Sk.jpg_220x220.jpg')).toEqual(['Khaki']);
  });

  it('多色共用一张图 → 返回多个（上游据此放弃，不猜）', () => {
    const shared = [
      { color: 'A', imageUrl: 'https://x/kf/same.jpg' },
      { color: 'B', imageUrl: 'https://x/kf/same.jpg' },
    ];
    expect(skuColorsByImage(shared, 'https://x/kf/same.jpg')).toEqual(['A', 'B']);
  });

  it('对不上 / 空图 / 空行 → 空数组', () => {
    expect(skuColorsByImage(rows, 'https://x/kf/other.jpg')).toEqual([]);
    expect(skuColorsByImage(rows, '')).toEqual([]);
    expect(skuColorsByImage([], 'https://x/kf/S7.jpg')).toEqual([]);
    expect(skuColorsByImage(null, 'https://x/kf/S7.jpg')).toEqual([]);
  });
});
