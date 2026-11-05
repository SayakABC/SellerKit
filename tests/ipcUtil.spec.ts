// ipc-util 单测 —— 这个封装是渲染层 ↔ 主进程全部 129 个通道的唯一注册入口，
// 它的返回形状（{ success, data?, error? }）与异常兜底一旦变了，
// 影响的不是某个功能，而是整个 IPC 边界。故用假 ipcMain 单独钉住契约。
//
// 用 vi.mock 替换 electron：真实 electron 在 Node 环境下只能拿到二进制路径，
// 没有 ipcMain。这里只关心「注册进去的回调做了什么」，不关心 Electron 本体。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 的工厂会被提升到 import 之前，因此共享状态必须经 vi.hoisted 定义
const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (...args: any[]) => any>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => {
      registered.set(channel, fn);
    },
  },
}));

import { register, handle } from '../electron/ipc-util';

/** 取回注册的回调并按 Electron 的调用形态触发（第 1 参为事件对象） */
const invoke = (channel: string, payload?: unknown) => registered.get(channel)!(null, payload);

beforeEach(() => registered.clear());

describe('register · handler 自行返回业务结果', () => {
  it('把 handler 的返回值原样透传，不做二次包装', async () => {
    register('t-ok', () => ({ success: true, data: { id: 1 } }));
    expect(await invoke('t-ok')).toEqual({ success: true, data: { id: 1 } });
  });

  it('handler 主动返回的校验失败也原样透传（不被当成异常）', async () => {
    register('t-invalid', () => ({ success: false, error: 'invalid payload' }));
    expect(await invoke('t-invalid')).toEqual({ success: false, error: 'invalid payload' });
  });

  it('支持 async handler 与 payload 透传', async () => {
    register('t-async', async (p: any) => ({ success: true, data: p.n * 2 }));
    expect(await invoke('t-async', { n: 21 })).toEqual({ success: true, data: 42 });
  });

  it('抛出 Error → { success:false, error: 消息 }', async () => {
    register('t-throw', () => {
      throw new Error('boom');
    });
    expect(await invoke('t-throw')).toEqual({ success: false, error: 'boom' });
  });

  it('抛出「非对象」不炸：兜成 fallback 文案而非 reject', async () => {
    // 回归点：原实现写的是 err.message，遇到 throw null / throw undefined
    // 会在 catch 块内再抛 TypeError，使 IPC 变成 reject、渲染层拿到未处理拒绝。
    register('t-throw-null', () => {
      throw null;
    });
    await expect(invoke('t-throw-null')).resolves.toEqual({ success: false, error: 'Unknown error' });
  });

  it('抛出无 message 的对象 → fallback 文案', async () => {
    register('t-throw-empty', () => {
      throw { code: 'E_FAIL' };
    });
    expect(await invoke('t-throw-empty')).toEqual({ success: false, error: 'Unknown error' });
  });
});

describe('handle · 由本层包装成 { success, data }', () => {
  it('同步 handler 的返回值被包成 success:true', async () => {
    handle('t-sync', (p: any) => ({ rows: [p] }));
    expect(await invoke('t-sync', 7)).toEqual({ success: true, data: { rows: [7] } });
  });

  it('async handler 同样被 await 后包装', async () => {
    handle('t-awaited', async () => 3);
    expect(await invoke('t-awaited')).toEqual({ success: true, data: 3 });
  });

  it('返回 null / undefined 也算成功（与 register 的差异点：不要求 handler 自造 success）', async () => {
    handle('t-null', () => null);
    expect(await invoke('t-null')).toEqual({ success: true, data: null });
  });

  it('抛出 Error → { success:false, error: 消息 }', async () => {
    handle('t-h-throw', () => {
      throw new Error('查询失败');
    });
    expect(await invoke('t-h-throw')).toEqual({ success: false, error: '查询失败' });
  });

  it('抛出「非对象」不炸，回落为「未知错误」', async () => {
    handle('t-h-throw-null', () => {
      throw undefined;
    });
    await expect(invoke('t-h-throw-null')).resolves.toEqual({ success: false, error: '未知错误' });
  });
});

describe('通道注册本身', () => {
  it('通道名原样交给 ipcMain.handle，不做归一化', () => {
    register('order-db-ensure', () => ({ success: true }));
    handle('t-channel-name', () => 1);
    expect([...registered.keys()]).toEqual(['order-db-ensure', 't-channel-name']);
  });

  it('两个封装互不串用：register 的 handler 返回裸数据不会被当成功', async () => {
    register('t-raw', (() => 5) as any);
    // 这是两种契约的边界——register 不做包装，故裸值会原样回给渲染层
    expect(await invoke('t-raw')).toBe(5);
  });

  it('两套 fallback 文案各自固定（会直接显示给用户，不可静默统一）', async () => {
    register('t-msg-r', () => {
      throw null;
    });
    handle('t-msg-h', () => {
      throw null;
    });
    expect((await invoke('t-msg-r')).error).toBe('Unknown error');
    expect((await invoke('t-msg-h')).error).toBe('未知错误');
  });
});
