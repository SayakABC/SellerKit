<template>
  <div class="flex-1 min-h-0 flex flex-col rounded-xl border border-[var(--wb-border)] overflow-hidden bg-[var(--wb-surface)]">
    <!-- 页签行 -->
    <div class="flex items-center gap-1 px-4 pt-2 border-b border-[var(--wb-border)]">
      <button
        class="px-3 py-1.5 text-xs rounded-t-md font-medium transition-colors"
        :class="
          tab === 'installed'
            ? 'bg-[var(--wb-surface-2)] text-[var(--wb-text)] border border-b-0 border-[var(--wb-border)]'
            : 'text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]'
        "
        @click="switchTab('installed')"
      >
        已安装插件
      </button>
      <button
        class="px-3 py-1.5 text-xs rounded-t-md font-medium transition-colors"
        :class="
          tab === 'market'
            ? 'bg-[var(--wb-surface-2)] text-[var(--wb-text)] border border-b-0 border-[var(--wb-border)]'
            : 'text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]'
        "
        @click="switchTab('market')"
      >
        插件市场
      </button>
    </div>

    <!-- ========== 已安装插件 ========== -->
    <template v-if="tab === 'installed'">
      <!-- 工具行 -->
      <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--wb-border)] flex-wrap">
        <span class="text-xs text-[var(--wb-text-muted)]">
          外置插件目录：
          <span class="font-mono">{{ pluginDir || FALLBACK_DIR }}</span>
        </span>
        <div class="ml-auto flex items-center gap-2">
          <button class="sk-btn" :disabled="scanning" @click="rescan">重新扫描</button>
          <button class="sk-btn" @click="openDir">打开目录</button>
        </div>
      </div>

      <!-- 插件列表 -->
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        <div
          v-for="p in rows"
          :key="p.id"
          class="flex items-start gap-3 rounded-lg border border-[var(--wb-border)] px-3 py-2.5"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium text-[var(--wb-text)]">{{ p.name }}</span>
              <span class="text-[11px] font-mono text-[var(--wb-text-muted)]">{{ p.id }}@{{ p.version }}</span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded font-mono"
                :class="badgeFor(p).cls"
                :title="badgeFor(p).tip"
              >
                {{ badgeFor(p).label }}
              </span>
              <span
                v-if="p.source === 'external' && p.kind !== 'ui'"
                class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]"
                title="Worker 沙箱：插件代码在独立 Worker 中执行（与宿主不共享运行环境，无法直达 window.electronAPI/DOM/localStorage）；能力调用经主线程权限门逐次判定"
              >
                Worker 沙箱
              </span>
              <span
                v-else-if="p.source === 'external' && p.kind === 'ui'"
                class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]"
                title="iframe 运行时岛：静态站点在宿主 iframe（sk-plugin:// 特权只读协议）独立 JS realm 执行；postMessage 桥 + 一次性 token 握手，能力经同一权限门逐次判定"
              >
                iframe 岛
              </span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded"
                :class="
                  p.state === 'active'
                    ? 'bg-[color-mix(in_srgb,var(--wb-success)_15%,transparent)] text-[var(--wb-success)]'
                    : 'bg-[var(--wb-hover)] text-[var(--wb-text-muted)]'
                "
              >
                {{ rowStateLabel(p) }}
              </span>
            </div>
            <p v-if="p.description" class="text-xs text-[var(--wb-text-muted)] mt-1 truncate">{{ p.description }}</p>
            <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span class="text-[10px] text-[var(--wb-text-muted)]">能力：</span>
              <template v-if="p.capabilities.length">
                <span
                  v-for="c in p.capabilities"
                  :key="c"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--wb-hover)] text-[var(--wb-text-muted)] font-mono"
                >
                  {{ c }}
                </span>
              </template>
              <span v-else class="text-[10px] text-[var(--wb-text-muted)]">
                {{ p.source === 'external' ? '未声明（所有受限能力被拒）' : 'Level 0（内建可信）' }}
              </span>
            </div>
          </div>
          <!-- 内建（含随宿主分发视图插件）：运行时按包启停（侧栏/⌘K/设置分类即时增减） -->
          <div v-if="p.source === 'builtin'" class="flex-shrink-0 flex items-center gap-2">
            <button
              class="sk-btn"
              :class="{ primary: p.state === 'disabled' }"
              :disabled="busyId === p.id"
              @click="togglePlugin(p)"
            >
              {{ busyId === p.id ? '…' : p.state === 'disabled' ? '启用' : '停用' }}
            </button>
          </div>
          <!-- 外置 UI 岛（kind:'ui'）：视图入口在侧栏激活；此处提供启停/卸载（停用后侧栏/⌘K 即时消失） -->
          <div v-if="p.source === 'external' && p.kind === 'ui'" class="flex-shrink-0 flex items-center gap-2">
            <button
              class="sk-btn"
              :class="{ primary: p.state === 'disabled' }"
              :disabled="busyId === p.id"
              @click="togglePlugin(p)"
            >
              {{ busyId === p.id ? '…' : p.state === 'disabled' ? '启用' : '停用' }}
            </button>
            <button class="sk-btn danger" :class="{ confirm: confirmId === p.id }" @click="uninstall(p.id)">
              {{ confirmId === p.id ? '确认卸载?' : '卸载' }}
            </button>
          </div>
          <!-- 外置 L2（Worker 沙箱后台贡献型）：激活/卸载 -->
          <div v-if="p.source === 'external' && p.kind !== 'ui'" class="flex-shrink-0 flex items-center gap-2">
            <button class="sk-btn primary" :disabled="p.state === 'active' || busyId === p.id" @click="activate(p.id)">
              {{ p.state === 'active' ? '运行中' : '激活' }}
            </button>
            <button class="sk-btn danger" :class="{ confirm: confirmId === p.id }" @click="uninstall(p.id)">
              {{ confirmId === p.id ? '确认卸载?' : '卸载' }}
            </button>
          </div>
        </div>
        <p v-if="!rows.length" class="text-xs text-[var(--wb-text-muted)] py-6 text-center">
          暂无插件。把插件目录放入
          <span class="font-mono">{{ pluginDir || FALLBACK_DIR }}</span>
          后点击「重新扫描」，或去「插件市场」一键安装。
        </p>
      </div>

      <!-- 权限审计（最近被拒绝） -->
      <div class="border-t border-[var(--wb-border)] px-4 py-2.5 max-h-36 overflow-y-auto">
        <p class="text-[11px] font-medium text-[var(--wb-text-muted)] mb-1.5">权限审计 · 最近被拒绝的调用</p>
        <ul v-if="denied.length" class="space-y-1">
          <li v-for="(d, i) in denied" :key="i" class="text-[11px] leading-snug text-[var(--wb-text-muted)]">
            <span class="font-mono text-[var(--wb-danger)]">{{ d.pluginId }}</span>
            <span class="font-mono">
              {{ d.req.capability }}{{ d.req.namespace ? '.' + d.req.namespace : '' }}
            </span>
            — {{ d.reason }}
          </li>
        </ul>
        <p v-else class="text-[11px] text-[var(--wb-text-muted)]">暂无越权记录。</p>
      </div>
    </template>

    <!-- ========== 插件市场 ========== -->
    <template v-else>
      <!-- 市场源地址 + 刷新 -->
      <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--wb-border)] flex-wrap">
        <span class="text-xs text-[var(--wb-text-muted)]">市场地址：</span>
        <input
          v-model="marketUrl"
          class="min-w-0 flex-1 sk-input text-xs font-mono"
          placeholder="https://…/catalog.json（默认官方市场）"
          spellcheck="false"
          @keydown.enter="loadMarket"
        />
        <button class="sk-btn" :disabled="loadingMarket" @click="loadMarket">
          {{ loadingMarket ? '加载中…' : '刷新' }}
        </button>
        <button
          class="sk-btn"
          title="在文件管理器中打开外置插件目录（本地安装位置）"
          @click="openDir"
        >
          打开插件目录
        </button>
      </div>

      <!-- 市场列表 -->
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        <p v-if="marketErr" class="text-xs text-[var(--wb-danger)] py-4 text-center">{{ marketErr }}</p>
        <p
          v-else-if="!loadingMarket && !marketRows.length"
          class="text-xs text-[var(--wb-text-muted)] py-6 text-center"
        >
          点击「刷新」拉取插件市场。市场地址默认指向官方仓库；也可填入自建/本地 catalog 地址
          （如 <span class="font-mono">http://127.0.0.1:8000/catalog.json</span>）。
        </p>
        <template v-else>
          <div
            v-for="p in marketRows"
            :key="p.id"
            class="flex items-start gap-3 rounded-lg border border-[var(--wb-border)] px-3 py-2.5"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-medium text-[var(--wb-text)]">{{ p.name }}</span>
                <span class="text-[11px] font-mono text-[var(--wb-text-muted)]">{{ p.id }}@{{ p.version }}</span>
                <span
                  v-if="p.kind === 'ui'"
                  class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[color-mix(in_srgb,var(--wb-warning)_15%,transparent)] text-[var(--wb-warning)]"
                  title="UI 形态包：静态站点经 iframe 运行时岛加载（安装后侧栏入口即就绪，可启停/卸载）"
                >
                  UI 岛
                </span>
                <span
                  v-if="marketStatus(p).installed"
                  class="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  :class="
                    marketStatus(p).updateable
                      ? 'bg-[color-mix(in_srgb,var(--wb-warning)_15%,transparent)] text-[var(--wb-warning)]'
                      : 'bg-[color-mix(in_srgb,var(--wb-success)_15%,transparent)] text-[var(--wb-success)]'
                  "
                >
                  {{ marketStatus(p).updateable ? `本地 v${marketStatus(p).localVersion}，可更新` : '已安装' }}
                </span>
              </div>
              <p v-if="p.description" class="text-xs text-[var(--wb-text-muted)] mt-1">{{ p.description }}</p>
              <p class="text-[11px] text-[var(--wb-text-muted)] mt-1.5">
                作者：{{ p.author || '未知' }}
                <span v-if="p.homepage" class="ml-2">
                  <a
                    class="underline decoration-dotted hover:text-[var(--wb-primary)]"
                    :href="p.homepage"
                    target="_blank"
                    rel="noopener noreferrer"
                    @click.stop
                  >
                    主页 ↗
                  </a>
                </span>
                <span class="ml-2 font-mono">sha256: {{ p.sha256.slice(0, 10) }}…</span>
              </p>
            </div>
            <div class="flex-shrink-0 flex items-center gap-2">
              <button
                class="sk-btn primary"
                :disabled="installingId === p.id || (marketStatus(p).installed && !marketStatus(p).updateable)"
                @click="doInstall(p)"
              >
                {{
                  installingId === p.id
                    ? '安装中…'
                    : marketStatus(p).updateable
                      ? `更新到 v${p.version}`
                      : marketStatus(p).installed
                        ? '已安装'
                        : '安装'
                }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { toast } from '../services/toast';
import type { BuiltinPluginManager, PluginOverview } from '../plugin';
import type { AuditEntry } from '../plugin/security';
import type { MarketPluginInfo } from '../plugin/types';
import {
  fetchMarketCatalog,
  installMarketPlugin,
  getMarketUrl,
  setMarketUrl,
  compareVersions,
} from '../plugin/marketClient';

const props = defineProps<{ manager: BuiltinPluginManager }>();

const FALLBACK_DIR = '~/Library/Application Support/seller-kit/plugins';

const tab = ref<'installed' | 'market'>('installed');
const rows = ref<PluginOverview[]>([]);
const denied = ref<AuditEntry[]>([]);
const busyId = ref('');
const confirmId = ref('');
const scanning = ref(false);
const pluginDir = ref('');

// ---- 市场状态 ----
const marketUrl = ref(getMarketUrl());
const marketRows = ref<MarketPluginInfo[]>([]);
const loadingMarket = ref(false);
const marketErr = ref('');
const installingId = ref('');
let marketLoadedOnce = false;

function switchTab(t: 'installed' | 'market') {
  tab.value = t;
  if (t === 'market' && !marketLoadedOnce) {
    marketLoadedOnce = true;
    void loadMarket();
  }
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    installed: '已发现',
    loaded: '待激活',
    activating: '激活中',
    active: '运行中',
    deactivating: '停用中',
    inactive: '已停用',
    disabled: '已停用(自)',
    error: '错误',
  };
  return map[state] ?? state;
}

