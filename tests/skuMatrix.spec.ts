import { describe, expect, it } from 'vitest';
import {
  addMatrixColor,
  addMatrixSize,
  classifyMatrixColor,
  countFilledWeightCells,
  emptySkuMatrix,
  fillMatrixSizeWeight,
  fillMatrixWeight,
  fromSkuMatrix,
  matrixWeightCommon,
  mergeMatrixColor,
  mergeSkuMatrix,
  normWeightG,
  parseSkuJsonRows,
  removeMatrixColor,
  removeMatrixSize,
  renameMatrixSize,
  setMatrixColumnCells,
  setMatrixRowCells,
  skuMatrixComboCount,
  skuRowKey,
  toSkuJsonRow,
  toSkuMatrix,
  toggleMatrixCell,
  type SkuFlatRow,
  type SkuMatrix,
} from '../src/lib/skuMatrix';

/** 真库 id=12 的形状：同名不同图（`blue` 挂两张图，各 2 码）+ 一个单图色 */
const SAME_NAME_DIFF_IMG: SkuFlatRow[] = [
  { color: 'blue', size: 'S', price: '', imageUrl: 'https://img/a.jpg' },
  { color: 'blue', size: 'M', price: '', imageUrl: 'https://img/a.jpg' },
  { color: 'blue', size: 'S', price: '', imageUrl: 'https://img/b.jpg' },
  { color: 'blue', size: 'M', price: '', imageUrl: 'https://img/b.jpg' },
  { color: 'red', size: 'S', price: '', imageUrl: 'https://img/c.jpg' },
];

describe('toSkuMatrix — 结构还原', () => {
  it('满叉积：2 色 × 2 码 ⇒ 4 格，行序/列序 = 首次出现顺序', () => {
    const m = toSkuMatrix([
      { color: '黑', size: 'L', price: '1', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '2', imageUrl: 'i1' },
      { color: '白', size: 'L', price: '3', imageUrl: 'i2' },
      { color: '白', size: 'M', price: '4', imageUrl: 'i2' },
    ]);
    expect(m.sizes).toEqual(['L', 'M']);
    expect(m.rows.map((r) => r.color)).toEqual(['黑', '白']);
    expect(skuMatrixComboCount(m)).toBe(4);
    expect(fromSkuMatrix(m)).toEqual([
      { color: '黑', size: 'L', price: '1', imageUrl: 'i1', weightG: 0 },
      { color: '黑', size: 'M', price: '2', imageUrl: 'i1', weightG: 0 },
      { color: '白', size: 'L', price: '3', imageUrl: 'i2', weightG: 0 },
      { color: '白', size: 'M', price: '4', imageUrl: 'i2', weightG: 0 },
    ]);
  });

  it('⭐ 空洞矩阵（黑只有 L、4 只有 M）⇒ 只 2 格，来回转**不凭空补格**', () => {
    const flat: SkuFlatRow[] = [
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '4', size: 'M', price: '', imageUrl: '' },
    ];
    const m = toSkuMatrix(flat);
    expect(m.sizes).toEqual(['L', 'M']);
    expect(skuMatrixComboCount(m)).toBe(2);
    // 交叉位（黑×M、4×L）必须是"不存在"，不是"0 元"
    expect(Object.prototype.hasOwnProperty.call(m.rows[0].cells, 'M')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(m.rows[1].cells, 'L')).toBe(false);
    expect(fromSkuMatrix(m)).toEqual([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1', weightG: 0 },
      { color: '4', size: 'M', price: '', imageUrl: '', weightG: 0 },
    ]);
  });

  it('⭐ 同名不同图 = 两行（真库 id=12 的形状：blue 挂两张图）', () => {
    const m = toSkuMatrix(SAME_NAME_DIFF_IMG);
    expect(m.rows.length).toBe(3);
    expect(m.rows.map((r) => r.imageUrl)).toEqual([
      'https://img/a.jpg',
      'https://img/b.jpg',
      'https://img/c.jpg',
    ]);
    // 两行的色名都是 blue，但 key 不同 —— 按色名做行身份会把这里静默合并成一行（丢一半）
    expect(m.rows[0].color).toBe('blue');
    expect(m.rows[1].color).toBe('blue');
    expect(m.rows[0].key).not.toBe(m.rows[1].key);
    expect(fromSkuMatrix(m).length).toBe(5);
  });

  it('同图同名重复帧 ⇒ 合并（幂等，不产生第二格）', () => {
    const m = toSkuMatrix([
      { color: '黑', size: 'L', price: '9', imageUrl: 'i1' },
      { color: '黑', size: 'L', price: '9', imageUrl: 'i1' },
    ]);
    expect(m.rows.length).toBe(1);
    expect(skuMatrixComboCount(m)).toBe(1);
  });

  it('无图（列表轻采）⇒ 行身份回落色名；无图同名合并', () => {
    const m = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '' },
      { color: '黑', size: 'M', price: '', imageUrl: '' },
    ]);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].key).toBe('name:黑');
    expect(m.sizes).toEqual(['L', 'M']);
  });

  it('全空行跳过（与主进程 normalizeIngestSku 同一条规则）', () => {
    const m = toSkuMatrix([
      { color: '', size: '', price: '', imageUrl: '' },
      { color: '', size: 'M', price: '', imageUrl: '' },
    ]);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].color).toBe('');
    expect(m.sizes).toEqual(['M']);
  });

  it('price 原样保留（界面撤掉价格格 ≠ 可以丢已存的值）', () => {
    const m = toSkuMatrix([{ color: '黑', size: 'L', price: 'US $9.99', imageUrl: 'i1' }]);
    expect(m.rows[0].cells['L'].price).toBe('US $9.99');
    expect(fromSkuMatrix(m)[0].price).toBe('US $9.99');
  });

  it('空输入 / 非数组 / null ⇒ 空矩阵（不抛）', () => {
    expect(toSkuMatrix([])).toEqual({ sizes: [], rows: [] });
    expect(toSkuMatrix(null)).toEqual({ sizes: [], rows: [] });
    expect(toSkuMatrix(undefined)).toEqual({ sizes: [], rows: [] });
  });
});

