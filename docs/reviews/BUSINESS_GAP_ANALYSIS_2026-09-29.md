# 业务能力差距审查（对 5 大目标需求的落地距离）

> **性质**：审查报告 + 改动清单。§1–§3 客观现状（带 `文件:行` 取证），§4–§6 要做的改动（含待拍板项）。
> **审查对象**：5 大目标需求（店铺/产品/物流价格/订单/财务管理）对照当前代码。
> **取数时点**：2026-09-29。IPC 契约与 op 数实跑所得（`npm run verify`），非抄文档。
> **前置阅读**：`AGENTS.md`、`docs/baseline/PROJECT_BASELINE.md`、`docs/plans/DOMAIN_INTEGRATION_PLAN.md`、`docs/features/PRODUCT_LIBRARY.md`、`docs/decisions/ADR-002-master-data-layer.md`。

---

## 0. 结论速览

### 0.1 五大需求成熟度

| # | 需求 | 成熟度 | 一句话结论 |
|---|---|---|---|
| 1 | 店铺管理 | 🟡 **85%** | 实体表+名称归一+维护界面已就绪；差"被其他模块用起来"（S2/S3 未做） |
| 2 | 产品管理 | 🟡 **85%** | 产品/SKU/克重/图片/供应商/商品映射已就绪；差**成本维护界面**（P4）与 SKU 级成本 |
| 3 | 物流价格测算 | 🟢 **90%** | 报价/按订单试算/按产品试算三链路都在；差**运价表不在中立层**与多件计费 |
| 4 | 订单管理 | 🔴 **25%** | 预期利润整条链缺 6 环节；统计无跨域 op；拣货未开工（P5） |
| 5 | 财务管理 | 🔴 **10%** | 供应商对账+店铺成本分摊已有；差店铺×天对账、**费用表**、分摊规则、店铺利润 |

### 0.2 一句话根因
**数据基本都在，但没有一个能跨域把它们算到一起的出口；而订单域缺"钱"和"量"。**
1. **跨域计算 op 一个都没有**：12 个 db 能力域全是单域 op（`host.ts` 的 `DB_OPS`），`oi_*`/`pl_*`/`ae_cost_map`/`purchase_*`/`shipping-rate` 五张网各自完整，**没有一根线串起来**（即 `DOMAIN_INTEGRATION_PLAN` S3 `shopOverview` 想解决、至今未开工）。
2. **订单库里没有金额、没有数量**：`oi_orders` 12 列无金额列；"产品数量"拆行时被丢弃（`shipRateOrders.ts:143` 注释"数量恒取 1"）。收入侧只存于另一套数据 `ae_orders`。**"订单预期利润"连输入都不完整。**
3. **财务管理整块空白**：无表承载"运营费用/杂费/分摊规则"，也无"店铺利润"计算出口；现只有供应商维度对账与成本侧店铺分摊。

### 0.3 顺带发现的文档漂移（3 处，已实测）
| 项 | 文档写的 | 实测 | 位置 |
|---|---|---|---|
| IPC 契约规模 | `PROJECT_BASELINE.md` §5：166 声明/162 通道 | **182/182/178 通道** | `npm run verify` |
| `product` 域 op 数 | `PRODUCT_LIBRARY.md` §6.2、注释：6 | **8**（1.2.0 加 `variantList`/`itemImagePool`） | `host.ts` |
| `product-admin` 域 op 数 | `PRODUCT_LIBRARY.md` §6.2：7 | **10**（1.4.0 加 `batchUpdate`，满额） | `host.ts` |

> 三处不影响功能，但会让"还剩多少 op 预算"的判断出错——本方案受此预算约束。

---

## 1. 现状盘点（客观事实）

### 1.1 12 个 db 能力域与 op 预算（实测）
> 预算：单域 ≤ 10 op（ADR-002 N5）。**`product-admin` 已满、`product` 8、`shop` 8**——加新 op 前必须先找位置，是本方案最大结构性约束。

