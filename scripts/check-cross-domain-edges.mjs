// scripts/check-cross-domain-edges.mjs
// 「跨域数据访问」守卫（数据表审查 P1-4 的收口）。
//
// 背景：各域模块（`electron/*-db.ts`）只管自己的表，"跨域"是**代码归属边界**而非物理分库
// （全仓共用一个 `userData/sellerkit.db`，见 `docs/notes/2026-10-30-island-host-boundary.md`）。
// 跨域访问在主进程里有两种落地形态，风险完全不同：
//
//   1) 静态 `import`（`ae-db.ts: import { upsertCollectedOrder } from './order-db'`）
//      —— 同一个 ts 项目，编译期就查。**风险不是"查不到"，而是"没人知道多了一条"**：
//      某域开始认识另一域的表，应该是有意识的决定（ADR-002 C1/C3：两个 db 都不该认识对方，
//      要合流就收到编排层，如 `purchase-cost-sync.ts`），不能顺手加。→ 规则 B 登记每一条。
//
//   2) 跨文件 `require()`（写型 handler 的历史惯例：`electron/order-handlers.ts` 等）
//      —— **只有带上 `as typeof import(...)` 才进类型检查**。不带就是 `any`。
//      实测（2026-10-15）：把 `order-db.findStyleColorImagePath` 的 `color` 由 `string` 改成 `number`，
//      `purchase-handlers.ts` 的两处调用（传的正是 string）**tsc 零报错** —— 直到运行期才按错参数查图。
//      → 规则 A：一律补 `as typeof import(...)`（擦除后无运行时开销）。
//
// ⭐ 规则 B 不写死"用途说明"文字，而是把**从对方拿到的符号清单**与源码逐字比对：
//    用途悄悄变了（多 import 一个函数 = 跨域面扩大）也会红，
//    避免出现"在册说明慢慢变成假话"（本仓屡次踩过的坑）。
//
// 两条规则都带**空转守卫**：扫到的条数低于基线即判失败 —— 正则失效 / 目录搬走时"全绿"没有意义。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const ELECTRON_DIR = path.join(ROOT, 'electron');

/** 数据访问层模块名（`electron/*-db.ts`）—— 本守卫的自变量范围 */
const DB_MODULE = /^\.\/[a-z0-9-]+-db$/;

// ---- 基线（空转守卫用）：低于这些数说明扫描失效，直接判失败 ----
const MIN_DB_REQUIRES = 3;
const MIN_DB_EDGES = 4;

/**
 * 在册的 db→db 静态 import 边（**唯一权威清单**）。
 * `symbols` = 从对方拿到的符号（源码为准，排序后逐字比对）。
 * 增删一条边、或给既有边多拿一个符号，都必须回来改这里并想清楚"这算不算跨域面扩大"。
 */
