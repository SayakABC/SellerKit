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
          : 'relative w-[600px] max-w-full bg-[var(--wb-surface)] shadow-xl flex flex-col z-10 rounded-l-xl overflow-hidden'
      "
    >
      <!-- Header（仅抽屉模式） -->
      <div
        v-if="!embedded"
        class="px-5 py-4 border-b border-[var(--wb-border)] flex items-center justify-between"
      >
        <h2 class="text-lg font-semibold text-[var(--wb-text)]">模板配置</h2>
        <button
          @click="close"
          class="text-[var(--wb-text-muted)] hover:text-[var(--wb-text)] transition-colors"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body（两种模式共用） -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Template list -->
        <div class="w-48 border-r border-[var(--wb-border)] flex flex-col">
          <div class="px-3 py-2 border-b border-[var(--wb-border)]">
            <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">模板列表</p>
          </div>
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="tpl in store.templateConfigs"
              :key="tpl.id"
              @click="selectTemplate(tpl)"
              :class="[
                'px-3 py-2.5 cursor-pointer text-sm border-l-3 transition-colors',
                editingId === tpl.id
                  ? 'bg-[var(--wb-primary-soft)] border-l-4 border-[var(--wb-primary)] text-[var(--wb-primary)]'
                  : 'border-l-4 border-transparent hover:bg-[var(--wb-hover)] text-[var(--wb-text)]',
                tpl.id === store.activeTemplateId ? 'font-medium' : '',
              ]"
            >
              <div class="flex items-center gap-1.5">
                <span class="truncate">{{ tpl.name }}</span>
                <span
                  v-if="tpl.id === store.activeTemplateId"
                  class="flex-shrink-0 w-1.5 h-1.5 bg-[var(--wb-primary)] rounded-full"
                ></span>
              </div>
              <p v-if="!tpl.content" class="text-xs text-[var(--wb-danger)] mt-0.5">文件丢失</p>
            </div>
          </div>

          <!-- Add buttons -->
          <div class="px-3 py-2 border-t border-[var(--wb-border)] space-y-1.5">
            <button
              @click="store.importTemplateFile()"
              class="w-full px-2 py-1.5 text-xs text-left text-[var(--wb-primary)] hover:bg-[var(--wb-primary-soft)] rounded-md transition-colors"
            >
              + 导入模板文件
            </button>
            <button
              @click="createBlankTemplate"
              class="w-full px-2 py-1.5 text-xs text-left text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] rounded-md transition-colors"
            >
              + 新建空白模板
            </button>
          </div>
        </div>

        <!-- Template editor -->
        <div class="flex-1 flex flex-col overflow-hidden">
          <div v-if="editingTemplate" class="flex-1 flex flex-col overflow-hidden">
            <!-- Template name -->
            <div class="px-4 py-3 border-b border-[var(--wb-border)] flex items-center gap-3">
              <input
                v-model="editingTemplate.name"
                class="flex-1 text-sm font-medium border border-[var(--wb-border)] rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--wb-primary)]"
                placeholder="模板名称"
              />
              <button
                v-if="editingTemplate.id !== store.activeTemplateId"
                @click="store.setActiveTemplate(editingTemplate.id)"
                class="px-3 py-1 text-xs bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] rounded-md hover:bg-[var(--wb-primary-hover)] transition-colors"
              >
                设为当前
              </button>
              <span v-else class="px-3 py-1 text-xs bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] rounded">当前使用</span>
            </div>

            <!-- Content editor -->
            <div class="flex-1 overflow-hidden relative">
              <textarea
                v-model="editingTemplate.content"
                class="w-full h-full p-4 text-sm font-mono resize-none focus:outline-none"
                placeholder="模板内容，使用 {{列名}} 作为占位符"
                @input="onTemplateInput"
              ></textarea>

              <!-- Autocomplete dropdown -->
              <div
                v-if="showAutocomplete"
                class="absolute z-10 bg-[var(--wb-surface)] border border-[var(--wb-border)] rounded-md shadow-lg max-h-40 overflow-y-auto"
                :style="autocompleteStyle"
              >
                <div
                  v-for="header in autocompleteOptions"
                  :key="header"
                  @click="insertPlaceholder(header)"
                  class="px-3 py-1.5 text-sm cursor-pointer hover:bg-[var(--wb-primary-soft)] text-[var(--wb-text)]"
                >
                  {{ header }}
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="px-4 py-3 border-t border-[var(--wb-border)] flex items-center gap-2">
              <button
                @click="saveCurrentTemplate"
                class="px-4 py-1.5 text-sm bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] rounded-md hover:bg-[var(--wb-primary-hover)] transition-colors"
              >
                保存
              </button>
              <button
                v-if="editingTemplate.id !== 'default'"
                @click="deleteTemplate(editingTemplate.id)"
                class="px-4 py-1.5 text-sm text-[var(--wb-danger)] border border-[var(--wb-border)] hover:bg-[var(--wb-danger-soft)] hover:border-[var(--wb-danger)] rounded-md transition-colors"
              >
                删除
              </button>
              <div class="flex-1"></div>
              <span class="text-xs text-[var(--wb-text-muted)]" v-pre>
                占位符: {{列名}}
              </span>
            </div>
          </div>

          <div v-else class="flex-1 flex items-center justify-center text-[var(--wb-text-muted)] text-sm">
            选择左侧模板进行编辑
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useExcelCopyStore } from '../store';
import type { TemplateConfig } from '../../../types';

