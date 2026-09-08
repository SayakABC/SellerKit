// src/core/plugin/marketClient.ts
// 插件市场（Market）渲染层客户端：拉取 catalog / 安装插件。
//  - catalog 是静态 JSON（{ plugins: [...] }），主进程已逐项净化；
//  - 安装 = 主进程下载 zip → sha256 → 解压校验 → 落盘 <userData>/plugins/<id>/，
//    之后调用方（PluginCenter）负责 discoverExternal + activate；
//  - 市场 URL 记忆在 localStorage（key: sk.market.url），默认指向官方市场仓库。

import { marketCatalogFetch, marketPluginInstall } from '@/core/services/ipc';
import type { MarketCatalog, MarketPluginInfo } from '@/core/plugin/types';

/** 默认官方市场（SayakABC/SellerKitPlugin，静态托管 catalog.json + 插件 zip） */
export const MARKET_DEFAULT_URL =
  'https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json';

const URL_KEY = 'sk.market.url';

export function getMarketUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || MARKET_DEFAULT_URL;
  } catch {
    return MARKET_DEFAULT_URL;
  }
}

export function setMarketUrl(url: string): void {
  try {
    if (url.trim()) localStorage.setItem(URL_KEY, url.trim());
    else localStorage.removeItem(URL_KEY);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 拉取并返回净化后的市场条目；失败抛错（由调用方 toast） */
export async function fetchMarketCatalog(url?: string): Promise<MarketPluginInfo[]> {
  const r = await marketCatalogFetch(url || getMarketUrl());
  if (!r.success || !r.data) throw new Error(r.error || '拉取市场目录失败');
  const catalog = r.data as MarketCatalog;
  return Array.isArray(catalog.plugins) ? catalog.plugins : [];
}

/** 安装/更新市场插件；成功返回 { id, version }，失败抛错 */
export async function installMarketPlugin(
  item: MarketPluginInfo,
  force = false,
): Promise<{ id: string; version: string }> {
  // 摊平成普通纯对象再走 IPC：Vue reactive Proxy 无法被 contextBridge 结构化克隆，
  // 直接传入会抛 DataCloneError（"An object could not be cloned."）
  const plain: MarketPluginInfo = {
    id: String(item?.id ?? ''),
    name: String(item?.name ?? ''),
    version: String(item?.version ?? ''),
    description: String(item?.description ?? ''),
    author: String(item?.author ?? ''),
    downloadUrl: String(item?.downloadUrl ?? ''),
    sha256: String(item?.sha256 ?? ''),
    homepage: String(item?.homepage ?? ''),
    ...(item?.kind === 'ui' || item?.kind === 'extension' ? { kind: item.kind } : {}),
  };
  const r = await marketPluginInstall(plain, force);
  if (!r.success || !r.data) throw new Error(r.error || '安装插件失败');
  return r.data;
}

/** 语义化版本比较（x.y.z）：a>b→1 / a==b→0 / a<b→-1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}
