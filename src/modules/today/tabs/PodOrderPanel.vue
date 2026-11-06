<template>
  <div class="wb-page po-view" data-act="pod-order-panel">
    <!-- ══ ① 口径条：五个数 + 每张几件 + 四个动作 ══════════════════════════════
         数字与「按款认图案」是**同一份输入**（candidates + 三个绑定索引），所以认完颜色
         这里立刻变 —— 用户不用来回切页签核对。 -->
    <section class="wb-panel po-top">
      <header class="wb-panel__head">
        <span>今天要订的花纸</span>
        <span class="wb-muted">要发货的件数 − 手上还剩的花纸 = 这次要补的件数</span>
      </header>

      <div class="po-top__row">
        <div class="po-nums" data-act="summary">
          <span
            >要发货 <b>{{ report.waitingPieces }}</b></span
          >
          <span
            >已认图案 <b>{{ report.boundPieces }}</b></span
          >
          <span :class="{ 'is-danger': report.unboundPieces > 0 }">
            还没认图案 <b>{{ report.unboundPieces }}</b>
          </span>
          <span
            >这次要补 <b>{{ report.shortPieces }}</b></span
          >
          <span
            >要订几张 <b>{{ report.totalSheets }}</b></span
          >
        </div>
        <label class="wb-field po-per">
          <span class="wb-field__label">每张花纸印几件</span>
          <input
            v-model="perInput"
            class="wb-input wb-input--sm"
            inputmode="numeric"
            data-act="per-sheet"
            @change="applyPer"
          />
        </label>
      </div>

      <!-- 动作分层（2026-11-05）：这一排原来 5 个按钮同为描边、且「重新算」排最左抢视线。
           实际每天要点的只有**第一个**（复制清单图发花纸厂），其余是低频或补救动作：
             · 主 = 复制清单图片（实心）
             · 次 = 复制文字清单 / 导出 zip（描边）
             · 补救 = 合并图案 / 重新算（ghost，放最右）
           顺序按"一天里点的概率"排，不按功能分类。 -->
      <div class="po-acts">
        <button
          class="wb-btn wb-btn--primary"
          data-act="copy-image"
          :disabled="!report.rows.length || loading || copying"
          @click="copyImage"
        >
          {{ copying ? '正在生成…' : '复制清单图片（图 + 张数）' }}
        </button>
        <button
          class="wb-btn"
          data-act="copy-text"
          :disabled="!report.rows.length || loading"
          @click="copyText"
        >
          复制文字清单
        </button>
        <button
          class="wb-btn"
          data-act="export"
          :disabled="!report.rows.length || loading"
          @click="exportZip"
        >
          导出清单 zip
        </button>
        <button
          class="wb-btn wb-btn--ghost"
          data-act="open-merge"
          :disabled="patterns.length < 2"
          title="两个图案其实是同一朵花时，合并后按一张订"
          @click="openMerge"
        >
          合并图案
        </button>
        <button
          class="wb-btn wb-btn--ghost"
          data-act="reload"
          :disabled="loading"
          title="重新读订单与库存再算一遍（改了数据才需要）"
          @click="load()"
        >
          重新算
        </button>
      </div>

      <!-- 可信度：还没认图案 > 0 时这份清单**必然偏少**，必须写在按钮旁边 -->
      <p class="po-trust" :class="`is-${trust.tone}`" data-act="trust">
        {{ trust.text }}
        <button
          v-if="report.unboundPieces > 0"
          class="wb-btn po-trust__cta"
          data-act="go-patterns"
          @click="focusStyles"
        >
          去认图案
        </button>
      </p>
      <p v-if="truncated > 0" class="po-trunc" data-act="truncated">
        订单行超过上限，本次只取了 {{ candidatesCount }} / {{ candidatesCount + truncated }} 行 ——
        清单可能偏少
      </p>
      <p v-if="receipt" class="wb-notice po-receipt" data-act="receipt">{{ receipt }}</p>
      <p v-if="error" class="wb-notice wb-notice--error po-receipt" data-act="error">
        {{ error }}
        <button class="wb-link" type="button" @click="load()">重试</button>
      </p>
    </section>

    <!-- ══ ② 主体：左「按款认图案」 / 右「这次要订的图案」 ══════════════════════
         左边是**填数据**（一次一个款），右边是**出清单**。两栏并排是为了让"认完立刻看到
         要订几张"发生在同一屏 —— 分成两页时，用户认完就离开发货动线了。 -->
    <div class="po-body">
      <!-- ── 左：按款认图案 ─────────────────────────────────────────────── -->
      <section ref="stylesEl" class="wb-panel po-styles" data-act="pod-styles">
        <header class="wb-panel__head">
          <span>
            ① 按款认图案
            <span class="po-head-sub" data-act="style-stats">
              {{ styleTotals.groups }} 个款 · 还有
              <b :class="{ 'is-danger': styleTotals.unboundGroups > 0 }">{{
                styleTotals.unboundGroups
              }}</b>
              个款没认全 · {{ podStylesHint }}
            </span>
          </span>
          <span class="po-styles__acts">
            <input
              v-model="search"
              class="wb-input wb-input--sm po-search"
              type="search"
              placeholder="搜款号 / 色名 / 店铺 / 商品ID"
              data-act="style-search"
            />
            <label class="po-onlywait" data-act="only-unbound">
              <input v-model="onlyUnbound" type="checkbox" />
              只看没认的
            </label>
            <!-- 说明收进问号：这页的正文是款卡片，常驻两段说明会把卡片挤下去（2026-11-03） -->
            <button
              type="button"
              class="po-help-btn"
              data-act="pod-help"
              aria-haspopup="dialog"
              :aria-expanded="helpOpen"
              title="怎么认 / 快捷键 / 放大看图"
              aria-label="这一页怎么用"
              @click="helpOpen = true"
            >
              ?
            </button>
          </span>
        </header>

        <div v-if="loading && !styleGroups.length" class="wb-muted po-pad">正在读取…</div>

        <div v-else-if="!styleGroups.length" class="wb-empty po-pad" data-act="styles-empty">
          <template v-if="styleTotals.pieces <= 0">
            <p class="wb-empty__title">现在没有「等我发货」的订单</p>
            <p class="wb-empty__desc">
              没有订单就没有要印的料 —— 先去「订单」把单弄进来（芒果采集为主）。
            </p>
          </template>
          <template v-else>
            <p class="wb-empty__title">要发的颜色都认好图案了</p>
            <p class="wb-empty__desc">
              这一批 {{ styleTotals.pieces }} 件都能算出该印哪朵花 ——
              下面的清单就是这次要订的花纸。以后同款进来会自动带出图案，不用再认。
            </p>
          </template>
        </div>

        <div v-else class="po-cards" data-act="style-cards">
          <article
            v-for="(g, i) in styleGroups"
            :key="g.key"
            class="po-style"
            :class="{
              'is-unclassified': g.unclassified,
              'has-unbound': g.unboundPieces > 0,
              'is-active': selStyleKey === g.key,
            }"
            :data-act="`style-${i}`"
          >
            <header class="po-style__head">
              <span class="po-style__thumb">
                <img v-if="groupImageOf(g)" :src="groupImageOf(g)!" alt="" />
                <span v-else class="po-ph">无图</span>
              </span>
              <span class="po-style__title">
                <span class="po-style__code">
                  {{ g.styleCode }}
                  <span v-if="g.unclassified" class="wb-tag is-warn" data-act="unclassified-tag">
                    还没归类
                  </span>
                </span>
                <span class="po-style__meta">
                  {{ g.colors.length }} 色 · 要发 {{ g.pieces }} 件
                  <template v-if="g.unboundPieces > 0">
                    · <b class="is-danger">{{ g.unboundPieces }} 件没认</b>
                  </template>
                  <template v-else>· 都认好了</template>
                </span>
                <span class="po-style__pats">
                  {{
                    g.patternIds.length
                      ? `图案 ${g.patternIds.map((id) => codeOf(id)).join(' / ')}`
                      : '还没认图案'
                  }}
                </span>
              </span>
            </header>

            <!-- 颜色 chip：一张 = 一个款色（多行订单合成一张，件数已求和） -->
            <div class="po-colors">
              <!-- 放大按钮必须是 chip 的**兄弟**而不是子元素：`<button>` 里不能再嵌 `<button>`，
                   嵌了以后按空格会同时触发"选中"和"放大"，而且读屏软件读不出来。 -->
              <div v-for="(c, ci) in g.colors" :key="c.key" class="po-chip-wrap">
                <button
                  type="button"
                  class="po-chip"
                  :class="{
                    'is-sel': isSelected(g, c),
                    'is-bound': c.patternId > 0,
                    'is-unbound': c.patternId <= 0,
                    'is-conflict': c.conflict,
                  }"
                  :title="chipTitle(c)"
                  :data-act="`color-${i}-${ci}`"
                  @click="toggleColor(g, c)"
                >
                  <span class="po-chip__thumb">
                    <img v-if="thumbOf(c.imagePath)" :src="thumbOf(c.imagePath)!" alt="" />
                    <span v-else class="po-ph">{{ c.imageUrl ? '图没下' : '无图' }}</span>
                  </span>
                  <span class="po-chip__meta">
                    <span class="po-chip__name">{{ c.color }}</span>
                    <span class="po-chip__qty">{{ c.pieces }} 件</span>
                  </span>
                  <span class="po-chip__pat">
                    <template v-if="c.patternId">{{ codeOf(c.patternId) }}</template>
                    <template v-else>未认</template>
                    <span v-if="c.conflict" class="po-chip__warn">认得不一样</span>
                  </span>
                </button>
                <!-- 看一眼不能顺手把色选上：`@click.stop` + 独立按钮，选择状态一个字节都不动 -->
                <button
                  v-if="c.imagePath"
                  type="button"
                  class="po-chip__zoom"
                  :data-act="`zoom-${i}-${ci}`"
                  :title="`放大看 ${c.color} 的图（Z）`"
                  :aria-label="`放大看 ${g.styleCode} ${c.color} 的图`"
                  @click.stop="openColorPreview(g, c)"
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <circle cx="6.9" cy="6.9" r="4.5" fill="none" stroke="currentColor" stroke-width="1.7" />
                    <path d="M10.4 10.4 L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- 选中后的操作条：只出现在当前款，避免多张卡片各有一个下拉 -->
            <footer v-if="selStyleKey === g.key && selCount > 0" class="po-pick">
              <span class="po-pick__hint" data-act="pick-hint">{{
                podStylePickHint(selCount, selectionSamePattern)
              }}</span>
              <select
                v-model.number="pick[g.key]"
                class="wb-input wb-input--sm po-pick__sel"
                data-act="pick-pattern"
              >
                <option :value="0" disabled>选图案…</option>
                <optgroup v-if="suggestPatterns(g).length" label="这个款已经用过的">
                  <option v-for="p in suggestPatterns(g)" :key="p.id" :value="p.id">
                    {{ p.code }}{{ p.name ? ` · ${p.name}` : '' }}
                  </option>
                </optgroup>
                <optgroup label="全部图案">
                  <option v-for="p in otherPatterns(g)" :key="p.id" :value="p.id">
                    {{ p.code }}{{ p.name ? ` · ${p.name}` : '' }}
                  </option>
                </optgroup>
              </select>
              <button
                class="wb-btn wb-btn--primary"
                data-act="assign"
                :disabled="!pick[g.key] || saving"
                @click="assignTo(g)"
              >
                认上
              </button>
              <button class="wb-btn" data-act="new-pattern" :disabled="saving" @click="openNew(g)">
                新建图案
              </button>
              <button
                v-if="selectedHasBound"
                class="wb-btn"
                data-act="unassign"
                :disabled="saving"
                @click="unassignFrom(g)"
              >
                撤销认领
              </button>
              <button class="wb-btn po-pick__cancel" data-act="clear-pick" @click="clearSelection">
                取消选择
              </button>
              <p v-if="g.unclassified" class="po-pick__note">
                这个款还没在「归类核对」认到款色 —— 现在只能按图记；归好类再认一次就会记到款上。
              </p>
            </footer>

            <!-- 按图认好但没记到款上：给一个显式按钮（不静默写库） -->
            <footer v-else-if="g.unsavedColors > 0" class="po-save">
              <span class="wb-muted">这些颜色是按图认的</span>
              <button class="wb-btn" data-act="save-to-style" :disabled="saving" @click="saveGroup(g)">
                记到款上（{{ g.unsavedColors }}）
              </button>
              <span class="wb-muted">记下以后同款换了图也认得</span>
            </footer>

            <!-- 新建图案：编号自动填好，名字可空；选中的颜色图顺手当识别图 -->
            <footer v-if="newFor === g.key" class="po-new" data-act="new-form">
              <span class="po-new__title">新建图案（{{ selCount }} 个颜色会认给它）</span>
              <input
                v-model="draft.code"
                class="wb-input wb-input--sm po-new__code"
                placeholder="编号"
                data-act="new-code"
              />
              <input
                v-model="draft.name"
                class="wb-input wb-input--sm po-new__name"
                placeholder="图案名（可空）"
                data-act="new-name"
              />
              <button
                class="wb-btn wb-btn--primary"
                data-act="new-save"
                :disabled="saving"
                @click="createFor(g)"
              >
                建好并认上
              </button>
              <button class="wb-btn" data-act="new-cancel" @click="newFor = ''">取消</button>
            </footer>
          </article>
        </div>
      </section>

      <!-- ── 右：这次要订的图案（清单：图 + 数量） ────────────────────────── -->
      <section class="wb-panel po-need" data-act="pod-need">
        <header class="wb-panel__head">
          <span>② 这次要订的花纸</span>
          <span class="wb-muted" data-act="row-count">{{ report.rows.length }} 个图案</span>
        </header>

        <!-- 空态三选一：没订单 / 没图案 / 库存够 —— 三种 0 要做三件不同的事 -->
        <div v-if="!loading && emptyKind" class="wb-empty po-pad" data-act="empty">
          <p v-if="emptyKind === 'noOrders'">
            现在没有「等我发货」的订单 —— 没有订单就没有要印的料。
          </p>
          <p v-else-if="emptyKind === 'noPatterns'">还没有图案 —— 先在左边按款认一个。</p>
          <p v-else>库存够用 —— {{ report.waitingPieces }} 件要发的都有花纸了，这次不用订。</p>
        </div>

        <div v-else class="po-table-wrap">
          <table class="wb-table" data-act="rows">
            <thead>
              <tr>
                <th class="po-col-img">图</th>
                <th>图案 / 要发</th>
                <th class="wb-num">要补 · 订</th>
                <th>制版图</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in report.rows" :key="r.patternId" :data-act="`row-${r.patternId}`">
                <td class="po-col-img">
                  <button
                    class="po-thumb"
                    type="button"
                    :data-act="`thumb-${r.patternId}`"
                    title="点开看大图"
                    @click="openPreview(r.patternId)"
                  >
                    <img v-if="thumbOf(patternImagePath(r.patternId))" :src="thumbOf(patternImagePath(r.patternId))!" alt="" />
                    <span v-else class="po-ph">无图</span>
                  </button>
                </td>
                <td class="po-col-pat">
                  <div class="po-pat__code">
                    <b>{{ r.code }}</b>
                    <span v-if="r.name" class="po-pat__name">{{ r.name }}</span>
                  </div>
                  <div class="po-pat__nums">
                    要发 {{ r.needPieces }} 件 · 还剩 {{ r.remainingPieces }} 件
                  </div>
                  <div v-if="stylesFor(r.patternId)" class="po-pat__styles" :title="stylesFor(r.patternId)">
                    {{ stylesFor(r.patternId) }}
                  </div>
                </td>
                <td class="wb-num po-col-num">
                  <div class="po-net" data-act="net">{{ r.netNeed }}</div>
                  <div class="po-sheets-line">
                    <span class="po-sheets" data-act="sheets">{{ r.sheets }}</span> 张
                  </div>
                </td>
                <td class="po-col-art">
                  <button
                    v-if="r.artworkImageId > 0"
                    class="wb-tag is-on po-art__ok"
                    type="button"
                    data-act="has-artwork"
                    title="点开看制版图"
                    @click="openPreview(r.patternId)"
                  >
                    有图
                  </button>
                  <button
                    v-else
                    class="wb-btn po-art__add"
                    type="button"
                    data-act="missing-artwork"
                    :disabled="saving"
                    @click="pickArtwork(r.patternId)"
                  >
                    缺图 · 补
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="wb-muted po-hint">
          缺制版图的图案仍进清单（它是真需求），但花纸厂不能直接拿去制版 ——
          点「缺图 · 补」选一张纯图案的图；「复制清单图片」会把每一行的图和**要订几张**画在一张图里。
        </p>
      </section>
    </div>

    <!-- ══ ③ 花纸库存：低频，收在底部（登记到货 / 记录用掉 / 批次） ═══════════ -->
    <section class="wb-panel po-stock" :class="{ 'is-open': showStock }">
      <header class="wb-panel__head">
        <span>花纸库存</span>
        <span class="wb-muted">
          登记一批订单不加库存（货到了才加）；用掉先到先扣，不够整笔拒绝
        </span>
        <button
          class="wb-btn po-stock__toggle"
          data-act="stock-toggle"
          :aria-expanded="showStock"
          @click="showStock = !showStock"
        >
          {{ showStock ? '收起' : `展开 · ${batches.length} 批` }}
        </button>
      </header>

      <div v-if="showStock" class="po-stock__body">
        <div class="po-stock__act" data-act="create-batch">
          <span class="po-stock__label">登记一批</span>
          <select v-model.number="batch.patternId" class="wb-input wb-input--sm" data-act="batch-pattern">
            <option :value="0" disabled>选图案</option>
            <option v-for="p in patterns" :key="p.id" :value="p.id">
              {{ p.code }}{{ p.name ? ` · ${p.name}` : '' }}
            </option>
          </select>
          <input
            v-model="batch.sheets"
            class="wb-input wb-input--sm po-num"
            inputmode="numeric"
            placeholder="订了几张"
            data-act="batch-sheets"
          />
          <span class="wb-muted">张 ×</span>
          <input
            v-model="batch.piecesPerSheet"
            class="wb-input wb-input--sm po-num"
            inputmode="numeric"
            placeholder="每张几件"
            data-act="batch-per"
          />
          <input
            v-model="batch.supplier"
            class="wb-input wb-input--sm po-supplier"
            placeholder="花纸厂（可空）"
            data-act="batch-supplier"
          />
          <button class="wb-btn" data-act="batch-create" :disabled="busy" @click="createBatch">
            登记
          </button>
        </div>

        <div class="po-stock__act" data-act="print">
          <span class="po-stock__label">记录用掉</span>
          <select v-model.number="print.patternId" class="wb-input wb-input--sm" data-act="print-pattern">
            <option :value="0" disabled>选图案</option>
            <option v-for="p in patterns" :key="p.id" :value="p.id">
              {{ p.code }}{{ p.name ? ` · ${p.name}` : '' }}
            </option>
          </select>
          <input
            v-model="print.pieces"
            class="wb-input wb-input--sm po-num"
            inputmode="numeric"
            placeholder="用掉几件"
            data-act="print-pieces"
          />
          <button class="wb-btn" data-act="print-run" :disabled="busy" @click="runPrint">记录</button>
        </div>

        <div v-if="!batches.length" class="wb-muted po-pad" data-act="batches-empty">
          还没有到货记录
        </div>
        <div v-else class="po-table-wrap po-batches">
          <table class="wb-table" data-act="batches">
            <thead>
              <tr>
                <th>图案</th>
                <th class="wb-num">订了几张 × 每张</th>
                <th class="wb-num">剩余</th>
                <th>花纸厂</th>
                <th>下单日</th>
                <th>到货</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in batches" :key="b.id" :data-act="`batch-${b.id}`">
                <td>{{ b.patternCode || `#${b.patternId}` }}</td>
                <td class="wb-num">{{ b.sheets }} × {{ b.piecesPerSheet }}</td>
                <td class="wb-num po-remain" :class="`is-${podStockToneOf(b.remainingPieces)}`">
                  {{ b.remainingPieces }}
                </td>
                <td class="wb-muted">{{ b.supplier || '—' }}</td>
                <td class="wb-muted">{{ b.orderedAt || '—' }}</td>
                <td class="wb-muted">{{ b.arrivedAt || '未到' }}</td>
                <td class="po-ops">
                  <button
                    v-if="!b.arrivedAt"
                    class="wb-btn po-opbtn"
                    :data-act="`arrive-${b.id}`"
                    :disabled="busy"
                    @click="arrive(b.id)"
                  >
                    到货了
                  </button>
                  <template v-else>
                    <input
                      v-model="adjust[b.id]"
                      class="wb-input wb-input--sm po-num"
                      inputmode="numeric"
                      placeholder="多/少几件"
                      :data-act="`adjust-delta-${b.id}`"
                    />
                    <button
                      class="wb-btn po-opbtn"
                      :data-act="`adjust-${b.id}`"
                      :disabled="busy"
                      @click="applyAdjust(b.id)"
                    >
                      修正
                    </button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 使用说明：默认收起。说明是**看一次就够**的东西，不该一直占着卡片的位置 -->
    <div v-if="helpOpen" class="wb-mask" data-act="help-mask" @click.self="helpOpen = false">
      <div class="wb-dialog po-help" role="dialog" aria-modal="true" aria-label="这一页怎么用">
        <header class="wb-dialog__head">
          <span>这一页怎么用</span>
          <button class="wb-dialog__x" type="button" data-act="help-close" @click="helpOpen = false">
            ×
          </button>
        </header>
        <div class="wb-dialog__body po-help__body">
          <h4>怎么认</h4>
          <p>
            一个款里的颜色<b>共用同一张花纸</b>就一起选中、认给同一个图案；两种花就认成两个图案。
            图上显示同一个编号才算一条花纸记录。认过的款下次自动带出来，不用再认。
          </p>

          <h4>快捷键</h4>
          <div class="po-help__keys" data-act="kbd-hint">
            <div class="po-help__row">
              <span class="po-help__key"><kbd>空格</kbd></span><span>选中 / 取消当前色</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>↑</kbd><kbd>↓</kbd></span
              ><span>款内换色（到头跨到相邻款）</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>←</kbd><kbd>→</kbd></span><span>换款</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>Enter</kbd></span><span>认上</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>1-9</kbd></span
              ><span>快选建议里的第 N 个图案并直接认上</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>Z</kbd></span><span>放大看游标那一色的图</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>N</kbd></span><span>新建图案</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>M</kbd></span><span>合并图案</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>S</kbd></span><span>跳过本款</span>
            </div>
            <div class="po-help__row">
              <span class="po-help__key"><kbd>Esc</kbd></span><span>关弹层 / 清空选择</span>
            </div>
          </div>

          <h4>放大看图</h4>
          <p>
            每个色卡右上角的放大镜（或按 <kbd>Z</kbd>）打开大图，图里点一下切到<b>原尺寸</b> ——
            「这两个色是不是同一朵花」就靠它看。
          </p>
        </div>
        <footer class="wb-dialog__foot">
          <span class="wb-muted">按 Esc 也能关</span>
          <button class="wb-btn" data-act="help-done" @click="helpOpen = false">知道了</button>
        </footer>
      </div>
    </div>

    <!-- 看大图：颜色看 SKU 图（认图案要跟图案比），图案看对外那张（制版图优先） -->
    <div v-if="preview.open" class="wb-mask" data-act="image-viewer" @click.self="closePreview">
      <div class="wb-dialog po-viewer" role="dialog" aria-modal="true" aria-label="查看图片">
        <header class="wb-dialog__head">
          <span>{{ preview.title }}</span>
          <button class="wb-dialog__x" type="button" data-act="viewer-close" @click="closePreview">
            ×
          </button>
        </header>
        <div class="wb-dialog__body po-viewer__body" :class="{ 'is-zoom': preview.zoom }">
          <img
            v-if="preview.dataUrl"
            :src="preview.dataUrl"
            alt=""
            :class="{ 'is-zoomable': true }"
            :title="preview.zoom ? '点一下缩回窗口大小' : '点一下放大到原尺寸（看清花蕊 / 色差）'"
            @click="preview.zoom = !preview.zoom"
          />
          <p v-else class="wb-muted">{{ preview.empty || '这张图打不开' }}</p>
        </div>
        <footer class="wb-dialog__foot">
          <span class="wb-muted">{{ preview.note }}</span>
          <button
            v-if="preview.dataUrl"
            class="wb-btn"
            data-act="viewer-zoom"
            @click="preview.zoom = !preview.zoom"
          >
            {{ preview.zoom ? '缩回窗口' : '放大到原尺寸' }}
          </button>
          <button class="wb-btn" data-act="viewer-done" @click="closePreview">看完了</button>
        </footer>
      </div>
    </div>

    <!-- 合并图案：两个图案其实是同一张花模（图 / 颜色 / 款色 / 花纸批次都会跟着过去，可撤销） -->
    <div v-if="mergeOpen" class="wb-mask" data-act="merge-mask" @click.self="closeMerge">
      <div class="wb-dialog po-merge" role="dialog" aria-modal="true" aria-label="合并图案">
        <header class="wb-dialog__head">
          <span>合并图案</span>
          <button class="wb-dialog__x" type="button" data-act="merge-close" @click="closeMerge">
            ×
          </button>
        </header>
        <div class="wb-dialog__body po-merge__body">
          <p class="po-lead">
            两个图案其实是同一张花模时用它：把重复的并成一个，
            <b>识别图、颜色认领、款色和花纸批次都会跟着过去</b>，并完之后源图案不再出现在列表里。
          </p>

          <label class="wb-field">
            <span class="wb-field__label">① 保留哪个图案？</span>
            <select v-model.number="mergeTargetId" class="wb-input wb-input--sm" data-act="merge-target">
              <!-- 占位项：不设默认。没有它时初值 0 落不到任何 option 上，浏览器仍显示第一个图案，
                   而「合并」因为 targetId=0 是灰的 —— 界面说"选好了"、按钮说"没选"，看着像坏了。 -->
              <option :value="0" disabled>保留哪个…（必须明确选）</option>
              <option v-for="p in patterns" :key="p.id" :value="p.id">
                {{ p.code }}{{ p.name ? ` · ${p.name}` : '' }}（{{ p.imageCount }} 张识别图）
              </option>
            </select>
          </label>

          <div class="po-merge__list" data-act="merge-sources">
            <span class="wb-field__label">② 把哪些并进来？</span>
            <button
              v-for="p in mergeCandidates"
              :key="p.id"
              class="po-merge__item"
              :class="{ 'is-on': mergeSources.has(p.id) }"
              :data-act="`merge-src-${p.id}`"
              @click="toggleMergeSource(p.id)"
            >
              <span class="po-merge__check" aria-hidden="true"></span>
              <b>{{ p.code }}</b>
              <span v-if="p.name" class="wb-muted">{{ p.name }}</span>
              <span class="wb-muted">
                {{ p.imageCount }} 张图 · 库存 {{ p.remainingPieces }} 件
              </span>
            </button>
            <p v-if="!mergeCandidates.length" class="wb-muted">没有可合并的图案（至少要有两个）</p>
          </div>

          <div v-if="mergeHistory.length" class="po-merge__hist" data-act="merge-history">
            <span class="wb-field__label">最近的合并（点撤销可以拆回来）</span>
            <div v-for="h in mergeHistory" :key="h.batchId" class="po-merge__hrow">
              <span>
                <b>{{ h.targetCode || `#${h.targetPatternId}` }}</b> ←
                {{ h.sources.map((s) => s.code).join('、') }}
              </span>
              <span class="wb-muted">
                搬了 {{ h.movedImages }} 张图 / {{ h.movedSlots }} 个颜色 /
                {{ h.movedStyleColors }} 个款色 / {{ h.movedBatches }} 批花纸 · {{ h.createdAt }}
              </span>
              <button
                class="wb-btn"
                :data-act="`merge-undo-${h.batchId}`"
                :disabled="mergeBusy"
                @click="undoMerge(h.batchId)"
              >
                撤销
              </button>
            </div>
          </div>
        </div>
        <footer class="wb-dialog__foot">
          <p v-if="mergeError" class="wb-notice wb-notice--error po-merge__err" data-act="merge-error">
            {{ mergeError }}
          </p>
          <span class="wb-muted">
            {{
              mergeSources.size
                ? `${mergeSources.size} 个图案 → ${mergeTargetLabel}`
                : '先勾要并进来的图案'
            }}
          </span>
          <button class="wb-btn" data-act="merge-cancel" @click="closeMerge">取消</button>
          <button
            class="wb-btn wb-btn--primary"
            data-act="merge-do"
            :disabled="mergeBusy || !mergeSources.size || !mergeTargetId"
            @click="doMerge"
          >
            {{ mergeBusy ? '合并中…' : '合并' }}
          </button>
        </footer>
      </div>
    </div>

    <p v-if="exported" class="po-done" data-act="export-result">
      已导出：{{ exported.filePath }} · 清单 {{ exported.rows }} 行 · 制版图
      {{ exported.images }} 张
      <template v-if="exported.missingArtwork.length">
        · 缺制版图：{{ exported.missingArtwork.join('、') }}
      </template>
    </p>
  </div>
