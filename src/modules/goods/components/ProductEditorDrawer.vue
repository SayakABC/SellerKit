<template>
  <div class="wb-mask ed-mask" @click.self="requestClose()">
    <aside class="wb-drawer ed-drawer" role="dialog" aria-modal="true" aria-label="产品编辑">
      <!-- ── 头部：身份一眼可见（编码 + 保存模型徽标）────────────────────────
           保存模型**必须一句话说清**（UX-G3）：编辑模式是"离开输入框就写库"，不说明的话
           用户会继续找那个已经不存在的「保存」按钮。这里压成一枚徽标（title 里放全文），
           正文不再用一整段说明去解释自己 —— 那一段本身就是"看着乱"的来源之一。 -->
      <div class="wb-dialog__head ed-head">
        <span class="ed-head__title">{{ isEdit ? '编辑产品' : '新增产品' }}</span>
        <span v-if="isEdit" class="wb-mono ed-head__code">{{ form.code }}</span>
        <span
          v-if="isEdit"
          class="ed-chip"
          data-act="ed-autosave-hint"
          title="表单字段离开输入框就写库，底部只剩一个「完成」。SKU 矩阵不自动存（一次可能改几十格），改完按底部的「完成」一并保存。"
        >
          边改边存
        </span>
        <button class="ed-x" type="button" aria-label="关闭" @click="requestClose()">✕</button>
      </div>

      <!-- 两栏：左 = 档案字段（窄、固定），右 = SKU 工作区（宽、吃满剩余高度）。
           为什么不再单列到底：单列时 SKU 矩阵被压到 560px 宽、40vh 高，还要滚过 8 个字段
           才看得到它 —— 用户口径「页面太杂乱、SKU 编辑不方便」。两栏让字段与 SKU
           各占一栏、互不挤占：字段不用滚，矩阵拿到全部剩余宽高。 -->
      <div class="wb-dialog__body ed-body" :class="{ 'ed-body--create': !isEdit }">
        <div class="ed-col">
          <!-- 主图：窄接口立即保存（不等底部「完成」） -->
          <section class="ed-sec">
            <h4 class="ed-sec__title">主图</h4>
            <div v-if="isEdit" class="ed-img">
              <img v-if="imgUrl" :src="imgUrl" class="ed-img__pic" alt="主图" />
              <div v-else class="ed-img__empty">暂无主图</div>
              <div class="ed-img__ops">
                <button class="wb-btn wb-btn--sm" type="button" :disabled="imgBusy" @click="pickImage">
                  {{ imgBusy ? '处理中…' : imgUrl ? '更换' : '上传主图' }}
                </button>
                <button
                  v-if="imgUrl"
                  class="wb-btn wb-btn--sm"
                  type="button"
                  :disabled="imgBusy"
                  @click="removeImage"
                >
                  移除
                </button>
              </div>
            </div>
            <p v-else class="wb-field__hint">先保存产品，才能上传主图与维护 SKU。</p>
          </section>

          <section class="ed-sec">
            <h4 class="ed-sec__title">基本信息</h4>
            <label class="wb-field">
              <span class="wb-field__label">
                款编码 <i class="wb-field__req">*</i>
                <span v-if="isEdit" class="ed-tag" title="编码是订单 / 采购 / 成本三域的关联锚点，改了会让历史数据指向另一个产品">
                  不可改
                </span>
              </span>
              <!-- 编辑时只读：编码是订单 / 采购 / 成本三域的关联锚点 —— 改这里会让历史数据
                   指向另一个产品。为什么不写成一行说明：这一屏已经有一枚「不可改」标签，
                   想追问的人悬停标签即可（2026-10-24 用户口径「文字也太多了」）。 -->
              <input
                v-model="form.code"
                class="wb-input"
                data-act="ed-code"
                :readonly="isEdit"
                :class="{ 'is-readonly': isEdit }"
                placeholder="例：STYLE-001"
              />
            </label>

            <label class="wb-field">
              <span class="wb-field__label">款式名</span>
              <input
                v-model="form.name"
                class="wb-input"
                data-act="ed-name"
                placeholder="例：折叠收纳箱 60L"
                @blur="autoSave"
              />
            </label>

            <div class="ed-pair">
              <label class="wb-field">
                <span class="wb-field__label">供应商</span>
                <select v-model="form.supplierId" class="wb-input" data-act="ed-supplier" @change="autoSave">
                  <option :value="0">未关联</option>
                  <option v-for="s in suppliers" :key="s.id" :value="s.id">
                    {{ s.name || `#${s.id}` }}{{ s.productCount ? `（${s.productCount}）` : '' }}
                  </option>
                </select>
              </label>

              <label class="wb-field">
                <span class="wb-field__label">类目</span>
                <input
                  v-model="form.category"
                  class="wb-input"
                  data-act="ed-category"
                  placeholder="例：家居收纳"
                  @blur="autoSave"
                />
              </label>
            </div>
            <span v-if="!suppliers.length" class="wb-field__hint">
              还没有供应商 —— 到「供应商」页签新增，这里只做关联。
            </span>
          </section>

          <section class="ed-sec">
            <h4 class="ed-sec__title">价格与状态</h4>
            <div class="ed-pair">
              <label class="wb-field" title="产品级的**当前**采购价。历史订单按各自导入/拿货当时的价结算，改这里不会改动它们">
                <span class="wb-field__label">进价（元）</span>
                <input
                  v-model="form.costYuan"
                  class="wb-input"
                  data-act="ed-cost"
                  inputmode="decimal"
                  placeholder="选填"
                  @blur="autoSave"
                />
              </label>

              <label class="wb-field">
                <span class="wb-field__label">状态</span>
                <select v-model="form.status" class="wb-input" @change="autoSave">
                  <option value="active">启用</option>
                  <option value="archived">停用</option>
                </select>
              </label>
            </div>
          </section>

          <section class="ed-sec">
            <h4 class="ed-sec__title">备注</h4>
            <textarea v-model="form.note" class="wb-input" rows="3" placeholder="选填" @blur="autoSave"></textarea>
          </section>

          <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>
        </div>

        <!-- SKU 矩阵：产品 SKU 的唯一维护面（色 × 码；格 = 在不在卖 + 克重）。
             采集段只认款、不再改 SKU；矩阵的初始内容可以从采集商品导入，
             但**落库之后**这里就是唯一真相 —— 外面不再有第二份可写的 SKU。 -->
        <div v-if="isEdit" class="ed-main" data-act="ed-sku-block">
          <!-- 工具条吸顶：保存按钮**永远在视野里**（矩阵可以几千像素高，按钮不许被滚走） -->
          <div class="ed-main__bar">
            <span class="ed-main__title">SKU</span>
            <span class="ed-main__sub wb-muted">颜色 × 尺码</span>
            <div class="ed-main__ops">
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="ed-import-open"
                :disabled="skuBusy || skuLoading || importBusy"
                @click="toggleImport"
              >
                {{ importOpen ? '收起' : '从采集商品导入' }}
              </button>
              <!-- SKU 的保存**只有一个入口：底部「完成」**（2026-10-25 用户口径
                   「保存按钮和完成按钮合并，放在完成上」）。
                   这里留的是**状态**而不是第二个保存按钮：脏时它说"有 5 处待保存"，
                   点一下等于"先存一下、别关"（中途想落库的人仍有出口，但它不再是一个
                   与「完成」并列、要人自己决定点哪个的按钮）。 -->
              <button
                class="ed-main__state"
                :class="{ 'is-dirty': matrixDirty }"
                type="button"
                data-act="ed-sku-save"
                :data-dirty="matrixDirty ? '1' : '0'"
                :disabled="skuBusy || !matrixDirty"
                :title="
                  matrixDirty
                    ? `还有 ${dirtyCount} 处改动没落库 —— 按「完成」会一并保存；想先存一下不关就点这里`
                    : 'SKU 与库里一致'
                "
                @click="saveMatrix"
              >
                {{
                  skuBusy ? '保存中…' : matrixDirty ? `有 ${dirtyCount} 处待保存` : 'SKU 已保存'
                }}
              </button>
            </div>
          </div>

          <!-- 从采集商品导入：产品 SKU 的**来源**是采集快照（2026-10-23）。
               只补缺口 —— 已有的组合、已填的克重、SKU 编码一个都不动；导入后仍要按上面的
               「完成」才落库（这一步只改界面上的矩阵）。 -->
          <section v-if="importOpen" class="ed-import" data-act="ed-import-panel">
            <div v-if="importLoading" class="wb-field__hint">正在读取这款关联的采集商品…</div>
            <div v-else-if="importError" class="wb-notice wb-notice--error ed-import__error">
              <span>{{ importError }}</span>
              <button class="wb-btn wb-btn--sm" type="button" data-act="ed-import-retry" @click="loadImportCandidates">
                重试
              </button>
            </div>
            <p v-else-if="!importCandidates.length" class="wb-field__hint" data-act="ed-import-empty">
              {{
                importRows.length
                  ? '这款关联的采集商品还没采到 SKU —— 到商品详情页用「采 SKU」采一次（列表页只采到标题/图/价）。'
                  : '还没有采集商品认到这款 —— 先到「待关联采集商品」段认款，或直接在矩阵里手动加颜色/尺码。'
              }}
            </p>
            <template v-else>
              <p class="ed-import__hint">
                选一条采集商品并进来 —— <b>只补缺口</b>，已有组合与克重不动。
              </p>
              <div class="ed-import__list">
                <button
                  v-for="c in importCandidates"
                  :key="c.row.id"
                  class="ed-import__item"
                  :class="{ 'is-active': c.row.id === importSelectedId }"
                  type="button"
                  data-act="ed-import-item"
                  :data-item-id="c.row.itemId"
                  @click="importSelectedId = c.row.id"
                >
                  <span class="ed-import__radio">{{ c.row.id === importSelectedId ? '●' : '○' }}</span>
                  <span class="ed-import__item-main">
                    <span class="ed-import__item-id wb-mono" :title="c.row.itemId">{{ c.row.itemId }}</span>
                    <span class="ed-import__item-meta">
                      {{ c.row.shopName || c.row.storeKey || '未登记店铺' }} · {{ c.comboCount }} 个组合（{{
                        c.colorCount
                      }} 色 × {{ c.sizeCount }} 码）
                    </span>
                  </span>
                  <span v-if="!c.comboCount" class="wb-muted ed-import__item-note">没采到 SKU</span>
                </button>
              </div>
              <p v-if="importPreview" class="ed-import__preview" data-act="ed-import-preview">
                将并入：新增 <b>{{ importPreview.stats.addedColors }}</b> 色 · 新增
                <b>{{ importPreview.stats.addedSizes }}</b> 个尺码 · <b>{{ importPreview.stats.addedCells }}</b>
                个组合，补 <b>{{ importPreview.stats.filledWeights }}</b> 格克重<template
                  v-if="importPreview.stats.skipped"
                  >；跳过 {{ importPreview.stats.skipped }} 条缺色/缺码</template
                >。
                <span v-if="!importCanApply">这份采集已经在矩阵里了 —— 没有可导入的内容。</span>
              </p>
              <div class="ed-import__ops">
                <button
                  class="wb-btn wb-btn--sm wb-btn--primary"
                  type="button"
                  data-act="ed-import-apply"
                  :disabled="importBusy || !importCanApply"
                  @click="applyImport"
                >
                  {{ importBusy ? '导入中…' : '并入矩阵' }}
                </button>
              </div>
            </template>
          </section>
          <p v-if="importHint" class="wb-notice ed-import__done" data-act="ed-import-hint">{{ importHint }}</p>

          <div v-if="skuLoading" class="wb-field__hint">SKU 读取中…</div>
          <template v-else>
            <SkuMatrixEditor
              v-model="matrix"
              act="ed"
              fill-height
              :disabled="skuBusy"
              :copy="MATRIX_COPY"
              :empty-hint="MATRIX_EMPTY_HINT"
              :resolve-viewer-image="resolveViewerImage"
            />

            <!-- SKU 编码：矩阵不显示编码（0/64 字符、全员为空时占了半屏），但它是既有能力，
                 不能因为"表里不画了"就失去维护入口。改动随矩阵一起保存。 -->
            <details
              v-if="variants.length"
              class="ed-codes"
              data-act="ed-codes"
              @toggle="onCodesToggle"
            >
              <summary title="非空时全库唯一；改动随底部的「完成」一起落库">
                SKU 编码<span class="wb-muted">（可选）</span>
              </summary>

              <!-- 规则 + 一键生成（2026-10-25）。放在列表**上面**：先定规则再生成，
                   而不是让人一条一条打完之后才发现有更快的办法。 -->
              <div class="ed-coderule" data-act="ed-code-rule-box">
                <span class="ed-coderule__k">规则</span>
                <input
                  v-model="codeRule"
                  class="wb-input ed-coderule__input"
                  type="text"
                  spellcheck="false"
                  :disabled="skuBusy"
                  data-act="ed-code-rule"
                  aria-label="SKU 编码规则"
                  :placeholder="DEFAULT_SKU_CODE_RULE"
                  title="用占位符拼：{code} 款号 · {color} 颜色 · {size} 尺码 · {index} 序号"
                  @change="persistCodeRule"
                  @blur="persistCodeRule"
                />
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="ed-code-gen"
                  :disabled="skuBusy || !codeSeeds.length"
                  title="按规则生成编码——只填空着的，已有编码不动"
                  @click="applyCodeRule('empty')"
                >
                  一键生成
                </button>
                <button
                  class="wb-link wb-link--danger ed-coderule__all"
                  type="button"
                  data-act="ed-code-gen-all"
                  :disabled="skuBusy || !codeSeeds.length"
                  title="按规则重写**所有**编码（含已经填过的）"
                  @click="applyCodeRule('all')"
                >
                  全部重写
                </button>
              </div>
              <p class="ed-coderule__hint wb-muted">
                可用
                <b v-for="t in SKU_CODE_TOKENS" :key="t.key">{{ t.key }}</b>
                （{{ SKU_CODE_TOKENS.map((t) => t.label).join(' / ') }}）
                <span v-if="codeRulePreview" class="ed-coderule__preview" data-act="ed-code-preview">
                  · 例：<b class="wb-mono">{{ codeRulePreview }}</b>
                </span>
              </p>

              <div class="ed-codes__list">
                <label v-for="v in variants" :key="`code-${v.id}`" class="ed-codes__row">
                  <span v-if="isLegacyVariant(v)" class="ed-tag" :title="`历史 SKU，原名称：${v.name}`">旧</span>
                  <span class="ed-codes__name" :title="v.name">{{ v.name }}</span>
                  <input
                    v-model="codeDraft[v.id]"
                    class="wb-input ed-codes__input"
                    placeholder="编码（可空）"
                    :disabled="skuBusy"
                    :aria-label="`${v.name} 的 SKU 编码`"
                  />
                </label>
              </div>
            </details>

            <!-- 老数据：只有自由文本名称、没有颜色/尺码。矩阵装不下它们（颜色尺码必须成对），
                 所以单独列出来 —— 能删，不静默丢掉。 -->
            <section v-if="legacyVariants.length" class="ed-legacy" data-act="ed-legacy">
              <p class="ed-legacy__hint">
                这 {{ legacyVariants.length }} 条<b>只有名称</b>、没有颜色/尺码，不进上面的矩阵 —— 没用就删掉。
              </p>
              <div v-for="v in legacyVariants" :key="`legacy-${v.id}`" class="ed-legacy__row" data-act="ed-legacy-row">
                <span class="ed-tag">旧</span>
                <span class="ed-legacy__name" :title="v.name">{{ v.name }}</span>
                <span class="wb-muted ed-legacy__code">{{ codeDraft[v.id] || '无编码' }}</span>
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="ed-legacy-del"
                  :disabled="skuBusy"
                  @click="askDeleteLegacy(v)"
                >
                  删除
                </button>
              </div>
            </section>
          </template>
        </div>
      </div>

      <div class="wb-dialog__foot">
        <!-- 页脚那行小字把两个问题一次答完：**存了没有**（`savedHint`）与
             **关掉会丢什么**（`closeGuard`）。后者必须常显而不是只在点了 ✕ 之后才说 ——
             "还有 3 处改动没保存"本身就是"别急着关"的提示。 -->
        <span v-if="savedHint" class="wb-muted ed-hint" data-act="ed-saved-hint">{{ savedHint }}</span>
        <span v-else-if="closeGuard" class="wb-muted ed-hint" data-act="ed-guard-hint">{{ closeGuard }}</span>
        <!-- ⚠️ 编辑模式**不再给「取消」**：改动已经边改边存，它已经没有可取消的东西了。
             再留一个「取消」，用户会以为那是"撤销我刚才的修改" —— 而它做不到（UX-G3）。
             新增模式仍是「取消 / 保存」：那时确实有一个还没创建的草稿可以取消。 -->
        <button v-if="!isEdit" class="wb-btn" type="button" :disabled="saving" @click="requestClose()">
          取消
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          :disabled="saving || skuBusy || (!isEdit && !form.code.trim())"
          :title="
            isEdit && matrixDirty
              ? `完成 = 保存并关闭（还有 ${dirtyCount} 处 SKU 改动会一起落库）`
              : undefined
          "
          @click="isEdit ? complete() : save()"
        >
          {{ saving || skuBusy ? '保存中…' : isEdit ? '完成' : '保存' }}
        </button>
        <!-- ⭐ 款级删除（2026-10-25 · P2/S4）：左栏行展开区撤掉之后，"删掉这个款"必须有新家，
             否则撤展开就不是"减负"而是**丢能力**（抽屉原先只有失效 SKU 的删除，没有删款）。
             放在**最右且独立**的位置：它不是这条页脚的常规动作（常规动作是「完成」），
             而且必须隔开 —— 紧贴主按钮的话，连点两下就会删掉一个款。 -->
        <button
          v-if="isEdit"
          class="wb-btn wb-btn--danger ed-foot__del"
          type="button"
          data-act="ed-delete-product"
          :disabled="saving || skuBusy"
          @click="confirmDel = true"
        >
          删除这款
        </button>
      </div>
    </aside>

    <!-- 关闭确认（W1）：只有"真的会丢"的两类才走到这里，见 `closeGuard` 的说明。 -->
    <ConfirmDialog
      v-if="confirmDiscard"
      title="关掉就会丢掉这些"
      confirm-text="放弃改动并关闭"
      @close="confirmDiscard = false"
      @confirm="discardAndClose"
    >
      <p>{{ closeGuard }} —— 关掉抽屉就没有了。</p>
      <p v-if="dirtyCount">按底部的「完成」会一并保存；直接关掉就丢了。</p>
    </ConfirmDialog>

    <!-- 款级删除的二次确认：文案与左栏行内那个删除（已随展开区撤掉）**逐字一致** ——
         同一个动作在两处出现时，说明"会发生什么"的话不能有两种版本。 -->
    <ConfirmDialog
      v-if="confirmDel"
      title="确认删除"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="deleting"
      @close="confirmDel = false"
      @confirm="doDelete"
    >
      <p>
        将删除产品
        <b class="wb-mono">{{ form.code }}</b>{{ form.name ? `（${form.name}）` : '' }}。
      </p>
      <p class="wb-notice wb-notice--warn">
        删除是物理删除且不可撤销。已进入订单 / 采购 / 成本链路的款请改用「停用」——
        编码是跨域关联的锚点，删掉会让历史数据指向空。
      </p>
    </ConfirmDialog>

    <!-- 矩阵里取消掉的组合 = 真的删除这些 SKU：删除是物理的，必须先说清删哪些。
         2026-10-25 加第三个出口「保留这几个」：用户实报"克重都填好了，保存还说这 3 个会被删"——
         那几格多半是误点列头（整列取消）掉的。只给"删除 / 取消"时他只能整轮重来。 -->
    <ConfirmDialog
      v-if="pendingSkuPlan"
      title="这些组合在矩阵里没有勾选"
      confirm-text="删除并保存"
      busy-text="保存中…"
      :busy="skuBusy"
      :extra-text="`保留这 ${pendingSkuPlan.deletes.length} 个`"
      @close="dismissSkuPlan"
      @confirm="confirmSkuSave"
      @extra="keepDeletedCells"
    >
      <p>
        库里有这 <b>{{ pendingSkuPlan.deletes.length }}</b> 个 SKU，矩阵里却没有勾选 ——
        保存会把它们<b>删掉</b>：
      </p>
      <p class="ed-del-list wb-mono">{{ pendingSkuPlan.deletes.map((v) => v.name).join('、') }}</p>
      <p class="ed-del-note">
        本来没打算删（比如刚点到了尺码列头 = 整列取消）？按
        <b>「保留这 {{ pendingSkuPlan.deletes.length }} 个」</b>把它们连同原克重加回矩阵，核对后再按「完成」。
      </p>
      <p class="ed-del-note">只删这个款的 SKU 档案。历史订单 / 拿货单里已经记下的颜色、尺码文字不受影响。</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="pendingLegacy"
      title="删除历史 SKU"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="skuBusy"
      @close="pendingLegacy = null"
      @confirm="confirmDeleteLegacy"
    >
      <p>将删除 <b class="wb-mono">{{ pendingLegacy.name }}</b>（没有颜色/尺码的老数据）。</p>
      <p class="ed-del-note">只删这个 SKU 档案；历史订单 / 拿货单里的文字不受影响。</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 产品编辑抽屉。
