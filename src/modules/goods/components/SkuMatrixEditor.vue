<template>
  <div
    ref="rootEl"
    class="mx"
    :class="{ 'mx--fill': fillHeight }"
    @pointermove="onChipMove"
    @pointerup="onChipUp"
    @pointercancel="onChipUp"
    @click.capture="onRootClickCapture"
    @dragstart.prevent
  >
    <!-- ── 规格（通用编辑项集中在这里）────────────────────────────────────
         为什么从表格里提出来：颜色（色图 · 色名）原先挤在 208px 的行头、尺码挤在 92px 的列头，
         一个输入框 + 一个缩略图 + 一个删除键塞进去，名字稍长就看不全；而表格本身只管"哪个组合在卖"。
         提出来之后两件事各自变好：规格可以排成卡片慢慢改（色图看得清、色名打得全），
         表格列宽可以收窄（一屏多看好几列），且"改规格"只有一个入口 —— 不再出现
         "表头改一个字、下面 140 个格跟着搬"的隐式耦合。 -->
    <section class="mx-spec" :data-act="`${act}-spec`" role="group" aria-label="规格编辑">
      <!-- 一行一组：颜色 / 尺码 / 克重。
           2026-10-24 收紧成"标签 + chip"（原来每个色一张 196px 的卡，外加三段说明文字）：
           多色多码时那一块要吃掉 330px，把矩阵压到 180px —— 一屏只看得见三行组合，
           这正是用户说的「乱、重叠」。现在同一屏能看见十来个色 + 十几行组合。
           说明文字一律收进 title：这一屏要回答的是"哪个色缺哪个码"，不是读说明书。 -->
      <!-- 常用色（2026-10-24 用户口径「把常用颜色放在上面」）：
           一点即加；已经在矩阵里的**打勾变灰**（于是这一排同时回答"还差哪些色没加"）。
           2026-10-24 晚补充（用户口径「拖动颜色里的项，拖动到常用色中进行归类」）：
           它同时是**拖放的落点** —— 把下面某个色名拖到自己这一排的某个常用色上松手，
           那个色就归到这个规范名下（矩阵里已有同名色 ⇒ 并进那一行；没有 ⇒ 原地改名）。
           于是"归类"的落点是 10 个固定的大靶子，而不是下面一排要瞄准的小 chip。 -->
      <div class="mx-line mx-line--palette">
        <span class="mx-line__k" title="常用色：点一下加一色；打勾 = 矩阵里已经有这个色名；把下面的色名拖到这里归档">
          常用色
        </span>
        <div class="mx-palette" :class="{ 'mx-palette--dragging': dragActive }">
          <button
            v-for="c in paletteColors"
            :key="`pc${c}`"
            class="mx-pc"
            :class="{ 'is-in': hasColor(c), 'is-drop': dragActive && dropPalette === c }"
            type="button"
            :data-act="`${act}-common`"
            :data-color="c"
            :data-mx-pc="c"
            :disabled="disabled"
            :title="pcTitle(c)"
            @click="pickCommon(c)"
          >
            <span class="mx-pc__dot" :style="{ background: findSwatch(c) ?? 'transparent' }"></span>
            {{ c }}
          </button>
        </div>
      </div>

      <div class="mx-line">
        <span
          class="mx-line__k"
          title="按住左侧色图拖到上面「常用色」= 归到这个规范色（落库用常用色的名字）；拖到另一个色上 = 合并两色"
          >颜色</span
        >
        <div class="mx-colors" :class="{ 'mx-colors--dragging': dragActive }">
          <div
            v-for="(r, ri) in matrix.rows"
            :key="`c${ri}`"
            class="mx-color"
            :class="{
              'is-flagged': flagged(r),
              'is-src': dragActive && dragSrc === ri,
              'is-drop': dragActive && dragOver === ri,
            }"
            :data-mx-row="ri"
            :title="
              dragActive
                ? dragOver === ri
                  ? `松手：把「${matrix.rows[dragSrc ?? 0]?.color || '这一色'}」并进「${r.color || '这一色'}」`
                  : ''
                : '按住色图左侧空白处拖到上面「常用色」= 归到这个规范色；拖到另一个色上 = 合并两色'
            "
            @pointerdown="onChipDown(ri, $event)"
          >
            <button
              v-if="rowImage(r)"
              class="mx-thumb-btn"
              type="button"
              :data-act="`${act}-thumb`"
              :aria-label="`放大查看${r.color || '这一色'}的色图`"
              :title="thumbTitle(r)"
              @click="openViewer(r)"
            >
              <img
                :src="rowImage(r)"
                class="wb-thumb mx-color__img"
                alt=""
                draggable="false"
                referrerpolicy="no-referrer"
              />
              <!-- 「这张图能点」常显角标：只写在 title 里的话，触屏与不会悬停的人永远看不到 -->
              <span class="mx-thumb-btn__zoom" aria-hidden="true">⤢</span>
            </button>
            <!-- 没有色图时不摆一个空白虚线框：认得出色名就填近似色（14 色一屏时靠它认行） -->
            <span
              v-else
              class="wb-thumb wb-thumb--empty mx-color__img"
              :style="swatchStyle(r.color)"
              :title="`${r.color || '这一色'}没有采到色图（色块按色名近似，只作辨认）`"
            ></span>
            <span v-if="flagged(r)" class="mx-dot" :title="flagHint" aria-hidden="true"></span>
            <input
              v-model="r.color"
              class="wb-input mx-color__name"
              :data-act="`${act}-color`"
              :aria-label="`第 ${ri + 1} 个颜色的名称`"
              :aria-expanded="suggestFor === ri ? 'true' : 'false'"
              autocomplete="off"
              :disabled="disabled"
              @focus="openSuggest(ri, $event)"
              @click="onColorNameClick(ri, $event)"
              @input="onColorNameInput(ri, $event)"
              @keydown="onColorNameKey(ri, $event)"
              @blur="closeSuggest"
            />
            <button
              class="mx-x"
              type="button"
              :data-act="`${act}-del`"
              :aria-label="`删除颜色 ${r.color || ri + 1}`"
              :title="delColorTitle(r)"
              :disabled="disabled"
              @click="delColor(ri)"
            >
              ✕
            </button>
          </div>
          <button
            class="mx-add"
            type="button"
            :data-act="`${act}-add`"
            :disabled="disabled"
            title="新增一色（新色对所有现有尺码默认都在卖）"
            @click="addColor"
          >
            ＋ 颜色
          </button>
        </div>
      </div>

      <div class="mx-line">
        <span class="mx-line__k">尺码</span>
        <div class="mx-chips">
          <span v-for="(s, si) in matrix.sizes" :key="`s${si}`" class="mx-chip">
            <input
              class="wb-input mx-chip__input"
              :value="s"
              :data-act="`${act}-size`"
              :aria-label="`第 ${si + 1} 个尺码`"
              :placeholder="`码${si + 1}`"
              :disabled="disabled"
              @input="onSizeInput(si, $event)"
            />
            <button
              class="mx-chip__x"
              type="button"
              :data-act="`${act}-del-size`"
              :aria-label="`删除尺码 ${s || si + 1}`"
              :disabled="disabled"
              @click="delSize(s)"
            >
              ✕
            </button>
          </span>
          <button
            class="mx-add"
            type="button"
            :data-act="`${act}-add-size`"
            :disabled="disabled"
            title="新增一码（新码对所有现有颜色默认都在卖）"
            @click="addSize"
          >
            ＋ 尺码
          </button>
          <!-- 常用码：一次补齐 S/M/L/XL，不用逐个「+」再逐个敲字 -->
          <details class="mx-preset">
            <summary class="mx-add mx-add--menu">常用 ▾</summary>
            <div class="mx-preset__menu">
              <button
                v-for="p in SIZE_PRESETS"
                :key="p.key"
                class="mx-preset__item"
                type="button"
                :data-act="`${act}-preset`"
                :data-preset="p.key"
                :disabled="disabled || !presetMissing(p).length"
                @click="addPreset(p, $event)"
              >
                <span>{{ p.label }}</span>
                <span class="wb-muted">{{
                  presetMissing(p).length ? `+${presetMissing(p).length}` : '已有'
                }}</span>
              </button>
            </div>
          </details>
        </div>
      </div>

      <!-- 整款克重（2026-10-25 提为克重录入的主入口）。
           真库里多数款**整款一个克重**（连帽风衣 6 码全 500g、卫衣套装全 800g），
           原来这个入口叫「批量值 / 填空格」，藏在这一行的中间位置，实际没人用 —— 于是 40 格逐格敲。
           现在：输入框写明「整款」，主按钮把格数写在脸上，右边常显**当前**共同值
           （`当前 500 g` / `当前 混填`）—— 填之前先知道现状，才不会重复劳动或覆盖掉已核对的值。 -->
      <div class="mx-line">
        <span class="mx-line__k" :title="copy.weightHint">克重</span>
        <div class="mx-weights">
          <!-- 同样不用 `type=number`：滚轮滚过会改掉批量值，紧接着一次"填空格"就把错值写进全表 -->
          <input
            v-model="defaultWeight"
            class="wb-input mx-weights__input"
            type="text"
            inputmode="numeric"
            placeholder="整款"
            :data-act="`${act}-default-weight`"
            aria-label="整款克重（克）"
            title="整款填一个数，再点右边的按钮铺开：默认只补空着的格，不动已经核对过的值"
            :disabled="disabled"
            @keydown.enter.prevent="fillEmpty"
          />
          <span class="mx-weights__unit wb-muted">g</span>
          <button
            class="wb-btn wb-btn--sm"
            type="button"
            :data-act="`${act}-fill`"
            :disabled="!canFill"
            :title="emptyWeightCount ? `只填还没填的 ${emptyWeightCount} 格，已填的不动` : '没有待填的格了'"
            @click="fillEmpty"
          >
            {{ fillLabel }}
          </button>
          <button
            v-if="canOverwrite"
            class="wb-link wb-link--danger mx-weights__all"
            type="button"
            :data-act="`${act}-fill-all`"
            title="所有组合都改成这个值 —— 会覆盖已经填过的克重"
            @click="fillAll"
          >
            全部覆盖
          </button>
          <span v-if="commonWeightText" class="mx-weights__now wb-muted" :data-act="`${act}-common-weight`">
            {{ commonWeightText }}
          </span>
        </div>
      </div>
    </section>

    <!-- ── 组合（矩阵）：行 = 颜色，列 = 尺码，格 = 在不在卖 + 该码克重 ────────── -->
    <div class="mx-bar">
      <span class="mx-bar__title">组合</span>
      <span class="mx-bar__stat wb-muted" :data-act="`${act}-stat`">{{ statText }}</span>
      <!-- 合并的回执：只在刚拖完那几秒出现（不占布局高度，收起后矩阵不跳）。
           它出现时**顶掉图例**（两者都是次要说明）：否则一行放不下，flex-wrap 会把
           图例挤到第二行 ⇒ 下面矩阵整体下移十几像素，看着像界面错位。 -->
      <!-- 拖动中的实时落点提示：**顶掉图例与上一条回执**（它此刻最重要）。
           没有这句的话，"现在松手会发生什么"只能靠 chip 上的虚线猜 —— 而这正是用户说的
           「拖动还是不太方便」：不知道有没有瞄准、不知道会合并还是改名。
           放在最前：上一次合并的回执要亮 8 秒，若排在它后面，刚开始拖就被旧回执盖住。 -->
      <span
        v-if="dragActive"
        class="mx-bar__drop"
        :data-act="`${act}-drop-hint`"
        title="拖到上面一排「常用色」= 归到这个规范色名；拖到另一个颜色的名字上 = 两个色合并成一个"
      >
        {{ dropHintText }}
      </span>
      <span
        v-else-if="undoBulk"
        class="mx-bar__merged mx-bar__merged--undo"
        :data-act="`${act}-bulk-undo-hint`"
        :title="undoBulk.label"
      >
        <span class="mx-bar__undo-text">{{ undoBulk.label }}</span>
        <button
          class="wb-link mx-bar__undo"
          type="button"
          :data-act="`${act}-bulk-undo`"
          title="把刚才那一整行 / 整列的开关收回去"
          @click="undoBulkAction"
        >
          撤销
        </button>
      </span>
      <span
        v-else-if="mergeHint"
        class="mx-bar__merged"
        :data-act="`${act}-merge-hint`"
        :title="mergeHint"
      >
        {{ mergeHint }}
      </span>
      <span
        v-else
        class="mx-bar__legend wb-muted"
        title="空格 = 这个组合不存在（不是 0 克）；点行名 / 列头可整行、整列开关；按住拖过几格可连续勾选"
        >空格 = 不存在 · 点行/列头批量开关</span
      >
    </div>

    <div class="wb-table-wrap mx-wrap" :class="{ 'mx-wrap--fill': fillHeight }">
      <table class="wb-table mx-table">
        <thead>
          <tr>
            <th class="mx-c-row">颜色</th>
            <!-- 列头 = 整列开关（点一下：这一码全部开；已经全开时点一下 = 整列取消）。
                 列头本身就是"这一列"的代表，比在每格里找 ＋ 快一个数量级；
                 尺码**改名**不在这里（在规格区的 chip 里，见 `onSizeInput` 的说明）。 -->
            <th v-for="(s, si) in matrix.sizes" :key="`h${si}`" class="mx-c-size">
              <button
                class="mx-size-name mx-bulk"
                type="button"
                :data-act="`${act}-col-all`"
                :data-size="s"
                :aria-pressed="columnAllOn(s)"
                :title="
                  columnAllOn(s)
                    ? `「${s || '无码'}」这一列已全开 —— 点一下整列取消（这些组合保存时会被删掉，可按「撤销」收回）`
                    : `点一下把「${s || '无码'}」这一列的 ${matrix.rows.length} 个组合全开`
                "
                :disabled="disabled || !matrix.rows.length"
                @click="toggleColumn(s)"
              >
                {{ s || '无码' }}
              </button>
            </th>
          </tr>
          <!-- 第二行 = 这一码的克重（2026-10-25）。
               为什么单开一行而不是塞进「克重」那一行：克重的真实粒度是**款 × 码**，
               不是"格"也不是"款" —— 真库 303 个已填克重的 SKU 里，按「产品 + 尺码」分组后
               86 组有 2 色以上的组**全部**"同码各色一模一样"（0 组不一致）。典型款整款一个值
               （连帽风衣 6 码全 500g），少数款是阶梯（L500→XL600→XXL700→3XL800）。
               所以填整款值解决多数款，填列头解决阶梯款 —— 两种都是"填一次管一片"，
               而逐格填 40 次里最多只有 6 次带着新信息。
               列头这个框显示的是**该列现有的共同值**（派生显示，不落库）：
               空白 = 这一列还没填、或各色不一致（后者占位写「混合」）。 -->
          <tr class="mx-head-w">
            <th class="mx-c-row">
              <span class="mx-head-w__k" title="每个尺码一个值：填了就铺到该码下所有存在的组合（不动别的码，也不造新组合）">
                码克重
              </span>
            </th>
            <th v-for="(s, si) in matrix.sizes" :key="`hw${si}`" class="mx-c-size">
              <input
                class="wb-input mx-colw"
                type="text"
                inputmode="numeric"
                :value="colWeightValue(s)"
                :placeholder="colWeightPlaceholder(s)"
                :data-act="`${act}-col-weight`"
                :data-size="s"
                :aria-label="`尺码 ${s || '无码'} 的整列克重（克）`"
                :title="`填一个数 ⇒ 「${s || '无码'}」这一列所有组合都改成它（不动其它码，不造新组合）`"
                :disabled="disabled || !matrix.rows.length"
                @change="applyColWeight(s, $event)"
                @keydown.enter.prevent="blurTarget($event)"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, ri) in matrix.rows"
            :key="`r${ri}`"
            :data-act="`${act}-row`"
            :class="{ 'is-flagged': flagged(r) }"
            :style="rowAccent(r)"
          >
            <td class="mx-c-row">
              <div class="mx-rowhead">
                <!-- 行头的图也能点开看大图（`-row-thumb`）：认色名时眼睛在表里，不该逼人回到上面找 -->
                <button
                  v-if="rowImage(r)"
                  class="mx-thumb-btn"
                  type="button"
                  :data-act="`${act}-row-thumb`"
                  :aria-label="`放大查看${r.color || '这一色'}的色图`"
                  :title="thumbTitle(r)"
                  @click="openViewer(r)"
                >
                  <img
                    :src="rowImage(r)"
                    class="wb-thumb mx-thumb"
                    alt=""
                    referrerpolicy="no-referrer"
                  />
                  <span class="mx-thumb-btn__zoom" aria-hidden="true">⤢</span>
                </button>
                <span
                  v-else
                  class="wb-thumb wb-thumb--empty mx-thumb"
                  :style="swatchStyle(r.color)"
                  :title="`${r.color || '这一色'}没有采到代表图（色块按色名近似）`"
                ></span>
                <!-- 行名 = 整行开关（色名本身在规格区改；这里点一下 = 这一色所有码全开/全取消） -->
                <button
                  class="mx-rowhead__name mx-bulk"
                  type="button"
                  :data-act="`${act}-row-all`"
                  :aria-pressed="rowAllOn(r)"
                  :title="
                    rowAllOn(r)
                      ? `「${r.color || '这一色'}」已全开 —— 点一下整行取消`
                      : `点一下把「${r.color || '这一色'}」这一行的 ${matrix.sizes.length} 个组合全开`
                  "
                  :disabled="disabled || !matrix.sizes.length"
                  @click="toggleRow(ri)"
                >
                  {{ r.color || '（未命名）' }}
                </button>
              </div>
            </td>
            <td
              v-for="(s, si) in matrix.sizes"
              :key="`c${ri}-${si}`"
              class="mx-cell"
              :class="{ 'is-off': !hasCell(r, s) }"
            >
              <!-- 一格 = 一个输入框（2026-10-25）。
                   以前是「✓ 开关 + 克重框」两个控件挤在 78px 里：8 色 5 码就是 80 个控件，
                   而人在这儿要回答的是**一个**问题 —— 这个组合在不在卖、多重。
                   现在三态都长在同一个框上：空 = 不存在（虚线 ＋）、✓ = 存在但克重待填、数字 = 有值。
                   "加入一个组合并填上重量"于是从「点 ✓ → 再点输入框 → 敲数」变成「敲数」一步。
                   ⚠️ 空格里敲 0 或非数字**不造 SKU**（`normWeightG` 归零），与 `toggleMatrixCell` 同语义：
                      合成一个控件是为了少点两下，不是为了多出几条空壳 SKU。 -->
              <input
                :value="weightDisplay(r, s)"
                class="wb-input mx-weight"
                :class="{ 'is-off': !hasCell(r, s) }"
                type="text"
                inputmode="numeric"
                :placeholder="hasCell(r, s) ? '待填' : '＋'"
                :data-act="`${act}-weight`"
                :data-cell-row="ri"
                :data-cell-size="s"
                :data-cell-on="hasCell(r, s) ? '1' : '0'"
                :aria-label="cellLabel(r, s)"
                :title="cellTitle(r, s)"
                :disabled="disabled"
                @input="onWeightInput(r, s, $event)"
                @keydown.enter.prevent="focusNextWeight(ri, s)"
                @keydown.down.prevent="focusWeightAt(ri + 1, s)"
                @keydown.up.prevent="focusWeightAt(ri - 1, s)"
                @keydown.delete="onWeightDelete(ri, s, $event)"
              />
            </td>
          </tr>
          <tr v-if="!matrix.rows.length">
            <td class="mx-empty" :colspan="1 + matrix.sizes.length" :data-act="`${act}-empty`">
              {{ emptyHint }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 看大图。⚠️ 这是一层**嵌套**的 `.wb-mask`（外面的编辑器弹层本身就是一层）：
         遮罩一律 `position: fixed`（见 styles/index.css 的说明），因此不受本组件任何祖先的
         `overflow: hidden/auto` 裁剪 —— 也就是说它盖的是整个窗口，不是那个 40vh 的表格容器。
         `@click.self` 只关自己：点大图的遮罩不该把整个编辑器一起关掉。 -->
    <div v-if="viewer" class="wb-mask" :data-act="`${act}-viewer`" @click.self="closeViewer">
      <div
        class="wb-dialog mx-viewer"
        role="dialog"
        aria-modal="true"
        :aria-label="`查看${viewer.color || '这一色'}的图`"
      >
        <div class="wb-dialog__head mx-viewer__head">
          <span class="mx-viewer__color">{{ viewer.color || '这一色' }}</span>
          <span class="wb-muted mx-viewer__src" :data-act="`${act}-viewer-src`">{{ viewerSrc }}</span>
          <button
            class="mx-viewer__x"
            type="button"
            :data-act="`${act}-viewer-close`"
            aria-label="关闭大图"
            @click="closeViewer"
          >
            ✕
          </button>
        </div>
        <div class="wb-dialog__body mx-viewer__body">
          <img
            :src="viewer.src"
            class="mx-viewer__img"
            alt=""
            referrerpolicy="no-referrer"
            :data-act="`${act}-viewer-img`"
          />
          <p class="mx-viewer__note wb-muted">{{ viewerNote }}</p>
        </div>
      </div>
    </div>

    <!-- 色名候选（归类 / 合并的"点选"路径）。
         为什么用 `Teleport` + `fixed`：`.mx-colors` 现在不再滚动（2026-10-25 起全部展开），
         但祖先仍是"抽屉 + 首屏容器"两层 `overflow`，`absolute` 浮层照样会被裁；
         抽屉的进出场动画还会改包含块。挂到 body 上一次躲掉这三件事。 -->
    <Teleport to="body">
      <div
        v-if="suggestFor !== null && suggestList.length"
        class="mx-suggest"
        :style="suggestStyle"
        role="listbox"
        :aria-label="'色名候选：归类或合并'"
        :data-act="`${act}-color-suggest`"
        @pointerdown.prevent
      >
        <div class="mx-suggest__hint">点一个 = 归类 / 合并</div>
        <template v-for="g in suggestGroups" :key="g.key">
          <!-- 分组标题：8 色时"合并两行"有六七项，没有标题就分不清"哪些是字典色、哪些是旁边的行" -->
          <div class="mx-suggest__group">{{ g.title }}</div>
          <button
            v-for="it in g.items"
            :key="it.key"
            class="mx-suggest__item"
            :class="{ 'is-active': suggestList.indexOf(it) === suggestActive }"
            type="button"
            role="option"
            :aria-selected="suggestList.indexOf(it) === suggestActive ? 'true' : 'false'"
            :data-act="`${act}-color-suggest-item`"
            :data-suggest-kind="it.kind"
            :title="it.note"
            @pointerenter="suggestActive = suggestList.indexOf(it)"
            @click="pickSuggest(it)"
          >
            <span class="mx-suggest__dot" :style="{ background: it.swatch ?? 'transparent' }"></span>
            <span class="mx-suggest__name">{{ it.label }}</span>
            <span class="mx-suggest__note wb-muted">{{ it.note }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  addMatrixColor,
  addMatrixSize,
  classifyMatrixColor,
  countFilledWeightCells,
  fillMatrixSizeWeight,
  fillMatrixWeight,
  isUnknownColorName,
  matrixWeightCommon,
  mergeMatrixColor,
  normWeightG,
  removeMatrixColor,
  removeMatrixSize,
  renameMatrixSize,
  setMatrixColumnCells,
  setMatrixRowCells,
  skuMatrixComboCount,
  type SkuMatrix,
  type SkuMatrixRow,
} from '@/lib/skuMatrix';
import { COMMON_COLORS, findSwatch } from '@/lib/colorSwatch';

/**
 * SKU 矩阵编辑器 —— 产品编辑抽屉（矩阵的唯一维护面）与建款向导**共用同一个**组件。
 *
 * 结构（2026-10-24 收紧，用户口径：「SKU 样式是乱的、有很多重叠；颜色不直观；文字太多」）：
 *   ┌ 规格 ─────────────────────────────────────────────┐
 *   │ 颜色（色图/色块 + 色名 chip）· 尺码（chip + 常用码）│  ← 三行，每行 ~30px
 *   │ 克重（批量值 + 填空格 / 覆盖）                      │
 *   ├ 组合（矩阵）──────────────────────────────────────┤
 *   │ 行 = 颜色，列 = 尺码，格 = ✓在卖 + 该码克重        │  ← 吃掉剩余高度
 *   └───────────────────────────────────────────────────┘
 *
 * 为什么从"色卡列表"改成"chip"：2026-10-17 那版把色图/色名做成 196px 的卡片，7 色 × 7 码时
 * 规格区实测 330px、矩阵只剩 180px（一屏三行组合），而且整块还带着三段说明文字 ——
 * 用户说的「乱、重叠、文字太多」讲的就是这一屏。现在色图缩到 26px 塞进 chip，
 * 规格区 ~110px，矩阵能拿到 300px 以上；说明一律进 `title`。
 *
 * 颜色为什么要色块：行的身份是色名，14 行汉字扫不动。`lib/colorSwatch.ts` 按色名给近似色
 * （`酒红` ≠ `红`，最长匹配），**只作显示**，不参与任何匹配 / 落库。
 *
 * ⚠️ 四条不能破的约束（细节与取证见 `src/lib/skuMatrix.ts` 头部注释）：
 *   ① **空格 = 这个组合不存在**。展开回平面数组时只输出存在的格 —— 不许替空缺补一条，
 *      否则"取消一个格"会变成"凭空造一个 SKU"。批量填克重同理：**只填存在的格**。
 *   ② **行身份 = 色图 + 色名**（`skuMatrix.ts#skuRowKey`）：同名不同图必须各占一行。
 *   ③ **界面不显示的字段照样原样带回**：`price` 已从界面撤掉，但它躺在格子里跟数据走到保存
 *      （本仓铁律：漏传字段 = 静默清空）。
 *   ④ **克重是「格」的属性**（色 × 码各一个值），不是行、更不是款。
 *
 * 三处调用（采集弹层 / 建款向导 / 产品编辑抽屉）的差异只走 props，不复制组件：
 *   · 弹层 `act="se"`（沿用既有 `data-act` 名字，既有冒烟断言自动重挂）；
 *   · 向导 `act="iw-sku"`、行头图为空时回落商品主图（`fallbackImageUrl`）；
 *   · 产品抽屉 `act="ed"`：行的身份是**色名**（产品 SKU 没有色图），文案按"色 + 码必须成对"覆盖（`copy`），
 *     缩略图是本地款色图，点开时经 `resolveViewerImage` 换原图。
 *
 * 看大图：认色名靠对图确认，而 34px 缩略图看不清印花与深浅 ⇒ 规格卡与矩阵行头**两处都**能点开。
 * 查看是**只读**动作，因此 `disabled` 时不隐藏（数据锁住也得让人看清颜色）。弹层是**嵌套**遮罩，
 * 点它只关自己。
 */
/**
 * 三处界面共用的文案。默认值是**采集快照**口径；产品侧的调用方（产品编辑抽屉）
 * 传 `copy` 覆盖 —— 产品 SKU 必须同时有颜色和尺码，且色图只作显示，这两句说错会误导人。
 */
interface MatrixCopy {
  /** 还没有尺码时 chips 区的空态 */
  sizeEmptyHint: string;
  /** 「克重」这个词的解释（挂在标签上的 title —— 术语说明跟着它走，不占正文） */
  weightHint: string;
  /** 看大图时来源标签 */
  imageLabel: string;
  /** 看大图时表格下方的说明（非回落图） */
  imageNote: string;
}

/**
 * ⚠️ 这里刻意只有三句：规格区顶部那句总说明、表格底部那段总说明都已删掉
 * （2026-10-24 用户口径「文字也太多了」）。剩下的解释一律放进 `title`——
 * 想知道的人悬停即见，不想知道的人不必先读三行字才能开始改 SKU。
 */
const DEFAULT_COPY: MatrixCopy = {
  // ⚠️ 别写成「从「常用」…」：悬空入口名守卫（`tests/uxEntryNames.spec.ts`）把 `从「X」` 当
  //    "让用户去某个入口"，而「常用」是**本组件自己画的一个下拉按钮**、不是导航入口。
  //    它不是不能写，而是不能用导航动词写（写成"用「常用」"= 指着眼前这个控件）。
  sizeEmptyHint: '还没有尺码 —— 点「＋ 尺码」逐个加，也可以用「常用」一次补齐。',
  weightHint: '单个 SKU 的重量（克）',
  imageLabel: '平台色图',
  imageNote: '这是采集到的这一色代表图，保存时随该行的每一格落库（行的身份就是它）。',
};

const props = withDefaults(
  defineProps<{
    /** `data-act` 前缀（弹层 `se` / 向导 `iw-sku` / 产品编辑 `ed`）—— 既有断言按名字认控件，别改 */
    act: string;
    /**
     * 行头图为空时的**显示**回落（向导回落商品主图，弹层不给 —— 色图就是色图，不拿主图冒充）。
     * ⚠️ 只影响显示：落库永远用 `row.imageUrl` 原值，回落图不会被当成色图写进款色。
     */
    fallbackImageUrl?: string;
    disabled?: boolean;
    emptyHint?: string;
    /** 覆盖默认文案（产品侧传：产品 SKU 必须色 + 码成对、色图只作显示） */
    copy?: Partial<MatrixCopy>;
    /**
     * 「点开看大图」时换成原图（产品编辑抽屉的缩略图是本地 256px，放大要重新读原图）。
     * 返回 null = 拿不到原图，继续显示缩略图。
     */
    resolveViewerImage?: (row: SkuMatrixRow) => Promise<string | null>;
    /**
     * 吃满父容器剩余高度（产品编辑抽屉的右栏用它）。
     *
     * 关着的时候沿用 `max-height: 40vh` —— 那是"弹层里不许把弹层顶出去"的兜底，
     * 采集快照弹层与建款向导仍是那个场景；产品抽屉是整窗高的两栏，40vh 反而把表格压成一条。
     */
    fillHeight?: boolean;
  }>(),
  {
    fallbackImageUrl: '',
    disabled: false,
    fillHeight: false,
    emptyHint: '这个商品还没有 SKU —— 点「颜色 › + 添加」手动补（列表页轻采不带矩阵；在商品详情页点「采 SKU」后重开即有）。',
  }
);

const copy = computed<MatrixCopy>(() => ({ ...DEFAULT_COPY, ...(props.copy ?? {}) }));

/**
 * v-model：整个矩阵对象。结构变更（加/删行、切换格、批量填）走 `skuMatrix.ts` 的纯函数**整体替换**，
 * 行内文本编辑（色名 / 尺码 / 单格克重）直接写字段 —— 后者若也整体替换，每次击键都会重建行对象，
 * 输入框会跟着重建（失焦）。
 */
const matrix = defineModel<SkuMatrix>({ required: true });

/** 本组件的根（键盘跳格 / 拖拽要按 DOM 找"下一格"，不能靠模板 ref 数组 —— 行列会变） */
const rootEl = ref<HTMLElement | null>(null);

/** 界面上的"实心格"数（= 眼前有多少个组合在卖）。空名/空码的格也算 —— 它就在那儿 */
const combos = computed(() => skuMatrixComboCount(matrix.value));

const filledWeights = computed(() => countFilledWeightCells(matrix.value));

/** 组合区的摘要：几色几码几个组合 + 克重填了多少（"还差几格"是这块最该一眼看到的进度） */
const statText = computed(() => {
  const base = `${matrix.value.rows.length} 色 × ${matrix.value.sizes.length} 码 · ${combos.value} 个组合`;
  return combos.value ? `${base} · 克重 已填 ${filledWeights.value}/${combos.value}` : base;
});

/** 还没填克重的格数：只在**存在的格**里数（空格不存在，谈不上待填） */
const emptyWeightCount = computed(() => Math.max(0, combos.value - filledWeights.value));

/**
 * 整表现有的克重共同值（全部存在的格字面相同才 >0）。
 *
 * 只作**显示**：填之前先让人看清"这款现在是 500"还是"混着"，否则要么重复劳动，
 * 要么一按覆盖把核对过的值抹平。派生值不落库 —— 它不是第二个真相。
 */
const commonWeight = computed(() => matrixWeightCommon(matrix.value));

const commonWeightText = computed(() => {
  if (commonWeight.value > 0) return `当前 ${commonWeight.value} g`;
  return filledWeights.value ? '当前 混填' : '';
});

/** 主按钮的文案把"将要发生什么、影响几格"写在脸上（原来叫「填空格（39）」，要读括号才懂） */
const fillLabel = computed(() =>
  emptyWeightCount.value ? `铺到空着的 ${emptyWeightCount.value} 格` : '已全部填好',
);

/**
 * 默认克重（界面态，不落库 —— 它只是"给新格子的初值 + 批量填的来源"）。
 *
 * 刻意**不**从现有数据里猜一个初值：猜错的话，人加一色就静默给十几格打上一个错误的克重，
 * 而克重会进成本/运费计算。空着 = 新格保持「待填」，人想批量填就自己敲 + 点按钮。
 * （"现在到底多重"由旁边那行 `当前 500 g` 回答 —— 那是只读事实，不是输入框的初值。）
 */
const defaultWeight = ref<string>('');
const weightValue = computed(() => normWeightG(defaultWeight.value));
const canFill = computed(() => weightValue.value > 0 && emptyWeightCount.value > 0 && !props.disabled);
const canOverwrite = computed(() => weightValue.value > 0 && combos.value > 0 && !props.disabled);

function hasCell(r: SkuMatrixRow, size: string): boolean {
  return Object.prototype.hasOwnProperty.call(r.cells, size);
}

/** 该列已有的格数（列头 placeholder 要靠它区分"待填"与"混填"） */
function columnCellCount(size: string): number {
  return matrix.value.rows.filter((r) => hasCell(r, size)).length;
}

function columnFilledCount(size: string): number {
  let n = 0;
  for (const r of matrix.value.rows) {
    const c = r.cells[size];
    if (c && normWeightG(c.weightG) > 0) n += 1;
  }
  return n;
}

/**
 * 克重输入框显示什么。
 *
 * ⭐ **0 显示成空**（占位「待填」）：0 是内部语义"没填"，可它在输入框里长得像一个真实的数字
 * （实测截图：整张表一列 `0`，人会以为"这些 SKU 是 0 克"，而 0 克的数据会一路进成本/运费）。
 * 空 + 占位符才是"还没填"该有的样子。
 */
function weightDisplay(r: SkuMatrixRow, size: string): string {
  const w = normWeightG(r.cells[size]?.weightG);
  return w > 0 ? String(w) : '';
}

/**
 * 单元格输入（2026-10-25：一格只剩这一个控件，于是它同时管"在不在卖"和"多重"）。
 *
 * 刻意**不用 v-model**：值为 0 时要显示空串，而 v-model 会把 0 原样画进框里。
 * 写回的是归一整数值（负数/非数 ⇒ 0 = 待填）；输入过程中的原文不动，避免打字时光标跳。
 *
 * ⭐ 空格里敲进一个正数 ⇒ **当场建这个组合**（这是"加入 + 填值"一步完成的关键）。
 * 但敲 0 / 非数字 / 退格成空 ⇒ **什么都不做**：空格仍然是不存在。
 * 这条与 `skuMatrix.ts` 的第一条不变量同源 —— 少点两下的前提是不能凭空多出空壳 SKU
 * （空壳会落成 `weight_g = 0` 的真 SKU，进成本/运费时按 0 算）。
 */
function onWeightInput(r: SkuMatrixRow, size: string, e: Event): void {
  const w = normWeightG((e.target as HTMLInputElement).value);
  const cell = r.cells[size];
  if (!cell) {
    if (w <= 0) return;
    // 新组合没有 variantId：与 `toggleMatrixCell` 重新加回来的格同语义（删了再建就是新 SKU）
    r.cells[size] = { price: '', weightG: w };
    return;
  }
  cell.weightG = w;
}

/**
 * Delete 键：输入框**为空**时移除这个组合；有内容时让浏览器照常删字符。
 *
 * 为什么两段式：一次 Delete 就把一整条 SKU 抹掉太危险（克重会进成本/运费，而且保存后是真删）。
 * 先清空（值 ⇒ 0 = 待填，组合还在）再按一次才移除 —— 中间那一步肉眼可见，也不会误伤。
 */
function onWeightDelete(rowIndex: number, size: string, e: KeyboardEvent): void {
  if (props.disabled) return;
  const el = e.target as HTMLInputElement;
  if (el.value !== '') return; // 有内容：交给浏览器删字符（不 preventDefault）
  e.preventDefault();
  const r = matrix.value.rows[rowIndex];
  if (!r || !hasCell(r, size)) return;
  delete r.cells[size];
  flashHint(`已移除「${r.color || '这一色'} ${size || '无码'}」这个组合（按底部「完成」后落库）`);
}

function cellLabel(r: SkuMatrixRow, size: string): string {
  const name = `${r.color || '这一色'} ${size || '无码'}`;
  return hasCell(r, size)
    ? `${name} 的克重（克）；清空后按 Delete 可移除此组合`
    : `${name}：不存在，直接输入克重即加入`;
}

function cellTitle(r: SkuMatrixRow, size: string): string {
  if (!hasCell(r, size)) return `${r.color || '这一色'} ${size || '无码'} · 不存在｜直接敲克重就加入`;
  const tail = weightDisplay(r, size) ? '' : '（克重待填）';
  return `${r.color || '这一色'} ${size || '无码'} · 在卖${tail}｜回车到下一色 · ↑↓ 换行 · 清空后 Delete 移除`;
}

/** 行的显示图：优先自己的色图，其次（仅向导）回落商品主图 */
function rowImage(r: SkuMatrixRow): string {
  return r.imageUrl || props.fallbackImageUrl || '';
}

/**
 * 这一行显示的是**自己的色图**还是**回落的主图**。
 *
 * 两件事都由它决定（别再各写一遍，否则"图上写的是一个说法、弹层里是另一个"）：
 * ① 缩略图的 title / 大图弹层的来源标签；② 大图下面那句说明。
 * ⚠️ 它只影响**显示**：落库永远用 `row.imageUrl` 原值，回落图不会被当成色图写进款色。
 */
function isFallbackImage(r: SkuMatrixRow): boolean {
  return !r.imageUrl && !!props.fallbackImageUrl;
}

function thumbTitle(r: SkuMatrixRow): string {
  const what = r.imageUrl
    ? `${r.color || '这一色'}的代表图`
    : isFallbackImage(r)
      ? '这一色没采到图，显示的是商品主图（保存不会用它当色图）'
      : '这一色没有采到代表图';
  return `${what} · 点击看大图`;
}

// ---- 看大图 ----------------------------------------------------------------
// 为什么要有：这两个界面的核心动作之一就是"**认色名**"（平台给的是数字色号或英文色名，
// 得人对着图确认），而 34px 的缩略图看不清印花和深浅 —— 用户口径：「点击色图展示大图」。
// 图是平台 URL（或 smoke 夹具的 data URL），`<img>` 直接放大即可，不需要走 IPC 读原图。
/** 看图弹层；null = 关着 */
const viewer = ref<{ src: string; color: string; fallback: boolean } | null>(null);

/** 原图在途时用户可能已经关掉/换了一张：只认最后一次打开 */
let viewerToken = 0;

const viewerSrc = computed(() => (viewer.value?.fallback ? '商品主图（回落）' : copy.value.imageLabel));

const viewerNote = computed(() =>
  viewer.value?.fallback
    ? '这一色没采到图，这里显示的是商品主图。它只是显示上的回落 —— 保存不会拿它当色图（色图的来源只有商品详情页那次采集）。'
    : copy.value.imageNote
);

function openViewer(r: SkuMatrixRow): void {
  const src = rowImage(r);
  if (!src) return; // 没图的行根本渲染不出这个按钮；这里再兜一次，免得将来有人从别处调
  const token = ++viewerToken;
  const fallback = isFallbackImage(r);
  viewer.value = { src, color: r.color, fallback };
  if (fallback || !props.resolveViewerImage) return;
  // 先画缩略图，原图到了再替换 —— 认色名不该等一次磁盘读取
  void props
    .resolveViewerImage(r)
    .then((full) => {
      if (!full || token !== viewerToken || !viewer.value) return;
      viewer.value = { ...viewer.value, src: full };
    })
    .catch(() => {
      // 原图读不出来就继续显示缩略图（看图是辅助动作，不该因此弹错）
    });
}

function closeViewer(): void {
  viewerToken++;
  viewer.value = null;
}

/**
 * 大图开着时 Esc 关它。
 *
 * ⚠️ 判据里必须带 `viewer.value`：监听器常驻 window，没这个守卫就会把 Esc 从别处抢走。
 * 本仓没有全局 Esc 绑定（AppShell 只管 ⌘K / ⌘[），所以这里不冲突。
 */
function onViewerKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && viewer.value) closeViewer();
}

