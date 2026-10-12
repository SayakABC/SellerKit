# 无忧物流运费（UI 岛 `shipping-rate`）

导入物流报价单 Excel，输入实际克重 → 算出到每个国家的实际运费。

- **形态**：手写 ESM、**无构建步骤**（`dist/` 即源码，`manifest.entry = ./dist/index.html`）
- **能力域**：`db` 域 `shipping-rate`（`parseRateSheet` / **`rateCurrent`** / **`rateAdopt`** / `quote` / `quoteOrders` / `quoteProducts`）；存储走自身命名空间 `modules.shipping-rate`（**只存界面状态，不存运价表** —— 见 §2）
- **规则源头**：`AGENTS.md` 红线 16–25；接入步骤见 `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md`
- **设计说明**：`docs/plans/SHIPPING_RATE_ISLAND_PLAN.md`
- **自动化**：`npm run shipping-rate:ui`（假桥无头冒烟，两个来回：冷启动空态 / 旧表迁移；含"计价 payload 里不许有 table"这条核心断言）

> **1.3.0 运价表回迁（M6，2026-09-30）**：运价表**归宿主** `sr_rate_snapshots`（按生效日留档，ADR-002 C3）。
> 本岛不再存表、也不再把它传回宿主计价 —— `quote` / `quoteOrders` / `quoteProducts` 的表参数已移除，
> 由宿主自取"当前那份"；岛改用 `rateCurrent` 取**只读副本**仅为渲染。升级后首启会把旧的岛内表
> **一次性迁移**（`rateAdopt`，宿主按内容 sha256 去重）并抹掉本地副本。「清空运价表」随之下线
> （历史快照是「算钱」按订单日期复算的依据，不该被一次抹掉；错表重导正确的那张即可）。

> **1.3.1 克重链收口（2026-10-10）**：克重是 **SKU 属性**（款 × 色 × 码），唯一来源 = 宿主产品库
> `pl_variants.weight_g`（在「货与成本」维护）。原先「导入商品信息 Excel → 商品ID 克重」那条链
> （`importProductWeights` / `productWeightStats` 两个 op + `pl_item_weights` 表）已**整条删除** ——
> 「按订单试算」改为按款色码取 SKU 克重，缺克重的原因文案同步改准（与商品ID 无关）。
> ⚠️ **时间线（别再踩"改完仓库 = 改完了"）**：宿主侧 2026-10-01 删链，本岛代码随后在仓库里也删净
> （`0dee5ff`，2026-10-05 —— 死导入按钮与旧页头文案都删了），但 **`manifest.json` 的版本号没升
> ⇒ 那批清理从未发布**：市场上与用户机器里一直是 10-01 那版 1.3.0（**按钮还在、点它调的是已删 op**）。
> **1.3.1 是第一次把"链已删"的岛真正发出去**的版本。

---

## 1. 数据流（为什么岛里没有 Excel 解析，也没有算术）

```
选文件（宿主对话框）
   └─ db.parseRateSheet(filePath, { sheetName?, prefer? })
        宿主：读字节 → xlsx 读工作簿 → **逐个 sheet 体检** → 自动挑出报价单所在的那张
              → src/lib/shipRate.ts#normalizeRateSheet → 运价表
        返回：{ sheetNames, sheetName, picked, table, candidates }
   └─ 宿主留档为快照；岛调 db.rateCurrent() 取回"当前那份"渲染（**岛内不存表**，1.3.0 起）

输入克重
   └─ db.quote(grams, { category, variant, rounding })
        宿主：src/lib/shipRateQuote.ts#quoteAll → 逐国运费
   └─ 岛只渲染返回值

按订单试算（1.1.0 起；1.3.1 起按款色码取 SKU 克重）
   └─ db.quoteOrders({ limit })
        宿主：order-shipping-rows（oi_orders 最小投影）→ src/lib/shipRateOrders.ts
              提取 收货国家 → 按款色码（`resolveWeightG`）联产品库 SKU 克重
              → 逐单计价（拒算逐单给原因 + reasonClass）
   └─ 岛只渲染返回值（订单原始行的大载荷到宿主为止，不过岛）

按产品试算（1.2.0 起）
   └─ db.quoteProducts(country, { limit })
        宿主：pl_products 分页拉全 + pl_variants 联 SKU 克重 → src/lib/shipRateProducts.ts
              目的国按点名解析一次 → 逐 SKU 计价（缺克重/无价/拒算逐行给原因 + reasonClass）
   └─ 重量锚点是**产品库 SKU 子表**（编辑产品时维护的克重）——与「按订单试算」读的是
      **同一份**克重（2026-10-01 前订单侧另有「商品ID 重量表」，那条链已删）
   └─ 岛只渲染返回值
```

