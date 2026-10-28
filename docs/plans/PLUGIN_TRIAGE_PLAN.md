# 内置插件盘点与处置方案（PLUGIN_TRIAGE_PLAN）

> **状态**：🟢 已完成 —— T1（`order-insight` 下记）✅、T2（`quick-note` 保留）✅、T3（`excel-copy` 转 UI 岛）✅、T4/T5（脚手架归位 + 文档回写）✅、T6（`sk-ui-starter` 删除）✅、示例外置插件 `sk-hello` 下架 ✅（均 2026-09-24）
> **生成日期**：2026-09-21（2026-09-22 / 2026-09-24 更新执行记录）
> **依据**：`docs/baseline/PROJECT_BASELINE.md`、`AGENTS.md` §1.8/§1.9/红线 23、`docs/reviews/CODE_REVIEW_REPORT.md`（P1-5）、`docs/plans/REMEDIATION_PLAN.md`（R1-5 先例）、`docs/features/PROFIT_TRACKER.md` §10 D1'
> **目标**：清理无用内置插件，把有用内置插件转为市场分发的 UI 岛

---

## 0. 执行记录（关键里程碑与决策）

- **T1（2026-09-21）**：`order-insight` 从 `standard` / `pro` 下记，`modules.config.json` 移除；id 释放，市场同名岛可注册。岛 **1.0.1 → 1.1.0**（命名空间级 store、列映射/分组维度读写、设置页列映射面板、修握手时序与 `DEFAULT_ENGINE.model` 拼写）。新增 `tests/pluginTriage.spec.ts`（10 例）守卫：预设 ∩ 岛 id = ∅、注册表不含岛 id、岛 db op ⊆ manifest 声明、`manifest.name` = 目录名。
- **T3（2026-09-22）**：`excel-copy` 从 `minimal` / `standard` / `pro` 三预设下记（它是 `minimal` 唯一成员）；宿主新增 `excel-copy` db 能力域（7 个 op：`parseExcel`/`parseExcelBuffer`/`applyRules`/`readTextFile`/`readDefaultTemplate`/`checkFileExists`/`saveTemplateFile`，带消毒与条数上限）；新建手写岛 `ui-plugins/excel-copy` 1.0.0（无构建步骤、零 npm 依赖、2 页签，与内建共用 `modules.excel-copy` 自动继承模板/规则/显示列/记录状态）。守卫增至 27 例。顺带修 2 个连带缺陷：① `vite.config.ts` 生成 `settingsPanelLoaders` 时空列表把闭合括号注释掉 → 不含 extensions 视图包即编译失败；② `profiles` 取值用 `||` 使"空预设"无法表达，改为 `??`。
- **T4（2026-09-22）**：脚手架归位 —— `git mv extensions/_template → scripts/templates/l2-plugin`、`sk-hello → scripts/templates/l2-demo`，脚本 `plugin-create.js` / `plugins-install-demo.js` 重指向并实跑验证；连带同步 `module-roots.cjs` / `publish-plugin.js` / `AGENTS.md` / `PLUGIN_ARCHITECTURE.md` / `PLUGIN_DEVELOPMENT.md` 旧路径。
- **T5（2026-09-22）**：文档回写 —— `README.md` 核心能力表、`PROJECT_BASELINE.md` §2/§3/§4/§6、`AGENTS.md` §1.8/§1.9、`docs/README.md` 索引、`CHANGELOG.md`。
- **T6（2026-09-24）**：`sk-ui-starter` 删除（用户拍板）—— 全量清场：源码包 `git rm -r`、市场 `sk-ui-starter-0.1.0.zip` + catalog 条目、本机 `<userData>/plugins/sk-ui-starter` 移废纸篓；脚手架保留在 `scripts/ui-plugin-template`。
- **示例外置插件下架（2026-09-24）**：`sk-hello` 本机副本移废纸篓；市场仓（独立 git 仓，远端 `SayakABC/SellerKitPlugin`）删 zip + catalog 条目并 commit & push；源码脚手架 `scripts/templates/l2-demo` 保留（是 `plugins-install-demo.js` 的 `SOURCE` 硬编码目标）。
- **dev 种子 UI 岛下架（2026-09-24）**：`sk-ui-hello` 从未进市场，本机副本移废纸篓、种子包 `scripts/poc-ui-hello/` 删除、**播种链路一并移除**（`plugin-ui-protocol.ts` 的 `UI_POC_ID`/`seedDevPocPackage`/`ensurePocPackageSeeded` + `main.ts` 调用）。能力面零变化。
- T2：`quick-note` 用户决定**先保留**。