const props = defineProps<{ embedded?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useExcelCopyStore();
const editingId = ref<string | null>(null);
const editingTemplate = ref<TemplateConfig | null>(null);
const showAutocomplete = ref(false);
const autocompleteStyle = ref({});

const autocompleteOptions = computed(() => {
  // 原始字段 + 衍生字段
  return [...store.headers, ...store.derivedHeaders];
});

function close() {
  store.showTemplateManager = false;
  emit('close');
}

function selectTemplate(tpl: TemplateConfig) {
  editingId.value = tpl.id;
  editingTemplate.value = { ...tpl };
}

function createBlankTemplate() {
  const id = `tpl_${Date.now()}`;
  const newTpl: TemplateConfig = {
    id,
    name: '新模板',
    filePath: '',
    content: '',
  };
  store.addTemplate(newTpl);
  selectTemplate(newTpl);
}

function deleteTemplate(id: string) {
  store.removeTemplate(id);
  editingId.value = null;
  editingTemplate.value = null;
}

function saveCurrentTemplate() {
  if (editingTemplate.value) {
    store.updateTemplate(editingTemplate.value.id, {
      name: editingTemplate.value.name,
      content: editingTemplate.value.content,
      isBuiltIn: false,
    });
    store.saveTemplateToFile(editingTemplate.value);
  }
}

function onTemplateInput(e: Event) {
  const textarea = e.target as HTMLTextAreaElement;
  const value = textarea.value;
  const pos = textarea.selectionStart;

  // Check if user typed {{
  if (value.substring(pos - 2, pos) === '{{') {
    showAutocomplete.value = true;
    // Position the autocomplete near cursor
    const lineHeight = 20;
    const charWidth = 8;
    const lines = value.substring(0, pos).split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length;
    autocompleteStyle.value = {
      top: `${(line - 1) * lineHeight + 10}px`,
      left: `${col * charWidth + 16}px`,
    };
  } else {
    showAutocomplete.value = false;
  }
}

function insertPlaceholder(header: string) {
  if (editingTemplate.value) {
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    if (textarea) {
      const pos = textarea.selectionStart;
      const before = editingTemplate.value.content.substring(0, pos);
      const after = editingTemplate.value.content.substring(pos);
      const insertText = `${header}}}`;
      editingTemplate.value.content = before + insertText + after;
    }
    showAutocomplete.value = false;
  }
}
</script>
