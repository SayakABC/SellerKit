// fieldProcessor 单测 —— 日期偏移 / 模板拼接 / 四则运算 / 自定义表达式四条规则链。
// 这些规则直接决定导出文案里的日期与价格，算错不会报错，只会让用户发出错误的货期。
import { describe, it, expect } from 'vitest';
import { applyFieldProcessor, computeRulesHash } from '../src/lib/fieldProcessor';
import type { ProcessingRule, RecordItem } from '../src/types';

function rule(partial: Partial<ProcessingRule> & Pick<ProcessingRule, 'type' | 'targetField'>): ProcessingRule {
  return {
    id: partial.id ?? partial.targetField,
    name: partial.name ?? partial.targetField,
    enabled: partial.enabled ?? true,
    order: partial.order ?? 0,
    config: partial.config ?? {},
    ...partial,
  } as ProcessingRule;
}

function records(...fieldsList: Record<string, string>[]): RecordItem[] {
  return fieldsList.map((fields, i) => ({ id: i + 1, fields, used: false, order: i + 1 }));
}

describe('computeRulesHash', () => {
  const base = rule({ type: 'template', targetField: 'out', config: { template: '{{a}}' } });

  it('同样配置产生同样哈希', () => {
    expect(computeRulesHash([base])).toBe(computeRulesHash([{ ...base }]));
  });

  it('启用状态 / 目标字段 / 类型 / 配置 / 顺序任一变化都会改变哈希', () => {
    expect(computeRulesHash([{ ...base, enabled: false }])).not.toBe(computeRulesHash([base]));
    expect(computeRulesHash([{ ...base, targetField: 'other' }])).not.toBe(computeRulesHash([base]));
    expect(computeRulesHash([{ ...base, type: 'math' }])).not.toBe(computeRulesHash([base]));
    expect(computeRulesHash([{ ...base, config: { template: '{{b}}' } }])).not.toBe(computeRulesHash([base]));
    expect(computeRulesHash([{ ...base, order: 9 }])).not.toBe(computeRulesHash([base]));
  });

  it('规则改名不影响哈希（哈希只表达"行为是否变化"）', () => {
    expect(computeRulesHash([{ ...base, name: '新名字' }])).toBe(computeRulesHash([base]));
  });
});

describe('applyFieldProcessor · 通用行为', () => {
  it('未启用的规则完全不参与，其目标字段也不计入 newHeaders', () => {
    const list = records({ a: '1' });
    const r = applyFieldProcessor(list, ['a'], [
      rule({ type: 'template', targetField: 'x', enabled: false, config: { template: 'X' } }),
    ]);
    expect(r.newHeaders).toEqual([]);
    expect(r.records[0].fields.x).toBeUndefined();
  });

  it('newHeaders 按规则顺序去重', () => {
    const r = applyFieldProcessor(
      records({ a: '1' }),
      ['a'],
      [
        rule({ type: 'template', targetField: 'x', order: 1, config: { template: '1' } }),
        rule({ type: 'template', targetField: 'y', order: 2, config: { template: '2' } }),
        rule({ type: 'template', targetField: 'x', order: 3, config: { template: '3' } }),
      ],
    );
    expect(r.newHeaders).toEqual(['x', 'y']);
  });

  it('order 决定执行顺序：后执行者覆盖同名字段', () => {
    const r = applyFieldProcessor(
      records({ a: '1' }),
      ['a'],
      [
        rule({ id: 'later', type: 'template', targetField: 't', order: 20, config: { template: '后' } }),
        rule({ id: 'earlier', type: 'template', targetField: 't', order: 10, config: { template: '先' } }),
      ],
    );
    expect(r.records[0].fields.t).toBe('后');
  });

  it('单条规则抛错不影响其他规则与其他记录', () => {
    const r = applyFieldProcessor(
      records({ a: '1' }, { a: '2' }),
      ['a'],
      [
        rule({ id: 'boom', type: 'math', targetField: 'bad', order: 1, config: { expression: '${notExist}+1' } }),
        rule({ id: 'ok', type: 'template', targetField: 'good', order: 2, config: { template: '{{a}}' } }),
      ],
    );
    expect(r.errors).toHaveLength(2); // 两条记录各报一次
    expect(r.errors.every((e) => e.ruleId === 'boom')).toBe(true);
    expect(r.records.map((x) => x.fields.good)).toEqual(['1', '2']);
  });
});

