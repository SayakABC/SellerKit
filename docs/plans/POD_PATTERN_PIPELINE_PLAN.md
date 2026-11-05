# POD 图案流水线 · 落地实施方案

> 本文替代前几份分散分析（`SellerKit_自动化机会清单` / `功能ROI评估` / `图案识别与花纸方案` / `冷启动建档策略` / `采集与图案池自动化` / `规格文本不可靠的解法` / `色名塌陷与图案判别`），把结论收敛成一条可执行链路。
>
> **所有 DDL、视图、SQL 均已在真库副本（`/tmp/sk_pod_probe.db`，14MB）上实跑通过**，非纸面设计。实测基线：71 链接 / 520 色名槽 / **560 个真实图案槽** / 6 个色名塌陷链接。

---

## 0. 结论收敛

| 争议点 | 收敛结论 | 依据 |
|---|---|---|
| 图案怎么认 | **不认图，认槽位**。槽位 = (链接, 色名[, 图键])，一次绑定永久复用 | 560 槽 vs 5000 单，比值 1:9 |
| 色名可不可信 | 不可信，但**可用**：它是"该链接内指向那一个 SKU"的键，不是色名 | `variantKey.ts` 原注释已写透 |
| 色名重复怎么办 | 加第 4 段 `imageKey`，**只对塌陷链接生效** | 实测 6/71 塌陷，全部同名多图 |
| 绑定表放哪 | **新建 `pod_variant_patterns`**，不挂 `oi_variant_keys` | 后者 `style_color_id NOT NULL REFERENCES`，未归类变体存不进去 |
| 键怎么扩展 | **变长**（3 段或 4 段），不做全量迁移 | 3/4 段天然不撞，`UNIQUE` 不用动 |
| 花纸余量按什么算 | 按**件**，`pieces_per_sheet` 记在**批次行** | 换排版会变，记图案主表会算错 |
| 交期从哪算 | 平台订单时间 + handling days，落 `oi_orders.pod_due_at` | 用本地入库时间会把导入延迟变成超时 |

---

## 1. 范围

**做（本域唯一目标）**：把 560 个槽位一次性绑到图案上，之后每单自动知道"印哪个图案"，花纸按图案聚合报单，余量跨单复用。

**不做**（芒果已覆盖，做了是双写冲突）：抓单、拣货、采购、打单、发货回传、刊登、物流、防关联环境。

---

## 2. 数据模型（已实测跑通）

### 2.1 DDL 全文

```sql
PRAGMA foreign_keys = ON;

-- 图案主数据。artwork（制版用图稿，纯图案无背景）与 preview（认图案用）必须分开存：
-- 传错就是花纸商拿模特图去制版，整批报废。
CREATE TABLE IF NOT EXISTS pod_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,                 -- P001，业务唯一编码
  name             TEXT NOT NULL DEFAULT '',
  artwork_image_id INTEGER NOT NULL DEFAULT 0,
  preview_image_id INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pod_patterns_code ON pod_patterns(code);

-- 变体键 → 图案 绑定台账（一行 = 一个槽位）
CREATE TABLE IF NOT EXISTS pod_variant_patterns (
  variant_key TEXT PRIMARY KEY,
  pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL DEFAULT 'manual',     -- image / name / manual
  image_key   TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'bound',      -- bound / suspected_merge
  bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_vp_pattern ON pod_variant_patterns(pattern_id);

-- 每链接判别力统计（让"是否塌陷"成为可查字段，不靠人工维护清单）
ALTER TABLE pl_shop_items ADD COLUMN pod_n_colors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pl_shop_items ADD COLUMN pod_n_images INTEGER NOT NULL DEFAULT 0;

-- 花纸批次（一次报单 = 一批）
CREATE TABLE IF NOT EXISTS pod_sheet_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id       INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  sheets           INTEGER NOT NULL,
  pieces_per_sheet INTEGER NOT NULL,
  supplier         TEXT NOT NULL DEFAULT '',
  cost_cents       INTEGER NOT NULL DEFAULT 0,
  ordered_at       TEXT NOT NULL,
  arrived_at       TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pod_sb_pattern ON pod_sheet_batches(pattern_id);

-- 件的流水：到货 +，印花 -，盘点调整 ±。余量 = 求和，不存冗余列
CREATE TABLE IF NOT EXISTS pod_sheet_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES pod_sheet_batches(id) ON DELETE CASCADE,
  delta_pieces      INTEGER NOT NULL,
  reason            TEXT NOT NULL,                -- arrive / print / adjust
  ref_order_item_id INTEGER NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_sl_batch ON pod_sheet_ledger(batch_id);

CREATE VIEW IF NOT EXISTS pod_pattern_balance AS
SELECT p.id AS pattern_id, p.code,
       COALESCE(SUM(l.delta_pieces), 0) AS remaining_pieces
FROM pod_patterns p
LEFT JOIN pod_sheet_batches b ON b.pattern_id = p.id
LEFT JOIN pod_sheet_ledger  l ON l.batch_id  = b.id
GROUP BY p.id;

-- 交期（从平台订单时间算）
ALTER TABLE oi_orders ADD COLUMN pod_due_at TEXT NOT NULL DEFAULT '';
```

