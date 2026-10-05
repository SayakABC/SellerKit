<script setup lang="ts">
// extensions/shop-accounts/src/ShopAccountsView.vue
// 「店铺账号管家」主视图：以「店铺套 · 邮箱」为单位管理店群账号（表格 / 卡片 / 分组三视图）。
//
// 默认表格视图（管理维护友好）：搜索 + 状态/平台筛选 + 明文字段点击复制 + 密码徽标（复制 / 临时查看）
// + 一键复制模板（ERP 登录 / 紫鸟登录 / 全部字段）+ 行内编辑 / 删除；卡片视图用于快速浏览。
// 分组视图：左侧分组导航（看清有哪些分组、各组多少店铺、层级归属）+ 右侧店铺列表，
// 支持整组三态勾选、整组复制邮箱、整组批量修改——即「先按分组找到店铺，再对这批店铺操作」。
// 隐私模式：一键全局隐藏所有密码，防投屏 / 录屏泄露。

import { computed, onBeforeUnmount, onMounted } from 'vue';
import {
  groupFieldLabel,
  openedDaysText,
  useShopAccountsStore,
  type StatusTone,
} from './store';
import AccountEditor from './components/AccountEditor.vue';
import BatchEditDrawer from './components/BatchEditDrawer.vue';
import CopyableCell from './components/CopyableCell.vue';
import CopyMenu from './components/CopyMenu.vue';
import GroupNavItem from './components/GroupNavItem.vue';
import GroupPicker from './components/GroupPicker.vue';
import IconGlyph from './components/IconGlyph.vue';
import MailAccessDrawer from './components/MailAccessDrawer.vue';
import MailInboxView from './components/MailInboxView.vue';
import SecretCell from './components/SecretCell.vue';
import CompanyManageView from './components/CompanyManageView.vue';
import ShopRegistryView from './components/ShopRegistryView.vue';
import { openHostSettingsPanel } from './bridge.js';
import { toast } from '@/core/services/toast';
import { useMailStore } from './mailStore';
import type { ShopAccountItem, ShopAccountStatus } from '@/types';

const store = useShopAccountsStore();
const mail = useMailStore();

/** 打开该店铺套的「接入邮箱」抽屉（IMAP 授权码只进不出） */
function openMailAccess(item: ShopAccountItem): void {
  mail.openAccess(item.id);
}

/** 各邮箱接入状态下的补充说明（用于 tooltip） */
const MAIL_STATUS_HINT: Record<string, string> = {
  idle: '点击管理接入',
  syncing: '正在同步',
  error: '连接异常，点击查看',
  paused: '已停用，点击恢复',
};

/**
 * 行内「邮箱」按钮的呈现：已接入 / 未接入用**不同图标 + 不同配色**，一眼可辨。
 * 已接入 = mail-check（信封带勾）+ 主色实底；未接入 = mail（空信封）+ 灰描边。
 */
function mailAccessState(item: ShopAccountItem): { connected: boolean; tone: string; title: string } {
  const acc = mail.mailAccessOf(item.id);
  if (!acc) return { connected: false, tone: 'off', title: '未接入邮箱 · 点此接入（IMAP 收件）' };
  const hint = MAIL_STATUS_HINT[acc.status] || '点击管理接入';
  return {
    connected: true,
    tone: acc.status === 'error' ? 'danger' : 'on',
    title: `已接入 ${acc.email} · ${hint}`,
  };
}

function selectStatus(value: ShopAccountStatus | ''): void {
  store.statusFilter = store.statusFilter === value ? '' : value;
}

function requestDelete(item: ShopAccountItem): void {
  if (!window.confirm(`确认删除店铺套「${item.email}」？该操作不可撤销，已保存的密码也会一并删除。`)) {
    return;
  }
  void store.remove(item);
}

/** 列表内平台标签最多展示数量，超出部分以 +N 概括（完整列表由 title 展示） */
const PLATFORM_VISIBLE_LIMIT = 3;

function visiblePlatforms(platforms: string[]): string[] {
  return platforms.slice(0, PLATFORM_VISIBLE_LIMIT);
}

function hiddenPlatformCount(platforms: string[]): number {
  return Math.max(0, platforms.length - PLATFORM_VISIBLE_LIMIT);
}

function platformsTitle(platforms: string[]): string {
  return platforms.join('、');
}

/**
 * 一批店铺的状态分布（仅保留有店铺的状态，顺序同 STATUS_META）。
 * @param list 待统计的店铺列表（详情区传入当前聚焦分组的并集店铺）
 */
