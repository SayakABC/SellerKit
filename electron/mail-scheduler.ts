// electron/mail-scheduler.ts
// 「邮件后台收信」的常驻调度层（主进程）：定时触发增量同步 + 新邮件系统通知。
//
// ---- 为什么必须在主进程（2026-11-04，现象：「不会自动接收邮件」）----
// 原实现把轮询放在渲染层 `mailStore.startPolling()`，而它只在 `MailView` 挂载时启动：
//   · 冷启动后不进「邮件」页 ⇒ 一次都不拉（用户看到的就是"永远不自动收信"）；
//   · 本应用关窗口不退出（有托盘，见 main.ts 的 window-all-closed），后台挂着的时候
//     根本没有渲染层在计时。
// 因此计时必须搬到主进程；渲染层只剩"把用户设的间隔告诉我"这一件事。
//
// ---- 三条纪律 ----
// ① **间隔的权威在渲染层**：用户设置里就那一个数（`MailPrefs.pollMinutes`）。
//    本层只做执行者 + 冷启动缓存：收到 `mail-auto-sync-config` 就覆盖并重排；
//    缓存写 `sk_mail_meta`，唯一目的是"窗口还没加载完的那十几秒"也能按上次的选择排程。
//    已知代价：升级后的**第一次冷启动**缓存为空，会按默认 10 分钟跑一轮；
//    用户打开邮件页/设置页时会把本地真实设置（可能是 0 = 关闭）重新下发并纠正。
// ② **只在自动轮次发通知**：手动点「同步」时用户就在界面前，再弹系统通知是噪音
//    （与 `scheduler.ts` 对订单自动同步的处理一致 —— 判定与副作用分开）。
// ③ **通知失败不许影响同步**：平台不支持 / 用户拒权 / 构造异常一律静默，
//    同步结果本身照常落库、照常广播 mail-sync-event。

export {};

const { Notification } = require('electron');

import { listMailAccounts, getMailMetaValue, setMailMetaValue } from './mail-db';
import {
  enqueueMailSync,
  getMailSyncState,
  setMailSyncSummaryHook,
  type MailSyncSummary,
} from './mail-engine';

/** `sk_mail_meta` 里存排程间隔的键（**只缓存**，权威在渲染层设置） */
const META_KEY = 'mailAutoSyncMinutes';
/** 没有任何缓存时的间隔：与渲染层 `DEFAULT_PREFS.pollMinutes` 保持一致 */
const DEFAULT_MINUTES = 10;
const MIN_MINUTES = 0;
const MAX_MINUTES = 1440;
/** 启动后延迟首轮：等 schema 迁移 / 窗口 / 网络就绪，避免和启动争抢 */
const START_DELAY_MS = 15_000;
/** 通知正文里主题的截断长度（macOS 横幅再长也折行，截断比"半句话"好读） */
const NOTIFY_SUBJECT_MAX = 60;

let timer: ReturnType<typeof setInterval> | null = null;
/** 已排程的间隔（分钟）；0 = 未排程 */
let scheduledMinutes = 0;
/**
 * 本轮自动同步涉及的账号。
 * 只有 `runAutoRound` 入队的账号在这里 ⇒ 手动同步 / 别处触发的同步**不会**弹通知。
 */
const autoRound = new Set<number>();
let showWindow: (() => void) | null = null;
let openInbox: (() => void) | null = null;

function clampMinutes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.floor(n)));
}

/** 读缓存间隔（无缓存 = 默认 10） */
function readCachedMinutes(): number {
  const raw = getMailMetaValue(META_KEY);
  if (String(raw) === '') return DEFAULT_MINUTES;
  return clampMinutes(raw);
}

/** 有启用同步的账号才值得排程（没账号时定时器空转只会白占一个计时器） */
function hasSyncableAccount(): boolean {
  try {
    return listMailAccounts().some((a) => a.syncEnabled);
  } catch {
    return false;
  }
}

/** 重排定时器（0 = 只清掉，不新建） */
function schedule(minutes: number): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  scheduledMinutes = minutes;
  if (minutes <= 0) return;
  timer = setInterval(runAutoRound, minutes * 60_000);
  // 计时器不许占住进程退出（托盘退出要能立即走），与 scheduler.ts 同款处理
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

/**
 * 跑一轮自动同步（到点触发 / 启动首轮）。
 *
 * 上一轮还没跑完就跳过而不是排队：IMAP 单账号连接是串行的，
 * 叠加只会让"下一次"越排越后，最后还是同一批邮件再扫一遍。
 */
