// electron/pod-handlers.ts
// 「图案」模块的渲染层 IPC（语义化通道；`electron/main.ts` require 后自动生效）。
//
//   pod-worklist          待绑颜色清单（一页 24 个）+ 顶部四个汇总数；每行补本地缩略图路径
//   pod-pattern-list      图案清单（绑定台快选 / 报单页 / 余量看板共用）；每行补制版图/预览图/识别图本地路径
//   pod-pattern-create    新建图案（code 唯一，人话报错；可同时挂上识别图）
//   pod-pattern-update    改图案（只改传入字段）
//   pod-pattern-image     图片落库：本地选图 / 远程色图 → `md_images`（新建图案用，不让用户填图片 id）
//   pod-slot-images       批量把颜色图下载进图片仓，并回感知哈希/主色（界面「自动找同款」用）
//   pod-bind              一次绑一批槽位（事务；上限 200）
//   pod-unbind            解绑（重绑错图案的回退路径）
//   pod-image-link        按订单图片认图案（主路径：图 + 款色 → 图案；一张图/一个款色只能属于一个图案）
//   pod-image-unlink      取消挂图（认错了的回退路径；款色一并撤）
//   pod-pattern-merge     图案合并 N→1（搬识别图 + 颜色绑定 + 款色 + 花纸批次，可撤销）
//   pod-pattern-merge-undo 拆开一次合并（按 batchId）
//   pod-pattern-merge-history 最近的合并记录（撤销入口的列表）
//   pod-need-data         报单页 / 认图案页的全部输入（订单行 + 绑定 + 图案余量，一次取齐）
//   pod-report-export     生成并保存 `报单_YYYYMMDD.zip`（清单.xlsx + 图稿）
//   pod-batch-list        花纸批次（按图案）
//   pod-batch-create      报单建批（**不扣余量**，到货才加）
//   pod-batch-arrive      到货（幂等：点两次不会多一批货）
//   pod-print             印花扣减（FIFO 分批次，不足整批拒绝）
//   pod-adjust            盘点调整（±，留一行带符号流水）
//   pod-balance           余量看板（直读 `pod_pattern_balance`）
//
// ⚠️ 所有入参在这里再消毒一次（preload 只做形状裁剪，业务口径校验必须落在主进程 —— AGENTS §2.3 双防线）。
// 净需件/张数**不在这里算**：由渲染层 `src/lib/podNeed.ts` 算好传进来，主进程只校验与打包。

export {};

