# 「共享实现被覆盖」≠「调用点被覆盖」：给一个 Electron handler 补冒烟

## 结论

把一段逻辑**抽成共享函数**、并给那个函数写了冒烟，**不等于**用它的 handler 被测了。
本项目 2026-10-05 的实例：`purchase-export-excel`（拿货单带图导出）在 `scripts/` 下
**没有任何脚本 require 过 `purchase-handlers`** —— 它当时带着与拣货单**同一个**
exceljs `extension` 真 bug，而 `picking:xlsx:smoke` 只覆盖了修好之后抽出来的那个共享函数
`xlsx-image.embedCellImage`。

调用点独有的东西，只有调用点能验：

| 只在调用点可见 | 具体到这轮 |
| --- | --- |
| 行映射 / 字段长度约束 | `it.styleCode` / `styleName` / `color` / `size` / `qty` / `priceCents` |
| 业务口径 | `单价 = priceCents/100`、`金额 = 数量 × 单价`、`priceCents===0` 与 `qty===0` **留空**（不是 0.00） |
| 何时去查图 | 只在 **款编码 且 款色** 都非空时；空款色照常导表、只是没图 |
| 分支护栏 | 取消保存 → 一个字节都不写；`items` 超 500 截前 500；洗完没行 → `没有可导出的行` |
| 传图源的方式 | `{ filePath }` 还是 `{ base64 }`（决定媒体扩展名是 png 还是 jpeg） |

## 做法：真 Electron 里截获真 handler

新增 `scripts/purchase-xlsx-smoke.cjs`（`npm run purchase:xlsx:smoke`，26 项）。
沿用 `scripts/preload-ipc-shape-smoke.cjs` 的范式，**只换四件**，其余保持真实：

```js
const realElectron = require('electron');
const fakeElectron = new Proxy(realElectron, {
  get(t, p) {
    if (p === 'ipcMain') return { handle: (c, fn) => handlers.set(c, fn), /* … */ };
    if (p === 'dialog') return { showSaveDialog: async (...) => /* 可控路径 / canceled */ };
    if (p === 'BrowserWindow') return { getFocusedWindow: () => null, getAllWindows: () => [] };
    if (p === 'app') return { getPath: () => tmpDir };
    return t[p];
  },
});
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, [request, ...rest]);
};
require(path.join(ROOT, 'dist', 'electron', 'purchase-handlers.js')); // 注册进 fakeIpcMain
```

三个要点：

1. **必须真 Electron**：require 链里有 `better-sqlite3`（Electron ABI）。
   沙箱里 `ELECTRON_RUN_AS_NODE=1` 常驻 ⇒ `env -u ELECTRON_RUN_AS_NODE` 去掉再跑，
   否则 `require('electron')` 只返回一个字符串路径，报的是不知所云的
   `Cannot read properties of undefined (reading 'handle')`。脚本开头有早退护栏直接说明跑法。
2. **只 stub 依赖的"叶子"**：`order-db.findStyleColorImagePath` 换成可控映射即可 ——
   handler 里是 `const orderDb = require('./order-db')`，拿的是**同一个 exports 对象**，
   改属性即生效（不必碰 `require.cache`）。素材用**真图**（`build/icon.png`）：
   造假文件会让"按原始比例算显示高度"永远测不到。
3. **"取消"要断言"没多出文件"**，不是断言某一条路径不存在 —— 后者挡不住
   "取消后写到某个默认路径"这类 bug。写成：输出目录里 `.xlsx` 数量为 0。

## 变异复核（7 组，都逐组确认变红后复原）

价格留空 · qty=0 金额留空 · 过滤条件（只认款编码）· 500 上限 · 取消分支（含"写到默认路径"）·
`extension` 缺失 · 单张坏图不再被吞。

⚠️ **其中一组第一次没变红**：把 `sniffImageFormat` 结果的 `return null` 改成 `throw` ——
冒烟照绿。因为那个 `throw` 就在**外层 `try/catch` 里面**，被自己吞掉了（`return null` 才是最终行为）。
改打在**真守卫点**（`return null` + 外层 `catch { return null }` 同时拆掉）之后才红。
这印证了老规矩：**变异补丁要打在真正的守卫点，否则"没变红"什么都不能证明**。

## 取证

```bash
npm run purchase:xlsx:smoke     # 26 项；改过 electron/*.ts 后脚本自带 tsc
grep -rn MUTANT src/ scripts/ tests/ electron/   # 收工必须为空
```

- 脚本：`scripts/purchase-xlsx-smoke.cjs`；npm script 在 `package.json` 的 `purchase:xlsx:smoke`
- 被验的 handler：`electron/purchase-handlers.ts:303` 的 `register('purchase-export-excel', …)`
- 共享实现与它的坑：`electron/xlsx-image.ts`（文件头）、`docs/notes/2026-10-05-picking-export-with-images.md`
- 基线登记：`docs/baseline/PROJECT_BASELINE.md` 的冒烟总表新增一行
