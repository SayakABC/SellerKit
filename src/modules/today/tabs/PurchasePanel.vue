<template>
  <div class="wb-page pu-view" data-act="purchase-panel">
    <!-- 指标条：全是**计数**（有多少活），金额归对账页。
         ⚠️ 每格必须是「标签 + 空格 + <b>数字</b>」同一串文本（冒烟按 textContent 取子串）。 -->
    <div class="wb-metabar pu-stats" data-act="pu-stats">
      <span class="wb-metric">拿货单 <b>{{ orders.length }}</b></span>
      <span class="wb-metric">草稿 <b>{{ draftCount }}</b></span>
      <span class="wb-metric" :class="{ 'is-warn': gaps.length > 0 }" data-act="pu-metric-gap">
        待拿货缺口 <b>{{ gaps.length }}</b>
      </span>
      <span class="wb-metric">已忽略 <b>{{ ignores.length }}</b></span>
    </div>

    <!-- 子视图：同一件事的两面 —— 「还差什么货没拿」与「已经开了哪些拿货单」。
         用分段控件（`.wb-seg`）而不是第二层页签栏：它们不是两个页面，是同一页的两个视图。 -->
    <div class="wb-seg pu-sub" data-act="pu-sub">
      <button
        type="button"
        class="wb-seg__item"
        :class="{ 'is-on': sub === 'gap' }"
        data-act="pu-sub-gap"
        @click="sub = 'gap'"
      >
        待拿货缺口
        <span v-if="gaps.length" class="wb-seg__badge">{{ gaps.length }}</span>
      </button>
      <button
        type="button"
        class="wb-seg__item"
        :class="{ 'is-on': sub === 'orders' }"
        data-act="pu-sub-orders"
        @click="sub = 'orders'"
      >
        拿货单
        <span class="wb-seg__badge wb-seg__badge--plain">{{ orders.length }}</span>
      </button>
      <span v-if="loading" class="wb-muted pu-loading" data-act="pu-loading">读取中…</span>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="pu-error">{{ error }}</p>

    <!-- ============ 视图 A：待拿货缺口（拿货的来源） ============ -->
    <template v-if="sub === 'gap'">
      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>待拿货缺口</span>
          <span class="wb-muted">缺口 = 订单需求 − 已拿（按款色码；已忽略的不再出现）</span>
          <!-- 生成区：厂家**不预选**（默认值不能靠位置 —— 有 3 个厂家时预选第一个
               会静默把单开给错的厂），日期默认今天（可改）。 -->
          <span class="pu-actions">
            <select v-model.number="newSupplierId" class="wb-input wb-input--sm" data-act="pu-supplier">
              <option :value="0">选择厂家…</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <input v-model="newBizDate" class="wb-input wb-input--sm" type="date" data-act="pu-date" />
            <button
              type="button"
              class="wb-btn wb-btn--primary wb-btn--sm"
              data-act="pu-create-from-gap"
              :disabled="busyAll || !picked.length || !newSupplierId"
              @click="createFromGap"
            >
              生成拿货单（{{ picked.length }}）
            </button>
          </span>
        </div>
        <div v-if="gaps.length" class="wb-panel__body wb-table-wrap">
          <table class="wb-table pu-table" data-act="pu-gap-table">
            <thead>
              <tr>
                <th class="pu-check">
                  <input
                    type="checkbox"
                    data-act="pu-gap-all"
                    :checked="allPicked"
                    :disabled="!gaps.length"
                    @change="toggleAll"
                  />
                </th>
                <th>款编码</th>
                <th>名称</th>
                <th>颜色</th>
                <th>尺码</th>
                <th class="wb-num">需求</th>
                <th class="wb-num">已拿</th>
                <th class="wb-num">还差</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in gaps" :key="gapKey(r)">
                <td class="pu-check">
                  <input
                    type="checkbox"
                    :data-act="`pu-gap-pick-${i}`"
                    :checked="picked.includes(gapKey(r))"
                    @change="togglePick(gapKey(r))"
                  />
                </td>
                <td class="wb-mono">{{ r.styleCode || '—' }}</td>
                <td>{{ r.styleName || '—' }}</td>
                <td>{{ r.color || '—' }}</td>
                <td>{{ r.size || '—' }}</td>
                <td class="wb-num">{{ r.demand }}</td>
                <td class="wb-num">{{ r.taken }}</td>
                <td class="wb-num pu-num--warn">{{ r.missing }}</td>
                <td>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-ignore-${i}`"
                    @click="askIgnore(r)"
                  >
                    忽略
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="wb-empty" data-act="pu-gap-none">
          <p class="wb-empty__title">没有待拿的货</p>
          <p class="wb-empty__desc">
            这里的缺口由订单推出来：订单库里有多少件、减掉已提交拿货单已拿的件数。
            没有缺口说明订单还没导入，或者该拿的都拿过了。
          </p>
          <div class="wb-empty__actions">
            <button type="button" class="wb-btn" data-act="pu-goto-import" @click="go('import')">
              去导入订单
            </button>
          </div>
        </div>
      </section>

      <section v-if="ignores.length" class="wb-panel">
        <div class="wb-panel__head">
          <span>已忽略（无需补货）</span>
          <span class="wb-muted">按「款编码 + 款色」整组生效；取消后该款色所有尺码会重新回到缺口</span>
        </div>
        <div class="wb-panel__body wb-table-wrap">
          <table class="wb-table" data-act="pu-ignore-table">
            <thead>
              <tr>
                <th>款编码</th>
                <th>款色</th>
                <th>原因</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in ignores" :key="`${r.styleCode}|${r.color}`">
                <td class="wb-mono">{{ r.styleCode }}</td>
                <td>{{ r.color || '（全部色）' }}</td>
                <td class="wb-muted">{{ r.reason || '—' }}</td>
                <td>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-unignore-${i}`"
                    @click="unignore(r)"
                  >
                    取消忽略
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- ============ 视图 B：拿货单 ============ -->
    <template v-else>
      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>拿货单</span>
          <span class="wb-muted">草稿不计入对账与缺口；提交后才算已拿</span>
          <!-- 模式**创建时定死**（宿主 update 不接受 mode）⇒ 建单时就要选，所以这里两个按钮。
               给一个"建完再改"的下拉会是假动作。 -->
          <span class="pu-actions">
            <button
              type="button"
              class="wb-btn wb-btn--sm"
              data-act="pu-new-detail"
              :disabled="busyAll || !newSupplierId"
              @click="createEmpty('detail')"
            >
              新建明细单
            </button>
            <button
              type="button"
              class="wb-btn wb-btn--sm"
              data-act="pu-new-package"
              :disabled="busyAll || !newSupplierId"
              @click="createEmpty('package')"
            >
              新建包价单
            </button>
          </span>
        </div>
        <div v-if="orders.length" class="wb-panel__body wb-table-wrap">
          <table class="wb-table" data-act="pu-order-table">
            <thead>
              <tr>
                <th>#</th>
                <th>日期</th>
                <th>厂家</th>
                <th>模式</th>
                <th class="wb-num">金额</th>
                <th>状态</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in orders" :key="o.id">
                <td>{{ o.id }}</td>
                <td>{{ o.bizDate }}</td>
                <td>{{ o.supplierName || '—' }}</td>
                <td>
                  <span class="wb-tag" :title="o.mode === 'package' ? '包价：只记总额' : '明细：按款色逐行记数量与单价'">
                    {{ o.mode === 'package' ? '包价' : '明细' }}
                  </span>
                </td>
                <td class="wb-num">¥{{ money(o.totalCents) }}</td>
                <td>
                  <span class="wb-tag" :class="o.status === 'submitted' ? 'is-on' : 'is-warn'">
                    {{ o.status === 'submitted' ? '已提交' : '草稿' }}
                  </span>
                </td>
                <td class="wb-muted">{{ o.note || '—' }}</td>
                <td class="pu-ops">
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-edit-${o.id}`"
                    @click="openEditor(o.id)"
                  >
                    查看 / 编辑
                  </button>
                  <button
                    v-if="o.status !== 'submitted'"
                    type="button"
                    class="wb-link"
                    :data-act="`pu-submit-${o.id}`"
                    @click="askSubmit(o)"
                  >
                    提交
                  </button>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-export-${o.id}`"
                    @click="exportOrder(o)"
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    class="wb-link wb-link--danger"
                    :data-act="`pu-del-${o.id}`"
                    @click="askDelete(o)"
                  >
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="wb-empty" data-act="pu-order-none">
          <p class="wb-empty__title">还没有拿货单</p>
          <p class="wb-empty__desc">
            拿货单是"这批货从哪个厂家拿、各拿几件、单价多少"的记录。最省事的开法：去
            待拿货缺口勾选要拿的款色，一键生成草稿，再逐行填单价。
          </p>
          <div class="wb-empty__actions">
            <button type="button" class="wb-btn wb-btn--primary" data-act="pu-goto-gap" @click="sub = 'gap'">
              去待拿货缺口
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- 明细编辑抽屉：改的是一张单的**明细行**，列表要保持可见（对照着改） -->
    <PurchaseOrderEditor
      v-if="editing"
      :order="editing"
      :supplier-name="supplierNameOf(editing.supplierId)"
      @close="editing = null"
      @saved="onSaved"
    />

    <!-- 确认弹层：一个组件承担三种确认（提交 / 删除 / 忽略），内容与后果交给调用方写 -->
    <ConfirmDialog
      v-if="confirm"
      :title="confirm.title"
      :confirm-text="confirm.okText"
      :danger="confirm.danger"
      :busy="busy"
      @close="confirm = null"
      @confirm="runConfirm"
    >
      <p v-for="(line, i) in confirm.body" :key="i">{{ line }}</p>
      <label v-if="confirm.input" class="wb-field pu-field">
        <span class="wb-field__label">{{ confirm.input.label }}</span>
        <input
          v-model="confirmInput"
          class="wb-input"
          data-act="pu-ignore-reason"
          :placeholder="confirm.input.placeholder"
        />
      </label>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「拿货」页签 = 发货流程第 5 步（2026-10-05 从「订单归类」岛的「拿货对账」页内建过来）。
