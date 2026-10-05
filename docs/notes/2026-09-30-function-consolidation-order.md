# 收编一个入口的顺序纪律：宿主加法先落地，岛减法再发版

**结论**：把功能从「市场岛」收编进「宿主内建页」时，**必须先在宿主把替代入口做出来并合并，再去删岛上的那个入口**。
顺序反了会出现一个**空窗期**：宿主还没有、岛上已经没了 —— 用户当场**没有地方**做那件事。

## 为什么这是硬约束（不是风格问题）

- 岛的改动**要经发布才生效**（改 `manifest.version` → `publish-plugin.js` → 用户本机安装 → **重启宿主**；见基线 §4 的三条共性），
  而宿主的改动**随下一次构建就到**。两者生效时点不同步，顺序就变成了正确性问题。
- 反例（本次差点踩到）：`ae-profit` 岛上第一无二的「汇率维护」（`ae_rates` upsert）。
  如果先删岛上的页签，而宿主「算钱」页还没接上汇率编辑 —— 外币订单从此**无处补汇率**，
  表现为"利润整单是空的、也找不到地方修"。
- 正确的做法（2026-09-30 实际执行）：`src/modules/order-cost/components/CostRatesSection.vue`（宿主，新增）
  先落地并被 `npm run order-profit:ui` 的 58 项断言守住，**然后**才删岛上的 `CostRatesPanel.vue` 等三个面板。

## 连带要一起改的东西（漏一个就红）

1. **`manifest.json` 能力声明必须双向对齐**：删了页面就删 op，别留着死声明。
   `tests/pluginTriage.spec.ts` 是**双向**守卫 —— 声明了不调用（"功能凭空消失"）、调用了没声明（运行期越权），**两条都会红**。
   同批还要动 `src/api.js`（适配层）与 `package.json` 的 `version`（有 spec 断言它与 `manifest.version` 相等）。
2. **岛名要跟着功能改名**：`displayName` 还写着旧职责就是"名字在撒谎"。
   `ae-profit` 从「利润追踪（UI 岛）」改为「订单采集（UI 岛）」（它只剩接收端状态）。
3. **`storage` 命名空间会跟着退场**：岛不再声明 `storage` 后，`modules.<id>` 里的旧数据没人读写 ——
   基线 §6 的命名空间表要同步标"已退场"（**不要**顺手去 `config.json` 里删，收益为零且有风险）。
4. **删掉的面板会让引用它的文档悬空**：`npm run verify:docs` 会报出来。审查/评审类文档里的引用属**历史取证**，
   走 `scripts/check-doc-links.mjs` 的 `DELIBERATELY_MISSING` 并写清"记录的是当时状态"；**不要**把校验器改瞎。

## 取证

- 宿主新面板：`src/modules/order-cost/components/CostRatesSection.vue`（默认收起；出现"缺成本"的行时自动摊开）。
- 岛瘦身：`ui-plugins/ae-profit/` 的 `src/` **9 文件 1,776 行 → 5 文件 466 行**；`manifest.json` 1.0.2 → 1.1.0。
- 冒烟：`npm run order-profit:ui` **52 → 58 项**（新增的 6 项正是"默认收起 / 缺成本时自动展开 / 成本表值 / 改汇率真的发出 upsert / 新增币种码归一大写"）。
- 计划与状态：`docs/plans/RESTRUCTURE_PLAN.md` 的 C9 行、`docs/baseline/PROJECT_BASELINE.md` §4 岛清单。

相关：[[2026-09-30-plugin-vs-host-boundary]]（什么该收编的判据）、[[2026-09-30-island-read-capability-pattern]]（收编后宿主页怎么复用纯函数）。