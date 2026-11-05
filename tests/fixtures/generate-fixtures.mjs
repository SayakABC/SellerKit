/**
 * 生成 tests/fixtures/ 下的 Excel 夹具。
 *
 * 夹具入库（而非"测试时现场生成"）的理由：
 *   1. `导出测试.xlsx` 被 .gitignore 忽略，本机可用而他机/CI 不可用，不能作为夹具；
 *   2. 输入文件固定不变，测试失败才能明确指向"代码回归"而非"夹具生成逻辑变了"。
 * 但夹具的**来源**必须可复现，所以保留本脚本：如需增改夹具，改这里后重跑。
 *
 * 用法：node tests/fixtures/generate-fixtures.mjs
 */
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/** 一个含中文表头、重复列名、空列名、首尾空行、中间空行的"不友好"表格 */
function ordersWorkbook() {
  const rows = [
    ['', '', '', '', '', ''], // 首行全空 → 解析时应被裁掉
    ['订单号', '商品名称', '商品名称', '数量', '金额', '下单时间'],
    ['SO-1001', '短袖T恤 A款', '圆领 白色', '2', '¥128.00', '2024/8/24 10:30'],
    ['', '', '', '', '', ''], // 数据区中间的空行 → 应被跳过且不产生记录
    ['SO-1002', '阔腿裤 B款', '高腰 黑色', '1', '59.9', '2024-08-25 09:05'],
    ['', '', '', '', '', ''], // 尾行全空 → 应被裁掉
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '订单');
  // 第二个 sheet 用于验证"只取第一个工作表"的行为
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['无关表头'], ['x']]), '说明');
  return wb;
}

/**
 * 「无忧物流运费」夹具：从**运营商报价单原始文件**里抽出目标 sheet，单独存成一个工作簿。
 *
 * 为什么不能现场合成：这张 sheet 有 268 行 × 17 段列结构互不相同的价卡（含大量合并单元格），
 * 手写一份等于把"被测试对象"抄一遍，夹具就不再是独立证据。所以夹具 = 原始报价单的**逐格切片**。
 *
 * ⚠️ 必须用 `sheet_to_json` + `aoa_to_sheet` 走本库（而不是 openpyxl 之类）中转：
 * 源表里存在 `166.54999999999998` 这类浮点字面量，任何"十进制往返"都会把它变成 `166.55`，
 * 而两者在"四舍五入到分"的边界上**结果不同**（16.65 vs 16.66）→ 夹具会与生产口径差 1 分。
 *
 * ⚠️⚠️ **必须保留源工作簿的 sheet 顺序**（首张是非报价单的「目录」，报价单在第 10 张）。
 * 这条曾经漏掉过，代价是一次线上故障：夹具当时把报价单放在**第一张**，
 * 于是"未指定 sheet 名就取第一个 sheet"这个错误写法在测试里恒绿
 * （见 tests/shipRate.spec.ts 的「自动选表」分组）。夹具的**结构**（不只是单元格内容）
 * 也是被测对象的一部分，顺序被抹平就等于把这个 bug 从此测不出来。
 *
 * ⚠️⚠️ **同样要保留"版式不是一种"**（2026-09-25 补）：源工作簿 21 张 sheet 里，
 * 表头有 1~3 行、叶子行与档位行的上下顺序还会颠倒、有的线路按美元报价。
 * 只留「无忧物流-标准」一张的话，"表头行数写死 3 行"这种实现照样恒绿 ——
 * 所以 familySheets 里放的是**各版式族各一张**的真实切片（燕文 / 4PX / 特货标准 / 海运大件）。
 *
 * 源文件不在仓库内（体积大且含运营商信息），故按路径查找；找不到就跳过并保留既有夹具。
 * 用法：SHIP_RATE_SRC=/path/to/报价单.xlsx node tests/fixtures/generate-fixtures.mjs
 */
