<template>
  <div class="wb-page cl-view" data-act="classify-panel">
    <!-- 工具条：查询 + 刷新。本页**只剩逐行动作** —— 原「识别未归类」批量按钮已于 2026-10-05
         按用户要求删除（为什么删见 script 头注释），不要再加回来而不改冒烟。 -->
    <div class="cl-bar">
      <input
        v-model="search"
        class="wb-input wb-input--sm cl-search"
        data-act="cl-search"
        placeholder="搜索订单号 / 店铺 / 款式 / 颜色…"
        @keyup.enter="doSearch"
      />
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-query" @click="doSearch">查询</button>
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-reload" :disabled="loading" @click="reload">
        刷新
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="cl-error">{{ error }}</p>

    <!-- ── 门 1：店铺归一（2026-10-28，P5）────────────────────────────────────
         为什么挂在这一页：本页是"款/色的身份"成型的地方，而键里带店名 ——
         一个店名没归一，它名下每个 listing 都自成一款，同一件货在统计与拿货里分成两行。
         ⚠️ 它**不阻断任何按钮**（这是与门 2 的区别，别照着抄成禁用）：
            它保护的是"数字口径"，不是某个动作；而归类在导入那一刻就已经自动发生了，
            事后把它拦在某个按钮上，只能做成一个点不到的门。
         ⚠️ 作用域：**全库订单**，不是"今天这批"（所以它不进页签徽标 —— 那个数只看今天，
            两处放在一起会被读成同一个作用域）。
         ⚠️ 只在真有问题时渲染：全归一了这块 DOM 不存在，不留一条"已完成"的常驻条。 -->
    <section v-if="shopGate.pending.length" class="wb-notice wb-notice--warn cl-gate" data-act="cl-gate-shop">
      <span class="cl-gate__t" data-act="cl-gate-shop-count">
        <b>{{ shopGate.pending.length }}</b> 家店还没归一，涉及 <b>{{ shopGate.orders }}</b> 行订单
      </span>
      <span class="cl-gate__why wb-muted" data-act="cl-gate-shop-why">
        它们的商品会各自算一款（键里带店名）—— 同一件货在统计和拿货里会分成两行
      </span>
      <button
        type="button"
        class="wb-btn wb-btn--sm"
        data-act="cl-gate-shop-open"
        @click="shopGateOpen = !shopGateOpen"
      >
        {{ shopGateOpen ? '收起' : '看是哪几家' }}
      </button>
      <button
        type="button"
        class="wb-btn wb-btn--sm wb-btn--primary"
        data-act="cl-gate-shop-go"
        @click="openModule('shop-accounts', 'registry')"
      >
        去「店名归一」
      </button>
      <ul v-if="shopGateOpen" class="cl-gate__list" data-act="cl-gate-shop-list">
        <li v-for="s in shopGate.pending" :key="s.key" :data-act="`cl-gate-shop-${s.key}`">
          <b>{{ s.raw }}</b>
          <span class="wb-muted">· {{ s.orders }} 行</span>
          <span v-if="s.autoShopName" class="wb-muted">· 能认成「{{ s.autoShopName }}」</span>
          <span v-else class="wb-muted">· 库里还没有这家店，先登记再认</span>
        </li>
      </ul>
    </section>

    <!-- 命名板（P3，2026-10-28）：订单进来就按变体键归好之后，这一页的**人工动作**从
         "逐行选款选色"变成了"给颜色起个名"。它放在核对表**上面**，因为它是现在唯一还能做
         的事；核对表在改造后通常一进来就是空的（"这批核对完了"）。
         ⚠️ 它是**可选**动作：不起名照样统计/拿货，卡片自己会收成一行 —— 不要给它加"必须做完"
            的措辞，也不要把它做成进入本页的前置（那会把 58 次输入变成门槛）。 -->
    <VariantNamingCard />

    <!-- 款合并（P4，2026-10-28）：同一个厂家下几个款其实是同一件货时，合并成 1 个。
         为什么和命名板并排、而不是放拿货页：两者是同一件事的两个动作（**人给结构**）——
         给色起名、认出一件货有两个链接；人在这页刚看完一屏 listing，判断成本最低。
         也有一条实测理由：拿货页是固定高度 flex + 内部滚动，往里插一块折叠卡会把宫格卡尾
         按钮挤出可点区（`today:ui` 的几何守卫 elementFromPoint 直接红）—— 那页的主活是
         开单，不能为了低频整理动它。
         ⚠️ 它**不是门**：默认折叠、可完全不碰，合并只影响"按款汇总"的口径。 -->
    <StyleMergeCard />

    <section class="wb-panel">
      <div class="wb-panel__head">
        <!-- ── 范围切换（2026-10-12）──────────────────────────────────────────────
             这块原来是**只读**的计数句「待核对 X · 已核对 Y」，现在两个数各自成为一个范围。
             为什么要能切：已核对的行按定义不在待核对列表里（本页只查 corrected=0）⇒
             **没有屏幕**能看见它们，也就没有地方能"退回待核对"。
             为什么用分段控件而不是两个按钮：这两块是**互斥视图**（同一张表的两种筛法），
             不是两个动作 —— 控件形状要与"只能选一个"这件事一致（基座 .wb-seg，见
             src/styles/index.css，与「货与成本」的「待关联队列 / 已建立映射」同一套）。
             ⚠️ 数字仍然只出现在这里、且**唯一**（不是"再在别处写一遍"）：切换与计数是同一件事
             的两面 —— 你要选的正是"哪一批"。
             ⚠️ 2026-10-12：这里**原本前面还有一个标题**「待核对订单 / 已核对订单」（跟着范围走，
                理由是"表头写待核对、列的却是已核对"会误读）。用户报"页头同一件事说两处"——
                标题与紧挨着的分段项说的是同一件事（范围 + 属于哪一批），而分段控件自己就带
                `is-on` 高亮 + 计数，**它是唯一真源**。⇒ 删标题，范围只说这一处。
                （原标题还想防的"列的是已核对"由 `is-on` 状态与计数表达，不缺信息。） -->
        <!-- 自愈回执：只有这一轮真的补过才出现（"刚刚发生了改变"，与常驻说明不同） -->
        <span v-if="healed > 0" class="cl-healed" data-act="cl-auto-healed">
          已按现有映射自动补了 {{ healed }} 行归属
        </span>
        <div class="wb-seg cl-scope" role="tablist" aria-label="核对范围" data-act="cl-scope">
          <button
            type="button"
            role="tab"
            class="wb-seg__item"
            data-act="cl-scope-pending"
            :class="{ 'is-on': scope === 'pending' }"
            :aria-selected="scope === 'pending'"
            @click="setScope('pending')"
          >
            待核对
            <span
              class="wb-seg__badge"
              :class="{ 'wb-seg__badge--plain': !counts.pending }"
              data-act="cl-count-pending"
            >
              {{ counts.pending }}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            class="wb-seg__item"
            data-act="cl-scope-corrected"
            :class="{ 'is-on': scope === 'corrected' }"
            :aria-selected="scope === 'corrected'"
            @click="setScope('corrected')"
          >
            已核对
            <span class="wb-seg__badge wb-seg__badge--plain" data-act="cl-count-corrected">
              {{ counts.corrected }}
            </span>
          </button>
        </div>
        <!-- 操作说明压到一行（原先三行解释，含"为什么要点款"的整段理由）——
             理由本身不丢：它在**发生的那一刻**说（「同商品」徽标的 title、保存后的回流 toast），
             不需要在页头先讲一遍。改这段时**别把原因再抄回来**（冒烟有长度守卫）。
             ⚠️ 两个范围的动作**不同**（待核对＝编辑+保存；已核对＝退回），说明必须跟着换 ——
             一句话盖两边必然有一边是错的（"点保存"在已核对里根本没有那个按钮）。
             ⚠️ 2026-10-28 加"批量"这半句：勾选后吸底动作条才出现，说明里不提一句的话，
                用户不会知道有这条路（而那正是这一轮要治的问题）。长度仍在 80 字以内。 -->
        <span class="wb-muted" data-act="cl-guide">
          {{
            scope === 'pending'
              ? '点「归属款」挑款 → 选色 → 保存并下一条；多行可勾选后批量定款 / 确认无误。回车＝保存并跳下一条'
              : '这些是核对过的行。要改哪一行，点「退回待核对」把它放回待核对列表，改好再保存'
          }}
        </span>
        <!-- 「全部确认无误」只在待核对范围有意义：对已核对的行再确认一次是**空动作**
             （那些行本来 corrected 就是 1）。留在那里会让用户以为它能做别的什么。
             ⚠️ 2026-10-28 文案改「这批」：原名会让人以为动的是全库（而它原先**真的**动全库，
                那是 bug；现在动的是"今天这批 + 当前搜索"，名字必须跟着说清范围）。 -->
        <span v-if="scope === 'pending'" class="cl-actions">
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="cl-all-ok"
            :disabled="busy || !total"
            :title="`把当前筛选下（${applied ? '搜索结果里的' : '今天这批里的'}）所有待核对行一起确认`"
            @click="confirmAll"
          >
            这批全部确认无误
          </button>
        </span>
      </div>

      <div v-if="rows.length" class="wb-panel__body wb-table-wrap">
        <table class="wb-table cl-table" data-act="cl-table">
          <thead>
            <tr>
              <!-- 勾选列（2026-10-28 批量）：只在待核对范围出现 —— 已核对是只读列表，
                   "退回"是一行一个判断，攒批退回会把"哪一行出错了"这件事糊掉。 -->
              <th v-if="scope === 'pending'" class="cl-sel-col">
                <input
                  type="checkbox"
                  class="cl-sel"
                  data-act="cl-select-all"
                  :checked="allSelected"
                  :indeterminate="someSelected && !allSelected"
                  :disabled="!selectableRows.length || busy"
                  :title="allSelected ? '取消全选本页' : `选中本页 ${selectableRows.length} 行`"
                  @change="toggleSelectAll"
                />
              </th>
              <th class="cl-thumb-col">图</th>
              <th>订单号</th>
              <th>店铺</th>
              <th class="cl-color-col">颜色</th>
              <th>尺码</th>
              <th class="cl-style-col">归属款</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="o in rows"
              :key="o.id"
              :class="{ 'is-selected': isSelected(o) }"
              @keydown.enter="onRowEnter(o, $event)"
            >
              <!-- 勾选框旁**不加**禁用：有未保存改动的行也能勾（禁用而不解释 = 一次静默失败）。
                   批量「确认无误」会跳过它并在回执里点名，判据写在 title 里。 -->
              <td v-if="scope === 'pending'" class="cl-sel-col">
                <input
                  type="checkbox"
                  class="cl-sel"
                  :data-act="`cl-select-${o.id}`"
                  :checked="isSelected(o)"
                  :title="isDirty(o) ? '这行有未保存的改动：批量「确认无误」会跳过它（改动不会被丢）' : '勾选后可批量确认 / 批量定款'"
                  @change="toggleSelect(o)"
                />
              </td>
              <td class="cl-thumb-col">
                <!-- 核对必须看得全图：识别结果对不对，是**拿图比**出来的而不是读文字读出来的。
                     ⚠️ 基座 `.wb-thumb` 是 40px + `object-fit: cover`（会裁掉边缘），本页在
                     `.cl-table` 里覆盖成 96px + `contain` —— 商品照多是竖版，cover 之下
                     上下两端正是"款长什么样"的关键部位（2026-10-10 用户报的"图片展示不全"）。
                     ⚠️ 已核对范围里**同样要出图**：退回的判据就是"这张图定错了款"，没有图退回只能靠猜。
                     ⭐ 2026-10-12 用户**第二次**报"图片展示不全"（同一句话，10-10 已修过 cover→contain）：
                       图既然从来不缺角（主进程等比缩放 + contain，真库 35 张里 31 张方图 contain 满格、
                       4 张竖版也完整），剩下的问题就只能是**尺寸** —— 64px 看不清印花 / 领型 / 颜色，
                       而这一页的全部工作就是拿图比对。表格里放到 96px，再给**点开看原图**
                       （`order-read-image` 不缩放）—— 与「货与成本」同一套模式（`goods/api.ts`
                       写明"认款要看清印花/领型/颜色，256 不够"）。
                     ⚠️ 「能点开」必须**常显**（⤢ 角标），不能只写在 title 里 —— 触屏 / 不会悬停的人
                        永远看不到 title（同 `PoolPane` 2026-10-10 P2-1 的教训）。 -->
                <button
                  v-if="thumbs[o.localPath || '']"
                  type="button"
                  class="cl-thumb-btn"
                  :data-act="`cl-zoom-${o.id}`"
                  title="点击看大图（原图）"
                  @click="openImage(o)"
                >
                  <img class="wb-thumb cl-thumb" :src="thumbs[o.localPath || '']" :alt="o.orderNo" />
                  <span class="cl-thumb-btn__zoom" aria-hidden="true">⤢</span>
                </button>
                <span v-else class="wb-thumb wb-thumb--empty" title="这条订单没有主图"></span>
              </td>
              <td class="wb-mono">
                {{ o.orderNo }}
                <!-- ⭐「同商品」徽标：这几行是**同一家店的同一个商品ID** ⇒ 只需定一次款。
                     它只在 >1 时出现；没有商品ID 的行（`o.itemId` 空串）永远没有它 ——
                     "同一个商品"与"没有商品ID"是两件事，别让它们长成一个样子。
                     ⚠️ 只在**待核对**范围出现：它说的是"给其中一行点名款，其余行以后会自动归类"，
                        那是一个**要做的动作**；已核对范围里没有可点名的下拉，留着它就成了空承诺。
                     ⚠️ 2026-10-28 改成**可点**：点一下 = 勾选本页这个商品的所有行。这是批量定款
                        最自然的起点（用户看到"同商品 ×6"的下一个念头就是"那把 6 行一起定了吧"）。
                        原先它只是个 span，用户得自己一行一行勾 —— 那正是"路径太长"的一部分。 -->
                <button
                  v-if="scope === 'pending' && sameCount(o) > 1"
                  type="button"
                  class="wb-tag cl-same"
                  :data-act="`cl-same-${o.id}`"
                  :title="`本页有 ${sameCount(o)} 行是这家店的同一个商品。点这里把这 ${sameCount(o)} 行一起勾上，再一次定款；也可以只给其中一行点名款，其余行以后会自动归类`"
                  @click.stop="selectSameProduct(o)"
                >
                  同商品 ×{{ sameCount(o) }}
                </button>
              </td>
              <td>{{ o.shop || '—' }}</td>
              <!-- ── 颜色（2026-10-10 用户口径重做）──────────────────────────────
                   ① 点了归属款 ⇒ **这个款有哪些颜色就选哪些**（下拉），不再是自由文本；
                   ② 默认值 = 「这张图上次定的颜色」—— 宿主把它记在 `oi_images.style_color_id`
                      上（订单列表联表出来就是 `o.styleColor`），图片按内容/URL 指纹去重 ⇒
                      **同样的图片地址下次进来读到的还是这一行**，于是自动带出上次的颜色；
                   ③ 那个颜色**不在**当前归属款的色卡里 ⇒ **留空让用户自己选**
                      （不替他改判，也不把别的款的色硬塞进来）；
                   ④ 没点名款（走自动匹配）或这个款还没录颜色 ⇒ 回落成自由输入 + 本库已用写法的建议。
                   ⚠️ 布局是「一个格子两种控件」而不是两个格子：它们是**同一个字段的两种形态**，
                      分开会让人以为"款的颜色"和"订单的颜色"是两回事（这个页面上它们不是）。
                   ⚠️ 已核对范围这一格是**只读**的：那一行要改就先退回（退回＝把它放回可编辑的列表），
                      在这里也能编辑的话，"退回"就变成多此一举的一步，而"哪些行还动得"会长成两套规则。 -->
              <td class="cl-color-col">
                <template v-if="scope === 'pending'">
                  <select
                    v-if="paletteOf(o).length"
                    v-model="draftOf(o).color"
                    class="wb-input wb-input--sm cl-cell"
                    :data-act="`cl-color-${o.id}`"
                    :title="colorTitle(o)"
                  >
                    <option value="">请选择颜色</option>
                    <option v-for="c in paletteOf(o)" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <input
                    v-else
                    v-model="draftOf(o).color"
                    class="wb-input wb-input--sm cl-cell"
                    :data-act="`cl-color-${o.id}`"
                    list="cl-color-options"
                    :placeholder="draftOf(o).styleCode ? '填颜色' : '自动'"
                  />
                  <span v-if="colorMissing(o)" class="cl-warn" :data-act="`cl-color-warn-${o.id}`">
                    请先选颜色
                  </span>
                </template>
                <span v-else class="cl-ro" :data-act="`cl-ro-color-${o.id}`">
                  {{ displayColor(o) || '—' }}
                </span>
              </td>
              <td>{{ o.size || '—' }}</td>
              <td class="cl-style-col">
                <template v-if="scope === 'pending'">
                  <!-- ── 归属款（2026-10-28 换掉原生下拉）────────────────────────────
                       用户原话：「只是通过下拉列表看文字，不够直观，也容易对应错」。
                       原生 `<select>` 有两条死路：① 选项里放不了图；② 展开时没法把这一行的
                       订单图摆在旁边。而这件事的全部判据就是**图**（"这款是不是这一单"）。
                       ⇒ 换成"带款首图的格子 + 弹层选择器"：
                         · 格子常显**当前款的首图**（一眼看出这行挂的是哪款，不是一串编码）；
                         · 点开弹层，左边固定这一行的订单图，右边带图列表 + 搜索 —— 拿图挑款。
                       ⚠️ `data-style` 是给冒烟/脚本读**当前值**的锚点（换掉 value 之后，
                          原来靠 `<select>.value` 的断言会全部失效 —— 值必须有个等价出口）。
                       ⚠️ 「自动匹配」这一支仍在（弹层底部「不点名款」）：改错了要能退回去。 -->
                  <button
                    v-if="styleOptions.length"
                    type="button"
                    class="cl-style-btn"
                    :class="{ 'is-auto': !draftOf(o).styleCode }"
                    :data-act="`cl-style-${o.id}`"
                    :data-style="draftOf(o).styleCode"
                    :title="styleBtnTitle(o)"
                    @click="openPicker(o)"
                  >
                    <img
                      v-if="draftOf(o).styleCode && styleThumbOf(draftOf(o).styleCode)"
                      :src="styleThumbOf(draftOf(o).styleCode)"
                      class="cl-style-btn__img"
                      :data-act="`cl-style-thumb-${o.id}`"
                      alt=""
                    />
                    <!-- 点了款、但这款没有图 ⇒ 虚线占位（"没图"是个事实，要说出来）；
                         没点名款 ⇒ **不留图位** —— 自动匹配本来就没有"哪一款"，摆一个空框
                         会被读成"这行缺数据"（2026-10-28 首版截图实测，看着像坏了）。 -->
                    <span
                      v-else-if="draftOf(o).styleCode"
                      class="cl-style-btn__img cl-style-btn__img--empty"
                      :data-act="`cl-style-thumb-empty-${o.id}`"
                      aria-hidden="true"
                    ></span>
                    <span class="cl-style-btn__text">
                      <template v-if="draftOf(o).styleCode">
                        <b class="wb-mono">{{ draftOf(o).styleCode }}</b>
                        <span v-if="styleNameOf(draftOf(o).styleCode)" class="wb-muted cl-style-btn__name">
                          {{ styleNameOf(draftOf(o).styleCode) }}
                        </span>
                      </template>
                      <template v-else>
                        <span class="cl-style-btn__auto">
                          自动匹配{{ o.styleCode ? `（当前 ${o.styleCode}）` : '（未归类）' }}
                        </span>
                      </template>
                    </span>
                    <span class="cl-style-btn__go" aria-hidden="true">选</span>
                  </button>
                  <span v-else class="wb-muted">产品库为空 —— 先到「产品管理」建档</span>
                  <!-- 「填了颜色却没有款可挂」：颜色的**载体是款色**（`oi_style_colors(款, 色)`），
                       没点名款、又没有可用于自动匹配的特征时，这个颜色落不到任何地方 ——
                       原先它照样能保存（宿主只写订单自己的 color 列，提示还是"已保存"），
                       而拿货单/算钱/取图全读款色 ⇒ 用户看到的是一次**成功的假动作**。
                       与颜色格的「请先选颜色」是对称的两半：那半边是"有款没色"，这半边是"有色没款"。 -->
                  <span v-if="colorUnattached(o)" class="cl-warn" :data-act="`cl-style-warn-${o.id}`">
                    颜色要挂在款上，先点名款
                  </span>
                </template>
                <span v-else-if="o.styleCode" class="cl-ro" :data-act="`cl-ro-style-${o.id}`">
                  {{ o.styleCode }}<span v-if="o.styleName" class="wb-muted"> · {{ o.styleName }}</span>
                </span>
                <span v-else class="wb-muted" :data-act="`cl-ro-style-${o.id}`">未归类</span>
              </td>
              <td class="cl-ops">
                <template v-if="scope === 'pending'">
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`cl-save-${o.id}`"
                    :disabled="busy || !isDirty(o) || colorMissing(o) || colorUnattached(o)"
                    @click="saveOne(o)"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`cl-ok-${o.id}`"
                    :disabled="busy"
                    @click="confirmOne(o)"
                  >
                    确认无误
                  </button>
                </template>
                <!-- 退回待核对：已核对范围里**唯一**的动作。
                     ⚠️ 它与「保存」不是同一件事的两半，别把两个范围的动作凑成一套：
                        待核对是"定款 + 定色 + 落库"，已核对是"把这一行放回去重做"。
                        这里给「保存」就等于在已核对的行上直接改 —— 那正是"看不见编辑入口"的
                        老问题（用户报过"核对完就找不着了"），退回这一步必须真的存在、且看得见。 -->
                <button
                  v-else
                  type="button"
                  class="wb-link"
                  :data-act="`cl-reopen-${o.id}`"
                  :disabled="busy"
                  @click="reopenOne(o)"
                >
                  退回待核对
                </button>
                <!-- 拆包（2026-10-21，阶段 B2）：一单多包、按商品行拆数量。
                     ⚠️ 它与"核对"是两件事：核对定的是"这行是什么款"，拆包定的是"这些件怎么装箱"。
                        所以**两个范围都给**（已核对的行照样要装包），且不占「保存/确认」那组的位置。 -->
                <button
                  type="button"
                  class="wb-link"
                  :data-act="`cl-parcel-${o.id}`"
                  :disabled="busy"
                  title="一单多包、按商品行拆件数"
                  @click="openParcel(o)"
                >
                  拆包<template v-if="parcelCounts[o.orderNo]"> ×{{ parcelCounts[o.orderNo] }}</template>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="wb-empty" data-act="cl-empty">
        <p class="wb-empty__title">{{ emptyTitle }}</p>
        <p class="wb-empty__desc">{{ emptyDesc }}</p>
        <!-- 空态的出口（⚠️「提示不是入口」：空态说明里的下一步必须**点得到**，不能只是句说明）：
             三种空态各自的下一步不同 ——
               · 今天还没导   → 去导入（本页无对象可核对）
               · 搜不到       → 不给按钮（清空搜索框就在旁边，塞个按钮反而多一步）
               · 这批核对完了 → **去「统计」看利润 / 去「拿货」页签**（独立模块 + 第 3 步）——
                 原先这里什么都没有，用户核对完就"断"在这一页上。
             ⚠️ 2026-10-17：算钱整步撤出发货台后，第一个出口变成**真跳「统计」模块**
                （`openModule('order-cost')`）；「去「拿货」页签」仍是就地切页签（第 3 步）。
             ⚠️ 2026-10-12 补第三个出口：**看已核对的行**。前两个出口都是"往前走"，
                而"核对完了发现漏了两行"是往后走 —— 没有这个出口时，用户会以为
                这一页到此为止、那两行再也改不了（真库现场：23 行全已核对，用户找不到回去的路）。
                它与页头的范围切换是同一个动作（setScope），不是第二条实现。 -->
        <div class="wb-empty__actions">
          <button
            v-if="!hasOrders"
            type="button"
            class="wb-btn wb-btn--primary"
            data-act="cl-goto-import"
            @click="go('import')"
          >
            去导入订单
          </button>
          <template v-else-if="applied">
            <!-- 搜索无结果时不给按钮（清空搜索框就在旁边）—— 两个范围一致 -->
          </template>
          <button
            v-else-if="scope === 'corrected'"
            type="button"
            class="wb-btn wb-btn--primary"
            data-act="cl-goto-pending"
            @click="setScope('pending')"
          >
            回到待核对
          </button>
          <template v-else>
            <button
              type="button"
              class="wb-btn wb-btn--primary"
              data-act="cl-goto-cost"
              @click="openModule('order-cost')"
            >
              去「统计」看利润
            </button>
            <button
              type="button"
              class="wb-btn"
              data-act="cl-goto-purchase"
              @click="go('purchase')"
            >
              去「拿货」页签
            </button>
            <button
              type="button"
              class="wb-btn"
              data-act="cl-goto-corrected"
              @click="setScope('corrected')"
            >
              看已核对的 {{ counts.corrected }} 行
            </button>
          </template>
        </div>
      </div>

      <!-- 看大图（2026-10-12）。与「货与成本」的 `gd-viewer` 同一套模式：
           ① 先用**已经在手里的缩略图**把弹层开出来（不等网络 / 磁盘，点下去立刻有东西看）；
           ② 再读**原图**换上（`order-read-image` 不缩放；`maxEdge` 那条通道在主进程被夹到 256，
              表格展示级够用、"看清印花/领型"不够）；
           ③ 读失败**保留缩略图**并说明，不比现在更坏；
           ④ 连点只认最后一次（`viewerSeq`），否则"点了 A 又点 B"可能把 A 的晚到的原图盖到 B 上。
           ⚠️ 原图可至 MB 级 ⇒ **只在用户点开某一张时读**，不要随表格批量预取。
           ⚠️⚠️ 它**必须放在 `v-if="rows.length"` / `v-else` 那一段之后**：这块的 `v-else`
               绑的是上面那个 `v-if`。第一版我把弹层插在两者中间 ⇒ `v-else` 改绑到 `viewer`
               ⇒ 表格与空态**同时渲染**（每屏都多出一段"今天这批都核对完了"）。
               既有断言 `!cl-empty && cl-table` 当场抓住。往这里加东西先看前后的 v-if/v-else。 -->
      <div v-if="viewer" class="wb-mask" data-act="cl-viewer" @click.self="viewer = null">
        <div class="wb-dialog cl-viewer" role="dialog" aria-modal="true" aria-label="查看订单图">
          <div class="wb-dialog__head">
            <span class="wb-mono">{{ viewer.orderNo }}</span>
            <span v-if="viewer.full" class="wb-muted cl-viewer__tag">原图</span>
            <span v-else class="wb-muted cl-viewer__tag">缩略图</span>
          </div>
          <div class="wb-dialog__body cl-viewer__body">
            <img v-if="viewer.src" :src="viewer.src" class="cl-viewer__img" alt="" />
            <p v-else class="wb-muted">这张图读不出来 —— 文件可能已被移动或删除。</p>
          </div>
          <div class="wb-dialog__foot">
            <button class="wb-btn" type="button" data-act="cl-viewer-close" @click="viewer = null">
              关闭
            </button>
          </div>
        </div>
      </div>

      <!-- ── 批量动作条（2026-10-28）─────────────────────────────────────────────
           用户原话：「归属款还是只能一个一个选，路径太长（点击、选择、关闭、确认）」。
           这条是"勾选 → 一次提交"的落点，吸附在可视区底部（表格再长也够得着）。

           ⚠️ 按钮上的数字 = **真的会被处理的行数**，不是勾选数：
              「确认无误（3）」在有 2 行脏的时候显示 3 而不是 5，并另说"其中 2 行有未保存的改动"。
              数字诚实是这条动作条的全部价值 —— 一个点了之后"少做了两行"的批量确认，
              比没有批量更糟（用户以为全好了，结果是明天在对账页上发现）。
           ⚠️ 挂着 `v-if="selectedIds.size"`：没勾任何行时它**不在页面上**，
              不是"灰着一条"。空动作条占 40px 高，而这一页每多 40px 就少半行订单。 -->
      <div v-if="scope === 'pending' && selectedIds.size" class="cl-bulk" data-act="cl-bulk">
        <span class="cl-bulk__count" data-act="cl-bulk-count">已选 {{ selectedIds.size }} 行</span>
        <span v-if="dirtySelected > 0" class="wb-muted cl-bulk__hint" data-act="cl-bulk-dirty">
          其中 {{ dirtySelected }} 行有未保存的改动，不会一起确认
        </span>
        <span class="cl-bulk__spacer"></span>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-bulk-style"
          :disabled="busy"
          title="给这几行按商品分组定款（同一个商品只选一次）"
          @click="openBulkPicker"
        >
          批量定款…
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--sm wb-btn--primary"
          data-act="cl-bulk-ok"
          :disabled="busy || !bulkConfirmable.length"
          @click="bulkConfirm"
        >
          确认无误（{{ bulkConfirmable.length }}）
        </button>
        <button type="button" class="wb-link" data-act="cl-bulk-clear" @click="clearSelection">
          清空选择
        </button>
      </div>

      <div v-if="total > PAGE_SIZE" class="wb-panel__foot wb-pager" data-act="cl-pager">
        <span>共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-prev"
          :disabled="page <= 0 || loading"
          @click="gotoPage(page - 1)"
        >
          上一页
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-next"
          :disabled="page >= totalPages - 1 || loading"
          @click="gotoPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>

    <!-- 颜色输入建议（datalist）。**只在"没有可选色卡"时用得上**（没点名款 / 该款还没录颜色）——
         有款有颜色时给的是该款的下拉。刻意**不限制自由输入**：色卡是主数据，但现实里
         同一个色各写各的（"藏青" 与 "深蓝"），硬做成下拉会把真实存在的写法挡在外面。
         它要解决的是**同一个词各写各的**：标准色词表给规范写法，库内写法让第二次遇到
         同一个词时能选到同一个。 -->
    <datalist id="cl-color-options" data-act="cl-color-options">
      <option v-for="c in colorSuggestions" :key="c" :value="c"></option>
    </datalist>

    <!-- 归属款选择器（带图）。⚠️ 放在**空态 `v-else` 之后**（同上面 viewer 的纪律）：
         插进 `v-if="rows.length"` 与 `v-else` 之间，那个 `v-else` 会改绑到这个弹层上，
         于是表格与空态同时渲染。 -->
    <StylePicker
      v-if="pickerRow"
      :styles="styleOptions"
      :order-image="thumbs[pickerRow.localPath || ''] || ''"
      :order-no="pickerRow.orderNo"
      :shop="pickerRow.shop"
      :size="pickerRow.size"
      :order-color="displayColor(pickerRow)"
      :current-style="draftOf(pickerRow).styleCode"
      :current-color="draftOf(pickerRow).color"
      :has-next="pickerRowIdx >= 0 && pickerRowIdx < rows.length - 1"
      :busy="busy"
      @close="closePicker"
      @zoom-order="zoomPickedOrder"
      @pick="onStylePicked"
      @clear="onStyleCleared"
    />

    <!-- 批量定款弹层（2026-10-28）：勾选 N 行 → 按商品分组，每组选一次款 → 一次落库。
         ⚠️ 与 `StylePicker` 一样放在空态 `v-else` **之后**（插进 two-way 之间会让 v-else 改绑）。 -->
    <BulkStylePicker
      v-if="bulkGroups"
      :groups="bulkGroups"
      :styles="styleOptions"
      :style-thumbs="styleThumbs"
      :busy="busy"
      @close="closeBulkPicker"
      @apply="applyBulkStyles"
    />

    <!-- 拆包抽屉：打开时按 `orderNo` 拉整单（包裹 + 商品行 + 汇总），关掉重算行内徽标 -->
    <ParcelDrawer
      :visible="!!parcelOrderNo"
      :order-no="parcelOrderNo"
      @close="closeParcel"
    />
  </div>
