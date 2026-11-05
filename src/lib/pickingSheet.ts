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
//
// ⚠️ 两种出口**故意不同口径**（2026-11-02 用户要求）：**文字清单**给自家留存/转发，含款名与金额；
//    **图**发出去给对方照着备货，只画"要拿什么"（无款名 / 无预估金额 / 无厂家名）——
//    见 `sheetImageModelOf` 的头注。

import { groupByColor, pendingOf, pendingRollup, type PickingGroup } from './picking';
import { sizeQtyBadge } from './pickingExport';

/** 金额展示：两位小数（**不写 ¥ 前缀** —— 单位由调用方写在别处，重复缀符号会挤掉数字宽度） */
export function money(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

/**
 * 分 → 两位小数（拿货单的金额按**分**存：`PurchaseOrder.totalCents`）。
 *
 * 与 `money` 的分工：那个吃**元**（拣货清单口径：进价 × 件数累加出来的是元），这个吃**分**
 * （单据口径：单子落库就是分）。两个单位域不同源，混用会出现「¥50000.00」这种把分当成元的错 ——
 * 2026-10-17 合并视图实测踩到（灰条与"已开单"行两处），故单列一个函数并各自注释单位。
 */
export function centsMoney(cents: unknown): string {
  const n = Number(cents);
  return ((Number.isFinite(n) ? n : 0) / 100).toFixed(2);
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
  /** 款色键，如 `S1 · 黑`（**内部身份/排序用**；对外文案一律走 `label` —— 款编码不外发） */
  key: string;
  /** 对外展示名：`款名 · 颜色`（缺款名只写颜色；两者都缺 = 未识别款）。款编码**不进**这里 */
  label: string;
  styleName: string;
  /** 颜色（图上与款名并排；缺名时它已在 label 里） */
  color: string;
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
  /** 单据日期（文字清单的标题里已含；图要单独一行，见 `sheetImageModelOf`） */
  date: string;
  lines: SheetLine[];
  /** 合计行：`共 2 款色 · 3 件 · 预估 ¥20.00（不含 1 件无进价）` */
  footer: string;
  /** 合计的两个**数**（与 `footer` 同源 `pendingRollup`；图上的落款只要这两个数，不要金额） */
  totals: { colors: number; pieces: number };
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
    label: [r.styleName, r.color].filter(Boolean).join(' · ') || '未识别款',
    styleName: r.styleName,
    color: r.color,
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
    date: meta.date,
    lines,
    footer: `共 ${t.colors} 款色 · ${t.pieces} 件 · 预估 ${amountText(t.amount, t.noPricePieces, t.pieces)}${noPriceNote(t.noPricePieces, t.pieces)}`,
    totals: { colors: t.colors, pieces: t.pieces },
  };
}

/**
 * 把发厂清单模型转成**纯文本**（「复制拿货清单」→ 粘进微信直接发给厂家）。
 *
 * 为什么图之外还要一份文字（2026-10-17 合并视图）：清单图信息全，但微信里对方常要
 * **复制文字转发 / 存备忘录**；纯文字粘过去不丢结构（一行一款色），格式：
 * 厂家名 + 日期（标题行）→ 每行「款名 · 颜色：尺码×件数 · 合计件数」→ 合计行。
 * 数字一律来自 `sheetModelOf`（与屏上、清单图、xlsx 同一个模型）—— 再算一遍就会出现
 * "复制出去的数与屏幕上不一样"这种查不出的悬案。
 */
export function sheetTextOf(model: SheetModel): string {
  const out = [model.title];
  for (const l of model.lines) {
    out.push(`${l.label}：${l.sizesText} · ${l.pieces} 件`);
  }
  out.push(model.footer);
  return out.join('\n');
}

// ───────────────────────────── 图上画什么（对外口径，与文字清单**故意不同**） ─────────────────────────────
//
// 2026-11-02 用户要求（原话）：「复制出来的拿货单图片重新设计，不显示款名、预估金额、供应商」。
// 于是图与文字清单**分成两个模型**：`sheetTextOf` 照旧（自家留存/转发，含款名与金额），
// 图只画"要把什么货拿回来"。
//
// 撤掉三样的代价必须自己补回来，否则这张图就不可核对了：
//   · 撤款名 ⇒ 一行只剩「图 + 颜色」，对方点名只能靠**行号** ⇒ 图上加序号（1、2、3…）；
//   · 撤金额 ⇒ 右侧那一列空出来 ⇒ 让给**件数大字**（点货时最常扫的就是它，原先被金额挤在次行）；
//   · 撤厂家 ⇒ 标题只剩「拿货单 + 日期」。
// ⚠️ 这张图是**对外**的：行上的字一律取"对方看得懂的事实"（颜色/尺码/件数），
//    内部身份（款编码 `key`）、内部估算（进价/预估金额）、自家商品标题（款名）都不上图。
//    要改这里，先问"这句话对方看得懂吗、会不会被当成报价"。

