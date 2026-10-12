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
      </select>

      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>

      <div class="gd-toolbar__actions">
        <button class="wb-btn" type="button" data-act="export-products" :disabled="busy" @click="doExport">导出</button>
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
          新增产品
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
        class="wb-btn wb-btn--sm wb-btn--ghost"
        type="button"
        data-act="clear-filters"
        @click="clearFilters"
      >
        清空全部
      </button>
    </div>

    <!-- 批量条：简洁模式下整条不渲染（连同每行的勾选框一列）—— 判据与理由见 `../simple`。
         ⚠️ 隐藏的是**整组**（勾选框列 + 批量条），不是只藏条子：留着勾选框而不给批量动作，
         用户勾了半天找不到下一步，比没有勾选框更差。 -->
    <div v-if="!goodsSimple && selectedIds.size" class="gd-selbar" data-act="selection-bar">
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
        <table class="wb-table gd-pane__table" data-act="product-table">
          <thead>
            <tr>
              <th class="gd-c-exp"><span class="wb-muted" aria-hidden="true">▸</span></th>
              <!-- 勾选框这一列整体受简洁模式控制（连同下面的每行勾选框与批量条）——
                   `colspan` 也跟着一起变，否则空态与展开行会少一格（见 `gdColspan`）。 -->
              <th v-if="!goodsSimple" class="gd-c-check">
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
            </tr>
          </thead>
          <tbody>
            <template v-for="p in rows" :key="p.id">
              <tr
                class="is-clickable"
                :class="{ 'is-on': p.id === expandedId }"
                :data-product-id="p.id"
                @click="toggleExpand(p.id)"
              >
                <td class="gd-c-exp">
                  <button
                    class="gd-pane__caret"
                    type="button"
                    data-act="row-expand"
                    :aria-expanded="p.id === expandedId"
                    :aria-label="`展开 ${p.code}`"
                    @click.stop="toggleExpand(p.id)"
                  >
                    {{ p.id === expandedId ? '▾' : '▸' }}
                  </button>
                </td>
                <td v-if="!goodsSimple" class="gd-c-check" @click.stop>
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
              </tr>

              <!-- 行展开：所有"选中之后才关心"的东西都在这里。
                   ⚠️ 这一行**不带** `data-product-id` —— 它是那一行的附属信息，不是又一条产品；
                   带上的话 `[data-act="product-table"] tbody tr[data-product-id]` 会把款数算多半行。 -->
              <tr v-if="p.id === expandedId" class="gd-pane__drow" data-act="row-detail">
                <td :colspan="gdColspan">
                  <div class="gd-detail">
                    <!-- ⭐ 认款入口（2026-10-08 R2 · W3）：「动线终点必须在视线焦点上」。
                         右栏工具栏那个「关联到 S2」离"刚展开的这一行"隔了一个栏宽 ——
                         用户点开款之后眼睛在左边，动作却在右边顶部。这里放**同一个动作的第二处入口**：
                         展开区第一眼就能看到，勾选数直接写在按钮上。
                         ⚠️ 本按钮**只发一个信号**（`relate-request`），真正写库的仍是右栏那一条
                         `commitMap` —— 两处入口、一条写路径，不存在第二套失败语义。 -->
                    <div class="gd-detail__relate">
                      <button
                        class="wb-btn wb-btn--sm wb-btn--primary"
                        type="button"
                        data-act="relate-from-expanded"
                        :disabled="relateCount === 0"
                        :title="`把右栏勾选的商品一次认到 ${p.code} 上`"
                        @click="emit('relate-request')"
                      >
                        认到本款<template v-if="relateCount">（{{ relateCount }} 项）</template>
                      </button>
                      <span class="wb-muted gd-detail__relate-hint" data-act="relate-hint">
                        {{
                          relateCount
                            ? `把右栏勾选的 ${relateCount} 个商品认到「${p.code}」`
                            : '先在右栏勾选商品，这个按钮就会亮（认款见右栏队列）'
                        }}
                      </span>
                    </div>

                    <!-- 元信息带：供应商/类目/创建/备注 是"这款是谁"的档案，横排一行放在
                         动作条之下、内容卡片之上；「编辑/删除」跟着档案走（操作的对象就是这份档案），
                         不再单独沉底 —— 旧版元信息挤左下、按钮悬右下，两块互不相干还高低不齐。 -->
                    <div class="gd-detail__meta">
                      <p><span class="wb-muted">供应商</span><span :class="{ 'wb-muted': !p.supplierId }" data-act="p-supplier">{{ p.supplierName || '(未关联)' }}</span></p>
                      <p><span class="wb-muted">类目</span><span :class="{ 'wb-muted': !p.category }" data-act="p-category">{{ p.category || '—' }}</span></p>
                      <p v-if="p.note" class="gd-detail__meta-note"><span class="wb-muted">备注</span>{{ p.note }}</p>
                      <p><span class="wb-muted">创建</span>{{ p.createdAt || '—' }}</p>
                      <div class="gd-detail__ops">
                        <button class="wb-btn wb-btn--sm" type="button" data-act="edit-product" @click="openEditor(p)">
                          编辑
                        </button>
                        <button
                          class="wb-btn wb-btn--sm wb-btn--danger"
                          type="button"
                          @click="pendingDelete = { ids: [p.id], one: p }"
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    <!-- 已关联商品：**只读反查**（数据层 `skuList({productId})`）。
                         刻意没有「解除」按钮 —— 硬删会让"关联率"莫名回落，且查不出原因；
                         失效的映射按"标失效"处理，这里只如实列出它已经不生效。 -->
                    <div class="gd-detail__block">
                      <div class="gd-detail__head">
                        <span>已关联商品</span>
                        <span class="wb-muted">
                          {{ linksBusy(p.id) ? '读取中…' : `${linksOf(p.id).length} 个店铺商品` }}
                        </span>
                      </div>
                      <!-- 一句"这里是只读的、要改去哪儿"。原先这句住在 SKU 块里（随那块一起撤了）——
                           而它守的**不是** SKU 的事，是"这一块为什么没有按钮"。 -->
                      <p class="wb-muted gd-detail__note">
                        只读：列出这个款已认下的商品。认款在右栏做 —— 认了哪个，这里就多哪个
                      </p>
                      <ul class="gd-links" data-act="detail-links">
                        <li
                          v-for="l in linksOf(p.id)"
                          :key="l.id"
                          class="gd-links__row"
                          data-act="detail-link"
                        >
                          <span class="wb-mono">{{ l.itemId }}</span>
                          <span class="wb-muted">{{ l.shopName || `#${l.shopId}` }}</span>
                          <span class="gd-links__plat">{{ l.platform }}</span>
                        </li>
                        <li v-if="!linksBusy(p.id) && !linksOf(p.id).length" class="wb-muted">
                          还没有店铺商品关联到这个款 —— 到右栏把商品认到这个款上，这里就会列出来
                        </li>
                      </ul>
                      <!-- 失效单列：**不能**混进上面那份"已关联"里（用户会以为那个商品还在用），
                           也不能一声不吭地藏掉（"被裁掉"和"不存在"在界面上必须长得不一样）。 -->
                      <p
                        v-if="deadLinksOf(p.id).length"
                        class="gd-links__dead"
                        data-act="detail-links-invalid"
                      >
                        另有 {{ deadLinksOf(p.id).length }} 条已失效（店铺商品ID 变了，不再计入关联）
                      </p>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!rows.length && !loading">
              <td :colspan="gdColspan" class="gd-list__empty">
                <div class="wb-empty">
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
                        新增产品
                      </button>
                    </template>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- ⭐ 「行可以点开」原先**只存在于行首那个 ▸ 小三角**（要鼠标悬停才发现，触屏根本没有）。
             一行常显提示把它说出来 —— 展开区里装着供应商 / 类目 / 规格 / 已认的商品，
             不知道有展开区的人等于看不到这些东西。
             ⚠️ 只在**真有行**时渲染：空态时多这一行会把空态的按钮往下推，
             而窄窗口下那正是 B3（按钮溢出容器、点不到）的成因。 -->
        <p v-if="rows.length" class="wb-muted gd-list__hint" data-act="expand-hint">
          点任意一行可展开，看它的规格与已认的商品
        </p>
      </div>

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
    </section>

    <ProductEditorDrawer
      v-if="editorOpen"
      :product="editing"
      :suppliers="supplierOptions"
      @close="editorOpen = false"
      @saved="onEditorSaved"
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
// 本组件自己只管三件**渲染专属**的事：
//   ① `expandedId` —— 哪一行展开了。**它同时是"当前款"**：展开就是选中，避免"高亮一行、
//      展开另一行"两套状态各说各话。S3 的「直连」与「对比」都落在这一款上；
//   ② `detail-links` 的取数 —— 按款反查该款关联了哪些店铺商品（`skuList({productId})`），
//      按需拉取 + 缓存（展开才拉；同一行反复展开不重复打）；
//   ③ 把"当前款"报给外壳（`select-product`）—— 跨栏通信只能经外壳，两个子组件互不认识。
import { computed, reactive, ref, watch } from 'vue';
import { useProductList } from '../useProductList';
import * as api from '../api';
import type { ShopSkuRow } from '@/types';
import ProductEditorDrawer from './ProductEditorDrawer.vue';
import { goodsSimple } from '../simple';
import ProductImportDialog from './ProductImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（筛选入口已搬进本栏工具栏，不再由页级下传） */
  refreshNonce: number;
  /**
   * 右栏**已勾选**的待关联商品数（0 = 没勾）。
   *
   * 为什么要从外壳转一手：勾选状态住在右栏的 `useSkuPool` 里（本栏用不到那份数据，
   * 也不该为了一个数字再拉一遍队列）。左栏只需要"有几个"，动作本身由右栏执行 ——
   * 见展开区那个「认到本款」按钮上的注释。
   */
  relateCount: number;
  /**
   * 待关联队列是不是**已经拉过、而且真的是空的**（`null` = 还没拉过）。
   *
   * 只用于一处：空态里"先做哪个"的顺序（P0-5 左半）。判据必须保留 `null`：
   * "还没拉过"不是"没有待办"，拿它当空会给出一句界面并不知道的结论
   * （见 `docs/notes/2026-10-08-goods-page-entry-guide.md` 第 4 条）。
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
   * 「把右栏勾选的商品认到本款」—— 只发信号，不做动作。
   *
   * ⚠️ 为什么不让本组件自己调：写映射只有一条路径（右栏的 `commitMap`：单事务、行级失败回传、
   * 写完必须重拉队列）。本栏再写一条就多出一套失败语义，而且它连队列数据都没有。
   */
  'relate-request': [];
  /**
   * 空态里那个「去「发货台」导入订单」按下了（只发信号）。
   *
   * 跨模块跳转由外壳做（`GoodsWorkbenchView.goImportOrders`）：本组件不认识模块表，
   * 也不该认识 —— 同 `relate-request` 的分工。
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
 * 表格的列数。**必须跟着「简洁模式」变** —— 空态与展开行都是跨全表的单元格，
 * 写死数字的话，简洁模式少一列时它们会各短一格（右边留一条空白，
 * 越宽的窗口越显眼，但**不会报错** —— 属于"看着就是不对、查起来没头绪"那一类）。
 *
 * 列数 = ▸ /（勾选框）/ 图 / 款编码 / 款式名 / 状态 ⇒ 简洁 5、完整 6。
 * （2026-10-10 撤掉 SKU / 缺克重 / 进价三列，两档各 −3；冒烟里那条断言是
 *  `colSpan === 表头 th 数` 的动态比法，所以撤列**不需要**改断言里的数字。）
 */
