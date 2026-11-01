<template>
  <!-- 命名板（P3）：归类自动化之后**人这一端唯一还剩的判断** —— "这个色在我生意里叫什么"。
       ⚠️ 它与「归类核对」是两件事，别合并：
          核对 = 这行属于哪个款色（现在由变体键回答，人工 0 次）；
          命名 = 那个款色叫什么（只有人能回答，且**可以永远不做**）。
       所以本卡不给任何"未完成就走不下去"的暗示：没有名字的色在统计与拿货里照样出数，
       只是显示成平台原文（`5` / `Picture color4`）。 -->
  <section class="wb-panel vn" data-act="vn-panel" @click.capture="onRootClickCapture">
    <div class="wb-panel__head vn-head">
      <div class="vn-head__text">
        <strong class="vn-title">颜色叫什么</strong>
        <!-- 计数只有一处：面板标题旁。它同时是"要不要展开"的理由 ——
             0 个待办时整张卡收成一行，用户在核对页看不到多余的东西。
             ⚠️ `totalKeys` 现在只算**这一批导入日**（与「待核对」同一批），所以 0 的两种含义要分开说：
                 · 这批里没有订单行 ⇒ 「还没有要起名的颜色」（不是"全都起完了"）；
                 · 这批有订单、但色全起过名 ⇒ 「全都起过名了」。 -->
        <span class="wb-muted vn-count" data-act="vn-count">
          <template v-if="board.unnamedKeys > 0">
            还有 <b>{{ board.unnamedKeys }}</b> 个颜色是平台原文，共 {{ board.totalKeys }} 个
          </template>
          <template v-else-if="board.totalKeys > 0">全部 {{ board.totalKeys }} 个颜色都起过名了</template>
          <template v-else>这一批还没有要起名的颜色</template>
        </span>
      </div>
      <div class="vn-head__ops">
        <button
          v-if="board.unnamedKeys > 0"
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="vn-collapse"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '展开' : '收起' }}
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="vn-reload"
          :disabled="loading || busy > 0"
          @click="reload"
        >
          刷新
        </button>
      </div>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error vn-note" data-act="vn-error">{{ error }}</p>

    <div v-if="visible" class="wb-panel__body vn-body">
      <p class="wb-muted vn-guide" data-act="vn-guide">
        这一块只列还没认颜色的订单色（起过名的不再出现）。点一个色格（例如「5」）→
        上面点一个常用色 = 起名；也可以把色格直接拖到色卡上。存完自动跳到下一个没起名的色；
        不起名不影响统计和拿货。
      </p>

      <!-- 常用色（2026-10-30 用户口径：起名方式改成产品页 SKU 编辑那一套）。
           一排色卡常驻在卡片顶部，点一颗 = 给"选中的色格"起名并保存。
           为什么不再给每格一个输入框：色名就是款色库的色名（拿货单与统计直接读它），
           手打会让 `黑 / 黑色 / Black` 各成一行 —— 同一件货在两张纸上分成三行。
           「＋ 新增颜色」是字典里没有时的出口（只写字典，不给色格改名）。 -->
      <div class="vn-palette" :class="{ 'is-dragging': drag.active }" data-act="vn-palette">
        <span class="vn-palette__k" title="点一颗常用色 = 给选中的色格起名；也可以把色格拖到这里">
          常用色
        </span>
        <ColorPalette
          act="vn"
          :colors="paletteColors"
          :present="presentColors"
          :current="activeName"
          :disabled="busy > 0"
          :dragging="drag.active"
          :drop-color="drag.color"
          drop-attr="data-vn-pc"
          allow-add
          compact
          :title-for="pcTitle"
          @pick="pickColor"
          @added="onPaletteAdded"
        />
        <span class="vn-sel-hint wb-muted" data-act="vn-sel-hint">{{ selHint }}</span>
        <button v-if="selected" type="button" class="wb-link" data-act="vn-sel-clear" @click="selectedId = 0">
          取消选择
        </button>
      </div>

      <!-- 一个 listing 一块：一个 listing 常有 4-6 个色键，必须**一屏填完**，
           做成"点开一个、填一个、关掉"就是用户抱怨过的四个动作再来一遍。 -->
      <section
        v-for="g in shownGroups"
        :key="g.itemId + '|' + g.shop"
        class="vn-group"
        :data-act="`vn-group-${g.itemId}`"
      >
        <header class="vn-group__head">
          <!-- 标题取不到时会回落成商品ID，那种情况不必把同一个串显示两遍 -->
          <span v-if="g.title && g.title !== g.itemId" class="vn-group__title" :title="g.title">
            {{ g.title }}
          </span>
          <span class="wb-muted vn-group__meta">
            <template v-if="g.shop">{{ g.shop }} · </template>{{ g.itemId }}
          </span>
          <!-- 只数**还没认**的：这一块现在是"待办清单"，已起名的色根本不渲染
               （2026-10-30 用户口径「只展示订单中没有认颜色的数据」）。 -->
          <span
            v-if="unnamedOf(g).length"
            class="wb-muted vn-group__meta"
            :data-act="`vn-group-left-${g.itemId}`"
          >
            · {{ unnamedOf(g).length }} 个没起名
          </span>
        </header>

        <!-- 款这一行：款名 + 厂家（拿货按厂家统计靠它）。
             为什么放在色格**上面**：人是看着一屏图先认出"这是个什么款、从哪家拿"，
             再逐个色起名 —— 顺序反过来就得先滚过 6 个输入框才够得着款。
             `styleCount > 1` 的组不给编辑：那组的色被人工分到了两个款，
             在这里改一次会顺手改掉另一个款的名字/厂家，而界面上看不出来。 -->
        <div class="vn-style" :data-act="`vn-style-${g.itemId}`">
          <template v-if="g.styleCount > 1">
            <span class="wb-muted vn-style__note" :data-act="`vn-style-mixed-${g.itemId}`">
              这些色挂在 {{ g.styleCount }} 个款下（以前手工合并过），款名与厂家请到「基础数据 › 产品管理」里改
            </span>
          </template>
          <template v-else-if="g.styleId > 0">
            <span class="vn-style__label wb-muted">款</span>
            <code class="vn-style__code" :data-act="`vn-style-code-${g.itemId}`">{{ g.styleCode }}</code>
            <input
              class="wb-input wb-input--sm vn-style__name"
              :data-act="`vn-style-name-${g.itemId}`"
              :value="styleNameOf(g)"
              placeholder="这个款叫什么（可留空）"
              maxlength="60"
              @input="onStyleName(g, ($event.target as HTMLInputElement).value)"
              @keyup.enter="saveStyle(g)"
            />
            <select
              class="wb-select wb-select--sm vn-style__sup"
              :data-act="`vn-style-sup-${g.itemId}`"
              :value="styleSupplierOf(g)"
              @change="onStyleSupplier(g, Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="0">未指定厂家</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <button
              type="button"
              class="wb-btn wb-btn--sm"
              :data-act="`vn-style-save-${g.itemId}`"
              :disabled="!styleDirty(g)"
              @click="saveStyle(g)"
            >
              保存
            </button>
          </template>
          <p v-if="styleError[g.styleId]" class="vn-style__err" :data-act="`vn-style-err-${g.itemId}`">
            {{ styleError[g.styleId] }}
          </p>
        </div>

        <div class="vn-grid">
          <div
            v-for="c in unnamedOf(g)"
            :key="c.styleColorId"
            class="vn-cell"
            :class="{
              'is-sel': selectedId === c.styleColorId,
              'is-src': drag.active && drag.src === c.styleColorId,
            }"
            :data-act="`vn-cell-${c.styleColorId}`"
            :title="cellTitle(c)"
            @pointerdown="onCellDown(c, $event)"
            @click="onCellClick(c)"
          >
            <button
              type="button"
              class="vn-thumb-btn"
              :disabled="!c.localPath"
              :title="c.localPath ? '看原图' : '这条订单没有主图'"
              :data-act="`vn-thumb-${c.styleColorId}`"
              @click.stop="openImage(c)"
            >
              <img
                v-if="c.localPath && thumbs[c.localPath]"
                class="wb-thumb vn-thumb"
                :src="thumbs[c.localPath]"
                :alt="c.colorRaw || c.colorName"
              />
              <span v-else class="wb-thumb wb-thumb--empty vn-thumb" aria-hidden="true"></span>
            </button>

            <div class="vn-cell__body">
              <div class="vn-cell__raw">
                <span class="wb-muted">平台原文</span>
                <code class="vn-raw" :data-act="`vn-raw-${c.styleColorId}`">{{ c.colorRaw || '（空）' }}</code>
              </div>
              <!-- 色名**只读**（与产品页 SKU 编辑同一条口径）：改名的唯一路径是
                   "选中这一格 → 点上面常用色 / 把这一格拖上去"，于是落库色名总是字典写法。
                   选中标记常显（未选空框、已选打勾），点它和点整格等价。 -->
              <div class="vn-cell__name">
                <span
                  class="vn-sel"
                  :class="{ 'is-on': selectedId === c.styleColorId }"
                  role="checkbox"
                  :aria-checked="selectedId === c.styleColorId ? 'true' : 'false'"
                  :aria-label="`选择${c.colorRaw || '这一色'}去起名`"
                  :data-act="`vn-sel-${c.styleColorId}`"
                  title="点一下选中这一格（再点上面常用色 = 起名）"
                  >{{ selectedId === c.styleColorId ? '✓' : '' }}</span
                >
                <span
                  class="vn-name"
                  :class="{ 'is-empty': !c.named }"
                  :data-act="`vn-name-${c.styleColorId}`"
                  :title="c.named ? `现在叫「${c.colorName}」` : '还没起名：选中它，再到上面常用色里点一个'"
                  >{{ c.named ? c.colorName : '还没起名' }}</span
                >
              </div>
              <div class="vn-cell__foot wb-muted">
                <span :data-act="`vn-qty-${c.styleColorId}`">{{ c.qty }} 件 / {{ c.orderRows }} 行</span>
                <span v-if="c.styleCode" class="vn-cell__style">
                  → {{ c.styleCode }}<template v-if="c.styleName"> · {{ c.styleName }}</template>
                </span>
              </div>
              <p v-if="rowError[c.styleColorId]" class="vn-cell__err" :data-act="`vn-err-${c.styleColorId}`">
                {{ rowError[c.styleColorId] }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!shownGroups.length" class="wb-empty vn-empty" data-act="vn-empty">
        <p class="wb-empty__title">没有要起名的颜色</p>
        <p class="wb-empty__desc">导入订单后，同一件商品的每个颜色都会自动出现在这里。</p>
      </div>

      <p v-if="hiddenGroups > 0" class="vn-more" data-act="vn-more">
        <span class="wb-muted">还有 {{ hiddenGroups }} 个商品、{{ hiddenKeys }} 个颜色没起名</span>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="vn-more-btn"
          @click="cap += GROUP_STEP"
        >
          再看 {{ Math.min(GROUP_STEP, hiddenGroups) }} 个商品
        </button>
      </p>
    </div>

    <!-- 看原图：与核对页同一个交互（点开才读，读完盖上），不另造一套 -->
    <div v-if="viewer.src" class="vn-viewer" data-act="vn-viewer" @click="viewer.src = ''">
      <img :src="viewer.src" class="vn-viewer__img" alt="" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ipc } from '@/core/services/ipc';