export interface SheetImageRow {
  /** 图上唯一的文字身份 = 颜色（缺色写「未标色」，见 `hasColor`） */
  colorText: string;
  /** 这一行到底有没有颜色。`false` ⇒ 图上用告警色写 `colorText`（数据缺口要看得见，不能画成正常行） */
  hasColor: boolean;
  /** 本地图片路径（渲染时由 `imageOf` 换成 dataUrl） */
  localPath: string;
  /** 「L×2  XL×1」各码**还要拿**的件数 */
  sizesText: string;
  /** 这一行还要拿的件数合计（图上右侧大字） */
  pieces: number;
}

export interface SheetImageModel {
  /** 固定写「拿货单」—— 不挂厂家名 */
  title: string;
  /** 日期（`2026-11-02`） */
  date: string;
  /** 图上那句口径说明 */
  hint: string;
  rows: SheetImageRow[];
  /** 落款：`共 2 款色 · 3 件`（不含金额） */
  footer: string;
}

/**
 * 清单模型 → **图片**模型（纯函数，被 vitest 钉住"图上不许出现什么"）。
 *
 * 只做减法与换位，不重新算数：行数/件数/尺码文字全部来自 `SheetModel`（⇒ 与屏上、xlsx、
 * 文字清单同一个 `pendingOf` 口径）。`title` / `date` / `hint` / `footer` 是措辞，住在这里。
 */
export function sheetImageModelOf(model: SheetModel): SheetImageModel {
  return {
    title: '拿货单',
    date: model.date,
    hint: '按图备货 · L×2 = L 码拿 2 件',
    rows: model.lines.map((l) => ({
      colorText: l.color || '未标色',
      hasColor: !!l.color,
      localPath: l.localPath,
      sizesText: l.sizesText,
      pieces: l.pieces,
    })),
    footer: `共 ${model.totals.colors} 款色 · ${model.totals.pieces} 件`,
  };
}

// ─────────────────────────────── 画布渲染（浏览器实现） ───────────────────────────────
// 配色是**画布像素**（不参与主题切换，见 AGENTS §1.6 的"非 UI 像素"条款）：
// 这张图要**离开应用**去别的软件里显示（微信/打印），跟随宿主深色主题反而会在对方那里失真。

const SHEET_FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
/**
 * 图宽（CSS px；实际画布按 2 倍渲染，粘到微信里清晰）。
 * ⚠️ 760 → 620（2026-11-02 重设计）：这张图**主要在手机聊天窗里看**（约 360pt 宽 ⇒ 缩放 ~0.58），
 *    760 宽时颜色只剩 8pt 左右、尺码几乎读不出。收窄 + 放字号，缩略图状态下才认得出"哪个色几件"。
 */
const SHEET_W = 620;
const SHEET_PAD = 22;
const SHEET_HEAD = 96;
const SHEET_ROW = 96;
const SHEET_FOOT = 60;
const SHEET_IMG = 84;
/** 行号列宽（撤掉款名后，序号是"第几行"的唯一把手 —— 见 `sheetImageModelOf` 头注） */
const SHEET_IDX_W = 20;

const SHEET_INK = '#111111';
const SHEET_SUB = '#555555';
const SHEET_MUTED = '#999999';
const SHEET_LINE = '#eeeeee';
const SHEET_WARN = '#b45309';

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
    // 缺图占位：底色 + **虚线框**。纯灰块在方图上会被当成"这张图就是这么灰"，
    // 虚线框才读得出"这里本该有图、但没取到"（对方会来问"这个是什么"，比闷着发出去好）。
    ctx.fillStyle = '#f6f6f6';
    ctx.fillRect(x, y, SHEET_IMG, SHEET_IMG);
    ctx.strokeStyle = '#d5d5d5';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, SHEET_IMG - 1, SHEET_IMG - 1);
    ctx.setLineDash([]);
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
 * 一段字的**限宽**（超了按字符砍 + 省略号）。调用前先 `ctx.font = …`（量宽度用的是当前字体）。
 *
 * 为什么必须有：画布**不会换行也不会裁**，`fillText` 超宽就是直接盖到右边去。颜色名是用户自己
 * 填的自由文本（"藏青蓝拼白"这种），而右边是件数大字 —— 不量宽度就画，长色名会压在数字上，
 * 图上就会出现"3"和"件"被糊在一起的读数错误。裁成 `…` 至少看得出"这里还有字"。
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * 把**图像模型**画成一张 PNG（dataURL）。**永不 reject**：画布不可用 / 编码失败返回 `null`
 * （调用方按"复制失败"提示，不静默）。
 *
 * ⚠️ 入参是 `SheetImageModel` 而**不是** `SheetModel`（2026-11-02）：这是"图上不许出现款名 /
 *    预估金额 / 厂家名"的**结构性保证** —— 渲染层手里根本没有这些字段可画，
 *    比写一条"画出来的字符串里不含 ¥"的断言更难绕过（断言只在有人记得维护它时有效）。
 *    要加内容，先在 `sheetImageModelOf` 里想清楚"对方看得懂吗、会不会被当成报价"。
 *
 * 版式（2026-11-02 重设计）：
 *
 * ```
 * 拿货单                                              2026-11-02
 * 按图备货 · L×2 = L 码拿 2 件
 * ─────────────────────────────────────────────────────────────
 *  1  [img]  黑                                        2 件
 *            L×2
 * ─────────────────────────────────────────────────────────────
 * 共 2 款色 · 3 件
 * ```
 *
 * 三列的信息优先级 = 对方干活时的顺序：**先按号码找行 → 再看图认货 → 再看颜色/尺码拿几件**。
 * 所以件数从"次行小字"升成右侧大字（撤掉金额后空出来的那一列），颜色与尺码上下叠（同一视线内）。
 */
