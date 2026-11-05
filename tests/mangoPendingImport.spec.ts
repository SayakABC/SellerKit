// 「芒果店长 · 待发货订单」导入的契约用例（`src/lib/importDetect.ts` + `src/lib/orderClassifier.ts`
// + `src/lib/orderRowSplitter.ts` + `electron/orderMoney.ts`）。
//
// 为什么值得单测：这份报表与速卖通订单报表**长得像但不一样** —— 它自带「店铺名」与「产品图片链接」，
// 于是导入侧要 ① 认出来（判据写准）、② 拿店铺名列落 `oi_orders.shop`、③ 拿图片列拆多产品行 + 下载主图。
// 任何一环判错都是**静默**的（导完了、行数不对 / 图全空 / 店铺空），没有异常也没有日志。
//
// 夹具是**用户真实导出**（16 行 / 12 列，单表），不是手搓的迷你样本 —— 结构（列名原文、多值分隔符、
// 尾随换行、块内 `(产品数量:N piece)`）必须一起复刻，否则依赖这些结构的实现会**恒绿**。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { detectImportKind, type SheetGrid } from '../src/lib/importDetect';
import {
  detectImageColumn,
  detectImageColumnStrict,
  detectShopColumn,
  detectSizeColumn,
} from '../src/lib/orderClassifier';
import { detectMultiProductColumns, expandOrderRows, parseRowQty } from '../src/lib/orderRowSplitter';
import { orderRowFields } from '../src/lib/orderImportRow';
import { extractOrderMoney } from '../electron/orderMoney';

