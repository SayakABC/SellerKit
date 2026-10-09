// 产品库 Excel 导入的解析与校验单测（src/lib/productImport.ts）。
//
// 为什么这个文件值得单独测：产品导入的**每一个**错误都会静默落成"看起来正常"的数据 ——
// 列认错 → 编码列读成了克重；厂家名对不上 → 成本挂到空厂家；状态认错 → 产品被停用；
// 尺码与克重错位 → 每个 SKU 的克重都是别人的。界面上一律只显示"导入成功 490 行"。
//
// ⚠️ 厂商名的匹配刻意**只做精确比对**（去空白 + 忽略大小写）。若哪天有人加了"模糊匹配"，
//    下面「厂家名对不上要报 warning 且落 0」那条必须仍然为真 —— 否则会把成本挂到别人账上。
//
// ⚠️ 「尺码 / 克重 按顺序对应」是本轮唯一靠**下标**成立的规则。它的守卫必须用
//    **两串长度不同**的输入（1 個尺码 / 2 个克重），否则"顺序"这件事根本没被测到。
import { describe, it, expect } from 'vitest';
import {
  attachExtractedImages,
  parseProductRows,
  validateImportRows,
  parseSkuCells,
  parseStatusText,
  buildProductSheet,
  buildProductSheetLayout,
  PRODUCT_EXPORT_HEADERS,
  type SupplierRef,
} from '../src/lib/productImport';

const SUPPLIERS: SupplierRef[] = [
  { id: 7, name: '深圳明辉' },
  { id: 9, name: 'Yiwu Star' },
];

/** 老版 6 列表头（含「类目」）—— 用户手上存量文件的形态，必须继续能读 */
const HEAD_OLD = ['款编码', '款式名', '厂家', '类目', '状态', '备注'];

/** 新版 9 列表头 */
const HEAD = [
  '款编码',
  '款式名',
  '供应商',
  '图片',
  '颜色',
  '尺码',
  '克重',
  '状态',
  '备注',
];

/** 只取可入库的行（便于断言"真正会进库的是什么"） */
const okRows = (r: ReturnType<typeof parseProductRows>) => r.rows.filter((x) => x.ok);

/** 取某行的全部 issue 文案（拼接，便于 contains 断言） */
const msgs = (r: ReturnType<typeof parseProductRows>, rowNo: number) =>
  r.issues
    .filter((x) => x.rowNo === rowNo)
    .map((x) => x.message)
    .join(' | ');

