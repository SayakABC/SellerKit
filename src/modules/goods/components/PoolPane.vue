<template>
  <!-- 两栏工作台**右栏**：店铺商品池（待认 / 已认）。
       与整宽形态（`SkuMappingView.vue`，`GOODS_LAYOUT='tabs'` 的回退路径）**共用同一份逻辑**
       （`../useSkuPool`），差别只在渲染：这里列更少，把"能折的都折了"。

       列的取舍（见 `docs/plans/GOODS_WORKBENCH_PLAN.md` §7-2）：
         · 待认 6~7 → 4：**平台 / 来源 / 店铺 / 卖出笔数或 SKU 条数全部折进「商品ID」格的副行**；
           **"能不能认"折进行态**（不能认的行整行浅底 + 「操作」列禁用并说明原因）——
           原来那些列里的话本来就是"能不能点"的注释；
         · 已认 9 → 6：**平台折进「店铺」格**；**来源 / 更新时间移进行 `title`**（它们只在
           "这条为什么变了"时才要，不该常驻占宽）。

       ⚠️ 取图、看图弹层与 `mapped` 段的所有 `data-act` 名与整宽形态**逐字一致**（见方案 §8-1 的
       "选择器稳定契约"）。`pending` 段是本栏独有的合并视图，它的锚点（`pending-*`）只在两栏形态存在。 -->
  <div class="gd-pool">
    <div class="gd-toolbar">
      <!-- 分段控件代替岛时代的胶囊页签：这两块是**互斥视图**而不是"另一个页面"，
           分段控件在视觉上更准确地表达"同一份数据的两面"。

           ⭐ 2026-10-25（P2）：三段并两段。原来按**来源**分（队列 / 采集），用户要先判断
           "这条从哪来"才能开工；现在按**状态**分（待认 / 已认），来源降为行内标签 + 筛选。 -->
      <div class="wb-seg" role="tablist" aria-label="商品视图">
        <button
          type="button"
          role="tab"
          class="wb-seg__item"
          data-act="sub-pending"
          :class="{ 'is-on': sub === 'pending' }"
          :aria-selected="sub === 'pending'"
          @click="sub = 'pending'"
        >
          待认
          <!-- 徽标报**权威待办数**（两源统计之和），不是"当前加载了几行"：
               队列分页时行数会少报，且只刷汇总的动静它也不跟着变。 -->
          <span v-if="pendingTotal" class="wb-seg__badge">{{ pendingTotal }}</span>
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
          已认
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

    <!-- 统计条已搬到「已认」段（P2 · S5）：那一排回答的是"干得怎么样"（关联率 / 映射记录），
         而「待认」段要回答的"还差多少"由**分段徽标**报（2026-10-25 用户口径：
         状态句与徽标/来源下拉重复报同一个数，撤句留徽标）。
         规则（含"`null` 不是空"、关联率 `—` 不渲染）仍全部在 `PoolMetrics.vue` 里写了一遍；
         整宽回落形态 `SkuMappingView` 用的是同一个组件，所以不存在"只改了一处"。 -->

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

    <!-- ── 待认：订单队列 + 采集快照合并成一张清单 ─────────────────────────
         合并的理由（`docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md` §3）：这两段原先按**来源**分，
         用户得先判断"我要找的那条来自哪"才能开工；而它们都是"卖出去 / 采回来、但还没认到款上"
         的同一件事。现在按**状态**分段（待认 / 已认），来源降为行内标签 + 一个筛选。
         判据：用户关心的是"还差多少"，不是"这些从哪来"。 -->
    <template v-if="sub === 'pending'">
      <!-- ⭐ 2026-10-25（用户口径）：S5 那句「还剩 N 个没认」撤掉了 —— 它与分段徽标
           （「待认 5」）和来源下拉里的「全部（5）」报的是**同一个数**，一屏三处报同一个数
           正是"文案重复"。剩余数的唯一承载回归**徽标**（顶部一眼可见，切到已认段也还在）。 -->

      <!-- 提示条：两个来源各缺什么，都在这说清，且每条都带出口（D1 的教训：只说不可点的话 = 死胡同）。
           ⭐ 2026-10-25（用户口径）：压缩成单行轻提示 —— 原先一整块橙色告警把队列顶到半屏以下。
           长解释（为什么必须先登记）收进 title 悬停里；店名仍是重点（要照着去登记的就是它们）。 -->
      <div v-if="hasQueueHints || unresolvedItemStores.length" class="gd-hints">
        <!-- 「未登记店铺」**只留一条**（2026-11-03 界面方案 §5.1）：
             订单侧与采集侧根因同一个（店铺没登记）、出口同一个（店名归一），原先并排两条
             几乎一样的橙条，只差"卖出去的 / 采回来的"—— 同屏两处警告把警告色变成背景噪音。
             现在一条报**并集数量** + **两侧各自的后果**：后果按"哪一侧真的有"分别说，
             没有那一侧就不说（别替用户编一句他没遇到的事）。
             ⚠️ 出口仍只有一个（`open-registry`），不再有第二个同名按钮：一个目标一个按钮。
             ⚠️ 店名串 must `nowrap` + 省略号，整条保持单行（≤34px 有断言守着）。 -->
        <p v-if="unresolvedShopsAll.length" class="wb-notice wb-notice--warn gd-hint-shops" data-act="hint-shops">
          <span :title="unresolvedHintTitle">
            <b>{{ unresolvedShopsAll.length }}</b> 家店还没登记<template
              v-if="unresolvedHasOrder && unresolvedHasItems"
              >，卖出去的先挂不上款、采回来的先认不了</template
            ><template v-else-if="unresolvedHasOrder">，卖出去的先挂不上款</template
            ><template v-else>，采回来的先认不了</template>：
            <b>{{ unresolvedShopsAll.join('、') }}</b>
          </span>
          <button
            class="wb-btn wb-btn--sm gd-hint-shops__act"
            type="button"
            data-act="open-registry"
            @click="goRegistry()"
          >
            去「店名归一」
          </button>
        </p>
        <p v-if="qStats?.truncated" class="wb-notice wb-notice--warn">
          订单行数超过单次扫描上限（50000 行），本次队列可能不完整。建议先按时间分批导入订单。
        </p>
        <p v-if="(qStats?.withoutItemId ?? 0) > 0" class="wb-notice">
          另有 <b>{{ qStats?.withoutItemId }}</b> 行订单取不到商品ID，不会进待认清单（丢行 ≠ 已完成）
        </p>
      </div>

      <!-- 采集接收端状态：⭐ 2026-10-25（用户口径）压成一行小字 —— 端口号与"怎么采集"
           是低频信息，收进 title 悬停；常驻的只有"采了多少 / 认了多少 / 最近一次"。
           全零**不占位**（没采过就说"没采过"，不显示"0 个商品"）。 -->
      <p
        v-if="itemStats.total > 0"
        class="gd-items__status"
        data-act="items-status"
        :title="receiverStatus?.running
          ? `采集接收端在线，端口 ${receiverStatus.port}。在卖家后台的店铺商品页点扩展的「采集本页」或「采集本店全部」，商品会出现在这里。`
          : '接收端未运行。启动后：在卖家后台的店铺商品页点扩展的「采集本页」或「采集本店全部」，商品会出现在这里。'"
      >
        <span class="gd-items__dot" :class="{ 'is-on': !!receiverStatus?.running }" aria-hidden="true"></span>
        <template v-if="receiverStatus?.running">
          已采 <b>{{ itemStats.total }}</b> · 认了 {{ itemStats.confirmed }} ·
          最近 {{ itemStats.lastScrapedAt ? fmtEpoch(itemStats.lastScrapedAt) : '—' }}
        </template>
        <template v-else>接收端未运行 —— 启动后在卖家后台点扩展的「采集本页」即可采集</template>
      </p>

      <!-- 接入引导（零采集的另一面）：没采过就不给表格，给一条走得通的路 -->
      <div v-if="itemStats.total === 0 && itemSummary" class="gd-panel__empty">
        <div class="wb-empty">
          <div class="wb-empty__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <p class="wb-empty__title">还没有采集过店铺商品</p>
          <p class="wb-empty__desc">
            采集是认款的另一个来源：订单里还没出现过的商品，可以先把整店采回来再认。
            装上 Chrome 扩展（SellerKitExtensions）后，在卖家后台的店铺商品页点「采集本页」或「采集本店全部」。
            采集按「店铺地址」归到已登记的店（「店名归一」里填）。
            <b>扩展装不上或选择器采不到时，走「手贴商品ID」</b> —— 把商品ID从后台复制进来，与采集同一条落库路径。
          </p>
          <div class="wb-empty__actions">
            <button
              class="wb-btn wb-btn--primary"
              type="button"
              data-act="items-copy-info"
              @click="copyItemsInfo"
            >
              复制接入信息
            </button>
            <!-- 保底通道（零数据版）：「一条都没采到」正是"扩展采不到"的时刻 —— 工具条那边
                 被 total>0 挡着，退路入口若只放那里，最需要它的时候恰恰点不到。 -->
            <button
              class="wb-btn"
              type="button"
              data-act="items-manual-import-empty"
              :disabled="busy"
              @click="openManualImport"
            >
              手贴商品ID
            </button>
            <button class="wb-btn" type="button" @click="goRegistry()">去「店名归一」</button>
          </div>
        </div>
      </div>

      <!-- ⚠️ 判据必须包含"已经问过数据、只是它是空的"（`qStats !== null` / `itemSummary !== null`）——
           若只写 `pendingRows.length`，两源全空时整块（含空态）都不渲染，
           于是"空态里那个去导入订单的入口"永远出不来，断言也就永远等不到它。 -->
      <template v-if="pendingRows.length || qStats !== null || itemSummary !== null">
        <div class="gd-toolbar gd-toolbar--sub">
          <!-- 来源筛选：**筛选项**而不是第二个分段 —— 来源是每条待办的一个属性，
               "还有多少没认"才是这一屏要回答的问题（见 useSkuPool 里 pendingOrigin 的注释）。
               两个数不受筛选自身影响，否则选中"订单"后"采集 3"就消失了。 -->
          <label class="gd-origin">
            <span class="wb-muted">来源</span>
            <select
              class="wb-input gd-origin__sel"
              :value="pendingOrigin"
              data-act="pending-origin"
              aria-label="按来源筛选待认商品"
              @change="setPendingOrigin"
            >
              <option value="">全部（{{ pendingTotal }}）</option>
              <option value="order">订单（{{ pendingOriginCount.order }}）</option>
              <option value="scrape">采集（{{ pendingOriginCount.scrape }}）</option>
            </select>
          </label>
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
          <!-- 保底通道：扩展选择器全落空时，用户从后台复制商品ID贴进来 -->
          <button
            class="wb-btn wb-btn--ghost"
            type="button"
            data-act="items-manual-import"
            :disabled="busy"
            @click="openManualImport"
          >
            手贴商品ID
          </button>
          <!-- 打开店铺：已登记店 → 浏览器打开它的主页（优先 Chrome —— 采集扩展装在那）。
               无地址的店在这里给「去补地址」，不留一个点了没反应的入口。 -->
          <div ref="shopOpenRoot" class="gd-shopopen">
            <button
              class="wb-btn wb-btn--ghost"
              type="button"
              data-act="items-open-shop"
              :disabled="busy"
              @click.stop="toggleShopOpen"
            >
              打开店铺 ▾
            </button>
            <div v-if="shopOpen" class="gd-shopopen__panel" data-act="items-open-shop-panel">
              <p class="gd-shopopen__title">打开一家店去采集它的商品：</p>
              <p
                v-if="openShopError"
                class="wb-notice wb-notice--error gd-shopopen__msg"
                data-act="open-shop-error"
              >
                {{ openShopError }}
              </p>
              <div v-else-if="!openShopRows.length" class="gd-shopopen__msg" data-act="open-shop-empty">
                <p class="wb-muted">还没有登记任何店铺 —— 先建一家，把店铺地址填上。</p>
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="open-shop-go-registry"
                  @click.stop="goFixShop"
                >
                  去「店名归一」
                </button>
              </div>
              <div v-else class="gd-shopopen__list">
                <div
                  v-for="r in openShopRows"
                  :key="r.shop.id"
                  class="gd-shopopen__row"
                  :data-shop-id="r.shop.id"
                >
                  <button
                    v-if="r.shop.shopUrl"
                    class="gd-shopopen__item"
                    type="button"
                    :disabled="busy"
                    @click.stop="openShopFromMenu(r.shop)"
                  >
                    <span class="gd-shopopen__name">
                      {{ r.shop.platform ? `[${r.shop.platform}] ` : '' }}{{ r.shop.name }}
                    </span>
                    <span class="gd-shopopen__stat">{{ shopStatText(r.stat) }}</span>
                  </button>
                  <div v-else class="gd-shopopen__item is-nourl" data-act="open-shop-no-url">
                    <span class="gd-shopopen__name">{{ r.shop.name }}</span>
                    <span class="gd-shopopen__stat">没填店铺地址</span>
                    <button
                      class="wb-link"
                      type="button"
                      data-act="open-shop-fix"
                      @click.stop="goFixShop"
                    >
                      去补地址
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- 计数报的是**当前筛选下**的待认项数，与表格行数恒等 -->
          <span class="wb-muted gd-toolbar__hint" data-act="pending-count">
            待认 {{ pendingVisible.length }} 项<template v-if="pendingTotal !== pendingVisible.length">（共 {{ pendingTotal }} 项）</template>
          </span>
        </div>

        <section class="wb-panel gd-panel">
          <div class="wb-panel__body">
            <table
              ref="pendingTableEl"
              class="wb-table gd-pending"
              data-act="pending-table"
              tabindex="0"
              aria-label="待认商品：上下键移动当前行，空格勾选，回车对比"
              @keydown="onKeydown"
            >
              <thead>
                <tr>
                  <th class="gd-c-check">
                    <input
                      type="checkbox"
                      :checked="pendingAllChecked"
                      :indeterminate.prop="pendingSomeChecked"
                      :disabled="!pendingSelectable.length"
                      aria-label="全选可认商品"
                      @change="togglePendingAll"
                    />
                  </th>
                  <th class="gd-c-img">图</th>
                  <!-- 商品ID 格承载四件事（ID / 来源 / 店铺 / 平台 / 补充），
                       与队列那次的压缩同一手法：列从 6~7 降到 4，一个字段都没丢。
                       图是认款的主要依据，所以它单独占一列且给常显图注。 -->
                  <th class="gd-c-item">商品ID / 店铺</th>
                  <th class="gd-c-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in pendingVisible"
                  :key="r.key"
                  :data-item-id="r.itemId"
                  :data-origin="r.origin"
                  :data-row-key="r.key"
                  :class="{ 'is-blocked': !r.canRelate, 'is-on': r.key === pendingCurrentKey }"
                  @click="markPendingRow(r.key, $event)"
                >
                  <td class="gd-c-check">
                    <input
                      type="checkbox"
                      :checked="pendingSelected.has(r.key)"
                      :disabled="!r.canRelate"
                      :aria-label="`选择 ${r.itemId}`"
                      @change="togglePendingOne(r)"
                    />
                  </td>
                  <td class="gd-c-img">
                    <!-- 订单行的图来自图池（可点开大图）；采集行的图是远程 CDN 地址（直显，不可点） -->
                    <button
                      v-if="r.origin === 'order' && r.thumb"
                      class="gd-thumb-btn"
                      type="button"
                      data-act="q-thumb"
                      :data-thumb-key="r.thumbKey"
                      :title="`${r.thumbSource || '商品图'} · 点击看大图`"
                      @click="openPendingImage(r)"
                    >
                      <img :src="r.thumb" class="wb-thumb" alt="" />
                      <span class="gd-thumb-btn__zoom" aria-hidden="true">⤢</span>
                    </button>
                    <img
                      v-else-if="r.thumb"
                      :src="r.thumb"
                      class="wb-thumb"
                      alt=""
                      referrerpolicy="no-referrer"
                    />
                    <span v-else class="wb-thumb wb-thumb--empty" data-act="q-thumb-empty"></span>
                    <!-- 常显图注：没有图时这行就是唯一说明（"图是认款的主要依据" ⇒ "这个商品没图"要一眼看见） -->
                    <span class="gd-imgcap" data-act="q-thumb-src">
                      {{ r.thumb ? (r.origin === 'order' ? srcShort(r.thumbSource) : (r.shopLabel || '未登记')) : '没有图' }}
                    </span>
                  </td>
                  <td class="gd-c-item">
                    <span class="wb-mono gd-item__id" :title="r.itemId" data-act="pending-item-id">{{ r.itemId }}</span>
                    <span class="gd-item__sub">
                      <span class="wb-tag gd-origin__tag" data-act="pending-origin-tag">{{ r.originLabel }}</span>
                      <template v-if="r.shopId">{{ r.shopLabel || `#${r.shopId}` }}</template>
                      <span v-else class="wb-muted">{{ r.shopLabel || '（无店铺名）' }}</span>
                      <span v-if="r.platform" class="wb-tag gd-shop__plat">{{ r.platform }}</span>
                      <span
                        v-if="r.extra"
                        class="wb-muted"
                        :data-act="r.origin === 'scrape' ? 'pending-sku-count' : 'pending-extra'"
                        :title="r.skuText ? `SKU ${r.skuCount} 条：${r.skuText}` : undefined"
                      >· {{ r.extra }}</span>
                      <!-- 自动建议只作提示（同名唯一精确命中给出的），永不自动落库 ——
                           它得在行里看得见，用户才知道"这行可能是哪家店的" -->
                      <span v-if="r.autoShopHint" class="gd-note" data-act="pending-auto-shop">{{ r.autoShopHint }}</span>
                      <!-- 采集行的 SKU 只报**条数**（2026-10-28 用户口径"SKU 不要全部列出来"）：
                           副行可用宽度只有 ~300px，十几色矩阵摊开会把店铺/平台挤掉、把行高撑成
                           两行 —— 看着就是"展示不全"。色码全文折进上面那格的 title，悬停/长按仍可
                           核对（认款要看色码，所以信息本身不丢）。 -->
                      <span
                        v-if="r.origin === 'scrape' && !r.skuText"
                        class="wb-muted gd-pending__sku"
                        data-act="pending-sku-empty"
                        title="这个采集快照没带 SKU 矩阵（列表轻采），要看色码得重新采集详情页"
                      >· 未采集</span>
                    </span>
                  </td>
                  <!-- 行内只留「看这一行」的动作：对比（凑近看）与删除（删采集快照）。
                       认款**不在这里** —— 它只有一条路径（勾选 → 底部动作条），
                       原先四个近义入口正是这页"不知道点哪个"的主因。 -->
                  <td class="gd-c-ops">
                    <button
                      v-if="r.canRelate && r.origin === 'order'"
                      class="wb-link"
                      type="button"
                      data-act="row-compare"
                      :disabled="busy"
                      title="把这个商品与候选产品并排放大（← / → 换候选，空格 关联）"
                      @click="openPendingCompare(r)"
                    >
                      对比
                    </button>
                    <!-- 删除采集快照与"能不能认款"**无关**：认不上的行（店铺没登记、
                         采错了）恰恰是最该清掉的那批。绑在 canRelate 上会让这些行
                         只剩「去登记」一条路 —— 垃圾数据就永远删不掉。 -->
                    <button
                      v-if="r.origin === 'scrape'"
                      class="wb-link wb-link--danger"
                      type="button"
                      data-act="i-row-delete"
                      :disabled="busy"
                      @click="requestDeletePending(r)"
                    >
                      删除
                    </button>
                    <template v-if="!r.canRelate">
                      <!-- 灰因不能只躺在 title 里：触屏 / 不会悬停的人永远看不到，
                           所以紧跟着给可点的出口「去登记」 -->
                      <button
                        class="wb-link"
                        type="button"
                        data-act="row-blocked"
                        disabled
                        :title="r.origin === 'order'
                          ? '订单里没有平台字段，平台只能从已登记的店铺取 —— 所以先登记店铺才能写映射'
                          : '采集时没对上已登记的店铺 —— 先到「店名归一」把它认下来'"
                      >
                        {{ r.blockedReason }}
                      </button>
                      <button
                        class="wb-link"
                        type="button"
                        data-act="row-open-registry"
                        :disabled="busy"
                        @click="goRegistry()"
                      >
                        去登记
                      </button>
                    </template>
                  </td>
                </tr>
                <tr v-if="!pendingVisible.length && !loading">
                  <td colspan="4" class="gd-panel__empty">
                    <div class="wb-empty wb-empty--sm">
                      <div class="wb-empty__icon" aria-hidden="true">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </div>
                      <p class="wb-empty__title">
                        {{ pendingRows.length
                          ? '这个来源下没有待认的商品'
                          : (qStats?.groups || itemStats.total ? '待认的都认完了' : '还没有要认的商品') }}
                      </p>
                      <p class="wb-empty__desc">
                        {{ pendingRows.length
                          ? '换一个来源筛选，或选「全部」看所有待认项。'
                          : (qStats?.groups || itemStats.total
                            ? '认好的在上面「已认」段里，可按款筛出来看。'
                            : '订单里的商品来自「发货台」导入；采集来的商品来自浏览器扩展或「手贴商品ID」。两个来源都会出现在这张清单里。') }}
                      </p>
                      <div v-if="!pendingRows.length" class="wb-empty__actions">
                        <button
                          class="wb-btn wb-btn--primary"
                          type="button"
                          data-act="go-today"
                          @click="goToday"
                        >
                          去「发货台」导入订单
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 动作条（吸底）：**全页唯一**的认款入口。
             ⚠️ 有行就常驻、没勾选时禁用 —— 不能"勾了才出现"：那样用户在勾之前
             根本不知道这一步存在（认款入口收敛成一个之后，它必须一眼看得见）。
             没选款时按钮是「先选一个款」——同一个选择器、同一条提交路径，不另开一条动线。
             只勾了一个采集行时多给「新建款并关联」：那是"还没有这个款"时的出口，
             与"有款、认过去"不是同一件事（所以它不属于"第二个认款入口"）。
             ⭐ 2026-11-03（界面方案 §5.1 第 8 项）：**只补作用域，没有改成"勾了才出现"**。
                方案原话是"常驻 → 有勾选才出现"，但那条与上面 2026-10-25 的裁定直接冲突：
                隐藏只会在用户勾选前把唯一入口藏起来。所以做的是另一半个真问题 ——
                「已选 2 项」不说清**是哪几个**（吸底栏，滚远了根本不知道自己勾了什么），
                现在补商品ID；「认到 S2」里的 S2 是什么，挂在按钮 title 上（低频、占宽大）。 -->
        <div v-if="pendingVisible.length" class="gd-actbar" data-act="pending-actbar">
          <span class="gd-actbar__count" data-act="pending-selcount" :title="pendingScopeTitle">
            <template v-if="pendingSelectionCount"
              >已选 <b>{{ pendingSelectionCount }}</b> 项<template v-if="pendingScopeText"
                ><span class="gd-actbar__scope" data-act="pending-scope">：{{ pendingScopeText }}</span></template
              ></template
            >
            <template v-else>勾选商品后可认款</template>
          </span>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="pending-relate"
            :disabled="busy || !pendingSelectionCount"
            :title="currentProduct ? `${currentProduct.code} ${currentProduct.name}` : ''"
            @click="currentProduct ? relatePending() : openPendingPicker()"
          >
            {{ currentProduct
              ? `认到 ${currentProduct.code}${pendingSelectionCount ? `（${pendingSelectionCount} 项）` : ''}`
              : '先选一个款' }}
          </button>
          <button
            v-if="currentProduct"
            class="wb-btn wb-btn--ghost"
            type="button"
            data-act="pending-pick"
            :disabled="busy"
            @click="openPendingPicker"
          >
            换一款…
          </button>
          <button
            v-if="pendingWizardItem"
            class="wb-btn wb-btn--ghost"
            type="button"
            data-act="items-new-product"
            :disabled="busy"
            @click="openPendingWizard"
          >
            新建款并关联（{{ pendingWizardItem.itemId }}）
          </button>
          <button
            class="wb-btn wb-btn--ghost"
            type="button"
            data-act="pending-clear"
            :disabled="busy"
            @click="clearPendingSelection"
          >
            清空
          </button>
        </div>
      </template>
    </template>

    <!-- ── 已建立映射 ─────────────────────────────────────────────── -->
    <template v-else-if="sub === 'mapped'">
      <!-- 统计条在这里才有意义（P2 · S5 从顶部搬来）：本段是"看成果"的视角，
           关联率 / 映射记录 / 已关联数正是这一段的结论；「待认」段的"还差多少"
           由分段徽标报（2026-10-25 用户口径：状态句与徽标重复，撤句留徽标）。
           ⚠️ 它必须在**工具栏之上**：跟这一段的筛选是两回事（这是全库汇总，不随筛选变）。
           ⭐ 2026-10-25：简洁模式整个撤掉 —— 统计条恒渲染（原来它只在"完整模式"出现，
           而默认就是简洁 ⇒ 绝大多数用户从来没见过它；一个默认藏起来的开关不值得留）。 -->
      <PoolMetrics :stats="qStats" :summary="mSummary" :rate-text="rateText" />

      <div class="gd-toolbar gd-toolbar--sub">
        <input
          v-model="mSearchInput"
          class="wb-input gd-toolbar__search"
          type="search"
          placeholder="搜索商品ID / 平台 / 备注…"
          aria-label="搜索映射"
        />
        <!-- `data-act` 是给断言用的稳定锚点：本页有**两个**叫「状态筛选」的下拉
             （左栏产品状态、这里映射状态），按 aria-label 找会撞名。 -->
        <select
          v-model="mStatus"
          class="wb-input gd-toolbar__select"
          data-act="mapped-status"
          aria-label="映射状态筛选"
        >
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
        <!-- ⭐ 按款反查（P2 · S4）：从**左栏行展开区**搬来的能力。
             原来展开一款就看到"这款认了哪些店铺商品"；展开区撤掉后，同一件事在这里做 ——
             本段本来就是全量映射视图，加一个按款过滤即可，不必再维护第二份读数。
             ⚠️ 只在左栏真的选了款时出现：没有落点时它就是个"点了没反应"的按钮。
             ⚠️ 文案自带当前状态（「已筛」），否则用户分不清自己看到的是一部分还是全部。 -->
        <button
          v-if="product"
          class="wb-btn wb-btn--sm"
          :class="{ 'wb-btn--primary': mProduct === product.id }"
          type="button"
          data-act="mapped-by-product"
          :title="`只看认到 ${product.code} 的店铺商品（左栏那一款认了哪些货）`"
          @click="toggleMappedProduct()"
        >
          {{
            mProduct === product.id
              ? '只看 ' + product.code + '（' + mappedTotal + ' 条）'
              : '只看当前款 ' + product.code
          }}
        </button>
        <!-- ⭐ 失效汇总入口（报告 P1-4 / D-2）。原先要看失效的那几条，得**先自己想到**去
             「状态筛选」里选「已失效」—— 而"还有几条失效没处理"这件事界面上没有任何地方说。
             现在它自己带着数字成为入口（有 N 条 → 只看它们）。
             ⚠️ 它不是"同一状态的第二个控件"：它只在**非失效视图且有失效行**时出现，
             按下去就消失（改成显示"正在只看已失效"），选择器照旧是那个状态显示。 -->
        <button
          v-if="invalidCount > 0 && mStatus !== 'invalid'"
          class="wb-btn wb-btn--sm gd-toolbar__warn"
          type="button"
          data-act="mapped-invalid-only"
          @click="mStatus = 'invalid'"
        >
          有 {{ invalidCount }} 条已失效 → 只看它们
        </button>
        <span
          v-else-if="mStatus === 'invalid'"
          class="wb-muted gd-toolbar__hint"
          data-act="mapped-invalid-on"
        >
          正在只看已失效（要恢复某条，点行内的「恢复」）
        </span>
        <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table
            ref="mappedTableEl"
            class="wb-table gd-mapped"
            data-act="mapped-table"
            tabindex="0"
            @keydown="onMappedKeydown"
          >
            <thead>
              <tr>
                <th class="gd-c-img">图</th>
                <th>商品ID</th>
                <th>关联产品</th>
                <th class="gd-c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <!-- 来源折进行内的常显小字（报告 P2-1）、更新时间仍在 title：
                   来源回答"这图是哪来的、这条凭什么信"（短、每行都要看），
                   更新时间只在"它最近动过吗"时才用（长，常显会把每行撑高）。 -->
              <tr
                v-for="r in mappedRows"
                :key="r.id"
                :data-item-id="r.itemId"
                :data-map-id="r.id"
                :data-row-key="r.id"
                :class="{ 'is-on': r.id === mappedCurrentId }"
                :title="`更新：${r.updatedAt}`"
                @click="markMappedRow(r.id, $event)"
              >
                <td class="gd-c-img">
                  <img
                    v-if="itemThumbs.get(r.itemId)"
                    :src="itemThumbs.get(r.itemId)"
                    class="wb-thumb"
                    :title="itemThumbSource.get(r.itemId) || ''"
                    alt=""
                  />
                  <span v-else class="wb-thumb wb-thumb--empty"></span>
                  <span class="gd-imgcap" data-act="m-thumb-src">
                    {{ itemThumbs.get(r.itemId) ? srcShort(itemThumbSource.get(r.itemId)) : '没有图' }}
                  </span>
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
                <td class="gd-c-item">
                  <span class="wb-mono gd-item__id">{{ r.itemId }}</span>
                  <span class="gd-item__sub">
                    <span :class="{ 'wb-muted': !r.shopName }">{{ r.shopName || `#${r.shopId}（店铺已删）` }}</span>
                    <span v-if="r.platform" class="wb-tag gd-shop__plat">{{ r.platform }}</span>
                    <!-- 来源常显（报告 P2-1）：它回答"这条凭什么信 / 是谁写的"，
                         而原先只在行的 title 里 —— 触屏与不会悬停的人拿不到。
                         更新时间仍留在 title（见行上方那句注释）。 -->
                    <span class="wb-muted gd-note" data-act="m-source">
                      · {{ SOURCE_LABEL[r.source] || r.source }}
                    </span>
                  </span>
                </td>
                <td class="gd-c-product">
                  <span class="wb-mono">{{ r.productCode || '—' }}</span>
                  <span v-if="r.productName" class="gd-note">{{ r.productName }}</span>
                  <span v-if="!r.productCode" class="gd-note">产品已不存在</span>
                  <span class="wb-tag gd-product__status" :class="STATUS_CLASS[r.status] || ''">
                    {{ STATUS_LABEL[r.status] || r.status }}
                  </span>
                </td>
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
                <td colspan="4" class="gd-panel__empty">
                  <div class="wb-empty wb-empty--sm">
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
                          : '在上面的「待认」段确认第一批 —— 建立映射后，订单里的商品ID 才能自动落到款上。'
                      }}
                    </p>
                    <div v-if="!mappedFiltered" class="wb-empty__actions">
                      <!-- ⚠️ 目标必须是本组件真的会渲染的段：`sub = 'queue'` 是整宽形态的段名，
                           在两栏形态里没有对应模板 ⇒ 点了会切到一片空白（不报错）。 -->
                      <button class="wb-btn" type="button" data-act="go-pending" @click="sub = 'pending'">去认款</button>
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

    <!-- 建款向导（从采集商品新建款并关联；方案 §4.3）。
         三个写入全部走既有 IPC（product-upsert / product-variant-upsert / 认款写路径），
         本组件只做"预填 → 人逐行确认"的组织者。 -->
    <ShopItemWizard
      v-if="wizardItem"
      :item="wizardItem"
      :busy="wizardBusy"
      :error="wizardError"
      :receipt="wizardReceipt"
      @close="closeItemWizard"
      @save="createProductFromItem"
    />

    <!-- SKU 矩阵的编辑入口**不在这里**（2026-10-23 起）：产品只维护一套矩阵，
         维护面是产品编辑抽屉；采集段只认款。 -->

    <!-- 删采集行确认：说清两件事 —— 认款映射不受影响；重新采集这行还会出现 -->
    <ConfirmDialog
      v-if="pendingDeleteItem"
      title="删除采集行"
      confirm-text="确认删除"
      busy-text="处理中…"
      :busy="busy"
      @close="cancelDeleteItem"
      @confirm="confirmDeleteItem"
    >
      <p>
        将删除 <b class="wb-mono">{{ pendingDeleteItem.itemId }}</b>
        （{{ pendingDeleteItem.shopName || pendingDeleteItem.storeKey || '未登记' }}）的采集记录。
      </p>
      <p class="wb-notice wb-notice--warn">
        已建立的认款映射<b>不受影响</b>（这一行认到过的款照常生效）；之后重新采集到这行，它会按商品ID
        再次出现并对上原映射。同一商品在多家店下各是一条采集记录，删除只影响这一条。
      </p>
    </ConfirmDialog>

    <!-- 对比认款：左 = 候选产品（独立取图），右 = 这个商品的订单图。
         初始候选直接用左栏「当前款」（多半就是它）—— 这一款通常已经是最接近的猜测。 -->
    <CompareModal
      v-if="compare"
      :item="compare.row"
      :item-image="compareItemImage"
      :initial-product-id="product?.id ?? 0"
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

    <!-- 手贴商品ID导入（保底通道：扩展选择器全落空时贴 ID 进来；source=manual）。
         与采集帧同一个写路径，表上分得开。shopId=0 = 落未登记桶。 -->
    <div v-if="manualImportOpen" class="wb-mask" data-act="manual-import" @click.self="closeManualImport">
      <div class="wb-dialog gd-manual-import" role="dialog" aria-modal="true" aria-label="手贴商品ID导入">
        <div class="wb-dialog__head">
          <span>手贴商品ID导入</span>
          <button class="wb-dialog__x" type="button" data-act="manual-import-close" @click="closeManualImport">
            ×
          </button>
        </div>
        <div class="wb-dialog__body">
          <p class="wb-muted gd-manual-import__hint">
            扩展选择器全落空时用：从卖家后台复制商品ID（每行一个，或用逗号 / 空格分隔），贴进来走与采集相同的落库。导入的行 source=manual，与采集行在表上分得开。
          </p>
          <label class="gd-field">
            <span class="gd-field__label">归属店铺</span>
            <select v-model.number="manualImportShopId" class="wb-input" data-act="manual-import-shop">
              <option :value="0">未登记桶（待登记）</option>
              <option v-for="s in manualImportShops" :key="s.id" :value="s.id">
                {{ s.platform || '—' }} · {{ s.name }}
              </option>
            </select>
          </label>
          <label class="gd-field">
            <span class="gd-field__label">商品ID</span>
            <textarea
              v-model="manualImportText"
              class="wb-input gd-manual-import__area"
              rows="8"
              placeholder="例如：&#10;1234567890&#10;2345678901, 3456789012&#10;4567890123"
              data-act="manual-import-text"
            ></textarea>
          </label>
          <p v-if="manualImportError" class="wb-notice wb-notice--warn" data-act="manual-import-error">
            {{ manualImportError }}
          </p>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" data-act="manual-import-cancel" :disabled="manualImportBusy" @click="closeManualImport">
            取消
          </button>
          <button class="wb-btn wb-btn--primary" type="button" data-act="manual-import-submit" :disabled="manualImportBusy" @click="submitManualImport">
            {{ manualImportBusy ? '导入中…' : '导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 两栏工作台右栏的渲染形态。逻辑见 `../useSkuPool`（与整宽形态 `SkuMappingView` 共用）。
//
// 本组件自己只管两件**渲染专属**的事：
//   ① 把三段（分段控件 / 队列 / 已映射）排进一个窄栏里；
//   ② 列裁剪（§7-2）—— 平台折进店铺格、状态折进行态、来源与更新时间折进 title。
//
// 页级「刷新」信号也接进右栏（`refresh: () => props.refreshNonce`）：页级「刷新」应当刷新
// **同屏**的每一栏，只刷左栏会让"我在右边看着队列、点刷新却什么都没变"。
//
// 左栏的「当前款」（`product`）也接进来 → 换来队列工具栏那个「关联到 `<款编码>`」直连入口，
// 以及对比弹层的初始候选。它由外壳转一手（两个子组件互不认识，见 `GoodsWorkbenchView`）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSkuPool, SKU_STATUS_LABEL as STATUS_LABEL, SKU_STATUS_CLASS as STATUS_CLASS, SKU_SOURCE_LABEL as SOURCE_LABEL, type PendingRow } from '../useSkuPool';
import { useRowNav } from '@/core/composables/useRowNav';
import ProductPicker from './ProductPicker.vue';
import PoolMetrics from './PoolMetrics.vue';
import CompareModal from './CompareModal.vue';
import ShopItemWizard from './ShopItemWizard.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import type { ShopItemSummaryRow, ShopListItem } from '@/types';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉 */
  refreshNonce: number;
  /** 左栏「当前款」（用户展开的那一行）；`null` = 没选款 ⇒ 不给直连入口 */
  product: { id: number; code: string; name: string } | null;
  /**
   * 请求跳去「基础数据」的「店名归一」（由 `GoodsWorkbenchView` 转手，最终来自 `GoodsView`）。
   *
   * 为什么右栏需要它：队列里"店铺未归一"的行**不能**写映射（订单里没有平台字段），
   * 而它们的出口（登记店铺）在「基础数据」模块里。只给一句文字就等于让用户自己去猜在哪 ——
   * 2026-10-08 真机走查实测：那句文字在全新安装上指着一个**根本没装的目的地**（D1 死锁）。
   * 2026-10-14 整合后登记搬进「基础数据」，这里把它变成一次跨模块跳转（TitleBar「返回」送回）。
   */
  goRegistry: () => void;
}>();

const emit = defineEmits<{
  /**
   * 队列聚合出的**组数**报给外壳（`null` = 队列还没拉过）。
   *
   * 报的是原始数字而不是"该不该显示引导卡"的布尔：判据只写一遍（`../firstRun.ts`），
   * 外壳只做原样转手、不推导。`null` 与 `0` 必须分得开 —— 见 `firstRun.ts` 顶部那段：
   * 把"还没拉过"当成"没有待办"，界面就会说出一个它不知道的结论。
   */
  'queue-groups': [groups: number | null];
  /**
   * 存量补图补到了款主图（>0 张）：外壳据此重拉同屏两栏 —— 左栏的产品列表归它自己管，
   * 右栏说"补了 N 张"却不重拉，用户看到的就是"提示说补了、列表还是白图"。
   */
  'images-adopted': [];
}>();

const {
  sub,
  loading,
  busy,
  error,
  failures,
  // 待认清单（两源合并 · P2）：右栏只认这一套
  pendingRows,
  pendingVisible,
  pendingOrigin,
  pendingOriginCount,
  pendingTotal,
  pendingSelected,
  pendingSelectedRows,
  pendingSelectionCount,
  pendingScopeText,
  pendingScopeTitle,
  pendingSelectable,
  pendingAllChecked,
  pendingSomeChecked,
  togglePendingAll,
  togglePendingOne,
  clearPendingSelection,
  openPendingPicker,
  relatePending,
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
  mProduct,
  picker,
  pendingInvalidate,
  compare,
  viewer,
  queueImgs,
  itemThumbs,
  itemOverrides,
  itemThumbSource,
  imgBusy,
  currentProduct,
  compareItemImage,
  unresolvedShopsAll,
  unresolvedHasOrder,
  unresolvedHasItems,
  unresolvedHintTitle,
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
  relateToSelected,
  confirmCompare,
  applyPick,
  confirmInvalidate,
  restore,
  // 待关联采集商品段（第三段）
  itemRows,
  itemTotal,
  itemSummary,
  itemSelected,
  receiverStatus,
  itemStats,
  unresolvedItemStores,
  selectableItems,
  itemSelectedRows,
  itemAllChecked,
  itemSomeChecked,
  toggleItemAll,
  toggleItemOne,  openItemPicker,
  openItemWizard,
  closeItemWizard,
  createProductFromItem,
  wizardItem,
  wizardBusy,
  wizardError,
  wizardReceipt,
  // 删采集行（行内「删除」→ 确认弹层）
  pendingDeleteItem,
  requestDeleteItem,
  cancelDeleteItem,
  confirmDeleteItem,
  manualImportOpen,
  manualImportShopId,
  manualImportText,
  manualImportBusy,
  manualImportError,
  manualImportShops,
  openManualImport,
  closeManualImport,
  submitManualImport,
  // 「打开店铺」下拉（items 段工具条）
  openShopError,
  openShopRows,
  loadOpenShopList,
  openShopNow,
} = useSkuPool({
  refresh: () => props.refreshNonce,
  selectedProduct: () => props.product,
  // 右栏的合并段（待认）—— 首屏就要两源一起拉，见 `SkuPoolOptions.initialSub`
  initialSub: 'pending',
  // 存量补图补到了款主图 → 请外壳重拉（左栏产品图由 `useProductList` 自己管）
  onImagesAdopted: () => emit('images-adopted'),
});

/* ---- 键盘动线（方案 §6）：↑↓ 移动 / Space 勾选 / Enter 对比 ------------
   ⚠️ 行 id 用 `r.key`（`o:` / `i:` + 主键），**不能用 `r.itemId`**：同一个商品可能同时来自
   订单与采集（两行同一个商品ID），拿 itemId 当键会在两行之间来回跳 —— 而且看起来完全正常，
   只是"按一下 ↓ 停在原地"。这条在真机上是查不出来的，只能靠键本身不重复。
   ⚠️ Space 走的仍是唯一的 `togglePendingOne`（它自己会挡 `canRelate=false` 的行）：
   勾选框是 disabled 的行，键盘也不许勾 —— 否则"按空格悄悄勾上了"会绕过 disabled。 */
const pendingCurrentKey = ref('');
const pendingTableEl = ref<HTMLTableElement | null>(null);

function markPendingRow(key: string, e: MouseEvent): void {
  pendingCurrentKey.value = key;
  // 点行内的按钮（对比 / 缩略图 / 删除）时不抢焦点：那个按钮马上要开弹层，
  // 把焦点抢回表上，弹层关掉之后焦点就落在一个看不见的位置了。
  if ((e.target as HTMLElement | null)?.closest('button')) return;
  pendingTableEl.value?.focus({ preventScroll: true });
}

const { onKeydown } = useRowNav({
  rows: pendingVisible,
  idOf: (r) => r.key,
  currentId: pendingCurrentKey,
  onSelect: (key) => {
    pendingCurrentKey.value = key;
    pendingTableEl.value?.focus({ preventScroll: true });
  },
  onToggle: (key) => {
    const r = pendingVisible.value.find((x) => x.key === key);
    if (r) togglePendingOne(r);
  },
  onOpen: (key) => {
    const r = pendingVisible.value.find((x) => x.key === key);
    // 与行内「对比」按钮**同一个判据**（`canRelate && origin === 'order'`）：
    // 按钮不在的行，回车也不该开弹层 —— 否则键盘能给出一条界面上不存在的路。
    if (r && r.canRelate && r.origin === 'order') openPendingCompare(r);
  },
  rowEl: (key) => pendingTableEl.value?.querySelector(`tr[data-row-key="${key}"]`) ?? null,
});

/** 筛选 / 认掉之后当前行可能已不在列表里 —— 撤回，别让下一次 ↑↓ 从"没有当前行"重来。 */
watch(pendingVisible, (list) => {
  if (pendingCurrentKey.value && !list.some((r) => r.key === pendingCurrentKey.value)) {
    pendingCurrentKey.value = '';
  }
});

/* ---- 已认表（映射表）的键盘动线 -----------------------------------------
   与待认表**不同**的三处（照抄上一张会错的地方）：
   ① 行身份用 `r.id`（映射行主键）：`itemId` 在这里同样不唯一 —— 同一商品在两个店铺各有一条映射；
   ② **没有勾选概念**（无 checkbox、无批量出口）⇒ 不传 `onToggle`，Space 交还页面滚动。
      硬塞一个"勾选"会勾出界面上看不见的状态，比没反应更糟；
   ③ `Enter` = 行内第一个操作「改绑」，判据与那个按钮**完全一致**（`busy` 时它是灰的）。
*/
const mappedCurrentId = ref(0);
const mappedTableEl = ref<HTMLTableElement | null>(null);

function markMappedRow(id: number, e: MouseEvent): void {
  mappedCurrentId.value = id;
  // 点行内按钮（设图 / 改绑 / 标失效）时不抢焦点：弹层马上要开，抢回来关掉弹层后焦点会落在看不见的地方。
  if ((e.target as HTMLElement | null)?.closest('button')) return;
  mappedTableEl.value?.focus({ preventScroll: true });
}

const { onKeydown: onMappedKeydown } = useRowNav({
  rows: mappedRows,
  idOf: (r) => r.id,
  currentId: mappedCurrentId,
  onSelect: (id) => {
    mappedCurrentId.value = id;
    mappedTableEl.value?.focus({ preventScroll: true });
  },
  onOpen: (id) => {
    const r = mappedRows.value.find((x) => x.id === id);
    if (r && !busy.value) openRebindPicker(r);
  },
  rowEl: (id) => mappedTableEl.value?.querySelector(`tr[data-row-key="${id}"]`) ?? null,
});

/** 改筛选 / 改绑后那一行可能已不在可见列表里：撤回当前行，否则下一次 ↑↓ 会从"没有当前行"重来。 */
watch(mappedRows, (list) => {
  if (mappedCurrentId.value && !list.some((r) => r.id === mappedCurrentId.value)) {
    mappedCurrentId.value = 0;
  }
});

/**
 * 失效条数（报告 P1-4）。
 *
 * 取自 `skuSummary()` 的 `byStatus` —— 它是**全库**汇总（不带筛选），所以这个数字
 * 与当前筛选无关，任何时候都表示"一共有几条失效还没处理"。
 * `null`（汇总还没到）算 0 ⇒ 入口不渲染：宁可晚一拍出现，也不要先亮一个不知道真假的数字。
 */
const invalidCount = computed(
  () => mSummary.value?.byStatus.find((s) => s.status === 'invalid')?.count ?? 0
);

/* ---- 待认清单的模板辅助（P2）------------------------------------------
   模板里的行是**联合形状**（订单行 / 采集行合成一个 `PendingRow`），取原始行、写筛选值时
   各收窄一次放在这里 —— 模板里写 `r.queueRow!` 这类断言，失败时是一整页白屏而不是一个函数报错。 */

/**
 * 「只看当前款」开关（P2 · S4）。
 *
 * `mProduct` 存的是**款 id**（编码只是展示标签，可以改）。按一下筛上、再按一下取消 ——
 * 取消的出口必须存在：用户看完这一款认了什么，接下来多半要回到全量去找别的。
 */
function toggleMappedProduct(): void {
  const p = props.product;
  if (!p) return;
  mProduct.value = mProduct.value === p.id ? 0 : p.id;
}

/**
 * 左栏换了一款时，"按款筛选"要跟着换。
 *
 * ⚠️ 只在**已经在筛**的时候跟（`if (!mProduct.value) return`）：
 * 没筛的时候自动筛上，用户切到「已认」段会发现全库映射突然只剩三条，而他并没有要求这个。
 * 而正在筛的时候不跟，用户点了 S2 却还看到 S1 的映射 —— 那看起来就是"筛选坏了"。
 */
watch(
  () => props.product?.id,
  (id) => {
    if (!mProduct.value) return;
    mProduct.value = id ?? 0;
  }
);

/** 来源筛选：把 select 的值写回钩子（`v-model` 对联合字面量类型不友好，显式收窄一次） */
function setPendingOrigin(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  pendingOrigin.value = v === 'order' || v === 'scrape' ? v : '';
}

function openPendingImage(r: PendingRow): void {
  if (r.queueRow) openImage(r.queueRow);
}
function openPendingCompare(r: PendingRow): void {
  if (r.queueRow) openCompare(r.queueRow);
}
function requestDeletePending(r: PendingRow): void {
  if (r.itemRow) requestDeleteItem(r.itemRow);
}

/**
 * 动作条上的「新建款并关联」—— 只在**恰好勾了一个采集行**时出现。
 *
 * 为什么只接受一个：向导预填的是**这一个**商品的 SKU 矩阵，多行没有"合并预填"这回事
 * （拼起来就是猜）。为什么只接受采集行：向导的预填与图片采纳都来自采集快照，
 * 订单行没有 SKU 矩阵可预填。
 */
const pendingWizardItem = computed(() => {
  const rows = pendingSelectedRows.value;
  if (rows.length !== 1) return null;
  return rows[0].itemRow;
});
function openPendingWizard(): void {
  const r = pendingWizardItem.value;
  if (r) openItemWizard(r);
}

/**
 * 图片来源的**短标**（报告 P2-1）。
 *
 * 完整说法（"订单识别图（自动）"/"手动上传的覆盖图"）只适合放 `title`；常显的图注
 * 只有几十像素宽，写全了会把「图」这一列顶宽、把右边的按钮挤出去。
 * 认不出来就回落一个"图"——**不猜**（猜错等于给用户一个假的出处）。
 */
function srcShort(s?: string): string {
  if (!s) return '';
  if (s.indexOf('手动') >= 0) return '手动图';
  if (s.indexOf('订单') >= 0) return '订单图';
  if (s.indexOf('产品') >= 0) return '产品图';
  return '图';
}

/**
 * 「批量关联选中 N 项…」的按钮文案 —— 与 `batchLabel` 同一条纪律：
 * **单项时不说「批量」**（批量是一个承诺：一次写多行、一次事务、一次回执）。
 */
const itemBatchLabel = computed(() =>
  itemSelectedRows.value.length === 1
    ? '关联选中 1 项…'
    : `批量关联选中 ${itemSelectedRows.value.length} 项…`
);

/** 采集时间（ms epoch → `MM-DD HH:mm`）；0 = 没采集过，显示 '—' 不显示 1970 */
function fmtEpoch(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---- 「打开店铺」下拉：开关、点外关闭、行内动作 ---- */
const shopOpen = ref(false);
const shopOpenRoot = ref<HTMLElement | null>(null);

function toggleShopOpen(): void {
  shopOpen.value = !shopOpen.value;
  // 每次打开都重拉店铺列表：店铺可能刚在「店名归一」里改过（本页没有别的途径感知）
  if (shopOpen.value) void loadOpenShopList();
}
function openShopFromMenu(shop: ShopListItem): void {
  // 先关面板再开浏览器（同 `applyPick` 的先关后提交）：失败时用户看到的是 toast，不是一个又弹着的面板
  shopOpen.value = false;
  void openShopNow(shop);
}
/** 面板里的「去补地址」/ 空态「去「店名归一」」：先关面板，再走既有跨模块出口 */
function goFixShop(): void {
  shopOpen.value = false;
  props.goRegistry();
}
/** 点面板外任意处关闭（与店铺账号页 CopyMenu 同款写法） */
function onDocClickShop(e: MouseEvent): void {
  const el = shopOpenRoot.value;
  if (el && !el.contains(e.target as Node)) shopOpen.value = false;
}
onMounted(() => document.addEventListener('click', onDocClickShop));
onBeforeUnmount(() => document.removeEventListener('click', onDocClickShop));
/** 切走分段时收起面板 —— 面板随 items 模板卸载，留着 open=true 再切回来会"无故弹着" */
watch(
  () => sub.value,
  () => {
    shopOpen.value = false;
  }
);

/** 下拉行里的采集统计短句（没采过 / 已采 N · 最近 MM-DD HH:mm） */
function shopStatText(stat: ShopItemSummaryRow | null): string {
  if (!stat || !stat.total) return '还没采过';
  return `已采 ${stat.total} · 最近 ${fmtEpoch(stat.lastScrapedAt)}`;
}

/**
 * 「复制接入信息」：把商品采集端点的 curl 样例写进剪贴板。
 *
 * 与「订单采集」岛（`ui-plugins/ae-profit`）里那条订单 curl **同构不同帧**：
 * 同一条接收端、同一枚 token、同一个"粘贴即可入库"的承诺，只是 schema 换成
 * `ae-shop-item/v1`、路径换成 `/ae/shop-items/ingest`。端口取实时状态里的值
 * （状态还没问到时回落默认 46211）—— 不硬编码一个可能已经变了的端口。
 */
async function copyItemsInfo(): Promise<void> {
  const port = receiverStatus.value?.port ?? 46211;
  const body = JSON.stringify({
    schema: 'ae-shop-item/v1',
    store: { url: 'https://www.aliexpress.com/store/123456/index.html', storeId: '123456' },
    items: [
      {
        itemId: '1005001234567890',
        title: '示例商品',
        imageUrl: 'https://ae01.alicdn.com/kf/S1234.jpg',
        priceText: 'US $9.99',
        skus: [{ props: 'Color:Black', price: 'US $9.99' }],
      },
    ],
  });
  const curl = [
    `curl -X POST http://127.0.0.1:${port}/ae/shop-items/ingest`,
    "-H 'Content-Type: application/json'",
    "-H 'X-Ae-Token: sk-ae-dev-token'",
    `-d '${body}'`,
  ].join(' \\\n');
  const ok = await writeClipboard(curl);
  if (ok) toast('接入信息已复制：终端粘贴运行即可入库（扩展采集走同一条端点）', 'success');
  else toast('复制失败', 'error');
}

/**
 * 组数往上报（→ 外壳 → 首次动线的判据）。`null` = 队列还没拉过，**不是 0**（见 `firstRun.ts`）。
 */
watch(() => qStats.value?.groups ?? null, (n) => emit('queue-groups', n), { immediate: true });
</script>

<style scoped>
.gd-pool {
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
  width: 100%;
  min-width: 140px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 130px;
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
  gap: 4px;
  flex-shrink: 0;
}
/* 提示条（2026-10-25 用户口径"太占位置"）：从告警块压成**单行轻提示** ——
   字号降一档、行高收紧、店名与按钮是仅有的两个重点。
   长解释（为什么必须登记 / 之后的采集怎么归位）收进 title 悬停，不常驻占宽。 */
.gd-hints :deep(p) {
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.5;
}
.gd-hint-shops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
}
/* 店名串允许收缩省略 —— 店名一多不能把按钮挤出屏外（按钮是这个出口的全部价值） */
.gd-hint-shops span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* 两张表都用**固定布局**，列宽由这一处说了算。
   为什么必须固定：默认 1200×800 窗口下右栏只有 ~500px 宽，而 `.wb-panel` 是 overflow:hidden ——
   表格一旦比容器宽，右半截（含「操作」表头与「对比」按钮）会被**静默裁掉**：没有滚动条、没有报错、
   DOM 里字段一个不少，于是"元素存在"类断言对它恒绿（2026-10-08 真机走查实测：表格右缘 1424 > 视口 1200，
   「对比」按钮中心点落在视口外）。固定布局 + width:100% 让表格**按构造**不越界。 */
.gd-queue,
.gd-mapped {
  width: 100%;
  table-layout: fixed;
}
/* 店铺商品表：同一套固定布局结论（2026-10-12 窄窗口坑：图列塌成 32px、
   表格右半截被 .wb-panel 静默裁掉）。2026-10-16 起**六列**（售价整列撤掉、
   SKU 从"条数"改成"色/码文本 + 行内修改"）：图列与时间列窄，商品ID 与 SKU
   吃剩下的宽度 —— 商品ID **单行不换行**（省略号 + title 全文），SKU 文本同理。
   ⚠️ 列宽必须写在 **th 与 td 两处**（或写元素无关的选择器）：table-layout:fixed 的
   列宽由**第一行（thead）**算，只写 `td.gd-c-ops` 时表头那列拿不到宽度 ⇒ 状态列
   被剩余空间撑到 150px（2026-10-16 实测），比声明宽出 40px，表格整体失衡。
   ⭐ 2026-10-17 晚间（用户口径"商品ID 和 SKU 中间空格太宽"）：商品ID 改**定宽**
   （16 位 ID 一行放得下，148px ≈ 16 字 × mono 12px + padding）。原先它是唯一的
   无声明列 ⇒ 剩余空间全灌给它，ID 右边留出一大截空白，正好横在 ID 与 SKU 中间。
   现在剩余空间改由 **SKU 列**吸收（去掉它的 132px 定宽），文本用省略号吃满自己的列。
   ⭐ 2026-10-18（用户口径"列表样式重叠在一起"）：右栏 518px 下六列分完，SKU 只剩
   60px 内容宽，而格内是 inline-block 文本 + 按钮、**不认列宽** ⇒ 「改」越到时间列上
   （实测 "改09-30 16:00"）。修法两条：① 格内改 flex（文本收缩省略、按钮不缩，
   溢出被结构性消掉，见 .gd-sku__cell / .gd-ops__cell）；② **撤掉「采集时间」整列**，
   时间折进商品ID 格第二行 ⇒ 腾出的 88px 全给 SKU，五列。 */
.gd-items {
  width: 100%;
  table-layout: fixed;
  /* 兜底（2026-10-18）：六列的定宽合计已占掉大半宽，右栏再窄时宁可让表格**自己横滚**
     （`.wb-panel__body` 是 overflow:auto，滚动条落在面板里、不裁内容），
     也不要把 SKU 列压成 0 —— 列一塌，格内内容就溢到隔壁列上去（就是本轮修的"重叠"）。 */
  min-width: 500px;
}
.gd-items .gd-c-ops {
  width: 108px;
}
/* 商品ID 定宽：16 位 ID + 左右 padding（mono 13px 实测 ~125px，148 是"刚好放下"的值 ——
   收到 140 就会截成 10050012345678…，那是这一列唯一的识别依据，不能再压）。 */
.gd-items .gd-c-item {
  width: 148px;
}
/* 图列：图 52px + 左右 padding 20px = 72 才能把图和图注都放平；再给 4px 余量到 76
   （图注是 10.5px 的店名，"芒果旗舰店"5 字约 52.5px —— 68 会截成"芒果旗…"）。
   原先 64（内容 44）时图注整串**越到商品ID列**上：格子不裁剪、图注又是 nowrap。 */
.gd-items .gd-c-img {
  width: 76px;
}
/* 采集时间列：放得下「09-30 16:00」约 80px ⇒ 88 留 8px 余量；单行 nowrap，
   不折行（折行会把整列撑高，与商品ID 列高度对照的冒烟断言会失准）。 */
.gd-items .gd-c-time {
  width: 88px;
  white-space: nowrap;
}
/* 图注一格一行、超宽省略：店名再长也不能越界（原先是 nowrap 且无上限） */
.gd-items .gd-imgcap {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 商品ID 单行：16 位 ID 在 break-all 下会折成两行把整列撑高 ⇒ nowrap + 省略号，
   全文进 title（悬停/触屏长按可见）。与队列/映射两表的"允许换行"是**两种**需求：
   那两表的第二行是折进来的店铺/卖出笔数（设计上就要换行），这里只有一个 ID。 */
.gd-items td.gd-c-item {
  white-space: nowrap;
}
.gd-items .gd-item__id {
  display: block;
  word-break: normal;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gd-items .wb-thumb {
  width: 52px;
  height: 52px;
}
/* SKU 列吃剩余宽度（原 132px 定宽已撤，见上面 gd-items 那段）。
   这一列现在是**只读文本**（2026-10-23 合并后采集段不再改矩阵），仍要能省略：
   固定布局下它可能只有 60-70px 内容宽，不裁剪就整串越到时间列上。 */
.gd-c-sku {
  white-space: nowrap;
}
.gd-sku__cell {
  display: flex;
  align-items: center;
  min-width: 0;
}
.gd-sku__text {
  /* 可 shrink ⇒ 窄列下变省略号；不 grow ⇒ 文本按内容宽，不铺满整列。 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-size: 12px;
}
/* 状态格：文字 + 1-2 个行内动作，列宽只有 ~80px 内容 ⇒ 换行由 flex-wrap 决定、间距由 gap 决定。
   原实现靠 inline 元素间的空白，换行后两行紧贴在一起（截图看就是"挤成一坨"）。 */
.gd-ops__cell {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  min-width: 0;
}
.gd-items td.gd-c-ops {
  white-space: normal;
}
/* 采集接收端状态（2026-10-25 用户口径"太占位置"）：一行**小字次级信息** ——
   不是告警也不是进度，只是"采集这个通道的现状"。12px + 次级色，点仍保留
   （在线/未运行是一眼要看的），端口与操作指引收进 title。全零不占位由模板层保证。 */
.gd-items__status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--wb-text-muted);
}
.gd-items__status b {
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
.gd-items__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--wb-text-muted);
  flex-shrink: 0;
}
.gd-items__dot.is-on {
  background: var(--wb-success, #2ea44f);
}
/* 「打开店铺」下拉（items 工具条）。面板绝对定位在工具条下方、盖住底下的表格 ——
   工具栏不在 `.wb-panel`（overflow:hidden）里面，无裁剪；z-index 压过面板即可。 */
.gd-shopopen {
  position: relative;
  display: inline-flex;
}
.gd-shopopen__panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  width: 300px;
  max-height: 360px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: 0 8px 24px var(--wb-overlay);
}
.gd-shopopen__title {
  margin: 2px 4px 6px;
  font-size: 11.5px;
  color: var(--wb-text-muted);
}
.gd-shopopen__msg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 4px 4px;
}
.gd-shopopen__msg p {
  margin: 0;
  font-size: 12px;
}
.gd-shopopen__list {
  display: flex;
  flex-direction: column;
}
.gd-shopopen__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  text-align: left;
}
button.gd-shopopen__item {
  cursor: pointer;
}
button.gd-shopopen__item:hover {
  background: var(--wb-hover);
  color: var(--wb-primary);
}
.gd-shopopen__item.is-nourl {
  color: var(--wb-text-muted);
}
.gd-shopopen__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gd-shopopen__stat {
  flex-shrink: 0;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
/* 队列的图放大一档：认款**只能靠肉眼比图**（订单里没有任何字段能推出"这是哪一款"），
   它是这一列的主要依据，不是装饰。 */
.gd-c-img {
  width: 64px;
  text-align: center;
}
/* 图注（报告 P2-1）：常显一行小字 —— "这图是从哪来的 / 这里根本没有图"原先只在 title 里，
   触屏与不会悬停的人拿不到。而图是认款的**主要依据**，它有没有、从哪来必须一眼看得见。 */
.gd-imgcap {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.25;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
.gd-queue .wb-thumb,
.gd-pending .wb-thumb {
  width: 52px;
  height: 52px;
}
/* 商品ID 格：第一行是 ID 本身，第二行是折进来的店铺 / 平台 / 卖出笔数 / 疑似店铺。
   ⚠️ 两行都**允许换行**（`.wb-table td` 全局是 nowrap）：固定布局下格子宽度是死的，
   折进来的信息若靠省略号裁掉，就等于"界面上看不见、DOM 里却有" —— 正是本轮要消掉的那类错觉。
   合并后的待认表同理：来源标签 + 店铺 + 平台 + 补充都在副行，一行放不下就得能折。 */
.gd-queue td.gd-c-item,
.gd-pending td.gd-c-item,
.gd-mapped td.gd-c-item {
  white-space: normal;
}
.gd-item__id {
  display: block;
  word-break: break-all;
}
.gd-item__sub {
  display: block;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}
.gd-shop__plat {
  margin-left: 6px;
  font-size: 11px;
}
.gd-c-product {
  width: 132px;
  white-space: normal;
}
.gd-product__status {
  margin-left: 6px;
}
/* 队列的缩略图包一层按钮（点开看原图）—— 剥掉按钮默认外观，只留"可点开"的光标 */
.gd-thumb-btn {
  position: relative;
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  line-height: 0;
  cursor: zoom-in;
}
/* 「这张图能点开看大图」常显角标（原先只在 title 里）—— 不依赖悬停，触屏也看得见 */
.gd-thumb-btn__zoom {
  position: absolute;
  right: -3px;
  bottom: -3px;
  padding: 0 2px;
  border-radius: 3px;
  background: var(--wb-overlay);
  color: var(--wb-on-accent);
  font-size: 9px;
  line-height: 1.4;
}
/* 「有 N 条已失效 → 只看它们」：这是一条**待办**入口（有东西没处理完），不是普通按钮 */
.gd-toolbar__warn {
  border-color: var(--wb-warning);
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
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
/* 商品ID图下的小操作（设图 / 换图 / 清除）：固定列宽下允许换行，别溢出格子 */
.gd-imgops {
  display: flex;
  flex-wrap: wrap;
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

/* ---- 手贴商品ID导入（保底通道）---- */
.gd-manual-import {
  max-width: min(86vw, 560px);
}
.gd-manual-import__hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
}
.gd-field {
  display: block;
  margin-bottom: 12px;
}
.gd-field__label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--wb-text-muted);
}
.gd-manual-import__area {
  width: 100%;
  resize: vertical;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 13px;
  line-height: 1.5;
}

/* ---- 待认清单（两源合并 · P2）------------------------------------------- */

/* 来源筛选：一个「来源 ▾」小标签 + 下拉。与"两个分段按钮"的差别是语义 ——
   筛选不改视图（还是同一张待认表），只收窄行。 */
.gd-origin {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.gd-origin__sel {
  width: auto;
  max-width: 180px;
  padding: 4px 6px;
  font-size: 12.5px;
}
/* 行内来源标签：订单 / 采集 / 手贴。副行里最小的一档字，
   与「店铺」「平台」并排 —— 它是**属性**，不该抢 ID 的视觉权重。 */
.gd-origin__tag {
  margin-right: 6px;
  padding: 0 5px;
  font-size: 10.5px;
  line-height: 1.5;
  border-radius: 3px;
  border: 1px solid var(--wb-border);
  color: var(--wb-text-muted);
}

/* 副行里的 SKU 补充文本：**只放一个短词**（「SKU N 条」/「未采集」），色码全文已降为
   `title`（2026-10-28 用户口径"SKU 不要全部列出来"）。
   保留 nowrap + 省略号是兜底：这格同时并排着来源标签、店铺、平台，宽度不够时它必须
   自己缩，不能把整行撑成两行（那一版就是用户说的"展示不全"）。
   ⭐ 2026-10-25（用户口径"SKU 太长"）：字号降到与副行一致（11.5px）。 */
.gd-pending__sku {
  display: inline-block;
  max-width: 94%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
  font-size: 11.5px;
}

/* 待认表的操作列（2026-10-25 用户口径"操作按钮不方便"）：合并后每行其实只有
   **一个**动作（订单 → 「对比」，采集 → 「删除」），共用规则那 150px 是给
   "关联 + 对比"两个按钮的老宽度 —— 白白占掉三成列宽。收窄到 96px 还给
   「商品ID / 店铺」列；右对齐让按钮贴着行尾（位置可预期，不随行长漂）。
   不可认行的"灰因 + 去登记"两个链接放不下了就换行（nowrap 会溢出格子）。 */
.gd-pending th.gd-c-ops,
.gd-pending td.gd-c-ops {
  width: 96px;
  text-align: right;
}
.gd-pending td.gd-c-ops {
  white-space: normal;
}
.gd-pending td.gd-c-ops .wb-link + .wb-link {
  margin-left: 6px;
}

/* 合并表的商品ID：**单行不折**。`.gd-item__id` 全局是 `word-break: break-all`（给队列的
   超长 ID 用），在合并表里会把 16 位 ID 折成两行、把行高撑起来 —— 而 ID 是这一行唯一的
   识别依据，折了两行反而更难读。溢出走省略号，全文在 title 里。 */
.gd-pending .gd-item__id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: normal;
}

/* 动作条：**吸底**。认款是全页唯一的提交动作，滚到第 30 行时它必须还在手边 ——
   放在表格上方的话，行数一多用户就得滚回去找。
   ⚠️ 全部走主题令牌（2026-10-25 用户报"没跟随主题"的根因就在这）：
   这里原先写的是 `var(--wb-bg-panel, #fff)` —— 而 `--wb-bg-panel` **根本不存在**于主题令牌里
   （那是一个从旧版式抄来的名字），于是深色主题下它永远回落到 `#fff` 白底；
   `--wb-text-2` 同罪。变量名拼错有回落兜着，不报错、只是"永远不对"。 */
.gd-actbar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: 0 -2px 10px var(--wb-shadow);
}
.gd-actbar__count {
  font-size: 12.5px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
/* 作用域：勾了哪几个商品（报商品ID，不报"第几行"—— 行号会随筛选/排序全变）。
   超长裁掉，完整名单在 title 里：吸底栏一旦被撑成两行就会盖住表格最后一行，
   而"哪几个"是辅助信息，不值得用两行去换。 */
.gd-actbar__scope {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
</style>