import { BrowserWindow, app, dialog, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { handle } from './ipc-util';
import {
  MAX_IMAGE_BYTES,
  findImageByFingerprint,
  findImageByUrlFingerprint,
  fingerprintUrl,
  imageLocalPath,
  imageLocalPathMap,
  landImageBytes,
} from './master-data-db';
import { landOrderImageByUrl } from './order-image-land';
import { averageRgbFromBgra, dHashFromBgra } from './podImageHash';
import {
  podAdjust,
  podBalanceRows,
  podBatchArrive,
  podBatchCreate,
  podBatchList,
  podBindSlots,
  podImageLink,
  podImageUnlink,
  podPatternCreate,
  podPatternList,
  podPatternMerge,
  podPatternMergeHistory,
  podPatternMergeUndo,
  podPatternUpdate,
  podPrint,
  podUnbindSlots,
  podWorklist,
  type PodBindSlotInput,
  type PodImageLinkItem,
} from './pod-db';
import { podNeedData } from './pod-need';
import { buildPodReportZip, type PodReportRowInput } from './pod-report';

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

// 「用户亲手选过的本地文件」白名单：与 read-file / select-image 同一份 H-02 语义。
// 本域只读用户选中的图片、不提供任意路径读取，故这一道校验必须留在主进程。
const { isUserFileAllowed } =
  require('./user-file-allowlist') as typeof import('./user-file-allowlist');

/** 图片相似度特征：dHash（构图）+ 平均主色（配色）；解码失败回空值，不拖垮整批 */
function imageMetricsOf(localPath: string): { dhash: string; r: number; g: number; b: number } {
  try {
    const img = nativeImage.createFromPath(localPath);
    if (img.isEmpty()) return { dhash: '', r: 0, g: 0, b: 0 };
    // 9×8 是 dHash 的标准输入形状；缩到 16×16 再取平均色（够稳，又不被单个像素带偏）
    const small = img.resize({ width: 9, height: 8, quality: 'good' });
    const smallSize = small.getSize();
    const dhash = dHashFromBgra(small.toBitmap(), smallSize.width, smallSize.height);
    const color = img.resize({ width: 16, height: 16, quality: 'good' });
    const colorSize = color.getSize();
    const rgb = averageRgbFromBgra(color.toBitmap(), colorSize.width, colorSize.height);
    return { dhash, ...rgb };
  } catch {
    return { dhash: '', r: 0, g: 0, b: 0 };
  }
}

handle('pod-worklist', (payload: any) => {
  const filter = ['all', 'unbound', 'bound', 'collapsed'].includes(payload?.filter)
    ? payload.filter
    : 'all';
  const pageSize = int(payload?.pageSize, 24);
  if (pageSize <= 0) throw new Error('每页条数必须大于 0');
  const out = podWorklist({
    filter,
    search: text(payload?.search, 60),
    page: Math.max(0, int(payload?.page, 0)),
    pageSize,
  });
  // 每行补 `imagePath`：界面据此走 order-image-thumb-batch 出缩略图（渲染层不直接加载外链图）。
  // 只查已落库的图，**不在这里下载** —— 下载是用户进入页面后由 `pod-slot-images` 按需做的，
  // 否则"翻一页"会变成一次 24 张图的网络等待，失败也没有可解释的位置。
  const rows = out.rows.map((r) => {
    const hit = r.imageUrl ? findImageByUrlFingerprint(fingerprintUrl(r.imageUrl)) : undefined;
    return { ...r, imagePath: hit?.localPath ?? '' };
  });
  return { ...out, rows };
});

handle('pod-pattern-list', (payload: any) => {
  const rows = podPatternList({
    search: text(payload?.search, 60),
    status: text(payload?.status, 20),
  });
  const ids: number[] = [];
  for (const p of rows) {
    if (p.artworkImageId > 0) ids.push(p.artworkImageId);
    if (p.previewImageId > 0) ids.push(p.previewImageId);
  }
  const paths = imageLocalPathMap(ids);
  return rows.map((p) => {
    // 识别图的本地路径（按**内容指纹**找回图片行；`md_images.local_path` 有自愈逻辑，
    // 所以走 `imageLocalPath(imageId)` 而不是直接读 `findImageByFingerprint().localPath`）。
    // 图案卡片要能直接显示"这个图案长什么样"，不依赖订单图是否已经下载。
    const imageLocalPaths = p.imageFingerprints.map((fp) => {
      const row = fp ? findImageByFingerprint(fp) : undefined;
      return row ? imageLocalPath(row.id) : '';
    });
    return {
      ...p,
      artworkLocalPath: paths.get(p.artworkImageId) ?? '',
      previewLocalPath: paths.get(p.previewImageId) ?? '',
      imageLocalPaths,
    };
  });
});

/** 指纹 → `md_images` 主键（挂图时顺手记下来，报单/排查都能按 id 找回原图） */
function imageIdOfFingerprint(fp: string): number {
  const row = fp ? findImageByFingerprint(fp) : undefined;
  return Number(row?.id) || 0;
}

/** preload 只做形状裁剪；指纹格式、条数上限与"图案能不能挂"由 `pod-db` 拒绝 */
function imageLinkItems(raw: unknown): PodImageLinkItem[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 200).map((i: any) => {
    const fingerprint =
      typeof i?.fingerprint === 'string' ? i.fingerprint.trim().toLowerCase().slice(0, 128) : '';
    return { fingerprint, imageId: imageIdOfFingerprint(fingerprint) };
  });
}

