# 订单采集（UI 岛）

速卖通订单**采集接收端**：Chrome 扩展（SellerKitExtensions）在卖家后台一键采集，或按本页给出的
curl 样例手动推送 —— 订单进宿主**订单主干** `oi_orders`（与 Excel 导入的订单同一张表，只差 `source` 字段）。

> **1.1.0 收编（2026-09-30）**：原「利润统计 / 订单明细 / 成本与汇率」三个页签已并入宿主
> **「算钱」**页（趋势、明细、成本表与汇率维护都在那里，读同一份主干数据）。本岛只留接收端状态与接入方式
> —— 「同一件事只有一个入口」是这套信息架构的铁律，两边各摆一份会让同一个数看起来像两套。

## 形态

`kind: "ui"` —— 纯静态站点（Vue 3 + Tailwind，构建产物 `dist/`），在宿主 `sk-plugin://` iframe 中运行。
数据一律经宿主 `db` 能力域写入（`sk.host.db.call('ae', op, payload)`），岛内不直连 `window.electronAPI`。

## 开发

```bash
npm run dev      # 纯浏览器预览（无桥，调用返回“未连接宿主桥”）
npm run build    # 产出 dist/index.html + assets/*
```

宿主侧联调：构建后用「插件市场 → 本地安装 zip」或直接把本目录拷到 `<userData>/plugins/ae-profit/`。
⚠️ **装完要重启宿主**：启动会预载「上次所在的岛」，其 iframe 持有旧产物。

## 源码约定

- `src/api.js`：宿主服务适配层（`window.__sk` → 与内建插件同名的服务函数），
  `vite.config.mjs` 通过 alias 将 `@/core/services/{ipc,clipboard,toast}` 指向它。
- `src/types.js`：类型导入桩（TS `import type` 构建期擦除，仅保证可解析）。
- 主题色一律用宿主注入的 `--wb-*` 令牌，回退值见 `src/style.css`。

## 能力声明（manifest.json）

| 能力 | 域 / 动作 |
| --- | --- |
| `clipboard` | `write` / `writeText`（复制 curl 样例） |
| `db` | 域 `ae`：`ensure` / `receiverStatus` |

新增域或操作必须同步：① `manifest.json` capabilities ② 宿主 `src/core/plugin/host.ts` 的 `DB_OPS` 白名单。
**删 op 同样要同步**：`tests/pluginTriage.spec.ts` 双向守卫 —— 声明了不调用、或调用了没声明，都会红。

## 发布

```bash
cd /path/to/SellerKit
node scripts/publish-plugin.js --dir ui-plugins/ae-profit --build \
  --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main
```

产物写入 `market-out/`（`ae-profit-<version>.zip` + `catalog.json`），提交推送后即上架。
**改内容必须升 `manifest.json` 的 `version`**（版本号是客户端唯一的更新判据；发布口会拦"同版本换内容"）。

> 注意：`ae-profit` 已从宿主 `modules.config.json` 的默认打包预设中移除。
> 内建视图插件与 UI 岛同名时内建优先（`pluginManager.registerUiIsland` 遇同名记录直接跳过），
> 因此**不要**把它加回 `standard` / `pro`，否则市场安装的版本不会生效。