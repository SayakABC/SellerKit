// orderRowSplitter 单测 —— "一订单多产品"拆行：拆错会造成订单数量与产品行数不一致，
// 且缺图产品必须保留空图记录（否则用户永远看不到需要补图的那一条）。
import { describe, it, expect } from 'vitest';
import {
  detectMultiProductColumns,
  expandOrderRow,
  expandOrderRows,
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
