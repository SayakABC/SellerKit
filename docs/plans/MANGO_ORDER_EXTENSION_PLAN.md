# 芒果订单自动同步 · 扩展路线实施方案

> **前提更新**：芒果登录态在你自己的 Chrome 里，且芒果可能有多个账号。
>
> 这两条把上一版 `ORDER_AUTO_SYNC_PLAN.md` 的路线判断整个反转了。

---

## 0. 路线反转：扩展是正解，内嵌窗口作废

上一版推荐"Electron 隐藏窗口 + 持久化分区"，理由是"不依赖浏览器开没开"。

**登录态在 Chrome 里这条信息出来后，这个推荐就错了**：

| | 内嵌窗口（上版推荐） | Chrome 扩展（本版） |
|---|---|---|
| 登录成本 | 要在 Electron 里**重新登录一次** | **0**，直接用 Chrome 的会话 |
| 单点登录风险 | 有，可能踢掉 Chrome 里的会话 | **无**，就是同一个会话 |
| 多账号 | 一个分区一套登录，难隔离 | 天然靠 Chrome Profile 隔离 |
| 抓取能力 | 强（可读 XHR、可翻页） | 强（`world: MAIN` 后等同） |
| 依赖 | 应用自己 | Chrome 被唤起 |
| 现有资产 | 0 | **扩展已存在，popup/options/推送全在** |

**代价只有一个**：Chrome 必须被唤起。而这个代价换掉了"重新登录 + 单点登录风险 + 多账号隔离"三件事，非常划算。

---

## 1. 现状：扩展比想象中完整，但权限一个都不够

`SellerKitExtensions/extensions/ae-profit` 已有：

- ✅ `options.html/js`：配置 `aeHost / aePort / aeToken` → `chrome.storage.local`
- ✅ `background.js` 的 `send()` / `ping()`：POST 到 `127.0.0.1:46211`
- ✅ `popup.html`：探测本地应用、手动触发采集、进度显示
- ✅ `content.js`：速卖通的商品/SKU 采集（**订单采集 0.5.0 已移除**）

**缺的是权限与匹配**：

```json
"permissions": ["storage", "activeTab", "scripting"],        // ❌ 缺 alarms（定时）、tabs（开/关标签页）
"host_permissions": [...三个速卖通域名..., 127.0.0.1]        // ❌ 缺 mangoerp.com
"content_scripts.matches": [...速卖通...]                    // ❌ 缺芒果页面
```

三处都要加，一个不加就跑不起来。

**宿主侧比预想的完整**（这三项常被误判为"没做"）：

| 能力 | 位置 | 状态 |
|---|---|---|
| 用 Chrome 打开指定 URL | `electron/browser-open.ts:108` `openUrlInPreferredBrowser()` | ✅ 已有，含平台差异处理 |
| 芒果账号（含加密密码） | `sk_tool_accounts` + `revealToolAccountPassword()` | ✅ 已有，实测 1 个 erp 账号管 16 店 |
| 店铺 ↔ 账号关联 | `sk_shops.erp_account_id` | ✅ 16/16 已关联 |
| 订单接收端 | `ae-receiver.ts` `/ae/ingest` | ✅ 现成（但从未被喂过） |
| 开机自启 / 托盘 / 定时 | — | ❌ 三项全无 |

---

## 2. 最大的技术坑：content script 默认 hook 不到页面 XHR

这是这类抓取**最容易翻车**的地方，必须写在最前面：

> content script 运行在 **isolated world**，它看到的 `XMLHttpRequest.prototype` 和 `window.fetch` 是**独立副本**。你在 content script 里 hook，页面自己的请求**一个都拦不到**。

两条解法：

**① `world: "MAIN"`（推荐，Chrome 111+）**

```json
{
  "matches": ["https://www.mangoerp.com/*"],
  "js": ["src/mango-main.js"],
  "world": "MAIN",
  "run_at": "document_start"
}
```

`run_at: document_start` 是必须的——晚于页面首个请求就漏了首页数据。

**② 动态注入 `<script>` 标签**（兼容老版本 Chrome）

```js
const s = document.createElement('script')
s.src = chrome.runtime.getURL('src/mango-main.js')
s.onload = () => s.remove()
;(document.head || document.documentElement).appendChild(s)
```

需要 `web_accessible_resources` 声明。

**两个坑连在一起**：MAIN world 里**没有 `chrome.runtime`**。所以必须两段式：

