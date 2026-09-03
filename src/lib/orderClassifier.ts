// src/lib/orderClassifier.ts
// 订单归类纯函数：识别结果的归一化（同义词映射/去空白）+ 主图列自动探测。
// 无副作用，可单测；归类逻辑集中于此，视图与 store 不重复实现。

/** 颜色同义词映射（识别结果 → 统一名称） */
const COLOR_SYNONYMS: Record<string, string> = {
  黑: '黑色',
  白: '白色',
  纯白: '白色',
  米白: '米白',
  灰: '灰色',
  浅灰: '浅灰',
  深灰: '深灰',
  藏青: '藏蓝',
  藏蓝: '藏蓝',
  深蓝: '藏蓝',
  宝蓝: '宝蓝',
  浅蓝: '浅蓝',
  蓝: '蓝色',
  红: '红色',
  酒红: '酒红',
  枣红: '枣红',
  粉: '粉色',
  浅粉: '粉色',
  紫: '紫色',
  香芋紫: '香芋紫',
  绿: '绿色',
  军绿: '军绿',
  墨绿: '墨绿',
  卡其: '卡其',
  棕: '棕色',
  咖啡: '咖啡色',
  黄: '黄色',
  姜黄: '姜黄',
  杏色: '杏色',
  燕麦: '燕麦色',
  奶咖: '奶咖',
  印花: '印花',
  多色: '印花',
};

/** 去掉多余空白，去除内部空格 */
export function normalizeText(v: string): string {
  return (v || '').trim().replace(/\s+/g, '');
}

/** 颜色归一化：命中同义词映射则替换，否则原样返回 */
export function normalizeColor(v: string): string {
  const t = normalizeText(v);
  if (!t) return '';
  return COLOR_SYNONYMS[t] || t;
}

/** 视为"空值"的识别结果（款式归一化时丢弃） */
const EMPTY_LIKE = new Set(['', '无', '未知', '未识别', '其他', 'none', 'null', 'undefined', '-']);

/**
 * 款式大类枚举白名单：与 VISION_PROMPT 中让模型选择的固定列表保持同源。
 * normalizeCategory 按此白名单做归一化（大小写/全角变体归并），
 * 避免「T恤 / 短袖t恤 / 短袖Ｔ恤」等拼写变体生成不同指纹导致同款拆成多个款编码。
 */
export const CATEGORY_WHITELIST = [
  '短袖T恤',
  '长袖T恤',
  '卫衣',
  '外套',
  '衬衫',
  '连衣裙',
  '长裤',
  '短裤',
  '马甲',
  '西装',
  '毛衣',
  '风衣',
  '牛仔裤',
  '运动套装',
  '其他',
] as const;

/** 全角 → 半角（仅用于白名单比对） */
function fullToHalf(s: string): string {
  return s
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 常见拼写/缩写变体 → 白名单标准名（仅收录确定同义的映射，避免误合并） */
const CATEGORY_ALIASES: Record<string, string> = {
  't恤': '短袖T恤',
  't恤衫': '短袖T恤',
  't桖': '短袖T恤',
  tee: '短袖T恤',
  '套头衫': '卫衣',
  '连帽衫': '卫衣',
  'hoodie': '卫衣',
  '夹克': '外套',
  '大衣': '外套',
  'jacket': '外套',
  '打底裤': '长裤',
  '运动裤': '长裤',
  '阔腿裤': '长裤',
  '牛仔裤': '牛仔裤',
  '牛仔': '牛仔裤',
};

/**
 * 款式归一化：清空不合法值；白名单精确命中归并（大小写/全角变体）；
 * 命中别名映射则替换；未命中保留原词（不做强行归类，避免错误合并）。
 * @param v 识别结果中的 category 原词
 * @returns 归一化后的款式名；空值返回 ''
 */
export function normalizeCategory(v: string): string {
  const t = normalizeText(v);
  if (!t || EMPTY_LIKE.has(t.toLowerCase())) return '';
  const key = fullToHalf(t).toLowerCase();
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  const exact = CATEGORY_WHITELIST.find((c) => fullToHalf(c).toLowerCase() === key);
  return exact || t;
}

/** 按关键词列表探测列：命中返回原始列名（区分大小写原样），未命中返回 '' */
function detectColumn(headers: string[], keywords: string[]): string {
  if (!headers.length) return '';
  const lower = headers.map((h) => h.toLowerCase());
  for (const kw of keywords) {
    const idx = lower.findIndex((h) => h.includes(kw));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

/** 主图列自动探测：优先匹配含"主图/图片/图/img/image/pic"的列名 */
export function detectImageColumn(headers: string[]): string {
  return detectColumn(headers, ['主图', '图片', '图', 'img', 'image', 'pic']) || headers[0] || '';
}

/** 订单号列自动探测（常见导出模板：订单号/订单编号/平台单号/order_no…） */
export function detectOrderNoColumn(headers: string[]): string {
  return detectColumn(headers, [
    '订单编号',
    '订单号',
    '平台单号',
    '订单id',
    '单号',
    'order_no',
    'order no',
    'orderno',
    'orderid',
  ]);
}

/** 店铺列自动探测（店铺名/店铺/店名/shop/store…） */
export function detectShopColumn(headers: string[]): string {
  return detectColumn(headers, ['店铺名', '店铺', '店名', 'shop', 'store']);
}

/** 尺寸列自动探测（尺寸/尺码/size…） */
export function detectSizeColumn(headers: string[]): string {
  return detectColumn(headers, ['尺寸', '尺码', 'size']);
}

/** 下单时间列自动探测（下单时间/购买时间/付款时间/创建时间…） */
export function detectOrderTimeColumn(headers: string[]): string {
  return detectColumn(headers, [
    '下单时间',
    '购买时间',
    '付款时间',
    '创建时间',
    '交易时间',
    '成交时间',
    '订单时间',
    'order_time',
    'order time',
    'ordertime',
  ]);
}

/** 识别结果 → 入库前的归一化字段 */
export function classifyResult(result: {
  category: string;
  color: string;
  logo: string;
  styleName?: string;
}): { category: string; color: string; logo: string; styleName: string } {
  return {
    category: normalizeCategory(result.category),
    color: normalizeColor(result.color),
    logo: normalizeText(result.logo),
    styleName: normalizeText(result.styleName ?? ''),
  };
}
