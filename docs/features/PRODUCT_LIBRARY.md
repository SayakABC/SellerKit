# 跨境产品库（Product Library）— 设计与实施计划

> **状态**：🟢 P0 决策已冻结（D1 / D3 / D5 + op 契约口径）、P1 数据层已落地、P4a 成本口径改造已落地（均 2026-09-24）、P2 UI 已落地（2026-09-27）、**P3 映射与关联已落地（含 D1 款式主数据写入权移交）**（2026-09-27）、**1.2.0 增量：产品图片 + SKU/克重维护已落地**（2026-09-27）、**1.3.0 SKU 改「颜色+尺码」组合**（2026-09-27）、**1.4.0 供应商维护迁移 + 产品批量编辑**（2026-09-27）、**1.5.0 新增「商品清单」页签**（2026-09-29）、**🆕 2026-10-01 UI 整体收归内建，市场分发的 UI 岛已下架**（见下方 §0-A）（本文 **v8：P3 + D1 + 1.2.0 落地实测**，1.3/1.4/1.5 增量见进度表与 CHANGELOG）
> **读者**：架构 / 开发者
> **落点**：数据层在宿主主进程（`electron/product-db.ts` / `-handlers.ts` / `shopSku.ts` / `shop-product-db.ts`）；**界面 = 内建页「货与成本」**（`src/modules/goods/**`）。
> ⚠️ **2026-10-08 起界面是三个页签**：产品 / 映射与关联 / 供应商 —— 「商品清单」在界面上**收起**
> （判据：它写的池行没有下游消费者，见 [`2026-10-08-goods-page-entry-guide.md`](../notes/2026-10-08-goods-page-entry-guide.md)），
> 但**数据层与 IPC 一行未删**，本文 §1–§3、§5.1、§5.2、§6.2 对它的描述仍然准确。
> **前置阅读**：`docs/decisions/ADR-002-master-data-layer.md`（**已 Accepted，本文须服从其 C1–C4**）、`docs/plans/DOMAIN_INTEGRATION_PLAN.md`（S1–S4）、`AGENTS.md`（§1.2 / §1.9 / §6.2；红线 3、23）

---

## 0-A. ⚠️ 2026-10-01 状态更新：UI 收归内建，「产品库」UI 岛整体下架

**一句话**：产品库的**界面**不再是市场分发的 UI 岛，而是宿主内建「货与成本」页（原四个页签，2026-10-08 起收成三个 —— 见文首注记）；岛源码、市场条目、本机安装副本已全部下架；为岛拆的 5 个 `DB_OPS` 能力域（32 op）随之删除。**数据层一行未动** —— §4.1 论证过「UI 换在哪不影响任何一个消费方的数据供给」，这次迁移正是那句话的兑现。

| 原岛能力 | 现在的落点 | 原始实现（已下架，均在 `ui-plugins/product-library/src/components/` 下） |
| --- | --- | --- |
| 产品列表 / 检索 / 批量编辑 / 批量删除 | 「货与成本 › 产品」 | `ProductListView.vue` |
| 新增编辑（主图 + 颜色×尺码 SKU 子表） | 「货与成本 › 产品」编辑抽屉 | `ProductEditor.vue` |
| Excel 导入向导 / 导出 / 模板下载 | 「货与成本 › 产品」 | `ImportDialog.vue`；纯函数 `src/lib/productImport.ts` **未动** |
| 店铺商品池 + `item_id` → 产品一对多关联（套装） | 「货与成本 › 商品清单」 | `ShopProductView.vue` |
| 映射维护与待关联队列 | 「货与成本 › 映射与关联」 | `SkuMappingView.vue` |
| 供应商（厂家）主数据 | 「货与成本 › 供应商」 | `SupplierView.vue` |

**为什么能整体收回**：内建渲染层与主进程**同进程信任域**，直接调 `ipc.*` 即可 —— 岛时代的 `DB_OPS` 白名单（`security.ts` 只按岛自报的 `domains` / `actions` 放行）对它是多余的间接层，还多一份"两边实现迟早漂移"的风险。**契约零新增**：每一个岛 `op` 都一对一映射到既有 `ipc.*` 通道，只是渲染层缺了十来个导出包装函数，补齐即可。

**下架动作清单**（可审计）：

1. `ui-plugins/product-library/` 源码移入 `.workbuddy/retired/product-library-2026-10-01/` —— ⚠️ 该目录**原未入库**（`git ls-files` 为 0），删除**不可靠 git 回退**，故必须先备份再动；
2. `market-out/catalog.json` 移除条目 + 删除产物 zip，市场仓库提交推送（线上目录 **6 → 5 条**，`product-library-1.5.0.zip` 已 404）；
3. 本机已装副本 `~/Library/Application Support/seller-kit/plugins/product-library` 一并移入 retired 目录（否则 `pluginsScan` 仍会扫到一个无源可维护的孤儿岛）；
4. `scripts/product-library-ui-smoke.mjs` 与 npm 脚本 `product:sku:ui` 下线 —— 其断言**没有跟着丢**，已整组迁进 `scripts/goods-ui-smoke.mjs`（38 条，含一次性批量映射 / 不跨店铺串数据 / 未解析店铺不可点 / 标失效按行 id / 部分 patch 不发空字段）；
5. `src/core/plugin/host.ts` 的 `DB_OPS` 删除 `product`（8 只读）/ `product-admin`（10 写）/ `product-image`（4）/ `product-supplier`（4）/ `shop-products`（6），共 **32 op**，原位留墓碑注释（同 2026-09-30 的 `picking` 域先例）；
6. `tests/pluginTriage.spec.ts` 的 `product-library` 守卫组（8 条）删除，原位留墓碑指向新的落点。

**因此以下小节的描述属于"当时"，不再是现状**（保留作历史记录，勿据以改代码）：
§4.1（为什么 UI 选岛）、§5.3（共享只读域）、**§6.2（域表 —— 五个域已整组删除）**、§6.3（岛侧契约与 manifest）、§7.2–§7.5（岛的逐条验收记录）。
**仍然描述现状的是**：§1–§3（目标 / 业务链路 / 数据模型）、§5.1（C1 单点写入）、§5.2（C3 数据层在宿主中立层）、§6.1（宿主侧落点）。

---

## 实施进度（以代码为准，随提交更新）

阶段编号统一以 **§7** 为准（本表此前与 §7 编号不一致，2026-09-24 已归一）。
**执行顺序**：P0 ✅ → P1 ✅ → **P4a ✅** → P2 → P3 → P4 → P5。

| 阶段    | 内容                                                                                          | 状态          | 落点                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| P0      | 决策冻结（D1 / D3 / D5 + op 契约口径）                                                        | ✅ 2026-09-24 | 本文 §8                                                                                                         |
| P1      | 产品主数据层（`pl_products` 表 + CRUD + 汇总）                                                | ✅ 已落地     | `electron/product-db.ts`、`electron/product-handlers.ts`                                                        |
| P1      | IPC **四处**同步（handler / preload / `src/types.ts` / `src/core/services/ipc.ts`）           | ✅ 已落地     | 6 通道：`product-db-ensure` / `-list` / `-get` / `-upsert` / `-delete` / `-summary`                             |
| P1      | 共享域 `DB_OPS['product']`（**6 op**）                                                        | ✅ 已落地     | `src/core/plugin/host.ts`                                                                                       |
| P1      | 数据层冒烟（18 项 → 本轮扩到 **22 项**）                                                      | ✅ 通过       | `scripts/product-db-smoke.cjs`（`npm run product:smoke`）                                                       |
| **P4a** | **`ae_cost_map` 生效区间改造**（D5 裁定）：多行 + `effective_from` + 手工成本不被对账导入清掉 | ✅ 2026-09-24 | `electron/ae-db.ts` / `electron/ae-engine.ts` / **`electron/purchase-db.ts`**（快照源头，v4 漏项）              |
| **P2**  | UI 岛 `ui-plugins/product-library`（**只到款式级，不做变体** —— D3）                          | ✅ 2026-09-27 | `ui-plugins/product-library/`（独立 vite 工程，参照 `ui-plugins/ae-profit`）；逐条验收见 §7.2                   |
| P2      | Excel 解析 / 逐行校验纯函数（宿主侧，**岛内不打包 xlsx**）                                    | ✅ 已落地     | `src/lib/productImport.ts` + `tests/productImport.spec.ts`（24 例）                                             |
| P2      | `DB_OPS['product']` 6 → **8 op**（`importProducts` / `exportExcel`）                          | ✅ 已落地     | `src/core/plugin/host.ts`（⚠️ 见 §6.2 的上限说明）                                                              |
| P2      | IPC 四处同步（**+2 通道**：`product-import` / `product-export`）                              | ✅ 已落地     | `verify` **153≡153 / 149 通道**（`product-handlers` 11 通道，含 P4a 的商品克重 3 个）；类型检查 0 error         |
| P2      | 岛能力守卫（声明 ↔ 真实调用、dist ↔ src 一致）                                                | ✅ 已落地     | `tests/pluginTriage.spec.ts`（52 例；变异测试 14/14 命中 + 1 条对照）                                           |
| P2      | 发布到本地市场 + 真机冒烟                                                                     | ✅ 2026-09-27 | `market-out/product-library-1.0.0.zip`；`ui-island-smoke` **6/6** 岛握手与首屏正常                              |
| **P3**  | **`pl_shop_sku` 映射层 + 待关联队列 + 岛侧「映射与关联」页 + 订单导入接 `resolve`**           | ✅ 2026-09-27 | `electron/shopSku.ts`（纯函数）/ `product-db.ts`（映射层）/ 岛 `components/SkuMappingView.vue`；**D1 见下两行** |
| P3      | **D1 落地**：`pl_products` 成为款式主数据唯一权威，`oi_styles` 降级为识别编码池               | ✅ 2026-09-27 | `electron/order-db.ts`（写侧改走 product-db、读侧改派生、老库交接）+ `electron/purchase-db.ts`（2 处 JOIN）     |
| P3      | **订单导入接 `resolve`**：落单即查映射、命中就归款（消费方零改动，**不新增 op**）             | ✅ 2026-09-27 | `order-db.insertOrder` → `product-db.resolveOrderSku`；逐条验收见 §7.3                                          |
| P3      | `DB_OPS` 按 C4 **拆只读子域**：`product`（只读 6）+ `product-admin`（写 7）（**后经 1.2.0 / 1.4.0 增至 8 / 10，以 §6.2 为准**） | ✅ 2026-09-27 | `src/core/plugin/host.ts`；`verify` **166≡166 / 162 通道**（`product-handlers` 16 通道，当日快照）                        |
| P3      | 数据层冒烟（**22 项**，含 A/B/C/D 四组）+ 变异测试 **22/22**                                  | ✅ 通过       | `scripts/style-authority-smoke.cjs`（`npm run style:smoke`）                                                    |
| P3      | 岛 **1.0.0 → 1.1.0** 重发市场（新增两个 `db` 子域声明，必须升版才生效）                       | ✅ 2026-09-27 | `market-out/product-library-1.1.0.zip` + `market-out/catalog.json`；真机冒烟 **6/6** 岛（见 §7.3）              |
| **1.2.0** | **用户需求增量：产品图片（三层回落取图）+ SKU 子表与克重维护**（D3 部分提前，见 §3.1 注记） | ✅ 2026-09-27 | 3 张新表 + `product-image` 写域 4 op + 岛 1.2.0；逐条验收见 §7.4                                                |
| **1.3.0** | **SKU 改服装「颜色+尺码」组合**（尺码拖选批量生成；`pl_variants` 补列 color/size）          | ✅ 2026-09-27 | 见 §3.1 注记与 CHANGELOG；门禁全绿                                                                              |
| **1.4.0** | **供应商维护自「拿货对账」迁移入岛（新页签）+ 产品批量编辑（部分 patch）**                   | ✅ 2026-09-27 | 新域 `product-supplier` 4 op（复用 purchase-supplier-\* 通道）+ `product-admin` +`batchUpdate`（9→10 满额）+ `product-batch-update` 通道 |
| **1.5.0** | **新增「商品清单」页签**：Excel 导入店铺商品池（按 `item_id` 去重）+ 一件商品一对多关联产品（套装） | ✅ 2026-09-29 | 新域 `shop-products` 6 op（复用 `shop-product-*` 通道，零新通道）+ 岛 1.5.0 重发市场。**起因是 1.4.0 同版本号重发布导致本机永远拿不到该页签**（见 §7.5） |
| P4      | 成本维护界面（读写 `ae_cost_map`，显示 `source`）                                             | ⬜ 依赖 P4a   | —                                                                                                               |
| P5      | 拣货（按产品/色码聚合）—— **变体表在本阶段才建**                                              | ⬜ 依赖 P3    | —                                                                                                               |

