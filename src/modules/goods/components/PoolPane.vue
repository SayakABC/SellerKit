<template>
  <!-- 两栏工作台**右栏**：店铺商品池（待关联队列 / 已建立映射）。
       与整宽形态（`SkuMappingView.vue`，`GOODS_LAYOUT='tabs'` 的回退路径）**共用同一份逻辑**
       （`../useSkuPool`），差别只在渲染：这里列更少，把"能折的都折了"。

       列的取舍（见 `docs/plans/GOODS_WORKBENCH_PLAN.md` §7-2）：
         · 队列 9 → 7：**平台折进「店铺」格里的小标签**；**状态折进行态**（未归一行整行浅底 +
           「操作」列禁用并说明原因）—— 原「状态」列那两句话本来就是"能不能点"的注释；
         · 已映射 9 → 6：**平台折进「店铺」格**；**来源 / 更新时间移进行 `title`**（它们只在
           "这条为什么变了"时才要，不该常驻占宽）。

       ⚠️ 取图、看图弹层、分段控件与所有 `data-act` 名与整宽形态**逐字一致**（见方案 §8-1 的
       "选择器稳定契约"）—— 契约变了就得两边一起重挂守卫，那是纯成本、没收益。 -->
  <div class="gd-pool">
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
         规则（含"`null` 不是空"、关联率 `—` 不渲染）全部在 `PoolMetrics.vue` 里写了一遍 ——
         整宽回落形态 `SkuMappingView` 用的是同一个组件，所以不存在"只改了一处"。
         ⚠️ 简洁模式下整条不渲染（报告 P1-1）：这一排是给"要盯指标"的人看的，
         新手看到的是"五项 0 和 —，这页是不是坏了"。判据在 `../simple`。 -->
    <PoolMetrics v-if="!goodsSimple" :stats="qStats" :summary="mSummary" :rate-text="rateText" />

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
        <!-- ⭐ 这一条**必须带按钮**（2026-10-08 走查 D1）：它是队列里"店铺未归一"那几行的出口，
             而原文写成纯文本长句 + "请先到「店铺账号管家」的「店铺登记」" —— 那个岛**不在默认包里**。
             于是全新安装上这里是一个两端都不可点的死胡同：提示不可点、目的地不存在。
             现在目的地是内建的「店铺登记」页签，按钮直接跳过去。 -->
        <p v-if="unresolvedShops.length" class="wb-notice wb-notice--warn gd-hint-shops" data-act="hint-shops">
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
        <!-- ⭐ 直连（分栏才有的动线）：款与商品同屏，看着左栏那一款直接把手里的商品认过去。
             只在左栏**真的展开了一款**时出现 —— 没有落点就不给入口（给了只能写错款）。 -->
        <button
          v-if="currentProduct"
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="relate-to-selected"
          :disabled="busy || !selectedUnmapped.length"
          @click="relateToSelected"
        >
          关联到 {{ currentProduct.code }}<template v-if="selectedUnmapped.length">（{{ selectedUnmapped.length }} 项）</template>
        </button>
        <!-- 弹层选产品：直连之外的老路（左栏没展开款、或想挑别的款时用）。 -->
        <button
          class="wb-btn"
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
        <!-- 计数用**待办总数**（未关联 + 店铺未归一），不是 `stats.groups`。
             `groups` 是"聚合出的全部组"，含**已经关联好的**那一半 —— 拿它当分母会写出
             「共 3 组待处理」而实际上只剩 1 组（2026-10-08 真机走查实测的同一处口径分裂）。 -->
        <span class="wb-muted gd-toolbar__hint" data-act="queue-count">
          共 {{ queuePendingTotal }} 组待处理，已列出 {{ qStats?.shown ?? 0 }} 组
        </span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table class="wb-table gd-queue" data-act="queue-table">
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
                <th class="gd-c-img">图</th>
                <th>商品ID</th>
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
                <!-- 认款只能靠肉眼比图（订单里没有任何字段能推出"这是哪一款"），
                     所以「图」是**主要依据**而不是装饰：没有它，用户只能对着一个 16 位商品ID 猜。
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
                    <!-- 「点它看大图」原先只在 title 里（触屏 / 不会悬停的人永远看不到）⇒
                         常显一个角标，让"这张图能点"不依赖鼠标。 -->
                    <span class="gd-thumb-btn__zoom" aria-hidden="true">⤢</span>
                  </button>
                  <span
                    v-else
                    class="wb-thumb wb-thumb--empty"
                    data-act="q-thumb-empty"
                  ></span>
                  <!-- 常显图注（报告 P2-1）：没有图时**这行就是唯一说明** ——
                       "图是认款的主要依据"，那么"这个商品没有图"必须一眼看得见，
                       而不是等鼠标悬停 1 秒才浮出来。 -->
                  <span class="gd-imgcap" data-act="q-thumb-src">
                    {{ queueImgs.get(r.itemKey) ? srcShort(queueImgs.get(r.itemKey)?.source) : '没有图' }}
                  </span>
                </td>
                <!-- 商品ID 格 —— 这一行**只剩「图」和它两样要看的**（2026-10-08 精简）。
                     原先「店铺 / 商品标题 / 订单行」各占一整列，7 列在**默认 1200×800 窗口**下
                     放不下：队列表整体超出容器右界，被 `.wb-panel{overflow:hidden}` 静默裁掉右半截
                     —— 「对比」按钮与「操作」表头都在裁掉的那一侧，S3 刚建好的对比动线等于没做。
                     现在店铺 / 平台 / 卖出笔数 / 疑似店铺折成第二行小字，一个字段都没丢，
                     但列数从 7 降到 4。 -->
                <td class="gd-c-item">
                  <span class="wb-mono gd-item__id" data-act="q-item-id">{{ r.itemId }}</span>
                  <span class="gd-item__sub">
                    <template v-if="r.shopId">{{ r.shopName || `#${r.shopId}` }}</template>
                    <span v-else class="wb-muted" :title="`订单里的店铺原文：${r.shopRaw || '（空）'}`">
                      {{ r.shopRaw || '（无店铺名）' }}
                    </span>
                    <span v-if="r.platform" class="wb-tag gd-shop__plat">{{ r.platform }}</span>
                    <span class="wb-muted">· 卖出 {{ r.orderCount }} 笔</span>
                    <!-- 自动建议只作提示（未自动落库）：认店铺时给个参照，不替用户决定 -->
                    <span v-if="r.autoShopName" class="gd-note">
                      疑似 {{ r.autoShopName }}<template v-if="r.autoShopPlatform">（{{ r.autoShopPlatform }}）</template>
                    </span>
                  </span>
                </td>
                <!-- 状态折进行态：能关联的只剩「关联…」与「对比」，不能关联的在这里说清原因
                     （而不是给个灰按钮就完事）。「对比」是**分栏/整宽都成立**的：它不依赖左栏，
                     只要这一行有图就能把候选产品与它并起来看。 -->
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
                    <!-- 「需先登记店铺」保持**禁用**：这一行确实不能关联（订单里没有平台字段，
                         硬塞会把两家店并到同一个键上）。但灰因不能只躺在 title 里 ——
                         触屏 / 不会悬停的人永远看不到它，而灰按钮旁边的**可点出口**才是关键。
                         所以紧跟着给「去登记」：同一个动作在提示条上也有一份（两处入口、一条路径）。 -->
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
                <td colspan="4" class="gd-panel__empty">
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
                         去导入时得自己找「发货台」在哪 —— 而队列本来就是那一页导进来之后才有的。
                         同文件下面「还没有任何映射」的空态早就这么做了（一个可点的下一步），
                         这里补齐同一形态。（`.wb-empty__desc` 里**不要再写 markdown 星号**：
                         它是纯文本节点，`**实时**` 会原样显示成四个星号。） -->
                    <p class="wb-empty__desc">
                      {{
                        qStats?.groups
                          ? '还有更多组没列出来时，点上面的「显示更多」继续。'
                          : '队列不是缓存表，而是实时从订单里聚出来的：在「发货台」导入订单后，出现过的「店铺 × 商品ID」会在这里等着确认。'
                      }}
                    </p>
                    <div v-if="!qStats?.groups" class="wb-empty__actions">
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
          <table class="wb-table gd-mapped" data-act="mapped-table">
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
                :title="`更新：${r.updatedAt}`"
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
import { computed, watch } from 'vue';
import { useSkuPool, SKU_STATUS_LABEL as STATUS_LABEL, SKU_STATUS_CLASS as STATUS_CLASS, SKU_SOURCE_LABEL as SOURCE_LABEL } from '../useSkuPool';
import ProductPicker from './ProductPicker.vue';
import PoolMetrics from './PoolMetrics.vue';
import CompareModal from './CompareModal.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import type { GoodsTabId } from '../tabs';
import { GOODS_TAB_REGISTRY } from '../tabs';
import { goodsSimple } from '../simple';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉 */
  refreshNonce: number;
  /** 左栏「当前款」（用户展开的那一行）；`null` = 没选款 ⇒ 不给直连入口 */
  product: { id: number; code: string; name: string } | null;
  /**
   * 请求切到本页另一个页签 —— 「店铺登记」那一支。
   *
   * 为什么右栏需要它：队列里"店铺未归一"的行**不能**写映射（订单里没有平台字段），
   * 而它们的出口（登记店铺）在另一个页签上。只给一句文字就等于让用户自己去猜在哪 ——
   * 2026-10-08 真机走查实测：那句文字在全新安装上指着一个**根本没装的目的地**（D1 死锁）。
   * 现在「店铺登记」已收进内建（见 `ShopRegistryView.vue`），这里把它变成一次点击。
   */
  navigate: (tab: GoodsTabId) => void;
  /**
   * 左栏展开区那个「认到本款」按钮发来的信号（自增 nonce，同 `refreshNonce` 的写法）。
   *
   * 为什么是"信号"而不是"回调"：真正写库的路径只有右栏这一条 `commitMap`（单事务、
   * 行级失败回传、写完重拉队列）。左栏没有队列数据、也不该有第二套失败语义 ——
   * 它只能说"用户想认款"，由本栏决定认哪些、怎么认。
   */
  relateNonce: number;
}>();