| 域 | op 数 | 声明它的岛 | 读取面 |
|---|---:|---|---|
| `order-insight` | **37** | order-insight | 独占（超预算，冻结） |
| `purchase` | **24** | order-insight、ae-profit | 共享（超预算，冻结） |
| `shop-accounts` | **17** | shop-accounts | 独占（超预算，冻结） |
| `product-admin` | **10** | product-library | owner 写（**满额**） |
| `ae` | 9 | ae-profit | 独占 |
| `product` | **8** | product-library | 共享只读 |
| `shop` | 8 | shop-accounts | **设计为共享只读，但当前写读同域** |
| `excel-copy` | 7 | excel-copy | 独占 |
| `shipping-rate` | 6 | shipping-rate | 独占 |
| `shop-products` | 6 | product-library | owner 写 |
| `product-image` | 4 | product-library | owner 写 |
| `product-supplier` | 4 | product-library | 共享（供应商主数据） |

### 1.2 各岛域声明（`ui-plugins/*/manifest.json`）
- `shop-accounts` 1.5.2：`shop-accounts`、**`shop`**；`order-insight` 1.3.0：`order-insight`、`purchase`
- `product-library` 1.5.0：`product`/`product-admin`/`product-image`/`product-supplier`/`order-insight`/`shop-products`
- `ae-profit` 1.0.2：`ae`、`purchase`；`shipping-rate` 1.2.1：`shipping-rate`；`excel-copy` 1.0.0：`excel-copy`

> **关键事实**：`shop` 域**只有拥有者自己声明**（S2 未做）；`product` 域只读面已拆好但**无任何第二消费方**——"产品库建好给别人用"至今零消费方。

### 1.3 唯一贯通的锚点
| 实体 | 状态 | 取证 |
|---|---|---|
| **款式编码** | ✅ 真贯通（`oi_styles.code`≡`pl_products.code`≡`purchase_items.style_code`≡`ae_cost_map.style_code`） | `order-db.ts:273` |
| **店铺** | 🟡 实体已立、映射已建、**零消费方** | `shop-db.ts:140`/`160` |
| **店铺商品ID→产品** | 🟡 映射层已建，只在主进程内部调用 | `product-db.ts:1123`（`resolveOrderSku`，**无 op**） |
| **订单行→SKU 变体** | ❌ 断的 | `product-db.ts:1141`（"一期只有 `spec='*'`，变体表推迟 P5"） |

---

## 2. 逐需求差距分析

### 2.1 店铺管理 —— 🟡 85%
**已具备**：店铺实体表（`shop-db.ts:140`，`platform`×`name_key` 唯一 + `platform_shop_id` 部分唯一）；名称归一映射（`shop-db.ts:160`，历史文本零改写）；未归一名单实时聚合；维护界面（shop-accounts 1.5.0/1.5.2）。
**缺口**：① 其他模块用不到店铺实体（`shop` 域只有 shop-accounts 声明，订单归类/利润追踪仍按自由文本）；② `shop` 域写读同域（ADR-002 C4 要求共享域只读，`host.ts:411-416` 已记待办，放行前必须先拆只读子域）；③ 无"店铺经营视图"（S3 `shopOverview` 未开工）。

### 2.2 产品管理 —— 🟡 85%
**已具备**：产品主数据（`pl_products`，唯一权威写入）；SKU 子表（`pl_variants`，颜色+尺码+克重）；图片三层回落；店铺商品ID→产品映射+待关联队列；商品清单去重关联套装；供应商主数据（1.4.0 迁入）；Excel 导入/导出/批量编辑/删除。
**缺口**：① **P4 成本维护界面未开工**（现成本只能从 ae-profit「成本衔接」导一次快照，手工成本无录入界面）；② 成本是款级无 SKU 级（`ae_cost_map` 主键 `(style_code,effective_from,source)`，`costSnapshot()` 不计颜色/尺码）；③ `pl_products` 无价格列（刻意为之，成本归 `ae_cost_map`）；④ 变体 `spec` 拆列留 P5。

