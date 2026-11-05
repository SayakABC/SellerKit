-- POD 图案域 · 一次性建表脚本（**照抄** `electron/pod-db.ts` 的 `POD_SCHEMA`，用于"先看数据、后改代码")
--
--
-- ⚠️ 正式落地**不是**靠这个文件：代码里由 `ensurePodSchema()` 幂等建表（每个入口先调它），
--    本文件只是"想在真库副本上先用 sqlite3 看数"时的便捷入口。两边形状必须一致 ——
--    改 DDL 时以 `electron/pod-db.ts` 为准，改完回来同步这里（同 `docs/plans/MANGO_INGEST_AND_POD_PLAN.md` 附录 A）。
--
-- 用法（**务必先对副本跑**，别直接怼生产库）：
--   cp "$HOME/Library/Application Support/seller-kit/sellerkit.db" /tmp/sk_probe.db
--   sqlite3 /tmp/sk_probe.db < scripts/pod-pattern-schema.sql
--   sqlite3 /tmp/sk_probe.db "SELECT COUNT(*) FROM pod_binding_worklist;"            -- 期望 560
--   sqlite3 /tmp/sk_probe.db "SELECT COUNT(*) FROM pod_binding_worklist WHERE image_key <> '';"  -- 期望 50
--
-- 与 2026-11-01 之前的旧版脚本相比，三处修正（都是施工中真踩到的）：
--   1. `pod_binding_worklist` 的店铺段改为 `sk_shops.name_key`（订单侧是 `toNameKey(oi_orders.shop)`，
--      两边必须逐字节同源；用展示名拼键时，店名多一个空格就让 560 个槽位与订单行一个都匹配不上）；
--   2. 工作清单补 `image_url`（塌陷链接里"同名色"的几张图长得不一样，只给图键等于让用户凭记忆挑图案）；
--   3. **删掉了 `ALTER TABLE oi_orders ADD COLUMN pod_due_at`**：那列从未落地（不再有读者），
--      留着它会让人以为上报单时该读它。真正的判别力两列走 `shop-item-db.ts` 迁移 v3（含回填）。
--
-- 说明：
--   · 建表 / 建视图全部 IF NOT EXISTS 之外，`pod_binding_worklist` 用 DROP + CREATE：
--     视图是纯派生对象，形状变了就该重建（`IF NOT EXISTS` 会静默保留旧列，表现为"代码加了列，界面就是没有"）；
--   · 末尾两条 ALTER **不可重复执行**（SQLite 无 ADD COLUMN IF NOT EXISTS），
--     重跑报 "duplicate column name: pod_n_colors" 属预期，忽略即可；
--   · 判别力回填的口径是「同一色名下不同图键个数的**最大值**」（不是整条链接的图总数 ——
--     后者会把「5 个色各挂 1 张图」算成 5，而那种链接完全不需要图键）。代码里的唯一实现在
--     `electron/podLinkStats.ts`，这里同步了同一口径。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 图案主数据
-- artwork = 制版用图稿（纯图案、无背景）；preview = 认图案用预览图。
-- 两者必须分开存：传错就是花纸商拿模特图去制版，整批报废。
-- ============================================================
CREATE TABLE IF NOT EXISTS pod_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL DEFAULT '',
  name             TEXT NOT NULL DEFAULT '',
  artwork_image_id INTEGER NOT NULL DEFAULT 0,
  preview_image_id INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pod_patterns_code ON pod_patterns(code);

