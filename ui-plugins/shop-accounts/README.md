# shop-accounts（UI 岛形态）

「店铺账号管家」的市场分发版本：iframe 运行时岛 + `window.__sk` 桥。

## 唯一实现（内建版已下记）

宿主内建版 `extensions/shop-accounts` 已于 2026-09-16 移除，**本 UI 岛是店铺账号管家的唯一实现**：

- 功能：账号库 / 企业管理（欧代·土代·德国包装法）/ 集中收件箱，全部在岛内；
- 数据：与主进程 `electron/shop-accounts-db.ts`、`company-db.ts` 同一套 SQLite（经 db 能力域，不放行任意 SQL）；
- 宿主侧只保留数据层与 IPC（`shop-account-*` / `company-*` / `mail-*`），不再有同名内建模块。

> ⚠️ **不得把 `shop-accounts` 登记进 `modules.config.json` 的 `profiles`**：内建记录会占用同名 id，
> 导致市场安装的 UI 岛无法注册（表现为"装上了但侧栏没入口、插件市场按钮状态不变"）。见 AGENTS.md 红线 23。

## 能力声明

- `db`（`domains: ["shop-accounts"]`）：宿主登记的白名单业务操作，**不放行任意 SQL**。
- `secrets`（`domains: ["shop-accounts"]`）：仅可查询宿主安全存储可用性。
- `mail`（`domains: ["mail"]`）：只读 IMAP 语义的邮件操作 + 邮箱接入维护（`accountUpsert` / `accountTest` / `accountDelete` / `providers`）。
- `storage` / `clipboard`：UI 偏好持久化与复制。

未声明的能力调用会被宿主权限门拒绝并写入审计环（设置 → 插件）。

## 与宿主的 boot 握手（不可回退的两条纪律）

岛不直接访问 `window.electronAPI`，一切经 `window.__sk`；而 `__sk` 的**可用**以宿主 `boot` 握手为界 —— 主题令牌与业务调用都在 boot 之后才有效。两条纪律改这里时务必守住：

1. **`bridge.js` 的 `ready()` 必须真正等待 boot 完成。** 运行时的 `window.__sk.ready` 是一个 **Promise**（boot 兑现时才 resolve），恒为真值。若像早期那样写成 `if (s.ready) return Promise.resolve(true)`，`ready()` 会立刻返回：`App.vue` / `SettingsView.vue` 的握手门形同虚设，岛在握手前就挂载 —— 首屏用 `style.css` 的浅色回退令牌（与宿主主题不一致），且首个数据调用挂在 boot 上，界面**永久停在「加载中」**。判定"已握手"的可靠信号是 `__sk.manifest.id`（仅在 boot 后写入），不是 `host` 对象是否存在（boot 前就存在）。
2. **iframe 端的 `hello` 必须重试到 boot 落地**，不得设放弃阈值（见 `electron/plugin-ui-runtime.js`）。宿主侧 `message` 监听器的注册时机可能显著晚于 iframe 首帧（冷启动 / 窗口恢复 / HMR 重挂），早期"重试 6 次约 3.75s 后永久停止"会让岛彻底失联且无自愈路径。

主题一致性还依赖**令牌双点覆盖**：宿主 `index.css` 定义的每个 `--wb-*` 都要同时出现在 `uiBridgeHost.ts` 的 `WB_THEME_TOKENS`（注入清单）与岛内 `style.css` 的 `:root`（回退值）。漏任一处，`var()` 解析失败会让**整条声明被丢弃**（不是退化成默认值），且不报任何错。`color-scheme` 另需 `theme.js` 跟随 `--wb-bg` 亮度回写。

## 宿主要求与排障

