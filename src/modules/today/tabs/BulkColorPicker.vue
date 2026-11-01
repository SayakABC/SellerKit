<template>
  <!-- 批量定色（2026-10-30）：勾选多行 → 选一个色 → 一次落库。
       ─────────────────────────────────────────────────────────────────────
       为什么还要这一层（页头已经有一排色卡托盘）：托盘是**快路径** —— 勾中的行款式一致、
       色卡也就一张，点一下就走。真正卡住的是**混款**：勾了 3 个款的行，同一个色名在有的款色卡里、
       在有的款色卡里没有。托盘只按"有没有这个色"逐行处理，人看不到"这一下会改动几行、
       几行会不动"，于是要点完才知道结果。这一层把那笔账在**点之前**摆出来。

       ⚠️ 不在这里选款、也不允许在这里给某个款"顺手加色"：加色是产品管理的动作，
          在这页加出来的色只服务这一单（下游取图/算钱全按款色匹配，会静默对不上）。

       ⚠️ 本弹层**不写库**：只 emit 一个色名，落库与回执由父层那一条实现完成
          （与 `applyTrayColor` 同一个入口 —— 两处各写一套必然分叉）。 -->
  <div class="wb-mask" data-act="bc-mask" @click.self="$emit('close')">
    <div class="wb-dialog bc-dialog" role="dialog" aria-modal="true" aria-label="批量定色">
      <div class="wb-dialog__head">
        <span>批量定色</span>
        <span class="wb-muted bc-head__sub" data-act="bc-head">
          已选 {{ rows.length }} 行 · {{ styleCount }} 个款
        </span>
      </div>

      <div class="wb-dialog__body bc-body">
        <p v-if="!options.length" class="bc-empty" data-act="bc-empty">
          这几行都还没点名款 —— 先定款，色卡才知道能选哪些色
        </p>
        <div v-else class="bc-list" data-act="bc-list">
          <button
            v-for="c in options"
            :key="c.name"
            type="button"
            class="bc-item"
            :class="{ 'is-on': picked === c.name, 'is-off': !c.change }"
            :data-act="`bc-color-${c.name}`"
            :data-color="c.name"
            :disabled="!c.change"
            :title="itemTitle(c)"
            @click="picked = c.name"
          >
            <span class="bc-item__dot" :style="{ background: swatch(c.name) ?? 'transparent' }"></span>
            <b class="bc-item__name">{{ c.name }}</b>
            <span class="bc-item__meta wb-muted" :data-act="`bc-meta-${c.name}`">
              改 {{ c.change }} 行<template v-if="c.same"> · 已是 {{ c.same }}</template
              ><template v-if="c.miss"> · 另 {{ c.miss }} 行不适用</template>
            </span>
          </button>
        </div>
      </div>

      <div class="wb-dialog__foot bc-foot">
        <span class="wb-muted bc-foot__note" data-act="bc-note">
          只改款色卡里有这个色的行；卡里没有的行不动（要先去产品管理给它加色）
        </span>
        <button class="wb-btn" type="button" data-act="bc-cancel" @click="$emit('close')">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="bc-apply"
          :disabled="!pickedChange || busy"
          @click="apply"
        >
          {{ busy ? '处理中…' : picked ? `定色并保存（${pickedChange} 行）` : '先选一个颜色' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 批量定色弹层。三条纪律（改这块前先读）：
//   ① 覆盖数由 `colorOptionsOf`（纯函数，有单测）算，**不在这里另算一份** ——
//      "卡片说改 3 行、实际改了 4 行"是这一层最容易出的错；
//   ② 只 emit 色名，落库/回执在父层（与托盘同一个入口 `applyTrayColor`）；
//   ③ `change = 0` 的色仍然列出、但**点不动**（"已经是这个色"要看得见，否则会被读成色卡读错了）。
import { computed, ref } from 'vue';
import { colorSwatchOf } from '@/core/services/colorDict';
import { colorOptionsOf, type BulkColorOption, type BulkColorRow } from '@/lib/classifyBulk';

const props = withDefaults(
  defineProps<{
    /** 父层按勾选行投影（`palette` = 该行当前款的色卡） */
    rows: BulkColorRow[];
    /** 父层正在落库 */
    busy?: boolean;
  }>(),
  { busy: false }
);

const emit = defineEmits<{
  close: [];
  /** 选定的色名；父层据此逐行落库 */
  apply: [color: string];
}>();

const options = computed(() => colorOptionsOf(props.rows));
const styleCount = computed(() => {
  const codes = new Set<string>();
  for (const r of props.rows) {
    const code = String(r.styleCode ?? '').trim();
    if (code) codes.add(code);
  }
  return codes.size;
});

/** 用户点中的色（初始不选：这一层没有"猜一个"的余地） */
const picked = ref('');
const pickedChange = computed(() => {
  const o = options.value.find((c) => c.name === picked.value);
  return o ? o.change : 0;
});

function swatch(name: string): string | null {
  return colorSwatchOf(name);
}

/** 悬停时把"哪几行不适用"说出来（最多 3 个订单号），别让用户自己去数 */
function itemTitle(c: BulkColorOption): string {
  if (!c.change) {
    return c.same ? `这 ${c.same} 行已经是「${c.name}」，不用再写一遍` : '这几行都定不了这个色';
  }
  if (!c.miss) return `点一下 = 把这 ${c.change} 行定到「${c.name}」并保存`;
  const nos = c.missNos.slice(0, 3).join('、');
  const more = c.missNos.length > 3 ? ' 等' : '';
  const why = c.noStyle ? `${c.noStyle} 行还没点名款；其余款色卡里没有这个色` : '款色卡里没有这个色';
  return `不适用：${nos}${more}（${why}）`;
}

function apply(): void {
  if (!picked.value || !pickedChange.value || props.busy) return;
  emit('apply', picked.value);
}
</script>

<style scoped>
.bc-dialog {
  width: min(92vw, 520px);
}

.bc-head__sub {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}

.bc-body {
  max-height: 52vh;
  overflow: auto;
}

.bc-empty {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted, #888);
}

.bc-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 24px 是这张卡片的手感下限（与 ColorPalette 的胶囊同源：再矮点在触控板上会脱靶） */
.bc-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--wb-text);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  cursor: pointer;
}
.bc-item:hover:not(:disabled) {
  border-color: var(--wb-border-strong);
}
.bc-item.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
/* 一行都不用改：留着但明显是"已完成"，不让人以为点它会发生什么 */
.bc-item.is-off {
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
  border-style: dashed;
  cursor: default;
}
.bc-item__dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.bc-item__name {
  font-size: 12px;
}
.bc-item__meta {
  font-size: 11px;
}

.bc-foot {
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bc-foot__note {
  margin-right: auto;
  font-size: 12px;
}
</style>
