// 「归类核对」域在渲染层的**薄封装**：把宿主的 `order*` 通道收成带类型的函数，
// 再加两件事 —— 读识别引擎（配置 + 密钥）、跑一次单图识别。
//
// ⚠️ **本文件不含任何业务算法**：指纹算 `@/lib/styleMatcher`、品类/颜色归一算
//    `@/lib/orderClassifier`（与导入/产品库同一份实现）。指纹只有同源，"识别出来的款"与
//    "人工核对的款"才会落到同一个款编码上（两处各写一套必然同款拆成两款，见该文件的注释）。
//
// 为什么不用 `src/core/services/ipc.ts` 的导出：那里 `order*` 主要挂在 `ipc` 实例上，
// 这里补齐后调用点读起来是 `listPending()` 而不是 `ipc.orderList({...})`，且失败一律抛错
// （`success:false` 的 error 文案比"静默空列表"有用 —— 空列表会被读成"没有待核对的单"）。

import {
  createVisionEngine,
  type RecognitionResult,
  type VisionEngine,
  type VisionEngineConfig,
} from '@/core/ai';
import { ipc, type ApiResult } from '@/core/services/ipc';
import { useModuleStorage } from '@/core/services/storage';
import { classifyResult } from '@/lib/orderClassifier';
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import type { OrderRecord, StyleRecord } from '@/types';

