# 邮件正文里的图为什么一张都显示不出来

**日期**：2026-10-04（同日三次返工，本文已含全部四层原因）
**触发**：用户报「邮件收件箱里的图片展示不出来」→ 修完仍报「还是没展示出来」
**结论**：不是数据问题。**四层原因叠加**，前两层是渲染管线结构问题，后两层是"改完为什么不生效"与"默认值选错"：

| 层 | 原因 | 症状 |
| --- | --- | --- |
| ① 结构 | 内联图（`src="cid:..."`）没有映射键（附件表无 `content_id` 列） | 内联图全裂 |
| ② 结构 | 正文用 `iframe srcdoc` 渲染 ⇒ **继承岛 CSP** `img-src 'self' data:` | 远程图全被拦 |
| ③ 分发 | 代码修好后**岛没重装**（本机跑的还是旧产物） | 界面上一点变化都没有 |
| ④ CSP | 岛自己的 `index.html` 里那份 **meta CSP** 缺 `frame-src sk-mail:`（CSP 取交集） | 正文区**整块空白**，只在 Electron 日志里报 `ERR_BLOCKED_BY_CSP` |

主修法仍是**另起一个自带 CSP 的 `sk-mail://` 协议**渲染正文（见 §3），但**只做 ① ② 是不够的** ——
③④ 见 §6/§7，那是"改完看不见效果"的真实原因。

---

## 1. 结论（先看这里）

| # | 现象 | 根因 | 取证 |
| --- | --- | --- | --- |
| ① | 内联图（签名 logo、商品图，`src="cid:xxx@yyy"`）全裂 | `cid:` 是 MIME 的 Content-ID，浏览器不认这个 scheme；而 `sk_mail_attachments` **没有 content_id 列**，宿主无从把 `cid:` 换成真图片 | `electron/mail-db.ts` 原 schema 仅 `filename/mime/size`；`mail-engine.ts` 原解析未取 `a.contentId` |
| ② | 外链图（`https://...`）全裂 | 正文用 `<iframe sandbox="" :srcdoc="htmlBody">` 渲染，而 **srcdoc 文档继承父文档的 CSP**；父文档是 `sk-plugin://` 下的岛页面，CSP 为 `img-src 'self' data:` ⇒ 外链图一律被拦 | 见 §2 实测日志 |

**顺带澄清**：附件区的「预览」按钮走 `data:` URL（`mail-attachment-preview`），**不受影响**，它本来就正常 —— 用户说的"图"是正文里的图。

---

## 2. 取证：两条实测（可复现，不靠推断）

探针脚本（Electron 44 + `--no-sandbox --disable-gpu`）：`sk-plugin://` 页面注入与 `UI_CSP` 相同的 CSP，内嵌两个 iframe —— 一个 `srcdoc="<img src='cid:abc@x'>"`，一个 `src="sk-mail://body/7"`。

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

另外实测两条工程事实：

- `protocol.registerSchemesAsPrivileged` **可以调用两次**（`plugin-ui-protocol` 已为 `sk-plugin` 注册过一次），Electron 44 下不抛错、两次都生效。
- `sandbox=""` 的 iframe 里，CSP 用 **scheme 源**（`img-src sk-mail:`）能命中；用 `'self'` 不行 —— sandbox 下文档是不透明来源，`'self'` 匹配不上任何东西。

---

## 3. 落地方案

新增 `electron/mail-body-protocol.ts`（`sk-mail://`），正文不再走 `srcdoc`：

| URL | 作用 |
| --- | --- |
| `sk-mail://body/<messageId>[?remote=1]` | 正文文档。cid 引用已改写为下面的 att URL；自带 CSP |
| `sk-mail://att/<messageId>/<attachmentId>` | 内联图片二进制（磁盘缓存优先，未命中才重拉原文，复用按需限流） |

三层安全边界，互不依赖：

1. 岛页面 CSP 只多一条 `frame-src sk-mail:`（放行"被嵌入"，不放开 img/connect/script）；
2. 正文文档 CSP：`default-src 'none'` + `img-src sk-mail: data:`（`?remote=1` 才加 `https: http:`）+ `script-src 'none'`；
3. iframe `sandbox=""` ⇒ 邮件 HTML 里的 JS 一律不跑。

