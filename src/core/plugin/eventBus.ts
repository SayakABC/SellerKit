// src/core/plugin/eventBus.ts
// 事件总线：插件间 / 宿主与插件间通信的唯一通道（不直接依赖对方模块）。
// 约束：payload 必须可结构化克隆（跨 Worker/iframe 透传的前提）；meta 由宿主填充来源。
// 通配订阅（T9）：type 以 * 结尾视为通配 pattern（如 'plugin:*' 匹配全部 plugin: 前缀事件）；
//   同一事件内先精确集合、后通配集合（各自保持注册序）；meta.eventType 携带实际事件名，
//   通配订阅下与订阅 pattern 不同（Worker 端据此本地路由）。
// 基础设施级捕获：单个监听器抛错不中断其它监听器（区别于业务代码的异常纪律）。

export type EventOrigin = 'host' | 'plugin';

export interface EventMeta {
  /** 事件来源插件 id（宿主填充，不可伪造；host 事件为 'host'） */
  sourcePlugin: string;
  origin: EventOrigin;
  /** true 表示本次传播经历了结构化克隆（跨沙箱），payload 已序列化校验 */
  serialized: boolean;
  /** 实际事件名（emit 时填充）：通配订阅下与订阅 pattern 不同，消费方可据此区分 */
  eventType?: string;
}

export type EventHandler = (
  payload: unknown,
  meta: EventMeta,
) => void | Promise<void>;

export interface EventBus {
  /** 订阅；返回 off 函数 */
  on(type: string, handler: EventHandler): () => void;
  once(type: string, handler: EventHandler): () => void;
  off(type: string, handler: EventHandler): void;
  /** 发布；同一事件内监听器按注册顺序串行等待（保证确定性） */
  emit(type: string, payload?: unknown, meta?: Partial<EventMeta>): Promise<void>;
}

/** 事件名收敛表：宿主定义的事件契约，插件按名称对接（payload 类型见各自消费点） */
export const PluginEvents = {
  /** 插件状态变更：payload { id: string; state: PluginState; prev: PluginState } */
  StateChanged: 'plugin:state-changed',
  /** 插件激活完成：payload { id: string } */
  Activated: 'plugin:activated',
  /** 插件停用完成：payload { id: string; reason?: string } */
  Deactivated: 'plugin:deactivated',
} as const;

/** 一组订阅记录：key = 精确 type 或通配 pattern（尾部 *）；Set 保注册序 */
interface Subscription {
  /** 调用方原始 handler（off 按此匹配） */
  handler: EventHandler;
  /** once 语义包装后的实际执行体 */
  wrapped: EventHandler;
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<Subscription>>();

  function isPattern(type: string): boolean {
    return type.length > 0 && type.endsWith('*');
  }

  function patternMatches(pattern: string, type: string): boolean {
    return type.startsWith(pattern.slice(0, -1));
  }

  function remove(key: string, sub: Subscription): void {
    const set = listeners.get(key);
    set?.delete(sub);
    if (set && set.size === 0) listeners.delete(key);
  }

  function subscribe(type: string, handler: EventHandler, onceOnly: boolean): () => void {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    const sub: Subscription = { handler, wrapped: handler };
    sub.wrapped = (payload, meta) => {
      if (onceOnly) remove(type, sub);
      return handler(payload, meta);
    };
    set.add(sub);
    return () => remove(type, sub);
  }

  const bus: EventBus = {
    on(type, handler) {
      return subscribe(type, handler, false);
    },
    once(type, handler) {
      return subscribe(type, handler, true);
    },
    off(type, handler) {
      const set = listeners.get(type);
      if (!set) return;
      for (const sub of [...set]) {
        if (sub.handler === handler) set.delete(sub);
      }
      if (set.size === 0) listeners.delete(type);
    },
    async emit(type, payload, meta) {
      // 命中集合：精确 type 优先；随后按注册序收集前缀命中的通配 pattern
      const keys: string[] = [];
      if (listeners.has(type)) keys.push(type);
      for (const key of listeners.keys()) {
        if (key !== type && isPattern(key) && patternMatches(key, type)) keys.push(key);
      }
      if (keys.length === 0) return;
      const fullMeta: EventMeta = {
        sourcePlugin: meta?.sourcePlugin ?? 'host',
        origin: meta?.origin ?? 'host',
        serialized: meta?.serialized ?? false,
        eventType: type,
      };
      for (const key of keys) {
        const set = listeners.get(key);
        if (!set) continue;
        for (const sub of [...set]) {
          try {
            await sub.wrapped(payload, fullMeta);
          } catch (e) {
            // 总线是基础设施：单点异常不拖垮整链，落日志便于排查
            // eslint-disable-next-line no-console
            console.error(`[plugin:event] handler error on "${type}"`, e);
          }
        }
      }
    },
  };

  return bus;
}
