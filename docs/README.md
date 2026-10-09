# 文档中心

SellerKit 项目文档索引。**先看这里的表格找文档，再打开具体文件**——不要凭记忆猜文件名，2026-09-16 起文档已按分类归入 `docs/` 子目录。

> 项目入口（安装 / 构建 / 目录结构 / 架构要点）见根目录 [`README.md`](../README.md)。
> 代码改动规则（架构基线 + 23 条红线）见根目录 [`AGENTS.md`](../AGENTS.md)。

---

## 文档地图

| 文档 | 主旨 | 读者 | 状态 | 最后更新 |
|---|---|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **架构基线 + 编码红线**（三层边界 / 模块化 / 插件体系 / 命名 / 异常 / 红线 1–23）**+ §0 跨工具协作契约** | 开发者、AI 助手 | ✅ 活跃（唯一规则源） | 2026-09-30 |
| [`notes/README.md`](notes/README.md) | **跨工具结论笔记**：多 AI 工具交替开工时"以后要记住什么"的结论层（命名 / 必须登记索引 / 与工具私有记忆的关系，规则见 `AGENTS.md` §0） | 开发者、AI 助手 | ✅ 活跃 | 2026-09-30 |
| [`baseline/PROJECT_BASELINE.md`](baseline/PROJECT_BASELINE.md) | **项目基线快照**：结构、规模、模块/插件注册表、IPC 契约、持久化、依赖、质量门禁现状 | 开发者、新人 | ✅ 活跃（随版本刷新） | 2026-09-30 |
| [`baseline/REFACTOR_PLAN.md`](baseline/REFACTOR_PLAN.md) | Phase 0–3 单体 → 模块化重构计划 | 架构/开发者 | 🗄️ 已完成归档 | 2026-08-21 |
| [`architecture/PLUGIN_ARCHITECTURE.md`](architecture/PLUGIN_ARCHITECTURE.md) | 插件化方向性架构：Phase 1–5、Worker 沙箱、权限门、UI 岛方案 | 架构/开发者 | ✅ 活跃（方向性，规则以 AGENTS.md 为准） | 2026-09-08 |
| [`architecture/PLUGIN_DEVELOPMENT.md`](architecture/PLUGIN_DEVELOPMENT.md) | 外置插件与 UI 岛开发、调试、发布操作手册 | 插件作者 | ✅ 活跃 | 2026-09-15 |
| [`architecture/UI_ISLAND_INTAKE_CHECKLIST.md`](architecture/UI_ISLAND_INTAKE_CHECKLIST.md) | **UI 岛接入 / 改动 / 排障逐步清单**：§1 步骤 · §2 检查项 · 故障速查表 · 一键冒烟 | 插件作者 | ✅ 活跃（新增或改岛前先过一遍） | 2026-09-24 |
| [`decisions/ADR-001-island-settings-stay-in-island.md`](decisions/ADR-001-island-settings-stay-in-island.md) | **ADR-001**：`excel-copy` / `order-insight` 的设置**保留在岛内视图**（不收编进宿主设置中心）—— 含判据与重新评估条件 | 架构/开发者 | ✅ 已裁定（改这两个插件的设置入口前必读） | 2026-09-25 |
| [`decisions/ADR-002-master-data-layer.md`](decisions/ADR-002-master-data-layer.md) | **ADR-002**：建立「主数据层」—— 基础数据独立维护、**以 ID 关联**（C1–C4 单一写入方 / 共享只读域 / G2 历史文本不改写 / D4b 变动即替换） | 架构/开发者 | ✅ 已裁定（S1 店铺实体已落地） | 2026-09-27 |
| [`features/MAIL_INBOX.md`](features/MAIL_INBOX.md) | 集中收件箱 M1–M3 设计与落地（IMAP / FTS / 附件缓存）+ 正文渲染通道 `sk-mail://`（内联图与远程图） | 开发者 | ✅ 活跃 | 2026-10-04 |
| [`features/PROFIT_TRACKER.md`](features/PROFIT_TRACKER.md) | 速卖通利润追踪三端方案与落地路线（**跨端协议唯一权威来源**） | 架构/开发者 | ✅ 活跃（含 2026-09-16 漂移提示） | 2026-09-15 |
| [`features/PRODUCT_LIBRARY.md`](features/PRODUCT_LIBRARY.md) | **跨境产品库**：产品（款式）主数据 + SKU/克重 + 店铺商品清单 + 商品ID↔产品映射。⚠️ **2026-10-01 起 UI 收归内建「货与成本」**（原 UI 岛已下架，§6.2 的域表已成历史，见 §0-A）；§1–§3、§5.1、§5.2 仍描述现状 | 架构/开发者 | 🟢 数据层 P0–P4 已落地（P5 未开工）；UI = 内建页 | 2026-10-01 |
| [`guides/USER_GUIDE.md`](guides/USER_GUIDE.md) | 用户使用指南 —— **已下线**，现为下线说明（正文删除） | 历史追溯 | 🗄️ **已下线（2026-10-08）**：它描述的是「TV模版」时代的三栏界面，照着找对不上。替代物 = 应用内「货与成本」页头的「?」（三句话 + 三步图），见 `reviews/UX_GOODS_NOVICE_2026-10-08.md` F-2 | 2026-10-08 |
| [`requirements/Requirements.md`](requirements/Requirements.md) | 最初立项需求规格 | 历史追溯 | 🗄️ 历史档案（功能已全部实现） | 2026-06-02 |
| [`reviews/CODE_REVIEW_REPORT.md`](reviews/CODE_REVIEW_REPORT.md) | 代码与文档审查报告（31 项发现、风险分级、取证命令） | 开发者 | ✅ 活跃 | 2026-09-16 |
| [`reviews/HOST_REVIEW_2026-09-22.md`](reviews/HOST_REVIEW_2026-09-22.md) | **宿主增量复查**（下记之后）：10 项问题分 P1–P3（`dist:select` 把已下记模块当可打包项、`excel-copy` 域可全盘读写、`.gitignore` 的 `dist/` 吞掉两个岛的源码…）；含「六道门禁全绿却看不见这些」的说明 | 开发者 | 🗄️ 历史审计（9 项已修，见 `be439cc`） | 2026-09-22 |
| [`reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md`](reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md) | UI 岛冷启动「数据加载不出来 + 样式不跟主题」根因分析与修复（握手竞态 / `color-scheme`） | 开发者 | ✅ 活跃（结论已固化进基线 §11-10） | 2026-09-22 |
| [`reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md`](reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md) | **5 大目标需求的落地距离审查**：逐需求成熟度打分 + 缺口取证（含 `文件:行`）+ 改动清单 F0–F6 + 待拍板 G8–G13；含 3 处文档漂移实测 | 架构/开发者 | ✅ 活跃（审查 + 改动清单） | 2026-09-29 |
| [`reviews/UX_REVIEW_2026-09-30.md`](reviews/UX_REVIEW_2026-09-30.md) | **用户体验审查**（用户视角）：现状与问题清单 A–F 六类（每条带 `文件:行` 取证）+ 分阶段建议 + 待拍板。一句话结论：**功能都做出来了，但「装起来 / 串起来 / 看懂它」的成本全转嫁给了用户** | 架构/开发者 | ✅ 活跃（已由 `plans/UX_POLISH_PLAN.md` 逐条复核） | 2026-09-30 |
| [`reviews/UX_REVIEW_2026-09-30-R2.md`](reviews/UX_REVIEW_2026-09-30-R2.md) | **用户体验审查 · 第二轮（重构后复查）**：S1–S3 之后重走一遍用户视角（§1 现状 + §2 问题清单 + §3 第一轮逐条复核 + §4 分阶段建议 + §5 待拍板 + §6 方法局限）。**本轮新增了"用户实际会运行到的那两份东西"的对照**（本机已装插件目录 + 线上市场 catalog）—— 一句话结论：**宿主这层已能自己走完一件事，但重构成果卡在"没发布"，而发布依赖的市场当前装不上东西**（含 `window.prompt` 在 Electron 必抛错的实测） | 架构/开发者 | ✅ 活跃（本轮取证含 4 个宿主冒烟实跑） | 2026-09-30 |
| [`reviews/UX_GOODS_NOVICE_2026-10-08.md`](reviews/UX_GOODS_NOVICE_2026-10-08.md) | **「货与成本」非技术用户可用性审查**（单页深审）：判据是"不会电脑的人第一次打开"——六维打分 + Top 10 问题（每条带 `文件:行`）+ 主流程逐步走查（标断点）+ A–F 问题清单 + §3 与既有裁定逐条对齐（**不重提被撤的常驻引导条**）+ P0/P1/P2 建议（P0 全部只碰文案与模板、不发版）+ UX-G1–G5 待拍板。**一句话结论：数据层成熟，缺的是包在外面的"给外行人的皮"——术语白话化 + 隐藏高级控件 + 三处提示改成按钮** | 架构/开发者/产品 | ✅ 活跃（含 3 处死锁与术语墙取证；未做真机走查，见 §6） | 2026-10-08 |
| [`plans/REMEDIATION_PLAN.md`](plans/REMEDIATION_PLAN.md) | **工程质量整改计划**：27 个任务分 4 阶段，含验收标准 / 风险回滚 / 进度跟踪 | 开发者 | 🟢 25/27 完成（余 R4-2、R4-6 的 LICENSE） | 2026-09-27 |
| [`plans/PLUGIN_TRIAGE_PLAN.md`](plans/PLUGIN_TRIAGE_PLAN.md) | **内置插件盘点与处置**：3 内置插件 + 2 脚手架 + 5 UI 岛的逐项判定、`order-insight` ID 冲突取证、外置化步骤与验收 | 架构/开发者 | ✅ T1–T6 已完成 | 2026-09-24 |
| [`plans/DOMAIN_INTEGRATION_PLAN.md`](plans/DOMAIN_INTEGRATION_PLAN.md) | **业务域盘点与串联方案**：7 域逐表字段/读写在哪个功能、7 条断裂诊断（核心是「店铺实体不存在」）、补实体层 + 共享只读域的三步方案与阶段计划 | 架构/开发者 | 🟢 S1 已实施；下一步 S2 共享域放行 | 2026-09-27 |
| [`plans/SHIPPING_RATE_ISLAND_PLAN.md`](plans/SHIPPING_RATE_ISLAND_PLAN.md) | **无忧物流运费 UI 岛落地方案**：报价单 17 段价卡建模、克重→逐国运费计价口径、数据更新机制与执行记录 | 架构/开发者 | ✅ 已执行（2026-09-24） | 2026-09-24 |
| [`plans/PICKING_PLAN.md`](plans/PICKING_PLAN.md) | **拣货线计划**：按 SKU（款×色×码）汇总订单需求 → 拣货单。含现状（**不依赖 `pl_variants`**）、P1–P5 阶段表与件数/范围口径的**实测证据** | 架构/开发者 | ✅ P1–P5 已落地（P5 的岛发版待攒批） | 2026-09-30 |
| [`plans/DAILY_SHIPPING_FLOW_PLAN.md`](plans/DAILY_SHIPPING_FLOW_PLAN.md) | **每日发货全流程改造方案**：日导出→归类→拣货→拿货→发货→结算→对账 六步的差距审查（成熟度 90/60/35/30/85/85%）+ 三个点名问题（商品ID↔厂家产品**项目已预留未启用** / 颜色**要有权威源不是看图更准** / 进价**能算缺出口**）+ S0–S6 阶段表 + 4 项待拍板。**一句话结论：数据能补齐，缺口在三处缝合与两处新增，不新建主数据表** | 架构/开发者 | 🟢 待拍板 4 项 | 2026-10-05 |
| [`plans/PRODUCT_SKU_LINKING_PLAN.md`](plans/PRODUCT_SKU_LINKING_PLAN.md) | **产品-商品关联与 SKU 克重管理方案审查**：对一份"单屏左右分栏"提案逐条裁定（✅ 已有 6 / 🔸 形态不同 9 / 🕳️ 值得补 2 / ⛔ 冲突 3 / 🚫 不采纳 5）+ 三条硬约束 + 加法路线 P0–P3（认款看图 / 对比模式 / 产品侧已关联反查）+ 3 项待拍板。**一句话结论：数据模型与核心原则现状已落地，界面形态（左右分栏重构）不建议照抄** | 架构/开发者 | ✅ 已拍板（冻结为裁定记录；执行方案见 `plans/GOODS_WORKBENCH_PLAN.md`） | 2026-10-08 |
| [`plans/GOODS_UX_REFACTOR_PLAN.md`](plans/GOODS_UX_REFACTOR_PLAN.md) | **「货与成本」新手可用性交互重构方案（真机走查版）**：CDP 实测推翻"只差包装"——4 个硬 bug（已关联数缓存不刷新 / 「显示更多」假动作 / 窄形态空态被裁不可点 / 默认 1200×800 下「对比」不可达）+ 死锁实测成立 + R0 修 bug → R1 解死锁 → R2 包装 → R3 首次动线，守卫升级为**可达性断言**；新增待拍板 UX-G6/G7 | 架构/开发者/产品 | 🟢 待拍板 2 项（UX-G6/G7） | 2026-10-08 |
| [`plans/GOODS_WORKBENCH_PLAN.md`](plans/GOODS_WORKBENCH_PLAN.md) | **「货与成本」工作台重构方案**：把「产品」+「映射与关联」两页签合并为**左产品 / 右商品池**分栏工作台。含三项已拍板决策 · 三条硬约束的保住方式（编码锚点 / 队列非缓存 / 不做硬删）+ 第 4 条取图口径 · 数据层最小改动（**只加 `productId` 反向过滤，零新通道**）· 列裁剪对照（10→6 列 + 行展开 / 9→7 列）· S0–S5 阶段 · **守卫选择器迁移表 + 7 条变异清单** · `GOODS_LAYOUT` 回退开关与窗口宽度下限。**一句话结论：可以重构，但那是重写两个成熟表格页 —— 代价用"列裁剪 + 行展开"补，硬约束一条不放开** | 架构/开发者/产品 | 🟢 已拍板，待开工 | 2026-10-08 |
| [`plans/UX_POLISH_PLAN.md`](plans/UX_POLISH_PLAN.md) | **体验优化计划**：对 `reviews/UX_REVIEW_2026-09-30.md` 的逐条复核 + 实施计划（P0 宿主外壳零发版 7 项 / P1 结构含 2 次岛发版攒批 / P2 打磨），含 2 条改法（移回默认包 / 完整向导）与 4 项待拍板 | 架构/开发者 | 🟢 待拍板 4 项 | 2026-09-30 |
| [`plans/RESTRUCTURE_PLAN.md`](plans/RESTRUCTURE_PLAN.md) | **平台重构方案**：形态判据（岛 = 可选加工 / 宿主 = 主干）· 目标 IA（今天 / 订单 / 货与成本 / 运费 / 算钱 / 设置）· **9 处「多套」收敛清单** · 10 项历史坑删除**待拍板** · S1–S6 迁移顺序 + 四条防复发守卫 | 架构/开发者 | 🟢 待拍板 10 项（含 1 项大手术） | 2026-09-30 |
| [`plans/PAID_LICENSE_PLAN.md`](plans/PAID_LICENSE_PLAN.md) | **付费授权方案**：Pro 档功能 + 月/年双档订阅 + 零自建（托管授权 API）；三条工程事实（岛是明文静态站点 / 判定必须落主进程 / 客户端永远可 patch）· **三个执法闸门**（安装门 / 激活门 / 调用门，零新协议）· 到期降级语义 · P0–P3 改动清单与门禁 | 架构/开发者 | 🟢 方案已定稿，未开工（待拍板 5 项） | 2026-09-30 |
| [`archive/manual.md`](archive/manual.md) | 早期简版用户手册 | 历史追溯 | 🗄️ 已归档（被 `guides/USER_GUIDE.md` 取代） | 2026-06-03 |

