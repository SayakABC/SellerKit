// 「归类核对」域在渲染层的**薄封装**：把宿主的 `order*` 通道收成带类型的函数。
//
// ⚠️ **本文件不含任何业务算法**：指纹算 `@/lib/styleMatcher`、品类/颜色归一算
//    `@/lib/orderClassifier`（与导入/产品库同一份实现）。指纹只有同源，"识别出来的款"与
//    "人工核对的款"才会落到同一个款编码上（两处各写一套必然同款拆成两款，见该文件的注释）。
//
// ⚠️ **2026-10-28：云端视觉识别链路已整条删除**（`readEngine` / `recognizeOrder` /
//    `src/core/ai` / 「设置 › 识别」页 / `order-api-key-*` 两个通道）。原因是它们自 2026-10-05
//    起就**零调用方**（「识别未归类」按钮当时已删），而用户已决定不接云端模型 ——
//    留着就是"用户配了 Key、没有任何地方会用它"的只写不读。判断与替代路线见
//    `docs/notes/2026-10-28-classify-local-vision-direction.md`。**别再往这里加识别入口**：
//    本地视觉方案（像素特征/颜色检索）落点在 `src/lib/imageFeatures.ts` + 主进程解码，
//    与云端引擎无关。
//
// 为什么不用 `src/core/services/ipc.ts` 的导出：那里 `order*` 主要挂在 `ipc` 实例上，
// 这里补齐后调用点读起来是 `listPending()` 而不是 `ipc.orderList({...})`，且失败一律抛错
// （`success:false` 的 error 文案比"静默空列表"有用 —— 空列表会被读成"没有待核对的单"）。

import { ipc, type ApiResult } from '@/core/services/ipc';
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import type { OrderRecord, SkuBackfillOutcome, StyleRecord, ColorAliasRemembered } from '@/types';

