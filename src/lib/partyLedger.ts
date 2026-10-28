// src/lib/partyLedger.ts
// 「资金相关人」往来余额与结算校验（纯函数，零依赖）。
//
// 这一层只回答一个问题：**「我跟他之间到底还差多少钱」**，以及「现在能不能结、结多少」。
// 它与「店铺成本归属」是两条正交的轴（见 docs/plans/LEDGER_PLAN.md §4.1 判据 7）：
//   一笔房租可以摊给 5 家店（店铺轴），但只跟 1 个房东结算（相关人轴）。
//   所以本文件完全不出现 shop / allocation 的概念 —— 一旦两者混在一个算式里，
//   「按店统计」与「按人结算」必然有一个是错的，而且错得不明显。
//
// ---- 三条口径（改了必须同步改文档与测试）----
//   1. 净往来 = 应收 − 应付。正数 = 对方欠我；负数 = 我欠对方。
//   2. 已结算净额 = Σ(我付出去的有效结算) − Σ(我收到的有效结算)。
//      ⚠️ 它是**对净往来的调整量**，不是"已结掉多少钱"这种无方向的额度：
//        我付出会让"我欠的"变少（对 net 而言是 +），我收到会让"对方欠我的"变少（对 net 是 −）。
//   3. 未结清 = 净往来 **+** 已结算净额。
//
//      ⚠️ 这里是**加号**，方案 v1.1 §6.2 原写"净往来 − 已结算净额"是错的（符号反了）：
//        我欠 1000（net=−1000）、付了 1000（settledNet=+1000），按减法会算出 −2000（越结越欠）。
//        按加法才是 0。单测 `partyLedger.spec.ts` 的「已付出去的结算冲减欠款」正守着这条。
//
// ---- 互抵单（`direction='offset'`，2026-10-27）----
//   一张单同时挂收入与支出条目，把两笔债务当场核销，只发生差额的资金流。
//   它对本文件的影响：**两侧毛额各减各的余额**（不是只减净额）——
//   应付 1000、应收 400 互抵后，"可付"必须归零、"可收"也必须归零；
//   若只按净额 600 记，会出现"可付还剩 400"的假余额，用户会被引导去再付一次。
//   故 `SettlementLite` 对互抵单要求 `payCents`/`receiveCents` 两侧毛额，缺了**直接抛错**
//   （按 0 计等于这笔钱在余额里凭空消失，而单据仍赫然在列）。
//
// 结算**只改往来状态，不产生收支**（方案 §1.3 硬规则 4）。所以本文件里没有任何
// "生成一条支出"的出口 —— 那是 RK-03（支出翻倍）的结构性防线。

/** 往来计算需要的条目最小形状（只取与本文件有关的字段） */
export interface LedgerEntryLite {
  kind: 'income' | 'expense';
  amountCents: number;
  /** 缺省视为 active；`void` 的条目不计入任何往来 */
  status?: 'active' | 'void';
}

/** 结算单最小形状 */
export interface SettlementLite {
  /** `pay` = 我付给对方；`receive` = 对方付给我；`offset` = 互抵结清（两边同时核销） */
  direction: 'pay' | 'receive' | 'offset';
  /** 单据毛额（= 结算行之和） */
  amountCents: number;
  /**
   * 互抵单的毛额拆分：支出侧 / 收入侧。
   * `direction='offset'` 时**必填**，缺了直接抛错 —— 按 0 计会让这张单对余额毫无影响，
   * 而页面上它还在列表里（钱在余额里凭空消失，且没有任何报错）。
   */
  payCents?: number;
  receiveCents?: number;
  status?: 'active' | 'void';
}

