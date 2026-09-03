<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--wb-overlay)]"
    @click.self="$emit('close')"
  >
    <div class="wb-card w-[980px] max-w-[94vw] h-[86vh] max-h-[86vh] shadow-xl flex flex-col">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-[var(--wb-border)] flex-shrink-0">
        <h2 class="text-base font-semibold text-[var(--wb-text)]">设置</h2>
        <button
          class="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] transition-colors"
          title="关闭"
          @click="$emit('close')"
          v-html="closeIcon"
        ></button>
      </div>

      <!-- 主体：左右布局（WorkBuddy 设置页风格） -->
      <div class="flex-1 flex min-h-0">
        <!-- 左侧分类导航 -->
        <aside class="w-48 flex-shrink-0 border-r border-[var(--wb-border)] py-3 overflow-y-auto">
          <div
            v-for="cat in categories"
            :key="cat.id"
            @click="activeCategory = cat.id"
            :class="[
              'mx-2 flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors border-l-2',
              activeCategory === cat.id
                ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] border-l-[var(--wb-primary)] font-medium'
                : 'border-l-transparent text-[var(--wb-text)] hover:bg-[var(--wb-hover)]',
            ]"
          >
            <span v-html="iconSvg(cat.icon)"></span>
            <span>{{ cat.name }}</span>
          </div>
        </aside>

        <!-- 右侧内容区 -->
        <div class="flex-1 min-w-0 flex flex-col">
          <!-- 通用 -->
          <div v-if="activeCategory === 'general'" class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <!-- 关于 -->
            <section>
              <div class="flex items-center gap-3 mb-2">
                <div
                  class="w-9 h-9 rounded-lg bg-[var(--wb-primary)] flex items-center justify-center text-[var(--wb-primary-contrast)] text-sm font-bold"
                >
                  SK
                </div>
                <div>
                  <div class="text-sm font-medium text-[var(--wb-text)]">SellerKit</div>
                  <div class="text-xs text-[var(--wb-text-muted)]">桌面工具 · v{{ appVersion }}</div>
                </div>
              </div>
              <p class="text-xs leading-relaxed text-[var(--wb-text-muted)]">
                导入 Excel 数据，按模板生成文本并一键复制，智能跟踪每条记录的使用状态。
                支持业务模块按需插拔与构建期裁剪。
              </p>
            </section>

            <!-- 已启用模块 -->
            <section>
              <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">已启用模块</div>
              <div class="space-y-1.5">
                <div
                  v-for="m in modules"
                  :key="m.id"
                  class="flex items-center gap-3 rounded-lg px-3 py-2 bg-[var(--wb-surface-2)] border border-[var(--wb-border)]"
                >
                  <span class="text-[var(--wb-primary)]" v-html="iconSvg(m.icon)"></span>
                  <div class="min-w-0">
                    <div class="text-sm text-[var(--wb-text)] truncate">{{ m.name }}</div>
                    <div class="text-xs text-[var(--wb-text-muted)] truncate">{{ m.id }}</div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 数据迁移 -->
            <section>
              <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">数据迁移</div>
              <div class="rounded-lg px-3 py-2.5 bg-[var(--wb-surface-2)] border border-[var(--wb-border)]">
                <p class="text-xs text-[var(--wb-text-muted)] leading-relaxed mb-2">
                  换电脑时把本机的产品库、订单识别结果、图片缓存与设置完整迁移到另一台电脑：先在本机
                  「导出备份」生成备份文件夹并拷贝到新电脑，再在新电脑「导入备份」，应用会自动重启。
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    @click="exportBackup"
                    :disabled="busy"
                    class="px-3 py-1.5 text-xs text-[var(--wb-primary-contrast)] bg-[var(--wb-primary)] hover:bg-[var(--wb-primary-hover)] rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    导出备份
                  </button>
                  <button
                    @click="importBackup"
                    :disabled="busy"
                    class="px-3 py-1.5 text-xs text-[var(--wb-text)] border border-[var(--wb-border)] hover:bg-[var(--wb-hover)] rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    导入备份
                  </button>
                  <button
                    @click="openDataDir"
                    :disabled="busy"
                    class="px-3 py-1.5 text-xs text-[var(--wb-text)] border border-[var(--wb-border)] hover:bg-[var(--wb-hover)] rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    打开数据目录
                  </button>
                  <span v-if="busy" class="text-xs text-[var(--wb-text-muted)]">处理中…</span>
                </div>
              </div>
            </section>

            <!-- 恢复出厂设置 -->
            <section>
              <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">危险操作</div>
              <div class="rounded-lg px-3 py-2.5 bg-[var(--wb-surface-2)] border border-[var(--wb-border)]">
                <p class="text-xs text-[var(--wb-text-muted)] mb-2">
                  清空所有已保存的设置与记录状态，恢复初始状态。
                </p>
                <button
                  @click="factoryReset"
                  class="px-3 py-1.5 text-xs text-[var(--wb-danger)] border border-[var(--wb-danger)] hover:bg-[var(--wb-danger-soft)] rounded-md transition-colors"
                >
                  恢复出厂设置
                </button>
              </div>
            </section>
          </div>

          <!-- 订单归类 -->
          <div v-else-if="activeCategory === 'order-insight'" class="flex-1 min-h-0 p-4">
            <div class="h-full rounded-xl border border-[var(--wb-border)] overflow-hidden bg-[var(--wb-surface)]">
              <EngineSettings :embedded="true" />
            </div>
          </div>

          <!-- TV模版 -->
          <div v-else-if="activeCategory === 'excel'" class="flex-1 flex flex-col min-h-0 p-4">
            <!-- 二级 Tab：模板配置 / 字段规则 -->
            <div class="flex items-center gap-1 mb-3 flex-shrink-0">
              <button
                v-for="tab in excelTabs"
                :key="tab.value"
                @click="excelTab = tab.value"
                :class="[
                  'px-3 py-1.5 text-sm rounded-md transition-colors',
                  excelTab === tab.value
                    ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] font-medium'
                    : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]',
                ]"
              >
                {{ tab.label }}
              </button>
            </div>
            <!-- 内嵌面板 -->
            <div class="flex-1 min-h-0 rounded-xl border border-[var(--wb-border)] overflow-hidden bg-[var(--wb-surface)]">
              <TemplateManager v-if="excelTab === 'template'" :embedded="true" />
              <FieldRuleManager v-else-if="excelTab === 'rules'" :embedded="true" />
              <ColumnSelector v-else :embedded="true" />
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { ModuleMeta } from '../types';
import { toast } from '../services/toast';
import { ipc } from '../services/ipc';
import TemplateManager from '@/modules/excel-copy/components/TemplateManager.vue';
import FieldRuleManager from '@/modules/excel-copy/components/FieldRuleManager.vue';
import ColumnSelector from '@/modules/excel-copy/components/ColumnSelector.vue';
import EngineSettings from '@/modules/order-insight/components/EngineSettings.vue';