describe('矩阵操作 —— 存在性语义', () => {
  it('toggleMatrixCell：空格 ⇄ 有，两个方向都真的变了', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
    ]);
    const off = toggleMatrixCell(base, 0, 'M');
    expect(skuMatrixComboCount(off)).toBe(1);
    const on = toggleMatrixCell(off, 0, 'M');
    expect(skuMatrixComboCount(on)).toBe(2);
  });

  it('⭐ 取消一格后再展开 ⇒ 少一条（不是"留一条空的"）', () => {
    const m = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
    ]);
    const after = fromSkuMatrix(toggleMatrixCell(m, 0, 'M'));
    expect(after.map((r) => r.size)).toEqual(['L']);
  });

  // 整行 / 整列批量：界面上的"这一色全都卖""这一码全都卖"。
  // ⚠️ 两条判据必须分开钉：**幂等**（已是目标状态 ⇒ 返回原对象，界面不多出"待保存"）
  //    与**真的改了**（否则一个永远 return m 的实现也能过"幂等"那条）。
  it('setMatrixRowCells：整行开 ⇒ 补齐这一行的空格，别的行不动', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
      { color: '白', size: 'L', price: '', imageUrl: 'i2' },
    ]);
    const m = setMatrixRowCells(base, 1, true, 180);
    expect(fromSkuMatrix(m)).toEqual([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1', weightG: 0 },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1', weightG: 0 },
      { color: '白', size: 'L', price: '', imageUrl: 'i2', weightG: 0 },
      { color: '白', size: 'M', price: '', imageUrl: 'i2', weightG: 180 },
    ]);
  });

  it('setMatrixRowCells：整行关 ⇒ 这一行的格全删（别的行一格不少）', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
      { color: '白', size: 'L', price: '', imageUrl: 'i2' },
    ]);
    const m = setMatrixRowCells(base, 0, false);
    expect(fromSkuMatrix(m)).toEqual([
      { color: '白', size: 'L', price: '', imageUrl: 'i2', weightG: 0 },
    ]);
  });

  it('⭐ setMatrixRowCells / setMatrixColumnCells 幂等：已是目标状态 ⇒ 原对象引用', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
    ]);
    expect(setMatrixRowCells(base, 0, true)).toBe(base);
    expect(setMatrixColumnCells(base, 'L', true)).toBe(base);
    expect(setMatrixRowCells(base, 9, true)).toBe(base); // 索引越界不造行
    expect(setMatrixColumnCells(base, 'XXL', false)).toBe(base); // 没有这一列不造列
  });

  it('setMatrixColumnCells：整列开/关只动这一列，且开的时候带上默认克重', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '白', size: 'M', price: '', imageUrl: 'i2' },
    ]);
    const on = setMatrixColumnCells(base, 'M', true, 250);
    expect(on.rows.map((r) => r.cells['M']?.weightG ?? null)).toEqual([250, 0]);
    const off = setMatrixColumnCells(on, 'M', false);
    expect(skuMatrixComboCount(off)).toBe(1);
    expect(off.rows.map((r) => r.cells['L'] !== undefined)).toEqual([true, false]);
  });

  it('addMatrixColor：新行对**所有现有尺码**默认有格', () => {
    const m = addMatrixColor(
      toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: 'i1' }]),
      '红',
      'i9'
    );
    expect(m.sizes).toEqual(['L']);
    expect(skuMatrixComboCount(m)).toBe(2);
    expect(fromSkuMatrix(m)).toEqual([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1', weightG: 0 },
      { color: '红', size: 'L', price: '', imageUrl: 'i9', weightG: 0 },
    ]);
  });

  it('addMatrixSize：新列对**所有现有颜色**默认有格；重名不重复加列', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '白', size: 'L', price: '', imageUrl: 'i2' },
    ]);
    const m = addMatrixSize(base, 'M');
    expect(m.sizes).toEqual(['L', 'M']);
    expect(skuMatrixComboCount(m)).toBe(4);
    expect(addMatrixSize(m, 'M').sizes).toEqual(['L', 'M']);
  });

  it('removeMatrixColor / removeMatrixSize：整行 / 整列连同格一起消失', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
      { color: '白', size: 'L', price: '', imageUrl: 'i2' },
    ]);
    const noBlack = removeMatrixColor(base, 0);
    expect(noBlack.rows.map((r) => r.color)).toEqual(['白']);
    expect(skuMatrixComboCount(noBlack)).toBe(1);
    const noM = removeMatrixSize(base, 'M');
    expect(noM.sizes).toEqual(['L']);
    expect(skuMatrixComboCount(noM)).toBe(2);
  });

  it('renameMatrixSize：整列改名，格里的值跟着搬；重名 ⇒ 合并（不覆盖已有列的值）', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '1', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '2', imageUrl: 'i1' },
    ]);
    const renamed = renameMatrixSize(base, 'M', 'L');
    expect(renamed.sizes).toEqual(['L']);
    expect(renamed.rows[0].cells['L'].price).toBe('1');
    const moved = renameMatrixSize(base, 'M', 'S');
    expect(moved.sizes).toEqual(['L', 'S']);
    expect(moved.rows[0].cells['S'].price).toBe('2');
  });

  it('emptySkuMatrix：一色 × 一码、那一格存在（打开就能填）', () => {
    const m = emptySkuMatrix();
    expect(m.sizes.length).toBe(1);
    expect(m.rows.length).toBe(1);
    expect(skuMatrixComboCount(m)).toBe(1);
    // 但"没填任何东西的格"不构成 SKU：直接保存 = 空矩阵（= 这一款没有规格），
    // 与旧弹层"给一个空行、直接保存存 []"以及主进程 normalizeIngestSku 的全空跳过一致。
    expect(fromSkuMatrix(m)).toEqual([]);
  });
});