function statusBreakdown(
  list: ShopAccountItem[],
): { value: ShopAccountStatus; label: string; tone: StatusTone; count: number }[] {
  return store.statusCounts
    .map((s) => ({
      value: s.value,
      label: s.label,
      tone: s.tone,
      count: list.filter((i) => i.status === s.value).length,
    }))
    .filter((s) => s.count > 0);
}

// ── 分组视图（左栏分组导航 + 右侧店铺列表）─────────────────────────────────

/** 是否启用「左栏导航 + 右侧列表」的分组布局（空列表 / 加载中不启用） */
const hasGroupLayout = computed(
  () => store.viewMode === 'group' && !store.isEmpty && !store.loading,
);

/** 左栏当前选中项的选中态：聚焦分组时取该组，否则取全部（驱动整组复选框三态） */
const currentSelectionState = computed(() =>
  store.activeGroupNode
    ? store.groupSelectionState(store.activeGroupNode)
    : store.allSelectionState,
);

/** 左栏当前选中项的名称（按钮 / 提示文案用） */
const currentGroupName = computed(() => store.activeGroupNode?.label ?? '全部分组');

/** 当前组是否已全选（决定「全选本组 / 取消本组」文案） */
const isCurrentGroupAllSelected = computed(() => currentSelectionState.value === 'all');

/** 整组选中 / 取消：聚焦分组时作用于该组（含子组），「全部」时作用于整个筛选结果 */
function toggleCurrentGroupSelection(): void {
  const node = store.activeGroupNode;
  if (node) {
    store.toggleSelectGroup(node);
    return;
  }
  if (store.isAllSelected()) store.clearSelection();
  else store.selectAll();
}

/** 复制左栏当前选中项的全部邮箱（「全部」时即整个筛选结果） */
function copyCurrentGroupEmails(): void {
  void store.copyEmails(store.activeGroupItems, currentGroupName.value);
}

/**
 * 对当前分组发起批量修改。
 * 本组尚未勾选任何店铺时先整组选中再打开抽屉，避免「点了批量修改却没有可改项」。
 */
function batchEditCurrentGroup(): void {
  const node = store.activeGroupNode;
  if (node) {
    if (store.groupSelectionState(node) === 'none') store.toggleSelectGroup(node);
  } else if (!store.hasSelection) {
    store.selectAll();
  }
  store.openBatchEdit();
}

onMounted(async () => {
  // 邮件库初始化 + 未读统计（页签徽标要用），失败已在 store 内 toast
  void mail.ensureReady();
  window.addEventListener('shop-accounts:goto', handleGotoTab);
  if (!store.initialized) {
    await store.init();
    return;
  }
  // 再次进入模块时刷新列表与汇总（保留筛选条件）
  await store.reload();
});

/**
 * 打开宿主设置中心并定位到本岛设置分类（`shop-accounts:settings`）。
 * 设置页已迁至宿主（manifest.settings 贡献），岛内不再渲染设置内容：
 * 经受控桥发宿主保留事件 `host:open-settings`（uiBridgeHost 转成宿主 open-settings），
 * 宿主 AppShell 打开 SettingsModal 并定位分类。
 */
function openHostSettings(): void {
  if (openHostSettingsPanel('shop-accounts:settings')) toast('已打开宿主设置中心', 'info');
  else toast('未连接宿主，无法打开设置中心', 'error');
}

/** 收件箱空态「去账号库接入」→ 切回账号库页签 */
function handleGotoTab(event: Event): void {
  const detail = (event as CustomEvent<{ tab?: string }>).detail;
  if (detail?.tab === 'accounts') store.mainTab = 'accounts';
}

onBeforeUnmount(() => {
  window.removeEventListener('shop-accounts:goto', handleGotoTab);
  store.clearAllReveals();
});
</script>

