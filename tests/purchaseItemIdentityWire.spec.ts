// 拿货明细行的**款色身份**必须穿过 IPC 消毒层（静态守卫）。
//
// 背景（2026-11-02 用户实报「生成拿货单后还要在单子里再设置颜色」）：
//   渲染层 `createFromPick` 已经把 `styleColorId` 放进明细；`purchase-db.insertItems` 也写这一列。
//   但 preload 与主进程各自有一份 `sanitizeItems` 白名单 —— 两份都漏了这个字段 ⇒
//   落库恒为 `style_color_id = 0` ⇒ 编辑器按「色未定」处理（该款多色时逐行要求选色），
//   `takenFrom` 也只能回落色名文本。症状不在界面上报错，只在"每次都要再选一遍"里。
//
// 为什么是静态断言：preload 依赖 Electron 的 `ipcRenderer`、handler 依赖 `ipcMain`，
// 在 vitest 里无法直接 import；而这条链的断点恰好就是"某个字段有没有出现在白名单里"。
// 剥注释后再查，防止注释里写一句 `styleColorId` 就骗过守卫。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** 剥掉 `//` 行注释与块注释（保留字符串字面量内容） */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (str) {
      if (c === '\\') {
        out += c + (n ?? '');
        i += 2;
        continue;
      }
      if (c === str) str = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      str = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 取从 marker 开始到第一个 endMarker 为止的代码块（找不到返回空串，断言会直接红） */
function blockAfter(src: string, marker: string, endMarker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + marker.length);
  return end < 0 ? '' : src.slice(start, end + endMarker.length);
}

const preload = stripComments(read('electron/preload.ts'));
const handlers = stripComments(read('electron/purchase-handlers.ts'));

describe('拿货明细的款色身份穿过 IPC 消毒层', () => {
  it('preload 的 sanitizePurchaseItems 保留 styleColorId', () => {
    const body = blockAfter(preload, 'const sanitizePurchaseItems', '\n};');
    expect(body, 'preload.ts 的明细白名单漏了 styleColorId —— 新建/保存的拿货单都会掉成「色未定」').toContain(
      'styleColorId',
    );
  });

  it('主进程的 sanitizeItems 保留 styleColorId', () => {
    const body = blockAfter(handlers, 'function sanitizeItems', '\n}');
    expect(body, 'purchase-handlers.ts 的明细白名单漏了 styleColorId —— 即使 preload 透传，落库仍是 0').toContain(
      'styleColorId',
    );
  });
});
