// extensions/order-insight/src/lib/colorSwatch.ts
// 款色色块字典 —— **业务数据，不是主题色，不参与主题切换**（C-09 / R3-5）。
//
// 为什么不令牌化：这些 hex 表达的是"红色/藏青/军绿"这类**现实世界颜色**，
// 与 --wb-* 主题令牌（界面底色、边框、语义色）是两套完全不同的语义。
// 把"红色"映射成主题变量会导致：① 深色主题下"白色"款色变成深灰块，颜色识别失效；
// ② 色卡本身是业务数据（款色来源于订单 Excel 的"款色"列），需与真实颜色一致。
//
// 因此本文件集中存放色值，组件不再直接出现 hex；新增颜色只改这里。

/** 常见颜色名 → 色值（键为中文色名；匹配时用 `includes`，故"深蓝色"能命中"蓝色"） */
export const COLOR_SWATCH: Record<string, string> = {
  黑色: '#3a3a3a',
  白色: '#f5f5f5',
  红色: '#d64545',
  蓝色: '#3b6fd4',
  绿色: '#3d9a5c',
  黄色: '#e8c23d',
  橙色: '#e8853d',
  紫色: '#8b5ec9',
  粉色: '#e89ab6',
  灰色: '#9a9a9a',
  棕色: '#8a6a4f',
  米色: '#d9c9a8',
  卡其: '#c3b091',
  藏青: '#2f3b5e',
  军绿: '#5b6b46',
  酒红: '#7d2f3a',
};

/** 未识别色名的兜底中性灰（同样不随主题变化，保证色块语义稳定） */
export const UNKNOWN_SWATCH = '#b9bdc7';

/** 查询款色色块：按字典顺序做子串匹配，未知返回中性灰 */
export function swatchOf(color: string): string {
  const c = (color || '').toLowerCase();
  for (const [name, value] of Object.entries(COLOR_SWATCH)) {
    if (c.includes(name)) return value;
  }
  return UNKNOWN_SWATCH;
}
