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
             一句话盖两边必然有一边是错的（"点保存"在已核对里根本没有那个按钮）。 -->
        <span class="wb-muted" data-act="cl-guide">
          {{
            scope === 'pending'
              ? '先点名「归属款」，再选这个款的颜色，点「保存」；没问题就点「确认无误」。回车＝保存并跳下一条'
              : '这些是核对过的行。要改哪一行，点「退回待核对」把它放回待核对列表，改好再保存'
          }}
        </span>
        <!-- 「全部确认无误」只在待核对范围有意义：对已核对的行再确认一次是**空动作**
             （那些行本来 corrected 就是 1）。留在那里会让用户以为它能做别的什么。 -->
        <span v-if="scope === 'pending'" class="cl-actions">
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="cl-all-ok"
            :disabled="busy || !total"
            @click="confirmAll"
          >
            全部确认无误
          </button>
        </span>
      </div>

      <div v-if="rows.length" class="wb-panel__body wb-table-wrap">
        <table class="wb-table cl-table" data-act="cl-table">
          <thead>
            <tr>
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
            <tr v-for="o in rows" :key="o.id" @keydown.enter="onRowEnter(o, $event)">
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
                        那是一个**要做的动作**；已核对范围里没有可点名的下拉，留着它就成了空承诺。 -->
                <span
                  v-if="scope === 'pending' && sameCount(o) > 1"
                  class="wb-tag cl-same"
                  :data-act="`cl-same-${o.id}`"
                  :title="`本页有 ${sameCount(o)} 行是这家店的同一个商品。给其中任意一行点名款，其余行以后会自动归类`"
                >
                  同商品 ×{{ sameCount(o) }}
                </span>
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
                  <select
                    v-if="styleOptions.length"
                    v-model="draftOf(o).styleCode"
                    class="wb-input wb-input--sm cl-cell"
                    :data-act="`cl-style-${o.id}`"
                    @change="onStylePick(o)"
                  >
                    <option value="">
                      自动匹配{{ o.styleCode ? `（当前 ${o.styleCode}）` : '（未归类）' }}
                    </option>
                    <option v-for="s in styleOptions" :key="s.code" :value="s.code">
                      {{ s.code }}{{ s.name ? ` · ${s.name}` : '' }}{{ s.status === 'archived' ? '（停用）' : '' }}
                    </option>
                  </select>
                  <span v-else class="wb-muted">产品库为空 —— 先到「货与成本」建档</span>
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
               · 这批核对完了 → **去算钱 / 去看要拿什么**（流程的第 3、4 步）——
                 原先这里什么都没有，用户核对完就"断"在这一页上。
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
              @click="go('cost')"
            >
              去算钱
            </button>
            <button
              type="button"
              class="wb-btn"
              data-act="cl-goto-purchase"
              @click="go('purchase')"
            >
              去看要拿什么
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
//   ⚠️ 连带：识别原语（`readEngine` / `recognizeOrder`）仍保留在 `../classify.ts`，**当前无调用方**
//   —— 留着是因为「设置 › 识别」写的那份引擎配置必须有个读取方，且它们正是重新接入识别时要用的现成件。
//   若最终决定不做自动识别，**两者与「设置 › 识别」页应一并删除**（别让它们烂在那里）。
//
// ⚠️ **2026-10-12 加「已核对」范围 + 行内「退回待核对」**（与用户确认过的口径）。要治的是：
//   核对过之后发现定错了款/色 —— 那些行按定义不在待核对列表里（本页只查 `corrected = 0`），
//   于是**屏幕上根本没有它们**，也就没有任何地方能改回去。真库现场：23 行全 `corrected=1`、
//   `oi_orders.color` 全空、款色全是「未分类」（"填了没存、然后被确认掉了"留下的痕迹），
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
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import { localDayKey } from '@/lib/localDay';
import type { OrderRecord, SkuBackfillOutcome, StyleRecord } from '@/types';
import { useShipping } from '../flowCtx';
import {
  PAGE_SIZE,
  listCorrected,
  listPending,
  listStyleOptions,
  markCorrected,
  pendingCounts,
  reopenCorrected,
  saveCorrection,
} from '../classify';

const { token, go, bump } = useShipping();

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
/** 归属款下拉的数据源：**产品库全集**（不是识别池 —— 见 script 头注释 ④） */
const styleOptions = ref<StyleRecord[]>([]);
const counts = reactive({ pending: 0, corrected: 0, unclassified: 0 });
const thumbs = ref<Record<string, string>>({});
/** 「看大图」弹层：先用手里那张缩略图开出来，再换原图（见模板里弹层的长注释） */
const viewer = ref<{ orderNo: string; src: string; full: boolean } | null>(null);
/** 连点只认最后一次：晚到的原图不许盖到用户后来点的那一行上 */
let viewerSeq = 0;
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
  return `这 ${counts.corrected} 行都点过「保存」或「确认无误」了 —— 接着去第 3 步算钱，或直接看第 4 步要拿什么。`;
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
 * 这一支**只在用户手点下拉时触发**（`@change`），不在载入时触发 —— 载入的取值口径在
 * `initialColor` 里，两处都做的话"清空"会跟"记住的颜色"打架（先选中再被清掉，症状是
 * "明明记住了却永远要重选"）。在色卡里的就保留：那多半正是图片记住的那个颜色（省一次点击）。
 */