/** 取单个值：失败抛错 */
async function need<T>(p: Promise<ApiResult<T>>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

// ─────────────────────────────────────────────────────────── 识别引擎

/**
 * 与「设置 › 识别」(`src/core/settings/RecognitionSettings.vue`) **同一命名空间同一键** —— 两边可互通。
 *
 * ⚠️ 名字沿用 `order-insight`（原岛 id）是**有意保留**：这是 electron-store 里已落盘的
 * **用户数据键**（引擎配置 + `imageColumn` 等列名）。岛已于 2026-10-05 整体下架，但键不能跟着改名 ——
 * 改名的唯一效果是"用户配好的 Key 与列映射静默消失"。**命名空间名 ≠ 模块是否存在。**
 */
const ENGINE_NS = 'order-insight';

/** 兜底默认（设置页里删过字段时用；与设置页的 DEFAULT_ENGINE 同值） */
const DEFAULT_ENGINE: Omit<VisionEngineConfig, 'apiKey'> = {
  provider: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  temperature: 0.1,
};

export interface EngineReadiness {
  engine: VisionEngine | null;
  /** `engine` 为 null 时**直接给用户看**的原因（别让它跑到一半才报错） */
  reason: string;
}

/**
 * 读识别引擎（引擎配置 + 加密存储里的密钥）。
 *
 * 没有密钥时**不造引擎**、把原因说清楚：批量识别是几十秒起步的动作，
 * 让它先跑起来再逐行失败，不如在点按钮的那一刻就拦住并给出入口。
 */
export async function readEngine(): Promise<EngineReadiness> {
  const storage = useModuleStorage<{ engine?: Partial<VisionEngineConfig> }>(ENGINE_NS);
  const cfg = await storage.load();
  const saved = cfg?.engine && typeof cfg.engine === 'object' ? cfg.engine : {};
  const merged = { ...DEFAULT_ENGINE, ...saved };
  delete (merged as { apiKey?: string }).apiKey; // 老版本曾把空 key 一起落盘，读出口径统一清掉
  const keyRes = await ipc.orderApiKeyGet();
  const apiKey = keyRes.success && keyRes.data ? String(keyRes.data.apiKey || '') : '';
  if (!apiKey) {
    return { engine: null, reason: '还没配视觉识别引擎的 API Key —— 去「设置 → 识别」填好保存再回来' };
  }
  return { engine: createVisionEngine({ ...merged, apiKey }), reason: '' };
}

// ─────────────────────────────────────────────────────────── 取数

/** 一页多少行（主进程 `orderList` 上限 2000，但核对是逐行看的，一屏 30~50 行够用） */
export const PAGE_SIZE = 30;

export interface PendingPage {
  rows: OrderRecord[];
  total: number;
}

/** 待核对订单（`corrected=false`），关键字下沉到主进程 LIKE */
export async function listPending(opts: {
  offset?: number;
  limit?: number;
  search?: string;
} = {}): Promise<PendingPage> {
  const r = await ipc.orderList({
    offset: 0,
    limit: PAGE_SIZE,
    corrected: false,
    ...opts,
  });
  if (!r.success) throw new Error(r.error || '读取待核对订单失败');
  return { rows: r.data?.rows ?? [], total: Number(r.data?.total ?? 0) };
}

/** 识别库（款编码列表）—— 行内"归属款"下拉的数据源 */
export async function listStyles(): Promise<StyleRecord[]> {
  const r = await ipc.orderStyleList();
  if (!r.success) throw new Error(r.error || '读取识别库失败');
  return r.data ?? [];
}

/** 待核对 + 其中**还没有归属款**的行数（页头指标用；独立查一次是为了不受分页影响） */
export async function pendingCounts(): Promise<{ pending: number; unclassified: number; styles: number }> {
  const [pending, unclassified, styles] = await Promise.all([
    ipc.orderList({ limit: 1, corrected: false }),
    ipc.orderList({ limit: 2000 }),
    ipc.orderStyleList(),
  ]);
  const un = unclassified.success ? (unclassified.data?.rows ?? []) : [];
  return {
    pending: pending.success ? Number(pending.data?.total ?? 0) : 0,
    unclassified: un.filter((o) => !o.styleCode).length,
    styles: styles.success ? (styles.data ?? []).length : 0,
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
  /** 用户在下拉里**显式点名**的目标款 id；0 = 自动匹配当前归属 */
  targetStyleId: number;
  /** 品类/颜色是否相对当前值有变（决定要不要 reclassify） */
  fieldsChanged: boolean;
}

/**
 * 保存一行核对结果，返回本次归属的款编码（空串 = 没归到任何款）。
 *
 * 与 `order-db.updateOrder` 的配合顺序**不可颠倒**（两条宿主通道）：
 *   1. `orderUpdate({ ..., reclassify })` —— 宿主按 `fingerprint + features` 重算归属款/款色。
 *      ⚠️ 重归类分支的条件是 `input.reclassify && input.fingerprint`，**必须带指纹**；
 *         只传 `reclassify` 而不传指纹是个**静默空操作**（旧版岛里就漏传过）。
 *   2. `orderStyleAssign` —— 仅当用户显式选了款、且与当前归属不同；把订单图挂到目标款并把
 *      指纹记入该款，使**后续自动识别**命中同一款编码。
 */
export async function saveCorrection(input: CorrectionInput): Promise<{ styleCode: string }> {
  const fpHint = input.features ?? [];
  const fingerprint =
    input.targetStyleId > 0 || input.fieldsChanged
      ? buildStyleFingerprint(input.category, fpHint)
      : undefined;
  const reclassify = input.targetStyleId === 0 && input.fieldsChanged;

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

  if (input.targetStyleId > 0 && fingerprint) {
    const assigned = await ipc.orderStyleAssign({
      orderId: input.id,
      styleId: input.targetStyleId,
      color: input.color,
      fingerprint,
    });
    if (assigned.success && assigned.data?.styleCode) styleCode = assigned.data.styleCode;
  }
  return { styleCode };
}

/** 标记已核对（单行 / 全部）。返回实际更新行数 */
export async function markCorrected(input: number[] | { all: true }): Promise<number> {
  const r = await need(ipc.orderMarkCorrected(input));
  return Number(r?.updated ?? 0);
}

// ─────────────────────────────────────────────────────────── 识别一张图

export interface RecognizeOutcome {
  category: string;
  color: string;
  styleCode: string;
}

/**
 * **识别一条订单的图并就地归类**（批量识别的单步）。
 *
 * 三步一条链，顺序不能反：
 *   ① 读图（`orderReadImage`，走图片缓存目录白名单）→ dataUrl；
 *   ② 引擎识别 → 归一化（与导入/产品库**同一份** `classifyResult`）+ 同源指纹；
 *   ③ 落库：`orderUpdate(reclassify)` 建/挂款，并把识别结果回写图片
 *      （`orderImageSave` —— 下次同 URL 的图直接复用该结论，不必再花一次模型调用）。
 *
 * 无图订单（`imageId` 为 0）直接跳过：识别链路只对有图的订单有意义，
 * 这类订单只能靠「商品ID 映射」或人工指定款。
 */
export async function recognizeOrder(order: OrderRecord, engine: VisionEngine): Promise<RecognizeOutcome> {
  const id = Number(order.id ?? 0);
  const localPath = String(order.localPath ?? '');
  if (!id || !localPath) throw new Error('这条订单没有主图，跳过');
  const img = await need(ipc.orderReadImage(localPath));
  const recv: RecognitionResult = await engine.analyze(img.dataUrl);
  const norm = classifyResult({
    category: String(recv.category ?? ''),
    color: String(recv.color ?? ''),
    logo: String(recv.logo ?? ''),
    styleName: String(recv.styleName ?? ''),
  });
  const features = Array.isArray(recv.features)
    ? recv.features.map((f) => String(f ?? '').trim()).filter(Boolean)
    : [];
  const fingerprint = buildStyleFingerprint(norm.category, features);
  if (!fingerprint) throw new Error('识别结果为空（品类与特征都没出来），已跳过');

  const r = await need(
    ipc.orderUpdate({
      id,
      category: norm.category,
      color: norm.color,
      logo: norm.logo,
      fingerprint,
      features,
      reclassify: true,
      styleName: norm.styleName || undefined,
    })
  );
  // 回写识别结论（失败不影响归类结果：只是下次要重新识别一次）
  if (order.imageId) {
    await ipc
      .orderImageSave({ id: Number(order.imageId), status: 'done', resultJson: JSON.stringify(recv) })
      .catch(() => undefined);
  }
  return { category: norm.category, color: norm.color, styleCode: String(r?.styleCode ?? '') };
}