**四处以代码为准、与下文计划不同**：

1. `pl_products` 字段收敛为 `code / name / supplier_id / category / status / note`；厂家**只存 id**，名称从采购域 `suppliers` 派生 —— 避免同一语义两个写入者（ADR-002 C1）。
2. `status` 枚举是 `active / archived`（§3.1 曾写 `discontinued`，已按代码更正）。
3. ~~`DB_OPS` **已按 C4 拆域**（2026-09-27）：`product` = 共享只读（**当前 8 op**），`product-admin` = owner 写（**当前 10 op，已满额**）~~ —— **该结论已于 2026-10-01 作废**：五个域整组从 `DB_OPS` 删除（见 §0-A），内建渲染层直接调 `ipc.*`，不再经桥。
4. P3 计划里的 `mapList` / `unmapped` 实际落地为 `skuList` / `skuQueue`，`resolve` **有意不建 op**（唯一消费者在主进程内）。理由见 §6.2（该节已成历史）。

---

## 0. v1 → v5 变更说明

本文经三次修正。**每次修正都是因为发现了前一版的事实性错误或与既有决策的冲突**（v4 还纠正了两处对代码的错误描述），记录在此以免读者以为结论是随意改的。

### v2（裁剪）：范围从"完整产品库"收敛到链路必需

| 维度   | v1                                                     | v2                                 | 原因                                           |
| ------ | ------------------------------------------------------ | ---------------------------------- | ---------------------------------------------- |
| 范围   | 12 张表（合规、多语言、图片、库存、关键词、刊登映射…） | 5 张表                             | 判据换成「是否参与 `订单 → 产品 → 拣货/利润`」 |
| 核心表 | `pl_listings`（平台刊登映射）                          | `pl_shop_sku`（店铺商品ID → 产品） | 目标是"订单里的商品ID对应我的哪个产品"         |

> v1 还犯了一个错：用 ADR-001 的判据（那是判**设置页归属**的）去推导**功能形态**。两者不是一回事。

### v3（对齐）：v2 有 5 处与 `ADR-002` / `DOMAIN_INTEGRATION_PLAN` 冲突

| #   | v2 的写法                               | 冲突对象                                                                                                     | v3 的修正                                                                            |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | 新建 `pl_cost_history` 作为产品库成本表 | **ADR-002 Q2**：「改 `ae_cost_map` 自身，**不新增第二套成本表**；产品库落地时是**迁移/合并**而不是另起一套」 | **删掉该表**。成本由 `ae_cost_map`（已加生效区间）承载，产品库只提供维护界面（§3.3） |
| 2   | "不需要 `DB_OPS` 登记"                  | **ADR-002 C3 / C4**：主数据的 schema 与 op 挂宿主中立层；跨域靠**共享只读域**                                | 补 `DB_OPS['product']`，并按 N5 一次定稿 op 清单（§5.3）                             |
| 3   | 18 个 op                                | **ADR-002 N5**：新域必须一次给出 owner + 访问模式 + op 上限（**≤10**）                                       | 收敛为 **10 个 op**，并标注读写权（§6.2）                                            |
| 4   | `pl_shop_sku.shop_id` → `sk_shop_sets`  | **ADR-002 S1**：店铺实体是新建的 `sk_shops`；`sk_shop_sets` 是**账号套装**（含凭据），两者不是一回事         | 指向 `sk_shops(id)`（§3.1）                                                          |
| 5   | 章节号与 v1 不一致                      | `DOMAIN_INTEGRATION_PLAN` / `ADR-002` 引用本文的 §2.3 / §3.2 / §4 P3·P5 / §5.3·§5.4                          | 提供**章节迁移对照表**（§11），并保留 §3.2 作为锚点章节                              |

### 同时被推翻的 v2 核心论据

v2 用"核心链路必经 → 不可卸载"论证"应随宿主分发"。核对后**这条不成立**：

> **订单导入时的自动关联逻辑在主进程**（导入 handler 内调 `pl_shop_sku` 查询），不在 UI 岛里。
> 因此**卸载产品库的岛不会破坏订单自动关联**，只是失去手工维护产品的界面。

论据被推翻后，形态结论改为随项目惯例（§4）。

### v4（决策冻结）：D1–D5 拍板 + 三处事实更正

| #   | v3 的写法                                                         | 问题                                                                                                     | v4 的修正                                                                                        |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | §5.1 路径 A =「改 `order-insight` 的建款逻辑」                    | **事实错误**：写 `oi_styles` 的三处全在主进程 `electron/order-db.ts`，岛侧一行都没有                     | 改为改主进程 `order-db.ts`；并说明**不需要**为此新增 `DB_OPS` op（同进程直接调 `upsertProduct`） |
| 2   | §5.3 `product` 域 owner = 产品库（`ui-plugins/product-library`）  | 与 §4.1「卸载岛不改变数据供给」自相矛盾                                                                  | owner 改为**宿主数据层** `electron/product-db.ts`                                                |
| 3   | §6.2 op 清单「10 个，一次定稿」                                   | 与代码实际的 **6 个**不符；且 `costAt`/`resolve`/`unmapped` 依赖未建的表与未做的改造，是**做不到的契约** | 收敛为「当前 6 op + P3 拟增补 4」，**以代码为准**                                                |
| 4   | §3.1 `status` 写 `discontinued`；「实施进度」表与 §7 阶段编号冲突 | 与代码 `PRODUCT_STATUSES` 的 `archived` 不符；两张表阶段号互相打架                                       | 按代码更正；阶段编号统一以 §7 为准                                                               |
| 5   | D5 被当纯"口径问题"                                               | **漏了数据丢失风险**：`costMapReplace` 是 `DELETE FROM ae_cost_map` 全表清空，会把手填成本抹掉           | D5 裁定**现在就改造**，新增 **P4a** 提到 P2 之前（§3.3 / §8.1）                                  |

**拍板结论**：D1 = 路径 A · D3 = 一期不要变体表 · D5 = 现在改造 `ae_cost_map` · op 契约收敛到代码现实。详见 §8。

### v5（P4a 落地）：实测又纠正了 v4 的 4 处错误预期

v4 的 §3.3「P4a 动作清单」是**纸上推演**，真开工后有 4 条与 SQLite / 代码现实不符 —— 均已按实际做法改写（§3.3）：

| #   | v4 的预期                                                                       | 实际                                                                                                                                                                                                       | 影响                                                                    |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | 主键改 `UNIQUE(style_code, effective_from)`；旧库 **不重建表**、走 `ALTER` 增量 | 主键必须是 **三列 `(style_code, effective_from, source)`**（否则 manual 与 purchase 不能同日并存）；而 SQLite **不能改主键**，`ALTER` 加不出复合唯一约束 → **必须重建表**（rename → create → copy → drop） | 迁移脚本比 v4 预估重；但存量数据零丢失（冒烟第 1 组 5 项覆盖）          |
| 2   | 改 `ae-engine` + `ae_cost_map` 两处即可                                         | **漏了快照源头** `electron/purchase-db.ts`：`costSnapshot()` 是 `GROUP BY style_code` + `MAX(biz_date)`，一款只导出一行 → 表支持多行也没用，**① 号验收标准根本不可能达成**                                 | v4 的工作量估少了 1 个文件；这是本轮最重要的发现                        |
| 3   | `ae-profit` 岛要显示 `source` + `last_biz_date`，**需发新版本**                 | 该岛**本就渲染 `source`**；快照 `lastBizDate` 直接当 `effective_from` 落库 → **数据流与 IPC 形状都不用改**                                                                                                 | **P4a 零岛侧改动、不升版本**（省掉一次发版）                            |
| 4   | 验收「改一条汇率不影响历史毛利」                                                | **做不到**：成本折 CNY 后确实不受汇率影响，但**订单收入**按当期 `ae_rates` 折算，汇率表没有生效区间                                                                                                        | 该条**从 P4a 验收移出**，如实标 ❌ 并归入 `ADR-002` Q2 后续范围（§7.1） |

**加上实现时补的一条规则**：`effective_from <= 订单日` 无命中时**回落最早一条成本**（v4 未写）—— 否则早于首次进货的订单会被判成缺成本，改造后毛利凭空少一块。

---

## 1. 目标与范围

### 1.1 一句话目标

让订单导入时**自动关联出产品**，从而支撑拣货（按产品/颜色/尺码聚合）与利润计算（按产品成本反算）。

产品库是**手段**，不是目的。判断任何字段/能力该不该进一期，只用一条判据：

> **它是否参与「订单 → 产品 → 拣货 / 利润」这条链路？**

### 1.2 一期做什么

| 能力         | 内容                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 产品维护     | 产品（款式）主数据：编码、名称、厂家、类目、备注                                     |
| 变体维护     | 颜色 / 尺码 / 规格 —— **拣货依赖它**。⚠️ **D3 冻结：不在 P2，推迟到 P5**（拣货阶段） |
| 成本维护     | 采购价、运费、包装、佣金率、汇率，**带生效日期**（落在 `ae_cost_map`，见 §3.3）      |
| 店铺商品映射 | 店铺 × 商品ID（× 规格）→ 产品（变体到 P5 才有）                                      |
| 待关联队列   | 未命中的订单行不丢、可批量人工确认、回写映射                                         |
| Excel 进出   | 产品/成本批量导入（含失败行隔离）、映射表导入导出                                    |

### 1.3 一期明确不做（见 §10）

多语言内容、图片素材库、平台刊登映射、合规资质、库存与补货、关键词库、供应商报价。不是不重要，是**不在这条链路上**。

---

## 2. 业务链路

```
订单导入（Excel / 平台报表）
   │  订单行：店铺 + 商品ID [+ 规格原文]
   ▼
查 pl_shop_sku（确定性映射，零成本）
   ├── 命中 ──► 产品 + 变体 ──► 拣货单（按产品/色码聚合）
   │                        └─► 利润计算（成本 × 汇率，交既有 ae-engine）
   └── 未命中 ─► 待关联队列 ─► 人工确认（支持按商品ID批量）─► 回写 pl_shop_sku
                                                              │
                                     下次同样的商品ID自动命中 ◄┘
```

**核心机制：关联率随使用单调上升。** 人工确认一次即沉淀为映射，后续同一商品ID永久自动命中。不做"一次性 AI 全自动识别"的承诺，做"确定性优先 + 人工沉淀"。

**与既有识别链路的关系**：`order-insight` 目前是「图片/字段 → AI 识别 → 款式指纹匹配」（`oi_images` / `oi_styles` / `oi_style_fingerprints`）。引入产品库后改为两步：

1. 先查 `pl_shop_sku`（确定性，零 API 成本）；
2. 查不到才走 AI 识别兜底。

---

## 3. 数据模型

**落点**：沿用现有单库 `userData/sellerkit.db`（`electron/db.ts`，WAL + `foreign_keys = ON`），**不新建库文件**。表前缀 `pl_`。

**类型约定**（对齐 `purchase-db.ts`）：金额一律 `_cents INTEGER`；日期/时间一律 `TEXT`；默认值 `datetime('now','localtime')`。

### 3.1 DDL（设计蓝图 4 张表；按 D3 / 阶段实际建表进度见下）