```
mango-main.js (MAIN world)      hook XHR/fetch → window.postMessage
        ↓
mango-bridge.js (isolated)      监听 message → chrome.runtime.sendMessage
        ↓
background.js (service worker)  解析 → 映射成 AeIngestOrder → POST 46211
```

---

## 3. 抓取实现

### 3.1 hook 骨架

```js
// mango-main.js —— world: MAIN, run_at: document_start
;(() => {
  const HIT = /order|list/i
  const relay = (url, text) => {
    try { window.postMessage({ __skMango: 1, url, body: text }, location.origin) } catch {}
  }

  const origFetch = window.fetch
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
      if (HIT.test(url)) res.clone().text().then((t) => relay(url, t)).catch(() => {})
    } catch {}
    return res
  }

  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__skUrl = u
    return origOpen.call(this, m, u, ...rest)
  }
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (HIT.test(this.__skUrl || '')) relay(this.__skUrl, this.responseText)
    })
    return origSend.apply(this, args)
  }
})()
```

```js
// mango-bridge.js —— isolated world
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__skMango !== 1) return
  chrome.runtime.sendMessage({ type: 'MANGO_PAYLOAD', url: e.data.url, body: e.data.body })
})
```

⚠️ `HIT` 正则**必须先用真机请求路径校准**。我无法看到你的芒果后台，接口路径是 `/api/order/list` 还是 `/erp/order/page` 只能在 DevTools → Network 里看一眼。

### 3.2 为什么不用 DOM 解析

芒果是 SPA + hash 路由。DOM 解析的问题是：

- 表格列可能虚拟滚动，滚动区外的行**不在 DOM 里**
- 改版后选择器失效，而你**不会知道**——只是抓到的条数变少
- 分页按钮的文案/结构不稳定

接口 JSON 是数据的源头，字段全、结构稳、翻页可控。**DOM 只作兜底**：当 hook 连续 N 次没命中时降级，并**上报"降级了"**，不要静默。

### 3.3 翻页

待发货几百单必然分页。hook 到第一个请求后就知道参数格式（`page` / `pageNum` / `offset`），两条路：

- **重放请求**（快）：在 MAIN world 里按原参数改 page 循环请求。注意可能有 `timestamp` / `sign` 参数，要原样带上。
- **点下一页**（稳）：注入点击 → 等 hook 到新响应 → 重复。慢但不怕签名。

**先用重放，失败自动降级到点击。**

### 3.4 字段映射

采集帧（`AeIngestOrder`，`ae-db.ts:84`）字段：

| 芒果字段 | 目标 | 说明 |
|---|---|---|
| 订单号 | `orderId` | 幂等键 |
| **订单状态** | `status` | **→ `biz_status`，晨报的唯一前提** |
| 店铺名 | `shopName` | 映射 `sk_shops`，多账号靠它区分 |
| 下单时间 | `orderTime` | 交期倒推 |
| 币种 / 金额 | `currency` / `goodsAmount` | 利润 |
| 产品ID / 规格 / 数量 / 图片 | `lines[]` | 图案绑定 |
| — | `source: 'mango'` | 新增来源标识 |

`AeIngestOrder` 有 `[key: string]: unknown` 兜底，加字段**不用改协议版本**。

---

## 4. 多账号：实测是单账号，这一整节作废

上一版把"多账号"当成核心难题，还设计了 Chrome Profile 隔离。**实测后不需要了。**

```
sk_tool_accounts:  id=1  kind=erp  account=yiyi112031  password_enc(36B)
sk_shops:          16 家店，erp_account_id 全部 = 1
```

**只有一个芒果账号，管全部 16 家店。** 于是：

- **Chrome Profile 隔离不用做**（砍掉 1 天）
- 一个 Chrome、一次打开、一次抓取覆盖 16 店
- 订单自带 `shopName`，足够定位店铺，不需要额外账号标识

保留一条底线：扩展推送时仍带 `source: 'mango'`，同步日志记录"用的是哪个工具账号"（从 `sk_tool_accounts` 读）。将来真要加第二个芒果账号，协议不用改。

### ⚠️ 密码不要拿来自动登录

`sk_tool_accounts.password_enc` 存了加密密码，`revealToolAccountPassword(id)`（`shop-accounts-db.ts:794`）能解出明文。

**但别用。** 芒果登录大概率有验证码/滑块，自动登录是封号最短路径，而且一旦触发风控，连你手动的 Chrome 会话一起废。

