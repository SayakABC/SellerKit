// 「归类核对」批量单位（`src/lib/classifyBulk.ts`）的单测。
//
// 为什么这些规则值得钉住：它们在真库里是**看不见的**——
//   · 分组键错了 ⇒ 勾了 6 行、弹层里只剩 2 组（或者反过来多出一组），用户只会觉得"这功能不准"；
//   · `pickColorFor` 猜错 ⇒ 一整批订单被挂到同一个色上，而下游（取图 / 拿货 / 算钱）
//     全按「款 + 色」匹配，错了不会报错、只会**少件**。
// 两者都是"批量"这个动作的放大效应：错一行是错一行，错一批就是一批。
import { describe, expect, it } from 'vitest';
import {
  colorOptionsOf,
  groupByProduct,
  pickColorFor,
  productKeyOf,
  type BulkColorRow,
  type BulkGroupView,
} from '@/lib/classifyBulk';
import type { OrderRecord } from '@/types';

/** 只造这些规则读得到的字段（其余用不到，硬凑满 OrderRecord 会让夹具掩盖真实依赖） */
function row(p: Partial<OrderRecord> & { id: number }): OrderRecord {
  return {
    color: '',
    styleColor: '',
    shop: '',
    itemId: '',
    orderNo: `NO${p.id}`,
    styleCode: '',
    ...p,
  } as unknown as OrderRecord;
}

describe('productKeyOf：分组键', () => {
  it('店铺 + 商品ID 组成同一个键（同一家店同一个商品 ⇒ 同键）', () => {
    const a = productKeyOf(row({ id: 1, shop: '甲店', itemId: 'I-1' }));
    const b = productKeyOf(row({ id: 2, shop: '甲店', itemId: 'I-1' }));
    expect(a).toBe(b);
    expect(a).not.toBe('');
  });

  // ⚠️ 这三条必须**成对**看：只断言"同店同商品相等"的话，一个恒返回常量 '' 的实现也能过。
  it('不同店 / 不同商品ID 是不同的键', () => {
    const base = productKeyOf(row({ id: 1, shop: '甲店', itemId: 'I-1' }));
    expect(productKeyOf(row({ id: 2, shop: '乙店', itemId: 'I-1' }))).not.toBe(base);
    expect(productKeyOf(row({ id: 3, shop: '甲店', itemId: 'I-2' }))).not.toBe(base);
  });

  it('没有商品ID ⇒ 空串（"没有商品ID"与"单独一个商品"必须能被区分开）', () => {
    expect(productKeyOf(row({ id: 1, shop: '甲店', itemId: '' }))).toBe('');
    expect(productKeyOf(row({ id: 1, shop: '甲店', itemId: '   ' }))).toBe('');
  });
});

describe('groupByProduct：按商品分组', () => {
  it('同一商品的 3 行归到一组，组内保持列表顺序（表格是从上往下看的）', () => {
    const rows = [
      row({ id: 1, shop: '甲店', itemId: 'I-1' }),
      row({ id: 2, shop: '乙店', itemId: 'I-9' }),
      row({ id: 3, shop: '甲店', itemId: 'I-1' }),
    ];
    const gs = groupByProduct(rows, () => '');
    expect(gs.length).toBe(2);
    expect(gs[0].rows.map((r) => r.id)).toEqual([1, 3]);
    expect(gs[1].rows.map((r) => r.id)).toEqual([2]);
  });

  it('组顺序 = 首次出现的顺序（不是按 key 字典序，否则用户勾的第 3 行会跑到第一组）', () => {
    const gs = groupByProduct(
      [
        row({ id: 1, shop: 'Z店', itemId: 'I-1' }),
        row({ id: 2, shop: 'A店', itemId: 'I-2' }),
      ],
      () => ''
    );
    expect(gs.map((g) => g.shop)).toEqual(['Z店', 'A店']);
  });

  it('没有商品ID 的行**各自成组**（合在一起就等于把两件不相关的商品按同一个款落库）', () => {
    const gs = groupByProduct(
      [
        row({ id: 1, shop: '甲店', itemId: '' }),
        row({ id: 2, shop: '甲店', itemId: '' }),
      ],
      () => 'S1'
    );
    expect(gs.length).toBe(2);
    expect(gs.every((g) => g.rows.length === 1)).toBe(true);
    // key 必须互不相同，否则弹层里两张卡片抢同一个 picks 槽位
    expect(new Set(gs.map((g) => g.key)).size).toBe(2);
  });

  it('组内款一致 ⇒ 带上这个款（"不用改的组"天然是已选状态，用户只需要处理真正要改的组）', () => {
    const gs = groupByProduct(
      [
        row({ id: 1, shop: '甲店', itemId: 'I-1' }),
        row({ id: 2, shop: '甲店', itemId: 'I-1' }),
      ],
      () => 'S1'
    );
    expect(gs[0].styleCode).toBe('S1');
  });

  it('组内款不一致 ⇒ 空串（空串 ≠ "没款"，它是"这组还没统一" —— 不能当成已选状态）', () => {
    const byId: Record<number, string> = { 1: 'S1', 2: 'S2' };
    const gs = groupByProduct(
      [
        row({ id: 1, shop: '甲店', itemId: 'I-1' }),
        row({ id: 2, shop: '甲店', itemId: 'I-1' }),
      ],
      (o) => byId[Number(o.id)]
    );
    expect(gs[0].styleCode).toBe('');
  });

  it('空输入 ⇒ 空数组（不抛错：勾选被清空时弹层仍可能重算一次）', () => {
    expect(groupByProduct([], () => '')).toEqual([]);
  });

  it('BulkGroupView 只是多了 images，不改变分组（防止有人把它当成另一套分组逻辑）', () => {
    const gs = groupByProduct([row({ id: 1, shop: '甲店', itemId: 'I-1' })], () => 'S1');
    const view: BulkGroupView = { ...gs[0], images: ['a'] };
    expect(view.rows.length).toBe(1);
    expect(view.key).toBe(gs[0].key);
  });
});

