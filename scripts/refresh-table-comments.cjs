// 刷新 SQLite 存量库的"用途"注释（写到 DDL 内部，进 sqlite_master.sql）。
//
//   npm run refresh:db-comments               # 自动探测 macOS App Support 下的库
//   npm run refresh:db-comments -- --db /path/to/sellerkit.db
//   npm run refresh:db-comments -- --dry-run  # 只打印要改哪些表、前后 DDL diff，不动数据
//
// 背景：SQLite 没有 COMMENT ON 语法，DBeaver / sqlite_master.sql 里能看到的"表说明"
//       只能藏在 CREATE TABLE 语句**内部**的 -- 注释里；语句上方的注释不入库。
//       而 CREATE TABLE IF NOT EXISTS 不会重写老表的 DDL 原文，所以代码里加完注释，
//       存量库看不到。这个脚本安全重建同名表（备份 → 建新表 → 搬数据 → 重建索引 → 追平序列号），
//       让新注释进 sqlite_master.sql。
//
// ⚠️ 注意事项（运行前必读）：
//   · 脚本只插一行 `-- 用途：xxx` 注释，不碰任何列名/类型/约束/CHECK/默认值/外键。
//     这样源码里那些用 tableSql('xxx') 做字符串短路判断的迁移
//     （例如 ledger-db.ts 里 `sql.includes("'offset'")` / `sql.includes('merged_to')`）
//     仍然成立，不会误触发重跑。
//   · 索引会跟着老表一起被 DROP，脚本按 sqlite_master 里原 SQL 重建所有索引；
//     索引的 table 名由 SQLite 从索引 SQL 里的建表语句自动指向新表，不用手动改。
//   · FTS5 虚拟表 sk_mail_fts 及其 5 张影子表不处理（影子表是 SQLite 自建，随虚表走）。
//   · sk_schema_migrations / sqlite_sequence 不处理（前者是迁移基础设施，后者 SQLite 自建）。
//   · 脚本会自动在同目录下生成 sellerkit.db.bak.<时间戳> 备份；
//     如需额外手动备份，请在运行脚本前执行。
//
// 退出码：0 = 成功（含零表需刷新）；1 = 参数错误 / DB 打不开 / 某张表搬数据失败。

const fs = require('fs');
const path = require('path');
const os = require('os');

// 项目依赖 better-sqlite3（package.json 已声明）
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('✗ 找不到 better-sqlite3。请先 npm install（或 electron 环境下 tsc + electron）。');
  process.exit(1);
}

// ──────────────────────── 参数解析 ────────────────────────
const argv = process.argv.slice(2);
let dbPath = null;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--db':
      dbPath = argv[++i];
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '-h':
    case '--help':
    default:
      console.log(
        '用法:\n' +
          '  node scripts/refresh-table-comments.cjs [--db /path/to/sellerkit.db] [--dry-run]',
      );
      process.exit(0);
  }
}

if (!dbPath) {
  // 默认：macOS App Support
  const candidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'seller-kit', 'sellerkit.db'),
    path.join(os.homedir(), 'Library', 'Application Support', 'SellerKit', 'sellerkit.db'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      dbPath = c;
      break;
    }
  }
}
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error(
    `✗ 找不到 sellerkit.db。已尝试:\n  ${dbPath ?? '(未指定)'}\n` +
      '请用 --db 手动指定路径。',
  );
  process.exit(1);
}

