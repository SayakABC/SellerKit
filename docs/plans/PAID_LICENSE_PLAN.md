# 付费授权方案（Paid License Plan）

> **状态**：🟢 **方案已定稿**（2026-09-30 用户拍板三项：收费客体 = Pro 档功能 / 计费 = 月 + 年双档订阅 / 后端 = 零自建），**尚未开工**。
> **读者**：架构 / 开发者。
> **要回答的问题**：要让"付费才能用"成立，判定该放在哪、有哪些执法点、要改哪些文件、客户端到底防得住什么。
> **性质**：§1–§2 是**客观事实与外部对标**（含 `文件:行` 与外部依据）；§3–§5 是**方案与改动清单**。
> **前置阅读**：`AGENTS.md`（§1.1 三层边界 / §1.7 网络与 IPC / §1.8–1.9 插件与岛；红线 16–23）、`docs/architecture/PLUGIN_ARCHITECTURE.md` §9（安全模型与权限门）+ §15（UI 岛形态）。

---

## 0. 结论速览（TL;DR）

| 决策项 | 定案 | 说明 |
| --- | --- | --- |
| 收费客体 | **Pro 档功能** | 不锁整个 App，不按岛收费；免费版照常可用 |
| 计费 | **月 + 年双档订阅**（年付折扣） | 用户 2026-09-30 拍板 |
| 到期行为 | **降级为免费版** | Pro 能力不可调用，基础功能与数据照常（§4.4） |
| 后端 | **零自建**：托管授权 API + 托管收银 | 不自建 license 服务（§4.1） |
| 判定位置 | **主进程**；渲染层只拿只读快照 | 岛**不自判**，只向宿主查询（§1 F2） |
| 执法点 | **3 个闸门**：安装门 / 激活门 / 调用门 | 全部挂在现有结构上，零新协议（§4.3） |
| op 预算 | **不新增 db 域、不新增 op** | 只给现有 op 加一个声明字段 ⇒ 不受 ADR-002 N5（≤10）约束 |
| 防破解定位 | **抬高成本 + 让破解无收益**，不追求绝对防住 | 见 §1 F3 |
| 阶段 | P0 授权内核 → P1 闸门与界面 → P2 加固 → P3（可选）付费岛 | 见 §5 |

---

## 1. 三条工程事实（它们决定了方案取舍）

### F1 · 岛是「预构建静态站点 + 本地明文文件」⇒ 付费墙不可能靠"藏代码"

- 岛包形态 = `manifest.json` + `dist/`（`docs/architecture/PLUGIN_ARCHITECTURE.md` §15.2）；安装即解压落盘到 `<userData>/plugins/<id>/`（`electron/plugins-market-handlers.ts` 的 `unzipSafe` + `rename` 分支）。
- 宿主用只读特权协议把这些文件原样喂给 iframe（`electron/plugin-ui-protocol.ts`）——**产物是明文 JS，用户一定能读到，也一定能改**。
- ⇒ 结论：付费岛/付费能力**不能靠"不下发代码"来保护**。要么宿主门控（可被 patch，但抬高成本），要么把价值放到服务端（真防）。

### F2 · 判定必须落主进程，岛只能"问"不能自判

- 本项目已有的两层结构正好是 JetBrains Marketplace 的同构物：**宿主 = 平台，岛 = 插件**。JetBrains 的官方口径是「授权完全在平台侧，插件不打包校验代码，只调一句"我被授权了吗"，凭公钥验签服务器签发的凭据」——插件侧不自持私钥、不做判定（见 §9 外部参考）。
- 落点对齐：现有 `src/core/plugin/security.ts` 的 `decidePermission()` 是**纯函数**且被 vitest 覆盖，授权判定作为**正交的第二道门**加在同处最自然（**不破坏** ADR-002 的 C4 `domains` 模型：`domains` = 第一道「这个插件能不能碰这个域」，entitlement = 第二道「这个账号买没买」）。
- 保持纯：entitlement 快照由调用方**注入**（`decidePermission(pluginId, manifest, req, entitlements?)`），内核不 import 主进程 ⇒ 可继续单测。
- ⚠️ **反例预警**：`src/core/network/token.ts` 现在把会话态写在 localStorage —— 渲染层 DevTools 可读可改。**授权态绝不能沿用这条路**（详见 §5 P0-1）。

