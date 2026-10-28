// 「采集已入库」广播接线守卫 —— 钉住一条五环链上的静默失效点。
//
// 背景（2026-10-15 用户报障「显示采集到 8 条数据，但在店铺商品中没有数据」）：
//   扩展采到 8 条、库里也有 8 行（shop_id=4 归店成功），但「货与成本 › 店铺商品」页一片空白。
//   根因不是数据链：采集是**外部进程**（Chrome 扩展）写库，已打开的宿主页面毫无感知 ——
//   用户采集前打开的分段、渲染的还是旧状态，不手动刷新就永远看不到新数据。
//   修法：接收端落库后广播 `ae-items-ingested`，页面订阅并重拉。
//
// 这条链有五环，**缺任何一环都不报错**（send/on 都写着、verify 全绿，功能却是死的）：
//   ① handleItemsIngest 成功路径调 emitItemsIngested（写了函数没调用 = 死）
//   ② emit 里 send('ae-items-ingested')          （事件名改一处忘一处 = 失联）
//   ③ main.ts 注入窗口引用                        （漏 = 广播永远静默不发：isDestroyed/getWindow 判空直接 return）
//   ④ preload 订阅并返回退订函数                  （verify 覆盖 ②↔④ 对称，但退订漏了会泄漏监听）
//   ⑤ useSkuPool 订阅                             （漏 = 广播没人听，页面照样不重拉）
//   其中 ③⑤ 与 ① 的位置（在 upsert 之后、不在早退分支）verify 都看不见，只能靠本守卫。
//
// 与 uiIslandBridgeLifecycle.spec.ts 同风格：静态断言 + 剥注释（查活代码，不把注释里的一句话算数）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** 剥掉 `//` 行注释与块注释（保留字符串字面量内容，事件名字面量就住在里面） */
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

const receiver = stripComments(read('electron/ae-receiver.ts'));
const main = stripComments(read('electron/main.ts'));
const preload = stripComments(read('electron/preload.ts'));
const useSkuPool = stripComments(read('src/modules/goods/useSkuPool.ts'));

const EVENT = 'ae-items-ingested';

describe('采集入库广播：接收端（① ②）', () => {
  it(`emit 里 send('${EVENT}')`, () => {
    expect(
      receiver,
      `ae-receiver.ts 里没有 webContents.send('${EVENT}', ...)。\n` +
        '没有它，采集落库后已打开的「店铺商品」页永远不知道要重拉（用户报障的原始症状）。'
    ).toContain(`send('${EVENT}'`);
  });

  it('handleItemsIngest 成功路径必须调 emitItemsIngested（写了函数没调用 = 死代码）', () => {
    const at = receiver.indexOf('function handleItemsIngest');
    expect(at, 'handleItemsIngest 不见了（函数被改名/删除？守卫需同步更新）').toBeGreaterThan(-1);
    const rest = receiver.slice(at);
    const nextFn = rest.indexOf('\nfunction ', 10);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;
    const emitAt = body.indexOf('emitItemsIngested(');
    const upsertAt = body.indexOf('upsertShopItems(');
    expect(emitAt, 'handleItemsIngest 里没有调用 emitItemsIngested()').toBeGreaterThan(-1);
    expect(upsertAt, 'handleItemsIngest 里不见 upsertShopItems()（落库调用被挪走？）').toBeGreaterThan(-1);
    expect(
      emitAt,
      'emitItemsIngested() 必须在 upsertShopItems() **之后**：\n' +
        '在之前（或放进早退分支）会在"没真的写库"时也广播，页面白拉一次还算轻的，\n' +
        '重的是校验失败分支也广播 —— 用户会看到"刷新了但什么都没变"的迷惑行为。'
    ).toBeGreaterThan(upsertAt);
  });
});

describe('采集入库广播：窗口注入（③）', () => {
  it('main.ts 创建窗口后必须 setAeEventWindow（漏 = 广播永远静默不发）', () => {
    expect(
      main,
      'main.ts 没有 aeReceiver.setAeEventWindow(() => mainWindow)。\n' +
        'getWindow 为空时 emitItemsIngested 直接 return —— send 与 on 两处都写着、verify 也全绿，\n' +
        '但广播一条都发不出去（这正是"接线守卫"要抓的静默失效）。'
    ).toContain('setAeEventWindow(() => mainWindow)');
  });

  it('require 的返回值必须拿来用（写成裸 require 就没法注入窗口）', () => {
    expect(main, "main.ts 里 require('./ae-receiver') 必须赋值给变量（再调 setAeEventWindow）").toMatch(
      /const\s+\w+\s*=\s*require\('\.\/ae-receiver'\)/
    );
  });
});

describe('采集入库广播：preload 订阅（④）', () => {
  it('订阅 + 返回退订函数（removeListener 成对）', () => {
    expect(preload, `preload.ts 没有 ipcRenderer.on('${EVENT}', ...)`).toContain(`on('${EVENT}'`);
    expect(
      preload,
      `preload.ts 没有 removeListener('${EVENT}', ...) —— 订阅泄漏（重复挂载会叠出多个监听）`
    ).toContain(`removeListener('${EVENT}'`);
  });
});

describe('采集入库广播：消费端订阅（⑤）', () => {
  it('useSkuPool 订阅 onAeItemsIngested 并在卸载时退订', () => {
    expect(
      useSkuPool,
      'useSkuPool.ts 没有 onAeItemsIngested(...) 订阅 —— 广播没人听，采集后页面照样不重拉（= 原 bug）。'
    ).toContain('onAeItemsIngested(');
    expect(
      useSkuPool,
      'useSkuPool.ts 里订阅句柄没有被退订（offAeItems?.() 不见了）—— 组件反复挂载会叠监听。'
    ).toContain('offAeItems?.()');
  });

  it('分流逻辑必须落在订阅回调**体内**（调用点，不是别处的定义凑数）', () => {
    // ⚠️ 不能全文件 toContain('loadItemSummaryOnly()')：函数**定义**（`loadItemSummaryOnly():`）
    //    本身就含这个子串 —— 那样把回调里的调用删掉、只留一个没人调的函数，断言照样绿。
    const m = useSkuPool.match(/onAeItemsIngested\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/);
    expect(
      m,
      '找不到 onAeItemsIngested(() => { ... }) 的订阅回调形态。\n' +
        'hook 在挂载期订阅、卸载期退订是唯一说得通的形态；若确实要改形态，请同步更新本守卫。'
    ).not.toBeNull();
    const body = m?.[1] ?? '';
    expect(body, "回调体内没有 sub.value === 'items' 分流判据").toContain("sub.value === 'items'");
    expect(body, 'items 段收到广播应刷 loadShopItems()').toContain('loadShopItems()');
    expect(
      body,
      '非 items 段收到广播应只刷 loadItemSummaryOnly()（点亮分段徽标，不动列表）——\n' +
        '全量重拉会清空勾选、打断当前操作（停在队列段时用户只是在扫队列）。'
    ).toContain('loadItemSummaryOnly()');
  });
});
