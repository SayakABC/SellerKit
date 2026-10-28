# 速卖通利润追踪（AE Profit Tracker）— 三端方案

> 方案主文档（决策依据 + 落地路线）。代码分属三个仓库，本文件位于**主程序仓库**（集成方），是跨端交互协议与数据口径的唯一权威来源；各端 README 只引用本文件，不复制协议细节（防双份漂移）。

## 1. 目标与形态

浏览器插件在**卖家已登录的速卖通后台**采集订单金额、物流费、佣金、运营费用，经本地通道送入桌面 App（SellerKit），按口径计算单订单利润并做统计展示。

> ⚠️ **2026-10-16 变更（就地标注，上文保留为历史陈述）**：扩展侧**订单采集已下线**——ae-profit 0.3.0 只做
> 商品/SKU 采集（「采集本店全部（含 SKU）」单按钮走位）；订单页解析、popup 订单入口、`ae/collect-orders`
> 等订单消息常量均已从扩展移除。**宿主侧接收链路（`/ae/ingest`、`electron/ae-receiver.ts`）与订单主干
> 表不动**：已入库的历史采集订单不受影响，通道本体仍在（供后续恢复或其它采集端使用）。§1 图与下文按
> 「订单采集端」读时，均指 0.3.0 之前的形态。

```
┌─ SellerKitExtensions（Chrome 扩展 · 采集端）─────────┐
│  content script 读取卖家后台订单/详情/对账/营销数据     │
│  → 统一 schema → 本地暂存 → 推送桌面端                │
└───────────────┬───────────────────────────────────┘
                │ 通道① Native Messaging（正式）／② localhost HTTP（POC 兜底）
┌───────────────▼───────────────────────────────────┐
│ SellerKit（主程序 · 接收端，主进程，不进渲染层）        │
│  ae-receiver：鉴权→严格校验→SQLite（复用 electron/db.ts）│
└───────────────┬───────────────────────────────────┘
                │ 语义化 IPC（遵循 AGENTS.md §1.7 / 红线 3/5）
┌───────────────▼───────────────────────────────────┐
│ SellerKit（extensions/ae-profit 视图插件 · 展示端）    │
│  利润引擎 + 统计页（趋势/TOP/费用构成/明细/成本衔接）    │
└───────────────────────────────────────────────────┘
```

## 2. 三仓库分工与提交路径

| 仓库 | 角色 | 本功能内的内容 | 发布/更新机制 |
|---|---|---|---|
| `https://github.com/SayakABC/SellerKit.git`（sellerkit，当前仓库） | 桌面主程序 | 接收端 `electron/ae-receiver.*`、`sellerkit.db` 新增 ae_* 表（幂等迁移）、语义化 IPC、`db` 能力域的 `ae` / `purchase` 业务域白名单（见 D1'）；统计页本身**不再随宿主分发**，源码与构建工程在 `ui-plugins/ae-profit/` | GitHub Releases（`vX.Y.Z` tag + electron-builder publish + `scripts/publish-finalize.js` 转正草稿） |
| `https://github.com/SayakABC/SellerKitPlugin.git` | 外置插件市场内容托管 | **利润追踪 UI 岛** `ae-profit`（`kind: "ui"`，静态产物 `dist/`）：订单明细 / 利润引擎 / 成本衔接 / 汇率维护；数据经宿主 `db` 能力域读写，接收端仍留在主进程（不随插件分发） | `market-out/`（本仓库已 gitignore，remote 指向 SellerKitPlugin）→ `scripts/publish-plugin.js` 打包 → push；下载前缀 `https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main` |
| `https://github.com/SayakABC/SellerKitExtensions.git`（已建） | Chrome/Edge 扩展（采集端） | MV3 扩展工程：content script（卖家后台白名单域名）、options 页（通道/目标 App 配置）、采集 schema 与字段映射、断点/重试 | 独立迭代；SellerKit 主程序不做任何扩展代码拷贝，仅依赖**通道协议**（本文件 §5） |

> 决策记录 D1（已变更，见下方 D1'）：原判定 ae-profit 必须作为 `extensions/` 随宿主分发视图插件，
> 原因是统计页需经语义化 IPC 读 SQLite，而当时运行期外置插件能力面固定为 storage/http/clipboard/dialog/ui/env，
> **没有自定义数据查询面**，拿不到 ae_* 数据。
>
> **D1'（现行）**：宿主新增 `db` 能力域（`ctx.host.db.call(domain, op, payload)`，白名单 op、禁止任意 SQL），
> UI 岛可经该域读 ae_* 数据 → ae-profit 迁移为**市场分发的 UI 岛**（`ui-plugins/ae-profit/`，`kind: "ui"`），
> 已从 `modules.config.json` 的 standard/pro 预设移除内建包。
> 约束：内建视图插件与 UI 岛同名时内建优先（`pluginManager.registerUiIsland` 遇同名记录跳过），
> 因此 ae-profit **不得**再进入任何默认打包预设，否则市场安装版不生效。

