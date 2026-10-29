<template>
  <!-- 款合并（2026-10-28，P4）。
       ⚠️ 这块**不是门**：合并只影响"按款汇总"的口径（一张拿货单按款分行），
          不合并也能拿货、也能统计 —— 所以它默认折叠，且不拦任何动作。
       放拿货页的理由：这是唯一"同款分成两行"会让人肉疼的地方（同一件货要开两张单）。 -->
  <section v-if="groups.length || merges.length" class="wb-panel sm-merge" data-act="sm-merge">
    <button
      type="button"
      class="wb-panel__head sm-merge-head"
      data-act="sm-merge-toggle"
      :aria-expanded="show"
      @click="show = !show"
    >
      <span>
        可能是同一件货
        <span v-if="groups.length" class="sm-merge-head__count" data-act="sm-merge-count">
          {{ groups.length }} 组 / {{ styleTotal }} 个款
        </span>
      </span>
      <span v-if="merges.length" class="wb-muted sm-merge-head__done" data-act="sm-merge-done-count">
        已合并 {{ merges.length }} 次
      </span>
      <span class="sm-merge-head__toggle">{{ show ? '收起' : '展开' }}</span>
    </button>

    <div v-if="show" class="wb-panel__body sm-merge__body">
      <p class="sm-merge-note wb-muted" data-act="sm-merge-note">
        同一个厂家下挂着好几个款。如果其中几个其实是同一件货（同款开了多个链接），合并成 1 个款，
        拿货单就按 1 个款汇总。<b>合并随时可拆开</b>，不影响订单里的任何数字。
      </p>
      <p v-if="error" class="wb-notice wb-notice--error" data-act="sm-merge-error">{{ error }}</p>

      <div v-for="g in groups" :key="g.supplierId" class="sm-group" :data-act="`sm-group-${g.supplierId}`">
        <header class="sm-group__head">
          <span class="sm-group__sup">{{ g.supplierName }}</span>
          <span class="wb-muted sm-group__meta">{{ g.styles.length }} 个款</span>
        </header>

        <ul class="sm-list">
          <li
            v-for="s in g.styles"
            :key="s.styleId"
            class="sm-row"
            :class="{ 'sm-row--on': picked(g.supplierId).includes(s.styleId) }"
            :data-act="`sm-row-${s.styleId}`"
          >
            <label class="sm-row__pick">
              <input
                type="checkbox"
                :checked="picked(g.supplierId).includes(s.styleId)"
                :data-act="`sm-pick-${s.styleId}`"
                @change="togglePick(g.supplierId, s.styleId)"
              />
            </label>
            <img
              v-if="s.imagePath && thumbs[s.imagePath]"
              class="wb-thumb sm-row__thumb"
              :src="thumbs[s.imagePath]"
              :alt="s.styleName || s.styleCode"
            />
            <span v-else class="wb-thumb wb-thumb--empty sm-row__thumb" aria-hidden="true"></span>

            <div class="sm-row__body">
              <div class="sm-row__title">
                <span v-if="isTarget(g.supplierId, s.styleId)" class="sm-tag" data-act="sm-target-tag">
                  合并到它
                </span>
                <span class="sm-row__name" :data-act="`sm-name-${s.styleId}`">
                  {{ s.styleName || '（还没起名）' }}
                </span>
                <code class="sm-row__code">{{ s.styleCode }}</code>
              </div>
              <div class="sm-row__meta wb-muted">
                {{ s.colorCount }} 个色 · {{ s.rowCount }} 行订单
              </div>
              <div v-if="s.colors.length" class="sm-row__colors">
                <span v-for="(c, i) in s.colors" :key="i" class="sm-chip">{{ c }}</span>
              </div>
            </div>
          </li>
        </ul>

        <div class="sm-actions">
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            :data-act="`sm-merge-btn-${g.supplierId}`"
            :disabled="busy || picked(g.supplierId).length < 2"
            @click="doMerge(g)"
          >
            {{
              picked(g.supplierId).length < 2
                ? '勾选 2 个以上才能合并'
                : `合并成 1 个款（${pickedStyleName(g)}）`
            }}
          </button>
        </div>
      </div>

      <!-- 已合并：一条 = 一次操作（可能并进多个款），按批次拆开 -->
      <div v-if="merges.length" class="sm-merges" data-act="sm-merges">
        <h4 class="sm-merges__title">已合并</h4>
        <ul class="sm-merges__list">
          <li
            v-for="m in merges"
            :key="m.batchId"
            class="sm-merges__row"
            :data-act="`sm-merge-record-${m.batchId}`"
          >
            <span class="sm-merges__desc">
              {{ m.sources.map((s) => s.styleCode).join('、') }} →
              <code>{{ m.targetStyleCode }}</code>
            </span>
            <span class="wb-muted sm-merges__meta">
              搬色 {{ m.movedColors }} · 改键 {{ m.movedKeys }} · {{ m.createdAt }}
            </span>
            <button
              type="button"
              class="wb-link"
              :data-act="`sm-unmerge-${m.batchId}`"
              :disabled="busy"
              @click="doUnmerge(m)"
            >
              拆开
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
// 款合并卡（P4）。
//
// 三条必须保住的语义：
//   ① **可跳过**：默认折叠、不拦任何动作。合并不是门（不合并也能拿货，只是同一厂家分行）。
//   ② **目标由"第一个勾的"决定**，且行上直接标「合并到它」—— 不让人猜"合并到哪个款了"。
//      勾选顺序在数组里，不在 DOM 顺序里（前者是人的意图，后者是渲染顺序）。
//   ③ **可拆**：拆开按**批次**，不按行 —— 一次 N→1 在库里写 N 行，按行拆只能拆掉最后一个源款
//      （真库副本上实测过 restored=1）。
import { computed, onMounted, ref } from 'vue';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import type { MergeCandidateGroup, MergeStyleBrief, StyleMergeBoard, StyleMergeRecord } from '@/types';

