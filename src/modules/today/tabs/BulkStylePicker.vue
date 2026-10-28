<template>
  <!-- 批量定款（2026-10-28）：勾选多行 → 一次选款 → 一次落库。
       ─────────────────────────────────────────────────────────────────────
       用户原话（第二版）：「归属款还是只能一个一个选，路径太长（点击、选择、关闭、确认）」。
       上一轮只做了"带图挑款"，路径反而更长了一点点 —— 真正省力的地方不在弹层里，
       而在**这件事本来就重复**：真库 42 行待核对，按「商品」去重只有 17 个商品。

       ⚠️ 为什么按**商品**分组而不是"勾中的行统一定一个款"：同一家店的同一个商品，
          款式必然相同；而不同商品的行款式不同 —— 一概批量只会得到一串错误的归属。
          也不许"按店铺分组"：一家店几十个商品，那是把错的范围缩小了一点点而已。

       ⚠️ **颜色不在这里选**：颜色是行级属性（同款不同单可以不同色），这一层替人做的是
          "拿每行原来的颜色去对色卡"（`pickColorFor`）；对不上的行**留在列表里**等他单独选，
          不猜、也不套用别的行的颜色。

       ⚠️ 本弹层**不写库**：只把「组 → 款」交回父层，落库与回执由父层那一条实现完成
          （两处各写一套必然分叉，症状是"弹层说成功、列表里还在"）。 -->
  <div class="wb-mask" data-act="bp-mask" @click.self="$emit('close')">
    <div class="wb-dialog bp-dialog" role="dialog" aria-modal="true" aria-label="批量定款">
      <div class="wb-dialog__head">
        <span>批量定款</span>
        <span class="wb-muted bp-head__sub" data-act="bp-head">
          {{
            groups.length > 1
              ? `${groups.length} 个商品 · 共 ${rowTotal} 行`
              : `这 ${rowTotal} 行是同一个商品`
          }}
        </span>
      </div>

      <div class="wb-dialog__body bp-body" :class="{ 'bp-body--single': groups.length === 1 }">
        <!-- 左栏：勾中的行按商品归好的组。每组一张卡片，卡片上直接显示**组的订单图 + 已选款**，
             让"我给哪几行定了什么"一眼可见（没有这一步，用户只能靠记）。 -->
        <div v-if="groups.length > 1" class="bp-groups" data-act="bp-groups">
          <button
            v-for="g in groups"
            :key="g.key"
            type="button"
            class="bp-group"
            :class="{ 'is-on': activeKey === g.key, 'is-done': !!picks[g.key] }"
            :data-act="`bp-group-${g.key}`"
            @click="focusGroup(g.key)"
          >
            <span class="bp-group__imgs">
              <img
                v-for="(src, i) in g.images.slice(0, 4)"
                :key="i"
                :src="src"
                class="bp-group__img"
                alt=""
              />
              <span v-if="!g.images.length" class="wb-thumb wb-thumb--empty bp-group__img"></span>
              <span v-if="g.images.length > 4" class="bp-group__more">+{{ g.images.length - 4 }}</span>
            </span>
            <span class="bp-group__text">
              <b class="bp-group__shop">{{ g.shop || '（无店铺）' }}</b>
              <span class="wb-muted bp-group__meta">
                {{ g.rows.length }} 行{{ g.itemId ? ` · 商品 ${g.itemId}` : ' · 没有商品ID' }}
              </span>
              <span class="bp-group__pick" :data-act="`bp-group-pick-${g.key}`">
                <template v-if="picks[g.key]">
                  <img
                    v-if="styleThumbs[picks[g.key]]"
                    :src="styleThumbs[picks[g.key]]"
                    class="bp-group__pickimg"
                    alt=""
                  />
                  <b class="wb-mono">{{ picks[g.key] }}</b>
                </template>
                <span v-else class="wb-muted">还没选款</span>
              </span>
            </span>
          </button>
        </div>

        <!-- 右栏：带图款列表（与单品挑款**共用** `StyleList`：取图只有一份实现） -->
        <div class="bp-main">
          <p v-if="groups.length > 1" class="bp-hint" data-act="bp-active-hint">
            正在给
            <b>{{ activeGroup?.shop || '（无店铺）' }}</b>
            （{{ activeGroup?.rows.length ?? 0 }} 行）选款 —— 点左边的卡片可以换一组
          </p>
          <StyleList
            ref="listEl"
            :styles="styles"
            :current="activeKey ? picks[activeKey] || '' : ''"
            prefix="bp"
            @pick="onPick"
          />
        </div>
      </div>

      <div class="wb-dialog__foot bp-foot">
        <span class="wb-muted bp-foot__note" data-act="bp-note">
          颜色按每行原来的颜色自动对上；对不上（或这个款颜色不止一个）的行会留在列表里，单独选
        </span>
        <button class="wb-btn" type="button" data-act="bp-cancel" @click="$emit('close')">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="bp-apply"
          :disabled="!ready || busy"
          @click="apply"
        >
          {{ busy ? '处理中…' : `定款并保存（${readyCount} / ${groups.length} 组）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 批量定款弹层。三条纪律（改这块前先读）：
//   ① **分组键与行内徽标同一个函数**（`productKeyOf`）—— 两处各算一份，必然出现
//      "徽标说同商品、这里却拆成两组"；
//   ② **颜色不在这里选**，按行原色对色卡（`pickColorFor`）；对不上的行交回父层留在列表；
//   ③ **不写库**：只 emit「组 key → 款编码」，落库与回执在父层。
import { computed, reactive, ref, watch } from 'vue';
import StyleList from './StyleList.vue';
import type { BulkGroupView } from '@/lib/classifyBulk';
import type { StyleRecord } from '@/types';

const props = withDefaults(
  defineProps<{
    groups: BulkGroupView[];
    /** 款全集（父层已取） */
    styles: StyleRecord[];
    /** 款首图（code → dataUrl），卡片上显示"我给这组定了哪一款" */
    styleThumbs?: Record<string, string>;
    /** 父层正在落库 */
    busy?: boolean;
  }>(),
  { styleThumbs: () => ({}), busy: false }
);

const emit = defineEmits<{
  close: [];
  /** 每组选定的款；父层据此逐行落库 */
  apply: [picks: { key: string; styleCode: string }[]];
}>();

const rowTotal = computed(() => props.groups.reduce((n, g) => n + g.rows.length, 0));

/** 每组选定的款（初值 = 组内本来一致的款，"不用改的组"因此天然是已选状态） */
const picks = reactive<Record<string, string>>({});
/** 正在给它挑款的组（款列表的落点） */
const activeKey = ref('');
const listEl = ref<InstanceType<typeof StyleList> | null>(null);

/** 组变过（重新勾选 / 换了行）就重建 —— 但要保住用户已经选过的（同 key 同款） */
watch(
  () => props.groups,
  (gs) => {
    const next: Record<string, string> = {};
    for (const g of gs) next[g.key] = picks[g.key] || g.styleCode || '';
    for (const k of Object.keys(picks)) delete picks[k];
    Object.assign(picks, next);
    if (!gs.some((g) => g.key === activeKey.value)) activeKey.value = gs[0]?.key ?? '';
  },
  { immediate: true }
);

const activeGroup = computed(() => props.groups.find((g) => g.key === activeKey.value) ?? null);
const readyCount = computed(() => props.groups.filter((g) => !!picks[g.key]).length);
const ready = computed(() => props.groups.length > 0 && readyCount.value === props.groups.length);

function focusGroup(key: string): void {
  activeKey.value = key;
  listEl.value?.focusSearch();
}

/**
 * 点款 = 给**当前组**定这一款，然后自动跳到下一个还没选的组。
 *
 * 为什么自动跳：勾了 5 个商品就有 5 次"选款"，每选完一次还要回头点下一张卡片的话，
 * 省力的效果会被"找卡片"吃掉一半。跳过去之后左边高亮会跟着动，用户看得见现在在给谁定。
 */
function onPick(s: StyleRecord): void {
  if (!activeKey.value) return;
  picks[activeKey.value] = s.code;
  const nextUnpicked = props.groups.find((g) => !picks[g.key]);
  if (nextUnpicked) {
    activeKey.value = nextUnpicked.key;
    listEl.value?.focusSearch();
  }
}

function apply(): void {
  if (!ready.value || props.busy) return;
  emit(
    'apply',
    props.groups.map((g) => ({ key: g.key, styleCode: picks[g.key] }))
  );
}
</script>

<style scoped>
.bp-dialog {
  width: min(94vw, 900px);
}

.bp-head__sub {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}

.bp-body {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
/* 只有一个商品时左栏整块不渲染 ⇒ 右栏吃掉全部宽度（不是"左边留一片空白"） */
.bp-body--single {
  grid-template-columns: minmax(0, 1fr);
}

.bp-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow: auto;
  padding-right: 2px;
}

.bp-group {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  text-align: left;
  cursor: pointer;
}
.bp-group:hover {
  border-color: var(--wb-primary);
}
.bp-group.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}

.bp-group__imgs {
  position: relative;
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.bp-group__img {
  width: 30px;
  height: 30px;
  object-fit: contain;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
}
.bp-group__more {
  position: absolute;
  right: -2px;
  bottom: -2px;
  padding: 0 3px;
  border-radius: var(--wb-radius-sm);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  line-height: 13px;
}

.bp-group__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
  font-size: 12px;
  line-height: 1.3;
}
.bp-group__shop {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-group__meta {
  font-size: 11px;
}

.bp-group__pick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-group__pickimg {
  width: 20px;
  height: 20px;
  object-fit: contain;
  border-radius: 3px;
  background: var(--wb-surface-2);
}

.bp-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.bp-hint {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted, var(--wb-muted, #888));
}

.bp-foot {
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.bp-foot__note {
  margin-right: auto;
  font-size: 12px;
}
</style>
