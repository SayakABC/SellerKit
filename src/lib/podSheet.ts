// src/lib/podSheet.ts
// 「订花纸」清单的**可复制模型**：把这次要补的图案折成「一张图 + 一个数量」，
// 复制成图片（发给花纸厂）或纯文字（存备忘录 / 转发）。
//
// 为什么要有它（2026-11-02 用户口径「可以直接复制出今天所需的花纸图片和数量」）：
//   花纸厂每天要的是**图和数量**，不是一张带单价与合计的表格。用户在微信里发过去的
//   东西必须一眼能对上"哪个花、几张"——所以模型只有这两件事，其余（还剩多少 / 净需件）
//   只作为**可核对的旁注**附在同一行，不另起一列。
//
// 分层照 `pickingSheet.ts`：**模型是纯函数**（`podSheetModelOf` / `podSheetTextOf`，
// 由 vitest 直接覆盖），画布渲染是浏览器实现（`renderPodSheetPng`，永不 reject）。
//
// ⚠️ 数字一律取自 `podNeed.ts` 的 `PodNeedRow`（`netNeed` / `sheets` 已经按"余量扣减 +
//    每张件数"算好了）。这里**不许再算一遍** —— 屏上、复制出去的图、纯文字、导出 zip
//    四处各算一次，就会出现"发出去的张数与页面上不一样"这种没人查得出的悬案。

import type { PodNeedRow } from './podNeed';
import type { PodPatternRow } from '@/types';

/** 清单图的一行（= 一个图案） */
export interface PodSheetLine {
  patternId: number;
  code: string;
  name: string;
  /** 图稿本地路径（制版图优先；空 = 这张图在本地找不到，画「缺图」占位） */
  localPath: string;
  /** 要印件数（待发货里绑到这个图案的件数） */
  needPieces: number;
  /** 手上还剩多少件 */
  remainingPieces: number;
  /** 这次要补多少件（= 净需件） */
  netNeed: number;
  /** 要订几张 */
  sheets: number;
  /** 缺制版图（花纸厂不能直接拿它制版；仍进清单，但要在图上标出来） */
  missingArtwork: boolean;
}

export interface PodSheetModel {
  /** 标题行：`订花纸 · 2026-11-02` */
  title: string;
  /** 副标题：`每张印 1 件 · 共 3 个图案` */
  subtitle: string;
  lines: PodSheetLine[];
  totalSheets: number;
  totalPieces: number;
  /** 合计行：`共 3 个图案 · 12 件 · 要订 12 张` */
  footer: string;
  /** 缺制版图的图案编码（空 = 齐） */
  missingArtwork: string[];
}

/**
 * 图案的"对外那张图"：制版图优先（花纸厂照着它制版），其次预览图，最后识别图。
 * 三张都没有 = 空串（画「缺图」占位，不静默跳过这一行）。
 */
function imagePathOf(p: PodPatternRow | undefined): string {
  if (!p) return '';
  return p.artworkLocalPath || p.previewLocalPath || (p.imageLocalPaths?.[0] ?? '') || '';
}

/**
 * 把「要补 > 0」的行折成清单模型；没有要补的行 → `null`
 * （调用方据此提示"这次不用订"，而不是复制一张空图出去）。
 *
 * `rows` 来自 `podNeedReport`，**只有净需件 > 0 的行** —— 这里不再筛一遍，
 * 否则两处筛选条件一漂开，就会出现"屏上 3 行、复制出去 2 行"。
 */
export function podSheetModelOf(
  rows: readonly PodNeedRow[] | null | undefined,
  patterns: readonly PodPatternRow[] | null | undefined,
  meta: {
    date: string;
    piecesPerSheet: number;
    /** 还没认图案的件数（> 0 时这份清单必然偏少，必须写在图上） */
    unboundPieces?: number;
    /** 还没认图案的订单行数 */
    unboundRows?: number;
  }
): PodSheetModel | null {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const byId = new Map<number, PodPatternRow>();
  for (const p of Array.isArray(patterns) ? patterns : []) byId.set(p.id, p);
  const per = Math.max(1, Math.round(Number(meta?.piecesPerSheet) || 1));

  const lines: PodSheetLine[] = list.map((r) => {
    const p = byId.get(r.patternId);
    return {
      patternId: r.patternId,
      code: r.code,
      name: r.name,
      localPath: imagePathOf(p),
      needPieces: r.needPieces,
      remainingPieces: r.remainingPieces,
      netNeed: r.netNeed,
      sheets: r.sheets,
      missingArtwork: r.artworkImageId <= 0,
    };
  });

  const totalSheets = lines.reduce((n, l) => n + l.sheets, 0);
  const totalPieces = lines.reduce((n, l) => n + l.netNeed, 0);
  const missingArtwork = lines.filter((l) => l.missingArtwork).map((l) => l.code);
  const unboundPieces = Math.max(0, Math.round(Number(meta?.unboundPieces) || 0));
  const unboundRows = Math.max(0, Math.round(Number(meta?.unboundRows) || 0));

  const tail = unboundPieces
    ? `（还没认图案的 ${unboundPieces} 件${unboundRows ? ` / ${unboundRows} 行` : ''}没算进来）`
    : '';
  return {
    title: `订花纸 · ${meta?.date ?? ''}`.trim(),
    subtitle: `每张印 ${per} 件 · 共 ${lines.length} 个图案${tail}`,
    lines,
    totalSheets,
    totalPieces,
    footer: `共 ${lines.length} 个图案 · 补 ${totalPieces} 件 · 要订 ${totalSheets} 张`,
    missingArtwork,
  };
}

