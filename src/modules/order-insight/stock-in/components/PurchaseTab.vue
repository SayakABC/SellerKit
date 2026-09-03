<script setup lang="ts">
// 「拿货」Tab：待拿货缺口（实时差量）→ 生成拿货单 → 拿货单记录；右侧为拿货单编辑面板。
import { computed, onMounted, watch } from 'vue';
import { useStockInStore, centsToYuan, yuanToCents } from '../store';
import type { OutstandingRow, PurchaseItem } from '@/types';

const store = useStockInStore();

onMounted(() => store.ensureLoaded());

function onPriceChange(it: PurchaseItem, e: Event) {
  it.priceCents = yuanToCents(Number((e.target as HTMLInputElement).value));
}

/** 草稿行输入款编码/款色后自动带出同款最近单价（仅当该行尚未定价时触发一次，避免覆盖手输价格） */
const priceFetching = new Set<PurchaseItem>();
watch(
  () => store.draftItems.map((it) => `${it.styleCode}\u0000${it.color}\u0000${it.priceCents}`),
  () => {
    for (const it of store.draftItems) {
      if (priceFetching.has(it) || !it.styleCode.trim() || it.priceCents > 0) continue;
      priceFetching.add(it);
      store.autoFillPrice(it).finally(() => priceFetching.delete(it));
    }
  },
);
function onQtyChange(it: PurchaseItem, e: Event) {
  const n = Number((e.target as HTMLInputElement).value);
  it.qty = Number.isFinite(n) && n > 0 ? Math.max(0, Math.round(n)) : 0;
}

function markIgnored(row: OutstandingRow) {
  const reason = window.prompt('标记「无需补货」原因（选填，如：已线下拿 / 放弃 / 退单）', '');
  if (reason === null) return;
  store.addIgnore(row, reason.trim());
}

/** 缺口按款分组内的款色码行：colorText 恒显示该行款色；忽略按钮每行都有（忽略按整款色生效） */
type GapRow = { r: OutstandingRow; colorText: string };
/** 缺口按款分组：一个款一张卡片，档口在款头（款级）指派，行 = 款色码 */
type GapGroup = {
  styleCode: string;
  styleName: string;
  rows: GapRow[];
  demand: number;
  taken: number;
  missing: number;
};

const groups = computed<GapGroup[]>(() => {
  const list: GapGroup[] = [];
  const map = new Map<string, GapGroup>();
  for (const r of store.outstanding) {
    const code = r.styleCode.trim() || r.styleCode;
    let g = map.get(code);
    if (!g) {
      g = { styleCode: code, styleName: r.styleName || '', rows: [], demand: 0, taken: 0, missing: 0 };
      map.set(code, g);
      list.push(g);
    }
    // 每行都显示所属款色，避免同一款色后续尺码行被误读为「无款色」
    g.rows.push({ r, colorText: (r.color || '').trim() || '—' });
    g.demand += r.demand || 0;
    g.taken += r.taken || 0;
    g.missing += r.missing || 0;
  }
  return list;
});
</script>