### 2.3 物流价格测算 —— 🟢 90%
**已具备**：报价单 Excel→运价表（17 段互斥归一化，`shipRate.ts` 832 行+50 例）；克重→逐国运费（`shipRateQuote.ts`）；按订单试算（`shipRateOrders.ts`+`quoteOrders`，拒算五分类）；按产品试算（`quoteProducts`）；商品信息 Excel→`pl_item_weights`（`importProductWeights`）。
**缺口**：① 🟡 运价表快照已落宿主中立层（新表 `sr_rate_snapshots`+3 通道，C3 收窄未关，余下"岛改读宿主表"要连带升版）；② 其他模块拿不到 `shipping-rate` 域（独占）；③ 数量恒按 1 件/行（`shipRateOrders.ts:143`）；④ 非本币价卡明确拒算，无汇率来源。

### 2.4 订单管理 —— 🔴 25%

#### 2.4.1 订单预期利润（核心缺口）
目标链路 12 环节状态：① 商品ID ✅（`shopSku.ts:64`）；② 目的国 ✅（`shipRateOrders.ts:109`）；③ 收入金额 ✅ 2026-09-29 补（报表本身有 `订单金额`/`产品总金额`，1722 行恒有值→已入账 14 列 `amount_cents` 等，`orderMoney.ts`）；④ 数量 ⚠️ 更正（报表无数量列，数量在 `商品信息` 块内 `(商品数量:N piece)` 58 处>1，随 F1-2 接入运费仍按 1 件/行）；⑤ SKU 规格 ⚠️（`oi_orders.color`/`.size` 有列但 `raw_fields` 的"规格"未接入，与 `pl_variants` 无映射）；⑥ 订单行→产品 ⚠️（已贯通但只在主进程内部，`insertOrder` 直调，无 op）；⑦ 订单行→SKU 克重 ❌（`pl_shop_sku.variant_id` 一期恒 0）；⑧ 产品进价 ⚠️（`ae_cost_map` 款级+生效区间，无维护界面且无 SKU 级）；⑨ 运费 ⚠️（计价完备但运价表在岛私有存储，跨域够不到）；⑩ 平台佣金/费率 ❌（无费率表，`ae_fees` 是逐单明细非规则）；⑪ 汇率 ⚠️（`ae_rates` 有但无生效区间）；⑫ 跨域计算出口 ❌（12 域全单域 op，无 join 五域的 op，`host.ts:53`）。
**结论**：链要通缺 ①订单侧"钱/量"②订单行到 SKU 下钻③中立层运价表④一个跨域计算 op，四者缺一不可。**不能复用 `ae-engine`**：它吃 `ae_orders`（扩展推送），与 `oi_orders`（Excel 导入）形状口径完全不同。

#### 2.4.2 按店铺 / 按产品统计
- 按店铺（订单侧）：`groupStats(['shop'])` 可组但只在本域（维度白名单仅 `category`/`color`/`shop`），无跨域/无金额/无日期。
- 按店铺（成本侧）：✅ `shopAllocation()` 按店铺分摊拿货成本（FIFO）。按产品：❌ 需 join `pl_products` 无 op。按日期：❌ `groupStats` 无日期维度。
- **关键落差**："按店铺统计"是两个半截（订单侧有单量没金额，采购侧有成本没收入），合成"店铺利润"必须先有 §2.4.1 跨域出口。

#### 2.4.3 拣货（P5 未开工）
已有素材：`pl_variants`（color/size/weight_g）、`pl_images`/`pl_item_images`、`pl_products.supplier_id`、`oi_orders`。缺：拣货 op、订单选择态与拣货单输出、`pl_shop_sku.spec` 规格级生产者（恒 `'*'`）、订单行 SKU 定位。注意 `outstanding()`（`purchase-db.ts:723`）已做"款色码粒度"需求−缺口，其 JOIN 写法（`oi_orders→oi_images→oi_style_colors→oi_styles`）是可复用拣货骨架。

### 2.5 财务管理 —— 🔴 10%

