// orderRowSplitter 单测 —— "一订单多产品"拆行：拆错会造成订单数量与产品行数不一致，
// 且缺图产品必须保留空图记录（否则用户永远看不到需要补图的那一条）。
import { describe, it, expect } from 'vitest';
import {
  detectMultiProductColumns,
  expandOrderRow,
  expandOrderRows,
  parseRowQty,
  type MultiProductColumns,
} from '../src/lib/orderRowSplitter';

const cols: MultiProductColumns = {
  count: '产品数量',
  image: '产品图片链接',
  productId: '产品ID',
  size: '尺寸',
  info: '产品信息',
};

describe('detectMultiProductColumns', () => {
  const headers = ['订单号', '产品数量', '产品图片链接', '产品ID', '尺寸', '产品信息'];

  it('数量列需要样本里存在 2..50 的整数，否则不认定为多产品结构', () => {
    const rows = [{ 产品数量: '1' }];
    expect(detectMultiProductColumns(headers, rows, { imageColumn: '产品图片链接' })).toBeNull();
  });

  it('命中多产品结构时返回各列（含已探测的主图/尺寸列）', () => {
    const rows = [{ 产品数量: '3', 产品信息: '【1】x' }];
    const got = detectMultiProductColumns(headers, rows, {
      imageColumn: '产品图片链接',
      sizeColumn: '尺寸',
    });
    expect(got).toEqual({
      count: '产品数量',
      image: '产品图片链接',
      productId: '产品ID',
      size: '尺寸',
      info: '产品信息',
    });
  });

  it('产品信息列需样本含「【」块结构才被采用', () => {
    const rows = [{ 产品数量: '2', 产品信息: '无块结构' }];
    const got = detectMultiProductColumns(headers, rows, { imageColumn: '产品图片链接' });
    expect(got?.info).toBe('');
  });

  it('订单号这类长数字不会被误判成数量列', () => {
    const rows = [{ 产品数量: '202408241234567890' }];
    expect(detectMultiProductColumns(headers, rows, {})).toBeNull();
  });
});

describe('expandOrderRow', () => {
  it('数量 <= 1 时原样返回单行', () => {
    const fields = { 产品数量: '1', 订单号: 'SO-1' };
    const r = expandOrderRow(fields, cols);
    expect(r.rows).toEqual([fields]);
    expect(r.missingImage).toBe(false);
  });

  it('按索引对齐拆分多值列，订单级字段原样复制', () => {
    const r = expandOrderRow(
      {
        订单号: 'SO-1',
        产品数量: '3',
        产品图片链接: 'a.jpg\nb.jpg;c.jpg',
        产品ID: 'p1;p2;p3',
        尺寸: 'S,M,L',
        产品信息: '【1】Size: S 【2】Size: M 【3】Size: L',
      },
      cols,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map((x) => x.产品图片链接)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(r.rows.map((x) => x.产品ID)).toEqual(['p1', 'p2', 'p3']);
    expect(r.rows.map((x) => x.尺寸)).toEqual(['S', 'M', 'L']);
    expect(r.rows.every((x) => x.订单号 === 'SO-1')).toBe(true);
    expect(r.missingImage).toBe(false);
  });

  it('图片数量不足 N：缺图行保留空图片并置 missingImage', () => {
    const r = expandOrderRow({ 产品数量: '3', 产品图片链接: 'a.jpg' }, cols);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map((x) => x.产品图片链接)).toEqual(['a.jpg', '', '']);
    expect(r.missingImage).toBe(true);
  });

  it('单值列（只有 1 个 ID / 尺寸）广播到每一行', () => {
    const r = expandOrderRow({ 产品数量: '2', 产品图片链接: 'a.jpg;b.jpg', 产品ID: 'p1', 尺寸: '均码' }, cols);
    expect(r.rows.map((x) => x.产品ID)).toEqual(['p1', 'p1']);
    expect(r.rows.map((x) => x.尺寸)).toEqual(['均码', '均码']);
  });

  it('尺寸缺失时从产品信息块内 Size 兜底', () => {
    const r = expandOrderRow(
      { 产品数量: '2', 产品图片链接: 'a.jpg;b.jpg', 产品信息: '【1】Size: XL 【2】尺寸：XXL' },
      cols,
    );
    expect(r.rows.map((x) => x.尺寸)).toEqual(['XL', 'XXL']);
  });

  it('产品信息块数与 N 一致时，块文本按行写入', () => {
    const r = expandOrderRow(
      { 产品数量: '2', 产品图片链接: 'a.jpg;b.jpg', 产品信息: '【1】红色 【2】蓝色' },
      cols,
    );
    expect(r.rows.map((x) => x.产品信息)).toEqual(['红色', '蓝色']);
  });

  it('数量非数字时按 1 处理；超过 50 时被截断到 50（防爆量）', () => {
    expect(expandOrderRow({ 产品数量: 'abc' }, cols).rows).toHaveLength(1);
    expect(expandOrderRow({ 产品数量: '999' }, cols).rows).toHaveLength(50);
    expect(expandOrderRow({ 产品数量: '0' }, cols).rows).toHaveLength(1);
  });

  it('拆分出的行是独立副本（不再与原行共享引用）', () => {
    const fields = { 产品数量: '2', 产品图片链接: 'a.jpg;b.jpg' };
    const r = expandOrderRow(fields, cols);
    r.rows[0].产品图片链接 = 'changed';
    expect(fields.产品图片链接).toBe('a.jpg;b.jpg');
  });
});

