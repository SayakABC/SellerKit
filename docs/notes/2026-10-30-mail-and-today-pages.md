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

## 33. 「不会自动收信」的根因是计时器放错了进程（2026-11-04）

**结论（现象 → 根因 → 修法）**：

- **渲染层轮询 ≠ 后台收信**。`mailStore.startPolling()` 只在 `MailView` 挂载
  （`ensureReady`）时启动 ⇒ 冷启动后不进「邮件」页就**一次都不拉**。本应用关窗口
  不退出（有托盘，见 `main.ts` 的 `window-all-closed`），后台挂着时更没有渲染层计时。
  这解释了"有时能收到、有时收不到"：只要进过一次邮件页，那次会话里就一直在跑。
- `electron/` 目录此前**没有任何 `setInterval`**：订单自动同步的设计是"启动时一次 +
  托盘手动"，明确不做常驻轮询。所以"邮件自动收信"这件事**从来没有真正存在过**，
  不是坏了。
- **计时搬主进程**（`electron/mail-scheduler.ts`），但**间隔的权威仍在渲染层**
  （`MailPrefs.pollMinutes`）—— 主进程只执行 + 缓存到 `sk_mail_meta.autoSyncMinutes`，
  缓存唯一的用途是"窗口还没加载完的那十几秒"也有值可读。双份计时会让同步频率翻倍，
  所以 `startPolling/stopPolling` 已整段删除。
- **新邮件判定用 id 段，不用未读数差值**：同步前取 `MAX(id)`，收尾取
  `COUNT(id > 基准)`。未读数差值会把"用户点开一封未读"算成负数、把"服务端标已读"
  算成 0；`id` 是 AUTOINCREMENT 单调递增，不受已读状态 / 清理任务 / 同秒插入干扰。
  `processed`（扫到的）与 `newCount`（新落库的）是两个量，别混用。
- **id 段必须再按账号过滤**（自测踩到）：多账号是并发同步的（`MAX_GLOBAL_CONNECTIONS`），
  只按 `id > 基准` 全局过滤时，A 还在同步期间 B 插进来的行会被 A 也算一遍 ——
  两个账号各弹一条通知、数字还是合并后的。故 `countMailMessagesAfter(id, accountId)` /
  `listMailMessagesAfter(id, accountId, limit)` 的 `accountId` 是**必填**，不做可选参数
  （可选就等于允许调用方漏掉它，而漏掉的表现是"数字变多"这种看起来合理的错）。
- **通知只在自动轮次发**：`autoRound` 集合记录本轮入队的账号，手动同步不进集合 ⇒
  不弹通知（用户就在界面前，弹了是噪音）。点通知 `showMainWindow()`，与订单自动同步
  同一套动作。
- **已知代价（接受）**：升级后首次冷启动缓存为空 → 按默认 10 分钟跑一轮；用户打开
  邮件页时会把本地真实设置（可能是 0 = 关闭）下发纠正。
- **仍未做**：点通知不会切到「邮件」模块（只把窗口拿出来）；侧栏没有未读角标。
  → 两项已在本日下一节 §34 补上。

**取证**：

- `electron/mail-scheduler.ts`（新增；`startMailScheduler` / `configureMailAutoSync` / `runAutoRound`）
- `electron/main.ts` 的 `app.whenReady` 段 —— 注入窗口钩子 + 启动调度（首轮延迟 15s）
- `electron/mail-engine.ts` 的 `runMailSync`：开头 `const sinceId = maxMailMessageId()`，
  `done` 事件带 `newCount`，并调 `onSyncSummary` 简报钩子
- `electron/mail-handlers.ts` 的 `mail-auto-sync-config`（渲染层 → 主进程单向下发）
- `src/modules/mail/mailStore.ts`：原 `startPolling/stopPolling` 已删，
  `ensureReady` 改为 `pushAutoSyncConfig()`，`setPrefs` 改间隔即重下发