export async function renderSheetPng(
  img: SheetImageModel,
  imageOf: (localPath: string) => string,
): Promise<string | null> {
  try {
    const scale = 2;
    const H = SHEET_HEAD + img.rows.length * SHEET_ROW + SHEET_FOOT;
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

    // ── 头：标题（左）+ 日期（右）+ 一句口径 ──
    ctx.textAlign = 'left';
    ctx.fillStyle = SHEET_INK;
    ctx.font = `700 24px ${SHEET_FONT}`;
    ctx.fillText(img.title, SHEET_PAD, 46);
    ctx.textAlign = 'right';
    ctx.fillStyle = SHEET_MUTED;
    ctx.font = `13px ${SHEET_FONT}`;
    ctx.fillText(img.date, SHEET_W - SHEET_PAD, 48);
    ctx.textAlign = 'left';
    ctx.fillStyle = SHEET_MUTED;
    ctx.font = `12px ${SHEET_FONT}`;
    ctx.fillText(img.hint, SHEET_PAD, 78);

    // 表头线比行线重一档 —— 它是"这里是表头、下面是货"的信号
    const headerY = SHEET_HEAD - 6;
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SHEET_PAD, headerY + 0.5);
    ctx.lineTo(SHEET_W - SHEET_PAD, headerY + 0.5);
    ctx.stroke();

    let y = SHEET_HEAD;
    for (let i = 0; i < img.rows.length; i++) {
      const row = img.rows[i];
      const cy = y + SHEET_ROW / 2;

      ctx.strokeStyle = SHEET_LINE;
      ctx.beginPath();
      ctx.moveTo(SHEET_PAD, y + 0.5);
      ctx.lineTo(SHEET_W - SHEET_PAD, y + 0.5);
      ctx.stroke();

      // ① 行号（撤掉款名后，"第几行"是唯一的点名方式）
      ctx.textAlign = 'left';
      ctx.fillStyle = SHEET_MUTED;
      ctx.font = `12px ${SHEET_FONT}`;
      ctx.fillText(String(i + 1), SHEET_PAD, cy);

      // ② 图
      await drawSheetImage(
        ctx,
        imageOf(row.localPath),
        SHEET_PAD + SHEET_IDX_W,
        y + (SHEET_ROW - SHEET_IMG) / 2,
      );

      // ③ 颜色（主）+ 尺码×件数（次）—— 上下叠，同一视线内。
      //    字号偏大一档：这张图在微信里是被**缩小预览**的（620px 宽 ≈ 手机 1/1.7），
      //    17px 缩完只剩 9px 左右，颜色认不出来（颜色是这版**唯一的文字身份**）。
      //    宽度上限 = 到件数列之前（留 88px 给「3 件」），长色名/多码会裁成 `…` 而不是盖住数字。
      const tx = SHEET_PAD + SHEET_IDX_W + SHEET_IMG + 14;
      const maxTextW = SHEET_W - SHEET_PAD - 88 - tx;
      ctx.fillStyle = row.hasColor ? SHEET_INK : SHEET_WARN;
      ctx.font = `700 22px ${SHEET_FONT}`;
      ctx.fillText(fitText(ctx, row.colorText, maxTextW), tx, cy - 15);
      ctx.fillStyle = SHEET_SUB;
      ctx.font = `16px ${SHEET_FONT}`;
      ctx.fillText(fitText(ctx, row.sizesText, maxTextW), tx, cy + 17);

      // ④ 右侧件数大字 + 小号单位（点货时最常扫的数）
      //    单位与数字之间留 19px：三位数（105）时 16px 会贴成"105件"一坨，读起来像另一种数量写法。
      ctx.textAlign = 'right';
      ctx.fillStyle = SHEET_MUTED;
      ctx.font = `12px ${SHEET_FONT}`;
      ctx.fillText('件', SHEET_W - SHEET_PAD, cy + 9);
      ctx.fillStyle = SHEET_INK;
      ctx.font = `700 28px ${SHEET_FONT}`;
      ctx.fillText(String(row.pieces), SHEET_W - SHEET_PAD - 19, cy);
      ctx.textAlign = 'left';

      y += SHEET_ROW;
    }

    // ── 落款：只要款色数 + 件数（不写金额） ──
    ctx.strokeStyle = '#dddddd';
    ctx.beginPath();
    ctx.moveTo(SHEET_PAD, y + 0.5);
    ctx.lineTo(SHEET_W - SHEET_PAD, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#333333';
    ctx.font = `600 15px ${SHEET_FONT}`;
    ctx.fillText(img.footer, SHEET_PAD, y + SHEET_FOOT / 2);

    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}
