<template>
  <div class="wb-page pu-view" data-act="purchase-panel">
    <!-- 子视图：同一件事的两面 —— 「还要拿什么货」与「已经开了哪些拿货单」。
         用分段控件（`.wb-seg`）而不是第二层页签栏：它们不是两个页面，是同一页的两个视图。
         2026-10-10 重设计：顶部指标条撤掉，**各自就地给数**（要拿什么 → 清单条上的
         「待拿 N 款色 · N 件 · 预估 ¥」；拿了什么 → 面板头「N 张 · N 张草稿待提交 · 已提交 ¥」）。
         分段上的徽章随之撤掉 —— 数字就在正下方同一处，写两遍只是噪声。 -->
    <div class="wb-seg pu-sub" data-act="pu-sub">
      <button
        type="button"
        class="wb-seg__item"
        :class="{ 'is-on': sub === 'pick' }"
        data-act="pu-sub-pick"
        @click="sub = 'pick'"
      >
        要拿什么
      </button>
      <button
        type="button"
        class="wb-seg__item"
        :class="{ 'is-on': sub === 'orders' }"
        data-act="pu-sub-orders"
        @click="sub = 'orders'"
      >
        拿了什么
      </button>
      <span v-if="loading" class="wb-muted pu-loading" data-act="pu-loading">读取中…</span>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="pu-error">{{ error }}</p>

    <!-- ============ 视图 A：要拿什么（拣货清单；开单按钮在**厂家段尾**） ============ -->
    <template v-if="sub === 'pick'">
      <!-- 同一份整页视图（`embedded` 藏页头、`auto` 进页即生成、`row-action` 借宿主的确认弹层做忽略、
           `supplier-action` 段尾给「生成拿货单（N 件）」）。不复制一份精简版 —— 同一件事两处摆，
           迟早两套口径（2026-10-05 岛内「拣货」页签发布前撤回就是这个理由）。
           ⚠️ 开单按钮**钉在厂家段上**：一张拿货单只能挂一个厂家（下游按厂家发单 / 对账），
              原先"页级按钮 + 先选一个厂家"的那一步对用户是白问的 —— 数据里已经分好段了。 -->
      <PickingView
        embedded
        auto
        row-action
        supplier-action
        :refresh-token="token"
        @go-import="go('import')"
        @generated="onPickRows"
        @ignore="askIgnore"
        @unignore="onUnignore"
        @supplier-action="onSupplierAction"
      />

      <!-- 已忽略：低频（标过就不该常来看），**折起来只占一行**；展开才出表。
           ⚠️ 表的 id（`pu-ignore-table`）保留 —— 展开后的断言仍按它选。 -->
      <section v-if="ignores.length" class="wb-panel">
        <button
          type="button"
          class="wb-panel__head pu-ignore-head"
          data-act="pu-ignore-toggle"
          :aria-expanded="showIgnores"
          @click="showIgnores = !showIgnores"
        >
          <span>已忽略 {{ ignores.length }} 项（无需补货）</span>
          <span class="wb-muted">按「款编码 + 款色」整组生效；取消后该款色所有尺码会重新回到缺口</span>
          <span class="pu-ignore-head__toggle">{{ showIgnores ? '收起' : '展开' }}</span>
        </button>
        <div v-if="showIgnores" class="wb-panel__body wb-table-wrap">
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

    <!-- ============ 视图 B：拿了什么（拿货单） ============ -->
    <template v-else>
      <section class="wb-panel">
        <div class="wb-panel__head">
          <!-- 就地给数：几张 / 几张草稿待提交 / 已提交多少钱（第三个数就是对账的"拿货"一侧） -->
          <span data-act="pu-orders-meta">{{ ordersMeta }}</span>
          <span class="wb-muted">草稿不计入缺口与对账；提交后才算已拿</span>
          <!-- 模式**创建时定死**（宿主 update 不接受 mode）⇒ 建单时就要选，所以两个按钮 ——
               给一个"建完再改"的下拉会是假动作。
               厂家下拉只服务于这里的「新建」；清单那边的开单按段分好厂家，不需要它。 -->
          <span class="pu-actions">
            <select
              v-model.number="newSupplierId"
              class="wb-input wb-input--sm"
              data-act="pu-supplier"
              :disabled="busyAll"
            >
              <option :value="0">选择厂家…</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
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
                <th class="wb-num">金额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in orders" :key="o.id">
                <td>{{ o.id }}</td>
                <td>{{ o.bizDate }}</td>
                <td>
                  <!-- 模式并进厂家格（原独立一列）：它是**这张单的性质**，不是每行各自的值 -->
                  {{ o.supplierName || '—' }}
                  <span
                    class="wb-tag"
                    :title="o.mode === 'package' ? '包价：只记总额' : '明细：按款色逐行记数量与单价'"
                  >
                    {{ o.mode === 'package' ? '包价' : '明细' }}
                  </span>
                </td>
                <td class="wb-num">¥{{ money(o.totalCents) }}</td>
                <td>
                  <span class="wb-tag" :class="o.status === 'submitted' ? 'is-on' : 'is-warn'">
                    {{ o.status === 'submitted' ? '已提交' : '草稿' }}
                  </span>
                </td>
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
            拿货单是"这批货从哪个厂家拿、各拿几件、单价多少"的记录。最省事的开法：去「要拿什么」，
            对着要发的厂家点「生成拿货单」—— 按清单开好草稿并直接进去填单价。
          </p>
          <div class="wb-empty__actions">
            <button
              type="button"
              class="wb-btn wb-btn--primary"
              data-act="pu-goto-pick"
              @click="sub = 'pick'"
            >
              去看要拿什么
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
// 「拿货」页签 = 发货流程第 4 步（2026-10-05 从「订单归类」岛的「拿货对账」页内建过来；
// 2026-10-10 把原第 3 步「生成拣货单」并了进来 —— 见下）。
//
// **为什么把拣货单并进来**（用户 2026-10-10）：拣货清单按「厂家 / 款 × 色 × 码 / 图 / 进价」汇总，
// 而"拿货"要的正是这张单 —— 原第 3 步生成完清单，第 5 步拿货**又得从头理一遍**
// （拿货页只有款色码，图与进价一概没有），于是同一件事在两个步骤里各算一次，口径还不同
// （清单是"未发货 · 近 30 天"，缺口是"全部订单"）。合并后一条链是：
// **要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账**。
//
// **2026-10-10 重设计（简洁直观）**：本页原先顶上一条四格指标条 + 视图 A 再一条"选厂家 / 选日期 /
// 按此生成"的行动区 —— 两排控件都在问"拿多少、开哪张单"，读起来是同一件事说了两遍。
// 现在：① 指标条撤掉，数字**就地**给（清单条 / 面板头各报自己的数）
// ② 开单按钮**钉在厂家段上**（一张单一个厂家，段就是天然的分组，不必先选厂家）
// ③ 忽略清单折成一行（低频，展开才出表）④ 生成后**直接进编辑器**填价（下一步就是"录付了多少钱"）。
//
// **照功能不照样式**：移植自原「订单归类」岛的**拿货对账页**（原页 994 行；该岛已于 2026-10-05
// 整体下架，源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的
// `.panel/.bar/.btn` 一套；内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
// 功能映射（岛 → 本页）：供应商**只读**（维护在「货与成本 › 供应商」，本页只做参照，同岛内 2026-09-28 的处置）
// · 拿货单列表/新建/编辑/提交/删除/导出 · 要拿什么（拣货清单 + 按段开单）· 忽略清单 · 单价记忆。
// **付款与对账留在第 5 步**（`ReconPanel.vue`）—— 岛把它们和拿货挤在一页，本页按流程拆开。
//
// 数据层**零新增**：全部走宿主现成的 `purchase*` 通道（能力域 `purchase`，见 `plugin/host.ts` 的 `DB_OPS`）。
// 清单本身仍由 `@/modules/picking/PickingView.vue` 出（**不复制一份**），本页只做"开单意图 + 忽略清单"。
import { computed, onMounted, ref, watch } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import type { IgnoreRow, PurchaseOrder, Supplier } from '@/types';
import { pendingOf, type PickingGroup } from '@/lib/picking';
import { useShipping } from '../flowCtx';
import PurchaseOrderEditor from './PurchaseOrderEditor.vue';
import PickingView from '@/modules/picking/PickingView.vue';
import {
  addIgnore,
  createOrder,
  deleteOrder,
  ensureSchema,
  exportOrderXlsx,
  getOrder,
  listIgnores,
  listOrders,
  listSuppliers,
  localDay,
  money,
  removeIgnore,
  submitOrder,
} from '../purchase';

