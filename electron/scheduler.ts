// electron/scheduler.ts
// **开机自动化**的编排层（M5·T5-3 / T5-4 / T5-5）：
//   启动后等网络就绪（≤60s，重试 3 次）→ 今天同步过就跳过 → 否则唤起 Chrome 打开待发货页
//   → 等扩展把订单推回来 → 按结果弹一条系统通知（成功 / 失败 / **抓 0 条但总数 > 0**）。
//
// 为什么是独立文件（而不是塞进 `main.ts`）：判定（该不该动手）与副作用（开浏览器 / 弹通知 / 写日志）
// 分开才能测 —— 判定层在 `electron/schedulerPlan.ts`（纯函数、vitest 覆盖），本文件只做编排。
//
// 三条硬纪律（对应计划 §6.2 的红线）：
//   ① **不做常驻轮询**（红线 3）：只有"启动时一次"与"托盘里人点的立即同步"两个入口，
//      没有定时器；补跑上限由**当天已触发次数**决定（`decideAutoSync`）。
//   ② **抓 0 条 ≠ 今天没单**（红线 1）：通知文案由 `autoSyncNotice` 决定，那一种排在失败之前判。
//   ③ **同步必须有日志**（红线 10）：每次"动手 / 跳过 / 放弃 / 没等到推送"都写一行
//      `sk_auto_sync_log`；真正的同步结果仍由 `mango-sync` 写 `sk_sync_log`（两处不重复）。
//
// ⚠️ 本文件**不自己抓数据**：抓取是 Chrome 扩展的事（hook 页面请求 → POST /mango/ingest）。
//    应用侧唯一的动作是"把待发货页开进用户的 Chrome"，扩展装在 Chrome 里，动线才成立
//    （见 `browser-open.ts` 顶部注释）。

export {};

const { app, net, Notification } = require('electron');

import { dbMigrate, dbQuery, dbRun } from './db';
import { lastMangoSync } from './mango-sync';
import { openUrlInPreferredBrowser } from './browser-open';
import {
  INGEST_WAIT_MS,
  MANGO_ORDER_LIST_URL,
  MAX_AUTO_SYNC_PER_DAY,
  NETWORK_RETRY_GAP_MS,
  NETWORK_TRIES,
  autoSyncNotice,
  decideAutoSync,
  localDayKey,
  type AutoSyncResultLike,
} from './schedulerPlan';

/**
 * 自动同步尝试日志（一行 = 一次"判定 + 动作"）。
 *
 * 为什么不复用 `sk_sync_log`：那张表是**抓取结果**（fetched/total_items/inserted…），
 * 由 `mango-sync` 写一次一批。本表记的是**应用侧的动作**（开浏览器 / 跳过 / 放弃 / 没等到推送），
 * 两者一一对照才能回答"今天到底动过几次手、为什么没数据"：
 *   · 有 open 行但没有 Sync 行 ⇒ 浏览器开了、扩展没推（登录过期 / 扩展没装）；
 *   · 有 already_done 行 ⇒ 很早就同步过，今天开机没开浏览器（这是正常的一天）；
 *   · 有 give_up 行 ⇒ 今天已经补跑满 3 次仍没结果（该人工看）。
 * 塞进 `sk_sync_log` 会让"最近一次同步"（`lastMangoSync`，只认 kind='mango'）以外的读者
 * 把动作行当成抓取行来数（0 单 / 0 请求），这正是"数字看着都对，只是不是同一件事"。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sk_auto_sync_log (
  -- 用途：开机自动同步的尝试日志（一天最多 3 次补跑；跳过 / 放弃也要留一行原因）
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key    TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'startup',
  action     TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT ''
)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_auto_sync_day ON sk_auto_sync_log(day_key, source, action)`,
];

export function ensureAutoSyncSchema(): void {
  dbMigrate(SCHEMA);
}

/** 动作取值（写进 `sk_auto_sync_log.action`；只数 `open` 进"今天几次"） */
export type AutoSyncAction = 'open' | 'already_done' | 'give_up' | 'offline' | 'open_failed' | 'no_push' | 'done';

export interface AutoSyncRunResult {
  /** 是否真的去开了浏览器 */
  opened: boolean;
  action: AutoSyncAction;
  reason: string;
}