/** 行级状态文案：UI 岛无真实状态机（pm 合成 loaded/disabled），展示"已注册 / 已停用(自)" */
function rowStateLabel(p: PluginOverview): string {
  if (p.kind === 'ui') return p.state === 'disabled' ? '已停用(自)' : '已注册';
  return stateLabel(p.state);
}

/**
 * 来源徽标：外置 UI 岛(iframe 运行时岛) / 外置 L2(Worker 沙箱) / 随宿主分发插件包(extensions/，L0) / 纯宿主模块(src/modules，L0)
 */
function badgeFor(p: PluginOverview): { label: string; cls: string; tip: string } {
  if (p.source === 'external') {
    if (p.kind === 'ui') {
      return {
        label: '外置 · 视图',
        cls: 'bg-[color-mix(in_srgb,var(--wb-warning)_16%,transparent)] text-[var(--wb-warning)]',
        tip: '外置富 UI 插件（UI 形态包）：静态站点在宿主 iframe 运行时岛内以独立 JS realm 执行（sk-plugin:// 特权只读协议 + postMessage 桥 + 一次性 token 握手），能力经同一权限门逐次判定；视图代码按"与宿主同 realm 等效"审视，安装前请确认来源与 manifest 能力声明',
      };
    }
    return {
      label: '外置 · L2',
      cls: 'bg-[var(--wb-accent-soft)] text-[var(--wb-accent)]',
      tip: '外置插件：位于 <userData>/plugins，Worker 沙箱执行，能力经主进程权限门逐次判定',
    };
  }
  if (p.kind === 'extension') {
    return {
      label: '扩展包 · L0',
      cls: 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)]',
      tip: '随宿主分发视图插件（extensions/<id>）：随宿主编译分发，运行时可按包启停/卸载',
    };
  }
  return {
    label: '内建 · L0',
    cls: 'bg-[var(--wb-hover)] text-[var(--wb-text-muted)]',
    tip: '宿主内建模块（src/modules）：随宿主分发，可按包启停',
  };
}