- **插件更新后必须重启宿主**：主进程 IPC 通道在启动时注册（`electron/company-handlers.ts`）。dev 模式下改过宿主主进程代码也一样要重启。
- **企业管理不可用**：岛内会显示降级面板并说明原因（`db 操作未登记` / `未注册通道` / `权限未授予`），附「重试」按钮；账号库与收件箱不受影响。此时**重启宿主**即可，若仍不可用说明宿主版本早于企业管理功能。
- 市场点安装提示「**已安装 vX，无需重复安装**」= 该版本已成功落盘到 `<userData>/plugins/<id>/`（不是安装失败）。宿主 ≥1.1.1 起这种情形会以「已是最新版」提示呈现。
- 复制报「**动作越权: clipboard.write 不在声明白名单**」= manifest 的 `clipboard.actions` 少写了 `write`。宿主权限门对 `host.clipboard.writeText` 判定的动作名是 `write`（不是 `writeText`），声明必须含它；1.2.1 起写作 `["write", "writeText"]`。
- 岛内显示「**等待宿主桥握手超时（8s）**」= `window.__sk` 已注入但没收到宿主 `boot` 握手，不是"没装插件"。点「重试」重新握手即可；若必现，看宿主 console 的 `[ui-island:shop-accounts]` 与桥的握手日志。**注意这个提示本身是 1.4.3 才有的**——1.4.3 之前握手未完成时岛不会显示它，而是直接渲染主视图并**永久停在「加载中」**（因为首个数据调用挂在 boot 上）。
- 岛内**样式与宿主主题不一致**（深色主题下原生控件仍是浅色、抽屉没有投影）= 主题令牌没到位，两类原因：① 握手未完成 → `--wb-*` 未注入，岛用 `style.css` 的浅色回退值；② 令牌本身漏注入（宿主 `index.css` 定义了但 `uiBridgeHost.ts` 的 `WB_THEME_TOKENS` 漏列，或 `style.css` 没写该令牌的回退值）。`--wb-shadow` 曾在 1.4.3 前同时命中两类。判断依据：打开 DevTools 看 `<html>` 的内联 style 里有没有 `--wb-bg`。

## 关联企业（company_id）语义

账号库的「关联企业」是**引用关系**，不是自由文本——新增/编辑（`AccountEditor`）与批量修改（`BatchEditDrawer`）均为**选择企业下拉**，候选取自「企业管理」列表：

| 取值 | 含义 |
|---|---|
| `> 0` | 关联该企业；写入时按 `sk_companies` 取当前企业名同步进 `company` 列（企业改名后下次保存即刷新） |
| `0` | 不关联（清空 `company_id` 与 `company`） |
| `-1` | 仅批量修改 UI 使用：**尚未选择**，不构成 patch、不提交 |

因此批量修改的企业字段**只有覆盖语义、没有追加语义**（企业是外键，追加无意义）；抽屉内复选框未勾选或未选企业时该项不会进入 `patch`。DB 侧 `batchUpdateShopAccounts` 对 `patch.companyId` 做 `coerceCompanyId` 归一，并在同一条 UPDATE 内一并写 `company_id` + `company`，避免二者不一致。

## 两个 db 域的 `list` 返回形状不同（1.5.1 踩过）

| 域 | `list` 返回 | 消费方式 |
|---|---|---|
| `shop-accounts` | **裸数组** `ShopAccountItem[]` | `result.data \|\| []`（`store.ts` 的 `refresh()`） |
| `shop`（店铺登记） | `{ rows, total }` | `result.data?.rows ?? []` |

⚠️ 1.5.0 的「店铺登记」页把两域形状搞混（按 `{rows}` 取 `shop-accounts.list` 的裸数组），
「账号套装」下拉恒为空——**桥、权限、数据全正常**（真机取证 `shop-accounts.list` 能返回全部 14 条），
纯视图层取值 bug，且被「失败不影响主流程」的静默兜底（`?? []`）完全掩盖。新调用点先确认域的返回形状。

## 店铺实体的两套平台词表 + 全量提交陷阱（1.5.2 踩过）

- **平台词表两套，别混**：店铺套（`sk_shop_sets`）的「关联平台」是**自由文本展示名**（`store.ts` 的 `PLATFORM_OPTIONS`，如 `速卖通`）；
  `sk_shops.platform` 是**小写代码**（`ae` / `amazon` / …，`store.ts` 的 `SHOP_PLATFORM_OPTIONS`）。
  两者只靠 `shopPlatformCodeFromLabel()` 启发式对接，映射不上返回空串由人选（不猜）。
- **`shopUpsert` 是全量提交**：只传 `{ id, name }` 会把平台/标识/状态/备注**静默清空**。
  「名下店铺」的解绑必须整行回传、只把 `shopSetId` 置 0；店铺登记编辑表单必须回填 `platformShopId`——
  1.5.2 之前登记页编辑一次就会把已登记的标识静默抹掉。
- **名下店铺区块**（编辑抽屉）：数据落 `sk_shops`、`shop_set_id` 软关联本套装（`shop` 域 `list` 的
  `shopSetId` 过滤，0 = 不过滤而非"只看未关联"）；新增套装时无套装 id，先保存才能登记。

