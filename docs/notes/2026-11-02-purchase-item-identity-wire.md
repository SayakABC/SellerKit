# 拿货明细的款色身份在 IPC 消毒层被清掉（2026-11-02）

## 结论

「生成拿货单后，在单据里还要再选一次颜色」不是界面设计，而是**写入链断了两处**：
`preload.ts` 与 `purchase-handlers.ts` 各有一份明细行白名单，**都没放行 `styleColorId`**。
渲染层（`createFromPick`）与 `purchase-db.insertItems` 都支持这个字段，但两道消毒层把它折掉了 ⇒
`purchase_items.style_color_id` 落库恒为 0 ⇒ 编辑器按「色未定」处理（该款有 2 个以上色时逐行出
「色未定 · 选一个」），已拿也只能回落 `款|色|码` 文本键。

修法：两份白名单都补上 `styleColorId`（非负整数），并加静态守卫
`tests/purchaseItemIdentityWire.spec.ts` —— 剥注释后断言两个 `sanitize*` 函数体里都有这个字段。

## 取证

- 真库只读查询（`~/Library/Application Support/seller-kit/sellerkit.db`）：
  `purchase_orders` #43 / #44 / #45（2026-11-02 生成的草稿）共 26 行，
  `style_color_id > 0` 的行数为 **0**；而它们的 `color` 列已经是「白色 / 粉色 / 蓝色」等真实色名。
  ⇒ 颜色文字透传成功，身份 id 在某个白名单处丢了。
- 代码：`electron/preload.ts` 的 `sanitizePurchaseItems`、`electron/purchase-handlers.ts` 的
  `sanitizeItems` 原字段清单只有 `styleCode/styleName/color/size/qty/priceCents/suggestionQty`；
  `purchase-db.insertItems` 末位明确写入 `style_color_id`。
- 守卫：`npx vitest run tests/purchaseItemIdentityWire.spec.ts` 2/2 PASS；
  变异（删掉任一白名单里的 `styleColorId`）对应断言变红。
- 回归：`npm run today:ui` **366 PASS / SMOKE: ALL PASS**；
  `npx tsc -p tsconfig.electron.json --noEmit` 0；`node --check scripts/today-ui-smoke.mjs` 通过。

## 边界（别误判成"修完历史单就自动好了"）

- 已经落库的 #43 / #44 / #45 仍是 `style_color_id = 0`；这些行需要**人选一次色**
  （编辑器里选完保存，现在会真的把 id 存住，不会再每次重选）。
- 新生成的拿货单会带着清单行的 `styleColorId` 进库，编辑器不再出「色未定」。
- 不做"按色名文本自动绑 id"：色名是可变标签，历史快照可能被改过；现有自动边界仍只处理
  「占位色名 + 该款唯一色」这一种能由事实唯一确定的情况。
