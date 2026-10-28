<template>
  <div class="wb-page lg-view">
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">记账</h1>
        <!-- 计划 §1.3 硬规则 3：口径必须常驻，不做成可关闭的引导 -->
        <p class="wb-head__desc">
          按已发生业务收支记账；与「统计」的订单毛利口径不同，不可相加
        </p>
      </div>
      <div class="wb-head__actions">
        <button class="wb-btn wb-btn--sm" type="button" data-act="open-parties" @click="partyOpen = true">
          相关人
        </button>
        <button class="wb-btn wb-btn--sm" type="button" data-act="open-categories" @click="categoryOpen = true">
          科目
        </button>
        <button class="wb-btn wb-btn--sm" type="button" data-act="ledger-import-open" @click="importOpen = true">
          批量导入
        </button>
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          data-act="ledger-export"
          :disabled="exporting || !rows.length"
          :title="rows.length ? `导出当前 ${rows.length} 条（按当前筛选）` : '没有可导出的条目'"
          @click="doExport"
        >
          {{ exporting ? '导出中…' : '导出' }}
        </button>
        <button class="wb-btn wb-btn--primary" type="button" data-act="new-entry" @click="openEditor(null)">
          记一笔
        </button>
      </div>
    </header>

    <div class="wb-seg lg-tabs" role="tablist" aria-label="记账视图" data-act="ledger-tabs">
      <button
        v-for="t in TABS"
        :key="t.value"
        class="wb-seg__item"
        type="button"
        role="tab"
        :class="{ 'is-on': tab === t.value }"
        :aria-selected="tab === t.value"
        :data-act="`ledger-tab-${t.value}`"
        @click="setTab(t.value)"
      >
        {{ t.label }}
      </button>
    </div>

    <template v-if="tab === 'detail'">
    <!-- 期间合计：**只认月份（或「全部日期」）**，不随下方筛选变化。
         口径写死在标签里（"整月" / "累计"），而不是让用户从数字反推 —— 选了店铺之后
         底部合计若还按筛选变，公共支出会被按整笔计入单店，数字就错了。
         按店铺归属的合计在「单店 / 汇总」页（读分摊行），不在这里跟着筛选变。 -->
    <div class="wb-metabar lg-metabar">
      <span class="lg-metabar__month" data-act="metabar-period">{{ periodScopeLabel }}</span>
      <span class="wb-metric" data-act="metric-income"
        >收入 <b>{{ money(summary?.incomeCents ?? 0) }}</b></span
      >
      <span class="wb-metric" data-act="metric-expense"
        >支出 <b>{{ money(summary?.expenseCents ?? 0) }}</b></span
      >
      <span class="wb-metric" data-act="metric-balance"
        >结余 <b>{{ money(summary?.balanceCents ?? 0) }}</b></span
      >
      <span class="wb-metric" data-act="metric-entries"
        >条目 <b>{{ summary?.entryCount ?? 0 }}</b></span
      >
      <span class="wb-metric" data-act="metric-shared"
        >其中公共 收 <b>{{ money(summary?.sharedIncomeCents ?? 0) }}</b> · 支
        <b>{{ money(summary?.sharedExpenseCents ?? 0) }}</b></span
      >
    </div>

    <!-- 体检异常只在**真异常**时出现：正常恒为 0，摆一排 0 就是噪声。 -->
    <p v-if="integrityIssues.length" class="wb-notice wb-notice--error" data-act="integrity-warning">
      数据体检不通过：{{ integrityIssues.join('；') }}。这些数暂时不能用来做决定，请先排查。
    </p>

    <div class="lg-filters">
      <div class="lg-month">
        <button class="wb-btn wb-btn--sm" type="button" data-act="month-prev" aria-label="上个月" @click="shiftMonth(-1)">
          ‹
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__label"
          type="button"
          data-act="month-now"
          title="回到本月"
          @click="toThisMonth"
        >
          {{ monthLabel() }}
        </button>
        <button class="wb-btn wb-btn--sm" type="button" data-act="month-next" aria-label="下个月" @click="shiftMonth(1)">
          ›
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__all"
          type="button"
          data-act="month-all"
          :class="{ 'is-on': isAllPeriod }"
          :aria-pressed="isAllPeriod"
          title="不限月份：列出库里全部日期的条目（合计也随之变成累计）"
          @click="setAllPeriod"
        >
          全部
        </button>
      </div>

      <div class="wb-seg" role="tablist" aria-label="收支方向" data-act="filter-kind">
        <button
          v-for="k in KIND_TABS"
          :key="k.value"
          class="wb-seg__item"
          type="button"
          role="tab"
          :class="{ 'is-on': kind === k.value }"
          :aria-selected="kind === k.value"
          :data-act="`filter-kind-${k.value || 'all'}`"
          @click="setKind(k.value)"
        >
          {{ k.label }}
        </button>
      </div>

      <select v-model.number="shopId" class="wb-input wb-input--sm" data-act="filter-shop" aria-label="按店铺筛选" @change="applyFilter()">
        <option :value="0">全部店铺</option>
        <option v-for="s in shops" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>

      <select
        v-model.number="categoryId"
        class="wb-input wb-input--sm"
        data-act="filter-category"
        aria-label="按科目筛选"
        @change="applyFilter()"
      >
        <option :value="0">全部科目</option>
        <optgroup v-for="g in categoryGroups" :key="g.kind" :label="KIND_LABEL[g.kind]">
          <option v-for="c in g.rows" :key="c.id" :value="c.id">{{ c.name }}</option>
        </optgroup>
      </select>

      <select v-model.number="partyId" class="wb-input wb-input--sm" data-act="filter-party" aria-label="按相关人筛选" @change="applyFilter()">
        <option :value="0">全部相关人</option>
        <option v-for="p in parties" :key="p.id" :value="p.id">
          {{ p.name }}{{ p.archived ? '（已停用）' : '' }}
        </option>
      </select>

      <select v-model="scope" class="wb-input wb-input--sm" data-act="filter-scope" aria-label="按范围筛选" @change="applyFilter()">
        <option value="">全部范围</option>
        <option value="shop">本店</option>
        <option value="shared">公共</option>
      </select>

      <select
        v-model="settleStatus"
        class="wb-input wb-input--sm"
        data-act="filter-settle"
        aria-label="按结算状态筛选"
        @change="applyFilter()"
      >
        <option value="">全部结算状态</option>
        <option value="unsettled">未结算</option>
        <option value="settled">已结算</option>
      </select>

      <label class="lg-check">
        <input v-model="includeVoid" type="checkbox" data-act="filter-void" @change="applyFilter()" />
        含作废
      </label>

      <input
        v-model="keyword"
        class="wb-input wb-input--sm lg-search"
        data-act="filter-keyword"
        placeholder="搜索备注 / 科目 / 相关人"
        @input="onKeyword"
      />

      <button class="wb-btn wb-btn--sm" type="button" data-act="filter-reset" :disabled="!hasFilter" @click="resetFilters()">
        重置
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="ledger-error">{{ error }}</p>
    <p v-if="masterError" class="wb-notice wb-notice--error" data-act="ledger-master-error">
      科目 / 相关人 / 店铺读取失败：{{ masterError }}
      <button class="wb-btn wb-btn--sm" type="button" data-act="master-error-retry" @click="reloadMasterData()">
        重试
      </button>
    </p>

    <section class="wb-panel lg-panel">
      <div class="wb-panel__head">
        <span>明细</span>
        <span class="wb-muted">{{ rows.length }} 条</span>
        <span v-if="hasFilter" class="wb-tag is-on">已筛选</span>
      </div>

      <div class="wb-panel__body wb-table-wrap">
        <div v-if="loading" class="lg-hint">读取中…</div>

        <table v-else-if="rows.length" class="wb-table lg-table" data-act="ledger-table">
          <thead>
            <tr>
              <th class="lg-c-check">
                <input
                  type="checkbox"
                  data-act="select-all"
                  :checked="allSelectableSelected"
                  :disabled="!selectableIds.length"
                  :title="allSelectableSelected ? '取消全选' : '全选有效条目'"
                  @change="toggleAllRows"
                />
              </th>
              <th class="lg-c-date">日期</th>
              <th>科目</th>
              <th class="lg-c-scope">范围</th>
              <th>店铺 / 分摊</th>
              <th>相关人</th>
              <th class="wb-num lg-c-amt">金额</th>
              <th class="lg-c-settle">结算</th>
              <th class="lg-c-note">备注</th>
              <th class="lg-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <!-- 整行可点开编辑（同供应商页），行内动作 stopPropagation —— 
                 否则"点作废"会顺带打开编辑弹层，两个弹层叠在一起。 -->
            <template v-for="r in rows" :key="r.id">
            <tr
              :data-entry-id="r.id"
              class="lg-row"
              :class="{ 'is-void': r.status === 'void', 'is-clickable': r.status === 'active' }"
              :title="r.status === 'void' ? `已作废：${r.voidReason || '—'}` : '点击编辑这笔账'"
              :tabindex="r.status === 'active' ? 0 : -1"
              :role="r.status === 'active' ? 'button' : undefined"
              @click="onRowClick(r)"
              @keydown.enter.prevent="onRowClick(r)"
            >
              <td class="lg-c-check" @click.stop>
                <input
                  v-if="r.status === 'active'"
                  type="checkbox"
                  :checked="selected.has(r.id)"
                  :data-act="`select-entry-${r.id}`"
                  :title="'勾选后可批量变更相关人或结算'"
                  @change="toggleRow(r.id)"
                />
                <span v-else class="wb-muted" title="已作废的条目不参与批量操作">—</span>
              </td>
              <td class="wb-mono lg-nowrap" data-act="entry-date">{{ r.bizDate }}</td>
              <td data-act="entry-category">{{ r.categoryName || '—' }}</td>
              <td data-act="entry-scope">
                <span class="wb-tag" :class="{ 'is-warn': r.scope === 'shared' }">{{ SCOPE_LABEL[r.scope] }}</span>
              </td>
              <td data-act="entry-shop">
                <template v-if="r.scope === 'shop'">{{ r.shopName || '—' }}</template>
                <button
                  v-else
                  class="wb-link lg-shared-note lg-expand"
                  type="button"
                  :data-act="`entry-alloc-toggle-${r.id}`"
                  :aria-expanded="expandedId === r.id"
                  :title="expandedId === r.id ? '收起分摊明细' : '展开看这家店摊了多少'"
                  @click.stop="toggleAllocations(r)"
                >
                  <span>摊 {{ r.allocCount }} 家</span>
                  <span class="lg-expand__caret" aria-hidden="true">{{ expandedId === r.id ? '▾' : '▸' }}</span>
                </button>
              </td>
              <td data-act="entry-party">
                {{ r.partyName || '—' }}
                <span v-if="r.partyArchived" class="wb-muted lg-archived">已停用</span>
              </td>
              <td class="wb-num lg-c-amt" :class="r.kind === 'income' ? 'lg-amt--income' : 'lg-amt--expense'" data-act="entry-amount">
                {{ r.kind === 'income' ? '+' : '−' }}{{ money(r.amountCents) }}
              </td>
              <td data-act="entry-settled">
                <span v-if="r.status === 'void'" class="wb-tag">作废</span>
                <span v-else-if="r.settled" class="wb-tag is-on" :title="`结算单 #${r.settlementId}`">已结算</span>
                <span v-else class="wb-muted">未结算</span>
              </td>
              <td class="lg-c-note" data-act="entry-note">
                <span v-if="r.status === 'void'" class="lg-void-reason">作废：{{ r.voidReason || '—' }}</span>
                <span v-else-if="r.note" class="lg-note" :title="r.note">{{ r.note }}</span>
                <span v-else class="wb-muted">—</span>
              </td>
              <td class="lg-c-ops">
                <button
                  class="wb-link"
                  type="button"
                  data-act="entry-edit"
                  :disabled="r.status === 'void'"
                  @click.stop="openEditor(r.id)"
                >
                  编辑
                </button>
                <!-- 已结算/已作废的不能作废：按钮保持可见但禁用，title 说明原因 —— 
                     直接藏掉的话，用户会以为"这个功能坏了"或"漏了权限"。 -->
                <button
                  class="wb-link wb-link--danger"
                  type="button"
                  data-act="entry-void"
                  :disabled="r.status === 'void' || r.settled"
                  :title="
                    r.settled
                      ? `已被结算单 #${r.settlementId} 占用，请先撤销结算再作废`
                      : r.status === 'void'
                        ? '这条已作废'
                        : '作废这条账（需填原因，历史仍可查）'
                  "
                  @click.stop="askVoid(r)"
                >
                  作废
                </button>
                <!-- 作废可逆：原先只有「作废」没有出口，录错了作废后只能重录一笔（审查 §4-2）。
                     只在作废行上出现 —— 有效行没有「恢复」这回事，摆在那里只会让人误点。 -->
                <button
                  v-if="r.status === 'void'"
                  class="wb-link"
                  type="button"
                  data-act="entry-restore"
                  title="把这条账恢复为有效（重新计入合计与相关人往来）"
                  @click.stop="askRestore(r)"
                >
                  恢复
                </button>
              </td>
            </tr>

            <!-- 分摊明细行：只在点开「摊 N 家」时出现（不是默认展开 —— 公共条目一多，
                 全部展开会把明细表挤得看不见账）。数据按需拉取并缓存，编辑保存后清空。 -->
            <tr v-if="expandedId === r.id" class="lg-alloc-detail" :data-alloc-detail="r.id">
              <td colspan="10">
                <div v-if="allocLoading === r.id" class="wb-muted">读取分摊…</div>
                <p v-else-if="allocError" class="wb-notice wb-notice--error">{{ allocError }}</p>
                <template v-else>
                  <div class="lg-alloc-detail__head">
                    <span>分摊明细 · {{ r.basis ? BASIS_LABEL[r.basis] : '—' }}</span>
                    <span class="wb-muted">
                      合计 {{ money(allocSum(r)) }} / 条目 {{ money(r.amountCents) }}
                    </span>
                  </div>
                  <table class="wb-table lg-alloc-table" data-act="alloc-detail-table">
                    <thead>
                      <tr>
                        <th>店铺</th>
                        <th class="wb-num">摊入</th>
                        <th class="wb-num">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="a in allocRowsOf(r)" :key="a.shopId">
                        <td>{{ a.shopName || `店铺 #${a.shopId}` }}</td>
                        <td class="wb-num">{{ money(a.amountCents) }}</td>
                        <td class="wb-num wb-muted">{{ (a.ratioBp / 100).toFixed(2) }}%</td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-if="allocGap(r) !== 0" class="wb-notice wb-notice--error">
                    分摊合计与条目金额差 {{ money(Math.abs(allocGap(r))) }} —— 这条账需要重新编辑保存。
                  </p>
                </template>
              </td>
            </tr>
            </template>
          </tbody>
        </table>

        <div v-else class="wb-empty" data-act="ledger-empty">
          <div class="wb-empty__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4Z" />
              <path d="M4 17a3 3 0 0 1 3-3h11" />
              <path d="M8 7h6M8 10h5" />
            </svg>
          </div>
          <template v-if="hasFilter">
            <p class="wb-empty__title">没有符合条件的条目</p>
            <p class="wb-empty__desc">换个筛选条件试试，或重置后看{{ isAllPeriod ? '全部日期' : '整月' }}的全部条目。</p>
            <div class="wb-empty__actions">
              <button class="wb-btn" type="button" data-act="empty-reset" @click="resetFilters()">重置筛选</button>
            </div>
          </template>
          <template v-else>
            <p class="wb-empty__title">{{ isAllPeriod ? '还没有任何记账' : `${monthLabel()}还没有记账` }}</p>
            <p class="wb-empty__desc">
              记一笔之后，这里能看到每笔的店铺归属、公共开支分摊到每家店多少，以及钱该收谁、该付谁。
            </p>
            <div class="wb-empty__actions">
              <button class="wb-btn wb-btn--primary" type="button" data-act="empty-new" @click="openEditor(null)">
                记一笔
              </button>
            </div>
          </template>
        </div>
      </div>

      <div class="wb-panel__foot lg-foot">
        <span class="wb-muted">当前显示 {{ rows.length }} 条</span>
        <span v-if="rows.length >= LIST_LIMIT" class="wb-notice wb-notice--warn lg-limit">
          已达 {{ LIST_LIMIT }} 条上限，更早的条目请按月或缩小范围查看
        </span>
        <span class="lg-foot__spacer"></span>
        <span class="wb-muted">合计见上方「{{ periodScopeLabel }}」</span>
      </div>
    </section>

    <!-- 导入是"一次写很多条"的动作，文件选错/列读错时只能逐条作废（审查 §5-5）。
         撤销入口只活在**本次会话**：ids 存在内存里，切页/重启即消失 —— 所以文案必须写明，
         绝不能让用户以为"以后还能回来撤"，那会让他不再核对文件。 -->
    <div v-if="importUndo" class="lg-undo wb-notice wb-notice--ok" data-act="import-undo-bar">
      <span>
        刚导入 <b data-act="import-undo-count">{{ importUndo.created }}</b> 笔（收入
        {{ money(importUndo.incomeCents) }} / 支出 {{ money(importUndo.expenseCents) }}）
      </span>
      <span class="lg-undo__spacer"></span>
      <button class="wb-link" type="button" data-act="import-undo" @click="importUndoOpen = true">
        撤销本次导入（{{ importUndo.ids.length }} 条）
      </button>
      <button class="wb-link" type="button" data-act="import-undo-dismiss" @click="importUndo = null">
        不用了
      </button>
    </div>

    <!-- 批量操作条只在有勾选时出现（吸底）：批量动作与逐行编辑分开，避免误触 -->
    <div v-if="selected.size" class="lg-batch" data-act="batch-bar">
      <span>
        已选 <b data-act="batch-count">{{ selected.size }}</b> 条 · 收
        <b class="wb-mono" data-act="batch-sum-income">{{ money(selectedIncomeCents) }}</b> · 支
        <b class="wb-mono" data-act="batch-sum-expense">{{ money(selectedExpenseCents) }}</b>
      </span>
      <span v-if="batchSettleBlock" class="wb-muted lg-batch__why" data-act="batch-settle-hint">
        {{ batchSettleBlock }}
      </span>
      <span class="lg-batch__spacer"></span>
      <button
        class="wb-btn wb-btn--sm"
        type="button"
        data-act="batch-settle"
        :disabled="!!batchSettleBlock"
        :title="batchSettleBlock || '为这些条目生成一张结算单（同一相关人、同一方向）'"
        @click="batchSettle"
      >
        结算
      </button>
      <button
        class="wb-btn wb-btn--sm wb-btn--primary"
        type="button"
        data-act="batch-repatch"
        @click="openRepatch"
      >
        变更相关人
      </button>
      <button class="wb-btn wb-btn--sm" type="button" data-act="batch-clear" @click="clearSelection">
        清除选择
      </button>
    </div>
    </template>

    <PartyLedger
      v-else-if="tab === 'parties'"
      ref="partyLedgerRef"
      @changed="onPartyLedgerChanged"
      @manage="partyOpen = true"
    />

    <ShopView
      v-else-if="tab === 'shop'"
      :month="month"
      :month-label="monthLabel()"
      :shops="shops"
      :shop-id="shopViewId"
      @update:month="setMonth"
      @update:shop-id="setShopViewId"
    />

    <SummaryView
      v-else
      :month="month"
      :month-label="monthLabel()"
      @update:month="setMonth"
      @drill-shared="drillShared"
      @open-entry="openEntryFromSummary"
    />

    <SettlementDialog
      v-if="settleCtx"
      :party-id="settleCtx.partyId"
      :party-name="settleCtx.partyName"
      :balance="settleCtx.balance"
      :initial-entry-ids="settleCtx.entryIds"
      :initial-direction="settleCtx.direction"
      @close="settleCtx = null"
      @done="onBatchSettled"
    />

    <RepatchDialog
      v-if="repatchOpen"
      :entry-ids="repatchEntryIds"
      :parties="parties"
      @close="repatchOpen = false"
      @done="onRepatchDone"
    />

    <LedgerImportDialog
      v-if="importOpen"
      :categories="categories"
      :parties="parties"
      :shops="shops"
      @close="importOpen = false"
      @done="onImportDone"
    />

    <EntryEditor
      v-if="editorOpen"
      :entry-id="editingId"
      :month="month"
      :default-kind="kind || 'expense'"
      :categories="categories"
      :parties="parties"
      :shops="shops"
      :last-party="lastParty"
      @close="editorOpen = false"
      @saved="onSaved"
      @repatch="onEditorRepatch"
      @master-changed="loadMasterData()"
    />

    <PartyManager v-if="partyOpen" @close="partyOpen = false" @changed="onPartiesChanged" />

    <CategoryManager v-if="categoryOpen" @close="categoryOpen = false" @changed="onCategoriesChanged" />

    <ConfirmDialog
      v-if="pendingVoid"
      title="作废这笔账"
      confirm-text="确认作废"
      busy-text="作废中…"
      :busy="voidBusy"
      @close="pendingVoid = null"
      @confirm="confirmVoid"
    >
      <p>
        {{ pendingVoid.bizDate }} · {{ pendingVoid.categoryName || '未分类' }} ·
        <b class="wb-mono">{{ money(pendingVoid.amountCents) }}</b>
        （{{ KIND_LABEL[pendingVoid.kind] }}）
      </p>
      <p class="wb-field__hint">
        作废不会删除这条账：它仍留在明细里（勾「含作废」可见），并从所有合计中移除。
      </p>
      <label class="wb-field">
        <span class="wb-field__label">作废原因 <i class="wb-field__req">*</i></span>
        <textarea
          v-model="voidReason"
          class="wb-input"
          rows="2"
          data-act="void-reason"
          placeholder="如：金额录错，已重记一笔"
        ></textarea>
      </label>
      <p v-if="voidError" class="wb-notice wb-notice--error">{{ voidError }}</p>
    </ConfirmDialog>

    <!-- 恢复：作废的逆操作。不用危险色 —— 它的方向是"把账加回来"，不是删东西 -->
    <ConfirmDialog
      v-if="pendingRestore"
      title="恢复这笔账"
      confirm-text="确认恢复"
      busy-text="恢复中…"
      :busy="restoreBusy"
      :danger="false"
      @close="pendingRestore = null"
      @confirm="confirmRestore"
    >
      <p>
        {{ pendingRestore.bizDate }} · {{ pendingRestore.categoryName || '未分类' }} ·
        <b class="wb-mono">{{ money(pendingRestore.amountCents) }}</b>
        （{{ KIND_LABEL[pendingRestore.kind] }}）
      </p>
      <p class="wb-field__hint">
        恢复后这条账<b>重新计入合计与相关人往来</b>，作废原因会被清掉（操作日志里仍留有记录）。
        如果同一笔已经重录过，请先确认现在没有重复。
      </p>
      <p v-if="restoreError" class="wb-notice wb-notice--error">{{ restoreError }}</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="importUndoOpen && importUndo"
      title="撤销本次导入"
      :confirm-text="`作废这 ${importUndo.ids.length} 条`"
      busy-text="撤销中…"
      :busy="importUndoBusy"
      @close="importUndoOpen = false"
      @confirm="confirmImportUndo"
    >
      <p>
        把刚导入的 <b>{{ importUndo.ids.length }}</b> 条全部作废（收入
        {{ money(importUndo.incomeCents) }} / 支出 {{ money(importUndo.expenseCents) }}）。
      </p>
      <p class="wb-field__hint">
        作废不删行：这批账仍留在明细里（勾「含作废」可见，原因写「撤销本次导入」），
        只是不再计入合计与往来。<b>本批自动新建的相关人 / 科目不会跟着删掉</b> ——
        它们可能已经挂在别的账上，删了就会连带失联。
      </p>
      <p class="wb-field__hint">
        整批一个事务：要么全撤，要么一条都不撤。这个入口只在本次打开应用期间有效。
      </p>
      <p v-if="importUndoError" class="wb-notice wb-notice--error">{{ importUndoError }}</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「记账」模块的四个页签（P4 收口）：
