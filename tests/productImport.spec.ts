// 产品库 Excel 导入的解析与校验单测（src/lib/productImport.ts）。
//
// 为什么这个文件值得单独测：产品导入的**每一个**错误都会静默落成"看起来正常"的数据 ——
// 列认错 → 编码列读成了类目；厂家名对不上 → 成本挂到空厂家；状态认错 → 产品被停用。
// 界面上一律只显示"导入成功 490 行"，所以口径必须在这里钉住。
//
// ⚠️ 厂商名的匹配刻意**只做精确比对**（去空白 + 忽略大小写）。若哪天有人加了"模糊匹配"，
//    下面「厂家名对不上要报 warning 且落 0」那条必须仍然为真 —— 否则会把成本挂到别人账上。
import { describe, it, expect } from 'vitest';
import {
  parseProductRows,
  validateImportRows,
  parseStatusText,
  buildProductSheet,
  PRODUCT_EXPORT_HEADERS,
  type SupplierRef,
} from '../src/lib/productImport';

const SUPPLIERS: SupplierRef[] = [
  { id: 7, name: '深圳明辉' },
  { id: 9, name: 'Yiwu Star' },
];

/** 一张标准的 6 列表头 */
const HEAD = ['款编码', '款式名', '厂家', '类目', '状态', '备注'];

/** 只取可入库的行（便于断言"真正会进库的是什么"） */
const okRows = (r: ReturnType<typeof parseProductRows>) => r.rows.filter((x) => x.ok);

