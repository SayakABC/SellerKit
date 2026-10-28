# 「打开店铺」优先用 Chrome 打开（没装才回落系统默认浏览器）

**结论（先看这段）**

1. **`shell.openExternal` 只能开"系统默认浏览器"，开不了"指定浏览器"**。Electron 这个 API
   没有"用哪个 app 打开"的参数，且 `shell.openExternal` 的第二个参数（`activate` / `workingDirectory`）
   也管不到应用选择 ⇒ 要指定浏览器只能自己起进程（`open` / `chrome.exe`）。
   原实现就是 `shell.openExternal(url)`：默认浏览器不是 Chrome 时，「打开店铺」开在**没有采集扩展的
   浏览器**里，用户看到的是"页面开了，但找不到采集按钮"——而且他没有任何线索知道为什么。
2. **为什么必须是 Chrome**：SellerKit 的采集能力由 Chrome MV3 扩展（`SellerKitExtensions` /
   `ae-profit`）提供，「打开店铺」这个按钮的**下一步动作**就是点扩展的采集按钮。
   所以"用哪个浏览器"不是审美偏好，是**动线的一部分**。
3. **两件事不能合并成一个概念**（本轮的设计边界）：
   - 「用哪个浏览器」= 本次是**固定策略**（Chrome 优先，无设置项、无 UI）；
   - 「Chrome 到底能不能用」= **运行时事实**，随时可能为假 ⇒ **探测失败必须回落**，
     绝不返回失败。回落代价只是"少了采集扩展"（用户至少看到了页面），报错的代价是"入口失效"。
     别把探测结果写成用户偏好值：偏好被改坏 / 装了挪位置的 Chrome，都会退化成"点了没反应"。
4. **判据按平台各写一份，不能抄**（三个平台的失败信号完全不同）：
   - **macOS**：`open -b com.google.Chrome <url>`。⚠️ 找不到 app 时**命令本身是成功的**
     （`spawn` 不报错、没有 `error` 事件），失败**只体现在退出码 1** ⇒ 必须看 `exit code === 0`。
   - **Windows**：按已知安装路径找 `chrome.exe`（用户级 `%LOCALAPPDATA%\Google\Chrome\Application\`
     才是默认落点，不能只看 Program Files）。⚠️ chrome.exe 若**已在运行**，它自己就是常驻进程，
     `exit` 可能永远不来 ⇒ 靠**超时判成功**（"还活着" = 浏览器起起来了）。
   - **Linux**：按 PATH 依次试 `google-chrome` / `chromium` 等命令名，靠 `error`(ENOENT) 判"这个命令不存在"。
5. **只改主进程一处出口，渲染层零逻辑改动**：两个「打开店铺」入口
   （「待关联采集商品」段的下拉、「基础数据 › 店铺登记」行内的「打开」）都走 `open-external`
   通道 ⇒ 通道形状、入参、中文错误文案一字未变。

## 取证

**改动点**

| 位置 | 内容 |
| --- | --- |
| `electron/browser-open.ts`（新增） | `openUrlInPreferredBrowser(url)`：Chrome 优先 + 按平台探测 + 失败回落 `shell.openExternal`；返回 `'chrome' \| 'system'`（只用于观测，不决定成败） |
| `electron/clipboard-handlers.ts` | `open-external` 的 `shell.openExternal` 换成 `openUrlInPreferredBrowser`；`shell` import 撤掉；注释说明"优先 Chrome"的理由 |
| `electron/main.ts` / `preload.ts` / `src/types.ts` / `src/core/services/ipc.ts` / `useSkuPool.ts` / `PoolPane.vue` / `ShopRegistryView.vue` | 注释同步（"系统默认浏览器" → "优先 Chrome，用不了回落系统默认"）；**无逻辑改动** |

**真机实测（darwin，2026-10-16）**

```
# ① 关键判据：找不到 app 时命令成功但退出码非 0（只按 spawn error 判会永远判成功）
$ open -b com.google.chrome.definitely.missing https://www.example.com/
LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application ...
EXIT_NONEXISTENT=1

# ② 正路：真跑 openUrlInPreferredBrowser（electron 主进程内）
RESULT=chrome MS=60

# ③ 回落：把 bundle id 变异成不存在的（改 dist 里的常量）后重跑
RESULT=system MS=33      # 走 shell.openExternal，无异常、无未捕获拒绝
```

**变异/还原**：改的是 `dist/electron/browser-open.js`（源码没留开关）；跑完从备份回拷并
`npx tsc -p tsconfig.electron.json` 重编，`grep` 确认常量回到 `com.google.Chrome`（本仓既有坑：
还原后不编译 = 后续门禁红在残留变异体上）。

**未实测（下次接手须知）**

- **Windows / Linux 分支**：本机是 darwin，这两条路径只有代码推理，没有实跑。
  Windows 首次落地时**必须**实测两件事：① 用户级安装（`%LOCALAPPDATA%`）能被找到；
  ② Chrome **已运行**时 `spawn` 的进程不退出 ⇒ 不能等 `exit` 才判成功（现靠超时兜）。
- **Chrome 冷启动**：实测那次 Chrome 已在运行（`open` 立即退出码 0）。冷启动时 `open` 同样
  立即返回、不等 app ready，判据不受影响，但没有实测样本。

## 坑（下次照着绕）

1. **⭐ 平台 API 的"失败信号"必须真机跑一次才知道落在哪**。`open -b` 找不到 app 时不报 spawn 错，
   只在退出码上体现 —— 如果按"spawn 没抛错就算成功"写，Chrome 缺失时会**静默不回落**，
   表现正是"点了按钮什么都没发生"（本条改动本来要修的就是这类症状）。
2. **浏览器是常驻进程**：`spawn` 必须 `detached: true` + `stdio: 'ignore'` + `unref()`，
   否则 Electron 退出会被子进程拦住（Windows 上还多一条 `windowsHide: true`，防闪控制台窗口）。
3. **electron 的 `process.argv` 会被 Chromium 开关占位**：实测
   `argv.slice(1) === ["--no-sandbox","--disable-gpu","/tmp/x.cjs"]` ⇒ 写一次性探针脚本时别用
   `process.argv[2]` 取参数（会拿到脚本路径，函数收到 `undefined` 后落到 `shell.openExternal`
   报 `Invalid URL`，看起来像"实现有 bug"）。用环境变量传参。
4. **别为这条加"设置项"**（本轮明确不做）：加了就变成"用户可以把入口改坏成没有扩展的浏览器"，
   而失败时没有任何提示能救回来。要放开也得先有"当前浏览器是否装了扩展"的判据。
