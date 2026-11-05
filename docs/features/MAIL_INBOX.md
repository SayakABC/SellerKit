# 集中邮件收件箱（Mail Inbox）— M1 / M2 / M3 + 正文渲染通道 已落地

> 更新：2026-10-15（收件箱所在模块 2026-10-14 更名「基础数据」并整页重设计，本页位置表述已同步）
> 代码入口：`electron/mail-*.ts`（主进程）、`src/modules/shop-accounts/`（渲染层，内建模块；曾为 UI 岛，2026-10-14 迁回宿主，见 `docs/notes/2026-10-30-shop-account-merge-and-status.md`）
> 相关文档：`AGENTS.md`（架构基线）、`docs/features/PROFIT_TRACKER.md`（ae 利润模块）、
> `docs/notes/2026-10-30-mail-and-today-pages.md`（正文图片为什么坏 / `sk-mail://` 的两条实测取证）

---

## 1. 功能定位与范围

「基础数据 › 店铺账号」下的**集中收件箱**：把每家店铺绑定的邮箱（163/126 为主）聚合到一个本地 inbox，
支持按店铺筛选、关键词搜索、未读过滤、时间窗口过滤。
（⚠️ 2026-10-22 物理合并：账号不再叫"店铺套"，`sk_mail_accounts` 外键已由 `sk_shop_sets(id)` 改指
`sk_shops(id) ON DELETE CASCADE`，见 `docs/decisions/ADR-003-shop-account-physical-merge.md`。）

**边界（务必守住）**

- **只读**：IMAP 一律 `mailboxOpen({ readOnly: true })`，引擎**不提供任何 STORE/flag 写入能力**，
  绝不改变用户邮箱里的已读状态——「已读」= 服务端 `seen` **或**本地 `read_at`（详见 §3 决策 6）。
- **本地优先**：列表/搜索/详情全部查本地 SQLite，**列表渲染路径绝不触网**（秒开的前提）。
- **凭据不出引擎**：授权码经 `shop-accounts-db` 解密后只在主进程引擎内使用，绝不回传渲染层。
- **接入态谁读谁初始化**：账号清单由 `mailStore.ensureAccountState()` 提供（prefs + providers + accounts，
  **不含**轮询与同步事件）；「基础数据」的账号行与「接入邮箱」抽屉自己 await 它，**不能假设收件箱先被打开过**
  —— 否则冷启动直接进「基础数据」时每行恒显示「未接入」、抽屉是空表单（2026-10-25 修，见
  `docs/notes/2026-10-30-mail-and-today-pages.md`）。`ensureReady()` 负责收件箱自己
  的轮询/事件订阅，内部复用同一个加载。

---

## 2. 已落地（M1）

### 2.1 文件清单

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 主进程 | `electron/mail-db.ts` | 邮件库 schema（`sk_mail_*`）+ 全部 CRUD / 列表 / 统计 |
| 主进程 | `electron/mail-providers.ts` | 服务商预设（连接参数 + 授权码获取指引），**不含任何凭据** |
| 主进程 | `electron/mail-cache.ts` | 附件本地磁盘缓存（`<userData>/mail-cache`，LRU 淘汰 + GC，M3-1） |
| 主进程 | `electron/mail-html.ts` | 正文 HTML 纯函数层：cid 引用识别/改写、远程图计数、回填判据（无 Electron/DB 依赖，可直接单测） |
| 主进程 | `electron/mail-body-protocol.ts` | 正文渲染协议 `sk-mail://`：把正文跑在自带 CSP 的独立来源文档里（内联图/远程图显示的**唯一**通路） |
| 主进程 | `electron/mail-engine.ts` | IMAP 只读同步引擎：连接测试 / 增量同步 / 并发限流 / 进度广播 |
| 主进程 | `electron/mail-handlers.ts` | IPC 通道定义（`mail-*`）与入参消毒 |
| 渲染层 | `src/modules/mail/MailInboxView.vue` / `src/modules/shop-accounts/components/MailAccessDrawer.vue` / `src/modules/mail/mailStore.ts` | 收件箱视图 + 邮箱接入（页内闭环：填授权码 → 测试连接 → 保存并同步）与收件箱 store（同步状态机 / 未读统计）。正文 iframe 指向 `sk-mail://body/<id>`；远程图**默认放行**（该收件箱的正文图全是远程图），横条可一键切回拦截 |
| 嵌正文的 CSP | 宿主 `index.html`（内迁前是岛根 index.html 的 meta CSP） | ⚠️ **嵌正文的页面所处文档的 CSP 必须含 `frame-src sk-mail:`** —— CSP 取交集，任何一层缺这条正文 iframe 就 `ERR_BLOCKED_BY_CSP`（正文区整块空白、只在 Electron 日志里报）。守卫 `tests/islandMailFrameCsp.spec.ts`（2026-10-14 起改为钉宿主 `index.html` 与内建模块） |
| 渲染层 | `src/core/services/ipc.ts`（mail 能力域包装） | 邮件 API 经宿主统一 IPC 服务调用（原岛内 `api.js`/`bridge.js` 桥桩已随岛删除） |

