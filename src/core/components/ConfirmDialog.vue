<template>
  <div class="wb-mask" @click.self="$emit('close')">
    <div class="wb-dialog wb-dialog--sm" role="dialog" aria-modal="true" data-act="confirm-dialog">
      <div class="wb-dialog__head">{{ title }}</div>
      <div class="wb-dialog__body">
        <slot />
      </div>
      <div class="wb-dialog__foot">
        <button
          v-if="extraText"
          class="wb-btn wb-dialog__extra"
          type="button"
          data-act="confirm-extra"
          :disabled="busy"
          @click="$emit('extra')"
        >
          {{ extraText }}
        </button>
        <button class="wb-btn" type="button" data-act="confirm-cancel" :disabled="busy" @click="$emit('close')">
          取消
        </button>
        <button
          class="wb-btn"
          :class="danger ? 'wb-btn--danger' : 'wb-btn--primary'"
          type="button"
          data-act="confirm-ok"
          :disabled="busy"
          @click="$emit('confirm')"
        >
          {{ busy ? busyText : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 危险操作确认弹层（删除产品 / 删除供应商 / 删除商品 / 删除拿货单…共用）。
//
// 抽成一个的原因：原来这几个确认框分散在四个组件里各拼一遍（结构一样、文案不同），
// 而**确认框是必须说清"后果"的地方** —— 抄四遍必然有一处漏掉关键警告。
// 内容交给调用方（slot），共同的部分只有"取消 / 确认"这两条出口。
//
// 2026-10-05 从 `src/modules/goods/components/` 上提到 shell 级：第二处消费者出现
// （「发货台 › 拿货」页签要确认提交 / 删除拿货单）。按项目既有约定 —— **同一角色只写一份**
// （同 `.wb-btn` / `.wb-seg` 的教训），而不是在第二个模块里再抄一份。
// 样式全部来自全局 `.wb-mask` / `.wb-dialog*`，本组件只有结构。
withDefaults(
  defineProps<{
    title: string;
    confirmText?: string;
    busyText?: string;
    busy?: boolean;
    /** 不可逆操作用危险色（红）——普通确认仍是主色，避免"到处都红" */
    danger?: boolean;
    /**
     * 第三个出口（次要、**非破坏**方向），排在「取消」左边。
     *
     * 2026-10-25 加：SKU 删除确认里，用户经常是"误点把整列取消了"而不是真的要删 ——
     * 只给"取消 / 删除"，他只能整轮重来。给一条"把这几格加回来"才救得回来。
     * 默认不传 ⇒ 其它调用方的两按钮外观不变。
     */
    extraText?: string;
  }>(),
  { confirmText: '确认', busyText: '处理中…', busy: false, danger: true, extraText: '' }
);

defineEmits<{ close: []; confirm: []; extra: [] }>();
</script>

<style scoped>
.wb-dialog__body :deep(p) {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.7;
}
.wb-dialog__body :deep(p:last-child) {
  margin-bottom: 0;
}
/* 第三个出口靠左：它和「删除」不是同一类决定，别让人在相邻位置误点 */
.wb-dialog__extra {
  margin-right: auto;
}
</style>