const gdColspan = computed(() => (goodsSimple.value ? 5 : 6));

/**
 * 切成简洁模式时把"已选"清空。
 *
 * 不清的后果是一个**隐形状态**：勾选框那一列不渲染了，但 `selectedIds` 还留着，
 * 用户看不见自己勾了什么、也不知道下次切回来会重新冒出来。可见的操作配可见的状态。
 */
watch(goodsSimple, (on) => {
  if (on) clearSelection();
});

/** 当前展开的款（同时是"当前款"—— 展开就是选中，避免"高亮一行、展开另一行"两套状态） */
const expandedId = ref(0);

function toggleExpand(id: number): void {
  if (expandedId.value === id) {
    expandedId.value = 0;
    emit('select-product', null);
    return;
  }
  expandedId.value = id;
  // 走同一个 `selectProduct`：它顺手清掉上一条保存回执（回执是"刚才那一行"的，
  // 换一行还挂着会让人以为新那行也保存过了）
  selectProduct(id);
  void loadLinks(id);
  const p = rows.value.find((x) => x.id === id);
  emit('select-product', p ? { id: p.id, code: p.code, name: p.name } : null);
}

/**
 * 刷新 / 换筛选之后，展开的那一行可能**已经不在列表里**了 —— 必须把"当前款"撤回。
 *
 * 不撤的后果不是"多显示一个按钮"，而是**写错款**：右栏那个「关联到 S1」还挂着一个
 * 屏幕上根本看不见的款，用户勾上商品点下去，映射就落到那个款上了。
 * （右栏的落点必须**始终是屏幕上看得见的那一行**，否则直连比开弹层选还危险。）
 */