### 2.2 为什么绑定表不复用 `oi_variant_keys`

现有表长这样：

```sql
CREATE TABLE oi_variant_keys (
  variant_key TEXT NOT NULL UNIQUE,
  style_color_id INTEGER NOT NULL REFERENCES oi_style_colors(id) ON DELETE CASCADE,
  ...
)
```

两个理由不复用：

1. **`style_color_id` 是 NOT NULL 外键**。未归类的变体（新链接刚出单、款色还没建）在表里根本没有行 —— 而"图案未绑定"恰恰最容易发生在这个阶段。硬塞进去就得先建档色，把两件事耦合死。
2. **职责不同**：款色管拿货成本与利润（款/色级），图案管印花（图案级）。一款多图案是常态，合并进一张表迟早要为"一个款色多个图案"再拆一次。

代价是多一张表、多一次 join。可接受。

### 2.3 迁移步骤 v13 骨架

挂在 `orderMigrationSteps()`（当前最新 v12），写法照 `addVariantKeys()` 的幂等模式：

```ts
{
  version: 13,
  name: 'POD 图案域：图案主数据 / 绑定台账 / 花纸批次与流水 / 链接判别力 / 交期列',
  up: migratePodPatternDomain,
},
```

```ts
function migratePodPatternDomain(): void {
  const d = getDb();
  // 新库：自定义迁移先于 dbMigrate(SCHEMA)，此刻明细表还没建出来 → 空转，交给 SCHEMA
  if (!tableExists('pl_shop_items')) return;

  d.exec(POD_SCHEMA_DDL);   // 上面 §2.1 的建表部分（不含 ALTER）

  const cols = (t: string) =>
    dbQuery<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => String(c.name));

  if (!cols('pl_shop_items').includes('pod_n_colors')) {
    dbRun(`ALTER TABLE pl_shop_items ADD COLUMN pod_n_colors INTEGER NOT NULL DEFAULT 0`);
    dbRun(`ALTER TABLE pl_shop_items ADD COLUMN pod_n_images INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols('oi_orders').includes('pod_due_at')) {
    dbRun(`ALTER TABLE oi_orders ADD COLUMN pod_due_at TEXT NOT NULL DEFAULT ''`);
  }
  backfillPodLinkStats();   // 见 §3.4
}
```

⚠️ **`ALTER TABLE ADD COLUMN` 不能写在 `db.exec(POD_SCHEMA_DDL)` 里**。SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行会报 `duplicate column name`，迁移会直接失败——这类失败发生在用户升级那一刻，不是测试时。

---

## 3. 判别链

### 3.1 图片身份归一化（新文件 `electron/podImageKey.ts`，纯函数）

```ts
/**
 * 从速卖通图片 URL 抽出稳定身份：`/kf/S<32hex>.<ext>` 里的 hash 段。
 *
 * 只认 `/kf/` 路径：那是速卖通图床的固定前缀。其他来源（卖家自己传的图床、
 * 报表里被替换过的地址）一律返回 ''，**降级到色名，不猜**。
 *
 * 不归一化 hash 段本身：hash 是内容标识，动它就是自己制造误判。
 * host（ae-pic-a1 / ae01.alicdn）与尺寸后缀（_640x640.jpg）都会变，所以只取中间那段。
 */