/** 页面被切到后台（最小化 / 切标签）：拖动状态一律丢弃，理由见 `abortDrag` */
function onVisibilityChange(): void {
  if (document.hidden) abortDrag();
}
onMounted(() => {
  window.addEventListener('keydown', onViewerKey);
  window.addEventListener('blur', abortDrag);
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onViewerKey);
  window.removeEventListener('blur', abortDrag);
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pointerup', onAnyPointerUp); // 拖色归类进行中被卸载
  if (undoBulkTimer) clearTimeout(undoBulkTimer);
});

/** 「认不出标准色名」——判据在 `skuMatrix.ts#isUnknownColorName`（与向导的计数同源） */
function flagged(r: SkuMatrixRow): boolean {
  return isUnknownColorName(r.color);
}

/** 认不出时的说明（挂在名字旁的橙点上；不再给整卡 / 整行铺底色） */
const flagHint =
  '订单域认不出这个色名（不是标准色名）—— 会按原文保留，不影响这里保存；把它拖到上面「常用色」里的某个色上即可归成标准色名';

/**
 * 色名 → 近似色块（没有色图时的占位）。认不出返回空对象 = 保持原来的空白虚线框。
 * ⚠️ 只作显示：不参与匹配，也不落库（见 `lib/colorSwatch.ts` 的说明）。
 */
