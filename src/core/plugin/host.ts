// src/core/plugin/host.ts
// Host API 渲染层 trusted 实现（Phase 2：收敛渲染层六域）。
// 依赖方向：core/services（ipc 服务层）+ core/network（默认 axios 实例），不直接触 window.electronAPI。
// 说明：本实现是"宿主能力面"的 trusted 实现，供插件上下文注入；
//       插件侧拿到的是接口端口（HostApi），权限门（Phase 3+）在桥层二次拦截。

import { writeClipboard } from '@/core/services/clipboard';
import { selectExcelFile, selectTemplateFile } from '@/core/services/dialog';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { useModuleStorage } from '@/core/services/storage';
import http from '@/core/network/request';
import type { DialogOptions, FilePayload, HostApi, PluginHttpOptions } from './sdk';

/** 当前应用的平台与版本信息（版本异步拉取一次，缓存于 getter 闭包） */
function createEnv(): HostApi['env'] {
  let version = '';
  void ipc
    .getAppVersion()
    .then((r) => {
      if (r.success && r.data) version = r.data;
    })
    .catch(() => {});
  return {
    isMac: ipc.platform === 'darwin',
    platform: ipc.platform,
    get version() {
      return version;
    },
  };
}

/**
 * 创建 HostApi 渲染层 trusted 实现。
 * storage 收敛为命名空间持久化（modules.<ns>，复用 useModuleStorage 底层 IPC）。
 */
export function createHostApi(): HostApi {
  const env = createEnv();

  const host: HostApi = {
    storage: {
      async load<T>(ns: string): Promise<T | undefined> {
        // 底层存储按命名空间返回 Partial 对象；宿主层显式收窄为 T（命名空间即记录对象）
        const data = await useModuleStorage(ns).load();
        return data === null || data === undefined ? undefined : (data as unknown as T);
      },
      async save<T>(ns: string, v: T): Promise<void> {
        await useModuleStorage(ns).save(v as Record<string, unknown>);
      },
      async clear(ns: string): Promise<void> {
        await useModuleStorage(ns).clear();
      },
    },
    clipboard: {
      async writeText(text: string): Promise<void> {
        const ok = await writeClipboard(text);
        if (!ok) throw new Error('clipboard write rejected by host');
      },
    },
    http: {
      async get<T>(url: string, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.get<T>(url, opts);
        return res.data as T;
      },
      async post<T>(url: string, body?: unknown, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.post<T>(url, body, opts);
        return res.data as T;
      },
    },
    dialog: {
      async openFile(opts: DialogOptions): Promise<FilePayload | null> {
        if (opts.kind === 'excel') {
          const f = await selectExcelFile();
          if (!f) return null;
          return { kind: 'excel', filePath: f.filePath, data: f.data };
        }
        if (opts.kind === 'template') {
          const f = await selectTemplateFile();
          if (!f) return null;
          return { kind: 'template', filePath: f.filePath, content: f.content };
        }
        const r = await ipc.selectDirectory();
        if (!r.success || !r.data) return null;
        return { kind: 'directory', filePath: r.data };
      },
    },
    ui: {
      openSettings(category?: string, tab?: string): void {
        // 对接 AppShell 已监听的 open-settings 事件，沿用现有"dispatch 事件定位设置"机制
        window.dispatchEvent(new CustomEvent('open-settings', { detail: { category, tab } }));
      },
      notify(o: { kind: 'success' | 'error' | 'info'; text: string }): void {
        toast(o.text, o.kind);
      },
    },
    env,
  };

  return host;
}