```sql
-- 产品（款式）主数据
CREATE TABLE IF NOT EXISTS pl_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                    -- 内部编码：锚点，永不复用、不可改
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  supplier_id INTEGER NOT NULL DEFAULT 0,       -- 软关联既有 suppliers(id)
  supplier_name TEXT NOT NULL DEFAULT '',       -- 冗余快照：厂家被删/改名后仍可显示
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',        -- active / archived（以代码 PRODUCT_STATUSES 为准）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pl_products_name ON pl_products(name);
CREATE INDEX IF NOT EXISTS idx_pl_products_supplier ON pl_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pl_products_status ON pl_products(status);

-- 变体（拣货按色/码聚合，依赖本表）
-- ⚠️ D3 原冻结"推迟到 P5"；**2026-09-27 部分提前**：用户明确要求"产品库要维护产品的 SKU 信息
--    以及每个 SKU 的克重"，故本表提前到 1.2.0 建表，但 DDL 与下方 P5 设计草案**不同**
--    （1.2.0 实际：name / code / weight_g / status，手工增删改，无 color/size/spec 拆列）。
--    **1.3.0 增量**：产品库只服务服装 SKU，UI 由"自由名称"改为「颜色 + 尺码」组合（尺码支持
--    拖动批量选择、颜色 × 尺码批量生成组合），故幂等补列 `color` / `size`（老库 `ALTER`，
--    判定 `PRAGMA table_info`）；color+size 成对时 name 自动生成为 "颜色 尺码"，组合唯一性
--    复用 `UNIQUE(product_id, name)` —— 老行（仅自由文本 name）不回填、不改写；
--    spec 拆列仍留给 P5（届时按拣货需求扩展，不改本表主键）。
--    部分唯一索引 `idx_pl_variants_code ON pl_variants(code) WHERE code <> ''`：
--    编码全局唯一但**空编码互不约束**（不是 UNIQUE 列，SQLite 不能给可空列挂 UNIQUE）。
CREATE TABLE IF NOT EXISTS pl_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES pl_products(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(product_id, color, size, spec)
);
CREATE INDEX IF NOT EXISTS idx_pl_variants_product ON pl_variants(product_id);

-- 店铺商品ID → 产品/变体 映射（本功能的核心表）
-- ⚠️ 建表时机 = P3（映射与关联）；P1 未建。
CREATE TABLE IF NOT EXISTS pl_shop_sku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT '',            -- amazon / shopee / temu / aliexpress ...
  shop_id INTEGER NOT NULL DEFAULT 0,           -- → sk_shops(id)（ADR-002 S1 新建的店铺实体）
  item_id TEXT NOT NULL,                        -- 店铺侧商品ID（ASIN / item_id）
  spec TEXT NOT NULL DEFAULT '*',               -- 店铺侧规格原文；'*' = 该商品下所有规格共用
  product_id INTEGER NOT NULL DEFAULT 0,
  variant_id INTEGER NOT NULL DEFAULT 0,        -- 0 = 仅到产品级（D3：一期恒为 0，变体表到 P5 才有）
  qty_per_item INTEGER NOT NULL DEFAULT 1,      -- 组合装：一个商品含几件（一期恒为 1）
  status TEXT NOT NULL DEFAULT 'confirmed',     -- confirmed / pending / invalid
  source TEXT NOT NULL DEFAULT 'manual',        -- manual / import / ai_suggest
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(platform, shop_id, item_id, spec)
);
CREATE INDEX IF NOT EXISTS idx_pl_shop_sku_lookup ON pl_shop_sku(platform, shop_id, item_id, status);
CREATE INDEX IF NOT EXISTS idx_pl_shop_sku_product ON pl_shop_sku(product_id);

-- 导入失败行（不丢行、可重试；沿用 oi_queue 的既有思路）
-- ⚠️ 建表时机 = P3（Excel 导入落地时）；P1 未建。
CREATE TABLE IF NOT EXISTS pl_import_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product',         -- product / variant / shop_sku
  row_no INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pl_import_errors_batch ON pl_import_errors(batch_no, resolved);
```

> **成本表不在此处** —— 见 §3.3。这是 v3 相对 v2 最重要的改动。

### 3.2 锚点关系（零迁移的关键）

```
oi_styles.code ─────┐
                    ├──► pl_products.code ◄── pl_variants.sku_code
purchase_items.style_code ─┘        │
ae_order_lines.style_code ──────────┘└──► pl_shop_sku
ae_cost_map.style_code ─────────────────────┘（成本，见 §3.3）
```

`style_code` 已贯通 `oi_styles`（UNIQUE）→ `purchase_items.style_code` → `ae_cost_map.style_code`（主键）→ `ae_order_lines.style_code`。产品库以 `pl_products.code` 承接**同一口径**：

- 不改动任何既有表；
- 不写数据迁移脚本；
- 订单域与利润域已有的款式编码立即可用。

> ⚠️ 引入第二套编码 = 必须写映射表 + 迁移脚本 + 改 `order-insight` 与 `ae-profit`。**不要这么做。**

**编码归一**：`sk_name_map`（ADR-002 S1 新建）的 `kind` 已预留 `product` 值 —— 历史文本形态的款式名经该表归一到 `pl_products.code`，**不改写历史文本列**（G2 裁定）。产品库不自建第二套名称映射。

### 3.3 成本口径（D5 已拍板：**现在就改造 `ae_cost_map`**，阶段 = P4a）

**ADR-002 Q2 已裁定：成本历史的落点是改 `ae_cost_map` 自身，不新增第二套成本表。** 因此：

| 事项           | 落点                                                                |
| -------------- | ------------------------------------------------------------------- |
| 成本存储       | `ae_cost_map`（**P4a 改造后**加 `effective_from`，可多行/款）       |
| 产品库的角色   | **只提供维护界面**，读写 `ae_cost_map`，不建自己的成本表            |
| 取成本语义     | 按**订单业务日期**匹配区间：`effective_from <= 订单日期` 取最近一条 |
| 历史毛利可复算 | 由此保证（Q2 的目标）                                               |

#### ⚠️ 改造前的真实状态（v3 曾误写为"已加 `effective_from`"）

| 项       | 现状（2026-09-24 读代码确认）                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 表结构   | `ae_cost_map` 主键是 **`style_code TEXT PRIMARY KEY`** —— **一款一行，没有 `effective_from`**               |
| 写入函数 | `electron/ae-db.ts` 的 `costMapReplace` 是 `DELETE FROM ae_cost_map` **全表清空**后重灌 `source='purchase'` |
| 取数     | `electron/ae-engine.ts:176` 读**全表**成 `style_code → unit_price_cents` 的字典，不区分业务日期             |
| 后果     | **手工成本没有容身之处**：产品库一旦开放成本录入，下一次拿货对账导入就把它整表抹掉                          |

#### P4a 已落地（2026-09-24）—— 与 v4 动作清单的差异已标注

| #   | v4 动作清单（计划）                                                           | 实际做法（**以代码为准**）                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~`UNIQUE(style_code, effective_from)`~~，旧库 **不重建表**，走 `ALTER` 增量  | ❌ **两处都改了**：SQLite **不能改主键**，`ALTER` 加不出复合唯一约束，故必须**重建表**（`rename → create → copy → drop`，整体在事务内）；且主键是 **`(style_code, effective_from, source)` 三列** —— 含 `source` 才能让同 (款, 生效日) 的 manual 与 purchase **并存**，再由读取侧定优先级（两列 UNIQUE 会把 manual 挤成覆盖 purchase）。迁移幂等判定 = `effective_from` 列是否存在（`electron/ae-db.ts` 的 `migrateCostMapIntervals()`） |
| 2   | `DELETE` 不清 `source='manual'`                                               | ✅ 按计划落地：`DELETE FROM ae_cost_map WHERE source='purchase'`；同 `(款, 生效日, 来源)` 用 `ON CONFLICT DO UPDATE` 覆盖写，重复导入不产生重复行                                                                                                                                                                                                                                                                                        |
| 3   | `ae-engine` 改按业务日期取成本（逐次查询 **或** 预取区间内存匹配）            | ✅ 取**预取区间 + 内存匹配**（避免 N+1）。另补一条 v4 未写的规则：`effective_from <= 订单日` 无命中时**回落最早一条**，不把历史订单判成缺成本（否则改造后老订单毛利会凭空少一块）                                                                                                                                                                                                                                                        |
| 4   | `ae-profit` 岛的成本列表要显示 `source` + `last_biz_date`，**该岛需发新版本** | ⚠️ **实测不需要发版**：该岛本就渲染 `source` 列；快照里的 `lastBizDate` 直接作为 `effective_from` 落库，**数据流与 IPC 形状完全不变**（无需扩 `domains`，也无需改 manifest）。故 **P4a 零岛侧改动**                                                                                                                                                                                                                                      |
| 5   | 新增成本冒烟（或并入既有 ae 冒烟）                                            | ✅ `scripts/ae-cost-smoke.cjs`（`npm run ae:smoke`）**13 项**全绿                                                                                                                                                                                                                                                                                                                                                                        |
| ➕  | **（v4 漏项，实测才发现）**                                                   | ❗ **必须同步改快照源头** `electron/purchase-db.ts` 的 `costSnapshot()`：它原为 `GROUP BY style_code` + `MAX(biz_date)`，一款只导出一行 → 表虽支持多行，导入进来仍只有一条区间，**① 号验收标准（跨两次进货分别按当时成本）不可能达成**。已改为 `GROUP BY style_code, biz_date`                                                                                                                                                           |

**残余（P4a 明确未覆盖，勿误认为已解决）**：

- **汇率的生效区间**（`ae_rates`）未做 —— 「今日改一次汇率，历史毛利跟着变」**这条仍在**。属 `ADR-002` Q2 的后续范围。
- `ae-profit` 岛顶部 `snapInfo.lastBizDate` 取 `items[0].lastBizDate` 当"最近业务日"显示；快照一改多行后
  它变成"第一行的拿货日"，**是纯文案漂移、不影响数字**（归 P4 的界面改版顺手修）。
- 手工成本的**写入口**只到数据层（`ae-db.costMapUpsertManual`），未接 IPC / host op —— 界面与 op 一起归 P4。

```sql
-- 取某款式在某业务日期生效的成本
SELECT * FROM ae_cost_map
WHERE style_code = ?
  AND effective_from <= ?
ORDER BY effective_from DESC
LIMIT 1;
```

**两个必须写清的口径问题**：

1. **手工录入与采购聚合共用一个权威表**（C1 单点写入）。`ae_cost_map.source` 已有 `purchase` 值；手工录入写 `manual`。**同一 `(style_code, effective_from)` 上 manual 优先**，避免"用户在界面上改了成本、下次采购对账导入又把它盖掉"。
2. **变更来源需可见**。界面要显示每行成本的 `source` 与 `last_biz_date`，否则用户无法判断"这个价是我填的还是系统算的"。

> **为什么一期不建 `pl_cost_history`**：那会形成两套成本表，违反 ADR-002 Q2 的"不新增第二套"与 C1 的"单点写入"。
> **终态**：`ae_cost_map` 的域归属是历史遗留（`ae` 是混合域，ADR-002 §5 已注明"后续可拆 `ae-order` + `cost-rate`"）。
> 将来拆出 `cost-rate` 域时，成本表随之改名 —— 产品库届时跟着换域，**但不换语义**。

### 3.4 `pl_shop_sku` 与 `sk_name_map` 的分工（不要混淆）

两者都是"把外部的标识归一到主数据 ID"，但**键不同、场景不同**：

| 表                          | 键                                          | 解决什么                                                                    |
| --------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `sk_name_map`（ADR-002 S1） | `kind` + `raw` 文本                         | 历史**文本**（店名、款名）→ 主数据 ID。例：`"十店"` → `sk_shops.id`         |
| `pl_shop_sku`（本文）       | `platform` + `shop_id` + `item_id` + `spec` | **平台商品ID** → 产品。例：`amazon/US/店铺3/B0XXXXXXXX/spec` → `product_id` |

- `sk_name_map` 的 `raw` 是**人写的文本**，靠精确匹配 + 人工指派（G6：模糊匹配永不自动写 `ref_id`）。
- `pl_shop_sku` 的 `item_id` 是**平台生成的标识**，本身就是稳定键，不需要模糊匹配 —— 未命中进待关联队列由人工确认。

### 3.5 `pl_shop_sku` 的三个现实约束

1. **`spec='*'` 通配是必需的**。部分平台报表只给商品 ID 不给规格，一刀切要求规格会导致整批命不中。
2. **商品 ID 会变**（Amazon 合并 listing、下架重建），映射标 `status='invalid'` 而**不是物理删除** —— 否则关联率会莫名回落且查不出原因。
3. **人工确认必须支持批量**。首次导入 500 行未命中是常态；按商品 ID 批量关联，一次确认覆盖该商品的所有历史行。

### 3.5.1 人工核对的**回流**：订单归类页的结论回写这张表（2026-10-05）

归类的正确顺序是 **映射 → 指纹 → 模型**，而**前两层早就建好了**。真正缺的是：
**人在「今天 › 归类核对」页做的判断没有回流到确定性层** —— 那一页写的是**指纹 → 款**
（`oi_style_fingerprints`），而指纹只覆盖"图长得一样"的单，**商品ID** 才覆盖"同一件商品的每一单"。

不回流的样子：某个商品被人工判对 10 次，第 11 条订单**照样进待核对队列**（人工工作量不随时间递减）。
量级参考：真实库上 42 行订单的商品 ID **去重后只有 17 个** ⇒ 十几条映射就能覆盖绝大多数行。

| 事 | 落点 |
| --- | --- |
| 触发点 | 「归类核对」页在**下拉里点名某个款**（`order-style-assign`）—— 这是本页唯一"对商品下结论"的动作 |
| 写入 | `skuBackfillFromOrder()`（`electron/order-db.ts`）→ 复用 `upsertSkuMappings()` 写 `(平台, 店铺, 商品ID) → 款 + 色`，`status='confirmed'` |
| 回填 | 写成功后立刻 `reassignOrdersByItemIds([itemId])`：该商品**存量未归款**的订单当场一起归好（否则用户看不出"记住了"发生过） |
| 回执 | 随 `order-style-assign` 的返回带上 `skuBackfill`（8 种 `status`），界面按它说清"记住了 / 为什么没记住" |

