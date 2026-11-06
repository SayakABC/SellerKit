# AI 工作进度（跨设备共享）

> 多人多设备开发的滚动台账。**收工前必须更新本文件**（契约见 [AGENTS.md](AGENTS.md) §0）：
> 只记"下一位接手需要知道的"，旧的完成项及时裁掉。深度笔记 / 计划 / 完整变更史在开发者本机的
> `docs/` 与 `CHANGELOG.md`（不入库），本文件只留摘要。

最后更新：2026-11-06

## 进行中

- **芒果采集 + POD 图案流水线**（2026-11-01 施工总纲，本机 `docs/plans/MANGO_INGEST_AND_POD_PLAN.md`）：
  T1–T5 待开工，落点为待新建的 `electron/mango-ingest.ts`、`src/lib/mangoStatus.ts`、
  `electron/podImageKey.ts`、`electron/pod-db.ts`、`electron/scheduler.ts` 及配套冒烟脚本。
  注意：订单自动同步的「Electron 内嵌隐藏窗口」路线已作废（登录态依赖用户 Chrome），采集统一走
  [SellerKitExtensions](https://github.com/SayakABC/SellerKitExtensions) 扩展推送。

## 最近完成（2026-11 上旬）

- `order-cost` 统计页 P0 口径门禁：默认全部、双轨并列、截断可见
- `mango` 已发货回执：v14 物流列、回执专道与「收已发货回执」入口
- `today` 订单维度状态跟踪：总览/待发货合并为「订单」、去步号、跨页焦点
- 仓库文档分层调整（2026-11-06）：`docs/`、`CHANGELOG.md` 转本机文档；README / CONTRIBUTING 重写

## 关键决定

- **2026-11-06**：`docs/` 与 `CHANGELOG.md` 不再入库，跨设备上下文只靠本文件 + AGENTS.md；
  代码注释里的 `docs/**`、`CHANGELOG.md` 引用是本机路径，克隆后悬空属已知（`scripts/check-doc-links.mjs` 已适配）。
- 模块形态现状：内建模块（`src/modules/`）= today / shop-accounts / mail / order-cost / ledger / quick-note；
  活跃市场 UI 岛（`ui-plugins/`）仅 `excel-copy`、`ae-profit`；
  product-library / order-insight / shop-accounts 岛 / shipping-rate 岛均已回收为内建。
- `默认模板.txt` 是打包资源（`electron-builder.yml` extraResources），必须入库。
- 门禁全部本地手动执行，无 CI（最大流程缺口）。

## 下一步候选

- 施工总纲 T1–T5 逐项落地（见「进行中」）
- 持续缺口：组件 / Pinia store / 主进程业务逻辑 / 插件沙箱无自动化测试覆盖，改动需手动回归