const board = ref<StyleMergeBoard>({ groups: [], merges: [] });
const show = ref(false);
const busy = ref(false);
const error = ref('');
const thumbs = ref<Record<string, string>>({});
/** `supplierId → 按勾选顺序排的 styleId`（顺序即意图：第一个是目标款） */
const pickedMap = ref<Record<number, number[]>>({});

const groups = computed(() => board.value.groups);
const merges = computed(() => board.value.merges);
const styleTotal = computed(() => groups.value.reduce((n, g) => n + g.styles.length, 0));

function picked(supplierId: number): number[] {
  return pickedMap.value[supplierId] ?? [];
}

function isTarget(supplierId: number, styleId: number): boolean {
  const list = picked(supplierId);
  return list.length >= 2 && list[0] === styleId;
}

function togglePick(supplierId: number, styleId: number): void {
  const cur = picked(supplierId);
  const next = cur.includes(styleId) ? cur.filter((n) => n !== styleId) : [...cur, styleId];
  pickedMap.value = { ...pickedMap.value, [supplierId]: next };
  error.value = '';
}

function pickedStyleName(g: MergeCandidateGroup): string {
  const id = picked(g.supplierId)[0] ?? 0;
  const s = g.styles.find((x) => x.styleId === id);
  if (!s) return '';
  return s.styleName || s.styleCode;
}

async function reload(): Promise<void> {
  try {
    const b = await ipc.orderStyleMergeBoard();
    if (!b.success || !b.data) {
      error.value = b.error || '读取合并候选失败';
      return;
    }
    board.value = b.data;
    // 选中的款可能已在别处被合并/删除 ⇒ 清掉不存在的，避免按钮上写着不存在的目标
    const alive = new Map<number, Set<number>>();
    for (const g of b.data.groups) alive.set(g.supplierId, new Set(g.styles.map((s) => s.styleId)));
    const next: Record<number, number[]> = {};
    for (const [sid, list] of Object.entries(pickedMap.value)) {
      const keep = list.filter((id) => alive.get(Number(sid))?.has(id));
      if (keep.length) next[Number(sid)] = keep;
    }
    pickedMap.value = next;
    void loadThumbs(b.data.groups.flatMap((g) => g.styles.map((s) => s.imagePath)));
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取合并候选失败';
  }
}

async function loadThumbs(paths: string[]): Promise<void> {
  const want = [...new Set(paths.filter((p) => p && !thumbs.value[p]))];
  if (!want.length) return;
  try {
    const t = await ipc.orderImageThumbBatch(want.map((localPath) => ({ localPath, maxEdge: 96 })));
    if (!t.success) return;
    want.forEach((p, i) => {
      const url = t.data?.dataUrls?.[i];
      if (url) thumbs.value[p] = url;
    });
  } catch {
    // 缩略图取不到只是少一张图（卡片还能靠款名/色名判断），不该让整块报错
  }
}