### F3 · ASAR 是归档不是加密 ⇒ 客户端永远可被 patch

| 事实 | 后果 |
| --- | --- |
| ASAR 只做拼接，不加密不混淆；标准 CLI 一条命令即可完整解包 | 源码与逻辑对用户透明 |
| `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` **默认关闭**（macOS ≥16 / Windows ≥30 才支持） | 不显式开启则产物可被静默改写 |
| CVE-2024-46992（Windows ASAR integrity 绕过，30.0.5 / 31.0.0-beta.1 已修）、CVE-2025-55305（V8 heap snapshot 不在 ASAR integrity 保护范围内） | **即使开了 fuse 也不是铁板** |
| 官方与第三方文档一致口径：「没有任何客户端保护是绝对的，必须配合服务端校验」 | 目标只能是"抬高成本"，不是"防住" |

---

## 2. 市面主流做法（对标）

| 场景 | 主流形态 | 代表 |
| --- | --- | --- |
| Electron 应用授权 | 主进程激活/校验 → IPC 只把结果给渲染层；**Ed25519 签名凭据 + 内嵌公钥离线验签**；机器指纹（`node-machine-id` + HMAC 盐）；联网时刷新撤销态；网络失败走**离线宽限期** | Keygen（CE 可自托管）、Keyforge、Keylight、Keymint、Cryptlex、LicenseSpring；收银用 LemonSqueezy / Paddle |
| 付费插件市场 | **授权归平台，插件只查询**；平台拿服务器签名确认；支持试用、多 license、按版本；平台分成 | JetBrains Marketplace |
| 客户端加固 | ASAR integrity fuses + V8 bytecode（bytenode / electron-vite `build.bytecode`）+ 关键逻辑下沉原生模块；**均声明不替代服务端校验** | Electron 官方 fuses 文档 |

---

## 3. 方案矩阵与选型

| 方案 | 收费边界 | 需后端 | 防破解 | 本项目改动 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A 离线签名授权** | 整个 App / Pro 档 | 否（可用托管 API） | 中 | 小 | ✅ **主线**（打底） |
| **B 订阅 + 在线心跳** | 整个 App / Pro | 是（自建） | 高 | 大 | ⏸️ 方案本体就是 A + 心跳；**因"零自建"而用托管方承载** |
| **C 功能分级门控** | 功能 / 额度 | 否（或轻） | 低–中 | 中 | ✅ **主线**（与 A 合成一体：A 管"买没买"，C 管"买了解锁什么"） |
| **D 付费岛市场** | 单个岛 | 是（下载鉴权） | 中–高 | 中–大 | 🕓 **P3 可选**（当前拍板为 Pro 档，不是按岛收费） |

**选型理由**：项目当前**零后端**（全部本地 SQLite；市场是 GitHub 静态托管，目录与 zip 都无鉴权）。A + C 是唯一能在**一个主进程模块 + 现有权限门**内闭环的形态；B 的"在线心跳"由托管方 API 承载，不自建；D 留待真有按岛售卖的需求时再做（届时正好复用本方案的三道闸门）。

---

## 4. 定案设计

### 4.1 授权凭据与环境

- **凭据形态**：托管方签发的**签名载荷**（Ed25519 优先），内嵌 `licenseKey / productId / plan / expiresAt / machineFp / entitlements[]`。公钥**内嵌进 App**。
- **离线可用是硬要求**：验签 + 到期判定全部在本地完成。**不要把"必须联网"写进启动路径** —— 断网必须能开机、能用到 `expiresAt`（否则付费用户被自己的网络环境坑）。
- **联网时**：每 24h 一次 validate，用于刷新 `expiresAt`（续费）与撤销态（退款 / chargeback）。
- **时钟回拨**：到期时间在**签名载荷内** ⇒ 改系统时间无效。仍记录 `maxSeenTs`（见过的最大时间戳），系统时间显著倒退即判异常 —— 这是对"本地存最后校验时间"这类可改文件写法的必要补强。
- **缓存位置**：主进程 + `electron-store`（`encryptionKey`）或 Electron `safeStorage`。**渲染层只拿只读快照**（`{ plan, entitlements, expiresAt, state }`），拿不到也改不了原始凭据。

### 4.2 生命周期（月/年双档订阅）

```
订阅有效 ──到期──▶ 宽限期（建议 14 天）──仍未续费──▶ 降级为免费版
   ▲                                                      │
   └──────────────── 续费成功（载荷重签，expiresAt 前移）───┘
```