**远程图**：正文文档 CSP 分两态 —— 缺省只放行 `sk-mail: data:`（防追踪像素），带 `?remote=1` 才加 `https: http:`；
岛侧那条「已加载 N 张远程图片 / 拦截远程图片」是一键切换。**默认值是放行**，理由与代价见 §8。
`sandbox` 的正文文档无法与岛通话，故计数由岛内基于 `detail.htmlBody` 自行判定。

**存量数据**：`content_id` 是后加的列，已同步过的邮件附件行补出来是空串，而**增量同步只处理新 UID**（正文已缓存的邮件不再进正文轮）⇒ 老邮件的内联图不会自己好。处理成**惰性回填**：`mail-message-get` 发现「正文含 cid 引用 ∧ 附件行一条 content_id 都没有」时重解析一次（判定见 `mail-html.ts` 的 `needsInlineBackfill`，6s 超时兜底，回填在后台继续）。

---

## 4. 两个必须记住的坑

1. **`content_id` 不能进 `replaceMailAttachments` 的合并键。** 该函数的合并键是 `filename+mime+size`，作用是**保留原 attachment_id**，否则重解析一次 id 就漂移，`sk_mail_attachment_cache` 索引与已落盘文件整批失效。content_id 是"后补的"，进键 ⇒ 老行（空值）被判成另一个附件 ⇒ 换 id ⇒ 缓存全废。正确做法：键不变，命中时**只在旧值为空时 UPDATE** 该列。已加离线冒烟守卫（变异：键里加 content_id → 3 项红）。
2. **属性正则别用 `\b` 匹配 `src`。** `-` 也是词边界，`\b(src|...)` 会把 `data-src` 里的 `src` 认成同名属性并改写它（懒加载邮件大量用 `data-src`）。用 `(?<![-\w])`。已加单测守卫（变异：改回 `\b` → 2 项红）。

---

## 5. 验证命令与结果

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

---

## 6. 第三次返工的首要原因：**改的是仓库，跑的是旧的**（2026-10-04 追加）

`sk-mail://` 那套代码写完、门禁全绿之后，用户回报"还是没展示出来"。真机取证发现：

```
~/Library/Application Support/seller-kit/plugins/shop-accounts/   ← 2026-09-27 的产物
  dist/assets/index-CRYcNu2-.js        （grep sk-mail://body → 0 命中，仍是 srcdoc 版）
仓库工程岛 dist（该岛已于 2026-10-14 内迁删除，留档 `/tmp/sellerkit-retire/`）    ← 2026-10-04 20:35 的新产物
  dist/assets/index-BmM99qNk.js        （grep sk-mail://body → 1 命中）
```

**岛一律从 `<userData>/plugins/` 加载**，仓库里的 `dist/` 只是待发布产物；不重装 = 用户看到的还是老代码，
而且**没有任何提示**（旧岛照样能跑，只是图不显示）。所以"修岛"的最小闭环是 **改源码 → `vite build` →
拷进 `<userData>/plugins/<id>/`（manifest + dist 都要）→ 重启宿主**，四步缺一不可（发布到市场是另一条链，
见 [把岛发到市场：是四步不是一步](2026-09-30-island-publish-runbook.md)）。

取证手法（可复用，别省这一步）：`cp -cR "<真实 userData>" <临时目录>` 做克隆 →
`electron . --user-data-dir=<克隆> --remote-debugging-port=93xx` → 用 Node 内置 `fetch` + `WebSocket` 直驱 CDP。
**只有克隆才带真实邮件数据**，新建的隔离 userData 里一个邮件都没有，测不出这个问题（见 §8 的判据）。

---

## 7. 第四次：**CSP 是取交集的，只改了宿主那一层**（2026-10-04 追加）

装上新岛后，正文还是空白，Electron 日志里才有这一行：

```
Failed to load URL: sk-mail://body/396?remote=1 with error: ERR_BLOCKED_BY_CSP
```

原因是**两层 CSP 叠加生效**：

| 层 | 位置 | 当时的状态 |
| --- | --- | --- |
| ① 响应头 | `electron/plugin-ui-protocol.ts` 的 `UI_CSP` | 已加 `frame-src sk-mail:` ✅ |
| ② **岛自己的 meta** | 岛根 index.html 的 `<meta http-equiv="Content-Security-Policy">`（该岛已内迁删除；宿主侧对应层现为 `index.html`） | `default-src 'self'`，**没有 `frame-src`** ⇒ 回落到 `default-src` ❌ |