</template>

<script setup lang="ts">
// 「发货台 › 订花纸」—— **认图案、算料、发清单在这同一页**（2026-11-03 合并改造）。
//
// ── 用户口径（改这一页之前先读）──────────────────────────────────────────────
// ① 「把产品管理中的图案和发货台的订花纸功能精简合并，放在现有的订花纸中」——
//    原「基础数据 › 产品管理 › 图案」整页并进来，那个入口已删除（入口唯一）。
// ② 「在归类核对完后，按款图进行用户手动分类汇总图案，并给出需要订购的花纸图片和数量」——
//    所以左边是**按款**的卡片（一个款一张卡，款内每个颜色一张 chip），右边是**清单**
//    （每个图案一张图 + 要补件数 + 要订张数）。
// ③ 「款 A 包含 3 个颜色…这三张 SKU 图片中有可能用的是同一个花纸图案，最终我们只需要用任意一张
//    图片存一条花纸图案记录；如果有两个花纸图案，就需要存两条」——
//    认的是**款色**（`oi_style_colors.id`），一个款色一行；同款三个色认给同一个图案 =
//    一条花纸记录（图案表里只有一行，识别图挂着三张）。款的图案集合由款色派生，不另存。
// ④ 「SKU 图案和花纸图案 id 的关系，自动维护款中的图案数据…下次遇到同款时就不用再对应了」——
//    每次认领都在同一事务里写 `pod_style_color_patterns`（款色 → 图案），下次同款直接命中；
//    匹配顺序的唯一实现在 `src/lib/podNeed.ts`（款色 → 图片指纹 → 变体键）。
//
// ── 三个"只有一处"的实现（界面里不许再写一遍）──────────────────────────────
//   · 匹配顺序 / 净需件 / 张数：`src/lib/podNeed.ts`
//   · 按款分组与款内汇总：`src/lib/podStyles.ts`
//   · 清单的图与文字：`src/lib/podSheet.ts`（屏上、复制、导出共用同一个模型）
//
// ⚠️ 这一页的 `data-act` 被 `scripts/today-ui-smoke.mjs` 钉着
//    （pod-order-panel / summary / row-N / .po-sheets / trust / go-patterns / copy-image / receipt）。
//    改结构时先看那段断言，别让"数值对不上"和"没接线"长得一样。
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import * as ipc from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { writeClipboard, writeClipboardImage } from '@/core/services/clipboard';
import { localDayKey } from '@/lib/localDay';
import {
  DEFAULT_PIECES_PER_SHEET,
  MAX_PIECES_PER_SHEET,
  podNeedEmptyOf,
  podNeedReport,
  podNeedTrustOf,
  type PodNeedReport,
} from '@/lib/podNeed';
import {
  podStyleGroupsOf,
  podStylePickHint,
  type PodStyleColor,
  type PodStyleGroup,
} from '@/lib/podStyles';
import { nextPodPatternCode, podStockToneOf } from '@/lib/podBinding';
import { podSheetModelOf, podSheetTextOf, renderPodSheetPng } from '@/lib/podSheet';
import type {
  PodBatchRow,
  PodNeedData,
  PodPatternMergeRecord,
  PodPatternRow,
  PodReportExportResult,
} from '@/types';
import { useShipping } from '../flowCtx';