function swatchStyle(color: string): Record<string, string> {
  const hex = findSwatch(color);
  if (!hex) return {};
  return { background: hex, borderColor: hex };
}

/** 整行左侧那道 3px 色条：14 行时靠它认行（同样只作显示，认不出就不画） */
function rowAccent(r: SkuMatrixRow): Record<string, string> {
  return { '--mx-accent': findSwatch(r.color) ?? 'transparent' };
}

/**
 * 常用码：一次补齐一整档，不用"点 ＋、敲字"十来遍。
 * 只补缺的（已有的不动）—— 批量动作必须幂等，否则重复点会打乱列序。
 */
const SIZE_PRESETS: ReadonlyArray<{ key: string; label: string; sizes: string[] }> = [
  { key: 'basic', label: 'S M L XL', sizes: ['S', 'M', 'L', 'XL'] },
  { key: 'full', label: 'S–XXL', sizes: ['S', 'M', 'L', 'XL', 'XXL'] },
  { key: 'free', label: '均码', sizes: ['均码'] },
];

function presetMissing(p: { sizes: string[] }): string[] {
  return p.sizes.filter((s) => !matrix.value.sizes.includes(s));
}

function addPreset(p: { sizes: string[] }, ev?: Event): void {
  if (props.disabled) return;
  // 点完就收起：菜单开着会一直盖住下面的矩阵（它是不占布局的浮层）
  (ev?.currentTarget as HTMLElement | null)?.closest('details')?.removeAttribute('open');
  const missing = presetMissing(p);
  if (!missing.length) return;
  let next = matrix.value;
  for (const s of missing) next = addMatrixSize(next, s, weightValue.value);
  matrix.value = next;
}

