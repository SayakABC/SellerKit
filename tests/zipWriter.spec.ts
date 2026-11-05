// tests/zipWriter.spec.ts
// 自写的 zip 打包器（`buildZip`）—— 用 `jszip` 把产物**解回来**再比对字节。
//
// 为什么必须"用别人写的库解回来"：自己写、自己读（同一个实现）两边可能同错，
// 而 zip 写错一处的症状是"Excel/资源管理器打不开，但打包函数不报错"。
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildZip, crc32 } from '../electron/zip-writer';

const readBack = async (buf: Buffer) => JSZip.loadAsync(buf);

describe('crc32', () => {
  it('与 zip 规范一致（已知向量：空 / "123456789"）', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('buildZip', () => {
  it('一个 deflate 项：解回来内容逐字节相同', async () => {
    const data = Buffer.from('图案编码,净需件\nP001,6\n', 'utf8');
    const zip = await readBack(buildZip([{ name: '清单.csv', data }]));
    expect(await zip.file('清单.csv')!.async('string')).toBe(data.toString('utf8'));
  });

  it('多个项（store + deflate 混用）+ 中文名：都能解出来（UTF-8 标志位没丢）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const zip = await readBack(
      buildZip([
        { name: '清单.xlsx', data: Buffer.from('fake-xlsx-内容'), method: 'deflate' },
        { name: '图稿/P001.png', data: png, method: 'store' },
        { name: '图稿/P002.jpg', data: Buffer.from('jpeg'), method: 'store' },
      ]),
    );
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['图稿/P001.png', '图稿/P002.jpg', '清单.xlsx']);
    const back = await zip.file('图稿/P001.png')!.async('nodebuffer');
    expect(Buffer.compare(back, png)).toBe(0);
    expect(await zip.file('清单.xlsx')!.async('string')).toBe('fake-xlsx-内容');
  });

  it('空内容 / 非数组 / 非法项名：抛错而不是写一个坏包', () => {
    expect(() => buildZip([])).toThrow();
    expect(() => buildZip(null as any)).toThrow();
    expect(() => buildZip([{ name: '', data: Buffer.alloc(0) }])).toThrow();
    expect(() => buildZip([{ name: '/abs/path', data: Buffer.alloc(0) }])).toThrow();
    expect(() => buildZip([{ name: '../escape', data: Buffer.alloc(0) }])).toThrow();
  });

  it('项数多时中央目录偏移不乱（第二、三项都解得出）', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      name: `图稿/P00${i}.txt`,
      data: Buffer.from(`内容 ${i}`),
    }));
    const zip = await readBack(buildZip(entries));
    for (let i = 0; i < 6; i += 1) {
      expect(await zip.file(`图稿/P00${i}.txt`)!.async('string')).toBe(`内容 ${i}`);
    }
  });
});