## 开发

本包为 **Vite + Vue 3 + Pinia 工程**（与 `ui-plugins/ae-profit` 同一套路），`dist/` 是构建产物，**不要手改**：

```bash
cd ui-plugins/shop-accounts
npm install        # 首次
npm run build      # 产出 dist/index.html + dist/assets/*
```

```
index.html            岛页面外壳（宿主注入 __sk runtime + --wb-* 令牌）
vite.config.mjs       构建配置：base './'（sk-plugin:// iframe 必需）+ 宿主服务 alias
src/main.js           入口：createApp + Pinia
src/App.vue           桥就绪门禁（未连宿主时给出明确提示）
src/bridge.js         __sk 受控桥封装（db / mail / storage / clipboard / notify / bus）
src/api.js            宿主服务适配层：把桥调用包装成内建插件同名的 shopAccount* / mail* / company*
src/storage.js        命名空间持久化（对应宿主 useModuleStorage）
src/theme.js          color-scheme 跟随（宿主只注入 --wb-* 变量、不设 data-theme，需岛内按背景亮度回写）
src/style.css         --wb-* 令牌兜底 + 输入控件主题化（等价宿主 @layer components）
src/ShopAccountsView.vue    主视图（页签：账号库 / 邮件收件箱 / 企业管理 / 设置）
src/store.ts                店铺套 store（三视图 / 复制模板 / 批量修改 / 分组归类）
src/mailStore.ts            收件箱 store（同步状态机 / 未读统计 / 事件订阅）
src/components/*            账号库、收件箱、企业管理、设置各面板
```

> 源码于 2026-09-16 从已下记的内建版 `extensions/shop-accounts` 整体迁入（vite alias 把
> `@/core/services/ipc|clipboard|toast|storage` 指向岛内桥实现），因此**界面与交互与内建版一致**。
> 宿主新增能力时：先在主进程加 IPC + `host.ts` 的 `DB_OPS` 白名单，再在 `manifest.json` 的
> `capabilities` 声明，最后在 `src/api.js` 暴露同名函数。

### 企业管理（Tab 2）

- **企业**：名称（唯一）/ 统一社会信用代码 / 注册国家 / 地址 / 法人 / 联系人 / VAT / EORI / 状态 / 备注；
- **合规资料**（挂在企业下，一条一家）：
  - 欧代 `eu_rep`：欧代公司名称、协议号、联系人、有效期，扩展「适用产品 / 类目」；
  - 土代 `tr_rep`：土代公司名称、注册号、联系人、有效期，扩展「适用产品 / 类目」；
  - 德国包装法 `de_packaging`：双元系统（回收商）、LUCID 注册号，扩展「回收合同号 / 申报年度 / 申报重量」；
- 到期预警：资料有到期日且 ≤ 30 天（含已过期）时，列表顶部提示条数与卡片红字；
- 数据落 `sk_companies` / `sk_company_profiles`，经 `db` 能力域的 `company*` op 读写（与账号库同一份 SQLite）。

### 邮箱接入流程（岛内闭环）

1. 收件箱工具条「接入邮箱」→ 选**店铺套**（接入归属，授权码写在该店铺套的 `mailAuthPwd` 加密列）；
2. 填邮箱地址 → 自动按域名推断服务商预设（IMAP 主机/端口/SSL + 授权码获取入口）；可展开「IMAP 参数（高级）」手改；
3. 填 **IMAP 授权码**（不是登录密码）→ 可先「测试连接」；
4. 「保存并同步」→ 写入后自动触发该邮箱同步；「邮箱管理」里可 同步 / 配置 / 重授权 / 取消接入。

安全口径：授权码**只进不出**——提交后即刻清空输入框、不入 `state`、不落岛内 storage；编辑时留空即沿用已保存的授权码。

本地预览：`npm run dev` 起 vite 开发服务器（脱离宿主时 `__sk` 缺失，页面会显示「未检测到宿主桥」提示）；
也可 `npm run build && npx vite preview` 预览产物。

## 发布

```bash
cd /path/to/SellerKit
node scripts/publish-plugin.js --dir ui-plugins/shop-accounts \
  --base https://raw.githubusercontent.com/<owner>/<repo>/main --build
```

产物：`market-out/shop-accounts-<version>.zip` + `market-out/catalog.json`。
本地验证：`cd market-out && python3 -m http.server 8000`，应用「插件市场」填 `http://127.0.0.1:8000/catalog.json`。
