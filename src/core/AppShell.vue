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

        <!-- 模块导航（一级项 + 分组子项；行序列见 script 里的 navRows） -->
        <div class="flex-1 w-full min-h-0 overflow-y-auto flex flex-col items-center gap-1">
          <template v-for="row in navRows" :key="row.key">
            <!-- 一级分组标题：可展开/收起；侧栏收起时不渲染（子项会平铺，见 navRows） -->
            <div
              v-if="row.kind === 'group'"
              class="relative group w-full flex justify-center flex-shrink-0"
            >
              <button
                type="button"
                @click="toggleGroup(row.id)"
                :aria-expanded="row.expanded ? 'true' : 'false'"
                :class="[
                  'flex items-center rounded-lg transition-colors w-[calc(100%-1rem)] h-10 px-3 gap-3 justify-start',
                  row.childActive
                    ? 'text-[var(--wb-primary)]'
                    : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]',
                ]"
              >
                <span v-html="iconSvg(row.icon)"></span>
                <span class="text-sm truncate flex-1 text-left font-medium">{{ row.name }}</span>
                <span
                  class="transition-transform duration-150"
                  :class="row.expanded ? 'rotate-90' : ''"
                  v-html="chevronIcon"
                ></span>
              </button>
            </div>

            <!--
              模块内二级项（2026-10-17）：缩进 + 名称 + 徽标。
              点它只切「这个模块里的哪一屏」—— 不换模块、不产生 TitleBar「返回」，
              所以直接调模块给的 onSelect，走不了 `activate()` 那条换模块的路。
            -->
            <div
              v-else-if="row.kind === 'sub'"
              class="w-full flex justify-center flex-shrink-0"
            >
              <button
                type="button"
                :data-act="row.act"
                :aria-current="row.active ? 'page' : undefined"
                @click="row.onSelect()"
                :class="[
                  'flex items-center rounded-lg transition-colors w-[calc(100%-1.5rem)] h-8 pl-7 pr-2 gap-2',
                  row.active
                    ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] font-medium'
                    : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]',
                ]"
              >
                <IconGlyph v-if="row.icon" :name="row.icon" :size="15" />
                <span class="text-[12.5px] truncate flex-1 text-left">{{ row.name }}</span>
                <!-- 徽标：读不到数就**不渲染**（不拿 0 冒充"没有"）；待办类 > 0 用警示色 -->
                <span
                  v-if="row.count !== undefined && row.count !== null"
                  :title="row.countTitle"
                  :class="[
                    'flex-shrink-0 min-w-[18px] px-1.5 rounded-full text-[10.5px] font-semibold text-center leading-[1.6]',
                    row.todo && row.count > 0
                      ? 'bg-[var(--wb-warning-soft)] text-[var(--wb-warning)]'
                      : row.active
                        ? 'bg-[var(--wb-surface)] text-[var(--wb-primary)]'
                        : 'bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]',
                  ]"
                  >{{ row.count }}</span
                >
              </button>
            </div>

            <!-- 模块项（分组子项带缩进；收起态只显示图标 + 气泡） -->
            <div v-else class="relative group w-full flex justify-center flex-shrink-0">
              <button
                :data-act="`nav-${row.id}`"
                :aria-expanded="row.hasSub ? (row.subExpanded ? 'true' : 'false') : undefined"
                @click="onModuleRow(row)"
                :class="[
                  'flex items-center rounded-lg transition-colors',
                  collapsed ? 'w-9 h-9 justify-center' : 'w-[calc(100%-1rem)] h-10 gap-3 justify-start',
                  !collapsed && row.depth > 0 ? 'pl-7 pr-3' : 'px-3',
                  activeId === row.id
                    ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)]'
                    : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]',
                ]"
              >
                <span v-html="iconSvg(row.icon)"></span>
                <span v-if="!collapsed" class="text-sm truncate flex-1 text-left">{{ row.name }}</span>
                <!--
                  有二级菜单的模块给一个展开箭头（2026-10-17）。
                  只在**模块还没打开过**时它才是唯一线索 —— 打开后子项直接出现，箭头就是状态位。
                  转 90° = 子项正展开；**判据只认 `row.subExpanded`**（前台 + 侧栏展开 + 没被手动收起），
                  不在模板里重新推一遍条件 —— 两处各推一遍，迟早一处忘了加"手动收起"。
                -->
                <span
                  v-if="row.hasSub && !collapsed"
                  class="flex-shrink-0 opacity-60 transition-transform duration-150"
                  :class="row.subExpanded ? 'rotate-90' : ''"
                  v-html="chevronIcon"
                ></span>
              </button>
              <!-- 激活态左侧指示条（贴侧边栏左边缘） -->
              <span
                v-if="activeId === row.id"
                class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--wb-primary)]"
              ></span>
              <!-- hover 名称气泡（收起时） -->
              <span
                v-if="collapsed"
                class="pointer-events-none absolute left-full ml-2 px-2 py-1 text-xs whitespace-nowrap rounded-md bg-[var(--wb-text)] text-[var(--wb-surface)] opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg"
              >
                {{ row.name }}
              </span>
            </div>
          </template>
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

            <!--
              「插件中心」直达（UX 审查 A2）：业务功能全是插件，安装/更新/卸载却埋在
              设置 › 插件 › 市场 三层里 —— 给一个两级内可达的快捷入口（仍复用设置里的同一个组件）。
            -->
            <button class="wb-menu-item" data-act="menu-plugins" @click="openSettings('plugins')">
              <span v-html="pluginIcon"></span>
              <span>插件中心</span>
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
        <!-- §15 UI 岛（外置富 UI 插件）：宿主双通道渲染——activeIslandId 非空时替代 activeView。
             `:key` 是**必须**的（2026-09-24 修「重启后点导航一片空白」）：
             Vue 对同一位置的同类型组件做**复用**，没有 key 时切岛只改 prop、组件实例不重建，
             于是 UiIslandView 里已建的桥（绑定旧岛 origin/token）被沿用 → 新岛握手消息被静默丢弃
             （postMessage 的 targetOrigin 不匹配是**静默**失败，不抛错、不打印）→ 新岛永久停在
             「等待桥握手」，表现为点任意非首个岛都是空白页。加 key 强制按岛重建，桥随组件重建。 -->
        <UiIslandView
          v-else-if="activeIslandId"
          ref="islandRef"
          :key="activeIslandId"
          :plugin-id="activeIslandId"
          :manager="pm"
          class="h-full"
          @back="backFromIsland"
          @ping="islandHostPing"
        />
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
    <div
      v-if="updPhase !== 'idle'"
      class="fixed bottom-20 right-4 z-[55] w-72 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-lg p-3.5 text-sm"
    >
      <!-- 下载中：进度条 -->
      <div v-if="updPhase === 'downloading'">
        <div class="flex items-center justify-between text-[13px]">
          <span class="font-medium text-[var(--wb-text)]"
            >正在下载{{ updVersion ? ` v${updVersion}` : '更新' }}</span
          >
          <span class="text-[var(--wb-text-muted)] tabular-nums"
            >{{ Math.round(updPercent) }}%</span
          >
        </div>
        <div class="mt-2 h-1.5 rounded-full bg-[var(--wb-surface-2)] overflow-hidden">
          <div
            class="h-full rounded-full bg-[var(--wb-primary)] transition-all duration-300"
            :style="{ width: Math.min(updPercent, 100) + '%' }"
          ></div>
        </div>
      </div>

      <!-- 下载完成：重启安装 -->
      <div v-else-if="updPhase === 'downloaded'" class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium text-[var(--wb-text)]">更新已就绪</p>
          <p class="text-xs text-[var(--wb-text-muted)] mt-0.5">
            v{{ updVersion || '' }} 下载完成，重启后生效
          </p>
        </div>
        <button class="wb-btn wb-btn--sm wb-btn--primary flex-shrink-0" @click="restartToInstall">
          立即重启
        </button>
      </div>

      <!-- 失败：错误信息 + 关闭 -->
      <div v-else class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium text-[var(--wb-danger)]">更新失败</p>
          <p class="text-xs text-[var(--wb-text-muted)] mt-0.5 break-all">{{ updError }}</p>
        </div>
        <button
          class="flex-shrink-0 text-xs text-[var(--wb-text-muted)] hover:text-[var(--wb-text)] px-1"
          @click="hideUpdBanner"
        >
          关闭
        </button>
      </div>
    </div>
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
import UiIslandView from './components/UiIslandView.vue';
import IconGlyph from './components/IconGlyph.vue';
import type { IconName } from './components/icons';
import { useModuleStorage } from './services/storage';
import { initTheme, useTheme } from './services/theme';
import { toast } from './services/toast';
import { ipc } from './services/ipc';
import { subNavOf } from './services/subNav';
import { NAV_GROUPS } from './nav';
import type { ModuleCommand, ModuleIcon, ModuleMeta } from './types';

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

