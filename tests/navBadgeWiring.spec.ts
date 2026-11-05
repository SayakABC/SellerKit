// 侧栏徽标 / 「点通知切模块」的接线守卫（2026-11-04）。
//
// 这一层坏掉的**全部**表现都是静默的：侧栏没有数字、点了通知还停在原来那页、未读清零后角标
// 一直挂着 —— 没有异常、没有红日志。而它们的根因都落在"时序/顺序"上，用行为断言抓不到：
//   · 主进程在 `did-finish-load` 重放，渲染层若在 `onMounted` 里**先 await 再注册订阅**就收不到；
//   · `did-finish-load` 触发时 `webContents.isLoading()` 仍为 true，重放若照常判"加载中"会被整批挡掉
//     （这条是本次实现里真实踩到的：15 项端到端验收里 5 项红，改完才绿）。
// 故按本仓既有守卫风格（uiIslandThemeTokens.spec.ts / uiIslandBridgeLifecycle.spec.ts）做静态断言，
// 外加对渲染层登记表的**行为**断言（那部分是纯 TS，能真跑）。
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportNavBadge, navBadgeOf, clearNavBadges } from '@/core/services/navBadge';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const appShell = read('src/core/AppShell.vue');
const uiBridge = read('electron/ui-bridge.ts');
const mainTs = read('electron/main.ts');
const mailScheduler = read('electron/mail-scheduler.ts');
const mailEngine = read('electron/mail-engine.ts');
const mailHandlers = read('electron/mail-handlers.ts');

describe('navBadge 登记表：缺席不是 0', () => {
  beforeEach(() => clearNavBadges());

  it('上报后读得到，`count: null` 表示撤掉（不是记一个 0）', () => {
    reportNavBadge('mail', { count: 3, title: '3 封未读邮件', todo: true });
    expect(navBadgeOf('mail')?.count).toBe(3);
    reportNavBadge('mail', { count: null });
    expect(navBadgeOf('mail')).toBeUndefined();
  });

  it('传 null 也等于撤掉；未知模块读出来是 undefined（侧栏据此不画）', () => {
    reportNavBadge('mail', { count: 2 });
    reportNavBadge('mail', null);
    expect(navBadgeOf('mail')).toBeUndefined();
    expect(navBadgeOf('never-reported')).toBeUndefined();
  });

  it('空 moduleId 不写脏键（广播里 moduleId 被裁空时不该污染侧栏）', () => {
    reportNavBadge('', { count: 5 });
    reportNavBadge('   ', { count: 5 });
    expect(navBadgeOf('')).toBeUndefined();
  });
});