/** 焦点落到第 N 个尺码输入（新增 / 空码时都走它 —— 敲字不用再拿鼠标点一下） */
async function focusSizeAt(index: number): Promise<void> {
  await nextTick();
  const el = rootEl.value?.querySelectorAll<HTMLInputElement>(`[data-act="${props.act}-size"]`)[index];
  el?.focus();
  el?.select();
}

/** 焦点落到最后一个色名输入（「＋ 颜色」之后直接敲名字） */
async function focusLastColor(): Promise<void> {
  await nextTick();
  const els = rootEl.value?.querySelectorAll<HTMLInputElement>(`[data-act="${props.act}-color"]`);
  const el = els?.[els.length - 1];
  el?.focus();
  el?.select();
}

async function addColor(): Promise<void> {
  if (props.disabled) return;
  matrix.value = addMatrixColor(matrix.value, '', '', weightValue.value);
  await focusLastColor();
}

/**
 * 常用色（矩阵顶部那一排）。
 *
 * 点一个**已经在矩阵里**的色不再加一行（那会造出两行同名色，保存时被校验拦下），
 * 而是把焦点递到那一行上 —— 用户的意图多半是"这个色在这儿，我要改它"。
 * 判断按**去空白后的全等**：`黑` 与 `黑色` 是两个色名，不做同义猜测（合并是人看着图做的判断）。
 *
 * 2026-10-24 晚：这一排同时是**拖放的落点**（见 `classifyInto`）。所以"打勾"的判据必须和
 * "拖上去会发生什么"是同一个：勾 = 矩阵里已经有这个色名 = 拖上去是**并入已有行**；
 * 没勾 = 拖上去是**原地改名**。两处若用两套判据，用户会看到"打勾了却新加一行"。
 */
const presentColors = computed(
  () =>
    new Set(
      matrix.value.rows.map((r) => String(r.color ?? '').trim()).filter((c) => !!c)
    )
);

function hasColor(color: string): boolean {
  const c = String(color ?? '').trim();
  return !!c && presentColors.value.has(c);
}

/**
 * 常用色这一排 = 字典色 + **这个款已经在用的颜色**。
 *
 * 2026-10-25 用户口径「常用色需要增加已设置的颜色」：原来这排只有 10 个写死的字典色，
 * 「酒红 / 灰白 / 深蓝」这类自己起的色名永远不在里面 —— 于是同一个色名第二次要手打一遍，
 * 打字就会漂（`灰白` / `灰白色` / `灰 白` 各成一行，同色不同行）。
 *
 * 顺序上字典色在前（大多数人要的是黑/白/红），自己的色跟在后面、并且天然是打勾态
 * （它就在矩阵里）—— 打勾的意思是"拖上去 = 并进这一行"，不是"点了会加一行"。
 */