//
// **照功能不照样式**：移植自原「订单归类」岛的**拿货对账页**（原页 994 行；该岛已于 2026-10-05
// 整体下架，源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的
// `.panel/.bar/.btn` 一套；内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
// 功能映射（岛 → 本页）：供应商**只读**（维护在「货与成本 › 供应商」，本页只做参照，同岛内 2026-09-28 的处置）
// · 拿货单列表/新建/编辑/提交/删除/导出 · 待拿货缺口 + 忽略清单 · 单价记忆（编辑器里的「取最近价」）。
// **付款与对账留在第 6 步**（`ReconPanel.vue`）—— 岛把它们和拿货挤在一页，本页按流程拆开。
//
// 数据层**零新增**：全部走宿主现成的 `purchase*` 通道（能力域 `purchase`，见 `plugin/host.ts` 的 `DB_OPS`）。
import { computed, onMounted, ref, watch } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import type { IgnoreRow, OutstandingRow, PurchaseOrder, Supplier } from '@/types';
import { useShipping } from '../flowCtx';
import PurchaseOrderEditor from './PurchaseOrderEditor.vue';
import {
  addIgnore,
  createOrder,
  deleteOrder,
  ensureSchema,
  exportOrderXlsx,
  gapKey,
  getOrder,
  listIgnores,
  listOrders,
  listSuppliers,
  localDay,
  money,
  outstanding,
  removeIgnore,
  submitOrder,
} from '../purchase';