// ---- 侧栏渲染行（一级项 + 分组子项 + 模块内二级项）-------------------------------
// 分组定义见 `src/core/nav.ts`。这里把"模块平铺"变成"可渲染的行序列"，模板只做一层 v-for：
//   · 无 parent 的模块 → 一级行（depth 0）
//   · 有 parent 的模块 → 收进其分组；分组行带展开箭头，子项 depth 1（缩进）
//   · 侧栏收起时（仅图标）不渲染分组行，子项平铺 —— 否则唯一入口会被折进点不到的地方
//   · 空分组 / parent 未登记的分组都不渲染，入口不会因为这两个字段而消失
//   · 模块内二级项（`kind: 'sub'`，2026-10-17 起）：`meta.subNav` 为 true 的模块在自己
//     **处于前台且侧栏展开**时，把运行时上报的项渲染成更深一层的缩进行。它与分组的区别是：
//     分组子项是**模块**（可独立激活、⌘K 可搜），二级项是**同一个模块里的面**（点了只切内容，
//     不换模块、不产生 TitleBar「返回」）。
type NavModuleRow = {
  key: string;
  kind: 'module';
  id: string;
  name: string;
  icon?: ModuleIcon;
  depth: number;
  /** 这个模块有二级菜单（画展开箭头；还没有上报时也画，否则用户不知道里面还有东西） */
  hasSub?: boolean;
  /**
   * 二级菜单此刻是否**展开**（只有 `hasSub` 的行才有意义）。
   * 判据 = 在前台 + 侧栏展开 + 没被用户手动收起 —— 三者缺一都算收起，
   * 模板的箭头旋转与 `aria-expanded` 只认这一个布尔（别再各自推一遍条件）。
   */
  subExpanded?: boolean;
};
type NavGroupRow = {
  key: string;
  kind: 'group';
  id: string;
  name: string;
  icon?: ModuleIcon;
  expanded: boolean;
  childActive: boolean;
};
/** 模块内部的二级项（缩进最深一层；点击 = 让模块自己切一屏，不是激活另一个模块） */
type NavSubRow = {
  key: string;
  kind: 'sub';
  /** 归属模块（仅为可读性与调试；点击不靠它，靠下面的 onSelect 闭包） */
  moduleId: string;
  name: string;
  icon?: IconName;
  /** 完整 data-act（保留 `kind-<id>` 这套既有锚点名 —— 冒烟与单测都钉在它上面） */
  act: string;
  count?: number | null;
  countTitle?: string;
  todo?: boolean;
  active: boolean;
  onSelect: () => void;
};
type NavRow = NavModuleRow | NavGroupRow | NavSubRow;

