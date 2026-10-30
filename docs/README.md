# 文档中心

SellerKit 项目文档索引。**先看这里的表格找文档，再打开具体文件**——不要凭记忆猜文件名，2026-09-16 起文档已按分类归入 `docs/` 子目录。

> 项目入口（安装 / 构建 / 目录结构 / 架构要点）见根目录 [`README.md`](../README.md)。
> 代码改动规则（架构基线 + 23 条红线）见根目录 [`AGENTS.md`](../AGENTS.md)。

---

## 文档地图

| 文档 | 主旨 | 读者 | 状态 | 最后更新 |
|---|---|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **架构基线 + 编码红线**（三层边界 / 模块化 / 插件体系 / 命名 / 异常 / 红线 1–23）**+ §0 跨工具协作契约** | 开发者、AI 助手 | ✅ 活跃（唯一规则源） | 2026-10-22 |
| [`notes/README.md`](notes/README.md) | **跨工具结论笔记**：多 AI 工具交替开工时"以后要记住什么"的结论层（命名 / 必须登记索引 / 与工具私有记忆的关系，规则见 `AGENTS.md` §0） | 开发者、AI 助手 | ✅ 活跃 | 2026-09-30 |
| [`baseline/PROJECT_BASELINE.md`](baseline/PROJECT_BASELINE.md) | **项目基线快照**：结构、规模、模块/插件注册表、IPC 契约、持久化、依赖、质量门禁现状 | 开发者、新人 | ✅ 活跃（随版本刷新） | 2026-10-22 |
| [`archive/baseline/REFACTOR_PLAN.md`](archive/baseline/REFACTOR_PLAN.md) | Phase 0–3 单体 → 模块化重构计划 | 架构/开发者 | 🗄️ 已完成归档 | 2026-08-21 |
| [`architecture/PLUGIN_ARCHITECTURE.md`](architecture/PLUGIN_ARCHITECTURE.md) | 插件化方向性架构：Phase 1–5、Worker 沙箱、权限门、UI 岛方案 | 架构/开发者 | ✅ 活跃（方向性，规则以 AGENTS.md 为准） | 2026-09-08 |
| [`architecture/PLUGIN_DEVELOPMENT.md`](architecture/PLUGIN_DEVELOPMENT.md) | 外置插件与 UI 岛开发、调试、发布操作手册 | 插件作者 | ✅ 活跃 | 2026-09-15 |
| [`architecture/UI_ISLAND_INTAKE_CHECKLIST.md`](architecture/UI_ISLAND_INTAKE_CHECKLIST.md) | **UI 岛接入 / 改动 / 排障逐步清单**：§1 步骤 · §2 检查项 · 故障速查表 · 一键冒烟 | 插件作者 | ✅ 活跃（新增或改岛前先过一遍） | 2026-09-24 |
| [`decisions/ADR-001-island-settings-stay-in-island.md`](decisions/ADR-001-island-settings-stay-in-island.md) | **ADR-001**：`excel-copy` / `order-insight` 的设置**保留在岛内视图**（不收编进宿主设置中心）—— 含判据与重新评估条件 | 架构/开发者 | ✅ 已裁定（改这两个插件的设置入口前必读） | 2026-09-25 |
| [`decisions/ADR-002-master-data-layer.md`](decisions/ADR-002-master-data-layer.md) | **ADR-002**：建立「主数据层」—— 基础数据独立维护、**以 ID 关联**（C1–C4 单一写入方 / 共享只读域 / G2 历史文本不改写 / D4b 变动即替换） | 架构/开发者 | ✅ 已裁定（S1 店铺实体已落地）；⚠️ 物理分表结论部分被 ADR-003 取代 | 2026-10-22 |
| [`decisions/ADR-003-shop-account-physical-merge.md`](decisions/ADR-003-shop-account-physical-merge.md) | **ADR-003**：店铺与账号**物理合并**为一张 `sk_shops`（含加密凭据），`sk_shop_sets` 删除；保留 ADR-002 C1–C4，**凭据边界下沉到 API 层**（共享域不返回密文、明文只走 owner reveal） | 架构/开发者 | ✅ 已裁定并落地（2026-10-22，`shop.main` v1 已在真库执行） | 2026-10-22 |
| [`features/MAIL_INBOX.md`](features/MAIL_INBOX.md) | 集中收件箱 M1–M3 设计与落地（IMAP / FTS / 附件缓存）+ 正文渲染通道 `sk-mail://`（内联图与远程图） | 开发者 | ✅ 活跃 | 2026-10-04 |
| [`features/PROFIT_TRACKER.md`](features/PROFIT_TRACKER.md) | 速卖通利润追踪三端方案与落地路线（**跨端协议唯一权威来源**） | 架构/开发者 | ✅ 活跃（含 2026-09-16 漂移提示） | 2026-09-15 |
| [`features/PRODUCT_LIBRARY.md`](features/PRODUCT_LIBRARY.md) | **跨境产品库**：产品（款式）主数据 + SKU/克重 + 店铺商品清单 + 商品ID↔产品映射。⚠️ **2026-10-01 起 UI 收归内建「货与成本」**（原 UI 岛已下架，§6.2 的域表已成历史，见 §0-A）；§1–§3、§5.1、§5.2 仍描述现状 | 架构/开发者 | 🟢 数据层 P0–P4 已落地（P5 未开工）；UI = 内建页 | 2026-10-01 |
| [`guides/USER_GUIDE.md`](guides/USER_GUIDE.md) | 用户使用指南 —— **已下线**，现为下线说明（正文删除） | 历史追溯 | 🗄️ **已下线（2026-10-08）**：它描述的是「TV模版」时代的三栏界面，照着找对不上。替代物 = 应用内「货与成本」页头的「?」（三句话 + 三步图），见 `reviews/UX_GOODS_NOVICE_2026-10-08.md` F-2 | 2026-10-08 |
| [`archive/requirements/Requirements.md`](archive/requirements/Requirements.md) | 最初立项需求规格 | 历史追溯 | 🗄️ 历史档案（功能已全部实现） | 2026-06-02 |
| [`reviews/CODE_REVIEW_REPORT.md`](reviews/CODE_REVIEW_REPORT.md) | 代码与文档审查报告（31 项发现、风险分级、取证命令） | 开发者 | ✅ 活跃 | 2026-09-16 |
| [`archive/reviews/HOST_REVIEW_2026-09-22.md`](archive/reviews/HOST_REVIEW_2026-09-22.md) | **宿主增量复查**（下记之后）：10 项问题分 P1–P3（`dist:select` 把已下记模块当可打包项、`excel-copy` 域可全盘读写、`.gitignore` 的 `dist/` 吞掉两个岛的源码…）；含「六道门禁全绿却看不见这些」的说明 | 开发者 | 🗄️ 历史审计（9 项已修，见 `be439cc`） | 2026-09-22 |
| [`reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md`](reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md) | UI 岛冷启动「数据加载不出来 + 样式不跟主题」根因分析与修复（握手竞态 / `color-scheme`） | 开发者 | ✅ 活跃（结论已固化进基线 §11-10） | 2026-09-22 |
| [`reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md`](reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md) | **5 大目标需求的落地距离审查**：逐需求成熟度打分 + 缺口取证（含 `文件:行`）+ 改动清单 F0–F6 + 待拍板 G8–G13；含 3 处文档漂移实测 | 架构/开发者 | ✅ 活跃（审查 + 改动清单） | 2026-09-29 |
| [`reviews/UX_REVIEW_2026-09-30.md`](reviews/UX_REVIEW_2026-09-30.md) | **用户体验审查**（用户视角）：现状与问题清单 A–F 六类（每条带 `文件:行` 取证）+ 分阶段建议 + 待拍板。一句话结论：**功能都做出来了，但「装起来 / 串起来 / 看懂它」的成本全转嫁给了用户** | 架构/开发者 | ✅ 活跃（已由 `plans/UX_POLISH_PLAN.md` 逐条复核） | 2026-09-30 |
| [`reviews/UX_REVIEW_2026-09-30-R2.md`](reviews/UX_REVIEW_2026-09-30-R2.md) | **用户体验审查 · 第二轮（重构后复查）**：S1–S3 之后重走一遍用户视角（§1 现状 + §2 问题清单 + §3 第一轮逐条复核 + §4 分阶段建议 + §5 待拍板 + §6 方法局限）。**本轮新增了"用户实际会运行到的那两份东西"的对照**（本机已装插件目录 + 线上市场 catalog）—— 一句话结论：**宿主这层已能自己走完一件事，但重构成果卡在"没发布"，而发布依赖的市场当前装不上东西**（含 `window.prompt` 在 Electron 必抛错的实测） | 架构/开发者 | ✅ 活跃（本轮取证含 4 个宿主冒烟实跑） | 2026-09-30 |
| [`reviews/UX_GOODS_NOVICE_2026-10-08.md`](reviews/UX_GOODS_NOVICE_2026-10-08.md) | **「货与成本」非技术用户可用性审查**（单页深审）：判据是"不会电脑的人第一次打开"——六维打分 + Top 10 问题（每条带 `文件:行`）+ 主流程逐步走查（标断点）+ A–F 问题清单 + §3 与既有裁定逐条对齐（**不重提被撤的常驻引导条**）+ P0/P1/P2 建议（P0 全部只碰文案与模板、不发版）+ UX-G1–G5 待拍板。**一句话结论：数据层成熟，缺的是包在外面的"给外行人的皮"——术语白话化 + 隐藏高级控件 + 三处提示改成按钮** | 架构/开发者/产品 | ✅ 活跃（含 3 处死锁与术语墙取证；未做真机走查，见 §6） | 2026-10-08 |
| [`reviews/AE_SHOP_ITEM_SYNC_PLAN_REVIEW_2026-10-12.md`](reviews/AE_SHOP_ITEM_SYNC_PLAN_REVIEW_2026-10-12.md) | **店铺商品采集方案审查**：约 30 处代码取证逐条核对（几乎全部精确，2 处计数漂移）+ 方案做对的 8 条 + **3 处 P1**（店铺 URL 精确相等会大面积失配 / 未登记店 `UNIQUE(shop_id, item_id)` 互相撞键 / "建档+关联单事务回滚"是做不到的验收点）+ 6 处 P2 + D1–D12 裁定 + 三处过度设计裁退。**一句话结论：方案成立，按修订清单开工；动代码前先理清工作区（99 个文件未提交，含要碰的 7 个）** | 架构/开发者 | ✅ 活跃 | 2026-10-12 |
| [`plans/REMEDIATION_PLAN.md`](plans/REMEDIATION_PLAN.md) | **工程质量整改计划**：27 个任务分 4 阶段，含验收标准 / 风险回滚 / 进度跟踪 | 开发者 | 🟢 25/27 完成（余 R4-2、R4-6 的 LICENSE） | 2026-09-27 |
| [`archive/plans/PLUGIN_TRIAGE_PLAN.md`](archive/plans/PLUGIN_TRIAGE_PLAN.md) | **内置插件盘点与处置**：3 内置插件 + 2 脚手架 + 5 UI 岛的逐项判定、`order-insight` ID 冲突取证、外置化步骤与验收 | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ T1–T6 已完成 | 2026-09-24 |
| [`plans/DOMAIN_INTEGRATION_PLAN.md`](plans/DOMAIN_INTEGRATION_PLAN.md) | **业务域盘点与串联方案**：7 域逐表字段/读写在哪个功能、7 条断裂诊断（核心是「店铺实体不存在」）、补实体层 + 共享只读域的三步方案与阶段计划 | 架构/开发者 | 🟢 S1 已实施；下一步 S2 共享域放行 | 2026-09-27 |
| [`archive/plans/SHIPPING_RATE_ISLAND_PLAN.md`](archive/plans/SHIPPING_RATE_ISLAND_PLAN.md) | **无忧物流运费 UI 岛落地方案**：报价单 17 段价卡建模、克重→逐国运费计价口径、数据更新机制与执行记录 | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ 已执行（2026-09-24） | 2026-09-24 |
| [`archive/plans/PICKING_PLAN.md`](archive/plans/PICKING_PLAN.md) | **拣货线计划**：按 SKU（款×色×码）汇总订单需求 → 拣货单。含现状（**不依赖 `pl_variants`**）、P1–P5 阶段表与件数/范围口径的**实测证据** | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ P1–P5 已落地（P5 的岛发版待攒批） | 2026-09-30 |
| [`plans/DAILY_SHIPPING_FLOW_PLAN.md`](plans/DAILY_SHIPPING_FLOW_PLAN.md) | **每日发货全流程改造方案**：日导出→归类→拣货→拿货→发货→结算→对账 六步的差距审查（成熟度 90/60/35/30/85/85%）+ 三个点名问题（商品ID↔厂家产品**项目已预留未启用** / 颜色**要有权威源不是看图更准** / 进价**能算缺出口**）+ S0–S6 阶段表 + 4 项待拍板。**一句话结论：数据能补齐，缺口在三处缝合与两处新增，不新建主数据表** | 架构/开发者 | 🟢 待拍板 4 项 | 2026-10-05 |
| [`archive/plans/PRODUCT_SKU_LINKING_PLAN.md`](archive/plans/PRODUCT_SKU_LINKING_PLAN.md) | **产品-商品关联与 SKU 克重管理方案审查**：对一份"单屏左右分栏"提案逐条裁定（✅ 已有 6 / 🔸 形态不同 9 / 🕳️ 值得补 2 / ⛔ 冲突 3 / 🚫 不采纳 5）+ 三条硬约束 + 加法路线 P0–P3（认款看图 / 对比模式 / 产品侧已关联反查）+ 3 项待拍板。**一句话结论：数据模型与核心原则现状已落地，界面形态（左右分栏重构）不建议照抄** | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ 已拍板（冻结为裁定记录；执行方案见 `plans/GOODS_WORKBENCH_PLAN.md`） | 2026-10-08 |
| [`plans/GOODS_TAB_REDESIGN_2026-10-25.md`](plans/GOODS_TAB_REDESIGN_2026-10-25.md) | **「款与商品」页重设计方案（P2 / P3 施工用）**：把「建档与关联」的杂乱拆成可施工的步骤 —— 诊断 6 条（认款 4 个近义入口 / 右栏把"来源"当并列页签 / 左展开区与右映射表同屏重复 / 款·产品·商品三词混用 等，均带 `data-act` 取证）+ 目标判据（认款入口 4→1、右栏分段 3→2、行详情 4 件事→0）+ 信息架构与两源合并的视图模型（不改主进程）+ 认款单动线 + 施工 S1–S5 与每步的冒烟改动清单 + 回退与变异复核。**一句话结论：改名与层级已落地，真正的减法必须连冒烟断言一起改，不能靠折叠面板"过断言"** | 架构/开发者/产品 | 🟡 P0/P1 已完成，P2 待开工 | 2026-10-25 |
| [`plans/GOODS_UX_REFACTOR_PLAN.md`](plans/GOODS_UX_REFACTOR_PLAN.md) | **「货与成本」新手可用性交互重构方案（真机走查版）**：CDP 实测推翻"只差包装"——4 个硬 bug（已关联数缓存不刷新 / 「显示更多」假动作 / 窄形态空态被裁不可点 / 默认 1200×800 下「对比」不可达）+ 死锁实测成立 + R0 修 bug → R1 解死锁 → R2 包装 → R3 首次动线，守卫升级为**可达性断言**；新增待拍板 UX-G6/G7 | 架构/开发者/产品 | 🟢 待拍板 2 项（UX-G6/G7） | 2026-10-08 |
| [`plans/GOODS_WORKBENCH_PLAN.md`](plans/GOODS_WORKBENCH_PLAN.md) | **「货与成本」工作台重构方案**：把「产品」+「映射与关联」两页签合并为**左产品 / 右商品池**分栏工作台。含三项已拍板决策 · 三条硬约束的保住方式（编码锚点 / 队列非缓存 / 不做硬删）+ 第 4 条取图口径 · 数据层最小改动（**只加 `productId` 反向过滤，零新通道**）· 列裁剪对照（10→6 列 + 行展开 / 9→7 列）· S0–S5 阶段 · **守卫选择器迁移表 + 7 条变异清单** · `GOODS_LAYOUT` 回退开关与窗口宽度下限。**一句话结论：可以重构，但那是重写两个成熟表格页 —— 代价用"列裁剪 + 行展开"补，硬约束一条不放开** | 架构/开发者/产品 | 🟢 已拍板，待开工 | 2026-10-08 |
| [`reviews/AE_SHOP_ITEM_SYNC_PLAN_IMPL_REVIEW_2026-10-13.md`](reviews/AE_SHOP_ITEM_SYNC_PLAN_IMPL_REVIEW_2026-10-13.md) | **店铺商品采集 P0–P5 实现复核**：逐期核对 + **两个可复现脚本实跑**（非静态推断）+ 断言反查夹具。**1 个 P0**（色图采纳把 `pl_images` 的 id 当 `oi_images` 用 ⇒ 真的把**无关订单图**绑进款色，污染订单归款，回执还报 `bound:true`）+ **2 个 P1**（岛版 `shopUpsert` 漏透传 `shop_url` ⇒ 编辑一次静默清空地址；保底通道点名店铺却落未登记桶）+ 6 条 P2 + 文档陈旧。**一句话结论：功能面八成五、门禁全绿，但那 5 条"色图采纳"用例是恒绿守卫——夹具插的是 `oi_images`，生产传的是 `pl_images`** | 架构/开发者 | ✅ 活跃（未修，待拍板修法） | 2026-10-13 |
| [`plans/AE_SHOP_ITEM_SYNC_PLAN.md`](plans/AE_SHOP_ITEM_SYNC_PLAN.md) | **速卖通店铺商品采集**方案：扩展采「店里有什么」→ 右栏**「待关联采集商品」**段（2026-10-16 由「店铺商品」改名且恒只列未认款，见该文 §4.2 现状回改）→ 认款/建款向导（新增面 = 1 端点 + 1 快照表 `pl_shop_items` + `sk_shops` 1 列 + 1 向导，**零新写口径**）；§8 SKU 色图闭环（采集色图 → 认款时采纳为款色绑定图 → 订单同图走既有去重自动归色） | 架构/开发者 | 🟢 已审定（修订清单见审查稿） | 2026-10-12 |
| [`plans/ORDER_ATTRIBUTION_WEIGHT_PLAN.md`](plans/ORDER_ATTRIBUTION_WEIGHT_PLAN.md) | **订单归款归色与克重取数简化方案**：两个目标的最小键都是「商品ID」，现状绑在「款色码」上多绕两跳 ⇒ P0 修 `variantUpsert` 全量提交清 `code/weight`（多店铺合并静默毁数据，有触发路径）+ P1 克重加第二级键 `(商品ID,尺码)`（未认款也能算运费）+ P2 单色商品自动定色 + P3 变体级对照（可选）+ P4 订单 size 归一；含 DDL、读写口、迁移回滚、5 条变异清单、5 项待拍板。**一句话结论：运费不该等认款，但产品成本仍然要** | 架构/开发者 | 🟡 待拍板（P0 建议先做） | 2026-10-19 |
| [`reviews/ORDER_PICKING_SIMPLIFY_2026-10-20.md`](reviews/ORDER_PICKING_SIMPLIFY_2026-10-20.md) | **「订单 → 拿货」链路简化审查**：四个需求（导入 / 分析款色码 / 按款色码统计拿货 / 拿全·拿了多少·花了多少）逐条对照现状，定位 **3 套需求口径 · 10 处手拼文本键 · 3 套金额口径 · 2 条取图链 · 9 个归色重算触发点**；F1–F16 逐条带 `文件:行` 与真库取证（需求按行数、已拿按件数会漏货；INNER JOIN 让 9/51 行对缺口不可见；色名当身份 ⇒ 改名即失联）。目标模型只加 4 列 + 3 条 SQL，分 P0/P1/P2 三期，含"明确不做"清单与 D1–D4 待拍板。**一句话结论：不是功能复杂，是分析结论没有落点 —— 款色只能从图片间接派生，于是每个消费者各走一遍、各拼一套键** | 架构/开发者/产品 | 🟢 待拍板（P0 建议先做） | 2026-10-20 |
| [`archive/reviews/LEDGER_REVIEW_2026-10-27.md`](archive/reviews/LEDGER_REVIEW_2026-10-27.md) | **记账模块审查**（功能完整性 / 逻辑漏洞 / 交互 / 可理解性）：四项硬骨头（分摊单点实现 + 守恒断言、结算金额结构上不可手填、结算行部分唯一索引、已结算字段前后端同一判据）全部正确，**未发现算错钱的实现缺陷**；2 个阻断入口（「全部日期」下记一笔不可用、台账读取失败反显"对账通过"）+ 5 处错账缺口（导入全选勾进重复行、公共条目无库内查重、批量操作静默截断 500 条、全已结算时自动预选"撤销结算"、单店下拉不显示当前店）+ 主流程第四步「发现记错人后改挂」动线断点。含体检④恒零空转、`其中公共` 收支混加等 4 处口径问题与三批修复顺序 | 架构/开发者/产品 | 🗄️ 已归档（2026-10-30） · ✅ 已修（24 项四批全部落地，验收记录见 [`archive/plans/LEDGER_FIX_PLAN_2026-10-27.md`](archive/plans/LEDGER_FIX_PLAN_2026-10-27.md) §10.1） | 2026-10-27 |
| [`reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md`](reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md) | **产品管理相关表审查（冗余判定与改造建议）**：15 张表逐表判定 + 真库只读取证（池行 **0** / `pl_images` 12 张**与 `oi_images` 同指纹双份字节** / `oi_styles` 13 行中 12 行与 `pl_products` 同码 / 套装写函数**零生产调用者** ⇒ `oi_item_parts` 恒 0 / 孤儿 `pl_variants` 23 + `oi_variant_keys` 9）。分 A（真冗余）/ B（结构待收紧）/ C（明确非冗余）三级，给 P0 清理 → P1 池行退役 → P2 结构改造（`oi_styles.product_id` / 套装取舍 / 指纹退役）与「明确不做」清单。**一句话结论：没有整张多余的表，可退役的只有「商品清单」池这一支；该改的是"款有两套""套装没人能配"，不该动 `pl_variants` / `oi_style_colors` / `pl_item_images`**。**§10** 复核一份外部 AI 重构提案：其表/列/行数与本仓库 schema 对不上，"视图替代 `oi_style_colors`""合并 `pl_shop_items`""去掉 `pl_products.code`""变体加成本"四处会弄坏运行时，**不建议执行**；可吸收的只有"颜色/尺码主数据 + 别名"，并按 §10.4 的 S1–S5（数据可丢则不做迁移）重写 | 架构/开发者/产品 | 🟢 待拍板（P0 可直接做） | 2026-10-30 |
| [`plans/PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md`](plans/PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md) | **产品/订单模型简化方案**：直击用户口径「简单功能十几张表、数据维护不好、Excel 定不了款色、SKU 维护太贵」。根因三条（映射键缺 `spec` ⇒ 46/48 行只能 `'*'`；一个款色被 `oi_styles`/`oi_style_colors`/`oi_variant_keys` 投影三次；457 行 SKU vs 订单仅 59 个键）。目标：款色降级为映射行上的一个色值，SKU 降级为按需附件；15 表 → 10 表、623 行维护面 → 约 149 行 + 首轮 69 次决定。~~S0 单独先做即可让 Excel 按 `(店铺,商品ID,Color)` 一次命中款色~~ → **2026-10-30 已订正：`Color` 原文会复用，`(店铺,商品ID,订单图片)` 才是 SKU 级精确键，`spec='*'` 回落作废**；S0 需按新键重排（见拆解清单 D1–D5），S1–S4 依次做认款分组、款色收口、SKU 稀疏+默认克重、删死表；**§10** 给出 R0/R1 文件级施工清单（唯一图片落地函数、删三张旧图表、备份改 `images/`、色/码改 id、冒烟与 5 个变异点） | 架构/开发者/产品 | 🟢 **R0 已完成全绿**（拆行器/幂等键/清库），下一步 R1 主数据 | 2026-10-30 |
| [`plans/FEATURE_DECOMPOSITION_2026-10-30.md`](plans/FEATURE_DECOMPOSITION_2026-10-30.md) | **发货台 / 产品管理功能拆解与待确认清单**：按用户纠错把"订单图片才是 SKU 级精确键、`Color` 原文会复用、`spec='*'` 回落作废"定为讨论基线；逐项拆 T-01–T-19（发货台 5 页签）与 P-01–P-28（产品管理左右栏 / 抽屉 / SKU / 导入 / 向导），每项给入口·输入键·写表·现状问题·待确认；附三条身份链与四套色词表（23/32/15/3 种）+ 决策表 D1–D18（图片键口径 / `color_raw` 是否入键 / 映射表改法 / 解析回落 / SKU 去留 / 克重粒度 / 色名词典 / 认款 UI 落点 / 状态回滚 / 图片目录 / 旧数据 / 池与套装 / **图片属性落点 / 远端图落地 / 识别字段去留 / 颜色别名作用域 / 变体文本列**）+ 确认后 R0–R6 分期（对齐方案 S0a/S0b/S1–S4）。**§4.3 统一图片表**：现状"两套半"（`pl_images` 12 + `oi_images` 101 + `pl_item_images` 0、同指纹双份、`pl_shop_items.image_id` 0/71、备份只含 `order-images/`）→ `md_images` 单表内容寻址 + 统一 `userData/images/`；**§4.4 颜色/尺码主数据**：`md_colors` / `md_sizes` / `md_color_aliases`，其他表只存 `color_id`/`size_id`。**D1–D18 与 Q6 全部确认**（拆行器先修；认款 UI 放发货台；待认四档状态；池与套装删；图片属性只写映射行；远端图全落地；识别字段全删；别名全局+按款；变体只留 id）。**一句话结论：键与主数据口径已定，可按方案 §10 从 R0/R1 开工；本文仍未改代码** | 产品/架构/开发者 | 🟢 已全部确认（未改代码） | 2026-10-30 |
| [`plans/UX_POLISH_PLAN.md`](plans/UX_POLISH_PLAN.md) | **体验优化计划**：对 `reviews/UX_REVIEW_2026-09-30.md` 的逐条复核 + 实施计划（P0 宿主外壳零发版 7 项 / P1 结构含 2 次岛发版攒批 / P2 打磨），含 2 条改法（移回默认包 / 完整向导）与 4 项待拍板 | 架构/开发者 | 🟢 待拍板 4 项 | 2026-09-30 |
| [`plans/RESTRUCTURE_PLAN.md`](plans/RESTRUCTURE_PLAN.md) | **平台重构方案**：形态判据（岛 = 可选加工 / 宿主 = 主干）· 目标 IA（今天 / 订单 / 货与成本 / 运费 / 算钱 / 设置）· **9 处「多套」收敛清单** · 10 项历史坑删除**待拍板** · S1–S6 迁移顺序 + 四条防复发守卫 | 架构/开发者 | 🟢 待拍板 10 项（含 1 项大手术） | 2026-09-30 |
| [`plans/PAID_LICENSE_PLAN.md`](plans/PAID_LICENSE_PLAN.md) | **付费授权方案**：Pro 档功能 + 月/年双档订阅 + 零自建（托管授权 API）；三条工程事实（岛是明文静态站点 / 判定必须落主进程 / 客户端永远可 patch）· **三个执法闸门**（安装门 / 激活门 / 调用门，零新协议）· 到期降级语义 · P0–P3 改动清单与门禁 | 架构/开发者 | 🟢 方案已定稿，未开工（待拍板 5 项） | 2026-09-30 |
| [`archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`](archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md) | **订单-采购模型简化执行计划**：把「进价/克重/运费」从实时反查（`ae_cost_map`/`pl_shop_sku`/`sr_rate_snapshots`）改成落库快照，利润只依赖订单域三表。分阶段 A 快照前置（`pl_products`+进价、`pl_variants`+image_id、订单表+总克重/总物流费、关联表+克重/实际进价、`purchase-cost-sync`/`manual-costs` 改落点、利润引擎改读快照）/ B 拆表+包裹（`parcels`+`parcel_lines` 支持一单多包拆数量）/ C 退役表。方案前提见 `notes/2026-10-30-order-table-and-model.md`。**A / B1 / B2 / C1 / C2 全部落地（含 `ae_cost_map` 删除，`order.main` v10），计划已收口** | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ 已完成 | 2026-10-21 |
| [`archive/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md`](archive/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md) | **店铺账号表与界面重构方案（物理合并版）**：店铺 + 账号合成一张 `sk_shops`（`name` / `email` 任一非空即可，分别表示「只有账号」「只有店铺」），删除 `sk_shop_sets`；紫鸟/ERP 独立成 `sk_tool_accounts`（一条登录一份密码），手机号与支付宝归企业、国际支付宝密码留店；邮件外键改指 `sk_shops`。含真库取证（10 账号无店、3 店无账号、12 账号共用 1 个 ERP）、一次性重建两张表的迁移与预检、旧 id 1–9 保留、合并列表/编辑器/一次保存 + 企业/手机/支付宝联动筛选、删除保护与明确不做清单 | 架构/开发者/产品 | 🗄️ 已归档（2026-10-30） · ✅ **已落地（2026-10-22，P0–P3）**，判据核对见其 §7.1 | 2026-10-22 |
| [`plans/LEDGER_PLAN.md`](plans/LEDGER_PLAN.md) | **记账（店铺收支 + 公共费用分摊 + 资金相关人往来结算）设计方案 v1.3**：口径先定（记账=已发生业务收支，**与「统计」的订单毛利不可相加**）· `bk_*` 十表（`period` 用 SQLite 生成列、结算行用**部分唯一索引** `WHERE active=1` 才允许撤销后重结）· 店铺轴分摊三基准 + 最大余数法尾差 · **相关人轴往来六数（应收/应付/净往来/已结/未结清/分方向未结清）** · 结算三件套（幂等 / 台账恒等式 / **按方向上限**拦截）· **变更相关人拆三路（改挂 / 改挂+留旧账 / 撤销后改挂）** · **相关人必填** · P0–P4 分期与 19 条 FR。**一句话结论：难点不在记账表单，在于把第四套金额口径隔离干净、让分摊是可重算的派生数据，并让"改人"分成纠错与转移两件事** | 架构/开发者/产品 | 🟢 **P0 数据层 + P1 界面已落地**（明细页 / 记一笔含公共分摊 / 相关人与科目管理）；P2 剩余：营收占比基准 / 分摊方案存取 / 分摊明细展开 / 店铺删除保护；往来与结算待下一轮 | 2026-10-25 |
| [`archive/plans/LEDGER_FIX_PLAN_2026-10-27.md`](archive/plans/LEDGER_FIX_PLAN_2026-10-27.md) | **记账模块修改计划**：把审查的 2 阻断 / 5 错账缺口 / 4 处口径 / 15 项交互拆成 **A 界面止血（12 项、零迁移）→ B 拦截与口径（7 项、改 handlers/db）→ C 体检与治理（4 项、含迁移 v3）→ D 文档订正**；每项给 `文件:行` 改法、可执行验收、**变异点（改坏哪一行必须红）**、风险与回滚，另含 6 项待拍板与「明确不做」清单。**一句话结论：先把「点过全部就记不了账」「读取失败反显对账通过」清掉再谈口径；B 批必须早于 C 批（B5 与 C1 落在同一段汇总 SQL）** | 架构/开发者 | 🗄️ 已归档（2026-10-30） · ✅ 已完工（A/B/C/D 四批全部落地，含迁移 v3；见 §10.1 实施记录） | 2026-10-27 |
| [`archive/manual.md`](archive/manual.md) | 早期简版用户手册 | 历史追溯 | 🗄️ 已归档（被 `guides/USER_GUIDE.md` 取代） | 2026-06-03 |

