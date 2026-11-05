// electron/pod-need.ts
// **净需件的取数编排层**（M4·T4-1）。
//
// 为什么是编排层而不是 `pod-db.ts` 里的一条 SQL 视图：计划附录 A 的 `pod_order_need` 视图要
// 「待发货集合与 T2-1 同一份实现」，而那份实现是 `src/lib/mangoStatus.ts` 的**正则规则**。
// 在 SQL 里手写 `biz_status IN ('待发货', …)` 就是第二套口径 —— "发货台说 3 单待发、
// 报单说 5 件要印"这类分裂正是这么来的。所以本层只做**投影**（订单行 / 绑定索引 / 图案余量原样搬），
// 聚合与状态判定交给渲染层 `src/lib/podNeed.ts`（`isWaitingShip` 只在那里被调一次）。
//
// 依赖方向：编排层可以同时认识订单域与图案域（同 `mango-sync.ts` / `purchase-cost-sync.ts`），
// 两个 `*-db.ts` 之间**不直连**（跨域边守卫会拦）。
//
// ⚠️ `bindings` 用**普通对象**而不是 `Map` 传给渲染层：IPC 的 structured clone 支持 Map，
//    但载荷会在 preload 里被二次拼装，对象形状更容易被断言钉住（一屏几千个键，不差这点）。
//    键里含 `\u0000`，JSON/IPC 都按普通字符处理，不会截断。

export {};

import { dbQuery } from './db';
import { ensureOrderSchema } from './order-db';
import {
  ensurePodSchema,
  podBindingIndex,
  podImageIndex,
  podPatternList,
  podStyleColorIndex,
  podWorklistStats,
} from './pod-db';

/**
 * 一个订单行（净需件的输入；字段名与 `src/lib/podNeed.ts` 的 `PodNeedCandidate` 逐字对应）。
 *
 * 2026-11-02 加 `itemId / color / imageFingerprint / imagePath`：认图案的单位改成**订单图片**
 * （用户口径「最终肯定是根据订单中的图片来决定印什么花的」）。订单行本来就带 `image_id`
 * （→ `md_images`），内容指纹是现成的，**不需要再下载一遍图**。
 */
export interface PodNeedCandidateRow {
  variantKey: string;
  bizStatus: string;
  qty: number | null;
  shop: string;
  orderNo: string;
  /** 商品ID（图片卡片上显示"商品 xxx"、搜索也要用它） */
  itemId: string;
  /** 订单行的颜色原文（图片卡片上显示"这张图覆盖了哪些颜色"） */
  color: string;
  /** 订单图的内容指纹（空 = 这一行没图，只能按变体键匹配） */
  imageFingerprint: string;
  /** 订单图的本地路径（渲染层缩略图通道只认本地文件；空 = 本地没有这张图） */
  imagePath: string;
  /** 订单图的原始 URL（空 = 没图）。只有"库里记了图但本地文件丢了"时才用到（界面给一个「重新下载」） */
  imageUrl: string;
  // ── 款色（2026-11-03：认图案的单位从"一张订单图"改成"款里的一个颜色"）────────────
  // 用户口径：「按款图进行用户手动分类汇总图案」「SKU 图案和花纸图案 id 的关系，自动维护款中的图案数据」。
  // 一个款有三种颜色 ⇒ 三行 chips 摆在一张款卡片里，用户一次就能看出"这俩是同一朵花"。
  // 0 / 空串 = 这一行还没在「归类核对」里认到款色（界面按商品ID 兜底分组）。
  /** 款 id（`oi_style_colors.style_id`；0 = 没归类） */
  styleId: number;
  /** 款编码（`oi_styles.code`；界面标题用它，空 = 没归类） */
  styleCode: string;
  /** 款色 id（`oi_style_colors.id`；认图案的稳定身份，跨店铺/换图都不变） */
  styleColorId: number;
  /** 款色名（`oi_style_colors.color`，自家色名；空 = 没归类 / 订单没给色） */
  styleColorName: string;
  /** 款色的代表图指纹（`oi_style_colors.image_id` → `md_images`；空 = 这个色还没配图） */
  styleImageFingerprint: string;
  /** 款色代表图的本地路径（款卡片里的那张"款图/色图"） */
  styleImagePath: string;
}

export interface PodNeedPatternRow {
  id: number;
  code: string;
  name: string;
  artworkImageId: number;
  previewImageId: number;
  remainingPieces: number;
  /** `active` / `retired`（界面可标注"已停用"，但净需件仍算它 —— 单已经下了） */
  status: string;
}

export interface PodNeedData {
  candidates: PodNeedCandidateRow[];
  bindings: Record<string, number>;
  /** 图片指纹 → 图案（**优先于** `bindings`；见 `src/lib/podNeed.ts` 的匹配顺序） */
  imageBindings: Record<string, number>;
  /** 款色 id → 图案（**最优先**：款色换了商品图也还认得，见 `pod_style_color_patterns`） */
  styleColorBindings: Record<string, number>;
  patterns: PodNeedPatternRow[];
  /** 绑定台汇总（报单页顶部与绑定台共用一份口径） */
  bindingStats: { total: number; bound: number; collapsed: number; collapsedBound: number };
  /** 取数截断标记（>0 = 本次只取了前 N 行，报单口径不完整，界面必须说） */
  truncated: number;
}