| 阶段 | Pro 能力 | 基础功能 | 在线校验 |
| --- | --- | --- | --- |
| 订阅有效 | 全开 | 全开 | 每 24h 一次（失败不影响使用） |
| 宽限期 | 全开（UI 持续提示续费） | 全开 | 每次启动 + 每 24h 重试 |
| 降级 | **不可调用**（入口可见 → 引导购买） | 全开，数据只增不减 | 每 24h 重试，恢复即自动升回 |

**宽限期长度约束**：不得长于计费周期太多（月付档下 14 天已接近半月）——否则"退订后靠离线白用"。

### 4.3 三个执法闸门（全部挂在现有结构上）

| 闸门 | 时机 | 落点（现有代码） | 未授权时 |
| --- | --- | --- | --- |
| ① 安装门 | 市场下载 / 安装 | `electron/plugins-market-handlers.ts` 的 `plugins-market-install`（现已有 sha256/zip-slip/manifest 三重校验）；`downloadUrl` 可改为**带签名的一次性 URL** | 拒绝下载（唯一能防"白嫖下载"的位置；**注意文件落盘后不再构成防线**） |
| ② 激活门 | 注册视图 / 激活插件前 | `src/core/plugin/managerActivate.ts` + `pluginManager.ts`（岛走独立轨道 `uiIslands`，启停复用统一停用集 `disabled`） | 不注册入口（或注册但进岛显示购买页 —— **待拍板 §8-Q3**） |
| ③ 调用门 | 每次能力调用 | `src/core/plugin/host.ts` 的 `DB_OPS` **给 op 加声明字段** `requires?: string`；`src/core/plugin/security.ts` 的 `decidePermission()` 在 manifest 判定**之后**再判 entitlement | 拒绝调用 + 写入**现有权限审计环**（`PluginCenter.vue` 的「权限审计」区已有展示位，零新 UI） |

**为什么选这三处**：都已在运行、都有审计/拒绝语义、都不需要新协议或新 IPC 通道。③ 尤其关键——它是唯一能覆盖"用户手动把 zip 拷进插件目录"这条路径的门。

### 4.4 到期降级语义（Pro 档的关键）

- **降级 = Pro 能力不可调用，不是 App 不可用**。基础功能（导入、查看、导出）必须照常，否则用户会认为"数据被扣了"。
- 降级后的**数据只增不减、可导出**。
- 理由有二：① 本地能力本来就锁不死（旧版代码在用户机器上），硬锁只会招致反感而不增加收入；② 降级 + 引导购买是**续费转化最高**的形态。
- 已实现的相关先例可直接复用：`PluginCenter.vue` 的停用集机制（`isEnabled` 读点判定 + 侧栏/⌘K 即时消失 + 正显示的岛自动回落）——**降级态的 UI 表现与它同构**。

### 4.5 设备与多机

- 用托管方的 instance / activation 上限（Keygen 的 machine、LS/LS 类平台的 activation limit）。
- 设置页必须有**「注销此设备」**入口 —— 换电脑是这类产品最高频的客诉。
- 机器指纹：`node-machine-id`（跨重启稳定）+ **HMAC 盐**后上传，**不上传原始机器 ID**（合规，见 §7）。

---

## 5. 改动清单（分子阶段）

> 新文件路径**不加反引号**（尚未创建 —— 见 `scripts/check-doc-links.mjs` 的路径形态判定）。

### P0 · 授权内核（无后端）

