# 跨工具上下文共享：现状、缺口与契约

> 日期：2026-09-30 · 结论层第 1 条。触发问题："项目基线、记忆、文档是不是所有 AI 工具共享的？
> 装了 WorkBuddy / Qoder / Hermes，能不能在任何一个地方干完活都同步？"

## 结论（四句）

1. **基线、文档共享；记忆不共享。** 共享的只有三处：`AGENTS.md`（唯一规则源）、`docs/**`、`CHANGELOG.md`
   与 `CONTRIBUTING.md`。工具自己的会话记忆各自留在本机私有目录。
2. **没有任何工具会自动回写共享层。** 读侧通、**写侧全断** —— 同步只能靠"约定 + 提交"，不能靠工具自治。
3. 唯一的跨工具通道是根目录 `AGENTS.local.md`：它是**软链** → `.workbuddy/memory/MEMORY.md`，
   而入库的是软链本身、不是内容（`.gitignore` 显式忽略它）。它之所以存在，是因为 **Qoder 原生读
   `AGENTS.md` / `AGENTS.local.md` / `.qoder/rules/*.md`**（三者中 `.qoder/rules` 优先级最高），
   于是这条软链构成"WorkBuddy 写 → Qoder 读"的**单向桥**。
4. 因此本仓库新增 **§0 跨工具协作契约**（在 [`AGENTS.md`](../../AGENTS.md) 文件最前 —— 该文件超长，
   注入给模型时常被截断，写在末尾等于没写）：持久结论一律落 `docs/notes/` + `CHANGELOG.md`。

## 分层实况（2026-09-30 实测）

| 层   | 位置                                                                    | 入库 | 谁读得到                                 |
| ---- | ----------------------------------------------------------------------- | ---- | ---------------------------------------- |
| 规则 | `AGENTS.md` + `docs/**` + `CHANGELOG.md`                                | ✅   | 任何工具（WorkBuddy 注入、Qoder 原生读） |
| 结论 | `docs/notes/`                                                           | ✅   | 同上（本目录即为此而建）                 |
| 桥   | `AGENTS.local.md`（软链 → `.workbuddy/memory/MEMORY.md`）               | ❌   | Qoder 原生读；其它工具未经确认           |
| 草稿 | `.workbuddy/memory/`（WorkBuddy）、`~/.qoder/memory/`（Qoder 自动记忆） | ❌   | 各自工具                                 |
| 草稿 | `~/.hermes/memory_store.db`（SQLite，`memory.enabled=true`、限额 4000） | ❌   | Hermes                                   |

## 取证（可复现）

```bash
git ls-files | grep -E 'AGENTS|CHANGELOG|docs/'   # 入库的只有规则与文档
git check-ignore -v AGENTS.local.md               # → .gitignore:63 显式忽略
readlink AGENTS.local.md                          # → .workbuddy/memory/MEMORY.md
grep -n 'memory' ~/.hermes/config.yaml            # Hermes 记忆开关与字符上限
```

## 四个缺口（改之前必须先知道）

1. **写侧全断**：没有任何工具完成工作后会自动更新 `AGENTS.md` / `docs/`。过去靠"当轮 AI 被明确要求"，
   这不可持续 ⇒ 已固化为 §0 契约 + 反向守卫（见下）。
2. **记忆孤岛**：`MEMORY.md` 里那批东西（"跑冒烟前必须先 `tsc -p tsconfig.electron.json`"、发布口
   同版本换内容 `exit 1`、版本号是唯一更新判据…）只有 WorkBuddy 看得到。换工具开工 = 从零踩。
3. **软链换机器必悬空**：`AGENTS.local.md` 不入库且指向被忽略的路径 ⇒ 克隆后不存在该文件。
   注意 `verify:docs` **抓不到它**（不是文档里的引用），只能靠本说明留痕。
4. **无并发保护**：同一工作区两个工具同时写会互相覆盖，git 不会替你合。
   ⇒ **同一时刻只让一个工具写**（另一个只读）。

## 契约的机械化部分

- 写入口：`docs/notes/`（结论）+ `CHANGELOG.md`（变更史）。
- 守卫：`npm run verify:docs` 的 **④ 反向守卫** —— 校验
  `docs/notes/*.md` 命名合规（`YYYY-MM-DD-<slug>.md`）**且**在 `AGENTS.md` / `CHANGELOG.md` /
  `docs/README.md` / `docs/notes/README.md` 之一被索引；0 条笔记时打印"未验证任何内容"
  （扫描型守卫必须自证非空转，否则"零命中"与"通过"长得一样）。
- 顺带把 `.workbuddy` / `.codebuddy` / `.qoder` 加进脚本的 `NON_REPO_HEADS`：与 `node_modules` 同理，
  这些路径按设计不在仓库内，否则新克隆的机器上引用它们的文档一律报悬空。