//   ① 明细：按期间/方向/店铺/科目/相关人/范围/结算状态筛条目，批量变更相关人 / 批量结算 / 导出；
//   ② 往来：相关人台账与结算（见 PartyLedger）；
//   ③ 单店：一家店的收入/支出/结余 + 科目分布（含公摊）+ 与统计口径的只读对照；
//   ④ 汇总：店铺汇总表 + 公共池与对账体检（三个恒等式）。
//
// ⚠️ 明细页上方合计只按**月份**取（`ledgerSummary(month)`），不跟筛选联动。
//   原因是店铺维度的正确金额来自**分摊行**（公共支出摊到该店的部分），而列表行只有
//   整笔金额 —— 在渲染层按筛选行求和，会把一笔公共开支整笔算进某一家店。
//   按店铺归属的合计在「单店 / 汇总」页（读 `byShop` / `shopBreakdown`），不在这里重算。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useLedger } from './useLedger';
import EntryEditor from './EntryEditor.vue';
import PartyManager from './PartyManager.vue';
import PartyLedger from './PartyLedger.vue';
import CategoryManager from './CategoryManager.vue';
import ShopView from './ShopView.vue';
import SummaryView from './SummaryView.vue';
import SettlementDialog from './SettlementDialog.vue';
import RepatchDialog from './RepatchDialog.vue';
import LedgerImportDialog from './LedgerImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import { conservationGap, formatCents } from '@/lib/ledger';
import { localDayKey } from '@/lib/localDay';
import * as api from './api';
import { BASIS_LABEL, KIND_LABEL, SCOPE_LABEL } from './labels';
import { ALL_PERIOD, type LedgerTab } from './useLedger';
import type { LedgerAllocationRow, LedgerEntryRow, LedgerPartyLedgerRow, LedgerRepatchResult } from '@/types';

