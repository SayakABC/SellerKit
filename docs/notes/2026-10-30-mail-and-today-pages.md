# 邮件正文渲染与「今天」四页：32 条结论（蒸馏自 3 篇，2026-10-04 ~ 2026-10-25）

> **蒸馏笔记**：由 3 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-mail-and-today-pages.md`

---

## 1. 邮件正文的图一张都显示不出来：不是数据问题，是四层原因叠加

**结论**：不是数据问题。**四层原因叠加**，前两层是渲染管线结构问题，后两层是"改完为什么不生效"与"默认值选错"：

| 层 | 原因 | 症状 |
| --- | --- | --- |
| ① 结构 | 内联图（`src="cid:..."`）没有映射键（附件表无 `content_id` 列） | 内联图全裂 |
| ② 结构 | 正文用 `iframe srcdoc` 渲染 ⇒ **继承岛 CSP** `img-src 'self' data:` | 远程图全被拦 |
| ③ 分发 | 代码修好后**岛没重装**（本机跑的还是旧产物） | 界面上一点变化都没有 |
| ④ CSP | 岛自己的 `index.html` 里那份 **meta CSP** 缺 `frame-src sk-mail:`（CSP 取交集） | 正文区**整块空白**，只在 Electron 日志里报 `ERR_BLOCKED_BY_CSP` |

主修法仍是**另起一个自带 CSP 的 `sk-mail://` 协议**渲染正文（见 §7），但**只做 ① ② 是不够的** ——
③④ 见 §11/§12，那是"改完看不见效果"的真实原因。

**取证**：同日三次返工，本文含全部四层原因；触发链：用户报「邮件收件箱里的图片展示不出来」→ 修完仍报「还是没展示出来」。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 2. 内联图全裂：`cid:` 无映射键，`sk_mail_attachments` 没有 content_id 列

**结论**：内联图（签名 logo、商品图，`src="cid:xxx@yyy"`）全裂，根因是 `cid:` 是 MIME 的 Content-ID，浏览器不认这个 scheme；而 `sk_mail_attachments` **没有 content_id 列**，宿主无从把 `cid:` 换成真图片。

**取证**：`electron/mail-db.ts` 原 schema 仅 `filename/mime/size`；`mail-engine.ts` 原解析未取 `a.contentId`。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 3. 外链图全裂：`iframe srcdoc` 继承父文档 CSP（`img-src 'self' data:`）

**结论**：外链图（`https://...`）全裂，根因是正文用 `<iframe sandbox="" :srcdoc="htmlBody">` 渲染，而 **srcdoc 文档继承父文档的 CSP**；父文档是 `sk-plugin://` 下的岛页面，CSP 为 `img-src 'self' data:` ⇒ 外链图一律被拦。

**取证**：见 §5 实测日志（Electron 44 + `--no-sandbox --disable-gpu` 探针脚本）。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 4. 附件区「预览」走 `data:` URL，不受影响

**结论**：**顺带澄清**：附件区的「预览」按钮走 `data:` URL（`mail-attachment-preview`），**不受影响**，它本来就正常 —— 用户说的"图"是正文里的图。

**取证**：`mail-attachment-preview` 走 `data:` URL。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 5. 两条实测：srcdoc 的 CSP 确实继承自父文档；`cid:` 连"能解析"的机会都没有

**结论**：两条根因同时被证实，且**独立来源文档不继承父 CSP**（这正是换协议的依据）。

**取证**：探针脚本（Electron 44 + `--no-sandbox --disable-gpu`）：`sk-plugin://` 页面注入与 `UI_CSP` 相同的 CSP，内嵌两个 iframe —— 一个 `srcdoc="<img src='cid:abc@x'>"`，一个 `src="sk-mail://body/7"`。

```
# 父 CSP 不含 frame-src sk-mail: 时
Framing 'sk-mail://body/' violates ... "default-src 'self'" ... ('frame-src' was not explicitly set)
Loading the image 'cid:abc@x' violates ... "img-src 'self' data:". The action has been blocked.
⇒ 两条根因同时被证实：srcdoc 的 CSP 确实继承自父文档；且 cid: 连"能解析"的机会都没有。

# 父 CSP 加上 frame-src sk-mail: 后
HANDLED_URLS [ 'sk-mail://body/7', 'sk-mail://att/7/2' ]
⇒ 子文档加载成功，且它内部的 `<img src="sk-mail://att/...">` 子资源也真的发起了请求
   （父文档的 img-src 'self' data: 不再适用 ⇒ 独立来源文档不继承父 CSP，这正是我们要的）
```

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 6. 两条工程事实：`registerSchemesAsPrivileged` 可调两次；sandbox 下 CSP 必须用 scheme 源