const emit = defineEmits<{
  /**
   * 右栏**已勾选**的待关联商品数 —— 报给外壳转手给左栏（左栏要靠它决定「认到本款」亮不亮）。
   * 只报一个数字：勾选状态本身不出这个组件（谁都不该在别处重建一份）。
   */
  'selection-changed': [count: number];
  /**
   * 队列聚合出的**组数**报给外壳（`null` = 队列还没拉过）。
   *
   * 报的是原始数字而不是"该不该显示引导卡"的布尔：判据只写一遍（`../firstRun.ts`），
   * 外壳只做原样转手、不推导。`null` 与 `0` 必须分得开 —— 见 `firstRun.ts` 顶部那段：
   * 把"还没拉过"当成"没有待办"，界面就会说出一个它不知道的结论。
   */
  'queue-groups': [groups: number | null];
}>();

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
  currentProduct,
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
  relateToSelected,
  confirmCompare,
  applyPick,
  confirmInvalidate,
  restore,
} = useSkuPool({
  refresh: () => props.refreshNonce,
  selectedProduct: () => props.product,
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
 * 勾选数上报（→ 外壳 → 左栏展开区那个「认到本款」按钮的亮/灭）。
 *
 * 只报一个数字：勾选状态本身住在 `useSkuPool` 里，谁都不该在别处重建一份。
 * `immediate` 是必须的 —— 初次挂载时如果已经有勾选（例如刷新后保留了选择），
 * 左栏那个按钮必须一上来就是亮的，不能等用户再点一次才同步。
 */
watch(() => selectedUnmapped.value.length, (n) => emit('selection-changed', n), { immediate: true });

/**
 * 左栏展开区的「认到本款」按下来 ⇒ 走本栏**同一条**写路径（`relateToSelected`，
 * 内部再落 `commitMap`：单事务、行级失败回传、写完重拉队列）。
 *
 * 为什么不直接在左栏调 `relateToSelected`：它依赖的 `selectedUnmapped` / `currentProduct`
 * 都住在本栏，左栏拿不到也不该拿到；信号式（nonce 自增）与 `refreshNonce` 同一写法。
 */
watch(() => props.relateNonce, () => void relateToSelected());

/** 组数往上报（→ 外壳 → 首次动线的判据）。`null` = 队列还没拉过，**不是 0**（见 `firstRun.ts`）。 */
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
  gap: 6px;
  flex-shrink: 0;
}
.gd-hints :deep(p) {
  margin: 0;
}
/* 「N 家店铺还没登记」这条：文字与按钮**同一行**（按钮是这个出口的全部价值，
   挤到第二行就跟一句纯文本没区别了）。窄栏下按钮换行也无妨 —— 关键是它可点、不是装饰。 */
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
.gd-queue .wb-thumb {
  width: 52px;
  height: 52px;
}
/* 商品ID 格：第一行是 ID 本身，第二行是折进来的店铺 / 平台 / 卖出笔数 / 疑似店铺。
   ⚠️ 两行都**允许换行**（`.wb-table td` 全局是 nowrap）：固定布局下格子宽度是死的，
   折进来的信息若靠省略号裁掉，就等于"界面上看不见、DOM 里却有" —— 正是本轮要消掉的那类错觉。 */
.gd-queue td.gd-c-item,
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
</style>