describe('AppShell：订阅时序与渲染', () => {
  const mountStart = appShell.indexOf('onMounted(async () => {');
  const unmountStart = appShell.indexOf('onUnmounted(() => {');
  const mountBlock = appShell.slice(mountStart, unmountStart);
  const unmountBlock = appShell.slice(unmountStart);

  it('onMounted 里必须先注册 nav-badge / open-module 订阅，再做任何 await', () => {
    expect(mountStart, 'AppShell.vue 找不到 onMounted 块').toBeGreaterThan(0);
    // 只认**语句级**的 await（行首缩进后紧跟 await）——注释里写"订阅要在所有 await 之前"
    // 是常见表述，用裸 indexOf('await ') 会把自己的注释当成第一个 await（写完就踩了）。
    const firstAwait = mountBlock.search(/\n\s*await\s/);
    expect(firstAwait, 'onMounted 里一个 await 都没有？先确认这段是不是被整体挪走了').toBeGreaterThan(0);
    const badgeSub = mountBlock.indexOf('ipc.onNavBadge(');
    const openSub = mountBlock.indexOf('ipc.onOpenModule(');
    expect(badgeSub, 'onMounted 里没有注册 onNavBadge 订阅').toBeGreaterThan(0);
    expect(openSub, 'onMounted 里没有注册 onOpenModule 订阅').toBeGreaterThan(0);
    expect(
      badgeSub < firstAwait && openSub < firstAwait,
      '主进程在 did-finish-load 重放徽标/打开意图；订阅一旦晚于 onMounted 的第一个 await，\n' +
        '冷启动那一批就会被静默丢弃 —— 表现为"侧栏没有未读角标""点通知没反应"。',
    ).toBe(true);
  });

  it('卸载时必须退订（否则 HMR / 重挂载会累积重复监听，徽标跳变）', () => {
    expect(unmountBlock).toMatch(/stopNavBadge\?\.\(\)/);
    expect(unmountBlock).toMatch(/stopOpenModule\?\.\(\)/);
  });

  it('模块行必须把 moduleBadge 拼进去，模板必须画徽标（数据在但 DOM 没有 = 静默坏）', () => {
    expect(appShell, 'navRows 的模块行没有拼 ...moduleBadge(...)').toMatch(/\.\.\.moduleBadge\(/);
    expect(appShell, '模板里没有一级入口徽标的渲染块').toContain('row.count !== undefined');
    // 收起态（仅图标）也要有点：48px 里塞不下数字，但完全看不见更糟
    expect(appShell, '收起态缺"圆点"退化（用户看不到还有未读）').toMatch(/collapsed[\s\S]{0,200}absolute top-1 right-1/);
  });

  it('打开意图不能走 activateFromSwitch（那不是业务流跳转，不该出现「返回」到用户上次那页）', () => {
    const fnStart = appShell.indexOf('async function applyOpenModule');
    const fnBlock = appShell.slice(fnStart, appShell.indexOf('\n}', fnStart));
    expect(fnStart).toBeGreaterThan(0);
    expect(fnBlock).not.toContain('activateFromSwitch');
    expect(fnBlock).toMatch(/pm\.has\(/);
  });
});

describe('主进程：推送链路不许有断点', () => {
  it('ui-bridge 的重放必须绕过 isLoading（did-finish-load 时它仍是 true）', () => {
    const flushStart = uiBridge.indexOf('export function flushUiBridge');
    const flushBlock = uiBridge.slice(flushStart, uiBridge.indexOf('\n}', flushStart));
    expect(flushStart).toBeGreaterThan(0);
    // 两条重放都要带 force=true，漏一条就是"某类消息永远收不到"
    expect(
      flushBlock.match(/, true\)/g)?.length ?? 0,
      'flushUiBridge 里的 send 必须带 force=true：did-finish-load 触发时 isLoading() 仍为 true，\n' +
        '照常判断会让整批重放被挡掉（本次实现真实踩过）。',
    ).toBe(2);
  });

  it('main.ts 要注入窗口引用、在 did-finish-load 重放、并给出「打开邮件」入口', () => {
    expect(mainTs).toContain('uiBridge.setUiBridgeWindow(() => mainWindow)');
    expect(mainTs).toMatch(/did-finish-load[\s\S]{0,200}flushUiBridge\(\)/);
    expect(mainTs).toContain("uiBridge.openModule('mail')");
    expect(mainTs).toMatch(/openInbox: openMailInbox/);
  });

  it('通知点击走「拿出来 + 切到邮件」，不是只 show 窗口', () => {
    const clickStart = mailScheduler.indexOf("notice.on('click'");
    const clickBlock = mailScheduler.slice(clickStart, clickStart + 400);
    expect(clickStart).toBeGreaterThan(0);
    expect(clickBlock, '点通知只 show 窗口的话，用户还得自己找侧栏点一下').toContain('openInbox');
  });

  it('未读数的每个变化点都要推徽标（漏一处 = 角标与页头对不上）', () => {
    // 同步收尾
    expect(mailEngine).toContain('publishMailUnreadBadge()');
    // 本地已读（两个分支）/ 清理 / 解绑账号
    const calls = (mailHandlers.match(/publishMailUnreadBadge\(\)/g) ?? []).length;
    expect(
      calls,
      'mail-handlers 里至少要有 4 处推送：按 ids 已读、按账号/全部已读、清理超窗邮件、解绑账号。' +
        '少一处就会出现"用户点开信了，侧栏角标还挂着"。',
    ).toBeGreaterThanOrEqual(4);
  });
});