**消费它的三个"不"**（都为了不替人下结论、不放大单次判断的影响面）：

1. **不覆盖**：该 `(店铺, 商品ID)` 已有生效映射且指向**别的产品**时，只回报 `conflict`、一行不动。
   理由不是保守，是**影响面不对等** —— 在这里顺手改绑等于让那个商品**所有**（含历史）订单一起改判，
   而用户此刻只看了眼前这一单。要改绑请到「货与成本」的映射清单（那里会说清影响几行）。
2. **颜色只填不猜**：颜色为空 / 是兜底占位（`未分类`）时只记到**款级**（`spec='*'` = 色从订单取），
   不把"还没定"固化成该商品的颜色（固化之后再也回不到"从订单取"）。
3. **失败不外抛**：这是"顺手记住"的**附加**动作，绝不能把**已经提交**的"归属已改"报成失败 ⇒
   `skuBackfillFromOrder` 任何分支都不抛，界面也必须把"归属"与"记住"分两句说。

**没覆盖到的**（写在前面免得被当成"已经解决了"）：只改品类/颜色那次（`targetStyleId === 0`）不触发回流
—— 那一路的结论是**指纹**的，不是对商品的判断；`确认无误` 同理（它是"这条没问题"，而且「全部确认无误」
会把它变成批量落库，正是 2026-10-05 删掉的那类风险）。

### 3.6 1.2.0 新增：图片三表与三层回落取图（2026-09-27）

| 表               | 关键列 / 约束                                                            | 承载什么                                                                 |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `pl_products.image_id` | 新增列（`ALTER TABLE`，幂等判定 `PRAGMA table_info`）                     | 产品（款）主图，**手动上传为主**                                        |
| `pl_images`      | `fingerprint UNIQUE`（SHA-256，去重）+ `local_path`                       | 产品图片文件索引；文件落 `userData/product-images/`（**独立目录**，见下） |
| `pl_item_images` | `item_id` 主键（经 `toSkuKey` 归一存储）                                  | 商品ID 维度的**覆盖图**（手动上传，最高优先级）                          |
| `pl_variants`    | `product_id` 外键 + 部分唯一索引 `idx_pl_variants_code (code) WHERE code <> ''` | SKU 子表：name / code / **weight_g** / status（1.2.0）+ **color / size**（1.3.0 幂等补列；成对时 name 自动生成"颜色 尺码"），手工增删改（§3.1 注记）  |

**为什么产品图不复用 `oi_images`**：订单域的孤图清理（`order-cleanup-orphan-images`）会删"没有订单引用"的图 —— 产品主图挂上去会被**误删**。产品图独立落 `userData/product-images/`，读取侧白名单按目录集合收敛（`order-handlers` 的 `IMAGE_CACHE_DIRS = Set(['order-images','product-images'])`）。

**映射页「图」列的三层回落**（`itemImagePool` 一次算好，岛侧只挑首选）：

```
pl_item_images 覆盖图（手动上传）
  → 订单识别图（oi_orders.raw_fields 商品ID 命中 → oi_orders.image_id → oi_images.local_path）
  → 款主图（pl_shop_sku confirmed 映射 → pl_products.image_id → pl_images.local_path）
```

逐 item 独立判定；每 item 最多取 3 张订单图。岛 CSP 只有 `img-src 'self' data:` —— 远程图必须走宿主落盘 + `imageThumbBatch` 转 base64 dataUrl（批量上限 40，单项失败置 `null`，界面显示空占位）。上传走 `select-image` 通道（系统对话框选中的文件才进 `approveUserFile` 白名单，H-02 语义）。

---

## 4. 形态决策：内置还是插件

三层答案不同，**第二层在 v3 中被修正**。

| 层                                                                   | 结论                                                            | 依据                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **数据层**（`electron/product-db` + handlers + `DB_OPS['product']`） | **必须在宿主主进程**（不是选择题）                              | ADR-002 **C3**：主数据的 schema 与 op 挂宿主中立层，不挂在可卸载的 UI 岛上。先例：`ae-profit` 下记为岛，但接收端 `ae-receiver` 永久留主进程 |
| **UI 层**                                                            | ~~市场分发 UI 岛~~ → **内建页「货与成本」**（2026-10-01 改，见 §0-A） | 见 §4.1（当时的论证，已不适用）                                                                                                             |
| **表结构归属**                                                       | `pl_*` 与 `sk_shops` / `sk_name_map` **同属主数据层**，一份清单 | ADR-002「When to revisit」第 4 条                                                                                                           |

### 4.1 为什么 UI 选岛（以及 v2 为什么错）

> ⚠️ **本节已成历史**（2026-10-01 UI 收归内建，见 §0-A）。保留是为了说明**当时**的取舍依据与代价估算 ——
> 其中"代价"第 ① 条（不能用宿主 Vue 组件，要自己实现虚拟滚动表格 / 批量编辑 / 导入向导）正是
> 四天后把它收回来的直接原因：这些交互在宿主侧全都有现成实现，重写第二份只会让两边慢慢分叉。

v2 主张"随宿主分发"，四条理由经核对后**三条被削弱或推翻**：

| v2 的理由                        | 核对结果                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| ① 核心链路必经 → 不可卸载        | ❌ **不成立**：自动关联逻辑在主进程，卸载岛不破坏关联，只是失去维护界面  |
| ② 关联是高频批量操作，岛有桥开销 | ⚠️ **削弱**：高频关联发生在主进程的导入 handler 内，不经过岛的桥         |
| ③ 主数据变更需宿主级广播         | ❌ **不成立**：ADR-002 **G7** 已裁定"跨域事件本轮不做"，消费方靠显式调用 |
| ④ 岛要独立构建工程，开发成本高   | ✅ **仍成立**：这是唯一没被推翻的成本，见下方"代价"                      |

修正后的结论 —— 选岛的三条正面理由：

1. **与项目惯例一致**。`excel-copy` / `order-insight` / `shop-accounts` / `ae-profit` / `shipping-rate` 五个业务功能**全部**是市场岛；`modules.config.json` 的注释也写明"2026-09-22 起全部业务功能已下记为市场分发的 UI 岛"。
2. **产品库与 `shop-accounts` 同构** —— 都是"主数据维护台"。`shop-accounts` 维护 `sk_companies` / `sk_shop_sets`，产品库维护 `pl_products` / `pl_shop_sku`，形态应当一致。
3. **它会长期演进**。店铺商品ID 的匹配规则随平台变化（新增平台、规格字段差异），独立发版避免每次都发整个宿主。

**代价（必须知道）**：

- 岛是 iframe + `__sk` 桥，**不能用宿主 Vue 组件**，虚拟滚动表格 / 批量编辑 / 导入向导要自己实现；
- 建议参照 `ui-plugins/ae-profit` 的**独立 vite 工程形态**（`src/` + `dist/` + `manifest.json`），而不是 `excel-copy` 的手写 ESM —— 产品库的交互复杂度高于 excel-copy。

### 4.2 红线 23：id 的锁死与可逆性

> **2026-10-01 后续**：`product-library` 这个 id 已随岛下架而**释放**，`modules.config.json` 至今未登记它
> （本来也不该登记）。若将来再把某个功能下记为岛，仍按本节的两条来判。

`ui-plugins/*` 的 id **不得**登记进 `modules.config.json` 的构建预设 —— 内建/随宿主记录会占用同名 id，导致市场同名岛永远注册不上（`pluginManager.registerUiIsland` 遇同名记录跳过）。这正是 `order-insight` 曾经的形态。

反过来：如果将来确实需要随宿主分发，走"下记"的反向操作（把 id 加进预设）是可行的，但需要**重写 UI 层**（岛 → 宿主 Vue 组件）—— 所以**形态是一次性决策，本次要定死**。

---

## 5. 与 ADR-002 三条硬约束的落实

ADR-002 的 C1–C4 是本文必须服从的上位规则。逐条落点：

### 5.1 C1 单点写入 —— 款式主数据写入权（✅ D1 已冻结：路径 A）

**问题**：现状 `oi_styles` 由订单归类写入（识别建款 / 手工指派 / 导入），`DOMAIN_INTEGRATION_PLAN` §2.1 也确认它是当前"款式"的权威来源。产品库上线后用户会直接维护 `pl_products` —— **两个写入方，违反 C1**。

**✅ 冻结结论（2026-09-24，D1 = 路径 A）**：**`pl_products` 是款式主数据的唯一权威；`oi_styles` 降级为「识别编码池」。**

| 项       | 裁定                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| 权威表   | `pl_products`（业务字段 `name` / `category` / `supplier_id` / `status` / `note`）                       |
| 降级表   | `oi_styles` 只保留识别私有信息（`fingerprint` 主指纹 UNIQUE、`oi_style_fingerprints` 多指纹、色码归属） |
| 关联键   | `oi_styles.code` ≡ `pl_products.code`（同口径，见 §3.2），两表**靠 code 关联**，不引入映射表            |
| 落地位置 | **`electron/order-db.ts`**（主进程）的建款逻辑改为写 `pl_products`；**改期 = P3**（与订单关联同批）     |

**⚠️ 两处事实更正（v3 写错了，会直接误导工作量估算）**：

1. **要改的不是 `order-insight` 岛，是主进程 `electron/order-db.ts`**。写 `oi_styles` 的三处（`INSERT INTO oi_styles` /
   `UPDATE oi_styles` / `DELETE FROM oi_styles`）**全在主进程，岛侧一行都没有** —— 所以这活不进岛工程、不涉及岛发版。
2. **不需要为 D1 新增 `DB_OPS['product']` 的 op**。`order-db.ts` 与 `product-db.ts` 同在主进程，直接
   `import { upsertProduct } from './product-db'` 调用即可；`DB_OPS` 白名单只约束**渲染层 / 岛侧**。
   这样 C1 意义上的唯一写入方仍然是 `product-db`，且**不会动到消费方岛的 op 契约**（§6.2）。

**✅ 遗留待定项已落定（2026-09-27，P3 实施时）：`oi_styles.name` 保留列，但**双向退役** —— 既无写入方，也无读取方。**

先查清了真实读点（**不是** v4 写的两处，实际 5 处活读点）：

| 读点                                                    | 处理                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `order-db.listStyles`（→ `order-insight.styleList` op） | 改 `LEFT JOIN pl_products` 取 `p.name`                                      |
| `order-db.listOrdersPage` 的 `style_name`               | 同上（订单列表 / 数据纠正页的款名）                                         |
| `order-db.listOrdersPage` 的**搜索条件** `s.name LIKE`  | 改 `p.name LIKE`（漏了这条 = 按款名搜不到）                                 |
| `purchase-db` 待拿货缺口 / 来源订单行的 `style_name`    | 同上（**采购域也是消费方**）                                                |
| `order-insight` 岛的「产品库」页                        | 经 `styleList` / `styleRename` / `styleImport` 落在上面四处，**岛侧零改动** |

> ⚠️ v4 写的"`order-insight` 的「数据纠正」页在用 `name`"是**误判**：该岛走的是
> `db('order-insight', 'styleList')`，不直接读 `oi_styles`；而 `order-style-*` 那批 IPC 通道
> 其消费者是已下记的**内建视图包**（`extensions/order-insight/` 仅为源码留档，见 `vite.config.ts:17`）。

**为什么保留列而不 DROP**：删列要重建 `oi_styles` 表，而 `oi_style_colors` / `oi_style_fingerprints`
两张表都 `REFERENCES oi_styles(id)`——为一个**没有业务价值的列**做不可逆结构手术，风险收益倒挂。

**怎么保证它不会变成第二写入方（C1 的关键）**：

1. 写侧一律写**空串哨兵**（`INSERT INTO oi_styles (code, name, fingerprint) VALUES (?, '', ?)`），
   名字只写 `pl_products`；哨兵**不携带信息**，因此结构上不可能与主数据分叉。
2. 启动时一次性**交接**：历史库的 `oi_styles.name` 灌进 `pl_products`（缺哪补哪，已有产品不动），
   随后把遗留列**清空**（`migrateStyleAuthority`，**同一事务**，幂等）。
3. 四条守卫钉住它（`style:smoke` 的 A / B / C 三组）：
   **看列本身**（`SELECT name FROM oi_styles`，不是接口返回名，否则等于自己考自己）；
   前四个读点**各配一条**「改主数据 → 该出口跟着变」；
   读不到时**回落空名而不是回落遗留列**（回落了就等于交接白做）。逐条证据见 §7.3。

### 5.2 C3 数据层在宿主中立层

