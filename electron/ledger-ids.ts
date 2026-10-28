/**
 * 批量 id 的消毒与上限。
 *
 * 单独成文件是为了能被单测直接打：上限错了的后果是**静默少处理**（勾 800 条只改 500 条，
 * 结果提示还写"已改挂 500 条"），界面上看不出任何异常（审查 P1-5）。
 */

/** 与 `ledger-entry-list` 的取数上限（2000）对齐：批量操作不该处理比列表能显示的更多条目 */
export const LEDGER_BATCH_ID_LIMIT = 2000;

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 去重、只留正整数；**超过上限直接抛错**而不是 `break`。
 *
 * 静默截断会让"勾了 800 条"变成"改了 500 条"，而用户以为自己改完了 —— 剩下的 300 条
 * 处于"改了一半"的状态，且没有任何提示引导他补齐。
 */
export function normalizeIdList(v: unknown, limit = LEDGER_BATCH_ID_LIMIT): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const item of v) {
    const n = toInt(item);
    if (n > 0) seen.add(n);
  }
  const out = [...seen];
  if (out.length > limit) {
    throw new Error(`一次最多处理 ${limit} 条，这次选了 ${out.length} 条 —— 请缩小范围后重试`);
  }
  return out;
}