watch(rows, (list) => {
  if (expandedId.value && !list.some((p) => p.id === expandedId.value)) {
    expandedId.value = 0;
    emit('select-product', null);
  }
});

/* ---- 已关联商品（按款反查，只读） ---- */

/** productId → 该款关联的映射行；`undefined` = 还没拉过 */
const links = reactive<Record<number, ShopSkuRow[] | undefined>>({});
const linksLoading = reactive<Record<number, boolean>>({});

function linksOf(id: number): ShopSkuRow[] {
  // 只列 confirmed：失效的映射**指向的店铺商品已经不在了**，混进"已关联"会让用户
  // 以为那个商品还在用（这是 `goods:ui` 与数据层两条断言一起钉的口径）。
  return (links[id] ?? []).filter((r) => r.status === 'confirmed');
}
function deadLinksOf(id: number): ShopSkuRow[] {
  return (links[id] ?? []).filter((r) => r.status !== 'confirmed');
}
function linksBusy(id: number): boolean {
  return !!linksLoading[id];
}

/**
 * 按款反查：这个款关联了哪些店铺商品。
 *
 * ⚠️ **每次展开都重拉**，不做"拉过就缓存"（2026-10-08 真机走查修正的缺陷）。
 *
 * 缓存版本的实测症状：用户刚在右栏完成一次认款（右栏指标条立刻变「已关联 1」），左栏**同一屏**
 * 仍写着首次展开时那个旧数字 —— 点「刷新」、收起再展开都无效，只有重启应用才恢复。用户刚做完
 * 一件"大事"却立刻看到两个互相矛盾的数字；对不会电脑的人，这不叫 bug，叫"这软件靠不住"。
 *
 * 代价可忽略：`skuList({productId})` 回的是**单款**的映射条数（通常个位数）。
 * 收益是"同屏两栏不可能各说各话"——那比省一次 IPC 重要得多。
 */
