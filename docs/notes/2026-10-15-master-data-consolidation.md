# 「基础数据」整合：维护功能只有一个家

> 实施 2026-10-14（模块改造 + 界面重设计），门禁与文档收口 2026-10-15。
> 用户口径：**基础数据维护相关功能整合到一起，让操作更简单、降低学习熟悉成本；不要太多文案，
> 用交互设计层面改善**，让不会用电脑的人也能快速上手。

## 一、整合的判据是「入口唯一」，不是"这一页太长"

整合前：进价录入在「货与成本 › 进价」、汇率维护在「算钱 › 成本与汇率」半区、店铺登记在两个模块
**各有一份实现**。用户为了记一家供应商要先猜"它在哪个模块的第几个页签"；两份实现则意味着改一处忘一处。

⇒ 沿用 `2026-09-30-plugin-vs-host-boundary.md` 的「入口唯一」铁律：**能力只能有一个家**，
别的页面想用它就跳转过去，不做平级第二入口。

## 二、左导航 + 右内容区，且默认落在第一项

`src/modules/shop-accounts/MasterDataView.vue`（392 行，替下 1,595 行的四页签旧视图）：
左导航六资料种类（店铺账号 / 邮件 / 店铺登记 / 企业 / 供应商 / 成本与费率）+ 右内容区。

延续 `2026-10-08-goods-page-entry-guide.md` 的结论：**并列的入口等于没有起点**。
所以默认 `mainTab='accounts'`，而不是让用户面对六个并列项自己挑。

## 三、跨模块跳转是**字符串协议**：两处必须同一份清单

`switchModule('shop-accounts', <action>)` 的 action 落到 `MasterDataView` 的
`KINDS.some(k => k.id === id)`。写错不报错（TS 帮不上忙，它是运行时字符串），表现为
**"跳过去停在上次那一项"** —— 用户看到的是"按钮没反应"，不是报错。

⇒ `tests/shopAccountsIntake.spec.ts` 钉两件事：左导航六项的 id 与跨模块 action **同一份清单**；
落地时必须校验 action 在 KINDS 里（否则任意字符串都能当选项 = 静默无变化）。

## 四、回程竞态：`activateCore` 的早退守卫会让"切回"静默失效

**现象**：`order-profit:ui` 在 `cost-rates` 步点「去维护」跳走、紧接着派发 `switch-module` 想切回
`order-cost`，后续 `empty-state` 步超时。调试副本 dump 的现场：

```
DEBUG navs=[{"moduleId":"shop-accounts","action":"cost"},{"moduleId":"order-cost"}]
DEBUG activeModuleHint=店铺账号← 人还停在「基础数据」
DEBUG hasOcView=false / refreshBtn=missing
```

**根因**：`pm.activate()` 是异步的，`activeId` 在最后才更新。在途激活未完成时
`activateCore('order-cost')` 命中 `src/core/AppShell.vue` 的早退守卫
`if (id === activeId.value && activeView.value) return;`（此时 `activeId` 仍是 `order-cost`）
⇒ **静默返回，哪都没去**；随后 shop-accounts 激活完成、消费掉 action marker。

**修法**（冒烟侧）：切回前先等目标模块真的落地 —— `.md-view` 在场 **且** `[data-act="kind-cost"]`
带 `is-active`（顺带确保 marker 已被消费），再派发切回事件。
⭐ **只等 `.oc-view` 会被骗绿**：早退命中时旧视图还没被卸掉，`.oc-view` 一直在。
所以回程判据必须**双向**：`.oc-view` 在 **且** `.md-view` 不在。

## 五、只读化 + 写入口唯一；反向守卫 = 录入控件整批消失 **且** 0 次 upsert

「算钱」页汇率区改只读展示（`rate-value-USD`），区头「去维护」跳转基础数据。
守卫钉两件事，缺一不可：

- 录入控件**整批**没有：`rate-input-USD` / `rate-save-USD` / `rate-add` / `rate-new-cur` /
  `rate-new-value` 五个选择器全无，且 `.cr__table--rates input` 计数为 0；
- 本页**一次写入都没发过**：`calls('aeRateUpsert').length === 0`
  （只断言"没有控件"不够 —— 控件可以藏起来而写入照发）。

写入闭环（改既有 / 新增币种 / 币种码归一）随录入一起搬去 `master-data:ui` 的 `rates` 步。

## 六、文档要跟着搬家走

`verify:docs` 抓到三处**搬家后没跟着走的引用**：`CostPane.vue`、`SupplierView.vue`
（goods → shop-accounts）、`ShopAccountsView.vue`（改名 `MasterDataView.vue`）。

`docs/baseline/PROJECT_BASELINE.md` 的「最大的 10 个文件」表也停在搬家前，且榜首以下名次全变
（`order-db.ts` 1,796 → 2,269）—— 按该文件自己的复现命令重数，并就地标注刷新日期与原因。
**计数表一旦漂移就不再是权威**，而本项目多处判断（单模块体量、技术债）都引它。

## 七、本轮复发的四个老坑（都不是新坑）

1. ⭐⭐ **扫描型守卫的固定 I/O**：`shopAccountsIntake` 的两次全量扫描写在 `it` 里，
   随模块涨到 26 文件顶穿 vitest 5s 默认超时 —— 报出来是 `Test timed out`，看着像守卫失败。
   正是 `2026-10-03-fixed-cost-outside-timed-test.md` 记过的坑；按该笔记把扫描提到模块作用域 +
   记忆化文件读取，用例 5.3s → 208ms。
2. ⭐⭐⭐ **残留模态看不见**：导入那一步打开「导入产品」弹层后**整段没关**，而后续 step 的
   `.click()` **绕过命中测试**，于是一路"绿"，直到可达性断言（走 `elementFromPoint`）才红 ——
   红的是可达性，看着却像布局坏了。判据：`covered-by` 栈里有没有 `wb-mask` / `wb-dialog`。
   该弹层的 ✕ 与「完成」原先**没有 `data-act`** ⇒ 冒烟根本没法按锚点关它，补 `import-close` /
   `import-done` 两个锚点后才关得掉。
3. ⭐ **helper 返回类型要看清**：`mapFlat` 返回 **join 过的字符串**，按数组写
   （`tabNames.length === 1 && tabNames[0] === …`）在字符串上恒假 ——
   而 detail 打印出来正是那一个页签名，**看着"数据没问题"，实际这条永远红**。
4. ⚠️ **注入脚本模板串**：`node --check` 对这类脚本**不充分** —— 注释里的反引号提前闭合模板后，
   若剩余文本恰好仍语法合法就能放过去（实测：`.click is not a function` 报到运行期才暴露）。
   判据只能是实跑。