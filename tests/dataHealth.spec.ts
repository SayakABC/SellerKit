// 「待补清单」判定层的单测。
//
// 这里守的**不是**"六类检查都返回了"（那是空转），而是每一类**判得对不对**：
//   · 同一缺口会不会被合并成一条、数量会不会重复计；
//   · 会不会把"其实不缺"的东西报成缺（`XXXL` vs `3XL`、归档变体、已填克重）；
//   · 会不会把"缺"悄悄吞掉（款不在产品库时若提前 return，后面两类就不再报它）。
// 每条都能被一条真实错误实现弄红 —— 写断言时按这个标准挑样本。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDataHealth, pendingKinds, UNCLASSIFIED_COLOR, type HealthInput } from '../src/lib/dataHealth';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 三款产品：P1 正常（S/M/L 都有、都填了克重、有进价）；
 *  P2 尺码只有 L、且 L 没填克重、没进价；P3 还没有任何 SKU。 */
function baseInput(): HealthInput {
  return {
    products: [
      { id: 1, code: 'P1', name: '款一', status: 'active' },
      { id: 2, code: 'P2', name: '款二', status: 'active' },
      { id: 3, code: 'P3', name: '款三', status: 'active' },
    ],
    variants: [
      { productId: 1, size: 'S', weightG: 200, status: 'active' },
      { productId: 1, size: 'M', weightG: 220, status: 'active' },
      { productId: 1, size: 'L', weightG: 240, status: 'active' },
      { productId: 2, size: 'L', weightG: 0, status: 'active' },
    ],
    pricedCodes: ['P1'],
    orders: [],
  };
}

const check = (input: HealthInput, id: string) =>
  buildDataHealth(input).find((c) => c.id === id)!;

