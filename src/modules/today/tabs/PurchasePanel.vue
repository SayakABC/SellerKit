<template>
  <div class="wb-page pu-view" data-act="purchase-panel">
    <!-- 顶部（2026-10-17 第五轮）：概览文案与「新建空白单」（选择厂家 / 明细 / 包价）都按用户要求
         **整块撤掉** —— 开单只剩厂家卡上的「生成拿货单（N 件）」（走清单，数字口径同源）。
         页级只剩读取中提示。 -->
    <p v-if="loading" class="wb-muted pu-loading" data-act="pu-loading">读取中…</p>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="pu-error">{{ error }}</p>

    <!-- 按单核对（2026-10-22 新增）：回答"拿完货了，哪些单可以发了"。
         以前这一页只能看到**款色码**级别的缺口 —— 拿齐的款色直接从卡上消失，没有"已齐"可回看，
         更说不出是哪张订单齐了（拿货明细没有订单号）。现在拿货单会把"这 N 件补给哪一行订单行"
         记在 `purchase_sources.order_item_id` 上，于是"这张单齐了"成了事实。
         ⚠️ **撤掉的东西别加回来**：这里不做"标记已发货"按钮。发货时点是平台回传的
            （`oi_orders.ship_time` 来自导入报表），应用内没有这个动作 —— 造一个本地开关
            只会和平台数据打架。这里只回答"货到齐了没有"。
         ⚠️ 折叠头就带着答案（可以发货 N 单 / 还差 N 单），展开才看**是哪几单** ——
            拿货页的主活是开单，别让一长串订单号把厂家卡压到屏幕外。 -->
    <section v-if="cover.orders > 0 || coverError" class="wb-panel pu-cover" data-act="pu-cover">
      <button
        type="button"
        class="wb-panel__head pu-cover-head"
        data-act="pu-cover-toggle"
        :aria-expanded="showCover"
        @click="showCover = !showCover"
      >
        <span>按单核对</span>
        <span v-if="cover.orders" class="pu-cover-head__sum" data-act="pu-cover-sum">
          可以发货 <b>{{ cover.done }}</b> 单 · 还差 <b>{{ cover.partial }}</b> 单
        </span>
        <span v-else-if="coverError" class="pu-cover-head__err" data-act="pu-cover-error">
          {{ coverError }}
        </span>
        <span class="pu-cover-head__toggle">{{ showCover ? '收起' : '展开' }}</span>
      </button>

      <div v-if="showCover" class="wb-panel__body">
        <p class="pu-cover-note wb-muted" data-act="pu-cover-note">
          按已提交拿货单记下的订单行判定 · 共 {{ cover.pieces }} 件，已拿 {{ cover.covered }} 件
        </p>
        <!-- 推算成分必须说出来：加 `order_item_id` 之前的拿货单没记订单归属，
             那部分只能按款色总量摊 —— 是推定，不是事实。 -->
        <p v-if="cover.estimated" class="pu-cover-warn" data-act="pu-cover-estimated">
          有历史拿货单没记订单归属，这部分按款色总量推算，"齐了"可能提前 1~2 件出现
        </p>

        <!-- 可以发货（用户要的就是这一段，放前面） -->
        <div class="pu-cover-seg" data-act="pu-cover-done">
          <h3 class="pu-cover-seg__title">可以发货 {{ doneOrders.length }} 单</h3>
          <p v-if="!doneOrders.length" class="pu-cover-seg__empty wb-muted">
            还没有拿齐的单 —— 下面的「还差」里补齐就能发
          </p>
          <ul v-else class="pu-cover-list">
            <li
              v-for="(o, i) in doneOrders"
              :key="`d-${o.orderNo}-${i}`"
              class="pu-cover-item"
              data-act="pu-cover-done-item"
            >
              <span class="pu-cover-item__no wb-mono">{{ o.orderNo || '（无单号）' }}</span>
              <span class="pu-cover-item__shop">{{ o.shop || '—' }}</span>
              <span class="pu-cover-item__meta">{{ o.pieces }} 件</span>
              <span v-if="o.estimated" class="pu-cover-tag">推算</span>
            </li>
          </ul>
        </div>

        <!-- 还差什么 -->
        <div class="pu-cover-seg" data-act="pu-cover-partial">
          <h3 class="pu-cover-seg__title">还差 {{ partialOrders.length }} 单</h3>
          <p v-if="!partialOrders.length" class="pu-cover-seg__empty wb-muted">
            全部齐了，按上面的单子发货就行
          </p>
          <ul v-else class="pu-cover-list">
            <li
              v-for="(o, i) in partialOrders"
              :key="`p-${o.orderNo}-${i}`"
              class="pu-cover-item pu-cover-item--partial"
              data-act="pu-cover-partial-item"
            >
              <div class="pu-cover-item__head">
                <span class="pu-cover-item__no wb-mono">{{ o.orderNo || '（无单号）' }}</span>
                <span class="pu-cover-item__shop">{{ o.shop || '—' }}</span>
                <span class="pu-cover-item__meta">还差 {{ o.remaining }} 件</span>
                <span v-if="o.unclassified" class="pu-cover-tag pu-cover-tag--warn">未识别款</span>
              </div>
              <div class="pu-cover-item__missing">
                <span v-for="(r, j) in missingOf(o)" :key="j" class="pu-cover-chip" data-act="pu-cover-chip">
                  {{ missingLabel(r) }}
                </span>
                <span
                  v-if="hiddenMissingOf(o)"
                  class="pu-cover-chip pu-cover-chip--more"
                  data-act="pu-cover-chip-more"
                >
                  还有 {{ hiddenMissingOf(o) }} 项
                </span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 厂家宫格（唯一视图）：同一份整页视图（`embedded` 藏页头、`auto` 进页即生成、`row-action`
         借宿主的确认弹层做忽略、`supplier-action` 卡尾给「生成拿货单（N 件）」）。
         不复制一份精简版 —— 同一件事两处摆，迟早两套口径（2026-10-05 岛内「拣货」页签发布前撤回就是这个理由）。
         ⚠️ 2026-10-17 合并后卡由 `PickingView` 渲染，宿主经 props 注入三样本视图没有的东西：
            各厂拿货单（卡上"已开单"那一截）/ 忽略原因（"暂不拿"瘦卡说清为什么）/ 厂家电话。
            单子上的动作（编辑/提交/导出/删除）本页**只收意图**（`order-action`）——
            确认弹层与写库都在这里，与既有的 `ignore` / `supplier-action` 同一规矩。 -->
    <PickingView
      embedded
      auto
      row-action
      supplier-action
      move-action
      fix-action
      :refresh-token="token"
      :supplier-orders="ordersBySupplier"
      :ignore-reasons="ignoreReasonMap"
      :supplier-phones="phoneMap"
      @go-import="go('import')"
      @generated="onPickRows"
      @ignore="askIgnore"
      @unignore="onUnignore"
      @supplier-action="onSupplierAction"
      @order-action="onOrderAction"
      @move-supplier="onMoveSupplier"
      @fix-unclassified="onFixUnclassified"
      @show-ignores="showIgnores = true"
    />

    <!-- 未归类 → 选产品（复用产品域的选择器：带图、可搜索，不在这里再实现一遍）。
         选完由本页写映射并回填该商品的历史订单（`reassignOrdersByItemIds` 在写映射时顺手做）。 -->
    <ProductPicker
      v-if="fixing"
      title="给这个商品指定产品"
      confirm-text="关联并归款"
      @close="fixing = null"
      @pick="onPickProduct"
    />

    <!-- 已忽略：**页级**（「暂不拿」瘦卡上的「忽略清单」链到这里）。
         低频（标过就不该常来看），**折起来只占一行**；展开才出表。
         ⚠️ 表的 id（`pu-ignore-table`）保留 —— 展开后的断言仍按它选。
         ⚠️ 2026-10-17 评审 P0：折叠头**只留标题**，生效范围那句挪进展开区（`pu-ignore-note`）——
            收起态用户要的只是"有几条"，后果说明是展开后看着表才需要的；
            且那句里的「款编码」是内部术语，不该每屏都挂在最显眼的一行。 -->
    <section v-if="ignores.length" class="wb-panel">
      <button
        type="button"
        class="wb-panel__head pu-ignore-head"
        data-act="pu-ignore-toggle"
        :aria-expanded="showIgnores"
        @click="showIgnores = !showIgnores"
      >
        <span>已忽略 {{ ignores.length }} 项（无需补货）</span>
        <span class="pu-ignore-head__toggle">{{ showIgnores ? '收起' : '展开' }}</span>
      </button>
      <div v-if="showIgnores" class="wb-panel__body">
        <p class="pu-ignore-note wb-muted" data-act="pu-ignore-note">
          按「款编码 + 款色」整组生效；取消后该款色所有尺码会重新回到缺口
        </p>
        <div class="wb-table-wrap">
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
      </div>
    </section>

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
// 「拿货」页签 = 发货流程第 3 步（2026-10-05 从「订单归类」岛的「拿货对账」页内建过来；
// 2026-10-10 把原第 3 步「生成拣货单」并了进来 —— 见下；2026-10-17 算钱整步撤出后由第 4 步顺位成第 3 步；
// 同日「要拿什么 / 拿了什么」两个子视图合并成"一家一卡"的单页 —— 见下）。
//
// **2026-10-17 合并重设计（要拿什么 × 拿了什么 → 按厂家 / 按订单）**：
// 用户方案是"拿货管理 = 概览条 + 厂家卡列表（待拿 / 暂不拿 / 已拿三态）"。按**当前项目基线**落地
// （照功能不照样式，没有数据支撑的功能不做）：
//   · 「标记已拿」= **生成拿货单 → 填价 → 提交**。拿货单本就是"照它付钱"的记录，
//     不新增开关 —— "拿没拿"由已提交的单说话，撤销 = 删单，缺口按它自动回滚；
//   · 「暂不拿」= 既有忽略机制（款色级 + 原因，`purchase_ignore`）—— 灰条 + 原因照方案做；
//   · 「一键拨号」= 桌面端复制号码（没有拨号能力，"一键"= 一键复制，粘到微信/拨号盘）；
//   · 「起批量提醒 / 缺量提示」**不做**：`suppliers` 表无起批数字段、也没有库存表 ——
//     没有数据的功能做出来只能是拍脑袋的数字。
// 于是本页 = 概览条（待拿 N 款色 · N 件 · 涉及 N 家 · N 单 · 上次拿货 X + 新建空白单）
//   + 厂家宫格（`PickingView`：待拿全卡 / 暂不拿瘦卡 / 已拿·已开单瘦卡，单页唯一视图）
//   + 页级忽略清单。
// 合并后**不复制实现**：卡由 `PickingView` 渲染；宿主只注入三样本视图没有的东西
// （各厂拿货单 `supplierOrders` / 忽略原因 `ignoreReasons` / 厂家电话 `supplierPhones`），
// 单子上的动作（编辑/提交/导出/删除）只收意图（`order-action`）—— 确认弹层与写库仍在这里。
//
// **2026-10-17 第二轮（合并之后）：宫格 + SKU 图 + 拖拽改厂家**（`PickingView` 内落地，本页只接写）：
//   · 厂家卡改**宫格**（一个厂家一个宫格）＋ 款色行加 **SKU 缩略图**（取数早在合批里，零新增通道）；
//   · 款色行可**拖到别家的格子** = 改 `pl_products.supplier_id`（产品域主数据，按款编码定位）——
//     本页经 `productMoveSupplier` 写、`bump()` 后清单重排。⚠️ 写是**款级**的：
//     拖一行 = 这一款的所有款色一起走（toast 里说清 N 个款色）；未指定厂家是合法落点（取消关联）。
//
// **为什么把拣货单并进来**（用户 2026-10-10）：拣货清单按「厂家 / 款 × 色 × 码 / 图 / 进价」汇总，
// 而"拿货"要的正是这张单 —— 原第 3 步生成完清单，再单独一步拿货**又得从头理一遍**
// （拿货页只有款色码，图与进价一概没有），于是同一件事在两个步骤里各算一次，口径还不同
// （清单是"未发货 · 近 30 天"，缺口是"全部订单"）。合并后一条链是：
// **要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账**。
//
// **2026-10-10 重设计（简洁直观）**：本页原先顶上一条四格指标条 + 视图 A 再一条"选厂家 / 选日期 /
// 按此生成"的行动区 —— 两排控件都在问"拿多少、开哪张单"，读起来是同一件事说了两遍。
// 现在：① 指标条撤掉，数字**就地**给（清单条 / 面板头各报自己的数）
// ② 开单按钮**钉在厂家段上**（一张单一个厂家，段就是天然的分组，不必先选厂家）
// ③ 忽略清单折成一行（低频，展开才出表）④ 生成后**直接进编辑器**填价（下一步就是"录付了多少钱"）。
// （2026-10-17：① 的"就地给数"随合并收敛到顶部概览条一处 —— 两个视图的数在一屏内并列，
//  正是"同一件事的两个视图"该有的样子。）
//
// **2026-10-17 第三轮（用户反馈"合并后为什么还有按订单/按厂家两个页签 / 三区不协调 / 行太挤"）**：
//   · 「按订单」页签**整条撤掉**：每张拿货单本来就在厂家卡"已开单"上（同一套 data-act），
//     宫格视图是纯重复；它唯一独有的"新建空白单"收进概览条右侧。单子管理全部在卡上完成。
//   · 三分区（待拿宫格卡 / 暂不拿灰条 / 已拿折叠列表）→ **单宫格一种卡**（`PickingView` 内落地）。
//   · 款色行瘦身（图 + 款名·颜色 + 尺码×件数 + 忽略；款编码/金额/缺口/涉及订单不再上卡）；
//     复制清单 / 清单图同步去款编码（`pickingSheet` 的 `label`）。
//
// **照功能不照样式**：移植自原「订单归类」岛的**拿货对账页**（原页 994 行；该岛已于 2026-10-05
// 整体下架，源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的
// `.panel/.bar/.btn` 一套；内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
// 功能映射（岛 → 本页）：供应商**只读**（维护在「货与成本 › 供应商」，本页只做参照，同岛内 2026-09-28 的处置）
// · 拿货单列表/新建/编辑/提交/删除/导出 · 要拿什么（拣货清单 + 按段开单）· 忽略清单 · 单价记忆。
// **付款与对账留在下一步（第 4 步，`ReconPanel.vue`）**—— 岛把它们和拿货挤在一页，本页按流程拆开。
//
// 数据层**零新增**：全部走宿主现成的 `purchase*` 通道（能力域 `purchase`，见 `plugin/host.ts` 的 `DB_OPS`）。
// 清单本身仍由 `@/modules/picking/PickingView.vue` 出（**不复制一份**），本页只做"开单意图 + 忽略清单"。
import { computed, onMounted, ref, watch } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import { productMoveSupplier } from '@/core/services/ipc';
import ProductPicker from '@/modules/goods/components/ProductPicker.vue';
import { skuMap } from '@/modules/goods/api';
import type { IgnoreRow, PurchaseOrder, Supplier } from '@/types';
import { ignoreKey, pendingOf, purchaseGateOf, type PickingGroup } from '@/lib/picking';
import {
  coverageInputs,
  coverageSummary,
  groupByOrder,
  missingLabel,
  planCoverage,
  type CoverageSummary,
  type OrderCoverageOrder,
  type RowCoverage,
} from '@/lib/orderCoverage';
import { useShipping } from '../flowCtx';
import PurchaseOrderEditor from './PurchaseOrderEditor.vue';
import PickingView from '@/modules/picking/PickingView.vue';
import {
  addIgnore,
  coverage,
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

const loading = ref(false);
const error = ref('');
const busy = ref(false);

const orders = ref<PurchaseOrder[]>([]);
const ignores = ref<IgnoreRow[]>([]);
const suppliers = ref<Supplier[]>([]);
/** 已忽略表默认收起（低频，见模板注释） */
const showIgnores = ref(false);

/** 清单（由 `PickingView` 的 `generated` 事件交过来，**不在这里重算**：同一件事只能有一处算） */
const pickRows = ref<PickingGroup[]>([]);

const editing = ref<PurchaseOrder | null>(null);
/** 正在处理「未归类」的那一条（商品ID / 件数 / 店铺）—— 非空时产品选择器打开 */
const fixing = ref<{ itemId: string; pieces: number; shops: string[] } | null>(null);

// ---- 按单核对（「哪张订单的货齐了」）----
//
// 数据链**只有一条**：宿主 `purchase-order-coverage` → `coverageInputs`（翻译列名/拼台账键）
// → `planCoverage`（逐行判定）→ `groupByOrder`（聚成每张单）。
// ⚠️ 总览那四个数走的是**同一个** `planCoverage` —— 两处各算一遍，
//    总览说"全齐了"、这里说"还差 1 件"是必然会发生的。
const showCover = ref(false);
const coverError = ref('');
const coverOrders = ref<OrderCoverageOrder[]>([]);
const cover = ref<CoverageSummary>({
  orders: 0,
  done: 0,
  partial: 0,
  pieces: 0,
  covered: 0,
  remaining: 0,
  estimated: false,
});
const doneOrders = computed(() => coverOrders.value.filter((o) => o.done));
const partialOrders = computed(() => coverOrders.value.filter((o) => !o.done));

/** 一张单还差的明细，**最多 6 条**（多的一行"还有 N 项"，别用 30 个 chip 铺满屏） */
function missingOf(o: OrderCoverageOrder): RowCoverage[] {
  return o.rows.filter((r) => r.covered < r.qty).slice(0, 6);
}

/** 被 `missingOf` 截掉的那几条有几条（0 = 没截） */
function hiddenMissingOf(o: OrderCoverageOrder): number {
  return Math.max(0, o.rows.filter((r) => r.covered < r.qty).length - 6);
}

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

/** 各厂家的拿货单（supplierId → 单子；草稿 + 已提交，排序交给 `PickingView`）—— 卡上"已开单"那一截 */
const ordersBySupplier = computed<Record<number, PurchaseOrder[]>>(() => {
  const out: Record<number, PurchaseOrder[]> = {};
  for (const o of orders.value) {
    (out[o.supplierId] ??= []).push(o);
  }
  return out;
});

/** 忽略原因（键 = `ignoreKey(款编码, 款色)`）—— "暂不拿"灰条要说清为什么（标的时候敲的那句话） */
const ignoreReasonMap = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const r of ignores.value) out[ignoreKey(r.styleCode, r.color)] = r.reason || '';
  return out;
});