const LIST_LIMIT = 1000;

const TABS: Array<{ value: LedgerTab; label: string }> = [
  { value: 'detail', label: '明细' },
  { value: 'parties', label: '往来' },
  { value: 'shop', label: '单店' },
  { value: 'summary', label: '汇总' },
];

const KIND_TABS: Array<{ value: '' | 'income' | 'expense'; label: string }> = [
  { value: '', label: '全部' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
];

const {
  tab,
  month,
  monthLabel,
  isAllPeriod,
  setAllPeriod,
  shiftMonth,
  kind,
  shopId,
  categoryId,
  partyId,
  scope,
  settleStatus,
  includeVoid,
  keyword,
  shopViewId,
  rows,
  summary,
  categories,
  parties,
  shops,
  lastParty,
  loading,
  error,
  masterError,
  init,
  load,
  loadMasterData,
  reloadMasterData,
  applyFilter,
  resetFilters,
  rememberParty,
  persist,
} = useLedger();

/**
 * 顶部合计的**期间口径**（写死在标签里，不让用户从数字反推）。
 * 全部日期下必须说「累计」—— 说「整月」会让人以为这是某一个月的数。
 */
const periodScopeLabel = computed(() => (isAllPeriod.value ? '全部日期 · 累计' : `${monthLabel()} · 整月`));

const editorOpen = ref(false);
const editingId = ref<number | null>(null);
const importOpen = ref(false);
const partyOpen = ref(false);
const categoryOpen = ref(false);
const partyLedgerRef = ref<InstanceType<typeof PartyLedger> | null>(null);

/** 批量勾选只对**有效**条目生效：作废条目留在表里可查，但不能被改挂/结算 */
const selected = ref(new Set<number>());
const selectableIds = computed(() => rows.value.filter((r) => r.status === 'active').map((r) => r.id));
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(r.id)));
// 批量条是结算前唯一的金额确认：收支混加会把"收 5000 + 支 5000"显示成 ¥0.00，数字直接失去意义
const selectedIncomeCents = computed(() =>
  selectedRows.value.filter((r) => r.kind === 'income').reduce((sum, r) => sum + r.amountCents, 0)
);
const selectedExpenseCents = computed(() =>
  selectedRows.value.filter((r) => r.kind === 'expense').reduce((sum, r) => sum + r.amountCents, 0)
);
const allSelectableSelected = computed(
  () => selectableIds.value.length > 0 && selectableIds.value.every((id) => selected.value.has(id))
);

