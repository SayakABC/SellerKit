// tests/marketCache.spec.ts
// 守「插件市场目录 / 插件包下载必须绕过 HTTP 缓存」这条纪律。
//
// 背景（真机踩到的坑）：`python -m http.server` 之类的静态服务只发 `Last-Modified`、不发
// `Cache-Control`，Chromium（Electron `net` 走的就是它）会对这类响应套用启发式新鲜度
// `freshness = (Date - Last-Modified) × 10%`。catalog.json 隔两天没动，算出的新鲜期就是 5 小时量级，
// 期间宿主刷新市场**连请求都不发**、直接吃旧副本 —— 症状是「新插件已发布，市场里却看不到」。
// 所以两侧都要钉住：请求端 `noCache`（强制回源验证）+ 服务端 `no-store`（源头掐掉）。
//
// ⚠️ 本文件是**源码静态守卫**（同 tests/pluginTriage.spec.ts 风格）：断言的是「代码里必须这么写」，
// 不是运行时行为。运行时那半由 scripts/ui-island-smoke.mjs 与市场端到端探针覆盖。

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('市场下载的缓存纪律', () => {
  const market = read('electron/plugins-market-handlers.ts');
  const httpClient = read('electron/http-client.ts');

  it('市场侧每一处 downloadFile 调用都显式带 noCache: true', () => {
    // 抓 `downloadFile(...)` 的实参串（本文件里调用无嵌套括号，`[^)]*` 足够）
    const calls = [...market.matchAll(/downloadFile\(\s*([^)]*)\)/g)].map((m) => m[1]);
    // catalog 一份 + 插件 zip 一份，少于此数说明有调用点被漏掉/改写了
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      expect(args, `downloadFile(${args}) 缺少 noCache: true`).toMatch(/noCache:\s*true/);
    }
  });

  it('downloadFile 在 noCache 时把 Cache-Control 设成 no-cache（降级为回源验证）', () => {
    expect(httpClient).toMatch(/opts\?\.noCache/);
    expect(httpClient).toMatch(/['"]Cache-Control['"]\s*:\s*['"]no-cache['"]/);
  });

  it('本地市场服务存在且对所有响应发 no-store（不从源头走缓存）', () => {
    const p = new URL('../scripts/serve-market.mjs', import.meta.url);
    expect(
      existsSync(p),
      'scripts/serve-market.mjs 缺失：python -m http.server 无法设置缓存头'
    ).toBe(true);
    const srv = readFileSync(p, 'utf8');
    expect(srv).toMatch(/no-store/);
    // 只认「真正的响应头设置写法」：发了 Last-Modified 就会引出 304 复核路径，与「一律不缓存」相悖。
    // （不能用 /Last-Modified/i 全文件扫——本服务的注释里就要解释这个坑，会误判成假红。）
    expect(srv).not.toMatch(/['"]Last-Modified['"]\s*:/);
    expect(srv).not.toMatch(/['"]ETag['"]\s*:/);
  });

  it('市场侧没有绕过 downloadFile 自行发 HTTP（否则守卫形同虚设）', () => {
    expect(market).not.toMatch(/\bnet\.request\(/);
    expect(market).not.toMatch(/\bhttps?\.request\(/);
  });
});