/** 厂家电话（supplierId → 电话；空串 = 没录，`PickingView` 不渲染那一格） */
const phoneMap = computed<Record<number, string>>(() => {
  const out: Record<number, string> = {};
  for (const s of suppliers.value) out[s.id] = s.phone || '';
  return out;
});

function supplierNameOf(id: number): string {
  return suppliers.value.find((s) => s.id === id)?.name ?? '';
}

/** 清单交过来了（`PickingView` 每次重算都会发）—— 只存起来给「按段开单」与概览条用 */
function onPickRows(groups: PickingGroup[]): void {
  pickRows.value = groups;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  coverError.value = '';
  try {
    await ensureSchema();
    const [os, ig, sp, cv] = await Promise.all([
      listOrders(),
      listIgnores(),
      listSuppliers(),
      // 按单核对取数失败**不该让整页报错**（拿货单照常能开），但也**不能悄悄显示 0 单** ——
      // 那是假结论（用户会以为货真的没齐）。收进 `coverError`，那一块自己说"取数失败"。
      coverage().catch((e: unknown) => {
        coverError.value = e instanceof Error ? e.message : '按单核对取数失败';
        return null;
      }),
    ]);
    orders.value = os;
    ignores.value = ig;
    suppliers.value = sp;

    // 逐行覆盖 → 每张单齐没齐（算法在 `@/lib/orderCoverage`，纯函数、vitest 覆盖）
    const ins = coverageInputs(cv);
    coverOrders.value = groupByOrder(planCoverage(ins.rows, ins).rows);
    cover.value = coverageSummary(coverOrders.value);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取拿货数据失败';
  } finally {
    loading.value = false;
  }
}

