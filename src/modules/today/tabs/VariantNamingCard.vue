<template>
  <!-- 命名板（P3）：归类自动化之后**人这一端唯一还剩的判断** —— "这个色在我生意里叫什么"。
       ⚠️ 它与「归类核对」是两件事，别合并：
          核对 = 这行属于哪个款色（现在由变体键回答，人工 0 次）；
          命名 = 那个款色叫什么（只有人能回答，且**可以永远不做**）。
       所以本卡不给任何"未完成就走不下去"的暗示：没有名字的色在统计与拿货里照样出数，
       只是显示成平台原文（`5` / `Picture color4`）。 -->
  <section class="wb-panel vn" data-act="vn-panel">
    <div class="wb-panel__head vn-head">
      <div class="vn-head__text">
        <strong class="vn-title">颜色叫什么</strong>
        <!-- 计数只有一处：面板标题旁。它同时是"要不要展开"的理由 ——
             0 个待办时整张卡收成一行，用户在核对页看不到多余的东西。 -->
        <span class="wb-muted vn-count" data-act="vn-count">
          <template v-if="board.unnamedKeys > 0">
            还有 <b>{{ board.unnamedKeys }}</b> 个颜色是平台原文，共 {{ board.totalKeys }} 个
          </template>
          <template v-else>全部 {{ board.totalKeys }} 个颜色都起过名了</template>
        </span>
      </div>
      <div class="vn-head__ops">
        <button
          v-if="board.unnamedKeys === 0 && board.totalKeys > 0"
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="vn-toggle-all"
          @click="showAll = !showAll"
        >
          {{ showAll ? '收起' : '查看全部颜色' }}
        </button>
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
        左边是订单图，右边填一个自家的叫法（例如 5 → 藏青）。填完按回车即存；不起名不影响统计和拿货。
      </p>

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
          <span v-if="g.colors.length" class="wb-muted vn-group__meta">
            · {{ g.colors.length }} 色
          </span>
          <!-- 组内进度：一屏只铺 6 个 listing，人需要一个"这一组填完了没"的读数，
               否则最后一个色存完也不知道能不能往下走。 -->
          <span
            v-if="leftOf(g) > 0"
            class="wb-muted vn-group__meta"
            :data-act="`vn-group-left-${g.itemId}`"
          >
            · 还剩 {{ leftOf(g) }} 个没起名
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
            v-for="c in g.colors"
            :key="c.styleColorId"
            class="vn-cell"
            :class="{ 'is-named': c.named }"
            :data-act="`vn-cell-${c.styleColorId}`"
          >
            <button
              type="button"
              class="vn-thumb-btn"
              :disabled="!c.localPath"
              :title="c.localPath ? '看原图' : '这条订单没有主图'"
              :data-act="`vn-thumb-${c.styleColorId}`"
              @click="openImage(c)"
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
              <div class="vn-cell__input">
                <input
                  class="wb-input wb-input--sm vn-input"
                  :data-act="`vn-input-${c.styleColorId}`"
                  :value="draftOf(c)"
                  :placeholder="c.colorRaw || '起个名字'"
                  maxlength="40"
                  @input="onInput(c, ($event.target as HTMLInputElement).value)"
                  @keyup.enter="saveOne(c, g)"
                />
                <button
                  type="button"
                  class="wb-btn wb-btn--sm"
                  :data-act="`vn-save-${c.styleColorId}`"
                  :disabled="!dirtyOf(c)"
                  @click="saveOne(c, g)"
                >
                  保存
                </button>
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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ipc } from '@/core/services/ipc';
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
 * 三条设计纪律（每条都对应一个已踩过的坑）：
 *   ① **可跳过**：不起名不影响统计与拿货 —— 卡上的计数说"还有 N 个"，不说"必须做完 N 个"。
 *      一旦做成前置，58 次输入就从可选变成门槛，等于把维护面换个名字搬回来。
 *   ② **一屏一批**：按 listing 分组，组内所有色键同时可见可填（不是逐键翻页）。
 *   ③ **保存是显式的**（回车 / 按钮），不做 blur 自动保存：色名会进拿货单，
 *      一次误触的失焦不该改变将要发给厂家的那张纸。
 */

const board = ref<VariantNamingBoard>({ groups: [], unnamedKeys: 0, totalKeys: 0 });
const loading = ref(false);
const error = ref('');
/** 正在保存的行数（并发计数；>0 时禁用输入，避免两次保存互相覆盖草稿） */
const busy = ref(0);
const collapsed = ref(false);
const showAll = ref(false);
/** 草稿：`styleColorId → 输入框里的值`（未改动的不进这里，`draftOf` 回落当前名） */
const draft = ref<Record<number, string>>({});
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

const visible = computed(
  () => !collapsed.value && (board.value.unnamedKeys > 0 || showAll.value),
);

/** 待处理（或全部，`showAll` 时）的组 —— 排序与"哪些组还有活"都由主进程算好，这里只切片 */
const workGroups = computed<VariantNamingGroup[]>(() => {
  const all = board.value.groups;
  if (showAll.value || board.value.unnamedKeys === 0) return all;
  return all.filter((g) => g.colors.some((c) => !c.named));
});

const shownGroups = computed<VariantNamingGroup[]>(() => workGroups.value.slice(0, cap.value));