/** 容器（发货台）在别处写操作后 +1 —— 认图/到货都可能改变净需件，跟着重算 */
const { token } = useShipping();

const loading = ref(false);
const error = ref('');
const receipt = ref('');
const copying = ref(false);
const saving = ref(false);
const busy = ref(false);

const data = ref<PodNeedData | null>(null);
const patterns = ref<PodPatternRow[]>([]);
const batches = ref<PodBatchRow[]>([]);
const perInput = ref(String(DEFAULT_PIECES_PER_SHEET));
const exported = ref<PodReportExportResult | null>(null);

/** 左栏筛选 */
const search = ref('');
const onlyUnbound = ref(true);
/** 使用说明（口径 / 快捷键 / 放大）默认收起：看一次就够的东西不该占着卡片的位置 */
const helpOpen = ref(false);

/** 选中的颜色（**只在一个款里**：跨款同时选没有意义，认的对象是款内的一组颜色） */
const selStyleKey = ref('');
const selKeys = ref<Set<string>>(new Set());
/** 每个款卡片当前选的图案（不选 = 0） */
const pick = reactive<Record<string, number>>({});

/** 新建图案的行内表单（'' = 没开）；`draft` 只在打开时填一次 */
const newFor = ref('');
const draft = reactive({ code: '', name: '' });

