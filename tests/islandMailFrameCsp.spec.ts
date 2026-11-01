// tests/islandMailFrameCsp.spec.ts
//
// 守卫：**凡是要嵌邮件正文的页面，两层 CSP 都必须放行 `frame-src sk-mail:`**。
//
// 为什么单独立一条（2026-10-04 实测事故）：
//   邮件正文跑在宿主的 `sk-mail://` 独立来源文档里（见 docs/notes/2026-10-30-mail-and-today-pages.md）。
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
//
// 2026-10-14 改造（`shop-accounts` 由 UI 岛回收为内建模块）：
//   嵌正文的主体从"岛"变成了**宿主内建模块**（`src/modules/shop-accounts/components/MailInboxView.vue`），
//   于是扫描面扩到两处，而**第二层的适用性分叉**：
//     · 岛（ui-plugins/<id>）：自己带 index.html ⇒ 第二层必须放行；
//     · 内建模块（src/modules/<id>）：跑在宿主 `index.html` 里，而宿主 index.html **没有 CSP meta** ⇒
//       不存在第二层（该前提由下方用例单向钉住：一旦有人给宿主加了 CSP meta，这条会红，提醒补 frame-src）。
//   「自证非空转」的锚点也随之改钉到内建模块那一侧 —— 否则岛列表一空，整条用例就变成空转。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'ui-plugins');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');
const HOST_PROTOCOL = path.join(ROOT, 'electron', 'plugin-ui-protocol.ts');
const HOST_INDEX = path.join(ROOT, 'index.html');

/** 递归判断目录下源码里是否出现 `sk-mail://`（跳 node_modules / dist / 隐藏目录） */
function dirUsesMail(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dirUsesMail(p)) return true;
    } else if (
      /\.(ts|vue|js|mts|cts)$/.test(e.name) &&
      fs.readFileSync(p, 'utf8').includes('sk-mail://')
    ) {
      return true;
    }
  }
  return false;
}

/** 取 index.html 的 meta CSP 的 content（按**引号配对**取值；CSP 里全是 'self'，用 `[^"']*` 会截断 ⇒ 恒绿） */
function metaCspOf(htmlPath: string): { hasMeta: boolean; metaCsp: string } {
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const m = html.match(
    /http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i,
  );
  return { hasMeta: !!m, metaCsp: m ? (m[1] ?? m[2] ?? '') : '' };
}

/** 收集期（不受 testTimeout 管）把磁盘 I/O 做完，`it` 里只留断言 —— 见 docs/notes/2026-10-03 */
function collect() {
  const islands = fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => dirUsesMail(path.join(PLUGINS_DIR, id, 'src')))
    .map((id) => ({ id, ...metaCspOf(path.join(PLUGINS_DIR, id, 'index.html')) }));

  const hostModules = fs
    .readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => dirUsesMail(path.join(MODULES_DIR, id)));

  const hostSrc = fs.readFileSync(HOST_PROTOCOL, 'utf8');
  // UI_CSP 的实际取值（模板拼接，故取字符串字面量再拼）
  const cspLiterals = [...hostSrc.matchAll(/["']([^"']*(?:default-src|frame-src)[^"']*)["']/g)].map(
    (m) => m[1],
  );
  const hostIndex = metaCspOf(HOST_INDEX);
  return { islands, hostModules, hostUiCsp: cspLiterals.join(' '), hostIndex };
}

const { islands, hostModules, hostUiCsp, hostIndex } = collect();

describe('邮件正文 iframe 的两层 CSP', () => {
  it('扫到了"要嵌正文的页面"（否则本用例是空转的）', () => {
    // 锚点跟着**嵌正文的主体**走：原为岛 `shop-accounts`（该岛 2026-10-14 回收为内建模块）
    // ⇒ 2026-10-17 邮件独立成一级模块后，嵌正文的主体是 `src/modules/mail`（`sk-mail://` 就在那里）；
    // 岛列表为空是当前事实（剩余几个岛都不嵌正文）。
    expect(hostModules).toContain('mail');
    expect(hostModules.length + islands.length).toBeGreaterThan(0);
  });

  it('宿主侧 UI_CSP 放行 frame-src sk-mail:（第一层）', () => {
    expect(hostUiCsp).toMatch(/frame-src[^;]*sk-mail:/);
  });

  it('每个嵌正文的岛，其 index.html 的 meta CSP 也放行 frame-src sk-mail:（第二层，最易漏）', () => {
    const detail = islands
      .map(
        (w) =>
          `${w.id}: ${w.hasMeta ? (w.metaCsp.match(/frame-src[^;]*/)?.[0] ?? '(无 frame-src)') : '(无 meta CSP)'}`,
      )
      .join('\n');
    const bad = islands.filter((w) => !w.hasMeta || !/frame-src[^;]*sk-mail:/.test(w.metaCsp));
    expect(bad.map((w) => w.id), `缺 frame-src sk-mail: 的岛 ——\n${detail}`).toEqual([]);
  });

  it('宿主 index.html 没有 CSP meta —— 内建模块因此不需要第二层（有人加了就必须回来补 frame-src）', () => {
    // 这条不是形式检查：宿主页一旦有了 CSP meta 且其 frame-src 未放行 sk-mail:，
    // 内建模块的邮件正文区会**整块空白且无提示**（与 2026-10-04 的岛事故同型）。
    expect(
      hostIndex.hasMeta,
      '宿主 index.html 出现了 CSP meta：请确认其 frame-src 放行 sk-mail:，并同步更新本守卫',
    ).toBe(false);
  });
});