**结论**：另实测两条工程事实（照原文）：

- `protocol.registerSchemesAsPrivileged` **可以调用两次**（`plugin-ui-protocol` 已为 `sk-plugin` 注册过一次），Electron 44 下不抛错、两次都生效。
- `sandbox=""` 的 iframe 里，CSP 用 **scheme 源**（`img-src sk-mail:`）能命中；用 `'self'` 不行 —— sandbox 下文档是不透明来源，`'self'` 匹配不上任何东西。

**取证**：同上探针（Electron 44）；`plugin-ui-protocol` 已为 `sk-plugin` 注册过一次。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 7. 落地方案：新增 `sk-mail://` 协议渲染正文，三层安全边界互不依赖

**结论**：新增 `electron/mail-body-protocol.ts`（`sk-mail://`），正文不再走 `srcdoc`。

**取证**：

| URL | 作用 |
| --- | --- |
| `sk-mail://body/<messageId>[?remote=1]` | 正文文档。cid 引用已改写为下面的 att URL；自带 CSP |
| `sk-mail://att/<messageId>/<attachmentId>` | 内联图片二进制（磁盘缓存优先，未命中才重拉原文，复用按需限流） |

三层安全边界，互不依赖：

1. 岛页面 CSP 只多一条 `frame-src sk-mail:`（放行"被嵌入"，不放开 img/connect/script）；
2. 正文文档 CSP：`default-src 'none'` + `img-src sk-mail: data:`（`?remote=1` 才加 `https: http:`）+ `script-src 'none'`；
3. iframe `sandbox=""` ⇒ 邮件 HTML 里的 JS 一律不跑。

**远程图**：正文文档 CSP 分两态 —— 缺省只放行 `sk-mail: data:`（防追踪像素），带 `?remote=1` 才加 `https: http:`；
岛侧那条「已加载 N 张远程图片 / 拦截远程图片」是一键切换。**默认值是放行**，理由与代价见 §14。
`sandbox` 的正文文档无法与岛通话，故计数由岛内基于 `detail.htmlBody` 自行判定。

**存量数据**：`content_id` 是后加的列，已同步过的邮件附件行补出来是空串，而**增量同步只处理新 UID**（正文已缓存的邮件不再进正文轮）⇒ 老邮件的内联图不会自己好。处理成**惰性回填**：`mail-message-get` 发现「正文含 cid 引用 ∧ 附件行一条 content_id 都没有」时重解析一次（判定见 `mail-html.ts` 的 `needsInlineBackfill`，6s 超时兜底，回填在后台继续）。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 8. `content_id` 不能进 `replaceMailAttachments` 的合并键

**结论**：**`content_id` 不能进 `replaceMailAttachments` 的合并键。** 该函数的合并键是 `filename+mime+size`，作用是**保留原 attachment_id**，否则重解析一次 id 就漂移，`sk_mail_attachment_cache` 索引与已落盘文件整批失效。content_id 是"后补的"，进键 ⇒ 老行（空值）被判成另一个附件 ⇒ 换 id ⇒ 缓存全废。正确做法：键不变，命中时**只在旧值为空时 UPDATE** 该列。

**取证**：已加离线冒烟守卫（变异：键里加 content_id → 3 项红）。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 9. 属性正则别用 `\b` 匹配 `src`

**结论**：**属性正则别用 `\b` 匹配 `src`。** `-` 也是词边界，`\b(src|...)` 会把 `data-src` 里的 `src` 认成同名属性并改写它（懒加载邮件大量用 `data-src`）。用 `(?<![-\w])`。

**取证**：已加单测守卫（变异：改回 `\b` → 2 项红）。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 10. 验证命令与结果（全绿清单）

**结论**：类型检查、verify、vitest、两个专项冒烟与 7 组变异复核全部通过。

