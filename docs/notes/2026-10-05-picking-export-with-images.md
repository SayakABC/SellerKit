# 带图 xlsx 导出：三个真 bug 与「同步/异步两条路径」的写法差异

> 起因：S3 拣货单升级（`docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §6）要产出一份**能直接发厂家**的
> 带图 xlsx。做完发现三个 bug —— 前两个**同样存在于既有的拿货单导出**，第三个是**冒烟脚本的假绿**。
> 三条都有可复制的取证。

## 结论速览

| # | 症状 | 根因 | 判据 / 纪律 |
| --- | --- | --- | --- |
| ① | Excel 提示"需要修复"并丢图；`xl/media/image1.undefined` | exceljs `addImage({ filename })` **不给 `extension`** | 扩展名**按文件内容推**（不是按文件名），并显式传 `extension`；包结构合法性要**读回 `[Content_Types].xml` 验** |
| ② | 主进程拿不到图（既转不了码也拿不到宽高） | **Electron `nativeImage` 解不了 WebP** | 图**归渲染层编码**（Chromium 有 WebP 解码），主进程只收 base64 + 尺寸 |
| ③ | 冒烟报"失败"，**退出码却是 0** | `process.exit(1)` 之后再跟 `process.exit(0)` | **同一段流程只调一次 `process.exit`**；`process.exitCode = 1` 在 Electron 下**不退出** |
| ④ | 一件价都没查到，界面写 `预估 ¥0.00` | 把"未知"表达成 0 | 并列金额的地方走**同一对函数**：全缺 → `—` +「N 件全部无进价」；部分缺才叫"不含" |

---

## ① exceljs：忘给 `extension` ⇒ 包结构不合法（**返回值里看不出来**）

**取证**（`scripts/picking-xlsx-smoke.cjs` 的断言输出）：

```
✗ xl/media 条数应为 2，实际 3（xl/media/, xl/media/image2.undefined, xl/media/image1.undefined）
```

读回 `[Content_Types].xml` 看到的是 `<Default ContentType="image/undefined"/>` ——
**连 `Extension` 属性都是空的**。而 OPC 要求每个 part 都有内容类型 ⇒ 包不合法 ⇒
Excel 走修复流程、**图被丢掉**（用户只看到"格式有点问题"，不会知道图没了）。

⚠️ 关键点：**这个 bug 在"导出成功"的返回值里完全看不出来** —— `wb.xlsx.writeFile()` 正常返回，
`fs.writeFileSync` 正常返回，函数返回 `{ filePath, rows, images }` 里 `images` 还是对的
（因为图确实被 `addImage` 登记了）。只有**读回 zip 看部件名**才能发现。

修法（`electron/xlsx-image.ts`）：

```ts
const fmt = sniffImageFormat(head);       // 按**内容**嗅探（PNG/JPEG 文件头）
if (!fmt) return null;                    // 认不出内容类型 → 嵌进去也是打不开的图
addImageArg = { filename: p, extension: fmt };   // ⚠️ extension 必须给
```

**为什么要按内容推而不是按文件名**：存量图里有"**内容是 PNG、名字是 `.jpg`**"的（当初保存时按
订单给的扩展名落盘）。按名字推 ⇒ 写 `xl/media/image1.jpg` 但内容不是 JPEG ⇒ 又是打不开的图。

同源修复：`electron/purchase-handlers.ts` 原先自己抄了一份 `imageSizeOf` + 同样的
`addImage({ filename })` ⇒ **既有的拿货单导出**一并改为共用 `embedCellImage`。

---

## ② Electron `nativeImage` 解不了 WebP ⇒ 图必须由渲染层编码

**取证**（真 Electron + `env -u ELECTRON_RUN_AS_NODE`，对 4 张真实订单图跑）：

```
nativeImage.createFromPath('/…/img-3.webp')   → isEmpty() = true
nativeImage.createFromBuffer(buf, {width:1})  → isEmpty() = true
```

而**真实订单图 8/9 张内容是 WebP**（文件名 `.webp`，另有一张"内容是 webp、名字是 `.jpg`"）。

⇒ 主进程在 WebP 上**既转不了码也拿不到宽高**，只能把 webp 原件塞进 xlsx；
旧版 Office / WPS 显示不出来 —— 与"发厂家"的用途直接冲突。

**修法（分层，而不是在主进程里硬解）**：

```
渲染层  <img> → canvas → toDataURL('image/jpeg', 0.85) → { base64, width, height }
主进程  embedCellImage(wb, ws, row, { base64, width, height })
```

- 渲染层 = Chromium，**自带 WebP 解码**；`src/lib/pickingExport.ts` 的 `domToJpeg` **永不 reject**
  （单张坏图不阻断导出），JPEG 无透明通道 ⇒ **先铺白底**再画。
- 顺带的好处：主进程**不再需要"按渲染层给的路径读任意文件"**（少一个路径穿越面）。
- ⚠️ 环境坑：本机 shell 里 `ELECTRON_RUN_AS_NODE=1` 常驻时 `nativeImage` 是 `undefined`，
  跑真 Electron 探针要 `env -u ELECTRON_RUN_AS_NODE`。

---

## ③ 冒烟"失败"却以退出码 0 结束（**跨脚本假绿**）

**取证**（`scripts/picking-xlsx-smoke.cjs` 的变异副本，把 `sheets.length` 断言从 2 改成 3）：

```
✗ 拣货单 xlsx 冒烟失败：1 项
✓ 拣货单 xlsx 冒烟全部通过          ← 两行都打印了
exit code = 0                       ← 红的被报成绿
```

原写法：

```js
if (failed > 0) { console.log(`✗ …失败：${failed} 项`); process.exit(1); }
console.log('✓ …全部通过');
process.exit(0);                    // ← 这一行照样执行，退出码 0
```

定性探针（真 Electron，两模式都测）：

| 写法 | 结果 |
| --- | --- |
| `process.exit(1)` 在**顶层同步**代码里 | `exit=1`（正常，进程真的终止） |
| `process.exit(1)` 在**异步续体**里 | `exit=1` |
| `if (...) exit(1)` 之后**再跟** `exit(0)` | **`exit=0`** —— 两次 log 都打印 |
| `process.exitCode = 1`（不调 `exit`） | **不退出**（事件循环不空，实测挂住） |

**纪律：同一段流程里只调一次 `process.exit`**，写成单点：

```js
console.log('');
if (failed > 0) console.log(`✗ …冒烟失败：${failed} 项`);
else console.log('✓ …冒烟全部通过');
process.exit(failed > 0 ? 1 : 0);   // 唯一的退出点
```

⚠️ **存量风险（本轮未清）**：`scripts/*.cjs` 的一批 DB 冒烟（`picking-db` / `order-db` / `ae-cost` /
`style-authority` / `schema-migration` / `shop-db` / `ship-rate-db` …）多是同款 `if(failed){…exit(1)} … exit(0)`
写法。它们的引导脚本（`npm run x:smoke` → `electron scripts/x.cjs`）**退出码在 node 模式下确认真实透传**，
所以作为门禁暂时有效；但**"后来又 exit(0)"这个结构本身没清**，一次重构就可能把红变成绿。

---

## ④ 「未知」不能写成 0（截图复核发现的表达失真）

一件价都查不到时，段标题与顶部指标写的是 `预估 ¥0.00` —— 读起来是"这批货不值钱"，
而事实是"还不知道多少钱"。**0 有两种含义（真的不要钱 / 没查到价），写 0 会让"估算偏低"和
"真的很便宜"长得一模一样。**

这是**拍图拍出来的**（冒烟全绿：断言只钉了正例"有价的段写 ¥60.00"，没钉"全无价时不许写 ¥0.00"）。

修法：并列金额的地方**走同一对函数**（`src/modules/picking/PickingView.vue`）：

```ts
function amountText(amount: number, noPricePieces: number, pieces: number): string {
  if (noPricePieces > 0 && noPricePieces >= pieces) return '—';   // 全缺 → 不写 0
  return `¥${money(amount)}`;
}
function noPriceNote(noPricePieces: number, pieces: number): string {
  if (noPricePieces <= 0) return '';
  return noPricePieces >= pieces
    ? `（${noPricePieces} 件全部无进价）`   // 全缺：说"全部"
    : `（不含 ${noPricePieces} 件无进价）`;  // 部分缺：才叫"不含"
}
```

同一条纪律在**导出**侧也一样：无价的行金额写 `undefined`（Excel 里留空），**不写 0**
（`picking:xlsx:smoke` 有断言：读回来必须是 `null`）。

---

## 附：这一层的"口径不搬"原则

导出链的最终形态是 **「渲染层算口径 + 编码图，主进程只画表」**：

- 进价复用 `orderCost.pickUnitCost`（款级成本区间，按**该行的下单日期**取当时生效的那条）+
  同一份 `round2` ⇒ 拣货页与「算钱」页不会出现"同一条订单两种成本"。
- `electron/picking-xlsx.ts` **不 import 任何 `*-db`**，只吃"已经算好的行"。
- ⇒ 结构上不可能出现"屏幕上的数与导出的数不一致"。

## 相关

- 计划与执行记录：`docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §6 S3 执行记录
- 变更史：`CHANGELOG.md` `[Unreleased]` 的 S3 条
- 同族笔记：[`2026-10-01-ui-style-system-audit.md`](2026-10-01-ui-style-system-audit.md)（无头截图器怎么来）、
  [`2026-10-03-hint-is-not-an-entry.md`](2026-10-03-hint-is-not-an-entry.md)（「全零不是正确表达」）、
  [`2026-10-05-daily-flow-card.md`](2026-10-05-daily-flow-card.md)（注入脚本注释不能含反引号）
