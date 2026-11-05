<template>
  <div
    class="flex-1 min-h-0 flex flex-col rounded-xl border border-[var(--wb-border)] overflow-hidden bg-[var(--wb-surface)]"
  >
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
          <button class="wb-btn wb-btn--sm sk-btn" :disabled="scanning" @click="rescan">
            重新扫描
          </button>
          <button class="wb-btn wb-btn--sm sk-btn" @click="openDir">打开目录</button>
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
              <span class="text-[11px] font-mono text-[var(--wb-text-muted)]"
                >{{ p.id }}@{{ p.version }}</span
              >
              <span
                class="text-[10px] px-1.5 py-0.5 rounded font-mono"
                :class="badgeFor(p).cls"
                :title="badgeFor(p).tip"
              >
                {{ badgeFor(p).label }}
              </span>
              <span
                v-if="p.source === 'external'"
                class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]"
                :title="badgeFor(p).tip"
              >
                独立运行
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
            <p v-if="p.description" class="text-xs text-[var(--wb-text-muted)] mt-1 truncate">
              {{ p.description }}
            </p>
            <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span class="text-[10px] text-[var(--wb-text-muted)]">能力：</span>
              <template v-if="p.capabilities.length">
                <span
                  v-for="c in p.capabilities"
                  :key="c"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--wb-hover)] text-[var(--wb-text-muted)]"
                  :title="capabilityLabel(c).tip"
                >
                  {{ capabilityLabel(c).label }}
                </span>
              </template>
              <span v-else class="text-[10px] text-[var(--wb-text-muted)]">
                {{
                  p.source === 'external'
                    ? '未声明任何能力（需要数据的功能会被拒绝）'
                    : '随应用附带，无需单独授权'
                }}
              </span>
            </div>
            <!--
              能力明细（H-02 配套）：只显示 `db` 这样的能力 id 时，"同意"是不可判断的 ——
              同一个 `db` 既可能只是"读自己的数据"，也可能是"读写你磁盘上的任意文件"。
              这里展开域 / 动作 / 命名空间 / 地址白名单，让权限范围可见（仅展示，不参与判定）。
            -->
            <ul v-if="p.capabilityDetails?.length" class="mt-1 space-y-0.5">
              <li
                v-for="d in p.capabilityDetails"
                :key="d"
                class="text-[10px] text-[var(--wb-text-muted)] font-mono leading-4 break-all"
              >
                {{ d }}
              </li>
            </ul>
          </div>
          <!-- 内建（含随宿主分发视图插件）：运行时按包启停（侧栏/⌘K/设置分类即时增减） -->
          <div v-if="p.source === 'builtin'" class="flex-shrink-0 flex items-center gap-2">
            <button
              class="wb-btn wb-btn--sm sk-btn"
              :class="{ primary: p.state === 'disabled' }"
              :disabled="busyId === p.id"
              @click="togglePlugin(p)"
            >
              {{ busyId === p.id ? '…' : p.state === 'disabled' ? '启用' : '停用' }}
            </button>
          </div>
          <!-- 外置 UI 岛（kind:'ui'）：视图入口在侧栏激活；此处提供启停/卸载（停用后侧栏/⌘K 即时消失） -->
          <div
            v-if="p.source === 'external' && p.kind === 'ui'"
            class="flex-shrink-0 flex items-center gap-2"
          >
            <button
              class="wb-btn wb-btn--sm sk-btn"
              :class="{ primary: p.state === 'disabled' }"
              :disabled="busyId === p.id"
              @click="togglePlugin(p)"
            >
              {{ busyId === p.id ? '…' : p.state === 'disabled' ? '启用' : '停用' }}
            </button>
            <button
              class="wb-btn wb-btn--sm wb-btn--danger sk-btn danger"
              :class="{ confirm: confirmId === p.id }"
              @click="uninstall(p.id)"
            >
              {{ confirmId === p.id ? '确认卸载?' : '卸载' }}
            </button>
          </div>
          <!-- 外置 L2（Worker 沙箱后台贡献型）：激活/卸载 -->
          <div
            v-if="p.source === 'external' && p.kind !== 'ui'"
            class="flex-shrink-0 flex items-center gap-2"
          >
            <button
              class="wb-btn wb-btn--sm wb-btn--primary sk-btn primary"
              :disabled="p.state === 'active' || busyId === p.id"
              @click="activate(p.id)"
            >
              {{ p.state === 'active' ? '运行中' : '激活' }}
            </button>
            <button
              class="wb-btn wb-btn--sm wb-btn--danger sk-btn danger"
              :class="{ confirm: confirmId === p.id }"
              @click="uninstall(p.id)"
            >
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
        <p class="text-[11px] font-medium text-[var(--wb-text-muted)] mb-1.5">
          权限审计 · 最近被拒绝的调用
        </p>
        <ul v-if="denied.length" class="space-y-1">
          <li
            v-for="(d, i) in denied"
            :key="i"
            class="text-[11px] leading-snug text-[var(--wb-text-muted)]"
          >
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
          class="wb-input wb-input--sm min-w-0 flex-1 sk-input text-xs font-mono"
          placeholder="https://…/catalog.json（默认官方市场）"
          spellcheck="false"
          @keydown.enter="loadMarket"
        />
        <button class="wb-btn wb-btn--sm sk-btn" :disabled="loadingMarket" @click="loadMarket">
          {{ loadingMarket ? '加载中…' : '刷新' }}
        </button>
        <button
          class="wb-btn wb-btn--sm sk-btn"
          title="在文件管理器中打开外置插件目录（本地安装位置）"
          @click="openDir"
        >
          打开插件目录
        </button>
      </div>

      <!-- 市场列表 -->
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        <p v-if="marketErr" class="text-xs text-[var(--wb-danger)] py-4 text-center">
          {{ marketErr }}
        </p>
        <p
          v-else-if="!loadingMarket && !marketRows.length"
          class="text-xs text-[var(--wb-text-muted)] py-6 text-center"
        >
          点击「刷新」拉取插件市场。市场地址默认指向官方仓库；也可填入自建/本地 catalog 地址 （如
          <span class="font-mono">http://127.0.0.1:8000/catalog.json</span>）。
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
                <span class="text-[11px] font-mono text-[var(--wb-text-muted)]"
                  >{{ p.id }}@{{ p.version }}</span
                >
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
                  {{
                    marketStatus(p).updateable
                      ? `本地 v${marketStatus(p).localVersion}，可更新`
                      : '已安装'
                  }}
                </span>
              </div>
              <p v-if="p.description" class="text-xs text-[var(--wb-text-muted)] mt-1">
                {{ p.description }}
              </p>
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
                class="wb-btn wb-btn--sm wb-btn--primary sk-btn primary"
                :disabled="
                  installingId === p.id ||
                  (marketStatus(p).installed && !marketStatus(p).updateable)
                "
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
import { reloadIsland } from '../services/shell';
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
 * 请求外壳重载正在打开的 UI 岛（事件名与 `AppShell.vue` 的监听保持一致，同 `open-settings` / `switch-module` 的约定）。
 * 为什么用事件而不是直接调：本组件在设置弹层里，拿不到外壳的 `activeIslandId`；
 * 由外壳判断"是不是当前这个岛"，不是就静默忽略（装了个别的插件不该把用户正在看的页面刷掉）。
 */