describe('parseProductRows · 表头定位与列匹配', () => {
  it('首行是导出横幅时，表头行往下探测到第 3 行', () => {
    const r = parseProductRows(
      [
        ['产品库导出', '', '', '', '', ''],
        ['导出时间：2026-09-27', '', '', '', '', ''],
        HEAD_OLD,
        ['P-001', '折叠收纳箱', '深圳明辉', '家居', '启用', ''],
      ],
      SUPPLIERS,
    );
    expect(r.headerRow).toBe(2);
    expect(r.columns.code).toBe(0);
    expect(r.columns.name).toBe(1);
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0]).toMatchObject({ code: 'P-001', name: '折叠收纳箱', supplierId: 7 });
  });

  it('表头带必填星号与括号注记也能命中（速卖通导出风格）', () => {
    const r = parseProductRows(
      [
        ['*款编码', '*款式名（中文）', '厂家', '类目', '状态', '备注'],
        ['P-002', '收纳袋', '深圳明辉', '家居', '停用', ''],
      ],
      SUPPLIERS,
    );
    expect(r.headerRow).toBe(0);
    expect(okRows(r)[0]).toMatchObject({ code: 'P-002', status: 'archived', supplierId: 7 });
  });

  it('列名同义族：产品编码 / 商品名称 也算数', () => {
    const r = parseProductRows(
      [
        ['产品编码', '商品名称', '供应商', '品类', 'status', 'note'],
        ['P-003', '挂钩', 'Yiwu Star', '五金', 'active', '样例'],
      ],
      SUPPLIERS,
    );
    expect(r.columns.code).toBe(0);
    expect(r.columns.name).toBe(1);
    expect(okRows(r)[0]).toMatchObject({ supplierId: 9, status: 'active', note: '样例' });
  });

  it('「类目」列不再匹配任何族 —— 被安全忽略，不报错也不占位', () => {
    // 这是"去列"的正确形态：老文件里那一列当成不存在，而不是"认不出来就报错"。
    const r = parseProductRows([HEAD_OLD, ['P-001', 'A', '', '家居', '', '']], SUPPLIERS);
    expect(r.issues).toEqual([]);
    expect(r.headerRow).toBe(0);
    // 类目没有对应的列字段了 —— 类型上就不存在，这里断言的是"没有因此产生任何问题"
    expect(okRows(r)[0].code).toBe('P-001');
  });

  it('新版 9 列：图片 / 颜色 / 尺码 / 克重 四列都能对上', () => {
    const r = parseProductRows([HEAD, ['P-001', 'A', '', '', '红', 'M,L', '120,130', '', '']], SUPPLIERS);
    expect(r.columns.image).toBe(3);
    expect(r.columns.color).toBe(4);
    expect(r.columns.size).toBe(5);
    expect(r.columns.weight).toBe(6);
    expect(okRows(r)[0].skus).toEqual([
      { color: '红', size: 'M', weightG: 120 },
      { color: '红', size: 'L', weightG: 130 },
    ]);
  });

  it('列顺序无关：名称列排在编码列前面也能对上（按语义扫描，不按列号）', () => {
    const r = parseProductRows(
      [
        ['备注', '款式名', '款编码', '厂家'],
        ['有货', '收纳箱', 'P-005', '深圳明辉'],
      ],
      SUPPLIERS,
    );
    expect(r.columns.code).toBe(2);
    expect(r.columns.name).toBe(1);
    expect(r.columns.note).toBe(0);
    expect(okRows(r)[0]).toMatchObject({ code: 'P-005', name: '收纳箱', supplierId: 7 });
  });

  it('「规格」列**不算**尺码（本仓「规格」= 整个 SKU，含颜色+尺码）', () => {
    // 收进来的话，`红-M` 这种整串会被当成尺码，然后与克重错位对应。
    const r = parseProductRows(
      [
        ['款编码', '款式名', '规格', '克重'],
        ['P-001', 'A', '红-M', '120'],
      ],
      SUPPLIERS,
    );
    expect(r.columns.size).toBe(-1);
    expect(r.columns.weight).toBe(3);
    // 没有尺码列 ⇒ 只有克重 ⇒ 明确报错（而不是把「红-M」当尺码悄悄建一个 SKU）
    expect(okRows(r)).toEqual([]);
    expect(msgs(r, 2)).toContain('没填尺码');
  });

  it('只有编码列、没有名称列 → 不算产品表（headerRow = -1）', () => {
    // 判据是**同时**认出编码列与名称列：只认编码会把「编码说明」这类说明行当成表头。
    const r = parseProductRows(
      [
        ['编码', '说明'],
        ['P-001', '这里是填写说明'],
      ],
      SUPPLIERS,
    );
    expect(r.headerRow).toBe(-1);
    expect(r.rows).toEqual([]);
  });

  it('数字编码当文本读（1001 与 "1001" 是同一条）', () => {
    const r = parseProductRows([HEAD_OLD, [1001, '挂钩', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)[0].code).toBe('1001');
  });
});

