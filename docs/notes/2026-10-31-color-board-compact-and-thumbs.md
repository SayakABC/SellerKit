# 颜色板返工：标准色卡缩小不滚、待归一加款图、色名列收窄

## 结论

用户三点口径（2026-10-31）：

1. 「标准色卡片尺寸可以小点，不要出现滚动条，要全部都展示出来」；
2. 「带归一列表中需要加款图，不然数字没法知道是什么颜色」；
3. 「带归一列表的的色名列太宽了，看起来不太协调」。

落地为三处改动 + 一条数据面新增。

## 1. 待归一每行的款图：从 `oi_style_colors.image_id` 来

数字色号（`5` / `9` / `10`…）没有 hex、没有语义，只靠文字认不出是红是蓝。款色表
`oi_style_colors` 本来就挂 1:1 代表图（`image_id`），只是颜色板没把它带出来。

- [`electron/color-merge.ts`](../../electron/color-merge.ts) 的 `ColorBoardRow` 新增
  `imagePath`（本地路径，空串 = 该色在款色表里还没有图）；`colorBoard()` 在统计
  `pl_variants` 之后、`oi_style_colors` 与 `md_images` 都存在时，按 `color` 取
  **`image_id` 最小的一行**（同色多款取图必须确定，否则同一色号两次进页可能换图），
  再经 `md.imageLocalPathMap()` 批量解析成本地路径。
- 真库只读取证（`sqlite3 -readonly …sellerkit.db`，
  `SELECT color, COUNT(*), SUM(image_id>0) FROM oi_style_colors GROUP BY color`）：
  `1` 5/5、`2` 6 行中 5 行有图、`9` 4/4、`10`/`11`/`14`/`21` 均有图，`白色` 8/8；
  只有 `未分类`（11 行仅 1 行）与 `PURPLE`（1/0）覆盖差 —— 数字色号基本都有图可显示。
- 渲染层 [`ColorPanel.vue`](../../src/modules/shop-accounts/components/ColorPanel.vue)
  用 `orderImageThumbBatch`（≤40 张一批，主进程白名单目录 `images`）取 64px 缩略图，
  只在**待归一**那半区取（标准色有 hex 色块，不需要图）。取不到图画**虚线空占位**并带
  title（「这个色还没有款图」／「图还没读出来」），不拿中性灰假装是答案。
- 取图失败不挡合并：缩略图是辅助信息，坏了只让格子空着，合并主流程照常。

## 2. 标准色卡缩小 + 一屏展示，`overflow` 的取舍

- 卡片从「28px 色块 + 三行文字（约 68px 高）」压成「20px 色块 + 两行小字（约 42px）」：
  `.std-card` padding `5px 8px`、`.std-card__swatch` 20px、名字独占首行
  （`flex: 1 0 100%`），hex 与用量并到第二行；网格起宽 180px → 140px。
- `.colors-cards` 去掉 `overflow: auto` 与 `flex: 1 1 auto`：色卡区按内容铺开、自己**不滚**，
  一屏看全；腾出的高度全给下面的待归一名单（名单在自己的框里滚）。
- `.colors-panel` 用 `overflow: hidden`，**绝不能写 auto**：实测面板内容比可视区多出
  2px 时 `auto` 就会真画出一条滚动条（用户口径明确「不要出现滚动条」）。

### 那 2px 从哪来（教训）

`master-data:ui` 窄视口（900×800、25 张标准色）实测 `panelScroll=2`。量到溢出源是
**待归一区的空态**：`.wb-empty.colors-pad` 作为 flex 子项，`min-height: auto` 让它按内容
（约 101px）顶住不肯缩，于是待归一区比父面板高 3px。面板即使 `overflow: hidden`，
内容也是**被切掉**的 —— 隐藏滚动条不等于不溢出。

修复给 `.colors-pad` 补 `flex: 1 1 auto; min-height: 0; overflow: auto`：空间不够时它自己缩、
真放不下时在占位块里滚。修后两遍视口（1440×900 / 900×800）都 `panelScroll=0`。

## 3. 「色名」列收窄

`.colors-col-name { width: 1% }` + 首列 `nowrap`（表格自动按内容宽），原 46% 的留白全部
让给用量列；新增 `.colors-col-img { width: 44px }`（32px 缩略图 + 内边距）。

## 验证

- `npm run build` / `npx vue-tsc --noEmit` / `npm run lint`（0 error）/ `npm run verify` 全绿。
- `npm run master-data:ui` **ALL PASS**（两遍视口）。颜色相关新断言：
  - `待归一列表带款图：数字色号「5」按 imagePath 取到缩略图`；
  - `没有款图的色画空占位（不拿中性灰假装是答案）`；
  - `25 个标准色一屏铺开：色卡区不自己滚，最后一张也在面板可视区内`。
- `npm run ipc:shape:smoke` 96 项全过：板行形状含 `imagePath`，且新增一条「款色有图的色名
  解析出本地路径」；`imagePath` 为空时必须保证不是伪装成数字路径。
- `npm run verify:docs` 全绿（本笔记 + `README.md` 索引 + `CHANGELOG.md` 同步）。

主进程有改动（`color-merge.ts`），需重启 `npm run dev` 才生效。