export function imageKeyOf(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  if (!s) return '';
  const m = /\/kf\/([0-9A-Za-z]+)\.(?:jpg|jpeg|png|webp)/i.exec(s);
  return m ? m[1] : '';
}
```

实测两侧同构，抽出来完全一致：

```
订单侧 .../kf/S2410a62cba024a409bd20be7bfc8f5c2u.jpg → S2410a62cba024a409bd20be7bfc8f5c2u
采集侧 .../kf/S59b69e8fd14e40f5b9d154d288e79ebbn.jpg → S59b69e8fd14e40f5b9d154d288e79ebbn
```

### 3.2 `variant_key` 加第 4 段（改 `electron/variantKey.ts`）

```ts
export interface VariantKeyParts {
  shopKey: string;
  itemKey: string;
  colorKey: string;
  /** 图案判别用的图键；空 = 该链接色名足够区分，仍是 3 段键 */
  imageKey?: string;
}

export function variantKeyOf(parts: VariantKeyParts): string {
  const item = normSegment(parts?.itemKey);
  if (!item) return '';
  const segs = [normSegment(parts?.shopKey), item, normSegment(parts?.colorKey)];
  const img = normSegment(parts?.imageKey);
  if (img) segs.push(img);           // 只有非空才追加 → 存量 3 段键逐字节不变
  return segs.join(SEP);
}

export function splitVariantKey(key: unknown): VariantKeyParts {
  const s = typeof key === 'string' ? key : '';
  if (!s) return { shopKey: '', itemKey: '', colorKey: '', imageKey: '' };
  const p = s.split(SEP);
  if (p.length < 3 || p.length > 4) return { shopKey: '', itemKey: '', colorKey: '', imageKey: '' };
  return { shopKey: p[0] ?? '', itemKey: p[1] ?? '', colorKey: p[2] ?? '', imageKey: p[3] ?? '' };
}
```

**`p.length !== 3` 必须改成 `< 3 || > 4`。** 这是唯一会静默失败的点：不改它，4 段键拆出来是全空串，而所有依赖拆键的路径（展示、排障、回填）都会拿到空值却**不报错**。

配套单测（`vitest`，本模块是纯函数可直接覆盖）：

| 用例 | 期望 |
|---|---|
| `variantKeyOf` 不传 imageKey | 与旧实现逐字节相同（防回归） |
| `variantKeyOf` 传 imageKey | 4 段，第 4 段 = 归一后的图键 |
| `splitVariantKey` 3 段 / 4 段 | 各自还原，`imageKey` 分别为 `''` / 原值 |
| `splitVariantKey` 2 段 / 5 段 / 空串 | 全空，不抛错 |
| 键中含 `\u0000` 的脏输入 | 不产生跨段撞车（沿用 `normSegment` 的剥离） |

### 3.3 订单行取图键（改 `electron/order-db.ts` 的 `variantKeyOfRow` 链路）

现有回填只取了 `shop / raw_fields / color`，需要 JOIN `md_images` 补图：

```ts
const rows = dbQuery<{ id: number; shop: string; raw_fields: string; color: string; img_url: string }>(
  `SELECT oi.id AS id, COALESCE(o.shop,'') AS shop,
          COALESCE(oi.raw_fields,'') AS raw_fields,
          COALESCE(oi.color,'') AS color,
          COALESCE(m.source_url,'') AS img_url
     FROM oi_order_items oi
     LEFT JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN md_images  m ON m.id = oi.image_id
    WHERE COALESCE(oi.variant_key,'') = ''`,
);
for (const r of rows) {
  const key = variantKeyOfRow(r.shop, r.raw_fields, r.color, imageKeyOf(r.img_url));
  if (key) dbRun(`UPDATE oi_order_items SET variant_key = ? WHERE id = ?`, [key, r.id]);
}
```

⚠️ **`WHERE variant_key = ''` 是硬陷阱**：存量键非空就永不回填。改了函数之后，现有 75 行**一行都不会更新**。必须另做一次定向重算，且范围要窄——只重算塌陷链接（`pl_shop_items.pod_n_colors = 1 AND pod_n_images > 1`），其余 64 个链接的 3 段键一个字节都别动（动了就是全量重绑）。

### 3.4 判别链（运行时）

```
订单行
 ├ 有 image_id → imageKeyOf(md_images.source_url)
 │   ├ 非空 → 在同一 (shop, item) 的槽位里按 image_key 精确匹配
 │   │   ├ 命中 1 槽 → 绑定它                                    ✅
 │   │   └ 命中多槽（同图多 SKU）→ 视为同一图案，state='suspected_merge'  ✅
 │   └ 空 / 未命中 → 降级
 ├ 降级到 (shop, item, color) 精确匹配色名
 │   ├ 命中 1 槽 → 绑定它                                        ✅
 │   └ 该链接色名塌陷（pod_n_colors=1 且 pod_n_images>1）→ **不许降级到色名**，直接进人工
 └ 全部失败 → 人工队列（不猜、不取"最像的"）
