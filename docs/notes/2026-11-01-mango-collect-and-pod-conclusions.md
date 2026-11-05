# 芒果采集与 POD 图案域 · 结论层

> 跨工具结论笔记。**只放"下次开工还得记得"的结论，且每条都有取证**。
> 施工计划在 [`../plans/MANGO_INGEST_AND_POD_PLAN.md`](../plans/MANGO_INGEST_AND_POD_PLAN.md)，本文不重复任务分解。
>
> 取代关系：本文**不改写** `plans/MANGO_ORDER_EXTENSION_PLAN.md`（扩展侧）与 `plans/POD_PATTERN_PIPELINE_PLAN.md`（图案域），
> 两者的技术结论仍有效；本文补的是**抓包之后才知道的三条修正**（见 §4）。

---

## 1. 形态定位：SellerKit 不与芒果抢地盘

| 环节 | 谁做 | 判据 |
|---|---|---|
| 抓单 / 拣货 / 采购 / 打单 / 发货回传 / 刊登 / 物流 | **芒果** | 已覆盖，本地再做就是双写冲突 |
| **图案 → 花纸的一整条链路** | **SellerKit** | 芒果没有这个维度，也不可能有 |
| **本地经营分析（利润 / 成本 / 对账）** | **SellerKit** | 芒果只有平台口径，看不到真实进货价 |

**一句话**：SellerKit 的价值不在"再做一个 ERP"，在于**把图案这个维度从订单里搬到槽位上，只搬一次**。

---

## 2. 订单真源是芒果，SellerKit 只消费

- 芒果导出的 Excel **没有订单状态列** ⇒ 存量 `oi_orders.biz_status` **70/70 全空**（`sqlite3 … "SELECT COUNT(*) FROM oi_orders WHERE biz_status=''"` = 70）。
- 采集帧**带状态** ⇒ 走采集进来的单天然多一维。这是"自动同步"相对"手工导出"最实的增量，比省下拖拽操作值钱得多。
- 所以：**抓单不是锦上添花，是"今日待办"能成立的前提**。库里没状态，"今天该做什么"永远算不出来。

---

## 3. 抓包之后确定的接口事实（2026-11-01 实测）

| 事实 | 值 | 影响 |
|---|---|---|
| 列表接口 | `POST /erp/order/data/search.json` | 固定路径，可正则精确匹配 |
| 请求体格式 | **form-urlencoded**（不是 JSON） | 翻页 = 复制 body 改 `page`/`pageSize` |
| 响应结构 | `data.{totalItems,list}` | 总数可校验条数 |
| 待发货实测 | `totalItems = 3`（不是抓取失败） | 晨报第一天就该显示 3 单 |
| 店铺列表 | `GET /erp/common/shop` → `shops[].id` | **等于订单的 `authId`**，硬关联，不用别名文本 |
| 全流程计数 | `GET /erp/order/data/order/statistics.json` | 直接给 `{normal, notHandled, declarationless, h24, abnormal, confirm, risk}` |
| 芒果店铺数 | **14**（13 速卖通 + 1 半托管） | 与 `sk_shops` 的 16 家**对不上**，见 §5 |

**接口优先，DOM 只作兜底**：芒果是 SPA + hash 路由，表格可能虚拟滚动（区外行不在 DOM 里）、改版后选择器失效且**不报错只少抓**。

---

## 4. 三条抓包后的修正（前两份方案里没有的）

### 4.1 `skuCode` 才是图案绑定的首选锚点，三元组是次选

芒果 `orderItemList[].skuCode` 是**平台 SKU 唯一 ID**：跨订单稳定、卖家改规格名也变不了。

但 `variant_key = (店铺, 商品ID, 色名原文)` **已经落了 75 行**（导入路径 100% 非空），且与既有映射身份同源。
**结论：不动 `variant_key` 的口径，另加一列 `sku_code` 与它并列**——
- `variant_key` 继续做款色/成本的聚合键（既有体系不变）；
- `sku_code` 做图案绑定的**首选精确匹配**，命中不了再回落 `variant_key`。

> 为什么不是二选一：`variant_key` 是已经有 75 行存量、被 9 个消费者读的键，改它就是全量重绑；
> `sku_code` 是更好的键，但从零开始。两列并存，等于**用新键做有限范围的事**，风险可控。

### 4.2 色名塌陷是**链接级**属性，不是订单级