## 3. 数据可获取性（先于编码的事实核查）

| 数据 | 后台位置（待 M0 人工核实） | 官方 API 覆盖 | 依赖方 |
|---|---|---|---|
| 订单主档/金额/状态 | 订单管理列表/详情 | ✅ `aliexpress.order.list` | 利润主档 |
| 平台佣金 | 订单详情"平台佣金"或对账中心 | ❌ 弱 | 利润扣减 |
| 物流费（卖家承担） | 订单物流详情/对账单 | ❌ 弱 | 利润扣减 |
| 运营费用 | 营销中心/推广报表 | ❌ | 期间分摊 |
| 结算/退款调整 | 结算中心对账单 | ❌ 弱 | 修正项 |

**结论**：核心扣减字段恰好是官方 API 覆盖最弱的部分 → 页面采集不是妥协而是必要路径；官方 API 仅作后续订单全量同步的可选增强（M3），不阻塞主线。

## 4. 利润口径（业务决策区，先对齐再编码）

**分层利润**（不把分摊写死到订单行，明细/汇总分列展示）：

```
毛利       = 订单收入(商品金额 + 买家付运费) − 商品成本
运营利润   = 毛利 − 物流费(卖家实付) − 平台佣金 − 订单级广告归因(如有)
净利(已摊) = 运营利润 − Σ(期间运营费用 × 分摊权重)
```

**决策 D3（成本源 = 快照导入，零运行期依赖）**：拿货对账（stock-in）是 `extensions/order-insight` 包内子模块，成本挂在"款编码/款色/尺码"（采购维度），与速卖通"平台 SKU"不同维——`ae-profit` 若运行期直调其 IPC 会造成跨包依赖 + key 体系不匹配 + 停用即缺成本（违反红线 10）。

> ⚠️ **2026-10-21 就地标注**：本决策描述的"写入岛自有 `ae_cost_map`"属旧形态，**宿主侧的同名表已随 C2 删除**
> （`order.main` v10；成本改为产品当前价 + 订单行两字段）。`purchase-cost-snapshot` 只读导出通道仍在
> （`electron/purchase-handlers.ts`），但宿主任一域都不再有价目表可供导入。下文保留为当时的跨端设计记录。

→ 改为**单向快照**：主程序提供只读导出通道（`purchase-cost-snapshot`：款编码 → 拿货单价元）→ `ae-profit` 内"从拿货对账导入成本"（人工触发 + 平台 SKU ↔ 款编码 映射微调）→ 写入自有 `ae_cost_map`。运行时利润引擎只读自己的表；purchase 更新后手动再导入即可。

**决策 D4（运营费用 = 独立科目 + 统计层实时分摊）**：直通车/联盟营销/站外广告等是期间性总账，无订单级归因 → 不预绑定订单。科目独立存 `ae_ops_costs`（期间/渠道/科目/金额），汇总统计时实时分摊（默认按订单收入占比，备选件数/毛利），**绝不写入订单行**（口径可切换、改科目不动历史）。

⚠️ 口径陷阱：**促销让利（优惠券/满减/闪购差额）** 常已在"收入"中体现为扣减，不得再作为费用记一次（二选一，默认走收入扣减、不设科目）。

- **币种**：速卖通多币种结算 → 入库统一基准币（默认 USD，按结算汇率），汇率表支持手动维护；避免按"页面显示数字"直接相加。
- **状态过滤**：退款/纠纷/取消单单列修正项或排除，默认排除但可展开看。

## 5. 扩展 ↔ 桌面端通道协议

**选型决策 D2：正式 = Chrome Native Messaging；POC/兜底 = localhost HTTP。**

| | Native Messaging（正式） | localhost HTTP（POC 兜底） |
|---|---|---|
| 机制 | 扩展 `chrome.runtime.connectNative('com.sellerkit.ae')`；App 启动时主进程写 host manifest（Windows: HKCU 注册表免管理员；macOS: `~/Library/Application Support/<浏览器>/NativeMessagingHosts/`）；主进程 stdin/stdout 收 4 字节长度前缀 JSON | 主进程监听 `127.0.0.1:<port>`；启动生成一次性 token，在桌面「设置 → 速卖通采集」展示，扩展 options 页粘贴；每次请求带 token + 校验 `Origin`/扩展 id |
| 安全面 | 最小（无网络端口；按 App 身份鉴权） | 需自建 token + Origin 校验 + 大小上限 + 限流 |

