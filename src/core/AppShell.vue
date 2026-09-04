<template>
  <div class="h-screen flex flex-col bg-[var(--wb-bg)] text-[var(--wb-text)] overflow-hidden">
    <!-- 一体化工作台顶栏：收起按钮 + 品牌 + 当前模块名 + 命令入口 + 窗口控制 -->
    <TitleBar
      :collapsed="collapsed"
      :module-name="activeMeta?.name"
      :back-label="backMeta?.name"
      @toggle="toggleCollapse"
      @open-palette="paletteOpen = true"
      @back="goBack"
    />

    <div class="flex-1 min-h-0 flex">
      <!-- 左侧侧边栏：可展开（图标+文字）/ 收起（仅图标+气泡），WorkBuddy 风格以背景色差区分区域 -->
      <nav
        :class="[
          'flex flex-col items-center bg-[var(--wb-surface)] flex-shrink-0 transition-[width] duration-200',
          collapsed ? 'w-12' : 'w-52',
        ]"
      >
        <!-- 品牌头部（收起时仅显示 logo，点击回到默认模块） -->
        <div
          :class="[
            'flex items-center gap-2.5 flex-shrink-0 overflow-hidden whitespace-nowrap w-full',
            collapsed ? 'justify-center h-14' : 'justify-start px-3 h-14',
          ]"
        >
          <button
            class="w-8 h-8 rounded-lg bg-[var(--wb-primary)] flex items-center justify-center text-[var(--wb-primary-contrast)] text-xs font-bold shadow-sm flex-shrink-0 hover:opacity-90 transition-opacity"
            :title="`SellerKit v${appVersion}`"
            @click="activate(sortedMetas[0]?.id)"
          >
            SK
          </button>
          <div v-if="!collapsed" class="min-w-0 leading-tight">
            <p class="text-[13px] font-semibold text-[var(--wb-text)] tracking-tight">SellerKit</p>
            <p class="text-[11px] text-[var(--wb-text-muted)] mt-0.5">v{{ appVersion }}</p>
          </div>
        </div>

        <!-- 分区标签（展开时显示） -->
        <div v-if="!collapsed" class="w-full px-4 mt-1 mb-1">
          <p class="text-[11px] font-medium text-[var(--wb-text-muted)]">工作区</p>
        </div>

        <!-- 模块导航 -->
        <div class="flex-1 w-full flex flex-col items-center gap-1">
          <div v-for="m in navMetas" :key="m.id" class="relative group w-full flex justify-center">
            <button
              @click="activate(m.id)"
              :class="[
                'flex items-center rounded-lg transition-colors',
                collapsed
                  ? 'w-9 h-9 justify-center'
                  : 'w-[calc(100%-1rem)] h-10 px-3 gap-3 justify-start',
                activeId === m.id
                  ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)]'
                  : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]',
              ]"
            >
              <span v-html="iconSvg(m.icon)"></span>
              <span v-if="!collapsed" class="text-sm truncate">{{ m.name }}</span>
            </button>
            <!-- 激活态左侧指示条（贴侧边栏左边缘） -->
            <span
              v-if="activeId === m.id"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--wb-primary)]"
            ></span>
            <!-- hover 名称气泡（收起时） -->
            <span
              v-if="collapsed"
              class="pointer-events-none absolute left-full ml-2 px-2 py-1 text-xs whitespace-nowrap rounded-md bg-[var(--wb-text)] text-[var(--wb-surface)] opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg"
            >
              {{ m.name }}
            </span>
          </div>
        </div>

        <!-- 底部：账户 / 设置入口 -->
        <div class="relative group flex-shrink-0 mt-2 mb-2 w-full flex justify-center">
          <button
            @click="toggleMenu"
            :class="[
              'flex items-center rounded-lg transition-colors text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]',
              collapsed
                ? 'w-9 h-9 justify-center'
                : 'w-[calc(100%-1rem)] h-10 px-3 gap-3 justify-start',
            ]"
          >
            <span v-html="accountIcon"></span>
            <span v-if="!collapsed" class="text-sm truncate">账户与设置</span>
          </button>
          <!-- hover 名称气泡（收起时） -->
          <span
            v-if="collapsed"
            class="pointer-events-none absolute left-full ml-2 px-2 py-1 text-xs whitespace-nowrap rounded-md bg-[var(--wb-text)] text-[var(--wb-surface)] opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg"
          >
            账户与设置
          </span>

          <!-- 弹出菜单（设置 / 外观 / 检查更新） -->
          <div
            v-if="menuOpen"
            class="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-xl py-2 z-50"
          >
            <button class="wb-menu-item" @click="openSettings()">
              <span v-html="settingsIcon"></span>
              <span>设置</span>
            </button>

            <!-- 外观：文字 + 右侧 Tab 切换 -->
            <div
              class="px-3 py-2 flex items-center justify-between rounded-lg transition-colors cursor-default"
              :class="hoveredAppearance ? 'bg-[var(--wb-hover)]' : ''"
              @mouseenter="hoveredAppearance = true"
              @mouseleave="hoveredAppearance = false"
            >
              <div class="flex items-center gap-2.5 text-sm text-[var(--wb-text)]">
                <span v-html="paletteIcon"></span>
                <span>外观</span>
              </div>
              <div class="flex rounded-lg overflow-hidden border border-[var(--wb-border)]">
                <button
                  v-for="opt in themeOptions"
                  :key="opt.value"
                  class="px-2.5 py-1 text-xs leading-4 transition-colors font-medium"
                  :class="
                    themeMode === opt.value
                      ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]'
                      : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-primary-soft)] hover:text-[var(--wb-primary)]'
                  "
                  @click="setTheme(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div class="my-2 border-t border-[var(--wb-border)]"></div>

            <button class="wb-menu-item" @click="checkUpdates">
              <span v-html="updateIcon"></span>
              <span>检查更新</span>
            </button>
          </div>
        </div>
      </nav>

      <!-- 工作区：模块内容直接铺满（工作台与工作区一体化） -->
      <main class="flex-1 min-w-0 relative">
        <component :is="activeView" v-if="activeView" class="h-full" />
        <div
          v-else
          class="absolute inset-0 flex items-center justify-center text-[var(--wb-text-muted)] text-sm"
        >
          加载中…
        </div>
      </main>
    </div>

    <!-- 点击遮罩：关闭账户菜单 -->
    <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false"></div>

    <SettingsModal
      v-if="settingsOpen"
      :modules="sortedMetas"
      :manager="pm"
      :initial-category="settingsInitial.category"
      :initial-tab="settingsInitial.tab"
      @close="settingsOpen = false"
    />
    <CommandPalette
      :open="paletteOpen"
      :modules="navMetas"
      :commands="activeCommands"
      :plugin-commands="pluginCommands"
      :active-module-id="activeId"
      @close="paletteOpen = false"
      @select-module="activate"
      @run-command="runCommand"
    />
    <ToastHost />
  </div>