describe('展开与 IPC 形状', () => {
  it('⭐ 克重 0 不写 key：存量 546 条快照的形状一个字节都不变', () => {
    const m = addMatrixSize(toSkuMatrix([{ color: '黑', size: 'L', price: 'p', imageUrl: 'i1' }]), 'M');
    const out = fromSkuMatrix(m).map(toSkuJsonRow);
    expect(out).toEqual([
      { color: '黑', size: 'L', price: 'p', imageUrl: 'i1' },
      { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
    ]);
    expect('weightG' in out[0]).toBe(false);
  });

  it('⭐ 填过克重的行带上 weightG（0 与"没填"是同一件事，所以清回 0 = 去掉 key）', () => {
    const m = toSkuMatrix([{ color: '红', size: 'L', price: '', imageUrl: '' }]);
    m.rows[0].cells['L'].weightG = 120;
    expect(toSkuJsonRow(fromSkuMatrix(m)[0])).toEqual({
      color: '红',
      size: 'L',
      price: '',
      imageUrl: '',
      weightG: 120,
    });
    m.rows[0].cells['L'].weightG = 0;
    expect('weightG' in toSkuJsonRow(fromSkuMatrix(m)[0])).toBe(false);
  });

  it('克重随格带走（一个填、一个没填 —— 只喂一个输入分不出"全写成同一个数"）', () => {
    const m = addMatrixSize(toSkuMatrix([{ color: '红', size: 'L', price: '', imageUrl: '' }]), 'M');
    m.rows[0].cells['L'].weightG = 120;
    expect(fromSkuMatrix(m).map((r) => [r.size, r.weightG])).toEqual([
      ['L', 120],
      ['M', 0],
    ]);
  });

  it('skuRowKey：色图 + 色名共同决定身份（同名不同图分开、同图同名合并）', () => {
    expect(skuRowKey('a', '黑')).toBe(skuRowKey('a', '黑'));
    expect(skuRowKey('a', '黑')).not.toBe(skuRowKey('b', '黑'));
    expect(skuRowKey('a', '黑')).not.toBe(skuRowKey('a', '白'));
    expect(skuRowKey('', '黑')).toBe(skuRowKey('', '黑'));
    expect(skuRowKey('  a  ', '黑')).toBe(skuRowKey('a', '黑'));
  });
});

describe('克重：读 / 写 / 批量填（弹层与向导共用同一套）', () => {
  it('反序列化读回克重；缺字段 / 脏值 / 负数一律 0（0 = 没填）', () => {
    const m = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 88 },
      { color: '黑', size: 'M', price: '', imageUrl: '' },
      { color: '白', size: 'L', price: '', imageUrl: '', weightG: -5 },
      { color: '白', size: 'M', price: '', imageUrl: '', weightG: 'abc' as unknown as number },
    ]);
    expect(m.rows[0].cells['L'].weightG).toBe(88);
    expect(m.rows[0].cells['M'].weightG).toBe(0);
    expect(m.rows[1].cells['L'].weightG).toBe(0);
    expect(m.rows[1].cells['M'].weightG).toBe(0);
  });

  it('normWeightG：四舍五入到整数克，非数/负数/Infinity ⇒ 0', () => {
    expect(normWeightG(88.4)).toBe(88);
    expect(normWeightG('120')).toBe(120);
    expect(normWeightG(-1)).toBe(0);
    expect(normWeightG(Number.NaN)).toBe(0);
    expect(normWeightG(Infinity)).toBe(0);
    expect(normWeightG(undefined)).toBe(0);
  });

  it('⭐⭐ 填进空格：只动还没填的格，已填的原样留着（批量动作的默认语义）', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 200 },
      { color: '黑', size: 'M', price: '', imageUrl: '' },
      { color: '白', size: 'L', price: '', imageUrl: '' },
      { color: '白', size: 'M', price: '', imageUrl: '', weightG: 300 },
    ]);
    expect(countFilledWeightCells(base)).toBe(2);
    const after = fillMatrixWeight(base, 150);
    expect(fromSkuMatrix(after).map((r) => r.weightG)).toEqual([200, 150, 150, 300]);
    expect(countFilledWeightCells(after)).toBe(4);
  });

  it('⭐ 覆盖已填（onlyEmpty=false）才改已填的值 —— 两个动作必须是两回事', () => {
    const base = toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: '', weightG: 200 }]);
    expect(fromSkuMatrix(fillMatrixWeight(base, 150))[0].weightG).toBe(200);
    expect(fromSkuMatrix(fillMatrixWeight(base, 150, { onlyEmpty: false }))[0].weightG).toBe(150);
  });

  it('⭐⭐ 批量填**绝不**把空格变成 SKU（不存在 ≠ 0 克）', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '' },
      { color: '白', size: 'M', price: '', imageUrl: '' },
    ]);
    expect(skuMatrixComboCount(base)).toBe(2);
    const after = fillMatrixWeight(base, 150, { onlyEmpty: false });
    expect(skuMatrixComboCount(after)).toBe(2);
    expect(fromSkuMatrix(after).map((r) => `${r.color}/${r.size}=${r.weightG}`)).toEqual([
      '黑/L=150',
      '白/M=150',
    ]);
  });

  it('填 0 / 负数 = 什么都不做（不会把已填的值清成 0）', () => {
    const base = toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: '', weightG: 200 }]);
    expect(fillMatrixWeight(base, 0, { onlyEmpty: false })).toBe(base);
    expect(fillMatrixWeight(base, -3, { onlyEmpty: false })).toBe(base);
  });

  // ── 按码填（2026-10-25：克重的真实粒度是「款 × 码」，不是"格"）──────────────
  // 真库取证：303 个已填克重的 SKU 里，按「产品 + 尺码」分组后，有 2 色以上的 86 组
  // **全部**"同码各色完全一致"（0 组不一致，涉及 298 个 SKU）。所以"填一列"是主路径。
  const ladder = () =>
    toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 500 },
      { color: '黑', size: 'XL', price: '', imageUrl: '' },
      { color: '白', size: 'L', price: '', imageUrl: '' },
      { color: '白', size: 'XL', price: '', imageUrl: '', weightG: 600 },
    ]);
  const dump = (m: SkuMatrix) =>
    fromSkuMatrix(m).map((r) => `${r.color}/${r.size}=${r.weightG}`);

  it('⭐⭐ 按码填只动这一列：M 码铺开，另一列的既有值一个都不碰', () => {
    const after = fillMatrixSizeWeight(ladder(), 'XL', 600);
    expect(dump(after)).toEqual(['黑/L=500', '黑/XL=600', '白/L=0', '白/XL=600']);
    // 反向：L 列没被动过
    expect(dump(after)[0]).toBe('黑/L=500');
  });

  it('按码填默认只填空；onlyEmpty=false 才覆盖该列的已填值', () => {
    const base = ladder();
    expect(dump(fillMatrixSizeWeight(base, 'L', 700))[0]).toBe('黑/L=500'); // 已填不动
    expect(dump(fillMatrixSizeWeight(base, 'L', 700, { onlyEmpty: false }))[0]).toBe('黑/L=700');
    // 反向对照：覆盖只发生在我点名的那一列
    expect(dump(fillMatrixSizeWeight(base, 'L', 700, { onlyEmpty: false }))[3]).toBe('白/XL=600');
  });

  it('⭐⭐ 按码填绝不把空格变成 SKU（只碰存在的格）', () => {
    // 只有 黑/L 一格：填 L 列不该凭空长出 白/L
    const base = toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: '' }]);
    const after = fillMatrixSizeWeight(base, 'L', 500);
    expect(skuMatrixComboCount(after)).toBe(1);
    expect(dump(after)).toEqual(['黑/L=500']);
  });

  it('⭐⭐ createMissing：列头敲数 = 这一码整列，缺的格一起补齐（"填了克重却要删 SKU"的根因）', () => {
    // 模拟"白/L 被误点列头取消掉了"：库里还有这条 SKU，矩阵里却没有
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '' },
      { color: '黑', size: 'XL', price: '', imageUrl: '' },
      { color: '白', size: 'XL', price: '', imageUrl: '', weightG: 600 },
    ]);
    expect(dump(base)).toEqual(['黑/L=0', '黑/XL=0', '白/XL=600']);

    const after = fillMatrixSizeWeight(base, 'L', 500, { onlyEmpty: false, createMissing: true });
    // 白/L 被补上；另一列（XL=600）一个都没动
    expect(dump(after)).toEqual(['黑/L=500', '黑/XL=0', '白/L=500', '白/XL=600']);
    expect(skuMatrixComboCount(after)).toBe(4);
  });

  it('createMissing 仍守 onlyEmpty：已填的值不被覆盖（补齐 ≠ 覆盖）', () => {
    const base = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 320 },
      { color: '白', size: 'L', price: '', imageUrl: '' },
    ]);
    const after = fillMatrixSizeWeight(base, 'L', 500, { createMissing: true });
    expect(dump(after)).toEqual(['黑/L=320', '白/L=500']);
  });

  it('按码填：0 / 负数 / 不存在的码 ⇒ 原样返回（同一个对象引用）', () => {
    const base = ladder();
    expect(fillMatrixSizeWeight(base, 'XL', 0)).toBe(base);
    expect(fillMatrixSizeWeight(base, 'XL', -1)).toBe(base);
    expect(fillMatrixSizeWeight(base, '3XL', 500)).toBe(base);
  });

  it('⭐ matrixWeightCommon：全一致才给值，混填/待填一律 0（派生显示，不编默认值）', () => {
    const same = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 500 },
      { color: '白', size: 'L', price: '', imageUrl: '', weightG: 500 },
    ]);
    expect(matrixWeightCommon(same)).toBe(500); // 正向对照：不是恒 0

    const mixed = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 500 },
      { color: '白', size: 'L', price: '', imageUrl: '', weightG: 600 },
    ]);
    expect(matrixWeightCommon(mixed)).toBe(0);

    const partial = toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 500 },
      { color: '白', size: 'L', price: '', imageUrl: '' }, // 有格没填 ⇒ 谈不上共同值
    ]);
    expect(matrixWeightCommon(partial)).toBe(0);
    expect(matrixWeightCommon(toSkuMatrix([]))).toBe(0);
  });

  it('⭐ matrixWeightCommon 传 size ⇒ 只看该列（列头显示的就是这个）', () => {
    const base = ladder(); // L: 500 / 0 ；XL: 0 / 600
    expect(matrixWeightCommon(base, 'XL')).toBe(0); // 该列有格没填
    const filled = fillMatrixSizeWeight(base, 'XL', 600);
    expect(matrixWeightCommon(filled, 'XL')).toBe(600);
    expect(matrixWeightCommon(filled, 'L')).toBe(0); // 另一列仍未填满 ⇒ 0，不是 600
  });

  it('新增的颜色 / 尺码 / 重新加入的格带上默认克重（人显式设过才有）', () => {
    const base = toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: '' }]);
    const withColor = addMatrixColor(base, '红', '', 300);
    expect(withColor.rows[1].cells['L'].weightG).toBe(300);
    // 没给默认值 ⇒ 新格是"待填"，不是 0 号值被当成填过
    expect(addMatrixColor(base, '蓝', '').rows[1].cells['L'].weightG).toBe(0);

    const withSize = addMatrixSize(base, 'XL', 250);
    expect(withSize.rows[0].cells['XL'].weightG).toBe(250);

    const off = toggleMatrixCell(withColor, 1, 'L');
    const on = toggleMatrixCell(off, 1, 'L', 180);
    expect(on.rows[1].cells['L'].weightG).toBe(180);
  });
});