状态图例：✅ 活跃 · 🟡 活跃但有已知缺口 · ⚠️ 已过期 · 🗄️ 已归档（仅历史对照）

> `docs/**` 现存 **70 个 `.md`**（含本文件）；判据是 `find docs -name '*.md'`，不是记忆。
> （2026-10-09 第 11 次订正：**69 → 70**，本轮加 `notes/2026-10-09-product-template-rework.md`。**当场改**。）
> （2026-10-08 第 10 次订正：**68 → 69**，本轮加 `notes/2026-10-08-goods-ux-refactor-closing-batch.md`。**当场改**。）
> （2026-10-08 第 9 次订正：**67 → 68**，本轮加 `notes/2026-10-08-goods-ux-refactor-r0-r3.md`。**当场改**。）
> （2026-10-08 第 8 次订正：**66 → 67**，本轮加 `plans/GOODS_UX_REFACTOR_PLAN.md`。**当场改**。）
> （2026-10-08 第 7 次订正：**65 → 66**，本轮加 `reviews/UX_GOODS_NOVICE_2026-10-08.md`。**当场改**。）
> （2026-10-08 第 6 次订正：**64 → 65**，本轮加 `plans/GOODS_WORKBENCH_PLAN.md`。**当场改**。）
> （2026-09-30 第 4 次订正：27 → 32 → 34 → 38 → 40 → 41；本轮加 `docs/notes/2026-09-30-island-publish-runbook.md`。）
> （2026-10-08 第 5 次订正：**41 → 64**。该计数自 2026-09-30 起未再同步，期间的 `notes/`（10-01/10-03/10-04/10-05/10-08）与 `plans/`（发货全流程、本方案审查等）都未计入 —— 实测 `find docs -name '*.md'` = 64。漂移量本身就是提醒：**计数必须当场改**。）
> （2026-09-30 第二次订正：原写 27 → 32 → 34，均落后于实测；本轮加 `UX_REVIEW_2026-09-30-R2.md` 与两条 `notes/` 后实测 **40**。
> 漂移的原因是把"同步计数"漏在收尾动作之外 —— 以后新增文档时**当场**改这一行。）

