// UI 岛 manifest 能力声明 × 宿主权限门 —— 钉住「声明写法」与「门判定口径」的一致性。
//
// 背景（2026-09-17 真实故障）：宿主权限门对 ctx.host.clipboard.writeText 请求的动作名是
// `clipboard.write`（见 gatedHost.ts），而当时的 shop-accounts / order-insight 的 manifest
// 声明成了 `["writeText"]`，结果点了复制就报「动作越权: clipboard.write 不在声明白名单 [writeText]」。
// 这类错误只在运行时暴露、且错误信息不指向 manifest，故在这里用真实 decidePermission 兜住。
//
// ⚠️ 这里的岛清单要跟着 `ui-plugins/` 走：`order-insight` 已于 2026-10-05 整体下架，
//    现换成 `excel-copy`（同为**手写 dist 岛**）。每项的第三个值是该岛**真实声明的**一个 db 动作
//    —— 显式写出来，不从 manifest 里现取（现取会让断言变成"拿声明去验声明"，恒真）。
import { describe, it, expect } from 'vitest';
import { decidePermission } from '@/core/plugin/security';
import { validateExternalManifest } from '@/core/plugin/externalManifest';
import type { PluginManifest } from '@/core/plugin/types';
import shopAccounts from '../ui-plugins/shop-accounts/manifest.json';
import excelCopy from '../ui-plugins/excel-copy/manifest.json';

const check = (pluginId: string, manifest: unknown, req: Parameters<typeof decidePermission>[2]) =>
  decidePermission(pluginId, manifest as PluginManifest, req);

/** [岛 id, manifest, 一个该岛真实声明的 db 动作] */
const ISLANDS: Array<[string, unknown, string]> = [
  ['shop-accounts', shopAccounts, 'list'],
  ['excel-copy', excelCopy, 'parseExcel'],
];

describe('UI 岛 manifest 能力声明应通过宿主权限门', () => {
  it.each(ISLANDS)('%s：clipboard.writeText（门按 clipboard.write 判定）放行', (id, m) => {
    expect(check(id, m, { capability: 'clipboard', action: 'write' }).ok).toBe(true);
  });

  it.each(ISLANDS)('%s：storage 自身命名空间放行', (id, m) => {
    expect(check(id, m, { capability: 'storage', action: 'load', namespace: id }).ok).toBe(true);
  });

  it.each(ISLANDS)('%s：db 业务域放行', (id, m, act) => {
    expect(check(id, m, { capability: 'db', domain: id, action: act }).ok).toBe(true);
  });
});

// 岛设置贡献（manifest.settings → 宿主设置中心）：校验器负责归一化，分类由 managerSettings 聚合。
describe('UI 岛 manifest.settings 校验与归一化', () => {
  it('shop-accounts 声明了设置入口且入口在 ./dist 下', () => {
    const settings = (shopAccounts as { settings?: { entry?: string } }).settings;
    expect(settings?.entry).toBe('./dist/settings.html');
  });

  it('entry 缺失 / 非相对路径 / 含 .. 一律拒收，合法项被归一化', () => {
    const base = {
      name: 'demo-island',
      displayName: 'Demo',
      version: '1.0.0',
      engines: { sellerkit: '>=1.0.0' },
      entry: './dist/index.html',
      kind: 'ui',
    };
    // 合法：entry 透传 + 展示字段裁剪
    const okRes = validateExternalManifest({
      ...base,
      settings: { entry: './dist/settings.html', displayName: '设置', icon: 'key', order: 50 },
    });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.manifest.settings).toEqual({
        entry: './dist/settings.html',
        displayName: '设置',
        icon: 'key',
        order: 50,
      });
    }

    // 非法：绝对路径/穿越路径
    for (const bad of ['./dist/../secret.html', '/abs/settings.html']) {
      const badRes = validateExternalManifest({ ...base, settings: { entry: bad } });
      expect(badRes.ok).toBe(false);
    }

    // 非 ui 形态：settings 被忽略（不报错、不贡献）
    const moduleRes = validateExternalManifest({
      ...base,
      kind: undefined,
      settings: { entry: './dist/settings.html' },
    });
    expect(moduleRes.ok).toBe(true);
    if (moduleRes.ok) expect(moduleRes.manifest.settings).toBeUndefined();
  });
});

// 真实投产 manifest 必须整体通过校验器的 schema 校验。
//
// 背景（2026-09-21 真实故障）：order-insight 跨 order-insight/purchase 两个业务域声明了
// 58 个 db 动作，而 checkStrArray 的 actions 条数上限当时是 32 → 安装期判定 manifest 非法，
// **整个插件加载失败**，宿主只报「capabilities.db.actions 条数超限（≤32）」。
// 此前本文件虽然 import 了两个真实 manifest，却只对它们做权限门断言、从未跑 schema 校验，
// 于是这类错误一路漏到运行时。这里补上这道闸。
describe('投产 manifest 应通过 schema 校验', () => {
  it.each(ISLANDS)('%s：validateExternalManifest 通过', (id, m) => {
    const res = validateExternalManifest(m);
    expect(res.ok, res.ok ? '' : `[${id}] ${res.error}`).toBe(true);
  });

  it.each(ISLANDS)('%s：声明的 db 动作数不超过校验器上限', (id, m) => {
    const db = (m as PluginManifest).capabilities?.find((c) => c.id === 'db');
    // 仅作规模提示：真正拦住超限的是上面的 schema 校验，这里失败说明上限需要重新评估
    expect((db?.actions ?? []).length, `[${id}] db 动作数已逼近上限，请评估 MAX_ACTIONS`).toBeLessThan(120);
  });
});