// 「常用色」条与产品编辑页共用同一份字典、同一个组件（2026-10-30 用户口径）
import ColorPalette from '@/core/components/ColorPalette.vue';
import { colorDictNames, loadColorDict } from '@/core/services/colorDict';
import { toast } from '@/core/services/toast';
import { loadNamingBoard, renameVariantColor, saveVariantStyle } from '../classify';
import { listSuppliers } from '../purchase';
import { useShipping } from '../flowCtx';
import type {
  Supplier,
  VariantColorItem,
  VariantNamingBoard,
  VariantNamingGroup,
} from '@/types';

/**
 * 命名板（P3）。
 *
 * 四条设计纪律（每条都对应一个已踩过的坑）：
 *   ① **可跳过**：不起名不影响统计与拿货 —— 卡上的计数说"还有 N 个"，不说"必须做完 N 个"。
 *      一旦做成前置，58 次输入就从可选变成门槛，等于把维护面换个名字搬回来。
 *   ② **一屏一批**：按 listing 分组，组内所有**未认**色键同时可见（不是逐键翻页）。
 *   ③ **只列待办**（2026-10-30 用户口径「只展示订单中没有认颜色的数据，目的只为了能认款和色」）：
 *      起过名的色不进渲染 —— 这块只服务"认款 + 认色"，为之后的拿货统计备口径；
 *      要改已经起过的名，走「基础数据 › 产品管理」。
 *   ④ **色名只能从常用色里挑**（2026-10-30 用户口径「改成编辑产品页 SKU 编辑的方式」）：
 *      点一个色格 = 选中它，再点卡片顶部那排常用色 = 起名并保存（把色格拖到色卡上也一样）。
 *      为什么不再逐格手打：色名会进拿货单与统计，`黑 / 黑色 / Black` 各成一行时，
 *      同一件货在两张纸上分成三行；而"点一下"顺手就把名字收口到字典写法。
 *      起手仍是**显式的一次点击**（不是 blur 自动保存）—— 一次误触的失焦
 *      不该改变将要发给厂家的那张纸。
 */