### 2.2 数据模型（`sk_mail_*`）

```
sk_mail_accounts     id / shop_id(UNIQUE, FK → sk_shops(id) ON DELETE CASCADE) / email / provider_id /
                     imap_host / imap_port / imap_secure / proxy / folder /
                     sync_enabled / sync_days(默认30) / max_body_bytes(默认200KB) /
                     status / last_error / last_synced_at /
                     uid_validity / last_uid / created_at / updated_at
sk_mail_messages     UNIQUE(account_id, folder, uid)   ← 幂等 upsert 的基石
                     envelope 字段 + seen/flagged/has_attachment/body_cached/preview
                     read_at TEXT NOT NULL DEFAULT ''   ← 本地已读标记（有效已读 = seen || read_at≠''）
sk_mail_bodies       message_id(PK) / text_body / html_body / truncated
sk_mail_attachments  message_id / filename / mime / size / content_id  ← 仅元信息，M2 起支持按需落盘
                                                          content_id 是正文内联图（src="cid:..."）唯一的映射键
sk_mail_folders      UNIQUE(account_id, path)               ← M3-3 每文件夹独立游标（uid_validity/last_uid）
sk_mail_attachment_cache  attachment_id(PK)                  ← M3-1 只存路径，二进制不入库
sk_mail_meta         key(PK) / value                         ← FTS 回填游标等运行时元数据
sk_mail_fts          fts5 虚表（M3-2，rowid = sk_mail_messages.id）
```

授权码（secret）**不在此库**，走 `shop-accounts-db` 的 safeStorage 通道，见 §2.5。

### 2.3 同步引擎（`mail-engine.ts`）

- **两轮抓取**（对齐 Thunderbird「不下载大于 X KB」）：
  1. 元数据轮：`fetch(uidRange, { uid, size })`，`FETCH_BATCH = 200` 分批写库；
  2. 正文轮：`BODY_BATCH = 20`，只对「未缓存且 size ≤ maxBodyBytes」的邮件抓 source 并解析正文。
     **超大邮件只留预览、不落正文**（`body_cached = 0`）——这正是 M2-1 要补的口子。
- **增量策略**：先按 `since = now - syncDays` 搜索窗口，再叠加 `uid > last_uid` 增量；
  `UIDVALIDITY` 变化即 `resetMailAccountMessages` 全量重拉（UID 语义已变）。
- **无 IDLE / 无 CONDSTORE**：163/126 实测不支持，实时性靠手动/轮询同步。
- **并发限流**：`MAX_GLOBAL_CONNECTIONS = 3`，串行队列 + 单飞去重（已在队列中的账号不重复入队）。
- **分批事务 + 可中断**：better-sqlite3 是同步 API，长事务会阻塞主进程，故每批独立事务；
  取消在**批次边界**生效，不留半截数据。
- **进度广播**：`mail-sync-event` → `setMailEventWindow(() => mainWindow)`，渲染层订阅后更新状态机。
- **过期清理**：同步末尾 `purgeMailMessages(accountId, now - syncDays)`。