两条硬约束决定了这个分工：

1. 岛运行在 iframe，文档 CSP 是 `script-src 'self'`（**无 `unsafe-eval`**），且没有构建步骤 ——
   既不能 `new Function`，也不该为读 Excel 打包一份 `xlsx`；
2. 档位边界、类别优先级、取整口径这三处**只要有两份实现就一定会漂移**，而它们直接影响金额。

因此岛的职责被压到最小：**收集参数 → 调宿主 op → 渲染返回值**。

### 1.1 选工作表：为什么不能"取第一张"

报价单**不是一张 sheet** —— 运营商给的是一本 **21 张工作表**的工作簿：第 1 张是「目录」，
其后 20 条线路各自一张，本岛要用的「无忧物流-标准」在**第 10 张**。
所以"没指定就取第一个"必然解析失败，而且报出来的是「不是报价单结构」——
看起来像数据有问题，真实原因是**读错了工作表**。

宿主改为**逐张体检 + 按语义排序**（`src/lib/shipRate.ts#pickRateSheet`）：

| 优先级 | 依据 | 为什么 |
| --- | --- | --- |
| ① | 名称与提示**完全相同** | `无忧物流-标准` 必须赢过 `无忧物流-标准-三方清关`（后者只有 1 国 5 卡） |
| ② | 名称**包含**提示，且名字越短越近 | 在"标准"与"标准-威海优选仓"之间选出前者 |
| ③ | 国家数多者优先 | 同一名字家族有多个时，宽表更可能是主表 |
| ④ | 价卡数多者优先 | —— |
| ⑤ | 工作簿顺序兜底 | 保证"同输入同结果"，否则用户会看到随机选表 |

国家数为 0 的 sheet 一律不参与排序，但**仍作为候选回报给岛**：自动挑错时用户能看到有哪些可选，
而不是被一句"结构无法识别"堵死。

两个参数语义**必须分清**：

- `sheetName` = **显式点名**（用户在「切换工作表」下拉里选的）→ 宿主严格按它解析，不存在就报错，**不静默改判**；
- `prefer` = **名称提示**（导入时传"上次那张"）→ 优先它，但认不出来时自动落到可用的表上 ——
  报价单换版后 sheet 改名/增删是常态，点名会把"换了个新文件"变成硬失败。

---

## 2. 配置键对照（命名空间 `modules.shipping-rate`）

| 键 | 类型 | 说明 |
| --- | --- | --- |
| ~~`table`~~ | — | **已退场（1.3.0 / M6）**：运价表归宿主 `sr_rate_snapshots`。岛内若还有这个键（老库），首启由 `syncTableFromHost()` 迁移上去后**显式写 `null` 抹掉** |
| ~~`source`~~ | — | 同上退场：来源改由宿主快照给出（`rateCurrent` 返回 `sourceFile` / `sheetName` / `effectiveFrom`），岛内不存 |
| `lastFile` | `{ filePath, fileName } \| null` | **上次打开过的**文件（不论解析成功与否）。导入失败后"手动指定工作表"必须针对刚打开的这个 → 见 `store.js#switchSheet` 的第二参数 |
| `sheetNames` | `string[]` | 该 Excel 内全部工作表名（换 sheet 下拉用） |
| `candidates` | `Array<{sheetName,countries,cards,sections,reason}>` | 上次体检结果（含不可用的，各带原因）。界面据此标出"可用 / 非报价单"，导入失败后还能一键改选 |
| `weight` | `number` | 上次输入的克重 |
| `category` | `'auto' \| 'general' \| 'special' \| 'bulk'` | 计费类别偏好 |
| `variant` | `string` | 仓库变体偏好（`''` = 不限） |
| `rounding` | `'round' \| 'ceil'` | 取整口径（四舍五入 / 向上进位到分） |

