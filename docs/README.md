# 文档中心

SellerKit 项目文档索引。**先看这里的表格找文档，再打开具体文件**——不要凭记忆猜文件名，2026-09-16 起文档已按分类归入 `docs/` 子目录。

> 项目入口（安装 / 构建 / 目录结构 / 架构要点）见根目录 [`README.md`](../README.md)。
> 代码改动规则（架构基线 + 23 条红线）见根目录 [`AGENTS.md`](../AGENTS.md)。

---

## 文档地图

| 文档 | 主旨 | 读者 | 状态 | 最后更新 |
|---|---|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **架构基线 + 编码红线**（三层边界 / 模块化 / 插件体系 / 命名 / 异常 / 红线 1–23） | 开发者、AI 助手 | ✅ 活跃（唯一规则源） | 2026-09-16 |
| [`baseline/PROJECT_BASELINE.md`](baseline/PROJECT_BASELINE.md) | **项目基线快照**：结构、规模、模块/插件注册表、IPC 契约、持久化、依赖、质量门禁现状 | 开发者、新人 | ✅ 活跃（随版本刷新） | 2026-09-16 |
| [`baseline/REFACTOR_PLAN.md`](baseline/REFACTOR_PLAN.md) | Phase 0–3 单体 → 模块化重构计划 | 架构/开发者 | 🗄️ 已完成归档 | 2026-08-21 |
| [`architecture/PLUGIN_ARCHITECTURE.md`](architecture/PLUGIN_ARCHITECTURE.md) | 插件化方向性架构：Phase 1–5、Worker 沙箱、权限门、UI 岛方案 | 架构/开发者 | ✅ 活跃（方向性，规则以 AGENTS.md 为准） | 2026-09-08 |
| [`architecture/PLUGIN_DEVELOPMENT.md`](architecture/PLUGIN_DEVELOPMENT.md) | 外置插件与 UI 岛开发、调试、发布操作手册 | 插件作者 | ✅ 活跃 | 2026-09-15 |
| [`features/MAIL_INBOX.md`](features/MAIL_INBOX.md) | 集中收件箱 M1–M3 设计与落地（IMAP / FTS / 附件缓存） | 开发者 | ✅ 活跃 | 2026-09-15 |
| [`features/PROFIT_TRACKER.md`](features/PROFIT_TRACKER.md) | 速卖通利润追踪三端方案与落地路线（**跨端协议唯一权威来源**） | 架构/开发者 | ✅ 活跃（含 2026-09-16 漂移提示） | 2026-09-15 |
| [`guides/USER_GUIDE.md`](guides/USER_GUIDE.md) | 用户使用指南（安装 / 界面 / 导入 / 复制 / 模板 / 字段规则 / 打包） | 最终用户 | 🟡 活跃但覆盖面偏旧（未含收件箱 / 店铺账号 / 自动更新） | 2026-06-20 |
| [`requirements/Requirements.md`](requirements/Requirements.md) | 最初立项需求规格 | 历史追溯 | 🗄️ 历史档案（功能已全部实现） | 2026-06-02 |
| [`reviews/CODE_REVIEW_REPORT.md`](reviews/CODE_REVIEW_REPORT.md) | 代码与文档审查报告（31 项发现、风险分级、取证命令） | 开发者 | ✅ 活跃 | 2026-09-16 |
| [`plans/REMEDIATION_PLAN.md`](plans/REMEDIATION_PLAN.md) | **整改计划**：26 个任务分 4 个阶段，含验收标准 / 风险回滚 / 进度跟踪表 | 开发者 | ✅ 活跃（待执行） | 2026-09-16 |
| [`plans/PLUGIN_TRIAGE_PLAN.md`](plans/PLUGIN_TRIAGE_PLAN.md) | **内置插件盘点与处置**：3 个内置插件 + 2 个脚手架 + 4 个 UI 岛的逐项判定、`order-insight` ID 冲突取证、外置化步骤与验收 | 架构/开发者 | ✅ 活跃（待评审，未执行） | 2026-09-21 |
| [`archive/manual.md`](archive/manual.md) | 早期简版用户手册 | 历史追溯 | 🗄️ 已归档（被 `guides/USER_GUIDE.md` 取代） | 2026-06-03 |

状态图例：✅ 活跃 · 🟡 活跃但有已知缺口 · ⚠️ 已过期 · 🗄️ 已归档（仅历史对照）

---

## 推荐阅读路径

| 你是谁 / 要做什么 | 按顺序读 |
|---|---|
| **第一次接手项目** | 根 `README.md` → `baseline/PROJECT_BASELINE.md` → `AGENTS.md` → `architecture/PLUGIN_ARCHITECTURE.md` |
| **要改代码 / 加功能** | `AGENTS.md`（§1 架构基线、§3 红线、§5 SOP）→ `baseline/PROJECT_BASELINE.md`（§3 契约现状） |
| **要写插件** | `architecture/PLUGIN_DEVELOPMENT.md` → `architecture/PLUGIN_ARCHITECTURE.md`（§1.8 机制）→ `AGENTS.md` 红线 16–23 |
| **要排查性能 / 找风险** | `reviews/CODE_REVIEW_REPORT.md` → `baseline/PROJECT_BASELINE.md` |
| **要执行整改** | `plans/REMEDIATION_PLAN.md`（先读 §1 原则与 §2 依赖关系，再按 Phase 顺序做） |
| **要清理内置插件 / 外置化** | `plans/PLUGIN_TRIAGE_PLAN.md` → `AGENTS.md` §1.8/§1.9 + 红线 23 → `baseline/PROJECT_BASELINE.md` §4 |
| **终端用户** | `guides/USER_GUIDE.md` |

---

## 维护规则

1. **规则只有一份**：架构约束与编码红线的唯一权威是根目录 `AGENTS.md`。其他文档写「为什么」和「怎么做」，不复制规则原文（`PLUGIN_ARCHITECTURE.md` 已确立"避免双头文档漂移"原则）。
2. **状态标注必填**：新增或迁移文档，须在头部标注状态（活跃 / 已过期 / 已归档），并写清被谁取代。归档文档不删除、只标注，保留演进可追溯性。
3. **事实以代码为准**：文档描述与 `src/` `electron/` 实际实现冲突时，先按代码修正文档；改动架构时同步回写 `AGENTS.md` 与 `baseline/PROJECT_BASELINE.md`。
4. **基线刷新时机**：`package.json` 版本号变更、新增模块/插件、新增 IPC 通道域、依赖大版本升级后，刷新 `baseline/PROJECT_BASELINE.md`。
5. **交叉引用用仓库根相对路径**（如 `docs/features/PROFIT_TRACKER.md`），不用裸文件名。

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
│   └── PLUGIN_DEVELOPMENT.md      # 插件开发手册
├── features/                      # 业务方案
│   ├── MAIL_INBOX.md
│   └── PROFIT_TRACKER.md
├── guides/                        # 用户文档
│   └── USER_GUIDE.md
├── requirements/                  # 需求档案
│   └── Requirements.md
├── reviews/                       # 审查报告
│   └── CODE_REVIEW_REPORT.md
├── plans/                         # 整改计划
│   ├── REMEDIATION_PLAN.md
│   └── PLUGIN_TRIAGE_PLAN.md
└── archive/                       # 归档
    └── manual.md
```
