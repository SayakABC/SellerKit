// tests/podRekey.spec.ts
// 塌陷链接的定向重算（`planCollapsedRekey`）—— 纯函数，vitest 直接覆盖。
//
// 最重要的一条是「**非塌陷链接一个字节都不改**」：重算范围稍一放宽，存量键会整体漂移，
// 而键是跨表连接的身份（绑定台账 / 采购映射 / 归类），漂一次要全库对账。
import { describe, it, expect } from 'vitest';
import { collapsedLinkPrefixes, linkPrefixOf, planCollapsedRekey } from '../electron/podRekey';
import { variantKeyOf, splitVariantKey } from '../electron/variantKey';

const SEP = '\u0000';
const IMG = (id: string) => `https://ae01.alicdn.com/kf/${id}.jpg`;
const key3 = (shop: string, item: string, color: string) => variantKeyOf({ shopKey: shop, itemKey: item, colorKey: color });
const row = (id: number, variantKey: string, imageUrl: string, linkCollapsed = true) => ({
  orderItemId: id,
  variantKey,
  imageUrl,
  linkCollapsed,
});

describe('planCollapsedRekey — 该动的才动', () => {
  it('塌陷链接 + 3 段键 + 认得出图键 → 一条 4 段 update', () => {
    const from = key3('九店', '100', 'Picture color');
    const plan = planCollapsedRekey([row(1, from, IMG('Sabc123'))]);
    expect(plan.updates).toHaveLength(1);
    const [u] = plan.updates;
    expect(u.orderItemId).toBe(1);
    expect(u.fromKey).toBe(from);
    expect(u.imageKey).toBe('Sabc123');
    expect(u.toKey).toBe(from + SEP + 'Sabc123');
    // 新键必须能被 splitVariantKey 拆回 4 段（否则绑定台账与订单行对不上）
    const parts = splitVariantKey(u.toKey);
    expect(parts.itemKey).toBe('100');
    expect(parts.imageKey).toBe('Sabc123');
  });

  it('非塌陷链接：一条都不改（哪怕有图也不加第 4 段）', () => {
    const plan = planCollapsedRekey([row(2, key3('九店', '200', 'Red'), IMG('Sxyz'), false)]);
    expect(plan.updates).toEqual([]);
    expect(plan.notCollapsed).toBe(1);
  });

  it('已经是 4 段键：原样不动（重跑脚本必须幂等）', () => {
    const four = key3('九店', '300', 'Red') + SEP + 'Sq1';
    const plan = planCollapsedRekey([row(3, four, IMG('Sq1'))]);
    expect(plan.updates).toEqual([]);
    expect(plan.alreadyFour).toBe(1);
  });

  it('图键认不出（非 /kf/ 或空图）：计"无法拆分"，不写半截键', () => {
    const plan = planCollapsedRekey([
      row(4, key3('九店', '400', 'Picture color'), ''),
      row(5, key3('九店', '500', 'Picture color'), 'https://ae01.alicdn.com/images/x.jpg'),
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.cannotSplit).toBe(2);
  });

  it('脏键（空 / 2 段 / 5 段）：计 dirty，绝不猜一个解释', () => {
    const plan = planCollapsedRekey([
      row(6, '', IMG('Sbad')),
      row(7, `a${SEP}b`, IMG('Sbad')),
      row(8, ['a', 'b', 'c', 'd', 'e'].join(SEP), IMG('Sbad')),
    ]);
    expect(plan.dirty).toBe(3);
    expect(plan.updates).toEqual([]);
  });

  it('一次多行：分类计数与 updates 互不串台', () => {
    const plan = planCollapsedRekey([
      row(10, key3('九店', '1', 'Picture color'), IMG('S1')),
      row(11, key3('九店', '2', 'Red'), IMG('S2'), false),
      row(12, key3('九店', '3', 'Red') + SEP + 'S3', IMG('S3')),
      row(13, key3('九店', '4', 'Picture color'), ''),
    ]);
    expect(plan.updates.map((u) => u.orderItemId)).toEqual([10]);
    expect(plan.notCollapsed).toBe(1);
    expect(plan.alreadyFour).toBe(1);
    expect(plan.cannotSplit).toBe(1);
    expect(plan.dirty).toBe(0);
  });

  it('空输入 / 非数组不抛错', () => {
    for (const v of [[], null, undefined, 'x']) {
      expect(planCollapsedRekey(v as any)).toEqual({
        updates: [],
        alreadyFour: 0,
        notCollapsed: 0,
        cannotSplit: 0,
        dirty: 0,
      });
    }
  });
});

describe('collapsedLinkPrefixes / linkPrefixOf', () => {
  it('只有 imgsInName > 1 的槽位进集合（= 同色名多图）', () => {
    const set = collapsedLinkPrefixes([
      { variantKey: key3('九店', '100', 'Picture color') + SEP + 'Sa', imgsInName: 2 },
      { variantKey: key3('九店', '200', 'Red'), imgsInName: 1 },
    ]);
    expect([...set]).toEqual([key3('九店', '100', 'Picture color')]);
  });

  it('前缀只取前 3 段：3 段与 4 段键指向同一个链接', () => {
    const three = key3('九店', '100', 'Picture color');
    expect(linkPrefixOf(three + SEP + 'Sa')).toBe(three);
    expect(linkPrefixOf(three)).toBe(three);
  });

  it('脏键的前缀是空串（不会被误当成一个链接去重算）', () => {
    expect(linkPrefixOf('')).toBe('');
    expect(linkPrefixOf(`a${SEP}b`)).toBe('');
  });
});