//
// ⭐ 版式（2026-10-24 重设计，用户口径「页面太杂乱，SKU 的编辑也很不方便」）：
//   从"560px 单列滚到底"改成**整窗高两栏** —— 左栏 320px 放档案字段（主图 / 基本信息 /
//   价格与状态 / 备注，分节不套框），右栏吃满剩余宽高放 SKU 工作区（吸顶工具条 + 规格 + 矩阵）。
//   两条都要：
//     · 单列时 SKU 矩阵被挤在 560px 宽、40vh 高里（行头 168 + 每列 96 ⇒ 一屏只看得到三列），
//       而且要先滚过 8 个字段才看得到它 —— 这两件事叠起来就是"不方便"的全部；
//     · 字段并不需要 900px 宽（宽了只是把输入框拉长），把它挪到窄栏反而读得更快。
//   抽屉宽度 1040（≤94vw）：仍然让列表露出可见的一条，抽屉的初衷（改的时候对照列表）没变。
//   两栏各自滚动 ⇒ 改 SKU 的时候字段不会跟着跑掉，反之亦然。
//
// 为什么是**右侧抽屉**而不是居中弹窗：改的同时经常要回头看列表里的其它款（对照编码、
// 看还有哪些缺克重）。居中弹窗会把列表整个盖住。
//
// ⭐ 保存模型（2026-10-08 R2 · UX-G3）：**表单字段统一即时保存**。
//   旧模型是"一半一半"（主图 / SKU 即时存，表单要按底部「保存」），于是"填了名字直接点 ✕"
//   就是**没保存**，而「取消」不提示就关了 —— 真机走查实测：用户以为存了，其实没有。现在：
//     · 编辑模式：表单字段**离开输入框就写库**（`@blur` / `@change` → `autoSave`），
//       底部主按钮从「保存」改成「完成」（把还没落库的改动冲掉再关）；
//     · "边改边存"压成头部的徽标（正文不再用一整段说明解释自己，全文在 title 里）；
//     · 关闭（✕ / 遮罩 / 完成）统一走 `requestClose()` —— 有**真的**会丢的东西时先确认（W1）；
//     · 新增模式没有 id 可写，"即时保存"无从谈起 ⇒ 保持显式「保存」（= 创建并关闭）。
//
// ⭐ SKU 的模型（2026-10-23，与"采集段只认款"同轮）：产品只维护**一套** SKU ——
//   就是这一屏的色 × 码矩阵。它仍**显式保存**（一次可能改几十格，逐格 blur 存会变成几十次写 +
//   几十次重拉），代价（改了没存就关）由 `closeGuard` 兜住。
//   矩阵与 `pl_variants` 的对应关系：
//     · 格 = 一个 SKU（颜色 + 尺码 + 克重）；空格 = 这个组合不存在；
//     · 色名 / 码名改名 = **在原 SKU 上改**（格子里带着 `variantId`，编码与状态跟着走），
//       不是"删旧建新"——后者会静默丢掉 SKU 编码；
//     · 取消一个格 = 删除那条 SKU（保存前弹确认，列出要删的组合）。
//   老数据（只有名称、没有颜色/尺码）装不进矩阵，单独列在下面：能删，不静默丢。
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { pickImage as selectImageFile } from '../productIo';
// 克重的术语解释在这里（而不是左栏展开区）：2026-10-09 起，克重的**唯一编辑处**就是这一屏 ——
// 术语说明跟着它走，展开区只留一句"要改去点编辑"。
import { gloss } from '../glossary';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import SkuMatrixEditor from './SkuMatrixEditor.vue';
import { toast } from '@/core/services/toast';
import {
  mergeSkuMatrix,
  normWeightG,
  parseSkuJsonRows,
  skuMatrixComboCount,
  toSkuMatrix,
  type MergeSkuStats,
  type SkuMatrix,
  type SkuMatrixRow,
} from '@/lib/skuMatrix';
import {
  buildSkuCodes,
  DEFAULT_SKU_CODE_RULE,
  renderSkuCode,
  ruleHasToken,
  SKU_CODE_TOKENS,
  type SkuCodeSeed,
} from '@/lib/skuCode';
import type { ProductListItem, ProductStatus, ShopItemRow, VariantRow } from '@/types';

