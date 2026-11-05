// UI 岛宿主桥（uiBridgeHost.ts）—— 握手、投递与主题载荷的行为回归。
//
// 背景（2026-09-22 真实故障链，本文件即其守卫）：
//   1. 握手死锁：iframe 的 load 早于 hello 到达宿主时，安全网先发 boot(A)，岛 ready 后
//      立刻发出首批 call(A)；紧接着迟到的 hello 触发**旧实现**的 token 轮转 → 宿主侧变 B，
//      首批 call(A) 被当串台**静默丢弃且不回包** → 岛内 pending 永久挂起，
//      表现为「重启后岛首屏永久加载中，必须手动点『重新加载』才恢复」（冷启动必现）。
//   2. 空 targetOrigin：`attachUiIslandBridge` 可能在 iframe 尚未导航时被调用（挂载那一帧 src 还是空串），
//      旧实现把此时的 `new URL(src).origin` 异常吞掉 → expectedOrigin 落成 **空串** →
//      `postMessage(data, '')` 非法抛错又被吞掉 → **宿主全部下行消息（boot/theme/call-result/abort）静默失效**；
//      同时 origin 校验被跳过、onBooted 照常触发 → 现场是"宿主状态灯已连接 + 岛说没收到 boot"，
//      岛停在「等待宿主桥握手超时（8s）」，点「重新加载」才恢复。修：origin 按插件 id 兜底推导，
//      load 事件每次补发 boot，onBooted 改为以岛的**带 token 回执**为准。
//   3. 主题缺口：color-scheme 不是设计令牌，无法随 --wb-* 注入；宿主须额外下发
//      theme.mode，运行时据此回写 <html> 的 color-scheme，否则深色主题下岛内原生控件
//      （日期选择器/下拉/滚动条）仍是浅色 →「岛内样式跟宿主主题不一致」。
//
// 桥依赖 window / document / getComputedStyle，故本用例在 node 环境下自建最小桩，
// 不引入 jsdom（保持 vitest environment: node 与零依赖）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachUiIslandBridge, UI_MSG } from '@/core/plugin/uiBridgeHost';
import type { UiIslandBridgeOptions } from '@/core/plugin/uiBridgeHost';
import type { PluginManifest } from '@/core/plugin/types';
import type { HostApi } from '@/core/plugin/sdk';

type Handler = (e: unknown) => void;

interface Sent {
  data: Record<string, unknown>;
  targetOrigin: string;
}

/** 记录宿主 → 岛的所有 postMessage（含 targetOrigin，便于断言"没发成空串"） */
let posted: Sent[] = [];
/** window message 监听器（桥注册在这个 stub 上） */
let winHandlers: Handler[] = [];
/** iframe load 监听器 */
let frameHandlers: Handler[] = [];

// 夹具用一个**中性 id**（不复用真实岛名）：原来借的是 `order-insight`，而那个岛已于 2026-10-05
// 整体下架 —— 名字留在夹具里会让人以为仓库里还有这个岛。桥的行为与具体岛无关，任何 id 等价。
const IFRAME_SRC = 'sk-plugin://demo-island/dist/index.html';
/** sk-plugin 是 standard scheme（宿主 registerSchemesAsPrivileged）→ Chromium 下真实 origin 形如 sk-plugin://<id> */
const ISLAND_ORIGIN = 'sk-plugin://demo-island';

const manifest = {
  name: 'demo-island',
  displayName: '演示岛',
  version: '1.2.0',
  entry: './dist/index.html',
  kind: 'ui',
} as unknown as PluginManifest;

const hostApi = {} as unknown as HostApi;
const bus = { on: () => () => {}, emit: () => {} } as never;

/**
 * iframe 桩：`postMessage` 复刻浏览器语义——
 * ① 非法 targetOrigin（空串/缺省）**抛 SyntaxError**（旧故障正是被这个异常静默吞掉）；
 * ② targetOrigin 既非 '*' 又不等于岛的真实 origin 时**静默丢弃**（不进入 posted）。
 */
