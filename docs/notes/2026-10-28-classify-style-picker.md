# 归属款从下拉换成带图选择器：换掉一个**被门禁覆盖的控件**要同时改什么

**结论（下次换这类控件直接照这四条走）**

1. **先问"判据是什么"再选控件形态。** 归类核对这一步的全部判据是**图**（"这款是不是这一单"），
   而原生 `<select>` 有两条死路：选项里放不了图、展开时没法把这一行的订单图摆在旁边。
   ⇒ 只要判据是视觉的，控件就必须能同时呈现"候选的图"与"待判的图"。
2. **换控件 = 换掉了"值"的出口。** `cl-style-<id>` 由 `<select>` 变按钮后，`.value` 没了。
   必须给一个等价出口（本项目取 `data-style`），并且**一次性改掉所有依赖 `.value` 的断言** ——
   漏掉不是"断言失败"，是 `undefined.length` 直接**崩**掉整段冒烟（`SMOKE: FAILED at [classify]
   - Cannot read properties of undefined (reading 'length')`），排查方向会被带偏。
3. **换控件会让"原来的守卫"失去构造入口，要重找观察点，不能删。** 原守卫是"换款后颜色被清空
   ⇒ 保存禁用"；新弹层里"没选色根本出不去"，那个中间态在界面上不存在了。于是观察点移到
   "弹层里色卡无选中 + 确定按不下去"——**判据强度不变**（点了款就必须给色），只是提前到提交前。
   删掉这条守卫是错的：它会连同"款与色必须成对"一起消失。
4. **同一个通道被第二个页面用到时，别再用"第几次调用"当判据。** 「归类核对」取款首图也用
   `purchaseStyleImages`，而它在冒烟里跑在拿货段之前 ⇒ 原来 `calls('purchaseStyleImages')[0]`
   取到的是款图那次。改成"第一条**按行带尺码**的调用"（那个形状只有拿货单编辑器会产生）——
   既修好，也比顺序假设更贴近断言真正想验的东西。

**为什么没有复用「产品管理」的 `ProductPicker`**（同构不等于同一个东西）

| | ProductPicker | 归类核对的 StylePicker |
| --- | --- | --- |
| 选的对象 | `pl_products`（`api.list`） | `oi_styles` 款全集（`orderStyleList`，**含停用**） |
| 颜色语义 | **商品级** `spec`，词表 `COLOR_SWATCH` | **行级款色**（`oi_style_colors`，该款真实有的色） |
| 对照物 | 无（认的是商品本身） | 左栏固定这一行的**订单图** |

混用的后果是落出"没有名字的款色"（款色主键是「款 + 色」）。只有"搜索 + 带图列表 + 单选"这个
形状是借来的。

**取证**

- 用户原话：「当前归属款只是通过下拉列表看文字，不够直观，也容易对应错」。
- 实现：`src/modules/today/tabs/StylePicker.vue`（新）+ `ClassifyPanel.vue` 的「归属款」格。
  取图零新 IPC：`purchaseStyleImages`（款编码 + 款色 → 路径）→ `orderImageThumbBatch`（路径 → dataUrl）。
- 冒烟 `npm run today:ui`：**298 条全绿**（依赖 `.value` / `.options` 的那批断言已按新控件重写，
  条数按实测 `^PASS ` 计）。
- 取证截图 `npm run classify:shot` → `.cache/classify-shot/picker-1440x900.png`（弹层）、
  `pending-table-1440x900.png`（行内带图格）。布局类改动**只能人眼看**：首版截图当场发现
  "未点名款的行带一个虚线空图位，看着像缺数据"与"两种行高不一致"，两处都是断言查不出来的。

**两个踩过的坑**

- 注入脚本（`today-ui-smoke.mjs` 的模板串）里的注释**不许出现反引号**：本轮写 `` `img` `` /
  `` `[0]` `` / `` `<select>` `` 各崩一次，`node --check` **照过**，只有真跑才报
  `Unexpected identifier` / `JSON.stringify(...)[0] is not a function`。
- 表格里出现第二类图之后，`querySelectorAll('img')` 这类按标签数的断言会静默变成"数多了"（3 → 6）。
  一律改成按语义选择器取（`.cl-thumb-btn img` / `.cl-style-btn__img`）。