/**
 * 这一批的导入日（`YYYY-MM-DD`，与下方「待核对」表**同一批**）。
 * 为什么要有：`oi_variant_keys` 是**跨批次**的记忆，不筛就会把十几天累积的色全铺出来
 * （真库实测 59 个键 / 10 个 listing 横跨 10-05 → 10-28），而核对表只显示今天的导入日。
 * 空/不传 = 不筛（历史调用与测试）。
 */
const props = defineProps<{ importDate?: string }>();

const board = ref<VariantNamingBoard>({ groups: [], unnamedKeys: 0, totalKeys: 0 });
const loading = ref(false);
const error = ref('');
/** 正在保存的行数（并发计数；>0 时禁用色卡，避免两次改名互相覆盖） */
const busy = ref(0);
const collapsed = ref(false);
/** 当前选中的色格（`styleColorId`；0 = 没选 —— 此时色卡只提示"先点一个色格"） */
const selectedId = ref(0);
/** 逐行的拒绝原话（同款重名 / 空名……）—— 只清掉这一行，不清整块 */
const rowError = ref<Record<number, string>>({});
const thumbs = ref<Record<string, string>>({});
const viewer = ref<{ src: string }>({ src: '' });

/**
 * 款级草稿（`styleId → { name?, supplierId? }`）与色名草稿分开存：
 * 两者写的是**两张不同域的表**（`pl_products` / `oi_style_colors`），
 * 混在一个 map 里迟早有人只保存了一半却以为整组都存了。
 */
