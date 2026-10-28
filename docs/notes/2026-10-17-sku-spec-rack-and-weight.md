# 「修改 SKU 矩阵」规格编辑独立成区：通用编辑项（颜色 / 尺码 / 默认克重）与组合表分家，克重可编辑

**结论（先看这段）**

1. **界面被切成两段**（用户口径：「规格编辑把通用的编辑项提取出来，如：颜色（色图 · 色名）、尺码、
   默认克重，增加克重编辑」）：
   - **规格区**（上）：颜色卡片列表（色图 + 色名 + 删除）、尺码 chip（内联改名 + 删除）、默认克重；
   - **组合区**（下）：矩阵，行 = 颜色（**只读**：28px 图 + 色名）、列 = 尺码（**只读**文字），
     格 = `✓ 在卖` 开关 + 该（色·码）的克重。
2. **为什么必须分**（不是审美）：原来的行头 208px 里塞着「缩略图 + 色名输入 + 删除」、列头 92px 里塞着
   「尺码输入 + 删除」。三件事挤在 208px 里，名字稍长就看不全；92px 里两个控件已经贴边。
   分开后各得其所：规格能排成卡片（14 色也扫得动、色名打得全），表格列宽回到 96px 的自然宽度，
   **并且"改规格"只剩一个入口** —— 不再有"表头改一个字、下面 140 个格跟着搬"的隐式耦合
   （`renameMatrixSize` 仍管整列搬家，但它现在只从尺码 chip 进来）。
3. **克重是「格」的属性**（色 × 码各一个值），落 `pl_shop_items.sku_json` 的 `weightG`。
   **0 / 缺省不写这个 key** ⇒ 存量 546 条快照的形状一个字节都不变，`raw_json` 里也一眼看得出
   "这行有人补过克重"。下游链：快照 → 建款向导预填 → `pl_variants.weight_g`。**单向**：这里改快照的
   克重不会回头改已建款的 SKU（那要走产品编辑，不能让两个写者互相改）。
4. **默认克重 = 两个显式批量动作**，不是"自动继承的隐藏默认值"：
   - 「填进空格（N）」：只动 `weightG <= 0` 的格（**默认不覆盖**人已核对过的值）；
   - 「覆盖已填」：另一个按钮，改全部（破坏性动作必须是独立的一次点击）。
   初值**刻意空着**、不按现有数据猜一个 —— 猜错就会在"加一色"时静默给十几格打上错误的克重，
   而克重会进成本/运费计算。人敲过值之后，新增的格才带这个初值（`addMatrixColor/-Size/toggleMatrixCell`
   都收 `weightG` 参数）。
5. **⭐ 0 显示成空（占位「待填」）**：内部 0 = 没填，但把它画进输入框就长成一个真数字 ——
   截图取证第一版整列是 `0`，读起来是"这些 SKU 是 0 克"。所以格里的克重走 `:value` + `@input`
   而不是 `v-model`（`weightDisplay()` / `onWeightInput()`）。
6. **`cellMode` prop 取消**：原先"弹层只标存在性 / 向导只填克重"两种模式合并成一种
   （两个都要：存在性 + 克重）。向导里因此**也能取消组合**了 —— 这是顺带修好的能力缺口，
   不是行为回归（冒烟的 `iw-sku-cell` 从 2 变 4，断言同步改成"四格都能标、其中两格是空的"）。

## 界面规格（交付给下一个改这块的人）

| 项 | 值 | 为什么 |
| --- | --- | --- |
| 规格区标签列 | `76px` | 三行（颜色 / 尺码 / 默认克重）左对齐成一条竖线，扫读快于"每行都贴一个标题" |
| 颜色卡片 | `repeat(auto-fill, minmax(196px, 1fr))`，高 40+8，列表 `max-height: 112px` 滚动 | 940 宽弹层里一行 3 张；14 色时两行内见得到 6 个，其余滚动 |
| 色图 | 卡片内 40px（矩阵行头 28px） | 40px 是能看出版型/花色的下限；表格里再小一档换列宽 |
| 尺码 chip | 输入 `72px` + `✕`，高 26 | 改名不用点"编辑"，chip 本身就是输入框 |
| 组合表列宽 | 行头 `168px` + 每列 `96px`（`table-layout: fixed`，列宽声明**必须挂在 th**） | 14×10 满叉积时表格 1128px，靠 wrap 横滚 |
| 格内控件 | `✓` 26px + 克重输入（`flex:1`，`max-width: 88px`），成对**居中** | 列被 `min-width:100%` 撑宽时，左对齐会让两者被甩到两端 |
| 空格 | 整格一个大虚线按钮（`width:100%`） | 目标大、看得见"这里能点"；比 26px 小方块好点得多 |
| 焦点 | 卡片 `:focus-within` 描边 + 环 | 14 色时"现在改的是哪一色"必须看得出来 |
| 主题 | 全部走 `--wb-*` 令牌（含 `--wb-warning-soft` 高亮、`--wb-focus-ring` 焦点环） | 深色主题自动成立，不写死颜色 |

