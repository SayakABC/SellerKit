// 模块命名空间持久化服务。
//
// 每个模块通过 useModuleStorage('<id>') 获得独立的 load/save/scheduleSave/clear，
// 底层数据落在 electron-store 的 `modules.<id>` 命名空间下，模块之间互不污染。
// 防抖保存（scheduleSave）用于替代原来各模块私有的 saveTimeout 逻辑。

import { ipc } from './ipc';

const SAVE_DEBOUNCE_MS = 500;

export interface ModuleStorage<T = Record<string, unknown>> {
  /** 读取模块持久化数据（命名空间为空时返回 null） */
  load(): Promise<Partial<T> | null>;
  /** 立即保存 */
  save(data: T): Promise<void>;
  /** 防抖保存（默认 500ms） */
  scheduleSave(data: T): void;
  /** 清空模块数据 */
  clear(): Promise<void>;
}

export function useModuleStorage<T = Record<string, unknown>>(moduleId: string): ModuleStorage<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<Partial<T> | null> {
    const result = await ipc.getModuleState(moduleId);
    if (result.success && result.data) {
      return result.data as Partial<T>;
    }
    return null;
  }

  async function save(data: T): Promise<void> {
    try {
      // 清洗为纯 JSON 再落盘：electron-store 本身即 JSON 存储，
      // 且 IPC 结构化克隆无法处理函数/Map/undefined 等值，
      // 预清洗可避免抛 "An object could not be cloned"。
      const sanitized = JSON.parse(JSON.stringify(data));
      await ipc.setModuleState(moduleId, sanitized);
    } catch (e) {
      console.error('[storage] save failed:', e);
    }
  }

  function scheduleSave(data: T): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void save(data);
    }, SAVE_DEBOUNCE_MS);
  }

  async function clear(): Promise<void> {
    await save({} as T);
  }

  return { load, save, scheduleSave, clear };
}
