// src/lib/podBinding.ts
// 「图案」卡片的**阈值与人话文案**（纯函数，别在界面里另写一份）。
// 页面在「发货台 › 订花纸」（`today/tabs/PodOrderPanel.vue`）—— 2026-11-03 起，
// 原来那一页（`shop-accounts/components/PatternPanel.vue`）与它一起并进了订花纸。
//
// 为什么这里不再用「覆盖率 / 塌陷链接 / 槽位」这些词（2026-11-02 用户反馈）：
//   用户第一次打开这一页，看到的就是"绑定覆盖率 38%、塌陷链接还有 50 个槽位没绑" ——
//   每个词都要先翻译一遍才知道该做什么。同一个判据换成人话就是：
//     · 覆盖率 → **已认好多少颜色**
//     · 塌陷链接 → **同一个颜色名下列出了多张图，需要逐张看图确认**
//     · 槽位 → **颜色**（店铺商品里的一个颜色 = 买家可能下单的一种颜色）
//
// 两个数各有自己的成败线，混在一起就会"看起来绿了其实没做完"：
//   ① **已认好 ≥ 60%**（计划 M3 门禁）—— 只算"认了多少颜色"；
//   ② **「同色多图」100% 确认**—— 这类颜色占少数，但认错一次是**整批错印**。
// 所以 60% 够了但多图没确认完，整体判据仍是**没做完**：`podCoverageOf` 把两条并成一个结论。
//
// 余量的阈值只是"该补货了"的提示线，不是账：低于线标黄，等于 0 标红，负数是"盘点发现少了"（红）。
// 阈值 20 件来自计划（"如 20 件"），与"每张 20 件"的排版值无关 —— 别把它接到排版参数上。

/** M3 的认领门禁（60%） */
export const POD_COVERAGE_TARGET = 60;
/** 余量低于这个件数就标黄（该补货了） */
export const POD_LOW_STOCK_PIECES = 20;

export interface PodBindingStatsInput {
  total: number;
  bound: number;
  /** 「同色多图」的颜色数（`image_key <> ''`） */
  collapsed: number;
  /** 「同色多图」里已认好的 */
  collapsedBound: number;
}

export interface PodCoverage {
  /** 已认好 / 总颜色（0 时按 0，不写 NaN） */
  pct: number;
  target: number;
  /** 认领率达标**且**「同色多图」全部确认 —— 两个都满足才算"可以进订花纸" */
  ok: boolean;
  /** 一句话结论（界面顶栏显示这一句，不自拼第二句） */
  text: string;
  tone: 'ok' | 'warn' | 'danger';
  /** 还差多少颜色才到 60%（向上取整；达标 = 0） */
  gapToTarget: number;
}

export function podCoverageOf(stats: PodBindingStatsInput | null | undefined): PodCoverage {
  const total = Math.max(0, Math.round(Number(stats?.total) || 0));
  const bound = Math.max(0, Math.round(Number(stats?.bound) || 0));
  const collapsed = Math.max(0, Math.round(Number(stats?.collapsed) || 0));
  const collapsedBound = Math.max(0, Math.round(Number(stats?.collapsedBound) || 0));
  const pct = total > 0 ? Math.min(100, Math.round((bound / total) * 1000) / 10) : 0;
  const collapseLeft = Math.max(0, collapsed - collapsedBound);
  // 60% 的门槛按"已认数达到 ceil(total*0.6)"算，不按四舍五入后的百分比 ——
  // 否则 59.6% 会显示成 59.6 却 `>= 60` 判真（或反过来），结论与屏上的数字对不上。
  const needCount = Math.ceil(total * (POD_COVERAGE_TARGET / 100));
  const gapToTarget = Math.max(0, needCount - bound);
  const pctOk = total > 0 && bound >= needCount;
  if (total === 0) {
    return {
      pct: 0,
      target: POD_COVERAGE_TARGET,
      ok: false,
      text: '还没有可认的颜色 —— 采集到的店铺商品为空，先去采集店铺商品',
      tone: 'warn',
      gapToTarget: 0,
    };
  }
  if (collapseLeft > 0) {
    return {
      pct,
      target: POD_COVERAGE_TARGET,
      ok: false,
      text: `有 ${collapsed} 个颜色对应多张图，还有 ${collapseLeft} 个没确认（认错会整批印错）`,
      tone: 'danger',
      gapToTarget,
    };
  }
  if (!pctOk) {
    return {
      pct,
      target: POD_COVERAGE_TARGET,
      ok: false,
      text: `已认好 ${pct}%，还差 ${gapToTarget} 个颜色才到 ${POD_COVERAGE_TARGET}%`,
      tone: gapToTarget > needCount / 2 ? 'danger' : 'warn',
      gapToTarget,
    };
  }
  return {
    pct,
    target: POD_COVERAGE_TARGET,
    ok: true,
    text: `已认好 ${pct}%（${bound}/${total}）· ${collapsed} 个「同色多图」都确认过了`,
    tone: 'ok',
    gapToTarget: 0,
  };
}