/** 大图预览 */
const preview = ref({ open: false, title: '', dataUrl: '', note: '', empty: '', zoom: false });

/** 花纸库存 */
const showStock = ref(false);
const batch = reactive({ patternId: 0, sheets: '', piecesPerSheet: '', supplier: '' });
const print = reactive({ patternId: 0, pieces: '' });
const adjust = reactive<Record<number, string>>({});

/** 合并图案 */
const mergeOpen = ref(false);
const mergeBusy = ref(false);
const mergeError = ref('');
const mergeTargetId = ref(0);
const mergeSources = ref<Set<number>>(new Set());
const mergeHistory = ref<PodPatternMergeRecord[]>([]);
const mergeTargetLabel = computed(() => {
  const p = patterns.value.find((x) => x.id === mergeTargetId.value);
  return p ? `${p.code}${p.name ? ` · ${p.name}` : ''}` : '—';
});
const mergeCandidates = computed(() =>
  patterns.value.filter((p) => p.id !== mergeTargetId.value)
);

const stylesEl = ref<HTMLElement | null>(null);

/** 缩略图缓存：key = 本地路径（同一张图只取一次；'' = 取过但失败，不重复重试） */
const thumbs = ref<Record<string, string>>({});

const candidatesCount = computed(() => data.value?.candidates.length ?? 0);
const truncated = computed(() => data.value?.truncated ?? 0);

const report = computed<PodNeedReport>(() => {
  const d = data.value;
  return podNeedReport({
    candidates: d?.candidates ?? [],
    bindings: d?.bindings ?? {},
    imageBindings: d?.imageBindings ?? {},
    styleColorBindings: d?.styleColorBindings ?? {},
    patterns: d?.patterns ?? [],
    piecesPerSheet: Number(perInput.value) || DEFAULT_PIECES_PER_SHEET,
  });
});

/** 按款分组（左栏；"还有几个款没认全"也只读这里） */
const styleReport = computed(() =>
  podStyleGroupsOf({
    candidates: data.value?.candidates ?? [],
    bindings: data.value?.bindings ?? {},
    imageBindings: data.value?.imageBindings ?? {},
    styleColorBindings: data.value?.styleColorBindings ?? {},
    patterns: data.value?.patterns ?? [],
    onlyUnbound: onlyUnbound.value,
    search: search.value,
  })
);
const styleGroups = computed(() => styleReport.value.groups);
const styleTotals = computed(() => styleReport.value.totals);

const podStylesHint = computed(() =>
  styleTotals.value.unclassifiedColors > 0
    ? `${styleTotals.value.unclassifiedColors} 个颜色还没归类`
    : `${styleTotals.value.colors} 个颜色`
);

const trust = computed(() => podNeedTrustOf(report.value));
const emptyKind = computed(() =>
  data.value ? podNeedEmptyOf(report.value, patterns.value.length) : null
);

// ── 选择与认领 ───────────────────────────────────────────────────────────

const selectedChips = computed<PodStyleColor[]>(() => {
  const g = styleGroups.value.find((x) => x.key === selStyleKey.value);
  if (!g) return [];
  return g.colors.filter((c) => selKeys.value.has(c.key));
});
const selCount = computed(() => selectedChips.value.length);
/** 选中的颜色是不是都已经属于同一个图案（按钮文案据此说"共用这一条花纸"） */
const selectionSamePattern = computed(() => {
  const ids = selectedChips.value.map((c) => c.patternId).filter((n) => n > 0);
  return ids.length > 0 && new Set(ids).size === 1 && ids.length === selectedChips.value.length;
});
const selectedHasBound = computed(() => selectedChips.value.some((c) => c.patternId > 0));

function isSelected(g: PodStyleGroup, c: PodStyleColor): boolean {
  return selStyleKey.value === g.key && selKeys.value.has(c.key);
}

function toggleColor(g: PodStyleGroup, c: PodStyleColor): void {
  // 换款就清空：跨款同时选会让"认给哪个图案"变成一个猜谜
  if (selStyleKey.value !== g.key) {
    selStyleKey.value = g.key;
    selKeys.value = new Set();
    if (!pick[g.key]) pick[g.key] = 0;
  }
  const next = new Set(selKeys.value);
  if (next.has(c.key)) next.delete(c.key);
  else next.add(c.key);
  selKeys.value = next;
  // 选中的颜色里有已经认过的，默认把图案带出来（"这个色改成它那个花"最常见的动作）
  if (!pick[g.key]) {
    const bound = g.colors.find((x) => next.has(x.key) && x.patternId > 0);
    if (bound) pick[g.key] = bound.patternId;
  }
}

function clearSelection(): void {
  selKeys.value = new Set();
  selStyleKey.value = '';
}

/** 这个款已经用过的图案（认新颜色时排前面当建议） */
function suggestPatterns(g: PodStyleGroup): PodPatternRow[] {
  return g.patternIds
    .map((id) => patterns.value.find((p) => p.id === id))
    .filter((p): p is PodPatternRow => !!p);
}

function otherPatterns(g: PodStyleGroup): PodPatternRow[] {
  const used = new Set(g.patternIds);
  return patterns.value.filter((p) => !used.has(p.id));
}

const FINGERPRINT_RE = /^[0-9a-f]{16,128}$/i;

/** 拼认领载荷：能用的指纹 + 款色 id（都没有 ⇒ 认不了，界面要说清） */
function linkPayloadOf(chips: PodStyleColor[]): { images: { fingerprint: string }[]; styleColorIds: number[] } {
  const seen = new Set<string>();
  const images: { fingerprint: string }[] = [];
  for (const c of chips) {
    const fp = (c.imageFingerprint || '').trim();
    if (!FINGERPRINT_RE.test(fp) || seen.has(fp)) continue;
    seen.add(fp);
    images.push({ fingerprint: fp });
  }
  const styleColorIds = [...new Set(chips.map((c) => c.styleColorId).filter((id) => id > 0))];
  return { images, styleColorIds };
}

