# 订单归类（UI 岛插件）

把「订单归类」从随宿主编译的 view 插件迁移为市场可分发的 **UI 岛（kind: ui）** 插件：纯静态站 + `window.__sk` 宿主桥，零 npm 依赖、不打包 `xlsx`、不持有 AI 密钥。

## 功能

| 页签 | 能力 |
|------|------|
| 导入与识别 | 选择 Excel（宿主解析）→ 列映射（主图/订单号/店铺/尺码/时间）→ 多产品行展开 → 入队 → 批量视觉识别 → 断点续跑 → 缺图补链接 |
| 透视统计 | 按品类/颜色/尺码/店铺/Logo 聚合；2 维度自动转款色矩阵；导出 Excel |
| 订单明细 | 搜索/核对状态/发货状态筛选、分页、缩略图、发货状态切换、删除、导出 |
| 数据纠正 | 待核对订单改品类/颜色/Logo/**款编码（手工指派）**并自动重挂款式（reclassify），逐条或全部确认 |
| 产品库 | 款式改名/删除、Excel 批量导入（含指纹列）、导出 |
| 拿货对账 | 供应商 / 拿货单（**查看·编辑，含「取最近价」单价记忆**）/ 付款记录 / 对账（**厂商 · 店铺分摊双视图 + 时间窗**）/ 待拿货缺口（含忽略与**取消忽略**） |
| 识别设置 | provider / baseUrl / model / temperature；API Key 只写不读；孤儿图片清理、订单数据清空 |

## 从内建版升级（1.1.0 起）

本插件自 1.1.0 起是「订单归类」的**唯一实现**。宿主 `modules.config.json` 的 `standard` / `pro` 预设已不再登记同名内建视图包 —— 内建记录会占用 id，`registerUiIsland()` 见 id 已存在即静默跳过，结果是岛装上了、市场显示"已安装"，却永远没有侧栏入口（AGENTS 红线 23）。宿主侧 `electron/order-db.ts` 与 db 能力域 `order-insight` / `purchase` 原样保留，**数据零迁移**。

**配置自动继承**：岛与内建版共用同一命名空间 `modules.order-insight`（岛的 `bridge.js#store` 走 `host.storage`，内建走 `useModuleStorage`），键名也刻意对齐：

| 键 | 含义 | 岛内入口 |
|---|---|---|
| `engine` | provider / baseUrl / model / temperature | 识别设置 → 视觉识别引擎 |
| `imageColumn` / `orderNoColumn` / `shopColumn` / `sizeColumn` / `orderTimeColumn` | 列映射 | 识别设置 → 列映射，或导入页每次覆盖 |
| `groupDimensions` | 透视统计维度 | 透视统计 → 统计维度勾选 |

导入时**优先采用已保存的列映射**（列名不在当前表头才回落到自动探测）；透视页同样继承上次维度。写回是合并语义，不会抹掉其它字段。

### `ready()` 语义（勿回退）

`__sk.ready` 本身是 boot 后 resolve 的 Promise。旧写法 `if (sk.ready) return true` 判断的是"Promise 对象存在"（恒真）→ **从不等待**，调用会在握手前发出而全部失败。1.1.0 起真正 `await` 它并加超时兜底。

### 1.2.0 补齐内建版剩余能力（与内建逐项对齐）

| 宿主 op | 岛内入口 | 说明 |
|---|---|---|
| `purchase.orderGet` / `orderUpdate` | 拿货单 → 「查看 / 编辑」 | 自管 DOM 的模态（`util.modal()` 是静态 HTML，加行后无法重绘）；岛内实时算合计，落库时由宿主按同一公式复核。已提交单也可改，会立即影响对账与缺口 |
| `purchase.priceHistory` | 编辑器内「取最近价」/ 填完款色自动回填 | 口径 = 同厂商同款色最近一次拿货价，未命中回落全局最近一次。仅在单价为空时自动填，不覆盖手输 |
| `purchase.ignoreRemove` | 待拿货缺口 → 「已忽略」表 → 取消忽略 | 忽略按「款编码 + 款色」整组生效，取消后该款色全部尺码回到缺口 |
| `purchase.shopAllocation` / `shopAllocationDetail` | 对账 → 「店铺」视图 → 展开明细 | 拿货成本按拿货单锁定的**来源订单**拆分到店铺；未锁定来源的拿货单不参与归属 |
| `oi.styleAssign` | 数据纠正 → 「款编码」下拉 | 仅当显式指定了**另一个**款才调用：把订单图片挂到目标款 + 指纹记入该款，后续同款自动识别即命中该款编码 |

时间窗筛选（全部 / 今天 / 本月 / 本年 / 自定义）同时作用于厂商与店铺两个视图，语义与内建 `reconRange` 一致。

**两个必须同时修掉的静默失效**（都不是"缺按钮"，而是调用参数不对导致操作无声无息）：

1. 数据纠正页的 `oi('update')` 原先**没带 `fingerprint` / `features`**。宿主重归类的分支条件是 `input.reclassify && input.fingerprint` —— 只传 `reclassify: true` 是**纯空操作**，界面提示"已重新归类"但款式根本没动。修复后按 `list` op 返回的 `fingerprint` / `features` 原样回传。
2. 对账表原先读 `payableCents` / `name` 等**宿主并不存在的字段**（真实字段是 `purchaseCents` / `paidCents` / `refundCents` / `balanceCents`），表格恒显示 0 / 空。字段名以 `src/types.ts#ReconciliationRow` 为准。

> 教训：这类"字段名/参数名写错"不会抛错，只会安静地给出错数据。新增 op 接线时应回 `src/types.ts` 与 `electron/*-handlers.ts` 对一遍字段，勿凭记忆。

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

岛内脚本为原生 ES Module，**无构建步骤**（`dist/` 即源码，改完直接发布）。

```bash
# 1) 语法自检（.js 是 ESM，需按 module 解析）
for f in dist/*.js dist/views/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done

# 2) 静态渲染自检（脱离宿主时桥不可用 → 顶栏显示「未连接宿主」）
cd ui-plugins/order-insight/dist && python3 -m http.server 5173
```

真机联调需把插件装进宿主的 UI 岛目录后从插件中心打开。

**两个自检陷阱**（都踩过）：① 不要用 `file://` 打开 —— ESM 动态导入会被 CORS 拦，页面**根本不会挂载**（症状是首个断言超时、结果数组为空，极易误判成选择器写错），必须走本地 HTTP；② 桥的 boot 是**异步握手**，断言要等 `#conn` 变为「已连接宿主」再开始，否则会在握手前发起调用。

## 出包

```bash
node scripts/publish-plugin.js --dir ui-plugins/order-insight \
  --base http://127.0.0.1:8000 --out market-out --catalog market-out/catalog.json
```

产物：`market-out/order-insight-<version>.zip` + 更新 `market-out/catalog.json`。远端市场仓库的推送需人工确认。
