<script setup lang="ts">
// 密码单元格：5 类敏感字段（店铺 / 邮箱 / 支付宝 / 紫鸟 / ERP）的「已配置」状态 + 复制 / 临时查看。
// 明文只在点击眼睛后临时显现（8 秒自动掩码），复制不显示明文。
import { useShopAccountsStore, SECRET_FIELDS } from '../store';
import IconGlyph from './IconGlyph.vue';
import type { ShopAccountItem, ShopAccountSecretKey } from '@/types';

const props = defineProps<{ item: ShopAccountItem }>();
const store = useShopAccountsStore();

/** 受列宽限制使用简称，title 提供完整名称 */
// Partial：本单元格只展示店铺套的 5 类密码，IMAP 授权码（mailAuthPwd）由收件箱接入流程维护，
// 故不在此处穷举——用 Partial 保证遍历 SECRET_FIELDS 时不会因缺键报错。
const SHORT_LABEL: Partial<Record<ShopAccountSecretKey, string>> = {
  shopPwd: '店铺',
  emailPwd: '邮箱',
  alipayPwd: '支付',
  ziniaoPwd: '紫鸟',
  erpPwd: 'ERP',
};

function configured(field: ShopAccountSecretKey): boolean {
  return props.item.secretKeys.includes(field);
}
</script>

<template>
  <div class="secret-cell">
    <div
      v-for="f in SECRET_FIELDS"
      :key="f.key"
      class="secret-chip"
      :class="{ 'is-empty': !configured(f.key) }"
    >
      <span class="secret-label" :title="f.label">{{ SHORT_LABEL[f.key] }}</span>
      <span v-if="!configured(f.key)" class="secret-none">未设置</span>
      <template v-else>
        <span v-if="store.isRevealed(item.id, f.key)" class="secret-plain" :title="f.label">
          {{ store.revealedValue(item.id, f.key) }}
        </span>
        <span v-else class="secret-mask">••••••</span>
        <button
          class="mini-btn"
          type="button"
          :title="`复制${f.label}`"
          @click="store.copySecret(item, f.key, f.label)"
        >
          <IconGlyph name="copy" :size="12" />
        </button>
        <button
          class="mini-btn"
          type="button"
          :title="
            store.isRevealed(item.id, f.key)
              ? '隐藏'
              : `临时查看${f.label}（8 秒后自动隐藏）`
          "
          @click="store.toggleReveal(item, f.key, f.label)"
        >
          <IconGlyph :name="store.isRevealed(item.id, f.key) ? 'eye-off' : 'eye'" :size="12" />
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.secret-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.secret-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: nowrap;
}
.secret-plain {
  overflow: hidden;
  text-overflow: ellipsis;
}
.secret-label {
  flex-shrink: 0;
  min-width: 30px;
  color: var(--wb-text-muted);
}
.secret-mask {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text-muted);
  letter-spacing: 1px;
  text-overflow: ellipsis;
}
.secret-plain {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--wb-primary);
  font-weight: 600;
}
.secret-none {
  flex: 1 1 auto;
  color: var(--wb-text-muted);
  opacity: 0.7;
}
.secret-chip.is-empty .secret-label {
  opacity: 0.7;
}
.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.mini-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
</style>
