// electron/schedulerPlan.ts
// **开机自动化**的判定层（M5·T5-1~T5-5 里"该不该动手 / 动手之后说什么"），纯函数、零依赖。
//
// 为什么把这层摘出来（同 `podLedger` / `podRekey` / `podLinkStats` 的做法）：
//   · 真正会写错的地方不是"怎么调 Chrome"，而是**该不该调**（一天一次、最多 3 次补跑）
//     与**该说什么**（抓 0 条但总数 > 0 必须告警，而不是"同步成功 0 单"）。
//   · 这两件事的副作用是**弹用户的浏览器**、**弹系统通知**：写错不会报错，只会一天开十几次
//     Chrome（把用户逼到卸载）或者把"登录过期"静默成"今天没单"（漏发整天的货）。
//   · `electron/scheduler.ts` 要碰 better-sqlite3 / electron API，系统 Node 下起不来；
//     判定层留在这里，vitest 才能逐条钉住 T5-3 / T5-5 的判据。
//
// ⚠️ 红线 3「不做常驻轮询」由本层守着：`decideAutoSync()` 只有三种出口，
//    没有"隔 N 分钟再来一次"的选项 —— 补跑次数由**当天已触发次数**决定，不由定时器决定。

/** 芒果订单列表（待发货筛选）—— 扩展 `background.js` 的 `ORDER_LIST_URL` 必须与本处同源 */
export const MANGO_ORDER_LIST_URL =
  'https://www.mangoerp.com/erp/#/erp/order/list/search/status/正常/normal';

/** 网络就绪等待：最多 60s、重试 3 次（T5-3 原文"等网络就绪（最多 60s，重试 3 次）"） */
export const NETWORK_WAIT_MS = 60_000;
export const NETWORK_TRIES = 3;
/** 每次重试之间的间隔（60s / 3 = 20s） */
export const NETWORK_RETRY_GAP_MS = NETWORK_WAIT_MS / NETWORK_TRIES;

/** 一天最多补跑次数（T5-3："一天一次，最多 3 次补跑"） */
export const MAX_AUTO_SYNC_PER_DAY = 3;

/** 唤起 Chrome 之后等扩展推帧的上限：超过就报"没收到推送"（扩展没装/没登录 Chrome） */
export const INGEST_WAIT_MS = 5 * 60_000;

/**
 * 本机今天（`yyyy-mm-dd`，**本地时区**）。
 *
 * ⚠️ 与 `src/lib/localDay.ts` 的 `localDayKey` 是同一口径的**第二份实现**：
 *    主进程 CJS 构建不 import `src/`（那是渲染层），只能刻意再写一份。
 * ⚠️ 不用 `toISOString().slice(0,10)`：那是 UTC 日期，东八区晚上 8 点后返回**前一天**，
 *    于是"今晚同步过的"会被判成"今天还没同步"，半夜开机又开一次 Chrome。
 */
