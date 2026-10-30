# 岛发布与下架：20 条结论（蒸馏自 3 篇，2026-09-30 ~ 2026-10-01）

> **蒸馏笔记**：由 3 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：
> - `git show b5df35c:docs/notes/2026-10-30-island-publish-and-retire.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-publish-and-retire.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-publish-and-retire.md`

## 1. 发布是四步不是一步：`publish-plugin.js` 只写本地磁盘，用户拿到的东西在 GitHub 上

**结论**：`scripts/publish-plugin.js` 只写到**本地磁盘**；用户能拿到的东西在 GitHub 上。完整链条是
**① 打包（绝对 https base）→ ② 在 `market-out/` 里 commit + push → ③ 复核线上目录 → ④ 本机安装目录更新 + 重启宿主**。
少任何一步，结论都是"改了但用户看不到"。

**取证**：四步各自的命令与判据见 §4–§7；"少一步就看不到"的实测差额见 §2。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）

---

## 2. 同一个岛有三个版本坐标，任何"用户能不能看到"的判断都必须同时看三处

**结论**：

1. 同一个岛有**三个版本坐标**，任何"功能改了用户能不能看到"的判断都必须同时看三处：
   `ui-plugins/<id>/manifest.json`（仓库，= 你改的那份）、线上 `catalog.json`（市场，= 用户点安装会拿到的那份）、
   `~/Library/Application Support/seller-kit/plugins/<id>/`（本机已装 = **当前真正跑着的那份**）。
2. **三者可以差好几个版本**，且**市场当前基本不可用** —— 也就是说：改完代码 ≠ 用户能看到，甚至 ≠ 用户装得上。
3. ⇒ **"发布"不是一个收尾动作，而是改动链的一部分**：升版本 → `publish-plugin.js` → **把 `catalog.json` 一起推** →
   同步本机插件目录 → **重启宿主**。少任何一步，用户看到的都还是旧的。

**取证**（2026-09-30 夜）：

```bash
# ① 仓库版 vs 本机已装版
for f in ui-plugins/*/manifest.json; do node -e "const m=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log(m.name,m.version)"; done
for d in ~/Library/Application\ Support/seller-kit/plugins/*/; do node -e "console.log('$d', require('$d/manifest.json').version)"; done
```

实测差额（仓库 → 市场 → 本机已装）：

| 岛 | 仓库 | 市场 | 本机已装 | 后果 |
| --- | --- | --- | --- | --- |
| order-insight | **1.5.0** | 1.3.0 | 1.3.0 | C2（撤拣货页签）+ C4（设置拆分）+ S1/S2 全不可见 |
| shipping-rate | **1.3.0** | 1.2.1 | 1.2.1 | M6 运价表回迁不可见 |
| ae-profit | **1.1.0** | 1.0.1 | 1.0.2 | C9 收编不可见 |
| product-library / shop-accounts / excel-copy | 1.5.0 / 1.5.2 / 1.0.0 | 同 | 同 | 一致 |

```bash
# ② 线上目录（默认地址见 src/core/plugin/marketClient.ts:12-13）
curl -s https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json
```

**源**：`2026-09-30-island-release-state-and-market-broken`（2026-09-30）

---

## 3. 市场曾经坏在哪：线上目录只有 3 条且条目本身非法，机制是"丢弃不回报"

**结论**：线上目录只有 **3 条**，且三条都有问题；"市场里没有这个插件"要先怀疑**目录本身**，而不是怀疑岛。
⇒ 直接否决了 `UX_POLISH_PLAN.md` 的 `P1-1 首启引导（一键装齐 6 个岛）`：**它的前置条件（市场可用）不存在**。

> **状态（2026-09-30 夜，同日）**：**市场已修复** —— 6 个岛用绝对 https base 重新发布并 push 到
> `SayakABC/SellerKitPlugin`（`3831453..d37367a`），线上目录 6 条的 `downloadUrl` 全部绝对 https 且非回环，
> 逐条 `sha256` 已核对通过（下载线上 zip 后本地复算）。
> **"改之前该做的两件事"（发布口守卫 / 丢弃留痕）仍待做**，见 §8。