const DB_EDGES = [
  {
    from: 'ae-db.ts',
    to: './order-db',
    symbols: ['upsertCollectedOrder'],
    why: 'C1 采集写主干：采集帧折算成 CNY 分后经它写 oi_orders（唯一订单主干）',
  },
  {
    from: 'order-db.ts',
    to: './product-db',
    symbols: [
      'adoptProduct',
      // 2026-10-30（认款补图）：认款把订单图绑到款色后，顺手把它采纳为产品主图 ——
      //   "只补空"的判定必须收在产品域（`pl_products.image_id = 0`），订单域不另写一份。
      //   只借用这个窄接口，不因此把产品写入口挪到订单域。
      'adoptProductImageIfEmpty',
      // 2026-10-28（套装）：归到套装款后自动展开成部件快照
      //   `isBundleProduct` 判"这个产品是不是套装"、`resolveBundleParts` 按 (产品,商品ID,色号)
      //   查出各部件色名、`bundleRolesOf` 在配色缺失时告诉用户"差哪个部位"。
      //   ⚠️ 展开**不猜**：色号没配过就 `missingColor` + 一件不写（写错就是少发一条裤子）。
      'bundleRolesOf',
      'ensureProductSchema',
      'isBundleProduct',
      // 2026-10-28（命名板组头）：款名与厂家一起改。厂家唯一权威在采购域 `suppliers`，
      //   产品层只存 `supplier_id`，所以只能经它这个窄接口写（code 定位、只改一列）。
      'moveProductSupplier',
      'orderColorByItemImage',
      'productIdByCode',
      'productSchemaReady',
      'renameProduct',
      'resolveBundleParts',
      'resolveOrderSku',
      'resolveShopRef',
      // 2026-10-21（C2 v9）：退役旧价目表前，把每个款最新的价镜像进产品「当前进价」
      // （一次性；只补空，不覆盖产品页已维护的价）。
      'setProductCostByCode',
      // 2026-10-20：全库重放要按"与 resolveOrderSku 同一口径"筛出有效映射
      // （`source <> 池来源 && shop_id <> 0`）。自己抄一份条件 = 两份口径漂移，
      // 漏掉的正是"池行被当成映射"这类静默错。
      'skuMappingSql',
      'upsertSkuMappings',
    ],
    why: '归类/导入把订单挂到产品款色（pl_* 主数据归产品库，订单侧只用它的认款能力）；orderColorByItemImage 是「订单图 → 采集色图 → 颜色」的唯一入口（订单域不直接读采集表，分层只在产品域收口）',
  },
  {
    from: 'picking-db.ts',
    to: './product-db',
    symbols: ['itemImagePool'],
    why: '拣货行取「商品池」图（三层回落图的最后一层）',
  },
  {
    from: 'picking-db.ts',
    to: './order-db',
    symbols: ['ITEM_STYLE_COLOR_ID'],
    why:
      '拣货行的款色/款编码/供应商必须按「订单行优先、图回落」取（ITEM_STYLE_COLOR_ID 是唯一一份）；' +
      '改造前只认图，订单行自动归类后这 9/75 行在拿货页仍是"未识别款无供应商"',
  },
  {
    from: 'purchase-db.ts',
    to: './product-db',
    symbols: ['productSchemaReady'],
    why: '拿货建单前判产品库是否已就绪（各域表按域懒建，不能假定都初始化过）',
  },
  {
    from: 'purchase-db.ts',
    to: './order-db',
    symbols: ['ITEM_STYLE_COLOR_ID', 'ITEM_STYLE_COLOR_SRC'],
    why:
      '待拿货缺口按「订单行 → 款色」展开（套装 = 一件实物多个款色）：口径必须与 itemStyleColorIds 同一份，各写一遍必然漂移；' +
      'ITEM_STYLE_COLOR_ID 是「这一行归哪个款色」的唯一身份表达式（订单行优先、图回落）',
  },
  {
    from: 'shop-accounts-db.ts',
    to: './shop-db',
    symbols: [
      'SHOP_STATUSES',
      'TOOL_ACCOUNT_KINDS',
      'ensureShopSchema',
      'normalizeShopScore',
      'normalizeShopUrl',
      'toOpenableUrl',
    ],
    why: '账号域不再自建表：表 owner 是 shop-db（sk_shops 物理合并后的唯一表）；复用其建表/迁移、地址归一与记分分值归一，合并 upsert 直接写同一行的账号列',
  },
  {
    from: 'shop-db.ts',
    to: './company-db',
    symbols: ['ensureCompanySchema'],
    why: '店铺主迁移要把旧账号的手机号 / 支付宝并进企业表，先确保企业表（含 alipay_account 列）已就绪；后续经 company_id 引用企业，不读企业其余字段',
  },
  {
    from: 'shop-item-db.ts',
    to: './shop-db',
    symbols: ['ensureShopSchema', 'getShop', 'normalizeShopUrl'],
    why: '采集商品认店：先比归一化 URL / storeId，认不出落未登记桶（绝不自动建店）；建表也找 owner（读链 LEFT JOIN sk_shops，全新库第一站是「店铺商品」时不能炸）',
  },
  // 图案域（M3·T3-1，2026-11-01）：它的「待绑定清单」视图从**商品快照**摊槽位，
  // 键的第一段是**店名** —— 两张输入表缺一张视图就建不出来。
  // 方向是"消费者 → 提供方"（图案域读它们，所以图案域先把它们的建表跑到），
  // 刻意**不**反过来让商品快照域替图案域建视图：底层域不该知道上层域的存在。
  // ⚠️ 这个顺序不是口味问题：跨域视图建早了会让**整个库**的语句报
  //   `error in view pod_binding_worklist: no such table: main.pl_shop_items`（2026-11-01 实测）。
  {
    from: 'pod-db.ts',
    to: './shop-item-db',
    symbols: ['ensureShopItemSchema'],
    why: '槽位从 pl_shop_items.sku_json 摊出来；本域入口先确保输入表在，再建跨域视图（建早了整库语句都会报错）',
  },
  {
    from: 'pod-db.ts',
    to: './shop-db',
    symbols: ['ensureShopSchema'],
    why: '槽位键的第一段是店铺名（读 sk_shops）；且商品快照域的迁移自己也要 sk_shops 先就位',
  },
  {
    from: 'shop-product-db.ts',
    to: './product-db',
    symbols: ['SKU_POOL_SOURCE', 'ensureProductSchema', 'ensureSkuSchema', 'skuPoolSql'],
    why: '商品↔产品关联共用「商品池」SQL（池的唯一定义在 product-db）',
  },  {
    from: 'product-db.ts',
    to: './shop-item-db',
    symbols: ['itemShopIndex', 'shopIdByItemId', 'skuColorByItemImage'],
    why: '认店补末级证据：店铺原文归一落空时用**商品ID 反查采集快照**（pl_shop_items 的键本来就是店+商品ID，商品ID 是平台给的、比手填店名强）。只作兜底，反查不出 / 多店歧义一律保持「未归一」，绝不猜一个店 —— 否则"配了映射却不生效"又会变成查不出的静默错账',
  },
  // ---- 主数据域（S0a / R1）：图片收口到唯一图片仓 `md_images` ----
  //
  // 这两条边是**收口本身**，不是新的耦合：旧实现里订单域查 `oi_images`、产品域查 `pl_images`，
  // 同一件事各有各的表/目录/落盘代码（两表 AUTOINCREMENT 撞 id 的生产 P0 就出在这里）。
  // R1 之后两个业务域只做两件事：
  //   ① 读 —— 列表/拿货单按 `image_id` 取 `local_path`（`imageIdExists` / `imageLocalPathMap` /
  //      `allImageLocalPaths`，以及订单导入的两级去重查询 `findImageBy*Fingerprint`）；
  //   ② 登记 —— 图已经在 `images/` 里时经 `registerImageRow` 落行（不写文件）；
  //   ③ `ensureMasterDataSchema` 是"各域懒建表"的同一纪律：读侧 JOIN 它，就不能假定别人建过。
  // 二进制落盘仍然只有 `landImageBytes` 一个入口，业务域**不**碰文件系统。
  {
    from: 'order-db.ts',
    to: './master-data-db',
    symbols: [
      'allImageLocalPaths',
      'ensureMasterDataSchema',
      'findImageByFingerprint',
      'findImageByUrlFingerprint',
      'imageIdExists',
      'registerImageRow',
    ],
    why: '订单域只读图片主数据：列表/拿货单取 local_path、导入按 URL/内容指纹复用同一行（"按图找色"的命入口）；登记图只经 registerImageRow（落盘唯一入口是 landImageBytes）',
  },
  {
    from: 'product-db.ts',
    to: './master-data-db',
    symbols: ['ensureMasterDataSchema', 'imageIdExists', 'imageLocalPathMap', 'registerImageRow'],
    why: '产品域同理：款主图/列表缩略图读 md_images.local_path，挂图前用 imageIdExists 挡住野 id（产品 id 误当图片 id 是历史事故），登记委托 registerImageRow',
  },
  // 下面两条是 R1d 之后**取数投影要带缩略图**带出来的读边（2026-11-01）：
  // 拣货单与拿货单的每一行都要显示"这行是什么色/什么图案"，而色图与本行订单图都是
  // `image_id`，路径唯一来源是 `md_images.local_path`。
  // 为什么不收进编排层：`imageLocalPathMap` 的调用点在投影函数**内部**（拼行时一次批量解析，
  // 一屏 2000 行只查一次），收上去就得把行拼装拆成"投影 → 编排喂路径 → 再拼回"两段，
  // 却不减少任何一次查询 —— 只是把同一个批量读搬了个位置。**只读、不写文件、缺表降级**，风险面很小。
  {
    from: 'picking-db.ts',
    to: './master-data-db',
    symbols: ['imageLocalPathMap'],
    why: '拣货投影按 `image_id` 批量取本地路径（款色代表图 → 本行订单图 → 商品池三档回落，见行上注释）；只读 md_images，缺表降级为空 Map 不抛',
  },
  {
    from: 'purchase-db.ts',
    to: './master-data-db',
    symbols: ['imageLocalPathMap'],
    why: '拿货/对账的覆盖行缩略图同上：一次批量把 style_color_image_id / order_image_id 解析成路径；只读，缺 md_images 表降级为空',
  },
];

