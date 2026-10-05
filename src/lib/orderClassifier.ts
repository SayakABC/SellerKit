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

/**
 * 标准色名词表 —— **唯一真相源**，两处消费者：
 *   ① `VISION_PROMPT` 让模型从这里选（枚举是**注入**的，不是再抄一份）；
 *   ② 核对页的输入建议（`ClassifyPanel` 的 datalist）。
 *
 * 刻意**由字典的值域派生**而不是手写一份：手写就会出现"字典能归一成 A、词表里却没有 A"
 * 的漂移 —— 症状是提示词让模型选一个归一化认不出的词，于是又原样穿透、颜色照样分裂。
 * 顺序即字典值域的出现顺序（藏蓝/宝蓝/浅蓝/蓝色…），没有别的含义。
 */
export const COLOR_WHITELIST: readonly string[] = [...new Set(Object.values(COLOR_SYNONYMS))];

/** 去掉多余空白，去除内部空格 */
export function normalizeText(v: string): string {
  return (v || '').trim().replace(/\s+/g, '');
}

/**
 * 颜色描述里的**分段**字符：`底色+花色` 的 `+`、顿号/斜杠，以及「底/配/带/和/与」这类连接字。
 * 与 `VISION_PROMPT` 里"多色按 `底色+花色` 写、底色在前"的约定成对 —— 改一处要改两处。
 */
const COLOR_SPLIT_RE = /[+/|｜、,，]|底|配|带|和|与/;

/**
 * 一段（已按分段符切开）颜色文本 → 标准名；认不出返回空串。
 *
 * 三段，从严到宽：
 *   ① 整段命中同义字典（`黑` → `黑色`）；
 *   ② 整段命中词表（大小写/全角变体归并）；
 *   ③ **前缀回退**：识别结果常把主色当短语的开头（`白条纹`、`军绿色`、`藏蓝白条纹`），
 *      按最长前缀逐级试。为什么不扫"任意位置"：那会把 `灰蓝色` 判成 `蓝色`
 *      （前缀给 `灰色`）—— 我们的约定是**主色在前**，宁可认不出也不猜。
 */
function colorFromSegment(seg: string): string {
  const s = normalizeText(seg);
  if (!s) return '';
  const direct = COLOR_SYNONYMS[s];
  if (direct) return direct;
  const hit = (t: string): string =>
    COLOR_WHITELIST.find((c) => fullToHalf(c).toLowerCase() === fullToHalf(t).toLowerCase()) ?? '';
  const exact = hit(s);
  if (exact) return exact;
  // 前缀回退：最长 3 字（现有标准色名最长 3 字：香芋紫 / 咖啡色 / 燕麦色）
  for (let n = Math.min(s.length - 1, 3); n >= 1; n--) {
    const whole = COLOR_SYNONYMS[s.slice(0, n)];
    if (whole) return whole;
    const pre = hit(s.slice(0, n));
    if (pre) return pre;
  }
  return '';
}

/**
 * 颜色归一化：字典 → 词表 → **描述式解析**（分段取第一个认得出的）→ 原样保留。
 *
 * 为什么要有描述式这一段：提示词曾要求模型写「底色+花色」的描述（`藏蓝底白色条纹`），
 * 而归一化只做**整串**字典精确匹配 ⇒ 描述式**原样穿透**，同一个颜色两次措辞不同就成两个款色
 * （"颜色口径两头打架"）。现在两头对齐：提示词优先让模型选枚举、确要多色时按 `底色+花色` 写，
 * 归一化按同一约定**只取底色**。
 *
 * ⚠️ 认不出来时**原样保留**，不强行归类：颜色是款色（SKU 级）的区分维度，错并（两色合一色）
 * 比拆（一色成两色）更难发现、更难回退。
 */
export function normalizeColor(v: string): string {
  const t = normalizeText(v);
  if (!t) return '';
  for (const seg of t.split(COLOR_SPLIT_RE)) {
    const hit = colorFromSegment(seg);
    if (hit) return hit;
  }
  return t;
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
 * 命中别名映射则替换；**未命中保留原词**（不做强行归类，避免错误合并）。
 *
 * ⚠️ "未命中保留原词"是刻意的：品类是指纹的**第一段**（`buildStyleFingerprint`），
 * 错并（两款合一款）比拆款更难发现。但它不等于"静默"—— 词表通过与界面建议两条路可见：
 *   ① `CATEGORY_WHITELIST` 直接注入 `VISION_PROMPT`（模型只会从里面选）；
 *   ② 核对页的品类输入带 datalist 建议（标准词表 + 本库已用过的写法），用户能看见系统里
 *      已经有哪些写法 ⇒ 第二次遇到同一个词时选中同一个，而不是各写各的。
 * 加品类只能加在**这两处同源的地方**，别在别的分支里悄悄合并。
 *
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

/** 主图列关键词族（顺序即优先级；strict 版与界面默认值共用这一份，规则只此一处） */
export const IMAGE_COLUMN_KEYWORDS = ['主图', '图片', '图', 'img', 'image', 'pic'];

/**
 * 主图列**严格**探测：只有列名真的像图列才返回，**不回落第一列**。
 *
 * 为什么要有它（与 `detectImageColumn` 分开）：自动导入拿这个列名去**拆多产品行**
 * （`orderRowSplitter` 的 `cols.image`）。若回落到"第一列"，一张没有图片列的报表
 * （如速卖通 47 列订单报表，第一列根本不是图列）会被当成"有图片列" → 拆出来的行图片全空、
 * 并**逐行误标缺图**（凭空制造待补图），而且全程无异常。
 * 界面让人选列时用 `detectImageColumn`（给个默认可改），自动导入一律用本函数。
 */
export function detectImageColumnStrict(headers: string[]): string {
  return detectColumn(headers, IMAGE_COLUMN_KEYWORDS);
}

/** 主图列自动探测：先严格匹配，认不出回落第一列（**仅供界面给出可选默认值**；自动导入请用 strict 版） */
export function detectImageColumn(headers: string[]): string {
  return detectImageColumnStrict(headers) || headers[0] || '';
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