function requestIslandReload(pluginId: string): void {
  reloadIsland(pluginId);
}

/**
 * 来源徽标（UX 审查 A5）：给用户看的只有两句话 —— **随应用附带** / **从市场安装**。
 * 内部分级（L0/L2）、进程与协议名（Worker / iframe / 桥 / token / 权限门）全部收进 tooltip：
 * 它们是"我们怎么实现的"，不是"你要不要装它"。验收判据：徽标里不出现 `L0` / `L2` / `外置 ·`。
 */
function badgeFor(p: PluginOverview): { label: string; cls: string; tip: string } {
  if (p.source === 'external') {
    return {
      label: '从市场安装',
      cls: 'bg-[color-mix(in_srgb,var(--wb-warning)_16%,transparent)] text-[var(--wb-warning)]',
      tip:
        p.kind === 'ui'
          ? '装到本机的插件（不在应用安装包内），可随时卸载。它以独立页面运行、只能通过宿主提供的接口访问数据，每次访问都要过权限检查；安装前请确认来源与它申请的能力。'
          : '装到本机的插件（不在应用安装包内），可随时卸载。它在独立的运行环境里执行、只能通过宿主提供的接口访问数据，每次访问都要过权限检查；安装前请确认来源与它申请的能力。',
    };
  }
  if (p.kind === 'extension') {
    return {
      label: '随应用附带',
      cls: 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)]',
      tip: '随应用安装包一起分发（视图插件包）：无需单独安装，可按包启停',
    };
  }
  return {
    label: '随应用附带',
    cls: 'bg-[var(--wb-hover)] text-[var(--wb-text-muted)]',
    tip: '应用自带的内置功能：无需单独安装，可按包启停',
  };
}