#### 2.5.1 已有能力（按供应商组织）
`reconciliation(from,to)`（`purchase-db.ts:664`，拿货额/已付/退款/`balanceCents`/单数）；`payments`（payment/refund 按供应商聚合）；**店铺成本分摊** `shopAllocation`(`:888`)+`shopAllocationDetail`(`:912`)（按店铺 FIFO）；`outstanding()`(`:723`)（款色码粒度需求−已拿−已忽略）；`costSnapshot()`(`:947`)（款×拿货日加权均价）；`priceHistory()`(`:974`)（供应商×款×色）。
> 即"拿了多少货/预期付多少/实际付多少/差额"数据全有，**只是按供应商组织，不是按店铺×天**。

#### 2.5.2 缺口
| 目标 | 现状 | 缺口 | 严重度 |
|---|---|---|---|
| 今天每家店发了多少货 | `oi_orders.shop`+`order_time` | **无 op**；`order_time` 与 `biz_date` 未对齐 | 中 |
| 今天每家店拿了多少货 | `shopAllocation` 有按店铺件数 | 时间窗是区间非"天"；依赖 `purchase_sources.shop`（自由文本） | 小 |
| 预期要付多少 | `purchase_orders.total_cents` | 无按店铺口径 | 中 |
| 实际要付多少 | `payments.amount_cents` | **付款只挂供应商，无店铺维度** | **大** |
| 差值在哪 | 仅 `balanceCents` 总额差 | 缺"差在哪"分解 | 中 |
| 店铺运营费用/杂费 | ❌ **无任何表** | 需新建费用表 | **大** |
| 费用均摊到各店铺 | ❌ **无任何规则表** | 需新建分摊规则 | **大** |
| 店铺利润统计 | ❌ | = 收入(缺)−拿货成本(有)−运费(够不到)−费用分摊(缺) | **大** |

---

## 3. 现在答不出来的业务问题

| # | 问题 | 能否 | 卡在哪 |
|---|---|---|---|
| 1 | 这条订单预计赚多少？ | ❌ | 订单无金额（§2.4.1-3）；无跨域 op |
| 2 | 这条订单实际运费多少？ | 🟡 单岛内能 | 运价表在岛私有存储，其他模块够不到 |
| 3 | 这批订单要拣哪些货？每款几件？图在哪？ | ❌ | P5 未开工；订单行定位不到 SKU 变体 |
| 4 | 这家店这个月赚多少？ | ❌ | 无店铺级收入；无费用分摊 |
| 5 | 今天每家店发/拿了多少货？ | 🟡 数据有 | 无按店铺×天 op |
| 6 | 预期付 vs 实际付，差在哪？ | 🟡 供应商维度能 | 付款无店铺维度；缺差额分解 |
| 7 | 运费/房租/软件费摊到各店多少？ | ❌ | 无费用表、无分摊规则 |
| 8 | 同产品多家店卖，有无防关联风险？ | ❌ | 需 product×shop×account 三方关联，跨域出口缺失（S3 未做） |
| 9 | 这款从哪家拿货、卖到哪些店、毛利多少？ | 🟡 半答 | 款编码贯通 ✅，"卖到哪些店"仍卡自由文本（S2 未做） |

---

## 4. 改动清单（按依赖顺序分阶段）

> 原则沿用 `DOMAIN_INTEGRATION_PLAN` §3.1：**零迁移优先 / 补实体层不补关联字段 / 宿主一次建成 / 不破安全模型 / 每步可回退**。接续 S1–S5/P0–P5，新增 **F0–F6**。