const paletteColors = computed<string[]>(() => {
  const out: string[] = [...COMMON_COLORS];
  const seen = new Set(out);
  for (const r of matrix.value.rows) {
    const c = String(r.color ?? '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
});

function pcTitle(c: string): string {
  const dragged = dragActive.value
    ? String(matrix.value.rows[dragSrc.value ?? -1]?.color ?? '').trim()
    : '';
  if (dragActive.value && dragged) {
    return dragged === c
      ? `松手：不改变（「${c}」已经是这个色名）`
      : hasColor(c)
        ? `松手：把「${dragged}」并进已有的「${c}」（同码合并，只留一张色图）`
        : `松手：把「${dragged}」归到「${c}」（原地改色名，SKU 与色图都保留）`;
  }
  return hasColor(c) ? `矩阵里已经有「${c}」了` : `加一色「${c}」（现有尺码全码都在卖）`;
}

async function pickCommon(color: string): Promise<void> {  if (props.disabled) return;
  const at = matrix.value.rows.findIndex((r) => String(r.color ?? '').trim() === String(color).trim());
  if (at >= 0) {
    await nextTick();
    const el = rootEl.value?.querySelectorAll<HTMLInputElement>(`[data-act="${props.act}-color"]`)[at];
    el?.focus();
    el?.select();
    return;
  }
  matrix.value = addMatrixColor(matrix.value, color, '', weightValue.value);
}

/**
 * 删一色的提示：这一行里有**已经落库的 SKU**（格子里带 `variantId`）时要说清代价 ——
 * 删行是立刻的，`variantDelete` 在保存那一刻才发（见 `ProductEditorDrawer` 的保存确认框），
 * 所以"点一下就没了"和"保存后才没了"这两件事必须在这一行上说清楚。
 */
function delColorTitle(r: SkuMatrixRow): string {
  const saved = Object.values(r.cells).filter((c) => Number(c.variantId) > 0).length;
  const name = String(r.color ?? '').trim() || '这一色';
  return saved
    ? `删掉「${name}」这一行：保存后会连同它已落库的 ${saved} 个 SKU 一起删除`
    : `删掉「${name}」这一行（它还没有落库的 SKU）`;
}

/* ---- 拖色：归类到常用色 / 合并到另一个色 ------------------------------------
   用户口径（2026-10-24）：「通过拖动颜色方式来合并」→「拖动操作还是不太方便 …
   拖动颜色里的项，拖动到常用色中进行归类，最终存储的以常用色为主」。

   两个落点、两种语义：
   · **落到「常用色」的某个 chip 上** = 归类（`classifyMatrixColor`）：矩阵里已有这个色名
     ⇒ 并进那一行；没有 ⇒ 原地改名。落库色名因此总是字典里的写法（即"以常用色为主"）。
   · **落到另一个色名 chip 上** = 两行合并（`mergeMatrixColor`）：目标名由矩阵内容决定，
     处理"两个色都不在字典里"的情况（`香芋紫` 之类）。
   为什么把常用色也做成落点：下面那排 chip 又小又会长成一模一样的输入框，瞄准它很难；
   顶部这 10 个靶子是固定的、每个都自带色块和名字 —— 拖上去不会拖错"旁边那一格"。

   实现取舍：
   · **不用 HTML5 拖放**：chip 里有 `<input>`，`draggable` 会和"拖选文字"抢事件；
   · **不用 pointer capture**：捕获会把 `pointermove` 全部锁在源元素上，合成事件（冒烟）里
     `setPointerCapture` 还可能直接抛 `InvalidStateError`。落点就在同一个组件里，
     所以监听挂在**根元素**上（原来挂在 `.mx-colors` 上 —— 那样鼠标一离开那一条
     就收不到 move/up，根本拖不到上面的常用色），靠 `elementFromPoint` 命中落点；
   · 另挂一个 `window` 级 `pointerup`：松手落在组件外（比如矩阵表格上）也必须结束拖动，
     否则状态会卡在"拖动中"（鼠标已经抬起，界面还灰着一片）；
   · 阈值 6px：小于它算"点击"（点 input / 缩略图 / ✕ 时要保持原行为）。
   `pointerdown` 只记起点，**不改数据** —— 一次普通点击不能被算成一次合并。
*/
const dragSrc = ref<number | null>(null);
const dragOver = ref<number | null>(null);
/** 拖动中悬停的常用色（`''` = 没悬停在任何常用色上） */
const dropPalette = ref('');
const dragActive = ref(false);
const mergeHint = ref('');
let mergeHintTimer: ReturnType<typeof setTimeout> | null = null;
let chipDrag: { index: number; x: number; y: number; fromField: boolean } | null = null;
/** 拖过之后的第一次 click 要吞掉（`@click.capture` 里读它） */
let swallowClick = false;

/** 拖动中那一句"现在松手会发生什么"（占的是图例/回执那一格，不额外占高度） */
const dropHintText = computed(() => {
  const from = matrix.value.rows[dragSrc.value ?? -1];
  const name = String(from?.color ?? '').trim() || '这一色';
  if (dropPalette.value) {
    const to = dropPalette.value;
    return hasColor(to) ? `松手：把「${name}」并进「${to}」` : `松手：把「${name}」改名为「${to}」`;
  }
  if (dragOver.value !== null) {
    const dst = matrix.value.rows[dragOver.value];
    const to = String(dst?.color ?? '').trim() || '这一色';
    return `松手：把「${name}」并进「${to}」`;
  }
  return '拖到上面「常用色」= 归类；拖到另一个颜色上 = 合并';
});

function onChipDown(index: number, e: PointerEvent): void {
  if (props.disabled) return;
  if (e.button !== 0) return; // 右键 / 中键不参与（否则会先记下起点、再被右键菜单吞掉 pointerup）
  const el = e.target as HTMLElement | null;
  // ⚠️ 这里**只**排除"按下就该让位"的一类，绝不能写成 `closest('input,button')`：
  //    色图裹在 `<button class="mx-thumb-btn">` 里（为了能点开看大图），那正是要按住拖的手柄。
  //    连 button 一起排除的后果是——**凡是有色图的色，整条都拖不动**，只剩没采到图的空色块能拖。
  //    用户看到的就是「根本没办法操作」。v-click vs 拖动由 6px 阈值区分，见 `onChipMove`。
  if (el?.closest('[data-act$="-del"]')) return; // ✕ 是独立动作，不该被拖走
  // 色名输入框**也算抓手**（2026-10-25 用户口径「拖动区域太小」）：
  // 原来这里一行 `closest('input') ⇒ return`，把整条 chip 唯一能按的地方压成了 26px 的色图；
  // 而 chip 有 125px 宽，人的手指/指针落在色名上的概率远大于落在色图上 —— 于是"拖十次动不了一次"。
  // 冲突（拖选色名文字 vs 拖这一行）由方向判据解决，见 `onChipMove`。
  chipDrag = { index, x: e.clientX, y: e.clientY, fromField: !!el?.closest('input,textarea,select') };
}

function onChipMove(e: PointerEvent): void {
  if (!chipDrag) return;
  if (!dragActive.value) {
    const dx = e.clientX - chipDrag.x;
    const dy = e.clientY - chipDrag.y;
    if (chipDrag.fromField) {
      // 在色名框里按下的两种意图：横向 = 拖选文字（保持原生行为），竖向为主 = 拖这一行。
      // 门槛 10px 且必须"竖向明显大于横向"，所以想选文字的人不会被半路改行、想拖行的人也不必先挪到色图上。
      if (Math.abs(dy) < 10 || Math.abs(dy) <= Math.abs(dx) + 4) return;
      // 已经拖出的文字选区要清掉：否则整段色名一路跟着变蓝，看着像"选了一大块"
      window.getSelection()?.removeAllRanges();
    } else if (Math.hypot(dx, dy) < 6) {
      return; // 还没离开"点击"的范围
    }
    dragActive.value = true;
    dragSrc.value = chipDrag.index;
    closeSuggest(); // 拖动开始：色名框刚聚焦弹出来的候选列表要让位，否则它挡着落点
    window.addEventListener('pointerup', onAnyPointerUp, { once: true });
  }
  resolveDropAt(e.clientX, e.clientY);
}

/**
 * 落点判定：从"必须点中矩形"改成"离谁最近"。
 *
 * 为什么改（2026-10-25 实测）：常用色胶囊只有 42×22，颜色行 chip 高 30 且与胶囊行只隔 6px。
 * 要求指针精确落在矩形内，等于要求人手做 40px 级的定位 —— 用户口径就是「拖动区域太小」。
 * 现在每个候选矩形向外放宽（横向 16px / 纵向 12px），在放宽后仍然命中的候选里取**距离最近**的一个：
 * · 落点面积从 42×22 变成 74×46（约 3.7 倍），落在胶囊之间的空隙里也算命中最近的胶囊；
 * · 胶囊行与颜色行只隔 6px，靠"谁更近"天然互斥，不需要给常用色偷一个优先级
 *   （定优先级会把颜色行最上面 4px 判给常用色 —— 想把 A 行拖到紧邻的 B 行时正好落进那个缝）。
 * 不用 `elementFromPoint` 的另一个好处：指针压在 chip 内的 input 上、或压在两个 chip 的
 * 4px 间隙里时，几何判定照样给出稳定答案。
 */
const DROP_PAD_X = 16;
const DROP_PAD_Y = 12;

/** 点到矩形的距离；超出放宽范围 ⇒ null（不参与竞争） */
function dropDistance(r: DOMRect, x: number, y: number): number | null {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  if (dx > DROP_PAD_X || dy > DROP_PAD_Y) return null;
  return Math.hypot(dx, dy);
}

function resolveDropAt(x: number, y: number): void {
  let bestPc: { name: string; d: number } | null = null;
  let bestRow: { at: number; d: number } | null = null;
  const root = rootEl.value;
  if (root) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-mx-pc]')) {
      const d = dropDistance(el.getBoundingClientRect(), x, y);
      if (d === null) continue;
      if (!bestPc || d < bestPc.d) bestPc = { name: el.dataset.mxPc ?? '', d };
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-mx-row]')) {
      const at = Number(el.dataset.mxRow);
      if (!Number.isFinite(at) || at === dragSrc.value) continue; // 拖回自己身上不算落点
      const d = dropDistance(el.getBoundingClientRect(), x, y);
      if (d === null) continue;
      if (!bestRow || d < bestRow.d) bestRow = { at, d };
    }
  }
  if (bestPc && (!bestRow || bestPc.d <= bestRow.d)) {
    dropPalette.value = bestPc.name;
    dragOver.value = null;
    return;
  }
  dropPalette.value = '';
  dragOver.value = bestRow ? bestRow.at : null;
}

/** 松手落在组件外（矩阵表格、抽屉空白处）时也要收尾 —— 见上面 `window` 监听的说明 */
function onAnyPointerUp(e: PointerEvent): void {
  if (dragActive.value) resolveDropAt(e.clientX, e.clientY);
  endDrag();
}

/**
 * 拖动被**外部**打断（切窗口 / 窗口失焦 / 页面隐藏）：直接丢弃，不判落点。
 *
 * 为什么要有：拖到窗口外松手时，`pointerup` 可能压根不派发（窗口已不聚焦），
 * `chipDrag` 就会留着 —— 之后鼠标一进组件、只要移动超过 6px，界面就自己进入"拖动中"
 * （整片色块变灰虚线），再随便点一下就真做了一次合并。用户看到的是"页面自己乱动、没法操作"。
 */
function abortDrag(): void {
  chipDrag = null;
  window.removeEventListener('pointerup', onAnyPointerUp);
  dragActive.value = false;
  dragSrc.value = null;
  dragOver.value = null;
  dropPalette.value = '';
}

function onChipUp(e?: PointerEvent): void {
  if (dragActive.value && e) resolveDropAt(e.clientX, e.clientY);
  endDrag();
}

function endDrag(): void {
  const src = dragSrc.value;
  const to = dragOver.value;
  const pc = dropPalette.value;
  const active = dragActive.value;
  chipDrag = null;
  window.removeEventListener('pointerup', onAnyPointerUp);
  dragActive.value = false;
  dragSrc.value = null;
  dragOver.value = null;
  dropPalette.value = '';
  if (!active || src === null) return; // 普通点击 / 松在空白处
  // 真的拖过了：松手之后浏览器还会补一次 click，落点若在缩略图按钮上就是"打开大图"——
  // 那层遮罩是全屏 fixed，拖完颜色顺手弹出来，看着就像"页面被锁住了动不了"。吞掉这一次。
  swallowClick = true;
  setTimeout(() => {
    swallowClick = false;
  }, 0);
  if (pc) {
    classifyInto(src, pc);
    return;
  }
  if (to !== null) mergeColorInto(src, to);
}

/** 拖过之后的第一次 click 一律不认（见 `endDrag` 的说明） */
function onRootClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}

function flashHint(text: string): void {
  mergeHint.value = text;
  if (mergeHintTimer) clearTimeout(mergeHintTimer);
  mergeHintTimer = setTimeout(() => {
    mergeHint.value = '';
    mergeHintTimer = null;
  }, 8000);
}

/* ---- 色名候选：改名即归类 / 合并 ------------------------------------------
   为什么要有这一条（2026-10-25）：「拖动」是把两件事画在一个手势上，天生要求精度 ——
   目标只有 42×22，源与目标只隔 6px，人手一次定位偏 20px 就落空（用户口径「拖动区域太小」）。
   而"这一色该叫什么"本质是**挑一个词**，挑词不该用手势：点进色名框，候选就摆在下面。
   于是同一个动作有两条路 —— 会拖的拖（快），不想拖的点（准），两条都通向 `classifyInto` /
   `mergeColorInto`，**落库语义只有一份**。

   候选列表的顺序就是决策顺序：先"归到常用色"（这条产品线认可的叫法），再"并进其它行"
   （两个色都不在字典里时的兜底，如 `香芋紫`）。每项后面的说明写清"会发生什么"，
   因为"归类"与"合并"的区别是**搬格子 vs 原地改名**，光看色名看不出来。 */
const suggestFor = ref<number | null>(null);
const suggestQuery = ref('');
const suggestAnchor = ref<{ left: number; top: number; bottom: number; width: number } | null>(null);
const suggestActive = ref(0);

type SuggestItem = {
  key: string;
  label: string;
  note: string;
  swatch: string | null;
  kind: 'common' | 'row';
  rowIndex?: number;
};

