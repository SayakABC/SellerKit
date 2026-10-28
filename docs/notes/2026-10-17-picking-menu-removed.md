# 摘掉左导航的「拣货」：删的是入口，不是功能

**结论**：`picking` 退出模块清单（`modules.config.json` 三处），`src/modules/picking/{meta,index}.ts` 删除，
`PickingView.vue` 原样留给「今天 › 拿货 › 要拿什么」。同一份清单**只有一个入口**了。
它的假桥冒烟 `picking:ui` 随之退役，但**验收面没有变窄**：真生成在主进程的那条链（`pickingExportExcel`
出参 / 图已转 JPEG / 无价行金额 `null`）与「只改条件不点按钮也重算」搬进了 `today:ui`。

## 为什么不是"再留一个入口"

清单功能 2026-10-10 就并进了「拿货」（`docs/notes/2026-10-10-picking-merged-into-purchase.md`），
独立页从那天起就是**第二条路**：两处都能出同一份单，口径却又各有取数入口。
`AGENTS.md` 的「入口唯一」判的是"删掉它闭环还成立吗" —— 成立（拿货页里一条不少），
所以它属于**可删的冗余入口**，而不是主干。

功能面核对（删完后用户还能做什么，逐条对过 `PickingView.vue`）：

| 动作 | 内嵌后的落点 |
| --- | --- |
| 生成/重算清单 | `auto` 进页即生成；改条件（天数窗 / 店铺 / 含已发货）自动重算 |
| 导出带图 xlsx | 精简条 `data-act="export"`（与页头那颗是同一实现） |
| 天数窗 / 店铺 / 含已发货 | 精简条「更多」展开 |
| 复制给厂家清单图、按厂家开单、忽略/取消忽略 | 汇总条与卡片行动作（**只有内嵌形态才给**，本来就依赖宿主） |

## 取证

- 注册表不再含它：`src/registry.generated.ts` 的 `enabledModuleMetas` / `moduleViewLoaders` 均无 `picking`
  （`npm run build` 生成，构建期裁剪 ⇒ 侧边栏与 ⌘K 都不会出现）。
- 没有代码还在跳它：全仓 `'picking'` 只剩两处**注释**（`src/modules/today/tabs/ImportPanel.vue` 的历史说明、
  `scripts/today-ui-smoke.mjs` 的"不许出现模块 id 字面量"反向守卫）。
- 门禁：`vue-tsc` / `tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `build` / 全量 `vitest` /
  `today:ui` 全绿。`picking:smoke`（`electron/picking-db.ts` 投影）与 `picking:xlsx:smoke`（主进程画表）
  **一行没改，照跑**。

## 看着像死代码、但**必须留着**的东西

- **`PickingView.vue` 的 `!embedded` 那一支**（页头 + `goImport()` 里的 `switchModule('today')`）：
  生产上恒为 `embedded`，确实不可达。留着的理由是它是这个组件的**自洽形态**（换宿主/再挂独立页时不用重写），
  且删它要连带拆页头里那三颗按钮的样式与 `wb-head` 契约 —— 收益只有"少 30 行 DOM"。
  已在文件头注明"生产恒为 `embedded`"，避免下一个人以为还能导航到它。
- **`pickingRows` / `pickingExportExcel` 两条 IPC 通道**：仍是「今天」总览卡（待拣）与拿货页的取数口，
  消费方没减少，只是不再有第二个页面调。
- **`src/lib/picking*.ts` 四个纯函数文件**：口径单源，`today:ui` 与 `picking:smoke` 都钉着它们。

## 下次做同类"摘菜单"时的顺序

1. `modules.config.json` 三处一起删（`profiles.*` 与 `enabledModules`）——只删一处会出现"预设里有、兜底没有"的漂移；
2. 删模块壳（`meta.ts` / `index.ts`），**留视图**；
3. **搜一遍 `moduleId` 跳转**：`switchModule('<id>')` / `openModule('<id>'…)` / `ImportNextStep.moduleId`
   —— 跳到一个不存在的 id 不会报错，`activeComp` 的 `?? TABS[0]` 会静默落到第一个页签；
4. 处置它独占的冒烟：**先把"入口还在但宿主变了"的断言搬到新入口，再退役脚本**
   （顺序反了就会丢断言，而丢掉的正是最难查的那类静默失败）；
5. 文档三件套：`CHANGELOG` 的 `[Unreleased]`、本条笔记 + `docs/notes/README.md` 索引、
   `docs/baseline/PROJECT_BASELINE.md` 里那条冒烟行改成**退役记录**（别直接删行 —— 历史要能查）。
