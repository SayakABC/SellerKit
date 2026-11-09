import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type Detected = { format: string; arch: string; arches?: string[] };
type Guard = {
  detectBinary: (buf: Buffer) => Detected;
  expectedBinary: (platform: string, arch: string | number) => { platform: string; format: string; arch: string };
  normalizeArch: (arch: string | number) => string;
  normalizePlatform: (platform: string) => string;
  assertNativeBinary: (opts: {
    platform: string;
    arch: string | number;
    buffer: Buffer;
    label?: string;
  }) => Detected;
};

const guard = require('../scripts/native-binary.js') as Guard;

function macho(cpu: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}

function pe(machine: number): Buffer {
  const b = Buffer.alloc(0x90);
  b.write('MZ', 0, 'ascii');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'ascii');
  b.writeUInt16LE(machine, 0x84);
  return b;
}

function fat(cpus: number[]): Buffer {
  const b = Buffer.alloc(8 + cpus.length * 20);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, i) => b.writeUInt32BE(cpu, 8 + i * 20));
  return b;
}

function elf(machine: number): Buffer {
  const b = Buffer.alloc(20);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = 2;
  b.writeUInt16LE(machine, 18);
  return b;
}

const MACHO_X64 = macho(0x01000007);
const MACHO_ARM64 = macho(0x0100000c);
const PE_X64 = pe(0x8664);
const PE_ARM64 = pe(0xaa64);

describe('原生模块二进制识别', () => {
  it('回归钉子：历史 win-x64 包里的 cffaedfe07000001 被认成 macho/x64，而不是「看起来像 PE」', () => {
    const real = Buffer.from('cffaedfe07000001', 'hex');
    expect(guard.detectBinary(real)).toEqual({ format: 'macho', arch: 'x64' });
    expect(real.equals(MACHO_X64)).toBe(true);
  });

  it('PE / ELF / 垃圾输入分别落到不同分支（桩要给两个结果不同的输入）', () => {
    expect(guard.detectBinary(PE_X64)).toEqual({ format: 'pe', arch: 'x64' });
    expect(guard.detectBinary(PE_ARM64)).toEqual({ format: 'pe', arch: 'arm64' });
    expect(guard.detectBinary(elf(183))).toEqual({ format: 'elf', arch: 'arm64' });
    expect(guard.detectBinary(Buffer.alloc(3))).toEqual({ format: 'unknown', arch: 'unknown' });
    expect(guard.detectBinary(Buffer.from('not a binary at all'))).toEqual({
      format: 'unknown',
      arch: 'unknown',
    });
  });

  it('universal 二进制解析出全部架构；fat 头被截断时不猜、返回空列表', () => {
    expect(guard.detectBinary(fat([0x01000007, 0x0100000c])).arches).toEqual(['x64', 'arm64']);
    expect(guard.detectBinary(fat([0x0100000c])).arches).toEqual(['arm64']);
    const truncated = fat([0x01000007, 0x0100000c]).subarray(0, 20);
    expect(guard.detectBinary(truncated).arches).toEqual([]);
  });

  it('结构反向守卫：普通样本只返回 format / arch，不掺别的字段', () => {
    expect(Object.keys(guard.detectBinary(MACHO_X64)).sort()).toEqual(['arch', 'format']);
  });

  it('platform / arch 归一：electron-builder 的数字枚举与字符串必须同义', () => {
    expect(guard.normalizeArch(1)).toBe('x64');
    expect(guard.normalizeArch(3)).toBe('arm64');
    expect(guard.normalizeArch('amd64')).toBe('x64');
    expect(guard.normalizeArch('armv7l')).toBe('armv7');
    expect(guard.normalizeArch('nonsense')).toBe('unknown');
    expect(guard.expectedBinary('win32', 'x64')).toEqual({ platform: 'win32', format: 'pe', arch: 'x64' });
    expect(guard.expectedBinary('darwin', 3)).toEqual({
      platform: 'darwin',
      format: 'macho',
      arch: 'arm64',
    });
  });
});