</template>

<script setup lang="ts">
// 「归类核对」页签 = 发货流程第 2 步（2026-10-05 从「订单归类」岛内建过来）。
//
// **这一页干什么**：订单导进来只是"有这些单"，还不知道每单是什么款 —— 本页把"还没归到款的行"
// 逐条核对/修正。动作都在行内：
//   · 在「归属款」下拉里点名某个款 → 挂到该款并把指纹记入它（**后续同样的指纹会命中同一款**），
//     宿主顺带回流「商品ID → 款+色」；
//   · 再从**这个款的颜色**里选一个 → 宿主把「这张图 → 款+色」记下来（`oi_images.style_color_id`），
//     同一张图（地址相同 ⇒ 内容/URL 指纹相同 ⇒ 同一行）下次自动带出这个颜色；
//   · 识别结果没问题的点「确认无误」，离开待核对列表。
//
// ⚠️ 2026-10-10 用户口径的四条（改这一段前先读）：
//   ① **撤掉页头指标条**（原来那排「待核对 / 未归类 / 识别库 / 本页 N 个商品 / 已配产品」）——
//      用户原话是「我看不太懂，用户肯定也会很懵」。连带 `order-sku-rollup` 整条链路退场
//      （那条通道只为这条指标条而生，零消费者即删）。
//   ② **撤掉「品类」与「Logo」两列** —— 品类属于主数据（在「货与成本」里维护），Logo 等
//      「印花 logo 管理」做出来再加回来。⇒ 这一页**只做"归到哪个款 + 哪个颜色"**这一件事。
//      ⚠️ 两个字段仍然**原样回传**（`Draft` 里保留、不显示）：把已有值抹成空串比不显示更糟
//      （那是悄悄改数据），而指纹要的品类必须还是订单原本那个。
//   ③ **颜色改成"该款的颜色"下拉 + 记住图片的颜色**（见模板里颜色格的长注释）。
//   ④ **「归属款」下拉的数据源改成产品库全集** —— 旧实现按识别池（`oi_styles`）驱动，
//      在「货与成本」手工新建、还没出过订单的款一个都不出现（用户报的"展示不全"就是这个）。
//
// ⚠️ **「识别未归类」批量动作已于 2026-10-05 按用户要求删除**（原按钮 `data-act="cl-recognize"`）。
//   它做的事是"对本页 30 行里有图无款的行，逐张跑视觉模型并直接落库"。删它的三条理由：
//     ① **慢得离谱且绑住界面**：串行识图 20~60s/张 ⇒ 跑满一页十几分钟；
//     ② **范围是"当前页"而不是"所有未归类"**：翻页要重跑，用户以为全跑了其实只跑了一页；
//     ③ **直接落库**（reclassify + 写指纹），错了要逐条回退 —— 识别这种事更适合"先给建议、
//        人看一眼再定"，而不是替用户下结论。
//   ⇒ **识别该以什么形态回来尚未拍板**（导入时后台跑 / 逐行「识这张图」按钮 / 只做建议不落库）。
//   在拍板前本页只留逐行核对这条**必然正确**的路径。
//
//   ✅ **2026-10-28 已拍板：不做云端识别** —— 识别原语（`readEngine` / `recognizeOrder`）、
//   `src/core/ai`、`order-api-key-*` 与「设置 › 识别」页**一并删除**。本页要的"自动认出款与色"
//   改走**本地视觉**（无网络、无云模型）：路线与落点见
//   `docs/notes/2026-10-28-classify-local-vision-direction.md`。别再把云端引擎接回来。
//
// ⚠️ **2026-10-12 加「已核对」范围 + 行内「退回待核对」**（与用户确认过的口径）。要治的是：
//   核对过之后发现定错了款/色 —— 那些行按定义不在待核对列表里（本页只查 `corrected = 0`），
//   于是**屏幕上根本没有它们**，也就没有任何地方能改回去。真库现场：23 行全 `corrected=1`、
//   `oi_order_items.color` 全空、款色全是「未分类」（"填了没存、然后被确认掉了"留下的痕迹），
//   而代码里此前**没有任何一处**会把 `corrected` 置回 0 ⇒ 用户再也回不到那些行。
//   三条口径（改这块前先读）：
//     ① **范围切换**放页头（原来那句只读计数「待核对 X · 已核对 Y」的两个数各自成为一个范围）。
//        用 `.wb-seg` 分段控件：两块是**互斥视图**而不是两个动作，控件形状要与之相符；
//        数字仍只出现在这一处（切换与计数是同一件事的两面）。
//     ② **已核对范围是只读的**：款/色格子换成纯文本，操作列只留「退回待核对」。
//        要在那里直接编辑的话，"退回"就成了多此一举的一步，而"哪些行还动得"会长成两套规则。
//     ③ **退回只翻 `corrected` 这一位**（宿主 `reopenOrdersCorrected`），只发 id ——
//        把字段一起发过去等于用"退回那一刻界面上的草稿"覆盖上一轮核对留下的结论。
//        ⚠️ 刻意**没有「全部退回」**：一次退回整批不可逆（没有任何地方记着"它原来是不是核对过的"），
//        退回一律点名、一行一个动作。
//   ⚠️ 连带：本页的取数从 `listPending` 一处扩成 `listPending` / `listCorrected` 两处，
//      但两者**共用 `../classify.ts` 里同一个 `listPage`**（只差 `corrected` 参数）——
//      各写一套分页/搜索/导入日筛必然会漂。
//
// **照功能不照样式**：移植自原「订单归类」岛的**纠正页**（该岛已于 2026-10-05 整体下架，
// 源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的 `.panel/.bar/.btn`；
// 内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import { COLOR_WHITELIST } from '@/lib/orderClassifier';
import ParcelDrawer from './ParcelDrawer.vue';
import StylePicker from './StylePicker.vue';
import BulkStylePicker from './BulkStylePicker.vue';
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import { groupByProduct, pickColorFor, productKeyOf, type BulkGroupView } from '@/lib/classifyBulk';
import { localDayKey } from '@/lib/localDay';
import type { OrderRecord, SkuBackfillOutcome, StyleRecord, ColorAliasRemembered, ShopGate } from '@/types';
import { useShipping } from '../flowCtx';
import { styleImages } from '../purchase';
// 命名板（P3）：本页多出来的一块**可选**动作，见该组件头注释
import VariantNamingCard from './VariantNamingCard.vue';
import StyleMergeCard from './StyleMergeCard.vue';
import {
  PAGE_SIZE,
  listCorrected,
  listPending,
  listStyleOptions,
  loadShopGate,
  markCorrected,
  pendingCounts,
  reopenCorrected,
  saveCorrection,
} from '../classify';