const suggestList = computed<SuggestItem[]>(() => {
  const at = suggestFor.value;
  if (at === null) return [];
  const q = suggestQuery.value.trim().toLowerCase();
  const self = String(matrix.value.rows[at]?.color ?? '').trim();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const out: SuggestItem[] = [];
  for (const c of COMMON_COLORS) {
    if (c === self || !hit(c)) continue;
    out.push({
      key: `pc:${c}`,
      label: c,
      // 判据与拖动的落点提示同源（`hasColor`）：勾着 ⇒ 并进已有行，没勾 ⇒ 原地改名。
      // 两处若用两套判据，会出现"候选说合并、实际新加一行"。
      // 文案刻意只有四个字：这一列每行都要读，写全（"归类（原地改名，SKU 不丢）"）会占掉一半宽度
      // 又把名字挤成省略号 —— 解释放在 title 与分组标题里，不重复 9 遍。
      note: hasColor(c) ? '并入已有' : '归类',
      swatch: findSwatch(c) ?? null,
      kind: 'common',
    });
  }
  matrix.value.rows.forEach((r, i) => {
    if (i === at) return;
    const name = String(r.color ?? '').trim();
    if (!name || !hit(name)) return;
    if (COMMON_COLORS.includes(name)) return; // 上面已经列过，不重复
    out.push({
      key: `row:${i}`,
      label: name,
      note: '合并两行',
      swatch: findSwatch(name) ?? null,
      kind: 'row',
      rowIndex: i,
    });
  });
  return out;
});

/** 按组渲染：「归到常用色」是主路径（色名不规范 → 归到字典写法），「并入其它颜色」是兜底 */
const suggestGroups = computed<{ key: string; title: string; items: SuggestItem[] }[]>(() => {
  const groups: { key: string; title: string; items: SuggestItem[] }[] = [];
  for (const it of suggestList.value) {
    const title = it.kind === 'common' ? '归到常用色' : '并入其它颜色';
    const last = groups[groups.length - 1];
    if (last && last.title === title) {
      last.items.push(it);
    } else {
      groups.push({ key: `${it.kind}-${groups.length}`, title, items: [it] });
    }
  }
  return groups;
});

/**
 * 浮层位置：贴着色名框下沿，下面放不下就翻到**上方**（上方用 `bottom` 定位：
 * 内容少时也贴着输入框，不会在顶边留一大片空白）。
 *
 * 高度按**可用空间**给，不给固定 264：8 色 × 5 码时"并入其它颜色"有六七项，
 * 固定高度会把它整段藏在滚动条下面 —— 用户看到的候选里永远没有"合并两行"。
 */
const suggestStyle = computed<Record<string, string> | undefined>(() => {
  const a = suggestAnchor.value;
  if (!a) return undefined;
  const width = Math.max(a.width + 90, 200);
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const below = vh - a.bottom - 14;
  const above = a.top - 14;
  const flip = below < 260 && above > below;
  const maxH = Math.max(160, Math.min(400, flip ? above : below));
  const left = `${Math.min(Math.max(8, a.left), vw - width - 8)}px`;
  const style: Record<string, string> = { left, width: `${width}px`, maxHeight: `${maxH}px` };
  if (flip) style.bottom = `${vh - a.top + 6}px`;
  else style.top = `${a.bottom + 6}px`;
  return style;
});

function openSuggest(index: number, e: Event): void {
  const el = e.target as HTMLInputElement | null;
  if (!el?.getBoundingClientRect) return;
  const r = el.getBoundingClientRect();
  suggestAnchor.value = { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
  suggestFor.value = index;
  // 聚焦时**不过滤**（空 query = 列全部）：把框里现有的色名当搜索词的话，
  // 一点进「藏青」就什么都剩不下 —— 用户看到的是"点了没反应"，而他要的恰恰是"换一个词"。
  suggestQuery.value = '';
  suggestActive.value = 0;
}

function closeSuggest(): void {
  if (suggestFor.value === null) return;
  suggestFor.value = null;
  suggestAnchor.value = null;
  suggestQuery.value = '';
  suggestActive.value = 0;
}

/**
 * 点浮层外面就收起。
 * 光靠色名框的 `blur` 不够：点到矩阵格子、空白处时焦点**没有转移**（那里不可聚焦），
 * input 不 blur ⇒ 浮层一直飘在矩阵上挡视线，用户以为"卡住了"。
 */
function onDocPointerDown(e: PointerEvent): void {
  if (suggestFor.value === null) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('.mx-suggest')) return; // 点候选本身
  if (t?.closest(`[data-act="${props.act}-color"]`)) return; // 同一格/另一格色名框：由 focus 换锚点
  closeSuggest();
}

function pickSuggest(item: SuggestItem): void {
  const at = suggestFor.value;
  closeSuggest();
  if (at === null) return;
  if (item.kind === 'common') {
    classifyInto(at, item.label);
    return;
  }
  if (item.rowIndex != null) mergeColorInto(at, item.rowIndex);
}

/** 点已经聚焦的色名框也要能重新打开（Esc / 点外面关掉之后，焦点还在原处 ⇒ 不会再触发 focus） */
function onColorNameClick(index: number, e: Event): void {
  if (suggestFor.value === index) return; // 已经开着：别把正在输入的关键字清掉
  openSuggest(index, e);
}

/** 色名框里打字：候选跟着过滤（聚焦后才想起来要改名的，这里补开一次） */
function onColorNameInput(index: number, e: Event): void {
  const el = e.target as HTMLInputElement;
  if (suggestFor.value !== index) {
    // 只有**真的拿着焦点**才弹浮层：程序化写值（导入合并、脚本、自动改写）不该在半空
    // 里长出一个菜单 —— 它挡着下面的矩阵，而且用户下一步点的可能是别处。
    if (document.activeElement !== el) return;
    openSuggest(index, e);
  }
  suggestQuery.value = el.value;
  suggestActive.value = 0;
}

/**
 * 色名框的键盘：↑↓ 选候选、Enter 采用、Esc 收起。
 * ⚠️ Enter 有候选时必须 `preventDefault` —— 这个组件挂在表单里，不拦就会连带提交整个表单
 * （用户改个色名，抽屉被关掉）。
 */
function onColorNameKey(index: number, e: KeyboardEvent): void {
  if (suggestFor.value !== index) {
    if (e.key === 'ArrowDown') {
      openSuggest(index, e);
      e.preventDefault();
    }
    return;
  }
  const n = suggestList.value.length;
  if (e.key === 'ArrowDown' && n) {
    suggestActive.value = (suggestActive.value + 1) % n;
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowUp' && n) {
    suggestActive.value = (suggestActive.value - 1 + n) % n;
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    closeSuggest();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    const item = suggestList.value[suggestActive.value];
    if (item) {
      e.preventDefault();
      pickSuggest(item);
    }
  }
}

/**
 * 归类到常用色：落库的色名取**字典写法**（用户口径「最终存储的以常用色为主」），
 * 已有同名行就并进去（一个色只留一张色图）。
 */
function classifyInto(from: number, canonical: string): void {
  const a = matrix.value.rows[from];
  if (!a) return;
  const name = String(canonical ?? '').trim();
  const before = String(a.color ?? '').trim() || '这一色';
  const res = classifyMatrixColor(matrix.value, from, name);
  if (res.matrix === matrix.value) {
    if (before === name) flashHint(`「${name}」本来就是常用色，不用再归类`);
    return;
  }
  matrix.value = res.matrix;
  const saved = Object.values(a.cells).filter((c) => Number(c.variantId) > 0).length;
  flashHint(
    res.merged
      ? `已把「${before}」归到「${name}」：搬 ${res.moved} 格` +
          (res.conflicts ? ` · ${res.conflicts} 个同码格以「${name}」为准` : '') +
          (res.dropped ? `（保存后少 ${res.dropped} 个 SKU）` : '') +
          ' · 这个色只留一张色图'
      : `已把「${before}」归到「${name}」（落库色名 = ${name}）：${saved || Object.keys(a.cells).length} 个 SKU 原地改名，色图保留`
  );
}

function mergeColorInto(from: number, to: number): void {
  const a = matrix.value.rows[from];
  const b = matrix.value.rows[to];
  if (!a || !b) return;
  const res = mergeMatrixColor(matrix.value, from, to);
  if (res.matrix === matrix.value) return;
  const fromName = String(a.color ?? '').trim() || '这一色';
  const toName = String(b.color ?? '').trim() || '这一色';
  matrix.value = res.matrix;
  flashHint(
    `已把「${fromName}」并入「${toName}」：搬 ${res.moved} 格` +
      (res.conflicts ? ` · ${res.conflicts} 个同码格以「${toName}」为准` : '') +
      (res.dropped ? `（保存后少 ${res.dropped} 个 SKU）` : '')
  );
}

/**
 * 新增一码。
 *
 * ⚠️ 尺码按**名字**去重（`addMatrixSize` 同名直接返回原矩阵），所以"已经有一个没起名的码"
 * 时再点「＋ 尺码」是**静默无反应** —— 用户会以为按钮坏了（2026-10-24 用户口径"操作不便捷"）。
 * 这里改成：有空格就选中它让人填，没有才真加一列。新增之后焦点跟到新码上。
 */
async function addSize(): Promise<void> {
  if (props.disabled) return;
  const blank = matrix.value.sizes.indexOf('');
  if (blank >= 0) {
    await focusSizeAt(blank);
    return;
  }
  matrix.value = addMatrixSize(matrix.value, '', weightValue.value);
  await focusSizeAt(matrix.value.sizes.length - 1);
}

function delColor(index: number): void {
  matrix.value = removeMatrixColor(matrix.value, index);
}

function delSize(size: string): void {
  matrix.value = removeMatrixSize(matrix.value, size);
}

/* ---- 整行 / 整列开关（列头与行名就是开关）--------------------------------
   为什么要它：一款 14 色 × 10 码时，"这一色全都卖"或"这一码全都卖"是**一句话**就能说清的事，
   而逐格点是 14 / 10 次点击。列头与行名在矩阵里本来就是"这一列 / 这一行"的代表。
   语义是"应该是"而不是"反过来"：已经全开时点一下 = 整行/整列取消（见 `setMatrixRowCells`）。

   ⚠️ 取消整列 = 那一列的 SKU 从矩阵里全没了、保存时被判成"要删"，而"点列头"和"填这一列的克重"
      在屏幕上只隔 22px —— 用户实报「克重都填好了，保存还说黑色 L / 白色 L / 红色 L 会被删掉」
      正是踩到这条。所以每次整行/整列开关都给一条**带「撤销」的回执**：误点当场可收回。 */
const undoBulk = ref<{ matrix: SkuMatrix; label: string } | null>(null);
let undoBulkTimer: ReturnType<typeof setTimeout> | null = null;

function markBulk(label: string, before: SkuMatrix): void {
  undoBulk.value = { matrix: before, label };
  if (undoBulkTimer) clearTimeout(undoBulkTimer);
  undoBulkTimer = setTimeout(() => {
    undoBulk.value = null;
    undoBulkTimer = null;
  }, 12000);
}

function undoBulkAction(): void {
  if (!undoBulk.value) return;
  matrix.value = undoBulk.value.matrix;
  undoBulk.value = null;
  if (undoBulkTimer) clearTimeout(undoBulkTimer);
  undoBulkTimer = null;
  flashHint('已撤销刚才那一整行 / 整列的开关');
}

function rowAllOn(r: SkuMatrixRow): boolean {
  const sizes = matrix.value.sizes;
  return sizes.length > 0 && sizes.every((s) => hasCell(r, s));
}

function columnAllOn(size: string): boolean {
  const rows = matrix.value.rows;
  return rows.length > 0 && rows.every((r) => hasCell(r, size));
}

function toggleRow(index: number): void {
  const r = matrix.value.rows[index];
  if (!r || props.disabled) return;
  const on = rowAllOn(r);
  const before = matrix.value;
  const next = setMatrixRowCells(matrix.value, index, !on, weightValue.value);
  if (next === matrix.value) return;
  matrix.value = next;
  const color = r.color || '这一色';
  markBulk(
    on
      ? `已取消「${color}」整行 ${matrix.value.sizes.length} 个组合（保存时会列为删除）`
      : `已把「${color}」整行 ${matrix.value.sizes.length} 个组合全开`,
    before,
  );
}

function toggleColumn(size: string): void {
  if (props.disabled) return;
  const on = columnAllOn(size);
  const before = matrix.value;
  const next = setMatrixColumnCells(matrix.value, size, !on, weightValue.value);
  if (next === matrix.value) return;
  matrix.value = next;
  const rows = matrix.value.rows.length;
  markBulk(
    on
      ? `已取消「${size || '无码'}」整列 ${rows} 个组合（保存时会列为删除）`
      : `已把「${size || '无码'}」整列 ${rows} 个组合全开`,
    before,
  );
}