function refresh() {
  rows.value = props.manager.overview();
  denied.value = props.manager.auditDenied();
}

/** 市场条目 vs 本地已装（仅对照外置目录）：{ installed, localVersion, updateable } */
function marketStatus(p: MarketPluginInfo): { installed: boolean; localVersion: string; updateable: boolean } {
  const local = rows.value.find((r) => r.source === 'external' && r.id === p.id);
  if (!local) return { installed: false, localVersion: '', updateable: false };
  const cmp = compareVersions(local.version, p.version);
  return {
    installed: true,
    localVersion: local.version,
    updateable: cmp < 0,
  };
}

/** 拉取市场 catalog 并落本地状态 */
async function loadMarket() {
  loadingMarket.value = true;
  marketErr.value = '';
  try {
    const url = marketUrl.value.trim() || getMarketUrl();
    setMarketUrl(url);
    const list = await fetchMarketCatalog(url);
    marketRows.value = list;
    if (!list.length) marketErr.value = '市场为空：catalog 中没有任何插件';
  } catch (e) {
    marketRows.value = [];
    marketErr.value = `拉取失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loadingMarket.value = false;
  }
}

/** 安装/更新：落盘成功后重新扫描（新插件需手动激活，与本地一致的安全语义；UI 岛装完侧栏入口即就绪） */
async function doInstall(p: MarketPluginInfo) {
  installingId.value = p.id;
  try {
    await installMarketPlugin(p);
    await props.manager.discoverExternal();
    refresh();
    const isUi = props.manager.isUiIsland(p.id);
    toast.success(
      isUi
        ? `插件 ${p.id} v${p.version} 已安装（UI 形态包：侧栏入口已就绪，能力清单见「已安装插件」行）`
        : `插件 ${p.id} v${p.version} 已安装，可在「已安装插件」中激活`,
    );
  } catch (e) {
    toast.error(`安装失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    installingId.value = '';
  }
}

