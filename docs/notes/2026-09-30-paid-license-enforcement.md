# 付费授权：判定放哪、客户端到底防得住什么

**结论（四条，下次做付费功能直接照用）**

1. **岛是「预构建静态站点 + 本地明文文件」⇒ 付费墙不可能靠"藏代码"**。安装即解压落盘，宿主再用只读协议原样喂给 iframe；产物是明文 JS，用户一定能读到、也一定能改。付费能力要么宿主门控（可被 patch，只抬高成本），要么把价值放服务端（真防）。
2. **判定必须落主进程，岛只能"问"不能自判** —— 与本项目"宿主 = 平台、岛 = 插件"的结构同构，对应 JetBrains Marketplace 的官方做法（授权在平台侧，插件不打包校验代码，凭公钥验签服务器签发的凭据）。落点选 `security.ts` 的 `decidePermission()`：它是**纯函数**且被 vitest 覆盖，entitlement 快照由调用方注入，可继续单测；它与 ADR-002 的 C4 `domains` 判定**正交**，不动后者。
3. **三个执法点已经存在，零新协议、零新 db 域**：① 安装门 = `plugins-market-install`；② 激活门 = `managerActivate` / `pluginManager`；③ 调用门 = `DB_OPS` 给 op 加 `requires` 声明 + `security.ts` 判定（③ 是唯一能覆盖"用户手动把 zip 拷进插件目录"的门，且可复用现有权限审计环做展示）。因为**只给现有 op 加字段、不新增 op**，不受 ADR-002 N5 的 op 预算（≤10）约束。
4. **授权态不要沿用 `src/core/network/token.ts` 的 localStorage 路线**（渲染层 DevTools 可读可改）。必须落主进程 + `safeStorage` / electron-store 加密，渲染层只拿只读快照。

## 取证

- 岛包形态与落盘：`docs/architecture/PLUGIN_ARCHITECTURE.md` §15.2；`electron/plugins-market-handlers.ts`（`unzipSafe` + 原子 `rename` 到 `<userData>/plugins/<id>/`）。
- 明文喂给 iframe：`electron/plugin-ui-protocol.ts`（只读特权协议，逐段拒绝 `..`，原样返回包内文件）。
- 纯函数权限门：`src/core/plugin/security.ts` 的 `decidePermission` / `AuditEntry` / `createPermissionGate`（放行与拒绝**都**入审计环）。
- 调用门落点：`src/core/plugin/host.ts` 的 `DB_OPS`（域 → op 闭表白名单）；`src/core/plugin/gatedHost.ts`（宿主侧唯一授权入口）。
- 激活门与降级态可复用的 UI 链路：`src/core/plugin/managerActivate.ts`、`src/core/plugin/pluginManager.ts`（岛独立轨道 `uiIslands` + 统一停用集 `disabled`）、`src/core/AppShell.vue` 的 `onStateChange → refreshMetas()`。
- 审计展示位（零新 UI）：`src/core/components/PluginCenter.vue` 的「权限审计 · 最近被拒绝的调用」区。
- 现有不安全先例：`src/core/network/token.ts`（`localStorage` 存 `sk_auth_token`）。
- 客户端可被 patch：ASAR 是拼接归档非加密；`EnableEmbeddedAsarIntegrityValidation` / `OnlyLoadAppFromAsar` **默认关**（macOS ≥16 / Windows ≥30）；CVE-2024-46992（Windows 绕过，30.0.5 / 31.0.0-beta.1 已修）、CVE-2025-55305（V8 heap snapshot 不在 ASAR integrity 保护内）。官方与第三方口径一致：客户端保护不绝对，须配合服务端校验。

## 定案（2026-09-30 用户拍板）

收费客体 = **Pro 档功能**（不锁 App、不按岛收费）；计费 = **月 + 年双档订阅**；后端 = **零自建**（托管授权 API + 托管收银）；到期 = **降级为免费版**（Pro 能力不可调用，基础功能与数据照常）。完整方案与改动清单见 `docs/plans/PAID_LICENSE_PLAN.md`。

> 仍未拍板：托管方选型、免费版与 Pro 的功能切分、未授权时闸门②的表现、宽限期天数（建议 14 天）。