/**
 * 从采集商品导入（2026-10-23）：产品只维护一套 SKU 矩阵，初始内容来自采集快照。
 * 合并口径 = **只补缺口**。下面每条都对应一种"覆盖会静默毁数据"的场景。
 */
describe('mergeSkuMatrix —— 采集快照并入产品矩阵（只补缺口）', () => {
  const base = () =>
    toSkuMatrix([
      { color: '黑', size: 'L', price: '', imageUrl: '', weightG: 320 },
      { color: '黑', size: 'M', price: '', imageUrl: '' },
    ]);
  /** 采集侧：`blue` 同色两张图（各 2 码），`red` 一图 */
  const collected = () =>
    toSkuMatrix([
      { color: '黑', size: 'L', price: 'US $1', imageUrl: 'col-a.jpg', weightG: 999 },
      { color: '黑', size: 'M', price: 'US $1', imageUrl: 'col-a.jpg', weightG: 150 },
      { color: '黑', size: 'XL', price: 'US $1', imageUrl: 'col-a.jpg', weightG: 170 },
      { color: '红', size: 'S', price: 'US $2', imageUrl: 'col-b.jpg', weightG: 180 },
      { color: '红', size: 'M', price: 'US $2', imageUrl: 'col-b.jpg' },
    ]);

  it('空产品矩阵 ⇒ 采集的全量进来（行序/列序 = 采集顺序）', () => {
    const { matrix, stats } = mergeSkuMatrix(toSkuMatrix([]), collected());
    expect(matrix.sizes).toEqual(['L', 'M', 'XL', 'S']);
    expect(matrix.rows.map((r) => r.color)).toEqual(['黑', '红']);
    expect(skuMatrixComboCount(matrix)).toBe(5);
    expect(stats).toEqual({ addedColors: 2, addedSizes: 4, addedCells: 5, filledWeights: 0, skipped: 0 });
  });

  it('⭐ 已有的格一个都不动（人核对过的克重比采集快照可信）', () => {
    const { matrix } = mergeSkuMatrix(base(), collected());
    const m = matrix.rows[0].cells['L'];
    expect(m.weightG).toBe(320);
    expect(m.price).toBe('');
  });

  it('⭐ 克重只补"没填"的格，且保留 variantId（填克重不是重建 SKU）', () => {
    const product = {
      sizes: ['L', 'M'],
      rows: [
        {
          key: 'color:黑',
          color: '黑',
          imageUrl: '',
          cells: {
            L: { price: '', weightG: 320, variantId: 11 },
            M: { price: '', weightG: 0, variantId: 12 },
          },
        },
      ],
    };
    const { matrix, stats } = mergeSkuMatrix(product, collected());
    expect(matrix.rows[0].cells['L'].weightG).toBe(320);
    expect(matrix.rows[0].cells['M'].weightG).toBe(150);
    expect(matrix.rows[0].cells['M'].variantId).toBe(12);
    expect(stats.filledWeights).toBe(1);
  });

  it('⭐ 新列只落在采集里真有这个组合的色上（导入不是补齐叉积）', () => {
    const { matrix } = mergeSkuMatrix(base(), collected());
    expect(matrix.sizes).toEqual(['L', 'M', 'XL', 'S']);
    const black = matrix.rows.find((r) => r.color === '黑')!;
    const red = matrix.rows.find((r) => r.color === '红')!;
    expect(Object.keys(black.cells).sort()).toEqual(['L', 'M', 'XL']);
    // 黑的新码不该凭空长到红那一行上
    expect(Object.keys(red.cells).sort()).toEqual(['M', 'S']);
    expect(Object.prototype.hasOwnProperty.call(black.cells, 'S')).toBe(false);
  });

  it('⭐ 采集侧同名不同图两行 ⇒ 产品侧合成一行（产品 SKU 按色名唯一）', () => {
    const twoImages = toSkuMatrix([
      { color: 'blue', size: 'L', price: '', imageUrl: 'a.jpg', weightG: 100 },
      { color: 'blue', size: 'M', price: '', imageUrl: 'b.jpg', weightG: 110 },
    ]);
    expect(twoImages.rows.length).toBe(2);
    const { matrix } = mergeSkuMatrix(toSkuMatrix([]), twoImages);
    expect(matrix.rows.length).toBe(1);
    expect(matrix.rows[0].cells['L'].weightG).toBe(100);
    expect(matrix.rows[0].cells['M'].weightG).toBe(110);
  });

  /* ── srcColor：并入那一刻的色名（保存时要把订单域色行一起改名，色图才跟得上）──
     2026-10-23 用户二次实报「保存以后图片还是丢失了」：并入的行在 pl_variants 里是**新建**，
     改色名后走 `creates`，而"原色名"只在并入那一刻存在 —— 不记下来，订单域色行就永远叫老名字，
     按新色名查图必然落空。 */
  it('⭐ 并入的新行记下当时的色名（srcColor），已在矩阵里的行不凭空多出这个字段', () => {
    const { matrix } = mergeSkuMatrix(base(), collected());
    const black = matrix.rows.find((r) => r.color === '黑')!;
    const red = matrix.rows.find((r) => r.color === '红')!;
    expect(red.srcColor).toBe('红'); // 新并入
    expect(black.srcColor).toBeUndefined(); // 原本就在（有 pl_variants.id，改名是原地改）
  });

  it('⭐ 改色名后 srcColor 不变（它记的是"并入时叫什么"，不是当前色名）', () => {
    const { matrix } = mergeSkuMatrix(base(), collected());
    // 等价于界面上的 v-model="r.color" 改一个字
    matrix.rows.find((r) => r.color === '红')!.color = '深红';
    const row = matrix.rows.find((r) => r.color === '深红')!;
    expect(row.srcColor).toBe('红');
    // 落 sku_json 时不带这个字段（采集快照的形状一个字节都不变）
    expect(Object.keys(toSkuJsonRow({ color: row.color, size: 'S', price: '', imageUrl: '', weightG: 0 })))
      .toEqual(['color', 'size', 'price', 'imageUrl']);
  });

  it('重复并入同一份采集不会覆盖已有行的 srcColor（先并入后改名，再导入不该退回原名）', () => {
    const first = mergeSkuMatrix(toSkuMatrix([]), collected());
    first.matrix.rows.find((r) => r.color === '红')!.color = '深红';
    const again = mergeSkuMatrix(first.matrix, collected());
    // 改过名的那一行仍是「深红」，它的 srcColor 还是当初那个名字，不会被这次导入刷成别的
    expect(again.matrix.rows.find((r) => r.color === '深红')!.srcColor).toBe('红');
  });

  it('缺色名 / 缺码名的采集行跳过并计数（产品 SKU 必须成对）', () => {
    const incoming = toSkuMatrix([
      { color: '', size: 'M', price: '', imageUrl: '' },
      { color: '黑', size: '', price: '', imageUrl: '' },
      { color: '黑', size: 'L', price: '', imageUrl: '' },
    ]);
    const { matrix, stats } = mergeSkuMatrix(toSkuMatrix([]), incoming);
    expect(stats.skipped).toBe(2);
    expect(matrix.rows.map((r) => r.color)).toEqual(['黑']);
    expect(skuMatrixComboCount(matrix)).toBe(1);
    // 被跳过那一格的码不能单独变成空列
    expect(matrix.sizes).toEqual(['L']);
  });

  it('⭐⭐ 幂等：同一份采集连并两次，第二次一个字都不改（返回原对象）', () => {
    const first = mergeSkuMatrix(base(), collected());
    const again = mergeSkuMatrix(first.matrix, collected());
    expect(again.matrix).toBe(first.matrix);
    expect(again.stats).toEqual({ addedColors: 0, addedSizes: 0, addedCells: 0, filledWeights: 0, skipped: 0 });
  });

  it('色名按 trim 后的**全等**对齐：空白差异算同色，大小写不同算两色', () => {
    const product = toSkuMatrix([{ color: '黑', size: 'L', price: '', imageUrl: '' }]);
    const same = mergeSkuMatrix(
      product,
      toSkuMatrix([{ color: '  黑  ', size: 'M', price: '', imageUrl: 'x.jpg' }]),
    );
    expect(same.stats.addedColors).toBe(0);
    expect(same.matrix.rows.length).toBe(1);
    const diff = mergeSkuMatrix(
      product,
      toSkuMatrix([{ color: 'BLACK', size: 'L', price: '', imageUrl: '' }]),
    );
    expect(diff.stats.addedColors).toBe(1);
    expect(diff.matrix.rows.length).toBe(2);
  });

  it('导入不搬价格 / 采集色图（产品行的图只来自订单域款色图）', () => {
    const { matrix } = mergeSkuMatrix(toSkuMatrix([]), collected());
    for (const r of matrix.rows) {
      expect(r.imageUrl).toBe('');
      for (const c of Object.values(r.cells)) expect(c.price).toBe('');
    }
    expect(fromSkuMatrix(matrix).every((r) => r.price === '')).toBe(true);
  });
});

