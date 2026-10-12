// src/lib/pickingSheet.ts
// 「复制给厂家」的**发厂清单图片**：把一家厂的待拿行合成一张 PNG，粘贴给厂家照着备货。
//
// 为什么不做"截屏"：截屏会把页签、按钮、别的厂家的货一起发出去，还随窗口大小变形 ——
// 而这张图是一条**对外**的凭据（对方照着它备货、报价）。所以它自绘：只有"货"这件事本身。
//
// 分层与 `pickingExport` 同一规矩：**模型是纯函数**（`sheetModelOf`，被 vitest 直接覆盖），
// 画布渲染是浏览器实现（`renderSheetPng`，由无头冒烟在真实 Chrome 里跑）。
// 数字一律取自 `picking.ts` 的既有口径（`pendingOf` / `groupByColor` / `pendingRollup` /
// `sizeQtyBadge`）—— 这张图与屏上、xlsx 三处各算一次，就会出现"发出去的图与表里的数不一样"
// 这种没人查得出的悬案。
//
// 金额展示口径（`money` / `amountText` / `noPriceNote`）也住在本文件、由界面 import ——
// 图与屏上必须是同一套字面：`¥0.00` 与"不知道多少钱"是两件事，这条纪律只留一个实现。

import { groupByColor, pendingOf, pendingRollup, type PickingGroup } from './picking';
import { sizeQtyBadge } from './pickingExport';