const styleDraft = ref<Record<number, { name?: string; supplierId?: number }>>({});
const styleError = ref<Record<number, string>>({});
/** 厂家下拉的数据源（采购域；失败当空表 —— 空的厂家列表不该让整块面板报错） */
const suppliers = ref<Supplier[]>([]);

/** 一次最多铺几个 listing：多了这一页就变成"翻不到底"，而它是随时可放下的可选动作 */
const cap = ref(6);
const GROUP_STEP = 6;

const visible = computed(() => !collapsed.value && board.value.unnamedKeys > 0);

/**
 * 还有未认色的组。
 *
 * 2026-10-30 用户口径「只展示订单中没有认颜色的数据，目的只为了能认款和色」：
 * 这块是**待办清单**，不是色名编辑器 —— 已起过名的色不进 `workGroups`，也不进渲染。
 * 想改已经起过的名，去「基础数据 › 产品管理」（款的色图与色名在那里）。
 */
const workGroups = computed<VariantNamingGroup[]>(() =>
  board.value.groups.filter((g) => g.colors.some((c) => !c.named)),
);

const shownGroups = computed<VariantNamingGroup[]>(() => workGroups.value.slice(0, cap.value));

const hiddenGroups = computed(() => Math.max(0, workGroups.value.length - cap.value));
const hiddenKeys = computed(() =>
  workGroups.value.slice(cap.value).reduce((n, g) => n + g.colors.filter((c) => !c.named).length, 0),
);

/** 这一组里**还没认**的色（渲染与计数都只认这个口径） */
function unnamedOf(g: VariantNamingGroup): VariantColorItem[] {
  return g.colors.filter((c) => !c.named);
}

/** 在整块命名板里找色格（按 id；找不到 = 已经被重读刷掉） */
function findCell(id: number): { c: VariantColorItem; g: VariantNamingGroup } | null {
  for (const g of board.value.groups) {
    const c = g.colors.find((x) => x.styleColorId === id);
    if (c) return { c, g };
  }
  return null;
}

/**
 * 选中的色格 —— 只在**这一批渲染出来的**组里认。
 *
 * 为什么要限定在 `shownGroups`：重读之后 `nextUnnamedOf` 可能把人"交给"下一批
 * （cap 切片之外的组还没渲染）；若选择态指向一个看不见的格子，色卡上那句
 * 「正在给『5』起名」就变成一次**看不见的写库**（用户以为在改眼前这一格）。
 * 交不过去就停在"没选"，比悄悄改别处安全。
 */
const selected = computed<{ c: VariantColorItem; g: VariantNamingGroup } | null>(() => {
  const id = selectedId.value;
  if (!id) return null;
  for (const g of shownGroups.value) {
    // `!x.named`：已起名的色不渲染（这一块只列待办），选中态也就不能在它上面停留
    const c = g.colors.find((x) => x.styleColorId === id && !x.named);
    if (c) return { c, g };
  }
  return null;
});

/** 色卡上高亮的那一颗（选中色格现在就叫这个名字时才亮） */
const activeName = computed(() => {
  const s = selected.value;
  return s ? String(s.c.colorName ?? '').trim() : '';
});

/**
 * 常用色这一排 = **共享颜色字典**（`md_colors`）+ 命名板里**已经起过的名字**。
 * 追加"本板用过的名字"的理由与产品页同一条：自己起的色名（`灰白 / 酒红`）不在字典里时，
 * 第二次要手打 —— 而手打必然漂（`灰白` / `灰白色` 各成一行）。
 * ⚠️ **平台原文**（`5` / `Picture color4`）不进这一排：那不是色名，摆上去等于允许"把色叫 5"。
 */