---

## 推荐阅读路径

| 你是谁 / 要做什么 | 按顺序读 |
|---|---|
| **第一次接手项目** | 根 `README.md` → `baseline/PROJECT_BASELINE.md` → `AGENTS.md` → `architecture/PLUGIN_ARCHITECTURE.md` |
| **换一个 AI 工具继续干活** | `AGENTS.md` §0（跨工具协作契约：共享层 / 私有层 / 收工两个动作）→ `notes/README.md`（结论笔记索引）→ `baseline/PROJECT_BASELINE.md`（当前状态） |
| **要改代码 / 加功能** | `AGENTS.md`（§1 架构基线、§3 红线、§5 SOP）→ `baseline/PROJECT_BASELINE.md`（§3 契约现状） |
| **要写插件** | `architecture/PLUGIN_DEVELOPMENT.md` → `architecture/PLUGIN_ARCHITECTURE.md`（§1.8 机制）→ `AGENTS.md` 红线 16–23 |
| **要接 / 改 / 排障一个 UI 岛** | `architecture/UI_ISLAND_INTAKE_CHECKLIST.md`（§1 步骤 → §2 检查项 → 故障速查）→ `architecture/PLUGIN_DEVELOPMENT.md` → `AGENTS.md` 红线 23–25 |
| **要排查性能 / 找风险** | `reviews/CODE_REVIEW_REPORT.md` → `baseline/PROJECT_BASELINE.md` |
| **要执行整改** | `plans/REMEDIATION_PLAN.md`（先读 §1 原则与 §2 依赖关系，再按 Phase 顺序做） |
| **要清理内置插件 / 外置化** | `plans/PLUGIN_TRIAGE_PLAN.md` → `AGENTS.md` §1.8/§1.9 + 红线 23 → `baseline/PROJECT_BASELINE.md` §4 |
| **要梳理业务数据 / 把各功能串起来** | `plans/DOMAIN_INTEGRATION_PLAN.md`（§1 盘点 → §2 断裂诊断 → §3 方案 → §4 阶段）→ `decisions/ADR-002-master-data-layer.md` → `features/PRODUCT_LIBRARY.md` |
| **要数据分层 / 定写入权（主数据）** | `decisions/ADR-002-master-data-layer.md`（谁是 owner、哪些能共享、哪些只能读）→ `plans/DOMAIN_INTEGRATION_PLAN.md` §3 |
| **要改物流运费（运价换版 / 计价口径）** | `plans/SHIPPING_RATE_ISLAND_PLAN.md` → `ui-plugins/shipping-rate/README.md`（换版流程 + 自检陷阱表）→ `tests/shipRate.spec.ts`（改口径必同步的断言） |
| **要评估体验 / 改界面与文案** | `reviews/UX_REVIEW_2026-09-30-R2.md`（**最新**：§0 结论 + §2 问题清单 + §3 上一轮复核）→ `reviews/UX_REVIEW_2026-09-30.md`（第一轮，看历史）→ `plans/UX_POLISH_PLAN.md`（逐条复核 + 执行顺序 + 待拍板）→ `plans/DOMAIN_INTEGRATION_PLAN.md`（数据侧同一批断点） |
| **要做付费授权 / 加付费墙** | `plans/PAID_LICENSE_PLAN.md`（§1 三条工程事实 → §4 定案设计 → §5 改动清单）→ `notes/2026-09-30-paid-license-enforcement.md` → `AGENTS.md`（§1.1 三层边界 / §1.8 域与权限门）→ `architecture/PLUGIN_ARCHITECTURE.md` §9 |
| **终端用户** | **应用内**：「货与成本」页头的「?」；空库时页面自己给的引导卡（`guides/USER_GUIDE.md` 已下线，只在需要追溯历史时看） |