**下记 ≠ 删除。** 宿主侧 `electron/order-db.ts` 与 db 能力域 `order-insight` / `purchase` 原样保留（岛照常调用）；`extensions/order-insight/` 源码暂留作算法参考，仅不进构建。

### 岛的功能缺口：已清零（2026-09-22，1.2.0）

内建版有、岛曾缺失的 op —— 宿主 `DB_OPS` 一直就绪，缺的只是岛侧交互：

| op | 内建对应功能 | 1.2.0 岛内入口 |
|---|---|---|
| `purchase.orderGet` / `orderUpdate` | 拿货单查看与编辑 | 拿货单 → 查看/编辑 → 自管 DOM 模态 |
| `purchase.priceHistory` | 供应商价格历史 | 编辑器内「取最近价」+ 填完款色自动回填 |
| `purchase.ignoreRemove` | 待拿货缺口「取消忽略」 | 缺口页新增「已忽略」表 + 取消忽略 |
| `purchase.shopAllocation` / `shopAllocationDetail` | 店铺分摊对账 | 对账页新增「店铺」子视图 |
| `order-insight.styleAssign` | 款式手工指派 | 数据纠正页「款编码」下拉 |
| `order-insight.imageFind` / `readLocalImage` / `imageThumb` | 单张查重/读图/缩略图 | **不补**：岛用 `imageThumbBatch` 合并调用 |

顺带补齐与内建 `reconRange` 同语义的对账时间窗筛选（全部/今天/本月/本年/自定义）。

### 接线时修掉的 4 处「静默失效」（已写入 `PROJECT_BASELINE.md` §11.12 冻结契约）

1. **子页签点了没反应** —— `app.js#onClick` 只代理 `[data-act]`，子页签用 `data-sub`；修：支持显式 selector。
2. **同一点击被回调 N 次** —— `draw()` 每次 `refresh()` 再挂一个监听器；修：`replaceChildren` 新 `.view-holder`。
3. **金额放大 100 倍** —— `util.js#money(v)` 原是 `num(v, 2)`，调用点传的是**分**；修：`money(cents)` 内置 ÷100。
4. **对账表恒显示 0 / reclassify 空操作** —— 对账行读不存在的 `payableCents`/`name`；`reclassify` 漏传 `fingerprint`/`features` 导致分支不触发。

---

## 1. 结论摘要

当前随宿主分发的"内置插件"**只有 3 个**：`excel-copy` / `quick-note` / `order-insight`，实际状态都不理想：

- **1 个已"死"**：`order-insight` 内建包占 id，导致**市场已安装同名 UI 岛永远注册不进去**（红线 23 典型形态）。
- **1 个是 demo**：`quick-note` 源码 124 行，`meta.ts` 自述"最小业务模块示例"。
- **1 个用户已停用**：`excel-copy` 在 `plugins.disabled`，配置为空壳（0 条记录）。

曾有两个放错位置的脚手架（`sk-hello` / `_template`，已归位）和一个与脚手架模板重复的市场样例（`sk-ui-starter`，2026-09-24 删除）。

### 处置矩阵

