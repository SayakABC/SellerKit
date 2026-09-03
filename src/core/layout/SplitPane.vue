<template>
  <div class="flex-1 flex min-h-0 overflow-hidden">
    <div :style="{ flex: '0 0 ' + leftRatio + '%' }" class="min-w-0 flex flex-col">
      <slot name="left" />
    </div>
    <!-- 列表与预览之间用画布色分隔（颜色深浅区分，无边框感） -->
    <div class="w-px bg-[var(--wb-bg)] flex-shrink-0"></div>
    <div class="flex-1 min-w-0 flex flex-col">
      <slot name="right" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ leftRatio?: number }>(), { leftRatio: 60 });
</script>