const { token, go, bump, openModule } = useShipping();

/** 本页的两个**互斥范围**（同一张表的两种筛法，不是两个页面） */
type Scope = 'pending' | 'corrected';

interface Draft {
  /** 品类：**不显示、不编辑**，只原样回传给宿主（指纹 / 重归类要用） */
  category: string;
  color: string;
  /** Logo：同上（列已撤，值原样带回，别把库里已有的 logo 抹成空串） */
  logo: string;
  /** 归属款编码；`''` = 自动匹配（保持/重建当前归属） */
  styleCode: string;
  /**
   * 载入时的颜色 / 归属款 —— `isDirty` 的基准。
   *
   * ⚠️ 不能用 `o.color` 当基准：颜色格显示的可能是**图片记住的颜色**（`o.styleColor`，
   * 那是"以图为准"的结论），它与订单行自己的 `color` 列不一定相同 ⇒ 拿 `o.color` 比，
   * 每行一进页面就是"脏"的，「保存」按钮全亮着，"改了才让存"这条守卫当场失效。
   */
  baseColor: string;
  baseStyle: string;
}

const loading = ref(false);
const busy = ref(false);
const error = ref('');
/** 本次进页按已有映射**自动补上**的行数（0 = 没有漏网的，不显示） */
const healed = ref(0);
const search = ref('');
/** 已提交给主进程的关键字（与输入框里正在敲的 `search` 分开 —— 否则每次输入都会触发分页重置） */
const applied = ref('');
const page = ref(0);
/**
 * 当前看的范围（待核对 / 已核对）。默认待核对 —— 这是这一页的**本职工作**，
 * 已核对范围是"出错了才去"的那一支（默认落在它上面会让每天第一次进来看到一屏不需要动的行）。
 * ⚠️ 切范围**不清搜索词**：搜索框就一个，两个范围共用它；清掉的话用户会以为搜索被重置了。
 */
