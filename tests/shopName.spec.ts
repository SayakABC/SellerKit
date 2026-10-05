// 店铺名归一的纯函数层单测（electron/shopName.ts）。
//
// 为什么这个文件能被 vitest 跑而 `electron/shop-db.ts` 不能：本模块**零依赖**（不 require
// better-sqlite3），而 `electron/db.ts` 会按 Electron ABI 加载原生模块，系统 Node 下直接抛
// NODE_MODULE_VERSION 149 vs 127。故"怎么算同一个名字"这条唯一有正确性风险的逻辑放这里被测，
// DB 层只留 SQL，由 `npm run shop:smoke` 覆盖。
//
// 断言的立足点：**不合并是安全的、错合并是不可逆的**（DOMAIN_INTEGRATION_PLAN G6 / ADR-002 Q3）。
// 所以每条"应等价"都配一条"不得等价"的反向断言 —— 防止哪天把口径改宽（加模糊匹配/折叠大小写）
// 而所有用例照样全绿。

import { describe, expect, it } from 'vitest';
import { mergeNameGroups, toNameKey } from '../electron/shopName';

describe('toNameKey：归一只做「去空白 + 剥不可见字符」', () => {
  it('去首尾空白', () => {
    expect(toNameKey('  店A  ')).toBe('店A');
    expect(toNameKey('\t店A\n')).toBe('店A');
  });

  it('全角空格与连续空白合并成单个半角空格', () => {
    expect(toNameKey('店　A')).toBe('店 A');
    expect(toNameKey('店   A')).toBe('店 A');
    expect(toNameKey('店\u3000\u3000A')).toBe('店 A');
  });

  it('剥掉零宽字符 / BOM（Excel 与复制粘贴的常客）', () => {
    expect(toNameKey('店\u200bA')).toBe('店A');
    expect(toNameKey('\ufeff店A')).toBe('店A');
    expect(toNameKey('店A\u200e')).toBe('店A');
  });

  it('空 / 纯空白 / 非字符串 → 空键', () => {
    expect(toNameKey('')).toBe('');
    expect(toNameKey('   ')).toBe('');
    expect(toNameKey('\u3000\u200b')).toBe('');
    expect(toNameKey(null)).toBe('');
    expect(toNameKey(undefined)).toBe('');
    expect(toNameKey(12)).toBe('');
  });

  it('一组肉眼一样的写法必须归成同一个键（否则一家店被静默拆成多家）', () => {
    const key = toNameKey('深圳优选店');
    for (const v of ['深圳优选店', ' 深圳优选店', '深圳优选店 ', '深圳优选店\u200b', '\ufeff深圳优选店']) {
      expect(toNameKey(v), `"${v}" 应与 "深圳优选店" 同键`).toBe(key);
    }
  });

  // ---- 反向控制：不得等价（守住"只做去空白"这条线）----
  it('不做大小写折叠（折叠会把 "ABC 店" 与 "abc 店" 错并成一家）', () => {
    expect(toNameKey('ABC店')).not.toBe(toNameKey('abc店'));
  });

  it('内部空格是有效差异：不做「去掉所有空白」的归一', () => {
    expect(toNameKey('深圳 优选店')).not.toBe(toNameKey('深圳优选店'));
  });

  it('不做模糊匹配：编辑距离 1 的名字不得同键', () => {
    expect(toNameKey('深圳优选店')).not.toBe(toNameKey('深圳优选店铺'));
    expect(toNameKey('Sunny Store')).not.toBe(toNameKey('Sunny Storee'));
  });
});

describe('mergeNameGroups：多来源分组按归一键合并', () => {
  const g = (source: string, raw: string, count: number) => ({ source, raw, count });

  it('空 / 纯空白原文被跳过（否则「合计」这类噪音会淹没真问题）', () => {
    expect(mergeNameGroups([g('order', '', 5), g('order', '   ', 3), g('ae', '\u3000', 1)])).toEqual(
      [],
    );
  });

  it('跨来源累加条数、来源去重且保序', () => {
    const out = mergeNameGroups([
      g('order', '店A', 3),
      g('purchase', '店A', 2),
      g('ae', ' 店A ', 1),
      g('order', '店A', 4),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('店A');
    expect(out[0].occurrences).toBe(10);
    expect(out[0].sources).toEqual(['order', 'purchase', 'ae']);
  });

  it('展示原文取最短形态（并排 "店A " 与 "店A" 时取后者）', () => {
    expect(mergeNameGroups([g('order', '店A ', 1), g('ae', '店A', 1)])[0].raw).toBe('店A');
    expect(mergeNameGroups([g('order', '店A', 1), g('ae', '店A ', 1)])[0].raw).toBe('店A');
  });

  it('展示原文同长度时取字典序最小（结果不依赖输入顺序）', () => {
    const a = mergeNameGroups([g('order', '店A\u3000', 1), g('ae', '店A ', 1)])[0].raw;
    const b = mergeNameGroups([g('ae', '店A ', 1), g('order', '店A\u3000', 1)])[0].raw;
    expect(a).toBe(b);
    expect(a).toBe('店A ');
  });

  it('排序：出现次数降序 → 归一键升序（同次数时顺序可预期，不随插入顺序漂移）', () => {
    const out = mergeNameGroups([
      g('order', 'b店', 1),
      g('order', 'a店', 1),
      g('order', 'c店', 9),
    ]);
    expect(out.map((x) => x.key)).toEqual(['c店', 'a店', 'b店']);
  });

  it('排序对中文用 UTF-16 码位序（不是笔画序），换插入顺序结果不变', () => {
    // ⚠️ 别按笔画想当然：乙 U+4E59 < 丙 U+4E19 是"看起来反了"但正确的码位序。
    // 这条断言的价值不在顺序本身，而在"同输入集合换顺序 → 输出一致"。
    const a = mergeNameGroups([g('order', '甲店', 1), g('order', '乙店', 1), g('order', '丙店', 1)]);
    const b = mergeNameGroups([g('order', '丙店', 1), g('order', '甲店', 1), g('order', '乙店', 1)]);
    expect(b.map((x) => x.key)).toEqual(a.map((x) => x.key));
    expect(a.map((x) => x.key)).toEqual(['丙店', '乙店', '甲店']);
  });

  it('非法 count 兜底为 0，不产生 NaN', () => {
    const out = mergeNameGroups([
      { source: 'order', raw: '店A', count: Number.NaN },
      { source: 'order', raw: '店B', count: -3 },
    ] as never);
    expect(out.every((x) => Number.isInteger(x.occurrences))).toBe(true);
    expect(out.find((x) => x.key === '店A')?.occurrences).toBe(0);
    expect(out.find((x) => x.key === '店B')?.occurrences).toBe(0);
  });
});
