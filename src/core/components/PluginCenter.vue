<template>
  <div class="flex-1 min-h-0 flex flex-col rounded-xl border border-[var(--wb-border)] overflow-hidden bg-[var(--wb-surface)]">
    <!-- 工具行 -->
    <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--wb-border)] flex-wrap">
      <span class="text-xs text-[var(--wb-text-muted)]">
        外置插件目录：
        <span class="font-mono">{{ pluginDir || FALLBACK_DIR }}</span>
        （示例：npm run plugins:demo:install）
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
              v-if="p.source === 'external'"
              class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]"
              title="Worker 沙箱：插件代码在独立 Worker 中执行（与宿主不共享运行环境，无法直达 window.electronAPI/DOM/localStorage）；能力调用经主线程权限门逐次判定"
            >
              Worker 沙箱
            </span>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded"
              :class="
                p.state === 'active'
                  ? 'bg-[color-mix(in_srgb,var(--wb-success)_15%,transparent)] text-[var(--wb-success)]'
                  : 'bg-[var(--wb-hover)] text-[var(--wb-text-muted)]'
              "
            >
              {{ stateLabel(p.state) }}
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
            @click="toggleBuiltin(p)"
          >
            {{ busyId === p.id ? '…' : p.state === 'disabled' ? '启用' : '停用' }}
          </button>
        </div>
        <div v-if="p.source === 'external'" class="flex-shrink-0 flex items-center gap-2">
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
        后点击「重新扫描」，或用 <span class="font-mono">npm run plugins:demo:install</span> 安装示例插件。
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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { toast } from '../services/toast';
import type { BuiltinPluginManager, PluginOverview } from '../plugin';
import type { AuditEntry } from '../plugin/security';

const props = defineProps<{ manager: BuiltinPluginManager }>();

const FALLBACK_DIR = '~/Library/Application Support/seller-kit/plugins';

const rows = ref<PluginOverview[]>([]);
const denied = ref<AuditEntry[]>([]);
const busyId = ref('');
const confirmId = ref('');
const scanning = ref(false);
const pluginDir = ref('');

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

/** 来源徽标三态：外置(L2 Worker 沙箱) / 随宿主分发插件包(extensions/，L0) / 纯宿主模块(src/modules，L0) */
function badgeFor(p: PluginOverview): { label: string; cls: string; tip: string } {
  if (p.source === 'external') {
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

/** 停用/启用内建插件（运行时按包启停：侧栏/⌘K/设置分类经 AppShell onStateChange 即时刷新并持久化） */
async function toggleBuiltin(p: PluginOverview) {
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