密码留在库里是给紫鸟那类必须登录的场景用的，不是给这里用的。

---

## 5. 开机自动化：实际会发生什么

**好消息：「用 Chrome 打开指定页面」这一环已经有现成实现。**

`electron/browser-open.ts:108` 导出 `openUrlInPreferredBrowser(url)`：

- macOS 用 `open -b <bundle-id>`，Windows 按已知路径找 `chrome.exe`，Linux 按 PATH 试常见命令
- Chrome 用不了才回落 `shell.openExternal`，**绝不返回"打开失败"**
- 注释里写明了设计意图：*「打开店铺」这个按钮的**下一步动作**就是点扩展的采集按钮*

也就是说，这个动线**从设计上就是为今天这个需求准备的**，缺的只是把"用户点一下"换成"定时触发"。

```
开机
 ↓ 应用自启（静默 + 托盘，不弹主窗口）
 ↓ 等网络就绪（最多 60s）
 ↓ 今天已同步？→ 跳过
 ↓ openUrlInPreferredBrowser(待发货 URL)   ← 已有实现，直接调
 ↓ 扩展 hook 抓取 → POST 46211 → 入库
 ↓ 扩展关标签页（chrome.tabs.remove）
 ↓ 应用广播 → 主窗口（若已打开）显示"今日待办"
```

**三个必须处理的现实**：

**① 主窗口不该弹出来**
macOS 用 `setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`。Windows 的 `openAsHidden` **不生效**，必须加 `--hidden` 启动参数 + 判断后不 `show()`。项目现在**没有托盘**，需补一个，否则开机弹窗会让人想卸载。

**② Chrome 会被弹到前台**
无法避免。`chrome.tabs.create({ active: false })` 需要扩展自己发起，而唤起 Chrome 是外部命令。
折中：抓完自动关标签页，用户最多看到 Chrome 闪一下。

**③ 扩展必须装在用户日常用的那个 Chrome 里**
`browser-open.ts` 固定"Chrome 优先"，所以扩展装在 Chrome，动线才成立。装 Edge 上就等于没装。
应用侧要做「扩展是否在线」探测（`ping()` 已有），离线时明确提示"请确认 Chrome 里装了 SellerKit 扩展"。

**④ 不要做常驻轮询**
一天一次足够。`chrome.alarms` 只在 Chrome 开着时有意义，作为"当天漏跑"的补跑机制，间隔设 30 分钟、每天最多 3 次。

---

## 6. 失败模式（这是成败关键）

| 失败 | 表现 | 对策 |
|---|---|---|
| **抓 0 条** | 接口改名 / 未登录 | **必须告警**。0 条 ≠ 今天没有待发货 |
| 未登录 | 页面跳登录 | 检测 URL / 页面特征 → 通知"需登录芒果" |
| 扩展未装该 Profile | 无任何数据 | 应用侧靠 `ping()` 反查 |
| hook 未命中 | 抓到的条数远小于页面显示 | 对比"页面显示 X 条"与"抓到 Y 条"，不相等就报 |
| 重复抓 | 同单多次 | `orderId + line` 幂等 upsert（已具备） |
| 应用侧断点 | 入库了但用不了 | 见 §7 |

**一条硬规则**：每次同步必须写一条**同步日志**（时间、账号、请求数、入库数、跳过数、失败原因）。没有日志的自动化，出问题时你只能猜。

---

## 7. 前置：三个入库断点（不修就是无用功）

这三条在 `ORDER_AUTO_SYNC_PLAN.md` §7 已取证，这里重申：

**① 采集路径 `variant_key` 恒空**
```ts
rawFields: { 采集帧: JSON.stringify(o).slice(0, 20000) }
```
整帧塞进字符串 → `extractSkuFields` 在顶层找不到「产品ID」→ `variantKeyOfRow` 返回 `''` → 全部未归类 → 图案绑定（`pod_variant_patterns` 以 `variant_key` 为主键）全落空。

**② 采集路径 `image_id` 写死 NULL**
色名塌陷的 6 个链接（50 个槽位）在采集路径上**永远判不出图案**。

**③ `source` 互斥静默挡单**
```ts
if (existed && existed.source !== 'collect') throw ...
```
存量 70 单全是 `import`，插件一开跑全部抛错，而 `ae-db.ts:746` 只 `console.warn` 后计入 `skipped`——界面上只有一个数字，没有原因。