查询结果**不落盘**（随时可由运价表 + 克重复现）；**运价表本身也不落岛**（1.3.0 起真源在宿主快照表）。

---

## 3. 运价更新流程（Excel 数值变更时）

1. 「运价表」页 → **导入 / 更新运价表** → 选新的报价单文件；
2. 宿主自动挑出报价单所在的工作表（优先「无忧物流-标准」），**整表覆盖**（不是合并 ——
   合并会让已下架的国家留下一份"幽灵价"）；
3. 页面立刻报告自动选了哪张表、新旧国家数对比，并展示本次解析的告警（若有）；
4. 挑了别的线路也不怕：用「切换工作表」下拉，或（导入失败时）从候选按钮里直接指定。

换 sheet 不必重选文件（走已记住的路径）。

**导入失败会给出可读解释，不是一句"结构无法识别"**：界面上会列出已体检的工作表张数、
哪些可用（带国家数）、并可手动指定任意一张。

**源文件被移动/删除不影响已有报价** —— 数据已经落在配置里。只有"再次导入/换 sheet"才需要文件。

---

## 4. 计费口径

| 项 | 规则 |
| --- | --- |
| 类别自动判定 | ≤2000g 优先普货 → 无则非普货 → 再退大包 → 最后 `any`（该表不分品类）；>2000g 先大包再普货/非普货/`any` |
| 类别手动切换 | 强制某类时只用该类 **+ `any` 兜底**（燕文/4PX/超级经济这类单一价线路只有 `any` 卡）；都命中不到则明确提示"该重量段无可用运价"，不静默回落 |
| `perKg` 模式 | `配送服务费(元/KG) × 计费克重 ÷ 1000 + 挂号服务费(元/包)` |
| `firstStep` 模式 | `首重 + ⌈(计费克重 − 500) ÷ 500⌉ × 续重`；不超 500g 只收首重 |
| **计费克重** | `max(实际克重, 该价卡的最低计费重量)` —— 报价单有单列「最低计费重量 10g」/「起重 克」，不套用会少算 |
| **币种** | 只按人民币计价。表头写 `美元（USD）/KG` 的线路**明确拒算**并说明原因，不套人民币的壳 |
| 仓库变体 | 仅乌克兰的非普货分「其他仓 / 香港仓」；默认取无变体价卡 |
| 取整 | 默认四舍五入到分；可切「向上进位到分」 |

不在本岛范围内：体积重（长×宽×高/8000）、单边/合计尺寸的大包判定、燃油附加费 ——
这些是"包裹属性"而不是"运价数据"，本岛只按用户输入的**实际克重**计算。
汇率同理：本域没有汇率来源，所以非人民币线路**拒算**，而不是按一个硬编码数字换算。

### 4.1 表头版式是一族，不是一种

实测源工作簿 21 张 sheet，表头行数与**上下顺序**都不统一：

| 版式 | 表头行数 | 实例 | 备注 |
| --- | --- | --- | --- |
| 类别 / 档位 / 叶子 | 3 行 | 无忧物流-标准、特惠、优先、三方清关 | 唯一有"类别标题"的一族 |
| 档位 / 叶子（无类别） | 2 行 | 燕文航空挂号小包、超级经济全系列、顺友、威海优选仓 | 整表不分品类 → 类别记 `any` |
| 叶子 / 档位（**上下颠倒**） | 2 行 | 无忧物流-特货标准、特货标快 | 数据起点必须取"表头各行的最下一行之后" |
| 只有叶子 | 1 行 | 4PX新邮挂号小包、部分超级经济 | 限重写在叶子文本里（`*每1克计重，限重2KG`） |
| 分档行式宽表 | —— | 海运大件专线、超大件专线、优先/特货标准的部分分节 | **不支持**：同一目的地在一节里占多行，整节拒绝 |