function onStylePick(o: OrderRecord): void {
  const d = draftOf(o);
  const palette = colorsFor(d.styleCode);
  if (palette.length && !palette.includes(d.color.trim())) d.color = '';
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
 * `oi_orders.color` 并把该行置为已核对，界面上一切正常、`toast` 还说"已保存"，而用户要的那件事
 * 一件都没发生（2026-10-11 用户报的就是这一类"设了颜色却不生效"）。
 * 与 `colorMissing`（有款没色）是一对：**款与色是「款 + 色」的两半，缺哪一半都不该放行**。
 */
function colorUnattached(o: OrderRecord): boolean {
  const d = draftOf(o);
  return d.color.trim() !== '' && !canAttachColor(o);
}

// ───────────────────────────────────────── 「同商品」分组（这一页真正要做多少决定）

/**
 * 分组键 = **店铺原文 + 商品ID**。商品ID 由主进程给（`OrderRecord.itemId`），渲染层不自己推 ——
 * 它与回流写映射时用的是同一个 `extractSkuFields`，推两遍就会出现"徽标说同商品、回流按另一个键记"。
 *
 * ⚠️ 已知的**欠算**：这里用的是店铺**原文**，而回流用的是归一后的店铺实体。同一家店在报表里
 * 写法不同（多一个空格/全角括号）时，这里会当成两个商品（徽标少算）。刻意不修：要修就得把
 * 店铺归一下沉到渲染层（那是 `sk_name_map` 的事，两处各判一次必分叉）。徽标是**提示**不是承诺，
 * 少算只会让人多核对一次，不会把两件商品混成一件。
 */
function productKey(o: OrderRecord): string {
  const itemId = String(o.itemId ?? '').trim();
  if (!itemId) return '';
  return `${String(o.shop ?? '').trim()}\u0000${itemId}`;
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
    counts.pending = cnt.pending;
    counts.corrected = cnt.corrected;
    counts.unclassified = cnt.unclassified;
    usedColors.value = cnt.usedColors;
    // 草稿按行重建：主进程回来的才是真值，旧的编辑态一律作废
    for (const k of Object.keys(drafts)) delete drafts[Number(k)];
    for (const o of rows.value) draftOf(o);
    // 缩略图跟着**本页**走（失败不影响核对本身）
    await loadThumbs();
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
      //    它在页签「建档与关联」下（名字的唯一来源是 `src/modules/goods/tabs.ts`）。
      //    用户照字面去找，找不到。写成「货与成本 › 商品ID 映射」这种自造路径同样不行 ——
      //    `tests/uxEntryNames.spec.ts` 会把"去/在/到「X」"里的 X 拿去对真实入口名。
      return `；这个商品已配过映射（${bf.conflictCode || '其他款'}），没敢覆盖 ——`
        + `要改绑请到「货与成本」的「建档与关联」页签、右栏「已建立映射」里改`;
    case 'shopUnresolved':
      // ⚠️ 2026-10-08 R1 起「店铺登记」已**收进内建**（市场岛的「店铺账号管家」在默认包里没有，
      //    原文让用户去那个岛 = 指着一个装都没装的地方，这是那次走查抓到的 D1 死锁）。
      return '；这家店还没归一，暂时记不住这个商品（请先到「货与成本」的「店铺登记」页签，把这家店认下来）';
    default:
      return '';
  }
}

async function saveOne(o: OrderRecord): Promise<void> {
  const d = draftOf(o);
  if (!isDirty(o)) return;
  // 点名了款却没给颜色 ⇒ 拦住（宿主落库时颜色是款色的主键之一，空颜色会落出一个没有名字的款色）
  if (colorMissing(o)) {
    toast('先给这个款选一个颜色：颜色是「款 + 色」的一半，不选会落出一个没有名字的款色', 'info');
    return;
  }
  // 给了颜色却没有款可挂 ⇒ 同样拦住。放它过去的话，宿主只会写订单自己的 color 列并把该行置为
  // 已核对，提示还说"已保存" —— 而拿货单 / 算钱 / 取图读的全是**款色**，用户要的事一件没发生。
  if (colorUnattached(o)) {
    toast('这个颜色落不到任何地方：先在上面的「归属款」里点名一个款，颜色才有地方挂', 'info');
    return;
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
    const base = r.styleCode ? `已保存，归属 ${r.styleCode}` : '已保存（未归到款）';
    // 回流"没生效"时用 info 色调：归属是成功的，别让红/绿把两件事混成一件
    const tone = r.skuBackfill?.status === 'conflict' || r.skuBackfill?.status === 'shopUnresolved' ? 'info' : 'success';
    toast(base + backfillNote(r.skuBackfill), tone);
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '保存失败', 'error');
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
    const n = await markCorrected({ all: true });
    toast(`已把 ${n} 条订单标记为已核对`, 'success');
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

onMounted(() => void load());
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了订单）就重取本页
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
/* 已核对范围里款/色两格的**只读文本**。刻意与可编辑那两支长得不同：
   输入框/下拉有边框、只读文本没有 —— 一眼能看出"这里现在动不了"。
   ⚠️ 别用 `cursor` 或灰色来区分：那两样都只是"看着不太一样"，而"能不能点"是个结构事实。 */
.cl-ro {
  font-size: 13px;
}
.cl-table {
  width: 100%;
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
   （独立成列会让"没有商品ID"的行留一个大空格，看着像缺数据） */
.cl-same {
  margin-left: 6px;
}
.cl-color-col {
  min-width: 110px;
}
.cl-style-col {
  min-width: 200px;
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