✅ 已落实：`electron/product-db` + `electron/product-handlers` + IPC **四处**同步（主进程 handler / `electron/preload.ts` /
`src/types.ts` / `src/core/services/ipc.ts`）。

> ⚠️ 是**四处**不是三处：`src/types.ts` 的 `ElectronAPI` 与 `src/core/services/ipc.ts` 的 `ElectronApi` 是
> **两份手写声明**。`npm run verify`（`scripts/check-ipc-contract.mjs`）只校验前者，漏掉后者时 `verify` 仍全绿、
> 只有 `vue-tsc` 才报 `Property 'xxx' does not exist on type 'ElectronApi'`。

### 5.3 C4 共享只读域（`DB_OPS['product']`）

> ⚠️ **本节已成历史**（2026-10-01 该域整组删除，见 §0-A）。保留是因为**拆域的判据本身没过时** ——
> `security.ts` 的 `decidePermission` 只按岛自报的 `domains` / `actions` 放行且两者独立检查，
> 所以将来再给岛开放产品读写，仍必须拆"只读子域 + owner 写子域"。删掉的只是**当时那个岛**的实例。

`DB_OPS`（`src/core/plugin/host.ts`）新增 key `product`（ADR-002 **N5**：op 上限 10，**当前 6**），供订单归类、利润追踪等岛只读消费。消费岛各自在 manifest 的 `capabilities[db].domains` 加 `"product"` 并**发一次新版本** —— `security.ts` 的 per-plugin 授权模型**零改动**。

**访问模式**（ADR-002 N2 要求登记 owner 与 rw/ro）：

| 域        | owner（唯一写入方）                                   | 共享只读范围（P3 已落地）                                          |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `product` | 宿主数据层 `electron/product-db.ts`（岛只是维护界面） | `list` / `get` / `summary` / `skuList` / `skuSummary` / `skuQueue` |

> ⚠️ **owner 是宿主数据层、不是岛**：`pl_products` 的 schema 与写入函数挂主进程（C3）。卸载
> `ui-plugins/product-library` 只失去维护界面，**不改变任何一个消费方的数据供给** —— 这正是 §4.1 论证
> "UI 选岛"的前提；若把 owner 写成岛，逻辑就自相矛盾了。

---

## 6. 落点

### 6.1 宿主侧

> 「✅」= P1 已落地；「待建」= 后续阶段新建。此表按模块名不带扩展名书写 —— 待建文件无法通过
> `scripts/check-doc-links.mjs` 的路径解析，写成全名会报悬空引用。

| 文件                                    | 状态 | 内容                                                                                 |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `electron/product-db`                   | ✅   | `ensureProductSchema()`（`dbMigrate`）+ 查询/写入/汇总函数（当前仅 `pl_products`）   |
| `electron/product-handlers`             | ✅   | 经 `electron/ipc-util.ts` 的 `register`/`handle` 注册通道，**不新写注册封装**        |
| `electron/main.ts`                      | ✅   | 启动时 `require('./product-handlers')`（第 39 行）                                   |
| `electron/preload.ts`                   | ✅   | 每通道一个方法                                                                       |
| `src/types.ts`                          | ✅   | 同步 `ElectronAPI` 接口（`npm run verify` 会拦截遗漏）                               |
| `src/core/services/ipc.ts`              | ✅   | 渲染层通道封装 —— **`ElectronApi` 接口 + 末尾导出函数两处都要加**（§5.2 注）         |
| `src/core/plugin/host.ts`               | ✅   | `DB_OPS['product']` 登记（§6.2）                                                     |
| `electron/order-db`                     | 待建 | P3：建款逻辑改为写 `pl_products`（D1 = 路径 A，见 §5.1）                             |
| `electron/ae-db` / `electron/ae-engine` | ✅   | **P4a 已落地**：`ae_cost_map` 多行 + `effective_from` + 引擎按业务日期取成本（§3.3） |
| `electron/purchase-db`                  | ✅   | **P4a 已落地**：`costSnapshot()` 改按 `(款, 拿货日期)` 分组（v4 漏项，见 §3.3）      |
| `scripts/ae-cost-smoke.cjs`             | ✅   | P4a 回归（13 项）：`npm run ae:smoke`                                                |

### 6.2 ~~`DB_OPS` op 清单~~ **（五个域已于 2026-10-01 整组删除）**

> ⚠️ **本节描述的能力域已全部删除**（见 §0-A 第 5 条）。下表与后续论证保留作**历史记录**：
> 它记下了 ADR-002 N5 的 op 预算如何在真实演进中被反复顶穿、以及每次被迫拆域的具体触发点 ——
> 这些数字对"将来再开岛时要预留多少预算"仍然有参考价值。
>
> **现状**：`src/core/plugin/host.ts` 的 `DB_OPS` 里已没有 `product` / `product-admin` /
> `product-image` / `product-supplier` / `shop-products` 这五个 key，原位是一段墓碑注释。
> 内建「货与成本」走 `ipc.*` 直连，通道与数据层**一行未改**。

**P0 冻结项（§8-4）**：文档此前写的 10 op 是**设计蓝图**，代码实际是 6 op（P1）+ 2 op（P2 的导入导出）= **8 op**，
再加 P3 的 5 个 = 13 —— 顶穿了 ADR-002 N5 的 op 上限（10）。**已按 C4 拆域**（2026-09-27 落地）。
**1.2.0 再拆出 `product-image` 写域**：variant 2 op 加进 `product-admin` 已 7→9，图片 4 op 若并入必顶穿 10 ——
图片写域独立（下表），`product` 只读域补 2 个新读 op（6→8）：

| 域                 | 定位                           | op 数 | op 清单                                                                                                        |
| ------------------ | ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------- |
| `product`          | **共享只读**（消费方岛接这个） | 8     | `list` · `get` · `summary` · `skuList` · `skuSummary` · `skuQueue` · `variantList` · `itemImagePool`           |
| `product-admin`    | **owner 写**（仅产品库岛用）   | **10（满额）** | `ensure` · `upsert` · `delete` · `importProducts` · `exportExcel` · `skuMap` · `skuInvalidate` · `variantUpsert` · `variantDelete` · `batchUpdate`（1.4.0）—— **再加任何 op 必须先拆子域** |
| `product-image`    | **图片写**（仅产品库岛用）     | 4     | `attach` · `detach` · `itemSet` · `itemClear`                                                                  |
| `product-supplier` | **厂家主数据**（1.4.0 新增；owner = 宿主 `purchase-db.ts` 的 `suppliers` 表） | 4 | `list` · `create` · `update` · `delete`（复用既有 `purchase-supplier-*` IPC 通道，零新通道；不声明 24 op 的 `purchase` 万能域） |
| `shop-products`    | **商品清单**（1.5.0 新增；owner = 宿主 `shop-product-db.ts`，复用 `pl_shop_sku` 扩展视图） | 6 | `import` · `list` · `delete` · `relations` · `relationAdd` · `relationDelete`（复用既有 `shop-product-*` IPC 通道，零新通道） |

**拆域为什么是必须的（不是洁癖）**：`security.ts` 的 `decidePermission` 对 db 能力**分别检查**
「`domains` 含不含」与「`actions` 含不含」，**两者彼此独立** —— 写 op 与读 op 同域时，消费方只要声明
这个域就够得着全部 op，"我只读"只能靠自觉。移出后它变成**结构事实**，不再依赖评审。

**P3 计划里的三个 op 与实际的差异（以代码为准）**：

| 计划名     | 实际落点                                                                       | 为什么                                                                                                             |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `mapList`  | `product.skuList`（改名）                                                      | 与库表 `pl_shop_sku` 的 `sku` 前缀对齐                                                                             |
| `unmapped` | `product.skuQueue`（改名）                                                     | 同上；且它是**实时聚合**（扫 `oi_orders.raw_fields` − 已生效映射），不是缓存表（同 `shop-db.listUnmapped` 的理由） |
| `resolve`  | **不建 op**：主进程内 `order-db.insertOrder` 直调 `product-db.resolveOrderSku` | 渲染层 / 岛侧**零调用点** —— 按"不为没有消费者的契约预留白名单"先例（同 §5.1 对"同进程直调"的处理）                |

`costAt` 仍未实现（依赖成本口径改造后的读取侧，归 P4a 后续）。

**为什么必须粗粒度**：`domains` 是岛**自报**的白名单，消费方接入时要复制 op 名到自己的 `actions` 并**发版**。
op 越细，接入一个消费方就要改一次 manifest（`skuQueue` 特意做成"批量聚合 + 汇总输出"，避免消费岛逐个查询）。

**预算核对**：两个域各自 ≤ 10，均**未**登记进 `pluginTriage` 的 `GRANDFATHERED` 豁免表 ——
那里有一条反向断言：预算内的域一旦出现在豁免表里就会变红（防豁免滥化）。

### 6.3 岛侧

> ⚠️ **本岛已下架**（2026-10-01，见 §0-A）。本节记录的是它**当时**的工程形态与 manifest 声明，
> 保留价值在于：将来再开岛时可直接照抄这份"capabilities ↔ 真实调用"的对照表与守卫写法
> （守卫本体曾是 `tests/pluginTriage.spec.ts` 的 `product-library` 组，已随之删除、原位留墓碑）。

`ui-plugins/product-library/`：独立 vite 工程（`src/` + `index.html` + `vite.config.mjs` + `dist/` + `manifest.json`），参照 `ui-plugins/ae-profit/`。`manifest.json` **实际**声明（2026-09-27，**1.2.0** 起）：

```json
{
  "version": "1.2.0",
  "capabilities": [
    { "id": "dialog", "actions": ["openFile"] },
    {
      "id": "db",
      "domains": ["product", "product-admin", "product-image", "order-insight"],
      "actions": [
        "list",
        "summary",
        "skuList",
        "skuSummary",
        "skuQueue",
        "variantList",
        "itemImagePool",
        "ensure",
        "upsert",
        "delete",
        "importProducts",
        "exportExcel",
        "skuMap",
        "skuInvalidate",
        "variantUpsert",
        "variantDelete",
        "attach",
        "detach",
        "itemSet",
        "itemClear",
        "imageThumbBatch"
      ]
    }
  ]
}
```

> ⚠️ **`order-insight` 域只声明 `imageThumbBatch` 一个 op**（缩略图合批长在该域下）；曾误声明成整个
> `order` 域 —— 宿主 DB_OPS 里根本没有 `order` 这个键（叫 `order-insight`），pluginTriage 立即变红。
> 另：`attach`/`detach`/`itemSet`/`itemClear` 之外还有个单张的 `imageThumb` op，**有意不声明**
> —— 声明了就必须真调用，本岛批量场景用不到它。

**岛侧 `api.js` 的形态与域一一对应（守卫靠这个解析）**：

```js
/** `product` 共享只读子域（消费方岛来接的也是这个） */
export const plib = (op, payload) => db('product', op, payload);
/** `product-admin` owner 写子域（本岛是唯一 owner；写 op 不进共享域） */
export const plibAdmin = (op, payload) => db('product-admin', op, payload);
```

`pluginTriage` 有两条按此形态写的反向断言：**两个域的 op 不得重叠**、**`plibAdmin` 的调用点集合恰好等于
`product-admin` 域的全部 op**（少一个 = 声明了没人用的权限，多一个 = 用了没声明的域）。

**与本文早先草稿的三处差异**（都以实测为准）：

1. **没有 `storage`** —— 岛内不需要任何配置持久化（页签记忆走 `localStorage`，容错处理，不属于跨会话配置）。
2. **没有 `clipboard`** —— 草稿照抄了别的岛；本岛没有任何复制功能。**能力声明按最小权限走**：
   多声明一个就多一份权限，而「声明了却从没调用」会被守卫当成能力缺口揪出来（见 §7.2 的守卫表）。
3. **`actions` 有意不含 `get`** —— 宿主 `product` 域有 `get`（单条详情），本岛编辑用的是列表行、
   保存后重新 `list`，没有"再拉一次单条"的场景。

> ⚠️ P3 增补 op 时**必须同时改 manifest 并升 version**（本岛 1.0.0 → **1.1.0**）——
> `domains`/`actions` 是岛**自报**白名单，不改就等于没授权。
> 另：发布走 `scripts/publish-plugin.js`，它读的是 **`manifest.json` 的 `version`**
> —— 只改 `package.json` 会出现"市场里永远装到旧版"。守卫里有一条断言把两者钉成一致。

**不做** `manifest.settings`（设置留在岛内视图）—— 与 ADR-001 判据一致：产品库的高频回路是"改产品 → 立刻看映射/成本变化"，收编进宿主设置模态会打断它。

**岛工程的两条自包含约定**（照 `scripts/ui-plugin-template`，踩过）：

