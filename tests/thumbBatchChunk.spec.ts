// 批量缩略图的**渲染层拆批**守卫。
//
// 为什么单独一条：主进程那侧是硬截断（`payload.items.slice(0, THUMB_BATCH_MAX)`，40 张），
// 而调用方是按"一页/一单"给路径的 —— 产品页一页 50 行、拣货单可能上百。
// 截断是**静默**的：返回数组短了，界面只是"后面几行的图空着"，既不报错也不提示。
// 拆批放在渲染层包装函数（`src/core/services/ipc.ts` 的 `orderImageThumbBatch`）里，
// 于是这里用「假 window.electronAPI」断言：分了几批、每批多大、顺序有没有乱、失败批有没有补位。
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 每次 `window.electronAPI.orderImageThumbBatch` 收到的 items（按批记录） */
let batches: { localPath: string; maxEdge?: number }[][] = [];
/** 让指定批号（从 0 起）整体失败，验证"坏一批不毁其余" */
let failBatchIndex = -1;

beforeEach(() => {
  vi.resetModules();
  batches = [];
  failBatchIndex = -1;
  // ipc.ts 在**模块求值期**就读 window.electronAPI，所以必须先装好假 window 再 import
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      orderImageThumbBatch: (items: { localPath: string; maxEdge?: number }[]) => {
        const idx = batches.length;
        batches.push(items);
        if (idx === failBatchIndex) return Promise.resolve({ success: false, error: 'boom' });
        return Promise.resolve({
          success: true,
          data: { dataUrls: items.map((it) => (it.localPath.includes('bad') ? null : `data:image/jpeg;base64,${it.localPath}`)) },
        });
      },
    },
  };
});

async function loadWrapper() {
  const mod = await import('@/core/services/ipc');
  return mod.orderImageThumbBatch;
}

function paths(n: number, pattern: (i: number) => string = (i) => `p${i}`) {
  return Array.from({ length: n }, (_, i) => ({ localPath: pattern(i) }));
}

describe('orderImageThumbBatch（渲染层包装：拆批 + 顺序 + 补位）', () => {
  it('超过单批上限时拆成多批，且返回长度与入参一致（不静默截断）', async () => {
    const call = await loadWrapper();
    const r = await call(paths(45));

    expect(batches.map((b) => b.length)).toEqual([40, 5]);
    expect(r.success).toBe(true);
    expect(r.data?.dataUrls).toHaveLength(45);
  });

  it('恰好等于上限时只发一次（边界不额外开一批）', async () => {
    const call = await loadWrapper();
    const r = await call(paths(40));

    expect(batches).toHaveLength(1);
    expect(r.data?.dataUrls).toHaveLength(40);
  });

  it('顺序逐项一致：第 i 个结果对应第 i 个入参（拆批后不许错位）', async () => {
    const call = await loadWrapper();
    // 奇数位放坏路径（返回 null），偶数位正常 —— 只要错位就一眼看得出来
    const r = await call(paths(45, (i) => (i % 2 === 0 ? `ok${i}` : `bad${i}`)));
    const urls = r.data?.dataUrls ?? [];

    expect(urls).toHaveLength(45);
    expect(urls.filter((u) => typeof u === 'string')).toHaveLength(23); // 0,2,…,44
    expect(urls.every((u, i) => (i % 2 === 0 ? typeof u === 'string' : u === null))).toBe(true);
  });

  it('某一批整体失败时只把该批补成 null，其余批次的结果照常返回', async () => {
    const call = await loadWrapper();
    failBatchIndex = 1; // 第二批（第 41..45 个）失败
    const r = await call(paths(45));

    expect(r.success).toBe(true);
    const urls = r.data?.dataUrls ?? [];
    expect(urls).toHaveLength(45);
    expect(urls.slice(0, 40).every((u) => typeof u === 'string')).toBe(true);
    expect(urls.slice(40)).toEqual([null, null, null, null, null]);
  });

  it('空数组不发起任何往返（省一次 IPC）', async () => {
    const call = await loadWrapper();
    const r = await call([]);

    expect(batches).toHaveLength(0);
    expect(r.data?.dataUrls).toEqual([]);
  });
});
