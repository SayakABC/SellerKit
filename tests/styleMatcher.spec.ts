// styleMatcher 单测 —— 指纹决定"同款是否会被拆成多个款编码"，
// 归一化不够就会导致 AI 命名漂移（同款两次识别）时重复建款，属数据层污染。
import { describe, it, expect } from 'vitest';
import { normalizeText, buildStyleFingerprint, buildStyleDisplayName } from '../src/lib/styleMatcher';

describe('normalizeText', () => {
  it('转小写并去掉标点与多余空白', () => {
    expect(normalizeText('  Hello,  World!!  ')).toBe('hello world');
  });

  it('全角字母数字与全角标点被转半角', () => {
    expect(normalizeText('ＡＢＣ１２３')).toBe('abc123');
    expect(normalizeText('圆领（纯棉）')).toBe('圆领 纯棉');
  });

  it('全角空格视为普通空格', () => {
    expect(normalizeText('短袖\u3000条纹')).toBe('短袖 条纹');
  });

  it('中文与数字保留、非字母数字变空格', () => {
    expect(normalizeText('短袖T恤-圆领/条纹')).toBe('短袖t恤 圆领 条纹');
  });

  it('空值/undefined 安全返回空串', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText(undefined as unknown as string)).toBe('');
  });
});

describe('buildStyleFingerprint', () => {
  it('特征顺序不同 → 指纹一致（避免同款拆成多个款编码）', () => {
    const a = buildStyleFingerprint('短袖T恤', ['圆领', '条纹']);
    const b = buildStyleFingerprint('短袖T恤', ['条纹', '圆领']);
    expect(a).toBe(b);
    expect(a).toBe('短袖t恤|圆领|条纹');
  });

  it('重复特征被去重', () => {
    expect(buildStyleFingerprint('短袖T恤', ['圆领', '圆领', ' 圆领 '])).toBe('短袖t恤|圆领');
  });

  it('空特征被剔除，只留品类', () => {
    expect(buildStyleFingerprint('卫衣', ['', '   '])).toBe('卫衣');
  });

  it('品类与特征全空 → 空串（调用方应据此跳过建款）', () => {
    expect(buildStyleFingerprint('', [])).toBe('');
    expect(buildStyleFingerprint('  ', [' '])).toBe('');
  });

  it('大小写/全角差异不影响指纹', () => {
    expect(buildStyleFingerprint('T恤', ['V领'])).toBe(buildStyleFingerprint('ｔ恤', ['v领']));
  });
});

describe('buildStyleDisplayName', () => {
  it('品类 + 特征用空格拼接', () => {
    expect(buildStyleDisplayName('短袖T恤', ['圆领', '条纹'])).toBe('短袖T恤 圆领 条纹');
  });

  it('保留 AI 原始大小写（仅展示用，不参与匹配）', () => {
    expect(buildStyleDisplayName('T恤', ['V领'])).toBe('T恤 V领');
  });

  it('无特征时只返回品类；全空时返回占位名', () => {
    expect(buildStyleDisplayName('卫衣', [])).toBe('卫衣');
    expect(buildStyleDisplayName('', [])).toBe('未命名款式');
    expect(buildStyleDisplayName('', ['  '])).toBe('未命名款式');
  });
});