---

## 维护规则

1. **规则只有一份**：架构约束与编码红线的唯一权威是根目录 `AGENTS.md`。其他文档写「为什么」和「怎么做」，不复制规则原文（`PLUGIN_ARCHITECTURE.md` 已确立"避免双头文档漂移"原则）。
2. **状态标注必填**：新增或迁移文档，须在头部标注状态（活跃 / 已过期 / 已归档），并写清被谁取代。归档文档不删除、只标注，保留演进可追溯性。
3. **事实以代码为准**：文档描述与 `src/` `electron/` 实际实现冲突时，先按代码修正文档；改动架构时同步回写 `AGENTS.md` 与 `baseline/PROJECT_BASELINE.md`。
4. **基线刷新时机**：`package.json` 版本号变更、新增模块/插件、新增 IPC 通道域、依赖大版本升级后，刷新 `baseline/PROJECT_BASELINE.md`。
5. **交叉引用用仓库根相对路径**（如 `docs/features/PROFIT_TRACKER.md`），不用裸文件名。
6. **结论进 `docs/notes/`**："下次开工还得记得"的结论写成 `docs/notes/YYYY-MM-DD-<slug>.md` 并在 `docs/notes/README.md` 登记一行 ——
   工具私有记忆目录（`.workbuddy/` / `~/.qoder/` / `~/.hermes/`）**不是共享层**（换机器即失效），见 `AGENTS.md` §0。
   `npm run verify:docs` 会**反向校验**：`docs/notes/` 里的笔记必须命名合规且已登记索引。

