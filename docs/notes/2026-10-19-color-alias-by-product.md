# 平台色名 → 我的色名：核对时顺手认一次，按**产品**记住

**结论**（2026-10-19）：

1. 订单/采集里的颜色是**平台侧字符串**，真库实测三类：`Khaki`、`Photo color`、`1`…`15`。
   款色库里是自家色名（`黑色` / `卡其`）。**两者之间没有可计算的对应关系** —— 数字色名连语义都没有，
   所以不要再试图"从平台色推我的色"（上一轮已证伪，见 `2026-10-19-weight-key-drops-color.md`）。
2. 唯一可行的路径是**人认一次、机器复用**。但"专门去配一遍"确实太重（一个款 5~8 个色要逐个填），
   所以入口放在**本来就要做的动作**里：归类核对时把颜色改掉、点名款保存 —— 这一对当场记下。
3. 记忆粒度 = **产品**（`pl_products.id`），不是平台也不是商品：
   · 平台级（`Khaki → 卡其`）会串 —— 同平台色名在不同款上未必同一叫法，影响面是全店；
   · 商品级最安全但费工 —— 同款在真实库常有 3~9 个商品ID，要一件件配；
   · **产品级**居中：同一款衣服的 `Khaki` 就是同一个色，配一次覆盖该款全部商品与订单。
4. 没配过对照的色名**原样落库**，不许因为"查不到翻译"就丢成 `未分类`（那会把"没配置"伪装成"没颜色"）。

## 落点

| 位置 | 作用 |
| --- | --- |
| `electron/colorAlias.ts` | 纯函数：`colorAliasKey`（大小写/空白/全角折叠）、`pickColorAlias`、`translateColor` |
| `oi_color_aliases` | 新表 `(product_id, alias_key) UNIQUE`；`alias_raw` 只为展示 |
| `autoAssignByMap` | ③按图定色 / ④订单原文色 → 落库前翻译；①映射色不翻译（人工填的已是自家名） |
| `assignOrderStyle` | 学习：原始色名**只从采集侧取**（`orderColorByItemImage`），返回 `colorAlias` 供界面说明 |
| `reassignOrdersByItemIds(ids, { colors })` | 配好对照后回填同商品历史订单（只认调用方显式点名的平台色名） |
| `ClassifyPanel.colorAliasNote` | toast 说清"以后这个名字都叫 X"（静默生效的规则最难查） |

## 两个必须守住的边界

**① 学习时不能拿订单自己的 `color` 当"原文"。**
`saveCorrection` 的顺序是「先 `orderUpdate` 写 `oi_orders.color`（新值）→ 再 `orderStyleAssign`」，
此时订单行的 color 已经是用户填的自家名，拿它当 from ⇒ 键与目标同值，永远记不下东西
（`rememberColorAlias` 里 `colorAliasKey(want) === key` 直接 return null）。

**② `import` 的原始色名必须来自采集快照，不是订单字段。**
真库里 `oi_orders.color` 有相当比例是空或占位；能定色的证据是**订单图 → `sku_json[].imageUrl` 反查**
（2/2 逐字节命中，见 `2026-10-19-color-by-order-image.md`）。定不出就不学（`raw === ''` → return null）——
记一对猜的对照，会影响该款**以后所有**订单，比不记危险得多。

## 变异取证（每条只让目标断言变红）

| 变异 | 结果 |
| --- | --- |
| `autoAssignByMap` 不调 `toOwnColor` | 色名对照 ①② 全红（`'Khaki' !== '卡其'`） |
| `rememberColorFromAssignment` 不写库（`remembered = null`） | 只有 ① 红（`colorAlias` 实际 `null`）—— ②是直接调 `rememberColorAlias`，本就不测学习链路 |
| 字典查询去掉 `WHERE product_id` + 纯函数去掉产品判定（**两层全拿掉**） | ② 红（`'卡其' !== 'Khaki'`，被别的款带跑） |
| 只拿掉其中一层 | **全绿** —— 两层过滤是冗余保护，不是重复实现；想验证"隔离存在"必须两层一起变异 |

## 已知未做

- 存量库里已经落成平台色名的款色（`oi_style_colors.color = 'Khaki'`）**不会**在配好对照的瞬间改名：
  只有走到归款链路（新订单 / 该商品被回填）的图才会翻译。要整体洗一遍需要另做一次迁移，
  而"哪些 `Khaki` 属于哪一款"在款色表里没有产品维度，强洗会跨款误改。
- 字典没有人工管理界面（只能靠核对时学习）。目前够用：字典为空时行为与上线前完全一致。