/** 用户手动收起的分组 id（持久化于 app-shell 命名空间 `collapsedGroups`） */
const collapsedGroups = ref<string[]>([]);

/**
 * 用户手动收起了**哪个模块**的二级菜单（2026-10-17 下午补）。
 *
 * 起因：展开态原本只由"是否在这个模块里"决定 ⇒ 点一级项「基础数据」时 `activate` 早退
 * （`activateCore` 对同模块直接 return），**没有任何办法把它收起来** —— 而那七个缩进项
 * 常驻约 288px，用户想临时让侧栏回到"只看模块"的形态时无路可走。
 *
 * 形态上刻意**只记一个 id、不持久化**（与 `collapsedGroups` 的差别就在这）：
 *   · 它表达的是一次**临时视图动作**；跨会话记住"基础数据默认收起"会让"点进去才展开"
 *     这条形态反过来 —— 用户下次点进来发现菜单是空的，以为功能坏了；
 *   · 只记一个 id 是因为它只对"当前前台模块"有意义，切走就清（见 `activateCore`）。
 */
const subCollapsedFor = ref<string>('');

const navRows = computed<NavRow[]>(() => {
  const metas = navMetas.value;
  const known = new Set(NAV_GROUPS.map((g) => g.id));
  // [排序值, 该一级项对应的行序列]
  const entries: Array<{ order: number; rows: NavRow[] }> = [];

  for (const m of metas) {
    if (m.parent && known.has(m.parent)) continue; // 归属已知分组的，稍后按分组展开
    // 二级菜单此刻开不开：**在前台 + 侧栏展开 + 没被手动收起**。
    // 手动收起是 2026-10-17 下午补的（用户口径：「现在点击基础数据没法收起二级菜单」）——
    // 少了第三个条件，点自己那次 `activate` 会早退（同模块直接 return），收起无路可走。
    const subOpen =
      !!m.subNav &&
      activeId.value === m.id &&
      !collapsed.value &&
      subCollapsedFor.value !== m.id;
    const rows: NavRow[] = [
      {
        key: `m:${m.id}`,
        kind: 'module',
        id: m.id,
        name: m.name,
        icon: m.icon,
        depth: 0,
        hasSub: !!m.subNav,
        subExpanded: subOpen,
      },
    ];

    // 模块内二级项：**只在"它正在前台 + 侧栏展开 + 没被手动收起"时画**（条件即上面的 `subOpen`）。
    // 这就是用户 2026-10-17 选的那条形态（"点进去才展开、切走自动收起"）——
    // 一举解决两件事：
    //   ① 侧栏常驻高度不被八个缩进项长期吃掉（展开时才占，约 8×36 = 288px）；
    //   ② 子项的 onSelect 只有在模块**确实挂载着**时才存在（模块不上报就没有 sub），
    //      于是不会出现"点得到但没反应"的幽灵项 —— 这个坑 2026-10-14 的分组那次踩过。
    // ⚠️ 侧栏收起（48px 纯图标）时**不画**子项：这里与上面分组的规矩**相反**。
    //    分组子项是"另一个模块的唯一条目"，折进点不到的地方等于入口消失，所以收起时平铺；
    //    二级项则不是入口 —— 一级项本身就在那儿，点进去就是用户上次停的那一屏。
    //    十四个图标挤在 48px 里谁也认不出，反而更糟。
    const sub = subOpen ? subNavOf(m.id) : undefined;
    if (sub) {
      for (const it of sub.items()) {
        rows.push({
          key: `s:${m.id}:${it.id}`,
          kind: 'sub',
          moduleId: m.id,
          name: it.name,
          icon: it.icon,
          // data-act 沿用 `kind-<id>`：这套锚点名从 2026-10-14 起被单测和三个冒烟脚本钉着，
          // 借这次搬家顺手改一遍等于让一堆断言静默失配（找不到元素 ⇒ 有的用例直接跳过）。
          act: `kind-${it.id}`,
          count: it.count,
          countTitle: it.countTitle,
          todo: it.todo,
          active: sub.activeId() === it.id,
          onSelect: () => sub.onSelect(it.id),
        });
      }
    }

    entries.push({ order: m.order ?? 0, rows });
  }

  for (const g of NAV_GROUPS) {
    const children = metas.filter((m) => m.parent === g.id);
    if (!children.length) continue; // 约束 1：空分组不渲染
    const childActive = children.some((c) => c.id === activeId.value);
    // 手动展开/收起 + 子项激活时强制展开（点进去后看得见自己在哪）
    const expanded = childActive || !collapsedGroups.value.includes(g.id);
    const rows: NavRow[] = [];
    if (!collapsed.value) {
      rows.push({
        key: `g:${g.id}`,
        kind: 'group',
        id: g.id,
        name: g.name,
        icon: g.icon,
        expanded,
        childActive,
      });
    }
    if (expanded || collapsed.value) {
      for (const c of children) {
        rows.push({
          key: `m:${c.id}`,
          kind: 'module',
          id: c.id,
          name: c.name,
          icon: c.icon,
          depth: collapsed.value ? 0 : 1,
        });
      }
    }
    entries.push({ order: g.order ?? 0, rows });
  }

  // 一级项之间按 order 升序（与既有 meta.order 同一坐标系；同值保持注册序稳定）
  return entries
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .flatMap((e) => e.rows);
});