describe('待补清单：六类缺口各自判得对', () => {
  it('全部齐了就是六类都为空（这是后续每条用例的对照基线）', () => {
    const checks = buildDataHealth(baseInput());
    // P2 缺 L 的克重、P2/P3 没进价 ⇒ 只有这两类不为空；其余必须干净
    expect(checks.map((c) => [c.id, c.n])).toEqual([
      ['unconfirmed', 0],
      ['noColor', 0],
      ['styleNotBuilt', 0],
      ['sizeMissing', 0],
      ['weightMissing', 1],
      ['costMissing', 2],
    ]);
    expect(pendingKinds(checks)).toBe(2);
  });

  it('① 没认到款：按「店铺 + 商品ID」合并，数量是单数而不是行数', () => {
    const input = baseInput();
    input.orders = [
      { shop: '店A', itemId: '1001', styleCode: '' },
      { shop: '店A', itemId: '1001', styleCode: '' },
      { shop: '店A', itemId: '1002', styleCode: '' },
      { shop: '', itemId: '', styleCode: '' },
    ];
    const c = check(input, 'unconfirmed');
    expect(c.n).toBe(4);
    expect(c.items).toHaveLength(3);
    // 同一商品的两单合成一条，且数量是 2（合并时把 n 加起来，不是只留 1）
    const one = c.items.find((i) => i.title === '店A' && i.detail === '商品ID 1001')!;
    expect(one.n).toBe(2);
    // 没有店铺也没有商品ID 的那一单不能丢（丢了就是"清单少一行、没人知道"）
    expect(c.items.some((i) => i.title === '未知店铺' && i.detail === '没有商品ID')).toBe(true);
  });

  it('② 颜色「未分类」：同款多个平台色名要都写出来（否则用户不知道要认几个色）', () => {
    const input = baseInput();
    input.orders = [
      { shop: '店A', styleCode: 'P1', styleColor: UNCLASSIFIED_COLOR, color: 'Khaki', size: 'S' },
      { shop: '店A', styleCode: 'P1', styleColor: UNCLASSIFIED_COLOR, color: '7', size: 'M' },
      // 颜色已经定了的那一单不该进清单
      { shop: '店A', styleCode: 'P1', styleColor: '黑色', color: 'black', size: 'L' },
    ];
    const c = check(input, 'noColor');
    expect(c.n).toBe(2);
    expect(c.items).toHaveLength(1);
    expect(c.items[0].detail).toContain('Khaki');
    expect(c.items[0].detail).toContain('7');
  });

  it('②b 色名互为子串（K / Khaki）也要各算一个 —— 用 includes 去重会静默吞掉一个', () => {
    // 真实库就是这么乱的：同款不同商品ID 上既有 `Khaki` 也有 `K`。
    // 用 `detail.includes(色名)` 判重在遇到 `K` 时会命中 `Khaki` 那一半，后一个色直接消失，
    // 而清单看起来只是"这款少一个色"，谁也不会去查。故按**等值**去重。
    const input = baseInput();
    input.orders = [
      { styleCode: 'P1', styleColor: UNCLASSIFIED_COLOR, color: 'Khaki' },
      { styleCode: 'P1', styleColor: UNCLASSIFIED_COLOR, color: 'K' },
    ];
    const c = check(input, 'noColor');
    expect(c.n).toBe(2);
    // ⚠️ 判据必须按**分隔符切开**再比：`detail` 里含 `Khaki` 时，`toContain('K')` 也成立
    //    （子串），那样这条用例会把"被吞掉一个色"的实现放过去 —— 正是它要抓的那个 bug。
    const colors = c.items[0].detail.replace('订单上的颜色：', '').split(' / ');
    expect(colors.sort()).toEqual(['K', 'Khaki']);
  });

  it('③ 认到的款不在产品库：报出来，且**不再重复**计入后两类（同一单只算一次）', () => {
    const input = baseInput();
    input.orders = [
      { shop: '店A', styleCode: 'STYPE-001', styleColor: '红色', size: 'S' },
      { shop: '店B', styleCode: 'stype-001', styleColor: '红色', size: 'M' },
    ];
    const checks = buildDataHealth(input);
    const c = checks.find((x) => x.id === 'styleNotBuilt')!;
    // 大小写不同也是同一个款编码（产品库比对走 upper）—— 两条合成一条、n=2
    expect(c.items).toHaveLength(1);
    expect(c.n).toBe(2);
    // 尺码那类不该再报它：款都不存在，"产品里有没有 S 码"这个问题无从谈起
    expect(checks.find((x) => x.id === 'sizeMissing')!.n).toBe(0);
  });

  it('④ 尺码：XXXL 与 3XL 是同一个码，不算缺口；真没有的码才报', () => {
    const input = baseInput();
    input.variants.push({ productId: 2, size: '3XL', weightG: 300, status: 'active' });
    input.orders = [
      // 产品写 3XL、订单写 XXXL —— 有 `canonSizeKey` 就不会被当成缺口
      { styleCode: 'P2', styleColor: '黑色', color: 'black', size: 'XXXL' },
      // M 码 P2 确实没有
      { styleCode: 'P2', styleColor: '黑色', color: 'black', size: 'M' },
      { styleCode: 'P2', styleColor: '黑色', color: 'black', size: 'M' },
    ];
    const c = check(input, 'sizeMissing');
    expect(c.n).toBe(2);
    expect(c.items).toHaveLength(1);
    expect(c.items[0].title).toContain('M');
    expect(c.items[0].detail).toContain('没有 M 码');
  });

  it('④b 归档的变体不算"这个码有"（归档 = 用户已经不用它了，拿它当有会一直显示"齐了"）', () => {
    const input = baseInput();
    input.variants = [
      ...input.variants,
      { productId: 2, size: 'S', weightG: 180, status: 'archived' },
    ];
    input.orders = [{ styleCode: 'P2', styleColor: '黑色', color: 'black', size: 'S' }];
    const c = check(input, 'sizeMissing');
    expect(c.n).toBe(1);
  });

  it('④c 一款还没有任何 SKU：说清是"先建 SKU"，不是"补这个码"', () => {
    const input = baseInput();
    input.orders = [{ styleCode: 'P3', styleColor: '黑色', color: 'black', size: 'L' }];
    const c = check(input, 'sizeMissing');
    expect(c.n).toBe(1);
    expect(c.items[0].detail).toContain('还没有任何 SKU');
  });

  it('⑤ 克重：只数在售 SKU，单位是"个 SKU"', () => {
    const input = baseInput();
    input.variants = [
      ...input.variants,
      { productId: 2, size: 'XL', weightG: 0, status: 'active' },
      // 归档的缺克重不该计入（用户已经不卖它了）
      { productId: 2, size: 'XXL', weightG: 0, status: 'archived' },
    ];
    const c = check(input, 'weightMissing');
    expect(c.unit).toBe('个 SKU');
    // P2 在售两个（L/XL）都缺 ⇒ 2；P1 三个都填了 ⇒ 一条都不该出
    expect(c.n).toBe(2);
    expect(c.items).toHaveLength(1);
    expect(c.items[0].title).toContain('P2');
    expect(c.items[0].detail).toContain('共 2 个 SKU，缺 2 个');
  });

  it('⑥ 进价：款编码大小写不敏感；没填的逐款一条', () => {
    const input = baseInput();
    input.pricedCodes = [' p1 '];
    const c = check(input, 'costMissing');
    expect(c.n).toBe(2);
    expect(c.items.map((i) => i.title)).toEqual(['P2 款二', 'P3 款三']);
  });

  it('⚠️ 非空转自检：把一条真实缺口补上，数字必须跟着变（喂两个应结果不同的输入）', () => {
    const before = buildDataHealth(baseInput());
    const fixed = baseInput();
    fixed.variants = fixed.variants.map((v) =>
      v.productId === 2 && v.size === 'L' ? { ...v, weightG: 260 } : v
    );
    fixed.pricedCodes = ['P1', 'P2', 'P3'];
    const after = buildDataHealth(fixed);
    expect(before.find((c) => c.id === 'weightMissing')!.n).toBe(1);
    expect(after.find((c) => c.id === 'weightMissing')!.n).toBe(0);
    expect(before.find((c) => c.id === 'costMissing')!.n).toBe(2);
    expect(after.find((c) => c.id === 'costMissing')!.n).toBe(0);
  });

  it('标题上的数 = 明细累加（不另写一条 COUNT；对不上就是"整页不可信"）', () => {
    const input = baseInput();
    input.orders = [
      { shop: '店A', itemId: '1', styleCode: '' },
      { shop: '店A', itemId: '1', styleCode: '' },
      { shop: '店B', itemId: '2', styleCode: '' },
      { styleCode: 'P2', styleColor: UNCLASSIFIED_COLOR, color: 'Khaki', size: 'M' },
      { styleCode: 'P2', styleColor: UNCLASSIFIED_COLOR, color: 'Khaki', size: 'M' },
    ];
    for (const c of buildDataHealth(input)) {
      expect(c.n, `${c.id} 的数与明细对不上`).toBe(c.items.reduce((s, i) => s + i.n, 0));
    }
  });
});