/** 卡尾「生成拿货单（N 件）」的意图（`PickingView` 只发厂家 id） */
function onSupplierAction(supplierId: number): void {
  void createFromPick(supplierId);
}

/**
 * 卡上"已开单"里某个动作的意图（编辑/提交/导出/删除）—— 按单号找回那张单，路由到本页既有处理器。
 * ⚠️ 找不到就**什么都不做**（不 toast"单子不存在"）：这些按钮只可能点在本页刚渲染出来的行上，
 *    找不到意味着数据刚被别处改走，此刻任何提示都是噪声；下一次 `bump` 重取后行自己就更新了。
 */
function onOrderAction(intent: { kind: 'edit' | 'submit' | 'export' | 'delete'; id: number }): void {
  const o = orders.value.find((x) => x.id === intent.id);
  if (!o) return;
  if (intent.kind === 'edit') void openEditor(o.id);
  else if (intent.kind === 'submit') askSubmit(o);
  else if (intent.kind === 'export') void exportOrder(o);
  else askDelete(o);
}

/**
 * 把一款拖到别家（宫格里拖拽的写入口）—— 改 `pl_products.supplier_id`（产品域主数据）。
 *
 * 为什么**不弹确认**：落点就是用户眼前的那一格，松手后清单立刻重排（这款从旧格跳进新格）——
 * 结果自证，弹窗反而是多问一句；且这一步可逆（拖回去 / 去「货品档案」改）。
 * ⚠️ toast 必须说清"**该款共 N 个款色一起走**"：写是款级的（厂家挂在款上），
 *    用户拖的是看见的那一款色行，不说清会以为只搬走了一行、别的色还在旧厂家。
 * 写失败**不外抛到拖拽热区**（行已经回原位了）—— 收进 error + toast，清单不动。
 */