const scope = ref<Scope>('pending');

const rows = ref<OrderRecord[]>([]);
const total = ref(0);
/** 门 1（店铺归一）的派生状态：空 = 门是开的。派生不存档，每次 `load()` 重算 */
const shopGate = ref<ShopGate>({ pending: [], orders: 0 });
/** 门 1 的清单是否展开（默认收起：常驻的只有一句带数字的话，不占半屏） */
const shopGateOpen = ref(false);
/** 归属款下拉的数据源：**产品库全集**（不是识别池 —— 见 script 头注释 ④） */
const styleOptions = ref<StyleRecord[]>([]);
const counts = reactive({ pending: 0, corrected: 0, unclassified: 0 });
const thumbs = ref<Record<string, string>>({});
/** 「看大图」弹层：先用手里那张缩略图开出来，再换原图（见模板里弹层的长注释） */
const viewer = ref<{ orderNo: string; src: string; full: boolean } | null>(null);
/** 连点只认最后一次：晚到的原图不许盖到用户后来点的那一行上 */
let viewerSeq = 0;

// ---- 拆包（阶段 B2）----
/** 正在拆包的订单号；空串 = 抽屉关着 */
const parcelOrderNo = ref('');
/** 各订单已拆了几个包（行内「拆包 ×N」徽标；不在表里的 = 还没拆包） */
const parcelCounts = ref<Record<string, number>>({});

function openParcel(o: OrderRecord) {
  parcelOrderNo.value = o.orderNo;
}

/** 抽屉关了要重算徽标 —— 用户可能刚在里面加了包，徽标不更新等于"看不到自己做过的事" */
function closeParcel() {
  parcelOrderNo.value = '';
  void refreshParcelCounts();
}

async function refreshParcelCounts() {
  const nos = [...new Set(rows.value.map((o) => String(o.orderNo ?? '')).filter(Boolean))];
  if (!nos.length) {
    parcelCounts.value = {};
    return;
  }
  const r = await ipc.orderParcelCounts(nos);
  // 徽标只是提示，取不到就保持原样（不弹窗打断核对）；但**不诈称 0**，也不清空已有徽标
  if (!r.success) return;
  parcelCounts.value = r.data ?? {};
}
const drafts = reactive<Record<number, Draft>>({});
/** 库里已用过的颜色写法（`pendingCounts` 顺带返回）—— 自由输入时的建议 */
const usedColors = ref<string[]>([]);

/**
 * 切范围：**回到第 1 页**（两个范围的行数不同，留在第 3 页很可能直接落到空白页上，
 * 而"空列表"会被读成"这批没有东西"）。搜索词保留，理由见 `scope` 的注释。
 */
function setScope(s: Scope): void {
  if (scope.value === s) return;
  scope.value = s;
  page.value = 0;
  void load();
}

/**
 * 颜色框的输入建议（datalist）= **标准色词表 + 本库已用过的写法**（词表在前）。
 *
 * ⚠️ 只在"没有可选色卡"那一支用得上：有款有颜色时给的是**该款的下拉**（主数据说了算）。
 *    自由输入这一支放任它只有库内写法是不够的 —— 同一个色各写各的（"藏青" / "深蓝"）时，
 *    库内已有的写法只会让错误写法**自我强化**；词表用来把新写法拉回规范。
 */
