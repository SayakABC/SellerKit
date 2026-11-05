// 桥层载荷预算 —— 钉住「体积门禁真的会拦、且不会把门禁自己变成瓶颈」。
//
// 背景（2026-09-22 复查 M-02）：UI 岛 → 宿主的 `__sk.call` 载荷原先只校验参数**个数**
// （uiBridgeHost.handleCall 的 arity 检查），不看体积；而宿主侧规模约束是三个独立上限
// （50000 记录 × 256 字段 × 20000 字符/值），组合起来约 250GB。
// 于是"岛发一个大载荷"就能让宿主在结构化克隆之后的消毒复制与规则引擎遍历上卡死。
//
// 本文件守两件事：
//   ① 超预算载荷必须被判定为超限（含"海量小值"这种体积近似为 0 的病态形状）；
//   ② 判断必须**提前返回** —— 估算本身不能因为载荷大而变成新的耗时点。
//
// 注意：为不让测试自己吃满内存，涉及预算的用例一律**下调 budget 参数**来构造同形状的小载荷，
// 而不是真的分配 64MB；默认值本身用一条等式断言钉住。
import { describe, it, expect } from 'vitest';
import { exceedsByteBudget, MAX_PAYLOAD_BYTES } from '@/core/plugin/payloadBudget';

describe('exceedsByteBudget · 预算常量', () => {
  it('默认预算为 64MB（够正常业务量级，只拦病态载荷）', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('exceedsByteBudget · 常规载荷不误判', () => {
  it('空载荷 / 未定义不算超限', () => {
    expect(exceedsByteBudget(undefined)).toBe(false);
    expect(exceedsByteBudget(null)).toBe(false);
    expect(exceedsByteBudget([])).toBe(false);
  });

  it('正常业务量级（几千条记录）远低于默认预算', () => {
    const payload = [
      {
        records: Array.from({ length: 3000 }, (_, i) => ({
          id: i,
          used: false,
          order: i,
          fields: { 款编码: `TV-${i}`, 款名: '测试款名', 数量: String(i % 100) },
        })),
      },
    ];
    expect(exceedsByteBudget(payload)).toBe(false);
  });

  it('嵌套对象与数组都会被计入', () => {
    const one = 'x'.repeat(1024);
    expect(exceedsByteBudget([{ a: [one, one, one], b: { c: one } }], 64 * 1024)).toBe(false);
  });

  it('数字 / 布尔值按固定开销计入（大量数值也会累积）', () => {
    expect(exceedsByteBudget([new Array(100).fill(1)], 800)).toBe(false);
    expect(exceedsByteBudget([new Array(100).fill(1)], 400)).toBe(true);
  });
});

describe('exceedsByteBudget · 超限载荷必须拦下', () => {
  it('字符串是主要体积来源：长值乘性放大后被拦', () => {
    // 10 条记录 × 256 字段 × 2000 字符 ≈ 5MB，用 1MB 预算即可判定（同 M-02 的形状，缩小版）
    const val = 'x'.repeat(2000);
    const fields: Record<string, string> = {};
    for (let i = 0; i < 256; i++) fields[`f${i}`] = val;
    const payload = [{ records: Array.from({ length: 10 }, (_, id) => ({ id, fields })) }];
    expect(exceedsByteBudget(payload, 1024 * 1024)).toBe(true);
  });

  it('海量小值（体积近似为 0，但节点数异常）也会被拦', () => {
    // 60 个数组 × 1000 项 = 6 万节点 > maxNodes(50000)：靠节点数上限兜住，不依赖体积
    const payload = [Array.from({ length: 60 }, () => new Array(1000).fill(''))];
    expect(exceedsByteBudget(payload)).toBe(true);
  });

  it('超长数组不逐项入栈即可判定（由数组长度直接早退）', () => {
    const payload = [new Array(50001).fill('')];
    expect(exceedsByteBudget(payload)).toBe(true);
  });

  it('预算可下调：同一载荷在小预算下超限、大预算下不超限', () => {
    const payload = ['x'.repeat(1000)];
    expect(exceedsByteBudget(payload, 500)).toBe(true);
    expect(exceedsByteBudget(payload, 5000)).toBe(false);
  });

  it('先超预算即返回，不受其后更大的兄弟节点影响（早退语义）', () => {
    const payload = [{ small: 'x'.repeat(100), big: 'y'.repeat(100000) }];
    expect(exceedsByteBudget(payload, 5000)).toBe(true);
  });
});