async function onMoveSupplier(intent: {
  styleCode: string;
  styleName: string;
  fromSupplierId: number;
  toSupplierId: number;
  colors: number;
}): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const r = await productMoveSupplier({ code: intent.styleCode, supplierId: intent.toSupplierId });
    if (!r.success) throw new Error(r.error || '移动失败');
    if (r.data?.changed === false) {
      toast('厂家没有变化', 'info');
      return;
    }
    const toName = intent.toSupplierId
      ? (suppliers.value.find((s) => s.id === intent.toSupplierId)?.name ?? `#${intent.toSupplierId}`)
      : '未指定厂家';
    const label = [intent.styleCode, intent.styleName].filter(Boolean).join(' ');
    toast(`${label}（该款共 ${intent.colors} 个款色）已移到「${toName}」`, 'success');
    bump();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '移动失败';
    error.value = msg;
    toast(msg, 'error');
  } finally {
    busy.value = false;
  }
}

/**
 * **按清单给这家厂生成草稿拿货单**（要拿什么 → 拿了什么）。
 *
 * 入参是"这家厂、未忽略、还差 > 0"的行 —— 判据走 lib 的 `pendingOf`（与卡尾按钮上的 N 件**同源**），
 * 不在这里自己 filter：两处各写一遍过滤，迟早出现"按钮说 12 件、单里 14 件"。
 *
 * 单价留 0：进价是**估算**（产品行的「当前进价」），实拿价要用户去编辑器里填（或点「取最近价」按历史价回填）
 * —— 把估算价当成付出去的钱落库，对账那一层就永远对不上。
 * `suggestionQty = 还差`：编辑器里显示"建议 X 件"，作为实拿数量的参照。
 *
 * 生成后**不切视图**（2026-10-17 合并前的行为是切到「拿了什么」）：合并后草稿**就地**出现在
 * 这家卡的"已开单"区里，跟着 `bump` 重取就能看见；原先靠切视图让新单可见，是因为那时
 * "要拿什么"那一半根本没有单子的位置。toast 里说明它出现在哪，用户不用猜。
 */