const paletteColors = computed<string[]>(() => {
  const out: string[] = [...colorDictNames.value];
  const seen = new Set(out);
  for (const g of board.value.groups) {
    for (const c of g.colors) {
      if (!c.named) continue;
      const n = String(c.colorName ?? '').trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
});

/**
 * 打勾的色 = 选中色格**所在的那个款下已经有了**这个名字。
 *
 * 为什么按款算而不是按整板：`renameStyleColor` 只拦"同一个款下重名"，
 * 所以"点了会失败"和"点了会成功"的分界恰好是**款**。把这个判据画在色卡上，
 * 用户点之前就知道"这一下会被拒（两个色要合并请用映射与关联）"，不用先撞一次再读错误。
 */
const presentColors = computed<string[]>(() => {
  const s = selected.value;
  if (!s) return [];
  const code = String(s.c.styleCode ?? '');
  if (!code) return [];
  const out: string[] = [];
  for (const g of board.value.groups) {
    for (const c of g.colors) {
      if (c.styleColorId === s.c.styleColorId) continue;
      if (String(c.styleCode ?? '') !== code) continue;
      const n = String(c.colorName ?? '').trim();
      if (!n || !c.named || out.includes(n)) continue;
      out.push(n);
    }
  }
  return out;
});

/** 色卡上那句"现在这一下会发生什么"（悬停才看得见，但每一次点击前都该答得出来） */
function pcTitle(c: string): string {
  const s = selected.value;
  if (!s) return `先在下面点一个色格，再点「${c}」给它起名（也可以把色格拖上来）`;
  const raw = s.c.colorRaw || s.c.colorName || '这一色';
  if (presentColors.value.includes(c)) {
    return `「${s.c.styleCode}」这个款下已经有「${c}」了 —— 改名会被拒；两个色要合并请用「映射与关联」`;
  }
  if (s.c.named && String(s.c.colorName ?? '').trim() === c) {
    return `它现在就叫「${c}」（点一下不会改动）`;
  }
  return `点一下：把「${raw}」叫「${c}」并保存`;
}

/**
 * 存完之后选中态交给谁：**同组的下一个未命名色**，本组没了就交下一组的第一个。
 *
 * 与原来的"落焦"是同一条教训（真库待命名 54 个键、分布在 37 个 listing 上）：
 * 每次保存后组件会重读命名板，已命名的色可能被排到组尾 —— 不主动接力的话，
 * 人每存一个都要再用鼠标点下一格，54 次。这里只交到**这一批（`shownGroups`）渲染出来的**
 * 格子；更后面的那一批由「再看 N 个商品」按钮接手（不把人交给看不见的格子）。
 *
 * 为什么**不**按"同一个平台原文"批量命名（`1` 在 7 个 listing 上都出现）：平台原文是
 * 商品级的编号，不同 listing 的 `1` 根本不是同一个颜色（键是 `(店铺, 商品, 原文色)` 也正是
 * 因为这个）。批量按原文命名 = 把"位置"当"语义"，错得悄无声息，还会被自己的键记住。
 */
function nextUnnamedOf(c: VariantColorItem, g: VariantNamingGroup): number {
  const at = g.colors.findIndex((x) => x.styleColorId === c.styleColorId);
  const rest = at >= 0 ? g.colors.slice(at + 1) : [];
  const next = rest.find((x) => !x.named);
  if (next) return next.styleColorId;
  const gi = shownGroups.value.findIndex((x) => x.itemId === g.itemId && x.shop === g.shop);
  for (const g2 of gi >= 0 ? shownGroups.value.slice(gi + 1) : []) {
    const first = g2.colors.find((x) => !x.named);
    if (first) return first.styleColorId;
  }
  return 0;
}

/** 卡片顶部那句"现在给谁起名"（选中的一定还没起名，所以不会出现"现在叫 X"那种半句） */
const selHint = computed(() => {
  const s = selected.value;
  if (!s) return '先在下面点一个色格，再点色卡（或把色格拖到色卡上）';
  return `正在给「${s.c.colorRaw || s.c.colorName || '这一色'}」起名`;
});

/** 点色格 = 选中 / 再点一次取消（色名只读之后，"点一下"只剩这一种含义） */
function onCellClick(c: VariantColorItem): void {
  if (busy.value) return;
  selectedId.value = selectedId.value === c.styleColorId ? 0 : c.styleColorId;
}

function cellTitle(c: VariantColorItem): string {
  const raw = c.colorRaw || c.colorName || '这一色';
  return selectedId.value === c.styleColorId
    ? `已选中「${raw}」—— 点上面常用色 = 起名`
    : `点一下选中「${raw}」，再点上面常用色 = 起名；也可以把它拖到色卡上`;
}

/* ---- 拖色格到常用色 = 起名（与产品页 `SkuMatrixEditor` 同一套手势）--------
   用 pointer 事件而不是 HTML5 drag：Electron 里 draggable 的 ghost 图与 pointer capture
   会丢事件；阈值 6px 区分"点击选中"与"拖动"。
   落点只认 `[data-vn-pc]`（常用色胶囊自带的属性），不认坐标区间 —— 胶囊宽度随字号变。
   `pointerup` 可能落在卡片外（比如页面上别处），所以监听挂在 `window` 上（按下时挂、收尾时摘）。 */
const DRAG_THRESHOLD = 6;
const drag = reactive({ active: false, src: 0, color: '' });
let cellDrag: { id: number; x0: number; y0: number; moved: boolean } | null = null;
/** 拖过之后的第一次 click 要吞掉（否则松手就顺手把别的格子选中/把色卡再点一次） */
let swallowClick = false;
let selectLocked = false;

function blockSelectStart(e: Event): void {
  e.preventDefault();
}

/**
 * 按住色格期间**禁用原生文本选择**（与产品页 `lockTextSelection` 同一条教训：
 * 色名改成只读文本后，整格都是拖动抓手，按住移动超过 6px 就会拖出一段"刷蓝"选择，
 * 一路拖过色卡时选区会跨到上面那一排）。
 * 用 `selectstart` 而不是 `pointerdown.preventDefault()`：后者会连带抑制 click，点选就失效了。
 */
function lockSelection(): void {
  if (selectLocked) return;
  selectLocked = true;
  document.addEventListener('selectstart', blockSelectStart, true);
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
}

function unlockSelection(): void {
  if (!selectLocked) return;
  selectLocked = false;
  document.removeEventListener('selectstart', blockSelectStart, true);
}

/** 指针下面是哪一颗常用色（`''` = 不在任何一颗上） */
function paletteColorAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const chip = el?.closest?.('[data-vn-pc]') as HTMLElement | null;
  return chip?.getAttribute('data-vn-pc') || '';
}

function onCellDown(c: VariantColorItem, e: PointerEvent): void {
  if (busy.value || e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  // 缩略图是"看原图"的按钮（裹着 img 的 button 正是最容易按到的地方，但要排除它）
  if (el?.closest('[data-act^="vn-thumb-"]')) return;
  cellDrag = { id: c.styleColorId, x0: e.clientX, y0: e.clientY, moved: false };
  // 按下就锁（不等 6px 判定）：原生选择是从"按下 + 移动"起算的，等判定成拖动再锁已经晚了
  lockSelection();
  window.addEventListener('pointermove', onCellMove);
  window.addEventListener('pointerup', onCellUp);
  window.addEventListener('pointercancel', onCellCancel);
}

function onCellMove(e: PointerEvent): void {
  const d = cellDrag;
  if (!d) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return;
    d.moved = true;
    drag.active = true;
    drag.src = d.id;
  }
  drag.color = paletteColorAt(e.clientX, e.clientY);
}

function endCellDrag(): void {
  cellDrag = null;
  drag.active = false;
  drag.src = 0;
  drag.color = '';
  unlockSelection();
  window.removeEventListener('pointermove', onCellMove);
  window.removeEventListener('pointerup', onCellUp);
  window.removeEventListener('pointercancel', onCellCancel);
}

function onCellUp(e: PointerEvent): void {
  const d = cellDrag;
  const color = d && d.moved ? paletteColorAt(e.clientX, e.clientY) : '';
  endCellDrag();
  if (!d || !d.moved) return; // 普通点击：交给 click 去选中
  swallowClick = true;
  setTimeout(() => {
    swallowClick = false;
  }, 0);
  if (!color) return;
  const hit = findCell(d.id);
  if (hit) void renameCell(hit.c, hit.g, color);
}

function onCellCancel(): void {
  endCellDrag();
}

/** 拖过之后的第一次 click 一律不认（见 `onCellUp`）—— 包括落在色卡上的那一次 */
function onRootClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}