const { token, go, bump } = useShipping();

const sub = ref<'pick' | 'orders'>('pick');
const loading = ref(false);
const error = ref('');
const busy = ref(false);

const orders = ref<PurchaseOrder[]>([]);
const ignores = ref<IgnoreRow[]>([]);
const suppliers = ref<Supplier[]>([]);
/** 已忽略表默认收起（低频，见模板注释） */
const showIgnores = ref(false);

const newSupplierId = ref(0);

/** 清单（由 `PickingView` 的 `generated` 事件交过来，**不在这里重算**：同一件事只能有一处算） */
const pickRows = ref<PickingGroup[]>([]);

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
/** 写操作或读取中都不许再点（`busy` 是本次写、`loading` 是重取 —— 两种都会让按钮的结果过期） */
const busyAll = computed(() => busy.value || loading.value);

/** 「拿了什么」就地给数：几张 / 几张草稿 / 已提交多少钱（**草稿不计入**，与下面那句说明同一口径） */
const ordersMeta = computed(() => {
  if (!orders.value.length) return '拿货单';
  const submitted = orders.value
    .filter((o) => o.status === 'submitted')
    .reduce((a, o) => a + (Number(o.totalCents) || 0), 0);
  return `${orders.value.length} 张 · ${draftCount.value} 张草稿待提交 · 已提交 ¥${money(submitted)}`;
});