handle('pod-pattern-create', (payload: any) =>
  podPatternCreate({
    code: text(payload?.code, 60),
    name: text(payload?.name, 120),
    artworkImageId: int(payload?.artworkImageId),
    previewImageId: int(payload?.previewImageId),
    note: text(payload?.note, 500),
    // 新建时就把选中图片挂成识别图：用户不需要"先建图案、再回头认一遍"
    images: imageLinkItems(payload?.images),
    source: text(payload?.source, 20) || 'create',
  })
);

handle('pod-pattern-update', (payload: any) => {
  const id = int(payload?.id);
  if (id <= 0) throw new Error('缺少图案 id');
  // 只透传**出现过的键**：`undefined` = 不改，空串 = 改成空（两者必须能分开）
  const input: Parameters<typeof podPatternUpdate>[0] = { id };
  if (typeof payload?.name === 'string') input.name = text(payload.name, 120);
  if (payload?.artworkImageId !== undefined) input.artworkImageId = int(payload.artworkImageId);
  if (payload?.previewImageId !== undefined) input.previewImageId = int(payload.previewImageId);
  if (typeof payload?.note === 'string') input.note = text(payload.note, 500);
  if (typeof payload?.status === 'string') input.status = text(payload.status, 20);
  return podPatternUpdate(input);
});

/**
 * 图片落库（新建图案的"选图"路径）。
 *
 * 为什么要有这条通道：`pod_patterns` 的 `artwork_image_id` / `preview_image_id` 是 `md_images`
 * 内部主键 —— 普通用户不可能知道，也不该被要求填。界面把「用户选的本地文件」或「当前颜色图
 * 的 URL」交给这里，主进程负责落进唯一图片仓（`landImageBytes`）再回 id。
 *
 * - 本地路径**必须**是用户在对话框里亲手选过的（`isUserFileAllowed`，与 read-file 同一道）；
 * - 远程 URL 走 `landOrderImageByUrl` 的同一套下载/去重（URL 指纹 → 内容指纹），不另写一份。
 */
