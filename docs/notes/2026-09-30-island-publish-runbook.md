# 把岛发到市场：是四步不是一步（可照抄的发布手册）

**结论**：`scripts/publish-plugin.js` 只写到**本地磁盘**；用户能拿到的东西在 GitHub 上。完整链条是
**① 打包（绝对 https base）→ ② 在 `market-out/` 里 commit + push → ③ 复核线上目录 → ④ 本机安装目录更新 + 重启宿主**。
少任何一步，结论都是"改了但用户看不到"。

## ① 打包（`--base` 决定用户从哪下载）

```bash
BASE=https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main
node scripts/publish-plugin.js --dir ui-plugins/<id> --base "$BASE" \
  --out market-out --catalog market-out/catalog.json
```

- `--base` 会被**原样**写进 catalog 的 `downloadUrl`，写错不报错、只会在用户那里 404。
- **本地联调线**（`--base http://127.0.0.1:8000`，配 `npm run market:serve`）与**对外分发线**
  **会互相覆盖同一条 catalog 条目**，绝不能混发。
- 同版本同内容 → 幂等放行（打印"同版本同内容…产物字节不变"）；**同版本不同内容 → exit 1 且产物一字未动**，
  正解是升 `manifest.version`（Vite 岛有 `package.json` 时两处一起改），不要加 `--force`。

## ② push 出去（这一步最容易漏）

```bash
git -C market-out add catalog.json <id>-<version>.zip
git -C market-out commit -m "market: <id> <version>"
git -C market-out push origin HEAD:main
```

`market-out/` **自带独立 git 仓**（`origin = SayakABC/SellerKitPlugin`），且被父仓库 `.gitignore` 忽略 ——
它不在 SellerKit 的版本控制里，**不 push = 没发布**，父仓库也不会替你保底。

> 2026-09-30 的实证：`market-out/` 里躺着 6 个岛 1.x 的 zip 与新版 catalog，而远端 `HEAD` 只跟踪
> `ae-profit 1.0.0/1.0.1`。线上目录长期只有 3 条，其中 `shop-accounts` 的 URL 是 `<BASE_URL>/…`
> （非 http → `electron/plugins-market-handlers.ts` 的 `isHttpUrl` **静默丢弃**，界面表现为"这个插件不存在"）、
> `order-insight` 指向 `http://127.0.0.1:8000/…`（用户机器上必然失败）、`shipping-rate`/`excel-copy`/`product-library`
> **完全缺席**。⇒ "市场里没有这个插件"要先怀疑**目录本身**，而不是怀疑岛。

## ③ 复核**线上**目录（不是本地那份）

```bash
curl -s https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json
```

判据：每条 `downloadUrl` 必须 `/^https:\/\//` 且不含 `127.0.0.1` / `localhost` / `<BASE_URL>`；
再逐条下载比对 `sha256`（下载线上 zip → 本地复算 → 与 catalog 里的值比）。

⚠️ **`raw.githubusercontent.com` 有 CDN 缓存（约 5 分钟）**：push 完立刻 curl 可能还是旧目录。
别据此判断"push 失败"——用 `git -C market-out log --oneline -1`、`git ls-remote` 确认远端已更新，等几分钟再 curl。
（宿主侧还有第二层缓存，见 [`2026-09-30-island-release-state-and-market-broken.md`](2026-09-30-island-release-state-and-market-broken.md) 与 `tests/marketCache.spec.ts`。）

## ④ 本机生效是另一步

`publish` ≠ 用户（包括自己）拿到新版。要在「插件中心」点更新（或把 `market-out/<id>-<v>.zip` 解到
`~/Library/Application Support/seller-kit/plugins/<id>/`），并**重启宿主** —— 宿主启动会预载"上次所在的岛"，
它的 iframe 文档持有旧产物，`pluginsScan` 即时可见**不等于**岛内已生效。

**判断"这个功能现在长什么样"，三个坐标都要看**：仓库 `ui-plugins/<id>/manifest.json` / 线上目录 / 本机已装目录。

## 仍待做（本次未动代码）

1. **发布口加守卫**：`publish-plugin.js` 写 catalog 时，每条 `downloadUrl` 必须 `isHttpUrl` 且 host 非回环，
   否则**直接失败**（宁可发不出去，也不要发一份装不上的目录）。注意：加硬失败会打断本地联调线，
   需同时提供显式的"本地允许"开关。
2. **丢弃要留痕**：`sanitizeCatalog` 丢掉条目时记下 id + 原因，让市场页能说"目录里有 N 条格式不合法"，
   而不是让用户以为"这个插件不存在"。

> 相关：`CHANGELOG.md` 的 `[Unreleased]`（本次发布记录）；
> `docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-A1/N1/N2；技能 `ui-island-authoring` §9.5.1。