const repatchOpen = ref(false);
const repatchEntryIds = ref<number[]>([]);
const exporting = ref(false);

interface BatchSettleCtx {
  partyId: number;
  partyName: string;
  balance: LedgerPartyLedgerRow;
  entryIds: number[];
  direction: 'pay' | 'receive';
}
const settleCtx = ref<BatchSettleCtx | null>(null);

/**
 * 批量结算的前置条件（返回非空 = 不可结，文案直接给用户看）。
 * 一张结算单只能结「同一相关人 + 同一方向」的条目，否则会把两边余额同时记错（方案 §6.3）。
 */
const batchSettleBlock = computed<string>(() => {
  const rs = selectedRows.value;
  if (!rs.length) return '先勾选条目';
  if (rs.some((r) => r.settled)) return '已结算的条目不能再结，请取消勾选或改用「变更相关人」';
  if (rs.some((r) => !r.partyId)) return '有条目缺少相关人，无法结算';
  if (rs.some((r) => r.partyId !== rs[0].partyId)) return '所选条目属于不同相关人，请先变更相关人或分开结算';
  if (rs.some((r) => r.kind !== rs[0].kind)) return '所选条目收支方向不同，一张结算单只能结同一方向';
  return '';
});

function toggleRow(id: number): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAllRows(): void {
  selected.value = allSelectableSelected.value ? new Set() : new Set(selectableIds.value);
}

