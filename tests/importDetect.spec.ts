// 「这份 Excel 是什么」纯检测层的契约用例（`src/lib/importDetect.ts`）。
//
// 为什么值得单测：判错会把整份文件导进**错的表** —— 用户看到的只是"导完了、数字不对"，
// 而这类错没有异常、没有日志。所以钉住两件事：① 每类文件的判据；② **判定顺序**（从具体到宽泛，
// "既是订单报表又含结算表"的混合文件必须落到更具体的那个）；③ 判不出时必须**扫过哪些表**能说出来。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { detectImportKind, gridToRecords, type SheetGrid } from '../src/lib/importDetect';

/** 结算明细（AE 后台导出）：商品级那张同时有 商品id 与 结算状态 */
const SETTLE: SheetGrid = {
  name: '订单商品明细_1',
  grid: [
    ['订单号', '商品id', 'sku id', '商品数量', '成交金额', '结算状态'],
    ['8214556439417537', '1005012244700397', '12000057838127422', '1', '87.15', '已结算'],
  ],
};

/** 订单报表（47 列报表签名）：订单号 + 订单金额/商品信息 */
const ORDERS: SheetGrid = {
  name: 'sheet1',
  grid: [
    ['订单号', '订单状态', '订单金额', '商品 ID', '商品信息', '收货国家'],
    ['3076475435222658', '等待发货', 'CN￥ 165.18', '1005011764572483', '【1】 某款 (商品数量:1 piece)', 'United States'],
  ],
};

/**
 * 「商品信息」表（商品ID + 重量）—— **不再是可导入类型**（2026-10-01 用户领域裁定：
 * 克重是 SKU 属性，商品ID 上没有克重）。它现在的作用只有一个：检测层认出来后给一句**指路**。
 */
const WEIGHTS: SheetGrid = {
  name: '商品信息',
  grid: [
    ['商品ID', '产品名称', '重量(g)'],
    ['1005011764572483', '某款外套', '320'],
  ],
};

/** 真实报价单夹具（21 张表的工作簿里那张目标表） */
function rateGrids(): SheetGrid[] {
  const buf = readFileSync(new URL('./fixtures/shipping-rate.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  return (wb.SheetNames as string[]).map((name) => ({
    name,
    grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][],
  }));
}

describe('detectImportKind：三类文件的判据', () => {
  it('结算明细（商品id + 结算状态）', () => {
    const d = detectImportKind([SETTLE, ORDERS, WEIGHTS]);
    expect(d.kind).toBe('settle');
    if (d.kind) expect(d.why).toContain('结算状态');
  });

  it('订单报表（订单号 + 订单金额/商品信息）', () => {
    const d = detectImportKind([ORDERS]);
    expect(d.kind).toBe('orders');
    if (d.kind) expect(d.why).toContain('订单号');
  });

  it('「商品信息」表不再可导入：判不出类型，但要给一句人话指路（别只说"认不出"）', () => {
    const d = detectImportKind([WEIGHTS]);
    expect(d.kind).toBeNull();
    // 体检串里必须写明"这类文件不用再导入 + 克重去哪维护"，否则用户会以为是自己文件坏了
    const hint = (d.kind === null ? d.scanned : []).join('；');
    expect(hint).toContain('不用再导入');
    // 2026-10-17：「货与成本」并入「基础数据」的左导航项 ⇒ 指路名跟着改；
    // 同日深夜该组按用户口径改名「产品管理」。
    expect(hint).toContain('产品管理');
  });

  it('报价单（真实夹具：21 张表里认出运价表那张）', () => {
    const d = detectImportKind(rateGrids());
    expect(d.kind).toBe('rates');
    if (d.kind) expect(d.why).toContain('国家');
  });
});

describe('detectImportKind：判定顺序与兜底', () => {
  it('混合文件：含结算表时**判结算**（具体优先于宽泛），与表顺序无关', () => {
    for (const sheets of [
      [ORDERS, SETTLE],
      [SETTLE, ORDERS],
    ]) {
      const d = detectImportKind(sheets);
      expect(d.kind).toBe('settle');
    }
  });

  it('都不是 → kind=null，并把**逐张体检**的理由带出来（不只说"认不出"）', () => {
    const d = detectImportKind([
      { name: '乱七八糟', grid: [['foo', 'bar'], ['1', '2']] },
    ]);
    expect(d.kind).toBeNull();
    expect(d.scanned.length).toBeGreaterThan(0);
    expect(d.scanned.join(' ')).toContain('乱七八糟');
  });

  it('空工作簿 / null 不炸', () => {
    expect(detectImportKind([]).kind).toBeNull();
    expect(detectImportKind(null).kind).toBeNull();
  });
});

describe('gridToRecords', () => {
  it('表头做键、其余逐行成对象（与既有解析器同形状）', () => {
    const rows = gridToRecords([
      ['订单号', '商品id'],
      ['A1', '1001'],
      ['A2', '1002'],
    ]);
    expect(rows).toEqual([
      { 订单号: 'A1', 商品id: '1001' },
      { 订单号: 'A2', 商品id: '1002' },
    ]);
  });

  it('缺列补空串（不对齐的行也成对象，不丢行）', () => {
    expect(gridToRecords([['a', 'b'], ['1']])).toEqual([{ a: '1', b: '' }]);
  });
});