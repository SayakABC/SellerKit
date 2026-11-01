# 新增产品的款编码由系统发号，界面只读

**结论**（2026-10-30 用户口径「新增产品时，款编码自动生成，不要手动填写」）：

- 新增产品抽屉打开即调 `api.nextCode()` → 主进程 `product-next-code` → `order-db#nextStyleCode`
  （编码池 = `oi_styles ∪ pl_products`，形状 `STYLE-001`），填进编码框并 `readonly` 展示。
  编辑模式原本就只读（编码是订单 / 采购 / 成本三域的关联锚点），所以两种模式都没有手填入口。
- **不要在渲染层自己按 `max+1` 发号**：订单识别（`resolveStyle`）也会占号，漏掉识别侧已用的序号时
  只会撞 `pl_products.code` 唯一键，报错方向全反。建款向导与产品抽屉必须共用同一个发号器。
- **撞号要自动换号**：抽屉打开后别处可能先占了同号。新增保存撞「产品编码已存在」时自动重新发号并
  toast 告知；编码只读、没有手改出口，不换号就会变成反复保存、反复失败。
- **关闭确认不能把自动值算成"填过东西"**：`createTouched` 判据因此**不含** `form.code`，否则每次点 ✕
  都会弹「这个新产品还没创建」。

**取证**：

- 模板与只读：`src/modules/goods/components/ProductEditorDrawer.vue`（编码框 `readonly`、旁标
  `data-act="ed-code-auto"`、失败提示 `data-act="ed-code-error"`）。
- 发号与撞号兜底：同文件 `loadCreateCode`（约 659 行）与 `doSave` 的 catch（约 770 行）；
  发号器：`electron/product-handlers.ts:184` / `electron/order-db.ts:1742`；
  向导共用：`src/modules/goods/components/ShopItemWizard.vue:208`。
- 守卫：`scripts/goods-ui-smoke.mjs:1527` 新增 3 条 —— 打开即发号 + `readOnly`、旁标「自动生成」、
  只发号就关不弹"还没创建"；`npm run goods:ui` 三窗口遍 `SMOKE: ALL PASS`。