| # | 落点 | 改动 |
| --- | --- | --- |
| P0-1 | electron/license.ts（新，主进程） | 验签（Ed25519 公钥内嵌）→ 机器指纹 → 到期/宽限判定 → `maxSeenTs` 防回拨 → 凭据缓存（`safeStorage` / `electron-store` 加密） |
| P0-2 | `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts` | 新增 4 条 IPC：`license-status` / `license-activate` / `license-deactivate` / `license-refresh`。**必须三处同步**（`src/types.ts` 被 `npm run verify` 拦截；`src/core/services/ipc.ts` 只有 `vue-tsc` 拦得住） |
| P0-3 | src/core/services/license.ts（新，渲染层） | 只读快照 + 订阅变更（`license-status` 变化即刷新 UI 态） |
| P0-4 | `src/core/plugin/host.ts` | `DB_OPS` op 表加 `requires?: string`（声明式，**不新增 op**）；op 分派前查 entitlement |
| P0-5 | `src/core/plugin/security.ts` | `decidePermission` 增第 4 参 `entitlements`，纯函数；`AuditEntry` 复用（拒绝理由带 `entitlement` 前缀即可区分） |
| P0-6 | `src/core/plugin/gatedHost.ts` | 传入 entitlement 快照（权限门是唯一授权入口，此处注入） |
| P0-7 | `src/core/components/SettingsModal.vue` | 新增「授权」分类：状态 / 到期时间 / 激活 / 注销此设备 / 管理订阅（跳托管方门户） |
| P0-8 | `electron/http-client.ts` 调用方 | 走托管方 API（协议白名单已覆盖 https；`noCache: true` 语义见该文件注释） |
| P0-9 | `src/core/network/token.ts` | **不再作为授权态载体**；若保留，明确降级为"业务会话 token" |

### P1 · 闸门② + 降级态

| # | 落点 | 改动 |
| --- | --- | --- |
| P1-1 | `src/core/plugin/managerActivate.ts` / `pluginManager.ts` | 激活前查 entitlement（岛与 L2 插件同轨） |
| P1-2 | `src/core/AppShell.vue` | 降级态的侧栏/入口表现（复用停用集那套刷新链路：`onStateChange` → `refreshMetas()`） |
| P1-3 | `src/core/components/PluginCenter.vue` | 未授权行加「未授权 · 去激活」态；复用现有 badge / 审计区 |
| P1-4 | `src/core/plugin/types.ts` + `src/core/plugin/externalManifest.ts` | （可选）岛只读授权态：加进现有 `env`（`{ isMac, version, platform }` → 增 `entitlements`），**比新增能力域便宜**；若后续需要"岛内发起激活流程"再加独立 `license` 能力域 |

### P2 · 加固

| # | 落点 | 改动 |
| --- | --- | --- |
| P2-1 | `electron-builder.yml` | 开启 `electronFuses`：`EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar`（**Android/iOS 无关，注意 macOS 需 Info.plist 的 `ElectronAsarIntegrity`、Windows 需 `ElectronAsar` 资源项**） |
| P2-2 | 打包流程 | 评估 V8 bytecode（`vm` / electron-vite `build.bytecode`）；注意其已知限制：async 箭头函数、字符串字面量仍可读 |
| P2-3 | P0-1 新建的授权模块（落在 `electron/` 下） | 校验点**分散**（启动 / 激活 / 周期性），避免单点 `if` 被一处 patch 全绕过 |

### P3 ·（可选）付费岛

沿用本方案三道闸门 + `docs/plans/PLUGIN_TRIAGE_PLAN.md` 的市场链路：catalog 加 `pricing` 字段 → `scripts/publish-plugin.js` 写入 → `electron/plugins-market-handlers.ts` 的 `sanitizeItem` 放行 → `MarketPluginInfo` 扩字段 → PluginCenter 展示价格/试用/已购。

---

## 6. 门禁与回归点

改完必须依次跑（**顺序不能颠倒**：DB/主进程冒烟跑的是 `dist/electron/*.js`，忘编译 = 测旧代码）：

```
npx tsc -p tsconfig.electron.json     # ① 主进程类型
npx vue-tsc --noEmit                  # ② 渲染层类型（唯一能拦 ipc.ts 的 ElectronApi 漂移）
npm run verify                        # ③ IPC 契约三方一致
npx vitest run                        # ④ 单测（security.ts 的 entitlement 判定必须有用例）
npm run verify:docs                   # ⑤ 文档引用无悬空
```

| 额外回归点 | 为什么 |
| --- | --- |
| `npm run plugins:island:smoke` | 闸门②改动直接影响岛的注册/激活路径 |
| 新增 IPC 通道数 | 变更后必须同步 `docs/baseline/PROJECT_BASELINE.md` §5（该处已有历史漂移：文档写 166/162、实测 182/178） |
| `security.ts` 用例 | 新增判定必须是**纯函数 + 可变异验证**：逐条把 entitlement 判定改坏，确认对应用例真变红（恒绿断言 = 没有守卫） |
| 兼容性 | 未激活 / 旧凭据 / 过期凭据 / 时钟回拨 / 断网启动 —— **五条路径各留一条用例**，不能只测"有效"这一条 |