/** 取单个值：失败抛错 */
async function need<T>(p: Promise<ApiResult<T>>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

// ─────────────────────────────────────────────────────────── 取数

/** 一页多少行（主进程 `orderList` 上限 2000，但核对是逐行看的，一屏 30~50 行够用） */
export const PAGE_SIZE = 30;

export interface PendingPage {
  rows: OrderRecord[];
  total: number;
}

/** 分页条件（待核对与已核对**共用**一份 —— 两个范围必须同规格，否则"切范围"会顺手换掉别的筛） */
interface PageOpts {
  offset?: number;
  limit?: number;
  search?: string;
  importDate?: string;
}

/** 待核对 / 已核对两个范围**唯一**的取数实现 —— `corrected` 是它俩的全部差别。 */
async function listPage(corrected: boolean, opts: PageOpts): Promise<PendingPage> {
  const r = await ipc.orderList({
    offset: 0,
    limit: PAGE_SIZE,
    corrected,
    ...opts,
  });
  if (!r.success) throw new Error(r.error || '读取订单失败');
  return { rows: r.data?.rows ?? [], total: Number(r.data?.total ?? 0) };
}

/**
 * 待核对订单（`corrected = false`），关键字下沉到主进程 LIKE。
 *
 * ⚠️ `importDate`（`yyyy-mm-dd`）是**「发货台」的每日口径**：本页挂在发货台第 2 步上，
 *    只核对**今天导进来**的那批（与容器 `reload()` 同一口径，见 `TodayView` 的注释）。
 *    不传 = 全库（本函数被别处复用时才有意义；当前只有一个调用方）。
 */
export async function listPending(opts: PageOpts = {}): Promise<PendingPage> {
  return listPage(false, opts);
}

/**
 * 已核对订单（`corrected = true`）—— 「已核对」范围的列表内容。
 *
 * 为什么取数要单独有一个：退回（{@link reopenCorrected}）是**看着行点**的动作，
 * 而这些行按定义不在待核对列表里 ⇒ 没有这条取数，用户就没有任何地方能看见它们，
 * 也就无从谈起"退哪一行"（真库现场：23 行全已核对而颜色全空，用户找不到回去的路）。
 *
 * 分页 / 搜索 / 导入日筛一律与 {@link listPending} **同一份实现**（只差 `corrected`）——
 * 两个范围各写一套必然会漂（典型症状：切范围后搜索框里的词还在、但筛的东西悄悄换了）。
 */
export async function listCorrected(opts: PageOpts = {}): Promise<PendingPage> {
  return listPage(true, opts);
}

/** 款选项（「归属款」下拉）—— **产品库全集**，不是识别池（见 `StyleRecord` 的注释） */
export async function listStyleOptions(): Promise<StyleRecord[]> {
  const r = await ipc.orderStyleList();
  if (!r.success) throw new Error(r.error || '读取产品库款式失败');
  return r.data ?? [];
}

export interface PendingCounts {
  /** 今天这批里**还没核对**的行数（`corrected = 0`） */
  pending: number;
  /**
   * 今天这批里**已核对**的行数（`corrected = 1`）。
   *
   * 为什么要有它：这页的动作是"逐行核对 → 那行离开列表"，用户做完一轮后**看不到自己做了多少**，
   * 列表一空只剩一句"全部订单都核对完了" —— 无从判断到底是"真核完了"还是"这批本来就没有"。
   * 两个数并排（待核对 X · 已核对 Y）就把这件事答清楚了；口径与 `pending` **必须同一个筛**
   * （都按导入日），否则两边的和会大于这批的行数，用户一眼看出对不上。
   */
  corrected: number;
  unclassified: number;
  /**
   * 库里**已经用过**的颜色写法（去重、有上限）—— 核对页颜色框的输入建议。
   * 只在"没有归属款 / 该款还没录颜色"时才用得上（有款有颜色时给的是**该款的下拉**）。
   * ⚠️ 与下面那次 `limit: 2000` 的取数是**同一次请求**顺带算出来的，没有额外往返；也因此
   * 只覆盖最近 2000 行 —— 建议列表够用即可，它不是"全库词表"的承诺。
   */
  usedColors: string[];
}

/** 取一列去重值（去空白、排序、上限） */
function distinctColumn(
  rows: OrderRecord[],
  pick: (o: OrderRecord) => string,
  cap = 40,
): string[] {
  const s = new Set<string>();
  for (const o of rows) {
    const v = String(pick(o) ?? '').trim();
    if (v) s.add(v);
  }
  return [...s].sort().slice(0, cap);
}

/**
 * 待核对 + 已核对 + 其中**还没有归属款**的行数（页头计数用；独立查一次是为了不受分页影响）。
 *
 * ⚠️ 三个数**必须同一个筛**（`importDate`）：只筛其中一个的话，两个数并排时对不上这批的总行数。
 * ⚠️ 2026-10-10：页头那条「待核对 / 未归类 / 识别库 / 已配产品」指标条按用户口径**整条撤掉**
 * （"看不懂"）⇒ 这里不再统计"款数"（那要额外查一次识别池），也不再统计"品类写法"
 * （品类列已撤）。2026-10-11 又把「已核对」加回来：它不是指标条，而是**这一页的动作计数**
 * （见 `PendingCounts.corrected`）—— 一条带 label 的短句，不是一排六格。
 */
export async function pendingCounts(opts: { importDate?: string } = {}): Promise<PendingCounts> {
  const [pending, corrected, all] = await Promise.all([
    ipc.orderList({ limit: 1, corrected: false, importDate: opts.importDate }),
    ipc.orderList({ limit: 1, corrected: true, importDate: opts.importDate }),
    ipc.orderList({ limit: 2000, importDate: opts.importDate }),
  ]);
  const rows = all.success ? (all.data?.rows ?? []) : [];
  return {
    pending: pending.success ? Number(pending.data?.total ?? 0) : 0,
    corrected: corrected.success ? Number(corrected.data?.total ?? 0) : 0,
    unclassified: rows.filter((o) => !o.styleCode).length,
    usedColors: distinctColumn(rows, (o) => o.color),
  };
}

// ─────────────────────────────────────────────────────────── 写

export interface CorrectionInput {
  id: number;
  category: string;
  color: string;
  logo: string;
  /** 订单携带的识别特征（来自 `oi_images.result_json`）—— 重建指纹用，缺它则指纹只剩品类 */
  features: string[];
  /** 用户在下拉里**显式点名**的目标款**编码**；`''` = 自动匹配当前归属 */
  targetStyle: string;
  /** 品类/颜色是否相对当前值有变（决定要不要 reclassify） */
  fieldsChanged: boolean;
}

export interface CorrectionResult {
  /** 本次归属的款编码（空串 = 没归到任何款） */
  styleCode: string;
  /**
   * ⭐ **回流**结果：点名某个款时，宿主顺带把「(店铺, 商品ID) → 款 + 色」记进确定性层
   * （`pl_shop_sku`），使该商品的**后续订单自动归类**、不再进待核对队列。
   * 只有"点名款"这条路有它 —— 只改品类/颜色走的是指纹重归类，不涉及商品级结论。
   */
  skuBackfill?: SkuBackfillOutcome;
  /**
   * ⭐ 顺带记住的**色名对照**（平台色名 → 我方色名）。
   *
   * 同 `skuBackfill`：`null`/缺省不影响"已保存"这个结论，界面只额外说一句"以后这个名字都叫 X"。
   */
  colorAlias?: ColorAliasRemembered | null;
}

/**
 * 保存一行核对结果，返回本次归属的款编码（空串 = 没归到任何款）。
 *
 * 与 `order-db.updateOrder` 的配合顺序**不可颠倒**（两条宿主通道）：
 *   1. `orderUpdate({ ..., reclassify })` —— 宿主按 `fingerprint + features` 重算归属款/款色。
 *      ⚠️ 重归类分支的条件是 `input.reclassify && input.fingerprint`，**必须带指纹**；
 *         只传 `reclassify` 而不传指纹是个**静默空操作**（旧版岛里就漏传过）。
 *   2. `orderStyleAssign` —— 仅当用户在下拉里**点名了款**时；把订单图挂到目标款并把指纹记入该款，
 *      使**后续自动识别**命中同一款编码。**这一步也是"颜色记忆"的落点**：宿主写下的
 *      `oi_images.style_color_id` 就是"这张图是什么颜色"，同一张图（按内容/URL 指纹去重，
 *      地址相同必然命中同一行）下次出现时读到的就是这个颜色。宿主还会顺带做**商品ID 回流**
 *      （写 `pl_shop_sku` + 回填存量），结果随 `skuBackfill` 回来 —— 见 `CorrectionResult`。
 *
 * ⚠️ 点名款走的是 **code**（不是 id）：下拉的数据源是产品库全集，产品库里手工新建、还没出过
 * 订单的款在识别池（`oi_styles`）里没有行，宿主按 code `ensureStyleByCode` 补占位款。
 *
 * ⚠️⚠️ **第 2 步的前提只有「点名了款」，绝不能再加"指纹非空"**（2026-10-11 用户报
 * "归类核对时设置的商品颜色还是不生效"，真库复现）：
 * `buildStyleFingerprint(category, features)` 在**品类与特征都为空时返回空串**，而真库里这两个量
 * 恰好恒空 —— 导入没提品类（23 行 `oi_order_items.category` 全空）、从没跑过 VLM（`oi_images.result_json`
 * 全 null ⇒ `features` 恒空）。原先写成 `if (named && fingerprint)` ⇒ 挂款、颜色记忆、商品ID 回流
 * **整条链一次都不执行**，而 `orderUpdate` 那一步照样写 `oi_order_items.color` 并返回 `corrected=1`，
 * 界面提示「已保存，归属 SUST-006」—— 用户看到"保存成功"，但**款色还是「未分类」**，
 * 拿货单/算钱/取图（全读 `sc.color`）一个地方都不会变。
 * 指纹在这一步只是**附加记忆**（写进 `oi_style_fingerprints`，供以后自动识别命中），
 * 宿主 `assignOrderStyle` 对它是可选的（`fingerprint?: string`）—— 没有它，这次归属照样成立。
 */
export async function saveCorrection(input: CorrectionInput): Promise<CorrectionResult> {
  const fpHint = input.features ?? [];
  const named = String(input.targetStyle ?? '').trim();
  const fingerprint =
    named || input.fieldsChanged ? buildStyleFingerprint(input.category, fpHint) : undefined;
  const reclassify = !named && input.fieldsChanged;

  const r = await need(
    ipc.orderUpdate({
      id: input.id,
      category: input.category,
      color: input.color,
      logo: input.logo,
      fingerprint,
      features: fpHint,
      reclassify,
    })
  );
  let styleCode = String(r?.styleCode ?? '');
  let skuBackfill: SkuBackfillOutcome | undefined;
  let colorAlias: ColorAliasRemembered | null = null;

  if (named) {
    const assigned = await ipc.orderStyleAssign({
      orderId: input.id,
      styleCode: named,
      color: input.color,
      fingerprint: fingerprint || undefined,
    });
    if (assigned.success && assigned.data?.styleCode) styleCode = assigned.data.styleCode;
    // ⚠️ 只读 `assigned.data`（**不是** `r`）：回流的入参是"用户点名的那个款"，
    //    而 `r` 是上一步重归类的产物，两者在"点名了款"这条路上必然是同一个款、
    //    但来源不同 —— 写混了会让"回填的是哪个商品"跟着重归类结果漂。
    skuBackfill = assigned.success ? assigned.data?.skuBackfill : undefined;
    colorAlias = assigned.success ? (assigned.data?.colorAlias ?? null) : null;
  }
  return { styleCode, skuBackfill, colorAlias };
}

/** 标记已核对（单行 / 全部）。返回实际更新行数 */
export async function markCorrected(input: number[] | { all: true }): Promise<number> {
  const r = await need(ipc.orderMarkCorrected(input));
  return Number(r?.updated ?? 0);
}

/**
 * 退回待核对：把**已核对**的行置回 `corrected = 0`，让它重新出现在待核对列表里。
 *
 * 「核对过之后发现定错了」的唯一回头路 —— `markCorrected` 是单向的（置 1 即离开列表），
 * 在它之前本页没有任何地方能把一行放回来（2026-10-11 真库现场：23 行全已核对而颜色全空，
 * 用户既看不到它们、也没法重做）。
 *
 * ⚠️ 只发 **id**：退回只翻 `corrected` 这一个位，**不重写**上一轮核对留下的款/色/logo
 *    （见宿主 `reopenOrdersCorrected`）—— 把字段一起发过去，就等于用"退回那一刻界面上的草稿"
 *    覆盖上一轮的结论，而草稿可能正是用户想改掉的东西。
 * ⚠️ 入参只有 id 数组，**没有** `{ all: true }` 形态：一次退回整批已核对的行不可逆
 *    （没有地方记着"它原来是不是核对过的"），退回一律点名。
 */
export async function reopenCorrected(ids: number[]): Promise<number> {
  const r = await need(ipc.orderReopenCorrected(ids));
  return Number(r?.updated ?? 0);
}