所以行角色只能**探测**（`detectLayout`），不能写死 `hdr+1` / `hdr+2` ——
那正是「燕文航空挂号小包」报「表头结构无法识别，整节跳过」的原因：
数据完全正常，只是那张表只有 2 行表头。改版前 21 张 sheet 只有 3 张可用，改版后 **19 张可解析**。

---

## 5. 自检陷阱（都在本仓真实踩过，改代码前先读）

| 陷阱 | 症状 | 正确做法 |
| --- | --- | --- |
| **未指定工作表就取第一张** | 导入稳定失败并报「未找到任何「运达国家/地区」表头行」—— 用户以为**报价单有问题**，实际是**读错了工作表**（第 1 张是「目录」，目标表在第 10 张） | 逐张体检后按语义排序挑（`pickRateSheet`）；由 `tests/shipRate.spec.ts` §⑤ 与 `tests/pluginTriage.spec.ts` 钉住 |
| **夹具只复刻单元格、不复刻 sheet 顺序** | 上面那条错误写法在测试里**恒绿**：夹具把报价单放在了第一张 | 夹具必须保留源工作簿的 sheet 顺序（首张非报价单 + 一张能解析但位置更靠前的中途表，否则"只取第一张能解析的"也能蒙对）—— 见 `tests/fixtures/generate-fixtures.mjs` 的 ⚠️⚠️ |
| **表头行数写死 3 行**（`hdr/hdr+1/hdr+2`） | 所有 1~2 行表头的线路报「表头结构无法识别，整节跳过」—— 文案指向"数据有问题"，真实原因是版式族没覆盖（燕文 5 国、超级经济 36 国×2 档等 **16 张 sheet** 全因此不可用） | `detectLayout` 按**角色命中数**探测三行角色；叶子/档位的上下顺序不假设 |
| **叶子同义词只认「挂号服务费」** | 燕文 / 超级经济 / 顺友 6 张表写的是「**Item 服务费**」→ 该列整列丢失、`registerFee` 落到 0，界面照常出数、金额偏小（最难发现的一类错） | `leafKind` 收同义词表：`挂号服务费` / `Item 服务费` / `操作处理费` / `处理费`；由夹具里「燕文航空挂号小包」那张钉住 |
| **「最低计费重量」列被当成叶子命中** | 该列常与档位**同处表头行** → 表头行被当成叶子行 → 真正的档位行被排除 → 整节档位退化成 `[0, 30000]`（选错档 = 用错费率，且无任何提示） | 探测时 `leafKind(k) !== 'minCharge'` 才算叶子命中；建卡时它也不参与，只记列号供**逐行**取值 |
| **「最低计费重量」列只在叶子行找** | 燕文/威海优选仓那张它落在**表头行**，中邮e邮宝与叶子同行 → 前者 `minChargeG` 恒为 0 | 在 `[leafRow, zoneRow, catRow]` 三个角色行里都找 |
| **档位文本里两个相同数字当成区间** | `2KG以内（包含2KG）` → `[2g, 2g]`：一张只覆盖 2 克的价卡，界面看不出异常，只是所有 >2g 查询都报"无可用运价" | 两数相同时 `{ minG: null, maxG: b }`（只说上限）；单位按**整段文本**判 kg/g，不能只看数字 |
| **整组限重盖过本列档位** | 摩洛哥大包两档（`0-5000g` 按 KG / `5000-30000g` 首重续重），组标题写着「大包计费 限重30kg」→ 按 KG 那张卡扩张到 0~30kg，把首重续重档整段吃掉 | `maxG = zone?.maxG ?? limitG ?? BULK_MAX_G`（本列档位优先） |
| **行式分档表被"结构扫描"识别成功** | 单元格里是"该档**总价**"却被当成"每 KG 费率"→ 算出来大两个数量级且不报错（无声错价） | 判据：**同一目的地在一节内占多行** → 整节拒绝并给出明确文案。宁可拒绝，不可产出量纲错的价 |
| **非人民币价卡按人民币算** | `超级经济` / `无忧物流-特惠` 表头写的是 `美元（USD）/KG` → 金额差 7 倍，且金额看起来完全正常 | 归一化时记 `currency`；`quoteAll` 对非 CNY **拒算**并说明"未接汇率"（界面分「该克重无价」与「未接汇率」两枚 chip） |
| **被拒绝的节把建卡告警漏进总表** | 界面显示"分节 3：挂号费按 0 计"，而那一节根本没被采纳 → 用户去查一个不存在的节 | 本节告警先收进 `secWarnings`，**整节被采纳时才并入**总表 |
| `__sk.ready` 被当成布尔值 | `if (sk.ready) return true` 恒真 → 握手前就发调用 → 全部失败、页面无声停在"未连接" | 真 `await` + 超时兜底（见 `dist/bridge.js#ready`） |
| 挂载点被复用 | 每次重绘都对同一个 root 再挂一次点击代理 → 同一次点击回调 N 次（重复发 IPC） | `app.js#draw` 每次新建 `.view-holder`，旧容器随 `replaceChildren` 回收 |
| 输入框走整体重绘 | 克重/筛选框"打字打不进去"（每次按键重建 DOM，光标与输入法组合态丢失） | 输入类事件只 `renderRegion(root, '#results', …)` 局部重绘 |
| 元素级 `color-scheme: light` | 深色主题下下拉弹层/滚动条/日期面板仍发白，文字却正常 | 只用 `var(--wb-*)`；`color-scheme` 只在 `:root` 写 `light dark`，元素级写 `inherit` |
| `[data-theme='dark']` 选择器 | 死代码：宿主只注入内联令牌，**不同步 `data-theme` 属性**到 iframe | 同上 |
| 点击目标属性不是 `data-act` | 按钮点了没反应且不报错（`closest('[data-act]')` 匹配不到直接 return） | 统一用 `data-act`；或用 `onClick(root, h, '你的选择器')` |
| 视图里用了未定义的类名 | 新加的提示条（如 `.notice`）在 `styles.css` 里不存在 → 渲染成无样式裸文本，不报错 | 加新 `class` 必须同步补 `dist/styles.css`（本仓已踩：`dist/views/quote.js` 的 `currencyNotice()`） |
| `dist/` 被 `.gitignore` 吞掉 | 本地能跑、门禁能过，但 `git ls-files` 里没源码，一次 `git clean -fdx` 即永久丢失 | `.gitignore` 必须有 `!ui-plugins/shipping-rate/dist/`（由 `tests/pluginTriage.spec.ts` 钉住） |
| 同版本重装 | 市场安装失败（zip 的 sha256 与 catalog 不符） | 改内容必须升 `manifest.json` 的 `version`（本岛无 `package.json`，只改 manifest） |
| ~~重量单位只看数字不看列名~~ / ~~商品信息表"取第一张 sheet"~~ | （**删除记录，不是活引用**）这两条坑位属「导入商品信息 Excel → 商品ID 克重」链（`src/lib/productWeight.ts#parseWeightSheet` + `pl_item_weights`）——该链与解析器已于 2026-10-01 随领域裁定（克重只属于 SKU）**整条删除**，仅存档于 git 历史与 `docs/plans/SHIPPING_RATE_ISLAND_PLAN.md` §8 | — |
| **订单「数量」列直接当件数** | 多产品订单拆行后每行仍带原始数量值 → 3 件拆 3 行每行按 3 件算 = 9 倍重量 | 恒按 **1 件/行** 计（`extractShipping` 注释）；数量 >1 的合并计费留待 UI 明确选择后再做 |
| **国名解析别名乱加** | 错误别名把 A 国订单算成 B 国运费且无告警 | 别名值以**运价表实际写法**为准（Korea / Russian Federation / United States）；加别名前先查表，变异测试钉住 alias / 前缀包含两条独立路径 |
| **拒算分类只断言汇总计数** | 对称交换两个计数器（noCountry ↔ unknownCountry）汇总不变、用例照绿 | 分类必须**逐行可观测**：`OrderQuoteRow.reasonClass` 与行绑定，断言钉在行上（变异测试 §④⑤ 现形后补的） |

