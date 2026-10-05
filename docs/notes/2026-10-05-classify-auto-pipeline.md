# 订单归类的三层链路：确定性 / 指纹 / 模型各管什么，以及四个已取证的缺口

> 日期：2026-10-05 深夜 · 触发：用户要求删掉「归类核对」的「识别未归类」批量按钮，并问
> 「怎么做才能更方便归类 / 自动识别品类、颜色和 logo」⇒ 先盘点现状再谈方案。
> 涉及：`electron/order-db.ts` / `electron/product-db.ts` / `src/lib/orderClassifier.ts` /
> `src/lib/styleMatcher.ts` / `src/core/ai/openaiCompatible.ts` / `src/modules/today/classify.ts`。

## 结论先行

**归类的正确顺序是「映射 → 指纹 → 模型」，而前两层已经建好了。**
现在的问题**不是模型不够强，而是人工核对的结果没有回流到确定性层** ⇒ 同一件商品的订单在被
一条条重新判断，而本该"配一次、此后全自动"的那张表一直是空的。

## 一、三层链路（现状，均已取证）

| 层 | 机制 | 落点 | 触发时机 |
| --- | --- | --- | --- |
| **L0 确定性** | 商品ID → 款 + 色（`pl_shop_sku`，只认 `status='confirmed'`） | `resolveOrderSku` → `autoAssignByMap` | **写时**：订单落库那一刻（`order-db.ts:1062` 附近） |
| **L0 回填** | 配完映射回头补存量未归款的订单 | `reassignOrdersByItemIds`（`order-db.ts:1117` 附近） | 映射写入成功后自动跑 |
| **L1 指纹** | `category + features` 归一化后算指纹；人工"点名某款"会把该指纹**记入该款** | `buildStyleFingerprint`（`styleMatcher.ts:33`）+ `oi_style_fingerprints` 表 | 识别落库 / 人工保存时 |
| **L2 模型** | VLM 出 `category / features / color / logo / style_name` → 归一化 | `createVisionEngine` → `classifyResult`（`orderClassifier.ts:195`） | 只在被调用时（现无入口） |

**L0 已升到「款 + 色」级**（颜色存 `pl_shop_sku.spec`），背景见
[商品ID 映射带上颜色](2026-10-05-mapping-carries-color.md) —— 也就是说**"品类 + 颜色"对已配映射的
商品早已是确定性的、零模型调用的**；模型真正要负责的只是"没配过映射的商品"。

## 二、缺口（四个，都有取证）

### 1. ⭐ 人工核对**不回填** L0 —— 这是最大的杠杆

归类核对页保存时走 `orderUpdate(reclassify)` + `orderStyleAssign`（`classify.ts:149` 起），
写的是**指纹 → 款**；它**从不写 `productSkuMap`**。而 `productSkuMap` 的渲染层调用方只有
「货与成本」的 `src/modules/goods/api.ts`。

后果：用户在核对页把某商品判对了 10 次，第 11 条订单照样进待核对队列 ——
**人工工作量不随时间递减**，而这正是"更方便归类"要解的那件事。

佐证量级：真实库上 42 行订单的商品ID **去重后只有 17 个**
（见 [差距审查要读真库](2026-10-05-gap-audit-read-the-real-db.md)）⇒ 17 条映射即可覆盖绝大多数行。

### 2. 颜色口径**两头打架**（prompt 要描述式，归一化要字典式）

- prompt 要的是"底色 + 花色"描述，示例 `藏蓝底白色条纹`（`openaiCompatible.ts:41`）；
- 归一化是**整串精确字典匹配**：`COLOR_SYNONYMS[t] || t`（`orderClassifier.ts:48`）。

⇒ 凡是模型按 prompt 输出的描述式颜色，**一律原样穿透**（既没归并、也没报错），
`oi_style_colors` 会随措辞长出无穷款色。

### 3. 品类白名单**未命中就静默保留原词**

`orderClassifier.ts:118`：`return exact || t` —— 白名单外的新词**不告警、不标记**，直接成为新指纹 ⇒
同款拆成多款（而这一层的代价很贵：拆了之后 L0 的款编码也跟着分叉）。同理 `features` 完全自由生成，
"字母印花 / 印花字母 / 字母图案"三种措辞 = 三个指纹。

### 4. `confidence` 解析了但**没有任何消费者**

`RecognitionResult.confidence` 有产出（`openaiCompatible.ts:277`），全仓 `grep confidence` 找不到
读取方 ⇒ 差得离谱的结果与稳稳正确的结果走**同一条落库路径**。

### 附带两条（不属于"识别质量"，但同属这条链路）

- **`logo` 不进指纹**（`buildStyleFingerprint(category, features)` 只有两个入参），
  且**全仓没有任何展示或下游消费者** —— 它只存在于订单表、能被搜索、在归类核对页可编辑；
  导入时恒写空串（`importSheet.ts:180`）⇒ logo 当前唯一来源就是识别/人工。
  **含义：把力气花在提升 logo 识别上，今天几乎换不来任何收益**，除非先给它一个下游用途。
- **免图订单拿不到 L0**：`autoAssignByMap` 第一行 `if (!rec.imageId) return;`
  （理由正当：归款的落点是把**图片**挂到款色上），而免图导入是被支持的 ⇒ 这类订单只能靠指纹或人工。

## 三、还有一件现成的、但闲置的东西

`oi_queue`（待识别队列：`batch_no` / `status` / `fail_count` / 断点续跑）**整套还在维护**：
10 个 IPC 通道（`src/types.ts`）、数据层（`order-db.ts` 队列段）、`order-db-smoke` 的队列用例 ——
但**渲染层零调用方**（原岛下架后没有任何页面用它）。

⇒ **要做"导入时后台识别"，队列不用重写**；若最终不做，它就与 `readEngine`/`recognizeOrder` 一样
属于"要么给个归期、要么删掉"的待办。

## 四、待拍板

识别入口的形态（导入时后台跑 / 逐行「识这张图」/ 只出建议不落库）与上面四个缺口的取舍
**尚未拍板** —— 本条只记录现状与取证，方案落地后另开一条并注明取代关系。