const { token, go, bump } = useShipping();

const sub = ref<'gap' | 'orders'>('gap');
const loading = ref(false);
const error = ref('');
const busy = ref(false);

const orders = ref<PurchaseOrder[]>([]);
const gaps = ref<OutstandingRow[]>([]);
const ignores = ref<IgnoreRow[]>([]);
const suppliers = ref<Supplier[]>([]);

const newSupplierId = ref(0);
const newBizDate = ref(localDay());
/** 勾选进拿货单的缺口行（键 = 款编码|款色|尺码） */
const picked = ref<string[]>([]);

const editing = ref<PurchaseOrder | null>(null);

type ConfirmSpec = {
  title: string;
  body: string[];
  okText: string;
  danger?: boolean;
  input?: { label: string; placeholder: string };
  run: (input: string) => Promise<void>;
};
const confirm = ref<ConfirmSpec | null>(null);
const confirmInput = ref('');

const draftCount = computed(() => orders.value.filter((o) => o.status !== 'submitted').length);
const allPicked = computed(() => gaps.value.length > 0 && picked.value.length === gaps.value.length);
/** 写操作或读取中都不许再点（`busy` 是本次写、`loading` 是重取 —— 两种都会让按钮的结果过期） */
const busyAll = computed(() => busy.value || loading.value);