describe('pickColorFor：批量时替人把颜色对上（对不上就不动它）', () => {
  // ⭐ 这一组断言必须**成对**：只写"记住色在色卡里就用它"的话，一个永远返回 `palette[0]`
  //    （或永远返回 ''）的实现都能过。四支两两配对，才叫"优先级真的按顺序生效"。
  it('① 图片记住的颜色在色卡里 ⇒ 用它（这是"以图为准"的结论，优先于订单列）', () => {
    const o = row({ id: 1, color: '白', styleColor: '黑' });
    expect(pickColorFor(o, ['黑', '白'])).toBe('黑');
  });

  it('② 记住的颜色不在色卡里、订单自己的颜色在 ⇒ 用订单的颜色', () => {
    const o = row({ id: 1, color: '白', styleColor: '青' });
    expect(pickColorFor(o, ['黑', '白'])).toBe('白');
  });

  it('③ 两个都不在色卡里、但这个款只有一个颜色 ⇒ 用它（只有一个候选时不存在选择歧义）', () => {
    const o = row({ id: 1, color: '青', styleColor: '紫' });
    expect(pickColorFor(o, ['黑'])).toBe('黑');
  });

  it('④ 两个都不在色卡里、色卡有多个颜色 ⇒ **空串**（不猜，让这行留着等他自己选）', () => {
    const o = row({ id: 1, color: '青', styleColor: '紫' });
    expect(pickColorFor(o, ['黑', '白'])).toBe('');
  });

  it('该款还没录颜色（色卡为空）⇒ 用订单原色，保持与行内自由输入同一口径', () => {
    const o = row({ id: 1, color: '青', styleColor: '' });
    expect(pickColorFor(o, [])).toBe('青');
    // 订单色也空时，退到"图片记住的颜色"；两者都空才是空 —— 空的那行会被留在列表里
    expect(pickColorFor(row({ id: 2, color: '', styleColor: '紫' }), [])).toBe('紫');
    expect(pickColorFor(row({ id: 3, color: '', styleColor: '' }), [])).toBe('');
  });

  it('色卡里只有空串之类的脏数据时不会被当成合法颜色', () => {
    // 色卡是主数据，理论上不该有空串；真出现时宁可不猜（返回空让用户处理）
    const o = row({ id: 1, color: '青', styleColor: '' });
    expect(pickColorFor(o, [''])).toBe('');
  });
});

describe('colorOptionsOf：批量定色的覆盖账（点之前就要知道会改几行）', () => {
  /** 只造这个规则读得到的字段 */
  function cRow(p: Partial<BulkColorRow> & { id: number }): BulkColorRow {
    return { orderNo: `NO${p.id}`, styleCode: '', color: '', palette: [], ...p };
  }

  it('候选色 = 各款色卡的**并集**，顺序按首次出现（不是字典序，也不是排行榜）', () => {
    const opts = colorOptionsOf([
      cRow({ id: 1, styleCode: 'S1', palette: ['黑', '白'] }),
      cRow({ id: 2, styleCode: 'S2', palette: ['蓝', '黑'] }),
    ]);
    expect(opts.map((o) => o.name)).toEqual(['黑', '白', '蓝']);
  });

  it('`change` 与 `same` 分开算：已是这个色的行不该被重复写一遍', () => {
    const opts = colorOptionsOf([
      cRow({ id: 1, styleCode: 'S1', color: '黑', palette: ['黑', '白'] }),
      cRow({ id: 2, styleCode: 'S1', color: '白', palette: ['黑', '白'] }),
    ]);
    const black = opts.find((o) => o.name === '黑')!;
    expect(black.change).toBe(1);
    expect(black.same).toBe(1);
    expect(black.miss).toBe(0);
  });

  it('色卡里没有这个色 / 还没点名款 ⇒ 都算"不适用"，但 `noStyle` 单独数出来', () => {
    // 这三行分别代表：能改、色卡没有、连款都没有。混在一起就会把"先去定款"说成"去加色"。
    const opts = colorOptionsOf([
      cRow({ id: 1, orderNo: 'A1', styleCode: 'S1', palette: ['黑'] }),
      cRow({ id: 2, orderNo: 'A2', styleCode: 'S9', palette: [] }),
      cRow({ id: 3, orderNo: 'A3', styleCode: '', palette: [] }),
    ]);
    const black = opts.find((o) => o.name === '黑')!;
    expect(black.change).toBe(1);
    expect(black.miss).toBe(2);
    expect(black.noStyle).toBe(1);
    expect(black.missNos).toEqual(['A2', 'A3']);
  });

  it('全都已经是这个色 ⇒ 仍然列出来，但 change = 0（弹层据此把它做成点不动）', () => {
    const opts = colorOptionsOf([
      cRow({ id: 1, styleCode: 'S1', color: '黑', palette: ['黑'] }),
      cRow({ id: 2, styleCode: 'S1', color: '黑', palette: ['黑'] }),
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0].change).toBe(0);
    expect(opts[0].same).toBe(2);
  });

  it('空输入 / 款色卡都为空 ⇒ 空数组（弹层显示"先定款"，不抛错）', () => {
    expect(colorOptionsOf([])).toEqual([]);
    expect(colorOptionsOf([cRow({ id: 1, styleCode: 'S9' })])).toEqual([]);
  });
});
