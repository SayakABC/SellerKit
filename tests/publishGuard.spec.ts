// 发布口守卫：**同版本重发布必须被拦下**（2026-09-29）。
//
// 背景（2026-09-28 真实故障）：产品库岛「商品清单」页签没出现，根因不在代码 ——
// 1.4.0 这个版本号被打了两次包，本机装的是旧包。而**版本号是宿主与市场唯一的更新判据**：
//   - electron/plugins-market-handlers.ts: `compareVersions(curVer, item.version) >= 0 && !force` → 直接拒绝安装
//   - src/core/components/PluginCenter.vue: `updateable: cmp < 0` → 按钮不给「更新」
// 于是「同版本换内容」等于「发了等于没发」，已装用户永远拿不到。
//
// 本测试造一个最小 UI 岛，在临时目录里**实跑** scripts/publish-plugin.js：
//   1) 首次发布 → exit 0；
//   2) 同内容重发布 → exit 0（幂等，且产物字节完全相同）；
//   3) 改内容、版本不动 → **exit 1**，且 zip / catalog 一字未动（守卫挡在写之前）；
//   4) 显式 --force → exit 0。
//
// 判据不用 zip 自身 sha256：JSZip 默认给条目打当前时间戳，同内容两次打包字节就不同
// （已实测），故守卫比的是「zip 内每个条目的 路径+字节」摘要。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = resolve(root, 'scripts/publish-plugin.js');

let work = '';
let pluginDir = '';
let outDir = '';
let catalogPath = '';
let zipShaBeforeMutation = '';
const zipPath = () => join(outDir, 'guard-fixture-1.0.0.zip');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function publish(extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      script,
      '--dir',
      pluginDir,
      '--base',
      'http://127.0.0.1:8000',
      '--out',
      outDir,
      '--catalog',
      catalogPath,
      ...extraArgs,
    ],
    { encoding: 'utf8' }
  );
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'sk-publish-guard-'));
  pluginDir = join(work, 'guard-fixture');
  outDir = join(work, 'out');
  catalogPath = join(outDir, 'catalog.json');
  mkdirSync(join(pluginDir, 'dist', 'assets'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'guard-fixture',
        displayName: '守卫夹具',
        version: '1.0.0',
        kind: 'ui',
        entry: './dist/index.html',
      },
      null,
      2
    )
  );
  writeFileSync(join(pluginDir, 'dist', 'index.html'), '<!doctype html><div>v1</div>\n');
  writeFileSync(join(pluginDir, 'dist', 'assets', 'app.js'), 'console.log("v1");\n');
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// 每条用例都要 fork 一个 node 进程实跑脚本（含 require('jszip')），单跑约 0.7s，
// 但全量并行时被同机其他用例挤到 5s+ —— vitest 默认 testTimeout 5000ms 会误判超时。
// 故显式放宽（同 pluginTriage 对重 describe 加 timeout 的处理）。
const T = 30_000;

describe('publish-plugin 同版本重发布守卫', () => {
  it(
    '① 首次发布成功，catalog 的 sha256 与 zip 实际一致',
    () => {
      const r = publish();
      expect(r.status, r.stderr).toBe(0);
      const entry = JSON.parse(readFileSync(catalogPath, 'utf8')).plugins.find(
        (p: { id: string }) => p.id === 'guard-fixture'
      );
      expect(entry.version).toBe('1.0.0');
      expect(entry.sha256).toBe(sha(zipPath()));
    },
    T
  );

  it(
    '② 同内容重发布：幂等放行，且产物字节完全相同（时间戳固定）',
    () => {
      const before = sha(zipPath());
      const r = publish();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('同版本同内容');
      expect(sha(zipPath())).toBe(before);
    },
    T
  );

  it(
    '③ 内容变了、版本不变：拒绝发布，且不写 zip / catalog（非空转）',
    () => {
      const zipBefore = sha(zipPath());
      zipShaBeforeMutation = zipBefore;
      const catalogBefore = readFileSync(catalogPath, 'utf8');
      appendFileSync(join(pluginDir, 'dist', 'assets', 'app.js'), 'console.log("v2");\n');

      const r = publish();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('拒绝发布');
      expect(r.stderr).toContain('version');
      // 关键：守卫在写盘之前 —— 产物一个字都不能动
      expect(sha(zipPath())).toBe(zipBefore);
      expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBefore);
    },
    T
  );

  it(
    '④ 显式 --force 才允许覆盖同版本，且告警说明后果',
    () => {
      const r = publish(['--force']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('--force');
      expect(r.stdout).toContain('sha256');
      // 覆盖真的发生了（产物不再是 ③ 拦下的那份），且 catalog 与新 zip 保持一致
      expect(sha(zipPath())).not.toBe(zipShaBeforeMutation);
      const entry = JSON.parse(readFileSync(catalogPath, 'utf8')).plugins.find(
        (p: { id: string }) => p.id === 'guard-fixture'
      );
      expect(entry.sha256).toBe(sha(zipPath()));
    },
    T
  );
});