interface SupplierOption {
  id: number;
  name: string;
  productCount: number;
}

const props = defineProps<{
  /** null = 新增 */
  product: ProductListItem | null;
  suppliers: SupplierOption[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [result: unknown, opts?: { keepOpen?: boolean }];
  /**
   * 这个款已经被删掉了（物理删除，`api.remove` 成功）。
   *
   * 为什么要在抽屉里删、再把这个信号递出去：左栏的行展开区撤掉之后，"删掉这个款"
   * 需要有新家（原先只有展开区里有），而删除的后果（刷新列表、当前款失效）只有父组件知道。
   * 抽屉自己不刷新列表、也不去动 `currentProduct` —— 它只报"删掉了哪一个"。
   */
  deleted: [id: number];
}>();

/* ---- 款级删除（P2 · S4）---------------------------------------------- */
const confirmDel = ref(false);
const deleting = ref(false);

/**
 * 真的删。
 *
 * ⚠️ 走 `api.remove`（与左栏批量删除**同一条**通道）：两处删除各写一套 SQL 的话，
 * "删掉一个已被映射引用的款"在一边会失败、在另一边会静默成功，用户看到的就是
 * "有时删得掉、有时删不掉"。
 * ⚠️ 判据只看 `deleted`：拿 HTTP 成功当删除成功，会在"款被外键挡住"时给一句"已删除"。
 */
async function doDelete(): Promise<void> {
  const id = props.product?.id ?? 0;
  if (!id) return;
  deleting.value = true;
  try {
    const r = await api.remove(id);
    if (r?.deleted) {
      confirmDel.value = false;
      emit('deleted', id);
      return;
    }
    error.value = '这个款没有被删掉（可能仍被订单 / 采购 / 成本链路引用 —— 请改用「停用」）';
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    deleting.value = false;
  }
}

/** 产品矩阵给共享组件的文案覆盖（默认文案是采集快照口径，见 `SkuMatrixEditor`） */
const MATRIX_COPY = {
  sizeEmptyHint: '还没有尺码 —— 点「＋ 尺码」或「常用」；只有一个维度的款请用「均码」。',
  weightHint: gloss('weight'),
  imageLabel: '款色图',
  imageNote: '这张图来自订单域该款色的代表图，只作显示 —— 改色名不会改这张图，保存也不会把它写成 SKU 图。',
};

const MATRIX_EMPTY_HINT = '这款还没有 SKU —— 先加一色、再加一码；表里勾上的就是这款在卖的组合。';

const isEdit = computed(() => !!props.product?.id);
const saving = ref(false);
const error = ref('');

const form = reactive({
  id: props.product?.id ?? 0,
  code: props.product?.code ?? '',
  name: props.product?.name ?? '',
  supplierId: props.product?.supplierId ?? 0,
  category: props.product?.category ?? '',
  status: (props.product?.status === 'archived' ? 'archived' : 'active') as 'active' | 'archived',
  note: props.product?.note ?? '',
  /** 进价（**元**，输入框原样字符串；落库转分）。空串 = 未填 → 落 0 */
  costYuan: props.product?.costCents ? (props.product.costCents / 100).toFixed(2) : '',
});

/** 元 → 分（整数）。空串/认不出 → 0（"没填"与"填 0"在本字段同义：都没价） */
function costYuanToCents(v: string): number {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/* ---- 保存模型：快照 / 自动保存 / 关闭守卫（UX-G3 + W1）---- */

interface SaveOpts {
  /** 不关抽屉 —— 即时保存都带它（主图 / 字段自动保存同理） */
  keepOpen?: boolean;
  /** 不弹 toast，改在页脚显示一行小字（逐字段自动保存时每存一次弹一个 toast 会刷屏） */
  silent?: boolean;
}

/** 表单的**已落库快照**（字段与 `api.upsert` 的载荷同口径：文本 trim、id 归一为数字） */
function snapshot() {
  return {
    name: form.name.trim(),
    supplierId: Number(form.supplierId) || 0,
    category: form.category.trim(),
    status: form.status,
    note: form.note,
    costCents: costYuanToCents(form.costYuan),
  };
}

const lastSaved = ref(snapshot());
const formDirty = computed(() => {
  const s = snapshot();
  const l = lastSaved.value;
  return (
    s.name !== l.name ||
    s.supplierId !== l.supplierId ||
    s.category !== l.category ||
    s.status !== l.status ||
    s.note !== l.note ||
    s.costCents !== l.costCents
  );
});

/** 正在飞的那条表单保存（同一条复用，不并发写同一行） */
let flying: Promise<boolean> | null = null;

const savedHint = ref('');
let hintTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved(text: string): void {
  savedHint.value = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    savedHint.value = '';
  }, 2500);
}