/** 一个人的往来五行（界面上必须同时显示，缺一行用户就得自己减） */
export interface PartyBalance {
  /** 应收：我该从对方收（收入类条目合计） */
  receivableCents: number;
  /** 应付：我该付给对方（支出类条目合计） */
  payableCents: number;
  /** 净往来 = 应收 − 应付 */
  netCents: number;
  /** 已结算净额 = Σpay − Σreceive（对净往来的**调整量**，付出为正） */
  settledNetCents: number;
  /** 未结清（净额）= 净往来 + 已结算净额；0 = 已结清 */
  unsettledCents: number;
  /**
   * **应收方向**还能结多少 = 应收 − 已收。
   *
   * 为什么必须按方向各给一个数，而不能只给净额：
   *   同一个供应商可能既欠我钱（退货/返利）又该我付（新货款）。净额 2000 时，
   *   "我欠他 3000"这笔账照样该付 —— 只拿 `|净额|` 当上限会把它误拦成超额。
   *   分方向的余额才是"这个方向还能结多少"的真实答案。
   */
  unsettledReceivableCents: number;
  /** **应付方向**还能结多少 = 应付 − 已付 */
  unsettledPayableCents: number;
}

/** 金额入参校验：非负整数分 */
function checkedCents(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what}金额不是有效数字`);
  if (!Number.isInteger(value)) throw new Error(`${what}金额必须是整数分`);
  if (value < 0) throw new Error(`${what}金额不能为负（方向由类型表达，不用负数）`);
  return value;
}

/** 是不是合法的非负整数分（校验类函数用，不抛错） */
function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * 算一个人的往来五行。
 *
 * 作废的条目与作废的结算单一律跳过 —— 作废 = 这笔从未发生，而不是"金额为 0"。
 * 金额非法直接抛错：静默当 0 会让台账数字变小，而且页面照常显示，
 * 属于典型的"静默失败"（钱从报表里消失，却没有任何报错）。
 */
export function partyBalance(
  entries: readonly LedgerEntryLite[],
  settlements: readonly SettlementLite[],
): PartyBalance {
  let receivableCents = 0;
  let payableCents = 0;
  for (const e of entries) {
    if ((e?.status ?? 'active') === 'void') continue;
    const amount = checkedCents(e?.amountCents, '条目');
    if (e?.kind === 'income') receivableCents += amount;
    else if (e?.kind === 'expense') payableCents += amount;
    else throw new Error(`条目类型非法：${String(e?.kind)}`);
  }

  let settledPayCents = 0;
  let settledReceiveCents = 0;
  for (const s of settlements) {
    if ((s?.status ?? 'active') === 'void') continue;
    const amount = checkedCents(s?.amountCents, '结算单');
    if (s?.direction === 'pay') settledPayCents += amount;
    else if (s?.direction === 'receive') settledReceiveCents += amount;
    else if (s?.direction === 'offset') {
      const pay = s.payCents;
      const receive = s.receiveCents;
      if (typeof pay !== 'number' || typeof receive !== 'number') {
        throw new Error('互抵结算单缺少支出/收入侧金额（不能按 0 计，否则余额会漏掉这张单）');
      }
      const payCents = checkedCents(pay, '互抵结算单支出侧');
      const receiveCents = checkedCents(receive, '互抵结算单收入侧');
      if (payCents + receiveCents !== amount) {
        throw new Error('互抵结算单毛额与两侧金额之和不一致');
      }
      // 两侧各减各的：只减净额会让另一个方向留下假余额（见文件头「互抵单」一节）
      settledPayCents += payCents;
      settledReceiveCents += receiveCents;
    } else throw new Error(`结算方向非法：${String(s?.direction)}`);
  }

  const netCents = receivableCents - payableCents;
  const settledNetCents = settledPayCents - settledReceiveCents;
  return {
    receivableCents,
    payableCents,
    netCents,
    settledNetCents,
    // 加号：付出让"我欠的"变少，收到的让"对方欠我的"变少（见文件头 §2/§3）
    unsettledCents: netCents + settledNetCents,
    // 分方向：两个数之差恒等于净额（用例里断言了这条，改错会立刻红）
    unsettledReceivableCents: receivableCents - settledReceiveCents,
    unsettledPayableCents: payableCents - settledPayCents,
  };
}

/** 往来抽屉的时间线事件（条目与结算单混排；金额恒为正，方向由 `kind` 表达） */
export interface PartyTimelineEvent {
  /** 业务日期 `YYYY-MM-DD`；结算单取 `settle_date` */
  date: string;
  kind: 'income' | 'expense' | 'settle-pay' | 'settle-receive';
  amountCents: number;
  /** 缺省视为 active；作废事件保留在时间线上，但**不影响余额** */
  status?: 'active' | 'void';
}

/**
 * 给时间线逐行算「未结清余额（截至这一笔之后）」。
 *
 * 与 `partyBalance` 同一套符号：收入 +、支出 −、我付出 +、我收到 −
 * （`未结清 = 净往来 + 已结算净额`，见文件头 §2/§3）。
 * 返回数组与**入参下标一一对应**（抽屉按日期倒序展示时，仍能取到该行自己的余额）；
 * 排序只在函数内部按日期升序做一次 —— 界面上再排一次，两处都"看起来对"但余额会错位。
 */
export function runningUnsettled(
  events: readonly PartyTimelineEvent[],
  baseCents = 0,
): Array<{ index: number; balanceCents: number }> {
  const order = events
    .map((e, index) => ({ e, index }))
    .sort((a, b) => (a.e.date === b.e.date ? a.index - b.index : a.e.date < b.e.date ? -1 : 1));
  const out: Array<{ index: number; balanceCents: number }> = new Array(events.length);
  // 起始余额：相关人合并承接的残额（`bk_transfers`）不在逐笔事件里，但确实在「未结清」里。
  // 不把它作为起点，最后一行就永远差这个数 —— 用户得自己加回去（审查 P2-15）。
  let balance = baseCents;
  for (const { e, index } of order) {
    if ((e.status ?? 'active') !== 'void') {
      const amount = checkedCents(e.amountCents, '时间线事件');
      if (e.kind === 'income' || e.kind === 'settle-pay') balance += amount;
      else if (e.kind === 'expense' || e.kind === 'settle-receive') balance -= amount;
      else throw new Error(`时间线事件类型非法：${String(e.kind)}`);
    }
    out[index] = { index, balanceCents: balance };
  }
  return out;
}

/** 结算拒绝原因（前端据此给出不同文案与跳转，不要混成一句"结算失败"） */
export type SettleRejectReason = 'invalid-amount' | 'nothing-to-settle' | 'over-amount';

/** 结算校验结果 */
export type SettleCheck = { ok: true } | { ok: false; reason: SettleRejectReason; message: string };

/**
 * 能不能按这个方向、这个金额结算。
 *
 * ---- 判据是「该方向的余额」，不是「净额」（实现时修正了方案原文）----
 *   方案 §6.3 原写"金额超出 |未结清| 直接拒"，用的是**净额**。但同一人可能既欠我钱
 *   （退货/返利）又该我付（新货款）：应收 5000、应付 3000 时净额只有 2000，
 *   拿它当上限会把"该付的 3000"误判成超额，用户永远结不掉这笔账。
 *   所以上限取**同方向**的余额：付出看应付余额、收到看应收余额。
 *
 * 三条拦截，每一条都对应一种真实的资损/错账：
 *   ① 该方向没有余额 → 没有可结的东西（再结就是凭空多付/多收一笔）；
 *   ② 金额不得超过该方向余额 —— 本期不做预付/多付（方案 §13）；
 *   ③ 金额必须是正整数分。
 *
 * 金额由调用方按「勾选条目之和」算好传入，**不允许手填**（方案 §6.3）。
 */
export function canSettle(
  balance: PartyBalance,
  direction: 'pay' | 'receive',
  amountCents: number,
): SettleCheck {
  if (direction !== 'pay' && direction !== 'receive') {
    return { ok: false, reason: 'invalid-amount', message: '结算方向非法' };
  }
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'invalid-amount', message: '结算金额必须是大于 0 的整数分' };
  }
  const available = direction === 'pay' ? balance?.unsettledPayableCents : balance?.unsettledReceivableCents;
  const other = direction === 'pay' ? balance?.unsettledReceivableCents : balance?.unsettledPayableCents;
  if (typeof available !== 'number' || !Number.isInteger(available)) {
    return { ok: false, reason: 'invalid-amount', message: '往来余额异常，已拒绝结算' };
  }
  if (available <= 0) {
    const which = direction === 'pay' ? '应付' : '应收';
    const hint =
      Number.isInteger(other) && other > 0
        ? `；另有 ${other} 分在${direction === 'pay' ? '应收' : '应付'}方向，请改选结算方向`
        : '';
    return {
      ok: false,
      reason: 'nothing-to-settle',
      message: `这个人在「${which}」方向已经没有余额了，没有可结算的条目${hint}`,
    };
  }
  if (amountCents > available) {
    return {
      ok: false,
      reason: 'over-amount',
      message: `结算金额超出该方向未结清 ${available} 分（本期不支持预付/多付）`,
    };
  }
  return { ok: true };
}

/**
 * 能不能按「互抵结清」结这批条目。
 *
 * 与 `canSettle` 的区别：互抵没有单向资金流，所以**不能只看一个方向的上限**，
 * 而是两侧各自不得超出自己方向的余额 —— 否则等于拿已经结过的额度再抵一次。
 * 额外两条：
 *   ① 两侧都必须有金额：只勾单方向时这不是互抵，是普通结算（截下来让他改选方向，
 *      比默默按普通单处理安全 —— 后者用户以为"抵过了"，实际只清了一边）；
 *   ② 两侧都必须是正整数分。
 * 净额可以是 0（完全对冲）甚至为负（我净收到），都不拦 —— 那正是互抵要表达的东西。
 */
export function canOffsetSettle(
  balance: PartyBalance,
  payCents: number,
  receiveCents: number,
): SettleCheck {
  if (!isCents(payCents) || !isCents(receiveCents)) {
    return { ok: false, reason: 'invalid-amount', message: '互抵金额必须是整数分' };
  }
  if (payCents <= 0 || receiveCents <= 0) {
    return {
      ok: false,
      reason: 'invalid-amount',
      message: '互抵结清必须同时勾选收入与支出条目；只勾单方向请改选结算方向',
    };
  }
  const availPay = balance?.unsettledPayableCents;
  const availReceive = balance?.unsettledReceivableCents;
  if (!isCents(availPay) || !isCents(availReceive)) {
    return { ok: false, reason: 'invalid-amount', message: '往来余额异常，已拒绝结算' };
  }
  if (payCents > availPay) {
    return {
      ok: false,
      reason: 'over-amount',
      message: `互抵里的支出部分 ${payCents} 分超出应付未结清 ${availPay} 分`,
    };
  }
  if (receiveCents > availReceive) {
    return {
      ok: false,
      reason: 'over-amount',
      message: `互抵里的收入部分 ${receiveCents} 分超出应收未结清 ${availReceive} 分`,
    };
  }
  return { ok: true };
}

/**
 * 结算单金额 = 所勾选条目金额之和（**唯一算法**）。
 *
 * 让调用方传金额进来再比对是不行的：那样"手改了金额"和"勾错了条目"两种情况长得一样，
 * 无法区分。这里只接受条目金额数组，前端展示的金额也走本函数，从结构上没有第二个数。
 */
export function settlementAmountOf(entryAmounts: readonly number[]): number {
  let sum = 0;
  for (const amount of entryAmounts) sum += checkedCents(amount, '结算条目');
  return sum;
}
/**
 * 全局体检：`Σ 所有人净往来 == 总收入 − 总支出`。
 *
 * 恒为 0 才正常。非 0 只有一种解释：有条目没挂到任何人头上，或者某处按人聚合漏了一个桶。
 * 相关人已改为**必填**（方案 §6.1），所以这里不需要再减「未指定」桶 —— 等式应当是严格的。
 * @returns 差额（分）；0 = 通过
 */
export function partyLedgerGap(totalIncomeCents: number, totalExpenseCents: number, netSumCents: number): number {
  return netSumCents - (totalIncomeCents - totalExpenseCents);
}

/** 往来方向的中文说明（界面与错误提示共用一份，避免两处说法不一致） */
export function describeNet(netCents: number): string {
  if (netCents === 0) return '已结清';
  return netCents > 0 ? '对方欠我' : '我欠对方';
}