**取证**：

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.electron.json --noEmit` | 通过 |
| `npx vue-tsc --noEmit` | 通过 |
| `npm run verify` | ✅ IPC 契约一致（未新增通道，`mail-handlers:24` 与改动前一致） |
| `npx vitest run` | 35 文件 / 605 用例全通过（含 `tests/mailHtml.spec.ts` 18 例、`tests/islandMailFrameCsp.spec.ts` 3 例） |
| `npm run mail:inline:smoke` | 15 项全通过（存量库补列 / id 稳定性 / 正文渲染 / CSP 两态） |
| `npm run mail:body:smoke` | 20 项全通过（真 handler + 真 DB + 真磁盘缓存 + 真 sandbox iframe；正文与内联图子资源都 200；远程图**默认零请求**、`?remote=1` 时真取到 200；岛 meta CSP 那一层单独复刻） |
| 变异复核 | 7 组（lookbehind · URL 反转义分支 · CSS url() 分支 · 合并键加 content_id · `UI_CSP` 去掉 `frame-src sk-mail:` · `UI_CSP` 默认态也放行远程图 · **岛 meta CSP 删掉 `frame-src sk-mail:`**），各自变红后已复原 |

> 顺带一条：把 `frame-src sk-mail:` 改坏时，`webRequest.onErrorOccurred` **不报**（只有"CSP 拦了 frame"本身），
> 所以协议冒烟里那条"无网络层错误"的断言名字已如实写成"网络层"，没有冒充 CSP 守卫。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 11. 第三次返工的首要原因：改的是仓库，跑的是旧的

**结论**：`sk-mail://` 那套代码写完、门禁全绿之后，用户回报"还是没展示出来"。真机取证发现：**岛一律从 `<userData>/plugins/` 加载**，仓库里的 `dist/` 只是待发布产物；不重装 = 用户看到的还是老代码，而且**没有任何提示**（旧岛照样能跑，只是图不显示）。所以"修岛"的最小闭环是 **改源码 → `vite build` → 拷进 `<userData>/plugins/<id>/`（manifest + dist 都要）→ 重启宿主**，四步缺一不可。

**取证**：

```
~/Library/Application Support/seller-kit/plugins/shop-accounts/   ← 2026-09-27 的产物
  dist/assets/index-CRYcNu2-.js        （grep sk-mail://body → 0 命中，仍是 srcdoc 版）
仓库工程岛 dist（该岛已于 2026-10-14 内迁删除，留档 `/tmp/sellerkit-retire/`）    ← 2026-10-04 20:35 的新产物
  dist/assets/index-BmM99qNk.js        （grep sk-mail://body → 1 命中）
```

取证手法（可复用，别省这一步）：`cp -cR "<真实 userData>" <临时目录>` 做克隆 →
`electron . --user-data-dir=<克隆> --remote-debugging-port=93xx` → 用 Node 内置 `fetch` + `WebSocket` 直驱 CDP。
**只有克隆才带真实邮件数据**，新建的隔离 userData 里一个邮件都没有，测不出这个问题。
发布到市场是另一条链，见 `2026-09-30-island-publish-runbook.md`（把岛发到市场：是四步不是一步）。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 12. 第四次返工：CSP 是取交集的，只改宿主那一层不够

**结论**：装上新岛后正文还是空白，原因是**两层 CSP 叠加生效**，CSP 的多重策略是**交集**，任一层缺这条就整个 frame 被拒。

**取证**：Electron 日志里才有这一行：

```
Failed to load URL: sk-mail://body/396?remote=1 with error: ERR_BLOCKED_BY_CSP
```

| 层 | 位置 | 当时的状态 |
| --- | --- | --- |
| ① 响应头 | `electron/plugin-ui-protocol.ts` 的 `UI_CSP` | 已加 `frame-src sk-mail:` ✅ |
| ② **岛自己的 meta** | 岛根 index.html 的 `<meta http-equiv="Content-Security-Policy">`（该岛已内迁删除；宿主侧对应层现为 `index.html`） | `default-src 'self'`，**没有 `frame-src`** ⇒ 回落到 `default-src` ❌ |