export function localDayKey(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时分 `HH:mm`（通知文案用，别在两处各补一次零） */
export function localClock(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `decideAutoSync` 的四种出口：只有 `open` 会真的动手 */
export type AutoSyncAction = 'open' | 'already_done' | 'give_up';

export interface AutoSyncDecision {
  action: AutoSyncAction;
  /** 人话原因（会写进 `sk_auto_sync_log`，也用于通知/日志；**不许留空**） */
  reason: string;
  /** 今天已经触发过几次（用于"还剩几次"这类文案与断言） */
  attempts: number;
}

export interface AutoSyncInput {
  /** 现在（注入是为了单测能钉住跨天边界） */
  now: Date;
  /** 最近一次芒果同步的完成时间（`sk_sync_log.finished_at`，ISO 串；`''` = 从没同步过） */
  lastSyncAt: string;
  /** 今天（本地日）已经触发过几次自动同步（只数 `source='startup'` 的触发行） */
  attemptsToday: number;
  /** 一天上限，默认 `MAX_AUTO_SYNC_PER_DAY`（单测要能压到 1） */
  maxAttempts?: number;
}

/**
 * 今天该不该自动同步。
 *
 * 顺序刻意的：**先判上限、再判今天是否已同步**。
 * 反过来（先判"已同步"）在"同步成功但扩展只推了半批、用户希望再补一次"的当天，
 * 会因为 lastSyncAt 是今天而永远跳过；而上限先判则最坏只多开 3 次 Chrome。
 *
 * `already_done` 的判据是**同一天**（本地日），不是"12 小时内"：跨天边界必须与用户的
 * "今天"一致，否则凌晨 0 点开机仍判定"昨天已同步"→ 跳过，当天的单就不抓了。
 */
export function decideAutoSync(input: AutoSyncInput): AutoSyncDecision {
  const max = Math.max(1, Math.round(Number(input?.maxAttempts ?? MAX_AUTO_SYNC_PER_DAY) || MAX_AUTO_SYNC_PER_DAY));
  const attempts = Math.max(0, Math.round(Number(input?.attemptsToday) || 0));
  if (attempts >= max) {
    return {
      action: 'give_up',
      attempts,
      reason: `今天已经触发过 ${attempts} 次自动同步（上限 ${max}）—— 不再开浏览器，请在「今日待办」里手动同步`,
    };
  }
  const day = localDayKey(input?.now ?? new Date());
  const lastAt = String(input?.lastSyncAt ?? '');
  const lastDay = localDayKey(lastAt);
  if (lastDay && lastDay === day) {
    return {
      action: 'already_done',
      attempts,
      reason: `今天 ${localClock(lastAt)} 已经同步过（抓取结果见 sk_sync_log），不再开浏览器`,
    };
  }
  return {
    action: 'open',
    attempts,
    reason: lastDay ? `上次同步在 ${lastDay}（不是今天）—— 唤起 Chrome 抓一次` : '从未同步过 —— 唤起 Chrome 抓一次',
  };
}

/** 通知/日志用的三种结果（T5-5 原文：成功 / 失败 / 抓 0 条但总数 > 0） */
export type AutoSyncNoticeKind = 'success' | 'failure' | 'zero';

export interface AutoSyncNotice {
  kind: AutoSyncNoticeKind;
  title: string;
  body: string;
}

/** 同步结果的**最小**输入面（只取判定要用的几个数，调用方传整个 `MangoIngestResult` 也行） */
export interface AutoSyncResultLike {
  ok?: boolean;
  fetched?: number;
  totalItems?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  missingImage?: number;
  shopUnmatched?: number;
  partial?: boolean;
  warnings?: readonly string[];
}

/**
 * 把一次同步结果翻成一条系统通知。
 *
 * **顺序是本函数最要紧的部分**：`fetched === 0 && totalItems > 0` 必须排在
 * `!ok` 之前判 —— 红线 1 的那一种在 `ingestMangoOrders` 里恰好也是 `ok:false`，
 * 先判失败就会退化成"同步失败（原因：…）"，而真正该说的是
 * **"芒果说有 12 单，一单都没抓到"**（登录过期/筛选不对/hook 没生效，三种都长得一样）。
 *
 * `fetched === 0 && totalItems === 0` 是唯一能说"今天没有待发货"的情形：
 * 芒果明确回了"共 0 单"，这才是"今天真没单"，不是"抓不到"。
 */
export function autoSyncNotice(r: AutoSyncResultLike): AutoSyncNotice {
  const fetched = Math.max(0, Math.round(Number(r?.fetched) || 0));
  const totalItems = Math.max(0, Math.round(Number(r?.totalItems) || 0));
  const inserted = Math.max(0, Math.round(Number(r?.inserted) || 0));
  const updated = Math.max(0, Math.round(Number(r?.updated) || 0));
  const skipped = Math.max(0, Math.round(Number(r?.skipped) || 0));
  const missingImage = Math.max(0, Math.round(Number(r?.missingImage) || 0));
  const shopUnmatched = Math.max(0, Math.round(Number(r?.shopUnmatched) || 0));

  if (fetched === 0 && totalItems > 0) {
    return {
      kind: 'zero',
      title: `芒果说共 ${totalItems} 单，一单都没抓到`,
      body: '登录过期 / 页面没停在待发货筛选 / 扩展未生效 —— 三种都长这样，请打开芒果看一眼「今日待办」。',
    };
  }
  if (r?.ok === false) {
    const warn = Array.isArray(r?.warnings) ? String(r.warnings[0] ?? '') : '';
    return {
      kind: 'failure',
      title: '芒果同步失败',
      body: warn || '扩展把订单推过来时出错了，原因见「今日待办」的采集状态条。',
    };
  }
  if (fetched === 0) {
    return {
      kind: 'success',
      title: '今天没有待发货订单',
      body: '芒果明确回了 0 单（不是抓不到）—— 可以放心。',
    };
  }
  const notes: string[] = [];
  if (skipped > 0) notes.push(`${skipped} 单未入库`);
  if (missingImage > 0) notes.push(`${missingImage} 行没取到图`);
  if (shopUnmatched > 0) notes.push(`${shopUnmatched} 单没认到店`);
  if (r?.partial === true) notes.push('这次没抓全（ext 标了 partial）');
  return {
    kind: 'success',
    title: `同步 ${fetched} 单（新增 ${inserted} / 更新 ${updated}）`,
    body: notes.length ? notes.join(' · ') : '全部入库，图已落地。',
  };
}

/**
 * 启动时该不该把主窗口藏起来（T5-2：开机自启**不许弹窗**）。
 *
 * 两个来源都要认：
 *   · macOS `openAsHidden` —— 系统会让应用以「隐藏」状态启动，但 Electron 不保证此时
 *     `process.argv` 带标记，所以**还要认 `--hidden`**；
 *   · Windows / Linux `openAsHidden` 不生效 —— 必须靠自启项里写 `--hidden` 参数。
 * 参数名与 `configureLoginItem()` 里写的 `args` **必须同字**，改一处要改两处。
 */
export function shouldStartHidden(argv: readonly string[]): boolean {
  const list = Array.isArray(argv) ? argv : [];
  return list.some((a) => String(a).trim() === '--hidden');
}

/** 自启项里要带的参数（与 `shouldStartHidden` 认的标记同一处定义） */
export const HIDDEN_ARG = '--hidden';