---

## 版本管理策略

**全部文档入库**（R4-5 / D-07，2026-09-16 决策变更）。

原策略只让「对外可共享」的文档入库，暴露了两个实际问题：

1. `AGENTS.md` 是编码助手的**强制约定入口**，不入库等于"换机器/协作即失效"；
2. `PLUGIN_DEVELOPMENT.md`（入库）大量引用 `PLUGIN_ARCHITECTURE.md` / `AGENTS.md`（不入库），
   克隆仓库者必然看到**指向不存在文件的悬空引用**。

现策略：`AGENTS.md` 与 `docs/**` **全部入库**，可追溯性优先于仓库整洁度。
仍不入库的只有 `.workbuddy/` / `.codebuddy/`（AI 工具本地数据，非项目文档）。
入库前已扫描密钥 / 内网 IP / 凭据，无命中。

> ⚠️ **该策略有一处副作用**（已记为发现项 `D-07`，整改任务 `R4-5`）：`PLUGIN_DEVELOPMENT.md` 入库但引用了不入库的 `PLUGIN_ARCHITECTURE.md`，因此克隆仓库者会看到悬空引用。策略定案前请知悉。

---

## 目录结构

```
docs/
├── README.md                      # 本文件 —— 文档索引
├── baseline/                      # 项目基线
│   ├── PROJECT_BASELINE.md        # 当前状态快照
│   └── REFACTOR_PLAN.md           # 重构计划（已归档）
├── architecture/                  # 架构
│   ├── PLUGIN_ARCHITECTURE.md     # 插件化方向性架构
│   ├── PLUGIN_DEVELOPMENT.md      # 插件开发手册
│   └── UI_ISLAND_INTAKE_CHECKLIST.md  # UI 岛接入/改动/排障清单
├── decisions/                     # 架构决策记录（ADR）
│   ├── ADR-001-...md              # 岛设置留岛内
│   └── ADR-002-master-data-layer.md
├── features/                      # 业务方案
│   ├── MAIL_INBOX.md
│   ├── PRODUCT_LIBRARY.md
│   └── PROFIT_TRACKER.md
├── guides/                        # 用户文档（USER_GUIDE 已下线，现为下线说明）
│   └── USER_GUIDE.md
├── notes/                         # 跨工具结论（AGENTS §0 共享层）
│   ├── README.md                  # 索引（必须登记）
│   └── YYYY-MM-DD-<slug>.md
├── requirements/                  # 需求档案
│   └── Requirements.md
├── reviews/                       # 审查报告
│   ├── CODE_REVIEW_REPORT.md
│   ├── BUSINESS_GAP_ANALYSIS_2026-09-29.md
│   └── UX_REVIEW_2026-09-30.md
├── plans/                         # 计划
│   ├── REMEDIATION_PLAN.md
│   ├── PLUGIN_TRIAGE_PLAN.md
│   ├── DOMAIN_INTEGRATION_PLAN.md
│   ├── PICKING_PLAN.md
│   ├── DAILY_SHIPPING_FLOW_PLAN.md   # 每日发货全流程（拣货线的上位主流程）
│   ├── UX_POLISH_PLAN.md
│   ├── PAID_LICENSE_PLAN.md       # 付费授权方案（未开工）
│   └── RESTRUCTURE_PLAN.md
└── archive/                       # 归档
    └── manual.md
```