</template>

<script setup lang="ts">
import { shallowRef, ref, computed, onMounted, onUnmounted } from 'vue';
import { createBuiltinPluginManager } from './plugin';
import TitleBar from './components/TitleBar.vue';
import ToastHost from './components/ToastHost.vue';
import CommandPalette from './components/CommandPalette.vue';
import SettingsModal from './components/SettingsModal.vue';
import { useModuleStorage } from './services/storage';
import { initTheme, useTheme } from './services/theme';
import { toast } from './services/toast';
import { ipc } from './services/ipc';
import type { ModuleCommand, ModuleMeta } from './types';

// 插件体系入口：从 registry 发现内建插件；贡献点注册表是侧栏 / 视图切换 / ⌘K 命令的单一数据源
const pm = createBuiltinPluginManager();
// 侧栏数据源：ref 承载（pm.sortedMetas 为 getter——启停插件后 refreshMetas() 重取即得最新列表）
const sortedMetas = ref<ModuleMeta[]>(pm.sortedMetas);
/** 重新从插件管理器拉取侧栏列表（插件停用/启用后调用，驱动侧栏/⌘K 即时更新） */
function refreshMetas() {
  sortedMetas.value = pm.sortedMetas;
}
// 导航入口列表：过滤 navHidden 模块（保留代码与跨模块跳转激活能力，仅不在侧边栏/⌘K 直接列出）
const navMetas = computed(() => sortedMetas.value.filter((m) => !m.navHidden));

const activeId = ref<string>('');
const activeView = shallowRef<any>(null);
const collapsed = ref(false);
const paletteOpen = ref(false);
const menuOpen = ref(false);
const hoveredAppearance = ref(false);
const settingsOpen = ref(false);const settingsInitial = ref<{ category?: string; tab?: string }>({});

const activeMeta = computed(() => sortedMetas.value.find((m) => m.id === activeId.value) || null);
/** 业务流来源模块（switch-module 跨模块跳转时记录），TitleBar 据此显示「返回」入口 */
const backId = ref<string>('');
const backMeta = computed(() => sortedMetas.value.find((m) => m.id === backId.value) || null);
const appVersion = ref('');
// ⌘K 命令数据源：当前活跃插件经贡献注册表暴露的命令（激活时由插件管理器填充）
const activeCommands = ref<ModuleCommand[]>([]);
// Phase 3：已激活外置插件（后台贡献型，无视图）的命令 → ⌘K「外置插件命令」区
const pluginCommands = ref<ModuleCommand[]>([]);
// onStateChange 退订函数（onUnmounted 清理）
let stopStateWatch: (() => void) | null = null;