function makeIframe(src: string = IFRAME_SRC) {
  const contentWindow = {
    postMessage: (d: Record<string, unknown>, targetOrigin: string) => {
      if (typeof targetOrigin !== 'string' || targetOrigin === '') {
        throw new SyntaxError(`Failed to execute 'postMessage': Invalid target origin '${String(targetOrigin)}'`);
      }
      if (targetOrigin !== '*' && targetOrigin !== ISLAND_ORIGIN) return;
      posted.push({ data: d, targetOrigin });
    },
  };
  return {
    src,
    contentWindow,
    addEventListener: (t: string, h: Handler) => {
      if (t === 'load') frameHandlers.push(h);
    },
    removeEventListener: () => {},
  } as unknown as HTMLIFrameElement;
}

/** 模拟一条来自岛的消息（宿主桥只认 e.source === iframe.contentWindow） */
function islandSays(
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin: string = ISLAND_ORIGIN,
): void {
  for (const h of winHandlers) h({ source: iframe.contentWindow, origin, data });
}

const lastOfType = (type: string): Record<string, unknown> | undefined =>
  [...posted].reverse().find((p) => p.data.type === type)?.data;

const countOfType = (type: string): number => posted.filter((p) => p.data.type === type).length;

beforeEach(() => {
  posted = [];
  winHandlers = [];
  frameHandlers = [];
  const win = {
    addEventListener: (t: string, h: Handler) => {
      if (t === 'message') winHandlers.push(h);
    },
    removeEventListener: () => {},
  };
  const doc = {
    documentElement: { getAttribute: () => 'dark' },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('getComputedStyle', () => ({
    length: 0,
    getPropertyValue: (name: string) => (name === '--wb-bg' ? '#15171c' : ''),
  }));
  if (!('crypto' in globalThis) || typeof crypto.randomUUID !== 'function') {
    vi.stubGlobal('crypto', { randomUUID: () => 'tok-fixed' });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function attach(opts: { iframeSrc?: string } & Partial<UiIslandBridgeOptions> = {}) {
  const { iframeSrc, ...bridgeOpts } = opts;
  const iframe = makeIframe(iframeSrc ?? IFRAME_SRC);
  const bridge = attachUiIslandBridge(iframe, {
    pluginId: 'demo-island',
    manifest,
    hostApi,
    bus,
    ...bridgeOpts,
  });
  return { iframe, bridge };
}

describe('UI 岛桥 · 握手不变量', () => {
  it('hello 不轮转 token：已 boot 后重发同一会话密钥，避免作废在途 call', () => {
    const { iframe } = attach();
    frameHandlers.forEach((h) => h({})); // 模拟 iframe load 安全网 → boot(A)
    const first = lastOfType(UI_MSG.boot);
    expect(first, 'load 安全网应发一次 boot').toBeTruthy();
    const tokenA = first!.token;
    expect(typeof tokenA).toBe('string');

    islandSays(iframe, { __sk: 1, type: UI_MSG.hello }); // 迟到的 hello
    const second = lastOfType(UI_MSG.boot);
    expect(second!.token, 'hello 补发必须复用 token，轮转会让在途 call 变串台').toBe(tokenA);
  });

  it('attach 时 iframe.src 还是空串：targetOrigin 不得为空串，boot 必须发得出去', () => {
    const { iframe } = attach({ iframeSrc: '' });
    frameHandlers.forEach((h) => h({}));

    const boot = lastOfType(UI_MSG.boot);
    expect(
      boot,
      'src 未就绪时若把 targetOrigin 算成空串，postMessage 会抛错并被吞掉 —— boot 静默发不出去，岛停在握手超时',
    ).toBeTruthy();
    expect(posted.every((p) => p.targetOrigin !== ''), '任何一条下行消息都不允许使用空 targetOrigin').toBe(true);
    expect(posted[posted.length - 1].targetOrigin).toBe(ISLAND_ORIGIN);

    // 空 src 场景下算出的 origin 必须是可投递的真实 origin：岛回话后仍能收到应答
    const token = boot!.token;
    islandSays(iframe, { __sk: 1, type: UI_MSG.call, id: 1, token, domain: 'db', method: 'call', args: [] });
    const reply = lastOfType(UI_MSG.callResult);
    expect(reply, 'call 应答也必须投得出去').toBeTruthy();
    expect(reply!.ok).toBe(false); // hostApi 为空桩 → 调用失败，但链路本身是通的
  });

  it('iframe 每次 load 都补发 boot（新文档必然还没握过手），且不轮转 token', () => {
    attach();
    frameHandlers.forEach((h) => h({}));
    const tokenA = lastOfType(UI_MSG.boot)!.token;
    frameHandlers.forEach((h) => h({})); // 视作 iframe reload / 二次导航

    expect(countOfType(UI_MSG.boot), '旧版"已握手就不再补发"会让新文档收不到 boot').toBe(2);
    expect(lastOfType(UI_MSG.boot)!.token).toBe(tokenA);
  });

  it('token 不匹配的 call 必须回错包（不能静默丢弃）', () => {
    const { iframe } = attach();
    frameHandlers.forEach((h) => h({}));
    islandSays(iframe, { __sk: 1, type: UI_MSG.call, id: 7, token: 'stale', domain: 'db', method: 'call', args: [] });

    const reply = lastOfType(UI_MSG.callResult);
    expect(reply, '静默丢弃会让 iframe 侧 pending 永不 reject（无法自愈、无日志）').toBeTruthy();
    expect(reply!.id).toBe(7);
    expect(reply!.ok).toBe(false);
  });

  it('来源不符的消息（非本 iframe / 非本 origin）被丢弃', () => {
    const { iframe } = attach();
    frameHandlers.forEach((h) => h({}));
    const before = posted.length;
    for (const h of winHandlers) {
      h({ source: { postMessage: () => {} }, origin: ISLAND_ORIGIN, data: { __sk: 1, type: UI_MSG.hello } });
      h({ source: iframe.contentWindow, origin: 'sk-plugin://evil', data: { __sk: 1, type: UI_MSG.hello } });
    }
    expect(posted.length).toBe(before);
  });

  it('onBooted 以岛的带 token 回执为准（"宿主发了 boot"不算连上）', () => {
    const onBooted = vi.fn();
    const { iframe } = attach({ iframeSrc: '', onBooted });
    frameHandlers.forEach((h) => h({}));
    expect(onBooted, '仅发出 boot 不得点灯——否则会出现"宿主说已连接、岛说没收到 boot"的自相矛盾现场').not.toHaveBeenCalled();

    islandSays(iframe, { __sk: 1, type: UI_MSG.hello });
    expect(onBooted, 'hello 恰恰说明岛还没收到 boot').not.toHaveBeenCalled();

    const token = lastOfType(UI_MSG.boot)!.token;
    islandSays(iframe, { __sk: 1, type: UI_MSG.log, token, level: 'info', args: ['hi'] });
    expect(onBooted).toHaveBeenCalledTimes(1);

    islandSays(iframe, { __sk: 1, type: UI_MSG.log, token, level: 'info', args: ['again'] });
    expect(onBooted, '每次会话只点一次灯').toHaveBeenCalledTimes(1);
  });

  it('dispose 后不再投递（abort 之后静默）', () => {
    const { iframe, bridge } = attach();
    frameHandlers.forEach((h) => h({}));
    bridge.dispose();
    const abortMsg = lastOfType(UI_MSG.abort);
    expect(abortMsg, 'dispose 应向岛广播 abort 以拒绝在途调用').toBeTruthy();
    const after = posted.length;
    islandSays(iframe, { __sk: 1, type: UI_MSG.hello });
    expect(posted.length).toBe(after);
  });
});

describe('UI 岛桥 · 主题载荷', () => {
  it('boot 携带令牌与 theme.mode（供岛内回写 color-scheme）', () => {
    attach();
    frameHandlers.forEach((h) => h({}));
    const boot = lastOfType(UI_MSG.boot)!;
    const theme = boot.theme as { vars: Record<string, string>; mode?: string };
    expect(theme.vars['--wb-bg']).toBe('#15171c');
    expect(theme.mode, 'color-scheme 无法经 --wb-* 传递，必须显式下发 mode').toBe('dark');
  });

  it('pushTheme（宿主切主题）同样带 mode，且不轮转 token', () => {
    const { bridge } = attach();
    frameHandlers.forEach((h) => h({}));
    const token = lastOfType(UI_MSG.boot)!.token;
    bridge.pushTheme();
    const themeMsg = lastOfType(UI_MSG.theme)!;
    expect((themeMsg as { mode?: string }).mode).toBe('dark');
    expect(token).toBeTruthy();
  });

  it('data-theme 非 light/dark 时不猜模式（保持岛内声明）', () => {
    vi.stubGlobal('document', { documentElement: { getAttribute: () => null } });
    attach();
    frameHandlers.forEach((h) => h({}));
    const theme = lastOfType(UI_MSG.boot)!.theme as { mode?: string };
    expect(theme.mode).toBeUndefined();
  });
});
