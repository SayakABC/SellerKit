<template>
  <!--
    实时区域：屏幕阅读器要能"听见"提示，光有视觉是不够的。
    aria-live=polite 让提示在读屏当前语句结束后播报，不打断用户正在做的事。
    容器常驻（即便没有 toast）—— 若容器随提示一起挂载，读屏会错过"区域刚出现时"的第一条内容。
  -->
  <div
    class="fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
    role="status"
    aria-live="polite"
    aria-relevant="additions text"
  >
    <transition-group name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="wb-toast"
        :class="
          t.type === 'success'
            ? 'wb-toast--success'
            : t.type === 'error'
              ? 'wb-toast--error'
              : 'wb-toast--info'
        "
      >
        <span
          class="wb-toast__icon"
          v-html="t.type === 'success' ? ICON.success : t.type === 'error' ? ICON.error : ICON.info"
        ></span>
        <span class="wb-toast__text">{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { useToasts } from '@/core/services/toast';

const toasts = useToasts();

/** 类型图标（内联 SVG）。颜色由所在类型的规则决定，跟随 currentColor。 */
const ICON = {
  success:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/></svg>',
  error:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.8v5M12 16.2h.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8h.01"/></svg>',
};
</script>

<!--
  样式取向（2026-10-01 第二轮）：
  原先 success/error/info 是**整块全饱和底色**（大红大绿），同一时刻弹 4 条就是
  屏幕右下角一大片高饱和色块 —— 全屏视觉噪音最大的一处，且"红底"与"危险操作"的语义
  混淆（导入成功也会出现红色块，因为上一次是 error）。
  改为：白底卡片 + 左侧 3px 类型色条 + 类型图标。颜色仍是线索，但由"整块"降为"一条"，
  文字回到 --wb-text（浅底深字，AA 天然达标，也不必再纠结 3.3:1 的前景色问题）。
-->
<style scoped>
.wb-toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  max-width: 360px;
  padding: 10px 14px 11px 11px;
  border: 1px solid var(--wb-border);
  border-left: 3px solid var(--wb-text-muted);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  color: var(--wb-text);
  box-shadow: var(--wb-elev-3);
  font-size: 13px;
  line-height: 1.5;
}
.wb-toast__icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--wb-text-muted);
}
.wb-toast__text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.wb-toast--success {
  border-left-color: var(--wb-success);
}
.wb-toast--success .wb-toast__icon {
  color: var(--wb-success);
}
.wb-toast--error {
  border-left-color: var(--wb-danger);
}
.wb-toast--error .wb-toast__icon {
  color: var(--wb-danger);
}
.wb-toast--info {
  border-left-color: var(--wb-primary);
}
</style>