/** 刷新外置插件命令区（外置插件激活/停用/卸载/扫描后调用） */
function refreshPluginCommands() {
  pluginCommands.value = pm.getPluginCommands();
}

/** Phase 3：扫描 <userData>/plugins 并激活 activationEvents 含 onStartup 的外置插件（失败只提示，不阻塞主流程） */
async function discoverAndStartExternalPlugins() {
  try {
    const found = await pm.discoverExternal();
    for (const e of found.errors) toast.error(`外置插件 ${e.id} 加载失败: ${e.error}`);
    const started = await pm.activateStartupPlugins();
    for (const e of started.errors) toast.error(`外置插件 ${e.id} 启动失败: ${e.error}`);
    refreshPluginCommands();
    if (started.activated.length > 0) {
      toast.success(`外置插件就绪：${started.activated.length} 个已激活`);
    }
  } catch (e) {
    toast.error(`外置插件扫描失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 外壳级持久化：记住上次活动模块与侧边栏状态（独立命名空间，不影响业务模块数据）
const shellStorage = useModuleStorage<{
  lastActiveModuleId?: string;
  collapsed?: boolean;
}>('app-shell');

// 插件启停状态：随宿主分发视图插件的"运行时按包启停"持久化（独立命名空间，与业务模块数据隔离）
const pluginStateStorage = useModuleStorage<{ disabled?: string[] }>('plugins');

const { mode: themeMode, setTheme } = useTheme();
const themeOptions = [
  { label: '浅色', value: 'light' as const },
  { label: '深色', value: 'dark' as const },
  { label: '跟随系统', value: 'system' as const },
];

/** 核心激活：执行模块切换（不处理返回标记，由上层调用方决定 back 语义）。
 * 停旧启新、懒加载、贡献注册、业务钩子均由插件管理器统一管理（生命周期状态机）。 */
async function activateCore(id: string) {
  if (!pm.has(id)) return;
  if (id === activeId.value && activeView.value) return;

  try {
    // 插件管理器内部先停用上一插件，再懒加载并激活目标插件
    const result = await pm.activate(id);

    activeView.value = result.view;
    activeId.value = id;
    // ⌘K 命令数据源与视图联动（来自命令贡献注册表）
    activeCommands.value = result.commands;

    // 持久化上次活动模块
    shellStorage.save({ lastActiveModuleId: id, collapsed: collapsed.value }).catch(() => {});
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** 用户主动导航（侧边栏 / ⌘K / logo / 恢复上次模块）：清除业务流返回标记 */
function activate(id: string) {
  backId.value = '';
  return activateCore(id);
}

/** 业务流跨模块跳转（switch-module 事件）：记住来源模块，TitleBar 提供一键返回 */
function activateFromSwitch(id: string) {
  if (id !== activeId.value && activeId.value) backId.value = activeId.value;
  return activateCore(id);
}

/** TitleBar「返回」/ ⌘[ ：回到业务流来源模块（回到其默认视图，如订单归类概览首页） */
function goBack() {
  if (!backId.value) return;
  const target = backId.value;
  backId.value = '';
  void activateCore(target);
}

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  shellStorage
    .save({ lastActiveModuleId: activeId.value, collapsed: collapsed.value })
    .catch(() => {});
}

function runCommand(cmd: ModuleCommand) {
  cmd.run();
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function openSettings(category?: string, tab?: string) {
  menuOpen.value = false;
  settingsInitial.value = { category, tab };
  settingsOpen.value = true;
}

/** 全局事件：模块内组件可触发"打开设置页并定位" */
function onOpenSettings(e: Event) {
  const detail = (e as CustomEvent<{ category?: string; tab?: string }>).detail;
  openSettings(detail?.category, detail?.tab);
}

/** 全局事件：模块内组件可触发"切换到另一个模块"（通用机制；当前各业务流已并入同模块 Tab，暂无调用方）。
 * 模块加载是异步的，事件先于目标模块挂载完成；带 action 时暂存到一次性窗口标记，
 * 由目标模块 onMounted 消费（避免丢失跳转意图）。detail 可携带 payload。 */
function onSwitchModule(e: Event) {
  const detail = (e as CustomEvent<{ moduleId?: string; action?: string; payload?: unknown }>).detail;
  if (!detail?.moduleId) return;
  menuOpen.value = false;
  if (detail.action) {
    (window as any).__switchModuleAction = { ...detail };
  }
  activateFromSwitch(detail.moduleId);
}

function checkUpdates() {
  menuOpen.value = false;
  toast.info('正在检查更新…');
  setTimeout(() => toast.success(`已是最新版本 (v${appVersion.value || '1.0.0'})`), 800);
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  } else if ((e.metaKey || e.ctrlKey) && e.key === '[') {
    // ⌘[ / Ctrl+[ ：返回业务流来源模块（Finder/Safari 习惯）
    e.preventDefault();
    goBack();
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('open-settings', onOpenSettings);
  window.addEventListener('switch-module', onSwitchModule);

  // 初始化主题（外观设置）
  await initTheme();

  // 获取应用版本号（品牌展示）
  try {
    const res = await ipc.getAppVersion();
    if (res.success && res.data) appVersion.value = res.data;
  } catch {
    /* 忽略：版本号获取失败时隐藏 */
  }

  // 先应用持久化插件停用集：停用插件的静态视图贡献移除后侧栏/⌘K 即时反映（幂等；首次 activate 前执行）
  try {
    const ps = await pluginStateStorage.load();
    if (ps?.disabled?.length) await pm.applyDisabled(ps.disabled);
  } catch {
    /* 忽略：应用失败时全部插件默认启用 */
  }
  refreshMetas();

  // 恢复上次活动模块与侧边栏状态（被停用插件不参与恢复，回退默认模块）
  let initialId = sortedMetas.value[0]?.id || '';
  try {
    const saved = await shellStorage.load();
    if (
      saved?.lastActiveModuleId &&
      pm.has(saved.lastActiveModuleId) &&
      pm.isEnabled(saved.lastActiveModuleId)
    ) {
      initialId = saved.lastActiveModuleId;
    }
    if (saved?.collapsed !== undefined) collapsed.value = saved.collapsed;
  } catch {
    /* 忽略读取失败，使用默认模块 */
  }
  await activate(initialId);

  // 订阅插件状态变更：
  //  - 插件停用/启用 → 刷新侧栏/⌘K 数据源并持久化停用集；当前视图插件被停用时回退第一个启用插件
  //  - 外置插件激活/停用 → 刷新 ⌘K「外置插件命令」区
  //  - 随后扫描独立插件目录并懒激活 onStartup 外置插件
  stopStateWatch = pm.onStateChange((id, state, prev) => {
    refreshPluginCommands();
    // 停用（state=disabled）或从停用恢复启用（disabled→installed→loaded 序列，prev=disabled 即触发）
    if (state === 'disabled' || prev === 'disabled') {
      refreshMetas();
      // 业务流返回标记指向被停用插件时清空，避免 TitleBar 残留无效返回入口
      if (backId.value === id) backId.value = '';
      pluginStateStorage.save({ disabled: pm.getDisabledIds() }).catch(() => {});
    }
    if (prev === 'active' && state === 'disabled' && id === activeId.value) {
      const fallback = sortedMetas.value[0];
      if (fallback && fallback.id !== id) {
        activateCore(fallback.id).catch((e) => {
          toast.error(`插件已停用：${e instanceof Error ? e.message : String(e)}`);
          activeView.value = null;
          activeId.value = '';
        });
      } else {
        activeView.value = null;
        activeId.value = '';
      }
    }
  });
  void discoverAndStartExternalPlugins();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('open-settings', onOpenSettings);
  window.removeEventListener('switch-module', onSwitchModule);
  stopStateWatch?.();
});

function iconSvg(icon?: string): string {
  const map: Record<string, string> = {
    table:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></svg>',
    tool:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 7a3 3 0 10-4 4l-6 6 2 2 6-6a3 3 0 004-4l-2 2-2-2 2-2z"/></svg>',
    box:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v6c0 4-3 7-8 8-5-1-8-4-8-8V7z"/></svg>',
    chart:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    sparkles:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
    note:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h11l4 4v12H5z"/><path d="M15 4v5h5M9 13h6M9 17h6"/></svg>',
  };
  return map[icon || ''] || map.box;
}

const accountIcon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 11a3 3 0 100-6 3 3 0 000 6zM6.5 19a5.5 5.5 0 0111 0"/></svg>';
const settingsIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const paletteIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3a9 9 0 100 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 004-4c0-4.4-4-7.7-9-7.7z"/><circle cx="7.5" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/></svg>';
const updateIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 4v4h-4"/></svg>';
</script>