**取证**：

- `shop-accounts` 1.0.0：`downloadUrl = "<BASE_URL>/shop-accounts-1.0.0.zip"` → **非 http/https**，
  被 `electron/plugins-market-handlers.ts:56`（`if (!isHttpUrl(downloadUrl)) return null;`）**静默丢弃**
  ⇒ 市场页里看不到它，且**没有任何提示**（"静默"是这里最坏的部分）。
- `order-insight` 1.0.0：`downloadUrl = "http://127.0.0.1:8000/…"` → 过了 `isHttpUrl`，但在**用户机器上**下载必然失败。
- `ae-profit` 1.0.1：GitHub raw，URL 可用；但本机已装 1.0.2 更高 ⇒ 市场判"无更新"。

**`shipping-rate` / `excel-copy` / `product-library` 三条根本不在线上目录里。**

为什么会这样（机制，不是疏忽）：

- `scripts/publish-plugin.js` 写出的 `catalog.json`（`market-out/`）里，`downloadUrl` 默认是**本机地址**
  `http://127.0.0.1:8000/…`（配 `market:serve` 本地联调用）；`market-out/` 还带独立 git 仓库，
  推给市场前**需要人工改写成绝对地址**——这一步没有任何守卫。
- 主进程按设计只放行合法条目、**丢弃非法条目却不回报**，于是"目录写坏了"在界面上表现为"这个插件不存在"。

> 2026-09-30 的实证：`market-out/` 里躺着 6 个岛 1.x 的 zip 与新版 catalog，而远端 `HEAD` 只跟踪
> `ae-profit 1.0.0/1.0.1`。

> 相关：`docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-A1/N1/N2；`docs/notes/2026-10-30-electron-and-platform.md`
> （同一类事实的另一面：岛是明文静态站点）；`AGENTS.md` 关于"岛改了要 build→升版本→发布→同步→重启"的约定。

**源**：`2026-09-30-island-release-state-and-market-broken`（2026-09-30）

---

## 4. ① 打包：`--base` 决定用户从哪下载，写错不报错只 404

**结论**：`--base` 会被**原样**写进 catalog 的 `downloadUrl`，写错不报错、只会在用户那里 404。

```bash
BASE=https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main
node scripts/publish-plugin.js --dir ui-plugins/<id> --base "$BASE" \
  --out market-out --catalog market-out/catalog.json
```

**取证**：

- **本地联调线**（`--base http://127.0.0.1:8000`，配 `npm run market:serve`）与**对外分发线**
  **会互相覆盖同一条 catalog 条目**，绝不能混发。
- 同版本同内容 → 幂等放行（打印"同版本同内容…产物字节不变"）；**同版本不同内容 → exit 1 且产物一字未动**，
  正解是升 `manifest.version`（Vite 岛有 `package.json` 时两处一起改），不要加 `--force`。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）

---

## 5. ② push 出去：这一步最容易漏，不 push = 没发布

**结论**：`market-out/` **自带独立 git 仓**（`origin = SayakABC/SellerKitPlugin`），且被父仓库 `.gitignore` 忽略 ——
它不在 SellerKit 的版本控制里，**不 push = 没发布**，父仓库也不会替你保底。

```bash
git -C market-out add catalog.json <id>-<version>.zip
git -C market-out commit -m "market: <id> <version>"
git -C market-out push origin HEAD:main
```

**取证**：2026-09-30 的实证见 §3 —— `market-out/` 里躺着 6 个岛 1.x 的 zip 与新版 catalog，远端 `HEAD` 只跟踪
`ae-profit 1.0.0/1.0.1`，线上目录长期只有 3 条。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）

---

## 6. ③ 复核**线上**目录（不是本地那份），且 CDN 缓存不能当 push 失败的证据

**结论**：判据：每条 `downloadUrl` 必须 `/^https:\/\//` 且不含 `127.0.0.1` / `localhost` / `<BASE_URL>`；
再逐条下载比对 `sha256`（下载线上 zip → 本地复算 → 与 catalog 里的值比）。

