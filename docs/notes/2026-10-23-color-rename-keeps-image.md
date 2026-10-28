# 改色名不许把色图抹掉：色名是标签，不是身份（产品编辑抽屉）

**日期**：2026-10-23 · **用户实报**：「当前编辑产品页，SKU 矩阵中并入的矩阵，修改颜色后，图片就没有了」。

## 结论

1. **色图在订单域是按「款编码 + 色名」查的**（`order-db#findStyleColorImagePath` →
   `oi_styles.code` + `oi_style_colors.color` → `oi_images`）。而产品抽屉里那一行的色名是
   `v-model="r.color"` 直接改的标签 —— **每敲一个字，查询就落空一次**。
2. 旧实现（`ProductEditorDrawer.vue#applyColorImages`）把"查不到"当成"这张图作废"：
   `if (row.imageUrl !== url) row.imageUrl = url`，`url` 为空就写成空 ⇒ 图当场消失。
   而库里那张图**还好端端挂在款色上**；界面把它抹掉纯属自伤。
3. 现在只**补**不**撤**：查到才换（库里有另一张图，说明这个色名确实对应别的图），
   查不到/查询失败一律保留行上原有的图。与 2026-10-20 拿货单那条同源：
   **色名会变，别拿它当身份**（`findStyleColorImagePath` 的 id 优先分支就是这么来的）。
4. 改名后**防抖 400ms 重查一次**：改色名有两种意图 —— ①同一个色换个说法（图不变）；
   ②改成一个库里已有、且有自己那张图的色（图该换成新的）。只有库能回答是哪一种。
   逐键查库既慢，异步回来的顺序还会乱贴。
5. 保存后重拉（`loadSkus`）也要把图续上：`matrixPlan` ①② 保证改名是**原地改**（`pl_variants.id` 不变），
   所以按 **SKU id** 把旧图带到新行（`carryRowImages`），不按色名 —— 按色名再查必然落空。

**仍然存在的边界（曾经）**：`carryRowImages` 只在本次抽屉会话内有效 —— **关掉抽屉再打开**，
图的来源只剩"按新色名查库"，而库里那张图还挂在**旧色名**的款色行上，所以重开仍会显示空占位。
这条已按用户裁定（**款色一起改名**）补上，见 §第二落点。

## 取证

- 旧行为不是"可能"，是可复现的：把 `if (url && row.imageUrl !== url)` 改回
  `if (row.imageUrl !== url)`（= 旧实现）后 `npm run goods:ui` 立刻红：
  `FAIL 改色名后行头色图仍在 … | src=missing`。改回新实现 ⇒ `PASS … | src=data:image/gif;base64,…`。
- 夹具口径：`goods-ui-smoke.mjs` 的 `purchaseStyleImages` 只对 `S1 + 黑` 返回图，
  所以"改成库里没有的名字（深蓝）"正是"查询落空"这一态；等 700ms 是为了让防抖重查真的跑完
  （只判同步状态会漏掉"重查回来又清空"这种写法）。
- 为什么不在 `loadColorImages` 里直接不写 `colorImages = {}`：那个清空是**必要的**——
  它保证"库里的结论"不会混着上一轮的缓存；本轮的判据是"命中才写行"，清缓存与清显示分开。

## 第二落点：改色名同步到订单域的款色（同日追加，用户裁定「款色一起改名」）

保存 SKU 矩阵那一刻，把这一款的色行**改名**：`oi_style_colors.color` 改成新名字，
`id` / `code` / `oi_images.style_color_id` 全都不动 ⇒ 图跟着 id 走，拿货/拣货按款色 id 分组的历史行也不受影响。

- 通道 `style-color-rename`（`electron/order-handlers.ts`）→ `order-db#renameStyleColorByCode`，
  payload `{ productId, styleCode, from, to }`；改名成功后顺手 `rememberColorAlias(productId, from, to)`。
- **三条边界**：目标色名已是一个色行 ⇒ **拒绝**（`target-exists`，两色合并要人看图决定，不能由"改成同名"隐式发生）；
  **不重算 `code`**（历史派生值、表上全局 UNIQUE，重算一次就可能去撞别的色行，把改名变成失败）；
  款/色行找不到 ⇒ 什么都不做（`no-style` / `no-color`），老库还没这个色是常态。
- **旧名从哪来**：`MatrixPlan.updates[].prevColor` —— 算差异那一刻读到的 `pl_variants.color`。
  ⚠️ 不能保存后回读 `variants`：写路径会把颜色改掉，回读到的是新名 ⇒ 判成"没改名"、同步静默不执行
  （本轮**实测踩到**：假桥返回的是夹具对象的引用，写一次 upsert `variants[i].color` 就变新名了）。
  真机上这条同样脆——别依赖"本地那份是旧的"。
- **失败不拦保存**：SKU 已经写进库，色名同步只是显示与后续归色的辅助；失败时界面照旧能看，
  只是重开后那一行没有图（比把一次成功的保存报成失败好）。

