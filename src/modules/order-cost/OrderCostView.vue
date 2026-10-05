<template>
  <div class="wb-page oc-view" :class="{ 'is-embedded': embedded }">
    <!-- 页头：原先整页没有标题，第一行就是四个统计数字 —— 用户不知道这页在算什么。
         `embedded` 时只藏**标题那两行**（外层页签已经交代了），
         ⚠️ **不能整块藏掉**：未归属 / 刷新 / 更多 三个动作都在这个 header 里（同拣货页的教训）。 -->
    <header class="wb-head" :class="{ 'is-toolbar': embedded }">
      <div v-if="!embedded" class="wb-head__main">
        <h1 class="wb-head__title">算钱</h1>
        <p class="wb-head__desc">
          按订单行算收入、运费、成本与毛利；缺哪一环逐行标出（缺的不按 0 算）
        </p>
      </div>
      <div class="wb-head__actions">
        <!-- 「未归属」原来是 <span>：看着像一条待处理提示，点了没反应；而真正的动作
             （选店铺 → 归到该店）藏在「更多」里 —— 用户看见问题却找不到路。
             现在它是一个按钮：点了自动展开「更多」并把店铺下拉聚焦。 -->
        <button
          v-if="unassignedCount"
          class="wb-btn wb-btn--sm wb-btn--warn oc-btn"
          type="button"
          data-act="unassigned-hint"
          title="这些行还没归属店铺（订单报表里没有店铺列，只能在这里人工指定）"
          @click="openMore('shop')"
        >
          未归属 {{ unassignedCount }} 单 · 去归属
        </button>
        <button class="wb-btn oc-btn" data-act="refresh" :disabled="loading" @click="load">
          刷新
        </button>
        <button
          class="wb-btn oc-btn"
          data-act="more"
          :class="{ 'is-on': showMore }"
          title="平台费率 · 店铺归属 · 结算明细导入 · 取数行数"
          @click="showMore = !showMore"
        >
          {{ showMore ? '收起' : '费率与归属' }}
        </button>
      </div>
    </header>

    <!-- 概览卡：**一行结论 + 一行体检**。
         原先「指标条 / 口径条 / 经营状态 / 缺哪一环」是 4 条各自带边框的全宽横条，
         底色还三套（surface / surface-2 交替），可它们都是"一眼扫过"的同级信息 ——
         4 层同权重的东西摞在表格之上，读的人分不出主次，这才是"杂乱"的来源。
         现在归成一张卡：第一行是数字，第二行是这批数据的体检结果。
         ⚠️ `.oc-topbar` 类名与各 `data-act="metric-*"` 锚点仍被冒烟断言（按锚点取元素，
         不按整串拼）——可以加格、可以改标签文案，不能把"标签 <b>数字</b>"拆成兄弟元素。 -->
    <div class="oc-overview">
      <div class="wb-metabar oc-topbar">
        <span class="wb-metric" data-act="metric-rows"
          >订单行 <b>{{ summary.total }}</b></span
        >
        <span
          class="wb-metric"
          data-act="metric-complete"
          :class="{ 'is-warn': summary.ok < summary.total }"
          >各环齐全 <b>{{ summary.ok }}</b></span
        >
        <span class="wb-metric" data-act="metric-revenue"
          >收入合计 <b>{{ money(summary.revenueTotal) }}</b></span
        >
        <!-- 成本合计与毛利并排，口径必须一致（都只含非关闭单）—— 否则"成本比收入还大"没法解释。
             见 src/lib/orderCost.ts 的 OrderCostSummary 注释。 -->
        <span class="wb-metric" data-act="metric-cost"
          >成本合计 <b>{{ money(summary.costTotal) }}</b></span
        >
        <span class="wb-metric" data-act="metric-gross"
          >毛利合计 <b>{{ money(summary.grossTotal) }}</b></span
        >
        <span class="wb-metric" data-act="metric-margin" :title="marginTitle"
          >毛利率 <b>{{ marginText }}</b></span
        >
      </div>

      <!-- 体检行：只在数据到位时出现（加载中不摆一排 0 出来） -->
      <div v-if="!loading && !error" class="oc-health">
        <div class="oc-gaps">
          <span class="oc-gaps__title">缺哪一环：</span>
          <!-- 这一行的目的就是"哪里缺"，所以**只在缺的时候列出来**。
               原来无论 0 都渲染 8 个「缺X 0」：数据齐全时用户得逐个读完才知道"都齐了" ——
               全 0 的正确表达是一句话，不是 8 个零。 -->
          <template v-if="activeGaps.length">
            <span
              v-for="g in activeGaps"
              :key="g.key"
              class="wb-tag oc-tag is-warn"
              :data-act="`gap-${g.key}`"
            >
              {{ g.label }} {{ g.count }}
            </span>
          </template>
          <!-- 「没有缺项」是**对整行**下的断言，所以必须整行真的都没有才能显示：
               平台费未配也是这一行里的一项（它虽是**全局标志**、不做成逐行缺口，见 orderCost.ts），
               若在它亮着的时候还说"没有缺项"，读起来就是"什么都不缺，但这个缺着"。 -->
          <span
            v-else-if="!summary.platformFeeMissing"
            class="wb-tag oc-tag is-on"
            data-act="gaps-none"
            >没有缺项</span
          >
          <!-- 平台费等于是"算钱的基准数据"，和成本/汇率同类；提示直接做成入口 ——
               否则用户看到"平台费未扣"也不知道去哪儿配。 -->
          <button
            v-if="summary.platformFeeMissing"
            class="wb-btn wb-btn--sm wb-btn--warn oc-btn"
            type="button"
            data-act="fee-missing"
            title="平台费（佣金 / 交易服务费）没有数据源，只能用近似费率估 —— 点这里去配"
            @click="openMore('rate')"
          >
            平台费未扣 · 去配费率
          </button>
          <span v-if="summary.platformFeeMissing" class="oc-muted">
            在途单结算前平台不给费用，只能估
          </span>
          <span v-else class="wb-tag oc-tag is-on">
            平台费按 {{ feeRatePercent }}% 近似（结算后以真值替换）
          </span>
          <span v-if="multiPieceRows" class="wb-tag oc-tag is-warn" data-act="multi-piece-hint">
            多件 {{ multiPieceRows }} 行 · 成本/运费仍按 1 件算（多件合并计费尚未支持）
          </span>
        </div>

        <div class="oc-buckets">
          <span class="oc-buckets__title">经营状态（利润合计只含非关闭单）：</span>
          <span v-for="b in summary.bucketTotals" :key="b.bucket" class="wb-tag oc-tag is-on">
            {{ bucketLabel(b.bucket) }} {{ b.rows }} 行 · 毛利 {{ money(b.gross) }}
          </span>
          <span v-if="preciseRows.length" class="wb-tag oc-tag is-on">
            精准 {{ preciseRows.length }} 行 · 毛利 {{ money(preciseGross) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 低频操作收进「费率与归属」：首屏只留要看的数字与主操作（原则：界面精简、聚焦重点）。
         里面放的都是"算钱要用的基准参数"与批量动作 —— 按钮名直接写出来，别再叫「更多」
         （「更多」等于没说：用户得先点开才知道值不值得点）。 -->
    <div v-if="showMore" class="oc-more">
      <div class="oc-actions">
        <label class="oc-rate">
          平台费
          <input
            ref="rateInputRef"
            v-model.number="feeRatePercent"
            class="wb-input wb-input--sm oc-rate__input"
            type="number"
            min="0"
            max="50"
            step="0.1"
            :disabled="loading"
            title="平台费（佣金+交易服务费…）近似费率；实测参考 9.14%（剔除全额退款后 277 行）"
            @change="onRateChange"
          />
          %
        </label>
        <select v-model.number="limit" class="wb-input wb-input--sm" :disabled="loading">
          <option :value="100">最近 100 行</option>
          <option :value="500">最近 500 行</option>
          <option :value="1000">最近 1000 行</option>
        </select>
        <select
          ref="shopSelRef"
          v-model="shopPick"
          class="wb-input wb-input--sm"
          data-act="shop-pick"
          aria-label="把订单归到哪个店铺"
          :disabled="loading || assigning"
          @change="onShopPickChange"
        >
          <option value="">{{ shops.length ? '选择店铺…' : '（店铺清单为空）' }}</option>
          <option v-for="s in shops" :key="s" :value="s">{{ s }}</option>
        </select>
        <button
          class="wb-btn oc-btn"
          data-act="assign-shop"
          :disabled="loading || assigning || !shopPick"
          @click="assignShop"
        >
          归到该店
        </button>
        <span class="oc-muted" data-act="assign-scope">
          会改写<b>当前列表里全部 {{ orderNoCount }} 个订单号</b>的店铺（不只是未归属的那几单）
        </span>
        <button
          class="wb-btn oc-btn"
          data-act="import-settle"
          :disabled="loading || importing"
          @click="importSettle"
        >
          {{ importing ? '导入中…' : '导入结算明细' }}
        </button>
      </div>
    </div>

    <!-- 数据来源与税口径：**写在首屏**（C1 后两条摄取通道在同一页；口径看不见用户就会怀疑数字） -->
    <div class="oc-scope">
      <span class="oc-scope__title">数据来源</span>
      <select
        v-model="sourceFilter"
        class="wb-input wb-input--sm"
        data-act="source"
        aria-label="只算哪个来源的订单行"
        @change="onFilterChange"
      >
        <option value="all">全部（采集 + 导入）</option>
        <option value="collect">仅采集</option>
        <option value="import">仅导入</option>
      </select>
      <span class="wb-tag oc-tag" data-act="source-count"
        >采集 {{ summary.sourceCounts.collect }} 行</span
      >
      <span class="wb-tag oc-tag" data-act="source-count"
        >导入 {{ summary.sourceCounts.import }} 行</span
      >

      <span class="oc-scope__title">税口径</span>
      <select
        v-model="taxDefault"
        class="wb-input wb-input--sm"
        data-act="tax-default"
        aria-label="订单自己没说税时按哪种口径算"
        @change="onFilterChange"
      >
        <option value="platform">平台代征代缴（默认，税记 0）</option>
        <option value="unknown">不知道（标缺口、不按 0 算）</option>
      </select>
      <span class="oc-muted">只作用于订单自己没写税的行</span>
    </div>

    <div v-if="loading" class="oc-hint">读取中…</div>
    <div v-else-if="error" class="oc-error">{{ error }}</div>

    <div v-else class="oc-body">
      <!-- 分组统计：**一个面板，两个互斥视图**。
           原先「按维度汇总」和「时间趋势」各占一个面板：两张表列几乎一样、各带一行表头、
           还各自重复写一遍「只含非关闭单」—— 同一份数据被讲了两遍，看上去就是"两坨"。
           切视图用分段控件（.wb-seg，与货与成本同一套）。
           ⚠️ 两个 select 与两张表都用 `v-show` 而不是 `v-if`：冒烟会直接 set value 触发 change
           （`[data-act="dim"]` / `[data-act="trend-gran"]`），元素不能随分段被摘掉。 -->
      <section class="wb-panel oc-stats">
        <div class="wb-panel__head oc-stats__head">
          <div class="wb-seg" role="tablist" aria-label="分组统计视图">
            <button
              class="wb-seg__item"
              :class="{ 'is-on': statView === 'summary' }"
              type="button"
              role="tab"
              :aria-selected="statView === 'summary'"
              data-act="stat-view-summary"
              @click="statView = 'summary'"
            >
              汇总
            </button>
            <button
              class="wb-seg__item"
              :class="{ 'is-on': statView === 'trend' }"
              type="button"
              role="tab"
              :aria-selected="statView === 'trend'"
              data-act="stat-view-trend"
              @click="statView = 'trend'"
            >
              趋势
            </button>
          </div>
          <select
            v-show="statView === 'summary'"
            v-model="dim"
            class="wb-input wb-input--sm oc-stats__dim"
            data-act="dim"
            aria-label="按什么维度汇总"
          >
            <option value="style">按款</option>
            <option value="country">按目的国</option>
            <option value="shop">按店铺</option>
            <option value="sku">按 SKU（款×色×码）</option>
            <option value="supplier">按供应商</option>
            <option value="bucket">按经营状态</option>
          </select>
          <select
            v-show="statView === 'trend'"
            v-model="trendGran"
            class="wb-input wb-input--sm oc-stats__dim"
            data-act="trend-gran"
            aria-label="时间趋势按什么粒度汇总"
          >
            <option value="month">按月</option>
            <option value="day">按日</option>
          </select>
          <span class="oc-muted">只含非关闭单</span>
        </div>

        <div v-show="statView === 'summary'" class="wb-table-wrap" data-act="stat-summary">
          <table v-if="groups.length" class="wb-table oc-table oc-table--stats">
            <thead>
              <tr>
                <th>{{ dimLabel }}</th>
                <th class="wb-num">行数</th>
                <th class="wb-num">件数</th>
                <th class="wb-num">收入</th>
                <th class="wb-num">成本</th>
                <th class="wb-num">预测毛利</th>
                <th class="wb-num">精准毛利</th>
                <th class="wb-num">缺</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in groups" :key="g.key">
                <td class="oc-mono">{{ groupLabel(g) }}</td>
                <td class="wb-num">{{ g.rows }}</td>
                <td class="wb-num">{{ g.pieces }}</td>
                <td class="wb-num">{{ money(g.revenue) }}</td>
                <td class="wb-num">{{ money(g.cost) }}</td>
                <td class="wb-num oc-total" :class="profitClass(g.gross)">{{ money(g.gross) }}</td>
                <td class="wb-num" :class="{ 'oc-muted': !g.preciseRows }">
                  {{ preciseCell(g.preciseRows, g.preciseGross) }}
                </td>
                <td class="wb-num" :class="{ 'oc-muted': !g.gapRows }">{{ g.gapRows || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="oc-hint">暂无数据</p>
        </div>

        <!-- 趋势表用独立 class：与统计表共用 `oc-table--stats` 会让"统计区几行"这类断言同时命中两张表 -->
        <div v-show="statView === 'trend'" class="wb-table-wrap" data-act="stat-trend">
          <table
            v-if="trend.length"
            class="wb-table oc-table oc-table--trend"
            data-act="trend-table"
          >
            <thead>
              <tr>
                <th>{{ trendGran === 'day' ? '日期' : '月份' }}</th>
                <th class="wb-num">行数</th>
                <th class="wb-num">收入</th>
                <th class="wb-num">成本</th>
                <th class="wb-num">预测毛利</th>
                <th class="wb-num">精准毛利</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in trend" :key="t.bucket">
                <td class="oc-mono">{{ t.bucket }}</td>
                <td class="wb-num">{{ t.rows }}</td>
                <td class="wb-num">{{ money(t.revenue) }}</td>
                <td class="wb-num">{{ money(t.cost) }}</td>
                <td class="wb-num oc-total" :class="profitClass(t.gross)">{{ money(t.gross) }}</td>
                <td class="wb-num" :class="{ 'oc-muted': !t.preciseRows }">
                  {{ preciseCell(t.preciseRows, t.preciseGross) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="oc-hint">暂无数据</p>
        </div>
      </section>

      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>订单行明细</span>
          <span class="wb-muted">{{ summary.rows.length }} 行</span>
        </div>
        <!-- ⚠️ 必须套 .wb-table-wrap：这张表 14 列，窄窗口下比可用宽度更宽，
             而 .wb-panel 是 overflow:hidden —— 直接放进去会被**静默裁掉右半截**
             （列既看不见也没有滚动条）。首列与表头 sticky，横滚时仍知道"这行是谁"。 -->
        <div class="wb-table-wrap">
          <table class="wb-table oc-table" data-act="detail-table">
            <thead>
              <tr>
                <!-- 单号 / 店铺 / 经营状态 合成一列：三样都是"这一行是谁"。
                     原先各占一列（店铺 44px、状态 59px 全是短标签），把表格撑到一屏放不下。 -->
                <th title="单号 · 店铺（未归属的会标出来）· 经营状态">订单</th>
                <th title="这条订单行来自采集还是导入">来源</th>
                <th>款 / 色</th>
                <th>商品ID</th>
                <th class="wb-num">件数</th>
                <th>国家</th>
                <th class="wb-num">克重</th>
                <th class="wb-num">运费</th>
                <!-- 列头从「成本」改成「产品成本」：与「按维度汇总」的「成本」区分开 ——
                     那张表的成本是 **运费 + 产品成本**。两边都叫「成本」而口径不同，
                     对照两张表会以为明细少算了运费（30.00）。 -->
                <th class="wb-num" title="产品成本（不含运费）">产品成本</th>
                <th class="wb-num">税</th>
                <!-- 平台费此前**有数据无列**：毛利 = 收入 − 运费 − 产品成本 − 税 − 平台费，
                     少了这一列，配好费率后毛利对不上账而差额无处解释。 -->
                <th class="wb-num" title="平台费（佣金 + 交易服务费）近似：收入 × 费率；未配费率时为「—」">
                  平台费
                </th>
                <th class="wb-num">收入</th>
                <!-- 「毛利依据」不再单占一列（那列只有「预测/精准」两个值）：
                     标签直接跟在毛利后面，见下方 td。表头仍带口径说明。 -->
                <th
                  class="wb-num"
                  title="毛利 = 收入 − 运费 − 产品成本 − 税 − 平台费。标签说明这一行用的是哪一轨：预测（该单还没结算）= 上式；精准（有平台结算数据）= 平台结算净收入 − 成本 − 运费"
                >
                  毛利
                </th>
                <th>缺</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in summary.rows"
                :key="r.id"
                :class="{ 'is-closed': r.bucket === 'closed' }"
              >
                <td class="oc-order">
                  <span class="oc-mono">{{ r.orderNo || '—' }}</span>
                  <span class="oc-order__sub">
                    <span :class="{ 'oc-muted': !r.shop }">{{ r.shop || '未归属' }}</span>
                    <span
                      v-if="r.bucket !== 'completed'"
                      class="oc-order__bucket"
                      :class="{ 'is-closed': r.bucket === 'closed' }"
                      >{{ bucketLabel(r.bucket) }}</span
                    >
                  </span>
                </td>
                <td>
                  <!-- 去掉 wb-tag 药丸：只有两个取值，药丸的边框/内边距白占 20px 宽度。
                       文案仍是「采集」/「导入」（冒烟按这两个词断言，别缩成单字）。 -->
                  <span
                    class="oc-src"
                    :class="{ 'is-collect': r.source === 'collect' }"
                    data-act="row-source"
                  >
                    {{ r.source === 'collect' ? '采集' : '导入' }}
                  </span>
                </td>
                <td>
                  <span class="oc-mono">{{ r.styleCode || '—' }}</span>
                  <span v-if="r.styleColor" class="oc-muted"> / {{ r.styleColor }}</span>
                </td>
                <td class="oc-mono">{{ r.itemId || '—' }}</td>
                <td
                  class="wb-num"
                  data-act="qty"
                  :class="{ 'oc-muted': r.qtySource === 'assumed' }"
                  :title="qtyTitle(r.qtySource)"
                >
                  {{ r.qty }}
                </td>
                <td :class="{ 'oc-muted': !r.country }">{{ r.country || '—' }}</td>
                <td class="wb-num" data-act="weight" :title="weightTitle(r)">
                  {{ r.weightG === null ? '—' : r.weightG }}
                </td>
                <td
                  class="wb-num"
                  data-act="shipping"
                  :class="{ 'oc-muted': r.shipping === null }"
                  :title="r.rateVersion ? `按运价表 ${r.rateVersion}` : '按当前那份运价表'"
                >
                  {{ money(r.shipping) }}
                </td>
                <td class="wb-num" data-act="product-cost" :class="{ 'oc-muted': r.productCost === null }">
                  {{ money(r.productCost) }}
                </td>
                <td class="wb-num" data-act="tax" :class="{ 'oc-muted': r.taxCost === null }">
                  {{ money(r.taxCost) }}
                </td>
                <td
                  class="wb-num"
                  data-act="platform-fee"
                  :class="{ 'oc-muted': r.platformFee === null }"
                  :title="
                    r.platformFee === null
                      ? '未配平台费率 → 这笔费用没扣，毛利会偏高（上方缺口行已在提示）'
                      : `收入 ${money(r.revenue)} × ${feeRatePercent}%`
                  "
                >
                  {{ money(r.platformFee) }}
                </td>
                <td class="wb-num" data-act="revenue" :class="{ 'oc-muted': r.revenue === null }">
                  {{ money(r.revenue) }}
                </td>
                <td
                  class="wb-num oc-total"
                  data-act="gross"
                  :class="profitClass(r.tier === 'precise' ? r.preciseGrossProfit : r.grossProfit)"
                >
                  <span class="oc-gross">
                    <span>{{
                      money(r.tier === 'precise' ? r.preciseGrossProfit : r.grossProfit)
                    }}</span>
                    <!-- 原「毛利依据」列（只有预测/精准两个值）收敛成一个贴标签，
                         悬停才展开口径说明 —— 单独占一列不值当。 -->
                    <span
                      class="wb-tag oc-tag oc-tier"
                      data-act="gross-tier"
                      :class="r.tier === 'precise' ? 'is-on' : ''"
                      :title="profitTitle(r)"
                    >
                      {{ r.tier === 'precise' ? '精准' : '预测' }}
                    </span>
                  </span>
                </td>
                <td>
                  <span v-if="!r.gaps.length" class="oc-ok">齐</span>
                  <span v-else class="wb-tag oc-tag is-warn">{{ gapText(r.gaps) }}</span>
                </td>
              </tr>
              <tr v-if="!summary.rows.length">
                <!-- colspan 必须等于**表头列数**（14）：写少了空态那一行会短一列、
                   右侧留出一条空白 —— 空表时最容易看出来 -->
                <td colspan="14" class="oc-empty">
                  <span class="wb-empty__icon" v-html="EMPTY_ICON"></span>
                  <p class="oc-empty__title">还没有订单行</p>
                  <p class="oc-empty__desc">
                    在「今天」页点「导入
                    Excel」选一份订单报表即可（宿主自己会拆行入库，不需要装插件）， 再回来点「刷新」。
                  </p>
                  <div class="wb-empty__actions">
                    <button
                      class="wb-btn wb-btn--primary"
                      data-act="empty-import"
                      @click="goImport"
                    >
                      去「今天」导入
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- 数据基础（成本与汇率）：默认收起；有"缺成本"的行时自动展开 —— 缺的就是这里能补的 -->
    <CostRatesSection :attention="summary.gapCounts.cost > 0" :refresh-key="costRatesKey" />
  </div>
</template>

<script setup lang="ts">
// 「算钱」视图（id 仍为 order-cost）：取数 → 纯计算层算 → 渲染。
// 两条摄取通道（采集 / 导入）在同一张表里，按「来源」列与顶部计数区分。
//
// 口径（用户 2026-09-29 裁定，别改）：
//   · 这是**预测**工具 —— 在途单要算（不是只算已结算）；精准值留给将来接结算数据的那一轨。
//   · 关闭单**单列一桶、不进利润合计**（真实报表实测 54% 是关闭单，混进来整体虚高）。
//   · 平台代征代缴 → 增值税不是我们的成本（确定的 0）；不知道谁承担 → 标缺、**不按 0 算**。
//   · 平台费（佣金/手续费）暂无数据源 → 全局提示"未扣"，**不按 0 算**。
//   · 任一环缺 → 毛利为 `null` 并逐行标出来（0 与"不知道"必须分开）。
//   · 件数是**拣货口径**：结算商品行真值 → 订单报表块内 `商品数量` → 按 1 件并标「缺件数」；
//     它**不参与**成本/运费算术（多件合并计费是运价岛的开放项）—— 有件数 > 1 的行时界面显式提示。
//
// 四路取数（全部经 core 服务，视图内零算术）：
//   1. 订单行（含店铺/时点/款编码 + 金额/状态/时点列）→ `orderShippingRows`
//   2. 克重（批量，一次调用）                        → `loadSkuWeights()`（SKU 级，`pl_variants.weight_g`）
//      ⚠️ 2026-10-01 起克重**只**来自 SKU：原「商品ID → 克重」那条链（`productWeightGet` +
//      `pl_item_weights`）已随领域裁定整条删除（克重是一款的属性，不是某个商品的属性）。
//   3. 款级成本（含生效区间）                        → `aeCostMapList`（分 → 元）
//   4. 运价表：宿主快照（`shipRateSnapshotCalc`，按订单日期取"当时那份"）；
//      一条快照都没有时才回落岛存储的"当前那份"（`useModuleStorage('shipping-rate')`）
//
// ⚠️ 第 4 路的「岛存储回落」是**一个版本期的读回退**（M6 运价表回迁，2026-09-30）：
//    真源已归宿主 `sr_rate_snapshots`（岛只显示、不再存也不回传）；宿主快照表是空的**只可能是**
//    "老库 + 还没打开过「无忧物流运费」"—— 该岛首次打开会把旧表一次性迁上来（`rateAdopt`）。
//    等所有用户都迁过一轮，这一路回落连同 `useModuleStorage('shipping-rate')` 一起删掉。
//    在那之前**不要**在宿主再存一份 —— 两份真相必然漂移。另外：报价单会更新，要"按历史复算"
//    就得给它加生效区间（同 `ae_cost_map` 的做法）。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { selectExcelFile } from '@/core/services/dialog';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { loadSkuWeights } from '@/core/services/skuWeights';
import * as ipc from '@/core/services/ipc';
import type { UnifiedOrderRow } from '@/types';
import {
  collectItemIds,
  skuWeightKey,
  computeOrderCosts,
  settleQtyKey,
  summarizeOrderCosts,
  trendOf,
  type BizBucket,
  type CostGroupDim,
  type CostInterval,
  type OrderCostGap,
  type QtySource,
  type RateSnapshot,
  type SettleQtyInfo,
} from '@/lib/orderCost';
import { importSettle as runSettleImport } from '@/core/services/importSheet';
import CostRatesSection from './components/CostRatesSection.vue';
import type { RateTable } from '@/lib/shipRate';

/**
 * `embedded` = 被「今天」页的页签内嵌（藏掉本页自己的页头，避免双层标题）。
 * `refreshToken` = 宿主的数据版本号：订单/成本一变，`today` 那边 +1 ⇒ 本页重算。
 *   页签是 `KeepAlive` 保活的，没有它就会一直显示"导入之前"那份利润 —— 保活的代价必须还回去。
 */
const props = withDefaults(
  defineProps<{ embedded?: boolean; refreshToken?: number }>(),
  { embedded: false, refreshToken: 0 }
);

/** 内嵌时"去导订单"交给外层页签系统（本组件不认识页签，只发意图） */
const emit = defineEmits<{ (e: 'go-import'): void }>();

/** 「数据基础：成本与汇率」区的重取信号（主刷新时 +1） */
const costRatesKey = ref(0);

/** 明细表空态图标（内联 SVG，跟随 currentColor） */
const EMPTY_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5C4 5.1 7.6 4 12 4s8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5z"/><path d="M4 6.5v11C4 18.9 7.6 20 12 20s8-1.1 8-2.5v-11"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/></svg>';

const limit = ref(500);
const loading = ref(false);
const importing = ref(false);
const error = ref('');
/** 平台费近似费率（%）；持久化在 `order-cost` 命名空间（**不配就不扣，见 summary.platformFeeMissing**） */
const feeRatePercent = ref(0);
/** 上一次取到的四路输入：改费率时**复用它们重算**，不必再打三次 IPC */
const inputs = ref<Parameters<typeof computeOrderCosts>[0] | null>(null);
const summary = ref(computeOrderCosts({ orders: [], rateTable: null, costs: [] }));

const GAPS: { key: OrderCostGap; label: string }[] = [
  { key: 'revenue', label: '缺收入' },
  { key: 'country', label: '缺国家' },
  { key: 'weight', label: '缺克重' },
  { key: 'rate', label: '缺运价表' },
  { key: 'style', label: '未识别款' },
  { key: 'cost', label: '缺成本' },
  { key: 'tax', label: '税未知' },
  { key: 'qty', label: '缺件数' },
];
const gapList = ref(GAPS.map((g) => ({ ...g, count: 0 })));

/**
 * 只列**真的缺**的那些环。
 * 全 0 时界面上收敛成一句「没有缺项」—— 数据齐全还罗列 8 个「缺X 0」，
 * 用户得逐个读完才知道"都齐了"；这一行的目的本来就是"哪里缺"。
 */
const activeGaps = computed(() => gapList.value.filter((g) => g.count > 0));

const BUCKET_LABELS: Record<BizBucket, string> = {
  completed: '已完成',
  intransit: '在途',
  closed: '已关闭',
  unknown: '状态未知',
};

function bucketLabel(b: BizBucket): string {
  return BUCKET_LABELS[b] ?? b;
}

function money(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

/** 毛利为负标红（色值走令牌，不写死） */
function profitClass(n: number | null): string {
  return n !== null && n < 0 ? 'is-loss' : '';
}

function gapText(gaps: OrderCostGap[]): string {
  const map = new Map(GAPS.map((g) => [g.key, g.label]));
  return gaps.map((g) => map.get(g) ?? g).join(' · ');
}

/** 件数单元格的悬停说明：把"这个数是真值还是兜底"写在行上（不静默） */
const QTY_TITLES: Record<QtySource, string> = {
  settle: '件数来自结算明细的商品行（平台真值）',
  order: '件数来自订单侧真值（报表「商品信息」块的 商品数量 / 采集行数量）',
  assumed: '结算与订单侧都取不到件数 → 按 1 件（已在「缺」列标出）',
};

function qtyTitle(source: QtySource): string {
  return QTY_TITLES[source] ?? source;
}

/** 克重单元格的悬停说明：克重只有一个来源（产品库 SKU 表），把"按哪一行 SKU 取的"说清楚 */
function weightTitle(r: { weightG: number | null; weightSource: 'item' | 'sku' | null }): string {
  if (r.weightG === null) {
    return '没查到克重：这一行没识别出款/色/码，或该 SKU 在「货与成本」里没维护克重';
  }
  return '克重按款 × 色 × 码取自产品库 SKU（在「货与成本」维护）';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // **一个读口**：主干 `oi_orders` 的投影（`source` 由宿主标好，页面不再自己打标签）
    const ord = await ipc.orderShippingRows({ limit: limit.value });
    if (!ord.success || !ord.data) throw new Error(ord.error || '读取订单失败');
    const orders: UnifiedOrderRow[] = ord.data;

    // 克重只有一个来源：产品库 SKU 表（款×色×码）—— 取数口在 `core/services/skuWeights`（三处共用一份）
    const skuWeights = await loadSkuWeights();

    const c = await ipc.aeCostMapList();
    if (!c.success) throw new Error(c.error || '读取成本失败');
    const costs: CostInterval[] = (c.data ?? []).map((x) => ({
      styleCode: String(x.styleCode ?? ''),
      effectiveFrom: String(x.effectiveFrom ?? ''),
      unitPrice: (Number(x.unitPriceCents) || 0) / 100,
      source: String(x.source ?? ''),
    }));

    // 运价表：宿主快照（按订单日期取"当时那份"，历史可复算）；
    // 一条快照都没有时才回落到岛存储里的"当前那份" —— 一个版本期的读回退，
    // 仅覆盖"老库且还没打开过「无忧物流运费」"（该岛首次打开会一次性把旧表迁到宿主）。
    const snap = await ipc.shipRateSnapshotCalc({ limit: 50 });
    const rateSnapshots: RateSnapshot[] = (snap.success ? (snap.data?.rows ?? []) : [])
      .filter((r) => r.table)
      .map((r) => ({ effectiveFrom: String(r.effectiveFrom ?? ''), table: r.table as RateTable }));

    const st = await useModuleStorage<{ table?: RateTable; rounding?: string }>(
      'shipping-rate'
    ).load();
    const rateTable = (st?.table as RateTable | undefined) ?? null;
    const rounding = st?.rounding === 'ceil' ? 'ceil' : 'round';

    // 订单行直接传：金额/状态/税承担方那几个字段与 `OrderCostInput` 同名
    // 结算数据（精准轨）：按可见订单号批量取一次（遣词注意：它按**订单级行**聚合，整单口径）
    // 顺带把**商品行件数**铺成查表（键口径由 `settleQtyKey` 提供，与算法层同一份）
    const orderNos = orders.map((o) => String(o.orderNo ?? '')).filter(Boolean);
    const settleByOrder: Record<string, { netIncomeCents: number; settleStatus?: string }> = {};
    const settleQty: Record<string, SettleQtyInfo> = {};
    if (orderNos.length) {
      const st2 = await ipc.settleOrders({ orderNos });
      if (st2.success) {
        for (const row of st2.data?.rows ?? []) {
          settleByOrder[row.orderNo] = {
            netIncomeCents: row.netIncomeCents,
            settleStatus: row.settleStatus,
          };
          for (const it of row.items ?? []) {
            settleQty[settleQtyKey(row.orderNo, it.itemId)] = { lines: it.lines, qty: it.qty };
          }
        }
      }
    }

    inputs.value = {
      orders,
      skuWeights,
      rateTable,
      rateSnapshots,
      costs,
      rounding,
      settleByOrder,
      settleQty,
    };
    recompute();
    if (!rateSnapshots.length && !rateTable) {
      toast('还没读到运价表 —— 先去「无忧物流运费」导入一次报价单，运费才算得出来', 'info');
    }
    costRatesKey.value += 1; // 成本表可能刚被拿货对账改动，跟着主刷新一起重取
  } catch (e: unknown) {
    error.value = `读取失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

/** 统计维度与分组结果（口径见 `summarizeOrderCosts`：只含非关闭单，未识别/缺的各自成组） */
const dim = ref<CostGroupDim>('style');
/** 时间趋势粒度：数据跨月时看月、只有一个月时按日更细（默认月 ✓ 与岛上旧视图一致） */
const trendGran = ref<'month' | 'day'>('month');
/** 分组统计的两个互斥视图（原先各占一个面板，同一份数据被讲了两遍） */
const statView = ref<'summary' | 'trend'>('summary');

/**
 * 毛利率 = 毛利合计 ÷ 收入合计（**同口径**：两者都只含非关闭单）。
 * 显示成小数比——收入与毛利并排摆着却要用户自己除，是最常被问的一个数。
 * ⚠️ 未配平台费率时 `grossTotal` 还没扣平台费，这个百分比会**偏高**；标题里写明。
 */
const marginText = computed(() => {
  const rev = summary.value.revenueTotal;
  if (!rev) return '—';
  return `${((summary.value.grossTotal / rev) * 100).toFixed(1)}%`;
});
const marginTitle = computed(() =>
  summary.value.platformFeeMissing
    ? '毛利合计 ÷ 收入合计。⚠️ 还没配平台费率 → 毛利未扣平台费，这个比率偏高'
    : '毛利合计 ÷ 收入合计（已扣平台费近似值）'
);
const groups = computed(() => summarizeOrderCosts(summary.value.rows, dim.value));
const trend = computed(() => trendOf(summary.value.rows, trendGran.value));
const dimLabel = computed(
  () =>
    ({
      style: '款编码',
      country: '目的国',
      shop: '店铺',
      sku: 'SKU（款 × 色 × 码）',
      supplier: '供应商',
      bucket: '经营状态',
    })[dim.value]
);

/** 店铺清单（店铺实体 sk_shops）：AE 导出**按店铺导出、报表无店铺列** → 店铺由人在这里指定 */
const shops = ref<string[]>([]);
const shopPick = ref('');
const assigning = ref(false);
/** 数据来源（C1 合并后两条摄取通道在同一页）：全部 / 仅采集 / 仅导入 */
const sourceFilter = ref<'all' | 'collect' | 'import'>('all');
/** 税口径的**可见默认**（只补"行自己没说"的：采集帧没有代征代缴列）—— 写在明处，缺省按平台代征代缴 */
const taxDefault = ref<'platform' | 'unknown'>('platform');
/** 低频操作（平台费率 / 店铺归属 / 结算导入 / 行数）默认收起 —— 首屏只留要看的数字与主操作 */
const showMore = ref(false);

/** 当前列表里**未归属店铺**的订单数（页头提示用：0 就不提示，免得白点） */
const unassignedCount = computed(() => summary.value.rows.filter((r) => !r.shop).length);

/** 「归到该店」的作用域：当前列表里的订单号个数（这个动作改的是**全部**，不只是未归属的） */
const orderNoCount = computed(
  () =>
    (inputs.value?.orders ?? []).map((o) => String(o.orderNo ?? '').trim()).filter(Boolean).length
);

/** 「费率与归属」区里被顶部提示唤出的两个控件（用于聚焦） */
const rateInputRef = ref<HTMLInputElement | null>(null);
const shopSelRef = ref<HTMLSelectElement | null>(null);

/**
 * 展开「费率与归属」并**聚焦到指定控件**。
 * 页头的「未归属 N 单」「平台费未扣」都是"看见问题但找不到动作"的入口 ——
 * 只把面板展开还不够，用户仍要在 5 个控件里自己找那个；直接聚焦省掉这一步。
 */
function openMore(focus: 'shop' | 'rate'): void {
  showMore.value = true;
  void nextTick(() => {
    const el = focus === 'shop' ? shopSelRef.value : rateInputRef.value;
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  });
}

/** 多件行（件数 > 1）：件数只用于拣货，成本/运费仍按 1 件计 —— 有这类行就把口径写在界面上 */
const multiPieceRows = computed(() => summary.value.rows.filter((r) => r.qty > 1).length);

/** 落盘这些页面偏好（费率 / 店铺 / 来源 / 税口径）—— 改动即存，别让用户每次重设 */
function savePrefs(): void {
  void useModuleStorage<{
    platformFeeRatePercent: number;
    shopPick: string;
    sourceFilter: string;
    taxDefault: string;
  }>('order-cost').scheduleSave({
    platformFeeRatePercent: feeRatePercent.value,
    shopPick: shopPick.value,
    sourceFilter: sourceFilter.value,
    taxDefault: taxDefault.value,
  });
}

/** 来源/税口径改动：立刻重算 + 落盘 */
function onFilterChange(): void {
  recompute();
  savePrefs();
}

/** 记住上次选的店铺（同一批导出通常连着导几次同一家店） */
function onShopPickChange(): void {
  void savePrefs();
}

/**
 * 分组行的展示名：桶名转中文；供应商维度用 `label`（key 是 id）；其余原样显示
 * —— 未识别/缺的原样露出，好一眼看出"这组是脏数据"。
 */
function groupLabel(g: { key: string; label?: string }): string {
  if (dim.value === 'bucket') return bucketLabel(g.key as BizBucket);
  return g.label ?? g.key;
}

/** 精准毛利单元格：有精准行就显示金额 +（行数），否则 — */
function preciseCell(rowCount: number, gross: number): string {
  return rowCount ? `${money(gross)}（${rowCount}）` : '—';
}

/** 已结算（精准轨）的行与其毛利合计 —— 从行里算，避免再往算法层加汇总字段 */
const preciseRows = computed(() => summary.value.rows.filter((r) => r.tier === 'precise'));
const preciseGross = computed(
  () =>
    Math.round(preciseRows.value.reduce((s, r) => s + (r.preciseGrossProfit ?? 0), 0) * 100) / 100
);

/** 毛利单元格的悬停说明：写清这一行用的是哪一轨、另一个轨的值是多少 */
function profitTitle(r: {
  tier: string;
  grossProfit: number | null;
  preciseGrossProfit: number | null;
}): string {
  if (r.tier === 'precise') {
    return `精准：净收入（平台结算，已扣平台费）− 成本 − 运费；预测值 ${money(r.grossProfit)}`;
  }
  return `预测：收入 − 成本 − 税 − 平台费（近似）；该单尚无结算数据`;
}

/** 用当前输入 + 当前费率/来源/税口径重算（不重新取数） */
function recompute(): void {
  const base = inputs.value;
  if (!base) return;
  const orders =
    sourceFilter.value === 'all'
      ? base.orders
      : base.orders.filter((o) => (o.source ?? 'import') === sourceFilter.value);
  summary.value = computeOrderCosts({
    ...base,
    orders,
    platformFeeRatePercent: feeRatePercent.value,
    taxDefault: taxDefault.value,
  });
  gapList.value = GAPS.map((g) => ({ ...g, count: summary.value.gapCounts[g.key] }));
}

/** 改费率：立即重算 + 防抖落盘（`order-cost` 命名空间） */
function onRateChange(): void {
  const n = Number(feeRatePercent.value);
  feeRatePercent.value = Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 0;
  recompute();
  void savePrefs();
}

/**
 * 把**当前列表里的订单**归到所选店铺（写 `oi_orders.shop` 原文）。
 * 用途：AE 的订单列表/明细导出是**按店铺导出**的，但报表里没有店铺列 → 导完指定一次即可。
 */
async function assignShop(): Promise<void> {
  const shopName = shopPick.value;
  const orderNos = (inputs.value?.orders ?? [])
    .map((o) => String(o.orderNo ?? '').trim())
    .filter(Boolean);
  if (!shopName || !orderNos.length) return;
  assigning.value = true;
  try {
    const r = await ipc.orderAssignShop({ orderNos, shopName });
    if (!r.success) throw new Error(r.error || '归属失败');
    toast(
      `已把 ${orderNos.length} 个订单号归到「${shopName}」（改动 ${r.data?.updated ?? 0} 行）`,
      'success'
    );
    await load();
  } catch (e: unknown) {
    const msg = `归属店铺失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  } finally {
    assigning.value = false;
  }
}

/** 导入结算明细（AE 后台「订单明细」导出）：选文件 → 解析（渲染层）→ 落库 → 重取 */
/** 空态里的下一步：切到「今天」（那儿有统一导入入口，也是"该干什么"的工作台） */
/** 空态里的下一步：去导订单。内嵌时发事件（`switchModule('today')` 等于跳到本页再跳回来） */
function goImport(): void {
  if (props.embedded) {
    emit('go-import');
    return;
  }
  switchModule('today');
}

async function importSettle(): Promise<void> {
  importing.value = true;
  error.value = '';
  try {
    const sel = await selectExcelFile();
    if (!sel?.filePath) return;
    // 解析 + 落库都在 `core/services/importSheet`（与首页的统一导入共用一份实现）
    const r = await runSettleImport({ data: sel.data, filePath: sel.filePath });
    toast(
      `结算明细已导入：新增 ${r.created} / 更新 ${r.updated}` +
        (r.issues ? `；${r.issues} 行有校验告警（差额，见控制台）` : ''),
      'success'
    );
    if (r.failed.length)
      toast(`${r.failed.length} 行落库失败：${r.failed[0]?.message ?? ''}`, 'error');
    await load();
  } catch (e: unknown) {
    const msg = `导入结算明细失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  } finally {
    importing.value = false;
  }
}

// 数据变了（导入了订单/结算明细、改了成本）→ 重算（本页本来就是"进页就算"，无需额外条件）
watch(
  () => props.refreshToken,
  () => void load()
);

onMounted(async () => {
  // 店铺清单（可选：读不到就只影响"归到该店"与店铺维度）
  try {
    await ipc.shopDbEnsure();
    const sl = await ipc.shopList({ status: 'active' });
    if (sl.success)
      shops.value = (sl.data?.rows ?? []).map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    /* 店铺域不可用不影响利润计算 */
  }
  // 先恢复上次设的费率，再取数（否则第一屏会用 0% 算一遍）
  try {
    const st = await useModuleStorage<{
      platformFeeRatePercent?: number;
      shopPick?: string;
      sourceFilter?: string;
      taxDefault?: string;
    }>('order-cost').load();
    const saved = Number(st?.platformFeeRatePercent);
    if (Number.isFinite(saved) && saved > 0) feeRatePercent.value = Math.min(saved, 50);
    if (typeof st?.shopPick === 'string') shopPick.value = st.shopPick;
    if (st?.sourceFilter === 'collect' || st?.sourceFilter === 'import')
      sourceFilter.value = st.sourceFilter;
    if (st?.taxDefault === 'unknown') taxDefault.value = 'unknown';
  } catch {
    /* 读不到就用 0（未配 → 不扣，有全局提示） */
  }
  void load();
});
</script>

<style scoped>
/* 页面外壳（栅格 / 内边距 / 滚动）由全局 .wb-page 提供。
   `.oc-topbar` 交给全局 .wb-metabar；`.oc-view` 类名保留（冒烟用它判"挂载成功"）。 */

/* 内嵌在「今天」页签里：顶上紧邻页签栏，把全局那 18px 顶部留白收一点
   （其余边距不动 —— 与独立打开时保持同一套栅格）。 */
.oc-view.is-embedded {
  padding-top: 12px;
}

/* 内嵌时页头只剩动作按钮 ⇒ 当工具栏用：靠左（不留 `margin-left:auto` 顶到右边）。 */
.oc-view.is-embedded .wb-head__actions {
  margin-left: 0;
}

/* 概览卡：**一行结论 + 一行体检**装进同一张卡。
   原先「指标条 / 分桶 / 缺口」是三条各自带边框的全宽横条、底色还两套，
   叠加「口径条」共 4 层同权重信息摞在表格之上 —— 这是"杂乱"的根源，不是信息太多。 */
.oc-overview {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}
.oc-overview .oc-topbar {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
/* 体检行：与指标行同卡、用一条淡分隔线分层（而不是再起一张卡） */
.oc-health {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  padding: 8px 14px 9px;
  border-top: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  border-radius: 0 0 calc(var(--wb-radius-md) - 1px) calc(var(--wb-radius-md) - 1px);
  font-size: 13px;
}
/* 分桶 / 缺口 在卡片里退成"一行内容"，不再各自带边框当卡片 */
.oc-health .oc-buckets,
.oc-health .oc-gaps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

/* 口径条：数据来源 / 税口径。装进白卡 —— 原先是一条横贯整屏的浅灰带，
   与上下两条同类带子（分桶 / 缺口）挤在一起，三层同级信息看起来像同一件事。 */
.oc-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  font-size: 13px;
}

.oc-scope__title {
  color: var(--wb-text-muted);
}

.oc-more {
  padding: 11px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.oc-more .oc-actions {
  margin-left: 0;
  flex-wrap: wrap;
}

.oc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.oc-rate {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.oc-rate__input {
  width: 76px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 按钮基座来自全局 .wb-btn（见 src/styles/index.css）；本页只留布局职责。 */
.oc-btn {
  flex-shrink: 0;
}

.oc-hint,
.oc-error {
  margin: 0;
  font-size: 13px;
}
.oc-error {
  color: var(--wb-danger);
}

/* 分桶 / 缺口：各自的卡片外观已由 .oc-health 里的覆盖规则去掉（同卡内只是一行内容），
   这里只留最基础的字号 —— 若将来它们又被单独使用，仍是可读的一行。 */
.oc-buckets,
.oc-gaps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.oc-gaps__title,
.oc-buckets__title {
  color: var(--wb-text-muted);
}

/* ---- 明细表：把"这一行是谁"的三样（单号/店铺/状态）压进一列 ---- */
.oc-order {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.35;
}
.oc-order__sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}
.oc-order__bucket {
  color: var(--wb-text-muted);
}
.oc-order__bucket.is-closed {
  color: var(--wb-danger);
}

/* 来源：两个取值不值得用药丸（边框 + 内边距白占 20px）。用一个小圆点区分通道。 */
.oc-src {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
}
.oc-src::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-border-strong);
}
.oc-src.is-collect {
  color: var(--wb-text);
}
.oc-src.is-collect::before {
  background: var(--wb-primary);
}

/* 毛利单元格：金额 + 轨标签（原「毛利依据」列收敛过来）。
   用 inline-flex 而不是把 td 改成 flex —— 改 td 的 display 会破坏表格布局。 */
.oc-gross {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.oc-tier {
  font-size: 11px;
}

.oc-tag {
  flex-shrink: 0;
}

.oc-ok {
  color: var(--wb-success);
  font-size: 12px;
}

/* 主体：一条纵向流（原来内部自成滚动区；现在整页滚动，嵌套滚动条没有必要） */
.oc-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.oc-stats {
  min-width: 0;
}

.oc-stats__head {
  font-weight: 400;
  flex-wrap: wrap;
}
/* 面板头是 600：说明性文字（"只含非关闭单"）要压回常规粗细，否则"备注"看起来和"标题"同级 */
.oc-stats__head .oc-muted {
  font-weight: 400;
}

.oc-stats__dim {
  margin-left: auto;
}
/* 分段控件靠左、粒度选择器靠右：两者之间留白，"切视图"和"换粒度"不是一件事 */
.oc-stats__head .wb-seg {
  margin-right: 4px;
}

.oc-total {
  color: var(--wb-text);
  font-weight: 600;
}

.is-loss {
  color: var(--wb-danger);
}

/* 已关闭单整行降权：它是"单列一桶、不进合计"的口径，视觉上也要能一眼跳过 */
.is-closed {
  opacity: 0.55;
}

.oc-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.oc-muted {
  color: var(--wb-text-muted);
}

/* 空态：占满整行的 td 里排一列（图标 / 标题 / 说明 / 动作）——
   原先只是一行灰字，横向铺满 16 列的宽度又居中，读起来是一句悬空的话。 */
.oc-empty {
  padding: 44px 24px;
  white-space: normal;
  text-align: center;
}
.oc-empty__title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}
.oc-empty__desc {
  max-width: 54ch;
  margin: 0 auto;
  font-size: 13px;
  line-height: 1.65;
  color: var(--wb-text-muted);
}
.oc-empty .wb-empty__icon {
  margin: 0 auto 8px;
}
.oc-empty .wb-empty__actions {
  margin-top: 12px;
}
</style>