- 门禁：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `verify` / `verify:docs` /
  `build` / `vitest run`（74 文件 1441 用例）全绿
- **真机（无界面）验收 12 项**：临时 Electron 脚本（`initDb` 指临时目录）跑
  「基准前后新增计数 / 同 UID 更新不计新增 / 并发账号不串号 / 间隔 0·5·越界·负数收敛 /
  落库可读 / 停止清排程」。这条链路**没跑**的一环是"真收到邮件后系统通知真的弹出"，
  需重启宿主、用真实邮箱收一封验证（macOS 还要给应用通知权限）。

---

## 34. 「点通知切到邮件」与侧栏未读角标：主进程 → 界面意图的单向下发（2026-11-04）

上一轮把计时搬进主进程之后，还留着两件"用户看不见结果"的事：点通知只把窗口拿出来（人可能
正停在别的模块上），侧栏也没有未读角标（邮件模块没被打开时它根本不存在，没人上报）。

### 为什么需要一条新的下发通道

两件事的**数据都在主进程**（未读数是 `mailStats().unread`，通知点击发生在主进程），
而**后果都在渲染层**。收件箱模块不在场时无法上报自己的状态 —— 让它上报的话，冷启动不进
邮件页就永远没有角标，而那恰恰是最需要它的时刻。

故新增 `electron/ui-bridge.ts`：`openModule(moduleId, action?)` + `pushNavBadge(moduleId, badge)`。
渲染层 `src/core/services/navBadge.ts` 只做登记表，`AppShell` 的 `navRows` 把它拼到模块行上。

### 四条踩点

- **`did-finish-load` 时 `webContents.isLoading()` 仍是 true**（要到 `did-stop-loading` 才翻转）。
  重放函数若照常判"加载中就不发"，整批重放会被**静默挡掉** —— 15 项端到端验收里 5 项红，
  改完才绿。修法：`send(channel, payload, force)`，只在 `flushUiBridge` 里传 `true`
  （事件名本身就证明页面已就绪：preload 在 document start 注册）。
- **不许丢消息**：窗口可能还没建 / 正在加载 / 已销毁。`ui-bridge` 保留最后一份状态
  （徽标按 moduleId 去重、打开意图只留一条），`did-finish-load` 重放。
  验收里专门跑了"无窗口时推 → 建窗口 → 自动重放"和"销毁后推 → 重开窗口 → 自动重放"。
- **渲染层订阅必须早于 `onMounted` 的第一个 `await`**：晚一步那批重放就收不到，
  表现为"侧栏没角标 / 点通知没反应"且**日志一条错都没有**。`tests/navBadgeWiring.spec.ts`
  用静态断言钉住这条顺序（`onOpenModule` 同理）。
- **`count: null` = 撤掉徽标，不是画 0**：未读清零时画一个"0"会让"没事了"和"还有 0 件"
  看起来一样。同一约定见 `SubNavItem.count`。收起态（48px 仅图标）退化为一个圆点 ——
  数字塞不下，但完全看不见更糟。

### 打开意图的语义

不走 `activateFromSwitch`（那是业务流跳转，会给 TitleBar 留一个「返回」到用户上次那页）：
点通知的语义是"带我去看新邮件"，不是"从这里出发再回来"。带 `action` 时复用
`switch-module` 通道（`await nextTick()` 后再派发 —— 目标模块的监听在它自己的 `onMounted` 里注册，
早派发会被静默丢掉）。

### 未读数的每个变化点都要推

`electron/mail-badge.ts` 的 `publishMailUnreadBadge()` 只读 `mailStats().unread`（与邮件页页头、
列表角标同一实现）。四处调用：同步收尾（`mail-engine` 的 done）、按 ids 已读 / 按账号或全部已读
（`mail-handlers` 两个分支）、清理超窗邮件、解绑账号。
**不做未读数 ±1 的增量推算**：读状态也可能是服务端改的（IMAP 只读，同步时才把服务端 `seen` 落库），
增量在这种场景下必然漂移。`tests/navBadgeWiring.spec.ts` 断言这四个推送点在位。

