// src/lib/syncBanner.ts
// 「采集状态条」的文案与配色（T2-3）—— **纯函数，唯一实现**。
//
// 为什么从面板里抽出来：这段逻辑有**四种形态**（读不到日志 / 从没同步过 / 同步失败 / 正常），
// 而 UI 冒烟要验四种就得连续点五次刷新 —— 实测把整页的虚拟时间预算撑爆，
// 断言脚本还没跑完页面就被 dump 了（症状是输出在最后一条 PASS 处截断，
// 既没有 ALL PASS 也没有 FAILED，`grep FAIL` 一条都没有 —— 看起来像"全绿"）。
//
// 抽成纯函数后分工清楚了：
//   · 四种形态的**文案与染色**由 vitest 覆盖（快、稳、可变异）；
//   · UI 冒烟只验"接线对不对"（真的渲染、真的读 `summary.sync`、class 真的生效）——
//     两次刷新就够。
//
// 一条铁律：**`reason` 有值就必须原样给出来**，不许在文案层改写成"同步异常"。
// 那条 reason 是同步层写好的可行动原因（"登录过期 / 没停在待发货筛选 / 扩展未生效"），
// 翻译一遍就等于把"该怎么办"删掉了。

import type { MangoSyncStatusRow } from '../types';
import { localWhen } from './localDay';

export type SyncTone = 'ok' | 'warn' | 'idle' | 'error';

export interface SyncBannerView {
  /** 一行文案（时间 + 计数，或失败原因） */
  text: string;
  /** 配色档位：`ok` 安静 / `warn` 数据能用但不全 / `idle` 还没开始 / `error` 出了问题 */
  tone: SyncTone;
  /** 是否显示"抓取被截断"小标签（与 `tone` 分开：截断时既要说清也不该忽略） */
  partial: boolean;
}

/** 输入形状（容器的 `summary.sync`） */
export interface SyncBannerInput {
  last: MangoSyncStatusRow | null;
  /** 读日志失败的原因；非空 = 这一条本身没读到（**不是**"没同步过"） */
  error: string;
}

/**
 * 算状态条该显示什么。
 *
 * 四种形态按优先级：
 *   ① `error` 非空 —— 读不到日志。**必须先判**：它和"没同步过"看起来一样，但要做的事完全不同。
 *   ② `last === null` —— 真没同步过，告诉人去哪就开始。
 *   ③ `last.reason` 非空 —— 同步失败，原样给原因。
 *   ④ 正常 —— 时间 + 抓了几条 + 入库几条；跳过/缺图/没认到店另说。
 */
export function syncBanner(input: SyncBannerInput | null | undefined): SyncBannerView {
  const last = input?.last ?? null;
  const error = String(input?.error ?? '');

  if (error) return { text: `读不到同步状态：${error}`, tone: 'error', partial: false };
  if (!last) {
    // ⚠️ 这里**不能**写「待发货」（本仓约定：「」= 应用内真实入口，`tests/uxEntryNames.spec.ts` 会拦）。
    // 芒果店长是**外部站点**，它的页面名不是本应用的入口名 —— 用普通文字说清即可。
    return {
      text: '还没同步过 —— 打开芒果店长的待发货页面会自动抓一次',
      tone: 'idle',
      partial: false,
    };
  }

  const at = localWhen(last.at);
  const head = at ? `${at} · ` : '';

  if (last.reason) {
    return { text: `${head}同步失败：${last.reason}`, tone: 'error', partial: last.partial };
  }

  const bits = [`抓 ${num(last.fetched)} 条`, `入库 ${num(last.inserted) + num(last.updated)}`];
  if (num(last.skipped) > 0) bits.push(`跳过 ${num(last.skipped)}`);
  if (num(last.missingImage) > 0) bits.push(`${num(last.missingImage)} 行没图`);
  if (num(last.shopUnmatched) > 0) bits.push(`${num(last.shopUnmatched)} 单没认到店`);

  return {
    text: `${head}${bits.join(' · ')}`,
    // 抓取被截断（服务端无视页码 / 中途失败）：数据能用但**不全**，要提醒但不该当失败
    tone: last.partial ? 'warn' : 'ok',
    partial: !!last.partial,
  };
}

/** 脏值兜底：`NaN` 会被 `toFixed` 之类渲染成 "NaN"，宁可显示 0 也别显示 NaN */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 「从来没同步过」——**空态**要用的判据（T2-5）。
 *
 * 为什么单独抽出来：`0 单` 在界面上有**三种**完全不同的含义，而它们要先做才谈得上做对：
 *   ① 读不到日志（`error`）——日志表坏了/读不出来，这时候说"还没同步过"是**假话**，
 *      而且是会让人白做一遍同步的假话；
 *   ② 从没同步过 —— 去芒果点一下就有；
 *   ③ 同步过、芒果那边就是空的 —— 真没单，该去干别的。
 *
 * 只有 ② 该给"去芒果采集"的出口。三处空态（总览 `现在还没发`、清单、以后的托盘提示）
 * 必须按同一份判据走，否则同一个 0 在不同屏上说三种话。
 */
export function isNeverSynced(input: SyncBannerInput | null | undefined): boolean {
  return !String(input?.error ?? '') && !(input?.last ?? null);
}
