// src/theme.js — 岛内 color-scheme 跟随宿主主题。
//
// 背景：宿主只把 --wb-* 令牌以**内联样式**写到岛的 <html>（见 electron/plugin-ui-runtime.js
// 的 applyTheme），**不会**同步 data-theme 属性。而 color-scheme 不在令牌里，
// 若写死 light，深色主题下原生控件（日期选择器、下拉、滚动条、输入框光标）仍会是浅色，
// 这是 iframe 岛最容易被忽略的观感破口。
//
// 做法：读 --wb-bg 的实际值判断深浅，回写 documentElement.style.colorScheme；
// 用 MutationObserver 监听宿主后续的主题推送（内联 style 变更），实现跟随切换。
//
// 历史坑（2026-09-21）：这里原本用一个只认 `rgb()/rgba()` 的正则解析颜色，
// 但 **自定义属性的 getPropertyValue 返回的是声明原文**（宿主 index.css 里是十六进制
// `#f6f7f9` / `#15171c`），并不是运算后的 rgb()。于是正则必然不匹配 → 函数静默 return →
// color-scheme 永远停在 style.css 里写死的 light，深色主题下所有原生控件都是浅色，
// 表现为「岛内样式跟宿主主题不一致」。现改为交给浏览器做颜色归一化（见 normalizeColor），
// 从而同时支持 hex / rgb / hsl / 命名色 / color-mix 等各种写法。

/**
 * 借浏览器把任意合法 CSS 颜色归一化成 rgb()/rgba() 文本。
 * 自定义属性拿到的是声明原文，直接正则匹配会漏掉 hex 等形式，故用探针元素让引擎解析。
 * @returns {string|null} 归一化后的颜色，无法解析时返回 null
 */
function normalizeColor(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.color = raw;
  // 浏览器不认这个值时，赋值会被丢弃 → style.color 为空
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  let computed = '';
  try {
    computed = getComputedStyle(probe).color || '';
  } finally {
    probe.remove();
  }
  return /^rgba?\(/.test(computed) ? computed : null;
}

/** 相对亮度（WCAG 2.x）；无法解析时返回 null */
function luminanceOf(color) {
  const normalized = normalizeColor(color);
  if (!normalized) return null;
  const m = normalized.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 依据 --wb-bg 亮度回写 color-scheme（无法判定时保持现状） */
export function syncColorScheme() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const lum = luminanceOf(cs.getPropertyValue('--wb-bg'));
    if (lum === null) return;
    const next = lum < 0.5 ? 'dark' : 'light';
    const el = document.documentElement;
    // 幂等：本函数由「<html style> 变更」的 MutationObserver 触发，而它自身又写这份 style。
    // 不比较就写会形成变更循环，故仅在值变化时才落笔。
    if (el.style.colorScheme !== next) el.style.colorScheme = next;
  } catch {
    /* 计算失败不影响渲染 */
  }
}

/** 挂载主题跟随：首帧 + 宿主每次推送主题后同步一次 */
export function watchTheme() {
  syncColorScheme();
  if (typeof MutationObserver === 'undefined') return () => {};
  const ob = new MutationObserver(syncColorScheme);
  ob.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => ob.disconnect();
}