/** 真实导出夹具 → 单表网格 */
function mangoSheet(): SheetGrid {
  const buf = readFileSync(new URL('./fixtures/mango-pending-orders.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const name = (wb.SheetNames as string[])[0];
  return {
    name,
    grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][],
  };
}

function records(sheet: SheetGrid): Record<string, string>[] {
  const header = (sheet.grid[0] ?? []).map((h) => String(h ?? '').trim());
  return sheet.grid
    .slice(1)
    .map((r) => Object.fromEntries(header.map((k, i) => [k, String(r?.[i] ?? '')])));
}

const HEADER = (s: SheetGrid): string[] => (s.grid[0] ?? []).map((h) => String(h ?? '').trim());

// ─────────────────────────────────────────────────────────── ① 识别

describe('detectImportKind：芒果店长待发货订单', () => {
  it('识别为订单报表，且判据点名「芒果店长」（不是笼统的订单报表签名）', () => {
    const d = detectImportKind([mangoSheet()]);
    expect(d.kind).toBe('orders');
    if (d.kind) {
      expect(d.why).toContain('芒果店长');
      expect(d.why).toContain('产品图片链接');
    }
  });

  it('速卖通式订单报表（无产品数量列）仍走通用签名，不被误判为芒果', () => {
    const ae: SheetGrid = {
      name: 'sheet1',
      grid: [
        ['订单号', '订单状态', '订单金额', '商品 ID', '商品信息'],
        ['3076475435222658', '等待发货', 'CN￥ 165.18', '1005011764572483', '【1】某款 (商品数量:1 piece)'],
      ],
    };
    const d = detectImportKind([ae]);
    expect(d.kind).toBe('orders');
    if (d.kind) expect(d.why).not.toContain('芒果店长');
  });
});

// ─────────────────────────────────────────────────────────── ② 列探测

describe('列探测：店铺名 / 主图 / 尺寸', () => {
  it('真实表头逐列命中', () => {
    const h = HEADER(mangoSheet());
    expect(detectShopColumn(h)).toBe('店铺名');
    expect(detectSizeColumn(h)).toBe('尺寸');
    expect(detectImageColumnStrict(h)).toBe('产品图片链接');
  });

  it('主图列 **strict**：无图列的报表不得回落第一列（否则拆行会逐行误标缺图）', () => {
    // 速卖通 47 列报表：第一列是「订单号」，没有图列
    const ae = ['订单号', '订单状态', '订单金额', '商品 ID', '商品信息'];
    expect(detectImageColumnStrict(ae)).toBe('');
    // 界面用的宽松版仍保留"回落第一列"（只是给个可改的默认值），两者分工不同
    expect(detectImageColumn(ae)).toBe('订单号');
  });

  it('无店铺列的报表不得猜出店铺（店铺由人「归到该店」指定）', () => {
    expect(detectShopColumn(['订单号', '订单金额', '商品信息'])).toBe('');
  });

  it('多产品列探测：数量列 / 图片列 / 尺寸列都接上（缺一就会拆错）', () => {
    const s = mangoSheet();
    const h = HEADER(s);
    const cols = detectMultiProductColumns(h, records(s), {
      imageColumn: detectImageColumnStrict(h),
      sizeColumn: detectSizeColumn(h),
    });
    expect(cols).not.toBeNull();
    expect(cols?.count).toBe('产品数量');
    expect(cols?.info).toBe('产品信息');
    expect(cols?.productId).toBe('产品ID');
    expect(cols?.image).toBe('产品图片链接');
    expect(cols?.size).toBe('尺寸');
  });

  it('无图列的报表探测出的 image 为空串 → 不产生"缺图"（负向：回落第一列会把它变成图列）', () => {
    const h = ['订单号', '商品 ID', '商品信息'];
    const rows = [{ 订单号: 'N1', '商品 ID': '111,222', 商品信息: '【1】A\n【2】B' }];
    const cols = detectMultiProductColumns(h, rows, { imageColumn: detectImageColumnStrict(h) });
    expect(cols?.image).toBe('');
    const out = expandOrderRows(rows, cols);
    expect(out.rows).toHaveLength(2);
    expect(out.missingImageCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────── ③ 拆行

describe('多产品行拆分（真实 16 行夹具）', () => {
  const s = mangoSheet();
  const h = HEADER(s);
  const rows = records(s);
  const cols = detectMultiProductColumns(h, rows, {
    imageColumn: detectImageColumnStrict(h),
    sizeColumn: detectSizeColumn(h),
  });
  const out = expandOrderRows(rows, cols);

  it('原始行 16 行，只有 1 个多产品单被拆开，展开后 17 行', () => {
    expect(rows).toHaveLength(16);
    expect(out.expanded).toBe(1);
    expect(out.rows).toHaveLength(17);
  });

  it('多产品单拆成 2 行：图片/尺寸/商品ID 逐行对齐（不再留多值串）', () => {
    const split = out.rows.filter((r) => r['订单号'] === '8215263987432184');
    expect(split).toHaveLength(2);
    expect(split.map((r) => r['尺寸'])).toEqual(['XXXL', 'XXXL']);
    expect(split.map((r) => r['产品ID'])).toEqual(['1005012244656475', '1005012244656475']);
    // 图片列逐行切分：每行只带走自己那一张（原始单元格是换行分隔的两张）
    expect(split.map((r) => r['产品图片链接'])).toEqual([
      'https://ae-pic-a1.aliexpress-media.com/kf/S506c88c561f64c799b1e941f616cfe56j.jpg',
      'https://ae-pic-a1.aliexpress-media.com/kf/S37521f225e154bf4bcc355229531dcadl.jpg',
    ]);
  });

  it('展开后每一行的图片链接都可直接下载（拆行不留多值串；未拆行的尾随换行由调用方 trim）', () => {
    for (const r of out.rows) {
      const v = String(r['产品图片链接'] ?? '').trim();
      expect(v).not.toContain('\n');
      expect(v.startsWith('http')).toBe(true);
    }
  });

  it('店铺名与订单级字段原样复制到拆出的每一行（订单号/店铺名/金额不摊分、不丢）', () => {
    const split = out.rows.filter((r) => r['订单号'] === '8215263987432184');
    expect(split.map((r) => r['店铺名'])).toEqual(['六店', '六店']);
    expect(split.map((r) => r['订单金额'])).toEqual(['193.09', '193.09']);
  });

  it('件数从「这一行自己的块」里取到（拆行后块内 (产品数量:N piece) 就是该行的件数）', () => {
    const split = out.rows.filter((r) => r['订单号'] === '8215263987432184');
    expect(split.map((r) => parseRowQty(r))).toEqual([1, 1]);
    // 单产品行照常取到
    const one = out.rows.find((r) => r['订单号'] === '3076888759001597');
    expect(parseRowQty(one)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────── ④ 金额

describe('金额列提取：芒果模板的「订单金额」是买家实付（无币种前缀也要认）', () => {
  it('订单金额 → 分；产品总金额 / 物流费用只留在 raw_fields（不进同一列）', () => {
    const rows = records(mangoSheet());
    const first = rows[0];
    const m = extractOrderMoney(first);
    expect(m.amountCents).toBe(7675); // '76.75'
    // 芒果模板没有「订单状态/发货时间/代征代缴」列 → 一律空，不猜
    expect(m.bizStatus).toBe('');
    expect(m.shipTime).toBe('');
    expect(m.taxPlatformRaw).toBe('');
    expect(m.vatCents).toBeNull();
    expect(m.ddpCents).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────── ⑤ 一行 → 落库字段

describe('orderRowFields：店铺名 / 主图 / 订单号 / 尺寸 / 时间', () => {
  const cols = { shop: '店铺名', image: '产品图片链接' };

  it('真实行：店铺名与订单号认得出，主图 URL 已 trim（单元格尾随换行不能带进下载）', () => {
    const rows = records(mangoSheet());
    const f = orderRowFields(rows[0], cols);
    expect(f.orderNo).toBe('3076888759001597');
    expect(f.shop).toBe('六店');
    expect(f.size).toBe('XXXL'); // 列名是「尺寸」
    expect(f.orderTime).toBe('2026-10-04 16:55:46');
    expect(f.imageUrl).toBe('https://ae-pic-a1.aliexpress-media.com/kf/S37521f225e154bf4bcc355229531dcadl.jpg');
  });

  it('未拆行的尾随换行被 trim（原始单元格是 `…jpg\\n`）', () => {
    const f = orderRowFields({ 订单号: 'N1', 产品图片链接: 'https://x/y.jpg\n' }, cols);
    expect(f.imageUrl).toBe('https://x/y.jpg');
  });

  it('报表没有店铺列 / 图片列时给空串（不猜、不回落别的列）', () => {
    const f = orderRowFields({ 订单号: 'N1', 订单金额: '1.00', 商品信息: '【1】A' }, { shop: '', image: '' });
    expect(f.shop).toBe('');
    expect(f.imageUrl).toBe('');
    expect(f.orderNo).toBe('N1');
  });

  it('没有订单号 → 空串（调用方据此 skip 并计数，不静默留半行）', () => {
    expect(orderRowFields({ 店铺名: '六店' }, cols).orderNo).toBe('');
  });
});