```bash
curl -s https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json
```

**取证**：

- ⚠️ **`raw.githubusercontent.com` 有 CDN 缓存（约 5 分钟）**：push 完立刻 curl 可能还是旧目录。
  别据此判断"push 失败"——用 `git -C market-out log --oneline -1`、`git ls-remote` 确认远端已更新，等几分钟再 curl。
  （宿主侧还有第二层缓存，见 `2026-09-30-island-release-state-and-market-broken` 与 `tests/marketCache.spec.ts`。）
- 2026-09-30 夜复核实况：线上目录 6 条的 `downloadUrl` 全部绝对 https 且非回环，逐条 `sha256` 已核对通过（§3 状态块）。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）

---

## 7. ④ 本机生效是另一步：`publish` ≠ 用户（包括自己）拿到新版

**结论**：要在「插件中心」点更新（或把 `market-out/<id>-<v>.zip` 解到
`~/Library/Application Support/seller-kit/plugins/<id>/`），并**重启宿主** —— 宿主启动会预载"上次所在的岛"，
它的 iframe 文档持有旧产物，`pluginsScan` 即时可见**不等于**岛内已生效。

**判断"这个功能现在长什么样"，三个坐标都要看**：仓库 `ui-plugins/<id>/manifest.json` / 线上目录 / 本机已装目录。

**取证**：§2 的实测差额（`shipping-rate` 仓库 1.3.0 / 市场 1.2.1 / 本机已装 1.2.1）就是"`publish` ≠ 拿到新版"的证据；
三个坐标的路径见 §2 结论 1。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）

---

## 8. 发布链上仍待做的两件事：发布口加守卫、丢弃要留痕

**结论**（本次未动代码）：

1. **发布口加守卫**：`publish-plugin.js` 写 catalog 时，每条 `downloadUrl` 必须 `isHttpUrl` 且 host 非回环，
   否则**直接失败**（宁可发不出去，也不要发一份装不上的目录）。注意：加硬失败会打断本地联调线，
   需同时提供显式的"本地允许"开关。
2. **丢弃要留痕**：`sanitizeCatalog` 丢掉条目时记下 id + 原因，让市场页能说"目录里有 N 条格式不合法"，
   而不是让用户以为"这个插件不存在"。

**取证**：这两条正是 §3 里三条坏条目的直接成因（`<BASE_URL>` 被 `isHttpUrl` 静默丢弃、`127.0.0.1` 在用户机上必然失败、
默认 base 是本机地址且改写无守卫）。

