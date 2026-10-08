<template>
  <div class="gd-map">
    <div class="gd-toolbar">
      <!-- 分段控件代替岛时代的胶囊页签：这两块是**互斥视图**而不是"另一个页面"，
           分段控件在视觉上更准确地表达"同一份数据的两面"。 -->
      <div class="wb-seg" role="tablist" aria-label="映射视图">
        <button
          type="button"
          role="tab"
          class="wb-seg__item"
          data-act="sub-queue"
          :class="{ 'is-on': sub === 'queue' }"
          :aria-selected="sub === 'queue'"
          @click="sub = 'queue'"
        >
          待关联队列
          <span v-if="qStats?.unmapped" class="wb-seg__badge">{{ qStats.unmapped }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="wb-seg__item"
          data-act="sub-mapped"
          :class="{ 'is-on': sub === 'mapped' }"
          :aria-selected="sub === 'mapped'"
          @click="sub = 'mapped'"
        >
          已建立映射
          <span v-if="mSummary?.total" class="wb-seg__badge wb-seg__badge--plain">
            {{ mSummary.total }}
          </span>
        </button>
      </div>

      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>

      <div class="gd-toolbar__actions">
        <button class="wb-btn" type="button" data-act="map-refresh" :disabled="busy || loading" @click="manualRefresh">
          刷新
        </button>
      </div>
    </div>

    <!-- 统计条：**0 不占位、全零说一句人话**（W2/全零，2026-10-08 R2）。
         规则全部在 `PoolMetrics.vue` 里写了一遍 —— 工作台右栏 `PoolPane` 用的是同一个组件。 -->
    <PoolMetrics :stats="qStats" :summary="mSummary" :rate-text="rateText" />

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <!-- 行级失败**不能只弹 toast**：用户要照着一行行去改，一闪而过等于没报 -->
    <div v-if="failures.length" class="wb-notice wb-notice--error gd-failures" data-act="map-failures">
      <div>有 <b>{{ failures.length }}</b> 行没能写入：</div>
      <ul>
        <li v-for="(f, i) in failures" :key="i">
          <span class="wb-mono">{{ f.itemId }}</span> —— {{ f.message }}
        </li>
      </ul>
    </div>

    <!-- ── 待关联队列 ─────────────────────────────────────────────── -->
    <template v-if="sub === 'queue'">
      <div v-if="hasQueueHints" class="gd-hints">
        <!-- 与两栏形态的右栏**同一处改动**（2026-10-08 D1）：出口是内建的「店铺登记」页签，
             按钮直接跳过去，不再是一句"请先到「店铺账号管家」…"（那个岛不在默认包里）。 -->
        <p v-if="unresolvedShops.length" class="wb-notice wb-notice--warn gd-hint-shops">
          <span>
            <b>{{ unresolvedShops.length }}</b> 家店铺还没登记，它们的商品<b>无法</b>写映射
            （订单里没有平台，平台只能从店铺实体取）：
            <b>{{ unresolvedShops.join('、') }}</b>。到「店铺登记」把它们认下来，这几行才能关联。
          </span>
          <button
            class="wb-btn wb-btn--sm gd-hint-shops__act"
            type="button"
            data-act="open-registry"
            @click="navigate(GOODS_TAB_REGISTRY)"
          >
            现在登记
          </button>
        </p>
        <p v-if="qStats?.truncated" class="wb-notice wb-notice--warn">
          订单行数超过单次扫描上限（50000 行），本次队列可能不完整。建议先按时间分批导入订单。
        </p>
        <p v-if="(qStats?.withoutItemId ?? 0) > 0" class="wb-notice">
          另有 <b>{{ qStats?.withoutItemId }}</b> 行订单取不到商品ID（列名不匹配或值为空），
          它们<b>不会</b>出现在队列里 —— 这是「丢行」而不是「已完成」。
        </p>
      </div>

      <div class="gd-toolbar gd-toolbar--sub">
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="queue-batch"
          :disabled="busy || !selectedUnmapped.length"
          @click="openBatchPicker"
        >
          {{ batchLabel }}
        </button>
        <button
          class="wb-btn"
          type="button"
          data-act="queue-clear"
          :disabled="busy || !selectedKeys.size"
          @click="clearSelection"
        >
          清空选择
        </button>
        <button
          v-if="queueHasMore"
          class="wb-btn"
          type="button"
          data-act="queue-more"
          :disabled="busy || loading"
          @click="showMore"
        >
          显示更多
        </button>
        <span class="wb-muted gd-toolbar__hint">
          共 {{ queuePendingTotal }} 组待处理，已列出 {{ qStats?.shown ?? 0 }} 组
        </span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table class="wb-table" data-act="queue-table">
            <thead>
              <tr>
                <th class="gd-c-check">
                  <input
                    type="checkbox"
                    :checked="allQueueChecked"
                    :indeterminate.prop="someQueueChecked"
                    :disabled="!selectableQueue.length"
                    aria-label="全选可关联行"
                    @change="toggleQueueAll"
                  />
                </th>
                <th>店铺</th>
                <th>平台</th>
                <th class="gd-c-img">图</th>
                <th>商品ID</th>
                <th>商品标题</th>
                <th class="wb-num">订单行</th>
                <th>状态</th>
                <th class="gd-c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in queueRows"
                :key="queueKey(r)"
                :data-item-id="r.itemId"
                :class="{ 'is-blocked': r.status !== 'unmapped' }"
              >
                <td class="gd-c-check">
                  <input
                    type="checkbox"
                    :checked="selectedKeys.has(queueKey(r))"
                    :disabled="r.status !== 'unmapped'"
                    :aria-label="`选择 ${r.itemId}`"
                    @change="toggleQueueOne(r)"
                  />
                </td>
                <td>
                  <template v-if="r.shopId">{{ r.shopName || `#${r.shopId}` }}</template>
                  <span v-else class="wb-muted" :title="`订单里的店铺原文：${r.shopRaw || '（空）'}`">
                    {{ r.shopRaw || '（无店铺名）' }}
                  </span>
                </td>
                <td>
                  <span v-if="r.platform" class="wb-tag">{{ r.platform }}</span>
                  <span v-else class="wb-muted">—</span>
                </td>
                <!-- 认款只能靠肉眼比图（订单里没有任何字段能推出"这是哪一款"），
                     所以这一列不是装饰：没有它，用户只能对着一个 16 位商品ID 猜。
                     图来自订单（`itemImagePool` 的第 ② 层），不用另准备任何文件。 -->
                <td class="gd-c-img">
                  <button
                    v-if="queueImgs.get(r.itemKey)"
                    class="gd-thumb-btn"
                    type="button"
                    data-act="q-thumb"
                    :data-thumb-key="r.itemKey"
                    :title="`${queueImgs.get(r.itemKey)?.source || '商品图'} · 点击看大图`"
                    @click="openImage(r)"
                  >
                    <img :src="queueImgs.get(r.itemKey)?.dataUrl || ''" class="wb-thumb" alt="" />
                  </button>
                  <span
                    v-else
                    class="wb-thumb wb-thumb--empty"
                    data-act="q-thumb-empty"
                    title="这个商品在订单里没有图"
                  ></span>
                </td>
                <td class="wb-mono">{{ r.itemId }}</td>
                <td :class="{ 'wb-muted': !r.title }">{{ r.title || '—' }}</td>
                <td class="wb-num">{{ r.orderCount }}</td>
                <td>
                  <span v-if="r.status === 'unmapped'" class="wb-tag is-warn">待关联</span>
                  <span v-else class="wb-tag">店铺未归一</span>
                  <span v-if="r.autoShopName" class="gd-note">
                    疑似 {{ r.autoShopName }}<template v-if="r.autoShopPlatform">（{{ r.autoShopPlatform }}）</template>
                  </span>
                </td>
                <td class="gd-c-ops">
                  <template v-if="r.status === 'unmapped'">
                    <button class="wb-link" type="button" data-act="row-relate" :disabled="busy" @click="openRowPicker(r)">
                      关联…
                    </button>
                    <button
                      class="wb-link"
                      type="button"
                      data-act="row-compare"
                      :disabled="busy"
                      title="把这个商品与候选产品并排放大（← / → 换候选，空格 关联）"
                      @click="openCompare(r)"
                    >
                      对比
                    </button>
                  </template>
                  <template v-else>
                    <button
                      class="wb-link"
                      type="button"
                      data-act="row-blocked"
                      disabled
                      title="订单里没有平台字段，平台只能从已登记的店铺取 —— 所以先登记店铺才能写映射"
                    >
                      需先登记店铺
                    </button>
                    <button
                      class="wb-link"
                      type="button"
                      data-act="row-open-registry"
                      :disabled="busy"
                      @click="navigate(GOODS_TAB_REGISTRY)"
                    >
                      去登记
                    </button>
                  </template>
                </td>
              </tr>
              <tr v-if="!queueRows.length && !loading">
                <td colspan="9" class="gd-panel__empty">
                  <div class="wb-empty">
                    <div class="wb-empty__icon" aria-hidden="true">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </div>
                    <p class="wb-empty__title">
                      {{ qStats?.groups ? '这一批待处理项都已关联完' : '还没有要认的商品' }}
                    </p>
                    <!-- 空态是**入口**不是提示：原先这里只有一句"导入订单后…"，但用户真要
                         去导入时得自己找「今天」在哪 —— 而队列本来就是那一页导进来之后才有的。
                         同文件下面「还没有任何映射」的空态早就这么做了（一个可点的下一步），
                         这里补齐同一形态。（`.wb-empty__desc` 里**不要再写 markdown 星号**：
                         它是纯文本节点，`**实时**` 会原样显示成四个星号。） -->
                    <p class="wb-empty__desc">
                      {{
                        queuePendingTotal
                          ? '还有更多组没列出来时，点上面的「显示更多」继续。'
                          : '队列不是缓存表，而是实时从订单里聚出来的：在「今天」页导入订单后，出现过的「店铺 × 商品ID」会在这里等着确认。'
                      }}
                    </p>
                    <div v-if="!qStats?.groups" class="wb-empty__actions">
                      <button
                        class="wb-btn wb-btn--primary"
                        type="button"
                        data-act="go-today"
                        @click="goToday"
                      >
                        去「今天」导入订单
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- ── 已建立映射 ─────────────────────────────────────────────── -->
    <template v-else>
      <div class="gd-toolbar gd-toolbar--sub">
        <input
          v-model="mSearchInput"
          class="wb-input gd-toolbar__search"
          type="search"
          placeholder="搜索商品ID / 平台 / 备注…"
          aria-label="搜索映射"
        />
        <select v-model="mStatus" class="wb-input gd-toolbar__select" aria-label="状态筛选">
          <option value="">全部状态</option>
          <option value="confirmed">已确认</option>
          <option value="pending">待确认</option>
          <option value="invalid">已失效</option>
        </select>
        <select v-model="mShop" class="wb-input gd-toolbar__select" aria-label="店铺筛选">
          <option value="">全部店铺</option>
          <option v-for="s in shopOptions" :key="s.shopId || 'unknown'" :value="String(s.shopId)">
            {{ s.shopName || `#${s.shopId}（店铺已删）` }}（{{ s.count }}）
          </option>
        </select>
        <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table class="wb-table" data-act="mapped-table">
            <thead>
              <tr>
                <th>店铺</th>
                <th>平台</th>
                <th class="gd-c-img">图</th>
                <th>商品ID</th>
                <th>关联产品</th>
                <th>状态</th>
                <th>来源</th>
                <th>更新时间</th>
                <th class="gd-c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in mappedRows" :key="r.id" :data-item-id="r.itemId" :data-map-id="r.id">
                <td :class="{ 'wb-muted': !r.shopName }">
                  {{ r.shopName || `#${r.shopId}（店铺已删）` }}
                </td>
                <td>
                  <span v-if="r.platform" class="wb-tag">{{ r.platform }}</span>
                  <span v-else class="wb-muted">—</span>
                </td>
                <td class="gd-c-img">
                  <img
                    v-if="itemThumbs.get(r.itemId)"
                    :src="itemThumbs.get(r.itemId)"
                    class="wb-thumb"
                    :title="itemThumbSource.get(r.itemId) || ''"
                    alt=""
                  />
                  <span v-else class="wb-thumb wb-thumb--empty" title="暂无图片"></span>
                  <span class="gd-imgops">
                    <button
                      class="wb-link"
                      type="button"
                      data-act="thumb-set"
                      :disabled="imgBusy"
                      :title="itemOverrides.has(r.itemId) ? '换一张手动覆盖图' : '为该商品ID指定一张图（优先于自动识别）'"
                      @click="pickItemThumb(r.itemId)"
                    >
                      {{ itemOverrides.has(r.itemId) ? '换图' : '设图' }}
                    </button>
                    <button
                      v-if="itemOverrides.has(r.itemId)"
                      class="wb-link"
                      type="button"
                      data-act="thumb-clear"
                      :disabled="imgBusy"
                      @click="clearItemThumb(r.itemId)"
                    >
                      清除
                    </button>
                  </span>
                </td>
                <td class="wb-mono">{{ r.itemId }}</td>
                <td>
                  <span class="wb-mono">{{ r.productCode || '—' }}</span>
                  <span v-if="r.productName" class="gd-note">{{ r.productName }}</span>
                  <span v-if="!r.productCode" class="gd-note">产品已不存在</span>
                </td>
                <td>
                  <span class="wb-tag" :class="STATUS_CLASS[r.status] || ''">
                    {{ STATUS_LABEL[r.status] || r.status }}
                  </span>
                </td>
                <td class="wb-muted">{{ SOURCE_LABEL[r.source] || r.source }}</td>
                <td class="wb-muted gd-nowrap">{{ r.updatedAt }}</td>
                <td class="gd-c-ops">
                  <button class="wb-link" type="button" data-act="row-rebind" :disabled="busy" @click="openRebindPicker(r)">
                    改绑
                  </button>
                  <button
                    v-if="r.status === 'invalid'"
                    class="wb-link"
                    type="button"
                    data-act="row-restore"
                    :disabled="busy"
                    @click="restore(r)"
                  >
                    恢复
                  </button>
                  <button
                    v-else
                    class="wb-link wb-link--danger"
                    type="button"
                    data-act="row-invalidate"
                    :disabled="busy"
                    @click="pendingInvalidate = r"
                  >
                    标失效
                  </button>
                </td>
              </tr>
              <tr v-if="!mappedRows.length && !loading">
                <td colspan="9" class="gd-panel__empty">
                  <div class="wb-empty">
                    <div class="wb-empty__icon" aria-hidden="true">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                        <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
                        <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
                      </svg>
                    </div>
                    <p class="wb-empty__title">
                      {{ mappedFiltered ? '没有符合筛选条件的映射' : '还没有任何映射' }}
                    </p>
                    <p class="wb-empty__desc">
                      {{
                        mappedFiltered
                          ? '换个关键字，或把上面的筛选条件清掉再试。'
                          : '到「待关联队列」确认第一批 —— 建立映射后，订单里的商品ID 才能自动落到款上。'
                      }}
                    </p>
                    <div v-if="!mappedFiltered" class="wb-empty__actions">
                      <button class="wb-btn" type="button" @click="sub = 'queue'">去待关联队列</button>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="mappedPages > 1" class="wb-panel__foot wb-pager">
          <span>共 {{ mappedTotal }} 条，第 {{ mPage }} / {{ mappedPages }} 页</span>
          <span class="wb-pager__spacer"></span>
          <button class="wb-btn wb-btn--sm" type="button" :disabled="mPage <= 1 || loading" @click="gotoMapped(mPage - 1)">
            上一页
          </button>
          <button
            class="wb-btn wb-btn--sm"
            type="button"
            :disabled="mPage >= mappedPages || loading"
            @click="gotoMapped(mPage + 1)"
          >
            下一页
          </button>
        </div>
      </section>
    </template>

    <!-- 产品选择器（批量关联 / 改绑共用）；写在两个确认弹层之前，
         但同层级下它总在最后一次打开时后挂载 —— 需要它压在最上面时由调用顺序保证。 -->
    <ProductPicker
      v-if="picker"
      :title="pickerTitle"
      :confirm-text="pickerConfirm"
      :initial-color="pickerInitialColor"
      @close="picker = null"
      @pick="applyPick"
    />

    <!-- 对比认款：左 = 候选产品（独立取图），右 = 这个商品的订单图。
         整宽形态没有左栏「当前款」，初始候选交给弹层自己取第一行（不传 initial-product-id）。 -->
    <CompareModal
      v-if="compare"
      :item="compare.row"
      :item-image="compareItemImage"
      @close="compare = null"
      @confirm="confirmCompare"
    />

    <!-- 标失效确认 -->
    <ConfirmDialog
      v-if="pendingInvalidate"
      title="标记为已失效"
      confirm-text="确认标失效"
      busy-text="处理中…"
      :busy="busy"
      @close="pendingInvalidate = null"
      @confirm="confirmInvalidate"
    >
      <p>
        将把 <b class="wb-mono">{{ pendingInvalidate.itemId }}</b>
        （{{ pendingInvalidate.shopName || `#${pendingInvalidate.shopId}` }}）标为「已失效」。
      </p>
      <p class="wb-notice wb-notice--warn">
        失效后这条映射不再参与自动命中，但记录会保留。商品ID 变了（例如 Amazon 合并 listing）时用这个
        操作 —— 直接删掉会让关联率莫名回落且查不出原因。
      </p>
    </ConfirmDialog>

    <!-- 看图（队列 / 已配映射共用）：缩略图只有 160px 边，认款要看清印花、领型、颜色，
         "能点开看原图"才是这一列真正有用的前提。点遮罩或「关闭」退出。 -->
    <div v-if="viewer" class="wb-mask" data-act="img-viewer" @click.self="viewer = null">
      <div class="wb-dialog gd-viewer" role="dialog" aria-modal="true" aria-label="查看商品图">
        <div class="wb-dialog__head">
          <span class="wb-mono">{{ viewer.itemId }}</span>
          <span v-if="viewer.source" class="wb-muted gd-viewer__src">{{ viewer.source }}</span>
        </div>
        <div class="wb-dialog__body gd-viewer__body">
          <img v-if="viewer.src" :src="viewer.src" class="gd-viewer__img" alt="" />
          <p v-else class="wb-muted">这张图读不出来 —— 文件可能已被移动或删除。</p>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" data-act="viewer-close" @click="viewer = null">
            关闭
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「映射与关联」页签：店铺商品ID → 产品 的**待关联队列**与**已建立映射**维护。
//
// 逻辑见 `../useSkuPool`（与本页两栏工作台右栏 `PoolPane.vue` **共用同一份**）——
// 本文件是 `GOODS_LAYOUT='tabs'` 的**回退渲染形态**：模板与样式自 2026-10 重构起一字未动，
// 脚本换成调用该 composable（回退时"逻辑"不再独立，但 DOM 逐字是旧的）。
//
// 三条口径由主进程裁定，界面只呈现、不自己算（迁移时一条都没动，详见 useSkuPool 顶部注释）：
//   1. 队列是**实时聚合** `oi_orders` 的商品ID 再减去已生效映射，不是缓存表 ——
//      所以每次写入完成后都要重新拉队列，「关联完就从队列里消失」才是真实状态。
//   2. `店铺未归一` 的行**不给**关联按钮：订单里没有平台字段，平台只能从店铺实体取，
//      拿空平台硬塞会把不同平台的两家店并到同一个键上。这类行只能先去店铺登记。
//   3. 批量关联**一次提交整批**（主进程单事务 + 行级失败逐行回来），不做逐条调用 ——
//      首次导入 500 行未命中是常态，逐条会把 IPC 往返变成瓶颈。
//
// 迁移时的界面改动（2026-10-01，仅界面层）：
//   · 顶部统计从「好几句 inline 文字」收成一条 `.wb-metabar`（标签 + 数字），扫描更快；
//   · 子视图切换从胶囊页签换成**分段控件**（它们是同一份数据的两面，不是两个页面）；
//   · 提示语从一行小灰字升级成 `.wb-notice`（「订单丢行」「店铺未归一」都是会让数字
//     看起来"完成了"的假象，必须显眼）；每类提示**只在真的命中时**才占位。
import {
  useSkuPool,
  SKU_STATUS_LABEL as STATUS_LABEL,
  SKU_STATUS_CLASS as STATUS_CLASS,
  SKU_SOURCE_LABEL as SOURCE_LABEL,
} from '../useSkuPool';
import ProductPicker from './ProductPicker.vue';
import PoolMetrics from './PoolMetrics.vue';
import CompareModal from './CompareModal.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { GOODS_TAB_REGISTRY, type GoodsTabId } from '../tabs';

const props = defineProps<{
  /** 页级「刷新」信号（值变化即重拉） */
  refreshNonce?: number;
  /**
   * 请求切到本页另一个页签 —— 「店铺登记」那一支。见 `PoolPane.vue` 里同一条 prop 的说明：
   * 回退形态与两栏形态必须走**同一个**出口，否则"改一个常量回退"会退到一个死胡同里去。
   */
  navigate: (tab: GoodsTabId) => void;
}>();

// ⚠️ 2026-10-08：原先这里还 emit `changed`（把「待关联数」报给外壳的页签徽标）。
//    指标条与徽标一起撤掉后它已**零消费者**，于是整条删掉（不留"转发了没人听"的空管道）。
const {
  sub,
  loading,
  busy,
  error,
  failures,
  queueRows,
  qStats,
  selectedKeys,
  mappedRows,
  mappedTotal,
  mPage,
  mSummary,
  mSearchInput,
  mStatus,
  mShop,
  picker,
  pendingInvalidate,
  compare,
  viewer,
  queueImgs,
  itemThumbs,
  itemOverrides,
  itemThumbSource,
  imgBusy,
  compareItemImage,
  unresolvedShops,
  shopOptions,
  hasQueueHints,
  selectableQueue,
  allQueueChecked,
  someQueueChecked,
  selectedUnmapped,
  mappedPages,
  mappedFiltered,
  rateText,
  queuePendingTotal,
  queueHasMore,
  pickerTitle,
  pickerConfirm,
  pickerInitialColor,
  batchLabel,
  queueKey,
  openImage,
  pickItemThumb,
  clearItemThumb,
  manualRefresh,
  goToday,
  gotoMapped,
  showMore,
  toggleQueueAll,
  toggleQueueOne,
  clearSelection,
  openBatchPicker,
  openRowPicker,
  openRebindPicker,
  openCompare,
  confirmCompare,
  applyPick,
  confirmInvalidate,
  restore,
} = useSkuPool({ refresh: () => props.refreshNonce ?? 0 });
</script>

<style scoped>
.gd-map {
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
.gd-toolbar--sub {
  gap: 8px;
}
.gd-toolbar__search {
  width: 260px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 140px;
}
.gd-toolbar__hint {
  font-size: 12px;
}
.gd-toolbar__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

/* 分段控件样式已提到全局 `src/styles/index.css` 的 `@layer components`（.wb-seg*）——
   算钱页也要用同一套，按"控件样式只有一个来源"不再各写一份。 */

.gd-hints {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.gd-hints :deep(p) {
  margin: 0;
}
/* 与两栏形态右栏同一条（PoolPane.vue）：出口按钮必须与文字同处一行 */
.gd-hint-shops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.gd-hint-shops__act {
  flex-shrink: 0;
}

.gd-panel {
  flex: 1;
  min-height: 180px;
}
.gd-panel__empty {
  padding: 0;
}
.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 56px;
}
/* 队列的缩略图包一层按钮（点开看原图）—— 剥掉按钮默认外观，只留"可点开"的光标 */
.gd-thumb-btn {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  line-height: 0;
  cursor: zoom-in;
}
.gd-c-ops {
  /* 「关联…」+「对比」两个行内动作 —— 原 128px 只放得下一个 */
  width: 150px;
  white-space: nowrap;
}
.gd-nowrap {
  white-space: nowrap;
}
.gd-note {
  margin-left: 6px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.gd-failures ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
tr.is-blocked :deep(td) {
  background: var(--wb-surface-2);
}
/* 商品ID图下的小操作（设图 / 换图 / 清除） */
.gd-imgops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}
.gd-imgops .wb-link {
  font-size: 11px;
  padding: 0 2px;
}

/* ---- 看图弹层（队列 / 映射列表共用）---- */
.gd-viewer {
  max-width: min(78vw, 900px);
}
.gd-viewer__src {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}
.gd-viewer__body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  max-height: 72vh;
  overflow: auto;
}
.gd-viewer__img {
  max-width: 100%;
  max-height: 72vh;
  object-fit: contain;
  border-radius: 4px;
}
</style>