-- ============================================================
-- 2. 变体键 → 图案绑定台账（一行 = 一个槽位）
-- 不复用 oi_variant_keys：那里 style_color_id 是 NOT NULL 外键，
-- 未归类的变体存不进来，而"图案未绑定"恰好最容易发生在这个阶段。
-- ============================================================
CREATE TABLE IF NOT EXISTS pod_variant_patterns (
  variant_key TEXT PRIMARY KEY,
  pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL DEFAULT 'manual',   -- image / name / manual
  image_key   TEXT NOT NULL DEFAULT '',
  sku_code    TEXT NOT NULL DEFAULT '',         -- D-4：图案首选锚点，空 = 未采到
  state       TEXT NOT NULL DEFAULT 'bound',    -- bound / suspected_merge
  bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_vp_pattern ON pod_variant_patterns(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pod_vp_sku ON pod_variant_patterns(sku_code);

-- ============================================================
-- 3. 花纸批次与件数流水
-- 余量按「件」算；pieces_per_sheet 记在批次行（换排版会变，记图案主表会改写历史）
-- ============================================================
CREATE TABLE IF NOT EXISTS pod_sheet_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id       INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  sheets           INTEGER NOT NULL DEFAULT 0,
  pieces_per_sheet INTEGER NOT NULL DEFAULT 0,
  supplier         TEXT NOT NULL DEFAULT '',
  cost_cents       INTEGER NOT NULL DEFAULT 0,
  ordered_at       TEXT NOT NULL DEFAULT '',
  arrived_at       TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pod_sb_pattern ON pod_sheet_batches(pattern_id);

CREATE TABLE IF NOT EXISTS pod_sheet_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES pod_sheet_batches(id) ON DELETE CASCADE,
  delta_pieces      INTEGER NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL DEFAULT 'adjust',   -- arrive / print / adjust
  ref_order_item_id INTEGER NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_sl_batch ON pod_sheet_ledger(batch_id);

-- 余量 = 流水求和，不存冗余列（存冗余列迟早和流水对不上）
CREATE VIEW IF NOT EXISTS pod_pattern_balance AS
SELECT p.id AS pattern_id, p.code AS code,
       COALESCE(SUM(l.delta_pieces), 0) AS remaining_pieces
FROM pod_patterns p
LEFT JOIN pod_sheet_batches b ON b.pattern_id = p.id
LEFT JOIN pod_sheet_ledger  l ON l.batch_id  = b.id
GROUP BY p.id;

-- ============================================================
-- 4. 待绑定清单（本方案核心里程碑：把"要建多少档"变成一行数字）
-- 期望：560 行，其中 image_key <> '' 的 50 行（色名塌陷，必须靠图判别）
-- 键必须与 electron/variantKey.ts 的 variantKey() 逐字节同构（char(0) 分隔、第 4 段只在该色多图时追加）
-- ⚠️ 建它之前 `pl_shop_items` 与 `sk_shops` 必须都在（SQLite 会解析 schema 里的所有视图，
--    引用了不存在的表时，报错会打在**别处**的 SQL 上：error in view … no such table）
-- ============================================================
DROP VIEW IF EXISTS pod_binding_worklist;
CREATE VIEW pod_binding_worklist AS
WITH sku AS (
  SELECT i.item_id AS item_id, s.name AS shop,
         COALESCE(NULLIF(trim(s.name_key), ''), s.name) AS shop_key,
         j.value->>'color' AS color, j.value->>'imageUrl' AS img
  FROM pl_shop_items i JOIN sk_shops s ON s.id = i.shop_id, json_each(i.sku_json) j
  WHERE i.sku_json <> ''
), slot AS (
  SELECT item_id, shop, shop_key, color, img FROM sku GROUP BY item_id, shop, shop_key, color, img
), namecnt AS (
  -- 商品ID 只在店内唯一，跨店同 ID 不是同一个链接
  SELECT shop_key, item_id, color, COUNT(*) AS imgs FROM slot GROUP BY shop_key, item_id, color
)
SELECT
  s.shop_key || char(0) || s.item_id || char(0) || s.color
    || CASE WHEN n.imgs > 1
            THEN char(0) || substr(s.img, instr(s.img,'/kf/')+4,
                                   instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
            ELSE '' END AS variant_key,
  s.shop     AS shop,
  s.item_id  AS item_id,
  s.color    AS color,
  CASE WHEN n.imgs > 1
       THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
       ELSE '' END AS image_key,
  n.imgs     AS imgs_in_name,
  s.img      AS image_url
FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color;

-- ============================================================
-- 5. 列新增（不可重复执行，重跑报 duplicate column 属预期）
-- 正式路径是 `shop-item-db.ts` 的迁移 v3：补列 + 回填存量（这里给的是同一口径的手工版）。
-- ============================================================
ALTER TABLE pl_shop_items ADD COLUMN pod_n_colors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pl_shop_items ADD COLUMN pod_n_images INTEGER NOT NULL DEFAULT 0;

-- 判别力两列：n_colors = 不同色名个数（空色名也算一个桶）；
--             n_images = **同一色名下**不同图键个数的最大值（不是整条链接的图总数）。
-- 也可以在 sqlite3 里直接调不到 TS 函数，故这里用等价的 SQL 还原同一口径。
UPDATE pl_shop_items SET
  pod_n_colors = COALESCE((
    SELECT COUNT(DISTINCT j.value->>'color')
    FROM json_each(pl_shop_items.sku_json) j
  ), 0),
  pod_n_images = COALESCE((
    SELECT MAX(per_color.n)
    FROM (
      SELECT COUNT(DISTINCT j.value->>'imageUrl') AS n
      FROM json_each(pl_shop_items.sku_json) j
      GROUP BY j.value->>'color'
    ) per_color
  ), 0)
WHERE sku_json <> '';