describe('applyFieldProcessor · dateOffset', () => {
  it('小时偏移：24 Hours 跨天', () => {
    const r = applyFieldProcessor(
      records({ 下单时间: '2024-08-24 10:30', 货期: '24 Hours' }),
      [],
      [
        rule({
          type: 'dateOffset',
          targetField: '发货时间',
          config: { sourceField: '下单时间', packageField: '货期', outputFormat: 'YYYY-MM-DD HH:mm' },
        }),
      ],
    );
    expect(r.records[0].fields['发货时间']).toBe('2024-08-25 10:30');
  });

  it('天/周偏移 + 默认输出格式', () => {
    const r = applyFieldProcessor(
      records({ d: '2024/08/24', p: '3 Days' }, { d: '2024/08/24', p: '2 Weeks' }),
      [],
      [
        rule({
          type: 'dateOffset',
          targetField: 'out',
          config: { sourceField: 'd', packageField: 'p', outputFormat: 'YYYY-MM-DD' },
        }),
      ],
    );
    expect(r.records.map((x) => x.fields.out)).toEqual(['2024-08-27', '2024-09-07']);
  });

  it('月偏移走 JS setMonth 的自然溢出规则（1/31 + 1 月 → 3/2）', () => {
    // 之所以把这条"看起来不对"的行为固化下来：它是 JS Date 的既定语义，
    // 供应链场景里月末下单（1/31）确实会撞到；改动它必须是有意识的决定
    const r = applyFieldProcessor(
      records({ d: '2024-01-31', p: '1 Months' }),
      [],
      [rule({ type: 'dateOffset', targetField: 'out', config: { sourceField: 'd', packageField: 'p', outputFormat: 'YYYY-MM-DD' } })],
    );
    expect(r.records[0].fields.out).toBe('2024-03-02');
  });

  it('分钟单位目前按"小时"处理（未除以 60，疑似缺陷，见审查报告 C-22）', () => {
    // 本用例锁的是**当前实现**，作用是让"30 minutes 被当成 30 小时"这件事
    // 不再静默：若将来修好（30 分钟 → +30 分钟），这里会红，必须同步更新为期望行为
    const r = applyFieldProcessor(
      records({ d: '2024-08-24 10:00', p: '30 minutes' }),
      [],
      [rule({ type: 'dateOffset', targetField: 'out', config: { sourceField: 'd', packageField: 'p', outputFormat: 'YYYY-MM-DD HH:mm' } })],
    );
    expect(r.records[0].fields.out).toBe('2024-08-25 16:00');
  });

  it('缺字段 / 无法解析的货期 / 无法解析的日期 → 不写入目标字段', () => {
    const r = applyFieldProcessor(
      records(
        { d: '', p: '3 Days' },
        { d: '2024-08-24', p: 'abc' },
        { d: '不是日期', p: '3 Days' },
        { p: '3 Days' },
      ),
      [],
      [rule({ type: 'dateOffset', targetField: 'out', config: { sourceField: 'd', packageField: 'p' } })],
    );
    expect(r.records.every((x) => x.fields.out === undefined)).toBe(true);
    expect(r.errors).toEqual([]); // 静默跳过，不算错误
  });
});

