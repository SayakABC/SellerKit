# 利润追踪（UI 岛）

速卖通订单利润追踪：**订单明细** + **利润引擎**（趋势 / 分类 / 爆品）+ **成本衔接**（拿货对账快照导入）+ **汇率维护**。

## 形态

`kind: "ui"` —— 纯静态站点（Vue 3 + Tailwind，构建产物 `dist/`），在宿主 `sk-plugin://` iframe 中运行。
数据一律经宿主 `db` 能力域读写（`sk.host.db.call('ae', op, payload)`），岛内不直连 `window.electronAPI`。

## 开发

```bash
npm run dev      # 纯浏览器预览（无桥，调用返回“未连接宿主桥”）
npm run build    # 产出 dist/index.html + assets/*
```

宿主侧联调：构建后用「插件市场 → 本地安装 zip」或直接把本目录拷到 `<userData>/plugins/ae-profit/`。

## 源码约定

- `src/api.js`：宿主服务适配层（`window.__sk` → 与内建插件同名的服务函数），
  `vite.config.mjs` 通过 alias 将 `@/core/services/{ipc,clipboard,toast}` 指向它，
  因此 `AeProfitView.vue` 与 `components/*.vue` 与内建版本保持一致、零改动复用。
- `src/types.js`：类型导入桩（TS `import type` 构建期擦除，仅保证可解析）。
- 主题色一律用宿主注入的 `--wb-*` 令牌，回退值见 `src/style.css`。

## 能力声明（manifest.json）

| 能力 | 域 / 动作 |
| --- | --- |
| `storage` | 命名空间 `ae-profit` |
| `clipboard` | `write` |
| `db` | 域 `ae`（ensure / receiverStatus / orderList / summary / profitStats / costMapList / costMapImport / rateList / rateUpsert）、域 `purchase`（costSnapshot） |

新增域或操作必须同步：① `manifest.json` capabilities ② 宿主 `src/core/plugin/host.ts` 的 `DB_OPS` 白名单。

## 发布

```bash
cd /path/to/SellerKit
node scripts/publish-plugin.js --dir ui-plugins/ae-profit --build \
  --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main
```

产物写入 `market-out/`（`ae-profit-1.0.0.zip` + `catalog.json`），提交推送后即上架。

> 注意：`ae-profit` 已从宿主 `modules.config.json` 的默认打包预设中移除。
> 内建视图插件与 UI 岛同名时内建优先（`pluginManager.registerUiIsland` 遇同名记录直接跳过），
> 因此**不要**把它加回 `standard` / `pro`，否则市场安装的版本不会生效。