① 是上一步特意放开的，② 完全没注意到 —— **岛作者写 meta CSP 时只想着"能不能引 JS/图片"，不会想到 `frame-src`**。已给 ② 补上并加了守卫。Chromium 的原文（本次变异复现，一字不改）：

```
Framing 'sk-mail://body/' violates the following Content Security Policy directive: "default-src 'self'".
The request has been blocked. Note that 'frame-src' was not explicitly set, so 'default-src' is used as a fallback.
```

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 13. CSP 两层的两个连带教训：假绿的冒烟，与 meta CSP 的取值写法

**结论**：**两个连带教训**：

1. 冒烟里那条"宿主页带真 UI_CSP + iframe 能加载"是**假绿** —— 它只复刻了第 ① 层。现已把**岛的真实
   `index.html`** 读进来当第二层（`sk-host://page/island.html` 分支），删掉岛里那条指令立刻变红。
2. 解析 meta CSP 时**必须按引号配对**取 `content` 属性的值。CSP 内容里全是单引号（`'self'`），
   若把"值的字符类"写成『排除引号』那种写法（排除双引号也排除单引号），会在第一个 `'` 处截断、
   只拿到 `default-src ` —— 守卫于是**恒绿**。正确写法：双引号与单引号各自成套匹配（外层引号决定内层边界）。
   （本轮真踩了：守卫第一次跑就"通过"了，实际是取值取空了。）

**取证**：`sk-host://page/island.html` 分支；守卫第一次跑"通过"但取值取空。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 14. 远程图默认放行（产品默认值修正，不是 bug 修复）

**结论**：放行开关原本默认"拦截"（防追踪像素），但真机一量：这个收件箱的正文图**全是远程图**，默认拦截的净效果就是"打开任何一封都是空白"，`cid` 那套修复对本机数据一图未救。改成**默认放行**（与主流邮件客户端一致），把"防追踪"降级为一次点击（正文上方那条「已加载 N 张远程图片 / 拦截远程图片」），并**不再按邮件重置**（它是用户偏好，不是每封邮件的状态）。

**取证**：

```
sk_mail_bodies: 103 封有 <img>，103 封是 http(s) 远程图，含 cid: 的 0 封
sk_mail_attachments: 0 行
```

`?remote=1` 与默认态的差异已由 `npm run mail:body:smoke` 第 4 节双向锁住（默认零请求 / 放行真取到 200）。

> ⚠️ 本条是**产品默认值**改动，不是 bug 修复：如果以后要改回默认拦截，改
> `src/modules/mail/MailInboxView.vue`（2026-10-14 内迁为基础数据页、2026-10-17 随「邮件」独立成一级模块搬到现路径）的 `showRemote` 初值即可，
> 冒烟与守卫都不依赖这个初值。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 15. 真机验收：`loaded == total` 才算真能看见图；`http:` 图不会被混合内容拦

**结论**：真机 + 真实 userData 克隆 + CDP 直读 `sk-mail` 文档里的 `<img>`：`loaded == total` ⇒ 图真的解码出来了（`naturalWidth > 0`）。顺带证实 **`http://` 图不会被混合内容拦** —— `sk-mail` 虽是 `secure: true` 的 scheme，但 `sandbox=""` 的正文文档是不透明来源、不被当作"可信"，所以 `img-src ... http:` 放行就真能取到（84/103 封邮件用的是 http 图，这条必须实测，不能靠推理）。

**取证**：

```json
{"url":"sk-mail://body/414?remote=1","total":4,"loaded":4,
 "sample":[{"src":"https://img.alicdn.com/imgextra/...","nw":168},
           {"src":"http://ae.mmstat.com/global-message-platform-ae.edm.edm_open?...","nw":1}]}
```

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 16. 版本与发版状态：岛 1.6.0 已落本机，尚未发布到市场

**结论**：岛 `ui-plugins/shop-accounts` 已升到 **1.6.0**（新增正文渲染通道 = minor），并已**拷进本机
`<userData>/plugins/shop-accounts/`**（旧产物备份在 `/tmp/shop-accounts-backup-*`）。**尚未发布到市场**：`publish-plugin.js --base …` → 在 `market-out/` 里 commit+push → 用户机器同步，一步都没做。线上仍是 1.5.2，别的机器不会自动获得这个修复。另注：工作树里 `ui-plugins/shop-accounts/src/` 还有**别的在途改动**（「名下店铺」区块等），本次 rebuild 把它们一起打进了 1.6.0 产物 —— 真要发版前需要确认是否一并发布。

