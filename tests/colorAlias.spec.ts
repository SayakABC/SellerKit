// 「平台色名 → 我的色名」纯函数契约（`electron/colorAlias.ts`）。
//
// 钉住三条：① 键的归一（大小写/空白/全角）；② **按产品隔离**（同平台色名在不同款上互不影响）；
// ③ 未命中**原样返回**（不许把没配过的色丢成空/未分类 —— 那会把"没配置"伪装成"没颜色"）。
import { describe, expect, it } from 'vitest';
import { colorAliasKey, pickColorAlias, translateColor, type ColorAliasRow } from '../electron/colorAlias';

const rows: ColorAliasRow[] = [
  { product_id: 1, alias_key: colorAliasKey('Khaki'), color: '卡其' },
  { product_id: 2, alias_key: colorAliasKey('Khaki'), color: '驼色' },
  { product_id: 1, alias_key: colorAliasKey('1'), color: '黑色' },
];

describe('colorAliasKey：键归一', () => {
  it('大小写与首尾/内部空白折叠（`Khaki` / ` khaki ` 同键）', () => {
    expect(colorAliasKey('Khaki')).toBe('khaki');
    expect(colorAliasKey(' khaki ')).toBe('khaki');
    expect(colorAliasKey('Photo  color')).toBe(colorAliasKey('photo color'));
  });

  it('全角转半角（`Ｋｈａｋｉ` 与 `Khaki` 同键）', () => {
    expect(colorAliasKey('Ｋｈａｋｉ')).toBe(colorAliasKey('Khaki'));
    expect(colorAliasKey('１')).toBe(colorAliasKey('1'));
  });

  it('中文/数字原样成键，不做"像不像颜色"的判断', () => {
    expect(colorAliasKey('卡其')).toBe('卡其');
    expect(colorAliasKey('70B')).toBe('70b');
    expect(colorAliasKey('　卡其　')).toBe('卡其'); // 全角空格经 trim 后的形态
  });

  it('非字符串 → 空串（不抛）', () => {
    expect(colorAliasKey(null)).toBe('');
    expect(colorAliasKey(undefined)).toBe('');
    expect(colorAliasKey(123 as unknown)).toBe('');
  });
});

describe('pickColorAlias：按产品命中', () => {
  it('同一平台色名在不同产品上给出不同自家色名（产品级隔离，不是平台级共享）', () => {
    expect(pickColorAlias(rows, 1, 'Khaki')).toBe('卡其');
    expect(pickColorAlias(rows, 2, 'Khaki')).toBe('驼色');
  });

  it('查别的产品配过的对照 → 不命中（`1 → 黑色` 只在产品 1 上成立）', () => {
    expect(pickColorAlias(rows, 2, '1')).toBe('');
  });

  it('大小写/全角差异仍能命中', () => {
    expect(pickColorAlias(rows, 1, 'KHAKI')).toBe('卡其');
    expect(pickColorAlias(rows, 1, 'Ｋｈａｋｉ')).toBe('卡其');
  });

  it('空产品 id / 空色名 / 空字典 → 不命中（不抛）', () => {
    expect(pickColorAlias(rows, 0, 'Khaki')).toBe('');
    expect(pickColorAlias(rows, 1, '  ')).toBe('');
    expect(pickColorAlias([], 1, 'Khaki')).toBe('');
    expect(pickColorAlias(null, 1, 'Khaki')).toBe('');
  });
});

describe('translateColor：未命中原样返回', () => {
  it('配过的 → 自家色名', () => {
    expect(translateColor(rows, 1, 'Khaki')).toBe('卡其');
  });

  it('没配过的 → **原文**（不是空串、不是未分类）', () => {
    expect(translateColor(rows, 1, 'Photo color')).toBe('Photo color');
    expect(translateColor(rows, 9, 'Khaki')).toBe('Khaki');
  });

  it('自家色名原样穿过（不会因为字典里恰好有同名键而变形）', () => {
    expect(translateColor(rows, 1, '黑色')).toBe('黑色');
  });

  it('空进空出（调用方据此落兜底色，而不是落一个空色名）', () => {
    expect(translateColor(rows, 1, '')).toBe('');
    expect(translateColor(rows, 1, null)).toBe('');
    expect(translateColor(rows, 1, '   ')).toBe('');
  });
});