/** 认给某个图案：款色与图**同一次调用**（主进程同一事务），失败不静默 */
async function assignTo(g: PodStyleGroup): Promise<void> {
  const patternId = pick[g.key] ?? 0;
  const chips = selectedChips.value;
  if (!patternId || !chips.length || saving.value) return;
  const { images, styleColorIds } = linkPayloadOf(chips);
  if (!images.length && !styleColorIds.length) {
    toast('这些颜色既没有款色也没有可用的图 —— 先去「归类核对」把款色认上', 'info');
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const r = await ipc.podImageLink({ patternId, images, styleColorIds, source: 'image' });
    if (!r.success) throw new Error(String(r.error || '认领失败'));
    const d = r.data;
    const code = codeOf(patternId);
    const parts = [`${chips.length} 个颜色 → ${code}`];
    if (d?.moved || d?.movedStyleColors) {
      parts.push(
        `${Math.max(d.moved, d.movedStyleColors)} 个原来在别的图案上，已挪过来`
      );
    }
    parts.push(images.length ? `挂了 ${images.length} 张识别图` : '没图，只按款色记');
    receipt.value = `已认好：${parts.join(' · ')}（下次同款会自动带出这个图案）`;
    clearSelection();
    delete pick[g.key];
    await refresh();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '未知错误';
    error.value = msg;
    toast(`认领失败：${msg}`, 'error');
  } finally {
    saving.value = false;
  }
}