CSP 的多重策略是**交集**，任一层缺这条就整个 frame 被拒。① 是我上一步特意放开的，② 完全没注意到 ——
**岛作者写 meta CSP 时只想着"能不能引 JS/图片"，不会想到 `frame-src`**。已给 ② 补上并加了守卫。

Chromium 的原文（本次变异复现，一字不改）：

```
Framing 'sk-mail://body/' violates the following Content Security Policy directive: "default-src 'self'".
The request has been blocked. Note that 'frame-src' was not explicitly set, so 'default-src' is used as a fallback.
```

**两个连带教训**：

1. 冒烟里那条"宿主页带真 UI_CSP + iframe 能加载"是**假绿** —— 它只复刻了第 ① 层。现已把**岛的真实
   `index.html`** 读进来当第二层（`sk-host://page/island.html` 分支），删掉岛里那条指令立刻变红。
2. 解析 meta CSP 时**必须按引号配对**取 `content` 属性的值。CSP 内容里全是单引号（`'self'`），
   若把"值的字符类"写成『排除引号』那种写法（排除双引号也排除单引号），会在第一个 `'` 处截断、
   只拿到 `default-src ` —— 守卫于是**恒绿**。正确写法：双引号与单引号各自成套匹配（外层引号决定内层边界）。
   （本轮真踩了：守卫第一次跑就"通过"了，实际是取值取空了。）

---

## 8. 远程图默认放行（同一次返工里的默认值修正）

放行开关原本默认"拦截"（防追踪像素），但真机一量：

```
sk_mail_bodies: 103 封有 <img>，103 封是 http(s) 远程图，含 cid: 的 0 封
sk_mail_attachments: 0 行
```

⇒ 这个收件箱的正文图**全是远程图**，默认拦截的净效果就是"打开任何一封都是空白"，
`cid` 那套修复对本机数据一图未救。改成**默认放行**（与主流邮件客户端一致），
把"防追踪"降级为一次点击（正文上方那条「已加载 N 张远程图片 / 拦截远程图片」），
并**不再按邮件重置**（它是用户偏好，不是每封邮件的状态）。
`?remote=1` 与默认态的差异已由 `npm run mail:body:smoke` 第 4 节双向锁住（默认零请求 / 放行真取到 200）。

> ⚠️ 本条是**产品默认值**改动，不是 bug 修复：如果以后要改回默认拦截，改
> `src/modules/mail/MailInboxView.vue`（2026-10-14 内迁为基础数据页、2026-10-17 随「邮件」独立成一级模块搬到现路径）的 `showRemote` 初值即可，
> 冒烟与守卫都不依赖这个初值。

---

## 9. 真机验收（唯一能证明"用户真能看见图"的一步）

真机 + 真实 userData 克隆 + CDP 直读 `sk-mail` 文档里的 `<img>`：

```json
{"url":"sk-mail://body/414?remote=1","total":4,"loaded":4,
 "sample":[{"src":"https://img.alicdn.com/imgextra/...","nw":168},
           {"src":"http://ae.mmstat.com/global-message-platform-ae.edm.edm_open?...","nw":1}]}
```

`loaded == total` ⇒ 图真的解码出来了（`naturalWidth > 0`）。顺带证实 **`http://` 图不会被混合内容拦** ——
`sk-mail` 虽是 `secure: true` 的 scheme，但 `sandbox=""` 的正文文档是不透明来源、不被当作"可信"，
所以 `img-src ... http:` 放行就真能取到（84/103 封邮件用的是 http 图，这条必须实测，不能靠推理）。

---

## 10. 版本与发版状态

- 岛 `ui-plugins/shop-accounts` 已升到 **1.6.0**（新增正文渲染通道 = minor），并已**拷进本机
  `<userData>/plugins/shop-accounts/`**（旧产物备份在 `/tmp/shop-accounts-backup-*`）。
- **尚未发布到市场**：`publish-plugin.js --base …` → 在 `market-out/` 里 commit+push → 用户机器同步，
  一步都没做。线上仍是 1.5.2，别的机器不会自动获得这个修复。
- 另注：工作树里 `ui-plugins/shop-accounts/src/` 还有**别的在途改动**（「名下店铺」区块等），
  本次 rebuild 把它们一起打进了 1.6.0 产物 —— 真要发版前需要确认是否一并发布。