- `base: './'` —— 产物经 `sk-plugin://` iframe 加载，绝对路径 `/assets/…` 会 404（整页白屏）。
- `css: { postcss: { plugins: [] } }` —— 不写这行，vite 会**向上查找**命中仓库根的
  `postcss.config.js`（tailwindcss + autoprefixer），于是产物变成"依赖当前工作目录里恰好有个根配置"。

**`build.minify` 保持 `false`（刻意，别改回默认）**：`tests/pluginTriage.spec.ts` 用正则扫产物里的
`plib('list'` 这类调用点来判定"声明的 op 是否真被调用"。压缩会改写 helper 名，守卫于是**静默失效**
（永远绿的假守卫比没有守卫更危险）。产物只有几十 KB，用体积换"守卫真的看得见"是划算的。

---

## 7. 实施阶段与验收

> ⚠️ **§7.2 – §7.5 是"当时"的逐条验收记录**（2026-09-27 / 09-29 实跑），其中凡以"UI 岛"为验收对象的条目
> 已随岛下架而**不再可复现**（岛源码、产物、市场条目都没了）。它们的价值是**证明数据层与契约当时是对的**
> —— 而数据层一行未改。
>
> **现在的等价守卫在 `scripts/goods-ui-smoke.mjs`**（`npm run goods:ui`，38 条断言）：岛侧那批关键契约
> （一次性批量映射 / 不跨店铺串数据 / 未解析店铺不可点 / 标失效按行 id 定位 / 部分 patch 不发空字段 /
> 供应商更新不带 name）已整组迁进来，断言对象从"岛 DOM"换成"内建页 DOM"，口径一条没放宽。

**与 `DOMAIN_INTEGRATION_PLAN` 的 S1–S4 同批**（该计划 §3.3 S4 已明确"P1 与本方案 S1 同批实施"）。

**执行顺序（2026-09-24 定）**：P0 ✅ → P1 ✅ → **P4a ✅** → P2 → P3 → P4 → P5。
P4a 提前，是因为 D5 裁定"现在就改造 `ae_cost_map`"—— 它是 P4 的前置，也是唯一会**清掉已有手工数据**的风险点，先修掉再往上叠界面。

| 阶段                       | 内容                                                                                                                                                   | 依赖                | 验收标准                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 决策冻结**            | §8 的 D1–D5 + op 契约口径                                                                                                                              | —                   | ✅ 2026-09-24 已完成，结论记录在本文件 §8                                                                                                                                   |
| **P1 数据层**              | `pl_products` DDL + `product-db` + handlers + IPC 四处 + `DB_OPS['product']`（P1 时 6 op；P3 已按 C4 拆域，见 §6.2）                                   | —                   | ✅ 已落地：`verify` 147≡147 / 143 通道（当时值）· `vue-tsc` 0 error · `product:smoke` **18/18**（后扩到 22）                                                                |
| **P4a 成本口径改造**（D5） | `ae_cost_map` 改**多行 + `effective_from`**；`costMapReplace` 不再清 `source='manual'` 行；`ae-engine` 按**订单业务日期**匹配区间取成本；`source` 可见 | P1                  | ✅ 2026-09-24 已落地：`ae:smoke` **13/13**、`verify` ✅、**零岛侧改动**。逐条见下                                                                                           |
| **P2 产品维护（UI 岛）**   | 岛工程骨架 + 产品列表与编辑 + Excel 导入（含失败行重试）。**只到款式级，无变体**（D3）                                                                 | P1                  | ✅ 2026-09-27 已落地（本文 §7.2 逐条对账）：导入 500 行含 10 行错误 → **490 入库 / 10 行可重试**；导出与界面同筛选；岛 id **未入** `modules.config.json`（红线 23）         |
| **P3 映射与关联**          | `pl_shop_sku` 维护界面（含批量关联）+ 待关联队列 + 订单导入接 `resolve`；**D1 落地**（`order-db.ts` 建款改写 `pl_products`，`oi_styles` 降级为编码池） | **P2 + ADR-002 S1** | ✅ 2026-09-27 已落地（本文 §7.3 逐条对账）：导入 1000 行陌生订单 → 全部进待关联队列、无丢行；批量确认后二次导入 100% 自动命中；`oi_styles` 侧**不再有业务字段的第二写入方** |
| **P4 成本与利润**          | 成本维护界面（读写 `ae_cost_map`，显示 `source` / `last_biz_date`）                                                                                    | **P4a**             | 手工改价后下次对账导入不回退；界面能看到每行来源是 `manual` 还是 `purchase`                                                                                                 |
| **P5 拣货**                | **`pl_variants` 建表**（D3 推迟到此）+ 拣货单（按产品/色码聚合）                                                                                       | P3                  | 同一批订单的拣货聚合数与明细行数一致                                                                                                                                        |

> ⚠️ **P3 的依赖栏原先只写 `P2`，这是错的（2026-09-27 更正）。** `pl_shop_sku.shop_id` 的外键目标是
> `sk_shops(id)` —— ADR-002 S1 新建的**店铺实体**，而该表在开工前**代码里零命中**（全库只有 `sk_shop_sets`，
> 那是含凭据的账号套装，不是店铺）。P3 的店铺定位键 `(platform, shop_id, item_id)` 没有合法落点，
> 且三处历史店铺文本（`oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name`）需要
> `sk_name_map` 归一 —— 两者都在 S1。
> 故执行顺序改为 **S1 → P3**（S1 已于 2026-09-27 落地，见 `docs/plans/DOMAIN_INTEGRATION_PLAN.md` §4.3）。
>
> 📌 **这条注记原先夹在表格中间**（P3 行与 P4 行之间）—— markdown 表格被引用块劈成两半，
> 于是 P4 / P5 两行实际渲染成了引用块文本（`prettier --write` 直接把它改写成 `> > |`，把这个错**显式化**了）。
> 现已移到表格**之后**。

### 7.1 P4a 验收逐条对账（2026-09-24 实跑，脚本 `scripts/ae-cost-smoke.cjs`）

| P4a 原定验收                                               | 结果          | 证据 / 说明                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一款跨两次进货 + 手工改价 → 对账导入后**手工价不被清掉** | ✅            | 「costMapReplace 不清 source=manual 的行」「手工改价后再导入一次对账快照：手工价仍生效」                                                                                                                              |
| 同一款式的**历史订单毛利按当时区间分别算出**               | ✅            | 「同一款跨两次进货：两笔订单各按当时成本」（早单 1.00 / 晚单 3.00 CNY）。**前提是同步改了快照源头**，见 §3.3 的 v4 漏项                                                                                               |
| 同 `(款, 生效日)` 上 manual 优先于 purchase                | ✅            | 「同 (款, 生效日) 上 manual 优先于 purchase」（手工 7.00 赢过导入 3.00）                                                                                                                                              |
| 老库迁移不丢数据、幂等                                     | ✅            | 「迁移不丢行、价格与来源原样保留」「ensureAeSchema 幂等」（含手工行 `source` 不被改写）                                                                                                                               |
| 订单日早于该款最早进货日 → 不判成缺成本                    | ✅            | 「回落最早一条，不判成缺成本」（v4 未写此规则，实现时补上）                                                                                                                                                           |
| ~~改一条汇率不影响历史毛利~~                               | ❌ **未达成** | **原验收条目写错**：成本折 CNY 后不受汇率影响（已覆盖），但**订单收入**仍按当期 `ae_rates` 折算，故改汇率**仍会改变历史毛利**。汇率表（`ae_rates`）没有生效区间 → 本条**从 P4a 验收移出**，归 `ADR-002` Q2 的后续范围 |

### 7.2 P2 验收逐条对账（2026-09-27 实跑）

| P2 原定验收                                                        | 结果 | 证据 / 说明                                                                                                                                                      |
| ------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导入 500 行含 10 行错误的文件：**490 入库**                        | ✅   | `product:smoke`「500 行含 10 行错误：490 入库、10 行逐行报错、不做整批回滚」                                                                                     |
| **10 行可在界面重试**                                              | ✅   | 同上 + 「修正后的 10 行重试可入库」→ 总数 500。界面侧由 `ImportDialog` 的 `pick → preview → done` 三步承载：预览表**就地编辑**款编码/款式名后重提（`rows` 分支） |
| 导出与界面一致                                                     | ✅   | `exportExcel` 按**当前筛选**分页拉全量（`PAGE=500` / `MAX_PAGES=40`），不是只导当前页；`template: true` 只出表头                                                 |
| 岛 id 不入 `modules.config.json`（红线 23）                        | ✅   | `pluginTriage` 的「预设清单与 `ui-plugins/` 目录名无交集」断言覆盖（该断言对**所有**岛生效）                                                                     |
| ~~仅此而已~~                                                       | —    | 以下为落地过程追加的、原验收没写但被实测证明**必须**钉住的项                                                                                                     |
| 行级错误**不得冒泡出事务**（否则 500 行里有 1 个空编码就整批回滚） | ✅   | 变异验证：把 `importProducts` 的行级 `catch` 改成 `throw e` → 冒烟立刻 3 条变红；复原后全绿                                                                      |
| 岛内**不得**自行解析 Excel / 求值（iframe CSP 无 `unsafe-eval`）   | ✅   | 守卫断言：岛源码无 `eval` / `new Function` / `xlsx` 引入；解析与校验唯一实现在宿主 `src/lib/productImport.ts`                                                    |
| 岛的 capability 声明 ↔ 真实调用一致（多声明 / 少声明都算缺口）     | ✅   | `pluginTriage` 的 product-library 组（8 条）：`声明 ⊆ 宿主 op` + `每个声明的 op 都被调用` + `dist ↔ src 调用点一致` + `manifest.version == package.json.version` |
| 守卫本身不是假守卫                                                 | ✅   | 变异测试 **14/14 命中**（+1 条等价改写对照），且带「基线必须绿」「收工必须复原」两道自检                                                                         |
| 真机：岛在宿主里能握手 + 首屏有内容                                | ✅   | `ui-island-smoke`：侧栏出现「产品库（UI 岛）」，**6/6** 岛 `booted=true` 且首屏非空（本岛 3398B）                                                                |

**未覆盖 / 已知缺口（如实记）**：

- **原生选文件对话框无法自动化**：导入的第一步是主进程弹系统文件框，CDP 驱不动。
  因此"点「导入 Excel」→ 选一个真实的 500 行 xlsx → 预览出 490/10"这一条**没有端到端自动验证**，
  它是被拆成两半分别覆盖的：卡面之前的**解析+校验**由 `tests/productImport.spec.ts`（24 例，含横幅/多表头/别名列/重复编码）
  覆盖，卡面之后的**落库+重试**由 `product:smoke` 覆盖。中间那一次「宿主读 xlsx」调用
  （`ipc.importExcelByPath`）则由 order-insight / excel-copy 的既有链路覆盖。**要端到端仍需人工点一次。**
- **`manifest.version` 漂移只在本岛被守卫**：`product-library` 有 `package.json`，`shipping-rate` 等无构建步骤的岛没有，
  故这条断言只放在本岛的专属组里；其余岛的版本纪律仍靠发布流程的自觉。

### 7.3 P3 验收逐条对账（2026-09-27 实跑）

两个脚本分工：**映射层**（队列 / 关联 / 命中）走 `scripts/product-sku-smoke.cjs`（`npm run product:sku:smoke`，**31 项**；2026-10-05 补 8 条「人工核对回流」，见 §人工核对的回流）；
**D1 款式主数据权威**走 `scripts/style-authority-smoke.cjs`（`npm run style:smoke`，**22 项**，A/B/C/D 四组）。
为什么必须拆两个脚本：前者答"关联能不能用"，后者答"主数据是不是只有一个写入方"—— 两个问题的**失败模式完全不同**
（一个是功能没做完，一个是数据会分叉），混在一个脚本里谁红了不知道先看哪边。

**三条原定验收**

| P3 原定验收                                                     | 结果 | 证据 / 说明                                                                                                                                                                       |
| --------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导入 1000 行陌生订单 → **全部进待关联队列、无丢行**             | ✅   | `product:sku:smoke`「验收①：1000 行陌生订单 → 1000 组全部进队列，无丢行」。配套：「队列：没有商品ID 的订单行必须**计数报出**（防无声丢行）」—— 丢行不是靠总数相等发现的，靠这一条 |
| 批量确认后**二次导入 100% 自动命中**                            | ✅   | `product:sku:smoke`「验收②：批量确认后同一批 1000 个商品 100% 命中」；`style:smoke` **D1**（落库即归款，不依赖 AI）+ **D6**（先导订单、后确认映射 → **重导即命中**）              |
| **`oi_styles` 侧不再有业务字段的第二写入方**（D1 / ADR-002 C1） | ✅   | 写侧 `style:smoke` **A2 / B1 / B4 / B6**：四条断言看的都是**遗留列本身**（`SELECT name FROM oi_styles`），不是任何接口返回的名字 —— 接口返回的是派生名，看接口等于自己考自己      |