describe('parseSkuCells · 尺码与克重按顺序对应', () => {
  it('多值一一对应（顺序就是对应关系）', () => {
    expect(parseSkuCells('红', 'M,L,XL', '120,130,140').skus).toEqual([
      { color: '红', size: 'M', weightG: 120 },
      { color: '红', size: 'L', weightG: 130 },
      { color: '红', size: 'XL', weightG: 140 },
    ]);
  });

  it('全角逗号 / 顿号 / 分号都能拆', () => {
    expect(parseSkuCells('红', 'M，L、XL；XXL', '1,2;3、4').skus.map((s) => [s.size, s.weightG])).toEqual([
      ['M', 1],
      ['L', 2],
      ['XL', 3],
      ['XXL', 4],
    ]);
  });

  it('⭐ 个数不等 → error（不猜、不补零、不循环）', () => {
    const a = parseSkuCells('红', 'M,L', '120');
    expect(a.skus).toEqual([]);
    expect(a.errors[0]).toContain('尺码 2 个、克重 1 个');
    const b = parseSkuCells('红', 'M', '120,130');
    expect(b.errors[0]).toContain('尺码 1 个、克重 2 个');
  });

  it('克重留空 = 未填（不是 0 克），不是错误', () => {
    expect(parseSkuCells('红', 'M,L', '').skus).toEqual([
      { color: '红', size: 'M', weightG: 0 },
      { color: '红', size: 'L', weightG: 0 },
    ]);
  });

  it('克重带单位（120g / 120 克）剥离后当同一个数', () => {
    expect(parseSkuCells('红', 'M', '120g').skus[0].weightG).toBe(120);
    expect(parseSkuCells('红', 'M', '120 克').skus[0].weightG).toBe(120);
  });

  it('克重非整数 → error（不四舍五入 —— 静默改数字比报错难查）', () => {
    const r = parseSkuCells('红', 'M', '120.5');
    expect(r.skus).toEqual([]);
    expect(r.errors[0]).toContain('不是不小于 0 的整数');
  });

  it('只填克重不填尺码 → error（克重没有可归属的 SKU）', () => {
    const r = parseSkuCells('红', '', '120');
    expect(r.skus).toEqual([]);
    expect(r.errors[0]).toContain('没填尺码');
  });

  it('填了尺码没填颜色 → error（颜色与尺码成对，否则会被标成「旧 SKU」）', () => {
    const r = parseSkuCells('', 'M', '120');
    expect(r.errors[0]).toContain('要填颜色');
  });

  it('颜色一格只允许一个（多颜色请分多行）', () => {
    const r = parseSkuCells('红,蓝', 'M', '120');
    expect(r.skus).toEqual([]);
    expect(r.errors[0]).toContain('颜色只支持一个');
  });

  it('整行没填尺码也没填克重 → 不声明 SKU，也不是错误', () => {
    expect(parseSkuCells('', '', '')).toEqual({ skus: [], errors: [] });
    expect(parseSkuCells('红', '', '')).toEqual({ skus: [], errors: [] });
  });

  it('尺码里带空格（XL 加大）是一个尺码，不是两个', () => {
    expect(parseSkuCells('红', 'XL 加大', '120').skus.map((s) => s.size)).toEqual(['XL 加大']);
  });
});

