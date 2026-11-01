# Changelog

本项目的所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于历史条目（重要）**：`v1.0.0` / `v1.0.1` / `v1.0.2` / `v1.0.4` 四个 tag **都指向同一个
> commit `9ccb73d`**（且缺 `v1.0.3`），因此它们不代表真实的发布节点。本文档中 1.0.x 段落
> 标注为**「补录」**，内容依据 `git log` 重建；**不再补打历史 tag**——错位的 tag 已是既成事实，
> 补打只会制造两套互相矛盾的版本坐标。真实版本历史的起点是下方 `[Unreleased]` 之后的第一个
> 正式发布（见 §发布流程）。

## [Unreleased]

### Added · 芒果订单入库通道：扩展推一帧 → 订单/图/日志全落库（2026-11-01，M1）

- **`POST /mango/ingest`（新路由，与 `/ae/ingest` 共用 token / 60 次每分 / 1MB / 单批上限四道防线）**：
  芒果单批放宽到 200 条（芒果是"一次把待发货全抓回来"，不分批；1MB 对 200 单 × 3KB 仍有余量）。
  `schema` 只认 `mango-order/v1`，推错帧给 400 且**说明支持哪个**，不会被当成订单吞掉。
  刻意宽松两处：`orders` 允许空数组（0 单也要留痕）；单条订单**不在这里校验** —— 由 `mango-ingest.toInternal`
  按帧给原因，否则"这一单为什么没进来"会退化成一个 400 错误码而不是一条可读的 skips。
- **`electron/mango-ingest.ts`（零依赖纯映射层，18 例单测）**：芒果帧 → 内部草稿。时间认 13 位毫秒/10 位秒
  并按**本地时区**格式化（按 UTC 会让同一单在"按下单日聚合"的页面上跨天跑到前一天）；金额币种非 CNY 一律
  `null` 而不是猜 1:1（`null` ≠ 0：0 会让"缺金额"伪装成"免费单"）；状态存芒果中文原文，**不做 bucket 映射**
  （映射只在 `src/lib/mangoStatus.ts` 一处）；同帧内同一 `skuCode` 合并成一行（芒果偶有重复行），
  没 skuCode 时用"商品ID+色+码"兜底。
- **店铺认亲 `authId` 优先（`sk_shops` v3 补 `erp_shop_id`）**：芒果帧没有速卖通店铺 ID，能认店的只有
  `authId`（ERP 内部 id，改不了）与 `alias`（人可改、可重名）。匹配序 = `authId` → 归一名 → 未登记桶；
  首次靠名字命中后**只补空**地把 authId 写回店铺行，下次直接命中 —— 店名改了（"十店"→"十号店"）订单不掉桶。
  三条纪律：同名多家店**一律不匹配**（取第一个会把订单落给一家恰好叫这个名字的店，图案/时效全错且事后
  看不出来）；authId 已被别的店占用时**不覆盖**（人已经决定过的状态）；**店铺状态不参与匹配** ——
  退店/封店只说明这家店现在不开，不改变它退店前那些单归谁（见下方 Fixed）。
- **图片落地复用唯一入口**：`landOrderImageByUrl`（URL 指纹 → 内容指纹两级去重），单批最多 200 张、并发 4；
  超出的行这次没图（计 `missingImage` + 一条 warning，下次同步补），**不阻断入库**。
- **`sk_sync_log`（新表，采集域自己的 SCHEMA）**：一次同步一行，抓 0 条也写。`fetched` / `total_items` 对账
  是"今天真没单"与"登录过期"唯一能分开的地方 —— 只回 `fetched=0` 时两者在界面上长得一模一样，
  用户唯一的动作是重启再点一次。回执另给 `skips` / `warnings` / `learned` 三列（上限各 50）。
- **`npm run mango:smoke`（21 项）**：用 `SellerKitExtensions` 的真实抓包帧走全链路 —— 四列齐 / 变体键含图键 /
  图真落盘 / 重推幂等（连下载都不发生）/ 红线 1（说 12 单抓到 0 单含原因）/ 残帧不删历史行 / 店铺改名仍认得出 /
  退店店照样认得出 / 色名塌陷分键 / **真发 HTTP 四态**。图片下载打桩，不联网。

### Added · 发货台第二行：现在还没发几单 / 哪单快超时（2026-11-01，M2）

- **动机**：第一行「今天要发」回答的是"今天导进来的这批"，而早上开机第一问是"我**现在**手上还有几单没发"——
  昨天没发完的单今天还在，按导入日筛会把它们漏掉。两块并排会得到"待发货 0 但今天要发 12 单"这种
  自相矛盾的画面，所以是**独立一块**，容器多取一次数（不带 `importDate` 的全库读）。
- **`src/lib/shippingPulse.ts`（纯函数，12 例单测）**：待发货单数（按单号去重）/ 24h 内到截止或**已过期**的单数 /
  件数 / 缺图行数。三个刻意的口径：
  ① 待发货只认 `mangoStatus.isWaitingShip`（唯一实现，别处不许写 `=== '待发货'`）；
  ② **没有截止期 ≠ 不会超时** —— 导入单根本没有这一列，空值单独计 `noDeadline` 并在界面说出来，
     否则「快超时 0」会被读成"都不会超时"；写坏格式的日期也归进这一项（不静默）；
  ③ **已过期也算风险** —— 截止期过了还没发是最该看见的一档，不能因为在过去就排除。
- **时间解析手写**（`parseLocalTime`）而不用 `new Date(str)`：`yyyy-mm-dd hh:mm:ss` 带空格的格式
  在 `Date` 构造器里行为是实现相关的，而这一屏显示"还剩几小时"，偏一小时就是错的告警。
- **补投影**：`shippingRows` 增加 `payTime` / `dealDeadline` / `timeoutAt` / `imageId` 四列，
  `UnifiedOrderRow` 同步声明。这四列正是 2026-09-30"零读者就删"删掉的那批 —— 现在有真读者了，
  按同一条原则加回来（注释里写明了）。
- **界面**：总览「今天要发」下方新增「现在还没发」一块（`data-act="pulse-summary"`），
  四格 + 两条提示（没有截止期的单数 / 件数按 1 计的**行数**）。少了截止期提示，
  「快超时 0」会被读成"都不会超时"，而事实是"算不出来"；件数按 1 计不说，件数会偏小且看不出。
- **样式**：复用 `.td-stat` 但要**解掉上面为「还差」写的 `:last-child` 染色** —— 否则"行缺图"
  会无条件染红，而缺图是常态（导入单没图），常态染红等于没有警示。改成只在 `is-warn` 时染色。
- **验证**：`today:ui` 3 条新断言（3 单 / 1 快超时 / 4 件 / 2 行缺图；**还没发(3) > 今天要发(2)**；
  没有截止期要明说）。夹具里 `IMPORTED_OLD` 是三天前导入的待发货行，正是"两块口径必须不同"的证据。
  三次变异确认会红：去掉待发货筛选 → 3 红；风险窗口改"只算已过期" → 2 红；
  第二次取数也带 `importDate` → 3 红。

### Added · 判别力统计：一条链接的画廊能不能唯一定位图案（2026-11-01，M3·T3-4）

- **动机**：变体键的第三段是平台色原文，而平台会把整条链接的色名全写成 `Picture color`，
  同一色名底下挂着各不相同的图。3 段键这时把它们并成**一个**槽位 —— 绑图案就是
  5–12 个图案被并成 1 个，**静默错印**。要不要第 4 段图键，取决于这条链接"一个色名下挂几张图"。
- **新 `electron/podLinkStats.ts`（零依赖纯函数，16 例单测）**：`podLinkStats(skuJson)` →
  `{nColors, nImages}`，`isCollapsedLink(stats)` 判塌陷。
  两个口径各有一处必须说清：
  · `nColors` 把**空色名也算一个色名**（"报表没给色"是真实存在的桶，与视图 `GROUP BY color` 同口径），
    否则"1 个真色 + 若干无色行"会看起来像"只有 1 个色"而被误判成塌陷；
  · `nImages` 取**同一色名下不同图键个数的最大值**，不是整条链接的图总数 ——
    后者会把「5 个色各挂 1 张图」算成 5，而那种链接**完全不需要**图键。两个数一样大、含义相反，
    而这两个数的唯一用途就是区分它们。图键认不出的行按"没有图"计，不算"另一张图"。
- **写路径两处都算（`upsertShopItems` 的 INSERT 与 UPDATE），且都从"这次真正写进库的那个 sku_json"算**：
  UPDATE 用合并后的值，不是本帧的值。列表轻采（不带 SKU）不会把两列打回 0；反过来的
  「轻采先到 0 → 详情帧后到」必须变成真实值，不能停在 0。三种跑法都有冒烟断言。
- **迁移 v3 改为"补列 + 回填存量"**（此前写的是不回填，是错的）：真库已有 71 条链接，
  两列全 0 之后 `WHERE pod_n_images > 1`（找塌陷链接的唯一入口）会筛出 **0 行** ——
  那不是"没有塌陷链接"，而是"没人算过"，而且它和真结论长得一模一样。回填只挑「两列都还是 0」
  的行，已算过的一个字节不动；`podLinkStats` 是纯模块，迁移与写路径调的是同一个函数，
  不存在第二套口径。
- **`isCollapsedLink` 的判据只有 `nImages > 1`**：计划里写的 `n_colors = 1 AND n_images > 1`
  是它的极端情形，拿 `n_colors = 1` 当前提会在"1 个色塌了、另 1 个色正常"的链接上漏判。
- **门禁**：`tests/podLinkStats.spec.ts` 16 例 · `shop-item:smoke` 53 → **58 项** ·
  `schema:smoke` [J] 8 → 10 条。变异测试逐条验过：UPDATE 改用本帧值 / `nImages` 改成图总数 /
  回填去掉「两列都是 0」的筛选，三处都只在预期的断言上变红。

### Added · 图案槽位域建表：四表两视图 + 判别力两列（2026-11-01，M3·T3-1）

- **动机**：一件印花定制品"印哪个图案"必须是能被查出来的事实，不能每次凭记忆挑。
  这一域存两件事：图案主数据（**图稿与预览图分开** —— 传错花纸商拿模特图制版 = 整批报废）、
  变体键 → 图案的绑定台账（一行 = 一个槽位）。
- **新 `electron/pod-db.ts`**：`pod_patterns` / `pod_variant_patterns` / `pod_sheet_batches` /
  `pod_sheet_ledger` + 视图 `pod_pattern_balance`（余量按**件**求和，不存冗余列）、
  `pod_binding_worklist`（把 `pl_shop_items.sku_json` 摊成槽位，
  键与 `variantKey()` **逐字节同构**：`char(0)` 分隔，第 4 段图键只在该颜色有多个图时追加）。
- **`pl_shop_items` 补 `pod_n_colors` / `pod_n_images`**（shop-item 迁移 v3）：一个颜色下挂几个图，
  决定了这个键能不能唯一定位图案 —— `WHERE pod_n_images > 1` 就是"塌陷链接"，
  不必再维护一份一定会过期的人工清单。回填口径见上方 T3-4 条目（补列同时回填存量）。
- **没有版本步骤**：全是新对象，幂等 `CREATE IF NOT EXISTS` 对老库就是补建、对新库就是一次建到当前形状。
  冒烟里直接钉死"图案域版本号必须为 0"，免得有人顺手加一个空的 v14。
- **⚠️ 施工时踩到并修掉的一处**：`pod_binding_worklist` 读别的域的表，而 SQLite 在**准备任何语句**时
  都会解析 schema 里的视图 —— 视图引用了不存在的表时，报错会打在**别处**的 SQL 上
  （`error in view pod_binding_worklist: no such table: main.pl_shop_items`，场景 H 当场红）。
  最终形状：`ensurePodSchema()` **先建输入域**（店铺 → 商品快照）**再建视图**，依赖方向"消费者 → 提供方"，
  两条新的 db→db 边在 `check-cross-domain-edges.mjs` 里登记了理由。
- **`schema:smoke` 新增两场景共 8 条**：空库一条 ensure 建齐六件 / 幂等 / 老库没有 pod 对象也能补回 /
  槽位键三 vs 四段（同色两图才带图键）/ 老库 `pl_shop_items` 补列不吃 `duplicate column`。

### Added · 空态骨化：`0` 单时要说清"是哪种没有"，并给一个能点的下一步（2026-11-01，M2）

- **动机**：`0` 在界面上有**三种**完全不同的含义，而它们要做的事完全不同 ——
  ① 读不到日志（日志表坏了）；② 从没同步过（去芒果点一下就有一批）；③ 同步过、芒果那边就是空的（真没单）。
  旧文案把它们混成一句"芒果那边待发货列表是空的，或还没同步过"：用户既不知道该干什么，
  也没法判断要不要担心 —— 与状态条治的是同一个病，空态不能自己再犯一次。
- **判据抽成 `isNeverSynced`**（`src/lib/syncBanner.ts`，3 例单测）：只有 ② 才给"去采集"的出口。
  `error` 非空时**不许**说"还没同步过" —— 那会让人白做一遍同步，还把真正的问题藏起来。
  总览与清单两处空态共用它（同一个 0 不许在两屏上说两种话）。
- **`src/modules/today/mangoOpen.ts`**：`MANGO_PENDING_URL`（就是扩展抓取用的那个筛选页
  `…/order/list/search/status/正常/normal`）+ `openMangoPending()`（复用现成的 `open-external`，
  Chrome 优先；打开失败会 toast 原因 —— 这一步失败的唯一表现就是"没反应"）。
- **两处空态各分两支**：从没同步过 ⇒ 一句话 + 「打开芒果待发货页面」按钮；同步过 ⇒ "芒果那边是空的"
  + 一句排查指引（登录过期 / 扩展没生效 / 抓取被截断都在状态条里说），**不给按钮**
  （真没单的时候给"去采集"按钮，等于让人做无用功）。
- **`today:ui` 5 条新断言**，其中一条核的是**打开的是哪个地址**而不是"按钮点得动"：
  首页也能叫"打开了芒果"（但还得自己找菜单），换个筛选也能叫"打开了芒果"（只是抓回来的是另一个列表，
  而且不会报错）。
- **两次变异**：`isWaitingShip` 改成全等匹配桶名（`=== 'unshipped'`）→ 8 条红（四数 / 清单 / 徽标 / 下钻全挂）；
  `isNeverSynced` 恒 `false`（两态合一）→ 3 条红（两处空态都退回"待发货是空的"，出口按钮消失）。

### Added · 待发货清单：按最晚发货时间排，最急的在最上（2026-11-01，M2）

- **动机**：总览只说"还有 12 单没发"，但**先发哪一单**没人回答。而漏一单的代价是罚款，
  不是少赚 —— 所以这一屏的排序本身就是功能，不是排版。
- **新页签「待发货」**（总览右边，**不带步骤号**）：四步讲的是"今天导进来的这批怎么走完"，
  这一屏讲的是"现在手上还有几单没发"（跨天、按当前状态）。六列 = 订单号 / 店铺 / 图案 / 件数 /
  剩余时间 / 图案状态。**一单三行就出三行**（件数与图案状态是行级的，聚合成一行会让"这单要印
  哪三个图案"彻底看不见）。**只读**：不做"标记已发货"，发货在平台那边完成，自己造一份状态
  第二天同步回来就会与真相打架。
- **`shippingQueue` 与四数同源**（`src/lib/shippingPulse.ts`，16 例新单测）：`shippingPulse`
  改成**由清单汇总而来**，而不是并列的第二个函数。否则一个按单去重、一个按行累加，界面上
  会出现"待发货 3 单"配"清单 5 行"，而用户第一步要判断的恰恰是"今天还有几单要发"。
  单测直接钉住两组数逐项相等；UI 再钉一条"清单单数 == 页签徽标"（徽标走 `summary.pulse`、
  清单走 `shippingQueue`，两条独立的路必须同一个数）。
- **没有截止期的排最后**（不是排最前，也不是当"最不急"混在中间）：导入单没有 `deal_deadline`
  这一列，按 0 参与比较会飘到最前（"1970 年就到期"），当"不重要"又会让人不去看它。
  垫底 + 单元格写「不知道」+ 单独一行说明"另有 N 单没有截止期"。`remainText` 分四档
  （分钟 / 小时 / 天 / 已超时），**不显示负数**。
- **「图案状态」三档：已绑 / 待绑 / 缺图**。M2 阶段能真读的只有两列：`image_id`（有没有图）
  与 `style_color_id`（归没归类）。所以语义是"可以进生产 / 不知道印在哪个款色 / 印不了"。
  M3 的 `pod_variant_patterns` 上线后 `ready` 再收紧一层（"这款色默认印哪个图案"也查得到），
  改动点只有 `patternStateOf` 一处。
- **空态分两句**：从没同步过 ⇒ 指向"去芒果待发货页面点一下采集"；同步过但确实没单 ⇒ 说"待发货
  列表是空的"。混成一句"暂无数据"，用户就分不清是"没生意"还是"采集坏了"（与状态条同一个病）。
- **总览下钻**：那条「现在还没发」多一个按钮，点了就地切到本页签（不跳模块）。
- **`today:ui` 5 条接线断言 + 两次变异**：把"无截止期"改成按 0 比较 → 单测与 UI 同时红
  （顺序变成 `I-OLD` 打头）；让 `patternStateOf` 忽略 `styleColorId` → 状态列变成「已绑,缺图,缺图」。

### Added · 采集状态条：把「今天真没单」和「一单没抓到」分开（2026-11-01，M2）

- **动机**：`fetched=0` 与"今天没单"在界面上长得一模一样，而用户要做的事完全不同
  （一个去发货，一个去重新登录）。`sk_sync_log` 从 M1 起就在记这件事，但**没有任何界面读它**。
- **新通道 `mango-sync-status`**（preload / types / ipc / handler 四处）：返回 `sk_sync_log` 最新一行，
  `null` = 从来没同步过。**刻意不吞异常**：这一条存在的意义就是"发现同步失败"，它自己静默降级成
  `null`，就变成「没同步过」与「读不到日志」分不开 —— 而那两件事要做的事也不同。
- **`src/lib/syncBanner.ts`（纯函数，13 例单测）**：四种形态 → 文案 + 配色档位。
  ① 读不到日志（`error`）优先于一切，哪怕手上有旧数据；② 从没同步过（idle，不是红）；
  ③ 同步失败（error，**原样给 reason**——那条 reason 是可行动的原因，"翻译"一遍等于把该怎么办删掉）；
  ④ 正常（ok；`partial` 时 warn，跳过/缺图/没认到店各自计数）。
- **`localWhen`**：`今天 09:12` / `11-01 09:12`。跨天必须带日期 —— 全天都写"今天"是假话，
  昨天 23:50 同步的会被当成刚抓的，于是不去点同步。**不用 `slice(11,16)`**：那是 UTC 时分，东八区差 8 小时。
- **性能与预算教训**：四种形态若都在 UI 冒烟里验，要连点五次刷新，把页面的 `--virtual-time-budget`
  撑爆 —— 而症状是**输出截断在最后一条 PASS**、`grep FAIL` 一条都没有，看着像全绿。
  所以文案/配色下沉到纯函数用单测覆盖，UI 只验接线；预算同时从 45s 提到 90s。
  顺带查明：此前"308 PASS 全绿"本身就是截断出来的假绿，跑完实际是 364+ 条。
- **`scripts/check-smoke-injection.mjs`（新守卫，挂在 `verify` 和每个 `:ui` 脚本前面）**：
  注入用的模板字符串里不许出现反引号。**一天内踩了五次**（`node --check` 只会报一句
  `Unexpected identifier 'xxx'`，指向注释中间，排查方向会被带偏），所以做成检查并前置 ——
  写完就拦，不靠记性。它当场抓到过两处我肉眼漏掉的。

### Fixed · 退店/封店的店铺仍然认得出订单（2026-11-01，M1 自查纠错）

- **错在哪**：`shopIdentityIndex()` 带了 `WHERE status='active'`，理由是"退店不该再接新单"。但芒果推来的是
  **已下的单**，不是新单 —— 一家店退店前还有单没发，那些单必须认到这家店。
- **后果（真库可量）**：已退店的八店 5 单 / 十二店 14 单共 **19 单**会落进"未登记桶"。订单上写芒果 `alias`
  （"八店"），库里那家店叫"八店-UK" ⇒ **同一家店在统计里变两家**（本仓反复栽过的派生漂移），而且因为店名
  是合法文本，**看不出哪里错了**，只会表现为"店铺归一页莫名其妙多一家店"。
- **改法**：全状态参与匹配（同 `src/modules/ledger/labels.ts` 的既有口径「退店不在此列，它照样参与分摊」）；
  `status` 经 `ShopMatch.shopStatus` 带出，同步层计 `onClosedShop` 并出一条提示
  「N 单属于已退店/封店的店铺（归属照旧，只是提示那边还有单没收尾）」——
  "退了店还有单"是**该让人看见**的信息，不是该静默隐藏的信息。状态永远不改变归属，只增加可见性。
- **验证**：单测新增 1 例（19 例），含逐条对照「同一家店 active vs exited 的匹配结果必须完全一致」；
  冒烟新增 1 项（21 项）走真实 SQL 层，另断言改回 `active` 后 `onClosedShop` 归零（否则恒等于 2 的实现
  也能让前一条断言变绿）。变异测试：把 `WHERE status='active'` 加回去 → 立刻 1 项红。

### Fixed · 采集路径不再丢字段：商品ID / 图 / 变体键落齐，跳过带原因（2026-11-01，M0）

- **动机（真库取证）**：芒果同步的通道全通，但**一个采集订单都没进来过**。真库现状：
  `oi_orders.source` 全是 `import`（70 单）、`source='collect'` 为 **0**；`biz_status` 70/70 全空；
  `pl_shop_items` 71 款只覆盖 2 家店；`pod_*` 表 0 张。四个断点都在这条路上，而且**全部静默**——
  人在界面上只看到"未归类"，看不出是"没采到"还是"采到了但字段丢了"。
- **A1 商品ID 被丢弃**：`upsertOrderBatch` 明明算出了 `itemId`，传进 `upsertCollectedOrder`
  后 `ins.run()` 只写 `size/raw_fields/color/qty` —— 商品ID 一个字都没进库，`oi_order_items`
  连 `item_id` 列都没有 ⇒ **采集单一行都拼不出 `variant_key`**，图案绑定 / 款色归类 / 成本
  全部落空。v13 加列并落齐。
- **A2 `image_id` 写死 NULL**：色名塌陷的链接（7/71，50 个槽位）永远判不出图案。改为写落地后的
  图 id（无图写 NULL，不写 0 —— 0 会让"没图"看起来像"图 id 是 0"）。
- **A3 整帧塞进 `raw_fields`**：既有解析链（`extractSkuFields` 的键名族、`parseOrderPropsColor`
  的规格串）都在**顶层**找值，只存整帧 JSON 时它们找不到且不报错 ⇒ 键静默为空。现在整帧快照
  仍然保真保留（`采集帧`），另**按行**叠加 `商品ID` / `产品属性` 两个可识别的键。
  ⚠️ 必须**每行一份**：一单多商品共用一份会让整单的键塌成第一行的值。
- **A4 通道互斥直接抛错**：`source !== 'collect'` 时抛「已由导入通道写入」⇒ 存量 70 单全是导入单，
  采集一开跑**全部被拒**，而调用方只 `console.warn` 后计进 `skipped`，界面上只有一个数字、没有原因。
  改为**允许 `import → collect` 升级**（采集帧信息更全：付款时刻 / 时效 / 店铺 authId 导入报表里根本没有），
  并加**行数不缩水**保护：帧行数少于已有行 ⇒ 整单不写 + 回执给原因（残帧不许静默删历史行）。
- **A5 跳过没有原因**：`upsertOrderBatch` 回执新增 `skips: [{orderNo, reason}]`（上限 50），
  `/ae/ingest` 把"消毒阶段被挡"与"入库阶段被拒"的原因**分开给**（前者要改扩展解析，后者要改数据，
  处置办法完全不同）。
- **变体键支持第 4 段（色名塌陷的唯一判别证据）**：新增 `electron/podImageKey.ts`
  （`imageKeyOf(url)` 纯函数，取 `/kf/<id>`，剥查询串/尺寸后缀，**不动 hash 也不折大小写**）；
  `variantKeyOf` 只在图键非空时追加第 4 段 —— **不传图键与改造前逐字节相同**（存量 75 行的键一个字没变，
  真库副本实测键集合完全一致）；`splitVariantKey` 接受 3/4 段，其他长度视为脏键。
- **迁移 v13**：`oi_order_items` 加 `item_id` / `sku_code`；`oi_orders` 加 `pay_time` /
  `shop_auth_id` / `deal_deadline` / `timeout_at`。**只加列不回填**（导入报表里没有这些字段，
  回填就是编数据）。D-2 的"两个时效时点"按推荐都建：芒果 `sendGoodExpiredDate`(11-11) 与
  `qualifiedTime`(11-05) 实测**差 6 天**，去订单详情页核对前不替用户选一个。
- **验证**：真库**副本**跑 v13 —— `version=13`、六列齐全、**70 单 / 75 行 / 75 个变体键逐字节不变**、
  二次运行无 `duplicate column name`；`npm run schema:smoke` / `order:smoke` / `ae:smoke` 全绿；
  `npm test` **1148 例**（54→55 文件）；`npm run verify` / `verify:docs` / `lint` 全绿。
  冒烟新增 6 条断言（四列齐 / 无图仍 3 段 / import→collect 升级 / 残帧拒绝 / 同源重推 / skips 带原因）。
- **环境注记**：本机 `ELECTRON_RUN_AS_NODE=1` 会被子进程继承，`electron scripts/*.cjs` 会退化成
  node 模式（`app` 为 undefined，`pickingRows` 报 `Cannot read properties of undefined (reading 'getPath')`）。
  跑 `*:smoke` 要用 `env -u ELECTRON_RUN_AS_NODE npm run …`。**这不是代码问题**，但会让"冒烟失败"
  看起来像功能坏了。

### Changed · 颜色板：标准色卡缩小不滚、待归一每行加款图、色名列收窄（2026-10-31）

- **动机（用户口径）**：「标准色卡片尺寸可以小点，不要出现滚动条，要全部都展示出来，带归一列表中需要加款图，
  不然数字没法知道是什么颜色，带归一列表的的色名列太宽了，看起来不太协调」。
- **标准色卡缩小、一屏展示**：卡片从「28px 色块 + 三行文字（约 68px）」压成「20px 色块 + 两行小字（约 42px）」，
  网格起宽 180 → 140px；`.colors-cards` 去掉自身的 `overflow: auto` —— 色卡区按内容铺开、不自己滚，
  高度全让给下面的待归一名单（名单仍独立滚动）。面板 `overflow: hidden`：实测差 2px 时 `auto` 就会画出滚动条。
- **待归一每行加款图**：板行新增 `imagePath` —— [`color-merge.ts`](electron/color-merge.ts) 从
  `oi_style_colors.image_id` 取**同色 `image_id` 最小的一行**（确定、可复现），经 `md.imageLocalPathMap()`
  批量解析本地路径；渲染层用 `orderImageThumbBatch` 取 64px 缩略图，没图的色画虚线空占位
  （不拿中性灰假装是答案），取图失败不挡合并。数字色号（`5` / `9` …）靠它才认得出颜色。
  （真库只读取证：`1` 5/5、`2` 6 行中 5 行、`9` 4/4、`白色` 8/8 有图。）
- **色名列收窄**：`width: 1%` + 首列 nowrap（按内容宽），原来 46% 的留白让给用量列；新增 `款图` 列 44px。
- **2px 溢出的真因**：待归一空态 `.wb-empty.colors-pad` 作为 flex 子项 `min-height: auto` 按内容顶住
  不肯缩，把面板撑出 3px（`overflow: hidden` 下表现为内容被切）。给 `.colors-pad` 补
  `flex: 1 1 auto; min-height: 0; overflow: auto` 后两遍视口 `panelScroll=0`。
- **验证**：`npm run build` / `npx vue-tsc --noEmit` / `npm run lint`（0 error）/ `npm run verify` /
  `npm run verify:docs` 全绿；`npm run master-data:ui` ALL PASS（新增「款图取到」「无图画空占位」
  「25 个标准色一屏铺开」三条）；`npm run ipc:shape:smoke` 96 项全过（板行形状含 `imagePath`）。
  主进程有改动，需重启 `npm run dev`。

### Added · 「基础数据 › 产品管理 › 颜色」：同色异名可合并，合并真改款色 / SKU / 别名（2026-10-30）

- **动机（用户口径）**：「当前颜色的管理页面还没有，现状是存在相同的颜色，只是名称不一样，要支持颜色合并」。
  色名在业务表里是文本（`oi_style_colors.color` / `pl_variants.color`），字典 `md_colors` 只是"常用色清单"，
  没有任何约束保证它们指向同一个词 —— 真库里 `黑 / 黑色`、`白 / 白色`、`灰 / 灰色`、`红 / 红色`、`蓝 / 蓝色`、
  `black / 黑色` 各自成行，于是"黑色卖了多少"被拆成两三个数。
- **2026-10-30 重新设计（用户反馈两点）**：① 颜色太多时拖动定位麻烦；② 数字色号 / 平台原文色名
  没有真实色块，不知道该并给谁。解法：板拆成上下两区 ——
  - **标准色**（字典里的色，合并目标）：用**色卡**展示，色块 = 真实 hex（点色块可取色器改）；色卡是大目标，
    合并靠「点一下待归一行 → 点一下标准色卡」，不再靠拖小行。
  - **待归一色名**（数字色号 / 平台原文 / 未入字典的异写）：列表，每行只带用量与徽标，**没有色块**
    （"还没认出来"就是没色块，不给中性灰兜底假装是答案）。
  - 合并手势：点待归一行选中 → 点任一标准色卡即合并；拖拽保留为**快捷**方式（拖待归一行到标准色卡）。
  - 新增标准色时可取色器选真实 hex（`md-color-create` 接受 `hex`）；已有标准色的色块可点取色器单独修
    （`md-color-update-hex`，只改 hex 不改名字 —— 名字是业务身份）。
- **合并真改数据**（编排层 [`color-merge.ts`](electron/color-merge.ts)，一个事务内六步，跨主数据 /
  订单 / 产品三域）：`md_color_aliases` 改指 + **新增**一条全局别名 `源 → 保留`（下次导入平台色直接归一）
  → 删源字典行 → `oi_color_aliases` 同改 → 款色同款撞名**先搬引用（订单行 / 变体键 / 套装部件）再删源行**
  （`image_id` 只补空），无撞名则原地改色名 → SKU 同产品同尺码撞名**先删源行再补** `weight_g` / `code`
  （顺序反了会撞 `code` 全局唯一索引），无撞名则改 `color` 与 `name`。
- **不变量**：`code` 一律不动（拣货 / 编码规则已引用）；`oi_order_items.color` 平台原文不动（"未认色"是派生态）；
  数字色号只能当源、不能当保留名（与 `md-color-create` 同一条校验）。拒绝路径（空名 / 同色 / 数字保留名 /
  源色不存在）全在写之前判定。
- **回执**只列真的动过的项（款色改名 / 并掉、SKU 改名 / 并掉、订单改指、变体键、套装部件、别名、字典移除）；
  合并后重拉颜色板 + 刷新字典单例，其他页面的色卡立即看到新名字。
- **验证**：`npm run build` / `npx vue-tsc --noEmit` / `npm test`（1139 例）/ `npm run lint`（0 error）/
  `npm run verify` / `npm run verify:docs` 全绿；`npm run master-data:ui` ALL PASS；
  `npm run images:smoke` / `npm run ipc:shape:smoke`（95 项，含 ⑬d `md-color-update-hex`）/
  `npm run order:smoke` / `npm run today:ui` 全通过。

### Fixed · 认款后的存量主图：打开「款与商品」自动补，不用重新认款（2026-10-30）

- **动机（用户口径）**：「认款后产品图片还是没更新」。上一批修的是**认款写入那一刻**的补图，
  升级前已经 `confirmed` 的映射不会自己跑一遍 —— 用户重启后看到的仍是白图。
- **实现**：
  - [`product-db.ts`](electron/product-db.ts) 新增 `confirmedMapPairs()`：全库已确认映射的
    (款, 商品ID) 配对；只认真映射行（`skuMappingSql` 排除 `shop-import` 池行与 `shop_id = 0`），
    商品ID 归一后再去重，出参按 `productId + itemId` 升序（「一款只补一张」可复现）。
  - [`product-handlers.ts`](electron/product-handlers.ts) 新增 `product-sku-repair-images` 通道：
    第一档本地图（`adoptOrderImages`）+ 第二档远程采集图（挑选 → 下载入库 → 采纳），
    单轮上限 `MAX_REMOTE_ADOPTS = 40`，回执 `{ adopted, pending }`（`pending` 是补完后仍缺的款数）。
    下载/回填/采纳语义与认款补图共用 `runRemoteAdoptions`，只写一份。
  - 渲染层 [`useSkuPool.ts`](src/modules/goods/useSkuPool.ts) 在打开「款与商品」与页级「刷新」时
    自动跑一轮；补到图就 toast，并经 `images-adopted` 事件让外壳重拉同屏两栏。
    认款写入时若 `adopted > 0` 也发同一个事件 —— 否则后端写进 `pl_products.image_id` 了，
    左栏产品列表仍停在旧数据（用户看到的正是「回执说设了主图、列表还是白图」）。
- **不覆盖人的选择**：仍只补 `pl_products.image_id = 0`；下载后会再走一次
  `adoptProductImageIfEmpty`，与认款补图同构。
- **「从采集商品导入」为空不是漏查**：候选按「该款最新一条 confirmed 映射」过滤，
  只显示认到**当前款**的采集行。真库 9822（STYLE-001）有 11 条，9823（STYLE-002）
  从未认款 ⇒ 0 条是正确行为。空态文案已点明当前款并说明「认到别款的不显示」。
- **验证**：`npm run product:sku:smoke`（新增 `confirmedMapPairs` 取数 1 条）、
  `npm run ipc:shape:smoke`（新增 ⑥+ 段 4 条：补图/只补空/limit 透传）、
  `npm run goods:ui`（新增「补了主图 → 左栏产品列表重拉」断言通过；脚本另有 1 条
  「颜色」页签的旧断言未随颜色功能更新，与本次无关）、`npx vue-tsc --noEmit`、
  `npm run build`、`npm run verify`、`npm run verify:docs` 全绿；
  真库副本上跑真 handler：9806 / 9811 / 9818 / 9822 四个缺图款全部补上
  （`adopted = 4`、`pending = 0`），采集行 `image_id` 同步回填、落盘文件齐全。

### Fixed · 「款与商品」认款后主图还是没有：把采集商品的远程图下载入库再采纳（2026-10-30）

- **动机（用户口径）**：「现在款与商品认款后主图还是没有」。上一批修的是**归类核对**那条路
  （`order-db.assignOrderStyle`）；「款与商品」走的是 `product-sku-map` → `adoptOrderImages`，
  那条路只发**本地**图。
- **根因（真库取证）**：采集商品的主图只有远程地址 —— 71 条 `pl_shop_items` **全部**
  `image_id = 0` 且 `image_url` 有值（界面直接拿远程 URL 显示），而 `pendingProductImages`
  要求 `localPath` 非空 ⇒ 没有图可采纳。有映射但没主图的款：9806 / 9811 / 9818 / 9822。
- **实现**：
  - [`product-db.ts`](electron/product-db.ts) 新增 `pendingRemoteProductImages()`：纯选择层、不做网络；
    规则与第一档同口径 —— 只补空（`pl_products.image_id = 0`）、**一款一张**
    （`productId + itemId` 升序确定性取第一张）、只挑还没入库的采集行（`image_id = 0` 且有 URL）。
  - [`product-handlers.ts`](electron/product-handlers.ts) 新增 `adoptShopItemRemoteImages()`：
    复用已有 `fetchImageToLibrary`（下载 → `landImageBytes` → 清临时文件），并发 4、
    单次最多 `MAX_REMOTE_ADOPTS = 40` 张；下载后回填采集行 `image_id`（下次列表直接命中本地图），
    再走 `adoptProductImageIfEmpty`（**只补空**，第一档刚落图时会自动跳过）。
    单张失败只跳过它自己，映射写入照旧成功。
- **不推翻人的选择**：`product-sku-map` 新增 `adoptImages?: boolean`（缺省 `true`）。
  「建档并关联」向导在用户取消勾选「采纳为款主图」时传 `false` —— 否则第 ③ 步认款已经
  悄悄采纳了，第 ④ 步的 `adoptMain = false` 形同虚设。preload 侧按 `=== false` 判，
  不传这个键的老调用方仍按采纳处理。
- **存量**：本修复只在认款写入时触发；已有映射的款**再认一次 / 改绑一次**（或「恢复」）就会补上。
  已有主图的款永远不会被换掉。
- **验证**：`npm run product:sku:smoke`（新增「采集商品只有远程图」的 4 条挑选规则）、
  `npm run ipc:shape:smoke`（新增 `adoptImages: false` 真 handler 断言：`adopted = 0` 且
  `pl_products.image_id` 仍为 0）、`npx vue-tsc --noEmit`、`npm run verify` 全绿。

### Changed · 「颜色叫什么」只列还没认的颜色；撤下「可能是同一件货」（2026-10-30）

- **动机（用户口径）**：命名板「只展示订单中没有认颜色的数据，目的只为了能认款和色，为之后的拿货统计做准备」；
  「可能是同一件货」——「现在的推荐完全不准，你看看是不是需要去掉」。
- **命名板只列待办**：[`VariantNamingCard.vue`](src/modules/today/tabs/VariantNamingCard.vue) 里已起过名的色
  **不再渲染**（组内只铺未认的色格，组头也改成「N 个没起名」），因此删掉了「查看全部颜色」那个开关。
  这块现在是**待办清单**而不是色名编辑器：要改已经起过的名，走「基础数据 › 产品管理」。
  选中态也只在未认的色格上停留（`selected` 加了 `!named` 条件），避免"给一格已经起过名的色改名"这种看不见的写库。
- **「可能是同一件货」撤下**：[`ClassifyPanel.vue`](src/modules/today/tabs/ClassifyPanel.vue) 不再挂
  [`StyleMergeCard.vue`](src/modules/today/tabs/StyleMergeCard.vue)。它的"推荐"其实只是「同一厂家下 ≥2 个款」
  （真库 5 号厂家挂了 8 个款）—— 一屏 8 行全摆出来让人自己判断，比不摆更费注意力。
  组件、IPC（`orderStyleMergeBoard` / `orderStyleMerge` / `orderStyleUnmerge`）与库表**都保留**：
  真库 0 条合并记录，不存在"想拆拆不掉"的问题；将来有可信判据再接回来（模板里有注释挡着）。
- **验证**：`node --check` / `npm run build` / `npx vue-tsc --noEmit` / `npm test`（1139 例）/ `npm run lint`
  （0 error，625 存量 warning）/ `npm run verify:docs` 全绿；`npm run today:ui` **359 PASS**
  （新增「只列待办：903 / 905 都不在 DOM 里」与「已撤下：没有这块也不再请求候选」两条反向断言，
  删掉原来 10 条款合并断言与 1 条其几何守卫）。

### Changed · 「颜色叫什么」改成点选起名（2026-10-30）

- **动机（用户口径）**：「归类核对页面的颜色叫什么也修改成编辑产品页的 SKU 编辑的方式」。
  改前每个色格一个自由输入框，色名会漂成「黑 / 黑色 / Black」三行 —— 而色名要进拿货单与统计，
  同一件货在两张纸上分成三行。
- **新形态**：[`VariantNamingCard.vue`](src/modules/today/tabs/VariantNamingCard.vue) 卡片顶部常驻一排
  **常用色**（复用通用组件 `ColorPalette`，与产品页 SKU 矩阵同一个）。点一个色格 = 选中它，
  色卡条改口成「正在给「5」起名」；点色卡即改名并保存，**存完自动跳到同组下一个未命名的色**，
  本组填完交下一组的第一个；把色格**拖到色卡上**松手也能起名（与产品页同一套 pointer 手势，
  拖完吞掉随后的那一次 click）。末尾「＋ 新增颜色」只写颜色字典，不给色格改名。
- **点之前就知道会不会被拒**：色卡按**款**打勾（同 `styleCode` 下已有这个名字即打勾），
  正对主进程 `renameStyleColor` 只拦"同款重名"那条边界；被拒时**主进程原话**显示在那一格，
  且**不跳选中**（跳走等于把错误甩在身后）。
- **不改的东西**：落库仍只送 `{styleColorId, name}`（款名/编码/平台原文由主进程回读）；
  款名 / 厂家那一层（组头）原样；「可跳过」口径不变 —— 不起名不影响统计与拿货。
- **验证**：`node --check` / `npm run build` / `npx vue-tsc --noEmit` / `npm test`（1139 例）/ `npm run lint`
  （0 error，625 存量 warning）/ `npm run verify:docs` 全绿；`npm run today:ui` **368 PASS**
  （命名板段 7 → 11 条，新增：色格内没有任何输入框、未选中时只提示、点格改口、色卡按款打勾、
  被拒不跳选中、拖到空白处不改名且吞 click、拖到色卡落库）；`npm run goods:ui` **447 PASS**（三窗口遍）。

### Fixed · 认款后产品没图时，采纳当前款色的图（2026-10-30）

- **动机（用户口径）**：「认款后，如果产品没有图片的时候，没有把当前款的图片给产品」。
  认款（归类核对里点名归款 / 批量定款）会把这单的图绑到款色，但产品主图一直是空的；
  只有「给商品ID 配产品映射」那条路会顺手采纳订单图（`product-handlers.ts:556` 的 `adoptOrderImages`）。
- **实现**：[`order-db.ts`](electron/order-db.ts) 的 `assignOrderStyle` 在归属事务提交后，用**该款色当前生效的图**
  调 `adoptProductImageIfEmpty`（`pl_products.image_id` 只在 0 时写）。源优先取本次订单图
  （`setImageStyleColor` 刚绑上去的那张）；订单本身没图时取款色已有的图 —— 也就是用户看到的「当前款的图片」。
- **边界**：① **只补空、不覆盖**（人挑过的主图优先）；② 失败不外抛（归属 / 款色 / 回流已提交，坏一张图
  不能让人以为"没保存"）；③ 款色也没图或产品库没这个编码 ⇒ 静默跳过，下次认款再试。
- **验证**：`npm run product:sku:smoke`（新增 1 例覆盖「订单图采纳 / 已有主图不覆盖 / 订单没图时采纳款色图」）、
  `npm run order:smoke`、`npm test`（1139 例）、`npx vue-tsc --noEmit` 全绿。

### Changed · 新增产品时款编码自动发号（2026-10-30）

- **动机（用户口径）**：「新增产品时，款编码自动生成，不要手动填写」。编码是订单 / 采购 / 成本三域的
  关联锚点，手打只是在抄系统该发的那串号，还多了打错 / 重号的机会。
- **实现**：[`ProductEditorDrawer.vue`](src/modules/goods/components/ProductEditorDrawer.vue) 新增模式打开即调
  （`ProductEditorDrawer.vue:659` 的 `loadCreateCode`）
  `api.nextCode()`（主进程 `product-next-code` → `order-db#nextStyleCode`，编码池 = `oi_styles ∪ pl_products`），
  填进编码框并**只读**展示；编辑模式原本就只读。发号失败时字段下方给出原因与「重新生成」出口。
  发号器与建款向导（`ShopItemWizard.vue:208`）共用同一个 —— 渲染层不自行 `max+1`（会漏掉订单识别已占用的序号）。
- **撞号兜底**：抽屉打开后别处（订单识别 / 另一处建档）可能先占了同号。新增保存撞唯一键时自动重新发号，
  toast 报「已重新发号为 …，再按一次保存」—— 编码只读、没有手改出口，不自动换号就会变成反复保存、反复失败。
- **关闭确认**：`createTouched` 不再把 `form.code` 算作"填过东西"（它打开就有值），否则每次点 ✕ 都会弹
  「这个新产品还没创建」（见 `ProductEditorDrawer.vue:845` 的注释与判据）。
- **验证**：`npx vue-tsc --noEmit` / 单文件 `eslint` / `npm test`（1139 例）/ `npm run verify` / `npm run build` 全绿；
  `npm run goods:ui` 三窗口遍全绿，并新增 3 条断言：打开即发号且 `readOnly`、旁边标「自动生成」、
  只发号就关**不弹**"还没创建"（`scripts/goods-ui-smoke.mjs:1527`）。

### Added · 归类核对：批量定色弹层（2026-10-30）

- **动机**：色卡托盘是快路径（勾中的行款式一致 ⇒ 一张色卡，点一下就走）；卡住的是**混款** ——
  同一个色名在有的款色卡里、在有的款色卡里没有。托盘只按"有没有这个色"逐行处理，人看不到
  "这一下会改几行、几行会不动"，于是要点完才知道结果。
- **入口**：勾选后在底部动作条「批量定款…」旁多一个「批量定色…」（`data-act="cl-bulk-color"`）。
- **弹层内容**：候选色 = 这批行各自款色卡的**并集**（保持首次出现顺序）；每种色**点之前**就摆出覆盖数
  「改 N 行 · 已是 M · 另 K 行不适用」，`change = 0` 的色仍然列出但**点不动**（"已经是它"要看得见）；
  底部说明"只改款色卡里有这个色的行，卡里没有的要先去产品管理加色"。不在这里选款、也不在这里给款加色。
- **落库**：与托盘**同一个入口** `applyTrayColor(color, ids)`（串行 `saveOne({ silent, defer })` + 一次 `bump()`，
  四类回执照旧），弹层只 emit 一个色名、落库后自动关闭。
- **纯函数**：[`colorOptionsOf`](src/lib/classifyBulk.ts) 负责覆盖账（`change` / `same` / `miss` / `noStyle` +
  `missNos`），单测 5 条钉住"并集顺序 / 改了就不重复写 / 色卡外与没定款分开数 / change=0 仍列出"。
- **验证**：`today:ui` 增 9 条（动作条有入口；弹层头报「已选 2 行 · 1 个款」；覆盖数；不改的色点不动；
  未选色时确定不可用；按钮报「定色并保存（1 行）」；只写 P-42、P-43 一字不写；回执点名"1 行还没点名款"；
  落库后自动关闭）。

### Added · 归类核对：色卡托盘 + 拖图定色（2026-10-30）

- **动机（用户口径）**：归类核对页要能「把某行的图直接拖到色卡上定色」。这一页的落点是「款 + 色」的款色，
  逐行点款、再点色、再保存路径太长；一排常驻色卡 + 拖放，把"定色"压成一次手势。
- **托盘列哪些色**：**本页各行 `styleCode` 的款色卡并集**，不是 27 个字典色 —— 颜色不在该款色卡里就落不下去
  （宿主 `ensureStyleColor` 会顺着它给这个款新建一个色，本页不该凭空造款色）。取 `styleCode` 而非草稿：
  `draftOf` 在 computed 里新建草稿会自激。
- **交互**：托盘挂在页头与表格之间（仅待核对、本页有行时渲染；不吸顶，避免压扁 `cl-list` 弹性区）。
  点色卡 = 给勾选行定色并保存（没勾选时只提示下一步，不写库）；拖图 = 行头缩略图按住 →
  越过 6px 阈值 → 落到某颗色卡上松手，只给那一行定色。缩略图同时是「点击看大图」与拖动抓手，
  拖后那一下的 click 被吞掉；拖动期间捕获阶段 `selectstart` 一律 `preventDefault`（与产品页同一条教训）。
- **统一写入口**：点与拖共用 `applyTrayColor(color, ids)`（串行 `saveOne({ silent, defer })` + 一次 `bump()`），
  回执分四类计数：已保存 / 本来就同色 / 还没点名款 / 款色卡里没有这个色。
- **验证**：`today:ui` 增 9 条（托盘 = 黑/白且不含别款的「蓝」；每颗带 `data-cl-tray`；无勾选点色卡不写库；
  勾 2 行点色卡 ⇒ 两次 `orderStyleAssign` 带 `S1 + 黑`；回执「已把 2 行定到「黑」并保存」；
  拖 P-44 到「白」⇒ 单行落库；拖动中 `is-dragging` + `is-drop`；拖后 click 被吞、大图没开）。

### Changed · SKU 编码的 `{color}` 段改为颜色 ID（2026-10-30）

- **动机（用户口径）**：「SKU编码把color修改为颜色ID」。色名是**会被改写的标签** —— 归类把 `藏蓝` 改成 `藏青`
  之后，按色名生成的编码就跟实际色对不上；`md_colors.id` 是主数据身份，改名不动它。
- **实现**：`colorDict.ts` 的 `ColorDictItem` 带上 `id`，新增 `colorIdOf(color)`（`0` = 不在字典）；
  `skuCode.ts` 的 `SkuCodeSeed` 增可选 `colorId`，`renderSkuCode` 经 `colorToken` 渲染 `{color}`
  （id > 0 用 id）。占位符标签改「颜色ID」，输入框 title 一并改。`ProductEditorDrawer.vue` 的 `codeSeeds`
  带上 `colorId`（读模块级字典单例 ⇒ 字典后到会自动重算预览），`onMounted` 补 `loadColorDict()`
  （预载，避免第一帧按色名算、载入后再跳成 ID）。
- **回落**：拿不到 id（还没归类的异写色 / 字典没载入 / 内置兜底 `COMMON_COLORS` 没有真实行）⇒ 回落色名，
  不能因为没 id 就留空（那会生成 `S1--L` 这种残码）。
- **验证**：`tests/skuCode.spec.ts` 增两条（id=3 ⇒ `SUST-001-3-L`；无 id ⇒ 回落 `黑色`）；
  `goods:ui` 的 `sku-drag-grab` 段增两条 —— 字典里已有「黑」时预览必须是数字（`S1-29-L`），
  提示里 `{color}` 标成「颜色ID」（三窗口遍全绿）。

### Fixed · 整站图片全黑：图片路径固化了临时目录（2026-10-30）

- **症状**：用户报「为什么现在所有的图片又不显示了」—— 产品库、订单列表、拿货单、款色代表图，
  凡走 `md_images` 的图**全部空白**。
- **根因**：R1 的旧图迁移（`legacy-image-migration.ts`）是在**临时 userData**（`/tmp/sk-apply`）里跑的，
  数据库随后被拷回真 userData，但 `md_images.local_path` 里记下的绝对路径前缀**固化了 `/tmp/sk-apply/images/`**。
  真库 101/101 条都是这个前缀，`/tmp` 被系统清理后全部指向不存在的文件 ⇒ `order-image-thumb` 的
  `resolveThumbPath`（`realpathSync` 失败）一律返回 `null` ⇒ 界面全是空占位。
  **字节一个没丢**：101 个文件都在 `userData/images/` 里，文件名 = 内容指纹，与库里的 basename 101/101 完全对应。
- **修复**：① 数据修复 —— 真库 101 条 `local_path` 前缀换成 `<userData>/images/`（先 `.backup`，
  修完逐条 `fs.exists` 校验 101/101 命中）；② 代码兜底 —— `imageLocalPath` / `imageLocalPathMap`
  读取时走 `resolveImagePath`（原位不存在就按 basename 到唯一图片目录找一次，仍找不到才原样返回），
  这样以后再遇到"换机 / 恢复旧备份 / 迁移用临时目录"也不会整站变黑。
- **为什么没在读取时写回库**：列表查询是只读路径，顺手 `UPDATE` 会把"看一眼产品列表"变成事务；
  脏前缀的正确清理是一次性的数据修复。
- **验证**：`tsc -p tsconfig.electron.json` / `images:smoke` / `verify` 全绿；真库逐条路径 `fs.exists` 101/101。

### Fixed · 拖动色名时误选中文字（2026-10-30）

- **症状（用户口径）**：「多选拖动的时候会出现文字被选中的情况，虽然不影响功能但用户体验不好」。
- **根因**：色名改成只读文本后整条 chip 都是拖动抓手，按住它移动会起一段浏览器原生的"刷蓝"选择；
  多选整组拖过整页时选区还会跨到上面那排常用色。功能本身没坏 —— 纯粹是拖动手势与文本选择的冲突。
- **修复**（`SkuMatrixEditor.vue`）：`onChipDown` 按下即锁（不等 6px 阈值 —— 原生选择是从"按下 + 移动"
  起算的），锁期间在捕获阶段对 `selectstart` `preventDefault`，并清掉已有旧选区；松手 /
  pointercancel / 窗口失焦（`abortDrag`）/ 组件卸载一律解锁。
  **不用** `pointerdown.preventDefault()`：它会连带抑制兼容的 mousedown/click，点选就失效了；
  **不用** CSS `user-select: none`：选择已经开始后改样式收不回来。
- **冒烟**：`goods:ui` 的 `sku-drag-grab` 段增一条 —— 拖动中派发 `selectstart` 必须
  `defaultPrevented=true`（三窗口遍全绿）。

### Added · R1d：色名只读 + 点选归类 + 通用「常用色」组件（产品编辑页 / 归类核对页共用）（2026-10-30）

- **动机（用户口径）**：「编辑产品中的颜色修改为不能修改，可以改成可多选，点击选中，批量拖动到常用色中选择颜色，
  如果不存在颜色，可以在常用色后面新增颜色，这可以做成通用的页面或方法，可供产品编辑页和归类核对页使用」。
- **色名只读、点行即选中**（`SkuMatrixEditor.vue`）：色名输入框撤掉（改色名的唯一路径 = 归类 / 合并，落库色名因此
  永远取字典写法，界面不再产出第四种异写）；点颜色 chip 任意处 = 选中/取消（Shift 连选保留），
  R1c 的「多选」显式开关一并撤掉（选中态本身已经可见，开关是第二套规则）。色名只读后整条 chip 都是拖动抓手，
  不再有"input 里选文字"要保护；候选词浮层（suggest）整体删除 —— 点行选中之后，「常用色」那排本身就是候选列表。
- **通用组件 `src/core/components/ColorPalette.vue`**：色点胶囊条（字典色 + 本矩阵已用色追加）、打勾 = 已在矩阵、
  拖动落点高亮、末尾「＋ 新增颜色」inline 编辑器（Enter 确定 / Esc 取消，失败就地报错）。两个页面只接
  「点 / 拖之后做什么」：产品矩阵 = 加行 / 归类 / 落点；归类核对页 = 写草稿色。共享服务
  `src/core/services/colorDict.ts` 单例承载字典（失败回落 `COMMON_COLORS`），两个页面读到的是同一份。
- **`md-color-create` 写通道**（`electron/master-data-handlers.ts`）：「＋ 新增颜色」的唯一落库路径；
  空名 / 超 40 字 / **纯数字色号**拒绝（数字色是"还没定色"的证据，放进来"未分类"就变主数据了）；
  同名幂等（`created:false` 返回既有行）。preload 消毒 + `types.ts` / `ipc.ts` 登记照旧四件套。
- **归类核对页颜色格去下拉**（`ClassifyPanel.vue`）：有款色卡的行 = 「色点 + 当前色名」按钮（`data-color` 带当前值），
  点开 Teleport 到 body 的小弹层复用 `ColorPalette`（compact，不开新增 —— 加款色是产品页的职责）；
  没点名款 / 款还没录色的行仍是自由输入 + datalist 建议（不是下拉）。弹层带「清空颜色」，Esc / 遮罩关闭。
- **回执互斥**（冒烟抓到的真问题）：单条归类/合并回执（8s）与批量「撤销」回执（12s）共用一行位置，此前旧的批量回执
  会把新回执盖掉 ⇒ 现在**最新一条优先**（`flashHint` 清 `undoBulk`、`markBulk` 清 `mergeHint`）。这不只是显示：
  `undoBulk` 存的是批量前的整矩阵快照，中间又动过别的再点撤销会把新改动一起抹掉 —— 让位顺带堵掉了这条路。
- **冒烟适配**：`goods:ui` 颜色断言整体改写（`mxChip/mxNames/tapColorRow/ensureDictColor` 帮助函数；
  改名走「点行选中 → 点常用色」；假桥 `mdColorCreate` 桩与真进程同闭环）；`today:ui` 颜色格
  SELECT → 按钮 + 弹层流程（`clPickColor / clClearColor`；回车保存改派在行内勾选框上 —— 按钮上的 Enter
  被组件刻意忽略，原生 Enter=点击会误开弹层）；`ipc:shape:smoke` 增 ⑬b 段 5 条（新增成功 / 同名幂等 /
  空名与数字色被拒 / list 可查），68 → 74 项。假桥模板串里一处 `\d` 没双重转义（实际匹配字母 d）被 lint 抓出，已修。
- **门禁实测**：`build` / `verify` / `verify:docs` / `lint`（0 error）/ `test`（1132 passed）/ `images:smoke` /
  `schema:smoke` / `ipc:shape:smoke`(74) / `goods:ui`（宽 + 默认窗口 + 窄三遍）/ `today:ui` 全绿。

### Added · R1c：颜色/尺码字典 IPC + SKU 矩阵「颜色工作台」（2026-10-30）

- **字典只读 IPC**（`electron/master-data-handlers.ts`）：`md-color-list` / `md-size-list`，走 `handle` 契约（只返数据，
  异常由 IPC 层包成 `{success:false}`）；`main.ts` / `preload.ts` / `src/types.ts` / `src/core/services/ipc.ts` 四处登记，
  `src/core/services/ipc.ts` 侧是唯一渲染层入口。**写入仍然只有业务路径**（`ensureColorId` / `ensureSizeId` / `setColorAlias`）——
  字典没有"界面上直接改主数据"的入口，避免一个色在字典与 `pl_variants` 文本列各写一半
  （同日 R1d 起开了唯一一个界面写入口 `md-color-create`，见上条）。
- **常用色由字典驱动**（`SkuMatrixEditor.vue`）：原来前端写死 10 个（`COMMON_COLORS`），现在渲染 `md_colors` 的 27 个
  （`sort_order,id`），矩阵里字典没有的异写（`藏蓝` / `4` / 英文名）照旧追加在这一排后面 ⇒ 这一排同时回答
  "还差哪些标准色没加"与"这些异写该归到哪个标准名"。字典取不到时回落 `COMMON_COLORS`（离线 / 首启不至于没有色卡）。
- **「颜色工作台」：多选 + 批量归类 / 批量合并**。多选是**显式开关**（默认一个勾都不出现 —— 否则第一次点色名会被当成"选中"），
  勾选支持 Shift 连选，选中后出现批量条（`已选 N 色` / 合并为一行 / 全选 / 取消选择）。从任一已选行起手拖动 = **整组**：
  拖到「常用色」= 归类（落库色名取字典写法），拖到另一色 = 合并；拖动中的落点提示会说清"把 2 色归到「黑色」"。
  落库语义仍是既有纯函数 `classifyMatrixColor` / `mergeMatrixColor` —— 批量只是**循环**，不新增任何写规则；
  批量动作一律走 `markBulk`（12 秒「撤销」，与整行 / 整列开关同一条回执位），退出多选 / 任何行结构变化都清空勾选。
- **修掉一处"写后立刻读"**（本次冒烟抓到的真 bug）：`matrix` 是 `defineModel`，props 模式下 `matrix.value = x` 只是 emit，
  父组件的 prop 要等下一帧才回写 ⇒ 批量循环里每归一次就读回 `matrix.value` 会拿到**旧矩阵**，第二色会把第一色的结果整个覆盖
  （实测：两色批量只归了后一个）。改为累加在**局部变量**上、最后一次写回；`addSize` 的焦点下标是同一类读后写（焦点落在倒数第二码），一并修。
- **调色板不加下拉，靠收紧密度放 27 色**：高度仍是 24px（这是拖动的靶子，压扁就脱靶），改压字号 / 内边距 / 色点
  （27 色正好两行）；「颜色」标签旁新增「多选 / 退出多选」开关。版式守卫的像素上限从 200 → 250 并写明理由 ——
  矩阵可见性另由「≥7 行组合可见」那条守卫独立承担，不靠这一个像素数兜。
- **新增冒烟**：`goods:ui` 增 `sku-batch-classify` 步（显式开关 / 整组拖动落点文案 / 归一成字典写法 / 撤销搬回两行 /
  全选 / 合并为一行 / 退出多选 / 批量步零写入）；`ipc:shape:smoke` 增 ⑬ 段 10 条（通道在册、camelCase 形状、`sortOrder` 升序、
  字典**不含**「未分类」与数字色、「别名」是逗号字符串），58 → 68 项。`pickCommon` 在多选且已选时改为批量归类（点常用色 = 归类）。
- **文案守卫**：`tests/uxEntryNames.spec.ts` 新增豁免「常用色」（拖动提示里"拖到上面「常用色」"指的是同屏那一排色卡的标签字，
  不是导航入口；存在性由 `goods:ui` 钉）。
- **门禁实测**：`build` / `verify` / `verify:docs` / `lint`（0 error）/ `test`（1132 passed）/ `images:smoke` /
  `ipc:shape:smoke`(68) / `goods:ui`（宽 + 默认窗口 + 窄三遍）全绿。

### Changed · R1（S0a）主数据落地：三张图片表收口成唯一 `md_images`，颜色/尺码进字典（2026-10-30）

- **动机（用户口径）**：图片/颜色/尺码是主数据，业务表只该存 id。旧实现有三张图片表（产品域 `pl_images`、
  订单域 `oi_images`、商品覆盖图 `pl_item_images`）、两套落盘目录（`product-images/` 与 `order-images/`，只有后者进备份），
  同指纹的图存成两份字节、两张表的 `AUTOINCREMENT` 各自从 1 起 ⇒ id 必然撞车（`order-image-land.ts` 记录的那次 P0：
  "色图绑定成功"实际改掉的是另一张表的订单图）。颜色则散在 `oi_style_colors.color` / `pl_variants.color` /
  `oi_color_aliases` 三套词表。
- **新增主数据域**（`electron/master-data-db.ts`）：`md_images`（内容 SHA-256 唯一）/ `md_colors` / `md_sizes` /
  `md_color_aliases`；**唯一落盘入口** `landImageBytes`（两级去重：URL 规范化指纹 → 内容指纹；单图 10MB 上限；
  按文件头判格式），文件统一落 `userData/images/<sha256><ext>`，备份 / 体检 / 孤图清理 / 缩略图白名单都只认这一个目录。
  `registerImageRow` 只登记"已经在 `images/` 里"的图（不写文件）。种子 27 色 + 10 码（`XXL→2XL` / `F→均码` 等别名），
  **`未分类` 与平台数字色（`1`..`15`）不入字典** —— 那是"还没定色"的证据，不是主数据。
- **删旧实现**：`pl_images` / `pl_item_images` / `oi_images` 的 DDL 与读写全删，以及 `oi_images` 上的识别流水线字段
  （`status` / `result_json` / `error` / `style_color_id`，识别链已于 2026-10-28 整条退役）。
  `oi_order_items` 旧 DDL 上的 `REFERENCES oi_images(id) ON DELETE CASCADE` 一并拆除 —— 父表删掉后它会让**所有**带图的
  订单插入失败，而报错指向图片表、排查方向整个反掉。拆除顺序受两个 SQLite 硬约束约束（`PRAGMA foreign_keys` 在事务内是
  no-op；`ALTER TABLE ... RENAME` 会改写别的表指向它的外键）⇒ `retireLegacyImageTables()` 只能「建新表 → 拷数据 → DROP → RENAME」。
  旧图**改为「搬完再拆」**（2026-10-30 修订，原口径"零迁移"是按「未正式发布、无存量库」定的）：真库实测有 101 行
  `oi_images` + 12 行 `pl_images` + **92 条「图 → 款色」绑定**，直接 DROP 等于把人工定款定色的积累清零。
  新增一次性过渡件 `electron/legacy-image-migration.ts`（拆旧表前调用，窗口结束后可整文件删除）：
  经 `landImageBytes` 搬进唯一 `images/` 仓（同内容收敛：113 行 → 101 张）、改写订单行 / 产品行 / 采集行的 `image_id`、
  款色代表图按 `updated_at DESC` 落 1:1（同色多图其余留作普通图片）。两个坑记在这里：
  ① 旧 `oi_order_items.image_id` 带 `REFERENCES oi_images` 外键 ⇒ **必须等重建表之后**才能改写，否则 `FOREIGN KEY constraint failed`；
  ② 新旧 id 都从 1 起自增 ⇒ 逐条 `WHERE image_id = 旧id` 会把刚改好的行再改一次（真库 11 个带图产品被改 18 行），
  改成「先全置负数、再落正数」的两阶段改写。
- **款色代表图改为 1:1**：代表图从 `oi_images.style_color_id` 搬到 `oi_style_colors.image_id`。真库取证支持这条：
  (店铺,商品ID,图片) 58 组 ⇔ (店铺,商品ID,Color) 58 组，图片→多色 0、色→多图 0。读取口径统一为
  `ITEM_STYLE_COLOR_ID`（**行上的 `style_color_id` 优先、图上的代表款色回落**），拣货 / 拿货 / 利润五处共用这一份。
- **跨域边登记**：`order-db` / `product-db` → `master-data-db` 两条边写进 `scripts/check-cross-domain-edges.mjs` 并注明理由
  （这两个域现在只做"读 `local_path`"与"登记委托 `registerImageRow`"，二进制落盘仍只有 `landImageBytes` 一处）。
- **新增门禁 `images:smoke`**（`scripts/master-data-db-smoke.cjs`，25 项 + 旧图搬迁 1 项）：唯一目录 / 两级去重（同图不同 URL 复用同一行 ——
  "按图找色"的命入口）/ 拒绝路径（空、非图片、超 10MB）/ `registerImageRow` 不覆盖既有行 / 字典精确匹配不猜 /
  别名全局 vs 款级 / 播种幂等 + 清库后自愈。
- **两处冒烟口径按被测语义更新（不是"修红断言"）**：
  ① `schema:smoke` [C] 的老库夹具改回**真表名** `oi_images`（v3 冻结 DDL 里写的就是它，拿 `md_images` 顶替会撞
  `no such table: main.oi_images`）；② [H] 的"存量收口自动归款"断言改为 `07aaac3` 回退后的语义 ——
  没有人工映射时行留 `style_color_id=0`、不许自动长款色；③ `picking:smoke` [7] 由"同图两色各归各色"改为
  "同一张图只有一个色结论"（1:1 之后前者不可达）。
- **明确不做（拆为 R1b / R2 / R4 / R5）**：`oi_style_colors.color → color_id`、`pl_variants` 加 `color_id`/`size_id` 并停写文本列、
  `oi_color_aliases` 并入 `md_color_aliases`（都要改唯一键，跟 R2 的键改造同属一套事实）；删 `oi_styles`、`pl_variants` 文本列、
  `pl_shop_sku` 的键改造各自留到 R2/R4/R5。
- **门禁实测**：`build` / `verify`（跨域边 13 条在册）/ `verify:docs` / `lint`（0 error）/ `test`（1132 passed）/ `order:smoke` /
  `product:smoke` / `product:sku:smoke` / `style:smoke` / `shop-item:smoke` / `picking:smoke` / `ipc:shape:smoke`(58) /
  `schema:smoke` / `images:smoke`(25) 全绿。

### Docs · 删 3 份零引用孤儿 + 归档 11 份完结文档：`docs/` 90 → 87（2026-10-30）

- **动机**：上一轮把 145 篇按天笔记蒸馏成 37 篇后，「多」集中到了 `plans/`(23) + `reviews/`(14) —— 它们不是同一类东西：
  一半是**已完结的方案与审查**（做完即过期），一半是**在办 / 待拍板**（删了等于丢在办事项）。混在一个目录里，读者分不出该读哪个。
- **判据不靠感觉**：`docs/README.md` 的文档地图本就有「状态」列（✅ 活跃 / 🟢 进行中 / 🟡 待拍板 / 🗄️ 归档），
  按它 + 全仓引用扫描（按裸名与按路径两种口径）× 取交集，得到「状态已完结且有人引用」11 份、「零引用孤儿」3 份。
  没有一条是"看着像旧的"就删。
- **删前先搬结论**（否则删的是知识不是文件）：
  - `SCHEMA_SIMPLIFICATION_REVIEW_2026-10-19` → 合表三条判据 + **「不该合并」5 组带理由** + 跨域用 `code` 不用 `id`，
    并入 `docs/notes/2026-10-30-db-schema-and-migration.md` §24。这是**负知识**：不写下来，下一个人会重提合并。
  - `UI_REVIEW_PURCHASE_2026-10-17` → 「渲染期崩溃只表现为元素消失」＋「`<input type="number">` 的 `v-model` 会把输入
    coerce 成 number ⇒ `.trim()` 抛错」＋排除法定位次序，并入 `docs/notes/2026-10-30-smoke-and-guard-discipline.md` §19。
  - `PRE_PURCHASE_PRECHECK_PLAN`（**从未实现**的提案）→ 六类缺口清单与「缺什么 → 去哪补 → 补完再走」动线目标，
    并入 `docs/notes/2026-10-30-order-classify-panel.md` §65 并标注【未实施】，需求本身不丢。
- **归档而非删除**（11 份 → `docs/archive/{plans,reviews,baseline,requirements}/`）：直接删会让 `CHANGELOG` 里 23 处
  历史引用悬空；而 `check-doc-links.mjs` 的 `SKIP_DIRS` 含 `archive`（脚本头部「已知覆盖边界」已写明），归档件不再被扫描。
  ⚠️ 同轮发现一个**反直觉点**：`walk()` 从仓库根就跳过 `archive`，因此 `archive/` 下的文件**不在后缀索引里** ——
  「只写文件名、不带目录」靠后缀匹配兜底的那套写法在这里不成立，必须显式带上 `archive/` 前缀（或写 `../archive/...` 相对链接）。
  第一轮脚本按后缀假设只改了带 `docs/` 前缀的写法，门禁当场报出 20 余条悬空，才补了第二轮。
- **指路型改指 / 事实型不改指**：`CHANGELOG` 那 23 处全是「见 X」的指路句，改指归档路径成立；另扫了一遍
  「新增 / 新建 / 创建」类事实句，命中的唯一一处指向的是**未归档**的 `GOODS_UX_REFACTOR_PLAN`，无需处理。
- **结果**：`docs/` 90 → 87 篇，其中 `archive/` 12 篇、**在办 75 篇**；`plans/` 23 → 15、`reviews/` 14 → 10。
  地图 12 行标注 `🗄️ 已归档（2026-10-30）`。`verify:docs` 复跑：37 条笔记全部登记、零悬空引用。

### Docs · 结论笔记按主题蒸馏：`docs/` 198 → 90 篇（2026-10-30）

- **动机**：`docs/notes/` 积到 145 篇按天短笔记，同主题扎堆（货品 25 篇、订单归类 22 篇、店铺 14 篇…），
  "打开目录就找不到该读哪篇"。文件数多不是冗余，是**入口失效**。
- **做法**：按 11 个主题组读全文后**合并**（不是抽取摘要）—— 每条结论与取证（命令 / `文件:行` / 实跑数字）
  一条不丢，只去重、重排、统一措辞；已被后续推翻的结论保留并标 `【历史记录】`。每篇新笔记文末附
  **「合并清单」表格**（哪几篇并进来、各自落到第几节），可据此反查；原文可 `git show b5df35c:docs/notes/<原名>` 取回。
- **结果**：`notes/` 145 → **37 篇**（33 篇合并 + 4 篇独立主题原样保留：`cross-tool-context-sharing` /
  `repo-hard-constraints` / `engineering-hard-laws` / `data-health-checklist`）；`docs/` 全仓 198 → **90 篇**。
  索引按 A 工程基线 / B 货品 SKU / C 订单归类 / D 店铺映射 / E 颜色界面 / F 拿货采购 / G 记账运费 /
  H 数据平台外围 分组重排，并给两篇"开工先扫"的标 ★。
- **不变式**：合并是**重排不是删信息** —— 判据是每篇旧笔记的每条结论都能在新笔记里找到；
  子代理被明令禁止删除/改名任何文件，删除与解引用由主流程统一做、一次成批。
- **解引用**：全仓 **120 个文件、453 处**引用（`docs/notes/<old>` 三种前缀写法 + Markdown 相对链接）批量改指新笔记，
  含 `CHANGELOG` / `PROJECT_BASELINE` / `docs/README` 的活导航与 **14 个代码文件注释里的出处**（只动注释串，未动逻辑）。
  `verify:docs` 复跑：**37 条笔记全部已登记、零悬空引用**。
- **历史记录不跟着改**：`docs/README.md` 的「第 N 次订正」与 `CHANGELOG` 里"本轮新增了某篇"属**事实陈述**，
  批量替换会把它们改指现存文件、读起来变成假记录 —— 这 8 处已还原为「原文件名（2026-10-30 蒸馏时并入）」。
  与 `check-doc-links.mjs` 头部豁免表同一条判据：**把 token 改成存在的路径，句子还成立吗？**

### Fixed · 订单多段拆行：一段一行、色/码/件数各自就位（R0，2026-10-30）

- **现象**：一单 4 段同商品的速卖通订单（`1123192657411338`）只落 2 行，且 `color=''`
  （`尺寸` 4 行全写成 `XL`、件数 NULL）。根因是拆行器把「产品数量」（速卖通里是**总件数** 5）
  当成段数 → 多拆一行空壳；又因 `块数 !== n`，**每行都留着多块原文** ⇒ 下游
  `parseOrderPropsColor` 判成"一单多色"返回空、`parseOrderQty` 取不到件数。
- **修**（`src/lib/orderRowSplitter.ts`）：有「【N】块」结构时段数 = 块数（块内件数之和 ==
  数量列即判为"总件数"）；**每行只带自己那一段**（块不足的行留空并计入缺色）；单值尺寸列
  不再广播，改取块内 `Size`。`expandOrderRows` 新增 `missingColorCount`，导入回执会报
  "N 行定不出颜色（已按待认色入库）"。
- **配套**（`electron/order-db.ts`）：订单行幂等键从 `(订单号, 图片)` 扩到
  `(订单号, 图片, 色, 码, 件数)` —— 同一 listing 的多个 SKU 常共用一张商品图，只按图判重
  会把后几段当重复行吞掉。
- **清库脚本**（`scripts/reset-dev-data.mjs`）：`sk_mail_fts` 是普通 FTS5 表，`delete-all`
  会让整条事务回滚（清库等于没清）⇒ 改 `DELETE`；清空清单补 `oi_variant_keys` / 款合并 /
  套装部件（CLI 未开外键时不会随父表级联，会留下 59 行孤儿键）；本机已清空并自动备份。
- **验证**：`vitest run` 1132 passed / 54 files（含新增 4 段回归 3 条）；`tsc` 两份配置 0 error；
  `order:smoke` 全绿；`schema:smoke` 仅既有 [H] 失败。依据见
  `docs/plans/PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md` §10.1。

### Removed · 退役两张"生产代码零引用"的表（2026-10-29）

- **`sk_shop_sets`**（2026-10-22 物理合并前的「店铺集 / 账号套装」表）：新库本就不建，运行库只剩
  0 行历史残留。项目尚未正式发布、没有要升级的存量库 ⇒ 当时那次整表合并迁移（搬账号 / 归并企业 /
  建工具账号 / 重建 `sk_mail_accounts`）整段退役；`shop.main` 现为 **v1 空步骤占位**（对齐开发机
  账本已记的版本号）+ **v2 `DROP TABLE IF EXISTS sk_shop_sets`**（幂等清残留）。
- **`bk_periods`**（月结留位表）：全仓零读写，产品本期明确不做月结（LEDGER_PLAN RK-10）。删建表语句，
  `ledger.main` 新增 **v4 `DROP TABLE IF EXISTS bk_periods`**。
- 相关脚本同步：`reset-dev-data.mjs` 清数据清单去掉 `bk_periods`；`refresh-table-comments.cjs` 用途表
  去掉两项；`shop-db-smoke.cjs` 移除两条依赖老形状的合并用例。
- 计数：新库稳态 **54 → 53 对象**（表 53 → 52，`bk_*` 由十张变九张）；运行库 **60 → 58**。
- 门禁：`tsc` · `verify` · `verify:docs` · `db:inventory` · `shop:smoke` · `ledger:smoke` · `order:smoke`
  全绿；`schema:smoke` 仅既有 [H] 失败（07aaac3 回退后断言未同步）。依据见
  `docs/notes/2026-10-30-db-schema-and-migration.md` §8。

### Reverted · 撤销「导入即按变体键自动建款色/产品」（2026-10-29）

- **现象**：产品列表出现一批 `AE-1005012506975770` 形态的占位产品，且自动建款在实际运行中
  长出了**大量重复的款** —— 同一个 listing 每次导入都可能各成一套款色。
- **回退**：`autoAssignByMap` 无人工映射时**不再**按键自动建款色/产品（删除
  `ensureStyleColorByVariant` / `assignByVariantKey` 两条路径），订单行留在**待认款**
  （`style_color_id = 0`），由人在认款界面手动认 —— 恢复 2026-10-28 之前的导入行为。
- **保留**：`variant_key` 仍照常落库（键是事实，不是行为）；`backfillVariantStyleColors`
  只给「已归类但键表没记」的存量行**补记绑定**（只补新、不建款色）；命名板 / 款合并等
  下游功能改由「人工认款」产生的数据驱动，全部照常。
- **副作用说明**：无图订单在人工认款路径（`assignOrderStyle` 经图片投影落行）上无法落款色
  —— 回退前靠自动归类能归，回退后只能留待认款。若需要支持无图单的人工认款，需另行处理。
- 门禁：`tsc` · `vitest`（1129）· `order:smoke`（94 项，[13] 改断言为
  "无映射不自动归 + 导入不建任何 AE- 款色/产品占位 + 认款后功能照常"）全绿。

### Added · 导入即归类：归类键从订单原文来，不再先建款建色（2026-10-28）

- 新增 `variantKey.ts`（`electron/` 下，纯函数、零依赖）：键 = `(店铺, 商品ID, 平台色原文)`，
  即平台在下单那一刻就记下的**确定性等价类**。色只剥不可见字符、**不折大小写、不映射标准色**
  （`Color:1` 同时出现在 7 个不同 listing：语义不可信，但组内分组力可用）。
- 迁移 `order.main` v12：`oi_order_items += variant_key`（从 `raw_fields` 回填）+ 新表
  `oi_variant_keys(variant_key UNIQUE, style_color_id, state)`。**N:1 合法**（人工的跨 listing 合并就是 N:1），
  所以映射必须是表，不能靠"同键行的 `style_color_id` 相同"反推。
- 导入时若无人工映射，按键**自动建/复用款色**：款编码 `AE-<商品ID>`（幂等，非自增 ——
  自增会让重导长出第二套款）、款色名保留平台色原文（裸数字会让人警惕去看图，写成"黑色"就没人核了）、
  补一行**空名**的 `pl_products` 占位（供应商/成本/拿货要挂）。
- 分类结论的唯一投影点 `projectImageColorToOrders` 顺带记键记忆（`ON CONFLICT DO NOTHING`）：
  记忆只增不改，误点不会永久改写它。
- 修：`ITEM_STYLE_COLOR_SRC` 的兜底从"图的款色"改成 `COALESCE(行款色, 图款色)` ——
  采集通道的行 `image_id` 恒空，只认图则这些行永远进不了拿货单。
- 修：`ensureOrderSchema` 末尾补跑存量收口（先给已归类的行补记绑定，再归"有键未归"的行）。
  真库副本实测：已归类 65/75 → **75/75**，8ms，重跑三张表行数不变，`outstanding()` 未归类组 9 → **0**。

### Added · 剩下两件必须人做的事：给色起名、认出「一件货两个链接」（2026-10-28，P3/P4）

- **命名板**（`VariantNamingCard`，挂「归类核对」）：一个 listing（店铺+商品ID）一块，
  组头是「款编码（只读）+ 款名 + 厂家」，下面是这个 listing 的全部色输入框 —— 一屏填完、回车即存、可全跳过。
  色名只改 `oi_style_colors.color`、**不动 `code`**（`code` 是拿货单/对账引用的稳定标识）。
  同款重名提前判并给一句人话（不吐 `UNIQUE constraint failed`）。
- **款信息入组头**（`order-style-basics` → `saveStyleBasics`）：款名与厂家写产品主数据，
  **只送改过的那一项**（`undefined` = 不改、`0` = 清空厂家，两件事）；两步同一事务
  （先写名再校验厂家的写法，在厂家不存在时会把名字留在库里却回 `ok:false`）。
- **款合并**（`StyleMergeCard`，挂「归类核对」）：同厂家下 ≥2 个款时给出候选，勾选后一次 N→1。
  色只按**同名**配对：同名 ⇒ 改键（源色行留着，否则拆不回去），不同名 ⇒ 搬色（只改 `style_id`，
  色 id 不变 ⇒ 键与订单行零改动）。**不按位置、不按相似度**判"这两个色其实是同一个"。
- 新表 `oi_style_merges`（一次操作 = 一行，带 `batch_id`）+ `oi_style_merge_items`（明细，`kind = color|key`）。
  撤销按**批次**：一次 N→1 在库里写 N 行，按行 id 拆只能拆掉最后一个源款。
- 修一处口径分裂（不修则 P2 的成果在拿货页看不见）：改造后款色权威在**订单行**，但
  `shippingRows` / `listOrdersPage` / `updateOrder` 回读 / `pickingRows` / `purchase-db` 缺口与 FIFO
  仍按图片链取色。真库 **9/75 行**因此"统计说已归类、列表说没归类"。收成一份 `ITEM_STYLE_COLOR_ID`
  （订单行优先、图回落）四处改读它；`purchase-db` 的 FIFO 需求行还从 `JOIN oi_images` 改成 LEFT JOIN
  （无图的行原本根本查不出来 —— 那等于"没图的货不用拿"）。

### Changed · 命名板：待命名的 54 个色改为键盘一口气填完（2026-10-28，P3 补）

- 存完一个色名后**自动把光标交给同组下一个未命名框**，本组填完则交给下一组的第一个。
  改前每保存一次都会重读重排（已命名的挪到组尾、输入框重建），人要再用鼠标点下一个框 ——
  真库 54 个待命名键 = 54 次点击。这是这一页唯一还属于人的劳动，能省的只有"找框"这一半。
- 组头给出**这一组**还剩几个没起名（组内口径；总数仍只有标题旁一处口径）。
- 明确不做「按平台原文批量命名」：真库 54 个键只对应 22 种原文（`1` 出现 7 次、`3`/`4` 各 6 次），
  但原文是**商品级编号** —— 跨 listing 的 `1` 不是同一个颜色（键之所以是 `(店铺, 商品, 原文色)`
  正是因为这个）。按原文批量命名等于把"位置"当"语义"，错得悄无声息、还会被键记住。

### Added · 拿货前把"不确定的数据"拦在写入口（2026-10-28，P5）

- **门 1 店铺归一**（`shopNormalizeGate` → `shop-gate` 通道 → 「归类核对」提示条）：按
  `DISTINCT oi_orders.shop` 的**订单行数**报"还有 N 家店没归成实体、涉及 M 行"。判据复用
  `listUnmapped()`（"未归一"只有一个实现），作用域收窄到**订单**（拿货单里的旧店名不归这个门管）。
  **不硬拦**：它保护的是数字口径（同店名的键会分裂），而归类在导入时已经发生 ——
  事后拦动作只能做成"点不到的门"。
- **门 2 拿货前检查**（`purchaseGateOf`，纯函数）：本次要拿的款里存在"没归到款色"或"款没指定厂家"的行时，
  `createFromPick` 在**写入口**拒绝并给原话（不是 disable 按钮）：一张卡上常只有一两行有问题，
  禁用整卡会挡掉能拿的货。**色名不在门里** —— 58 次输入变成门槛=没人再敢用。
- **`FIRST_RUN_STEPS` 第三步语义翻转**：从「点一款认款」改成「看要拿什么」（真按钮跳「发货台 › 拿货」）。
  归款已经是导入时自动完成的，第一步就成了别的模块的事 —— 原地留一个"就在这一页"反而在骗人。

- 修：**同一张图被多个变体键共用时，后进的那行会把先归好的行改判**。`assignByVariantKey` 的注释写着
  "只补空"，实现却经 `setImageStyleColor` 全量投影（`WHERE image_id = ?`）。一个商品多个色共用一张
  主图是常态（AE 的图是商品的、色是 SKU 属性），症状是"先导的那色变成后导的色"。
  改为 `{ onlyUnset: true }`：图只能补**没有结论**的行；人工改图（识别确认 / 纠正 / 点名归款）仍全量。
  同时 `rememberVariantBinding` 从"按图取键"改成"按**行上确实持有这个结论**取键"（作用域与投影一致）。
- 修：**「先导订单、后配映射」的回填静默失效**（P2 引入的回归）。回填的候选判据是"图上没结论 /
  占位色"，而导入即归类之后这两条再也不可能成立 ⇒ 用户配完映射看不到任何变化，和"没配过"长得一样。
  判据换成 `guessedScSql` / `isGuessedStyleColor`：**这条结论是不是系统猜的**，取两条事实
  （该色上没有 `state <> 'auto'` 的键绑定；色名仍等于订单原文色）—— 猜的才允许映射改写，
  命名过 / 合并过 / 改过色名的一律不动（`reassignCore` 候选、`autoAssignByMap` 的 ②③④ 分支、
  映射带色分支、无图行分支四处共用同一个判据）。

### Changed · 套装模型收敛为「产品关联子商品」一张表（2026-10-28，取代上一版的两张表设想）

- 业务澄清两条，直接改了模型：①套装**不是整体色**，而是自由搭配（上衣红 + 裤黑）；
  ②**子商品也是独立商品、能单独卖**。⇒ 组合是**产品库**的事，落在"产品 ↔ 子商品"的关联上，
  不是每张订单各存一份副本。
- 新增 `pl_bundle_links(product_id, item_id, alias_key, role, child_product_id, child_color, qty)`，
  `UNIQUE(product_id, item_id, alias_key, role)`。子商品就是 `pl_products` 自己的行，
  本表**只存关系**：不复制子商品的名称/成本/图片（复制即第二个真相，改子商品时套装那份静默过期）。
- **键里必须有 `alias_key`（平台色号）**，这是本设计唯一不能省的列：关联的不是
  "这个套装 ↔ 那些子商品"，而是"**这个套装的这个色号** ↔ 那些子商品的那些颜色"。
  同款套装色号 8 = 红上衣+黑裤、色号 9 = 黑上衣+黑裤；少了色号，两个色号会拆成同一堆东西，
  **拿货单上颜色就没了**。色号归一复用 `colorAliasKey`（与 `oi_color_aliases` 同一函数，
  否则同一个 `8` 在两张表里是两个键）。
- 不设 `pl_products.kind='bundle'`："是不是套装"= 有没有关联行，是派生事实；写成列必然与关联表漂移。
- `resolveBundleParts({productId, itemId, color})` 的查找顺序是**点名 > 提示**：
  `(商品ID, 色号)` → `('', 色号)`。商品级是"这件事就这么定"、产品级是"同款一般都这样"。
- **该色号没配过 ⇒ `matched:false`、`parts:[]`，绝不回落别的色号**。拿别的色号顶上，
  统计会安静地给出错误的拿货单（少发一条裤子是发货后才发现的事）；调用方应进"待配"队列。
- 写入处三道闸：自引用拒、**子商品本身是套装拒**（不嵌套 = 环的入口）、子颜色必填
  （留空等于"到展平时再猜"）。校验全部前置，失败**不动**已存关联（避免"保存失败但搭配没了"）。
- 冒烟 `product:sku:smoke` 新增 9 条。断言刻意让三种错误实现各自变红：色号不区分 /
  商品级被产品级压过 / 未配色号回落。变异已验证：去掉色号过滤 ⇒ 红 5 条；反转商品级优先 ⇒ 红 1 条。
- 未做（下一步）：`itemStyleColorIds()` 三档回落（订单快照 → 关联展开 → 图款色）、
  展开结果经 `ensureStyleColor(childCode, 色名)` 落到 `oi_style_colors`、5 处汇总口径。
  **在此之前页面行为零变化。** 设计取证见
  [`docs/notes/2026-10-30-data-model-and-dependencies.md`](docs/notes/2026-10-30-data-model-and-dependencies.md)。

### Added · 套装（一件实物多个款色）数据层 P0（2026-10-28）

- 场景：一套衣服分上衣和裤子，两者的**款与颜色都不同**，平台当成一个商品卖。此前模型无法表达 ——
  款色归属的唯一权威是 `oi_images.style_color_id`（单值、且按内容指纹共享记忆），一条订单行只能指向一个款色。
- 新增表 `oi_item_parts`（`order_item_id` + `role` + `style_color_id` + `qty_per_set`，
  `UNIQUE(order_item_id, role)`，`ON DELETE CASCADE`），把"这件实物由哪几个款色组成"落在**订单行**上：
  套装事实必须压过图级共享记忆，否则同一张套装图在别的订单里会被读成单品、且没有任何界面能纠正。
- **读取口径只有一处** `itemStyleColorIds(orderItemId)`：有部件 ⇒ 只返回部件集（图上残留的单品款色
  不许并进来，并进来 = 一件实物算两遍）；无部件 ⇒ 回落**图**的款色。**老数据零迁移** ——
  表为空即"不是套装"，现有页面行为不变（P0 也还没有任何界面能写入部件）。
- 同部位要两件用 `qty_per_set=2` 而不是两条同 role 记录；组合键 `bundleKeyOf`（如 `12x1+57x1`）
  是派生值、不落库（与录入顺序无关）。校验在写库前给出可读中文错误，且**校验失败不动已存部件**。
- 冒烟 `scripts/order-db-smoke.cjs` 新增 `[10]` 节 11 条：套装行与单品行**期望不同的值**
  （若实现把图款色并进套装，`2` 会变 `3` ⇒ 红；两条都期望 `2` 就会恒绿）。变异已验证两条主路径
  （掺入杂物 / 去掉回落）各自只红目标断言。
- 未做（下一步）：P1 让套装商品走 `resolveOrderSkuList`（`resolveOrderSku` 的 `LIMIT 1` 现在会把套装
  回流写成单品、第二个款被判 `conflict`）；P2 核对页部件槽位；P3 采购需求/拣货按部件展开
  （`picking-db.ts:121` 的回落是**行优先**，与本口径相反，接入时必须改）。设计与取证见
  [`docs/notes/2026-10-30-data-model-and-dependencies.md`](docs/notes/2026-10-30-data-model-and-dependencies.md)。

### Added · 套装映射 P1：不再把套装固化成单品（2026-10-28）

- 上一版的行为是**会写错数据**的：给套装行点了「上衣 A 款」后，`skuBackfillFromOrder` 把
  `(店铺, 商品ID, 色) → A` 写成确认映射，之后同商品所有订单自动归成上衣（裤子永久丢失，
  且因为有归属、不进待核对队列，用户没有任何机会发现）；再点「裤子 B 款」还会被判 `conflict` 拒写。
- `pl_shop_sku` 加列 **`bundle_role`**（`''` = 普通映射；非空 = 该商品的某个部件），迁移
  `product.sku` v4（`PRODUCT_SKU_STEPS` 3→4）。三处判据同步改，缺一不可：
  - `upsertSkuMappings` 的判重键：套装行按 `(店, 商品, bundle_role)`，普通行额外带 `bundle_role = ''`。
    **不改就是灾难** —— 套装各部位的 `spec` 都是 `'*'`，按 spec 判重会让"写裤子"命中"上衣"那行并
    UPDATE 它，上衣映射静默消失而回执报 updated。
  - `resolveOrderSku` 加 `AND bundle_role = ''`：套装商品的映射是"组成部分"，不是"这行是哪款"。
  - `skuBackfillFromOrder` 检测到行有部件 ⇒ 逐部位写（`spec='*'`）；同部位改绑一律 `conflict`
    （影响面不对等，改绑请走「商品ID 映射」页）；套装分支不调 `reassignOrdersByItemIds`（白扫）。
- 新增 `resolveOrderBundle()`（产品域）返回部件模板，供 P2 核对页"这件商品上次是哪几个部件"。
  ⚠️ 同一 `role` 出现多条 = 该部位绑过不同款的**歧义**，调用方只能摆候选、不得自动套用。
- `normalizeSkuUniqueKey`（v2 重建表）开头补 `ensureSkuColumns()`：重建按 `SKU_COPY_COLS` 逐列搬，
  而这份清单会随加列变长；停在 v1 的老库没有新列，直接 `SELECT` 会抛 `no such column` 并把整个
  迁移事务回滚（症状是"升级卡死"，报错指向一句看不懂的 SQL）。
- 冒烟 `order-db-smoke.cjs` 新增 `[11]` 节 6 条（两行不互相覆盖 / 套装不自动归款 / 部件模板 /
  单品回归 / **单件套装混卖** / 同部位改绑 conflict）。断言全读库里的人行、不看返回值。
  变异已验证：判重退回按 spec ⇒ 红 4 条；去掉 `bundle_role = ''` ⇒ 红 2 条。
- ⚠️ **本节已被上面的「套装模型收敛」取代**：新模型里一个商品只映射一个套装产品，
  搭配在 `pl_bundle_links` 里，`bundle_role` 这一列与它的三处判据**待退**（尤其
  `resolveOrderSku` 的 `bundle_role = ''` 过滤会让套装商品解析不到产品、展开无从谈起）。

### Fixed · `schema:smoke` 因 v11 漏改常数而连红 7 条（2026-10-28）

- `ORDER_MAIN_STEPS` 仍是 10（上一轮加 v11 删 `oi_queue` 时没同步），7 条断言一起红；
  已补到 11。顺带给 v11 补上守卫：场景 H 里**手工造 `oi_queue` + 把版本退回 v8** 让 v11 真跑一遍，
  再断言表消失 —— 只建表不退版本的话 v11 早已记账完成、不会再执行，"表被删掉"会退化成
  "表压根没建过"的假绿。变异（把 `DROP TABLE` 改成删另一张表名）已验证该断言会红。

### Docs · 本地视觉方案 B（CLIP 小模型）实测结论入库（2026-10-28）

- 在真库 82 张已归类图上做了留一法实测（不联网、不改产品代码），结论写进
  [`docs/notes/2026-10-30-order-classify-panel.md`](docs/notes/2026-10-30-order-classify-panel.md) §八：
  款 Top1 **93.6%** / Top3 98.7%（剔除近重复图后 91.1%），`margin≥0.02` 弃权后建议精度 **98.6%**；
  **CLIP 判色 AUC 0.522 ≈ 随机**（色应交给像素主色集合 ΔE，AUC 0.729）；
  另取证两条与本方案无关、但会直接卡住任何像素方案的事实：**`nativeImage` 解不了 webp**
  （真库 83% 是 webp），以及**颜色标签本身有约 20% 自相矛盾**（同一"红色"款色下实测有黄图与黑图）。
  分发建议：用 `onnxruntime-web`（WASM，46-165ms/张、零原生依赖）而非 `onnxruntime-node`（每平台 +65~87MB 二进制）。

### Removed · 云端视觉识别链路 + 待识别队列整体删除（2026-10-28）

- 用户决定「**不接云端 API**」（本地视觉方案另议，判断与路线见
  [`docs/notes/2026-10-30-order-classify-panel.md`](docs/notes/2026-10-30-order-classify-panel.md)）。
  据此删掉三块**零调用方**的残件 —— 它们自 2026-10-05「识别未归类」按钮删除起就没有任何消费方：
  - `src/core/ai/**`（引擎工厂 / OpenAI 兼容客户端 / 视觉提示词）、`src/modules/today/classify.ts`
    的 `readEngine` 与 `recognizeOrder`、「设置 › 识别」页（`RecognitionSettings.vue` 与
    `src/core/settings/panels.ts` 里唯一一条贡献）。
  - `order-api-key-set/get` 两个通道（preload / `src/types.ts` / `src/core/services/ipc.ts` 三处同步）
    与主进程 `safeStorage` 加密落盘实现（不再写 `userData/secure/oi-api-key.bin`；**历史文件不主动删**，
    避免把"没有明文备份"的凭据直接抹掉）。
  - `oi_queue` 待识别队列整套：建表 + 数据层（约 190 行）+ 10 个 IPC 通道（三处）+ `order:smoke` 用例
    + `reset-dev-data` 表清单。
- **v11 迁移 `DROP TABLE IF EXISTS oi_queue`**（真库实测 0 行，删表不丢业务数据）。
- **顺带修掉一个从未生效的 bug**：`listImageLocalPaths` 原来 `UNION` 了 `oi_queue.local_path`，
  而该列**从未存在** ⇒ 真库上整条 SQL 抛 `no such column: local_path`，被调用方 try/catch 吞掉，
  「孤儿图清理」一直处于失败状态。删掉那一支后才第一次能跑（对真库直接执行原 SQL 可复现）。
- 门禁：`tsc` ✅ · `verify`「IPC 契约一致」✅ · `vitest` **1107 passed (53 files)**
  （原 1111/54，减 `visionPrompt.spec.ts` 的 4 例）· `order:smoke` 全通过 · `lint` 0 error · `build` ✅。
  `vue-tsc` 另剩 3 条**本次改动之前就存在**的 WIP 不一致（`orderShippingRows` 缺 `period`、
  `orderStyleAssign` 缺 `colorAlias`、`purchaseOrderCreate` 缺 `mode`），未擅自补。

### Changed · 「发货台 › 归类核对」批量定款 + 一次点击落库（2026-10-28）

- 用户口径：「归属款还是只能一个一个选，路径太长（点击、选择、关闭、确认），能不能批量操作，并且简化操作步骤」。
  上一轮把下拉换成带图弹层解决了"看不准"，但**一个款一次**这件事没变，路径反而更长了一点。
- **勾选列 + 吸底动作条**：表头全选本页、逐行勾选、点「同商品 ×N」一键勾上该商品在本页的所有行
  （真库 42 行按商品去重只有 17 个商品，这条路吃掉大半点击）。动作条提供「批量定款…」
  与「确认无误（N）」，其中 **N = 真的会被处理的行数**（不含未保存改动的行，并另写"其中 K 行…"）。
- **批量定款弹层**（`BulkStylePicker.vue`）：按「店铺 + 商品ID」分组，同一个商品只选一次款
  （分组键与行内徽标**同一个函数** `productKeyOf`）；没有商品ID 的行各自成组，不与别的行合并。
  颜色**不在弹层里选** —— 按每行原色对款色卡（`pickColorFor`），对不上就**不猜**：该行不落库、
  留在列表并保持勾选，等单独选色。
- **一次点击落库**：`StylePicker` 主按钮改「保存并下一条」—— 落库 + 自动接上顶上来的那一行；
  「只填上」（原「确定」）保留为可退回的中间态。路径从 6 步降到 3 步（点款格 → 选款 → 选色/保存）。
  批量路径只 `bump()` **一次**（`saveOne` 的 `defer`），30 行不再是 30 次整页重载。
- 款**没录颜色**时弹层给输入框并要求填上（原先允许"没色也确定"，而行内 `colorMissing` 又会禁掉
  「保存」⇒ 用户被卡在一个没有出路的状态里）。
- 抽 `StyleList.vue`（搜索 + 含停用 + 款首图 + 键盘上下），单品挑款与批量定款**共用一份**
  取图实现（`styleImages` → `orderImageThumbBatch` 少接一条就整列空占位且不报错）。
- 冒烟 `today:ui` **309 条全绿**（+11 条：全选/数字诚实/同商品点选/一组与两组两种弹层形态/
  保存并下一条自动接管下一行/批量定款遇多色不猜）。`classify:shot` 增 `bulk-bar-*`、`bulk-picker-*`。
- 结论见 [`docs/notes/2026-10-30-order-classify-panel.md`](docs/notes/2026-10-30-order-classify-panel.md)。

### Fixed · 「归类核对」的「全部确认无误」原来会改**全库**（2026-10-28，P0）

- 原实现走 `markCorrected({ all: true })`，宿主是 `UPDATE ... WHERE corrected = 0` —— **不带导入日、
  不带搜索词**。而这一页只显示"今天这批"：页面上 5 行、库里 300 行未核对 ⇒ 那 295 行（别的日子、
  别的批次）被一起确认，还顺带把它们的克重与进价快照钉死（事后无从判断当时是什么价）。搜索时更糟。
- 改成按**本页同一套筛**（导入日 + 搜索词）先取 id 再点名标记，按钮文案随之改为「这批全部确认无误」
  （原名会让人以为动的是全库）。撞上 2000 行上限时明确说出"还有 N 行没处理"，不静默部分成功。
- 冒烟补一条**反向守卫**：全程 `orderMarkCorrected` 一次都不许收到 `{all:true}` —— 只断言"发的是数组"
  的话，哪天改回 all 只是那条变红、看不出为什么危险。

### Changed · 「发货台 › 归类核对」归属款改成**带图选择器**（2026-10-28）

- 用户口径：「当前归属款只是通过下拉列表看文字，不够直观，也容易对应错」。原生 `<select>`
  有两条死路：选项里放不了图、展开时没法把这一行的订单图摆在旁边 —— 而这一步的全部判据就是**图**。
- 「归属款」格改成**带款首图的按钮**（`cl-style-<id>`，值走 `data-style`）：不点开也看得见这行
  挂的是哪款；没点名款时显示「自动匹配（未归类/当前 X）」且**不留空图位**（空框会被读成缺数据）。
- 新增 `src/modules/today/tabs/StylePicker.vue`：左栏固定这一行的订单图（点击可放大，复用页面已有的
  原图弹层），右栏带图款列表 + 搜索 + 「含停用」；选中款后出**该款真实有的色卡**，没选色不许确定
  —— 于是"有款没色"这个中间态在界面上不再存在（原先是回车保存时才被 toast 拦）。
- 取图零新 IPC：`purchaseStyleImages`（款编码 + 款色 → 本地路径）→ `orderImageThumbBatch`（路径 → dataUrl），
  两条串起来；任一步失败静默退化空占位（图是"帮你认"，不是"能不能核对"的前提）。
- 「不点名款（按图片指纹自动匹配）」保留在弹层底部，且**只清款不清色**（与换控件前的 `@change` 一致）。
- 冒烟 `today:ui` 同步：`cl-style-NN` 由 `<select>` 变按钮 ⇒ 值判据改读 `data-style`；换款清空的
  观察点从"行内颜色被清空"移到"弹层色卡无选中 + 确定禁用"；订单图断言按语义选择器
  （`.cl-thumb-btn img`）取，不再按 `img` 标签数（表格现有两类图）；`purchaseStyleImages` 的
  `[0]` 顺序断言改成"第一条按行带尺码的调用"。**298 条全绿**。
- `classify:shot` 增一张 `picker-*.png` 取证图（布局类改动只能人眼看）。
- 结论见 [`docs/notes/2026-10-30-order-classify-panel.md`](docs/notes/2026-10-30-order-classify-panel.md)。

### Fixed · 「款与商品 › 待认」SKU 只报条数（2026-10-28）

- 待认表副行不再摊开采集到的**全部** SKU 色码文本（`黑/L、4/M、…`）。右栏 ~300px 的副行里
  这段一动就折成两行，行高 66 → 86px、一屏可见行从 3 掉到 2 —— 用户报的"列表展示不全"。
  现在副行只显示 `SKU N 条`，色码全文进该格的 `title`（悬停/长按仍可核对，认款要看的证据没丢）。
- 「未采集」独立成一个分支：没采到 SKU 矩阵（列表轻采/手贴行）说「未采集」并提示"要色码得重新采集
  详情页"，不再拿 `SKU 0 条` 冒充。
- `PendingRow` 新增 `skuCount`（渲染用），`skuText` 降为仅供 `title`；数量与文本出自同一对函数
  （`itemSkuCount()` / `itemSkuText()`），模板不另算。
- 冒烟 `goods:ui` 的对应断言同步改名（`pending-sku-text` → `pending-sku-count`），并改成**双向钉**：
  可见文本必须不含色码串 **且** `title` 必须仍含全文。
- 结论见 [`docs/notes/2026-10-30-order-import-pipeline.md`](docs/notes/2026-10-30-order-import-pipeline.md)。

### Fixed · 记账模块审查后的 24 项修改（2026-10-27）

审查报告 `docs/archive/reviews/LEDGER_REVIEW_2026-10-27.md` 与修改计划 `docs/archive/plans/LEDGER_FIX_PLAN_2026-10-27.md`
（A 界面止血 12 项 / B 拦截与口径 7 项 / C 体检与治理 4 项 / D 文档订正 3 项）已**全部落地**。
按计划排序：D 先行（订正两处与实现相反的方案描述），A 独立提交（界面止血可单独回滚），B 早于 C
（B5「其中公共」与 C1 体检落在同一个 `getSummary()`）。

**A · 界面（12 项）**

- 「全部日期」下记一笔不再默认填 `2026-10-01`，而是**今天**（新增纯函数 `defaultBizDate`，4 例单测）；
  仍然支持记账到历史月。
- 相关人台账取数失败时不再停在"空列表 + 全 0"的假象：`loaded` 复位并给「余额不可用，请勿据此结账」。
- 单店页店铺下拉补 `:value` 绑定，店铺已不在列表时显示 `#id（已不在店铺列表）` 而不是静默跳到第一家。
- 切月/切筛选清空旧数据再拉新数据（避免"上月数字挂着本月标签"）。
- 结算失败的错误块移到弹层页脚正上方并 `scrollIntoView`（原来沉在内容底部，用户以为"点了没反应"）。
- 主数据（店铺/相关人/科目）加载失败与条目列表失败**分开显示**，并给重试按钮。
- 台账页脚写明「0 不等于已结清」，净往来为 0 但两向都有余额时加「对冲」标记。
- **三个「变更相关人」入口**：相关人抽屉页脚、已结算条目的编辑弹层、明细批量条。
- 筛选条件统一走 `applyFilter()`（落盘 + 重取），原来 6 处 `@change="load()"` 会丢掉已保存的筛选。
- 术语统一「本店 / 公共」（`SCOPE_LABEL`），并订正相关人管理里与实现相反的合并说明。
- 四个弹层加 `useDialogA11y`（Esc 关闭 / Tab 焦点陷阱 / 焦点归位），已填内容时点遮罩不关闭；
  明细行与台账行键盘可达。
- 体检③④ 的异常条目给可点入口（`summary-broken-open` / `summary-missing-open`），能直接落到那一条。

**B · 拦截与口径（7 项）**

- 导入「全选」只勾**合格且不像重复**的行；疑似重复的行要显式点「仍要重记这 N 行」。
- 公共条目参与库内查重（列表加 `includeAllocations`，主进程一条批量 SQL 补 `allocations`）——
  否则房租/工资这类按月重复导入完全无保护。无 `allocations` 的公共行仍跳过（只漏报不误报）。
- 批量操作 id 上限 **2000**（`electron/ledger-ids.ts`），超限**报错**而不是静默截断。
- 「撤销结算后改挂」不再默认预选：C 路会作废结算单，必须用户主动点选（`repatchMode.ts` + 8 例单测）。
- 汇总 `sharedCents` 拆成 `sharedIncomeCents` / `sharedExpenseCents`（收支混加会把"收 5000 + 支 5000"显示成 0）。
- 批量条金额按方向拆分显示（`batch-sum-income` / `batch-sum-expense`）。
- 往来抽屉末行余额 == 顶部「未结清」：`runningUnsettled(events, baseCents)` 新增起始余额；
  取数到 1000 条上限时显式提示「余额从最早可见行起算」。

**C · 体检与治理（4 项）**

- 体检④ `partyGapCents` 原先与「总收入 − 支出」是同一表达式 ⇒ **恒为 0**，永远不会红。
  改 `JOIN bk_parties` 后真能变红，并新增 `missingPartyEntries` 定位到具体条目。
  冒烟新增"能变红"用例（同一数据下旧实现返回 0）。
- **作废可恢复**：新增 `ledger-entry-restore`。只允许 `void → active`，被有效结算单占用或
  分摊合计 ≠ 金额时拒绝并提示重记。明细勾「含作废」后行上有「恢复」，确认文案写明
  "重新计入合计与相关人往来"。
- **导入可撤销（轻量版）**：导入返回 `createdIds`，明细顶部出现「撤销本次导入（N 条）」，
  走一次**批量作废**（`ledger-entries-void`，整批一个事务）。只在本次会话有效，文案写明。
  完整版（`import_batch_id` + 导入历史）仍待拍板。
- **迁移 v3**：`bk_parties` 加 `merged_to`（`ALTER TABLE ADD COLUMN`，不重建表），
  合并时落值。相关人列表与往来台账因此能把「已并入 → 某甲」和「手动停用」分开显示；
  重新启用时清掉该值。历史行一律不猜（老库的 `archived=1` 分不清是哪种）。
- **导入报的是 Excel 行号**：`rowNo` 从解析层透传到 `batchCreateEntries`（原来用批内序号，
  勾选子集后会把人指到别人的那一行）；缺「相关人」列从逐行报错改成一条列级提示。

验证：`vitest` 172 例（6 个记账 spec，新增 `repatchMode` 8 例 / `ledgerIds` 4 例 / 导入列级与行号 3 例 /
`defaultBizDate` 4 例 / `runningUnsettled` 起始余额 3 例）；`ledger:smoke` 新增 6 项真库用例
（作废→恢复→合计回同值、恢复两条拒收、迁移 v3、`merged_to` 写入与清除、Excel 行号、批量作废整批回滚）；
`ledger:ui` 新增 12 条断言（恢复入口与合计回原值、撤销导入、已并入 vs 手动停用）。
门禁：`vue-tsc` / `tsc` / `build` / `verify` / `verify:docs` / `ledger:smoke` / `ledger:ui` 全绿。

### Added · 记账结算「互抵结清」（2026-10-27）

同一个人既欠你钱（垫付、货款）又欠你钱的反向（代收货款、退货返利）时，以前只能
"付一张单 + 收一张单"，资金流水凭空多一进一出；净额为零时更是被问"为什么还要付钱"。
现在结算弹层多了第三个方向「互抵结清」：一张单同时勾收入与支出条目，两边一起核销，
**只发生差额资金流**（差额为 0 就完全不用走钱）。

- **单据记毛额，资金流派生**（`electron/ledger-db.ts`）。`bk_settlements.amount_cents` 仍是
  结算行之和（互抵单也是 1400 而不是 600），实付 `cashCents = payCents − receiveCents` 现算不落库。
  落净额会同时破掉"单据金额 == 结算行之和"的对账断言与 `CHECK (> 0)`（完全对冲时净额为 0），
  且必然出现两套口径。
- **余额汇总改为按条目收/支聚合，不再看单据 `direction`**。否则 `offset` 单两个 SUM 都落到 0，
  结了等于没结。两侧**各减各的毛额**：只减净额会让另一边留假余额（应付 1000/应收 400 互抵后
  仍显示"可收 400"，用户会被引导去再收一次）。
- **只勾单边直接拒**，提示改选方向 —— 放过去用户会以为"抵过了"，实际只清了一边。
- **两个方向都有余额时弹层给出互抵提示**，不然用户只能看到"应付方向可结 ¥1000"。
- **迁移 v2**：SQLite 改不了已有 CHECK，只能重建 `bk_settlements`。顺序是
  "建新表 → 拷 → DROP 老表 → 换名"，**不能先 RENAME**（SQLite 3.25+ 会把子表
  `bk_settlement_lines` 的外键文本改写成 legacy 表名，而本项目 `foreign_keys` 是 OFF，
  迁移会"成功"且 schema 已歪）。末尾补回索引并按 `MAX(id)` 重置 `AUTOINCREMENT`。
- **仍然不做部分核销**：一条条目只能整条结清（`LEDGER_PLAN.md` §13 保留该条）。

验证：`tests/partyLedger.spec.ts` 新增 13 例（互抵单两侧归零 / 完全对冲 / 缺两侧金额抛错 /
毛额不一致抛错 / `canOffsetSettle` 六种分支）；`ledger:smoke` 新增 6 项（含"造老形状再迁移"
一条：CHECK 放开、老数据在、子表外键仍指 `bk_settlements`、索引补回、新 id 不复用）；
`ledger:ui` 新增 10 条（两边都勾才可提交、资金流显示 ¥600、请求 `direction=offset` 且不带金额、
台账两侧归零、只生成一张单）。变异两处逐一变红：余额只减净额 → 单测红 3 例；
SQL 改回按 `direction` 聚合 → 数据层冒烟红 3 项。

### Added · 记账明细「全部日期」（2026-10-26）

明细页以前只能按月看，查一笔往年的账得一个月一个月翻。现在月份控件右侧多了「全部」：
不限月份，列出库里全部条目，顶部合计随之变成**累计**口径（不是把某个月的数留在屏上）。

- **哨兵值 `ALL_PERIOD = 'all'`，但发出去时一律换成"不带 period"**（`src/modules/ledger/useLedger.ts`）。
  主进程对 period 的处理是 `if (filter.period) where.push('e.period = ?')` —— 传 `all` 不报错，
  只会查出 0 行，于是"点了全部一片空白"看起来像没数据。合计走 `summary('')`（全期间，
  与「往来」对账同口径）。
- **期间口径写死在标签里**：`XXXX年X月 · 整月` ↔ `全部日期 · 累计`。不写成"本月"是刻意的 ——
  用户不该从数字反推自己看的是哪一段。
- **全部日期下翻月不会算出 `NaN-NaN`**：`shiftMonth` 先取本月再翻（`NaN-NaN` 是合法字符串，
  能通过任何存在性检查，主进程只做 `slice`，于是"翻一下之后一条都不剩"且不报错）。
- **偏好存过 `all` 要还原成 `all`**：`init()` 以前只认 `YYYY-MM`，漏了就是一个"设定不生效"的静默 bug。
- **单店 / 汇总页跟着联动**：收支、科目分布、公摊明细在全期间都能算；唯独单店页的**订单收入对照**
  在全期间不取数并说明原因（订单按月拉、有 2000 行上限，跨月必然截断，拿它对照会得出
  "记账比订单多"的错误结论）。
- **导出**：文件名与表头期间同步变成「全部日期」；列表撞上 1000 条上限时在筛选说明里追加
  「导出只含当前显示的这些」—— 否则用户会以为整本账都导出来了。
- 导入完成 / 记一笔保存后**不再自动跳月**（全部日期下本来就看得见，硬切会把用户选的期间改掉）。

验证：`tests/ledgerPeriod.spec.ts` 新增 6 例（不传 period / 合计传空串 / 翻月不是 NaN /
偏好还原 / 坏值回落）；`ledger:ui` 新增 5 条断言 —— 从"上个月空态"点「全部」必须变回 6 行
（这是决定性证据：空月变有数据，说明真的没按月过滤）。变异三处逐一变红：
`period` 直接传哨兵值、偏好还原漏掉 `all`、`shiftMonth` 不判全部（报 `NaN-NaN`）。

### Fixed · 批量导入整批失败：`An object could not be cloned.`（2026-10-26）

真机：点「导入」→「导入失败，一笔都没进：An object could not be cloned.」——报错与业务毫无关系，
也说不出哪一行有问题。

- **根因**：`buildLedgerImportPayload` 用 `{ ...r.input }` 拼载荷。结果躺在 Vue 的 `ref` 里，
  读出来的每一层都是 **reactive proxy**，而 `ipcRenderer.invoke` 走**结构化克隆**，proxy 一律克隆不了 ——
  于是主进程一个字节都没收到。浅拷贝只换最外层：`allocations` 与它的元素还是代理。
  表现随文件内容而变（只导专属行时 `input.allocations` 是 undefined，碰巧能过；**一旦有公共支出就整批炸**）。
- **修法**（`src/lib/ledgerImport.ts`）：新增 `toCloneable` 深拷贝，`buildLedgerImportPayload` 一律现造
  普通对象/数组/标量。刻意**不做字段白名单** —— 白名单在 preload 的 `sanitizeLedgerImportEntries` 里
  已经有一份，渲染层再抄一份就等着"新加字段两边不同步 → 静默丢掉"。
- **补上真机缺口**：`ledger:ui` 此前**完全不覆盖导入弹层**（`docs/notes/2026-10-26-…` 里已记为残留缺口），
  这次的错正落在这段盲区。现在用 **Node 侧生成的真 xlsx** 走完 `selectExcel → readWorkbookSheets → 预览 → 提交`，
  假桥的 `ledgerEntryBatchCreate` 桩**照真机先做一次 `structuredClone`** —— 载荷里混代理当场红。
  新增 9 条断言（认列 / 取整标签 / 将新建 / 逐笔分摊 / 克隆 / 金额分 / 分摊行 / 自动建名 / 真落库 11→14 行）。
- **验证**：单调 `tests/ledgerImport.spec.ts` 新增 ⑪ 组 2 例（结果放进 `ref` 后 `structuredClone` 必须过；
  反向证明浅拷贝确实抛错）；变异验证两处 —— 退回浅拷贝时：单测 ⑪ 变红、`ledger:ui` 导入步变红。
- 顺带核对同模块其它 IPC 入参：`entryUpsert` / `exportExcel` / `repatch` 都是显式取值现造，无同类问题。

### Changed · 记账导入：金额超过两位小数自动保留两位（2026-10-26）

用户口径：「导入时解析的金额自动保留小数点后两位」。

- **金额单元格 → 到分**（`src/lib/ledgerImport.ts` 的 `parseImportAmountCell`）：数字格与文本格先各自
  归一成**十进制字符串**，再走同一段算术 —— 数字格 `toFixed(6)` 去尾零、文本格 trim，两条路不会再
  "Excel 里 1200.505 进成 1200.50、手打成文本却进 1200.51"。
  - 两位以内仍交给 `parseYuanToCents`（与「记一笔」同一份实现，结论恒等，新增用例逐个数字比对）；
  - 超过两位才走本层的取整分支：**只看十进制第三位半进一**，全程字符串/整数不碰浮点
    （`1.005 * 100 === 100.49999999999999`，用浮点会把 1.005 舍成 1.00）。
- **取整不静默**：改过值就回一句 `rounded`，逐行塞进该行 warn、状态列标「金额取整」，
  汇总条写「N 行金额超过两位小数、已自动保留两位」。用户要的是别卡住导入，不是账上少几厘还没人告诉他。
- **不拦行**：取整的行仍然 `ok` 且默认勾选（旧行为是整行报错「金额只到分」，一份三级精度的
  平台结算表会整批导不进来）。
- **两种 0 分开说**：`0` / `0.00` → 「金额必须大于 0」；`0.004` → 「保留两位小数后是 0.00：导入只记到分，
  这么小的金额记不了」（同一个"金额必填"会让人回去检查单元格是不是空的）。
- 顺带修**文案自相矛盾**（上一版遗留）：相关人 / 科目的列提示还写着「导入不会新建」，与已上线的自动新建
  正好相反；改为"库里没有会按表里的写法自动新建，预览里标「将新建」"。模板说明表的用例改为断言
  「自动新建」+「店铺必须先登记」（店铺仍是唯一不新建的一轴）。
- **门禁**：`tests/ledgerImport.spec.ts` 70 例（新增取整/等价/取整成 0/只提醒不拦行 4 组）；
  变异验证过 —— 把半进一改成严格大于，取整那组当场变红。

### Changed · 记账导入：相关人/科目缺失自动新建；退店参与均摊（2026-10-26）

用户口径：「导入记账明细时，如果不存在的科目、相关人，需要自动新建。店铺状态为退店的时候也可以参与均摊」。

- **导入自动建人/科目**（`src/lib/ledgerImport.ts` → `electron/ledger-db.ts`）：库里没有的相关人 / 科目
  不再整行报错，而是把**名字**带进落库入参（`LedgerImportEntryInput.partyName` / `categoryName`），
  由主进程在同一批事务里按 `toNameKey` **先找后建**（`batchCreateEntries` 的
  `resolveOrCreatePartyByName` / `resolveOrCreateCategoryByName`）：
  - 新建的相关人类型是「其他」（文件里没有"身份"列，凭方向猜房东/供应商就是编造）；科目取这一行的收/支方向；
  - **同一个名字只建一个**（一批里出现 20 行同名也只建 1 条），主进程回传 `createdParties` / `createdCategories`，
    导入成功的 toast 原样念出新建了哪些名字，父层跟着刷主数据缓存（否则弹层下拉还是旧名单）；
  - **整批回滚连新建的人一起退回** —— 第 N 行坏掉时库里不会留下"导失败了但凭空多出三个相关人"；
  - 名字命中**已停用**的人/科目仍然报错（不静默启用、也不另建一个同名，`name_key` 唯一索引兜底）。
- **预览必须把这些名字摆到明面上**（这个功能唯一的风险就是"打错一个字凭空多一个假房东"）：
  逐行标「将新建相关人 / 科目」（悬停给出名字）、切换「只看要处理的」把它们算进去、
  汇总条写「N 行会新建名字（相关人 X 个 / 科目 Y 个）」；空态文案改成"相关人和科目会自动新建、
  店铺不会"（店铺是带平台/账号/企业的实体，跨域凭空建半个店比报错更糟，仍然整行报错）。
- **指纹带上待新建的名字**：`ledgerEntryFingerprint` 在 id 为 0 时用名字占位，
  否则"同一天同一笔钱给张三"和"给李四"会因两个 `partyId` 都是 0 被判成同一笔（把真账标成重复、默认不勾）。
- **退店（`exited`）参与均摊**（`eligibleShops`）：可摊状态从 `status='active'` 放宽到
  `active | exited`；退店只是标记，收尾的房租 / 年费 / 税 / 清仓运费仍要摊到它头上 ——
  把它排除会让这笔钱只落到剩下几家，而合计**依然等于金额**（守恒断言抓不到）。
  不参与的仍是 `archived`（停用）与 `banned`（封店）。
- **名字解析同步区分状态**（`resolveImportNames`）：店铺命中返回原始 `status`，退店算 `ok`（可摊、可专属），
  停用/封店才算 `archived`，报错文案按状态分别说「已停用」「已封店」；「未参与」标签改成「已停用 / 已封店」。
- 顺带修一处**悬空入口名**：导入文案里的「基础数据 › 店铺登记」早在 2026-10-22 就改名（实体增改在「店铺」，
  「店名归一」只管历史文本），现改为「基础数据 › 店铺」；`uxEntryNames` 同时补两条豁免
  （「相关人 / 科目」是「记账」页头按钮，非导航）。
- **门禁与冒烟**：
  - `tests/ledgerImport.spec.ts` 67 例（④ 组重写为"缺失→待建"、新增 ④b 组 3 例钉指纹与落库入参）；
  - `ledger:smoke` 46 → **51 项**（新增 `[12]` 组：自动建名 / 同名只建一个 / 整批回滚带走新建 / 停用名报错带行号 /
    退店能摊；`eligibleShops` 与名字解析两条旧断言按新口径重写，并补 `店E`(停用) `店F`(封店) 两个样本）；
  - `ipc:shape:smoke` 新增 `⑫` 组 5 项：`partyName` / `categoryName` 必须活着穿过 preload 的
    **字段白名单**（漏一个就是静默丢弃，直接测 `batchCreateEntries` 永远看不见这层）——
    变异验证过：注释掉 preload 里那两行，这 5 项当场全红；
  - `ledger:ui` 新增 `exited-shop` 步 2 条（真在勾选区、真拿到分摊），假桥 `eligible` 同步新口径。

### Added · 记账 P4 批量变更相关人 + 单店/汇总视图 + xlsx 导出（2026-10-26）

方案 §11 的 P4 收口 —— 记账五期（P0 数据层 / P1 明细页 / P2 分摊接入 / P3 往来结算 / P4 批量与视图）至此全部落地。

- **批量操作条**（明细页勾选后才出现，逐行编辑不与它混在一起）：合计**只算有效条目**（作废行不参与）；
  三个动作各自说明被挡的原因 —— 跨相关人 → 结算禁用并引导「变更相关人」；含已结算 → 结算禁用；
  全选时表头勾选与批量条同步收起。
- **变更相关人三路**（`RepatchDialog.vue`，落实 §6.4 与 RK-04）：预览数由服务端算
  （新通道 `ledger-entry-repatch-preview`），界面**不复算任何金额口径**：
  ① A `move-all` 直接改挂 —— 仅当所选**全部未结算**，否则禁用并写明原因；
  ② B `move-unsettled` 只改挂未结算 —— 已结算的留在原人与原结算单，**不写 `bk_transfers`**
     （与方案 §6.4 表里"生成往来转移记录"有意偏差：改挂本身不产生新资金事实，写了就是重复计算，
     代码里在 `repatchEntries` 上方说明）；
  ③ C `void-then-move` 撤销后改挂 —— 原因必填，**整单作废**并把连带如实披露
     （列出每张待作废结算单 + 「本次选中 / 条目数」，同单有未选中条目时给连带提示）。
  目标下拉排除**已停用**与**条目当前所属的人**（改给原主等于没改）。
- **单店视图**（`ShopView.vue` + 新通道 `ledger-shop-breakdown`）：收入/支出/结余三卡按
  **专属 / 公摊分项**；科目分布占比按**同方向**算（收入不跟支出混在一起）；公摊逐笔列出摊入金额与比例；
  另有与「统计」口径的**只读对照**（差异如实给数、不做归因、不相加、不裁定 —— RK-01）。
- **汇总视图**（`SummaryView.vue`）：店铺行拆四分项（直接/公摊 × 收入/支出）+ 合计行按四个分项各自相加；
  **四项体检**：公共池余额、Σ分摊 vs 条目金额缺口、相关人净往来对平、分摊不全条目逐条点名（id + 金额 + 已摊），
  红字声明"这个数不为 0 时上面的店铺汇总不能用来做决定"并给定位入口。
- **导出 xlsx**（新文件 `electron/ledger-xlsx.ts` + 新通道 `ledger-export-excel`，与 `picking-xlsx.ts` 同分工）：
  主进程只"分行 → 画表 → 存盘"，**行文本、金额（分）、三个合计全部由渲染层算好传入** ——
  屏幕与导出表结构上不可能有两套数；`rows` 上限 5000 行、文件名去非法字符、默认落 `documents/`；
  在保存对话框点**取消**不当失败（`__canceled__` 走取消分支，按钮恢复正常）。
- **`ledgerSummary` 的 byShop 拆成四分项**：`byShop[i]` 现在给
  `directIncomeCents / sharedIncomeCents / directExpenseCents / sharedExpenseCents` + 三个汇总数，
  单店页与汇总页读**同一份** `byShop`（交叉对账由冒烟钉住）。
- **两个只有真库跑一遍才会红的生产 bug**（都是本轮 `ledger:smoke` 新增用例当场拦下的）：
  ① byShop 拆四分项后，SQL 里 `ORDER BY expense DESC` 指的是**已被拆掉的别名** ⇒ 该查询一执行就抛
     `no such column: expense`（汇总页取数必失败）；改成 `ORDER BY (direct_expense + shared_expense) DESC`。
  ② `repatchPreview` 的 C 路预估按**本次选中条目**的金额扣残留，而作废是**整单**作废 ——
     那张结算单结的钱（含没被选中的同单条目）要从"已结算"里全部撤走，
     于是牵连场景给出的"原人改挂后未结清"**是个错的数**，用户照它决策就算错钱。
     改成按结算单**整单金额**、每单只计一次（UI 冒烟的假桥桩同步同口径，两处注释互相指认）。
- **悬空入口名守卫**（`tests/uxEntryNames.spec.ts`）本轮拦下两条记账文案：
  ① `RepatchDialog` 空态写"请先在「相关人」里新建一位" —— 「相关人」是**页头按钮**不是去处，
     且弹层开着时点不到它；改成三段式（一个人都选不了 + 候选排除规则 + 先关掉这里再从页面右上角的 相关人 新建/启用）；
  ② `LedgerView` 的"请到「往来」页刷新" —— 「往来」是同页页签，按既有先例（「运费查询」「款与商品」）
     进 `ALLOWED_NON_ENTRY` 并写明理由与存在性来源（`ledger:ui` 逐项点得开）。
- **冒烟与门禁**：
  - `ledger:smoke` 34 → **46 项**（P4 组 12 项）：三路各自的成功 / 拒绝 / 回滚、B 路**不写结转**且原结算单不动、
    C 路整单作废 + 连带条目可重新结算、七个非法入参（目标人 0 / 缺 / 已停用 / 改给自己 / 非法 mode / 作废单 id / 缺 id）
    且拒绝后不留半改、单店三卡与 `ledgerSummary().byShop` **交叉对账**、作废条目不计入、
    空店空月给全 0、体检人为制造漏摊后三个数各自报对应差额且**不互相顶包**。
  - `ledger:ui` 108 / 110 → **160 / 162 条**（宽 / 窄）：批量条合计只认有效条目、三路各自的下拉候选
    （从下拉本身读"排除原属人 + 排除已停用"）、推荐与禁用理由、请求参数、落库后的真实数据（非乐观更新）、
    C 路连带披露与撤销原因必填、三路走完整月三个数一分没变、单店与汇总同源、
    导出载荷的行数与三个合计跟屏幕一致、按筛选导出改表头与合计、点取消不报失败。
  - 全绿（逐条单看退出码）：`npx tsc -p tsconfig.electron.json --noEmit` · `npx vue-tsc --noEmit` ·
    `npm run lint`（**0 error** / 608 warning）· `npm run verify`（preload 234 键 ↔ types 234 ↔ 注册 229 通道；
    **P4 新增 4 条**：`ledger-entry-repatch-preview` / `ledger-entry-repatch` /
    `ledger-shop-breakdown` / `ledger-export-excel`，`ledger-handlers` 由 18 → 22 条）·
    `npm run verify:docs`（无悬空引用）· `npm test`（**49 文件 / 974 例**）·
    `npm run build` · `npm run ledger:smoke`（46 项）· `npm run ledger:ui`（160 / 162，宽 + 窄）·
    `npm run db:inventory`（**50 = 49 表 + 1 FTS5**，`bk_*` 仍 10 张 —— 本轮无表形状变更、无迁移步骤）。
- 结论笔记（含"作废是整单的"与"SQL 里的裸列名静态门禁抓不到"两条判定）见
  [`docs/notes/2026-10-30-ledger-parties-and-settlement.md`](docs/notes/2026-10-30-ledger-parties-and-settlement.md)。

### Added · 记账 P3 往来与结算：台账 + 抽屉 + 结算弹层 + 撤销（2026-10-26）

方案 §11 的 P3 一次收口；P4（批量变更 / 单店与汇总视图 / 导出）**当时**仍未开工（同日稍后已收口，见上一段）。

- **往来页签**：`LedgerView` 顶部 `明细 / 往来` 两页签，选中项进 `ledger` 命名空间
  （`LedgerPrefs.tab`），下次进来还停在原处。切页签只切视图，不重取明细。
- **往来台账**（`PartyLedger.vue`）：六个数据列（应收 / 应付 / 净往来 / 已结算 / 未结清 + 分方向小字），
  合计行跟随「当前显示」，另有一条**全期间恒等式**（`Σ净往来 = 全期间收入 − 全期间支出`，取数含已停用）——
  筛选只改视图、不改事实；对账**通过也要写出来**，用户需要知道这些数能拿来结账。
  「未结清」列表头可点，按绝对值排序。
- **往来抽屉**（`PartyDrawer.vue`）：六个数 + 逐笔时间线（日期倒序，**余额 = 截至该笔之后的未结清**，
  由 `partyLedger.ts` 新增的 `runningUnsettled` 算，与 `partyBalance` 同一套符号）+ 结算单列表（含已撤销与原因）。
- **结算弹层**（`SettlementDialog.vue`）：三条硬约束都落在这一层——
  ① **金额不可手填**，只显示勾选条目之和，提交也**不传金额**（服务端按条目 id 再求和，唯一算法）；
  ② 方向与条目类型绑定（付出→支出、收到→收入），切方向即清空勾选；
  ③ 上限是**该方向**余额而不是净额（混方向时只按净额判会把"该付的"误拦）。
  重复结算 / 方向不符 / 超额三类错误由服务端兜底，错误留在弹层内、不假装成功。
- **撤销结算**：原因必填（空原因不发请求）；撤销不删记录——结算单标「已撤销 + 原因」保留，
  结算行失活、条目恢复未结；明细页的「已结算」标记与作废按钮禁用同步解除。
- **修正接线**：`api.settleVoid(id, reason)` 补第二个参数（服务层签名是两参，漏传会被类型门禁拦下）；
  `PartyDrawer` 的金额着色改用 `row.kind`（模板里原本引用了不存在的 `row.type`）。
- **冒烟与门禁**：
  - `ledger:ui` 从 78 / 80 扩到 **108 / 110 条**（宽 / 窄）：页签切换与持久化、台账五个数各自独立、
    合计跟随筛选、全期间恒等式、含已停用合计、抽屉六个数与取数口径（按人、不限月份）、
    时间线 12 行且首行余额与「未结清」一致、结算候选只含未结算且同方向的条目、全选合计 = 该方向余额、
    结算请求不带金额、落库后台账与明细同步、重复结算被拒、撤销原因必填、撤销后单据保留且余额回滚。
  - 顺手修了冒烟桩的三处**假绿**：`__smokeLedger.entry()` 未暴露 `settled` / `settlementId`（条目级断言恒为
    `undefined`）、候选行用了 `actAll('[data-settle-entry]')`（该 helper 会再包一层 `[data-act=…]`，恒为 0）、
    时间线行数写成 11（实际 12：11 条明细 + 1 张结算单）。
  - `npx tsc -p tsconfig.electron.json --noEmit` · `npx vue-tsc --noEmit` · `npm run verify`（230 / 225）·
    `npm run verify:docs` · `npm test`（**49 文件 / 974 例**）· `npm run lint`（0 error / 596 warning）·
    `npm run build` · `npm run ledger:smoke`（34 项）· `npm run shop:smoke`（45 项）全绿；
    `npm run db:inventory` 对象数不变（**50 = 49 表 + 1 FTS5**）—— 本轮无表形状变更、无新 IPC 通道。

### Added · 记账 P2 分摊接入：营收占比 + 方案存取 + 明细展开 + 删店保护（2026-10-26）

把方案 §11 的 P2 剩余项一次收口；P3（往来与结算）/ P4（批量变更、视图、导出）仍未开工。

- **营收占比基准**（`src/lib/ledgerRevenue.ts`，9 例单测）：营收口径**只复用统计页那一套**
  （`src/lib/orderCost.ts` 的 `computeOrderCosts` → `summarizeRevenueByShop`），不另写收入 SQL（RK-06）。
  该文件只做两件 `orderCost` 不该管的事：归一键 → `sk_shops.id` 的映射、认不出的营收如实分桶。
  - **不猜**：名字没登记 → `not-found`；同名多店（跨平台同名合法）→ `ambiguous`，不按顺序取第一家；
    两者逐家列出金额，不参与分摊。
  - **不静默吞**：订单没写店铺 → `unassignedCents`；关闭单排除行数与统计页一致；缺金额行单独计数；
    取数上限 2000 行触顶 → **停用营收基准**（按半份数据算占比会把钱摊错）。
  - **全部参与店营收为 0** → 引擎回落平均并显式提示；落库 `basis` 记实际采用的 `equal`，
    不把「按营收」写进历史却给一组平均分摊（否则日后无法解释）。
  - **历史营收条目**：参与店铺与基准冻结，改金额按**当初分摊金额的比例**重算，
    不重新拉当期营收 —— 否则历史分摊会随之后的新订单悄悄漂移。
    （P1 的「营收基准锁金额」据此调整为「锁范围、金额可改且按原比例重算」；弹出层内写明原因。）
- **分摊方案存取**：`bk_allocation_rules` 接进记一笔弹层（下拉套用 / 保存为方案）。
  保存时带名称、基准、店铺 id 顺序与万分比；套用时按 `shopIds` 对齐回填，已不存在的店跳过并提示。
  条目上的 `rule_id` **只作来源留痕**（重算不读它）；用户换掉基准/比例后显式写 0 清掉旧来源
  （漏传会让旧方案 id 永远挂在这笔账上）。
- **明细行展开分摊**：公共条目的「摊 N 家」可展开逐店分摊（金额 / 占比 / 基准 / 「合计 / 条目」对照）；
  展开态按条目 id 缓存，保存或作废后**立即失效**，避免显示改之前的数。
- **重算校验（DB 层）**：`ledger:smoke` 补两组 —— 金额改了并重传分摊 → 旧分摊行**被替换**（不叠加，
  合计按新金额守恒，ratio 快照同步）；改店铺集合 → 被移出的店**不留幽灵分摊行**。
- **删店保护**：新增编排层 `electron/shop-delete-guard.ts`（IPC handler 与 DB 冒烟调用**同一份**，
  避免 db→db 隐式依赖）。有专属条目 / 公共分摊行 / 已作废条目引用时拒绝删除，提示「改为停用」；
  作废条目仍算历史引用（明细里仍按店名展示）。
- **冒烟与门禁**：
  - `ledger:ui` 从 55 / 57 条扩到 **78 / 80 条**（宽 / 窄两遍）：三基准、营收占比与统计页对平
    （关闭单 / 未登记 / 未写店铺 / 缺金额分桶）、方案保存-套用-回开往返、改金额后按原比例重算、
    重开旧营收账不重新拉订单（权重取当初分摊金额）、守恒失败时错误显示在弹层内且列表不变。
  - `ledger:smoke` **34 项** · `shop:smoke` **45 项**（含删除保护的拒绝与正控制）· `db:inventory`
    对象数不变（**50 = 49 表 + 1 FTS5**，业务表 47；本轮无表形状变更、无新 IPC 通道）。
  - `npx tsc -p tsconfig.electron.json --noEmit` · `npx vue-tsc --noEmit` · `npm run verify`（230 / 225）·
    `npm run verify:docs` · `npm test`（**49 文件 / 969 例**）· `npm run build` 全绿。

### Added · 记账 P1 界面：明细页 + 记一笔（含公共分摊）+ 相关人与科目管理（2026-10-25）

用户口径：P0 数据层验收后选「P1 + 公共分摊」—— 模块骨架、明细页、记一笔（专属与公共都在）、
相关人与科目管理；往来 / 结算留到下一轮。方案见 [`docs/plans/LEDGER_PLAN.md`](docs/plans/LEDGER_PLAN.md) §11。

- **新内建模块「记账」**（`src/modules/ledger/`，id `ledger`，`order: 5`）：登记进 `modules.config.json` 的
  `standard` / `pro` / `enabledModules`。做内建而非 UI 岛的理由写在 `meta.ts`：数据面是 10 张表两条轴、
  表单重（分摊预览），且改口径不该发版。
- **明细页**：月份切换（上/下/回本月）+ 五个本期数（收入 / 支出 / 结余 / 笔数 / 公共池）+ 筛选条
  （类型 / 店铺 / 科目 / 相关人 / 范围 / 结算状态 / 含作废 / 关键词）+ 明细表（日期 / 科目 / 范围 /
  店铺 / 相关人 / 金额 / 结算标 / 备注）+ 行内「改」「作废」。
  ⚠️ **指标只受月份约束，不随筛选变** —— 筛完只剩两行而合计还显示整月，是有意的；
  筛选只决定"看哪些行"。按店铺筛公共条目走**分摊行**（摊到该店的部分算该店的支出）。
- **记一笔（弹层，不跳页）**：专属（一家店）/ 公共（多店分摊）两种范围。
  - 公共范围：可参与店铺由 `ledgerEligibleShops(period)` 给（**未开业 / 已停用单列出来并说明原因**）；
    基准支持**平均**与**手工比例**（营收占比暂不提供，界面上直接写明"接通后再提供"，而不是给个按了没用的按钮）；
    保存前逐店预览金额，并显示「合计 / 条目」守恒行；手工比例合计 ≠ 100% 直接拦、不自动补齐。
  - 分摊只在 `src/lib/ledger.ts` 算一次，弹层调 `computeAllocations` 做预览，主进程只做守恒断言（P0 定下的分工）。
  - 从「这家店」切到「公共」时**默认全选可参与店铺**（不预选的话用户看到的是「0 家参与 + 请至少勾选一家」）。
  - 相关人必填，下拉内可**就地新建**（只填名称 + 类型）；按收支**分别记住上次选的人**，降低必填摩擦。
  - 跨月保存后**自动切到条目所属月份**，否则用户会以为"存了但列表里没有"。
  - 锁定边界：**已结算**条目只能改备注 / 科目 / 日期（金额 / 方向 / 范围 / 店铺 / 相关人锁死，作废按钮禁用并说明单据号）；
    **营收占比基准**的历史条目同理锁金额与范围（重算会改变分摊）。
- **资金相关人管理**：列表（条目数 / 状态）+ 新增 / 编辑 / 停用（确认框说明"历史与往来不受影响"）/ **合并**
  （单独一屏、逐条讲后果；完成回执报"改挂几条 + 承接余额"）。
- **科目管理**：收入 / 支出两套各自独立（`kind` 建表时定死），可新增 / 改名 / 停用；预置科目不可删
  （历史条目要能读懂），收入科目不会出现在支出下拉里。
- **体检条**：汇总的三个不变量（分摊缺口 / 往来缺口 / 明细缺口）非 0 时红字提示并给定位入口；
  全 0 时不摆一排 0。
- 存储：新增命名空间 `ledger`（月份 / 筛选 / 上次相关人），经 `useModuleStorage('ledger')`。
- **新增假桥无头冒烟 `npm run ledger:ui`**（`scripts/ledger-ui-smoke.mjs`，宽 1440 + 窄 900 两遍，
  55 / 57 条断言）：夹具复刻三种店铺参与态（在用·已开业 / 已停用 / 当月尚未开业）、专属 / 公共 / 已结算 / 已作废 /
  跨月 / 营收基准六类条目；stub **真改夹具**（保存、作废、合并、科目增改都落在同一份数据上），
  所以"列表与合计变了"不能靠乐观 UI 蒙过。首跑抓到两个真问题并已修：
  ① 切到「公共」时参与店铺为空（每次都要手点一遍才能存）；
  ② 空店态提示把人送到「基础数据 › 店铺登记」（该页签 2026-10-22 已改名「店名归一」、且**加店在「店铺」页签**）——
  文案由 `uxEntryNames` 悬空名守卫抓到、跳转目标一并改正。
- 工具：`npm run db:inventory` 补入 `ledger-db` 域（此前漏登记 ⇒ 数出来的 40 个对象不含 `bk_*` 十张表）；
  `scripts/reset-dev-data.mjs` 的清库清单补入 `bk_*`（全流程从零演练要连记账一起清）。
- 门禁：`vitest run` 48 文件 / 958 例 · `vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` · `lint`（0 error）·
  `verify` · `verify:docs` · `build` · `ledger:ui`（两遍 ALL PASS）· `ledger:smoke` 全绿。
  结论笔记见 [`docs/notes/2026-10-30-ledger-core-fixes.md`](docs/notes/2026-10-30-ledger-core-fixes.md)。

### Added · 记账 P0 数据层：店铺收支 + 公共费用分摊 + 资金相关人往来结算（2026-10-25）

按 [`docs/plans/LEDGER_PLAN.md`](docs/plans/LEDGER_PLAN.md) 施工，P0（数据层）落地；P1 界面同轮随后完成（见上一条）。

- **新域 `ledger`，表前缀 `bk_`**（与 `sk_` / `oi_` / `pl_` / `sr_` / `ae_` 并列），迁移键 `ledger.main`：
  `bk_parties` / `bk_categories` / `bk_entries` / `bk_allocations` / `bk_allocation_rules` /
  `bk_settlements` / `bk_settlement_lines` / `bk_transfers` / `bk_periods` / `bk_op_log` 共 10 张。
- **口径隔离**：记账记的是「已发生、金额确定、算谁的」业务收支，「统计」页是订单预测毛利 ——
  两者**只并排不求和**，记账侧不出现"利润"字样（RK-01）。
- **分摊引擎**（`src/lib/ledger.ts`，纯函数）：平均 / 按营收占比 / 手工比例三基准；
  尾差写死最大余数法（小数降序、平局按 `shop_id` 升序），恒有 `Σ分摊 == 条目金额`；
  营收全零回落平均并标记 `fallback`；手工比例合计 ≠ 100% 直接拦、不自动补齐。
- **主进程只做守恒断言**：`electron/ledger-db.ts` 不重算分摊，只校验"合计等于金额"，不满足整笔回滚。
  （结构原因：`tsconfig.electron.json` 的 `rootDir=electron` 使主进程无法 import `src/lib/…`。）
- **相关人往来**（`src/lib/partyLedger.ts` + 台账 SQL）：应收 / 应付 / 净往来 / 已结算 / 未结清 /
  分方向未结清六个数；全局体检 `Σ净往来 == 总收入 − 总支出`（相关人必填后严格成立）。
- **结算三件套**：金额由服务端按勾选条目求和（前端不传金额）· 幂等靠部分唯一索引
  `uq_bk_settle_line_entry ... WHERE active=1` · 上限按**同方向**余额拦、金额超出即拒；
  撤销结算 = 结算单作废 + 结算行 `active=0`（条目恢复可结，痕迹保留）。
- **合并相关人**：未结算条目改挂、已结算条目留在原人（与它的结算单一起）、残额兜底写 `bk_transfers`；
  验收判据 = 合并后原人未结清为 0。
- **已结算条目的改动边界**：只允许改备注 / 科目 / 日期；改金额 / 方向 / 范围 / 店铺 / 相关人一律拒并提示先撤销结算。
- IPC 新增 18 条通道（`ledger-db-ensure` … `ledger-settle-void`），`preload.ts` / `src/types.ts` /
  `src/core/services/ipc.ts` 三处同步；`electron/main.ts` 注册 `require('./ledger-handlers')`。
- 门禁：`tests/ledger.spec.ts`（26 例）+ `tests/partyLedger.spec.ts`（22 例）+
  新增 `npm run ledger:smoke`（`scripts/ledger-db-smoke.cjs`，31 项真库断言 —— better-sqlite3 进不了 vitest）。

### Changed · 「款与商品」右栏减负与简洁模式撤除（2026-10-25 · 下午）

用户口径（七条）：SKU 行太长操作不便、「还剩 N 个没认」重复、接收端状态条太占位、未登记店提示太占位、
底部动作条没跟随主题、**去掉简洁模式**、整体不够协调。逐条：

- **「还剩 N 个没认」状态句撤除**：它与分段徽标（「待认 5」）、来源下拉（「全部（5）」）报的是同一个数
  —— 一屏三处报同一个数。剩余数的唯一承载回归**徽标**；`useSkuPool.statusKnown` 一并撤掉。
- **简洁模式整个撤除**（`src/modules/goods/simple.ts` 删除）：一个"默认藏起勾选框 / 批量条 / 统计条"
  的开关让大多数用户永远见不到那些能力。勾选框列、批量条、`PoolMetrics` 恒渲染；
  `gdColspan` 收敛为常量 7；页头「简洁模式」按钮撤掉。
- **接收端状态条压成一行小字**：「接收端在线 · 端口 N · 最近采集 … · 已采 N 个商品（已认款 N）」
  → 「● 已采 N · 认了 N · 最近 MM-DD HH:mm」，12px 次级色；端口号与"怎么采集"收进 title 悬停。
- **未登记店提示压成单行轻提示**：两块橙色告警（各两三行）→ 各一行 12px 轻提示
  （「N 家店还没登记，卖出去的先挂不上款：A、B [去「店名归一」]」），店名超长走省略号；
  长解释收进 title。按钮文案「现在登记」→「去「店名归一」」（目的地写在按钮上）。
- **动作条修主题跟随**：`.gd-actbar` 原写 `var(--wb-bg-panel, #fff)` —— `--wb-bg-panel`
  **不存在**于主题令牌，深色下永远白底。改走 `--wb-surface` / `--wb-text-muted` / `--wb-shadow`；
  同罪的两处 `--wb-text-2` 一并修。冒烟加**活体哨兵守卫**（临时改 `--wb-surface` 值，
  底色不跟着变 = 写死）。
- **待认表操作列收窄右贴**：合并后每行只有一个动作（对比 / 删除），150px 共用宽度收成 96px 右对齐；
  不可认行灰因「需先登记店铺 / 店铺未登记」压成「未登记」（96px 里长词折三行），完整原因在 title。
- 门禁：`vue-tsc` ✅ · `build` ✅ · `goods:ui` 三视口 ALL PASS ✅ · `vitest run` 958/958 ✅ ·
  `verify` ✅ · `verify:docs` ✅。变异 2 组（动作条写死白底 ⇒ 恒红主题守卫；提示条恢复旧版式 ⇒ 恒红单行守卫）各只红目标。

### Changed · 「款与商品」右栏三段并两段，认款只剩一条动线（2026-10-25）

用户口径（连环两条）：「当前建档与关联页面太杂乱了，操作也不方便，请重新设计」「这几个字也不合适」。
改名与层级收敛（P0/P1）见
[`docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md`](docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md) §0；本轮做完 P2 的 S1–S3：

- **右栏三段 → 两段**：原来按**来源**分「待关联队列（订单）」/「待关联采集商品（采集）」/「已建立映射」，
  用户得先判断"这条从哪来"才能开工。改为按**状态**分「待认（N）」/「已认」，来源降为行内标签 + 一个筛选下拉
  （`data-act="pending-origin"`）。合并后一张表 4 列（勾选 / 图 / 商品ID·店铺 / 操作），
  两个来源本来各 4 列与 6 列、工具栏各 5 颗按钮 ⇒ 现在一套。
- **认款入口 4 → 1**：左栏展开区「认到本款（N 项）」（`relate-from-expanded`，2026-10-08 为"视线焦点"加的
  第二处入口）、右栏工具栏「关联到 S2」、行内「关联…」、批量关联 —— 收敛成**吸底动作条**上的一个按钮：
  勾商品（可多选）→ 点左栏一款 → 「认到 X（N 项）」。没选款时同一按钮改口「先选一个款」并打开选款弹层；
  恰好勾一个采集行时多给「新建款并关联」（那是"还没有这个款"的出口，不是第二个认款入口）。
  行内只留「对比」（订单）/「删除」（采集）。
- **视图合并、写路径不合并**：两源各自构造写入行（`queueWriteRows` / `itemWriteRows`），拼成一个数组交给
  **同一个** `commitMap`（一次 IPC、一个事务、行级失败回传）。新增 `pendingRows` 视图模型统一两源形状；
  全选只作用于**当前筛选下可认的行**，计数走「清单 ∩ 选择集」而不是 `pendingSelected.size`。
- 顺带修掉三个**产品侧真错**（合并视图才暴露的）：① 建款向导写完没有把该行的 key 从选择集里摘掉 ⇒
  行已离开清单、动作条仍报「已选 1 项」；② 行内动作整块包在 `v-if="canRelate"` 里 ⇒
  **店铺未登记的采集行连「删除」一起消失**（认不上的行恰恰最该清）；③ 分段徽标写的是
  `pendingRows.length`（"加载了几行"）⇒ 队列分页时少报、停在「已认」段收到采集广播时不动 ⇒
  改为 `queuePendingTotal + itemStats.unmapped`（筛选下拉三个数同源）。
- 冒烟 `goods:ui`：`queue-*` / `items-*` 锚点整组换成 `pending-*`，5 条判据按合并后的语义改写
  （零采集判"采集侧没有行"、"广播只刷徽标"改在「已认」段验、徽标判数字而不是"在不在"…）；
  新增反向守卫「全页只有一个认款提交按钮」（选择器计数）+ 来源标签存在性。三视口（1440 / 1200 / 900）ALL PASS；
  变异复核 2 组（复制提交按钮 → `count=2` 红；删来源标签 → 两条来源断言红）各只红目标断言。
  单测 910 项全绿；`npm run verify` 通过。教训见
  [`docs/notes/2026-10-30-goods-list-and-pool.md`](docs/notes/2026-10-30-goods-list-and-pool.md)。

### Changed · 左栏一行只做一件事：撤掉行展开区，档案进抽屉、反查进右栏（2026-10-25）

P2 的 S4 + S5，同一方案
[`docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md`](docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md)：

- **单击 = 选中，不再有展开区**。原来展开区里塞着五样东西（认款按钮 / 供应商·类目 / 编辑·删除 /
  已关联反查），用户原话是"点了不知道看哪儿"。现在各归各处：选中 → 右栏动作条的落点；
  档案 → 行尾「编辑」打开的抽屉（含供应商 / 类目 / 进价 / SKU / **款级删除**）；
  「这款认了哪些商品」→ 右栏「已认」段新增的「只看当前款」（按 `productId` 反查，同一个
  `skuList`，不另做第二份读数）。重复点同一行**不取消** —— 落点是整批认款的目标，手滑一下不该作废。
- **统计条（关联率 / 映射记录 / 已关联）搬到「已认」段**，「待认」段改一句状态句
  （「还剩 N 个没认」），口径取主进程权威统计而不是已加载的行数。
- **修掉一个真回归**：「操作」列（文字链「编辑」）比被它取代的 ▸ 列宽 26px，全部从款名那列扣 ⇒
  22 字的长款名被挤到第三行（用户最初报的"款式名展示不完全"就是这个）。压掉两处右内边距后
  款名列 163 → 171px，两行放得下。
- 冒烟 `goods:ui`：五条挂在展开区上的契约改判（选中态 / 跨栏按钮文案 / 抽屉档案值 /
  已认段按款反查的新值 / 当前款被筛出列表后落点撤回），「抽屉底部只剩一个完成」改成
  「没有取消」（S4 加了「删除这款」，那不是取消）。三视口 ALL PASS、单测 958 全绿；
  变异 2 组（`productId` 写死 0 ⇒ 红 7 条；`watch(rows)` 不撤回落点 ⇒ 红 1 条）各只红目标断言。
  教训见 [`docs/notes/2026-10-30-goods-list-and-pool.md`](docs/notes/2026-10-30-goods-list-and-pool.md)。

### Fixed · 邮件收件箱与店铺「接入邮箱」设置恢复（2026-10-25）

用户口径：「当前项目中邮件功能不可用了，原来店铺中的邮箱设置也没有了，请修复」。两侧各有一条根因：

- **数据**：`sk_mail_accounts` / `sk_mail_messages` / `sk_mail_bodies` / `sk_mail_folders` 全空，
  而 `sk_mail_fts` 还留着 890 条孤儿（游标 1446）。取证结论：10-22 物理合并把三个纯账号行
  （`rich0910xx@163.com`）插成了新的 `sk_shops` 行、邮件账号挂在它们上面；这三行被删时
  `ON DELETE CASCADE` 把账号与 851 封邮件一并带走，之后同样的邮箱又填回店铺行 7/8/9，
  但凭据没跟着回来（`secret_keys = []`）。已从合并前备份 `sellerkit.db.bak-shop-merge-v1-*`
  **按邮箱**把 3 个账号 / 851 封邮件 / 3 条文件夹游标 / 授权码（`mailAuthPwd`）恢复到当前店铺行 9/8/7，
  并清空 FTS 与 `fts_indexed_upto` 让进邮件页时重建（实测重建后 851 条）。写入前的真库快照：
  `sellerkit.db.bak-before-mail-restore-20261025`。备份止于 10-21，之后的新邮件靠 IMAP 同步补回。
- **界面**：冷启动直接落在「基础数据」时，邮件 store 从没被初始化（只有「邮件」页会 `ensureReady`），
  于是每行都显示「未接入邮箱」、接入抽屉是空表单 —— 用户体感就是"设置没了"。
  新增 `mailStore.ensureAccountState()`（prefs + providers + accounts，单飞、失败可重试、
  不含轮询与同步订阅）：`MasterDataView` 挂载时调用，`MailAccessDrawer` 打开前 await。
- **冒烟**：`master-data:ui` 在 boot 步加固（冷启动读到接入态 / 抽屉回填「已接入 + 邮箱 + 留空表示保持不变」/
  抽屉可关），宽窄两遍；变异取证：把两处接线还原后三条按预期变红。夹具里邮件账号状态写了
  不合词表的 `active`，改为 `idle`。
- 已知残余：FTS 由应用代码维护，店铺级联删邮件时不会同步清理索引（本轮手工清掉 890 条孤儿），
  本轮不改级联路径。

### Changed · 记账方案：相关人定为必填（2026-10-25 22:17）

用户口径：「相关人必填」。

- 取消 v1.1 的「`party_id=0` = 未指定、台账单列一行」兜底：`bk_entries.party_id` 改为
  `INTEGER NOT NULL CHECK (party_id > 0)`，前端保存时拦并聚焦下拉 —— **两道防线**，绕过界面直接调数据层同样被拒。
- 连带简化：往来台账不再有「未指定」行与明细页「N 条未指定相关人」提示条；
  全局恒等式 `Σ各相关人净往来 == 总收入 − 总支出` 变为**严格成立**（原先要减一个"未指定"桶）。
- 必须同时处理的陷阱（否则历史条目会变成"不能碰"）：**编辑旧条目时若相关人未被改动、且原相关人已停用，允许保存**；
  只有"换人"才要求新相关人未停用。
- 录入摩擦的对策：相关人下拉按"记住上次选择（收/支各一个）+ 最近使用排序 + 下拉内直接新建"，
  并新增风险项 RK-11（必填诱发"随手选一个"污染台账，3×3=9 中）。
- FR 18 → **19 条**（新增 FR-19 必填校验，含绕过前端的数据层断言）；待拍板 5 → 4 项。

### Changed · 记账方案升到 v1.1：增补「资金相关人 + 往来结算」（2026-10-25 22:10）

用户口径：「收支需要增加资金相关人，可以根据相关人统计支出和收入总金额，便于结算金额，结算后可以统一变更相关人」。

- 记账从**单轴（店铺）**扩为**双轴（店铺 × 资金相关人）**：`店铺` 答"这笔算什么成本"，`相关人` 答"跟谁结"，
  两者正交 —— 一笔房租可摊 5 家店、只跟 1 个房东结算。新增 `bk_parties` / `bk_settlements` /
  `bk_settlement_lines` / `bk_transfers` / `bk_op_log`，`bk_entries` 加 `party_id`（0 = 未指定，台账单列一行）。
- **修订 v1.0 的口径表述**（原写"收付实现"已站不住）：记账记的是"已发生、金额确定、算谁的"业务收支，
  不是银行流水；**结算只改往来状态，不生成收支、不改店铺收支与结余** —— 否则支出翻倍（RK-03，15 高）。
- 往来口径定五个数：应收 / 应付 / 净往来 / 已结算 / **未结清**，并给出全局恒等式
  `Σ净往来(含未指定) == 总收入 − 总支出`，汇总页做体检、不过即红字。
- 结算走资金三件套：`UNIQUE(entry_id)` 兜底幂等（一条条目只能被一张有效结算单占用）· 台账恒等式对账 ·
  超额拦截（不做预付/多付）；整条结算不做部分结算；撤销 = 作废留原因，不删行。
- **「结算后统一变更相关人」拆三路**，界面按选中条目的结算状态自动路由：
  A 改挂（全部未结算，直改）· **B 结转（含已结算，默认推荐：未结算条目改挂 + 生成往来转移，历史零改动）** ·
  C 撤销结算后改挂（逐单确认将作废的结算单）。混成一个按钮会让已付过的结算单与明细对不上（RK-04，15 高）。
- 界面三页签 → **四页签**（明细 / **往来** / 单店 / 汇总）；明细加批量操作条；记一笔加相关人一行（不折叠）。
  FR 11 → **18 条**，分期 P0–P3 → **P0–P4**（往来与结算独立成 P3）。

### Added · 记账（店铺收支 + 公共费用分摊）设计方案（2026-10-25）

用户口径：「增加记账功能，记录各店铺的日常支出和收入；有些是各店铺的公共开支，统计到单店时需要均摊；
最终一目了然每家店铺的收支，以及所有店铺的汇总收支」。

- 新增 [`docs/plans/LEDGER_PLAN.md`](docs/plans/LEDGER_PLAN.md)（仅方案，未动代码）。四个口径已由用户拍板：
  分摊基准 = 平均 / 按营收占比 / 手工比例（默认平均）· 收入以手工记账为主、「统计」页只做只读对照 ·
  月结锁定本期不做但留 `bk_periods` 字段 · 只记人民币。
- 方案的立足点不是表单，而是**口径隔离**：记账是「实际收付」，`order-cost` 是「订单预测毛利」，
  两者数字必然不同、**禁止进入同一个求和**；记账侧统一用「收入/支出/结余」，禁用「利润」字样。
- 数据模型 `bk_categories` / `bk_entries` / `bk_allocations` / `bk_allocation_rules`（+ 留位 `bk_periods`），
  迁移键 `ledger.main`；金额恒为正整数分、方向由 `kind` 决定；店铺一律按 `shop_id` 关联。
- 分摊是**派生数据**：唯一实现放 `src/lib/ledger.ts`（尾差走最大余数法，平局按 `shop_id` 升序），
  主进程只做守恒断言（`Σ分摊 == 条目金额`）不做计算；改/作废后按「目标值 == 现值则不写」重算。
- 分期 P0 数据层 → P1 明细页 → P2 分摊接入 → P3 单店/汇总/导出，含 IPC 三处同步与门禁清单。
- `docs/README.md` 索引登记 + 计数按实测改为 172（原 152 已落后 19 篇）。

### Changed · 店铺列表状态并到店名下方 + 退店行显示保证金到账时间（2026-10-25）

用户口径：「店铺账号列表中的状态，放在店铺下方，如果为退店状态，显示保证金到账时间」。

- **列表**（`AccountsPanel.vue`）：整列「状态」删掉（表头 10 列 → 9 列），状态徽标与记分改挂在
  **店铺格**里、紧跟在店名下方；卡片视图同一读法（名称 → 状态 → 保证金）。顶部状态统计条
  （点数字筛选）不变 —— 它是筛选器，不是行内状态。
- **保证金到账时间**：新增 `deposit_received_at`（TEXT，`YYYY-MM-DD`，空串 = 未填写）。
  仅 `退店` 行在列表里显示「保证金到账 2026-02-10」；未填时显示「保证金到账时间未填」，
  不冒充「未到账」。非退店行即使是历史遗留值也不显示。
- **老库迁移**：`shop.columns` **v1 → v2**（`ALTER TABLE ... ADD COLUMN`，幂等探测），
  新库由 `shopTableSql` 直接建出该列；合并迁移（`shop.main` v1）出来的老店铺行默认 `''`。
- **编辑器**：状态选「退店」才出现「保证金到账时间」日期输入（其余状态收起但不清值）；
  非法日期（如 `2026-02-30`）在数据层归一为空串，不写脏值。
- **门禁**：`shop:smoke` 新增保证金往返用例并覆盖 v2 补列；`master-data:ui` 新增
  表头无「状态」列 / 徽标在店铺格 / 退店有日期而非退店没有 / 编辑器只在退店时出现输入 五条断言。

### Changed · 「建档与关联」改名「款与商品」，工具栏分出主次（2026-10-25 21:25）

用户口径：「当前建档与关联页面太杂乱了，操作也不方便，"建档与关联"这几个字也不合适」。
本轮只做**改名 + 层级**（P0 / P1），结构层重设计（右栏三段合并、认款单动线）另立方案
[`docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md`](docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md)。

**改名**：`建档与关联` → **`款与商品`**（`src/modules/goods/tabs.ts` 的 `GOODS_TAB_LABEL.workbench`
是唯一来源，14 个文件 41 处引用一并跟上）。判据不是"顺不顺口"：侧栏读作「产品管理 › <名>」，
组名是名词而旧名是**两个动词并列**（建档 + 关联），读起来像一条待办；它也没覆盖这一屏真正的内容
（左边是款档案，右边是店铺商品）。不选「认款台」（弱化左栏的档案维护）、不选「产品库」
（与组名「产品管理」重复"产品"）。`store.mainTab` 的值仍是 `'goods'`，跨模块 action 与用户偏好不受影响。

**层级收敛**（`data-act` 一个没动 —— 冒烟与脚本按它挂）：

| 位置 | 改法 |
| ---- | ---- |
| 左栏工具栏 | 「新增产品」→「新增款」（页名叫款、按钮叫产品是同一屏两个词说一件事）。导出 / 导入**保持普通按钮** —— 本工具栏原本只有一颗 `--primary`（新增款），层级已成立；降 ghost 会让"导入 Excel"这个新用户第一步的入口看起来像纯文本 |
| 右栏采集段 | 6 颗同款按钮 → 3 普通（关联到… / 新建款并关联 / 计数）+ 3 ghost（清空选择 / 手贴商品ID / 打开店铺）；主操作「关联到 <款>」仍是唯一的 primary |
| 右栏队列段 | 「清空选择」降 ghost |
| 页头说明 | 改为只描述两侧各是什么，去掉"建档 / 映射"这类动作词与 SKU 一词；连带撤掉 `glossary` 的未使用导入 |

⚠️ P1 **没有减少任何常驻控件**：冒烟脚本直接 `setVal` / `click` 那些控件（`goods-ui-smoke.mjs:1545`
`:1601` `:3990` `:4030`），把它们收进折叠面板会让断言变成"操作一个用户看不见的控件"。
真正的减法在 P2，必须同步改断言。

门禁：`vue-tsc --noEmit` ✅ · `npm run verify` ✅ · `vitest run tests/uxEntryNames.spec.ts
tests/shopAccountsIntake.spec.ts` ✅（18 tests）。**`goods:ui` 未跑**（需构建 + Electron）。

### Fixed · 展开「SKU 编码」被上面的「组合」压住（2026-10-25 深夜）

用户报：「打开 SKU 编码编辑时被上面的组合遮挡了」。三种窗口高度下量矩形都**不相交**、
第一行编码框的命中测试也是它自己 ⇒ 不是常规尺寸的布局重叠（详见
[笔记](docs/notes/2026-10-30-goods-sku-matrix.md)）。

真因：`.mx--fill { min-height: 0 }` 允许矩阵压到**远小于自己内容**的高度，而规格区
（按内容撑高）与带 `min-height: 140px` 的表格容器照样按自己的高度画 ⇒ 内容**溢出到 `.mx`
盒子之外**，盖住按"压缩后高度"排版的编码区。只在右栏高度不足以放下矩阵时出现
（矮窗口 / 多色多码），默认视口的冒烟因此恒绿。

- `min-height: 0` → **`min-content`**：矩阵最低缩到"规格区 + 140px 表格"，再不够就让右栏整体滚动。
- `.ed-codes { flex: none }`：展开的编码区不再被压成一条缝。
- **展开即入视野**：`onCodesToggle` → `revealInMain()`，顶部让开吸顶工具条，
  只有整块塞得进可视区时才追底边（比可视区高时对齐顶边）。
- `scroll-padding-top: 46px`（右栏）+ `scroll-margin-block: 46px`（编码框）：
  聚焦时的隐式滚动也不会停在工具条底下。

`goods:ui` 的 `sku-code-rule` 步新增两条守卫（命中测试 / 把右栏压到 300px 再展开时
`scrollTop > 0`）。

### Fixed · 「克重都填好了，保存还说这 3 个组合会被删掉」+ 保存合并到「完成」（2026-10-25 晚）

用户报：所有克重都填了，点保存仍提示「矩阵里没有勾选的 3 个组合会被删掉：黑色 L、白色 L、红色 L」，
并明确要求「保存按钮和完成按钮合并，放在完成上」。

三格同时缺 **L 码** = 缺的是一整列，不是某一格（详见
[笔记](docs/notes/2026-10-30-goods-sku-weight.md)）：

- **列头点一下 = 整列取消**，而"填这一码克重"的输入框就在列头**正下方 22px** ——
  想填克重手一偏，三格 SKU 就从矩阵里消失，当时**没有任何回执**。
- 之后在列头填 `500`：`fillMatrixSizeWeight` 对空格是「批量填不造 SKU」，
  一格都没写进去，回执却是「这一列已经都是 500 g」⇒ 人读到的是"填好了"。
- 根因是语义分裂：**格内敲数字 = 创建组合**，**列头敲数字 ≠ 创建**。

改法围绕一条不变量 —— **克重即存在**：

- 列头敲数 = 这一码整列，缺的格一起补齐（`createMissing`）；回执说事实：
  「M 这一列改成 800 g · 补齐 1 个原本没有的组合」。没有颜色行 / 这一列 0 个组合各自说实话。
- 整行 / 整列开关给**「撤销」**（12s 内可收回），回执直说「保存时会列为删除」。
- 删除确认加第三个出口**「保留这 3 个」**：把 SKU 连同 `variantId`、原克重加回矩阵（不落库，可再核对）。
- **保存合并到底部「完成」**：工具条不再有保存按钮，只留状态徽标（`有 5 处待保存` / `SKU 已保存`，
  点一下 = 立即存但不关）。`complete()` 先存矩阵再关；有删除则弹确认，确认后落库并关、取消留在抽屉。

### Added · 颜色全部展开、常用色带上已设置的色、SKU 编码规则 + 一键生成（2026-10-25 晚）

- **颜色区不再出现滚动条**：删掉 `max-height: 96px / 64px` 两档与 `overflow-y: auto`
  （被裁掉半个色看着像"这个色不存在"）。实测 8 色 `scrollHeight/clientHeight = 68/68`、`overflow-y: visible`。
- **常用色 = 字典色 + 这个款已经在用的色名**：`酒红 / 灰白 / 藏青` 这类自己起的色名第二次不用手打
  —— 打字就会漂（`灰白` / `灰白色` 各成一行，同色不同行）。
- **SKU 编码规则 + 一键生成**（`src/lib/skuCode.ts`）：占位符 `{code} {color} {size} {index}`，
  默认 `{code}-{color}-{size}`，规则存 localStorage、旁边给真实预览。
  「一键生成」**只填空**（已有编码是人对外的标识，覆盖比留空更糟）、「全部重写」是另一个显式动作；
  批内重名自动 `-2`、超 64 字跳过并计数、规则里一个已知占位符都没有则拒绝生成（否则 40 条同一个编码）。
  改动只进草稿，随「完成」一起落库。真库 411 个 SKU 目前零编码 —— 这是让编码能用起来的唯一现实路径。

### Changed · 拖色的抓手与落点：整条 chip 都能按、落点改「离谁最近」，另给一条不用拖的路（2026-10-25）

用户报「现在的拖动区域太小，操作太不方便了」。先量了才知道"小"在哪
（详见 [笔记](docs/notes/2026-10-30-goods-sku-matrix.md)）：

- 颜色 chip 是 **125×30**，但**能按住的只有 26×26 的色图** —— `onChipDown` 当时写着
  `closest('input,textarea,select') ⇒ return`（本意是"色名要能拖选文字"），
  于是中间 96px 的色名整段按不动。表现就是"拖十次动不了一次"。
- 落点（常用色胶囊）只有 **42×22**，与颜色行只隔 **6px**，判定还是 `elementFromPoint` **点中矩形** ——
  指针偏 20px 就等于没拖。

改了三处：

- **抓手扩到整条 chip**：按住色名也能起拖，但只在**竖向**（`|dy| ≥ 10 且 > |dx| + 4`）——
  横向仍是原生拖选文字（进入拖动时 `removeAllRanges()` 清掉已拖出的选区）。
- **落点改「离谁最近」**：不再问 `elementFromPoint`（它只回答"指针底下是谁"，落在缝里就是"没人"），
  改为对 `[data-mx-pc]` / `[data-mx-row]` 算**矩形外扩后的距离**（横向 16 / 纵向 12px）取最近：
  有效落点 42×22 → **74×46**。胶囊与颜色行靠"谁更近"天然互斥 ——
  定优先级会把这 6px 判给上方，而人正是从下往上拖。色图 26 → 28、胶囊 22 → 24。
- **不用拖的那条路**：点进色名框给出候选（`Teleport` 到 `body` + `fixed`，否则会被
  `.mx-colors` 的 `overflow-y: auto` 裁掉一半）。分「归到常用色」/「并入其它颜色」两组，
  每项只写四个字（`归类` / `并入已有` / `合并两行` —— 写全会把色名挤成省略号，且重复 9 遍）；
  `↑↓` 选、`Enter` 采用（**必须 `preventDefault`**：组件在表单里，不拦会连带提交）、`Esc` 收；
  `focus` **和** `click` 都能打开（关掉后焦点还在框上，再点不会再触发 `focus`）；
  `blur` + `document` 级 `pointerdown` 都收起（点到矩阵格子时焦点**不转移**，光靠 `blur` 会让菜单一直飘着）。
  两条路都走同一个 `classifyInto` / `mergeColorInto` —— **落库语义只有一份**。
- 守卫：`goods:ui` 新步 `sku-drag-grab` **13 条**（380 项 × 三视口 ALL PASS）；
  变异 3 组各只红目标断言（落点不放宽 ⇒ 不命中且归类没发生；恢复 `closest('input')` ⇒ 竖拖不起拖；
  去掉外部点击收起 ⇒ 菜单不收）。

### Changed · 编辑 SKU 改成「按款 / 按码填一次」，一格只留一个控件（2026-10-25）

用户第三次提「编辑 SKU 信息还是不太方便」。前两轮（[两栏版式](docs/notes/2026-10-30-goods-product-editor.md)、
[规格区收 chips](docs/notes/2026-10-30-goods-sku-matrix.md)）解决的是**一屏能看见几行**，
这一轮先查了真库才动手 —— 因为"填一次能管几格"是业务事实，不是版面问题：

- **克重是「款 × 码」的属性，不是"格"的**。`pl_variants` 411 行里 303 行填了克重，按「产品 + 尺码」
  分组后，有 2 色以上的 **86 组全部"同码各色克重完全一致"（0 组不一致，覆盖 298/303 = 98%）**；
  典型款整款一个值（连帽风衣 6 码全 500g、卫衣套装全 800g），少数是码阶梯
  （L500 → XL600 → XXL700 → 3XL800 → 4XL850 → 5XL900）。逐格填 40 次里最多 6 次带新信息。
- **按码填**：`fillMatrixSizeWeight`（`src/lib/skuMatrix.ts`）+ 矩阵第二行的「码克重」——
  每个尺码一个输入框，填了铺满该列（阶梯款 3 次代替 18 次）。语义逐条对齐 `fillMatrixWeight`：
  只碰存在的格、默认只填空、0/负数/不存在的码返回**原引用**、覆盖时用回执说清改了几格。
- **整款值提为主入口**：`克重 [整款] g │ 铺到空着的 39 格 │ 全部覆盖 │ 当前 500 g`。
  按钮把"影响几格"写在脸上（原「填空格（39）」要读括号才懂）；右侧**常显现状**
  （`当前 500 g` / `当前 混填`，来自 `matrixWeightCommon` 的派生值，不落库）——
  填之前先看见现状，才不会重复劳动、也不会一按覆盖抹平核对过的值。
- **一格一个控件**：原来的「✓ 开关 + 克重框」合成一个输入框（空 = 不存在·虚线 ＋ /
  实线 = 待填 / 数字 = 有值）。8 色 5 码从 **80 个控件降到 40 个**；空格里**直接敲数字
  就"加入 + 填值"一步完成**（原来要先点 ✓ 再点输入框敲数）。⚠️ 空格里敲 0 / 非数字
  **不造 SKU**（语义同 `toggleMatrixCell`，空壳会落成 0 克的真 SKU 并进成本/运费）。
- **Delete 两段式**：值非空时交给浏览器删字符，框空了再按 Delete 才**移除组合** ——
  一次误按不会抹掉一整条 SKU。键盘：Enter = 同列下一格（既有）、新增 ↑↓ 换行。
- **知情删掉「按住拖过几格连续勾选」**：它是对"用按钮逐格切换太慢"的补偿；加入=敲数、
  取消=Delete 之后这层补偿没有意义，整批仍有行头/列头开关、整款值、列头值。
- **不做**：「这一格是批量填的」标记（批量填是真写进每格，标来源要存第二份真相）、
  矩阵自动保存（一次可能改几十格，仍显式保存；这轮减的是**需要保存的动作**）。

守卫：`goods:ui` 新步 `sku-column-weight` 12 条（列头只动这一列 / 填值不造 SKU / 空格敲数一步加入 /
Delete 两段式 / 现状读数两态），三视口 × 367 项 ALL PASS；单测 879 → **901**（新增 9 例）。
变异两条各只红目标断言：`fillMatrixSizeWeight` 忽略 size（填全表）⇒「只动这一码」红；
`onWeightInput` 去掉建格分支 ⇒「空格敲 250 一步加入」红。

### Fixed · SKU 矩阵「根本没办法操作」的五个真原因（2026-10-24 晚）

用户原话：「现在这个页面根本没办法操作」。没有报错、没有白屏、冒烟全绿 —— 命中测试先排除了
"被盖住"（136 个可见控件的中心点全部命中自己），真因都在**事件进不了代码**：

- **有色图的色拖不动**：`onChipDown` 里写的是 `closest('input,button')`，而色图恰好裹在
  `<button class="mx-thumb-btn">` 里（为了能点开看大图）⇒ 凡是有色图的颜色整条都拖不动，
  只剩没采到图的空色块能拖。产品抽屉的款色没有色图（冒烟、截图、真鼠标探针拖的都是空色块，
  所以一直全绿），而**向导与采集弹层每行都有图**，在那里一条都拖不动。
  现在只排除 `input/textarea/select`（色名要能选中文字）与 `[data-act$="-del"]`（✕ 是独立动作）。
- **拖完顺手弹出全屏大图**：松手后浏览器补发一次 `click`，落点若在色图上就是 `openViewer`，
  那层 `.wb-mask` 是 `position: fixed` 盖整个窗口 —— 观感就是"页面被锁住了"。
  改为 `@click.capture` 吞掉拖动后的第一次 click。
- **滚轮滚过就改克重**：克重框原来是 `type="number"`，40 个格占了大半张表；用户想往下滚两行，
  指针停在哪个格上那个格就被改了。改为 `type="text"` + `inputmode="numeric"`（归一仍走 `normWeightG`）。
- **向导的「建档并关联」跟着内容滚**：`.wb-dialog__foot` 被放在 `.wb-dialog__body` 里面，
  档案 + 矩阵把内容顶到两屏高，动作条首屏完全不可见。移到 body 外面，成为抽屉的第三段。
- **幽灵拖动**：拖到窗口外松手时 `pointerup` 可能不派发，`chipDrag` 残留 ⇒ 之后鼠标一进组件、
  移动超过 6px 就自己进"拖动中"（整片色块变灰虚线），随便一点就真做了一次合并。
  加 `window.blur` 与 `document.visibilitychange` 主动丢弃。

新守卫（`goods:ui`，三视口各跑一遍）：克重框不是 number 框 · SKU 区每个可见控件的中心点都命中它自己 ·
从色图上按住能拖（`is-src=true`，只有向导守得住 —— 那里才真挂着色图）。

### Added · 常用色一排 + 拖色合并（两色并一色）（2026-10-24）

需求原话：「是否可以把常用颜色放在上面，通过拖动颜色方式来合并？当前将并入的颜色名称修改后或删除后，
下面已存在的 SKU 信息就没了。」

- **先澄清一件事（探针实测）**：改色名**不会**丢格。并入 → 改色名 → 删一色，全程 `✓` 数与克重输入框数
  原样保持（`checked 4→4→4→2`，最后一步少的正是被删那一行的 2 格）。真正缺的是"把两行并成一行"的路：
  用户只能把一行改名成另一行的名字，而保存校验会拦下（`颜色「黑」出现了两行`），
  被拦下后关掉抽屉（放弃改动）⇒ 此前并入的一切都不落库，读起来就是"改了名就没了"。
- **拖色合并**：把色 chip 拖到另一个 chip 上松手 = 前者的格搬进后者、前者消失（`mergeMatrixColor`）。
  阈值 6px（小于它算点击，点输入框 / ✕ / 缩略图照旧）；拖动中源 chip 变虚、目标 chip 高亮；
  松手后「组合」那一行给出回执（`已把「军绿」并入「藏青」：搬 0 格 · 5 个同码格以「藏青」为准（保存后少 5 个 SKU）`）。
  - **落库语义**：搬的是同一个格对象，`variantId` 跟着走 ⇒ 保存时是"原地改色名"而不是"删旧建新"
    （编码与状态都在）；同码冲突保留**目标行**那一格、克重取有值的一方；行序不变；
    源行独有的码若不在列里会补进 `sizes`（否则展开时静默丢一格）。
- **常用色**：10 个服装高频色排在「颜色」上面，点一下加一色；已经在矩阵里的**打勾变灰**，
  再点**不加第二行**（只把焦点递到那一行）。色名全部来自 `COMMON_COLORS`，每项都必须在
  `SWATCH_WORDS` 里认得出（单测钉住）。
- **文案**：撞名错误从"先合成一行再保存"改成指路（"把一行拖到另一行上合并成一色，或先把其中一个改名"）；
  色名的 ✕ 现在按 `title` 说明代价（已落库的会连同 N 个 SKU 一起删）。
- **守卫**：`goods:ui` 新增 `sku-color-merge` 步（361 → **371** 项 × 三遍 ALL PASS）——
  常用色打勾 / 色块真色 / 再点不加行 / 拖动两态 / 合并成一行 + 回执「搬 1 格」/ 克重 320·250 保留 /
  进脏计数 / 纯点击不合并 / 收尾放弃后 SKU 写入为 0；`tests/skuMatrix.spec.ts` 47 → **54** 例、
  `tests/colorSwatch.spec.ts` 7 → **8** 例。**变异 5 组各只红目标断言**：搬格丢 `variantId` /
  不带克重 / 不补列 / 合并结果没写回（连锁红 4 条）/ `hasColor` 恒 false。
  截图新增拖到一半与松手后两张（`sku-matrix-merging-*` / `sku-matrix-merged-*`）。
- **门禁**：`tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `eslint` · `verify` · `verify:docs` ·
  `build` · `vitest` · `goods:ui` · `goods:shot`。结论见 `docs/notes/2026-10-30-color-alias-and-merge.md`。

### Changed · 拖色落点改成「常用色」：拖动即归类，落库以常用色为准（2026-10-24 晚）

需求原话：「现在的拖动操作还是不太方便，常用色用是否可以把当前产品的颜色如果存在的话就打钩，
不存在的话就按原始状态，最终存储的以常用色为主，拖动颜色里的项，拖动到常用色中进行归类，
最终存储颜色的图片保留一张。」

- **「常用色」不再只是快捷添加，它同时是拖放落点**：把下面的色名拖到某个常用色上松手 =
  把这个色归到该规范名下。顶部 10 个靶子固定、自带色块与名字，比原来"瞄准下面一排 22px 的输入框"
  好用得多（拖到另一个 chip 上的合并**保留**，用于两个色都不在字典里的情况）。
- **两种语义，落库色名一律取字典写法**（`classifyMatrixColor`）：
  目标色**已在矩阵里** ⇒ 并进那一行（格连同 `variantId` 一起搬、行序不变）；
  目标色**还不在矩阵里** ⇒ **原地改名**（`cells` / `variantId` / `imageUrl` 一个都不动）。
- **勾 = 矩阵里真有这个色名**（`trim` 全等）；没有就保持原始状态，不拿近似色冒充。
  这个判据与"拖上去会发生什么"是**同一个** `hasColor` —— 两套判据会造出"打了勾却改了名"的自相矛盾。
- **一个色只留一张色图**：图在 `SkuMatrixRow.imageUrl` 上（一个字段），合并时优先保目标行的、
  目标行没图才用源行的。图不按格存是刻意的：按格存会让同一个色下十条 SKU 挂着三张矛盾的图。
- ⭐ **两处真 bug（不是"体验问题"）**
  1. `pointermove` / `pointerup` 原来挂在 `.mx-colors` 上 ⇒ 鼠标一离开那一条就收不到事件，
     **根本拖不到上面的常用色**。改挂根元素 `.mx`，另加 `window` 级 `pointerup` 兜底
     （松手落在组件外也要收尾，否则界面卡在"拖动中"）。
  2. 往"刚点常用色新建的空白行"上合并会**删旧建新**：同码冲突原本无条件保留目标格，
     而新行没有 `variantId` ⇒ 已落库那条被丢。现在目标格没 id 时**接过源格的 id**；
     真会消失的 SKU 数用 `dropped` 单独数（`conflicts` 只是"同码格数"，拿它写回执会谎报损失）。
- **守卫**：`goods:ui` 新步 `sku-palette-classify`（**382 项 × 三遍 ALL PASS**）——打勾按真实色名、
  拖到未打勾的 = 原地改名（行数/克重不动、`color=藏青`）、拖到已打勾的 = 并进（`names=黑`、
  `只留一张色图`）、每 chip 恰 1 张图、拖到自己 = 不变、改名合并回原位 = **净变化为零不产生幽灵待保存**。
  单测 `tests/skuMatrix.spec.ts` 62 例（`classifyMatrixColor` 6 例 + 合并 `dropped` 2 例）。
  变异 6 组各只红目标断言：落点不动作（5 条红）/ `hasColor` 恒 true（3 条红）/ 落点不高亮（1 条）/
  改名清空色图 / 合并优先源图 / 不接源格 id。
- ⚠️ 断言量错层一次：`.mx-color__img` 挂在**颜色 chip** 上、不在矩阵行（`ed-row`）上，
  第一版得到 `imgs/row=0` 的假红。收尾也不能假设一定弹「放弃改动」（净变化为零时抽屉直接关）。
  截图新增 `sku-palette-classify-*` / `sku-palette-classified-*` / `sku-palette-realdrag-*` 三张。
- **`<img>` 默认可拖**：色图现在兼作拖动手柄，不关原生拖放会在按下时先起 `dragstart`（指针事件
  随之断掉 = "拖不动"）。已加 `draggable="false"` + `-webkit-user-drag: none` + `user-select: none`。
  合成 PointerEvent 抓不到这条（冒烟是 `--dump-dom`）⇒ `goods:shot` 增加 **CDP 真鼠标拖拽探针**
  （`Input.dispatchMouseEvent` 三段式），实测 `米白 → 白` 归类成功；把 `onChipDown` 改成直接
  `return` 时探针读到 `dragging=false`、色名不变 —— 证明它有判别力。
- **门禁**：`tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `eslint` · `verify` · `verify:docs` ·
  `build` · `vitest`（45 文件 / 895 例）· `goods:ui` · `goods:shot`。
  结论与取证见 `docs/notes/2026-10-30-order-classify-panel.md`。

### Changed · SKU 矩阵：规格区收成三行 chips，颜色靠只读色块认（2026-10-24）

需求原话：「现在选择并入矩阵后，SKU 样式是乱的，有很多重叠，页面中的颜色也不够直观，操作不够便捷」
+「文字也太多了」。接在同日两栏改版之后，**数据模型零改动**。

- **根因不是重叠，是高度**：规格区原先用 196px 宽的色卡，7 色实测 **330px** 高，把矩阵压到约 180px
  ⇒ 一屏只看得到 **3 行**组合，同时单元格内容只有 96px 宽 ⇒ 看着像"挤成一团 / 重叠"。
- **规格区**（`SkuMatrixEditor.vue`）改成三行「标签 + content」：`颜色` / `尺码` / `克重`，内容是
  chip（26px 色块 + 色名输入 + ✕）而不是卡片。`spec 330 → 150`、`table 180 → 420`、
  一屏可见 **13 行**（8 色 5 码）。
- **颜色直观**：chip 前挂色块、行首再给 3px accent（`.mx-c-row` 的 `inset box-shadow`），色值来自
  `findSwatch()`。色块**只读** —— 不落库、不参与匹配、点不动：色名仍是唯一标签（身份用 id）。
  `src/lib/colorSwatch.ts` 扩到单字/描述性色名并新增 `findSwatch()`：**最长匹配**（`酒红` 先于 `红`）、
  认不出返回 `null`（刻意不回落中性灰 —— 全都一个灰块比没有更误导）。
- **常用动作就地给**：`常用 ▾` 一次补齐 S–XXL（**幂等，只补缺，列序不重排**，选完自动收起）；
  新增色 / 码后自动聚焦到刚生成的那个输入框；`＋ 尺码` 遇到已有空 chip 就**聚焦**它而不是再插一列。
  克重侧明确两个批量动作：`填空格（N）` 与 `覆盖已填`。
- **文字**：规格区总说明、矩阵页脚说明、导入说明、进价说明、底部唯一性提示全部删除或压成一句，
  解释搬进 `title`。判据是"第一眼看过去只剩控件"。
- **守卫**：`goods:ui` 新增 `sku-compact-layout` 步（351 → **361** 项 × 三遍视口 ALL PASS）——
  只补缺尺码 / 菜单选完收起 / 可见行 ≥ 7 / 规格区 ≤ 200px / 藏青色块 `rgb(47,59,94)` 与 accent、`#2f3b5e` /
  控件不溢出 td 且不被压扁 / 被标记色只显示圆点不涂满 / 收尾放弃后 `productVariantUpsert` 零新增；
  `tests/colorSwatch.spec.ts` 重写为 **7** 例。`vitest` 45 文件 / **879** 例。
  **变异 5 组各只红目标断言**：`max-width: 20px` ⇒ `squeezed=40` 红；规格区套回卡片 ⇒ `spec=214` 红；
  去掉收起 / 去掉色块 / 去掉 accent ⇒ 三条各自红。
- **门禁**：`tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `eslint`（改动 5 文件）· `verify` ·
  `verify:docs` · `build` · `vitest` · `goods:ui` · `goods:shot`。
  取证截图新增一张 **8 色 × 5 码**特写（`sku-matrix-dense-1440x900.png`，`spec=150 / table=364 / 可见 11 行`）——
  1 色 2 码的截图看不出问题，用户报障的状态是多色多码。
  结论与取证见 `docs/notes/2026-10-30-goods-sku-matrix.md`。

### Changed · 产品编辑抽屉重设计：整窗高两栏，SKU 矩阵拿到全部剩余宽高 + 批量手势（2026-10-24）

需求原话：「重新设计编辑产品页面，当前页面太杂乱，SKU 的编辑也很不方便」。只改版式与手势，**数据模型零改动**。

- **版式**：560px 单列 → **整窗高两栏**（`ProductEditorDrawer.vue`）。左栏 320px 放档案字段
  （主图 / 基本信息 / 价格与状态 / 备注，分节用一条细横线分隔，不套框），右栏吃满剩余宽高放 SKU
  （吸顶工具条 + 规格 + 矩阵 + 编码 / 老数据）。抽屉宽 `min(1040px, 94vw)`：列表仍露出可见的一条。
  两栏**各自滚动** —— 这是"杂乱"的根（单列时字段与 SKU 抢同一条滚轴，矩阵还被 560px 宽 + `40vh` 高一起挤）。
- **矩阵高度**：新增 `fill-height` prop，产品抽屉用它取消 `max-height: 40vh` 改成 `flex: 1 1 auto`
  + `min-height: 180px`。采集快照弹层与建款向导**仍保留** `40vh` 兜底（那两个场景没变）。
- **SKU 批量手势**（`SkuMatrixEditor.vue` + `src/lib/skuMatrix.ts`）：
  - **列头 = 整列开关、行名 = 整行开关**（`data-act="{act}-col-all"` / `{act}-row-all`）。语义是
    "**应该是**"而不是"反过来"⇒ 幂等：已经全开时点一下 = 整列/整行取消。新增纯函数
    `setMatrixRowCells` / `setMatrixColumnCells`（越界不造行、已是目标状态返回原引用）。
  - **按住拖过几格 = 连续勾选 / 取消**：`pointerdown` 只记目标状态（不直接改，否则一次点击算两次），
    掠过另一格才动手并补上起点；`pointerup` 后用 0ms 的 `suppressClick` 挡掉拖完那一下的 click。
  - **克重格 Enter ⇒ 同一列的下一格**（不绕回第一格）；定位靠 `data-cell-row` / `data-cell-size`。
  - 矩阵图例补一句手势说明；「边改边存」由一整段说明压成头部徽标（全文进 `title`），
    抽屉末尾与矩阵页脚的重复说明去重。
- **守卫**：`goods:ui` 新增 `sku-bulk-toggle` 步（344 → **351** 项：列头只动这一列 / 再点回到全开 /
  行名整行取消且统计同步 / 再点回来是"存在但待填" / Enter 落到同列下一格 / 收尾放弃且 SKU 写入为 0）；
  `tests/skuMatrix.spec.ts` 43 → **47** 例。**变异两条都红**：`toggleColumn` 恒传 `true` ⇒ 只取消这一列那条红；
  `focusNextWeight` 去掉"同列"判据 ⇒ Enter 那条红（`r0 sM`）。
- **门禁**：`eslint`（改动 4 文件）· `verify` · `vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` ·
  `vitest` 45 文件 / **879** 例 · `build` · `goods:ui`（宽 / 默认 / 窄三遍 ALL PASS）· `goods:shot`。
  结论与取证见 `docs/notes/2026-10-30-goods-product-editor.md`。

### Added · 店铺属性加「记分分值」，状态值加封店 / 退店（2026-10-23）

需求原话：「店铺属性增加，记分分值、状态值增加封店、退店」。

- **数据层**：`sk_shops` 新增 `score REAL NOT NULL DEFAULT 0`（0 = 未记录；记分分值不参与任何匹配 / 筛选键）。
  新库由 `shopTableSql` 一次建到当前形状；老库走**独立迁移键 `shop.columns` v1**
  （`PRAGMA table_info` 幂等探测 + `ALTER TABLE ... ADD COLUMN`）。不能挂进 `shop.main`：
  那一步已在 v1 短路，之后追加的步骤永远不会执行。`shop.main` 重建用的也是同一个 `shopTableSql`
  （新表带 score），但 `loadShopsSql` 不列该列 ⇒ 老库合并出来的行记分为 0。
- **四态**：`ShopStatus` / `ShopAccountStatus` = 启用 / 停用 / 封店 / 退店，`SHOP_STATUSES` 是唯一来源
  （账号域直接复用，不再各写一份白名单）。合并店铺与账号时：店铺侧非启用优先；账号侧旧值
  `banned` → 封店、`closed` → 退店、其余非启用（`paused` / `archived`）→ 停用。
- **局部更新不再"复活"非启用店**：状态缺省时沿用**归一后的现值**（原先只认 `archived`，
  只改备注就会把封店 / 退店静默改回启用）。记分缺省保持原值，显式传 0 = 清为未记录。
- **记分归一**：只接受 ≥ 0 的有限数、保留两位小数；负数 / `NaN` / `Infinity` **抛错**
  （`记分分值必须是 0 或正数`），不静默归零 —— 静默归零会表现为"保存成功但什么都没记下"。
- **界面**：「店铺登记」编辑器新增「记分分值」（`data-act="shop-score"`），状态选择器四态
  （`data-status`）；列表在状态徽标下、卡片在字段区**仅当 > 0** 显示「记分 N」（0 = 未记录，不占位）。
  订单 / 拣货页面按 `status: 'active'` 取店，封店 / 退店与停用一样不再进候选。
- **守卫**：`npm run shop:smoke` 39 → **43 项**（老库补列：老行默认 0、数据不丢、幂等；四态写入 / 筛选 /
  局部更新不复活；记分两位小数与非法值抛错）；`npm run master-data:ui` 钉住四态选择器、记分 12 / 20 的展示
  与「封店 + 20 分」保存回写；`scripts/check-cross-domain-edges.mjs` 登记 `shop-accounts-db → shop-db`
  新增取用面 `normalizeShopScore`。
- **门禁**：`lint` 0 error / 523 warning · `verify` · `verify:docs` · `vue-tsc --noEmit` ·
  `tsc -p tsconfig.electron.json` · `vitest` 45 文件 / **872** 用例 · `build` · `shop:smoke`（43）·
  `master-data:ui` · `schema:smoke` 全绿。`schema:smoke` 覆盖不到本域（`shop.main` 不走 `migrate()` 步骤表），
  本域的老库场景以 `shop:smoke` 为准。

### Fixed · 产品 SKU 矩阵里改色名不再把色图弄丢（2026-10-23）

用户实报：「当前编辑产品页，SKU 矩阵中并入的矩阵，修改颜色后，图片就没有了」。根因不在合并没有色图，
而在**显示层的判据**：色图在订单域是按「款编码 + 色名」查的（`findStyleColorImagePath`），而抽屉里
色名是能随时改的标签 —— `ProductEditorDrawer.vue#applyColorImages` 把"查不到"当成"这张图作废"
（`row.imageUrl = ''`），于是每敲一个键就把这一行的图抹一次，而库里那张图仍挂在款色上。

- **只补不撤**：查到（库里这个色名确实有图）才换；查不到 / 查询失败保留行上原有的图。
- **改名后防抖 400ms 重查一次**：改色名的两种意图（换个说法 vs 改成库里另一个有图的色）只有库能分。
- **保存后按 SKU id 续图**（`carryRowImages`）：改名在 `matrixPlan` 里是**原地改**（`pl_variants.id` 不变），
  重拉矩阵后按 id 把旧图带回新行 —— 按色名再查必然落空。
- **保存时把色名同步到订单域的款色**（新通道 `style-color-rename` → `order-db#renameStyleColorByCode`）：
  只改 `oi_style_colors.color`，id / 编码 / 绑定的图都不动（图跟着 id 走，拿货/拣货按款色 id 分组的历史行
  不受影响），成功后顺手记一条 `oi_color_aliases` 旧名→新名（以后平台再发旧色名的订单能对上）。
  目标色名已是另一色行时**拒绝合并**（`target-exists`，合并要人看图决定）；同步失败**不拦保存**。
  ⚠️ 旧名取自 `MatrixPlan.updates[].prevColor`（算差异那一刻的值）—— 保存后回读 `variants` 会拿到新名，
  判成"没改名"、同步静默不执行（本轮实测踩到）。
- 守卫：`npm run goods:ui` 新增「改色名后行头色图仍在」（改成库里没有的名字，等满防抖再看）
  与 `color-rename-sync` 四步（不保存不发通道 / 发的是改名前→后 / 保存后图仍在 / 改回去的 from 是当下真实值）；
  变异回旧实现 ⇒ 前者红（`src=missing`）。
- **新增行（并入矩阵的行）也必须改名**（同日第三次修复，用户接着报「保存以后图片还是丢失了」）：
  上面那条只覆盖 `MatrixPlan.updates`（已有 SKU 原地改名）。从采集商品并入的行在 `pl_variants` 里
  还没有 id ⇒ 走 `creates`，`SkuCreate` 里又没有"原色名"，于是**一次改名请求都没发出去**
  （真库实证：新增 SKU id 404–411 全是新行、`oi_style_colors` 仍是平台色号 `1..8`、`oi_color_aliases` 空）。
  修法：`SkuMatrixRow.srcColor` 记下并入那一刻的色名（`mergeSkuMatrix` 写入，不落 `sku_json`），
  `SkuCreate.prevColor` 带进 plan，`renameStyleColors` 先收 `creates` 再收 `updates`；改名失败
  （`target-exists` / `no-color` / 异常）不再静默 —— 保存后 toast 点名"哪几行色图重开后会空"。
  ⚠️ 已丢的那批图不做自动对齐：库里没有"它原来叫色号几"的记录，采集 9 个色的尺码集合完全相同，
  按顺序猜会猜错色（发错货）—— 只能由人重新导入那一色后再改名一次。
- 影响面：改色名后，订单 / 拿货 / 拣货 里显示的色名会一起变成新名字（这是"款色一起改名"的应有之义）。
- ⚠️ 守卫脚本自身的一处失修（本轮被 `lint` 抓到）：`goods-ui-smoke.mjs` 的假桥是模板串，注释里写了
  反引号包住的 `oi_images.style_color_id` / `shopItemImageFetch` / `oi_color_aliases` / `pl_variants`
  ⇒ 模板串被提前截断、整份脚本解析失败，`goods:ui` 一条都跑不了。已去掉注释里的反引号；
  这正是本仓反复踩过的坑 —— **注入脚本的注释不能带反引号**（改动后先 `node --check`）。

### Changed · 产品 SKU 只维护一套矩阵：采集段只认款，矩阵在产品编辑抽屉，内容从采集商品导入（2026-10-23）

用户口径：「未关联采集商品页面只认款」+「把修改 SKU 矩阵的功能与产品编辑里的 SKU 编辑合并，
最终目的是产品只维护一套完整的 SKU 矩阵，SKU 矩阵来源于采集商品」。此前同一个 SKU 有两个编辑面
（采集段行内「改/补」写采集快照 `sku_json`、产品编辑写 `pl_variants`），改了一边另一边看不到。本轮收成一个面：

- **采集段退成只读**：`PoolPane.vue` 的 SKU 列只展示色/码文本（没采到显示「未采集」），行内「改/补」
  入口与 `shop-items-update-sku` 通道整条删除（handler / preload / `src/types.ts` /
  `src/core/services/ipc.ts` / `goods/api.ts` 五处）；采集快照 `sku_json` 从此只由采集帧写。
  认款动作（关联到当前款 / 新建款并关联 / 删采集快照）一字不动。
- **产品编辑抽屉 = 唯一维护面**：行式 SKU 子表换成与建款向导共用的 `SkuMatrixEditor`
  （色 × 码二维矩阵，格 = 该组合在不在卖 + 克重）；SKU 编码收进「可选」折叠区，旧版只有名称的
  SKU 单列「旧」区（补上颜色尺码保存即升级 —— **不因为表里不画了就失去维护入口**）；
  保存仍是显式动作（「保存 SKU 矩阵（N）」，一次全量提交）。
- **新增「从采集商品导入」**（矩阵上方，仅编辑态）：列出认到当前款的采集商品（含没采到 SKU 的，
  选中时明说没有可导入的组合），预览「新增 N 色 · N 码 · N 组合 · 补 N 格克重」，`并入矩阵` 只改界面。
  - **按款筛在服务端**：`shop-items-list` 新增 `productId`，走与列表同一份 `LATEST_MAP_JOIN`
    （最新一条 confirmed 映射）——"历史认过"不等于"现在认的是它"；分页在服务端，前端筛会漏候选。
    `0 / NaN` 一律视为不过滤（`NaN` 也是 `typeof number`，不拦会绑进 SQL 抛错）。
  - **只补缺口**：新增纯函数 `mergeSkuMatrix(base, incoming)`（`src/lib/skuMatrix.ts`）——
    已有组合 / 已填克重 / SKU 编码一个都不覆盖，空格只从 0 补，新色新码只在该采集行真有这个组合时加，
    不笛卡尔补齐；按色名 trim 对齐；无变化返回原引用（幂等）。
  - **导入 ≠ 保存**：并入后按钮变「保存 SKU 矩阵（N）」、关抽屉照样先确认；导入那一刻
    `productVariantUpsert` 调用数必须是 0（否则"导入即生效"会把还没看过的矩阵直接写进库）。
  - **色图顺手采纳（只补空、失败不拦）**：按「采集行 id + 产品 id + 色→图（同色取第一张）」调
    `shop-item-image-fetch`，主进程仍是 `adoptStyleColorImageByCode` 的"目标色已有图就不换"；
    图片失败只影响回执里的采纳计数，矩阵照常并入。
- **建款向导的预填保留**（刻意）：它回答"这个新款的初始矩阵长什么样"，不是第二个长期维护入口；
  建档后再改一律去产品编辑抽屉。
- **冒烟/单测**：新增 `tests/skuMatrix.spec.ts` 9 例（含 999g 竞争值钉住"不覆盖已有克重"、
  幂等返回原引用）；`goods:ui` 新增 `matrix-import` 步（假桥**真的按 productId 过滤**、未认款的
  干扰项不得入列、导入后克重 `['320','150','','180']`、色图载荷只含红色、SKU 写入数为 0、放弃关闭）；
  `shop-item:smoke` 三条按款筛（只列当前认到该款 / 改绑后旧款筛不到 / 0·NaN 不过滤）；
  `ipc:shape:smoke` 钉 `productId` 载荷三态（>0 原样透传、0 压成 undefined、返回只含该款）。
- **门禁**：`lint` 0 error / 521 warning · `verify`（preload 211 / types 211 / 主进程 206，广播 3；
  跨域 require 6 / db→db 边 9）· `verify:docs` · `vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` ·
  `vitest` 45 文件 / **872** 用例 · `build` · `goods:ui`（宽 / 默认 / 窄三遍 ALL PASS）·
  `shop-item:smoke` · `ipc:shape:smoke`（53 项）全绿。`schema:smoke` 未跑：本轮无表形状 / 迁移改动。

### Changed · 进价页退役：进价回到产品行（列表内联 + 抽屉维护），汇率面板一并退场（2026-10-23）

C2 之后「进价」已经是 `pl_products.cost_cents` **一个字段**，而「基础数据 › 进价」页（`CostRatesPane`
= `CostPane` + `RatesPane`）还剩两块东西：一款一价的清单、以及汇率维护。用户直接问「进价页面还需要吗」
—— 核查后**两块都不需要**，整页退役：

- **汇率是死代码（先证后删，不是"看着没人用"）**：真实库 `ae_rates` 5 行全是种子默认值
  （USD 7.2 / EUR 7.8 / GBP 9.2 / RUB 0.085 / CNY 1.0）、从未被改过；`oi_orders` **没有 `currency` 列**，
  金额本来就按人民币分存；实时引擎 `orderCost.ts` 从不查汇率（非人民币报价的运费直接拒算）；
  唯一读这张表的是老采集库的一次性迁移 `migrateLegacyCollectedOrders` ⇒ **UI 撤，表留**（迁移还要读，
  删表风险换不来任何收益）。
- **缺价待办搬进产品列表，走服务端筛选**：新增 `onlyMissingCost`（`listProducts` 优先级排在
  「未关联厂家 > 指定厂家 > 缺克重」之后），工具栏下拉加「缺进价」、活跃筛选区加 chip
  「只看缺进价」。⚠️ 必须服务端筛：产品列表**分页在服务端**，前端过滤会把分页后的款藏成"没有"。
- **进价内联到产品列表**：`ProductPane.vue` / `ProductListView.vue` 各加一列 `p-cost`
  （`gdColspan` 5/6 → 6/7 —— 空态行与展开行都跨全表，列数不改会各短一格，**不报错**）；
  维护仍只在产品编辑抽屉的「进价（元）」栏（`ed-cost`，唯一写口 `product-cost-set`）。
- **撤入口**：`SHOP_ACCOUNTS_MAIN_TABS` 删 `'cost'`（唯一真源，`ShopAccountsMainTab` 类型自动收窄）、
  `MasterDataView.vue` 的 `KINDS` / `GROUPS.kinds` / 渲染分支 / `loadCounts` 的缺价款数 / `groupBadge`
  的货品组徽标；删除 `CostRatesPane.vue` / `CostPane.vue` / `RatesPane.vue` 三个文件。
- **算钱页只读区**（`CostRatesSection.vue`）：区头改「数据基础：产品当前进价」，删汇率表整块与
  「去维护」按钮（它指向的页已经没了，留着 = 点下去一片空白），`refresh()` 不再调 `aeRateList`。
- **健康检查指向**：`dataHealth.ts` 的缺进价项 `target` 由 `'cost'` 改 `'goods'`（并用「只看缺进价」筛选）、
  `HealthTarget` 收窄为 `'classify' | 'goods'`、`HealthPane.goFix` 删 cost 分支。
- **冒烟/截图同步**：`goods:ui` 新增 `issue-filter-cost` 步（下拉 → chip → 载荷 `onlyMissingCost:true`
  → 筛出的行 `p-cost` 全为「—」→ 点 chip 撤掉回到全部），「产品管理这组几条页签」由三条改两条；
  `order-profit:ui` 的 `cost-rates` 步改写为退役守卫（不画币种 / 不取 `ae_rates` / 不写 / 无「去维护」，
  并保留"缺成本自动展开 + 列出当前进价"）；`master-data:ui` 删 `cost` 步；`goods-shot.mjs` 删进价截图步。
- **单测同步**：`shopAccountsIntake.spec.ts` 的 kinds / GROUPS / 款级进价表用例随页退役删除（-1 用例）；
  `dataHealth.spec.ts`「三类去处」改「两类」；`uxEntryNames.spec.ts` 命中的旧模块名「货品档案」改「基础数据」
  （`CostRatesSection.vue` 里那句文案指向了一个已停用的入口名）。
- **文档**：`PRODUCT_LIBRARY.md` P4 行由"成本维护界面在哪"改写为「退役记录 + 现状入口」；
  `SHOP_ACCOUNT_REDESIGN_PLAN.md` §7.1 补一条归属闭环（那条"另一个工具在写进价线"的红点已转绿）；
  `check-doc-links.mjs` 把 `CostPane.vue` 登记为有意缺失（句子本身在陈述"它当时住在哪"）。
- **漏项修正**：`src/modules/goods/api.ts` 的 `list()` 载荷类型最初漏加 `onlyMissingCost`，
  `vite build` 不含 `vue-tsc` 所以没报 —— 是单独跑 `npx vue-tsc --noEmit` 抓到的
  （`useProductList.ts:137` 传了个类型里没有的键）。
- **门禁**：`tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `verify` · `verify:docs` · `lint`
  （0 error / 525 warning）· `build` · `product:smoke` · `vitest`（45 文件 / **860** 用例）·
  `goods:ui`（宽 + 默认 + 窄三遍）· `master-data:ui`（宽 + 窄）· `order-profit:ui` 全绿；
  `plugins:island:smoke` **未跑**（需先起 `npm run dev`，本轮未动任何岛）。

### Added · 「拿货」页新增「按单核对」：拿完货，哪几张单可以发了（2026-10-22）

用户追问：「拿完货后，怎么才能知道哪些订单的货拿完了？」—— 此前后台**回答不了**：全应用最细只到
款色码（拿齐的行从缺口里直接消失，没有"已齐"可回看），订单级的"齐了"根本不存在。两个根因：
`purchase_items` 没有 `order_no`（拿货单是按款色码凑的），`oi_orders.ship_time` 只来自导入报表
（应用内没有"这单货齐了"这个动作）。**不是设计缺失，是中间少了一条边**。

- `purchase_sources` 加 `order_item_id`（`purchase.main` v3）：`autoSourceRows()` 从 2026-10 初
  就在生成拿货单时按 `oi_order_items.id` 做 FIFO 分配（"这 N 件对应哪几条订单行"当时就算出来了），
  但只把 `shop` 写进库、把 `oi.id` 扔了 ⇒ 拿货与订单之间没有一条可查的边。现在补上这一列，
  "这张单齐了"从**推测**变成**事实**。
  - **存量只补"能由事实唯一确定"的行**（同 v2 补色的纪律）：该（拿货单, 款色码）组里只有一条来源行
    + 该款色码在未发货订单里只有一条候选行 + 那条只覆盖 1 件，三者同时成立才认。其余留 0（= 无归属），
    由界面明说"这批历史拿货没有订单归属"。猜错的代价是**把别的单宣布成已齐**，比显示"查不到"贵得多。
- 顺带修 `autoSourceRows()` 两处既有偏差（今天只让店铺成本分摊少记几行，但一旦变成"哪单齐了"的判据，
  就会给出**看着正常、实际错了**的答案）：
  1. **没有范围过滤** —— 它查订单行时没有 `ship_time='' AND status<>'shipped' AND 非终结`（而
     `outstanding()` 有），会把这次拿货分给已发货甚至已取消的订单；
  2. **件数当行数跳** —— `skip -= 1` 每行只跳 1 件，而需求按 `SUM(COALESCE(NULLIF(qty,0),1))` 算件，
     一单买 2 件时多跳一行。现在按件跳过、`qty` 记该行被覆盖的件数（一条来源 = 一条订单行 × 件数）。
- 新增只读取数口 `purchase-order-coverage`（`purchase-db.orderCoverage()`）：
  `rows` = 未发货 + 非终结订单的每一行 + 已被已提交拿货单覆盖的件数；`unattributed` = 无归属台账
  （`order_item_id = 0` 的那部分，减去已归属的差额）。**两者互斥**，相加不重复。
  ⚠️ 不用 `outstanding()`：那个是"还缺什么"，缺为 0 的行会被它自己过滤掉 —— 拿它判"齐了"，
  齐了的行整个消失，无从确认（2026-10-17 那次"全待拿"事故同一个坑）。
- 新增纯函数 `src/lib/orderCoverage.ts`：`planCoverage`（逐行判定）→ `groupByOrder`（聚成每张单）→
  `coverageSummary`（顶部那句数）。精确归属是事实，历史台账按款色码先到先得摊且**标 `estimated`**；
  未识别款不摊池子（空键会把"同色同码的不同商品"并成一格，凭空宣布已拿）。
- `PurchasePanel.vue` 顶部新增「按单核对」折叠块：折叠头直接给答案（`可以发货 N 单 · 还差 N 单`），
  展开分「可以发货」/「还差」两段；还差的行给款色码 × 件数 chip（超 6 条折成"还有 N 项"），
  未识别款单独打标，含推算成分时挂一句说明。**默认收起** —— 这一页的主活是开单，名单不该把厂家卡挤下去。
- 新单测 `tests/orderCoverage.spec.ts`（20 例）：精确命中/夹到需求、池子按行 id 先到先得（换传参顺序
  答案不变）、一件台账只被吃掉一次、精确与池子不重复、未识别款不摊、已终结剔除、两段互斥、
  件数守恒、`coverageInputs` 的列名翻译（`orderItemId → id`、`colorRaw → color`）。
- 冒烟 `scripts/today-ui-smoke.mjs` 新增 9 条：取数走 `purchase-order-coverage`、折叠头数字、
  默认收起、展开后 1 单可以发（**是哪一张**：I-1）、两段互斥、还差明细到款色码 × 件数、
  未识别款有标、件数守恒（共 6 件 / 已拿 1 件）、再点一次收回。

### Changed · 总览的「已拿」改成**逐行精确**（2026-10-22，同日第二轮）

上一轮那四个数只能用"款色码台账总量"近似 —— 同款色码有两条订单行时，那 1 件算谁的说不清。
`order_item_id` 落下来之后，已拿改成逐行判定：

- `dailyShip()` 的入参由 `{ taken }` 改为 `{ covered, pool }`（`taken` 保留为 `pool` 的旧名），
  内部改为复用 `planCoverage` —— **与「按单核对」同一份实现**。两处各算一遍，
  总览说"全齐了"、清单说"还差 1 件"是必然会发生的。
- 有归属的行按行精确扣，无归属的历史台账按款色码池子回退并夹到剩余需求内；
  `已拿 + 还差 ≡ 件数` 仍然恒成立。含推算成分时总览挂一句「已拿里有历史拿货单（没记订单归属），
  按款色总量估算」—— 推定不能当事实卖。
- `TodayView.reload()` 改读 `purchase-order-coverage`（**不再读整条 `purchase-taken`**：那会把有归属的
  再算一遍，已拿虚高、缺口提前变 0 ⇒ 漏货）。每次刷新仍是 1 次取数。
- `tests/dailyShip.spec.ts` 补 3 例（逐行精确、精确+池子不重复、`estimated` 报出来），共 14 例。

### Changed · 「发货台 › 总览」砍成四个数（今天要发几单 / 几件 / 已拿 / 还差）（2026-10-22）

用户裁定：「总览中的功能暂时没什么意义，先去掉，修改成展示：今天一共要发多少单、一共多少件商品、
已经拿了多少件、还差多少件。样式要简洁明了。」

- `src/modules/today/tabs/OverviewPanel.vue` 整页重写：撤掉**流程卡**（四步主线）与
  **订单 / 待拣 / 钱算得准吗**三张卡，只留四格数字 + 一条进度条 + 一句结论。
  空态保留一句话与「导入 Excel」按钮（否则这一屏是死路）；空态不挂口径小字、不摆一排 0。
- 新增纯函数 `src/lib/dailyShip.ts`（`dailyShip()`）：**四个数只有这一处实现**。
  - 范围 = 容器喂进来的「今天导入的订单」；已终结（关闭/完成）的行剔掉并计数；
  - 件数走 `orderCost.resolveQty`（与「统计」/ 拣货单同一份：结算真值 → 明细 qty → 报表 → 按 1 件并计数）；
  - 已拿 = 已提交拿货单**台账**，按「款|色|码」扣、逐 SKU 夹到需求以内 ⇒ **已拿 + 还差 ≡ 件数**；
  - 未识别款的行**照收件数、不扣已拿**（空款编码会把不同商品并成一格，凭空扣出一批已拿）。
  - ⚠️ 拿货明细里**没有订单号**（`purchase_items` 无 `order_no`），所以"已拿"只能是款色码维度的
    累计量：同一款色前几天拿过时会被算进今天这批（最多算到需求为止）。要按单核对只能看「拿货」页签。
- `src/modules/today/flowCtx.ts`：`ShippingSummary` 删掉 `picking` 与 `gaps.{weight,cost,rate}` /
  `gapTotal`（它们唯一的读者是那张被撤掉的卡），新增 `daily`。⇒ 每次刷新**少跑 3 次 IPC**
  （`pickingRows` / 产品库克重 + 价目 / 运价快照）。`gaps.style` 保留（「归类核对」页签徽标与主线状态用）。
- `src/modules/today/TodayView.vue`：`reload()` 改为读 `purchase-taken` 台账 + 调 `dailyShip()`；
  `flow` 仍保留 —— 页签左侧的「当前步」标记（`.td-tab.is-now`）读它。
- 冒烟 `scripts/today-ui-smoke.mjs`：`flow` / `orders` / `picking-card` / `gaps` 四段 20 余条断言
  随卡片一起撤掉，换成 5 条新守卫（四格数字、`已拿+还差=件数` 恒等式、口径小字、进度条几何比例、
  空态不摆 0 且刷新后数字回来），并加**反向守卫**（`flow` / `card-orders` / `card-picking` / `card-gaps`
  都不许再出现）。夹具里 `IMPORTED.styleColor` 由「红」改成「黑」—— 必须与台账同色名，
  否则"已拿"恒为 0，断言看着能跑却把"键对不上"的真 bug 掩盖掉。
- 新单测 `tests/dailyShip.spec.ts`（11 例）：去重单数、件数兜底计数、已终结剔除、逐 SKU 夹取、
  同款多行只扣一次、有效色回落、未识别款不扣已拿、`已拿+还差=件数` 恒等式。

### Added · 「导入订单」页列出今天导入的那些行（2026-10-22）

用户实报：「导入后显示『已导入 16 行订单』，但不知道订单在哪」。第 1 步的产物此前**没有任何一处列出来** ——
回执里那句「存到『订单』—— 在 XX 能看到」指的是页面名，"16 行"只是个数字。

- `src/modules/today/tabs/ImportPanel.vue` 新增「今天导入的订单」明细表：订单号 / 店铺 / 下单时间 /
  款号（未归类直接标出来）/ 颜色 / 尺码 / 件数 / 金额 / 状态，带关键字过滤与单次 100 行折叠。
  取数 `orderShippingRows({ limit: 2000, importDate: 本地今天 })` 与容器 `reload()` **同参同口径**，
  并在 `token` 变化时重取（选文件与拖放共用同一条 `bump()` 链路，不另写刷新逻辑）。
- 原「今天导入 N 行订单」现状条**并入本表表头**：数字与它下面那些行必须在同一块里 —— 分开摆正是
  "知道有 16 行、看不到这 16 行"的由来。计数只保留一处（列表自己那份，不与容器 `summary` 并列）。
- 导入**写了库**之后自动把明细表滚进视野（`block: 'nearest'`，尊重「减少动效」）：1152×800 下
  投放区 + 回执正好占满首屏，原本一行都看不见。
- 金额列不做合计：`amountCents` 是**整单**金额（`oi_orders`），一单拆多行时会重复，加总等于翻倍（表头已用 `title` 写明）。
- 冒烟 `scripts/today-ui-smoke.mjs` 新增 6 条断言：列表在且两种来源都出、三天前导入的行**不出现**
  （反向夹具，漏传 `importDate` 才绿）、计数=行数、未归类徽标、搜索能筛、无匹配与"今天还没导"两句分叉。

### Design → 落地 · 店铺账号物理合并（`shop.main` v1）+ ADR-003（2026-10-22）

开发期以「表简单、好维护」为先，`docs/archive/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md` 从「两表 1:1 逻辑合并」改写为
**店铺 + 账号物理合并成一张 `sk_shops`**：

- `sk_shops` 同时装店铺身份、账号、企业/工具引用、状态与加密凭据；`sk_shop_sets` 删除。
  `name` / `email` 任一非空即可（分别表示「只有账号」「只有店铺」），双空由 `CHECK` 拒绝；
  店铺名与邮箱改用**部分唯一索引**（空值不参与唯一性）。
- 紫鸟 / ERP 独立成 `sk_tool_accounts`（一条登录一份密码）；手机号复用 `sk_companies.contact_phone`、
  新增 `alipay_account`；国际支付宝密码留店铺行；`sk_mail_accounts` 外键改指 `sk_shops(id)`。
- 代价：一次性重建 `sk_shops` 与 `sk_mail_accounts`（`RENAME COLUMN` 不改外键目标），
  店铺 id 1–9 原样保留；唯一回滚手段是迁移前 `VACUUM INTO` 备份。
- 新增 [`docs/decisions/ADR-003-shop-account-physical-merge.md`](docs/decisions/ADR-003-shop-account-physical-merge.md)：
  **部分取代 ADR-002** 的「身份层必须物理独立」；C1–C4 保留，凭据边界下沉到 API 层
  （共享只读域 `shop` 不返回密文列，明文只走 owner 域 reveal）。ADR-002 已就地标注取代关系。
- 结论笔记 [`docs/notes/2026-10-30-shop-account-merge-and-status.md`](docs/notes/2026-10-30-shop-account-merge-and-status.md)
  记录不可逆点与合并后必须守住的四条；`docs/README.md` 索引与文档计数同步。
- **P0–P3 已于同日全部落地**（原「本轮仅改方案与文档，未动代码」的后续），落地记录与两个生产级隐患见
  [`docs/notes/2026-10-30-shop-account-merge-and-status.md`](docs/notes/2026-10-30-shop-account-merge-and-status.md)：
  - **P0** `shop.main` v1（**刻意不走 `migrate()` 步骤表**：`PRAGMA foreign_keys=OFF` 在事务内无效，事务外壳由
    `runShopMainMigration()` 自管）+ 迁移前 `VACUUM INTO` 备份 + 启动编排「先企业 → 再店铺 → 后邮件」
    （手机号 / 支付宝要从账号行回填进企业表）。⚠️ 踩到两个只在真老库上才暴露的问题：
    ① `ensureShopSchema()` 按 house convention 先迁移后建表时，迁移收尾要建的 `idx_sk_name_map_ref` 指向还不存在的
    `sk_name_map`，老库第一次启动直接 `no such table`（由 `shop-item` 冒烟抓到）→ 本域改成**建表在前、索引在最后**；
    ② `VACUUM INTO` 撞到已存在的备份文件**直接报错**，"上次尝试留下的备份"会让迁移永远起不来 → 备份名避让已存在文件。
  - **P1** `upsertShop` 改**局部更新**（`undefined` = 保持原值、`''` = 清空）且写入面**不含账号列** —— 店铺选择器
    编辑一次地址就把同行的邮箱 / 工具 / 凭据清空，是这个模型最容易犯的错；`upsertShopAccount` 为合并后的唯一账号写口；
    删除保护：被 `pl_shop_sku` / `pl_shop_items` / `sk_name_map` 引用即拒绝；邮件账号 + 本地邮件缓存**刻意级联删**，
    确认框用 `hasMailAccount` 明说。工具账号四通道（`tool-account-list/upsert/reveal/delete`，明文只从 reveal 出）。
  - **P2/P3** 店铺列表与账号列表合成一页 + 企业 / 手机号 / 支付宝 / 紫鸟 / ERP 五个下拉**联动**筛选（选项随彼此收窄）、
    合并编辑器、工具账号页（一条登录管多店，新增店铺不再重填密码）、企业侧新增 `alipay_account`、
    复制模板与批量字段收缩到工具账号、新行默认带出上一次选的企业 / 紫鸟 / ERP。
  - **真库克隆重放**（`shop.main` v1 打在迁移前 `VACUUM` 副本上）：19 行 = 6 双栖（店 + 账号）+ 3 纯店铺 + 10 纯账号、
    店铺 id 1–9 原样、工具账号 1 条、邮件 3 条 + 851 封一条不丢、`PRAGMA foreign_key_check` 干净、连跑三次幂等；
    企业 3 → 4（某个账号自带企业名，非造壳）、无企业信息的账号**照旧不建壳**（迁移遗留 `备注` 2 条即其痕迹）。
  - **表计数净 0**（−`sk_shop_sets` + `sk_tool_accounts`），§6「稳态共 40 个对象 / 37 业务表」未变；
    但"手抄 grep 推算"退役，新增 **`npm run db:inventory`**（真建一个库逐域数，首跑即发现自己双计了 FTS5 本体）。
  - **残留收口**：`src/**` 与 `electron/**` 的业务代码里 `shopSetId` **0 处**；九处 `upsertShop({… shopSetId: 0 …})`
    死键从冒烟夹具里删掉（合并后的入参忽略多余键，不报错，但会让下一个人以为这一列还在）。
    `sk_shop_sets` / `shop_set_id` 只剩三类合法去处：迁移本体、冒烟里**刻意造的旧形状夹具**（`shop-db-smoke` 建老表、
    `shop-item-db-smoke` 的 `DDL_PREV`/`DDL_OLDEST`）、带日期的历史文档与注释。
  - **顺手修掉两条与本轮无关的死引用**（`mail:body:smoke` 从 2026-10-14 起就再没跑通过）：① 它的夹具还在
    `INSERT INTO sk_mail_accounts (shop_set_id, …)` → `no such column`；② 第二层 CSP 的来源写死成
    `ui-plugins/shop-accounts/index.html`（该岛早已回收为内建模块），而这一句跑在 `app.whenReady()` **之前**，
    Electron 遇 load 期异常只打一行 `App threw an error during load` **且不退出进程** —— 症状是"**零输出、一直卡死**"，
    本轮一度被误记成"同机并发挤住"。现改为按事实扫描（谁的岛源码引用 `sk-mail:` 就读谁的 `index.html`；
    当前无岛嵌正文 ⇒ 显式打印「不适用」跳过，不抄副本冒充真实）。铁律入
    [`docs/notes/2026-10-20-engineering-hard-laws.md`](docs/notes/2026-10-20-engineering-hard-laws.md)。
  - **收工门禁快照**（同一棵树）：`tsc` / `lint`(0 error) / `verify` / `npm test`(860) / `build` / `schema:smoke` /
    `shop:smoke`(39) / `shop-item` / `product:sku` / `picking` / `style` / `order` / `ship-rate` / `product` /
    `ipc:shape`(55) / `mail:inline` / `mail:body` / `db:inventory` / `plugins:island` / `master-data:ui` / `today:ui` /
    `shipping-rate:ui` 全绿；`vue-tsc` / `verify:docs` / `goods:ui` / `order-profit:ui` 各红一处，**同因**：同机另一个
    工具正在写「进价 / 成本维护」那条线（`onlyMissingCost` 未进 `api.list` 入参类型、`CostPane.vue` 处于 `RD` 半搬状态），
    红点没有一条读店铺或账号数据，不据它们判本域回归，也不替对方补。`mail:smoke` 需 `MAIL_USER`/`MAIL_PASS`，未跑。

### Fixed · 克重取数拉全：修掉「只取前 500 款」的静默上限（2026-10-22）

A7（阶段 A）遗留项：`loadSkuWeights()` 只取产品列表前 500 款，产品超过 500 款时第 501 款起的订单行
`weightSource` 会静默变成 `none`（"缺克重"），看起来像数据没维护，且没有任何报错。
阶段 B/C 已完成但一直没改这一处，本轮收口：

- **取数改法**（`src/core/services/skuWeights.ts`）：产品分页拉全（`product-list` 单页上限 500，按 `offset` 翻页，
  `total` 到齐或遇短页/空页即停）；SKU 分批取（`product-variant-list` 单次 ≤5000 个产品 id），合并后仍交给
  `buildSkuWeightIndex` 建键 —— 与 `shipRateOps.quoteProducts` 已有的翻页/分批写法同一套。
- **失败语义不变**：任何一页/一批读失败 → 返回空表，**不给半个表**（半个表会把"其实有克重"的行误报成缺口）。
- **守卫**：新增 `tests/skuWeights.spec.ts` 4 条（620 款第 2 页命中 / 5200 款按 `[5000, 200]` 两批 /
  产品第 2 页失败 → 空表 / SKU 第 2 批失败 → 空表）；变异"只取第一页"⇒ 3 条变红。
- **冒烟夹具**：`scripts/shipping-rate-ui-smoke.mjs` 的假桥改成照真宿主分页、`productVariantList` 按
  `productIds` 过滤（原先忽略 `offset/limit` 回全量，会掩护分页漏页）。
- **门禁**：`tsc` / `vue-tsc` / `lint`（0 error）/ `verify` / `verify:docs` / `build` / `vitest` 43 文件 827 用例 ·
  `shipping-rate:ui`（宽 + 窄）/ `order-profit:ui` / `today:ui` 全绿。

### Fixed · 基线复核：清库脚本补表 + 表/命名空间口径订正（2026-10-22）

本轮「审查变更并更新项目基线」中发现并修掉的问题：

- **`scripts/reset-dev-data.mjs` 漏清 6 张表**：`CLEAR` 列表停在拆表/包裹之前，缺 `oi_order_items` /
  `parcels` / `parcel_lines` / `oi_color_aliases` / `pl_shop_items` / `pl_shop_store_keys` ⇒ 一次"清库重跑"
  会留下孤儿明细与包裹行。已补齐（现为 **34 张**，以脚本 `CLEAR` 数组为准）。
- **基线表计数与命名空间清单订正**：稳态对象由错记的 38 业务表 / 41 对象订正为 **37 / 40**
  （此前漏减 C2 删除的 `ae_cost_map`、且只列了一处冻结迁移 DDL；`COST_MAP_DDL` 同属迁移期旧形状）；
  `quick-note` **确有** `quick-note` 命名空间（旧记"随会话存在"已过时），并补记 `appearance` /
  `shop-accounts-mail` 两个命名空间。同批把 `AGENTS.md` 里滞后的三处事实（在架 UI 岛 4 → **2**、
  命名空间清单、vitest 2.x → **4.x**）与主进程规模/通道数一并对齐。
- **数字与注释残留（同日第二轮复核）**：`scripts/` 实测 **26,073** 行（旧记 26,072，合计应为 **111,776**）；
  `theme.ts` 头注释写「持久化到 app-shell 命名空间」而代码实为 `useModuleStorage('appearance')`；
  `AGENTS.md` 把 `shipping-rate` 命名空间写成「运价表 + 报价配置」（运价表真源是宿主表 `sr_rate_snapshots`，
  该命名空间只存查询偏好）；两处 prettier 失败文件数互相矛盾（125 / 151）→ 统一为 2026-10-22 实测 **336**。

### Design · C2 定稿：订单明细行拆「进价 / 实际进价」两个成本字段

`ae_cost_map` 退役前把成本来源补齐为两个落库快照（早前方案定过「进价 + 实际进价」，实现侧只落了后者）：

- `oi_order_items.cost_cents` = **进价（预估）**，归类核对「确认无误」时按当时生效价钉住；
- `oi_order_items.actual_cost_cents` = **实际进价（实付）**，拿货落账回写（只补空、按拿货日期先到先得）；
- `pl_products.cost_cents` 仍是**当前进价**，供新单估算，不回写历史行。

利润取数 `实际 > 预估 > 缺`；0 一律视为缺失；来源由"哪个字段有值"表达，**不另加 `cost_source` 标记**。
存量迁移：现有 `cost_cents`（实际价）先搬 `actual_cost_cents`，再按订单日期从旧价目表回填预估。
判据更正：只要求成本侧 `costmap` 归零，`weightSource='lookup'` 是克重来源、**不在 C2 判据内**。
执行细则见 `docs/archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §5。

### Changed · C2 收尾：`ae_cost_map` 已删除（`order.main` v10，不可逆）

成本两字段落地后，旧款级区间价目表已无任何消费者，本轮把它与配套写口一并删除：

- **迁移（v10）**：`DROP TABLE IF EXISTS ae_cost_map`。挂在**订单域**而非 ae 域：v9 要先从这张表回填预估，
  两个域懒初始化顺序不定，放 ae 域可能先于 v9 执行。冒烟 [D]/[D2]/[H] 钉住「ae 域单独跑不删 /
  order 跑完才删 / order 域先跑且表还是旧形状时也读得动」。
- **删除通道与代码**：`ae-cost-map-import / -list / -upsert-manual / -delete-manual` 四条 IPC、preload 四个方法、
  `src/types.ts` / `ipc.ts` / host `ae` 域对应封装；`ae-db` 的 `costMap*` 与成本类型；`electron/manual-costs.ts`；
  产品导入载荷里已无消费者的 `effectiveFrom`。
- **新库形状**：`ae` 域 SCHEMA 不再建这张表（只留 ae 域 v1 迁移里冻结的旧 DDL，服务历史库）。
- **冒烟同步**：`ae:smoke` 收窄为「快照分组 + 采集落主干 + 新库不长表」；两个 UI 冒烟删掉
  `aeCostMapList` 假桩与零调用断言（通道已不存在，留着桩反而会掩护误调用）；
  `schema:smoke` 的 `ORDER_MAIN_STEPS` 9 → 10。
- **真实库**：实测已到 `order.main=9`（两字段与预估回填早已落库）、旧表 21 行；克隆后跑 v10 验证，
  47 单 / 51 明细 / 实付 ¥32.00 / 预估 ¥1,116.00 / 产品价 ¥503.00 逐项原样、外键零孤儿。
  **真库在 app 下次启动时自动删表**——运行中的进程仍按 v9 假设工作，不要中途手工删。


- **迁移（v9）**：明细加 `actual_cost_cents`；存量 `cost_cents`（实际一直只装拿货实付）搬进它并清空原列；
  再按**下单日期**从旧 `ae_cost_map` 取当时生效价回填 `cost_cents`（未归类/无区间留 NULL）、
  从拿货单补一次实付（不能等下次拿货，否则那 1 行实付会暂时掉回旧估算）、
  把价目表每款最新价镜像进 `pl_products.cost_cents`。`schema:smoke` 场景 [H] 钉住搬 / 回填 / 只补空 / 幂等。
- **写口收拢**：`purchase-cost-sync` 只剩 `syncOrderRowCosts()`（拿货落账只回写**实际进价**：只补空、
  按拿货日期先到先得、按款色 id + 尺码匹配）；旧 `syncPurchaseCosts`（同步写成本表）已删。
  手工改价只有一个入口 `product-cost-set`（只改 `pl_products.cost_cents`，回执带 `updated`，
  界面据此区分「已保存」与「与当前进价相同」）；产品导入 / 编辑抽屉随产品行写同一列。
- **读侧改接**：利润引擎 `orderCost.ts` 取数改为 **实际 > 预估 > 缺**（`costSource = snapshot / estimate / none`），
  删掉 `costmap` 回落；「货品档案」列表的当前价直接读产品行；拣货清单的价来自 `pickingRows` 的行投影
  （三档成本字段，优先级只在 `aggregatePicking` 一处实现）；利润页与拣货**不再调用** `aeCostMapList`。
- **冒烟/截图同步**：`today:ui` 夹具改成行上三档成本的真形状（S2 只填预估、S1/S3 全空）并加
  「一次都没调价目表」反向守卫；`goods:ui` 删掉价目表夹具与三个桩；`master-data:ui` 回显去掉「来源」
  并反向钉住来源/生效日/区间不许回来；`product:smoke` 补齐 `updated` 契约（同值重写不算改动）；
  `goods:shot` 的进价截图改走「产品管理 › 进价」并在拍完后切回建档页（否则后两张永远跳过）。
- **删除旧表（已在本版完成）**：`ae_cost_map` 表、`ae-cost-map-*` 通道、`ae-db` 成本段、
  `manual-costs.ts` 与 host 的 `costMap*` op 已随 `order.main` v10 删除（见上一节「C2 收尾」）。
- **门禁**：`schema:smoke` / `order:smoke` / `ae:smoke` / `product:smoke` / `picking:smoke` ·
  `master-data:ui` / `order-profit:ui` / `today:ui` / `goods:ui` / `goods:shot` · lint 0 error · verify · vitest 823 全绿。

### Changed · 运费接入利润：已拆包按包裹实付、缺则标缺（阶段 C1）

利润页的运费从"只按运价表估算"改为**包裹真值优先**：已拆包的单，运费 = 该单所有包裹的运费合计；
没拆包的单保持原运价表链路。运价表快照表本身保留（导入/归类算运费仍用），退役的只是"利润侧对它的依赖"。

- **分配的只有行**：订单级包裹运费按件数摊到各商品行（四舍五入到分，**尾差归末行** ⇒ 各行之和恒等于订单合计）；
  订单级总额不因摊法改变。
- **缺运费不回落估算**：已拆包但有包裹没填 `ship_cents` ⇒ 该单各行运费 `null`、标 `parcel` 缺口
  （界面 chip「缺包裹运费」，可点筛行），**不拿运价表补** —— 否则用户按包填的真值会被估算悄悄盖掉，行上无痕。
- **新读口（三方同步）**：`order-db.parcelTotalsByOrders(orderNos)` → `order-parcel-totals` → preload
  `orderParcelTotals` → `src/types.ts`（`ParcelTotalsMap`，具名别名，避免契约校验器把内联
  `Record<...>` 的逗号切成假成员）→ `src/core/services/ipc.ts`。利润页刷新只发**一次**批量查询。
- **一个数字一处实现**：单笔 `parcelTotals(orderNo)` 改为委托批量聚合（`parcelTotalsByOrders`），
  多行汇总/缺值判空/合计口径只有一份 SQL 与一处判据。
- **界面口径**：运费单元格悬停区分三态（包裹实付 / 按哪份运价表 / 包裹缺运费且不估算）；
  「缺包裹运费」进缺口表且可点筛选；多件提示改为"成本按单件价，未拆包的单运费也按 1 件估"；
  "还没读到运价表"的 toast **只在还有未拆包订单时**出现（全部已拆包时它是一份用不到的数据）。
- **守卫**：`tests/orderCost.spec.ts` 新增 5 条（包裹合计压过运价表 / 多行按件数摊 / 尾差归末行 /
  缺运费标缺不回落 / 无包保持原链路）；`order-profit:ui` 新增 2 条（包裹 45.00 ≠ 运价表 30.00，
  证明真走了包裹链；缺运费 →「—」+ 缺口 chip「缺包裹运费 1」）；`order:smoke` 与 `ipc:shape:smoke` 全绿。
- **顺带修复**：`ipc:shape:smoke` ⑥/⑧ 的造数仍按 B1 前的 `oi_orders(image_id, size)` 形状插入
  （B1 后这两列在 `oi_order_items`），已改为「主表一行 + 明细一行」，冒烟恢复全绿。
- **未做**：C2 退役 `ae_cost_map`（成本维护/导入写口搬产品表、按两字段定稿回填、全库统计成本侧 `costmap` 归零后再删）。

### Changed · 订单表拆成「主表 + 明细」（阶段 B1，`order.main` v8）

`oi_orders` 从「一行 = 订单 × 商品图」拆成 `oi_orders`（一单一行，`order_no UNIQUE`）+
`oi_order_items`（一 SKU 一行，`order_id` 指主表），同单多图时订单级字段（金额/税/状态/发货时点）不再复制 N 份。

- **唯一不变量：明细 id 原样保留旧 `oi_orders.id`** —— `parcel_lines.order_item_id`、采购来源等
  所有按"行 id"的引用**零迁移**；主表 `oi_orders.id` 才是新自增。
- **迁移口径**：每个 `order_no` 取 `MIN(id)` 那行的订单级字段作主表行；空单号的历史行用 `__empty__||id`
  各自成单（不并、不丢）；**同款同色不合并** —— 合并是汇总层语义，物理层保留 SKU 粒度（拆包/取图都靠它）；
  重建后追平 `sqlite_sequence`。
- **真实库对照**：v6 库 51 行 → 47 主表 + 51 明细，**51/51 明细 id 不变**、逐行字段一致、外键有效、二次迁移零变化。
- **三条写入口约定**（都是原先"跳过就静默"的地方）：
  ① 空订单号**明确报错**，不再往 `NOT NULL` 列写 `null` 占位；
  ② **导入与采集互斥**：同一单号已由另一通道写入时拒绝（导入不许往采集单追加、采集不许整单替换导入单），
     `ae-db` 把被拒原因记进主进程日志，不再只留一个 `skipped` 计数；
  ③ 采集重推是整单替换 ⇒ **先清该单的包裹与明细**（明细 id 会换，旧包否则变成"0 条明细的空壳"、
     还继续参与 `parcelTotals` 的运费/重量汇总）；明细删除显式写出，不靠 `ON DELETE CASCADE`
     （`PRAGMA foreign_keys` 是连接级开关）。
- **下游随同改写**：`shippingRows` / `pickingRows` / 归类回写 / `syncOrderRowCosts` 等一律「主表 JOIN 明细」。
- **守卫**：`order:smoke` 新增 [9] 一组（空单号不留半行 · 双向通道互斥且不改对方金额 ·
  重采集后旧包裹为 0、总运费回 `null`）；`schema:smoke` 场景 C 覆盖 v8 拆表。
- **未做**：运费接进利润（B3/C）、`ae_cost_map` 退役（C）。详见 `docs/notes/2026-10-30-order-table-and-model.md`。

### Added · 包裹模型：一单多包 / 按商品行拆数量（阶段 B2）

订单可以被装成多个包，一个商品行的件数还能拆到两个包里（重量/运费按包算）。

- **新表**（不改老表）：`parcels(order_no, label, tracking_no, carrier, ship_cents, weight_g, note)` +
  `parcel_lines(parcel_id, order_item_id, qty, UNIQUE(parcel_id, order_item_id))`。
  键用 `order_no` —— B1 拆表前 `oi_orders` 一行 = 订单×图、没有订单主键可指；拆表后它正好是订单主表的业务键，数据不用迁。
- **空值口径**：`ship_cents` / `weight_g` 可空且不给 `DEFAULT 0`（NULL = 还不知道）。
  总运费/总重由 `parcelTotals()` 派生：**任一包缺值 ⇒ 整单 null**，并给出"还有 N 个包没填"，不拿已知部分之和冒充。
- **拆包规则只有一处实现**：`order-db.setParcelLineQty` 统一拒绝「跨单」「超拆（超过这行还能拆的件数）」，
  拒绝理由带具体数字；"还能拆几件"与界面显示共用 `parcelRemaining`。
- **界面**：「今天 › 归类核对」行内「拆包 ×N」→ 右侧抽屉（商品行 + 包裹卡片）。两个范围都给入口
  （核对定"是什么款"，拆包定"怎么装箱"，是两件事）。写入成功一律用主进程回的**整单**状态重绘。
- **守卫**：`order:smoke` 新增包裹一组（超拆/跨单/缺值当 0/删包留残）；`today:ui` 新增 7 条
  （入口 · 徽标 · 出参单号 · 汇总 · 超拆理由 · **被拒后回读** · 新建包裹 2 包 → 3 包）。
  后者当场抓到"拒绝理由被回读清空"（修法：先回读、再挂理由）。
- **生命周期**（B1 落地后补齐）：`clearAll` 连包裹一起清；删行后顺带清掉不再有明细的空包裹；
  采集重推前清掉该单包裹（明细 id 会换，否则旧包成空壳还进 `parcelTotals`）。详见 `docs/notes/2026-10-30-data-model-and-dependencies.md`。
- **未做**：运费接进利润（B1 的订单主表已落，留给 B3）——✅ **已由 C1 完成**（见上一条）。

### Changed · 利润引擎改读行级快照（阶段 A7）

`orderCost.ts` 的成本与克重改成「**快照优先、缺失回落**」，并在每行标出这个数从哪来：

- 成本：行上有 `costCents`（拿货实付）就用，否则回落 `ae_cost_map` 区间取价；`costSource` = `snapshot` / `costmap` / `none`
- 克重：行上有 `weightG` 就用，否则仍按「款色码 → 款码」查产品库 SKU；`weightSource` = `snapshot` / `lookup`
- **次序铁律：真值先于估算**。反过来的症状是"用户填了拿货实付、利润却按估算算"——改了价看不出变化
- `0` 与缺失一律**不当快照**（0 既不是"免费"也不是"零克重"）
- 利润页「成本」列悬停现在会说明是实付还是估算（`weightTitle` 同样补了"本行还没钉快照"）

真实库对照（克隆库 51 行，改造前后各算一遍）：46 行逐行一致；4 行克重由 `lookup` 钉成 `snapshot`
且重量/运费**不变**；1 行成本由估算 28 元变实付 32 元（设计意图，非回归）。
证据与判据写在 `docs/archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §0.1。

### Changed · 手工进价的镜像收进一处（阶段 A6）

三个入口（成本面板 / 产品导入 / 产品抽屉）过去各写一遍"成本表 + 产品表"，现在统一由
`applyManualCosts` 内部镜像，回执带 `productsSynced` / `productsMissing`：

- 成本表里已有同价（区间幂等跳过）时**产品表照样补齐**——老数据的价只在成本表，重存一次正是补齐的机会
- 产品库没有该款时如实计数，界面明说"价只记在成本表，产品页的进价不会变"
- `0` 价不镜像（产品表的 0 语义是"没填"，写 0 = 把价清空，利润会凭空变大）

> 过渡期已知限制：产品抽屉把进价清空时，列表/利润仍会从成本表回落到老价（"清不掉"）。
> 列表与利润走同一条回落链，两处**数一致**；阶段 C 删回落分支后自然消失。

### Added · 订单行级快照：克重 / 实际进价（阶段 A4/A5）

`oi_orders` 新增 `weight_g` / `cost_cents`（迁移 v7，**NULL = 还不知道**，不是 0）：

> B1 拆表后（v8）这两列随行级字段搬到 `oi_order_items`；本条保留当时的记录。

- `snapshotOrderWeights()`：归类核对「确认无误 / 全部确认无误」时，按「款色 + 尺码」查 SKU 克重钉到行上。
  **只补空** —— 之后改 SKU 克重不会刷新历史行（否则同一单今天算 250g、明天算 300g，运费跟着漂）。
  行被改写款/色时（`updateOrder`）先作废该行快照再重钉，钉不上留 NULL 交给缺口统计。
- `syncOrderRowCosts()`：拿货落账后，把**已提交**拿货单的单价回写到订单行 `cost_cents`。
  三条边界：只补 `IS NULL` 的行 / 按拿货日期升序先到先得 / 只认有 `style_color_id` 的明细
  （文本色名配行会在改名后静默错配）。

### Changed · `schema:smoke` 迁移步数常数补齐（原有红灯）

`ORDER_MAIN_STEPS` 4→7、`PURCHASE_STEPS` 1→2 —— v5/v6/v2 加进来时没跟着改，冒烟此前一直红。
场景 C/E 里写死的 `order.main = 4` 一并改为读常数（避免下次加步再神秘变红）。

### Added · 产品「进价」落到产品表（阶段 A1）

`pl_products` 新增 `cost_cents`（当前进价，分），产品抽屉可维护、产品列表「进价」列优先读它：

- `upsertProduct` 对 `costCents` 采用**未传即保留**（全量提交里唯一破例）——防止"只改个名字"
  把价清成 0：进价是钱，静默归零会让利润凭空变好看且不报错。
- `product-import` 的「进价」列同值写入产品表；接口仍按行级「没填 = 不修改」处理。
- **过渡镜像**：手工改价同时写 `ae_cost_map`（利润引擎尚读成本表，阶段 A7 改读订单行快照后删除，
  届时唯一写入方 = `pl_products`）。列表取价顺序 = 产品表 → 回落成本表（老数据的价还在那儿）。

### Design · 订单-采购模型简化方案（方案评审 + 执行计划，未动代码）

评审「只靠订单表 + 订单商品关联表 + 包裹表算利润、退役 `ae_cost_map`」的可行性，结论落
`docs/notes/2026-10-30-order-table-and-model.md` + 执行计划
`docs/archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`：

- **实际进价不在导入时产生**：拿货单填价落账后才回写订单关联表（替代旧 `ae_cost_map` 落点）。
- **运费/克重是包裹级**：无忧按总克重计费、一单可多包 ⇒ 克重钉订单行、运费钉订单表/包裹表；统一在「归类核对确认无误」时钉死。
- 拍板：建「包裹表」支持一单多包（`parcel_lines` 带 qty，拆包按单个商品拆、可拆数量）；对账口径 = 拿货单（供应商应付）。
- 产品域：`pl_products` + 进价（当前价）、`pl_variants` + image_id（SKU 图，供认色）。
- 执行分 A 快照前置 / B 拆表+包裹 / C 退役表三阶段；风险标注：拆表是独立大工程、`ae_settle_lines` 去留未定。

### Fixed · 拿货：色名不再是身份（"图没了 + 全待拿"的根因）

色名（`oi_style_colors.color`）是**可变标签**，却被当成匹配键：改一次色名，拿货单的行图取不到、
已拿也扣不掉待拿 —— 用户实报的两件事是同一个根因。改为**身份优先、文本兜底**：

- `oi_orders.style_color_id`（order v6）+ `purchase_items.style_color_id`（purchase v2）两列；
  v2 只回填"该款唯一真实色"那些行（真库 3 行），其余留 0 —— **绝不猜色**。
- 已拿映射 `takenKeyOf/takenFrom`：有身份走 `#id|码`，无身份才回落到 `款|色|码`，两拨**互斥不双算**。
- 取图 `findStyleColorImagePath(…, styleColorId)`：有 id 只按 id 取，id 无图就显示「缺图」，
  **不回落色名**（回落到的是别的色，等于贴错图）。
- 需求侧两处算错数一并修：`COUNT(*)` → `SUM(qty)`（一单多件被少算）、需求侧 INNER JOIN → LEFT JOIN
  （51 行未发货里 9 行对缺口不可见）。真库：需求件数 50、待拿 45 行、未归类 9 件单列成组且不丢。

### Added · 已拿侧「N 行色未定」：卡面就提示，点一下去认色

老拿货单的色名是开单那一刻的快照（占位「未分类」），后来订单行归了色 ⇒ `款|未分类|码` 与
`款|3|码` 永不相等，那些件数**扣不掉待拿**（真库 #38/#39 共 9 行，涉及 3 个款、每款 2~7 个候选色，
无法自动定）。因此「已开单」行上多一枚标签：

- 显示「N 行色未定」，`title` 写清后果（这些行扣不掉待拿，清单会一直显示待拿）；
- 点它**直接打开那张单的编辑器**，行内「色未定 · 选一个」的候选只取该款真实色，
  选完写回 `style_color_id`（只补身份，不覆盖色名快照），可勾「同款其余 N 行一起」。

### Changed · 删掉包价单（第四套金额口径）

真库 `mode='package'` 0 条、也没有创建入口，留着只是"合计"的第二种算法。删除编辑器里的包价分支、
列表徽标、建单/改单的 `mode`/`totalCents` 入参与页头模式标签；建单时宿主恒写 `'detail'`。
同批把三处冒烟断言改成**反向守卫**（不该再出现模式标签 / 出参不许带 `mode` / 删除确认不许再按
"包价只进对账"分支措辞），假桥夹具也不再造包价单 —— 否则等于替已删代码养老。

### Docs · 「订单 → 拿货」链路简化审查（只出结论，未动代码）

用户实报「拿货单图全没了 + 拿货页全待拿」，追下去发现不是两个 bug，而是结构问题：
`oi_orders` 没有款/色/码列，款色只能经「订单图 → 色图 → 款色」间接派生 ⇒ 每个消费者各走一遍、
各拼一套文本键、各自定义过滤范围。审查稿把它量化：**3 套需求口径 · 10 处手拼文本键 ·
3 套金额口径 · 2 条取图链 · 9 个归色重算触发点**，并给出最小目标模型（加 4 列 + 3 条 SQL）与 P0/P1/P2 三期。

两条会直接算出错数的断言（各带真库取证）：需求按 `COUNT(*)`、已拿按 `SUM(qty)` ⇒ 一单多件时
`missing<=0` 会把该款色整行从缺口丢掉；需求侧 INNER JOIN ⇒ 51 行未发货里 9 行对缺口不可见，
而清单用 LEFT JOIN 能看见。**本轮不改代码**，待拍板 D1–D4。

> 说明：`docs/reviews/ORDER_PICKING_SIMPLIFY_2026-10-20.md`。

### Fixed · 改一次店铺平台，整店映射全废：身份改为「店铺 + 商品ID」

`pl_shop_sku.platform` 是写映射那一刻从店铺行抄下来的**副本**，却参与匹配键。于是「店铺登记」里
把平台下拉改一下（哪怕只是 `AE` → `ae`，`normPlatform` 不折叠大小写），该店所有订单都认不出款；
重新配一遍时四列键都不撞，会**新增一行**、旧行仍 `confirmed` 留成幽灵关联，而界面上完全没有提示。

- 身份改为 `(shop_id, item_id, spec)`：`shopSku.mappingKey(platform, shopId, itemId)` →
  **`bindingKey(shopId, itemId)`**（平台参数直接去掉，不给再传的机会）。
- 四处匹配一次改齐：`resolveOrderSku`（认款）、`shopSkuQueue` 的已关联集合、`resolveSkuBatch`、`upsertSkuMappings`
  （判重 + "改色=替换"的孪生行查找）。
- 平台改为**从店铺派生**：映射列表的 `platform` 列、`skuMapSummary.byPlatform`、列表关键字搜索都取店铺当前值；
  重配时顺手把副本刷新成当前值。
- 新增索引 `idx_pl_shop_sku_binding(shop_id, item_id, status)`（旧索引前缀是 `platform`，键去掉平台后会退化成扫表）。
- **无需迁移**：去掉条件只让命中变宽。真库取证 29/29 确认态映射仍命中，平台副本与店铺漂移 0 条
  ⇒ 新旧命中集合逐行相同。变异七组各只红目标断言。

### Fixed · 「44 单颜色未分类」：颜色一直在报表里，只是没人解析

真实库 51 单里 44 单挂在占位色「未分类」上 —— **不同颜色的订单在拣货单上长得一模一样**，
这是发错色的直接来源。追下去发现颜色的唯一来源是「订单图 → 采集 SKU 色图」，
而其中多数商品**从没被采集过**（`pl_shop_items` 里没有行），那条路恒空；可报表的「产品信息」
里一直写着 `(产品属性:Color:5,Size:5XL,Ships From:China Mainland)`。

补上归色的第四级 `parseOrderPropsColor`（`electron/aeMoney.ts`）：独立的「颜色」列优先，
否则取规格列里**所有** `Color:<值>`，按等值去重后**只剩一个才认**。真库分布正好卡在这条线上：
49 单唯一，2 单一单多色（同一张订单含 4 个 SKU 行、颜色 `10` 与 `6`）—— 那 2 单必须定不出来，
取第一个就是静默错色。

- 归色顺序变为：映射色 → 图片已有真实色 → 订单图反查采集色 → **报表规格串** → 已有平台色名 → `未分类`。
  规格串排在「按图」之后：图那条有采集快照作证据、同一份快照还能定克重 ⇒ 以前能定的行一个都不变。
- `insertOrder` 把平台色名写进 `oi_orders.color`（该列的既有语义），待补清单的
  「订单上的颜色：5 / 10」终于有值。
- **`rememberColorFromAssignment` 的原文补第二级**（采集色 ‖ 规格串色）：以前没有采集快照的商品，
  用户认一次色也记不下 ⇒ 下一批照样落 `5`，人工量不随时间递减。仍是外部事实，绝不取刚写下的
  `oi_orders.color`（先写订单再点名款 ⇒ 键与目标同值）。
- `order.main` **v5 迁移**：存量单只补**空值**（人工结论一行都不动），不碰 `raw_fields`/`updated_at`。
  真库克隆实测：回填 49 单 + 重放补上 32 行，未分类 **35 → 5**。

### Fixed · 映射指向已删产品：队列里「看起来已关联」，于是没有任何入口能修

回填后仍有 11 单认不出，真因是 **2 条映射指向已删除的产品 `9802`**（映射行不随产品删除消失）。
`resolveOrderSku` 把这种映射当未命中（不替人猜产品），但待关联队列与批量解析按映射表算「已关联」
⇒ 这些商品**连待办都不进**：用户看到"11 单认不出"，却没有一处能点。
两处映射集合改为 `JOIN pl_products`（只算产品还在的），与认款同一口径。
点一次名就能改对 —— `upsertSkuMappings` 本来就按 `(平台, 店铺, 商品ID, spec)` 整行替换。

> 说明：`docs/notes/2026-10-30-order-color-source.md`。

### Fixed · 「映射配了、订单还是没归上」：进页时自动重放，不留按钮

真实库 51 行订单里，9 行"没定款"中有 **6 行的商品ID 其实已经有确认映射**。根因不是认款逻辑，
而是**写映射的两条路径不对称**：人工核对（`assignOrderStyle`）会回填存量，而「建档与关联」里
配映射（`upsertSkuMappings`）**不回填**。于是"先导单、后配映射"的商品永远停在未归款，
且与"没配过映射"在界面上完全同形。

修法按"人工介入最少"原则做（没有加按钮）：`order-db.replaySkuMappings()` 全库套一遍已有映射，
在**取数之前**由「基础数据 › 待补清单」和「发货台 › 归类核对」进页时各调一次，
补了几行就在页头写一行"已按现有映射自动补了 N 行归属"。

四条边界：只碰未归款 / 占位色的行（挂在真实颜色上的**一律不动**）、`dryRun` 只报数不写库、
幂等（第二次 0 改动）、**自动修完必须说出来**（静默改库比不修更糟）。

> 踩坑：第一版把自愈挂在 `watch(token)` 上，冒烟实测一次进页被触发 **21 次**（保存/翻页都会 bump）。
> 已收敛成 `onMounted` 一次 —— 新订单落库时本来就走 `autoAssignByMap`，重放治的是历史漏网。
> 断言收紧成 `=== 1`，把"又挂回 token 上"变成会红的守卫。
>
> 说明：`docs/notes/2026-10-30-mapping-color-and-replay.md`。

### Added · 「基础数据 › 待补清单」：一屏看清资料还欠什么

三轮改码（商品ID 认店 / 订单图定色 / 克重去掉颜色条件）接通之后，剩下的问题不再是代码，
而是**数据还欠什么** —— 而它散在三个页面里，口径还各不相同：

| 缺口 | 原来要去的页面 |
| --- | --- |
| 订单没认款 / 颜色还是「未分类」 | 发货台 › 归类核对 |
| 认到的款在产品库里没有 / 尺码对不上 / SKU 没克重 | 基础数据 › 产品管理 |
| 款没填进价 | 基础数据 › 进价 |

现在它们是同一张单子上的六类检查，每类写清「不补会怎样 · 差在哪几行 · 去哪补」，按钮直接落到
能改它的那一屏（订单侧跳「归类核对」页签，货品侧跳「产品管理」，进价跳「进价」）。

- 入口：「基础数据」侧栏新增第四组「待补清单」（单页组，同「物流运费」，不画组内页签条）。
- 判定在 `src/lib/dataHealth.ts`（纯函数、15 例单测）；界面只取数 + 渲染 + 跳转。
- **三条规矩**：不新开口径（全走既有取数口，与各页数字同源）· 数字 = 明细累加（不另写 COUNT）·
  不跨类相加（单 / 个 SKU / 款 单位不同，页头只说"还欠几类"）。
- 细节：尺码比较过 `canonSizeKey`（`XXXL` 与 `3XL` 同码，但不动 `S/M/L/XS`）；归档变体不算"有这个码"；
  款不在产品库时不再重复计入尺码/克重；色名去重按等值（`K` 与 `Khaki` 互不为子串）。
- 顺带修：`TodayView` 原来**不消费**跨模块 action ⇒ 从别处跳「发货台」只停在「总览」。
  现在读 marker + 监听事件，`switchModule('today','classify')` 会落在「归类核对」页签。
- 顺带修：`store.loadPrefs` 的资料项白名单原是一条手写 if 长链，`shipping`（10-15 加的）一直漏着
  —— 用户最后停在「物流运费」，下次进模块被弹回「店铺账号」，不报错。现在白名单从
  `SHOP_ACCOUNTS_MAIN_TABS` 派生，类型也由它派生（加一项只改一处）。

说明：`docs/notes/2026-10-19-data-health-checklist.md`。

### Added · 核对时顺手认色名：`Khaki` 改一次，同款以后都叫「卡其」

平台侧的色是采集字符串（真库实测 `Khaki` / `Photo color` / `1`…`15`），款色要的是自家色名，
两者没有可计算的对应关系（数字色名连语义都没有）。此前唯一的办法是**每单都改一遍**：
改完只落在"这一行的颜色"上，下一单照旧 `Khaki`，人工量不随时间递减。

- 入口就在**本来就要做的动作**里：归类核对时把颜色改成自家名、点名款保存 ⇒ 这一对当场记进
  `oi_color_aliases`，toast 明说「已记住「Khaki」＝「卡其」，这款以后自动用这个名字」。
- 粒度 = **产品**（`pl_products.id`）：同款的多件商品与后续订单共享，不用一件件配；
  不同款互不影响（同一平台色名在不同款上可以是不同叫法）。比平台级安全、比商品级省工。
- 归色链路在落库前翻译 **③按图定色** 与 **④订单原文色**；**①映射色不翻译**（人填的已是自家名）。
- ②"已有真实色不动"多一个例外：挂在**已确认是平台色名**（字典里有这一对）的图要翻译，
  并顺带回填同一商品的历史订单（`reassignOrdersByItemIds` 新增 `colors` 选项）。
- 没配过对照的色名**原样落库** —— 不许因为查不到翻译就丢成 `未分类`（那会把"没配置"伪装成"没颜色"）。

说明：`docs/notes/2026-10-30-color-alias-and-merge.md`。

### Fixed · 「填了克重还是缺克重」：克重取数不再要求颜色对得上

两个独立的断点，都在真库上量过：① 订单上的色是**平台色名**（`7` / `Khaki` / `Photo color`），
产品库里是用户自己的色名（`黑色`/`白色`）——`skuWeightKey` 逐字节比 ⇒ 一条也命中不了；
② 产品 SKU 写 `3XL/4XL/5XL` 而同一批订单写 `XXXL` ⇒ 就算颜色对上也命中不了。
真库 51 单里精确命中只有 4 单，而 **83/83** 个「款×码」的各色克重完全一致（0 例各色不同重）。

- `canonSizeKey`：**只用于建查表键**的尺码归一（全角→半角、`XXL`→`2XL`、`XXXL`→`3XL`）；
  不碰 `S/M/L/XL/XS`（`XS≠S`），不猜 `均码`/`70B`。`skuWeightKey` 的码段改走它，建表与查表天然对称。
- `resolveWeightG` 两级：`款+色+码` → **`款+码`** → `null`。
- `buildSkuWeightIndex`（纯层，新增）：折叠键**只在"这款这码各色确实同重"时**产出 ——
  在售变体全部填了克重且值一致才写。没填 / 有不同重 → 不写，继续如实报「缺克重」。
  **少算（看得见、会去补）优于错算（发错货）**；无色行不建精确键、归档变体不参与折叠判定。
- 效果：真库 51 单有克重 **4 → 12**（折叠键 72 个）；剩余缺口全在"补数据 / 认款"侧。

说明：`docs/notes/2026-10-30-mapping-color-and-replay.md`。上游方案里「让用户**预先**给每个平台色
配一遍我的色名」**未采纳** —— 平台色名有半数是无语义数字（`1`…`15`），专门去配既无从猜起、
也是纯增负担。当晚补上的做法是"核对时顺手认一次"（见上一条 Added）：入口在本来就要做的动作里。

### Docs · 订单归款归色与克重取数简化方案（未实施）

新增 `docs/plans/ORDER_ATTRIBUTION_WEIGHT_PLAN.md`（并在 `docs/README.md` 文档地图登记）。
两个目标（订单定款定色 / 算钱定克重）的最小键都是「商品ID」，现状绑在「款×色×码」上：
运费必须等认款、认色、建变体、填克重全部完成才算得出来。方案给 P0–P4：

- **P0（阻断）**：`variantUpsert` 更新分支是全量 `UPDATE`（`product-db.ts:1796`），而建款向导
  重入只传 `color/size/weightG`（`useSkuPool.ts:1055`）⇒ **同一款被第二家店铺再走一次
  「建档并关联」会清空既有变体的 `code`、覆盖 `weight_g`**。改「未传即保留」。
- **P1** 克重新增第二级键 `(商品ID, 尺码)`：`resolveWeightG` 三级回落（款色码 → 商品ID+码 → null），
  运费不再被归款绑架；`manual` 不被 `snapshot` 覆盖。
- **P2** 单色商品自动定色（采集色集合恰 1 个 ⇒ 唯一解，不再落「未分类」）。
- **P3（可选）** 变体级对照 `(平台,店铺,商品ID,色,码) → variant_id`。
- **P4** 订单 `size` 落库前过 `normalizeSkuSize`（主进程侧，不跨层）。

含 DDL、读写口、迁移回滚、5 条变异清单、5 项待拍板。**未改任何代码。**

### Fixed · 整店采集没去重 + 商品全落「未关联店铺」（宿主与采集端 ae-profit 0.5.0）

用户口径一条：「现在采集没有去重，之前已经采集过40条数据了，剩余23条未采集，但本次采集
还是采集了所有数据，并出现在待关联采集商品中了，并且未关联店铺」。真库取证：九店
（`shop_id=6`）40 条 / 未登记桶 63 条，两桶 `item_id` **交集 40** 且两侧 SKU 与标题逐字相同。

- ⭐⭐ **跨轮去重的真源头是宿主库，不是扩展本地台账**。上一轮加的 `aeWalkSeen` 存在扩展
  `chrome.storage.local`，只认「这套扩展在这个浏览器采过的款」—— 旧版扩展采的历史、换浏览器、
  清扩展数据、换机器它统统不知道 ⇒ 升级后第一次点采集必然把已入库的款全重采一遍。
  新增只读端点 `GET /ae/shop-items/known`（`shop-item-db.listScrapedItemIds`）；
  扩展 `startWalk` 改为与本地台账**取并集**。两处纪律：匹配口径必须与 `upsertShopItems`
  **同源**（否则"问的时候算 A 店、写的时候算 B 桶"，去重静默失效）；该端点**刻意不套**
  ingest 的 60 次/分限速（大店铺批量采集时会被自家挤掉，而它恰好是"少采"的那一环）。
- ⭐ **清单只列「采到过 SKU 矩阵」的款**（`sku_json <> '[]'`）。采集分两层（列表轻采无 SKU /
  详情重采带矩阵），用户在列表阶段跑完就停，库里就有只有列表信息的行；把它们当"已采过"
  跳过，那些款**永远拿不到 SKU 矩阵**。「存在」≠「采到」。
- ⭐⭐ **收养是一次性的**：它只在 `shop-upsert`（保存店铺那一刻）跑一次。用户登记九店时把**店名**
  填进了「平台店铺ID」、URL 数字也填错（真 storeId 是 `1105668759`，填的是 `1105671703`）
  ⇒ `matchShopByStore` 三级证据此后恒落空 ⇒ 之后每次采集都落未登记桶，与已归店的行**并存成两行**。
  新增收养记忆表 `pl_shop_store_keys(store_key → shop_id)` 作**第 4 级匹配证据**
  （`JOIN sk_shops` 是防线：店删后记忆必须失效，否则写悬空 `shop_id` 认不了款）。
  记忆只在**用户已登记过该店**的前提下产生 ⇒ 仍不自动建店、不跨店乱挂。
- 存量修复：`shop-item.main` **v2** 迁移合并「未登记桶 × 已登记店」的同款重复行
  （空字段 ← 另一侧非空值、`scraped_at` 取较新者；先合并后删副本）；认不出的桶**一律不动**。
  ⚠️ 迁移体内不调 `ensureShopItemSchema`（它自己就跑 `migrate()` ⇒ 无限递归）；
  `sk_shops` 缺表按跨域纪律用 `tableExists` 降级，不抛 `no such table`。
- 采集端查不到已采清单时**不阻断采集**，但原因进台账并在 popup 明写「未向主程序核对已采清单
  ……可能重复采集」—— 否则用户只看到"又全采了一遍"，分不清是主程序没连上还是真有新货。
- 顺带修掉一条**一直红着的过期断言**：「同名不自动落库」与 2026-10-17 新增的第 3 级店名匹配
  直接矛盾，按当前口径重写为「店名全等且已登记 ⇒ 归该店」+「没登记过 ⇒ 仍落未登记桶」。
  两条迁移版本断言从 `=== 1` 改 `>= 1`（版本化追加，写死数字会每加一版假红）。
- 验证：采集端 `npm test` **29/29**（新增 5 条）；宿主 `shop-item:smoke` 全绿（新增 7 条）；
  变异复核扩展 5 条 + 宿主 7 条逐条打红。用户真实库已生效：九店 63 条、未登记桶 0 条、重复行消除。
- ⚠️ 建议用户把九店的**店铺地址/店铺ID 改对**（现在是店名与错数字）：记忆表是兜底，
  URL/ID 匹配才是正路。


### Fixed · 整店采集漏采与重复采集（采集端 ae-profit 0.4.0；宿主零改动）

用户口径两条：①「店铺有 63 件商品，只采集到 40 条」；②「第一次采了 20 条，第二次点采集会不会只采剩下的」。
修复全部在采集端（Chrome 扩展仓库 `SellerKitExtensions`），SellerKit 主程序**零代码改动**。

- **漏采真因**：换页成功的判据把分页器的 `currentpage/totalpage` 算进了列表签名。实测点页码后
  `currentpage` 约 800ms 内就翻到新页，而新一页的卡片此刻还没渲染（DOM 里 0 张）⇒ 在空列表上采集（0 条），
  随后被判「走完」并报告「全部完成」。改法：判据只看商品卡片（有卡片 + 卡片集合变了），
  并新增 `settleList()` 等卡片数稳定（列表分批渲染，第一次采到卡片可能只是半截）；
  翻页过去却一张卡都没采到时明说（`page-empty`），不再静默算完成。
- **停在第 N 页点采集**：先回列表第 1 页再扫（此前就地开跑 ⇒ 前面几页这轮不扫，静默漏发现新货）。
- **重复采集**：新增跨轮次去重台账 `aeWalkSeen`（按店存已采 SKU 的款），新一轮走位把它灌进台账 ⇒
  · 列表阶段照翻全部页（不翻就发现不了新货），但只推没采过的款；
  · SKU 阶段只走没采过的款 ⇒ 第二次点采集 = 只采剩下的。
  只有 `status==='done'` 才入台账（上次失败的款下一轮自动重采）；popup 新增
  「整店重采（忽略已采集）」与「清除本店采集记录」两个出口。
- 真机复核（店铺 `store/1105668759`）：修复前 40 条，修复后 **63 条**（帧 40 + 23，`failed=0`）；
  扩展回归 24/24，变异复核逐条打红。
- 生效方式：Chrome 直接从扩展仓库目录加载，改完在 `chrome://extensions` 点「重新加载」即可（无拷贝步骤）。


### Fixed · 提交拿货单后卡仍停在「待拿」：已拿读错了台账（2026-10-17 深夜）

用户口径：「已经提交了，状态还是在待拿，没有变更」。

- 根因（本机库实锤）：清单的"已拿"读的是 `purchase-outstanding`（**缺口**），而它末尾有
  `missing <= 0 就丢掉` —— **拿齐的那一行根本不返回**。实测：已提交单 #38 的 5 行明细与
  `SUST-006·未分类` 的需求**逐码相等** ⇒ 缺口 0 行 ⇒ 清单拿到的"已拿台账"里没有它
  ⇒ `remaining = pieces` ⇒ 卡永远停在待拿（拿得越多越看不见，逻辑正好反了）
- 修法：新增**已拿台账**通道 `purchase-taken`（`purchase-db.takenLedger()`：所有已提交拿货单
  明细 qty 合计，按款色码，**拿齐了照样在**）；`outstanding()` 内部的"已拿"改为复用同一条 SQL
  （口径只留一份，缺口与台账不会各算一次）；`PickingView` 的 `opts.taken` 改读台账
- 契约四处同步：handlers / preload / types（`TakenRow`）/ `core/services/ipc.ts`
- 守卫：`today-ui-smoke` 加**端到端**断言 —— 夹具给"缺口为空 + 台账三行全齐"的不对称样本，
  厂A 卡必须落进已拿区且不再有「生成拿货单」；双向断言（撤掉台账回待拿）。
  **变异验证**：把实现改回读缺口 ⇒ 两条立刻红（`pending 还在=true done=false`），还原后绿

### Changed · 卡尾三按钮一行摆放（2026-10-17 深夜）

用户口径：「复制拿货清单、复制清单图、生成拿货单（N 件）」三个按钮调整为同一行展示。

- 根因：宫格最小列宽 288 时卡内容盒只有 264px，三个按钮（~305px）必然折成两行
- `PickingView.vue`：`.pu-grid` 最小列宽 288 → **324**（留两位数件数余量；窄窗 ~500 可用宽度仍排一列不亏）；
  卡尾按钮水平内边距 8px → 6px（只收 `.pu-scard__acts` 这一处）；`flex-wrap` 保留作为三位数件数的兜底
- `today-ui-smoke.mjs`：`puTileGuard` 最小列宽判据 288 → 324，新增 **同行判据**（三个卡尾按钮
  offsetTop 相差 ≤2px，折行即红）；「厂家宫格在眼前」一条的文案同步

### Fixed · 「拿货」页顶距与「归类核对」对齐（2026-10-17 深夜）

用户口径：拿货页面离左上角的间距有点宽，请保持和归类核对页面一致；随后「拿货页面还是感觉很奇怪」。

- 根因（headless Chrome 几何取证）：`PickingView` 根节点挂着全局 `.wb-page`（自带 18/20/24 内边距），
  嵌进宿主 `.wb-page` 后四边全叠一遍 —— 顶 18+12、**左右 20+20=40px**、底 24+24；
  且宫格左缘（x=268）与宿主页级"已忽略"面板左缘（x=249）对不齐 —— "说不上来的怪"即来自这里
- `PickingView.vue`：`.pk-view.is-embedded` 内边距**四边归零**（独立页形态不受影响）；
  精简条白卡壳随之去掉 —— 左侧大片空白的空壳卡片是另一个怪点，退成无壳工具行（右对齐「导出带图 xlsx / 更多」）
- `today-ui-smoke.mjs`：布局守卫升级为 computed padding 四边全 0；
  临时探针（复用冒烟假桥 + `--screenshot` 截图 + getBoundingClientRect 几何 dump）已用毕删除

### Changed · 「拿货」页第四轮：撤页级概览文案，顶部条退成"新建空白单"工具行（2026-10-17 深夜）

用户口径：「待拿 7 款色 · 14 件 · 涉及 3 家 · 13 单 · 上次拿货 —」这一条删掉，页面样式相应调整。

- `PurchasePanel.vue`：删掉 `pu-overview` 概览文案与 `overviewMeta` / `lastPickLabel` 两个 computed
  —— 数字口径仍在卡面合计行与「生成拿货单（N 件）」按钮上（同一函数 `pendingRollup`），页级不再重复一份
- `.pu-bar` 从白卡（边框/阴影/内边距）退成无壳工具行，只剩"读取中…"与新建空白单（选厂家 + 明细/包价）
- `today-ui-smoke.mjs`：三处锚在 `pu-overview` 上的断言改锚 ——
  同屏断言改钉 `pu-bar`；概览数字断言改成**负向断言**（`!card('pu-overview')`，撤了就是撤了，回来就红）；
  拖拽净效果改钉宫格本身（未指定厂家清空后整卡消失）；"数据回来"判据改钉动作条 + 三款色行

### Changed · 「拿货」页第五轮：撤「缺：…」缺口行、口径说明行与「新建空白单」整块（2026-10-17 深夜）

用户口径：「缺：缺件数 2 / 未发货 · 近 30 天 · 超窗剔除 25 行 / 选择厂家… / 新建明细单 / 新建包价单」也去掉。

- `PickingView.vue`（精简条 `pk-bar`）：删「缺：…」缺口汇总（`gapsText`）与「未发货 · 近 30 天 ·
  超窗剔除…」口径说明（`scopeDays`）—— 空态的"为什么空 + 调天数窗"仍由 `emptyReason` 在清单区说清
  （口径解释跟着空态走，不常驻占一行）；条上只剩"正在汇总…"与右侧「导出带图 xlsx / 更多」
- `PurchasePanel.vue`：**「新建空白单」整块撤掉**（选择厂家下拉 / 新建明细单 / 新建包价单 +
  `createEmpty` / `newSupplierId` / 随之空转的 `watch` 与 `busyAll`）—— 开单入口唯一 =
  厂家卡上的「生成拿货单（N 件）」；页级只剩"读取中…"一行
- `today-ui-smoke.mjs`：同屏断言改钉 `pk-bar` + `pu-grid`；新增负向断言
  （概览 / 厂家下拉 / 两个新建按钮回来就红）；"厂家不预选 / 禁用 / 解禁"三条随功能退役；
  天数窗改 60/30 的重算断言改钉 `pickingRows` 再次被调（天数是清单层应用的，不入 IPC 入参）

### Changed · 「拿货」页第三轮收敛：撤「按订单」页签、三区并成一种卡、款色行与发厂清单瘦身（2026-10-17 晚）

用户口径：①「合并后为什么还有按订单和按厂家的 tab？不是应该都在同一个页面操作吗？」
②「拿货页面三个区域看起来很不协调，是否可以合并？」
③「卡片信息太局促：只展示对拿货有用的信息（SKU 图 / 颜色 / 尺码 / 件数）；款编码是内部使用的，
不在卡片、清单图和文字清单里出现」
④「已开单和复制拿货清单 / 复制清单图 / 生成拿货单按钮固定在卡片底部」。

**① 「按订单」页签整条撤掉**
- 每张拿货单本来就在厂家卡的"已开单"行上（同一套 `data-act="pu-*-${单号}"`：查看/提交/导出/删除），
  拿货单宫格视图是纯重复；它唯一独有的**新建空白单**（选厂家 + 明细/包价）收进顶部概览条右侧
- 单子管理从此只有一个入口：厂家卡（待拿卡"已开单"区 / 已拿瘦卡的单子行）；
  "新单入册"不再靠切视图查看 —— 提交/导出/删除就在同一张卡上
- 概览条数字口径不变（待拿 N 款色 · N 件 · 涉及 N 家 · N 单 · 上次拿货 X）

**② 三区（待拿宫格卡 / 暂不拿灰条 / 已拿折叠列表）→ 单宫格一种卡**
- 同一外壳（边框/圆角/阴影），靠状态签与高矮区分：待拿全卡在前，暂不拿 / 已拿收成瘦卡随后，
  不再有分区标题 —— 顺序即分区（`data-zone` 序 pending → pending → skip → done 由冒烟钉死）
- 已拿卡不再默认折叠：单子行（含完整四动作）直接排在卡上，"拿完的事"安静待在页尾但不消失；
  拖拽改厂家的落点三态照旧（pending / skip / done 卡都是合法落点）

**③ 款色行瘦身：一行读完"拿什么"**
- 行上只留 **SKU 图 + 款名·颜色 + 尺码×件数角标 + 还差件数 + 忽略**；
  款编码降为内部身份（`data-key` 仍在，供拖拽/断言定位）—— 界面上不再展示；
  行内预估金额 / 缺口标签（缺图/缺供应商/无进价）/「涉及 N 个订单」展开全部撤掉
  （预估只在卡底合计行报价；缺图由占位框承担；订单号聚合层本来就不保留"每单几件"）
- **发厂清单同步去款编码**（`pickingSheet.ts`）：`SheetLine` 新增对外展示名 `label`
  （`款名 · 颜色`，缺款名只写颜色；`key` 保留为内部身份/排序），清单图与文字清单一律走 `label`
  —— 复制出去的图与文字里不再出现内部款编码；金额/单价照发（厂家照它报价）
- 导出带图 xlsx 不动：那是内部作业表（按码列 + 缺口列），款编码照旧

**④ 卡底动作吸底**
- 待拿卡把「已开单」区 + 复制拿货清单 / 复制清单图 / 生成拿货单收进 `.pu-scard__bottom`
  （`margin-top:auto`）：宫格里各卡行数不同，底部动作永远贴卡下缘、横向对齐

**契约修补**：上一轮拖拽通道 `product-move-supplier` 漏了契约② —— `productMoveSupplier`
补进 `src/types.ts` 的 `ElectronAPI`（`ProductMoveSupplierInput`；verify 由 198/199 恢复 199/199）。

**守卫**（`today:ui` 与 `pickingSheet` 单测同步翻面）：
- 冒烟：宫格排序 `data-zone` 序钉死 / 行上反向守卫（无款编码、无金额、无缺口标签）/
  文字清单全文不含 `S1`/`S3` / 吸底几何守卫（底块下缘与卡下缘差 ≤ 2px）/
  新单四动作同卡可管 /「按订单」页签反向守卫（`!card('pu-sub')`）
- 删除随视图消失的断言：拿货单宫格逐格对 / 宫格并排几何 / `pu-orders-meta` /
  已拿折叠 toggle 双向 /「涉及 N 个订单」展开 / 拿货单空态（有「新建空白单」兜底）
- `pickingSheet.spec.ts`：文字清单期望改「款名 · 颜色：尺码×件数」；新增 label 反款编码断言；
  `uxEntryNames`：撤「按订单」豁免（文案再写它就是悬空名，应当直接红）

### Changed · 「拿货 › 拿了什么」重做成拿货单宫格：表格 → 卡片网格（2026-10-17）

用户口径：「将发货台-拿货页面重新设计，修改成宫格样式」。

**① 视图 B「拿了什么」：六列表格 → 一张卡 = 一张拿货单**
- 表格六列（# / 日期 / 厂家 / 金额 / 状态 / 操作）在拿货面板的可用宽度下要么横滚要么被裁，
  且"这一张单什么情况"要横着读完整行才拼得出来。宫格把每张单收成一张自明的卡：
  **身份**（单号 + 状态签）→ **归属**（厂家 + 模式签）→ **钱与日子**（日期 + 金额）→ **动作**
  （查看/编辑 · 提交 · 导出 · 删除，四个文字按钮，不做无标注图标）
- 草稿卡左侧一条**警告色竖线**（与状态签同色系）：宫格扫一眼就把"还等着处理的几张"摘出来；
  已提交卡无竖线，安静排在旁边。金额是卡面视觉锚点（17px + 等宽数字）
- 列的语义一个没少（单号 / 日期 / 厂家+模式 / 金额 / 状态 / 四动作），只是换了铺法；
  `data-act="pu-*-${o.id}"` 逐卡带单号，同页多卡不会串；容器锚点随形态改名
  `pu-order-table` → `pu-order-grid`（冒烟 / 截图脚本同步改，文字断言一条没删）

**② 修掉一个同形态的静默压扁（宫格的立身之本）**
- 取证：756×469 窄窗（侧栏 208）下，`.wb-panel` 的 `overflow:hidden` 把弹性列里的自动最小尺寸
  归零 ⇒ 整块面板被压成一条 37px 的缝，卡面内容全裁在里面（DOM 还在、点不到）——
  与拣货视图 `pk-sum` 2026-10-10 那次"按钮跟页签走"同一根因
- 修法：`.pu-view > .wb-panel { flex-shrink: 0 }`（拿货单宫格与已忽略折叠面板都吃这条）——
  装不下就溢出 `.pu-view` 去滚，那才是本来的设计
- 栅格最小列宽取 **200**（款色卡是 224）：窄窗可用宽度只剩 ~440 时 224 只能排一列、
  200 仍能并排两列 —— 宫格的"并排"是形态本身，塌成一列就等于退回竖排

**守卫**（`today:ui` 257 → **258**，+1：宫格布局守卫一条，内含三个判据）
- 原有文字断言全部保留并改挂新锚点：切视图换内容 / 两张单的厂家·状态·金额逐格对 /
  「备注」零消费者字段不再出现 / 只有草稿给「提交」
- 新增**宫格布局守卫**（表格换宫格后旧形态判据全部翻面，按几何钉新形态）：
  ① 前两张卡**同一行左右并列**（改成竖排会红）② 每张卡 `scrollHeight == clientHeight`
  （被弹性列压扁会红）③ 行内动作滚到眼前后在视口内且 `elementFromPoint` 命中
  （被别的元素盖住会红）
- **变异验证**：拿掉 `flex-shrink:0` ⇒ `clipped=true` + 按钮出视野，红；
  `display:grid` 改 `block` ⇒ `side=false`，红（各只红这一条，其余不受）

**验证**：`vue-tsc` / `build` 绿；`today:ui` **258 PASS 全绿**（含 1440×900 取证截图
`purchase:shot` 六张：宫格列表 / 编辑器开合 / 多行明细 / 包价单）；`vitest` 40 文件 / 741 用例全绿。

### Changed · 「成本」页：页签改名 + 款级进价列表加图片列、去生效日/来源列（2026-10-17 深夜）

用户口径：「成本与费率修改为成本，其中款级进价列表增加图片，去除生效日、来源展示，要注意样式」。

**① 页签改名**：「成本与费率」→「成本」（只动呈现层）
- `MasterDataView.vue` 的 `KINDS`：`cost` 的页签名改「成本」；`store.mainTab` 的七个值与
  跨模块 action 的字符串协议**一个没改** ⇒ 老用户偏好、算钱页的「去维护」全部照旧
- 全部用户可见引用同步改名（`order-cost` 的数据基础区三处提示文案）；`uxEntryNames` 的
  豁免键 `成本与费率` → `成本`（旧名再出现就是悬空入口名，直接红）

**② 款级进价列表改版**（`CostPane.vue` 主表）
- 新增**图片列**：款主图缩略图（40×40，复用全局 `.wb-thumb`），数据走
  `ipc.orderImageThumbBatch`（core 里带 40 一批拆批的那个包装 —— 主进程硬截断 40，
  不拆批第 41 张起静默变空占位）；只给**表里有的款**取图（产品库可能上万款）；
  无图/取图失败渲染空占位（图是"帮你认款"，不是"能不能看表"的前提）
- 去掉「来源」「生效日」两列：它们回答"这条价怎么来的 / 从哪天起"，属**历史细节** ——
  展开区（生效区间）里有全的，且那边生效日是行主键、来源决定能否删，一动就不能读了
- 样式：图列给定宽 62px（`table-layout:auto` 下不给地板会被宽图撑着走、款名弹性列让位，
  而列宽选择器都写在 td/th 上，撑开是静默的）；图与空占位两条居中路径都给
  （img 是 block 吃 margin:auto、占位 span 是 inline-block 只认 text-align）
- 主表 8 列 → 7 列，展开行 / 空态行 colspan 同步 8 → 7

**守卫**（旧冒烟全绿也盖不住的部分）
- `master-data:ui`：`cost-source` 锚点随列撤掉（锚点是给列用的，列没了锚点也没了 ——
  只删列不删断言的话按旧名定位会**静默点空**）；新增「主表不再有来源/生效日两列」
  「主表七列」「S1 渲染出主图缩略图」「取图只问表里有的款」「空态行 colspan 与列数一致」
  五条；夹具加 S3（有图、无成本）—— 没有这个样本，"遍历整个产品库取图"的实现照样能绿
- `shopAccountsIntake`：新增结构回归例（主表 thead 有图列、无两列；明细表两列都保留；
  colspan 与列数一致；缩略图走拆批包装）—— 防的是"改错了表"（明细表嵌在主表 tbody 里，
  正则必须按各自的 thead 切）
- 变异验证：取图改成遍历全库 ⇒ 正好「取图只问表里有的款」红；图永不渲染 ⇒ 正好
  「S1 渲染出主图缩略图」红（各 88 PASS / 1 FAIL，其余不受）

**踩坑**：注入脚本（模板串）里写正则 `/^data:image\//` 判前缀 —— `\/` 被求值成 `/`，
浏览器拿到 `/^data:image//` **语法错，整段断言脚本都不跑**（`node --check` 查的是外层文件，
查不出来；现象是"没抓到 #smoke-result"）。改判据用 `indexOf(...) === 0`。
教训与反引号同族：**模板串里的转义会被求值**，判据只能实跑。

**验证**：`vue-tsc` / `build` 绿；`master-data:ui` **89 PASS**（宽 85 + 窄 4，+5）、
`goods:ui` 338 / `shipping-rate:ui` 44 / `order-profit:ui` 91 / `today:ui` 257 全 PASS。

### Fixed · 组内页签切不动：「店铺账号 / 货品档案」第一页点不了（2026-10-17 当晚）

用户口径：「店铺账号和货品档案中切换 tab 不正常」。

根因是**组 id 与 kind id 两个字面量撞车**：组 `accounts` ⇄ kind `accounts`、组 `goods` ⇄ kind
`goods`。收拢时的 `selectKind()` 一个函数先查组表再接 kind 表，于是在组内点**第一页页签**
（「账号库」/「建档与关联」）被解释成"点组名"，命中"已在这组"的早退 ⇒ 页面什么都不发生
（无报错、无变化）。物流运费组只有一页、没有页签条，所以看不出来。

- `MasterDataView.vue`：入口按**来源**拆成两个函数 —— 侧栏传组 id 走 `selectGroup()`
  （已在这组时保持当前页），组内页签传 kind id 走 `selectKind()`（只认 kind，体内不出现 GROUPS）。
  `applySwitchAction`（跨模块 action 两种 id 都可能）改为先按 kind 解、落空再按组解
  （`accounts`/`goods` 两种解释同页，解析顺序不影响任何现有跳转）
- 守卫：`shopAccountsIntake` 新增回归例（页签走 selectKind 且其体内无 GROUPS、侧栏走
  selectGroup、action 先 kind 后组）；`master-data:ui` 新增两条**单独走页签**的断言
  （停在「企业」点「账号库」、停在「成本与费率」点「建档与关联」）—— `gotoKind` 的
  两步走法（先点侧栏组）恰好绕开这条路径，所以旧冒烟全绿也盖不住这个 bug
- 变异验证：把 `selectKind` 改回双 id 逻辑后，**正好**这两条新断言变红（82 PASS → 2 FAIL），
  其余不受影响 ⇒ 守卫非空转

**验证**：`vue-tsc` / `build` 绿；`master-data:ui` **84 PASS**（82 + 2 新回归）、
`goods:ui` 338 / `shipping-rate:ui` 44 / `order-profit:ui` 91 / `today:ui` 257 全 PASS。

### Changed · 「基础数据」二级菜单再收拢：七项并列 → 三组 + 组内页签（2026-10-17）

用户口径：「① 店铺登记、企业收拢到店铺账号中；② 成本与费率、供应商收拢到货品档案中」。

侧栏二级菜单从**七个并列项**收到**三项**，项内的资料页由内容区顶部一条页签条切换：

| 侧栏（组） | 组内页签（资料页）                     | `data-act`                        |
| ---------- | -------------------------------------- | --------------------------------- |
| 店铺账号   | 账号库 / 店铺登记 / 企业               | 组 `kind-accounts`、页 `kind-tab-*` |
| 货品档案   | 建档与关联 / 成本与费率 / 供应商       | 组 `kind-goods`、页 `kind-tab-*`    |
| 物流运费   | （单页，不画页签条）                   | 组 `kind-shipping`                  |

- `MasterDataView.vue`：新增 `GROUPS`（组 → 资料页），侧栏上报改报三组、`activeId` 报**组**；
  组内页签条只在「这一组多于一项」时渲染。组上只挂**一个**徽标，规则：组内有待办（未归一店名 /
  缺进价）就用待办色报那个数，否则报该类总数（仅店铺账号），读不到就不画 —— 不做"各项相加"（没有含义）
- `selectKind()` 两种 id 都认：组 id（侧栏点的）与 kind id（页签 / `switch-module` 的 action 传的）；
  **已在这一组里时点组名是 no-op**（用户点它只是想确认"我在这组"，不该被弹回第一页）
- 七个 kind id 与 `store.mainTab` 的持久化值**一个没改** ⇒ 老用户偏好、跨模块 action
  （`registry` / `cost` / `suppliers` …）全部照旧，无需迁移
- `GoodsView.vue` 新增 `hideTabs`：内嵌时页签条交给外层画（只在自己只有一条页签时才允许隐藏，
  否则 `GOODS_LAYOUT` 回退成 `'tabs'` 时会把产品表与映射队列的入口藏掉）
- 守卫同批翻面：`shopAccountsIntake` 改断「items 由 GROUPS 派生」+ 新增「三组把七类资料一个不漏装进去」
  （漏一项 = 那一页没有入口，且不报任何错）；`master-data:ui` / `goods:ui` / `shipping-rate:ui` /
  `order-profit:ui` 的锚点从 `kind-<kindId>` 改为 `kind-tab-<kindId>`，并新增「四个被收拢的项不再并列
  在侧栏」「组内页签只有当前组那几项」等反向断言（只验"三组在"，组里没画页签照样能绿）

**验证**：`vue-tsc` / `verify` / `build` 绿；`master-data:ui` **82 PASS**（宽 78 + 窄 4）、
`goods:ui`（338 PASS）/ `shipping-rate:ui` / `order-profit:ui` / `today:ui` 全 PASS；`vitest` 739/739。
取证与踩坑见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`。

### Changed · 侧栏二级菜单能点收起；「基础数据 › 设置」那一行去掉（2026-10-17）

用户口径：「现在点击基础数据没法收起二级菜单，二级菜单中的设置去掉」。

**收起**：展开态原来只由"是否在这个模块里"决定（`activeId === 模块 id`），而点自己那次
`activate` 会被 `activateCore` 的**同模块早退**吞掉 ⇒ 除了切走，没有任何办法把那一串缩进项收起来，
它们常驻占约 8×36 = 288px。补法：给渲染判据加第三个条件（`subCollapsedFor`，只记一个模块 id、**不持久化**），
点已在前台且有二级菜单的一级项 = 收起/展开，切到别的模块时清掉。

- `AppShell.vue`：`navRows` 的展开判据 = 前台 + 侧栏展开 + 没被手动收起；一级行点击改走
  `onModuleRow()`（同模块切换折叠，其余才 `activate`）；箭头旋转与 `aria-expanded` 只认 `row.subExpanded`；
  一级行补 `data-act="nav-<id>"`（冒烟要能点它，二级项的 `kind-<id>` 锚点未动）
- 不持久化的理由：收起是一次**临时视图动作**。记住"基础数据默认收起"会让用户下次点进来看到空菜单，
  与上一轮选定的"点进去才展开"正好相反，且箭头折着、没有任何提示

**去掉「设置」行**：二级菜单第 8 行「设置」（打开宿主设置中心 `shop-accounts:settings`）按用户口径删除 ——
它不是第八类资料，混在资料项里像个页面。安全设置仍在**设置中心**（侧栏底部齿轮 →「基础数据」分类）。
连带删掉 `SubNavState.settings` 这个通用口（唯一消费者就是它；留着是无人使用的分支）、
`MasterDataView` 的 `openHostSettings` 与 `openSettings` / `toast` 导入。

- 验证：`master-data:ui` **79 PASS**（宽 75 + 窄 4；新增「设置行没有回来」「一级项可点」
  「点一次收起：七项消失 + aria-expanded=false」「再点一次展开」四条，双向验；
  只验收起的话"关了打不开"照样绿）；
  `vitest` 738/738（`shopAccountsIntake` 的"两处 id 一致"改为"设置 id 只有 settings.ts 一个来源"，
  另加一条"收起判据必须挂在渲染条件上"——只转箭头、那七行照旧占高度的实现能骗过任何只查 aria-expanded 的断言）

### Changed · 「基础数据」的七项资料从页面内左导航搬到**主侧栏的二级菜单**（2026-10-17）

用户口径：「基础数据中的左边区域可以放到工作台中基础数据的二级菜单中吗？」——可以。侧栏本来就有
"分组 + 缩进子项"的机制（`src/core/nav.ts` + `AppShell.vue` 的 `navRows`），只是从没用于
"一个模块内部的几个面"（既有的分组收的是**模块**）。

**动机是一个宽度账**：那条 200px 左导航是**从内容区里扣的**，加栏间距共 212px。默认 1200 窗口下
「货品档案」的可用宽度只剩 744px，而两栏工作台的下限之和是 836px——同一天上午并进「基础数据」时
的代价就是被迫把断点抬到 1280、**默认窗口变成堆叠形态**（见上一节）。侧栏那 208px 是已经付过的
宽度，七个面挪进去等于免费。

**做法**：新增 `src/core/services/subNav.ts`——模块**运行时上报**自己的二级项
（`items` / `activeId` 是 getter 不是快照：徽标数是算出来的实时值，传快照会变成"进页面那一瞬"的僵值）。
`ModuleMeta` 只加一个布尔 `subNav`（模块还没打开过时侧栏也画得出展开箭头），内容不复制。
侧栏只在「该模块处于前台 + 侧栏展开」时渲染子项，即"点进去才展开、切走自动收起"。

- `MasterDataView` 删掉整块 `.md-nav`（七项 + 设置 + 200px 两栏容器 + 只为它存在的样式），
  改为 `onMounted` 上报七项与设置回调；内容区吃满宽度
- 侧栏子项的 `data-act` **沿用 `kind-<id>`**（锚点名不变，三个冒烟脚本与单测都钉在它上面）；
  激活态从 `.is-active` 类改为语义属性 `aria-current="page"`
- 两栏断点 **1280 → 1180**（可用宽度回到 956 ⇒ 左 420 / 右 520），
  `goods:ui` 默认窗口那遍的布局断言随之**翻面**（"上下堆叠" → "并排"）
- ⚠️ 必须一起改的一处：`ModuleMeta.subNav` 要穿过 `managerDiscover` → `ViewContribSpec` →
  `metasFromContributions` 的**两层字面量白名单**。少抄一处，字段在到达侧栏之前静默消失，
  TypeScript 一句话都不报（表现为"二级菜单怎么都不出现"）。已加单测钉住这两行
- 验证：`master-data:ui` 75、`goods:ui` 三遍 ALL PASS（含"并排"翻面断言）、
  `vitest` 737/737（新增 2 条 subNav 守卫：上报齐不齐、过路字段丢不丢）


### Changed · 左导航去掉「拣货」一项（2026-10-17）

用户口径：「把拣货菜单去掉」。不是砍功能 —— 同一份清单早就是「今天 › 拿货 › 要拿什么」的入口视图
（`PickingView` 以 `embedded` 复用了半年，见 `docs/notes/2026-10-30-picking-and-takeout.md`），
左导航那一项是**第二条**入口，与"入口唯一"冲突。删完后功能面零缩减（导出 / 更多〔天数窗 · 店铺 ·
含已发货〕内嵌时本就挂在精简条上，取数、忽略、开单一条没少）。

- **形态**：`modules.config.json` 的 `profiles.standard/pro` 与 `enabledModules` 各去掉 `picking`
  ⇒ 构建期不注册、不进包、侧边栏与 ⌘K 都不出现。`src/modules/picking/{meta,index}.ts` 删除
  （与「货与成本」同一种退出方式：**留视图、删模块壳**），`PickingView.vue` 原样留在
  `src/modules/picking/PickingView.vue` 供 `PurchasePanel` 复用。
- **连带资产**：`scripts/picking-ui-smoke.mjs` 与 `npm run picking:ui` **退役**（它的宿主页没了）。
  但**不是删断言了事**：真生成在主进程、渲染层只传"算好的行"的那条链（`pickingExportExcel` 出参、
  图已转 JPEG、无价行金额传 `null`）和「只改天数窗不点按钮也重算」两条**搬进了 `today:ui`** ——
  入口还在（内嵌精简条上），守卫就得跟着入口走，否则"点了导出没反应"从此没人抓。
  `picking:smoke`（`electron/picking-db.ts` 的投影冒烟）与 `picking:xlsx:smoke`（主进程画表）
  **不受影响，照跑**。
- **导航实况**：`今天 / 基础数据 / 邮件 / 统计 / 便签`（原「拣货」在第 5 位，便签顺移到第 5）。
- **验证**：`vue-tsc` / `tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `build` /
  全量 `vitest` / `today:ui` 全绿（`today:ui` 本轮 +5：导出与天数窗那两条搬进来）。
  取证与"哪些东西看着像死代码但必须留着"的清单见 `docs/notes/2026-10-30-picking-and-takeout.md`。

### Changed · 「邮件」独立成一级菜单；「货与成本」并进「基础数据」成「货品档案」（2026-10-17）

用户口径：「邮件功能独立出来，放在一级菜单。货与成本归拢到基础数据中」。
两处形态按用户选择落地：**左导航加一项「货品档案」**（不是新页面）+ **设置中心新增「邮件」分类**。

- **分界线是"动作的种类"，不是"功能的大小"**：基础数据整合的判据一直是「维护一份资料」。
  读信不是资料（未读每天要看、有同步/检索/附件自己的动线）⇒ **搬出去**；款 / 采集商品 /
  映射 / 成本表是资料本身 ⇒ **搬进来**。一句话：进基础数据的是"我维护的东西"，留在外面的是"我做的动作"。
- **新模块 `mail`**（`src/modules/mail/`，`name: '邮件'`、`icon: 'inbox'`、`order: 3`）：
  `MailView` 只做页头（未读数）+ `MailInboxView`。**`MailAccessDrawer` 留在基础数据** ——
  它的触发点是账号行（「接入邮箱」），是**账号的属性**而不是收件箱的属性。
- **设置跟模块走**：设置分类 `shop-accounts:settings` 的「邮件收件箱」页签搬成新的 `mail:settings`，
  `shop-accounts:settings` 只剩「安全设置」。顺带修掉一个既有 bug：收件箱里那个齿轮原来手写
  `CustomEvent('open-settings', { detail: { category: 'shop-accounts' } })`，而 `SettingsModal`
  按 **categoryId 全串**（`shop-accounts:settings`）匹配 ⇒ **点了其实什么都没发生**；改用
  `openSettings('mail:settings', 'inbox')`。
- **存储命名空间刻意不动**：`defineStore('shop-accounts-mail')` 与 `useModuleStorage` 的
  命名空间**一个字母没改** —— 它们是已落盘的用户数据键（邮箱账号 / 同步游标 / 附件索引），
  改 id 等于让老用户的收件箱"变空"。先例同 `order-insight`。
- **「货与成本」不再是模块**：`src/modules/goods/{meta,index}.ts` 删除，`GoodsView` 以
  `embedded` 形态渲染成「基础数据」左导航第二项（内部页签 / 工具栏 / 帮助 / 简洁模式一字不动，
  只去掉 h1）。`modules.config.json` 的 profiles 与 `enabledModules` 换成
  `today / shop-accounts / mail / order-cost / picking / quick-note`。
- **"只说模块 id"会把用户丢在上次停留的那一类资料上**：`shop-accounts` 有七类资料，于是
  `ImportNextStep` 新增 `action`，`openModule(moduleId, action)` 一起带；`data-act` 仍由
  `import-next-${tab || action || moduleId}` 生成 ⇒ 锚点名 `import-next-goods` **没变**，
  尽管 `moduleId` 从 `goods` 变成 `shop-accounts`（刻意的：断言按锚点挂，不按 moduleId 挂）。
- **嵌入有宽度代价 ⇒ 两栏断点 1180 → 1280**：左导航 200 + 页内边距 36 + 栏间距 12 = **248px**
  不再属于这一页，默认 1200 窗口的可用宽度从 1200 掉到 **736**，而两栏下限之和是
  420 + 400 + 16 = **836**。硬排的后果（实测）：右栏只剩 300px、队列「商品ID」列被挤到 **42px**、
  行高 **234px**、图列被顶出视口。抬断点后**默认窗口落在断点下方**，堆叠成了主形态，这条写进了
  `GoodsWorkbenchView.vue` 与本页冒烟断言（不是"窄窗口专属"了）。
- **验证**：`goods:ui` 三遍（1440 / 1200 / 900）ALL PASS，其中 reach 那一遍的判据改成
  "**用户能滚到它、滚到之后点到的就是它**"（只滚 `overflow: auto/scroll` 的祖先，
  `overflow: hidden` 一律不替它滚 —— 被容器静默裁掉仍会红），并新增三条几何断言
  （堆叠、`商品ID` 列 ≥ 120px、行高 ≤ 120px）。变异取证：断点改回 1024 后三条同时红，
  而同一次变异里「缩略图可达」是**绿的** —— 这正是判据放宽一档的代价，几何断言是唯一还抓得住的地方。
  `master-data:ui`（七项 + 无 `kind-mail` + 邮件未读在邮件页头）/ `today:ui` / `picking:ui` /
  `order-profit:ui` / `shipping-rate:ui` 全绿；`vue-tsc` / `tsc -p tsconfig.electron.json` /
  `verify` / `verify:docs` / 全量 `vitest` 全绿。坑与取证见
  `docs/notes/2026-10-30-goods-ux-refactor.md`。

### Changed · 发货台去掉「算钱」这一步（五步 → 四步）；「算钱」菜单改名「统计」（2026-10-17）

用户口径：「发货台中的算钱步骤去掉，还是都归拢到算钱菜单中，算钱菜单修改成统计」。

- **发货台只管"做"，「统计」只管"看钱"**：页签 6 → 5（总览 + 导入订单 / 归类核对 / 拿货 / 结算对账），
  流程卡 5 → 4 步，拿货由第 4 步顺位成**第 3 步**、结算对账由第 5 步成**第 4 步**。
  **判据**：算钱**不写任何数据**、也不是发货的必经动作（一辈子不看利润也照常发货），却占着流程卡一个节点 ——
  "当前该做哪一步"的推导里永远挂着一个不动的位置（`flowNow` 找不到 `now` 时落到它身上）。撤掉后 `now` 恒为 1。
- **改名只动 `name`，`id` 仍是 `order-cost`**（`src/modules/order-cost/meta.ts`）：id 是
  `modules.config.json` 配置、`switchModule`、`data-act`、文档路径的锚，`name` 才是显示名 —— 于是用户配置零迁移。
  叫「统计」而不是「算钱」的理由：这一面答的不只是"这批订单赚不赚"，还有分组统计（款/店铺/来源）、
  时间趋势、缺项体检，叫「算钱」会把那一半藏起来。
- **一个入口、一个口径**：`OrderCostView.vue` 的**内嵌形态整套删除**（`embedded` / `refreshToken` / `importDate`
  三个 prop、页内刷新按钮、「今天导入」范围标）。原来"内嵌只算今天导入的那批 / 独立看全库"是同页两个口径，
  撤掉页签后没有存在必要。利润口径仍只在 `src/lib/orderCost.ts` 一处算。
- **回执里的落点从"切页签"改成"跳模块"**（`src/core/services/importSheet.ts`）：原来
  `{ label: '去「算钱」归店铺', tab: 'cost' }` 的 `tab` 语义是**就地切页签**，页签删掉后 `go('cost')` 只会把
  `tab.value` 设成一个不存在的 id，界面**静默回落到总览**（`activeComp` 的 `?? TABS[0]` 兜底）——
  比报错更难查。三处（归店铺 / 看毛利 / 核对运价表）一律改 `moduleId: 'order-cost'`，
  `data-act` 随之从 `import-next-cost` 变成 `import-next-order-cost`。
- **汇总卡与归类空态的出口改真跳转**：「看订单与利润」「看缺在哪」「去「统计」看利润」原来都是 `go('cost')`
  就地切页签，现在都是 `switchModule('order-cost')`。
- **`FlowStep.state` 的 `gap` 态淘汰**（`'done' | 'now' | 'todo'` 三态）：它唯一的产生者就是算钱步。
  页签名表 `SHIPPING_TAB_NAMES` 同步删 `cost`。
- **验证**：`today:ui` **250 PASS / ALL PASS**，其中新增的反向守卫：`tab-cost` 与 `.oc-view` 都不在本页、
  `flow-cost` 卡不存在、回执里不再有 `import-next-cost`、归类首个出口是"真跳模块"（等目标页 `.oc-view` 挂上）；
  `uxEntryNames.spec.ts` 加两条反向断言（页签名不含「算钱」、宿主模块名含「统计」）；
  `vue-tsc` / `tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `build` / 全量 `vitest` 全绿。
  坑与取证见 `docs/notes/2026-10-30-shipping-desk-and-rate.md`。
- **未发版**：`ui-plugins/ae-profit` 岛内 tip-card 的文案跟着改成「统计」（并补上"成本表与汇率维护已搬到基础数据"），
  但**没有重发版** —— 已装旧岛的机器上仍显示「算钱」。`manifest.json` 的 `description` 故意没动
  （同版本改内容会被发布口判成硬错误）。

### Changed · 「修改 SKU 矩阵」规格编辑独立成区 + 克重可编辑（2026-10-17）

用户口径：「修改 SKU 矩阵页面，规格编辑把通用的编辑项提取出来，如：颜色（色图 · 色名）、尺码、
默认克重，增加克重编辑」。

- **界面切成两段**：**规格区**（颜色卡片 = 色图 + 色名 + 删除 / 尺码 chip = 内联改名 / 默认克重）＋
  **组合区**（矩阵：行 = 颜色、列 = 尺码、格 = `✓ 在卖` + 该码克重）。原先「缩略图 + 色名 + 删除」
  挤在 208px 的行头、「尺码 + 删除」挤在 92px 的列头 —— 三件事塞一处，名字稍长就看不全。
  分开后表格列宽回到 96px 的自然宽度，且**改规格只剩一个入口**（不再有"表头改一个字、下面
  140 个格跟着搬"的隐式耦合）。
- **克重落到 `sku_json`**（`weightG`）：**0 / 缺省不写 key** ⇒ 存量 546 条快照形状一个字节不变。
  链路：快照 → 建款向导预填 → `pl_variants.weight_g`（单向：改快照不回头改已建款的 SKU）。
  采集端不产这个字段，重新采集（详情页）覆盖色/码时要重填 —— 界面上写明了。
- **默认克重 = 两个显式批量动作**：「填进空格（N）」只动还没填的格（**不覆盖**人已核对的值）、
  「覆盖已填」是另一个按钮。初值**刻意不按现有数据猜**（猜错会在"加一色"时静默给十几格打上错
  克重，而克重会进成本/运费）；人敲过值之后新增的格才带这个初值。
- **⭐ 0 显示成空**（占位「待填」）：内部 0 = 没填，画进输入框却像个真数字 —— 第一版截图整列 `0`
  读起来是"这些 SKU 是 0 克"。故格内克重走 `:value` + `@input` 而非 `v-model`。
- **`cellMode` prop 取消**：弹层与向导合并成同一种格（存在性 + 克重）。向导顺带补上"取消组合"的
  能力（原先 weight 模式下已有格没有开关）。
- **验证**：`skuMatrix.spec.ts` 当轮 28 例（+10：读回克重 / 0 不写 key / 只填空 / 覆盖才改已填 /
  批量填不造 SKU / 新增格带初值 / `parseSkuJsonRows` 抗坏值）；`goods:ui` 弹层段 **+7 例**
  （规格不在 tbody / 克重随格出 / 0 显示成待填 / 输入后可点 / 填进空格只填空 / 覆盖已填 /
  无空格时禁用）+ 载荷深比较加 `weightG`；`goods:shot` 新增弹层与建款向导的取证截图（含几何）；
  `vue-tsc` / `tsc` / `verify` / `verify:docs` / 全量 `vitest`（735）全绿；**变异 3 条全红**
  （填进空格改成一律覆盖 ⇒ 单测 2 条红；0 也写 key ⇒ 单测 2 条红；0 画成数字 ⇒ 冒烟"待填"1 条红）。
  细节与坑见 `docs/notes/2026-10-30-goods-sku-weight.md`。

### Changed · 采集 SKU 的尺码剥掉卖家写的修饰（体重区间 / 版型前缀 / 括号补注）+ 存量回填（2026-10-17）

用户口径：「采集商品解析的 SKU 中尺码要剔除非正常尺码的字符串」。

- **真库取证**（8 个商品 / 546 条 SKU）：脏值只有三类 —— 体重区间 `XL 60-65kg`（10 种 × 7 色 = **70 条**）、
  版型前缀 `Asian size XXXL`（6 种 × 6 色 = **36 条**）、全角括号补注 `XS（old）`（**14 条**），合计 **120 条**。
  原样落库的后果是矩阵列头**一个码占四列**（`1005007171795928` 的 12 列里 10 列带体重区间），
  看着像"采到了十几种尺码"。
- **是提取不是丢弃**：剥完都是合法码（S/M/L/…/7XL/4XL），且**无一与本商品已有的纯码撞列**
  —— 真库副本回填实测：4 个受害商品的列数 **12/8/8/9 一条不变**，只是列头变干净。
  真按"剔除整行"做，84 行那款只剩 14 行、48 行那款只剩 6 行（带修饰的码就是它全部的码），用户会以为漏采。
- **三条保守纪律**（`electron/aeMoney.ts#normalizeSkuSize`）：
  ① **只剥已知修饰，不校验"像不像尺码"** —— 正当尺码体系无穷（`70B` / `2T` / `28W` / `均码`），
  黑名单式校验迟早误伤，而被误伤的码会从矩阵里消失且不报错；
  ② **括号里含数字就不剥** —— `S (2-3 years)` 那个区间正是童装区分变体的东西，剥了会把两个变体并成一格；
  ③ 剥完为空 / 输入本来干净 ⇒ 原样返回（幂等）。
  全角转半角**只动字母数字**：全角括号在中日文里是正常排版，转了等于改用户看到的形态。
- **两条入口刻意分叉**：采集落库走 `normalizeIngestSku`（剥修饰）；人在矩阵里手改走 `normalizeEditedSku`
  （**原样保留**）—— "用户填的形态不能被吃掉"是本仓硬约束（同 `shop_url` / `shop_url_raw` 的教训）。
  消毒规则（全空跳过 / 非串转空）仍是同一份 `normalizeSkuRow`，不抄第二套。
- **存量回填**（`migrate('shop-item.main', v1)`）：不回填等于"修了代码但用户看到的一模一样"，
  得等下一次详情页采集才变。回填**不动 `scraped_at` / `updated_at`**（这是口径修正，不是重采、也不是人改过 ——
  拿它冒充采集时间会让「最近采集」状态条说假话），**不动 `raw_json`**，解析不了的行原样留着。
- **验证**：`aeMoney.spec.ts` +8 例（三类修饰各一 / 括号含数字不剥 / 罕见正当码不动 / 剥空保留原文 /
  大写统一 / 幂等）；`shop-item:smoke` +4 例（采集三步剥离逐条对位 / 人工保存原样 / 回填校正且不动时间戳 /
  **版本已记就不再回填**）；**变异 5 条全红**（采集不剥 ⇒ 1 例；人工也归一 ⇒ 1 例；回填不归一 ⇒ 2 例；
  回填顺手改 `updated_at` ⇒ 1 例；括号一律剥 ⇒ 单测 1 例），逐条还原后哈希一致、全绿。

### Added · SKU 矩阵的行头色图可点开看大图（弹层与建款向导两处都有）（2026-10-16）

用户口径：「增加点击色图展示大图」。

- **为什么需要**：矩阵化之后，这两个界面的核心动作之一就是**认色名** —— 平台给的常常是数字色号
  （`4`）或英文色名（`Black`），得人**对着图**判断该归到哪个标准色。34px 的缩略图看不清印花和深浅。
- **做法**：行头图包一层按钮（剥掉按钮外观、`cursor: zoom-in`，右下角**常显** `⤢` 角标 —— 原先队列缩略图
  就吃过"只在 title 里说能点、触屏永远看不到"的亏，这次一开始就带上）。点开是一层 `.wb-mask` +
  `.wb-dialog` 的大图弹层，头部写「哪一色 + 这张图从哪来」（平台色图 / 商品主图回落），底部一句说明。
- **只读动作 ⇒ 不受 `disabled` 影响**：数据锁住时人仍然需要看清这一色到底是什么颜色，所以 `disabled`
  时按钮照常在（与"格/输入框锁住"是两回事）。
- **没图的行不给按钮**：点开一个空窗比不做还糟 —— 没采到色图的行仍是不可点的空占位。
- **⚠️ 这是一层嵌套遮罩**（外面的编辑器弹层本身就是一层 `.wb-mask`）：靠遮罩一律 `position: fixed`
  才没有被那个 `max-height: 46vh` 的表格容器裁掉；`@click.self` 只关自己 —— 点大图的遮罩/`Esc` 都
  **不能把整个编辑器一起关掉**（关错一层就得重开重填）。
- **`Esc` 的监听器常驻 window**，判据里必须带"大图开着"这个守卫，否则会无脑打断当前弹层。
- **"是色图还是回落主图"只有一处判据**（`isFallbackImage`）：缩略图 title、大图弹层的来源标签、大图
  下方那句说明全用它 —— 各写一遍必然出现"图上说一个说法、弹层里是另一个"。
- **顺手修掉**：矩阵提示语与向导提示语里的 `**…**`（Markdown 星号直接显示在了界面上）。
- **验证**：`goods:ui` 弹层段 +8 例（有图才有按钮 / 常显角标 / 大图与缩略图**同一个 src** / 头部写清色名
  与来源 / **遮罩盖满整个视口** / 大图真的比缩略图大 / 点遮罩只关一层 / `Esc` 只关一层）、向导段 +3 例
  （两行都能点 / 回落行写明"不会拿它当色图" / 关掉后向导还在）；**变异 3 条全红**（没图的行也渲染按钮
  ⇒ 2 例红；`isFallbackImage` 恒假 ⇒ 1 例红；给遮罩的祖先加 `transform` ⇒ 几何那条量到
  `rect=267,314,906,219` 而非视口 `1440×813`），还原后宽 + 默认 + 窄三遍全绿。另做了**一次性截图取证**
  （假桥从冒烟脚本切出，不是另造桩）。

### Changed · 「修改 SKU 矩阵」重做成 色 × 码 二维矩阵（弹层与建款向导共用同一组件）（2026-10-16）

用户口径：这个弹层能不能按**速卖通商品详情页**那种"颜色 / 尺码"的展示方式重做。

- **为什么不照搬速卖通**：那一块是**选择器**（选色 → 选码 → 只显示选中组合的价格/库存，故意把其余组合
  藏起来）且没有编辑面；这个弹层要的是**编辑器**（一屏看全 + 改任意格），而真库最大一条有 **140 个组合**
  （14 色 × 10 码），用选择器过一遍要点 140 次。它值得借的是**色图块 + 维度分组** —— 这恰恰是原来那张
  平铺表丢掉的东西：色图是**色级**属性（同色多行同图），平铺表却按行把同一张图画了 140 遍。
- **新形态**：行 = 颜色（行头 = 色图 + 色名）、列 = 尺码、交叉格 = 这个组合在不在卖（**空格 = 不存在**）；
  `+ 颜色` / `+ 尺码` 新增的整行/整列**默认全有**（人明确点的动作，不要的再逐格取消）。数据层新增
  `src/lib/skuMatrix.ts`（平面数组 ⇄ 矩阵互转，纯函数 + 18 例单测），界面新增 `SkuMatrixEditor.vue`；
  「修改 SKU 矩阵」弹层与建款向导**共用同一个组件**，差别只在 props（向导的格是克重输入、行头图回落商品主图）。
- **⚠️ 行的身份 = 色图 + 色名**（不是色名）：真库 id=12 有 66 条 SKU，唯一 `(色名, 码)` 对只有 **42** 个
  —— `blue` 这一个名字下挂着**两张不同的图**（各 6 码）。按色名做行会把其中一张静默合并掉。
- **撤掉「平台单价」列**：真库 **546/546 全空**（采集端不采价，前台是区间价），且 `sku_json.price` 在代码里
  **零下游读者**（建款向导读了、保存时丢弃）。**撤的是界面不是字段** —— 格子里仍带着价格走到保存。
- **验证**：`tests/skuMatrix.spec.ts` 18 例全绿；`goods:ui` 弹层段 +7 例（空格语义 / 加列默认全有 / 删列 /
  展开逐字段对位含价格与色图）、向导段 +2 例（存在的格数 vs 空格 / 克重**按格**透传）；**变异 3 条全红**
  （去掉"只输出存在的格" ⇒ 4 例红；输出 `price: ''` ⇒ 1 例红；新列不补格 ⇒ 1 例红），还原后三遍冒烟全绿。
  结论与坑见 `docs/notes/2026-10-30-goods-sku-matrix.md`。

### Changed · 「打开店铺」优先用 Chrome 打开（没装才回落系统默认浏览器）（2026-10-16）

用户提问：「待关联采集商品」里的「打开店铺」能否默认打开 Chrome。**原先不能** —— 实现是
`shell.openExternal(url)`，即**系统默认浏览器**；Electron 这个 API 没有"指定应用"的参数。
默认浏览器不是 Chrome 时，页面开在一个**没装采集扩展**的浏览器里，用户看到的是"打开了，
但找不到采集按钮"，且看不出原因。

- **修法**：新增 `electron/browser-open.ts` 作为外链的统一出口（`openUrlInPreferredBrowser()`）——
  按平台探测 Chrome 并交给它打开（macOS `open -b com.google.Chrome`、Windows 按已知安装路径找
  `chrome.exe`、Linux 试常见命令名），**探测 / 启动失败一律回落 `shell.openExternal`**，绝不返回失败
  （回落只是"少了采集扩展"，报错是"入口失效"）。`open-external` 通道形状、入参、错误文案一字未变。
- **两个「打开店铺」入口自动受益**（「待关联采集商品」下拉 / 「基础数据 › 店铺登记」行内），
  因为二者共用该通道 ⇒ 渲染层零逻辑改动，只有注释同步。
- **验证（真机 darwin）**：`RESULT=chrome MS=60`；把 bundle id 变异成不存在 ⇒ `RESULT=system MS=33`
  （回落分支无异常）；关键判据实测 `open -b <缺失> <url>` **命令成功但退出码 1**（只按 spawn error
  判会永远判成功 ⇒ 静默不回落）。Windows / Linux 分支**未实测**，结论与坑见
  `docs/notes/2026-10-30-electron-and-platform.md`。

### Fixed · 店铺地址填 `https://` 保存后被剥成裸域名 ⇒「打开店铺」报「链接地址无效」（2026-10-16）

用户现场两条，同一个根因：① 「基础数据 › 店铺登记」里填 `https://…` 保存，再打开编辑，前缀被
吃掉；② 「货与成本 › 待关联采集商品」点「打开店铺」提示**链接地址无效**。

- **根因：一列担两个角色**。`sk_shops.shop_url` 既是采集帧的**匹配键**（落库时把协议 / `www.` /
  尾斜杠 / `index.html` / 查询串都剥掉，好让"人贴的地址"与"页面采集的 URL"对得上），又是界面回显
  与「打开店铺」的目标（`open-external` 要求 `http(s)://` 开头）—— 后者被前者吃掉了。
- **修法：拆成两列**（`electron/shop-db.ts`）。`shop_url` 仍**只做匹配键**（索引与
  `WHERE shop_url = ?` 一字未动，采集落库口径不变）；新增 `shop_url_raw` 存**用户填的原文**。
  新增 `toOpenableUrl()` 规整原文：已带 `http(s)://` 的**原样保留**（只补不删）、`//host` 补
  `https:`、其它协议原样交给 `open-external` 按白名单拒绝（不伪装成能打开）、裸域名补 `https://`；
  匹配键**从规整后的原文派生**（展示值与键同出一次规整）。读取面（`ShopListItem.shopUrl` /
  `listShops` / `getShop`）改为给**原文**，原文缺失时按键补协议兜底 ⇒ 两处「打开店铺」
  （店铺登记页 / 待关联采集商品的下拉）与两处表单回显**零改动即正确**。
- **老库迁移**：`ensureShopColumns()` 补 `shop_url_raw`，并在**同一次**把存量归一键回填成
  `https://<键>`（不回填的话老店的「打开店铺」照样报无效）。回填带
  `shop_url_raw = '' AND shop_url <> ''` 两个条件（不覆盖已有原文、不给没地址的店凭空造地址），
  且只在"缺列"那一次执行。
- **验证**：`shop-item:smoke` 新增 5 条（原文保留 `http://` / 裸域名补 https / 读取面给可打开地址 /
  改址与清空两列同步 / 三种库形状的迁移回填与"迁移只做一次"）；**变异复核 4 条全红**
  （读取面退回匹配键 / 回填移出缺列分支 / 去掉空键条件 / 原文也走归一），还原后全绿。
  真库克隆端到端：9 家店行数与键逐 id 一致、回填到位、8 家有地址的店在"帧只差协议/www/query/
  index.html"下仍全部命中。结论与坑见 `docs/notes/2026-10-30-shop-identity-and-mapping.md`。

### Changed · 「货与成本」第三段改名「待关联采集商品」并恒只列未认款；采集行支持行内 SKU 编辑与删除（2026-10-16）

用户口径三轮递进：① 售价列去掉、「商品」列改名「商品ID」且不换行、SKU 要展示出来并支持修改；
② 增加删除功能（并问「同一个商品采集多次会不会多条记录」）；③ 段改名「待关联采集商品」、
已认款的展示在「已建立映射」、本段只展示未认款、修「页面样式不协调」。

- **段名与过滤**（`src/modules/goods/useSkuPool.ts` / `components/PoolPane.vue`）：第三段
  `sub-items` 改名「**待关联采集商品**」，`loadShopItems` **恒传 `onlyUnconfirmed: true`**
  （服务端过滤，分页不被客户端过滤掏空）。认款写的就是映射行 ⇒ 已认款的采集商品只在
  「已建立映射」里出现（原先同一商品两段同屏，正是"不协调"的根因）。徽标改用**未认款数**
  （`itemStats.unmapped = total - confirmed`，与列表同口径）；采集状态条仍报全库事实
  （已采 N / 已认款 M）。删掉「只看未认款」勾选框（改为恒开）、删掉状态列的「已认到」死分支、
  空态改为「采集的都认款完了」+ 指向「已建立映射」。
- **表列与行内动作**：六列 = 勾选 / 图 / 商品ID / SKU / 采集时间 / 状态（**售价整列撤掉**）；
  商品ID 格 `nowrap` + 省略号 + `title` 全文；SKU 格展示色码文本（`黑/L、4/M`）+「改」（有矩阵）
  或「补」（没采到矩阵，含手贴/轻采行）；状态列新增**行内删除**（确认弹层写明"认款映射不受影响 /
  重新采集还会出现 / 同商品多家店各是一条"）。新增 `ShopItemSkuEditor.vue`：色图缩略图常显 +
  颜色/尺码/平台单价矩阵编辑（加行 / 删行）。
- **唯一标识（回答用户提问）**：`pl_shop_items` 唯一键是 **`(shop_id, store_key, item_id)` 三元组**
  —— 同店重复采集是**同一行 UPDATE**（幂等，只覆盖非空字段），同一商品ID 在两家店 / 未登记桶下
  **各是一行** ⇒ 改与删一律**按行 id**（按 `item_id` 删会误删别家那份）。
- **新 IPC 两通道**（`shop-items-update-sku` / `shop-items-delete`，四处同步：handlers + preload
  + `src/types.ts` + `src/core/services/ipc.ts`）：改矩阵是**全量提交**（每行
  `{color,size,price,imageUrl}`，色图必须原样带回，漏传=静默清空；行级消毒复用采集的
  `normalizeIngestSku`），**不动 `scraped_at`**（人工修改不冒充"重新采过"）；行不存在时**报错**
  而非返回"成功"让界面照常刷新。
- **样式修复**：`.gd-items .gd-c-ops` 的列宽选择器原先只写 `td`，而 `table-layout: fixed` 下
  列宽由 `thead` 决定 ⇒ 状态列实测 150px、声明 108px 根本没生效（改后 th/td 都命中）；同时删掉
  已无消费者的 `.gd-items__filter` 样式块。
- **验证**：`goods:ui` 三遍 **310 条 PASS**（含新增「7002 不出现在本段 / 认款后该行从本段消失
  且出现在已建立映射 / 徽标 2→1 / 按行 id 改删」）；`ipc:shape:smoke` ⑪ 段四例（真 handler + 真库：
  规范形落库、色图落库、`scraped_at` 不动、删快照不联动删映射、行不在报错）；`vitest` 39 文件
  **699 例**；`uxEntryNames` 悬空入口名守卫补登「已建立映射」（同页分段控件）。
  **变异复核**：`onlyUnconfirmed: true → false` 立即红掉两条核心新断言（还原后全绿）。
  结论与复发坑见 `docs/notes/2026-10-30-shop-item-import-and-merge.md`。

### Added · 整店采集：单按钮「采集本店全部（含 SKU）」+ 走位状态机断点续采（ae-profit 0.3.0，2026-10-16）

用户问「采集插件中为什么要有三个按钮？能不能只保留一个按钮，实现采集本页商品并自动采集商品详情
中的 SKU 数据」——原三入口（采集本页 / 采集本店全部 ≤20 页 / 采 SKU）合并为**一个按钮**：在店铺
主页或任意本店页面点一次，先走 all-items 列表页聚合全部商品（规范 ID/标题/图/价，分页 ≤20 页、
翻页 ~900ms 节奏），再自动**逐款导航到详情页**解析 SKU 矩阵（颜色/尺码/每色图），完成后回到起点页。
全程用户在场、随时可停、断点续采（与店小秘采品同形态；合规边界见 AE_SHOP_ITEM_SYNC_PLAN §5）。

- **扩展侧走位状态机**（`SellerKitExtensions/extensions/ae-profit`，0.2.1 → 0.3.0）：单槽台账
  `aeWalk` 落 `chrome.storage.local`，**每步（每页/每款）都写盘** —— MV3 里 tab 崩了、worker 被杀、
  用户手动停，下次点按钮都从断点接上（已完成的款不重采）。停止信号走独立键 `aeWalkAbort`（popup
  直写 storage）：content 可能正处在页面跳转中收不到消息，storage 是跨页面唯一可靠的信号通道。
- **走位标记 `?skwalk=<token>`**：本脚本发出的每一次导航都带它，页面 boot 时凭「URL token == 台账
  token」续跑；用户手动浏览的 URL 不带它，不会被误伤；token 不匹配 = 让位（superseded，只入史）。
- **防错配**：逐款导航后按「目标 ID / 302 别名孪生（台账 canonicalId）/ 新鲜期内的未知页」三判据
  放行；落在上一款的旧页（已入台账）**一点不采**，回目标款重走 —— 错配 = 把别款的 SKU 挂到目标头上。
- **无规格商品是合法终态**：渲染完成但没有 SKU 行 = 该款没有规格（SKU 数 0），不算失败；页面没
  渲染出内容（加载失败/人机墙）才记失败，判据只认 `og:url`（报错页也有 title）。
- **回归**：jsdom 双层次测试 18/18（解析层 5 + SKU 单元 1 + 走位层 12），走位层用「一次导航 = 一个
  新 jsdom + 同一份 shared.storage」复刻生产同构；含停止双通道 / 并发保护 / 推送失败两阶段记账。
  详见 `docs/notes/2026-10-30-ae-collection-pipeline.md`（含两个测试基建坑：夹具数据对象 vs
  预渲染字符串、jsdom realm 与 Node realm 原型不同导致 `deepEqual` 误判）。
- **生效方式**：Chrome 直接从仓库目录加载（本机取证：Secure Preferences 的 path =
  `SellerKitExtensions/extensions/ae-profit`）⇒ 在 `chrome://extensions` 点「重新加载」即可，无拷贝步骤。

### Removed · 采集扩展下线订单采集（仅扩展侧）；宿主接收链路与域名白名单不动（2026-10-16）

用户裁定「顺便把订单采集功能去掉」。**仅扩展侧**移除：content.js 订单页解析、popup 订单按钮、
background 的 `COLLECT_RESULT` 分支、protocol.js 订单常量与回归用例、两份 README 与 options 文案。

- **宿主侧零改动**：`/ae/ingest` 接收链路、`ae-receiver`、订单主干（C1 归一后的 `oi_orders`）
  与历史数据一律不动 —— 本项只停「采集端入口」，不动「接收端通道」。
- **域名白名单全族保留**（`csp.aliexpress.com/m_apps/*`、`marketplace.seller.aliexpress.com/*`、
  `sell/seller.aliexpress.com/*`）：其中前两者承载**商品管理页**（仍在用）；全部保留的成本 ≈ 0，
  而删错的后果是**静默失效**（采集无响应、页面无提示），偏向保留已断案。
- 复核：扩展仓全仓 grep 订单采集残留为空；订单停采的**就地标注**已加在 `docs/features/PROFIT_TRACKER.md` §1。

### Fixed · 「店铺商品」一片空白的真因：preload 把缺省的 shopId 压成 0（2026-10-15）

接「广播桥」那条的续查：用户复报「重启过了，列表还是没有数据」。**真因与广播无关** ——
`preload.shopItemsList` 把缺省的 `shopId` 归一成 `0`（`Number(payload?.shopId) || 0`），
而 `0` 在数据层是**「未登记桶」过滤条件**；「货与成本 › 店铺商品」的调用点（`useSkuPool.ts:488`）
**本来就不传 shopId（= 不过滤）**，被压成桶过滤 ⇒ 已归店的 8 行（`shop_id=4`）**手动刷新也看不到**。
「数据链完好、坏的是可见性」只说对一半：广播修的是「采集后零点击可见」，列表本身是**读链缺陷**。

- 契约 = 三态：缺省（不过滤）/ ≤0（未登记桶）/ >0（指定店）—— preload 原样透传
  （`Number.isFinite(Number(x)) ? Number(x) : undefined`）；`shopItemsImport` 刻意**不**改
  （它缺省的语义 = 用户下拉里显式选的「未登记桶」）。
- **守卫落在通道层**（`npm run ipc:shape:smoke` ⑩）：钉发出去的载荷 `shopId === undefined`、
  不过滤看到全部、点名店只回该店、未登记桶回 0 —— 压 0 的写法立刻红。
- 真机复验（真实 userData 克隆 + CDP）：**8 行全出** + 状态条「已采 8 个商品（已认款 1）」。
- ⚠️ 本轮三处修复都动了主进程与 preload —— **需重启应用才生效**（HMR 不覆盖）。

### Fixed · 既有缺陷：全新库点「店铺商品」报 `no such table: sk_shops`（2026-10-15）

做广播真机验证时撞上的既有缺陷（与该轮改动无关，**只在全新 userData 上现形**）：本域读链有
`LEFT JOIN sk_shops`（列表 / 单行读），而 shop-items 各 handler 只 ensure 本域表 ⇒ 新库第一站
就是「店铺商品」段时直接抛原始 SQLite 错（"能采、不能看"：`matchShopByStore` 仅在有店证据时
才查店铺表，扩展帧 `store:{}` 全空 ⇒ ingest 照常 200）。

- 修法 = 落库层共用 `ensureSchema()`：`ensureShopItemSchema()` + **import 店铺域的
  `ensureShopSchema()`**（表由 owner 建、DDL 只留一份；同款先例 `shop-product-db.ts`），
  7 个入口（含图片回填的单行读）统一走它 —— 比页级 `shopDbEnsure()` 引导覆盖更全、
  比逐处读侧 `tableExists` 守卫面更小。
- 跨域边登记更新：`check-cross-domain-edges.mjs` 的 `shop-item-db.ts → ./shop-db` 符号
  +`ensureShopSchema`。
- 守卫：`shop-item:smoke` 新增全新库段 3 例 + `ipc:shape:smoke` ⑩ 全新库腿；
  **新用例先在修前的 dist 上跑**：3 例红且报的正是 `no such table: sk_shops`，重建后全绿。
- 详见 `docs/notes/2026-10-30-shop-account-merge-and-status.md`（已翻 ✅）。

### Fixed · 既有缺陷：采集帧「全字段覆盖」把另一采集层级采到的字段静默清空（2026-10-15）

采集分两个层级、**各带一半字段**：列表页轻采（标题 / 图 / 价 / 类目 / 状态 / URL，无 SKU）；
详情页「采 SKU」（**只有** SKU 矩阵）。而 `upsertShopItems` 对已存在行是**全字段覆盖** ⇒ 后跑的
那次把另一次采到的字段**静默清空**，两个方向都可达：「采 SKU」清掉标题/图/价；全店重采清掉
SKU 矩阵。回执照报 inserted/updated 成功 —— 看起来像"没采到"，实际是被覆盖没了。

- 修法 = 落库改为**只覆盖非空**（空值语义 = 「这次没采到」，不是「平台上没了」——后者不存在
  这种事件）；非空新值照常覆盖（是"空值不覆盖"，不是"一律不覆盖"）；SKU 按"有没有行"判。
- 守卫：`shop-item:smoke` 新增 3 例 —— 详情帧不清列表字段 / 列表重采不清 SKU / 详情帧带新 SKU
  覆盖旧矩阵（第三条防"有值就跳过"的坏修法）；前两例在旧代码上逐条打红。
- 直接保护当前工作流：8 行 `sku_json` 现全为空，正是首次「采 SKU」的前夜 —— 旧实现里首采成功
  会顺带把标题/图/价清空。
- 详见 `docs/notes/2026-10-30-shop-item-import-and-merge.md`。

### Fixed · 「采集到 8 条，应用里却没有数据」—— 外部写入 → 界面可见的广播桥（2026-10-15）

用户报障：扩展 popup 显示「采集到 8 条」，宿主「货与成本 › 店铺商品」却一片空白。**数据链完好**
（`pl_shop_items` 8 行、归店正确、ID 是规范空间），坏的是**可见性** —— 采集是**外部进程**（Chrome 扩展 →
`ae-receiver` 的 HTTP 帧）写库，已打开的宿主页面一无感知（`ae-receiver` 的状态口也只暴露订单任务的
`lastIngestAt`，对商品帧是盲的）。修法 = 落库后**广播** `ae-items-ingested`（与 `mail-sync-event` 同款）：

- **五环链**：`emitItemsIngested()` 在 `upsertShopItems` **之后**调用（`ae-receiver.ts:90/250`）→
  `main.ts:232` 注入窗口引用（漏 = 广播永远静默不发）→ `preload.ts:1165` 订阅 + 退订 →
  `src/types.ts` / `src/core/services/ipc.ts` 契约 → `useSkuPool.ts:1124` 消费：停在「店铺商品」段
  **全量重拉**，停在其它段**只刷汇总徽标**（后台重拉不打乱勾选/筛选）。`check-ipc-contract.mjs` 的
  `BROADCAST_EVENTS` 已登记（verify 做双端对称检查）。
- **验证**：静态接线守卫 `tests/aeItemsIngestWiring.spec.ts`（7 例，剥注释查活代码 —— 函数"写了没调用"、
  位置放错、窗口没注入、订阅泄漏都在它眼里；4 条变异逐条打红）· `npm run goods:ui` 新增
  `ingest-broadcast` 步（4 断言：空态前置 / 广播**零点击**出数据 / 别段只刷徽标 / 库翻回非空徽标
  重新点亮 —— 同一条通道正反两向都钉；2 条变异复核，else 分支改全量重拉只红"列表不动"那条）·
  真机隔离实例端到端（真 Electron + 真接收端 + CDP 投帧）：**零交互** 3 行 → 5 行 + 状态条更新。
- ⚠️ **本次动了主进程（ae-receiver / main / preload）—— 需重启应用才生效**（HMR 不覆盖）。
- 结论与可复用取证法见 `docs/notes/2026-10-30-ae-collection-pipeline.md`。

> ⚠️ **同日追记**：本条修的是「采集后零点击可见」。用户重启后仍看不到列表的**真因是另一处** ——
> preload 把缺省 shopId 压成 0（见上方「『店铺商品』一片空白的真因」）。两处修的是不同环节，缺一不可。

### Fixed · 采集扩展（ae-profit 0.2.1）：店铺主页（买家视角）商品采集 + 商品ID 双空间收口（2026-10-15）

用户复报「采集商品的 Chrome 插件无法采集到商品信息」，场景为**自己店铺的主页**（买家视角 `aliexpress.com/store/…`，
非卖家后台）。改动全在扩展仓库（SellerKitExtensions），**主机端零改动**（协议 / 落库不变）：

- **两处根因**：① `manifest.content_scripts.matches` 没有 `store/*`（脚本未常驻，只靠 activeTab 兜底注入）；
  ② 店铺主页是 Choice 主题卡片（`div[exp_type="XRcmd-ItemExposure"]`，无 class、全靠行内样式），
  既有 `ITEM_ROW_SELECTORS` 全不命中（旧实现采 0 行）。
- **正确性要害 —— 商品ID 双空间**：店铺主页卡片 href 是**旧空间别名**（`32…` 开头），而订单 / 认款 / SKU
  全用规范 ID（`1005…`）；拿 href 采会**静默对不上账**（采集回执"成功"，认款时才发现全空）。规范 ID 的
  唯一来源 = 卡片曝光埋点 `utlogmap`（URL 编码 JSON）的 `prod` —— 已实现「utlogmap 优先 / href 兜底」，
  并变异钉死（优先级反转 ⇒ 用例红）。
- **配套收口**：店铺连接键 = 地址栏 `/store/<id>` 优先（店铺页可能含别人店铺的链接；og:url 的规范店号
  与主机已登记的别名店 URL 反而匹配不上）· 店名取页面自报（`<title>` / keywords meta）· `/i/` 短链详情页
  itemId 走 `og:url` 兜底（实测 `/i/` 不会被重定向到 `/item/`）· 「采 SKU」在 itemId 为空时**明说且不推空号帧**。
- **顺带修复（既有缺陷）**：买家商品页 UI 文案（`Color: 6 View More Size: XL…`）被旧 props 判据（"含 Color:"）
  当 SKU 推出去 —— props 兜底收紧为「主程序 `parseSkuProps` 可解析的两种写法」（`Color:X;Size:Y` 需分隔符 /
  `X+Y+Z` ≥2 段），不成形即计失败、不推垃圾。
- **验证**：jsdom 回归 29/29（新增店铺主页卡片 7 例 + `/i/` 2 例 + props 收紧 1 例）；变异复核 10 条
  （ID 优先级 / 埋点嵌套 / 价格兜底 / 店铺键守卫 / og 兜底 / props 判据…）逐条打红；真机在实页注入验证
  8/8 条规范 ID / 标题 / 价格 / 图全对。
- **已知限制（记入 README）**：买家商品页的 SKU 矩阵暂未支持（选择器只对卖家后台结构调过；会明说失败并给样本）。
- 扩展 0.2.1 已拷入本机 unpacked 扩展目录，**需在 Chrome 扩展页点「重新加载」生效**。
- 结论与取证笔记：`docs/notes/2026-10-30-ae-collection-pipeline.md`。

### Changed · 跨域数据访问改为「编译期看住 + 显式在册」（P1-4，2026-10-15）

数据依赖审查的 **P1-4**（笔记 `docs/notes/2026-10-30-db-schema-and-migration.md` §二）。
原判据说"跨域写未收口：`ae-db → order-db` 模块级 import + `purchase-handlers` 直接 `require('./order-db')`"——
**复核后推翻了一半**：

- **`ae-db → order-db` 不需要改**：它是同一 ts 项目里的**静态 import**，本来就在类型检查里
  （实测：改 `upsertCollectedOrder` 的参数类型，`ae-db` 立刻 TS2345），且是 C1 刻意的**单一具名函数 seam**
  （`order-db.ts` 注释写明"汇率属 ae 域，让 order-db 读别的域才是跨域耦合，所以由 ae-db 折算"）。搬去编排层只是把 import 换个文件。
- **真缺陷是"跨文件 `require` 不带类型标注"**：`const orderDb = require('./order-db')` 是 `any`。
  **实测（改前）**：把 `order-db.findStyleColorImagePath` 的 `color` 由 `string` 改成 `number`，
  两处调用照传 string，`tsc -p tsconfig.electron.json` **退 0、一个错都不报**。

改动：

- **3 处补 `as typeof import(...)`**：`order-handlers.ts`、`purchase-handlers.ts`（`purchase-db` 与 `order-db`）。
  擦除后无运行时开销；同文件对 `xlsx-image` / `ipc-util` 早就是这么写的。改后同一次探针报
  `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'`。
- ⚠️ **补上标注后 tsc 立刻照出 4 处此前被 `any` 掩盖的旧签名不匹配**（这才是"收口"的真正产出）：
  - `order-insert`：`payload.imageId` 是 `unknown`，原来经布尔中转**收不窄**（TS 不能用排除法收窄 `unknown`）
    ⇒ 改类型谓词 `isOrderImageId`；顺带把 `isPlainObject(payload)` 提到最前（原来 `payload` 为 null 时
    `payload.imageId` 会抛，兜底成了异常而不是 `{success:false}`）。
  - `order-queue-list`：`[...].includes(s) ? s : undefined` 里 `includes` **不收窄** `s` ⇒ 改类型谓词 `isQueueStatusFilter`（不用 `as`）。
  - `purchase-handlers` 两处明细：`sanitizeItems` 不产出 `amountCents` —— 真相是**它是派生列**
    （`insertItems` 里 `amount_cents = qty × priceCents` 现算），**写侧本来就不该给**。
    新增 `PurchaseItemInput = Omit<PurchaseItem, 'id' | 'amountCents'>` 用于
    `createPurchaseOrder` / `updatePurchaseOrder` / `insertItems` / `computeTotal` / `autoSourceRows`
    （读侧 `loadItems` / `PurchaseOrder.items` 仍是完整 `PurchaseItem`）——
    与渲染层 `src/modules/today/purchase.ts` 早已存在的同名同义类型**对齐**。
- **新增守卫 `scripts/check-cross-domain-edges.mjs`**（接进 `npm run verify` 第③条，`AGENTS.md` §5 同步）：
  **规则 A** `electron/` 内所有 `require('<路径>-db')` 必须带 `as typeof import(<同路径>)`（同路径也要查，
  写成别的模块等于没查）；**规则 B** `*-db.ts` 之间的静态 import 边必须**逐条在册**（`DB_EDGES`，6 条，
  含**从对方取用的符号清单**）——比对符号而非写死说明文字，用途悄悄变了（多 import 一个函数）也会红；
  在册但源码已无对应边同样判红（陈旧条目）。两条都有**空转守卫**。
- **刻意没做**：① 不搬 `upsertOrderBatch`（见上）；② 不给全仓所有 `require` 补标注
  （`main.ts` 那批是**只为注册副作用**的裸调用，没有 API 要查；其余普通模块属另一类清理，混进来会把判据说糊）。

**验证（含变异复核）**：`tsc` ✅ · `vue-tsc` ✅ · `verify`（3 条）✅ · `verify:docs` ✅ · `build` ✅ ·
`vitest` 38 文件 **692** 例 ✅ · 数据库 / 形状冒烟 9 个 ✅（`order` / `schema` / `shop-item` / `ae` / `shop` /
`purchase:xlsx` / `picking` / `ship-rate` / `ipc:shape` 37 项）· UI 冒烟 **order-profit 91 / today 249 / goods 291 / master-data 74** ✅。
守卫 5 组变异**逐条实测判红**且只由对应规则报红（去标注 / 标注指错模块 / 新增未登记边 / 既有边多拿符号 / 删掉在册边）。

### Fixed · 「基础数据 › 物流运费 › 运费查询」页表格区一片空白（DOM 完好但整页看不见）（2026-10-15）

用户报"样式不对"。**冒烟 31 项全绿、DOM 里 184 国表格完好，页面却只剩一块空白**
—— 只有截图能发现，文本断言一条都不会红。

- **根因是 flex 高度链断裂**，不是渲染问题。四个页签的根容器都只有 `display:flex; flex-direction:column`，
  **没有高度约束** ⇒ 内容自然高（184 国表格全渲染）撑到 8036px，而祖先 `.srp__body` 只有 773px。
  关键的一环：宿主 `.wb-panel__body { flex: 1 }` 在**没有确定高度的祖先里等于"平分内容"而非"伸缩"**
  ⇒ 结果面板内部两个 body 各平分 3982px；其中 summary 那行标签是 row 布局 + `align-items:center`
  ⇒ 被垂直居中到 y≈2162，而视口只有 913px ⇒ **整个可见区全是那 3982px 的空白**；表格本体在 y=4153。
- **修法**（契约与 `CostPane.vue` 相同）：根容器 `flex:1 + min-height:0`；固定区 `flex-shrink:0`；
  唯一可伸缩的是结果面板，且 overflow 交给内部表格容器滚动；summary 显式收回 `flex:0 0 auto`。
  四个页签（运费查询 / 运价表 / 按订单试算 / 按产品试算）一并修 —— 同一处病因。
- **冒烟补 4 条几何断言**（此前只判文本语义）：汇总条保持一行高 / 首行落在视口内 /
  结果面板不超过视口高 / 表格容器可滚（`scrollHeight > clientHeight`）。
  同时把 `isShown` 收紧：原实现只查 `display!=='none'`，**元素在视口外 4.5 倍高照样判"可见"** ——
  这正是它全绿而页面空白的原因。
- **变异复核**：退回修复前 ⇒ 4 条全红，detail 精确复现原始数字（h=3982 / top=4188 / 7966）；
  还原后全绿（36 项）。新增工具 `scripts/shipping-rate-ui-shot.mjs`（截图 + DOM 量测，
  假桥从冒烟脚本切出来，保证"截出来的就是冒烟在跑的那条链"）。

### Fixed · UI 岛冒烟的设置贡献断言稳定误红：固定 sleep 读不到惰性加载的面板（2026-10-15）

- 症状：`plugins:island:smoke` 三条岛断言全绿，但「设置贡献」稳定报
  `分类导航=[general, plugins]` —— 看着像"宿主自有的「识别」分类整个没注册"。
- 真因：**不是功能缺失，是读取太早**。设置面板是惰性动态 import
  （`registry.settingsPanelLoaders` → `@/core/settings/panels` → `RecognitionSettings.vue`），
  dev 模式下 vite 首次编译这条链常常超过脚本里写死的 `sleep(1500)`。
- 修法：改成**轮询等锚点** `[data-act="settings-cat"][data-cat="recognition"]`（最多 ~21s），
  与脚本上文「等侧栏出现」同一写法，等不到再判失败 —— 不再靠猜一个毫秒数。
  修后该冒烟 exit=0（3/3 岛握手 + 设置贡献 ✓ + 重启恢复 ✓）。

### Removed · 「无忧物流运费」旧岛通路整域删除（项目未上线，不留兼容层）（2026-10-15）

同日回收为内建页后，宿主仍留着 `DB_OPS['shipping-rate']` **薄委托**给"市场里已装旧岛的用户"。
项目尚未上线、没有这批用户，故按"未上线不留兼容层"整条拿掉 —— 每个保留的域都是一份要维护、
要守卫、还容易被后来人当成"另有实现"的分身。

- 删 `host.ts` 的整个 `shipping-rate` 域（5 个 op）与其 import；市场 catalog 去掉该条目 + 8 个历史 zip
  （**撤下比留着更安全**：装到旧岛就意味着按已被取代的口径算钱）；顺带清掉同样已回收的 `shop-accounts` 条目。
- 删 `OrderCostView` 里读旧岛 storage 键 `table` 的回落分支 —— 岛没了 ⇒ 那个键永远读不到值
  ⇒ 恒不生效的死代码（"看起来还兼容着、实际分支永远进不去"，比没有更容易骗人）。
  同键里的 `rounding` 是**用户查询偏好**、仍在写，保留。
  算法层 `computeOrderCosts` 的单表口径分支也**故意留着**（分支本身合法，`tests/orderCost.spec.ts`
  钉着"快照优先于单表"），只是生产恒传 `rateTable: null`。
- `rateAdopt` 保留：它不是岛通路，而是**用户数据迁移**（把早期留在 storage 里的运价表一次性交给宿主快照）。
- 守卫**改为反向**而非删除：`pluginTriage` 现在钉「`host.ts` 不得再有该域」「catalog 不得再有这两个岛」，
  因为这个域一旦被加回来，症状不是报错而是**同一份报价单算出两个数**（静默错价），
  而且它长得"很合理"（薄委托 + 有注释解释为什么保留），review 时极易放过。
  **变异复核**：把域加回 ⇒ 红；catalog 加回条目 ⇒ 红。

### Removed · 删掉三张"只建不写"的弃表与整条死代码链（`ae_orders` / `ae_order_lines` / `ae_fees` + `ae-engine`）（2026-10-15）

数据依赖审查的 P0 收口（笔记 `docs/notes/2026-10-30-db-schema-and-migration.md` §二 已就地记"已处置"）。
这三张表是 **C1 订单主干归一**（`oi_orders` 成唯一主干）留下的孤儿：采集写入口早改指主干，
但旧表、旧读口、旧利润引擎**没跟着迁走** —— 于是"读取方还在跑、数据永远不更新"。

- **判据不是"没人读"，是"没有存活消费者"**：三表仍有 6/3/3 处读取点，但顺着读到界面层全部断链 ——
  ① 宿主「算钱」用的是 `aeCostMapList` / `aeRateList`，**利润在渲染层 `src/lib/orderCost.ts` 组合**；
  ② ae-profit 岛的 manifest 只剩 `ensure` + `receiverStatus`（C9 收编时岛侧 op 已删）；
  ③ `src/core/plugin/host.ts` 的 `ae:` 域包装里 `orderList` / `summary` / `profitStats` 三键无人调。
- **删表走版本化迁移**（不是 `DROP` 在 ensure 里）：`ae.main` **v3** = `dropLegacyOrderTables`
  （`DROP TABLE IF EXISTS ae_fees / ae_order_lines / ae_orders`），同时把三张表的建表语句从
  `ae-db.ts` 的 `SCHEMA` 删除 —— 两处同向删，否则新库直建又会长回来（`purchase.main` v1 同款纪律）。
  ⚠️ 原 v2「补 `ae_order_lines.style_code`」随该表退场 ⇒ 步数 2、版本号到 3。
  存量库里的残留（本机实测 **101 单**历史采集 + 115 行明细，来源是 2026-09-08~09 的扩展推送）
  **按用户裁定直接丢弃**——它们早已不出现在任何界面上（`oi_orders` 里 39 行全是 `source=import`，
  两批 `order_no` **零重叠**）。
- **`order.main` v4 的历史回填保留不动**：它**只做加法、不删表**（是"老库可能还有数据"的兜底），
  与本次删表互不冲突；冒烟场景 [E] 照旧断言"老表**原样保留**"，场景 [D] 兼测"v3 把带数据的弃表也照删"。
- **一并删的**：`electron/ae-engine.ts` 整文件（378 行，唯一消费者「利润统计」页早随 C9 并入宿主）；
  `ae-db.listOrders` / `getAeSummary` / `mapOrderRow` / `fetchFeesByOrderIds` / `ORDER_COLS`；
  三段 IPC（`ae-order-list` / `ae-summary` / `ae-profit-stats`）四处契约同步删
  （handlers + preload + `src/types.ts` + `src/core/services/ipc.ts`）+ `host.ts` 包装同步删；
  以及**顺带清掉的死配置**：`shop-db.ts` 的 `SHOP_NAME_SOURCES` 原第三源
  `{id:'ae', table:'ae_orders', column:'shop_name'}`（表删了它就是死登记，`shop-unmapped` 的聚合从三处降到两处）、
  `scripts/reset-dev-data.mjs` 清空清单里的三个表名。
  口径文案同步：店铺登记页用户可见的那句"订单 / 采购 / **利润**三处的历史文本实时汇总"改为
  "订单 / 采购**两处**"（`ShopRegistryView.vue`），源码里同口径的注释（`shop-db` / `types` / `ipc` /
  `preload` / `main` / `shopApi` / `MasterDataView` / `shop-product-db` / `shop-handlers`）一并改 ——
 "三处文本"是这次删表的直接后果，不改就成了**假文档**。
- **文档**：baseline §「SQLite」**重数** 39 个对象 → **36**（33 业务表 + 2 内部表 + 1 FTS；grep 45 → 42 处，
  含注释同形文字 7 处），并订正两处此前遗漏（`pl_item_weights` 已于 2026-10-01 删除却仍在表里、
  `pl_shop_items` 2026-10-13 新增却未登记）；§「schema 演进」`ae.main` v2 → **v3**；
  `docs/notes/2026-10-30-island-host-boundary.md` 的域清单同步（35 张表）。
- **门禁**（2026-10-15 实跑）：`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅
  （preload 194 / types 194 / 主进程注册 190）· `verify:docs` ✅ · `build` ✅ · `vitest run` 692 ✅ ·
  `ae:smoke` **25/25**（原 `[4]` 那 5 条随 `ae-engine` 退场；成本口径本身**没丢** ——
  现由 `src/lib/orderCost.ts` 单源实现，`[4.5]/[4.6]` 仍在测）· `shop:smoke` 35/35 ·
  `schema:smoke` 37/37 · `ae:settle:smoke` ✅。
  新增一条**反向守卫**：`ae-cost-smoke.cjs` 断言三张弃表在 `sqlite_master` 里**不存在**（防它被重新引入）。

### Fixed · 采集「缺汇率」不再静默：入站回执报 `rateMissing`、「算钱」把「缺汇率」与「缺收入」拆成两档（2026-10-15）

数据依赖审查的 **P1-3**（笔记 `docs/notes/2026-10-30-db-schema-and-migration.md` §二，已就地记处置）。
采集帧是**外币**，`ae_rates` 查不到该币种时整单金额只能落 `NULL` —— 这不是失败，但**也不能当成功**：
原实现里 `/ae/ingest` 只回 `{ok:true, inserted:N}`，用户以为整批都收好了，实际有一批订单永远算不出利润。

- **入站不再静默**：`upsertOrderBatch` 回执新增 **`rateMissing`**（本批因缺汇率落 NULL 的单数）；
  `ae-receiver.ts` 的 `/ae/ingest` 响应带上它，并记进 `AeReceiverStatus.lastRateMissing`（`src/types.ts` 同构加字段）。
  ⚠️ 只在**真的落库**之后才计数 —— 被校验挡掉的行（`skipped`）不算"缺汇率的订单"（一个要补汇率、一个要修帧，处置办法不同）。
- **界面把两档拆开**：`src/lib/orderCost.ts` 新增缺口 `fx`（缺汇率），按**摄取通道**分流 ——
  `collect` + 金额 null ⇒ `fx`（**去「成本与汇率」补一条汇率、重推即可**）；
  `import` + 金额 null ⇒ `revenue`（报表里就没有这一列值，无处可补）。
  判据是精确的：`upsertOrderBatch` 只在一处生成金额（本币恒 1:1、外币有汇率即非 null），
  故采集单金额为 null **必然**是缺汇率。「算钱」缺口行新增「缺汇率」chip，沿用 2026-10-11 的**点 chip 即筛行**入口。
- **刻意没做**：① **不**把标记写进 `biz_status` —— 它**有下游读者**
  （`src/lib/orderCost.ts:187 bucketOfStatus` 按它分完成/在途/关闭桶，拣货也读），覆盖它会把真实平台状态吞掉、
  让订单落进 `unknown` 桶（**是真回归**）；② 不把金额写 `0`（`0` = "确实是 0"、`null` = "算不出来"，
  混起来会把"缺收入"伪装成"收入为零"）。
- **验证（含变异复核）**：`vitest` 新增用例**两个输入只差 `source`**、期望缺口必须不同（关掉分流 → 红）；
  `ae:smoke` 同一断言里造 CNY / USD / JPY 三个输入，计数必须给出不同值（"不计数"与"每单都计数"两种变异**都红**）。
  `ae:smoke` 25/25 · `vitest` 当轮 +1 例（当时总数记为 693；⚠️ 随后同一日的 shipping-rate 二次收口改了 spec 集，
  现测总数为 **692**——**别把"某一轮的总数"当常量引用，跑一次门禁为准**） · `order-profit:ui` 88 → **91**（+3，全 0 时仍**一个 chip 都不渲染**，不因新增档位漏渲染）。

### Changed · `oi_orders` 的拼接列变成「可直读 + 可断言」的一份（P1-2，2026-10-15）

数据依赖审查的 **P1-2**（笔记 `docs/notes/2026-10-30-db-schema-and-migration.md` §二）。
`oi_orders` 的列一直是"数组拼出来的"（金额列/主干列要**同时**服务「新库建表」与「老库 `ALTER` 补列」，
写字面量必然两处漂移）—— 这个设计是对的，欠的是**可读性**与**新库这条路上的断言**。

- `electron/order-db.ts`：原先硬写在模板里的 13 个基础列抽成 **`ORDER_BASE_COLS`**，建表模板改为
  **三份数组统一拼接**（改列只改数组）；新增导出 **`ORDER_TABLE_COLUMNS`** = 解析后的完整列序
  （由同一批数组推出，**不是第二份清单**）。
- `scripts/schema-migration-smoke.cjs` 新增**场景 [G]**：干净库 → `ensureOrderSchema()` →
  `PRAGMA table_info(oi_orders)` 与 `ORDER_TABLE_COLUMNS` **逐列相等**（`schema:smoke` 37 → **38 项 / 7 场景**，
  非空转守卫：清单条数 `>= 20`）。
- **刻意不做启动自校验**：`CREATE TABLE IF NOT EXISTS` 对老表一个字都不改 ⇒ 启动期检查既修不了形状、
  又只往日志里加噪声；"断言拼接结果"的落点是**测试**，不是运行时。
- **验证（含变异复核）**：① 模板漏一段 `${}` ⇒ 红；② **只**往模板字面量里手加一列（未进数组）⇒
  **只有 [G] 红**；③ 重建后 `sqlite_master` 里的建表语句与改动前**逐字相同**（列序未变，
  位置参数 `INSERT` 不受影响）。

### Changed · 「无忧物流运费」UI 岛回收为内建「基础数据 › 物流运费」（2026-10-15）

把 `ui-plugins/shipping-rate`（手写 ESM 岛，`dist/` 即源码、无构建步骤，14 文件 / 1.3.1）
整体并入内建「基础数据」，成为**第七类资料**。与 10-14 的「店铺账号管家」回收同一模式
（见 `docs/notes/2026-10-30-shop-account-merge-and-status.md`），但这次的难点不在桥桩，而在**两份实现**。

- **6 个 op 抽成单源服务** `src/core/services/shipRateOps.ts`（唯一实现）：原先它们住在
  `src/core/plugin/host.ts` 的 `DB_OPS['shipping-rate']` 里、专供 iframe 岛经 `window.__sk` 调。
  内建页面要**直接**调同一份逻辑，若在页面里另写一遍，档位 / 取整 / 类别优先级任何一处漂移都会让
  **同一份报价单算出两个数**（静默错价）。故抽服务后：`host.ts` 该域改为**薄委托**（市场里已装旧岛的
  用户照常能用，同 shop-accounts 的处理），内建页面直接 import 该服务。
- **页面落地**：`shipRateFormat.ts`（展示格式化）+ `shipRateStore.ts`（Pinia store）+
  5 个组件（`ShippingRatePane` 四页签 shell + `ShipRateQuote/Rates/Orders/ProductsTab`）。
  `MasterDataView.vue` 资料种类 6 → **7**，新增「物流运费」；`icons.ts` 补 `ship` 图标。
  四个页签（运费查询 / 运价表 / 按订单试算 / 按产品试算）逐一按内建交互重排，
  原岛 `dist/` 里的手写 ESM 视图**不复用**（它依赖岛桥与 iframe 布局）。
- **岛下架**：`git rm -r ui-plugins/shipping-rate`（14 文件全在 git 跟踪下，可从历史恢复）；
  `.gitignore` 里岛专用的反忽略行 `!ui-plugins/shipping-rate/dist/` 同步删除（留着会让
  `tests/pluginTriage.spec.ts` 的「dist/ 未被忽略」守卫读到一条指向已删目录的规则）。
- **存储命名空间刻意沿用 `shipping-rate`**：`useModuleStorage('shipping-rate')` **没有**改成
  `shop-accounts`。空间键未变 ⇒ 旧岛存下的查询偏好（克重 / 类别 / 变体 / 进位方式 +
  `lastFile` / `sheetNames` / `candidates`）**无缝接续**，老用户不必迁移也不必清空。
- **改文案而非加豁免的一处**：`ShipRateProductsTab.vue` 里"去「产品库」编辑补克重"——
  「产品库」在当前代码里只是 `pl_products` 这个**数据域**的名字，不是任何可点页面
  （模块只有 货与成本 / 算钱 / 拣货 / 便签 / 基础数据 / 发货台）。已改为指向真实入口
  「货与成本」的「建档与关联」。这是 `tests/uxEntryNames.spec.ts` 悬空名守卫抓出来的。
- **守卫改锚点**：`tests/pluginManifest.spec.ts` 岛清单改钉 `excel-copy` + `ae-profit`
  （顺带修掉"拿岛 id 兼作 db 域名 / storage 命名空间"的隐含假设 —— `ae-profit` 的域是 `ae`、
  且它并未声明 storage）；`tests/pluginTriage.spec.ts` 删除依赖岛源码的 6 条断言，改为**顺着
  `host.ts → shipRateOps → importSheet` 三层链**逐层查（每层不许自己解析、全链不许回落取第一张 sheet）。
  **变异复核**：host 混入 `xlsx` → 1 条红；服务不调 importSheet → 2 条红；还原全绿。
- **冒烟重写** `scripts/shipping-rate-ui-smoke.mjs`：站点从岛 `dist/` 换成宿主 `build` 产物
  （骨架与两遍视口沿用），**31 项断言**。三条真值是独立算出来的：100g 最便宜哈萨克斯坦
  `8.50`（45×0.1+4）、次便宜马来西亚 `9.80`；**改 350g 后首行换人**（KZ 只有 ≤150g 档，
  装不下 350g → 马来西亚 150g–500g 档 `16.05`）。夹具 sheet 数按**真实集合**断言
  （`tests/fixtures/shipping-rate.xlsx` 实为 **9 张**，先前写死 8 是错的）。
- **文档**：baseline 局部修订 + 第九次全量重扫（`src/` 155→165 文件 / 53,662→55,319 行）。
  ⚠️ `ui-plugins/` 两行**数值不变**（8 / 509）是口径使然 —— 该岛源码在 `dist/` 下被重扫口径
  `prune` 掉，从头到尾没进过那张表，"数值不变 ≠ 没删"。新增笔记
  `docs/notes/2026-10-30-shipping-desk-and-rate.md`。
- **门禁**（2026-10-15 实跑）：`tsc` ✅ · `vue-tsc` ✅ · `verify` ✅ · `verify:docs` ✅ ·
  `vitest run` **38 文件 692 例** ✅ · `build` ✅（顺带清掉一条 `INEFFECTIVE_DYNAMIC_IMPORT` 告警：
  store 里两处 `await import('./shipRateFormat')` 是岛时代残留，同文件已被静态 import）·
  `shipping-rate:ui` ✅（31 项 × 宽/窄）· `master-data:ui` 74 ✅ · `goods:ui` 291 ✅ ·
  `order-profit:ui` 88 ✅ · `ship-rate:smoke` ✅。

### 遗留：~~市场仓（独立 git 仓）的 shipping-rate zip 与 catalog 条目未动~~ —— **已于同日处置**
> 原为"待用户确认后另行删除"。用户答复：**老用户市场里的旧岛不需要能用，都删掉**（并说明项目尚未上线）
> ⇒ 已删 `shipping-rate` 与 `shop-accounts` 的 catalog 条目及全部 zip，宿主岛桥域整域删除。
> 详见上方「Removed · 旧岛通路整域删除」条目。

### Added · 「基础数据」：全部维护功能整合成一个一级入口，按资料种类重设计交互（2026-10-14）

用户口径：**基础数据维护相关功能整合到一起，让操作更简单、降低学习熟悉成本；不要太多文案，
用交互设计层面改善**，让不会用电脑的人也能快速上手。

- **整合的判据是「入口唯一」，不是"这一页太长"**：进价录入 / 汇率维护 / 店铺登记原先散在**三个模块**
  （「货与成本」两个页签 + 「算钱」页半区），用户为了记一家供应商要先猜"它在哪个模块的第几个页签"；
  「店铺登记」更是在两个模块**各有一份实现**（改一处忘一处）。现在全部维护只有一个家。
- **一级入口**：`shop-accounts` 模块更名「**基础数据**」，从「店铺管理」分组下的子项升为一级入口
  （分组整个撤销 —— 留着空分组会在侧栏渲染一个点不开的标题）；顺序排在「货与成本」之前（维护先行）。
- **新主视图** `src/modules/shop-accounts/MasterDataView.vue`（392 行，替下 1,595 行的四页签旧视图）：
  **左导航六资料种类 + 右内容区**（店铺账号 / 邮件 / 店铺登记 / 企业 / 供应商 / 成本与费率），
  默认落在第一项（「主数据页也要有起点」的落地 —— 并列的入口等于没有起点）。
- **迁移重设计**：供应商（原「货与成本 › 供应商」页签）、进价（原「货与成本 › 进价」页签，
  `CostPane.vue` 原样迁入，`data-act` 契约一个都没动）、汇率（原「算钱」页半区，`RatesPane.vue`）
  拼成「**成本与费率**」一个资料种类（`CostRatesPane.vue`）—— 对用户它们是**同一件事**：
  "算钱要用的两个基准数"；分成两个入口时，用户补完进价不知道还有汇率要补。
- **瘦身与跳转**：「货与成本」撤掉三个页签与组件 import（**漏一处 = 两个入口**，有守卫钉着）；
  行内出口（「现在登记」等）改为**跨模块跳转** `switchModule('shop-accounts', <kind>)`，
  由 TitleBar 的「返回」送人回来 —— 不是删掉了事（删了出口，队列里"店铺未归一"的行就成了死路）。
  「算钱」页汇率区改**只读展示**，区头「去维护」跳转基础数据（写入口唯一）。
- **守卫**：`tests/shopAccountsIntake.spec.ts` 新增整合专属断言（左导航六项存在性是 `uxEntryNames`
  豁免的锚点 / kind id 与跨模块 action **同一份清单** / goods 不再有三个页签与 import）；
  新建 `scripts/master-data-ui-smoke.mjs`（`npm run master-data:ui`，**74 断言 × 两遍视口**
  full 1440 + narrow 900）；`goods:ui` / `order-profit:ui` 相关断言整组搬家，并补**反向守卫**：
  录入控件整批消失、只读页一次汇率 upsert 都没发过。
- **连带修的四处基础设施问题**：① `order-profit:ui` 回程竞态 —— 点「去维护」后立刻派发切回事件会撞上
  `activateCore` 的早退守卫（在途激活未完成，`activeId` 仍是原模块）⇒ 静默哪都没去；
  冒烟改为**等目标模块 DOM 真的落地再切回**，且回程判据双向（`.oc-view` 在且 `.md-view` 不在）。
  ② `shopAccountsIntake` 扫描超时 —— 2026-10-03 笔记记过的坑（固定 I/O 写在 `it` 里顶穿 5s 默认超时）
  随模块涨到 26 文件**复发**；按该笔记把两次全量扫描提到模块作用域，用例 5.3s → 208ms。
  ③ `verify:docs` 抓到三处**搬家后没跟着走的文档引用**（`CostPane` / `SupplierView` / `ShopAccountsView`），
  逐一改指新路径；baseline「最大的 10 个文件」表同口径重数（榜首以下名次大变）。
  ④ `goods:ui` 两条红：其一，页签断言把 `mapFlat` 的返回值（**join 过的字符串**）当数组用，
  在字符串上恒假而 detail 打印正是那一个页签名 —— 看着"数据没问题"实则永远红；
  其二，导入那一步打开「导入产品」弹层后**整段没关**，而 `.click()` 绕过命中测试 ⇒ 状态污染一路"绿"，
  直到可达性断言（`elementFromPoint`）才红。红的是可达性、看着像布局坏了。
  该弹层的 ✕ 与「完成」原先没有 `data-act`（冒烟没法按锚点关它），补 `import-close` / `import-done`。
- 门禁：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest 38 文件 697 例` /
  `goods:ui` 291 / `master-data:ui` 74 / `order-profit:ui` 88 全绿。
  结论笔记：`docs/notes/2026-10-30-data-model-and-dependencies.md`。

### Added · 「店铺账号管家」UI 岛回收为内建模块，挂「店铺管理」二级导航（2026-10-14）

> ⚠️ **本条已被上一条「基础数据」整合取代其中的导航部分**（同日）：该分组已整个撤销，
> 模块升为一级入口「基础数据」，显示名与信息架构都改了。同日岛回收本身的结论仍成立。

计划：`docs/plans/SHOP_ACCOUNTS_INTAKE_PLAN.md`；结论笔记：`docs/notes/2026-10-30-shop-account-merge-and-status.md`。

- **迁移**：`ui-plugins/shop-accounts`（vite + Vue3 + Pinia 工程岛，源码 ~11,037 行）整体迁入 `src/modules/shop-accounts/`，**丢弃 11 个桥接/入口桩**——岛靠 vite alias 把 `@/core/services/*`、`@/types` 劫持到自绘桩文件，源码本就写的宿主路径，进宿主后 `@/` 直连真身；只有 2 个组件真用相对路径引 `api.js`（改 `@/core/services/ipc`），另有 `openHostSettingsPanel` 死导入一并删。
- **导航**：`ModuleMeta` 增可选 `parent`，新建 `src/core/nav.ts`（`NAV_GROUPS`），侧边栏出现「店铺管理」一级分组、可展开/收起（展开态进 `app-shell` 命名空间），「店铺账号管家」为其子项。不做"父模块中转页"。
- **设置**：`vite.config.ts` 的 `settingsPanelLoaders` 生成条件放宽到「任一模块根下存在 `settings.ts`」；`src/modules/shop-accounts/settings.ts`（安全设置 + 邮件设置）照常贡献进宿主设置中心。
- **数据零迁移**：与岛共用同一套 `electron/*-db.ts` + `ipc.*` 通道；`modules.shop-accounts` / `modules.shop-accounts-mail` 存储命名空间同键同形，用户配置自动继承。
- **安全面**：`sk-mail://` 正文 iframe 少一层 CSP 交集（宿主渲染页无 meta CSP）；`tests/islandMailFrameCsp.spec.ts` 改钉宿主 `index.html` + 内建模块。
- **类型补齐**：`ShopAccountUpsertInput` 补 `companyId`、`shopList` 补 `shopSetId` 过滤——岛内凭 alias 绕过宿主类型而实际缺失的字段，回收后首次纳入类型门禁。
- **岛下架**：`git rm -r ui-plugins/shop-accounts`（从未入库文件先 tar 留档 `/tmp/sellerkit-retire/`）；本机 `<userData>/plugins/shop-accounts` 副本备份后移废纸篓。**市场仓（独立 git 仓）的 zip 与 catalog 未动**——对外下架动作待用户确认。
- **守卫**：新增 `tests/shopAccountsIntake.spec.ts`（parent/目录/设置贡献/桥桩不存在/登记五类结构断言，变异复核打红后还原）；`tests/pluginManifest.spec.ts` 岛清单 −1、`tests/uxEntryNames.spec.ts` 岛名锚点改钉剩余岛。
- 门禁：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest 38 文件 695 例` 全绿。

### Fixed · 采集色图采纳写错表（P0）：色图改落订单域 `oi_images`，并消掉两份落库实现（2026-10-13）

实现复核（`docs/reviews/AE_SHOP_ITEM_SYNC_PLAN_IMPL_REVIEW_2026-10-13.md` P0-1）抓到的跨域脏写。

- **原状**：`shop-item-image-fetch` 用产品域 `landImageBuffer` 落 `pl_images`，却把那个 id 交给读写 **`oi_images`** 的 `adoptStyleColorImageByCode`。两表各自 `AUTOINCREMENT`、id 必然撞 ⇒ 一次"色图绑定成功"实际改的是**任意一张订单图**的 `style_color_id`（= 订单归类状态，方案 §8.1），回执还报 `bound:true`。而 `oi_images.style_color_id` 正是归类核对 / 拣货单 / 拿货单的判据（`picking-db.ts:121`、`purchase-db.ts:490`）。
- **落在哪个库由消费端定**：色图的用途是"订单导入后按图找到颜色"，而按图找色的唯一入口是 `order-download-image` 的**内容指纹命中**（`order-handlers.ts:584`，命中即复用那一行连带它的 `styleColorId`）——它只查 `oi_images`。落在 `pl_images` 里，闭环一次都不闭。
- **改法**：新建 `electron/order-image-land.ts` 作为「远程图 → `oi_images`」的**唯一**实现（下载 → 落 `userData/order-images/` → 两级去重 URL 指纹 → 内容指纹 → 登记）；`order-download-image` 与 `shop-item-image-fetch` 共用它，原先各自一份的落盘/去重/指纹代码删掉（根因不是参数传错，是存在两份实现）。`adoptStyleColorImageByCode` 的 `imageId` 改成品牌类型 `OrderImageId` ⇒ 再传 `pl_images` 的 id **编译不过**（TS2345）。
- **真库影响面 = 0 行**（只读盘点，`.backup` 出副本后统计）：`pl_shop_items` 表尚未建立、`pl_images` 10 行全是 `order-image` 来源 ⇒ `shop-item-image-fetch` 在真机上从未跑过；`oi_images` 里 24 条已绑定**全部**被订单引用，均为映射回填写的占位色。
- **守卫**：`shop-item:smoke` 的 5 条色图用例原是恒绿（夹具手工插 `oi_images`，而生产传的是 `pl_images` 的 id）。改为走**生产同一条** `landOrderImageBytes` 取 id，并新增三条：① 落点必须是 `oi_images`（指纹与字节一致、且不进 `pl_images`）；② **按图找色端到端闭环**（色图采纳 → 同内容不同 URL 再落一次 → 复用同一行且带着款色）；③ 反例（喂 `pl_images` 的 id ⇒ 不绑、`oi_images` 一行不许改）。**变异复核两条均已打红后还原**：改回 `fetchImageToLibrary` → `tsc` 失败；去掉内容指纹去重 → 闭环用例转红。

### Fixed · 手贴商品ID「点名了店铺却落未登记桶」（P1-1，2026-10-14）

复核报告的 P1-1（`docs/reviews/AE_SHOP_ITEM_SYNC_PLAN_IMPL_REVIEW_2026-10-13.md`）。

- **原状**：保底通道用「店铺 id → 取店实体 → 反查 url/storeId/name → `matchShopByStore`」定位店铺。而 `shop_url` 与 `platform_shop_id` 在 `sk_shops` 里**都是可选字段**，P0 之前登记的老店两个都空 ⇒ 反查必然落空 ⇒ 用户在弹层里明明选了「我的店A」，商品却写进 `shop_id=0` 未登记桶（`store_key="我的店A"`），回执还说"新增 1"；未登记行的勾选被禁用 ⇒ 认不了款。
- **改法**：**点名是证据，不是提示** —— `matchShopByStore` 新增 `pinnedShopId`（压过 URL / storeId 两级，且只在店铺真存在时生效，避免写出 `shop_id` 悬空的行）；`upsertShopItems` 新增 `opts.pinnedShopId`，帧不带身份（帧是"采到了什么"，pin 是"人说是谁的"）；`importManualItems` 删掉反查那条绕路，并改成**严格**语义：`getShop` 拿不到 ⇒ `ok:false` + 错误上行（handler 抛 ⇒ 弹层显示原因），绝不静默落桶。`shopId=0`（下拉里显式选的「未登记桶」）保持原语义。
- **守卫**：`importManualItems` 此前是**零用例覆盖**（不是"只覆盖了有地址的店"）。新增 5 条：点名到「只有店名」的店 ⇒ 落该店 / `store_key=''` / `source='manual'` / 未登记桶为空 / 汇总口径跟着对；点名到有地址的店；幂等（同店同 ID 再贴 = 更新）+ 空 ID 计 `skipped`；点名到不存在的店 ⇒ `ok:false` 且一行不许落；`shopId=0` 落桶语义不变。**变异两条均已打红后还原**：去掉 pin（改回反查身份）→ 第一条转红，而"有地址的店"那条**仍绿**（正是"夹具形状决定守卫有没有用"的实证）；去掉严格校验 → 反例转红。
- ⚠️ **派生缺口待决策**：`shopId=0` 的手贴行 `store_key=''` ⇒ 以后登记该店时 `adoptShopItemsForShop`（按 name/url/storeId 收养）收养不到它，会永久留在未登记桶。

### Fixed · 店铺登记「第二写入者漏透传 shop_url」（P1-2，2026-10-14）

- `upsertShop` 是**全量提交**：漏传字段不是"不改它"，而是把它**静默清空**。岛「店铺账号管家」是独立工程（自己的 `package.json` / vite 构建，拿不到宿主类型）⇒ TS 帮不上忙。顺着这条纪律扫全部写入点，**漏的是 3 处**（原报告只看到登记页那一处）：
  - `ShopRegistryView.vue`：编辑店铺 ⇒ 地址被清空 ⇒ 该店之后采集的商品**全部落未登记桶**（`shop_url` 是采集帧唯一的精确连接键）。补表单字段（地址输入框 + 回填 + 表列「打开」链接）与提交透传。
  - `AccountEditor.vue` **解除套装关联**：解绑一次 = 顺手清空地址（该函数注释里就写着"漏传任何字段都会把它静默清空"，自己就漏了）。补 `shopUrl: row.shopUrl ?? ''`，`SetShopRow` 类型补字段。
  - `AccountEditor.vue` 快速登记名下店铺：新建时无地址可填，但字段必须**出现** ⇒ 显式传 `''`（出现且为空 = 没填，不出现 = 漏传）。
- **新增门禁 `scripts/check-shop-upsert-fields.mjs`，接进 `npm run verify`**：必填字段清单**从 `src/types.ts` 的 `ShopUpsertInput` 读出**（不写死 ⇒ 加字段时清单自动跟着变）；认三种写法（岛 `shopUpsert(` / 宿主 `shopApi.upsert(` / 直连桥 `db.call('shop','upsert',…)`），透传点自动跳过；**空转守卫**（一处都没扫到 = 判失败）。当前扫到 4 处全绿；变异（删掉 `AccountEditor` 的 `shopUrl`）⇒ `❌ 漏传 shopUrl`，`EXIT=1`。
- ⚠️ **分发坐标**：岛产物 `ui-plugins/shop-accounts/dist/` 已重建（含 `shopUrl` / 「店铺地址」），但**已装机器** `~/Library/Application Support/seller-kit/plugins/shop-accounts/dist/` 仍是 10-05 旧产物 ⇒ 需重新发布/安装才能在界面上看到。

### Added · 速卖通店铺商品采集 P3–P4：建款向导 + 图片下载采纳（2026-10-13）

接 P0–P2 落地后两期（`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`）。向导**零新写口径**——三次既有 IPC（`product-upsert` → `variant-upsert`×N → `commitMap`）按「预填 → 人确认」组织，图片走方案 §3.6 唯一新增通道 `shop-item-image-fetch`。

- **P3 建款向导 `ShopItemWizard.vue`**：独立抽屉而非扩 `ProductEditorDrawer`（那边失焦即存，与「批量预填待确认」模型冲突）；档案区系统发号只读（`product-next-code` 复用 `nextStyleCode`）、名称/类目从采集事实预填、供应商必选（建档必须知道找谁拿货）；SKU 矩阵从 `sku_json` 预填（**落库时**已用订单侧 `parseSkuProps` 归一，渲染层不再解析第二遍）；**色号促确认**（D13）：`normalizeColor` 认不出时原样返回（"4"→"4"）⇒ 判据 `normalizeColor(c) === normalizeText(c)` 的行高亮 + 缩略图 + 说明，永不猜色名；回执说清「建了哪个款 / 写了几条 SKU / 几条失败 / 关联上没有」，可重入（既有行按 (color,size) 匹配传 `id` 走更新路径，不撞唯一键）。
- **P4 图片下载入库**：`shop-item-image-fetch`（下载 → `landImageBuffer` 内容去重 → 回填 `pl_shop_items.image_id` → 可选采纳）；`adoptProductImageIfEmpty` 在主进程判「只补空」不靠渲染层自觉；**色图采纳为款色绑定图**（`ensureStyleByCode` + `ensureStyleColor` + `setImageStyleColor`，与订单回流同一份款色解析，只补空）；下载失败**不外抛**（建档/关联已成立，坏图只在回执里写「主图没设上（原因）」）；`skus[].imageUrl` 落库、向导每色行带缩略图。
- **冒烟**：`goods:ui` 补 10 条（勾选默认态 / 色行缩略图 / fetch 调用出参 / 三遍回执：采纳、不勾选、下载失败）；`shop-item:smoke` 补 5 条色图采纳用例（17/17）；**变异复核 8/8 打红**后重建 dist 复跑全门禁。

### Added · 速卖通店铺商品采集 P5：扩展端稳健化 + SellerKit 侧保底通道（2026-10-13）

P4 收口后补最后一期（退路与采集端韧性）。遵循方案 §"后台改版选择器全落空时的退路"。

- **扩展端 `SellerKitExtensions/extensions/ae-profit` v0.2.0**：选择器稳健化（候选多选择器 + 双路 ID：`/item/<id>` href 优先、行文本回退；图片多源懒取）；列表轻采（无 SKU）+ 详情重采 SKU 矩阵（color/size/price/color-image 结构化拆解，props 原样透传、主进程 `parseSkuProps` 是唯一解析点）；**有界全店批量**（D14：手动触发、页数 ≤20、~900ms 延迟、失败跳过计数、可中途停、批次记录落 storage）；单条失败跳过 + 计数（一行坏数据不卡整批）。popup 三入口（本页 / 本店全部 / 采 SKU）+ 进度 + 停止 + 最近批次。jsdom 冒烟 19/19 + **变异复核 12/12 打红**。两个真 bug 已修：① 文本回退 ID 正则无捕获组 → 纯文本行 ID 静默丢失；② `\b` 锚点在 jsdom 拼接单元格下失效 → 改"前后非数字"断言。
- **SellerKit 侧保底通道**：新通道 `shopItemsImport`（契约五处同步：handler / preload / `types.ts` / `ipc.ts` 接口 + 顶层包装 / `api.ts`）。手贴商品 ID 列表 → 与采集帧**同一写路径** `upsertShopItems`，`source='manual'` 与 `scrape` 在 `pl_shop_items` 上分得开。`parseManualIds` 按换行/逗号/空白切分 + 去空 + 去重；**空输入不调 IPC、框不关、给校验错**；归属店铺默认=未登记桶（shopId=0，不渲染假 store）。`PoolPane` 加「手贴商品ID」按钮 + 导入弹层（店铺下拉 + 文本框 + 提交 + 校验错 + 成功自动关闭）。`goods:ui` 补 6 条断言（入口 / 默认店 / 空输入不动 IPC / 三行透传去重 / 落库即列表可见 / 成功关框），三遍全绿；**变异复核**：中和空输入守卫 → 断言转红（calls=1），证明守卫非恒绿。
- **真机手验抓到并修掉一个入口可达性 bug**：保底按钮原先只挂在采集工具条里，而该工具条整条被 `itemStats.total > 0` 包着 ⇒ **零采集时（正是扩展选择器全落空、最需要退路的时刻）按钮根本不渲染**。冒烟没抓到是因为假桥永远有商品行 —— 夹具只复刻了"合理形状"，没复刻"零数据"这个生产形状。已把入口补进「接入引导」空态（`data-act="items-manual-import-empty"`，与工具条那个共用 `openManualImport`），空态文案也点明这条退路；`goods:ui` 增 `__smokeEmptyItems` 零样本 + 3 条断言（空态而非空表 / 退路入口**可达** / 点开真的弹出框），变异（去掉空态按钮）→ 断言转红。

### Added · 速卖通店铺商品采集 P0–P2：店铺地址列 + 采集快照 + 右栏第三认款源（2026-10-13）

按 `docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` 落地前三期。三个输入源（待关联队列 / 店铺商品 / 已建立映射）、**一条**认款写路径（`commitMap` → `productSkuMap`），不新增第二套失败语义。

- **P0 `sk_shops.shop_url`**：建表 + `ensureShopColumns` 补列两处同向；契约五处同步（`ShopUpsertInput` / handler / preload / `types.ts` / `ipc.ts` 顶层包装）；登记表单加「店铺地址」（归一后落库，`normalizeShopUrl` 匹配两侧同口径）；列表行加「打开店铺」链接（给地址一个下游读者）。
- **P1 接收端 `POST /ae/shop-items/ingest`**：与订单端点同防线（token 鉴权 → 限速 → `ae-shop-item/v1` schema → 逐条消毒）；新表 `pl_shop_items`（快照，`UNIQUE(shop_id, store_key, item_id)` —— 未登记店不再互相撞键）；店铺匹配四级（URL 归一 → storeId → 同名建议 → 未登记落 `shop_id=0`）；新通道 `shop-items-list` / `shop-items-summary`；**登记后收养**未登记采集行（`adoptShopItemsForShop`，否则"登记了还不归位"）；`AeReceiverStatus` 加 `lastItemsIngestAt`（契约同步）。
- **P2 右栏「店铺商品」段**：三段控件（`data-act` 名不变，`sub-items` 为新增）；状态条（在线/端口/最近采集/已采数，全零不占位改接入引导）；未登记警告条与队列 `hint-shops` 同构；认款三态（未认款 / 已认到某款 / 店铺未登记）；勾选纪律（无平台或已认款即禁用）；直连 + 批量都走 `commitMap`，平台/店铺**从快照行带出**不写死；`goods:ui` 补 16 条断言（三态同屏 / 勾选纪律 / 写路径出参 / 筛选可逆）+ 窄窗口图列地板三条（列宽 ≥40px、图不压瘪、表格不出视口 —— 2026-10-12 auto 布局坑的回归守卫）。

**冒烟中新抓到的真 bug**：「只看未认款」复选框空转 —— `loadShopItems` 没把 `onlyUnconfirmed` 传给服务端（界面勾了筛选，拿到的还是全量）。已修，断言转绿。

### Docs · 审查：「速卖通店铺商品采集」方案 —— 通过并带修订清单（2026-10-12）

对 `docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` 逐条取证核对（约 30 处 `文件:行`，几乎全部精确；仅 2 处计数漂移、
1 处样本文件不在库）。方案"已有能力延伸而非新系统"的自我定位准确：接收端 / 落点表 / 认款写路径 / 店铺实体
全部在产，新增面确实只有「1 端点 + 1 快照表 + `sk_shops` 1 列 + 1 视图段 + 1 向导」。

审查稿 `docs/reviews/AE_SHOP_ITEM_SYNC_PLAN_REVIEW_2026-10-12.md`（未动任何代码）：

- **3 处 P1（方案级修订）**：①店铺 URL「精确相等」匹配在存量库会大面积失配（人贴的 vs 页面拿的不同形），
  改店铺级 URL 归一或与 storeId 规则合并；②未登记店 `UNIQUE(shop_id, item_id)` 会互相撞键覆盖 `store_key`，
  唯一键加 `store_key`；③P3「建档+关联单事务回卷」做不到（三个独立事务的 IPC + D3 禁复合 handler），
  改验收为「结构化回执 + 可重入」。
- **6 处 P2**：样本判据改指夹具、`img_key` 落点与唯一实现、向导 vs `ProductEditorDrawer` 的理由、
  §3.6 自相矛盾、断言计数指向脚本名、收工三件 + 门禁点名到脚本。
- **方案文档自身不过 `verify:docs`**（审查中已当场修）：§8.1 反引号路径引用兄弟仓库文件，本仓解析不到
  ⇒ 按守卫首选修法改 prose 形式（语义未动），复跑绿；方案 + 审查稿两行已登记 `docs/README.md`（计数 70 → 97，当场改）。
- **D1–D12 裁定**：10 条照办、2 条带条件（D11 `img_key` 落点待定义 / D12 建议移出本期）。
- **三处过度设计裁退**：§8 拆两期（先写入侧即闭合，读取侧 L2 建议缓一步）、砍 `ae_sync_log` 批次记录、
  `shop-items-summary` 暂缓。
- ⚠️ **开工前先理清工作区**：`git status` 99 个文件未提交，含本方案要碰的 7 个 electron 文件。

### Fixed · 「图片展示不全」二次复报 + 两个范围的样式（2026-10-12）

用户原话两条：**「待核对订单页面的图片展示不全」**、**「已核对和待核对页面的样式也有问题」**。
同一个"图片展示不全"在 2026-10-10 已经修过一次（`cover → contain` + `40 → 64px`）—— 原话复现说明
那一层不够。取证后确认：**图从来不缺角**（主进程 `thumbDataUrl` 等比缩放不裁切 + CSS `contain`；
真库 35 张里 31 张方图，"商品照多是竖版会被裁"这个注释在**这份真库上不成立**），
缺的是**尺寸**（64px 看不清印花 / 领型 / 颜色，而这一页的全部工作就是拿图比对）。

- **表格图 64 → 96px**，并新增**「点开看原图」**（`order-read-image` 不缩放，⤢ 角标**常显**、
  点整格都算点它）：与「货与成本」同一套既定解法（`goods/api.ts`：「认款要看清印花/领型/颜色，256 不够」）。
  三步刻意为之：先用**已在手里的缩略图**把弹层开出来（点下去立刻有东西看，不等磁盘）→ 读原图换上 →
  读失败**保留缩略图**（不比现在更坏）；连点只认最后一次（`viewerSeq`）。
- ⭐**真 bug：窄窗口下，图列被 `table-layout: auto` 压扁，图变成 12px 细条。** `.wb-table` 的列宽按
  "各列首选宽之和 vs 表格可用宽"算，**差额从每列抠**；已核对范围各列都是窄文本 ⇒ 图列从 112px 塌到 32px，
  而基座 `img { max-width: 100% }` 随即使图缩成 12px。待核对范围只因下拉框把表撑宽而侥幸逃过 ——
  **同一个窗口宽度下两个范围一个好看一个坏**。修法：图列要有**自己的地板**
  （`.cl-thumb-col { min-width: 112px }` + `.cl-thumb-btn` 定尺 96×96）。
  ⚠️ 别指望图片固有尺寸兜底：`max-width: 100%` 会让浏览器按**固有尺寸**算该列 min-content，
  缩略图固有尺寸很小（主进程 `maxEdge` 256）⇒ 列该塌还是塌。
- **页头同一件事只说一处**：删掉与分段控件重复的面板标题「待核对订单 / 已核对订单」——
  分段控件自带选中态 + 计数，是范围名的唯一真源。
- **操作列不再换行撑高行**：「保存 / 确认无误」`flex-wrap: wrap` 会换行成两行（5 行多占约 100px），
  改成 `nowrap`；判据是**几何**（两个按钮在同一视觉行），不是 DOM 结构。
- **已核对范围的空占位是冒烟夹具的漏洞，不是产品缺陷**：P-46 / P-47 的 `localPath` 是空串，
  而真库 **23/23 行全有图**、模板注释也要求"已核对范围同样要出图（退回的判据就是这张图定错了款）"
  ⇒ 这条注释此前**结构上无法被验证**（238 条断言一条都没覆盖它）。补夹具 + 补断言。

**门禁**：`today:ui` 238 → **249**（+11）· `tsc` / `vue-tsc` / `verify` / `verify:docs` ✅ ·
`vitest` **689 passed (37 files)** · `lint` 0 errors · `goods:ui` ALL PASS · `order:smoke` 全部通过。
**变异复核 11 条全部被抓住**（去掉图列地板 / `contain→fill` / 96→64 / 角标藏起来 / 操作列换行 /
页头加回标题 / 不先用缩略图顶上 / 原图不换上 / 读失败关弹层 / 去掉 `viewerSeq` / 缩略图只取待核对）。
新增取证脚本 `scripts/classify-shot.mjs`（`npm run classify:shot`，支持 `W=` 窄视口 / `THEME=dark` / `PROBE=1`）。
详见 `docs/notes/2026-10-30-order-classify-panel.md`。

### Added · 「退回待核对」：把单向的核对补成双向（2026-10-12）

用户核对完一轮、发现某行款色选错了 —— **没有任何入口能回去改**。真库现场：当天导入的 **23 行全部**
`corrected = 1`（都被「确认无误」过了），而全仓找不到任何一处会把 `corrected` 写回 `0`。

**这是能力缺口，不是 bug。** 待核对表按定义只查 `corrected = 0`；写 `corrected` 的两条路径
（`orderUpdate` 保存 / `orderMarkCorrected` 确认）**都只写 1** ⇒ 已核对的行在任何屏幕上都不出现，
也回不去。上一轮修完「设颜色不生效」之后，核对过的行才真的写对了数据 —— 紧接着就撞上"写错了也回不去"。

- **入口 = 页头范围切换**：原先那条只读计数「待核对 X · 已核对 Y」改成两个**可点**的范围
  （`.wb-seg`，与「货与成本」的「待关联队列 / 已建立映射」同一套基座）。切到「已核对」即列出今天这批
  已核对的行，每行一个「退回待核对」。
- **只做逐行，刻意不做「全部退回」**：一次退回整批不可逆（退回后分不出"本来就没核对"与"刚退回来的"），
  用户也看不出退回了多少。确认可以一键（错一行还有列表兜底），退回不行 —— **这个不对称是有意的**。
- **`electron/order-db.ts` 新增 `reopenOrdersCorrected(ids)`**：`UPDATE oi_orders SET corrected = 0
  WHERE id IN (…)`，**只翻这一位、不碰 `category` / `color` / `logo`**（退回是"我要重做"，不是
  "把你之前的判断抹掉"）。
- **契约四处同改**（新通道 `order-reopen-corrected`，payload `{ ids: number[] }`，上限 10000）：
  `order-db.ts` → `order-handlers.ts` → `preload.ts`（**入参裸数组**，无 `{ all }` 分支）→ `types.ts` + `ipc.ts`。
  ⚠️ handler 的校验段与 `order-mark-corrected` **刻意各写一遍、不抽公共函数** ——
  两条通道语义不对称，抽公共函数会把"它们其实不一样"这件事藏起来。
- **`src/modules/today/classify.ts`**：抽出唯一取数实现 `listPage(corrected, opts)`；`listPending`
  **保留原名**（避免既有 docs 引用失效）+ 新增 `listCorrected` / `reopenCorrected(ids)`.
- **`ClassifyPanel.vue`**：已核对范围的颜色/归属款两格改成**纯只读文本**（不是 `disabled` 的输入框 ——
  让"这里改不了、要退回才能改"在屏幕上一眼可见）；「同商品」徽标、说明句、「全部确认无误」都只在待核对范围；
  空态按范围分叉（已核对空态给"切回待核对"的出口）；`setScope()` 回到第 1 页、保留搜索词。
  ⚠️ **计数与产品库那两份取数不跟着范围换** —— 两个计数必须**同屏同时可见**（那是"这一轮做了多少"的唯一证据）。

⭐ **实测纠正一条直觉：退回与确认「互为镜像」** —— 都按点名的 id 直接写目标值、**不校验原状态**
（退回一行本来就待核对的行，实测 `changes = 1` 而不是 0）。与既有 `markOrdersCorrected` 的行为对齐，
界面层负责只把该出现的行露出来。

**门禁**：`today:ui` 223 → **238**（+15）· `order:smoke` **21 → 27**（+6，宿主侧唯一能验这两条 SQL 的地方；
⚠️ 基线旧记的「23 项」与实测对不上，已标口径更正）· `verify` 191/187 → **192/188**。
**变异复核 13 条全部被抓住**（含 handler 通道名写错 ⇒ `verify` 红），`grep -rn MUTANT` 无残留。
详见 `docs/notes/2026-10-30-order-classify-panel.md`。

### Fixed · 归类核对里「设了颜色不生效」：挂款链被一个字面空串整条短路（2026-10-11）

用户报「当前归类核对时设置的商品颜色还是没有生效」。

**根因：颜色写进了没人读的那一列。** 「颜色」在本仓有两个存处 —— `oi_orders.color` 只是**订单行自己的
属性**（归类页当草稿显示 / 搜索 `LIKE` / `skuBackfillFromOrder` 拿它当自动归色的提示），而颜色的**真正载体**
是 `oi_style_colors(style_id, color)`，经 `oi_images.style_color_id` 挂到图上；**拿货**（`outstanding()`
的聚合键 `style_code + color + size`）、**算钱**、**取图**（`findStyleColorImagePath`）、**商品ID 回流**
（`pl_shop_sku.spec`）读的全是 `sc.color`（`purchase-db.ts:488/787`）。只写第一列 =
用户所有看得见的地方都读不到它，而界面一切正常、`toast` 说「已保存」、行也离开了待核对列表。

断点在 `src/modules/today/classify.ts` 的 `saveCorrection`：`if (named && fingerprint)`。
`buildStyleFingerprint` 会把空项 `filter(Boolean)` 掉 ⇒ **`category` 与 `features` 都为空时它返回 `''`**
（falsy）⇒ 即便用户在下拉里**明确点名了款**，挂款 / 颜色记忆 / 商品ID 回流**一次都不跑**。
生产数据正是这个形状（真库实测：`oi_orders.category` 非空 **0 / 23 行**；`oi_images.result_json` 全 `null`
⇒ VLM 从没跑过 ⇒ `features` 恒空）。

- **`classify.ts`**：`if (named)`（不再要求 `fingerprint` 非空）。宿主侧签名本来就是
  `fingerprint?: string`（`order-db.ts:783`）—— **拦住它的是渲染层自己那道门**，不是接口能力不够。
  `fingerprint` 非空时行为与改前逐字一致。
- **`ClassifyPanel.vue` 新增 `colorUnattached`**：填了颜色却**既没点名款、指纹又是空** ⇒「保存」按不下去
  + 格子里写明原因。（保存下去只会写 `oi_orders.color` 并把行置为已核对、`toast` 还说"已保存" ——
  **与那 23 行真库现场同一个形状**。）它与既有的 `colorMissing`（有款没色）成一对：
  **款与色是「款 + 色」的两半，缺哪一半都不该放行。**
  ⚠️ 判据必须与 `saveCorrection` 用**同一个函数**（`buildStyleFingerprint`），另写一套判断 = 本 bug 的第二遍。
- **`confirmOne` / `confirmAll` 加脏改动守卫**：「确认无误」只把 `corrected` 置 1、**不写任何字段**，
  而它与「保存」就在同一格 ⇒「选完颜色直接点确认」是很自然的动作，那一下就把刚填的丢掉、行还离开了列表。
  单行与批量两版，提示措辞不同（批量那条报出「有 N 行」）。

**真库副本探针取证**（`sqlite3 <真库> ".backup /tmp/probe1.db"` + `ELECTRON_RUN_AS_NODE=1
./node_modules/.bin/electron <probe.cjs>` 调 `dist/electron/order-db.js`；⚠️ 原生模块按 Electron ABI
编译，纯 `node` 起不来）—— 订单 #204（`SUST-006`，图 #52）：

```
改前：fingerprint=""  [assignOrderStyle] 未调用
      oi_orders.color "" → "黑色"；oi_images#52.style_color_id 仍 53（未分类）；款色表不新增
改后：[assignOrderStyle] 已调用
      oi_images#52.style_color_id 53 → 57；新建 oi_style_colors{57, 黑色, SUST-006-BLACK}
      skuBackfill { status:'written', spec:'黑色', reassigned:2 }
```

⭐ **门禁全绿却没拦住的原因：夹具给的不是「生产形状」。** `today-ui-smoke` 原先给每行都填了
`category: 'T恤'` / `features: ['圆领','短袖']` ⇒ `fingerprint` 恒非空 ⇒ 那个洞在冒烟里**永远走不到**
（等于把被验的量写死）。现换成生产形状（P-43 无款无品类无特征 / P-41 有特征作对照 / P-45 点名款但指纹为空）。
**自问法**：这个字段在生产数据里有几成非空？答案是"零"时，夹具填上它就等于关掉了这条用例。

守卫分三段：渲染层的**门**（`today:ui` 216 → **223**，含「指纹为空也照样挂款：P-45 点名 S1 + 颜色 白
⇒ `orderStyleAssign` 被调用」）· 渲染层的**拦**（本轮两条新守卫）· 宿主侧的**写**（⚠️ **无自动化守卫** ——
改 `assignOrderStyle` 的款色写入或 `oi_style_colors` 唯一键时，冒烟只会说"通道被调用了"，不会发现"写歪了"；
目前只有一次性探针，要收进 `scripts/` 才能长期生效）。**变异复核 3 条**逐条打红：恢复 `&& fingerprint`
（诊断 `{}` = 通道根本没被调用，**原地复现用户现象**）· `canAttachColor` 恒定 false · 拆掉确认守卫。
详见 `docs/notes/2026-10-30-order-color-source.md`。

### Fixed · 拿货单明细的图片「都是一样的」：取图口径补上「尺码」（2026-10-11）

用户报「拿货单中的图片为什么都是一样的？拿货单明细的图片应该使用的是订单 Excel 中解析出来的图片，
例如订单 1123192657411338 存在多个商品，需要按顺序对应」。

**根因不是图错了，是挑图的口径比行粗一层**：订单 Excel 解析出来的图挂在**订单行**上
（`oi_orders.image_id` → `oi_images.local_path`，即那一件商品的「产品图片链接」），而拿货单明细行的
粒度是**款色 × 尺码**（`outstanding()` 的聚合键 = `purchase_items` 唯一键），取图却只认**款色**
（`findStyleColorImagePath(styleCode, color)` + `ORDER BY i.id DESC LIMIT 1`）⇒ 同一款的所有行
（不同尺码、各来自不同商品）全部落到「该款色下 id 最大那张」。

真库取证（拿货单 #32，5 行 `SUST-006 · 未分类`）：改前 5 行**全**是 `oi_images#52 eead0796ee0.webp`；
改后 S→#48 / M→#44 / L→#45 / XL→#52 / XXL→#48 —— **改前 4/5 行的图不是自己那件**。

- `order-db.findStyleColorImagePath(styleCode, color, size = '')`：新增可选 `size`，`ORDER BY` 变成
  `CASE WHEN EXISTS(该尺码的订单行用过这张图) THEN 0 ELSE 1 END, i.id DESC`。
  **用 `EXISTS` 不用 `JOIN`**（一张图会被多个订单行引用，JOIN 会放大候选行 ⇒ `LIMIT 1` 取到谁不确定）；
  该尺码**没有**订单行（手工加的行 / 订单还没导入）才回落款色级最新图 —— **有图仍优于缺图**；
  **不传 `size` 时行为与改前逐字一致**（既有只按款色的调用方不受影响）。
- `purchase-handlers` 两处调用点（`purchase-style-images` 与 `purchase-export-excel` 的嵌图）都传 `size`；
  `preload` / `types.ts` / `ipc.ts` / `purchase.ts` 契约同步（`purchaseStyleImages` 入参加 `size?`）。
- `PurchaseOrderEditor.vue`：行图键从 `款编码|款色` 改成 `款编码|款色|尺码`；`pue-size` 加 `@change`
  **只重查这一行的图**（尺码是取图键，但与单价无关 —— 不碰历史价）。新增行 `resolvedNoImage` 改为
  **显式判 `styleCode` 为空**（键变三段后 `'||'` 这种字符比较是脆的隐式契约）。
- ⚠️ 「未分类」不是根因、只是放大器：真库 10 行款色全是 `未分类` 占位（颜色从未配过），它让整款的图
  挤进同一个款色；但**颜色配齐也治不好**，同款同色的多件商品仍会共图。

守卫三层：`today:ui` 215 → **216**（渲染层的键）· `ipc:shape:smoke` 34 → **37**（preload 透传 + 真库 JOIN）
· `purchase:xlsx:smoke` +3（导出调用点的入参；⚠️ 那段 `findStyleColorImagePath` 是 **stub**，
改坏 SQL 它照样绿 —— 已在注释里写明边界）。**变异复核 3 条**逐条确认变红：丢 `pairKey` 的 size
（诊断 `L=… | M=…` 两张 src 相同，**原地复现用户现象**）· preload 丢 size · 删 SQL 的 `CASE`。
详见 `docs/notes/2026-10-30-purchase-merge-and-images.md`。

### Changed · 「发货台」命名 + 每日口径 + 回执结论卡 + 归类动作计数（2026-10-11）

用户对「今天」这条主线提了四问：① 导入订单后记录不知道去哪了、反馈信息模糊、文字太多、完全看不懂；
② 做完归类核对后订单不知道在哪；③ 是不是只该展示今天导入的记录（工作流是"每天上班导前一天 → 导出时点"
的全部订单，中途追加的也算今天要拿的货；拿货数量未必等于订单商品数量 —— 取消 / 厂家没货等场景要考虑，
**但别过度设计**）；④ 是不是该改名「今日拣货台」。

**用户拍板**：名称 = **发货台**；口径 = **1–3 步按「今天导入」、4–5 步按「未结清」（跨天结转）**；范围 = 四问全做。

**改名（`src/modules/today/meta.ts` / `TodayView.vue`）**

- 只改**显示名**（`name` + 页头 `<h1>`），**模块 id 仍是 `today`** —— 改 id 会断 `knownModules` / 深链 / 市场 id。
- 连带扫掉注释里的旧指路（"今天 › 拿货"这类）以及 `tests/uxEntryNames.spec.ts` 的两处说明 ——
  悬空入口名守卫**扫前会 strip 注释**，所以注释不同步改它是看不见的，得手工 `grep -E`。
- ⚠️ 「今天」在**结算对账的时间窗分段控件**里是**日期语义**（`{ id: 'day', label: '今天' }`），不是模块名，未动。

**新增 · 订单取数支持按「导入日」筛（1–3 步）**

- 筛的键是 **`date(created_at)`（导入时间）**，不是 `order_time`（下单时间）：昨天下的单今天导，
  就该落在今天这批里。契约四处同改：`electron/order-db.ts`（`shippingRows` + `listOrdersPage`）→
  `electron/order-handlers.ts`（新增 `sanitizeImportDate`，只放行 `yyyy-mm-dd`）→ `electron/preload.ts` →
  `src/types.ts` + `src/core/services/ipc.ts`。
- ⚠️ 只改 `IpcApi` 接口、漏改 `ipc.ts` 顶层的包装签名时，`vue-tsc` 才报"属性不存在" —— 契约是**四处**不是三处。
- `src/modules/today/classify.ts` 的 `listPending` / `pendingCounts` 同步加 `importDate`；
  新增 `src/lib/localDay.ts` 收敛三处"今天"（`localDayKey()`，**不用 `toISOString`** —— 那是 UTC，跨时区会错一天）。
- **4–5 步（拿货 / 对账）不动**：它们走"未发货近 30 天 / 未结清"，天然跨天结转。

**Changed · 「算钱」一份视图两个口径，并写明作用域（`src/modules/order-cost/OrderCostView.vue`）**

- 加**可选** `importDate` prop：内嵌在发货台（`CostPanel`）时传今天；独立模块入口不传 = 全库（改造前行为）。
- 页面上用「今天导入」药丸（`data-act="oc-scope"`）**写明作用域**，总览的订单卡同样加 `data-act="orders-scope"`。
  理由：同一页里两个数不一样时用户没法判断谁对。标签**只在有数字时**出现（空态那句自己已交代范围）。

**Changed · 导入回执拆两层（`src/core/services/importSheet.ts` / `tabs/ImportPanel.vue`）**

- `AutoImportResult` 新增 `headline`（**大字结论**，一行说清结果）与 `warnings[]`（**异常行**：跳过 N 行 /
  主图没下来 —— 凡是"用户要采取行动"的，**平铺不折叠**；空数组则一个字都不写，不写"无异常"这种不携带信息的话）。
  原 `message` 保留为**判据**，界面上**默认折叠**在「怎么看出来的」里 —— 原先它与结论揉成一坨，正是"文字太多"的来源。
- `ImportNextStep` 的 `moduleId` 改可选、新增 `tab`：目标在本页页签就写 `tab`（**就地切页签**）。
  主操作**两场都是**「去核对这些行」(`classify`) —— 修掉"流程卡说第 2 步才是当前步、回执却把人送到第 4 步拿货"的自相矛盾；
  次操作按店铺**未归属 → 「去『算钱』归店铺」(`cost`) / 已归属 → 「去看要拿什么」(`purchase`)** 分叉，两支分别有断言。

**Added · 归类页「待核对 X · 已核对 Y」+ 空态三出口（`tabs/ClassifyPanel.vue`）**

- 页头 `data-act="cl-counts"`：这不是被撤掉的"指标条"复活，而是**这一页的动作计数** ——
  这页的动作是"逐行核对 → 那行离开列表"，做完一轮原先**看不出自己做了多少**，列表一空只剩一句"都核对完了"，
  无从判断"真核完了"还是"这批本来就没有"。两个数**必须同一个筛**（都按导入日），否则两边之和会大于这批行数。
- 空态按**原因**分三支（提示不是入口，说明里的下一步必须点得到）：没导过 → 「去导入订单」`cl-goto-import`；
  搜不到 → **不给按钮**（清空搜索框就在旁边）；核完了 → 「去算钱」`cl-goto-cost` + 「去看要拿什么」`cl-goto-purchase`。
- 空态标题改「**今天还没有导入订单**」：只数今天这批时，「还没有订单数据」是**假话**
  （库里可能有前几天的单，用户会以为数据丢了）。

**Fixed · 冒烟夹具与真实 SQL 语义不一致，导致一条断言恒绿（`scripts/today-ui-smoke.mjs`）**

- 假桥 `orderList` 原先在 `corrected` **未传**时只回"待核对"行；而真实 `listOrdersPage` 的语义是
  **未传 = 不过滤（全表）**。于是新加的「核对过的行不该出现在待核对表里」这条断言**永远绿**
  （桥根本不可能返回那些行），"列表漏传 `corrected: false`"这个回归抓不到。
- 修法：让假桥照抄真实语义（`undefined` ⇒ 全部，`true` / `false` 才按列筛）。此后对应的变异体真的能打红。
  **通用教训**：夹具要连"被依赖的结构"（参数语义 / 缺省行为 / 分页边界…）一起复刻，不能只复刻内容。
- 新增/改写断言：口径标签 + 「只数今天导入的」（配**三天前导入**的反向夹具 `IMPORTED_OLD`）·
  回执结论卡 6 条（大字结论存在且**真的比明细大**（读计算样式）· 判据默认折叠 + 点开能展开 · 无异常时不出现异常块 ·
  主/次操作与落点）· 归类页计数（夹具刻意给 5 待核对 + 2 已核对，**不相等且都不为 0**，
  否则"计数坏了恒返回 0 / 两个数相等"都分不出来）· 「都核对完了」空态与它的两个出口（新增 `__allCorrected` 开关，
  与 `__noPendingOrders`（什么都没导）**分开造**，否则"核完了"这条路径在冒烟里走不到）。
- 门禁：`vue-tsc` · `tsc -p tsconfig.electron.json` · `verify` · `verify:docs` · `vitest run`（689 通过）·
  `lint`（0 error）· `build` · `today:ui`（**215** 项）· `goods:ui`（271 项 ×3 遍）· `order-profit:ui` 全绿；
  **变异复核 6 条**逐条打红后 `grep -rn MUTANT` 清零。笔记见
  `docs/notes/2026-10-30-shipping-desk-and-rate.md`。

### Changed · 「今天 › 算钱」只留有用的信息：撤说明、并同类、把缺口做成筛子（2026-10-11）

用户反馈："重新优化设计今天--算钱页面，只展示有用的信息，要简洁，不要过度设计，减少提示文字，
要从交互让用户真正会用。"（落到 `src/modules/order-cost/OrderCostView.vue` —— 内嵌形态就是该页签。）

**删掉的（判据各不相同）**

- 指标条里的 **「各环齐全 N」** —— 它与下一行的缺口说的是同一件事（齐不齐），而缺口的说法具体得多
  （缺哪一环、几行）⇒ 同一件事在页面上**只说一处**。指标条现在只有钱的五个数。
- **「缺哪一环：」「经营状态（利润合计只含非关闭单）：」** 两个标签 —— 两边的 chip 自己就说清了是什么。
- **「在途单结算前平台不给费用，只能估」** —— 它解释的那个动作（"去配费率"）就在旁边；
  用户不需要懂在途单结算规则，只需要点那颗按钮。
- **「只作用于订单自己没写税的行」「多件…（多件合并计费尚未支持）」** 两句长尾 ⇒ 进 `title`。
- 统计面板头的 **「只含非关闭单」** —— 同一句口径的第二遍。那唯一一次改放指标条
  （`不含已关闭 N 行`），**且只在真有已关闭单时出现**（零的正确表达是不出现，不是"不含已关闭 0 行"）。
- 空态里 **「点『导入 Excel』…」** —— 这一页没有这个按钮（按钮写的是「去『导入订单』」），
  文案点了一个不存在的东西。现在说明只讲"能得到什么"，"点哪里"交给那颗按钮。

**⭐ 真正的交互改动：缺口从"提示"变成"筛子"**

原先「缺克重 1」是一颗点不动的 chip：它说"有 1 行缺克重"，却**没有任何办法知道是哪一行** ——
几百行的明细表里只能逐格去找。现在点它 ⇒ 明细表**只留带这个缺口的行**，面板头出现
「只看 缺成本 ×」，再点一下 chip 或点 × 撤掉。

- **形状必须区分开**：只读标签是**实心药丸**，可点的缺口是**描边按钮**（悬停填底、激活变实心）。
  交互藏在看不出来的地方等于没做 —— 光加 `cursor: pointer` 不够，用户不会去悬停每一颗 chip。
  于是体检行天然分成两半：**左边"要做的事"（可点）、右边"现状"（只读）**，中间一条竖线，
  连"缺什么 / 现状如何"两个标签都省掉了。
- ⚠️ **重算时必须清空筛选**：换来源 / 改税口径之后，原来那个缺口可能已经不存在了，
  留着筛选会变成"表格空着、头上还写着只看缺X"的**静默失效**。
- ⚠️ **筛选态必须看得见、也必须撤得掉**：表格忽然只剩一行而不说明原因，用户会以为数据没了。

守卫：`order-profit:ui` **82 → 86**（指标条那条拆成两条，其中一条反向钉住「各环齐全」那格不再回来；
新增 3 条缺口筛选断言 —— **是可点按钮** / **点下去行数真的 2 → 1 且留下的正是那行** / **可见可撤**。
三条缺一不可：只断言"点下去有点反应"是空转，弹个 toast 也能绿）。`.vue` **未动任何既有 `data-act` 名**
（只删了 `metric-complete`、新增 `gap-filter` / `clear-filter`）；`today:ui` 199 / `vue-tsc` /
`tsc -p tsconfig.electron.json` / `verify` / `verify:docs` / `lint` / `vitest` / `build` 全绿。
断言细则与两条踩点见 `docs/notes/2026-10-30-cost-maintenance-and-retire.md`。

### Changed · 「今天 › 导入订单」二次收口：撤掉说明文字，改由交互自己讲（2026-10-11）

用户反馈："'导入后这里会留下一张回执'这里的区域去掉，尽量少有提示文字，要从交互设计中让用户会用。"

- **删掉空态占位卡**（原 `data-act="import-none"`，写着"导入后这里会留下一张回执"）：它是一段
  **在任何状态下都不对应界面上任何东西**的自我说明 —— 占位置、每次导入前都要读、读完还不一定信。
  回执本身就在投放区正下方，导一次自然就见到了。**空态现在就是投放区自己。**
- **删掉投放区副标题**（"点这块任意位置选文件，也可以直接把文件拖进来"）：它讲的两件事界面已经在讲
  —— 主按钮 = 点击入口，虚线框 + 上传图标 = 可投放（拖到上面变实线 + 标题换"松手就导入"）。
- 主按钮 `选择 Excel 文件导入` → **`选择 Excel 文件`**（本页就是导入页，"导入"二字不必再说）。
- 判据：一句话值不值得留，看它**有没有对应的界面事实**。有事实兜底就撤文字；没有兜底就是便签。
- ⚠️ 连带改断言：原"关掉回执后回到空态指引（文案含 `Excel` / `回执`）"实际是在**把一段说明文
  锁进测试** —— 换成"回执撤掉后**无残壳 + 投放区还在 + 主按钮未被禁用**"（空态少句话不影响任何人，
  **入口没了才是致命的**，而"关回执顺手禁了入口"这类 bug 原来测不出来）。
- ⚠️ 另补一条**非空转**的交互守卫：拖 `dragenter` → 断言**计算样式** `border-style: dashed → solid`
  且标题变"松手就导入"，`dragleave` 后复原（文字撤掉后，这就是用户**唯一**的引导；读计算样式而非
  `is-over` class —— class 挂上但样式被覆盖时用户照样看不见，只查 class 会恒绿）。

守卫：`today:ui` **198 → 199**（−1 钉文案那条，+2 干净空态 / 拖入高亮）。

### Changed · 「今天 › 导入订单」重做成投放区（可点可拖）+ 回执卡精修（2026-10-11）

上一轮只做了减法（删页首说明、空态改成两行预告），**最核心的交互缺失没解决**：导 Excel 最常见的
动作是"从资源管理器把文件拖过来"，而这一页全页只有一个按钮，拖进来毫无反应。本次整页重排。

- **投放区（`data-act="import-drop"`）**：虚线框 = 约定的"可投放"语义，悬浮 / 拖入时**同时**换边框
  样式（dashed → solid）与颜色（只换底色在深色主题下读不出来）。区里是上传图标 + 状态标题
  （`把订单 Excel 拖到这里` / `松手就导入` / `正在识别并入库…`）+ 主按钮 + 四类可识别文件
  的标签（原先埋在空态那句长括号里，扫不动）。
  <sub>（原还有一行副标题，已于同日二次收口撤掉 —— 见上一节。）</sub>
  ⚠️ **点击 handler 只挂在区块上、按钮不另挂** —— 按钮的 click 冒泡上来就够；两个 handler 并存
  会让一次点击导入两次，而导入**非幂等**（同一份报表导两遍 = 订单行翻倍），所以从结构上只留一条
  路径，而不是靠"记得写 `stopPropagation`"。`data-act="import"` 仍在按钮上（既有断言点它）。
- **拖放导入**：`dragenter/dragover/dragleave/drop`（enter/leave 在子元素间会反复触发 ⇒ 用计数器
  判定，指针划过图标时高亮不闪）。字节来自渲染层 `File.arrayBuffer()`，与对话框选文件的 `ArrayBuffer`
  **同形** ⇒ 容器里抽出一条 `runImport(src)`：识别 → 落库 → 回执 → `bump`。"选文件"与"拖文件"
  只是**字节从哪来**不同，链路只有一份（否则拖放那条路会慢慢长成"少刷面板 / 不写回执"的半截实现）。
  重入守卫：导入进行中再拖/再点一律忽略（导入非幂等，而投放区整块可点，连点两下很容易发生）。
- **库内现状条（`data-act="import-stock"`）**：原先是一句挤在按钮右边的灰字（`当前库里有 N 行订单`），
  按钮一动它就跟着跑；现在拧成 行数 / 导入 / 采集 / 最近下单 四项可扫的数。
- **回执卡**：状态徽标上色（`已导入` 成功绿 / `未写入` 警示橙），补 0.2s `translateY + opacity`
  入场（`prefers-reduced-motion` 下关闭）。
  <sub>（原还配了一张同位置同尺寸的虚线占位卡"导入后这里会留下一张回执"，已于同日二次收口撤掉 ——
  见上一节。回执自己的入场动画已足以避免"状态切换跳到没见过的地方"。）</sub>
- 全页文案随之调整。
  <sub>（原文："空态两句仍保留'选什么文件 / 导完留下什么'，含 `Excel` 与 `回执` 两个既有断言的判据"
  —— 那两句已随占位卡删除，对应断言也已换掉。）</sub>

守卫：`today:ui` 192 → **198**（+6：投放区存在 / **整块可点**（点区块本身、非按钮，也拉起选文件）/
认不出的表走同一链路且不写库 / **拖入真的导入**（`orderInsert+2`）/ 拖入后同样留回执 / 四类标签）。
`.vue` **未动任何既有 `data-act` 名**（新增的只有 `import-drop` / `import-stock`），`.td-*` 类名亦未改
⇒ 既有 192 条断言原样重挂。断言细则与两条踩点（**重入守卫吞并发拖放制造的假红**、合成 drop 事件
的写法）见 `docs/notes/2026-10-30-order-import-pipeline.md`。

### Changed · 「今天」四页内容设计收口：导入订单 / 归类核对 / 算钱 / 结算对账（2026-10-11）

页签栏按用户裁定还原后（设计对象 = **各页签内的页面内容**，见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`），
按流程顺序把剩余四页各过一轮。统一判据：一屏只回答"这一步要做什么"；文案压到"看一眼就懂"的量；
空态必须给一个**可点的下一步**。拿货页刚重做过，本轮不动。

- **导入订单**：删页首整段说明（与回执、空态重复，白占视线）；空态从半屏居中空卡改成**回执位的
  一份预告**（两行：选什么文件 / 导完留下什么）；成功与未写入**只留回执卡、不发 toast** —— 回执
  是常驻的、toast 是几秒即走的同一句话，两张一起出现只是重复且 toast 会盖右下角（错误路径仍发）。
  回执落点行改说「数据落到了 X —— 本页「Y」看得到」。
- **归类核对**：页头操作说明收成**一行**（点名「归属款」→ 选色 → 保存 / 确认无误 + 回车＝保存并
  跳下一条；原三行文案连"为什么要点款"整段解释一起删）。
- **算钱**：内嵌时**藏掉页内「刷新」**（容器页头的 `bump()` 是超集、波及所有面板）；空态重写 ——
  不再拿「宿主 / 插件」向用户解释内部架构（§1.10 禁用词），改说"点「导入 Excel」会得到什么"；
  运价表缺失的 toast 不再指向"可能没装的岛"，改指「今天 › 导入订单」的报价单入口（指死路＝没有出口）。
- **结算对账**：同一条裁定删掉页内「刷新」；厂家账**只列窗口内有账的厂家**（对账 op 是
  `FROM suppliers` 出全量 —— 真库 6 家里 5 家恒零，全列出来是常态噪音，不是"账"）；删付款 / 删退款
  的确认文案按**类型分叉**（差额 = 拿货 −（已付 − 退款）⇒ 删付款欠款**回升**、删退款**减少**，
  方向相反；旧文案把两笔账糊成一句、对退款是反的）；店铺视图空态补**可点出口**（「去拿货」就地切
  页签，不跳页）；厂家账清零空态步号修「第 5 步」→「第 4 步」（六步→五步后拿货顺位成第 4 步的漏改文案）。

守卫：`today:ui` 185 → **192**（+7，断言细则与踩点见 `docs/notes/2026-10-30-mail-and-today-pages.md`）；
`order-profit:ui` 空态断言追加两条词守卫（不出现「宿主」「插件」；⚠️ 该脚本计数同日实测为 **81**，
基线旧记 64 系陈旧快照，已更正）。`.vue` 未动任何既有 `data-act` 名 ⇒ 既有断言原样重挂。

### Changed · 「拿货单」编辑器按用户反馈再修：身份列去「输入框样」· 行尾改文字动作（2026-10-10）

用户两点反馈：「拿货单中的款色和尺码为什么要用输入框的样式？现在操作区的两个按钮完全不知道
是什么意思。」——两条都成立，各改各的：

- **款编码 / 颜色 / 尺码改「幽灵输入框」**（新类 `.pue__ghost`）：默认无边框、无底色（看着就是
  文字）；悬浮只出一条边框（提示"可点"）；聚焦才还原完整输入框（边框 + 焦点环 + 浅底）。这三个是
  清单带过来的**身份数据**（人只偶尔修正），每格画框会把整行读成"这里有三个框等我填"；
  **实拿 / 单价保留输入框** —— 那两个才是"等你填"。⚠️ 用 `:focus` 而非 `:focus-visible`（基座
  `.wb-input` 的 focus-visible 只服务键盘环；ghost 常态像纯文字，鼠标点进去若不还原外观就没有
  "我在编辑"的反馈）。**可编辑性一字未动**（手工加行、现场改色照旧）。
- **行尾 ↻ / ✕ 图标改文字动作**「取最近价」「删除」（`.wb-link` / `.wb-link--danger`，与
  「拿了什么」列表的行尾动作同一套惯例）—— 图标说不出含义，"完全不知道是什么意思"就是原话。
  宽度代价：操作列 60 → **66px**（12px「取最近价」在 60px 里会挤断行）、单元格 padding 收 4px；
  ⚠️ 覆盖 td padding 要写 `.pue__table .pue__ops`（同层内 `.pue__table td` 0-1-1 压过裸
  `.pue__ops` 0-1-0）。上一条重设计里"文字链接改图标"的决定**同日被本反馈推翻**。

守卫：`today:ui` 183 → **185** —— ①「款色 / 尺码默认无边框无底色（`getComputedStyle` 逐项比
`rgba(0, 0, 0, 0)`），实拿 / 单价仍有框」②「行尾两个动作 `textContent` 恰为「取最近价」「删除」」；
上一条重设计加的两条几何 / 可达性守卫**自动重挂**（判据含 `contains`，子节点是文字还是 SVG 都
吃不倒）。⚠️ 本轮又踩**模板字符串转义陷阱**两次（该冒烟脚本浏览器侧整段嵌在模板串里，**正则
与注释都是字符串内容**）：① 新守卫正则里的转义括号被**剥成半个括号** ⇒ 诊断值全对、断言恒红，
判据改**字符串相等**；② 为解释 ① 写的注释里又写转义 ⇒ ESLint `no-useless-escape` 报 error。
两条都已写进脚本注释。见 `docs/notes/2026-10-30-purchase-card-and-editor.md`（文末「同日反馈修正」）。

### Changed · 「拿货单」编辑器整页重设计：8 列一行放下 + 行尾动作可达（2026-10-10）

用户：「帮我重新设计拿货单页面，当前页面看着很别扭」——**先取证再动手**：新增
`npm run purchase:shot`（复用假桥 + CDP 截图 + 几何 PROBE）拍下改前形态，确诊「别扭」的根因
**不是审美而是一个数字**：8 列明细表固有宽度 658px > 抽屉内容区 527px ⇒ 「金额(元)」列被裁半边、
行尾操作列 **x=1475 落在 1440 视窗之外** —— 静默不可达（点不到、也无任何报错）。

- **抽屉 560 → 620px**，表格改 `table-layout: fixed` + `<colgroup>`（图片 48 / 款色吃剩余 /
  尺码 54 / 建议 40 / 实拿 60 / 单价 80 / 金额 76 / 操作 60）—— 8 列一行放下，不再横溢出。
- **行尾两个文字链接改图标按钮**（↻ 取最近价 / ✕ 删本行，`title` + `aria-label` 兜底）：
  原先在 80px 列里竖排挤成三行，也是表格宽度的最大贡献者。
- **款色格去「·」**（改 placeholder「款编码 / 颜色」）· **顶部两行（日期 label + 提示句）并成
  一行工具条** · 页脚加「共 N 行」（**包价单不加** —— 它没有"行"的概念）· 行内 padding 9 → 5px
  （行高 77 → ≈58）· 行 hover 高亮（连同首格，首格 sticky 不跟着换会在横滚时断层）。
- **兼容底线一个没动**：`data-act` 全保留 + 表头 8 格文字逐字不动 ⇒ 既有 181 条断言原样重挂。

守卫：`today:ui` 181 → **183** —— 新增两条**几何/可达性**守卫（此前这类问题是零覆盖）：
①「明细表不横向溢出」（`wrap.scrollWidth ≤ clientWidth`）②「行尾两个按钮在视口内且
`elementFromPoint` 命中」（按钮里是 SVG ⇒ `contains` 判）。两条都做了**变异确认**：去掉
`table-layout: fixed` → 溢出条红（590/587）；加 `min-width: 700px` → 两条都红（诊断给出行尾
按钮坐标 791/815 vs 视口 800）。见 `docs/notes/2026-10-30-purchase-card-and-editor.md`。

### Changed · 「拿货单」明细表改列：图片 + 款色合并 + 按款色取行图（2026-10-10）

用户要求「拿货单中，列表中展示**图片、款色、尺码、建议、实拿、单价、金额**」——明细表从
`款编码 | 款式名 | 颜色 | 尺码 | 建议 | 实拿 | 单价 | 金额` 收敛为
**图片 / 款色 / 尺码 / 建议 / 实拿 / 单价(元) / 金额(元)**：

- **款色合并**：款编码 · 颜色双输入并进一格（数据与出参一字未动，只是排版）；款式名保留为该格下
  的**只读灰字**（权威在产品库，ADR-002 D1）。手工加行 / 取最近价 / 删行 原样。
- **行图**：新通道 `purchase-style-images`（`purchase-handlers`）按「款编码 + 款色」批量查本地图路径
  —— 复用 **`order-db.findStyleColorImagePath` 单一实现**（拿货单 xlsx 导出早就用的同一个函数），
  渲染层再走既有 `orderImageThumbBatch` 出缩略图。三分态：还没查 / 查过没有（「缺图」占位）/ 有图。
- **图是装饰**：取图失败整体静默（空占位），绝不拦录入与保存主链路；改款色才重查，改回同款色走缓存
  不重复往返。

守卫：`today:ui` 175 → **181**（列集合逐列钉死 · 款名只读 · 取图入参按款色 · `<img>` 真解码
`naturalWidth > 0` · 改 S9 给「缺图」· 改回不重复请求；变异【表头改字 + 取图恒空】验证 5 条全红）；
`ipc:shape:smoke` 30 → **34**（新增 §⑨ 段：真 preload + 真 handler + 真库 JOIN 逐项对位 / 载荷透传 /
空清单 / 500 上限；变异【preload 漏传 items】3 条红 —— 该失效形态与 `orderImageThumbBatch` 事故同形：
**每行都显示「缺图」且一条错都不报**）；`verify` 通道 190/186 → **191/187**。

### Changed · 「拿货单」删掉「备注」整条链 · 「模式」改页头只读标签（2026-10-10）

用户问「拿货单中，列表中展示图片、款色、尺码、建议、实拿、单价、金额。**模式是什么？备注的意义是什么？**
如果没有可以去掉，界面尽量简洁，不要过度设计」——逐条溯源后裁决：**模式保留、备注整条删**。

- **模式（mode）保留**：它有两条**互不相同**的真实下游行为 —— `detail` 明细金额 = Σ(实拿 × 单价)、
  行参与拿货缺口扣减与成本同步；`package` 包价只记总额、**只参与厂家对账**、不扣缺口不进成本。
  但 `purchase-order-update` **不接受 mode**（创建时定死）⇒ 原编辑器里的下拉框是"改不动的假动作"，
  改为**页头只读标签**（`pue-mode-tag`，措辞与列表逐字一致），界面更简、语义不减。
- **备注（note）整条删除**：全仓**零读者** —— 只被存过、在拿货单列表显示过，不进导出 xlsx、
  不进对账、不进成本快照（只读明细行）。真实库佐证：2 张拿货单 0 条备注（**只作佐证不作判据** ——
  判据是"有没有下游链路"）。删除面：列表「备注」列 · 编辑器表单格（`pue-note`）· 创建/更新载荷
  与出参（`types.ts` / `ipc.ts` / `preload.ts` / `purchase-handlers.ts` / `purchase-db.ts`）·
  **DB 列**（`purchase.main` v1 迁移 `DROP COLUMN`，SCHEMA 同向删除）。⚠️ `Supplier.note` /
  `Payment.note` 是别的表，**保留**。
- **删列纪律（与"新增列两处都要动"镜像）**：`IF NOT EXISTS` 对已存在表一个字都不改 ⇒ 只删 SCHEMA
  或只写迁移都会让新旧库形状分叉 ⇒ `ensurePurchaseSchema()` 内先 `migrate('purchase.main', …)`
  再 `dbMigrate(SCHEMA)`（house convention，迁移须处理"表还不存在"），两处同向删到当前形状。
- **顺带修文案谎报**：删除/提交确认与编辑器已提交警示原先对所有拿货单都写「缺口会回升、成本同步减少」
  —— 对**包价单**是谎话 ⇒ 按 mode（及 status）分叉：包价只说"从厂家对账里移除"、草稿只说"只影响这张单自己"。

守卫：`schema:smoke` 30 → **38**（新增场景 F：老库带 note → 迁移后版本记 v1 + 列已删 + **数据一条不丢** +
**老库删列后新建单可用**〔列删了但 INSERT 还写它 ⇒ 老库上建单必抛，同 `oi_styles.name` 的删法事故〕+
幂等；随后新库直建 PRAGMA 无 note —— 抓"只删迁移忘了删 SCHEMA"的分叉）；`today:ui` 172 → **175**
（列表无备注列 · 编辑器无备注输入框 · 开单出参无 `note` · 模式钉只读标签 · **包价单的删除确认不许出现「回升」**）。
变异确认非空转：`dropOrderNote` 改空操作 → 恰好那条断言变红，其余全绿；还原后复跑全绿。
见 `docs/notes/2026-10-30-purchase-card-and-editor.md`。

### Added · 「商品ID 映射」改绑可选颜色 —— 存量「未分类」订单跟着补色（2026-10-10）

用户问「为什么款色是'未分类'，归类核对时我不是已经选了款色吗」——查明：归款（`autoAssignByMap`）
的颜色顺序是**映射色 → 订单原文色 → 兜底占位名** `MAPPED_FALLBACK_COLOR`（`未分类`），
8 条映射全是 `spec='*'`（一期不带色）⇒ 6 个款全落在占位色上。本轮把「补色」做成界面里的自助通道：
在 **「货与成本 › 商品ID 映射」改绑时选颜色**（下拉，选项 = 款色色卡），该商品**挂在占位「未分类」
上的存量订单跟着补成该色**。

- **改色 = 改同一条绑定，不留旧行**：该商品名下属同一产品恰好一条手动映射行时 `UPDATE` 它的 `spec`
  （否则 `INSERT`）—— 旁留的旧行永远命中不了（`resolveOrderSku` 带色行优先），却出现在映射列表里，
  人也看不出哪条算数。「同产品」限定是有意的：同商品把不同颜色绑不同产品是既有合法形态，仍可新增。
- **回填只碰占位色**：`reassignOrdersByItemIds` 范围从「未归款」扩为「未归款 ∨ 占位色」，
  挂在**真实颜色**上的图一律不动（人工纠正 / 识别结论 / 上次补的色都算数）—— 改一次映射色不会把
  历史订单全改判。计数按**实际变化行数**（before/after 比较）：补色前的占位色也有 id，拿"非空"计会把
  没动的行也报成处理过。
- 回执措辞去行话：「已自动关联 N 行存量订单」→「**另有 N 行老订单一并归好**」（该数现在也计入补色）。

守卫：`product:sku:smoke` 39 → **41**（正例：改绑补色 → 挂占位「未分类」的存量订单跟色、同键只留一行；
边界：同商品多色绑不同产品仍可**新增**；两条变异确认非空转 —— 拆掉"同产品一条行"分支、
回填范围退回「仅未归款」均变红）；`picking:smoke` 用例名更新（"回填不覆盖已有归款结论" → "回填不碰已定色"）。
见 `docs/notes/2026-10-30-mapping-color-and-replay.md`。

### Fixed · 「拿货」吸底汇总条被压成 2px —— 「按钮只对某几个厂家出现」的真因（2026-10-10）

用户问：选「全部」「集雨」时没有「复制给厂家」和「生成拿货单」，选「欢喜」「大众」就出现，逻辑是什么。
**与页签无关** —— 按钮是逐厂家的 `v-if`（`sec.sg.supplierId && sec.pending.pieces > 0`，「生成拿货单」
另需宿主传 `supplierAction`），汇总条遍历**全部**厂家，页签只过滤卡片网格。真因是 **flex 压塌**：
`.pk-sum` 是 `.wb-page`（定高弹性列）里的子项，默认 `flex-shrink: 1` 被内容溢出压扁；自身
`overflow: hidden`（圆角用）又把自动最小尺寸归零 ⇒ 一路压到 **2px** 被**自己裁掉**（元素仍在 DOM、
矩形也还回 2px，`elementFromPoint` 命中下面的卡片）。页签只改卡片数量 ⇒ 改塌陷程度 ⇒ 造成"按钮跟页签走"
的假象（实测：全部 6 款色 / 集雨 4 → 2px 全塌；欢喜 / 大众各 1 → 95px / 71px，压得浅按钮露出来）。
修：`.pk-sum { flex-shrink: 0 }` —— 内容装不下就溢出 `.pk-view` 去滚（本来就是这个设计），
`sticky` 负责把**完整的**条钉在滚动口底边。

守卫升级：两条冒烟原来只断言 `position === 'sticky'`（声明式断言，塌成 2px 照样绿）⇒ 换成
**几何 + 可达性**（`pkSumGuard`）：① 没被压扁（`clientHeight + 1 >= scrollHeight`）② 底边在视口内
③ 每个必需按钮**中心 `elementFromPoint` 命中它自己或后代**。先加守卫跑红
（`条 h=2（client 0 / scroll 139）… pk-copy→点到 pk-card__head`）→ 修复 → 绿；断言条数 **1:1 替换**
（`today:ui` 172 / `picking:ui` 84 不变）。

次级发现（修完第一条后 `today:ui` 仍红，命中元素是 ToastHost 容器）：**常驻 toast 容器吞右下角点击** ——
它为 `aria-live` 常驻（`fixed bottom-4 right-4 z-[60]`），自身盒子（含两条提示之间的 `gap-2` 空隙）
静止地挡在右下角；真实场景：点「复制给厂家」→ 成功 toast 弹出恰好盖住同时位于右下角的「生成拿货单」
⇒ 下一次点击被挡约 3 秒。修：容器 `pointer-events: none`（继承 ⇒ 整条提示链穿透；提示是纯信息、
没有可点元素，穿透无害）。

真机复验（克隆库 + CDP 量几何）：修复前 全部 / 集雨「h=2、按钮不可点」· 欢喜 95 / 大众 71；
修复后四页签一律 **h=163、6 个按钮全部 `hit=self inView=true`**。
见 `docs/notes/2026-10-30-ui-style-and-hierarchy.md`。

### Fixed · 「复制给厂家」真机上一直失败 —— Electron 44 移除了 `clipboard.writeImage`（2026-10-10）

用户实测点「复制给厂家」弹「复制失败：写入剪贴板失败」。根因是 **Electron 33→44 升级残留**：v44 的
clipboard 重构（RFC 0019，narrow helpers 清理）**删掉了 `writeImage`**（同批还有 `readImage` /
`writeHTML` / `availableFormats`），上一轮写这条通道用的还是 v33 时代的 API —— 渲染层每次都拿到
`{ success:false }`，界面只显示一句兜底文案（原始错误在 `src/core/services/clipboard.ts` 被吞，
本次已补 `console.warn`，真机排查不再多绕一轮）。

**为什么三道门禁都没拦住**：主进程 `require('electron')` 是 `any`（tsc 看不见成员不存在）；
`verify` 只核**通道名**三方一致（没变，照样 ✅）；`picking:ui` / `today:ui` 的剪贴板是**假桥**，
只验"发出去的是什么"。**「运行时 API 存在性」是独立于类型 / 契约 / 载荷形状的第四类缺陷** ——
只有真写一次系统剪贴板才暴露（对照 `docs/notes/2026-10-30-electron-and-platform.md` 的第三类）。

- **新写法** `clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)]) })])`
  （v44 起 clipboard 全部方法转 async，文本通道一并补 `await writeText`）。`new Uint8Array(png)`
  而非 Buffer：BlobPart 不收 `ArrayBufferLike`（类型层）+ Buffer 池化分配会带上无关字节（运行时层）。
- **两条剪贴板通道外提**到新文件 `electron/clipboard-handlers.ts`（原住 `main.ts`）：冒烟要
  `require` 到 handler 才能对穿（`main.ts` 是应用入口，起不了）；且新文件用 ESM import 拿**真类型**，
  再写错 API 名 tsc 直接红（实测变异回 `writeImage` → `TS2339`）。
- **守卫进 `ipc:shape:smoke` ⑧ 段（23 → 30 项）**：真写系统剪贴板 + **读回** —— 写入前 `clear()`
  立基态（防残留让断言蒙对）· `has('image/png')` + 读回尺寸 64×64 内容级验证 · 拒绝分支（非 PNG /
  超 8MB）· 文本通道一并读回。两条变异确认是真守卫：实现退化成 `writeText` → `success:true` 那条
  **仍绿**、读回那条红（**`success:true` 单独就是假守卫**）；文本写错内容 → 读回那条红。

真机复验（CDP 驱动真宿主点击）：toast「已复制 4 款色 · 5 件 的清单图」，系统剪贴板读回 1520×1152 PNG。
见 `docs/notes/2026-10-30-electron-and-platform.md`。

### Changed · 「拿货 › 要拿什么」整页重做：卡片网格 + 「复制给厂家」（2026-10-10）

用户给出「拿货工作台」设计稿并选定**整页重做卡片网格**。上一轮虽把行粒度收到款色（`S1 · 黑` 一行），
但仍是「表格 + 段标题」两层嵌套：厂家名与货离得远（只在段标题上）、动作散在表尾与段尾、
"把这一家的货发给厂家"这一步连个按钮都没有（只能导出 xlsx 再找文件发出去）。本轮四块一起换：

- **顶部厂家筛选标签**（`pk-tabs`）：数 = **待拿款色数**，只给有货要拿的厂家占位；「未指定厂家」
  是独立一档（`data-supplier="0"` —— 它的货要能看到，但不该混进别家的筛选里）；一个可筛的都没有时
  整行不渲染（只剩「全部」的标签栏是纯噪声）。
- **卡片网格**（`pk-grid`，`repeat(auto-fill, minmax(224px,1fr))`）：一张卡 = **一个款色** =
  图（缺图画「缺图」占位）+ 厂家胶囊（`is-missing` 标明未指定）+ 尺码角标条（沿用 `L×2` / `L✓`
  与「需求 / 已拿 / 还差」tooltip）+ 四态标签（**已忽略 > 已拿完 > 缺哪一环 > 齐**）+ 款名 +
  卡面金额（`≈¥20.00` / 全无价 `—`，已拿完 / 已忽略不渲染）+ 单价（裸数字，「元/件」后缀挂在
  `data-act` **外面** —— 断言要求那格恰好是数字）+ 行尾「忽略」。
- **底部汇总条**（`pk-sum`，**`position: sticky` 吸底**）：一行一个厂家 = 「这家什么情况
  （`N 款色 · 待拿 N 件 · 预估 ¥X` / 「余下已忽略（无需补货）」/「已拿齐」）+ 「复制」+
  「生成拿货单（N 件）」」，最后一行总账。卡片一多，随列表滚的条子会被顶到几十屏之外，
  而开单按钮就在这条上 —— 找不到等于没有。
- **「复制给厂家」**（`pk-copy`）：把**这一家**的待拿货画成一张 PNG 写进**系统图片剪贴板**
  （粘到微信直接发）。新 `src/lib/pickingSheet.ts`（`sheetModelOf` 走 `pendingOf` + `renderSheetPng`
  canvas 2×）与**新 IPC `write-clipboard-image`**（渲染层产图 → 主进程校验 `data:image/` 前缀 +
  8MB 上限 → `nativeImage.createFromDataURL` + `clipboard.writeImage`；`verify` **189/185 → 190/186**）。
  **屏上 / 发出去的 PNG / 导出 xlsx 是同一个数**（`money` / `amountText` / `noPriceNote` 三方共用 ——
  纯文本粘进微信会丢表格结构，截屏又会把页签与别家的货一起发出去）。
- **排序修到全网格**（本轮唯一真 bug，被断言抓到）：卡序 = **还要拿 → 已拿完 → 已忽略**
  （同档内维持段序 + 件数降序）。原先排序写在**段内**，被段序盖过 —— 厂A 整段被忽略后，
  那张调暗的卡仍排在未指定厂家的待拿卡**前面**（"还不用动的东西不抢眼"没做到）；`Array.sort`
  稳定，收集完统一排一次即可。
- **两种宿主共用**：独立「拣货」页与「今天 › 拿货」仍是同一个 `PickingView`（embedded）；
  忽略链接 / 开单按钮由 `rowAction` / `supplierAction` 决定渲染（独立页不渲染开单按钮 ——
  那是「拿货」页的动作）。

守卫：`picking:ui` **60 → 84**（标签筛选与回退 · 已拿完第四态整条翻〔调暗 + 不再报金额 +
该厂家标签消失 + 汇总行说「已拿齐」〕· 复制成功与失败两分支〔`__clipFail` 反向夹具〕· 吸底与
网格布局 · 卡面金额与单价）· `today:ui` **168 → 172**（标签计数 · 汇总条吸底 · 复制载荷是
`data:image/png;base64,` 前缀 · 复制 toast 说清"几款色几件 + 发给谁"）· `tests/pickingSheet.spec.ts`
新增（`vitest` **678 → 689**；37 文件）。三条实测纪律：**注入脚本注释里又不能有反引号**
（`node --check` 报 `Unexpected identifier 'lib'`，这个坑又踩一次）；**写剪贴板的假桥只能验
"发出去的是什么"** ⇒ 补非空转判据 `new Image()` 解码 `naturalWidth > 0`（画布空壳 dataURL 当场红）；
**卡上两个判据钉同一格**（尺码格的文本与 tooltip 同取一个 `size-chip`，分开取"串位"不会红）。

### Changed · 「生成拣货单」页签并入「拿货」：六步收成五步（2026-10-10）

拣货清单按「厂家 / 款 × 色 × 码 / 图 / 进价」汇总，而"拿货"要的正是这张单 —— 原第 3 步生成完清单，
第 5 步拿货**又得从头理一遍**（拿货页只有款色码，图与进价一概没有）：同一件事在两个步骤里各算一次，
口径还不同（清单是"未发货 · 近 30 天"，缺口表是"全部订单"）。本轮把两半并成一件事：
**要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账。**

- **页签与编号**：`TodayView.vue` 的 `TABS` 去掉 `picking` 一项，编号顺移（3 算钱 / 4 拿货 / 5 结算对账），
  页头描述与总览流程卡「六步」→「五步」（`flow-picking` 卡不存在了；`picking.sku` 只是总览上的一个数字）。
  `flowCtx.ts` 的 `SHIPPING_TAB_NAMES` 删掉 `picking: '生成拣货单'` —— **这不是改名，是这个页签没了**：
  留着它会让悬空名守卫把一个点不到的名字当成合法入口（跨模块入口名由 `src/modules/picking/meta.ts`
  的 `name`「拣货」兜）。
- **「拿货」页两个子视图**（`.wb-seg` 分段控件，不是第二层页签栏）：**「要拿什么」** = 整页复用
  `PickingView`（`embedded auto row-action` + `:refresh-token="token"`，**不复制一份精简版** ——
  同一件事两处摆，迟早两套口径）+ 行动区（厂家**不预选**：默认值不能靠位置；日期默认今天；
  「按此生成拿货单（N）」）；**「拿了什么」** = 拿货单列表。原「待拿货缺口」表格视图**整块删除**
  （它的列就是"要拿什么"去掉图与价的样子，两版并排只会让人问"这两个数为什么不一样"），
  指标条上「待拿货缺口 N」（`outstanding()` 的全部订单口径）保留。
- **一键开单的口径**：`createFromPick` 只收**所选厂家**的行（一张拿货单只能挂一个厂家，混着发会把单
  开给错的厂，而"单里有别家的货"在那张单上看不出来）；单价留 0（进价是**估算**，实拿价去编辑器填 ——
  把估算价当已付钱落库，对账永远对不上），`suggestionQty = 还差`。
- **清单本身升级**（`PickingView.vue`；「今天 › 拿货」与「拣货」模块两个入口同源）：
  新增「需求 / 已拿 / 还差」三列 + 图角标（**尺码 × 还要拿的件数**，与导出 xlsx 上烧的角标**同源** ——
  图是直接发厂家的，写需求数会让厂家照需求发；已拿完 / 已忽略不画角标，画个 0 会被读成"拿 0 件"）·
  指标条新增「还要拿 N 款 · M 件」（只在有"拿过 / 忽略过"时出现，否则与"共 N 款"重复）·
  行尾「忽略 / 取消忽略」（仅 `rowAction` 时渲染，colspan 9 ↔ 10）——只**发意图**，
  写库与确认弹层留在「拿货」页（Electron 没有 `window.prompt`，原因输入要自绘）·
  状态三态分开：**已忽略 > 已拿完 > 齐 / 缺**（「已拿完」与「齐」是两句不同的话）。
- **口径单源**：`takenKey` / `ignoreKey`（`src/lib/picking.ts`）与主进程 `purchase-db.ts` 的
  `outstanding()` **逐字一致**（`|` 拼接原样字符串）—— 两处拼法分叉会静默出现"明明拿了，清单还说没拿"。
  `remaining = max(0, pieces − taken)`（多拿是"拿多了"，不是"还差负数"）。
- **契约零改动**：全部 `data-act` 名未动 ⇒ 既有断言原样重挂；**零新 IPC**（`verify` 一字未变）。
- **守卫**：`today:ui` **149 → 164**（六页签 / 五步流程卡 / 「去看要拿什么」落点改「拿货」页签 /
  分段控件两视图点得开 / 行动区厂家不预选 / 生成只收本厂 / 括号里的数 = 本厂还要拿的款数）·
  `picking:ui` **50 → 60**（「需求/已拿/还差」三列各自数对 / 图角标 = 还要拿的件数 / 没图没角标 /
  导出带上已拿·还差 / 反向夹具 `__noTaken`（没拿过时角标回落需求数、且「还要拿」那格不渲染）/
  `__ignore`（被忽略的组不画角标））· `uxEntryNames` 两处同步（撤「待拿货缺口」豁免 —— 那条视图
  已经不存在；加「要拿什么」「拿了什么」；自证非空转的锚点从「生成拣货单」改钉「拿货」）·
  `tests/picking.spec.ts` **32 → 44**（已拿按款色码扣 / 忽略按款色整组 / 还差夹到 0 / 已拿不影响金额 ·
  `takenKey`/`ignoreKey` 与宿主行粒度逐字同源）。

### Changed · 「拿货」页重设计：款色一行 / 就地给数 / 段上开单（2026-10-10）

用户口径：「拿货 tab 界面一条一条的实在太多了，元素很多，嵌套也很多」—— 上一轮把拣货并进来之后，
「要拿什么」还是 **款 × 色 × 码 一行**（一款黑 L 一行、黑 M 又一行，同一张图逐码重复，表共 10 列），
页面上再叠一条指标条 + 一个"先选厂家、再按此生成"的行动区 + 一张常驻的已忽略表：屏上同时有几层
数字、几处按钮，而"拿货"要的只是一眼看清「哪家 · 拿什么 · 拿几件 · 大概多少钱」。本轮按用户两个
裁决重设计（**款色一行、尺码并排**；**收掉顶栏计数、按视图就地给数**）：

- **款色一行、尺码并排**（`src/lib/picking.ts` 的 `groupByColor`）：行粒度 款色码 → **款色**（行键
  `S1 · 黑`），尺码折进行内成 `size-chip`（`L×2` = 这一码**还要拿** 2 件、`L✓` = 已拿完；tooltip
  里是「需求 3 · 已拿 1 · 还差 2」三个数 —— 折叠展示，一个数不丢）。同一款色的图只出现一次，
  表格 **10 列 → 6 列**（图 / 款·色 / 尺码（还差）/ 进价 / 缺 / 行尾动作）。发给厂家的 xlsx
  **仍按码把角标烧进图**（出货粒度不变，与 `badgeOf` 同源 —— 展示粒度与出货粒度是两回事）。
- **顶栏指标条撤掉、各自就地给数**：清单条（`pk-bar`）给「待拿 N 款色 · N 件 · 预估 ¥」
  （与段尾按钮同一个 `pendingRollup`）+ 「缺：…」同一条；「拿了什么」面板头（`pu-orders-meta`）给
  「N 张 · N 张草稿待提交 · 已提交 ¥」；分段控件上的徽章一并撤 —— 数字住在它所描述的对象旁边。
- **开单按钮钉在厂家段尾**（`pk-create-order`，带 `data-supplier`）：一张拿货单只能挂一个厂家，
  数据里已经按厂家分好段 —— 页级行动区（厂家下拉 + 「按此生成拿货单（N）」）**整个撤掉**，
  "先选厂家"那一步对用户是白问的。`pu-supplier` 下拉留在「拿了什么」，只服务于「新建明细单 /
  新建包价单」，且**没选厂家时两个新建都禁用**（不允许开出无主单）。
- **生成后直接进编辑器**：生成草稿后自动切「拿了什么」并**直接打开这张单的编辑器**（合计 0.00
  等填），toast 说「已生成拿货单 #N（草稿）—— 填好单价再提交」—— 开单只是中点，"填价"才是下一步。
- **已忽略折成一行**（`pu-ignore-toggle`）：低频内容默认收起（一行说清几条 + 生效范围），
  展开才出表（`pu-ignore-table` 与「取消忽略」原样保留）。
- **契约零改动**：`data-act` 名一个没动（`pk-*` / `pu-*` 全部保留）⇒ 既有断言按新 DOM 重写判据；
  **零新 IPC**（`verify` 一字未变）。

守卫：`today:ui` **164 → 168**（款色行的尺码格文本与 tooltip **钉在同一格**〔列串位即红〕·
清单条就地给数「待拿 1 款色 · 2 件 · 预估 —（2 件全部无进价）」· 缺口条按**需求**口径「无进价 3 件」、
与「待拿 2 件」刻意不同值〔口径混用即红〕· 段尾按钮带 `data-supplier="7"` · 折叠/展开已忽略 ·
生成后自动进编辑器〔新单 `#99`、合计 0.00〕· 新单入册后面板头变「3 张 · 2 张草稿待提交」）·
`picking:ui` **60**（清单升级的断言同轮改钉新 DOM：`S1 · 黑` 款色行 / chip `L×2` + tooltip 三个数 /
「待拿 2 款色 · 3 件」与总需求 7 件相区分 / 反向夹具 `__noTaken` 回到 `L×6` / `__ignore` 划掉且不进待拿）·
`tests/picking.spec.ts` 增补款色聚合与待拿口径用例（`vitest` **663 → 678**）。两条实测坑：
**改 toast 文案要 grep 按文案取的断言**（「去「拿货单」填单价」→「填好单价再提交」后，
`toastHas('填单价')` 不再是子串 —— `today:ui` 当场红一条）；**假桥必须记住新建的单**
（生成后立即 `purchaseOrderGet(新 id)` 打开编辑器，夹具不持久化就当场报「拿货单不存在」⇒ 补
`CREATED_ORDERS` / `allOrders()`）。

### Changed · 运费岛 `shipping-rate` 1.3.1：克重链收口（工作区已备好、待发布）（2026-10-10）

2026-10-01 宿主侧已按领域裁定删掉「商品信息 Excel → 商品ID 克重」整条链（克重只属于 SKU），
但堆上还有两层没跟上，本轮一次补齐：

- **已发布的 1.3.0 就没跟上**：当日 00:04 推出去的 `shipping-rate-1.3.0.zip` 里那条链**还在** ——
  「按订单试算」页头仍写"联商品重量表"、页面上还有「导入 / 更新商品信息」死按钮
  （点它调的是宿主已删的 op）、manifest 描述还在讲"导入商品信息 Excel"。
- **仓库里删了、但从未发布**：岛的这条链随后在仓库里也删净（`0dee5ff`，2026-10-05 ——
  死按钮与旧页头文案都删了），**但 `manifest.json` 的版本号没升** ⇒ 客户端判据
  （同版本不更新）直接跳过 ⇒ 那批清理**从未到达任何用户**。这是「版本号是唯一更新信号」
  的反面教材：**改完仓库 ≠ 发布**（红线 27）。

**1.3.1 是「链已删」的岛第一次真正发出去**的版本。相对仓库已提交状态（`0dee5ff`）
**零行为改动**（克重两条试算早在 1.3.0 就都读 SKU 克重），只对文案与版本：

- `dist/views/orders.js`（产物即源码，手写岛无构建）：页头说明改「逐单取『收货国家 + 款色码』，
  联产品库 SKU 克重后按运价表计价」；`dist/api.js` / `dist/views/products.js` 的注释同步改成
  "两种试算读**同一份**克重，不再有第二条重量链"。
- `README.md`：能力域行删掉两个**已死 op**（`importProductWeights` / `productWeightStats`）·
  两条"重量单位 / 取第一张 sheet"的坑位改标**删除记录**（链与解析器已不存在，只存档在 git 历史与
  `SHIPPING_RATE_ISLAND_PLAN.md` §8）· §7.1 记录发布状态。
- `manifest.json` **1.3.0 → 1.3.1**（版本号是唯一更新信号 ⇒ 同版本换内容会被 `publish-plugin.js` 硬拦）+
  描述改写。
- 本地已打包 `market-out/shipping-rate-1.3.1.zip`（sha256 `0e6430b2edc07f629ebb169764a6133469bb804686d3c781e94ee05c7db4f76a`），
  catalog 同步更新。**push 与本机重装待用户操作** —— 岛从 `<userData>/plugins/` 加载，
  不重装则用户看到的还是 1.3.0 的老文案（且没有任何提示）。

### Fixed · 拣货合并收尾：款名读错表 + 两条门禁卫生（2026-10-10）

- **拣货投影把款名读向了不存在的列**：`electron/picking-db.ts` 新加的 `styleName` 用了
  `COALESCE(s.name,'')`（s = `oi_styles`）—— 该列**不存在**（款名权威在 `pl_products.name`，
  ADR-002 D1），`picking:smoke` 18 条全红报 `no such column: s.name`。修法：`tableExists('pl_products')`
  守卫 + `LEFT JOIN pl_products p ON p.code = s.code` —— 与 `shippingRows` / `styleNameJoin()` 同一条口径
  （**别把"产品库还没建"报成"拣货域坏了"**）。
- **`goods:ui` 一条行数断言没跟上夹具**：导入夹具已长到 4 行，断言还写 3 ⇒ 改为 4（三遍 ALL PASS）。
- **`lint` 从 43 error 归零**：41 个来自 `.workbuddy/retired/**` 归档的旧岛 dist 产物（打包后的第三方
  bundle，本就不该进 lint）⇒ `eslint.config.mjs` 加 ignore（写明了原因）；另 2 个来自
  `scripts/goods-ui-smoke.mjs` 假桥模板串里不必要的 `\"` 转义。

### Fixed · 「生成拣货单」空态说不清"为什么空" + 改了筛选条件不重算（2026-10-10）

用户实报：归类核对做完，点「生成待拣清单」仍提示「扫了 9 行…都被『已终结 / 超窗』排除了」。
**根因不是归类**：这 9 行下单日是 `2026-08-25`（距今 46 天），被默认的「近 30 天」天数窗全部剔除
（`excludedOld = 9`、`excludedFinished = 0`）。拣货单只看四件事（未发货 / 非已终结 / 天数窗 / 店铺），
**与"归类核对做了没有"无关** —— 归类只决定清单里的款色码对不对。取证见
`docs/notes/2026-10-30-picking-and-takeout.md`。

顺手修掉这条链上三处会把人带偏的地方（都在渲染层，口径不变）：

- **空态按实际生效的口径分说**（原先一律写「都被『已终结 / 超窗』排除了」并同时给出两个动作，
  而这两个动作**各自只对一半场景有效**）：超窗那一支点名「超窗」+ 说清是哪个窗 + 说「0 = 不限」；
  已终结那一支说清"拣了也白拣、放宽也没用"并指向「导入订单」页签去核报表有没有「订单状态」列
  （没有这一列 ⇒ 这一层判不出来，也不会误剔）；两支都有时分别报数。
- **空态的下一步是真按钮**（`data-act="empty-widen"`，点了真的展开「更多」里的天数窗）——
  原先只是一句"去「更多」调大"，属"提示不是入口"。
- **改筛选条件（天数窗 / 店铺 / 含已发货）即重算**（`watch`，仍只在"已经生成过"时跑，保留一键语义）。
  原先只 `watch(refreshToken)` ⇒ 改了条件得再点一次生成，用户以为改了没生效。
- **条件条的天数窗改读本次结果的口径**（`PickingSummary.days`，未生成过才回落到输入框值）：
  原先读输入框 ref ⇒ 数据还是旧的、标签已经变了。顺带修 `0` 显示成「近 0 天」——
  0 的含义是"不限"，写成 0 天正好读反。

守卫（`npm run picking:ui` **44 → 50 PASS / 0 FAIL**）：
- 新夹具 `__onlyOld`（只有一行超窗）—— 补上"两种剔除原因"里缺的那一支的**反向夹具**
  （原先只有 `__onlyFinished`，「超窗」这一支 —— 也就是用户实报的那一支 —— 从没被验过）。
- 新断言：空态①点名已终结且**不给**无效动作（无 `empty-widen` 按钮、不提"连已发货"）；
  空态②点名超窗且说清是哪个窗、空态按钮点了真的展开「更多」；只改店铺 / 只改天数窗都会重算；
  `0` 说「不限天数」而不写「近 0 天」。
- 脚本内新增 `tryWait`（等待超时不当异常）：一条 `waitFor` 超时会抛到最外层 catch，
  后面几十条断言全不跑、报出来的失败条数与真实失败数无关（今天页冒烟早就是这么写的）。
- **变异取证**：①去掉条件 `watch` + ②`daysText` 恒返回「近 N 天」⇒ 恰好那 3 条新断言变红
  （47 PASS / 3 FAIL），其余照旧全绿；还原后 50 / 0。

### Changed · 「今天 › 归类核对 › 待核对订单」改版：颜色跟着归属款走（2026-10-10）

用户口径五条，完整判据见 `docs/notes/2026-10-30-order-classify-panel.md`。

- **列表图不再裁切**：基座 `.wb-thumb` 是 40px + `object-fit: cover`，而商品照多是竖版 ——
  上下两端正是"这个款长什么样"的关键部位。本页覆盖成 64px + `contain`，缩略图 `maxEdge`
  96 → 192（跟着展示尺寸走）。核对是**拿图比**出来的，不是读文字读出来的。
- **撤掉「品类」「Logo」两列**（表头 9 → 7：图 / 订单号 / 店铺 / 颜色 / 尺码 / 归属款 / 操作）。
  品类是主数据、在「货与成本」维护；Logo 等「印花 logo 管理」做出来再加回来。
  ⚠️ 两个字段**仍原样回传**（`Draft` 里保留、不显示）—— 把库里已有的值抹成空串比不显示更糟。
- **颜色改成「该款的颜色」下拉 + 记住这张图上次定的颜色**。取值优先级（每一支都要落在该款
  色卡里才作数）：① 图记住的颜色（宿主存在 `oi_images.style_color_id`；图片按内容/URL 指纹去重
  ⇒ 同一张图下次读到同一行）→ ② 订单自己的颜色列 → ③ 留空让用户自己选。没有归属款 /
  该款还没录颜色时回落自由输入（`datalist` = 标准色词表 + 本库已用过的写法）。
  ⚠️ 布局是**一个格子两种控件**而不是两个格子：它们是同一个字段的两种形态，分开会让人以为
  "款的颜色"和"订单的颜色"是两回事。
- **「点名了款却没给颜色」不许保存**（颜色是款色的主键之一，空颜色会落出一个没有名字的款色，
  而界面上看不出异常）：「保存」按不下去 + 格子里写明原因。
- **`isDirty` 的基准改成 `baseColor` / `baseStyle`**（不能用行字段：颜色格显示的是"图片记住的
  颜色"，拿 `o.color` 比会让每行一进页面就是脏的，「保存」全亮着）。
- **归属款下拉的数据源改成产品库全集**：`order-db.listStyles()` 的驱动表由 `oi_styles` 改为
  `pl_products LEFT JOIN oi_styles`（识别池有而产品库没有的行以空名补在末尾 —— 少一行比多一行
  难查得多）。用户报的"展示不全"就是前者：**产品库里手工新建、还没出过订单的款在识别池里没有行**。
  `orderStyleAssign` 的入参主用 `styleCode`（宿主 `ensureStyleByCode` 给这类款补占位款），
  `styleId` 保留兼容老调用方；`order-handlers` 的校验改为 `!styleId && !styleCode` 才报错。
- **面板头文案去掉 markdown 粗体**：Vue 模板不解析 markdown ⇒ 屏幕上原样显示成一串星号
  （本轮实测踩到，见 Tests 段新增的那条守卫）。

### Removed · 归类核对页页头指标条 + `order-sku-rollup` 整条通道退场（2026-10-10）

用户口径：「待核对、未归类、识别库…这个区域去掉，我看不太懂，用户肯定也会很懵」。

- 页面：整排 `.wb-metabar`（`data-act="cl-stats"`）及其四个计数格（含产品维度那一格
  `cl-metric-product` 的三态处理）删除。
- 通道（**零消费者即删**）：`electron/order-handlers.ts` 的 `order-sku-rollup` handler ·
  `electron/preload.ts` 的暴露键 · `src/types.ts` 与 `src/core/services/ipc.ts` 的声明 ·
  `src/modules/today/classify.ts` 的 `skuRollup()` · `electron/product-db.ts` 的
  `resolveOrderSkuRollup()` / `OrderSkuRollup` / `MAX_ROLLUP_ROWS`。
- `pendingCounts()` 随之少两个统计（"款数"要额外查一次识别池；"品类写法"随品类列一起撤），
  只留 `pending` / `unclassified` / `usedColors`（空态判定 + 颜色输入建议）。
- 守卫：`product:sku:smoke` 删 6 条 —— ⚠️ **它测的规则没有消失**：店铺原文 → 实体走
  `resolveShopRef`、(平台,店铺,商品ID) → 产品走 `resolveSkuBatch`，两条在上面的用例里都还在；
  删的是"已经没有调用方的汇总壳"。`ipc:shape:smoke` 删 §⑥ 的 3 条，**只删断言、留夹具**
  （`shopId` / `pid` 被后面两段引用，连夹具一起删会把无关的东西一并拆掉），节号顺延 ⑦⑧ → ⑥⑦。
- `npm run verify`：**190/186 → 189/185**。

### Tests · 归类核对页改版的守卫（`today:ui` 139 → **149**，ALL PASS）

- 反向守卫：页头无指标条（**同一条 `report` 里先确认面板与表格真的在**，否则"查不到"与
  "没有它"长得一样）· 表格只剩 7 列（表头）· 品类 / Logo 的**控件**也消失（列撤了控件却留着
  = 看不见但仍在写）· 工具条仍可用（自证非空转）。
- ⚠️ **"通道没人调"是条恒真的假守卫**：桩删掉之后调用次数必然是 0（读不到就无所谓调用）。
  假桥的兜底分支改记「渲染层读了哪些没人实现的键」（`__unhandled`），判据改成
  **`orderSkuRollup` 没被读过** —— 顺带它也把"本页偷偷用了什么没实现的键"暴露出来。
- 图不裁切：先等图片解码完（`complete && naturalWidth > 0` —— 图是异步加载的，在"元素在、
  还没加载完"时取 computed style 读到的是占位状态，断言会变成"看运气"）再判
  `object-fit === 'contain'` 且宽度 ≥ 60。
- 颜色三支优先级**三行各一支**（P-42 记住「白」/ 订单「黑」⇒ **白** —— 只留这一行时
  "永远取订单自己的颜色"照样全绿，所以期望值必须与订单的色不同 · P-45 记住「印花」/ 订单「黑」
  ⇒ 黑 · P-44 两个都是「印花」⇒ **空** + 缺色提示）；有名字段 ⇒ 下拉、无名款/无色卡 ⇒ 自由输入
  + `datalist`（**词表与库内写法两条都要**：只读词表的实现会被"灰 只可能来自订单"打红）。
- 缺色拦保存**三条连着看**：换款清空 + 提示 → 保存 `disabled` → **补上颜色后同一行立刻可保存**
  （末条才证明卡住的是缺色，不是"这行压根没改动"）。
- 归属款：4 个选项（自动匹配 + S1 + S2 + **S9**）—— S9 是产品库里手工新建、识别池里没有的款，
  识别池驱动时它一个都不出现；停用款带「（停用）」；默认值不靠位置（P-42 → `S1`，下拉的
  值就是款编码）。
- **新增「可见文案不许漏出 markdown 记号」守卫**（`**` 与反引号）—— 这条是**实测踩到**的：
  说明文字写成 markdown 粗体，而 Vue 模板不解析 markdown，屏幕上就是一串星号。变异确认：
  把 `**` 写回模板 → rebuild → **恰好只有这一条变红**（PASS 148 / FAIL 1），复原后 149 / 0。
- 点名款走**款编码**：断言从 `styleId === 6` 改为 `styleCode === 'S2'`（下拉数据源是产品库全集，
  产品库里的款在识别池里未必有行 ⇒ 发 id 的话那些款根本点不了）。

### Changed · `style:smoke` B7：换驱动表之后，那条旧断言自己变成了错的（2026-10-10）

`order-db.listStyles()` 的驱动表换成 `pl_products` 之后，B7 原来断言的
`listStyles().length === 0`（删掉识别池那一行 ⇒ 列表清空）**变成了在要求一个错的结论** ——
产品库还有这个款，它就**该**还在列表里。新断言三段：识别池那行真的没了（夹具前提）·
产品库主数据还在 · **它仍在款式列表里且名字跟产品库走**（断言里写明"别改回 `length === 0`"）。

### Changed · 「货与成本 › 进价」整页重设计：三块平铺 → 「左行动区 / 右现状表」（2026-10-10）

用户口径：**当前页面不够直观，也不好看**。改的是**信息架构**，不只是皮肤。

- **两栏**：左 = 行动区（录入框 + 「还没维护进价的款」），右 = 款级进价表。
  改版前三块 `.wb-panel` **等宽平铺**纵向堆叠 —— 一屏全是同一重量的白卡，"先做什么 / 现在什么样"
  读不出来，宽屏下每块内部还大片留白（录入行 4 个控件只占左边 1/3）。判据：这一页唯一的动线是
  **缺 → 有**（补进价），两栏正好是这条动线的两端。
  窄窗口（<1180px）改上下堆叠（行动区在上），三条坑与判据同两栏工作台（`max-content` 行高 /
  `align-content: start` / **只改子栏内部 flex，`.ct` 自己必须留 `flex: 1`**）。
- **录入框加回显**（`data-act="cost-echo"`）：填了款编码就当场说清「这是哪个款 · 现在的价是多少 ·
  来源是什么」。改版前只有一个光秃秃的输入框 —— 而一行**挂错款**的价在表上看起来完全正常
  （只是永远没有订单取到它）。⚠️ 打字只到**前缀**（`S`）时不报「产品库里没有这个款」：
  那是"还没输完"，不是"查无此款"。
- **待补清单整行可点**（整行是 `<button>`）：改版前是灰字 + 行尾一个文字链接，点名字没反应；
  带 warn 色计数徽标 + "只列出前 300 个"的说明 + 「产品库里的 N 个款都已维护进价」的结论行。
- **展开区标出哪条正在生效**（`.ct-iv tr.is-current` + 「当前」标签）：改版前要用户自己拿今天比生效日。
- 表体：进价加粗加大 + 「元」后缀 · 来源标签带小圆点 · 区间数做成 chip · 款名溢出省略号（全文留 `title`）·
  空态换成 `.wb-empty` 骨架 · 展开区改成 surface-2 井里的白卡（与产品页展开区同一套语言）。
- ⚠️ **单位必须在 `data-act` 外面**：`flat([data-act="cost-current"])` 必须**恰好**是 `12.34`
  （既有断言），合进去就成了 `12.34元` ⇒ 立刻红。已补一条断言把这件事写成契约。
- 契约零改动：`cost-table / cost-code / cost-price / cost-save / cost-pick / cost-row-expand /
  cost-current / cost-source / cost-missing / cost-truncated / cost-iv-delete` 与
  `[data-cost-code]`/`[data-cost-detail]`/`.ct-iv tbody tr` **一个没动** ⇒ 既有进价断言原样重挂。

### Tests · 进价页改版的守卫（`goods:ui` 242 → **261**，三遍 ALL PASS）

- 宽视口 **+15**：两栏并排（grid **轨道数**）· 左栏=行动区（**结构**：录入框与待补清单在左、
  价格表不在左）· 两栏真分开（**几何**：`aside.right <= list.left`）· 回显 4 条（空着不显示 ·
  款名/当前价/来源 · 不误报 · **前缀不报"查无此款"**）· 待补整行可点 2 条 · 标出正在生效 1 条 ·
  「元」在 `data-act` 外面 1 条 · 零成本空态 3 条（**反向夹具** `__smokeEmptyCosts`，
  临时让假桥返回空、**不动 `COSTS`**，并验 S1 也回到待补里）。
- 窄视口 **+4**：进价页两栏堆叠（轨道数）· 两栏都在 · 行动区在表上面 · **「保存进价」可达**。
- 变异 3 组各自 rebuild 后确认变红再复原：① 两栏 → 单列 → 2 条 FAIL（轨道数 1 / 两栏重叠；
  ⚠️「左栏=行动区」那条**照旧绿**是对的 —— 结构没变）② 去掉 `is-current` → 1 条 FAIL（`标了 0 条`）
  ③ 前缀守卫失效 → 1 条 FAIL。
- `goods:shot` 多出一张 `cost-<W>x<H>.png`（切到「进价」页签 + 展开生效区间）—— 布局类改版
  唯一能判的是人眼。

### Changed · 「货与成本」产品列表瘦身 + 展开区二次精简（2026-10-10）

用户口径两条：① **产品列表不展示 SKU 与进价**，款式名现在展示不完全；② **展开页里的 SKU 也去掉**，
并把展开区样式顺一遍。

- **左栏主表（`ProductPane.vue`）撤掉三列**：`SKU 数 · 缺 m`（一格）、`进价`。表格 8 → 6 列
  （简洁模式 7 → 5，`gdColspan` 跟着变成 5/6 —— 空态与展开行的 `colspan` 写死就会右边缺一块）。
  留下的列：`▸ / 勾选框 / 图 / 款编码 / 款式名 / 状态`。
- **款名改成"弹性列 + 最多两行"**：撤列只是给款名腾宽度的**一半**修法，另一半是它自己折行
  （里层 `<span class="gd-pane__name-text">` + `-webkit-line-clamp:2`；`td` 必须保持 `table-cell`，
  直接在 td 上 `display:-webkit-box` 会让那一格脱离表格布局）。`title` 仍给全文。
- **展开区撤掉只读 SKU 清单整块**（`data-act="variant-table"` 与其行、`data-variant-id` 一并消失），
  两列栅格 → **单列三层**：① 认款条（带主色浅底）；② 档案卡（供应商 / 类目 / 备注 / 创建 + 编辑·删除）；
  ③ 「已关联商品」卡。档案带原先是一条**裸露**的横排（无底色无边框）⇒ 升级为同规格卡片，
  平台名做成小标签靠右，标签列给统一宽度让值对齐。
- ⚠️ **撤列 ≠ 撤能力**（这是本轮最容易做成"静默降级"的地方，三处各有断言守着）：
  **缺克重** → 工具栏「问题件 › 缺克重」筛选（`filter-issue`）；**进价** → 同页「进价」页签
  （那里本就有"还没维护进价的款"清单，比列表里一个「—」可操作）；**SKU 增删改** → 「编辑」抽屉
  （颜色 × 尺码批量生成 + 逐行克重，`weight-save-in-drawer` 步继续守着）。
- **回退形态不动**：`GOODS_LAYOUT='tabs'` 的 `ProductListView` / `SkuMappingView` 契约是
  "与重构前逐字一致，回退 = 改一个常量"，本轮**一字未改**（它的列组成与 workbench 现在不同，
  这是回退路径的应有状态）。
- **守卫 `goods:ui`**：全量 **+2**（撤 3 条、加 5 条），三遍 **ALL PASS**；总数 227 → **242**
  （口径见 `docs/baseline/PROJECT_BASELINE.md`）。新增：1 条反向守卫（主表不再有那三列 ·
  展开区不再有 SKU 清单）+ 3 条款名守卫（整段在 / 不横向溢出 / 最多两行）。
- ⚠️ **夹具必须给出"长得像真的"长款名**（S1 换成 18 字）：短名在两行内怎么排都放得下 ⇒
  那三条"放不下"的断言**恒绿**。早先试过用一个开关 + 两次页级刷新来造/复位长名 ——
  结果把队列那条"缩略图只合批取一次"的**绝对计数**从 1 顶到 3（每次页级刷新右栏都会重新合批取图），
  红的却是队列断言；改成常驻夹具最稳。
- `goods:shot` 的探针去掉 `variant-table`（换成 `detail-links` / `.gd-detail__meta`）。

### Added · P4 落地：「货与成本 › 进价」—— 款级进价维护界面（2026-10-09 续十七）

路线图 P4「成本维护界面」的最后一格。db 层写入口（`ae-db.costMapUpsertManual`）早在 P4a 就备好，
注释原文就写着"**未接 IPC / host op —— 界面与 op 一起归 P4**"，本轮补齐。

- **新页签「进价」**（`CostPane.vue`，两个页面形态都加）：
  ① 录入 / 改价（选款 + 填价 + 生效日）；② **还没维护进价的款**清单（`pl_products` 减去有成本的款
  —— 这是本页相对「导入模板」的**独有价值**：导入不会告诉你漏了哪个款）；③ 款级成本表
  （一行一款、显示**当前生效**价与来源，展开看生效区间，可删 `manual` 行）。
- **+2 IPC 通道**：`ae-cost-map-upsert-manual` / `ae-cost-map-delete-manual`
  （`verify` **188/184 → 190/186**；`ae-handlers` 12 → 14）。
- **写入口径收到一个文件**：新建 `electron/manual-costs.ts` —— 产品导入的「进价」列与成本维护界面
  **共用**同一份"值相同就不写 / 缺省生效日 = 当天 / 不回落 `0000-01-01`"的判断。
  原 `electron/product-cost-sync.ts` **删除**（移走后它只剩一层没有实质的薄壳，留薄壳是反向负担）。
- **删除只删 `manual`**：`purchase` 行是拿货对账自动同步的产物，删了下次落账会原样写回来
  （用户会在"删不掉"里打转）。确认框明说"删掉后会回落到更早的价"，并有冒烟断言钉住这个回落**真的成立**。
- **口径不新增**：`pickUnitCost` 拆出 `pickCostInterval`（原来只能"给价"、现在也能"给那条区间"），
  成本页与算钱 / 拣货挑的**是同一条** —— 页面自己按日期挑必然漂开（这里写 12.34（手工）、
  利润里算 10.00（拿货）这种错不会报错，只会对不上）。
- **入口唯一**：算钱页的成本表**保持只读**。原注释给的理由（"手点会让用户在两个地方看到两份成本"）
  是错的 —— `ae_cost_map` 就一张表，不是两份；真正的约束是**入口唯一**，注释已改正，
  并加了一句指向「进价」页的路标。
- **守卫**：`ae:smoke` **28 → 31**（删 manual 不动 purchase / 删了回落到更早区间 / 删不存在的不报错）·
  `goods:ui` 三遍 ALL PASS（**+10 条**：页签渲染、当前价取"当前生效"那条、缺价清单、区间展开、
  拿货行不给删除、录入换算成分、**桩真改夹具**、确认框文案、删除载荷、**回落真的成立**）·
  `uxEntryNames` 登记页签名「进价」· `vitest` 仍 644（本轮无新纯函数）。
- ⚠️ **本轮踩的两个坑**（都是本仓记过的老坑新犯，已写进 notes）：
  ① **注入脚本的注释里不能有反引号**（模板字面量被提前终止，`node --check` 直接报语法错）；
  ② **toggle 型展开被点了两次 → 收起**（下一步的选择器成了 `null`，报错信息只指向 `.click()`）。

### Added · 「货与成本」产品模板加「进价」列 —— 导入落 `ae_cost_map`、列表页展示（2026-10-09 续十六）

模板与导出共用同一份表头（`PRODUCT_EXPORT_HEADERS`）：
`款编码 | 款式名 | 供应商 | **进价(元)** | 图片 | 颜色 | 尺码 | 克重 | 状态 | 备注`。

- **落点不是 `pl_products`**（用户提议过、讨论后否，见 `docs/notes/2026-10-30-goods-product-editor.md`）：
  进价的权威是 `ae_cost_map`（款级 + 生效区间 + `source`，ADR-002 Q2）—— 成本有**两个来源**
  （拿货对账自动同步 `purchase` 多行区间 + 手工 `manual`），一列存不下；且 `pl_products` 无价格列是既定裁定。
- **导入**：`parseCostYuan`（元 → 分）+ 逐行校验 → 主进程 `product-handlers` 调
  `electron/product-cost-sync.ts#applyManualCosts` 写 `ae_cost_map(source='manual')`，
  生效日 = **导入当日**（跨域编排收在宿主一处，同 `purchase-cost-sync.ts`）。免费获得
  「改价作用到新订单、历史订单按区间回查仍取旧价」—— **不需要订单表加快照列**（快照在
  "先导订单、后补价"时会抄成 NULL 且补不回）。
- **展示**：产品列表（两种形态）+ 导入预览表新增「进价」列，读 `aeCostMapList()` 用
  `pickUnitCost`（与算钱 / 拣货同一份取价实现）显示**当前生效价**；无价显示「—」**不写 `0.00`**。
- **三条防静默事故的口径**：① **空 = 不修改**（不是清 0 —— 否则"导出 → 导回"一次抹掉全部价）
  ② **非法值 error 剔行**（负数 / 非数字 / 超两位小数，不猜数字）③ **幂等**：值与库内现价相同
  则不写（否则"导出 → 原样导回"每天新增一条区间行）。
- **守卫**：`vitest` `productImport.spec.ts` +18（元→分 / 空≠0 / 非法剔行 / 合并取先出现值 / 导出闭环）·
  `ae:smoke` **23 → 28**（`applyManualCosts` 落库 + 幂等 + 改价新增区间 + 无效行跳过 + 与 purchase 并存）·
  `goods:ui` 三遍 ALL PASS（新增「进价」列显示 + 预览进价列 + `items.costCents` 换算成**分**共 4 条）。
- ⚠️ **顺带修两处既有隐患**：① **`goods:ui` 读 `dist` ⇒ 改完源码没 build 就跑是假绿**（本轮真踩，
  build 后才暴露）② 上一轮「克重广播」让"1 个克重"合法，而冒烟夹具 `IMP-3`（2 尺码 / 1 克重）
  与断言「必须标成跳过」还停在旧规则 —— 夹具改为 **3 个克重**让"对不上"真的成立；按列下标的
  3 处断言随新列整体 +1。
- IPC **零新通道**（复用 `product-import` 的 items 载荷 + `aeCostMapList`）：`verify` 188≡188 / 184。

### Changed · 「货与成本」展开区**去克重**：克重编辑整块搬回「编辑」抽屉（2026-10-09 续十五）

- **口径**（用户拍板）：展开区"信息太多了"，**克重信息只放在编辑页**。展开区的「SKU 克重」子表（含逐行克重输入框、克重术语说明、保存回执）整块移除，改为**只读 SKU 清单**（规格 + 编码，两列、允许换行）；卡片头只报"N 个"，不再带"缺 M 个"（缺克重提示保留在主列表「SKU」列与「只看缺克重」筛选里）。SKU 清单下方一句话指路："增删改点行尾的「编辑」，克重也在那里填"。
- **克重的唯一写入路径 = 编辑抽屉**（`ProductEditorDrawer` 本就有颜色 × 尺码批量生成 + 逐行克重 + 全量提交 + 未保存确认）：克重的术语解释（`gloss('weight')`）跟着搬进抽屉的 SKU 说明里，展开区不再出现。
- **主列表口径不变**：`SKU` 列仍是「n · 缺 m」（待办标记，非克重数值）。
- **守卫（226 → 227）**：新增 3 条"只在编辑页"反向守卫（展开区无 `data-act="weight"` / SKU 清单整块只读 / 说明指路）+ 2 条抽屉写入守卫（全量提交字段齐全 / 存完关抽屉不再弹确认框）；移除 4 条展开区现场克重断言。**顺手修一个假桥盲区**：`productVariantUpsert` 桩原先只记调用不改夹具 —— 旧"导出读当下值"断言是靠组件乐观更新蒙对的；现改为真改夹具（与 `productUpsert` 同口径），并把该写入挪到抽屉步复验（导出期望 `320,275` → `320,333`）。变异复核：把克重输入塞回展开区 ⇒ 两条新守卫各自给出可读 FAIL（`weightInputs=2` / `controls=2`）。

### Changed · 「货与成本」产品列表**展开区重设计**：平铺四块 → 三层结构（2026-10-09 续十四）

- **问题**：上一轮只修了"文字横穿"，但展开区仍是四块内容（认款条 / SKU 表 / 关联列表 / 元信息+按钮）全部平铺在 `surface-2` 井底上 —— 视觉重量相同、没有分组边界；元信息挤左下、编辑/删除悬右下，两块互不相干还高低不齐，"看着乱"。
- **新结构**（`ProductPane.vue`，`data-act` 契约一字未动）：① 认款条升为**带主色浅底的主动作条**（页内唯一色块，动线终点一眼可见，沿用 R2-W3 判据）；② 供应商/类目/创建/备注 + 编辑/删除合并成**一条元信息带**（档案与它的操作同行，备注长时独占一行）；③ SKU 克重与已关联商品改为**两张白底卡片**（`--wb-surface` + 边框圆角，从井底浮起一级），块头加下沿分隔线、计数右对齐，两卡等高。
- **守卫**：`goods:ui` 226 项原样全绿（`row-detail-layout` 的 nowrap / 全宽断言天然复检）；窄视口（<1180px）自动收成单列堆叠。`goods:shot` 截图取证宽窄两档。

### Fixed · 「货与成本」产品列表**展开区样式**：文字横穿网格列压住右列标题（2026-10-09 续十三）

- **根因**：展开区（`row-detail`）住在 `.wb-table` 的 `<td>` 里，而样式基座给 td 定了 `white-space: nowrap`（`styles/index.css`）—— 展开区里的长文案**整体继承 nowrap**：认款提示一行 325px 顶进 ~217px 的网格列、横穿压住右列「SKU 克重」标题；克重说明溢出被面板裁掉。`.gd-detail__empty` 早已单独补过 `white-space: normal` —— 说明这个坑早已存在，只是当年只修了那一个格子。另：`.gd-detail__relate` / `__relate-hint` / `__note` 三个类**从来没有样式定义**（认款动作条挤在左列里折成细长条、`<p>` 默认 margin 撑出怪空隙）。
- **修复**：`.gd-pane__drow > td` 恢复 `white-space: normal`（SKU 子表自己的 td 仍按 `.wb-table td` 的 nowrap 走，直接命中优先于继承）；认款动作条 `grid-column: 1 / -1` 横跨全宽 + flex；提示语与克重说明补字号 / margin。修后布局：动作条整条在最上，SKU 克重与已关联商品并排，元信息与编辑/删除同排（左右各占其位）。
- **守卫**：`goods:ui` **223 → 226**（新 `row-detail-layout` 步：用 `scrollWidth vs clientWidth` 判"文字在自己的格子里放得下"nowrap 一回归立刻红；动作条横跨全宽）。变异复核：nowrap 回归 → `note=301/213` 红；去掉 `grid-column` → `relate=213/467` 红，各自可读、不超时。

### Changed · 产品导入模板改列：去「类目」，加「图片 / 颜色 / 尺码 / 克重」（2026-10-09 续十二）

模板与导出**共用同一份表头**（`PRODUCT_EXPORT_HEADERS`）：`款编码 | 款式名 | 供应商 | 图片 | 颜色 | 尺码 | 克重 | 状态 | 备注`。一行一个款；「尺码 / 克重」可多值（逗号分隔）**按顺序一一对应**，个数不等 → error（回 Excel 改）；同款多行 = **合并 SKU**（不报错剔行，产品字段取先出现者）。

- **「类目」退出模板与导入**：导入不解析不提交该列，库层对已存在的款**原样保留** `category` —— 防"导出 → 改 → 导回"把已有类目清空（全量提交语义下，表里没这列会写成空串）。
- **「图片」列两端都能用**：导出由主进程用 exceljs **嵌入真图**（`electron/xlsx-image.ts` 的唯一实现，"图给人看"），同时该列文本填**本机缓存路径**（"路径给机器读"，同机导出 → 改 → 导回离线可用，不新增数据库列）；导入读 xlsx **嵌入图**按**锚点行**归位，落盘 `userData/product-images/`（SHA-256 去重）→ 写 `pl_products.image_id`。归不了位的图（表头以上 / 空行 / 一行多图）逐条报 warning，不静默错位。
- **导出改由主进程生成 xlsx**（渲染层只算"每格写什么"的纯函数）：嵌图要写 `xl/drawings` + 关系 + 内容类型，渲染层的 SheetJS 写不了这套。分工 = 渲染层算内容（有单测），主进程只写格子 + 嵌图（`electron/product-xlsx.ts`）。
- **克重随 SKU 落库**：导入按行写 `pl_variants`（颜色 × 尺码 + 克重，upsert 语义）；导出从 `product-variant-list` 批量取回拼格。
- **IPC +1**：`product-extract-images`（渲染层传 xlsx buffer + 表名 + 表头行号，主进程抽图落盘返回 行→imageId 映射）。

#### 修一个真 bug：提交路径把「规格对不上」的行放行了

预览时 `parseProductRows` 把 SKU 单元格错误记进行结果的 `skuErrors` 字段、行标「跳过」；但提交前 `validateImportRows` **二次校验只认解析中间态的 `cellErrors`** —— 回传行结果上的 `skuErrors` 被丢，于是预览标了跳过的行**带着空 SKU 照样落库**（goods:ui 实测抓到：IMP-3 规格对不上却出现在 items 里）。修法：校验器两个来源都认（两套字段名各有各的路径）；单测用**只有提交路径才有**的形状（只给 `skuErrors`）钉住，变异复核确认单测与冒烟同时变红。

#### 守卫与门禁

- `tests/productImport.spec.ts` 按新口径重写（表头族 / 顺序对应 / 合并 / 抽图归位 / 提交路径），`tests/uxEntryNames.spec.ts` 登记「图片」（列名）。
- `scripts/product-db-smoke.cjs` 加导入落库用例（SKU 写入 / 类目保留 / imageId 防野值）；新增 `scripts/product-xlsx-smoke.cjs`（`product:xlsx:smoke`）：导出 ↔ 导入**往返** + 嵌图真读回（zip 层验 `xl/media`）。
- `goods:ui` **203 → 223**（导出新形状 / 预览列 / 抽图归位 / 提交剔除等 20 条；含把预览切回「全部行」再断言——预览默认只看有问题的行）。
- 门禁全绿：`tsc -p tsconfig.electron.json` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest`（36 文件 / 626 用例）/ `product:smoke` / `product:xlsx:smoke` / `goods:ui`（三遍）/ `today:ui` / `plugins:island:smoke`（4/4）。

### Added · 「货与成本」**简洁模式**（默认开，页头一键关）（2026-10-08 续十一）

给"第一次用"的人一层减法：页头加一个开关（`data-act="simple-toggle"`，`aria-pressed` 同步），默认**开**。唯一真源是 `src/modules/goods/simple.ts` 里一个**共享 `ref`**，落 `localStorage['sk.goods.simple']`；关掉即恢复完整形态。（⚠️ 2026-10-25 按用户口径**整个撤除**，见同日「款与商品」右栏重排条目 —— 文中路径已不存在）

| 简洁时收起 | 判据 |
| --- | --- |
| 左栏勾选框 / 表头全选 / 批量条 | 第一次用的人没有"批量"这件事，先让他认得一款 |
| 右栏统计条（`PoolMetrics`） | 那排数字是给"已经在做减料"的人看的 |
| 隐藏列 ⇒ 表格列数 7 → 6 | `colspan` **跟着列数算**（写死 7 的症状是"右边缺一块"，不报错） |

**两处刻意不藏**：① 左栏「问题件」下拉 —— 它是「缺克重 / 未关联供应商」两个筛选的**唯一入口**，藏掉就是死能力；② 右栏队列每行的勾选框 —— 那是"认款"的**唯一选择方式**。**没有新增「批量…」按钮**（那会是同一布尔值的第二个控件，且说不清点它是"开"还是"关"）；一个布尔值只留一个开关。

**只作用于工作台形态**：回退形态（`GOODS_LAYOUT='tabs'`）的契约是"模板与重构前逐字一致"，加条件渲染就破坏"回退 = 改一个常量"。切回完整形态时**清空已选中行**（避免"看不见了却还带着一个选中态"）。

### Changed · 「货与成本」新手可用性**收尾批**（P0-5 / P1-2 / P1-4 / P1-5 / P2-1 / P2-2 / P2-3）（2026-10-08 续十一）

对应 `docs/reviews/UX_GOODS_NOVICE_2026-10-08.md` §4 里 R0–R3 之外剩下的条目。

| 条目 | 改法 |
| --- | --- |
| **P0-5** 两个空态说清先做哪个 | 左栏"库是空的"不再并列两个入口：队列**确实拉过且为空**时领头改「先在『今天』页把订单导进来…」，并给主按钮「去『今天』导入订单」（`data-act="empty-go-today"`），`导入 Excel` / `新增产品` 降为次按钮。`queueEmpty` 有**三种**取值（`true` / `false` / `null`），`null` = 队列还没拉过 ⇒ **不翻顺序** —— `null` 不是 `0` |
| **P1-2** 行展开可被发现 | 表格下方常显一句「点任意一行可展开，看它的规格与已认的商品」（`data-act="expand-hint"`）。**没有**改用"默认展开第一行" —— 行展开同时是「当前款」的来源（`expandedId`），默认展开会一进页面就选中第一款 |
| **P1-4** 失效有汇总入口 | 右栏状态筛选旁：有失效时出「有 N 条已失效 → 只看它们」（`data-act="mapped-invalid-only"`，按下即把状态筛到 `invalid`）；已经在看失效时换一句说明。不必再翻「店铺登记」页签去找它们 |
| **P1-5** 术语 / 入口名漂移 | 「今天」页归类面板三处悬空引用（"在货与成本里改"）改成真名：**「建档与关联」页签 · 右栏「已建立映射」**；`tests/uxEntryNames.spec.ts` 的 `ALLOWED_NON_ENTRY` 登记 `建档与关联`（页签名，存在性由 `goods:ui` 断言） |
| **P2-1** 悬停信息常显 | 队列 / 已映射行的图注不再只靠 `title`：常显来源短名（手动图 / 订单图 / 产品图 / 图 / 没有图，`data-act="q-thumb-src"` / `"m-thumb-src"`），可放大的格子补 `⤢` 角标；已映射行另常显"来源：xxx"（`data-act="m-source"`） |
| **P2-2** 拖选补按钮 + 键盘可达 | 编辑抽屉尺码组：标签写明「点击选中；按住拖动可连选 / 连消；键盘用回车切换」，每个码 `@keydown.enter` / `@keydown.space` 可切换，每组末尾补「全选本组 / 清空本组」（`data-act="size-all"` / `"size-none"`）—— 拖选之外有不用鼠标的等价路径 |
| **P2-3** 对比弹层键盘提示降级 | 提示从"看起来像要求"降为 11px / 0.75 透明度的补充说明，文案改成「也可以只用键盘：← / → 换候选 · 空格 关联 · Esc 关闭」 |

**`goods:ui` 180 → 203 项**（全量 181 + 默认窗口可达性 11 + 窄视口 11）。新增 `simple-mode` / `mapped-invalid-entry` / `viewport-narrow-empty-order` 三组步骤，以及队列图注、已映射行来源的常显断言。

**两处"空转断言"已修（本轮最值得记的一条）**：① 假桥的 `productSkuSummary` 原先写死 `byStatus: []` ⇒ 失效条数恒 0，"有正数才显示"这条断言**恒绿**；改为按状态真实聚合。② 补反向夹具 `window.__smokeNoInvalid`，让"库里零失效"这个状态**造得出来**，才能断言"0 时不渲染"；加这条之前，把"丢条数守卫"改坏的变异体**不变红**（实测 M6）。另：反向断言的等待信号必须钉在**目标状态**上（等"入口消失"），等"汇总被多取一次"会被上一步请求喂饱。

**门禁**：`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅（零 IPC 改动）· `verify:docs` ✅ · `build` ✅ · `vitest run` **36 文件 / 593 用例** ✅ · `goods:ui` **203 PASS / 0 FAIL** ✅ · `today:ui` **139 PASS** ✅ · `plugins:island:smoke` **4/4** ✅。10 组变异逐条确认变红（见 `docs/notes/2026-10-30-goods-ux-refactor.md`）。

### Changed · 「货与成本」按新手可用性方案执行 **R0–R3**（2026-10-08 续十）

`docs/plans/GOODS_UX_REFACTOR_PLAN.md` 的 R0–R3 全部落地（用户拍板"R0–R3 全做"）。四段顺序**不可换**：修 bug 先于文案、解死锁先于包装层、包装层先于首次动线（理由见笔记）。

| 段 | 内容 | 主要位置 |
| --- | --- | --- |
| **R0 修 bug** | ① 左栏「已关联商品」缓存不再"拉过一次即置位"（认款后两栏口径自相矛盾）；② 「显示更多」真假判据（`queuePendingTotal` / `queueHasMore`，原判据恒真）；③ 窄形态（<1180px）左栏空态不再溢出被遮（`grid-template-rows: max-content max-content`）；④ 右栏队列**列精简**——只留商品ID + 图片（图为主），「对比」在默认 1200×800 下不再被裁 | `ProductPane.vue` / `useSkuPool.ts` / `PoolPane.vue` / `GoodsWorkbenchView.vue` / `goods-ui-smoke.mjs` |
| **R1 解死锁** | 「店铺登记」**收进内建页签**（`ShopRegistryView.vue`，原在未安装的 UI 岛里）⇒ 提示条「现在登记」与行内「去登记」**都**有真出口；页签 id/显示名收成单一真源 `tabs.ts`；`shopApi.ts` 隔离店铺域调用 | 新增 `tabs.ts` / `shopApi.ts` / `ShopRegistryView.vue`；`GoodsView.vue` |
| **R2 包装层** | 左栏展开区「**认到本款**」按钮（带计数、0 时禁用、写真进左栏展开的那一款）；指标条抽成 `PoolMetrics.vue`（**0 不占位** + 全零**说一句真话** + `null` 时一项都不渲染）；单项操作不说"批量"（`batchLabel`）；术语首现加括号白话（`glossary.ts`）；编辑抽屉**统一保存模型**（离开输入框即落库 / 快照对比 `formDirty` / 单飞 `flying` / `closeGuard` 只对"真的会丢"的 SKU 改动确认） | 新增 `glossary.ts` / `PoolMetrics.vue`；`ProductPane.vue` / `PoolPane.vue` / `useSkuPool.ts` / `ProductEditorDrawer.vue` / `ProductPicker.vue` / `SkuMappingView.vue` |
| **R3 首次动线** | **空库一次性引导卡**（零款 + 队列已拉过且为空才出现，三步 订单→店铺→认款，第三步**刻意无按钮**，有款后**自己消失**）；页头「?」帮助面板与卡**共用**同一份三步（`firstRun.ts` 的 `FIRST_RUN_STEPS`） | 新增 `firstRun.ts` / `FirstRunCard.vue`；`useProductList.ts`（`stylesTotal` 取**全库**汇总）/ `GoodsView.vue` / `GoodsWorkbenchView.vue` |

**守卫升级（本轮最重要的一条）**：断言从**存在性**升级为**可达性** —— `getBoundingClientRect` 在视口内 **且** `elementFromPoint(中心)` 命中自己。原 bug 的症状正是"元素在 DOM 里但用户点不到"，存在性断言对它恒绿。冒烟 runner 由两遍视口扩为**三遍**（1440×900 全量 / 1200×800 默认窗口可达性 / 900×800 窄视口），`goods:ui` **110 → 180 项**。

**门禁**：`vue-tsc` ✅ · `build` ✅ · `verify:docs` ✅ · `goods:ui` **180 PASS / 0 FAIL** · `vitest run` **36 文件 / 593 用例**（新增 `tests/goodsFirstRun.spec.ts` 8 例）。7 组变异逐条确认变红（见 `docs/notes/2026-10-30-goods-ux-refactor.md`）。

> ⚠️ **变异跑完必须 `npm run build` 再跑最终门禁** —— 本轮真的踩了：C1b 的变异体（`firstRun.ts` 的 `&&` 改 `||`）留在 `dist/` 里，让最后一次全量冒烟挂着两条"源码看着对"的假 FAIL。`*:ui` 读 `dist/`，"改界面先 build"在本仓是前提不是建议。

### Removed · `docs/guides/USER_GUIDE.md` 正文**已删除**（594 行 → 下线说明）

原文描述的是「TV模版」时代的三栏界面，与现在的界面**对不上**（照着找会找不到）。**594 行正文整篇删除**，文件改为下线说明：现在去哪儿看 = 应用内「货与成本」页头右上角的 **「?」**（三句话 + 一张三步图，R3 加的）；历史版本走 `git log --follow docs/guides/USER_GUIDE.md`。保留文件路径只为不让别处的引用悬空（`docs/README.md` 三处引用同步改为「已下线」）。

### Added · 「货与成本」**真机走查**完成并产出新手可用性交互重构方案（2026-10-08 续九）

用真实 userData 克隆 + 全新空 userData 各跑一遍应用（CDP 实测，含 `elementFromPoint` 命中检测），**推翻同日静态审查"只差包装层"的结论**：实测出 4 个硬 bug——

1. 左栏「已关联商品」缓存永不刷新（`ProductPane.vue` `loadLinks` 拉过一次即置位）：认款后两栏口径自相矛盾，仅重启恢复；
2. 「显示更多」假动作（`useSkuPool` 判据 `groups > shown` 恒真）：点击后计数与行数均不变；
3. 窄形态（<1180px，**全新安装默认视口即在此**）左栏空态溢出容器且被工具栏遮挡，按钮点不到；
4. 默认 1200×800 下右栏队列「对比」按钮被裁、超出视口——**S3 的对比动线在默认窗口不可达**。

另实测坐实：店铺未归一死锁成立（提示条零可点元素 + 全新安装侧边栏无「店铺账号管家」）；编辑抽屉静默丢弃未保存内容；`0 · 缺 0` 与全零指标条复现。

产出：`docs/plans/GOODS_UX_REFACTOR_PLAN.md`（R0 修 bug → R1 解死锁 → R2 包装 → R3 首次动线；守卫升级为**可达性断言**；新增待拍板 UX-G6/G7）。静态审查 `docs/reviews/UX_GOODS_NOVICE_2026-10-08.md` 补 §7 修正记录。**本条只含文档，未改任何代码。**

### Changed · 「货与成本」重构 **S4**：页签 3→2 收口、工作台恒两栏，并补上拖了两轮的窄视口守卫（2026-10-08 续八）

`docs/plans/GOODS_WORKBENCH_PLAN.md` 的 S4：把「产品」与「映射与关联」**合并成一个页签**。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/GoodsView.vue` | `TabId` 加 `'workbench'`；**`TABS` 按 `GOODS_LAYOUT` 分叉**（workbench = 建档与关联 + 供应商；tabs 回退 = 产品 / 商品清单 / 映射与关联 / 供应商）；`TAB_DESC` 加合并后的一句；默认页签改 `'workbench'`；模板分支改 `v-if="GOODS_LAYOUT === 'workbench' && tab === 'workbench'"` |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | **删 `pool` 属性**（含 `.is-pool` / `.is-idle` 两套样式）：工作台**恒两栏** |
| `scripts/goods-ui-smoke.mjs` | 页签断言迁移 + 反向守卫；`workbench-shell` 的"池栏首屏未激活"**反向**为"首屏就激活"；runner 改**两遍视口**；抽 `finish()` |

**为什么页签能合并**（判据不是"少一个页签更清爽"）

分栏的全部价值在**同屏**：左栏看着款、右栏认着货，左栏选一款右栏就能直连、就能对比。分成两个页签，两侧永远不可能同时出现在屏幕上 —— 直连与对比这两条动线在物理上就不成立。所以合并是 S3 三条动线成立的前提，不是收尾时的美化。

⚠️ `'tabs'` 回退形态**仍是三个页签**（它是整宽单栏，产品表与队列必须各占一屏）。回退时页签跟着一起回去，否则"改一个常量回退"就是假的（会退到一个只剩两个页签、却仍然单栏渲染的表上）。

**⚠️ 一处"前提消失"而非"顺手删"（`pool` 懒挂载）**

S0 建两栏外壳时，池栏是**懒挂载**的，理由：首屏停在「产品」页签时池栏看不见，不该白付一次全量订单聚合。S4 把两个页签合并后**该前提消失** —— 进这一页就是进工作台，池栏上来就在屏幕上，那次聚合正是用户看得见的那一栏该做的事。于是 `pool` 开关与两套样式一并撤掉，改成恒两栏。

理由已写成代码注释：这是"前提消失"，不是"懒挂载不划算"。将来若再出现"池栏可能不可见"的形态，这个开关该回来，而不是把它永久删掉。

**⭐ 补上拖了两轮的窄视口守卫（方案 §9-1）**

方案从 S0 就写着"窄窗口（< 1180px）两栏改上下堆叠，且**两栏都在**（不是有一个消失）"，CSS 当时就写好了，**断言一路推到 S4**。落地方式：`goods:ui` 的 runner 由"单次 spawn"改成**两遍**——

| 遍 | 视口 | 跑什么 |
| --- | --- | --- |
| 一 | `--window-size=1440,900` | **全量断言**（含"宽视口两栏并排"） |
| 二 | `--window-size=1000,900` | **只跑窄视口守卫**（3 条） |

注入脚本**自己按 `window.innerWidth` 判断**该跑哪一套，所以 runner 不必额外注入任何标记 —— 视口宽度就是判据本身。

判据用 `grid-template-columns` 的**轨道个数**（并排 = 两个轨道如 `420px 960px`；堆叠 = 一个如 `744px`），而不是"看起来像不像堆叠"：这样顺带守住"把 grid 改成 flex、媒体查询从此失效"这类静默回归 —— 那种改法视觉上可能恰好也是堆叠，但断言会红，因为判的是**声明**不是观感。

**守卫**：`goods:ui` **105 → 110**（宽视口 107 + 窄视口 3）。既有 105 条**全部自动重挂通过**（只改了"点击的页签文案"与**一条断言的方向**，没动任何 `data-act` 名）。

**变异复核（4 条，全部确认变红后复原，`grep MUTANT` 零残留）**

| # | 变异 | 结果 |
| --- | --- | --- |
| A | 把「映射与关联」页签塞回来（合并没做） | 宽那遍红 **2** 条（页签条数 / 旧页签不再存在） |
| B | 页签合并了但 `data-act` 仍叫 `tab-products` | 红 **1** 条（旧页签的 `data-act` 必须消失） |
| C | 窄视口媒体查询断点由 1180px 改成 300px | **窄那遍红 1 条**（`cols=420px 316px`）—— 证明第二遍真在起作用，不是恒绿 |
| D | 池栏容器加 `style="display:none"` | 宽红 **1** + 窄红 **1**（两栏同屏 / 两栏都在）—— 证明"可见性"判据不是恒真 |

**⚠️ 本轮又踩的两个坑（已进 `notes/2026-10-05-repo-hard-constraints.md`）**

1. **BSD `grep` 的 `\|` 交替又静默失配**：用 `grep "goTab\|TabId\|GOODS_LAYOUT"` 查引用面，返回"无匹配"，看起来像"这些标识符已经没人用了"。改用 Grep 工具（ripgrep）立刻看到一堆命中 —— 差点据此判断"页签相关只有一处要改"。这是本仓记载过的老坑的新一次显形。
2. **`node --check` 覆盖不到注入脚本的*内部*语法**：`goods-ui-smoke.mjs` 里两段要注入的脚本是模板字面量的内容，`node --check` 只校验外层 JS。于是"模板串提前闭合"它抓得到，但**注入脚本自己写错语法**它抓不到 —— 症状是页面挂掉、报"没抓到 #smoke-result"，很难定位。本轮新写的 `finish()` / `narrowViewportChecks()` 正落在这个盲区里，于是补了一步：**把两段注入脚本抠出来单独 `node --check`**（按 `const X = <模板串起点>` 与结尾的 `;` 切，剥掉 `<script>` 标签，各自 check）。

### Added · 「货与成本」重构 **S3**：关联动线（弹层带图 + 直连 + 对比模式），零新 IPC（2026-10-08 续七）

`docs/plans/GOODS_WORKBENCH_PLAN.md` 的 S3：把"认出这是哪一款"这件事从**记忆**变成**看**。
三条动线，**一条新 IPC 都没有**（全部复用既有通道）。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/components/CompareModal.vue` | **新增**：对比认款弹层 —— 左 = 候选产品大图（`←/→` 翻），右 = 该商品的订单图；`空格` 确认关联、`Esc` 关闭 |
| `src/modules/goods/components/ProductPicker.vue` | 每行加产品主图（`imagePath` → 合批缩略图；无图渲染空占位） |
| `src/modules/goods/components/ProductPane.vue` | 「当前款」上报（`select-product`）：**用户真的展开过的那一行** |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 转一手 `currentProduct`（左栏 → 右栏）—— 全页唯一的跨栏状态 |
| `src/modules/goods/useSkuPool.ts` | 加 `selectedProduct` 输入 + `relateToSelected`（直连）+ `openCompare` / `confirmCompare`；抽 `commitMap` / `queueWriteRows`（三处写映射**收敛成一条路径**） |
| `src/modules/goods/components/PoolPane.vue` / `SkuMappingView.vue` | 队列工具栏加「关联到 `<款编码>`」（分栏才有）；每行加「对比」；都挂 `CompareModal`（两形态行为一致） |

**三条动线**

- **弹层带图**：`ProductPicker` 每行显示产品主图。认款靠肉眼比图（款编码 / 名称常常也认不出来），
  而队列那边的商品图本来就有 —— 只有一边有图等于白给。取图失败渲染空占位，**不是**整列空掉
  （图取不到不该让人连产品都选不了）。
- **直连**：左栏展开一款 → 右栏勾选商品 → 点「关联到 S2（2 项）」。分栏之后款与商品同屏，
  比"勾商品 → 开弹层 → 搜款 → 选"少两步。⚠️ 与弹层选产品**同一条写路径**：不新增写路径
  = 不新增一套失败语义。颜色落 `'*'`（不给色比替用户猜一个诚实——猜错会把该商品的所有订单
  带到错的颜色上，且事后看不出那是猜的）。
- **对比模式**：左候选产品 / 右店铺商品并排放大，`←/→` 换候选、`空格` 关联、`Esc` 关闭。
  ⚠️ 左侧候选图**独立取**（产品主图），**不能**走 `itemImagePool` 的产品层 —— 队列是"还没配映射"
  的那一半，那层对它必然为空，拿它当候选图会得到一片空白**而且不报错**。

**⭐ 「当前款」为什么不是 `selectedId`**

`useProductList` 的 `selectedId` 一进页面就指向第一行（整宽形态的详情面板需要它）。若拿它当
当前款，用户**没选任何款**时右栏也会挂着一个"看起来已经选好"的落点 —— 照着点就是**写错款**，
而且事后看不出那是系统替他选的。故用"用户真的展开过的那一行"（`ProductPane.expandedId`），
并在**收起 / 该款被筛掉**时一并撤回（`watch(rows)` 清理：否则右栏会挂着一个屏幕上已看不见的款）。

**连带清理（零消费者即删）**

- 删掉 `ProductPane` / `ProductListView` 的 `changed` / `suppliers-changed` emit
  与 `useProductList` 的 `onChanged` —— 指标条撤掉后整条链无人监听（同续五、续六的纪律）。

**守卫（`goods:ui` 80 → 105）**

- 直连 10 条：入口写明落到哪一款（S2）· 没勾选时不可点 · ⭐ 落点是**左栏展开的那款**（不是产品列表
  第一行）· 不带颜色 · 写完队列重拉 · **收起展开行 → 入口消失**（反向守卫，钉"当前款 = 真的展开过"）·
  重新展开 → 恢复。
- 对比模式 11 条：开 → 左右两栏 · 右侧是订单图 · 初始候选 = 左栏当前款 · 候选无图时给"空占位 +
  下一步" · `←` 换候选 · ⭐ 左侧是**候选产品自己的主图** · `空格` 写入的是当前候选 · 确认后自动关 ·
  写入完成后行内动作恢复可点 · `Esc` 关闭。
- 弹层带图 3 条：每行有图 · 有图那行装的是**它自己的**主图 · 无图那行渲染空占位（"有图 / 无图"
  两个样本同屏，否则"失败即空列"这条恒绿）。

**变异复核（5 条，全部确认变红后复原，`grep MUTANT` 零残留）**

| # | 变异 | 结果 |
| --- | --- | --- |
| A | 直连写死 `productId = 第一行产品`（方案 §8-3-4） | `goods:ui` 红 **1** 条（⭐ 落点是左栏那款） |
| B | 对比模式候选图改走 `itemImagePool` 的产品层（§8-3-5） | 红 **1** 条（⭐ 左侧是候选产品主图） |
| C | 弹层无图行不渲染空占位（§8-3-7「失败即空列」） | 红 **1** 条（无图行渲染空占位） |
| D | 对比模式 `←/→` 整段没接 | 红 **3** 条（换候选 + 依赖它的两条） |
| E | 收起展开行时不撤回「当前款」 | 红 **1** 条（收起 → 入口消失） |

**⚠️ 夹具改造（两处，都是"断言强度不够"逼出来的）**

1. **加产品主图 + 产品图与订单图用不同 dataUrl**：两边返回同一张的话，"对比模式左侧取的是产品主图"
   这条断言恒绿 —— 图对不对永远不会被发现。同时给 S1 有图 / S2 无图两个样本。
2. **加夹具复位**（`__smokeReset` + `__smokeClearCalls`）：S3 之后「直连」「对比确认」「批量关联」
   **三条动线都要消耗那两行待关联商品**，而各自的断言都建立在"队列里有 2 行可勾选"这个初始态上。
   用一个夹具跑三个场景就必须能回到原点 —— 否则只能删掉其中两个场景的断言（那才是真的降级）。
   ⚠️ 清的是 `calls` **这个对象本身的内容**，不是把 `window.__smokeCalls` 换成新对象：换掉之后
   `rec` 仍往旧对象里写、断言读的却是新对象 —— 全场恒绿，而且不报错。

**⚠️ 三处"跑起来才发现"（本条目的主要价值）**

1. **「合批取图」的绝对计数会被同一条通道的其它调用污染**：左栏产品列表用的是同一条
   `image-thumb-batch`，于是"只调了 1 次"变成恒红。改成数"请求里含这张订单图的那几次"——
   断言守的是队列侧的行为，就该只数队列侧的调用。
2. **等待条件不能指向"上一步也可能出现"的那句话**：直连与批量关联都发「新增 2 条」回执，
   而虚拟时间下前一条可能还没过期 ⇒ `waitFor` 立刻为真、读到的是**上一步**的回执（那条断言于是
   恒错）。等待条件必须指向"这一次才可能出现的那句话"（此处是「款主图」）。
3. **写入期间按钮是 `disabled` 的，在 disabled 按钮上 `click()` 不派发事件**：`Esc` 那一步
   "弹层没打开"很容易被读成功能坏了。先等行内动作恢复可点再点（这条等待本身也是个断言）。

### Changed · 「货与成本」重构 **S2**：右栏换成专用「商品池」（列裁剪），池逻辑抽成共用 composable（2026-10-08 续六）

`docs/plans/GOODS_WORKBENCH_PLAN.md` 的 S2：两栏工作台**右栏**从整宽的 `SkuMappingView` 换成**分栏用的
`PoolPane`**，按方案 §7-2 裁列；同时把池的取数与交互逻辑抽成 `useSkuPool`，两个渲染形态共用（与 S1 的
`useProductList` 同一套办法）。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/useSkuPool.ts` | **新增**：商品池的取数与交互逻辑（队列实时聚合 / 已映射分页筛选 / 批量与改绑**一次提交** / 三层回落取图 + 合批缩略图 / 看图弹层 / 标失效与恢复），由下面两个渲染形态共用 |
| `src/modules/goods/components/PoolPane.vue` | **新增**：右栏（分段控件 + 队列 / 已映射）。列裁剪见下；所有 `data-act` 名与整宽形态**逐字一致**（方案 §8-1 的选择器稳定契约） |
| `src/modules/goods/components/SkuMappingView.vue` | 脚本改为调用 `useSkuPool`（**模板与样式一个字未动** —— 它是 `GOODS_LAYOUT='tabs'` 的回退形态，DOM 必须逐字保留） |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 右栏 `SkuMappingView` → `PoolPane`；并把页级 `refreshNonce` **也透传给右栏**（页级「刷新」应当刷新同屏的每一栏，只刷左栏会让"我在右边看着队列、点刷新却什么都没变"） |

**列裁剪（右栏 ~60% 宽，方案 §7-2）**

- **队列 9 → 7**：`平台` 折进「店铺」格的小标签；`状态` 折进**行态**（未归一行整行浅底 + 「操作」列
  禁用并说明原因「需先登记店铺」）—— 原「状态」列那两句话本来就是"能不能点"的注释。自动建议
  （「疑似 X（平台）」）随状态列一起挪进「店铺」格，仍留在同一行文本里。
- **已映射 9 → 6**：`平台` 折进「店铺」格；`来源` 与 `更新时间` 移进行 `title`（它们只回答"这条为什么变了"，
  不该常驻占宽）。
- 取图、看图弹层、分段控件、`map-stats` / `map-failures` / `map-refresh` 全部**整段照搬，不改口径**。

**口径与连带改动**

- 主进程裁定的三条口径**一条未动**：队列是实时聚合（非缓存表）· 未归一行不给关联按钮 ·
  批量关联一次提交整批。
- **删掉零消费者的 `changed` emit**：`SkuMappingView` 原先把「待关联数」报给外壳的页签徽标；徽标随指标条
  一起撤掉后无人监听 —— 不留"转发了没人听"的空管道（同续五的纪律）。

**守卫（`goods:ui` **77 → 80**）**

- 既有 77 条**全部自动重挂通过**：列裁剪没有动任何 `data-act` 名，断言钉的是锚点不是列位置 ——
  这正是 §8-1 契约的价值（契约一稳，界面重构就不用成批改守卫）。
- **新增 2 条 S2 反向守卫**：
  ① **队列里不出现已建立映射的商品**（队列 = 订单聚合 − 生效映射，不是缓存表；夹具的四条历史映射与
  「队列」三条**无交集**，正好互证）；② **队列列已裁**（`平台` / `状态` 不再是独立列 —— 再拆回独立列就等于没裁，
  理由同工具栏那条 `toolbar-shape` 反向守卫）。
- **新增 1 条按 id 的锋利断言**：批量关联后，刚认下的两个商品**按 id** 从队列消失（只数行数会漏掉
  "换了一批别的东西"）。

**变异复核（3 条，全部确认变红后复原，`grep MUTANT` 源码零残留）**

| # | 变异 | 结果 |
| --- | --- | --- |
| ① | 把已映射行也渲染进队列表（模拟"合并两个视图"） | 红 **4** 条：含两条新守卫（`queue=[...SKU-OLD...]` / 队列行数 7） |
| ② | 队列表加回一个独立 `平台` 列 | 红 **1** 条（「队列列已裁」，表头出现 `平台`） |
| ③ | 写入后只重拉映射列表、不重拉队列 | 红 **3** 条：含「刚认下的两个商品已从队列消失」（`queue=["SKU-A1","B0XYZ1234","TB-999"]`） |

⚠️ **顺带修好两条守卫形态（同一坑的第二次显形）**：`step('queue')` 与 `queue-reload` 两处把
"行数对不对"写成了 `waitFor` 的**条件** —— 变异③一跑就 `SMOKE: FAILED at [queue] - timeout`，
**后面几十条断言一起被吞掉**。改成 `settle(fn, ms)`（有界轮询、超时也不抛）负责"等它渲染出来"、
判定留给紧跟的 `report(...)`：断言一字未放松（仍是"3 行" / "1 行"），只是失败形态从 `timeout` 变成
可读 FAIL（`rows=7`）。改完再跑同一个变异 ⇒ 脚本**跑到底**、红得有指向。

### Changed · 「货与成本」页首减负：撤掉**指标条**与**起点引导条**，筛选入口搬进左栏，页头收成单行（2026-10-08 续五）

用户看了 S0/S1 的成品后的三句反馈，逐字对应三件事：**① 步骤条（立款 → 补克重 → 认货）去掉，
"感觉实用意义不大"；② 产品 / SKU / 缺克重 / 未关联供应商 / 已映射商品ID 那一栏也去掉；
③ 重新布局页面。**

**撤掉了什么**

| 位置 | 动作 |
| --- | --- |
| `GoodsView.vue` 的 `wb-metabar gd-stats`（指标条 5 格） | **整块删除**。那 5 个数字在左栏每行本来就有（`n · 缺 m`、状态列），单独再汇总一行是重复 |
| `GoodsView.vue` 的 `gd-guide`（三步引导 + 「下一步」按钮） | **整块删除**。页签点一遍就知道顺序；常驻一条只占高度、不带来新信息 |
| 页签上的**数字徽标**（`gd-tab__badge`） | 一并去掉（徽标与被撤的指标条同源，留着就要保留整套页级汇总取数） |
| 页首布局 | 只剩「页头 + 页签」两层：页头一行（标题 + 随页签走的说明 + 刷新），页签紧贴主体 |

**连带移除（不是顺手删，是**没有消费者**了）**

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/flow.ts` | **删除**：`buildGoodsFlow()` 是引导条的判据，引导条撤掉后零消费者 |
| `tests/goodsFlow.spec.ts` | **删除**：它测的正是上面那个纯函数 |
| `Stats` / `loadStats` / `badgeOf` / `flow` computed / `goProducts` / `goStep` / `onMappingChanged` | `GoodsView.vue` 里整套删除 —— 它们唯一的用途就是喂指标条与徽标。**外壳不再取任何数**（原先每次刷新多打 3 次 IPC 只为喂一行没人看的数字） |
| `GoodsWorkbenchView.vue` 的 `changed` / `products-changed` / `suppliers-changed` 三条 emit + `onPoolChanged` | 删除：子视图→外壳的回报链是给页级汇总用的，汇总没了这条链就是空管道 |

**「缺克重 / 未关联供应商」两个筛选的入口搬进左栏**（关键：不搬就是**死能力**）

这两个筛选原先**只能从指标条进入**（左栏工具栏只有 搜索 / 状态 / 供应商）。指标条一撤，若不补入口，
它们就变成"界面还在、永远进不去"。故：

- `useProductList.ts`：删掉外部驱动的 `intent` 管线（`ProductIntent` / `applyIntent`），改成**内部单一真源**
  `issueFilter: '' | 'missingWeight' | 'noSupplier'`；`onlyMissingWeight` / `withoutSupplier` 由 `ref` 改**派生 computed**。
  ⚠️ 为什么必须单一真源：入口从一个"下拉"进来，下拉只能有一个值；两个可各自为真的 `ref` 会出现
  "下拉显示『缺克重』、实际两个条件都在生效"这种界面对不上、又看不出哪里错的状态（服务端还是快捷筛选优先，
  第三个条件等于被静默丢弃）。
- `ProductPane.vue` 与 `ProductListView.vue`（回退形态）的工具栏**各加同一个** `data-act="filter-issue"` 下拉
  （全部款式 / 缺克重 / 未关联供应商）—— 两个渲染形态行为一致。
- 页级「刷新」改成 `refreshNonce` 信号：外壳不再自己取数，值一变就戳当前挂着的视图重拉。

**与实现相关的三处取舍（照实写）**

1. **刷新按钮不再显示「读取中…」**：外壳已无自己的加载状态可报；各视图的工具栏本身有 `读取中…`。
   留一个假 loading 比没有更糟。
2. **供应商 ↔ 问题件互切时可能多打一次 IPC**：两个 `watch` 各自触发一次 `load()`。仅在两个筛选互切时发生，
   换来的是两处状态永远不可能各自为真。
3. **`flow.ts` 是删而不是留**：它不是 `GOODS_LAYOUT='tabs'` 那种"刻意保留的回退路径"，
   而是零消费者的死代码；留着就要连单测一起养。历史可 `git log` 回溯。

**守卫（`goods:ui` **85 → 77**；删 17 条、加 9 条）**

- **删**：指标条 3 条 · 指标条点筛 4 条 · 引导条 4 条 · 「下一步」带筛选 1 条 · 引导条前进 2 条 · 引导条切页签 3 条。
  （`metric()` 辅助函数一并删。）
- **改**：`save` 步的"缺克重计数实时归零"从**指标条读数**改判**那一行自己的** `missing-weight-cell` —— 语义不变
  （保存后界面必须立刻反映，不能等下次刷新），只是读数位置随 UI 迁移。
- **新增 3 条反向守卫**（删掉的能力必须留一条"不再有它"，否则会以"少了个总览"的名义回来）：
  页首不再有指标条 · 不再有引导条 · 页签不再挂徽标。
- **新增 6 条入口断言**：左栏工具栏有 `filter-issue` 下拉 · 选「缺克重」真把列表筛到 1 款 · 筛窄靠发参数给主进程
  · 出现活跃筛选 chip · chip 的 × 撤掉条件后回到 2 款 · **撤掉条件后下拉自己回到「全部款式」**（单一真源，防"下拉还显示缺克重"）。
- `toolbar-shape` 里那条断言**反了过来**：原来断"工具栏**不该**有「只看…」开关"（理由：入口统一在顶部指标条），
  现在断"工具栏**必须**有 `filter-issue`"（理由反转：指标条没了，它成了唯一入口）。

**变异复核（3 条，全部确认变红后复原，`grep MUTANT` 源码零残留）**

| # | 变异 | 结果 |
| --- | --- | --- |
| ① | 把 `data-act="stats"` 与 `.gd-tab__badge` 各塞回一个 | `goods:ui` 红 **2** 条（指标条 / 徽标两条反向守卫；**引导条那条正确地保持 PASS** —— 证明它盯的是自己那个锚点，不是"N 个锚点都没了"） |
| ② | 撤掉左栏工具栏的 `filter-issue` 下拉 | 红 **1** 条（「工具栏有「问题件」下拉」——正是那条入口守卫） |
| ③ | 去掉 `issueFilter` 的 `watch`（选了不重载） | 红 **2** 条（「筛到 1 款」`rows=2` + 「筛窄靠发参数」载荷 `onlyMissingWeight:false`） |

⚠️ **变异③顺带修好一条守卫形态**：它第一次跑出来的是 `SMOKE: FAILED at [issue-filter] - timeout`，
不是可读 FAIL —— 因为我把「列表变成 1 款」写成了 `waitFor` 的**条件**，一旦筛选没生效就超时中断，
**后面 40 多条断言一起被吞掉**。这正是硬约束表里那条"不要把断言本身写成等待条件"。改法：新增
`settle(fn, ms)`（**有界轮询，超时也不抛**）负责"等它渲染出来"，判定留给紧随其后的 `report(...)`。
改完再跑同一个变异 ⇒ 2 条**可读 FAIL**（`rows=2` / `onlyMissingWeight:false`），且脚本**跑到底**。
`settle` 与 `waitFor` 的唯一区别就是超时不抛，所以对既有断言是纯增量、零风险。

**文档面**：`scripts/check-doc-links.mjs` 的 `DELIBERATELY_MISSING` 新增两条豁免
（`src/modules/goods/flow.ts` · `tests/goodsFlow.spec.ts`）—— S1 条目、`GOODS_WORKBENCH_PLAN` 与那条引导笔记
记述的是"当时新增了它"，**改指现存文件句子就不成立**，属历史记录而非悬空引用。
`docs/notes/2026-10-30-goods-list-and-pool.md` 顶部加 ⚠️ 横幅，声明引导条已撤、该笔记降级为历史记录。

### Changed · 「货与成本」重构 **S1**：左栏换成专用产品栏（紧凑列表 + 行展开），数据层补「按款反查」（2026-10-08 续四）

`docs/plans/GOODS_WORKBENCH_PLAN.md` 的 S1：左栏从整宽产品表换成**分栏用的紧凑列表**，把装不下的东西收进**行展开**；
同时补上"产品侧能看见自己关联了哪些店铺商品"这个一直缺的入口（数据模型里产品挂在商品上，此前只有商品→产品一侧）。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/useProductList.ts` | **新增**：产品列表的取数与交互逻辑（三个筛选互斥 / 分页 / 选择集跨页清理 / **全量提交**的克重保存 / 缩略图合批 / 批量编辑的部分 patch / 逐条删除），由下面两个渲染形态共用 |
| `src/modules/goods/components/ProductPane.vue` | **新增**：左栏紧凑列表（☑ / 图 / 款编码 / 款式名 / `n · 缺 m` / 状态）+ **行展开**（`row-expand` → `row-detail`：供应商 / 类目、`detail-skus` 内联改克重、`detail-links` 已关联商品只读） |
| `src/modules/goods/components/ProductListView.vue` | 脚本改为调用 `useProductList`（**模板与样式一个字未动** —— 它是 `GOODS_LAYOUT='tabs'` 的回退形态，DOM 必须逐字保留） |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 左栏 `ProductListView` → `ProductPane` |
| `electron/product-db.ts` · `product-handlers.ts` · `electron/preload.ts` · `src/core/services/ipc.ts`（**两处**）· `src/modules/goods/api.ts` | `SkuMapQuery` 加 `productId` 反向过滤 + 五处透传。**不新增表、不新增 IPC 通道**（`verify` 契约不变），复用既有索引 `idx_pl_shop_sku_product` |

**三条口径**：

- **反查只列 `confirmed`**：失效映射指向的店铺商品已经不在了，混进「已关联」会让用户以为那个商品还在用；
  但它也**不能一声不吭地藏掉** —— 展开区单列一句「另有 N 条已失效」。
- **反查必须带 `productId`**：不带就是"每一款点开都显示全库映射"，界面上完全看不出错。数据层与界面各一条断言钉它。
- **`detail-links` 里没有任何解除/删除按钮**：硬删会让关联率莫名回落且查不出原因；失效走"标失效"。

**与方案 S1 原文的两处偏差（按代码现实回改）**：

1. **列表逻辑抽成 `useProductList` 两形态共用**，而不是让新组件抄一份。照抄会多出约 400 行，代价不是行数，
   而是**两处会漂** —— 回退路径没有任何冒烟覆盖，抄错的那一份不会有人发现，等真要回退时才发现回退不了。
   ⚠️ 代价照实写：回退路径的**逻辑**不再独立（composable 出问题两边一起坏）；§9-2 只要求"旧组件不删 + 改一个常量能回去"，两条仍成立。
2. **`detail-links` 一次拉全（含失效）再按状态分开渲染**，而不是传 `status='confirmed'` —— 失效那几条也要能"说出来"，且只花一次 IPC。

**变异复核（5 条，全部确认变红后复原，`grep MUTANT` 源码零残留）**

| # | 变异 | 结果 |
| --- | --- | --- |
| ① | 数据层去掉 `product_id` 条件 | `product:sku:smoke` 红 1 条 |
| ② | 数据层去掉 `status` 条件 | 红 2 条 |
| ③ | 界面反查**不带** `productId` | `goods:ui` 红 3 条（列出全库 4 条 / 载荷没带 / 失效混入） |
| ④ | 界面把**失效的也算作已关联** | `goods:ui` 红 1 条 |
| ⑤ | 界面行展开**不渲染 SKU 子表** | `goods:ui` 红 2 条（子表 + 克重读数 `v0=null`） |

顺带把两条**会"超时/抛错中断"的断言**改成可读 FAIL（条数不对时报 FAIL 而不是让整段冒烟挂死；克重读数改空安全）——
变异实测发现：中断会把后面几十条断言一起吞掉，读日志的人只看到 `timeout`，看不出是"多了"还是"少了"。

⚠️ 本轮另踩到一条工具坑并已入硬约束表：**`electron <script>` 在"加载期"报错时照样退 0**
（语法错走 `App threw an error during load`，末尾那句 `process.exit(1)` 根本执行不到）——
跑 electron 冒烟前先 `node --check`，且**别只看退出码**，要同时确认输出里有 `✅ 全部通过`。

### Changed · 「货与成本」重构 **S0**：起一个左右分栏工作台的外壳 + 一行回退开关（2026-10-08 续三）

`docs/plans/GOODS_WORKBENCH_PLAN.md` 的 S0 阶段：把「产品」与「商品池」放进**同一屏的两栏**。
这一版**只搭壳**，两个栏各自挂的还是现有组件（`ProductListView` / `SkuMappingView`），功能一件没增没减。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | **新增**：两栏外壳（`data-act="goods-workbench"` / `pane-products` / `pane-pool`）；只做布局与事件转接，不取数 |
| `src/modules/goods/GoodsView.vue` | 新增常量 `GOODS_LAYOUT: 'workbench' \| 'tabs'`（默认 `workbench`）；`'tabs'` 分支保留**与重构前逐字一致**的 DOM ⇒ **回退 = 改这一个常量**（同 `SHOP_PRODUCTS_TAB_ENABLED` 先例） |
| `scripts/goods-ui-smoke.mjs` | +4 项：两栏锚点都在 · 左栏真装了产品表 · **池栏首屏未激活** · 切到映射视图后两栏**同屏可见** |

**与方案 S0 原文的两处偏差（按代码现实回改，不是偷工）**：

1. **右栏是懒挂载的**（`pool` 属性为真才挂 `SkuMappingView`），不是常挂。原因是实跑才发现：
   `SkuMappingView` 一挂载就会扫队列并回报待关联数，于是 `flow.ts` 三态里的
   **`mappedQueue === null`（未知）这一态在界面上永远不再出现**，引导条会从「已配 4 条」
   改口成报一个它此刻并不真的知道的待办数。变异②（改成常挂载）实测同时打红两条断言
   （`queueCalls=1` + 引导条改口）—— 这个"顺手"的写法确实会静默吃掉一条既有契约。
2. **页签仍是 3 个**（合并到 2 个留在 S4）：因此两栏只在「映射与关联」页签下同屏；
   「产品」页签仍是整宽单栏（与现状逐字一致）。

**变异复核**（三条都确认能变红，之后复原，`grep MUTANT` 源码零残留）

| 变异 | 结果 |
| --- | --- |
| 去掉池栏容器（`data-act="pane-pool"`） | ✅ 2 条 FAIL（外壳锚点缺失 + `两栏同屏 R=false`） |
| 池栏改**常挂载**（去掉 `v-if="pool"`） | ✅ 2 条 FAIL（`queueCalls=1` + 引导条改口成「2 个商品ID 没认到款」） |
| 池栏恒不可见（`is-idle` 恒真） | ✅ 1 条 FAIL（`两栏同屏 L=true R=false` ⇒ 该断言判的是**可见性**，不是存在） |

⚠️ 窄窗口（< 1180px）两栏改上下堆叠的 CSS 已写，但**视口宽度守卫推迟到 S2/S4**（本轮未测）。

### Added · 认款时**顺手把订单图采纳为款主图**：给"款侧一张图都没有"补上起点（2026-10-08 续二）

接上一条：队列已经能**看见**订单图，但**款侧一张主图都没有**（真库只读：`pl_products` 27 个款、
`image_id` 非空 = **0**，`pl_images` **0 行**）⇒ "图对图认款"只有一半。这一版补上另一半的**起点**：
**认款（写映射）那一刻，若该款还没有主图，就把这个商品在订单里的那张图采纳为款主图** ——
形成正循环：认一次款 → 款就有一张图 → 下次这个款在候选列表里就有图可比 → 更好认款。

| 位置 | 动作 |
| --- | --- |
| `electron/product-db.ts` | 新增 `pendingProductImages(pairs)`：只**挑**（回"该把哪张图给哪个款"），**不碰文件** |
| `electron/product-handlers.ts` | 新增 `adoptOrderImages()`：认款后落库（复用 `importImageFile` + `attachProductImage`，与 `product-image-attach` **同一套实现**）；`importImageFile` 增 `source` 形参 |
| `electron/product-db.ts` / `src/types.ts` / `src/core/services/ipc.ts` / `src/modules/goods/api.ts` | `SkuMapOutcome` / `productSkuMap` 回执新增 **`adopted`**（采纳张数） |
| `src/modules/goods/components/SkuMappingView.vue` | 认款回执尾部报出"并把 N 张订单图设为款主图"（**为 0 时不提**） |
| `scripts/product-sku-smoke.cjs` | +6 项：只补空 · 取图池首选（最新一张，不是最早）· 同款只挑一张且**不随入参顺序漂** · 商品ID 归一 · 挑不到就回空 · 覆盖图优先 |
| `scripts/preload-ipc-shape-smoke.cjs` | +6 项（第七节）：`adopted=1` · **`image_id` 真写进库**（不是只在返回值里数了个数）· `pl_images` 真登记且落 `product-images/` · 复制的是**同一份内容** · 再认一次 `adopted=0` 且 `image_id` 一字节不动 |
| `scripts/goods-ui-smoke.mjs` | +2 项：`adopted=2` 时回执报出 · `adopted=0` 时**一个字都不多说** |

**三条规则都是「不做多余的事」**：① **只补空**（`pl_products.image_id = 0` 才采纳 —— 主图是人的决定，
程序不该悄悄换掉它）② **取与界面同一张**（覆盖图 → 订单识别图，和队列里显示给用户的是同一张）
③ **确定性**（同款被多个商品ID 映射时取 `productId` 升序 + `itemKey` 升序的第一个，不随 Map / SQL
返回顺序漂）。落库**失败不外抛**：单张失败只让这个款留空图，下次认款再试，绝不影响"映射已写入"这个事实。

**变异复核**（用例全绿 ≠ 守卫有效；八条都确认能变红，之后复原，`grep MUTANT` 源码零残留）

| 变异 | 结果 |
| --- | --- |
| 去掉「只补空」判断 | ✅ 数据层「款已有主图还被挑出来」FAIL |
| 去掉覆盖图优先 | ✅ 数据层「与界面同口径」FAIL |
| 去掉确定性排序 | ✅ 数据层「不随入参顺序漂」FAIL |
| 不归一（`toSkuKey` → `trim`） | ✅ 数据层「商品ID 先归一」FAIL |
| 取最早那张（`order[0]` → 末位） | ✅ 数据层「取图池首选（最新一张）」FAIL |
| 不调 `attachProductImage`（只数不写） | ✅ 端到端 4 条 FAIL（`image_id=0`） |
| 界面 `adopted` 恒显示 | ✅ UI「adopted=0 时不提」FAIL |
| 界面 `adopted` 恒不显示 | ✅ UI「认款回执报出采纳了几张」FAIL |

守卫三层一段都省不掉：**数据层**（挑哪个款/哪张图，不进主进程）· **端到端**（真落盘 + 真写 `image_id`；
⚠️ 界面假桥替的是 **preload 上面那一层**，`payload → items` 的包装在 preload，它测不到）· **界面**（回执怎么说）。

### Added · 待关联队列显示**订单图**：认款从"对着商品ID 猜"变成"看着图选"（2026-10-08 续）

用户问："导入订单时有 产品图片链接 / 产品ID / 店铺名，能不能自动添加到货与成本？"

**答**：三个字段里**两个早已自动** —— 产品ID 走 `oi_orders.raw_fields` 保真 + 队列的商品ID 列名族
（`shopSku.ts` 的 `ITEM_ID_KEYS` 本来就含「产品ID」）；店铺名走 `sk_name_map` 归一。
第三个（图片）**图也早就自动下载入库了**（真库只读实测：9 行订单 `image_id` 全非空、
`oi_images` 9 行、本地文件都在），**但只有「已配映射」那一半显示它，「待关联队列」那一半不显示**。
这一版补上这一半 —— 图不来自任何新导入，就是订单里那张。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/components/SkuMappingView.vue` | 队列表格加**「图」列**（与已配映射表同位、同形态）；`loadQueueThumbs()` 复用现成的 `pickFirst` + `itemImagePool`（**三层回落**：覆盖图 → 订单识别图 → 款主图）；**点缩略图看原图**（弹层先用缩略图顶上，再换原图） |
| `electron/shopSku.ts` | `QueueGroup` / `QueueRow` 增加 **`itemKey`**（归一后的商品ID），`buildQueueView` 透传 |
| `src/modules/goods/api.ts` | 新增 `readImage()`：读**原图**不缩放（缩略图通道的 `maxEdge` 在主进程被夹到 256，认印花/领型不够） |
| `src/core/services/ipc.ts` | 补 `orderReadImage` 的**渲染层包装**（此前只有 `ElectronApi` 上的声明、没有导出函数 —— 与 `orderImageThumbBatch` 同款缺口） |
| `tests/shopSku.spec.ts` | +2 条：`itemKey` 是归一键（`itemId` 保留订单原文）· `itemKey` 一路透传到队列行 |
| `scripts/goods-ui-smoke.mjs` | `report(` **63 → 71 项**（+8）：有「图」列 · **订单原文带空格的那一行照样有图** · 缩略图真的装了图（不是空 src 占位）· 图注标出来源 · 无图行是空占位不是破图 · 点开弹层里是**原图** · 关闭后弹层真消失 · 缩略图合批取 |

**`itemKey` 为什么必须单独加一个字段**：图池 `itemImagePool()` 的键是**归一后**的商品ID，
而队列的 `itemId` 是**订单原文**（`extractSkuFields` 直出，可能带空格）。已配映射那半能用 `itemId`
查图，是因为 `pl_shop_sku.item_id` **本来就归一存储**；队列不是。拿原文去查池的症状是**整列的图
全变成空占位且不报错**，看起来像"订单里本来就没有图"。故归一键在 `aggregateQueue` 里算好后一路带出
（**零复制**——不在前端再实现一份归一规则，两份必然漂移）。

**修掉一个假守卫**：`goods-ui-smoke.mjs` 的假桥替换的是 **preload 那一层**，所以入参形状 =
渲染层传给 preload 的形状 —— 而 `ipc.ts` 的拆批函数传的是**数组**（`payload → items` 的包装发生在
preload，被假桥绕过了）。旧假桥只认 `{ items }` ⇒ 恒返回空数组 ⇒ **"图列真的能显示图"从来没被验证过**
（映射列表那半的图同样一直没覆盖）。新假桥兼容两种形状，且这条进了变异复核。

**一个必须说清的事实（认款不可能自动）**：订单里的产品ID 是 16 位平台数字（如 `1005012742360018`），
自有款编码是 `STYLE-002`，**两者之间没有任何可推导的对应**，订单里也没有别的字段能推出"这是哪一款"
⇒ 认款只能人工。而**款侧现在一张主图都没有**（`pl_products` 27 个款、`image_id` 非空 = **0**，
`pl_images` **0 行**）⇒ "图对图认款"目前只有一半：订单那半有图可看，款那半只能看名字。
故这一版先解决"看得见订单里那件长什么样"。

**变异复核**（用例全绿 ≠ 守卫有效；五条都确认能变红，之后复原，`grep MUTANT` 零残留）

| 变异 | 结果 |
| --- | --- |
| 队列查图用 `itemId`（订单原文）而不是 `itemKey` | ✅ 4 条 FAIL |
| `aggregateQueue` 的 `itemKey` 记成订单原文 | ✅ 单测 2 failed |
| 不调 `loadQueueThumbs()`（队列根本不取图） | ✅ 4 条 FAIL |
| 点开不取原图（停在缩略图上） | ✅ 卡在 `queue-viewer` |
| 假桥改回只认 `{ items }`（复现旧假桥） | ✅ 3 条 FAIL |

门禁：`build` · `tsc electron` · `vue-tsc` · `verify` · `verify:docs` · `vitest`（**594 passed**）· `goods:ui`（**ALL PASS**）。

### Changed · 「货与成本」补起点引导，并收起「商品清单」页签（2026-10-08）

用户实报："不知道该从哪里开始，也不知道应该做什么"。根因不是功能少，而是**这一页按数据结构组织**：
产品 / 商品清单 / 映射与关联 / 供应商 四个**并列**页签，"我该从哪开始"在界面上没有任何答案 ——
而同一仓的「今天」页早有流程卡（`flow` / `flowNow`），那套语言没有被第二页复用。
真实只有两条链：**① 立款**（供应商 → 产品 → SKU 克重）· **② 认货**（订单 → 待关联队列 → 映射）。

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/flow.ts`（新） | `buildGoodsFlow()` —— 三步进度的**纯函数**。判据照搬「今天」流程卡的**串联语义**（前一步没完成，后面一律 `todo` + "等第 N 步"），使"当前步"**至多一个** |
| `src/modules/goods/GoodsView.vue` | 页头下加**起点引导条**（三步徽标 + 一句带数字的理由 + 一个真能过去的按钮）；`SHOP_PRODUCTS_TAB_ENABLED = false` 收起「商品清单」；`stats.mappedQueue` 由 `0` 改 `number \| null`（`null` = 还没取到，**不是 0**） |
| `src/modules/goods/components/SkuMappingView.vue` | 队列空态补「去「今天」导入订单」按钮（同文件下面那个空态早有下一步按钮，这里补齐同一形态）；顺带删掉文案里误写的 markdown 星号（`.wb-empty__desc` 是纯文本，界面上原样显示成 `**实时**`） |
| `src/modules/shop-accounts/components/SupplierView.vue`（2026-10-14 随「基础数据」整合从货与成本模块迁入，原在 goods 组件目录下） | 工具栏那句内部迁移史（"自「订单归类 → 拿货对账」迁移而来"）改成用户视角的一句话 |
| `tests/goodsFlow.spec.ts`（新） | 9 条：串联语义 / **排他性** / `null` ≠ 0 / "配过 ≠ 没有待办" / 脏值归零 / 按钮带筛选意图 |
| `scripts/goods-ui-smoke.mjs` | `report(` **53 → 63 项**（新增 10 条，删掉 2 条旧的「商品清单」断言）：引导条三步与当前步 · 「下一步」**带上筛选真的把列表筛窄**（结果断言）· 补完克重后当前步自己往前走 · **队列未取到时说"已配 N 条"、拉过之后才改口"队列是空的"** · 空态真入口 · **反向守卫：页签里不再有「商品清单」** |

**两条刻意的取舍**：

1. **「商品清单」只收界面，数据一行不删**（`ShopProductView.vue`、6 个 `shop-product-*` 通道、
   `shop-product-db.ts`、存量池行全留；恢复 = 把常量改成 `true`）。收起判据是**"有没有下游消费者"**
   （同 2026-10-01 删 `DB_OPS` 域的判据）：它写的池行（`source='shop-import'` / `shop_id=0`）
   全仓**只有 `shop-product-db.ts` 自己读**，订单归款走的是补集谓词 `skuMappingSql()` ⇒ 用户在这个
   页签做的事**不影响任何其它页面**。而"导入后回看到底进来了哪些数据"这个真实需求，由
   「映射与关联」的待关联队列（从订单实时聚出）与「今天」页的导入回执覆盖了。
2. **`mappedQueue` 的三态必须分开**：`0`（真没有待办）/ 数字 / `null`（还没取到）。外壳首屏停在
   「产品」页签时队列根本没被拉过；把 `null` 当 0，引导条会说出"都认完了"——那是它**不知道**的结论，
   代价是用户不再去配映射。故第 3 步另外吃一个**确定取得到**的 `mapped`（`skuSummary().total`）。

**变异复核**（用例全绿 ≠ 守卫有效，四条都确认能变红，之后复原）

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| `flow.ts` 把 `null` 当 0 | 「队列没取到时不能说队列是空的」 | ✅ 1 failed |
| 去掉串联语义（`wait1` 恒空） | 空库用例 + 排他性 + 脏值 | ✅ 3 failed |
| `SHOP_PRODUCTS_TAB_ENABLED = true` | 「三个页签」+「商品清单已收起」 | ✅ 2 FAIL |
| `goStep` 只切页签、不传 `intent` | 「点下一步把列表筛窄」 | ✅ `FAILED at [guide-go-filter] - timeout` |

结论与取证见 [`docs/notes/2026-10-30-goods-list-and-pool.md`](docs/notes/2026-10-30-goods-list-and-pool.md)。

### Added · 核对页指标条补**产品维度**：让"配映射"的收益在界面上显形（2026-10-05 深夜续四）

上一轮的核查结论是：**"按产品统计拿货"在数据层早就通了，唯一缺的是"配映射"这一步**
（真库 9 单全有 `产品ID`、6 店全归一，`pl_shop_sku` 却 0 行）。但配映射的收益**在界面上看不见** ——
于是给「今天 › 归类核对」的指标条补一格：

```
待核对 9 | 未归类 9 | 识别库 0 款 | 本页 9 个商品 | 已配产品 0 个 · 供应商 0 家（本页商品还没配映射）
```

| 位置 | 动作 |
| --- | --- |
| `electron/product-db.ts` | 新增 `resolveOrderSkuRollup(rows)`：一批（**店铺原文** + 商品ID）→ 已配到的**去重产品数 / 去重供应商数**。**复用**现成的两段规则而不是新写一套匹配：店铺原文 → 实体走 `resolveShopRef`、(平台,店铺,商品ID) → 产品走 `resolveSkuBatch`（一次算完一批）。`productLabelMap()` 顺带带出 `supplier_id` |
| `electron/order-handlers.ts` / `electron/preload.ts` / `src/types.ts` / `src/core/services/ipc.ts` | 新通道 `order-sku-rollup`（通道名四处同步；渲染层传**裸数组**，包装成 `{rows}` 在 preload 里） |
| `src/modules/today/classify.ts` / `ClassifyPanel.vue` | `skuRollup()` + 指标格 `cl-metric-product`。渲染层**刻意不自己推**商品属于哪个产品 |
| `scripts/product-sku-smoke.cjs` | +6 项（口径：去重 / 未归一 / **悬空产品** / 供应商去重 / **池行不算** / 订单原文两种写法归一） |
| `scripts/preload-ipc-shape-smoke.cjs` | +3 项：`裸数组 → {rows}` 的包装真的过到主进程（**假桥在 preload 上面那一层，这条界面冒烟根本看不见**） |
| `scripts/today-ui-smoke.mjs` | +4 项（135 → 139）：请求只带**有商品ID** 的行 · 格子画的是宿主回来的数 · `0 个已配` 带说明 · 取不到时**整格不显示** |

**三条刻意的取舍**：

1. **与归款同口径**：只认 `status='confirmed'` 的**映射行**（`skuMappingSql()`），**不认跨店池行**
   （`source='shop-import'` / `shop_id=0`）。两处不一致的症状是"核对页说这一页配了 3 个产品、
   真去拿货只有 2 个"。悬空产品（映射指向已删产品）按未命中，`supplier_id = 0`（未关联厂家）**不计家数**。
2. **`0 个已配` 与 `没取到` 必须长得不一样**：前者是**待办**（显示 0 并说明"本页商品还没配映射"），
   后者渲染层用 `null` 表达 ⇒ **整格不显示**。合并两者会把"没取到"说成"一件都没配"，
   而这两件事的下一步动作完全不同。产品维度是**附加信息**，取数失败不拦页面。
3. **一处口径只写一遍**：归一/匹配复用 `resolveShopRef` + `resolveSkuBatch`，本函数只做
   "去重 + 计数 + 两条与 `resolveOrderSku` 对齐的跳过规则"。在渲染层再写一份的下场是
   "队列说这家店已归一、核对页却统计不出来"，且两边分别看都正常。

**变异 7 组**（逐组确认变红后复原）：preload 键名写歪（`ipc:shape:smoke` 红，症状是
`success=true` 而 `products=0`）· `supplier_id = 0` 算一家 · 悬空产品算命中 ·
去掉"未归一店铺跳过"（**池行夹具让这条可判别**）· 渲染层不过滤空商品ID · 去掉"还没配映射"的说明 ·
取数失败时归零。见 `docs/notes/2026-10-30-order-import-pipeline.md` §八。

### Fixed · 「品类 / 颜色」的口径收成一份；核对页能**选**而不是各写各的（2026-10-05 深夜续二）

上一轮盘点出的四个缺口里，②③（颜色口径两头打架 / 品类白名单未命中静默保留原词）在本轮治掉。
先摆一个**前提**，免得把收益记错账：**这两条改的是 L2（模型）的归一口径，而 L2 今天仍无入口**
（「识别未归类」批量按钮已删，`recognizeOrder` 无调用方）⇒ 修的是"等 L2 回来时它是对的"，
**不是**今天的收益。今天真实的收益来自同一轮里给核对页加的**输入建议词表**。

| 位置 | 动作 |
| --- | --- |
| `src/lib/orderClassifier.ts` | 新增 `COLOR_WHITELIST`（**由同义字典的值域派生**，杜绝"字典能归一成 A、词表里没有 A"的漂移）；`normalizeColor` 从"整串字典精确匹配"升级为 **字典 → 词表 → 描述式解析 → 原样保留**（按 `+ / 、 底 配 带 和 与` 分段，逐段"整段精确 + 最长前缀回退"，取**第一个**认得出的段＝底色） |
| `src/core/ai/visionPrompt.ts` | **新增（提示词搬家）**：`VISION_PROMPT` 从 `openaiCompatible.ts` 移到这里，`color` 字段改为**注入** `COLOR_WHITELIST`，并定死多色写法「底色+花色、底色在前」——与上面的解析规则成对 |
| `ClassifyPanel.vue` | 品类 / 颜色输入挂 `datalist` 建议 = **标准词表 + 本库已用过的写法**（仍允许自由输入，**不替用户改写**）；品类建议排除「其他」（`EMPTY_LIKE` 空值语义，选了会被归一成空串） |
| `src/modules/today/classify.ts` | `pendingCounts()` 顺带返回 `usedCategories` / `usedColors` —— 复用**已经要发的那次** `limit: 2000` 查询，零额外往返 |
| `tests/visionPrompt.spec.ts` | **新增**：品类/颜色两处枚举都是**注入**的（不是各抄一份）+ 自证非空转 + 多色写法与解析规则成对 |
| `tests/orderClassifier.spec.ts` | 新增 13 例：描述式各分支（`底` / `+` / `、` / 斜杠 / 前缀回退 / **不扫任意位置** / 认不出原样保留）+ 词表自洽 |
| `scripts/today-ui-smoke.mjs` | 新增 4 项（131 → 135）：建议真的挂上（`list` 指向的 datalist 存在且选项非空）· 既有词表也有库内写法 · 不推荐「其他」· 颜色同理 |

**三条刻意的取舍**：

1. **提示词必须住在纯模块里**（`visionPrompt.ts` 只依赖 `@/lib/orderClassifier`）。它原先所在的
   `openaiCompatible.ts` import `@/core/network/request`，而 `src/core/services/ipc.ts`
   **顶层就求值 `window.electronAPI`** ⇒ node 环境的 vitest 一 import 就抛，"枚举同源"这条不变量
   只能退化成"扫源码文本"（模式写歪就恒绿）。**别挪回去。**
2. **不做"任意位置"扫描**：`灰蓝色` 按"主色在前"判成 `灰色`，不是 `蓝色`。扫任意位置等于全靠猜；
   **认不出仍原样保留** —— 颜色是款色（SKU 级）的维度，**错并**（两色合一色）比**拆**更难发现。
3. **不替用户改判**：品类/颜色框给建议但**不改写**用户输入。品类是指纹的第一段、颜色是款色维度，
   "静默改写"比"写得不一致"更难查。收敛摆在明面上让他选；词表覆盖不到的现实品类（帽子/汉服）
   靠"库内已用过的写法"这一半自己收敛。

> **⚠️ 变异 4 组，逐条确认对应断言变红后复原**（`grep -rn MUTANT` 无残留）：
> 提示词颜色枚举换成字面量（`visionPrompt.spec` 红）· 摘掉前缀回退（描述式用例红）·
> 建议只留词表、去掉库内写法（"帽子"那条红）· `list` 属性写歪（"datalist 存在"那条红，
> **而颜色那条仍绿** —— 证明两条断言各自独立，不是一条恒真的合并断言）。

### Added · 归类核对页的**界面省力**：「同商品」徽标 + 行内回车往下走（2026-10-05 深夜）

回流让"同一件商品不必反复判断"，但它没解决**界面上看不出来**这件事 —— 一页 30 行里哪几行是
同一个商品、定完这一条会不会顺带把别的也解决，原来只能靠用户自己记。这一轮把这两件补上，
**纯界面层：一行都没碰识别链路**（顺序仍是 映射 → 指纹 → 模型）。

| 位置 | 动作 |
| --- | --- |
| `electron/order-db.ts` | `listOrdersPage` 补上 `o.raw_fields`（**这是个静默陷阱**：类型上写着"原始整行"，之前恒回 `{}`）；`mapOrderRow` 用 `extractSkuFields` 推出 `itemId` —— 与回流写映射**同一个函数**，刻意**不让渲染层自己正则匹配**（两处各写一套列名族 ⇒ "徽标说同商品、回流按另一个键记"） |
| `ClassifyPanel.vue` | 行上「同商品 ×N」（同店同商品ID 的组，N>1 才出现）；指标条多一格「本页 N 个商品」= **真正要做多少决定**的量；行内 `Enter` ＝ 保存这一行并把焦点交给**顶上来的**那一条 |
| `src/types.ts` / `electron/order-db.ts` | `OrderRecord.itemId`（两份声明逐字对应，注释里写明"改一处必须改两处"） |
| `scripts/order-db-smoke.cjs` | 新增 1 项（22 → 23）：列表回带 `itemId` 与原始整行；夹具放「商品名称」作**干扰项**，确认没抓到名字相近的列 |
| `scripts/today-ui-smoke.mjs` | 新增 5 项（126 → 131）：徽标正/反各一条、回车保存、焦点往下走一条、以及前置自证 |

**两处刻意的设计（都写进了代码注释）**：

1. **徽标的分组键是「店铺原文 + 商品ID」**，而回流用的是**归一后的店铺实体** ⇒ 同一家店写法不同
   （多一个空格 / 全角括号）时徽标会**少算**。刻意不修：要修就得把店铺归一下沉到渲染层，
   必与 `sk_name_map` 分叉。徽标是**提示**不是承诺 —— 少算只会让人多核对一次，不会把两件商品混成一件。
2. **键盘流钉在"行下标"而不是订单 id**：保存会把该单置为已核对（`updateOrder` 里 `corrected = 1`），
   它随即离开待核对列表、后面的行上移一位 ⇒ "下一条"在取数之后**正好落在同一下标**上。
   钉在 id 上会找不到元素，症状是"焦点丢了"，很难查。

> **⚠️ 本轮两个"看着绿其实绿得没道理"的地方，都已经用变异确认过**：
> ① 徽标夹具**三种情况各占一行**（同商品 / 商品只此一行 / 没有商品ID）——
> 只放前两种，"凡有商品ID 就标"这种错法照样全绿；只放后一种，"徽标恒显示"照样全绿。
> ② 焦点断言**必须先把夹具对齐宿主的"已核对即离表"**（本轮为此给假桥加了 `__emulateCorrected`，
> **默认关** —— 本页前半段的断言要反复操作同一行）。不对齐时列表不缩水，焦点"回到第 N 行"永远成立，
> 分不出"往下走了一格"与"原地没动"；对齐后把 `focusRowIdx` 写成 `idx + 1` 当场变红。
> 另：主进程侧的口径只能由 `order:smoke` 守 —— 假桥里的 `itemId` 是**夹具给的**，
> 宿主忘了带 `raw_fields` 时 `today:ui` 照样全绿。

### Added · ⭐ 人工核对的**回流**：点名某个款 → 记住「这个商品 → 款 + 色」（2026-10-05 深夜）

**用户诉求（原话）**：「你觉得怎么做才能更方便归类或者识别自动识别品类、颜色和logo」。
先盘点了三层链路（映射 → 指纹 → 模型），结论是**前两层早就建好了，缺的不是模型，是人在核对页
做的判断没回流到确定性层**：核对页写的是**指纹 → 款**，而指纹只覆盖"图长得一样"的单，
**商品ID** 才覆盖"同一件商品的每一单"。不回流的样子是——某个商品被人工判对 10 次，
第 11 条订单**照样进待核对队列**（人工工作量不随时间递减）；而真实库上 42 行订单的商品ID
**去重后只有 17 个**，十几条映射就能覆盖绝大多数行。链路盘点见
`docs/notes/2026-10-30-order-import-pipeline.md`。

| 位置 | 动作 |
| --- | --- |
| `electron/order-db.ts` | 新增 `skuBackfillFromOrder()`：把「(店铺, 商品ID) → 款 + 色」写进 `pl_shop_sku`（`confirmed`），并在**事务外**接进 `assignOrderStyle`——回流失败绝不影响"归属已改"这个已提交的事实 |
| `electron/product-db.ts` | 新暴露 `resolveShopRef()`（店铺原文 → 店铺 id + 平台，与 `resolveOrderSku` **同一套规则**）与 `productIdByCode()`（两域唯一锚点 `pl_products.code`） |
| `classify.ts` / `ClassifyPanel.vue` | 回执随 `order-style-assign` 回来（`skuBackfill`），保存提示把"记住了"**说出来**（含"同一商品另有 N 单一起归好了"），并在没记住时指到**真实入口** |
| `scripts/product-sku-smoke.cjs` | 新增 **8 项**回流用例（23 → 31 项），逐条做变异确认会变红 |
| `scripts/today-ui-smoke.mjs` | 新增 **3 项**断言（123 → 126 项），含一条**反向**断言"没点名款的那次保存不许谎称已记住" |

**三条边界**（写进了代码注释与 `docs/features/PRODUCT_LIBRARY.md` §3.5.1，防止下次"顺手放宽"）：

1. **只写、不覆盖** —— 该商品已有别的产品的映射时只回报 `conflict`、一行不动。
   在这里顺手改绑等于让那个商品**所有**（含历史）订单一起改判，而用户此刻只看了眼前这一单。
2. **颜色只填不猜** —— 颜色为空 / 是兜底占位（`未分类`）时只记到**款级**（`spec='*'`），
   不把"还没定"固化成该商品的颜色。
3. **失败不外抛** —— 顺手记住是**附加**动作，不能把"归属已改"报成失败。

**没覆盖到的**（免得被当成已解决）：只改品类/颜色那次（`targetStyleId === 0`）与 `确认无误` 都**不**触发回流
—— 前者结论属于指纹层，后者是"这条没问题"，「全部确认无误」还会把它变成批量落库（正是本次一起删掉的批量动作的风险形态）。

> **⚠️ 本轮踩到并修掉的一个假绿**：界面断言"提示里没有那句话"**不能**在"通道被调用"的那一刻取 DOM ——
> 假桥是在 invoke 的**同步**阶段记录调用的，而 toast 要等 `await` 回来才 push、再等 Vue 渲染才进 DOM。
> 那一刻取 DOM 只能得到"还没有提示"，于是**反向**断言在"提示还没渲染"与"提示里没有那句话"之间恒绿；
> 把提示故意改成恒显示那句，它照样全绿。改成"先等这次保存的提示渲染出来，再断言里面没有那句话"后，
> **同一个变异立刻把断言打红**。取提示一律 `querySelectorAll` 逐个看，不能取第一条（同屏能并排几十条旧提示）。

### Removed · 「归类核对」删掉「识别未归类」批量按钮（2026-10-05 深夜）

**用户诉求（原话）**：「归类核对中的识别未归类功能删除掉」。删的是**批量动作**，不是识别能力本身
—— 识别引擎配置（「设置 › 识别」）与识别原语都还在，等形态拍板后重新接入。

| 位置 | 动作 |
| --- | --- |
| `ClassifyPanel.vue` | 删按钮 `cl-recognize` / `cl-stop` / 进度条 `cl-progress`，以及 `recognizeAll()`、`stop()` 与 `running/stopFlag/queue/done/progress/failed` 六个状态；工具条只剩「查询 / 刷新」 |
| `scripts/today-ui-smoke.mjs` | 删该链路的 3 条断言，**换成 2 条反向断言**（「不再有这个按钮」+「删完工具条仍能用」）；假桥里 `orderReadImage` / `orderImageSave` / `orderApiKeyGet` / `orderApiKeySet` 四个桩随之删除 |
| `RecognitionSettings.vue` | 文案不再指向「归类核对」页 —— 那一页已经没有这个动作了（**指向已删入口是真 bug**，`uxEntryNames` 守卫上次就抓到过同类） |

**删它的三条理由**（都写进了 `ClassifyPanel.vue` 的注释，避免下次又按"看起来有用"加回来）：
① **慢且绑住界面** —— 串行识图 20~60s/张，跑满一页十几分钟；
② **范围是"当前页"而不是"所有未归类"** —— 翻页要重跑，用户以为全跑了其实只跑了一页；
③ **直接落库**（reclassify + 写指纹 + 关联款色）—— 识别这种事更适合"先给建议、人看一眼再定"。

> **反向断言不是凑数**：删功能必须留一条"它不在了"的守卫，否则按钮被加回来时冒烟照样全绿、
> 也没人会想起它当初是被有意拿掉的。判据钉在 `data-act` 上（比文案稳），并在注释里写明
> **要加回来就改这条断言**。非空转的证明：紧邻的第二条 report 用**同一个** `card()` 取到了
> `cl-query` / `cl-reload` 两个真元素 ⇒ `!card(...)` 不可能是"查不到任何元素才恒绿"。

**保留但暂无调用方**：`readEngine` / `recognizeOrder`（`src/modules/today/classify.ts`）——
「设置 › 识别」写的引擎配置必须有个读取方，且它们正是重新接入识别时的现成件。
⚠️ 若最终决定不做自动识别，**这两个原语应与「设置 › 识别」页一并删除**。

**门禁（逐条单看退出码）**：`tsc` 0 · `vue-tsc` 0 · `verify` 0（IPC 契约一致，本轮零新增通道）·
`verify:docs` 0 · `build` 0 · `vitest` **34 files / 569 tests** · `today:ui` **123 PASS / 0 FAIL**
（断言数 124 → 123 = 删 3 增 2）。

### Added · 「今天」升级为**发货台**：六步收进一页多页签，点步骤不再跳页（2026-10-05）

**用户诉求（原话）**：「将每日发货流程中的每一步都挪到宿主中，可以在一个页面中的多个tab中，
避免点击后跳转到其他页面，丝滑操作」—— 拍板两项：**落在「今天」**（导航不增项）+ **六步全内建**。

**改了什么**（`src/modules/today/**` 为主，**零迁移、零新 IPC、零能力域、岛不发版**）：

- 「今天」页变成**页签容器**：`总览 | 1 导入订单 | 2 归类核对 | 3 生成拣货单 | 4 算钱 | 5 拿货 | 6 结算对账`。
  页签上带这一步"还有多少活"的徽标（`2 行` / `1 未识别` / `1 SKU` / `缺 4`），
  当前该做的那一步在页签上有主色标记 —— 不用点进去就知道下一步在哪。
- **点步骤 = 切页签，不再跳模块**。流程卡、三张卡、导入回执里的"下一步"全部改走 `go(tabId)`；
  只有「货与成本」（主数据维护，不属于这条流程的某一步）仍是真跳转。
- **懒挂载 + 保活**：`defineAsyncComponent` ⇒ 第一次点某页签才加载它的代码；
  `<KeepAlive>` ⇒ 切走不销毁，切回来界面原样（表单、已生成的清单都还在）。
- **`token` 把保活的代价还回去**：任何让数据变了的动作（导入/生成/提交）后 `bump()` ⇒
  `token` +1 ⇒ 各面板 `watch` 后重取。没有它，保活会让用户切回拣货页签时看到"导入之前"那份清单。
- 各步视图**复用整页视图**（`PickingView` / `OrderCostView` 加 `embedded` prop：只藏标题两行，
  保留动作按钮），**不复制精简版** —— 同一件事两处摆迟早两套口径（岛内「拣货」页签撤回的前例）。
- ~~拿货 / 结算对账 / 归类核对三个页签先给**诚实占位**~~ → **已全部内建**（见下方「六步全部内建」小节）。
  数据层其实已全在宿主（`purchase*` / `orderQueue*`），缺的只是界面。
- `SHIPPING_TAB_NAMES` 作为页签名的**唯一来源**（`flowCtx.ts`）：页签名是**新的一类入口名**，
  `tests/uxEntryNames.spec.ts`（悬空入口名守卫）新增这个来源，文案里写「去「归类核对」页签」
  必须能对上真东西（**进 `known`，不是进 `ALLOWED_NON_ENTRY` 豁免**）。

**顺带修掉的 2 个真问题**：

1. **内嵌时把整个页头藏掉 ⇒ 动作按钮一起消失**（拣货页的"生成待拣清单 / 导出带图 xlsx"、
   算钱页的"刷新 / 更多 / 未归属"都在 `header.wb-head` 里）⇒ 页签打开就是空态且没法操作。
   改成只藏标题（`wb-head__main`），动作区保留并左对齐当工具栏。**这是变异测试顺带抓到的**
   （见下条）。
2. **一条假守卫**：`today:ui` 里"导入后拣货单自动重算"原本按 `pickingRows` 的**调用总数**断言 ——
   但这个 IPC 有**两个调用方**（容器 `reload()` 用 `{limit:2000}` 要汇总数、拣货面板用
   `{shop, includeShipped}` 生成清单），容器的调用把总数喂饱了 ⇒ 变异（拿掉 `:refresh-token`）
   照样全绿。改成**按入参区分调用方**（拣货面板的入参没有 `limit`）后，变异立刻变红。

**验证**：`today:ui` **48 → 57 项**（新增：七页签齐全 / 默认落总览 / **懒加载**（没点过的面板不在 DOM）/
**切页签不派发 `switch-module`**（"不跳页"的判据）/ **保活 = 同一个 DOM 实例** /
空态导入一步直达并切到导入页签 / **导入后已生成的拣货单自动重算**）。
**5 组变异**逐组确认变红后复原（① 切页签退回 `switchModule` ② 去掉 `KeepAlive` ③ 断掉 `token` 传递
④ 改成全量挂载 ⑤ 删掉一个页签），`grep -rn MUTANT src/ scripts/ tests/ electron/` 无残留。
**深/浅主题 + 三个页签的真截图**看过（内嵌面板无双层页头、工具栏靠左、无内容被裁）。
门禁全 0：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `vitest` **633** / `build` /
6 个界面冒烟（含 `picking:ui` / `order-profit:ui` 独立打开不受影响）/ 11 个 DB+形状冒烟 /
`picking:xlsx:smoke` / `purchase:xlsx:smoke` / `plugins:island:smoke`。
详见 `docs/notes/2026-10-30-shipping-desk-and-rate.md`。

### Added · **六步全部内建**：归类核对 / 拿货 / 结算对账 三页签从「订单归类」岛收编（2026-10-05 晚）

**用户诉求（原话）**：「把归类核对和拿货对账都移到宿主中，归到今天菜单中，可以决断一下哪些是
在流程中有用的，去掉那些没用的功能」。

**新文件**（数据层全用宿主现成 IPC，**零新 IPC / 零迁移 / 零能力域 / 岛不发版**）：
`tabs/PurchasePanel.vue` + `tabs/PurchaseOrderEditor.vue`（第 5 步拿货：缺口勾选→草稿单 / 拿货单 /
明细编辑抽屉带实时重算与「取最近价」/ 忽略清单）、`tabs/ReconPanel.vue`（第 6 步结算对账：按厂家
四金额 + 付款记录增删 / 按店铺分摊 + 明细 / 时间窗五档）、`tabs/ClassifyPanel.vue`（第 2 步归类核对：
逐行核对 + 归属款下拉 / 批量识别未归类 / 单行与全部确认）、域薄封装 `purchase.ts` / `classify.ts`
（类型化 + 失败抛错 + 分/元与时间窗纯函数；**业务算法仍只在主进程**）；确认弹层从 `goods`
**上提为 `src/core/components/ConfirmDialog.vue`**（第二处消费者出现 ⇒ 按约定上提，不复制）。

**裁量（砍掉的岛功能）**：识别队列中间层（宿主导入直落订单表）· 行内改款式展示名（主数据归
「货与成本 › 产品」）· 识别库 / 透视 / 明细 / 设置四个非每日动作页（设置已在宿主「设置 → 识别」）·
对账页的「导出 Excel」（要新开 IPC 才能导对账汇总，屏幕看得见 ⇒ 不造按钮）· 对账页的厂家增删改
（主数据归「货与成本 › 供应商」）。**保留**付款的「退款」类型（真实业务：厂家退次品）。

**验证**：`today:ui` **57 → 124 项**全绿；**10 组变异**逐组确认变红后复原（漏指纹 / 摘掉无 Key 拦截 /
缩略图不滤空路径 / 付款不预选厂家 / 切窗不重取 / 摘掉空金额拦截 / 去掉 `!styleCode` / 去掉 `localPath` /
默认款靠位置），`grep -rn MUTANT` 无残留。两个夹具/断言教训：**假桥载荷形状以 `src/types.ts`
声明为准**（`orderImageThumbBatch` 渲染层传裸数组，归一成 `{items}` 是 preload 的事 —— 写错 ⇒
缩略图全空占位且不报错）；**验 `A && B` 过滤条件夹具要"各缺一样"**（第一版把"已归类"写成无图 ⇒
`!styleCode` 这个条件根本没被验到；且无图行在读图前就抛错 ⇒ 必须用**队列大小**这条后置可观测点验它）。
`vitest` **633** 全过（悬空名守卫抓到 2 个新引号名并按真实入口修：`设置 → 识别`、`全部`）；
门禁全 0（两侧 tsc / `verify` / `verify:docs` / build / 6 个 UI 冒烟 / 13 条 electron DB 冒烟）；
深浅主题真截图看过（`.workbuddy/artifacts/t-classify.png` / `t-recon.png` / `t-recon-dark.png`）；
顺手修掉 5 处 markdown 星号漏进用户可见文案。

### Removed · 「订单归类」UI 岛整体下架：六步全内建之后，连带删掉 37 op 的能力域（2026-10-05 晚）

**背景**：上一条把第 2/5/6 步（归类核对 / 拿货 / 结算对账）从岛收编进宿主「今天」发货台。
**六个步骤一旦全部内建，岛剩下的就只有「识别库 / 透视 / 明细」三个非每日动作的页** ——
用户据此拍板**整体下架**（放弃了"拆 `purchase` 只读子域 + 岛发版"那条过渡路线）。

**三处版本坐标一起清**（只删仓库源码 = 线上市场仍装得到、本机已装的还会跑）：

- **仓库**：`ui-plugins/order-insight/`。与上一例 `product-library` 不同的两点 ——
  该目录**是被 git 跟踪的**（19 个文件）⇒ 用 `git rm -rf`；其中 **8 个 `dist/` 文件带未提交改动**，
  `git rm` 因此报 `local modifications`，**必须 `-f`**。用 `-f` 的前提是留档 tar 打自**当前磁盘状态**。
  留档：`.workbuddy/retired/order-insight-2026-10-05/`（`repo-order-insight.tar.gz` **21 条** = 19 岛文件
  + 1 个冒烟脚本 + 1 个单测；另存 6 个历史 zip 与本机已装目录副本）。
- **市场**：删 `market-out/catalog.json` 里的 `order-insight 1.5.0` 条目并删 zip、commit（`4482d57`）、
  **push 完成**（`279ee07..4482d57 main -> main`）。线上复核：目录**只剩 4 条**
  （`shop-accounts` / `ae-profit` / `excel-copy` / `shipping-rate`）、`order-insight-1.5.0.zip` **HTTP 404**。
  ⚠️ 中途 `push` 多次失败（`Failed to connect to github.com:443` / `Operation too slow`），
  **网络恢复后重试即成功** —— 卡住时**别去改产物或 `--force`**，本地 `ahead 1` 就是唯一状态。
- **本机**：`~/Library/Application Support/seller-kit/plugins/order-insight/` 同步移除（18 个文件，
  副本已进留档目录）；装完需**重启宿主**才生效。现役岛 **4 个**。

**宿主侧**：

- `src/core/plugin/host.ts`：删 `'order-insight'` 能力域整块 **37 个 op**（当时仓库内最大的域：
  视觉指纹 / 订单明细读写 / 图片下载·读图·缩略图（单条与合批）/ 孤立图清理 / Excel 解析与导出 /
  视觉识别 `analyze` / 处理队列 `oi_queue` ×10 / 款式库 `oi_styles` ×6 / 订单维护 ×5），就地留**墓碑**
  （写明"数据层与 IPC 通道不动"）。⚠️ 判据同上一例：内建页**结构上够不到** `DB_OPS`；
  `npm run verify` 显示 **IPC 契约零改动** —— 这是"删的确实是权限面、不是通道"的可复核证据。
- ⚠️ **能力域 ≠ 存储命名空间**：`modules.order-insight`（引擎配置 + 列映射）是**已落盘的用户数据键**，
  由「设置 › 识别」写入、`today/classify.ts` 读取 ⇒ **名字刻意不改**（改名会让用户配好的 API Key 与
  列映射静默消失）。两处都补了注释说明"名字 ≠ 模块还在"。
- `tests/pluginTriage.spec.ts`：删该岛 **7 条**逆向守卫（等价守卫已在 `today:ui` 冒烟与 `purchase.ts` 的
  TS 类型里，后者是编译期、比扫字符串更强），`GRANDFATHERED` 去掉 `'order-insight': 37`；
  该组**自证**锚点 `expect(domains).toContain('order-insight')` 改钉 `'shop-accounts'`
  （锚点历史：`product` → `order-insight` → `shop-accounts`）。
- 其余清理：`tests/{pluginManifest,pluginSettingsIsland,uiBridgeHost,aggregator,colorSwatch,uxEntryNames}.spec.ts`、
  `scripts/{check-doc-links,shipping-rate-ui-smoke}.mjs`、`package.json`（删 `order-insight:settings:ui`）、
  `.gitignore`、`modules.config.json`、`externalManifest.ts` / `sanitizeExcel.ts` 的注释。

**守卫抓到一个真 bug（不是守卫过期）**：删完跑全量单测，`tests/uxEntryNames.spec.ts` 报
`文案让用户去一个不存在的入口 … src/core/settings/RecognitionSettings.vue:「订单归类」` ——
设置页**仍在把用户指向已下架的岛**。修法是**改产品文案**指向内建页（`「今天」的「归类核对」页签`），
**不是加豁免**。同一条守卫的**自证锚点**（`toContain('订单归类')`）正好落在被删的岛上，
改钉 `店铺账号管家` —— 两者处置相反：文案改产品、锚点改测试。

**文档**：`verify:docs` 一次报 **12 条**悬空引用，按"句子还成立 / 本就是历史记录"分流 ——
前者**改写**（`DAILY_SHIPPING_FLOW_PLAN.md` ×3、`2026-10-05-shipping-console-tabs.md`、
`2026-10-04-preload-payload-shape.md`、`DOMAIN_INTEGRATION_PLAN.md`、`PLUGIN_TRIAGE_PLAN.md`、baseline ~10 行），
后者进 `DELIBERATELY_MISSING` **并写明理由**（+4 条，49 → 53）。

**验证**：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `npm run verify` / `npm run verify:docs` /
`vitest`（**36 files · 615 tests**）全绿；六步内建的 124 项 `today:ui` 与其余 5 个 UI 冒烟、
13 条 electron DB 冒烟 ALL PASS。**本轮只改宿主，没有别的岛需要发版。**

**结论笔记**：[`docs/notes/2026-10-30-island-publish-and-retire.md`](docs/notes/2026-10-30-island-publish-and-retire.md)
**§6**（第二次实例：git 跟踪/未跟踪两种命运、`git rm -f` 与留档的关系、守卫抓到真 bug 的处置分叉、
文档悬空引用分流、以及"市场最容易留半截"）。

### Removed · 清掉下架遗留的孤儿代码：`aggregator` / `templateEngine` 两模块 + 两条单测（2026-10-05 深夜）

**为什么现在做**：上一条把岛下架了，但**渲染层里给岛用的纯函数没人回收**。
判据不是"看名字像不像没人用"，而是**可达性**：从渲染层入口（`src/main.ts` + `enabledModules` 各自的
`meta`/`index`）出发对 115 个 `src/` 文件做 import 图遍历，列出**入口到不了**的文件 —— 得 4 个。

**结果**：真孤儿 2 个（删），另 2 个**不是孤儿、不动**：

| 文件 | 判定 | 依据 |
|---|---|---|
| `aggregator.ts`（`src/lib/` 下）+ 其单测 | ✅ **删**（313 行） | 透视聚合引擎，原两个调用方 `PivotPanel.vue` 与岛的透视页**都已下线** ⇒ 只剩自己的单测引用它（30 个用例） |
| `templateEngine.ts`（`src/lib/` 下）+ 其单测 | ✅ **删**（37 行） | 唯一消费者是 excel-copy；它 2026-09-24 下记为岛后**岛自带同语义副本**（`ui-plugins/excel-copy/dist/util.js`），宿主这份已无人调用（16 个用例）。删除早经 `PLUGIN_TRIAGE_PLAN` §C 预授权 |
| `src/core/plugin/sandboxRuntime.ts` | ❌ **不动** | **扫描器假阳性**：以 `import runtimeSource from './sandboxRuntime.ts?raw'` 注入，**带查询串的 import 我的解析器接不住**；另有 `scripts/sandbox-smoke.mjs` 按路径读它 |
| `src/core/layout/SplitPane.vue` | ⏸ **保留待定** | 确无引用，但它是**基线期的通用布局原语**、不是下架产物；且 4 处文档快照（`REFACTOR_PLAN` / `CODE_REVIEW_REPORT`）正在说"它已落地"，删了要连带改那几句。**与本轮无关，单独再定** |

**留档**：`.workbuddy/retired/orphan-code-2026-10-05/`（4 个文件的当前磁盘态；`git rm -f` 是因为
`aggregator` 那条单测**带未提交改动** —— 与岛下架同一纪律：**用 `-f` 的前提是留档打自当前磁盘**）。

**文档同步**：`AGENTS.md` 两处（§4.4「底层公共工具」清单去掉 `templateEngine`；
§6.3 那条"类型标必填、运行时却有兜底"的**例子**随模块一起删、纪律保留）·
`PLUGIN_TRIAGE_PLAN` §C 标 ✅ 收口（并写明 `fieldProcessor` **保留** —— excel-copy 的 `applyRules`
仍在宿主 `db` 域复用它，别顺手一起删）· `REMEDIATION_PLAN` 的覆盖计划与验收条目就地标注作废 ·
`ui-plugins/excel-copy/dist/util.js` 的注释（原来写着"与宿主 `src/lib/templateEngine.ts#renderTemplate`
语义一致"，**宿主那份没了** ⇒ 改述为"本副本是当前唯一实现"）· `check-doc-links.mjs` 的示例路径换现存文件。

⚠️ **副作用（可接受、不发布）**：`excel-copy` 岛的 `dist/util.js` 只改了注释，因此仓库产物与市场上
已发布的 `1.0.0` zip 在**注释层面**不再逐字节相同。功能零改动 ⇒ **不升版本、不重发**；但下次真要
发布该岛时，`publish-plugin.js` 会因"同版本换内容"而拒绝，**那时按规矩升版本、别 `--force`**。

**验证**：`tsc` / `vue-tsc` / `npm run verify` / `npm run verify:docs` 全 0；
`vitest` **34 files · 569 tests**（原 36 · 615 —— 减的正是这 2 个文件 / 46 个用例，数字对得上）。



**为什么**：S3 把 exceljs「`addImage({filename})` 忘给 `extension`」那条真 bug 的修法抽进了
`electron/xlsx-image.ts`，并让 `purchase-handlers.ts` 改用它 —— 但**只测了那个共享函数**
（`picking:xlsx:smoke`），`purchase-export-excel` 这个**调用点**此前**零覆盖**
（`scripts/` 下没有任何脚本 require 过 `purchase-handlers`）。
"共享实现被覆盖 ≠ 调用点被覆盖"：行映射、金额口径、查图条件、落盘/取消分支，只有调用点能验。

**做法**（新增 `scripts/purchase-xlsx-smoke.cjs` + npm script `purchase:xlsx:smoke`，26 项）：
在**真 Electron**（require 链含 better-sqlite3，Electron ABI）里用 `Module._load` 替身把 `electron`
换成"只改 `ipcMain` / `dialog` / `BrowserWindow` / `app` 四件"的代理，于是能**截获真 handler**、
用假对话框喂路径、其余全真；只把 `order-db.findStyleColorImagePath` 换成可控映射（改同一 exports 对象的属性即可生效）。

**断言**：入参护栏（非对象 / `items` 非数组 → `invalid payload`；洗完没行 → `没有可导出的行`）·
**取消保存 → 输出目录里一个 `.xlsx` 都不多出来**（不是"写了再删"、也不是写到某个默认路径）·
`defaultName` 的 `\ / : * ? " < > |` 全换 `_` · 表名「拿货单」+ 9 列表头 ·
**单价 = `priceCents/100`、金额 = 数量 × 单价** · **`priceCents===0` → 单价/金额留空**（不是 0.00）·
**`qty===0` → 实拿数量/金额留空**（0 件 ≠ 尚未填数）· 款色为空的行照常导出（只是不查图）·
只填款名的行不丢 · **媒体扩展名跟着内容**（PNG 内容名 `.jpg` → `imageN.png`；base64 源恒 jpeg，
所以是 png 就证明走的是**文件源**分支）· 无 `imageN.undefined` · `[Content_Types].xml` 有 `image/png`
无 `undefined` · 有 drawing 部件 · 有图行设了行高 · **`items` 超 500 截前 500**（剪的是入参）。

**验证**：**7 组变异**逐组确认变红后复原（其中一组第一次**没打中守卫点** —— 变异打在
`sniffImageFormat` 的 `throw` 上，被外层 `try/catch` 吞掉了、冒烟照绿；改打在真守卫点后才红，
这条本身也是"变异补丁要打在真正的守卫点"的实例）；`grep -rn MUTANT` 无残留。
全量门禁：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `vitest` 633 / `build` /
11 个 DB+形状冒烟 / `picking:xlsx:smoke` 15 / `purchase:xlsx:smoke` 26 / 6 个 UI 冒烟 /
`plugins:island:smoke` 5/5 全 0；新增文件 eslint 0 error。

### Added · S3 拣货单升级：进价 / 预估金额 + 按厂家分组 + 带图 xlsx（2026-10-05）

**背景**：用户六步发货流程的第 3 步（「产品图片+颜色尺码数量**发厂家**拣货」）此前只能靠肉眼看图。
本阶段把这一页变成**可以直接发出去的拣货单**，并把「进价」钉在与「算钱」页**同一份实现**上 ——
两页各自取价会出现"同一条订单两张页上成本不一样"的悬案。

**变更（零迁移 / 一条新 IPC 通道 / 零能力域 / 岛不发版）**

| 事 | 落点 |
| --- | --- |
| 进价 / 预估金额 | `src/lib/picking.ts` 复用 `orderCost.pickUnitCost`（**款级**成本区间，按**该行的下单日期**取当时生效的那条）+ 同一份 `round2`（`orderCost.ts` 里改为 export） |
| 逐行取价 | `Σ(件数 × 单价)`，**不是** `件数合计 × 某一价` —— 同一 SKU 的订单可跨成本生效区间 |
| 缺价语义 | `unitPrice / amount === null` = "没查到价"；金额里**不含**这些件数，另累 `noPricePieces` 单独报出（写 0 会让"估算偏低"和"真的很便宜"长得一模一样） |
| 按厂家分组 | `PickingSummary.suppliers`（`groupBySupplier`）：有厂家的在前、件数降序、**未指定整组排最后**；分组内引用**同一个 `PickingGroup` 对象**，不复制 |
| 带图 xlsx | 新增 `electron/picking-xlsx.ts`（生成层，**不 import 任何 `*-db`**）+ 新通道 `picking-export-excel` + `src/lib/pickingExport.ts`（渲染层 canvas 编码图） |
| 图怎么进来的 | **渲染层编码成 JPEG 再传主进程**（见下方 bug ②），主进程只画表、不重算任何业务口径 |
| 界面 | 新增「进价 / 预估金额」两列 + 按厂家分段的 `tbody`；表格套 `.wb-table-wrap`（`.wb-panel{overflow:hidden}` 会**静默裁掉**右半截）；全无价时写 `—（N 件全部无进价）` 而不是 `¥0.00` |

**修 bug ①（影响面**不止**拣货单）：exceljs `addImage({ filename })` 不给 `extension` ⇒ 包结构不合法**

- 现象：`xl/media/image1.undefined`、`[Content_Types].xml` 里是 `<Default ContentType="image/undefined"/>`
  （连 `Extension` 属性都空掉）⇒ OPC 要求每个 part 都有内容类型 ⇒ Excel 提示"需要修复"并**丢图**。
- **在"导出成功"的返回值里看不出来**（导出照样返回 filePath）。
- 修：新增 `electron/xlsx-image.ts`，按**文件内容**（不是文件名 —— 存量图里有"内容是 PNG、名字是 `.jpg`"的）
  推扩展名并显式传给 `addImage`；`purchase-handlers.ts` 原先自己抄了一份 `imageSizeOf` + 同样的
  `addImage({filename})`，**改为共用同一实现** ⇒ 既有的**拿货单导出**一并修好。

**修 bug ②：Electron `nativeImage` 解不了 WebP**

- 实测 `createFromPath` / `createFromBuffer` 对 4 张真实订单图全部 `isEmpty()`；而**真实订单图 8/9 张
  内容是 WebP**（还有"内容是 webp、名字是 `.jpg`"的）⇒ 主进程既转不了码也拿不到宽高，
  嵌 webp 在旧版 Office/WPS 里显示不出来，与"发厂家"的用途直接冲突。
- 修：改由**渲染层**（Chromium 有 WebP 解码）canvas 统一转 JPEG（先铺白底，JPEG 无透明通道）再传；
  顺带省掉"主进程按渲染层给的路径读任意文件"。

**修 bug ③（跨脚本假绿隐患）：冒烟"失败"却以退出码 0 结束**

- `if (failed > 0) { console.log(...); process.exit(1); }` 之后再跟 `console.log('全部通过'); process.exit(0);`
  ⇒ 真 Electron 下**两次 log 都打印、退出码是 0**（同一个 `process.exit(1)` 在顶层同步代码里是正常终止的；
  `process.exitCode = 1` 在 Electron 下**不退出** —— 事件循环不空，实测挂住）。
- 修：纪律 + 落地 —— **同一段流程里只调一次 `process.exit`**，写成 `process.exit(failed > 0 ? 1 : 0)`；
  `scripts/picking-xlsx-smoke.cjs` 已改，并用**变异版确认 `exit=1`**。
- ⚠️ 存量风险（**本阶段未改**）：`scripts/*.cjs` 的一批 DB 冒烟（`picking-db` / `order-db` / `ae-cost` /
  `style-authority` / `schema-migration` / `shop-db` / `ship-rate-db` …）多是同款写法，退出码在
  node 模式下确认真实透传，但**同款"后来又 exit(0)"的写法没逐个清**。

**顺手改掉一处"表达失真"**（截图复核发现的）：一件价都查不到时段标题与顶部指标写 `预估 ¥0.00`
—— 0 元会被读成"这批货不值钱"，事实是"还不知道多少钱" ⇒ 改为 `—` +「N 件全部无进价」，
且只有**部分**缺价才叫"不含"。

**验证**：`tests/picking.spec.ts` **+11 条 = 32 项**；`scripts/picking-xlsx-smoke.cjs` **新增 15 项**
（含"媒体扩展名跟着内容推"、"`[Content_Types].xml` 有 `image/jpeg`"、"无进价读回来是 `null`"、
"一个厂家一张 sheet"、"各表的数来自各自的行"、WebP/PNG/认不出三种文件源）；
`scripts/picking-ui-smoke.mjs` **41 → 44 项**（新增"全无价不写 ¥0.00"两条 + 段标题一条，假桥的
`orderImageThumbBatch` 改为返回**真 JPEG** —— 原来返回假 dataUrl 会让每张图被静默跳过，这条链永远测不到）；
**10 组变异**逐组确认变红后复原（`grep -rn MUTANT` 无残留），其中一组打的是**界面接线**
（`generate()` 不再传成本区间）—— 这类错单测看不见、只有界面冒烟抓得到；
`npx vitest run` 633 / `tsc` / `vue-tsc` / `verify` / `verify:docs` / 9 个 DB 冒烟 / 5 个其它 UI 冒烟 /
`ipc:shape:smoke` 13 / `plugins:island:smoke` 5/5 全过。
详见 `docs/notes/2026-10-30-picking-and-takeout.md`。

### Added · 商品ID 映射带上颜色（S4）＋ 修掉两个「只有老库才暴露」的 bug（2026-10-05）

**背景**：用户点名的三个问题里，①「颜色只能靠图片肉眼区分」与 ②「商品ID 和厂家产品的关系怎么处理」
其实是**同一件事** —— 让**商品ID 成为颜色的权威源**（拍板项 G4：映射升到「款 + 色」级）。
配一次，该商品之后的所有订单自动带出款编码与颜色，人工从「每单看图」降到「每商品配一次」。

**变更（零迁移、零新 IPC 通道、零能力域、岛不发版）**

| 事 | 落点 |
| --- | --- |
| 颜色**存哪** | `pl_shop_sku.spec`（`'*'` = 未指定）。**不新增列、不动 `pl_variants`** —— 它的粒度是 款×色×码，而映射只需要「款 + 色」，选哪行变体是任意的 |
| 变体关联 | 写库时按 `(product_id, 色)` 反查一个变体填 `variant_id`（0 = 该色还没录变体）；**不让用户把颜色选两遍** |
| 匹配语义 | `resolveOrderSku` 去掉写死的 `spec = '*'`，改 `ORDER BY (spec='*' OR spec='') ASC, id ASC`（**带色行优先**） |
| 归款颜色 | `autoAssignByMap` 改为 **映射配的色 → 订单原文色 → `未分类`** |
| 拣货投影 | `pickingRows` 的 `color` 改为 **款色 → 订单原文**（详见下方 bug ②） |
| **回填** | 新增 `reassignOrdersByItemIds()`；`product-sku-map` 写成功后**自动回填存量未归款订单**，回执里报「已自动关联 N 行存量订单」 |
| UI | `ProductPicker` 增加**颜色下拉**（选项 = `COLOR_SWATCH` 的键，与 `oi_style_colors.color` 同口径）；改绑时预填原色，不预填会把配好的色冲掉 |

**修 bug ①（P0）：`oi_styles` 的建表语句、三处 INSERT、迁移三方矛盾 ⇒ 老库上任何"新建款"必崩**

- 现象：真实库上配映射后归款直接抛 `SqliteError: table oi_styles has no column named name`
  （同理，AI 识别建款也必抛；**症状是"识别/归款静默失败、款表永远为空"**）。
- 根因：建表 `order-db.ts` 带 `name TEXT NOT NULL`、三处 `INSERT INTO oi_styles (code, name, fingerprint)` 都写它，
  而 v3 迁移 `migrateOrderSpine` 又对老库 `ALTER TABLE oi_styles DROP COLUMN name`。
  文件头注释写的"列保留、写入空串哨兵"与迁移**相反**，是过时残留。
- **为什么一直没人发现**：冒烟建的是**新库**（建表带 `name` ⇒ INSERT 成功）⇒ **冒烟恒绿、线上必崩**。
- 修法：统一到"**无该列**"（迁移的意图）—— 建表去掉 `name`、三处 INSERT 去掉 `name`、
  迁移里的「历史名交接」与 `DROP COLUMN` 都**先探列再动**。改完 `picking:smoke` 在新库（已无 `name`）上仍全绿，
  **这一步同时证明"夹具形状终于等于线上形状"**。

**修 bug ②：拣货单读的是「订单原文色」而不是「映射/识别结论」**

- `pickingRows` 一直返回 `color = oi_orders.color`（订单原文，实测恒空 / 39% 是 `Picture color` 占位），
  而映射带出的颜色在 `styleColor` 列 —— **配好的颜色在拣货单上被丢掉**，症状是"我明明配了色，拣货单还是没色"。
- 修法：`color` 改为**款色 → 订单原文**的回落，并在类型注释里写明"谁是权威"。

**验证（逐条看退出码，全 0）**

- `tsc` / `vue-tsc` / `verify` / `verify:docs`；`vitest` 37 文件 **622 例**。
- `npm run picking:smoke` **14 → 19 项**：新增 5 条全钉在颜色链上（映射带色落地 / **带色行优先于 `*` 行** /
  **写入后回填存量订单** / **回填不覆盖已有结论** / 缺省 `spec` 行为不变）。
  **3 组变异**（匹配排序 / 归款取色 / 投影回落）逐组确认对应断言变红后复原，`grep -rn MUTANT` 无残留。
- `product:smoke` 44 / `style:smoke` 22 / `order:smoke` / `schema:smoke` / `product:sku:smoke` /
  `goods:ui` 52 / `picking:ui` / `today:ui` / `ipc:shape:smoke` 13 全过。
- **克隆真实库端到端**（`cp -cR` + electron，不动原件）：配 1 条映射 → **回填 2 行** →
  `款=STYLE-002 色=黑色 码=L / 5XL`，`variant_id` 自动关联到「虎头袄 · 黑色」变体。

**用户待办**：① **重启宿主**（S1 是外部写库，内存态不刷新）；② 在「货与成本 › 映射与关联」
按 `2026-10-05-mapping-carries-color.md` 的对照方式配 **8 个商品ID**（顺手选颜色）。

### Added · 「今天」页发货主线流程卡（S2）＋ S1 数据补齐（2026-10-05）

**背景**：六步流程（导订单 → 归类 → 拣货 → 拿货 → 发货 → 结算 → 对账）里，**宿主能直达的只有前四步**，
而界面上这四步是**三张并列的卡、没有任何顺序关系** —— 用户得自己判断"现在该做哪一步、下一步点哪"。
（同一个病灶上一轮刚在「导入回执」上修过一遍：**导完不知道去哪、也不知道下一步**。）

**S1 · 数据补齐（用户已拍板，外部写库，非代码变更）**

- 清空历史订单：`oi_orders` 157 → 0、`oi_images` 32 → 0、`oi_queue` 32 → 0、
  `pl_shop_sku` 3 → 0、`oi_styles` 27 → 0、`oi_style_colors` 38 → 0、`oi_style_fingerprints` 22 → 0。
  32 张图片**移到**备份目录（未删）。备份：`<userData>/backup_before_order_clear_20261005-131641/`。
- 存量成本回填：`ae_cost_map` **0 → 7 行**（6 款）—— 补 `syncPurchaseCosts` 上线前拿货单没进成本表的缺口。
- 产出商品ID配单清单 `/tmp/mango-item-mapping-checklist.md`（**17 个去重商品ID**，含订单行数/尺码/标题）。
- 未动的主数据：`pl_products` 27 / `pl_variants` 5 / `suppliers` 2。

**S2 · 流程卡（`src/modules/today/TodayView.vue`，零新 IPC、零新表、零发版）**

- 新增 `data-act="flow"` 区块：四步（**导入订单 → 归类核对 → 生成拣货单 → 算钱**），每步给
  「现在什么情况（带数字）+ **在哪个页面做**（写人话页名，不写模块 id）」；点任一步直达该模块。
- 状态**只由本页已有数字推导，不引入新取数**：`orders.total` / `gaps.style` / `picking.sku` / `gapTotal`。
- **串联语义（本轮唯一的设计要点）**：前一步没完成时，后面的步骤一律 `todo` + 写明「等第 N 步」。
  初版各步独立判断 ⇒ 有未识别款时第 2/3/4 步**同时**高亮（截图上是三块橙边），
  「当前该做哪一步」这个卡片唯一的职能反而答不出来。现在 `now`+`gap` 合计**恒为 1**。
- `flowNext` 条：「下一步：<步骤名> —— <它的情况>」+ 一个真按钮（`data-act="flow-next-<key>"`）。
- `flowTail` 条：后三步（拿货 → 结算 → 对账）如实标注**界面在「订单归类」插件的「拿货对账」页**并给入口。
  按钮文案是「打开「订单归类」」而非「去「拿货对账」」—— 宿主**跳不进岛的某个页**
  （`switchModule` 的 `action`/`payload` 是半接线：`AppShell.vue:491` 只写 `window.__switchModuleAction`，
  **全仓无消费方**），文案不能承诺落在那一页。

**验证**

- `npm run today:ui` 假桥无头冒烟 **ALL PASS（40 → 48 项）**。新增 8 条**全部钉在 `data-act` 上**：
  四步齐全 · 每步标明"在哪个页面做" · **当前步唯一 + 后续步骤被挡且写明等谁** · 已完成的步打 `done` ·
  「下一步」跟着当前步走且指向真实模块 · 点它真派发 `switch-module → order-insight` ·
  后三步如实标注在插件里并给入口。⚠️ 这条**点击会进 `window.__events`**，断言末尾必须清空
  （后面有按 `[0]` 取 `switch-module` 的断言，不清就是假红）。
- **变异复核 4 组，逐组确认对应断言变红后复原**（全部用 Edit 改、逐条取退出码，不串管道）：
  ① `flowNext` 恒回落第 1 步 → 「下一步跟着当前步走」+ 跳转断言红；
  ② 第 2 步 `state` 恒 `done` → 「当前步高亮」+「下一步跟着当前步走」红；
  ③ 第 3 步 `where` 由「拣货页」改「拣货」 → 「每步标明在哪做」红（46 PASS + 1 FAIL）；
  ④ **第 3 步 `state` 改回独立判断** → 新增的「当前步唯一」红（`高亮数=2`，47 PASS + 1 FAIL）。
  复原后 48 项全绿，`grep -rn MUTANT src/ scripts/ tests/ electron/` 无残留。
- **两张真截图**（浅色 + 深色）逐帧看过 —— 第 1 步绿边 `done` / 第 2 步橙边 `now` / 第 3·4 步灰字 `todo`，
  层次清楚。**"当前步不唯一"这个 bug 就是拍图拍出来的**（冒烟当时全绿：原断言只钉了正例、没钉排他）。
- **顺手修夹具两处不忠实**：① 假桥缺 `pluginsScan` 桩 ⇒ 兜底返回 `{success:true, data:null}`、
  而 `externalLoader.ts:44` 判 `!r.data` ⇒ **每张截图右下角常驻红 toast**「扫描插件目录失败（IPC 不可用）」；
  ② 注入脚本注释里的反引号会**提前终止模板字面量**（报错却指向注释行，本轮踩两次）—— 已改成不带反引号的写法。
- 门禁：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `npm run verify` / `npm run verify:docs` /
  `npx vitest run`（37 文件 622 例）**逐条单独取退出码全 0**。
- 顺带修的守卫：`tests/uxEntryNames.spec.ts` 的 `ALLOWED_NON_ENTRY` 新增「拿货对账」
  （它是「订单归类」岛**岛内的一级页签名**，宿主不可枚举 ⇒ 只有豁免这一条路；同先例「识别设置」）。
- 结论笔记：`docs/notes/2026-10-30-ui-nav-and-tabs.md`。
- **未做（待用户另行授权）**：S3 拣货单升级（金额 / 按厂家分组 / 导出带图）、S4 启用 `pl_shop_sku.spec`/`variant_id`、
  S5 拣货→拿货、S6 拿货→发货、S7 收编拿货对账（G1 未拍板）。

### Added · 每日发货全流程改造方案（差距审查，2026-10-05）

- **新增 `docs/plans/DAILY_SHIPPING_FLOW_PLAN.md`**：把「日导出 → 归类 → 拣货 → 拿货 → 发货 → 结算 → 对账」
  六步做成差距审查 + 阶段表。**结论：数据能补齐，且比预想容易 —— 缺口不在数据源，在"主数据没维护 + 存量没归一/没回填"。**
- **§1 全部是真实库只读实测**（`userData/sellerkit.db`），三个颠覆原假设的发现：
  ① 「商品ID ↔ 厂家产品」**只需配 17 个商品ID**（现有 3 条映射已覆盖 42 行订单的 26 行 = 62%）；
  ② 颜色**不是缺失**（`oi_orders.color` 157/157 有值），而是**62 行是 `Picture color` / `Image Color` 这类"看图"占位值**（39%），其余中英混杂（`black` 与 `黑色` 并存）→ 缺的是**权威源**；
  ③ 成本表 `ae_cost_map` **0 行**（拿货单已有 3 张、12 行有价）⇒ 预估金额的口径**被数据定死**为 `purchase_items` 的拿货价，另需一次存量回填。
- **头号发现（比"界面不直观"更根本）**：157 行未发货订单里 **115 行是老采集数据迁移的"半残行"**
  （`raw_fields` 只有整帧、无产品ID、无图、未识别款），全部堆进拣货单「未识别款」组 → 157 行聚出 75 组噪声；
  识别队列 `oi_queue` 32 条**全是 `pending`（识别从未跑过）**。
- **方案 S1–S7**：S1 数据补齐（配 17 个映射 + 存量成本回填 + 处置 115 行采集帧）→ S2 主线流程卡 →
  S3 拣货单升级（金额 / 按厂家分组 / 导出带图）→ S4 启用 `pl_shop_sku.spec`/`variant_id`（映射进拣货链、识别降为兜底）
  → S5 拣货→拿货 → S6 拿货→发货 → S7 对账入口统一。
- **待拍板 3 项**（G1 拿货对账是否内建化 / G3 颜色枚举 / G4 映射升变体级）；
  原「进价口径」候选已被实测解决（`ae_cost_map` 空），不占用决策。

### Changed · 导入回执：导完之后「数据去哪了 / 下一步做什么」说清楚（2026-10-05）

**背景**：用户实报「现在的流程还是不够直观，导入订单后，接下来不知道要做什么，并且数据也不知道去哪了」。旧实现只有一行灰字（`识别为「订单报表」（…）→ 已导入 17 行…`）——**判据写得挺全，但缺两样东西**：① 没有目的地（没说进哪张表、去哪个页面能看见）；② 没有动作（三张卡并列，用户得自己判断"导完订单该点哪个"）。

**改了什么**（**零新 IPC 通道、零新表、零能力域变更、岛无需发版**）：

- **`src/core/services/importSheet.ts`**：`AutoImportResult` 新增三个**结构化**字段（界面不再从一句话里猜）：
  - `title` —— 人话类型名（`订单报表` / **`芒果店长待发货订单`** / `结算明细` / `报价单`）；
  - `landed` —— **数据去哪了**：`{ label, views }`，只给**人话名**与**用户真点得到的页面名**（不写 `oi_orders` 这类表名 —— 那是开发者视角）；
  - `next` —— **接下来点哪**：`[{ label, moduleId, primary }]`；订单类按"店铺已归属 / 未归属"给两组不同按钮。
- **`src/lib/importDetect.ts`**：`ImportDetection` 新增 `variant`（更具体的子类名；`item-info` 标识"认出来了但这类文件不该导"的那支）。
- **`src/modules/today/TodayView.vue`**：`lastImport: string` → `receipt: AutoImportResult | null`，渲成**回执卡**四段（状态+标题 / 判据明细 / 落点 / 下一步按钮），可一键关闭；订单导入后把「待拣」卡点亮（`is-fresh` 边框 + 一行"刚导入的订单已算进来"）——**只引导视线，不重复入口**（动作仍是卡里原有那个按钮）。
- **提示变入口**：`message` 里那句"可在「算钱」页一次「归到该店」"原来只是个说法，现在店铺未归属时回执的第二格按钮就是它（原句一字未删，仍在明细里）。
- **卡片内部顺序 = 结论在前、证据垫底**：落点 + 下一步提到判据**之前**，判据压成最后一条带分隔线的灰字脚注（它是最长的一段，夹在标题和落点之间会把"数据去哪了/下一步点哪"挤下去）。
- **两个被"真截图"照出来的文案 bug**（光看断言发现不了 —— 断言只看 `data-act` 锚点里的几个词）：
  ① `kind === null` 分支一律用「**没认出**这个文件是什么…」当 message，而「商品信息」表是**已经认出来了**的那支 ⇒ 标题写「商品信息」表、正文写"没认出"，自相矛盾（现按 `item-info` 分开写）；
  ② 检测层那条体检记录里带着 markdown 的 `**不用再导入**`，在界面上**星号是按字面渲染的**（已去掉 —— 这些字符串是**用户可见文案**，不是文档）。
- **顺手堵一个静默缝**：`importExcel` 在**选定文件之后**先撤掉上一条回执 —— 否则识别期间界面挂着上次结论；商品信息表与"认不出"两条 message 都以"没认出这个文件是什么"开头，重复导入时会**被读成这次的结论**（冒烟真踩到了，见下）。

**验证**：

- `npm run today:ui` 假桥无头冒烟 **ALL PASS（30 → 40 项）**。断言升级为**按 `data-act` 逐元素**（不再拿整段 `textContent` 拼串 —— 回执拆成四段后，相邻元素间 `textContent` 不插分隔符，整串比对会假红/假绿）；**新增 10 条 / 改写 2 条**：回执把"是什么"与"凭什么这么判"分开渲染 · **落点行说清在哪三处看得到** · **下一步按钮每个都指向真实模块**（白名单**从 `modules.config.json` 读**，不抄副本；订单回执按"店铺已归属/未归属"的**两组分支各测一次** —— 只测一组会漏掉另一半）· 主操作是「生成待拣清单」· **刚导完订单点亮待拣卡** · 标题点名到「芒果店长待发货订单」· **认不出时不给"下一步"按钮**（反向守卫）· 回执可关掉且真的消失。
- **两张真截图**（把冒烟脚本的 `--dump-dom` 换成 `--screenshot` 复用假桥）逐帧看过："已导入 / 未写入"两种语气、`landed` 为空时的布局、亮起的「待拣」卡 —— 上面那两个文案 bug 就是这么发现的。
- **踩到的坑（已固化为断言纪律）**：junk 那条的完成信号原本是 `indexOf('没认出')`，而商品信息表的 message **也含"没认出"**（模板开头）⇒ 上一条还在界面上时就已满足 ⇒ 后续断言全读着旧回执做（"认不出不给按钮"因此判成红）。**两层修**：根因是新一轮导入先撤旧回执，判据改成钉在唯一特征（`import-title`）上。
- **另一条更要命的坑**：变异复核时用 `npm run build | tail -2 && npm run today:ui` —— **管道把 build 的失败退出码吞了**，冒烟跑的是**旧 `dist/`**，于是"变异后仍然全绿"差点被读成"断言恒绿"。改成逐条单独取退出码后，4 组变异一次打入 **5 条断言全红**，复原后 40 项全绿。
- 门禁：`tsc` / `vue-tsc` / `npm run verify` / `npm run verify:docs` / `npx vitest run`（37 文件 622 例）全绿；`grep MUTANT` 无残留。
- 结论笔记：`docs/notes/2026-10-30-order-import-pipeline.md`。

**没动的**：`detectAndImport` 的 message 文案（除新增字段外一字未改）、`importOrders` 的落库行为、IPC 契约、`oi_orders` 表结构。

### Added · 芒果店长「待发货订单」导入（2026-10-05）

**背景**：用户给出芒果店长导出的**待发货订单**模板（12 列 / 16 行），要求按当前基线接入导入。该模板与速卖通订单报表**长得像但不一样**：它自带「店铺名」与「产品图片链接」两列（AE 是**按店铺导出**、既没有店铺列也没有图列）。

**改了什么**（全部落在宿主「今天」页的**统一导入**链路；**零新 IPC 通道、零新表、零能力域变更、岛无需发版**）：

- **识别**（`src/lib/importDetect.ts`）：新增「芒果店长待发货订单」签名（订单号 + 产品数量 + 产品图片链接）—— 它在通用订单报表签名**之内**、更具体；判据 `why` 点名「芒果店长」并说明自带店铺名与主图列（`why` 是界面上用户核对"导到哪去了"的唯一线索）。
- **列探测**（`src/lib/orderClassifier.ts`）：新增 `detectImageColumnStrict`（**不回落第一列**）。自动导入拿它去拆多产品行 —— 旧 `detectImageColumn` 认不出图列时会回落第一列，于是**无图列的报表**（速卖通 47 列，第一列是订单号）会被当成"有图片列"，拆出的行图片全空并**逐行误标缺图**。界面让人选列仍用宽松版（给个可改的默认值）。
- **一行 → 字段**（新增纯层 `src/lib/orderImportRow.ts`）：把「订单号 / 店铺名 / 尺寸 / 下单时间 / 主图 URL」的提取集中成一份可单测的口径。两个要点：① 店铺名落 `oi_orders.shop`（报表无该列才留空，仍由「算钱」页「归到该店」）；② 图片 URL 一律 **trim**（未拆行的单元格带尾随换行，带上去下载必失败）。
- **带图导入**（`src/core/services/importSheet.ts` 的 `importOrders`）：由「免图导入」改为**带图** —— 按「产品图片链接」逐行 `orderDownloadImage` 建 `oi_images` 再挂到订单行（URL/内容指纹命中即复用，重复导入不重复落盘、不重复落行）；**下载失败不丢行**，回落免图并计数上报。新增 `images` / `imageFailed` / `shops` 三个回报字段，`detectAndImport` 的消息随之说清「主图 N 张 / X 行下载失败 / 店铺已归属：…」。
- `src/core/services/ipc.ts`：补 `orderDownloadImage` 的**导出包装函数**（此前只有 `ElectronApi` 声明、没有包装 —— 与 `orderImageThumbBatch` / `importExcelByPath` 同款缺口）。

**验证**：新增夹具 `tests/fixtures/mango-pending-orders.xlsx`（用户真实导出，16 行原样，不手搓）与 `tests/mangoPendingImport.spec.ts`（**17 例**：识别判据 / 列探测 / strict 不回落 / 真实 16 行拆成 17 行的逐列对齐 / 件数 / 金额提列 / 一行→字段）。门禁 `tsc` / `vue-tsc` / `npm run verify`（IPC 契约一致，通道未变：185/185/181）/ `npm run verify:docs` / `npx vitest run`（**37 文件 622 例**）全绿；**变异复核 4 组**（strict 回落到第一列 · 芒果签名恒 `false` · 图片 URL 不 trim · 店铺恒空）各自变红后已复原，`grep MUTANT` 无残留。

**没动的**：AI 款式识别队列（仍在「订单归类」岛 —— 那是"识别"不是"导入"）、`oi_orders` 表结构与 IPC 契约、`picking` 待发货投影。

### Fixed · 「产品页的图片没有展示」= 缩略图批通道的载荷形状不一致（2026-10-04）

**背景**：用户报「产品页的图片没有展示」。先按"没数据"排：库里确实缺图（27 个产品 `image_id` 全为 0、`pl_images` 空、`product-images/` 目录不存在），但**同一个缩略图通道在「映射与关联」页本该有图**（订单域有 42 张带图订单、三层回落实测能解析到真实 webp），那里也是空的 ⇒ 问题在通道不在数据。

**根因（用真 preload 取证，不靠读代码）**：`order-image-thumb-batch` 的载荷形状两侧不一致 —— 渲染层（`src/types.ts` 声明 / `src/core/services/ipc.ts` 包装 / 岛桥 `host.ts` / 4 个调用点）一律传**裸数组**，而 `electron/preload.ts` 只读 `payload?.items`。于是发出去的是 `{ items: [] }`，主进程**正常返回**空数组，界面全是空占位且**一条错都不报**（调用方的 `catch` 拦的是异常，拦不住"成功但空"）。实测：裸数组 → 载荷 `{"items":[]}`；`{items:[...]}` → 正常载荷。

**修法**（不动 IPC 契约：零新增通道、零能力域变更、岛无需发版）：
- `electron/preload.ts` 的 `orderImageThumbBatch` 改为两种形状都收（裸数组优先，`{ items }` 兼容岛侧老调用方）。
- 同族第二个静默缺口一并堵掉：主进程/preload 都按 `slice(0, 40)` 硬截断，而调用方按"页/单"给路径（产品页一页 50 行、拣货单可能上百）⇒ 超出的行静默空图。改成在渲染层包装函数 `orderImageThumbBatch` 按 40 **拆批**（顺序不打乱、单批失败按 `null` 补位）。

**验证**：新增 `npm run ipc:shape:smoke`（真 preload + 真主进程 handler 对穿，13 项：正面 + 反面（缺失/越权路径必须 null）+ 40 项逐项对号 + 同族三条通道）与 `tests/thumbBatchChunk.spec.ts`（5 例：分批大小 / 长度 / 顺序 / 坏批补位 / 空数组）。门禁 `tsc` / `vue-tsc` / `npm run verify` / `vitest 35 文件 602 例` 全通过；变异复核 2 组（preload 改回"只认 `{items}`" → 冒烟 7 项红；去掉拆批 → 单测 2 项红）各自变红后已复原。

**遗留（未修）**：岛桥 `DB_OPS.order.imageThumbBatch` 返回 `{ dataUrls: [...] }`，而 `ui-plugins/order-insight` 的详情页按 `map[localPath]` 取值 —— 形状同样对不上，那个岛的订单详情缩略图仍不显示；修它要岛侧改 + 发版，本轮只记录（见 `docs/notes/2026-10-30-electron-and-platform.md`）。

### Fixed · 邮件收件箱正文里的图片一张都显示不出来（2026-10-04）

**背景**：用户报「邮件收件箱里的图片展示不出来」。先否掉了"数据没同步下来"这个方向 —— 列表、附件清单、附件「预览」（走 `data:` URL）全都正常，说明**只有正文里的图坏了**。

**根因取证（两条，都实测过）**：正文原先用 `<iframe sandbox="" :srcdoc="htmlBody">` 渲染，于是同时撞上两堵墙 ——

- **srcdoc 文档继承父文档 CSP**：父文档是 `sk-plugin://` 下的岛页面，CSP 为 `img-src 'self' data:` ⇒ 邮件里的远程图（`https://...`）一律被拦。探针实测日志：`Loading the image ... violates "img-src 'self' data:"`。
- **`cid:` 引用没有映射键**：内联图写作 `<img src="cid:image001.png@01D9...">`，是 MIME 的 Content-ID，浏览器不认这个 scheme；而 `sk_mail_attachments` **根本没有 content_id 列**，宿主无从把它换成真图片。

**改了什么**：

- **新增 `electron/mail-body-protocol.ts`（`sk-mail://`）**：正文改由**自带 CSP 的独立来源文档**渲染（`sk-mail://body/<messageId>`），内联图指向 `sk-mail://att/<messageId>/<attachmentId>`（磁盘缓存优先，未命中才重拉原文，复用按需限流）。独立来源 ⇒ **不继承岛 CSP**，图片能力与安全边界收敛到这一处。零新增 IPC op、零能力域变更。
  - 三层安全边界：岛 CSP 只多一条 `frame-src sk-mail:`；正文文档 CSP `default-src 'none'` + `img-src sk-mail: data:` + `script-src 'none'`；iframe `sandbox=""` ⇒ 邮件 HTML 里的 JS 一律不跑。
  - **远程图默认放行**，正文上方出「已加载 N 张远程图片 / 拦截远程图片」一键切换（放行 = `?remote=1`）。默认值的理由见下方追加段：这个收件箱的正文图 **103/103 封全是远程图**（含 `cid:` 的 0 封、附件表 0 行），默认拦截的净效果就是"打开任何一封都是空白"。计数由岛侧基于 `htmlBody` 判定 —— sandbox 文档无法与岛通话。
- **`electron/mail-html.ts`（新增纯函数层）**：`normalizeContentId` / `collectCidRefs` / `countRemoteImages` / `needsInlineBackfill` / `rewriteCidRefs`。覆盖 `src`、`background`、CSS `url()` 三种 cid 形态与三种引号写法；映射不上的 cid **保持原样**（显示裂图，不静默清空 `src`）。
- **`sk_mail_attachments` 补 `content_id` 列**（`ensureMailAttachmentColumns()` 幂等补列，老数据零丢失）。写入侧两条解析路径（同步轮 + 按需补拉）统一带上 `contentId`。
- **存量邮件惰性回填**：`mail-message-get` 发现「正文含 cid 引用 ∧ 附件行一条 content_id 都没有」时重解析一次（6s 超时兜底，超时按现状显示、回填在后台继续）。增量同步只处理新 UID，老邮件不会自己好 —— 这一步是必须的。
- **`mail-handlers.ts`**：`mail-message-get` 改为 async（回填触发点），通道与入参形状不变。
- 岛内 `MailInboxView.vue`：iframe 从 `:srcdoc` 改为 `:src="sk-mail://body/<id>"`，加远程图拦截横条。

**两个差点写错的坑**（都有守卫）：

- `content_id` **不能进** `replaceMailAttachments` 的合并键 —— 该键的作用是"保留原 attachment_id"，content_id 进键会让老行（空值）被判成另一个附件而换 id，`sk_mail_attachment_cache` 索引与已落盘文件整批失效（缓存**不失效**是 M3 定的红线）。改为键不变、命中时只在旧值为空时 UPDATE。
- 属性正则**不能**用 `\b(src|...)`：`-` 也是词边界，会把 `data-src` 里的 `src` 认成同名属性并改写（懒加载邮件大量用 `data-src`）。用 `(?<![-\w])`。

**验证**：`tsc` / `vue-tsc` / `npm run verify`（IPC 契约一致，未新增通道）/ `npx vitest run`（34 文件 597 例）/ 新增两个**无需凭据**的冒烟 —— `npm run mail:inline:smoke`（15 项：存量库补列、附件 id 稳定性、正文渲染、CSP 两态）与 `npm run mail:body:smoke`（13 项：真 handler + 真 DB + 真磁盘缓存 + 真 sandbox iframe，正文与内联图子资源都取到 200）全通过；变异复核 5 组（lookbehind · URL 反转义分支 · CSS `url()` 分支 · 合并键加 content_id · `UI_CSP` 去掉 `frame-src sk-mail:`）各自变红后已复原。

> 协议冒烟的宿主页 CSP 直接 import `plugin-ui-protocol.ts` 导出的 `UI_CSP` 真值（不抄副本）：否则"`frame-src sk-mail:` 被误删"这种回归会在冒烟里恒绿。另实测：CSP 拦 frame 时 `webRequest.onErrorOccurred` **不报**，故该冒烟里"无网络层错误"那条断言名字如实写，没有冒充 CSP 守卫。

**没动的**：IPC 通道与能力域声明、`sk_mail_*` 其余表结构、列表/搜索的"纯本地查询"红线。

**追加（同日返工三次，用户两次回报"还是没展示出来"后查出的另两层）**：上面这套代码写完、门禁全绿，但**用户机器上什么都没变**，因为

- **③ 岛没重装**：本机 `<userData>/plugins/shop-accounts/` 里还是 **2026-09-27 的产物**（仍是 `srcdoc` 版，`grep sk-mail://body` 零命中）。岛一律从 `<userData>/plugins/` 加载，仓库里的 `dist/` 只是待发布产物 —— 修岛的最小闭环是**改源码 → `vite build` → 拷 manifest+dist 进插件目录 → 重启宿主**，四步缺一不可，且不重装**没有任何提示**。
- **④ 岛自带 meta CSP 那一层没放行**：CSP 是**取交集**的。宿主响应头的 `UI_CSP` 已加 `frame-src sk-mail:`，但 `ui-plugins/shop-accounts/index.html` 里的 `<meta http-equiv="Content-Security-Policy">` 是 `default-src 'self'` 且**没有 `frame-src`** ⇒ 回落被拒。症状是**正文区整块空白**，界面无提示，Chromium 原文：`Framing 'sk-mail://body/' violates ... "default-src 'self'" ... 'frame-src' was not explicitly set, so 'default-src' is used as a fallback.`（本轮变异复现，一字不改）。已给 meta 补上 `frame-src sk-mail:`。

顺带修掉**默认值**：远程图从"默认拦截"改为**默认放行**（`MailInboxView.vue` 的 `showRemote` 初值 + 不再按邮件重置 —— 它是用户偏好）。原冒烟那条"宿主页带真 `UI_CSP` + iframe 能加载"是**假绿**（只复刻了头 CSP 这一层）。

**追加验证**：`vitest 35 文件 605 例`（新增 `tests/islandMailFrameCsp.spec.ts` 3 例：岛若引 `sk-mail://` 则其 `index.html` 的 meta CSP **必须**放行 `frame-src sk-mail:`，且宿主 `UI_CSP` 也必须有 —— 解析 `content` 属性而非搜子串）；`npm run mail:body:smoke` 扩到 **20 项**（新增：默认态**远程图零请求** / `?remote=1` 真起一个**非 loopback http 服务**并断言取到 200 / 用岛的真实 `index.html` 的 meta CSP 复刻第二层）；变异复核补 2 组（`UI_CSP` 默认态也放行远程图 · 岛 meta 删掉 `frame-src sk-mail:`）各自变红后已复原。

**真机验收（唯一能证明"用户真能看见图"的一步）**：真实 userData 克隆 + `--remote-debugging-port` + CDP 直读 `sk-mail://body/414?remote=1` 文档 ⇒ `{"total":4,"loaded":4}`（`naturalWidth>0`），并顺带证实 `http://` 图**不会**被混合内容拦（84/103 封邮件用 http 图）。

> 状态：岛已升 **1.6.0** 并已**装进本机插件目录**（旧产物备份在 `/tmp/shop-accounts-backup-*`）。**尚未发布到市场**（用户要求先确认再发）；发版时在 `market-out/` 里 commit+push 那一步不能省，链条见 `docs/notes/2026-10-30-island-publish-and-retire.md`。另注：`ui-plugins/shop-accounts/src/` 里还有别的在途改动（「名下店铺」区块等），本次 rebuild 把它们一并打进了 1.6.0 产物，发版前需确认是否一起发。

### Fixed · 「算钱」不是缺字段，是右边几列被容器裁掉了 + 同屏合计口径不一致（2026-10-03）

**背景**：用户报「算钱页面信息展示不全，并且很杂乱」。"展示不全"的第一反应是"少了字段"，但取证否掉了这个方向。

**根因取证（先量再改）**：在真实长度的夹具下量 DOM —— `table.scrollWidth = 1211` > `page.clientWidth = 1064`，而外层 `.wb-panel { overflow: hidden }` **静默吃掉溢出**（没有滚动条、不报错）。截图 `/tmp/c3-oc-clipped.png` 里右侧 3 列整块被切掉。⇒ **"展示不全" = 容器裁切，不是数据缺失**。这条决定了修法：不是加字段，是让表能滚。

**改了什么**：

- **新增全局 `.wb-table-wrap`**（`src/styles/index.css`：`overflow: auto` + `max-height`，首列吸附）→ 明细表与统计表都套进去。宽度不够时**出横向滚动条**，而不是静默裁掉。
- **顺带查出一个真实的口径 bug**（`src/lib/orderCost.ts`）：`costTotal` / `shippingTotal` / `platformFeeTotal` **含关闭单**，而并列显示的 `revenueTotal` / `grossTotal` **不含** —— 四个合计写在同一条指标带上，口径却不同，用户拿它们相减算毛利会得到错的数。统一为「只含非关闭单」，接口注释同步。补单测守卫（变异 → `expected 52 to be close to 26`）。
- **去杂乱：4 条顶栏 → 2 条**（`OrderCostView.vue`）：合并为**概览卡**（指标条 + 体检行）+ **筛选条**。指标条由 4 格扩到 6 格，补上原先只在明细里能看到的**成本合计**与**毛利率**。
- **明细表 16 → 14 列**：
  - 「订单」= 单号 + 店铺（两行一列，不再各占一列）；
  - 「毛利」并入**预测 / 精准** tag（原先是独立一列「轨」）；
  - 「来源」压成紧凑文本；「成本」→ **「产品成本」**（与"平台费/运费"区分口径）；
  - **新增「平台费」列** —— 原先平台费只出现在提示里，明细看不到。
- **「汇总」+「时间趋势」合并为一个面板**：用分段控件（`.wb-seg`）切换，`v-show` 保留两表，不再上下堆两块表格。
- **`.wb-seg` 提为全局**（原为「货与成本」模块内私有），控件来源保持唯一；`SkuMappingView.vue` 改用全局类。

**冒烟同步与加固**（`scripts/order-profit-ui-smoke.mjs`，**81 PASS**）：

- 新增**根因反向守卫**：断言 `.wb-table-wrap` 存在 + 该容器 `scrollWidth > clientWidth` 时**真的可滚动** + **最后一列可达**（实测 `wrap=true overflowX=auto 表宽=819 容器宽=498 溢出=true 末列可达=true`）。这条把"表够宽时也该滚"钉住 —— 只断言"有 wrap 元素"会恒绿。
- 新增「平台费」列守卫、合并面板守卫（`面板数=1` + 点「趋势」切换）、指标条逐元素（`data-act`）断言。
- **变异复核 4 组**（用例全绿 ≠ 守卫有效）：① 去掉滚动包裹层 → `末列可达=false`；② 平台费列恒显 0.00 → 列守卫红；③ 分段切换打断 → 红；④ `costTotal` 退回含关闭单 → `expected 52 to be close to 26`。四条均已复原。

**没动的**：IPC 通道、能力域、数据库表结构（`npm run verify` 显示 185/185/181，与改动前一致）。

### Changed · 「算钱」交互简化：提示变入口、缺口行收敛、去生造词（2026-10-03）

**背景**：与「货与成本」同一套方法（先取证再改）。首屏把**问题**和**解决问题的路**分在了两处 —— 页头一个 `<span>` 说"未归属 N 单"（看着像待办、点了没反应），而真正的动作藏在「更多」里，用户看见问题却找不到入口；「缺哪一环」无论 0 都渲染 8 个 `缺X 0`，数据齐全时要逐个读完才知道"都齐了"。逐条改掉：

**改了什么**：

- **提示变入口**（`OrderCostView.vue`）：
  - 页头「未归属 N 单」由 `<span>` 改**可点按钮**（`data-act="unassigned-hint"`，文案补「· 去归属」）→ 点击自动展开「费率与归属」并**聚焦店铺下拉**（`openMore('shop')`）。
  - 「平台费未扣」同样改为可点按钮（`data-act="fee-missing"`，文案补「· 去配费率」）→ 展开并**聚焦平台费率输入**（`openMore('rate')`）。原先用户看到"平台费未扣"也不知道去哪儿配。
  - 新增 `.wb-btn--warn`（`src/styles/index.css`，与 `.wb-tag.is-warn` 同一角色），供这类"这是待办"的按钮用。
- **「缺口」行收敛**（`OrderCostView.vue`）：新增 `activeGaps`（只留 `count > 0`）。全齐时只渲染一句 **「没有缺项」**（`data-act="gaps-none"`）；有缺时**只列非零项**（`warn` 色，逐项 `data-act="gap-<key>"`）。原来 8 个 `缺X 0` 是"数据齐全的正确表达 = 8 个零"。
  - ⚠️ **顺带修掉一个自己引入的作用域矛盾**：「没有缺项」是**对整行**的断言，而 `platformFeeMissing` 也是这一行里的一项 ⇒ 条件收紧为 `v-else-if="!summary.platformFeeMissing"`。否则未配费率时会同时显示「没有缺项」与「平台费未扣 · 去配费率」，读起来是"什么都不缺、但这个缺着"。
- **去生造词 / 行话**：
  - 「算齐 N」→ **「各环齐全 N」**（"算齐"是生造词，且与「缺哪一环」配不成对）。
  - 明细表列头「轨」→ **「毛利依据」**（"轨"是代码注释里的说法"留给将来接结算数据的那一轨"，用户看到列里写着「预测」完全不知道这列在说什么），并给 `<th>` 补 `title` 说明预测/精准两种口径。
  - 「缺运价卡」→ **「缺运价表」**（全页其余处含 tooltip 都叫"运价表"，只此一处叫"卡"）。
- **去掉开发者视角的括号 / 冗余说明**：
  - 「只补"订单自己没说"的行（采集帧没有代征代缴列）」→ **「只作用于订单自己没写税的行」**（去掉实现细节）。
  - 「（合并计费口径待定）」→ **「（多件合并计费尚未支持）」**（说清是"没做"而非"待定"）。
  - 删时间趋势区那句「汇总口径与上表同一份（关闭单不计）」—— 与面板标题「时间趋势（只含非关闭单）」重复。
- **指标条补锚点**（`OrderCostView.vue`）：四格加 `data-act="metric-rows|metric-complete|metric-revenue|metric-gross"`，为冒烟提供稳定判据（今后改标签文案不再把断言整条带红）。
- **「归到该店」补明作用域**（`data-act="assign-scope"`）：「会改写**当前列表里全部 N 个订单号**的店铺（不只是未归属的那几单）」。⚠️ **只把行为说清楚，没改行为** —— "是否该只处理未归属单"属产品决策，留给用户定。

**冒烟同步与加固**（`scripts/order-profit-ui-smoke.mjs`）：

- 指标条断言由「`.oc-topbar` 整段 `textContent`」升级为**按 `data-act` 逐元素断言**。
- 「缺口」行判据改为：全齐 → **无任何 `gap-*` chip**；未配费率时**不出现**「没有缺项」；配好费率后**才出现**「没有缺项」（有缺 → 逐项按锚点出现）。
- **补一条此前零覆盖的用户路径**：点页头「未归属」→ 「费率与归属」展开 **且店铺下拉获得焦点** → 之后才继续该分支原有断言。
- **变异复核 4 组**（项目纪律：用例全绿 ≠ 守卫有效）：① `activeGaps` 退回"全量"→ 三条缺口断言同时变红（`none=false chips=8`）；② `openMore` 去掉聚焦 → `FAILED at [shop] - timeout`；③ 列头改回「轨」→ 列头断言变红；④ 「没有缺项」条件退回 `v-else` → 变红（`none=true fee-missing=true`，正是那个矛盾态）。四条均已复原。

**没动的**：数据层、能力域、IPC 通道、算账口径（`src/lib/orderCost.ts`）。

### Changed · 「货与成本」交互简化：去重复入口、去假动作、统一术语（2026-10-01）

**背景**：模块收回内建后控件密度偏高 —— 产品页签在表格之上叠了 **5 个指标 + 4 个页签 + 9 个常驻控件**（共 18 个可交互元素，工具栏靠 `flex-wrap` 折行）。盘点后发现有**四类**具体问题，逐一改掉；每一条都先定位到文件与行，不凭感觉"简化"。

**改了什么**：

- **假动作**（`GoodsView.vue`）：指标条左段「产品 N」「SKU M」原先**两格都是按钮、都绑 `goProducts('all')`** —— 看着能点，点下去只是"回到全部"。改为**只读事实格**（`<span>`，锚点 `data-act="metric-products"` / `metric-sku`）。右段三格（缺克重 / 未关联供应商 / 已映射商品ID）确实是待办入口，保留可点并补 `data-act` 锚点。
- **重复入口**（`ProductListView.vue`）：工具栏常驻控件 **9 → 6**。
  - 删「下载模板」—— 导入弹层里本来就有（`ProductImportDialog.vue` 的"没有现成表格？下载导入模板"），且那句文案更贴场景。
  - 删「只看缺克重」「只看未关联厂家」两个常驻开关 —— 它们与指标条是**同一状态的两张面孔**，且互斥关系（服务端三个筛选互斥）在界面上**完全看不出来**：点一个会静默关掉另一个。
- **新增「活跃筛选」chip 行**（`ProductListView.vue`，`v-if="filtered"`）：**空闲时整行不存在**（不占垂直空间、不增加"要看的东西"）；每个生效条件一个可一键撤掉的 chip（搜索 / 状态 / 供应商 / 缺克重 / 未关联），另有「清空全部」。筛选入口因此统一到顶部指标条一处。
- **术语统一**：同一概念原先**两套词**（`厂家` 23 处 / `供应商` 18 处，连 `SupplierView.vue` 一个文件里两种都有）。用户可见面一律改为**供应商**：指标条、产品表列头、下拉「全部供应商」、供应商页、导入弹层说明、批量编辑与详情抽屉标签。
  - ⚠️ **连带改 `PRODUCT_EXPORT_HEADERS` 第 3 列**（`src/lib/productImport.ts`）：导出/模板的表头是用户可见产物，不改就变成"界面写供应商、导出的表写厂家"。**不影响老文件** —— `COLUMN_FAMILIES.supplier` 别名族同时收录「厂家名称 / 厂家 / 供应商名称 / 供应商 / supplier」，用户按旧表头导出的文件仍能原样导回。
- **页头说明随页签走**（`GoodsView.vue` 的 `TAB_DESC`）：原先那句固定枚举（"款式 · SKU · 克重 · 厂家 · 商品ID 映射"）**切了页签就不成立**，而切页签时正是最需要一句解释的时刻。改为一句人话 + "什么时候该来这"，用页头**本来就有**的说明位，不新增控件。

**冒烟同步与加固**（`scripts/goods-ui-smoke.mjs`）：

- 指标条断言由"整段 `textContent` 拼串"升级为**按 `data-act` 逐元素断言**（因为改了文案 `厂家 → 供应商`，整串比对会一起失配 —— 这是"用测试迁就实现"的反面）。
- **补一条此前零覆盖的用户路径**：点指标条「缺克重」→ 产品表**筛到 1 款** → 出现活跃筛选 chip → 点 chip 的 × → **回到 2 款且整行消失**。
- 新增断言：工具栏**不再**有「下载模板」与两个常驻开关；假桥 `productList` 真的实现 `onlyMissingWeight` / `withoutSupplier` 参数（否则新断言是空转）。
- **变异复核 3 条**（项目纪律：用例全绿 ≠ 守卫有效）：① 把事实格改回按钮 → 「产品 / SKU 是只读事实格」变红；② 把 chip 的 × 错分派到别的条件 → 筛选路径超时变红；③ 把导出表头改回「厂家」→ 单测变红。三条均已复原。
- 单测 **577 → 578**：新增「导出表头第 3 列是「供应商」」**钉字面量**（原来那条是常量跟自己比，表头被整体改错时恒绿）。

**没动的**：布局骨架（`.wb-page/.wb-head/.wb-metabar`）、数据层、能力域、IPC 通道、页签名。

### Removed · 「产品库」UI 岛整体下架：功能收回内建，连带删掉 5 个已无消费者的能力域（2026-10-01）

**背景**：上一轮已把产品库的功能迁进内建「货与成本」（4 个页签）。既然内建页与宿主**同进程**、
不经 `window.__sk` 桥，那个岛就只剩"同一套功能维护两处"的代价；而它那 5 个 `DB_OPS` 能力域
（`product` / `product-admin` / `product-image` / `product-supplier` / `shop-products`，共 **32 个 op**）
**一个消费者都没有** —— 是纯权限面（沿用 `picking` 域 2026-09-30 删除的先例：死物可删）。

**做了什么**：

- **三处版本坐标一起清**（只删仓库源码 = 线上市场仍装得到、本机已装的还会跑）：
  - **仓库**：`ui-plugins/product-library/`。注意该目录**未被 git 跟踪**（`git ls-files` 为 0），
    直接 `rm` 不可回滚，故先打 tar 备份校验、再 `mv` 进被 .gitignore 的 `.workbuddy/retired/` 留档，最后删。
  - **市场**：删 `market-out/catalog.json` 里的 `product-library 1.5.0` 条目并 **commit + push**
    （`d37367a..279ee07`）。线上复核：目录 HTTP 200 且**只剩 5 条**、`product-library-1.5.0.zip` **HTTP 404**。
  - **本机**：`~/Library/Application Support/seller-kit/plugins/product-library/` 同步移除（装完需**重启宿主**才生效）。
- `src/core/plugin/host.ts`：删 5 个能力域共 **32 个 op**（299 行），就地留 16 行**墓碑**（同 `picking` 的样式），
  写明"数据层与 IPC 通道不动"。`DB_OPS` 收敛为 **7 个域**。
  ⚠️ 判据：内建页**结构上够不到** `DB_OPS`（该对象只经 `window.__sk` 桥暴露给 iframe 岛）；
  `npm run verify` 显示 **IPC 契约零改动**（`preload` / `src/types.ts` / `ipc.ts` 三方未动）。
- `tests/pluginTriage.spec.ts`：删该岛的 **8 条**守卫用例（留 9 行墓碑指向宿主冒烟）；
  该组的**自证**那一条从 `expect(domains).toContain('product')` 改钉 `'order-insight'`
  —— 否则"锚点分类消失"会让整组守卫静默空转。
- `package.json`：移除 `product:sku:ui` 脚本（该冒烟随岛下线，断言已整组迁进 `scripts/goods-ui-smoke.mjs`）。
- 文档与本机笔记同步：`docs/features/PRODUCT_LIBRARY.md` 新增 **§0-A**（能力域→新落点对照表 + 6 步可复核下架清单）、
  `docs/README.md`、`AGENTS.md` §1.4（岛实例 6 → **5**）、`docs/baseline/PROJECT_BASELINE.md`、
  `docs/plans/{RESTRUCTURE_PLAN,DOMAIN_INTEGRATION_PLAN,UX_POLISH_PLAN}.md`（均就地加 ⚠️ 注明"当时做法"、不改历史结论）、
  `scripts/check-doc-links.mjs` 补 3 条豁免。

**连带修好三个既有红冒烟**（都是"实现改了、判据没跟上"，**不是**产品回归）：

- `style:smoke`（22/22）：夹具造的是**不可能组合**（新形状 `oi_orders` + 有内容的 `oi_styles.name`），
  v3 迁移会直接早退 ⇒ "名字交接"这条路径从未被跑到。改为先建**真·老库形状**并把迁移版本退到 v3 的前驱，
  A2 加断言"遗留列是真的被 `DROP COLUMN`"（并复核过它确实能变红）。
- `order-profit:ui`（ALL PASS）：期望值仍按"商品ID 级克重"算，改为 **SKU 级 275g**（运费 30.00 / 毛利 125.18 /
  精准毛利 50.86 / 费率后 110.31）；把**已删通道** `productWeightGet` 的桩改成**绊线**（保留，但断言调用 0 次）。
- `schema:smoke`：`product.sku` 迁移多了第 3 步（删 `pl_item_weights`），而冒烟硬编码版本 `2`。
  改为 `PRODUCT_SKU_STEPS` 等常数 + **自证**（常数 ≠ 源码步数时**这条自己先红**并给出可执行提示），不再连坐下游三条。

**顺带修一处假红（判据把布局当契约）**：`scripts/ui-island-smoke.mjs` 的「设置贡献」体检读的是
`document.querySelectorAll('aside > div')` —— 而设置分类导航在本轮可访问性改造里已由 `div` 改成 `button`
（见上一条 Changed，"原先键盘不可达"），选择器**静默读到 0 个** ⇒ 报"分类没出来"，
而同一次探测里「识别」面板**已正常渲染**（`hasEngineForm=true`）。
改为钉**语义锚点** `[data-act="settings-cat"]` + `data-cat`（= **分类 id**，不是显示名），
并在 `SettingsModal.vue` 的导航按钮上补这两个属性（**只加属性，不动文本/class**）。
用变异复核过（把 `data-act` 改名）：**该断言确实变红**，即它不是恒绿。

**验证**：`tsc -p tsconfig.electron.json` / `npm run verify` / `npm run verify:docs` /
`vitest`（**33 files · 577 tests**）全绿；`plugins:island:smoke`（5 个岛握手 + 工具条文案体检 +「设置贡献」+ 重启恢复）、
`style:smoke`、`schema:smoke`、`order-profit:ui`、`goods:ui`、`today:ui`、`picking:ui`、`product:smoke`、
`shop:smoke`、`product:sku:smoke`、`order:smoke`、`ae:smoke`、`ae:settle:smoke`、`ship-rate:smoke`、
`shipping-rate:ui`、`order-insight:settings:ui`、`plugins:sandbox:smoke` 等 ALL PASS。
本轮只改宿主，**没有岛需要发版**（下架动作本身已含市场 push）。

**结论笔记**：[`docs/notes/2026-10-30-island-publish-and-retire.md`](docs/notes/2026-10-30-island-publish-and-retire.md)
（下架一个 UI 岛的可复核清单 · 「死能力域可删」的判据 · 陈旧选择器=把布局当契约）。

### Changed · 界面重做骨架：从"控件统一"进到"结构统一"（2026-10-01）

**背景**：上一轮把按钮/输入/标签收敛成同一套基座后，界面**仍然被评价为"还是很难看"**。
复盘发现病根不在控件而在**层次**：画布 `#f6f7f9` 与面板 `#ffffff` 只差约 2%（卡片边界读不出来）、
全仓**没有任何阴影尺度**、字号全挤在 12–13px、统计数字写成一句流水、空态是一行居中灰字飘在大片空白里。

**做了什么**：

- `src/styles/index.css`：画布反差 2% → 约 5%（`--wb-bg` `#f6f7f9`→`#eff1f5`，深色 `#15171c`→`#0f1115`）；
  新增**投影尺度** `--wb-elev-1/2/3`（刻意不叫 `--wb-shadow-sm`：存量 `--wb-shadow` 是*颜色*）
  与 `--wb-border-strong`（表头下沿等"要读得出来"的分隔）。
- 新增 **5 种结构骨架**（`@layer components`，模块可继续覆盖）：
  `.wb-page`（页面内边距/栅格）、`.wb-head`（页头：标题 + 描述 + 动作）、
  `.wb-metabar`/`.wb-metric`（指标条：标签 + 数字）、`.wb-panel`（带投影的白卡）、
  `.wb-empty`（空态四段：图标/标题/说明/动作）、`.wb-table`（统一表头/行高/悬浮/数字列）。
- 五个内建页全部套用新骨架，并各自补上**此前缺失的页头标题**（拣货页原先整页没有标题）：
  `today`（三张卡改为图标 + 大数字 + 提示条）、`goods`（统计条改指标条、两张表进面板）、
  `picking`（条件条独立成卡、空态改标准骨架）、`quick-note`（输入区/列表进面板）、
  `order-cost`（三张表各自进面板；分桶/缺口两条状态带与口径条分层）。
- `ToastHost` 重做：原先 success/error/info 是**整块全饱和底色**（一次弹 4 条 = 屏幕右下角一大片高饱和色块），
  改为白底卡片 + 左侧 3px 类型色条 + 类型图标。
- 顺带修一处可见缺陷：`OrderCostView` 明细表空态行的 `colspan` 是 15、而表头是 16 列（空表时右侧短一格）。
- 新增令牌同步进 `src/core/plugin/uiBridgeHost.ts` 的 `WB_THEME_TOKENS`（`tests/uiIslandThemeTokens.spec.ts` 双向校验）。

**⚠️ 视觉重构的硬约束（已入库 `docs/notes/2026-10-30-ui-style-and-hierarchy.md`）**：
UI 冒烟的断言判据是 `textContent` 子串，而 `textContent` **不给相邻元素插分隔符**
（实测输出 `产品 2SKU 3缺克重 1…`）；又因 Vue 编译器 `whitespace: 'condense'` 会删掉含换行的空白节点，
模板里的裸空格经 prettier 重排后可能消失。故本轮**只换 class、只加包裹层，所有文本节点逐字不动**。

**验证**：`vue-tsc` / `vitest`（33 files·597 tests）/ `build` / `verify` / `eslint` 全绿；
`today:ui`·`picking:ui`·`goods:ui`·`order-profit:ui`·`shipping-rate:ui`·`order-insight:settings:ui`·
`product:sku:ui`·`plugins:island:smoke` 八个冒烟 ALL PASS；另取浅色/深色两套共 8 张无头截图人工复核。
本轮只改宿主，**没有岛需要发版**。

### Changed · 界面样式盘点：补一层统一控件基座 + 全仓缺失的焦点态/减弱动效（2026-10-01）

**背景**：盘点`src/` 全部 17 个 `.vue` 后发现，**可见缺陷只有 3 处**，其余是"同一角色被写 5–6 遍" ——
同一个"次要按钮"在 5 个模块里各有一份局部类（`.td-btn` / `.gd-btn` / `.pk-btn` / `.oc-btn` / `.cr__btn` / `.rs-btn`），
高度 24/26/28、圆角 6/8/12、字号 12/13 各不相同，所以页面之间"不像一个软件"。

**做了什么**：

- `src/styles/index.css` 新增统一基座（放 `@layer components`，模块可继续覆盖）：
  `.wb-btn`（+`--primary/--danger/--ghost/--sm`、`:disabled`、`.is-on`/`aria-pressed`）、
  `.wb-tag`（+`is-on/is-warn`）、`.wb-input--sm`；新增圆角尺度 `--wb-radius-sm/md/lg`
  （`--wb-radius` 保留并指向 lg，存量调用点无需改动）。
- 把上述 6 个模块的局部按钮/标签/输入框类**收敛为"只留布局职责"**，样式交给基座；
  `PluginCenter` 的 `.sk-btn`、`UiIslandView` 的 `.ui-island-btn` 同样收敛。
- **补齐全仓此前完全缺失的三件事**：全局 `:focus-visible` 焦点环（原先 `src/` 下只有 4 处焦点样式，全在输入框上）、
  `@media (prefers-reduced-motion: reduce)` 兜底（原先 0 命中）、`body` 的 `background`/`color` 兜底。
- **修正两处不达 WCAG AA 的文字色**（实算对比度）：`--wb-text-muted` `#8a909a`→`#666d79`（3.2:1→4.8:1）、
  `--wb-success` `#16a34a`→`#15803d`（3.3:1→5.0:1）；新增语义色 `--wb-on-accent` 替代表头借用 `--wb-primary-contrast`。
- **输入框主题化改为排除法**：原按 `type` 列举漏了 `number` 与 `password`（正是克重/天数窗/温度/费率与 API Key 用的），
  深色主题下与相邻 text 输入框底色不同 —— 现新增 type 自动纳入。
- 可访问性：设置页分类导航 `div`→`button`（原先键盘不可达）、便签删除按钮补 `focus-visible`（原先 hover-only，键盘/触屏看不见却能点到）、
  toast 补 `role="status" aria-live`、命令面板补 `role="dialog"` + combobox/listbox 语义、产品表行补 hover 与键盘可达。
- **修复一处真·布局 bug**：`GoodsView` 的 `.gd-body`（`flex: 1` + `display: grid`）未写 `align-content`，
  隐式行按 `stretch` 撑满容器 ⇒ `<table>` 被拉高并把高度摊到各行，两行数据各被拉到 200+px（无头截图实证）。
- `index.html`：去掉硬编码 `bg-gray-100`（与 `--wb-bg` 差 2 级色阶），加同步脚本按 `prefers-color-scheme` 预置 `data-theme`
  —— 消除深色系统用户每次启动的一帧白闪。
- `RecognitionSettings` 模板中一处字面 Markdown（`**…**`）会原样显示星号，已去掉。
- `uiBridgeHost.ts` 的 `WB_THEME_TOKENS` 同步新增令牌（`tests/uiIslandThemeTokens.spec.ts` 双向守卫）。

**未做（有意）**：没有把正文提到 16px（桌面高密度工具，13px 是既有事实标准；只把低于可读下限的 11px 提到 12px）；
没有改 `ui-plugins/` 下任何一个岛（岛有独立样式表与令牌注入链路）。

**结论笔记**：`docs/notes/2026-10-30-ui-style-and-hierarchy.md`（含两条可复用判据：`flex:1` 的 grid 放 `<table>` 必须
`align-content: start`；无头截图器 = 假桥冒烟脚本把 `--dump-dom` 换成 `--screenshot`）。

**顺带修的假失败**：`tests/uxEntryNames.spec.ts` 读 `src/` 整棵树，全量并发时超默认 5s 超时
（报 `Test timed out in 5000ms`，不是断言失败）→ 按既有先例加 `{ timeout: 20000 }`。

**验证**：`vue-tsc` / `vitest`（33 files · 597 tests）/ `build` / `verify` / `verify:docs` / eslint 全绿；
`goods:ui` · `today:ui` · `picking:ui` · `order-profit:ui` · `order-insight:settings:ui` 五个假桥冒烟 ALL PASS；
另存三张无头截图人工复核（表格行高修复前后、toast 栈、宿主设置弹窗）。

### Fixed · 插件市场恢复可用：6 个 UI 岛重新发布（2026-09-30）

**背景**：UX 审查第二轮指出"重构成果一个都没发布 + 线上市场装不上东西"。本轮把发布链跑通。

**做了什么**：

- 用正确的 `--base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main` 重跑 `scripts/publish-plugin.js`，
  覆盖全部 6 个 UI 岛：
  - **新增版本**：`order-insight 1.5.0`、`shipping-rate 1.3.0`、`ae-profit 1.1.0`（仓库版本早已升好，此前只差发布）；
  - **补齐**：`excel-copy 1.0.0`、`product-library 1.5.0`、`shop-accounts 1.5.2`（此前**从未进过市场仓库**，幂等重发布，产物字节不变）。
- 修正 `catalog.json` 里三类不可用 `downloadUrl`：`<BASE_URL>/…`（非 http → 宿主**静默丢弃**）、`http://127.0.0.1:8000/…`（回环地址，用户必失败）。
  现在 6 条的 URL **全部是绝对 https 且非回环**，逐条 sha256 已写入目录。
- **提交并推送到市场仓库** `SayakABC/SellerKitPlugin`：`3831453..d37367a`（此前 HEAD 只跟踪 `ae-profit 1.0.0/1.0.1` 两个 zip，
  `market-out/` 里的 1.x 产物从未 push —— 这是"市场装不上东西"的直接原因）。

**注意（后续动作）**：

- **发布 ≠ 本机生效**。本机 `~/Library/Application Support/seller-kit/plugins/` 里仍是旧版；要在「插件中心」点更新并**重启宿主**。
- `market-out/` 是市场仓库的工作树，且被父仓库 `.gitignore` 忽略 —— 它**不在 SellerKit 的 git 里**，改动只靠 push 出去，别指望父仓库保底。
- `raw.githubusercontent.com` 有 CDN 缓存（约 5 分钟内可能仍返回旧目录）。

### Added · 用户体验审查第二轮（重构后复查）：`docs/reviews/UX_REVIEW_2026-09-30-R2.md`

**为什么还要审一遍**：S1–S3 把宿主侧改了（默认包自洽 + 「今天」首页 + 统一导入 + 薄内建「货与成本」+「算钱」更名），
第一轮的结论有一半已经作废；而且**第一轮只读了仓库源码**，没有对照过"用户实际会运行到的那两份东西"。

**本轮新做的取证（与第一轮最大的差别）**：

- **跑了**四个宿主页的假桥无头冒烟（`today:ui` / `goods:ui` / `order-profit:ui` / `picking:ui`）—— **全绿**，
  含"空态按钮真派发 `switch-module`""统一导入真解析真落库""改克重真带全字段提交"等 100+ 条断言。
- **实测了平台行为**：起一个隐藏 Electron 窗口执行 `window.prompt()`，实测 `threw: prompt() is not supported.`
  ⇒ 订单归类岛「待拿货缺口 → 忽略」这条功能在真机上**必然报错**（`ui-plugins/order-insight/dist/views/stockin.js:950`）。
- **对照了用户实际拿到的版本**：`ui-plugins/*/manifest.json` ↔ 本机 `~/Library/Application Support/seller-kit/plugins/*`
  ↔ 线上 `catalog.json`。结论（本轮最重的一条）：
  - **重构成果一个都没发布** —— `order-insight` 仓库 1.5.0 / 市场 1.3.0 / 本机 1.3.0；`shipping-rate` 1.3.0 / 1.2.1 / 1.2.1；
    `ae-profit` 1.1.0 / 1.0.1 / 1.0.2。用户看不到任何重构后的岛界面。
  - **市场当前装不上东西** —— 线上目录只有 3 条：`shop-accounts` 的 URL 是 `<BASE_URL>/…`（非 http，被
    `electron/plugins-market-handlers.ts:56` **静默丢弃**）、`order-insight` 指向 `http://127.0.0.1:8000/…`（必然下载失败）、
    `shipping-rate` / `excel-copy` / `product-library` **完全缺席**。
  ⇒ `UX_POLISH_PLAN.md` 的 `P1-1 首启引导（一键装齐）`**前置条件不存在**，先修市场才有意义。

**其余新发现**：首页卡③标出"运价表 没有"却**没有任何可点动作**（而宿主已能导报价单）；「算钱」仍把人指向那个装不上的岛；
订单归类「导入与识别」与「导入设置」**两处都能改同一份列映射**；供应商维护**指路成环**（A→B→A）；
岛侧 12+ 处弱空态、6 处删除**无确认**、2 处**覆盖式导入无确认**（整表替换运价表/重量表）；默认包仍留「便签」且两模块 `order` 撞号。

**净结果**：第一轮 26 条 → **8 条已解 / 8 条部分 / 10 条仍在**，仍在的**几乎全在岛侧**（岛侧改一次 = 一次发版）。

**文档**：`docs/README.md` 加索引行 + 「要评估体验」推荐路径改指本份 + 计数第 3 次订正（34 → 实测 38）。

**未做（如实标注）**：未起真实宿主 + 真库走完整链路；岛侧结论来自静态通读 + 6 条抽验，未覆盖焦点顺序/滚动性能。

## [Unreleased]

### Fixed · 在「货与成本」补了 SKU 克重，「算钱」却毫无变化（用户实报）

**现象**：在「货与成本」里改 SKU 克重并保存后，产品列表的「缺克重」列显示 **「—」**，「算钱」里也完全没生效。
**实测（只读探针扒本机库）**：保存**是成功的**（`pl_variants` 5 行全部有克重，`updated_at` 就是刚才），
`pl_item_weights`（**算钱真正读的那张表**）**0 行**。于是两个问题各自坐实：

1. **「—」是渲染错了**（不是没保存）：那列写的是 `missingOf(p.id) || '—'` —— 0 被渲染成「—」，
   而「—」在表格里是"没有数据"的通用写法，用户读成"没生效"。⇒ 现在 0 就写 `0`（>0 才转警示色）。
2. **算钱根本不看 SKU 克重**：算钱的运费只认「商品ID 克重」（`pl_item_weights`，来自**商品信息 Excel**），
   而用户在「货与成本」补的是**产品库 SKU 克重**（`pl_variants.weight_g`）—— 两张表、两种粒度、两条链，
   补完算钱自然没反应。⇒ **现在按款色码回落**（见下）。

**修的（宿主加法，不改表、不发版）**：

- `src/lib/orderCost.ts` 新增**单源**判定 `resolveWeightG(row, weights, skuWeights)`：
  **商品ID 克重优先**（它是这件货的实称）→ 缺了按**款色码**（新导出的 `skuWeightKey`：款编码 trim+大写 / 色 / 码，
  用 `\u0001` 分隔）回落产品库 SKU 克重 → 两处都没有才算缺。
  行上新增 `weightSource`（`item` / `sku` / null），界面**如实标出来源**（别让用户以为商品ID 克重本来就有）。
- 「算钱」页：多取两路（`productList` + `productVariantList`，**零新通道零新 op**）建款色码 → SKU 克重；
  明细表「克重」列加了悬停说明（"来自商品信息 Excel" / "商品ID 克重没有 → 按款/色/码回落…"）。
- 「今天」页的缺口卡：**同一份判定**（`resolveWeightG`），并顺手修了它的**计数口径错误** ——
  原来数的是"唯一商品ID 里缺重量的个数"却标着「**行**」，现在按**行**计，与「算钱」同数（同一批订单不再出现两个缺口数字）。
- 「货与成本」页的「缺克重」列：0 就写 0。

**验证**：`tests/orderCost.spec.ts` **+4 例**（键归一 / 回落生效并标 `sku` / 两处都有时商品ID 优先 / 对不上款时照旧缺，不静默套别的款）；
`order-profit:ui` **60 → 64 项**（新增回落接线 + 商品ID 优先 + 「缺」列回到「齐」的逐行断言）；
`today:ui` **23 → 26 项**（缺克重按行计 + 回落生效 + 无数据时不催人）；
`goods:ui` **10 → 12 项**（0 不再渲染成「—」）。

> 注：这只是"**读**侧对齐" —— 两处重量的**来源**仍是两条链（订单侧按商品ID / 产品侧按 SKU）。
> 「导入商品信息时同时填两处」（M4 的另一半）仍未做。

## [Unreleased]

### Changed · C3 完成：删掉 `extensions/` 留档源码包，并收口它占着的四处耦合

**删的**（你执行 `rm -rf extensions/order-insight extensions/excel-copy`）：两个**下记留档**的 Vue 版视图插件包，
共 33 个文件 —— 它们是"多套实现"的源头之一（算法早已在内建 `src/lib` / 岛 `dist` / 宿主 op 各有落地），
且一直占着 `tsconfig` / `eslint` 的覆盖范围。空掉的 `extensions/` 目录也一并移除（机制保留，要用再建）。

**收口（我做的，一处不漏）**：

- `tsconfig.json` 三条 `extensions/**` include；`eslint.config.mjs` 的 `extensions/**` files 覆盖（+ 两处注释、覆盖范围说明）。
  ⇒ lint 警告 **473 → 443**（少掉的全是留档包里的存量 any），0 error。
- `src/types.ts` 的 **`AppState`** 类型 + 那段"随 C3 删"的注释 —— 它只为留档包存在（旧扁平存储的数据形状，通道早已删）。
- 措辞改成真话：`AGENTS.md`（§1.2 目录树 / §1.8 / §1.9 判定表 / §4.3 禁改项说明 / §5 SOP / §6.1）与
  `PROJECT_BASELINE.md`（§2 目录表 + 「已知目录语义冲突」段 / §3 规模表 / §4 下记说明 / §6 设置贡献表）——
  一律写明「**机制保留、目录当前不存在**」，并保留"将来重建时怎么判定"的留档依据。
- 文档引用：**18 处「src 下的 meta 入口」那种带前缀写法统一改成裸名 `meta.ts`**（它本是"包内 src 下的 meta 入口"这个**判定标志**的写法，
  之前靠"后缀匹配"蒙中已删的留档文件；改成裸名后不再当路径解析 —— **比把它塞进豁免表好**：豁免是按 token 全局生效的，
  塞进去会让守卫对真悬空的 `src/**` 路径也瞎掉）。
- 7 处**历史记录**（`docs/reviews/**` 与 `CHANGELOG` 里"当时路径"）进 `check-doc-links.mjs` 豁免表，逐条写明是「C3 删除记录」。
- 顺手做**第五次全量重扫**：基线 §3 的目录规模（`src/` 92 文件 20,538 行 · `electron/` 45/18,539 · `ui-plugins/` 53/16,128 ·
  `scripts/` 40/10,603 · 合计 **230 / 65,808**）、各岛规模与 Top-10 大文件全部对齐实测。

**验证**：`npx vue-tsc --noEmit`（关键：`AppState` 删掉后全仓无引用）· `tsc -p tsconfig.electron.json` · `npm run lint`（0 error）
· `vitest` **33 文件 / 597 例** · `npm run verify` 188/184 · `npm run verify:docs` 无悬空引用 · `npm run build` 通过。

## [Unreleased]

### Changed · C8：删掉 `Support/`（一份过期的岛快照）

`Support/` 是仓库根下一个零引用目录，实测内容 = **2026-09-28 的 `shipping-rate` 岛 `dist/` 快照**
（`Support/seller-kit/plugins/shipping-rate/dist`，12 个文件）—— 与仓库现版逐文件比对有 6 处差异 ⇒ **是更旧的副本，无独有内容**，
与 `market-out/`（发布产物）职责重叠。删除后 `npm run verify:docs` 无悬空引用（它本就不在任何文档/代码的引用链里）。

> 结论：**它不是"用户数据"也不是"构建输入"**，删掉不丢东西。将来若还要模拟"插件目录长什么样"，直接用
> `scripts/publish-plugin.js` 产出的 zip 解压，或把 `ui-plugins/<id>/` 拷进一个临时 userData。

## [Unreleased]

### Changed · C9' 前置：历史采集单**回填主干**（`order.main` v4 迁移）

**问题**：C1 之后只有**新采集**的订单写主干（`oi_orders`），而 C1 **之前**采到的单只存在于老采集表
（`ae_orders` / `ae_order_lines`）—— 界面只读主干，于是那批单**看不见了**（本机实测 **101 单**）。
所以"删表（C9'）"不能直接做：先得把数据搬进去，否则删表就是真丢数据。

**做的（走"先迁移、暂不删表"，加法）**：`order.main` 迁移链加 **v4 = 历史采集单回填**：

- 读老表（表不存在就整步跳过 —— 新库无事可做），按 `source='collect'` 写入主干；
  口径**复用实时采集同一组原语**（`electron/aeMoney.ts` 的 `orderIncomeCcy` / `toCentsCny` / `parseSkuProps` +
  `upsertCollectedOrder`）—— 不另写一遍算式（两份口径必然漂移）。
- **保真**：原帧整段进 `raw_fields.采集帧`（与实时采集同一个键名）；另加 `__migratedFrom='ae_orders'`
  **可回滚标记**（撤迁移：按该标记删这批行）。
- **不迁 `ae_fees`**：费用侧的真值源是结算明细（`ae_settle_lines`），主干模型里也没有费用科目列。
- **幂等**：`upsertCollectedOrder` 先删后插（按 order_no + source），迁移重入不翻倍；版本记账再兜一层。
- **老表原样保留**：回填是加法，删表留到你发版之后单独做。

**验证**：`npm run schema:smoke` 新增**场景 [E] 6 项**（回填落位 / 金额按汇率折 CNY 分 / 行级明细与颜色尺码 /
原帧保真 + 可回滚标记 / 幂等不翻倍 / 老表原样保留），冒烟总数 **21 → 30 项**；
场景 [C] 的"版本推进到 3"同步改为 **4**（并注明本场景没有 ae_orders → v4 是空操作但仍记账）。

**文档**：`PROJECT_BASELINE.md` §6「schema 演进」（`order.main` = **v4**）+ §7 冒烟清单；`RESTRUCTURE_PLAN.md` C9'。

## [Unreleased]

### Changed · C4 收编：「识别引擎 + API Key」搬进宿主「设置 › 识别」（走"宿主自有设置也能贡献"）

**问题（UX 审查 M7）**：视觉识别引擎与 API Key 是**全局基础设施**，却只存在于「订单归类」这个**可卸载/可停用**的岛里
—— 一卸载就"设置找不到"；ADR-001 那条"设置留在岛内"的例外本该只管"改完要立刻看预览"的**映射类**。

**机制（关键：`SettingsModal` 一行都没改）**：`AGENTS.md` §1.5 要求"基础分类固定两个，其余一律由贡献生成、不得硬编码"。
所以 `vite.config.ts` 的 `settingsPanelLoaders` 多了一个来源 —— **宿主自有**的 `src/core/settings/panels.ts`（键 `core`，不是模块 id、不可被停用）：

- 新增宿主「**设置 › 识别**」面板：服务商 / 模型 / 接口地址 / 温度 + API Key（写宿主机密存储，只写不读、不回显）。
  存储**与岛同一命名空间同一键**（`modules.order-insight.engine` / `orderApiKeySet`）—— 两边互通、不会各写一份；
  页内写明"列映射 / 本次导入店铺留在岛上"，并说明理由（ADR-001）。
- 岛侧同批：岛内设置视图（`settings.js`）删掉引擎与密钥两个面板、页签由**「识别设置」改名「导入设置」**（只留列映射 + 本次导入店铺），
  `api.js` 删掉 `saveEngine` / `setApiKey`（`loadEngine` 保留：识别时仍要读引擎），manifest 动作 57 → 55。
- 判据写进 `AGENTS.md` §1.5：**"改完要不要立刻看数据变化"决定它在哪，不是"原来在哪"**。

**新增自动化**：`npm run order-insight:settings:ui`（**新脚本**，手写岛原本无任何冒烟）9 项 ——
岛挂载（7 页签、拣货页签已撤）· 页签名已改 · 列映射从岛配置读出 · **页签里没有引擎/密钥表单了**且指路宿主设置 ·
点保存真的合并写回（5 列 + 固定店铺，且**不覆盖 `engine` 键**）。
真机 `plugins:island:smoke` 加**「设置贡献」段**（dispatch `open-settings → recognition`，断言分类可达 + 面板渲染）。

**文档**：`PROJECT_BASELINE.md` §6 新增「设置页分类」清单（AGENTS §1.5 一直指向它却没有 —— 现补齐）+ §7 冒烟清单两条；
`RESTRUCTURE_PLAN.md` C4/S4；`AGENTS.md` §1.5 表 + §1.2 目录树 + §6 命令。

## [Unreleased]

### Changed · P0 文案与可达性（UX_POLISH_PLAN 的 P0-2 / P0-4 / P0-5）

**P0-2 · 岛工具条去调试化**（UX 审查 Top-10 第 4 条：业务页顶部挂着插件运行时调试台）：

- 「← 返回」改为回**上一次所在的模块**（复用外壳已有的 `backId`；旧写法固定回退"首个非岛模块"，
  点返回却跳到用户没去过的地方 —— 审查 C1）。没有来源时仍回首个非岛模块兜底。
- 状态行说人话：`等待桥握手…`（还带"越权调用由宿主权限门拒绝并审计"）→ **「正在连接… / 已连接 / 未能连接」**。
- **握手失败可见**：8s 内没等到带 token 的回执 → 状态行变「未能连接 —— 点此重试」（点它即重载）。
  旧实现失败与"正在连"长得一样（一个不变的灰点），用户无从自助（审查 D1）。
- 「宿主→岛事件」+ 插件 id 收进**默认收起的「诊断」**区；「重新加载」留在外面。

**P0-4 · 插件中心可达性与人话**（Top-10 第 2、10 条）：

- 「账户与设置」菜单加一级 **「插件中心」**直达（业务功能全是插件，安装/更新原来埋在 设置 › 插件 › 市场 三层里）。
- 安装/更新后派发 `reload-island`：外壳**只在"正是当前打开的那个岛"**时调它的 `reload()`
  （iframe 文档挂载时就加载好了，不重载则用户看到旧界面并判成"没装成功"）；toast 也就此说实话。
- 来源徽标 `外置 · 视图` / `外置 · L2` / `扩展包 · L0` / `内建 · L0` → **「从市场安装」/「随应用附带」**，
  内部术语全部进 tooltip；顺手去掉并列的 `Worker 沙箱` / `iframe 岛` 两个技术小标签。
- 能力标签 `db` / `storage` … → **「读写业务数据」/「保存本插件设置」/…**（原始能力名进 tooltip）；
  未声明时改成人话（外部插件：「未声明任何能力（需要数据的功能会被拒绝）」）。

**P0-5 · 文案纪律成文**：`AGENTS.md` 新增 **§1.10「用户可见文案纪律」** —— 禁用族表
（能力域/表名/op 名 · 进程与协议名 宿主/桥/iframe/CSP/realm/token · 内部分级 L0/L2 · 主键 ID · 悬空功能名）、
改写方向（能力/来源/状态说人话 + 空态三段式）、**守卫落在哪一层**的取舍（真机冒烟读 `innerText` 优先；
源码正则只钉结构性事实），以及权限明细那一列**刻意保留技术细目**的例外。

**P0-6 · 守卫改落在真机冒烟**：`npm run plugins:island:smoke` 新增**工具条文案体检** —— 逐岛读宿主
`.ui-island-bar` 的可见文本，断言无上述禁用词、状态行为「已连接」；因为折叠区天然不在 `innerText` 里，
"调试入口必须默认收起"这条也被同一条断言顺手守住。（原计划是新写一个源码扫描测试；实测取舍见 §1.10。）
岛名悬空那条（`「X」` 必须在某个岛的 displayName 里）**未做** —— 需先收窄白名单，否则误报会淹掉真信号。

**P0-3 · 空态给可点的下一步**（三处，都是"功能变了、指路没变"）：

- 「算钱」空态不再让用户"先去「订单归类」导入"（那个岛是市场插件、可能还没装；S2-b 起宿主自己能导订单报表），
  改为指到宿主自己的入口 + 按钮「去「今天」导入」（派发 `switch-module → today`）。
- 「今天」首页「还没有订单数据」的主按钮原为**「去打开「订单归类」」**（同样是把人送去装插件），改为宿主自己的
  **「导入 Excel」**；「订单归类」降级为一行说明（想做 AI 款式/颜色识别才需要它）。
- 「拣货」空态**分两态**（`generated` 标记）：还没生成过 → 引导点生成；生成过但为空 → **说清为什么空**
  （`scanned>0`：扫了 N 行、被「已终结 / 超窗」排除，并给放宽办法；`scanned=0`：一行都没扫到 → 指向导入入口 + 按钮）。

**P0-6 · 悬空入口名守卫**：新增 `tests/uxEntryNames.spec.ts` —— 扫宿主文案里"去 / 在 / 到「X」"式引用，
断言每个引号名都是真实入口（宿主模块名 ∪ 岛 `displayName` ∪ `ALLOWED_NON_ENTRY` 里逐条写明理由的控件名）。
扫描前**剥注释**、并**自证非空转**（零命中即失败）。两条变异实跑：把名字改回历史的「运费测算」→ 红；
把扫描模式写坏 → 命中空转自检。

**P0-7 · 过时文档标注**：`docs/guides/USER_GUIDE.md` 顶部加醒目提示 —— 它描述的是「TV模版」一个功能的旧界面，不是当前产品全貌（现在的形态是"今天 / 订单 / 货与成本 / 运费 / 算钱 / 设置"的工作台 + 插件），照它找界面对不上属已知；并指向重写待办（`UX_POLISH_PLAN` §4-UX-P3）。`docs/README.md` 的「终端用户」行此前已带 ⚠️。

**顺带·外壳事件名收敛**：新增 `src/core/services/shell.ts`（`switchModule` / `openSettings` / `reloadIsland`），
把原先散在 5 处的 `new CustomEvent('switch-module'|'open-settings'|'reload-island')` 字面量收敛成唯一出处 ——
事件名写错是**静默**失败（没人接 = "点了没反应"），这类字符串协议只该有一份。

**验证**：`order-profit:ui` **60 项** · `today:ui` **23 项**（原 21，新增空态两条）· `picking:ui` **28 项**（原 25，新增两态空态三条）
· `goods:ui` 通过 · `npm run plugins:island:smoke` 真机 6/6 + 工具条文案体检 · vitest **33 文件 / 597 例**（+`uxEntryNames` 2 例）
· 两处 tsc、lint 0 error、`verify`、`verify:docs`。

## [Unreleased]

### Changed · C2（S5）：撤销 order-insight 岛的「拣货」页签 —— 拣货只留一个入口

**问题**：拣货有**两个入口** —— 内建侧栏模块 `src/modules/picking`（P4 产物）与 order-insight 岛的「拣货」页签（P5 产物）。
数据口径本来就只有一份（宿主 `DB_OPS.picking.groups` 里 `await import('@/lib/picking')`，与内建页同一份纯函数），
但**入口重复**会让用户不知道以哪个为准 —— 违背「入口唯一」铁律。用户已倾向保留宿主模块（`RESTRUCTURE_PLAN` 的 UX-G3）。

**删除清单**（岛侧 + 宿主侧 + 守卫，一处不留）：

- 岛：`ui-plugins/order-insight/dist/views/picking.js`、`main.js` 的注册、`api.js` 的 `picking` 助手、
  `manifest.json` 的 `picking` 域与 `groups` 动作（域 3 → 2、动作 57 → 56）。
- 宿主：`src/core/plugin/host.ts` 的 **`DB_OPS.picking` 整块**。理由：它唯一的消费者是那个页签，
  删掉后就是**零消费者的能力域**（死物）—— 拣货是主干内建功能，内建页走 `ipc.pickingRows` + `@/lib/picking`，
  不需要岛侧通道。将来真有岛要消费，照 `docs/notes/2026-10-30-island-host-boundary.md` 再开回来（~20 行）。
- 守卫/冒烟：`tests/orderInsightPicking.spec.ts`（11 例）、`scripts/order-insight-picking-ui-smoke.mjs`、`npm run order-insight:picking:ui`。

**版本说明（重要）**：order-insight 的 **1.4.0 / 1.5.0 都从未发布**（`market-out/` 里最新 zip 是 1.3.0，本机装的是 1.3.0），
所以这次是"**发布前撤回**"，不构成"已发布又收回"。`manifest.version` 保持 **1.5.0**，只把描述里那两句拣货说明改成撤回说明。
⚠️ **若你已在别处（GitHub 市场 / 自建服务器）发过 1.4.0 或 1.5.0，请改发 1.5.1** —— 否则"同版本换内容"会让已装机器判定为无需更新。

**验证**：`vitest` **33 文件 / 606 例 → 32 / 595**；`pluginTriage`（双向守卫）与 `pluginManifest` 通过；
`npm run plugins:island:smoke`（逐岛点开 + 握手 + 重启恢复）通过 —— 岛少一个页签后仍能正常挂载切换。

**文档**：`PROJECT_BASELINE.md` §3 岛规模、§4 岛清单与能力、§7 冒烟清单、§10 测试清单与用例数；
`AGENTS.md` §6 的命令清单（顺带补上漏记的 `goods:ui` 与新脚本）；`RESTRUCTURE_PLAN.md` M3/C2 行；
`PICKING_PLAN.md` P5 行与 §3.3；`UX_POLISH_PLAN.md` P0-3 与验证套路；两条 `docs/notes/` 的取证同步订正。

## [Unreleased]

### Changed · M6（S4）：运价表**回迁宿主**，`shipping-rate` 岛不再存表也不再回传

**问题（ADR-002 C3 已知债）**：运价表真源在**可卸载的岛私有 storage** —— 宿主 op `quote` /
`quoteOrders` / `quoteProducts` 每次靠岛把**整张表**传进来（`host.ts` 原注释："运价表仍由岛传入"）。
后果：那是"真源在岛"；岛一卸载或两份不等，同一批订单在「运费」岛与「算钱」页会出两个数。
而且"只留当前一份"让历史订单的运费随报价单更新而变、不可复算。

**宿主侧**：

- `DB_OPS['shipping-rate']` 的 `quote` / `quoteOrders` / `quoteProducts` **移除 `table` 参数**，改为统一走
  新增的 `requireRateTable()` —— 从宿主快照表 `sr_rate_snapshots` 取"当前那份"（生效日倒序第一条）；
  没有快照时报一句人能看懂的话（"还没有运价表：先在「无忧物流运费」导入一次报价单"），**不静默用空表算**。
- 新增两个 op：`rateCurrent`（岛侧显示用的只读副本，含来源文件/工作表/生效日）与
  `rateAdopt`（**一次性迁移**口，把旧表交给宿主快照，按内容 sha256 去重）。域内 op 6 → 8（N5 ≤10）。

**岛侧（需发版，1.2.1 → 1.3.0）**：

- `store.js`：`collect()` 不再落 `table` / `source`；新增 `syncTableFromHost()` ——
  首启取宿主当前表，**若宿主还没有而岛内存有旧表则迁移一次**（`rateAdopt`）并把本地副本显式写 `null` 抹掉；
  导入/换表后改为"宿主已留档 → 岛取回当前那份渲染"。
- `api.js`：`quote(grams, opts)` / `quoteOrders(opts)` / `quoteProducts(country, opts)` **去掉 table 形参**。
- 「清空运价表」**下线**：运价表现在是按生效日留档的历史快照（「算钱」按订单日期取"当时那份"复算），
  一次抹掉所有快照的语义不再成立；错表重导正确的那张即可。
- 「运价来源」面板改显示宿主给回的**生效日**（原先显示本地导入时间）。

**读回退留一个版本期**：渲染层「算钱」页第 4 路仍保留"无快照 → 读岛命名空间"的回落，
只覆盖"老库且还没打开过运费岛"这一种情况（该岛首启会迁移），到期后与岛内存量键一起删。

**验证（新增自动化）**：`npm run shipping-rate:ui`（**新脚本**，`scripts/shipping-rate-ui-smoke.mjs`）——
假桥无头冒烟跑**两个来回**共 19 项断言：① 冷启动无表 → 空态、不发生迁移、不去计价；
② 岛内有旧表 → `rateAdopt` 带着整张表与来源、随后抹掉本地副本、取回并渲染、**计价 payload 里没有 `table`**、
按订单/按产品试算同样不带表。另 `npm run ship-rate:smoke`（DB 层）复跑通过。

**文档**：`PROJECT_BASELINE.md` §3 岛规模、§4 岛清单（1.3.0 + 能力）、§6 命名空间（岛内不再有运价表）；
`RESTRUCTURE_PLAN.md` M6 行；`BUSINESS_GAP_ANALYSIS` F0-3 标注已做；`ui-plugins/shipping-rate/README.md`（§2 配置键 + 首屏说明）。

## [Unreleased]

### Changed · C9 收编：「成本与汇率」并入宿主「算钱」，`ae-profit` 岛缩为采集接收端

**问题**：同一个数在两处各有一个入口 —— 岛有「利润统计 / 订单明细 / 成本与汇率」，宿主「算钱」页有预测/精准两轨 + 明细 + 趋势。
数据（`oi_orders` 主干）在 C1 之后已经是**同一份**，界面却是两套 —— 违背「入口唯一」。

**宿主侧（新增，零发版）**：「算钱」页末尾加**数据基础：成本与汇率**区（`CostRatesSection.vue`）：

- 款级成本表**只读浏览**（款编码 / 款名 / 单价 / 样本数 / 生效日 / 来源 / 更新时间；同一款多段区间按 `款|生效日|来源` 分行）；
  来源是拿货对账 —— **落账即自动同步**（S3 的 `purchase-cost-sync`），所以这里刻意**不给**"手点导入"按钮（给了就会出现两份成本）；
- 币种汇率**可改可加**（`ae_rates` upsert）—— 外币订单整单靠它折算，缺汇率 → 该单不进利润合计（不是按 0 算）；
- **默认收起**：有"缺成本"的行出现时自动摊开（它正是此刻要补的东西），消失后不自动收起（不打扰正在改汇率的用户）。
- 顺手修掉一处悬空文案：空运价表提示的「运费测算」→ 真实入口名「无忧物流运费」（UX 审查 C4，全仓已零命中）。

**岛侧（需发版）**：`ae-profit` 删掉三个页签与对应三个面板组件（`ProfitStatsPanel` / `OrderListPanel` / `CostRatesPanel`）
与 `format.ts`，只留**接收端状态 + 接入方式**（在线状态 / 端口 / 最近入库 / 最近错误 / curl 样例），
并加一段"数据与利润看哪里"的指引（指向「算钱」「拣货」）。

- `manifest.json` **1.0.2 → 1.1.0**、`displayName` 改为**「订单采集（UI 岛）」**（它不再追踪利润，名字得说实话）；
  `storage` 与 `purchase` 域退场，`db.actions` 收敛为 `ensure` / `receiverStatus`（`tests/pluginTriage.spec.ts` 双向守卫：
  声明了不调用、调用了没声明都红）；`storage` 命名空间 `ae-profit` 随之退场（旧数据留在 `config.json`，无人读写）。
- 岛源码 `src/` **9 文件 1,776 行 → 5 文件 466 行**。

**为什么先做宿主侧**：岛一旦先瘦身而宿主还没接手，用户就**没有地方**维护汇率了 —— 加法先落地、减法再发版。

**未做（等你发版后）**：删 `ae_orders` / `ae_order_lines` / `ae_fees`（C9'，前置就是这次收编；本机有 101 条历史采集单，
删除前会先跟你确认要迁移还是清掉）。

**验证**：`order-profit:ui` 假桥无头冒烟 **52 → 58 项**（新增：默认收起 / 缺成本时自动展开 / 成本表列出的值 /
改汇率真的发出 upsert / 新增币种码归一大写）；`vitest` 606 例绿；两处 tsc、lint（0 error）、`verify`、`verify:docs` 全绿。

## [Unreleased]

### Changed · S6（宿主侧）：旧扁平存储契约退场 + 调试脚本清理

**C6 — `get-store` / `set-store` 四处退场**（渲染层早已无调用方，契约却还挂在 `preload.ts` /
`src/types.ts` / `src/core/services/ipc.ts` / `electron/main.ts` 四处）：
IPC 契约 **190/186 → 188/184**、`main` 注册 **15 → 13**（`verify` 会指出漏处，删净后自洽）。
`reset-store` **保留**（`SettingsModal.vue` 的「恢复出厂设置」在用）。
⚠️ 旧形状类型 `AppState` 暂留并加注 —— 留档包 `extensions/excel-copy/src/store.ts` 还引用它，随 **C3**（删留档包）一起删。

**C7 — 一次性调试脚本清理**：删 `debug-name.js`、`scripts/debug-order-db.js`（硬编码本机路径、零引用）。

**仍待你执行**（工具侧策略拦不可逆删除，须你亲手跑）：
- **C3**：`rm -rf extensions/order-insight extensions/excel-copy` → 随后我删 `tsconfig.json` 的 3 行 include + `eslint.config.mjs` 的 `extensions/**` 覆盖 + `AppState` 类型；
- **C8**：`rm -rf Support/`。

**文档**：`PROJECT_BASELINE.md` §5 契约表（188/188/184、分布 `main 13`、演进轨迹末条）与 §10 门禁行同步；`docs/plans/RESTRUCTURE_PLAN.md` C3/C6/C7 与 §6 的 S6 进度同步。

## [Unreleased]

### Added · 付费授权方案（`docs/plans/PAID_LICENSE_PLAN.md`，仅出方案，未写功能代码）

**背景**：用户提出"要在本项目增加付费才能使用"。先出方案与选型，未改任何业务代码。

**决策**（2026-09-30 用户拍板四项）：收费客体 = **Pro 档功能**（不锁整个 App、不按岛收费）；计费 = **月 + 年双档订阅**；后端 = **零自建**（托管授权 API + 托管收银）；到期行为 = **降级为免费版**（Pro 能力不可调用，基础功能与数据照常）。

**方案要点** —— 三条工程事实决定了取舍：

1. 岛 = 预构建静态站点 + 本地明文文件（安装即解压落盘、宿主用只读特权协议原样喂给 iframe）⇒ **付费墙不可能靠"藏代码"**；
2. 判定必须落**主进程**，岛只能"问"不能自判 —— 与本项目「宿主 = 平台、岛 = 插件」同构，对齐 JetBrains Marketplace 的官方做法；
3. ASAR 是拼接归档非加密、asar integrity 双 fuse **默认关闭**、且 CVE-2025-55305（V8 heap snapshot 不在保护内）/ CVE-2024-46992（Windows 绕过）⇒ **客户端永远可被 patch**，目标是"抬高成本 + 让破解无收益"。

**三个执法闸门**（零新协议、**零新 db 域、不新增 op** ⇒ 不受 ADR-002 N5 的 op 预算约束）：

- ① 安装门 = `electron/plugins-market-handlers.ts` 的 `plugins-market-install`（可改签名一次性下载 URL）；
- ② 激活门 = `src/core/plugin/managerActivate.ts` / `pluginManager.ts`（岛与 L2 插件同轨）；
- ③ 调用门 = `src/core/plugin/host.ts` 的 `DB_OPS` 给 op 加 `requires` 声明 + `src/core/plugin/security.ts` 的 `decidePermission` —— 该判定是**纯函数**、entitlement 快照由调用方注入，可继续单测；与 ADR-002 的 C4 `domains` 判定**正交**，不动后者。

**顺带发现（安全隐患）**：`src/core/network/token.ts` 把会话态写在 localStorage（渲染层 DevTools 可读可改）。方案明确**授权态不得沿用该路线** —— 必须落主进程 + `safeStorage` / electron-store 加密，渲染层只拿只读快照。

**文档**：新增 `docs/plans/PAID_LICENSE_PLAN.md`（方案 + P0–P3 改动清单 + 门禁 + 风险合规 + 5 项待拍板）、新增结论笔记（2026-10-30 蒸馏时并入 `docs/notes/2026-10-30-electron-and-platform.md`）；并登记 `docs/README.md` 文档地图与「要做付费授权」阅读路径、`docs/notes/README.md` 索引、本文件。

**顺带订正文档漂移**：`docs/README.md` 与 `docs/baseline/PROJECT_BASELINE.md` §9 的 `docs/**` 计数原写 **27**，实测本轮改动前已为 **32**（本轮后 **34**）—— 计数未随文档增删同步。

## [Unreleased]

### Added · 跨 AI 工具协作契约（共享层 / 结论层 + 反向索引守卫）

**问题**：`AGENTS.md` 与 `docs/**` 随 git 共享，但各 AI 工具（WorkBuddy / Qoder / Hermes…）的会话记忆
各自留在本机私有目录 —— 换工具开工就丢掉门禁清单与踩过的坑；且**没有任何工具会自动回写共享层**。

**做的三件事**：

1. `AGENTS.md` 新增 **§0 跨工具协作契约**（放在文件最前 —— 该文件超长，注入给模型时常被截断，写在末尾等于没写）：
   共享层只有 `AGENTS.md` / `docs/**` / `CHANGELOG.md`，结论层是 `docs/notes/`，工具私有目录只是草稿；
   规定**收工两个动作**（`CHANGELOG.md` 记"做了什么"、`docs/notes/` 记"以后要记住什么"）与并发提醒。
2. 新建 **`docs/notes/`**（入库结论层）+ 首条笔记 `docs/notes/2026-09-30-cross-tool-context-sharing.md`：
   记录共享层 / 私有层拓扑、`AGENTS.local.md` 软链桥（Qoder 原生读它，等于能读到 WorkBuddy 的笔记）、
   以及"读侧通、写侧全断"这个核心缺口。
3. `scripts/check-doc-links.mjs` 增 **④ 反向守卫**：`docs/notes/*.md` 必须命名为 `YYYY-MM-DD-<slug>.md`
   且在 `AGENTS.md` / `CHANGELOG.md` / `docs/README.md` / `docs/notes/README.md` 之一被索引（未登记即 exit 1），
   并**自证非空转**（0 条笔记时打印"未验证任何内容"，而不是静默通过）。顺带把 `.workbuddy` / `.codebuddy` /
   `.qoder` 加入 `NON_REPO_HEADS`（与 `node_modules` 同理：按设计不在仓库内，否则新克隆的机器上引用它们的文档一律悬空）。

**顺带订正**：`PROJECT_BASELINE.md` 的 `docs/**` 计数 21 → **27**（实际值）；`docs/README.md` 文档地图补登
`notes/README.md` 与"换一个 AI 工具继续干活"阅读路径。

**⚠️ 顺带观测（并发写）**：本次作业期间（2026-09-30 10:22–10:23）`docs/README.md` 被外部进程写空后回退到
HEAD（v1.1.0）版本，未提交的索引更新（`CONTRIBUTING.md`、两份 ADR、`DOMAIN_INTEGRATION_PLAN` /
`PICKING_PLAN` / `SHIPPING_RATE_ISLAND_PLAN` / `UI_ISLAND_INTAKE_CHECKLIST` / `PRODUCT_LIBRARY` /
`UX_REVIEW_2026-09-30` / `UX_POLISH_PLAN` 等行）随之丢失。**同一工作区勿让两个 AI 工具同时写**（见 §0 末段）。

## [Unreleased]

### Changed · 清理：删掉确实无用的本地文件 + 修一条过期的冒烟断言

- 删除（均零引用）：`docs/features/__pp_probe.md`、`ui-plugins/product-library/__pp_probe.md`（0 字节探针残留）、
  `ui-plugins/product-library/vite.config.mjs.timestamp-*.mjs`（12 个，`.gitignore` 自认的 vite 临时文件）、
  桹目录与各子目录的 `.DS_Store`、空目录 `.hermes/skills/`、本会话自己写的 `tmp-probe-*.mjs` / `tmp-orders.xlsx`。
- 修正两处文档陈述：`docs/README.md` 里"含临时探针"的计数句；`PROJECT_BASELINE.md` 称
  `extensions/ae-profit/` 仍为"迁移残留"—— 该目录已于 `ad7471d` 删除。
- **修 `product:sku:ui`**：该冒烟断言"页签恰好 3 个"而岛 1.5.0 起是 **4 个**（新增「商品清单」）→
  整条冒烟在第一步就超时，看起来像"岛坏了"。现改为**不写死数量**：断言必需的四个页签都在 + 默认页签是「产品库」（冒烟 36 项全绿）。

## [Unreleased]

### Added · C9 第一步：「算钱」补上**时间趋势**（岛那两条视图从此真正冗余）

**为什么先做这个**：岛的「利润统计」有而内建页没有的**唯一**内容是**时间趋势** —— 不补上，岛就无法退役
（C9 + C9' 删 `ae_orders` 三表都卡在这一条）。

- 纯层 `trendOf(rows, 'month' | 'day')`：按 `orderTime` 归档，口径与汇总**完全一致**（**只统计非关闭单**）；
  日期认不出的行单独进 `(无日期)` 桶**并排最后**（不丢行、也不硬塞进某个时间点）。
- 页面：「时间趋势（只含非关闭单）」表，月/日切换；**预测毛利**与**精准毛利**分列（与上方统计表同一份口径）。
- ⚠️ 趋势表用独立 class（`oc-table--trend`）：与统计表共用 `oc-table--stats` 会让"统计区几行"这类既有断言
  **同时命中两张表**（实测把冒烟打红，已拆开）。

**验证**：`tests/orderCost.spec.ts` **69 例**（新增 4 例：按月归档只含非关闭单 · 按日 + `(无日期)` 排最后 · 精准轨单独计入 · 空输入）·
`npm run order-profit:ui` **52 项**（新增：趋势桶 = 2026-09 且收入/毛利与汇总一致 · 切「按日」桶变日期）·
606 例单测 · lint 0 error · verify 190/186 · verify:docs · 两侧 tsc · build 全绿。

## [Unreleased]

### Added · S2-b：**订单报表免图导入**（订单不再必须走岛）

**为什么是它**：`image_id` 是 `oi_orders` 的必填外键，而**订单报表根本没有主图列** ——
过去订单一律要经「订单归类」岛（带图 + 识别队列）才能进来，于是"想算钱得先装插件 + 有图"。
本轮把"无图订单"这条路打开：

- **全链放开可空**：`imageId` 在 handler / `OrderRecord` / 渲染层类型都允许 `null`；`autoAssignByMap` 对无图订单直接跳过
  （归款的落点是"把**图片**挂到款色上"，无图无从挂）。
- ⚠️ **幂等判重必须改 `IS ?`**：`WHERE image_id = NULL` 永远不成立 → 重导同一份报表会**不断插重复行**（幂等当场失效）。
  这条已写进 `order:smoke`（"免图订单重导不重复插"）。
- **统一导入入口接上真实落库**：`detectAndImport` 识别到订单报表后**直接导入主干**（不再叫用户去岛上导）——
  多产品行用**与岛同一份**纯函数 `orderRowSplitter` 拆行，其余 30 余列原样进 `raw_fields`（金额提列仍在主进程 `orderMoney`）。
- **店铺**：AE 导出按店铺、报表里没有店铺列 → 落空店铺，由「算钱」页的「归到该店」**一次**归好
  （页面已有「未归属 N 单」提示，不静默；导入结论里也写明这下一步）。
- 空态文案同步：订单来源②不再指向岛（四类文件都可以在顶栏「导入 Excel」导入）。

**验证**：`npm run order:smoke` **22 项**（新增：免图订单能落库且金额/状态照常提列 · **重导不重复插**）·
`npm run today:ui` **21 项**（新增：订单报表 → 多产品拆两行 · `imageId=null` · 订单号/时点进 payload · 结论带判据与下一步）·
602 例单测 · lint 0 error · verify 190/186 · verify:docs · 两侧 tsc · build 全绿。

## [Unreleased]

### Added · S3 界面侧：内建「货与成本」页（薄内建）+ 首页缺口卡**就地补齐**

**判据来自形态方案**（`RESTRUCTURE_PLAN` §3）：`货与成本` = **②薄内建 + 重手段留岛** ——
算钱要用的那 20%（款 / SKU / 克重 / 供应商）内建，批量编辑 / 商品清单导入 / 映射维护仍留「产品库」岛。
为什么克重必须内建：它是**运费两条链的输入**，藏在岛里就等于"想算钱得先装插件"。

- 新模块 `src/modules/goods`（显示名「货与成本」，侧栏排第 2：**今天 → 货与成本 → 算钱 → 拣货 → 便签**）。
  统计条（产品 / SKU / **缺克重** / **未关联厂家** / 已映射商品ID）+ 产品表（逐款 SKU 数与缺克重数）+ 选中款的 SKU 表。
- **就地改克重**：改完即存，缺克重计数实时归零，并给保存回执（不只是一闪而过的 toast）。
  ⚠️ `productVariantUpsert` 是**全量提交** —— 只传 `weightG` 会把该 SKU 的颜色/尺码/名称**静默清空**，
  所以页面把该行现有字段一起送回，且冒烟**钉住出参**（这正是"点击断言出参"要抓的那类错）。
- **零新 IPC**：全用既有 product 域通道（`productList` / `productVariantList` / `productVariantUpsert` / `productSkuSummary`）。
- **首页缺口卡就地补齐**：缺克重 → 「导入商品信息（补克重）」按钮（走 S2 的统一导入，自动识别类型）；
  缺成本/未识别款 → 「货与成本」入口；**克重齐时按钮不出现**（不催人）。

**验证**：`npm run goods:ui` **10 项**（新）· `npm run today:ui` **17 项**（+缺口卡就地入口）· 602 例单测 · lint 0 error · verify 190/186 · verify:docs · 两侧 tsc · build 全绿。

## [Unreleased]

### Changed · S3：**消掉两条"有数据但接不上"的断链**（拿货成本 / 商品克重）

**实测约束**（本机库普查）：`purchase_orders` 有 3 张而 `ae_cost_map` **0 行** · `pl_variants` 有 5 个而 `pl_item_weights` **0 行**。
两条链都不是"缺功能"，而是**要用户手动搬一次** —— 这正是本轮要消灭的那类摩擦。

- **① 拿货落账 → 成本自动同步**（新 `electron/purchase-cost-sync.ts`）：拿货单/付款的**每次写操作**之后自动跑一遍
  `costSnapshot() → ae_cost_map(source='purchase')`，`effective_from` 取该行拿货日期（历史订单毛利仍可复算）。
  - 用户不再需要知道"还有个成本要同步"；同步**只清 purchase 行**，手工改过的价（`source='manual'`）不受影响。
  - 同步失败**不影响落账**（单据已写成功，抛出去会让人以为没落）：只打日志，且**首页缺口卡会显示「缺成本 N 行」**（看得见）。
- **② 一次导入填两处克重**（`product-db.importItemWeights`）：导入商品信息时，**顺带把商品ID克重回填到该产品还没填的 SKU**
  （`pl_variants.weight_g <= 0` 才写，**绝不覆盖人工值** —— 与 D4b「默认不覆盖、显式才覆盖」同一纪律）。
  于是"按订单试算"（读商品ID克重）与"按产品试算"（读 SKU 克重）**同一次导入就都可用**；界面文案会带上"顺手回填了 N 个 SKU"。

**验证**：`npm run ae:smoke` **23 项**（新增：落账后成本表出现 purchase 行且生效日=拿货日期 · **同步不碰 manual 行**）·
`npm run product:smoke` 新增两项（**回填空 SKU 且人工值不动** · 无映射的商品ID不回填）· 602 例单测 · verify 190/186 · verify:docs · 两侧 tsc · build 全绿。

## [Unreleased]

### Changed · C1（**写侧 + 读口**）：采集通道改写主干，算钱/拣货只读**一个口**

- **采集入库改写主干**：`ae-db.upsertOrderBatch`（扩展推送的落库点）不再写 `ae_orders`/`ae_order_lines`/`ae_fees`，
  改调新的 `order-db.upsertCollectedOrder()` 写进 **`oi_orders`**（`source='collect'`、`image_id` 恒 NULL、每行一个商品）；
  金额折算放在这里（汇率属 ae 域）：整单收入 =（商品金额 + 买家付运费）× 汇率 × 100，**不扣退款**
  —— 退款/费用的真值源是「结算明细」，在订单侧再扣一次会得到两套净额口径（同一批货两个数）。
- **件数真值落行**：采集帧每行自带数量 → `oi_orders.qty`；规格串（`Picture color+XXXL+China Mainland`）解析出颜色/尺码 → 同行 `color`/`size`。
- **删掉第二个读口**：`order-shipping-rows` 支持 `source` 过滤（`all` / `import` / `collect`）并带出 `source`/`qty`；
  **删除 `order-collected-rows`**（通道 + 类型 + `ae-db.collectedOrderRows`）—— 主干一个读口、一份语义（IPC 回到 190/190/186）。
  两个页面改为**单次取数**，来源由宿主在行上标好（页面不再自己打标签）。
- **拣货页因此也能看到采集单**（真实收益：采集帧带颜色/尺码/件数，只是款编码常空 → 会标"未识别款"）。

**过渡期事项（写在明处，不当默认）**：`ae_orders`/`ae_order_lines`/`ae_fees` 从本轮起**只读、不再写入**；
岛上「订单明细 / 利润统计」两条视图仍能看**历史数据**，但**新采集单只进主干** —— 随 **C9**（把利润统计并进「算钱」）收编后删表。
为什么**不双写**：双写 = 两份真相，正是本轮重构要消灭的东西。

**验证**：`npm run ae:smoke` 第 [5] 段**整段重写**（5 项：一帧落两行（件数真值 / 规格解析 / 整单收入 × 汇率）·
重推 = 整单替换（幂等）· 缺汇率 → 金额 NULL（不是 0）且空单号计数 · **读口三态过滤** · **采集不再写 legacy 表**）；
两个页面冒烟各自新增/改正「同一个返回里两类行（按 source 区分）」的断言。

## [Unreleased]

### Changed · C1（表侧）：`oi_orders` 归一为**唯一订单主干**（一次重建）

**为什么要重建**（两条事需要改约束/改形状，SQLite 不能直接 ALTER）：
- `image_id` 从 `NOT NULL` 改为**可空** —— 订单报表里**没有主图列**，这是「订单报表免图导入」（S2-b）的前提；
- 新增主干两列：**`source`**（`import` / `collect`，界面按它标来源）与 **`qty`**（件数**真值**；`NULL` = 不知道，导入侧仍由渲染层解析块内数量）；
- **删 8 个零读者列**（`goods/ship_fee/shop_discount/platform_subsidy/currency/biz_mode/paid_time/received_time`）——
  与「算钱」页的投影精简同一口径；原文仍在 `raw_fields` 里保真，需要时随时可加回（`orderMoney` 同步只提主线列）。
  ⚠️ `ship_time` **保留**：拣货的「未发货」判定在读它。
- 同一次迁移里连带：**`oi_styles` 去掉哨兵列 `name`**（历史款名先交接进 `pl_products` 再删列）——
  原 `migrateStyleAuthority()` 并入迁移（少一个每次启动都跑的交接函数）。

**验证**：`npm run schema:smoke` 场景 [C] 重写为**六条断言**（记账到 3 · 主干形状（含 8 列已删）·
`image_id` 可空能落库 · **款式名已进 `pl_products` 且 `oi_styles.name` 已删** · 老行 `source='import'`/`qty=NULL` ·
**新插入 id > 历史最大 id**（行号已追平）· 数据一条不丢）· `order:smoke` 同步（新增"主干两列"与"零读者列已删"两条）。

**重建表的三个坑已固化**：`docs/notes/2026-10-30-db-schema-and-migration.md`
（父表有 FK 子表时别用 rename→drop；重建后追平 `sqlite_sequence`；交接类步骤自己保证目标表存在）。

## [Unreleased]

### Added · S2-a：**统一导入入口**（一份 Excel 进来 → 自动判断是什么 → 落到对的表）

用户不再需要知道“该去哪个功能选文件”。首页顶栏一个「**导入 Excel**」：
- **纯检测层 `src/lib/importDetect.ts`**（+ `tests/importDetect.spec.ts` 9 例）：判据**复用各解析器自己的入口条件**（结算=商品id+结算状态 · 商品信息=`parseWeightSheet` · 报价单=`normalizeRateSheet`+《`pickRateSheet`》 · 订单报表=表头签名）。
  **判定顺序从具体到宽泛**，且**必须回报“凭什么这么判”**（判错会把整份文件导进错的表，而用户只看到“数字不对”）；
  真实 21 张表的报价单夹具已纳入用例（认得出目标表）。
- **实现单源 `src/core/services/importSheet.ts`**：解析 + 落库路由只有这一份 ——
  宿主插件 op（`DB_OPS['shipping-rate']` 的 `parseRateSheet` / `importProductWeights`）**改成薄包装调它**，内建页面也调它（算钱页的结算导入同步改为调服务，去掉重复实现）。
  三类可自动落库：结算明细（`ae_settle_lines`）· 商品信息克重（`pl_item_weights`）· 报价单（宿主运价表快照）—— **零新表零新通道**。
- **订单报表只识别、不落库**：它的导入链路（拆行 + 主图 + 识别队列）目前唯一实现在「订单归类」岛，页面会明确告诉用户去哪儿导（收编进宿主排在 C1 的表合并里）。
- 结果**留在界面上**（`上次导入：识别为「…」（因为…）→ 已导入 N 条`），不只是一个闪就没的 toast；认不出的文件**不写库**并给逐张体检结论。

**同时修一个静默错**：`productWeightGet` 返回的是**行对象**（`{weight_g,…}`），而「算钱」与「今天」两页都把它当**数字**用 ——
真实数据下“有克重”会被判成“缺克重”（两个冒烟的假数据给的是数字，把它掩盖了）；已修正并把**假数据改成真实形状**，变异测试确认现在会变红。

**验证**：`tests/importDetect.spec.ts` 9 例 · `npm run today:ui` **16 项**（新增：点「导入 Excel」→ 真实 xlsx 解析 → 识别为商品信息 → 落库出参 `items:[{itemId:ITEM9,weightG:320}]`；认不出的文件**不写库**）·
`tests/pluginTriage.spec.ts` 那条“宿主读表不得回落取第一张 sheet”的守卫已改为**顺着新链路**检查（宿主 op 必须调服务 + 服务里必须用 `pickRateSheet`），守卫未被绕过。

## [Unreleased]

### Added · S1-3：首页工作台「今天」（+ 「订单利润」更名「算钱」）

**新用户打开就能看懂“现在该干什么”**（重构 IA 的第一面）：新建内建模块 `today`（显示名「今天」，侧栏排第一），三张待办卡片，**每张只给一个动作**：
- **订单**：总数 + 两条摄取通道分开计数 + 最近下单；无数据时给**空态引导**（两条来源说明 + 一键去打开「订单归类」）而不是一句“暂无数据”。
- **待拣**：SKU 数 / 件数 / 涉及订单（范围写在卡上：未发货 · 近 30 天）→ 「生成待拣清单」。**复用拣货单的同一份纯函数**（`aggregatePicking`），不另算一遍。
- **钱算得准吗**：只做**存在性检查**（缺克重 / 缺成本 / 未识别款 / 运价表有无），**不跑利润模型**（算法只在「算钱」页一处）。
- 跳转走宜已有的 `switch-module` 事件机制（零新机制）；空态走 `open-settings` 到插件中心。

**同时更名**：「订单利润」→ **「算钱」**（id 仍为 `order-cost`）—— 这一面回答“这批订单赚不赚”，两条摄取通道与两条轨都在它内部，**不再分两个入口**。

**验证**：`npm run today:ui` **13 项**（新增：三张卡的数字可验算 · 范围写在卡上 · **点击派发的事件出参** · 空态给的是动作）。
⚙️ 本轮踩到一个冒烟新陷阱并固化：`waitFor` 的**轮询回调抛错 → Promise 永不落地**，只报「没抓到 #smoke-result」而真正的错在断言里
—— 已加 `try/catch` 并同步到另三个冒烟（见 `docs/notes/2026-10-30-smoke-and-guard-discipline.md`）。

## [Unreleased]

### Added · S1-2：页面合一 —— 「订单利润」把两条摄取通道摆在同一张表里

- **数据来源（首屏可见）**：全部 / 仅采集 / 仅导入 + 「采集 N 行 / 导入 N 行」计数；切来源**不重取数**（本地筛完重算）。
- **税口径的可见默认**：`平台代征代缴（默认，税记 0）` / `不知道（标缺口、不按 0 算）` —— 只补**订单自己没说**的行
  （采集帧没有「代征代缴」列），行自己的声明永远优先（导入侧照旧）。默认值与来源一起落 `order-cost` 命名空间。
- **明细表加「来源」列**，每行都能看出是采集来的还是报表导进来的；缺口逐行照旧（采集行会如实显示 未识别款 / 缺成本 / 缺克重）。
- **修一个真 bug**：件数口径漏了「源直接给的件数」这条 —— 采集行明明带着真值 `qty`，却仍按 1 件并标「缺件数」。
  现在 `resolveQty` 的顺序是：结算商品行真值 → **行自带 qty** → 报表块文本 → 按 1 件。
- 验证：`tests/orderCost.spec.ts` **65 例**（新增 8 例：来源标记 / 税默认三态 / 行自带件数）+ `npm run order-profit:ui` **50 项**
  （含"打开采集后两行都在 / 来源标签 / 采集行件数=真值 2 / 税默认 0.00 与切"不知道"标缺口 / 仅采集筛选"）。

## [Unreleased]

### Added · S1-1（重构第一步）：采集订单进「同一套算钱模型」

**要解决的问题**（`RESTRUCTURE_PLAN` C1）：订单有**两条主干**（`ae_orders` 浏览器采集 101 单 / `oi_orders` Excel 导入 42 单），
各养一个利润页、各有一套算法 —— 用户面对两个"讲钱"的入口。

**这一步做的事**：
- **`electron/aeMoney.ts`（新，纯函数层）**：采集链的金额口径**单源** —— 收入 = 商品金额 + 买家付运费 − 退款 ·
  **行收入按行金额占比分摊**（行金额缺失才回落 qty，再不行平分）· 汇率为 0/缺失 → `null`（不折成 0）·
  `skuProps` 解析（`Picture color+XXXL+China Mainland` → 颜色/尺码/发货地）。
  ⚠️ 分摊口径由此前的"一律按 qty 近似"**细化为按行金额占比**（`ae-engine` 同步改为调用它 → 岛上「利润追踪」的口径与将要合并的页面**一致**，不再两套）。
- **`ae-db.collectedOrderRows()` + 通道 `order-collected-rows`**：采集订单 → **统一订单行投影**
  （形状与 `order-shipping-rows` 对齐：金额一律 CNY 分、带件数/款色码/状态），于是渲染层的
  `src/lib/orderCost.ts` 能直接吃两边数据。**只读**；缺汇率的订单**照回**（金额列 null），不静默丢行。
- 渲染层类型收敛：`UnifiedOrderRow`（两条摄取通道共用一个形状）+ 补齐 `orderCollectedRows` 包装。

**按用户 2026-09-30 的原则精简**（非必要先删、必要再加）：统一投影**只留主线必需字段**，
删掉 9 个**零读者**字段（货值/买家运费/店铺优惠/平台补贴/币种/业务模式/付款·收货·发货时点），
`UnifiedOrderRow` 22 → 13 字段；两个投影（`order-shipping-rows` / `order-collected-rows`）的 SQL 与映射同步收窄。
表里那 9 个列（`oi_orders`）与 `oi_styles.name` 的**物理删除**排进 S6（与 C1 的表变更**合并成一次重建**，避免两次重建）。

**实测发现（写进 `RESTRUCTURE_PLAN` §1）**：采集帧**没有店铺、没有目的国、没有商品ID**（101 单里 `product_id` 全空），
也**没有「平台是否代征代缴」列** → 采集订单的毛理会缺"税/运费/成本"三环（页面必须逐行标出来，而不是编一个默认值）。

**验证**：`tests/aeMoney.spec.ts` **14 例**（2 条变异测试：去掉"按行金额"分支、缺汇率折成 0 —— 都会变红）·
`npm run ae:smoke` **21 项**（新增 5 项：整单收入落首行/行金额占比/外币折算/缺汇率照回/采集缺口如实投影）·
`verify` 191/191/187 · 全套 586 例绿。

## [Unreleased]

### Added · 平台重构方案（`docs/plans/RESTRUCTURE_PLAN.md`）：形态判据 + 多套收敛 + 待拍板清单

用户两条原则落成可执行方案（体验优先 / 重构期不维护多套，历史坑一起拍板）：
- **判据**：**岛 = 可选的加工手段；宿主 = 必经的主干与契约**（删掉它最小闭环还成立吗）；
  三分法（内建 / 薄内建+重手段留岛 / 纯岛）+ 铁律**入口唯一**。
- **目标 IA**：今天（首页·新）· 订单 · 货与成本 · 运费（岛）· 算钱（双轨合一）· 设置；纯岛只留店铺账号 / TV模版 / AI 识别加工 / 报价单试算。
- **9 处「多套」收敛**：订单主干 ×2 · 利润页 ×2 · 拣货入口 ×2 · 重量源 ×2 · 成本手动同步 · 运价表两处存储 · 设置入口 ×2 · 代码层双份纯函数 · `oi_styles.name` 哨兵列。
- **10 项历史坑待拍板**（含 1 项大手术：订单主干合并）；S1–S6 迁移顺序 + 四条防复发守卫。
- **只读实证支撑取舍**（本机库普查 2026-09-30）：`ae_orders` **101**（采集是在用主线）/ `oi_orders` 42（Excel 辅线）→
  **不能删任一条**，要"单主干 + 双摄取"；而 `pl_item_weights` **0** / `ae_cost_map` **0** / `ae_settle_lines` **0**
  → 三条断链都是**交互问题**（没导、没同步），不是数据模型缺东西。

## [Unreleased]

### Added · 体验审查复核与优化计划（`docs/plans/UX_POLISH_PLAN.md`）

对 `docs/reviews/UX_REVIEW_2026-09-30.md` **逐条复核**后形成可执行计划（开发 + 运营双视角）：
- **采纳 15 项**：P0 **宿主外壳 7 项（零发版）** —— 岛工具条去调试化（返回/状态/重试说人话）·
  空态可点可行动（含修「运费测算」悬空名与"拣货页生成后仍显示点生成"）· 插件中心两步可达 +
  装完可重载当前岛 · 来源徽标与能力标签人话化 · 文案纪律成文 + 窄口径守卫 · 用户文档过期标注；
  P1 结构 5 项（首启推荐包 · 统一确认弹层 · **岛侧文案攒批 2 次发版** · 空态规范 · 文档）；
  P2 打磨 3 项（缺口标签排序跳转 · 导航视觉统一 · ⌘K 帮助）。
- **改法 2 项**：① ❌ 不把「订单归类」移回默认包（与红线 23 冲突 + 作废市场版 + 复活停更实现）→ 改为
  **一键安装引导**；② ⚠️ 完整任务向导 → 先做**只读就绪检查**（判据只用宿主自己的表，拿不到的项不猜）。
- **4 项待拍板**：默认包内容 / 拣货两份入口的二选一 / 用户文档重写或降级 / 是否随包预置市场包。

### Added · `scripts/reset-dev-data.mjs`：清库重跑（重构期用，默认干跑 + 强制备份）

重构期需要"把业务数据清掉、从零走一遍全流程"（用户 2026-09-30 授权，范围＝**含主数据**）。
做成可审阅的仓库脚本而不是临时命令：
- **默认干跑**（只打印"会删哪些表、各多少行"），加 `--yes` 才真删；执行前**自动备份**到 `sellerkit.db.bak-<时间戳>`；
- 走 `sqlite3` CLI（应用库是 Electron ABI，系统 Node 加载不了）；执行前检查宿主是否在运行（并发写纪律，AGENTS §0）；
- 清 33 张表（订单/派生/拿货/付款/邮件缓存/主数据）；**保留** `sk_schema_migrations`（清了会让迁移重跑）、
  账号（`sk_mail_accounts`）、企业资质、汇率；邮件 FTS 用 FTS5 `delete-all` 清，避免幽灵命中。
- ⚠️ 删除动作由**人**执行（工具侧的策略不允许代跑不可逆的真实数据删除）。

### Fixed · `docs/README.md` 索引被并发写清空后恢复

10:22 另一个工具会话把 `docs/README.md` 写空并回退到 HEAD 版，**未提交的索引更新整批消失**。
本次从 git 恢复骨架并**补回 09-24~09-30 新增的 12 行索引**（ADR-001/002 · UI 岛清单 · 产品库 ·
域串联 / 运费 / 拣货 / 体验四份计划 · 四份审查 · 结论文档），顺带订正 4 处过期状态
（`USER_GUIDE` 标为已过期、整改 25/27、插件盘点 T1–T6、基线日期）。
教训与契约见 `docs/notes/2026-09-30-cross-tool-context-sharing.md` 与 `AGENTS.md` §0：**同一工作区同一时刻只让一个工具写**。

### Added · 结论笔记（`docs/notes/`，AGENTS §0 的共享层）

`docs/notes/2026-10-30-island-host-boundary.md` —— 给 UI 岛加「读数据」能力的正确形态：
宿主只读域 op 内 `await import('@/lib/…')` 复用渲染层纯函数，岛侧零口径、零新通道；
含"守卫必须先剥注释"的变异测试取证。已在 `docs/notes/README.md` 登记。

## [Unreleased]

### Added · 拣货线 P5：能力交给 UI 岛（`order-insight` 加「拣货」页签，升 1.5.0）

**宿主**：`src/core/plugin/host.ts` 新增**只读能力域 `picking`（单 op `groups`）**。
关键：`host.ts` 跑在**渲染进程**，故能 `await import('@/lib/picking')` ——
于是"取投影 + 取结算件数 + 按 SKU 汇总 + 范围口径"与**内建拣货页共用同一份纯函数**，
**岛侧零口径**（不必把口径拄一遍 —— 拄一遍必然漂移，而拣货单少一件就是少发一件货）。零新通道（190/186 不变）。

**岛侧**：`ui-plugins/order-insight` 新增「拣货」页签（`dist/views/picking.js` + `api.js` 加 `picking` 助手 + `main.js` 注册）：
一键看待拣清单（图 / 款色码 / 件数 / 订单数 / 供应商 / 缺）+ 天数窗（7/30/90/不限）+ 导出 xlsx（复用岛内已有的 `exportWorkbook`）。
manifest：声明 `picking` 域 + `groups` 动作，**版本 1.4.0 → 1.5.0**（版本号是唯一更新判据）。

**验证**：`npm run order-insight:picking:ui` **14 项**（假桥无头：页签出现 / 汇总走 `db picking.groups` 带天数 / 表与缺口逐行 / 缩略图 `maxEdge` / 改天数窗重取 / **导出 payload 形状**）·
`tests/orderInsightPicking.spec.ts` **10 例**接线守卫（含"岛里不得出现口径实现""宿主必须复用纯层"；
3 条变异测试逐条变红）。⚙️ 其中"宿主复用纯层"那条**必须先剥注释** ——
域上方注释里就写着那句 `await import`，不剥的话变异也恒绿（实测已踩）。

**发布动作待攒批**（用户节奏）：`node scripts/publish-plugin.js --dir ui-plugins/order-insight --base <市场仓库>`
→ 同步本机 `~/Library/Application Support/seller-kit/plugins/` → **重启宿主**（启动会预载上次所在的岛，其 iframe 持旧产物）。

## [Unreleased]

### Added · 拣货线 P3/P4：只读投影 + 一键「生成待拣清单」页

**能干什么**：打开「拣货」→ 点一下 → 按 **SKU（款 × 色 × 码）** 列出"要拣什么、各几件、图与供应商在哪"
→ 导出 xlsx 交给仓库或自己照着拣。默认范围 **未发货 · 近 30 天**，条件**写在界面上**（含被剔除的行数）。

**宿主侧（`picking-rows`，只读通道，+1 通道 → 190/186）**
- `electron/picking-db.ts`：未发货订单行投影 = 款色码（识别链 JOIN，同 `shippingRows` 口径）+ **图三层回落**
  （复用 `itemImagePool`：覆盖图 > 订单图 > 款主图）+ 供应商（缺 `suppliers` 表降级空串）+ `raw_fields`（件数由渲染层解析）。
- **刻意只回投影、不做聚合**：件数要从 `raw_fields` 的「商品信息」块解析、范围判定要认状态原文与多种日期写法 ——
  这些的唯一实现都在渲染层纯函数，主进程再抄一份必然漂移。
- **只做机械筛选**（`ship_time` 空 且 `status<>'shipped'` / 可选店铺 / 上限）：关闭单照收（由渲染层剔并计数）。
  实测依据：`订单列表-6.xlsx` 153 行里 **101 行"订单关闭"的发货时间是空的** —— 不做这层过滤会多 25 倍噪声。

**渲染层**
- `src/lib/picking.ts`（纯层，21 例）：按 SKU 汇总件数/订单数/图/供应商/店铺，**逐组**记缺口（缺图 / 缺件数 /
  缺供应商 / 未识别款）；**范围口径**（已终结剔除 · 超窗剔除 · 无日期照收，三者都计数）；
  分组键与件数口径**与订单利润页共用同一份实现**（`skuKey` / `resolveQty` —— 顺手把它们从 `orderCost.ts` 提出来单源）。
  ⚠️ 日期窗用 `dateKey` 认多种写法：在 SQL 里做字符串比较会把 `08/30/2026 07:00` 这种格式**静默丢掉**。
- `src/modules/picking/`（内建模块，`modules.config.json` 登记）：一键生成 + SKU 表（图/款色码/件数/订单数/供应商/缺）
  + 导出 xlsx（`orderExportExcel`）+ 「更多」折叠（天数窗 / 店铺 / 含已发货）。顺手补齐 `orderImageThumbBatch` /
  `orderExportExcel` 两个 core 服务包装（此前只有类型声明、没有导出函数）。

**验证**：`npm run picking:smoke` **15 项**（DB 层：未发货只认机械事实 / 三层回落 / 识别链 / 降级不抛 / 上限钳制 / 脏行不毁整批；
存量测试确认把筛选改成 `1=1` 会变红）· `npm run picking:ui` **25 项**（无头：一键语义 / 三路取数 / 组内件数可验算 /
剔除计数标签 / 缺口逐行标 / 缩略图带 maxEdge / 改筛选后重新生成带出店铺 / **导出真的生成 xlsx 字节且文件名带日期**）· `tests/picking.spec.ts` 21 例。

**未做（刻意）**：`db` 能力域 `picking` —— 该域只为 **UI 岛** 存在，而拣货页是内建模块（走 core 服务直连宿主通道）；
加一个没人消费的域只是死声明。岛消费时（P5）再把域与岛声明一起发版。

## [Unreleased]

### Added · 件数口径接入（P2，拣货线第二刀）

**为什么必须做**：拣货单的"要拣几件"此前恒按 **1 件/行**（与运费岛同样的保守口径），
而实测真实报表里 **6% 的块是 2~3 件** —— 件数是假的，拣货单就不可用。

**件数的三个来源（优先级已钉住，缺则**逐行标出**、不静默）**：
1. **结算明细的商品行真值**（`ae_settle_lines.qty`，经 `settleOrders` 带出的 `items`）——
   ⚠️ **仅当该 `(订单,商品)` 在结算表里恰好一行商品行**时才采用：实测**同一商品会以多个 SKU
   出现在一张单里**（订单报表 14 行"商品ID 重复"、结算侧 10 组多行），把合计铺到每一行会**翻倍**；
2. **订单报表「商品信息」块内的 `商品数量`**（`src/lib/orderRowSplitter.ts` 新增 `parseRowQty`）——
   拆分后每行只剩自己那一块，故就是这一件的数量；**多块原文**（块数 ≠ 商品数时没替换）一律返回 null，
   **不用「数量」列**（拆行后它仍是整行值，同一理由见 `extractShipping`）；
3. 两处都没有 → **按 1 件 + 逐行标 `缺件数`**（进"缺哪一环"计数）。

**界面**：明细表新增「件数」列（悬停说明来源：结算明细 / 订单报表 / 兜底），
统计表新增「件数」合计（与收入/成本同口径，**只含非关闭单**）；
件数 > 1 时出一枚提示 `多件 N 行 · 成本/运费仍按 1 件计（合并计费口径待定）`。

**⚠️ 刻意不做的**：件数**不参与**成本/运费/毛利算术 —— 单件成本来自 `ae_cost_map`（可放大），
但多件合并计费仍是运价岛的开放项；只放大成本会得到"成本×N、运费×1"的怪数。
两件事要一起改且会改动所有已展示的毛利 → **等拍板**（开放项记在 `docs/archive/plans/PICKING_PLAN.md` §3.2）。
为防止"顺手放大一半"，单测里用一条断言把这个口径钉住（`qty=2` 与 `qty=1` 的运费/成本/毛利逐项相同）。

**验证**：`tests/orderCost.spec.ts` 57 例 + `tests/orderRowSplitter.spec.ts` 28 例；
UI 冒烟 **40 项**（含"报表 2 件 → 结算真值 3 件盖过它 → 两处都拿掉时按 1 件并出现「缺件数 1」"）；
4 条新守卫**逐条变异测试**确认会变红（去结算多行守卫 / 去缺件数标记 / 去件数汇总 / 去多块守卫）。

**新增 DB 层冒烟 `npm run ae:settle:smoke`（10 项）**：`ae_settle_lines` 此前**没有任何自动化覆盖**，
而本次改了 `settleOrders` 的 SQL 与返回形状。覆盖落库幂等（重导 = update 而非重复行）、
行类型判定、订单级行优先（两类行不可相加）、**`items` 件数明细**（去掉 `lines++` 会变红）、`qty` 兜底、`settleStats` 计数。

## [Unreleased]

### Added · 订单利润页：界面精简（P0）+ 两个新统计维度（P1，拣货线第一刀）

**P0 界面精简**（用户原则：操作极简 / 界面聚焦）：低频操作（**店铺归属 / 导入结算明细 / 平台费率 / 行数**）
收进折叠的「更多」；首屏只留 **统计数字 + 刷新 + 统计维度**。冒烟新增"首屏确实收起 + 展开后可达"两条断言。

**P1 两个新维度**（对应 `docs/archive/plans/PICKING_PLAN.md` 的 P1，**零新域 / 零通道 / 零发版**）：
- 投影补 **`color` / `size` / `supplier_id` / `supplier_name`**：颜色/尺码是 `oi_orders` 的列；
  供应商经 **`LEFT JOIN pl_products → suppliers`**（缺 `suppliers` 表时降级空串，不抛 `no such table`）。
- `summarizeOrderCosts` 新增 **`'sku'`**（key = `款 · 色 · 码`，**缺哪段就把哪段写进 key** →
  "缺色 3 组"在表上肉眼可见）与 **`'supplier'`**（按 **id** 分组、显示名字，C2：关联用 ID）。
- 顺带**收拢 `tableExists`**：原先 product/shop/shop-product 三个域各抄一份 → 现在只留 `electron/db.ts` 一份导出。

**为什么先做这两维**：`oi_orders.color` 由 AI 归类写入、`size` 依赖「尺码列」映射 —— **填充率未知**。
统计表上一眼能看出色/码缺多少，**决定拣货能做多准**。

**P1 取证结论（2026-09-29 实测用户库 42 行，只读聚合）**：
`color` / `size` / 款编码 **全部 100% 填充** → **拣货按 款×色×码 做准没有障碍**；
但 **供应商只填了 1/27**（`pl_products.supplier_id`）→ 按供应商分组先别当主打，
缺的行显示 `(未识别供应商)` 并计数，**不静默糊成一组**；要真按厂家分单需先去产品库补 `supplier_id`（主数据维护）。

## [Unreleased]

### Added · `order-insight` 岛 1.4.0：导入时指定店铺（**未发布，待与发版一起做**）

**用户反馈**："导入后归到该店"这个补动作本不该存在 —— 订单列表/明细本来就是**按店铺导出**的，
所以正确的流程是**导入时就带上店铺**。宿主侧无需改动（`order-import` 通道本来就收 `shop`），改的是岛：

- **导入面板**（列映射区）新增「**本次导入店铺**」输入；**设置面板**也可改（不必靠再导入一次）。
- **落库优先用它**：`shop: s.fixedShop || fieldOf(s, row, 'shop')`（没填才回落到「店铺列」）；
  入队时的 `info.shop` 也一致（队列界面不出现"空店铺"）。
- **配置持久化**：`fixedShop` 与列映射同键名空间，与内建版配置双向互通。
- **版本升到 1.4.0**（`ui-plugins/order-insight/manifest.json`）—— 版本号是唯一更新判据，
  且发布口会拦"同版本换内容"。
- **逻辑层验证（手写岛无单测，故做接线守卫）**：新增 `tests/orderInsightShopAtImport.spec.ts`（5 例，
  扫描型）钉住五个接线点（面板输入 / 读值 / 持久化 / 恢复 / 落库优先）+ 宿主收 `shop` + **版本已升**
  （防"改了没升版本 = 发了等于没发"）+ 文件存在（防扫描空转）。
- ⏳ **待办（需你点头的发布动作）**：`node scripts/publish-plugin.js` 打 `order-insight-1.4.0.zip` →
  同步本机安装目录 → **重启宿主** → 真机验证（清单见下）。同时把此前积压的**拆行三处修复**一并发出。

## [Unreleased]

### Added · 订单归属店铺（让「店铺」维度真正可用）

**背景（用户确认）**：AE 的「订单列表 / 订单明细」都是**按店铺导出**的，但**报表里没有店铺列**
（只有"店铺优惠"；岛侧"店铺列"是用户手选的，对这类报表选不出来）→ 店铺只能**在导入后由人指定**。

- **新通道 `order-assign-shop`**（payload `{ orderNos, shopName }`）：写 `oi_orders.shop` 的**名称原文** ——
  与 `purchase_sources.shop` / `ae_orders.shop_name` 一致，归一仍由 `sk_name_map` 在**查询时**旁挂（G2 历史文本不改写）。
  一个订单号的多行（拆行后的多商品）一起更新；已是同名的不重复改。
- **页面**：工具栏新增店铺下拉（读店铺实体 `sk_shops`，用现成的 `shopList`）+「归到该店」按钮
  （把当前列表里的订单号一起归过去，答完提示改动行数）；统计维度新增**按店铺**，未归属的自成 `(未归属店铺)` 一组。
- **站在用户角度的两处改进（2026-09-29 用户反馈）**：①工具栏显式提示**「未归属 N 单」**（0 就不显示）——
  让用户一眼知道要不要点那一下，而不是靠猜；②**记住上次选的店铺**（同命名空间持久化）—— 同一家店连着导几次不用重选。
  ⚠️ **「归到该店」本来就是一次点击整批**（一次 IPC 送当前列表所有订单号），不是逐单点。
- **正解是"导入时就带店铺"**（用户原话）：那需要改**岛侧导入面板**（加"本次导入属于哪个店铺"）+ 升版发布
  —— 属发布动作，待确认；届时可与**积压的拆行修复**一次发出去。
- **冒烟**：新增"未归属提示 → 归属 → 提示消失 + 明细显示店铺"的**全回路**断言（假桥模拟落库）。
  顺带修一处夹具时序：按钮 `:disabled` 依赖 `shopPick`，**Vue 下一个 tick 才更新** → 必须等按钮可用再点，
  否则"点了没反应"（这类失败不报错，只会表现为超时）。

## [Unreleased]

### Added · 订单利润页：按维度统计区（款 / 目的国 / 经营状态）

回答"这款赚多少""这个国家赚多少"这类问题 —— 明细页之上加一层汇总（`src/lib/orderCost.ts` 的 `summarizeOrderCosts`，**6 例**新单测）：

- **两个维度天然对应两把成本尺**：`款` 对应款级成本、`目的国` 对应运价卡；第三个 `经营状态` 用来单看关闭单。
- **口径与汇总一致：只统计非关闭单**（实测某批 2/3 是关闭单，混进每组都会虚高）；关闭单看 `bucket` 组。
- **未识别款 / 缺国家 / 缺成本的行各自成组，不丢** —— 丢了会让"合计对不上"变成查不出的悬案（沿用既有纪律）。
- 每组给：行数 · 收入 · 成本 · 预测毛利 · 精准毛利（含行数）· 缺口行数。
- ⚠️ **「店铺」维度做不了（实测）**：47 列订单报表里**没有店铺列**（只有"店铺优惠"），
  岛侧"店铺列"是用户手选的；这批订单的店铺为空 → 按店铺统计需要另找来源（店铺实体映射或另一份导出）。

### Fixed · 无头冒烟的三处自身缺陷（都被它自己抓到）

- 页面加了第二张 `.oc-table`（统计表）后，**明细断言的选择器撞上了统计行** → 明细表加 `data-act="detail-table"`，
  断言一律限定范围（"两张同类表"是这类冒烟的典型坑）。
- 刷新期间 `v-if="loading"` 会把整块摘掉 → 断言前必须 `waitFor` 表回来（预测轨与统计区两处都踩了）。
- **注入脚本（模板字符串）里的注释不能含反引号** —— 一个反引号就把字符串截断（本轮踩了三次）；
  `npm run order-profit:ui` 已加 `node --check` 前置，把"运行时报怪错"变成"一眼语法错"。

## [Unreleased]

### Added · 结算明细落库 + 「预测 / 精准」双轨（真值轨打通）

接上一条解析层，本次把它**落库并接进利润页**：

- **新表 `ae_settle_lines`**（`electron/ae-db.ts` 的 SCHEMA；新表无需迁移）：一表两粒度，
  `line_type` 区分**商品行**与**订单级行**；费用按 **JSON 科目**存（加科目零 ALTER，同 `ae_fees` 思路）；
  幂等键 `(order_no, item_id, sku_id)`，落库走 `ON CONFLICT DO UPDATE` + **行级 catch**（不整批回滚）。
- ⚠️ **口径发现（实测）**：**订单级行的 `成交金额` 是整单**（含买家付的运费那部分），
  **商品行的只是商品部分** —— 样例 87.15 vs 114.52；全表合计 7833.61 vs 29407.01 → **两类行绝不可相加**。
  故 `settleOrders()` **优先取订单级行**（整单权威口径），没有时才退化为商品行求和并把 `from` 标成 `items`。
- **新通道 3 个**：`settle-import` / `settle-orders` / `settle-stats`（preload/types/ipc 三处同步；`verify` 188/188/184）。
- **算法层双轨**：`OrderCostInput.settleByOrder` 给了该订单的结算数据就走**精准轨**
  （`preciseGrossProfit = 净收入 − 成本 − 运费`；净收入是平台结算口径，**已扣平台费** → 本层不再估平台费、不再另扣税），
  否则走预测轨；每行带 `tier`（`precise` / `forecast`）。**39 例单测**覆盖（含"结算数据在、成本缺 → 精准毛利为 null"）。
- **页面**：新增「导入结算明细」按钮（`selectExcelFile` → 渲染层解析 → 落库 → 重取；⚠️ 文件对话框驱动不了，冒烟未覆盖，与产品库导入同缺口）·
  新增「轨」列（预测/精准）· 毛利列**按轨取值**（精准行的悬停说明里保留预测值）· 分桶行多一个"精准 N 行 · 毛利 X" chip。

### Changed · `ae` 域迁移转为版本化（house convention）

`ensureAeSchema()` 原先在 `dbMigrate` 前后散着两个幂等函数，现统一为 `migrate('ae.main', …)`（v1 重建 `ae_cost_map`、
v2 补 `ae_order_lines.style_code`），并**把 `style_code` 补进建表语句** —— 原先它只写在迁移里，
迁移先跑后**新库会永久缺该列**（与 `oi_images.style_color_id` 同一个坑）。
`schema:smoke` 新增 **ae 老库场景**（老形状 → 重建 → 行不丢 + 哨兵生效日 + 幂等），共 **21 项 / 4 场景**。

## [Unreleased]

### Added · 结算明细解析层（真值轨的入口）

数据源：AE 后台导出的「订单明细」（真实样本 2 表 / 200 单 / 412 商品行）。本层只做**解析 + 校验**，
落表与页面接线在下一轮。

- `src/lib/settleImport.ts`（纯函数，**17 例**）：选表（取带 `商品id` + `结算状态` 的**商品级**那张）·
  行类型判定（**`商品id` 为空 = 订单级行**）· 八类费用 + 退回逐科目存**分** · 幂等键 `(订单号, 商品id, sku id)` ·
  模板定义行（订单号不是 8 位以上纯数字）**跳过并记 issue，不静默丢**。
- **两条等式逐行校验**（不符记 issue、不抛错）：`平台分账金额 = Σ八类费用`、`净收入 = 成交金额 − Σ费用`。
  后者**只对"已结算且无退款"的行**校验 —— 实测待结算行费用列全是 0（平台结算前不给），
  全额退款单费用与净收入也都是 0（平台口径），公式对它们不成立。
- **真实数据验证**：在 412 行导出上跑通 —— 商品行 212 / 订单级行 200 / 已结算 332 / 待结算 80 / **issues 0**
  （与独立探针数字一致，两条等式零误报）。

## [Unreleased]

### Added · 平台费近似费率（预测轨的费用缺口）

**为什么必须估**：实测结算明细（2026-09-28 导出）—— **待结算行的费用列全是 0**（`待结算原因=订单未发货`），
平台在**结算前不给佣金**，而结算要等到发货/确认收货之后（1–2 个月）。所以「预测」轨的费用只能估。

- **算法层**：`OrderCostInput.platformFeeRatePercent`（百分数）。配了 → `platformFee = 收入 × 费率` 并计入毛利；
  **没配 → 不扣**，`platformFeeMissing` 标真（**不按 0 算** —— 0 会让毛利看起来更好）。
- **默认值有据**：实测该批结算数据（剔除 55 条全额退款后 277 行）—— 佣金 **5.50%** + 交易服务费 **2.23%** +
  联盟佣金 0.59% + 金币营销费 0.50% + 营销类 0.31% ≈ **9.14%**；已写进字段注释与页面 tooltip。
- **页面**：工具栏加费率输入（0–50%，step 0.1），改动即重算（复用上次取数结果，不再打 IPC）+ 防抖落盘到
  新命名空间 `order-cost`；提示文案随之在「平台费未扣（未配费率…）」与「平台费按 X% 近似（结算后以真值替换）」之间切换。
- **冒烟**：`order-profit:ui` 增到 **16 项**，新增「改费率 → 毛利 139.18 扣到 124.31 + 落盘出参」的交互断言。
  顺带修了夹具两个真 bug：假桥 Proxy **只转发第一个实参**（`setModuleState(ns,data)` 的 data 被丢）、
  以及断言"最后一次 `setModuleState`"（外壳启动也会调它 → 误判）。

## [Unreleased]

### Added · 运价表快照（宿主中立层）—— 预测可复算

**问题**：运价表原先只以"当前那一份"存在运费岛的私有 storage 里 —— 报价单更新后，
**历史订单的预测运费会跟着变**（预测不可复算）；而且它挂在可卸载的岛上，违反 ADR-002 C3。

- **新表 `sr_rate_snapshots`**（`electron/ship-rate-db.ts`）：一次导入 = 一条，
  `content_key`（payload SHA-256）UNIQUE **按内容去重**（反复导入同一张表不堆行），
  `effective_from` = 导入当日（显式传入合法日期则以传入为准，脏值回落当日、不写脏数据）。
- **写入时机零改岛**：宿主 op `parseRateSheet` 本来就在用户每次导入报价单时被调用 →
  在那里顺手留档。**失败不吞**（留档失败会让后续预测悄悄用旧表 → 直接报错让用户重试，导入本身幂等）。
- **读取侧**：`src/lib/orderCost.ts` 新增 `pickRateSnapshot`（口径同 `ae_cost_map`：
  `effective_from <= 订单日` 最近一份；早于所有快照 → **回落最早一份**），
  并**按所选快照分组**逐组调同一个 `quoteOrders`（不重算运费口径）；每行带 `rateVersion`（按哪张表算的）。
  无快照时退回"当前那份"（老库零回归）。
- **新通道 3 个**：`ship-rate-snapshot-{save,list,calc}`（preload/types/ipc 三处同步；`verify` 通过）。
  通道由宿主 op 调用，**岛无需改、无需发版**。
- **门禁**：`npm run ship-rate:smoke`（11 项）。

## [Unreleased]

### Added · 订单「钱 / 状态 / 时点」入账 + 「订单利润」页（预测口径）

**背景（真实报表实证，`订单数据.xlsx` 1722 行 / 47 列）**：`oi_orders` 原无任何金额列，
"这单会赚多少"连输入都不完整。本次把利润公式的输入提成正式列：

- **新增 14 列**（`electron/order-db.ts`，版本化迁移 `order.main` = v2；建表与老库补列共用一份列定义）：
  `amount_cents` / `goods_cents` / `ship_fee_cents` / `vat_cents` / `ddp_cents` /
  `shop_discount_cents` / `platform_subsidy_cents` / `currency` /
  `biz_status` / `biz_mode` / `tax_platform` / `paid_time` / `ship_time` / `received_time`。
  **金额列可空（NULL = 报表里没有），故意不给 DEFAULT 0** —— 0 是"确实是 0"，混起来就会把"缺税"算成"零税"。
- **解析层** `electron/orderMoney.ts`（零依赖纯函数，11 例单测）：`CN￥ 1,234.56` → 分 + 币种；
  空/认不出 → `null`；列名族宽松（换平台导出也能认）。**入库这一刻**在主进程完成 → 岛侧无需改、不必发版。
- **判定与算账** `src/lib/orderCost.ts`（27 例）：新增 收入 / 税 / 毛利 与经营状态分桶：
  - **预测口径**：在途单也算（这是预测工具，不是只算已结算）；
  - **关闭单单列一桶、不进利润合计**（实测该报表 54% 是关闭单，混进来整体虚高）；
  - **平台代征代缴 → 增值税不是我们的成本**（记确定的 0）；不知道谁承担 → 标缺、**不按 0 算**；
  - **平台费（佣金）无数据源** → 全局标志 `platformFeeMissing` + 页面提示，毛利如实标"未扣平台费"。
- **页面**：「订单成本」升级为「**订单利润**」（`src/modules/order-cost/`，id 未变）：分桶合计、
  逐行 运费/成本/税/收入/毛利、缺口提示、关闭单灰显。
- **门禁补齐（二）**：`npm run order-profit:ui`（11 项，假桥无头冒烟）—— 这一页有四路取数与一条跨域算账链，
  但纯层单测只覆盖到 `computeCosts`，**接线**（IPC 键名/字段名/分→元/是否真走宿主快照）从未被跑过。
  冒烟用可验算的样本断言**精确值**（运费 16.00 / 成本 10.00 / 税 0.00 / 收入 165.18 / 毛利 139.18）
  并断言点击出参，首次运行即通过。
- **门禁补齐**：`npm run order:smoke`（14 项）—— 订单域是最大的域却一直没有自己的冒烟，
  本次的入库提列/投影改动此前只能被 `style:smoke` / `product:sku:smoke` 间接兜住。

**不做派生的理由**（实测）：金额列之间没有稳定等式（三种常见关系最高只命中 493/1722 = 29%）
→ 逐列如实取；少存一列以后就得重导。其余 30 余列仍留在 `raw_fields` 里保真，**随时可提**。

### Fixed · 订单拆行接不住「速卖通订单报表」格式（三处静默错，均据真实报表实证）

真实样本：`订单数据.xlsx`（1722 行 / 47 列，2026-09-29）。三处问题都在**旧实现**里，且都不报错：

- **认列要求存在「产品数量」列** → 该报表无此列，`detectMultiProductColumns` 直接返回 null →
  **一行多商品完全不拆**（实测 1 商品 1663 行 / 2 商品 49 行 / 3 商品 10 行）。
  现补第二条信号：**「【N】块 ≥ 2」或「商品ID 逗号分隔 ≥ 2」**，N 取两者较大者
  （不一致时按较大值拆、多出的行字段留空 —— 与"缺图保留空记录"同一处置：留给人看见，不静默丢产品）。
- **商品ID 多值分隔符不含逗号** → 该报表的写法是 `1005...,1005...` → 会被当成**一个假商品ID**入库
  （商品ID→产品/克重全查不中，且无告警）。逗号已加入 ID 分隔符。
- **商品ID 列名族 `/商品ID/` 匹配不上真实的 `商品 ID`（带空格）** → 连"多值列"都认不出来。
  已对齐仓内唯一口径（`shopSku.ITEM_ID_KEYS`）：`/商品\s*ID|产品\s*ID|SKU|货号/i`。
- **顺带收紧**：`missingImage` 只在**存在图片列**时判 —— 像该报表这样压根没有图片列的格式，
  逐行标"缺图"等于凭空制造 59 行待补图（那种报表的图按商品ID 另有来源）。

改动落在**两份拷贝**（仓内长期笔记约定：改 order-insight 必须两处同改）：
`src/lib/orderRowSplitter.ts`（留档源码 + vitest，**21 例**）与
`ui-plugins/order-insight/dist/splitter.js`（**运行版**，手写岛产物）。

⚠️ **运行版尚未生效**：手写岛必须 `manifest.version` 升版本 → `scripts/publish-plugin.js` 发布 →
本机安装目录同步 → **重启宿主**（版本号是唯一更新判据）。**发布属发布动作，待确认后执行。**
⚠️ 两份拷贝目前**无一致性守卫**（守卫只扫 `ui-plugins/*/src/`，手写岛无 `src/`）—— 建议补一条扫描型守卫。

### Added · 「订单成本」内建模块（跨域算到一处的第一刀）

- **目标**：回答「这条订单要花多少钱」—— 把 **订单行 × 款级成本 × 克重 × 运价表** 算到一处，
  逐行给出 运费 / 产品成本 / 合计，并标出**缺哪一环**（无国家 / 无克重 / 运价表没这张卡 /
  未识别款 / 该款无成本）。任一环缺则 `total` 为 `null` —— **不拿 0 顶替**（0 会让"缺成本"看起来像
  "零成本的高利润"）。
- **落点**：纯计算层 `src/lib/orderCost.ts`（口径单源 + 19 例 vitest）；内建模块
  `src/modules/order-cost/`（已登记进 `modules.config.json` 的 standard/pro）。
- **口径复用**：运费一律走 `shipRateOrders.quoteOrders`（含拒算五分类），本层**不重算运费**；
  成本取数照 `ae-engine.costAt`（`effective_from <= 订单日` 最近一条 · 同日 manual 优先 · 无命中回落最早一条）。
- **过渡形态（有意）**：运价表仍存在运费岛的命名空间，本模块**借宿主同一个 electron-store 读
  `modules.shipping-rate`** —— 零迁移、零发版、**无双写**（在宿主再存一份必然漂移）。等出现第二个
  写入方（或该岛退役）再按 `migrate()` 正式把它搬进宿主表（ADR-002 C3）。
- **为什么是内建模块而非岛**：走渲染层核心不经过岛的 `domains`/`actions` 判定 → **零发版**即可验证
  跨域骨架；搬进岛时再连带声明新 op 一起发版。
- **配套**：`order-shipping-rows` 的只读投影加 `shop` / `order_time` / `style_code` / `style_color`
  （**加法**，老调用方不传不改也能照常工作；款编码走 `oi_images → oi_style_colors → oi_styles` 识别链，
  与 `purchase-db.outstanding()` 同一套 JOIN，**LEFT JOIN** 保证未识别的行仍在）。
- ⚠️ 未验证：页面**未经真机点击**（纯计算层有单测、构建产物已生成）；`npm run dev` 起来后需人工看一眼。

### Added · schema 版本化迁移（`electron/db.ts` 的 `migrate()`）+ `schema:smoke`

- **为什么必须加**（实测教训）：`pl_shop_sku` 的唯一键在一对多改造时由 `(platform, shop_id, item_id, spec)`
  扩成含 `product_id` 的 5 列，而 `CREATE TABLE IF NOT EXISTS` **不会重建老库** ——
  于是**老库 4 列键 / 新库 5 列键**，代码里对旧形状的假设（`ON CONFLICT(platform, shop_id, item_id, spec)`）
  在**新库上每次写入都失败**、在老库上完全看不出来。形状差异只能靠一次性迁移收敛。
- **两条通道，职责不可互相替代**：`dbMigrate(statements)` = 幂等 DDL（新库一次建到当前形状）；
  `migrate(key, steps)` = 版本化演进（补列 / 重建表 / 改唯一键 / 搬数据），只跑未应用的版本，
  记账于新表 `sk_schema_migrations(key, version, applied_at)`，**按域 key 分别记版本**。
- **首个迁移**：`product.sku` v1（补 `image_url`/`imported_at`）+ v2（`pl_shop_sku` 唯一键归一到 5 列，
  用"建新表 → 显式列名搬数据 → 删旧表 → 补索引"重建，并重置 `AUTOINCREMENT` 序列以免 id 复用）。
- **门禁**：`npm run schema:smoke`（12 项）造一个**老库形状**的库，断言数据一条不丢、索引没丢、
  唯一键已升级、序列已重置、幂等可重跑，并断言新库走"跳过重建"那条路。
- **同轮修正的既有缺陷**（都由上面这个形状差异派生）：
  - `upsertSkuMappings`：改绑 = **替换**（同 `(platform, shop_id, item_id, spec)` 只有一条映射行，显式"查 → 更新/新增"），
    不再依赖已失效的 4 列 `ON CONFLICT`；
  - 池行（`source='shop-import'`）与归款映射行的种群隔离：映射侧的 list / 汇总 / 队列"已映射"判定 /
    `resolveOrderSku` / `resolveSkuBatch` / `upsert` 一律带 `skuMappingSql()`，池侧一律带 `skuPoolSql()`；
  - 池的 `删除` 只删池行（此前 `DELETE WHERE item_id = ?` 会把 confirmed 归款映射一并删掉）。

### Added · 发布口加「同版本重发布」守卫（`scripts/publish-plugin.js`）

- **问题**：宿主与市场的更新判据**只有版本号**（`plugins-market-handlers.ts` 的
  `compareVersions(已装, 目标) >= 0 && !force` 直接拒绝安装，`PluginCenter.vue` 的
  `updateable = cmp < 0` 连"更新"按钮都不给）。于是"改了内容但没升版本"= 发了等于没发；
  反过来"同版本覆盖旧包"会让已拉过的人的 sha256 校验对不上。产品库 1.4.0 事故即前者。
- **守卫**：写 zip / catalog **之前**，用「**打包内容摘要**」（zip 内每个条目的 路径+字节）与
  已存在的同版本 zip 比对 —— 内容一致 → 幂等放行；**内容不同 → exit 1 拒绝并打印两个摘要前缀**，
  产物一字未动；确需原地覆盖（刚发出就发现打坏包）加 `--force`，会打印显式告警。
  catalog 已登记同版本但本地无 zip 可比对 → 告警放行（提示"线上那份可能不是这份"）。
- **判据不是 zip 自身 sha256**：JSZip 默认给条目打当前时间戳，同内容两次打包字节就不同（实测）。
  顺带把条目时间戳固定为常量 `ZIP_ENTRY_DATE` —— 同内容现在产出**同字节同 sha256**，
  `catalog.json` 不再因重发布而无意义抖动。
- **回归**：`tests/publishGuard.spec.ts` —— 造最小 UI 岛**实跑脚本**，4 条断言
  （首发给对 sha / 同内容幂等且字节相同 / 内容变则 exit 1 且 zip·catalog 未动 / `--force` 才覆盖）；
  已做变异自证：关掉守卫 → ③④ 变红；把守卫挪到写盘之后 → ③ 在「zip 未变」上变红。
- 跨岛核验：`shipping-rate` 1.2.1 走同守卫**同版本同内容**放行（说明线上产物与当前内容一致，非误伤）。

### Added · 产品库新增「商品清单」页签（`product-library` 1.5.0）

- **新页签「商品清单」**：Excel 导入店铺商品池（按 `item_id` 去重，保留最新 `image_url`），
  一件商品可**一对多**关联产品 —— 覆盖套装 / 组合装场景（与「映射与关联」页的单值映射互补）。
  数据复用 `pl_shop_sku` 扩展视图，新增宿主 db 能力域 **`shop-products`**（6 op：
  `import` / `list` / `relations` / `relationAdd` / `relationDelete` + 删除），
  复用既有 `shop-product-*` IPC 通道，**零新通道**。
- ⚠️ **这一版是「同一版本号重复发布」事故的补救版**：09-27 发布的 `1.4.0` 不含本页签，
  09-28 用**同一个 1.4.0** 重打包（内容已含本页签）覆盖了市场 zip，但更新判据只有版本号
  （`compareVersions(local, market) < 0` 才可更新，主进程 `>= 0` 直接拒绝安装），
  于是 `1.4.0 == 1.4.0`，**装过的机器永远拿不到新内容**，症状是「页签怎么都不出现」。
  本次升版到 `1.5.0` 并重发，链路才真正通。详见 `ui-plugins/product-library/README.md` 的陷阱表。
- **发布与验收**：`market-out/product-library-1.5.0.zip`（sha256 `1f689051…`，条目时间戳固定后为当前值）
  已写入 `market-out/catalog.json`；本地市场改用 `npm run market:serve`（`no-store`，替换掉 8000 端口上
  原 `python3 -m http.server`）；`pluginTriage` 68/68 全绿。
  端到端验收在**真实 userData 的克隆**上跑真实市场 IPC：catalog 见 `1.5.0` → `install(force)`
  成功 → `pluginsScan` 即时可见 → 侧栏进入岛后可断言页签集合。
  ⚠️ **装完必须重启宿主（或重载岛文档）**：宿主启动时会预载「上次所在岛」，
  该 iframe 文档仍持有旧产物（实测重载前 3 页签 / 重载后 4 页签含「商品清单」）。

### Added · 无忧物流运费支持按产品试算（`shipping-rate` 岛 1.2.0）

- **新页签「按产品试算」**：目的国下拉点名（选项即运价表国家行）→ 宿主自取产品库
  （`pl_products` 分页拉全 + `pl_variants` 联 SKU 克重）→ 逐 SKU 算出到该国实际运费。
  回答"我的产品发到某国每件运费多少"，与按订单试算（已成交订单侧）互补。
- **重量锚点是产品库 SKU 子表**（`pl_variants.weight_g`，编辑产品时维护），与订单侧的
  速卖通商品ID重量表（`pl_item_weights`）是**两条独立数据源**，不混用。
- 拒算逐行给原因（复用五分类纪律，产品侧为：缺克重 / 表没该国 / 无价 / 未接汇率），
  未维护克重的 SKU 单独成行提示「去产品库补克重」，不静默丢行；summary 各类互斥 Σ=total。
- 计价纯函数收在宿主新文件 `src/lib/shipRateProducts.ts`（复用 `shipRateQuote` 单点口径，
  国家只解析一次）；岛内仍零算术，op 数 5→6（shipping-rate 域 ≤ 10 预算内）。
- 门禁全绿：`tsc` / `vue-tsc` / `verify` / `vitest` 431（新增 8 用例）/ doc-links；
  岛 1.2.0 已发布 `market-out/shipping-rate-1.2.0.zip` 并同步本机安装目录。

### Changed · 「产品库」页签更名「识别库」+ 供应商页签降级只读（`order-insight` 岛 1.3.0）

- **正名**：订单归类里的「产品库」页签实际维护的是订单识别用的**识别库**（`oi_styles`
  款式编码池：款编码 / 款色 / 图片指纹），与产品库岛的款式主数据（`pl_products`）是两个
  数据域 —— 页签更名为「识别库」，导出文件 / sheet 名、空态文案同步，消除与产品库岛的混淆。
- **供应商维护迁移补完到运行侧**：1.4.0 迁移只改了宿主侧 `extensions/` 拷贝，市场分发的
  order-insight 岛（实际运行版本）的供应商页签仍带完整 CRUD。本次将其降级为**只读展示**
  （对账 / 拿货单仍需对照厂商），`supplierCreate/Update/Delete` 三个 op 移出岛能力声明
  （声明 ⊆ 调用守卫双向校验），空态与报错文案指向「产品库 → 供应商」。
- 门禁：`plugins:island:smoke` 6/6（识别库页签生效）· `vitest` 423/423 · 岛已发布
  `market-out/order-insight-1.3.0.zip` 并同步本机安装目录。

### Changed · 供应商维护迁移产品库 + 产品批量编辑（`product-library` 1.4.0）

- **供应商（厂家）主数据维护自「订单归类 → 拿货对账」迁移到产品库岛**：新增「供应商」页签
  （列表 + 产品数合并自 `product.summary`、新增/编辑/删除）。语义不变：编辑只改电话/备注
  （名称是 UNIQUE 键不可改）；删除沿用宿主守卫（已有拿货单/付款记录时拒绝）。拿货单 /
  付款 / 欠款对账等**业务视图**留在订单归类（数据同源 `suppliers` 表，读侧不受影响）；
  order-insight 侧移除 `SupplierModal` /「+ 新增厂商」/ 对账卡片「编辑」入口，空态文案指向产品库。
- 新增宿主 db 能力域 **`product-supplier`**（4 op：list / create / update / delete）：复用既有
  `purchase-supplier-*` IPC 通道，零新通道。岛声明窄域而不是 24 op 的 `purchase` 万能域 ——
  授权面最小化（C4）。
- **产品批量编辑**：列表勾选行后「批量编辑」，一次 op 覆盖厂家（含清空关联）/ 类目 / 状态 /
  备注。**部分 patch 语义**（与全量 upsert 刻意不同）：payload 未出现的字段宿主一律不动，
  界面留空即不改；`supplierId: 0` = 清空关联。code / name 不可批量改（跨域关联锚点）。
- 新增 IPC 通道 `product-batch-update`（handler / preload / types / ipc 四处同步）；
  `product-admin` 9→10 op **恰好满额**（N5），`product` 域不变 —— 再加任何 op 必须先拆子域。

### 验证与发布（1.4.0）

- 门禁全绿：`verify` ✅（172 通道）· `vue-tsc` 0 error · `vitest` **423/423**（op 预算守卫：
  product-admin=10 ≤ 10、新域 product-supplier=4 ≤ 10）· `product:smoke`（+3 批量编辑用例：
  部分patch只改传入字段 / 清空语义与状态兜底 / 空ids-无字段-厂家不存在各自抛错）·
  `product:sku:ui` **36/36**（新增：3 页签、批量编辑空 patch 拦截、部分 patch payload 形状、
  供应商列表与编辑弹窗名称锁定）· `plugins:island:smoke` / `product:sku:smoke` / `style:smoke` ✅。
- 岛 1.4.0 已发布本地市场（`market-out/product-library-1.4.0.zip`）；应用侧在「插件市场」更新后生效。

### Changed · 产品库 SKU 改为服装「颜色 + 尺码」组合（`product-library` 1.3.0）

- SKU 编辑由自由「名称」改为**颜色 + 尺码**两个输入（服装口径）：同款下组合唯一（复用
  `UNIQUE(product_id, name)`，成对时 name 自动生成为 "颜色 尺码"），编码 / 克重口径不变，
  每个颜色尺码组合的克重单独设置。
- 尺码**快捷批量选择**：字母码 / 身高码预设芯片，支持**按住拖动连选 / 连消**；自定义尺码回车
  加入；颜色输入支持 `，、空格` 分隔一次加多个；「生成组合」= 已选颜色 × 已选尺码笛卡尔积
  （已存在组合自动跳过），可设默认克重预填，生成后逐行改克重并「保存全部改动」批量提交。
- `pl_variants` 幂等补列 `color` / `size`（老库 `ALTER`，判定 `PRAGMA table_info`）；老行
  （仅自由文本 name）不回填不改写，界面标「旧」，补上颜色尺码保存后即升级为新格式。
- IPC 四处同步（handler / preload / `src/types.ts` / 岛）：`product-variant-upsert` 增
  `color` / `size` 字段，op 数与能力域划分不变（`product` 8 / `product-admin` 9）。

### 验证与发布（1.3.0）

- 门禁全绿：`verify` ✅ · `vue-tsc` 0 error · `vitest` 422/422 · `product:smoke`（+5 用例：
  组合生成 name 自动生成 / 重复组合 / 不成对 / 老数据兼容 / 更新升级）· `product:sku:smoke` /
  `style:smoke` ✅ · `product:sku:ui` 27/27 ✅（岛 dist 重新构建）。
- 岛 1.3.0 已发布本地市场（`market-out/product-library-1.3.0.zip`，catalog 已更新）；
  应用侧需在「插件市场」更新到 1.3.0 后生效。

### Added · 产品库图片 + SKU/克重维护（`product-library` 1.2.0）

- 产品（款）主图：编辑抽屉新增主图区（上传/更换/移除），落 `pl_products.image_id` + `pl_images`
  （SHA-256 去重，文件落 `userData/product-images/` **独立目录** —— 不复用 `oi_images`，订单域的
  孤图清理会删"无订单引用"的图，产品图挂上去必被误删）。
- 映射与关联列表新增商品ID「图」列：**三层回落** `itemImagePool`（手动覆盖图 `pl_item_images`
  → 订单识别图 → 款主图），逐 item 独立判定；支持设覆盖图 / 清除回自动图；缩略图走
  `imageThumbBatch` 合批转 dataUrl（岛 CSP 只有 `img-src 'self' data:`，远程图必须宿主落盘）。
- SKU 子表 `pl_variants`（**D3 部分提前**，DDL 与 P5 设计草案不同）：name/code/**weight_g**/status
  手工增删改；编码部分唯一索引 `WHERE code <> ''`（空编码互不约束）；同款重名/编码全局占用分别抛错。
- 能力域按 C4 再拆：`product` 只读 8 op（+`variantList`/`itemImagePool`）、`product-admin` 写 9 op
  （+`variantUpsert`/`variantDelete`）、新增 `product-image` 写域 4 op（attach/detach/itemSet/itemClear
  —— 并入 admin 必顶穿 N5 上限 10）。
- 宿主新增 `select-image` 通道（`dialog` kind 加 `'image'`）：系统对话框选中的文件才进
  `approveUserFile` 白名单（H-02 语义）；图片读取白名单按目录集合收敛
  （`IMAGE_CACHE_DIRS = Set(['order-images','product-images'])`），`sniffImageFormat` 收敛到
  `ipc-util` 两域共用。

### 验证与发布（1.2.0）

- 门禁全绿：`verify` ✅ · `vue-tsc` 0 error · `vitest` **422/422**（23 文件，含 pluginTriage
  修复 manifest 误声明 `order` 域后 66/66）· `product:smoke` **33**（+11）· `product:sku:smoke` /
  `shop:smoke` / `style:smoke` / `ae:smoke` ✅ · `plugins:island:smoke` ✅。
- 变异测试 **4/4 变红**（覆盖图层跳过 / 克重负数校验删 / 部分唯一索引丢 WHERE / item_id 归一去掉），
  直接改 dist 产物，收工 sha256 复原一致。
- 真机探针 5 步全绿（CDP + 克隆 userData）：列表图列 → 编辑抽屉主图/SKU 区块 → SKU UI 真点增删
  → 桥直调 4 域 op 权限链 → 映射页图列。上传图片端到端（系统文件框）未自动覆盖，需人工点一次。
- 发布：`market-out/product-library-1.2.0.zip`，本机 `<userData>/plugins/` 已同步。

### Added · 店铺套编辑抽屉「名下店铺」区块（`shop-accounts` 1.5.2）

- 编辑抽屉新增「名下店铺」段：登记/解绑这套账号实际经营的店铺（`sk_shops` 实体），立即保存、不等抽屉底部「保存」按钮。
  数据仍落 `sk_shops`（ADR-002 方案 B：UI 在店铺套、实体在主数据层），经 `shop_set_id` 软关联本套装
  （复用 `shop` 域 `list` 既有的 `shopSetId` 过滤，**未新增 op**）。
- 平台默认值 = 套装第一个平台的展示名经 `shopPlatformCodeFromLabel()` 映射到 `sk_shops` 的平台代码
  （两套词表对接）；映射不上时下拉停在占位项，由人显式选择（不猜歧义）。
- 解绑只解除关联：整行回传 + `shopSetId=0`（`shopUpsert` 全量提交语义下唯一安全的姿势），店铺本体保留、可改挂其它套装。

### Fixed · 店铺登记编辑表单会静默清空平台店铺ID（同轮连带发现）

- 店铺登记页的店铺编辑抽屉此前不回填也不透传 `platformShopId`，而 `shopUpsert` 是**全量提交**
  —— 编辑保存一次，已登记的店铺标识就被静默抹成空串（比报错更难查）。已回填 + 透传，并在岛 README 记入陷阱表。

### 验证与发布

- 端到端真机探针（CDP，克隆 userData）：区块存在 → 登记 → 桥查 `shopSetId` 关联与标识落库 → 解绑后 `shopSetId` 归 0，四步全绿。
- `shop:smoke` 基线绿 + **变异测试 4/4 变红**（标识查重短路 / 部分唯一索引丢 WHERE / 标识归一去掉 / `shopSetId` 过滤删除），收工复原逐字节一致。
- 门禁：`verify` ✅ · `vue-tsc` ✅ 0 error · `vitest` ✅ 23 文件 / 421 例（含 pluginTriage，岛 `actions` 未变）。
- 发布：`market-out/shop-accounts-1.5.2.zip`（sha256 `8fc1193b…ed284`），本机 `<userData>/plugins/` 已原子替换。

### Fixed · 店铺登记页「账号套装」下拉恒为空（`shop-accounts` 1.5.1）

- **根因是形状错配，不是数据或权限**：`shop` 域的 `list` 返回 `{ rows, total }`，而 `shop-accounts` 域的 `list`
  返回**裸数组**（账号主页 `store.ts` 一直按数组消费、显示正常）。店铺登记页却按
  `acc.data?.rows ?? []` 取值 —— 对数组取 `.rows` 恒为 `undefined` → 下拉永远只剩「— 未关联 —」。
- 修复：按「数组优先、对象回落」双形状兼容取值，并把两个域返回形状的差异写成注释钉在调用点。
- 真机取证（CDP 克隆真实 userData）：修复前 `shop-accounts.list` 实际**能返回全部 14 条**（桥/权限/数据均正常），
  纯视图层取值 bug；修复后端到端点开「店铺登记 → 新建店铺」，下拉 **15 项**（占位 + 14 套）。
- 发布：`market-out/shop-accounts-1.5.1.zip`（sha256 `66f6b70c…5910`），本机 `<userData>/plugins/` 已同步。

### Changed · 文档与基线整理 + 一处冒烟计数的自维护（2026-09-27）

- **文档索引重写**（`docs/README.md`）：主旨压到一行、状态列与各文档头部去重、补上漏登记的 `CHANGELOG.md` / `CONTRIBUTING.md`；
  删掉「版本管理策略」里那条**已过期且自相矛盾**的注记（它说 `PLUGIN_ARCHITECTURE.md` 不入库会导致悬空引用，而该文件早已入库、`R4-5` 也已定案）。
  该文件**现在通过 prettier**（此前不过）。
- **基线瘦身**（`docs/baseline/PROJECT_BASELINE.md`）：§10 把那个 2400 字符的巨型单元格拆成「门禁表 + 10.1 守卫分布 + 10.2 六类盲区」；
  §6 的"表/对象怎么数"改为**可复跑口径**（并纠正一处算不通的 `sqlite_master` 说法）；§7 补上此前漏登记的 `product:sku:smoke` / `style:smoke` 两个脚本；
  §9 文档表合并同类行、去掉已删文件的占位行。
- **跨文档事实订正**：`DOMAIN_INTEGRATION_PLAN.md` 的稳态对象数（32→**33**）、`verify`（161/157→**166/162**）、
  `vitest`（22 文件 393 例→**23 文件 421 例**）、db 域个数（8→**9**，含 P3 拆出的 `product-admin`）；
  `REMEDIATION_PLAN.md` 头部状态从"📋 已制定，待执行"改为实际进度 **25 / 27**（并说明执行中新增 `R2-8` 使总数 26→27）。
- **修掉一处会持续漂移的硬编码**：`scripts/ae-cost-smoke.cjs` 收尾打印的"（13 项）"与实际用例数早已不符（真值 **16**）。
  改为由新增的 `passed` 计数器自算 —— 这类数字不再需要手改。
- **新增纪律**（写进 `docs/README.md` 维护规则 5）：IPC 通道数 / 用例数 / 表数这类每轮都变的量**只在 `PROJECT_BASELINE.md` 出现一次**，
  其他文档引用而不转抄。本次清理的起因正是同一数字在三处各写一遍、其中两处已过期。

### Added · 产品库「映射与关联」+ 款式主数据写入权移交（`docs/features/PRODUCT_LIBRARY.md` 的 P3 / `ADR-002 D1`）

- **要解决的问题**：产品库有了主数据，但**订单和产品之间没有任何关联** —— 订单行里的商品ID只是自由文本，
  没人知道它属于哪个款。于是"按产品算利润 / 按产品出拣货单"这一步永远走不通。
  同时 P1 引入 `pl_products` 后，**"款式名"出现了两个写入方**（订单归类写 `oi_styles.name`、产品库写 `pl_products.name`），
  直接违反 ADR-002 的 **C1 单点写入**。
- **两件事同批做**（P3 =「映射与关联」，D1 是它的前置）：
  1. **新增 `pl_shop_sku`**（`electron/product-db.ts`）—— `(platform, shop_id, item_id, spec)` 唯一键，
     `spec='*'` 通配兜底，`shop_id` 外键 → `sk_shops`（S1 建的店铺实体）。**只有 `status='confirmed'` 才算命中**。
  2. **D1：`pl_products` 成为款式主数据的唯一权威**，`oi_styles` 降级为「识别编码池」。
- **D1 的落法（`electron/order-db.ts`，主进程 —— 岛侧零改动）**：
  - **写侧**：`migrateStyleAuthority()` 在 `ensureOrderSchema()` 末尾把老库的 `oi_styles.name` 灌进 `pl_products`
    （缺哪补哪、已有产品不动），随后**清空遗留列**——两步在**同一事务**里（插入失败就不清源数据），幂等。
    此后一律写**空串哨兵** `VALUES (?, '', ?)`：哨兵不携带信息，结构上不可能与主数据分叉。
  - **读侧**：原来有 **4 处活读点**在 `oi_styles.name` 上（v4 文档只写了 2 处）——`listStyles`、
    `listOrdersPage` 的 `style_name`、`listOrdersPage` 的**搜索条件**、`purchase-db` 的两处 JOIN（采购域也是消费方）。
    统一改为 `LEFT JOIN pl_products p ON p.code = s.code` 取 `p.name`。用 **LEFT** 而非 INNER：
    产品行缺失时**仍要列出该款**（INNER 会让"少一行"看起来像"没这款"），且**回落空名而不是回落遗留列**。
  - **为什么保留 `oi_styles.name` 列而不 DROP**：`oi_style_colors` / `oi_style_fingerprints` 两张表都
    `REFERENCES oi_styles(id)`，删列要重建表 —— 为一个没有业务价值的列做不可逆结构手术，风险收益倒挂。
  - **改名走新增的窄接口 `renameProduct(code, name)`**，**不用 `upsertProduct`**：后者是**全量提交**语义，
    只传 `{ code, name }` 会把厂家 / 类目 / 状态 / 备注**静默重置成默认值**（静默清空比报错更难查）。
  - **跨域交接用 `adoptProduct(input, { overwriteName })`**：已有产品默认**不覆盖** name（识别结果不得盖掉人工主数据），
    只在主数据名为空时补位；`overwriteName: true` 只给「产品库 Excel 导入」这种**显式产品库写入**语义。
  - **编码池有两个来源**：`nextStyleCode()` 改为 `SELECT code FROM oi_styles UNION SELECT code FROM pl_products`
    —— 只查前者会让产品库先占用的编码又发一次，撞唯一键，而报错指向产品库（排查方向被带偏）。
- **订单导入接 `resolve`（确定性优先，零 API 成本）**：`order-db.insertOrder` → 新增的 `autoAssignByMap`
  → `product-db.resolveOrderSku({ shop, itemId })`：店铺**文本**先经 `sk_name_map` / 店铺实体归一成
  `platform + shop_id`（**归一不了就不命中**，不拿空平台硬凑 —— 那会把不同平台的同名店并到一个键上）→
  查 `pl_shop_sku(status='confirmed')` → 命中就归到该产品的款色。**未命中什么都不做**（不清空 AI 已归的款色）；
  **不 catch**（吞掉会让"看着导入成功却没归款"变成查不出的问题，而 `insertOrder` 幂等重入会再试一次 = 可自愈）。
  产品库手工建的款没进过识别链路 → 命中时补一行 `oi_styles` 占位，指纹用 **`mapped:<code>` 前缀**
  （真指纹不可能以此开头，故不会互相误命中）。
- **`DB_OPS` 按 C4 拆域**（`src/core/plugin/host.ts`）：P3 的 5 个 op 会把 `product` 顶到 13 个，**顶穿 ADR-002 N5 的 10 上限**。
  故拆成 **`product`（共享只读 6 op：`list`/`get`/`summary`/`skuList`/`skuSummary`/`skuQueue`）**
  与 **`product-admin`（owner 写 7 op）**。**这不是洁癖**：`security.ts` 的 `decidePermission` 对 `domains` 与
  `actions` **分别检查**、两者彼此独立 —— 写 op 与读 op 同域时，消费方只要声明这个域就够得着全部 op，
  "我只读"只能靠自觉；拆开后它变成**结构事实**。P3 计划的 `mapList`/`unmapped` 落地为 `skuList`/`skuQueue`，
  `resolve` **有意不建 op**（消费方在主进程内，渲染层/岛侧零调用点）。
- **岛侧**：`ui-plugins/product-library` **1.0.0 → 1.1.0**，新增「映射与关联」页签
  （待关联队列按 `(店铺, 商品ID)` 聚合、可批量勾选一次提交；已建立映射支持改绑 / 标失效 / 恢复）。
  **改内容必须升 `manifest.version` 并重跑 `publish-plugin.js`** —— 否则市场与 `<userData>/plugins/` 都还是旧版。
  已发布 `market-out/product-library-1.1.0.zip`。
- **IPC 四处同步**：+5 通道（`product-sku-*`）→ `verify` **166 ≡ 166 / 162 通道**（`product-handlers:16`）。
- **守卫与验证**：
  - `scripts/style-authority-smoke.cjs`（**22/22**，`npm run style:smoke`）：A 老库交接 / B 写侧唯一 / C 读侧五处派生 / D 订单导入接 resolve。
  - `scripts/product-sku-smoke.cjs`（**23/23**）：含**验收原文**「1000 行陌生订单 → 1000 组全部进队列，无丢行」与「批量确认后 100% 命中」。
  - **变异测试 22/22 全中**，带「基线必须绿 / 补丁唯一命中 / 收工比 sha256」三道自检。本轮它自己抓出**两条假守卫**：
    ① 两道防线互为兜底（`if (!shopId) return null` 先拦住，变异到不了 SQL）→ 拆成 D4a（脏映射考防线本身）+ D4b（换一家已登记的店考店铺维度）；
    ② 判据正则 `/([A-Z]\d+)\b/` 匹配不到 `D4a`（`4` 后是字母，无单词边界）→ 真失败被漏数、**方向完全反**地报成"假守卫"。
    **这就是「用例全绿 ≠ 守卫有效」的实例**：不做变异，这两条会一直以"通过"的身份躺在报告里。
  - 真机 `npm run plugins:island:smoke`：**6/6** 岛握手 + 首屏正常（本岛 3468B），重启后自动回到上次所在岛。
- **一处结构性文档修复**：`docs/features/PRODUCT_LIBRARY.md` §7 的验收表原先被一个 `> ⚠️` 引用块**从中间劈开**
  （P3 行与 P4 行之间），导致 P4 / P5 两行实际渲染成了引用块文本 —— `prettier --write` 直接把它改写成 `> > |`，
  把这个错**显式化**了。现已把注记移到表格之后，并补上 §7.3 P3 验收逐条对账。
- **已知缺口（如实记）**：① 消费岛（订单归类 / 利润追踪）**尚未**声明 `product` 域 —— 映射结果目前只有
  订单导入这一个消费方；② `shop` 域仍是写读同域（S1 遗留，放行给别的岛之前要先按 C4 拆）；
  ③ 导入的第一步是系统文件框，CDP 驱不动 → "选真实文件 → 看到结果"**没有端到端自动验证**，
  仍需人工点一次；④ D1 的读写切换只有 DB 层冒烟证据，没有真机端到端。
- **文档回写**：`docs/features/PRODUCT_LIBRARY.md`（v7，§5.1 / §6.2 / §6.3 / §7 / 新增 §7.3）、
  `docs/baseline/PROJECT_BASELINE.md`（表数 **31 业务表 / 33 对象**、IPC 166/162、`product-library` 1.1.0、`shipping-rate` 1.1.0 补记）、
  `docs/README.md`、`ui-plugins/product-library/README.md`（新增第四条口径 + 三条陷阱）。

### Added · 店铺实体与名称归一（`ADR-002 S1`）—— `docs/plans/DOMAIN_INTEGRATION_PLAN.md` 的 S1 阶段

- **要解决的问题**：店铺**实体根本不存在**（该计划 D1/D2）。店名以自由文本各存三处且互相拷贝
  （`oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name`），"某家店的订单 + 拿货成本 + 毛利"
  这个业务问题在三处各算一遍且互不相识。S1 补上实体层与名称归一映射表。
- **两张新表**（`electron/shop-db.ts`，宿主侧 = 主数据，ADR-002 C3；卸载任何岛都不影响数据供给）：
  - `sk_shops` —— 店铺实体，UNIQUE 建在 **`(platform, name_key)`** 而非 `name` 上。
    ⚠️ `name_key` 不是冗余列：只对 `name` 建唯一约束，`"店A"` 与 `"店A "` 会同时入库 → 同一个归一键命中两家店 →
    "精确命中"的语义当场破产。
  - `sk_name_map` —— `(kind, raw_key) → ref_id / ignored` 的归一映射（`kind` 预留 `supplier`/`style`/`product`，
    供产品库 P3 复用）。**历史文本一律不改写**（G2）：查询时旁挂归一，映射可撤销。
- **`shop` 能力域 8 op**（`electron/shop-handlers.ts` + `src/core/plugin/host.ts`）：
  `ensure` / `list` / `get` / `upsert` / `summary` / `unmapped` / `map` / `unmap`。IPC 四处同步
  → `verify` **161 ≡ 161 / 157 通道**（`shop-handlers:8`）。
- **六条口径（都是被真实数据/项目规则逼出来的，改宽之前先读理由）**：
  1. 归一 = **去空白 + 剥不可见字符**（U+200B–200F / U+2028 / U+2029 / U+FEFF，全角空格与连续空白并成单个半角空格）。
     **不做**大小写折叠、**不做**模糊匹配、**不做**"去掉所有内部空白"——内部空格在真实数据里是**有效差异**（G6）。
  2. **不猜歧义**：同一个归一键命中 >1 家店（同名不同平台是合法的）时**不给**"一键采纳"的建议。
  3. **未归一名单是实时聚合**（`listUnmapped` 每次扫三处文本），不是缓存表 —— 否则删订单 / 重导后名单与源头不一致。
  4. **映射表只存"人的决定"**：不写 `source='auto'` 占位行（故 `source` 至今只有 `manual` 一个值）。
     ⇒ 设计文档 §3.3 原写的"首启动扫描并写入 `ref_id=0` 的 auto 行"**在实施时被改掉了**，理由已回写该节。
  5. **模糊匹配只作排序提示、永不写 `ref_id`**（G6）→ `sk_shops` **有意不建 `confidence` 列**（没有任何生产者）。
  6. `shop_set_id` 对 `sk_shop_sets` 是**软关联**（整数、无外键），套装删除后 id 仍在、只用于回显。
- **纯函数层单独成文件**（`electron/shopName.ts`）：`toNameKey()` / `mergeNameGroups()`。
  **为什么要单独一个文件**：主进程 `*-db.ts` 依赖 `better-sqlite3`，按 Electron ABI(149) 编译，而 vitest 跑在系统
  Node(127) 上直接 require 会崩 —— 把归一逻辑摘成**零依赖**模块，它才进得了 vitest（`tests/shopName.spec.ts` 15 例）。
- **岛侧**：`ui-plugins/shop-accounts` **1.4.4 → 1.5.0**，新增「店铺登记」页签
  （统计 chips / 未归一名单：一键采纳·指派·新建并绑定·忽略 / 店铺实体表 / 过期映射说明 / 抽屉表单）。
  已发布 `market-out/shop-accounts-1.5.0.zip`（`sha256 5f7c1313…`，11 文件；catalog 含 6 个插件）。
- **守卫与验证**：`tests/shopName.spec.ts`（15 例，每条"应等价"都配一条"不得等价"的反向断言）、
  `scripts/shop-db-smoke.cjs`（**25/25**，含"未归一名单覆盖 `oi_orders` 每个店铺名且计数一致"这条**验收原文**的用例）、
  `scripts/shop-registry-smoke.mjs`（**真机 CDP 8/8**：「店铺登记」页挂载 / 面板渲染 / **无 error-bar（= 4 个 shop op 全过权限门）** / chips 渲染）。
  变异验证：`shp('unmap')` 改坏 → 变红；从 manifest 删 `map` → 变红（带"基线必须绿 / 收工必须复原（比 sha256）"两道自检）。
- **顺带查出并冻住的存量问题**：新增「宿主 db 能力域的 **op 预算**」守卫（ADR-002 N5，单域 ≤10）后，
  首次量化出**三个域早就超预算**：`order-insight` **37** / `purchase` **24** / `shop-accounts` **17**（此前无人知道）。
  它们进 `GRANDFATHERED` 豁免表并**只允许变少**，另加一条断言防止"豁免表被当垃圾桶塞新域"。
- **已知缺口（如实记，属 S2/S3）**：① 消费岛（订单归类 / 利润追踪）**尚未**声明 `shop` 域 —— 映射结果**还没有任何消费方**，
  所以 D1 只是"部分收敛"；② `shop` 域**写读同域**（`upsert/map/unmap` 与 `list/summary/unmapped` 混在一起），
  与 ADR-002 C4「共享域只读」冲突，**放行给其他岛之前必须先按 C4 拆只读子域**；
  ③ `sk_name_map.kind` 的三个预留值**无生产者**（产品库 P3 才接）。
- **文档回写**：`docs/plans/DOMAIN_INTEGRATION_PLAN.md`（§0/§1.1–§1.4/§3.3/§4.1 + 新增 **§4.3 执行记录**）、
  `docs/baseline/PROJECT_BASELINE.md`（§0/§3/§4/§5/§6/§7/§9/§10）、`docs/README.md`、`docs/features/PRODUCT_LIBRARY.md`。
  其中基线 §3/§5/§6/§9/§10 是**全量重扫**（此前各行快照日期不一、已明显失真）：
  §6 的"25 业务表 / 27 个对象"被订正为 **30 业务表 / 32 个对象**（漏了 `pl_*` 与 S1 的两张新表，
  且其自身枚举逐行相加也得 26 而非 25）；§9 补上**长期漏列的 `plans/` 与 `decisions/` 两个整类**；
  §10 的 IPC 数字 153/149 → **161/157**。

### Added · 产品库 UI 岛（`ui-plugins/product-library` 1.0.0）—— `docs/features/PRODUCT_LIBRARY.md` 的 P2 阶段

- **形态**：市场分发的独立 vite 工程岛（`kind: ui`，`entry: ./dist/index.html`），id **不入**
  `modules.config.json`（红线 23）。数据层仍在宿主（ADR-002 C3）：岛只是维护界面，卸载岛不改变任何消费方的数据供给。
- **能做的事**：列表检索（关键字 / 状态 / 全量厂家下拉）、新增与编辑（编辑时 `code` 只读；编码冲突
  留在表单内可见而不是只弹 toast）、批量删除（二次确认，文案引导"已进业务链路的改用停用"）、
  **Excel 批量导入三步向导**（选文件 → 预览并**就地修正**错误行的编码/款式名 → 结果页列出失败行与原因、
  可返回再导一次）、导出当前筛选下的全量行 / 下载导入模板。
- **解析与校验只在宿主**（`src/lib/productImport.ts`，427 行纯函数）：岛所在 iframe 的 CSP 无
  `unsafe-eval`，岛也不打包 xlsx；更要紧的是"哪列是编码 / 厂家名怎么对 id / 状态怎么认"必须只有一份口径。
  列名走**语义扫描**（精确命中优先、再退到包含且长键优先），表头在横幅/说明行之后仍能定位（前 10 行探测）。
- **两条路径共用一个 op**（op 上限 10，不为"预览"再开一个）：`importProducts` 传 `filePath`（宿主读表 +
  逐个 sheet 体检 + 校验）或 `rows`（把界面上改过的行回传），`dryRun: true` 只预览不落库。
- **`DB_OPS['product']` 6 → 8 op**（`importProducts` / `exportExcel`）；IPC 四处同步（+2 通道，
  `verify` **153≡153 / 149 通道**）。⚠️ 写 op 已达 8，P3 计划的 4 个只读 op 加进来会超过 ADR-002 N5 的
  上限 10 —— **P3 开工第一步须按 C4 拆只读子域**（见 `PRODUCT_LIBRARY.md` §6.2）。
- **行级错误不得冒泡出事务**：500 行里有 1 个空编码若整批回滚，用户会"一行都进不去"，而 P2 验收要的正是
  「490 入库、10 行可重试」。冒烟 `product:smoke` 新增 4 条把这条钉死（18 → **22 项**）；变异验证：
  把行级 `catch` 改成 `throw e` → 立刻 3 条变红。
- **顺手修掉两处既有隐患**：
  - `productSummary().supplierOptions` 原先只返回「**已有产品**的厂家」→ 用户给产品关联一个**新厂家**时
    下拉里根本没有该项，症状像界面 bug 而不是数据问题。改为返回**全量厂家**（计数为 0 的也在）。
  - 「空编码」这类行级问题原先只能靠界面 toast 提示，改为随预览/结果**逐行回传**（带 `ok` 标记与原因）。
- **守卫**：`tests/pluginTriage.spec.ts` 新增 product-library 组（8 条），并修掉三处**让守卫形同虚设**的问题 ——
  ① `apiBindings()` 原先只认产物里的 `dist/api.js` 与源码侧的 `.ts` 后缀写法（后者其实从未存在——所有岛的
  api 文件都是 `.js`），两个 vite 工程岛（`ae-profit` / `shop-accounts`，源码在 `ui-plugins/ae-profit/src/api.js`、
  `ui-plugins/shop-accounts/src/api.js`）**整岛逃过**「调用 ⊆ 声明」与能力缺口检查；现支持三种既有写法（helper 绑域 /
  `dbCall(DOMAIN_X, 'op')` / 桥里硬编码域）② `stripComments()` 用两条正则剥注释，会把行注释里的
  `@/core/services/` 后跟星号当成块注释开头，**吞掉后续真实代码**（症状是把域解析成常量名本身）；改为逐字符扫描
  ③ `hostDomainOps()` 只认带引号的域键，而主数据域按 ADR-002 N4 用**裸标识符**（`product: {`）→ 返回空数组。
  另新增：manifest 声明的 op 必须都存在且**都被真实调用**（多声明 / 少声明都算缺口）、岛内禁 `eval`/`new Function`/
  xlsx、禁直连 `electronAPI`、`manifest.version == package.json.version`、**dist 与 src 的 db 调用点一致**（防产物陈旧）。
  变异测试 **14/14 命中**（+1 条等价改写对照），且脚本带「基线必须绿」「收工必须复原」两道自检 ——
  上一轮某条变异的残留曾让下一轮对照直接变红，而 `git status` 看不见（岛目录整体未跟踪）。
- **发布与真机**：`market-out/product-library-1.0.0.zip`（`sha256 5d79e293…`，catalog 含 6 个插件）；
  按「下载 → 校验 sha256 → 解压落盘」的真实安装路径装到 userData 后跑真机冒烟 **6/6** 岛通过
  （侧栏出现「产品库（UI 岛）」，握手 + 首屏 3398B 非空，重启恢复到上次所在岛）。
- **已知缺口（如实记）**：导入的第一步是主进程弹**系统文件框**，CDP 驱不动 ——
  "点导入 → 选一个真实 500 行 xlsx → 预览出 490/10"这条**没有端到端自动验证**，
  被拆成前后两半分别覆盖（卡面之前：`tests/productImport.spec.ts` 24 例；卡面之后：`product:smoke`），
  中间那次「宿主读 xlsx」由 order-insight / excel-copy 的既有链路覆盖。端到端仍需人工点一次。

### Added · 「按订单试算」：订单（收货国家 + 商品ID）× 商品重量 × 运价表 → 逐单实际运费

- **数据源头补齐**（此前三段数据都在但都没接上）：
  - 商品重量：新表 `pl_item_weights`（商品ID → 克），由速卖通「商品信息」Excel 导入
    （`src/lib/productWeight.ts`：列名语义匹配、表头位置不写死、kg/g 按列名判、同 ID 后到先得；
    宿主 op `importProductWeights` 逐张 sheet 探测、取条数最多的一张）。重量挂**商品ID** 而非
    `pl_products.code`：商品ID → 产品的映射属产品库 P3，提前进款表等于替 P3 造口径不明的字段。
    > ⚠️ **以上整条链路已于 2026-10-01 删除**（用户领域裁定：克重是 SKU 属性，改挂 `pl_variants.weight_g`，
    > 在「货与成本」按 SKU 维护）。上面点名的那个纯函数文件随之删除、**现在不存在** ——
    > 本段是**删除记录**，不是"该文件在这里"。原文保留不改写，只为让后来者对得上当时的决策。
  - 订单目的地：`oi_orders.raw_fields`「收货国家」多键名回落提取；国名 → 运价表国家行**直接对表解析**
    （`src/lib/shipRateOrders.ts`：归一化 + 以运价表实际写法为准的少量别名 + ≥4 字符才启用前缀包含），
    不另维护国名映射表。
  - 订单原始行：新只读通道 `order-shipping-rows`（`oi_orders` 最小投影 `id/order_no/raw_fields`）——
    `listOrdersPage` 刻意不带 raw_fields，这里单独开口且大载荷到宿主为止。
- **逐单计价**：`quoteOrders` 复用 `shipRateQuote` 的选卡/币种拒算/取整口径（不另写实现）；拒算分五类
  （缺重量 / 无国家 / 表没该国 / 该克重无价 / 未接汇率），**逐行携带 `reasonClass`** 供岛分桶展示。
  ⚠️ 数量刻意按 **1 件/行**：多产品订单拆行后每行仍带原始「数量」列值，用它会把 3 件拆 3 行按 3 件算
  （3×3 错算）；多件口径留待 UI 明确选择后再做（PLAN §8 第 6 项）。
- **岛侧**（`shipping-rate` → **1.1.0**）：新增「按订单试算」页（重量表导入 + 逐单结果，五类拒算分 chip）；
  `db` 域 actions 增 `importProductWeights` / `productWeightStats` / `quoteOrders`。
- **验证**：`tests/shipRateOrders.spec.ts` 23 例全绿（累计 332）；变异测试 **7/7 变红** ——
  其中两条现形的是**测试问题而非实现问题**：对称交换计数器不破坏汇总断言（补 `reasonClass` 行级绑定）、
  别名与前缀包含互为兜底（改用只有该路径能到达的用例：`UK` 两字符、`United States of America` 带后缀）。
  真机 CDP 冒烟 5/5 岛 + 新页空库态渲染正确；已发布 `market-out/shipping-rate-1.1.0.zip`
  （`sha256 50d43f76…4405`，catalog 原地替换 1.0.2）。

### Added · 产品库宿主数据层（产品主数据 + 6 个 IPC 通道 + `product` 能力域）

- **范围**：本轮只做**宿主数据层**。UI 岛（`ui-plugins/product-library`）与订单自动关联未开工；
  成本维护界面阻塞于 `ae_cost_map` 生效区间改造（见
  [`docs/decisions/ADR-002-master-data-layer.md`](docs/decisions/ADR-002-master-data-layer.md) Q2）
  —— **该阻塞已于同日解除**，见下方 Changed 段。
- **数据层** `electron/product-db.ts`：新增 `pl_products` 表（`code` UNIQUE / `name` / `supplier_id` /
  `category` / `status` / `note`），含 `ensureProductSchema` / `listProducts` / `getProduct` /
  `upsertProduct` / `deleteProduct` / `productSummary`。**编码与既有链路同口径**（`oi_styles.code` →
  `purchase_items.style_code` → `ae_cost_map.style_code`），是后续「店铺商品 ID → 产品」映射与订单自动关联的
  唯一锚点；编码冲突**明确抛错**，不静默改名或覆盖。厂家**只存 `supplier_id`**，名称从采购域 `suppliers`
  派生 —— 同一语义不留两个写入者（ADR-002 C1）。
- **IPC** `electron/product-handlers.ts`：新增 6 个语义化通道 `product-db-ensure` / `-list` / `-get` /
  `-upsert` / `-delete` / `-summary`，经 `electron/ipc-util.ts` 注册；`preload.ts`、`src/types.ts`、
  `src/core/services/ipc.ts` 三处同步，`electron/main.ts` 挂载。
- **能力域** `src/core/plugin/host.ts`：新增 `DB_OPS['product']`（6 op，低于 ADR-002 N5 的 10 上限）。
- **验证**：新增 `scripts/product-db-smoke.cjs`（`npm run product:smoke`，18 项）—— `better-sqlite3`
  按 Electron 的 Node ABI 编译，**vitest 无法覆盖 DB 层**，故照 `mail:smoke` 先例用 `electron` 跑冒烟。
- **文档**：[`docs/features/PRODUCT_LIBRARY.md`](docs/features/PRODUCT_LIBRARY.md) 新增「实施进度」表，
  标注已落地 / 未开工 / 阻塞项。

### Changed · 成本口径改造：`ae_cost_map` 支持生效区间，手工成本不再被对账导入清掉（P4a / ADR-002 Q2）

- **改造前的真实行为（不是"口径问题"，是数据丢失）**：`ae_cost_map` 是 `style_code TEXT PRIMARY KEY`
  （一款一行、无生效日），`costMapReplace` 走 `DELETE FROM ae_cost_map` **全表清空**后重灌 ——
  产品库一开放成本录入，下一次「拿货对账」导入就把用户手填的成本**整表抹掉**；且利润引擎只认
  "当期一行"，同一款跨两次进货的历史毛利复算不出来。
- **`electron/ae-db.ts`**：`ae_cost_map` 改 **`(style_code, effective_from, source)` 复合主键**
  （一款多行、带生效区间；主键含 `source` 才能让同 (款, 生效日) 的 `manual` 与 `purchase` **并存**，
  再由读取侧定优先级）。新增 `migrateCostMapIntervals()`：SQLite 不能改主键，故走
  `rename → create → copy → drop`（整体在事务内）；存量行补**基准生效日 `0000-01-01`** ——
  该值早于任何真实业务日期，保证**迁移瞬间历史订单毛利不变**（若补成 `last_biz_date`，
  早于该日的订单会取不到成本，属回归）。幂等判定 = `effective_from` 列是否存在。
  `costMapReplace` 的 `DELETE` 收窄为 `WHERE source='purchase'`；新增 `costMapUpsertManual()`
  （手工写入，界面归 P4）；`costMapList()` 增出 `effectiveFrom`。
- **`electron/purchase-db.ts`**：`costSnapshot()` 由 `GROUP BY style_code` + `MAX(biz_date)` 改为
  **`GROUP BY style_code, biz_date`** —— 这是设计文档漏掉的一环：不改源头的话一款永远只导出一行区间，
  上面的多行结构白改、验收不可能达成。`lastBizDate` 语义随之从「该款最近一次拿货日」变为「本行的拿货日」。
- **`electron/ae-engine.ts`**：成本取数由「全表字典」改为**按订单业务日期取区间**
  （`effective_from <= 订单日` 取最近一条，同生效日 `manual` 优先；无命中**回落最早一条**，
  不把历史订单判成缺成本）。
- **零岛侧改动**：`ae-profit` 岛本就渲染 `source` 列，且快照 `lastBizDate` 直接作为 `effective_from`
  落库 —— IPC 形状、`domains`、manifest 均未变，**未发新版本**。
- **验证**：新增 `scripts/ae-cost-smoke.cjs`（`npm run ae:smoke`，**13 项全绿**）：老库迁移零丢失 + 幂等、
  手工行不被对账导入清掉、同 (款, 生效日) `manual` 优先、跨两次进货两笔订单分别按当时成本、
  快照按拿货日分组（含 `draft` 单必须被排除）、无命中回落最早、汇率变化不影响已取到的成本。
  `npm run verify` 通过（**未改 IPC 契约**：`ae-handlers` 仍 9 通道）。
- **未覆盖（勿误认为已解决）**：`ae_rates` 仍无生效区间 → 「改汇率会改变历史毛利」这条**仍在**，
  归 `ADR-002` Q2 后续范围；手工成本的**写入口**只到数据层（IPC / host op / 界面随 P4 一起做）。
- **文档**：[`docs/features/PRODUCT_LIBRARY.md`](docs/features/PRODUCT_LIBRARY.md) 出 **v5**（记录 P4a 落地时
  纠正的 4 处 v4 错误预期，其中「改汇率不影响历史毛利」如实标 ❌ 并移出本阶段验收）；
  `ADR-002` Q2 删掉已废弃的 `pl_cost_cards` 表名；`DOMAIN_INTEGRATION_PLAN` 的 G5 / D4 / 数据流图 /
  实体锚点表 / 章节号漂移全部回写；PRODUCT_LIBRARY §11 的「引用方待同步」转为「已同步」记录。

### Added · 新增 UI 岛 `shipping-rate`（无忧物流运费：输入克重 → 算出到每个国家的实际运费）

- **需求**：读物流报价 Excel 的「无忧物流-标准」sheet，输入实际克重（g）→ 列出全部目的国的实际运费；
  报价单数值会随谈价变更，**必须支持更新运价数据而不改代码**。方案与执行记录见
  [`docs/archive/plans/SHIPPING_RATE_ISLAND_PLAN.md`](docs/archive/plans/SHIPPING_RATE_ISLAND_PLAN.md)。
- **数据建模（宿主侧纯函数）**：报价单不是一张二维表，而是 **17 段列结构互不相同的价卡拼在同一张 sheet** 上
  （268 行 × 40 列）。归一化后为 **184 个国家 / 857 张价卡（791 `perKg` + 66 `firstStep`）**；
  已逐段验证 **17 段的国家集合两两不交**，故不需要任何优先级/覆盖规则。新增
  `src/lib/shipRate.ts`（解析，479 行）+ `src/lib/shipRateQuote.ts`（计价，218 行）：
  按**语义**扫描定位价卡列（不依赖列下标）、两种计价模式共存（`perKg` = 配送服务费元/KG × g ÷ 1000 + 挂号费；
  `firstStep` = 0.5KG 首重 + ⌈(g−500)÷500⌉ × 续重），且**模式是价卡级属性**——
  摩洛哥大包 0–5000g 走 `perKg`、5000–30000g 走 `firstStep`。
- **三类计费**（普货小包 / 非普货小包 / 大包）：按克重自动判定（≤2kg 小包、>2kg 大包）并可手动切换；
  类别是**集合**（韩国「小包普货&小包非普货计费」同时命中两类）；带仓库前缀的变体（乌克兰「其他仓 / 香港仓」）
  只做同变体匹配、**不替换**，无前缀变体优先。逐段回溯合并单元格时不得越过类别起点（否则大包会继承小包的 `0~2000g` 档）。
- **解析容错**：`暂无服务` / 空单元格 = 「该路向不提供服务」（`null`，不是异常），**只有非数值脏数据才记 warning**——
  修订前会误报 101 条「首重价缺失」，现为 **0 条**。
- **UI 岛**（`ui-plugins/shipping-rate/`，原生 ESM 手写岛：`dist/` 即源码、**无构建步骤**、零 npm 依赖，
  与 `excel-copy` / `order-insight` 同形态）：两页签「报价」「运价表」。报价页＝克重输入（局部重绘保焦点/输入法）、
  筛选、类别手动切换、进位方式（四舍五入 / 进位到分）、复制单国行或整表、克重变更后的「结果已过期」提示；
  运价表页＝来源信息（文件 / sheet / 导入时间 / 国家与价卡覆盖率）、解析告警、17 段结构表、逐国价卡明细，
  外加换 sheet 与「两步确认」清空（iframe 内不弹原生 `confirm`）。
- **能力边界（沿用基线硬约束）**：Excel 解析与费用计算**都在宿主**——新增 db 能力域 `shipping-rate` 的
  `parseRateSheet` / `quote` 两个 op（`src/core/plugin/host.ts`）；岛内不打包 `xlsx`、不出现
  `eval` / `new Function`（iframe CSP `script-src 'self'` 无 `unsafe-eval`），岛只做「收集参数 → 调用 → 渲染」。
  **未新增 IPC 通道**（复用既有 `importExcelByPath` + 动态 `import('xlsx')`），故 `electron/preload.ts` 与
  `src/types.ts` 的 141 项契约不变。
- **运价更新流程**：归一化后的运价表落岛自己的命名空间 `modules.shipping-rate`（`useModuleStorage` 同源机制），
  换版只需在「运价表」页重新导入一次，之后**离线可用**；清空是显式写入 `{table:null, source:null, sheetNames:[]}`
  （宿主写回是**合并**语义，不能靠「不传」来清空）。
- **测试与守卫**：新增 `tests/shipRate.spec.ts`（30 例：结构自洽 / 三个算法陷阱 / 计价与边界 / 载荷预算）；
  夹具 `tests/fixtures/shipping-rate.xlsx` 经 `xlsx` 库切片生成（与源文件**逐格一致**：0 处差异、1714 个数值格，
  用 openpyxl 生成时曾因 `166.54999999999998 → 166.55` 浮点往返漂移出 90 处差异）；
  `tests/pluginTriage.spec.ts` 新增 `shipping-rate` 分组（宿主 op 必须真被调用 / 禁 `eval`、`new Function` /
  禁岛内打包 `xlsx` / 禁岛内对费率字段做算术 —— 只允许显示层面的取整）。
- **已发布到本地市场**：`market-out/shipping-rate-1.0.0.zip`（24.5 KB，zip 内仅 `manifest.json` + `dist/**` 共 13 条目），
  `sha256 7b7cfd22…ffb504`（**已被 1.0.1 原地替换，见下方 Fixed 段**），`catalog.json` upsert 后共 5 条；宿主「插件市场」地址填 `http://127.0.0.1:8000/catalog.json`，
  静态服务用 **`npm run market:serve`**（`scripts/serve-market.mjs`，**别用 `python3 -m http.server`**，原因见下方 Fixed 条目）。
  发布链路的端到端验收：隔离 userData 起宿主 + CDP 直驱
  **真实市场 IPC**（catalog 拉取 → sha256 强校验安装 → 落盘仅 `manifest.json` + `dist/**` → 重启后侧栏出现入口 → 岛握手并渲染），14 项断言全绿。
- ⚠️ **新增手写岛必须在 `.gitignore` 的 `dist/` 规则下加反向例外** `!ui-plugins/<id>/dist/`
  （裸 `dist/` 匹配任意层级），否则「`dist/` 即源码」的岛会静默不入库。

### Fixed · 「导入运价表」必失败：读错了工作表（报价单在第 10 张，代码却取第 1 张「目录」）

- **症状**（用户实测，2026-09-24）：在「无忧物流运费」岛点「导入运价表」，稳定弹
  「该 sheet 没解析出运价：未找到任何「运达国家/地区」表头行 —— 该 sheet 不是报价单结构，未解析出任何运价」。
  文案指向"报价单结构不对"，但**数据本身完全正常**（夹具逐格核对过）。
- **根因**：运营商报价单是**一本 21 张工作表的工作簿** —— 第 1 张是「目录」，其后 20 条线路各自一张，
  本岛要用的「无忧物流-标准」在**第 10 张**。而宿主 `parseRateSheet` 在岛没传 sheet 名时写的是
  `const sheetName = want && sheetNames.includes(want) ? want : sheetNames[0]` —— **回落到第一张**。
  岛首屏那句「默认取「无忧物流-标准」sheet」的文案一直是**承诺**，实现从没做到。
  更糟的是失败被归因成"结构无法识别"，用户会去怀疑报价单而不是去看读的是哪张表。
- **修复**：
  - `src/lib/shipRate.ts` 新增 `pickRateSheet()` + `DEFAULT_SHEET_HINT`：**逐张体检 + 按语义排序**选表
    （名称完全相同 > 名称包含且越短越近 > 国家数 > 价卡数 > 工作簿顺序兜底）；国家数为 0 的 sheet
    不参与排序但**仍作为候选回报**（自动挑错时用户能看到有哪些可选）。
  - `src/core/plugin/host.ts` 的 `parseRateSheet` 拆开两个语义：`sheetName` = **显式点名**（严格，不存在即报错，
    不静默改判）、`prefer` = **名称提示**（优先但可回落，用于"换版后 sheet 改名"）；返回值新增
    `picked` / `candidates`，`table` 在整本都不可用时为 `null`。
  - 岛侧：导入改传 `prefer`；`store.js` 新增持久键 `lastFile`（上次**打开过**的文件，导入失败时
    `source` 可能仍是更早的另一个文件）与 `candidates`（体检结果）；「运价表」页把导入失败从**死路**
    改成可自愈 —— 列出已体检张数、可用工作表（带国家数）按钮、以及标注「非报价单」的全表下拉；
    列表里也标出每张表的可用性；`switchSheet(sheetName, filePath)` 第二参数用于失败态重试。
- **验证**：`tests/shipRate.spec.ts` 新增「自动选表」分组（9 例）+ `tests/pluginTriage.spec.ts` 新增
  2 条守卫（宿主域内不得出现 `sheetNames[0]` 回落、导入必须传 `prefer` 而非 `sheetName`）。
  **7 条断言已实测「破坏对应实现即变红」**。真机验收（隔离 userData + CDP 直驱岛自身 `api.js`）
  14 项全绿：自动选中「无忧物流-标准」、184 国 / 857 卡 / 0 告警、21 张表全部回报、
  点名切表严格生效、点名不存在的表会报错、失败恢复面板可渲染出 3 个候选按钮与 22 个下拉项。
- ⚠️ **两个过程教训（已写进 `tests/fixtures/generate-fixtures.mjs` 与岛 README §5）**：
  1. **夹具必须复刻结构，不只是单元格**。旧夹具把报价单放在**第一张**，于是"取第一张"这个错误写法
     在测试里**恒绿** —— 夹具现已保留源工作簿顺序（首张「目录」+ 一张**能解析但位置更靠前**的
     「无忧物流-特惠」，否则"取第一张能解析的"也能蒙对）。
  2. **"默认值"不能靠位置（顺序/下标）**，要靠**语义**。同类写法在 `src/lib/excelParser.ts` 与
     `extensions/order-insight` 里也存在，但那些是各自功能的**既定契约**（"只读第一个工作表"已写进
     需求文档），本次未改动。

### Fixed · 「无忧物流运费」切到别的线路就报「表头结构无法识别」：表头版式是一族，不是一种

- **症状**（用户实测，2026-09-25）：在岛的「运价表」页切换工作表到「燕文航空挂号小包」，提示
  「没解析出运价：分节 1（第 9 行）：表头结构无法识别，整节跳过」。数据完全正常 ——
  21 张 sheet 里当时只有 **3 张**能解析。
- **根因**：归一化把表头**写死成 3 行**（类别 / 档位 / 叶子，`hdr` / `hdr+1` / `hdr+2`）。
  实测源工作簿的表头行数与**上下顺序**都不统一：燕文 / 超级经济 / 顺友 / 4PX 只有 1~2 行，
  无忧物流-特货标准 / 特货标快是**叶子在上、档位在下**。固定偏移在这些表上会把**数据行**当成叶子行。
  伴随的三个静默错：`Item 服务费`（= 挂号费的别称，6 张表这么写）整列丢失、报价单单列的
  「最低计费重量 10g」从未被套用、`无忧物流-特惠` / `超级经济` 是**美元**报价却被按人民币算（差 7 倍）。
- **修复**（`src/lib/shipRate.ts` / `src/lib/shipRateQuote.ts`）：
  - 新增 `detectLayout()`：**按角色命中数探测** cat/zone/leaf 三行（行号不写死、不假设上下顺序）；
    数据区起点 = `max(leafRow, zoneRow) + 1`。探测时「最低计费重量」列**不算叶子命中**
    （否则表头行被判成叶子行 → 真正的档位行被挤掉 → 整节档位退化成 `[0, 30000]`）。
  - `leafKind` 补同义词 `Item 服务费` / `操作处理费` / `处理费`，并新增 `minCharge` 种类；
    `parseZoneRange` 认「两数相同 = 只说上限」且单位按**整段文本**判 kg/g。
  - `maxG` 改为**本列档位优先于整组限重**（此前摩洛哥的大包按 KG 档会被限重 30kg 吃掉整段首重续重档）。
  - 新增 `Currency` / `RateCard.currency` 与非本币**拒算**（`QUOTE_CURRENCY = 'CNY'`）：
    拒算文案与「该重量段无可用运价」**分开**，界面分两枚 chip，不合成一句。
  - `computeFee` 套用 `minChargeG`（计费克重 = `max(克重, 最低计费重量)`），`QuoteBreakdown` 新增 `chargeG`。
  - `Category` 新增 `any`（该表不分品类），`pickCard` 里**永远排在最后**：有明确类别的价卡先说话，
    但任何类别（含强制类别）的查询都能落到它身上。
  - 新增判据「**同一目的地在一节内占多行** = 行式分档表」→ **整节拒绝**并给出明确文案。
    这类表（海运大件专线 / 超大件专线 / 优先与特货标准的部分分节）把"该档总价"写在单元格里，
    会被当成"每 KG 费率"，算出**大两个数量级且不报错**的金额 —— 宁可拒绝，不可产出量纲错的价。
  - 被拒绝的节不再把它自己的建卡告警（如"挂号费按 0 计"）漏进总表。
- **岛侧** `ui-plugins/shipping-rate`（`manifest.json` → **1.0.2**）：运价来源新增「报价币种」行与
  非本币说明条；分节结构表新增「币种 / 最低计费」两列；价卡明细对非 CNY 与 `minChargeG` 打标签
  （升级前导入的旧运价表没有这两个字段 → 判空跳过，不误报）；查询页摘要拆成「该克重无价」/
  「未接汇率」两枚 chip，并在全表拒算时给出币种说明。`ui-plugins/shipping-rate/dist/styles.css`
  补 `.notice`（此前 `ui-plugins/shipping-rate/dist/views/quote.js` 用了未定义的类名，
  会渲染成无样式裸文本且不报错）。
- **验证**：21 张 sheet 的可用覆盖率 **3/21 → 19/21**（仅「目录」与「无忧物流-超大件专线-优选仓」为 0 国，
  属预期）；「无忧物流-标准」核心数字**零回归**（184 国 / 857 卡 / 17 节 / 0 告警）。
  `tests/shipRate.spec.ts` 39 → **50 例**（夹具新增 5 张不同版式族的真表切片，放在目标表**之后**以保住
  "报价单不在第一张"的结构）；全量 `npx vitest run` 309 例全绿。
- ⚠️ **两个过程教训**：
  1. **同时查出一处真错**：`pickCard` 的强制类别分支漏了 `'any'` 兜底 → 不分品类的表被强制查询判成无价
     （那条用例当时是**红的**，不是"假守卫"）。已修为 `[forced, 'any']`。
  2. **变异测试的判据必须先剥 ANSI**。直接匹配 vitest 彩色输出里的 `Tests\s+(\d+) failed` 会**永远匹配不到**
     （真实行夹着 `\u001b[22m \u001b[1m\u001b[31m`），于是 10 条变异全被误报成"这条断言是假守卫"。
     剥掉后 10/10 条变异**全部被抓住**。判据写错会把好测试冤枉成假守卫，排查方向完全相反。
- **已重新上架**：`market-out/shipping-rate-1.0.2.zip`（30.2 KB，仅 `manifest.json` + `dist/**` 共 13 条目）、
  `sha256 52f61332…74dc`，catalog 第 5 条原地替换 1.0.1（base 仍为 `http://127.0.0.1:8000`）；
  运行时目录 `<userData>/plugins/shipping-rate` 已重建为 1.0.2；真机冒烟 **5/5 岛通过 + 重启恢复通过**。
  ⚠️ `market-out/` 是独立 git 仓，本轮**只更新工作区，未 commit / push**，对外分发需另发一次。

### Fixed · 「插件已发布到市场，宿主刷新却看不到」（catalog 被 Chromium 启发式缓存钉住）

- **症状**：`market-out/catalog.json` 已是新内容（磁盘与 HTTP 实测都对、`plugins-scan` 也正常），
  本地静态服务也没换过，但宿主「插件中心 → 市场」刷新后**仍然只列旧条目**，新插件不出现。
  用**真实 userData 克隆**起宿主 + CDP 实测复现：宿主拿到的是 6 条两天前的旧目录，且连续两次拉取结果一模一样。
- **根因**：`downloadFile`（`electron/http-client.ts`，走 Electron `net` = Chromium 网络栈）用裸 `net.request({ method:'GET', url })`，
  **没有任何缓存指令**；而 `python3 -m http.server` 只发 `Last-Modified`、不发 `Cache-Control`，
  Chromium 于是套用启发式新鲜度 `freshness = (Date − Last-Modified) × 10%`。catalog 上次改动距今两天
  → 新鲜期算出 5 小时量级 → 宿主刷新市场**连请求都不发**，直接用两天前的副本。
  （隔离 userData 的端到端验收之所以全绿，正是因为那份 userData 里**没有历史缓存**——弱验收漏掉的正是这一环。）
- **修复（两侧都补，缺一不可）**：
  - 请求端 `downloadFile(url, dest, { noCache: true })` → 带 `Cache-Control: no-cache` + `Pragma: no-cache`，
    把「直接用缓存」降级为「回源验证」（没变走 304，变了拿新的）；市场侧 catalog 与插件 zip 两处调用点均已传。
  - 服务端新增 `scripts/serve-market.mjs` / `npm run market:serve`：所有响应 `Cache-Control: no-store`，
    且**不发** `Last-Modified` / `ETag`（避免 304 复核路径）。
- **验证**：同一份「缓存里还留着旧目录」的 userData，修复前宿主看到 6 条旧目录、修复后立刻拿到 5 条含
  `shipping-rate@1.0.0` —— A/B 对照成立。新增守卫 `tests/marketCache.spec.ts`（4 例，市场侧每处
  `downloadFile` 必须 `noCache:true` / 服务端必须 `no-store` 且不设 `Last-Modified`·`ETag` / 市场侧不得绕过
  `downloadFile` 自行发请求），并已实测「撤掉修复即变红」。
- ⚠️ 修复在主进程，**改完必须重启宿主**（dev 模式 `npm run dev` 会重新 `tsc`）才生效。

### Fixed · UI 岛重启后不回到上次所在的岛（启动时序：扫描晚于恢复）

- **症状**：上次停在某个 UI 岛，重启后落在别的模块，要手动点一次；岛本身完全正常（侧栏在、点进去也好）。
- **根因**：恢复「上次活动模块」用 `pm.has(id)` 判定，而 UI 岛只在 `pm.discoverExternal()` 里登记。
  原 `onMounted` 里外部插件扫描排在 `await activate(initialId)` **之后**（且是 `void` 不等待）→ 恢复时岛尚未登记
  → 判假 → 静默回落首个非岛模块。**判假处没有任何日志**，属静默失效（与前两条同类：不报错、只是"不对"）。
  修：把扫描拆出 `scanExternalPlugins()`，**在恢复之前 `await`**；`activateStartupPlugins()` 单独成
  `startStartupExternalPlugins()`，仍在恢复之后不阻塞首屏。无存档时的默认落点不变——岛 meta 的 `order` 固定 120，
  排在所有内建模块之后。`src/core/AppShell.vue`
- 扩展 `tests/uiIslandBridgeLifecycle.spec.ts`（9 → 11 例）：新增启动时序守卫 —— onMounted 体内「扫描调用点」
  必须早于「恢复 `lastActiveModuleId`」且必须 `await`；并禁止回退成「扫描+启动合一」的单函数。
  ⚠️ 该守卫**只在 onMounted 体内**做 `indexOf`：对整个文件 `indexOf('pm.discoverExternal()')` 命中的是函数**定义**，
  那样把调用挪回恢复之后仍然全绿（实现时已实测踩到，故注释写死在测试里）。
- 扩展 `npm run plugins:island:smoke`：逐岛点击之后**用同一份 userData 重启一次**，不点任何导航，
  断言自动回到了最后点开的岛（`[重启恢复]` 段）。已双向验证：修复后 ✓ 回到 `shop-accounts`；把扫描挪回恢复之后 → ✗
  「重启后没有任何岛被渲染」。
- 文档：`docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md` 新增 §3.10 故障条目，§4.1 冒烟说明补重启段，
  §5 移除该「已知缺口」。

### Fixed · UI 岛「重启后点导航一片空白」（切岛未重建桥 + 打包缺运行时）

- **切岛未重建桥 → 本会话第一个岛能用、之后每个岛永久空白**（用户多次报障的根因，此前几轮修的是握手内部逻辑，
  故一直没治好）：AppShell 用 `<UiIslandView :plugin-id="activeIslandId">` 渲染岛，而 Vue 会**复用**同位置同类型
  组件——切岛只换 prop、组件实例与「桥」不重建，旧桥带着**上一个岛的 `expectedOrigin` 与 token** 继续服务：
  新岛的 `hello` 被判串台丢弃，旧桥补发的 `boot` 又以旧岛 origin 为 targetOrigin，被 `postMessage` **静默丢弃**
  （规范上 targetOrigin 不匹配不抛错、不打印）→ 新岛永久停在「等待桥握手」；把首屏门控在 boot 之后的岛即整屏空白，
  而宿主工具条还显示「桥已连接」（旧会话状态）。修：① `src/core/AppShell.vue` 的 `<UiIslandView>` 加
  `:key="activeIslandId"`（按岛重建组件）；② `UiIslandView.attach()` 改按 `bridgePluginId === props.pluginId`
  判定，换岛先 `dispose` 再建桥（组件被复用时的自保）；③ `uiBridgeHost` 对「来源与 expectedOrigin 不符」的岛消息
  留一次性告警（这一类失败过去完全静默，是它反复复发的直接原因）。
- **打包版所有岛空白（dev 正常）**：`electron/plugin-ui-runtime.js` 是经 `sk-plugin://` 注入 UI 包 HTML 的
  **桥运行时源码文本**，既不参与 tsc 编译（`tsconfig.electron.json` 的 include 只收 `*.ts`，且用 `allowJs` 搬运会被
  全文重写），也未进 `electron-builder.yml` 的 `files` → 打包版 asar 内两处候选路径全 miss
  → `loadRuntimeSource()` 返回 null → 不注入桥 → **所有**岛 `window.__sk` 缺失。修：builder `files` 显式收录该文件
  （原样分发，不编译）；并在 `loadRuntimeSource()` 全候选 miss 时打一次性 `[ui-island] 桥运行时源码缺失：<候选路径>`
  ——这条静默路径过去在打包版里连一行日志都没有。
- 新增接线守卫 `tests/uiIslandBridgeLifecycle.spec.ts`（现 11 例）：钉住「切岛必须重建桥（`:key` + `pluginId` 判定）」
  「运行时源文件存在且是经典脚本、必须进 builder files、不得交给 tsc 编译」「宿主 `UI_MSG` 与 runtime `TYPE`
  的消息字面量一致」。
- 新增一键冒烟 `npm run plugins:island:smoke`（`scripts/ui-island-smoke.mjs`）：复制一份 `<userData>/plugins` 到
  临时 userData 起隔离宿主 → 用 CDP 逐个点岛 → 断言岛内 `window.__sk` 存在且 `ready` 落地、首屏非空；
  失败时按「首个岛正常/全部坏」给出定位引导。已在真机验证可复现旧故障（旧代码 3/4 失败）与确认修复（4/4 通过）。
- 新增 `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md`：UI 岛接入 8 步 SOP + 五类检查清单 + 故障速查表
  （症状→根因→定位→修复）+ 回归验证方法；`AGENTS.md` 增红线 24/25，`PLUGIN_DEVELOPMENT.md` §12 增 12.5 接入自检。

### Fixed · UI 岛（外置插件）冷启动「加载不出数据 + 样式不跟主题」

- **冷启动握手死锁**：iframe 的 `load` 早于 iframe 端 `hello` 到达宿主时，宿主「load 安全网」先发 boot，
  随后迟到的 `hello` 又轮转 token → 岛**已在途**的首批能力调用被判为串台，而旧实现在 token 不匹配时
  **静默丢弃且不回包** → iframe 侧 pending 永不 reject，表现为「重启后岛内数据加载不出来，
  必须点工具条的『重新加载』才恢复」（冷启动必现，非偶发）。
  修：`hello` 改为**复用同一会话密钥**再发一次 boot（`repostBoot`，不轮转）；token 不匹配的 `call`
  一律回错误包，不再静默吞掉。`src/core/plugin/uiBridgeHost.ts`
- **深色主题下岛内原生控件仍是浅色**：`color-scheme` 不是设计令牌，无法随 `--wb-*` 注入；
  岛里写死 `color-scheme: light`（或完全不声明）时，深色主题下日期选择器 / 下拉弹层 / 滚动条 /
  复选框仍是浅色——文字与面板都变黑了，只有原生件是白的，即「页面样式跟主题不一样」。
  修：宿主 boot/theme 载荷下发 `theme.mode`（新增 `currentThemeMode()`），iframe 端运行时
  `applyTheme` 把它写到 `<html>` 内联样式（内联优先级可覆盖岛内写死的值）。
  `src/core/plugin/uiBridgeHost.ts` + `electron/plugin-ui-runtime.js`（双端同步，AGENTS 红线 20）
- **`dispose()` 的 `abort` 发不出去**：`alive = false` 先于 `post(...)`，被 `post` 自身的
  `if (!alive) return` 守卫吞掉 → 岛内在途调用无法被中止（同属"静默挂起"）。改为先广播再置位。
  由新增用例 `tests/uiBridgeHost.spec.ts` 抓出。
- 新增回归守卫 `tests/uiBridgeHost.spec.ts`（7 例，自建 window/document 桩、不引 jsdom）：
  钉住「hello 不轮转 token」「token 不匹配必回错包」「boot/theme 带 `theme.mode`」「dispose 发得出 abort」。

### Fixed · UI 岛产物（岛内元素级 `color-scheme` 收敛）

- `shop-accounts` **1.4.4**：`AccountEditor.vue` 的 `.date-input` 写死 `color-scheme: light`，**元素级声明会盖过**
  宿主写在 `<html>` 上的内联主题值 → 深色主题下账号编辑抽屉的日期面板/日历图标仍发白。改为 `inherit`；
  同时删除 `:global([data-theme='dark']) .date-input` —— 宿主只注入内联令牌、**不同步 `data-theme` 属性**到 iframe，
  该选择器永不命中（死代码）。
- `ae-profit` **1.0.2**：`style.css` 的 `@layer components` 日期/时间输入组同因改为 `inherit`。
- 两岛 `package.json` 版本同步递增，产物已重建；`<userData>/plugins/` 已按「manifest + dist」重装；
  `market-out/` 已产出 `shop-accounts-1.4.4.zip` / `ae-profit-1.0.2.zip` 并更新 `catalog.json`
  （**远端仓库未推送**，待人工确认）。

### Removed · 删除样例岛 `sk-ui-starter`（`PLUGIN_TRIAGE_PLAN` T6）

- 该岛与脚手架 `scripts/ui-plugin-template` 内容重复（同为 189 行 / 2 文件），且 README 已自述"样例岛，供参照非脚手架" ——
  样例无独立价值，**删除**（非"下架"，不再从市场分发）。
- 清场范围：① 源码包 `ui-plugins/sk-ui-starter/`（`git rm -r`，9 个跟踪文件）；
  ② 市场产物 `market-out/sk-ui-starter-0.1.0.zip` 与 `catalog.json` 条目；
  ③ 本机已装副本 `<userData>/plugins/sk-ui-starter`（移入废纸篓，可恢复）。
- **脚手架保留** `scripts/ui-plugin-template`（`plugin-create.js --ui` 的 `TEMPLATE_UI` 指向它）——
  `npm run plugins:create:ui <id>` 生成新岛的能力不受影响。`pluginTriage` / `uiIslandThemeTokens` 等守卫按目录动态枚举，
  无需改动；`ui-plugins/` 现有 4 个岛（`ae-profit` / `excel-copy` / `order-insight` / `shop-accounts`）。
- 连带回写：`AGENTS.md` §1.9 实例列表、`PROJECT_BASELINE.md` §3/§4/§6、`PLUGIN_ARCHITECTURE.md` §15.6、
  `CODE_REVIEW_REPORT.md` §5.5、`HOST_REVIEW_2026-09-22.md` §4、`.gitignore` 注释、
  `ui-plugins/{ae-profit,shop-accounts}/src/style.css` 的模板指引注释。
- 残留未动（有意）：`<userData>/config.json` 的 `modules['app-shell'].lastActiveModuleId` 若曾指向该岛，
  由 AppShell 启动时按"模块不存在"回落，无需手改用户态数据。

### Removed · 下架示例外置插件 `sk-hello`（外置示例 · 你好 0.1.0）

- 与本轮删除 `sk-ui-starter` 同一判据：**示例插件无独立价值，且它的市场条目会持续出现在插件市场**。
- 清场范围：① 本机已装副本 `<userData>/plugins/sk-hello`（移入废纸篓，可恢复）；
  ② **市场仓**（`market-out/` 是独立 git 仓，远端 `SayakABC/SellerKitPlugin`）删除 `sk-hello-0.1.0.zip`
  并从 `catalog.json` 摘除条目，**已 commit & push**（`3831453`）。同一提交顺带把上一轮 `sk-ui-starter`
  的条目也一并下架 —— 上一轮只清了本地工作区，远端市场仍能装到它。
- **脚手架保留**：`scripts/templates/l2-demo`（`sk-hello` 的源码本体，即 `scripts/plugins-install-demo.js`
  的 `SOURCE`）—— 删了它 `npm run plugins:demo:install` 会直接坏。需临时复现示例时仍可本地安装。
- 未动：`scripts/sandbox-smoke.mjs` 里以 `sk-hello` 为名字的夹具（只是 token/命名空间字面量，不依赖该目录）。
- 连带回写：`PROJECT_BASELINE.md` §2（脚手架旧名改为 `l2-plugin` / `l2-demo`）、
  `PLUGIN_DEVELOPMENT.md`（市场形态示例在架包）、`docs/archive/plans/PLUGIN_TRIAGE_PLAN.md` §0。

### Removed · 删除 dev 种子 UI 岛 `sk-ui-hello`（UI 岛 Hello 0.2.0）

- 它是 P0 起用于验证的**开发期种子 demo**（manifest 自述"勿发布"），由 dev 启动自动播种，从未进市场。
- **必须连播种链路一起删**，否则只删 `<userData>` 副本，下次 `npm run dev` 又会被同步回来：
  ① 本机副本 `<userData>/plugins/sk-ui-hello`（移入废纸篓，可恢复）；
  ② 种子包 `scripts/poc-ui-hello/`（`dist/` + manifest，未入库）；
  ③ `electron/plugin-ui-protocol.ts`：`UI_POC_ID` / `seedDevPocPackage()` / `ensurePocPackageSeeded()` 移除；
  ④ `electron/main.ts`：`ensurePocPackageSeeded()` 调用与 import 移除（`initPluginUiProtocol()` 保留）；
  ⑤ 连带清掉 `eslint.config.mjs` 与 `.gitignore` 里针对该目录的忽略项。
- **能力面无变化**：`sk-plugin://` 协议服务、桥 runtime 注入、`UiIslandView` 渲染、PluginCenter 启停/卸载全部保留 ——
  删的只是"造一个 demo 岛"的便利入口；要再起 demo 用 `npm run plugins:create:ui <id>`（模板 `scripts/ui-plugin-template`）。
- 连带回写：`PLUGIN_ARCHITECTURE.md` §15/§15.6（状态行 + P0/P1/P2 历史结论加"已不可复现"提示）、
  `PLUGIN_TRIAGE_PLAN.md` §3 脚注、`UiIslandView.vue` 注释示例。

## [1.1.0] — 2026-09-22

> 首个**真实发布节点**（文首说明：1.0.x 的四个 tag 全部错位指向 `9ccb73d`，不代表发布）。
> 主题是「业务模块全部下记为市场 UI 岛 + 宿主安全收敛 + 工程化整改」，`package.json` 由 `1.0.4` 推进至此版本。

### Changed · 依赖大版本升级（工程化整改 R3）

- **Vite 5.4 → 8.3**：构建管线由 Rollup + esbuild 换为 **Rolldown + Oxc**。
  `vite.config.ts` 与 `vitest.config.ts` 配置零改动；`src/registry.generated.ts` 与升级前逐字节一致。
  配套：`@vitejs/plugin-vue` ^5.0.4 → ^6.0.9、`vitest` ^2.1.9 → ^4.1.11（保守取 4.x 维护线而非 5.x）。
  前置条件：`modules.config.ts` 已先改为纯 JSON（消除对 esbuild `transformSync` 的直接依赖）。
- **Electron 33.4.11 → 44.4.1**：跨 11 个大版本。内置 Node 20.18 → 24.21、Chromium 130 → 152、
  原生模块 ABI 130 → 149。业务代码零改动（所用 API 面不在破坏性变更清单内）。
  原生模块重建链路修复：新增显式依赖 `@electron/rebuild@^4.2.0`，并以 scoped `overrides`
  将其依赖的 `node-abi` 收窄到 `^4.35.0`（旧版无法识别 ABI 149）。

### Changed · 插件脚手架归位 + 文档回写（`PLUGIN_TRIAGE_PLAN` T4 / T5）

- **脚手架不再寄居 `extensions/`**：`extensions/_template` → `scripts/templates/l2-plugin`（L2 模板）、
  `extensions/sk-hello` → `scripts/templates/l2-demo`（L2 演示），`git mv` 保留文件历史。
  二者都是构建脚本的**活依赖**，已同步重指向 `scripts/plugin-create.js` 的 `TEMPLATE_BG` 与
  `scripts/plugins-install-demo.js` 的 `SOURCE`，并实跑 `plugins:create` / `plugins:demo:install` 验证不坏。
  归位后「`extensions/` 下的目录 = 随宿主分发的视图插件包」这条直觉重新成立（当前只剩
  `excel-copy` / `order-insight` 两份下记留档源码）。
- **`ui-plugins/sk-ui-starter` 明确为样例岛**（与 `scripts/ui-plugin-template` 内容重复）：README 顶部标注
  "样例岛，供参照非脚手架"；是否从市场下架待项目方拍板（未删除，避免不可逆操作）。
- 文档回写：`README.md` 核心能力表按「4 个市场 UI 岛 + 1 个内建模块」的新形态改写；
  `PROJECT_BASELINE.md` §2 目录职责 / §3 规模表 / §4 岛清单按 T4 增量修正；
  `AGENTS.md` §1.9、`PLUGIN_ARCHITECTURE.md`、`PLUGIN_DEVELOPMENT.md`、`docs/README.md`、`REMEDIATION_PLAN.md`（R2-7）
  的旧路径与滞后表述同步。（版本号随本次 `[1.1.0]` 发布一并推进，见文首段落。）

### Added

- **UI 岛设置贡献（宿主设置中心承载外置插件设置）**：岛 manifest 新增 `settings: { entry, displayName?, icon?, order? }`，
  声明后宿主设置中心自动出现 `<pluginId>:settings` 分类，内容由新增的 `IslandSettingsPanel.vue`
  以 `sk-plugin://<id>/<entry>` iframe 岛承载（复用 `__sk` 受控桥，权限门与审计口径不变）；
  分类随岛安装/卸载/停用即时增减（`managerSettings.getIslandSettingCategories()`）。
  岛侧跳转复用既有桥能力 `sk.host.ui.openSettings(category)`（`ui` 为默认放行的轻量能力，
  不写入 `capabilities`），由宿主内部 dispatch `open-settings` 打开并定位分类。
  首个接入方：`shop-accounts` 1.4.0（岛内「设置」页签迁出，主视图保留跳转入口）。
  发布脚本 `scripts/publish-plugin.js` 强校验 `settings.entry`（相对路径 / `.html` / 文件存在 / 与 `entry` 同打包子树）。
- **IPC 契约自动校验**（`npm run verify`）：从源码动态提取 preload 暴露键、`src/types.ts` 声明、
  主进程注册通道三份清单求差，把"新增通道忘改声明"的复发路径封死。
- **单元测试网**（`npm test`，vitest）：覆盖 `src/lib/` 全部 7 个纯函数模块、
  `electron/ipc-util.ts` 的 IPC 注册契约、款色色卡字典，共 207 用例；配套自建 Excel 夹具。
  另加**插件体系静态守卫**：`pluginManifest`（manifest × 权限门口径）、`pluginSettingsIsland`、
  `pluginTriage`（红线 23：预设不得占用岛 id；岛的 db 调用必须全在 manifest 声明内）、
  `uiIslandThemeTokens`（宿主令牌 × 注入清单）、`payloadBudget`（桥层载荷体积预算）。
- **ESLint + Prettier**：flat config，门禁标准为 **error 数 = 0**；`vue/no-restricted-class`
  以 error 级拦截调色板类名与任意值色号。
- `electron/ipc-util.ts`：主进程 IPC 注册封装单一事实源（`register` / `handle` 双契约）。
- `--wb-shadow` 主题令牌（抽屉/浮层投影色，浅色与深色各一套）。
- `docs/baseline/`（项目基线快照 + 重构计划）、`docs/reviews/`（代码审查报告）、
  `docs/plans/`（分阶段整改计划）三类文档建立并纳入版本管理。
- `CONTRIBUTING.md`、`CHANGELOG.md`。
- **`LICENSE`（专有声明，非开源）**：上游 `SayakABC/SellerKit` 实测无 license 文件（GitHub API
  `license: null`），本仓库据此把它明确为 **All rights reserved**——禁止复制 / 修改 / 分发 /
  反向工程 / 商用，并单列「第三方组件依其各自许可证」条款（`xlsx` 为 Apache-2.0 等），
  避免把不属于本项目的代码也纳入专有声明。`package.json` 同步置 `"license": "UNLICENSED"`。

### Changed · 业务模块全部下记为市场 UI 岛

内建业务模块至此**清零**：三个模块依次改由市场分发，宿主不再随包编译它们的视图。

- **`shop-accounts` → `ui-plugins/shop-accounts` 1.4.3**、**`order-insight` → 1.2.0**、
  **`excel-copy` → 1.0.0**（TV模版）。`modules.config.json` 的 `minimal` / `standard` / `pro`
  与 `enabledModules` 已移除三者 id，`src/registry.generated.ts` 现在只剩 `quick-note`。
- **`extensions/` 侧当前无实例**：三个目录保留为源码留档，不进构建。
- **配置零迁移**：岛的存储命名空间与内建同源（`modules.<id>`），老用户的模板 / 规则 / 显示列配置自动继承。
- **能力边界由 CSP 决定，不是偏好**：岛所在 iframe 的 CSP 为 `script-src 'self'`（无 `unsafe-eval`），
  因此 Excel 解析与 `jsExpression` 规则求值**必须**留在宿主，岛只做「收集参数 → 调宿主 op → 渲染」。
  副作用是两侧共用 `src/lib/excelParser.ts` / `fieldProcessor.ts`，行为口径不会漂。
- 保留 `quick-note` 为内建模块（`src/modules/` 因此不悬空，「内建模块」这条路径仍有活样例）。

### Fixed

- **深色主题「白字白底」**：8 处硬编码 `text-white` 改用 `--wb-primary-contrast` 令牌。
- **`dist:select` 会静默产出残缺安装包**：模块扫描只认 `src/modules`，漏掉 `extensions/<id>/src`
  的插件包；改为双根扫描并以 `scripts/lib/module-roots.cjs` 作为唯一事实源。
- **`xlsx` 换源**至 SheetJS 官方 CDN 版本，消除 CVE-2023-30533 / CVE-2024-22363。
- **主进程 `throw null` 会让 IPC 变成 reject**：注册封装的 `err.message` 改为 `err?.message`，
  避免 catch 块自身抛 TypeError（渲染层会拿到未处理拒绝而不是约定的 `{ success: false }`）。
- **邮件模块源码内嵌裸控制字节**（7 个 `0x00` / `0x1f`）改为转义写法——原文件被 `file`/`grep`
  判定为二进制，内容无法检索，且编辑器可能静默改写这些不可见字节。
- **`ShopAccountUpsertInput` 缺 `mailAuthPwd`**：敏感字段白名单含该键、写入逻辑也用它，
  但输入类型没声明（"运行时收得下、类型说不收"）。
- **`simpleParser` 的 `as any` 误匹配到回调重载**，返回值被推断成 `void`；移除该 cast 后
  恢复 `Promise<ParsedMail>`，字段访问重新受类型保护。
- `PROJECT_OVERVIEW.md` 严重过期（描述已删除的文件与过期的 IPC 通道数）→ 已删除，
  现状描述职责由 `docs/baseline/PROJECT_BASELINE.md` 承接。
- `UiIslandView.vue` 未连接态圆点裸 hex 改用主题令牌（深色下不再偏亮）。

### Fixed · 宿主代码复查（2026-09-22）

复查结论见 `docs/archive/reviews/HOST_REVIEW_2026-09-22.md`（六道门禁全绿，但 11 项问题**全部落在门禁盲区**）。

- **已下记模块仍被当作打包候选**：`extensions/` 留档目录里仍有 `meta.ts`，于是
  「有 meta.ts 即模块」的枚举把 `excel-copy` / `order-insight` 重新算成可打包模块 ——
  勾选即占住岛 id（`registerUiIsland` 见 `records.has(id)` 静默 return → 从市场装的岛永远没有侧栏入口，
  AGENTS 红线 23）。现由 `scripts/lib/module-roots.cjs` 的 `isUndocked()`（判据：`ui-plugins/<id>` 存在）
  在**枚举与构建两处**硬拦：选择器把这类目录单列为「已下记为市场 UI 岛」不入候选，
  `vite.config.ts` 对 `MODULE_IDS` 里出现的已下记 id **报错并忽略**。
- **`db[excel-copy]` 实为「全盘读 + 任意文件覆写」**：`read-file` / `save-template` /
  `check-file-exists` 原先接受任意绝对路径（写还无长度上限），而它们的唯一调用方就是岛的 `db` 能力面。
  现收敛为**用户已选文件白名单**（`electron/user-file-allowlist.ts`）：只放行宿主内置模板路径，
  以及用户经 `select-excel` / `select-template` 对话框真实选过、跨会话持久化的文件；
  存在性探测对未授权路径返回 `false`（与"文件不存在"不可区分，不泄露信息），写模板另加 2MB 上限。
  同法收紧 `order-read-local-image` —— 其路径实际来自**用户导入的 Excel 单元格内容**，
  原注释「用户在导入对话框主动选择」与实现不符。
- **管理面板的能力展示不足以支撑"知情同意"**：原先只显示 `db` 这样的能力 id 标签，用户看不出
  它可能意味着"读写你磁盘上的任意文件"。`PluginOverview` 新增 `capabilityDetails`，
  把域 / 动作 / 命名空间 / 地址白名单展开显示。
- **导航与拖放防护漏掉"保留 preload"的那条路径**：`will-navigate` 原先只拦 `.xlsx/.xls`，
  把任意本地 `.html` 拖进主窗口即会导航过去，而 preload 绑定在 webContents 上、不随 URL 变化
  → 该第三方页面直接拿到 `window.electronAPI`。现收敛为「只放行应用自身 URL」白名单，
  并加 `setWindowOpenHandler` 拒绝开新窗；渲染层加 document 级拖放兜底
  （仅拦文件拖放，保留文本拖入输入框的默认行为）。
- **桥层载荷无体积上限**：`__sk.call` 原先只校验参数个数，而宿主侧「50000 记录 × 256 字段 ×
  20000 字符」三个独立上限组合起来约 250GB。现加预算门禁（`payloadBudget.ts`，默认 64MB，
  用**带早退**的估算实现 —— 否则"海量小值"会把门禁自身变成新的耗时点），
  超限直接回「桥拒绝超大载荷」，不让载荷进入下游的消毒复制与规则引擎遍历。
- **`.gitignore` 的 `dist/` 通配吞掉了两个岛的源码**：`excel-copy` / `order-insight` 是**无构建步骤**的岛
  （无 `package.json` / `vite.config`，`manifest.entry` 指向 `./dist/index.html`），源码直接写在 `dist/` 下。
  原规则使 `git add -A` 只收录 `manifest.json` + `README.md` —— 仓库里存着一个 entry 指向不存在文件的坏岛
  （`order-insight` 此前已如此，且其 1.2.0 是发布过的版本）。
  现加定向例外放行这两个岛的 `dist/`；有 `src/` 与构建脚本的岛（`ae-profit` / `shop-accounts` / `sk-ui-starter`）保持忽略。
- **`AGENTS.md` 多处陈述已被下记推翻**（§1.5 的 `excel` 分类、§1.8 的"已外挂为视图插件包"、
  §1.9 的当前实例表、§6.3 的 129 个通道），§5 更在示范 `MODULE_IDS=excel-copy,quick-note` —— 正是红线 23 的违规操作。
  现 §1.5 / §1.8 / §1.9 改为「规则 + 指针」（现状由 `docs/baseline/PROJECT_BASELINE.md` 单点维护）、
  通道数改为 137、示例改为 `MODULE_IDS=quick-note`，并补上「已下记 id 不得用于打包」的红线说明。
- **4 处滞后注释与文档口径修正**：`vite.config.ts` 的根分布说明；`shop-accounts-handlers.ts` /
  `shop-accounts-db.ts` 仍称 `extensions/shop-accounts`（该目录 2026-09-16 已删）；
  `externalManifest.ts` 的 `activationEvents` 注释称支持 `onCommand:xxx`（实现会静默丢弃）；
  `PLUGIN_DEVELOPMENT.md` 的 `secrets` 需声明 `domains`（该能力无域粒度，声明无效）、
  `engines.sellerkit` 的兼容性语义（实际只查"是非空字符串"，不做范围比对）、
  以及一处把合法能力 id 写成「四项」的陈旧表述（实为七项）。
  被静默忽略的声明（`onCommand:*`、`secrets.domains`）一律改为**明确告警**。
- **款色色卡迁出留档目录**：从 `extensions/order-insight/src/lib/` 迁至 `src/lib/colorSwatch.ts`。
  它是纯函数字典（§1.2 目录语义归 `src/lib/`），而 `tests/colorSwatch.spec.ts` 直接从留档目录 import，
  使"删留档目录"会连带打挂测试与 `vue-tsc`（且报错不提示原因）。迁移后留档目录才真的不进任何门禁链路。

### Changed · 决策收口（宿主复查报告 §6 五项遗留，2026-09-22 结案）

- **ADR-001：`excel-copy` / `order-insight` 的设置不收编进宿主「设置」模态**。收编会打断这两个插件
  「改模板 / 改规则 → 立刻看预览」的核心回路（用户需 打开设置 → 改 → 关闭 → 切回岛 四步）。
  判据定为「改完设置是否需要立刻看数据变化」：需要 → 留在岛内；不需要 → 收编（如 `shop-accounts`）。
  全文见 `docs/decisions/ADR-001-island-settings-stay-in-island.md`；`AGENTS.md` §1.5 的偏差标注已改为指向该 ADR。
- **`db[excel-copy]` 超限语义由「一律静默截断」改为分层**：规则条数（64）/ 表头列数（256）/
  单条字段数（256）/ Excel 文件体积（新增 64MB 上限）属**配置类**——超限即**拒绝并报错**，
  不再让用户拿到"看起来正常但结果不对"的数据；记录行数（50000）与单元格字符串长度（20000）
  属**数据类**——大文件是真实场景，仍截断但**回传截断元信息**
  （`truncation.droppedRecords` / `truncation.truncatedStrings`），由岛侧决定是否提示"已处理前 N 行"。
  新增字段向后兼容，不读它的岛行为不变。
- **勘误（报告第 3 处）：`xlsx` 并非入口静态依赖**。原报告据「产物里有 492KB `xlsx-*.js` chunk」
  推断它启动即加载；实测 `dist/renderer/index.html` **无 modulepreload**，入口 chunk 对 xlsx 是
  `import()` 动态导入，只在岛调用 `db['excel-copy'].parseExcel*` 时才拉取。故 §6 第 5 项
  「改懒加载」**不成立、已关闭**；宿主侧 3 处调用本就是 `await import('@/core/services/excel')`。
  判据：**产物里存在某 chunk ≠ 它会被首屏加载**，要看 `index.html` 的 preload 与引用形态。

### Changed · 重构

- **`pluginManager.ts` 683 行工厂函数拆分为 6 个职责文件**（`managerContext` / `managerDiscover` /
  `managerActivate` / `managerEnabled` / `managerSettings` / `managerOverview`），
  `pluginManager.ts` 退化为纯组合门面；最长函数 683 → 79 行，对外签名逐字不变。
- **主进程开启 `noImplicitAny`**（`strict` 仍为 `false`，属渐进收紧的中间态，策略见 `AGENTS.md` §6.0.1）：
  清零 61 处隐式 `any`。
- **款色色卡字典**从 `ProductLibraryView.vue` 抽到独立文件 `src/lib/colorSwatch.ts`。
  该批色值为**业务数据**（款色 → 现实颜色），**刻意不令牌化**——否则深色主题下"白色"款色会变成深灰块。
  （抽取时落在 `extensions/order-insight/src/lib/`，2026-09-22 迁入 `src/lib/`：该目录已下记为留档，
  测试挂在留档目录下会让"删留档"连带打挂门禁。）

### Removed

- `extensions/ae-profit` 迁移残留（1,541 行，与命名 id 冲突的旧实现）。
- `buildVersion` 配置：产物版本元数据统一继承 `package.json`，避免 `Info.plist` 版本号与
  应用版本不一致。
- `PROJECT_OVERVIEW.md`（见 Fixed 段）。

## [1.0.4] — 2026-09-04（补录）

> tag `v1.0.4` 指向 `9ccb73d`。以下依据 `git log` 重建。

### Added

- **集中收件箱**：IMAP 收取、全文索引（FTS）、附件缓存与本机解密。
- **店铺账号管家**：多平台店铺账号的加密存储与批量维护。
- **速卖通利润追踪**：M0 闭环 + 存储层通用化（原 `ae-profit`，后 UI 岛化）。
- **UI 岛插件运行时**与宿主 ↔ 岛桥；插件市场目录浏览与安装；基于 `electron-updater` 的自动更新。
- 外置插件开发指南 `PLUGIN_DEVELOPMENT.md`。

### Changed

- 业务模块迁移为 `extensions/<id>` 随宿主分发的插件包，支持运行时启停；
  修复 Tailwind 扫描范围、启停后侧栏刷新等回归。

## [1.0.0] — 2026-09-03（补录）

> 首个提交为 `4141609`；`v1.0.0` ~ `v1.0.2` 三个 tag 均错位指向 `9ccb73d`。

### Added

- 初始版本：**订单洞察**（Excel 导入、订单归类识别、预览与复制）与
  **Excel 模板复制**（模板引擎、字段规则、显示列配置）两个业务的 Electron 桌面工具。
- 三层进程架构（主进程 / preload / 渲染进程）、模块化外壳（`AppShell`）、
  主题令牌体系、IPC 适配的网络请求链路。

---

## 发布流程

1. **确定版本号**：按语义化版本改 `package.json` 的 `version`。
2. **更新本文件**：把 `[Unreleased]` 段落改名为 `[<新版本>] - <YYYY-MM-DD>`，
   并按 Added / Changed / Fixed / Removed 归位；随后新建空的 `[Unreleased]` 段落。
3. **提交**：`git add -A && git commit -m "chore(release): v<新版本>"`。
4. **出包**：`npm run dist`（macOS）/ `npm run dist:win`（Windows）——
   `electron-builder` 会读 `package.json` 的版本号并自动打 tag、上传 Release 资产。
   国内网络下如需加速 Electron 二进制下载：
   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist`。
5. **核对 Release**：确认 tag 指向发布 commit、资产齐全（.dmg / .zip / .exe / `latest.yml` 等），
   且 `latest.yml` 中的版本号与新 tag 一致（自动更新依赖它）。
6. **不要为历史版本补打 tag**（见文首说明）。

### 发布前检查清单

- [ ] `npm run lint` → 0 error
- [ ] `npm run verify` → IPC 契约一致
- [ ] `npm test` → 全绿
- [ ] `npx vue-tsc --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit` → exit 0
- [ ] `npm run build` → 通过
- [ ] `npm run plugins:sandbox:smoke` → 通过
- [ ] 手工回归：启动 / 导入 Excel / 预览 / 复制 / 设置页 / 主题切换 / 插件启停 / ⌘K /
      UI 岛加载 / 邮件同步 / 店铺账号