/** 一次最多取多少订单行（真库 75 行；留到 5000 足够跑几年，超了要让人知道口径被截断） */
const MAX_CANDIDATES = 5000;

/**
 * 订单行投影（`variant_key` 为空的行也要带上）。
 *
 * 为什么带上空键行：那些行同样"等我发货"，但永远匹配不到图案 —— 它们是 `unboundPieces` 的
 * 一部分。SQL 里 `WHERE variant_key <> ''` 会让未绑定数偏小，而"少算了未绑定"正是报单偏少的起点。
 */
export function podNeedCandidates(limit = MAX_CANDIDATES): {
  rows: PodNeedCandidateRow[];
  total: number;
} {
  ensureOrderSchema();
  const cap = Math.min(Math.max(Math.round(Number(limit) || MAX_CANDIDATES), 1), 20000);
  const total = Number(
    dbQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_order_items`)[0]?.n ?? 0
  );
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT COALESCE(oi.variant_key, '') AS variant_key, COALESCE(o.biz_status, '') AS biz_status,
            oi.qty AS qty, COALESCE(o.shop, '') AS shop, COALESCE(o.order_no, '') AS order_no,
            COALESCE(oi.item_id, '') AS item_id, COALESCE(oi.color, '') AS color,
            COALESCE(mi.fingerprint, '') AS image_fingerprint,
            COALESCE(mi.local_path, '') AS image_path,
            COALESCE(mi.source_url, '') AS image_url,
            COALESCE(sc.style_id, 0) AS style_id,
            COALESCE(st.code, '') AS style_code,
            COALESCE(sc.id, 0) AS style_color_id,
            COALESCE(sc.color, '') AS style_color_name,
            COALESCE(si.fingerprint, '') AS style_image_fingerprint,
            COALESCE(si.local_path, '') AS style_image_path
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN md_images mi ON mi.id = oi.image_id
       -- 款色是认图案的稳定身份（跨店铺、换商品图都不变）；没归类的行这两张表都落空，
       -- 界面按商品ID 兜底分组 —— 不是错误，是"还没做第 2 步归类核对"
       LEFT JOIN oi_style_colors sc ON sc.id = oi.style_color_id
       LEFT JOIN oi_styles st ON st.id = sc.style_id
       LEFT JOIN md_images si ON si.id = sc.image_id
      ORDER BY oi.id DESC
      LIMIT ?`,
    [cap]
  ).map((r) => ({
    variantKey: String(r.variant_key ?? ''),
    bizStatus: String(r.biz_status ?? ''),
    qty:
      r.qty === null || r.qty === undefined || !Number.isFinite(Number(r.qty))
        ? null
        : Number(r.qty),
    shop: String(r.shop ?? ''),
    orderNo: String(r.order_no ?? ''),
    itemId: String(r.item_id ?? ''),
    color: String(r.color ?? ''),
    imageFingerprint: String(r.image_fingerprint ?? ''),
    imagePath: String(r.image_path ?? ''),
    imageUrl: String(r.image_url ?? ''),
    styleId: Number(r.style_id ?? 0) || 0,
    styleCode: String(r.style_code ?? ''),
    styleColorId: Number(r.style_color_id ?? 0) || 0,
    styleColorName: String(r.style_color_name ?? ''),
    styleImageFingerprint: String(r.style_image_fingerprint ?? ''),
    styleImagePath: String(r.style_image_path ?? ''),
  }));
  return { rows, total };
}

/** 图案 + 余量（`pod_pattern_balance` 直读；"还没买过花纸"的图案也出现，余量 0） */
export function podNeedPatterns(): PodNeedPatternRow[] {
  ensurePodSchema();
  return podPatternList({}).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    artworkImageId: p.artworkImageId,
    previewImageId: p.previewImageId,
    remainingPieces: p.remainingPieces,
    status: p.status,
  }));
}

/** 报单页的全部输入（一次 IPC 取齐：三张表的读不能各取一次，否则三份数字各自漂移） */
export function podNeedData(): PodNeedData {
  const { rows, total } = podNeedCandidates();
  const index = podBindingIndex();
  const bindings: Record<string, number> = {};
  for (const [k, v] of index) bindings[k] = v;
  const imgIndex = podImageIndex();
  const imageBindings: Record<string, number> = {};
  for (const [k, v] of imgIndex) imageBindings[k] = v;
  // 款色 → 图案（数字键经 IPC 会变成字符串键；渲染层解析时按 Number() 还原）
  const styleColorBindings: Record<string, number> = {};
  for (const [k, v] of podStyleColorIndex()) styleColorBindings[String(k)] = v;
  const stats = podWorklistStats();
  return {
    candidates: rows,
    bindings,
    imageBindings,
    styleColorBindings,
    patterns: podNeedPatterns(),
    bindingStats: {
      total: stats.total,
      bound: stats.bound,
      collapsed: stats.collapsed,
      collapsedBound: stats.collapsedBound,
    },
    truncated: Math.max(0, total - rows.length),
  };
}
