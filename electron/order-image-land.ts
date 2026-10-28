// electron/order-image-land.ts
// 「远程图 → 订单图库（oi_images）」的**唯一**落库实现。
//
// ---- 为什么单开一个文件（不是为整洁，是为业务闭环）----
// 这条链路有两个调用方：
//   · `order-download-image`  —— 订单导入时下载主图
//   · `shop-item-image-fetch` —— 店铺商品采集把**色图**采纳为「款色绑定图」
//
// 色图的全部价值是「订单导入后能按图找到颜色」：归类核对 / 拣货单 / 拿货单都走
//     oi_order_items.image_id → oi_images.style_color_id → oi_style_colors → oi_styles
// 而「按图找色」的唯一入口是 `order-download-image` 里的**内容指纹命中** ——
// 命中即复用那一行（连带它已有的 styleColorId，注释原文：「含识别状态 / 款色归属」）。
// 于是色图必须同时满足三件事，缺一样闭环就不闭：
//   ① 落在 **oi_images**（不是产品域 pl_images）；
//   ② 落在 **userData/order-images/**（与订单图同目录，同内容不存两份字节）；
//   ③ 用同一套**两级去重**（URL 指纹 → 内容指纹）。
//
// 教训（审查报告 P0-1）：曾经色图走产品域 `landImageBuffer` 落 pl_images，再把那个 id
// 交给 `adoptStyleColorImageByCode`（它读写 oi_images）。两表各自 AUTOINCREMENT、
// id 必然撞上 ⇒ 一次采纳改的是**任意一张订单图**的归类状态，回执还报 bound:true。
// 根因不是"传错了参数"，是**存在两份落库实现**。所以这里只留一份，两边共用。
//
// 落盘上限沿用 `http-client.downloadFile` 的 20MB（本层不另设一套，免得两处不同）。

import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IMG_EXT_BY_FORMAT, sniffImageFormat } from './ipc-util';
import {
  findImageByFingerprint,
  findImageByUrlFingerprint,
  insertImage,
  type OrderImageId,
  type OrderImageRecord,
} from './order-db';

const { downloadFile } = require('./http-client');

/** 订单主图缓存目录：userData/order-images/（孤图清理 / 备份导出认的也是这个目录） */
export const ORDER_IMAGE_DIR = () => path.join(app.getPath('userData'), 'order-images');

/** URL 规范化指纹（同类图不同签名参数视为同一张；解析失败退回整串哈希） */
export function fingerprintUrl(url: string): string {
  try {
    const u = new URL(url);
    return crypto.createHash('sha256').update(u.origin + u.pathname).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(url).digest('hex');
  }
}

export interface LandedOrderImage {
  /** **oi_images 的主键**（品牌类型） —— 交给 `adoptStyleColorImageByCode` 的就是它 */
  imageId: OrderImageId;
  localPath: string;
  /** 内容 SHA-256（订单导入时按它命中本行 ⇒ 继承 styleColorId） */
  fingerprint: string;
  /** true = 命中既有行（URL 指纹或内容指纹），没插新行 */
  reused: boolean;
  row: OrderImageRecord;
}

/**
 * 把**已在内存里**的图片字节落进 order-images 并登记 oi_images。
 *
 * 两级去重与 `order-download-image` 原实现同序：URL 指纹 → 内容指纹 → 新插一行。
 * 先比 URL 指纹是为了"同一张色图被采纳两次"不再落第二行；后比内容指纹正是
 * 「按图找色」的命入口 —— **同图不同 URL 也复用同一行**（连带它的款色归属）。
 *
 * @throws 内容不是受支持的图片格式（按文件头判断，不只看扩展名）
 */
export function landOrderImageBytes(
  buf: Buffer,
  opts: { urlFingerprint: string; sourceUrl: string },
): LandedOrderImage {
  const fmt = sniffImageFormat(buf);
  if (!fmt) throw new Error('unsupported image format');
  const fingerprint = crypto.createHash('sha256').update(buf).digest('hex');
  const urlFp = String(opts?.urlFingerprint ?? '');
  const hit = (row: OrderImageRecord | undefined): LandedOrderImage | undefined =>
    row && Number(row.id) > 0
      ? {
          imageId: Number(row.id) as OrderImageId,
          localPath: String(row.localPath ?? ''),
          fingerprint: String(row.fingerprint ?? ''),
          reused: true,
          row,
        }
      : undefined;
  // URL 指纹先比：同 URL 重复采纳不落第二行
  if (urlFp) {
    const byUrl = hit(findImageByUrlFingerprint(urlFp));
    if (byUrl) return byUrl;
  }
  // 内容指纹后比：这是"订单导入后按图找到颜色"的命入口
  const byContent = hit(findImageByFingerprint(fingerprint));
  if (byContent) return byContent;
  const dir = ORDER_IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, fingerprint + IMG_EXT_BY_FORMAT[fmt]);
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, buf);
  const sourceUrl = String(opts?.sourceUrl ?? '');
  const id = insertImage({
    fingerprint,
    urlFingerprint: urlFp,
    sourceUrl,
    localPath: finalPath,
    status: 'pending',
  });
  const row: OrderImageRecord = {
    id,
    fingerprint,
    urlFingerprint: urlFp,
    sourceUrl,
    localPath: finalPath,
    status: 'pending',
  };
  return { imageId: id, localPath: finalPath, fingerprint, reused: false, row };
}

/**
 * 下载远程图的结果（`ok` 与 `image/error` 的可选关系**只能靠注释保证** ——
 * 本仓 electron 侧 `strict:false`，布尔判别联合不会被收窄，写成 `{ok:true,…}|{ok:false,…}`
 * 反而让调用方取不到 `.error`；故沿用 `downloadFile` 同款的扁平形状）。
 */
export interface LandOrderImageResult {
  ok: boolean;
  /** ok=true 时必有 */
  image?: LandedOrderImage;
  /** ok=false 时的原因，可直接进回执 */
  error?: string;
}

/**
 * 下载远程图 → 落 order-images → 登记 oi_images（两级去重）。
 *
 * URL 指纹先查一次再下载：同一张图第二次请求连流量都不产生（与原实现同行为）。
 * 临时文件用 `.img` 后缀（不是图片扩展名）：下载失败/格式不对时不会被当成正式缓存图。
 *
 * 失败不外抛：调用方决定是整单失败还是收进单色的 `reason`（色图场景要"一张坏图不拖累其它色"）。
 */
export async function landOrderImageByUrl(url: string): Promise<LandOrderImageResult> {
  const urlFp = fingerprintUrl(url);
  const byUrl = findImageByUrlFingerprint(urlFp);
  if (byUrl && Number(byUrl.id) > 0) {
    return {
      ok: true,
      image: {
        imageId: Number(byUrl.id) as OrderImageId,
        localPath: String(byUrl.localPath ?? ''),
        fingerprint: String(byUrl.fingerprint ?? ''),
        reused: true,
        row: byUrl,
      },
    };
  }
  const dir = ORDER_IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, urlFp + '.img');
  try {
    const r = await downloadFile(url, tmpPath);
    if (!r.ok) return { ok: false, error: r.error || 'download failed' };
    const buf = fs.readFileSync(tmpPath);
    // 下载内容不是受支持的图片（或下载到了错误页/防盗链占位）：不落盘避免垃圾入库
    if (!sniffImageFormat(buf)) return { ok: false, error: 'unsupported image format' };
    return { ok: true, image: landOrderImageBytes(buf, { urlFingerprint: urlFp, sourceUrl: url }) };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}