describe('parseProductRows · 行级校验（error 剔行 / warning 留行）', () => {
  it('编码为空的行标 ok=false 但仍回传（界面要靠它做「重试」）', () => {
    const r = parseProductRows(
      [
        HEAD_OLD,
        ['P-001', '收纳箱', '', '', '', ''],
        ['', '没有编码的行', '', '', '', ''],
        ['P-002', '收纳袋', '', '', '', ''],
      ],
      SUPPLIERS,
    );
    // 关键契约：不合格行**不消失**，只是 ok=false —— 否则"在界面上改完再重试"没有数据可改
    expect(r.rows.map((x) => [x.code, x.ok])).toEqual([
      ['P-001', true],
      ['', false],
      ['P-002', true],
    ]);
    expect(r.rows[1].name).toBe('没有编码的行'); // 用户改编码时要能看到这行原本是什么
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ level: 'error', rowNo: 3 });
    expect(r.issues[0].message).toContain('款编码为空');
  });

  it('编码超长 → ok=false', () => {
    const long = 'X'.repeat(65);
    const r = parseProductRows([HEAD_OLD, [long, '太长', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)).toEqual([]);
    expect(r.issues[0].message).toContain('超过 64 字符');
  });

  it('不合格行不再叠加 warning（提示只留真正的阻断原因）', () => {
    // 空编码 + 厂家对不上 + 状态认不出：三条问题里只应留下 error 那条
    const r = parseProductRows([HEAD_OLD, ['', '无名', '查无此厂', '', '乱写', '']], SUPPLIERS);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].level).toBe('error');
  });

  it('厂家名对不上 → warning + 落 0（**不猜**近似名）', () => {
    const r = parseProductRows(
      [HEAD_OLD, ['P-001', '收纳箱', '深圳明辉有限公司', '', '', '']],
      SUPPLIERS,
    );
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0].supplierId).toBe(0);
    expect(okRows(r)[0].supplierRaw).toBe('深圳明辉有限公司');
    expect(r.issues[0]).toMatchObject({ level: 'warning' });
    expect(r.issues[0].message).toContain('不存在');
  });

  it('厂家名的大小写与空白不敏感（Yiwu Star / yiwu  star 同一条）', () => {
    const r = parseProductRows(
      [HEAD_OLD, ['P-001', 'A', 'yiwu  star', '', '', ''], ['P-002', 'B', '深圳 明辉', '', '', '']],
      SUPPLIERS,
    );
    expect(okRows(r).map((x) => x.supplierId)).toEqual([9, 7]);
    expect(r.issues).toEqual([]);
  });

  it('状态中文可认；认不出的报 warning 并回落 active', () => {
    const r = parseProductRows(
      [
        HEAD_OLD,
        ['P-001', 'A', '', '', '停用', ''],
        ['P-002', 'B', '', '', '随便写的', ''],
      ],
      SUPPLIERS,
    );
    expect(r.rows[0].status).toBe('archived');
    expect(r.rows[1].status).toBe('active');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toContain('无法识别');
  });

  it('款式名为空 → warning 但该行仍然入库', () => {
    const r = parseProductRows([HEAD_OLD, ['P-001', '', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ level: 'warning' });
    expect(r.issues[0].message).toContain('款式名为空');
  });

  it('整行为空的尾部空行只计入 blankRows，不产生 issue', () => {
    const r = parseProductRows(
      [
        HEAD_OLD,
        ['P-001', 'A', '', '', '', ''],
        ['', '', '', '', '', ''],
        ['', '', '', '', '', ''],
      ],
      SUPPLIERS,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toEqual([]);
    expect(r.blankRows).toBe(2);
  });

  it('只在「图片」列里留了个文字、其余全空的行 = 空行（不制造"款编码为空"的红行）', () => {
    const r = parseProductRows(
      [HEAD, ['P-001', 'A', '', '', '红', 'M', '120', '', ''], ['', '', '', 'https://x/y.jpg', '', '', '', '', '']],
      SUPPLIERS,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.blankRows).toBe(1);
    expect(r.issues).toEqual([]);
  });

  it('「图片」列写了文字 → warning（这一版只认插进去的图），行仍然入库', () => {
    const r = parseProductRows(
      [HEAD, ['P-001', 'A', '', 'https://x/y.jpg', '', '', '', '', '']],
      SUPPLIERS,
    );
    expect(okRows(r)).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ level: 'warning' });
    expect(r.issues[0].message).toContain('插入图片');
  });

  it('SKU 单元格解析失败时，该行 ok=false 且 SKU 不被带入库', () => {
    const r = parseProductRows([HEAD, ['P-001', 'A', '', '', '红', 'M,L', '120', '', '']], SUPPLIERS);
    expect(okRows(r)).toEqual([]);
    expect(r.rows[0].skus).toEqual([]);
    expect(msgs(r, 2)).toContain('对不上');
  });

  it('没有任何厂家可关联时不报「厂家对不上」（供应商表为空的降级）', () => {
    // 提交路径里厂家 id 已由界面下拉选定，此时供应商表为空不代表数据有问题。
    const r = parseProductRows([HEAD_OLD, ['P-001', 'A', '深圳明辉', '', '', '']], []);
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0].supplierId).toBe(0);
    expect(r.issues).toEqual([]);
  });
});