**修法**：`import → collect` 允许升级（同一单的更好来源），反向禁止；`skipped` 带原因回执。

---

## 8. 扩展改造清单

### manifest.json

```json
{
  "permissions": ["storage", "activeTab", "scripting", "alarms", "tabs"],
  "host_permissions": [
    "https://marketplace.seller.aliexpress.com/*",
    "https://seller.aliexpress.com/*",
    "https://sell.aliexpress.com/*",
    "https://www.mangoerp.com/*",
    "http://127.0.0.1/*",
    "http://localhost/*"
  ],
  "content_scripts": [
    { "matches": ["https://www.mangoerp.com/*"], "js": ["src/mango-main.js"],
      "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://www.mangoerp.com/*"], "js": ["src/mango-bridge.js"],
      "run_at": "document_start" }
  ]
}
```

`web_accessible_resources` 仅在用注入 `<script>` 方案时需要。

### 新增文件

| 文件 | 作用 |
|---|---|
> 下列文件在**扩展仓**（`SellerKitExtensions/extensions/mango-order/src/`），不在本仓。

| 文件 | 作用 |
|---|---|
| `SellerKitExtensions/extensions/mango-order/src/mango-main.js` | MAIN world：hook XHR/fetch、翻页、DOM 兜底 |
| `SellerKitExtensions/extensions/mango-order/src/mango-bridge.js` | isolated：postMessage 中转 |
| `SellerKitExtensions/extensions/mango-order/src/mango-parse.js` | 芒果 JSON → `AeIngestOrder` 映射（纯函数，可单测） |
| `SellerKitExtensions/extensions/mango-order/src/mango-config.js` | 账号标识、目标 URL、抓取窗口（近 N 天） |

### 改动的文件

| 文件 | 改动 |
|---|---|
| `manifest.json` | 上述权限与 content_scripts |
| `background.js` | 新增 `MANGO_PAYLOAD` 分支；`alarms` 注册；同步日志 |
| `options.html/js` | 加「目标状态」「抓取天数」「自动同步开关」；`erpAccount` 字段一并留出（当前单账号，预留给将来） |
| `popup.html/js` | 加「同步芒果订单」按钮 + 上次同步时间 |
| `protocol.js` | `MESSAGE_TYPES.MANGO_PAYLOAD`；`source: 'mango'` 常量 |

---

## 9. 排期

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| **V0 抓包** | DevTools 看请求路径/参数/响应结构；确认"正常"是否含已发货 | **1 小时** | 拿到接口样例 JSON |
| **S1 hook** | manifest + MAIN world + 单页抓取 | 1.5 天 | 控制台能打出待发货 JSON |
| **S2 映射** | `mango-parse.js` + 单测 + POST 到 46211 | 1 天 | 应用里出现真实订单 |
| **S3 翻页** | 全量待发货 + 条数校验 | 1 天 | 抓到的条数 = 页面显示条数 |
| **S4 自动化** | 应用自启 + 托盘 + 唤起 Chrome + 关标签 | 1.5 天 | 重启电脑后无人干预完成 |
| **S5 晨报** | 今日待办卡片 | 1 天 | 打开应用 3 秒内看到 4 个数字 |

**前置**：S2 之前必须先修 §7 的三个断点（1.5 天），否则入库了也用不了。

**合计 ≈ 7 天**（不含 V0 的 1 小时和断点 1.5 天）。

范围上已剔除的两项：
- ~~Chrome Profile 隔离多账号~~ → 实测单账号，不需要（−1 天）
- ~~自动登录（用 `password_enc`）~~ → 验证码风险，不做

**门禁**：
- V0 没拿到接口样例前**不写代码**
- S3 的判据是「抓到条数 == 页面显示条数」，不是「跑通了」
- S4 上线前必须演练：断网重启、登录过期、扩展未装

---

## 10. 红线

1. **抓 0 条必须告警。** 否则每天静默失败，你以为今天没单。
2. **不做自动登录。** 见验证码就停，通知人。自动登录是封号最短路径。
3. **不做常驻轮询。** 一天一次，最多 3 次补跑。
4. **`world: MAIN` 不能省。** isolated world hook 不到页面请求，这个坑会浪费整天。
5. **`run_at: document_start` 不能省。** 晚一步就漏首页数据。
6. **`splitVariantKey` 的 `p.length !== 3` 必须改。** 4 段键拆出来全空且不报错。
7. **同步必须有日志。** 没有日志的自动化等于没有自动化。
