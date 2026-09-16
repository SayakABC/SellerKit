# 订单归类（UI 岛插件）

把「订单归类」从随宿主编译的 view 插件迁移为市场可分发的 **UI 岛（kind: ui）** 插件：纯静态站 + `window.__sk` 宿主桥，零 npm 依赖、不打包 `xlsx`、不持有 AI 密钥。

## 功能

| 页签 | 能力 |
|------|------|
| 导入与识别 | 选择 Excel（宿主解析）→ 列映射（主图/订单号/店铺/尺码/时间）→ 多产品行展开 → 入队 → 批量视觉识别 → 断点续跑 → 缺图补链接 |
| 透视统计 | 按品类/颜色/尺码/店铺/Logo 聚合；2 维度自动转款色矩阵；导出 Excel |
| 订单明细 | 搜索/核对状态/发货状态筛选、分页、缩略图、发货状态切换、删除、导出 |
| 数据纠正 | 待核对订单改品类/颜色/Logo 并自动重挂款式（reclassify），逐条或全部确认 |
| 产品库 | 款式改名/删除、Excel 批量导入（含指纹列）、导出 |
| 拿货对账 | 供应商 / 拿货单 / 付款记录 / 供应商对账 / 待拿货缺口（含忽略） |
| 识别设置 | provider / baseUrl / model / temperature；API Key 只写不读；孤儿图片清理、订单数据清空 |

## 与宿主的边界

- **数据库**：全部走 `db` 能力域的语义化 op，两个业务域
  - `order-insight`：图片指纹库、订单表、识别队列、款式库
  - `purchase`：供应商、拿货单、付款、对账、待拿货缺口
- **文件**：Excel 读取（`parseExcel`）与写出（`exportWorkbook`）都在宿主完成，岛侧只传/收 JSON（避免把 xlsx 打进静态站）
- **AI 密钥**：`setApiKey` 单向写入宿主机密存储；识别时由宿主取 Key 调 `analyze`，岛内永远拿不到 Key
- **图片**：下载/缓存/缩略图由宿主完成（`downloadImage` / `readImage` / `imageThumbBatch`），岛内只拿 dataURL 展示
- **文件选择**：`dialog.openFile('excel')`，仅宿主允许的类型

## 目录

```
manifest.json     # kind: ui + capabilities（db 两域 / dialog / clipboard / storage）
dist/
  index.html      # 入口（加载 main.js）
  styles.css      # 依赖宿主注入的 --wb-* 主题令牌
  bridge.js       # window.__sk 封装（db / prefs / notify / openFile）
  api.js          # 业务 API（oi / purchase / 引擎配置 / analyze）
  app.js          # 视图注册与外壳（标签导航、重绘、事件代理）
  store.js        # 轻量状态容器
  lib.js          # 归类纯函数（归一化/指纹/展示名/列探测）
  splitter.js     # 多产品行拆分
  util.js         # 转义/格式化/确认框等通用工具
  views/          # 各页签视图
```

## 开发/自测

岛内脚本为原生 ES Module，无构建步骤：

```bash
cd ui-plugins/order-insight/dist && python3 -m http.server 5173
```

脱离宿主时桥不可用（`未连接宿主`），可用于检查静态渲染；真机联调需把插件装进宿主的 UI 岛目录后从插件中心打开。

## 出包

```bash
node scripts/publish-plugin.js ui-plugins/order-insight
```

产物落在 `market-out/order-insight/`（`manifest.json` + `order-insight-<version>.zip` + `.sha256`），并更新 `market-out/catalog.json`。远端市场仓库的推送需人工确认。