// ──────────────────────── 用途注释表 ────────────────────────
// 跟各域 DDL 里刚加的 `-- 用途：` 行保持一致；源码里表名改了要同步这里。
const TABLE_PURPOSES = {
  ae_rates: '外币→CNY 当前汇率（ae 域/成本折算）。只存当前值。',
  ae_settle_lines: 'AE 平台结算明细切片（商品级行 + 订单级行两种，靠 order_no 与订单域软对齐）。',

  bk_parties: '记账「资金相关人」主档（供应商/员工/房东/平台/其他），余额按 party_id 汇总。',
  bk_categories: '收支科目（收入/支出两套各自独立，唯一键 kind+name_key）。',
  bk_entries: '收支条目主表（金额恒为正、方向由 kind 表达；period 是生成列）。',
  bk_allocations: '公共条目（scope=shared）的分摊行，一行 = 一条目×一店；派生数据，整批重写。',
  bk_allocation_rules: '分摊方案（equal/revenue/manual），店铺 id 与万分比存 JSON。',
  bk_settlements: '结算单（付款/收款/互抵结清，一行 = 一次结算；作废不删行）。',
  bk_settlement_lines: '结算单明细（一张单结掉的条目，SETTLEMENT_ID 级联；撤销后可重结）。',
  bk_transfers: '相关人之间的承接余额（合并相关人时把残额转给承接人）。',
  bk_op_log: '记账域操作留痕（改挂/合并/作废等），前后值存 JSON，只追加。',

  oi_orders: '订单主表（订单域，一行 = 一份订单，order_no 唯一）；金额/状态汇总。',
  oi_order_items: '订单明细行（一行 = 订单×商品/尺码），承载归类款色、成本与变体键。',
  oi_variant_keys: '变体键→款色映射（订单驱动归类；state = auto/named/merged）；保证重导幂等。',
  oi_style_merges: '款合并操作头（一行 = 一次合并，支持撤销还原）；明细见 oi_style_merge_items。',
  oi_style_merge_items: '款合并明细（kind = color 搬色 / key 改键），记 from/to 与 from_state 以支持拆开。',
  oi_images: '订单识别图仓（内容指纹唯一，缓存 AI 识别结果与"按图找色"记忆）。',
  parcels: '包裹（一单可多包，按订单行拆；金额/重量缺值为 NULL 不给 0）。',
  parcel_lines: '拆包明细（包×订单行唯一，拆出的 qty 记在这条）。',
  oi_styles: '款式识别池（order 域，code 与主指纹唯一）；业务字段权威在 pl_products。',
  oi_style_colors: '款色主键（款下一种颜色，code 全局唯一）；订单行 / 变体键 / 套装部件都指向它。',
  oi_style_fingerprints: '款式附加指纹（人工归并后让后续识别也命中该款）。',
  oi_color_aliases: '平台色名→自家色名对照（产品级，唯一键 product_id+alias_key）。',
  oi_item_parts: '套装部件（订单行×部位→款色，qty_per_set 记套内件数）。',

  pl_products: '产品/款式主数据（product 域，code 唯一）；cost_cents 是当前进价。',
  pl_bundle_links: '套装关联（套装产品×商品×平台色号→子产品/子色/数量）；只存关系。',
  pl_shop_sku: '店铺商品认款映射（平台商品→产品/SKU，含每件用量）；认款写路径唯一。',
  pl_variants: '产品 SKU（颜色+尺码组合；weight_g 是拣货/运费的唯一克重落点）。',
  pl_images: '产品图仓（内容寻址，fingerprint 唯一；二进制在 userData/product-images/）。',
  pl_item_images: '商品ID→覆盖图（图池最高优先级，人工指定）。',

  pl_shop_items: '店铺商品快照（采集的平台事实，只存"店里有什么"，不认款）。',
  pl_shop_store_keys: '采集「展示名键」→ 已登记店 的收养记忆（防"只跑一次、再采又落未登记桶"）。',

  suppliers: '拿货商主档（purchase 域，name 唯一）；与 sk_companies 不是同一实体。',
  purchase_orders: '拿货单头（一行 = 一次拿货，mode = detail/pool）；total_cents 是明细合计。',
  purchase_items: '拿货明细（一行 = 一个款色码，记买了多少）；与 purchase_sources 粒度不同。',
  purchase_sources: '拿货明细的需求来源（一行 = 一条被凑数的订单行，FIFO 分配）。',
  payments: '供应商往来流水（付款/退款等）；读 = 供应商余额与对账明细。',
  purchase_ignore: '采购需求里的忽略标记（一个款色一行）。',

  sk_companies: '企业法律主体（合规字段 VAT/EORI/对公账户等）。',
  sk_company_profiles: '企业合规资质（欧代/土代/德国包装法等，一行 = 一条资质）。',

  sk_shops: '店铺 + 账号单表（一行可为纯店铺/纯账号/两者）；账号与企业列为软关联。',
  sk_tool_accounts: '紫鸟/ERP 登录账号（一行 = 一个登录，可管多店；密码只存密文）。',
  sk_name_map: '名称归一映射（历史自由文本名 → 实体 ref_id / ignored）。',

  sk_mail_accounts: '邮件账号（一行 = 一个店铺邮箱，shop_id 唯一并级联删除）。',
  sk_mail_messages: '邮件元数据（一账号×文件夹×UID 一行，幂等 upsert 的基石）。',
  sk_mail_bodies: '邮件正文（与消息一对一，大文本拆出列表行以免膨胀）。',
  sk_mail_attachments: '附件元数据（文件名/MIME/大小/content_id）；二进制不入库。',
  sk_mail_folders: '多文件夹增量游标（账号×文件夹一行，唯一键 account_id+path）。',
  sk_mail_attachment_cache: '附件本地缓存索引（只记落盘路径与大小，二进制永不入库）。',
  sk_mail_meta: '内部 KV（FTS 回填游标等非业务状态）；基础设施表。',
  sk_mail_fts: '全文检索虚表（FTS5，rowid = sk_mail_messages.id）。',

  sr_rate_snapshots: '运价表快照（一行 = 一次导入，content_key 去重）；算账按订单日期取"当时那份"。',
};

