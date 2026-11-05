<template>
  <div class="wb-page pk-view" :class="{ 'is-embedded': embedded }">
    <!-- 页头：**只在独立页**（`embedded=false`）出现。内嵌进「发货台 › 拿货」时整块不渲染 ——
         标题由外层页签交代，而"导出 / 更多"两个动作移到下面的精简条上（不能随页头一起消失）。
         ⚠️ 2026-10-17：左导航的「拣货」一级入口已摘（同一份清单在「今天 › 拿货 › 按厂家」里，
         入口唯一），生产上恒为 `embedded`；页头这一支保留给"将来若再挂成独立页"的复用形态。 -->
    <header v-if="!embedded" class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">拣货</h1>
        <p class="wb-head__desc">
          按未发货订单汇总「还要拿什么、各几件、图与供应商在哪、大概多少钱」，按厂家分卡 —— 可导出带图
          xlsx，也可以把某家的清单（图 / 文字）复制给厂家
        </p>
      </div>
      <div class="wb-head__actions">
        <button
          class="wb-btn wb-btn--primary"
          data-act="generate"
          :disabled="loading"
          @click="generate"
        >
          {{ loading ? '生成中…' : summary.groups.length ? '重新生成' : '生成待拣清单' }}
        </button>
        <button
          class="wb-btn"
          data-act="export"
          :disabled="loading || !summary.groups.length"
          @click="exportXlsx"
        >
          导出带图 xlsx
        </button>
        <button
          class="wb-btn"
          data-act="more"
          :class="{ 'is-on': showMore }"
          @click="showMore = !showMore"
        >
          {{ showMore ? '收起' : '更多' }}
        </button>
      </div>
    </header>

    <!-- 精简条（2026-10-17 第五轮）：「缺：…」缺口汇总与「未发货 · 近 30 天 · 超窗剔除…」
         口径说明都按用户要求撤掉 —— 页面只留动作（导出 / 更多）。空态的"为什么空"
         与动作仍由 `emptyReason` 在清单区说清（口径解释跟着空态走，不常驻占一行）。
         三个数（待拿款色 / 件数 / 预估金额）在卡面合计行与「生成拿货单（N 件）」按钮上。
         ⚠️ 条上的两个 span（缺口 / 口径）删掉后，这里只剩"正在汇总…"与右侧两个动作。 -->
    <div class="pk-bar pk-topbar" data-act="pk-bar">
      <span v-if="loading" class="wb-muted">正在汇总…</span>
      <span class="pk-bar__spacer"></span>
      <!-- 内嵌时页头不渲染 ⇒ 导出 / 更多跟着精简条走（藏了就没有可点的入口了） -->
      <button
        v-if="embedded"
        class="wb-btn wb-btn--sm"
        data-act="export"
        :disabled="loading || !summary.groups.length"
        @click="exportXlsx"
      >
        导出带图 xlsx
      </button>
      <button
        v-if="embedded"
        class="wb-btn wb-btn--sm"
        data-act="more"
        :class="{ 'is-on': showMore }"
        @click="showMore = !showMore"
      >
        {{ showMore ? '收起' : '更多' }}
      </button>
    </div>

    <!-- 未归类（2026-10-20）：**先说"数不准"，再给修复入口**。
         · 件数照常进统计（排除 = 悄悄少算，比如真库 51 行里有 9 行，18%）；
         · 但它们扣不掉"已拿"、也取不到图 ⇒ 卡片上会一直显示待拿，用户不被告知就只能猜；
         · 修复落在**商品ID**上：选中产品后该商品的全部历史订单自动回填款色，不是逐行点。
         ⚠️ 不可折叠进「更多」：这是"数字不准"的告知，藏起来等于没说。 -->
    <section v-if="unclassifiedRows.length" class="wb-panel pk-unclass" data-act="pk-unclass">
      <div class="pk-unclass__head">
        <span class="wb-tag is-warn" data-act="pk-unclass-tag">未归类</span>
        <span class="pk-unclass__title" data-act="pk-unclass-title">
          {{ unclassifiedPieces }} 件没有款色归属（{{ unclassifiedRows.length }} 个商品）
        </span>
        <span class="pk-unclass__why wb-muted">
          件数已照常计入待拿；但它们扣不掉已拿、也取不到图
        </span>
        <button
          type="button"
          class="wb-link pk-unclass__toggle"
          data-act="pk-unclass-toggle"
          :aria-expanded="showUnclassified"
          @click="showUnclassified = !showUnclassified"
        >
          {{ showUnclassified ? '收起' : '处理' }}
        </button>
      </div>
      <div v-if="showUnclassified" class="pk-unclass__body">
        <div v-for="u in unclassifiedRows" :key="u.itemId || 'no-item'" class="pk-unclass__row" data-act="pk-unclass-row">
          <span class="pk-unclass__iid">{{ u.itemId ? `商品ID ${u.itemId}` : '订单里没有商品ID' }}</span>
          <span class="pk-unclass__qty">{{ u.pieces }} 件 · {{ u.rows }} 行</span>
          <span class="wb-muted pk-unclass__shops">{{ u.shops.join(' / ') || '未知店铺' }}</span>
          <span class="pk-bar__spacer"></span>
          <button
            v-if="fixAction && u.itemId"
            type="button"
            class="wb-btn wb-btn--sm"
            :data-act="`pk-unclass-fix-${u.itemId}`"
            @click="emit('fix-unclassified', { itemId: u.itemId, pieces: u.pieces, shops: u.shops })"
          >
            选产品并归款
          </button>
          <span v-else-if="!u.itemId" class="wb-muted pk-unclass__hint">
            没有商品ID 只能在订单表里核对，这里修不了
          </span>
        </div>
      </div>
    </section>

    <!-- 亚洲款加码（2026-11-02）：**本页唯一的加码设置入口**，按"款"列出、逐款设幅度。
         ① 幅度是按客户反馈反复调的（+1 不够就 +2）⇒ 必须有一处把"哪几款 · 现在几码 · 待拿几件"
            连现状一起看全，而不是逐行翻；
         ② 没有加码款时**折成一行**（不占版面），但那行标题本身就是入口 —— 上一版把下拉藏在
            "有加码才显示"的提示条里，结果第一批款永远加不上码；
         ③ 行内只留只读标记（`+2 码`），点它跳到这里并高亮。
         ⚠️ 封顶与"认不出"分开说：前者仍按最大码拿（拿得到），后者是**没加**（照原码拿），
         两种后果完全不同，并成一句会让用户以为都加好了。 -->
    <section
      v-if="styleShiftRows.length"
      ref="shiftPanelRef"
      class="wb-panel pk-shift"
      :class="{ 'is-open': shiftPanelOpen, 'is-on': shiftStats.shiftedStyles > 0 }"
      data-act="pk-shift"
    >
      <button
        type="button"
        class="pk-shift__head"
        data-act="pk-shift-toggle"
        :aria-expanded="shiftPanelOpen"
        @click="toggleShiftPanel"
      >
        <span class="pk-shift__badge" data-act="pk-shift-tag">加码</span>
        <span class="pk-shift__title" data-act="pk-shift-title">{{ shiftTitle }}</span>
        <!-- 白话解释（2026-11-05）：只写「下单 L 拿 XL」是在解释**现象**，"为什么要加码"
             仍然要用户自己知道（亚洲码偏小）。加半句成本为零，换人不至于看不懂这一块。 -->
        <span class="wb-muted pk-shift__why">亚洲码偏小：下单 L 就照 XL 拿 · 订单与利润不变</span>
        <span class="pk-bar__spacer"></span>
        <span class="wb-muted pk-shift__count">{{ styleShiftRows.length }} 款可选</span>
        <span class="pk-shift__chev" data-act="pk-shift-chev">
          {{ shiftPanelOpen ? '收起' : '设置加码' }}
          <span class="pk-shift__caret" aria-hidden="true">{{ shiftPanelOpen ? '▴' : '▾' }}</span>
        </span>
      </button>

      <div v-if="shiftPanelOpen" class="pk-shift__body">
        <div class="pk-shift__filter">
          <input
            v-model="shiftQuery"
            class="wb-input wb-input--sm pk-shift__search"
            placeholder="搜款号 / 款名"
            data-act="pk-shift-search"
          />
          <label class="pk-field">
            <input v-model="onlyShifted" type="checkbox" data-act="pk-shift-only" />
            只看已加码
          </label>
          <span class="wb-muted pk-shift__hint">同款所有颜色一起生效</span>
        </div>

        <!-- `is-all` = 「展开全部」已点：放开高度上限，让用户真能一屏看全（2026-11-02 用户实报
             "点开展开全部还是被裁"——上限不撤的话这个按钮等于没点）。 -->
        <div class="pk-shift__list" data-act="pk-shift-list">
          <div class="pk-shift__cols" aria-hidden="true">
            <span>款 · 款号 / 款名</span>
            <span class="pk-shift__cols-meta">款色 · 待拿</span>
            <span class="pk-shift__cols-pick">加几码</span>
          </div>
          <div class="pk-shift__rows" :class="{ 'is-all': showAllShiftRows }">
            <div
              v-for="s in visibleShiftRows"
              :key="s.styleCode"
              class="pk-shift__row"
              :class="{ 'is-on': s.shift > 0, 'is-focus': shiftFocusCode === s.styleCode }"
              :data-act="`pk-shift-style-${s.styleCode}`"
            >
              <!-- 款图 + 款号/款名（竖排）。款号在上是因为**厂家单据上写的是号码**，
                   用户找行先扫号码；款名是辅助。图取本款本批首个有图的款色（见 `styleShiftRows`）。 -->
              <span class="pk-shift__cell">
                <img
                  v-if="shiftThumbOf(s)"
                  class="pk-shift__img"
                  :src="shiftThumbOf(s)"
                  :alt="s.styleCode"
                  :title="shiftImgTitle(s)"
                  draggable="false"
                />
                <span
                  v-else
                  class="pk-shift__img pk-shift__img--none"
                  :title="`「${s.styleName || s.styleCode}」本批没有款图`"
                  v-html="ICON.noimg"
                  aria-hidden="true"
                ></span>
                <span class="pk-shift__ident">
                  <span class="pk-shift__code wb-mono">{{ s.styleCode }}</span>
                  <span class="pk-shift__name" :title="s.styleName || s.styleCode">
                    {{ s.styleName || '(无款名)' }}
                  </span>
                </span>
              </span>
              <span class="pk-shift__meta">
                <span class="wb-muted">{{ s.colors }} 色 · 待拿 {{ s.remaining }} 件</span>
                <span v-if="s.ignored" class="wb-muted pk-shift__flag">整款已忽略</span>
                <span v-if="s.clampedRows" class="pk-shift__flag is-warn">
                  封顶 {{ s.clampedRows }} 行
                </span>
                <span v-if="s.unknownRows" class="pk-shift__flag is-warn">
                  认不出 {{ s.unknownRows }} 行（照原码）
                </span>
              </span>
              <select
                class="wb-input wb-input--sm pk-shift__pick"
                :value="s.shift"
                :disabled="loading"
                :title="`「${s.styleName || s.styleCode}」拿货时加几码（同款所有颜色一起；只改拿货尺码）`"
                :data-act="`pk-shift-pick-${s.styleCode}`"
                @change="onShiftChange(s.styleCode, $event)"
              >
                <option v-for="o in SIZE_SHIFT_OPTIONS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </option>
              </select>
            </div>
            <p v-if="!filteredShiftRows.length" class="wb-muted pk-shift__empty">
              没有匹配的款（换个款号 / 清掉「只看已加码」）
            </p>
          </div>
        </div>

        <div class="pk-shift__foot">
          <button
            v-if="filteredShiftRows.length > SHIFT_ROW_MAX"
            type="button"
            class="wb-link pk-shift__more"
            data-act="pk-shift-more"
            @click="showAllShiftRows = !showAllShiftRows"
          >
            {{ showAllShiftRows ? '收起' : `展开全部 ${filteredShiftRows.length} 款` }}
          </button>
          <span class="wb-muted pk-shift__foot-note">
            改完立刻按新码重算清单；已开的草稿单不自动改
          </span>
        </div>

        <p v-if="shiftStats.clampedRows > 0" class="pk-shift__warn" data-act="pk-shift-clamped">
          {{ shiftStats.clampedRows }} 行加码后超出码段，已按最大码拿（多个下单码会并到同一个码上）
        </p>
        <p v-if="shiftStats.unknownRows > 0" class="pk-shift__warn" data-act="pk-shift-unknown">
          {{ shiftStats.unknownRows }} 行的尺码认不出（如 F / 均码），没有加码，照原码拿
        </p>
      </div>
    </section>

    <div v-if="showMore" class="pk-more">
      <div class="pk-actions--wrap">
        <label class="pk-field">
          天数窗
          <input
            v-model.number="days"
            class="wb-input wb-input--sm pk-input--num"
            type="number"
            min="0"
            max="3650"
          />
          天（0 = 不限）
        </label>
        <select
          v-model="shopPick"
          class="wb-input wb-input--sm"
          data-act="shop-pick"
          :disabled="loading"
        >
          <option value="">全部店铺</option>
          <option v-for="s in shops" :key="s" :value="s">{{ s }}</option>
        </select>
        <label class="pk-field">
          <input v-model="includeShipped" type="checkbox" data-act="include-shipped" />
          连已发货一起看（对照用）
        </label>
      </div>
    </div>

    <p v-if="error" class="pk-error">
      {{ error }}
      <!-- 内嵌时页头不渲染、没有「生成」按钮 ⇒ 取数失败必须就地给一条重试，否则只能等数据变动 -->
      <button v-if="embedded" type="button" class="wb-link" data-act="retry" @click="generate">
        重试
      </button>
    </p>

    <!-- 空态分两种（UX 审查 D3/P0-3）：「还没生成过」是引导动作；「生成过但没货可拣」要说清为什么空。
         文案逐字保留（冒烟按 textContent 断言）。
         ⚠️ 2026-10-17 合并：判据从 `summary.groups.length` 换成 `hasCards` —— 只有拿货单、
         没有清单行的厂家（空白单 / 货已发完）也要占一张卡，否则那些单子在合并视图里看不见。 -->
    <div v-if="!hasCards && !loading" class="wb-empty pk-empty" data-act="empty">
      <span class="wb-empty__icon" v-html="ICON.empty"></span>
      <template v-if="!generated">
        <p class="wb-empty__title">还没生成过待拣清单</p>
        <p class="wb-empty__desc">
          点「生成待拣清单」→ 按未发货订单汇总出 图 / 款色码 / 件数 / 供应商
        </p>
      </template>
      <template v-else-if="summary.scanned">
        <p class="wb-empty__title">没有要拣的货</p>
        <!-- ⚠️ 2026-10-10：**按实际生效的那条口径分说**，不再把「已终结」与「超窗」并成一句。
             合并写法给出的两个动作各自只对一半场景有效（「连已发货一起看」对超窗毫无作用、
             「把天数窗调大」对已终结毫无作用）—— 用户照做一次没变化，只能认为这东西坏了。 -->
        <p class="wb-empty__desc">
          扫了 {{ summary.scanned }} 行未发货订单，{{ emptyReason.text }}
        </p>
        <div v-if="emptyReason.widen" class="wb-empty__actions">
          <button class="wb-btn wb-btn--primary" data-act="empty-widen" @click="widenDays">
            打开「更多」调天数窗
          </button>
        </div>
      </template>
      <template v-else>
        <p class="wb-empty__title">一行订单都没扫到</p>
        <p class="wb-empty__desc">
          这批条件下一行订单都没扫到 —— 若还没导过订单，去「发货台」的「待发货」页采集（芒果为主），
          或展开那里的「Excel 导入（备选）」导一份订单报表。
        </p>
        <div class="wb-empty__actions">
          <button class="wb-btn wb-btn--primary" data-act="empty-import" @click="goImport">
            去「待发货」页
          </button>
        </div>
      </template>
    </div>

    <!-- 2026-10-17 第三轮（用户反馈"三个区域不协调 / 卡片信息局促"）：**一种厂家卡 + 单宫格**。
         原形态是三个分区（待拿宫格卡 / 暂不拿灰条 / 已拿折叠列表）三种视觉语言 —— 同一屏上
         看着像三个人做的。现在：
           · **一个宫格**，按 待拿 → 暂不拿 → 已拿 排序（`orderedCards`），不再有分区标题；
           · 卡是**同一种**（同一外壳 / 圆角 / 边框），靠状态签与高矮区分：待拿全卡，
             暂不拿与已拿收成瘦卡（同格宽，一行高起）；
           · 款色行只留"照它拿货"要看的：**SKU 图 + 款名·颜色 + 尺码×件数 + 还差 + 忽略** ——
             款编码是内部身份（`data-key` 仍带，供拖拽/断言定位），**不在界面上展示**；
             **已拿完的款色整行不渲染**（2026-11-05 用户要求：这页只回答"还要拿什么"）；
             预估金额只在卡底合计行出现，缺口（缺图/缺供应商/无进价）由占位图与合计行的
             说明文字承担，不再逐行贴标签；
           · **已开单 + 复制/开单动作吸在卡底**（`margin-top:auto`）：宫格里多卡高矮不一，
             底部动作永远贴着卡底、横向对齐。
         拿货单是"照它付钱"的记录 ⇒ **不新增"标记已拿"开关**：拿没拿由已提交的单说话
         （生成拿货单 → 填价 → 提交 = "标记已拿"，撤销 = 删单，缺口自动回滚）。 -->
    <div v-else-if="hasCards" class="pu-grid" data-act="pu-grid">
      <template v-for="c in orderedCards" :key="c.supplierId">
        <!-- ── 待拿（全卡）：款色行（图 + 款名·颜色 + 尺码×件数）+ 合计 + 已开单 + 动作 ── -->
        <article
          v-if="c.zone === 'pending'"
          class="pu-scard"
          data-act="pu-scard"
          data-zone="pending"
          :data-supplier="c.supplierId"
          :class="{ 'is-drop-target': dropTarget === c.supplierId }"
          @dragover="onTileDragOver($event, c)"
          @dragleave="onTileDragLeave($event, c)"
          @drop="onTileDrop($event, c)"
        >
          <header class="pu-scard__head">
            <span class="pu-scard__name">{{ c.supplierName || '未指定厂家' }}</span>
            <!-- 厂家电话：桌面端没有"拨号"这事，一键=复制（粘到微信 / 拨号盘里） -->
            <span v-if="c.phone" class="pu-scard__phone">
              <span class="wb-muted">电话</span> {{ c.phone }}
              <button
                type="button"
                class="wb-link"
                :data-act="`pu-copy-phone-${c.supplierId}`"
                @click="copyPhone(c)"
              >
                复制
              </button>
            </span>
            <span class="pu-scard__spacer"></span>
            <span class="wb-tag is-warn">待拿</span>
          </header>

          <div class="pu-scard__rows">
            <!-- 只列还差 > 0 的款色（`shownRows`）——已拿完的行不再出现（2026-11-05）。
                 判据是**已提交拿货单**算出来的还差，不是本地开关：删单/撤销提交后它会自己回来。 -->
            <div
              v-for="r in c.shownRows"
              :key="r.key"
              class="pu-srow"
              data-act="pu-srow"
              :data-key="r.key"
              :data-style="r.styleCode"
              :class="{
                'is-off': r.ignored,
                'is-dragging': dragCode === r.styleCode && dragFrom === c.supplierId,
              }"
              :title="rowTitle(r)"
              :draggable="moveAction && r.styleCode ? true : undefined"
              @dragstart="onRowDragStart($event, r, c)"
              @dragend="onRowDragEnd"
            >
              <!--
                拖拽把手（2026-10-17 评审 P1：可发现性）。
                此前"行能拖到别家的格子上"的唯一线索是行 tooltip（要悬停才出现）⇒
                扫一眼页面没有任何"这些行可以拖"的信号，功能等于不存在。
                现在每行左缘常驻一个**极淡**的六点把手（常驻才叫线索，藏在 hover 里等于没有；
                淡到不抢款名）。未识别款 / 不接写通道时不渲染 —— 与 `draggable` 同一条件，
                不给一个拖不动的行画把手（那会是第二种假动作）。
              -->
              <span
                v-if="moveAction && r.styleCode"
                class="pu-srow__grip"
                data-act="pk-grip"
                aria-hidden="true"
              ></span>
              <!-- SKU 图：缩略图已在生成时合批取回（`thumbs`），这里只负责摆。
                   无图给占位框而不是藏掉 —— "这款没图"本身是要去补的信息（行上不再另贴「缺图」标签）。 -->
              <img v-if="thumbOf(r)" class="pu-srow__img" :src="thumbOf(r)" :alt="r.key" draggable="false" />
              <span v-else class="pu-srow__img pu-srow__img--none" v-html="ICON.noimg" aria-hidden="true"></span>
              <div class="pu-srow__main">
                <!-- 只留"照它拿货"要看的：款名 · 颜色（款编码是内部身份，不展示）+ 还差件数 -->
                <div class="pu-srow__top">
                  <span class="pu-srow__name">{{ rowName(r) }}</span>
                  <span v-if="r.styleName && r.color" class="pu-srow__color">{{ r.color }}</span>
                  <span class="pu-srow__spacer"></span>
                  <!-- 只剩两种：已忽略 / 还差 N 件（已拿完的行整行不渲染 ⇒ 不再有"已拿完"这一态） -->
                  <span class="pu-srow__qty">{{ r.ignored ? '已忽略' : `还差 ${r.remaining} 件` }}</span>
                </div>
                <div class="pu-srow__sub">
                  <!-- 尺码角标：`L×2` = 这一码**还要拿** 2 件；`L✓` = 已拿完。
                       tooltip 里是这一码的「需求 · 已拿 · 还差」三个数 —— 折叠展示，不丢数。 -->
                  <span class="pu-srow__sizes">
                    <span
                      v-for="s in r.sizes"
                      :key="s.size"
                      class="pk-chip"
                      :class="{ 'is-done': s.remaining <= 0, 'is-off': r.ignored }"
                      data-act="size-chip"
                      :data-size="s.size"
                      :title="chipTitle(s)"
                      >{{ chipText(s) }}</span
                    >
                  </span>
                  <!-- 行尾只发**意图**：确认弹层（要用户敲原因）与写库都在宿主（「拿货」页）——
                       本组件不认识 `purchase*` 写通道，也不该把确认弹层再实现一遍。
                       忽略按**款色**整组生效（`ignoreKey` 里没有码）⇒ 动作挂在款色行上。 -->
                  <span class="pu-srow__acts">
                    <!-- 指定厂家：拖拽落点只有"有清单行/有拿货单"的厂家，没拿过货的厂家没有格子
                         ⇒ 无厂家的款只能在这里指定。粒度是款级（`pl_products.supplier_id`），
                         载荷带该款款色数，宿主才能把"整款一起走"说全。 -->
                    <button
                      v-if="assignAction && !r.ignored && !r.supplierId && r.styleCode"
                      type="button"
                      class="wb-link"
                      :data-act="`pk-assign-${r.key}`"
                      @click="emit('assign-supplier', { styleCode: r.styleCode, styleName: r.styleName, colors: colorsOfStyle(r.styleCode) })"
                    >
                      指定厂家
                    </button>
                    <button
                      v-if="rowAction && !r.ignored"
                      type="button"
                      class="wb-link"
                      :data-act="`pk-ignore-${r.key}`"
                      @click="emit('ignore', { styleCode: r.styleCode, color: r.color, remaining: r.remaining })"
                    >
                      忽略
                    </button>
                    <button
                      v-else-if="rowAction"
                      type="button"
                      class="wb-link"
                      :data-act="`pk-unignore-${r.key}`"
                      @click="emit('unignore', { styleCode: r.styleCode, color: r.color })"
                    >
                      取消忽略
                    </button>
                    <!-- 亚洲款加码：这里只**标**不**设**（动作在上面的「款列表」里）。
                         为什么不留在款色行上做下拉：它是**款级**生效，挂在某个款色行上会让人以为
                         只改了这一个色（同款其余色一起变），改完才发现就晚了。点它跳过去并高亮。 -->
                    <button
                      v-if="r.styleCode && shiftOf(r.styleCode)"
                      type="button"
                      class="wb-link pk-rowshift"
                      :data-act="`pk-shift-goto-${r.key}`"
                      :title="`本款按 ${shiftText(shiftOf(r.styleCode))} 码拿货（同款所有颜色）—— 点这里去改幅度`"
                      @click="jumpToShift(r.styleCode)"
                    >
                      加码 {{ shiftText(shiftOf(r.styleCode)) }}
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <p class="pu-scard__sum">
            合计 {{ c.pending.colors }} 款色 · 待拿 {{ c.pending.pieces }} 件 ·
            {{ amountText(c.pending.amount, c.pending.noPricePieces, c.pending.pieces)
            }}{{ noPriceNote(c.pending.noPricePieces, c.pending.pieces) }}
          </p>

          <!-- 吸底块：已开单 + 三个动作永远贴卡底（宫格内多卡高矮不一，底部横向对齐）。
               已开单（宿主注入）：这一家已经开了哪些单、什么状态、多少钱 ——
               与"要拿什么"同卡对照；单子上的动作与旧「按订单」视图同一套 data-act。 -->
          <div class="pu-scard__bottom">
            <div v-if="c.orders.length" class="pu-scard__orders" data-act="pu-scard-orders">
              <div class="pu-scard__orders-head">
                <span class="pu-scard__orders-title">已开单</span>
                <!-- 再开一张（2026-11-05）：草稿不扣待拿 ⇒ 只按"还有待拿"渲染卡尾主按钮，会让人
                     在开过草稿后再点一次、得到第二张同内容的单。有草稿时主按钮改成"继续"，
                     真正的"我想再开一单（分批：这批只到一部分 / 隔几天补）"降到这里 ——
                     语义也在这：已经有一张，再加一张。 -->
                <button
                  v-if="supplierAction && c.pending.pieces > 0 && c.draftId"
                  type="button"
                  class="wb-link pu-scard__neworder"
                  data-act="pk-new-order"
                  :data-supplier="c.supplierId"
                  :title="`同一家厂再开一张（分批拿货：这次只到一部分、或隔几天再补）—— 现有草稿 #${c.draftId} 不会动`"
                  @click="emit('supplier-action', c.supplierId)"
                >
                  再开一张（{{ c.pending.pieces }} 件）
                </button>
              </div>
              <div v-for="o in c.orders" :key="o.id" class="pu-orow" :data-act="`pu-orow-${o.id}`">
                <span class="pu-orow__no wb-mono">#{{ o.id }}</span>
                <span class="pu-orow__date wb-muted">{{ o.bizDate }}</span>
                <span class="wb-tag" :class="o.status === 'submitted' ? 'is-on' : 'is-warn'">
                  {{ o.status === 'submitted' ? '已提交' : '草稿' }}
                </span>
                <!-- 包价单 2026-10-20 已删：单子只有"明细"一种形态，不再挂一个恒为"明细"的标签 -->
                <button
                  v-if="undecidedOf(o)"
                  type="button"
                  class="wb-tag is-warn pu-orow__undecided"
                  :data-act="`pu-undecided-${o.id}`"
                  :title="`这 ${undecidedOf(o)} 行买的时候还没定颜色 —— 它们扣不掉待拿（那边会一直显示待拿）。点这里去认色。`"
                  @click="emit('order-action', { kind: 'edit', id: o.id })"
                >
                  {{ undecidedOf(o) }} 行色未定
                </button>
                <span class="pu-orow__amount">¥{{ centsMoney(o.totalCents) }}</span>
                <span class="pu-orow__ops">
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-edit-${o.id}`"
                    @click="emit('order-action', { kind: 'edit', id: o.id })"
                  >
                    查看 / 编辑
                  </button>
                  <button
                    v-if="o.status !== 'submitted'"
                    type="button"
                    class="wb-link"
                    :data-act="`pu-submit-${o.id}`"
                    @click="emit('order-action', { kind: 'submit', id: o.id })"
                  >
                    提交
                  </button>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`pu-export-${o.id}`"
                    @click="emit('order-action', { kind: 'export', id: o.id })"
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    class="wb-link wb-link--danger"
                    :data-act="`pu-del-${o.id}`"
                    @click="emit('order-action', { kind: 'delete', id: o.id })"
                  >
                    删除
                  </button>
                </span>
              </div>
            </div>

            <footer class="pu-scard__acts">
              <!-- 两个复制**成组**（评审 P2）：此前三个按钮平级一行，扫读时分不清
                   「给厂家发图」与「留一份文字」是同一件事的两种形态；
                   现在它们贴在一起（组内 4px、与主动作隔开 8px），主次才读得出来。
                   用途写进 title —— 按钮上只留动作名（12px 图标会把三按钮挤出一行）。 -->
              <span class="pu-scard__copys">
                <button
                  type="button"
                  class="wb-btn wb-btn--sm"
                  data-act="pk-copy-text"
                  :data-supplier="c.supplierId"
                  title="文字清单：粘进聊天或备忘，字可以改"
                  @click="copyText(c)"
                >
                  复制拿货清单
                </button>
                <button
                  type="button"
                  class="wb-btn wb-btn--sm"
                  data-act="pk-copy"
                  :data-supplier="c.supplierId"
                  title="清单图：粘到微信直接发出去，厂家照图备货"
                  :disabled="copyingId !== null && copyingId === c.supplierId"
                  @click="copyForSupplier(c)"
                >
                  {{ copyingId !== null && copyingId === c.supplierId ? '生成中…' : '复制清单图' }}
                </button>
              </span>
              <!-- 主按钮两态（2026-11-05）：**有草稿 ⇒ 继续那张草稿**，没草稿 ⇒ 照旧生成新单。
                   判据是"这家厂有没有未提交的单"，不是"用户点过没有" —— 草稿不扣待拿
                   （`purchase-taken` 只算已提交），所以"还有 N 件待拿"与"已经开过一张"可以同时成立；
                   只按"还有待拿"渲染"生成拿货单"，第二次点就是同一批货的第二张单（用户 2026-11-05 提问的由来）。
                   "继续"走 `order-action:edit`，与"已开单"行上的「查看 / 编辑」是同一个动作，不新开通道。 -->
              <button
                v-if="supplierAction && c.pending.pieces > 0 && c.draftId"
                type="button"
                class="wb-btn wb-btn--sm wb-btn--primary"
                data-act="pk-continue-draft"
                :data-order="c.draftId"
                :data-supplier="c.supplierId"
                title="这张草稿还没提交（草稿不扣待拿）—— 接着填单价、提交，不必再开一张"
                @click="emit('order-action', { kind: 'edit', id: c.draftId })"
              >
                继续 #{{ c.draftId }} 草稿
              </button>
              <button
                v-else-if="supplierAction && c.pending.pieces > 0"
                type="button"
                class="wb-btn wb-btn--sm wb-btn--primary"
                data-act="pk-create-order"
                :data-supplier="c.supplierId"
                @click="emit('supplier-action', c.supplierId)"
              >
                生成拿货单（{{ c.pending.pieces }} 件）
              </button>
            </footer>
          </div>
        </article>

        <!-- ── 暂不拿（瘦卡，同一种外壳压灰）：款色全被忽略 + 用户标的忽略原因 ── -->
        <div
          v-else-if="c.zone === 'skip'"
          class="pu-scard pu-scard--mini pu-scard--skip"
          data-act="pu-scard"
          data-zone="skip"
          :data-supplier="c.supplierId"
          :class="{ 'is-drop-target': dropTarget === c.supplierId }"
          @dragover="onTileDragOver($event, c)"
          @dragleave="onTileDragLeave($event, c)"
          @drop="onTileDrop($event, c)"
        >
          <span class="pu-scard__name">{{ c.supplierName || '未指定厂家' }}</span>
          <span class="wb-tag">暂不拿</span>
          <span class="pu-scard__meta wb-muted">{{ skipText(c) }}</span>
          <span class="pu-scard__spacer"></span>
          <button
            type="button"
            class="wb-link"
            :data-act="`pu-skip-ignores-${c.supplierId}`"
            @click="emit('show-ignores')"
          >
            忽略清单
          </button>
        </div>

        <!-- ── 已拿 · 已开单（瘦卡）：没有待拿的厂家，单子行上管（编辑/提交/导出/删除）。
             不再默认折叠 —— 单宫格按序排在最后，"拿完的事"安静待在页尾但不消失。 ── -->
        <div
          v-else
          class="pu-scard pu-scard--mini pu-scard--done"
          data-act="pu-scard"
          data-zone="done"
          :data-supplier="c.supplierId"
          :class="{ 'is-drop-target': dropTarget === c.supplierId }"
          @dragover="onTileDragOver($event, c)"
          @dragleave="onTileDragLeave($event, c)"
          @drop="onTileDrop($event, c)"
        >
          <div class="pu-scard__head">
            <span class="pu-done__ok">✓</span>
            <span class="pu-scard__name">{{ c.supplierName || '未指定厂家' }}</span>
            <span class="wb-tag">已拿</span>
            <span class="pu-scard__meta wb-muted">{{ doneText(c) }}</span>
            <span class="pu-scard__spacer"></span>
          </div>
          <div v-for="o in c.orders" :key="o.id" class="pu-orow" :data-act="`pu-orow-${o.id}`">
            <span class="pu-orow__no wb-mono">#{{ o.id }}</span>
            <span class="pu-orow__date wb-muted">{{ o.bizDate }}</span>
            <span class="wb-tag" :class="o.status === 'submitted' ? 'is-on' : 'is-warn'">
              {{ o.status === 'submitted' ? '已提交' : '草稿' }}
            </span>
            <button
              v-if="undecidedOf(o)"
              type="button"
              class="wb-tag is-warn pu-orow__undecided"
              :data-act="`pu-undecided-${o.id}`"
              :title="`这 ${undecidedOf(o)} 行买的时候还没定颜色 —— 它们扣不掉待拿（那边会一直显示待拿）。点这里去认色。`"
              @click="emit('order-action', { kind: 'edit', id: o.id })"
            >
              {{ undecidedOf(o) }} 行色未定
            </button>
            <span class="pu-orow__amount">¥{{ centsMoney(o.totalCents) }}</span>
            <span class="pu-orow__ops">
              <button
                type="button"
                class="wb-link"
                :data-act="`pu-edit-${o.id}`"
                @click="emit('order-action', { kind: 'edit', id: o.id })"
              >
                查看 / 编辑
              </button>
              <button
                v-if="o.status !== 'submitted'"
                type="button"
                class="wb-link wb-link--strong"
                :data-act="`pu-submit-${o.id}`"
                @click="emit('order-action', { kind: 'submit', id: o.id })"
              >
                提交
              </button>
              <button
                type="button"
                class="wb-link"
                :data-act="`pu-export-${o.id}`"
                @click="emit('order-action', { kind: 'export', id: o.id })"
              >
                导出
              </button>
              <button
                type="button"
                class="wb-link wb-link--danger"
                :data-act="`pu-del-${o.id}`"
                @click="emit('order-action', { kind: 'delete', id: o.id })"
              >
                删除
              </button>
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「拣货」视图（2026-10-17 合并重设计）：一键生成 → 按款色汇总"要拿什么、各几件、图与供应商在哪、
// 大概多少钱" → **按厂家分卡**（一张卡 = 一家厂：待拿款色行 + 已开单 + 复制/开单动作）→ 导出带图 xlsx。
//
// **2026-10-17 第二轮（合并之后）：宫格 + SKU 图 + 拖拽改厂家**：
//   · 厂家卡从"一家一张全宽卡竖排"改成**宫格**（一个厂家一个宫格，auto-fill 最小列宽，现为 324）——
//     厂家一多就得整页滚，且"哪家还有什么"要逐张读完才比得出来；
//   · 款色行加 **SKU 缩略图**（生成时已合批取回的那批 `thumbs`，这里只负责摆）；
//     无图给虚线占位框 —— "这款没图"是要去补的信息，不藏行；
//   · 款色行可**拖到别家的格子**：宿主按款编码改 `pl_products.supplier_id`（`move-supplier` 意图）。
//     ⚠️ 写是**款级**的（厂家挂在款上，不挂在款色上）⇒ 拖一行 = 这一款的所有款色一起走，
//        载荷带 `colors` 让宿主把"整款一起移动"说给用户听；
//   · 未指定厂家（supplierId 0）是合法落点（拖过去 = 取消关联）；未识别款（无款编码）不能拖。
//
// 口径（别改，与订单利润页**同一份实现**）：
//   · 件数 `resolveQty`（结算商品行真值 → 报表块 `商品数量` → 按 1 件并标缺）；
//   · 分组键 `skuKey`（款 × 色 × 码，缺哪段标哪段）；
//   · 进价 `positiveCents` 三级回落（订单行实际进价 → 订单行进价预估 → 产品当前价），
//     与「统计」页的差别只在最后一级：**拣货是"要花多少钱"的经营估算**，老行还没有预估快照时
//     用产品当前价兜一下；利润页则只认行级两个快照（历史口径不能跟着产品改价漂移）。
//   · 范围：**未发货**（宿主按机械事实筛）+ **近 30 天** + **已终结（关闭/已完成）不拣**（`bucketOfStatus`）。
// 界面上把默认条件写成标签（含被剔除的行数），缺件数/缺图/缺供应商/无进价逐行标 ——
// 拣货单是"照它干活"的东西，少一行就是少发一件货、漏一个价就是少带一笔钱。
//
// 取数三路（全部经 core 服务，视图内零算术）：
//   1. 订单行投影（含三层回落后的图 + 两个行级成本字段）→ `pickingRows`
//   2. 结算商品行件数                → `settleOrders`（键口径 `settleQtyKey`）
//   3. 缩略图（合批一次往返）        → `orderImageThumbBatch`
//   动作：导出 `pickingExportExcel`（主进程 exceljs）· 复制清单图 `writeClipboardImage`
//         · 复制文字清单 `writeClipboard`（模型 `sheetTextOf`，与图/屏上/xlsx 同源）。
//
// **2026-10-17 合并（「要拿什么」×「拿了什么」→ 按厂家单页）**：
// 本视图从"款色卡网格 + 底部汇总条"改成"厂家卡列表"。为此宿主（「拿货」页）注入三样本视图
// 没有的东西：各厂家的**拿货单**（`supplierOrders`，卡上"已开单"那一截）、**忽略原因**
// （`ignoreReasons`，"暂不拿"瘦卡要说清为什么）、**厂家电话**（`supplierPhones`）。
// 单子上的动作（编辑/提交/导出/删除）本视图**只发意图**（`order-action`）—— 确认弹层与写库都在宿主，
// 与既有的 `ignore` / `supplier-action` 同一规矩（本组件不认识 `purchase*` 写通道）。
// **2026-10-17 第三轮（用户反馈"三区不协调 / 行信息局促 / 卡底动作要固定"）**：
// 三分区撤掉 → **单宫格一种卡**（待拿 → 暂不拿 → 已拿 排序，瘦卡与全卡同一外壳）；
// 款色行瘦身（图 + 款名·颜色 + 尺码×件数 + 忽略；款编码/金额/缺口/涉及订单不再上卡）；
// 已开单 + 复制/开单动作 `margin-top:auto` 吸卡底。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { writeClipboard, writeClipboardImage } from '@/core/services/clipboard';
import * as ipc from '@/core/services/ipc';
import {
  aggregatePicking,
  DEFAULT_PICKING_DAYS,
  groupByColor,
  ignoreKey,
  pendingRollup,
  takenKeyOf,
  type PendingRollup,
  type PickingColorGroup,
  type PickingGroup,
  type PickingSizeCell,
  type PickingSupplierGroup,
  type PickingSummary,
} from '@/lib/picking';
import { settleQtyKey, type SettleQtyInfo } from '@/lib/orderCost';
import { applySizeShift, sizeChain, SIZE_SHIFT_OPTIONS, type SizeShiftStats } from '@/lib/sizeShift';
import { domToJpeg, encodeImagesForExport, sizeQtyBadge } from '@/lib/pickingExport';
import {
  amountText,
  centsMoney,
  noPriceNote,
  renderSheetPng,
  sheetImageModelOf,
  sheetModelOf,
  sheetTextOf,
} from '@/lib/pickingSheet';
import type { IgnoreRow, PurchaseOrder, TakenRow } from '@/types';

/**
 * `embedded` = 被「发货台」页的页签内嵌（藏掉本页自己的页头，避免"标题下面又一个标题"）。
 * `refreshToken` = 宿主的数据版本号：订单/映射一变，`today` 那边 +1 ⇒ 本页跟着重算。
 *   为什么必须有它：页签是 `KeepAlive` 保活的，不重算就会**一直显示刚才那份清单**——
 *   保活的代价（看到旧数据）必须这样还回去。
 * `auto` = 挂载即生成（**由外层显式指定**，不按"是否内嵌"隐式推断）。
 *   为什么单独一个 prop 而不是"内嵌就自动"：两种宿主对"这一屏是什么"的回答不同 ——
 *   独立页是**快照工具**（进页面不动手就不该取数，冒烟钉着"首屏不自动取数"）；
 *   而并进「拿货」后它是那一步的**入口视图**（"要拿什么"应当一眼可读，还得让
 *   「按此生成拿货单」有东西可拿）⇒ 两种语义都真实存在，写成一个 prop 才不会互相改坏。
 * `rowAction` = 款色行给「忽略 / 取消忽略」链接（宿主提供，本组件只发意图，不碰拿货数据）。
 * `supplierAction` = 卡上给「生成拿货单（N 件）」/「继续 #N 草稿」（宿主提供，本组件只发意图）。
 *   两态（2026-11-05）：该厂有未提交的草稿时主按钮是「继续 #N 草稿」（发 `order-action:edit`），
 *   「再开一张」降为"已开单"标题旁的链接（发 `supplier-action`）；没有草稿时才直接给「生成拿货单」。
 *   为什么必须分：草稿不扣待拿 ⇒ "还有 N 件"与"已经开过一张"同时成立，只按前者渲染会让用户
 *   连点两次得到两张同内容的单（2026-11-05 用户提问的由来）。
 *   为什么钉在**厂家卡**上而不是页级一个按钮：一张拿货单只能挂**一个厂家**（下游按厂家发单/对账），
 *   页级按钮必然先拉一个"选厂家"的下拉——那一步对用户是白问的，数据里已经分好卡了。
 * `supplierOrders` = 宿主注入的各厂家拿货单（按 supplierId；草稿 + 已提交）。
 *   只有单子、没有清单行的厂家也据此占一张"已拿 · 已开单"卡 —— 否则空白单 / 货已发完的单
 *   在合并视图里看不见、也管不动（单子管理本来就都在卡上）。
 * `ignoreReasons` = 宿主注入的忽略原因（键 = `ignoreKey(款编码, 款色)`）—— "暂不拿"区要说清为什么。
 * `supplierPhones` = 宿主注入的厂家电话（supplierId → 电话；空串 = 没录，不渲染那一格）。
 * `moveAction` = 款色行可**拖到别家**（宿主提供写通道，本组件只发意图）。
 *   为什么是一个独立开关而不是搭 `rowAction`：拖拽改的是**款主数据**（`pl_products.supplier_id`），
 *   与"忽略"是两件不相干的事；宿主没接这个能力时行就不该看起来能拖（假控件）。
 * `fixAction` = 「未归类」提示条里给「选产品并归款」（宿主提供写通道，本组件只发商品ID 意图）。
 *   为什么单独一个开关：这条动作改的是**产品域的映射**（`pl_sku`），不是拿货数据；
 *   宿主没接时按钮不渲染（否则又是一个点不动的假控件）。
 * `assignAction` = 「未指定厂家」的款色行给一个「指定厂家」入口（宿主提供写通道，本组件只发意图）。
 *   为什么必须有：拖拽的落点只来自**有清单行/有拿货单**的厂家，而"还没拿过货的厂家"根本没有格子
 *   ⇒ 无厂家的款色只能拖到别家、不能指定给新厂家（用户实报"指定不了"）。
 *   与 `moveAction` 同一件事的另一半（都是改 `pl_products.supplier_id`），所以粒度也是**款级**。
 */
const props = withDefaults(
  defineProps<{
    embedded?: boolean;
    refreshToken?: number;
    auto?: boolean;
    rowAction?: boolean;
    supplierAction?: boolean;
    supplierOrders?: Record<number, PurchaseOrder[]>;
    ignoreReasons?: Record<string, string>;
    supplierPhones?: Record<number, string>;
    moveAction?: boolean;
    fixAction?: boolean;
    assignAction?: boolean;
  }>(),
  {
    embedded: false,
    refreshToken: 0,
    auto: false,
    rowAction: false,
    supplierAction: false,
    supplierOrders: () => ({}),
    ignoreReasons: () => ({}),
    supplierPhones: () => ({}),
    moveAction: false,
    fixAction: false,
    assignAction: false,
  }
);

/**
 * `go-import`  空态里的「去导订单」（内嵌时外层接管；本组件不认识页签，只发一个意图）
 * `generated`  清单重算完成 → 把**这一份**清单交给外层（「拿货」据此开单：只取本视图算过的同一批组）
 * `ignore` / `unignore`  款色行上动作的**意图**（真正的写库与确认弹层由宿主做：
 *   本组件不认识 `purchase*` 写通道，也不该把确认弹层再实现一遍）。
 *   ⚠️ 忽略是**整款色**生效的（同 `lib/picking` 的 `ignoreKey`）⇒ 载荷不带 `size`；
 *   带上反而让宿主以为"只忽略这一码、别的码继续要"。
 * `supplier-action`  卡上「生成拿货单」的意图（载荷 = 厂家 id，只发厂商、不带明细：
 *   明细由宿主从**自己刚算过的同一份清单**里取，避免"按钮说 12 件、单里 14 件"两套口径）
 * `order-action`  卡上"已开单"里某个动作的意图（编辑/提交/导出/删除；宿主认单号）。
 *   全卡与瘦卡上的单子行是**同一套 data-act**（`pu-*-${单号}`）。
 * `show-ignores`  「暂不拿」区的「忽略清单」链接：让宿主把页级的忽略清单展开（本视图不管它）。
 * `move-supplier` 把一款拖到别家的**意图**（载荷 = 款编码 / 款名 / 从哪家到哪家 / 该款几个款色）。
 *   写库在宿主（`pl_products.supplier_id` 是产品域主数据，本组件不认识产品域写通道）。
 *   ⚠️ 粒度是**款级**的（厂家挂在款上，不挂在款色上）⇒ 载荷必须带 `colors`：
 *      宿主只有知道"这一款一共几个款色一起走"，才能把话说全（否则用户以为只拖走了看见的那一行）。
 * `fix-unclassified` 「未归类」行上「选产品并归款」的意图（载荷 = 商品ID / 件数 / 店铺）。
 *   写库在宿主（产品域映射 `pl_shop_sku`）；本组件只把"要修哪一条"说清。
 * `assign-supplier` 「未指定厂家」行上「指定厂家」的意图（载荷 = 款编码 / 款名 / 该款几个款色）。
 *   写库在宿主（`pl_products.supplier_id`；款级），与 `move-supplier` 共用同一条写通道。
 */
const emit = defineEmits<{
  (e: 'go-import'): void;
  (e: 'generated', groups: PickingGroup[]): void;
  (e: 'ignore', row: { styleCode: string; color: string; remaining: number }): void;
  (e: 'unignore', row: { styleCode: string; color: string }): void;
  (e: 'supplier-action', supplierId: number): void;
  (e: 'order-action', intent: { kind: 'edit' | 'submit' | 'export' | 'delete'; id: number }): void;
  (e: 'show-ignores'): void;
  (
    e: 'move-supplier',
    intent: {
      styleCode: string;
      styleName: string;
      fromSupplierId: number;
      toSupplierId: number;
      /** 该款在清单里一共几个款色（写是款级的 ⇒ 它们一起走） */
      colors: number;
    }
  ): void;
  (e: 'fix-unclassified', intent: { itemId: string; pieces: number; shops: string[] }): void;
  (e: 'assign-supplier', intent: { styleCode: string; styleName: string; colors: number }): void;
}>();

/** 空态图标（内联 SVG，跟随 currentColor） */
const ICON = {
  empty:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/><path d="M8 10.2v4"/></svg>',
  // 款色行上的"这款没图"占位（虚线框 + 山形图标）：缺图是要去补的信息，不藏行
  noimg:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.4"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>',
};

const loading = ref(false);
const error = ref('');
/** 本页是否**生成过**：空态要分"还没点过"与"点了但没货可拣"两种（后者得说清为什么） */
const generated = ref(false);
/** 低频筛选默认收起（界面精简）：天数窗 / 店铺 / 含已发货 */
const showMore = ref(false);
const days = ref(DEFAULT_PICKING_DAYS);
const shopPick = ref('');
const includeShipped = ref(false);
const shops = ref<string[]>([]);
/** 款色行 tooltip 之外的临时态已全部随第三轮精简撤掉（涉及订单展开 / 已拿折叠） */

/** 缩略图边长：96 太小 —— 导出时要以它为准转 JPEG 嵌进 Excel（发厂家看图认货），
 *  且**尺码×件数角标要烧进图里**（角标字号按图短边的比例算，图太小字就糊了）；
 *  200 在卡片里也更清晰。 */
const THUMB_EDGE = 200;
/** 缩略图缓存：本地路径 → dataUrl（同款色的多卡共用一张，合批只取一次） */
const thumbs = ref<Record<string, string>>({});

const EMPTY: PickingSummary = aggregatePicking([], { today: '' });
const summary = ref<PickingSummary>(EMPTY);

/* ---- 未归类（2026-10-20）------------------------------------------------------------
 * 这些订单行没有款色归属：件数**照常进统计**（排除 = 悄悄少算，远比如实标注危险），
 * 但它们扣不掉"已拿"、也取不到图。界面必须先把"数不准"说出来，再给修复入口 ——
 * 修的是**商品ID**（选中产品 ⇒ 该商品的全部历史订单自动回填款色），一次修一批。
 */
const showUnclassified = ref(false);
const unclassifiedRows = computed(() => summary.value.unclassifiedItems ?? []);
const unclassifiedPieces = computed(() =>
  unclassifiedRows.value.reduce((sum, it) => sum + it.pieces, 0)
);

/* ---- 亚洲款加码（2026-11-02）----------------------------------------------------------
 * 口径：只有**拿货侧**的尺码被换（下单 L → 拿 XL）；订单原文、利润、发货台一个字不动。
 * 换算必须在 `aggregatePicking` **之前**做 —— 清单的尺码格、开单明细（`g.size`）、已拿抵扣、
 * 导出全部读聚合后的 `size`，改在后面就要在五处各改一遍，且必然有一处忘掉。
 *
 * ⭐ 第二次改（用户口径）：**设置动作集中在本页的「款列表」里**，按**款**列出、逐款设幅度，
 *    不再挂在每个款色行的操作条上。三条理由：
 *    ① 行内那个下拉挂在**款色行**上、生效却是**款级**（同款三个色一起变）—— 语义错位，
 *       用户会以为只改了眼前这一个色；
 *    ② 幅度是**按客户反馈反复调**的（+1 不够就 +2），调的时候视线在页面上、心里记着"哪几款"，
 *       需要一处能把"哪几款 · 现在几码 · 待拿几件"连现状一起看全，而不是逐行翻；
 *    ③ 款列表列的是**本批所有款**，所以它同时也是"入口"：上一版把入口藏在"有加码才显示"的
 *       提示条里，结果**第一批款永远加不上码**（没有加码款 ⇒ 提示条不渲染 ⇒ 没有下拉）。
 *    行内只留一个只读标记（`+2 码`），点它跳到款列表里那一款并高亮 —— 感知在行上，动作在列表里。
 */
const shiftStats = ref<SizeShiftStats>({
  shiftedRows: 0,
  shiftedStyles: 0,
  clampedRows: 0,
  unknownRows: 0,
  styles: [],
});
/** 本次清单读到的「款 → 偏移」：款列表下拉的当前值，也是重算时的输入 */
const shiftMap = ref<Record<string, number>>({});
/** 款名取**本批订单行**的 `styleName`：拿货页的款常常还没入库，不能指望 `pl_products` 给名字 */
const shiftNames = ref<Record<string, string>>({});

/** 款列表的一行（**款级**，不是款色级） */
interface StyleShiftRow {
  styleCode: string;
  styleName: string;
  /** 本批该款的款色数 */
  colors: number;
  /** 需求件数（Σ 各色） */
  pieces: number;
  /** 待拿件数（Σ 未忽略的还差） */
  remaining: number;
  shift: number;
  /** 本款撞到码段边界的行数 / 尺码认不出的行数 */
  clampedRows: number;
  unknownRows: number;
  /** 整款都被标了「暂不拿」—— 加码照样生效，但要说明"清单上不会多出来" */
  ignored: boolean;
  /**
   * 款图（款级只有一张）：取本批该款**首个有图**的款色的 `imagePath`。
   * 为什么不按"件数最多 / 第一个色"取：同款各色的图常常不一样（不同色拍不同张），
   * 而款列表是按款号升序的稳定顺序 —— 取"本批第一个有图的色"是唯一不随件数变的可解释口径
   * （件数一变主图就换，用户会以为图配错了）。图只用于**认货**，不承担"这是哪个色"的职责。
   */
  imagePath: string;
  /** 上面那张图属于哪个色（tooltip 用：同款多色时得说清图取自重哪一张） */
  imageColor: string;
}

/**
 * 款列表：**本批所有款**（不只是加了码的）。
 * 顺序按**款号升序**：稳定。按件数排或"已加码优先"排，都会在改完一个档位之后重排，
 * 用户刚点的那一行跳走 ⇒ 以为改错了。已加码靠左侧色条 + `+N 码` 标记"感知"，不靠位置。
 */
const styleShiftRows = computed<StyleShiftRow[]>(() => {
  const stat = new Map(shiftStats.value.styles.map((s) => [s.styleCode, s]));
  const agg = new Map<string, StyleShiftRow>();
  for (const r of groupByColor(summary.value.groups)) {
    const code = String(r.styleCode ?? '');
    if (!code) continue;
    const cur = agg.get(code) ?? {
      styleCode: code,
      styleName: r.styleName || shiftNames.value[code] || '',
      colors: 0,
      pieces: 0,
      remaining: 0,
      shift: shiftOf(code),
      clampedRows: stat.get(code)?.clampedRows ?? 0,
      unknownRows: stat.get(code)?.unknownRows ?? 0,
      // 先按"整款被忽略"假设，遇到任一款色未忽略就翻过来（忽略键是款色级，款级只是汇总）
      ignored: true,
      imagePath: '',
      imageColor: '',
    };
    cur.colors += 1;
    cur.pieces += r.pieces;
    if (!r.ignored) {
      cur.remaining += r.remaining;
      cur.ignored = false;
    }
    if (!cur.styleName && r.styleName) cur.styleName = r.styleName;
    // 款图取"本批第一个有图的色"：一旦取到就不再覆盖（见 `StyleShiftRow.imagePath` 头注）
    if (!cur.imagePath && r.imagePath) {
      cur.imagePath = r.imagePath;
      cur.imageColor = r.color;
    }
    agg.set(code, cur);
  }
  return [...agg.values()].sort((a, b) =>
    a.styleCode < b.styleCode ? -1 : a.styleCode > b.styleCode ? 1 : 0
  );
});

/**
 * 款列表一屏最多铺几行（再多给「展开全部」）。
 * ⚠️ 与 `.pk-shift__rows` 的 `max-height` **同源**：10 行 × 45px（上下内边距 4+4 +
 *    款图 36 + 分割线 1；行内 `wb-input--sm` 控件 28 比图矮、不决定行高）。行数或行高改一边、
 *    另一边不改，就会出现"一屏 N 行"实际只看到六七行的裁切（用户实报过两次）。
 *    2026-11-03 加款图：行高 37 → 45、行数 12 → 10（总高 444 → 450，面板整体高度基本不变）。
 */
const SHIFT_ROW_MAX = 10;
const shiftQuery = ref('');
const onlyShifted = ref(false);
const showAllShiftRows = ref(false);

const filteredShiftRows = computed(() => {
  const q = shiftQuery.value.trim().toLowerCase();
  return styleShiftRows.value.filter((r) => {
    if (onlyShifted.value && !r.shift) return false;
    if (!q) return true;
    return r.styleCode.toLowerCase().includes(q) || r.styleName.toLowerCase().includes(q);
  });
});
const visibleShiftRows = computed(() =>
  showAllShiftRows.value
    ? filteredShiftRows.value
    : filteredShiftRows.value.slice(0, SHIFT_ROW_MAX)
);

/**
 * 面板展开态：**用户手动点过就以用户的为准**，没点过跟随"本批有没有加码款"
 * （有 ⇒ 自动展开，让用户看到"这批加了码"；没有 ⇒ 折成一行，不占版面，但标题就是入口）。
 */
const shiftPanelUser = ref<boolean | null>(null);
const shiftPanelOpen = computed(
  () => shiftPanelUser.value ?? shiftStats.value.shiftedStyles > 0
);
function toggleShiftPanel(): void {
  shiftPanelUser.value = !shiftPanelOpen.value;
}

/** 行内标记 → 跳到款列表并高亮 1.6s（淡出靠 CSS 过渡；用 ref 存定时器避免连点堆一串） */
const shiftPanelRef = ref<HTMLElement | null>(null);
const shiftFocusCode = ref('');
let shiftFocusTimer = 0;
async function jumpToShift(styleCode: string): Promise<void> {
  shiftPanelUser.value = true;
  // 被"只看已加码"/搜索过滤掉的款跳过去会是一片空 ⇒ 清掉过滤再跳
  if (onlyShifted.value || shiftQuery.value) {
    onlyShifted.value = false;
    shiftQuery.value = '';
  }
  shiftFocusCode.value = styleCode;
  await nextTick();
  shiftPanelRef.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  window.clearTimeout(shiftFocusTimer);
  shiftFocusTimer = window.setTimeout(() => {
    shiftFocusCode.value = '';
  }, 1600);
}

/** `+2` / `-1`（负数留给减码；0 不该出现在标记里） */
function shiftText(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * 标题：**行数为 0 时不能说"（0 行）"** —— 整款都封顶/认不出时款是真的加了码，
 * 写 0 行会读成"设置没生效"（用户会回去再点一遍）。此时改说"本批没有一行能加"，
 * 与下面那条封顶/认不出的说明接上。
 */
const shiftTitle = computed(() => {
  const s = shiftStats.value;
  if (!s.shiftedStyles) return '本批没有加码的款';
  if (s.shiftedRows > 0) return `${s.shiftedStyles} 款已加码（${s.shiftedRows} 行）`;
  return `${s.shiftedStyles} 款已设加码，本批没有一行能加`;
});

function shiftOf(styleCode: string): number {
  return shiftMap.value[styleCode] ?? 0;
}

/**
 * 改加码：**写产品域通道 + 立刻重算**。
 *
 * 为什么入口放在拿货页（而不是只放产品档案）：发现"这牌是亚洲款"的时刻就是**看清单的时候**，
 * 让人切到产品页找这款、改完再切回来，实际上没人会去改，最后就是照错码拿货。
 * 写的是产品域主数据（`pl_size_shift`），本组件直接调（与读同一通道），不经宿主转发。
 */
async function onShiftChange(styleCode: string, ev: Event): Promise<void> {
  if (!styleCode) return;
  const shift = Math.trunc(Number((ev.target as HTMLSelectElement)?.value) || 0);
  const r = await ipc.productSizeShiftSet({ styleCode, shift });
  if (!r.success) {
    toast(r.error || '设置加码失败', 'error');
    return;
  }
  if (shift) shiftMap.value = { ...shiftMap.value, [styleCode]: shift };
  else {
    const next = { ...shiftMap.value };
    delete next[styleCode];
    shiftMap.value = next;
  }
  toast(
    shift
      ? `已设「${styleCode}」加 ${shift} 码 —— 清单按新码重算；已开的草稿单不自动改`
      : `已取消「${styleCode}」的加码`,
    'success'
  );
  await generate();
}

/** 天数窗的中文说法。
 * ⚠️ `0` **不能说成「近 0 天」** —— 它的含义是"不限"（`cutoffDate` 见 `lib/picking`），
 * 说成 0 天会读成"只看今天的单"，正好相反。
 */
function daysText(d: number): string {
  return d > 0 ? `近 ${d} 天` : '不限天数';
}

/**
 * 界面的**行动单位是"厂家一张卡"**（2026-10-17 合并重设计）：同厂家的所有款色折进一张卡，
 * 卡内一行一个款色（尺码并排成小格）。段（厂家）之间沿用 `summary.suppliers` 的顺序
 * （未指定厂家整段排最后）；分区由 `zoneOf` 判（待拿 > 已拿 > 暂不拿）。
 */
interface SupplierCard {
  supplierId: number;
  supplierName: string;
  /** 该厂的全部款色行（含已拿完 / 已忽略 —— 统计口径要全，不只是要显示的那些） */
  rows: PickingColorGroup[];
  /**
   * **卡上真正渲染的行** = 还差 > 0 的款色（含被忽略的，它们要能就地取消忽略）。
   *
   * 已拿完（`remaining <= 0`）的行不再出现（2026-11-05 用户要求）：这一页的活是"还要拿什么"，
   * 拿满的行昨天还占着一整块版面，扫一眼分不清"这行还要不要管"。
   * ⚠️ 与 `rows` 分开而不是直接过滤 `rows`：卡合计、已拿件数、忽略数都按**全部**行算 ——
   *    只留一个数组，迟早有人拿被过滤过的那份去求和，合计就会随"看不看得见"变化。
   * ⚠️ 消失不是删除：拿满的依据是**已提交拿货单**（`purchase-taken`），删单 / 撤销提交后
   *    `remaining` 回升，下一次重算（`bump` ⇒ `refreshToken`）这行自己回来。
   */
  shownRows: PickingColorGroup[];
  /** 待拿合计（口径 = `pendingOf` 的款色折叠版；卡面合计行与「生成拿货单（N 件）」同源） */
  pending: PendingRollup;
  /** 被忽略且还差 > 0 的款色数（"暂不拿"区的口径） */
  ignoredColors: number;
  /** 已拿件数合计（Σ 各款色行 taken；"已拿"区的一行摘要用） */
  takenPieces: number;
  /** 宿主注入的该厂拿货单（草稿 + 已提交，按日期倒序） */
  orders: PurchaseOrder[];
  /**
   * 该厂**最近一张草稿**的单号（0 = 没有草稿）—— 卡尾主按钮据此分流。
   *
   * 为什么界面非要知道它：**草稿不扣待拿**（`purchase-taken` 只算已提交），所以"还差多少件"
   * 在开过草稿之后仍然照旧 ⇒ 卡尾若一直叫「生成拿货单（N 件）」，用户再点一次就得到
   * **第二张内容完全相同的草稿**（2026-11-05 用户问"为什么能生成多个拿货单"时确认的洞）。
   * 有草稿时主按钮改成「继续 #N 草稿」（走 `order-action:edit`，与"已开单"行同一个动作），
   * 「再开一张」降为"已开单"标题旁的次要入口 —— 真分批照样开得出来，重复开单要多一步。
   */
  draftId: number;
  phone: string;
  zone: 'pending' | 'skip' | 'done';
}

const EMPTY_ROLLUP: PendingRollup = { colors: 0, pieces: 0, amount: 0, noPricePieces: 0 };

/** 单子排序：日期倒序 → 单号倒序（新的在前；同一天开的单看单号） */
const byOrderRecency = (a: PurchaseOrder, b: PurchaseOrder): number =>
  b.bizDate < a.bizDate ? -1 : b.bizDate > a.bizDate ? 1 : 0 || b.id - a.id;

/**
 * 分区判据（方案三态的落地）：
 *   · **待拿**：还有还差 > 0 且未忽略的款色 —— 不管有没有开过单（开了草稿也还是待拿）；
 *   · **已拿 · 已开单**：没有待拿，但有**已提交**的单（"拿过"由单说话，不由开关说）；
 *   · **暂不拿**：没有待拿、没有已提交单，但**有被忽略**的款色（灰条 + 原因）；
 *   · 其余（只剩草稿 / 已拿完但无单）落「已拿 · 已开单」—— 那一区的标签本就含"已开单"。
 */
function zoneOf(c: Omit<SupplierCard, 'zone'>): 'pending' | 'skip' | 'done' {
  if (c.pending.colors > 0) return 'pending';
  if (c.orders.some((o) => o.status === 'submitted')) return 'done';
  if (c.ignoredColors > 0) return 'skip';
  return 'done';
}

/** 该厂最近一张草稿的单号（0 = 没有草稿）；`orders` 已按 `byOrderRecency` 排过 ⇒ 取第一条命中的 */
function draftIdOf(orders: PurchaseOrder[]): number {
  return orders.find((o) => o.status !== 'submitted')?.id ?? 0;
}

const supplierCards = computed<SupplierCard[]>(() => {
  const out: SupplierCard[] = summary.value.suppliers.map((sg: PickingSupplierGroup) => {
    const rows = groupByColor(sg.groups);
    const orders = [...(props.supplierOrders?.[sg.supplierId] ?? [])].sort(byOrderRecency);
    const card = {
      supplierId: sg.supplierId,
      supplierName: sg.supplierName,
      rows,
      // 只滤"拿完的"：忽略行 remaining 仍 > 0（忽略不扣需求），照旧显示（要能就地取消忽略）
      shownRows: rows.filter((r) => r.remaining > 0),
      pending: pendingRollup(rows),
      ignoredColors: rows.filter((r) => r.ignored && r.remaining > 0).length,
      takenPieces: rows.reduce((n, r) => n + r.taken, 0),
      orders,
      draftId: draftIdOf(orders),
      phone: props.supplierPhones?.[sg.supplierId] ?? '',
    };
    return { ...card, zone: zoneOf(card) };
  });
  // 只有拿货单、没有清单行的厂家（空白单 / 货已发完）也要占一张卡：
  // 否则那些单子在合并视图里看不见、也管不动。
  const seen = new Set(out.map((c) => c.supplierId));
  for (const [sid, list] of Object.entries(props.supplierOrders ?? {})) {
    const id = Number(sid);
    if (!id || seen.has(id) || !list || !list.length) continue;
    const orders = [...list].sort(byOrderRecency);
    const card = {
      supplierId: id,
      supplierName: list[0]?.supplierName ?? '',
      rows: [],
      shownRows: [],
      pending: EMPTY_ROLLUP,
      ignoredColors: 0,
      takenPieces: 0,
      orders,
      draftId: draftIdOf(orders),
      phone: props.supplierPhones?.[id] ?? '',
    };
    out.push({ ...card, zone: zoneOf(card) });
  }
  return out;
});

/** 宫格排序（2026-10-17 第三轮统一卡）：待拿 → 暂不拿 → 已拿；同档保持清单顺序（有厂家在前）。 */
const ZONE_RANK: Record<SupplierCard['zone'], number> = { pending: 0, skip: 1, done: 2 };
const orderedCards = computed(() =>
  [...supplierCards.value].sort((a, b) => ZONE_RANK[a.zone] - ZONE_RANK[b.zone]),
);
/** 有没有卡可渲染（空态判据）：清单行或注入的单子，至少占一样 */
const hasCards = computed(() => supplierCards.value.length > 0);

/**
 * 全页待拿总账 = **待拿**（还差 > 0 且未忽略）—— 与「生成拿货单（N 件）」同一判据（`pendingRollup`）。
 *
 * ⚠️ 为什么不用 `summary.remainingGroups / remainingPieces`：那两个含被忽略的组
 * （它们的定义是"总需求还差多少"）。两套数同时出现就会出现"区标题说 4 件、按钮说 2 件"——
 * 用户没有任何办法判断哪个是对的。
 */
const pending = computed(() => pendingRollup(groupByColor(summary.value.groups)));

/**
 * 正在生成/写剪贴板的厂家 id。**空闲是 `null`，不是 `0`**（2026-10-17 评审 P0 修）。
 * 原先拿 0 当哨兵，但「未指定厂家」卡的 `supplierId` 恰好是 0 ⇒
 * `copyingId === c.supplierId` 恒真 ⇒ 那张卡的「复制清单图」**永远显示「生成中…」且禁用**
 * （1440/1152 两组截图都已见证）。哨兵必须取业务 id 取值域之外的那个值。
 */
const copyingId = ref<number | null>(null);

/**
 * 「复制清单图」：把**这一家**的待拿行画成一张清单图，写进系统剪贴板（用户粘到微信里发出去）。
 * 为什么是图而不是文字：对方要照着备货，图里是「号码 + 图 + 颜色 + 尺码×件数 + 件数」的版式 ——
 * 纯文字粘进微信会丢版式，截屏又会把页签、别家的货一起发出去（见 `lib/pickingSheet` 头部）。
 * 数字全部与屏上同源（`sheetModelOf` 走 `pendingOf`），发出去的图与卡上的数不可能两套。
 * ⚠️ **图上没有款名 / 预估金额 / 厂家名**（2026-11-02 用户要求，口径住在 `sheetImageModelOf`）：
 *    这张是**对外**的图；自家的款名与进价估算不外发。文字清单（`sheetTextOf`）仍带这两样 ——
 *    它是给自家留存/转发的，两个出口故意不同口径。
 * ⚠️ 与「复制拿货清单」（文字）是**两个按钮**：图给"照着备货"，文字给"转发/存备忘录"——
 *    合成一个按钮就得让用户在"要图还是要字"里先选一次，那一步是白问的。
 */
async function copyForSupplier(c: SupplierCard): Promise<void> {
  if (copyingId.value !== null) return;
  copyingId.value = c.supplierId;
  try {
    const model = sheetModelOf(summary.value.groups, {
      supplierId: c.supplierId,
      supplierName: c.supplierName,
      date: todayLocal(),
    });
    if (!model) {
      toast('这家没有要拿的货', 'info');
      return;
    }
    // 图与文字**不同口径**：`sheetImageModelOf` 只留"要拿什么"（无款名 / 无预估金额 / 无厂家名），
    // 渲染层的入参类型就是它 —— 想往上加回款名或金额，得先改那个函数（那里有为什么的注）。
    const dataUrl = await renderSheetPng(sheetImageModelOf(model), (p) => thumbs.value[p] ?? '');
    if (!dataUrl) throw new Error('清单图生成失败');
    const ok = await writeClipboardImage(dataUrl);
    if (!ok) throw new Error('写入剪贴板失败');
    const pieces = model.lines.reduce((n, l) => n + l.pieces, 0);
    toast(
      `已复制 ${model.lines.length} 款色 · ${pieces} 件 的清单图 —— 粘贴到微信里发给「${
        c.supplierName || '未指定厂家'
      }」`,
      'success',
    );
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    copyingId.value = null;
  }
}

/**
 * 「复制拿货清单」（文字，2026-10-17 合并时加）：同一份模型（`sheetModelOf`）转纯文本，
 * 写进**文本**剪贴板 —— 用户粘到微信对话框 / 备忘录里转发。数字与清单图、屏上、xlsx 同源。
 */
async function copyText(c: SupplierCard): Promise<void> {
  const model = sheetModelOf(summary.value.groups, {
    supplierId: c.supplierId,
    supplierName: c.supplierName,
    date: todayLocal(),
  });
  if (!model) {
    toast('这家没有要拿的货', 'info');
    return;
  }
  try {
    const ok = await writeClipboard(sheetTextOf(model));
    if (!ok) throw new Error('写入剪贴板失败');
    toast(`已复制 ${model.lines.length} 款色 · ${model.lines.reduce((n, l) => n + l.pieces, 0)} 件的文字清单`, 'success');
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  }
}

/** 「复制」厂家电话（桌面端没有拨号动作，一键 = 复制，粘到微信/拨号盘里） */
async function copyPhone(c: SupplierCard): Promise<void> {
  try {
    const ok = await writeClipboard(c.phone);
    toast(ok ? `已复制 ${c.supplierName || '厂家'} 的电话 ${c.phone}` : '复制失败', ok ? 'success' : 'error');
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  }
}

/**
 * 图角标上的字（**导出 xlsx 用**）：`尺码×**还要拿的件数**`
 * （无图可挂 / 已拿完 / 已忽略 → 空串 = 不显示。`drawBadge('')` 与模板的 `v-if` 都按"空串 = 不画"处理）。
 *
 * ⚠️ **要拿的是"还差"不是"需求"**：这张图是直接发给厂家的 ——
 * 一件已拿 4 剩 2 的货，图上写 `L×6` 会让厂家照 6 件发。没建过拿货单时 `remaining === pieces`，
 * 所以"什么都没拿"的场景读起来仍是需求数，两种读法不冲突。
 */
function badgeOf(g: PickingGroup): string {
  return g.ignored || g.remaining <= 0 ? '' : sizeQtyBadge(g.size, g.remaining);
}

/**
 * 空态里"为什么空" —— 按**实际生效的口径**分说，并只说对得上那个口径的动作。
 *
 * 为什么必须分开（2026-10-10 实报）：两种原因的动作是**互斥**的 ——
 * 超窗只能"把天数窗调大"，已终结（关闭/已完成）**没有任何放宽办法**（单已经没了）。
 * 原先那句「都被『已终结 / 超窗』排除了」既不说是哪个，又同时给出两个动作 ⇒
 * 用户照着点了没变化，只能认为这一页坏了。
 */
const emptyReason = computed<{ text: string; widen: boolean }>(() => {
  const s = summary.value;
  const win = daysText(s.days);
  const old = s.excludedOld;
  const fin = s.excludedFinished;
  if (old > 0 && fin === 0) {
    return {
      text: `都被「超窗」排除了：这 ${old} 行比「${win}」更旧。把天数窗调大（0 = 不限）就能拣。`,
      widen: true,
    };
  }
  if (fin > 0 && old === 0) {
    return {
      text:
        `都被「已终结」排除了：这 ${fin} 行是关闭 / 已完成的单，拣了也白拣，放宽条件也变不出来。` +
        `若你确认它们还没终结，去「发货台」的「待发货」页展开「Excel 导入（备选）」核一下那份报表有没有「订单状态」列 ——` +
        `没有这一列就判不出终结，也就不会误剔。`,
      widen: false,
    };
  }
  return {
    text: `两种原因都有：超窗 ${old} 行（不在「${win}」里）、已终结 ${fin} 行（关闭/已完成 —— 不用拣）。先调大天数窗看超窗那批。`,
    widen: true,
  };
});

/** 空态里的下一步：把天数窗调大 —— 真的**打开「更多」**（提示不是入口：让用户照着一个说法去找按钮，等于没给动作） */
function widenDays(): void {
  showMore.value = true;
}

/** 逐组的"缺什么"标签（**导出 xlsx 按码列**用）。
 *  ⚠️ 「无进价」也进这里 —— 它和缺图/缺件数同类："这行的数不全，别拿它当完整清单用"。
 *  （款色行上不再逐行贴缺口标签：缺口由占位图与合计行的说明文字承担。） */
function groupGaps(g: PickingGroup): string[] {
  const out: string[] = [];
  if (g.missingQty) out.push(`缺件数 ${g.missingQty}`);
  if (g.missingImage) out.push(`缺图 ${g.missingImage}`);
  if (!g.supplierId) out.push('缺供应商');
  if (g.missingStyle) out.push('未识别款');
  if (g.unitPrice === null) out.push('无进价');
  return out;
}

/** 款色行的**显示名**：款名（缺款名退颜色，两者都缺 = 未识别款）。
 *  ⚠️ 款编码是内部身份（`data-key` / 拖拽定位用它），**不进界面** —— 卡上、清单图、文字清单同此口径。 */
function rowName(r: PickingColorGroup): string {
  return r.styleName || r.color || '未识别款';
}

/** 尺码名（空码有专名：写 `×2` 会读成"乘以 2"） */
function sizeName(s: string): string {
  return s || '(无尺码)';
}

/** 下单码前缀：加码款显示 `L→`，未加码返回空串（不给正常款加噪音）。
 *  封顶时可能有多个下单码并到同一拿货码（L/XL 都→XXL），用 `/` 串起来；
 *  其中"下单码 == 拿货码"的那一项（6XL→6XL）不重复画出来 —— 它是封顶后留在组里的来源。 */
function orderPrefix(c: PickingSizeCell): string {
  const from = c.orderSizes.filter((s) => s !== c.size);
  return from.length ? `${from.map(sizeName).join('/')}→` : '';
}

/** 尺码角标：`L×2` = 这一码**还要拿** 2 件；`L✓` = 已拿完；加码款是 `L→XL×2`
 *  （写 `L×0` 会读成"要拿 0 件"—— 与 `badgeOf` 同一取舍）。 */
function chipText(c: PickingSizeCell): string {
  const base = c.remaining > 0 ? `${sizeName(c.size)}×${c.remaining}` : `${sizeName(c.size)}✓`;
  return `${orderPrefix(c)}${base}`;
}

/** 尺码角标 tooltip：这一码的「需求 · 已拿 · 还差」—— 折叠展示，三个数一个都没丢 */
function chipTitle(c: PickingSizeCell): string {
  const base = `需求 ${c.pieces} · 已拿 ${c.taken} · 还差 ${c.remaining}`;
  // 加码款把"为什么拿这个码"说全：下单 L、拿货 XL —— 否则用户会以为清单把码算错了
  const from = c.orderSizes.filter((s) => s !== c.size);
  if (!from.length) return `${sizeName(c.size)}：${base}`;
  return `下单 ${from.map(sizeName).join(' / ')} → 拿货 ${sizeName(c.size)}：${base}`;
}

/** 「暂不拿」灰条上的一行话：几款无需补货 + 用户标的忽略原因（标的时候敲的那句话） */
function skipText(c: SupplierCard): string {
  const reasons = [
    ...new Set(
      c.rows
        .filter((r) => r.ignored)
        .map((r) => props.ignoreReasons?.[ignoreKey(r.styleCode, r.color)] ?? '')
        .filter(Boolean),
    ),
  ];
  const base = `${c.ignoredColors} 款色无需补货`;
  return reasons.length ? `${base}（${reasons.join('、')}）` : base;
}

/** 「已拿 · 已开单」行上的一行话：拿了多少件 / 几张已提交共多少钱 / 几张草稿 / 最近拿货日期 */
/**
 * 这张单里有几行"买的时候还没定颜色"（`style_color_id = 0`）。
 *
 * 为什么要放到**卡面**上（而不是只在编辑器里提示）：这些行**扣不掉待拿** ——
 * 身份匹配靠 `style_color_id`，缺了它连带文本兜底都对不上（老单的色名快照是占位
 * 「未分类」，而需求侧现在显示的是平台真色名「3」「Beige」…）。用户看到的现象就是
 * "明明拿过货，清单还是全待拿"，却看不出该去哪里修（2026-10-20 真库：2 张已提交单
 * 共 9 行如此、涉及 3 个款，每款 2~7 个候选色 ⇒ 无法自动定，只能人认）。
 * 所以这枚标签既是**提示**也是**入口**：点它直接进编辑器那排「色未定 · 选一个」。
 */
function undecidedOf(o: PurchaseOrder): number {
  return (o.items || []).filter((i) => !Number(i.styleColorId)).length;
}

/** 「已拿 · 已开单」行上的一行话：拿了多少件 / 几张已提交共多少钱 / 几张草稿 / 最近拿货日期 */
function doneText(c: SupplierCard): string {
  const submitted = c.orders.filter((o) => o.status === 'submitted');
  const drafts = c.orders.filter((o) => o.status !== 'submitted');
  const parts: string[] = [];
  if (c.takenPieces) parts.push(`已拿 ${c.takenPieces} 件`);
  if (submitted.length) {
    // ⚠️ `totalCents` 是**分**（单据口径）⇒ 走 `centsMoney` 除 100；
    //    用清单口径的 `money`（吃元）会显示成 ¥50000.00（2026-10-17 实测）。
    const total = submitted.reduce((a, o) => a + (Number(o.totalCents) || 0), 0);
    parts.push(`${submitted.length} 张已提交 · ¥${centsMoney(total)}`);
  }
  if (drafts.length) parts.push(`${drafts.length} 张草稿`);
  if (submitted[0]) parts.push(`最近 ${submitted[0].bizDate}`);
  return parts.join(' · ') || '暂无记录';
}

/** 忽略行上的原因（宿主注入；没敲原因时给一句默认话，不让 title 空着） */
function ignoreReasonOf(r: PickingColorGroup): string {
  return props.ignoreReasons?.[ignoreKey(r.styleCode, r.color)] ?? '';
}

/** 行上的 tooltip：忽略原因 / 为什么不能拖 / 拖拽提示（三条互斥，一次只说一件事） */
function rowTitle(r: PickingColorGroup): string {
  if (r.ignored) return ignoreReasonOf(r) || '已忽略：无需补货';
  // 未识别款没有款编码 ⇒ 没有可改的款（写通道按 code 定位）。说清原因，别让它看起来"坏了"。
  if (!r.styleCode) return '未识别款：先去认款，之后才能改厂家';
  return props.moveAction ? '拖到别家的格子即可改厂家' : '';
}

/** 款色行的缩略图（生成时已合批取回；'' = 这款没图，走占位框） */
function thumbOf(r: PickingColorGroup): string {
  return (r.imagePath && thumbs.value[r.imagePath]) || '';
}

/**
 * 加码行的款图。与 `thumbOf` 共用同一批 `thumbs`：缩略图是按**清单里的 imagePath** 合批取的，
 * 而加码行的 `imagePath` 正是从这些行里挑出来的 ⇒ 不会多一次 IPC，也不会出现"款色行有图、
 * 加码行没图"的分叉（两处都读同一个 `thumbs`，取不到就是真的没取到）。
 */
function shiftThumbOf(s: StyleShiftRow): string {
  return (s.imagePath && thumbs.value[s.imagePath]) || '';
}

/** 款图的 tooltip：同款多色时**必须说清图取自哪个色**，否则用户会拿它当"这款就长这样" */
function shiftImgTitle(s: StyleShiftRow): string {
  const color = s.imageColor || '';
  if (!color) return `「${s.styleName || s.styleCode}」款图`;
  return s.colors > 1
    ? `「${s.styleName || s.styleCode}」款图取自本批「${color}」色（同款 ${s.colors} 色，图可能不同）`
    : `「${s.styleName || s.styleCode}」款图（${color}）`;
}

// ───────────────────────── 拖拽改厂家（2026-10-17 合并后第二轮） ─────────────────────────
//
// 交互：款色行 draggable → 拖到另一家的格子上松手 → 宿主改 `pl_products.supplier_id`。
// 三态各自的意义：
//   · `is-dragging`（行）= 这一款正被拖着（视觉反馈，松手/取消都会清）；
//   · `is-drop-target`（格）= 合法落点。**从本格拖出去又拖回本格不高亮** ——
//     高亮了会给"松手有变化"的假象，而那是空操作（from === to，宿主也不会写）；
//   · 未指定厂家（supplierId 0）是**合法落点**：拖过去 = 取消这款的厂家关联。
//
// 为什么 dragstart 里同时 setData：真 drag 的数据通道就是 dataTransfer（拖到应用外也带着它），
// 视觉态另存一份 ref 供 dragover/drop 同步读 —— drop 时优先读 ref，读不到再回落 getData。

/** 正在拖的款编码（'' = 没在拖） */
const dragCode = ref('');
/** 从哪家拖出来的（null = 没在拖；0 = 未指定厂家格） */
const dragFrom = ref<number | null>(null);
/** 落点厂家 id（null = 没有；0 = 未指定厂家格是合法落点，不能用 0 当"无"） */
const dropTarget = ref<number | null>(null);

function onRowDragStart(e: DragEvent, r: PickingColorGroup, c: SupplierCard): void {
  if (!props.moveAction || !r.styleCode) return;
  dragCode.value = r.styleCode;
  dragFrom.value = c.supplierId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', r.styleCode);
  }
}

function onRowDragEnd(): void {
  dragCode.value = '';
  dragFrom.value = null;
  dropTarget.value = null;
}

function onTileDragOver(e: DragEvent, c: SupplierCard): void {
  if (!dragCode.value) return;
  if (dragFrom.value === c.supplierId) {
    // 原地：不当落点（清了防止从别格掠过来时留着上个格的落点）
    if (dropTarget.value !== null) dropTarget.value = null;
    return;
  }
  // 不 preventDefault 的话浏览器不放行 drop（默认把元素当"不能放"）
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropTarget.value = c.supplierId;
}

function onTileDragLeave(e: DragEvent, c: SupplierCard): void {
  // 拖到格子里的子元素上也会冒泡出 dragleave —— 那时 relatedTarget 仍在格内，不能清落点
  // （不判这一条的表现是落点闪烁：鼠标在卡内移动时高亮一灭一亮）。
  const to = e.relatedTarget as Node | null;
  const cur = e.currentTarget as HTMLElement | null;
  if (to && cur && cur.contains(to)) return;
  if (dropTarget.value === c.supplierId) dropTarget.value = null;
}

function onTileDrop(e: DragEvent, c: SupplierCard): void {
  e.preventDefault();
  const code = dragCode.value || (e.dataTransfer?.getData('text/plain') ?? '');
  const from = dragFrom.value;
  onRowDragEnd();
  if (!code || from === null || from === c.supplierId) return;
  // 写是**款级**的（厂家挂在 pl_products 上按款编码）⇒ 这一款的所有款色一起走。
  // 带上款色数与款名，宿主才能把"整款一起移动"说全（只说拖的那一行会误导）。
  const src = supplierCards.value.find((x) => x.supplierId === from);
  const row = src?.rows.find((r) => r.styleCode === code);
  emit('move-supplier', {
    styleCode: code,
    styleName: row?.styleName ?? '',
    fromSupplierId: from,
    toSupplierId: c.supplierId,
    colors: src ? src.rows.filter((r) => r.styleCode === code).length : 0,
  });
}

/** 该款在清单里一共几个款色（款级写库要带上它，宿主才能说全"整款一起走"） */
function colorsOfStyle(styleCode: string): number {
  if (!styleCode) return 0;
  return supplierCards.value.reduce((n, c) => n + c.rows.filter((r) => r.styleCode === styleCode).length, 0);
}

function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 空态里的下一步：去导订单 —— 一行订单都没有时，用户其实缺的是"先导订单"。
 *  内嵌时发事件交给「发货台」页切到导入页签（`switchModule('today')` 会跳到本页再跳回来，等于没动）。 */
function goImport(): void {
  if (props.embedded) {
    emit('go-import');
    return;
  }
  switchModule('today');
}

/** 一键生成：取数 → 汇总 → 取缩略图（四路都在这里，界面只读结果） */
async function generate(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await ipc.pickingRows({
      shop: shopPick.value,
      includeShipped: includeShipped.value,
    });
    if (!res.success || !res.data) throw new Error(res.error || '读取待拣订单失败');
    const rows = res.data.rows;

    // ── 亚洲款加码（2026-11-02）：先把行的尺码换成**拿货码**，再聚合 ──────────────────
    // 为什么必须在聚合**之前**：清单尺码格、开单明细（`g.size`）、已拿抵扣、导出全读聚合后的
    // `size`；换在聚合之后就要在五处各改一遍，而且必然有一处忘掉（忘了那处不报错、只是拿错货）。
    // ⚠️ 读配置失败**不回落成"不加码"**：静默少加一个码 = 照错码拿货，比报错贵得多。
    const codes = [...new Set(rows.map((r) => String(r.styleCode ?? '')).filter(Boolean))];
    const sm = await ipc.productSizeShiftLoad({ codes });
    if (!sm.success) throw new Error(sm.error || '读取加码配置失败（不能按未加码继续算）');
    const shifts = sm.data?.shifts ?? {};
    // 行内下拉读它（`shiftOf`）；换一份对象而不是就地改，避免下游误以为还是旧配置
    shiftMap.value = shifts;
    // 码链：该款实际有哪些码，决定"数字码 38 的下一个码是谁"（38→40 由链说话，不靠猜）
    const chains: Record<string, string[]> = {};
    for (const [code, list] of Object.entries(sm.data?.chains ?? {})) chains[code] = sizeChain(list);
    const shifted = applySizeShift(
      rows,
      (code) => shifts[code] ?? 0,
      (code) => chains[code] ?? null
    );
    shiftStats.value = shifted.stats;
    // 款名：本批订单行自己带的（首个非空），**不查主数据** —— 拿货页的款常常还没入库
    const names: Record<string, string> = {};
    for (const r of rows) {
      const c = String(r.styleCode ?? '');
      if (!c) continue;
      const n = String(r.styleName ?? '');
      if (n && !names[c]) names[c] = n;
    }
    shiftNames.value = names;

    // 结算商品行的件数（真值）：按可见订单号批量取一次，铺成查表（键口径由 `settleQtyKey` 单源给出）
    const settleQty: Record<string, SettleQtyInfo> = {};
    const orderNos = [...new Set(rows.map((r) => String(r.orderNo ?? '')).filter(Boolean))];
    if (orderNos.length) {
      const st = await ipc.settleOrders({ orderNos });
      if (st.success) {
        for (const row of st.data?.rows ?? []) {
          for (const it of row.items ?? []) {
            settleQty[settleQtyKey(row.orderNo, it.itemId)] = { lines: it.lines, qty: it.qty };
          }
        }
      }
    }

    // 进价/预估金额：订单行投影已带**两个行级成本字段**（实际进价 / 进价预估）
    // 与产品当前价（`productCostCents`，只给还没钉预估的老行兜底）。取价优先级在
    // `aggregatePicking` 内一处实现（`positiveCents` 三级），本页不再拉任何价目表。

    // 已拿 / 已忽略：**已拿**来自 `purchase-taken`（**台账**：所有已提交拿货单的 qty 合计，按款色码），
    // 忽略来自 `purchase_ignore`（按款色，整组生效）。
    // ⚠️ 2026-10-17 事故（用户实报"已经提交了，状态还是在待拿"）：原先这里读的是 `purchase-outstanding`
    //   （**缺口**），它末尾有 `missing <= 0 就丢掉` —— **拿齐的那一行根本不会返回**，
    //   于是"刚拿完"在清单里等价于"一件没拿"，`remaining = pieces`、卡永远停在待拿。
    //   缺口与台账是两种语义：问"还缺什么"用前者，问"拿过多少"只能用后者。
    // ⚠️ 2026-10-20：键必须走 `takenKeyOf`（**身份优先**）。拿色名当键时，色行改名一次
    //   ⇒ 历史明细全匹配不上 ⇒ 每张卡都"待拿"（用户实报的那个现象）。两端口径同一函数。
    const tg = await ipc.purchaseTaken();
    const ig = await ipc.purchaseIgnoreList();
    const taken: Record<string, number> = {};
    for (const r of (tg.success ? (tg.data ?? []) : []) as TakenRow[]) {
      const k = takenKeyOf(r);
      taken[k] = (Number(taken[k]) || 0) + (Number(r.taken) || 0);
    }
    const ignored = new Set(
      ((ig.success ? (ig.data ?? []) : []) as IgnoreRow[]).map((r) => ignoreKey(r.styleCode, r.color)),
    );

    summary.value = aggregatePicking(shifted.rows, {
      settleQty,
      taken,
      ignored,
      days: days.value,
      today: todayLocal(),
    });
    generated.value = true;

    // 缩略图：只取"清单上真正要看的"那些图，合批一次往返（路径去重）
    const paths = [...new Set(summary.value.groups.map((g) => g.imagePath).filter(Boolean))];
    thumbs.value = {};
    if (paths.length) {
      const t = await ipc.orderImageThumbBatch(
        paths.map((localPath) => ({ localPath, maxEdge: THUMB_EDGE }))
      );
      if (t.success) {
        paths.forEach((p, i) => {
          const url = t.data?.dataUrls?.[i];
          if (url) thumbs.value[p] = url;
        });
      }
    }
  } catch (e: unknown) {
    error.value = `生成失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 导出拣货单（**带图 + 按厂家分表**，供直接转发厂家）。
 *
 * 为什么不在渲染层用 `xlsx` 生成了：Excel 没有"图片作为单元格内容"的格式，嵌图必须走浮动图 +
 * 图片部件，社区版 SheetJS 不支持；主进程已有 `exceljs` 的嵌图先例（拿货单导出）。
 * **口径不搬家**：这里把已算好的行原样传过去（件数/进价/金额/缺口文案），主进程只画表 ——
 * 于是"导出的数"与"屏幕上的数"不可能不一致。
 *
 * 图：复用页面上**已经取回的缩略图**（不额外发 IPC），再用 canvas 统一转成 JPEG，
 * **并把尺码×件数角标烧进图里** —— 真实订单图大半是 WebP，而 Excel 嵌入的 WebP 在旧版 Office/WPS
 * 里显示不出来（详见 `lib/pickingExport`）。
 *
 * 行的顺序 = 清单顺序（有厂家的在前、未指定的最后），主进程按 `supplierName` 切表。
 */
