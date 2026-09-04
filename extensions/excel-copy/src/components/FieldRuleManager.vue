<template>
  <!-- embedded=false 时为右侧抽屉弹窗；embedded=true 时为设置页内嵌面板 -->
  <div
    :class="
      embedded
        ? 'h-full flex flex-col overflow-hidden'
        : 'fixed inset-0 z-40 flex justify-end'
    "
  >
    <!-- Backdrop（仅抽屉模式） -->
    <div v-if="!embedded" class="absolute inset-0 bg-[var(--wb-overlay)]" @click="close"></div>

    <!-- 容器：抽屉时是浮层面板，嵌入时是普通 flex 面板 -->
    <div
      :class="
        embedded
          ? 'flex-1 flex flex-col min-h-0'
          : 'relative w-[680px] max-w-full bg-[var(--wb-surface)] shadow-xl flex flex-col z-10 rounded-l-xl overflow-hidden'
      "
    >
      <!-- Header（两种模式共用，嵌入模式无关闭按钮） -->
      <div class="px-5 py-4 border-b border-[var(--wb-border)] flex items-center justify-between">
        <h2 class="text-lg font-semibold text-[var(--wb-text)]">字段规则配置</h2>
        <div class="flex items-center gap-2">
          <button
            @click="store.reprocessRules()"
            class="px-3 py-1.5 text-sm bg-[var(--wb-success)] text-white rounded-md hover:opacity-90 transition-colors"
          >
            立即应用
          </button>
          <button
            v-if="!embedded"
            @click="close"
            class="text-[var(--wb-text-muted)] hover:text-[var(--wb-text)] transition-colors"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Rule list (left sidebar) -->
        <div class="w-56 border-r border-[var(--wb-border)] flex flex-col">
          <div class="px-3 py-2 border-b border-[var(--wb-border)]">
            <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">规则列表</p>
          </div>
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="rule in sortedRules"
              :key="rule.id"
              @click="selectRule(rule)"
              :class="[
                'px-3 py-2.5 cursor-pointer text-sm border-l-4 transition-colors group',
                editingId === rule.id
                  ? 'bg-[var(--wb-primary-soft)] border-l-4 border-[var(--wb-primary)]'
                  : 'border-l-4 border-transparent hover:bg-[var(--wb-hover)]',
              ]"
            >
              <div class="flex items-center gap-2">
                <!-- Enable toggle -->
                <label class="relative inline-flex items-center cursor-pointer" @click.stop>
                  <input
                    type="checkbox"
                    :checked="rule.enabled"
                    @change="store.toggleRuleEnabled(rule.id)"
                    class="sr-only peer"
                  />
                  <div class="w-7 h-4 bg-[var(--wb-border)] rounded-full peer peer-checked:bg-[var(--wb-primary)] peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--wb-primary-contrast)] after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
                <span :class="rule.enabled ? 'text-[var(--wb-text)]' : 'text-[var(--wb-text-muted)]'">
                  {{ rule.name }}
                </span>
              </div>
              <div class="flex items-center gap-1 mt-0.5">
                <span class="text-xs px-1.5 py-0.5 rounded" :class="typeBadgeClass(rule.type)">
                  {{ typeLabel(rule.type) }}
                </span>
                <span class="text-xs text-[var(--wb-text-muted)]">#{{ rule.order }}</span>
              </div>
            </div>
          </div>

          <!-- Add button -->
          <div class="px-3 py-2 border-t border-[var(--wb-border)]">
            <button
              @click="createNewRule"
              class="w-full px-2 py-1.5 text-xs text-[var(--wb-primary)] hover:bg-[var(--wb-primary-soft)] rounded-md transition-colors text-left"
            >
              + 新建规则
            </button>
          </div>
        </div>

        <!-- Rule editor (right side) -->
        <div class="flex-1 flex flex-col overflow-hidden">
          <div v-if="editingRule" class="flex-1 flex flex-col overflow-hidden">
            <!-- Scrollable form area -->
            <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <!-- 规则名称 -->
              <div>
                <label class="block text-xs font-medium text-[var(--wb-text-muted)] mb-1">规则名称</label>
                <input
                  v-model="editingRule.name"
                  class="w-full text-sm border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                  placeholder="例如：计算到期时间"
                />
              </div>

              <!-- 目标字段名 -->
              <div>
                <label class="block text-xs font-medium text-[var(--wb-text-muted)] mb-1">
                  目标字段名
                  <span v-if="targetFieldConflict" class="text-[var(--wb-danger)] ml-1">(与原始列名冲突)</span>
                </label>
                <input
                  v-model="editingRule.targetField"
                  class="w-full text-sm border rounded px-2 py-1.5 focus:outline-none focus:ring-1"
                  :class="targetFieldConflict ? 'border-[var(--wb-danger)] focus:ring-[var(--wb-danger)]' : 'border-[var(--wb-border)] focus:ring-[var(--wb-primary)]'"
                  placeholder="例如：到期时间"
                />
              </div>

              <!-- 处理类型 -->
              <div>
                <label class="block text-xs font-medium text-[var(--wb-text-muted)] mb-1">处理类型</label>
                <select
                  v-model="editingRule.type"
                  class="w-full text-sm border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                  @change="onTypeChange"
                >
                  <option value="dateOffset">日期偏移 (dateOffset)</option>
                  <option value="template">模板拼接 (template)</option>
                  <option value="math">数值运算 (math)</option>
                  <option value="jsExpression">自定义表达式 (jsExpression)</option>
                </select>
              </div>

              <!-- dateOffset 配置区 -->
              <div v-if="editingRule.type === 'dateOffset'" class="space-y-3 border-t border-[var(--wb-border)] pt-3">
                <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">日期偏移配置</p>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">源日期字段</label>
                  <select
                    v-model="editingRule.config.sourceField"
                    class="w-full text-sm border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                  >
                    <option value="">— 选择字段 —</option>
                    <option v-for="h in store.headers" :key="h" :value="h">{{ h }}</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">时长/套餐字段</label>
                  <select
                    v-model="editingRule.config.packageField"
                    class="w-full text-sm border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                  >
                    <option value="">— 选择字段 —</option>
                    <option v-for="h in store.headers" :key="h" :value="h">{{ h }}</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">输出格式</label>
                  <input
                    v-model="editingRule.config.outputFormat"
                    class="w-full text-sm border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                    placeholder="YYYY-MM-DD HH:mm"
                  />
                  <p class="text-xs text-[var(--wb-text-muted)] mt-1">支持: YYYY MM DD HH mm ss</p>
                </div>
              </div>

              <!-- template 配置区 -->
              <div v-if="editingRule.type === 'template'" class="space-y-3 border-t border-[var(--wb-border)] pt-3">
                <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">模板拼接配置</p>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">拼接模板</label>
                  <div class="relative">
                    <textarea
                      v-model="editingRule.config.template"
                      class="w-full h-32 text-sm font-mono border border-[var(--wb-border)] rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                      placeholder="例如：{{姓名}}-{{手机号}}"
                    ></textarea>
                    <!-- Insert placeholder button -->
                    <div class="absolute bottom-2 right-2 flex gap-1">
                      <div class="relative" v-for="h in availablePlaceholderFields" :key="h">
                        <button
                          @click="insertPlaceholder(h)"
                          class="px-1.5 py-0.5 text-xs bg-[var(--wb-surface-2)] hover:bg-[var(--wb-primary-soft)] text-[var(--wb-text-muted)] hover:text-[var(--wb-primary)] rounded transition-colors"
                          :title="`插入 {{${h}}}`"
                        >
                          {{ h }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- math 配置区 -->
              <div v-if="editingRule.type === 'math'" class="space-y-3 border-t border-[var(--wb-border)] pt-3">
                <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">数值运算配置</p>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">运算表达式</label>
                  <input
                    v-model="editingRule.config.expression"
                    class="w-full text-sm font-mono border border-[var(--wb-border)] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                    placeholder='例如: ${price} * ${qty}'
                  />
                  <p class="text-xs text-[var(--wb-text-muted)] mt-1">
                    使用 <code class="bg-[var(--wb-surface-2)] px-1 rounded">${字段名}</code> 引用字段，支持 + - * / 和 ()
                  </p>
                </div>
                <!-- Math preview -->
                <div v-if="editingRule.config.expression && store.selectedRecord">
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">预览（选中记录）</label>
                  <div class="bg-[var(--wb-surface-2)] rounded px-3 py-2 text-sm font-mono">
                    {{ getMathPreview(editingRule.config.expression, store.selectedRecord.fields) }}
                  </div>
                </div>
              </div>

              <!-- jsExpression 配置区 -->
              <div v-if="editingRule.type === 'jsExpression'" class="space-y-3 border-t border-[var(--wb-border)] pt-3">
                <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">自定义表达式配置</p>
                <div>
                  <label class="block text-xs text-[var(--wb-text-muted)] mb-1">JavaScript 代码</label>
                  <textarea
                    v-model="editingRule.config.code"
                    class="w-full h-40 text-sm font-mono border border-[var(--wb-border)] rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                    placeholder='例如: fields["price"] > 100 ? "高价" : "低价"'
                  ></textarea>
                  <p class="text-xs text-[var(--wb-warning)] mt-1">
                    ⚠️ 代码中通过 <code class="bg-[var(--wb-warning-soft)] px-1 rounded">fields["字段名"]</code> 访问数据，需返回字符串或数字。
                  </p>
                </div>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="px-5 py-3 border-t border-[var(--wb-border)] flex items-center gap-2">
              <button
                @click="saveCurrentRule"
                :disabled="!canSave"
                class="px-4 py-1.5 text-sm bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] rounded-md hover:bg-[var(--wb-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                保存规则
              </button>
              <button
                @click="deleteCurrentRule"
                class="px-4 py-1.5 text-sm text-[var(--wb-danger)] border border-[var(--wb-border)] hover:bg-[var(--wb-danger-soft)] hover:border-[var(--wb-danger)] rounded-md transition-colors"
              >
                删除规则
              </button>
              <div class="flex-1"></div>
              <span class="text-xs text-[var(--wb-text-muted)]">
                {{ store.headers.length }} 个原始字段 · {{ store.derivedHeaders.length }} 个衍生字段
              </span>
            </div>
          </div>

          <!-- No selection -->
          <div v-else class="flex-1 flex items-center justify-center text-[var(--wb-text-muted)] text-sm">
            选择左侧规则进行编辑，或点击"+ 新建规则"
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useExcelCopyStore } from '../store';
import type { ProcessingRule } from '@/types';
import { toast } from '@/core/services/toast';