async function createFromPick(supplierId: number): Promise<void> {
  const rows = pendingOf(pickRows.value, supplierId);
  if (!rows.length) return toast('这家厂没有要拿的货', 'error');
  // ── 门 2（拿货前检查）────────────────────────────────────────────────────
  // ⚠️ 拦在**这一处**（唯一的写入口），不是把按钮 disabled：
  //    · 一张卡上常常只有一两行没归类，禁用整张卡的按钮会连带挡掉另外十几行能拿的货
  //      —— 门的作用域是"这批里的那几行"，不是"这家厂"；
  //    · 用户 2026-10-12 已拍板过拦截形态：拿货页**不禁用开单**，把缺什么说清、给入口。
  // 拒绝时把原话写进 `error`（页面上的错误条），而不是只弹一条 3 秒就消失的 toast ——
  // 用户要照着这句话去补数据，它得留在屏幕上。
  const gate = purchaseGateOf(rows);
  if (!gate.ok) {
    const parts: string[] = [];
    if (gate.unclassifiedRows > 0) {
      parts.push(
        `${gate.unclassifiedRows} 行还没归到款色（开进单里以后改个色名就再也对不上账）`,
      );
    }
    if (gate.noSupplierRows > 0) {
      parts.push(`${gate.noSupplierRows} 个款色还没指定厂家（开单会直接报"厂商不存在"）`);
    }
    const msg = `先补数据再开单：${parts.join('；')}。到「归类核对」把这几行归好 / 给款选个厂家，或把它们标「暂不拿」`;
    error.value = msg;
    toast(msg, 'error');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const r = await createOrder({
      supplierId,
      bizDate: localDay(),
      items: rows.map((g) => ({
        styleCode: g.styleCode,
        styleName: g.styleName,
        // 身份（2026-10-20）：开单那一刻把款色 id 记进明细 —— 之后色名再被改写，
        // "已拿"与取图都不会失联。不传 ⇒ 0 ⇒ 只能靠色名文本兜底（本轮修的就是这个坑）。
        styleColorId: g.styleColorId,
        color: g.color,
        size: g.size,
        qty: g.remaining,
        priceCents: 0,
        suggestionQty: g.remaining,
      })),
    });
    bump();
    toast(`已生成拿货单 #${r.id}（草稿）—— 它在本卡的「已开单」里，填好单价再提交`, 'success');
    await openEditor(r.id);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '生成拿货单失败';
  } finally {
    busy.value = false;
  }
}