function read(file) {
  return fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
}

function listElectronTs() {
  return fs
    .readdirSync(ELECTRON_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .sort();
}

const problems = [];
const files = listElectronTs();

// ══════════ 规则 A：`require('<路径>-db')` 必须带类型标注 ══════════
//
// 只扫 `*-db`：数据访问层是"改了签名就静默错查"的那一层。
// （`main.ts` 的 `require('./order-handlers')` 是**只为注册副作用**的裸调用，没有 API 要查，
//   typed 与否无意义；其余普通模块的 require 属另一类清理，不在本守卫范围。）
const REQUIRE_RX = /require\(\s*'(\.\/[a-z0-9-]+-db)'\s*\)/g;

const requires = [];
for (const file of files) {
  const src = read(file);
  for (const m of src.matchAll(REQUIRE_RX)) {
    const typed = new RegExp(
      `require\\(\\s*'${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*\\)\\s*as\\s+typeof\\s+import\\(\\s*'([^']+)'\\s*\\)`,
    ).exec(src.slice(m.index, m.index + 200));
    requires.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      target: m[1],
      // 标注必须指向**同一个模块**（写成 import('./other-db') 等于没查）
      typedPath: typed ? typed[1] : null,
    });
  }
}
requires.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

for (const r of requires) {
  if (r.typedPath === null) {
    problems.push(
      `${r.file}:${r.line} 对 ${r.target} 的 require 没有类型标注` +
        `（应写 \`require('${r.target}') as typeof import('${r.target}')\`）`,
    );
  } else if (r.typedPath !== r.target) {
    problems.push(
      `${r.file}:${r.line} 类型标注指向了别的模块（${r.typedPath} ≠ ${r.target}）—— 等于没查`,
    );
  }
}

