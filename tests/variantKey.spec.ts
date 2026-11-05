import { describe, expect, it } from 'vitest';
import {
  provisionalStyleCode,
  splitVariantKey,
  variantColorKey,
  variantKeyOf,
} from '../electron/variantKey';

/**
 * 变体键的守卫。
 *
 * 每一条都刻意用**应当给出不同结果**的输入对（`铁律 3`：两个都期望 2 的夹具恒绿）——
 * 例如"同店同色"与"跨店同色"必须一个相等、一个不等，只写相等那半边，把店铺段删掉也是绿的。
 */
describe('variantKeyOf', () => {
  const base = { shopKey: '十店', itemKey: '1005012406132867', colorKey: '5' };

  it('同一组输入稳定（幂等）', () => {
    expect(variantKeyOf(base)).toBe(variantKeyOf({ ...base }));
  });

  it('店铺在键里：同商品同色、换店铺 ⇒ **不同**键', () => {
    // 真库取证：37 个商品ID 无一跨店，所以这一条今天不改任何分组；
    // 但少了它，键就与本仓已裁定的映射身份 `(店铺, 商品ID)` 成了两套口径。
    expect(variantKeyOf(base)).not.toBe(variantKeyOf({ ...base, shopKey: '十一店' }));
  });

  it('颜色在键里：同商品换色 ⇒ **不同**键', () => {
    expect(variantKeyOf(base)).not.toBe(variantKeyOf({ ...base, colorKey: '6' }));
  });

  it('报表没给色也成键，且与"有色"是两回事', () => {
    const noColor = variantKeyOf({ ...base, colorKey: '' });
    expect(noColor).toContain(base.itemKey);
    expect(noColor).not.toBe(variantKeyOf(base));
    // 空店铺同理：仍成键（那种行本来就没有店铺可分，不该被吞掉）
    expect(variantKeyOf({ ...base, shopKey: '' })).not.toBe('');
  });

  it('没有商品ID ⇒ 不成键（唯一不可缺的一段）', () => {
    expect(variantKeyOf({ ...base, itemKey: '' })).toBe('');
    expect(variantKeyOf({ ...base, itemKey: '   ' })).toBe('');
    expect(variantKeyOf({ ...base, itemKey: '\u200b' })).toBe(''); // 纯零宽 = 空
  });

  it('空白 / 全角空格 / 零宽字符被折叠（Excel 带脏字符不算换了一件货）', () => {
    expect(variantKeyOf({ ...base, itemKey: ' 1005012406132867 ' })).toBe(variantKeyOf(base));
    expect(variantKeyOf({ ...base, itemKey: '1005012406132867\u200b' })).toBe(variantKeyOf(base));
    expect(variantKeyOf({ ...base, colorKey: '5 ' })).toBe(variantKeyOf(base));
    // 全角空格折叠成**半角空格**（`toNameKey` 的口径），不是删掉 —— 所以 `十\u3000店` 与 `十 店` 同键、
    // 与 `十店` 不同键。空格算不算店名的一部分由店铺归一那层判，键这层不做模糊匹配。
    expect(variantKeyOf({ ...base, shopKey: '十\u3000店' })).toBe(
      variantKeyOf({ ...base, shopKey: '十 店' }),
    );
    expect(variantKeyOf({ ...base, shopKey: '十 店' })).not.toBe(variantKeyOf(base));
  });

  it('大小写**不**折叠：平台 ID 是精确标识，猜错就是把两件货的账并到一起', () => {
    expect(variantKeyOf({ ...base, itemKey: 'abc123' })).not.toBe(
      variantKeyOf({ ...base, itemKey: 'ABC123' }),
    );
  });

  it('段内的分隔符被剥掉，构造不出"两段并一段"的键', () => {
    // 不剥的话：shop='a' + item='b\0c' 与 shop='a\0b' + item='c' 会拼出同一个字符串
    const forged = variantKeyOf({ shopKey: 'a', itemKey: 'b\u0000c', colorKey: 'd' });
    const legit = variantKeyOf({ shopKey: 'a\u0000b', itemKey: 'c', colorKey: 'd' });
    expect(forged).not.toBe(legit);
    expect(splitVariantKey(forged)).toEqual({
      shopKey: 'a',
      itemKey: 'bc',
      colorKey: 'd',
      imageKey: '',
    });
  });

  // ── T0-6：色名塌陷链接的第 4 段（图键）────────────────────────────────────
  it('不给图键 ⇒ 与改造前**逐字节相同**的 3 段键（存量 75 行的键一个字都不许变）', () => {
    const noImg = variantKeyOf(base);
    expect(noImg.split('\u0000').length).toBe(3);
    // 显式传空串、传 undefined、不传该键，三者必须同键（否则同一个槽位会出现两种写法）
    expect(variantKeyOf({ ...base, imageKey: '' })).toBe(noImg);
    expect(variantKeyOf({ ...base, imageKey: '   ' })).toBe(noImg);
    expect(variantKeyOf({ ...base, imageKey: undefined })).toBe(noImg);
    // 尾巴不许留多余分隔符（`a\0b\0` 与 `a\0b` 会被当成两个槽位）
    expect(noImg.endsWith('\u0000')).toBe(false);
  });

  it('给了图键 ⇒ 4 段，且同色不同图**不同键**（塌陷链接才能分开）', () => {
    const k1 = variantKeyOf({ ...base, imageKey: 'S111' });
    const k2 = variantKeyOf({ ...base, imageKey: 'S222' });
    expect(k1.split('\u0000').length).toBe(4);
    expect(k1).not.toBe(k2); // 这是整条链要解决的事：`Picture color` 全都同名，只能靠图分开
    expect(k1).not.toBe(variantKeyOf(base)); // 加了图键就不是原来那个键（不会被旧绑定吞掉）
  });

  it('4 段键能拆回四段；2 段/5 段视为脏键（不猜一个解释）', () => {
    const key = variantKeyOf({ ...base, imageKey: 'S111' });
    expect(splitVariantKey(key)).toEqual({
      shopKey: '十店',
      itemKey: '1005012406132867',
      colorKey: '5',
      imageKey: 'S111',
    });
    for (const bad of ['a\u0000b', 'a\u0000b\u0000c\u0000d\u0000e']) {
      expect(splitVariantKey(bad)).toEqual({
        shopKey: '',
        itemKey: '',
        colorKey: '',
        imageKey: '',
      });
    }
  });
});