const hiddenGroups = computed(() =>
  showAll.value || board.value.unnamedKeys === 0
    ? 0
    : Math.max(0, workGroups.value.length - cap.value),
);
const hiddenKeys = computed(() =>
  workGroups.value.slice(cap.value).reduce((n, g) => n + g.colors.filter((c) => !c.named).length, 0),
);

function draftOf(c: VariantColorItem): string {
  const d = draft.value[c.styleColorId];
  return d === undefined ? c.colorName : d;
}

/** 这一组还剩几个色是平台原文（组的进度，不是总进度；总数只有 `board.unnamedKeys` 一处口径） */
function leftOf(g: VariantNamingGroup): number {
  return g.colors.filter((c) => !c.named).length;
}

/**
 * 存完之后该把光标交给谁：**同组的下一个未命名框**，本组没了就交下一组的第一个。
 *
 * 为什么这件事不能省（真库实测的依据）：待命名是 54 个键、分布在 37 个 listing 上。
 * 每次保存后组件会重读命名板（`finally` 里 reload），重排会把已命名的色挪到组尾、
 * 输入框重建 —— 不主动落焦的话，人每填一个都要再用鼠标点下一个框，54 次。
 * 这是这一页唯一还属于人的劳动，能省的只有"找框"这一半。
 *
 * 为什么**不**按"同一个平台原文"批量命名（`1` 在 7 个 listing 上都出现）：平台原文是
 * 商品级的编号，不同 listing 的 `1` 根本不是同一个颜色（键是 `(店铺, 商品, 原文色)` 也正是
 * 因为这个）。批量按原文命名 = 把"位置"当"语义"，错得悄无声息，还会被自己的键记住。
 */
function nextFocusOf(c: VariantColorItem, g: VariantNamingGroup): number {
  const idx = g.colors.findIndex((x) => x.styleColorId === c.styleColorId);
  const rest = idx >= 0 ? g.colors.slice(idx + 1) : [];
  const next = rest.find((x) => !x.named);
  if (next) return next.styleColorId;
  const gi = workGroups.value.findIndex((x) => x.itemId === g.itemId && x.shop === g.shop);
  for (const g2 of workGroups.value.slice(gi + 1)) {
    const first = g2.colors.find((x) => !x.named);
    if (first) return first.styleColorId;
  }
  return 0;
}

/** 待落焦的框（`styleColorId`）；重读完成后再落，因为 reload 会重建 DOM */
const pendingFocus = ref(0);

async function applyPendingFocus(): Promise<void> {
  const id = pendingFocus.value;
  if (!id) return;
  pendingFocus.value = 0;
  await nextTick();
  // 用 `data-act` 找而不是 `ref` 数组：一个 listing 里的框是 v-for 出来的、重排后会重建，
  // 而 `data-act` 是这页与冒烟脚本共用的稳定标识（两边找的是同一个东西）。
  const el = document.querySelector<HTMLInputElement>(`[data-act="vn-input-${id}"]`);
  if (!el) return; // 目标被折叠/滑出这一批（cap 切片）—— 不抢焦点，别把人跳到别处
  el.focus();
  el.select();
}

/** 是否有改动（空串也算改动 —— 让人能看见"我清空了"，由保存时的校验来拒绝）。 */
function dirtyOf(c: VariantColorItem): boolean {
  return draftOf(c) !== c.colorName;
}

function onInput(c: VariantColorItem, v: string): void {
  draft.value = { ...draft.value, [c.styleColorId]: v };
  if (rowError.value[c.styleColorId]) {
    const next = { ...rowError.value };
    delete next[c.styleColorId];
    rowError.value = next;
  }
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

async function saveOne(c: VariantColorItem, g: VariantNamingGroup): Promise<void> {
  // ⚠️ 这里**不许**写 `if (busy > 0) return`：那是"上一次还没存完就把这次回车丢掉"，
  //    界面毫无反馈（用户以为名字存上了）。一次填 6 个色的正常用法必然连按回车，
  //    所以并发是常态，按行各存各的；整批只用一个计数决定"什么时候该刷新"。
  const name = draftOf(c).trim();
  busy.value += 1;
  try {
    const r = await renameVariantColor(c.styleColorId, name);
    if (!r.ok) {
      rowError.value = { ...rowError.value, [c.styleColorId]: r.error || '没保存成功' };
      return; // 被拒时**不动光标**：人还得在同一个框里改（跳走等于把错误甩在身后）
    }
    // 光标交给下一个未命名的框（顺序在点击那一刻确定，重排后依然成立）
    pendingFocus.value = nextFocusOf(c, g);
    // 成功后把草稿清掉（新值以服务端回读为准，下次 reload 会带回来）
    const next = { ...draft.value };
    delete next[c.styleColorId];
    draft.value = next;
  } catch (e: unknown) {
    rowError.value = {
      ...rowError.value,
      [c.styleColorId]: e instanceof Error ? e.message : '没保存成功',
    };
  } finally {
    busy.value -= 1;
    // 最后一个存完才回读一次：每行各刷一次会让列表在用户眼前跳 6 次
    if (busy.value === 0) await reload();
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    board.value = await loadNamingBoard();
    await applyPendingFocus(); // 必须在重读之后：DOM 刚被这批新数据重建
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

onMounted(() => {
  void reload();
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
}
.vn-cell.is-named {
  opacity: 0.72;
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
.vn-cell__input {
  display: flex;
  gap: 4px;
  min-width: 0;
}
.vn-input {
  flex: 1;
  min-width: 0;
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