describe('parseProductRows · 表头定位与列匹配', () => {
  it('首行是导出横幅时，表头行往下探测到第 3 行', () => {
    const r = parseProductRows(
      [
        ['产品库导出', '', '', '', '', ''],
        ['导出时间：2026-09-27', '', '', '', '', ''],
        HEAD,
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
    expect(okRows(r)[0]).toMatchObject({ supplierId: 9, category: '五金', status: 'active' });
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
    const r = parseProductRows([HEAD, [1001, '挂钩', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)[0].code).toBe('1001');
  });
});

describe('parseProductRows · 行级校验（error 剔行 / warning 留行）', () => {
  it('编码为空的行标 ok=false 但仍回传（界面要靠它做「重试」）', () => {
    const r = parseProductRows(
      [
        HEAD,
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

  it('重复编码 → 只留先出现的那行，后者 ok=false 并指向行号', () => {
    const r = parseProductRows(
      [
        HEAD,
        ['P-001', '先来的', '', '', '', ''],
        ['P-001', '后来的', '', '', '', ''],
      ],
      SUPPLIERS,
    );
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0].name).toBe('先来的');
    expect(r.rows[1].ok).toBe(false);
    expect(r.issues[0].level).toBe('error');
    expect(r.issues[0].message).toContain('第 2 行');
  });

  it('编码超长 → ok=false', () => {
    const long = 'X'.repeat(65);
    const r = parseProductRows([HEAD, [long, '太长', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)).toEqual([]);
    expect(r.issues[0].message).toContain('超过 64 字符');
  });

  it('不合格行不再叠加 warning（提示只留真正的阻断原因）', () => {
    // 空编码 + 厂家对不上 + 状态认不出：三条问题里只应留下 error 那条
    const r = parseProductRows([HEAD, ['', '无名', '查无此厂', '', '乱写', '']], SUPPLIERS);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].level).toBe('error');
  });

  it('厂家名对不上 → warning + 落 0（**不猜**近似名）', () => {
    const r = parseProductRows(
      [HEAD, ['P-001', '收纳箱', '深圳明辉有限公司', '', '', '']],
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
      [HEAD, ['P-001', 'A', 'yiwu  star', '', '', ''], ['P-002', 'B', '深圳 明辉', '', '', '']],
      SUPPLIERS,
    );
    expect(okRows(r).map((x) => x.supplierId)).toEqual([9, 7]);
    expect(r.issues).toEqual([]);
  });

  it('状态中文可认；认不出的报 warning 并回落 active', () => {
    const r = parseProductRows(
      [
        HEAD,
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
    const r = parseProductRows([HEAD, ['P-001', '', '', '', '', '']], SUPPLIERS);
    expect(okRows(r)).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ level: 'warning' });
    expect(r.issues[0].message).toContain('款式名为空');
  });

  it('整行为空的尾部空行只计入 blankRows，不产生 issue', () => {
    const r = parseProductRows(
      [HEAD, ['P-001', 'A', '', '', '', ''], ['', '', '', '', '', ''], ['', '', '', '', '', '']],
      SUPPLIERS,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toEqual([]);
    expect(r.blankRows).toBe(2);
  });

  it('没有任何厂家可关联时不报「厂家对不上」（供应商表为空的降级）', () => {
    // 提交路径里厂家 id 已由界面下拉选定，此时供应商表为空不代表数据有问题。
    const r = parseProductRows([HEAD, ['P-001', 'A', '深圳明辉', '', '', '']], []);
    expect(okRows(r)).toHaveLength(1);
    expect(okRows(r)[0].supplierId).toBe(0);
    expect(r.issues).toEqual([]);
  });
});

describe('validateImportRows · 提交路径（用户改过的行回传）', () => {
  const okOnly = (r: ReturnType<typeof validateImportRows>) => r.rows.filter((x) => x.ok);

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

  it('用户手改出的重复编码同样被拦（改坏数据不能绕过校验）', () => {
    const res = validateImportRows(
      [
        { rowNo: 3, code: 'P-001', name: 'A' },
        { rowNo: 4, code: 'P-001', name: 'B' },
      ],
      SUPPLIERS,
    );
    expect(okOnly(res)).toHaveLength(1);
    expect(res.errorCount).toBe(1);
    expect(res.issues[0].level).toBe('error');
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
  it('模板只出表头', () => {
    expect(buildProductSheet([], true)).toEqual([[...PRODUCT_EXPORT_HEADERS]]);
  });

  // ⚠️ 上一条是**常量跟自己比**（两边都是 PRODUCT_EXPORT_HEADERS）——表头字符串被整体改错时它恒绿。
  // 所以这里把第 3 列钉成字面量：2026-10-01 界面术语由「厂家」统一为「供应商」，导出表头必须跟着走，
  // 否则用户拿到表头写「供应商」的模板、界面上却到处写「厂家」，又变成两套词。
  // 同时**不许**因此删掉 `COLUMN_FAMILIES.supplier` 里的「厂家」别名 —— 那是用户手上旧表能导回的唯一保证，
  // 由本文件顶部 `HEAD = ['款编码','款式名','厂家',…]` 那批夹具守着（它们逐条断言 supplierId 解析正确）。
  it('导出表头第 3 列是「供应商」（钉字面量，防止它与常量一起被改回「厂家」）', () => {
    expect(PRODUCT_EXPORT_HEADERS[2]).toBe('供应商');
    expect(buildProductSheet([], true)[0][2]).toBe('供应商');
  });

  it('状态导出成中文（与导入侧的中文映射对称）', () => {
    const aoa = buildProductSheet([
      {
        code: 'P-001',
        name: '收纳箱',
        supplierName: '深圳明辉',
        category: '家居',
        status: 'archived',
        note: '停售款',
      },
    ]);
    expect(aoa[1]).toEqual(['P-001', '收纳箱', '深圳明辉', '家居', '停用', '停售款']);
  });

  it('导出的文件能原样导回（列名族与导出表头是同一套）', () => {
    const aoa = buildProductSheet([
      {
        code: 'P-001',
        name: '收纳箱',
        supplierName: '深圳明辉',
        category: '家居',
        status: 'active',
        note: '',
      },
      {
        code: 'P-002',
        name: '收纳袋',
        supplierName: 'Yiwu Star',
        category: '家居',
        status: 'archived',
        note: '',
      },
    ]);
    const back = parseProductRows(aoa, SUPPLIERS);
    expect(back.headerRow).toBe(0);
    expect(back.issues).toEqual([]);
    expect(back.rows.map((x) => [x.code, x.status, x.supplierId])).toEqual([
      ['P-001', 'active', 7],
      ['P-002', 'archived', 9],
    ]);
  });
});