function clearSelection(): void {
  selected.value = new Set();
}

// 重取列表后（改月份/筛选/作废）把已不在列表里的勾选摘掉 —— 否则批量条上留着看不见的条目
watch(rows, () => {
  const valid = new Set(rows.value.filter((r) => r.status === 'active').map((r) => r.id));
  const next = new Set([...selected.value].filter((id) => valid.has(id)));
  if (next.size !== selected.value.size) selected.value = next;
});

function openRepatch(): void {
  if (!selectedRows.value.length) return;
  repatchEntryIds.value = selectedRows.value.map((r) => r.id);
  repatchOpen.value = true;
}

/** 已结算行的编辑弹层点了「变更相关人…」：关掉表单，直接开改挂（C 路会披露将作废的结算单） */
function onEditorRepatch(id: number): void {
  editorOpen.value = false;
  editingId.value = null;
  repatchEntryIds.value = [id];
  repatchOpen.value = true;
}

async function onRepatchDone(result: LedgerRepatchResult): Promise<void> {
  repatchOpen.value = false;
  clearSelection();
  await load();
  await partyLedgerRef.value?.reload();
  // 结果必须给可核对的数字（方案 §6.4 硬约束 3）：改了几条、留了几条、作废几张、原人还剩多少
  const bits = [`已改挂 ${result.movedCount} 条（${money(result.movedCents)}）到「${result.toPartyName}」`];
  if (result.keptSettledCount) {
    bits.push(`已结算 ${result.keptSettledCount} 条留在原人（${money(result.keptSettledCents)}）`);
  }
  if (result.voidedSettlements.length) {
    bits.push(`作废结算单 ${result.voidedSettlements.length} 张`);
  }
  for (const f of result.fromParties) {
    bits.push(`「${f.partyName}」改挂后未结清 ${money(f.remainingUnsettledCents)}`);
  }
  toast(bits.join('；'), 'success');
}

/**
 * 导入的结果必须给可核对的数字（与「批量变更相关人」同口径）：
 * 导了几笔、金额各多少、摊出几行分摊 —— 只说"成功"用户没法确认文件真的读对了。
 */