> 相关：`CHANGELOG.md` 的 `[Unreleased]`（本次发布记录）；
> `docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-A1/N1/N2；技能 `ui-island-authoring` §9.5.1。

**源**：`2026-09-30-island-publish-runbook`（2026-09-30）、`2026-09-30-island-release-state-and-market-broken`（2026-09-30）

---

## 9. 下架 = 三处版本坐标一起清，不是一次 `rm`

**结论**：**下架 = 三处版本坐标一起清**（仓库 / 线上市场 / 本机已装）。只删仓库源码，用户那边
"市场里还装得到、已装的还在跑" —— 与发布需要四步是同一件事的两面。

| 坐标 | 位置 | 本次动作 | 复核命令 |
| --- | --- | --- | --- |
| 仓库 | `ui-plugins/<id>/` | 留档后删除（见 §10） | `git status --porcelain ui-plugins/` |
| 市场 | 线上 `catalog.json`（本地工作树 `market-out/catalog.json`，**自带 `.git`、被父仓库忽略**） | 删条目 → commit → **push** | 见下方两条 |
| 本机已装 | `~/Library/Application Support/seller-kit/plugins/<id>/` | 删除，**重启宿主** | `ls` 该目录 |

**线上复核（不能只看本地文件）**：

```bash
# 目录里应少一条、且剩 5 条
curl -sS https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json | head -c 400
# 该版本的 zip 应 404
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/product-library-1.5.0.zip
```

两条都过一次才算下架。

**取证**：

- ⚠️ raw CDN 有约 5 分钟缓存，**刚 push 完查到旧内容别急着判"push 失败"**。
- ⚠️ **raw 也可能整条不通**（`Connection reset by peer`）—— 那是链路问题、**不是 push 失败**；
  换镜像读同一份内容 + 用一个**对照文件**证明"能读到 200"，并**用 `git ls-remote origin main` 单独证 push**（见 §18）。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 10. `ui-plugins/<id>/` 可能根本没被 git 跟踪：先留档再删

**结论**：**`ui-plugins/<id>/` 可能根本没被 git 跟踪**（本次实测 `git ls-files` 为 0）。这种目录
`rm` **不可回滚**，要先留档再删。

**取证**：本次 `ui-plugins/product-library` 的 `git ls-files` 计数是 **0** —— 它的产物在别处被忽略、
源码目录从未 `git add`。这意味着：

- `rm -rf` **不是**"可以用 git 恢复"的操作，是真删；
- 沙箱下把目录搬到仓库外（`/Users/.../ _retired/`）或走 Finder/osascript 都可能被拦。

**可用做法**：先打 tar 备份并校验条目数，再 `mv` 进**仓库内、已被 .gitignore 的**留档目录
（本次用 `.workbuddy/retired/`）—— 不触发沙箱、可回滚、且不会污染 `git status`。
确认无需回滚后再删备份。

> 判据：**留档目录必须在 .gitignore 里**。否则它会被当成新文件进 `git status`，反而变成噪音源。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 11. 能力域可以删，判据是"有没有消费者"而不是"还有没有代码提到它"

**结论**：**能力域可以删，判据是"有没有消费者"，不是"还有没有代码提到它"**。内建页与宿主同进程、
够不到 `DB_OPS`，所以岛一下架，它独占的那几个域**立刻就是死权限面**。

**判据只有一条：还有没有消费者。** 两个前提要分别查证：

1. **岛侧**：下架的岛是唯一声明方 → 其余岛 `manifest.capabilities` 里不再出现该域
   （`tests/pluginTriage.spec.ts` 的双向守卫就是查这个）。
2. **宿主侧**：内建代码**结构上够不到** `DB_OPS`。该对象只经 `window.__sk` 桥暴露给 iframe 岛；
   内建页走的是自己的 `ipc.*` 通道。所以"宿主也在用这些表"**不构成保留理由** ——
   用的是**数据层**（`electron/*-db.ts`），不是**能力域**。

**取证**：本次删掉的 5 个域（`product` / `product-admin` / `product-image` / `product-supplier` / `shop-products`，32 个 op）
满足上述两条，于是：

- 删 `host.ts` 里的域定义，**就地留墓碑**（写明"数据层与 IPC 通道不动"），与 `picking` 域的处置一致；
- `npm run verify` 应显示 **IPC 契约零改动**（`preload` / `src/types.ts` / `src/core/services/ipc.ts` 三方未动）
  —— 这是"删的确实是权限面、不是通道"的可复核证据；
- 删守卫用例时，**同组的"自证"断言要换锚点**。本次 `pluginTriage` 的自证原本是
  `expect(domains).toContain('product')`；域一删，这条自证就变成"证明守卫是空转的"，
  必须改钉一个仍然存在的域（本次改 `order-insight`）。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 12. "体检变红"先怀疑判据：位置型选择器把布局当成了契约

**结论**：**"体检变红"先怀疑判据，别先怀疑产品**：位置型选择器（`aside > div`）把**布局**当成了契约，
布局一改就假红，而真正要断言的东西（面板渲染了没有）其实是好的。

**取证**：

- **症状**：`scripts/ui-island-smoke.mjs` 的「设置贡献」体检报
  `宿主自有设置分类没出来：分类导航=[] · 引擎表单=true`。
  同一份探测里 `hasEngineForm=true` 已经证明「识别」面板**渲染正常** —— 两条信息互相矛盾时，
  先信"能拿到的那条"。
- **根因**：判据写的是 `document.querySelectorAll('aside > div')`，而设置分类导航在**同期的
  可访问性改造**里已从 `div` 改成 `button`（"原先键盘不可达"）。选择器读到 0 个元素，
  **静默返回空数组**，报出来却像"功能没了"。
- **修法（两段）**：

  1. `src/core/components/SettingsModal.vue` 的导航按钮补**语义锚点**：
     `data-act="settings-cat"` + `:data-cat="cat.id"`（**只加属性**，文本与 class 一字不动 —— 见
     `2026-10-01-ui-visual-hierarchy.md` 的硬约束）。
  2. 判据钉在锚点上，且**断言分类 id**（`recognition`）而不是显示名（`识别`）：
     改名是文案调整，不等于功能缺失。

- **必须做变异复核**（否则修完不知道新断言是不是恒绿）：把 `data-act` 改名后重跑，
  应看到 `分类导航=[]` 并**变红**；还原后恢复绿。

> 通用规则：断言只用两类锚点 —— **语义属性**（`data-act` / `aria-label` / `data-*` 业务键）
> 与**可访问性角色**。**不要**用 `父 > 子` 的血缘/位置选择器：那是布局，不是契约。
> 这条在本仓已踩过多次（`aside > div`、`.oc-table` 撞统计行、`arr[0]` 当默认值）。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 13. 第一次实例 `product-library` 的门禁收口（本次实跑）

**结论**：一次下架必须让五条门禁同时绿，并留下"删的是权限面、不是通道"的可复核数字。

**取证**：

```bash
npx tsc -p tsconfig.electron.json   # ✅
npm run verify                      # ✅ IPC 契约一致（185/185/181，product-handlers:22 未变）
npm run verify:docs                 # ✅ 无悬空引用（新增 3 条有意缺失豁免）
npx vitest run                      # ✅ 33 files · 577 tests
npm run plugins:island:smoke -- --no-sandbox --disable-gpu   # ✅ 5/5 岛 + 设置贡献 + 重启恢复
```

`plugins:island:smoke` **不会自己起 vite dev server**：它连 `localhost:5173`，且 vite 在本机可能
只绑 IPv6 回环 —— 先确认端口在监听再跑，否则脚本会**静默 exit 0 且不给结论**。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 14. 第二次实例 `order-insight`：与第一次的两处差异，以及"同一目录里两种 git 命运"

**结论**：与 `product-library` 的"功能收回内建"同理，但触发方式不同 —— 用户要求把
「今天」做成**发货台**（一页七页签），三个占位页签（归类核对 / 拿货 / 结算对账）在同一晚
全部从岛收编进宿主。**六个步骤都内建之后，岛只剩「识别库 / 透视 / 明细」三个非每日动作的页**，
用户拍板**整体下架**（而不是走"拆 `purchase` 只读子域 + 岛发版"那条过渡路线）。

**取证**：

| | `product-library`（2026-10-01） | `order-insight`（2026-10-05） |
| --- | --- | --- |
| 仓库是否被 git 跟踪 | **否**（`git ls-files` = 0，`rm` 不可回滚） | **是**（19 个文件）⇒ 可用 `git rm` |
| 宿主侧能力域 | 5 个域 / 32 op | 1 个域 / **37 op**（当时仓库内最大） |
| 怎么删 | `rm -rf`（先留档） | `git rm -rf`（有 8 个 dist 文件带未提交改动 ⇒ **必须 `-f`**） |

⚠️ `git rm` 拒绝的理由是 `the following files have local modifications`。**能 `-f` 的前提是
留档 tar 是从"当前磁盘状态"打的**（不是 `git HEAD`）—— 否则 `-f` 会静默丢掉那 8 个文件的改动。
本次 tar 条目数 **21 = 19 个岛文件 + 1 个冒烟脚本 + 1 个单测**，逐个在 tar listing 里核过。

两个脚本/测试**没被 git 跟踪**（同一目录里两种命运）：
`scripts/order-insight-settings-ui-smoke.mjs` 与 `tests/orderInsightShopAtImport.spec.ts`
**既不在 `git ls-files` 里，也不在 `.gitignore` 的覆盖范围内** —— 它们只是从未 `git add`。
`git rm` 会报 `pathspec ... did not match any files`；**别据此以为"文件不存在"**，用 `ls` 核对后用
`rm -f`。⇒ 判据：**下架前先 `git ls-files <路径>` 逐条问"这个文件在不在版本控制里"**，
不能按目录一刀切（同一次下架里，目录内 19 个文件在、2 个不在）。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 15. 守卫抓到一个真 bug：设置页还在把用户指向已下架的岛

**结论**：删完跑全量单测，`tests/uxEntryNames.spec.ts`（悬空入口名守卫）报：

```
文案让用户去一个不存在的入口 ... + src/core/settings/RecognitionSettings.vue: 「订单归类」
```

**这不是守卫过期，是真问题**：`RecognitionSettings.vue` 里两句面向用户的文案仍写着
「订单归类」（"用于 Excel 导入后的款式/颜色识别（在「订单归类」里跑）"）。岛一删，这句话就把
用户指向一个不存在的入口。修法是改写文案指向**内建页**（`「今天」的「归类核对」页签`），
不是往白名单里加豁免。

**同一条守卫同时暴露了它的自证锚点过期**：`expect(islandNames()).toContain('订单归类')` ——
它是"证明守卫没空转"的那条，锚点正好落在被删的岛上 ⇒ 必须改钉仍存在的岛
（本次改 `店铺账号管家`）。**两者的处置方式相反**：文案是"改产品"，锚点是"改测试"，
别一起塞进豁免名单了事。

**取证**：报错原文见上方代码块；§11 记录了同一次下架里 `pluginTriage` 自证锚点改 `order-insight` 的同类处置。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 16. 文档悬空引用：先分"还成立的句子"与"历史记录"，豁免必须有理由

**结论**：`npm run verify:docs` 一次报 **12 条**，处置分两类：

- **句子还成立、只是路径过期** ⇒ **改写**（`DAILY_SHIPPING_FLOW_PLAN.md` ×3、
  `2026-10-05-shipping-console-tabs.md`、`2026-10-04-preload-payload-shape.md`、
  `DOMAIN_INTEGRATION_PLAN.md`、`PLUGIN_TRIAGE_PLAN.md`、baseline ~10 行）；
- **本身就是历史记录**（`CHANGELOG.md` 的"当时改了这个文件"、一份带日期的审查快照）⇒
  进 `DELIBERATELY_MISSING` **并写明理由**（本次 +4 条，49 → 53）。

**判据：豁免必须有理由、且理由是"这条引用在语义上就该指向一个已不存在的路径"**，
不是"懒得改"。

**取证**：本次 `verify:docs` 的收口结果见 §17（新增 5 条有意缺失豁免）。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 17. `order-insight` 的门禁收口，与两条"不是回归、是环境"的红

**结论**：全量门禁实跑结果如下；两条红要先认出来再下结论 —— 它们**不是回归、是环境**。

**取证**：

```bash
npx tsc -p tsconfig.electron.json   # ✅ 0
npx vue-tsc --noEmit                # ✅ 0
npm run verify                      # ✅ IPC 契约一致（删的确实是权限面、不是通道）
npm run verify:docs                 # ✅ 无悬空引用（新增 5 条有意缺失豁免）
npx vitest run                      # ✅ 36 files · 615 tests
npm run build                       # ✅ 0
# 5 个界面冒烟（goods / picking / order-profit / shipping-rate / today）  ✅ ALL PASS
# plugins:island:smoke                                                 ✅ 4/4 岛 + 设置贡献 + 重启恢复
# DB / 形状冒烟（order picking product product:sku shop style schema ae ae:settle ship-rate
#   plugins:sandbox picking:xlsx purchase:xlsx mail:inline ipc:shape mail:body）  ✅ 全 0
```

⚠️ 两条**不是回归、是环境**的"红"，都值得先认出来再下结论：

- `mail:smoke` **要真实 IMAP 凭据**（`缺少凭据：请设置 MAIL_USER / MAIL_PASS`）—— 这是它的正常形态，
  不是 DB 回归。
- 本机 shell **默认带 `ELECTRON_RUN_AS_NODE=1`** ⇒ `ipc:shape:smoke` / `purchase:xlsx:smoke`
  **自检拦下**（各给一行 `✗ 本冒烟必须用真 Electron 运行`），`mail:body:smoke` 则直接
  `Cannot read properties of undefined (reading 'setPath')`。**加 `env -u ELECTRON_RUN_AS_NODE` 后三条全 0。**
  ⚠️ 判据：**看到"`app` undefined / setPath 报错"先想这个环境变量**，别去查主进程代码。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 18. `push` 卡住 ≠ 下架没做完，但也别急着判"push 失败"：只有 `ls-remote` 能证 push

**结论**：本次 `git -C market-out push` **连试多次失败**（`Failed to connect to github.com port 443` /
`Operation too slow. Less than 1000 bytes/sec`），一度按"未完成"记了账；**稍后重试即成功**：

```
279ee07..4482d57  main -> main
```

**两条复核路径别只认一条**：

| 要证的事 | 命令 | 本次结果 |
| --- | --- | --- |
| push 真的上去了吗 | `git -C market-out ls-remote origin main` | `4482d57…` ✅（**这是 push 的权威判据**，git 只在远端接受后才打印 `..main -> main`） |
| 线上内容真变了吗 | 读 `catalog.json` / 探 zip 的 HTTP 码 | 4 条 / zip **404** ✅ |

**取证**：⚠️ **读线上内容时 `raw.githubusercontent.com` 可能不通**（本次 `curl` 是
`Recv failure: Connection reset by peer`、Node `fetch` 是 `fetch failed`，**而 github.com 的 git 通道是通的**）。
此时换**镜像**读同一份内容即可（本次用 `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<file>`，
目录 200 且 4 条、`order-insight-1.5.0.zip` **404**），并配一个**对照文件**证明 404 不是"整体不可用"
（本次 `shipping-rate-1.3.0.zip` 返回 200）。
⇒ **"raw 读不到"不是"push 失败"的证据**：前者是链路问题，后者只有 `ls-remote` 能证。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 19. 下架删不到的东西：宿主侧孤儿代码，判据是可达性而不是"名字像没人用"

**结论**：下架删掉的是岛（`ui-plugins/<id>/`）、能力域与市场条目，
但**专为它写在宿主里的纯函数不会自己消失**。它们不报错、还各自带着自己的单测 ——
`tsc` / `vue-tsc` / `vitest` / `verify` / `verify:docs` **全绿也照样看不见**。
`order-insight` 下架后隔了一天才发现：`aggregator.ts`（`src/lib/` 下，313 行，岛「透视」页的引擎）
与它的 30 个用例还完整地待在仓库里。

**判据不是"看名字像不像没人用"，而是可达性**：从渲染层入口
（`src/main.ts` + `modules.config.json` 的 `enabledModules` 各自 `meta`/`index`）出发遍历 import 图，
列出**入口到不了**的文件。脚本：`.workbuddy/tools/orphan-scan.mjs`（私有草稿区，只做报告不删东西）。

**取证** —— 三类"零引用"要分开验，别只信 import 图：

| 形态 | 例子 | 扫描器看得见吗 |
| --- | --- | --- |
| 静态 / 动态 import | 绝大多数 | ✅ |
| **带查询串的 import** | `import src from './sandboxRuntime.ts?raw'` | ❌ **假阳性重灾区**（Vite 的 `?raw` / `?url` / `?worker`）—— 本脚本已按 `?` 截断，**但每次新增 Vite 专有后缀都要同步** |
| 按路径字符串读文件 | `scripts/*-smoke.mjs` 里 `fs.readFileSync('src/.../x.ts')` | ❌ 不是 import，图里看不见 ⇒ **判定前必须再 grep 一遍文件名** |
| 拼接出来的路径 | ``import(`./views/${n}.js`)`` | ❌ 无法静态解析 |

**本次实测**：扫出 4 个"不可达"，其中 `sandboxRuntime.ts` 是**假阳性**（`?raw` 注入 + 冒烟脚本按路径读），
真孤儿只有 2 个。**"工具说没人用"≠"没人用"**：4 个候选逐个 grep 过才动手。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 20. 孤儿的判定、删除纪律与连带文档：通用原语不随一次下架带走

**结论**：**"不可达"里要再分一层"是这次下架的产物吗"**。通用原语、脚手架、平台能力即使当前零引用，
也不该由一次下架顺手带走；留下的**要在表里写明为什么留**（否则下次扫描又得重推一遍）。

**取证** —— 判定与处置（本次对照表）：

| 文件 | 判定 | 依据 |
| --- | --- | --- |
| `aggregator.ts`（`src/lib/` 下）+ 其 spec | **删** | 两个调用方（宿主 `PivotPanel.vue`、岛的透视页）都已下线 ⇒ 只剩自己的单测引用 |
| `templateEngine.ts`（`src/lib/` 下）+ 其 spec | **删** | 唯一消费者 excel-copy 下记为岛后**岛自带副本**；删除早经 `PLUGIN_TRIAGE_PLAN` §C 预授权 |
| `src/core/layout/SplitPane.vue` | **保留待定** | 确无引用，但它是**基线期的通用布局原语**、不是下架产物，且 4 处文档快照正在说"它已落地" ⇒ 与本轮无关，**单独再定** |

删除的纪律（与 §10 同源，别省）：

- **先留档当前磁盘状态**再删（`.workbuddy/retired/orphan-code-<日期>/`）。本次 `git rm -f` 是必需的 ——
  `aggregator` 的那条单测**带未提交改动**，而 `-f` 的前提正是"留档打自当前磁盘"。
- 删完**核对测试数减法**：本次 `36 files / 615 tests` → `34 files / 569 tests`，正好是 −2 文件 / −46 用例。
  **数字对得上才算删干净**（对不上说明删错了文件或有别的 spec 被连带）。

连带要改的文档/注释（`verify:docs` 会一条条点出来）：

1. `AGENTS.md` **§4.4「底层公共工具」清单** —— 删掉的那条要摘出来（本次：`templateEngine`）。
2. `AGENTS.md` **§6.3 那条"类型标必填、运行时却有兜底"** —— 举例的模块被删了 ⇒
   **改成无例子的纪律陈述**，别把例子一起带走（教训比例子值钱；同类：任何"以某文件为例"的段落）。
3. **历史计划文档**（`PLUGIN_TRIAGE_PLAN` / `REMEDIATION_PLAN`）：句子在说"计划要删它" ⇒ 标 ✅ 收口；
   在说"当时的验收" ⇒ 就地注明"此后已删除、不复可做"。**别改写成现存路径**（那就变成假陈述了）。
4. **仍然在役的岛**若在自己的 `dist/` 注释里引用了被删的宿主文件（本次 excel-copy 的
   `dist/util.js` 写着"与宿主 `src/lib/templateEngine.ts#renderTemplate` 语义一致"）—— 改述为"本副本是当前唯一实现"。
   ⚠️ 后果：**仓库产物与市场已发布的 zip 在注释层面不再逐字节相同**。功能零改动 ⇒ **不升版本、不重发**；
   但下次真发布该岛时会撞上 `publish-plugin.js` 的"同版本换内容 → exit 1"，**那时按规矩升版本、别 `--force`**。
5. 基线（`PROJECT_BASELINE.md`）：`src/` 文件数 / 行数、**`vitest` 的文件数与用例数**都要跟着动
   （按文件里给的复现命令重扫，别手改数字）。
6. `scripts/check-doc-links.mjs` 里若拿被删文件当**示例路径**（本次第 18 行拿 `aggregator.ts` 当
   "仓库根相对"的样例），换成现存文件即可 —— 这类"示例"也是引用，守卫照样算。

**源**：`2026-10-01-ui-island-retirement`（2026-10-01）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-09-30-island-publish-runbook.md` | 2026-09-30 | §1 / §4 / §5 / §6 / §7 / §8 |
| `2026-09-30-island-release-state-and-market-broken.md` | 2026-09-30 | §2 / §3 / §8 |
| `2026-10-01-ui-island-retirement.md` | 2026-10-01 | §9 / §10 / §11 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 / §20 |
