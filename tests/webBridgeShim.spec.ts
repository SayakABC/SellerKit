// 浏览器预览垫片的结构守卫。
//
// 为什么值得单独盯：这条链的失败方式是**白屏**，而且只在「用浏览器打开」时出现 ——
// 三道常规门禁（tsc / verify / vitest）全都看不见它，Electron 里也复现不了。
// 2026-11-06 实测对照：不带垫片时 `#app` 为空、DOM 2616 字节；带上后 27444 字节、导航齐全。
//
// 守的是**结构性事实**（谁在谁之前、守卫分支存在与否），不钉文案。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INDEX = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHIM = readFileSync(path.join(ROOT, 'public', 'web-bridge.js'), 'utf8');

describe('浏览器预览垫片（public/web-bridge.js）', () => {
  it('index.html 在模块脚本之前同步加载垫片', () => {
    const shimAt = INDEX.indexOf('<script src="/web-bridge.js"></script>');
    const moduleAt = INDEX.indexOf('<script type="module"');
    expect(shimAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(-1);
    // 顺序是硬约束：ipc.ts 在模块求值期就读 window.electronAPI.platform，
    // 垫片排在后面等于没装。
    expect(shimAt).toBeLessThan(moduleAt);
    // 不能带 defer/async，否则同样晚于模块脚本
    expect(/<script[^>]*web-bridge\.js[^>]*(defer|async)/.test(INDEX)).toBe(false);
  });

  it('桥已存在时立即返回（Electron 的 preload 永远优先）', () => {
    expect(SHIM).toMatch(/if\s*\(\s*window\.electronAPI\s*\)\s*return/);
  });

  it('只认 http(s)：打包产物的 file:// 不许被兜底', () => {
    // 若哪天有人把协议守卫删掉，打包版 preload 真挂了会被伪装成"能用"，比白屏更难查。
    expect(SHIM).toContain('/^https?:$/');
    expect(SHIM).toContain('location.protocol');
  });

  it('失败返回 ApiResult 形状（success: false），不给「成功但空」', () => {
    expect(SHIM).toContain('success: false');
    expect(SHIM).not.toMatch(/success:\s*true/);
  });

  it('then / toJSON 不被伪造成函数（否则整座桥被当成 thenable）', () => {
    expect(SHIM).toContain("prop === 'then'");
    expect(SHIM).toContain("prop === 'toJSON'");
  });
});
