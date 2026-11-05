// electron/zip-writer.ts
// **最小 zip 打包器**（零依赖，只用 Node 的 `zlib`）。M4·T4-3 的「报单 zip」用它。
//
// 为什么自己写而不是加依赖：仓库的依赖清单里 `jszip` 只在 devDependencies（`scripts/*` 用它校验产物），
// 主进程不能依赖 devDependency 打包；而报单 zip 只需要"几个文件、deflate、写盘"这一件事。
// 引入 `archiver` 这类库会为一个 200 行的格式再涨几 MB 安装体积。
//
// 格式要点（写错任何一处 = Excel/资源管理器打不开，而**不报错**）：
//   ① **UTF-8 文件名**：`清单.xlsx` 之外的 `图稿/P001.jpg` 含中文 ⇒ 必须置通用位标志 bit 11（0x0800），
//      否则解压出来是乱码文件名（报单发给花纸商时对方找不到图）；
//   ② CRC32 与**压缩后**大小必须与写进本地头的值一致；
//   ③ 中央目录里的 `local header offset` 必须指向真正的起点（算错 = 只能解开第一个文件）。
// 本文件只支持 **store（0）与 deflate（8）** 两种方法，不写 zip64（报单不会超过 4GB / 65535 个文件，
// 真到了那个量级说明报单流程本身已经坏了）。
//
// 校验在 `tests/zipWriter.spec.ts`：用 `jszip`（devDependency）把产物解回来逐个比对字节 ——
// "我们自己写的格式，自己读回来"等于没验，因为两边可能同错。

export {};

import * as zlib from 'zlib';

export interface ZipEntry {
  /** 包内路径（用 `/` 分隔；不得以 `/` 开头） */
  name: string;
  data: Buffer;
  /** 压缩方式：默认 `deflate`（xlsx/文本收益大）；已压缩的图片用 `store` 更快 */
  method?: 'deflate' | 'store';
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32（zip 规范用的那个多项式，不是 PNG 的） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间/日期（只用固定值 1980-01-01 00:00 —— 报单内容是数据，不靠时间戳表达"新旧"） */
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

/**
 * 打包成 zip（内存内完成；调用方负责写盘）。
 *
 * @throws 项名为空 / 以 `/` 开头 / 含 `..` 时抛错 —— 这些是路径穿越或空名，不该被静默写进包
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new Error('zip 内容为空（报单至少要有一个文件）');

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of list) {
    const name = String(e?.name ?? '');
    if (!name) throw new Error('zip 项名为空');
    if (name.startsWith('/') || name.includes('..')) throw new Error(`zip 项名不合法：${name}`);
    const data = Buffer.isBuffer(e?.data) ? e.data : Buffer.from(e?.data ?? '');
    const method = e?.method === 'store' ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地头签名
    local.writeUInt16LE(20, 4); // 版本
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 生成版本
    central.writeUInt16LE(20, 6); // 需要的版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移 —— 算错就只解得出第一个文件
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16); // 中央目录起点
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}
