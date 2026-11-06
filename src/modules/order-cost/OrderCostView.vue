<template>
  <div class="wb-page oc-view">
    <!-- 页头：原先整页没有标题，第一行就是四个统计数字 —— 用户不知道这页在算什么。
         ⚠️ 2026-10-17 起本页**只有独立形态**：原来它还能被「发货台」的「算钱」页签内嵌
            （`embedded` prop 藏标题、藏刷新按钮、只算今天导入的那批）。用户裁定把算钱整步
            撤出发货台、都归拢到这里 ⇒ 那个形态已无消费者，整套分支（prop / emit / `oc-scope`
            口径标签 / `is-embedded` 样式）一并删掉：留着它只会让人以为"还有第二个入口"，
            而两个入口给两个口径的数正是这页最早的病。
         「刷新」是页面自己的按钮（没有容器页头再顶一个，不必再藏）。 -->
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">统计</h1>
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
        <button
          class="wb-btn oc-btn"
          data-act="refresh"
          :disabled="loading"
          @click="load"
        >
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

    <!-- 概览卡：**这页的结论**，两行。
         第一行 = 钱的五个数。原先是六个格，其中「各环齐全 N」与下一行的缺口说的是同一件事
         （"数据齐不齐"），而缺口的说法具体得多（缺哪一环、几行）⇒ 撤掉那一格，
         「齐不齐」在页面上**只剩一处说法**。
         第二行 = 这批数据的状态：左边缺什么、右边按经营状态各多少，中间一条淡分隔线。
         ⭐ **每个缺口都是一颗可点的筛子**（2026-10-11）：点「缺克重 1」→ 明细表只留那一行。
            原先它是纯提示 —— 用户被告知"有 1 行缺克重"，却没有任何办法知道**是哪一行**，
            只能自己在几百行里逐格找。这与本仓既有的「提示不是入口」是同一条规矩。
         ⚠️ `.oc-topbar` / `.oc-gaps` / `.oc-buckets` 与各 `data-act` 锚点仍被冒烟按锚点取用；
            「标签 <b>数字</b>」不能被拆成兄弟元素。 -->
    <div class="oc-overview">
      <div class="wb-metabar oc-topbar">
        <span class="wb-metric" data-act="metric-rows"
          >订单行 <b>{{ summary.total }}</b></span
        >
        <span class="wb-metric" data-act="metric-revenue"
          >收入合计 <b>{{ money(summary.revenueTotal) }}</b></span
        >
        <!-- 成本合计与毛利并排，口径必须一致（都只含非关闭单）—— 否则"成本比收入还大"没法解释。
             见 src/lib/orderCost.ts 的 OrderCostSummary 注释。 -->
        <span class="wb-metric" data-act="metric-cost"
          >成本合计 <b>{{ money(summary.costTotal) }}</b></span
        >
        <span class="wb-metric" data-act="metric-gross" :title="grossTitle"
          >毛利合计 <b>{{ money(summary.grossTotal) }}</b></span
        >
        <span class="wb-metric" data-act="metric-margin" :title="marginTitle"
          >毛利率 <b>{{ marginText }}</b></span
        >
        <!-- 关闭单不进上面任何一个合计。这句话**只在真有**关闭单时出现 ——
             没有的时候摆一句"不含已关闭 0 行"就是噪声（零的正确表达是不出现）。 -->
        <span v-if="closedRows" class="oc-topbar__note" title="关闭单单列一桶，不进收入/成本/毛利合计（混进来会让整体虚高）">
          不含已关闭 {{ closedRows }} 行
        </span>
      </div>

      <!-- 体检行：只在数据到位时出现（加载中不摆一排 0 出来）。
           ⚠️ 2026-10-11 二改：撤掉「缺哪一环：」「在途单结算前平台不给费用，只能估」
              「经营状态（利润合计只含非关闭单）：」三句，以及「多件…（多件合并计费尚未支持）」的长尾 ——
             屏幕上只留"是什么"，"为什么"进 title。 -->
      <div v-if="!loading && !error" class="oc-health">
        <div class="oc-gaps">
          <!-- 只为**真的缺**的那些环渲染；每个都是按钮：点了筛明细。
               原先无论 0 都渲染 8 个「缺X 0」：数据齐全时用户要逐个读完才知道"都齐了" ——
               全 0 的正确表达是一句话，不是 8 个零。 -->
          <template v-if="activeGaps.length">
            <button
              v-for="g in activeGaps"
              :key="g.key"
              class="wb-tag oc-tag is-warn oc-tag--act"
              :class="{ 'is-on': gapFilter === g.key }"
              type="button"
              :data-act="`gap-${g.key}`"
              :title="`只显示「${g.label}」的 ${g.count} 行（再点一次取消）`"
              @click="toggleGap(g.key)"
            >
              {{ g.label }} {{ g.count }}
            </button>
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
          <span v-else class="wb-tag oc-tag is-on">
            平台费按 {{ feeRatePercent }}% 近似
          </span>
          <!-- ⚠️ 仍是 **span 不是按钮**：它没有可做的动作，做成按钮就是"假动作"。
               长句（"成本/运费仍按 1 件算、多件合并计费尚未支持"）进 title。 -->
          <span
            v-if="multiPieceRows"
            class="wb-tag oc-tag is-warn"
            data-act="multi-piece-hint"
            :title="`${multiPieceRows} 行的件数大于 1：成本按单件价算（不乘件数）；运费只有已拆包的单会按件数摊包裹实付，未拆包的单仍按 1 件估`"
          >
            多件 {{ multiPieceRows }} 行按单件计
          </span>
        </div>

        <span class="oc-health__sep" aria-hidden="true"></span>

        <div class="oc-buckets">
          <span v-for="b in summary.bucketTotals" :key="b.bucket" class="wb-tag oc-tag is-on">
            {{ bucketLabel(b.bucket) }} {{ b.rows }} 行 · 毛利 {{ money(b.gross) }}
          </span>
          <span v-if="preciseRows.length" class="wb-tag oc-tag is-on">
            精准 {{ preciseRows.length }} 行 · 毛利 {{ money(preciseGross) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 口径门禁（P0，2026-11-06）：只增不改。
         ⚠️ `.oc-topbar` / `.oc-gaps` 被 order-profit:ui 按整段 textContent 与 data-act 取用，
            所以这一块**放在既有容器之外**，锚点全部新命名；既有锚点一个不动、一个不拆。
         ⚠️ 不新增金额：`grossTotal`（预测公式，含精准行）与 `preciseGross`（结算净收入）口径不同，
            并排可以，相加不行 —— 这里只把"谁有真值、谁带缺口、谁在估"说清楚。 -->
    <section
      v-if="!loading && !error"
      class="oc-trust"
      data-act="oc-trust"
      aria-label="数据口径与可信度"
    >
      <div class="oc-trust__head">
        <span
          class="oc-trust__badge"
          :data-level="trustLevel === '数据基本齐全' ? 'ok' : 'warn'"
          data-act="trust-level"
          >{{ trustLevel }}</span
        >
        <span class="oc-trust__headline">{{ trustHeadline }}</span>
      </div>

      <div class="oc-trust__tracks">
        <div class="oc-trust__track" data-act="trust-precise">
          <span class="oc-trust__track-label">精准轨 · 平台结算口径</span>
          <b>{{ trust.preciseRows }}</b> 行
        </div>
        <div class="oc-trust__track" data-act="trust-forecast">
          <span class="oc-trust__track-label">预测轨 · 估算口径</span>
          <b>{{ trust.forecastRows }}</b> 行
        </div>
        <span class="oc-trust__track-note">两轨口径不同，只并列、不相加</span>
      </div>

      <div class="oc-trust__meter" data-act="trust-coverage">
        <div class="oc-trust__meter-bar">
          <span :style="{ width: (trust.coveragePercent ?? 0) + '%' }"></span>
        </div>
        <span
          >结算真值覆盖 {{ trust.coveragePercent === null ? '—' : trust.coveragePercent + '%' }}（{{
            trust.preciseRows
          }}
          / {{ trust.liveRows }} 行）</span
        >
      </div>

      <div class="oc-trust__scope" data-act="trust-scope">
        全部订单 · 按下单日 · 只含非关闭单 · 运费按运价表估算
        {{ trust.estimatedFreightRows }} 行 · 平台费{{
          summary.platformFeeMissing ? '未扣' : '按 ' + feeRatePercent + '% 近似'
        }}
      </div>

      <p v-if="rowLimitHit" class="oc-trust__limit" data-act="trust-limit">
        本次取到 {{ rawRowCount }} 行，已达上限 {{ limit }} 行 —— 更早的订单可能没算进来（只少报，不多报）
      </p>

      <div class="oc-trust__actions">
        <button
          class="wb-btn wb-btn--primary oc-btn"
          type="button"
          data-act="trust-goto-health"
          @click="goHealth"
        >
          去「基础数据 › 待补清单」补数据
        </button>
        <span class="oc-trust__hint">缺 {{ trust.gapRows }} 行 · 补完回来点「刷新」</span>
      </div>
    </section>

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

    <!-- 口径条：**只放会改变上面数字的开关**，一句说明都不写。
         · 「取数范围」2026-11-06 由「费率与归属」搬来 —— 它决定"哪些单进合计"，是口径不是低频维护，
           且默认「全部」必须一眼可见；上限 2000 是宿主 shippingRows 的物理边界。
         · 「数据来源」到底指什么，紧邻的两枚「采集 N 行 / 导入 N 行」已经说完；
         · 「税口径」只作用于订单自己没写税的行 ⇒ 进 title；选项里的括号**只留后果**
           （税记 0 / 标缺口），删掉"默认""不按 0 算"这类句子。
         ⚠️ 两枚 `data-act="source-count"` 的文案仍被冒烟按词取用（"采集 1 行"）。 -->
    <div class="oc-scope">
      <!-- ⚠️ 原来这个 select 没有 change 处理：选了档位不点「刷新」就什么都不发生（静默失效）。
           搬到口径条时一并接上，让"选了"立刻"生效"。 -->
      <select
        v-model.number="limit"
        class="wb-input wb-input--sm"
        data-act="row-limit"
        aria-label="取数范围"
        title="默认全部；2000 行是宿主取数上限，到上限会在口径门禁里提示"
        :disabled="loading"
        @change="onLimitChange"
      >
        <option :value="100">最近 100 行</option>
        <option :value="500">最近 500 行</option>
        <option :value="1000">最近 1000 行</option>
        <option :value="2000">全部（最多 2000 行）</option>
      </select>
      <select
        v-model="sourceFilter"
        class="wb-input wb-input--sm"
        data-act="source"
        aria-label="只算哪个来源的订单行"
        title="采集 = 从店铺抓回来的；导入 = Excel 导进来的"
        @change="onFilterChange"
      >
        <option value="all">全部来源</option>
        <option value="collect">仅采集</option>
        <option value="import">仅导入</option>
      </select>
      <span class="wb-tag oc-tag" data-act="source-count"
        >采集 {{ summary.sourceCounts.collect }} 行</span
      >
      <span class="wb-tag oc-tag" data-act="source-count"
        >导入 {{ summary.sourceCounts.import }} 行</span
      >

      <select
        v-model="taxDefault"
        class="wb-input wb-input--sm oc-scope__tax"
        data-act="tax-default"
        aria-label="订单自己没说税时按哪种口径算"
        title="只作用于订单自己没写税的行"
        @change="onFilterChange"
      >
        <option value="platform">平台代征代缴（税记 0）</option>
        <option value="unknown">不知道（标缺口）</option>
      </select>
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
          <!-- 面板头**不再重复口径**（2026-10-11）："金额只算非关闭单"这件事在页面上只说一次，
               就在指标条上 —— 且只在真有已关闭单时出现（`不含已关闭 N 行`）。
               原来这里那句「只含非关闭单」是同一句话的第二遍，常在的句子读多了就成噪声。 -->
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
          <span class="wb-muted"
            >{{ shownRows.length }} 行<template v-if="gapFilter"
              >（全 {{ summary.rows.length }}）</template
            ></span
          >
          <!-- 筛选态**必须看得见、也必须撤得掉**：表格忽然只剩一行而不说明原因，
               用户会以为"数据没了"。这条 chip 就是那个开关（点 × 或再点上面那颗缺口都行）。 -->
          <span v-if="gapFilter" class="wb-tag oc-tag is-warn oc-filter" data-act="gap-filter">
            只看 {{ gapLabel(gapFilter) }}
            <button
              class="oc-filter__x"
              type="button"
              data-act="clear-filter"
              title="取消筛选"
              aria-label="取消筛选"
              @click="gapFilter = null"
            >
              ×
            </button>
          </span>
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
                v-for="r in shownRows"
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
                  :title="shippingTitle(r)"
                >
                  {{ money(r.shipping) }}
                </td>
                <td class="wb-num" data-act="product-cost" :class="{ 'oc-muted': r.productCost === null }" :title="costTitle(r)">
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
                  <!-- 空态 = 一段"导入后会得到什么"的承诺 + 一个可点的下一步。
                       原文案里的「（宿主自己会拆行入库，不需要装插件）」已删（2026-10-11）：
                       它拿内部架构向用户解释（§1.10 禁用词），而用户只需要"去哪、点哪个"。
                       也不再提"再回来点刷新" —— 重挂即取（原来的"内嵌时 token 自动重算"随
                       内嵌形态一起删掉，2026-10-17）。 -->
                  <p class="oc-empty__desc">
                    导一份订单报表，这里就按订单行算收入、运费、成本与毛利；缺的那一环逐行标出来。
                  </p>
                  <div class="wb-empty__actions">
                    <button
                      class="wb-btn wb-btn--primary"
                      data-act="empty-import"
                      @click="goImport"
                    >
                      去「发货台」导入
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
// 「统计」视图（id 仍为 order-cost；2026-10-17 显示名由「算钱」改为「统计」）：取数 → 纯计算层算 → 渲染。
// 两条摄取通道（采集 / 导入）在同一张表里，按「来源」列与顶部计数区分。
//
// 口径（用户 2026-09-29 裁定，别改）：
//   · 这是**预测**工具 —— 在途单要算（不是只算已结算）；精准值留给将来接结算数据的那一轨。
//   · 关闭单**单列一桶、不进利润合计**（真实报表实测 54% 是关闭单，混进来整体虚高）。
//   · 平台代征代缴 → 增值税不是我们的成本（确定的 0）；不知道谁承担 → 标缺、**不按 0 算**。
//   · 平台费（佣金/手续费）暂无数据源 → 全局提示"未扣"，**不按 0 算**。
//   · 任一环缺 → 毛利为 `null` 并逐行标出来（0 与"不知道"必须分开）。
//   · 件数是**拣货口径**：结算商品行真值 → 订单报表块内 `商品数量` → 按 1 件并标「缺件数」。
//     它**不乘进**成本（成本是单件价）；**已拆包的单**运费按件数把包裹实付摊到各行。
//
// 取数（全部经 core 服务，视图内零算术）：
//   1. 订单行（含店铺/时点/款编码 + 金额/状态/时点列）→ `orderShippingRows`
//      —— 其中 `weightG`/`costCents` 是**行级快照**（阶段 A4/A5），有值就优先用（见 `computeOrderCosts`）
//   2. 克重（批量，一次调用）                        → `loadSkuWeights()`（SKU 级，`pl_variants.weight_g`）
//      ⚠️ 2026-10-01 起克重**只**来自 SKU：原「商品ID → 克重」那条链（`productWeightGet` +
//      `pl_item_weights`）已随领域裁定整条删除（克重是一款的属性，不是某个商品的属性）。
//      现只作**回落**：订单行没钉过快照时才算。
//   3. 成本（行级两字段，C2）                        → `costCents`（进价预估）/ `actualCostCents`（实际进价）
//      取数口径 `actual > estimate > none`，两处都没有就标缺 —— 不再回查任何"款级价目表"。
//   4. 包裹运费汇总（批量，按单号）                   → `orderParcelTotals`（阶段 C1）
//      已拆包的单：运费 = **包裹实付合计**（按件数摊到各行），**不再**看运价表；
//      已拆包但缺运费：标 `parcel` 缺口、**不回落估算**（否则"按包记的真值"会被估算盖掉）。
//   5. 运价表：**只有**宿主快照（`shipRateSnapshotCalc`，按订单日期取"当时那份"）——只算还没拆包的单
//
// ⚠️ 第 4 路原有一层「岛存储回落」，2026-10-15 随 `shipping-rate` 岛整体下架一并删除：
//    真源早已归宿主 `sr_rate_snapshots`（M6，2026-09-30；岛只显示、不再存也不回传），
//    那层回落只覆盖"老库 + 还没打开过运费页"的过渡期。岛一没，键永远读不到值
//    ⇒ 恒不生效的死代码，比没有更容易骗人（"看起来还兼容着"）。
//    算法层 `computeOrderCosts` 的单表口径分支**故意留着**（那分支本身合法，
//    `tests/orderCost.spec.ts` 钉着"快照优先于单表"），只是生产恒传 null。
//    另外：报价单会更新，要"按历史复算"就得给它加生效区间（`sr_rate_snapshots` 就是这么做的）；
//    成本侧同理 —— 订单行自己钉 `cost_cents` / `actual_cost_cents` 两个快照，本页不回查产品当前价。
import { computed, nextTick, onMounted, ref } from 'vue';
import { selectExcelFile } from '@/core/services/dialog';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { loadSkuWeights } from '@/core/services/skuWeights';
import * as ipc from '@/core/services/ipc';
import type { UnifiedOrderRow } from '@/types';
import {
  computeOrderCosts,
  settleQtyKey,
  summarizeOrderCosts,
  trendOf,
  trustSummary,
  type BizBucket,
  type CostGroupDim,
  type OrderCostGap,
  type QtySource,
  type RateSnapshot,
  type SettleQtyInfo,
} from '@/lib/orderCost';
import { importSettle as runSettleImport } from '@/core/services/importSheet';
import CostRatesSection from './components/CostRatesSection.vue';
import type { RateTable } from '@/lib/shipRate';

/**
 * ⚠️ 本组件**不收任何 prop**（2026-10-17）。
 * 原先是"一份视图两个入口"：被「发货台」的「算钱」页签内嵌时收 `embedded` / `refreshToken` /
 * `importDate`（藏页头、跟容器的数据版本重算、只算今天导入的那批），独立打开时不传（全库）。
 * 用户裁定把算钱整步撤出发货台、都归拢到这里 ⇒ 只剩**一个入口、一个口径（全库）**，
 * 三种入参随之删掉 —— 留着它们就会重新长出"同一页两个数"那类缝。
 */

/** 「数据基础：成本与汇率」区的重取信号（主刷新时 +1） */
const costRatesKey = ref(0);

/** 明细表空态图标（内联 SVG，跟随 currentColor） */
const EMPTY_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5C4 5.1 7.6 4 12 4s8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5z"/><path d="M4 6.5v11C4 18.9 7.6 20 12 20s8-1.1 8-2.5v-11"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/></svg>';

/**
 * 取数行数上限（用户 2026-11-06 裁定「默认全部」）。
 * 宿主 `order-db.ts#shippingRows` 的物理上限是 2000（`Math.min(..., 2000)`），所以"全部"= 取满这个上限。
 * ⚠️ 原默认 500 会**静默少算**：超过 500 行的库，更早的订单不进任何合计，而页面一个字都不说。
 *    到上限时下面有显式提示（只少报，不多报），不假装"全部"真的等于无限。
 */
const limit = ref(2000);
const loading = ref(false);
const importing = ref(false);
const error = ref('');
/** 平台费近似费率（%）；持久化在 `order-cost` 命名空间（**不配就不扣，见 summary.platformFeeMissing**） */
const feeRatePercent = ref(0);
/** 上一次取到的四路输入：改费率时**复用它们重算**，不必再打三次 IPC */
const inputs = ref<Parameters<typeof computeOrderCosts>[0] | null>(null);
const summary = ref(computeOrderCosts({ orders: [], rateTable: null }));

const GAPS: { key: OrderCostGap; label: string }[] = [
  { key: 'revenue', label: '缺收入' },
  { key: 'fx', label: '缺汇率' },
  { key: 'country', label: '缺国家' },
  { key: 'weight', label: '缺克重' },
  { key: 'rate', label: '缺运价表' },
  { key: 'parcel', label: '缺包裹运费' },
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

/**
 * 缺口筛选（2026-10-11）：点指标下的任一缺口 chip ⇒ 明细表只留**带这个缺口**的行。
 *
 * 为什么值得做：缺口 chip 原本是纯提示 —— 它说"1 行缺克重"，用户却无法知道是哪一行，
 * 500 行的表里只能逐格去找（这正是本仓「提示不是入口」那条规矩要治的东西）。
 * `null` = 不筛。**每次重算都清空**（见 `recompute`）：换来源/改税口径之后，
 * 原来那个缺口可能已经不存在了，留着筛选会出现"表里空的但头上写着只看缺成本"——静默失效。
 */
const gapFilter = ref<OrderCostGap | null>(null);

/** 明细表真正渲染的行（不筛时就是全部） */
const shownRows = computed(() =>
  gapFilter.value ? summary.value.rows.filter((r) => r.gaps.includes(gapFilter.value as OrderCostGap)) : summary.value.rows
);

function toggleGap(k: OrderCostGap): void {
  gapFilter.value = gapFilter.value === k ? null : k;
}

function gapLabel(k: OrderCostGap): string {
  return GAPS.find((g) => g.key === k)?.label ?? k;
}

/** 已关闭单的行数（不进任何金额合计）。只在 > 0 时于指标条尾注一句，说清"订单行 3 但合计只算 2 行"。 */
const closedRows = computed(
  () => summary.value.bucketTotals.find((b) => b.bucket === 'closed')?.rows ?? 0
);

/** 毛利合计的悬停口径：它是四个数的差，用户对不上账时最先想知道的就是这个式子 */
const grossTitle =
  '毛利 = 收入 − 运费 − 产品成本 − 税 − 平台费（近似）；已结算的行改用平台结算净收入，见明细里的「精准」标签';

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
function weightTitle(r: { weightG: number | null; weightSource?: string }): string {
  if (r.weightG === null) {
    return '没查到克重：这一行没识别出款/色/码，或该 SKU 在「产品管理」里没维护克重';
  }
  if (r.weightSource === 'snapshot') {
    return '克重取自这一行**钉住的快照**（归类核对「确认无误」时定下的值），之后改 SKU 克重不会回改它';
  }
  return '克重按款 × 色 × 码取自产品库 SKU（在「基础数据 › 产品管理」维护；本行还没钉快照）';
}

/**
 * 成本单元格的悬停说明：把"这笔成本是真值还是预估"讲明。
 * 两种来源给的数会不一样（拿货实付 vs 确认时钉的预估），不说清就会出现"同一单两个页面两个成本"。
 */
function costTitle(r: { productCost: number | null; costSource?: string }): string {
  if (r.productCost === null) {
    return '没有这一行的成本：款没识别出来，或该款在产品管理里没有当前进价（不按 0 算）';
  }
  if (r.costSource === 'snapshot') {
    return '成本 = 这一行的**实际进价**（拿货单落账时回写的实付真值）';
  }
  return '成本 = 这一行的**进价预估**（归类核对「确认无误」时按产品当时价钉的快照；之后改价不回改它）';
}

/**
 * 运费单元格的悬停说明：把"真值 / 估算"和"缺了为什么不估"讲明。
 * 包裹与运价表是**互斥**的：拆了包就只认包裹实付，缺了也标缺 —— 不拿运价表去补，
 * 否则用户在拆包面板填的数会被估算悄悄盖掉，且行上没有任何痕迹。
 */
function shippingTitle(r: {
  shipping: number | null;
  shippingSource?: string;
  rateVersion?: string;
}): string {
  if (r.shippingSource === 'parcel') {
    return r.shipping === null
      ? '这一单已拆包，但还有包裹没填运费 —— 不按运价表估算；去「归类核对 › 拆包」把每个包的运费补上'
      : '运费 = 这一单所有包裹的运费合计（实付真值），按件数摊到各行；在「归类核对 › 拆包」维护';
  }
  return r.rateVersion ? `按运价表 ${r.rateVersion}` : '按当前那份运价表';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // **一个读口**：主干 `oi_orders` 的投影（`source` 由宿主标好，页面不再自己打标签）
    // ⚠️ 不按导入日筛：本页问的是"这些订单赚不赚"，不限今天（原内嵌形态的"今天导入"口径
    //    已随发货台那个页签一起删掉，2026-10-17）。
    const ord = await ipc.orderShippingRows({ limit: limit.value });
    if (!ord.success || !ord.data) throw new Error(ord.error || '读取订单失败');
    const orders: UnifiedOrderRow[] = ord.data;

    // 克重只有一个来源：产品库 SKU 表（款×色×码）—— 取数口在 `core/services/skuWeights`（三处共用一份）
    const skuWeights = await loadSkuWeights();

    // 运价表：宿主快照（按订单日期取"当时那份"，历史可复算）。
    // ⚠️ 这里**只**读宿主快照，不再回落到"岛存储里的当前那份"（2026-10-15 删除）：
    //   该回落本是为"老库 + 还没打开过运费页"的过渡期准备的，而 `shipping-rate` 岛
    //   同日整体下架、宿主侧的岛桥域也一并删除 ⇒ 那个键永远读不到值 ⇒ 恒不生效的死代码
    //   （"看起来还兼容着，实际分支永远进不去"，比没有更容易骗人）。
    const snap = await ipc.shipRateSnapshotCalc({ limit: 50 });
    const rateSnapshots: RateSnapshot[] = (snap.success ? (snap.data?.rows ?? []) : [])
      .filter((r) => r.table)
      .map((r) => ({ effectiveFrom: String(r.effectiveFrom ?? ''), table: r.table as RateTable }));

    // 只保留**查询偏好**（取整方式）：它是用户设置、仍在写，不是岛的遗留数据。
    const st = await useModuleStorage<{ rounding?: string }>('shipping-rate').load();
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

    // 包裹运费（阶段 C1）：已拆包的单用包裹实付合计，缺了标缺。
    // 读失败**不能**当成"都没拆包"—— 那会静默回落到运价表估算，行上看着有数，
    // 实际把用户在拆包面板填的真值盖掉了；故与成本/订单同样走抛错。
    const parcelRes = orderNos.length ? await ipc.orderParcelTotals(orderNos) : null;
    if (parcelRes && !parcelRes.success) throw new Error(parcelRes.error || '读取包裹运费失败');
    const parcelTotals = parcelRes?.data ?? {};

    inputs.value = {
      orders,
      skuWeights,
      // 恒传 null：单表口径的**唯一生产来源**（岛存储里的表）已随岛下架删除
      // （2026-10-15）。算法层的这个回退分支本身仍保留（单表口径本身合法，
      // tests/orderCost.spec.ts 也钉着"快照优先于单表"）——只是没有生产数据能走它。
      rateTable: null,
      rateSnapshots,
      parcelTotals,
      rounding,
      settleByOrder,
      settleQty,
    };
    recompute();
    // 只有"还需要靠运价表"的单才提示 —— 全部已拆包时运费走包裹实付，没运价表也照样算得出，
    // 此时再喊"去导报价单"就是把用户支去补一份他根本用不到的数据。
    const needsRate = orders.some((o) => !((parcelTotals[String(o.orderNo ?? '')]?.count ?? 0) > 0));
    if (!rateSnapshots.length && needsRate) {
      // ⚠️ 指路指向**宿主自己的导入入口**（发货台 › 订单 › Excel 导入），不再指向岛「无忧物流运费」
      //   （2026-10-11 改）：统一导入已能导报价单（`importSheet.importShipRate` 落到
      //   `sr_rate_snapshots`），而那个岛可能根本没装 —— 指一个装没装都不一定的入口，
      //   对没装的用户就是"死路"。
      //   ⚠️ 2026-11-02：「导入订单」页签并进「待发货」（Excel 成为页内默认收起的备选区）⇒ 文案跟着改。
      //   ⚠️ 2026-11-05：「待发货」与「总览」又合并成「订单」一屏 ⇒ 指路里的页签名再改一次
      //      （页签名是本守卫的"真实入口"，改名不同步 ⇒ 用户按着提示找不到页）。
      toast(
        '还没读到运价表 —— 还没拆包的订单要靠它算运费：去「发货台」的「订单」页展开「Excel 导入（备选）」导一份报价单',
        'info'
      );
    }
    costRatesKey.value += 1; // 产品当前价可能刚被改过，跟着主刷新一起重取
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

/** 多件行（件数 > 1）：成本按单件价；运价表估算也按单件 —— 有这类行就把口径写在界面上 */
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

// ── 口径门禁（P0，2026-11-06）──────────────────────────────────────────────
// ⚠️ 这一块**只回答"这批数能不能信"，不新增任何金额**。
//    `summary.grossTotal` 是全部非关闭单按**预测公式**求和（精准行也走预测公式），
//    而 `preciseGross` 是**平台结算净收入**口径 —— 两者并排但绝不相加。
//    金额继续只用 .oc-topbar / .oc-buckets 里那几个既有实现（每个数字只能有一处实现）。
const trust = computed(() => trustSummary(summary.value.rows));
/** 本次真正读进来的行数（在 sourceFilter 之前）——用于判断是否被 limit 截断 */
const rawRowCount = computed(() => inputs.value?.orders.length ?? 0);
/** 到上限：宁可多提示一次，也不静默少算。零行时不提示（零的正确表达是不出现） */
const rowLimitHit = computed(() => rawRowCount.value > 0 && rawRowCount.value >= limit.value);
const trustLevel = computed(() => {
  const t = trust.value;
  if (!t.liveRows) return '暂无可判断的订单';
  if (t.gapRows > 0 || summary.value.platformFeeMissing) return '这批数还不能拿去结算';
  if ((t.coveragePercent ?? 0) < 50) return '预测为主';
  return '数据基本齐全';
});
const trustHeadline = computed(() => {
  const t = trust.value;
  if (!t.liveRows) return '还没有参与合计的订单行';
  return `${t.liveRows} 行参与合计，其中 ${t.gapRows} 行带缺口、${t.estimatedFreightRows} 行运费为估算`;
});

/**
 * 改取数范围后立即重取。
 * ⚠️ 不直接信 `v-model` 的结果：`v-model.number` 对 select 是「取被选中 option 的 _value」，
 *    一旦 DOM 上出现无匹配项（选中态被外部改坏 / 选项还没渲染完），它会把 `limit` 写成
 *    `undefined`。宿主 preload 对非 number 的 limit **静默回落 500** —— 用户看到的是
 *    "选了新档位，数字却按 500 行算"且一声不响。所以这里从事件目标显式读、判合法、再落值。
 * ⚠️ 仍要等一个 tick：指令的 change 监听与 `@change` 合并后执行顺序不保证，
 *    直接读旧值会出现"选了 100 行却按 2000 行取数"且不报错。
 */
function onLimitChange(event: Event): void {
  const el = event.target as HTMLSelectElement | null;
  const n = Number(el?.value);
  if (!el || !Number.isFinite(n) || n < 1) return;
  limit.value = Math.min(Math.max(Math.round(n), 1), 2000);
  void nextTick(() => {
    void load();
  });
}

/**
 * 缺口跳补：**入口唯一**。六类缺口各自去哪补已经写在「基础数据 › 待补清单」里，
 * 这里只给一个出口，不在统计页复制六套跨模块跳转（改一处忘一处的经典来源）。
 */
function goHealth(): void {
  switchModule('shop-accounts', 'health');
}

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
  // 缺口筛选跟着「这一批数据」走：重算后原来那个缺口可能已经不存在了（补了成本、换了来源），
  // 留着筛选会变成"表格空着、头上还写着只看缺X"——**静默失效**。每次重算一律清掉。
  gapFilter.value = null;
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

/** 空态里的下一步：去「发货台」导订单（那儿的「导入订单」页签是统一入口）。
 *  本页不再有内嵌形态（2026-10-17），所以只有"真跳转"这一条路。 */
function goImport(): void {
  switchModule('today');
}

/** 导入结算明细（AE 后台「订单明细」导出）：选文件 → 解析（渲染层）→ 落库 → 重取 */
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

// 进页即取（本页没有"别人改了数据要通知我"的第二入口了：容器 `refreshToken` 那套随内嵌形态删除）
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

/* 概览卡：**一行结论 + 一行体检**装进同一张卡。
   原先「指标条 / 分桶 / 缺口」是三条各自带边框的全宽横条、底色还两套，
   叠加「口径条」共 4 层同权重信息摞在表格之上 —— 这是"杂乱"的根源，不是信息太多。
   （「口径条」本身已随内嵌形态删除，2026-10-17：本页只有全库一个口径，没有要声明的范围。） */
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
/* 指标条尾注（"不含已关闭 N 行"）：与数字同排但**降一档** —— 它是给数字打的补丁，不是第七个数。 */
.oc-topbar__note {
  margin-left: auto;
  padding-left: 12px;
  font-size: 12px;
  color: var(--wb-text-muted);
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
/* 「缺什么」与「按状态各多少」是两件事，用一条竖线分开 —— 比再写两个标签省一半的字 */
.oc-health__sep {
  width: 1px;
  align-self: stretch;
  margin: 2px 0;
  background: var(--wb-border);
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

/* 可点的缺口 chip：**形状必须跟右边那些只读标签区分开**，否则用户根本不知道它点得动 ——
   交互藏在看不出来的地方，等于没做。做法：实心药丸 ⇒ 描边按钮（悬停填底、按下变实心）。
   于是体检行天然分成两半：**左边是"要做的事"（可点），右边是"现状"（只读）**。
   ⚠️ 只补 `<button>` 缺失的那几项（UA 默认边框/字体），**不写 font 简写** ——
      它会把全局 `.wb-tag` 的 0.75rem 一并覆盖掉，标签就比旁边那颗大一号。 */
.oc-tag--act {
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--wb-warning);
  background: transparent;
  color: var(--wb-warning);
  font-family: inherit;
  font-weight: 400;
  cursor: pointer;
}
.oc-tag--act:hover {
  background: var(--wb-warning-soft);
}
.oc-tag--act.is-on {
  border-color: var(--wb-warning);
  background: var(--wb-warning);
  color: #fff;
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

/* 税口径靠右：左边是"看哪些行"，右边是"怎么算税"，两组之间留白分开
   （都不再写标签，靠这条空白和 select 自己的文案区分） */
.oc-scope__tax {
  margin-left: auto;
}

/* 明细面板头里的筛选 chip：它就是"当前只看什么"的开关，× 直接撤掉 */
.oc-filter {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.oc-filter__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.oc-filter__x:hover {
  background: rgb(0 0 0 / 12%);
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
   这里只留最基础的字号 —— 若将来它们又被单独使用，仍是可读的一行。
   2026-10-11：两侧的「缺哪一环：」「经营状态（…）：」标签已删（详见模板注释），
   所以这里不再有 `__title` 那一档样式。 */
.oc-buckets,
.oc-gaps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
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

/* ── 口径门禁（P0，2026-11-06）────────────────────────────────────────────
   不新增色值 / 字号令牌，全部复用 --wb-*；主按钮直接用既有的 .wb-btn--primary。
   状态徽标靠**边框形状**（实线 / 虚线）区分，不靠颜色编码（11-04 方案 §6.1 同一条纪律）。 */
.oc-trust {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
}
.oc-trust__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.oc-trust__badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 4px;
  font-size: 11px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
.oc-trust__badge[data-level='warn'] {
  border-style: dashed;
}
.oc-trust__headline {
  font-size: 13px;
  color: var(--wb-text);
}
.oc-trust__tracks {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.oc-trust__track {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  font-size: 13px;
  color: var(--wb-text);
}
.oc-trust__track b {
  font-weight: 600;
}
.oc-trust__track-label,
.oc-trust__track-note,
.oc-trust__scope,
.oc-trust__hint,
.oc-trust__meter {
  font-size: 11px;
  color: var(--wb-text-muted);
}
.oc-trust__meter {
  display: flex;
  align-items: center;
  gap: 10px;
}
.oc-trust__meter-bar {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: var(--wb-border);
  overflow: hidden;
}
.oc-trust__meter-bar span {
  display: block;
  height: 100%;
  background: var(--wb-primary);
}
.oc-trust__limit {
  margin: 0;
  font-size: 11px;
  color: var(--wb-warning);
}
.oc-trust__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