describe('parseSkuJsonRows —— 渲染层唯一的解析点', () => {
  it('空串 / 非数组 / 坏 JSON ⇒ 空数组（历史损坏值不该让弹层打不开）', () => {
    expect(parseSkuJsonRows('')).toEqual([]);
    expect(parseSkuJsonRows('{}')).toEqual([]);
    expect(parseSkuJsonRows('not json')).toEqual([]);
    expect(parseSkuJsonRows(null)).toEqual([]);
  });

  it('⭐ 克重读回来（少了这一条，弹层里补的克重在下次打开时静默归零）', () => {
    const rows = parseSkuJsonRows(
      JSON.stringify([
        { color: '黑', size: 'L', price: '', imageUrl: 'i1', weightG: 88 },
        { color: '黑', size: 'M', price: '', imageUrl: 'i1' },
      ])
    );
    expect(rows.length).toBe(2);
    expect(rows[0].weightG).toBe(88);
    expect('weightG' in rows[1]).toBe(false);
    // 解析出来的形状能直接进矩阵，且来回转等值
    const m = toSkuMatrix(rows);
    expect(m.rows[0].cells['L'].weightG).toBe(88);
    expect(m.rows[0].cells['M'].weightG).toBe(0);
  });
});

/**
 * 产品侧（`pl_variants`）的格子里带 `variantId` —— 它是"改名 = 原地改 vs 删旧建新"的唯一判据。
 * 这些纯函数一旦在结构变更时把该字段甩掉，保存就会静默删掉旧 SKU（连同它的编码与状态）。
 * 采集侧不使用该字段（恒 undefined），所以这些用例只钉"搬动时保留"这一条。
 */
