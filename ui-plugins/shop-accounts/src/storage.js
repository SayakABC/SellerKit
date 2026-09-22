// src/storage.js — 命名空间持久化适配层（对应宿主 @/core/services/storage 的 useModuleStorage）。
// 数据落宿主的 modules.<namespaceId>（electron-store），与内建版共用同一命名空间，
// 因此视图偏好（视图模式 / 分组维度 / 当前页签）从内建版切到本岛后自动延续。

import { storage } from './bridge.js';

/** 防抖写间隔（与宿主 useModuleStorage 一致） */
const SAVE_DEBOUNCE_MS = 500;

export function useModuleStorage(namespaceId) {
  let timer = null;
  let pending = null;

  async function load() {
    try {
      const data = await storage.load(namespaceId);
      return data === null || data === undefined ? null : data;
    } catch {
      return null;
    }
  }

  async function save(data) {
    try {
      await storage.save(namespaceId, data);
    } catch {
      /* 写入失败不阻塞交互 */
    }
  }

  /** 防抖写（高频交互如切换视图模式用） */
  function scheduleSave(data) {
    pending = data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (next !== null && next !== undefined) void save(next);
    }, SAVE_DEBOUNCE_MS);
  }

  async function clear() {
    try {
      await storage.clear(namespaceId);
    } catch {
      /* 同上 */
    }
  }

  return { load, save, scheduleSave, clear };
}
