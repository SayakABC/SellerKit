# 岛的"改了没生效"有三个版本坐标：仓库 / 市场 / 本机已装

> **状态（2026-09-30 夜，同日）**：**市场已修复** —— 6 个岛用绝对 https base 重新发布并 push 到
> `SayakABC/SellerKitPlugin`（`3831453..d37367a`），线上目录 6 条的 `downloadUrl` 全部绝对 https 且非回环，
> 逐条 `sha256` 已核对通过（下载线上 zip 后本地复算）。
> **"改之前该做的两件事"（发布口守卫 / 丢弃留痕）仍待做**，见文末。
> 发布的可复用手册见 [`2026-09-30-island-publish-runbook.md`](2026-09-30-island-publish-runbook.md)。

**结论**（2026-09-30 实测）：

1. 同一个岛有**三个版本坐标**，任何"功能改了用户能不能看到"的判断都必须同时看三处：
   `ui-plugins/<id>/manifest.json`（仓库，= 你改的那份）、线上 `catalog.json`（市场，= 用户点安装会拿到的那份）、
   `~/Library/Application Support/seller-kit/plugins/<id>/`（本机已装 = **当前真正跑着的那份**）。
2. **三者可以差好几个版本**，且**市场当前基本不可用** —— 也就是说：改完代码 ≠ 用户能看到，甚至 ≠ 用户装得上。
3. ⇒ **"发布"不是一个收尾动作，而是改动链的一部分**：升版本 → `publish-plugin.js` → **把 `catalog.json` 一起推** →
   同步本机插件目录 → **重启宿主**。少任何一步，用户看到的都还是旧的。

## 取证（2026-09-30 夜）

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

线上目录只有 **3 条**，且三条都有问题：

- `shop-accounts` 1.0.0：`downloadUrl = "<BASE_URL>/shop-accounts-1.0.0.zip"` → **非 http/https**，
  被 `electron/plugins-market-handlers.ts:56`（`if (!isHttpUrl(downloadUrl)) return null;`）**静默丢弃**
  ⇒ 市场页里看不到它，且**没有任何提示**（"静默"是这里最坏的部分）。
- `order-insight` 1.0.0：`downloadUrl = "http://127.0.0.1:8000/…"` → 过了 `isHttpUrl`，但在**用户机器上**下载必然失败。
- `ae-profit` 1.0.1：GitHub raw，URL 可用；但本机已装 1.0.2 更高 ⇒ 市场判"无更新"。

**`shipping-rate` / `excel-copy` / `product-library` 三条根本不在线上目录里。**

⇒ 直接否决了 `UX_POLISH_PLAN.md` 的 `P1-1 首启引导（一键装齐 6 个岛）`：**它的前置条件（市场可用）不存在**。

## 为什么会这样（机制，不是疏忽）

- `scripts/publish-plugin.js` 写出的 `catalog.json`（`market-out/`）里，`downloadUrl` 默认是**本机地址**
  `http://127.0.0.1:8000/…`（配 `market:serve` 本地联调用）；`market-out/` 还带独立 git 仓库，
  推给市场前**需要人工改写成绝对地址**——这一步没有任何守卫。
- 主进程按设计只放行合法条目、**丢弃非法条目却不回报**，于是"目录写坏了"在界面上表现为"这个插件不存在"。

## 改之前该做的两件事

1. **发布口加守卫**：`publish-plugin.js` 生成 catalog 时，每条 `downloadUrl` 必须 `isHttpUrl`
   且 host 不得是 `127.0.0.1` / `localhost`，否则**直接失败**（宁可发不出去，也不要发一份装不上的目录）。
2. **丢弃要留痕**：`sanitizeCatalog` 丢弃条目时记下 id + 原因，让市场页能说"目录里有 N 条格式不合法"，
   而不是让用户以为"这个插件不存在"。

> 相关：`docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-A1/N1/N2；`docs/notes/2026-09-30-paid-license-enforcement.md`
> （同一类事实的另一面：岛是明文静态站点）；`AGENTS.md` 关于"岛改了要 build→升版本→发布→同步→重启"的约定。