async function save(opts: SaveOpts = {}): Promise<boolean> {
  // 同一条表单保存**至多一条在飞**：`blur` 与「完成」可能在同一帧撞上，
  // 不串起来就会对同一行写两遍（第二遍的成功 toast 盖掉第一遍的失败）。
  if (flying) return flying;
  flying = doSave(opts).finally(() => {
    flying = null;
  });
  return flying;
}

async function doSave(opts: SaveOpts): Promise<boolean> {
  const code = form.code.trim();
  if (!code) {
    error.value = '款编码不能为空';
    return false;
  }
  saving.value = true;
  error.value = '';
  try {
    const r = await api.upsert({
      id: form.id || 0,
      code,
      name: form.name.trim(),
      supplierId: Number(form.supplierId) || 0,
      category: form.category.trim(),
      status: form.status,
      note: form.note,
      // 进价：抽屉里这一栏是"当前价"的维护入口，恒传（清空 = 显式清零）
      costCents: costYuanToCents(form.costYuan),
    });
    // 快照跟着更新：`formDirty` 的判据是"与已落库的值比"，不是"按过按钮没有"
    lastSaved.value = snapshot();
    if (opts.silent) flashSaved('已自动保存');
    else toast(r?.created ? `已新增 ${code}` : `已更新 ${code}`, 'success');
    emit('saved', r, opts.keepOpen ? { keepOpen: true } : undefined);
    return true;
  } catch (e: unknown) {
    // 编码冲突这类错误必须留在表单里可见（toast 一闪而过，用户还要照着改）
    error.value = e instanceof Error ? e.message : String(e);
    if (opts.silent) toast(error.value, 'error');
    return false;
  } finally {
    saving.value = false;
  }
}

/**
 * 字段**离开即存**（编辑模式）。
 *
 * 判据是 `formDirty`（与已落库快照比），所以"点进来又原样离开"不会白白写一次库。
 * 新增模式直接返回：没有 id 可写（见文件头的保存模型说明）。
 */
async function autoSave(): Promise<void> {
  if (!isEdit.value || !formDirty.value) return;
  await save({ keepOpen: true, silent: true });
}

/**
 * 编辑模式的「完成」：把还没落库的东西**全部**冲掉，然后关。
 *
 * 2026-10-25 起 SKU 矩阵也走这里（用户口径：「保存按钮和完成按钮合并，放在完成上」）——
 * 原来的模型是"左边的字段边改边存、右边的矩阵要单独按一个按钮"，于是填完 40 格克重
 * 还得去工具条找那个按钮，找不到就直接关 → 又被"还有 38 处没保存"拦一次。
 *
 * 顺序：先等 blur 触发的 `autoSave` 落地（同一个字段写两次锁），再存矩阵。
 * 矩阵有**删除**时弹确认（`saveMatrix` 返回 pending）：确认框里选"删除并保存"才落库并关，
 * 选取消就留在抽屉里（`pendingComplete` 复位）。
 * 保存**失败就不关**：关掉等于把"没存上"变成"存过了"。
 */
async function complete(): Promise<void> {
  if (flying) await flying;
  if (formDirty.value && !(await save({ keepOpen: true, silent: true }))) return;
  if (!matrixDirty.value) {
    requestClose();
    return;
  }
  const r = await saveMatrix();
  if (r === 'done' || r === 'noop') {
    requestClose();
    return;
  }
  if (r === 'pending') {
    pendingComplete.value = true; // 等删除确认框那一下
    return;
  }
  pendingComplete.value = false; // 校验没过 / 写库失败：留在抽屉里看得见错误
}

/**
 * 「关掉会丢的东西」—— 空串 = 可以放心关。
 *
 * ⚠️ 它**刻意不包含"表单有改动"**：编辑模式下那些改动是边改边存的。写进来的话就会变成一个
 * 每次关闭都弹、内容却已经不存在的确认框 —— 用户学两下就闭眼点过，真出事那次也照点。
 * 真正会丢的只有两类：
 *   · SKU 矩阵 —— 刻意不自动存（见文件头），工具条上显示"有几处待保存"，保存入口是底部的「完成」；
 *   · 新增模式的草稿 —— 还没有 id，一个字段都没写进库。
 */
const closeGuard = computed(() => {
  if (dirtyCount.value > 0) return `SKU 矩阵还有 ${dirtyCount.value} 处改动没保存（按「完成」会一并保存）`;
  if (createTouched.value) return '这个新产品还没创建';
  return '';
});

/** 新增模式下**填过东西**（判据是"界面上有内容"，不是"有改动"——新增没有可比的基线） */
const createTouched = computed(
  () =>
    !isEdit.value &&
    ([form.code, form.name, form.category, form.note].some((v) => String(v).trim() !== '') ||
      (Number(form.supplierId) || 0) !== 0)
);

const confirmDiscard = ref(false);

/** 所有关闭路径的唯一出口（✕ / 点遮罩 / 保存成功后的收尾） */
function requestClose(): void {
  if (saving.value || skuBusy.value || importBusy.value) {
    toast('还在处理，稍等一下再关', 'info');
    return;
  }
  if (closeGuard.value) {
    confirmDiscard.value = true;
    return;
  }
  emit('close');
}

function discardAndClose(): void {
  confirmDiscard.value = false;
  emit('close');
}

/* ---- 主图 ---- */

const imgUrl = ref('');
const imgBusy = ref(false);
const imagePath = ref(props.product?.imagePath ?? '');

async function loadThumb(): Promise<void> {
  imgUrl.value = '';
  if (!imagePath.value) return;
  try {
    const r = await api.imageThumbBatch([{ localPath: imagePath.value, maxEdge: 160 }]);
    imgUrl.value = r?.dataUrls?.[0] ?? '';
  } catch {
    // 缩略图失败不阻塞编辑（原图路径可能已失效），留空即可
    imgUrl.value = '';
  }
}