守卫（`goods:ui` 的 `color-rename-sync` 步）：① 只改名字**没点保存** ⇒ 一次 `styleColorRename` 都不能有；
② 保存时发 `{productId:1, styleCode:'S1', from:'黑', to:'深蓝'}`；③ 保存后（库里已是新色名）行头图仍在；
④ 再改回去发的 `from` 是"深蓝"（说明取的是改名前的真实值，不是写死的）。

## 第三落点：**新增行**（并入矩阵的行）也要改名（同日第三次，用户实报「保存以后图片还是丢失了」）

上面两条落点只覆盖了"已有 SKU 原地改名"（`MatrixPlan.updates`）。用户实际操作是
**从采集商品并入 → 改色名 → 保存**，那几行在 `pl_variants` 里还没有 id ⇒ 走 `creates`，
于是色名同步一次都没发出去。

真库实证（`~/Library/Application Support/seller-kit/sellerkit.db`，只读查询）：

| 查询 | 结果 | 含义 |
| --- | --- | --- |
| `pl_variants where product_id=9807` | 新增 8 行「深蓝」，id **404–411**（全为最大 id） | 保存时走的是**新增**，不是原地改 |
| `oi_style_colors where style_id=42` | `未分类,1,2,3,4,5,6,7,8` | 订单域色名是**平台色号**，产品侧是中文名 |
| `oi_images` 最近一批 | 5 张，`style_color_id` 指向色名 `1,2,3,4,5`，`created_at=23:04:57` | 图挂在"导入时采纳到的那几个色行"上 |
| `oi_color_aliases where product_id=9807` | **空** | 改名请求一次都没发生（不是失败，是没发） |
| 按 `SUST-004 + 深蓝` 查图 | `[]` | 重开抽屉必然空 |

**根因**：`renameStyleColors` 只遍历 `plan.updates`。并入的行 `variantId=0`，改色名后仍然匹配不到
任何 `pl_variants` 行 ⇒ `creates`。而 `SkuCreate` 里**根本没有"原色名"这个字段** ——
信息在并入那一刻就丢了（`mergeSkuMatrix` 新建行时 `imageUrl: ''`，色名会被用户改）。

**修法**：
- `SkuMatrixRow.srcColor`（`src/lib/skuMatrix.ts`）：`mergeSkuMatrix` 新并入的行记下**并入时的色名**，
  此后用户改 `color` 它不变；不写进 `sku_json`（`toSkuFlat` 不带它）。
- `SkuCreate.prevColor`：算差异时把 `row.srcColor` 带进 plan；`renameStyleColors` 的 `pairs`
  先收 `creates` 再收 `updates`，按 `(from,to)` 去重（一行多码只发一次）。
- 失败不再静默：`renameStyleColors` 返回 `{renamed, failed[{from,to,reason}]}`，保存后
  `toast(..., 'error')` 点名"哪几行色图重开后会空" —— 静默失败的下场就是用户再报一次"图又没了"。

**夹具同时修了一个假绿灯**（`scripts/goods-ui-smoke.mjs`）：
1. `productVariantUpsert` 桩原来**只改已有 id、没有 id 就静默忽略** —— 新增路径永远看不见行，
   守卫第一次跑就撞上：改名请求发出去了，行却不在库里（重拉后消失）。现在按真机语义 push 新行并回 `created:true`。
2. `purchaseStyleImages` 从"只认 `S1 + 黑`"改成维护 `STYLE_COLOR_WITH_IMG` 集合：
   `shopItemImageFetch` 采纳时加入色名、`styleColorRename` 成功时把旧名换成新名 —— 复刻
   "图挂在款色行上，色行改名后 id 与图都不动"。静态一张图分不出"按色名查"与"图跟着色行走"。

守卫（`import-rename-sync` 步）：并入 → 把「红」改成「深红」→ 保存，断言
① `styleColorRename` 收到 `{from:'红', to:'深红'}`（旧实现这里是空数组）；
② 保存后该行色图仍在；③ **关掉抽屉再打开**仍在（这一条只能靠库里按新色名查得到）。

**已经丢的那批图（数据补偿）**：库里没有"深蓝原来叫色号几"的记录 —— 采集里 9 个色的尺码集合
完全一样（`S…4XL` 各 7 个），靠尺码/顺序猜会猜错色、发错货。所以不做自动对齐，
补偿只能由人指认一次（重新导入那一色 → 在矩阵里把新行改名成产品现有色名 → 保存，本次修复会把图带过去）。

## 门禁（2026-10-23 实跑）

`vue-tsc --noEmit` 0 · `tsc -p tsconfig.electron.json` 0 · `verify`（preload 212 / types 212 / 主进程 207，
`✅ IPC 契约一致`）· `verify:docs` · `build` 通过 · `goods:ui`（宽 / 默认 / 窄，共三遍）ALL PASS，
含新增 `改色名后行头色图仍在`、`color-rename-sync` 四步与 `import-rename-sync` 五步；
两处变异回旧实现 ⇒ 对应断言红（`src=missing` / `renames=[]`）。
