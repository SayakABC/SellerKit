# 开机自动同步芒果待发货订单 · 可行性评估与落地方案

> 目标：每天早上打开电脑，SellerKit 自动把芒果店长"待发货"订单同步进来，发货台直接显示"今天要做哪些事"。
>
> 本文基于 SellerKit 现有代码与真实数据库实测（`~/Library/Application Support/seller-kit/sellerkit.db`）。
>
> ⚠️ **路线已更新**：确认芒果登录态在用户自己的 Chrome 内、且可能有多个芒果账号后，本文 §3 推荐的"Electron 内嵌隐藏窗口"**作废**，改用 Chrome 扩展路线。
> 现行方案见 [`MANGO_ORDER_EXTENSION_PLAN.md`](./MANGO_ORDER_EXTENSION_PLAN.md)。
> 本文仍有效的部分：§1 现状实测、§7 三个入库断点、§9 失败模式、§8 晨报可先做。

---

## 0. 结论

**方向对，目标对，但"自动打开浏览器页面"这一环不能作为架构核心。**

拆成三段判定：

| 环节 | 判定 | 依据 |
|---|---|---|
| 开机自启 + 后台跑一次 | ✅ 完全可行 | Electron 原生能力，当前项目 0 实现，加即可 |
| 自动采集芒果待发货订单 | ⚠️ 可行，有一个致命前置 | 取决于芒果登录态能否被复用（见 §3） |
| 发货台显示"今天要做哪些事" | ✅ 可行，但**依赖前一步** | 生产库 `biz_status` 70/70 全空，状态只能靠采集灌入 |

**一句话**：抓单不是锦上添花，它是"今日待办"能成立的**前提**。库里没有状态，"今天该做什么"永远算不出来。

---

## 1. 现状实测（当前项目裸能力）

| 能力 | 状态 | 取证 |
|---|---|---|
| 开机自启 | ❌ 无 | `grep setLoginItemSettings\|openAtLogin` 零命中 |
| 定时调度 | ❌ 无 | `grep setInterval electron/*.ts` 零命中，无 scheduler |
| 系统托盘 | ❌ 无 | 无 `Tray(` |
| 隐藏窗口 / 独立会话 | ❌ 无 | 全项目只有 `main.ts:178` 一个 `BrowserWindow`，无 `partition` |
| 系统通知 | ❌ 无 | 无 `Notification` |
| 订单入库通道 | ✅ 现成 | `127.0.0.1:46211/ae/ingest`，token、限速、`ae-order/v1\|v2`、`upsertCollectedOrder` 全在 |
| 店铺-ERP 账号绑定 | ✅ 字段已留 | `sk_shops.erp_account_id` / `ziniao_account_id` |

**结论**：通道是通的，缺的是"谁去抓"和"什么时候抓"。这跟前几轮的判断一致——`oi_orders.source` 现在是 `import` 70 / `collect` 0，通道从来没人喂过。

---

## 2. 采集订单里的状态，是这次最大的额外收益

芒果导出的 Excel 报表**没有订单状态列**，所以：

- 生产库 `biz_status` = **70/70 全空**
- 只有 `ship_time` 能间接反映"发没发"
- 发货台算不出"待发货有几单"、"今天截止有几单"

而采集帧（`ae-order/v1|v2`）**带 `status`**，`upsertCollectedOrder` 会写进 `biz_status`。

**这意味着**：走采集通道进来的单，天然比 Excel 导入的单多一维状态。这是"自动同步"相对"手工导出"最实的一个增量，比省下拖拽操作值钱得多。

---

## 3. 致命前置：芒果登录态在哪

这是整个方案**唯一可能一票否决**的点。

Electron 的 `session` 和你的 Chrome / 紫鸟浏览器的 cookie **完全隔离**。要在后台抓芒果页面，必须先解决"谁已经登录着"。

三条路：

### 路 A：Electron 内嵌隐藏窗口 + 持久化分区（推荐）

```ts
const PARTITION = 'persist:mango'   // 首次登录后 cookie 常驻磁盘
const win = new BrowserWindow({
  show: false,
  webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
})
```