/** 等扩展推帧的那一次"挂起"（同一时刻最多一个：同步是串行的，重入直接忽略） */
let pending: { timer: ReturnType<typeof setTimeout>; startedAt: string } | null = null;
/** 正在跑判定（防托盘连点两次同时开两个浏览器） */
let running = false;
/** 主窗口显示入口（main.ts 注入；托盘菜单与通知点击共用） */
let showWindow: (() => void) | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 写一行尝试日志（失败不许影响主流程：日志坏了也不能不开浏览器） */
export function writeAutoSyncLog(input: {
  action: AutoSyncAction;
  reason: string;
  source: 'startup' | 'manual';
  dayKey?: string;
  url?: string;
}): void {
  try {
    ensureAutoSyncSchema();
    dbRun(
      `INSERT INTO sk_auto_sync_log (day_key, at, source, action, reason, url) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.dayKey || localDayKey(),
        nowIso(),
        input.source,
        input.action,
        String(input.reason ?? '').slice(0, 500),
        String(input.url ?? '').slice(0, 500),
      ],
    );
  } catch (err: any) {
    console.warn('[scheduler] 写自动同步日志失败：', err?.message || err);
  }
}

/** 今天（本地日）已经触发过几次**自动**（非手动）同步 */
export function attemptsToday(dayKey = localDayKey(), source: 'startup' | 'manual' = 'startup'): number {
  try {
    ensureAutoSyncSchema();
    const r = dbQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sk_auto_sync_log WHERE day_key = ? AND source = ? AND action = 'open'`,
      [dayKey, source],
    )[0];
    return Math.max(0, Number(r?.n) || 0);
  } catch {
    // 读不出来就当作"没触发过"：宁可多补一次，也不要因为一张日志表坏了整天不抓单。
    return 0;
  }
}

/** 网络是否就绪（拿不到判定能力时按"就绪"处理，不让平台差异把同步卡死） */
function networkReady(): boolean {
  try {
    if (typeof net?.isOnline === 'function') return net.isOnline() === true;
  } catch {
    /* 落到默认 */
  }
  return true;
}

/**
 * 等网络就绪：最多 60s、重试 3 次（每次之间 20s）。
 *
 * 为什么不在就绪前就开浏览器：开机那一分钟 DNS/代理往往还没起来，此时打开的页面是
 * 一个**打不开的标签页** —— 扩展 hook 不到请求，结果就是"今天没数据"，而原因完全不可见。
 * @returns true = 就绪（或无法判定）；false = 等满 60s 仍离线
 */
async function waitForNetwork(): Promise<boolean> {
  if (networkReady()) return true;
  for (let i = 1; i <= NETWORK_TRIES; i += 1) {
    await sleep(NETWORK_RETRY_GAP_MS);
    if (networkReady()) return true;
    console.log(`[scheduler] 网络未就绪（第 ${i}/${NETWORK_TRIES} 次重试）`);
  }
  return false;
}

/** 弹一条系统通知（平台不支持 / 构造失败时静默：通知不许让同步失败） */
function notify(title: string, body: string): void {
  try {
    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) return;
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 300) });
    n.on('click', () => {
      // 点通知 = "我要去看结果"：把主窗口拿出来，而不是再开一次浏览器
      try {
        showWindow?.();
      } catch {
        /* 窗口已销毁 */
      }
    });
    n.show();
  } catch (err: any) {
    console.warn('[scheduler] 系统通知失败：', err?.message || err);
  }
}

/** 主窗口显示入口的注入口（`main.ts` 创建窗口后调用） */
export function setAutoSyncWindowHooks(fns: { show: () => void }): void {
  showWindow = fns.show;
}

/**
 * 跑一次自动同步判定。
 *
 * @param source `startup` = 启动时自动（受"今天已同步/上限 3 次"约束）；
 *               `manual` = 托盘里的「立即同步」（**人点的不受约束**，但同样留日志）
 */