describe('parseProductRows · 同款多行 = 合并（不是报错剔行）', () => {
  it('同款两行不同颜色 → 合并成一个款、两个 SKU', () => {
    const r = parseProductRows(
      [
        HEAD,
        ['P-001', '收纳箱', '', '', '红', 'M,L', '120,130', '', ''],
        ['P-001', '', '', '', '蓝', 'M', '125', '', ''],
      ],
      SUPPLIERS,
    );
    expect(r.rows).toHaveLength(1);
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0].skus).toEqual([
      { color: '红', size: 'M', weightG: 120 },
      { color: '红', size: 'L', weightG: 130 },
      { color: '蓝', size: 'M', weightG: 125 },
    ]);
    // 款式名沿用先出现那行的（第二行为空 ⇒ 不覆盖）
    expect(okRows(r)[0].name).toBe('收纳箱');
    // 干净合并不发任何提示（否则导入自己导出的文件会满屏噪音）
    expect(r.issues).toEqual([]);
  });

  it('被并入的行**不出现在结果里**（它不是"要改两遍"的两行）', () => {
    const r = parseProductRows(
      [HEAD, ['P-001', 'A', '', '', '红', 'M', '1', '', ''], ['P-001', '', '', '', '蓝', 'M', '2', '', '']],
      SUPPLIERS,
    );
    expect(r.rows.map((x) => x.rowNo)).toEqual([2]);
  });

  it('同样的颜色+尺码又写一遍 → warning，不新增（先出现的克重胜）', () => {
    const r = parseProductRows(
      [
        HEAD,
        ['P-001', 'A', '', '', '红', 'M', '120', '', ''],
        ['P-001', '', '', '', '红', 'M', '999', '', ''],
      ],
      SUPPLIERS,
    );
    expect(okRows(r)[0].skus).toEqual([{ color: '红', size: 'M', weightG: 120 }]);
    expect(msgs(r, 2)).toContain('又写了一遍');
  });

  it('款式名不一致 → warning，保留先出现的那个', () => {
    const r = parseProductRows(
      [
        HEAD,
        ['P-001', '先来的名', '', '', '红', 'M', '1', '', ''],
        ['P-001', '后来的名', '', '', '蓝', 'M', '2', '', ''],
      ],
      SUPPLIERS,
    );
    expect(okRows(r)[0].name).toBe('先来的名');
    expect(msgs(r, 2)).toContain('款式名是');
  });

  it('不合格的同款行**不参与合并**（保持独立，等用户改完再来）', () => {
    const r = parseProductRows(
      [
        HEAD,
        ['P-001', 'A', '', '', '红', 'M', '1', '', ''],
        ['P-001', '', '', '', '蓝', 'M', '错的', '', ''],
      ],
      SUPPLIERS,
    );
    expect(r.rows.map((x) => [x.rowNo, x.ok])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect(okRows(r)[0].skus).toEqual([{ color: '红', size: 'M', weightG: 1 }]);
  });
});