```

**为什么图优先于色名**：图 URL 是平台 SKU 的内部标识，卖家改不了；色名是自由文本，改一次旧绑定就断。

**为什么塌陷链接禁止降级到色名**：该链接色名只有 1 个值，降级等于把 5–12 个图案并成 1 个——静默错印，比识别失败严重得多。

### 3.5 判别力统计必须在 upsert 里算（陷阱）

`upsertShopItems()` 是 `UPDATE pl_shop_items SET ...`，**不是 REPLACE**。所以：

- 采集重跑时如果不把 `pod_n_colors / pod_n_images` 写进 UPDATE 的 SET 列表，这两列就**永远停在第一次回填的值**；
- 新链接插入时不写，就是 0，而 0 会被判成"未统计"，塌陷检测直接失效。

两处都要加。计算逻辑与 §4 视图同源，抽一个 `podLinkStats(skuJson)` 纯函数，插入与更新各调一次。

---

## 4. 待绑定清单（视图，已实测 560 行）

这是整个方案的核心资产：**它把"要建多少档"从猜测变成一行数字**。

```sql
CREATE VIEW IF NOT EXISTS pod_binding_worklist AS
WITH sku AS (
  SELECT i.item_id, s.name AS shop, j.value->>'color' AS color, j.value->>'imageUrl' AS img
  FROM pl_shop_items i JOIN sk_shops s ON s.id = i.shop_id, json_each(i.sku_json) j
  WHERE i.sku_json <> ''
), slot AS (
  SELECT item_id, shop, color, img FROM sku GROUP BY item_id, shop, color, img
), namecnt AS (
  SELECT item_id, color, COUNT(*) AS imgs FROM slot GROUP BY item_id, color
)
SELECT
  s.shop || char(0) || s.item_id || char(0) || s.color
    || CASE WHEN n.imgs > 1
            THEN char(0) || substr(s.img, instr(s.img,'/kf/')+4,
                                   instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
            ELSE '' END AS variant_key,
  s.shop, s.item_id, s.color,
  CASE WHEN n.imgs > 1
       THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
       ELSE '' END AS image_key,
  n.imgs AS imgs_in_name
FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color;
```

实测输出：

| 指标 | 值 |
|---|---|
| 槽位总数 | **560** |
| 其中需要图键（塌陷） | **50** |
| 覆盖链接 | **71** |

**键构造一致性已验证**：用 SQL 拼出的 `variant_key` 与应用的 `variantKey.ts` 落库值，对可对照的 4 个订单行 **4/4 逐字节相等**（色名 `7` / `Khaki` / `black` / `6`，每行唯一命中 1 槽）。说明 SQL 侧与 TS 侧是同一个口径，不存在两套实现。

---

## 5. 绑定页交互

**一屏平铺 24 张 SKU 色图**，键盘流：

| 键 | 动作 |
|---|---|
| `Space` | 多选（同一图案常横跨多槽，一次指定） |
| `1`–`9` | 快选已有图案 |
| `Enter` | 确认并跳下一张 |
| `N` | 就地新建图案 |
| `S` | 跳过（进欠账队列） |

三条设计约束：

1. **默认让人先搜已有图案，搜不到才新建**。POD 上新 90% 是"老图案配新款"，建成全新图案是少数。多数人感觉"一直在建"，是因为把 A 类（纯映射，30 秒）当 C 类（全新图案，10 分钟）在做。
2. **预填必须标来源**：`P012（图指纹相同）` 可以直接信；`P012（标题含 Racing）` 要确认。
3. **不强制选颜色**。87/89 条映射是 `spec='*'`，颜色不参与判定，强制选色是纯无用功。

**排序**：按近 30 天订单量倒序，不按时间。前 20% 链接覆盖 80% 订单；1–2 单的链接攒着不建（就 1 单，人工看 30 秒比建档快）。

---

## 6. 报单闭环

```sql
-- 待印件数（按图案聚合，跨店铺）
WITH need AS (
  SELECT vp.pattern_id, COUNT(*) AS pieces
  FROM oi_order_items oi
  JOIN pod_variant_patterns vp ON vp.variant_key = oi.variant_key
  WHERE oi.status = 'pending'          -- 未发货
  GROUP BY vp.pattern_id
)
SELECT p.code, n.pieces AS 待印件,
       COALESCE(b.remaining_pieces, 0) AS 余量,
       CASE WHEN n.pieces > COALESCE(b.remaining_pieces, 0)
            THEN n.pieces - COALESCE(b.remaining_pieces, 0) ELSE 0 END AS 净需件
FROM need n
JOIN pod_patterns p ON p.id = n.pattern_id
LEFT JOIN pod_pattern_balance b ON b.pattern_id = n.pattern_id
WHERE n.pieces > COALESCE(b.remaining_pieces, 0)
ORDER BY 净需件 DESC;
```

报单张数 = `ceil(净需件 / pieces_per_sheet)`。**余量够的那几行净需件 = 0，不进报单** —— 那几行就是直接省下来的钱。

报单输出一个 zip：`报单_20261101.zip`（清单.xlsx + 非零图案的**图稿**）。花纸商拿到就能开工，不用再一张张发图。

三条不能错的：

1. **余量按"件"算，不按"张"**。单位搞错，余量复用全废。
2. **`pieces_per_sheet` 记在批次行，不记图案主表**。换排版就变，记主表会让历史批次被新值改写。
3. **印花完成才扣余量，报单时不扣**。报单只是意向，花纸没到就扣，等于账上凭空少货。

---

## 7. 里程碑与验收

| 周 | 做什么 | 验收判据（可执行 SQL） |
|---|---|---|
| **W0（半天）** | 建 DDL + `pod_binding_worklist`，导出 560 行清单人工看一遍 | `SELECT COUNT(*) FROM pod_binding_worklist` = **560**，`SUM(image_key<>'')` = **50** |
| **W1** | `podImageKey.ts` + `variantKey` 第 4 段 + 单测；`pod_patterns` 表与建档页 | 单测全绿；`SELECT COUNT(*) FROM pod_patterns` > 0 且 `artwork_image_id>0` 占比可查 |
| **W2** | 绑定页（键盘流）+ 塌陷链接定向重算 | `SELECT COUNT(*) FROM pod_variant_patterns` / 560 ≥ 60%，且**塌陷链接 50 槽全绑**（这 50 个是错印高风险，必须 100%） |
| **W3** | 图稿归位 + 报单页 + zip 导出 | 一次报单能产出 `清单.xlsx + 图稿`，且余量够的图案净需件为 0 |
| **W4** | 花纸批次入库 + 印花扣减 + 余量看板 | 连续 3 天：`SUM(remaining_pieces)` 与实际库存盘点差 ≤ 2 件 |

**终点判据（比功能清单重要）**：

```sql
-- 每天跑一次：绑定覆盖率
SELECT (SELECT COUNT(*) FROM pod_binding_worklist) AS 总槽位,
       (SELECT COUNT(*) FROM pod_variant_patterns) AS 已绑定,
       ROUND(100.0 * (SELECT COUNT(*) FROM pod_variant_patterns)
                   / (SELECT COUNT(*) FROM pod_binding_worklist), 1) AS 覆盖率;
```

覆盖率 < 60% 时，**不许开工 W3**。报单建立在绑定之上，绑定不全就去报单，等于按残缺数据买花纸。

---

## 8. 红线

1. **图案做成宿主内建模块，不做 UI 岛**。`PICKING_PLAN.md:107-111` 已裁定：内建页不受 `DB_OPS` 10 op 上限限制。
2. **`splitVariantKey` 的 `!== 3` 不改，4 段键静默失效**。改完必须补单测。
3. **回填条件 `WHERE variant_key = ''` 不会更新存量**。必须单独定向重算，且只对塌陷链接。
4. **塌陷链接禁止降级到色名**。降级 = 把 5–12 个图案并成 1 个。
5. **图稿 ≠ 商品主图**。传错花纸商拿模特图制版，整批报废。
6. **`pod_n_colors / pod_n_images` 必须在 upsert 的 INSERT 与 UPDATE 两处都算**，否则采集重跑后永远是旧值。
7. **图案侵权是 POD 最大法律风险**。检测工具只作辅助，必须人工复核 + 违规图案黑名单。
8. **发错图案 = 全额损失**（印了图案的成品退回即废品）。打包必须扫码校验，不能靠人眼。

---

## 9. 一句话

> 560 个槽位、一次性绑定，换掉 5000 单/2 个月的看图；花纸按图案聚合报单，余量跨单复用。
>
> 整条链路的本质不是"识别图片"，是**把图案这个维度从订单里搬到槽位上，只搬一次**。
