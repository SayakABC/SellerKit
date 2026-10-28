# 速卖通店铺主页商品采集：商品ID 双空间 + 采 SKU 判定收紧（ae-profit 0.2.1）

日期：2026-10-15 · 涉两仓：`SellerKitExtensions`（全部修复）+ SellerKit（**零代码改动**，仅文档）。

## 结论（下次开工要记得的）

1. **店铺主页（买家视角 `aliexpress.com/store/…`）已支持「采集本页商品」**。修复两处根因：
   ① `manifest.content_scripts.matches` 补 `https://www.aliexpress.com/store/*`（此前脚本未常驻，
   只靠 popup 的 activeTab 兜底注入）；② 店铺主页是 Choice 主题卡片
   `div[exp_type="XRcmd-ItemExposure"]`（无 class、全靠行内样式），加进 `ITEM_ROW_SELECTORS`
   首位 + 专用解析（标题 `span[numberoflines]`、价格 = 整段文本恰为价格的节点、主图 = 首张非 `data:` img）。
2. ⭐⭐ **速卖通商品ID 有两个空间，凡采集必取规范空间（`1005…` 开头）**：店铺主页卡片 href 是
   **旧空间别名**（`32…` 开头、带 `pdp_npi` query）；规范 ID 的唯一可靠来源 = 卡片曝光埋点
   `utlogmap`（URL 编码 JSON）的 `prod` 字段（同一串挂在卡片根 div 与内部 `<a>` **双份**）。
   **拿 href 采 = 静默对不上账** —— 采集与落库全部"成功"，认款/订单匹配时才发现全空。
   已实现「utlogmap 优先 / href 兜底」，并变异钉死（优先级反转 ⇒ 用例红）。
3. **店铺主页的店铺连接键取地址栏** `/store/<id>`，不要用页面里的店铺链接（页脚「推荐店铺」之类
   会把商品错挂到别人店）；也**别用 og:url** —— og 报的是规范店号（如 `1103865174`），而主机里
   用户登记的是地址栏别名 URL（如 `1103865175`），反而匹配不上。店名取页面自报：
   `<title>`（`<店名> - Amazing products…`）→ keywords meta 兜底。
4. **`/i/` 短链详情页不会被重定向到 `/item/`**（跳转后仍停在 `/i/<规范id>.html`）⇒ location 永远没有
   `/item/`；itemId 走 `og:url`（content 含规范 `/item/1005….html`）兜底。`/item/<别名>.html` 则会
   服务端重定向，location 本来就对。
5. **props 兜底判据必须对齐主程序 `parseSkuProps` 的两种可解析写法**：`Color:X;Size:Y`
   （需 `[;；,，]` 分隔）或 `X+Y+Z`（≥2 段）。旧判据「含 `Color:` 即收」会把买家商品页 UI 文案
   （`Color: 6 View More Size: XL…`）当 props 推出去 —— 主程序拆出来 color 会**吸走整段垃圾**。
   收紧后不成形即计失败（用户可见），垃圾不进 `pl_shop_sku`（用户看不见）。
6. **买家商品页的 SKU 矩阵暂不支持**（既有缺口，本轮刻意未做）：SKU 选择器只对卖家后台结构调过，
   买家页上「采 SKU」会明说失败并给样本（扩展 README 已注明）。要做需重新采买家页色卡/尺码 DOM。
7. **改这个扩展的生效路径**：仓库改动 → 拷到本机 unpacked 扩展目录
   （`~/Library/Application Support/Google/Chrome/Default/UnpackedExtensions/<id>/`）→ Chrome 扩展页点
   「重新加载」。**没有热更新**；`dist/*.zip` 只用于分发/商店，不是本机生效路径。

## 取证

- 修复点（`SellerKitExtensions/extensions/ae-profit/src/content.js`）：
  `ITEM_ROW_SELECTORS` 首位 `[exp_type="XRcmd-ItemExposure"]` · `utlogmapProdId()`（`prod` / `x_object_id`，
  须过 `^\d{10,19}$`）· `storefrontTitle()` / `storefrontPrice()` · `storeNameFromPage()` ·
  `extractStoreInfo()`（地址栏块优先 + 防改写守卫）· `currentItemId()`（og:url 兜底）·
  `parseSkuRow()`（收紧判据）· `COLLECT_ITEM_DETAIL` handler（itemId 为空不推帧）。
- 回归：扩展仓库 `npm test` **29/29**。店铺主页夹具按生产形状复刻（无 class、行内样式、`utlogmap`
  双份、价格拆 4 个 span 紧邻无空白、页内无 `/store/` 链接、页面尾部 data: 占位 png）；
  另有 `/i/` 2 例与 props 收紧 1 例。
- 变异复核（**在仓库副本上跑**，10 条逐条打红后复原）：ID 优先级反转 / 去掉嵌套 `utlogmap` 持有者 /
  去价格兜底 / 地址栏块失效 / 去 url 防改写守卫 / 去 og 兜底 / 去 itemId 空守卫 / 店名版式失效 /
  去行选择器 / props 判据松回旧版。⚠️ 探针注入脚本（拼接 content.js 原文）的**注释与字符串里不能有
  反引号** —— content.js 自身含反引号，模板字符串会提前闭合。
- 真机取证：CDP（克隆 Chrome profile + 手动注入 content.js）在真实店铺主页跑「采集本页商品」8/8 条：
  ID 全为规范 `1005…`、标题 / 价格 / 图 / 店铺键正确、推送帧结构正确；`/i/` 实页「采 SKU」回
  `ok:true` + 规范 itemId。
- 部署：`diff -rq` 确认 unpacked 目录与仓库 `extensions/ae-profit` 同版本（0.2.1）。