- 用户**只需登录一次**（首次运行时弹出窗口让他登），之后开机静默复用
- 不依赖浏览器是否打开、不依赖扩展安装
- 能读 XHR、能控制分页、失败可检测

**风险**：芒果若限制单点登录，在 Electron 里登录会**踢掉你在紫鸟/Chrome 里的会话**。ERP 类系统常见此限制。

> ⚠️ **必须先验证**：保持紫鸟里芒果登录状态，用另一个浏览器（无痕）登录同一芒果账号，看紫鸟那边是否被踢下线。被踢 → 路 A 死，只能走路 B。这一步 5 分钟，但决定后面一周的工作量。

### 路 B：浏览器扩展抓页面（复用现有登录态）

在现有 `SellerKitExtensions` 上加芒果域名。**但当前扩展根本跑不了**：

```json
"permissions": ["storage", "activeTab", "scripting"],     // ❌ 缺 alarms（定时）与 tabs
"host_permissions": [ ...aliexpress 三个域名..., 127.0.0.1 ]  // ❌ 无 mangoerp.com
"content_scripts.matches": [ ...aliexpress... ]              // ❌ 无芒果页面
```

三处都要加。另外 MV3 的现实约束：

- **关掉浏览器就完全不跑**，不是"每天定时"，而是"开着的时候才有机会"
- 开机自启应用 ≠ 浏览器已启动，需要 `shell.openExternal(ORDER_URL)` 主动唤起
- 用户很可能关标签页 → 采集窗口要能被重新拉起

**路 B 的语义必须诚实**：UI 上写「**上次同步：昨天 09:12**」+「立即同步」，而不是「已开启自动同步」。后者是骗人的。

### 路 C：芒果开放 API

`sk_shops.erp_account_id` 已经预留，说明设计上想走这条。但需要开发者资质 + 接口权限审批，短期不可控（参见 `速卖通POD_系统对接与自研方案.md`）。

**建议**：路 A 为主（先验证单点登录），路 B 为备，路 C 并行问资质。

---

## 4. "待发货"的口径要先在真页面确认

你给的 URL：

```
https://www.mangoerp.com/erp/#/erp/order/list/search/status/正常/normal
```

`status/正常/normal` 是**筛选条件**，但"正常"≠"待发货"。ERP 通常还有"已发货 / 已完成 / 已取消 / 退款中 / 部分发货"。

必须确认：**"正常"这个状态里，是否包含已发货的单？**

- 若包含 → 抓回来要按 `ship_time` / 发货状态二次过滤，否则"今日待办"里会混进已发的单
- 若不包含 → 直接可用

**不做这一步，晨报第一天就是错的。** 半小时能确认。

---

## 5. 抓什么：接口优先，DOM 兜底

芒果是 SPA（hash 路由），直接解析 DOM 遇改版必崩。优先级：

**① 抓 XHR（首选）**

页面加载时注入 hook，截获订单列表接口响应：

```ts
// preload 或 executeJavaScript（document_start）
const origOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (m, u, ...rest) {
  this.addEventListener('load', () => {
    if (/order/i.test(u)) {
      try { window.postMessage({ __sk: 'mango-xhr', url: u, body: this.responseText }, '*') } catch {}
    }
  })
  return origOpen.call(this, m, u, ...rest)
}
```

主进程用 `executeJavaScript` 读回，或 preload 里直接 `ipcRenderer.sendToHost`。

**② 翻页**

订单列表通常分页（20–50 条/页）。待发货几百单要循环翻页：

- 有接口 → 改 `page` 参数重放请求（最快，但可能有签名/时间戳）
- 没接口 → `executeJavaScript` 点"下一页"，等 network idle，重复

**③ DOM 兜底**

接口签名/rpc 化导致无法重放时，用 DOM 表格解析兜底。必须写选择器的容错（改版后先降级告警，不要静默返回空）。

**④ 必须带的字段**