### 5.1 改解析逻辑后怎么确认守卫不是假的

50 条用例全绿**不等于**断言有效 —— 有可能某条断言在"实现改坏"时照样绿。做法是把实现逐条改坏、确认对应的那条用例真的变红（变异测试，10 条变异点全部覆盖上表加粗行）：

```bash
node /tmp/srbench/mutate.mjs      # 逐条变异 → 跑对应用例 → 还原；输出应全为 ✅
```

⚠️ 判据必须**先剥掉 ANSI 颜色序列**再匹配 `Tests\s+(\d+) failed`：vitest 的彩色输出里
`Tests\u001b[22m \u001b[1m\u001b[31m1 failed` 中间夹着转义码，直接匹配会**永远匹配不到**，
于是 10 条变异全部被误报成"仍然是绿的 —— 这条断言是假守卫"。**判据写错会把好测试冤枉成假守卫**，
排查方向完全反过来（本仓踩过一次）。

---

## 6. 改完代码怎么生效

本岛**无构建步骤**，所以"改源码"就是"改产物"：

```bash
# 语法自检（dist/ 即源码，逐个过一遍 parser）
for f in dist/*.js dist/views/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done

# 本地生效：重建运行时目录（只含 manifest.json + dist/**，即市场分发形态）
P="$HOME/Library/Application Support/seller-kit/plugins/shipping-rate"
rm -rf "$P" && mkdir -p "$P" && cp manifest.json "$P/" && cp -R dist "$P/"
```