- **消息帧**：双方同款 JSON 信封 `{ "type": "ae-capture|ack|error|pong", "seq": n, "payload": {...} }`；`seq` 回执去重（扩展断线重发幂等）。
- **校验防线**（对齐 AGENTS 红线 3/18 风格）：接收端第一层=形状/大小（单帧 ≤ 2MB、字段长度上限）；第二层=ae 专属 schema 严格校验（仿 `externalManifest.ts` 白名单式校验：枚举/类型/必填）。
- **限流与断点**：扩展侧采集按钮人工触发 + 每批 ≤ N 条 + 批间最小间隔；本地暂存队列未确认不丢；`ae_sync_log` 记录断点续采。
- 渲染进程**不直连**扩展，全部经主进程语义化 IPC（红线 5）。

## 6. 数据模型（sellerkit.db 新增表，沿用 electron/db.ts 幂等 DDL 迁移）

- `ae_orders`：订单主档（窄列 = 稳定查询键：order_id、店铺/站点、下单时间、状态、币种、商品金额、买家运费、source、**raw_json 整帧全量快照**）
- `ae_order_lines`：SKU 行（product_id/sku、数量、单价）
- `ae_fees`：订单级费用科目子表（`category`/`amount`/`currency`；平台佣金、物流费-卖家承担、支付通道费、退款/纠纷调整）
- `ae_ops_costs`：**运营费用独立科目表**（期间、渠道、科目、金额），与订单无绑定；统计时实时分摊（D4）
- `ae_cost_map`：SKU ↔ 拿货成本（快照导入自 stock-in 只读导出，含更新时间，D3）
- `ae_sync_log`：采集批次/断点/失败记录（用于 UI 告警与续采）
- 利润结果**不落表存计算值**：由引擎实时计算（口径变更不需迁移历史数据；含均摊的分摊亦只发生在查询层）

### 6.1 存储策略与字段演进（已落地，M0 通用化）

- **窄列 + 全量快照**：`ae_orders` 只保留稳定查询键列；扩展发来的订单对象**整帧不裁剪**存 `raw_json`（上限 64KB/条）。语义化字段的增减只发生在采集端与展示端，主程序与表结构无需同步升级——历史数据不丢。
- **费用科目化**：订单级费用一律进 `ae_fees` 子表（按「订单币种 × category」聚合）。**新增费用科目 = 采集端多推一条 `fees` 条目，零 ALTER**；科目 key 为宽松白名单（`platform_commission` / `logistics_fee` / `payment_channel` / `refund` / `dispute` …），未知科目同样入库，前端字典缺失时回退原始 key 展示。
- **schema 双收**：`ae-order/v1`（旧帧：顶层 `platformFee`/`logisticsFee`/`refundAmount` 便捷字段）与 `ae-order/v2`（结构化 `fees: [{category, amount, currency?}]` 数组）均接受；v1 便捷字段由接收端自动映射为 fees 科目行，跨端不必同步发版。
- **入参校验（宽容模式）**：必填仅 `orderId`；字符串长度 / 金额有限数 / lines≤100 / fees≤100 / 单批≤100 由接收端校验；未知字段不拒绝、原样入快照。
- 多币种金额**按币种分组聚合**（`byCurrency`），不做跨币种直接加总的口径误导（top 级 total* 仅供预览）。

## 7. 落位清单（对照 SellerKit 仓库目录）

| 新增/改动 | 位置 | 边界说明 |
|---|---|---|
| 接收端 | `electron/ae-receiver.ts`（native messaging / localhost 二选一开关）+ `electron/ae-db.ts`（ae_* 表迁移与 DAO，复用 `db.ts` 单例与事务） | 主进程；进包前须评审安全（§4.2 类） |
| 语义化 IPC | `src/core/services/ipc.ts` + `src/types.ts` `ElectronAPI` + preload（新通道 kebab-case） | 三处同步（AGENTS §1.1） |
| 展示端 | ~~`extensions/ae-profit/`（manifest kind: view + src/ 完整 Vue 统计）~~ → **已改为 `ui-plugins/ae-profit/`（kind: ui 市场 UI 岛）** | 见 §10 D1'（D1 已被取代）。运行时按 host `db` 能力域（域 `ae` / `purchase`）读写 |
| 方案文档 | 本文件（跨端协议唯一权威） | 随 SellerKit 仓库维护 |