**取证**：线上 1.5.2；本机 `<userData>/plugins/shop-accounts/` 为 1.6.0 产物；备份 `/tmp/shop-accounts-backup-*`。

**源**：`2026-10-04-mail-inline-images`（2026-10-04）

---

## 17. 邮件账号挂在店铺行上，删行 = 删账号 + 全部缓存邮件（ADR-003 既定行为）

**结论**：**来处**：2026-10-25 用户报「当前项目中邮件功能不可用了，原来店铺中的邮箱设置也没有了，请修复」。
结论先行：**数据是被级联删除带走的**（可从合并前备份按邮箱恢复），**界面是冷启动没初始化**
（每行恒显示「未接入」、抽屉空表单），两件事叠在一起才让人以为"功能坏了 + 设置丢了"。

**邮件账号挂在店铺行上，删行 = 删账号 + 全部缓存邮件**（ADR-003 的既定行为）。
2026-10-22 物理合并会把"只有账号、没挂店铺"的 `sk_shop_sets` 行插成新的 `sk_shops` 行；
这些行与用户后来补齐的店铺行是**同一家店的两行**，最容易被当成重复行删掉 ——
而 `ON DELETE CASCADE` 会静默带走邮件账号、邮件正文与文件夹游标。
删除确认框只在 `hasMailAccount` 时写明级联范围（该字段取自真库、与界面初始化无关），
所以"没看到邮件相关提示"不能当作"这行没有邮件"。

**取证**：真库恢复前（`sk_mail_*` 全空、FTS 是旧残渣）：

```
accounts 0 | messages 0 | bodies 0 | folders 0 | fts 890 | meta fts_indexed_upto=1446
sk_shops(7,8,9): secret_keys=[] secret_enc=NULL
```

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 18. 谁读这个状态，谁就得负责初始化（`ensureAccountState()`）

**结论**：**谁读这个状态，谁就得负责初始化**。此前注释写着「这里 ensureReady 由 MailAccessDrawer 负责」，
但抽屉从来没调过 —— 冷启动直接落「基础数据」时邮件 store 是空的，于是
13 家店全是「未接入邮箱」、接入抽屉是空壳。现在拆出
`src/modules/mail/mailStore.ts` 的 `ensureAccountState()`：只拉 prefs / providers / accounts，
**不含**轮询与同步事件订阅（那是收件箱自己的事），单飞 + 失败可重试；
`src/modules/shop-accounts/MasterDataView.vue` 挂载时调用，
`src/modules/shop-accounts/components/MailAccessDrawer.vue` 打开时 await 后再填表单。

**取证**：冷启动实测（真库 APFS 克隆）：

```
克隆冷启动进「基础数据」：三行「已接入 rich0910xx@163.com」，其余「未接入」
接入抽屉：chip=已接入 / 邮箱已填 / 授权码占位「留空表示保持不变」
「邮件」页：INBOX 851，851 封 · 上次同步 10-21；未读 825
```

**变异取证**（证明新断言不是恒绿）：把 `MasterDataView` 的 `ensureAccountState()` 调用与抽屉的 await
临时还原后重跑 `npm run master-data:ui`，两条断言同时红，且输出正是用户看到的现象：

```
FAIL 冷启动进本页就读到邮箱接入态 | titles=未接入邮箱 … | 未接入邮箱 …
FAIL 冷启动点开「接入邮箱」：已有配置被回填 | chip=missing | ph=在此粘贴 IMAP 授权码
```

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 19. 恢复只能按业务唯一键映射（`lower(trim(email))`）

**结论**：**恢复只能按业务唯一键映射**。迁移后店铺 id 变了（账号 1/2/3 → 店铺 9/8/7），
所以回灌 `sk_mail_accounts` 时用 `lower(trim(email))` 对到当前 `sk_shops`，
同时把备份里 `sk_shop_sets` 的 `secret_enc` / `secret_keys` 按同一邮箱取回（含 `mailAuthPwd`）。

**取证**：合并前备份 `sellerkit.db.bak-shop-merge-v1-20261022T060344`（同时是旧形状：有 `sk_shop_sets`）：