### 2.4 IPC 契约（`mail-*`，kebab-case）

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `mail-db-ensure` | invoke | 建表/迁移（惰性） |
| `mail-account-list` / `mail-account-upsert` / `mail-account-delete` | invoke | 账号 CRUD |
| `mail-account-test` | invoke | 连接测试（只读打开后即登出，**不落库**） |
| `mail-provider-list` | invoke | 服务商预设（授权码指引） |
| `mail-sync-now` / `mail-sync-cancel` / `mail-sync-state` | invoke | 同步控制与队列状态 |
| `mail-messages-list` | invoke | 列表（**纯本地查询**） |
| `mail-message-get` | invoke | 详情（正文 + 附件元信息）；正文含 `cid:` 引用而附件行还没有映射时，**顺带重解析一次回填 `content_id`**（6s 超时兜底，超时按现状返回、回填在后台继续） |
| `mail-message-read` | invoke | 本地已读标记（单个/批量/整账号，返回 `{ changed, unread }`） |
| `mail-body-fetch` | invoke | 按需补拉正文（M2-1） |
| `mail-attachment-save` | invoke | 附件另存（M2-2，弹保存对话框后落盘） |
| `mail-attachment-preview` | invoke | 附件预览：走缓存优先，图片 ≤5MB 返回 data URL（M3-1） |
| `mail-attachment-open` | invoke | 附件入缓存后 `shell.openPath`（M3-1） |
| `mail-folders-list` | invoke | 只读拉取服务端文件夹清单（M3-3，不落库） |
| `mail-cache-status` / `mail-cache-clear` / `mail-cache-open` | invoke | 缓存用量 / 清空 / 打开目录（M3-1） |
| `mail-fts-status` / `mail-fts-rebuild` | invoke | 全文索引进度 / 重建（M3-2） |
| `mail-purge` / `mail-stats` | invoke | 清理 / 汇总统计（stats 含 `folders[]` 计数） |
| `mail-sync-event` | main → renderer | 同步进度广播 |

新增通道必须同步四处：`electron/mail-handlers.ts` → `electron/preload.ts` →
`src/types.ts`(`ElectronAPI`) → `src/core/services/ipc.ts`。

### 2.5 安全与凭据

- 授权码存 `shop-accounts-db` 的 secret 列；写入路径 safeStorage 加密，读取路径
  `revealShopAccountSecret()` 仅在主进程解密（含 256B 采样探测的安全降级路径）。
- **渲染层禁止直连 `window.electronAPI`**：一律走 `core/services/ipc.ts` 封装。
- IPC 入参在 handler 侧二次消毒（数值/长度/布尔），不信任渲染层。

---

## 3. 关键设计决策（勿回退）

1. **只读 IMAP**：不写 flag、不删服务端邮件——避免"看了邮件就把用户邮箱标已读"的事故。
2. **列表不触网**：列表/搜索走本地库，同步进度另走事件广播；否则大窗口下必然卡死。
3. **UID + UIDVALIDITY 双条件增量**：只认 `last_uid` 会在 UIDVALIDITY 变化后错乱。
4. **正文与预览分离落库**：超大邮件不落正文也要有预览，故 `updateMailParsed` 与 `saveMailBody` 分开调用。
5. **附件只存元信息**（M1）：避免同步阶段为附件付流量/磁盘成本；需要时再按需拉取（M2）。
6. **已读态在本地，不在服务端**：IMAP 只读改不了 flag，而每次同步都会把 `seen` 覆盖回服务端值，
   所以必须有本地列兜底——`sk_mail_messages.read_at`（空串=未读过），
   **有效已读 = `seen = 1 OR read_at ≠ ''`**；列表查询、`只看未读` 过滤、角标统计三处共用同一口径
   （`EFFECTIVE_READ_SQL` / `COALESCE(read_at,'')=''`），漏一处就会出现"点了邮件未读不消失"。
   `upsertMailMessages` 刻意不写 `read_at`，同步不会冲掉本地已读。

---

## 4. M2（已实施）

> 目标：把 M1 故意留下的两个"口子"补上——**超大邮件正文**与**附件内容**，
> 二者共用同一条技术路径：**按 UID 单封重拉 source → 解析 → 落库/落盘**。

### M2-1 邮件正文按需补拉

**问题**：M1 中 `size > maxBodyBytes` 的邮件不落正文，详情页只有预览（"正文过大，未缓存"）。

**方案**