| id | 位置 | 形态 | 判定 | 处置 | 优先级 |
|---|---|---|---|---|---|
| `order-insight` | `extensions/order-insight` | 扩展包·L0 | **ID 冲突，功能已被岛覆盖** | **下记内建 → 让已装 UI 岛生效** | **P0** |
| `quick-note` | `src/modules/quick-note` | 内建·L0 | 自述 demo，无真实数据 | 删除，或转 UI 岛示例 | P1 |
| `excel-copy` | `extensions/excel-copy` | 扩展包·L0 | 已停用、数据空壳 | **下记内建 + 转 UI 岛（已完成）** | P1 |
| `sk-hello` | → `scripts/templates/l2-demo` | 脚手架·示例 | 放置错误 | ✅ 已归位；示例包本体已下架，脚手架保留 | P2 |
| `_template` | → `scripts/templates/l2-plugin` | 脚手架·模板 | 放置错误，被构建脚本硬编码依赖 | ✅ 已归位 + 脚本重指向 | P2 |
| `sk-ui-starter` | 原 `ui-plugins/sk-ui-starter` | 市场 UI 岛 | 与 `scripts/ui-plugin-template` 重复 | ✅ 已删除（T6） | P2 |

---

## 2. 盘点范围与判定规则

仓库里叫"插件"的目录有三类，判定标志与侧栏徽标一一对应（`AGENTS.md` §1.9 + `PluginCenter.vue` `badgeFor()`）：

| 类别 | 目录 | 判定标志 | 分发 |
|---|---|---|---|
| 内建业务模块 | `src/modules/<id>/` | 存在 `meta.ts` | 随宿主 |
| 随宿主视图插件包 | `extensions/<id>/` | 存在 `meta.ts`，manifest `kind: 'view'` | 随宿主 |
| 市场 UI 岛 | `ui-plugins/<id>/` | manifest `kind: 'ui'`，`entry: './dist/index.html'` | 市场 zip |
| L2 后台插件 | `<userData>/plugins/` | manifest 无 `kind`，`entry: './index.js'` | 市场 zip |

> `extensions/` 下无 `meta.ts` 的目录（`_template` / `sk-hello`）是脚手架，**不被 registry 收录、不随包分发**。

---

## 3. 完整盘点表

### A. 随宿主分发的内置插件（3 个）

| id | 显示名 | 源码 | 规模 | 形态 | 状态 |
|---|---|---|---|---|---|
| `excel-copy` | TV模版 | `extensions/excel-copy/src` | 1,853 行 / 13 文件 | 扩展包·L0 | ⚠️ 已停用 |
| `quick-note` | 便签 | `src/modules/quick-note` | 124 行 / 3 文件 | 内建·L0 | ⚠️ demo |
| `order-insight` | 订单归类 | `extensions/order-insight/src` | **5,464 行 / 20 文件** | 扩展包·L0 | 🔴 ID 冲突 |

### B. 脚手架（已迁出 `extensions/` → `scripts/templates/`）

| id | 文件 | 规模 | 真实身份 | 谁在用 |
|---|---|---|---|---|
| `l2-demo`（原 `sk-hello`） | `index.js` + `manifest.json` | 66 行 | L2 插件示例 | `scripts/plugins-install-demo.js` 的 `SOURCE` |
| `l2-plugin`（原 `_template`） | `index.js` + `manifest.json` | 50 行 | `npm run plugins:create` 的 L2 模板 | `scripts/plugin-create.js` 的 `TEMPLATE_BG` |

### C. 市场 UI 岛（`ui-plugins/`，独立分发）

| id | 版本 | 源码规模 | 已装版本 | 评估 |
|---|---|---|---|---|
| `shop-accounts` | 1.4.3 | 9,979 行 / 29 文件 | 1.4.1 | ✅ 生产级主力 |
| `ae-profit` | 1.0.1 | 1,783 行 / 9 文件 | 1.0.1 | ✅ 有效 |
| `order-insight` | 1.0.1 | dist 2,450 行 / 16 文件（无 `src/`） | 1.0.1 | 🔴 已装但注册被静默跳过（见 F1） |
| ~~`sk-ui-starter`~~ | ~~0.1.0~~ | ~~189 行 / 2 文件~~ | — | ✅ 已删除（2026-09-24） |

---

## 4. 关键发现

### F1 🔴 `order-insight` 双实现 + ID 冲突 → 已装的岛是个死件