/** 金额展示：两位小数（**不写 ¥ 前缀** —— 单位由调用方写在别处，重复缀符号会挤掉数字宽度） */
export function money(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

/**
 * 「合计金额」怎么显示 —— 与 `noPriceNote` 是一对，凡是并列展示金额的地方都走这两个函数。
 * ⚠️ 一件价都没查到（缺价件数 ≥ 总件数）时**不写 `¥0.00`**：0 有两种含义
 * （"真的不要钱" / "没查到价"），写 0 会让"估算偏低"和"真的很便宜"长得一模一样。
 */
export function amountText(amount: number, noPricePieces: number, pieces: number): string {
  if (noPricePieces > 0 && noPricePieces >= pieces) return '—';
  return `¥${money(amount)}`;
}

/** 与 `amountText` 配套的说明文字：只有**部分**缺价才叫"不含"，全缺时说的是"全部" */
export function noPriceNote(noPricePieces: number, pieces: number): string {
  if (noPricePieces <= 0) return '';
  return noPricePieces >= pieces
    ? `（${noPricePieces} 件全部无进价）`
    : `（不含 ${noPricePieces} 件无进价）`;
}

/** 发厂清单图的一行（款色粒度，与卡片同一层折叠） */
export interface SheetLine {
  /** 款色键，如 `S1 · 黑` */
  key: string;
  styleName: string;
  /** 本地图片路径（渲染时由 `imageOf` 换成 dataUrl —— 模型不持有图片字节） */
  localPath: string;
  /** 「L×2  XL×1」= 各码**还要拿**的件数（`sizeQtyBadge` 与 xlsx 烧进图的角标同一实现） */
  sizesText: string;
  /** 这一行还要拿的件数合计（= Σ 各码还差） */
  pieces: number;
  /** 进价文字：`¥10.00` / `—`（无价不写 0） */
  unitPriceText: string;
  /** 小计文字：`≈¥20.00` / `—`；只含**有价**的还差件（整体缺价在 `footer` 里说） */
  amountText: string;
}

export interface SheetModel {
  /** 标题：`拿货单 · 厂A · 2026-10-10` */
  title: string;
  lines: SheetLine[];
  /** 合计行：`共 2 款色 · 3 件 · 预估 ¥20.00（不含 1 件无进价）` */
  footer: string;
}

/**
 * 把（全量或某厂家的）拣货项折成"发这一家厂的清单图"模型；没有待拿的行 → `null`
 * （调用方据此提示"没有要拿的货"，而不是发一张空图出去）。
 *
 * 口径 = **待拿**（还差 > 0 且未忽略）—— 与「生成拿货单（N 件）」**同一条判据**（`pendingOf`）：
 * 已拿完/已忽略的货发过去，厂家会照着多备货。
 */
export function sheetModelOf(
  groups: PickingGroup[] | null | undefined,
  meta: { supplierId: number; supplierName: string; date: string },
): SheetModel | null {
  const rows = groupByColor(pendingOf(groups, meta.supplierId));
  if (!rows.length) return null;
  const t = pendingRollup(rows);
  const lines: SheetLine[] = rows.map((r) => ({
    key: r.key,
    styleName: r.styleName,
    localPath: r.imagePath,
    sizesText: r.sizes
      .filter((s) => s.remaining > 0)
      .map((s) => sizeQtyBadge(s.size, s.remaining))
      .join('  '),
    pieces: r.remaining,
    unitPriceText: r.unitPrice === null ? '—' : `¥${money(r.unitPrice)}`,
    // 整行无价写 `—`（不写 `≈¥0.00`）；部分无价的小计只含有价件 —— 屏上、xlsx 同一条纪律
    amountText: r.pendingNoPricePieces >= r.remaining ? '—' : `≈¥${money(r.pendingAmount)}`,
  }));
  return {
    title: `拿货单 · ${meta.supplierName || '未指定厂家'} · ${meta.date}`,
    lines,
    footer: `共 ${t.colors} 款色 · ${t.pieces} 件 · 预估 ${amountText(t.amount, t.noPricePieces, t.pieces)}${noPriceNote(t.noPricePieces, t.pieces)}`,
  };
}

// ─────────────────────────────── 画布渲染（浏览器实现） ───────────────────────────────
// 配色是**画布像素**（不参与主题切换，见 AGENTS §1.6 的"非 UI 像素"条款）：
// 这张图要**离开应用**去别的软件里显示（微信/打印），跟随宿主深色主题反而会在对方那里失真。

const SHEET_FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
/** 图宽（CSS px；实际画布按 2 倍渲染，粘到微信里清晰） */
const SHEET_W = 760;
const SHEET_PAD = 24;
const SHEET_HEAD = 92;
const SHEET_ROW = 104;
const SHEET_FOOT = 68;
const SHEET_IMG = 80;

/** dataUrl → 已解码的图（`null` = 解码失败） */
function loadImageEl(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 画一行的缩略图（cover 裁切；取不到就画「缺图」占位 —— 少一张图不该让整张图失败） */
async function drawSheetImage(
  ctx: CanvasRenderingContext2D,
  dataUrl: string,
  x: number,
  y: number,
): Promise<void> {
  const img = dataUrl ? await loadImageEl(dataUrl) : null;
  if (!img) {
    ctx.fillStyle = '#f3f3f3';
    ctx.fillRect(x, y, SHEET_IMG, SHEET_IMG);
    ctx.fillStyle = '#aaaaaa';
    ctx.font = `12px ${SHEET_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('缺图', x + SHEET_IMG / 2, y + SHEET_IMG / 2);
    ctx.textAlign = 'left';
    return;
  }
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const scale = Math.max(SHEET_IMG / iw, SHEET_IMG / ih);
  const sw = SHEET_IMG / scale;
  const sh = SHEET_IMG / scale;
  // JPEG 无透明通道：透明区直接画上去会变黑，先铺白（同 `domToJpeg`）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, SHEET_IMG, SHEET_IMG);
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, SHEET_IMG, SHEET_IMG);
}

/**
 * 把模型画成一张 PNG（dataURL）。**永不 reject**：画布不可用 / 编码失败返回 `null`
 * （调用方按"复制失败"提示，不静默）。
 */
export async function renderSheetPng(
  model: SheetModel,
  imageOf: (localPath: string) => string,
): Promise<string | null> {
  try {
    const scale = 2;
    const H = SHEET_HEAD + model.lines.length * SHEET_ROW + SHEET_FOOT;
    const c = document.createElement('canvas');
    c.width = SHEET_W * scale;
    c.height = H * scale;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.textBaseline = 'middle';

    // 白底（这张图要发给别人，不做深色适配）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SHEET_W, H);

    // 标题 + 一句用途说明（"单价是预估"要先说 —— 对方拿它报价时才不会把预估当实付）
    ctx.fillStyle = '#111111';
    ctx.font = `600 22px ${SHEET_FONT}`;
    ctx.fillText(model.title, SHEET_PAD, 44);
    ctx.fillStyle = '#888888';
    ctx.font = `12px ${SHEET_FONT}`;
    ctx.fillText('按此清单备货；单价为预估进价，以实际结算为准', SHEET_PAD, 72);

    let y = SHEET_HEAD;
    for (const ln of model.lines) {
      ctx.strokeStyle = '#eeeeee';
      ctx.beginPath();
      ctx.moveTo(SHEET_PAD, y + 0.5);
      ctx.lineTo(SHEET_W - SHEET_PAD, y + 0.5);
      ctx.stroke();

      await drawSheetImage(ctx, imageOf(ln.localPath), SHEET_PAD, y + (SHEET_ROW - SHEET_IMG) / 2);

      // 左：款色（主） + 款名/尺码（次）
      ctx.fillStyle = '#111111';
      ctx.font = `600 16px ${SHEET_FONT}`;
      ctx.fillText(ln.key, SHEET_PAD + SHEET_IMG + 16, y + 34);
      ctx.fillStyle = '#444444';
      ctx.font = `14px ${SHEET_FONT}`;
      ctx.fillText(
        [ln.styleName, ln.sizesText].filter(Boolean).join(' · '),
        SHEET_PAD + SHEET_IMG + 16,
        y + 64,
      );

      // 右：小计（主） + 件数/单价（次）—— 右对齐在留白侧，扫一眼就能对到行
      ctx.textAlign = 'right';
      ctx.fillStyle = '#111111';
      ctx.font = `600 16px ${SHEET_FONT}`;
      ctx.fillText(ln.amountText, SHEET_W - SHEET_PAD, y + 34);
      ctx.fillStyle = '#888888';
      ctx.font = `12px ${SHEET_FONT}`;
      ctx.fillText(`${ln.pieces} 件 · ${ln.unitPriceText}/件`, SHEET_W - SHEET_PAD, y + 64);
      ctx.textAlign = 'left';

      y += SHEET_ROW;
    }

    ctx.strokeStyle = '#dddddd';
    ctx.beginPath();
    ctx.moveTo(SHEET_PAD, y + 0.5);
    ctx.lineTo(SHEET_W - SHEET_PAD, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#333333';
    ctx.font = `600 14px ${SHEET_FONT}`;
    ctx.fillText(model.footer, SHEET_PAD, y + SHEET_FOOT / 2);

    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}
