import { describe, expect, it } from 'vitest';
import {
  buildSkuCodes,
  DEFAULT_SKU_CODE_RULE,
  renderSkuCode,
  SKU_CODE_MAX,
  type SkuCodeSeed,
} from '../src/lib/skuCode';

const seed = (over: Partial<SkuCodeSeed> = {}): SkuCodeSeed => ({
  key: '1',
  styleCode: 'SUST-001',
  color: '黑色',
  size: 'L',
  index: 1,
  ...over,
});

describe('skuCode', () => {
  it('规则里的四个占位符都替换；序号补两位', () => {
    expect(renderSkuCode('{code}-{color}-{size}', seed())).toBe('SUST-001-黑色-L');
    expect(renderSkuCode('{code}_{index}', seed({ index: 7 }))).toBe('SUST-001_07');
  });

  it('规则为空 ⇒ 用默认规则（不生成空编码：空编码等于没设置）', () => {
    expect(renderSkuCode('', seed())).toBe(renderSkuCode(DEFAULT_SKU_CODE_RULE, seed()));
    expect(renderSkuCode('   ', seed())).toBe('SUST-001-黑色-L');
  });

  it('字段为空 ⇒ 压掉多余分隔符，不留尾随连字符', () => {
    expect(renderSkuCode('{code}-{color}-{size}', seed({ size: '' }))).toBe('SUST-001-黑色');
    expect(renderSkuCode('{code}--{color}', seed())).toBe('SUST-001-黑色');
  });

  it('不认识的占位符**原样保留**（悄悄吃掉会变成"看着对、其实少一截"的编码）', () => {
    expect(renderSkuCode('{code}-{style}', seed())).toBe('SUST-001-{style}');
  });

  it('批内重名 ⇒ 后来者加 -2（编码非空时全库唯一，重复会整批保存失败）', () => {
    const { drafts } = buildSkuCodes(DEFAULT_SKU_CODE_RULE, [
      seed({ key: 'a' }),
      seed({ key: 'b', size: 'L ' }), // 只差一个空格：trim 后同名
      seed({ key: 'c', size: 'XL' }),
    ]);
    expect(drafts.map((d) => d.code)).toEqual(['SUST-001-黑色-L', 'SUST-001-黑色-L-2', 'SUST-001-黑色-XL']);
    // 反向对照：三条都在，没有把重名的悄悄丢掉
    expect(drafts.length).toBe(3);
  });

  it('超长的跳过并计数（不截断：截断会把两条不同 SKU 截成同一个编码）', () => {
    const long = 'X'.repeat(SKU_CODE_MAX);
    const { drafts, tooLong } = buildSkuCodes('{code}{color}', [
      seed({ key: 'ok', styleCode: 'A', color: '黑' }),
      seed({ key: 'bad', styleCode: long, color: '黑' }),
    ]);
    expect(drafts).toEqual([{ key: 'ok', code: 'A黑' }]);
    expect(tooLong).toBe(1);
  });

  it('规则里一个种子字段都没用 ⇒ 全空 ⇒ 不生成（避免把 40 条都写成同一个常量）', () => {
    const { drafts } = buildSkuCodes('固定前缀', [seed({ key: 'a' })]);
    expect(drafts).toEqual([]);
  });
});