/**
 * 能力标签中文化（UX 审查 B2）：直接渲染 `db` / `storage` 这些 id，用户无法判断"同意什么"。
 * 人类语言在前、**原始能力名放 tooltip**（要深究的人仍看得到），明细行不再重复这些 id。
 */
const CAPABILITY_LABELS: Record<string, { label: string; tip: string }> = {
  db: { label: '读写业务数据', tip: '能力域 db：订单 / 产品 / 成本等业务表（每次调用逐项判定）' },
  storage: { label: '保存本插件设置', tip: '能力域 storage：只写本插件自己的配置，不碰别的插件' },
  clipboard: { label: '读写剪贴板', tip: '能力域 clipboard' },
  dialog: { label: '选择文件', tip: '能力域 dialog：只能弹系统的文件选择框，读不到任意路径' },
  secrets: { label: '保存密钥', tip: '能力域 secrets：加密存储（如识别用的 API Key）' },
  mail: { label: '读取邮件', tip: '能力域 mail：本地邮箱账户的收发' },
};

function capabilityLabel(c: string): { label: string; tip: string } {
  return (
    CAPABILITY_LABELS[c] ?? {
      label: c,
      tip: `未收录的能力名：${c}（新版宿主新增的能力，语义见插件说明）`,
    }
  );
}

function refresh() {
  rows.value = props.manager.overview();
  denied.value = props.manager.auditDenied();
}

/** 市场条目 vs 本地已装（仅对照外置目录）：{ installed, localVersion, updateable } */
function marketStatus(p: MarketPluginInfo): {
  installed: boolean;
  localVersion: string;
  updateable: boolean;
} {
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
    // 页面**已打开**时插件文件不会自动换新（iframe 文档在挂载时就加载好了）——
    // 旧文案写着"侧栏入口已就绪"，用户会以为界面也更新了，看到旧界面就判断成"没装成功"（UX 审查 A3）。
    // 派发 `reload-island`：外壳只在"这正是当前打开的那个岛"时重载它（不是就什么都不做）。
    requestIslandReload(p.id);
    toast.success(
      isUi
        ? `插件 ${p.id} v${p.version} 已安装 —— 正打开着的该插件页已自动重载，未打开则下次打开即新版`
        : `插件 ${p.id} v${p.version} 已安装，可在「已安装插件」中激活`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 同版本重复安装：主进程会拒绝（目录已是该版本），此处按「已是最新」处理而非报错
    if (msg.includes('无需重复安装')) {
      await props.manager.discoverExternal();
      refresh();
      toast.info(`插件 ${p.id} v${p.version} 已是最新版`);
      return;
    }
    toast.error(`安装失败：${msg}`);
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
      toast.error(
        `外置插件扫描完成，${found.errors.length} 个异常：${found.errors.map((e) => `${e.id}: ${e.error}`).join('；')}`
      );
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
/* 输入框 / 按钮的基座统一来自全局 .wb-input--sm 与 .wb-btn（见 src/styles/index.css）。
   本页原先自写一套 12px 字 / 6px 圆角 / 透明底的 .sk-btn/.sk-input，
   与宿主其它按钮(8px 圆角)不同源。这里只保留本页特有的"二次确认"配色。 */
.sk-input {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
}

/* 二次确认态：把"卸载"从描边红升级为实心红 —— 只有真的要点第二次时才刺眼 */
.wb-btn.sk-btn.confirm {
  background: var(--wb-danger);
  border-color: var(--wb-danger);
  color: var(--wb-on-accent);
}
</style>