function supplierNameOf(id: number): string {
  return suppliers.value.find((s) => s.id === id)?.name ?? '';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await ensureSchema();
    const [os, gs, ig, sp] = await Promise.all([
      listOrders(),
      outstanding(),
      listIgnores(),
      listSuppliers(),
    ]);
    orders.value = os;
    gaps.value = gs;
    ignores.value = ig;
    suppliers.value = sp;
    // 勾选态跟着数据走：重取后把已不在缺口里的键剔掉，并**默认全勾**
    //（进这一步的语义就是"这些是还差的货"；要不要少拿几条，用户自己取消勾选）
    picked.value = gs.map(gapKey);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取拿货数据失败';
  } finally {
    loading.value = false;
  }
}

function toggleAll(e: Event): void {
  picked.value = (e.target as HTMLInputElement).checked ? gaps.value.map(gapKey) : [];
}

function togglePick(key: string): void {
  picked.value = picked.value.includes(key)
    ? picked.value.filter((k) => k !== key)
    : [...picked.value, key];
}

/** 勾选 → 草稿拿货单。单价留 0，去编辑器里逐行填（或点「取最近价」按历史价回填）。 */
async function createFromGap(): Promise<void> {
  if (!newSupplierId.value) return toast('先选一个厂家', 'error');
  const rows = gaps.value.filter((g) => picked.value.includes(gapKey(g)));
  if (!rows.length) return toast('先勾选要拿的款色', 'error');
  busy.value = true;
  error.value = '';
  try {
    const r = await createOrder({
      supplierId: newSupplierId.value,
      bizDate: newBizDate.value,
      mode: 'detail',
      note: '',
      items: rows.map((g) => ({
        styleCode: g.styleCode,
        styleName: g.styleName,
        color: g.color,
        size: g.size,
        qty: g.missing,
        priceCents: 0,
        // 建议数量 = 缺口：编辑器里显示"建议 X 件"，作为实拿数量的参照
        suggestionQty: g.missing,
      })),
    });
    toast(`已生成拿货单 #${r.id}（草稿）—— 去「拿货单」填单价`, 'success');
    sub.value = 'orders';
    bump();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '生成拿货单失败';
  } finally {
    busy.value = false;
  }
}

async function createEmpty(mode: 'detail' | 'package'): Promise<void> {
  if (!newSupplierId.value) return toast('先选一个厂家', 'error');
  busy.value = true;
  try {
    const r = await createOrder({
      supplierId: newSupplierId.value,
      bizDate: newBizDate.value,
      mode,
      note: '',
      items: [],
    });
    toast(`已创建空白拿货单 #${r.id}`, 'success');
    sub.value = 'orders';
    bump();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '创建失败';
  } finally {
    busy.value = false;
  }
}

async function openEditor(id: number): Promise<void> {
  try {
    editing.value = await getOrder(id);
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '打开拿货单失败', 'error');
  }
}

function onSaved(): void {
  editing.value = null;
  toast('拿货单已保存', 'success');
  bump();
}