async function loadLinks(productId: number): Promise<void> {
  if (linksLoading[productId]) return; // 只去重"同一次并发"，不拦"第二次展开"
  linksLoading[productId] = true;
  try {
    // 一次把该款的全部映射拿回来（含失效的），再按状态分开渲染 ——
    // 失效那几条也要能说出来（"被裁掉"和"不存在"在界面上必须长得不一样）。
    const res = await api.skuList({ productId, limit: 100 });
    links[productId] = res?.rows ?? [];
  } catch {
    // 取不到不该把展开区弄成一个错误红条：留空并允许下次再试
    links[productId] = undefined;
  } finally {
    linksLoading[productId] = false;
  }
}

/**
 * 页级「刷新」也刷新这一栏的展开区。
 *
 * 不刷的后果与上面那条缓存缺陷同源：页级刷新看起来"刷新了同屏每一栏"，而展开区里那块
 * 「已关联商品」纹丝不动 —— 又是"同一屏两个数字各说各话"。
 */
watch(
  () => props.refreshNonce,
  () => {
    if (expandedId.value) void loadLinks(expandedId.value);
  }
);
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
.gd-c-exp {
  width: 30px;
}
.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 48px;
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
  padding-right: 12px;
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

.gd-pane__caret {
  border: none;
  background: none;
  padding: 2px 4px;
  font: inherit;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.gd-pane__caret:hover {
  color: var(--wb-text);
}

/* 展开区所在行：不随 hover 高亮（它是详情不是可点行），底色与主行区分。
   ⚠️ 必须恢复 white-space: normal —— 展开区住在 .wb-table 的 td 里，而基座给 td 定了
   nowrap（styles/index.css），不恢复的话展开区里所有长文案（认款提示 / 说明 / 元信息）
   一行顶出去，横穿网格列压住右边的内容（2026-10-09 实测：hint 325px 顶进 217px 的列）。 */
.gd-pane__drow > td {
  padding: 0;
  background: var(--wb-surface-2);
  white-space: normal;
}
/* ── 展开区（2026-10-10 定稿）──────────────────────────────────────
   2026-10-09 那一版解决的是"分组"（四块平铺 → 主动作条 / 元信息带 / 双白卡）；
   2026-10-10 用户口径再砍一刀：SKU 清单整块撤掉、元信息带并入卡片 —— 只剩三层：
     ① 认款条（带主色浅底，展开区里唯一带色块 ⇒ 主动作一眼可见）；
     ② 档案卡（供应商 / 类目 / 备注 / 创建 + 编辑·删除）；
     ③ 「已关联商品」卡。
   三层都是**满宽**、同一套圆角与间距 —— 一列到底，不再有"左一块右一块、高低还不齐"。 */
.gd-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}
/* 认款动作条：满宽。挤在窄列里时提示语只能在 ~217px 里折行，
   主动作和它自己的说明被拆成两行读；`wrap` 让窄栏下按钮与提示自然换行而不是溢出。 */
