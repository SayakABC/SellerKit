# shop-accounts（UI 岛形态）

「店铺账号管家」的市场分发版本：iframe 运行时岛 + `window.__sk` 桥。

## 与宿主内建版的关系

| 项 | 宿主内建（`extensions/shop-accounts`） | 本 UI 岛 |
| --- | --- | --- |
| 形态 | `kind: view`，随宿主编译 | `kind: ui`，市场下载安装 |
| 数据 | 同一套 SQLite | **同一套 SQLite**（经 db 能力域） |
| 敏感字段 | 主进程 safeStorage 加密 | 同上（密文不出主进程，岛只见明文副本用于编辑） |
| 邮件 | 同一套 mail IPC | 同上（经 mail 能力域） |
| 邮箱接入 | 设置页 / 账号库内完成 | **岛内完成**（填授权码 → 测试连接 → 保存并同步） |

> 二者读写的是**同一份数据**，不需要迁移；但请勿同时打开（避免并发编辑互相覆盖）。

## 能力声明

- `db`（`domains: ["shop-accounts"]`）：宿主登记的白名单业务操作，**不放行任意 SQL**。
- `secrets`（`domains: ["shop-accounts"]`）：仅可查询宿主安全存储可用性。
- `mail`（`domains: ["mail"]`）：只读 IMAP 语义的邮件操作 + 邮箱接入维护（`accountUpsert` / `accountTest` / `accountDelete` / `providers`）。
- `storage` / `clipboard`：UI 偏好持久化与复制。

未声明的能力调用会被宿主权限门拒绝并写入审计环（设置 → 插件）。

## 开发

本包为**零依赖静态站点**（无需 `npm install`），源码即 `dist/` 下的 ES Module：

```
dist/index.html   外壳（Tab：账号库 / 收件箱）
dist/styles.css   主题（消费宿主注入的 --wb-* 令牌）
dist/bridge.js    __sk 桥封装（notify / copy / db / mail / storage）
dist/api.js       业务 API 层（店铺套 + 邮件，统一解错）
dist/accounts.js  账号库视图
dist/mail.js      收件箱视图 + 邮箱接入（IMAP 授权码）弹窗
dist/styles.css   含 .frow / .adv / .acct-card 等表单与列表样式
dist/main.js      启动与 Tab 路由
```

### 邮箱接入流程（岛内闭环）

1. 收件箱工具条「接入邮箱」→ 选**店铺套**（接入归属，授权码写在该店铺套的 `mailAuthPwd` 加密列）；
2. 填邮箱地址 → 自动按域名推断服务商预设（IMAP 主机/端口/SSL + 授权码获取入口）；可展开「IMAP 参数（高级）」手改；
3. 填 **IMAP 授权码**（不是登录密码）→ 可先「测试连接」；
4. 「保存并同步」→ 写入后自动触发该邮箱同步；「邮箱管理」里可 同步 / 配置 / 重授权 / 取消接入。

安全口径：授权码**只进不出**——提交后即刻清空输入框、不入 `state`、不落岛内 storage；编辑时留空即沿用已保存的授权码。

本地预览：直接以静态服务器打开 `dist/`（脱离宿主时 `__sk` 缺失，会显示「未连接到宿主」提示并禁用操作）。

## 发布

```bash
cd /path/to/SellerKit
node scripts/publish-plugin.js --dir ui-plugins/shop-accounts \
  --base https://raw.githubusercontent.com/<owner>/<repo>/main --build
```

产物：`market-out/shop-accounts-<version>.zip` + `market-out/catalog.json`。
本地验证：`cd market-out && python3 -m http.server 8000`，应用「插件市场」填 `http://127.0.0.1:8000/catalog.json`。