describe('打包门禁：assertNativeBinary', () => {
  it('平台与架构都对 → 放行', () => {
    expect(guard.assertNativeBinary({ platform: 'darwin', arch: 'x64', buffer: MACHO_X64 })).toEqual({
      format: 'macho',
      arch: 'x64',
    });
    expect(guard.assertNativeBinary({ platform: 'win32', arch: 1, buffer: PE_X64 })).toEqual({
      format: 'pe',
      arch: 'x64',
    });
  });

  it('核心场景：Windows 包里塞 Mach-O → 硬失败，且错误信息给出可执行修法', () => {
    let msg = '';
    try {
      guard.assertNativeBinary({ platform: 'win32', arch: 'x64', buffer: MACHO_X64 });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('拒绝产出坏包');
    expect(msg).toContain('cffaedfe07000001');
    expect(msg).toContain('Mach-O (macOS)');
    expect(msg).toContain('npm run rebuild');
    expect(msg).toContain('Windows x64 上打');
  });

  it('同平台但架构不符也不放行（mac x64 包里塞 arm64 二进制）', () => {
    expect(() =>
      guard.assertNativeBinary({ platform: 'darwin', arch: 'x64', buffer: MACHO_ARM64 })
    ).toThrow(/拒绝产出坏包/);
    expect(() =>
      guard.assertNativeBinary({ platform: 'win32', arch: 'arm64', buffer: PE_X64 })
    ).toThrow(/拒绝产出坏包/);
  });

  it('无法识别的二进制 / 无法判断的目标都不静默放行', () => {
    expect(() =>
      guard.assertNativeBinary({ platform: 'win32', arch: 'x64', buffer: Buffer.alloc(8) })
    ).toThrow(/拒绝产出坏包/);
    expect(() =>
      guard.assertNativeBinary({ platform: 'solaris', arch: 'x64', buffer: PE_X64 })
    ).toThrow(/无法判断目标/);
  });

  it('universal 二进制：包含目标架构才放行，只有 arm64 的不许当 x64 包发出去', () => {
    expect(
      guard.assertNativeBinary({ platform: 'darwin', arch: 'x64', buffer: fat([0x01000007, 0x0100000c]) })
        .format
    ).toBe('fat');
    expect(() =>
      guard.assertNativeBinary({ platform: 'darwin', arch: 'x64', buffer: fat([0x0100000c]) })
    ).toThrow(/拒绝产出坏包/);
  });
});

describe('守卫接线（防止守卫被摘掉而测试仍绿）', () => {
  it('afterPack 真的调用 assertNativeBinary 并且会抛错，不是只 console.warn', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(new URL('../scripts/afterPack.js', import.meta.url), 'utf8');
    expect(src).toContain('assertNativeBinary');
    expect(src).toContain('throw new Error');
    expect(src).toContain('找不到 app.asar.unpacked');
  });

  it('check-release 存在、能识别 mac zip / win exe、坏包时退出码非 0', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(new URL('../scripts/check-release.mjs', import.meta.url), 'utf8');
    expect(src).toContain('-mac-(x64|arm64|universal)');
    expect(src).toContain('-win-(x64|arm64|ia32)');
    expect(src).toContain('process.exit(1)');
  });

  it('端到端：把 Mach-O 放进模拟的 win32 产物目录，afterPack 必须拒绝放行', async () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const afterPack = require('../scripts/afterPack.js') as (ctx: unknown) => Promise<void>;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-afterpack-'));
    const unpacked = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(unpacked, { recursive: true });
    fs.writeFileSync(path.join(unpacked, 'better_sqlite3.node'), MACHO_X64);
    const ctx = {
      electronPlatformName: 'win32',
      arch: 1, // electron-builder Arch.x64
      appOutDir: dir,
      packager: { appInfo: { productFilename: 'SellerKit' } },
    };

    try {
      await expect(afterPack(ctx)).rejects.toThrow(/拒绝产出坏包/);
      // 换成正确的 PE → 同一个钩子必须放行（两个输入给出不同结果，不是恒真断言）
      fs.writeFileSync(path.join(unpacked, 'better_sqlite3.node'), PE_X64);
      await expect(afterPack(ctx)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('端到端：产物里缺 better_sqlite3.node 时也不静默放行', async () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const afterPack = require('../scripts/afterPack.js') as (ctx: unknown) => Promise<void>;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-afterpack-empty-'));
    try {
      await expect(
        afterPack({
          electronPlatformName: 'win32',
          arch: 1,
          appOutDir: dir,
          packager: { appInfo: { productFilename: 'SellerKit' } },
        })
      ).rejects.toThrow(/找不到 app\.asar\.unpacked/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