.gd-detail__relate {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--wb-primary-soft);
  border-radius: var(--wb-radius-md);
  background: var(--wb-primary-soft);
}
.gd-detail__relate-hint {
  font-size: 12px;
  min-width: 0;
}
/* 卡片：从 surface-2 的井里浮起一级，块与块的边界不再靠猜 */
.gd-detail__block {
  min-width: 0;
  padding: 10px 12px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
}
.gd-detail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
/* 说明是 <p>：不给 margin 的话浏览器默认 1em 上下距会在标题和内容之间撑出一截 */
.gd-detail__note {
  margin: 0 0 8px;
  font-size: 12px;
}

/* 档案卡：label·值 一组一组横排。原先它是一条**裸露**的横排（无底色无边框），
   跟旁边两张白卡混在同一层上，读起来像"卡片漏出来的一行" —— 现在同为一等卡片。
   备注可能很长 —— 允许它占满一整行（flex-basis:100%），别的项保持紧凑。 */
.gd-detail__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 20px;
  padding: 9px 12px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  font-size: 12px;
}
.gd-detail__meta p {
  margin: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
/* 标签统一占位宽（供应商 / 类目 / 创建 / 备注 两三个字）⇒ 值从左对齐，一眼能横着比 */
.gd-detail__meta p > .wb-muted:first-child {
  min-width: 3.2em;
}
.gd-detail__meta-note {
  flex-basis: 100%;
}
.gd-detail__meta-note > .wb-muted:first-child {
  flex-shrink: 0;
}

.gd-links {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
}
.gd-links__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--wb-border);
}
.gd-links__row:last-child {
  border-bottom: none;
}
/* 平台名做成小标签靠右：原先它只是又一个灰字，跟店铺名挤在同一行分不出主次 */
.gd-links__plat {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 11px;
}
.gd-links__dead {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wb-warning);
}

.gd-detail__ops {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.gd-batch {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