**D1 落地后必须钉住、但原验收一个字都没写的项**（实测补出来的，按"漏了就会回归"排序）

| 补钉项                                                                          | 用例                  | 为什么它必须是独立断言                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 老库交接：历史 `oi_styles.name` 灌进产品库，随后**清空遗留列**，且幂等          | **A1 / A2 / A3**      | 交接与清空若不在**同一事务**，插入失败就会变成"清了个寂寞"。A3 还钉住"重复 `ensureOrderSchema` 不得把人工改过的名字覆盖回历史值"                                               |
| 读侧**四处出口**全部改派生（款式列表 / 订单款名 / 订单**搜索条件** / 采购缺口） | **C1 / C2 / C3 / C4** | 只改展示名不改搜索条件 = 按款名搜不到，而"列表面是对的"会让人以为读侧改完了。每条都配**幽灵名反证**（`plantGhostName` 往遗留列塞一个只可能被漏改读点命中的值）                 |
| 产品库缺该款时**仍要列出来**（`LEFT JOIN` 不掉行），且**不回落遗留列**          | **C5**                | 两条独立风险：用 `INNER JOIN` 会让"少一行"看起来像"没这款"；回落遗留列则等于交接白做（名字又从两个地方来了）                                                                   |
| 建款编码池**有两个来源**（`oi_styles` ∪ `pl_products`）                         | **B3**                | 只查前者会让产品库先占用的编码又发一次，撞唯一键 —— 症状是"识别建款失败"，报错却指向产品库（排查方向被带偏）                                                                   |
| 改名走**窄接口**，不得重置厂家 / 类目 / 状态 / 备注                             | **B5**                | `upsertProduct` 是**全量提交**语义，只传 `{code, name}` 会把其余字段静默重置成默认值 —— **静默清空比报错更难查**，故必须有独立断言                                             |
| 交接的**覆盖方向**：识别结果不得盖掉人工主数据；产品库 Excel 导入**才**允许覆盖 | **B2 / B6**           | 同一个 `adoptProduct` 按 `overwriteName` 分流，两个方向都要各有一条用例（只测一个方向，改错另一方向不会红）                                                                    |
| 映射命中**不依赖 AI**、未命中**什么都不做**、`pending` **不算数**               | **D1 / D2 / D3**      | D2 考的是"别清空 AI 已归的款色"——"未命中"最危险的实现是"顺手清一下"，而结果列看起来仍然是空的，肉眼查不出                                                                      |
| 店铺未归一时**不命中**（哪怕库里有 `shop_id=0` 的脏映射）                       | **D4a**               | `if (!shopId) return null` 与查询里的 `shop_id = ?` 是**两道独立防线**，正常输入只能触到前一道 → 必须造"只有这一条路径能到达"的输入（脏映射），否则断言恒绿                    |
| 同商品 ID **换一家店不得命中**                                                  | **D4b**               | 唯一键是 `(platform, shop_id, item_id, spec)`；键里丢了店铺维度时，A 店确认过的关联会在 B 店生效（串店）                                                                       |
| 产品库独有的款命中时**补占位款**，且占位**不吸走真实指纹**                      | **D5**                | `oi_style_colors` 挂在 `style_id` 上，不建占位行就落不了归款结论；但指纹是 `NOT NULL UNIQUE`，用真指纹格式会被后续识别误命中 → 用 `mapped:<code>` 前缀（真指纹不可能以此开头） |
| 删款编码（识别池）**不删产品库主数据**                                          | **B7**                | 反向：删订单空壳款顺手删产品 = 数据丢失                                                                                                                                        |

**变异测试：22 / 22 全中**（脚本 `/tmp/mutate-style.mjs`，临时件，不入库）

- **与 22 条用例一一对应**：逐条把对应实现改坏，确认**恰好那一条**变红（`D4a` / `D4b` 各占一条独立变异）。
- **三道自检**：① 基线必须绿（否则后面全无意义）② 补丁必须**唯一命中**（改了 0 处或多处说明锚点失效）③ 收工比 **sha256**，产物必须一字不差复原。
- 直接改**编译产物**（`dist/electron/{order,product,purchase}-db.js`），零构建零删除 —— 本环境的删除 shim 按轮次累计、超 50 拒绝，走构建会被卡住。
- **本轮变异自己抓出来的两条假守卫**（详见 `D4a` / `D4b` 行）：一条是两道防线互为兜底、一条是判据正则 `\b` 收尾匹配不到 `D4a`（`4` 后是字母，无单词边界）→ 真失败被漏数、误报成"假守卫"。
  **这正是"用例全绿 ≠ 守卫有效"的实例**：若不做变异，这两条会一直以"通过"的身份躺在报告里。

**门禁（2026-09-27 全绿）**

