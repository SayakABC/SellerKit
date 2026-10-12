<template>
  <section class="wb-panel gd-fix">
    <div class="wb-panel__head">
      <span>SKU 克重</span>
      <span v-if="product" class="wb-muted">
        {{ product.code || product.name }}
      </span>
      <span v-else class="wb-muted">← 在上面选一个款</span>
      <span class="gd-fix__count wb-muted" v-if="product && variants.length">
        {{ variants.length }} 个 SKU · 缺 {{ missingCount }} 个
      </span>
    </div>

    <div class="wb-panel__body">
      <table class="wb-table gd-fix__table" data-act="variant-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>编码</th>
            <th class="wb-num gd-fix__w">克重(g)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in variants" :key="v.id" :data-variant-id="v.id">
            <td>{{ v.name }}</td>
            <td class="wb-mono wb-muted">{{ v.code || '—' }}</td>
            <td class="wb-num">
              <input
                class="wb-input wb-input--sm gd-fix__input"
                data-act="weight"
                type="number"
                min="0"
                step="1"
                :value="v.weightG || ''"
                :disabled="saving"
                :aria-label="`${v.name} 克重`"
                @change="onChange(v, ($event.target as HTMLInputElement).value)"
              />
            </td>
          </tr>
          <tr v-if="product && !variants.length">
            <td colspan="3" class="gd-fix__empty">
              这款还没有 SKU —— 点右边「编辑」，用颜色 × 尺码批量生成
            </td>
          </tr>
          <tr v-if="!product">
            <td colspan="3" class="gd-fix__empty">
              选一个款后，它的 SKU 克重会出现在这里；克重是运费与利润的输入，缺一个就少算一环
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="wb-panel__foot gd-fix__foot">
      <!-- 保存回执。为什么不只靠 toast：改动是逐行落库的，连改几行后需要一处
           "刚才那些真的存进去了"的凭据，toast 一闪而过留不住。 -->
      <p v-if="savedHint" class="gd-fix__saved" data-act="saved">{{ savedHint }}</p>
      <p v-else class="gd-fix__tip">
        改完自动保存（失焦即落库）。克重走全量提交，所以每行都会把现有字段一起送回，不会丢颜色尺码。
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
// 补克重速修面板：左边选款 → 这里逐行填克重，失焦即落库。
//
// 存在的理由：克重是**所有运费试算的输入**（按订单试算 / 按产品试算都读 `pl_variants.weight_g`，
// 2026-10-01 起商品ID 上没有克重），也是"缺哪一环"里最常见的一环。实际使用场景是"一口气补几十个款"，
// 所以它必须是**并排/常驻**的，而不是"点开抽屉、改完、关掉、再点下一个"——后者每款多两次点击。
// 完整的 SKU 维护（增删、颜色×尺码批量生成）仍在「编辑」抽屉里，这里只做克重这一个字段。
import { computed } from 'vue';
import type { ProductListItem, VariantRow } from '@/types';

const props = defineProps<{
  product: ProductListItem | null;
  variants: VariantRow[];
  saving: boolean;
  savedHint: string;
}>();

const emit = defineEmits<{ save: [variant: VariantRow, raw: string] }>();

const missingCount = computed(() => props.variants.filter((v) => !(Number(v.weightG) > 0)).length);

function onChange(v: VariantRow, raw: string): void {
  emit('save', v, raw);
}
</script>

<style scoped>
.gd-fix {
  flex-shrink: 0;
  max-height: 34vh;
}
.gd-fix__count {
  margin-left: auto;
  font-weight: 400;
}
.gd-fix__table {
  width: 100%;
}
.gd-fix__w {
  width: 110px;
}
.gd-fix__input {
  width: 84px;
  text-align: right;
}
.gd-fix__empty {
  padding: 18px 10px;
  text-align: center;
  white-space: normal;
  color: var(--wb-text-muted);
}
.gd-fix__foot {
  display: flex;
  align-items: center;
  min-height: 34px;
}
.gd-fix__saved {
  margin: 0;
  font-size: 12px;
  color: var(--wb-success);
}
.gd-fix__tip {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
