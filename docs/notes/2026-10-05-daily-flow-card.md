# 发货主线流程卡：五条结论（串联语义 / 跳不进岛内页 / 注入脚本三个坑）

> 场景：「今天」页新增「每日发货流程」卡（导入 → 归类核对 → 拣货 → 算钱，后三步标注在插件里）。
> 结论按"下次开工必须记得"排序，每条带取证。

## 1. 流程卡的「当前步」必须**串联**推导，不能各步独立判断

**结论**：前一步没完成时，后面的步骤一律 `todo` + 写明「等第 N 步」。各步独立判断会让
**多个步骤同时高亮**，"当前该做哪一步"这个卡片的唯一职能反而答不出来。

**取证**：初版第 2/3/4 步各看自己的数（未识别款 / 有 SKU 要拣 / 缺数据），
假桥夹具下第 2/3/4 步**同时**是 `now` —— 截图上是三块橙边（`/tmp/flow-light.png` 首版）。
修法：`wait2 = !hasOrders ? '等第 1 步' : needClassify ? '等第 2 步' : ''`，
`wait3 = wait2 || (needPicking ? '等第 3 步' : '')`，`state = wait2 ? 'todo' : …`。
守卫：`scripts/today-ui-smoke.mjs` 的
「当前步唯一：高亮（now/gap）的步骤数 = 1，且第 2 步未完成时第 3/4 步是 todo 并写明「等第 2 步」」。
**变异复核**：把第 3 步的 `state` 改回 `!hasOrders ? 'todo' : needPicking ? 'now' : 'done'`
→ 输出 `高亮数=2` → 该断言变红（47 PASS + 1 FAIL）；复原后 48 PASS。

> 这条是**拍图拍出来的**，冒烟全绿时没暴露 —— 因为原断言只要求"第 2 步是 `is-now`"，
> 没说"别的步骤不能也是"。凡"当前/唯一/默认"这类语义，断言要**同时钉住正例与排他**。

## 2. 宿主**跳不进岛的某个页**：`switchModule` 的 `action`/`payload` 目前无消费方

**结论**：`switchModule(moduleId, action?, payload?)` 的参数是**半接线**的 ——
`AppShell.vue:490` 把 `detail.action` 存进 `window.__switchModuleAction`，但**全仓没有任何读取方**。
所以文案可以点名"在「订单归类」插件的「拿货对账」页"，按钮只能承诺**打开那个岛**（不能承诺落在那一页）。

**取证**：

```bash
grep -rn "__switchModuleAction" src/      # 只有 AppShell.vue:491 的写入，无读取
grep -rn "拿货对账" ui-plugins/order-insight/dist/views/stockin.js
#   → export default { id: 'stockin', title: '拿货对账', order: 60 }
```

**待办**（未做，属 S3+ 范围）：若真要深链到岛内页，得给 `UiIslandView`/岛加"打开时消费一次性动作"的协议，
并按 `docs/notes/2026-09-30-plugin-vs-host-boundary.md` 的分界判据确认它算主干契约还是岛内约定。

## 3. 岛内页签名不在宿主可枚举范围 ⇒ 只能进文案守卫的 `ALLOWED_NON_ENTRY`

**结论**：`tests/uxEntryNames.spec.ts` 的合法名集合 = 宿主模块名 ∪ 岛 `displayName` ∪ `ALLOWED_NON_ENTRY`。
「拿货对账」是**岛内页签**（既不是模块名也不是岛名），文案里引用它就会被判悬空。
处理方式与先例「识别设置」一致：加进 `ALLOWED_NON_ENTRY` 并**逐条写明理由**。

**取证**：加豁免前 `npx vitest run tests/uxEntryNames.spec.ts` 报
`文案让用户去一个不存在的入口: expected 'src/modules/today/TodayView.vue: 「拿货对…'`；加后 2 passed。

⚠️ 豁免是**按名字**生效的 ⇒ 岛改页签名时要同步这里，否则守卫会对一个已不存在的名字继续放行。

## 4. 注入式假桥 / 断言脚本里的注释**不能含反引号**

**结论**：`FAKE_BRIDGE` / `ASSERT_SCRIPT` 都是 `scripts/*-ui-smoke.mjs` 里的**模板字面量**，
注释里写一个 `` ` `` 会**提前终止模板串**，报错却指向注释那一行，形如
`SyntaxError: Unexpected identifier 'xxx'`（caret 指在注释文字中间），极易误判成"别的语法问题"。

**取证**：本轮踩两次 —— ① 注释里写 `` `evts('switch-module')[0]` `` 报 `Unexpected identifier 'evts'`；
② 注释里写 `` `{success:true, data:null}` `` 报 `Unexpected token '{'`。
**纪律**：改完注入脚本必跑 `node --check scripts/<x>.mjs`（该文件头部本就有这条提醒，别跳过）。

## 5. 「复用冒烟脚本当截图器」的三个坑

沿用 `docs/notes/2026-10-01-ui-style-system-audit.md` 的做法（`'--dump-dom',` → `'--window-size=…','--screenshot=…'`）时：

1. **主题注入不能写在页面脚本里**：`process.env` 在浏览器里不存在 ⇒ 整段断言脚本首行就抛，
   但**图照样出**（页面由 app 自己渲染）⇒ 得到一张"看起来正常"的假绿截图。
   正确做法：主题在 **Node 侧**注入 —— `html.replace('</head>', () => '<script>…</script></head>')`。
2. **必须 `return` 在跳转类断言之前**：断言脚本里有"点下一步真的跳"，跑完页面已在目标模块，
   截到的是被跳过去的岛，不是要审的页。
3. **截图前先让夹具忠实**：假桥兜底 `{success:true, data:null}`，而 `externalLoader.ts:44`
   判的是 `!r.data` ⇒ 每张截图右下角常驻红 toast「扫描插件目录失败（IPC 不可用）」。
   补 `pluginsScan` 桩（返回 `{root, plugins: []}`，与 `plugins-handlers.ts` 真形状一致）——
   目的是**忠于真形状**，不是为了消颜色：常驻红 toast 会训练人忽略红 toast。

（文件放仓库内、用完即删：`scripts/` 之外跑会 `ERR_MODULE_NOT_FOUND: xlsx`。）