⚠️ **只重装插件不重启宿主不生效**（岛的 HTML/JS 是安装时落到 `<userData>/plugins/` 的）。

回归门禁：

```bash
npx vitest run                    # 含 tests/shipRate.spec.ts 与 tests/pluginTriage.spec.ts
npm run verify:docs               # 文档交叉引用
npm run plugins:island:smoke      # 真机逐岛点击 + 握手断言（需先 npm run dev）
```

---

## 7. 发布

### 7.1 发到本地市场（开发/自用；宿主市场地址填 `http://127.0.0.1:8000/catalog.json`）

```bash
# ① 语法自检（见 §6；dist 即源码，语法错会直接让岛空白）
for f in dist/*.js dist/views/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done

# ② 打包 + upsert 进 catalog（zip 只含 manifest.json + dist/**，大小约 24KB）
node scripts/publish-plugin.js --dir ui-plugins/shipping-rate \
  --base http://127.0.0.1:8000 --out market-out --catalog market-out/catalog.json

# ③ 起本地市场静态服务（另开一个终端，保持运行）
npm run market:serve          # = node scripts/serve-market.mjs，默认 market-out + 127.0.0.1:8000
# ⚠️ 不要用 `python3 -m http.server`：它只发 Last-Modified、不发 Cache-Control，
#    宿主会按 Chromium 启发式规则把旧 catalog 当新鲜（见 §7.3）

# ④ 核对产物与目录条目 sha256 一致
unzip -l market-out/shipping-rate-<版本>.zip          # 应只有 manifest.json + dist/**
shasum -a 256 market-out/shipping-rate-<版本>.zip     # 与 catalog.json 里的 sha256 逐位一致
```