// 跳过的表：SQLite 内建 / FTS 影子表 / 基础设施
const SKIP = new Set(['sqlite_sequence', 'sk_schema_migrations', 'sk_mail_meta']);
const FTS_SHADOW = /^sk_mail_fts_(config|content|data|docsize|idx)$/;

// ──────────────────────── 工具 ────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在 DDL 的 CREATE TABLE 后、第一列前插入用途注释行。
 * 表名可能有引号（`"xxx"` / `[xxx]` / `` `xxx` ``）或无引号，injectPurpose 里已兼容。
 */
function injectPurpose(ddl, purpose) {
  if (/\n\s*-- 用途：/.test(ddl)) return ddl;
  // CREATE TABLE(IF NOT EXISTS)? ["`[]?]表名["`[]? ( —— 捕获括号前那一段
  const match = ddl.match(
    /^(CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+(?:"|`|\[)?[A-Za-z_][A-Za-z0-9_]*(?:"|`|\])?)\s*\(\s*\n/m,
  );
  if (!match) {
    return ddl.replace(
      /^([\s\S]*?\()(\s*\n)/,
      (_m, prefix, nl) => prefix + nl + `    -- 用途：${purpose}\n`,
    );
  }
  return ddl.replace(
    /^(CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+(?:"|`|\[)?[A-Za-z_][A-Za-z0-9_]*(?:"|`|\])?)\s*\(\s*\n/m,
    (_m, prefix) => `${prefix} (\n    -- 用途：${purpose}\n`,
  );
}

/**
 * 把 CREATE TABLE 后的表名改成新名（保留引号风格）。
 * 原表名可能是 `"xxx"` / `[xxx]` / `` `xxx` `` / `xxx` —— 用正则捕获后替换。
 */
function renameTableInCreateTable(ddl, newName) {
  // 找 CREATE TABLE 后紧跟的非空白非括号 token（可能带引号或不带）
  const m = ddl.match(
    /^CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_]\w*)\s*\(/m,
  );
  if (!m) {
    return ddl.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+\w+/, `CREATE TABLE ${newName}`);
  }
  const quotedName = m[1];
  const newQuoted = quotedName.startsWith('"')
    ? `"${newName}"`
    : quotedName.startsWith('`')
    ? `\`${newName}\``
    : quotedName.startsWith('[')
    ? `[${newName}]`
    : newName;
  return ddl.replace(quotedName, newQuoted);
}

function backupFile(p) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${p}.bak.${ts}`;
  // 优先 SQLite 原生 backup（不受文件系统权限影响）
  try {
    db.backup(backup);
    return backup;
  } catch {
    /* 退到文件复制 */
  }
  try {
    fs.copyFileSync(p, backup);
  } catch {
    throw new Error(`备份失败：SQLite backup 和 fs.copyFileSync 都不可用（路径 ${p}）`);
  }
  return backup;
}

// ──────────────────────── 主流程 ────────────────────────
console.log(`目标库: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('foreign_keys = OFF'); // 重建时关闭外键检查，避免顺序依赖

const tables = db
  .prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  .all();

const FTS_VIRTUAL = new Set();
for (const v of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts%'").all()) {
  FTS_VIRTUAL.add(v.name);
}

const indexSqls = db
  .prepare(
    `SELECT name, sql, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND sql NOT LIKE '%sqlite_autoindex%' ORDER BY tbl_name, name`,
  )
  .all();

const toRefresh = [];
const skipped = [];
const ftsSkipped = [];

for (const t of tables) {
  if (SKIP.has(t.name)) {
    skipped.push(t.name + '（基础设施）');
    continue;
  }
  if (FTS_SHADOW.test(t.name)) {
    ftsSkipped.push(t.name);
    continue;
  }
  if (FTS_VIRTUAL.has(t.name)) {
    ftsSkipped.push(t.name + '（FTS 虚表/影子不重建）');
    continue;
  }
  const purpose = TABLE_PURPOSES[t.name];
  if (!purpose) {
    console.warn(`⚠️  ${t.name} 在 TABLE_PURPOSES 里没登记用途，跳过（请补脚本）`);
    skipped.push(t.name + '（用途未登记）');
    continue;
  }
  if (!t.sql) {
    skipped.push(t.name + '（sqlite_master 无 sql）');
    continue;
  }
  if (/\n\s*-- 用途：/.test(t.sql)) {
    skipped.push(t.name + '（已含用途注释）');
    continue;
  }
  const newSql = injectPurpose(t.sql, purpose);
  toRefresh.push({ name: t.name, oldSql: t.sql, newSql });
}

console.log(`\n要刷新: ${toRefresh.length} 张表`);
console.log(`跳过   : ${skipped.length}（${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? ' …' : ''}）`);
if (ftsSkipped.length) {
  console.log(`FTS 跳过: ${ftsSkipped.length}（${ftsSkipped.join(', ')}）`);
}

if (toRefresh.length === 0) {
  console.log('\n✓ 所有表已带用途注释，无需刷新。');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('\n── DRY-RUN：不会动数据库，只展示 diff ──');
  for (const t of toRefresh) {
    console.log(`\n### ${t.name}`);
    const added = t.newSql.match(/^\s*-- 用途：.*$/m);
    console.log(`+ ${added ? added[0].trim() : '(无变化)'}`);
  }
  db.close();
  process.exit(0);
}

// ── 备份 ──
const backupPath = backupFile(dbPath);
console.log(`\n备份: ${backupPath}`);

// ── 逐表重建 ──
try {
  db.transaction(() => {
    for (const t of toRefresh) {
      const tmp = `${t.name}_comments_tmp`;
      // 建新表（保留原引号风格）
      const tmpSql = renameTableInCreateTable(t.newSql, tmp);
      db.prepare(tmpSql).run();
      // 搬数据
      db.exec(`INSERT INTO ${tmp} SELECT * FROM ${t.name}`);
      // DROP 旧表
      db.exec(`DROP TABLE ${t.name}`);
      // 改名
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${t.name}`);
      // 追平 sqlite_sequence（AUTOINCREMENT）
      try {
        const maxId = db
          .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t.name}`)
          .get().m;
        const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(t.name);
        if (row) {
          db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`).run(maxId, t.name);
        } else if (maxId > 0) {
          db.prepare(`INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)`).run(t.name, maxId);
        }
      } catch {
        /* 非 AUTOINCREMENT 表，忽略 */
      }
      console.log(`  ✓ ${t.name}`);
    }

    // 重建所有索引（从 sqlite_master 原 SQL 拿，SQLite 会自动把 tbl 指到新表）
    // 注意：上面的 DROP TABLE 已经把关联索引也一起 DROP 掉了
    for (const idx of indexSqls) {
      // 只重建目标表是本次刷新过的索引，其他索引（比如指向没刷新表的）可能也被级联删了
      // 保险点：只要 SQL 里没有 IF NOT EXISTS 就自己加
      // SQLite 原生 CREATE INDEX 会因已存在而报错，但上面 DROP 表已经级联删了索引
      const sql = idx.sql.includes('IF NOT EXISTS') ? idx.sql : idx.sql.replace(/^CREATE INDEX/, 'CREATE INDEX IF NOT EXISTS');
      db.prepare(sql).run();
    }
  })();
} catch (err) {
  console.error(`\n✗ 重建失败：${err.message}`);
  console.error('  原库未被改动，但新库可能在半途中。请从备份恢复：');
  console.error(`    cp ${backupPath} ${dbPath}`);
  db.close();
  process.exit(1);
}

db.close();

// ── 验证：重开读 sqlite_master.sql，看注释是否进库 ──
const db2 = new Database(dbPath, { readonly: true });
db2.pragma('foreign_keys = OFF');
let ok = 0;
let fail = 0;
for (const t of toRefresh) {
  const row = db2.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t.name);
  if (row && /\n\s*-- 用途：/.test(row.sql)) ok++;
  else {
    console.error(`  ✗ ${t.name} 重建后仍无用途注释，可能 SQL 解析失败`);
    fail++;
  }
}
db2.close();

console.log(`\n结果: ${ok}/${toRefresh.length} 张表已带用途注释进 sqlite_master.sql`);
if (fail) {
  console.error(`✗ ${fail} 张表未成功。备份在 ${backupPath}`);
  process.exit(1);
}
console.log(`✓ 全部完成。备份在 ${backupPath}`);