/**
 * 模型 → 纯文字（「复制文字清单」）。
 *
 * 一行一个图案，格式固定成「编号 名字：要订 N 张（补 N 件，还剩 N 件）」——
 * 粘进微信后对方从上往下读就是备货顺序，不需要表格。
 * ⚠️ 缺制版图的行**明确写「缺制版图」**：不写的话花纸厂会去制版，然后打回来问图在哪。
 */
export function podSheetTextOf(model: PodSheetModel): string {
  const out = [model.title, model.subtitle];
  for (const l of model.lines) {
    const name = l.name ? ` ${l.name}` : '';
    const art = l.missingArtwork ? '（缺制版图）' : '';
    out.push(
      `${l.code}${name}：要订 ${l.sheets} 张（补 ${l.netNeed} 件，还剩 ${l.remainingPieces} 件）${art}`
    );
  }
  out.push(model.footer);
  return out.join('\n');
}

// ─────────────────────────────── 画布渲染（浏览器实现） ───────────────────────────────
// 配色是**画布像素**（不参与主题切换）：这张图要离开应用去微信里显示，
// 跟随宿主深色主题反而会在对方那里失真（同 `pickingSheet.ts` 的说明）。

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const W = 640;
const PAD = 22;
const HEAD = 84;
const ROW = 96;
const FOOT = 56;
const IMG = 76;

function loadImageEl(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 画一行的缩略图（cover 裁切；取不到就画「缺图」占位 —— 少一张图不该让整张图失败） */
async function drawRowImage(
  ctx: CanvasRenderingContext2D,
  dataUrl: string,
  x: number,
  y: number,
  label: string
): Promise<void> {
  const img = dataUrl ? await loadImageEl(dataUrl) : null;
  if (!img) {
    ctx.fillStyle = '#f3f3f3';
    ctx.fillRect(x, y, IMG, IMG);
    ctx.fillStyle = '#aaaaaa';
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(label || '缺图', x + IMG / 2, y + IMG / 2);
    ctx.textAlign = 'left';
    return;
  }
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const scale = Math.max(IMG / iw, IMG / ih);
  const sw = IMG / scale;
  const sh = IMG / scale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, IMG, IMG);
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, IMG, IMG);
}

/**
 * 把模型画成一张 PNG（dataURL）。**永不 reject**：画布不可用 / 编码失败返回 `null`
 * （调用方按"复制失败"提示，不静默）。
 */
export async function renderPodSheetPng(
  model: PodSheetModel,
  imageOf: (localPath: string) => string
): Promise<string | null> {
  try {
    const scale = 2;
    const H = HEAD + model.lines.length * ROW + FOOT;
    const c = document.createElement('canvas');
    c.width = W * scale;
    c.height = H * scale;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';

    // 白底（这张图要发给别人，不做深色适配）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#111111';
    ctx.font = `600 21px ${FONT}`;
    ctx.fillText(model.title, PAD, 40);
    ctx.fillStyle = '#888888';
    ctx.font = `12px ${FONT}`;
    ctx.fillText(model.subtitle, PAD, 66);

    let y = HEAD;
    for (const ln of model.lines) {
      ctx.strokeStyle = '#eeeeee';
      ctx.beginPath();
      ctx.moveTo(PAD, y + 0.5);
      ctx.lineTo(W - PAD, y + 0.5);
      ctx.stroke();

      await drawRowImage(
        ctx,
        imageOf(ln.localPath),
        PAD,
        y + (ROW - IMG) / 2,
        ln.missingArtwork ? '缺制版图' : ''
      );

      // 左：编号 + 名字（主）+ 数量（次，图上最要紧的就是它）
      ctx.fillStyle = '#111111';
      ctx.font = `600 15px ${FONT}`;
      ctx.fillText(`${ln.code}${ln.name ? ` ${ln.name}` : ''}`, PAD + IMG + 14, y + 30);
      ctx.fillStyle = '#333333';
      ctx.font = `600 15px ${FONT}`;
      ctx.fillText(`要订 ${ln.sheets} 张`, PAD + IMG + 14, y + 56);
      ctx.fillStyle = '#888888';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(
        `补 ${ln.netNeed} 件 · 还剩 ${ln.remainingPieces} 件${ln.missingArtwork ? ' · 缺制版图' : ''}`,
        PAD + IMG + 14,
        y + 76
      );

      // 右：张数再放大一遍（厂家扫一眼就要看到"几张"）
      ctx.textAlign = 'right';
      ctx.fillStyle = '#111111';
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(`${ln.sheets}`, W - PAD, y + 40);
      ctx.fillStyle = '#888888';
      ctx.font = `12px ${FONT}`;
      ctx.fillText('张', W - PAD, y + 62);
      ctx.textAlign = 'left';

      y += ROW;
    }

    ctx.strokeStyle = '#dddddd';
    ctx.beginPath();
    ctx.moveTo(PAD, y + 0.5);
    ctx.lineTo(W - PAD, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#333333';
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(model.footer, PAD, y + FOOT / 2);

    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}
