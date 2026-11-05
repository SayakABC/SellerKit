// public/theme-init.js —— 首屏主题预置（在模块脚本之前同步执行）
//
// 为什么是独立文件而不是 index.html 里的内联 <script>：
//   index.html 现在带 CSP（`script-src 'self'`，**没有** `'unsafe-inline'`），
//   内联脚本会被直接拦下 —— 表现是"首帧闪白/闪黑"回来，且控制台一条 CSP 违规，
//   不报错、不白屏，最容易当成主题 bug 去查。内联脚本要保留就只能开
//   `'unsafe-inline'`，那等于把 CSP 对脚本注入的防护整条作废。
//   public/ 下的文件由 vite 原样拷贝，`<script src="/theme-init.js">` 在 base='./' 下
//   会输出相对路径 `./theme-init.js`，file:// 打包环境同样有效。
//
// 逻辑与原来的内联版本逐行一致（改这里等价于改首帧行为，别顺手优化）：
//   真正的主题模式存在 electron-store（appearance 命名空间），只能经 IPC 异步读，
//   而 initTheme() 要等应用 onMounted 之后才跑 —— 在那之前 <html> 上没有 data-theme。
//   这里用**同步**可得的 prefers-color-scheme 先定初值，覆盖"跟随系统"的多数用户；
//   显式选过浅色/深色的用户会在 initTheme() 落定后被校正（只差一帧，方向一致）。
(function () {
  try {
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    document.documentElement.setAttribute('data-theme', mql.matches ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