async function exportXlsx(): Promise<void> {
  const groups = summary.value.groups;
  if (!groups.length) return;
  try {
    // 图先编码（顺序、失败不抛）：取不到的只是一行没图，不该让整个导出失败。
    // ⚠️ 键用**组键**而不是图片路径：同一张图可能被不同尺码的组共用，而角标（尺码×要拿件数）不同 ——
    //    按路径去重会把角标串味（L 那组显示成 XL 的件数，且不会报错）。
    const images = await encodeImagesForExport(
      groups.map((g) => ({
        key: g.key,
        localPath: g.imagePath,
        badge: badgeOf(g),
      })),
      { loadDataUrl: (p) => thumbs.value[p] ?? '', toJpeg: domToJpeg },
      THUMB_EDGE,
    );
    const rows = groups.map((g) => ({
      supplierName: g.supplierId ? g.supplierName : '',
      styleCode: g.styleCode,
      color: g.color,
      size: g.size,
      // 加码款：`XL` + 下单码 `L` ⇒ 表里渲染成 `XL（下单L）`（厂家照 XL 拿，来源可追溯）
      orderSize: g.orderSizes.join('/'),
      pieces: g.pieces,
      taken: g.taken,
      remaining: g.remaining,
      orders: g.orders,
      unitPrice: g.unitPrice,
      amount: g.unitPrice === null ? null : g.amount,
      gaps: g.ignored ? '已忽略（无需补货）' : groupGaps(g).join(' · '),
      image: images[g.key] ?? null,
    }));
    const r = await ipc.pickingExportExcel({ rows, defaultName: `拣货单-${todayLocal()}` });
    if (!r.success) {
      if (r.error === '__canceled__') return; // 用户点了取消：不算失败
      throw new Error(r.error || '导出失败');
    }
    const withImg = rows.filter((x) => x.image).length;
    toast(
      `已导出 ${groups.length} 个 SKU（共 ${summary.value.pieces} 件）· 按厂家分了 ${
        summary.value.suppliers.length
      } 张表 · ${withImg} 张图`,
      'success',
    );
  } catch (e: unknown) {
    const msg = `导出失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  }
}

// 数据变了（导入了订单 / 配了映射 / 改了成本）→ **已经生成过**的清单跟着重算；
// 没生成过就保持空态（本页的"一键语义"：进页不自动取数，冒烟有断言钉着）。
watch(
  () => props.refreshToken,
  () => {
    if (generated.value) void generate();
  }
);

// 改了筛选条件（天数窗 / 店铺 / 含已发货）→ 同样只在"已经生成过"时重算。
// 为什么必须有：条件条上的数就是"本次清单的口径"，不重算就会出现**标签写着新条件、数还是旧的**
//   —— 用户改了条件看见标签变了、数字没变，只能以为改坏了（2026-10-10 实报的邻接症状）。
// 为什么用 watch 而不是给控件加 @change：`v-model` 与 @change 在同一次事件里的先后无法保证，
//   读到旧值的静默 bug 比多跑一次取数更难查。
watch([days, shopPick, includeShipped], () => {
  if (generated.value) void generate();
});

// 清单变了就交给外层（「拿货」页据此给这家厂开单：只取本视图算过的同一批组）。
// 为什么用 watch 而不是在 `generate()` 里 emit：`summary` 是**唯一的**清单出口（含以后新增的
// 取数路径）；钉在出口上，"换了取数方式却忘了通知外层"这类缝就不可能再出现。
watch(summary, (s) => {
  emit('generated', s.groups);
});

onMounted(async () => {
  // 店铺清单（可选：读不到就只是不能按店铺筛，不影响生成）
  try {
    await ipc.shopDbEnsure();
    const sl = await ipc.shopList({ status: 'active' });
    if (sl.success)
      shops.value = (sl.data?.rows ?? []).map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    /* 店铺域不可用不影响拣货 */
  }
  // `auto`（由外层显式指定）：并进「拿货」后这一屏是那一步的入口视图，应当一眼可读。
  // ⚠️ 放在店铺清单之后：`generate()` 里店铺下拉只是筛选条件，不依赖它，但先拿到店铺能让
  //    自动生成的**第一次**就带上完整条件条（否则条件条少一格，用户看到的默认值与实际不一致）。
  if (props.auto) void generate();
});
</script>

<style scoped>
/* 页面外壳由全局 .wb-page 提供；精简条是组件自有的 `.pk-bar`（`.pk-topbar` 类名保留供冒烟断言）。 */

/* 内嵌在「今天 › 拿货」里：外层宿主（`PurchasePanel` 的 `.wb-page`）已经给了整套页面内边距
   （18/20/24），这里**四边全部归零** —— 根节点还挂着全局 `.wb-page`（自带 18/20/24），
   不清掉就是双层叠加：内容左右缩进 40px、且与宿主的页级面板（"已忽略"折叠条）左缘对不齐
   （2026-10-17 用户实测"页面很奇怪"，几何取证 pkView pad=[0,20,24]）。
   若将来再挂成独立页（embedded=false），`.wb-page` 的内边距自然生效，不需要这里补。 */
.pk-view.is-embedded {
  padding: 0;
}

/* ⚠️ 2026-11-02：**本页每一块子区都不许被 flex 压缩**。
   `.wb-page` 是 `display:flex; flex-direction:column; height:100%; overflow:auto`，
   子项默认 `flex-shrink:1`：内容一超过一屏，可滚动的那几块（加码款列表 `overflow-y:auto`）
   自动最小尺寸是 **0**，会被压成十几像素，再被 `.wb-panel` 的 `overflow:hidden` 裁掉 ——
   用户看到的就是"一条空白"（实测 `.pk-shift` 高 18px、`.pk-shift__head` 却被要求 28px）。
   正确形态是**整页滚动**（`.wb-page` 本来就 `overflow:auto`），不是压缩某一区。
   冒烟只查元素在不在、文案对不对，抓不到这种"在但看不见" ⇒ 判据补在 today-ui-smoke 的几何守卫里。 */
.pk-view > * {
  flex: 0 0 auto;
}

/* 内嵌时页头整块不渲染（标题由外层页签交代，动作在下面的精简条上）——
   原先那条"把页头按钮靠左"的规则随页头一起没了，别再加回来。 */

/* 精简条（2026-10-17 第五轮）：「缺什么 / 什么口径」两段文案撤掉后，
   这里只剩右侧「导出带图 xlsx / 更多」两个低频动作 —— 白卡壳随之去掉（左侧大片空白的
   空壳卡片是"页面很奇怪"的另一来源，几何取证后用户确认）；退成无壳工具行。
   ⚠️ 数据类条子（分类页的过滤条等）仍保留白卡 —— 有内容的条才配得上卡片外壳。 */
.pk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  flex-shrink: 0;
}

/* 宽窗口把右侧动作推到右端；窄窗口它们自己折到下一行 */
.pk-bar__spacer {
  flex: 1 1 auto;
}

.pk-tag {
  flex-shrink: 0;
}

.pk-more {
  padding: 11px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

/* ---- 未归类提示条（2026-10-20）----
   为什么给白卡壳（与 `.pk-bar` 退成无壳相反）：它不是工具行，是**一条结论**
   （"这些数不准"）+ 一份清单 —— 有内容的条才配得上卡片（同 `.pk-bar` 注释里的判据）。
   颜色用 warn 系而不是故障红：数据本身没错，只是**归属缺一块**。 */
.pk-unclass {
  border-color: var(--wb-warning);
  background: var(--wb-warning-soft);
}

.pk-unclass__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
}

/* 亚洲款加码：与「未归类」同一种卡片语言（都是"这条清单的口径说明"），
   但颜色走中性系 —— 加码是**正常业务**，不是数据有问题。
   ⚠️ 这一块是**设置入口**（不只是提示）：标题行是可点开的按钮（键盘可聚焦、可 Enter）。
   ⚠️ 2026-11-02 重做：折叠/展开两态都**按内容自然撑高**（`flex: 0 0 auto`，见文件头
      `.pk-view > *`）—— 上一版缺这条，面板被页面纵向 flex 压成 18px、标题行整条被裁，
      用户实报"加码区域完全看不到"。视觉上把"能点"做成明摆着的按钮，不再靠一行灰字暗示。 */
.pk-shift {
  flex: 0 0 auto;
  padding: 0;
}

/* 有加码款时整块换强调边框：一屏扫过去就知道"这批改过码" */
.pk-shift.is-on {
  border-color: var(--wb-accent, var(--wb-border));
}

/* 标题行 = 开关。用 `<button>` 而不是 `<div @click>`：这个入口是**设置动作**不是装饰，
   键盘用户得能聚焦、Enter 打开。默认按钮样式全部抹掉，高度由 min-height 撑到 40px
   （低于 32px 的一行在密集页面里会被读成"分隔条"，而不是可点的入口）。 */
.pk-shift__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  min-height: 40px;
  padding: 6px 14px;
  background: none;
  border: 0;
  border-radius: var(--wb-radius-lg) var(--wb-radius-lg) 0 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.pk-shift__head:hover {
  background: var(--wb-hover);
}

/* 展开后标题行与内容之间要有一条分界，否则 40px 标题行与下面的筛选行糊成一片 */
.pk-shift.is-open .pk-shift__head {
  border-bottom: 1px solid var(--wb-border);
}

/* 「加码」徽标：中性底 + 弱文字；有加码款时换强调浅底，与右侧那句状态一起读 */
.pk-shift__badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.pk-shift.is-on .pk-shift__badge {
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.pk-shift__title {
  font-weight: 600;
}

.pk-shift__why,
.pk-shift__count {
  font-size: 12px;
  white-space: nowrap;
}

/* 「设置加码」= 明摆着的按钮（边框 + 底色 + 箭头）。折叠态下它是这一块唯一的动作 ——
   上一版做成右侧一行灰字，用户读成"说明文字"，于是整批款从来没被加过码。
   `margin-left:auto` 是为**窄窗口折行**准备的：一行放不下时它落到第二行，仍然贴右边，
   不会孤零零掉到左下角（820px 实测）。 */
.pk-shift__chev {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  margin-left: auto;
  padding: 0 8px;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12px;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.pk-shift__head:hover .pk-shift__chev {
  background: var(--wb-primary-soft);
  border-color: var(--wb-text-muted);
}

.pk-shift__caret {
  font-size: 10px;
}

.pk-shift__body {
  padding: 0 14px 12px;
}

.pk-shift__filter {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0 8px;
  font-size: 12px;
}

.pk-shift__search {
  max-width: 16em;
}

/* 列表 = 表头 + 滚动区。表头与行用**同一套 grid 轨道**（fr 由容器宽度统一解算 ⇒ 天然对齐），
   款号 / 款名 / 待拿 / 下拉四列在任意宽度下都成列 —— 上一版是 flex + spacer，
   款名长短一变，右侧下拉的左缘就跟着跳，扫读时找不到"加几码"那一列。 */
.pk-shift__list {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  overflow: hidden;
}

.pk-shift__cols,
.pk-shift__row {
  display: grid;
  /* 第一列 = 款图 + 款号/款名（2026-11-03 加图前是"款号 / 款名"两列）。
     第一列给**上限**而不是纯 fr：纯 fr 会把款名那格撑到半屏，第二列「N 色 · 待拿 N 件」
     于是被推到中间，眼睛要在两片空白之间跳。上限 22em（≈264px）够放款图 + 长款名，
     多出来的宽度留给「待拿」那一列（含两条警告标签，它才是宽度不定的一列）。 */
  grid-template-columns: minmax(0, 22em) minmax(0, 1fr) 6.8em;
  align-items: center;
  gap: 8px;
}

.pk-shift__cols {
  padding: 5px 10px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
}

.pk-shift__cols-pick {
  justify-self: end;
}

/* 收起态固定高度 + 内部滚动：款列表是"设置面板"，不能随款数增长把清单挤走。
   ⚠️ 上限必须**装得下 10 行**（10 × 45px = 450px，与 `SHIFT_ROW_MAX` 同源）：
      上一版按 35px 估、实际行更高，页面上"一屏 N 行"的承诺就破了
      （2026-11-02 用户实报"列表被裁"）。改行高或改行数，这里必须同改。 */
.pk-shift__rows {
  max-height: 450px;
  overflow-y: auto;
}

/* 「展开全部」= 真的全部展开：用户已明确要一次看全，再留高度上限等于没展开。
   高清单会把下面的清单顶下去，但那是用户自己点的，且「收起」就在旁边。 */
.pk-shift__rows.is-all {
  max-height: none;
}

.pk-shift__row {
  /* 左侧色条留位：已加码时染色，**不留位会让整行文字左右跳**（列表里最容易被当成"改错了"） */
  padding: 4px 10px 4px 8px;
  border-bottom: 1px solid var(--wb-border);
  border-left: 2px solid transparent;
  font-size: 12px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.pk-shift__row:last-child {
  border-bottom: 0;
}

.pk-shift__row:hover {
  background: var(--wb-surface-2);
}

/* 已加码：左色条 + 淡底。靠**视觉**说"这款加了码"，不靠排序 —— 排序会让改完的那一行跳走 */
.pk-shift__row.is-on {
  border-left-color: var(--wb-accent, currentColor);
  background: var(--wb-accent-soft);
}

/* 从款色行跳过来时闪一下（1.6s 后由脚本摘掉 class） */
.pk-shift__row.is-focus {
  outline: 1px solid var(--wb-accent, currentColor);
  outline-offset: -1px;
}

/* 第一列：款图 + 身份（款号 / 款名）。图与文字**同高对齐**（align-items:center），
   行高由图决定（36px），文字两行加起来不超过它 —— 所以下拉与款色列看起来仍在同一中线上。 */
.pk-shift__cell {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

/* 款图：与款色行的 `.pu-srow__img` 同一语言（方角圆边、细边框），但小一号 ——
   这里是"设置面板"（一行要看/要比），款色清单才是"照着拿货"（图要大）。 */
.pk-shift__img {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  object-fit: cover;
}

/* 无图 = 虚线占位框（与款色行同口径）：藏掉会让一行看起来"缺了左边那格"，
   而"这款本批没图"本身是要去补的信息。 */
.pk-shift__img--none {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  color: var(--wb-text-muted);
}

.pk-shift__ident {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.pk-shift__code {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 款名可以被挤（长名字省略），款号与幅度**不能** —— 它们才是识别与核对的那两位。
   款名降一档字号 + 次要色：加了图之后第一列是"图 + 两行字"，两行同样粗细会显得吵。 */
.pk-shift__name {
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--wb-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 待拿件数与两条警告并在**同一列**：警告跟着款走，别单独占一列把款名挤掉。
   宽度不够时整列省略（而不是让警告溢出盖住下拉），全量口径在下面的汇总句里另有说明。 */
.pk-shift__meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-shift__flag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
}

.pk-shift__flag.is-warn {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.pk-shift__pick {
  width: 100%;
}

.pk-shift__empty {
  margin: 10px 0;
  padding: 0 10px;
  font-size: 12px;
}

.pk-shift__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 12px;
}

/* 后果说明贴右：左边是「展开全部」这类动作，两种东西不混在一处 */
.pk-shift__foot-note {
  margin-left: auto;
  font-size: 12px;
  text-align: right;
}

.pk-shift__more {
  font-size: 12px;
}

.pk-shift__warn {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wb-warning);
}

/* 款色行上的**只读**加码标记（动作在款列表里）：小一号、不抢眼，
   它的作用是"让人在行的位置就知道这款加过码"，不是提供第二个改值入口 */
.pk-rowshift {
  font-size: 12px;
  white-space: nowrap;
}

.pk-unclass__title {
  font-weight: 600;
}

/* 后果说明可以被挤（窄窗口折行），但**不能被 `min-width:0` 压成一点** —— 它是这条提示存在的理由 */
.pk-unclass__why {
  font-size: 12px;
  min-width: 12em;
}

.pk-unclass__toggle {
  margin-left: auto;
}

.pk-unclass__body {
  border-top: 1px solid var(--wb-border);
  padding: 6px 14px 10px;
}

.pk-unclass__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--wb-border);
}

.pk-unclass__row:last-child {
  border-bottom: 0;
}

.pk-unclass__iid {
  font-family: var(--wb-font-mono, monospace);
  font-size: 12.5px;
}

.pk-unclass__qty {
  font-variant-numeric: tabular-nums;
}

.pk-unclass__shops {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 22em;
}

.pk-unclass__hint {
  font-size: 12px;
}

.pk-actions--wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.pk-field {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.pk-input--num {
  width: 68px;
  text-align: right;
}

.pk-error {
  margin: 0;
  font-size: 13px;
  color: var(--wb-danger);
}

/* 空态：面板化，避免"一段灰字飘在大片空白中央" */
.pk-empty {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

/* ───────────────────────── 一张卡 = 一家厂（三种高矮，同一外壳） ───────────────────────── */

/* ⚠️ `flex-shrink: 0`（2026-10-17）——**不能删**，与拣货汇总条 2026-10-10 那次"按钮跟页签走"
   同一根因：`.wb-page` 是定高弹性列，内容超高时压缩默认可缩的弹性项；卡片自己的
   `overflow:hidden`（草稿竖线/圆角要它）把自动最小尺寸归零 ⇒ 整张卡被压成一条缝、
   行与按钮全裁在里面（DOM 还在、`elementFromPoint` 点不到）。修法语义：卡不许缩，
   装不下就溢出 `.pk-view` 去滚（那才是本来的设计）。 */
.pu-scard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.pu-scard__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

/* 厂家名是卡上第一显眼的东西（拿货单是发给谁的） */
.pu-scard__name {
  font-size: 15px;
  font-weight: 700;
}

.pu-scard__phone {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.pu-scard__spacer {
  flex: 1 1 auto;
}

/* 状态签（待拿）：与卡上其余部分同一套 `wb-tag`，颜色走令牌 */
.pu-scard__head .wb-tag {
  flex-shrink: 0;
}

.pu-scard__rows {
  display: flex;
  flex-direction: column;
}

/* ───────────────────────── 厂家宫格（2026-10-17 第三轮：一种卡 + 单宫格） ───────────────────────── */

/* 一个厂家一格：auto-fill + 最小列宽 + 12px 缝。
   ⚠️ 最小列宽取 **324**（2026-10-17 第六轮从 288 上调）：格子里除了 44px 图 + 款名颜色 +
     尺码角标 + 动作链接，卡尾还要**一行摆下三个按钮**（复制拿货清单 86 + 复制清单图 74 +
     生成拿货单（N 件）~121 + 缝 12 + 卡内边距 24 ≈ 317，324 留了两位数件数的余量）——
     288 时卡尾必然折成两行（用户实测反馈"三个按钮要同一行"）。
     756×469 窄窗（侧栏 208）下可用宽度 ~500，324 排一列也不亏——厂家卡本来就高。
   ⚠️ 宫格是 `.wb-page` 的直接子项：`flex-shrink:0` 防止定高弹性列把整格压扁（同 `.pu-scard`）。 */
.pu-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(324px, 1fr));
  /* ⚠️ 2026-10-17 评审 P0：卡片**按内容高**，不许被同行的高卡拉齐。
     grid 默认 `stretch` ⇒ 瘦卡（未指定厂家 / 暂不拿 / 已拿）被拉成与同行最高全卡等高，
     而卡内动作块是 `margin-top:auto` 吸底 ⇒ 中部撑出一大片真空（1440/1152 两组截图都可见），
     "瘦卡应该矮一截"的第三轮设计意图被 stretch 抵消。
     代价：同一行卡片底边不再对齐（卡片高度本来就该是内容的函数，不是邻居的函数）。 */
  align-items: start;
  gap: 12px;
  flex-shrink: 0;
}

/* 拖拽落点（待拿/暂不拿/已拿卡都吃这条）：主色描边 + 选中态浅底 —— 与"待拿"签同色系，
   松手就会有事发生。⚠️ 从本格拖出去又拖回本格**不**高亮（见 onTileDragOver）：那是空操作。 */
.pu-scard.is-drop-target {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}

/* 一个款色一行：SKU 图 + 主列（身份行 / 尺码·钱·动作行两行式）。
   窄窗口允许折行（不裁不滚）—— 行是"照它干活"的东西，少一截就是少拿一件。 */
.pu-srow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
}

.pu-srow + .pu-srow {
  border-top: 1px dashed var(--wb-border);
}

/* 六点把手（评审 P1：把"这行能拖"从悬停 tooltip 里搬到界面上）。
   用 background 平铺画点，不引入图标组件 —— 它是**装饰**，读屏也不需要它（aria-hidden）。
   颜色走一个局部变量：默认取边框色（淡到扫视时不抢款名），行悬浮才提到次要文字色（可操作感）。 */
.pu-srow__grip {
  --grip-dot: var(--wb-border-strong);

  flex: 0 0 9px;
  width: 9px;
  height: 14px;
  margin-top: 2px;
  background-image: radial-gradient(circle 1px at 2px 2px, var(--grip-dot) 100%, transparent 0);
  background-size: 5px 5px;
}

.pu-srow:hover .pu-srow__grip {
  --grip-dot: var(--wb-text-muted);
}

/* 只有宿主接了写通道（moveAction）才渲染 draggable —— 抓手势只出现在真能拖的行上 */
.pu-srow[draggable='true'] {
  cursor: grab;
}

/* 正在被拖动：半透明（"这款被我拎起来了"）；松手 / 取消都会清掉 */
.pu-srow.is-dragging {
  opacity: 0.45;
}

/* SKU 图：44px 方图。`object-fit: cover` —— 真库 35 张里 31 方 4 竖，竖图不能拉扁。
   `draggable="false"`（写在模板上）：不让浏览器把图本身当成拖拽源 ——
   那样拖起来的是那张图，行的 dragstart 根本不触发（拖了没反应，还查不到原因）。 */
.pu-srow__img {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  object-fit: cover;
}

/* 无图 = 虚线占位框："这款没图"本身是要去补的信息（与行上的「缺图」标签同一口径），不藏行 */
.pu-srow__img--none {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  color: var(--wb-text-muted);
}

.pu-srow__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pu-srow__top {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 8px;
}

.pu-srow__spacer {
  flex: 1 1 auto;
}

.pu-srow__sub {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

/* 动作组：有空间就贴行右（与旧版行尾同一视觉位置），窄了自然折行 */
.pu-srow__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-left: auto;
}

/* 已忽略：划掉的是"再要这些件"，不是"记错了"（数字照留着可回看） */
.pu-srow.is-off {
  color: var(--wb-text-muted);
}

.pu-srow.is-off .pu-srow__name {
  text-decoration: line-through;
}

/* 款名 = 行上第一显眼的东西（款编码不展示，见 rowName） */
.pu-srow__name {
  font-weight: 600;
}

.pu-srow__color {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.pu-srow__sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* 加码下拉：宽度只够放下"不加码 / +3 码"（不抢款名的位置），高度与行内链接齐平 */
/* 加码设置在页顶的「款列表」里；款色行只留 `.pk-rowshift` 那个只读标记 */

.pu-srow__qty {
  font-variant-numeric: tabular-nums;
}

/* 尺码角标（行内）：`L×2` = 还要拿 2 件；`L✓` = 已拿完 */
.pk-chip {
  padding: 0 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 12px;
  line-height: 18px;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

/* 已拿完的码：还在格里（"这码处理过了"是信息），但不再抢眼 */
.pk-chip.is-done {
  color: var(--wb-text-muted);
}

/* 已忽略的整款色：划掉（数字照留） */
.pk-chip.is-off {
  color: var(--wb-text-muted);
  text-decoration: line-through;
}

/* 合计行：与卡身之间一条虚线（它不是数据行，是这一家的收口） */
.pu-scard__sum {
  margin: 0;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* ⭐ 吸底块（已开单 + 卡尾动作）：`margin-top:auto` 把它钉在卡底 ——
   宫格里各卡行数不同，底部动作永远贴着卡的下缘、横向对齐（用户明确要求的形态）。
   顶线由这块统一给，里面的"已开单"/动作组不再各自画线。 */
.pu-scard__bottom {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--wb-border);
}

/* 已开单（宿主注入）：草稿/已提交各一行，动作与旧「按订单」视图同一套 data-act */
.pu-scard__orders {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pu-scard__orders-title {
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* "再开一张"所在的一行：标题左、次动作用 wb-link 右贴（2026-11-05）。
   放在这里而不是卡尾，是为了不跟卡尾那三颗按钮抢同一行宽度（324 最小列宽下一行只放得下三个）。 */
.pu-scard__orders-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pu-scard__neworder {
  margin-left: auto;
  font-size: 12px;
  white-space: nowrap;
}

.pu-orow {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
}

.pu-orow__no {
  font-weight: 600;
}

.pu-orow__amount {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 「N 行色未定」：**伪装成标签的按钮**（既是提示也是入口 —— 点它进编辑器认色）。
   去掉按钮默认的边框/底色/内边距，否则在 12px 的行里会撑高一行、并把金额挤到换行。 */
.pu-orow__undecided {
  border: 0;
  padding: 0 6px;
  font: inherit;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}

.pu-orow__ops {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
}

/* 「提交」是这一行唯一的主操作（2026-11-05）：原来它和"导出/删除"一样是 13px 常规字重，
   一张草稿单上四个同等重量的动作，用户要点哪个得先读一遍。
   ⚠️ 只加**字重**、不改尺寸/形状：换 `wb-btn` 会把行高撑起来，而这张卡每涨 6px
   一屏就少一行（与 2026-10-12「行高被排版细节决定」是同一类坑）。
   ⚠️ 也不能靠颜色 —— `.wb-link` 基座本来就是主色，再染一次等于没变。 */
.pu-orow__ops .wb-link--strong {
  font-weight: 600;
}

/* 卡尾动作：复制文字清单 / 复制清单图 / 生成拿货单（2026-10-17 第六轮：三个按钮**一行**）。
   按钮水平内边距从 8px 收到 6px（全局 .wb-btn--sm 不动，只收这一处）——
   三个按钮 + 缝要塞进最小列 324 的内容盒（300px），8px 时合计 ~305 塞不下。
   ⚠️ flex-wrap 保留：件数到三位数（生成拿货单（100+ 件））按钮变宽时宁可折行也不溢出卡外。 */
.pu-scard__acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 两个复制动作成组（评审 P2）：组内贴紧 4px，与右侧主动作之间由父级的 6px 隔开 ——
   三个按钮平级一行时，"哪两个是同一件事的两种形态"读不出来。 */
.pu-scard__copys {
  display: flex;
  gap: 4px;
}

.pu-scard__acts > .wb-btn--sm,
.pu-scard__copys > .wb-btn--sm {
  padding-left: 6px;
  padding-right: 6px;
}

/* ───────────────────────── 暂不拿 / 已拿的瘦卡（同一种外壳，压矮） ───────────────────────── */

.pu-scard--mini {
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
}

/* 瘦卡里的单子行（已拿卡）：与大卡"已开单"区同一套行样式，只是上边距收紧 */
.pu-scard--mini .pu-orow {
  padding-top: 4px;
  border-top: 1px dashed var(--wb-border);
}

/* 瘦卡上的说明文字（忽略原因 / 已拿摘要）：超长省略号，title 补全 */
.pu-scard__meta {
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 暂不拿：压灰 + 虚线框（"主动不补"不该和待拿一样实） */
.pu-scard--skip {
  background: var(--wb-surface-2);
  border-style: dashed;
  color: var(--wb-text-muted);
}

.pu-scard--skip .pu-scard__name {
  font-size: 14px;
}

/* 已拿（评审 P2）：**不再整卡半透明**。
   0.72 一层会把卡上 12px 的次要文字压到 AA 线下（次要色本来就贴在 5:1 附近），
   且"已拿"与"暂不拿"会变成两张同样发灰的卡 —— 用户只能靠虚线边框分辨，那太弱了。
   安静感改由三件不伤可读性的东西承担：瘦卡（矮）、排在页尾、不投影（"浮起来"留给待拿卡）。
   「拿过了」由行首的绿色 ✓ 说 —— 那是语义信号，不是亮度信号。 */
.pu-scard--done {
  box-shadow: none;
}

.pu-done__ok {
  color: var(--wb-success);
  font-weight: 700;
}
</style>