- 引擎新增 `fetchMailBody(accountId, messageId)`：
  1. `getMailAccount` + `getMailMessage` 取 `uid`，缺任一方直接返回 `null`；
  2. 走 `connect()` 连接池（复用 M1 的 `CONNECT` 池与限流，新开连接需受 `MAX_GLOBAL_CONNECTIONS` 约束）；
  3. `fetch(String(uid), { uid: true, source: { start: 0, maxLength: ON_DEMAND_MAX_BYTES } })`；
     `ON_DEMAND_MAX_BYTES` 取 `max(account.maxBodyBytes, 25MB)`——按需场景用户明确要看，上限放宽；
  4. `simpleParser(source)` → `saveMailBody()` + `updateMailParsed(preview, hasAttachment)`
     + `replaceMailAttachments()`（顺便补齐附件清单）；
  5. `source.length >= maxLength` 时 `truncated = true`；
  6. 返回 `getMailMessage(messageId)`，UI 直接整体替换详情。
- **并发**：按需拉取最多同时 2 个（`ON_DEMAND_MAX_CONCURRENT`），超出排队，避免把连接池占满导致同步饿死。
- **失败处理**：失败不熔断账号（与同步不同——单次拉取失败不代表账号不可用），只把 `lastError` 透传给调用方 toast。

**接口**

```ts
// IPC
mailBodyFetch({ accountId: number; messageId: number }) -> ApiResult<MailMessageDetail | null>
```

**验收**：超大邮件详情页显示「正文过大，仅缓存预览」+「拉取完整正文」按钮 → 点击后正文/附件出现；
断网时按钮报错 toast 且不影响列表。

### M2-2 附件下载

**问题**：M1 只存附件元信息，`sk_mail_attachments` 无内容字段。

**方案**

- 引擎新增 `fetchMailAttachmentData(messageId, attachmentId)` → `{ filename, mime, size, content }`：
  1. 取消息（`uid`）+ 附件行（filename/mime/size，取自 `getMailMessage().attachments`）；
  2. 重拉 source（上限同 M2-1，`ON_DEMAND_MAX_BYTES`）并 `simpleParser(source)`；
  3. **定位附件**：先按「附件行序号」取（`ordinal` = 该行在明细列表中的下标，与入库顺序一致），
     文件名对不上时按「同名序号」回退——处理重名附件（如多张 image001.png）；
  4. **不把附件内容写进 SQLite**（体积不可控 + 同步语义复杂），只交给 handler 落盘。
- **落盘路径**：handler 侧 `dialog.showSaveDialog({ defaultPath: filename })`（聚焦窗口归属），
  `fsPromises.writeFile` 写盘；用户取消 → 返回 `{ canceled: true }` 而非报错。

**接口**

```ts
// IPC
mailAttachmentSave({ messageId: number; attachmentId: number }) -> ApiResult<{ path: string; size: number } | null>
// 用户取消保存对话框：data === null 且 canceled === true
```

**验收**：详情页附件行出现「下载」按钮 → 弹保存对话框（默认文件名=附件名）→ 确认后文件落盘且大小与元信息一致；
取消不弹错误。

### M2 任务清单

- [x] `electron/mail-engine.ts`：`fetchMailBody` / `fetchMailAttachmentData` + 按需并发限流（`ON_DEMAND_MAX_CONCURRENT = 2`）
- [x] `electron/mail-handlers.ts`：`mail-body-fetch` / `mail-attachment-save`（含保存对话框与落盘）
- [x] `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts`（`ElectronAPI` 与 `ElectronApi` 两处接口）：通道同步
- [x] `mailStore.ts`：`fetchBodyOnDemand` / `saveAttachment`
- [x] `MailInboxView.vue`：`!bodyCached` 时出「拉取完整正文」按钮 + 附件行「下载」按钮（下载中禁用）
- [x] 校验：`npm run build` + `vue-tsc --noEmit` + `tsc -p tsconfig.electron.json --noEmit` 全通过

> 说明：列表项渲染仍**完全不触网**——按需拉取只在用户点击详情按钮/下载附件时发生，且受并发名额约束。

---

## 5. M3（已实施）

> 目标：**附件别再重拉**、**搜索别再用 LIKE**、**只看 INBOX 不够**。三条都在"列表不触网"前提下完成。

### M3-1 附件本地缓存与预览

**问题**：M2 的「下载」每次都重连 IMAP 重拉整封 source；同一个附件点 5 次就付 5 次流量。

**方案**

