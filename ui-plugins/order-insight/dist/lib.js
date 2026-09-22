// dist/lib.js
// 岛内纯函数库：从宿主 src/lib/orderClassifier.ts 与 src/lib/styleMatcher.ts 同语义移植。
// 无副作用、无依赖；指纹算法必须与主进程 order-db.ts 的款/款色匹配保持同源，
// 否则「同款两张图」会被拆成两个款编码（因此两处算法改动需同步）。

/** 美式 retained: 全角 → 半角 */
function fullToHalf(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

const COLOR_SYNONYMS = {
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

/** 款式大类白名单（与视觉提示词中要求模型选择的固定列表同源） */
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
];

const CATEGORY_ALIASES = {
  't恤': '短袖T恤',
  't恤衫': '短袖T恤',
  't桖': '短袖T恤',
  tee: '短袖T恤',
  '套头衫': '卫衣',
  '连帽衫': '卫衣',
  hoodie: '卫衣',
  '夹克': '外套',
  '大衣': '外套',
  jacket: '外套',
  '打底裤': '长裤',
  '运动裤': '长裤',
  '阔腿裤': '长裤',
  '牛仔': '牛仔裤',
};

const EMPTY_LIKE = new Set(['', '无', '未知', '未识别', '其他', 'none', 'null', 'undefined', '-']);

/** 去首尾空白并压缩内部空白（颜色/款名等短文本归一化用） */
export function normalizeText(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, '');
}

/** 指纹用强归一化：小写 + 全角转半角 + 非字母数字转空格 + 压缩空格 */
export function normalizeKey(s) {
  return fullToHalf(String(s ?? ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 颜色归一化：命中同义词则替换 */
export function normalizeColor(v) {
  const t = normalizeText(v);
  if (!t) return '';
  return COLOR_SYNONYMS[t] || t;
}

/** 款式归一化：白名单/别名归并，未命中保留原词（不强行合并，避免误归一类） */
export function normalizeCategory(v) {
  const t = normalizeText(v);
  if (!t || EMPTY_LIKE.has(t.toLowerCase())) return '';
  const key = normalizeKey(t);
  if (CATEGORY_ALIASES[normalizeKey(t)]) return CATEGORY_ALIASES[normalizeKey(t)];
  const exact = CATEGORY_WHITELIST.find((c) => normalizeKey(c) === key);
  return exact || t;
}

/**
 * 构建款式指纹：归一化品类 + 排序去重的归一化特征，以 '|' 连接。
 * 指纹相等即视为同一款式（规避 LLM 命名漂移）。
 */
export function buildStyleFingerprint(category, features) {
  const cat = normalizeKey(category);
  const feats = [...new Set((features || []).map((f) => normalizeKey(f)).filter(Boolean).sort())];
  return [cat, ...feats].filter(Boolean).join('|');
}

/** 款式展示名（仅展示，不参与匹配） */
export function buildStyleDisplayName(category, features) {
  const cat = String(category ?? '').trim();
  const feats = (features || []).map((f) => String(f).trim()).filter(Boolean);
  return feats.length ? `${cat} ${feats.join(' ')}`.trim() : cat || '未命名款式';
}

/** 识别结果 → 入库前归一化字段 */
export function classifyResult(result) {
  return {
    category: normalizeCategory(result.category),
    color: normalizeColor(result.color),
    logo: normalizeText(result.logo),
    styleName: normalizeText(result.styleName ?? ''),
  };
}

/** 按关键词探测列：返回原始列名，未命中返回 '' */
function detectColumn(headers, keywords) {
  if (!headers.length) return '';
  const lower = headers.map((h) => String(h).toLowerCase());
  for (const kw of keywords) {
    const idx = lower.findIndex((h) => h.includes(kw));
    if (idx !== -1) return headers[idx];
  }
  return '';
}

/** 主图列自动探测 */
export function detectImageColumn(headers) {
  return detectColumn(headers, ['主图', '图片', '图', 'img', 'image', 'pic']) || headers[0] || '';
}

/** 订单号列自动探测 */
export function detectOrderNoColumn(headers) {
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

/** 店铺列自动探测 */
export function detectShopColumn(headers) {
  return detectColumn(headers, ['店铺名', '店铺', '店名', 'shop', 'store']);
}

/** 尺寸列自动探测 */
export function detectSizeColumn(headers) {
  return detectColumn(headers, ['尺寸', '尺码', 'size']);
}

/** 下单时间列自动探测 */
export function detectOrderTimeColumn(headers) {
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