describe('splitVariantKey', () => {
  it('往返：拼出来再拆开，三段与输入归一后的值一致', () => {
    const key = variantKeyOf({ shopKey: ' 十店 ', itemKey: '1005', colorKey: ' 5 ' });
    expect(splitVariantKey(key)).toEqual({
      shopKey: '十店',
      itemKey: '1005',
      colorKey: '5',
      imageKey: '',
    });
  });

  it('脏键不抛错（查询路径不该因库里的坏值崩），返回全空串', () => {
    const empty = { shopKey: '', itemKey: '', colorKey: '', imageKey: '' };
    expect(splitVariantKey('')).toEqual(empty);
    expect(splitVariantKey('a\u0000b')).toEqual(empty);
    expect(splitVariantKey(null)).toEqual(empty);
  });
});

describe('variantColorKey', () => {
  it('只做去空白：不映射标准色、不折大小写、不判"像不像颜色"', () => {
    expect(variantColorKey('  5 ')).toBe('5');
    expect(variantColorKey('Picture color4')).toBe('Picture color4');
    expect(variantColorKey('picture color4')).not.toBe(variantColorKey('Picture color4'));
    // 裸数字是**正当**的平台色名，不能被"看着不像颜色"过滤掉
    expect(variantColorKey('1')).toBe('1');
    expect(variantColorKey('')).toBe('');
  });
});

describe('provisionalStyleCode', () => {
  it('由商品ID 推出且幂等：同一 listing 反复导入拿到同一个款编码', () => {
    expect(provisionalStyleCode('1005012406132867')).toBe('AE-1005012406132867');
    expect(provisionalStyleCode(' 1005012406132867 ')).toBe(provisionalStyleCode('1005012406132867'));
  });

  it('不同 listing ⇒ 不同款编码（否则两个款并成一个）', () => {
    expect(provisionalStyleCode('1005012406132867')).not.toBe(
      provisionalStyleCode('1005013235945478'),
    );
  });

  it('空商品ID ⇒ 空编码（调用方据此放弃建款，不拿空串当编码写入）', () => {
    expect(provisionalStyleCode('')).toBe('');
    expect(provisionalStyleCode(undefined)).toBe('');
  });

  it('非法字符逐个转义，**不同商品ID 不会折成同一编码**（撞了就是两件货并进一个款）', () => {
    expect(provisionalStyleCode('ab/cd')).toBe('AE-ab-2fcd');
    expect(provisionalStyleCode('ab_cd')).toBe('AE-ab-5fcd');
    expect(provisionalStyleCode('ab/cd')).not.toBe(provisionalStyleCode('ab_cd'));
    // `-` 自身也被转义 ⇒ 转义串不会与真实字符混淆
    expect(provisionalStyleCode('a-b')).toBe('AE-a-2db');
  });
});
