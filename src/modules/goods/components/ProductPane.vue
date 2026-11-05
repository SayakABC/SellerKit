<template>
  <!-- 两栏工作台**左栏**：产品（款式）的紧凑列表 + 行展开。
       与整宽形态（`ProductListView.vue`，`GOODS_LAYOUT='tabs'` 的回退路径）**共用同一份逻辑**
       （`../useProductList`），差别只在渲染：这里列少、把装不下的东西放进展开区。

       列的取舍（2026-10-10 用户口径收紧后）：
         · 主列只留「☑ / 图 / 款编码 / 款式名 / 状态」—— 栏宽有限，"扫一眼找款"只要这几项；
         · SKU 数 / 缺克重 / 进价 **三列整列撤掉**（用户口径：产品列表不展示 SKU 与进价）：
           它们是"维护进度 / 成本数据"，却一直在跟**款名**抢宽度 —— 撤掉它们，款名才显示得全。
           ⚠️ 撤列不等于撤能力，两条都另有入口：缺克重走工具栏「问题件 › 缺克重」筛选，
           进价走同页「进价」页签（那里有"还没维护进价的款"清单，比列表里一个「—」可操作）；
         · 供应商 / 类目 / 操作（编辑、删除）仍在**行展开**里 —— 它们是"选中之后才关心"的信息；
         · 展开区只剩两块：档案带（元信息 + 编辑/删除）与「已关联商品」（只读反查）。
           ⚠️ SKU 清单 2026-10-10 一并撤掉（用户口径："展开页中的 SKU 也去掉"）；
           SKU 的增删改**没有**因此失去入口 —— 仍在「编辑」抽屉（颜色 × 尺码批量生成 + 逐行克重）。

       ⭐ 款名是**弹性列**，撤掉三列之后它要真的把名字显示出来（旧版单行省略号 + 栏宽被挤 ⇒
       "款式名展示不完全"）。现在最多两行 + `title` 给全文 —— 判据是那一格的
       `scrollWidth <= clientWidth`（放不下就会溢出，不是"看着短一点"）。 -->
  <div class="gd-pane">
    <div class="gd-toolbar">
      <input
        v-model="searchInput"
        class="wb-input gd-toolbar__search"
        type="search"
        placeholder="搜索款编码 / 款式名 / 类目…"
        aria-label="搜索产品"
      />
      <select v-model="statusFilter" class="wb-input gd-toolbar__select" aria-label="状态筛选">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="archived">停用</option>
      </select>
      <select
        v-model="supplierFilter"
        class="wb-input gd-toolbar__select"
        data-act="filter-supplier"
        aria-label="供应商筛选"
      >
        <option value="">全部供应商</option>
        <option v-for="s in supplierOptions" :key="s.id" :value="String(s.id)">
          {{ s.name || `#${s.id}` }}（{{ s.productCount }}）
        </option>
      </select>
      <!-- 「问题件」：只看"有问题的那几款"。2026-10-08 页级指标条撤掉后，这里是
           「缺克重 / 未关联供应商」两个筛选的**唯一入口** —— 它不是重复控件，
           去掉等于把这两个筛选变成永远进不去的死能力。与上面两个筛选互斥（选了它自动撤供应商）。 -->
      <select
        v-model="issueFilter"
        class="wb-input gd-toolbar__select"
        data-act="filter-issue"
        aria-label="问题件筛选"
      >
        <option value="">全部款式</option>
        <option value="missingWeight">缺克重</option>
        <option value="noSupplier">未关联供应商</option>
        <option value="missingCost">缺进价</option>
      </select>

      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>

      <div class="gd-toolbar__actions">
        <!-- 文案「新增产品」→「新增款」（2026-10-25）：页名叫「款与商品」，按钮却叫"产品"，
             同一屏两个词说同一件事（本页正是靠"款 / 产品 / 商品"三个词的混用把用户绕晕的）。
             ⚠️ 导出 / 导入**保持普通按钮**（不加 `--ghost`）：本工具栏原本就只有一个主操作
             （新增款是 `--primary`），层级已经成立；把这两颗降成透明底会让"导入 Excel"
             这个新用户第一步的入口看起来像纯文本 —— 本页的杂乱来自**控件数量**，不是缺少灰化。
             `data-act` 一个没动（冒烟与脚本按它挂）。 -->
        <button class="wb-btn" type="button" data-act="export-products" :disabled="busy" @click="doExport">
          导出
        </button>
        <button
          class="wb-btn"
          type="button"
          data-act="import-excel"
          :disabled="busy"
          @click="importOpen = true"
        >
          导入 Excel
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="new-product"
          :disabled="busy"
          @click="openEditor(null)"
        >
          新增款
        </button>
      </div>
    </div>

    <!-- 活跃筛选：只在真的筛了东西时出现（空闲时整行不存在，不占位） -->
    <div v-if="filtered" class="gd-filters" data-act="active-filters">
      <span class="gd-filters__label">筛选</span>
      <button
        v-if="searchApplied"
        class="gd-chip"
        type="button"
        data-act="chip-search"
        @click="clearOne('search')"
      >
        搜索「{{ searchApplied }}」<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="statusFilter"
        class="gd-chip"
        type="button"
        data-act="chip-status"
        @click="clearOne('status')"
      >
        状态：{{ statusFilter === 'archived' ? '停用' : '启用' }}<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="supplierFilter"
        class="gd-chip"
        type="button"
        data-act="chip-supplier"
        @click="clearOne('supplier')"
      >
        供应商：{{ supplierLabel }}<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="onlyMissingWeight"
        class="gd-chip gd-chip--warn"
        type="button"
        data-act="chip-missing"
        @click="clearOne('missingWeight')"
      >
        只看缺克重<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="withoutSupplier"
        class="gd-chip gd-chip--warn"
        type="button"
        data-act="chip-no-supplier"
        @click="clearOne('noSupplier')"
      >
        只看未关联供应商<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="onlyMissingCost"
        class="gd-chip gd-chip--warn"
        type="button"
        data-act="chip-missing-cost"
        @click="clearOne('missingCost')"
      >
        只看缺进价<span aria-hidden="true">×</span>
      </button>
      <button
        class="wb-btn wb-btn--sm wb-btn--ghost"
        type="button"
        data-act="clear-filters"
        @click="clearFilters"
      >
        清空全部
      </button>
    </div>

    <!-- 批量条（⭐ 2026-10-25：简洁模式整个撤掉，勾选框列与批量条恒渲染 ——
         一个"默认藏起来"的开关不值得留，收尾笔记见 docs/notes/2026-10-25-*） -->
    <div v-if="selectedIds.size" class="gd-selbar" data-act="selection-bar">
      <span>已选 <b>{{ selectedIds.size }}</b> 个款</span>
      <button class="wb-btn wb-btn--sm" type="button" :disabled="busy" @click="openBatchEdit">
        批量编辑
      </button>
      <button
        class="wb-btn wb-btn--sm wb-btn--danger"
        type="button"
        :disabled="busy"
        @click="pendingDelete = { ids: [...selectedIds], one: null }"
      >
        删除选中
      </button>
      <button class="wb-btn wb-btn--sm wb-btn--ghost" type="button" @click="clearSelection">
        清空选择
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <section class="wb-panel gd-list">
      <div class="wb-panel__head">
        <span>产品</span>
        <span class="wb-muted">{{ total }}</span>
        <span v-if="filtered" class="wb-muted">· 已筛选</span>
      </div>

      <div class="wb-panel__body">
        <!-- `tabindex="0"`：这张表本身是一个键盘操作对象（↑↓ 移动 / 空格勾选 / 回车编辑，
             见 `@/core/composables/useRowNav`）。没有它，鼠标点过行之后按方向键什么都不会发生 ——
             「手不离键」就成了"必须先 Tab 十几次才能用"。 -->
        <table
          ref="tableEl"
          class="wb-table gd-pane__table"
          data-act="product-table"
          tabindex="0"
          aria-label="产品列表：上下键移动当前行，空格勾选，回车打开编辑"
          @keydown="onKeydown"
        >
          <thead>
            <tr>
              <th class="gd-c-check">
                <input
                  type="checkbox"
                  :checked="allChecked"
                  :indeterminate.prop="someChecked"
                  aria-label="全选本页"
                  @change="toggleAll"
                />
              </th>
              <th class="gd-c-img">图</th>
              <th class="gd-c-code">款编码</th>
              <th class="gd-c-name">款式名</th>
              <th class="gd-c-status">状态</th>
              <th class="gd-c-cost wb-num">进价</th>
              <th class="gd-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in rows" :key="p.id">
              <!-- ⭐ 2026-10-25（P2 · S4）：一行只做**一件事** —— 单击 = 选中这一款。
                   原来单击是"展开"，而展开区里塞着认款按钮 / 供应商标 / 类目 / 编辑删除 / 已关联反查
                   五样东西（用户原话：点了不知道看哪儿）。现在：
                     · 选中 → 右栏动作条的落点（唯一跨栏状态还是 `currentProduct`）
                     · 档案 → 「编辑」抽屉（那里本来就有全部字段）
                     · 已关联反查 → 右栏「已认」段的「只看当前款」
                   上面三样各归一处，"点一行"这件事才有唯一答案。 -->
              <tr
                class="is-clickable"
                :class="{ 'is-on': p.id === currentId }"
                :data-product-id="p.id"
                data-act="p-select"
                @click="selectRow(p.id)"
              >
                <td class="gd-c-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selectedIds.has(p.id)"
                    :aria-label="`选择 ${p.code}`"
                    @change="toggleOne(p.id)"
                  />
                </td>
                <td class="gd-c-img">
                  <img v-if="thumbs.get(p.id)" :src="thumbs.get(p.id)" class="wb-thumb" alt="" />
                  <span v-else class="wb-thumb wb-thumb--empty" title="暂无主图"></span>
                </td>
                <td class="wb-mono gd-c-code" data-act="p-code">{{ p.code }}</td>
                <!-- 款名：弹性列，最多两行。里层 span 承担折行（td 自己必须是 table-cell，
                     不能直接 `display:-webkit-box`，否则这一格会脱离表格布局）。
                     ⚠️ 文本仍是一个节点 ⇒ `el.textContent` 与撤列前逐字相同（断言不受影响）。 -->
                <td class="gd-pane__name" data-act="p-name" :title="p.name || ''">
                  <span class="gd-pane__name-text">{{ p.name || '—' }}</span>
                </td>
                <td class="gd-c-status" data-act="p-status">
                  <span class="wb-tag" :class="p.status === 'archived' ? '' : 'is-on'">
                    {{ p.status === 'archived' ? '停用' : '启用' }}
                  </span>
                </td>
                <!-- 进价（当前价，分）：还没维护显示「—」。2026-10-22 进价页退役后，
                     这一列是"产品列表展示进价"的落点（方案 B'）；与「只看缺进价」筛选配套。 -->
                <td class="gd-c-cost wb-num" data-act="p-cost">
                  <span v-if="costText(p.code) === '—'" class="wb-muted">—</span>
                  <span v-else>{{ costText(p.code) }}</span>
                </td>
                <!-- 档案入口：编辑（含供应商 / 类目 / 备注 / 创建时间 / SKU / 删除）。
                     `@click.stop`：点「编辑」不该顺带把这一行选成当前款 —— 那是两件事，
                     而且"打开抽屉"这个动作本身已经说明了操作对象是谁。 -->
                <td class="gd-c-ops" @click.stop>
                  <button
                    class="wb-link"
                    type="button"
                    data-act="row-edit"
                    :title="`编辑 ${p.code} 的档案与 SKU`"
                    @click="openEditor(p)"
                  >
                    编辑
                  </button>
                </td>
              </tr>
            </template>
            <tr v-if="!rows.length && !loading">
              <td :colspan="gdColspan" class="gd-list__empty">
                <div class="wb-empty wb-empty--sm">
                  <div class="wb-empty__icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
                      <path d="M3 8v8l9 5 9-5V8" />
                    </svg>
                  </div>
                  <p class="wb-empty__title">{{ filtered ? '没有符合条件的款' : '还没有产品' }}</p>
                  <!-- ⭐ 空态要说清"先做哪个"（P0-5 左半）。真实顺序是**先有订单才有队列**：
                       队列不是缓存表，是从订单里实时聚出来的。所以队列已拉过且为空时，
                       领头那句和领头那个按钮都换成「去「发货台」导订单」。
                       ⚠️ 判据是 `queueEmpty === true`（不是 `!queueEmpty`）：`null` = 队列还没拉过，
                       那时我们并不知道顺序该不该翻 —— 按默认顺序说，并保留那句稳妥的原理说明。 -->
                  <p class="wb-empty__desc">
                    {{
                      filtered
                        ? '换个关键字，或把上面的筛选条件清掉再试。'
                        : queueEmpty === true
                          ? '右边那些待认的商品不是导入进来的，是从订单里长出来的 —— 先在「发货台」把订单导进来，这里才有款可配。'
                          : '产品库是订单 / 采购 / 成本三域的关联锚点 —— 先建档，后面才有得算。'
                    }}
                  </p>
                  <div class="wb-empty__actions">
                    <button v-if="filtered" class="wb-btn" type="button" @click="clearFilters">
                      清空筛选
                    </button>
                    <template v-else>
                      <!-- 队列也空：把「去「发货台」导订单」放到**第一位**并做成主按钮（顺序即答案） -->
                      <button
                        v-if="queueEmpty === true"
                        class="wb-btn wb-btn--primary"
                        type="button"
                        data-act="empty-go-today"
                        @click="emit('import-orders')"
                      >
                        去「发货台」导入订单
                      </button>
                      <button
                        class="wb-btn"
                        :class="{ 'wb-btn--primary': queueEmpty !== true }"
                        type="button"
                        @click="importOpen = true"
                      >
                        导入 Excel
                      </button>
                      <button
                        class="wb-btn"
                        :class="{ 'wb-btn--primary': queueEmpty !== true }"
                        type="button"
                        @click="openEditor(null)"
                      >
                        新增款
                      </button>
                    </template>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 面板脚：多页时是分页条，**单页时是收束行**（2026-11-03 界面方案 §5.9）。
           原来只在多页时才挂页脚，而常见情况正是一页装完 —— 于是表格直接断在一段空白上，
           用户分不清"到底了"还是"还在加载 / 被我裁掉了"。
           ⚠️ 收束行放在表**外**（挂在面板脚），不要加成 tbody 的收尾 `<tr>`：那会吃到
              斑马纹与 hover 热区、长得像一条数据行，且以后任何"数行"的判据都会被它带偏。
           ⚠️ 单位跟分页那条保持一致写「条」（"共 N 条，第 x / y 页"）：同一个面板里出现
              "条"和"款"两个单位词，用户会以为在数两样东西。 -->
      <div v-if="totalPages > 1" class="wb-panel__foot gd-list__foot">
        <span class="wb-muted">共 {{ total }} 条，第 {{ page }} / {{ totalPages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button class="wb-btn wb-btn--sm" type="button" :disabled="page <= 1 || loading" @click="goto(page - 1)">
          上一页
        </button>
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          :disabled="page >= totalPages || loading"
          @click="goto(page + 1)"
        >
          下一页
        </button>
      </div>
      <p v-else-if="total > 0" class="wb-panel__foot gd-list__cap" data-act="product-cap">
        共 {{ total }} 条 · 已全部显示
      </p>
    </section>

    <ProductEditorDrawer
      v-if="editorOpen"
      :product="editing"
      :suppliers="supplierOptions"
      @close="editorOpen = false"
      @saved="onEditorSaved"
      @deleted="onEditorDeleted"
    />

    <ProductImportDialog
      v-if="importOpen"
      @close="importOpen = false"
      @done="onImported"
      @template="downloadTemplate"
    />

    <div v-if="batchEditOpen" class="wb-mask" @click.self="batchEditOpen = false">
      <div class="wb-dialog wb-dialog--sm" role="dialog" aria-modal="true">
        <div class="wb-dialog__head">批量编辑 {{ selectedIds.size }} 个款</div>
        <div class="wb-dialog__body gd-batch">
          <label class="wb-field">
            <span class="wb-field__label">供应商</span>
            <select v-model="batch.supplierId" class="wb-input">
              <option value="">不修改</option>
              <option value="0">未关联（清空供应商）</option>
              <option v-for="s in supplierOptions" :key="s.id" :value="String(s.id)">
                {{ s.name || `#${s.id}` }}
              </option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">类目</span>
            <input v-model="batch.category" class="wb-input" placeholder="留空 = 不修改" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">状态</span>
            <select v-model="batch.status" class="wb-input">
              <option value="">不修改</option>
              <option value="active">启用</option>
              <option value="archived">停用</option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">备注（整列覆盖）</span>
            <input
              v-model="batch.note"
              class="wb-input"
              placeholder="留空 = 不修改；填写则覆盖所有选中行"
            />
          </label>
          <p v-if="batchError" class="wb-notice wb-notice--error">{{ batchError }}</p>
          <p class="wb-field__hint">
            款编码与款式名不可批量修改 —— 编码是跨域关联的锚点，改名会让历史数据指向别处。
          </p>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" :disabled="batchBusy" @click="batchEditOpen = false">
            取消
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            :disabled="batchBusy"
            @click="applyBatchEdit"
          >
            {{ batchBusy ? '保存中…' : '应用到选中行' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="pendingDelete"
      title="确认删除"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="busy"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <p v-if="pendingDelete.one">
        将删除产品
        <b class="wb-mono">{{ pendingDelete.one.code }}</b>
        {{ pendingDelete.one.name ? `（${pendingDelete.one.name}）` : '' }}。
      </p>
      <p v-else>将删除选中的 <b>{{ pendingDelete.ids.length }}</b> 个产品。</p>
      <p class="wb-notice wb-notice--warn">
        删除是物理删除且不可撤销。已进入订单 / 采购 / 成本链路的款请改用「停用」——
        编码是跨域关联的锚点，删掉会让历史数据指向空。
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 两栏工作台左栏的渲染形态。逻辑见 `../useProductList`（与整宽形态共用）。
//
// 本组件自己只管两件**渲染专属**的事：
//   ① `currentId` —— 哪一行**被选中**（不再是"哪一行展开了"）。S4 之后一行只做一件事：
//      单击 = 选中。原来的展开区（认款 / 供应商 / 类目 / 编辑删除 / 已关联反查）五合一，
//      现在各归各位：档案进「编辑」抽屉、反查进右栏「已认」的「只看当前款」。
//   ② 把"当前款"报给外壳（`select-product`）—— 跨栏通信只能经外壳，两个子组件互不认识。
import { computed, reactive, ref, watch } from 'vue';
import { useRowNav } from '@/core/composables/useRowNav';
import { useProductList } from '../useProductList';
import * as api from '../api';
import ProductEditorDrawer from './ProductEditorDrawer.vue';
import ProductImportDialog from './ProductImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（筛选入口已搬进本栏工具栏，不再由页级下传） */
  refreshNonce: number;
  /**
   * 待关联队列是不是**已经拉过、而且真的是空的**（`null` = 还没拉过）。
   *
   * 只用于一处：空态里"先做哪个"的顺序（P0-5 左半）。判据必须保留 `null`：
   * "还没拉过"不是"没有待办"，拿它当空会给出一句界面并不知道的结论
   * （见 `docs/notes/2026-10-30-goods-list-and-pool.md` 第 4 条）。
   */
  queueEmpty: boolean | null;
}>();

/**
 * 「当前款」（`null` = 没有款被展开）。
 *
 * ⚠️ 刻意**不用** `useProductList` 里的 `selectedId`：那个会被自动设成第一行
 * （整宽形态的详情面板需要它），于是"一进页面右栏就挂着一个 `关联到 S1`" ——
 * 用户没选任何款，却有一个看起来像是自己选好的落点，照着点就是**写错款**。
 * 这里用"用户真的展开过哪一行"，语义上诚实（展开 = 我看过这款）。
 */
const emit = defineEmits<{
  'select-product': [product: { id: number; code: string; name: string } | null];
  /**
   * **全库**款数报给外壳（`null` = 汇总还没拉到）。
   *
   * 为什么本栏自己不用它、却要往上报：首次动线（空库引导卡）的判据要**同时**看"零款"与
   * "队列已拉过且为空"，而这两个数分别住在本栏与右栏 —— 外壳是唯一同时拿到两者的地方。
   * 报的是原始数字而不是"该不该显示卡片"的布尔：判据只写一遍（`./../firstRun.ts`），
   * 外壳不推导（同 `relateCount` 的分工）。
   */
  'styles-total': [total: number | null];
  /**
   * 空态里那个「去「发货台」导入订单」按下了（只发信号）。
   *
   * 跨模块跳转由外壳做（`GoodsWorkbenchView.goImportOrders`）：本组件不认识模块表，
   * 也不该认识。
   */
  'import-orders': [];
}>();

const {
  loading,
  busy,
  error,
  rows,
  total,
  page,
  selectedIds,
  supplierOptions,
  searchInput,
  searchApplied,
  statusFilter,
  supplierFilter,
  issueFilter,
  onlyMissingWeight,
  withoutSupplier,
  onlyMissingCost,
  editorOpen,
  editing,
  importOpen,
  pendingDelete,
  thumbs,
  stylesTotal,
  totalPages,
  filtered,
  allChecked,
  someChecked,
  supplierLabel,
  costCentsOf,
  clearFilters,
  clearOne,
  selectProduct,
  toggleAll,
  toggleOne,
  clearSelection,
  goto,
  openEditor,
  onEditorSaved,
  onImported,
  openBatchEdit,
  applyBatchEdit,
  confirmDelete,
  downloadTemplate,
  doExport,
  batchEditOpen,
  batchBusy,
  batchError,
  batch,
} = useProductList({ refresh: () => props.refreshNonce });

/**
 * 全库款数往上报（→ 外壳 → 首次动线的判据）。
 * `immediate` 是必须的：汇总比列表先/后到都可能，不带上它，"零款 + 空队列"这个瞬间
 * 就只能等下一次变化才传出去（那时用户已经看到界面停在空态上了）。
 */
watch(() => stylesTotal.value, (n) => emit('styles-total', n), { immediate: true });

/**
 * 进价（元，两位小数）；还没价显示「—」（**不写 0.00** —— 0 会被读成"零成本/免费"）。
 * 唯一来源 = 产品表「当前进价」（`costCentsOf`，见 `useProductList`）。2026-10-22 进价页
 * 退役后，这一列就是"产品列表展示进价"的落点（方案 B'）；与「只看缺进价」筛选配套。
 */
function costText(code: string): string {
  const cents = costCentsOf(code);
  return cents === null ? '—' : (cents / 100).toFixed(2);
}

/**
 * 空态那一格跨的列数 = 表头 th 数（勾选框 / 图 / 款编码 / 款式名 / 状态 / 进价 / 操作 = 7）。
 * （2026-10-10 曾撤掉 SKU / 缺克重 / 进价三列，各 −3；2026-10-22 进价列随进价页退役
 * 重新加回"展示"这一面。2026-10-25 S4 撤掉行首 ▸ 展开列、加回行尾「操作」列 —— 一撤一加。
 * 同日简洁模式整个撤掉，勾选框列恒渲染 ⇒ 不再有 6/7 两档。冒烟仍是 `colSpan === th 数`
 * 的动态比法，这里给常量只是注释性的。）
 */
const gdColspan = 7;

/** 当前选中的款（也是右栏动作条的落点；**不再是"展开的那一行"**） */
const currentId = ref(0);

/** 表格元素：既是键盘动线的挂载点，也是"点完行把焦点收回表上"的落点（见 `selectRow`）。 */
const tableEl = ref<HTMLTableElement | null>(null);

/**
 * 单击一行 = 选中它。
 *
 * ⚠️ 重复点同一行**不取消**（原 `toggleExpand` 会）：`currentId` 是右栏认款的**落点**，
 * 取消选中会让动作条上的「认到 S2（3 项）」突然变成「先选一个款」——
 * 用户在右栏勾了一堆商品之后回左栏点了一下同一个款，不该把落点清掉。
 * "不选任何款"不需要出口：不认款就是不选，那件事用不着按钮。
 */
function selectRow(id: number): void {
  if (currentId.value !== id) {
    currentId.value = id;
    // 走同一个 `selectProduct`：它顺手清掉上一条保存回执（回执是"刚才那一行"的，
    // 换一行还挂着会让人以为新那行也保存过了）
    selectProduct(id);
    const p = rows.value.find((x) => x.id === id);
    emit('select-product', p ? { id: p.id, code: p.code, name: p.name } : null);
  }
  // 点完一行把焦点交给表：`tr` 不可获焦，不收回来的话"鼠标点了行、接着按 ↓"什么都不会发生
  // （键盘动线成了只对纯键盘用户有效的东西）。`preventScroll`：行本来就在眼皮底下，别顺带滚页。
  tableEl.value?.focus({ preventScroll: true });
}

/**
 * 抽屉里把这个款删掉了（P2 · S4 —— 款级删除的新家）。
 *
 * 两件事：
 * - 关抽屉 + 刷列表：直接复用保存回执那条路（`onEditorSaved`），**不另写一份刷新逻辑**；
 * - 若删的正是当前款：立刻撤回落点。不撤的话右栏动作条上还挂着「认到 S1（3 项）」，
 *   而 S1 已经不存在了 —— 用户点下去就是一整批写向空款的映射。
 *   （`watch(rows)` 也会兜这一下，但它要等列表重拉回来；删除是"马上就不该再挂着"的事。）
 */
function onEditorDeleted(id: number): void {
  onEditorSaved(null);
  if (currentId.value === id) {
    currentId.value = 0;
    emit('select-product', null);
  }
}

/**
 * 刷新 / 换筛选之后，选中的那一行可能**已经不在列表里**了 —— 必须把"当前款"撤回。
 *
 * 不撤的后果不是"多显示一个按钮"，而是**写错款**：右栏动作条还挂着一个
 * 屏幕上根本看不见的款，用户勾上商品点下去，映射就落到那个款上了。
 * （落点必须**始终是屏幕上看得见的那一行**，否则直连比开弹层选还危险。）
 */
watch(rows, (list) => {
  if (currentId.value && !list.some((p) => p.id === currentId.value)) {
    currentId.value = 0;
    emit('select-product', null);
  }
});

/* ---- 键盘动线（方案 §6）：↑↓ 移动 / Space 勾选 / Enter 编辑 ------------
   为什么挂在 `<table>` 上而不是每一行：`tr` 不可获焦，`tabindex` 加在行上会造出 N 个
   焦停点（表一长，Tab 就废了）。表本身一个焦停点 + 表内移动，才是"手不离键"的形状。
   焦点在行内 checkbox / 行尾「编辑」上时由 `useRowNav` 让路（不判会勾上又立刻取消）。 */
const { onKeydown } = useRowNav({
  rows,
  idOf: (p) => p.id,
  currentId,
  onSelect: (id) => selectRow(id),
  onToggle: (id) => toggleOne(id),
  onOpen: (id) => {
    const p = rows.value.find((x) => x.id === id);
    if (p) openEditor(p);
  },
  rowEl: (id) => tableEl.value?.querySelector(`tr[data-product-id="${id}"]`) ?? null,
});

/* ---- 已关联反查已搬到右栏「已认」段（P2 · S4）---------------------------
   原来这里按款反查 `skuList({productId})` 并把结果列在行展开区里。展开区撤掉后，
   同一件事挪到右栏「已认」段的「只看当前款」—— 那边本来就是**同一份数据**的全量视图，
   再在左栏维护一份按款反查，等于给同一条映射做两个读数（P2 的原始问题之一正是"同屏重复"）。
   ⚠️ 右栏那边必须真的带 `productId`：不带的话每选一款都显示全库映射，且**不报错**。 */
</script>

<style scoped>
.gd-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-toolbar__search {
  width: 100%;
  min-width: 140px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 120px;
}
.gd-toolbar__hint {
  font-size: 12px;
}
.gd-toolbar__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.gd-selbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--wb-primary-soft);
  border-radius: var(--wb-radius-md);
  background: var(--wb-primary-soft);
  font-size: 13px;
  color: var(--wb-text);
}

.gd-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-filters__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.gd-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-text);
  cursor: pointer;
}
.gd-chip:hover {
  border-color: var(--wb-border-strong);
  background: var(--wb-hover);
}
.gd-chip--warn {
  border-color: var(--wb-warning-soft);
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.gd-list {
  flex: 1;
  min-height: 180px;
}
.gd-list__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 收束行（单页时替代分页条）：只回答"到底了没有"这一件事，所以不发声音 ——
   无按钮、无实底色，文字压到说明级。它的价值在**边界**（一条横线 + 一句话），
   不在信息量：没有它，表格末尾与画布之间没有任何分界，用户读不出"结束"还是"没加载完"。 */
.gd-list__cap {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: var(--wb-fs-caption);
  color: var(--wb-text-muted);
}
.gd-list__empty {
  padding: 0;
}
/* 「点任意一行可展开」那行常显提示。它自己**不是**一行表格行 —— 放在表体末尾，
   所以要有左右内边距，否则文字会贴着列的边界。 */
.gd-list__hint {
  padding: 8px 4px 2px;
  font-size: 12px;
}

.gd-pane__table {
  width: 100%;
}
.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 48px;
}
/* 「操作」列（S4 新增）：只放一个文字链「编辑」，按内容定宽。
   ⚠️ 它**确实比被它取代的那个 ▸ 列宽**（实测 56px vs 30px：文字链比小三角宽，且要留右内边距）。
   这 26px 全部从款名那列扣 —— 而款名是这个栏里**唯一该吃剩余宽度**的弹性列，
   实测刚好把 22 字的长款名从两行挤到三行（用户最初报的"款式名展示不完全"就是它）。
   所以这一列的右内边距压到 4px（td 自带 10px 已经够），款名那列再让出 4px。 */
.gd-c-ops {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  padding-right: 4px;
}
/* 款编码 / 状态：按内容定宽（`width:1%` + nowrap 就是这个意思），**别跟款名抢宽度**。
   2026-10-10 撤掉 SKU / 缺克重 / 进价三列之后，款名是唯一该吃剩余宽度的列。 */
.gd-c-code,
.gd-c-status {
  width: 1%;
  white-space: nowrap;
}
/* 款名 = **弹性列**，也是这一版要修的症状所在（用户："款式名现在展示不完全"）。
   做法：td 只负责"吃掉剩余宽度"，折行交给里层 span（td 自己必须保持 table-cell，
   直接上 `display:-webkit-box` 会让这一格脱离表格布局）。
   上限两行：再长的名字截断，但 `title` 里仍有全文（不能裁了又查不到）。 */
.gd-pane__name {
  overflow: hidden;
  padding-right: 8px;
}
.gd-pane__name-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.35;
}

.gd-batch {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
