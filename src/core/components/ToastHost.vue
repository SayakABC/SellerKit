<template>
  <div class="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
    <transition-group name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="[
          'px-4 py-2.5 rounded-lg shadow-lg text-sm max-w-xs',
          t.type === 'success'
            ? 'bg-[var(--wb-success)] text-white'
            : t.type === 'error'
              ? 'bg-[var(--wb-danger)] text-white'
              : 'bg-[var(--wb-text)] text-[var(--wb-surface)]',
        ]"
      >
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { useToasts } from '@/core/services/toast';
const toasts = useToasts();
</script>