describe('validateImportRows · 提交路径（用户改过的行回传）', () => {
  const okOnly = (r: ReturnType<typeof validateImportRows>) => r.rows.filter((x) => x.ok);

  it('⭐ 回传行上的 skuErrors（行结果字段）同样拦下 —— 不然预览标了「跳过」、提交照样落库', () => {
    // 2026-10-09 实测：校验器只认解析中间态的 cellErrors，提交路径回传的是行结果
    // （字段名 skuErrors）⇒ 规格对不上的行带着空 SKU 被提交。两条路径进同一个校验器，
    // 两套字段名就必须都认 —— 这条用例用**只有提交路径才有**的形状（只给 skuErrors），
    // 解析路径的兜底救不了它。
    const res = validateImportRows(
      [
        {
          rowNo: 2,
          code: 'P-001',
          name: '收纳箱',
          supplierId: 7,
          skus: [],
          skuErrors: ['尺码 2 个、克重 1 个，对不上 —— 两列要按顺序一一对应'],
        },
      ],
      SUPPLIERS,
    );
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].skuErrors).toContain('尺码 2 个、克重 1 个，对不上 —— 两列要按顺序一一对应');
    expect(res.okCount).toBe(0);
    expect(res.issues.some((x) => x.level === 'error' && x.rowNo === 2)).toBe(true);
  });

  it('cellErrors（解析中间态）照旧认 —— 两条来源互不挤掉', () => {
    const res = validateImportRows(
      [{ rowNo: 2, code: 'P-002', cellErrors: ['克重不是整数'] }],
      SUPPLIERS,
    );
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].skuErrors).toEqual(['克重不是整数']);
  });

  it('用户把空编码补上后就该放行 —— 与 Excel 路径共用同一套校验', () => {
    const res = validateImportRows(
      [
        { rowNo: 3, code: 'P-001', name: '收纳箱', supplierId: 7 },
        { rowNo: 9, code: 'P-009', name: '补上的' },
      ],
      SUPPLIERS,
    );
    expect(okOnly(res).map((x) => x.code)).toEqual(['P-001', 'P-009']);
    expect(res.issues).toEqual([]);
    expect(res.okCount).toBe(2);
    expect(res.errorCount).toBe(0);
  });

  it('提交路径的同款多行同样合并（口径只有一份）', () => {
    const res = validateImportRows(
      [
        { rowNo: 3, code: 'P-001', name: 'A', skus: [{ color: '红', size: 'M', weightG: 1 }] },
        { rowNo: 4, code: 'P-001', skus: [{ color: '蓝', size: 'M', weightG: 2 }] },
      ],
      SUPPLIERS,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].skus).toEqual([
      { color: '红', size: 'M', weightG: 1 },
      { color: '蓝', size: 'M', weightG: 2 },
    ]);
  });

  it('回传的 skus 做形状消毒（脏数据不落库、也不抛）', () => {
    const res = validateImportRows(
      [
        {
          rowNo: 3,
          code: 'P-001',
          name: 'A',
          skus: [null, 'x', { color: '红', size: 'M', weightG: -5 }, { color: '蓝', size: 'L', weightG: 12 }],
        },
      ],
      SUPPLIERS,
    );
    expect(res.rows[0].skus).toEqual([
      { color: '红', size: 'M', weightG: 0 },
      { color: '蓝', size: 'L', weightG: 12 },
    ]);
  });

  it('显式给了 supplierId 就不再按名称解析（提交路径不覆盖界面上的选择）', () => {
    const res = validateImportRows(
      [{ rowNo: 3, code: 'P-001', name: 'A', supplierId: 9, supplierRaw: '深圳明辉' }],
      SUPPLIERS,
    );
    expect(res.rows[0].supplierId).toBe(9);
  });

  it('缺 rowNo 时按序号兜底（不是恒 0 —— 0 会让界面报不出是哪一行）', () => {
    const res = validateImportRows([{ code: 'P-001' }, { code: 'P-002' }], SUPPLIERS);
    expect(res.rows.map((x) => x.rowNo)).toEqual([1, 2]);
  });
});

describe('parseStatusText', () => {
  it('中英文都能认，认不出的返回空串（由调用方决定降级）', () => {
    expect(parseStatusText('active')).toBe('active');
    expect(parseStatusText(' 停用 ')).toBe('archived');
    expect(parseStatusText('已经不存在了')).toBe('');
    expect(parseStatusText(undefined)).toBe('');
  });
});