defineProps<{ embedded?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useExcelCopyStore();

const editingId = ref<string | null>(null);
const editingRule = ref<ProcessingRule | null>(null);

function close() {
  store.showRuleManager = false;
  emit('close');
}

/** 排序后的规则列表 */
const sortedRules = computed(() => {
  return [...store.processingRules].sort((a, b) => a.order - b.order);
});

/** 可用占位符字段 = 原始 + 衍生 */
const availablePlaceholderFields = computed(() => {
  return [...store.headers, ...store.derivedHeaders];
});

/** 目标字段名是否与原始列冲突 */
const targetFieldConflict = computed(() => {
  if (!editingRule.value) return false;
  return store.headers.includes(editingRule.value.targetField);
});

/** 是否可以保存 */
const canSave = computed(() => {
  if (!editingRule.value) return false;
  if (!editingRule.value.name.trim()) return false;
  if (!editingRule.value.targetField.trim()) return false;
  return true;
});

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    dateOffset: '日期偏移',
    template: '模板拼接',
    math: '数值运算',
    jsExpression: '自定义JS',
  };
  return labels[type] || type;
}

function typeBadgeClass(type: string): string {
  const classes: Record<string, string> = {
    dateOffset: 'bg-[var(--wb-accent-soft)] text-[var(--wb-accent)]',
    template: 'bg-[var(--wb-success-soft)] text-[var(--wb-success)]',
    math: 'bg-[var(--wb-warning-soft)] text-[var(--wb-warning)]',
    jsExpression: 'bg-[var(--wb-danger-soft)] text-[var(--wb-danger)]',
  };
  return classes[type] || 'bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]';
}