function runAutoRound(): void {
  if (!hasSyncableAccount()) return;
  const state = getMailSyncState();
  if (state.active.length > 0 || state.queued.length > 0) return;
  // 每轮开始先清空：上一轮若因为报错没走到 done，账号 id 会残留在这里，
  // 那会让"下一次手动同步成功"被误判成本轮自动同步而弹通知。
  autoRound.clear();
  const { queued } = enqueueMailSync();
  for (const id of queued) autoRound.add(id);
  if (queued.length) console.log(`[mail-scheduler] 自动收信：${queued.length} 个账号入队`);
}

/** 同步收尾：只处理本轮自动入队的账号，其余（手动触发）不弹通知 */
function handleSummary(summary: MailSyncSummary): void {
  if (!autoRound.delete(summary.accountId)) return;
  if (summary.newCount > 0) notifyNewMail(summary);
}

/** 一条新邮件系统通知（点通知 = 把主窗口拿出来） */
function notifyNewMail(summary: MailSyncSummary): void {
  try {
    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) return;
    const first = summary.samples[0];
    const sample = first
      ? `${first.fromName || '未知发件人'}：${String(first.subject || '（无主题）').slice(0, NOTIFY_SUBJECT_MAX)}`
      : '';
    const body =
      summary.newCount === 1 && sample ? sample : `${summary.newCount} 封（${summary.email}） ${sample}`.trim();
    const notice = new Notification({
      title: `${summary.newCount} 封新邮件`,
      body: String(body).slice(0, 300),
    });
    notice.on('click', () => {
      // 点通知 = "我要去看这几封信"：把窗口拿出来**并切到邮件模块**。
      // 旧行为只 show 窗口，用户若正停在别的模块上，点完通知还得自己找侧栏点一下
      // —— 通知的语义是"带我去看"，不是"提醒我这里有个东西"。
      try {
        (openInbox ?? showWindow)?.();
      } catch {
        /* 窗口已销毁 */
      }
    });
    notice.show();
  } catch (err: any) {
    console.warn('[mail-scheduler] 新邮件通知失败：', err?.message || err);
  }
}

/**
 * 注入界面入口（`main.ts` 创建窗口后调用）。
 * @param hooks.show 只把主窗口拿出来（诊断/兜底路径用）
 * @param hooks.openInbox 拿出来 + 让外壳切到「邮件」模块（通知点击用；缺省回落 `show`）
 */
export function setMailSchedulerWindowHook(hooks: { show: () => void; openInbox?: () => void }): void {
  showWindow = hooks.show;
  openInbox = hooks.openInbox ?? null;
}

/** 当前排程状态（诊断用：设置页/日志可据此回答"到底有没有在跑"） */
export function getMailSchedulerState(): { minutes: number; running: boolean; autoRound: number[] } {
  return { minutes: scheduledMinutes, running: scheduledMinutes > 0, autoRound: [...autoRound] };
}

/**
 * 渲染层下发自动同步间隔（**唯一权威在渲染层设置**）。
 * @param minutes 0 = 关闭；其余按 [1, 1440] 收敛
 */
export function configureMailAutoSync(minutes: unknown): { minutes: number } {
  const value = clampMinutes(minutes);
  setMailMetaValue(META_KEY, String(value));
  schedule(value);
  console.log(`[mail-scheduler] 自动收信间隔已更新为 ${value ? `${value} 分钟` : '关闭'}`);
  return { minutes: value };
}

/**
 * 启动调度（`main.ts` 的 `app.whenReady` 里、schema 迁完之后调用一次）。
 *
 * @param delayMs 首轮延迟；测试或"人刚点了手动同步"时可传 0
 */
export function startMailScheduler(delayMs = START_DELAY_MS): void {
  setMailSyncSummaryHook(handleSummary);
  const minutes = readCachedMinutes();
  schedule(minutes);
  if (minutes <= 0) {
    console.log('[mail-scheduler] 自动收信已关闭（间隔 0），等渲染层下发设置');
    return;
  }
  console.log(`[mail-scheduler] 自动收信已排程：每 ${minutes} 分钟`);
  const first = setTimeout(runAutoRound, Math.max(0, delayMs));
  if (typeof (first as any)?.unref === 'function') (first as any).unref();
}

/** 停用（应用退出 / 测试收尾）：清计时器与订阅，避免残留回调写库 */
export function stopMailScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  scheduledMinutes = 0;
  autoRound.clear();
  setMailSyncSummaryHook(null);
}
