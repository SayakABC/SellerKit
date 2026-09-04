// src/core/plugin/contributions.ts
// 贡献点注册表：插件注册"扩展槽位"，宿主消费点（侧栏/⌘K/设置页…）只从这里取数据。
// 规则：贡献全局 id = <plugin>.<localId>；同 type+id 重复注册被拒绝（抛错），不允许静默覆盖。
// register() 返回注销函数；插件 deactivate 时宿主批量注销（资源随生命周期释放）。

import type {
  Contribution,
  ContributionType,
} from './types';

export interface ContributionRegistry {
  register<S = unknown>(contrib: Contribution<S>): () => void;
  get<S = unknown>(type: ContributionType, id: string): Contribution<S> | undefined;
  list<S = unknown>(type: ContributionType): Contribution<S>[];
  /** 按插件注销全部贡献（deactivate 时调用） */
  removeByPlugin(pluginId: string): void;
  /** 注册插件贡献数（调试/审计用） */
  count(pluginId?: string): number;
}

/** 由插件 id 与本地贡献 id 拼接全局唯一贡献 id */
export function contributionId(pluginId: string, localId: string): string {
  return `${pluginId}.${localId}`;
}

export function createContributionRegistry(): ContributionRegistry {
  const buckets = new Map<ContributionType, Contribution[]>();

  function bucket(type: ContributionType): Contribution[] {
    let list = buckets.get(type);
    if (!list) {
      list = [];
      buckets.set(type, list);
    }
    return list;
  }

  const registry: ContributionRegistry = {
    register<S>(contrib: Contribution<S>): () => void {
      const list = bucket(contrib.type);
      if (list.some((c) => c.id === contrib.id)) {
        throw new Error(
          `duplicate contribution "${contrib.id}" (type=${contrib.type}) from plugin "${contrib.plugin}"`,
        );
      }
      list.push(contrib as Contribution);
      return () => {
        const idx = list.findIndex((c) => c.id === contrib.id);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    get<S = unknown>(type: ContributionType, id: string): Contribution<S> | undefined {
      return bucket(type).find((c) => c.id === id) as Contribution<S> | undefined;
    },
    list<S = unknown>(type: ContributionType): Contribution<S>[] {
      return [...bucket(type)] as Contribution<S>[];
    },
    removeByPlugin(pluginId: string): void {
      for (const list of buckets.values()) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].plugin === pluginId) list.splice(i, 1);
        }
      }
    },
    count(pluginId?: string): number {
      let n = 0;
      for (const list of buckets.values()) {
        n += pluginId ? list.filter((c) => c.plugin === pluginId).length : list.length;
      }
      return n;
    },
  };

  return registry;
}