- 新增 `electron/mail-cache.ts`：`<userData>/mail-cache` 目录，文件名 `<attachmentId>-<sanitized>`；
  写盘后把**路径**登记进 `sk_mail_attachment_cache`（二进制不入库），并把 `last_access_at` 刷新为访问时间。
- **配额与淘汰**：`CACHE_MAX_BYTES = 200MB`（目录总），`CACHE_FILE_MAX_BYTES = 50MB`（单附件）；
  写盘后超配额即按 `last_access_at` 升序 LRU 淘汰。`mail-cache-clear` / 删除账号 / `mail-purge` 后
  触发 `garbageCollectMailCache()`，回收"表里已无记录的残留文件"。
- **缓存不失效**：`replaceMailAttachments()` 按 `filename+mime+size` 成键，**命中即保留原 attachment id**
  （否则重新同步会让已下载的附件 id 漂移，缓存全废）。
- 引擎新增 `resolveMailAttachment(messageId, attachmentId)`：**先读缓存** → 命中直接返回（不联网）；
  未命中走 M2 的路径拉取后 `writeMailAttachmentCache()`；超大附件退化为临时文件路径（不占缓存配额）。
- **预览通道** `mail-attachment-preview`：仅 `image/*` 且 ≤ `PREVIEW_MAX_BYTES(5MB)` 才转 data URL
  （避免大 base64 撑爆渲染进程）；非图片走 `mail-attachment-open` → `shell.openPath` 调系统应用。
- **UI**：详情页附件行三按钮「预览 / 打开 / 另存」，预览结果内联显示；设置页「附件缓存」显示
  目录、文件数、用量条（相对 200MB 配额），支持「清空缓存 / 打开缓存目录」。

### M3-2 FTS5 全文检索

**问题**：原 `listMailMessages` 关键词走 `LIKE`，只扫主题/预览，正文不参与、无分词。

**方案**

- `sk_mail_fts`：`CREATE VIRTUAL TABLE ... USING fts5(subject, from_name, from_addr, preview, body_text, tokenize='unicode61')`，
  rowid 复用 `sk_mail_messages.id`。**不支持 FTS5 的构建自动降级为 LIKE**（`isMailFtsAvailable()` 判定）。
- **CJK 处理**：`toMailFtsQuery()` 对 CJK 字串逐字符补空格后再加引号，避免 unicode61 把整句当一个 token；
  英文短语仍走正常词组匹配。
- **增量维护**：`saveMailBody()` 默认写索引；同步主循环批量传 `{ index: false }`，整文件夹结束后
  统一 `indexMailMessages(ids)` 批量写；`ensureMailSchema()` 每次启动按游标回填（每轮 200 封，游标存 `sk_mail_meta`）；
  `mail-fts-rebuild` 可全量重建。
- **清理**：FTS 虚表**无外键级联**，故 `purgeMailMessages()` / `deleteMailAccount()` 显式 `removeMailFtsByMessageFilter()`
  + `pruneMailFts()`，避免孤儿 rowid。
- 搜索命中走 `id IN (SELECT rowid FROM sk_mail_fts WHERE ... MATCH ...)`，与其余过滤条件取交集；
  FTS 抛错即回退 LIKE，**不会让列表打不开**。

### M3-3 多文件夹

**问题**：每套看账号的账号只有一个 `folder`（默认 INBOX），订阅/推广/自定义文件夹看不到。

**方案**

- `sk_mail_folders(account_id, path)` 唯一索引，承载每文件夹的 `uid_validity / last_uid`；
  账号 `folders` 列（JSON 数组）为"启用的文件夹清单"，为空时 `resolveMailFolders()` 回退单文件夹，
  **不影响已有账号**（主文件夹沿用账号级旧游标，不触发全量重拉）。
- 同步主循环改为遍历文件夹：`for (const folder of folders) syncMailFolder(...)`；
  单文件夹失败只进 `errors`、不熔断整账号，全部失败才置 `status='error'`。
- `mail-folders-list`：只读连接 `client.list()` 拉服务端目录树（**不落库**），供设置页勾选；
  保存时回传**账号完整字段**（`providerId` 等一并带上，避免局部更新把其它配置写成空）。
- **UI**：列表头部按 `mail.stats.folders` 出「全部文件夹」下拉（`folderFilter`）；设置页「同步文件夹」
  支持选邮箱 → 读服务器文件夹 → 勾选保存 → 立即重同步。

