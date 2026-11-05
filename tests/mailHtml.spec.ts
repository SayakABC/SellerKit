import { describe, expect, it } from 'vitest';
import {
  collectCidRefs,
  countRemoteImages,
  needsInlineBackfill,
  normalizeContentId,
  rewriteCidRefs,
} from '../electron/mail-html';

// 邮件正文里的图片能不能显示，全押在这一层纯函数上（宿主渲染通道 sk-mail:// 直接消费它的输出）。
// 每个 it 都刻意用「只有该分支能到达」的输入：三条引号路径、URL 编码路径、无法映射路径互不兜底。

describe('normalizeContentId', () => {
  it('剥掉 mailparser 带的尖括号', () => {
    expect(normalizeContentId('<image001.png@01D9A>')).toBe('image001.png@01D9A');
  });

  it('同时剥掉引号（引用侧可能写成 "<...>"）', () => {
    expect(normalizeContentId('"<image001.png@01D9A>"')).toBe('image001.png@01D9A');
  });

  it('先反转义再剥括号（少数服务商把 cid 整体 URL 编码）', () => {
    expect(normalizeContentId('%3Cimage001.png%4001D9A%3E')).toBe('image001.png@01D9A');
  });

  it('空值/无括号的裸串原样返回', () => {
    expect(normalizeContentId('')).toBe('');
    expect(normalizeContentId(undefined)).toBe('');
    expect(normalizeContentId('plain@id')).toBe('plain@id');
  });
});

describe('collectCidRefs', () => {
  it('三种引号形态 + background + CSS url() 都要认出来', () => {
    const html =
      '<img src="cid:double@x">' +
      "<img src='cid:single@x'>" +
      '<img src=cid:bare@x>' +
      '<body background="cid:bg@x">' +
      '<div style="background:url(cid:css@x)"></div>';
    expect(collectCidRefs(html).sort()).toEqual(['bare@x', 'bg@x', 'css@x', 'double@x', 'single@x']);
  });

  it('不去动 data-src（`\\b` 会把 data-src 的 src 当成同名属性）', () => {
    expect(collectCidRefs('<img data-src="cid:lazy@x" src="cid:real@x">')).toEqual(['real@x']);
  });

  it('重复引用只收一条，非 cid 的 src 一律忽略', () => {
    expect(collectCidRefs('<img src="cid:a@x"><img src="cid:a@x"><img src="https://e.com/a.png">')).toEqual([
      'a@x',
    ]);
  });
});

describe('rewriteCidRefs', () => {
  // 用显式 id 映射而不是"按 cid 长度拼串"：断言里出现的就是期望值本身，改坏一眼能看出
  const ids: Record<string, number> = {
    'double@x': 1,
    's@x': 2,
    'bare@x': 3,
    'bg@x': 4,
    'u@x': 5,
    'hit@x': 6,
  };
  const resolve = (cid: string): string | null =>
    cid === 'miss@x' ? null : `sk-mail://att/7/${ids[cid] ?? 0}`;

  it('三种引号形态都改写且保留原引号', () => {
    const out = rewriteCidRefs(
      '<img src="cid:double@x"><img src=\'cid:s@x\'><img src=cid:bare@x>',
      resolve,
    );
    expect(out.replaced).toBe(3);
    expect(out.unmapped).toBe(0);
    expect(out.html).toContain('src="sk-mail://att/7/1"');
    expect(out.html).toContain("src='sk-mail://att/7/2'");
    expect(out.html).toContain('src=sk-mail://att/7/3'); // 裸值形态不补引号
  });

  it('background 属性与 CSS url() 同样改写（背景图是营销邮件的主要图片形态）', () => {
    const out = rewriteCidRefs('<body background="cid:bg@x"><div style="background:url(cid:u@x)"></div>', resolve);
    expect(out.replaced).toBe(2);
    expect(out.html).toContain('background="sk-mail://att/7/4"');
    expect(out.html).toContain('url("sk-mail://att/7/5")');
  });

  it('映射不上的 cid 保留原样并计数（不静默改成空 src）', () => {
    const out = rewriteCidRefs('<img src="cid:miss@x"><img src="cid:hit@x">', resolve);
    expect(out.unmapped).toBe(1);
    expect(out.replaced).toBe(1);
    expect(out.html).toContain('src="cid:miss@x"');
    expect(out.html).toContain('src="sk-mail://att/7/6"');
  });

  it('URL 编码过的引用也能命中（与 normalizeContentId 同口径）', () => {
    const out = rewriteCidRefs('<img src="cid:%3Ca%4001D%3E">', (cid) => `ok:${cid}`);
    expect(out.replaced).toBe(1);
    expect(out.html).toContain('src="ok:a@01D"');
  });

  it('data-src 与 data: 图片都不动', () => {
    const out = rewriteCidRefs('<img data-src="cid:x@x" src="data:image/png;base64,AAA">', resolve);
    expect(out.replaced).toBe(0);
    expect(out.html).toContain('data-src="cid:x@x"');
    expect(out.html).toContain('src="data:image/png;base64,AAA"');
  });
});

describe('countRemoteImages', () => {
  it('img 标签的 http/https/协议相对地址都算远程图', () => {
    const html =
      '<img src="https://a.com/1.png"><img src="http://b.com/2.png"><img src="//c.com/3.png">' +
      '<img src="cid:x@y"><img src="data:image/png;base64,AA">';
    expect(countRemoteImages(html)).toBe(3);
  });

  it('CSS 背景图也算（否则只有背景图的邮件点不出「显示远程图片」）', () => {
    expect(countRemoteImages('<div style="background:url(https://a.com/bg.png)"></div>')).toBe(1);
    expect(countRemoteImages('<div style="background:url(cid:bg@x)"></div>')).toBe(0);
  });

  it('纯内联图正文计 0（决定不放行入口是否出现）', () => {
    expect(countRemoteImages('<img src="cid:a@x"><p>hi</p>')).toBe(0);
    expect(countRemoteImages('')).toBe(0);
  });
});

describe('needsInlineBackfill', () => {
  const withCid = '<img src="cid:a@x">';

  it('正文引用了 cid 且附件行全无 content_id → 需要重解析回填', () => {
    expect(
      needsInlineBackfill({ htmlBody: withCid, attachments: [{ contentId: '' }, { contentId: '' }] }),
    ).toBe(true);
  });

  it('任一行已有 content_id → 说明已在新口径下解析过，不再重拉', () => {
    expect(needsInlineBackfill({ htmlBody: withCid, attachments: [{ contentId: 'a@x' }] })).toBe(false);
  });

  it('没有附件 / 没有 cid 引用 / 没有详情 → 不触发', () => {
    expect(needsInlineBackfill({ htmlBody: withCid, attachments: [] })).toBe(false);
    expect(needsInlineBackfill({ htmlBody: '<p>纯文本</p>', attachments: [{ contentId: '' }] })).toBe(false);
    expect(needsInlineBackfill(null)).toBe(false);
    expect(needsInlineBackfill(undefined)).toBe(false);
  });
});
