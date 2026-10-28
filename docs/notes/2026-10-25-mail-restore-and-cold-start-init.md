# 邮件「设置没了」的两条根因：级联删除 + 冷启动没人初始化

> 来处：2026-10-25 用户报「当前项目中邮件功能不可用了，原来店铺中的邮箱设置也没有了，请修复」。
> 结论先行：**数据是被级联删除带走的**（可从合并前备份按邮箱恢复），**界面是冷启动没初始化**
> （每行恒显示「未接入」、抽屉空表单），两件事叠在一起才让人以为"功能坏了 + 设置丢了"。

## 结论

1. **邮件账号挂在店铺行上，删行 = 删账号 + 全部缓存邮件**（ADR-003 的既定行为）。
   2026-10-22 物理合并会把"只有账号、没挂店铺"的 `sk_shop_sets` 行插成新的 `sk_shops` 行；
   这些行与用户后来补齐的店铺行是**同一家店的两行**，最容易被当成重复行删掉 ——
   而 `ON DELETE CASCADE` 会静默带走邮件账号、邮件正文与文件夹游标。
   删除确认框只在 `hasMailAccount` 时写明级联范围（该字段取自真库、与界面初始化无关），
   所以"没看到邮件相关提示"不能当作"这行没有邮件"。
2. **谁读这个状态，谁就得负责初始化**。此前注释写着「这里 ensureReady 由 MailAccessDrawer 负责」，
   但抽屉从来没调过 —— 冷启动直接落「基础数据」时邮件 store 是空的，于是
   13 家店全是「未接入邮箱」、接入抽屉是空壳。现在拆出
   `src/modules/mail/mailStore.ts` 的 `ensureAccountState()`：只拉 prefs / providers / accounts，
   **不含**轮询与同步事件订阅（那是收件箱自己的事），单飞 + 失败可重试；
   `src/modules/shop-accounts/MasterDataView.vue` 挂载时调用，
   `src/modules/shop-accounts/components/MailAccessDrawer.vue` 打开时 await 后再填表单。
3. **恢复只能按业务唯一键映射**。迁移后店铺 id 变了（账号 1/2/3 → 店铺 9/8/7），
   所以回灌 `sk_mail_accounts` 时用 `lower(trim(email))` 对到当前 `sk_shops`，
   同时把备份里 `sk_shop_sets` 的 `secret_enc` / `secret_keys` 按同一邮箱取回（含 `mailAuthPwd`）。
4. **恢复后必须重置 FTS 游标**。真库里 `sk_mail_fts` 残留 890 条孤儿、`sk_mail_meta.fts_indexed_upto = 1446`；
   恢复的邮件 id 最大 851 —— 游标不回零，增量回填会把它们**整批跳过**（搜索恒空，列表却正常）。
   处置：`DELETE FROM sk_mail_fts` + 删 `fts_indexed_upto`，进邮件页时全量重建（实测 851 条）。

## 取证

真库恢复前（`sk_mail_*` 全空、FTS 是旧残渣）：

```
accounts 0 | messages 0 | bodies 0 | folders 0 | fts 890 | meta fts_indexed_upto=1446
sk_shops(7,8,9): secret_keys=[] secret_enc=NULL
```

合并前备份 `sellerkit.db.bak-shop-merge-v1-20261022T060344`（同时是旧形状：有 `sk_shop_sets`）：

```
sk_mail_accounts: 1=rich091002@163.com, 2=rich091003@163.com, 3=rich09105@163.com（各挂旧 set 3/4/5）
sk_mail_messages: 851
sk_shop_sets(3/4/5).secret_keys 均含 mailAuthPwd
备份里的 sk_shops 7/8/9（十二店/十三店/十五店）**没有** shop_set_id ⇒ 账号是合并时新插的纯账号行
```

恢复后（真库）与冷启动实测（真库 APFS 克隆）：

```
3 accounts / 851 messages / 851 bodies / 3 folder cursors ; foreign_key_check 为空
店铺行 9/8/7 的 secret_keys 含 mailAuthPwd（reveal 实测能解密）
克隆冷启动进「基础数据」：三行「已接入 rich0910xx@163.com」，其余「未接入」
接入抽屉：chip=已接入 / 邮箱已填 / 授权码占位「留空表示保持不变」
「邮件」页：INBOX 851，851 封 · 上次同步 10-21；未读 825
```

> 825 ≠ 851 是**既有口径**，不是丢信：未读 = `seen = 0 AND COALESCE(read_at,'') = ''`
> （见 `electron/mail-db.ts` 的 `mailStats`）。备份里有 26 封 `seen=0` 但 `read_at` 已落。

**变异取证**（证明新断言不是恒绿）：把 `MasterDataView` 的 `ensureAccountState()` 调用与抽屉的 await
临时还原后重跑 `npm run master-data:ui`，两条断言同时红，且输出正是用户看到的现象：

```
FAIL 冷启动进本页就读到邮箱接入态 | titles=未接入邮箱 … | 未接入邮箱 …
FAIL 冷启动点开「接入邮箱」：已有配置被回填 | chip=missing | ph=在此粘贴 IMAP 授权码
```

## 前向守卫

- `scripts/master-data-ui-smoke.mjs` **boot 步**三条：冷启动接入态（含"有邮箱但未接入"的反向样本）/
  抽屉回填 / 抽屉可关。⚠️ 必须留在 boot：后面的 mail 步骤会打开「邮件」页，那时 store 已就绪，
  断言挪过去就变成恒绿（这正是这个 bug 三个月没被冒烟抓到的方式）。
- `ensureAccountState` 的"失败置空可重试"是硬要求：建库/拉账号任一失败时不能让后续每次打开抽屉
  都吃一份缓存的失败结果（否则用户要重启应用才能恢复）。
- 夹具纪律：`MailAccountItem.status` 的合法词表是 `idle / syncing / error / paused`；
  冒烟夹具原本写了 `active`（不在词表里），已改 `idle` —— **夹具形状偏离真形状时，UI 的兜底分支永远测不到**。

## 边界（本轮没有做）

- **不改 ADR-003 的级联设计**：删除店铺连带删邮件是既定语义，确认框已按 `hasMailAccount` 写明范围。
- **FTS 孤儿未修**：`sk_mail_fts` 由应用代码维护，店铺级联删邮件时不会走 `removeMailFtsByMessageFilter`，
  索引会留下孤儿（本轮手工清掉 890 条）。当前搜索按消息 id 关联，孤儿不会变成错误结果；
  将来若改成直接查 FTS，必须补删除路径或 join 回 `sk_mail_messages`。
- **备份之后的新邮件不在这里**：备份止于 10-21，10-22 之后的邮件靠 IMAP 同步（各账号游标一并恢复，
  会从断点继续收）。同步窗口外的历史按各账号 `syncDays` 执行。