async function onImportDone(result: {
  created: number;
  allocations: number;
  rows: number;
  incomeCents: number;
  expenseCents: number;
  sheetName: string;
  periods: string[];
  createdParties: string[];
  createdCategories: string[];
  ids: number[];
}): Promise<void> {
  importOpen.value = false;
  // 分摊行是新写入的：缓存里的旧形状不能再展示
  clearAllocCache();
  // 整份文件只写了一个月时跟着切过去，否则"已导入"却看不到这些条目。
  // 「全部日期」下不切：这批本来就在列表里，切走反而把用户选的期间改掉。
  if (!isAllPeriod.value && result.periods.length === 1 && result.periods[0] !== month.value) {
    month.value = result.periods[0];
    persist();
  }
  await load();
  // 导入会自动新建相关人/科目：主数据缓存必须跟着刷，否则弹层里下拉还是旧名单
  if (result.createdParties.length || result.createdCategories.length) await loadMasterData();
  await partyLedgerRef.value?.reload();
  const bits = [
    `已导入 ${result.created} 笔（收入 ${money(result.incomeCents)} / 支出 ${money(result.expenseCents)}）`,
  ];
  if (result.allocations) bits.push(`分摊明细 ${result.allocations} 行`);
  if (result.createdParties.length) bits.push(`新建相关人 ${result.createdParties.join('、')}`);
  if (result.createdCategories.length) bits.push(`新建科目 ${result.createdCategories.join('、')}`);
  toast(`${bits.join(' · ')}（来自「${result.sheetName}」）`, 'success');
  // 撤销入口只保留最近一次导入：两次导入后还能撤上一批的话，用户会以为撤的是"刚才那批"
  importUndo.value = result.ids.length
    ? {
        created: result.created,
        incomeCents: result.incomeCents,
        expenseCents: result.expenseCents,
        ids: [...result.ids],
      }
    : null;
}