`discover()` 遍历 `enabledModuleMetas` 写入 builtin 记录占用 id；`discoverExternal()` → `registerUiIsland()` **若 `records.has(id)` 则直接 `return`**（只留 `console.warn`）。结果：`<userData>/plugins/order-insight/` 装上了、市场显示"已安装"，但永不出现在侧栏，且无用户可见提示。这正是红线 23 的形态（`PROFIT_TRACKER.md` §10 D1' 给 `ae-profit` 定的规矩）。

### F2 ✅ 数据是共用的，下记内建**不会丢数据**（但配置要迁）

订单/指纹/队列/款式、拿货对账、AI 密钥两边共用同一批函数与 secrets；唯一需搬的是 `electron-store` 里那份**识别配置**（provider/model/列映射/分组维度/透视维度），否则识别设置要重填。

### F3 `src/lib/` 有 6/7 被这两个扩展包"独享"

`templateEngine`/`fieldProcessor` 仅 `excel-copy`；`orderClassifier`/`orderRowSplitter` 仅 `order-insight`（+`orderClassifier` 被 `openaiCompatible.ts` 引用）；`styleMatcher`/`aggregator` 仅 `order-insight`；`excelParser` 在宿主侧。两者都外置化后 `src/lib/` 可瘦身（岛自带纯函数）。

### F4 脚手架位置错误 + 两个 UI 岛样例重复 —— ✅ 已处置（T4/T6）

`sk-hello`/`_template` 实际运行位置应是 `<userData>/plugins/`，放 `extensions/` 既不被收录又混淆；二者都是构建脚本活依赖，已重指向。`ui-plugins/sk-ui-starter` 与 `scripts/ui-plugin-template` 内容重复，2026-09-24 删重复一方、留模板。

### F5 文档已多处漂移（清理前后都应回写）

| 位置 | 现写 | 实际 |
|---|---|---|
| `README.md` 核心能力表 | `shop-accounts` = 视图插件包 | 已是市场 UI 岛 |
| `PROJECT_BASELINE.md` §2 | `extensions/ae-profit` 残留 | **已删除**（commit `ad7471d`） |
| `PROJECT_BASELINE.md` §3 | `ui-plugins/shop-accounts` 1,261 行 | 9,979 行 |
| `AGENTS.md` §1.9 | `extensions` 列含 `shop-accounts` | 已无该目录 |
| `AGENTS.md` §1.8 | 未提红线 23 已被触发 | 需补实例 |

---

## 5. 分项处置方案

### T1 · `order-insight` 下记内建，让 UI 岛生效（P0，最高价值）

**前置：等价性核对**（强制，沿用 R1-5 先例）：先证明岛不是"阉割版"再删内建，按页签逐项核对（overview/pivot/detail/correction/library/stockin/settings），**发现缺项就补进岛，而非保留内建**。

**动作**：① 迁移识别配置；② `modules.config.json` 从 `minimal/standard/pro` 全移除 `order-insight`；③ `git rm -r extensions/order-insight`；④ `npm run build` 确认 `registry.generated.ts` 无该条目；⑤ 重启宿主确认岛注册。

**验收**：PluginCenter 出现 `order-insight`（徽标「外置 · 视图」）、侧栏出现入口、打开岛能读既有数据、`vue-tsc`/`tsc`/`vitest`/`verify`/`eslint` 全绿。**风险与回退**：岛缺功能 → git revert + 恢复 profile；数据在 SQLite 未动。

### T2 · `quick-note`（P1，待拍板）

`meta.ts` 自述"最小业务模块示例"，124 行、`notes: []`。

| 选项 | 动作 | 代价 |
|---|---|---|
| **A. 删除**（推荐） | 删 `src/modules/quick-note/` + 从 profile 移除 | 副作用：`src/modules/` 变空 → `module-roots.cjs` 的 modules 根失去实例（机制仍在） |
| B. 转 UI 岛示例 | 迁 `ui-plugins/`（原可取代 `sk-ui-starter`，后者已删除，此路不成立） | 岛无 `icon`，侧栏图标固定 `box` |
| C. 保留 | 不动 | 继续作为机制样例维护 |