/** 拖动被**外部**打断（切窗口 / 窗口失焦）：直接丢弃，不判落点（否则状态卡在"拖动中"） */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest('input, select, textarea')) return; // 「新增颜色」的输入框自己处理 Esc
  if (cellDrag) endCellDrag();
  if (selectedId.value) selectedId.value = 0;
}

function styleNameOf(g: VariantNamingGroup): string {
  const d = styleDraft.value[g.styleId];
  return d?.name === undefined ? g.styleName : d.name;
}

function styleSupplierOf(g: VariantNamingGroup): number {
  const d = styleDraft.value[g.styleId];
  return d?.supplierId === undefined ? g.supplierId : d.supplierId;
}

/** 有改动 = 名字或厂家任一与当前库值不同（款名允许清空，由主进程决定它算不算有效） */
function styleDirty(g: VariantNamingGroup): boolean {
  return styleNameOf(g) !== g.styleName || styleSupplierOf(g) !== g.supplierId;
}

function onStyleName(g: VariantNamingGroup, v: string): void {
  styleDraft.value = { ...styleDraft.value, [g.styleId]: { ...styleDraft.value[g.styleId], name: v } };
  clearStyleError(g.styleId);
}

/** 厂家是**离散的一次选择**（不是连续输入）⇒ 选完立刻存，不留"选了但没保存"的假象 */
function onStyleSupplier(g: VariantNamingGroup, id: number): void {
  styleDraft.value = {
    ...styleDraft.value,
    [g.styleId]: { ...styleDraft.value[g.styleId], supplierId: id },
  };
  void saveStyle(g);
}

function clearStyleError(styleId: number): void {
  if (!styleError.value[styleId]) return;
  const next = { ...styleError.value };
  delete next[styleId];
  styleError.value = next;
}

/**
 * 保存款名 / 厂家。
 *
 * ⚠️ **只送改过的那一项**：`undefined`（不改）与 `0`（清空厂家）在 IPC 上是两件事，
 * 一律送全量字段会让"我只改个款名"顺手把厂家清成 0 —— 拿货页随即多出一批未指定厂家的货。
 */