实测基线（真库副本）：**71 链接 / 520 色名槽 / 560 图案槽 / 6~7 个塌陷链接**。
塌陷定义：`pod_n_colors = 1 AND pod_n_images > 1`（该链接所有 SKU 色名相同、图不同）。

**塌陷链接禁止降级到色名匹配** —— 降级等于把 5–12 个图案并成 1 个，是**静默错印**，比识别失败严重得多。

### 4.3 图片 URL 的稳定身份只取 `/kf/<hash>.<ext>` 中间的 hash 段

host（`ae-pic-a1` / `ae01.alicdn`）与尺寸后缀（`_640x640.jpg`）都会变，**hash 是内容标识，动它就是自己制造误判**。

```
订单侧 .../kf/S2410a62cba024a409bd20be7bfc8f5c2u.jpg → S2410a62cba024a409bd20be7bfc8f5c2u
采集侧 .../kf/S59b69e8fd14e40f5b9d154d288e79ebbn.jpg → S59b69e8fd14e40f5b9d154d288e79ebbn
```

两侧同构，可直接比对。

---

## 5. 三个"看起来是 bug 其实不是"的现象

| 现象 | 结论 | 取证 |
|---|---|---|
| 待发货只有 3 单 | **真的只有 3 单**，不是抓取失败 | 抓包 `data.totalItems = 3`；且有一单 `3077041601058259` 付款 10-24 已压 7.8 天 |
| 芒果 14 店 vs 库里 16 店 | **待核对**，两边口径不同（芒果 13 速卖通 + 1 半托管） | `sqlite3 … "SELECT COUNT(*) FROM sk_shops"` = 16；芒果店铺列表 14 条 |
| `pl_shop_items` 只有 71 款 / 2 店 | 采集商品**只跑过 2 家店**，不是采集能力不足 | `SELECT COUNT(*), COUNT(DISTINCT shop_id) FROM pl_shop_items` = 71 / 2 |

**这三条直接影响排期**：图案槽位的分母（560）只来自这 2 家店，**铺满 14 家店之前，绑定覆盖率的分母是虚的**。

---

## 6. 硬约束（施工时不能破）

1. **抓 0 条 ≠ 今天没单。** 必须能区分，否则每天静默失败。判据：`fetched == 0 && totalItems > 0` → 告警。
2. **不做自动登录。** 芒果登录态在用户自己的 Chrome 里；密码留在库里是给紫鸟那类必须登录的场景用的。见验证码就停。
3. **不做常驻轮询。** 一天一次，最多 3 次补跑（`chrome.alarms` 间隔 30 分钟）。
4. **`world: "MAIN"` + `run_at: "document_start"` 都不能省** —— isolated world 的 `XMLHttpRequest.prototype` 是独立副本，改了拦不到且不报错。
5. **`splitVariantKey` 的 `p.length !== 3` 必须改成 `< 3 || > 4`** —— 不改，4 段键拆出来是全空串而**不报错**。
6. **图稿 ≠ 商品主图。** 传错花纸商拿模特图制版，整批报废。
7. **发错图案 = 全额损失**（印了图案的成品退回即废品）。打包必须扫码校验，不能靠人眼。
8. **同步必须有日志。** 没有日志的自动化等于没有自动化。

---

## 7. 取证命令

```bash
DB="$HOME/Library/Application Support/seller-kit/sellerkit.db"

# 订单来源与状态（应看到 import 70 / biz_status 全空）
sqlite3 "$DB" "SELECT source, COUNT(*) FROM oi_orders GROUP BY source;"
sqlite3 "$DB" "SELECT COUNT(*) FROM oi_orders WHERE biz_status='';"

# 明细行的键完整度（导入路径应 75/75/75）
sqlite3 "$DB" "SELECT COUNT(*), SUM(variant_key<>''), SUM(image_id IS NOT NULL) FROM oi_order_items;"

# 店铺与采集覆盖面
sqlite3 "$DB" "SELECT COUNT(*) FROM sk_shops;"
sqlite3 "$DB" "SELECT COUNT(*), COUNT(DISTINCT shop_id) FROM pl_shop_items;"

# 图案域是否已建（当前应为空）
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE name LIKE 'pod%';"
```

```bash
# 宿主侧能力（当前全部零命中）
cd <SellerKit 仓库>
grep -rln "setLoginItemSettings" electron/   # 无 → 无开机自启
grep -rln "new Tray(" electron/              # 无 → 无托盘
grep -rln "new Notification(" electron/      # 无 → 无系统通知
```
