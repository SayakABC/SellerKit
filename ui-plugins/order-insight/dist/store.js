// dist/store.js
// 岛内共享状态：当前批次号、批次统计、处理开关。
// 极简发布订阅，视图之间只通过这里共享「当前批次」语义，不互相 import。

const listeners = new Set();

export const state = {
  /** 当前操作批次号（空串 = 未选择批次） */
  batchNo: '',
  /** 当前批次统计 OrderQueueStats */
  stats: { total: 0, pending: 0, done: 0, error: 0, missing: 0 },
  /** 是否正在处理队列 */
  running: false,
};

/** 更新共享状态并广播（partial 合并） */
export function setState(partial) {
  Object.assign(state, partial);
  listeners.forEach((fn) => fn(state));
}

/** 订阅状态变更，返回退订函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