| 字段 | 用途 | 报表有无 |
|---|---|---|
| 订单号 | 幂等键 | ✅ |
| **订单状态** | **`biz_status`，晨报前提** | ❌ **仅采集有** |
| 下单时间 | 交期倒推 | ✅ |
| 店铺 | 映射 `sk_shops` | ✅ |
| 产品ID | 图案绑定 | ✅ |
| 规格（色/码） | `variant_key` | ✅ |
| 数量 | 成本 | ✅（口径有歧义，见 `ORDER_SYNC_PLUGIN_PLAN.md`） |
| 产品图片 | **色名塌陷链接的唯一判别依据** | ✅ |
| 金额 / 币种 | 利润 | ✅ |
| 收货国家 | 按国家看利润 | ✅（现在没入库） |

---

## 6. 三层架构（推荐）

```
┌─ 触发层 ─────────────────────────────────────────┐
│ 开机自启（Electron）                               │
│   ↓ 等网络就绪（最多 60s，失败重试 3 次）           │
│   ↓ 每天只跑一次（当天已跑过则跳过）                │
├─ 采集层 ─────────────────────────────────────────┤
│ 隐藏 BrowserWindow（persist:mango 分区）           │
│   ↓ 加载待发货 URL                                 │
│   ↓ 登录态检测（URL / 页面特征）→ 失败则通知并退出  │
│   ↓ 注入 hook 抓 XHR → 翻页 → 聚合                 │
├─ 落地层 ─────────────────────────────────────────┤
│ POST 127.0.0.1:46211/ae/ingest（token 鉴权）       │
│   ↓ upsertCollectedOrder（order_no + line 幂等）   │
│   ↓ 广播 ae-ingested → 渲染层刷新                  │
│   ↓ 生成晨报（今日待办清单）                        │
└──────────────────────────────────────────────────┘
```

**代码落点**：

| 位置 | 改动 |
|---|---|
| `electron/main.ts:254` 之后 | 注册 `mangoSync.reconcileDaily()`，`setAeEventWindow` 之后 |
| 新增 `electron/mango-sync.ts` | 隐藏窗口生命周期、hook 注入、翻页、超时与重试 |
| 新增 `electron/scheduler.ts` | 最小 tick（当前 0 处定时，这是所有自动化的底座） |
| `electron/ae-receiver.ts` | 已够用，不需要改协议 |
| 渲染层 | 新增"今日待办"卡片；设置页加开关与"立即同步" |

---

## 7. 三个必须修的入库断点（否则同步进来也用不了）

这三条在前份文档已标，这里重申，因为它们是本方案的前置：

**① `oi_order_items` 没有 `item_id` 列，采集路径 `variant_key` 恒空**

```ts
rawFields: { 采集帧: JSON.stringify(o).slice(0, 20000) }   // ae-db.ts
```

整帧塞进一个字符串，`extractSkuFields` 在顶层找「产品ID」永远找不到 → `variantKeyOfRow` 返回 `''`。

**后果**：采集进来的单**全部未归类**，`pod_variant_patterns`（以 `variant_key` 为主键）全部落空，图案绑定失效。

**② 采集路径 `image_id` 写死 NULL**

`order-db.ts` 采集明细的 INSERT 第二个参数是 `NULL`；导入路径写了 `imageId / qty / variantKey`。

**后果**：色名塌陷的 6 个链接（50 个槽位）在采集路径上**永远判不出图案**。

**③ `source` 互斥会静默挡单**

```ts
if (existed && existed.source !== 'collect') throw ...
```

存量 70 单 100% 是 `import`，插件一开跑，覆盖到的旧单全部抛错，而 `ae-db.ts:746` 只 `console.warn` 后计入 `skipped`——**界面上只有一个数字，没有原因**。

**修法**：`import → collect` 允许升级（视为同一条单的更好来源），反向禁止；`skipped` 带原因回执。

---

## 8. 晨报：不依赖抓单也能先做

"今天要做哪些事"这个价值可以**部分先兑现**，因为现有库已经能算一部分：