<template>
  <div class="flex h-full min-h-0 gap-3 overflow-hidden">
    <!-- 左列：待拿货 + 拿货单列表 -->
    <div class="flex w-[58%] min-w-0 flex-col gap-3 overflow-y-auto pr-0.5">
      <!-- 待拿货缺口 -->
      <section class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-3">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-semibold">待拿货缺口（{{ groups.length }} 款 · {{ store.outstanding.length }} 项）</h3>
          <button
            class="rounded-lg bg-[var(--wb-primary)] px-3 py-1.5 text-xs font-medium text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)] disabled:opacity-50"
            :disabled="store.outstanding.length === 0 || !!store.editing || store.generating"
            :title="'把已分配档口的款按档口各拆一张拿货单（未分配档口的款不会生成）'"
            @click="store.generateBySupplier()"
          >
            {{ store.generating ? '生成中…' : '按档口生成拿货单' }}
          </button>
        </div>
        <p class="mb-2 text-[10px] leading-relaxed text-[var(--wb-text-muted)]">
          按款归类 · 每款指定「档口」（默认按上次拿货记忆）→ 点右上「按档口生成拿货单」，系统按档口各生成一张草稿单，一家一家去拿即可。
        </p>
        <div v-if="store.outstanding.length === 0" class="py-6 text-center text-xs text-[var(--wb-text-muted)]">
          暂无缺口 —— 当前订单需求均已拿全
        </div>
        <div v-else class="space-y-2">
          <div v-for="g in groups" :key="g.styleCode" class="overflow-hidden rounded-lg border border-[var(--wb-border)]">
            <!-- 款头：款编码 + 款式名 + 该款合计差 + 档口（按款指派） -->
            <div class="flex items-center gap-2 border-b border-[var(--wb-border)] px-2 py-1.5">
              <span class="shrink-0 text-xs font-semibold">{{ g.styleCode }}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-[var(--wb-text-muted)]" :title="g.styleName">{{ g.styleName }}</span>
              <span
                class="shrink-0 rounded bg-[var(--wb-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--wb-warning)]"
                :title="`该款需求 ${g.demand} 件 / 已拿 ${g.taken} 件`"
              >
                差 {{ g.missing }}
              </span>
              <select
                v-model.number="store.planSupplier[g.styleCode]"
                class="h-6 w-[118px] shrink-0 rounded border border-[var(--wb-border)] bg-[var(--wb-surface)] px-1 text-[11px] outline-none focus:border-[var(--wb-primary)]"
                :title="`计划去哪个档口拿「${g.styleCode}」（同款所有款色/尺码默认一起去这家）`"
              >
                <option :value="0">去谁家…</option>
                <option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] text-[var(--wb-text-muted)]">
                  <th class="w-[72px] py-1 pl-2 pr-1 font-normal">款色</th>
                  <th class="w-[38px] py-1 font-normal">码</th>
                  <th class="w-[52px] py-1 pr-1 text-right font-normal">需求</th>
                  <th class="w-[52px] py-1 pr-1 text-right font-normal">已拿</th>
                  <th class="w-[44px] py-1 text-right font-normal">差</th>
                  <th class="py-1 pr-2 text-right font-normal"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, i) in g.rows"
                  :key="i"
                  class="border-t border-[var(--wb-border)]/70 transition-colors hover:bg-[var(--wb-hover)]"
                >
                  <td class="py-1 pl-2 pr-1 text-[var(--wb-text-muted)]">{{ row.colorText }}</td>
                  <td class="py-1">{{ row.r.size || '—' }}</td>
                  <td class="py-1 pr-1 text-right tabular-nums text-[var(--wb-text-muted)]">{{ row.r.demand }}</td>
                  <td class="py-1 pr-1 text-right tabular-nums">{{ row.r.taken }}</td>
                  <td class="py-1 text-right font-semibold tabular-nums text-[var(--wb-danger)]">{{ row.r.missing }}</td>
                  <td class="py-1 pr-2 text-right">
                    <button
                      class="rounded px-1.5 py-0.5 text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]"
                      title="标记该款色无需补货（同款色所有尺码都不再补）"
                      @click="markIgnored(row.r)"
                    >
                      忽略
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- 拿货单列表 -->
      <section class="flex-1 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-3">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-semibold">拿货单记录（{{ store.orders.length }}）</h3>
          <button
            class="rounded-lg border border-[var(--wb-border)] px-3 py-1.5 text-xs hover:bg-[var(--wb-hover)] disabled:opacity-50"
            :disabled="!!store.editing || store.generating"
            title="新建一张空白拿货单，手动加行（按缺口批量生成请用上方「按档口生成拿货单」）"
            @click="store.newDraft()"
          >
            + 新建拿货单
          </button>
        </div>
        <div v-if="store.orders.length === 0" class="py-6 text-center text-xs text-[var(--wb-text-muted)]">
          还没有拿货单，从上方「按档口生成拿货单」开始
        </div>
        <div v-else class="space-y-1.5">
          <div
            v-for="o in store.orders"
            :key="o.id"
            class="flex items-center gap-1.5 rounded-lg border border-[var(--wb-border)] px-2.5 py-2"
            :class="store.editing?.id === o.id ? 'ring-1 ring-[var(--wb-primary)]' : ''"
          >
            <span class="w-[72px] shrink-0 text-xs tabular-nums text-[var(--wb-text-muted)]">{{ o.bizDate }}</span>
            <span class="min-w-0 flex-1 truncate text-xs font-medium" :title="o.supplierName">{{ o.supplierName }}</span>
            <span
              class="shrink-0 rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]"
              :title="o.mode === 'detail' ? '明细模式：按款色逐行记录数量与单价' : '包价模式：只记一笔总金额，不参与齐货/利润'"
            >
              {{ o.mode === 'package' ? '包价' : '明细' }}
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              :class="o.status === 'submitted' ? 'bg-[var(--wb-success)]/10 text-[var(--wb-success)]' : 'bg-[var(--wb-warning)]/10 text-[var(--wb-warning)]'"
            >
              {{ o.status === 'submitted' ? '已提交' : '草稿' }}
            </span>
            <span class="ml-auto shrink-0 text-xs font-semibold tabular-nums">¥{{ centsToYuan(o.totalCents) }}</span>
            <span class="flex shrink-0 gap-0.5">
              <button class="rounded px-1.5 py-0.5 text-xs text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]" title="编辑，查看/修改明细" @click="store.editOrder(o.id)">编辑</button>
              <button class="rounded px-1.5 py-0.5 text-xs text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]" title="导出拿货单 Excel（现场填写）" @click="store.exportOrderExcel(o)">导出</button>
              <button
                v-if="o.status === 'draft'"
                class="rounded bg-[var(--wb-primary)] px-1.5 py-0.5 text-xs text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)]"
                @click="store.submitOrder(o.id)"
              >
                提交
              </button>
              <button class="rounded px-1.5 py-0.5 text-xs text-[var(--wb-text-muted)] hover:bg-[var(--wb-danger)] hover:text-[var(--wb-primary-contrast)]" title="删除" @click="store.deleteOrder(o)">删除</button>
            </span>
          </div>
        </div>
      </section>
    </div>

    <!-- 右列：编辑面板（行多时明细内部滚动；窗矮时整列滚动兜底，底部操作始终可达） -->
    <div class="flex w-[42%] min-w-0 flex-col overflow-y-auto">
      <section class="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-3">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-semibold">
            {{ store.editing ? `编辑拿货单 #${store.editing.id}` : '新建拿货单' }}
          </h3>
          <div class="flex gap-1">
            <button
              class="rounded-lg border border-[var(--wb-border)] px-2.5 py-1 text-xs hover:bg-[var(--wb-hover)] disabled:opacity-40"
              :disabled="!store.editing"
              @click="store.importOrderExcel()"
            >
              导入回填
            </button>
            <button
              v-if="store.editing"
              class="rounded-lg border border-[var(--wb-border)] px-2.5 py-1 text-xs hover:bg-[var(--wb-hover)]"
              @click="store.exportOrderExcel(store.editing)"
            >
              导出
            </button>
          </div>
        </div>

        <!-- 头部：厂商 / 日期 / 模式 -->
        <div class="mb-2 grid grid-cols-2 gap-2">
          <div>
            <label class="mb-0.5 block text-[10px] text-[var(--wb-text-muted)]">厂商</label>
            <select
              v-model.number="store.draftSupplierId"
              class="h-7 w-full rounded-md border border-[var(--wb-border)] px-2 text-xs outline-none focus:border-[var(--wb-primary)] disabled:opacity-50"
              :disabled="!!store.editing"
            >
              <option :value="0">选择厂商…</option>
              <option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
          <div>
            <label class="mb-0.5 block text-[10px] text-[var(--wb-text-muted)]">日期</label>
            <input
              v-model="store.draftBizDate"
              type="date"
              class="h-7 w-full rounded-md border border-[var(--wb-border)] px-2 text-xs outline-none focus:border-[var(--wb-primary)]"
            />
          </div>
        </div>
        <div class="mb-2 flex items-center gap-2">
          <span class="text-[10px] text-[var(--wb-text-muted)]">模式</span>
          <button
            class="rounded-lg px-2.5 py-1 text-xs"
            :class="store.draftMode === 'detail' ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="store.draftMode = 'detail'"
          >
            明细
          </button>
          <button
            class="rounded-lg px-2.5 py-1 text-xs"
            title="包价：只记总金额，不参与齐货与利润"
            :class="store.draftMode === 'package' ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="store.draftMode = 'package'"
          >
            包价
          </button>
          <span v-if="store.draftMode === 'package'" class="text-[10px] text-[var(--wb-text-muted)]">（只记总额，不参与齐货/利润）</span>
        </div>

        <!-- 明细（仅明细模式；粒度 = 款色码） -->
        <template v-if="store.draftMode === 'detail'">
          <div class="min-h-[120px] flex-1 overflow-auto">
            <div class="sticky top-0 z-10 grid min-w-[520px] grid-cols-[0.9fr_1.15fr_0.7fr_0.6fr_0.6fr_0.75fr_0.9fr_16px] items-center gap-1 border-b border-[var(--wb-border)] bg-[var(--wb-surface)] px-1 py-1.5 text-[10px] font-medium text-[var(--wb-text-muted)]">
              <span>款编码</span><span>款式名</span><span>款色</span><span>尺码</span><span class="text-right">数量</span><span class="text-right">单价(元)</span><span class="text-right">金额</span><span></span>
            </div>
            <div
              v-for="(it, idx) in store.draftItems"
              :key="idx"
              class="grid min-w-[520px] grid-cols-[0.9fr_1.15fr_0.7fr_0.6fr_0.6fr_0.75fr_0.9fr_16px] items-center gap-1 border-b border-[var(--wb-border)] px-1 py-1 text-xs last:border-b-0 hover:bg-[var(--wb-hover)]"
            >
              <input v-model="it.styleCode" type="text" placeholder="款编码" class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-xs outline-none focus:border-[var(--wb-primary)]" />
              <input v-model="it.styleName" type="text" placeholder="款式名" class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-xs outline-none focus:border-[var(--wb-primary)]" />
              <input v-model="it.color" type="text" placeholder="款色" class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-xs outline-none focus:border-[var(--wb-primary)]" />
              <input v-model="it.size" type="text" placeholder="码" class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-xs outline-none focus:border-[var(--wb-primary)]" />
              <input
                :value="it.qty || ''"
                type="number"
                min="0"
                step="1"
                class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-right text-xs tabular-nums outline-none focus:border-[var(--wb-primary)]"
                @change="onQtyChange(it, $event)"
              />
              <input
                :value="it.priceCents ? it.priceCents / 100 : ''"
                type="number"
                min="0"
                step="0.01"
                class="h-7 min-w-0 w-full rounded border border-[var(--wb-border)] px-1 text-right text-xs tabular-nums outline-none focus:border-[var(--wb-primary)]"
                @change="onPriceChange(it, $event)"
              />
              <span class="min-w-0 whitespace-nowrap text-right text-xs tabular-nums text-[var(--wb-text-muted)]">{{ centsToYuan((it.qty || 0) * (it.priceCents || 0)) }}</span>
              <button class="text-[var(--wb-text-muted)] hover:text-[var(--wb-danger)]" title="删除行" @click="store.removeDraftRow(idx)">✕</button>
            </div>
            <div v-if="store.draftItems.length === 0" class="px-2 py-6 text-center text-xs text-[var(--wb-text-muted)]">
              暂无明细行，点击「+ 加行」添加
            </div>
          </div>
          <button class="mt-1.5 rounded-lg border border-dashed border-[var(--wb-border)] px-2 py-1 text-xs text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]" @click="store.addDraftRow()">
            + 加行
          </button>
        </template>
        <template v-else>
          <div class="flex-1 space-y-2">
            <div>
              <label class="mb-0.5 block text-[10px] text-[var(--wb-text-muted)]">本次拿货总额（元）</label>
              <input
                v-model="store.draftPackageTotalYuan"
                type="number"
                min="0"
                step="0.01"
                class="h-7 w-full rounded-md border border-[var(--wb-border)] px-2 text-xs outline-none focus:border-[var(--wb-primary)]"
              />
            </div>
            <div class="text-[10px] text-[var(--wb-text-muted)]">包价单只参与厂商对账，不参与待拿货齐货校验与利润计算。</div>
          </div>
        </template>

        <!-- 备注 + 合计 + 操作 -->
        <div class="mt-2">
          <input
            v-model="store.draftNote"
            type="text"
            placeholder="备注（选填）"
            class="h-7 w-full rounded-md border border-[var(--wb-border)] px-2 text-xs outline-none focus:border-[var(--wb-primary)]"
          />
        </div>
        <div class="mt-2 flex items-center justify-between border-t border-[var(--wb-border)] pt-2">
          <span class="text-xs text-[var(--wb-text-muted)]">
            合计
            <b class="text-sm text-[var(--wb-text)]">
              ¥{{ store.draftMode === 'package' ? Number(store.draftPackageTotalYuan || 0).toFixed(2) : centsToYuan(store.editingTotalCents) }}
            </b>
          </span>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--wb-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--wb-hover)]" @click="store.cancelDraft()">
              取消
            </button>
            <button
              class="rounded-lg border border-[var(--wb-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--wb-hover)] disabled:opacity-50"
              :disabled="store.saving"
              @click="store.saveDraft()"
            >
              {{ store.saving ? '保存中…' : '保存草稿' }}
            </button>
            <button
              class="rounded-lg bg-[var(--wb-primary)] px-2.5 py-1.5 text-xs font-medium text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)] disabled:opacity-50"
              :disabled="store.submitting || !store.editing"
              @click="store.submitDraft()"
            >
              {{ store.submitting ? '提交中…' : '提交' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
