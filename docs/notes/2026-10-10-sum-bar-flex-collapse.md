# 吸底汇总条被压成 2px —— 「复制给厂家 / 生成拿货单只对某几个厂家出现」的真因（2026-10-10）

**结论先行**：用户报「选『全部』『集雨』时没有『复制给厂家』和『生成拿货单』，选『欢喜』『大众』就出现，
这出现的逻辑是什么？」——**按钮的显隐与页签毫无关系**。真因是**弹性塌陷**：
`.pk-sum`（吸底汇总条）是 `.pk-view` 的弹性子项，而根节点 `.wb-page` 是 `height: 100%` 的**定高弹性列**
⇒ 内容一溢出，默认 `flex-shrink: 1` 就先把汇总条压扁；汇总条自己又带 `overflow: hidden`（为圆角），
它本该保底的自动最小尺寸（`min-height: auto`）被这行**归零** ⇒ 一路压到 **2px**，
行与按钮被**它自己裁掉**（元素仍在 DOM 里、`getBoundingClientRect` 也还回矩形，但只剩 2px 高，
`elementFromPoint` 命中的是下面的卡片）。
「页签能决定按钮有无」是假象：**页签只改卡片数量 ⇒ 改内容总高 ⇒ 改塌陷程度**。
实测（真机、克隆库）：全部 6 款色 / 集雨 4 → **2px 全塌**；欢喜 / 大众各 1 款色 → 95px / 71px（压得浅、按钮露出来）。

## 按钮的渲染逻辑（代码事实，与页签无关）

- 「复制给厂家」= `v-if="sec.sg.supplierId && sec.pending.pieces > 0"`（`PickingView.vue:295`）
  ——**逐厂家**：这家厂有 ID 且有待拿件数就有按钮。
- 「生成拿货单」= 同上**再加** `supplierAction`（`PickingView.vue:306`）——只有宿主「今天 › 拿货」
  嵌入形态传 `true`；独立「拣货」模块页不给（那是宿主页的动作）。
- `.pk-sum` 遍历**全部** `sections` 逐厂家出一行（它是总账）；页签 `supplierFilter` **只过滤卡片网格**，
  不碰汇总条 ⇒ 三个页签下汇总条内容**一样**，变的只是被压成几像素。

## 修法与守卫

- **修**：`.pk-sum` 加 `flex-shrink: 0`（`PickingView.vue` 附"不许删"的 why-comment）——
  修复语义：条子不许缩，内容装不下就溢出 `.pk-view` 去滚（那才是本来的设计），
  `sticky` 负责把**完整的**条子钉在滚动口底边。
- **守卫升级（原断言是空的）**：两条冒烟里原来只断言 `position === 'sticky'` —— 声明式断言，
  塌成 2px 照样绿。换成 **几何 + 可达性** 三条（`pkSumGuard`，`picking-ui-smoke.mjs` / `today-ui-smoke.mjs` 各一份）：
  ① `clientHeight + 1 >= scrollHeight`（没被压扁）② 矩形底边在视口内、顶边没越过上沿 ③ 每个必需按钮的
  **中心 `elementFromPoint` 命中它自己或后代**。
- **红证纪律**：先加守卫跑红（`条 h=2（client 0 / scroll 139）… pk-copy→点到 pk-card__head`）
  → 再应用修复 → 绿。断言条数 **1:1 替换**（`today:ui` 172、`picking:ui` 84 不变；`picking:ui` 里
  "独立页不给生成拿货单"那条共存，两条各自钉一件事）。

## 同日次级发现：ToastHost 吞点击

修完塌陷后 `today:ui` 仍红，命中元素是 **ToastHost 的常驻容器**
（`fixed bottom-4 right-4 z-[60] flex flex-col gap-2`）。它为 `aria-live` **常驻**（即便没有 toast 也在），
⇒ 自身的盒子（含两条 toast 之间的 `gap-2` 空隙）静止地挡在右下角、吞掉点击。
真实场景：点「复制给厂家」→ 成功 toast 弹出，恰好盖在同时位于右下角的「生成拿货单」上
⇒ 下一次点击被挡约 3 秒（用户感知是"按钮点了没反应"）。
**修**：容器加 `pointer-events: none`（继承 ⇒ 整条提示链穿透；toast 是纯信息、没有可点元素，穿透无害）。

## 真机取证（可复跑）

- `cp -cR` 克隆真实 userData + `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox
  --disable-gpu --remote-debugging-port=9222 --user-data-dir=<克隆>`，Node 内置 WebSocket 直驱 CDP 量几何。
- 克隆库里 9 条订单全是 2026-08-25（超过默认 30 天窗）⇒ 默认窗口下面板合法为空；
  经「更多 › 天数窗」扩大后复现用户场景（全部 6 / 集雨 4 / 欢喜 1 / 大众 1）。
- 修复前：全部 / 集雨 `h=2`（按钮 `elementFromPoint` 命中卡片）；欢喜 `h=95`、大众 `h=71`（按钮部分露出）。
- 修复后：四页签一律 `h=163`，6 个按钮全部 `hit=self inView=true`（截图目视确认完整汇总条：
  行 + 按钮 + 「待拿 6 款色 · 9 件 · 预估 ¥152.00」）。

## 教训

1. **声明式断言 ≠ 可达性断言**：`position: sticky`、`v-if` 求值为真、`display: flex` —— 都只说明"写了"，
   不说明"看得见、点得到"。凡"按钮在不在眼前"的断言，判据必须是**几何 + `elementFromPoint` 命中**。
2. **常驻覆盖层必须 `pointer-events: none`**：为 aria-live 常驻的 toast 容器是标准案例——
   它自身的盒子（含间隙）与胶囊都会静止地挡在右下角，且只在"恰好点同一个角落"时咬人。
3. **定高弹性列里的子项默认会被压扁**：`height: 100%` 的 flex 列 + 内容溢出 = 压最软的那个；
   若该子项还带 `overflow: hidden`，它会**先被压到接近 0 再被自己裁掉**，看起来像"这个模块没渲染"。
   凡是"必须完整可见"的条/栏，都要显式 `flex-shrink: 0`。