async function doMerge(g: MergeCandidateGroup): Promise<void> {
  const list = picked(g.supplierId);
  if (list.length < 2 || busy.value) return;
  const [targetStyleId, ...sourceStyleIds] = list;
  const target: MergeStyleBrief | undefined = g.styles.find((s) => s.styleId === targetStyleId);
  busy.value = true;
  error.value = '';
  try {
    const r = await ipc.orderStyleMerge({ targetStyleId, sourceStyleIds });
    if (!r.success || !r.data) {
      error.value = r.error || '合并失败';
      return;
    }
    if (!r.data.ok) {
      error.value = r.data.error || '没合并成功';
      return;
    }
    const d = r.data;
    toast.success(
      `已并到 ${target?.styleName || target?.styleCode || '目标款'}：搬色 ${d.movedColors} · 改键 ${d.movedKeys}`,
    );
    pickedMap.value = { ...pickedMap.value, [g.supplierId]: [] };
    await reload();
    // 拿货页的缺口按款汇总 ⇒ 合并后必须让它重算（否则"同一件货两行"要切页才消失）
    window.dispatchEvent(new CustomEvent('sk:order-changed'));
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '合并失败';
  } finally {
    busy.value = false;
  }
}

async function doUnmerge(m: StyleMergeRecord): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await ipc.orderStyleUnmerge({ batchId: m.batchId });
    if (!r.success || !r.data) {
      error.value = r.error || '拆开失败';
      return;
    }
    if (!r.data.ok) {
      error.value = r.data.error || '没拆成功';
      return;
    }
    // 跳过数必须说出来：静默少还原几条，人会以为拆干净了
    toast.success(
      r.data.skipped > 0
        ? `已拆开，还原 ${r.data.restored} 项；另有 ${r.data.skipped} 项已被后续改动覆盖，保持原样`
        : `已拆开，还原 ${r.data.restored} 项`,
    );
    await reload();
    window.dispatchEvent(new CustomEvent('sk:order-changed'));
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '拆开失败';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void reload();
});
</script>

<style scoped>
/* ⚠️ 折叠态只有 41px，而它所在那一页是**定高弹性列** ⇒ 默认可缩的它会被压成 5px
   （实测：命名板一进来，这一块就成了"谁矮谁让路"里最矮的那个，结果连标题都看不见）。
   折叠态必须保住自己的高度；展开态由内容决定高度，但也要有上限（见 `.sm-merge__body`）。 */
.sm-merge {
  flex-shrink: 0;
}
/* 展开态限高 + 自己滚：厂家多、款多时这块能长出几百 px，而它**不是**这一页的主活
   （默认折叠、可不碰）；不封顶就会把核对表挤出屏幕（命名板同款处理：44vh）。
   与命名板取同一个比例，两块加起来的上限是能预期的。 */
.sm-merge__body {
  max-height: 44vh;
  overflow: auto;
}
.sm-merge-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sm-merge-head__count {
  margin-left: 6px;
  font-size: 12px;
  color: var(--wb-text-muted, #666);
}
.sm-merge-head__done {
  font-size: 12px;
}
.sm-merge-head__toggle {
  margin-left: auto;
  font-size: 12px;
  color: var(--wb-text-muted, #666);
}
.sm-merge-note {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
}
.sm-group {
  border-top: 1px solid var(--wb-border, #e6e6e6);
  padding-top: 10px;
  margin-top: 10px;
}
.sm-group__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.sm-group__sup {
  font-weight: 600;
  font-size: 13px;
}
.sm-group__meta {
  font-size: 12px;
}
.sm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sm-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px;
  border-radius: 6px;
  border: 1px solid transparent;
}
.sm-row--on {
  border-color: var(--wb-accent, #4a7cff);
  background: var(--wb-accent-soft, rgba(74, 124, 255, 0.06));
}
.sm-row__pick {
  display: flex;
  align-items: center;
  padding-top: 2px;
}
.sm-row__thumb {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  object-fit: cover;
  border-radius: 4px;
}
.sm-row__body {
  min-width: 0;
  flex: 1 1 auto;
}
.sm-row__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.sm-row__name {
  font-size: 13px;
}
.sm-row__code {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--wb-text-muted, #666);
}
.sm-tag {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--wb-accent, #4a7cff);
  color: #fff;
}
.sm-row__meta {
  font-size: 11px;
}
.sm-row__colors {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
}
.sm-chip {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--wb-chip-bg, #f2f2f2);
  color: var(--wb-text-muted, #555);
}
.sm-actions {
  margin-top: 8px;
}
.sm-merges {
  margin-top: 14px;
  border-top: 1px solid var(--wb-border, #e6e6e6);
  padding-top: 10px;
}
.sm-merges__title {
  margin: 0 0 6px;
  font-size: 13px;
}
.sm-merges__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sm-merges__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}
.sm-merges__desc code {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
}
.sm-merges__meta {
  flex: 1 1 auto;
  font-size: 11px;
}
</style>
