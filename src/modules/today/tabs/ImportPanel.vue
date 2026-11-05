<template>
  <!-- 兼容壳：2026-11-02「导入订单」页签并进「待发货」后，真正的界面与逻辑都在
       `ExcelImportSection.vue`（本文件不再被页签引用）。
       保留它只为一个原因：外部/历史引用导入本文件时不至于断裂；**不要在这里再写一份实现**。 -->
  <ExcelImportSection />
</template>

<script setup lang="ts">
import ExcelImportSection from './ExcelImportSection.vue';
</script>
