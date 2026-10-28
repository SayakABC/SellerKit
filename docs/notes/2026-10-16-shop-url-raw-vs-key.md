# 店铺地址：一列两角色 ⇒ 拆成「匹配键 + 原文」，`https://` 不再被吃掉

**结论（先看这段）**

1. **同一个字段不能既当"匹配键"又当"给人看的地址"**。`sk_shops.shop_url` 原先两个角色都担：
   作为匹配键它必须**归一**（剥掉协议 / `www.` / 尾斜杠 / `index.html` / 查询串，好让"人贴的地址"
   与"页面采集的 URL"对上），作为界面回显与「打开店铺」的目标它又必须**带协议**。
   归一化赢了 ⇒ 用户在「店铺登记」里填 `https://x.com/store/1`，存进去是 `x.com/store/1`，
   再打开编辑前缀不见了，点「打开店铺」报**链接地址无效**（`open-external` 要求 `http(s)://` 开头，
   无协议直接判非法）。**两个症状同一个根因**（2026-10-16 用户报的现场）。
2. **拆列，不折中**：`shop_url` 继续只做匹配键（索引与 `WHERE shop_url = ?` 一字未动，
   采集落库口径不变），新增 `shop_url_raw` 存**用户填的原文**。判据是"这一列有没有下游读者"——
   把协议塞回 `shop_url` 会破坏 `matchShopByStore` 的精确相等，等于拿匹配去换展示。
3. **原文规整只补不删**：`toOpenableUrl()` —— 已带 `http(s)://` 的**原样保留**（用户填 http 就是
   http）、`//host` 补 `https:`、其它协议（`ftp:` / `javascript:`）原样留着交给 `open-external`
   按白名单拒绝（改写成 https 会把"填错了"伪装成"能打开"）、裸域名补 `https://`。
   匹配键**从规整后的原文派生** ⇒ 展示值与键永远同出一次规整。
4. **读取面给原文，缺失才回落**：`mapShopRow()` 输出 `raw || ('https://' + key)`。
   于是四处消费点（店铺登记页「打开」/ 待关联采集商品的下拉「打开」/ 两处表单回显）
   **一行没改就正确** —— 老调用方拿到的是它本来就期望的"可打开地址"。
5. **老库要回填，且只回填一次**：补 `shop_url_raw` 列的同一次，把存量归一键写成
   `https://<键>`（不回填 ⇒ 老店的「打开店铺」照样报无效）。回填条件两个：
   `shop_url_raw = ''`（不覆盖已有原文）+ `shop_url <> ''`（不给没地址的店凭空造地址）。
   **放在"缺列"分支内** = 迁移语义；`shop_url <> ''` 顺带保证"用户清空地址后不会被写回"。

## 取证

**改动点**

| 位置 | 内容 |
| --- | --- |
| `electron/shop-db.ts` | `SCHEMA` 加 `shop_url_raw`；`ensureShopColumns()` 补列 + 回填；新增 `toOpenableUrl()` / `displayShopUrl()`；`upsertShop()` 双写（键从规整后的原文派生）；`COLS` + `mapShopRow()` 读原文 |
| `src/types.ts` | `ShopListItem.shopUrl` / `ShopUpsertInput.shopUrl` 注释改为"原文"（**契约字段名不变**，值语义变） |
| `src/modules/shop-accounts/components/ShopRegistryView.vue` | 地址字段提示：保留协议、无协议按 https、比对时忽略协议等差异 |
| `electron/shop-handlers.ts` / `AccountEditor.vue` | 注释同步（收养入口传的就是原文，内部归一 —— 别在外面再归一一次，会与"键从原文派生"分叉） |
| `scripts/shop-item-db-smoke.cjs` | 5 条新用例 + 1 条改写（原「URL 归一匹配」的 `stored.shopUrl` 断言改为直读库两列） |

**冒烟新增用例**（`npm run shop-item:smoke`，跑前必须 `tsc`，且需 `env -u ELECTRON_RUN_AS_NODE`）

- 原文保留 `http://`（用户填 http 不许被改成 https）+ 读取面给原文
- 裸域名补 `https://`，且读取面的值能过 `open-external` 的协议判据
- 编辑改址 / 清空 ⇒ 两列同步（清空不留幽灵键）
- 迁移（上一版形状：有 `shop_url` 无 `shop_url_raw`）⇒ 补列 + 回填 `https://`
- 迁移（更老形状：地址两列都没有）⇒ 三列一并补上，**不造数据**（`raw` 仍空）
- 迁移**只做一次**：列已在的库不再回填（`alreadyMigrated` 夹具 —— 这是唯一测不到"跑迁移"的形状）

**变异复核（4 条全红，还原后全绿）**

| 变异 | 红在哪 |
| --- | --- |
| `mapShopRow` 回退成给匹配键 | 3 条（原文保留 / 可打开 / 迁移后读取面） |
| 回填移出"缺列"分支 | 1 条（迁移只做一次） |
| 回填去掉 `shop_url <> ''` | 1 条（更老形状：`raw` 被写成 `'https://'`） |
| `upsertShop` 的原文也走 `normalizeShopUrl` | 4 条（= 旧实现整体回退） |

**真库克隆端到端**（`cp -c` 真 `userData/sellerkit.db` 到临时目录，脚本里 `initDb(process.env.SK_DB)`）

```
迁移前 sk_shops：9 行 / 迁移后：9 行
✅ 迁移：行数 / 逐 id / 键值 / 回填全部一致
✅ 读取面：9 家店的地址全部可打开，没地址的店恒空
✅ 匹配链：8 家有地址的店，帧只差协议/www/query/index.html 仍全部命中
```

## 坑（下次照着绕）

1. **⭐ 还原变异后必须重跑 `tsc -p tsconfig.electron.json`**：冒烟读的是 `dist/`。这次我就是
   还原源码后没编译，于是"迁移只做一次"用例红在**变异体残留的 dist** 上，白排查了一轮。
   （本仓既有结论"变异跑完必须 build"的同型坑，只是这里换成了 tsc。）
2. **`initDb` 是单例**：迁移用例必须先 `closeDb()` 再 `initDb(新路径)`，且这类用例要**放在脚本末尾** ——
   换到只建了 `sk_shops` 的库之后，前面那些用例的 `reset()` 会因为 `DELETE FROM pl_shop_items`
   报 `no such table`（本脚本已经把迁移段单开在"收尾"之前）。
3. **夹具建表用 `replace` 拼 DDL 会静默失效**（缩进差一格就 replace 不到，于是夹具少了关键列）。
   形状不同的 DDL 直接各写一份。
4. **"迁移只做一次"不能用"跑迁移"来测**：凡是"建缺列旧库 → ensure"的用例，回填都在进分支那一次完成，
   之后再 ensure 多少次都不进分支 ⇒ 断言"没被改写"必然恒绿。必须先造出**列已在**的库。
5. **本机 `ELECTRON_RUN_AS_NODE=1` 会让 `app` 缺失**：不带 `env -u ELECTRON_RUN_AS_NODE` 跑冒烟时，
   凡是碰 `app.getPath` 的用例（色图那批）会集体红成 `Cannot read properties of undefined (reading 'getPath')`
   —— 那**不是**回归，是环境。判据看改动相关的用例是否绿。
6. 迁移/回填类改动**别只信合成夹具**：真库克隆跑一遍才看得到"9 家真实店铺、键逐 id 不变、匹配仍命中"。