### T3 · `excel-copy`（P1，已转 UI 岛）

最老模块，用户已停用且数据空壳（0 记录、1 默认模板），是唯一旧扁平 key 读写方。

| 选项 | 动作 | 工作量 |
|---|---|---|
| **B. 转 UI 岛**（已选） | 岛自带 `templateEngine`/`fieldProcessor`；Excel 解析走宿主 `db.parseExcel`/`exportWorkbook`；剪贴板走 `clipboard` 能力域；设置面板迁 `manifest.settings`；旧扁平 key 一次迁移 | 已落地：岛 1.0.0 发布，内建包三预设下记，id 释放 |
| C. 删除 | 删包 + 移除 profile | ✅ 已收口（2026-10-05）：`templateEngine` 随孤儿代码删除；`fieldProcessor` **保留** —— excel-copy 岛的 `applyRules` 仍在宿主 `db` 域复用它 |

> **判据建议**：若"Excel→模板→复制"仍是主链路选 B；若已被取代选 C。

### T4 · 脚手架归位（P2）—— ✅ 已完成（见 §0）

### T5 · 文档回写（P2）—— ✅ 已完成（见 §0）

---

## 6. 建议执行顺序

| 批次 | 内容 | 风险 | 前置 |
|---|---|---|---|
| **批次 1** | T1 `order-insight` 下记 | 中（功能覆盖） | 等价性核对完成 |
| **批次 2** | T4 脚手架归位 + 脚本重指向 | 低 | — |
| **批次 3** | T2 / T3 按拍板 | 中 | 用户决策 |
| **批次 4** | T5 文档回写 + 基线刷新 | 低 | 前三批完成 |

---

## 7. 决策记录（2026-09-21，已拍板）

| # | 议题 | 决定 | 状态 |
|---|---|---|---|
| 1 | `excel-copy` | **转为 UI 岛** | ✅ 已完成：岛 1.0.0 发布，内建包三预设下记，id 释放 |
| 2 | `quick-note` | **先保留** | ✅ 维持现状 |
| 3 | `order-insight` | **下记内建，达到"市场安装可用 + 功能完善"** | ✅ 下记已完成（1.1.0/1.2.0 缺口清零） |
| 4 | `ui-plugins/sk-ui-starter` | **用户拍板：删除** | ✅ 已完成（2026-09-24，T6） |
| 5 | `npm run plugins:create <id>` 的 L2 产物落点仍是 `extensions/<id>/` | **待用户决定**：是否一并迁出 | 🟡 未拍板。本轮只搬模板与示例，未改落点 |

### 术语：什么叫「下记内建」

把某个 id 从 `modules.config.json` 构建预设移除，使其不再随宿主分发、由市场安装的 UI 岛接管。三步：① 移出预设（vite 读清单生成 `registry.generated.ts`，下记后无对应 chunk）；② 释放 id（否则 `registerUiIsland` 见 `records.has(id)` 即 return，市场同名岛永远注册不上）；③ 决定残留去向（宿主数据层/能力域通常保留，前端源码视情况删或留档）。与「删除」区别：下记只解除分发+占 id，不动数据、不动宿主能力，**可逆**。

---

## 8. 附：本次盘点用到的取证命令

```bash
cat src/registry.generated.ts                                  # 谁被构建收录（唯一权威）
ls src/modules extensions ui-plugins                            # 各插件形态与规模
ls "$HOME/Library/Application Support/seller-kit/plugins"       # 已装到宿主的插件
node -e "const c=require('$HOME/Library/Application Support/seller-kit/config.json');console.log(c.modules.plugins)"  # 启停状态
sed -n '105,130p' src/core/plugin/managerDiscover.ts           # ID 冲突判定
grep -n "store.ts" extensions/order-insight/src/store.ts       # 数据是否共用
sed -n '/const DB_OPS/,/^};/p' src/core/plugin/host.ts          # db 域 order-insight
```