### M3-4 已读 / 未读状态修复

**问题**：点击邮件后未读小点与角标不动。根因是 `seen` 只来自同步时的**服务端 flag**，而 IMAP 只读引擎改不了服务端，
打开邮件也没有任何本地写入 ⇒ 读过的邮件永远是未读，`stats.unread` 只统计服务端未读，口径也对不上体感。

**方案**

- `ensureMailMessageColumns()` 为存量库补 `read_at`（新建库由 `ensureMailSchema()` 迁移后自动补列）。
- 新增 `markMailMessagesRead(ids, read)` / `markAllMailMessagesRead(accountId?, read)`：
  仅更新状态未达标的行（幂等），返回实际变更行数；**服务端 `seen=1` 的行不允许改回未读**。
- 新增 IPC `mail-message-read`（`mail-handlers` / `preload` / `src/types.ts` / `src/core/services/ipc.ts` 四处同步），
  返回 `{ changed, unread }`，前端直接用它校正角标，不必重查列表。
- `openMessage()` 拿到详情后：若 `!detail.read` → 静默 `markRead([id], true)`（打开即已读）。
- store `markRead()` 同步刷新列表行与详情的 `read/readAt`，并在「只看未读」下重查列表让已读项消失。
- UI：列表未读态统一走 `isUnread(m)` helper（`!seen && !read`）；详情头显示「已读」与「标记未读」按钮
  （仅本地读过且服务端未读时可回退）；列表头新增「全部已读」按钮（按当前筛选邮箱 / 全部账号）。

**验收**：点一封未读 → 小点消失、角标 -1；**重新同步后仍保持已读**（不会被服务端 `seen=0` 冲回）。

### M3 任务清单

- [x] `electron/mail-cache.ts`：缓存写/读/清/GC/状态 + LRU 配额
- [x] `electron/mail-db.ts`：folders / attachment_cache / meta / FTS 虚表 + 对应查询与索引维护
- [x] `electron/mail-engine.ts`：`runMailSync` 多文件夹循环、`resolveMailAttachment`、`listMailRemoteFolders`
- [x] `electron/mail-handlers.ts`：`mail-attachment-preview|open`、`mail-folders-list`、`mail-cache-*`、`mail-fts-*`
- [x] `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts`（两处接口同步）：通道与类型
- [x] `mailStore.ts`：`folderFilter` / `attachmentPreview` / `previewAttachment` / `openAttachment` /
  `loadRemoteFolders` / `cacheStatus` / `clearCache` / `openCacheDir` / `ftsStatus` / `rebuildFts`
- [x] `MailInboxView.vue`：文件夹筛选下拉 + 附件「预览 / 打开 / 另存」+ 内联预览区
- [x] `MailSettingsPanel.vue`：同步文件夹（读服务器+勾选保存）、附件缓存用量条与清/开按钮、索引进度与重建
- [x] `electron/mail-db.ts`：`read_at` 补列 + `markMailMessagesRead` / `markAllMailMessagesRead` + 三处有效已读口径统一
- [x] `electron/mail-handlers.ts` + `preload.ts` + 两处类型表面：`mail-message-read`
- [x] `mailStore.ts` / `MailInboxView.vue`：打开即已读、`markRead` / `markAllRead`、未读小点与角标同步
- [x] 校验：`npm run build` + `vue-tsc --noEmit` + `tsc -p tsconfig.electron.json --noEmit` 全通过

> 红线不变：列表/搜索仍是**纯本地查询**；联网只发生在 同步 / 按需补拉 / 附件首次拉取 / 读服务器文件夹。

---

## 6. 正文渲染通道（`sk-mail://`，2026-10-04）

> 起因：正文里的图片「一张都显示不出来」。根因取证与实测日志见
> [`docs/notes/2026-10-30-mail-and-today-pages.md`](../notes/2026-10-30-mail-and-today-pages.md)。

### 6.1 为什么要另起一个协议

原先正文用 `<iframe sandbox="" :srcdoc="htmlBody">` 渲染，同时撞上两堵墙：