function askSubmit(o: PurchaseOrder): void {
  confirm.value = {
    title: `提交拿货单 #${o.id}？`,
    body: [
      `厂家 ${o.supplierName} · 金额 ¥${money(o.totalCents)}`,
      '提交后这张单才算「已拿」：待拿货缺口会按它扣减，金额进入对账，成本会同步到「算钱」。',
      '提交后仍可继续编辑（改动会立刻反映到对账与缺口）。',
    ],
    okText: '提交',
    danger: false,
    run: async () => {
      await submitOrder(o.id);
      toast('已提交', 'success');
      bump();
    },
  };
}

function askDelete(o: PurchaseOrder): void {
  confirm.value = {
    title: `删除拿货单 #${o.id}？`,
    body: [
      `厂家 ${o.supplierName} · 金额 ¥${money(o.totalCents)} · ${o.status === 'submitted' ? '已提交' : '草稿'}`,
      '删除后已拿数量会自动回滚：待拿货缺口随之回升，对账金额与成本同步减少。',
    ],
    okText: '删除',
    danger: true,
    run: async () => {
      await deleteOrder(o.id);
      toast('已删除', 'success');
      bump();
    },
  };
}

function askIgnore(r: OutstandingRow): void {
  const where = [r.styleCode, r.color, r.size].filter(Boolean).join(' · ');
  confirm.value = {
    title: '标记「无需补货」？',
    body: [
      `${where}（还差 ${r.missing} 件）`,
      '标记后这一款色（含全部尺码）不再出现在缺口里。已线下拿、放弃、退单都适合标它。',
    ],
    okText: '标记忽略',
    danger: false,
    input: { label: '原因（选填）', placeholder: '如：已线下拿 / 放弃 / 退单' },
    run: async (input) => {
      await addIgnore({ styleCode: r.styleCode, color: r.color, reason: input.trim() });
      toast(`已忽略 ${where}`, 'success');
      bump();
    },
  };
}

async function unignore(r: IgnoreRow): Promise<void> {
  try {
    await removeIgnore({ styleCode: r.styleCode, color: r.color });
    toast(`已取消忽略 ${r.styleCode}${r.color ? ' ' + r.color : ''}`, 'success');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '取消忽略失败', 'error');
  }
}

async function runConfirm(): Promise<void> {
  const spec = confirm.value;
  if (!spec) return;
  busy.value = true;
  try {
    await spec.run(confirmInput.value);
    confirm.value = null;
    confirmInput.value = '';
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '操作失败', 'error');
  } finally {
    busy.value = false;
  }
}

/** 导出这张单的明细（主进程生成 xlsx，款色图自动嵌入）；用户取消向导不算错 */
async function exportOrder(o: PurchaseOrder): Promise<void> {
  try {
    const path = await exportOrderXlsx({
      items: o.items,
      defaultName: `拿货单-${o.supplierName || o.id}-${o.bizDate}`,
    });
    if (path) toast('已导出', 'success');
    else toast('已取消导出', 'info');
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '导出失败', 'error');
  }
}

onMounted(() => void load());
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了拿货数据）就重取本页数据
watch(
  () => token.value,
  () => void load()
);

// `loading` 只用于禁用按钮；`suppliers` 变了要保证已选项仍然有效（厂家被删掉的情况）
watch(suppliers, (list) => {
  if (newSupplierId.value && !list.some((s) => s.id === newSupplierId.value)) newSupplierId.value = 0;
});
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.pu-view {
  gap: 12px;
}

.pu-sub {
  align-self: flex-start;
}

.pu-loading {
  align-self: center;
  margin-left: 10px;
  font-size: 12px;
}

.pu-stats {
  flex-shrink: 0;
}

/* 面板头右侧的动作区：`margin-left:auto` 把它推到最右（`.wb-panel__head` 是 flex，无此工具类） */
.pu-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}

.pu-check {
  width: 32px;
}

.pu-num--warn {
  color: var(--wb-warning);
}

/* 操作列：4 个文字动作排一行，窄窗口下允许换行 */
.pu-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.pu-field {
  margin-top: 10px;
}
</style>