async function confirmImportUndo(): Promise<void> {
  const target = importUndo.value;
  if (!target || !target.ids.length || importUndoBusy.value) return;
  importUndoBusy.value = true;
  importUndoError.value = '';
  try {
    const res = await api.entriesVoid(target.ids, '撤销本次导入');
    importUndoOpen.value = false;
    importUndo.value = null;
    clearAllocCache();
    clearSelection();
    toast(`已撤销本次导入：${res.voided} 条已作废（勾「含作废」仍可看到）`, 'success');
    await load();
    await partyLedgerRef.value?.reload();
  } catch (e: unknown) {
    // 整批事务：失败就是一条都没撤，文案不能写成"部分撤销"
    importUndoError.value = `撤销失败，一条都没撤：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    importUndoBusy.value = false;
  }
}

async function batchSettle(): Promise<void> {
  if (batchSettleBlock.value) {
    toast(batchSettleBlock.value, 'error');
    return;
  }
  const rs = selectedRows.value;
  const partyId = rs[0].partyId;
  try {
    // 结算上限按**分方向余额**判定，弹层需要这个人的完整台账行
    const ledgers = await api.partyLedger({ partyId });
    const row = ledgers.find((l) => l.partyId === partyId);
    if (!row) throw new Error('相关人台账里找不到这个人，请到「往来」页刷新后重试');
    settleCtx.value = {
      partyId,
      partyName: row.partyName,
      balance: row,
      entryIds: rs.map((r) => r.id),
      direction: rs[0].kind === 'expense' ? 'pay' : 'receive',
    };
  } catch (e: unknown) {
    toast(`打不开结算：${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

async function onBatchSettled(): Promise<void> {
  settleCtx.value = null;
  clearSelection();
  await load();
  await partyLedgerRef.value?.reload();
}

const pendingVoid = ref<LedgerEntryRow | null>(null);
const voidReason = ref('');
const voidError = ref('');
const voidBusy = ref(false);

/**
 * 作废的逆操作。
 * 只有 `void → active` 一条路：恢复不新建条目、不动金额，所以它不会产生"第二份实现"的账。
 * 后端会拒绝「恢复后被有效结算单占用」和「分摊合计 ≠ 条目金额」两种情况（前者会改结算单语义，
 * 后者说明分摊行在作废期间被改动过），错误原文直接透给用户 —— 那时该做的是重新记一笔，不是恢复。
 */
const pendingRestore = ref<LedgerEntryRow | null>(null);
const restoreError = ref('');
const restoreBusy = ref(false);

/**
 * 「撤销本次导入」（轻量版：会话级）。
 * 计划 D4 的完整版要 `bk_entries.import_batch_id` + 导入历史列表（跨会话撤销），那要迁移；
 * 轻量版先救最疼的一次 —— 文件选错、列读错，导完当场发现。ids 只在内存里，重启即失效。
 */
const importUndo = ref<{
  created: number;
  incomeCents: number;
  expenseCents: number;
  ids: number[];
} | null>(null);
const importUndoOpen = ref(false);
const importUndoBusy = ref(false);
const importUndoError = ref('');

/** 展开中的分摊明细（按条目缓存；编辑/作废后清空，避免展示旧分摊） */
const expandedId = ref<number | null>(null);
const allocCache = ref<Record<number, LedgerAllocationRow[]>>({});
const allocLoading = ref(0);
const allocError = ref('');

function allocRowsOf(r: LedgerEntryRow): LedgerAllocationRow[] {
  return allocCache.value[r.id] ?? [];
}

function allocSum(r: LedgerEntryRow): number {
  return allocRowsOf(r).reduce((s, a) => s + a.amountCents, 0);
}

/** 非 0 = 库里这条的分摊与条目金额对不上（体检也会报，这里定位到具体一笔） */
function allocGap(r: LedgerEntryRow): number {
  if (!allocRowsOf(r).length) return 0;
  return conservationGap(r.amountCents, allocRowsOf(r));
}

function clearAllocCache(): void {
  allocCache.value = {};
  expandedId.value = null;
}

async function toggleAllocations(r: LedgerEntryRow): Promise<void> {
  if (expandedId.value === r.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = r.id;
  allocError.value = '';
  if (allocCache.value[r.id]) return;
  allocLoading.value = r.id;
  try {
    const d = await api.entryDetail(r.id);
    if (!d) throw new Error('条目不存在或已被删除');
    allocCache.value = { ...allocCache.value, [r.id]: d.allocations };
  } catch (e: unknown) {
    allocError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (allocLoading.value === r.id) allocLoading.value = 0;
  }
}

const hasFilter = computed(
  () =>
    !!kind.value ||
    !!shopId.value ||
    !!categoryId.value ||
    !!partyId.value ||
    !!scope.value ||
    !!settleStatus.value ||
    includeVoid.value ||
    !!keyword.value.trim()
);

const categoryGroups = computed(() =>
  (['expense', 'income'] as const)
    .map((k) => ({ kind: k, rows: categories.value.filter((c) => c.kind === k) }))
    .filter((g) => g.rows.length > 0)
);

/** 体检异常翻译成人话：数字后面必须说清"差的是什么"，否则用户只能看到一串分。 */
const integrityIssues = computed<string[]>(() => {
  const it = summary.value?.integrity;
  if (!it) return [];
  const out: string[] = [];
  if (it.allocationGapCents !== 0) {
    out.push(`公共分摊合计比条目金额${it.allocationGapCents > 0 ? '多' : '少'} ${money(Math.abs(it.allocationGapCents))}`);
  }
  if (it.partyGapCents !== 0) {
    out.push(`相关人净往来与「总收入 − 总支出」差 ${money(Math.abs(it.partyGapCents))}`);
  }
  if (it.brokenEntries.length) {
    out.push(`${it.brokenEntries.length} 条公共条目的分摊不全`);
  }
  return out;
});

/** 负数（结余为负）把减号放符号前：`¥-1280.00` 读起来像"金额本身带负号"，`-¥1280.00` 才是欠钱 */
function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

function setKind(v: '' | 'income' | 'expense'): void {
  kind.value = v;
  persist();
  void load();
}

function toThisMonth(): void {
  month.value = localDayKey().slice(0, 7);
  persist();
  void load();
}

/** 单店 / 汇总页自己也有月份切换：改的是同一个月份（明细页跟着更新，不各存一份） */
function setMonth(v: string): void {
  // `all` 与 `YYYY-MM` 都合法；其余值静默忽略（下拉/按钮只会给这两种）
  if ((v !== ALL_PERIOD && !/^\d{4}-\d{2}$/.test(v)) || v === month.value) return;
  month.value = v;
  persist();
  void load();
}

function setShopViewId(id: number): void {
  shopViewId.value = Number(id) || 0;
  persist();
}

/** 公共池异常时的定位入口：回到明细并筛「范围 = 公共」 */
function drillShared(): void {
  tab.value = 'detail';
  scope.value = 'shared';
  persist();
  void load();
}

/** 导出的是**当前筛选结果**（不是整月）：筛选条件会写进表头，合计也只算导出的这批 */
const exportFilterLabel = computed<string>(() => {
  const parts: string[] = [];
  if (kind.value) parts.push(`收/支：${KIND_LABEL[kind.value]}`);
  if (shopId.value) {
    const name = shops.value.find((s) => s.id === shopId.value)?.name ?? `#${shopId.value}`;
    parts.push(`店铺：${name}`);
  }
  if (categoryId.value) {
    const name = categories.value.find((c) => c.id === categoryId.value)?.name ?? `#${categoryId.value}`;
    parts.push(`科目：${name}`);
  }
  if (partyId.value) {
    const name = parties.value.find((p) => p.id === partyId.value)?.name ?? `#${partyId.value}`;
    parts.push(`相关人：${name}`);
  }
  if (scope.value) parts.push(`范围：${SCOPE_LABEL[scope.value]}`);
  if (settleStatus.value) parts.push(`结算：${settleStatus.value === 'settled' ? '已结算' : '未结算'}`);
  if (includeVoid.value) parts.push('含作废');
  if (keyword.value.trim()) parts.push(`搜索：${keyword.value.trim()}`);
  // 列表有 1000 条上限，而「全部日期」最容易撞上：不写进表头，用户会以为整本账都导出来了
  const truncated =
    rows.value.length >= LIST_LIMIT ? `（列表已达 ${LIST_LIMIT} 条上限，导出只含当前显示的这些）` : '';
  if (!parts.length) {
    const base = isAllPeriod.value ? '未筛选（全部日期的全部条目）' : '未筛选（整月全部条目）';
    return base + truncated;
  }
  const base = parts.join(' · ');
  const withVoid = rows.value.some((r) => r.status === 'void') ? `${base}（合计只计有效条目）` : base;
  return withVoid + truncated;
});

async function doExport(): Promise<void> {
  if (exporting.value || !rows.value.length) return;
  exporting.value = true;
  try {
    const out = rows.value.map((r) => ({
      bizDate: r.bizDate,
      kindLabel: KIND_LABEL[r.kind],
      scopeLabel: SCOPE_LABEL[r.scope],
      shopLabel: r.scope === 'shop' ? r.shopName || '' : `公共（摊 ${r.allocCount} 家）`,
      partyName: r.partyName || '',
      categoryName: r.categoryName || '',
      amountCents: r.amountCents,
      settleLabel: r.status === 'void' ? '作废' : r.settled ? `已结算 #${r.settlementId}` : '未结算',
      note: r.note || '',
    }));
    // 合计只对有效条目求和（作废行仍在表里可查，但不参与合计）——与明细页的月份合计同口径
    const active = rows.value.filter((r) => r.status === 'active');
    const incomeCents = active.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amountCents, 0);
    const expenseCents = active.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amountCents, 0);
    const res = await api.exportExcel({
      title: '记账明细',
      periodLabel: monthLabel(),
      filterLabel: exportFilterLabel.value,
      rows: out,
      totalIncomeCents: incomeCents,
      totalExpenseCents: expenseCents,
      balanceCents: incomeCents - expenseCents,
      defaultName: `记账明细-${isAllPeriod.value ? '全部日期' : month.value}.xlsx`,
    });
    if (!res) return; // 用户点了取消
    toast(`已导出 ${res.rows} 行到 ${res.filePath}`, 'success');
  } catch (e: unknown) {
    toast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    exporting.value = false;
  }
}

let kwTimer: ReturnType<typeof setTimeout> | null = null;
function onKeyword(): void {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => void load(), 300);
}

function openEditor(id: number | null): void {
  editingId.value = id;
  editorOpen.value = true;
}

/** 汇总页体检点条目号：直接开这条账（不先切筛选，否则可能因为筛选把它挡住而"点了没反应"） */
function openEntryFromSummary(id: number): void {
  openEditor(id);
}

/** 切页签只改视图，不重取数据：往来页挂载时自己加载；明细的数据一直是最新的 */
function setTab(v: LedgerTab): void {
  if (tab.value === v) return;
  tab.value = v;
  persist();
}

function onRowClick(r: LedgerEntryRow): void {
  if (r.status !== 'active') return;
  openEditor(r.id);
}

async function onSaved(info: {
  id: number;
  period: string;
  created: boolean;
  kind: 'income' | 'expense';
  partyId: number;
}): Promise<void> {
  editorOpen.value = false;
  // 分摊可能已被重算：缓存里的旧分摊行不能再展示（否则显示的是改之前的数）
  clearAllocCache();
  rememberParty(info.kind, info.partyId);
  // 记的是别的月份的账：自动切到那个月，否则用户"保存成功"却看不到它。
  // 「全部日期」下不切 —— 本来就看得见，硬切会把用户刚选的"全部"改掉。
  if (!isAllPeriod.value && info.period !== month.value) {
    month.value = info.period;
    persist();
  }
  toast(info.created ? '已记一笔' : '已保存', 'success');
  await loadMasterData();
  await load();
  // 保存的条目可能被当前筛选挡住（方向/店铺/未结算/搜索）：不告诉用户"去哪了"，他会以为没记上再录一遍
  const landed = rows.value.some((r) => r.id === info.id);
  if (!landed) toast('这笔不在当前筛选结果里，点「重置」可看到它', 'info');
}

async function onPartiesChanged(): Promise<void> {
  await loadMasterData();
  await load();
  // 合并/停用会改往来余额：台账在页签里挂着时必须一并刷新，否则它显示合并前的数
  await partyLedgerRef.value?.reload();
}

/** 结算/撤销不产生收支，只改条目的"已结算"标记 —— 明细列表要重取，月份合计不用 */
async function onPartyLedgerChanged(): Promise<void> {
  await load();
}

async function onCategoriesChanged(): Promise<void> {
  await loadMasterData();
  await load();
}

function askVoid(r: LedgerEntryRow): void {
  pendingVoid.value = r;
  voidReason.value = '';
  voidError.value = '';
}

async function confirmVoid(): Promise<void> {
  const target = pendingVoid.value;
  if (!target || voidBusy.value) return;
  const why = voidReason.value.trim();
  if (!why) {
    voidError.value = '请填写作废原因（会记入操作日志）';
    return;
  }
  voidBusy.value = true;
  voidError.value = '';
  try {
    await api.entryVoid(target.id, why);
    pendingVoid.value = null;
    clearAllocCache();
    toast(`已作废 ${money(target.amountCents)}`, 'success');
    await load();
  } catch (e: unknown) {
    voidError.value = e instanceof Error ? e.message : String(e);
  } finally {
    voidBusy.value = false;
  }
}

function askRestore(r: LedgerEntryRow): void {
  pendingRestore.value = r;
  restoreError.value = '';
}

async function confirmRestore(): Promise<void> {
  const target = pendingRestore.value;
  if (!target || restoreBusy.value) return;
  restoreBusy.value = true;
  restoreError.value = '';
  try {
    await api.entryRestore(target.id);
    pendingRestore.value = null;
    clearAllocCache();
    toast(`已恢复 ${money(target.amountCents)}`, 'success');
    await load();
  } catch (e: unknown) {
    restoreError.value = e instanceof Error ? e.message : String(e);
  } finally {
    restoreBusy.value = false;
  }
}

onMounted(() => void init());
onBeforeUnmount(() => {
  if (kwTimer) clearTimeout(kwTimer);
});
</script>

<style scoped>
.lg-view {
  gap: 12px;
}
.lg-metabar {
  flex-shrink: 0;
}
.lg-tabs {
  flex-shrink: 0;
  align-self: flex-start;
}
/* 月份不是"指标"，不参与「标签 + 数字」的 baseline 对齐 —— 单独给一条左项 */
.lg-metabar__month {
  padding-right: 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  white-space: nowrap;
}

.lg-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.lg-month {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg-month__label {
  min-width: 96px;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
/* 「全部」不是月份，用一条细分隔线隔开，避免被读成"第 13 个月" */
.lg-month__all {
  margin-left: 2px;
  min-width: 44px;
  justify-content: center;
}
.lg-search {
  width: 190px;
}
.lg-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.lg-check input {
  accent-color: var(--wb-primary);
}

.lg-panel {
  flex: 1;
  min-height: 220px;
}
.lg-hint {
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.lg-table th,
.lg-table td {
  white-space: nowrap;
}
.lg-row.is-clickable {
  cursor: pointer;
}
.lg-row.is-clickable:hover {
  background: var(--wb-hover);
}
/* 作废行留在表里（历史可查），但必须一眼看出"它不算数" */
.lg-row.is-void {
  color: var(--wb-text-muted);
}
.lg-row.is-void .lg-c-amt {
  text-decoration: line-through;
}
.lg-nowrap {
  white-space: nowrap;
}
.lg-c-check {
  width: 34px;
  text-align: center;
}
.lg-c-check input {
  accent-color: var(--wb-primary);
}
.lg-c-date {
  width: 96px;
}
.lg-c-scope {
  width: 64px;
}
.lg-c-amt {
  width: 120px;
}
.lg-c-settle {
  width: 76px;
}
.lg-c-note {
  max-width: 260px;
}
.lg-note {
  display: inline-block;
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
.lg-void-reason {
  font-size: 12.5px;
}
.lg-c-ops {
  width: 104px;
  white-space: nowrap;
}
.lg-shared-note {
  color: var(--wb-warning);
}
/* 「摊 N 家」现在是个展开器（按钮），不是静态标签 —— 去掉按钮默认外观，只留文字 + 小三角 */
.lg-expand {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--wb-warning);
  cursor: pointer;
}
.lg-expand__caret {
  font-size: 10px;
  opacity: 0.75;
}
.lg-expand:hover .lg-expand__caret {
  opacity: 1;
}
/* 展开行不是可点的账目行：不参与行 hover，底色略沉一层表示"这是附属信息" */
.lg-alloc-detail > td {
  padding: 10px 12px 12px;
  background: var(--wb-surface-2);
  white-space: normal;
}
.lg-alloc-detail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12.5px;
  font-weight: 600;
}
.lg-alloc-table {
  width: auto;
  min-width: 360px;
  background: var(--wb-surface);
}
.lg-alloc-table th,
.lg-alloc-table td {
  padding: 4px 10px;
  font-size: 12.5px;
}
.lg-archived {
  margin-left: 4px;
  font-size: 11.5px;
}
.lg-amt--income {
  color: var(--wb-success);
}
.lg-amt--expense {
  color: var(--wb-danger);
}

/* 撤销导入条：贴着筛选区下方，不进吸底条 —— 它是一次性动作，不该和常用批量操作抢位置 */
.lg-undo {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.lg-undo__spacer {
  flex: 1;
}

.lg-batch {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  box-shadow: var(--wb-shadow);
  font-size: 12.5px;
}
.lg-batch__spacer {
  flex: 1;
}.lg-batch__why {
  font-size: 12px;
}

.lg-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
}
.lg-foot__spacer {
  flex: 1;
}
.lg-limit {
  padding: 2px 8px;
}
</style>