describe('applyFieldProcessor · template', () => {
  it('拼接多字段，缺失字段留下可见标记', () => {
    const r = applyFieldProcessor(
      records({ sku: 'A1', color: '白' }),
      [],
      [rule({ type: 'template', targetField: '标题', config: { template: '{{sku}}-{{color}}-{{size}}' } })],
    );
    expect(r.records[0].fields['标题']).toBe('A1-白-[字段缺失: size]');
  });

  it('模板为空串时写入空串（而非跳过）', () => {
    const r = applyFieldProcessor(records({}), [], [rule({ type: 'template', targetField: 't', config: {} })]);
    expect(r.records[0].fields.t).toBe('');
  });
});

describe('applyFieldProcessor · math', () => {
  const mathRule = (expression: string) =>
    rule({ type: 'math', targetField: 'r', config: { expression } });

  it('四则运算与括号优先级', () => {
    const r = applyFieldProcessor(
      records({ a: '2', b: '3' }),
      [],
      [mathRule('(${a}+${b})*2-1')],
    );
    expect(r.records[0].fields.r).toBe('9');
  });

  it('一元负号', () => {
    const r = applyFieldProcessor(records({ a: '5' }), [], [mathRule('-${a}')]);
    expect(r.records[0].fields.r).toBe('-5');
  });

  it('字段值中的货币符号与千分位会被剥离', () => {
    const r = applyFieldProcessor(records({ p: '¥1,234.00', q: '2' }), [], [mathRule('${p}*${q}')]);
    expect(r.records[0].fields.r).toBe('2468');
  });

  it('小数保留（不做四舍五入）', () => {
    const r = applyFieldProcessor(records({ a: '1', b: '3' }), [], [mathRule('${a}/${b}')]);
    expect(Number(r.records[0].fields.r)).toBeCloseTo(1 / 3, 12);
  });

  it('字段缺失 → 记入 errors，不写入目标字段', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [mathRule('${a}+${qty}')]);
    expect(r.errors).toEqual([{ ruleId: 'r', message: '字段缺失: qty' }]);
    expect(r.records[0].fields.r).toBeUndefined();
  });

  it('字段值无法转成数字 → 记入 errors', () => {
    const r = applyFieldProcessor(records({ a: '1', q: 'abc' }), [], [mathRule('${a}+${q}')]);
    expect(r.errors[0].message).toContain('无法转换为数字');
  });

  it('除零 → 记入 errors（不产生 Infinity）', () => {
    const r = applyFieldProcessor(records({ a: '1', z: '0' }), [], [mathRule('${a}/${z}')]);
    expect(r.errors[0].message).toBe('除零错误');
    expect(r.records[0].fields.r).toBeUndefined();
  });

  it('表达式含非法字符 → 记入 errors', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [mathRule('${a} + alert(1)')]);
    expect(r.errors[0].message).toContain('无法解析');
  });

  it('括号不闭合 → 记入 errors', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [mathRule('(${a}+1')]);
    expect(r.errors[0].message).toBe('缺少闭合括号');
  });

  it('空表达式 → 不写入目标字段且不报错', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [mathRule('')]);
    expect(r.records[0].fields.r).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});

describe('applyFieldProcessor · jsExpression', () => {
  const jsRule = (code: string) => rule({ type: 'jsExpression', targetField: 'r', config: { code } });

  it('按 JS 语义求值并字符串化结果', () => {
    const r = applyFieldProcessor(records({ a: '2', b: '3' }), [], [jsRule('Number(fields.a) * Number(fields.b)')]);
    expect(r.records[0].fields.r).toBe('6');
  });

  it('返回 null/undefined → 不写入目标字段', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [jsRule('null'), jsRule('undefined')]);
    expect(r.records[0].fields.r).toBeUndefined();
  });

  it('字段是冻结副本：表达式内赋值会抛错并计入 errors（防污染）', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [jsRule('(fields.a = "hacked", fields.a)')]);
    expect(r.records[0].fields.a).toBe('1');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/read only|not extensible|Cannot assign/i);
  });

  it('代码语法错误 → 记入 errors，不中断整批处理', () => {
    const r = applyFieldProcessor(records({ a: '1' }), [], [jsRule('这是 不合法 的 表达式')]);
    expect(r.errors).toHaveLength(1);
  });
});
