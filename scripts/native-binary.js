'use strict';

// 原生模块二进制的平台 / 架构识别：只读文件头，不加载、不执行。
//
// 为什么必须有这一层：electron-builder 在 macOS 上执行 `--win` 时**不会**把
// better-sqlite3 交叉编译成 Windows PE，而是把构建机上那份 Mach-O 原样收进包。
// 打包 exit 0、产物能上传 GitHub Releases、用户能下载安装，直到主进程
// `require('bindings')('better_sqlite3.node')` 加载 Mach-O 才崩 —— 典型的静默坏包。
// 实测：release/ 里 1.0.0 / 1.0.1 / 1.0.2 / 1.0.4 的 8 个 win-x64 安装包，
// 内嵌 better_sqlite3.node 全是 `cffaedfe 07000001`（Mach-O x86_64）。
//
// 这里只做「这个二进制是什么」的判断，不做「怎么修」；修法见 README 打包矩阵。

const CPU_MACHO = {
  7: 'ia32',           // CPU_TYPE_I386
  0x01000007: 'x64',   // CPU_TYPE_X86_64
  12: 'armv7',         // CPU_TYPE_ARM
  0x0100000c: 'arm64', // CPU_TYPE_ARM64
  0x01000002: 'arm64', // CPU_TYPE_ARM64_32（按 arm64 处理）
};

const CPU_PE = {
  0x014c: 'ia32',  // IMAGE_FILE_MACHINE_I386
  0x8664: 'x64',   // IMAGE_FILE_MACHINE_AMD64
  0xaa64: 'arm64', // IMAGE_FILE_MACHINE_ARM64
  0x01c4: 'armv7', // IMAGE_FILE_MACHINE_ARMNT
};

const CPU_ELF = {
  3: 'ia32',   // EM_386
  62: 'x64',   // EM_X86_64
  183: 'arm64', // EM_AARCH64
  40: 'armv7', // EM_ARM
};

/**
 * electron-builder 的 Arch 枚举是数字（ia32=0 / x64=1 / armv7l=2 / arm64=3 / universal=4），
 * 而 check-release 传进来的是字符串。两处都必须归一到同一套名字，否则守卫本身就会口径漂移。
 */
function normalizeArch(arch) {
  if (typeof arch === 'number') {
    return { 0: 'ia32', 1: 'x64', 2: 'armv7', 3: 'arm64', 4: 'any' }[arch] || 'unknown';
  }
  const s = String(arch == null ? '' : arch).toLowerCase();
  if (s === 'any' || s === 'universal') return 'any';
  if (s === 'x64' || s === 'amd64' || s === 'x86_64') return 'x64';
  if (s === 'arm64' || s === 'aarch64') return 'arm64';
  if (s === 'ia32' || s === 'x86' || s === 'i386') return 'ia32';
  if (s === 'armv7l' || s === 'armv7' || s === 'arm') return 'armv7';
  return 'unknown';
}

function normalizePlatform(platform) {
  const s = String(platform == null ? '' : platform).toLowerCase();
  if (s === 'win32' || s === 'win' || s === 'windows') return 'win32';
  if (s === 'darwin' || s === 'mac' || s === 'macos') return 'darwin';
  if (s === 'linux') return 'linux';
  return 'unknown';
}

/** 解析 Mach-O universal（fat）头里列出的架构；头被截断时返回空数组（宁可判失败，不猜）。 */
function parseFatArches(buf) {
  const is64 = buf[3] === 0xbf;
  const count = Math.min(buf.readUInt32BE(4), 16);
  const entrySize = is64 ? 32 : 20;
  const arches = [];
  for (let i = 0; i < count; i += 1) {
    const off = 8 + i * entrySize;
    if (off + 4 > buf.length) return [];
    const a = CPU_MACHO[buf.readUInt32BE(off)];
    if (a) arches.push(a);
  }
  return arches;
}

/**
 * @returns {{format: string, arch: string, arches?: string[]}}
 *   format: macho | fat | pe | elf | unknown
 */