/**
 * 「未归类」行 → 选产品（意图来自清单的提示条）。
 *
 * 为什么修的是**商品ID**而不是那一行订单：映射的身份是（店铺 × 商品ID），配一次就覆盖
 * 该商品的全部历史订单（写映射时顺手 `reassignOrdersByItemIds` 回填）—— 逐行点等于把
 * 同一件事做 N 遍，且下次再导同一商品的订单又会回到未归类。
 *
 * `shopId` 传 0：界面手里只有商品ID（订单行不带店铺 id），由主进程按商品ID 认店；
 * 认不出会**报错**（不猜），此时提示用户去「基础数据 › 店铺登记」补店铺链接。
 */
function onFixUnclassified(intent: { itemId: string; pieces: number; shops: string[] }): void {
  fixing.value = intent;
}

async function onPickProduct(p: { id: number; code: string; name: string; color: string }): Promise<void> {
  const target = fixing.value;
  if (!target) return;
  busy.value = true;
  try {
    const r = await skuMap({
      rows: [
        {
          platform: '',
          shopId: 0, // 由主进程按商品ID 认店（认不出就报错，见 `onFixUnclassified`）
          itemId: target.itemId,
          productId: p.id,
          spec: p.color || '*',
          status: 'confirmed',
        },
      ],
    });
    const fail = r.failed.find((f) => f.itemId === target.itemId);
    if (fail) throw new Error(fail.message);
    fixing.value = null;
    // 回执必须说清"覆盖了多少件"—— 用户点的是"选个产品"，实际改的是一批历史订单
    const moved = Number(r.reassigned) || 0;
    toast(
      moved
        ? `已关联到「${p.code} ${p.name || ''}」：回填了 ${moved} 行历史订单（约 ${target.pieces} 件）`
        : `已关联到「${p.code} ${p.name || ''}」，没有需要回填的订单`,
      'success'
    );
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '关联失败', 'error');
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
      '提交后这张单才算「已拿」：拿货缺口会按它扣减，「按厂家」的“还差”跟着少，金额进入对账，成本会同步到「统计」。',
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
 * 忽略某一款色（**意图来自清单的行尾**，「按厂家」视图里点，不在这里自己找行）。
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
      '标记后这一款色不再出现在「按厂家」里，也会从拿货缺口里消失。已线下拿、放弃、退单都适合标它。',
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
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.pu-view {
  gap: 12px;
}

/* 顶部读取中提示（2026-10-17 第五轮：概览文案与「新建空白单」都撤了，页级只剩这一行） */
.pu-loading {
  font-size: 12px;
  flex-shrink: 0;
}

/* ⚠️ 面板**不许被弹性列压扁**（2026-10-17 宫格重做时补，与拣货视图 `pk-sum` 的 `flex-shrink:0`
   同一处置）：本视图根节点是 `.wb-page`（定高 `height:100%` 的弹性列），内容超过可用高度时
   弹性布局会压缩**默认可缩**的项；而 `.wb-panel` 自己的 `overflow:hidden` 把自动最小尺寸
   （min-height:auto）归零 ⇒ 它会被一路压成一条缝，卡面内容全裁在里面（DOM 还在、点不到）。
   修复语义：条子不许缩，装不下就溢出 `.pu-view` 去滚（那才是本来的设计，`pu-view` 自己
   就是 overflow:auto 的滚动口）。拿货单宫格与页级忽略折叠面板都吃这条。 */
.pu-view > .wb-panel {
  flex-shrink: 0;
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

/* 展开后的生效范围说明（2026-10-17 评审 P0：从折叠头里挪出来，收起态不再挂这句） */
.pu-ignore-note {
  margin: 0 0 8px;
  font-size: 12px;
}

.pu-field {
  margin-top: 10px;
}

/* ---- 按单核对（2026-10-22）----
   与「已忽略」同一套折叠头：整行是按钮，长得像 `.wb-panel__head`。 */
.pu-cover-head {
  width: 100%;
  text-align: left;
  cursor: pointer;
  background: none;
}

.pu-cover-head__sum {
  margin-left: 10px;
  font-weight: 400;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.pu-cover-head__sum b {
  font-weight: 600;
  color: var(--wb-text);
}

.pu-cover-head__err {
  margin-left: 10px;
  font-weight: 400;
  font-size: 12px;
  color: var(--wb-danger, #c0392b);
}

.pu-cover-head__toggle {
  margin-left: auto;
  font-weight: 400;
  color: var(--wb-primary);
}

.pu-cover-note {
  margin: 0 0 4px;
  font-size: 12px;
}

.pu-cover-warn {
  margin: 0 0 8px;
  padding-left: 8px;
  border-left: 2px dashed var(--wb-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

.pu-cover-seg + .pu-cover-seg {
  margin-top: 12px;
}

.pu-cover-seg__title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.pu-cover-seg__empty {
  margin: 0;
  font-size: 12px;
}

.pu-cover-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 一单一行（可以发货那段）：单号 / 店铺 / 件数，右对齐的件数便于扫读 */
.pu-cover-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--wb-surface);
}

.pu-cover-item--partial {
  display: block;
}

.pu-cover-item__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pu-cover-item__no {
  font-size: 12px;
  color: var(--wb-text);
}

.pu-cover-item__shop {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.pu-cover-item__meta {
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--wb-text-muted);
}

/* 缺什么：一行 chip（款 · 色 · 码 × 件数），换行不换行内 */
.pu-cover-item__missing {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pu-cover-chip {
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--wb-surface-2);
  font-size: 12px;
  line-height: 18px;
  color: var(--wb-text);
}

.pu-cover-chip--more {
  background: none;
  border: 1px dashed var(--wb-border);
  color: var(--wb-text-muted);
}

.pu-cover-tag {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--wb-surface-2);
  font-size: 11px;
  line-height: 16px;
  color: var(--wb-text-muted);
}

.pu-cover-tag--warn {
  color: var(--wb-warning, #b7791f);
}
</style>