/** 展开/收起一个侧栏分组 */
function toggleGroup(groupId: string): void {
  const next = collapsedGroups.value.includes(groupId)
    ? collapsedGroups.value.filter((id) => id !== groupId)
    : [...collapsedGroups.value, groupId];
  collapsedGroups.value = next;
  persistShell();
}

/**
 * 点一级模块行（模板里那个 `@click`）。
 *
 * 两种语义合并在一个入口，因为**用户眼里只有"这一行"**：
 *   · 还没进来 → 激活模块（原行为）；
 *   · 已经在这一模块里、且它有二级菜单 → 这一下是**收起/展开二级菜单**，
 *     不重新激活（`activateCore` 对同模块本来就早退，重激活什么也不会发生）。
 *     2026-10-17 下午用户反馈：「现在点击基础数据没法收起二级菜单」。
 */
function onModuleRow(row: NavModuleRow): void {
  if (row.hasSub && activeId.value === row.id) {
    subCollapsedFor.value = subCollapsedFor.value === row.id ? '' : row.id;
    return;
  }
  void activate(row.id);
}

const activeId = ref<string>('');
const activeView = shallowRef<any>(null);
const collapsed = ref(false);
const paletteOpen = ref(false);
const menuOpen = ref(false);
const hoveredAppearance = ref(false);
const settingsOpen = ref(false);
const settingsInitial = ref<{ category?: string; tab?: string }>({});
// §15 UI 岛（外置富 UI 插件）双通道：activeIslandId 非空 → 渲染 UiIslandView（桥会话生命周期随组件）
const activeIslandId = ref<string>('');
/** 当前 UiIslandView 实例（插件装/更新后外壳按需调它的 reload()；见 `reload-island` 监听） */
const islandRef = ref<InstanceType<typeof UiIslandView> | null>(null);

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
// 更新事件订阅退订函数（onUnmounted 清理）
let stopUpdaterEvents: (() => void) | null = null;
// 更新进度浮层状态：idle(隐藏) / downloading(进度条) / downloaded(重启安装) / error(失败信息)
const updPhase = ref<'idle' | 'downloading' | 'downloaded' | 'error'>('idle');
const updVersion = ref('');
const updPercent = ref(0);
const updError = ref('');
function hideUpdBanner() {
  updPhase.value = 'idle';
  updError.value = '';
}
async function restartToInstall() {
  try {
    const res = await ipc.quitAndInstallUpdate();
    if (!res.success) toast.error(`重启安装失败：${res.error || '未知错误'}`);
  } catch (e: unknown) {
    toast.error(`重启安装失败：${e instanceof Error ? e.message : '未知错误'}`);
  }
}