```
sk_mail_accounts: 1=rich091002@163.com, 2=rich091003@163.com, 3=rich09105@163.com（各挂旧 set 3/4/5）
sk_mail_messages: 851
sk_shop_sets(3/4/5).secret_keys 均含 mailAuthPwd
备份里的 sk_shops 7/8/9（十二店/十三店/十五店）**没有** shop_set_id ⇒ 账号是合并时新插的纯账号行
```

恢复后（真库）：

```
3 accounts / 851 messages / 851 bodies / 3 folder cursors ; foreign_key_check 为空
店铺行 9/8/7 的 secret_keys 含 mailAuthPwd（reveal 实测能解密）
```

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 20. 恢复后必须重置 FTS 游标（否则搜索恒空、列表却正常）

**结论**：**恢复后必须重置 FTS 游标**。真库里 `sk_mail_fts` 残留 890 条孤儿、`sk_mail_meta.fts_indexed_upto = 1446`；
恢复的邮件 id 最大 851 —— 游标不回零，增量回填会把它们**整批跳过**（搜索恒空，列表却正常）。
处置：`DELETE FROM sk_mail_fts` + 删 `fts_indexed_upto`，进邮件页时全量重建（实测 851 条）。

**取证**：`fts 890 | meta fts_indexed_upto=1446`；恢复的邮件 id 最大 851；全量重建实测 851 条。

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 21. 825 ≠ 851 是既有口径，不是丢信

**结论**：825 ≠ 851 是**既有口径**，不是丢信：未读 = `seen = 0 AND COALESCE(read_at,'') = ''`
（见 `electron/mail-db.ts` 的 `mailStats`）。备份里有 26 封 `seen=0` 但 `read_at` 已落。

**取证**：`INBOX 851，851 封 · 上次同步 10-21；未读 825`；`electron/mail-db.ts` 的 `mailStats`；26 封 `seen=0` 但 `read_at` 已落。

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 22. 前向守卫：boot 步三条、失败置空可重试、夹具词表

**结论**：

- `scripts/master-data-ui-smoke.mjs` **boot 步**三条：冷启动接入态（含"有邮箱但未接入"的反向样本）/
  抽屉回填 / 抽屉可关。⚠️ 必须留在 boot：后面的 mail 步骤会打开「邮件」页，那时 store 已就绪，
  断言挪过去就变成恒绿（这正是这个 bug 三个月没被冒烟抓到的方式）。
- `ensureAccountState` 的"失败置空可重试"是硬要求：建库/拉账号任一失败时不能让后续每次打开抽屉
  都吃一份缓存的失败结果（否则用户要重启应用才能恢复）。
- 夹具纪律：`MailAccountItem.status` 的合法词表是 `idle / syncing / error / paused`；
  冒烟夹具原本写了 `active`（不在词表里），已改 `idle` —— **夹具形状偏离真形状时，UI 的兜底分支永远测不到**。

**取证**：`scripts/master-data-ui-smoke.mjs` boot 步；夹具 `active` → `idle`。

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 23. 边界（本轮没有做）：不改级联设计、FTS 孤儿未修、备份之后的新邮件靠同步

**结论**：

- **不改 ADR-003 的级联设计**：删除店铺连带删邮件是既定语义，确认框已按 `hasMailAccount` 写明范围。
- **FTS 孤儿未修**：`sk_mail_fts` 由应用代码维护，店铺级联删邮件时不会走 `removeMailFtsByMessageFilter`，
  索引会留下孤儿（本轮手工清掉 890 条）。当前搜索按消息 id 关联，孤儿不会变成错误结果；
  将来若改成直接查 FTS，必须补删除路径或 join 回 `sk_mail_messages`。
- **备份之后的新邮件不在这里**：备份止于 10-21，10-22 之后的邮件靠 IMAP 同步（各账号游标一并恢复，
  会从断点继续收）。同步窗口外的历史按各账号 `syncDays` 执行。

**取证**：手工清掉 890 条孤儿；备份止于 10-21。

**源**：`2026-10-25-mail-restore-and-cold-start-init`（2026-10-25）

---

## 24. 「今天」四页各改了什么（一句话版）

