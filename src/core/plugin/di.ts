// src/core/plugin/di.ts
// 轻量依赖注入容器（Phase 1 自研，无第三方运行时依赖）。
// 用途：注册插件系统级服务（事件总线/贡献点注册表等），供插件上下文与宿主按 token 取用；
// 插件只经接口端口访问，不直接持有实现类（便于替换/mock）。

export type Token<T = unknown> = symbol | string | (abstract new (...args: any[]) => T);

export interface ServiceDefinition<T = unknown> {
  token: Token<T>;
  useValue?: T;
  useFactory?: (c: Container) => T;
  useClass?: new (...args: any[]) => T;
}

export interface Container {
  register<T>(def: ServiceDefinition<T>): void;
  /** 解析服务；循环依赖/未注册时抛错（调用方负责捕获与 toast） */
  resolve<T>(token: Token<T>): T;
  has(token: Token<unknown>): boolean;
  dispose(): void;
}

export function createContainer(): Container {
  const registry = new Map<Token<unknown>, ServiceDefinition<unknown>>();
  const instances = new Map<Token<unknown>, unknown>();
  const resolving: Token<unknown>[] = [];

  function instantiate<T>(def: ServiceDefinition<T>): T {
    if (def.useValue !== undefined) return def.useValue;
    if (def.useFactory) return def.useFactory(api);
    if (def.useClass) return new def.useClass();
    throw new Error(`service definition for "${String(def.token)}" has no provider`);
  }

  const api: Container = {
    register<T>(def: ServiceDefinition<T>): void {
      if (registry.has(def.token)) {
        throw new Error(`duplicate service token: ${String(def.token)}`);
      }
      registry.set(def.token, def);
    },
    resolve<T>(token: Token<T>): T {
      if (resolving.includes(token)) {
        throw new Error(`circular dependency detected: ${[...resolving, token].map(String).join(' -> ')}`);
      }
      if (instances.has(token)) return instances.get(token) as T;
      const def = registry.get(token);
      if (!def) throw new Error(`service not registered: ${String(token)}`);
      resolving.push(token);
      try {
        const value = instantiate(def as ServiceDefinition<T>);
        instances.set(token, value);
        return value;
      } finally {
        resolving.pop();
      }
    },
    has(token: Token<unknown>): boolean {
      return registry.has(token);
    },
    dispose(): void {
      registry.clear();
      instances.clear();
    },
  };

  return api;
}
