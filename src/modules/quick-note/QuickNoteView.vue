<template>
  <div class="wb-page qn-view">
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">便签</h1>
        <p class="wb-head__desc">随手记点东西，⌘S 或点「保存便签」存下来</p>
      </div>
    </header>

    <section class="wb-panel qn-compose">
      <textarea
        v-model="draft"
        rows="4"
        placeholder="写点什么…⌘S 或点击保存"
        class="qn-textarea"
        @keydown.meta.s="onSaveKey"
      ></textarea>
      <div class="wb-panel__foot qn-compose__foot">
        <button class="wb-btn wb-btn--primary" @click="save">保存便签</button>
      </div>
    </section>

    <div v-if="!notes.length" class="wb-empty qn-empty">
      <span class="wb-empty__icon" v-html="ICON" />
      <p class="wb-empty__title">还没有便签</p>
      <p class="wb-empty__desc">在上面写点什么，保存后会一条条排在这里。</p>
    </div>

    <ul v-else class="qn-list">
      <li v-for="note in notes" :key="note.id" class="qn-item">
        <p class="qn-item__text">{{ note.text }}</p>
        <!-- 删除原先只在 group-hover 时可见：键盘 Tab 到它、或触控板/触屏上没有 hover，
             就完全看不见这个按钮（仍可点击，等于"藏了一个能毁数据的控件"）。
             现在常驻显示（低权重灰字），悬浮转为危险色 —— 可见性不再依赖指针。 -->
        <button
          class="qn-del"
          :aria-label="`删除便签：${note.text.slice(0, 20)}`"
          @click="remove(note.id)"
        >
          删除
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';

interface Note {
  id: string;
  text: string;
  createdAt: number;
}

/** 空态图标（内联 SVG） */
const ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9.5 13h5M9.5 17h5"/></svg>';

// 模块私有命名空间持久化（与 excel-copy 互不污染）
const storage = useModuleStorage<{ notes: Note[] }>('quick-note');

const draft = ref('');
const notes = ref<Note[]>([]);

onMounted(async () => {
  try {
    const data = await storage.load();
    notes.value = data?.notes ?? [];
  } catch {
    notes.value = [];
  }
});

async function save() {
  const text = draft.value.trim();
  if (!text) {
    toast('便签内容不能为空', 'error');
    return;
  }
  notes.value = [{ id: Date.now().toString(), text, createdAt: Date.now() }, ...notes.value];
  await storage.save({ notes: notes.value });
  draft.value = '';
  toast('已保存', 'success');
}

async function remove(id: string) {
  notes.value = notes.value.filter((n) => n.id !== id);
  await storage.save({ notes: notes.value });
  toast('已删除', 'info');
}

function onSaveKey(e: KeyboardEvent) {
  e.preventDefault();
  save();
}
</script>

<style scoped>
/* 页面外壳由全局 .wb-page 提供；正文列限宽，长便签不会横跨整屏（原先靠 max-w-2xl 居中，
   页面标题与列表的左右边界对不齐，读起来是"两个块各居各的"）。 */
.qn-view {
  max-width: 840px;
}

.qn-compose {
  overflow: visible;
}

.qn-textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  padding: 12px 14px;
  border: 0;
  border-radius: var(--wb-radius-lg) var(--wb-radius-lg) 0 0;
  background: transparent;
  color: var(--wb-text);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.7;
  resize: vertical;
}
.qn-textarea:focus-visible {
  outline: 2px solid var(--wb-focus);
  outline-offset: -2px;
}

.qn-compose__foot {
  display: flex;
  justify-content: flex-end;
  background: var(--wb-surface-2);
}

.qn-empty {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.qn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.qn-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  transition: border-color 0.15s ease;
}
.qn-item:hover {
  border-color: var(--wb-border-strong);
}

.qn-item__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--wb-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.qn-del {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.qn-del:hover {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
</style>