**取证**：

- `electron/ui-bridge.ts`（新）/ `electron/mail-badge.ts`（新）
- `electron/main.ts`：`setUiBridgeWindow` + `did-finish-load → flushUiBridge` + `openMailInbox`
- `electron/mail-scheduler.ts`：通知点击从 `showWindow` 改为 `openInbox`
- `electron/mail-engine.ts` / `mail-handlers.ts`：四处 `publishMailUnreadBadge()`
- `electron/preload.ts` / `src/types.ts` / `src/core/services/ipc.ts`：`onOpenModule` / `onNavBadge`
  （契约脚本的 `BROADCAST_EVENTS` 同步登记 `open-module` / `nav-badge`）
- `src/core/services/navBadge.ts`（新）/ `src/core/AppShell.vue`（模块行徽标 + 收起态圆点 +
  启动期暂存打开意图 + 订阅时序）
- 门禁：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `verify` / `verify:docs` /
  `build` / `vitest run` 全绿
- **真机端到端 15 项**（临时 Electron 脚本 + 真 preload + 临时库）：无窗口缓存 / 重放送达 /
  徽标数值与 `todo` / 未读归零推 `null` / 新增未读 → 1 / 带 action 原样送达 / 销毁后不抛且进缓存 /
  重开窗口自动重放
- **新增无头 UI 冒烟 `npm run nav:ui`**（15 条断言，假桥 + 无头 Chrome）：徽标真的画出来、
  待办色、`count:null` 撤掉、未登记模块不渲染、`open-module` 真的切到邮件、未知 id 不跳走、
  action 被转发成 `switch-module`、无未捕获错误。**做过变异测试**（抽掉 `...moduleBadge(...)`
  + 让 `applyOpenModule` 直接 return）：8 条断言变红，还原后全绿 —— 守卫不是恒绿的。

---

## 35. 「待办」视图：1423 封里只有 16 单值得看（2026-11-04）

**先有数据，才有这个功能**。本机 31 天 1423 封速卖通邮件按类型归并后：

| 类型 | 封数 | 要不要动手 |
|---|---|---|
| 新订单 / 风控通过 / 未付款关单 / 买家确认收货 | 591 / 317 / 256 / 197 | 流水通知 |
| 订单关闭（协议取消 22 + 卖家未发货 1） | 23 | 1 单要动手 |
| 纠纷·客诉·仲裁 | 18 | 15 单要核对 |
| 罚单（待申诉 → 申诉失败） | 2 | 1 单，直接扣钱 |

⇒ 需动手 16 单 / 参与判定 43 封 / 全库 1423 封。

**三条判定规则（只认主题）**：罚单（`申诉失败|举证不成立` 优先于 `罚单`）→ 卖家未发货关单 →
**未付款关单显式排除** → 纠纷处理结果 / 仲裁 / `Resolution for Order` → 通用「关闭」（协议取消，sev1）。
规则表**顺序敏感**：少了"未付款"那条排除项，256 封自动关单会落到通用「关闭」上把待办淹掉
（单测 `tests/mailTriage.spec.ts` 专门钉这一条）。

**订单号从哪来**：`风控通过 / 纠纷 / Resolution` 的主题里**没有单号**，只在正文
（`订单：1123620564922700`）。而正文里还有 `#CaseNo:1143809062350955#`、`Service No.` ——
同样是 15–16 位纯数字。取"第一个长数字"会稳定抓错，**且看起来完全正常**（长度对、不报错）。
所以正文兜底**只认带"订单/order"前缀的数字**，用前缀做结构性约束，而不是维护"哪些编号要剔除"
的黑名单（平台多一个字段就多一种噪声）。实测 43 封参与判定的邮件 **0 封无法归属**。

