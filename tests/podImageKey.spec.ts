import { describe, expect, it } from 'vitest';
import { imageKeyOf } from '../electron/podImageKey';

/**
 * 图键的守卫（色名塌陷链接的唯一判别证据）。
 *
 * 为什么它是"唯一证据"：真库 7/71 链接里 `Color` 全写 `Picture color`，同一色名下挂 5–12 张
 * 不同的图。3 段键（店+商品+色）会把它们并成一件实物 ⇒ 绑图案时 5–12 个图案并成 1 个 ⇒
 * **整批错印**，而且查不出来（界面上就是"这个款只有一种图案"）。
 *
 * 断言配对原则：认得出 / 认不出两边都钉。只钉"认得出"，把函数改成 `return url` 也是绿的。
 */
describe('imageKeyOf', () => {
  const ID = 'S3f2a1b9c';

  it('四种真实域名形态取到同一个图键', () => {
    // 实测芒果/速卖通返回过这四种写法（换 CDN 前缀不该让键变）
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg`)).toBe(ID);
    expect(imageKeyOf(`//ae01.alicdn.com/kf/${ID}.jpg`)).toBe(ID);
    expect(imageKeyOf(`https://img.alicdn.com/kf/${ID}.png`)).toBe(ID);
    expect(imageKeyOf(`https://ae04.alicdn.com/kf/${ID}.webp`)).toBe(ID);
  });

  it('尺寸后缀 / 查询串 / hash 都不参与身份（同一张图的四种写法必须同键）', () => {
    const bare = imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg`);
    // CDN 尺寸后缀：`xxx.jpg_220x220.jpg` —— id 永远在**第一段**扩展名之前
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg_220x220.jpg`)).toBe(bare);
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg_100x100.jpg`)).toBe(bare);
    // 签名查询串
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg?x-oss-process=image/resize,w_100`)).toBe(
      bare,
    );
    // hash 片段（**不归一化 hash 本身**，只是它不属于图的身份）
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.jpg#frag`)).toBe(bare);
    expect(bare).not.toBe('');
  });

  it('不是 `/kf/` 路径 ⇒ 空串（不拿整串 URL 兜底：签名一变键就变）', () => {
    expect(imageKeyOf(`https://ae01.alicdn.com/other/${ID}.jpg`)).toBe('');
    expect(imageKeyOf(`https://example.com/${ID}.jpg`)).toBe('');
    // 店铺 logo / 买家秀图这类不该被当成商品图纳进键
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}/readme`)).toBe('');
  });

  it('没有扩展名 / 扩展名不是图片 ⇒ 空串（认不出就是认不出，不猜）', () => {
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}`)).toBe('');
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/${ID}.txt`)).toBe('');
    expect(imageKeyOf('')).toBe('');
    expect(imageKeyOf(null)).toBe('');
    expect(imageKeyOf(undefined)).toBe('');
    expect(imageKeyOf(123)).toBe('');
  });

  it('id 段做**大小写敏感**（AE 图床文件名大小写敏感，折叠就是制造假命中）', () => {
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/S3F2A.jpg`)).not.toBe(
      imageKeyOf(`https://ae01.alicdn.com/kf/s3f2a.jpg`),
    );
  });

  it('不同图 ⇒ 不同键（否则塌陷链接又并回一件）', () => {
    expect(imageKeyOf(`https://ae01.alicdn.com/kf/Saaa1.jpg`)).not.toBe(
      imageKeyOf(`https://ae01.alicdn.com/kf/Sbbb2.jpg`),
    );
  });
});
