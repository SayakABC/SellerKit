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
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

mkdirSync(OUT_DIR, { recursive: true });
const wb = ordersWorkbook();
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(OUT_DIR, 'orders.xlsx'), buf);
console.log(`已生成 ${join(OUT_DIR, 'orders.xlsx')}（${buf.length} 字节）`);