export async function runAutoSync(source: 'startup' | 'manual' = 'startup'): Promise<AutoSyncRunResult> {
  if (running) {
    return { opened: false, action: 'give_up', reason: '上一次自动同步还没结束（本机同一时刻只跑一次）' };
  }
  running = true;
  try {
    ensureAutoSyncSchema();
    const dayKey = localDayKey();

    if (source === 'startup') {
      const decision = decideAutoSync({
        now: new Date(),
        lastSyncAt: lastMangoSync()?.at ?? '',
        attemptsToday: attemptsToday(dayKey),
        maxAttempts: MAX_AUTO_SYNC_PER_DAY,
      });
      if (decision.action !== 'open') {
        writeAutoSyncLog({ action: decision.action, reason: decision.reason, source, dayKey });
        console.log(`[scheduler] ${decision.action}：${decision.reason}`);
        return { opened: false, action: decision.action, reason: decision.reason };
      }
      if (!(await waitForNetwork())) {
        const reason = `等了 ${NETWORK_TRIES} × ${NETWORK_RETRY_GAP_MS / 1000}s 网络仍未就绪，这次不开浏览器（下次启动会再试）`;
        writeAutoSyncLog({ action: 'offline', reason, source, dayKey });
        notify('芒果同步没跑起来', `${reason}。连上网后可在托盘里点「立即同步」。`);
        return { opened: false, action: 'offline', reason };
      }
    }

    // 真正动手：唤起 Chrome 打开待发货页（扩展装在 Chrome 里才 hook 得到）
    let why = '启动时自动同步';
    try {
      const who = await openUrlInPreferredBrowser(MANGO_ORDER_LIST_URL);
      why = who === 'chrome' ? '已用 Chrome 打开待发货页' : 'Chrome 不可用，已用系统浏览器打开待发货页（那种浏览器里没装扩展，可能推不过来）';
    } catch (err: any) {
      const reason = `打开待发货页失败：${String(err?.message || err || '未知错误')}`;
      writeAutoSyncLog({ action: 'open_failed', reason, source, dayKey, url: MANGO_ORDER_LIST_URL });
      notify('芒果同步失败', `${reason}。请检查浏览器是否能正常打开。`);
      return { opened: false, action: 'open_failed', reason };
    }

    writeAutoSyncLog({ action: 'open', reason: why, source, dayKey, url: MANGO_ORDER_LIST_URL });
    console.log(`[scheduler] ${why}（${source}）—— 等扩展推帧`);

    // 等扩展把订单推回来。**不做轮询**：结果由 `/mango/ingest` 的编排层回调 `onIngestDone`，
    // 这里只挂一个"等太久就报没收到推送"的上限计时器（扩展没装 / 没登录时唯一能说出口的原因）。
    if (pending) clearTimeout(pending.timer);
    pending = {
      startedAt: nowIso(),
      timer: setTimeout(() => {
        pending = null;
        const reason = `唤起 Chrome 后 ${Math.round(INGEST_WAIT_MS / 60_000)} 分钟内没有收到扩展推送`;
        writeAutoSyncLog({ action: 'no_push', reason, source, dayKey, url: MANGO_ORDER_LIST_URL });
        notify(
          '芒果同步没收到数据',
          `${reason}。请确认日常用的 Chrome 里装了 SellerKit 扩展、并且芒果是登录状态。`,
        );
      }, INGEST_WAIT_MS),
    };
    // 计时器不许占住进程退出（Electron 主进程里 unref 掉，托盘退出能立即走）
    if (typeof (pending.timer as any)?.unref === 'function') (pending.timer as any).unref();

    return { opened: true, action: 'open', reason: why };
  } finally {
    running = false;
  }
}

/**
 * `/mango/ingest` 落库后由 `ae-receiver` 调用一次（T5-5 的通知就在这里发）。
 *
 * 只在**我们自己去开过浏览器**（`pending` 非空）时通知：用户自己点扩展采集时，
 * 结果已经在界面的采集状态条上，再弹一条通知是噪音。
 */
export function onIngestDone(result: AutoSyncResultLike): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
  const notice = autoSyncNotice(result);
  const dayKey = localDayKey();
  writeAutoSyncLog({
    action: 'done',
    reason: `${notice.kind}：${notice.title}`,
    source: 'startup',
    dayKey,
    url: MANGO_ORDER_LIST_URL,
  });
  notify(notice.title, notice.body);
  console.log(`[scheduler] 同步结果通知（${notice.kind}）：${notice.title}`);
}

/**
 * 启动时调用一次（`main.ts` 的 `app.whenReady` 之后）。
 *
 * 延后 3s 的理由：接收端（`startAeReceiver`）与 schema 迁移要先跑完 —— 扩展的推帧
 * 可能在浏览器打开后 1~2s 就到，那时 `/mango/ingest` 还没监听会直接连不上。
 *
 * @returns 是否真的排入了（被 `SELLERKIT_AUTO_SYNC=0` 关掉时返回 false，供日志用）
 */
export function startAutoSync(delayMs = 3000): boolean {
  if (process.env.SELLERKIT_AUTO_SYNC === '0') {
    console.log('[scheduler] 已按 SELLERKIT_AUTO_SYNC=0 关掉启动时自动同步');
    return false;
  }
  setTimeout(() => {
    runAutoSync('startup').catch((err: any) => {
      console.warn('[scheduler] 自动同步异常：', err?.message || err);
    });
  }, Math.max(0, delayMs));
  return true;
}