当前线上：`shipping-rate-1.3.0.zip`（**含旧「商品ID 克重」链**，2026-10-01 00:04 推送）；工作区已备好
**1.3.1**（克重链收口，见文首 1.3.1 blockquote）**待发布** —— 同版本换内容会被 `publish-plugin.js` 硬拦（exit 1），
故必须升版本号。
历次版本都是**原地替换**（catalog 是 upsert 语义），`market-out/` 里仅最新一条有引用，旧 zip 可删。

⚠️ **改完内容要两条都走**：① 升 `manifest.json` 的 `version`；② 重跑上面的 `publish-plugin.js`。
只改仓库不重新打包 → 「插件中心 → 市场」装到的还是旧行为；只打包不重建运行时目录 →
本地已装的岛也还是旧的（见 §6 的重建命令，两条都已在本轮做过）。
另：`manifest.json` 的 `description` 会原样显示在市场卡片上 —— **不要写 markdown**（`**粗体**` 会字面显示）。

**发布前必须升 `manifest.json` 的 `version`**，否则同版本 zip 的 sha256 与 catalog 对不上、安装直接失败（宿主 `plugins-market-install` 会强制校验 sha256 与 manifest 版本三项一致性）。
`catalog.json` 是 upsert 语义（无删除路径），下架要手工改条目并推送 `market-out` 远端仓（该目录本身是一个独立 git 仓，`origin = SayakABC/SellerKitPlugin`）。

### 7.2 发到 GitHub 市场（对外分发）

```bash
node scripts/publish-plugin.js --dir ui-plugins/shipping-rate \
  --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main
cd market-out && git add shipping-rate-<版本>.zip catalog.json && git commit -m "feat(shipping-rate): 上架无忧物流运费 UI 岛 v<版本>" && git push
```

⚠️ `--base` 决定 catalog 里的 `downloadUrl`，**换 `--base` 就会改写该条目**；本地自用与对外分发两条线的 URL 不能混着发（混发会让另一端的用户下载 404）。

### 7.3 「已发布，但宿主「插件中心 → 市场」里看不到新插件」怎么查

按顺序排，**前三步全绿也照样可能看不到**，第 ④ 步才是真正的坑：

| # | 检查 | 命令 / 做法 |
|---|---|---|
| ① | 磁盘上 catalog 有条目吗 | `python3 -c "import json;print([p['id'] for p in json.load(open('market-out/catalog.json'))['plugins']])"` |
| ② | HTTP 真能取到吗 | 浏览器开 `http://127.0.0.1:8000/catalog.json`（**别信页面缓存，用无痕窗或 Cmd+Shift+R**） |
| ③ | 宿主扫到插件了吗 | 插件中心「已安装插件」页；或宿主控制台 `await electronAPI.pluginsScan()`（⚠️ 返回是 `{success, data:{plugins}}` 信封，直接读 `res.plugins` 会得到"全空"的假红） |
| ④ | **宿主是否吃了 HTTP 缓存** | 宿主 `downloadFile` 走 Electron `net`（Chromium 栈）。服务端只发 `Last-Modified` 时，会按 `freshness = (Date − Last-Modified) × 10%` 缓存 —— catalog 隔两天没动，新鲜期就是 5 小时量级，期间刷新市场**连请求都不发** |

④ 的判定法（一步到位，不需要猜）：**用隔离 userData 起宿主能立刻看到、用你真实 userData 起宿主看不到** → 就是缓存。

**两个修法，都要**：

- 服务端：用 `npm run market:serve`（发 `Cache-Control: no-store`，不发 `Last-Modified`/`ETag`）替换 `python3 -m http.server`。
- 请求端：`electron/http-client.ts` 的 `downloadFile(url, dest, { noCache: true })`（<kbd>v1.1.0</kbd> 起市场侧两处调用点已默认传），带 `Cache-Control: no-cache` 强制回源验证。**改的是主进程，必须重启宿主才生效。**

> 只换服务端、不重启宿主：**已经存下来的旧缓存条目仍按原来的新鲜期有效**，要等它过期或清缓存 —— 所以"改了没生效"是正常的，别误判成修复失败。
> 守卫：`tests/marketCache.spec.ts`（撤掉任一修复即变红）。