describe('variantId — 产品侧的行身份（改名不能丢）', () => {
  function productMatrix() {
    return {
      sizes: ['L', 'M'],
      rows: [
        {
          key: 'color:黑',
          color: '黑',
          imageUrl: '',
          cells: {
            L: { price: '', weightG: 320, variantId: 11 },
            M: { price: '', weightG: 0, variantId: 12 },
          },
        },
      ],
    };
  }

  it('⭐ 批量填克重保留每格的 variantId（填克重不是重建 SKU）', () => {
    const m = fillMatrixWeight(productMatrix(), 150);
    expect(m.rows[0].cells['L'].variantId).toBe(11);
    expect(m.rows[0].cells['M'].variantId).toBe(12);
  });

  it('⭐ 改尺码名把格连同 variantId 一起搬到新列（否则保存会先删后建）', () => {
    const m = renameMatrixSize(productMatrix(), 'M', 'XL');
    expect(m.sizes).toEqual(['L', 'XL']);
    expect(m.rows[0].cells['XL'].variantId).toBe(12);
    expect(m.rows[0].cells['M']).toBeUndefined();
  });

  it('取消一格再加回来 = 新组合，不带 variantId（这条路径本来就是删了重建）', () => {
    const off = toggleMatrixCell(productMatrix(), 0, 'M');
    expect(off.rows[0].cells['M']).toBeUndefined();
    const back = toggleMatrixCell(off, 0, 'M');
    expect(back.rows[0].cells['M'].variantId).toBeUndefined();
  });
});

/**
 * 拖色合并（2026-10-24 用户口径「通过拖动颜色方式来合并」）。
 *
 * 为什么这条纯函数值得单测：合并是**唯一一条能把两行数据并成一行**的路。
 * 写错它的代价分两种，都不报错：① 搬格时新建了格对象（丢了 `variantId`）⇒ 保存走"删旧建新"，
 * 那一批 SKU 的编码与状态静默清空；② 同码冲突时盲目以源为准 ⇒ 目标侧已经核对过的克重被覆盖。
 */
