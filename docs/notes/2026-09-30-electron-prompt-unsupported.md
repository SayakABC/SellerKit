# Electron 里 `window.prompt` 会抛错 —— 岛/渲染层不能用它取输入

**结论**：Electron 渲染进程**不支持 `window.prompt`**，调用即抛 `prompt() is not supported.`。
`alert` / `confirm` 有实现（会弹原生样式对话框），**只有 `prompt` 没有**。
⇒ 任何"点一下 → 让用户敲一行字"的交互都必须用**自绘输入弹层**，不能用 `window.prompt`。
这类错**不会被任何门禁抓到**（类型正确、能构建、页面能挂载），只有真机点到那一步才炸。

## 取证（2026-09-30，实跑）

```bash
# 起一个隐藏窗口，在渲染进程里直接调 prompt
cat > /tmp/prompt-probe.js <<'EOF'
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<html><body>hi</body></html>');
  console.log('PROBE_RESULT ' + await w.webContents.executeJavaScript(`
    (() => { try { return 'value:' + String(window.prompt('t','')); }
      catch (e) { return 'threw:' + e.message; } })()`));
  app.quit();
});
EOF
env -u ELECTRON_RUN_AS_NODE "$(node -e "console.log(require('./node_modules/electron'))")" /tmp/prompt-probe.js --no-sandbox --disable-gpu
# 实测输出： PROBE_RESULT threw:prompt() is not supported.
```

（`env -u ELECTRON_RUN_AS_NODE` 与 `--no-sandbox --disable-gpu` 见项目既有约定——继承到
`ELECTRON_RUN_AS_NODE=1` 时 Electron 会当纯 Node 跑，拿不到 `BrowserWindow`。）

## 本仓库里现存的命中

- `ui-plugins/order-insight/dist/views/stockin.js:950`
  `const reason = window.prompt('标记「无需补货」原因（选填，如：已线下拿 / 放弃 / 退单）', '');`
  → 「拿货对账 › 待拿货缺口 › 忽略」这条功能在真机上**必然报错**（异常还会打断后面的
  `ignoreAdd` 调用与 `load/refresh`）。第一/二轮 UX 审查都没能靠静态读发现"它会抛"，只能靠实测。

## 顺手记住的判据

`window.confirm` 可以用但**不该用**（Electron 下像系统错误框、不可样式化、与自绘弹层混排在同一个产品里很难看）
—— 项目已有自绘样板：`ui-plugins/order-insight/dist/util.js:97-100`、`ui-plugins/excel-copy/dist/util.js:70-105`、
`ui-plugins/product-library` 的 `pl-mask` / `pl-dialog`。宿主侧抽 `ConfirmDialog` 的待办见
`docs/plans/UX_POLISH_PLAN.md` P1-2。

> 相关：`docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-D2/N3。
> 教训归类：**"平台能力"这类假设必须实测**，别按浏览器的常识推断 Electron。