**结论**：缘起：页签栏重设计被用户否决、整轮还原之后（裁定原话与边界见
`docs/notes/2026-10-30-ui-nav-and-tabs.md`），把**页签内的页面内容**按流程顺序过了四页。
拿货页 10-10 刚重做过三轮，本轮不动。

| 页 | 改法 |
| --- | --- |
| 导入订单 | 删页首说明段；空态 = 回执位预告（两行：选什么文件 / 导完留下什么）；成功只留回执、不发 toast |
| 归类核对 | 页头操作说明收成一行（≤ 80 字，守卫钉长度） |
| 算钱 | 内嵌藏「刷新」；空态去内部词、指向真入口；运价表 toast 改指「导入订单」 |
| 结算对账 | 同删「刷新」；零活动厂家不占行；删除确认按类型分叉；两处空态补出口 / 修步号 |

**取证**：逐页改动见 `CHANGELOG.md` 2026-10-11 段与各 `.vue` 注释。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 25. 「只列有账的厂家」——判据是"这是账，还是常态噪音"

**结论**：

- `reconciliation()` 是 **`FROM suppliers s`**（按厂家目录出全量 + 窗口内子查询求和）⇒ **没账的厂家
  也会返回**（`orderCount = 0 / paymentCount = 0`）。
- 真库 2026-10-11 实测：6 家厂家里 **5 家恒零** ⇒ 全列出来是常态噪音、不是"账"。渲染侧过滤：
  `rc.filter((r) => r.orderCount > 0 || r.paymentCount > 0)`。
- ⚠️ **连带效果：空态的触发形态变了** —— 从"表格没有行"变成"**厂家目录还在、窗口内全零**"。
  冒烟夹具 `__noRecon` 因此要**归零而不是清空**（清空 = 连厂家目录都没了，是另一种形态；
  真机上"空表"根本走不到，因为零行全被过滤掉了）。
- 断言要**同时**数"行数 = 2"与"无厂家 C"：只查"无 C"的话，"只显示前两行"这类错法也能蒙对。

**取证**：真库 2026-10-11 实测 6 家厂家里 5 家恒零；冒烟夹具 `__noRecon`。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 26. 删付款 vs 删退款的后果文案是**相反**的

**结论**：

- 口径：差额 = 拿货 −（已付 − 退款）⇒ **删付款 ⇒ 欠款回升；删退款 ⇒ 欠款减少**。
- 旧文案「（或「已退」）会同步减少，欠款随之回升」把两笔账糊成一句 —— 对退款**恰好是反的**。
- ⚠️ 断言要**三维**：讲到「已退」+ 方向是「减少」+ **不许出现「回升」**。前两条都满足时，
  最后一条才拦得住"两句糅一起"的旧写法（旧文案恰好同时含「已退」与「减少」，只查前两条会全绿）。

**取证**：旧文案原文「（或「已退」）会同步减少，欠款随之回升」。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 27. 「刷新」的单一来源：容器页头那个是超集（两页同一裁定）

**结论**：

- 算钱 / 结算对账两个内嵌面板各有一个「刷新」，而容器页头的 `bump()` 波及所有面板 ⇒ 删面板内的、
  留容器的。面板**只作为容器页签存在**时应把这一类"页级动作"让给容器。
- ⚠️ 冒烟判据按**用户可见的按钮文字数**（`button.textContent === '刷新'` 计数），**不按 `data-act`**：
  重复按钮的 data-act 叫 `rc-reload`，而 `[data-act="refresh"]` 选择器从来只命中容器那一个
  —— 拿它判**恒绿**，实测过。等按钮回到可点再数（loading 时显示「读取中…」，文字数出来会是 0）。

**取证**：`button.textContent === '刷新'` 计数；`[data-act="refresh"]` 只命中容器那一个（实测恒绿）。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 28. 空态里的"内部词"是第二类回归（§1.10）

**结论**：

- 算钱空态原写「（宿主自己会拆行入库，不需要装插件）」—— 把"为什么不用装插件"这种**内心戏**
  写到了用户面前。修法是换成用户视角的预告（"点「导入 Excel」→ 会得到什么，缺的怎么标"），
  并把"不出现「宿主」「插件」"钉成断言 —— 只是把「导入 Excel」找回来、文字里照样能把内部词抄回来。