**按订单号合并，不按邮件列**：同一单会连着来「卖家未发货关单 → 罚单待申诉 → 罚单申诉失败」
三封（主题原文措辞是**"申诉失败"**，2026-11-05 用真库复查确认；规则表也只认这一族词），列成三条会把一条因果链拆成三件事。合并后每行显示最新状态 + `共 N 封`，点开是**最新那封**。
`severity` 取最新事件：3 有申诉期 / 2 已成事实待核对 / 1 仅知会（协议取消，默认折叠）。

**读时计算，不建派生表**：命中 ~43 行、实测 <20ms。落表会引入"原始邮件被 purge 后待办还在"
的漂移（同步窗口 30 天滚动，见 §33 的 purge 逻辑），而待办本来就该跟着原始邮件一起消失。

**踩点：纯函数不能和 db 同模块**。渲染层 `tsconfig.json` 把 `tests/**` 也纳入编译，
单元测试直接引用判定函数时，只要那个模块顶层 `import './db'`，就会把 `electron/db.ts` 拖进
渲染层工程 —— 那边是 ESM，`import Database = require(...)` 直接 `TS1202`；vitest 跑在 node 下
加载 Electron ABI 的 better-sqlite3 会 `ERR_DLOPEN`。故拆成
`mail-triage-rules.ts`（零 import，纯函数）+ `mail-triage.ts`（SQL，import db）。
**这是编译期就炸的错，比运行时静默错好排查得多** —— 但只有真去跑 `vue-tsc` 才看得见。

**UI**：待办区在筛选栏下方，`severity>=2` 常驻、`severity=1` 点「另有 N 单已了结」才展开；
有要动手的待办时**邮件列表默认收起**（否则待办被流水通知淹没），点「展开其余 N 封」放出来；
输入关键词时整个待办区让位（搜索是"我要找某封邮件"）。点待办行 = 打开该单最新那封，详情占满整行。

**取证**：

- `electron/mail-triage-rules.ts`（新，纯判定）/ `electron/mail-triage.ts`（新，SQL 归并）
- `electron/mail-handlers.ts` 的 `mail-todo-list`；`preload.ts` / `types.ts` / `ipc.ts` 三处声明
- `src/modules/mail/mailStore.ts`（`todos` / `todoActions` / `todoInfo` / `loadTodos`，
  只随 `accountFilter` 刷新，**不叠加**关键词/未读/文件夹）
- `src/modules/mail/MailInboxView.vue`（待办区 + `listCollapsed`）
- `tests/mailTriage.spec.ts`（18 条：规则顺序、未付款排除、CaseNo 陷阱、17 位串不截断、
  标签切分数字仍能取到）
- `scripts/mail-todo-ui-smoke.mjs` + `npm run mail:ui`（17 条断言）
- 真库验收 19 项（临时 Electron 脚本 + `/tmp` 克隆库）：单号格式、未付款不进、CaseNo 不误取、
  排序、同单唯一、事件正序、账号过滤
- **变异测试**：去掉"未付款"排除项 → 1 条红；正文允许裸号 → 2 条红；
  `todoActions` 去掉 severity 过滤 + 列表不收起 → UI 冒烟 5 条红。均还原后全绿
