# 记账导入：自动建人/科目 + 退店参与分摊 —— 五条判定

2026-10-26。用户口径：「导入记账明细时，如果不存在的科目、相关人，需要自动新建。店铺状态为退店的时候也可以参与均摊」。

## 结论

1. **"要不要自动新建"是两条路各一份口径，故意的**：「记一笔」永远给 id、名字找不到就报错（逐笔手填，
   打错字必须拦）；Excel 导入给名字、库里没有就建（用户拿现成账单来对账，名字本来就在表里）。
   分叉落在类型上 —— `LedgerImportEntryInput`（带 `partyName` / `categoryName`）与 `LedgerEntryInput` 分开，
   「记一笔」那条路**拿不到**这两个字段。
2. **新建必须在落库的同一个事务里，不能在预览阶段建**：预览是"看看会怎样"，此时建就是把
   "用户点了取消"变成"库里多三个假房东"。`batchCreateEntries` 内按 `toNameKey` 先找后建，
   第 N 行失败整批回滚，**新建的人一起退回**。
3. **新建的东西必须念出来**：主进程回 `createdParties` / `createdCategories`，预览逐行标「将新建」、
   汇总条给个数、导入成功的 toast 列名字、父层跟着刷主数据缓存。理由：自动新建唯一的真实风险是
   "打错一个字凭空多一个假房东，之后所有钱都累计到假名字上"，只有让它显形才有意义。
4. **指纹要带待新建的名字**：id 都是 0 时用名字占位，否则"同一天同一笔钱给张三 / 给李四"会判成同一笔
   （把真账标成重复、默认不勾 —— 比不查重更坏）。
5. **退店是标记，不是"不算了"**：可摊状态 `active | exited`；`archived`（停用）/ `banned`（封店）仍排除。
   退店排除的失效方式是静默的：钱只摊到剩下几家，**合计依然等于金额**，守恒断言抓不到。

## 取证

- 口径唯一：`electron/ledger-db.ts` 的 `resolveOrCreatePartyByName` / `resolveOrCreateCategoryByName`
  都只认 `toNameKey`（与 `upsertParty` / `upsertCategory` 去重同一个键）；创建走既有 upsert，不新写 INSERT。
- 事务边界：`batchCreateEntries` 的 `dbTransaction` 包住"建名字 + 写条目"（better-sqlite3 的嵌套事务走 savepoint）。
- 可摊判定：`electron/ledger-db.ts` `eligibleShops`（`status !== 'active' && status !== 'exited'` ⇒ 排除）；
  `resolveImportNames` 的店铺查询把 `exited` 折成 `ok`、`archived|banned` 折成 `archived`，并把原始 `status` 一并返回给文案层。
- 假桥同口径：`scripts/ledger-ui-smoke.mjs` 的 `eligible()` 同步放宽；只改主进程不改假桥，夹具里退店的店会恒绿。
- 门禁与冒烟（全部实跑过）：
  - `npx vitest run` → 50 文件 / **1045 例**全绿（含 `tests/ledgerImport.spec.ts` 67 例：④ 组重写为"缺失→待建"、新增 ④b 指纹 3 例）；
  - `npm run ledger:smoke` → **51 项**（新增 `[12]` 组 5 项：自动建名 / 同名只建一个 / 整批回滚带走新建 /
    停用名报错带行号 / 退店能摊）；
  - `npm run ipc:shape:smoke` → 58 项全绿（新增 `⑫` 组 5 项）。**这一组是必须的**：`preload.ts` 的
    `sanitizeLedgerImportEntries` 是**字段白名单**，直接调 `batchCreateEntries` 的 DB 冒烟看不见它 ——
    变异验证：把 preload 里 `partyName` / `categoryName` 两行注释掉，这 5 项当场全红（报「第 1 行：没有资金相关人」）；
  - `npm run ledger:ui` → ALL PASS（新增 `exited-shop` 步 2 条：退店的店真在勾选区、真拿到 1/3 分摊）。
- 顺带修的悬空名：文案里的「基础数据 › 店铺登记」自 2026-10-22 物理合并后已不存在（实体增改在「店铺」，
  「店名归一」只管历史文本），改成「基础数据 › 店铺」；`tests/uxEntryNames.spec.ts` 新豁免
  「相关人 / 科目」（「记账」页头按钮 `data-act="open-parties"` / `open-categories`，由 `ledger:ui` 点得开）。
- 注入脚本的老坑又踩一次：假桥那段是**模板字符串**，注释里写 `eligibleShops` 用的反引号直接截断整段
  （`node --check` 报的是注释下一行的 `Unexpected identifier`）。改假桥时先跑 `node --check`。

## 追加：金额超两位小数自动取整（同日，用户口径「解析的金额自动保留小数点后两位」）

