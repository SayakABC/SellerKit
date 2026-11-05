// electron/podLedger.ts
// **印花扣减的批次分配**（M4·T4-4 的判定层，纯函数、零依赖）。
//
// 图案域把"件"记成流水（`pod_sheet_ledger`：到货 +、印花 -、盘点 ±），余量 = 求和。
// 印花时要回答一个问题：**这 N 件从哪一批上扣？**
//
// 规则只有一条但必须固定：**先到先扣（FIFO）** —— 按 `ordered_at` 从早到晚。
// 为什么不是"从余量最大的批次扣"：批次是**实物**，先买的那批花纸放得久、先发霉/先褪色，
// 生产上本来就该先用掉；从"余量最大"扣会让新旧批次长期并存，而看板上两批都"有余量"，
// 谁也不知道该先动哪一堆。
//
// ⚠️ **不足就整批拒绝，不部分扣**（`shortfall > 0` 时 `allocations` 一律为空）：
// 半扣会让账上凭空出现"已扣 3 件但实际一张花纸都没领"的中间态，而印花完成是按
// **整单**计数的事实 —— 部分扣等于把一次生产拆成两个不存在的半次。
//
// 为什么摘成纯函数（与 `podLinkStats` / `podImageKey` 同一理由）：`electron/*-db.ts`
// 里有 better-sqlite3 的 Electron ABI，vitest 进不来；而"跨批次怎么分、够不够"恰恰是
// 这段逻辑唯一会算错的地方（真库会有"一个图案三批花纸、余量各 3/0/7"这种形状）。

/** 一个批次的当前余量（来自 `pod_sheet_ledger` 的求和；调用方负责算，这里只排序与分配） */
export interface BatchRemaining {
  batchId: number;
  /** 剩余**件**（不是张）。≤ 0 的批次不会被扣（那是"这批用完了"） */
  remaining: number;
  /** 报单日期 `yyyy-mm-dd`（空串 = 不知道 ⇒ 视为**最新**，排在队尾） */
  orderedAt: string;
}

export interface PrintAllocation {
  batchId: number;
  pieces: number;
}

export interface PrintPlan {
  /** 每批扣多少件（**只有够扣时非空**；见文件头的"不足就整批拒绝"） */
  allocations: PrintAllocation[];
  /** 还差几件（0 = 够扣；> 0 = 调用方必须拒绝并告诉用户差多少） */
  shortfall: number;
}

/**
 * 把 `pieces` 件印花分摊到批次（FIFO）。
 *
 * @param batches 各批余量（顺序不敏感：本函数自己排；同一日期的批次按 `batchId` 升序）
 * @param pieces 要扣的件数（≤ 0 或非有限数 → 空方案，不算错误）
 * @returns 分配方案；不足时 `allocations` 为空且给出 `shortfall`
 */
export function allocatePrint(batches: readonly BatchRemaining[], pieces: number): PrintPlan {
  const need = Number.isFinite(pieces) ? Math.round(pieces) : 0;
  if (need <= 0) return { allocations: [], shortfall: 0 };

  const usable = (Array.isArray(batches) ? batches : [])
    .filter((b) => b && Number(b.remaining) > 0)
    .map((b) => ({
      batchId: Number(b.batchId) || 0,
      remaining: Math.round(Number(b.remaining)),
      orderedAt: typeof b.orderedAt === 'string' ? b.orderedAt.trim() : '',
    }))
    .filter((b) => b.batchId > 0);

  // FIFO：有日期的在前（早 → 晚），没日期的排最后；同日按批次 id（先建的先用）
  usable.sort((a, b) => {
    if (a.orderedAt && b.orderedAt) return a.orderedAt < b.orderedAt ? -1 : a.orderedAt > b.orderedAt ? 1 : a.batchId - b.batchId;
    if (a.orderedAt) return -1;
    if (b.orderedAt) return 1;
    return a.batchId - b.batchId;
  });

  const available = usable.reduce((s, b) => s + b.remaining, 0);
  if (available < need) return { allocations: [], shortfall: need - available };

  const out: PrintAllocation[] = [];
  let left = need;
  for (const b of usable) {
    if (left <= 0) break;
    const take = Math.min(b.remaining, left);
    if (take > 0) {
      out.push({ batchId: b.batchId, pieces: take });
      left -= take;
    }
  }
  return { allocations: out, shortfall: 0 };
}