// ══════════ 规则 B：db→db 静态 import 边必须逐条在册 ══════════
const IMPORT_RX = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.\/[a-z0-9-]+-db)'/g;

/** 从源码抽一条 import 的符号名（去掉 `as` 别名、注释残留、非标识符 token） */
function symbolsOf(listRaw) {
  return listRaw
    .split(',')
    .map((t) => t.trim().split(/\s+as\s+/)[0].trim())
    .filter((t) => /^[A-Za-z_$][\w$]*$/.test(t))
    .sort();
}

const edges = [];
for (const file of files) {
  if (!/-db\.ts$/.test(file)) continue; // 只算"数据层 → 数据层"
  const src = read(file);
  for (const m of src.matchAll(IMPORT_RX)) {
    edges.push({
      from: file,
      to: m[2],
      symbols: symbolsOf(m[1]),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
}
edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from < b.from ? -1 : 1));

const key = (e) => `${e.from} -> ${e.to}`;
const declared = new Map(DB_EDGES.map((e) => [key(e), e]));

const seen = new Set();
for (const e of edges) {
  const k = key(e);
  if (seen.has(k)) {
    problems.push(`${e.from}:${e.line} 同一条边出现两次（${e.to}）—— 清单一处就够`);
    continue;
  }
  seen.add(k);
  const decl = declared.get(k);
  if (!decl) {
    problems.push(
      `${e.from}:${e.line} 新增未登记的 db→db 边：${e.from} → ${e.to}` +
        `\n     └ 跨域访问要"有意识的决定"：先问能不能收进编排层（如 purchase-cost-sync.ts）` +
        `\n     └ 确实要直连，就在 check-cross-domain-edges.mjs 的 DB_EDGES 里登记并写清为什么`,
    );
    continue;
  }
  const want = [...decl.symbols].sort();
  const got = e.symbols;
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    const added = got.filter((s) => !want.includes(s));
    const removed = want.filter((s) => !got.includes(s));
    problems.push(
      `${e.from}:${e.line} 在册边 ${k} 的**取用面变了**` +
        (added.length ? `\n     └ 多取了：${added.join(', ')}` : '') +
        (removed.length ? `\n     └ 不再取：${removed.join(', ')}` : '') +
        `\n     └ 请复核这次扩大/收缩是否有意，然后更新 DB_EDGES 的 symbols`,
    );
  }
}

