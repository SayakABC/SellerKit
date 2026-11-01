-- POD 图案流水线 · 一次性建表脚本（对应实施方案 §2 / §4）
--
-- 用法（务必先对副本跑，别直接怼生产库）：
--   cp "$HOME/Library/Application Support/seller-kit/sellerkit.db" /tmp/sk_probe.db
--   sqlite3 /tmp/sk_probe.db < scripts/pod-pattern-schema.sql
--   sqlite3 /tmp/sk_probe.db "SELECT COUNT(*) FROM pod_binding_worklist;"   -- 期望 560
--
-- 说明：
--   1. 建表与建视图全部 IF NOT EXISTS，可重复执行。
--   2. 末尾 3 条 ALTER 不可重复执行（SQLite 无 ADD COLUMN IF NOT EXISTS），
--      重跑报 "duplicate column name: pod_n_colors" 属预期，忽略即可。
--   3. 正式落地由迁移 v13 接管（见 docs/plans/POD_PATTERN_PIPELINE_PLAN.md §2.3），
--      本文件用于「先看数据、后改代码」的验证阶段。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 图案主数据
-- artwork = 制版用图稿（纯图案、无背景）；preview = 认图案用预览图。
-- 两者必须分开存：传错就是花纸商拿模特图去制版，整批报废。
-- ============================================================
CREATE TABLE IF NOT EXISTS pod_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,
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
-- 2. 变体键 → 图案 绑定台账（一行 = 一个槽位）
-- 不复用 oi_variant_keys：那里 style_color_id 是 NOT NULL 外键，
-- 未归类的变体存不进来，而"图案未绑定"恰好最容易发生在这个阶段。
-- ============================================================
CREATE TABLE IF NOT EXISTS pod_variant_patterns (
  variant_key TEXT PRIMARY KEY,
  pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL DEFAULT 'manual',   -- image / name / manual
  image_key   TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'bound',    -- bound / suspected_merge
  bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_vp_pattern ON pod_variant_patterns(pattern_id);

-- ============================================================
-- 3. 花纸批次与件数流水
-- 余量按「件」算；pieces_per_sheet 记在批次行（换排版会变，记图案主表会改写历史）
-- ============================================================
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

CREATE TABLE IF NOT EXISTS pod_sheet_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES pod_sheet_batches(id) ON DELETE CASCADE,
  delta_pieces      INTEGER NOT NULL,
  reason            TEXT NOT NULL,              -- arrive / print / adjust
  ref_order_item_id INTEGER NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_sl_batch ON pod_sheet_ledger(batch_id);

-- 余量 = 流水求和，不存冗余列（存冗余列迟早和流水对不上）
CREATE VIEW IF NOT EXISTS pod_pattern_balance AS
SELECT p.id AS pattern_id, p.code,
       COALESCE(SUM(l.delta_pieces), 0) AS remaining_pieces
FROM pod_patterns p
LEFT JOIN pod_sheet_batches b ON b.pattern_id = p.id
LEFT JOIN pod_sheet_ledger  l ON l.batch_id  = b.id
GROUP BY p.id;

-- ============================================================
-- 4. 待绑定清单（本方案的核心里程碑：把"要建多少档"变成一行数字）
-- 期望：560 行，其中 image_key<>'' 的 50 行（色名塌陷，必须靠图判别）
-- ============================================================
DROP VIEW IF EXISTS pod_binding_worklist;
CREATE VIEW pod_binding_worklist AS
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
  s.shop   AS shop,
  s.item_id AS item_id,
  s.color  AS color,
  CASE WHEN n.imgs > 1
       THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
       ELSE '' END AS image_key,
  n.imgs AS imgs_in_name
FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color;

-- ============================================================
-- 5. 列新增（不可重复执行，重跑报 duplicate column 属预期）
-- ============================================================
ALTER TABLE pl_shop_items ADD COLUMN pod_n_colors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pl_shop_items ADD COLUMN pod_n_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oi_orders     ADD COLUMN pod_due_at   TEXT    NOT NULL DEFAULT '';

-- 回填链接判别力（正式版应放进 upsertShopItems 的 INSERT/UPDATE 两处，见方案 §3.5）
WITH sku AS (
  SELECT i.item_id, j.value->>'color' AS c, j.value->>'imageUrl' AS u
  FROM pl_shop_items i, json_each(i.sku_json) j WHERE i.sku_json <> ''
), per AS (
  SELECT item_id, COUNT(DISTINCT c) AS n, COUNT(DISTINCT u) AS m FROM sku GROUP BY item_id
)
UPDATE pl_shop_items SET
  pod_n_colors = (SELECT n FROM per WHERE per.item_id = pl_shop_items.item_id),
  pod_n_images = (SELECT m FROM per WHERE per.item_id = pl_shop_items.item_id)
WHERE item_id IN (SELECT item_id FROM per);
