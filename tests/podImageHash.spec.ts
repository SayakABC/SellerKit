// tests/podImageHash.spec.ts
// 图案「看图认领」的像素特征（`electron/podImageHash.ts`）—— 纯函数，不依赖 Electron。
//
// 为什么这几条必须钉住：dHash 一旦改（权重 / 方向 / 位序），**历史建议的相似度就不可比** ——
// 用户昨天看到"这两张很像"，今天同一对图可能变成"差 37 位"，而代码却全绿。
import { describe, it, expect } from 'vitest';
import { averageRgbFromBgra, dHashFromBgra, hammingDistance } from '../electron/podImageHash';

/** 造一张 9×8 的 BGRA 图（`rgb(x, y)` 返回 [r,g,b]） */
function bitmap(rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const w = 9;
  const h = 8;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = rgb(x, y);
      const o = (y * w + x) * 4;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

describe('dHashFromBgra — 感知哈希', () => {
  it('纯色图：没有任何"左边比右边亮"，64 位全 0', () => {
    const hash = dHashFromBgra(bitmap(() => [120, 120, 120]));
    expect(hash).toBe('0000000000000000');
    expect(hash).toHaveLength(16);
  });

  it('每行从左到右变暗：每一对都"左 > 右"，64 位全 1', () => {
    const hash = dHashFromBgra(bitmap((x) => [200 - x * 20, 200 - x * 20, 200 - x * 20]));
    expect(hash).toBe('ffffffffffffffff');
  });

  it('亮度是"结构"：整图整体加亮 50 不减位（比的是相邻像素，不是绝对值）', () => {
    const a = dHashFromBgra(bitmap((x, y) => [((x + y) % 2) * 180 + 20, 100, 100]));
    const b = dHashFromBgra(bitmap((x, y) => [((x + y) % 2) * 180 + 20, 150, 150]));
    expect(a).toBe(b);
  });

  it('字节不够长 / 空输入 → 空串（不抛错，一张坏图不该让整批建议消失）', () => {
    expect(dHashFromBgra(Buffer.alloc(0))).toBe('');
    expect(dHashFromBgra(null as any)).toBe('');
    expect(dHashFromBgra(Buffer.alloc(10))).toBe('');
  });
});

describe('hammingDistance — 两个哈希差几位', () => {
  it('相同 → 0；全反 → 64', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', '0000000000000003')).toBe(2);
    expect(hammingDistance('00000000', 'ffffffff')).toBe(32);
  });

  it('空 / 非十六进制 / 长度不同 → 64（最不相似），不抛错', () => {
    expect(hammingDistance('', '')).toBe(64);
    expect(hammingDistance('', '0000')).toBe(64);
    expect(hammingDistance('zzzz', '0000')).toBe(64);
    expect(hammingDistance('0000', '000000')).toBe(64);
    expect(() => hammingDistance(null as any, undefined as any)).not.toThrow();
  });

  it('大小写不敏感（同一个哈希两种写法必须差 0 位）', () => {
    expect(hammingDistance('ABCDEF', 'abcdef')).toBe(0);
  });
});

describe('averageRgbFromBgra — 平均主色', () => {
  it('BGRA 的通道顺序不能搞反（B=0,G=1,R=2,alpha 忽略）', () => {
    const buf = Buffer.alloc(2 * 2 * 4);
    for (let i = 0; i < 4; i += 1) {
      buf[i * 4] = 10; // B
      buf[i * 4 + 1] = 20; // G
      buf[i * 4 + 2] = 30; // R
      buf[i * 4 + 3] = 255;
    }
    expect(averageRgbFromBgra(buf, 2, 2)).toEqual({ r: 30, g: 20, b: 10 });
  });

  it('alpha 不参与平均（半透明黑底不该被算成灰）', () => {
    const buf = Buffer.alloc(2 * 4);
    buf[0] = 0;
    buf[1] = 0;
    buf[2] = 0;
    buf[3] = 0; // 全透明黑
    buf[4] = 0;
    buf[5] = 0;
    buf[6] = 0;
    buf[7] = 255;
    expect(averageRgbFromBgra(buf, 2, 1)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('字节不够长 → 全 0，不抛错', () => {
    expect(averageRgbFromBgra(Buffer.alloc(4), 4, 4)).toEqual({ r: 0, g: 0, b: 0 });
    expect(averageRgbFromBgra(null as any, 1, 1)).toEqual({ r: 0, g: 0, b: 0 });
  });
});