- 同类：运价表缺失的 toast 原指向一个**装没装都不一定**的岛 ⇒ 改指宿主自己的「今天 › 导入订单」
  报价单入口（**指死路 = 没有出口**，对没装岛的用户那句引导是废话）。
- 顺带一条产品判断：**成功/未写入只留回执卡、不发 toast**。回执是常驻的、toast 是几秒即走的
  同一句话 —— 两张一起出现只是重复，且 toast 会盖右下角（错误路径仍发，回执装不下）。

**取证**：空态断言加 2 条词条件（宿主/插件），见 §31 的 `order-profit:ui` 记录。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 29. 步号这类"跨页复制的字"只能靠断言钉

**结论**：

- 六步→五步后拿货顺位从第 5 变第 4，本页空态文案漏改（**注释改了、界面没改，没有任何门禁看得见**）。
- 守卫方式 = 在空态断言里**同时查步号与出口名**（「第 4 步」+「拿货」），单查一个都可能被蒙对。

**取证**：断言同查「第 4 步」+「拿货」。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 30. 冒烟侧踩点：KeepAlive 带回视图状态、绝对计数被夹具污染、长度守卫是刻意的

**结论**：

- ⚠️ **保活会把视图状态带回来**：结算对账先测了「按店铺」，视图停在 shop；`rc-recon-none` 用例
  **只属于厂家视图** ⇒ 不先点回「按厂家」就永远等不到，会误报成"空态没实现"。凡 KeepAlive 面板的
  重置型用例，先显式把视图摆回目标态再触发。
- ⚠️ **绝对计数会被夹具污染**：厂家夹具加一家（厂C）就把「厂家不预选」的 `options.length === 3`
  顶红 ⇒ 改 `>= 3`。数"有几个"的断言能松就松，或改成相对计数。
- **长度守卫是刻意的**（归类说明 ≤ 80 字）：关键词（点名/颜色/保存/确认无误/回车）本身 ≈ 45 字，
  80 给"还能补半句实用提示"的余量；把原来那段 ≈110 字的解释抄回来**必然红**。这段的回归风险
  就是"又被人把解释抄回来"，长度是最省事也最准的判据。

**取证**：`options.length === 3` → `>= 3`；关键词 ≈ 45 字、原解释 ≈110 字、阈值 80。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 31. 计数与门禁（2026-10-11）

**结论**：本轮 `today:ui` 从 185 涨到 192；`order-profit:ui` 81 PASS 且本轮 +0 条断言；全量门禁绿；`.vue` 未动任何既有 `data-act` 名。

**取证**：

- `today:ui` 185 → **192**（+7：导入空态指引 / 归类说明长度 / 单个「刷新」 / 零活动厂家不占行 /
  删退款三维文案 / 店铺空态按钮 / 步号+出口）。
- `order-profit:ui` = **81 PASS**；本轮 **+0 条断言**、只给空态断言加了 2 条词条件（宿主/插件）。
  ⚠️ 基线旧记「64 项，2026-10-01」是陈旧快照（其后多轮追加载荷未同步计数），同日实测更正为 81。
- 全量门禁绿：lint 0 error · `verify` 191/191/187 · `verify:docs` · `vue-tsc` · `tsc -p tsconfig.electron.json` ·
  `vitest` 689 · `build` · `today:ui` 192 · `order-profit:ui` 81。
- `.vue` 未动任何既有 `data-act` 名（只删/改文案与内嵌可见性）⇒ 既有断言原样重挂。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 32. 仍未做

**结论**：「拿货」本轮不动（10-10 刚重做）；其余四页已过一轮，后续若用户再给口径按
`docs/notes/2026-10-30-mail-and-today-pages.md`（本文）§0 对照逐页更新。**页签栏不要再动**
（范围裁定见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`）。

**取证**：页签栏裁定原话与边界见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`。

**源**：`2026-10-11-today-pages-design`（2026-10-11）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-04-mail-inline-images.md` | 2026-10-04 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 / §13 / §14 / §15 / §16 |
| `2026-10-25-mail-restore-and-cold-start-init.md` | 2026-10-25 | §17 / §18 / §19 / §20 / §21 / §22 / §23 |
| `2026-10-11-today-pages-design.md` | 2026-10-11 | §24 / §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 |
