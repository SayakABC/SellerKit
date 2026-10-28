<template>
  <!-- 归属款选择器（2026-10-28）：「归类核对」的款不再用原生下拉。
       ─────────────────────────────────────────────────────────────────────
       为什么要换掉 `<select>`：下拉里**只有文字**（款编码 + 名），而这件事的判据是**图**
       —— 用户原话「只是通过下拉列表看文字，不够直观，也容易对应错」。原生下拉不能放图，
       也没有任何办法在展开时把"这一行的订单图"摆在旁边 ⇒ 只能换成弹层。

       ⚠️ 与「产品管理」的 `ProductPicker` 是同构但**不是同一个东西**，别合并：
          · 那边选的是 `pl_products`（产品，走 `api.list`），这边选的是 `oi_styles` 款全集
            （走 `orderStyleList`，**含停用款** —— 历史订单可能正指向它）；
          · 那边的颜色是**商品级** `spec`，取词表 `COLOR_SWATCH`；这边的颜色是**行级的款色**
            （`oi_style_colors`，该款真实有的色），两套口径混用会落出没有名字的款色。
          · 只有"搜索 + 带图列表 + 单选"这个交互形状是借来的（那部分是 `StyleList.vue`，两处共用）。

       ⚠️ 本弹层**自己不写库**：它只 emit「款 + 色」+ 一个"要不要立刻存"的意图，
          真正的落库由父层那一条 `saveCorrection` 完成（两处各写一套必然分叉）。

       ⚠️⚠️ 2026-10-28 晚：加「保存并下一条」（用户原话「路径太长：点击、选择、关闭、确认」）。
          主按钮从"只回填草稿"改成**直接落库并推进到下一行**，路径从 6 步降到 3 步
          （点款格 → 选款 → 选色/保存）。"只填到行内"仍保留 —— 它是可退回的中间态，
          删掉它等于让"先改草稿、回头再一起看"这件事没有入口。 -->
  <div class="wb-mask" data-act="sp-mask" @click.self="$emit('close')">
    <div class="wb-dialog sp-dialog" role="dialog" aria-modal="true" aria-label="选择归属款">
      <div class="wb-dialog__head">
        <span>选择归属款</span>
        <span v-if="orderNo" class="wb-mono wb-muted sp-head__no" data-act="sp-order-no">{{ orderNo }}</span>
      </div>

      <div class="wb-dialog__body sp-body">
        <!-- 订单图**固定在左边且不随列表滚走**：这一页的动作是"拿这张图去挑款"，
             图一离开视线就只能靠记忆比对 —— 那正是"对应错"的来源。
             点击放大：与表格里的 ⤢ 走同一个实现（父层的 `openImage` 读原图），不另开一套。 -->
        <div class="sp-side">
          <button
            v-if="orderImage"
            type="button"
            class="sp-order"
            data-act="sp-order-img"
            title="点开看原图"
            @click="$emit('zoomOrder')"
          >
            <img :src="orderImage" alt="" />
            <span class="sp-order__zoom" aria-hidden="true">⤢</span>
          </button>
          <span v-else class="wb-thumb wb-thumb--empty sp-order" data-act="sp-order-empty"></span>
          <p class="sp-side__meta" data-act="sp-order-meta">
            <span v-if="shop">{{ shop }}</span>
            <span v-if="orderColor">订单颜色「{{ orderColor }}」</span>
            <span v-if="size">尺码 {{ size }}</span>
            <span v-if="!shop && !orderColor && !size" class="wb-muted">这条订单没有更多信息</span>
          </p>
        </div>

        <!-- 右栏：搜索 + 带图列表（与批量定款共用 `StyleList`）+ 色卡 -->
        <div class="sp-main">
          <StyleList
            ref="listEl"
            :styles="styles"
            :current="picked"
            prefix="sp"
            @pick="onPick"
          />

          <!-- 色卡：只在选中款之后出现，且**只列这个款真实有的颜色**（款色是落库主键的一半，
               在这里现编一个色名会落出一个别的款没有的款色）。
               ⚠️ 这个款**还没录颜色**时才给自由输入 —— 且同样不许留空：空颜色落库会生成
                  "没有名字的款色"，界面上看不出异常（与父层 `colorMissing` 是同一条守卫）。 -->
          <div v-if="pickedRow" class="sp-colors" data-act="sp-colors">
            <span class="wb-muted sp-colors__label">颜色</span>
            <template v-if="pickedRow.colors.length">
              <button
                v-for="c in pickedRow.colors"
                :key="c"
                type="button"
                class="sp-color"
                :class="{ 'is-on': color === c }"
                :data-act="`sp-color-${c}`"
                :data-color="c"
                @click="color = c"
              >
                <span class="sp-color__dot" :style="{ background: swatchOf(c) }" aria-hidden="true"></span>
                {{ c }}
              </button>
            </template>
            <template v-else>
              <input
                v-model="color"
                class="wb-input wb-input--sm sp-color-input"
                data-act="sp-color-input"
                :placeholder="orderColor ? `订单颜色「${orderColor}」` : '填一个颜色'"
              />
              <span class="wb-muted sp-colors__hint" data-act="sp-colors-empty">
                这个款还没录颜色 —— 先在这里填一个（之后到「产品管理」补进色卡）
              </span>
            </template>
          </div>
        </div>
      </div>

      <div class="wb-dialog__foot sp-foot">
        <div class="sp-foot__left">
          <!-- 「不点名款」= 回到按图片指纹自动匹配。这是原下拉里 `value=""` 那一项，
               换控件时**不能丢**：改错了要能退回去，否则只能去改库。 -->
          <button class="wb-link" type="button" data-act="sp-auto" :disabled="busy" @click="$emit('clear')">
            不点名款（按图片指纹自动匹配）
          </button>
          <!-- 灰因常显：按钮为什么按不动要写在按钮旁边，不能只躺在 title 里 -->
          <span v-if="!picked" class="wb-muted sp-blocked" data-act="sp-blocked">
            先选一个款
          </span>
          <span v-else-if="needColor" class="wb-muted sp-blocked" data-act="sp-need-color">
            {{
              pickedRow && pickedRow.colors.length
                ? `还要选一个颜色（${pickedRow.colors.length} 个可选）`
                : '这个款还没有颜色，先填一个'
            }}
          </span>
        </div>
        <button class="wb-btn" type="button" data-act="sp-cancel" :disabled="busy" @click="$emit('close')">
          取消
        </button>
        <!-- 「只填上」= 旧语义（回填草稿，不落库）。留着的原因：有人想先把几行填好、回头一起看；
             但它**不是**主路径 —— 用户抱怨的"关闭+确认"两步正是它带来的。 -->
        <button
          class="wb-btn"
          type="button"
          data-act="sp-confirm"
          :disabled="!picked || needColor || busy"
          @click="submit(false)"
        >
          只填上
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="sp-save-next"
          :disabled="!picked || needColor || busy"
          @click="submit(true)"
        >
          {{ busy ? '保存中…' : hasNext ? '保存并下一条' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 归属款选择器（「归类核对」行内「归属款」格的落点）。
//
// 四条口径（改这块前先读）：
//   ① **图是主判据**：款首图 + 订单图并排，搜索按「款编码 / 款名」本地过滤（数据已在内存，
//      不再发 IPC —— 款全集由父层 `listStyleOptions()` 一次取到）。
//   ② **颜色只列该款真实有的色**（`StyleRecord.colors`，来自 `oi_style_colors`）。
//      换款后旧颜色不在新色卡里 ⇒ **留空让人重选**（与父层同一条规则，两处各判一次必然分叉：
//      一处清空一处保留，症状是"明明记住了却永远要重选"）。
//   ③ **不写库**：只 emit 选中的「款 + 色」以及"是否立刻存"。
//   ④ **款没录颜色时不放行空色**（2026-10-28）：原先这里允许"没颜色也能确定"，而行内
//      `colorMissing` 又会把「保存」禁掉 ⇒ 用户被卡在一个没有出路的状态里（弹层说可以、
//      行内说不行）。现在弹层里直接给输入框并要求填上，闭环。
import { computed, ref } from 'vue';
import StyleList from './StyleList.vue';
import { COLOR_SWATCH } from '@/lib/colorSwatch';
import type { StyleRecord } from '@/types';

const props = withDefaults(
  defineProps<{
    /** 款全集（父层已取；含停用款） */
    styles: StyleRecord[];
    /** 这一行的订单图（缩略图 dataUrl）；取不到时空占位 */
    orderImage?: string;
    orderNo?: string;
    shop?: string;
    size?: string;
    /** 订单自己的颜色（只作提示，**不预选**：它可能不在该款色卡里） */
    orderColor?: string;
    currentStyle?: string;
    currentColor?: string;
    /** 这一行保存后还有下一行（决定主按钮文案「保存并下一条」/「保存」） */
    hasNext?: boolean;
    /** 父层正在落库（期间禁用全部动作，避免连点写出两次） */
    busy?: boolean;
  }>(),
  {
    orderImage: '',
    orderNo: '',
    shop: '',
    size: '',
    orderColor: '',
    currentStyle: '',
    currentColor: '',
    hasNext: false,
    busy: false,
  }
);

const emit = defineEmits<{
  close: [];
  /**
   * 选中「款 + 色」。
   * `save` = true 表示"现在就落库"（父层 `saveCorrection`）；false = 只回填草稿。
   * `color` 在款有色卡时必非空；款没色卡时由输入框填入，同样非空。
   */
  pick: [value: { styleCode: string; color: string }, save: boolean];
  /** 不点名款（回到自动匹配） */
  clear: [];
  /** 请求父层把订单图放大（复用父层已有的原图弹层） */
  zoomOrder: [];
}>();

const picked = ref(props.currentStyle || '');
const color = ref(props.currentColor || '');
const listEl = ref<InstanceType<typeof StyleList> | null>(null);

const pickedRow = computed(() => props.styles.find((s) => s.code === picked.value) ?? null);

/**
 * 能不能提交：款必须有；颜色按"这个款有没有色卡"分两种判据，但**结论都是必须非空**。
 *
 * ⚠️ 判据刻意不合并成 `colorMissing`（父层那条是落库守卫，必须独立成立）——
 *    这里只是"提前告诉他"，两处各判一次的风险是文案漂移，不是数据错。
 */
const needColor = computed(() => {
  if (!pickedRow.value) return false;
  return !color.value.trim();
});

function swatchOf(name: string): string {
  const hit = COLOR_SWATCH[name as keyof typeof COLOR_SWATCH];
  return typeof hit === 'string' ? hit : 'var(--wb-border)';
}

/**
 * 列表回填。换款后旧颜色落在新色卡里就保留（省一次点击），不在就清空（父层同规则）。
 *
 * ⚠️ `via === 'enter'` 时**直接提交**（`sp-confirm` 那条路，即只填上）：搜索框里敲编码 + 回车
 *    是一条"我看见就是这个款"的快路径，让它停在"还要再点一下"没有意义。
 *    注意这里提交的是 `save=false`（旧语义）—— 敲回车不等于"我要把它存进库"，
 *    真要存的人会去按那个写着「保存」的按钮。
 */
function onPick(s: StyleRecord, via: 'click' | 'enter'): void {
  picked.value = s.code;
  if (s.colors.length && !s.colors.includes(color.value)) color.value = '';
  if (via === 'enter' && !needColor.value) submit(false);
}

function submit(save: boolean): void {
  if (!picked.value || needColor.value || props.busy) return;
  emit('pick', { styleCode: picked.value, color: color.value.trim() }, save);
}

defineExpose({ focusSearch: (): void => listEl.value?.focusSearch() });
</script>

<style scoped>
.sp-dialog {
  width: min(92vw, 780px);
}

.sp-head__no {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}

/* 两栏：左订单图（固定）+ 右选择区。左栏窄而固定，右栏吃掉剩余宽度 */
.sp-body {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.sp-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: sticky;
  top: 0;
}

.sp-order {
  position: relative;
  display: block;
  width: 132px;
  height: 132px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  line-height: 0;
  cursor: zoom-in;
  overflow: hidden;
}

.sp-order img {
  width: 100%;
  height: 100%;
  /* 与表格同一条口径：核对要看**整张图**，不裁 */
  object-fit: contain;
}

.sp-order__zoom {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 3px;
  border-radius: var(--wb-radius-sm);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 14px;
}

.sp-side__meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--wb-text-muted, var(--wb-muted, #888));
}

.sp-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.sp-colors {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  min-height: 40px;
}

.sp-colors__label {
  font-size: 12px;
  margin-right: 2px;
}

.sp-color-input {
  width: 160px;
}

.sp-colors__hint {
  font-size: 12px;
}

.sp-color {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  font-size: 12px;
  cursor: pointer;
}

.sp-color.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}

.sp-color__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.18);
}

.sp-foot__left {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: auto;
  flex-wrap: wrap;
}

.sp-blocked {
  font-size: 12px;
}
</style>