<template>
  <div class="shop-accounts-view">
    <div v-if="!store.secureStorage" class="banner">
      <IconGlyph name="alert" :size="14" />
      <span>系统安全存储不可用，密码将以降级方式保存，建议仅在受信任设备上使用。</span>
    </div>

    <header class="view-header">
      <div class="stat-group">
        <button
          class="stat"
          :class="{ 'is-active': !store.statusFilter }"
          type="button"
          @click="selectStatus('')"
        >
          <span class="stat-num">{{ store.summary.total }}</span>
          <span class="stat-label">全部店铺套</span>
        </button>
        <button
          v-for="s in store.statusCounts"
          :key="s.value"
          class="stat"
          :class="[`tone-${s.tone}`, { 'is-active': store.statusFilter === s.value }]"
          type="button"
          @click="selectStatus(s.value)"
        >
          <span class="stat-num">{{ s.count }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </button>
      </div>
      <button class="btn-primary" type="button" @click="store.openCreate()">
        <IconGlyph name="plus" :size="14" />
        <span>新增店铺套</span>
      </button>
    </header>

    <div class="main-tabs">
      <button
        class="tab"
        :class="{ active: store.mainTab === 'accounts' }"
        type="button"
        @click="store.mainTab = 'accounts'"
      >
        <IconGlyph name="grid" :size="14" />
        <span>账号库</span>
      </button>
      <button
        class="tab"
        :class="{ active: store.mainTab === 'mail' }"
        type="button"
        @click="store.mainTab = 'mail'"
      >
        <IconGlyph name="inbox" :size="14" />
        <span>邮件收件箱</span>
        <span v-if="mail.unread" class="tab-badge">{{ mail.unread }}</span>
      </button>
      <button
        class="tab"
        :class="{ active: store.mainTab === 'companies' }"
        type="button"
        @click="store.mainTab = 'companies'"
      >
        <IconGlyph name="layers" :size="14" />
        <span>企业管理</span>
      </button>
      <button
        class="tab"
        :class="{ active: store.mainTab === 'shops' }"
        type="button"
        @click="store.mainTab = 'shops'"
      >
        <IconGlyph name="table" :size="14" />
        <span>店铺登记</span>
      </button>
      <button
        class="tab tab-goto-settings"
        type="button"
        title="在宿主设置中心打开账号管家设置"
        @click="openHostSettings()"
      >
        <IconGlyph name="shield" :size="14" />
        <span>设置</span>
        <IconGlyph name="external" :size="11" />
      </button>
    </div>

    <MailInboxView v-if="store.mainTab === 'mail'" />

    <CompanyManageView v-else-if="store.mainTab === 'companies'" />

    <ShopRegistryView v-else-if="store.mainTab === 'shops'" />

    <template v-if="store.mainTab === 'accounts'">
    <div class="toolbar">
      <label class="search-box">
        <IconGlyph name="search" :size="14" />
        <input
          v-model="store.search"
          type="text"
          placeholder="搜索 邮箱 / 手机号 / 企业 / 支付宝 / 紫鸟 / ERP / 平台"
        />
        <button
          v-if="store.search"
          class="icon-btn"
          type="button"
          title="清空搜索"
          @click="store.search = ''"
        >
          <IconGlyph name="x" :size="12" />
        </button>
      </label>

      <select v-model="store.statusFilter" class="filter">
        <option value="">全部状态</option>
        <option v-for="s in store.statusCounts" :key="s.value" :value="s.value">
          {{ s.label }}
        </option>
      </select>

      <select v-model="store.platformFilter" class="filter">
        <option value="">全部平台</option>
        <option v-for="p in store.summary.platforms" :key="p.platform" :value="p.platform">
          {{ p.platform }}（{{ p.count }}）
        </option>
      </select>

      <button
        class="btn-ghost"
        :class="{ 'is-on': store.privacyMode }"
        type="button"
        :title="store.privacyMode ? '关闭隐私模式' : '开启隐私模式（全局隐藏所有密码）'"
        @click="store.setPrivacyMode(!store.privacyMode)"
      >
        <IconGlyph :name="store.privacyMode ? 'eye-off' : 'eye'" :size="14" />
        <span>{{ store.privacyMode ? '隐私模式已开' : '隐私模式' }}</span>
      </button>

      <template v-if="store.hasSelection">
        <span class="selection-badge">
          已选 {{ store.selectionCount }} 套
          <button
            class="chip-close"
            type="button"
            title="清除选择"
            @click="store.clearSelection()"
          >
            ×
          </button>
        </span>
        <button class="btn-ghost is-on" type="button" @click="store.openBatchEdit()">
          <IconGlyph name="edit" :size="14" />
          <span>批量修改</span>
        </button>
      </template>

      <GroupPicker v-if="store.viewMode === 'group'" />

      <div class="view-switch">
        <button
          type="button"
          title="表格视图"
          :class="{ 'is-active': store.viewMode === 'table' }"
          @click="store.viewMode = 'table'"
        >
          <IconGlyph name="table" :size="14" />
        </button>
        <button
          type="button"
          title="卡片视图"
          :class="{ 'is-active': store.viewMode === 'card' }"
          @click="store.viewMode = 'card'"
        >
          <IconGlyph name="grid" :size="14" />
        </button>
        <button
          type="button"
          title="分组视图（以自选字段为维度归类查看账号组）"
          :class="{ 'is-active': store.viewMode === 'group' }"
          @click="store.viewMode = 'group'"
        >
          <IconGlyph name="layers" :size="14" />
        </button>
      </div>
    </div>

    <!-- 分组视图：左栏分组导航（有哪些分组 / 各组多少店铺 / 层级归属）与右侧列表并排 -->
    <div class="content-split" :class="{ 'has-nav': hasGroupLayout }">
      <aside v-if="hasGroupLayout" class="group-nav">
        <div class="nav-head">
          <span class="nav-title">分组导航</span>
          <span class="nav-meta">{{ store.grouping ? `${store.groupNodeCount} 个分组` : '未设维度' }}</span>
        </div>

        <template v-if="store.grouping">
          <div class="nav-tools">
            <button class="mini-text" type="button" @click="store.expandAllGroups()">展开全部</button>
            <button class="mini-text" type="button" @click="store.collapseAllGroups()">收起全部</button>
          </div>
          <div class="nav-list">
            <div
              class="nav-item"
              :class="{ 'is-active': !store.activeGroupKey }"
              @click="store.setActiveGroup('')"
            >
              <span class="nav-caret is-leaf"></span>
              <input
                class="nav-check"
                type="checkbox"
                :checked="store.allSelectionState === 'all'"
                :indeterminate="store.allSelectionState === 'partial'"
                title="全选 / 取消全选（当前筛选结果）"
                @click.stop
                @change="toggleCurrentGroupSelection()"
              />
              <span class="nav-label">全部店铺</span>
              <span class="nav-count">{{ store.items.length }}</span>
            </div>
            <GroupNavItem v-for="node in store.groupTree" :key="node.key" :node="node" :depth="0" />
          </div>
          <p v-if="store.hasMultiGroup" class="nav-hint">
            <IconGlyph name="alert" :size="11" />
            <span>含多值维度，同一店铺会归入多个分组</span>
          </p>
        </template>

        <div v-else class="nav-empty">
          <IconGlyph name="layers" :size="22" />
          <p class="nav-empty-title">尚未选择分组维度</p>
          <p class="nav-empty-hint">在工具栏「分组维度」中勾选字段，即可按分组查看与管理店铺。</p>
        </div>
      </aside>

      <!-- 右侧内容区：分组视图下与左栏并排 -->
      <div class="content-area">
        <!-- 详情头：当前分组路径 + 状态分布 + 整组操作（对「这批店铺」直接动手）
             用 v-show 而非 v-if，避免打断下方 loading / empty / 列表的 v-if 链 -->
        <div v-show="hasGroupLayout" class="detail-head">
          <div class="crumb-row">
            <button
              class="crumb"
              :class="{ 'is-current': !store.activeGroupKey }"
              type="button"
              @click="store.setActiveGroup('')"
            >
              <span class="crumb-label">全部分组</span>
            </button>
            <template v-for="n in store.activeGroupTrail" :key="n.key">
              <span class="crumb-sep">›</span>
              <button
                class="crumb"
                :class="{ 'is-current': n.key === store.activeGroupKey }"
                type="button"
                @click="store.setActiveGroup(n.key)"
              >
                <span class="crumb-dim">{{ groupFieldLabel(n.field) }}</span>
                <span class="crumb-label">{{ n.label }}</span>
              </button>
            </template>
            <span class="crumb-count">{{ store.activeGroupItems.length }} 套店铺</span>
          </div>

          <div class="detail-actions">
            <span
              v-for="s in statusBreakdown(store.activeGroupItems)"
              :key="s.value"
              class="group-status"
              :class="`tone-${s.tone}`"
            >
              {{ s.label }} {{ s.count }}
            </span>
            <span class="detail-spacer"></span>
            <button class="mini-text" type="button" @click="toggleCurrentGroupSelection()">
              {{ isCurrentGroupAllSelected ? '取消本组' : '全选本组' }}
            </button>
            <button class="mini-text" type="button" @click="copyCurrentGroupEmails()">
              <IconGlyph name="copy" :size="11" />
              <span>复制邮箱</span>
            </button>
            <button class="btn-ghost is-on" type="button" @click="batchEditCurrentGroup()">
              <IconGlyph name="edit" :size="13" />
              <span>批量修改本组</span>
            </button>
          </div>
        </div>

        <div v-if="store.loading" class="placeholder">加载中…</div>

    <div v-else-if="store.isEmpty" class="placeholder">
      <template v-if="store.hasFilter">
        <p>没有符合条件的店铺套</p>
        <button class="btn-ghost" type="button" @click="store.resetFilters()">清除筛选条件</button>
      </template>
      <template v-else>
        <p>还没有店铺套，先新增一套吧</p>
        <button class="btn-primary" type="button" @click="store.openCreate()">
          <IconGlyph name="plus" :size="14" />
          <span>新增店铺套</span>
        </button>
      </template>
    </div>

    <div v-else-if="store.viewMode === 'table' || store.viewMode === 'group'" class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="col-select">
              <input
                type="checkbox"
                title="全选 / 取消全选（当前列表）"
                :checked="store.isAllSelected()"
                @change="store.toggleSelectAll()"
              />
            </th>
            <th title="店铺邮箱（业务主标识）">店铺邮箱</th>
            <th>状态</th>
            <th title="开店时间（YYYY-MM-DD）与开店至今的天数">开店时间</th>
            <th title="关联手机号">手机号</th>
            <th title="关联企业名称">企业</th>
            <th title="关联支付宝">支付宝</th>
            <th title="关联紫鸟账号">紫鸟</th>
            <th title="关联 ERP 账号">ERP</th>
            <th title="关联平台">平台</th>
            <th title="密码（复制 / 临时查看）">密码</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <!-- 表格视图与分组视图共用同一套行渲染：数据源为「当前聚焦分组（或全部）的店铺」 -->
          <tr v-for="item in store.activeGroupItems" :key="item.id">
            <td class="col-select">
              <input
                type="checkbox"
                :title="store.isSelected(item.id) ? '取消选择' : '加入批量修改'"
                :checked="store.isSelected(item.id)"
                @change="store.toggleSelect(item.id)"
              />
            </td>
            <td class="col-email">
              <CopyableCell :item="item" field="email" label="店铺邮箱" />
              <div v-if="item.tags" class="cell-sub" :title="item.tags">{{ item.tags }}</div>
            </td>
            <td>
              <span class="status-chip" :class="`tone-${store.statusMeta(item.status).tone}`">
                {{ store.statusMeta(item.status).label }}
              </span>
            </td>
            <td>
              <template v-if="item.openedAt">
                <span class="opened-date">{{ item.openedAt }}</span>
                <div class="cell-sub held-days-line">{{ openedDaysText(item.openedAt) }}</div>
              </template>
              <span v-else class="cell-empty">—</span>
            </td>
            <td><CopyableCell :item="item" field="phone" label="关联手机号" /></td>
            <td><CopyableCell :item="item" field="company" label="关联企业名称" /></td>
            <td><CopyableCell :item="item" field="alipay" label="关联支付宝" /></td>
            <td><CopyableCell :item="item" field="ziniaoAccount" label="紫鸟账号" /></td>
            <td><CopyableCell :item="item" field="erpAccount" label="ERP账号" /></td>
            <td>
              <div
                v-if="item.platforms.length"
                class="platform-tags"
                :title="platformsTitle(item.platforms)"
              >
                <span v-for="p in visiblePlatforms(item.platforms)" :key="p" class="platform-tag">
                  {{ p }}
                </span>
                <span v-if="hiddenPlatformCount(item.platforms)" class="platform-more">
                  +{{ hiddenPlatformCount(item.platforms) }}
                </span>
              </div>
              <span v-else class="cell-empty">—</span>
            </td>
            <td><SecretCell :item="item" /></td>
            <td class="col-actions">
              <div class="row-actions">
                <CopyMenu :item="item" />
                <button
                  class="icon-btn mail-btn"
                  :class="`is-${mailAccessState(item).tone}`"
                  type="button"
                  :title="mailAccessState(item).title"
                  :aria-label="mailAccessState(item).title"
                  @click="openMailAccess(item)"
                >
                  <IconGlyph :name="mailAccessState(item).connected ? 'mail-check' : 'mail'" :size="13" />
                </button>
                <button class="icon-btn" type="button" title="编辑" @click="store.openEdit(item.id)">
                  <IconGlyph name="edit" :size="13" />
                </button>
                <button
                  class="icon-btn is-danger"
                  type="button"
                  title="删除"
                  @click="requestDelete(item)"
                >
                  <IconGlyph name="trash" :size="13" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="card-grid">
      <article v-for="item in store.items" :key="item.id" class="card">
        <div class="card-head">
          <div class="card-title">
            <input
              type="checkbox"
              :title="store.isSelected(item.id) ? '取消选择' : '加入批量修改'"
              :checked="store.isSelected(item.id)"
              @change="store.toggleSelect(item.id)"
            />
            <CopyableCell :item="item" field="email" label="店铺邮箱" />
            <span class="status-chip" :class="`tone-${store.statusMeta(item.status).tone}`">
              {{ store.statusMeta(item.status).label }}
            </span>
          </div>
          <div class="row-actions">
            <CopyMenu :item="item" />
            <button
              class="icon-btn mail-btn"
              :class="`is-${mailAccessState(item).tone}`"
              type="button"
              :title="mailAccessState(item).title"
              :aria-label="mailAccessState(item).title"
              @click="openMailAccess(item)"
            >
              <IconGlyph :name="mailAccessState(item).connected ? 'mail-check' : 'mail'" :size="13" />
            </button>
            <button class="icon-btn" type="button" title="编辑" @click="store.openEdit(item.id)">
              <IconGlyph name="edit" :size="13" />
            </button>
            <button
              class="icon-btn is-danger"
              type="button"
              title="删除"
              @click="requestDelete(item)"
            >
              <IconGlyph name="trash" :size="13" />
            </button>
          </div>
        </div>

        <div class="card-fields">
          <div class="card-field">
            <span class="field-key">开店时间</span>
            <span v-if="item.openedAt" class="opened-value" :title="`${item.openedAt} 开店`">
              {{ item.openedAt }}
              <span class="opened-days">{{ openedDaysText(item.openedAt) }}</span>
            </span>
            <span v-else class="cell-empty">—</span>
          </div>
          <div class="card-field">
            <span class="field-key">手机号</span>
            <CopyableCell :item="item" field="phone" label="关联手机号" />
          </div>
          <div class="card-field">
            <span class="field-key">企业</span>
            <CopyableCell :item="item" field="company" label="关联企业名称" />
          </div>
          <div class="card-field">
            <span class="field-key">支付宝</span>
            <CopyableCell :item="item" field="alipay" label="关联支付宝" />
          </div>
          <div class="card-field">
            <span class="field-key">紫鸟</span>
            <CopyableCell :item="item" field="ziniaoAccount" label="紫鸟账号" />
          </div>
          <div class="card-field">
            <span class="field-key">ERP</span>
            <CopyableCell :item="item" field="erpAccount" label="ERP账号" />
          </div>
          <div class="card-field">
            <span class="field-key">平台</span>
            <div
              v-if="item.platforms.length"
              class="platform-tags"
              :title="platformsTitle(item.platforms)"
            >
              <span v-for="p in visiblePlatforms(item.platforms)" :key="p" class="platform-tag">
                {{ p }}
              </span>
              <span v-if="hiddenPlatformCount(item.platforms)" class="platform-more">
                +{{ hiddenPlatformCount(item.platforms) }}
              </span>
            </div>
            <span v-else class="cell-empty">—</span>
          </div>
        </div>

        <SecretCell :item="item" />

        <div v-if="item.tags || item.note" class="card-foot">
          <span v-if="item.tags" class="card-tag" :title="item.tags">{{ item.tags }}</span>
          <span v-if="item.note" class="card-note" :title="item.note">{{ item.note }}</span>
        </div>
      </article>
      </div>
      </div>
    </div>

    </template>

    <AccountEditor v-if="store.editorOpen" />
    <BatchEditDrawer v-if="store.batchEditOpen" />
    <MailAccessDrawer @close="mail.closeAccess()" />
  </div>
</template>

<style scoped>
.shop-accounts-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px 18px;
  overflow: hidden;
  color: var(--wb-text);
}