状态图例：✅ 活跃 · 🟡 活跃但有已知缺口 · ⚠️ 已过期 · 🗄️ 已归档（仅历史对照）

> `docs/**` 现存 **87 个 `.md`**（含本文件，其中 12 份在 `archive/`）；判据是 `find docs -name '*.md' | wc -l`，不是记忆。
> （2026-10-30 第 31 次订正：**90 → 87**。删 3 份零引用孤儿（`PRE_PURCHASE_PRECHECK_PLAN` / `SCHEMA_SIMPLIFICATION_REVIEW_2026-10-19` / `UI_REVIEW_PURCHASE_2026-10-17`，删前把独有结论搬进 `notes/2026-10-30-db-schema-and-migration.md` §24、`notes/2026-10-30-smoke-and-guard-discipline.md` §19、`notes/2026-10-30-order-classify-panel.md` §65）；11 份「状态已完结」移入 `docs/archive/`（`plans/` 7 · `reviews/` 2 · `baseline/` 1 · `requirements/` 1），在办文档 75 份。归档件不再被 `check-doc-links.mjs` 扫描，引用按「指路型可改指 / 事实型不改指」处理。**当场改。**）
> （2026-10-30 第 30 次订正：**198 → 90**。`notes/` 的 145 篇按天笔记按主题蒸馏合并为 **33 篇**（另 4 篇独立主题原样保留），净减 108 篇 —— 每篇新笔记文末附「合并清单」给出归属，原文可 `git show b5df35c:docs/notes/<原名>` 取回。索引同时按 A–H 主题分组重排。**当场改。**）
> （2026-10-30 第 29 次订正：计数仍 **198**，R0 落地——拆行器按"块数=段数"拆、每行只带自己那一段；订单行幂等键扩到 `(订单号,图片,色,码,件数)`；清库脚本修普通 FTS5 的 `delete-all` 回滚。门禁见方案 §10.1。**当场改。**）
> （2026-10-30 第 28 次订正：计数仍 **198**，D1–D18 与 Q6 全部确认，方案新增 **§10 R0/R1 施工清单**（文件级改动、迁移方式、冒烟命令、5 个变异点）。**当场改。**）
> （2026-10-30 第 27 次订正：计数仍 **198**，拆解清单的 D2–D4 已确认（`Color` 原文入唯一键 / 改 `pl_shop_sku` / `spec` 退役），D1–D8、D11 全部落定。**当场改。**）
> （2026-10-30 第 26 次订正：计数仍 **198**，拆解清单补入第二轮确认：统一图片表 `md_images` / 颜色·尺码主数据 / D14–D18 / R0–R6。**当场改。**）
> （2026-10-30 第 25 次订正：**197 → 198**，新增 `plans/FEATURE_DECOMPOSITION_2026-10-30.md`（发货台/产品管理逐项拆解与 D1–D18 待确认清单）。**当场改。**）
> （2026-10-30 第 24 次订正：**196 → 197**，新增 `plans/PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md`。**当场改。**）
> （2026-10-30 第 23 次订正：**186 → 196**。本轮新增 `reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md`；
> 入库前当场实测为 **195**（第 22 次记 186 后又有 9 篇入库未计入），加本审查稿后 196。**当场改。**）
> （2026-10-27 第 22 次订正：**178 → 186**。本轮新增 `archive/reviews/LEDGER_REVIEW_2026-10-27.md` 与
> `archive/plans/LEDGER_FIX_PLAN_2026-10-27.md`；另有 6 篇（10-26 起入库）此前未计入。**当场改。**）
> （2026-10-25 第 21 次订正：**175 → 178**。本轮新增 `notes/2026-10-30-ledger-core-fixes.md`（原 `2026-10-25-ledger-p1-ui.md`，2026-10-30 蒸馏时并入）；
> 另有 2 篇同期（10-25）笔记此前未计入 —— 并行改动仍在产笔记，**计数以当场实测为准**。**当场改。**）
> （2026-10-25 第 20 次订正：**172 → 175**。本轮新增 `notes/2026-10-30-ledger-core-fixes.md`（原 `2026-10-25-ledger-p0-formula-fixes.md`，2026-10-30 蒸馏时并入）；
> 另有 2 篇同期笔记此前未计入。**当场改。**）
> （2026-10-25 第 19 次订正：**152 → 172**。本轮新增 `plans/LEDGER_PLAN.md`；同时实测发现
> 上一次计数已落后 19 篇（10-22 之后入库的笔记/方案均未计入）。**当场改。**）
> （2026-10-22 第 18 次订正：**150 → 152**。本轮加 `decisions/ADR-003-shop-account-physical-merge.md` 与 `notes/2026-10-30-shop-account-merge-and-status.md`（原 `2026-10-22-shop-account-physical-merge.md`，2026-10-30 蒸馏时并入）。**当场改**。）
> （2026-10-22 第 17 次订正：**145 → 150**。本轮实测 149（第 16 次记 145 后又有 4 篇入库未计入），加 `archive/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md` 后 150。**当场改**。）
> （2026-10-21 第 16 次订正：**144 → 145**。本轮新增 `notes/2026-10-30-data-model-and-dependencies.md`（原 `2026-10-21-parcel-model-b2.md`，2026-10-30 蒸馏时并入）（阶段 B2 包裹）。
> **当场改**。上一轮（同日第 15 次）131 → 144。）
> （2026-10-21 第 15 次订正：**131 → 144**。上一轮（10-19）之后停更，本轮实测 144（含本轮新增 `notes/2026-10-30-order-table-and-model.md`（原 `2026-10-21-order-purchase-model-simplify.md`，2026-10-30 蒸馏时并入） 与 `archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` 两篇 + 期间新增的笔记）。**当场改**。）
> （2026-10-19 第 14 次订正：**100 → 131**。上一轮（10-13）之后停更，本轮实测 130、加 `plans/ORDER_ATTRIBUTION_WEIGHT_PLAN.md` 后 131。**当场改**。）
> （2026-10-13 第 13 次订正：**97 → 100**。上一轮（10-12）之后又停更：实测 99（含本轮两篇 `notes/2026-10-13-*`），加本复核稿后 100。**当场改**。）
> （2026-10-12 第 12 次订正：**70 → 97**。上一轮（10-09）之后计数又停更，本轮实测 96、加本审查稿后 97 —— 中间新增的笔记/方案均未计入。漂移量本身就是提醒：**计数必须当场改**。）
> （2026-10-08 第 10 次订正：**68 → 69**，本轮加 `notes/2026-10-30-goods-ux-refactor.md`（原 `2026-10-08-goods-ux-refactor-closing-batch.md`，2026-10-30 蒸馏时并入）。**当场改**。）
> （2026-10-08 第 9 次订正：**67 → 68**，本轮加 `notes/2026-10-30-goods-ux-refactor.md`（原 `2026-10-08-goods-ux-refactor-r0-r3.md`，2026-10-30 蒸馏时并入）。**当场改**。）
> （2026-10-08 第 8 次订正：**66 → 67**，本轮加 `plans/GOODS_UX_REFACTOR_PLAN.md`。**当场改**。）
> （2026-10-08 第 7 次订正：**65 → 66**，本轮加 `reviews/UX_GOODS_NOVICE_2026-10-08.md`。**当场改**。）
> （2026-10-08 第 6 次订正：**64 → 65**，本轮加 `plans/GOODS_WORKBENCH_PLAN.md`。**当场改**。）
> （2026-09-30 第 4 次订正：27 → 32 → 34 → 38 → 40 → 41；本轮加 `docs/notes/2026-10-30-island-publish-and-retire.md`（原 `2026-09-30-island-publish-runbook.md`，2026-10-30 蒸馏时并入）。）
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
| **要清理内置插件 / 外置化** | `archive/plans/PLUGIN_TRIAGE_PLAN.md` → `AGENTS.md` §1.8/§1.9 + 红线 23 → `baseline/PROJECT_BASELINE.md` §4 |
| **要梳理业务数据 / 把各功能串起来** | `plans/DOMAIN_INTEGRATION_PLAN.md`（§1 盘点 → §2 断裂诊断 → §3 方案 → §4 阶段）→ `decisions/ADR-002-master-data-layer.md` → `features/PRODUCT_LIBRARY.md` |
| **要数据分层 / 定写入权（主数据）** | `decisions/ADR-002-master-data-layer.md`（谁是 owner、哪些能共享、哪些只能读）→ `plans/DOMAIN_INTEGRATION_PLAN.md` §3 |
| **要改物流运费（运价换版 / 计价口径）** | `notes/2026-10-30-shipping-desk-and-rate.md`（2026-10-15 回收为内建「基础数据 › 物流运费」：当前实现的入口与口径说明）→ `src/core/services/shipRateOps.ts`（**六 op 的唯一实现**：解析委托 `importSheet`、计价走 `@/lib/shipRateQuote`）→ `tests/shipRate.spec.ts`（改口径必同步的断言）→ `scripts/shipping-rate-ui-smoke.mjs`（接线断言）。⚠️ 原计划的 `ui-plugins/shipping-rate/README.md` 随该岛 2026-10-15 下架，历史换版流程留档在 `archive/plans/SHIPPING_RATE_ISLAND_PLAN.md` |
| **要评估体验 / 改界面与文案** | `reviews/UX_REVIEW_2026-09-30-R2.md`（**最新**：§0 结论 + §2 问题清单 + §3 上一轮复核）→ `reviews/UX_REVIEW_2026-09-30.md`（第一轮，看历史）→ `plans/UX_POLISH_PLAN.md`（逐条复核 + 执行顺序 + 待拍板）→ `plans/DOMAIN_INTEGRATION_PLAN.md`（数据侧同一批断点） |
| **要做付费授权 / 加付费墙** | `plans/PAID_LICENSE_PLAN.md`（§1 三条工程事实 → §4 定案设计 → §5 改动清单）→ `notes/2026-10-30-electron-and-platform.md` → `AGENTS.md`（§1.1 三层边界 / §1.8 域与权限门）→ `architecture/PLUGIN_ARCHITECTURE.md` §9 |
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
│   ├── ADR-002-master-data-layer.md
│   └── ADR-003-shop-account-physical-merge.md
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