- 门禁：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest`（76 文件 1470 用例）

## 36. 待办「手工划掉」：判据是水位线，不是"永久屏蔽"（2026-11-05）

**为什么必须加**：待办的状态只由后续邮件推进。若平台对某些事项不再发终结邮件（或用户已在线下
处理完），那一行会永远留着，人只能靠"12 天前"自己判断 —— 待办区会慢慢退化成噪音。

**但"划掉"最危险的实现是永久屏蔽该订单**：罚单升级、纠纷判决这类后续进展会被静默吞掉，
用户以为已经没事，实际在扣钱。所以判据是**水位线**：

- 划掉时记下"那一刻最新那封邮件的 id"（`last_message_id`）；
- 只有 `latest.messageId <= 水位线` 才压住；一旦同单来了新邮件（id 更大）**自动浮出**，
  并标「有新进展」——这样"我刚划掉它怎么又回来了"有解释：不是划掉失效，是事情有新进展。

两个方向写反都是**静默**的：写成 `<` 会让"划掉的那封自己"漏出来（用户以为没生效，反复点）；
写成"永久"会吞掉后续进展。故单独提成纯函数 `isTodoSuppressed()` 并配单测。

**只落一张覆盖层表**：`sk_mail_todo_dismissed(todo_key, last_message_id, kind, dismissed_at)`，
**不复制待办字段**。待办本身是读时计算的派生结果，落派生表 ⇒ 30 天窗口 purge 掉原始邮件后
表里还留着，两套数据必然漂移（这是 §35「读时计算」的直接推论）。

**撤销入口必须有**（「已划掉 N 单」→ 展开 → 恢复）：划错一次就再也看不见，等于给待办加了个
永久静默的坑。界面细节：`@click.stop` 防止点「已处理」顺带打开正文；划掉后**重新拉一次**
而不是本地 -1，分组/计数/排序全在主进程。

**一处措辞纠偏**：§35 与验收夹具里曾写「罚单申诉未通过」，但规则表是
`/申诉失败|举证不成立|处罚已执行/`，真库复查主题原文为 `…罚单申诉失败`。自造措辞若被后来者
当成规则依据，会把"已处罚"降级成"待申诉（有申诉期）"（severity 3 vs 2）—— 已改正。

**取证与守卫**

- 老库平滑加表：在用户真库副本上 `ensureMailSchema()` 前后各数一次 → 0 → 1；加表前后待办
  都是 **38 单 / 43 封 / 0 封无法归属**（新字段不改变任何判定），划掉一单 → 37 单 + 1 已划掉，
  撤销 → 回到 38 单
- `tests/mailTriage.spec.ts` +5 条（`isTodoSuppressed`：相等压住 / 更早压住 / 更大浮出 /
  水位线 0 / 非数字入参）
- `npm run mail:ui` 17 → **27 条**（按钮存在、调 `mailTodoDismiss` 且带订单号与 `messageId`、
  `click.stop` 不打开正文、数字按主进程重算、已划掉入口/展开/恢复）
- 真机验收 **22 项**（临时 Electron + 临时库）：幂等重复划掉、单账号隔离、**同单新邮件浮出**、
  再次划掉 `resurfaced` 归零、撤销后空 key 报错、**邮件被 purge 后记号仍在且重建邮件仍能浮出**
- **变异**：`todoActions` 去掉 `!t.dismissed` + 去掉 `@click.stop` → UI 冒烟 2 条红；
  `isTodoSuppressed` 的 `<=` 改 `<` → 单测 1 条红。均还原后全绿
- 门禁：`tsc` / `vue-tsc` / `verify`（264 通道一致）/ `verify:docs` / `build` /
  `vitest`（76 文件 **1475** 用例）；`db:inventory` **66**（表 65 + FTS 1，业务表 62）

## 37. 「点待办看不全正文」是三条叠加：面板占高 / 双层滚动 / 同单邮件没有入口（2026-11-05）

**现象**：点一条待办，右侧正文只露出一小块，得在 iframe 里滚、外面还有一条滚动条。

**三条原因是叠加的，只修一条都还有残余**（读 `MailInboxView.vue` 得出）：

| # | 原因 | 取证 |
| --- | --- | --- |
| ① | 待办面板在详情**上方**且 `max-height: 42vh`，待办越多正文越矮 | 900px 窗口 10 单时正文 ≈216px，3 单时 ≈400px |
| ② | `.detail-body{overflow:auto}` + iframe `min-height:320px` ⇒ **内外双层滚动** | 320 的 iframe 塞进 230 的容器，外层出现滚动条 |
| ③ | `openTodo()` 只开 `t.messageId`（最新一封），`t.events` 里同单历史邮件**没有入口** | 罚单"通知 → 已受理 → 补材料"三封只能看一封 |

③ 最容易被漏掉：它看起来像布局问题，实际是**数据有、界面没入口**——`events` 早就在
`MailTodoItem` 里（§35 合并同单时就有了），只差一个时间线。

**改法：竖向堆叠 → 左右主从。** 左栏 300–360px 是队列（`待办` / `全部邮件` 两个模式，
取代旧版"待办面板 + 可折叠邮件列表"），右栏是**一张单据**：单据头（类型 + 可复制单号 + 时效 +
标记已处理）→ 同单邮件时间线 → 正文（唯一滚动区）→ 附件条。待办不再横在上面，
所以既不占正文高度，也不需要靠 `listCollapsed` 把邮件列表藏起来让位。

**身份仍只有一处**：右栏的"当前单据"由 `selectedId` **派生**
（`todos.find(t => t.events.some(e => e.messageId === id))`），不新开 `selectedOrderNo`。
两个细节都是坑：
- 只比 `t.messageId` ⇒ 点时间线第二封时单据头**整块消失**（它只等于最新那封）；
- 新开一份 `selectedOrderNo` ⇒ 与"选中邮件"迟早对不上（本仓已有三次同类实证）。

**动线对齐习惯**：划掉后**自动接下一条**（待办是队列，处理完接着下一个），并给 6 秒撤销；
「已处理」常显不藏 hover（沿用 §36 结论）；↑↓ / Enter / `D` 复用 `useRowNav`，
但这页没有能稳拿焦点的"表格"，所以挂在 `window` 上（`isKeyTarget` 已保证输入框内不抢键）。

**视觉三条**（深色主题下最容易白做）：
1. 选中不能只靠底色 —— `#22262e` 与 `#191c22` 只差 4%，实测看不出来；必须叠 inset 描边环 + 单号加粗；
2. 左边缘 3px **只表达紧急度**，选中不抢这条边（两个含义压在同一条线上会互相抵消）；
3. 邮件正文是浅色排版，深色界面里把它当"一张纸"（白底 + 圆角 + 描边 + 轻微投影），不反色。