> ⚠️ **文档与代码漂移提示（2026-09-16 审查发现）**
> 1. 上表「展示端」行原写 `extensions/ae-profit/`，与 §10 决策 D1' 冲突；D1' 已生效，正确落位是 `ui-plugins/ae-profit/`。
> 2. **磁盘现状与决策不一致**：`extensions/ae-profit/`（约 1.5k 行，`kind: view`）仍然存在，而 `modules.config.json` 已将其移出 standard/pro 预设，且明确注明"必须保持其不进入默认包，否则内建记录会占用同名 id，导致市场安装的 UI 岛无法注册"。该目录目前是**迁移残留**，建议确认后删除（本次审查未改动）。
> 3. §5 列出的 `ae_ops_costs`、`ae_sync_log` 两张表在 `electron/ae-db.ts` 中**尚未实现**（实际已建：`ae_orders` / `ae_order_lines` / `ae_fees` / `ae_cost_map` / `ae_rates`），它们属 §8 的 M2 范围。

## 8. 里程碑（每步明确"验证什么"）

- **M0 POC（建议最先做，1–2 天）**：扩展在订单管理页读列表行 → localhost 推送 → 主进程入 `ae_orders` 雏形 → ae-profit 极简明细页。
  *验证点①：佣金/运费字段在页面（新旧后台）的实际可达性与口径；② 登录态下采集体验。*
  *若①不成立 → 降级为"后台导出 CSV → 本地解析入库"兜底通道，本方案 §3 随之修订。*
- **M1**：字段补全（佣金/物流/结算）+ 利润引擎 + 成本衔接 + 统计页 v1（日月趋势/TOP/费用构成/明细）。
  > 现状（extension 0.2.0）：利润引擎（`electron/ae-engine.ts`，CNY 分层：净收入/成本/毛利/费用/运营利润）、成本衔接（拿货对账快照 → `ae_cost_map`）、汇率维护（`ae_rates`）与统计页 v1 已落地；费用口径为订单级 `fees` 科目，运营费分摊仍归 M2。缺汇率单、未命中成本行在统计页有显式提示。
- **M2**：Native Messaging 正式化 + host manifest 安装注册 + 采集稳健化（翻页/断点/容错/限流）+ 运营费用采集 + 汇率维护（UI 已先行落地）。
- **M3（可选）**：官方 API 全量订单同步 + 结算 CSV 导入兜底。

## 9. 风险与合规

| 风险 | 对策 |
|---|---|
| 卖家后台改版（最高风险） | 选择器集中配置 + 单条失败跳过告警；**CSV 导入兜底通道保数据流不断**（设计在 P0 就要留接口） |
| 平台自动化条款/账号风控 | 仅采集**本人店铺**、人工触发 + 限流、不绕过登录/验证码、不做无人值守全自动翻页；代码注释与文档声明合规边界 |
| 口径错误（费用归属） | M0 人工核对字段；引擎实时计算不落存储值；单测用典型订单样例固话口径 |
| 本地通道暴露 | Native Messaging 为主；localhost 兜底必须 token + Origin + 大小/频率上限（§5） |

## 10. 决策记录

| # | 决策 | 状态 |
|---|---|---|
| D1 | ae-profit = `extensions/` 随宿主分发外挂 UI 视图包（kind: view，与 order-insight 同构）；不做市场分发 | ⛔ 已被 D1' 取代 |
| D1' | ae-profit 迁移为**市场分发 UI 岛**：`ui-plugins/ae-profit/`（kind: ui，Vue3+Tailwind 静态产物），经宿主 `db` 能力域（域 `ae` / `purchase`）读写；内建同名包已从 standard/pro 预设移除 | ✅ 已落地 |
| D2 | 扩展↔桌面通道：正式 Native Messaging，M0 POC 用 localhost HTTP 验证数据可达性 | ✅ 已定 |
| D3 | 成本源：purchase 数据**不运行期直连**，走只读导出 → `ae_cost_map` 快照导入（单向、零依赖） | ✅ 已定（见 §4） |
| D4 | 运营费用：独立科目表 `ae_ops_costs` + 统计层实时分摊（默认按收入占比），不写订单行；促销让利走收入扣减不设科目 | ✅ 已定（见 §4） |
| D5 | M0 目标 = 验证佣金/运费字段页面可达性与口径；不可达则降级 CSV 导入兜底 | ✅ 已定 |

## 11. 仓库就绪状态

- `SellerKit`（主程序）✅ 已提交基线
- `SellerKitPlugin`（市场托管）✅ 已建（market-out remote）
- `SellerKitExtensions`（Chrome 扩展）✅ 已建 → 下一步在其初始化 MV3 工程骨架

> 对齐项目基线：本功能全部改动落在 AGENTS.md §4.1/§4.2 允许面（主进程新增接收端与 DB 表按 §4.2 评审）；不触碰 §4.3 禁用文件；新增 IPC 三处同步；渲染层一律走 `src/core/services/ipc.ts`。