function supplierNameOf(id: number): string {
  return suppliers.value.find((s) => s.id === id)?.name ?? '';
}

/** 清单交过来了（`PickingView` 每次重算都会发）—— 只存起来给「按段开单」用 */
function onPickRows(groups: PickingGroup[]): void {
  pickRows.value = groups;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await ensureSchema();
    const [os, ig, sp] = await Promise.all([listOrders(), listIgnores(), listSuppliers()]);
    orders.value = os;
    ignores.value = ig;
    suppliers.value = sp;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取拿货数据失败';
  } finally {
    loading.value = false;
  }
}

/** 段尾「生成拿货单（N 件）」的意图（`PickingView` 只发厂家 id） */
function onSupplierAction(supplierId: number): void {
  void createFromPick(supplierId);
}

/**
 * **按清单给这家厂生成草稿拿货单**（要拿什么 → 拿了什么）。
 *
 * 入参是"这家厂、未忽略、还差 > 0"的行 —— 判据走 lib 的 `pendingOf`（与段尾按钮上的 N 件**同源**），
 * 不在这里自己 filter：两处各写一遍过滤，迟早出现"按钮说 12 件、单里 14 件"。
 *
 * 单价留 0：进价是**估算**（`ae_cost_map`），实拿价要用户去编辑器里填（或点「取最近价」按历史价回填）
 * —— 把估算价当成付出去的钱落库，对账那一层就永远对不上。
 * `suggestionQty = 还差`：编辑器里显示"建议 X 件"，作为实拿数量的参照。
 *
 * 生成后**立刻切到「拿了什么」并打开编辑器**：
 *   · 切视图：草稿**不**扣"还差"（已拿只认已提交）—— 留在「要拿什么」会看到数字没变，
 *     读成"没生成成功"再点一次 ⇒ 重复草稿；
 *   · 开编辑器：这条链的下一步就是"录付了多少钱"，新单的价格全是 0，就地填掉。
 */
async function createFromPick(supplierId: number): Promise<void> {
  const rows = pendingOf(pickRows.value, supplierId);
  if (!rows.length) return toast('这家厂没有要拿的货', 'error');
  busy.value = true;
  error.value = '';
  try {
    const r = await createOrder({
      supplierId,
      bizDate: localDay(),
      mode: 'detail',
      items: rows.map((g) => ({
        styleCode: g.styleCode,
        styleName: g.styleName,
        color: g.color,
        size: g.size,
        qty: g.remaining,
        priceCents: 0,
        suggestionQty: g.remaining,
      })),
    });
    sub.value = 'orders';
    bump();
    toast(`已生成拿货单 #${r.id}（草稿）—— 填好单价再提交`, 'success');
    await openEditor(r.id);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '生成拿货单失败';
  } finally {
    busy.value = false;
  }
}

