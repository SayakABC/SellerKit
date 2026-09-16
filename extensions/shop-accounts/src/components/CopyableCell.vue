<script setup lang="ts">
// 可点击复制的明文字段单元格：有值时可点击复制，无值显示占位符。
import { computed } from 'vue';
import { useShopAccountsStore, type PlainField } from '../store';
import type { ShopAccountItem } from '@/types';

const props = defineProps<{ item: ShopAccountItem; field: PlainField; label: string }>();
const store = useShopAccountsStore();
const value = computed(() => String(props.item[props.field] || '').trim());
</script>

<template>
  <button
    v-if="value"
    class="cell-copy"
    type="button"
    :title="`${value}（点击复制${label}）`"
    @click="store.copyPlain(item, field, label)"
  >
    {{ value }}
  </button>
  <span v-else class="cell-empty">—</span>
</template>

<style scoped>
.cell-copy {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
  /* 列表内一律单行展示，超出以省略号截断（完整内容见 title） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.cell-copy:hover {
  color: var(--wb-primary);
  text-decoration: underline;
}
.cell-empty {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}
</style>
