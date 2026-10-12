# 「生成拣货单」为空时，先看是哪条口径剔的 —— 与"归类核对做了没有"无关

> ⚠️ **同日晚的后续（2026-10-10）**：「生成拣货单」页签已**并入「拿货」**（六步 → 五步）——
> 本笔记所说的"点生成拣货单"入口不再存在：清单现在「拿货 › 要拿什么」**进页即自动生成**。
> 取数口径（未发货 / 非已终结 / 天数窗 / 店铺）与本文两条夹具纪律不变。
> 见 `2026-10-10-picking-merged-into-purchase.md`。

**结论**（2026-10-10，用户实报「归类核对做完，点生成拣货单还是提示扫了 9 行都被排除了」）：

1. **拣货单的取数只看四件事**：`未发货`（宿主机械筛）· `非已终结`（`bucketOfStatus` 关/完成）·
   `天数窗`（默认近 30 天，`lib/picking` 的 `cutoffDate`）· `店铺`。
   **它不读"归类核对到什么状态"** —— 归类只决定清单里的款 × 色 × 码对不对，不决定行会不会进清单。
   所以"品类/款都核对完了却还是空的"是**两个不相干的问题**，别顺着归类去查。
2. 那 9 行的真因是**天数窗**：下单日全是 `2026-08-25`，距当天 46 天 > 30 天 ⇒ `excludedOld = 9`、
   `excludedFinished = 0`。放宽办法：`更多 → 天数窗` 调大（**`0` = 不限**）。
3. 界面上"为什么空"原先只有一句「都被『已终结 / 超窗』排除了」，**不说到底哪个**；而它给的两个动作
   （调天数窗 / 勾"连已发货"）**各自只对一半场景有效** ⇒ 用户照做一次没变化，只能认为坏了。
   本轮把文案按**实际生效的口径**分开、把"下一步"做成真按钮，并让改条件即重算（见 CHANGELOG）。

## 取证

```bash
# 真库在 seller-kit；`.../SellerKit/sellerkit.db` 是 0 字节的空壳（读它会得出"库里什么都没有"的错结论）
sqlite3 -header -column "$HOME/Library/Application Support/seller-kit/sellerkit.db" \
  "SELECT id, order_no, order_time, status, biz_status, ship_time FROM oi_orders
   WHERE ship_time = '' AND status <> 'shipped' ORDER BY id DESC;"
# → 9 行，order_time 全 2026-08-25，biz_status 全为 ''
```

- 归类**是**生效的：`oi_orders.image_id → oi_images.style_color_id → oi_style_colors.style_id → oi_styles.code`
  9 行都挂上了款（`SUST-011/016/012/001/009`、`STYPE-001`）。
- 纯层复现（等形状夹具跑 `aggregatePicking`）：`days=30 → scanned 9 / groups 0 / excludedOld 9`；
  `days=60 或 0 → rows 9 / groups 4`。
- UI 证据：条件条上写着 `超窗剔除 9 行`，`已排除已终结` 那一格**没出现**（= 0）——两个数分项就在同一行上。

## 顺带查明的坑（都还没修，记着）

1. **「已终结」这一层对没有状态列的报表是空转的**：`biz_status` 只从列名族 `^订单状态` / `^状态$`
   提取（`electron/orderMoney.ts` 的 `TEXT_KEYS`）。用户这批报表的列只有
   `店铺名 / 尺寸 / 订单号 / 下单时间 / 产品信息 / 产品数量 / 产品图片链接 / 产品ID`
   ⇒ `biz_status` 恒空 ⇒ `bucketOfStatus('') = 'unknown'` ⇒ 关闭单**照样进拣货单**（只是这次被天数窗挡了）。
   反过来不会误剔 —— 没这列就判不出终结。
2. **`pickingRows` 的上限是静默的**：`ORDER BY id DESC LIMIT 2000`，`meta.limit` 回了但视图没用
   ⇒ 超过 2000 行时最旧那批**无声消失**，把天数窗调大也补不回来、计数里也看不到（违反本仓"不许静默"）。
3. **`oi_style_colors.color` 的占位值 `未分类`** 在别处被当"没有颜色"处理
   （`order-db.ts` 的 `MAPPED_FALLBACK_COLOR`：写映射时回落款级 `'*'`），但拣货投影里它是个**真颜色**
   （`color = style_color || 订单原文色`）⇒ 清单键显示 `S1 · 未分类 · XL`，而"真的没色"那支显示
   `(无颜色)` —— 同一件事两种写法；且 `未分类` 不会命中 `pl_variants` 的色卡 ⇒ 这些行拿不到 SKU 克重。

## 写守卫时的两条纪律（本轮各踩一次）

- **超窗那一支此前从未被验过**：`picking-ui-smoke` 的假桥只有 `__onlyFinished` 一个"全被剔除"的夹具，
  而用户实报的恰恰是另一支。补夹具 = 补 `__onlyOld`（一行 400 天前）——**一个原因一个反向夹具**，
  否则"两种原因合并写"这种错永远测不出来。
- **`waitFor` 超时会中断整份脚本**：抛到最外层 catch ⇒ 后面几十条断言全不跑，报出来的失败条数
  与真实失败数无关。新增等待一律走 `tryWait`（超时不当异常，断言自己给结论）。
- 扫描型守卫（`tests/uxEntryNames.spec.ts` 的悬空入口名）**会拦新写的话术**：本轮文案里
  `去「今天 › 导入订单」` 被判悬空（那不是任何入口的真名），改成 `去「今天」页的「导入订单」页签`
  —— 页签名来自 `SHIPPING_TAB_NAMES`，是**真入口**，按真名写而不是加豁免。