/* 安全降级提示 */
.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border: 1px solid var(--wb-warning);
  border-radius: var(--wb-radius);
  background: var(--wb-warning-soft);
  color: var(--wb-text);
  font-size: 12.5px;
}

/* 统计条 */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.stat-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.stat:hover {
  border-color: var(--wb-primary);
}
.stat.is-active {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.stat-num {
  font-size: 15px;
  font-weight: 700;
  color: var(--wb-text);
}
.stat-label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.stat.tone-success .stat-num {
  color: var(--wb-success);
}
.stat.tone-warning .stat-num {
  color: var(--wb-warning);
}
.stat.tone-danger .stat-num {
  color: var(--wb-danger);
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 260px;
  min-width: 200px;
  padding: 0 10px;
  height: 32px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text-muted);
}
.search-box input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  outline: none;
}
.filter {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
}
.view-switch {
  display: inline-flex;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  overflow: hidden;
}
.view-switch button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  cursor: pointer;
}
.view-switch button + button {
  border-left: 1px solid var(--wb-border);
}
.view-switch button.is-active {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

/* 按钮 */
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--wb-primary);
  border-radius: var(--wb-radius);
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-primary:hover {
  background: var(--wb-primary-hover);
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.btn-ghost:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.btn-ghost.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.icon-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.icon-btn.is-danger:hover {
  color: var(--wb-danger);
  border-color: var(--wb-danger);
  background: transparent;
}
/* 邮箱接入状态：已接入（信封带勾 + 主色实底）/ 未接入（空信封 + 灰描边），图标与配色双重区分 */
.mail-btn.is-off {
  color: var(--wb-text-muted);
  border-style: dashed;
}
.mail-btn.is-off:hover {
  color: var(--wb-primary);
  border-style: solid;
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.mail-btn.is-on {
  color: var(--wb-primary);
  border-color: transparent;
  background: var(--wb-primary-soft);
}
.mail-btn.is-on:hover {
  border-color: var(--wb-primary);
}
.mail-btn.is-danger {
  color: var(--wb-danger);
  border-color: transparent;
  background: color-mix(in srgb, var(--wb-danger) 12%, transparent);
}
.mail-btn.is-danger:hover {
  border-color: var(--wb-danger);
  background: color-mix(in srgb, var(--wb-danger) 18%, transparent);
}

/* 占位 */
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  color: var(--wb-text-muted);
  font-size: 13px;
}

/* 表格 */
.table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}
.data-table {
  width: 100%;
  min-width: 1240px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12.5px;
}
/* 固定列宽：单元格一律单行展示，超出省略（窄窗口下由 .table-wrap 横向滚动）
   注意：序号含义为 1=选择列、2=店铺邮箱、3=状态、4=开店时间、5~11=其余业务列、12=操作；
   新增列时须整体重排百分比（当前合计 100%） */