- **F0 前置（不做则后面全是死路）**：**F0-1** 按 C4 拆 `shop` 只读子域（`host.ts` 的 `DB_OPS`：`shop` 拆只读 `list`/`get`/`summary`/`unmapped` + `shop-admin` `ensure`/`upsert`/`map`/`unmap`，样板 = P3 的 `product`/`product-admin`）；**F0-2** S2 放行：order-insight/ae-profit 声明 `shop` 域并**发版**；**F0-3** ✅ **已做（M6，2026-09-30）** 运价表迁宿主中立层（快照表 `sr_rate_snapshots`+宿主读 op，原为岛私有 electron-store，不迁则跨域算运费不可能，违反 ADR-002 C3）；**F0-4** 回写文档漂移（§0.3 三处）。
- **F1 订单侧补字段**：**F1-1** 订单金额入账（收入侧，`oi_orders` 增 `amount_cents`/`currency`，幂等 `ALTER`，从 `raw_fields` 取，待拍板 G8）；**F1-2** 数量入账（增 `qty`，放开 `quoteOrders`"恒取 1"，待 G9）；**F1-3** 规格归一（订单"规格"→`pl_variants`，复用 `sk_name_map`，待 G10）；**F1-4** `pl_shop_sku.spec` 生产者。
- **F2 订单预期利润引擎**：**F2-1** 新增粗粒度只读 op（1 个，主进程聚合，只回汇总+逐行）新域 `order-profit`（只读 ≤10），一次 JOIN `oi_*×pl_*×ae_cost_map×拿货成本×运价表`；**F2-2** 返回分项：收入/产品成本/物流费/平台费/**预期利润**/物流利润/产品利润，逐行带"缺什么"标识（别静默按 0 算）；**F2-3** 费用/佣金**费率表**新表（`ord_fee_rules`）；**F2-4** 岛侧界面（消费方声明新域+发版）。
- **F3 统计**：**F3-1** `shopOverview({shopId,from,to})`（S3，并入 F2 域）；**F3-2** 按产品统计 op（复用 F2 域）。
- **F4 拣货（原 P5）**：**F4-1** 拣货聚合 op（选中订单集→按 产品×SKU 聚合→图/供应商/尺码/数量，骨架复用 `outstanding()` 的 JOIN，`purchase-db.ts:723`）；**F4-2** 拣货单输出（依赖 F0-2 与 F1-3）。
- **F5 财务管理**：**F5-1** **费用表** `fin_expenses`（日期/类型/金额/币种/归属/备注/单据图）；**F5-2** **分摊规则表** `fin_alloc_rules`（口径+生效区间）；**F5-3** **付款的店铺维度**（`payments` 增 `shop_id` 或经分摊规则摊）；**F5-4** 新域 `finance`（只读 ≤10）+`finance-admin`（写）；**F5-5** **店铺×天对账 op**（发货×拿货×预期付×实付×差额分解）；**F5-6** **店铺利润 op**（与 F2 共用成本/运费口径，不得各自实现）；**F5-7** 财务岛界面。
- **F6 收口**：**F6-1** 宿主「经营概览」统一入口（S5）；**F6-2** 岛间交叉跳转。

---

## 5. 待拍板决策

| 编号 | 决策点 | 建议 | 影响面 |
|---|---|---|---|
| **G8** | 订单收入从哪来？(a) 报表 Excel 金额列 (b) 复用 AE 后台 (c) 人工填 | **(a)**（最贴近"订单管理"语义；(b) 合并两套源口径风险大） | F1-1 |
| **G9** | 订单数量是否入账（现恒 1） | **入账**（否则运费/成本系统性少算） | `oi_orders.qty` |
| **G10** | 订单"规格"如何映射 `pl_variants` | **照 `sk_name_map`**：精确匹配自动+人工指派一次，模糊只排序 | F1-3 |
| **G11** | 费用分摊默认口径 | **"按拿货额比例"**（与 `shopAllocation` 同源可复算） | F5-2 |
| **G12** | 运价表迁宿主 vs 留岛内 | **迁宿主**（F0-3）。留岛内则跨域算运费永远穿透岛私有存储 | 一次迁移+岛侧改读法+发版 |
| **G13** | 新跨域利润 op 挂哪个域 | **新域 `order-profit`**（只读）。`product` 8/`shop` 8/`product-admin` 10 满额，挤进必顶穿 | 域划分与岛权限声明 |

**已封存、不用拍板**：拆 `shop` 只读子域（C4 硬要求）· 不建万能域（G4）· 跨域事件本轮仍不做（G7）· 不引入第二套成本表（ADR-002 Q2）· 新岛不登记进 `modules.config.json`（红线 23）。

---

## 6. 风险与硬约束