## 改动点

| 位置 | 内容 |
| --- | --- |
| `src/lib/skuMatrix.ts` | `SkuFlatRow.weightG?` · `normWeightG` · `parseSkuJsonRows`（渲染层**唯一**解析点，两处调用不再各抄一份） · `countFilledWeightCells` · `fillMatrixWeight(m, w, {onlyEmpty})` · `addMatrixColor/-Size`/`toggleMatrixCell` 收 `weightG` · `toSkuJsonRow` **0 不写 key** |
| `SkuMatrixEditor.vue` | 规格区（颜色卡片 / 尺码 chip / 默认克重）+ 组合区重排；格 = `✓` + 克重；取消 `cellMode`；`-weight` / `-default-weight` / `-fill` / `-fill-all` / `-spec` / `-row` / `-row-thumb` 新增 `data-act` |
| `ShopItemSkuEditor.vue` | 弹出说明改写（指向"规格 / 组合"两段）· 解析换 `parseSkuJsonRows` |
| `ShopItemWizard.vue` | 去掉 `cell-mode`；解析换 `parseSkuJsonRows`（**克重预填**从快照读，不再恒 0） |
| `electron/shop-item-db.ts` | `ShopItemSkuRow.weightG?`；`normalizeSkuRow` **>0 才带 key**（采集路径无此字段 ⇒ 0，不写） |
| `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts` + `src/modules/goods/api.ts` | 契约四处同改（`weightG?: number`） |
| `tests/skuMatrix.spec.ts` | +10 例（读回克重 / 0 不写 key / 填只填空 / 覆盖才改已填 / 批量填不造 SKU / 新增格带初值 / `parseSkuJsonRows` 抗坏值 …），当轮 28 例 |
| `scripts/goods-ui-smoke.mjs` | 弹层段 **+7 例**（规格不在 tbody / 克重随格出 / 0 显示成待填 / 输入后可点 / 填进空格只填空 / 覆盖已填 / 无空格时禁用）+ 载荷深比较加 `weightG`；向导段 3 处选择器与计数跟着结构改 |
| `scripts/goods-shot.mjs` | 新增「修改 SKU 矩阵」弹层与建款向导的取证截图 + 几何（卡片等宽、`pairBox` 左右 gap、规格区/表格高度、640px 抽屉里的规格区） |

## 坑（下次照着绕）

1. **⭐ 断言点击 disabled 按钮 = 静默无效**：`setVal()` 之后立刻 `click()`，Vue 还没把 `disabled`
   刷回 DOM ⇒ 点了没反应、断言红在"填进去的值没变"（实测 `weights=88/0/0`）。
   先 `await settle(() => !btn.disabled)` 再点 —— 这一步顺带就是"输入后按钮变可点"的断言。
2. **⭐ 0 值的显示**：内部语义 0 = 未填，`v-model` 会把它画成 `0`。要显示"空 + 占位"就只能
   `:value` + `@input`；副作用是输入过程中别回写 DOM（否则打字时光标跳）。
3. **`table-layout: fixed` + `min-width: 100%` 时，多出来的宽度是**均分**给各列的**（实测
   906px 表：168/96/96 → 350/278/278）。所以格内控件必须成对居中，否则被甩到两端。
4. **父组件 scoped 样式打不到子组件渲染的元素**（2026-10-16 已有这条）：`is-flagged` 高亮必须
   留在 `SkuMatrixEditor.vue` 自己的 scoped 块里；冒烟定位也从"`tr.is-flagged` 里的输入框"
   改成"` .is-flagged ` 里的输入框"（色名输入已不在 tr 内）。
5. **注入脚本（假桥 / 冒烟）里注释也不能有反引号** —— 仍是本仓最容易复发的一条（本次未踩）。

## 验证

- `vitest run tests/skuMatrix.spec.ts` → 28 passed
- `vue-tsc --noEmit` / `tsc -p tsconfig.electron.json` → 0
- `npm run goods:ui` → 宽 / 1200×800 / 900×800 **三遍 SMOKE: ALL PASS**（弹层段当轮 +5 例）
- **变异 3 条全红**：`仅填空` 改成一律覆盖 ⇒ 单测 2 条红；`toSkuJsonRow` 让 0 也写 key ⇒ 单测 2 条红；
  `weightDisplay` 把 0 画成 `0` ⇒ 冒烟「待填」1 条红（`values="0"/"0"/"0"`）
- `npm run goods:shot` → `sku-matrix-1440x900.png` / `sku-matrix-900x800.png` / `sku-wizard-1440x900.png` 人眼验版式
  （1440：规格区 198px、表格 108px，一屏同时看得见规格与组合；900：弹层 846×578 也不出现
  "最后一行被裁"）
