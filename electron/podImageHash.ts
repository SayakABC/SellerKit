// electron/podImageHash.ts
// 「图片长相」的三个纯函数（**不依赖 Electron**，vitest 可直接覆盖）。
//
// 为什么图案模块需要它：用户反馈"图案认领全靠肉眼，看不出两个颜色是不是同一种图案"。
// 真正能自动判断"两张图看起来一样"的，不是文件名、不是色名，而是**像素本身**。
// 本文件只提供三个最便宜、最可解释的像素特征：
//   ① `dhash`       —— 感知哈希（9×8 灰度图相邻像素比大小 → 64 位），结构/构图相似即相近；
//   ② `averageRgb`  —— 平均颜色，区分"同构图不同配色"；
//   ③ `hammingDistance` —— 两个 dhash 差几位（0 = 结构几乎一致）。
//
// ⚠️ 这里**只做建议**：输出永远交给用户确认后才绑定。图案认错 = 整批花纸报废，
//    所以本模块不提供"自动绑定"的入口（红线见 `docs/plans/POD_PATTERN_PIPELINE_PLAN.md`）。
//
// 像素格式按 `nativeImage.toBitmap()` 返回的 **BGRA**（B,G,R,A，每像素 4 字节，行优先）：
// 主进程在 `pod-handlers.ts` 里把图缩到 9×8 再喂进来。纯函数不 import electron，
// 是为了让"哈希算法本身"能被单测钉住 —— 它一旦改了，历史建议的相似度就不可比。

/** BGRA 像素里取亮度（BT.601 权重；用同样的权重才能让不同图可比） */
function lumaAt(pixels: Buffer | Uint8Array, offset: number): number {
  const b = pixels[offset] ?? 0;
  const g = pixels[offset + 1] ?? 0;
  const r = pixels[offset + 2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 差分感知哈希（dHash）：每行相邻像素比大小，得到 `(width-1) × height` 位。
 *
 * 默认 9×8 → 64 位 → 16 个十六进制字符（与 `hammingDistance` 的输入形状对应）。
 * 与常见 dHash 实现一致：**先缩到 9×8 再比**，所以它认的是构图/明暗结构，不是分辨率。
 */
export function dHashFromBgra(pixels: Buffer | Uint8Array, width = 9, height = 8): string {
  const w = Math.max(2, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const need = w * h * 4;
  if (!pixels || pixels.length < need) return '';
  let hex = '';
  let nibble = 0;
  let bitCount = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const a = lumaAt(pixels, (y * w + x) * 4);
      const b = lumaAt(pixels, (y * w + x + 1) * 4);
      nibble = (nibble << 1) | (a > b ? 1 : 0);
      bitCount += 1;
      if (bitCount === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitCount = 0;
      }
    }
  }
  // 位数不是 4 的整数倍时把最后一组补零（9×8 恒为 64 位，这里只是兜底）
  if (bitCount > 0) hex += (nibble << (4 - bitCount)).toString(16);
  return hex;
}

/** 每个半字节的 1 的个数（汉明距离用） */
const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * 两个 dHash 差几位（0..64）。
 * 形状不合法（空串 / 非十六进制 / 长度不同）返回 64（= 最不相似），不抛错 ——
 * 调用方是在"建议分组"里跑它，一张坏图不该让整批建议消失。
 */
export function hammingDistance(a: string, b: string): number {
  const x = String(a ?? '')
    .trim()
    .toLowerCase();
  const y = String(b ?? '')
    .trim()
    .toLowerCase();
  if (!x || !y || x.length !== y.length) return 64;
  if (!/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y)) return 64;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    const va = parseInt(x[i] as string, 16);
    const vb = parseInt(y[i] as string, 16);
    diff += POPCOUNT4[va ^ vb] ?? 0;
  }
  return diff;
}

/**
 * 平均颜色（0..255 的 r/g/b；忽略 alpha）。
 * 用途不是"显示这个颜色"，而是把"同构图不同配色"区分开：粉底 vs 黑底的花纹 dHash 可能很像，
 * 但主色差得远 —— 分组时必须两道门槛一起过。
 */
export function averageRgbFromBgra(
  pixels: Buffer | Uint8Array,
  width: number,
  height: number
): { r: number; g: number; b: number } {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const need = w * h * 4;
  if (!pixels || pixels.length < need) return { r: 0, g: 0, b: 0 };
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const n = w * h;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    sb += pixels[o] ?? 0;
    sg += pixels[o + 1] ?? 0;
    sr += pixels[o + 2] ?? 0;
  }
  return {
    r: Math.round(sr / n),
    g: Math.round(sg / n),
    b: Math.round(sb / n),
  };
}