原设计是"超过两位小数**整行报错**"（`金额只到分（最多两位小数）`）。实测代价：一份三级精度的平台
结算表 / 换算过汇率的分摊表，整批一行都导不进来。改成**自动四舍五入到分 + 逐行念出来**。

1. **两条路先归一成字符串，再做同一段算术**：数字格 `(v).toFixed(6)` 去尾零、文本格 `trim()`。
   不归一就会出现"Excel 里 1200.505 进成 1200.50、手打成文本却进 1200.51"——同一份文件两种结果，
   而且没有人会想到去比对。
2. **两位以内仍交给 `parseYuanToCents`**（与「记一笔」同一份实现）。取整分支只负责"多余的小数位"，
   不重写正常路径；用例里逐个数比对两条路的结论恒等（`for (const s of [...]) expect(import).toBe(strict)`）。
3. **只看十进制第三位、半进一，不碰浮点**：`1.005 * 100 === 100.49999999999999`，用 `Math.round(v*100)`
   会把 1.005 舍成 1.00 —— 这与"用户以为四舍五入"正好相反，且只在很窄的输入上出现（最难发现的那种）。
4. **取整必须念出来**：回一句 `rounded`，进该行 warn、状态列标「金额取整」、汇总条计数。
   允许"金额和文件里不一样"，不允许"不一样还没人说"。
5. **不拦行**：`ok`/默认勾选照旧（旧行为是整行 error）。
6. **两种 0 分开说**：`0` → 「金额必须大于 0」（`assertAmountCents` 原话）；`0.004` → 「保留两位小数后是
   0.00：导入只记到分」。合成一句"金额必填"会让人回去检查单元格是不是空的。

顺带修上一版遗留的**文案自相矛盾**：相关人/科目的列提示还写着「导入不会新建」，与已上线的自动新建相反；
`tests/ledgerImport.spec.ts` 里那条断言「不会新建」的用例正是靠这句错话才绿 —— 用例钉住了旧行为时，
改行为要连用例一起改，否则"全绿"本身就是假证据。

变异验证：把 `Number(rest[0]) >= 5` 改成 `> 5`，取整那组当场变红（69 passed / 1 failed）。

## 追加：整批导入报 `An object could not be cloned.`（同一个功能，真机验收才发现）

用户点「导入」→「导入失败，一笔都没进：An object could not be cloned.」。**根因不是数据、不是 SQL，
是载荷里有 Vue 的 reactive 代理**：`ipcRenderer.invoke` 走结构化克隆，Proxy 一律克隆不了，
主进程一个字节都没收到 —— 所以既没有行号，也没有业务文案。

1. **浅拷贝不算**：`{ ...r.input }` 只换最外层，`allocations` 与它的元素仍是代理。而且失效面随文件内容变：
   只导专属行时 `input.allocations` 是 `undefined`，碰巧能过；**一旦有公共支出就整批炸**。
   这种"看文件内容决定成不成"的故障最难查，也最容易在自测里漏掉（自己试的那份文件正好都是专属行）。
2. **过 IPC 的对象必须现造**：`toCloneable` 深拷贝（对象/数组/标量，Date 单独处理）。
   **不做字段白名单** —— 白名单在 preload 的 `sanitizeLedgerImportEntries` 里已有一份，
   渲染层再抄一份就是等着"新加字段两边不同步 → 静默丢掉"（本仓库吃过三次）。
3. **为什么单元测试全绿还是炸**：`buildLedgerImportPayload` 单测里吃的是普通数组，不是 `ref` 里的数组。
   修法是让用例复刻真实状态：`vueRef(runOnce(...).results)` 再 `structuredClone` —— 直接调纯函数永远绿。
4. **为什么 UI 冒烟也没拦住**：`ledger:ui` 从来不覆盖导入弹层（此前已记为残留缺口），这次正好落在盲区。
   现在补上了：Node 侧用 `xlsx` 生成**真 xlsx**（喂假 grid 会绕开 `XLSX.read` 那段），
   假桥的 `ledgerEntryBatchCreate` 桩**照真机先做一次 `structuredClone`**，混进代理就当场红。
   夹具刻意三行各带一个失效点：金额超两位（取整）/ 公共「全部」/ 名字库里没有（自动新建）。
5. **夹具踩到的坑**：一开始用「房东陈」当相关人，结果前序步骤把它停用了 —— 导入两行报「已停用」。
   冒烟是**有状态的长流程**，夹具取的名字必须确认在该步骤时点仍然可用（或自己造一个）。

变异验证：把 `toCloneable(r.input)` 退回 `{ ...r.input }` → 单测 ⑪ 组变红、`ledger:ui` 导入步变红（`SMOKE: FAILED`）。