const props = defineProps<{
  modules: ModuleMeta[];
  initialCategory?: string;
  initialTab?: string;
}>();
defineEmits<{ close: [] }>();

const categories = [
  { id: 'general', name: '通用', icon: 'box' },
  { id: 'excel', name: 'TV模版', icon: 'table' },
  { id: 'order-insight', name: '订单归类', icon: 'sparkles' },
];
const activeCategory = ref(
  props.initialCategory && categories.some((c) => c.id === props.initialCategory)
    ? props.initialCategory
    : 'general',
);

const excelTabs = [
  { label: '模板配置', value: 'template' as const },
  { label: '字段规则', value: 'rules' as const },
  { label: '显示列', value: 'columns' as const },
];
const excelTab = ref<'template' | 'rules' | 'columns'>(
  props.initialTab === 'rules' || props.initialTab === 'columns' ? props.initialTab : 'template',
);

const appVersion = ref('');

onMounted(async () => {
  try {
    const res = await ipc.getAppVersion();
    if (res.success && res.data) appVersion.value = res.data;
  } catch {
    /* 忽略 */
  }
});

async function factoryReset() {
  if (!confirm('确定要恢复出厂设置吗？所有已保存的数据将被清空。')) return;
  const res = await ipc.resetStore();
  if (res.success) {
    toast.success('已恢复出厂设置');
    setTimeout(() => window.location.reload(), 600);
  } else {
    toast.error(`恢复失败: ${res.error || '未知错误'}`);
  }
}

/** 数据备份/恢复（换机迁移） */
const busy = ref(false);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function exportBackup() {
  const dir = await ipc.selectDirectory();
  if (!dir.success || !dir.data) return;
  busy.value = true;
  try {
    const res = await ipc.backupExport(dir.data);
    if (!res.success || !res.data) {
      toast.error(`导出失败: ${res.error || '未知错误'}`);
      return;
    }
    const d = res.data;
    toast.success(
      `备份已导出到 ${d.dir}：数据库 ${fmtBytes(d.dbBytes)}、图片 ${d.imageCount} 个 (${fmtBytes(d.imageBytes)})${d.hasConfig ? '、含设置' : ''}`,
    );
  } catch (e) {
    toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`);
  } finally {
    busy.value = false;
  }
}

async function importBackup() {
  const dir = await ipc.selectDirectory();
  if (!dir.success || !dir.data) return;
  if (!confirm('导入备份将覆盖当前电脑的全部数据（导入前会自动把现有数据备份到数据目录，可找回）。确定继续？')) return;
  busy.value = true;
  try {
    const res = await ipc.backupImport(dir.data);
    if (!res.success) {
      toast.error(`导入失败: ${res.error || '未知错误'}`);
      return;
    }
    toast.success('已导入备份，应用正在重启…');
  } catch (e) {
    toast.error(`导入失败: ${e instanceof Error ? e.message : '未知错误'}`);
  } finally {
    busy.value = false;
  }
}

async function openDataDir() {
  const res = await ipc.openDataDir();
  if (!res.success) toast.error(`打开失败: ${res.error || '未知错误'}`);
}

const closeIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function iconSvg(icon?: string): string {
  const map: Record<string, string> = {
    table:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></svg>',
    tool:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 7a3 3 0 10-4 4l-6 6 2 2 6-6a3 3 0 004-4l-2 2-2-2 2-2z"/></svg>',
    box:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v6c0 4-3 7-8 8-5-1-8-4-8-8V7z"/></svg>',
    chart:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    sparkles:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
    note:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h11l4 4v12H5z"/><path d="M15 4v5h5M9 13h6M9 17h6"/></svg>',
  };
  return map[icon || ''] || map.box;
}
</script>