describe('expandOrderRows', () => {
  it('cols 为 null 时原样返回，统计为 0', () => {
    const rows = [{ 产品数量: '3' }];
    expect(expandOrderRows(rows, null)).toEqual({ rows, expanded: 0, missingImageCount: 0 });
  });

  it('累计统计被拆分的订单行数与缺图产品数', () => {
    const r = expandOrderRows(
      [
        { 产品数量: '2', 产品图片链接: 'a.jpg;b.jpg' },
        { 产品数量: '1', 产品图片链接: 'c.jpg' },
        { 产品数量: '2', 产品图片链接: 'd.jpg' },
      ],
      cols,
    );
    expect(r.rows).toHaveLength(2 + 1 + 2);
    expect(r.expanded).toBe(2);
    expect(r.missingImageCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────── 速卖通订单报表式（无「数量」列）
//
// 真实样本（2026-09-29，47 列 / 1722 行）：**没有数量列**，多商品行把商品ID 用**逗号**并列
// （`1005...,1005...`），商品信息里带 `【1】…【2】…` 块，订单级金额只有一条。
// 旧实现要求存在数量列 → 这类报表**完全不拆**，且 `A,B` 会被当成一个假商品ID 入库（全程无告警）。
describe('速卖通式：无数量列时按【N】块 / 逗号商品ID 兜底', () => {
  const headers = ['订单号', '商品 ID', '商品信息', '收货国家', '订单金额'];
  const au = { ...cols, count: '', image: '', productId: '商品 ID', size: '', info: '商品信息' };

  it('识别：无数量列但有【N】块（≥2）→ 认定为多产品结构，count 为空串', () => {
    const rows = [{ 商品信息: '【1】A\n【2】B' }];
    const got = detectMultiProductColumns(headers, rows, {});
    expect(got).not.toBeNull();
    expect(got?.count).toBe('');
    expect(got?.productId).toBe('商品 ID');
    expect(got?.info).toBe('商品信息');
  });

  it('识别：无数量列、无【】块，但商品ID 逗号并列 → 也认定为多产品结构', () => {
    const rows = [{ '商品 ID': '111,222' }];
    expect(detectMultiProductColumns(headers, rows, {})).not.toBeNull();
  });

  it('识别：两条信号都没有（单商品行）→ null（保持既有行为，不误判）', () => {
    const rows = [{ 商品信息: '【1】A', '商品 ID': '111' }];
    expect(detectMultiProductColumns(headers, rows, {})).toBeNull();
  });

  it('拆分：逗号分隔的商品ID 按序切开，【N】块与订单级字段各自就位', () => {
    const row = {
      订单号: 'NO1',
      '商品 ID': '111,222',
      商品信息: '【1】AAA\n(商品数量:1 piece)\n【2】BBB\n(商品数量:1 piece)',
      收货国家: 'Latvia',
      订单金额: 'CN￥ 165.18',
    };
    const r = expandOrderRow(row, au);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x['商品 ID'])).toEqual(['111', '222']);
    expect(r.rows[0]['商品信息']).toBe('AAA\n(商品数量:1 piece)');
    expect(r.rows[1]['商品信息']).toBe('BBB\n(商品数量:1 piece)');
    // 订单级字段原样复制（金额只有一条，不摊到行上）
    expect(r.rows.map((x) => x['订单金额'])).toEqual(['CN￥ 165.18', 'CN￥ 165.18']);
    expect(r.rows.map((x) => x['订单号'])).toEqual(['NO1', 'NO1']);
  });

  it('拆分：只有【1】的单商品行原样返回（不产生额外行）', () => {
    const row = { '商品 ID': '111', 商品信息: '【1】AAA', 订单号: 'NO1' };
    const r = expandOrderRow(row, au);
    expect(r.rows).toEqual([row]);
  });

  it('拆分：块数与商品ID 数不一致时按较大值拆，多出的行留空（留给人看见）', () => {
    const row = { '商品 ID': '111,222', 商品信息: '【1】A\n【2】B\n【3】C' };
    const r = expandOrderRow(row, au);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map((x) => x['商品 ID'])).toEqual(['111', '222', '']);
  });

  it('同时有数量列时以数量列为准（芒果店长式行为不变）', () => {
    const both = { ...au, count: '产品数量', productId: '商品 ID', info: '商品信息' };
    const row = { 产品数量: '2', '商品 ID': '111,222,333', 商品信息: '【1】A\n【2】B\n【3】C' };
    expect(expandOrderRow(row, both).rows).toHaveLength(2);
  });

  it('拆分：没有图片列时不判缺图（不凭空制造待补图）', () => {
    const row = { '商品 ID': '111,222', 商品信息: '【1】A\n【2】B' };
    const r = expandOrderRow(row, au);
    expect(r.rows).toHaveLength(2);
    expect(r.missingImage).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────── 件数提取（`parseRowQty`）
//
// 件数决定拣货单"要拣几件"，也决定订单利润页的「缺件数」缺口。它**必须来自这一行自己的块**：
// 用「数量」列会把 N 件拆出的每行都按 N 件算（splitter 不清空该列），用多块原文则无从判定是哪一件。
describe('parseRowQty：件数只认这一行自己的商品信息块', () => {
  const block = (qty: number, note = '') =>
    `【1】 某款外套 (产品属性:Color:5、Size:XXL、Ships From:China Mainland)\n(商品数量:${qty} piece)${note}`;

  it('单块 + 商品数量 → 取到（速卖通实测写法）', () => {
    expect(parseRowQty({ 商品信息: block(1) })).toBe(1);
    expect(parseRowQty({ 商品信息: block(2) })).toBe(2);
    expect(parseRowQty({ 产品信息: block(3) })).toBe(3);
  });

  it('块数与商品数不一致时留下的**多块原文** → null（不猜是哪一件）', () => {
    expect(parseRowQty({ 商品信息: `【1】A\n(商品数量:2 piece)\n【2】B\n(商品数量:3 piece)` })).toBeNull();
  });

  it('IOSS 标记不算块（`【AE IOSS/IM...】` 不是 `【数字】`）', () => {
    expect(parseRowQty({ 商品信息: block(2, '\n【AE IOSS/IM5280002556】') })).toBe(2);
  });

  it('无该列 / 列内无数量 / 数量为 0 → null（不是 1：1 是兜底值，由调用方给）', () => {
    expect(parseRowQty({ 商品ID: 'ITEM1' })).toBeNull();
    expect(parseRowQty({ 商品信息: '【1】 某款外套 (产品属性:Size:XL)' })).toBeNull();
    expect(parseRowQty({ 商品信息: '【1】 某款外套 (商品数量:0 piece)' })).toBeNull();
    expect(parseRowQty(null)).toBeNull();
  });

  it('件数荒谬（超上限）→ null（宁可按取不到处理，别给拣货单一个荒谬数字）', () => {
    expect(parseRowQty({ 商品信息: block(1000) })).toBeNull();
    expect(parseRowQty({ 商品信息: block(999) })).toBe(999);
  });

  it('**不用**「数量」列：拆行后它仍是整行的值（照搬会把 3 件拆出的每行都按 3 件算）', () => {
    expect(parseRowQty({ 数量: '3', 商品信息: block(1) })).toBe(1);
  });
});