| 风险 | 说明 | 应对 |
|---|---|---|
| **op 预算已近顶** | `product-admin` 10 满、`product` 8、`shop` 8（N5 ≤10） | 新能力一律**新域**，挤进现有域必顶穿 |
| **岛发版成本** | 改 `domains`/`actions` 必须升版本+重发布+装+重启宿主 | 每新域**一次定稿 op 集合**，别分批发版 |
| **运价表位置** | 挂在可卸载岛私有存储（§2.3） | F0-3 优先，是 F2/F5 共同前置 |
| **两套订单源** | `oi_orders`（Excel）与 `ae_orders`（扩展推送）形状口径不同 | 不合并；利润口径各自实现但**共享同一套成本/运费函数** |
| **日期口径未对齐** | `oi_orders.order_time`（字符串）vs `purchase_orders.biz_date` | 跨域对账前先归一 |
| **自由文本残留** | `purchase_sources.shop`/`ae_orders.shop_name` 未过 `sk_shops` | F0-2 放行后逐域接归一 |
| **历史数字不可复算** | `ae_rates` 无生效区间；费用分摊无生效区间同问题 | 分摊规则**带生效区间**（F5-2 已含） |

---

## 7. 建议的最小可验证路径（第一刀）
**不要一次铺开 5 个需求。** 走通断得最狠的一条，其余是复制：
```
F0-1 拆 shop 只读子域 → F0-3 运价表迁宿主 → F1-1/1-2 订单补钱与量
  → F2-1 一个跨域利润 op（先只算"产品成本+物流费"，不算费用）
  → 取一条真实订单，人工核算三处数字对齐
```
跑通判据：**同一条订单，在订单利润页看到的"产品进价/物流费"，与产品库成本、运费岛运费是同一个数。** 骨架对了 F3/F4/F5 都是复制。

---

## 附：数据来源
能力域 op 数/域名清单：解析 `host.ts` 的 `DB_OPS`；IPC 182/182/178：`npm run verify` 实跑；各岛域声明：`ui-plugins/*/manifest.json`；表结构：`electron/*-db.ts`；已有对账/分摊：`purchase-db.ts` 的 `reconciliation`/`shopAllocation`/`outstanding`/`costSnapshot`；阶段现状：`DOMAIN_INTEGRATION_PLAN.md` §4、`PRODUCT_LIBRARY.md` 进度表。

---

## 8. 追加勘察（2026-09-29 晚）
> 只**补事实与状态**，不改 §4–§6 裁定。

- **8.1 店铺：半闭环**——实体与映射通了，消费与归一没通：`sk_shops`/`sk_name_map` ✅、登记界面 ✅；但**跨域读 ❌**（`shop` 域只有 owner 声明，放行前必须先按 C4 拆只读子域）；历史文本归一 ⚠️（三处自由文本零改写，仅订单侧新数据闭环）；订单→店铺无 `shop_id`（唯一 ID 关联是 `pl_shop_sku.shop_id→sk_shops`）；店铺经营视图 ❌。还差三件：**① C4 拆只读子域+放行消费方（S2，含发版）→ ② 采购/AE 侧接归一 → ③ 订单侧写 `shop_id`**（导入时既已指定店铺，顺手写）。
- **8.2 拣货（P5/F4）：可实现且不需要 `pl_variants`**——"款×色×码"即 SKU 粒度，三样**订单侧都有**（`oi_images→oi_style_colors→oi_styles` JOIN、`oi_orders.color`/`size`、三层图回落、`pl_products.supplier_id`）；"数量"一期按 1 件但结算明细的 `商品数量` 是真值。**最短第一刀（零新域/零通道/零发版）**：在「订单利润」页统计维度加 `款×色×码`（`summarizeOrderCosts` 扩 dimension）→ 立刻得汇总表验证口径，确认后再做新域 `picking`。
- **8.3 两条新增的"可 join 但未接线"的键**：**订单号** `oi_orders.order_no`↔`ae_orders.order_id`↔`ae_settle_lines.order_no`（钱在结算/采集侧、店铺与发货在报表侧，两套源可 join 未接线）；**款式编码**已真贯通（五表同键）。