function shippingRateWorkbook(srcPath, sheetName, leadSheetName, extraSheets = [], familySheets = []) {
  const src = XLSX.read(readFileSync(srcPath), { type: 'buffer' });
  const sheet = src.Sheets[sheetName];
  if (!sheet) throw new Error(`源文件里没有 sheet「${sheetName}」：${src.SheetNames.join(' / ')}`);
  // 空串转 null（aoa_to_sheet 会为 '' 真的建一个空单元格）；裁掉每行尾部的空值
  //（sheet_to_json 会把每行补齐到最大列宽，不裁的话 268×40 个空单元格会白白撑大夹具）
  const slice = (ws) =>
    XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map((row) => {
      const out = row.map((v) => (v === '' ? null : v));
      while (out.length > 0 && out[out.length - 1] === null) out.pop();
      return out;
    });
  const put = (name) => {
    const ws = src.Sheets[name];
    if (!ws) throw new Error(`源文件里没有 sheet「${name}」：${src.SheetNames.join(' / ')}`);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(slice(ws)), name);
  };

  const wb = XLSX.utils.book_new();
  // ① 先放首张（源文件里的「目录」）：**顺序是夹具的一部分**，见上方 ⚠️⚠️
  put(leadSheetName);
  // ② 再放**同样能解析、但在源文件里位置更靠前**的线路 —— 这是"只取第一张可解析表"的对照组。
  //    没有它，`pickRateSheet` 就算完全不排序也能蒙对（不可用的首张会被过滤掉）。
  extraSheets.forEach(put);
  // ③ 目标表（源文件里在第 10 张，不在第一张）
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(slice(sheet)), sheetName);
  // ④ 其余版式族（见上方第二个 ⚠️⚠️）。放在目标表**之后**：它们只服务于"解析覆盖"用例，
  //    不参与"目标表不在第一张"那组排序断言（混进来会让那组的意图变模糊）。
  familySheets.forEach(put);
  // ⑤ 尾张：让「按名取 sheet」「恒取第一张」「恒取最后一张」三种写法在测试里都能区分
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['无关表头'], ['x']]), '说明');
  return wb;
}

mkdirSync(OUT_DIR, { recursive: true });
const wb = ordersWorkbook();
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(OUT_DIR, 'orders.xlsx'), buf);
console.log(`已生成 ${join(OUT_DIR, 'orders.xlsx')}（${buf.length} 字节）`);

const SHIP_SHEET = '无忧物流-标准';
/** 源工作簿的首张工作表（非报价单）——夹具要复刻"报价单不在第一张"这个结构 */
const SHIP_LEAD_SHEET = '目录';
/**
 * 源文件里**位置更靠前、且同样能解析出运价**的线路（排在目标表之前）。
 * 放进夹具是为了给"只取第一张可解析表"的写法留一个对照组 —— 见 shippingRateWorkbook ②。
 */
const SHIP_EXTRA_SHEETS = ['无忧物流-特惠'];
/**
 * 其余**版式族各一张**（表头行数 / 叶子与档位的上下顺序 / 币种各不相同）。
 * 每张都钉住一个当年真出过问题的解析分支，理由见 generate-fixtures 上方第二个 ⚠️⚠️：
 *   · 燕文航空挂号小包    2 行表头 + 叶子写作「Item 服务费」（用户实测报"表头结构无法识别"的那张）
 *   · 超级经济-燕文       2 行表头 + 两个档位 + 单列「最低计费重量」
 *   · 4PX新邮挂号小包     1 行表头（无档位行，限重写在叶子里）
 *   · 无忧物流-特货标准   叶子行在**上**、档位行在下；且含一个"重量分档写在数据行里"的节（须整节拒绝）
 *   · 无忧物流-海运大件专线 分档行式宽表（同一目的地多行）—— 须整节拒绝且**不产出任何国家**
 */
const SHIP_FAMILY_SHEETS = [
  '燕文航空挂号小包',
  '超级经济-燕文',
  '4PX新邮挂号小包',
  '无忧物流-特货标准',
  '无忧物流-海运大件专线',
];
const shipSrc =
  process.env.SHIP_RATE_SRC ||
  join(homedir(), 'Downloads', 'ae5a7f6345c82d53575081d63e91b90a.xlsx');
if (existsSync(shipSrc)) {
  const shipBuf = XLSX.write(
    shippingRateWorkbook(shipSrc, SHIP_SHEET, SHIP_LEAD_SHEET, SHIP_EXTRA_SHEETS, SHIP_FAMILY_SHEETS),
    {
      type: 'buffer',
      bookType: 'xlsx',
    }
  );
  writeFileSync(join(OUT_DIR, 'shipping-rate.xlsx'), shipBuf);
  console.log(
    `已生成 ${join(OUT_DIR, 'shipping-rate.xlsx')}（${shipBuf.length} 字节，源：${shipSrc}）`
  );
} else {
  console.log(`[跳过] 未找到运价源文件：${shipSrc}（设 SHIP_RATE_SRC 指定；既有夹具保持不变）`);
}