/** 余量分档（看板标色用） */
export type PodStockTone = 'empty' | 'low' | 'ok';

export function podStockToneOf(remaining: unknown, low = POD_LOW_STOCK_PIECES): PodStockTone {
  const n = Number(remaining);
  const line =
    Number.isFinite(Number(low)) && Number(low) >= 0 ? Number(low) : POD_LOW_STOCK_PIECES;
  if (!Number.isFinite(n) || n <= 0) return 'empty'; // 负余量也是"没了"：盘点发现少了，必须补
  return n < line ? 'low' : 'ok';
}

/** 颜色筛选的四个档（「图案」页顶部；顺序即界面顺序） */
export type PodSlotFilter = 'unbound' | 'collapsed' | 'bound' | 'all';

export const POD_SLOT_FILTER_LABEL: Record<PodSlotFilter, string> = {
  unbound: '待认领',
  collapsed: '需看图确认',
  bound: '已认好',
  all: '全部',
};

// ---------------------------------------------------------------------------
// 按图片认图案（2026-11-02）：筛档与进度
//
// 用户口径换了以后，"认了多少"要按**订单图片**说，而不是按颜色槽位说 —— 因为最终
// 「根据订单中的图片来决定印什么花」。旧的颜色口径（`PodSlotFilter` / `podCoverageOf`）
// 保留给颜色清单（兜底认领 + 同色多图确认），这一组是图片卡片用的。
// ---------------------------------------------------------------------------

/** 图片卡片的四个筛档（顺序即界面顺序） */
export type PodImageFilter = 'unbound' | 'bound' | 'noImage' | 'all';

export const POD_IMAGE_FILTER_LABEL: Record<PodImageFilter, string> = {
  unbound: '还差认图案',
  bound: '已认好',
  noImage: '没有图的订单',
  all: '全部都看',
};

export interface PodImageCoverageInput {
  /** 待发货总件数 */
  waitingPieces: number;
  /** 其中还没认图案的件数 */
  unboundWaitingPieces: number;
  /** 还没认图案、且有待发件的图片卡片数 */
  unboundWaitingGroups: number;
  /** 认不了的行数（没图、也没有商品ID） */
  unbindableRows?: number;
}

export interface PodImageCoverage {
  /** 已认好 / 待发件（按件算；0 时按 0，不写 NaN） */
  pct: number;
  /** 一句话结论（界面顶栏显示这一句，不自拼第二句） */
  text: string;
  tone: 'ok' | 'warn' | 'danger';
  /** 还有待发件没认图案（= 清单必然偏少） */
  blocked: boolean;
}

