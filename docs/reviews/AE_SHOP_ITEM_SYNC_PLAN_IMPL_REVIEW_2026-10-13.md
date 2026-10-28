# 「速卖通店铺商品采集」实现复核（P0–P5）

> 对象：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`（含审查修订，见 `reviews/AE_SHOP_ITEM_SYNC_PLAN_REVIEW_2026-10-12.md`）
> 范围：`electron/shop-item-db.ts` / `shop-item-handlers.ts` / `ae-receiver.ts` / `product-handlers.ts` / `order-db.ts` / `shop-db.ts`、`src/modules/goods/{useSkuPool.ts, components/*}`、`scripts/*`、`SellerKitExtensions/extensions/ae-profit`
> 方法：逐条读代码 + **两个可复现脚本实跑**（非静态推断）+ 门禁实跑 + 断言反查夹具
> 结论一句话：**功能面做到了八成五，门禁全绿；但有 1 个 P0（色图采纳写错表，会污染订单归款）、2 个 P1（第二写入者漏透传、保底通道落错桶），另有 8 条与修订后方案的偏差。**
>
> **2026-10-13 后续：P0-1 已修**（色图改落订单域 `oi_images`，并加了编译期品牌类型 + 端到端闭环断言；真库盘点确认**影响面 0 行**）。详见 [P0-1 处置](#处置2026-10-13-已修落在哪个库由消费端决定)。
>
> **2026-10-14 后续：P1-1、P1-2 已修**（点名的店铺 pin 住不再落桶 + 岛的三个写入点补齐 `shopUrl`，并给「店铺全量提交」加了一道静态守卫 `check-shop-upsert-fields.mjs`）。P2 / P3 仍未修。

---

## 0. 逐期核对（实现了没有）

| 期 | 方案要求 | 实现 | 判定 |
| -- | --- | --- | --- |
| P0 | `sk_shops.shop_url` 建表 + 补列两处同向、契约五处、登记表单字段、列表「打开店铺」、全量提交透传 | 全部在位：建表 `shop-db.ts:152` / 补列 `:198`、宿主表单 `ShopRegistryView.vue:291,517`、行内链接 `:187` | ✅ 但见 **P1-2**（第二写入者） |
| P1 | `/ae/shop-items/ingest` + `pl_shop_items` + 店铺匹配四级 + 未登记落 0 + 收养 + `lastItemsIngestAt` | 端点 `ae-receiver.ts:164`（token→限速→schema→逐条消毒，与订单端点同防线）；表 `shop-item-db.ts:128`（唯一键含 `store_key` ✓ 审查修正）；匹配 URL 归一同口径 ✓；收养 `:486`；`lastItemsIngestAt` `ae-receiver.ts:49` | ✅ 见 **P2-1/2-2** |
| P2 | 右栏第三段：三段控件、状态条、接入引导、未登记警告条、认款三态、勾选纪律、平台从快照带出 | 全在位 `PoolPane.vue:346-583`；`onlyUnconfirmed` 真发给服务端 `useSkuPool.ts:488`（CHANGELOG 记的那个 bug 确已修） | ✅ 见 **P2-3** |
| P3 | 向导三块、发号只读、供应商必选、不在渲染层二次解析、色号促确认、结构化回执 | 全在位 `ShopItemWizard.vue`；`parseSkus` 只读规范形 `:243`；色号判据 `normalizeColor(c)===normalizeText(c)` `:232` | ✅ 见 **P2-4** |
| P4 | 下载→去重→回填→只补空+失败不外抛；**色图采纳为款色绑定图** | 主图链路正确；色图链路原写错表，**已修**（见下） | ✅（修后）**P0-1** |
| P5 | 扩展选择器稳健化、分级采集、有界批量、失败跳过计数；SellerKit 侧保底通道 | 扩展侧 `protocol.js` 常量集中、双路 ID、`<20 页 / 900ms / 可停`；jsdom 19/19。保底通道复用同一写路径 | ✅ 见 **P1-1** |

---

## P0-1 · 色图采纳写错表：把「类」当成了「款」，会污染订单归款（**必须修**）

**现象**：`shop-item-image-fetch` 拿 `landImageBuffer` 返回的 `imageId`（= **`pl_images`** 的主键）去调 `adoptStyleColorImageByCode`，而那个函数读写的是 **`oi_images`**。两张表各自 `AUTOINCREMENT`，同一个库里 id 必然撞上。

取证：
- 传参来源：`electron/product-handlers.ts:644` `adoptStyleColorImageByCode(code, c.color, landed.imageId)`；`landed` 出自 `:609` `landImageBuffer(...)`
- `landImageBuffer` → `upsertImageRecord` → **写 `pl_images`**：`product-handlers.ts:498` / `product-db.ts:1806-1813`
- 消费函数全部读 **`oi_images`**：`order-db.ts:604`（查 `style_color_id`）、`:609`（查该色是否已有图）、`:613`（`setImageStyleColor`）

**复现（已实跑，脚本见下）**：先有 1 张订单图（`oi_images` id=1），再落 1 张采集色图（`pl_images` id=1），按生产参数调用：

```
oi_images 里那张订单图 id = 1
采集色图落 pl_images 得到 imageId = 1
调用前：订单图的 style_color_id = null
adoptStyleColorImageByCode 返回 = {"bound":true}
调用后：订单图的 style_color_id = 1      ← 改了别的表的别的行
```

**影响（两个都严重）**：
1. **§8 的色图闭环没闭上**：色图永远不会绑到款色上 ⇒ 订单同图走既有去重分支也归不到色。
2. **跨域脏写**：`oi_images.style_color_id` 就是订单的「归类状态」（方案 §8.1）。这一下把**任意一张订单图**判成了某个款色 ⇒ 那张订单的款/色被改错，而且回执还说 `bound:true`（界面显示"色图绑定 1 张"）——**用户以为做了、界面也说做了、动的是别的东西**，本仓"静默失败三件套"的教科书形态。若 `oi_images` 恰好没有该 id，则退化为静默 no-op（`reason` 为空，界面把它算进"跳过"）。

**修法（两个方向，需你拍板）**：
- A（贴方案 §8.3 原意）：`shop-item-image-fetch` 的色图落点改走订单域 `oi_images`（`insertImage({fingerprint, urlFingerprint, sourceUrl: 色图URL, localPath})`），再把那个 id 交给 `adoptStyleColorImageByCode`。好处：闭环成立、订单按图归色真的能命中；代价：色图进入 `oi_images`（方案 §5 明确"采集图直接写 oi_images（认款前）不做"——但**认款后**采纳正是 §8.3 要的）。
- B（最小改动）：让 `adoptStyleColorImageByCode` 接受 `pl_images` 的 id 并改读写 `pl_images`/款色。代价：订单侧 `order-download-image` 的图在 `oi_images`，两侧不同库 ⇒ **闭环仍然闭不上**（只剩"界面上看得见色图"）。

建议 **A**；无论选哪个，**夹具必须跟着改**（见 §3）。

## 处置（2026-10-13 已修）：落在哪个库由**消费端**决定

用户给的用途是判据：「色图主要是要跟**订单导入后根据图片查找颜色**，归类核对、拿货单等地方使用」。顺着这条消费链查下去，答案不是偏好问题：

| 消费端 | 读的是什么 |
| -- | -- |
| 拣货单 `picking-db.ts:121` | `oi_orders.image_id → oi_images → i.style_color_id → oi_style_colors → oi_styles` |
| 拿货单 `purchase-db.ts:490 / :790` | 同上（`JOIN oi_images i ON o.image_id = i.id`） |
| **按图找色**的唯一入口 `order-handlers.ts:584` | 下载后算内容 SHA-256 → `findImageByFingerprint` 查 **oi_images** → 命中即复用那一行（原注释：**「含识别状态 / 款色归属 styleColorId / 识别结果」**） |

色图在 `pl_images` 里，最后那条查询永远看不到它 ⇒ **闭环一次都不闭**。故取 A，并且不止"改个写入目标"，而是**消掉两份落库实现**：

- 新建 `electron/order-image-land.ts` —— 「远程图 → oi_images」的唯一实现（下载 → 落 `userData/order-images/` → 两级去重 URL 指纹 → 内容指纹 → 登记）。`order-download-image` 与 `shop-item-image-fetch` 共用它；原先各自一份去重/落盘/指纹的代码删掉。根因不是"参数传错"，是**存在两份实现**。
- `adoptStyleColorImageByCode` 的 `imageId` 参数改成品牌类型 `OrderImageId`（`number & {__orderImageId}`）。把 `pl_images` 的 id 传进来现在**编译不过**（`tsc` 报 `TS2345`），而不是留到运行时静默写脏。

### 影响面取证（真库只读盘点，已实跑）

`.backup` 出副本后统计（`sellerkit.db`，2.1MB）：

| 指标 | 值 |
| -- | -- |
| `oi_images` 总行数 | 35 |
| `style_color_id` 非空 | 24（**全部**被 `oi_orders` 引用，孤儿 0 行） |
| `pl_images` 行数 / `source` 分布 | 10，**全部 `order-image`** |
| `pl_shop_items` 表 | **不存在**（懒建表，从未被触发） |

⇒ `shop-item-image-fetch` 在真机上**一次都没跑过**（`pl_images` 里没有任何 `shop-item` 来源的行，采集表都还没建）⇒ **P0-1 造成的脏数据 = 0 行**。24 条已绑定都是映射回填（`reassignOrdersByItemIds`，2026-10-09 / 10-11 / 10-12 三个时点）写的占位色，与本 bug 无关。

### 补上的守卫（不再恒绿）

`scripts/shop-item-db-smoke.cjs`：

1. **色图落点 = oi_images**：走**生产同一条** `landOrderImageBytes` 取 id（不再是"手工插一行 oi_images"），断言该 id 在 `oi_images` 里、指纹等于字节 SHA-256、且 `pl_images` 里没有这张图。
2. **按图找色端到端闭环**：色图采纳 → 再以**同内容不同 URL** 走同一条函数模拟订单导入 → 断言复用**同一行**且该行带着款色。这条直接验的是闭环本身。
3. **反例**：把 `pl_images` 的 id 喂给采纳函数 ⇒ 必须 `bound=false`，且 `oi_images` 一行都不许改。
4. 原有 5 条"只补空"边界用例的夹具同步改成走 `landOrderImageBytes`（多张图靠 PNG 尾部拼唯一尾巴实现，文件头仍是合法 PNG）。

**变异复核**（两条都确认转红后已还原）：
- 把色图改回 `fetchImageToLibrary`（pl_images）⇒ `tsc` 直接失败：`TS2345: Argument of type 'number' is not assignable to parameter of type 'OrderImageId'`。
- 去掉 `landOrderImageBytes` 的内容指纹去重 ⇒ 「按图找色闭环」用例转红。

> ⚠️ 跑 `shop-item:smoke` 时若环境里带着 `ELECTRON_RUN_AS_NODE=1`（本机的工具环境会继承），`require('electron')` 返回路径字符串、`app` 为 undefined，新增用例会全红。用 `env -u ELECTRON_RUN_AS_NODE electron scripts/...` 跑。

---

## P1-1 · 保底通道点名了店铺，商品却掉进未登记桶

**现象**：`importManualItems` 用「店铺 id → 取店实体 → 反查身份」的方式定位店铺。若该店**既没填地址、也没填平台店铺 ID**（P0 之前登记的店就是这样，两个字段都是可选的），三个身份全空 ⇒ `matchShopByStore` 一路回落，最终 `shopId=0`。

取证：`shop-item-db.ts:305-313`（组装 store）→ `:167-189`（`url` / `storeId` 都空 → 返回 `{shopId:0, storeKey:name}`）。

**复现（已实跑）**：

```
店A（无地址/无平台ID）id = 1
手贴到店A 的回执 = {"received":1,"inserted":1,"updated":0,"skipped":0}   ← 报"成功"
  999000111  shop_id=0  ← 落到未登记桶   store_key="我的店A"
  999000222  shop_id=2  store_key=""      ← 有地址的店B 正常
```

**影响**：用户在弹层里**显式选了**归属店铺，结果商品进未登记桶 —— 界面显示"店铺未登记"、**勾选被禁用**（`PoolPane.vue:520`）、无法认款。回执还说"新增 1"。这正是本仓那条纪律的反例：*用户点名的参数必须严格生效，改判会让用户以为成功*。

**修法**：点名路径不走"按身份反查"，直接把 `shopId` 写进落库参数（`upsertShopItems` 已有 `matchShopByStore` 这一层，给点名场景加一条"显式 shopId 优先"的入口即可）；`store_key` 按规范形留空。

### 处置（2026-10-14 已修：点名是**证据**，不是提示）

| 改动 | 位置 |
| --- | --- |
| `matchShopByStore(store, pinnedShopId?)`：pin 压过 URL / storeId 两级（且只在店铺真的存在时生效，避免写出 `shop_id` 悬空的行） | `electron/shop-item-db.ts:167` |
| `upsertShopItems(payload, opts?)`：帧不带身份，`opts.pinnedShopId` 单独传 —— **帧是"采到了什么"，pin 是"人说是谁的"** | `electron/shop-item-db.ts:233` |
| `importManualItems`：删掉"取店实体 → 反查 url/storeId/name"那条绕路；**点名严格**（`getShop` 拿不到 ⇒ `ok:false` + 错误上行，不静默落桶）；`shopId=0` 保持落桶语义 | `electron/shop-item-db.ts:292` |
| handler：`!r.ok` 直接抛 ⇒ 弹层错误条显示原因（不再回报"已接收 N 条"） | `electron/shop-item-handlers.ts:32` |

守卫（`scripts/shop-item-db-smoke.cjs`，5 条，**此前是 0 条覆盖**）：

| 用例 | 变异复核 |
| --- | --- |
| 点名到「只有店名」的店 ⇒ 落该店、`store_key=''`、`source='manual'`、未登记桶为空、汇总也跟着对 | 去掉 pin（改回反查身份）⇒ **转红** ✅ |
| 点名到有地址的店 ⇒ 同样落该店（防 pin 把本来就对的改坏） | 上一条变异下**仍绿**（说明只靠这条抓不住） |
| 幂等：同店同 ID 再贴 = 更新不新增；空 ID 计 `skipped` | — |
| 点名到不存在的店 ⇒ `ok:false` + 一行都不许落 | 去掉严格校验 ⇒ **转红** ✅ |
| `shopId=0`（下拉显式选的未登记桶）⇒ 落桶语义不变 | — |

> ⭐ **夹具纪律**：第一条的店**绝不给它补地址也不补平台 ID**（`nameOnlyShop()`）—— 生产里老店就是两个都空。补上就等于把这条用例关掉：变异实测里"点名到有地址的店"那条在坏实现下**照样绿**，正说明覆盖形状决定守卫有没有用。
>
> ⚠️ **派生缺口（未修，需决策）**：`shopId=0` 的手贴行 `store_key=''` ⇒ 以后登记该店时 `adoptShopItemsForShop`（按 name/url/storeId 三键收养）**收养不到它**，这些行会永久留在未登记桶里。可选补法：手贴弹层在选「未登记桶」时让用户输入一个店名存进 `store_key`（唯一键含 `store_key`，不影响别的桶），或明确要求"登记完再重贴一次"。

---

## P1-2 · 第二个写入者漏透传 `shop_url`：在「店铺账号管家」里编辑一次店铺 = 静默清空地址

方案 §4.5-3 与审查 P1① 都把这条写成了硬约束（"漏一处 = 编辑一次静默清空"），但只改了宿主那一处：

- 宿主版**对**：`src/modules/goods/components/ShopRegistryView.vue:480`（编辑回填）+ `:517`（提交透传）
- 岛版**漏**：`ui-plugins/shop-accounts/src/components/ShopRegistryView.vue:191-201` 的 `shopUpsert` 载荷里**没有 `shopUrl`**，整个文件搜不到 `shopUrl`（既不回填也不透传）

`upsertShop` 是**全量提交**（`shop-db.ts:562` `normalizeShopUrl(input?.shopUrl)`，缺省 → `''`）⇒ 从那个岛编辑任何一家店，**地址被清空**。

**影响**：地址是采集帧唯一的精确连接键 ⇒ 该店之后采集的商品**全部落未登记桶**，症状正是审查 P1① 要避免的"大面积失配"，而且用户不会把"我昨天在店铺账号管家里改过备注"和"今天采不到"联系起来。

**修法**：岛版表单加地址字段（回填 + 透传），与宿主版同口径；并在 `shopUpsert` 的消费者清单里记一条（写入者有两个，不是"契约五处"就够）。

### 处置（2026-10-14 已修：漏的是**三处**，不是一处）

顺着"全量提交"这条纪律把**所有** `shopUpsert` 写入点扫了一遍，岛里漏的是 **3 个**（原报告只看到登记页那个）：

| 写入点 | 症状 | 处置 |
| --- | --- | --- |
| `ui-plugins/shop-accounts/.../ShopRegistryView.vue:196` | 编辑店铺 ⇒ 地址被清空 | 补表单字段（地址输入框 + 回填 + 表列「打开」链接），提交透传 |
| `ui-plugins/shop-accounts/.../AccountEditor.vue:200` **解除套装关联** | **解绑一次 = 顺手清空地址**（该函数注释里就写着"必须整行回传，漏传任何字段都会把它静默清空"，结果自己就漏了） | 补 `shopUrl: row.shopUrl ?? ''`，并给 `SetShopRow` 补上该字段 |
| `ui-plugins/shop-accounts/.../AccountEditor.vue:168` 快速登记名下店铺 | 新建，无地址可填；但字段必须**出现** | 显式传 `shopUrl: ''`（出现且为空 = 没填，不出现 = 漏传） |

**根因不是"某处参数写漏了"，是「一个实体有多个写入者，字段同步靠人记」** —— 与 P0-1 同源（那边是两份落库实现，这边是 N 份提交参数）。岛是独立工程（自己的 `package.json` / vite 构建），拿不到宿主类型 ⇒ TS 帮不上忙。所以除了补三处，还加了一道**门禁**：

- **新增 `scripts/check-shop-upsert-fields.mjs`，并接进 `npm run verify`**
- 必填字段清单**从 `src/types.ts` 的 `ShopUpsertInput` 读出**（不是写死在脚本里）⇒ 以后给店铺加字段，清单自动跟着变，漏了的写入者在门禁里就红
- 认三种写法：岛的 `shopUpsert(`、宿主的 `shopApi.upsert(`、直连桥的 `db.call('shop','upsert',...)`；非字面量的透传点（如 `host.ts:208`）自动跳过
- **空转守卫**：一处调用点都没扫到 = 正则失效/文件搬走 ⇒ 直接判失败（"全绿"不能来自"没扫到"）
- 当前扫到 4 处，全绿；变异实测：把 `AccountEditor.vue:200` 的 `shopUrl` 删掉 ⇒ `❌ …:200 漏传 shopUrl`，`EXIT=1`

> ⚠️ **分发坐标**：岛产物 `ui-plugins/shop-accounts/dist/` 已重建（含 `shopUrl` / 「店铺地址」），但**已装机器** `~/Library/Application Support/seller-kit/plugins/shop-accounts/dist/` 仍是 10-05 的旧产物 ⇒ 不重新发布/安装，界面上看不到这次改动。

---

## P2（应修/待确认）

1. **`raw_json` 不是"整帧快照"，未知字段进不来。** 接收端先 `sanitizeShopItem` 白名单化（`ae-receiver.ts:199-205`），落库时 `raw_json = safeJson(it)` 存的是**白名单后的对象**（`shop-item-db.ts:257`）⇒ 方案 §3.2「未知字段进 raw_json」这条字段演进保险实际是空的。另 `raw_json` 无 ≤64KB 截断（方案 §3.3 写了上限；body 上限 1MB、单批 100 ⇒ 单行可达 ~1MB）。
2. **三列采了但没有下游读者**：`source` / `status` / `url` 在采集段界面**从不显示**（`PoolPane.vue` 里 `r.status`/`r.source` 的命中全属队列行与映射行）。`source` 的存在理由被写成"手贴的与采来的在表上必须分得开，否则用户以为采到了脏数据"，但表上没有任何地方体现它；`status`（"下架商品标出"，方案 §2.1）与 `url`（"打开商品页"）同样。要么给它们一个可见处（状态列/来源徽标），要么承认这是为以后留的列并写清。
3. **向导的失败态不可恢复。** ①步"建档"若抛（编码已存在，`product-db.ts:337` 明说 `产品编码已存在：STYLE-042`），而编码格是 `readonly`（`ShopItemWizard.vue:16`）、`nextCode` 只在 `onMounted` 取一次（`:268`）⇒ 用户**改不了编码也无法重试**，只能关掉重开——重开会拿到新编码、又建一个款（脏数据）。方案 P3 的验收写的是"可重入"，实现只做到"不重复建"，没做到"能继续做"。建议：失败后允许重取发号（或把编码格在该错误下转为可编辑）。
4. **§4.1「平台随地址证据带出」未实现**：填了 `aliexpress.com` 的地址不会默认选中平台（`ShopRegistryView.vue` 里只有 placeholder 提到 aliexpress，无推断逻辑），而界面纪律 #2 写的是"默认值只能来自证据（URL→平台）"。
5. **§3.4 第 3 级（同名唯一命中 → 只作建议）未实现**：`matchShopByStore` 只有 URL / storeId 两级 + 未登记，第三级是空的。功能上不写库所以无风险，但方案那一级确实没落地（要么补、要么在方案里划掉）。
6. **列表缩略图无 `@error` 降级**：方案 §8.4-1 要求"URL 热链 + `@error` 降级"（R4 热链失效的对策），采集表的 `img` 只有 `referrerpolicy="no-referrer"`（`PoolPane.vue:528-534`）⇒ 坏链会显示破图。向导色图行同样。

## P3（文档/一致性）

7. **方案文档状态陈旧**：头部仍写"**状态：待评审（未动任何代码）**"，D1–D12 全列"待评审"；§8.8 路线仍把 L2 建议 + `img_key` 写在本期，与审查裁退（"读取侧 L2 建议缓一步"）矛盾；D11/D12 未定案但 §8.9.5 已按"R1 已关闭"叙述。五期已落地，这份文档现在读起来与仓库现状相反。
8. **评审的裁退项没有全守**：① `shop-items-summary` 当时"暂缓"，实际实现了（可接受：状态条要用，但这属于偏离，应在方案里补上理由）；② 扩展侧 `ITEM_BATCHES` / `ITEM_BATCH_KEEP: 20` + popup「最近批次」正属被砍的"`ae_sync_log` 式批次记录"，仍在。
9. `content.js:168-169` 重复声明 `ITEM_PAGE_LIMIT` / `ITEM_PAGE_DELAY_MS`（内容脚本不能 import ESM，与主进程的"两处同向"同类），建议注释里点明"改一处必须改两处"，否则将来只改 `protocol.js`。

---

## 3. 门禁与**断言可信度**（门禁全绿 ≠ 这段是对的）

实跑现状（全部通过）：

| 门禁 | 结果 |
| -- | --- |
| `tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` | ✅ |
| `npm run verify`（IPC 契约） | ✅ 契约一致（`shop-item-handlers` 3 个通道在册） |
| `npm run verify:docs` | ✅ 无悬空引用 |
| `npm run goods:ui`（宽 + 默认 + 窄，三遍） | ✅ **EXIT=0**（含第三段的 20+ 条与保底通道 9 条） |
| `npm run shop-item:smoke` | ✅ 全过（含 5 条色图采纳用例） |
| `SellerKitExtensions` `npm test`（jsdom） | ✅ 19 passed |

**但这 5 条色图用例当时是一条恒绿的守卫**（已于 2026-10-13 修掉，见 [处置](#处置2026-10-13-已修落在哪个库由消费端决定)）——它们与 P0 处在**不同的表**上：

```js
// scripts/shop-item-db-smoke.cjs:311-318
/** 插一张已入库的图（内容指纹唯一；adoptStyleColorImageByCode 只认 imageId） */
const insertImg = (fp) => odb.insertImage({...});   // ← 写 oi_images
```

生产传进来的是 `pl_images` 的 id，夹具插的是 `oi_images` 的行 ⇒ **夹具复刻的是"函数期望的形状"，不是"生产传进来的形状"**——正是本仓那条铁律（*夹具复刻生产形状，不是合理形状*）的实际现行犯。`goods:ui` 那边 `shopItemImageFetch` 是桩，返回罐头数据，结构上也不可能发现。

**验伪方法（建议直接变成新用例）**：色图用例改走生产同一条落库函数取 id（`pdb.upsertImageRecord({fingerprint, localPath, source:'shop-item'})`），断言"色图 URL 对应的那一行 `oi_images`（或款色绑定）成立"。加上这条，P0-1 会立刻变红。

同样的自查建议给 P1-1：`importManualItems` 的用例目前只覆盖"点名到有地址的店"，补一条"点名到**只有店名**的店"（夹具别给它补地址——那是生产里很常见的形状）。

> **2026-10-14 复核**：这条自查挖出来的比预想严重 —— `importManualItems` 此前是 **0 条用例覆盖**（`grep manual scripts/shop-item-db-smoke.cjs` 无命中，不是"只覆盖了有地址的店"）。已补 5 条并做变异复核（见 [P1-1 处置](#处置2026-10-14-已修点名是证据不是提示)）。
>
> 同理，**"店铺登记表"这类多写入者实体，门禁里此前一条"字段有没有漏传"的检查都没有**。已补 `scripts/check-shop-upsert-fields.mjs`（接进 `verify`），见 [P1-2 处置](#处置2026-10-14-已修漏的是三处不是一处)。

---

## 4. 建议的收口顺序

1. ~~**P0-1**（跨域脏写，越晚修脏数据越多）：定 A/B 方案 → 改落点 → 改夹具为生产形状 → 变异复核 → 重建 dist 复跑全门禁。~~ ✅ **已完成**（2026-10-13）：定为 A，见 [处置](#处置2026-10-13-已修落在哪个库由消费端决定)。全门禁复跑通过（`tsc` / `verify` / `vue-tsc` / `verify:docs` / `build` / `goods:ui` / `shop-item:smoke` / `order:smoke` / `product:smoke` / `vitest` 689 passed）。
2. ~~**P1-1**（点名参数失真）：点名优先直写 `shopId`，补"只有店名的店"用例。~~ ✅ **已完成**（2026-10-14）：pin 压过身份反查 + 点名严格；补 5 条用例并变异复核。派生缺口（手贴到未登记桶的行收养不到）待决策。
3. ~~**P1-2**（第二写入者）：岛版补字段，并在 `shopUpsert` 上标"两个写入者"。~~ ✅ **已完成**（2026-10-14）：岛的 3 个写入点补齐（含"解除套装关联"会清空地址那处），并新增字段全量性守卫接进 `verify`；岛 dist 已重建，已装机器需重新发布/安装。
4. P2 逐条（`raw_json` 白名单 / 向导失败态 / `@error` 降级 / 三列的下游）。
5. 方案文档与决策表回写（§7 状态、§8.8 范围、§3.4 第 3 级），否则下一轮还会按"待评审"重复讨论一遍。

## 5. 方法局限

- 只看代码与自建夹具，**未在真机点一遍界面**；P2-4（平台随地址带出）一类"交互该有但没有"的结论来自静态检索，不排除藏在未读的 watch 分支里（已按 `shopUrl`/`platform` 全文检索过，未命中）。
- P0-1 的影响面（"已有多少订单被绑错色"）未取证：需要查真库 `oi_images` 里 `style_color_id` 非空且 `source_url` 不像订单图的行数——**这属于对用户真实数据的只读盘点，需你同意后我再跑**。