function detectBinary(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return { format: 'unknown', arch: 'unknown' };

  // Mach-O 64-bit little endian：cf fa ed fe + cputype(uint32 LE)
  if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
    const cpu = buf.readUInt32LE(4);
    return { format: 'macho', arch: CPU_MACHO[cpu] || 'unknown' };
  }
  // Mach-O 32-bit little endian：ce fa ed fe
  if (buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
    const cpu = buf.readUInt32LE(4);
    return { format: 'macho', arch: CPU_MACHO[cpu] || 'unknown' };
  }
  // universal：ca fe ba be(32) / ca fe ba bf(64)
  if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && (buf[3] === 0xbe || buf[3] === 0xbf)) {
    return { format: 'fat', arch: 'universal', arches: parseFatArches(buf) };
  }

  // PE：MZ + e_lfanew(0x3c) → "PE\0\0" + Machine(uint16)
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return { format: 'pe', arch: 'unknown' };
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length || buf[pe] !== 0x50 || buf[pe + 1] !== 0x45) {
      return { format: 'pe', arch: 'unknown' };
    }
    const machine = buf.readUInt16LE(pe + 4);
    return { format: 'pe', arch: CPU_PE[machine] || 'unknown' };
  }

  // ELF：\x7fELF + EI_CLASS(4) + e_machine(uint16 @18, LE)
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    if (buf.length < 20) return { format: 'elf', arch: 'unknown' };
    return { format: 'elf', arch: CPU_ELF[buf.readUInt16LE(18)] || 'unknown' };
  }

  return { format: 'unknown', arch: 'unknown' };
}

function expectedBinary(platform, arch) {
  const p = normalizePlatform(platform);
  const format = { win32: 'pe', darwin: 'macho', linux: 'elf' }[p] || 'unknown';
  return { platform: p, format, arch: normalizeArch(arch) };
}

const FORMAT_LABEL = {
  macho: 'Mach-O (macOS)',
  fat: 'Mach-O universal (macOS)',
  pe: 'PE (Windows)',
  elf: 'ELF (Linux)',
  unknown: '无法识别',
};

/**
 * 校验目标平台的原生模块二进制；不匹配就抛错中止打包。
 * 绝不「警告后继续」—— 警告会被淹没在 electron-builder 的日志里，包照样发出去。
 *
 * @returns {{format: string, arch: string}}
 */
function assertNativeBinary({ platform, arch, buffer, label }) {
  const want = expectedBinary(platform, arch);
  const got = detectBinary(buffer);
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 8).toString('hex') : '(无内容)';
  const at = label || 'better_sqlite3.node';

  if (want.format === 'unknown' || want.arch === 'unknown') {
    throw new Error(`[native-binary] 无法判断目标 platform/arch：${String(platform)} / ${String(arch)}`);
  }

  let ok = false;
  if (got.format === 'fat') {
    ok = want.format === 'macho' && (want.arch === 'any' || (got.arches || []).includes(want.arch));
  } else {
    ok = got.format === want.format && (want.arch === 'any' || got.arch === want.arch);
  }
  if (ok) return got;

  throw new Error(
    [
      `[native-binary] 原生模块与目标平台不匹配，拒绝产出坏包`,
      `  文件：${at}`,
      `  目标：${want.platform} / ${want.arch} → 期望 ${FORMAT_LABEL[want.format]} / ${want.arch}`,
      `  实际：${FORMAT_LABEL[got.format]} / ${got.arch}（头 8 字节 ${head}）`,
      want.platform === 'win32' && got.format !== 'pe'
        ? `  原因：这份 better_sqlite3.node 不是 Windows PE。electron-builder 不会跨平台交叉编译原生模块，`
        : `  原因：构建机上的原生模块属于另一个平台 / 架构。`,
      `  处理：请在「目标平台 + 目标架构」的构建机上先 npm run rebuild，再执行对应平台的 dist 脚本；`,
      `        mac 双架构要分两次打（--mac --arm64 / --mac --x64），Windows 包必须在 Windows x64 上打。`,
      `  说明：这种包能构建、能签名、能上传 Releases，但用户启动到数据库初始化时必崩。`,
    ].join('\n')
  );
}

module.exports = { detectBinary, expectedBinary, normalizeArch, normalizePlatform, assertNativeBinary };