async function saveStyle(g: VariantNamingGroup): Promise<void> {
  const patch: { styleId: number; name?: string; supplierId?: number } = { styleId: g.styleId };
  if (styleNameOf(g) !== g.styleName) patch.name = styleNameOf(g).trim();
  if (styleSupplierOf(g) !== g.supplierId) patch.supplierId = styleSupplierOf(g);
  if (patch.name === undefined && patch.supplierId === undefined) return;
  busy.value += 1;
  try {
    const r = await saveVariantStyle(patch);
    if (!r.ok) {
      styleError.value = { ...styleError.value, [g.styleId]: r.error || '没保存成功' };
      return;
    }
    const next = { ...styleDraft.value };
    delete next[g.styleId];
    styleDraft.value = next;
  } catch (e: unknown) {
    styleError.value = {
      ...styleError.value,
      [g.styleId]: e instanceof Error ? e.message : '没保存成功',
    };
  } finally {
    busy.value -= 1;
    if (busy.value === 0) await reload();
  }
}

/**
 * 把某一格改成 `name` 并保存（**点色卡**与**拖到色卡**都走这里，落库语义只有一份）。
 *
 * ⚠️ 保存后**不动**被拒的那一格（不跳选中）：人还得看着它改（跳走等于把错误甩在身后）；
 *    成功后才把选中交给下一个未命名的色。
 * ⚠️ `busy > 0` 时直接返回（色卡此刻是 disabled，正常路径点不进来）—— 两次改名互相覆盖
 *    比"少存一次"更糟。
 */
async function renameCell(c: VariantColorItem, g: VariantNamingGroup, name: string): Promise<void> {
  const target = String(name ?? '').trim();
  if (!target || busy.value) return;
  // 已经是这个名字：不白跑一次 IPC（主进程虽幂等，但会给下游一次无意义的"已命名"心跳）
  if (c.named && String(c.colorName ?? '').trim() === target) {
    selectedId.value = nextUnnamedOf(c, g);
    return;
  }
  busy.value += 1;
  try {
    const r = await renameVariantColor(c.styleColorId, target);
    if (!r.ok) {
      rowError.value = { ...rowError.value, [c.styleColorId]: r.error || '没保存成功' };
      return;
    }
    const next = { ...rowError.value };
    delete next[c.styleColorId];
    rowError.value = next;
    // 选中交给下一个未命名的色（顺序在点击那一刻确定，重读后依然成立）
    selectedId.value = nextUnnamedOf(c, g);
  } catch (e: unknown) {
    rowError.value = {
      ...rowError.value,
      [c.styleColorId]: e instanceof Error ? e.message : '没保存成功',
    };
  } finally {
    busy.value -= 1;
    // 最后一个存完才回读一次：每行各刷一次会让列表在用户眼前跳 N 次
    if (busy.value === 0) await reload();
  }
}

/** 点常用色：有选中 ⇒ 改名并保存；没选中 ⇒ 说清楚下一步（不做"点什么都没发生"） */
async function pickColor(name: string): Promise<void> {
  const s = selected.value;
  if (!s) {
    toast('先在下面点一个色格，再点常用色 —— 也可以把色格直接拖到色卡上', 'info');
    return;
  }
  await renameCell(s.c, s.g, name);
}

/** 新增颜色成功后的一句回执（只进字典，**不给色格改名**） */
function onPaletteAdded(name: string): void {
  toast(`已把「${name}」加进常用色 —— 选中一个色格，再点它即可改名`, 'info');
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    board.value = await loadNamingBoard(props.importDate || '');
    // 选中的色格被删/被归并掉了 ⇒ 收起选择（别让色卡指着一个不存在的行）
    if (selectedId.value && !findCell(selectedId.value)) selectedId.value = 0;
    await loadThumbs();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取待命名颜色失败';
  } finally {
    loading.value = false;
  }
}

/**
 * 缩略图合批一次往返（与核对页同一通道、同一条理由：`maxEdge` 跟展示尺寸走）。
 * 本卡图格 56px，但认色要看整块颜色 ⇒ 给 256，宁可大一点也不要模糊到分不出黑与藏青。
 */
async function loadThumbs(): Promise<void> {
  const paths = [
    ...new Set(
      board.value.groups.flatMap((g) => g.colors.map((c) => c.localPath)).filter(Boolean),
    ),
  ].filter((p) => !thumbs.value[p]);
  if (!paths.length) return;
  const t = await ipc.orderImageThumbBatch(paths.map((localPath) => ({ localPath, maxEdge: 256 })));
  if (!t.success) return;
  paths.forEach((p, i) => {
    const url = t.data?.dataUrls?.[i];
    if (url) thumbs.value[p] = url;
  });
}

/** 点开看原图（与核对页同一条通道：`orderReadImage` 不缩放，能看清印花/领型） */
async function openImage(c: VariantColorItem): Promise<void> {
  const localPath = String(c.localPath ?? '');
  if (!localPath) return;
  viewer.value = { src: thumbs.value[localPath] || '' };
  const big = await ipc.orderReadImage(localPath);
  if (big.success && big.data?.dataUrl) viewer.value = { src: big.data.dataUrl };
}

