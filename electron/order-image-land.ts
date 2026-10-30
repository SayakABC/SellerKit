// electron/order-image-land.ts
// 「远程图 → 图片主数据（md_images）」的**唯一**落库实现（R1 / S0a 收口后）。
//
// 历史（为什么曾经单开一个文件）：这条链路有两个调用方 —— 订单导入下载主图、
// 店铺商品采集采纳色图；旧实现把图片落在订单域 `oi_images`、文件放 `order-images/`，
// 而产品图落在产品域 `pl_images`、文件放 `product-images/`。两表各自 AUTOINCREMENT、
// id 必然撞车，于是"把产品图 id 当色图 id 传进去"曾改掉另一张表的另一行（审查 P0-1）。
//
// R1 之后：落库实现搬到 `electron/master-data-db.ts` 的 `landImageBytes`（全项目唯一入口），
// 本文件只保留**远程图的下载壳**（临时文件、URL 指纹预判、错误不外抛）。
// 目录只剩一个：`userData/images/`；备份、孤图清理、缩略图白名单都认它。
//
// 落盘上限沿用 `http-client.downloadFile` 的 20MB（本层不另设一套，免得两处不同）。

import * as fs from 'fs';
import * as path from 'path';
import { sniffImageFormat } from './ipc-util';
import {
  IMAGE_DIR,
  fingerprintUrl,
  findImageByUrlFingerprint,
  landImageBytes,
  type MdImageId,
  type MdImageRow,
} from './master-data-db';

const { downloadFile } = require('./http-client');

/** 图片缓存目录（兼容旧名：`IMAGE_DIR()` 就是 `userData/images/`） */
export const ORDER_IMAGE_DIR = IMAGE_DIR;

export interface LandedOrderImage {
  /** **md_images 的主键**（品牌类型） */
  imageId: MdImageId;
  localPath: string;
  /** 内容 SHA-256（订单导入时按它命中本行） */
  fingerprint: string;
  /** true = 命中既有行（URL 指纹或内容指纹），没插新行 */
  reused: boolean;
  row: MdImageRow;
}

/**
 * 把**已在内存里**的图片字节落进 `userData/images/` 并登记 `md_images`。
 *
 * 两级去重（URL 指纹 → 内容指纹）与 `landImageBytes` 同一份实现 —— 这里只是把
 * "订单图"这个来源标记固定下来，让排查时一眼能看出图是从哪条链路进来的。
 *
 * @throws 内容不是受支持的图片格式（按文件头判断，不只看扩展名）
 */
export function landOrderImageBytes(
  buf: Buffer,
  opts: { urlFingerprint: string; sourceUrl: string; source?: string },
): LandedOrderImage {
  const landed = landImageBytes(buf, {
    sourceUrl: opts?.sourceUrl,
    urlFingerprint: opts?.urlFingerprint,
    source: opts?.source || 'order-image',
  });
  // landed 只回 id/路径/指纹；row 是调用方展示用的完整行（回查一次，命中路径也一致）
  const row: MdImageRow = {
    id: Number(landed.imageId) || 0,
    fingerprint: landed.fingerprint,
    urlFingerprint: String(opts?.urlFingerprint ?? ''),
    sourceUrl: String(opts?.sourceUrl ?? ''),
    localPath: landed.localPath,
    source: String(opts?.source || 'order-image'),
  };
  return {
    imageId: landed.imageId,
    localPath: landed.localPath,
    fingerprint: landed.fingerprint,
    reused: landed.reused,
    row,
  };
}

/**
 * 下载远程图的结果（`ok` 与 `image/error` 的可选关系**只能靠注释保证** ——
 * 本仓 electron 侧 `strict:false`，布尔判别联合不会被收窄）。
 */
export interface LandOrderImageResult {
  ok: boolean;
  /** ok=true 时必有 */
  image?: LandedOrderImage;
  /** ok=false 时的原因，可直接进回执 */
  error?: string;
}

/**
 * 下载远程图 → 落 `userData/images/` → 登记 `md_images`（两级去重）。
 *
 * URL 指纹先查一次再下载：同一张图第二次请求连流量都不产生。
 * 临时文件用 `.img` 后缀（不是图片扩展名）：下载失败/格式不对时不会被当成正式缓存图。
 *
 * 失败不外抛：调用方决定是整单失败还是收进单色的 `reason`（色图场景要"一张坏图不拖累其它色"）。
 */
export async function landOrderImageByUrl(url: string): Promise<LandOrderImageResult> {
  const urlFp = fingerprintUrl(url);
  const byUrl = findImageByUrlFingerprint(urlFp);
  if (byUrl && byUrl.id > 0) {
    return {
      ok: true,
      image: {
        imageId: Number(byUrl.id) as MdImageId,
        localPath: byUrl.localPath,
        fingerprint: byUrl.fingerprint,
        reused: true,
        row: byUrl,
      },
    };
  }
  const dir = IMAGE_DIR();
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