describe('buildProductSheet · 导出与导入的闭环', () => {
  const P = (
    over: Partial<Parameters<typeof buildProductSheet>[0][number]> = {},
  ): Parameters<typeof buildProductSheet>[0][number] => ({
    code: 'P-001',
    name: '收纳箱',
    supplierName: '深圳明辉',
    imagePath: '',
    status: 'active',
    note: '',
    skus: [],
    ...over,
  });

  it('模板只出表头', () => {
    expect(buildProductSheet([], true)).toEqual([[...PRODUCT_EXPORT_HEADERS]]);
  });

  // ⚠️ 上一条是**常量跟自己比**（两边都是 PRODUCT_EXPORT_HEADERS）——表头字符串被整体改错时它恒绿。
  // 所以这里把关键列钉成字面量：
  //   · 第 3 列「供应商」—— 2026-10-01 界面术语由「厂家」统一为「供应商」，导出表头必须跟着走。
  //     同时**不许**因此删掉 `COLUMN_FAMILIES.supplier` 里的「厂家」别名：那是用户手上旧表
  //     能导回的唯一保证，由本文件顶部 `HEAD_OLD = [..., '厂家', ...]` 那批夹具守着。
  //   · 2026-10-08：**没有「类目」**，且「图片 / 颜色 / 尺码 / 克重」四列都在。
  //     这几条都是"改了会静默破坏用户手上文件"的位置，必须钉字面量而不是跟常量比。
  it('导出表头钉字面量：第 3 列是「供应商」、没有「类目」、四列新列齐全', () => {
    expect(PRODUCT_EXPORT_HEADERS[2]).toBe('供应商');
    expect(buildProductSheet([], true)[0][2]).toBe('供应商');
    expect(PRODUCT_EXPORT_HEADERS).not.toContain('类目');
    expect([...PRODUCT_EXPORT_HEADERS]).toEqual([
      '款编码',
      '款式名',
      '供应商',
      '图片',
      '颜色',
      '尺码',
      '克重',
      '状态',
      '备注',
    ]);
  });

  it('没有 SKU 的款：只出一行，颜色/尺码/克重留空', () => {
    const aoa = buildProductSheet([P({ status: 'archived', note: '停售款' })]);
    expect(aoa[1]).toEqual(['P-001', '收纳箱', '深圳明辉', '', '', '', '', '停用', '停售款']);
  });

  it('有 SKU 的款：尺码与克重按顺序拼进一格（未填克重写空串，不写 0）', () => {
    const aoa = buildProductSheet([
      P({
        skus: [
          { color: '红', size: 'M', weightG: 120 },
          { color: '红', size: 'L', weightG: 0 },
        ],
      }),
    ]);
    expect(aoa[1]).toEqual(['P-001', '收纳箱', '深圳明辉', '', '红', 'M,L', '120,', '启用', '']);
  });

  it('多个颜色的款按颜色拆行；图只挂在第一行（`firstOfCode`）', () => {
    const layout = buildProductSheetLayout([
      P({
        imagePath: '/cache/a.jpg',
        skus: [
          { color: '红', size: 'M', weightG: 1 },
          { color: '蓝', size: 'M', weightG: 2 },
        ],
      }),
    ]);
    expect(layout).toHaveLength(3); // 表头 + 2 个颜色行
    expect(layout[1]).toMatchObject({ code: 'P-001', firstOfCode: true, imagePath: '/cache/a.jpg' });
    expect(layout[2]).toMatchObject({ code: 'P-001', firstOfCode: false, imagePath: '' });
    expect(layout.map((r) => r.cells[4])).toEqual(['颜色', '红', '蓝']);
  });

  it('⭐ 导出的文件能原样导回 —— 含 SKU 与克重，且未填克重不会被写成 0', () => {
    const aoa = buildProductSheet([
      P({
        code: 'P-001',
        status: 'active',
        skus: [
          { color: '红', size: 'M', weightG: 120 },
          { color: '红', size: 'L', weightG: 0 },
          { color: '蓝', size: 'M', weightG: 125 },
        ],
      }),
      P({ code: 'P-002', name: '收纳袋', supplierName: 'Yiwu Star', status: 'archived' }),
    ]);
    const back = parseProductRows(aoa, SUPPLIERS);
    expect(back.headerRow).toBe(0);
    expect(back.issues).toEqual([]);
    expect(back.rows.map((x) => [x.code, x.status, x.supplierId, x.skus])).toEqual([
      [
        'P-001',
        'active',
        7,
        [
          { color: '红', size: 'M', weightG: 120 },
          { color: '红', size: 'L', weightG: 0 },
          { color: '蓝', size: 'M', weightG: 125 },
        ],
      ],
      ['P-002', 'archived', 9, []],
    ]);
  });
});