/* ---- 列头克重（按码填一次，2026-10-25）-----------------------------------
   真库里少数款是码阶梯（L500→XL600→XXL700→3XL800→4XL850→5XL900）：
   逐格填是 18 次，按码填是 3 次。这里刻意**覆盖**（不是只填空）——
   在列头敲一个数是"这一码就是这个重量"的明确声明，若还只填空，人得先逐格清空才能改。
   覆盖面用一句回执说清（`flashHint`），并在落库前还能靠「放弃改动并关闭」整体撤销。 */
function colWeightValue(size: string): string {
  const w = matrixWeightCommon(matrix.value, size);
  return w > 0 ? String(w) : '';
}

function colWeightPlaceholder(size: string): string {
  if (!columnCellCount(size)) return '—'; // 这一码一个组合都没有，填了也没地方落
  return columnFilledCount(size) ? '混填' : '待填';
}

function applyColWeight(size: string, e: Event): void {
  if (props.disabled) return;
  const el = e.target as HTMLInputElement;
  const w = normWeightG(el.value);
  if (w <= 0) {
    el.value = colWeightValue(size); // 清空 / 非数字 ⇒ 还原成这一列的真实状态，不写任何格
    return;
  }
  if (!matrix.value.rows.length) {
    el.value = '';
    flashHint('还没有颜色行 —— 先加一个颜色，再填这一码的克重');
    return;
  }
  const had = columnCellCount(size);
  const missing = matrix.value.rows.length - had;
  // ⭐ `createMissing`：列头敲数 = "这一码整列都是这个重量"的声明 ⇒ 缺的格一起补上。
  //    不补的话，人填完 L 列再保存，那三格仍算"不存在" ⇒ 旧 SKU 被当成要删的（用户实报）。
  const next = fillMatrixSizeWeight(matrix.value, size, w, { onlyEmpty: false, createMissing: true });
  if (next === matrix.value) {
    el.value = String(w); // 输入的是 "0700" 这类写法，还原成规范值（列已经很整齐了）
    flashHint(`「${size || '无码'}」这一列 ${had} 个组合已经都是 ${w} g`);
    return;
  }
  matrix.value = next;
  el.value = String(w);
  const parts = [`「${size || '无码'}」这一列改成 ${w} g`];
  if (missing) parts.push(`补齐 ${missing} 个原本没有的组合`);
  flashHint(parts.join(' · '));
}

/** 列头按 Enter ⇒ 失焦（change 自然触发一次）。刻意**不**直接调 applyColWeight：
 *  直接调会让"Enter 一次"变成"change + Enter 各一次"，第二遍只留下"已经都是 X g"的回执。 */
function blurTarget(e: KeyboardEvent): void {
  (e.target as HTMLElement | null)?.blur();
}

/* ---- 键盘走格 -------------------------------------------------------------
   一格一个输入框之后，键盘就是主要输入方式：一列填下来不必再碰鼠标。
   ↑↓ 换行（Enter 也是，见 `focusNextWeight`）—— 因为按码填的人是在**一列**里往下走。 */
function cellInputs(): HTMLInputElement[] {
  return Array.from(
    rootEl.value?.querySelectorAll<HTMLInputElement>(`[data-act="${props.act}-weight"]`) ?? []
  );
}

function focusWeightAt(rowIndex: number, size: string): void {
  const el = cellInputs().find(
    (i) => Number(i.dataset.cellRow) === rowIndex && i.dataset.cellSize === size
  );
  if (!el) return; // 越界（第一行按 ↑ / 最后一行按 ↓）什么都不做
  el.focus();
  el.select();
}

/**
 * 克重格按 Enter ⇒ 跳到**同一列的下一格**（同色号的下一色）。
 *
 * 为什么是列不是行：填克重时人按的是一个"尺码"的整列（同一个码在不同颜色上差别最小），
 * 一行里跳来跳去反而要重读码名。没有下一格就什么都不做（不弹错、不绕回第一格 ——
 * 绕回去会让人以为自己没离开过，接着把值打到已经填好的格上）。
 */
function focusNextWeight(rowIndex: number, size: string): void {
  const inputs = cellInputs();
  const at = inputs.findIndex(
    (el) => Number(el.dataset.cellRow) === rowIndex && el.dataset.cellSize === size
  );
  if (at < 0) return;
  for (let i = at + 1; i < inputs.length; i++) {
    if (inputs[i].dataset.cellSize === size) {
      inputs[i].focus();
      inputs[i].select();
      return;
    }
  }
}

/** 只填还没填的格（默认动作 —— 不覆盖人已经核对过的值） */
function fillEmpty(): void {
  if (!canFill.value) return;
  matrix.value = fillMatrixWeight(matrix.value, weightValue.value, { onlyEmpty: true });
}

/** 覆盖全部（破坏性：必须是人另外点的一个按钮，永不作为批量的默认行为） */
function fillAll(): void {
  if (!canOverwrite.value) return;
  matrix.value = fillMatrixWeight(matrix.value, weightValue.value, { onlyEmpty: false });
}

/**
 * 尺码列改名。⚠️ 用 `:value` + `@input` 而不是 `v-model`：改名要走 `renameMatrixSize`
 * （整列的格跟着搬），若用 v-model 直接改 `sizes[i]`，格还挂在旧 key 上 ⇒ 界面上看着改了、
 * 保存时那一列的格全丢。
 */
function onSizeInput(index: number, e: Event): void {
  const next = (e.target as HTMLInputElement).value;
  matrix.value = renameMatrixSize(matrix.value, matrix.value.sizes[index], next);
}
</script>

<style scoped>
.mx {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* 吃满父容器（产品编辑抽屉的右栏）：规格区按内容给高，矩阵拿走剩下的全部高度。
   ⚠️ 这里**不能**写 `min-height: 0`（2026-10-25 修）。它确实让 flex 子项能无限收缩，
   但 `.mx` 里还有**按内容撑高**的规格区与 `min-height: 140px` 的表格容器 ——
   一旦可用高度不足，`.mx` 会被压到几十像素，而内部内容照样按自己的高度画出来、
   **溢出到 `.mx` 之外**，直接盖住抽屉里排在它下面的「SKU 编码」区（用户实报
   「打开 SKU 编码编辑时被上面的组合遮挡了」，就是这个）。改成 `min-content`：
   矩阵最低缩到"规格区 + 140px 表格"，再不够就让右栏整体滚动 —— 不许叠在一起。 */
.mx--fill {
  flex: 1 1 auto;
  min-height: min-content;
}
.mx--fill .mx-spec {
  flex: none;
}
/* ---- 规格区 ----------------------------------------------------------------
   三行"标签 + 内容"，每行 ~30px。标签列 40px（"颜色/尺码/克重"三个两字词，再宽就是白占地方），
   行距 6px：靠间距分组，不靠加框（框一多整页就脏）。 */
.mx-spec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  min-width: 0;
}
.mx-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.mx-line__k {
  flex: 0 0 40px;
  padding-top: 6px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--wb-text-muted);
}

/* ---- 常用色（顶部那一排）----------------------------------------------------
   22px 的小胶囊，比下面的颜色 chip 更矮 —— 它只是"加一个色"的快捷方式，不是数据本身
   （数据在下面那行）。已经在矩阵里的**变灰打勾**：这一排于是同时回答"还差哪些色没加"，
   而且点它不会造出第二行同名色（只把焦点递过去）。 */
.mx-line--palette .mx-line__k {
  padding-top: 3px;
}
.mx-palette {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.mx-pc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 24px：这一排同时是拖放的落点，22px 时"点在胶囊上下边缘"会脱靶（2026-10-25 实测） */
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--wb-text);
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  cursor: pointer;
}
.mx-pc:hover:not(:disabled) {
  border-color: var(--wb-border-strong);
}
.mx-pc__dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.mx-pc.is-in {
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
  border-style: dashed;
}
.mx-pc.is-in::after {
  content: '✓';
  font-size: 10px;
}
/* 拖动中：这一排就是落点，全部描边提亮（否则"能不能往这儿拖"全靠猜）。
   不加高、不加 padding —— 拖到一半布局跳一下，落点会从指针底下跑掉。 */
.mx-palette--dragging .mx-pc {
  border-color: var(--wb-focus);
  border-style: dashed;
  background: var(--wb-surface);
  cursor: copy;
}
/* 悬停中的那一个：实心描边 + 外环 + 反白，与"整排可拖"区分开（一半亮度不够区分"将落到哪个"） */
.mx-palette--dragging .mx-pc.is-drop,
.mx-palette--dragging .mx-pc.is-drop.is-in {
  color: var(--wb-primary-contrast);
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  border-style: solid;
  box-shadow: 0 0 0 2px var(--wb-focus-ring);
}
.mx-palette--dragging .mx-pc.is-drop .mx-pc__dot {
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.12),
    0 0 0 1.5px #fff;
}

/* 颜色 chip：色图/色块 26px + 色名 + 删除。一屏能放下十来个（原来一张卡 196px，
   7 色就吃掉 330px，矩阵只剩三行）。
   2026-10-25 用户口径「颜色中的项要完全展示，不要出现滚动条」⇒ 原来那两档
   `max-height: 96px / 64px` + `overflow-y: auto` 全删。代价是 14 色时颜色区占 3~4 行、
   矩阵整体下移 —— 但"少两个色看不见、还得多滚一次"是更坏的代价（而且被裁掉的那半行
   看着像"这个色不存在"）。 */
