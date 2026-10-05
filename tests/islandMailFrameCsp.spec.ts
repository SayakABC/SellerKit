// tests/islandMailFrameCsp.spec.ts
//
// 守卫：**凡是要嵌邮件正文的岛，两层 CSP 都必须放行 `frame-src sk-mail:`**。
//
// 为什么单独立一条（2026-10-04 实测事故）：
//   邮件正文跑在宿主的 `sk-mail://` 独立来源文档里（见 docs/notes/2026-10-04-mail-inline-images.md）。
//   它能被嵌进去，需要**同时**满足两层 CSP —— CSP 是取交集的，任何一层缺这条就直接废掉整个 Frame：
//     ① 宿主下发到岛页面的响应头 `UI_CSP`（electron/plugin-ui-protocol.ts）
//     ② **岛自带的 index.html 里的 `<meta http-equiv="Content-Security-Policy">`**
//   ② 是最容易漏的一层：岛作者写 meta CSP 时只想着"能不能引 JS/图片"，而 `frame-src` 缺失会回落到
//   `default-src 'self'`，于是 `sk-mail://body/...` 被判成外源 → `ERR_BLOCKED_BY_CSP`。
//   症状是**正文区整块空白**，界面上没有任何提示，只有 Electron 日志里一行
//   `Failed to load URL: sk-mail://body/... with error: ERR_BLOCKED_BY_CSP` ——
//   本轮就是靠真机抓这行才定位到（冒烟的宿主页只带了头 CSP，故一直是绿的）。
//
// 判据形状要点：**必须解析 meta 的 content 属性**，不能在整份 HTML 里搜子串 ——
// index.html 里通常会留一行"勿删 frame-src sk-mail:"的注释，搜子串的话删掉真指令也照样绿。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'ui-plugins');
const HOST_PROTOCOL = path.join(ROOT, 'electron', 'plugin-ui-protocol.ts');

/** 收集期（不受 testTimeout 管）把磁盘 I/O 做完，`it` 里只留断言 —— 见 docs/notes/2026-10-03 */
function collect() {
  const islands = fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  /** 源码里出现 `sk-mail://` 的岛 = 真的要嵌邮件正文的那些（其余岛不必放行 frame-src） */
  const wallets = islands
    .map((id) => {
      const srcDir = path.join(PLUGINS_DIR, id, 'src');
      let usesMail = false;
      if (fs.existsSync(srcDir)) {
        const walk = (dir: string): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|vue|js|mts|cts)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('sk-mail://')) {
              usesMail = true;
            }
          }
        };
        walk(srcDir);
      }
      const htmlPath = path.join(PLUGINS_DIR, id, 'index.html');
      const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
      // 只取 meta 的 content 属性值；注释/说明里出现同样的字样不算。
      // ⚠️ 取值必须按**引号配对**：CSP 内容里含大量单引号（'self'），用 `[^"']*` 会在
      //    第一个 `'` 处截断，只拿到 "default-src " —— 那样本守卫会**恒绿**（实测踩过）。
      const m = html.match(
        /http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i,
      );
      return { id, usesMail, hasMeta: !!m, metaCsp: m ? m[1] ?? m[2] ?? '' : '' };
    })
    .filter((x) => x.usesMail);

  const hostSrc = fs.readFileSync(HOST_PROTOCOL, 'utf8');
  // UI_CSP 的实际取值（模板拼接，故取字符串字面量再拼）
  const cspLiterals = [...hostSrc.matchAll(/["']([^"']*(?:default-src|frame-src)[^"']*)["']/g)].map((m) => m[1]);
  return { wallets, hostUiCsp: cspLiterals.join(' ') };
}

const { wallets, hostUiCsp } = collect();

describe('邮件正文 iframe 的两层 CSP', () => {
  it('扫到了"要嵌正文的岛"（否则本用例是空转的）', () => {
    expect(wallets.map((w) => w.id)).toContain('shop-accounts');
  });

  it('宿主侧 UI_CSP 放行 frame-src sk-mail:（第一层）', () => {
    expect(hostUiCsp).toMatch(/frame-src[^;]*sk-mail:/);
  });

  it('每个嵌正文的岛，其 index.html 的 meta CSP 也放行 frame-src sk-mail:（第二层，最易漏）', () => {
    const detail = wallets
      .map((w) => `${w.id}: ${w.hasMeta ? (w.metaCsp.match(/frame-src[^;]*/)?.[0] ?? '(无 frame-src)') : '(无 meta CSP)'}`)
      .join('\n');
    const bad = wallets.filter((w) => !w.hasMeta || !/frame-src[^;]*sk-mail:/.test(w.metaCsp));
    expect(bad.map((w) => w.id), `缺 frame-src sk-mail: 的岛 ——\n${detail}`).toEqual([]);
  });
});