describe('mergeMatrixColor —— 拖色合并（并进目标行，格连同 variantId 一起搬）', () => {
  // 显式标 `SkuMatrix`：不标的话字面量会把 cells 收成"只有 L/M 两个 key"，
  // 后面 `rows.push` 一个带 S 的行就变成类型不兼容（vue-tsc 会红，vitest 却照样绿）
  function twoColors(): SkuMatrix {
    return {
      sizes: ['L', 'M'],
      rows: [
        {
          key: 'color:黑',
          color: '黑',
          imageUrl: '',
          cells: {
            L: { price: '', weightG: 320, variantId: 11 },
            M: { price: '', weightG: 0, variantId: 12 },
          },
        },
        {
          key: 'color:红',
          color: '红',
          imageUrl: '',
          cells: {
            M: { price: '', weightG: 250 },
            S: { price: '', weightG: 180 },
          },
        },
      ],
    };
  }

  it('⭐ 搬进目标行：源独有的码跟着走、没落库的列补进 sizes、行只留一行', () => {
    const res = mergeMatrixColor(twoColors(), 1, 0);
    expect(res.matrix.rows.length).toBe(1);
    expect(res.matrix.rows[0].color).toBe('黑');
    // S 只存在于源行、且不是矩阵的列 —— 必须补进列，否则展开时那一格会被静默丢掉
    expect(res.matrix.sizes).toEqual(['L', 'M', 'S']);
    expect(res.matrix.rows[0].cells['S'].weightG).toBe(180);
    expect(res.moved).toBe(1);
    expect(res.conflicts).toBe(1);
  });

  it('⭐ 搬过来的格保留 variantId（合并 ≠ 删了重建：编码与状态要跟着走）', () => {
    const res = mergeMatrixColor(twoColors(), 1, 0);
    expect(res.matrix.rows[0].cells['L'].variantId).toBe(11);
    // 同码冲突那一格保留**目标行**的 id（活下来的是它），只是把源行量过的克重带过来
    expect(res.matrix.rows[0].cells['M'].variantId).toBe(12);
    expect(res.matrix.rows[0].cells['M'].weightG).toBe(250);
  });

  it('⭐ 搬过去的那一格自己带的 variantId 也要跟着走（源行也可能是已落库的色）', () => {
    const m = twoColors();
    m.rows[1].cells['S'] = { price: '', weightG: 180, variantId: 77 };
    const res = mergeMatrixColor(m, 1, 0);
    expect(res.matrix.rows[0].cells['S'].variantId).toBe(77);
  });

  it('同码冲突时若目标已有克重 ⇒ 以目标为准（合并不能把核对过的值改掉）', () => {
    const m = twoColors();
    m.rows[1].cells['L'] = { price: '', weightG: 999 };
    const res = mergeMatrixColor(m, 1, 0);
    expect(res.matrix.rows[0].cells['L'].weightG).toBe(320);
  });

  it('目标行没图时取源行的图（只影响显示，不参与落库）', () => {
    const m = twoColors();
    m.rows[1].imageUrl = '/tmp/red.png';
    expect(mergeMatrixColor(m, 1, 0).matrix.rows[0].imageUrl).toBe('/tmp/red.png');
    m.rows[0].imageUrl = '/tmp/black.png';
    expect(mergeMatrixColor(m, 1, 0).matrix.rows[0].imageUrl).toBe('/tmp/black.png');
  });

  it('行序不变，且展开后没有 SKU 凭空消失（合并前 6 条 → 合并后 5 条，只少同码那一条）', () => {
    const m = twoColors();
    // 白 与 红 在 M 上撞码：合并必然少一条 SKU —— 少的只能是"同码的那条"，别的都不许少
    m.rows.push({
      key: 'color:白',
      color: '白',
      imageUrl: '',
      cells: { L: { price: '', weightG: 100 }, M: { price: '', weightG: 120 } },
    });
    // ⚠️ S 必须是矩阵的列：`fromSkuMatrix` 只按 `sizes` 展开，"格在但列不在"本来就会被静默丢掉
    //    （这也是 `mergeMatrixColor` 要补列的原因）
    m.sizes.push('S');
    expect(fromSkuMatrix(m).length).toBe(6);
    const res = mergeMatrixColor(m, 1, 2); // 红 并进 白
    expect(res.matrix.rows.map((r) => r.color)).toEqual(['黑', '白']);
    expect(res.conflicts).toBe(1);
    // 5 = 黑 2 + 白 3（L 原有 · M 冲突保留 · S 搬过来）
    expect(fromSkuMatrix(res.matrix).length).toBe(5);
  });

  it('自己并自己 / 越界 ⇒ 返回原引用（界面据此判断"什么都没发生"，不会白多一处待保存）', () => {
    const m = twoColors();
    expect(mergeMatrixColor(m, 0, 0).matrix).toBe(m);
    expect(mergeMatrixColor(m, 5, 0).matrix).toBe(m);
    expect(mergeMatrixColor(m, 0, 5).matrix).toBe(m);
    expect(mergeMatrixColor(m, -1, 0).matrix).toBe(m);
  });

  it('⭐ 目标是**未落库**的空白行 ⇒ 接过源格的 id（同一组合不许删旧建新）', () => {
    const m = twoColors();
    // 目标行（黑）这一格还没落库（模拟"刚点常用色加出来的新行"）
    m.rows[0].cells['L'] = { price: '', weightG: 0 };
    m.rows[1].cells['L'] = { price: '', weightG: 0, variantId: 21 };
    const res = mergeMatrixColor(m, 1, 0);
    expect(res.matrix.rows[0].cells['L'].variantId).toBe(21);
    // 没有 SKU 真的消失 ⇒ 界面不能说"少 1 个 SKU"
    expect(res.dropped).toBe(0);
  });

  it('两边都已落库 ⇒ dropped 数出真正少掉的 SKU（这跟"同码冲突数"不是一回事）', () => {
    const m = twoColors();
    m.rows[1].cells['L'] = { price: '', weightG: 0, variantId: 21 };
    const res = mergeMatrixColor(m, 1, 0);
    // 撞码的有两格：L（两边都有 id）与 M（源侧还没落库）⇒ 冲突 2、真的少 1
    expect(res.conflicts).toBe(2);
    expect(res.dropped).toBe(1);
  });
});