async function pickImage(): Promise<void> {
  if (imgBusy.value || !props.product) return;
  try {
    const srcPath = await selectImageFile();
    if (!srcPath) return; // 用户取消
    imgBusy.value = true;
    const r = await api.imageAttach(props.product.id, srcPath);
    imagePath.value = r.localPath;
    toast('主图已更新', 'success');
    await loadThumb();
    emit('saved', null, { keepOpen: true }); // 让列表刷新（不关抽屉）
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

async function removeImage(): Promise<void> {
  if (imgBusy.value || !props.product) return;
  imgBusy.value = true;
  try {
    await api.imageDetach(props.product.id);
    imagePath.value = '';
    imgUrl.value = '';
    toast('已移除主图', 'success');
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

/* ---- SKU 矩阵 ---- */

const variants = ref<VariantRow[]>([]);
const matrix = ref<SkuMatrix>({ sizes: [], rows: [] });
const skuLoading = ref(isEdit.value);
const skuBusy = ref(false);
/** 编码草稿（id → 编码）。改的是草稿，随矩阵一起保存 —— 不另开一条即时写路径。 */
const codeDraft = reactive<Record<number, string>>({});

/* ---- SKU 编码规则 + 一键生成（2026-10-25）----------------------------------
   真库 411 个 SKU 零编码：逐条手打没人会做，所以给"规则 + 一键"。
   规则存在 localStorage（公司/个人统一，不随款变），键与读写都收在这一处。 */
const CODE_RULE_KEY = 'sellerkit.skuCodeRule';
const codeRule = ref<string>(
  (typeof localStorage !== 'undefined' && localStorage.getItem(CODE_RULE_KEY)) || DEFAULT_SKU_CODE_RULE,
);

function persistCodeRule(): void {
  const v = String(codeRule.value ?? '').trim();
  codeRule.value = v || DEFAULT_SKU_CODE_RULE;
  try {
    localStorage.setItem(CODE_RULE_KEY, codeRule.value);
  } catch {
    /* 存储不可用（隐私模式）⇒ 只影响"下次打开还记得"，不影响本次生成 */
  }
}

/** 生成用的种子：只有"色 + 码成对"的 SKU（老数据没有颜色/尺码，编码是只读的，不参与生成） */
const codeSeeds = computed<SkuCodeSeed[]>(() =>
  variants.value
    .filter((v) => !isLegacyVariant(v))
    .map((v, i) => ({
      key: String(v.id),
      styleCode: form.code,
      color: String(v.color ?? '').trim(),
      size: String(v.size ?? '').trim(),
      index: i + 1,
    })),
);

/** 规则预览：拿第一条 SKU 的真实值算一遍（不写库） */
const codeRulePreview = computed(() => {
  const first = codeSeeds.value[0];
  if (!first) return '';
  return renderSkuCode(codeRule.value, first);
});

/**
 * 一键生成。
 *
 * `mode='empty'`（默认）只填空着的 —— 已有编码是人对外的标识，覆盖比留空更糟；
 * `mode='all'` 是另一个显式动作（「全部重写」），并且不弹确认框：编码此时只在草稿里，
 * 走的是同一条"放弃改动并关闭"的撤销路径，弹两次确认反而让人闭眼点过。
 */
function applyCodeRule(mode: 'empty' | 'all'): void {
  if (skuBusy.value) return;
  persistCodeRule();
  const seeds = codeSeeds.value;
  if (!seeds.length) {
    toast('还没有色 + 码成对的 SKU —— 先在上面的矩阵里加组合', 'info');
    return;
  }
  if (!ruleHasToken(codeRule.value)) {
    toast(
      '规则里至少要有一个占位符（{code} / {color} / {size} / {index}）—— 否则每个 SKU 都会拿到同一个编码',
      'error',
    );
    return;
  }
  const { drafts, tooLong } = buildSkuCodes(codeRule.value, seeds);
  let filled = 0;
  let kept = 0;
  for (const v of variants.value) {
    if (isLegacyVariant(v)) continue;
    const draft = drafts.find((d) => d.key === String(v.id));
    if (!draft) continue;
    const current = String(codeDraft[v.id] ?? v.code ?? '').trim();
    if (mode === 'empty' && current) {
      kept += 1;
      continue;
    }
    if (current === draft.code) continue;
    codeDraft[v.id] = draft.code;
    filled += 1;
  }
  const parts = [`已生成 ${filled} 条编码`];
  if (kept) parts.push(`${kept} 条已有编码没动（要覆盖用「全部重写」）`);
  if (tooLong) parts.push(`${tooLong} 条超长或重名，已跳过`);
  // 新建的组合在库里还没有 id，编码无处可挂（codeDraft 是按 variantId 存的）——
  // 不说清的话，"点了没反应"会被当成坏了。保存之后它们就有 id 了，再点一次即可。
  const pendingNew = matrixPlan.value.creates.length;
  if (pendingNew) parts.push(`${pendingNew} 个新组合要先按「完成」存下来才有编码，之后可再点一次`);
  toast(parts.join(' · '), tooLong ? 'error' : 'success');
}

/* ---- 编码区的视野保障（2026-10-25）----------------------------------------
   实报症状：「打开 SKU 编码编辑时被上面的组合遮挡了」。
   右栏 `.ed-main` 是一个可滚容器，矩阵（`flex: 1 1 auto`）先把剩余高度全吃掉；
   details 展开后落在窗口下沿之外 —— macOS 的滚动条默认**不显示**，于是看上去就是
   "点开了、可编码行被上面的组合压住了"。修法两条：
     ① CSS：`.ed-codes` 不吃收缩（`flex: none`），并给右栏 `scroll-padding-top`
        让开吸顶工具条 —— 聚焦到编码框时浏览器自己滚，也不会停在工具条底下；
     ② 展开时主动把它滚进可视区（下面两个函数），不指望用户去猜"下面还有"。 */

/** 让元素完整落在 `.ed-main` 的可见区内；顶部还要让开吸顶工具条。 */
function revealInMain(el: HTMLElement): void {
  const main = el.closest('.ed-main') as HTMLElement | null;
  if (!main) return;
  const bar = main.querySelector('.ed-main__bar') as HTMLElement | null;
  const box = main.getBoundingClientRect();
  const top = box.top + (bar?.getBoundingClientRect().height ?? 0) + 8;
  const bottom = box.bottom - 8;
  let r = el.getBoundingClientRect();
  if (r.top < top) {
    main.scrollTop -= top - r.top;
    r = el.getBoundingClientRect();
  }
  // 只有"这一块能整个塞进可视区"时才去追底边；比可视区还高时，对齐顶边才是对的
  // （否则滚到底部会把标题滚走，人反而不知道自己在看哪一块）。
  if (r.height <= bottom - top && r.bottom > bottom) main.scrollTop += r.bottom - bottom;
}

/**
 * `<details>` 展开回调。
 *
 * `toggle` 派发时 details 已经展开完（DOM 已更新），所以同步量一次就能滚到位；
 * 后面那一帧只是兜底：内容里若有异步渲染（色图 / 图片），首次量到的高度会偏小。
 * 两处都调 `revealInMain` 是幂等的 —— 已经可见时它一格都不滚。
 */
function onCodesToggle(e: Event): void {
  const el = e.target as HTMLDetailsElement | null;
  if (!el || !el.open) return;
  revealInMain(el);
  requestAnimationFrame(() => revealInMain(el));
}

interface SkuCreate {
  color: string;
  size: string;
  weightG: number;
  /**
   * 这一行并入矩阵时的原色名（`SkuMatrixRow.srcColor`；手工加色为空）。
   * 新建行没有 `pl_variants.id`，订单域款色行还叫原色名 —— 保存时要把色行一起改名，图才跟得上。
   */
  prevColor: string;
}

interface SkuUpdate {
  v: VariantRow;
  color: string;
  size: string;
  weightG: number;
  code: string;
  /**
   * 改名前那一刻的颜色（`pl_variants.color`）。
   *
   * 为什么要在**算差异时**就记下来，而不是保存后回读 `variants`：色名同步（订单域款色改名）
   * 要用"从什么改成了什么"，而保存过程中 `variants` 会被写路径改掉（重拉、局部刷新都可能），
   * 事后回读拿到的是新名 ⇒ 判成"没改名"，同步静默不执行（2026-10-23 实测踩过）。
   */
  prevColor: string;
}

interface MatrixPlan {
  creates: SkuCreate[];
  updates: SkuUpdate[];
  deletes: VariantRow[];
  /** 老数据只改编码（它们不进矩阵，但编码仍要能维护） */
  legacyUpdates: SkuUpdate[];
}

/** 老数据：只有名称，颜色/尺码没有成对填上（含只填了一边的） */
function isLegacyVariant(v: VariantRow): boolean {
  const c = String(v.color ?? '').trim();
  const s = String(v.size ?? '').trim();
  return !c || !s;
}

const legacyVariants = computed(() => variants.value.filter((v) => isLegacyVariant(v)));

/**
 * `pl_variants` → 矩阵。
 *
 * ⚠️ 行身份是**色名**（不是"色图 + 色名"）：产品 SKU 没有色图，色图只按色名去订单域查来显示。
 * 格子带 `variantId` —— 改名时靠它在原 SKU 上改（见 `skuMatrix.ts` 的 `variantId` 说明）。
 */
function matrixFromVariants(rows: VariantRow[]): SkuMatrix {
  const sizes: string[] = [];
  const byColor = new Map<string, SkuMatrixRow>();
  const out: SkuMatrixRow[] = [];
  for (const v of rows) {
    const color = String(v.color ?? '').trim();
    const size = String(v.size ?? '').trim();
    if (!color || !size) continue;
    if (!sizes.includes(size)) sizes.push(size);
    let row = byColor.get(color);
    if (!row) {
      row = { key: `color:${color}`, color, imageUrl: '', cells: {} };
      byColor.set(color, row);
      out.push(row);
    }
    row.cells[size] = { price: '', weightG: normWeightG(v.weightG), variantId: v.id };
  }
  return { sizes, rows: out };
}

/**
 * 矩阵 → 要写库的差异（**纯计算，不写库**）。
 *
 * 三条匹配规则，顺序不能反：
 *   ① 格子里记着 `variantId` 且该 SKU 还在 ⇒ 更新它（色名/码名改了也是**原地改**，编码与状态跟着走）；
 *   ② 没有 id（比如取消后又勾回来）但 `色+码` 命中现有 SKU ⇒ 也更新它（别凭空造重复组合）；
 *   ③ 都没有 ⇒ 新增。
 * 现有 SKU 一个都没被命中 ⇒ 删除（保存前会先弹确认）。
 */
const matrixPlan = computed<MatrixPlan>(() => {
  const plan: MatrixPlan = { creates: [], updates: [], deletes: [], legacyUpdates: [] };
  const byId = new Map<number, VariantRow>();
  const byKey = new Map<string, VariantRow>();
  for (const v of variants.value) {
    const c = String(v.color ?? '').trim();
    const s = String(v.size ?? '').trim();
    if (!c || !s) continue;
    byId.set(v.id, v);
    byKey.set(`${c}\u0001${s}`, v);
  }

  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  for (const row of matrix.value.rows) {
    const color = String(row.color ?? '').trim();
    for (const sizeRaw of matrix.value.sizes) {
      const cell = row.cells[sizeRaw];
      if (!cell) continue;
      const size = String(sizeRaw).trim();
      const key = `${color}\u0001${size}`;
      if (seenKeys.has(key)) continue; // 重名行/重名码由 validateMatrix 在保存前拦下
      seenKeys.add(key);
      const weightG = normWeightG(cell.weightG);
      const target =
        (Number(cell.variantId) > 0 ? byId.get(Number(cell.variantId)) : undefined) ?? byKey.get(key);
      if (!target) {
        plan.creates.push({
          color,
          size,
          weightG,
          prevColor: String(row.srcColor ?? '').trim(),
        });
        continue;
      }
      seenIds.add(target.id);
      const code = String(codeDraft[target.id] ?? target.code).trim();
      if (
        weightG !== normWeightG(target.weightG) ||
        code !== target.code ||
        color !== String(target.color ?? '').trim() ||
        size !== String(target.size ?? '').trim()
      ) {
        plan.updates.push({
          v: target,
          color,
          size,
          weightG,
          code,
          prevColor: String(target.color ?? '').trim(),
        });
      }
    }
  }

  for (const v of variants.value) {
    if (isLegacyVariant(v)) {
      const code = String(codeDraft[v.id] ?? v.code).trim();
      if (code !== v.code) {
        plan.legacyUpdates.push({
          v,
          color: String(v.color ?? ''),
          size: String(v.size ?? ''),
          weightG: normWeightG(v.weightG),
          code,
          prevColor: String(v.color ?? '').trim(),
        });
      }
      continue;
    }
    if (!seenIds.has(v.id)) plan.deletes.push(v);
  }
  return plan;
});

const dirtyCount = computed(
  () =>
    matrixPlan.value.creates.length +
    matrixPlan.value.updates.length +
    matrixPlan.value.deletes.length +
    matrixPlan.value.legacyUpdates.length
);
const matrixDirty = computed(() => dirtyCount.value > 0);

/**
 * 保存前的校验。**只能拦"落不了库的形状"**，不替人做数据判断：
 *   · 产品 SKU 必须色 + 码成对（`variantUpsert` 的硬约束），空码不是"只有颜色的款"；
 *   · 同色两行 / 同码两列会撞 `UNIQUE(product_id, name)`，提前说清比让主进程抛一句更近；
 *   · 长度上限与主进程一致（超了会被 `str()` 截断，那是静默改数据）。
 */
function validateMatrix(): string {
  const m = matrix.value;
  if (m.rows.length && !m.sizes.length) {
    return '请至少加一个尺码 —— 产品 SKU 必须同时有颜色和尺码（只有一个维度的款请用「均码」这类实际尺码）';
  }
  const colors = new Set<string>();
  for (const row of m.rows) {
    const c = String(row.color ?? '').trim();
    if (!c) return '每一行都要填颜色名 —— 空着的颜色行落不了库（不需要就把它删掉）';
    if (c.length > 40) return `颜色名「${c.slice(0, 12)}…」太长（最多 40 字）`;
    if (colors.has(c))
      return `颜色「${c}」出现了两行 —— 把其中一行拖到上面「常用色」的「${c}」上（或拖到另一行上）合并成一色`;
    colors.add(c);
  }
  const sizes = new Set<string>();
  for (const raw of m.sizes) {
    const s = String(raw ?? '').trim();
    if (!s) return '尺码不能为空 —— 产品 SKU 必须同时有颜色和尺码（只有一个维度的款请用「均码」这类实际尺码）';
    if (s.length > 40) return `尺码「${s.slice(0, 12)}…」太长（最多 40 字）`;
    if (sizes.has(s)) return `尺码「${s}」重复了`;
    sizes.add(s);
  }
  for (const key of Object.keys(codeDraft)) {
    const code = String(codeDraft[Number(key)] ?? '').trim();
    if (code.length > 64) return `SKU 编码「${code.slice(0, 16)}…」太长（最多 64 字）`;
  }
  return '';
}

/** 更新载荷：**全量提交**（缺字段会被清空）—— 颜色/尺码用矩阵里的当前值，改名即原地改 */
function updatePayload(u: SkuUpdate) {
  return {
    id: u.v.id,
    productId: props.product?.id ?? 0,
    name: [u.color.trim(), u.size.trim()].filter(Boolean).join(' ') || u.v.name,
    color: u.color.trim(),
    size: u.size.trim(),
    code: u.code,
    weightG: u.weightG,
    // 行上存的是宽松 string，落库只认这两个值（其它历史值一律当启用，别静默停用）
    status: (u.v.status === 'archived' ? 'archived' : 'active') as ProductStatus,
  };
}

const pendingSkuPlan = ref<MatrixPlan | null>(null);
const pendingLegacy = ref<VariantRow | null>(null);
/** 「完成」触发的保存正等着删除确认：确认后要接着关抽屉（取消则留在原地） */
const pendingComplete = ref(false);

/** `pending` = 弹了删除确认，落库要等用户点一下；`noop` = 本来就没改动 */
type MatrixSaveResult = 'done' | 'pending' | 'failed' | 'noop';

async function saveMatrix(): Promise<MatrixSaveResult> {
  if (skuBusy.value) return 'failed';
  const err = validateMatrix();
  if (err) {
    toast(err, 'error');
    return 'failed';
  }
  const plan = matrixPlan.value;
  if (!plan.creates.length && !plan.updates.length && !plan.deletes.length && !plan.legacyUpdates.length) {
    toast('SKU 矩阵没有改动', 'info');
    return 'noop';
  }
  // 删除是物理的：先让人看清删哪几个，再连同新增/更新一起提交（一次保存 = 一个决定）
  if (plan.deletes.length) {
    pendingSkuPlan.value = plan;
    return 'pending';
  }
  return (await applyMatrixPlan(plan)) ? 'done' : 'failed';
}

async function confirmSkuSave(): Promise<void> {
  const plan = pendingSkuPlan.value;
  pendingSkuPlan.value = null;
  if (!plan) {
    pendingComplete.value = false;
    return;
  }
  const ok = await applyMatrixPlan(plan);
  if (!ok) {
    pendingComplete.value = false;
    return;
  }
  if (pendingComplete.value) {
    pendingComplete.value = false;
    requestClose();
  }
}

/** 删除确认框"取消"：不保存，留在抽屉里继续改（"完成"那条路也要把意图复位） */
function dismissSkuPlan(): void {
  pendingSkuPlan.value = null;
  pendingComplete.value = false;
}

/**
 * 「保留这些组合」= 把确认框里列出的 SKU 原样加回矩阵（克重、编码、variantId 全带回）。
 *
 * 为什么要有这条路（2026-10-25 用户实报「我所有的克重都已经填好了，保存还说这 3 个组合会被删掉」）：
 * 那三格多半是误点列头（整列取消）掉的 —— 人根本没打算删，却只在"保存"这一步才被告知。
 * 只给"删除并保存 / 取消"两个出口时，他只能整轮重来（或放弃改动重新填一遍克重）。
 * 加回来是**非破坏**方向：矩阵改回原样，还没落库，人可以再核对一遍再按「完成」。
 */
function keepDeletedCells(): void {
  const plan = pendingSkuPlan.value;
  if (!plan) return;
  const m: SkuMatrix = { sizes: [...matrix.value.sizes], rows: matrix.value.rows.map((r) => ({ ...r, cells: { ...r.cells } })) };
  let added = 0;
  for (const v of plan.deletes) {
    const color = String(v.color ?? '').trim();
    const size = String(v.size ?? '').trim();
    if (!color || !size) continue;
    let row = m.rows.find((r) => String(r.color ?? '').trim() === color);
    if (!row) {
      row = { key: `color:${color}`, color, imageUrl: '', cells: {} };
      m.rows.push(row);
    }
    if (!m.sizes.includes(size)) m.sizes.push(size);
    row.cells[size] = { price: '', weightG: normWeightG(v.weightG), variantId: v.id };
    added += 1;
  }
  matrix.value = m;
  pendingSkuPlan.value = null;
  pendingComplete.value = false;
  flashSaved(`已把这 ${added} 个组合加回矩阵（还没保存）`);
  if (added) toast(`已加回 ${added} 个组合 —— 核对后按「完成」保存`, 'success');
}

/**
 * 色名改了 ⇒ 把**订单域的色行**一起改名（只改标签；款色 id / 编码 / 绑定的图都不动）。
 *
 * 为什么必须在保存这一刻做：色图是按「款编码 + 色名」查的（`order-db#findStyleColorImagePath`），
 * 只改产品侧的名字，库里那张图还挂在旧色名的色行上 ⇒ 关掉抽屉重开图就空
 * （2026-10-23 用户实报「并入矩阵后改颜色，图片就没了」）。
 * 为什么不是"把图挪到新色名行"：那会让历史拿货/拣货行（按旧款色 id 分组）失去图 ——
 * 保 id 的改名才是最小动作（C2：关联用 ID，不用名字）。
 *
 * ⚠️ **新增行（`plan.creates`）也在这条链上**：并入矩阵的行在 `pl_variants` 里还没有 id，
 * 它的原色名只存在于 `SkuMatrixRow.srcColor`（采集侧色名，如平台的 `5`）。
 * 之前只遍历 `updates`，于是"并入 → 改色名 → 保存"这条最常见的路径整个漏掉：
 * 订单域色行还叫 `5`，SKU 却成了「深蓝」⇒ 重查落空、图丢（2026-10-23 二次实报
 * 「保存以后图片还是丢失了」；真库实证：新增 SKU id 404-411 全是新行，
 * `oi_style_colors` 里仍是 `1..8`、`oi_color_aliases` 空 = 改名根本没发出去）。
 *
 * 失败**不拦保存**（SKU 已经写进库了，色名同步只是显示与后续归色的辅助），
 * 但要把失败**说出来**：`target-exists`（新名已是另一个色行，合并要人看图定）/
 * `no-style` / `no-color`（这个色名在订单域还没有色行）/ 异常。
 * 静默失败的下场就是用户再报一次"图又没了"。
 */
async function renameStyleColors(
  plan: MatrixPlan
): Promise<{ renamed: number; failed: { from: string; to: string; reason: string }[] }> {
  const code = form.code.trim();
  const productId = props.product?.id ?? 0;
  const failed: { from: string; to: string; reason: string }[] = [];
  if (!code || !productId) return { renamed: 0, failed };
  // 「旧名 → 新名」只能从**差异**里取：`prevColor` 是算差异那一刻读到的值，
  // 保存过程中 `variants` 会被写路径刷新，事后回读拿到的已经是新名 ⇒ 会判成"没改名"。
  // 一行多格（同色多码）改名只发一次 —— 款色是一行，不是一格。
  const pairs: { from: string; to: string }[] = [];
  for (const c of plan.creates) pairs.push({ from: c.prevColor, to: String(c.color ?? '').trim() });
  for (const u of plan.updates) pairs.push({ from: u.prevColor, to: String(u.color ?? '').trim() });
  const seen = new Set<string>();
  let renamed = 0;
  for (const p of pairs) {
    const from = String(p.from ?? '').trim();
    const to = p.to;
    if (!from || !to || from === to) continue;
    const pair = `${from}\u0001${to}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    try {
      const r = await api.styleColorRename({ productId, styleCode: code, from, to });
      if (r?.renamed) renamed += 1;
      else failed.push({ from, to, reason: String(r?.reason || 'not-applied') });
    } catch (e: unknown) {
      failed.push({ from, to, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { renamed, failed };
}

/** 返回"整批是不是都写成功了" —— 「完成」要靠它决定关不关抽屉（失败还关 = 假装存上了） */
async function applyMatrixPlan(plan: MatrixPlan): Promise<boolean> {
  skuBusy.value = true;
  let ok = true;
  let created = 0;
  let updated = 0;
  let removed = 0;
  try {
    for (const c of plan.creates) {
      await api.variantUpsert({
        productId: props.product?.id ?? 0,
        name: `${c.color} ${c.size}`,
        color: c.color,
        size: c.size,
        code: '',
        weightG: c.weightG,
        status: 'active',
      });
      created++;
    }
    for (const u of plan.updates) {
      await api.variantUpsert(updatePayload(u));
      updated++;
    }
    for (const u of plan.legacyUpdates) {
      await api.variantUpsert(updatePayload(u));
      updated++;
    }
    for (const v of plan.deletes) {
      await api.variantDelete(v.id);
      removed++;
    }
    // 色名同步到订单域（只改标签，图跟着款色 id 走）——必须在 loadSkus 之前：
    // 重拉时按新色名查图，晚一步就会先画一帧空占位。
    const sync = await renameStyleColors(plan);
    await loadSkus();
    emit('saved', null, { keepOpen: true });
    flashSaved(
      `SKU 已保存：新增 ${created} · 更新 ${updated} · 删除 ${removed}` +
        (sync.renamed ? ` · 色名同步 ${sync.renamed}` : '')
    );
    toast('SKU 已保存', 'success');
    // 色名没同步上 = 这些行的色图重开就没了 —— 必须当面说，不能只留在 console
    if (sync.failed.length) {
      const detail = sync.failed.map((f) => `${f.from}→${f.to}（${f.reason}）`).join('、');
      toast(`色名未同步到订单域，这些行的色图重开后会空：${detail}`, 'error');
    }
  } catch (e: unknown) {
    ok = false;
    toast(e instanceof Error ? e.message : String(e), 'error');
    // 可能已经写进去一部分：对齐服务端，别让界面继续显示一份假的"待保存"
    await loadSkus();
  } finally {
    skuBusy.value = false;
  }
  return ok;
}

function askDeleteLegacy(v: VariantRow): void {
  if (skuBusy.value) return;
  pendingLegacy.value = v;
}

/**
 * 删老数据：**不重拉整张 SKU 表**。
 * 老数据不在矩阵里，删掉它不影响矩阵；而重拉会把矩阵上还没保存的改动冲掉。
 */
async function confirmDeleteLegacy(): Promise<void> {
  const v = pendingLegacy.value;
  pendingLegacy.value = null;
  if (!v || skuBusy.value) return;
  skuBusy.value = true;
  try {
    await api.variantDelete(v.id);
    variants.value = variants.value.filter((x) => x.id !== v.id);
    delete codeDraft[v.id];
    toast(`已删除「${v.name}」`, 'success');
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    skuBusy.value = false;
  }
}

/* ---- 从采集商品导入矩阵（产品 SKU 的唯一来源是采集快照）---- */

interface ImportCandidate {
  row: ShopItemRow;
  matrix: SkuMatrix;
  comboCount: number;
  colorCount: number;
  sizeCount: number;
}

const importOpen = ref(false);
const importLoading = ref(false);
const importError = ref('');
const importBusy = ref(false);
/** 这款当前认到的采集行（服务端按「最新一条 confirmed 映射」筛） */
const importRows = ref<ShopItemRow[]>([]);
const importSelectedId = ref(0);
const importHint = ref('');

const importCandidates = computed<ImportCandidate[]>(() =>
  importRows.value.map((row) => {
    const m = toSkuMatrix(parseSkuJsonRows(row.skuJson));
    return {
      row,
      matrix: m,
      comboCount: skuMatrixComboCount(m),
      colorCount: m.rows.filter((r) => String(r.color ?? '').trim()).length,
      sizeCount: m.sizes.filter((s) => String(s ?? '').trim()).length,
    };
  })
);

const importSelected = computed(
  () => importCandidates.value.find((c) => c.row.id === importSelectedId.value) ?? null
);

/** 选中项并进当前矩阵的**预览**（纯计算：真正落进矩阵要等用户点「并入矩阵」） */
const importPreview = computed<{ matrix: SkuMatrix; stats: MergeSkuStats } | null>(() => {
  const sel = importSelected.value;
  if (!sel || !sel.comboCount) return null;
  return mergeSkuMatrix(matrix.value, sel.matrix);
});

const importCanApply = computed(() => {
  const p = importPreview.value;
  if (!p) return false;
  const s = p.stats;
  return s.addedColors + s.addedCells + s.filledWeights > 0;
});

async function toggleImport(): Promise<void> {
  if (importBusy.value) return;
  if (importOpen.value) {
    importOpen.value = false;
    return;
  }
  importOpen.value = true;
  await loadImportCandidates();
}

async function loadImportCandidates(): Promise<void> {
  const productId = props.product?.id ?? 0;
  if (!productId) return;
  importLoading.value = true;
  importError.value = '';
  try {
    const r = await api.shopItemsList({ productId, pageSize: 100 });
    importRows.value = r?.rows ?? [];
    // 默认选组合最多的一条（矩阵最全）；一条都没采到 SKU 时留空，让预览区不冒"没有可导入"
    const list = importCandidates.value;
    let best: ImportCandidate | null = null;
    for (const c of list) if (c.comboCount > (best?.comboCount ?? 0)) best = c;
    importSelectedId.value = best?.row.id ?? 0;
  } catch (e: unknown) {
    importError.value = `读取采集商品失败：${e instanceof Error ? e.message : String(e)}`;
    importRows.value = [];
    importSelectedId.value = 0;
  } finally {
    importLoading.value = false;
  }
}

/**
 * 把选中采集商品的 SKU 并进当前矩阵（**不落库** —— 仍要按底部「完成」）。
 * 色图顺手采纳为款色图（只补空、失败不影响矩阵）；采纳后重拉展示图。
 */
async function applyImport(): Promise<void> {
  const sel = importSelected.value;
  const preview = importPreview.value;
  if (!sel || !preview || importBusy.value || !importCanApply.value) return;
  importBusy.value = true;
  const { matrix: merged, stats } = preview;
  try {
    matrix.value = merged;
    const parts: string[] = [];
    if (stats.addedColors) parts.push(`${stats.addedColors} 色`);
    if (stats.addedSizes) parts.push(`${stats.addedSizes} 个尺码`);
    if (stats.addedCells) parts.push(`${stats.addedCells} 个组合`);
    if (stats.filledWeights) parts.push(`补 ${stats.filledWeights} 格克重`);
    if (stats.skipped) parts.push(`跳过 ${stats.skipped} 条缺色/缺码`);
    let hint = `已从采集商品导入：${parts.join(' · ')}。改完按底部的「完成」落库。`;
    importOpen.value = false;

    // 色→图 1:1：同色多图只取第一张（采集侧同色可能挂两张图，产品侧一个色只能有一张代表图）
    const seen = new Set<string>();
    const colors = sel.matrix.rows
      .map((r) => ({ color: String(r.color ?? '').trim(), imageUrl: String(r.imageUrl ?? '').trim() }))
      .filter((c) => {
        if (!c.color || !c.imageUrl || seen.has(c.color)) return false;
        seen.add(c.color);
        return true;
      });
    if (colors.length && props.product) {
      try {
        const r = await api.shopItemImageFetch({
          id: sel.row.id,
          productId: props.product.id,
          colors,
        });
        const bound = (r?.colors ?? []).filter((c) => c.bound).length;
        if (bound) hint += ` 色图已采纳 ${bound} 张。`;
        void loadColorImages();
      } catch {
        // 图是锦上添花：下载/采纳失败不能把"矩阵已导入"说成失败
        hint += ' 色图没取到（不影响 SKU，可稍后重试）。';
      }
    }

    importHint.value = hint;
    toast('已并入矩阵 —— 记得按底部「完成」落库', 'info');
  } finally {
    importBusy.value = false;
  }
}

/* ---- 色图（只作显示：按款编码 + 色名去订单域取该款色的代表图）---- */

const colorPaths = ref<Record<string, string>>({});
const colorImages = ref<Record<string, string>>({});
let imageToken = 0;

/**
 * 把查到的缩略图贴到矩阵行上 —— **只补不撤**：查到就换成库里的那张，查不到**保留行上原有的图**。
 *
 * ⭐ 为什么不能"查不到就清空"（2026-10-23 用户报「并入矩阵后改颜色，图片就没了」）：
 * 色图在订单域是按「款编码 + 色名」查的，而色名是**人会改的标签**。改一个字的瞬间查询就落空，
 * 于是每敲一个键都把这一行的图抹掉一次 —— 图明明还在库里（绑在款色上），界面却当它不存在。
 * 只有确认"这个色名在库里确实有另一张图"时才该换图；没有结论（查不到 / 查询失败）就什么都不做。
 * 与 `findStyleColorImagePath` 的 2026-10-20 口径同一条：色名会变，别拿它当身份。
 */
function applyColorImages(): void {
  for (const row of matrix.value.rows) {
    const url = colorImages.value[String(row.color ?? '').trim()] ?? '';
    if (url && row.imageUrl !== url) row.imageUrl = url;
  }
}

async function loadColorImages(): Promise<void> {
  const token = ++imageToken;
  const code = form.code.trim();
  const colors = [
    ...new Set(matrix.value.rows.map((r) => String(r.color ?? '').trim()).filter(Boolean)),
  ];
  colorPaths.value = {};
  colorImages.value = {};
  if (!code || !colors.length) {
    applyColorImages();
    return;
  }
  try {
    const { paths } = await api.styleImagePaths({
      items: colors.map((color) => ({ styleCode: code, color })),
    });
    const hits: { color: string; localPath: string }[] = [];
    (paths || []).forEach((p, i) => {
      if (p && colors[i]) hits.push({ color: colors[i], localPath: p });
    });
    if (!hits.length || token !== imageToken) {
      if (token === imageToken) applyColorImages();
      return;
    }
    const { dataUrls } = await api.imageThumbBatch(
      hits.map((h) => ({ localPath: h.localPath, maxEdge: 256 }))
    );
    if (token !== imageToken) return;
    const nextPaths: Record<string, string> = {};
    const nextImages: Record<string, string> = {};
    hits.forEach((h, i) => {
      nextPaths[h.color] = h.localPath;
      const u = dataUrls?.[i];
      if (u) nextImages[h.color] = u;
    });
    colorPaths.value = nextPaths;
    colorImages.value = nextImages;
  } catch {
    // 图只作显示：查不到 / 读失败都只是空占位，不打断编辑
  }
  if (token === imageToken) applyColorImages();
}

/** 缩略图是 256px 的展示级；点开看大图时再读原图（只在用户点开某一张时调） */
async function resolveViewerImage(row: SkuMatrixRow): Promise<string | null> {
  const p = colorPaths.value[String(row.color ?? '').trim()];
  if (!p) return null;
  try {
    const r = await api.readImage(p);
    return r?.dataUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * 色名一改，**重查一次库**（防抖 400ms，敲字途中不查）。
 *
 * 为什么要重查而不是只做本地对齐：改色名有两种意图 —— ①同一个色换个说法（图不变）；
 * ②改成一个库里已有的、有自己那张图的色（图该换成新的）。只有库里能回答是哪一种。
 * 防抖是必需的：`v-model` 每个键都触发，逐键查库既慢又会把查询结果乱序贴回来。
 */
let colorImageTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => matrix.value.rows.map((r) => r.color).join('\u0001'),
  () => {
    applyColorImages(); // 先本地对齐：命中的立刻换，没命中的保留原图（不清空）
    if (colorImageTimer) clearTimeout(colorImageTimer);
    colorImageTimer = setTimeout(() => {
      colorImageTimer = null;
      void loadColorImages();
    }, 400);
  }
);

/**
 * 保存/重拉之后，把「已经查到的色图」**按 SKU id** 带到新矩阵上（只在本次抽屉会话内有效）。
 *
 * 为什么按 id 而不按色名：`pl_variants.id` 在改名保存时是**原地改**（见 `matrixPlan` ①②），
 * 它才代表"还是那一行"；色名是刚被改掉的标签，按它再查库必然查不到 ⇒ 一保存图就没了。
 * 为什么不干脆不重拉：保存后必须对齐服务端（可能有新增/删除），这里只是把"显示用的图"续上。
 * 局限（明说）：关掉抽屉再打开，这条路径就断了 —— 图要么由库里按新色名查得到，要么为空。
 */
function carryRowImages(prev: SkuMatrix, next: SkuMatrix): SkuMatrix {
  const byVariant = new Map<number, string>();
  for (const row of prev.rows) {
    if (!row.imageUrl) continue;
    for (const cell of Object.values(row.cells)) {
      if (Number(cell.variantId) > 0) byVariant.set(Number(cell.variantId), row.imageUrl);
    }
  }
  if (!byVariant.size) return next;
  let changed = false;
  const rows = next.rows.map((row) => {
    if (row.imageUrl) return row;
    for (const cell of Object.values(row.cells)) {
      const img = Number(cell.variantId) > 0 ? byVariant.get(Number(cell.variantId)) : '';
      if (img) {
        changed = true;
        return { ...row, imageUrl: img };
      }
    }
    return row;
  });
  return changed ? { ...next, rows } : next;
}

async function loadSkus(): Promise<void> {
  if (!isEdit.value || !props.product) return;
  // 矩阵重新从库里读 ⇒ 之前"已导入、待保存"的回执不再成立（保存失败也会走到这里）
  importHint.value = '';
  skuLoading.value = true;
  try {
    const r = await api.variantList([props.product.id]);
    variants.value = r?.rows ?? [];
    for (const key of Object.keys(codeDraft)) delete codeDraft[Number(key)];
    for (const v of variants.value) codeDraft[v.id] = v.code;
    matrix.value = carryRowImages(matrix.value, matrixFromVariants(variants.value));
    void loadColorImages();
  } catch (e: unknown) {
    toast(`SKU 读取失败：${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    skuLoading.value = false;
  }
}

onMounted(() => {
  void loadThumb();
  void loadSkus();
});

onUnmounted(() => {
  imageToken++;
  if (colorImageTimer) clearTimeout(colorImageTimer);
  if (hintTimer) clearTimeout(hintTimer);
});
</script>

<style scoped>
/* 遮罩只做"点击空白关闭"，抽屉自己贴在右侧（两者都在全局 .wb-mask / .wb-drawer 里） */
.ed-mask {
  align-items: stretch;
  justify-content: flex-end;
  padding: 0;
}

/* 抽屉宽度：从 560 → 1040（不超过 94vw）。
   1040 = 左栏 320 + 间隔 + 右栏 ≈ 690（行头 176 + 5 列 × 96 一屏看得见）；窗口再窄时
   按 94vw 收，列表仍留一条可见 —— 抽屉的初衷（改的时候看得到列表）没有被牺牲。 */
.ed-drawer {
  width: min(1040px, 94vw);
}

.ed-head {
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
}
.ed-head__title {
  flex: none;
}
.ed-head__code {
  overflow: hidden;
  max-width: 240px;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「边改边存」徽标：把原来那一整段说明压成一枚 chip（全文在 title 里）。
   不是装饰 —— 少了它，人会在这一屏继续找那个已经不存在的「保存」按钮（UX-G3）。 */
.ed-chip {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.6;
  color: var(--wb-text-muted);
  cursor: help;
}
.ed-x {
  margin-left: auto;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  color: var(--wb-text-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--wb-radius-sm);
}
.ed-x:hover {
  background: var(--wb-hover);
  color: var(--wb-text);
}

/* 页脚那行小字（`已自动保存` / `还有 N 处改动没保存`）靠左，
   两个按钮保持右对齐 —— 与产品选择器 `ProductPicker` 同一条排法。 */
.ed-hint {
  margin-right: auto;
  font-size: 12px;
  white-space: normal;
}
/* 款级删除：与「完成」之间留出明确间距（同一条页脚里两种性质的动作用空白分开），
   且不吃 `margin-right: auto` 那一份弹性 —— 它必须停在最右，不能跟着提示语跑。 */
.ed-foot__del {
  margin-left: 8px;
}

/* ---- 两栏骨架 --------------------------------------------------------------
   左栏固定 320px（字段不需要更宽，宽了只是把输入框拉长），右栏吃满剩余宽度**与高度**。
   `padding: 0` 在这里：`.wb-dialog__body` 统一的内边距会让两栏之间的分隔线只画一半 ——
   内边距交给两栏各自给，分隔线才是通高的。 */
.ed-body {
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0;
  overflow: hidden;
}
.ed-col {
  display: flex;
  flex: 0 0 320px;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 14px 16px;
  overflow-y: auto;
  border-right: 1px solid var(--wb-border);
}
/* 新增模式没有 SKU 栏：单列铺开（否则右半边是一整片空白） */
.ed-body--create .ed-col {
  flex: 1 1 auto;
  max-width: 460px;
  border-right: 0;
}

/* 分节：标题一条细横线，比"每个字段都套一个框"干净得多（框一多整页就脏） */
.ed-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ed-sec__title {
  margin: 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text-muted);
}
/* 同一行两列（供应商 + 类目 / 进价 + 状态） */
.ed-pair {
  display: flex;
  gap: 10px;
}
.ed-pair > * {
  flex: 1;
  min-width: 0;
}

.is-readonly {
  background: var(--wb-hover);
  color: var(--wb-text-muted);
}

/* ---- 主图 ---- */
.ed-img {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ed-img__pic {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-hover);
}
.ed-img__empty {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-md);
  color: var(--wb-text-muted);
  font-size: 11px;
}
.ed-img__ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ---- SKU 工作区（右栏）------------------------------------------------------
   它是一个 flex 列：吸顶工具条 + 导入面板（可选）+ 矩阵（吃满剩余高度）+ 编码/老数据。
   矩阵**不再有 40vh 上限**：上限的意义是"别顶出弹层"，而现在这个弹层是整窗高、
   右栏自己裁切 —— 表格该拿走剩下的每一像素（那正是"SKU 编辑不方便"的主因）。 */
.ed-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  padding: 12px 16px 14px;
  overflow-y: auto;
  /* 吸顶工具条的高度 + 间距：聚焦到下面的输入框（编码 / 老数据）时，浏览器的隐式滚动
     会把目标停在工具条**底下** —— 那一瞬间看起来就是"被上面的东西盖住了"。 */
  scroll-padding-top: 46px;
}
/* 吸顶：矩阵滚多远，SKU 的保存状态都在视野里。
   2026-10-25 起这里**只显示状态**（"有几处待保存"）—— 保存入口合并到底部的「完成」，
   不再有第二个要人自己挑的按钮。 */
.ed-main__bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface);
}
.ed-main__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.ed-main__sub {
  font-size: 11px;
}
.ed-main__ops {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

/* SKU 的保存状态（**不是**第二个保存按钮）：脏时变暖色小标签，点一下 = 立即存但不关。
   保存的主入口是底部「完成」——见文件头与 `complete()`。 */
.ed-main__state {
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--wb-radius-sm);
  cursor: default;
}
.ed-main__state.is-dirty {
  color: var(--wb-warning);
  border-color: var(--wb-border);
  background: var(--wb-surface-2);
  cursor: pointer;
}
.ed-main__state.is-dirty:hover:not(:disabled) {
  border-color: var(--wb-warning);
}
.ed-main__state:disabled {
  cursor: default;
}

/* 从采集商品导入（只补缺口；导入后仍需保存矩阵） */
.ed-import {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.ed-import__error {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ed-import__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.ed-import__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}
.ed-import__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  color: var(--wb-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ed-import__item:hover {
  background: var(--wb-hover);
}
.ed-import__item.is-active {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.ed-import__radio {
  flex: none;
  font-size: 12px;
  color: var(--wb-primary);
}
.ed-import__item-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ed-import__item-id {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ed-import__item-meta {
  font-size: 11px;
  color: var(--wb-text-muted);
}
.ed-import__item-note {
  flex: none;
  font-size: 11px;
}
.ed-import__preview {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.ed-import__ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ed-import__done {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

/* SKU 编码：折叠着（绝大多数款留空），要维护时再展开。
   `flex: none`（2026-10-25）：右栏可用高度不够时，矩阵会把它压成一条缝 ——
   展开是为了**编辑**，压扁等于没给这个入口。空间不够就整体滚动，由 `onCodesToggle`
   负责把展开的这块滚进视野。 */
.ed-codes {
  flex: none;
  scroll-margin-top: 46px;
  padding: 6px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.ed-codes > summary {
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.ed-codes__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  margin-top: 8px;
  overflow-y: auto;
}

/* 编码规则（一行放得下：规则框 + 一键生成 + 全部重写） */
.ed-coderule {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.ed-coderule__k {
  flex: none;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ed-coderule__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  font-size: 12px;
  font-family: var(--wb-font-mono, monospace);
}
.ed-coderule__all {
  flex: none;
  font-size: 12px;
}
.ed-coderule__hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
}
.ed-coderule__hint b {
  margin-right: 4px;
  font-weight: 600;
  color: var(--wb-text);
}
.ed-coderule__preview {
  margin-left: 6px;
}
.ed-coderule__preview b {
  font-weight: 600;
  color: var(--wb-primary);
}
.ed-codes__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ed-codes__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.ed-codes__input {
  flex: 0 0 180px;
  min-width: 0;
  height: 26px;
  font-size: 12px;
  /* 与 `.ed-main` 的 scroll-padding 同一用途：聚焦时别停在吸顶工具条底下 */
  scroll-margin-block: 46px;
}

/* 老数据（只有名称）：单独列出来，能删不静默丢 */
.ed-legacy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
}
.ed-legacy__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.ed-legacy__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ed-legacy__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.ed-legacy__code {
  flex: none;
  font-family: var(--wb-font-mono, monospace);
  font-size: 11px;
}
.ed-tag {
  flex-shrink: 0;
  padding: 0 4px;
  font-size: 11px;
  color: var(--wb-text-muted);
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  cursor: help;
}

/* 删除确认里那句"删哪些" */
.ed-del-list {
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.7;
  white-space: normal;
}
.ed-del-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}
</style>