.data-table th:nth-child(1) {
  width: 40px;
} /* 选择列 */
.data-table th:nth-child(2) {
  width: 13%;
} /* 店铺邮箱 */
.data-table th:nth-child(3) {
  width: 6.5%;
} /* 状态 */
.data-table th:nth-child(4) {
  width: 9%;
} /* 开店时间 */
.data-table th:nth-child(5) {
  width: 8.5%;
} /* 手机号 */
.data-table th:nth-child(6) {
  width: 9%;
} /* 企业 */
.data-table th:nth-child(7) {
  width: 9%;
} /* 支付宝 */
.data-table th:nth-child(8) {
  width: 8%;
} /* 紫鸟 */
.data-table th:nth-child(9) {
  width: 8%;
} /* ERP */
.data-table th:nth-child(10) {
  width: 9%;
} /* 平台 */
.data-table th:nth-child(11) {
  width: 10%;
} /* 密码 */
.data-table th:nth-child(12) {
  width: 10%;
} /* 操作 */
.data-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 12px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.data-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--wb-border);
  vertical-align: middle;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.data-table tbody tr:hover td {
  background: var(--wb-hover);
}
.data-table tbody tr:last-child td {
  border-bottom: none;
}
.col-email {
  font-weight: 600;
}
/* 选择列：固定窄列，仅放复选框（宽度由 nth-child(1) 控制，此处只收窄内边距） */
.data-table th.col-select,
.data-table td.col-select {
  padding-left: 0;
  padding-right: 0;
  text-align: center;
}
.data-table .col-select input[type='checkbox'] {
  display: block;
  margin: 0 auto;
  accent-color: var(--wb-primary);
  cursor: pointer;
}
/* 已选徽标（工具栏，批量修改入口旁） */
.selection-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--wb-primary);
  border-radius: 999px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 12px;
  font-weight: 600;
}
.selection-badge .chip-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.selection-badge .chip-close:hover {
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
}
.col-actions {
  white-space: nowrap;
}
/* 操作列的「一键复制」下拉不会被 td 的 overflow:hidden 裁掉 */
.data-table td.col-actions {
  overflow: visible;
}
.cell-sub {
  margin-top: 2px;
  overflow: hidden;
  color: var(--wb-text-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cell-empty {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}
/* 开店时间：上一行日期，下一行开店天数（沿用 .cell-sub 的弱化样式） */
.opened-date {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.held-days-line {
  color: var(--wb-accent);
}
.opened-value {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.opened-days {
  margin-left: 6px;
  color: var(--wb-accent);
  font-size: 11px;
}
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.main-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--wb-border);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 13px;
  cursor: pointer;
}
.tab:hover {
  color: var(--wb-text);
}
.tab.active {
  color: var(--wb-primary);
  border-bottom-color: var(--wb-primary);
  font-weight: 600;
}
.tab-badge {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

/* ── 分组视图布局：左栏分组导航 + 右侧内容区 ──────────────────────────── */
.content-split {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}
.content-split.has-nav {
  flex-direction: row;
}
.content-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* 左栏：分组导航（层级树 + 各组店铺数 + 三态整组勾选） */
.group-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 0 0 236px;
  width: 236px;
  min-height: 0;
  padding: 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  overflow: hidden;
}
.nav-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.nav-title {
  color: var(--wb-text);
  font-size: 12.5px;
  font-weight: 600;
}
.nav-meta {
  color: var(--wb-text-muted);
  font-size: 11px;
}
.nav-tools {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.nav-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
/* 导航项本体在递归子组件 GroupNavItem.vue 内，故用 :deep 穿透补样式 */
.group-nav :deep(.nav-item) {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-left: 10px;
  padding-right: 8px;
  border-radius: 5px;
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.group-nav :deep(.nav-item:hover) {
  background: var(--wb-hover);
}
.group-nav :deep(.nav-item.is-active) {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}
.group-nav :deep(.nav-caret) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.group-nav :deep(.nav-caret.is-leaf) {
  cursor: default;
}
.group-nav :deep(.nav-check) {
  flex-shrink: 0;
  margin: 0;
  accent-color: var(--wb-primary);
  cursor: pointer;
}
.group-nav :deep(.nav-label) {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.group-nav :deep(.nav-count) {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
  font-weight: 600;
}
.group-nav :deep(.nav-item.is-active .nav-count) {
  background: var(--wb-surface);
  color: var(--wb-primary);
}
.nav-hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  flex-shrink: 0;
  margin: 0;
  color: var(--wb-warning);
  font-size: 11px;
  line-height: 1.5;
}
.nav-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1 1 auto;
  padding: 16px 8px;
  color: var(--wb-text-muted);
  text-align: center;
}
.nav-empty-title {
  margin: 0;
  color: var(--wb-text);
  font-size: 12.5px;
  font-weight: 600;
}
.nav-empty-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

/* 右栏详情头：分组路径面包屑 + 状态分布 + 整组操作 */
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
  padding: 8px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}
.crumb-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 260px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.crumb:hover {
  border-color: var(--wb-border);
  background: var(--wb-hover);
}
.crumb.is-current {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}
.crumb-dim {
  flex-shrink: 0;
  color: var(--wb-text-muted);
  font-size: 11px;
}
.crumb.is-current .crumb-dim {
  color: var(--wb-primary);
  opacity: 0.75;
}
.crumb-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.crumb-sep {
  color: var(--wb-text-muted);
  font-size: 12px;
}
.crumb-count {
  margin-left: 4px;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.detail-spacer {
  flex: 1 1 auto;
}
.mini-text {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  height: 21px;
  padding: 0 8px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.mini-text:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.group-status {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 1.8;
}
.group-status.tone-success {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.group-status.tone-muted {
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}
.group-status.tone-warning {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.group-status.tone-danger {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

/* 状态 / 平台标签 */
.status-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: nowrap;
}
.status-chip.tone-success {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.status-chip.tone-muted {
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}
.status-chip.tone-warning {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.status-chip.tone-danger {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
.platform-tags {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.platform-tag {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 1px 6px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.platform-more {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

/* 卡片 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-bottom: 4px;
  align-content: start;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}
.card:hover {
  border-color: var(--wb-primary);
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
  font-weight: 600;
}
.card-title .status-chip {
  flex-shrink: 0;
}
/* 卡片视图选择框：不参与压缩，保持可点击尺寸 */
.card-title > input[type='checkbox'] {
  flex-shrink: 0;
  accent-color: var(--wb-primary);
  cursor: pointer;
}
.card-fields {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.card-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.field-key {
  flex-shrink: 0;
  width: 56px;
  color: var(--wb-text-muted);
}
.card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
  font-size: 11.5px;
}
.card-tag {
  display: inline-block;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.card-note {
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--wb-text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 「设置」入口：非页签，点击跳宿主设置中心（带外链标记，样式弱化以示区别） */
.tab-goto-settings {
  color: var(--wb-text-muted);
}
</style>