**取证与守卫**

- `npm run mail:ui` 27 → **37 条**：新增「两个视图切换」「同一单 3 封出时间线且按时间升序」
  「点时间线第 1 封 = 载入那一封、单据头不变」「划掉后自动打开下一条（12 而不是 11）」
  「提示条上的撤销真的调 `mailTodoRestore`」；夹具给罚单那一单补成 3 封（13/14/11）
- **响应乱序**：桩里给 id=13 加 400ms 延迟，先点 13 再点 11，最终必须显示 11。
  这条守的是 `openMessage` 里新加的 `if (selectedId !== id) return` —— 没有它，
  后到的旧响应会盖掉新选中那封，界面表现为「点 A 显示 B」，不报错、也最难复现
- **变异**（三条新守卫逐条改坏）：去掉自动接下一条 ⇒ 「划掉后自动切到下一条」红；
  `activeTodo` 改成只比 `t.messageId` ⇒ 「换邮件不换单」红；去掉过期响应丢弃 ⇒
  「响应乱序时以最后一次点击为准」红（显示成 13 的主题）。均还原后全绿
- `master-data:ui` 仍全绿 —— 它没有待办夹具，靠"没有要动手的待办 ⇒ 默认落到全部邮件"
  这一条继续满足它对 `.mail-list .mail-item` 的断言
- 门禁：`vue-tsc` / `tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `build` /
  `vitest`（76 文件 1477 用例）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-04-mail-inline-images.md` | 2026-10-04 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 / §13 / §14 / §15 / §16 |
| `2026-10-25-mail-restore-and-cold-start-init.md` | 2026-10-25 | §17 / §18 / §19 / §20 / §21 / §22 / §23 |
| `2026-10-11-today-pages-design.md` | 2026-10-11 | §24 / §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 |