const colorSuggestions = computed(() => {
  const s = new Set<string>();
  for (const c of COLOR_WHITELIST) s.add(String(c));
  for (const c of usedColors.value) s.add(String(c));
  return [...s];
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
/**
 * 今天这批里到底有没有东西（区分三种空态：还没导 / 搜不到 / 都核对完了）。
 * ⚠️ `corrected` 必须算进来：只有它 > 0 时，`pending = 0` 才意味着"核对完了"而不是"没导过"。
 * ⚠️ 两个范围**共用**这一个判据：它问的是"今天这批有没有东西"，与正在看哪个范围无关 ——
 *    按范围各算一份的话，已核对范围里"这批还没核对过任何行"会被答成"今天还没有导入订单"。
 */
const hasOrders = computed(() => counts.pending > 0 || counts.corrected > 0 || total.value > 0);
const emptyTitle = computed(() => {
  if (!hasOrders.value) return '今天还没有导入订单';
  if (applied.value) return '没有匹配的订单';
  if (scope.value === 'corrected') return '今天这批还没有核对过的行';
  return '今天这批都核对完了';
});
const emptyDesc = computed(() => {
  // ⚠️ 文案里**不要出现 markdown 星号**（`**X**` 在 HTML 里就是两个字面星号，不是加粗）。
  // ⚠️ 也不要用「待核对」这类**引号名**去指路：`tests/uxEntryNames.spec.ts` 会把
  //    "去/在/到/先/从/回「X」"里的 X 拿去对真实入口名，而范围名不是模块/页签名。⇒ 不带引号写。
  if (!hasOrders.value) {
    // ⚠️ 说「今天导入的订单行」而不是「导入进来的订单行」：本页口径是**今天这批**
    //（与容器汇总、算钱页同一个筛），不写清楚的话，库里明明有前几天的单却说"还没订单"
    // 会让人以为数据丢了。
    return '核对的对象是今天导入的订单行。先在第 1 步「导入订单」把平台导出的订单报表导进来。';
  }
  if (applied.value) {
    // 搜的是哪个范围就说哪个范围 —— 两个范围共用同一个搜索框，写错一边会让人以为搜索失灵
    return `换个关键字试试，或清空搜索框看全部${scope.value === 'corrected' ? '已核对' : '待核对'}订单。`;
  }
  if (scope.value === 'corrected') {
    return '点过「保存」或「确认无误」的行会出现在这里。发现哪一行定错了款或颜色，把它退回待核对，改好再保存。';
  }
  return `这 ${counts.corrected} 行都点过「保存」或「确认无误」了 —— 接着去第 3 步拿货；要算这批单赚不赚，去「统计」页。`;
});

// ───────────────────────────────────────── 款 → 颜色（2026-10-10 新口径）

/** 某个款有哪些颜色可选（款编码 → 色卡；查不到 / 未点名款 = 空，界面回落成自由输入） */
function colorsFor(code: string): string[] {
  const c = String(code ?? '').trim();
  if (!c) return [];
  return styleOptions.value.find((s) => s.code === c)?.colors ?? [];
}

/** 这一行**当前草稿所选款**的色卡（模板里读它决定用下拉还是输入框） */
function paletteOf(o: OrderRecord): string[] {
  return colorsFor(draftOf(o).styleCode);
}

/**
 * 这一行载入时的颜色。优先级（**每一支都要在色卡里才作数**）：
 *   ① 图片记住的颜色 `o.styleColor`（宿主存在 `oi_images.style_color_id` 上，见模板长注释）；
 *   ② 订单自己的颜色列（上一轮人工核对留下的值）；
 *   ③ 都不在色卡里 ⇒ `''`（**留空让用户自己选** —— 不替他猜）。
 * 没点名款（自动匹配）或该款还没录颜色 ⇒ 色卡为空 ⇒ 直接用订单的颜色列（自由输入那一支）。
 */
function initialColor(o: OrderRecord): string {
  const palette = colorsFor(String(o.styleCode ?? ''));
  const own = String(o.color ?? '').trim();
  if (!palette.length) return own;
  const remembered = String(o.styleColor ?? '').trim();
  if (remembered && palette.includes(remembered)) return remembered;
  if (own && palette.includes(own)) return own;
  return '';
}

/**
 * 已核对范围里颜色格的**只读**显示值。
 *
 * 优先级与 `initialColor` 同源但**不同义**，别把两者合并：
 *   · `initialColor` 回答的是"编辑时该预选哪个"（**要落在该款色卡里**才作数，不在就留空让人选）；
 *   · 这里回答的是"这一行**现在是什么**"（款色优先 —— 下游（拿货单/算钱/取图/商品ID 回流）
 *     读的正是 `oi_images.style_color_id` 那一份，订单自己的 `color` 列只是上一轮人工留下的记录，
 *     两者不一致时屏幕上必须显示**真正在生效的那个**，否则用户会以为改对了）。
 */
function displayColor(o: OrderRecord): string {
  return String(o.styleColor ?? '').trim() || String(o.color ?? '').trim();
}

/** 颜色格「为什么是这个值」的一句话（下拉的 title；把"记住"这件事说出来，否则用户不知道它从哪来） */
function colorTitle(o: OrderRecord): string {
  const palette = colorsFor(String(o.styleCode ?? ''));
  const remembered = String(o.styleColor ?? '').trim();
  const head = `这个款有 ${palette.length} 个颜色可选`;
  if (!remembered) return `${head}（选了款就按这个款的色卡选，色卡里没有的可以先不选）`;
  if (palette.includes(remembered)) return `${head}；默认选中「${remembered}」—— 是这个商品的图片上次定的颜色`;
  return `${head}；图片上次定的颜色是「${remembered}」，不在这个款的色卡里，所以留空让你自己选`;
}

/**
 * 换了归属款之后跟着换色卡：草稿里的颜色**不在新款色卡里**就清空（让用户重新选）。
 *
 * ⚠️ 2026-10-28 起这条规则**搬到了 `StylePicker.pickRow`**（换控件后"换款"只发生在弹层里）：
 *    那边选款时就按新色卡判一次，且**没选色不许确定** —— 于是"换了款、颜色还挂在旧款的色上"
 *    这个中间态在界面上根本不存在了。这里刻意**不再**补一份：两处各判一次，
 *    症状是"明明选了颜色却还是被清掉"（载入口径 `initialColor` 与清空口径打架）。
 */
// ───────────────────────────────────────── 归属款：带图选择（2026-10-28）

/** 正在挑款的那一行；`null` = 弹层关着 */
const pickerRow = ref<OrderRecord | null>(null);
/**
 * 款首图（款编码 → dataUrl）。行内格子上常显 —— 用户要治的是"只能看文字、容易对应错"，
 * 所以**不选的时候也要看得见图**，不能只在弹层里有。
 *
 * ⚠️ 取数只在 `load()` 之后对**本页出现的款**做（去重 + 上限），不跟翻页/逐行保存重复跑。
 */
const styleThumbs = ref<Record<string, string>>({});

function styleNameOf(code: string): string {
  const c = String(code ?? '').trim();
  if (!c) return '';
  return styleOptions.value.find((s) => s.code === c)?.name ?? '';
}

function styleThumbOf(code: string): string {
  const c = String(code ?? '').trim();
  return c ? (styleThumbs.value[c] ?? '') : '';
}

/** 格子的 title：把"这个款有几个颜色 / 还没录颜色"说出来（灰因不能只躺在弹层里） */
function styleBtnTitle(o: OrderRecord): string {
  const d = draftOf(o);
  if (!d.styleCode) return '没点名款 —— 按图片指纹自动匹配。点这里从带图的列表里挑一个款';
  const s = styleOptions.value.find((x) => x.code === d.styleCode);
  const n = s?.colors.length ?? 0;
  const cols = n ? `这个款有 ${n} 个颜色` : '这个款还没录颜色';
  return `归属 ${d.styleCode}${s?.name ? ` · ${s.name}` : ''} —— ${cols}；点这里换款`;
}

function openPicker(o: OrderRecord): void {
  pickerRow.value = o;
  void loadStyleThumbs();
}

/** 正在挑款的行在**当前页**里的下标（-1 = 不在列表里）；主按钮文案与"下一条"都看它 */
const pickerRowIdx = computed(() => {
  const o = pickerRow.value;
  if (!o) return -1;
  return rows.value.findIndex((r) => Number(r.id) === Number(o.id));
});

/**
 * 下一次 `load()` 结束后要接着打开的那一行（下标）；-1 = 不接。
 *
 * ⚠️ 用**下标**而不是 id：保存会把该行置为已核对、它随即离开列表、后面的行整体上移一位，
 *    "下一条"正好落在同一下标上（与 `applyFocus` 同一条理由）。
 * ⚠️ 必须在 `saveOne` **之前**赋值：`bump()` 触发的 `load()` 与本次 continue 谁先跑没有保证，
 *    先赋值 ⇒ 无论谁先，`load()` 结束时都能看见它。
 */
let nextAfterSave = -1;

function closePicker(): void {
  pickerRow.value = null;
}

/** 弹层里点订单图放大 —— 复用本页既有的原图弹层（`openImage`），不另开一套 */
function zoomPickedOrder(): void {
  const o = pickerRow.value;
  if (o) void openImage(o);
}

/**
 * 弹层回填：**款与色一起写**（弹层里已经按新色卡选好了，这里不再二次判色）。
 *
 * `save = true`（主按钮「保存 / 保存并下一条」）⇒ 立刻落库并**接着开下一行**，
 * 用户从此不必"关弹层 → 点保存 → 找到下一行再点开"（那三步正是用户嫌长的部分）。
 * `save = false`（「只填上」）⇒ 只回填草稿，行内「保存」变亮 —— 可退回的中间态，不是主路径。
 *
 * ⚠️ 保存失败时**不推进**：弹层留着，用户能看见原因并重试；推进了就等于"这次改动丢了、
 *    而且人还走远了"。这就是 `saveOne` 必须返回布尔的原因。
 */
async function onStylePicked(p: { styleCode: string; color: string }, save: boolean): Promise<void> {
  const o = pickerRow.value;
  if (!o) return;
  const d = draftOf(o);
  d.styleCode = p.styleCode;
  d.color = p.color;
  if (!save) {
    pickerRow.value = null;
    return;
  }
  const idx = pickerRowIdx.value;
  nextAfterSave = idx;
  const ok = await saveOne(o, { force: true });
  if (!ok) {
    nextAfterSave = -1;
    return;
  }
  // 先关掉；`load()` 末尾若还有下一行会重新打开（见 load 里的消费点）
  pickerRow.value = null;
}

/**
 * 「不点名款」= 回到按图片指纹自动匹配。
 *
 * ⚠️ **只清款、不清颜色**，与换控件之前一致（原 `@change` 在 `palette` 为空时不碰颜色）：
 *    没点名款时颜色格回落自由输入，那个值仍会随保存写进订单行 —— 顺手抹掉等于
 *    "用户点了一下自动匹配，之前填的颜色没了"。
 */
function onStyleCleared(): void {
  const o = pickerRow.value;
  if (!o) return;
  const d = draftOf(o);
  d.styleCode = '';
  pickerRow.value = null;
}

/**
 * 取"本页涉及的款"的首图：`styleImages`（按款编码 + 款色查订单域代表图）→ 缩略图。
 *
 * ⚠️ 两条通道必须串起来（前一条只给本地路径）；任何一步失败都**静默** ——
 *    图是"帮你认"，不是"能不能核对"的前提（退化成空占位，格子照样能点开挑款）。
 */
let styleThumbSeq = 0;
async function loadStyleThumbs(): Promise<void> {
  // 缓存只增不减会长期攒下几百条 dataUrl（每条几 KB base64）；翻过几十页就换一轮。
  // 上限给 200：一页最多 30 行、款去重后远小于它 ⇒ 正常使用几乎不会触发。
  if (Object.keys(styleThumbs.value).length > 200) styleThumbs.value = {};
  const codes = [
    ...new Set(
      rows.value
        .map((o) => String(draftOf(o).styleCode ?? '').trim())
        .filter(Boolean)
    ),
  ].slice(0, 60);
  const want = codes.filter((c) => !styleThumbs.value[c]);
  if (!want.length) return;
  const seq = ++styleThumbSeq;
  try {
    const paths = await styleImages({
      items: want.map((c) => ({ styleCode: c, color: colorsFor(c)[0] ?? '' })),
    });
    const hit: { code: string; path: string }[] = [];
    want.forEach((c, i) => {
      const p = paths[i];
      if (p) hit.push({ code: c, path: p });
    });
    if (!hit.length) return;
    const t = await ipc.orderImageThumbBatch(hit.map((h) => ({ localPath: h.path, maxEdge: 128 })));
    if (seq !== styleThumbSeq) return;
    if (!t.success) return;
    const urls = t.data?.dataUrls ?? [];
    const next = { ...styleThumbs.value };
    hit.forEach((h, i) => {
      const url = urls[i];
      if (url) next[h.code] = url;
    });
    styleThumbs.value = next;
  } catch {
    /* 图是装饰：取不到就空占位 */
  }
}

/**
 * 点名了款却没给颜色 —— **不许保存**。
 *
 * 为什么拦得住才叫对：宿主落库时颜色是**款色的主键之一**（`oi_style_colors(style_id, color)`），
 * 空颜色会落出一个没有名字的款色，而界面上看不出任何异常（订单归到"某个没有颜色的款色"）。
 * 与其让它静默发生，不如让「保存」按不下去 + 格子里写明原因。
 */
function colorMissing(o: OrderRecord): boolean {
  const d = draftOf(o);
  return d.styleCode !== '' && d.color.trim() === '';
}

/**
 * 这一行**有没有可以挂颜色的地方**：点名了款就有（宿主挂到该款色）；没点名款时，只有**指纹非空**
 * 才可能靠重归类自动匹配到一个款 —— 而指纹由 `category + features` 拼成，**两者都空时是空串**
 * （真库里就是这样：导入没提品类、从没跑过 VLM）。
 *
 * ⚠️ 判据必须与 `saveCorrection` 用的是**同一个函数**（`buildStyleFingerprint`）：
 * 在这里另写一套判断，必然出现"界面说可以保存、保存下去什么都没发生"。
 */
function canAttachColor(o: OrderRecord): boolean {
  const d = draftOf(o);
  if (d.styleCode.trim() !== '') return true;
  return buildStyleFingerprint(d.category, Array.isArray(o.features) ? o.features : []) !== '';
}

/**
 * 填了颜色却没有款可挂 —— **不许"保存成功"**。
 *
 * 为什么拦住才叫对：颜色的载体是款色（`oi_style_colors(款, 色)`），下游（拿货单 / 算钱 / 取图 /
 * 商品ID 映射回流）读的都是**款色**，而不是订单自己的 `color` 列。没有款可挂时保存只会写
 * `oi_order_items.color` 并把该行置为已核对，界面上一切正常、`toast` 还说"已保存"，而用户要的那件事
 * 一件都没发生（2026-10-11 用户报的就是这一类"设了颜色却不生效"）。
 * 与 `colorMissing`（有款没色）是一对：**款与色是「款 + 色」的两半，缺哪一半都不该放行**。
 */
function colorUnattached(o: OrderRecord): boolean {
  const d = draftOf(o);
  return d.color.trim() !== '' && !canAttachColor(o);
}

// ───────────────────────────────────────── 「同商品」分组（这一页真正要做多少决定）

/**
 * 分组键 = **店铺原文 + 商品ID**。
 *
 * ⚠️ 2026-10-28 搬到 `@/lib/classifyBulk`：批量定款弹层的分组与这里的「同商品 ×N」徽标
 *    **必须是同一个函数**（各写一份的典型症状：徽标说这 3 行同商品，批量弹层却拆成 3 组）。
 *    那边有单测（`tests/classifyBulk.spec.ts`），改规则请改那一处。
 */
function productKey(o: OrderRecord): string {
  return productKeyOf(o);
}

/** 本页每个商品占了几行（只收有商品ID 的行） */
const productRows = computed(() => {
  const m = new Map<string, number>();
  for (const o of rows.value) {
    const k = productKey(o);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
});

/** 这一行所属商品在本页占了几行；0 = 这行没有商品ID（**不是** 1 —— 两者含义完全不同） */
function sameCount(o: OrderRecord): number {
  const k = productKey(o);
  return k ? (productRows.value.get(k) ?? 1) : 0;
}

// ───────────────────────────────────────── 批量选择（2026-10-28）

/**
 * 勾选的行 id。
 *
 * ⚠️ 存**新 Set**而不是原地改：`reactive(new Set())` 在模板里读 `size` 也能追踪，但
 *    "读 size"与"读 has"走的是两条不同的追踪路径，混用时报不更新最难查（列表没反应、
 *    动作条不出现）。整体替换是笨办法，但行为只有一种。
 */
const selectedIds = ref<Set<number>>(new Set());

const selectedRows = computed(() => rows.value.filter((o) => selectedIds.value.has(Number(o.id))));
/**
 * 可以勾选的行 = 本页所有行（**刻意不排除脏行**）。
 *
 * 排除脏行看起来更"安全"，但代价是：勾选框灰着、没有任何解释，用户只看到"这一行勾不上"。
 * 而脏行恰恰是"刚改了款/色、正要保存"的行 —— 它们更需要能被批量动作看见。
 * 真正的守卫放在动作里：批量「确认无误」只处理不脏的行，并把跳过的行数说出来。
 */
const selectableRows = computed(() => rows.value);
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((o) => selectedIds.value.has(Number(o.id)))
);
const someSelected = computed(() => rows.value.some((o) => selectedIds.value.has(Number(o.id))));
/** 勾中但有未保存改动的行数 —— 它们**不会**被批量确认（改动不能被静默丢掉） */
const dirtySelected = computed(() => selectedRows.value.filter((o) => isDirty(o)).length);
/** 批量「确认无误」真正会处理的行（= 勾中 − 脏行）；按钮上的数字取它 */
const bulkConfirmable = computed(() => selectedRows.value.filter((o) => !isDirty(o)));

function isSelected(o: OrderRecord): boolean {
  return selectedIds.value.has(Number(o.id));
}

function toggleSelect(o: OrderRecord): void {
  const next = new Set(selectedIds.value);
  const id = Number(o.id);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll(): void {
  if (allSelected.value) {
    selectedIds.value = new Set();
    return;
  }
  selectedIds.value = new Set(rows.value.map((o) => Number(o.id)));
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

/**
 * 点「同商品 ×N」= 勾选本页这个商品的所有行。
 *
 * 这是批量定款最自然的起点：用户看见"同商品 ×6"，下一个念头就是"那 6 行一起定了吧"。
 * 原先徽标只是个说明，用户得自己一行行勾 —— 那正是"路径太长"的一部分。
 *
 * ⚠️ 只勾**本页**（这一页 30 行）而不是库里该商品的全部行：看不见的行不能被勾上，
 *    否则"我明明只勾了 6 行，怎么报了 9 行"。跨页的靠"同一行点名款 → 商品ID 回流"自动归类。
 */
function selectSameProduct(o: OrderRecord): void {
  const k = productKey(o);
  if (!k) return;
  const next = new Set(selectedIds.value);
  let n = 0;
  for (const r of rows.value) {
    if (productKey(r) !== k) continue;
    next.add(Number(r.id));
    n += 1;
  }
  selectedIds.value = next;
  toast(`已勾上这个商品在本页的 ${n} 行 —— 接着点「批量定款」一次给它们定款`, 'info');
}

/**
 * 批量「确认无误」：**一次 IPC、一次重载**（逐行调会重载 N 次，那正是逐行操作慢的来源）。
 *
 * ⚠️ 只发**不脏**的行（`bulkConfirmable`）—— 「确认无误」不写任何字段，所以脏行一旦被它
 *    带走，刚填的款/色就静默丢了（真库 2026-10-11 的 23 行 `corrected=1` 而 `color` 全空就是
 *    这么来的）。脏行留在勾选里并说明，让用户自己决定是保存还是放弃。
 * ⚠️ 回执里的数字取自**库返回的 updated**，不是"我以为提交了几行"。
 */
async function bulkConfirm(): Promise<void> {
  const ids = bulkConfirmable.value.map((o) => Number(o.id));
  const skipped = selectedRows.value.length - ids.length;
  if (!ids.length) {
    toast('勾中的行都有未保存的改动 —— 先逐行点「保存」，再批量确认', 'info');
    return;
  }
  busy.value = true;
  try {
    const n = await markCorrected(ids);
    const tail = skipped > 0 ? `；另外 ${skipped} 行有未保存的改动，没有一起确认` : '';
    toast(`已确认 ${n} 行${tail}`, skipped > 0 ? 'info' : 'success');
    // 确认掉的行已经离开列表 ⇒ 勾选里只剩"没被处理的"，保留它们（用户正要接着处理）
    selectedIds.value = new Set(selectedRows.value.filter((o) => isDirty(o)).map((o) => Number(o.id)));
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '批量确认失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ───────────────────────────────────────── 批量定款（2026-10-28）

/** 打开批量定款弹层时**快照**下来的分组（弹层期间列表可能被别处 bump，不能边选边变） */
const bulkGroups = ref<BulkGroupView[] | null>(null);

function openBulkPicker(): void {
  const chosen = selectedRows.value;
  if (!chosen.length) return;
  bulkGroups.value = groupByProduct(chosen, (o) => draftOf(o).styleCode).map((g) => ({
    ...g,
    images: g.rows.map((o) => thumbs.value[String(o.localPath ?? '')] ?? '').filter(Boolean),
  }));
  void loadStyleThumbs();
}

function closeBulkPicker(): void {
  bulkGroups.value = null;
}

/**
 * 把「组 → 款」落到每一行。
 *
 * 三件事必须一起看：
 *   ① 颜色**按行**定（`pickColorFor`）：同款不同单可以不同色，批量定款不能连带把颜色一锅端；
 *   ② 颜色定不出来的行**不保存**（不猜），留在列表并**重新勾上** —— 那是"接下来还要做"的那几行，
 *      取消勾选等于把它们混回 30 行里再也找不到；
 *   ③ 全程只 `bump()` **一次**（`saveOne` 带 `defer`）：逐行 bump 会让 30 行变成 30 次整页重载，
 *      而批量操作的全部意义就是把这个数降到 1。
 *
 * ⚠️ 落库是**串行逐行**的（没有事务边界）⇒ 部分失败是**可能**的，回执必须把三类数字分开报：
 *    已存 / 缺色 / 失败。谎称"全部成功"比失败本身更糟。
 */
async function applyBulkStyles(picks: { key: string; styleCode: string }[]): Promise<void> {
  const groups = bulkGroups.value ?? [];
  const codeOf = new Map(picks.map((p) => [p.key, p.styleCode]));
  busy.value = true;
  let done = 0;
  const needColorRows: OrderRecord[] = [];
  const failed: string[] = [];
  try {
    for (const g of groups) {
      const code = codeOf.get(g.key);
      if (!code) continue;
      const palette = colorsFor(code);
      for (const o of g.rows) {
        const color = pickColorFor(o, palette);
        if (!color) {
          needColorRows.push(o);
          continue;
        }
        const d = draftOf(o);
        d.styleCode = code;
        d.color = color;
        const ok = await saveOne(o, { force: true, silent: true, defer: true });
        if (ok) done += 1;
        else failed.push(o.orderNo);
      }
    }
  } finally {
    busy.value = false;
  }
  bulkGroups.value = null;
  // 缺色的行留在勾选里：它们就是"下一步要处理的那几行"
  selectedIds.value = new Set(needColorRows.map((o) => Number(o.id)));

  const parts = [`已定款并保存 ${done} 行`];
  if (needColorRows.length) {
    parts.push(`${needColorRows.length} 行要先选颜色（这个款的颜色不止一个，没有替你猜）—— 已留在列表并勾好`);
  }
  if (failed.length) parts.push(`${failed.length} 行保存失败`);
  const tone = failed.length ? 'error' : needColorRows.length ? 'info' : 'success';
  toast(parts.join('；'), tone);
  bump();
}

// ───────────────────────────────────────── 键盘流（回车＝保存并往下走）

/** 下一次取数完成后要把焦点送到的**行下标**；-1 = 不送 */
let focusRowIdx = -1;

/**
 * 把焦点送到目标行的「归属款」下拉 —— 这是逐行核对的**起点控件**（颜色是第二步）。
 *
 * ⚠️ 用**下标**而不是订单 id：保存会把该单置为已核对（`updateOrder` 里 `corrected = 1`），
 * 它随即离开待核对列表、后面的行**整体上移一位** ⇒ "下一条"在取数后正好落在同一下标上。
 * 钉在 id 上会找不到元素（那一行已经不在了），症状是"焦点丢了"，很难查。
 */
async function applyFocus(): Promise<void> {
  if (focusRowIdx < 0) return;
  // 焦点流只属于待核对范围：已核对行没有 `cl-style-<id>` 这个元素（那一格是只读文本），
  // 送过去只会是一次静默失败（`?.focus()` 打在 null 上）。切换范围时把待送的焦点也作废。
  if (scope.value !== 'pending') {
    focusRowIdx = -1;
    return;
  }
  const i = Math.min(focusRowIdx, Math.max(rows.value.length - 1, 0));
  focusRowIdx = -1;
  const o = rows.value[i];
  if (!o) return;
  await nextTick();
  document.querySelector<HTMLElement>(`[data-act="cl-style-${o.id}"]`)?.focus();
}

/**
 * 行内回车：**有改动就保存**（保存完焦点自动落到下一条），没有改动就单纯往下走一格。
 *
 * 焦点在按钮上时直接放行 —— 按钮的原生"回车＝点击"照常发生（Tab 到「保存」再按回车
 * 是一条很自然的路径，在这里拦掉会让它变成"按了没反应"）。
 */
function onRowEnter(o: OrderRecord, ev: KeyboardEvent): void {
  if (busy.value) return;
  // 已核对范围没有可编辑的格子，也就没有"回车＝保存并往下走"这条流（唯一的动作是「退回待核对」，
  // 而它在按钮上、原生回车＝点击照常）。不拦的话会调 `saveOne` —— 那是个**不该存在的动作**。
  if (scope.value !== 'pending') return;
  const t = ev.target as HTMLElement | null;
  if (t?.tagName === 'BUTTON') return;
  const idx = rows.value.findIndex((r) => Number(r.id) === Number(o.id));
  if (isDirty(o)) {
    // 被拦住的那两种（有款没色 / 有色没款）也交给 `saveOne` —— 由它把原因说出来，
    // 而不是"按了回车什么都没发生"。它们都不会让该行离开列表，故**不设**焦点目标。
    if (!colorMissing(o) && !colorUnattached(o)) focusRowIdx = idx;
    void saveOne(o);
    return;
  }
  focusRowIdx = idx + 1; // 没改动 ⇒ 什么都不消失，直接去下一行
  void applyFocus();
}

/** 取（并按需建立）一行的草稿 —— 行是主进程给的只读快照，编辑态单独放，避免和"刷新"打架 */
function draftOf(o: OrderRecord): Draft {
  const id = Number(o.id ?? 0);
  const cur = drafts[id];
  if (cur) return cur;
  const color = initialColor(o);
  const styleCode = String(o.styleCode ?? '');
  const d: Draft = {
    category: o.category ?? '',
    color,
    logo: o.logo ?? '',
    styleCode,
    baseColor: color,
    baseStyle: styleCode,
  };
  drafts[id] = d;
  return d;
}

/** 有改动才允许保存（"点保存但什么也没改"是噪音；也让脏值一眼看得出来） */
function isDirty(o: OrderRecord): boolean {
  const d = draftOf(o);
  // ⚠️ 比的是**载入时的初值**（`base*`）而不是行本身的字段：颜色格显示的可能是图片记住的颜色
  //    （`o.styleColor`），它与 `o.color` 不一定相同 ⇒ 拿行字段比会让每行一进来就是脏的。
  return d.color !== d.baseColor || d.styleCode !== d.baseStyle;
}

/** 品类/颜色相对**库里当前值**有没有变（决定要不要按指纹重归类；与上面那条"脏"判据不同义） */
function fieldsChanged(o: OrderRecord): boolean {
  const d = draftOf(o);
  return (
    d.category !== (o.category ?? '') ||
    d.color !== (o.color ?? '') ||
    d.logo !== (o.logo ?? '')
  );
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // 「发货台」的每日口径：本页只核对**今天导进来**的那批（与容器汇总、算钱页同一个筛）。
    // ⚠️ 三个取数**必须同一个 `day`**：分页那一份用今天、计数那一份用全库的话，
    //    页头「待核对 0 · 已核对 12」会与列表里的行对不上（最容易被读成"数据丢了"）。
    const day = localDayKey();
    // ⚠️ 分页那一份跟着 **`scope`** 换取数函数，另外两份（产品库 / 计数）**不跟着换** ——
    //    计数要的是"两个范围各有多少"（页头切换上就写着这两个数），换成按范围查会把另一个数抹成 0，
    //    于是切一次范围、另一个范围的行数就"消失"了。
    const pageOpts = { offset: page.value * PAGE_SIZE, limit: PAGE_SIZE, search: applied.value, importDate: day };
    const [pend, st, cnt] = await Promise.all([
      scope.value === 'corrected' ? listCorrected(pageOpts) : listPending(pageOpts),
      listStyleOptions(),
      pendingCounts({ importDate: day }),
    ]);
    // 门 1 与上面三个**并行**取（不 await 等它）：它只影响一条提示，
    // 让它参与 `loading` 会让"表格已经出来了、整页还在转圈"。
    void loadShopGate().then((g) => {
      shopGate.value = g;
    });
    rows.value = pend.rows;
    total.value = pend.total;
    if (total.value > 0 && page.value > totalPages.value - 1) {
      // 删除/确认后当前页可能超出范围 —— 回退一页重取，别停在空白页
      page.value = totalPages.value - 1;
      loading.value = false;
      await load();
      return;
    }
    styleOptions.value = st;
    // 「拆包 ×N」徽标：本页各行所属订单的包数（失败只影响徽标，不影响核对本身）
    void refreshParcelCounts();
    counts.pending = cnt.pending;
    counts.corrected = cnt.corrected;
    counts.unclassified = cnt.unclassified;
    usedColors.value = cnt.usedColors;
    // 草稿按行重建：主进程回来的才是真值，旧的编辑态一律作废
    for (const k of Object.keys(drafts)) delete drafts[Number(k)];
    for (const o of rows.value) draftOf(o);
    // 缩略图跟着**本页**走（失败不影响核对本身）
    await loadThumbs();
    // 款首图（行内「归属款」格子常显）—— 它只影响"看得见"，失败静默，不等它
    void loadStyleThumbs();
    // 勾选里那些已经不在本页的行（刚被保存/确认走了，或翻了页）要把 id 清掉 ——
    // 留着一个看不见的 id 会让"已选 3 行"与屏幕上能看见的 2 行对不上，而动作条上的数字
    // 是用户决定"要不要点那一下"的唯一依据。
    const liveIds = new Set(rows.value.map((o) => Number(o.id)));
    const keep = [...selectedIds.value].filter((id) => liveIds.has(id));
    if (keep.length !== selectedIds.value.size) selectedIds.value = new Set(keep);
    // 「保存并下一条」的落地：**必须在取数之后**——这一行已离开列表，后面的行整体上移一位，
    // 所以"下一条"就落在它原来的下标上（与 `applyFocus` 同一条理由）。
    if (nextAfterSave >= 0) {
      const i = nextAfterSave;
      nextAfterSave = -1;
      const nxt = rows.value[i] ?? rows.value[i - 1] ?? null;
      pickerRow.value = nxt;
      if (nxt) void loadStyleThumbs();
    } else if (pickerRow.value) {
      // 弹层开着的时候别处 bump 了：把行换成列表里的新对象 —— 否则弹层显示的是上一批快照
      // （单号/颜色/图都可能已经变了），而用户以为自己在看当前这一行。
      const curId = Number(pickerRow.value.id);
      pickerRow.value = rows.value.find((r) => Number(r.id) === curId) ?? null;
    }
    // 键盘流：保存后（或按回车往下走）把焦点送回目标行 —— 必须在**取数之后**做，
    // 否则元素还是上一批的老 DOM（保存会把那一行移走、后面的行整体上移）
    await applyFocus();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取待核对订单失败';
  } finally {
    loading.value = false;
  }
}

/**
 * 缩略图合批一次往返（路径去重；`orderImageThumbBatch` 内部已按上限拆批）。
 *
 * ⚠️ `maxEdge` 必须跟上展示尺寸：本页图格是 96px（见 `.cl-thumb`），
 * 旧值 96 在 cover 时代够糊弄，改成 contain 之后要的是"整图看得清" ⇒ 给 256（主进程上限）。
 * 表格只是"看得见是哪一款"，真要看清印花/领型走 `openImage` 读原图。
 */
async function loadThumbs(): Promise<void> {
  const paths = [...new Set(rows.value.map((o) => String(o.localPath ?? '')).filter(Boolean))];
  thumbs.value = {};
  if (!paths.length) return;
  const t = await ipc.orderImageThumbBatch(paths.map((localPath) => ({ localPath, maxEdge: 256 })));
  if (!t.success) return;
  paths.forEach((p, i) => {
    const url = t.data?.dataUrls?.[i];
    if (url) thumbs.value[p] = url;
  });
}

/**
 * 点开看**原图**（不缩放）。
 *
 * 为什么不复用 `orderImageThumbBatch`：那条通道的 `maxEdge` 在主进程被夹到 **256**（表格展示级），
 * 而认款要看清印花 / 领型 / 颜色，256 不够。`order-read-image` 走的是**同一套**目录白名单
 * （`order-images` + 扩展名 + realpath 归一），安全边界一致，只是不缩放。
 * 代价是整张原图（可至 MB 级）过 IPC ⇒ **只在用户点开某一张时调**，不随表格批量预取。
 *
 * 三步都是刻意的：先用缩略图把弹层开出来（点下去立刻有东西看，不等磁盘）→ 读原图换上 →
 * 读失败保留缩略图（不比现在更坏）。`viewerSeq` 保证连点只认最后一次。
 */
async function openImage(o: OrderRecord): Promise<void> {
  const localPath = String(o.localPath ?? '');
  if (!localPath) return;
  const seq = ++viewerSeq;
  viewer.value = { orderNo: o.orderNo, src: thumbs.value[localPath] || '', full: false };
  try {
    const big = await ipc.orderReadImage(localPath);
    if (seq !== viewerSeq) return; // 之后又点了别的行 → 这次的结果作废
    if (big.success && big.data?.dataUrl) {
      viewer.value = { orderNo: o.orderNo, src: big.data.dataUrl, full: true };
    }
  } catch {
    // 保留缩略图（弹层已经开着，用户至少看到原来那张）
  }
}

function doSearch(): void {
  applied.value = search.value.trim();
  page.value = 0;
  void load();
}

function gotoPage(p: number): void {
  page.value = p;
  void load();
}

function reload(): void {
  void load();
}

/**
 * ⭐ 回流结果的一句话（点名校时宿主会把「(店铺, 商品ID) → 款 + 色」记进确定性层，
 * 该商品**以后**的订单就自动归类、不再进本页）。
 *
 * 只对**用户需要知道**的三种情况说话：
 *   · `written`  —— 记住了（含"顺带把历史几单也归好了"）。不说这句，用户不会知道这条"省力"存在，
 *                  也就不会去"多判几次"——而这件事的价值恰恰来自重复发生；
 *   · `conflict` —— **没**覆盖既有映射。这是最需要说清的一支：不说的话用户会以为记住了，
 *                  下次看到"同商品还是旧款"会完全查不出原因；
 *   · `shopUnresolved` —— 店铺没归一，暂时记不住，并指出去哪解决（否则又是一次"点了没反应"）。
 * 其余（无商品ID / 产品库还没这个款 / 产品域未建）不打断：那几种情况下**本来就无处可记**，
 * 弹一句技术原因只会让人以为出错了。
 */
function backfillNote(bf?: SkuBackfillOutcome): string {
  switch (bf?.status) {
    case 'written': {
      const more = bf.reassigned > 0 ? `，同一商品另有 ${bf.reassigned} 单一起归好了` : '';
      return `；已记住这个商品 → ${bf.spec ? '款和颜色' : '款'}，以后它自动归类${more}`;
    }
    case 'conflict':
      // ⚠️ 入口名必须写**屏幕上真有的名字**。
      //    原先写的是「「货与成本」的映射清单」—— 全仓没有任何一处叫「映射清单」：
      //    「货与成本」只是模块名，页内那一段叫「已建立映射」（工作台右栏的分段控件），
      //    它在页签「款与商品」下（名字的唯一来源是 `src/modules/goods/tabs.ts`）。
      //    用户照字面去找，找不到。写成「货与成本 › 商品ID 映射」这种自造路径同样不行 ——
      //    `tests/uxEntryNames.spec.ts` 会把"去/在/到「X」"里的 X 拿去对真实入口名。
      return `；这个商品已配过映射（${bf.conflictCode || '其他款'}），没敢覆盖 ——`
        + `要改绑请到「基础数据 › 产品管理」的「款与商品」页签、右栏「已建立映射」里改`;
    case 'shopUnresolved':
      // ⚠️ 2026-10-08 R1 起「店铺登记」已**收进内建**（市场岛的「店铺账号管家」在默认包里没有，
      //    原文让用户去那个岛 = 指着一个装都没装的地方，这是那次走查抓到的 D1 死锁）。
      return '；这家店还没归一，暂时记不住这个商品（请先到「基础数据」的「店名归一」把这家店认下来）';
    default:
      return '';
  }
}

/**
 * 色名对照记下时的一句话。
 *
 * 为什么必须说：用户以为自己只是改了**这一行**的颜色，实际给了系统一条**通用规则**
 * （这一款的 `Khaki` 以后都算「卡其」）。不说的话，下次别的订单自动变成「卡其」
 * 会让人以为串了数据 —— 而这种"静默生效的规则"正是最难查的一类问题。
 */
function colorAliasNote(ca?: ColorAliasRemembered | null): string {
  if (!ca?.from || !ca?.to) return '';
  return `；已记住「${ca.from}」＝「${ca.to}」，这款以后自动用这个名字`;
}

/**
 * 保存一行。返回**是否真的写进去了**（批量与"保存并下一条"都要据此决定下一步，
 * 原来返回 `void`，调用方无从判断成败，只能乐观地继续 —— 那正是"弹层关了、行还在"的来源）。
 *
 * 参数：
 *   · `force`  —— 即使这一行看起来"没改动"也落库。判断依据是"用户点了保存"这件事本身：
 *                 弹层里重新选了同一个款/色，`isDirty` 是 false，但用户的意图是"这行我核过了"。
 *                 （行内那个「保存」按钮仍然是"改动才亮"，两处口径不同**是有意的**：
 *                 行内按钮是"有没有东西要写"，弹层是"我要把这一行定下来"。）
 *   · `silent` —— 不逐行弹 toast（批量时 30 行会刷屏）；结果由调用方汇总成一句。
 *   · `defer`  —— 不 `bump()`（批量时由调用方在最后统一重载**一次**）。
 */
async function saveOne(
  o: OrderRecord,
  opts: { force?: boolean; silent?: boolean; defer?: boolean } = {}
): Promise<boolean> {
  const d = draftOf(o);
  if (!opts.force && !isDirty(o)) return true;
  // 点名了款却没给颜色 ⇒ 拦住（宿主落库时颜色是款色的主键之一，空颜色会落出一个没有名字的款色）
  if (colorMissing(o)) {
    toast('先给这个款选一个颜色：颜色是「款 + 色」的一半，不选会落出一个没有名字的款色', 'info');
    return false;
  }
  // 给了颜色却没有款可挂 ⇒ 同样拦住。放它过去的话，宿主只会写订单自己的 color 列并把该行置为
  // 已核对，提示还说"已保存" —— 而拿货单 / 算钱 / 取图读的全是**款色**，用户要的事一件没发生。
  if (colorUnattached(o)) {
    toast('这个颜色落不到任何地方：先在上面的「归属款」里点名一个款，颜色才有地方挂', 'info');
    return false;
  }
  busy.value = true;
  try {
    const r = await saveCorrection({
      id: Number(o.id ?? 0),
      category: d.category,
      color: d.color,
      logo: d.logo,
      features: Array.isArray(o.features) ? o.features : [],
      targetStyle: d.styleCode,
      fieldsChanged: fieldsChanged(o),
    });
    if (!opts.silent) {
      const base = r.styleCode ? `已保存，归属 ${r.styleCode}` : '已保存（未归到款）';
      // 回流"没生效"时用 info 色调：归属是成功的，别让红/绿把两件事混成一件
      const tone =
        r.skuBackfill?.status === 'conflict' || r.skuBackfill?.status === 'shopUnresolved' ? 'info' : 'success';
      toast(base + backfillNote(r.skuBackfill) + colorAliasNote(r.colorAlias), tone);
    }
    if (!opts.defer) bump();
    return true;
  } catch (e: unknown) {
    if (!opts.silent) toast(e instanceof Error ? e.message : '保存失败', 'error');
    return false;
  } finally {
    busy.value = false;
  }
}

/**
 * 「确认无误」= 这行**不用改**，只置 `corrected = 1` 让它离开列表 —— **它不写任何字段**。
 *
 * ⚠️ 所以有未保存的改动时必须拦住：用户「选了颜色 / 改了归属款，然后点确认无误」是很自然的动作
 * （两个按钮就在同一格里），而这一下会把刚填的东西**静默丢掉** —— 行离开了列表，用户以为已经定了，
 * 结果拿货单上还是「未分类」。真库现场（2026-10-11）：23 行全部 `corrected=1` 而 `color` 全空、
 * 款色全是「未分类」，正是"填了没存、然后被确认掉了"留下的痕迹。
 */
async function confirmOne(o: OrderRecord): Promise<void> {
  if (isDirty(o)) {
    toast('这一行填了颜色或改了归属款还没保存 —— 先点「保存」，再点「确认无误」', 'info');
    return;
  }
  busy.value = true;
  try {
    const n = await markCorrected([Number(o.id ?? 0)]);
    if (n) toast('已确认无误', 'success');
    else toast('订单不存在或已核对', 'info');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

/**
 * 「确认这批全部无误」= 把**当前筛选下的所有待核对行**标记为已核对。
 *
 * ⚠️⚠️ 2026-10-28 修了一个**会误伤历史数据**的实现：原先走 `markCorrected({ all: true })`，
 *    宿主是 `UPDATE ... WHERE corrected = 0` —— **全库**、不带导入日、不带搜索词，
 *    而这一页只显示"今天这批"。于是：
 *      · 页面上 5 行、库里 300 行未核对 ⇒ 那 295 行（别的日子、甚至别的批次）一起被确认；
 *      · 还顺带把它们的克重/进价快照钉死（`snapshotOrderWeights/Costs`），事后无从判断
 *        当时是什么价。搜索状态下点它更危险：看得见的是 3 行，动的是全库。
 *    ⇒ 改成：先按**本页同一套筛**（导入日 + 搜索词）取全部 id，再点名标记。
 *      没有新 IPC（`orderList` + `orderMarkCorrected(ids)` 都是现成的），语义与页面表述一致了。
 *
 * ⚠️ 取数上限 2000（`orderList` 的天花板）：一天的行数量级远低于它，真撞上了要**说出来**
 *    （"超过 2000 行的部分没处理"），不能默默只做前 2000 行 —— 那是一次静默的部分成功。
 */
async function confirmAll(): Promise<void> {
  // 同一条守卫的批量版：本页**任何一行**有没保存的改动，都不许"全部确认"（那些改动会被丢掉，
  // 而且是一起丢，用户再也说不清哪几行是填过的）。
  const dirtyRows = rows.value.filter((o) => isDirty(o)).length;
  if (dirtyRows > 0) {
    toast(`有 ${dirtyRows} 行填了颜色或改了归属款还没保存 —— 先逐行点「保存」，再「全部确认无误」`, 'info');
    return;
  }
  busy.value = true;
  try {
    const all = await listPending({
      offset: 0,
      limit: 2000,
      search: applied.value,
      importDate: localDayKey(),
    });
    const ids = all.rows.map((o) => Number(o.id)).filter((n) => n > 0);
    if (!ids.length) {
      toast('当前筛选下没有待核对的行', 'info');
      return;
    }
    const n = await markCorrected(ids);
    const truncated = all.total > ids.length;
    toast(
      truncated
        ? `已确认 ${n} 行；还有 ${all.total - ids.length} 行超出单次上限没有处理 —— 先用搜索缩小范围再确认`
        : `已确认 ${n} 行（${applied.value ? '当前搜索结果里的全部' : '今天这批里的全部'}）`,
      truncated ? 'info' : 'success'
    );
    selectedIds.value = new Set();
    page.value = 0;
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

/**
 * 「退回待核对」= 把这一行从已核对放回待核对列表（`corrected = 0`），供人重做。
 *
 * 为什么必须存在：`markCorrected` / `updateOrder` 都是**单向**的（置 1 即离开本页），
 * 而"核对过之后发现定错了款/色"是必然会发生的 —— 没有这一步，那些行就再也回不到这一页
 * （用户报的"做完归类核对后订单不知道在哪"里就有这一支：它们既不在待核对里，也没有别处列出来）。
 *
 * ⚠️ 只发 id（不连字段一起发）：退回**不重写**上一轮核对留下的款/色/logo ——
 *    连字段发过去等于拿"退回那一刻界面上的草稿"覆盖那次的结论，而草稿可能正是用户想改掉的东西。
 * ⚠️ 退回后**留在已核对范围**（不自动跳回待核对）：用户多半要连着退好几行，
 *    每退一行就把人甩到另一个范围，等于让"退第 2 行"从头找一遍。
 *    行数在页头那个切换上就写着（退一行少一个，不用切过去确认）；要接着改就点页头切回去。
 * ⚠️ 不弹确认框：这不删数据、也不改字段（只翻一个状态位），而且**再点一次「确认无误」就能回去** ——
 *    给一个可逆的动作加确认框，只会让人对下一个真危险的确认也麻木。
 */
async function reopenOne(o: OrderRecord): Promise<void> {
  busy.value = true;
  try {
    const n = await reopenCorrected([Number(o.id ?? 0)]);
    if (n) toast('已退回待核对 —— 回到待核对列表后可以重新定款和颜色', 'success');
    else toast('这一行在库里已经不存在了，退回没有生效', 'info');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '退回失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ~~批量识别（`cl-recognize` / `cl-stop` / 进度条 `cl-progress`）~~
// **已删（2026-10-05，用户要求）** —— 原因见 script 头注释的三条（慢 / 只跑当前页 / 直接落库）。
// 原实现留档在 git 历史（该提交同时删掉 `readEngine` / `recognizeOrder` 在本页的调用）。
// ⚠️ 重新加回来时必须同步 `scripts/today-ui-smoke.mjs` 的 `classify` 段 —— 那里现在有一条
//    **反向断言**「工具条不再有识别按钮」，加了按钮它会红，那是设计如此（逼你确认是"要加回来"）。

/**
 * 进页时**先自愈、再取数**：把「映射已确认、订单却没吃到」的行按映射补上。
 *
 * 为什么不给按钮：这是把**已被确认的事实**重新套一遍（确定性推导），唯一不确定的只是
 * "有没有漏"，而那正是这一步算出来的。让人点一下，只是把"系统该自愈"变成"人记得点"。
 * 详见 `docs/notes/2026-10-20-replay-mappings-on-load.md` 与 MEMORY 的「人工介入最少」原则。
 *
 * 只在**挂载 / 外部数据变更（`token`）**时跑；翻页、搜索不跑 —— 那些不改变"有没有漏网"，
 * 而重放要扫一遍能补的行（订单量级大时不是零成本）。
 *
 * ⚠️ 这里**不调 `bump()`**：`bump` 会改 `token`，而 `token` 的 watch 又调本函数 ——
 *    第一轮补到东西就会自我触发。汇总数由本页 `load()` 里的 `pendingCounts` 重取，
 *    容器那一层的统计下次进模块会自己重算，不值得为它引入递归。
 */
async function bootstrap(): Promise<void> {
  const r = await ipc.orderReplayMappings();
  healed.value = r.success ? Number(r.data?.fixedRows ?? 0) || 0 : 0;
  await load();
}

onMounted(() => void bootstrap());
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了订单）就重取本页。
// ⚠️ 这里**只 load、不再自愈**：`token` 在本页保存一行、翻一页都会变（本页自己也在 `bump()`），
//    跟着它重放 = 每动一下就把全表扫一遍（冒烟实测过：一次进页被触发 21 次）。
//    而"刚导进来的订单"落库那一刻已经走过 `autoAssignByMap`，恰恰不需要重放；
//    重放治的是**历史漏网**，进页一次就够。
watch(
  () => token.value,
  () => void load()
);
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.cl-view {
  gap: 12px;
}
.cl-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.cl-search {
  width: 300px;
  max-width: 40vw;
}
/* 门 1（店铺归一）那条提示：一句话 + 两个按钮，展开后才是清单。
   ⚠️ 必须 flex-wrap：窄窗口下"店名 + 行数 + 能认成什么"会很长，不换行会把按钮顶出去。 */
.cl-gate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  color: var(--wb-text);
}
.cl-gate__t {
  font-size: 13px;
}
.cl-gate__why {
  flex: 1 1 220px;
  min-width: 0;
  font-size: 12px;
}
.cl-gate__list {
  flex-basis: 100%;
  margin: 0;
  padding: 0 0 0 2px;
  list-style: none;
  font-size: 12px;
  line-height: 1.8;
  max-height: 132px;
  overflow: auto;
}
/* 面板头右侧动作区（`.wb-panel__head` 是 flex，无"推右"工具类） */
.cl-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}
/* 范围切换（`.wb-seg` 本体样式在 src/styles/index.css，这里只收口本页的间距）。
   它夹在标题与说明之间，跟着标题走、不跟 `.cl-actions` 一起被推到右边 —— 计数属于标题区。 */
.cl-scope {
  margin-left: -2px;
}
/* 自愈回执：放在范围控件左边，用成功色 —— 它说的是"刚刚发生了什么"，
   不是常驻说明；补 0 行时整块不渲染（`v-if`），所以不会长期占位。 */
.cl-healed {
  font-size: 12px;
  color: var(--wb-success, #15803d);
  white-space: nowrap;
}
/* 已核对范围里款/色两格的**只读文本**。刻意与可编辑那两支长得不同：
   输入框/下拉有边框、只读文本没有 —— 一眼能看出"这里现在动不了"。
   ⚠️ 别用 `cursor` 或灰色来区分：那两样都只是"看着不太一样"，而"能不能点"是个结构事实。 */
.cl-ro {
  font-size: 13px;
}
.cl-table {
  width: 100%;
}
/* ── 勾选列（2026-10-28 批量）─────────────────────────────────────────────
   30px 够点、又不抢图列的位置。⚠️ 它成了表首列 ⇒ `.wb-table-wrap` 那条
   `th:first-child / td:first-child { position: sticky }` 现在钉的是它（勾选框跟着横向滚不动，
   图列会滚走）。这是可接受的取舍：只在很窄的窗口才横滚，而横滚时"勾选"比"图"更需要固定在眼前
   （图有 `cl-zoom-*` 可以点开看原图）。 */
.cl-sel-col {
  width: 30px;
  min-width: 30px;
  padding-left: 8px;
  padding-right: 2px;
  text-align: center;
}
.cl-sel {
  width: 14px;
  height: 14px;
  cursor: pointer;
}
/* 勾中的行整行提亮：动作条上的"N 行"必须能在表里数出来（数字与看得见的行要一致）。
   ⚠️ 只靠浅底不够：`--wb-primary-soft` 是 #eff1f4，与行底色 #fff 差得很小（截图实测
   在两个主题下都数不出来）⇒ 再给勾选列一道左侧竖条。判据是"能不能一眼数清"，不是"有没有底色"。 */
.cl-table tbody tr.is-selected td {
  background: var(--wb-primary-soft);
}
.cl-table tbody tr.is-selected td.cl-sel-col {
  box-shadow: inset 3px 0 0 var(--wb-primary);
}
/* ── 吸底批量动作条 ─────────────────────────────────────────────────────
   `sticky` 而不是 `fixed`：它属于这个面板（换页签要跟着走），且宽度由面板决定 ——
   fixed 会横跨整窗、盖到侧栏上。外层面板若自身滚动，它照样贴在可视区底部。 */
.cl-bulk {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--wb-primary);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.08);
}
.cl-bulk__count {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.cl-bulk__hint {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cl-bulk__spacer {
  flex: 1;
}
.cl-cell {
  width: 100%;
  min-width: 76px;
}
.cl-thumb-col {
  width: 112px;
  /* ⭐ 2026-10-12 补的**地板**：这一列不许被压扁。
     为什么需要它：`.wb-table` 是 `table-layout: auto`，列宽由"各列首选宽之和 vs 表格可用宽"
     决定；差多少就从**每列抠**。已核对范围各列都是窄文本（只读格），首选宽之和很容易超过
     可用宽 ⇒ 图列从 112px 被抠到 32px，而基座 `img { max-width: 100% }` 随即使图变成
     12px 的细条 —— 用户看到的正是"图片展示不全 / 这一页看着是坏的"。
     待核对范围只是**侥幸**逃过：下拉框把整表撑宽，差额摊到了别的列上。
     ⚠️ 光靠图片自己的固有尺寸兜不住：缩略图很小（主进程 maxEdge 256，冒烟夹具 8×8）时，
        min-content 只有几十 px，列该塌还是塌。地板必须由 CSS 给，不能靠图片有多大。
     代价：窄窗口下整表会比容器宽一点 ⇒ 横向滚动（`.wb-table-wrap` 本来就为这个准备着，
        且首列 sticky —— 与待核对范围在同一窄窗口下的行为一致，不是新引入的）。 */
  min-width: 112px;
}
/* 核对用的是**整张图**，不是裁出来的中心块：
   基座 `.wb-thumb` 是 40px + `object-fit: cover`（商品照多是竖版，上下两端正是"款长什么样"
   的关键部位）。本页放大到 96px 并改成 `contain` —— 宁可留点空白，也不要把图裁掉。
   直接命中优先于继承：`.cl-table` 是本组件的元素，选择器能在 scoped 下命中子层的 `.wb-thumb`。
   ⚠️ 96 是 2026-10-12 用户**第二次**报"图片展示不全"后从 64 提上来的：图从来不缺角
      （主进程等比缩放 + contain），缺的是**尺寸** —— 64px 看不清印花/领型/颜色。
      再往上提就得不偿失：图列每 +32px，颜色/归属款两列就要让出空间（表格总宽固定），
      而"要看细节"有 `cl-zoom-*` 那条路（读原图），不必把表格撑胖。 */
.cl-table .wb-thumb {
  width: 96px;
  height: 96px;
  object-fit: contain;
}
/* 「点开看大图」：整格是一个按钮（不是只在图右上角一个小角标）——
   要认的是"这一款"，点哪里都算点它。⤢ 角标**常显**：写在 title 里的话，
   触屏 / 不会悬停的人永远不知道这张图能点开（同 `PoolPane` 2026-10-10 P2-1 的教训）。 */
.cl-thumb-btn {
  position: relative;
  display: block;
  /* 尺寸写死在按钮上（而不是只写在 img 上）：按钮是格子里那个**块**，它的宽度就是本列
     min-content 的来源。只给 img 设宽时，`img { max-width: 100% }` 会让 Chrome 按图片
     **固有尺寸**算这一列的下限（缩略图固有尺寸很小 ⇒ 列照样塌）—— 2026-10-12 实测踩到。 */
  width: 96px;
  height: 96px;
  padding: 0;
  border: 0;
  background: none;
  line-height: 0;
  cursor: zoom-in;
}
.cl-thumb-btn__zoom {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 3px;
  border-radius: var(--wb-radius-sm);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 14px;
}
/* 看大图弹层：原图可至 MB 级 / 4096px，故给一个上限并允许内部滚动 */
.cl-viewer {
  max-width: min(78vw, 900px);
}
.cl-viewer__tag {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}
.cl-viewer__body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  max-height: 72vh;
  overflow: auto;
}
.cl-viewer__img {
  max-width: 100%;
  object-fit: contain;
}
/* 「同商品」徽标紧跟在单号后面：它是**这一行的属性**，不是独立一列
   （独立成列会让"没有商品ID"的行留一个大空格，看着像缺数据）。
   ⚠️ 2026-10-28 起它是**按钮**（点一下 = 勾选本页这个商品的所有行）⇒ 必须清掉 button 的
   默认边框/字体/底色，否则与 `.wb-tag` 的样式叠成"两个控件压在一起"。 */
.cl-same {
  margin-left: 6px;
  border: 0;
  font: inherit;
  cursor: pointer;
}
.cl-color-col {
  min-width: 110px;
}
.cl-style-col {
  /* 200 → 232：格子里多了一枚 36px 的款首图（2026-10-28 换掉原生下拉）。
     宽度不够时名字会被截断成"看不清是哪款"，而名字正是图之外的第二判据。 */
  min-width: 232px;
}

/* ── 归属款格子（2026-10-28）：带款首图的按钮，取代原生下拉 ──────────────────
   视觉上要像"一个可点的框"而不是链接：它有边框、有内边距，与同行的颜色下拉同一高度，
   扫一眼就知道"这一格是个控件"。`is-auto`（没点名款）时文字走灰，与"已定款"区分开。 */
.cl-style-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  /* 高度两档必须一致：有款（36px 图 + 上下 padding = 44）与没点名款（只有一行文字）。
     不写死的话，未归类那行的框会比有图的**矮一截** —— 同一列两种高度，看着像没做完。 */
  min-height: 44px;
  padding: 3px 6px 3px 3px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.cl-style-btn:hover {
  border-color: var(--wb-primary);
}
.cl-style-btn__img {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--wb-radius-sm);
  object-fit: contain;
  background: var(--wb-surface-2);
}
.cl-style-btn__img--empty {
  display: block;
  border: 1px dashed var(--wb-border);
}
.cl-style-btn__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
  line-height: 1.25;
}
.cl-style-btn__name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cl-style-btn__auto {
  color: var(--wb-text-muted, var(--wb-muted, #888));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 右侧「选」：常显（不是悬停才出现）—— 触屏 / 不会悬停的人也要知道这一格能点 */
.cl-style-btn__go {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--wb-text-muted, var(--wb-muted, #888));
}
/* 「点了款但还没选颜色」的行内原因：它挡的是「保存」按钮，不说清就是一次"按不下去" */
.cl-warn {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--wb-warning);
}
/* 操作列：两个文字动作**必须排一行**。
   ⚠️ 原来是 `flex-wrap: wrap`，于是「保存 / 确认无误」在 170px 的列里折成两行 ——
   每行被撑高约 20px，5 行就是 100px，而**行高是被一个排版细节决定的**，与内容无关。
   用户 2026-10-12 报"行高被撑高"就是它。改成 nowrap：这一列的内容是两个 13px 文字链接
   （合计 ≈120px），170px 放得下；放不下的情况由 `.wb-table-wrap` 的横向滚动兜底
   （该列会跟着表格一起滚，不会被裁掉——裁切是静默的，滚动才是可发现的）。 */
.cl-ops {
  display: flex;
  flex-wrap: nowrap;
  gap: 10px;
  white-space: nowrap;
}
</style>