- **`srcdoc` 文档继承父文档的 CSP** —— 父文档是 `sk-plugin://` 下的岛页面（`img-src 'self' data:`），
  邮件里的远程图一律被 CSP 拦（实测 `Loading the image ... violates "img-src 'self' data:"`）；
- **`cid:` 没有映射键** —— `<img src="cid:image001.png@01D9...">` 是 MIME 的 Content-ID，
  浏览器不认这个 scheme，而附件表原先没有 `content_id` 列，宿主无从把它换成真图片。

**独立来源的文档不继承父文档 CSP**（实测：父 CSP 加 `frame-src sk-mail:` 后，
子文档与其图片子资源都正常发起请求），所以正文改由 `sk-mail://` 提供。

### 6.2 两个 host

| URL | 作用 |
| --- | --- |
| `sk-mail://body/<messageId>[?remote=1]` | 正文文档。`cid:` 引用在返回前改写为下面的 att URL；响应自带 CSP |
| `sk-mail://att/<messageId>/<attachmentId>` | 内联图片二进制。磁盘缓存优先，未命中才重拉原文（复用按需限流），会话内可缓存 10 分钟 |

### 6.3 三层安全边界（互不依赖）

1. **岛页面 CSP**：只多一条 `frame-src sk-mail:`（放行"被嵌入"，不放开 img / connect / script）；
2. **正文文档 CSP**：`default-src 'none'` + `img-src sk-mail: data:` + `script-src 'none'`；
   **远程图默认不放行**（防追踪像素），`?remote=1` 才加 `https: http:`；
3. **iframe `sandbox=""`**：邮件 HTML 里的 JS 一律不跑。

越权面与 `mail` 能力域已暴露的读能力同级（附件只按 `(messageId, attachmentId)` 取，
且会校验该附件确属这封邮件），**未新增 IPC 通道、未新增能力域 op**。

### 6.4 远程图默认拦截 + 一键放行

正文上方出「已拦截 N 张远程图片（防发件方追踪）」+「显示远程图片」按钮（点击即带 `?remote=1` 重载）。
计数由**岛侧**基于 `detail.htmlBody` 判定 —— sandbox 的正文文档无法与岛通话，必须由岛自己算。
换一封邮件自动回到"拦截"默认态。

### 6.5 存量邮件的惰性回填

`content_id` 是后加的列，已同步过的邮件附件行补出来是空串；而**增量同步只处理新 UID**
（正文已缓存的邮件不再进正文轮），老邮件不会自己好。故 `mail-message-get` 增加回填触发：
判定 = 正文含 `cid:` 引用 ∧ 该邮件附件行**一条 `content_id` 都没有**（`needsInlineBackfill`）。
回填后正文里的内联图即正常，且不会反复触发。

> ⚠️ **红线**：`content_id` **不进** `replaceMailAttachments` 的合并键。该键（`filename+mime+size`）的
> 作用是保留原 `attachment_id`，content_id 进键会让老行被判成另一个附件而换 id，
> `sk_mail_attachment_cache` 索引与已落盘文件整批失效。命中时只在旧值为空时 UPDATE 该列。

---

## 7. 验收与冒烟

