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
- 品牌标识「插槽 S」全量接入（2026-11-06）：`brand/` 矢量资产与规范页；`scripts/gen-icon.js` 改为
  从 SVG 渲染（`npm run icons` 可复现、逐产物字节一致），替换 `build/` 全部位图；侧栏与「设置 › 关于」
  经 `src/core/components/AppLogo.vue` 单一引用点接入，补 `index.html` favicon；
  兄弟仓库 `SellerKitExtensions` 三个 MV3 扩展补 16/32/48/128 图标并升 patch 版本

## 关键决定

- **2026-11-06**：`docs/` 与 `CHANGELOG.md` 不再入库，跨设备上下文只靠本文件 + AGENTS.md；
  代码注释里的 `docs/**`、`CHANGELOG.md` 引用是本机路径，克隆后悬空属已知（`scripts/check-doc-links.mjs` 已适配）。
- **2026-11-06 品牌标识**：界面用**固定色应用图标**（与 Dock / 安装包同一张脸），不新增
  `--wb-logo-signal`、不改 `WB_THEME_TOKENS` 白名单；`logo-mark.svg` 只留给将来真正需要主题化的内联场景。
  应用图标固定不随主题反相，只有托盘模板图按系统深浅自动反相。
- **2026-11-06 托盘**：macOS `setTemplateImage(true)` 只按 alpha 渲染，彩色图标的实心底板会变成
  纯色方块、S 消失；必须用 `brand/logo-tray-template.svg` 生成的透明底单色模板图（darwin 分支不
  `resize`，否则把 @2x 多表示压平）。断口 20 单位才能在 18px 剪影里留出可见间隙（12 单位会被
  圆头端点填满）。
- **2026-11-06 扩展分发**：Chrome 以版本号为唯一更新信号，同版本换图标等于没发；三个扩展已升
  patch（`mango-order` 1.1.3 / `mango-probe` 0.1.2 / `ae-profit` 0.5.1）。扩展仓库打包脚本目前
  **允许同版本覆盖 zip**，发布口应加「同版本内容摘要不同即 exit 1」守卫（判据取逐条目
  path+content 摘要，不能比 zip 自身哈希——时间戳会让每次都不同）。
- 模块形态现状：内建模块（`src/modules/`）= today / shop-accounts / mail / order-cost / ledger / quick-note；
  活跃市场 UI 岛（`ui-plugins/`）仅 `excel-copy`、`ae-profit`；
  product-library / order-insight / shop-accounts 岛 / shipping-rate 岛均已回收为内建。
- `默认模板.txt` 是打包资源（`electron-builder.yml` extraResources），必须入库。
- 门禁全部本地手动执行，无 CI（最大流程缺口）。

## 下一步候选

- **安装包重打包（待本机执行）**：`npm run dist:mac` 两次都在 electron-builder 写 `app.asar` 时被
  WorkBuddy 的 `node-brokered-fs-shim` 拦下（`Brokered file token refused`），加沙箱外执行同样失败，
  属环境限制、非代码问题；`npm run build` 部分成功、全部门禁绿。`release/` 里仍是 9-04 的旧安装包，
  需在本机终端跑 `npm run dist:mac` 生成 1.1.0 并**重装**才能看到新 Dock / 桌面图标（macOS 可能还要
  清图标缓存）；Chrome 扩展需指向新版本解压目录或刷新。
- 组合标字标**尚未转曲**，对外印刷 / 商店素材前需处理。
- 施工总纲 T1–T5 逐项落地（见「进行中」）
- 持续缺口：组件 / Pinia store / 主进程业务逻辑 / 插件沙箱无自动化测试覆盖，改动需手动回归