| 门禁                                  | 结果                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npx tsc -p tsconfig.electron.json`   | 0 error                                                                                              |
| `npx vue-tsc --noEmit`                | 0 error（渲染层 `ElectronApi` 只有它能兜，`verify` 不覆盖）                                          |
| `npx vitest run`                      | **421 / 421**（23 文件）                                                                             |
| `npm run verify`                      | ✅ 契约一致 **166 ≡ 166 / 162 通道**（新增 `product-handlers:16`）                                   |
| `npm run verify:docs`                 | ✅ 无悬空引用                                                                                        |
| `product:smoke` / `product:sku:smoke` | ✅ 22 / 22 · ✅ 23 / 23                                                                              |
| `shop:smoke` / `ae:smoke`             | ✅ 店铺实体数据层 · ✅ 成本口径 13 / 13（两条脚本本轮补了 `process.exit(0)`，退出码从 SIGTRAP 归 0） |
| `style:smoke`                         | ✅ **22 / 22** —— `✅ 全部通过：写侧唯一（pl_products）、读侧五处全派生、老库交接幂等`               |
| `npm run plugins:island:smoke`        | ✅ **6 / 6** 岛握手 + 首屏正常（本岛 3468B），且**重启后自动回到上次所在岛**                         |

**未覆盖 / 已知缺口（如实记）**

- **`renameStyle` 仍以识别池为准**：产品库有、`oi_styles` 无的编码改名时会先 `adoptProduct(..., { overwriteName: true })` 补建识别行；
  若两边都没有则抛错。这条边界**只由 B5 / B6 间接覆盖**（它们都先经过 `resolveStyle` 建了款），"只存在于产品库的编码去改名"
  没有独立用例 —— 该路径在本期没有真实调用方（`renameStyle` 的调用者是 `order-insight` 岛，它列的款必然在识别池里）。
- **真机冒烟只覆盖到"岛能起来"**：`plugins:island:smoke` **6/6** 通过（本岛首屏 3468B）、重启恢复也通过，
  但它**不点页面内部**（页签切换、勾选、提交走的是 `product:sku:ui` 那套假桥冒烟，不碰真实数据库）。
  换句话说：**"岛加载正常" ≠ "映射页在真机上能写完一条关联"**——后者仍需人工点一次。
### 7.4 1.2.0 验收逐条对账（2026-09-27 实跑：产品图片 + SKU/克重）

用户原话（四项决策经确认）：「产品库中需要增加产品图片，在映射与关联列表中也需要增加商品ID对应的图片，
产品库要维护产品的SKU信息以及每个SKU的克重」—— 粒度确认：**一个商品ID 下多个 SKU（SKU 子表挂 product_id）**，
图片来源：**自动聚合订单图 + 手动上传覆盖**；产品主图：**手动上传为主**。

| 验收项                                                         | 结果 | 证据 / 说明                                                                                                                                                                        |
| -------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品编辑抽屉有主图区，可上传/更换/移除                          | ✅   | 真机探针②：抽屉含 `.ed-img`；上传链路 = `openFile('image')` → `product-image.attach` → 缩略图回显。**系统文件框 CDP 驱不动**，选文件本身与 P2 导入同属"人工点一次"缺口            |
| 产品库列表有「图」列 + 批量缩略图                               | ✅   | 探针①：表头有「图」列；`imageThumbBatch` 合批（40 张/次，单项失败置 null）                                                                                                         |
| 映射与关联列表有商品ID「图」列，三层回落取图                    | ✅   | 探针⑤：切「映射与关联」→「已建立映射」子页签后表头含「图」；`itemImagePool` 三层回落逐 item 独立判定（`product:smoke`「覆盖图 > 订单图 > 款主图」用例）                            |
| 商品ID 可设覆盖图 / 清除回自动图                                | ✅   | `product-image.itemSet` / `itemClear`；`clearItemImage` 按 `toSkuKey` 归一键删（原文带空白也能命中，冒烟用例）                                                                       |
| SKU 子表手工增删改，克重落 `weight_g`                           | ✅   | 探针③：UI 真点「添加」→ 行出现 →「删」→ 行消失（走真实 `variantUpsert`/`variantDelete`）；克重四舍五入取整、负数拒收（冒烟用例）                                                   |
| SKU 同款重名抛错、编码全局唯一（空编码互不约束）                | ✅   | `product:smoke`：同款重名 / 编码占用 / 部分唯一索引各一条；**变异 4/4 变红**（覆盖图层跳过 / 负数校验删 / 索引丢 WHERE / 归一去掉），收工 sha256 复原一致                           |
| 岛 1.2.0 发版 + 四处 IPC 同步                                   | ✅   | `verify` ✅（`product-handlers` 16→24 通道口径）；`pluginTriage` 修复 `order`→`order-insight` 域名后 **66/66**，全量 vitest **422/422**（23 文件）                                 |
| 真机探针 5 步全绿（克隆 userData + CDP）                        | ✅   | `/tmp/probe-e2e-plib.mjs`：列表图列 → 编辑抽屉主图/SKU 区块 → SKU 真点增删 → 桥直调 4 域 op 权限链 → 映射页图列，exit 0                                                            |
| 上传图片端到端（系统文件框）                                    | ⚠️   | **未自动覆盖**：`select-image` 是主进程对话框，CDP 驱不动。桥直调已覆盖 attach 之外的 op 权限链；选文件 → attach → 回显这条仍需人工点一次                                          |

**探针过程修出的两条经验**（探针的错，不是应用的错）：SKU 名在 `<input value>` 里，`textContent` 取不到 ——
断言必须查 input value；映射页内部还有「待关联队列 / 已建立映射」子页签，查「图」列前要先点进去。

**门禁（2026-09-27 全绿）**：`tsc` / `vue-tsc` 0 error · `verify` ✅ · `vitest` **422/422** ·
`product:smoke` **33** · `product:sku:smoke` / `shop:smoke` / `style:smoke` / `ae:smoke` ✅ ·
`plugins:island:smoke` ✅ · 变异 **4/4**。

### 7.5 1.5.0 验收逐条对账（2026-09-29 实跑：「商品清单」页签 + 同版本号重发布事故补救）

起因不是需求变更，而是**发布事故**：09-28 把「商品清单」页签折进**已发布过的 `1.4.0`** 重打包，
zip 与 catalog 都被覆盖成新内容，但已装机器上的 `manifest.version` 仍是 `1.4.0`，
而更新判据只有版本号 → 本机永远拿不到该页签（详见 `ui-plugins/product-library/README.md` §5）。

| 验收项                                                        | 结果 | 证据 / 说明                                                                                                                                                    |
| ------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 岛源码 → 构建产物 → zip 三处一致含「商品清单」                 | ✅   | `src/ProductLibraryView.vue` TABS 有 `shop-products`；`dist/assets/index-DPWVlHK4.js` 命中 2 处；`market-out/product-library-1.5.0.zip` 内含同一产物            |
| 版本号升到 1.5.0 且 `manifest.version == package.json.version` | ✅   | 两处同为 `1.5.0`；`pluginTriage` **68/68** 全绿（含该一致性断言与「声明的 op 都被真实调用」）                                                                     |
| `shop-products` 域 6 op 全部有真实调用点                       | ✅   | `src/api.js` 6 个 `shopProducts(op,…)` 包装 ↔ `ShopProductView.vue` 6 处调用；宿主 `DB_OPS['shop-products']` 也是 6 op                                           |
| zip 与 catalog 逐位对齐                                        | ✅   | `unzip -l` = `manifest.json` + `dist/**`（6 条目 / 81.3 KB）；`shasum -a 256` = catalog 的 `1f689051…`（一致；条目时间戳固定后，同内容重发布 sha 不再漂移）        |
| 本地市场走 `no-store` 服务                                     | ✅   | 原 8000 端口上残留的是 `python3 -m http.server`（只发 `Last-Modified`，会触发 Chromium 启发式缓存）→ 已换成 `npm run market:serve`，实测 `cache-control: no-store` |
| 端到端链路（**真实 userData 的克隆** + 真实市场 IPC）           | ✅   | catalog 见 `product-library@1.5.0` → `pluginMarketInstall({force:true})` 成功 → `pluginsScan` **即时**回报 `1.5.0`（无需重启宿主）→ 落盘 `manifest.json` + `dist/**` |
| 岛内页签集合最终正确                                           | ✅   | 点侧栏进岛后 CDP 读 `.pl-tab`：**重载前 3 个**（产品库 / 映射与关联 / 供应商）→ **重载后 4 个**（多出「商品清单」）。⚠️ 宿主启动会预载「上次所在的岛」，其 iframe 持有旧产物 ⇒ **装完必须重启应用** |
| 「商品清单」页签内的增删改（导入 / 关联 / 删除）                | ⚠️   | **未自动覆盖**：导入走系统文件对话框（CDP 驱不动，与 §7.4 的"人工点一次"缺口同类）。数据层链路（`shop-product-*` → `pl_shop_sku`）已有 `shop:smoke` 覆盖       |
| 同版本号重发布的预防                                           | ✅   | **已加发布口守卫**（2026-09-29）：`scripts/publish-plugin.js` 写盘前比「打包内容摘要」（zip 内逐条目 路径+字节），同版本内容不同 → **exit 1 且产物不动**，要覆盖须显式 `--force`；catalog 已登记同版本但本地无 zip 可比对 → 告警放行。回归 `tests/publishGuard.spec.ts`（实跑脚本 4 条，变异 A/B' 均能变红） |

**门禁（2026-09-29）**：`pluginTriage` **68/68** · 岛构建成功 · 发布产物 sha256 与 catalog 一致 · 端到端探针 exit 0 ·
`publishGuard` **4/4**（同内容幂等 / 内容变拒绝且不写盘 / `--force` 覆盖各有断言）。

---

## 8. 已拍板决策（D1–D5 冻结于 2026-09-24）

### 8.1 用户裁定项

| 编号     | 决策点                       | **结论**                                                                                                                                  | 影响面 / 落地位置                                                       |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **D1** ★ | 款式主数据的唯一写入方（C1） | ✅ **路径 A**：`pl_products` 为唯一权威，`oi_styles` 降级为「识别编码池」（只留 `fingerprint` 等识别私有列），两表靠 `code` 同口径关联    | 改**主进程** `electron/order-db.ts` 建款逻辑（**不是**改岛）；改期 = P3 |
| **D2**   | 产品编码口径                 | ✅ 沿用 `oi_styles.code` 口径，**不引入第二套编码**                                                                                       | 零迁移；已在 `product-db.ts` 头注释落定                                 |
| **D3**   | 一期是否要变体表             | ✅ **不要**。P2 只到款式级；`pl_variants` 推迟到 P5（拣货），`pl_shop_sku.variant_id` 一期恒为 0                                          | P2 界面无变体维护；P5 才建表（§3.1 / §7）                               |
| **D4**   | 映射粒度                     | ✅ `(platform, shop_id, item_id, spec)` 唯一键，`spec='*'` 通配兜底                                                                       | 未命中率；`pl_shop_sku` 建表规格（P3）                                  |
| **D5**   | 成本口径与改造时机           | ✅ **现在就改造** `ae_cost_map`：改**多行 + `effective_from`**，同 `(style_code, effective_from)` 上 `source='manual'` 优先，界面显示来源 | 新增 **P4a**，**提到 P2 之前**（§7 / §3.3）                             |

> **D5 的触发事实**（本轮读代码发现，v3 未识别）：`electron/ae-db.ts` 的 `costMapReplace` 是
> `DELETE FROM ae_cost_map` **全表清空**后重灌 `source='purchase'`。也就是说，**只要产品库让用户手工录成本，
> 下一次拿货对账导入就会把手填的整表清掉** —— 这不是口径问题，是既有代码的数据丢失风险。故 P4a 排在最前。

### 8.2 随方案自决项（无需拍板，已按此执行）

| 编号 | 项                 | 结论                                                                                                                                                                                                                                |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1   | op 契约口径        | **收敛到代码现实**：P1 落地后实际 **6 op**（`ensure`/`list`/`get`/`summary`/`upsert`/`delete`），P2 加 2 个导入导出 = **8**，P3 加 5 个 = 13 → 顶穿 N5 上限，故 **P3 按 C4 拆域**为 `product` 6 只读 + `product-admin` 7 写（§6.2）。**该两数后经 1.2.0 / 1.4.0 变为 8 / 10（写域已满额）—— 以 §6.2 为准** |
| N2   | `status` 枚举命名  | 以代码为准 `active / archived`（更正 §3.1 曾写的 `discontinued`）                                                                                                                                                                   |
| N3   | 岛工程形态         | 参照 `ui-plugins/ae-profit`：`src/` 入库 + vite 构建，`dist/` 走 `.gitignore` 例外规则；`order-insight` 式的手写 dist ESM 不适用                                                                                                    |
| N4   | `product` 域 owner | 记为**宿主数据层** `electron/product-db.ts`，**不是岛**（岛只是维护界面）—— 否则与"卸载岛不影响数据供给"自相矛盾（§5.3）                                                                                                            |
| N5   | IPC 同步处数       | 是**四处**（handler / preload / `src/types.ts` / `src/core/services/ipc.ts`），`verify` 只拦前三处，第四处靠 `vue-tsc`（§5.2）                                                                                                      |

---

## 9. 风险与红线对照

| 风险                                                        | 应对                                                                                                           | 依据                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 岛 id 登记进 `modules.config.json` → 市场同名岛永久无法注册 | **不登记**（§4.2）                                                                                             | `AGENTS.md` 红线 23       |
| 透传 SQL / 岛内拼 SQL                                       | 全部经 `DB_OPS` 白名单，op 内参数化拼装                                                                        | `AGENTS.md` §1.7 / 红线 3 |
| 新增 IPC 通道漏同步**四处**                                 | `verify` 拦前三处，第四处（`services/ipc.ts` 的 `ElectronApi`）靠 `vue-tsc`                                    | `AGENTS.md` §6.2 / §5.2   |
| 多写同一份主数据（C1 被突破）                               | ✅ D1 已拍板路径 A；`pl_products` / `ae_cost_map` 各只有一个写入方                                             | ADR-002 C1 / §8.1         |
| **手工成本被下一次对账导入清掉**                            | **P4a**：`costMapReplace` 不再清 `source='manual'` 行 + `effective_from` 区间                                  | ADR-002 Q2 / §3.3         |
| `oi_styles.name` 成为 C1 的复发点                           | ✅ **已消解**（P3）：保留列但**双向退役** —— 写侧空串哨兵、读侧四处全派生、启动交接后清空遗留列（§5.1 / §7.3） | ADR-002 C1                |
| 成本出现两套表                                              | 复用 `ae_cost_map`，不建 `pl_cost_*`（§3.3）                                                                   | ADR-002 Q2                |
| 改已发布岛的 `domains` 需发版                               | P3 已实测走通：新增 `product-admin` 域 + 5 个 op → **manifest 1.0.0 → 1.1.0 并重发**（§6.3）                   | ADR-002 N5 / §6.2         |
| 用当期成本算历史订单利润                                    | 按订单业务日期匹配 `effective_from` 区间（P4a 落地）                                                           | ADR-002 Q2                |
| 拿 ASIN 当产品主键                                          | 主键是 `pl_products.code`；平台 ID 只进 `pl_shop_sku`                                                          | §3.2                      |
| 与既有域出现两套编码                                        | 硬约束：`pl_products.code` ≡ `oi_styles.code`；文本归一走 `sk_name_map(kind='product')`                        | §3.2 / D2                 |
| 批量导入写坏数据                                            | 单事务 + `pl_import_errors` 失败行隔离 + 批次号可追溯                                                          | 参照 `oi_queue` 既有实践  |

---

## 10. 后置能力（明确不在本期）

| 能力                                | 触发条件                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| 多语言内容（标题/五点/描述/关键词） | 需要从产品库**直接生成刊登文案**时                                           |
| 图片素材库（A+/多角度图/刊登素材）  | 需要**刊登素材管理**时（1.2.0 已落产品主图 + 商品ID 覆盖图，自动图由 `order-insight` 的 `oi_images` 承载；多图/A+ 不在本期） |
| 平台刊登映射（ASIN ↔ 我登了什么）   | 需要**刊登状态与价格管理**时，与 `pl_shop_sku` 是不同问题                    |
| 合规资质（CE/FCC/欧代/包装法）      | 需要**上架前合规拦截**时（`sk_company_profiles` 已存主体资料，缺产品绑定）   |
| 库存与补货                          | 需要**补货建议**时                                                           |
| 供应商报价历史 / MOQ / 交期         | 采购比价需求出现时                                                           |
| 变更审计与回滚                      | 多人协作或出现误改事故后                                                     |
| 跨域变更事件                        | 出现真实「一处写入、多处需重算」场景时（ADR-002 G7 的触发条件）              |

---

## 11. 章节迁移对照（v1 → v3）

`DOMAIN_INTEGRATION_PLAN` 与 `ADR-002` 引用过本文，**引用的是 v1 的章节号**。
**2026-09-24：4 处过期引用已全部回写引用方，本节转为「已同步」记录**（只同步引用位置与已失效的旧结论，**未改动任何裁定本身**）。

| 引用方                                           | v1 的引用点                                       | 本文当前位置                               | 处理结果                                                         |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `DOMAIN_INTEGRATION_PLAN` §2.1                   | `PRODUCT_LIBRARY.md` §3.2（款式编码零迁移已确认） | **§3.2**（未变）                           | ✅ 位置一致，无需改                                              |
| `DOMAIN_INTEGRATION_PLAN` §2.2 D3                | `pl_*` 表，P0–**P5**                              | §7，P0–**P5**                              | ✅ 位置一致（P5 已恢复）                                         |
| `DOMAIN_INTEGRATION_PLAN` §2.2 D4                | （成本无时间维度，无章节引用）                    | §3.3 / §7                                  | ✅ 已回写：D4 标题加「已修（P4a）」并写明改造前 / 后             |
| `DOMAIN_INTEGRATION_PLAN` §2.2 D7                | §4 P5 的"关联跳转"                                | **§10 后置能力**                           | ✅ 已回写为「§10（后置能力）」                                   |
| `DOMAIN_INTEGRATION_PLAN` §3.1 原则 3 / §3.5     | §5.3 / §5.4（op 一次定稿、跨岛共享）              | **§5.3 / §6.2**                            | ✅ 已回写为「§5.3 / §6.2」（§5.4 已并入 §6.2）                   |
| `DOMAIN_INTEGRATION_PLAN` §3.4 G5 / `ADR-002` Q2 | §2.3 的 `pl_cost_cards`（生效日区间）             | **§3.3**，**`pl_cost_cards` 这个表不存在** | ✅ 已回写：G5 行标注复议改判；ADR-002 Q2 删除废弃表名、指向 §3.3 |
| `DOMAIN_INTEGRATION_PLAN` §2.3 数据流图          | `ae_cost_map（当期口径，保留）`                   | **§3.3**                                   | ✅ 已回写为「按 (款, 拿货日) 多行，P4a 后」                      |
| `DOMAIN_INTEGRATION_PLAN` §2.1 实体锚点表        | `ae_cost_map.style_code`**(PK)**                  | §3.2 / §3.3                                | ✅ 已回写：PK 现为复合键，不再单列                               |
| `ADR-002` Related                                | "并行姊妹方案（款式主数据）"                      | §3.2 / §5.1 / §3.3                         | ✅ 已回写：补上三个交汇点（编码口径、写入权、成本口径）          |

> 本节原记「本文不擅自修改已 Accepted 的决策文档，待项目方确认后再回写」—— 项目方已于 2026-09-24 确认，
> 上述回写据此执行。

---

## 12. 关联文档

- `docs/decisions/ADR-002-master-data-layer.md` —— **上位决策**（C1–C4、N1–N6、Q1–Q4），本文 §5 逐条落实。
- `docs/plans/DOMAIN_INTEGRATION_PLAN.md` —— 上游盘点与 S1–S4；本文 P1 与其 S1 同批。
- `docs/features/PROFIT_TRACKER.md` —— 利润口径；成本取数改为按业务日期匹配区间（ADR-002 Q2），口径不变。
- `docs/decisions/ADR-001-island-settings-stay-in-island.md` —— 设置页归属（本文 §6.3 据此决定设置留岛内）。
- `docs/baseline/PROJECT_BASELINE.md` §6 —— 实施 P1 后需回写（SQLite 分域表清单）。