/** 重新扫描插件目录：真实目录经 IPC 发现，扫描失败不阻塞列表刷新 */
async function rescan() {
  scanning.value = true;
  try {
    const found = await props.manager.discoverExternal();
    if (found.root) pluginDir.value = found.root;
    if (found.errors.length) {
      toast.error(`外置插件扫描完成，${found.errors.length} 个异常：${found.errors.map((e) => `${e.id}: ${e.error}`).join('；')}`);
    } else {
      toast.success(`外置插件扫描完成，发现 ${found.total} 个`);
    }
  } catch (e) {
    toast.error(`重新扫描失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    scanning.value = false;
    refresh();
  }
}

/** 停用/启用内建插件与 UI 岛（运行时按包启停：侧栏/⌘K/设置分类经 AppShell onStateChange 即时刷新并持久化；正显示的岛被停用时宿主自动回落） */
async function togglePlugin(p: PluginOverview) {
  const enable = p.state === 'disabled';
  busyId.value = p.id;
  try {
    await props.manager.setPluginEnabled(p.id, enable);
    toast.success(enable ? `插件 ${p.id} 已启用` : `插件 ${p.id} 已停用`);
  } catch (e) {
    toast.error(`操作失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busyId.value = '';
    refresh();
  }
}

async function activate(id: string) {
  busyId.value = id;
  try {
    await props.manager.activateExternal(id);
    toast.success(`外置插件 ${id} 已激活`);
  } catch (e) {
    toast.error(`激活失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busyId.value = '';
    refresh();
  }
}

async function uninstall(id: string) {
  if (confirmId.value !== id) {
    confirmId.value = id;
    setTimeout(() => {
      if (confirmId.value === id) confirmId.value = '';
    }, 4000);
    return;
  }
  confirmId.value = '';
  busyId.value = id;
  try {
    await props.manager.uninstallExternal(id);
    toast.success(`外置插件 ${id} 已卸载`);
  } catch (e) {
    toast.error(`卸载失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busyId.value = '';
    refresh();
  }
}

async function openDir() {
  try {
    const dir = await props.manager.openPluginsDir();
    if (dir) pluginDir.value = dir;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** 挂载即静默同步一次目录状态（与 AppShell 启动扫描幂等，主要取真实目录路径） */
async function init() {
  try {
    const found = await props.manager.discoverExternal();
    if (found.root) pluginDir.value = found.root;
  } catch {
    // 忽略：仅目录展示，失败回退 FALLBACK_DIR
  }
  refresh();
}

void init();
</script>

<style scoped>
.sk-input {
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--wb-surface-2);
  color: var(--wb-text);
  outline: none;
}
.sk-input:focus {
  border-color: var(--wb-primary);
}
.sk-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  border-radius: 6px;
  border: 1px solid var(--wb-border);
  color: var(--wb-text);
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s, opacity 0.15s;
}
.sk-btn:hover:not(:disabled) {
  background: var(--wb-hover);
}
.sk-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sk-btn.primary {
  background: var(--wb-primary);
  border-color: transparent;
  color: var(--wb-primary-contrast);
}
.sk-btn.primary:hover:not(:disabled) {
  background: var(--wb-primary-hover);
}
.sk-btn.danger {
  border-color: color-mix(in srgb, var(--wb-danger) 45%, transparent);
  color: var(--wb-danger);
}
.sk-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--wb-danger) 10%, transparent);
}
.sk-btn.danger.confirm {
  background: var(--wb-danger);
  border-color: transparent;
  color: var(--wb-primary-contrast);
}
</style>