| 项 | 命令 / 操作 | 期望 |
| --- | --- | --- |
| 主进程类型 | `npx tsc -p tsconfig.electron.json --noEmit` | 无错误 |
| 渲染层类型 | `npx vue-tsc --noEmit -p tsconfig.json` | 无错误 |
| 构建 | `npm run build` | 通过（registry 自动重生成） |
| 引擎冒烟（需真实凭据） | `MAIL_USER=xxx MAIL_AUTH=xxx npm run mail:smoke` | 连接测试 + 同步 N 封 + 正文/附件可读 |
| 正文图片离线冒烟（**无需凭据**） | `npm run mail:inline:smoke` | 存量库补出 `content_id` 且老数据不丢 · 重解析保留原 `attachment_id` · cid 改写为 `sk-mail://att/...` · 远程图两态 |
| 协议端到端冒烟（**无需凭据**，起真窗口） | `npm run mail:body:smoke` | 正文文档 200 / cid 改写命中 / 附件返回真实字节 / 三种 404 语义 / sandbox iframe 里正文与内联图都取到 200 / 远程图**默认零请求**且 `?remote=1` 真取到 200（本机非 loopback http 服务）/ **用岛真实 `index.html` 的 meta CSP 复刻第二层 CSP** |
| 两层 CSP 静态守卫（无需 Electron） | `npx vitest run tests/islandMailFrameCsp.spec.ts` | 岛若引用 `sk-mail://` ⇒ 其 `index.html` 的 meta CSP **必须**含 `frame-src sk-mail:`，宿主 `UI_CSP` 也必须含（两层缺一即红） |
| 手动 | 接入 163 邮箱 → 同步 → 列表/搜索/未读过滤 → 详情 → 补拉正文 → 下载附件 | 全程列表无阻塞 |
| M2-1 手动 | 找一封超 `maxBodyBytes` 的邮件 → 详情显示「正文未缓存」→ 点「拉取完整正文」 | 正文/附件出现；断网时 toast 报错且列表不受影响 |
| M2-2 手动 | 带附件的邮件 → 附件行点「下载」→ 系统保存对话框（默认文件名=附件名） | 确认后落盘、大小与元信息一致；取消不报错 |
| M3-1 手动 | 图片附件点「预览」→ 二次在同一封email再点 | 首次联网、**第二次秒开且不再走网**（缓存命中）；非图片点「预览」自动转「打开」调系统应用 |
| M3-1 手动 | 设置页「附件缓存」→ 清空缓存 / 打开缓存目录 | 用量归零、目录可直达；`<userData>/mail-cache` 无孤儿文件 |
| M3-2 手动 | 收件箱搜正文里才出现的中文/英文词 | 命中正文档邮件；设置页「全文检索索引」显示 `已索引 N / M`，「重建索引」后计数刷新 |
| M3-3 手动 | 设置页「同步文件夹」→ 选邮箱 → 读服务器文件夹 → 勾选 → 保存并重同步 | 列表头出现「全部文件夹」下拉，可按路径过滤 + 显示每文件夹邮件数；已有 INBOX 不触发全量重拉 |
| M3-4 手动 | 点开一封未读邮件 → 看列表小点与「N 未读」角标 | 小点消失、角标 -1；再点「同步」后仍为已读（不会被服务端 `seen=0` 冲回） |
| M3-4 手动 | 详情头「标记未读」/ 列表头「全部已读」 | 未读恢复后角标 +1；全部已读后角标归零、「只看未读」列表清空 |
| 正文图片 手动 | 打开一封**内联图**邮件（签名 logo / 商品图，`src="cid:..."`） | 图片正常显示（不再裂图）；老邮件首次打开时地图会出现（触发了一次惰性回填），之后再开不再重拉 |
| 正文图片 手动 | 打开一封**外链图**邮件 → 看正文上方横条 | 远程图默认不显示且出「已拦截 N 张远程图片」→ 点「显示远程图片」后图片出现 |
| 正文图片 手动 | 打开一封正文里带 `<script>` / 表单的邮件 | 脚本一律不执行（正文文档 CSP `script-src 'none'` + iframe `sandbox=""` 两层） |

---

## 8. 风险与后续（M4+）

- **163/126 限流**：高频重拉单封可能触发频控，按需拉取已限并发；后续可视情况加退避。
- **正文体积**：`ON_DEMAND_MAX_BYTES` 只放宽到 25MB，更大的邮件仍只留预览（可再加"分段拉取"）。
- **远程图默认拦截是产品决策**（防追踪像素 / 已读回执），不是能力缺失：需要时点正文上方的「显示远程图片」即可。
  若哪天要改成默认放行，只改 `mail-body-protocol.ts` 的 `bodyCsp()` 与岛侧默认值 —— 别把 `frame-src sk-mail:`
  之外的图片能力放开到岛 CSP 上（那会让所有岛都能外链取图）。
- **正文文档是浅色渲染**（与常见邮件客户端一致，`.html-frame` 也硬编码白底）：深色主题下正文区域仍是白底，
  如需跟随主题，要同时改文档外壳 CSS 与正文里发件方自带的颜色，收益不大。
- **非图片内联预览**（M4）：PDF/文本类目前走系统应用打开，如需内联需再引 viewer 或落盘后用系统预览。
- **附件全文**（M4）：FTS 目前只索引正文；附件内容（PDF/Office）需先提取文本再入索引。
- **草稿/发件箱**：多文件夹已具备读取能力，但发送侧（SMTP / 回复）尚未规划。