.mx-colors {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
/* 拖色合并进行中：整片区域不吃文字选择（否则拖过色名会顺手把文字选中，看着像选中了整行） */
.mx-colors--dragging {
  cursor: grabbing;
  user-select: none;
}
.mx-color {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  transition: border-color 0.15s ease;
}
.mx-color:hover {
  border-color: var(--wb-border-strong);
}
/* 焦点在 chip 内 ⇒ 整条描边，指出"现在改的是哪一色"（14 色时很关键） */
.mx-color:focus-within {
  border-color: var(--wb-focus);
  box-shadow: 0 0 0 2px var(--wb-focus-ring);
}
/* 拖色合并：源 chip 半透明 + 虚线（"我要被搬走了"），目标 chip 实线加粗 + 浅底
   （"放这儿"）。两个状态必须**不同**形态，只改颜色的话在浅色主题下几乎看不出来。 */
.mx-color.is-src {
  opacity: 0.45;
  border-style: dashed;
}
.mx-color.is-drop {
  border-color: var(--wb-focus);
  border-style: dashed;
  background: var(--wb-focus-ring);
}
.mx-color__img {
  /* 28px：它首先是**拖动手柄**（2026-10-25 由 26 放大）。
     真正的抓手其实扩到了整条 chip —— 按住色名竖向拖也算拖行，见 `onChipDown` 的注释。 */
  width: 28px;
  height: 28px;
  flex: none;
  /* 色图/色块就是**拖动手柄**（名字那格是输入框，拖它等于拖选文字）。
     光标必须自己说这件事：会拖的人不看 title。 */
  cursor: grab;
  touch-action: none;
  /* ⚠️ `<img>` 在 Chromium 里**默认可拖**：不关掉的话从缩略图按下会先起一个原生图片拖放，
     `dragstart` 一来指针事件就断了，`pointerup` 永远等不到 —— 真机上表现为"拖不动"，
     而冒烟的合成 PointerEvent 根本走不到这条原生路径（合成事件恒绿）。 */
  -webkit-user-drag: none;
  user-select: none;
}
.mx-colors--dragging .mx-color__img {
  cursor: grabbing;
}
/* chip 里的色图首先是**拖动手柄**，其次才是"点一下看大图"：光标给 grab 而不是放大镜。
   行头那张（矩阵行首）保持 zoom-in —— 那里没有拖动，只有看大图。
   两处光标不同不是洁癖：光标是唯一不用悬停等 title 就能读到的操作提示。 */
.mx-color .mx-thumb-btn {
  cursor: grab;
  touch-action: none;
}
.mx-colors--dragging .mx-color .mx-thumb-btn {
  cursor: grabbing;
}
.mx-color__name {
  width: 76px;
  height: 24px;
  padding: 0 3px;
  font-size: 12px;
  /* chip 自己已经是框，输入框再画一圈就是双层边框 */
  border-color: transparent;
  background: transparent;
  border-radius: var(--wb-radius-sm);
}
.mx-color__name:focus-visible {
  border-color: var(--wb-focus);
}
.mx-colors__empty {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
}

/* ---- 色名候选浮层（Teleport 到 body ⇒ 这里的定位一律相对**视口**）----------------
   1px 间隙 + 28px 行高：这是"点一个词"的靶子，比拖动落点（42×24）还大一点。
   用 `--wb-elev-3` 抬起来：它盖在矩阵上方，不抬就会和表格线糊在一起。 */
.mx-suggest {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-3);
}
.mx-suggest__hint {
  padding: 3px 6px 5px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--wb-text-muted);
  border-bottom: 1px solid var(--wb-border);
  margin-bottom: 2px;
}
.mx-suggest__group {
  padding: 6px 8px 3px;
  font-size: 11px;
  line-height: 1.2;
  color: var(--wb-text-muted);
  border-top: 1px solid var(--wb-border);
  margin-top: 3px;
}
/* 紧跟在使用说明后面的那一组不再画分隔线（它有 hint 的下边框，再画就是双线） */
.mx-suggest__hint + .mx-suggest__group {
  padding-top: 3px;
  border-top: 0;
  margin-top: 0;
}
.mx-suggest__item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
/* 键盘 ↑↓ 与鼠标悬停共用同一个高亮：两条路看到的是同一个"回车会选哪个" */
.mx-suggest__item.is-active,
.mx-suggest__item:hover {
  background: var(--wb-hover);
}
.mx-suggest__dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.mx-suggest__name {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mx-suggest__note {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  text-align: right;
}

/* 「＋ 颜色 / ＋ 尺码 / 常用」：虚线小按钮，和 chip 同一行高 */
.mx-add {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  height: 28px;
  padding: 0 8px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: transparent;
  color: var(--wb-text-muted);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.mx-add:hover:not(:disabled) {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.mx-add:disabled {
  cursor: default;
  opacity: 0.55;
}

/* 常用码下拉：绝对定位 —— 打开时才盖住矩阵，不把这一行撑高 */
.mx-preset {
  position: relative;
  flex: none;
}
.mx-preset > summary {
  list-style: none;
  height: 28px;
}
.mx-preset > summary::-webkit-details-marker {
  display: none;
}
.mx-preset__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-2);
}
.mx-preset__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.mx-preset__item:hover:not(:disabled) {
  background: var(--wb-hover);
}
.mx-preset__item:disabled {
  cursor: default;
  opacity: 0.55;
}

/* 尺码 chip：输入框 + ✕ 合成一个胶囊，改名字不用点"编辑" */
.mx-chips {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.mx-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
}
.mx-chip:focus-within {
  border-color: var(--wb-focus);
  box-shadow: 0 0 0 2px var(--wb-focus-ring);
}
.mx-chip__input {
  width: 52px;
  height: 26px;
  padding: 0 2px 0 6px;
  font-size: 12px;
  text-align: center;
  border: 0;
  background: transparent;
}
.mx-chip__input:focus-visible {
  box-shadow: none;
}
.mx-chip__x {
  width: 18px;
  height: 22px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  color: var(--wb-text-muted);
  border-radius: var(--wb-radius-sm);
}
.mx-chip__x:hover:not(:disabled) {
  color: var(--wb-danger);
  background: var(--wb-danger-soft);
}

/* 克重：批量值 + 两个显式动作（默认只填空） */
.mx-weights {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mx-weights__input {
  width: 88px;
  height: 28px;
  padding: 0 8px;
  font-size: 13px;
  border-radius: var(--wb-radius-sm);
}
.mx-weights__unit {
  font-size: 12px;
}
.mx-weights__all {
  font-size: 12px;
}
/* 「当前 500 g」/「当前 混填」：只读事实，摆在按钮后面 ——
   填之前先看见现状，才不会重复劳动、也不会一按覆盖把核对过的值抹平。 */
.mx-weights__now {
  margin-left: auto;
  font-size: 11px;
  white-space: nowrap;
}

/* ---- 组合区 ---------------------------------------------------------------- */
.mx-bar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.mx-bar__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.mx-bar__stat {
  font-size: 12px;
}
/* 合并回执：只在刚拖完那几秒出现。刻意放在这一行（不新增一行），
   否则下面矩阵会在 8 秒后跳一下 —— 布局跳动会被读成"界面坏了"。
   `min-width: 0` + 单行截断：文案长了就省略，绝不把图例挤到第二行。 */
.mx-bar__merged {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--wb-warning);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 「撤销」跟在回执后面：回执文字可以被省略号截断，按钮必须始终可点 */
.mx-bar__merged--undo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: visible;
}
.mx-bar__undo-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mx-bar__undo {
  flex: none;
  font-size: 12px;
  white-space: nowrap;
}
.mx-bar__legend {
  margin-left: auto;
  flex: none;
  font-size: 11px;
}
/* 拖动中的落点提示：比普通图例更显眼（用主色 + 略粗），但**高度与图例完全一致**
   —— 拖动中布局一跳，落点就从指针底下跑掉了。 */
.mx-bar__drop {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 横滚 + 吸顶都在 `.wb-table-wrap` 里；这里只加高度上限让表头真的能吸住。
   40vh 是"弹层里别把弹层顶出去"的兜底（采集快照弹层 / 建款向导仍用它）。 */
.mx-wrap {
  max-height: 40vh;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
}
/* 吃满剩余高度（产品抽屉）：上限交给 flex 收缩，只留 140px 的下限
   —— 再小就连表头 + 两行都放不下，等于让人在缝里点格子。 */
.mx-wrap--fill {
  flex: 1 1 auto;
  min-height: 140px;
  max-height: none;
}
/* `table-layout: fixed` 的列宽**由 thead 算**：列宽声明必须挂在 th 上（写在 td 上不生效）。
   `width: max-content` + 固定列宽 ⇒ 列多到放不下时由 wrap 横滚，而不是把列抠塌。 */
.mx-table {
  width: max-content;
  min-width: 100%;
  table-layout: fixed;
}
/* 行高比通用表格紧（这里一行只有"开关 + 一个数字"，9px 上下留白纯属浪费 ——
   一屏多一行组合，就是少一次滚动） */
.mx-table th,
.mx-table td {
  padding: 3px 4px;
}
/* 行头 140px：色图 24 + 名字 ~105（14 色时名字多半是两三个字）。
   尺码列 78px：22px 开关 + 4 位克重正好放得下。这两个数是被"一屏看全"倒推出来的：
   1040 抽屉的右栏 687px ⇒ 140 + 7×78 = 686，S~XXL + 均码 刚好不横滚（96px 时 6 码就要滚）。 */
.mx-c-row {
  width: 140px;
  padding-left: 8px;
}
.mx-c-size {
  width: 78px;
}
/* 列头 / 行名 = 整列 / 整行开关：外观保持"标签"的样子（矩阵里已经有 ✓ 方块、
   虚线 ＋、输入框三套控件，再画一套按钮边框就真的乱了），只用 hover 底色 + 常显的光标
   表明"这里能点"；真正的说明在 title 里（悬停即见）。 */
.mx-bulk {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  font: inherit;
  font-weight: 600;
  text-align: inherit;
  cursor: pointer;
}
.mx-bulk:hover:not(:disabled) {
  background: var(--wb-hover);
}
.mx-bulk:focus-visible {
  outline: 2px solid var(--wb-focus);
  outline-offset: -2px;
}
.mx-bulk:disabled {
  cursor: default;
}
/* 列头：文字居中（列头本来就是居中的表头） */
.mx-size-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  color: var(--wb-text);
}
.mx-rowhead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 行名（整行开关）：名字长了省略 —— 完整色名在 title 与规格 chip 里 */
.mx-rowhead__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 2px 2px;
  font-size: 12px;
  font-weight: 400;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-text);
}
.mx-thumb {
  width: 24px;
  height: 24px;
  flex: none;
}
/* 图包一层按钮（点开看大图）：剥掉按钮默认外观，只留"可点开"的光标 */
.mx-thumb-btn {
  position: relative;
  display: inline-flex;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  line-height: 0;
  cursor: zoom-in;
  border-radius: var(--wb-radius-sm);
}
.mx-thumb-btn:focus-visible {
  outline: 2px solid var(--wb-focus);
  outline-offset: 2px;
}
/* 「这张图能点」常显角标（与队列缩略图同一套写法）—— 不依赖悬停，触屏也看得见 */
.mx-thumb-btn__zoom {
  position: absolute;
  right: 1px;
  bottom: 1px;
  padding: 0 2px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 8px;
  line-height: 1.5;
}
.mx-cell {
  text-align: center;
}
/* 一格一个输入框（2026-10-25）。宽度仍然决定"一屏能看全几个码"：
   `table-layout: fixed` 在 `width: max-content` 上不生效，列宽由格内控件倒推，
   所以这个数不只是在调"输入框多宽"。58px = 78px 列宽减两侧 padding 后留 12px 余量
   （原来 52px 是因为左边还要挤一个 22px 的存在性开关，现在那个开关没了）。 */
.mx-weight {
  display: block;
  width: 100%;
  max-width: 58px;
  height: 24px;
  margin: 0 auto;
  padding: 0 2px;
  font-size: 12px;
  text-align: center;
  border-radius: var(--wb-radius-sm);
}
/* 空格 = 这个组合不存在：虚线 + 「＋」占位，与"存在但待填"（实线 + 「待填」）一眼可分。
   ⚠️ 它仍然是一个真输入框 —— 直接敲数字就"加入并填值"，这是本轮省掉的那个动作。 */
.mx-weight.is-off {
  border-style: dashed;
  background: transparent;
  color: var(--wb-text-muted);
}
.mx-weight.is-off::placeholder {
  color: var(--wb-border-strong);
}
.mx-weight.is-off:hover:not(:disabled) {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
/* 列头下的「码克重」：填一个数铺满该列（比逐格填少 N 倍动作） */
.mx-head-w .mx-c-row,
.mx-head-w .mx-c-size {
  padding-top: 0;
  padding-bottom: 4px;
}
.mx-head-w__k {
  display: block;
  padding-left: 2px;
  font-size: 11px;
  font-weight: 400;
  color: var(--wb-text-muted);
}
.mx-colw {
  display: block;
  width: 100%;
  max-width: 58px;
  height: 22px;
  margin: 0 auto;
  padding: 0 2px;
  font-size: 11px;
  text-align: center;
  border-radius: var(--wb-radius-sm);
}
.mx-colw::placeholder {
  color: var(--wb-text-muted);
}
.mx-x {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0 3px;
  font-size: 12px;
  line-height: 1;
  color: var(--wb-text-muted);
  border-radius: var(--wb-radius-sm);
}
.mx-x:hover:not(:disabled) {
  color: var(--wb-danger);
}
.mx-x:focus-visible {
  outline: 2px solid var(--wb-focus);
  outline-offset: 1px;
}
.mx-empty {
  padding: 12px 10px;
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: normal;
}
/* 整行左侧那道 3px 色条：14 行时靠它认行（色名认不出就不画） */
.mx tbody td.mx-c-row {
  box-shadow: inset 3px 0 0 var(--mx-accent, transparent);
}
/* 「认不出标准色名」只在名字旁点一个小橙点。
   2026-10-24 之前是"整卡 / 整行铺橙底"：7 个色里 5 个不在词表时整屏像报错，用户口径
   「样式是乱的」。行上的 `is-flagged` 类保留（向导的"N 行认不出"计数与断言按它认行）。 */
.mx-dot {
  flex: none;
  width: 5px;
  height: 5px;
  margin-left: 3px;
  border-radius: 50%;
  background: var(--wb-warning);
}

/* ---- 看大图（嵌套遮罩；见模板里那段说明）---- */
/* `max-width` 而不是 `width`：小图（色图常见 800×800）按原尺寸显示，别拉糊 */
.mx-viewer {
  max-width: min(78vw, 900px);
}
.mx-viewer__head {
  align-items: center;
}
.mx-viewer__color {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mx-viewer__src {
  flex: none;
  font-size: 12px;
  font-weight: 400;
}
.mx-viewer__x {
  margin-left: auto;
  padding: 2px 6px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--wb-text-muted);
}
.mx-viewer__x:hover {
  color: var(--wb-text);
}
.mx-viewer__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-height: 160px;
  max-height: 78vh;
}
.mx-viewer__img {
  max-width: 100%;
  max-height: 66vh;
  object-fit: contain;
  border-radius: var(--wb-radius-sm);
}
.mx-viewer__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}
</style>