handle('pod-pattern-image', async (payload: any) => {
  const srcPath = text(payload?.srcPath, 1024);
  const url = text(payload?.url, 1024);
  if (srcPath) {
    if (!isUserFileAllowed(srcPath)) throw new Error('只能使用你在文件选择框里选过的图片');
    if (!fs.existsSync(srcPath)) throw new Error('这张图片已不在原来的位置');
    if (fs.statSync(srcPath).size > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB 上限');
    const landed = landImageBytes(fs.readFileSync(srcPath), { source: 'pod-pattern' });
    return {
      imageId: Number(landed.imageId) || 0,
      localPath: landed.localPath,
      fingerprint: landed.fingerprint,
      reused: landed.reused,
    };
  }
  if (url) {
    const r = await landOrderImageByUrl(url, 'pod-pattern');
    if (!r.ok || !r.image) throw new Error(r.error || '图片下载失败');
    return {
      imageId: Number(r.image.imageId) || 0,
      localPath: r.image.localPath,
      fingerprint: r.image.fingerprint,
      reused: r.image.reused,
    };
  }
  throw new Error('缺少图片来源');
});

const SLOT_IMAGE_MAX = 40;

/**
 * 批量把颜色图下载进图片仓，并回「感知哈希 + 主色」。
 *
 * 界面用它做两件事：① 把没有本地缓存的颜色图显示出来（缩略图通道只认本地文件）；
 * ② 「自动找同款」—— 渲染层拿 dhash/rgb 分组，**只出建议、不自动绑定**（认错=整批印错）。
 *
 * 单张失败不影响其余（`ok:false` 带 `error`）；同一批里重复 URL 只下载一次（渲染层按 URL 映射回行）。
 */
handle('pod-slot-images', async (payload: any) => {
  const raw = Array.isArray(payload?.urls) ? payload.urls : [];
  const urls = [
    ...new Set(
      raw.filter((u: unknown) => typeof u === 'string' && u.trim()).map((u: string) => u.trim())
    ),
  ].slice(0, SLOT_IMAGE_MAX) as string[];
  const items = [];
  for (const url of urls) {
    const r = await landOrderImageByUrl(url, 'pod-slot');
    if (!r.ok || !r.image) {
      items.push({
        url,
        ok: false,
        error: r.error || '图片下载失败',
        imageId: 0,
        localPath: '',
        fingerprint: '',
        dhash: '',
        r: 0,
        g: 0,
        b: 0,
      });
      continue;
    }
    const metrics = imageMetricsOf(r.image.localPath);
    items.push({
      url,
      ok: true,
      imageId: Number(r.image.imageId) || 0,
      localPath: r.image.localPath,
      fingerprint: r.image.fingerprint,
      dhash: metrics.dhash,
      r: metrics.r,
      g: metrics.g,
      b: metrics.b,
    });
  }
  return { items };
});

handle('pod-bind', (payload: any) => {
  const slots: PodBindSlotInput[] = (Array.isArray(payload?.slots) ? payload.slots : [])
    .slice(0, 200)
    .map((s: any) => ({
      // 键里含 `\u0000`，**不能 trim**（trim 不会去掉 NUL，但为一致性仍保持原样）
      variantKey: typeof s?.variantKey === 'string' ? s.variantKey : '',
      imageKey: text(s?.imageKey, 80),
      skuCode: text(s?.skuCode, 80),
    }));
  return podBindSlots({
    patternId: int(payload?.patternId),
    slots,
    source: text(payload?.source, 20) || 'manual',
    state: text(payload?.state, 20) || 'bound',
  });
});

handle('pod-unbind', (payload: any) => {
  const keys = (Array.isArray(payload?.keys) ? payload.keys : [])
    .filter((k: unknown) => typeof k === 'string' && k)
    .slice(0, 200) as string[];
  return podUnbindSlots(keys);
});

/**
 * 按**订单图片**认图案（认图案页的主路径）。
 *
 * 一张图只能属于一个图案（`pod_pattern_images.fingerprint` 是主键）：认到第二个图案时是
 * **改指**，回 `moved` 让界面说清楚"这 N 张原来在别的图案上，已挪过来了"。
 */
handle('pod-image-link', (payload: any) =>
  podImageLink({
    patternId: int(payload?.patternId),
    images: imageLinkItems(payload?.images),
    source: text(payload?.source, 20) || 'manual',
    // 款色与图在同一事务里写（「下次同款不用再认」的唯一依据）；主进程这里只消毒形状。
    styleColorIds: (Array.isArray(payload?.styleColorIds) ? payload.styleColorIds : [])
      .map((n: unknown) => int(n))
      .filter((n: number) => n > 0)
      .slice(0, 500),
  })
);

handle('pod-image-unlink', (payload: any) =>
  podImageUnlink(
    (Array.isArray(payload?.fingerprints) ? payload.fingerprints : [])
      .filter((f: unknown) => typeof f === 'string' && f)
      .map((f: string) => f.trim().toLowerCase().slice(0, 128))
      .slice(0, 200),
    (Array.isArray(payload?.styleColorIds) ? payload.styleColorIds : [])
      .map((n: unknown) => int(n))
      .filter((n: number) => n > 0)
      .slice(0, 500)
  )
);

handle('pod-pattern-merge', (payload: any) =>
  podPatternMerge({
    targetId: int(payload?.targetId),
    sourceIds: (Array.isArray(payload?.sourceIds) ? payload.sourceIds : [])
      .map((n: unknown) => int(n))
      .filter((n: number) => n > 0)
      .slice(0, 50),
  })
);

handle('pod-pattern-merge-undo', (payload: any) => podPatternMergeUndo(text(payload?.batchId, 64)));

handle('pod-pattern-merge-history', (payload: any) =>
  podPatternMergeHistory(int(payload?.limit, 50))
);

handle('pod-need-data', () => podNeedData());

handle('pod-batch-list', (payload: any) =>
  podBatchList({ patternId: int(payload?.patternId), limit: int(payload?.limit, 200) })
);

handle('pod-batch-create', (payload: any) =>
  podBatchCreate({
    patternId: int(payload?.patternId),
    sheets: int(payload?.sheets),
    piecesPerSheet: int(payload?.piecesPerSheet),
    supplier: text(payload?.supplier, 120),
    costCents: int(payload?.costCents),
    orderedAt: text(payload?.orderedAt, 10),
    note: text(payload?.note, 500),
    arrive: payload?.arrive === true,
  })
);

handle('pod-batch-arrive', (payload: any) => {
  const batchId = int(payload?.batchId);
  if (batchId <= 0) throw new Error('缺少批次 id');
  return podBatchArrive(batchId);
});

handle('pod-print', (payload: any) =>
  podPrint({
    patternId: int(payload?.patternId),
    pieces: int(payload?.pieces),
    refOrderItemId: int(payload?.refOrderItemId),
  })
);

handle('pod-adjust', (payload: any) =>
  podAdjust({
    batchId: int(payload?.batchId),
    deltaPieces: int(payload?.deltaPieces),
    note: text(payload?.note, 200),
  })
);

handle('pod-balance', () => podBalanceRows());

/**
 * 报单导出：`报单_YYYYMMDD.zip`。
 *
 * 行数据由渲染层算好（净需件／张数），这里只做**形状 + 值域**校验：
 * 缺图稿的行照旧留在清单里（标红），`missingArtwork` 回给界面 —— 缺图不阻断导出（阻断只会让人绕过系统）。
 * 取消保存不算失败（抛 `__canceled__`，与 `ledger-export-excel` 同口径）。
 */
handle('pod-report-export', async (payload: any) => {
  const rows: PodReportRowInput[] = (Array.isArray(payload?.rows) ? payload.rows : [])
    .slice(0, 500)
    .map((r: any) => ({
      patternId: int(r?.patternId),
      code: text(r?.code, 60),
      name: text(r?.name, 120),
      artworkImageId: int(r?.artworkImageId),
      previewImageId: int(r?.previewImageId),
      needPieces: Math.max(0, int(r?.needPieces)),
      remainingPieces: Math.max(0, int(r?.remainingPieces)),
      netNeed: Math.max(0, int(r?.netNeed)),
      sheets: Math.max(0, int(r?.sheets)),
    }))
    .filter((r: PodReportRowInput) => r.netNeed > 0);
  if (!rows.length) throw new Error('没有需要报单的图案（余量都够，不用报）');

  const date = text(payload?.date, 10);
  const out = await buildPodReportZip({
    rows,
    date,
    piecesPerSheet: int(payload?.piecesPerSheet, 1),
    unboundPieces: int(payload?.unboundPieces),
    unboundRows: int(payload?.unboundRows),
    assumedRows: int(payload?.assumedRows),
  });

  const safeDate = (
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10)
  ).replace(/-/g, '');
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const dialogOpts = {
    title: '导出花纸报单',
    defaultPath: path.join(app.getPath('documents'), `报单_${safeDate}.zip`),
    filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
  };
  const result = win
    ? await dialog.showSaveDialog(win, dialogOpts)
    : await dialog.showSaveDialog(dialogOpts);
  if (result.canceled || !result.filePath) throw new Error('__canceled__');
  fs.writeFileSync(result.filePath, out.zip);
  return {
    filePath: result.filePath,
    rows: out.rows,
    images: out.images,
    missingArtwork: out.missingArtwork,
    warnings: out.warnings,
  };
});