/** 创建空规则配置 */
function createEmptyConfig(type: ProcessingRule['type']): ProcessingRule['config'] {
  return { sourceField: '', packageField: '', outputFormat: 'YYYY-MM-DD HH:mm', template: '', expression: '', code: '' };
}

function createNewRule() {
  const id = `rule_${Date.now()}`;
  const maxOrder = store.processingRules.reduce((max, r) => Math.max(max, r.order), 0);
  const newRule: ProcessingRule = {
    id,
    name: '新规则',
    enabled: true,
    targetField: '',
    type: 'dateOffset',
    order: maxOrder + 1,
    config: createEmptyConfig('dateOffset'),
  };
  store.addRule(newRule);
  selectRule(newRule);
}

function selectRule(rule: ProcessingRule) {
  editingId.value = rule.id;
  // 深拷贝以允许取消
  editingRule.value = JSON.parse(JSON.stringify(rule));
}

function onTypeChange() {
  if (editingRule.value) {
    // 切换类型时重置配置
    editingRule.value.config = createEmptyConfig(editingRule.value.type);
  }
}

function saveCurrentRule() {
  if (!editingRule.value || !canSave.value) return;
  store.updateRule(editingRule.value.id, {
    name: editingRule.value.name,
    targetField: editingRule.value.targetField,
    type: editingRule.value.type,
    config: editingRule.value.config,
  });
  toast('规则已保存', 'success');
}

function deleteCurrentRule() {
  if (!editingRule.value) return;
  store.removeRule(editingRule.value.id);
  editingId.value = null;
  editingRule.value = null;
  toast('规则已删除', 'info');
}

function insertPlaceholder(field: string) {
  if (!editingRule.value) return;
  const current = editingRule.value.config.template || '';
  editingRule.value.config.template = current + `{{${field}}}`;
}

/** 数学表达式预览 */
function getMathPreview(expression: string, fields: Record<string, string>): string {
  try {
    const resolved = expression.replace(/\$\{(.+?)\}/g, (_m, key: string) => {
      const val = fields[key.trim()];
      return val !== undefined ? val : `?${key}?`;
    });
    return resolved;
  } catch {
    return '表达式错误';
  }
}
</script>