/** 空白单（厂家在视图 B 的下拉里选）—— 建完同样直接进编辑器：建单的下一步总是"填进去" */
async function createEmpty(mode: 'detail' | 'package'): Promise<void> {
  if (!newSupplierId.value) return toast('先选一个厂家', 'error');
  busy.value = true;
  try {
    const r = await createOrder({
      supplierId: newSupplierId.value,
      bizDate: localDay(),
      mode,
      items: [],
    });
    toast(`已创建空白拿货单 #${r.id}`, 'success');
    bump();
    await openEditor(r.id);
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
  const isPkg = o.mode === 'package';
  confirm.value = {
    title: `提交拿货单 #${o.id}？`,
    body: [
      `厂家 ${o.supplierName} · 金额 ¥${money(o.totalCents)}`,
      isPkg
        ? '提交后这张单才算「已拿」：金额进入厂家对账；包价单没有明细，不扣拿货缺口、不影响成本。'
        : '提交后这张单才算「已拿」：拿货缺口会按它扣减，「要拿什么」的“还差”跟着少，金额进入对账，成本会同步到「算钱」。',
      '提交后仍可继续编辑。',
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
  const effect =
    o.status !== 'submitted'
      ? '草稿不计入缺口与对账 —— 删除只影响这张单自己。'
      : o.mode === 'package'
        ? '删除后这张单的金额从厂家对账里移除（包价单不涉及拿货缺口与成本）。'
        : '删除后已拿数量会自动回滚：拿货缺口随之回升，对账金额与成本同步减少。';
  confirm.value = {
    title: `删除拿货单 #${o.id}？`,
    body: [
      `厂家 ${o.supplierName} · 金额 ¥${money(o.totalCents)} · ${o.status === 'submitted' ? '已提交' : '草稿'}`,
      effect,
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

/**
 * 忽略某一款色（**意图来自清单的行尾**，「要拿什么」视图里点，不在这里自己找行）。
 *
 * 为什么要确认弹层 + 原因输入：忽略是"这一款色不再补货"，影响的是**所有尺码**
 * （`ignoreKey` 里没有码），且它会让缺口数字变小 —— 静默生效会被读成"货自动拿齐了"。
 * Electron 没有 `window.prompt`，自绘。
 */
function askIgnore(r: { styleCode: string; color: string; remaining: number }): void {
  const where = [r.styleCode, r.color].filter(Boolean).join(' · ');
  confirm.value = {
    title: '标记「无需补货」？',
    body: [
      `${where} · 还差 ${r.remaining} 件（含全部尺码）`,
      '标记后这一款色不再出现在「要拿什么」里，也会从拿货缺口里消失。已线下拿、放弃、退单都适合标它。',
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

/** 取消忽略（清单行尾与忽略清单里的「取消忽略」都走它）—— 撤销没有不可逆后果，不必再确认 */
async function unignore(r: IgnoreRow | { styleCode: string; color: string }): Promise<void> {
  try {
    await removeIgnore({ styleCode: r.styleCode, color: r.color });
    toast(`已取消忽略 ${r.styleCode}${r.color ? ' ' + r.color : ''}`, 'success');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '取消忽略失败', 'error');
  }
}

/** 行尾「取消忽略」的入参形状（`PickingView` 只发意图，不带 reason/createdAt） */
function onUnignore(r: { styleCode: string; color: string }): void {
  void unignore(r);
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
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了拿货数据）就重取本页数据。
// ⚠️ 清单那一半不用管 —— `PickingView` 自己 watch 同一个 `token`（它是清单的唯一出处）。
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

/* 面板头右侧的动作区：`margin-left:auto` 把它推到最右（`.wb-panel__head` 是 flex，无此工具类） */
.pu-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}

/* 已忽略的折叠头：是一个**按钮**（整行可点），但要长得跟 `.wb-panel__head` 一样 ——
   button 自带居中 / 边框 / 内边距，逐条抵消掉。 */
.pu-ignore-head {
  width: 100%;
  text-align: left;
  cursor: pointer;
  background: none;
}

.pu-ignore-head__toggle {
  margin-left: auto;
  font-weight: 400;
  color: var(--wb-primary);
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
