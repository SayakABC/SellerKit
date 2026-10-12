# Electron 44 移除了 `clipboard.writeImage` —— 「复制给厂家」在真机上一直失败（2026-10-10）

**结论先行**：用户报「复制给厂家」弹「复制失败：写入剪贴板失败」。根因是 **Electron 33→44 升级残留**：
v44 的 clipboard 重构（RFC 0019，narrow helpers 清理）**删掉了 `writeImage`**（同批还有 `readImage` /
`writeHTML` / `availableFormats`），而上一条通道是照 v33 时代 API 写的。v44 起写图只有一条路：
`clipboard.write([new ClipboardItem({ 'image/png': new Blob([...]) })])`，且 clipboard 全部方法**转 async**。

## 为什么三道门禁全绿、只有真机才暴露

| 门禁 | 为什么看不见 |
| --- | --- |
| `tsc`（主进程） | 旧实现在 `main.ts`，`require('electron')` 是 `any` —— 调不存在的成员不报错 |
| `npm run verify` | 只核**通道名**三方一致；通道名没变，照样 ✅ |
| `picking:ui` / `today:ui` | 剪贴板是**假桥**，只能验"发出去的是什么"；真写系统剪贴板这一步没人测 |

⇒ 教训：**"运行时 API 存在性"是独立于类型/契约/载荷形状的第四类缺陷**，守卫只能是真调一次真 API。

## 修法与守卫

- **新文件 `electron/clipboard-handlers.ts`**（两条剪贴板通道从 `main.ts` 外提）：新代码用 ESM
  `import { clipboard } from 'electron'` 拿**真类型** —— 再写错 API 名 `tsc` 直接红（实测：变异回
  `writeImage` → `TS2339`）。外提的另一个动机：冒烟脚本要 `require` 到 handler 才能对穿，而 `main.ts`
  是应用入口（会起窗口、开 ae-receiver），冒烟不能加载它。
- **`new Uint8Array(png)` 而非直接给 Buffer**：① BlobPart 不收 Buffer 的 `ArrayBufferLike`（类型层）
  ② Buffer 底层池化分配，给 `.buffer` 会带上池里无关字节（运行时层）。
- **文本通道同批修**：`writeText` 也转 async，补 `await` —— 不 await = "发起即成功"，写失败时错误
  落进 unhandled rejection（界面却是"已复制"）。
- **`ipc:shape:smoke` ⑧ 段（真写系统剪贴板 + 读回，23 → 28 → 30 项）**：写入前 `clipboard.clear()`
  立基态（不清的话上次残留的图会让断言蒙对）；`has('image/png')` + **读回尺寸 64×64** 内容级验证；
  拒绝分支（非 PNG / 超 8MB）；文本通道一并读回。**两条变异验过都是真守卫**：
  ① 实现退化成 `writeText` → `success:true` 那条**仍绿**、读回那条红
  ② 文本写错内容 → 读回那条红。**`success:true` 单独就是假守卫，别只报状态。**
- **渲染层 `writeClipboardImage` 失败时 `console.warn` 原始错误**：本次 `clipboard.writeImage is not
  a function` 就是在 `src/core/services/clipboard.ts` 被吞掉、多绕了一轮排查（文案仍只给用户一句人话，
  §1.10 不变）。

## 真机取证怎么做（可复跑）

- 起真宿主 + CDP：`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu
  --remote-debugging-port=9222 --user-data-dir=<真实 userData 的 cp -cR 克隆>`；Node 内置 WebSocket 直驱
  `Runtime.evaluate`（`fetch('http://127.0.0.1:9222/json/list')` 找页面）。
- 剪贴板读回用独立 Electron 进程（`app.whenReady` + `clipboard.read()`），**别在 CDP 里读**（拿不到系统剪贴板）。
- ⚠️ 主进程改动**必须重启宿主**才生效（HMR 不覆盖）—— 本次用户重启过，所以"旧 API 还在跑"的方向
  一秒排除（对编译产物与进程的启动时间戳）。
- ⚠️ 本机调试实例与用户 dev 实例**抢同一个端口**（ae-receiver 46211）：用户没关干净时调试实例
  `EADDRINUSE` 直接退出，别误读成"应用起不来"。