describe('classifyMatrixColor —— 拖到「常用色」上归类（落库以常用色为准）', () => {
  // 采集来的两种说法：`藏蓝`（非标准名）与 `藏青`（标准名），各带一张色图
  function navy(): SkuMatrix {
    return {
      sizes: ['L', 'M'],
      rows: [
        {
          key: 'img:a\u0001藏蓝',
          color: '藏蓝',
          imageUrl: '/tmp/blue.png',
          cells: {
            L: { price: '', weightG: 0, variantId: 31 },
            M: { price: '', weightG: 250, variantId: 32 },
          },
        },
        {
          key: 'img:b\u0001藏青',
          color: '藏青',
          imageUrl: '/tmp/navy.png',
          cells: {
            L: { price: '', weightG: 310, variantId: 33 },
            S: { price: '', weightG: 180, variantId: 34 },
          },
        },
      ],
    };
  }

  it('⭐ 常用色不在矩阵里 ⇒ **原地改名**（格、variantId、色图一个都不动）', () => {
    const m = navy();
    // 只留 `藏蓝` 这一行：目标色 藏青 不在矩阵里
    const solo: SkuMatrix = { sizes: m.sizes, rows: [m.rows[0]] };
    const r2 = classifyMatrixColor(solo, 0, '藏青');
    expect(r2.merged).toBe(false);
    expect(r2.matrix.rows.length).toBe(1);
    expect(r2.matrix.rows[0].color).toBe('藏青');
    expect(r2.matrix.rows[0].imageUrl).toBe('/tmp/blue.png');
    expect(r2.matrix.rows[0].cells['L'].variantId).toBe(31);
    expect(r2.matrix.rows[0].cells['M'].weightG).toBe(250);
    expect(r2.fromColor).toBe('藏蓝');
    // 行 key 跟着新色名走（否则同图不同名的两行会被当成同一行）
    expect(r2.matrix.rows[0].key).toBe(skuRowKey('/tmp/blue.png', '藏青'));
    // 原矩阵不变（纯函数）
    expect(solo.rows[0].color).toBe('藏蓝');
  });

  it('⭐ 常用色已在矩阵里 ⇒ 并进那一行（行少一条、格与 id 跟着走）', () => {
    const res = classifyMatrixColor(navy(), 0, '藏青');
    expect(res.merged).toBe(true);
    expect(res.matrix.rows.length).toBe(1);
    expect(res.matrix.rows[0].color).toBe('藏青');
    // 藏蓝 的 M 搬过来（藏青 没有 M），L 撞码 ⇒ 以 藏青 为准
    expect(res.moved).toBe(1);
    expect(res.conflicts).toBe(1);
    expect(res.matrix.rows[0].cells['M'].variantId).toBe(32);
    expect(res.matrix.rows[0].cells['M'].weightG).toBe(250);
    expect(res.matrix.rows[0].cells['L'].variantId).toBe(33);
    expect(res.matrix.rows[0].cells['L'].weightG).toBe(310);
    // 源行的 S 也要进列，否则展开时静默丢一条 SKU
    expect(res.matrix.sizes).toContain('S');
  });

  it('⭐ 一个色只留一张图：合并后目标行仍是 1 张图（优先目标行自己的）', () => {
    const res = classifyMatrixColor(navy(), 0, '藏青');
    expect(res.matrix.rows[0].imageUrl).toBe('/tmp/navy.png');
    // 目标行没图时才用源行的 —— 但无论如何只有一张
    const m = navy();
    m.rows[1].imageUrl = '';
    expect(classifyMatrixColor(m, 0, '藏青').matrix.rows[0].imageUrl).toBe('/tmp/blue.png');
  });

  it('源行在目标行后面时也改对行（合并后下标前移一位，容易改错邻居）', () => {
    const m = navy();
    // 把两行顺序倒过来：藏青在前、藏蓝在后，拖后者去归类
    const swapped: SkuMatrix = { sizes: m.sizes, rows: [m.rows[1], m.rows[0]] };
    const res = classifyMatrixColor(swapped, 1, '藏青');
    expect(res.matrix.rows.length).toBe(1);
    expect(res.matrix.rows[0].color).toBe('藏青');
    expect(res.matrix.rows[0].cells['M'].weightG).toBe(250);
  });

  it('名字已经就是这个常用色 / 空名 / 越界 ⇒ 返回原引用（不产生"待保存"）', () => {
    const m = navy();
    expect(classifyMatrixColor(m, 1, '藏青').matrix).toBe(m);
    expect(classifyMatrixColor(m, 0, '  藏蓝  ').matrix).toBe(m); // 去空白后同名
    expect(classifyMatrixColor(m, 0, '').matrix).toBe(m);
    expect(classifyMatrixColor(m, 9, '藏青').matrix).toBe(m);
    expect(classifyMatrixColor(m, -1, '藏青').matrix).toBe(m);
  });

  it('落库色名的判据与「常用色打勾」同一个：去空白后同名 = 已经归好，拖上去不产生待保存', () => {
    const m = navy();
    const spaced: SkuMatrix = {
      sizes: m.sizes,
      rows: [{ ...m.rows[1], color: '藏青 ' }],
    };
    // 打勾的判据也是 trim 后的全等（`hasColor`），两边必须是同一个 —— 否则会出现
    // "打了勾，拖上去却改了名" 这种自相矛盾的状态
    expect(classifyMatrixColor(spaced, 0, '藏青').matrix).toBe(spaced);
    expect(classifyMatrixColor(spaced, 0, '  藏青').matrix).toBe(spaced);
  });
});
