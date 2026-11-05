<script setup lang="ts">
// 轻量内联图标：24×24 stroke 路径，颜色继承 currentColor（自动跟随主题令牌）。
import { computed } from 'vue';
import { ICON_PATHS, type IconName } from '@/core/components/icons';

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 14 });

const paths = computed(() => ICON_PATHS[props.name] || []);
</script>

<template>
  <svg
    class="icon-glyph"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon-glyph {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