/**
 * 「认图案」的进度结论（按**待发件**算，不按颜色数算）。
 *
 * 为什么不复用 60% 那条线：那条线的对象是"店铺商品里的所有颜色"（560 个，是个长期清单），
 * 而这里问的是"**今天要发的**货，图案认全了没有" —— 认不全就会漏印，跟 60% 一点关系都没有。
 */
export function podImageCoverageOf(
  input: PodImageCoverageInput | null | undefined
): PodImageCoverage {
  const waiting = Math.max(0, Math.round(Number(input?.waitingPieces) || 0));
  const unbound = Math.min(
    waiting,
    Math.max(0, Math.round(Number(input?.unboundWaitingPieces) || 0))
  );
  const groups = Math.max(0, Math.round(Number(input?.unboundWaitingGroups) || 0));
  const unbindable = Math.max(0, Math.round(Number(input?.unbindableRows) || 0));
  const pct =
    waiting > 0 ? Math.min(100, Math.round(((waiting - unbound) / waiting) * 1000) / 10) : 0;
  if (waiting <= 0) {
    return {
      pct: 0,
      text: '现在没有「等我发货」的订单 —— 有单进来了再回来认图案',
      tone: 'warn',
      blocked: false,
    };
  }
  if (unbound > 0) {
    return {
      pct,
      text: `要发的 ${waiting} 件里有 ${unbound} 件还没认图案（${groups} 张图）—— 认完这份清单才准`,
      tone: 'danger',
      blocked: true,
    };
  }
  if (unbindable > 0) {
    return {
      pct,
      text: `要发的 ${waiting} 件都认好了，但有 ${unbindable} 行没图也没商品ID，认不了（它们不会进报单）`,
      tone: 'warn',
      blocked: false,
    };
  }
  return { pct, text: `要发的 ${waiting} 件都认好图案了`, tone: 'ok', blocked: false };
}

/** 图案卡片上的识别图文案（"N 张识别图" / "还没挂识别图"） */
export function podImageCountLabel(count: unknown): string {
  const n = Math.max(0, Math.round(Number(count) || 0));
  return n > 0 ? `${n} 张识别图` : '还没挂识别图';
}

/** 认领来源 → 人话（台账里 `source` 只有三个值） */
export const POD_BIND_SOURCE_LABEL: Record<string, string> = {
  image: '照着图认的',
  name: '按颜色名认的',
  manual: '手工认的',
};

/**
 * 键盘流提示（「图案」页订单图片名单上方那一行字）。
 *
 * 为什么文案要下沉到纯函数：`Space` 多选 / `1-9` 快选 / `Enter` 确认 / `N` 新建 / `S` 跳过
 * 这一套是**唯一的用法**，写在 `.vue` 里就没法被单测钉住；而快捷键文案写歪（比如把
 * `Enter` 说成"下一张"）会让人以为确认不用按键，认到一半才发现没保存。
 */
export const POD_KEY_HINTS: { key: string; do: string }[] = [
  { key: 'Space', do: '选中/取消这张图' },
  { key: '1-9', do: '认成第 N 个图案（最近的在前）' },
  { key: 'Enter', do: '确认并跳到下一张图' },
  { key: '← →', do: '切换当前图' },
  { key: 'N', do: '新建图案' },
  { key: 'M', do: '合并图案（几个图案其实是同一个花）' },
  { key: 'S', do: '跳过（这次不认，留着下次再认）' },
];

/**
 * 下一个图案编号：按现有 `P001` 这类编号取最大 + 1。
 *
 * 用户不该被要求记编号规则；新建图案时直接预填一个空位上（仍可改）。
 * 只认 `P` + 数字的形状：其它命名（例如花纸商自己的编号）不参与自增，避免把别人的编码算乱。
 */
export function nextPodPatternCode(codes: readonly string[]): string {
  let max = 0;
  for (const raw of Array.isArray(codes) ? codes : []) {
    const m = /^P(\d+)$/i.exec(String(raw ?? '').trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `P${String(max + 1).padStart(3, '0')}`;
}