describe('row.skuErrors · 「在这儿改不了」的那一类错误', () => {
  it('SKU 单元格解析失败 ⇒ skuErrors 非空、该行不入库；编码为空的错误**不进** skuErrors', () => {
    const r = parseProductRows(
      [
        HEAD,
        // 尺码 2 个、克重 1 个 → 对不上（回 Excel 才能改）
        ['P-001', '收纳箱', '深圳明辉', '', '红', 'M,L', '120', '启用', ''],
        // 编码为空（在预览表里就能改，不该算进 skuErrors）
        ['', '收纳袋', '深圳明辉', '', '红', 'M', '120', '启用', ''],
      ],
      SUPPLIERS,
    );
    const [a, b] = r.rows;
    expect(a.ok).toBe(false);
    expect(a.skuErrors.join('')).toContain('对不上');
    expect(b.ok).toBe(false);
    expect(b.skuErrors).toEqual([]);
    // 两条都还得在 issues 里（说明列要显示），不能只留在行上
    expect(msgs(r, 2)).toContain('对不上');
    expect(msgs(r, 3)).toContain('款编码为空');
  });

  it('SKU 正常的行 skuErrors 为空、imageId 恒 0（图是抽图那一步才贴上的）', () => {
    const r = parseProductRows([HEAD, ['P-001', '收纳箱', '深圳明辉', '', '红', 'M', '120', '启用', '']], SUPPLIERS);
    expect(r.rows[0].skuErrors).toEqual([]);
    expect(r.rows[0].imageId).toBe(0);
  });
});

describe('attachExtractedImages · 嵌入图按锚点行归位', () => {
  const rows = () =>
    parseProductRows(
      [
        HEAD,
        ['P-001', '收纳箱', '深圳明辉', '', '红', 'M', '120', '启用', ''],
        ['P-002', '收纳袋', '深圳明辉', '', '蓝', 'L', '130', '启用', ''],
      ],
      SUPPLIERS,
    ).rows;

  it('按行号贴到对应行，别的行不受影响', () => {
    const { rows: out, issues } = attachExtractedImages(
      rows(),
      { '3': { imageId: 41, localPath: '/cache/a.jpg' } },
      [],
    );
    expect(out.map((r) => r.imageId)).toEqual([0, 41]);
    expect(issues).toEqual([]);
  });

  it('⭐ 图落在表头以上的行 ⇒ 报出来，且**不**顺手贴给第一行', () => {
    const { rows: out, issues } = attachExtractedImages(
      rows(),
      { '1': { imageId: 41, localPath: '/cache/a.png' } },
      [],
    );
    expect(out.map((r) => r.imageId)).toEqual([0, 0]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('没有归位');
  });

  it('主进程报的 skips 转成 warning，并带上该行的编码（便于定位）', () => {
    const { issues } = attachExtractedImages(
      rows(),
      {},
      [{ rowNo: 3, reason: '第 3 行插了不止一张图片，只用了第一张' }],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].rowNo).toBe(3);
    // Excel 第 1 行是表头 ⇒ 第 3 行是第二个款
    expect(issues[0].code).toBe('P-002');
  });

  it('非法 imageId（0 / NaN）当作"没有图"，不写进任何行', () => {
    const { rows: out, issues } = attachExtractedImages(
      rows(),
      { '3': { imageId: 0, localPath: '' }, '4': { imageId: Number.NaN, localPath: '/x' } },
      [],
    );
    expect(out.map((r) => r.imageId)).toEqual([0, 0]);
    expect(issues).toEqual([]);
  });

  it('纯函数：不修改入参（否则界面上"再校验一次"会带着上一次的结果跑）', () => {
    const input = rows();
    const snapshot = JSON.stringify(input);
    attachExtractedImages(input, { '3': { imageId: 41, localPath: '/cache/a.jpg' } }, []);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