/** 撤销选中颜色的认领（图和款色一起撤） */
async function unassignFrom(g: PodStyleGroup): Promise<void> {
  const chips = selectedChips.value;
  if (!chips.length || saving.value) return;
  const { images, styleColorIds } = linkPayloadOf(chips);
  if (!images.length && !styleColorIds.length) {
    toast('这些颜色没有可撤销的认领', 'info');
    return;
  }
  saving.value = true;
  try {
    const r = await ipc.podImageUnlink({
      fingerprints: images.map((i) => i.fingerprint),
      styleColorIds,
    });
    if (!r.success) throw new Error(String(r.error || '撤销失败'));
    receipt.value = `已撤销 ${chips.length} 个颜色的认领（图与款色都撤了）`;
    clearSelection();
    await refresh();
  } catch (e: unknown) {
    toast(`撤销失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

/** 把"按图认好但没记到款上"的颜色记下来（显式动作，不静默写库） */
async function saveGroup(g: PodStyleGroup): Promise<void> {
  const chips = g.colors.filter(
    (c) => c.patternId > 0 && c.styleColorId > 0 && c.via !== 'styleColor'
  );
  if (!chips.length || saving.value) return;
  saving.value = true;
  try {
    const byPattern = new Map<number, number[]>();
    for (const c of chips) {
      const list = byPattern.get(c.patternId) ?? [];
      list.push(c.styleColorId);
      byPattern.set(c.patternId, list);
    }
    for (const [pid, ids] of byPattern) {
      const r = await ipc.podImageLink({ patternId: pid, images: [], styleColorIds: ids, source: 'image' });
      if (!r.success) throw new Error(String(r.error || '记到款上失败'));
    }
    receipt.value = `已把 ${g.styleCode} 的 ${chips.length} 个颜色记到款上 —— 以后同款换了图也认得`;
    await refresh();
  } catch (e: unknown) {
    toast(`记到款上失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

/** 打开新建图案的行内表单（编号自动填下一个空号） */
function openNew(g: PodStyleGroup): void {
  newFor.value = g.key;
  draft.code = nextPodPatternCode(patterns.value.map((p) => p.code));
  draft.name = '';
  void nextTick(() => {
    const el = stylesEl.value?.querySelector<HTMLInputElement>('[data-act="new-code"]');
    el?.focus();
    el?.select();
  });
}

/** 建图案 + 认上（建行与挂图在同一事务；款色随后一条调用，失败要说出来） */
async function createFor(g: PodStyleGroup): Promise<void> {
  if (saving.value) return;
  const code = draft.code.trim();
  if (!code) {
    toast('图案编号不能为空（不知道填什么就保留自动填的那个）', 'error');
    return;
  }
  const chips = selectedChips.value;
  if (!chips.length) {
    toast('先点颜色图选中（可多选）', 'info');
    return;
  }
  const { images, styleColorIds } = linkPayloadOf(chips);
  saving.value = true;
  try {
    const r = await ipc.podPatternCreate({
      code,
      name: draft.name.trim(),
      images,
      source: 'create',
    });
    if (!r.success) throw new Error(String(r.error || '新建失败'));
    const id = Number(r.data?.id) || 0;
    if (styleColorIds.length) {
      const l = await ipc.podImageLink({ patternId: id, images: [], styleColorIds, source: 'create' });
      if (!l.success) {
        // 图案已经建好了：不能报"整个失败"（用户会以为没建成），要说清"图挂了、款色没记住"
        throw new Error(`图案 ${code} 已建好，但款色没记上：${String(l.error || '未知原因')}`);
      }
    }
    receipt.value = `新建图案 ${code}，已认上 ${chips.length} 个颜色${
      styleColorIds.length ? '（并记到款上）' : '（只按图记，未归类）'
    }`;
    newFor.value = '';
    clearSelection();
    await refresh();
  } catch (e: unknown) {
    toast(`新建失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

// ── 图案 / 缩略图 ────────────────────────────────────────────────────────

function patternOf(id: number): PodPatternRow | undefined {
  return patterns.value.find((p) => p.id === id);
}

function codeOf(id: number): string {
  return patternOf(id)?.code || `#${id}`;
}

/** 图案的"对外那张图"：制版图优先（花纸厂照着它制版），其次预览图，最后识别图 */
function patternImagePath(patternId: number): string {
  const p = patternOf(patternId);
  if (!p) return '';
  return p.artworkLocalPath || p.previewLocalPath || (p.imageLocalPaths?.[0] ?? '') || '';
}

/** 款卡片的图：第一个有图的颜色（款图 = 这个款卖相的那张） */
function groupImageOf(g: PodStyleGroup): string {
  for (const c of g.colors) {
    const t = thumbOf(c.imagePath);
    if (t) return t;
  }
  return '';
}

function thumbOf(localPath: string | null | undefined): string {
  if (!localPath) return '';
  return thumbs.value[localPath] ?? '';
}

function chipTitle(c: PodStyleColor): string {
  const bits = [`${c.color} · 要发 ${c.pieces} 件`];
  if (c.patternId) bits.push(`已认 ${codeOf(c.patternId)}`);
  else bits.push('还没认图案');
  if (c.conflict) bits.push('这个色的订单认到了不同图案，需要确认');
  if (c.styleColorId <= 0) bits.push('这款还没归类（只能按图记）');
  return bits.join(' · ');
}

/** 清单行下面的"这朵花是谁要的"（取前两个款色，多了说个数） */
function stylesFor(patternId: number): string {
  const out: string[] = [];
  for (const g of styleGroups.value) {
    for (const c of g.colors) {
      if (c.patternId !== patternId) continue;
      out.push(`${g.styleCode}·${c.color}`);
    }
  }
  if (!out.length) return '';
  return out.length > 2 ? `${out.slice(0, 2).join('、')} 等 ${out.length} 个颜色` : out.join('、');
}

async function primeThumbs(paths: (string | null | undefined)[]): Promise<void> {
  const need = [...new Set(paths.filter((p): p is string => !!p && !(p in thumbs.value)))];
  if (!need.length) return;
  try {
    const r = await ipc.orderImageThumbBatch(need.map((localPath) => ({ localPath, maxEdge: 220 })));
    if (!r.success) return;
    const patch: Record<string, string> = {};
    need.forEach((p, i) => {
      patch[p] = r.data?.dataUrls?.[i] ?? '';
    });
    thumbs.value = { ...thumbs.value, ...patch };
  } catch {
    // 缩略图是辅助信息：坏了不该让整块清单报错（数量才是这一页的主职能）
  }
}

// ── 取数 ─────────────────────────────────────────────────────────────────

async function load(opts?: { keepReceipt?: boolean }): Promise<void> {
  loading.value = true;
  error.value = '';
  // 写操作后的重取**不清回执**：那句「已认好：1 个颜色 → P001 · 没图，只按款色记」是用户唯一
  // 能核对的确认（toast 一走动就没了）。所有写操作都是先写回执再 refresh ⇒ 清掉就等于认完没说话。
  if (!opts?.keepReceipt) receipt.value = '';
  try {
    const [n, pl, bl] = await Promise.all([
      ipc.podNeedData(),
      ipc.podPatternList(),
      ipc.podBatchList({ limit: 200 }),
    ]);
    if (!n.success) throw new Error(String(n.error || '读取失败'));
    data.value = n.data ?? null;
    patterns.value = pl.success ? (pl.data ?? []) : [];
    batches.value = bl.success ? (bl.data ?? []) : [];
    exported.value = null;
    await primeThumbs([
      ...styleGroups.value.flatMap((g) => g.colors.map((c) => c.imagePath)),
      ...patterns.value.map((p) => p.artworkLocalPath || p.previewLocalPath || p.imageLocalPaths?.[0] || ''),
    ]);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '未知错误';
    data.value = null;
  } finally {
    loading.value = false;
  }
}

/** 写操作后：重取全部（件数、余量、识别图张数都变了），**保留回执** */
async function refresh(): Promise<void> {
  await load({ keepReceipt: true });
}

function focusStyles(): void {
  stylesEl.value?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (!styleGroups.value.length) toast('没有要认的颜色了', 'info');
}

/** 每张印几件只接受 1..MAX；越界**回落**到默认并提示（不静默截断成一个看似合理的值） */
function applyPer(): void {
  const n = Math.round(Number(perInput.value) || 0);
  if (n <= 0 || n > MAX_PIECES_PER_SHEET) {
    perInput.value = String(DEFAULT_PIECES_PER_SHEET);
    toast(
      `每张花纸印几件要填 1..${MAX_PIECES_PER_SHEET} 之间的整数，已改回 ${DEFAULT_PIECES_PER_SHEET}`,
      'info'
    );
  } else {
    perInput.value = String(n);
  }
}

// ── 清单输出（屏上 / 复制图 / 复制文字 / 导出 共用同一个模型）─────────────

function sheetModel() {
  return podSheetModelOf(report.value.rows, patterns.value, {
    date: localDayKey(),
    piecesPerSheet: report.value.piecesPerSheet,
    unboundPieces: report.value.unboundPieces,
    unboundRows: report.value.unboundRows,
  });
}

async function copyImage(): Promise<void> {
  if (copying.value) return;
  const model = sheetModel();
  if (!model) {
    toast('这次没有要补的花纸', 'info');
    return;
  }
  copying.value = true;
  try {
    const dataUrl = await renderPodSheetPng(model, (path) => thumbs.value[path] ?? '');
    if (!dataUrl) throw new Error('清单图生成失败');
    const ok = await writeClipboardImage(dataUrl);
    if (!ok) throw new Error('写入剪贴板失败');
    receipt.value = `已复制清单图：${model.lines.length} 个图案 · 要订 ${model.totalSheets} 张 —— 粘贴到微信里发给花纸厂`;
    toast(receipt.value, 'success');
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    copying.value = false;
  }
}

async function copyText(): Promise<void> {
  const model = sheetModel();
  if (!model) {
    toast('这次没有要补的花纸', 'info');
    return;
  }
  try {
    const ok = await writeClipboard(podSheetTextOf(model));
    if (!ok) throw new Error('写入剪贴板失败');
    receipt.value = `已复制文字清单：${model.lines.length} 个图案 · 要订 ${model.totalSheets} 张`;
    toast(receipt.value, 'success');
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  }
}

async function exportZip(): Promise<void> {
  if (loading.value || !report.value.rows.length) return;
  loading.value = true;
  error.value = '';
  try {
    const r = await ipc.podReportExport({
      rows: report.value.rows,
      date: localDayKey(),
      piecesPerSheet: report.value.piecesPerSheet,
      unboundPieces: report.value.unboundPieces,
      unboundRows: report.value.unboundRows,
      assumedRows: report.value.assumedRows,
    });
    if (!r.success) throw new Error(String(r.error || '导出失败'));
    exported.value = r.data ?? null;
    toast(`已导出 ${r.data?.rows ?? 0} 行 / ${r.data?.images ?? 0} 张制版图`, 'info');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '未知错误';
    // 取消保存不是失败（与 ledger 导出同口径）
    if (msg !== '__canceled__') {
      error.value = msg;
      toast(`导出失败：${msg}`, 'error');
    }
  } finally {
    loading.value = false;
  }
}

/** 补制版图：选一张纯图案的图（不能是模特图 —— 传错整批报废） */
async function pickArtwork(patternId: number): Promise<void> {
  if (saving.value) return;
  const sel = await ipc.selectImage();
  if (!sel.success) {
    if (String(sel.error || '') !== 'User canceled') {
      toast(String(sel.error || '选图失败'), 'error');
    }
    return;
  }
  saving.value = true;
  try {
    const landed = await ipc.podPatternImage({ srcPath: sel.data?.filePath ?? '' });
    if (!landed.success) throw new Error(String(landed.error || '这张图读不进来'));
    const imageId = Number(landed.data?.imageId) || 0;
    if (!imageId) throw new Error('这张图没有落库');
    const p = patternOf(patternId);
    const up = await ipc.podPatternUpdate({
      id: patternId,
      artworkImageId: imageId,
      // 预览图只补空：已经配过认图用的预览就不要被制版图顶掉
      ...(p && p.previewImageId > 0 ? {} : { previewImageId: imageId }),
    });
    if (!up.success) throw new Error(String(up.error || '保存制版图失败'));
    receipt.value = `已给 ${codeOf(patternId)} 补上制版图`;
    await refresh();
  } catch (e: unknown) {
    toast(`补制版图失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

/**
 * 打开大图。**只做一件事**：把这张图读出来给人看。
 * 标题 / 脚注必须写清"这是哪个款哪个色、它现在认到哪个图案" ——
 * 认错图案时，用户唯一的发现方式就是把这张图和那个图案的图放到一样大去比。
 */
async function showImage(
  title: string,
  localPath: string,
  note: string,
  empty: string
): Promise<void> {
  if (!localPath) {
    preview.value = { open: true, title, dataUrl: '', note, empty, zoom: false };
    return;
  }
  const r = await ipc.orderReadImage(localPath);
  preview.value = {
    open: true,
    title,
    dataUrl: r.success ? (r.data?.dataUrl ?? '') : '',
    note,
    empty,
    zoom: false,
  };
}

/**
 * 「按款认图案」里放大看某一色的 SKU 图。
 * 三件事不写进标题/脚注，放大了也判断不了：
 *   ① 哪个款哪个色（同款三色长得像，不带色名就会看串）；
 *   ② 它现在认到哪个图案（认错时，只有两张图放一样大才看得出来）；
 *   ③ 两行认到不同图案（`conflict`）要说出来 —— 不说就会照着错的图案订花纸。
 */
function openColorPreview(g: PodStyleGroup, c: PodStyleColor): void {
  const bits = [`${c.pieces} 件`];
  bits.push(c.patternId ? `现在认到 ${codeOf(c.patternId)}` : '还没认图案');
  if (c.conflict) bits.push('同色两行认到了不同图案，先核对');
  void showImage(
    `${g.styleCode} · ${c.color}`,
    c.imagePath,
    bits.join(' · '),
    '这个色还没有 SKU 图 —— 先在「归类核对」把商品图下下来，或者直接按款色认图案（不靠图也能记）'
  );
}

async function openPreview(patternId: number): Promise<void> {
  const p = patternOf(patternId);
  const title = p ? `${p.code}${p.name ? ` · ${p.name}` : ''}` : `图案 #${patternId}`;
  await showImage(
    title,
    patternImagePath(patternId),
    p && p.artworkImageId > 0
      ? '这张是制版图'
      : '这张是识别图 / 预览图（补了制版图后按制版图发）',
    '这个图案还没配图 —— 认颜色时会自动挂上识别图，制版图要单独补'
  );
}

function closePreview(): void {
  preview.value = { open: false, title: '', dataUrl: '', note: '', empty: '', zoom: false };
}

// ── 花纸库存 ─────────────────────────────────────────────────────────────
// 四条账务纪律（见 `electron/pod-db.ts` 的注释，界面这一侧不能再造一套）：
//   ① 登记订单**不加库存**：钱花了但货没到；
//   ② 到货**只能登记一次**（`arrivedAt` 已有就不给按钮）；
//   ③ 用掉按批次**先到先扣**，**不够整笔拒绝**；
//   ④ 修正写一行**带符号**流水，不改旧行。

async function createBatch(): Promise<void> {
  if (busy.value) return;
  const sheets = Math.round(Number(batch.sheets) || 0);
  const per = Math.round(Number(batch.piecesPerSheet) || 0);
  if (!batch.patternId) {
    receipt.value = '先选图案';
    return;
  }
  if (sheets <= 0 || per <= 0) {
    toast('“订了几张”和“每张几件”都要大于 0（单位错了库存就全废了）', 'error');
    return;
  }
  busy.value = true;
  try {
    const r = await ipc.podBatchCreate({
      patternId: batch.patternId,
      sheets,
      piecesPerSheet: per,
      supplier: batch.supplier.trim(),
    });
    if (!r.success) throw new Error(String(r.error || '登记失败'));
    receipt.value = `已登记一批（订了 ${sheets} 张 × 每张 ${per} 件）—— 货到了才加库存，去下面点「到货了」`;
    batch.sheets = '';
    batch.piecesPerSheet = '';
    batch.supplier = '';
    await refresh();
  } catch (e: unknown) {
    toast(`登记失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function arrive(batchId: number): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await ipc.podBatchArrive({ batchId });
    if (!r.success) throw new Error(String(r.error || '登记到货失败'));
    // 只能登记一次：主进程回 arrived:false 时**不报成功**，否则用户以为多了一批
    receipt.value = r.data?.arrived
      ? `已到货 ${r.data.arrivedPieces} 件，库存已加上`
      : '这批已经登记过到货了（没有重复加库存）';
    await refresh();
  } catch (e: unknown) {
    toast(`登记到货失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function applyAdjust(batchId: number): Promise<void> {
  if (busy.value) return;
  const delta = Math.round(Number(adjust[batchId] || 0));
  if (!delta) {
    toast('修正值不能是 0（多了填正数，少了填负数）', 'info');
    return;
  }
  busy.value = true;
  try {
    const r = await ipc.podAdjust({ batchId, deltaPieces: delta });
    if (!r.success) throw new Error(String(r.error || '修正失败'));
    receipt.value = `已修正 ${delta > 0 ? '+' : ''}${delta} 件`;
    adjust[batchId] = '';
    await refresh();
  } catch (e: unknown) {
    toast(`修正失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function runPrint(): Promise<void> {
  if (busy.value) return;
  const pieces = Math.round(Number(print.pieces) || 0);
  if (!print.patternId || pieces <= 0) {
    receipt.value = '先选图案并填用掉几件';
    return;
  }
  busy.value = true;
  try {
    const r = await ipc.podPrint({ patternId: print.patternId, pieces });
    if (!r.success) throw new Error(String(r.error || '记录失败'));
    receipt.value = `已记录用掉 ${r.data?.printed ?? 0} 件（从 ${
      (r.data?.allocations ?? []).length
    } 批里先到先扣）`;
    print.pieces = '';
    await refresh();
  } catch (e: unknown) {
    // 余量不足时主进程回的是人话（「花纸余量不足：还差 N 件」）—— 原样显示
    toast(e instanceof Error ? e.message : '未知错误', 'error');
  } finally {
    busy.value = false;
  }
}

// ── 合并 ────────────────────────────────────────────────────────────────

async function openMerge(): Promise<void> {
  mergeOpen.value = true;
  mergeError.value = '';
  mergeSources.value = new Set();
  await reloadMergeHistory();
}

function closeMerge(): void {
  if (mergeBusy.value) return;
  mergeOpen.value = false;
  mergeError.value = '';
}

async function reloadMergeHistory(): Promise<void> {
  const r = await ipc.podPatternMergeHistory({ limit: 20 });
  if (r.success) mergeHistory.value = r.data ?? [];
}

function toggleMergeSource(id: number): void {
  const next = new Set(mergeSources.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  mergeSources.value = next;
}

async function doMerge(): Promise<void> {
  if (mergeBusy.value || !mergeSources.value.size || !mergeTargetId.value) return;
  mergeBusy.value = true;
  mergeError.value = '';
  try {
    const r = await ipc.podPatternMerge({
      targetId: mergeTargetId.value,
      sourceIds: [...mergeSources.value],
    });
    if (!r.success) throw new Error(String(r.error || '合并失败'));
    const d = r.data;
    if (d && !d.ok) throw new Error(d.error || '合并失败');
    receipt.value = `已合并：搬了 ${d?.movedImages ?? 0} 张识别图、${d?.movedSlots ?? 0} 个颜色、${
      d?.movedStyleColors ?? 0
    } 个款色、${d?.movedBatches ?? 0} 批花纸`;
    mergeSources.value = new Set();
    await Promise.all([refresh(), reloadMergeHistory()]);
  } catch (e: unknown) {
    mergeError.value = e instanceof Error ? e.message : '未知错误';
    toast(`合并失败：${mergeError.value}`, 'error');
  } finally {
    mergeBusy.value = false;
  }
}

async function undoMerge(batchId: string): Promise<void> {
  if (mergeBusy.value) return;
  mergeBusy.value = true;
  mergeError.value = '';
  try {
    const r = await ipc.podPatternMergeUndo({ batchId });
    if (!r.success) throw new Error(String(r.error || '撤销失败'));
    const d = r.data;
    if (d && !d.ok) throw new Error(d.error || '撤销失败');
    receipt.value = `已拆开这次合并（还原 ${d?.restored ?? 0} 样${
      d?.skipped ? `，${d.skipped} 样已被后续操作改到别处，没搬回` : ''
    }）`;
    await Promise.all([refresh(), reloadMergeHistory()]);
  } catch (e: unknown) {
    mergeError.value = e instanceof Error ? e.message : '未知错误';
    toast(`撤销失败：${mergeError.value}`, 'error');
  } finally {
    mergeBusy.value = false;
  }
}

// ── 键盘流（T3-7：连续认几十个颜色不出鼠标）───────────────────────────────
//
// 语义照旧绑定台（已归档的 `BindingPanel.vue`）平移过来，按"款卡片 + 色 chip"重排后
// 多出 ↑↓：一款多色时 ←→ 换款、↑↓ 换色。
//
//   Space 选/取消当前色 · ↑↓ 款内换色 · ←→ 换款 · Enter 认上 · 1-9 快选建议图案
//   N 新建 · M 合并 · S 跳过本款 · Esc 关层/清选择
//
// ⚠️ 本页被 `TodayView` 的 `<KeepAlive>` 保活 —— 切到「归类核对」时组件**不卸载**。
//    所以监听必须挂 onActivated / 摘 onDeactivated：不然在别的页签按空格会把这里的颜色选上、
//    按 1 会直接写库认领（"人已经离开这页了，它还在动"）。这是本文件最容易复发的一处。
const focusIdx = reactive({ style: 0, color: 0 });

function clampIdx(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(Math.max(i, 0), len - 1);
}

function focusGroup(): PodStyleGroup | undefined {
  return styleGroups.value[clampIdx(focusIdx.style, styleGroups.value.length)];
}

function focusChip(): PodStyleColor | undefined {
  const g = focusGroup();
  return g ? g.colors[clampIdx(focusIdx.color, g.colors.length)] : undefined;
}

/** 把 DOM 焦点挪到游标那格（真聚焦才能让 :focus-visible 环出现、读屏也跟得上） */
function syncFocusEl(): void {
  const el = stylesEl.value?.querySelector<HTMLElement>(
    `[data-act="color-${focusIdx.style}-${focusIdx.color}"]`
  );
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

/**
 * 移动游标。
 * `dColor` 走到本款头/尾再按**跨到相邻款**（连续认色时不用先按 ←→）；
 * `dStyle` 换款时保住色序（第二款也选第二个色，款色对齐时最省手）。
 */
function moveFocus(dStyle: number, dColor: number): void {
  const gs = styleGroups.value;
  if (!gs.length) return;
  const si = clampIdx(focusIdx.style, gs.length);
  const g = gs[si];
  if (dStyle) {
    const ns = clampIdx(si + dStyle, gs.length);
    focusIdx.style = ns;
    focusIdx.color = clampIdx(focusIdx.color, gs[ns].colors.length);
  } else if (dColor) {
    const len = g.colors.length;
    if (!len) return;
    const ci = focusIdx.color + dColor;
    const ns = clampIdx(si + (ci < 0 ? -1 : 1), gs.length);
    if (ci < 0 || ci >= len) {
      if (ns !== si) {
        focusIdx.style = ns;
        focusIdx.color = ci < 0 ? gs[ns].colors.length - 1 : 0;
      } else {
        focusIdx.color = clampIdx(ci, len);
      }
    } else {
      focusIdx.color = ci;
    }
  }
  syncFocusEl();
}

/**
 * 数字键快选：本款用过的图案排前面（与下拉的 optgroup 同序，键位和看到的列表一致）。
 * 没选颜色就先把**光标那一格**选上 —— "按 1" 的意图是"这个色就印这朵花"，不该再要一次点击。
 */
async function quickPick(g: PodStyleGroup, n: number): Promise<void> {
  const list = [...suggestPatterns(g), ...otherPatterns(g)];
  const p = list[n - 1];
  if (!p) {
    toast(`这个款可选 ${list.length} 个图案（按 1-${Math.min(list.length, 9)}）`, 'info');
    return;
  }
  if (selStyleKey.value !== g.key || !selCount.value) {
    const chip = focusChip();
    if (!chip) return;
    if (selStyleKey.value !== g.key) selKeys.value = new Set();
    selStyleKey.value = g.key;
    selKeys.value = new Set([chip.key]);
  }
  pick[g.key] = p.id;
  await assignTo(g);
}

function onKeydown(e: KeyboardEvent): void {
  // 弹层在前：这时只认 Esc，别在遮罩上又触发一次认领
  if (preview.value.open || newFor.value || mergeOpen.value || helpOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (preview.value.open) closePreview();
      else if (helpOpen.value) helpOpen.value = false;
      else if (newFor.value) newFor.value = '';
      else closeMerge();
    }
    return;
  }
  const t = e.target as HTMLElement | null;
  // 输入框 / 下拉里一律让路（否则在"图案名"里打 n 会弹出新建表单）
  if (
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  ) {
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!styleGroups.value.length) return;
  // 人不在左栏（点了右栏的按钮等）就不抢键 —— 抢了会让"给清单点复制"变成"给颜色换款"
  const active = document.activeElement as HTMLElement | null;
  const inPanel = !!active && !!stylesEl.value?.contains(active);
  const onBody = !active || active === document.body;
  if (!inPanel && !onBody) return;

  const g = focusGroup();
  if (!g) return;

  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    const chip = focusChip();
    // 空格同时是 button 的激活键：preventDefault 后才不会既 toggle 又 click 一次
    if (chip) toggleColor(g, chip);
    syncFocusEl();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!selCount.value) {
      toast('先按空格把要认的颜色选上（可多选，同一朵花的一起选）', 'info');
      return;
    }
    void assignTo(g);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveFocus(0, -1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveFocus(0, 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    moveFocus(-1, 0);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    moveFocus(1, 0);
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openNew(g);
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    if (patterns.value.length < 2) {
      toast('只有 1 个图案，没有可合并的对象', 'info');
      return;
    }
    openMerge();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    clearSelection();
    moveFocus(1, 0);
  } else if (e.key === 'z' || e.key === 'Z') {
    // 放大看**游标那一格**的图（不是"选中的"）—— 只按 ↓ 走一圈逐一比对，不用先选上
    e.preventDefault();
    const chip = focusChip();
    if (chip) openColorPreview(g, chip);
  } else if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    void quickPick(g, Number(e.key));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearSelection();
  }
}

// 挂载期也挂一次：同一函数引用重复 addEventListener 会被去重，不会双触发；
// 这样即使将来有人把这页从 `<KeepAlive>` 里摘出去，键盘流也不会静默失效。
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onActivated(() => {
  window.addEventListener('keydown', onKeydown);
});

onDeactivated(() => {
  window.removeEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

// ── 联动 ────────────────────────────────────────────────────────────────

/** 容器在别处写操作后 +1（认图 / 到货 / 用掉都可能改变净需件） */
watch(
  () => token.value,
  () => {
    void load();
  }
);

// 款卡片换了（筛选/搜索/认领）就补缩略图；顺带把"选中集里已经不在列表上的"剔掉
watch(
  () => styleGroups.value,
  (gs) => {
    void primeThumbs(gs.flatMap((g) => g.colors.map((c) => c.imagePath)));
    const alive = new Set(gs.flatMap((g) => g.colors.map((c) => c.key)));
    const kept = [...selKeys.value].filter((k) => alive.has(k));
    if (kept.length !== selKeys.value.size) selKeys.value = new Set(kept);
    if (!gs.some((g) => g.key === selStyleKey.value)) {
      selStyleKey.value = '';
      selKeys.value = new Set();
    }
    // 键盘游标跟着新的列表收口：认完一个色它就从「只看没认的」里消失了，
    // 不 clamp 的话下一次按空格会作用在一个已经不存在的下标上（静默没反应）。
    focusIdx.style = clampIdx(focusIdx.style, gs.length);
    focusIdx.color = clampIdx(focusIdx.color, gs[focusIdx.style]?.colors.length ?? 0);
  }
);

watch(
  () => report.value.rows.map((r) => r.patternId).join(','),
  () => void primeThumbs(report.value.rows.map((r) => patternImagePath(r.patternId)))
);

onMounted(() => {
  void load();
});
</script>

<style scoped>
/* 整页三块：口径条（固定）→ 主体两栏（吃满剩余高度）→ 库存（固定，可展开）。
   两栏各自滚，页面自己不出滚动条 —— 双滚动条会让"还有多少没认"看不出来。 */
.po-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.po-view > .wb-panel {
  flex-shrink: 0;
}

/* ---- ① 口径条 ---- */
.po-top__row {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.po-nums {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.po-nums b {
  color: var(--wb-text);
  font-size: 14px;
}
.po-nums .is-danger b {
  color: var(--wb-danger);
}
.po-per {
  width: 130px;
}
.po-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.po-trust {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  font-size: 12.5px;
}
.po-trust.is-ok {
  color: var(--wb-success, #1a7f37);
}
.po-trust.is-warn {
  color: var(--wb-warning, #b26a00);
}
.po-trust.is-danger {
  color: var(--wb-danger);
}
.po-trust__cta {
  padding: 1px 8px;
  font-size: 12px;
}
.po-trunc {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--wb-warning, #b26a00);
}
.po-receipt {
  margin: 6px 0 0;
}
.po-done {
  margin: 0;
  font-size: 12.5px;
  color: var(--wb-success, #1a7f37);
  word-break: break-all;
}

/* ---- ② 主体两栏 ---- */
.po-body {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(340px, 1fr);
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
}
@media (max-width: 1080px) {
  .po-body {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }
  .po-body > .wb-panel {
    min-height: 320px;
  }
}
.po-styles,
.po-need {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.po-styles > .wb-panel__head,
.po-need > .wb-panel__head {
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
}
.po-head-sub {
  margin-left: 6px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-text-muted);
}
.po-head-sub b {
  color: var(--wb-text);
}
.po-head-sub b.is-danger {
  color: var(--wb-danger);
}
.po-styles__acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.po-search {
  width: 190px;
  height: 26px;
  font-size: 12px;
}
.po-onlywait {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
/* 问号：说明收进来的入口。做成圆钮而不是文字链，因为它跟"搜索/只看没认的"是同一排控件 */
.po-help-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 50%;
  background: var(--wb-surface-2);
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.po-help-btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.po-help-btn:focus-visible {
  outline: 2px solid var(--wb-primary);
  outline-offset: 2px;
}
.po-pad {
  padding: 14px;
}

/* ---- 款卡片 ---- */
.po-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 8px;
  align-content: start;
  overflow: auto;
  padding: 1px 2px 4px;
  min-height: 0;
  flex: 1 1 auto;
}
.po-style {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 9px 9px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  min-width: 0;
}
.po-style.has-unbound {
  border-color: var(--wb-warning, #b26a00);
}
.po-style.is-active {
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 1px var(--wb-primary-soft);
}
.po-style.is-unclassified {
  border-style: dashed;
}
.po-style__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.po-style__thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
}
.po-style__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.po-style__title {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.po-style__code {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-style__meta {
  font-size: 11px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.po-style__meta .is-danger {
  color: var(--wb-danger);
}
.po-style__pats {
  font-size: 11px;
  color: var(--wb-primary);
  font-variant-numeric: tabular-nums;
}

/* 颜色 chip：一个款色一张；已认 / 未认 / 认得不一致 三个视觉通道 */
.po-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
/* chip 与它的放大按钮的定位容器（按钮不能嵌在 button 里，见模板注释） */
.po-chip-wrap {
  position: relative;
  display: flex;
}
.po-chip__zoom {
  position: absolute;
  top: 5px;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: rgb(0 0 0 / 0.46);
  color: #fff;
  cursor: zoom-in;
  transition: background 0.12s ease;
}
.po-chip__zoom:hover {
  background: rgb(0 0 0 / 0.68);
}
.po-chip__zoom:focus-visible {
  outline: 2px solid var(--wb-primary);
  outline-offset: 1px;
}
.po-chip {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 92px;
  padding: 4px 5px 5px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.12s ease,
    background 0.12s ease;
}
.po-chip:hover {
  border-color: var(--wb-border-strong);
}
.po-chip.is-unbound {
  border-style: dashed;
  border-color: var(--wb-warning, #b26a00);
}
.po-chip.is-sel {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.po-chip.is-conflict {
  box-shadow: inset 0 -2px 0 var(--wb-danger);
}
.po-chip__thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 56px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--wb-surface);
}
.po-chip__thumb img {
  width: 100%;
  height: 100%;
  /* contain 不是为了好看：`cover` 会把方图上下各切掉三成，一朵花的花瓣正好落在切口上 ——
     用户就是照着这张图判断"两个色是不是同一朵花"，裁掉就没法判断（2026-11-03 改） */
  object-fit: contain;
  cursor: zoom-in;
}
.po-chip__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
}
.po-chip__name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-chip__qty {
  font-size: 10.5px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.po-chip__pat {
  font-size: 10.5px;
  color: var(--wb-primary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-chip.is-unbound .po-chip__pat {
  color: var(--wb-warning, #b26a00);
  font-weight: 400;
}
.po-chip__warn {
  margin-left: 4px;
  color: var(--wb-danger);
  font-weight: 400;
}

/* 选中后的操作条 */
.po-pick {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
}
.po-pick__hint {
  flex: 1 1 100%;
  font-size: 11.5px;
  color: var(--wb-text);
}
.po-pick__sel {
  min-width: 150px;
  max-width: 210px;
}
.po-pick__cancel {
  margin-left: auto;
}
.po-pick__note {
  flex: 1 1 100%;
  margin: 0;
  font-size: 11px;
  color: var(--wb-warning, #b26a00);
}
.po-save {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
  font-size: 11.5px;
}
.po-new {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
}
.po-new__title {
  flex: 1 1 100%;
  font-size: 11.5px;
  font-weight: 600;
}
.po-new__code {
  width: 84px;
}
.po-new__name {
  width: 130px;
}

/* ---- 右：清单 ---- */
.po-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.po-table-wrap .wb-table th,
.po-table-wrap .wb-table td {
  padding: 5px 8px;
  vertical-align: middle;
}
.po-col-img {
  width: 52px;
}
.po-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface-2);
  cursor: zoom-in;
  overflow: hidden;
}
.po-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.po-col-pat {
  min-width: 0;
}
.po-pat__code {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12.5px;
  min-width: 0;
}
.po-pat__name {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-pat__nums {
  font-size: 11px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.po-pat__styles {
  font-size: 10.5px;
  color: var(--wb-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-col-num {
  width: 76px;
  text-align: right;
}
.po-net {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-primary);
  font-variant-numeric: tabular-nums;
}
.po-sheets-line {
  font-size: 11px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.po-sheets {
  font-weight: 600;
  color: var(--wb-text);
}
.po-col-art {
  width: 82px;
}
.po-art__ok {
  cursor: zoom-in;
}
.po-art__add {
  padding: 1px 7px;
  font-size: 11.5px;
  color: var(--wb-warning, #b26a00);
  border-color: var(--wb-warning, #b26a00);
}
.po-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
}
.po-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 3px;
  text-align: center;
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--wb-text-muted);
}

/* ---- ③ 库存 ---- */
.po-stock.is-open {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 46%;
}
.po-stock__toggle {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 12px;
}
.po-stock__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow: auto;
  padding-top: 6px;
}
.po-stock__act {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.po-stock__label {
  min-width: 70px;
  font-size: 12.5px;
  font-weight: 600;
}
.po-num {
  width: 82px;
}
.po-supplier {
  width: 130px;
}
.po-batches {
  max-height: 200px;
}
.po-remain {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.po-remain.is-empty {
  color: var(--wb-danger);
}
.po-remain.is-low {
  color: var(--wb-warning, #b26a00);
}
.po-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.po-opbtn {
  padding: 1px 8px;
  font-size: 12px;
}

/* ---- 弹层 ---- */
.po-viewer {
  width: min(760px, 92vw);
}
.po-viewer__body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
.po-viewer__body img {
  max-width: 100%;
  max-height: 62vh;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  object-fit: contain;
}
/* 原尺寸：花蕊、色差、布纹这些细节只有在 1:1 下才看得见。
   放大后**不再缩放**、容器滚动 —— 别用 CSS zoom 放大位图，那是插值糊，等于没放大。 */
.po-viewer__body.is-zoom {
  display: block;
  overflow: auto;
  max-height: 68vh;
  text-align: left;
}
.po-viewer__body.is-zoom img {
  max-width: none;
  max-height: none;
  cursor: zoom-out;
}
.po-viewer__body img.is-zoomable {
  cursor: zoom-in;
}
.po-help {
  width: min(520px, 92vw);
}
.po-help__body h4 {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text);
}
.po-help__body h4:not(:first-child) {
  margin-top: 14px;
}
.po-help__body p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}
.po-help__keys {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.po-help__row {
  display: grid;
  grid-template-columns: 92px 1fr;
  align-items: center;
  gap: 10px;
}
.po-help__key {
  display: flex;
  gap: 2px;
}
.po-help__keys kbd,
.po-help__body p kbd {
  display: inline-block;
  min-width: 16px;
  padding: 0 4px;
  border: 1px solid var(--wb-border);
  border-bottom-width: 2px;
  border-radius: 3px;
  background: var(--wb-surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  line-height: 15px;
  text-align: center;
  color: var(--wb-text);
}
.po-help__keys span {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.po-merge {
  width: min(760px, 94vw);
}
.po-merge__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.po-merge__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 34vh;
  overflow: auto;
}
.po-merge__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.po-merge__item.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.po-merge__check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 1px solid var(--wb-border-strong);
  border-radius: 3px;
  background: var(--wb-surface);
}
.po-merge__item.is-on .po-merge__check {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  box-shadow: inset 0 0 0 2px var(--wb-surface);
}
.po-merge__hist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--wb-border);
  padding-top: 8px;
}
.po-merge__hrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.po-merge__err {
  flex: 1 1 100%;
  margin: 0 0 6px;
}
</style>