---

## 7. 风险与合规

| 风险 | 说明与缓解 |
| --- | --- |
| **客户端可被 patch** | 见 §1 F3。缓解：P2 加固 + 校验点分散 + 关键价值上云（P3 之后）。**不承诺"防住"** |
| **托管方成为单点** | 零自建的必然代价。缓解：选型硬指标 = **凭据必须能离线验签** ⇒ 托管方宕机只影响新激活，不影响存量用户；另需确认数据可导出、迁移成本 |
| **凭据缓存被改** | 用 `safeStorage` / electron-store 加密；且**到期时间来自签名载荷**，改缓存改不出更长有效期 |
| **机器指纹 = 个人信息** | 必须告知 + 最小化：`node-machine-id` + HMAC 盐，**不上传原始机器 ID**；隐私政策需覆盖 |
| **收款资质** | 国内个人开发者直连微信/支付宝需资质，通常走第三方聚合（有风险）；LemonSqueezy / Paddle 属 Merchant of Record（代收税、无需资质），但为境外收款（涉税务申报） |
| **退款 / chargeback** | 必须靠在线 validate 把 `revoked` 拉回来；纯离线不可撤销 —— 这是"每 24h 校验"的存在理由 |
| **降级引发负面口碑** | §4.4 的语义（不锁 App、数据可导出）即缓解本身；文案要写清"到期后基础功能照常" |

---

## 8. 待拍板

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | 托管方最终选型（LemonSqueezy / Paddle / Keyforge / Keylight / LicenseSeat / Keymint / Keygen Cloud） | 先按"**凭据可离线验签**"过滤，再按成熟度排序。Keygen CE 自托管 = 需要服务器，与"零自建"冲突 |
| Q2 | 免费版 vs Pro 的**功能切分**（哪些 `DB_OPS` 的 op 挂 `requires`） | 从"分析型产出"切（利润算钱 / 成本维护 / 批量编辑），**不切导入与查看** —— 保证免费版仍可完成基本闭环 |
| Q3 | 未授权时闸门②的表现：不注册入口 vs 入口可见但进岛显示购买页 | 建议**入口可见 + 购买页**（可发现性优先；也是转化路径） |
| Q4 | 宽限期天数 | 建议 14 天（月付档的上限） |
| Q5 | 是否 / 何时做 P3 付费岛 | 等"按岛售卖"真有需求；届时复用本方案三道闸门 |

---

## 9. 外部参考

- Electron ASAR 完整性（fuses / 平台差异 / 不支持范围）：<https://www.electronjs.org/docs/latest/tutorial/asar-integrity>
- Electron 源码保护实践（ASAR integrity + V8 bytecode，含"客户端保护不绝对"的官方口径）：<https://electron-vite.org/guide/source-code-protection>
- CVE-2024-46992（Windows ASAR integrity 绕过，30.0.5 / 31.0.0-beta.1 已修）：<https://github.com/electron/electron/security/advisories>
- CVE-2025-55305（V8 heap snapshot 绕过 ASAR 完整性）：<https://cve.circl.lu/>
- JetBrains Marketplace 技术实现（**授权归平台、插件只查询**、平台侧黑盒 + 公钥验签）：<https://plugins.jetbrains.com/docs/marketplace/technical-implementation.html>
- Keygen 离线许可（签名许可文件 / 签名 key 的算法与格式）：<https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses>
- 面向 Electron 的授权平台横向对比（Keygen / Keylight / LicenseSeat / Keyforge / Keymint / Cryptlex / LicenseSpring）：<https://keylight.dev/best-licensing-for-electron-apps>

---

## 10. 关联文档

- `docs/architecture/PLUGIN_ARCHITECTURE.md` §9（安全模型 / 权限门 / 分级信任）+ §15（UI 岛形态与分发）
- `src/core/plugin/host.ts`（`DB_OPS` 域与 op 表）、`src/core/plugin/security.ts`（权限门内核）
- `docs/decisions/ADR-002-master-data-layer.md`（C4：per-plugin `domains` 模型 —— 本方案**不动**它，entitlement 是正交的第二道门）
- `docs/features/PRODUCT_LIBRARY.md` §6（op 预算实测现状：`product-admin` 10 满额）—— 本方案不新增 op，故不受影响
- `docs/notes/2026-09-30-paid-license-enforcement.md`（本方案的跨工具结论摘要）