```sql
-- 今日待办（现有数据就能出，不需要等抓单）
SELECT
  COUNT(*) FILTER (WHERE ship_time IS NULL)                    AS 未发货,
  COUNT(*) FILTER (WHERE ship_time IS NULL
                     AND date(order_time) = date('now','localtime'))  AS 今日新单,
  COUNT(*) FILTER (WHERE amount_cents = 0)                     AS 金额缺失,
  COUNT(*) FILTER (WHERE variant_key = '' OR variant_key IS NULL)   AS 未归类
FROM oi_orders;
```

**但缺一条命脉**：`biz_status` 全空 → 算不出"待发货"，只能算"未发货"（含取消单）。抓单补上状态后，这一条才准。

所以顺序是：

```
先做晨报（1–2 天，立刻可见）
  ↓ 用户每天真用起来
再修 3 个断点（1.5 天）
  ↓ 数据可用
再做自动抓单（3–4 天）
  ↓ 状态灌入，晨报变准
```

**不要反过来。** 先做抓单再做晨报，等于花一周把数据搬进来，却没有人看。

---

## 9. 失败模式与对策

| 失败 | 表现 | 对策 |
|---|---|---|
| 登录态过期 | 加载后被重定向到登录页 | 检测 URL / 页面特征 → **系统通知 + 应用内红条**，不静默 |
| 单点登录互踢 | 紫鸟那边被登出 | **上线前必须验证**，被踢则改走路 B |
| 验证码 / 滑块 | 页面停在验证 | 超时 → 通知用户"需手动登录一次"，保留窗口给用户操作 |
| 网络未就绪 | 开机瞬间加载失败 | 重试 3 次 × 20s，仍失败则等用户首次交互再补跑 |
| 页面改版 | 选择器失效，抓到 0 条 | **抓 0 条必须报警**，不能当"今天没有待发货" |
| 重复抓取 | 同单多次入库 | `order_no + line_no` 幂等 upsert（已具备） |
| 与手工操作冲突 | 用户在芒果里改了单 | 每次全量覆盖当天窗口，以平台为准 |

**一条硬规则**：`fetched_count == 0` 时必须区分"真的没有待发货"和"抓取失败"。前者正常，后者必须告警。混在一起 = 每天静默失败而你以为是没单。

---

## 10. 排期与验收

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| **V0 验证** | ①单点登录是否互踢 ②"正常"状态是否含已发货 ③接口能否重放 | **1 小时** | 三项都有明确答案 |
| **S1 晨报** | 今日待办卡片（现有数据） | 1–2 天 | 打开应用 3 秒内看到 4 个数字 |
| **S2 断点** | `item_id` / `image_id` / `source` 升级 / `skipped` 原因 | 1.5 天 | 采集单 `variant_key` 非空率 >90% |
| **S3 抓取** | 隐藏窗口 + 登录态 + 单页抓取 | 2 天 | 手动触发，抓到真实订单且字段完整 |
| **S4 自动化** | 开机自启 + 翻页 + 每日一次 + 失败通知 | 1.5 天 | 重启电脑后无人干预完成同步 |
| **S5 收口** | 设置页开关、上次同步时间、立即同步、日志 | 1 天 | 用户能自助排查 |

**总计约 7–8 天**（不含 V0 的 1 小时）。

**门禁**：
- V0 三项没答案前**不写代码**
- S2 未完成不进 S3（否则同步进来的是死数据）
- S4 上线前必须做一次**断网重连**和**登录过期**演练

---

## 11. 红线

1. **抓 0 条 ≠ 没有单。** 必须能区分，否则每天静默失败。
2. **不要做常驻轮询。** 一天一次足够（订单不是秒级变化），频率越高越容易被风控，收益为零。
3. **不要在渲染层开隐藏窗口。** 必须在主进程，否则窗口一闪而过吓人。
4. **登录态只存本机加密盘。** `persist:` 分区默认在 userData 下，配合现有 `secret_enc` 模式，不要明文写库。
5. **不要绕过验证码。** 见验证码就停下通知人，自动化破解是自找封号。
6. **多 ERP 账号要分别维护登录态。** `sk_shops.erp_account_id` 说明可能不止一个芒果账号——先数清楚有几个，每个一套分区。
