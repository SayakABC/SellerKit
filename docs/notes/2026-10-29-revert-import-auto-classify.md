# 撤销「导入即按变体键自动建款色/产品」：为什么回退、留了什么

> **取代关系**：`2026-10-28-order-driven-classify-plan.md` 里"导入时自动归到款色"那部分
> **已回退**（见 `CHANGELOG.md` [Unreleased] 2026-10-29）。本文只讲回退本身；
> 10-28 笔记里键的设计（`variantKey.ts`、键表、命名板、款合并）取证仍然有效。

## 1. 现象与决定

- 用户实报：产品列表冒出一批 `AE-1005012506975770` 形态的占位产品；追问后明确
  **"自动建款会出现很多重复的款"** —— 同一 listing 反复导入各成一套款色，重复款比占位更伤。
- 用户决定：**"导入时还是不要创建产品，像以前一样，放到待认款里。"** 即完全回退自动建档，
  不是调参（比如去重）—— 去重救不了"键是对的、量是错的"这种结构性重复。

## 2. 改了什么（`electron/order-db.ts`）

- `autoAssignByMap` 无人工映射分支：`assignByVariantKey(...)` → 直接 `return`（行留
  `style_color_id = 0` 待认款）。
- 删除 `ensureStyleColorByVariant` / `assignByVariantKey` 两个函数（唯一调用方就是上面那处）。
- `backfillVariantStyleColors()`：**不再**归"有键未归"的行，只保留"已归类但键表没记"的
  补记绑定（`ON CONFLICT DO NOTHING`）。
- **保留**：`variant_key` 照常落库（键是事实不是行为）；`variantKey.ts` 的
  `provisionalStyleCode` 不删（单测仍钉它，将来若做"建议候选"还用得上）。

## 3. 冒烟改写踩的两个坑（都值得记）

1. **人工认款不落无图行**：`assignOrderStyle` 走 `setImageStyleColor → projectImageColorToOrders`，
   而 `projectImageColorToOrders` 对 `image_id = null` **直接 return** —— 无图订单认款后
   行上仍是 0。冒烟夹具因此必须用**有图**订单（同色共用一张图，认一次归两行）。
   ⚠️ 这同时暴露一个产品缺口：**回退后无图订单既不会自动归、也归不了（人工路径落不上）**，
   只能永远待认款。要支持需另行给 `assignOrderStyle` 加"按行直写"的分支 —— 未做，先记录。
2. **键绑定不用手填**：`projectImageColorToOrders` 末尾的 `rememberVariantBinding` 会自动把
   行上的 `variant_key` 记进 `oi_variant_keys`。冒烟里手写 `INSERT INTO oi_variant_keys` 时
   拿 `assignOrderStyle` 返回值里的 `styleColorId` —— **返回类型里没有这个字段**（只有
   `styleCode/styleColorCode/...`），插进去是 NULL，命名板 `JOIN oi_style_colors` 直接把整组
   过滤掉，症状是"找不到 VT_ITEM 这一组"。教训：**夹具模拟一条链路前先看它的返回类型**，
   别按"应该返回什么"写。

## 4. 门禁

`tsc` · `vitest`（1129）· `order:smoke`（94 项）全绿。[13] 节断言反转为：
"无映射不自动归（严格 `style_color_id = 0`）" + "导入不建任何 `AE-` 款色/产品占位"
+ "人工认款后命名板/投影/拿货/合并照常"。