// 订单/归属会随导入变化 ⇒ 进页面取一次，容器 `bump()` 时（`token` +1）再取一次。
// 用容器的版本号而不是自定义事件：本仓的刷新只有这一条口径（各面板都 watch `token`），
// 再造一个 `window` 事件就是第二套刷新语义，且没人 dispatch 时它**静默什么都不做**。
const { token } = useShipping();
watch(token, () => void reload());
// 这一批的导入日变了（跨零点 / 上层换批）⇒ 重取，否则卡上还是昨天那批的色
watch(() => props.importDate, () => void reload());

onMounted(() => {
  void reload();
  // 常用色那一排来自共享颜色字典（与产品编辑页同一份单例）；取不到时组件自己回落到内置常用色
  void loadColorDict();
  // Esc = 取消选中 / 放弃这次拖动（键盘出口；输入框里的 Esc 由输入框自己处理）
  window.addEventListener('keydown', onWindowKeydown);
  // 厂家列表单独取：它是采购域的数据，取不到（还没建表）只该让下拉少几个选项，
  // 不该让整块命名板报错 —— 命名板的活是"给色起名"，厂家是顺手捎带的那一步。
  void listSuppliers()
    .then((rows) => {
      suppliers.value = rows;
    })
    .catch(() => {
      suppliers.value = [];
    });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  endCellDrag();
});
</script>

<style scoped>
.vn {
  flex-shrink: 0;
}
.vn-head {
  align-items: center;
  gap: 10px;
}
.vn-head__text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.vn-title {
  font-size: 13px;
  white-space: nowrap;
}
.vn-count {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vn-head__ops {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.vn-note {
  margin: 8px 0 0;
}
.vn-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 44vh;
  overflow: auto;
}
.vn-guide {
  margin: 0;
  font-size: 12px;
}
/* 常用色那一排（2026-10-30）：常驻在卡片顶部，点一颗 = 给选中的色格起名 */
.vn-palette {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-sm);
}
.vn-palette.is-dragging {
  border-color: var(--wb-focus);
}
.vn-palette__k {
  font-size: 11px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
.vn-sel-hint {
  flex: 1 1 200px;
  min-width: 0;
  font-size: 11px;
}
.vn-group {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  padding: 8px 10px 10px;
}
.vn-group__head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
  min-width: 0;
}
.vn-group__title {
  font-size: 12px;
  font-weight: 600;
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vn-group__meta {
  font-size: 11px;
  white-space: nowrap;
}
/* 款这一行：款编码（只读身份）+ 款名 + 厂家 */
.vn-style {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
}
.vn-style__label {
  font-size: 11px;
}
.vn-style__code {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 11px;
  white-space: nowrap;
}
.vn-style__name {
  flex: 1 1 180px;
  min-width: 120px;
}
.vn-style__sup {
  flex: 0 0 auto;
  max-width: 180px;
}
.vn-style__note {
  font-size: 11px;
}
.vn-style__err {
  margin: 0;
  flex-basis: 100%;
  font-size: 11px;
  color: var(--wb-danger, #c0392b);
}
/* 一屏一批：一个 listing 的 4-6 个色键平铺，不折叠、不分页 */
.vn-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.vn-cell {
  display: flex;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  min-width: 0;
  /* 整格可点（选中）+ 整格可拖（拖到上面常用色）—— 光标要提前说出来 */
  cursor: pointer;
}
.vn-cell.is-sel {
  border-color: var(--wb-focus);
  background: var(--wb-focus-ring);
}
.vn-cell.is-src {
  opacity: 0.45;
}
.vn-thumb-btn {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  flex-shrink: 0;
}
.vn-thumb-btn:disabled {
  cursor: default;
}
.vn-thumb {
  width: 56px;
  height: 56px;
  object-fit: contain;
}
.vn-cell__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.vn-cell__raw {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  min-width: 0;
}
.vn-raw {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 12ch;
}
/* 色名（只读）+ 选中标记：整格都是"选中/拖动"的抓手（2026-10-30） */
.vn-cell__name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.vn-sel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  font-size: 11px;
  line-height: 1;
  color: var(--wb-primary-contrast);
  border: 1px solid var(--wb-border);
  border-radius: 4px;
}
.vn-sel.is-on {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
}
.vn-name {
  font-size: 12px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vn-name.is-empty {
  font-weight: 400;
  color: var(--wb-text-muted);
}
.vn-cell__foot {
  display: flex;
  gap: 6px;
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.vn-cell__style {
  overflow: hidden;
  text-overflow: ellipsis;
}
.vn-cell__err {
  margin: 0;
  font-size: 11px;
  color: var(--wb-danger, #c0392b);
}
.vn-empty {
  padding: 12px 0;
}
.vn-more {
  margin: 0;
  font-size: 12px;
}
.vn-viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.66);
  cursor: zoom-out;
}
.vn-viewer__img {
  max-width: 88vw;
  max-height: 88vh;
  border-radius: var(--wb-radius-sm);
  background: #fff;
}
</style>