/** 刷新外置插件命令区（外置插件激活/停用/卸载/扫描后调用） */
function refreshPluginCommands() {
  pluginCommands.value = pm.getPluginCommands();
}

/** Phase 3：扫描 <userData>/plugins 并登记外置插件（失败只提示，不阻塞主流程）。
 *
 *  ⚠️ **必须在「恢复上次所在模块」之前 await 执行**：UI 岛（kind: 'ui'）只在 discoverExternal 里登记，
 *  而恢复逻辑用 `pm.has(id)` 判定 → 扫描晚于恢复时，上次所在的岛尚未登记 → 恢复被静默跳过、
 *  回落首个非岛模块（表现为「重启后不回到上次的岛」）。顺序见 onMounted 里的注释。
 *  岛 meta 的 order 固定 120（pluginManager.sortedMetas），故提前扫描**不会**改变无存档时的默认落点。 */
async function scanExternalPlugins(): Promise<void> {
  try {
    const found = await pm.discoverExternal();
    // §15：发现 UI 形态包（kind: 'ui'）时其侧栏 meta 需同步刷新（恢复逻辑之外，⌘K 也依赖）
    if (found.uiCount > 0) refreshMetas();
    for (const e of found.errors) toast.error(`外置插件 ${e.id} 加载失败: ${e.error}`);
  } catch (e) {
    toast.error(`外置插件扫描失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 激活 activationEvents 含 onStartup 的外置插件（扫描之后执行；不阻塞首屏激活，故不 await） */
async function startStartupExternalPlugins(): Promise<void> {
  try {
    const started = await pm.activateStartupPlugins();
    for (const e of started.errors) toast.error(`外置插件 ${e.id} 启动失败: ${e.error}`);
    refreshPluginCommands();
    if (started.activated.length > 0) {
      toast.success(`外置插件就绪：${started.activated.length} 个已激活`);
    }
  } catch (e) {
    toast.error(`外置插件启动失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 外壳级持久化：记住上次活动模块与侧边栏状态（独立命名空间，不影响业务模块数据）
// ⚠️ `save()` 是**整对象替换**（`setModuleState` 覆盖该命名空间），故所有写点必须走
//    `persistShell()` 统一落三字段 —— 否则某处只写两个字段会把第三个字段静默抹掉。
const shellStorage = useModuleStorage<{
  lastActiveModuleId?: string;
  collapsed?: boolean;
  /** 手动收起的一级分组 id（见 NAV_GROUPS） */
  collapsedGroups?: string[];
}>('app-shell');

/** 统一落盘外壳状态（唯一写点，避免漏字段） */
function persistShell(): void {
  shellStorage
    .save({
      lastActiveModuleId: activeId.value,
      collapsed: collapsed.value,
      collapsedGroups: collapsedGroups.value,
    })
    .catch(() => {});
}

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
  // 切模块时忘掉"手动收起"：它只对刚才那个模块有意义。
  // 不清的话，用户收起「基础数据」→ 去「邮件」→ 再点回「基础数据」，会看到一行空菜单 ——
  // "点进去才展开"这条形态被反过来，而且没有任何提示让他知道菜单还在（箭头是折着的）。
  if (id !== activeId.value) subCollapsedFor.value = '';
  if (id === activeId.value && activeView.value) return;
  if (pm.isUiIsland(id) && id === activeIslandId.value) return;

  try {
    // 插件管理器内部先停用上一插件，再懒加载并激活目标插件
    const result = await pm.activate(id);

    // §15 UI 岛：宿主双通道——activeIslandId 驱动 UiIslandView（pm.activate 对岛返回 view:null）
    if (pm.isUiIsland(id)) {
      activeIslandId.value = id;
      activeView.value = null;
    } else {
      activeIslandId.value = '';
      activeView.value = result.view;
    }
    activeId.value = id;
    // ⌘K 命令数据源与视图联动（来自命令贡献注册表）
    activeCommands.value = result.commands;

    // 持久化上次活动模块
    persistShell();
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
  persistShell();
}

function runCommand(cmd: ModuleCommand) {
  cmd.run();
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

/** §15 UI 岛「宿主→岛事件」演示按钮：经总线 emit，岛内订阅 sk:host-ping 后展示 */
function islandHostPing() {
  pm.bus.emit('sk:host-ping', { at: Date.now() });
}

/** §15 UI 岛「返回」：切回默认视图插件（首个非 UI 岛模块） */
function backFromIsland() {
  // 「从哪来回哪去」：优先复用 TitleBar 那套 `backId`（跨模块跳转记下的来源模块）。
  // 旧写法固定回退到"首个非岛模块"（当时是便签）—— 用户点「返回」却跳到一个他没去过的地方，
  // 是 UX 审查 C1 那条"岛的返回语义与预期不符"。
  if (backId.value) {
    goBack();
    return;
  }
  // 没有来源（直接从侧栏点进岛）时的兜底：仍回首个非岛模块 —— 至少保证有路可走。
  const fallback = sortedMetas.value.find((m) => !pm.isUiIsland(m.id)) ?? sortedMetas.value[0];
  if (fallback) void activateCore(fallback.id);
  else {
    activeIslandId.value = '';
    activeView.value = null;
    activeId.value = '';
  }
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
  const detail = (e as CustomEvent<{ moduleId?: string; action?: string; payload?: unknown }>)
    .detail;
  if (!detail?.moduleId) return;
  menuOpen.value = false;
  if (detail.action) {
    (window as any).__switchModuleAction = { ...detail };
  }
  activateFromSwitch(detail.moduleId);
}

/**
 * 全局事件：插件装好/更新后重载正在打开的那个岛（由 `PluginCenter` 派发，见 UX 审查 A3）。
 * 只认"正是当前打开的这个岛" —— 装了别的插件不该把用户正在看的页面刷掉。
 */
function onReloadIsland(e: Event) {
  const detail = (e as CustomEvent<{ pluginId?: string }>).detail;
  if (!activeIslandId.value) return;
  if (detail?.pluginId && detail.pluginId !== activeIslandId.value) return;
  islandRef.value?.reload();
}

// 软件更新：点击入口（真实检测；结果经 updater-event 事件异步送达，见 onMounted 订阅）
let checkBusy = false;
let lastCheckedAt = 0;
async function checkUpdates() {
  menuOpen.value = false;
  // 下载中/已就绪时不再发起新检查：避免并发触发 + 「后台下载中」反复提示
  if (updPhase.value === 'downloading') {
    toast.info('新版本正在下载中，请稍候…');
    return;
  }
  if (updPhase.value === 'downloaded') {
    toast.info('新版本已下载完成，点击「立即重启」即可安装');
    return;
  }
  // 3s 冷却，避免连点重复触发 autoUpdater.checkForUpdates（并发会报错）
  if (checkBusy || Date.now() - lastCheckedAt < 3000) return;
  checkBusy = true;
  try {
    const res = await ipc.checkForUpdates();
    if (!res.success) {
      toast.error(`检查更新失败：${res.error || '未知错误'}`);
      return;
    }
    if (res.data?.mode === 'dev') {
      toast.info(`开发模式：不检查更新（当前 v${appVersion.value || '1.0.0'}）`);
      return;
    }
    lastCheckedAt = Date.now();
    toast.info('正在检查更新…');
  } catch (e: unknown) {
    toast.error(`检查更新失败：${e instanceof Error ? e.message : '未知错误'}`);
  } finally {
    checkBusy = false;
  }
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

// 全局拖放兜底：把文件拖到窗口任意位置时，Chromium 的默认动作是**导航到该文件**——
// 拖一个 .html 进来就等于在主窗口把它加载起来，而 preload 绑定在 webContents 上、
// 不随 URL 变化，于是那个外来页面直接拥有 window.electronAPI（主进程侧已同步收敛导航白名单，
// 这里是渲染层第二道，且能在不触发 IPC 的情况下就拦掉）。
// 只拦「文件」拖放：拖文本/链接要留给输入框的默认插入行为。
// 用捕获阶段：即使某个子视图的 drop 处理里忘了 preventDefault，也不会漏掉导航这条默认动作；
// 不 stopPropagation，故各视图自己的投放区（以及 iframe 岛内的投放）照常工作。
function dragHasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}
function onGlobalDragOver(e: DragEvent) {
  if (dragHasFiles(e)) e.preventDefault();
}
function onGlobalDrop(e: DragEvent) {
  if (dragHasFiles(e)) e.preventDefault();
}

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('open-settings', onOpenSettings);
  window.addEventListener('switch-module', onSwitchModule);
  window.addEventListener('reload-island', onReloadIsland as EventListener);
  document.addEventListener('dragover', onGlobalDragOver, true);
  document.addEventListener('drop', onGlobalDrop, true);

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

  // ⚠️ 顺序敏感：先扫描并登记外置插件/UI 岛，再恢复上次所在模块。
  //    反了的话，上次所在的岛还没登记 → 下面 `pm.has()` 判假 → 静默回落到首个非岛模块。
  await scanExternalPlugins();

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
    if (Array.isArray(saved?.collapsedGroups)) collapsedGroups.value = saved.collapsedGroups;
  } catch {
    /* 忽略读取失败，使用默认模块 */
  }
  await activate(initialId);

  // 订阅插件状态变更：
  //  - 插件停用/启用 → 刷新侧栏/⌘K 数据源并持久化停用集；当前视图插件被停用时回退第一个启用插件
  //  - 外置插件激活/停用 → 刷新 ⌘K「外置插件命令」区
  //  - 随后懒激活 onStartup 外置插件（扫描已在恢复上次模块**之前**完成，见上方 scanExternalPlugins 注释）
  // 订阅更新事件：检测结果 / 下载完成 → toast 提示（下载完成后由主进程弹「立即重启」原生对话框）
  stopUpdaterEvents = ipc.onUpdaterEvent((ev) => {
    switch (ev.type) {
      case 'update-available':
        updPhase.value = 'downloading';
        updVersion.value = ev.version || '';
        updPercent.value = 0;
        toast.info(ev.version ? `发现新版本 v${ev.version}，开始下载…` : '发现新版本，开始下载…');
        break;
      case 'download-progress':
        if (ev.percent !== undefined) {
          updPhase.value = 'downloading';
          updPercent.value = ev.percent;
        }
        break;
      case 'update-not-available':
        toast.success(`已是最新版本 (v${appVersion.value || '1.0.0'})`);
        break;
      case 'update-downloaded':
        updPhase.value = 'downloaded';
        if (ev.version) updVersion.value = ev.version;
        toast.info(ev.version ? `新版本 v${ev.version} 已下载完成` : '新版本已下载完成');
        break;
      case 'updater-error':
        updPhase.value = 'error';
        updError.value = ev.message || '未知错误';
        toast.error(`检查更新失败：${ev.message || '未知错误'}`);
        break;
      default:
        break; // checking 静默
    }
  });

  stopStateWatch = pm.onStateChange((id, state, prev) => {
    refreshPluginCommands();
    // P2：UI 岛轨道事件（注册 loaded/installed、启停 loaded/disabled 由 pm 合成广播）→ 即时刷新侧栏
    if (pm.isUiIsland(id)) refreshMetas();
    // 停用（state=disabled）或从停用恢复启用（disabled→installed→loaded 序列，prev=disabled 即触发）
    if (state === 'disabled' || prev === 'disabled') {
      refreshMetas();
      // 业务流返回标记指向被停用插件时清空，避免 TitleBar 残留无效返回入口
      if (backId.value === id) backId.value = '';
      pluginStateStorage.save({ disabled: pm.getDisabledIds() }).catch(() => {});
    }
    // 内建插件停用 + UI 岛停用（pm 以 prev=active 合成广播）且正被显示 → 自动回落其他入口
    if (prev === 'active' && state === 'disabled' && id === activeId.value) {
      const fallback = sortedMetas.value[0];
      if (fallback && fallback.id !== id) {
        activateCore(fallback.id).catch((e) => {
          toast.error(`插件已停用：${e instanceof Error ? e.message : String(e)}`);
          activeView.value = null;
          activeId.value = '';
          activeIslandId.value = '';
        });
      } else {
        activeView.value = null;
        activeId.value = '';
        // 被停用的正是当前显示的 UI 岛且无其他可用入口 → 一并清岛状态
        if (id === activeIslandId.value) activeIslandId.value = '';
      }
    }
    // P2：插件/UI 岛被卸载（运行时已移除）→ 刷新侧栏；若正显示被卸载的岛则回落其他入口
    if (!pm.has(id)) {
      refreshMetas();
      if (id === activeIslandId.value) backFromIsland();
    }
  });
  void startStartupExternalPlugins();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  window.removeEventListener('open-settings', onOpenSettings);
  window.removeEventListener('switch-module', onSwitchModule);
  window.removeEventListener('reload-island', onReloadIsland as EventListener);
  document.removeEventListener('dragover', onGlobalDragOver, true);
  document.removeEventListener('drop', onGlobalDrop, true);
  stopStateWatch?.();
  stopUpdaterEvents?.();
});

function iconSvg(icon?: string): string {
  const map: Record<string, string> = {
    table:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></svg>',
    tool: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 7a3 3 0 10-4 4l-6 6 2 2 6-6a3 3 0 004-4l-2 2-2-2 2-2z"/></svg>',
    box: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v6c0 4-3 7-8 8-5-1-8-4-8-8V7z"/></svg>',
    chart:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    sparkles:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
    note: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h11l4 4v12H5z"/><path d="M15 4v5h5M9 13h6M9 17h6"/></svg>',
    key: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.5 12v3M20 12v2"/></svg>',
    shop: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9h16v10a1 1 0 01-1 1H5a1 1 0 01-1-1z"/><path d="M3 9l1.5-5h15L21 9M9 20v-5h6v5"/></svg>',
    // 2026-10-17：「邮件」独立成一级模块后需要一枚信封（没有它就落到 fallback 的 box，
    // 与侧栏里另一个用 box 的入口撞脸）。
    inbox:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h18v12H3z"/><path d="M3 7l9 6 9-6"/></svg>',
  };
  return map[icon || ''] || map.box;
}

/** 分组展开箭头（侧栏一级分组用，展开时旋转 90°） */
const chevronIcon =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg>';

const accountIcon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 11a3 3 0 100-6 3 3 0 000 6zM6.5 19a5.5 5.5 0 0111 0"/></svg>';
const settingsIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const paletteIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3a9 9 0 100 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 004-4c0-4.4-4-7.7-9-7.7z"/><circle cx="7.5" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/></svg>';
const updateIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 4v4h-4"/></svg>';
/** 插件中心（拼图块） */
const pluginIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h6a2 2 0 012 2v2h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v2a2 2 0 01-2 2H9a2 2 0 01-2-2v-2H5a2 2 0 01-2-2v-2h2.5a1.5 1.5 0 000-3H3V9a2 2 0 012-2h2V5a2 2 0 012-2z"/></svg>';
</script>