// 在册但没有对应代码的边 = 陈旧条目（说明不再成立），也要报
for (const d of DB_EDGES) {
  if (!seen.has(key(d))) {
    problems.push(`在册边 ${key(d)} 在源码里已不存在 —— 陈旧条目，请从 DB_EDGES 删掉`);
  }
}

// ══════════ 空转守卫 ══════════
if (requires.length < MIN_DB_REQUIRES) {
  problems.push(
    `只扫到 ${requires.length} 处 require('*-db')（基线 ${MIN_DB_REQUIRES}）—— 正则失效 / 文件搬走了，守卫不能空转`,
  );
}
if (edges.length < MIN_DB_EDGES) {
  problems.push(
    `只扫到 ${edges.length} 条 db→db 边（基线 ${MIN_DB_EDGES}）—— 正则失效 / 目录结构变了，守卫不能空转`,
  );
}

// ══════════ 输出 ══════════
console.log(`规则 A —— require('<路径>-db') 的类型标注（${requires.length} 处）：`);
for (const r of requires) {
  const ok = r.typedPath === r.target;
  console.log(`  ${ok ? '✅' : '❌'} ${r.file}:${r.line}  ${r.target}`);
}
console.log(`\n规则 B —— db→db 静态 import 边（${edges.length} 条，在册 ${DB_EDGES.length} 条）：`);
for (const e of edges) {
  const decl = declared.get(key(e));
  const ok = decl && JSON.stringify([...decl.symbols].sort()) === JSON.stringify(e.symbols);
  console.log(`  ${ok ? '✅' : '❌'} ${key(e)}  ← ${e.symbols.join(', ')}`);
}

if (problems.length) {
  for (const p of problems) console.error(`❌ ${p}`);
  console.error(
    '\n跨域访问要么被编译期看住（规则 A），要么被显式登记（规则 B）。请按上面提示处置。',
  );
  process.exit(1);
}
console.log('\n✅ 跨域数据访问全部合规：require 均有类型标注，db→db 边与在册清单逐条一致');