describe('待补清单：口径常量必须与主进程一致', () => {
  it('「未分类」这个占位值与 electron/order-db.ts 的 MAPPED_FALLBACK_COLOR 逐字相同', () => {
    // 两个进程各存一份字面量（跨进程共享常量的代价比这行断言大）。
    // 主进程那边一改，这份清单就会把"已定色"的订单当成"未分类"重新报一遍 ——
    // 而这种错**不会报错**，只会让清单永远清不掉。故在这里钉死。
    const src = readFileSync(resolve(ROOT, 'electron/order-db.ts'), 'utf-8');
    const m = /MAPPED_FALLBACK_COLOR\s*=\s*'([^']*)'/.exec(src);
    expect(m, '主进程里找不到 MAPPED_FALLBACK_COLOR（常量改名了？）').toBeTruthy();
    expect(m![1]).toBe(UNCLASSIFIED_COLOR);
  });
});

describe('待补清单：「去补」的接线（源码级，界面上点一次验不了的那一半）', () => {
  const pane = readFileSync(resolve(ROOT, 'src/modules/shop-accounts/components/HealthPane.vue'), 'utf-8');
  const today = readFileSync(resolve(ROOT, 'src/modules/today/TodayView.vue'), 'utf-8');

  it('三类去处各自落到真实落点：订单侧走发货台、货品侧走组内页签（进价已并入产品管理）', () => {
    // 为什么钉源码：`master-data:ui` 只点得动"同模块"那一下（跳走之后整页换掉，
    // 后面的断言没法接着跑）；跨模块那一下只能靠"事件被消费"来验，而"按钮到哪个 action"
    // 这层映射没有别的地方能观察到。
    expect(pane.includes("switchModule('today', 'classify')"), '「未认款/未定色」没指到归类核对').toBe(true);
    expect(pane.includes("switchModule('shop-accounts', 'goods')"), '「款/尺码/克重/进价」没指到产品管理').toBe(true);
    // 2026-10-22（B'）：进价页整页退役，进价缺口现在也跳「产品管理」（配合「只看缺进价」筛选）。
    // 反守卫：旧的 cost 跳转不能残留（残留 = 点了进价那一项跳到已删除的页签）。
    expect(pane.includes("switchModule('shop-accounts', 'cost')"), '进价还指向已退役的进价页（应跳产品管理）').toBe(
      false
    );
  });

  it('发货台会消费 action：marker 在挂载时读、已在场时靠事件接（漏一条 = 点了没反应）', () => {
    // 两条路缺一不可（同 `MasterDataView.applySwitchAction` 的注释）：
    //   · 模块不在场 → AppShell 存 `__switchModuleAction`，目标视图 onMounted 消费；
    //   · 模块已在场 → AppShell 的 activateCore 对同模块早退，marker 没人消费 ⇒ 必须自己监听。
    expect(today.includes('__switchModuleAction'), '没读 marker = 从别的模块跳进来停在总览').toBe(true);
    expect(
      today.includes("addEventListener('switch-module'"),
      '没监听 switch-module = 已经在发货台时再点「去认款」没有任何反应'
    ).toBe(true);
    // 认不出的 action 不许硬赋（否则 tab 会变成一个不存在的 id，页签区一片空）
    expect(today.includes("TABS.some((t) => t.id === detail.action)"), '不认识 action 也赋值了').toBe(true);
  });
});
