<template>
  <!-- 归属款选择器（2026-10-28）：「归类核对」的款不再用原生下拉。
       ─────────────────────────────────────────────────────────────────────
       为什么要换掉 `<select>`：下拉里**只有文字**（款编码 + 名），而这件事的判据是**图**
       —— 用户原话「只是通过下拉列表看文字，不够直观，也容易对应错」。原生下拉不能放图，
       也没有任何办法在展开时把"这一行的订单图"摆在旁边 ⇒ 只能换成弹层。

       ⚠️ 与「产品管理」的 `ProductPicker` 是同构但**不是同一个东西**，别合并：
          · 那边选的是 `pl_products`（产品，走 `api.list`），这边选的是 `oi_styles` 款全集
            （走 `orderStyleList`，**含停用款** —— 历史订单可能正指向它）；
          · 那边的颜色是**商品级** `spec`，取词表 `COLOR_SWATCH`；这边的颜色是**行级的款色**
            （`oi_style_colors`，该款真实有的色），两套口径混用会落出没有名字的款色。
          · 只有"搜索 + 带图列表 + 单选"这个交互形状是借来的（那部分是 `StyleList.vue`，两处共用）。

       ⚠️ 本弹层**自己不写库**：它只 emit「款 + 色」+ 一个"要不要立刻存"的意图，
          真正的落库由父层那一条 `saveCorrection` 完成（两处各写一套必然分叉）。

       ⚠️⚠️ 2026-10-28 晚：加「保存并下一条」（用户原话「路径太长：点击、选择、关闭、确认」）。
          主按钮从"只回填草稿"改成**直接落库并推进到下一行**，路径从 6 步降到 3 步
          （点款格 → 选款 → 选色/保存）。"只填到行内"仍保留 —— 它是可退回的中间态，
          删掉它等于让"先改草稿、回头再一起看"这件事没有入口。 -->
  <div class="wb-mask" data-act="sp-mask" @click.self="$emit('close')">
    <div class="wb-dialog sp-dialog" role="dialog" aria-modal="true" aria-label="选择归属款">
      <div class="wb-dialog__head">
        <span>选择归属款</span>
        <span v-if="orderNo" class="wb-mono wb-muted sp-head__no" data-act="sp-order-no">{{ orderNo }}</span>
      </div>

      <div class="wb-dialog__body sp-body">
        <!-- 订单图**固定在左边且不随列表滚走**：这一页的动作是"拿这张图去挑款"，
             图一离开视线就只能靠记忆比对 —— 那正是"对应错"的来源。
             点击放大：与表格里的 ⤢ 走同一个实现（父层的 `openImage` 读原图），不另开一套。 -->
        <div class="sp-side">
          <button
            v-if="orderImage"
            type="button"
            class="sp-order"
            data-act="sp-order-img"
            title="点开看原图"
            @click="$emit('zoomOrder')"
          >
            <img :src="orderImage" alt="" />
            <span class="sp-order__zoom" aria-hidden="true">⤢</span>
          </button>
          <span v-else class="wb-thumb wb-thumb--empty sp-order" data-act="sp-order-empty"></span>
          <p class="sp-side__meta" data-act="sp-order-meta">
            <span v-if="shop">{{ shop }}</span>
            <span v-if="orderColor">订单颜色「{{ orderColor }}」</span>
            <span v-if="size">尺码 {{ size }}</span>
            <span v-if="!shop && !orderColor && !size" class="wb-muted">这条订单没有更多信息</span>
          </p>
        </div>

        <!-- 右栏：搜索 + 带图列表（与批量定款共用 `StyleList`）+ 色卡 -->
        <div class="sp-main">
          <StyleList
            ref="listEl"
            :styles="styles"
            :current="picked"
            prefix="sp"
            @pick="onPick"
          >
            <!-- ── 就地建款（2026-11-02）─────────────────────────────────────────────
                 用户口径：「不存在款时要能继续，不必先去基础数据建款」。
                 数据层其实早就允许点名一个产品库里还没有的款（宿主 `ensureStyleByCode` 会补占位款），
                 缺的只是**入口** —— 这一行就是那个入口。
                 ⚠️ 本弹层仍然**不写库**：`create` 交给父层（那里只有一条 `productUpsert`），
                    建完父层调 `acceptCreated()` 回来，弹层才知道"建好了、选中它"。
                 ⚠️ 编码预填 `suggestedCode`（父层用 `productNextCode` 取），但不许留空提交 ——
                    空编码在宿主会被判成"编码不能为空"，与其让它失败一次，不如按钮就按不动。 -->
            <template #tail="{ keyword }">
              <div v-if="!creating" class="sp-new" data-act="sp-new-wrap">
                <button type="button" class="sp-new__btn" data-act="sp-new-style" @click="startCreate(keyword)">
                  <span class="sp-new__plus" aria-hidden="true">＋</span>
                  新建款{{ keyword ? `「${keyword}」` : '' }}
                  <span class="wb-muted sp-new__sub">建完直接选中，不用去「产品管理」</span>
                </button>
              </div>
              <div v-else class="sp-new__form" data-act="sp-new-form">
                <div class="sp-new__row">
                  <span class="sp-new__k">编码</span>
                  <input
                    v-model="newCode"
                    class="wb-input wb-input--sm sp-new__code"
                    data-act="sp-new-code"
                    maxlength="64"
                    placeholder="如 STYLE-014"
                    @keydown.enter.prevent="submitCreate"
                  />
                </div>
                <div class="sp-new__row">
                  <span class="sp-new__k">名称</span>
                  <input
                    v-model="newName"
                    class="wb-input wb-input--sm sp-new__name"
                    data-act="sp-new-name"
                    maxlength="200"
                    placeholder="可空，之后在「产品管理」补"
                    @keydown.enter.prevent="submitCreate"
                  />
                </div>
                <p v-if="createError" class="wb-notice wb-notice--error sp-new__err" data-act="sp-new-error">
                  {{ createError }}
                </p>
                <div class="sp-new__acts">
                  <button
                    class="wb-btn wb-btn--sm wb-btn--primary"
                    type="button"
                    data-act="sp-new-ok"
                    :disabled="createBusy || !newCode.trim()"
                    @click="submitCreate"
                  >
                    {{ createBusy ? '建款中…' : '建这个款' }}
                  </button>
                  <button
                    class="wb-link"
                    type="button"
                    data-act="sp-new-cancel"
                    :disabled="createBusy"
                    @click="cancelCreate"
                  >
                    取消
                  </button>
                  <span class="wb-muted sp-new__note">建的是产品库的款（真主数据），不是只服务这一单的临时款</span>
                </div>
              </div>
            </template>
          </StyleList>

          <!-- ── 颜色区（2026-11-02 定稿：**只从颜色库点选**）────────────────────────
               这块改过两版都不对，先把结论写在这里：
                 ① 第一版：有款色时只给几个 chips、**没有加色出口** ⇒ 缺色即死路；
                 ② 第二版：补了「＋ 新色」，却是一个**自由文本输入框** ⇒ 用户当场否掉：
                    「在款中增加颜色不能填名称，否则又会造成颜色库中的数据重复」。
               所以现在只留一条路：**点颜色库里的色**。复用 `ColorPalette`（与产品编辑页
               SKU 矩阵、命名板**同一个组件、同一份字典单例**）：
                 · 打勾 = 这个款已经有这个色；
                 · 点一个没打勾的 = 本次给它加上这个色（保存时随 `saveCorrection` 落库，
                   宿主 `ensureStyleColor` 建款色）；
                 · 末尾「＋ 新增颜色」写的是**颜色库**（`md_colors`，同名幂等），
                   不是给这个款随手起个名 —— 加一次，所有款都能选到它。

               ⚠️ 款色里可能有颜色库没有的名字（识别链早就学过、或字典还没整理）。它们
                  **必须照样列出来**：否则"这个款明明标着黑、界面上却点不到"就成了新的死路。
                  排序是"本款已有的在前、库色在后"，并在提示里点明"不在颜色库"。
               ⚠️ 颜色字典是模块级单例（`colorDict.ts`），弹层打开即 `loadColorDict()`。
                  **没读到就只列款色、不给新增入口**（`colorDictLoaded`）—— 那时 `colorDictNames`
                  回落的是内置常用色（`黑`/`白`/`灰`），点一下就会写出一个字典里没有的款色，
                  正好制造用户这次要治的那种重复。 -->
          <div v-if="pickedRow" class="sp-colors" data-act="sp-colors">
            <span class="wb-muted sp-colors__label">颜色</span>
            <ColorPalette
              :colors="paletteColors"
              :present="pickedRow.colors"
              :current="color"
              :act="'sp-pal'"
              :disabled="busy"
              :allow-add="colorDictLoaded"
              compact
              :title-for="colorTitle"
              @pick="pickColor"
              @added="onColorAdded"
            />
            <span class="wb-muted sp-colors__hint" data-act="sp-colors-hint">{{ colorsHint }}</span>
            <span v-if="colorNote" class="wb-muted sp-colors__note" data-act="sp-colors-note">{{ colorNote }}</span>
          </div>
        </div>
      </div>

      <div class="wb-dialog__foot sp-foot">
        <div class="sp-foot__left">
          <!-- 「不点名款」= 回到按图片指纹自动匹配。这是原下拉里 `value=""` 那一项，
               换控件时**不能丢**：改错了要能退回去，否则只能去改库。 -->
          <button class="wb-link" type="button" data-act="sp-auto" :disabled="busy" @click="$emit('clear')">
            不点名款（按图片指纹自动匹配）
          </button>
          <!-- 灰因常显：按钮为什么按不动要写在按钮旁边，不能只躺在 title 里 -->
          <span v-if="!picked" class="wb-muted sp-blocked" data-act="sp-blocked">
            先选一个款
          </span>
          <span v-else-if="needColor" class="wb-muted sp-blocked" data-act="sp-need-color">
            {{
              pickedRow && pickedRow.colors.length
                ? `还要选一个颜色（本款已有 ${pickedRow.colors.length} 个，其余在颜色库里；点一下就行）`
                : '这个款还没有颜色 —— 从颜色库点一个'
            }}
          </span>
        </div>
        <button class="wb-btn" type="button" data-act="sp-cancel" :disabled="busy" @click="$emit('close')">
          取消
        </button>
        <!-- 「只填上」= 旧语义（回填草稿，不落库）。留着的原因：有人想先把几行填好、回头一起看；
             但它**不是**主路径 —— 用户抱怨的"关闭+确认"两步正是它带来的。 -->
        <button
          class="wb-btn"
          type="button"
          data-act="sp-confirm"
          :disabled="!picked || needColor || busy"
          @click="submit(false)"
        >
          只填上
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="sp-save-next"
          :disabled="!picked || needColor || busy"
          @click="submit(true)"
        >
          {{ busy ? '保存中…' : hasNext ? '保存并下一条' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 归属款选择器（「归类核对」行内「归属款」格的落点）。
//
// 四条口径（改这块前先读）：
//   ① **图是主判据**：款首图 + 订单图并排，搜索按「款编码 / 款名」本地过滤（数据已在内存，
//      不再发 IPC —— 款全集由父层 `listStyleOptions()` 一次取到）。
//   ② **颜色 = 款色 ∪ 颜色库**（2026-11-02 定稿）。款色来自 `oi_style_colors`，
//      颜色库来自 `md_colors`（共享单例 `colorDict.ts`）。只列款色会让缺色变成死路；
//      只列库色会让"款色里那个库里还没有的名字"凭空消失。合并列、款色优先、去重。
//      换款后旧颜色不在新色卡里 ⇒ **留空让人重选**（与父层同一条规则，两处各判一次必然分叉：
//      一处清空一处保留，症状是"明明记住了却永远要重选"）。
//   ③ **不写库**：只 emit 选中的「款 + 色」以及"是否立刻存"。唯一的例外是 `ColorPalette`
//      末尾的「＋ 新增颜色」—— 它写的是**颜色库**（`md_colors`，同名幂等），不是款色；
//      款色仍然只在 `saveCorrection` 那一条路上落库。
//   ④ **款没录颜色时不放行空色**（2026-10-28）：原先这里允许"没颜色也能确定"，而行内
//      `colorMissing` 又会把「保存」禁掉 ⇒ 用户被卡在一个没有出路的状态里（弹层说可以、
//      行内说不行）。现在弹层里直接给入口并要求填上，闭环。
//
// ⚠️ 2026-11-02（用户口径「不存在款或不存在款色时就没办法进入下一步」）——**补两个出口**：
//      · 「＋ 新建款」：款不在列表里也不必离开本页。**仍然不写库**，只 emit `create`，
//        由父层那一条 `productUpsert` 落库后调 `acceptCreated()` 回来；
//      · 缺色：**从颜色库点选**（`ColorPalette`）。⚠️ 这一版之前试过"给个输入框自己打色名"，
//        被用户当场否掉 ——「在款中增加颜色不能填名称，否则又会造成颜色库中的数据重复」。
//        所以这里没有自由文本：要一个库里没有的色，走末尾「＋ 新增颜色」（写库、同名幂等），
//        加完它就在库里，所有款都能选到，不会出现"黑 / 黑色"两份主数据。
//    这两个出口刻意都**不直接写款色**：一处写库的实现只该有一条，弹层里再开一条必然分叉。
import { computed, onMounted, ref } from 'vue';
import StyleList from './StyleList.vue';
import ColorPalette from '@/core/components/ColorPalette.vue';
import { colorDictLoaded, colorDictNames, loadColorDict } from '@/core/services/colorDict';
import type { StyleRecord } from '@/types';

const props = withDefaults(
  defineProps<{
    /** 款全集（父层已取；含停用款） */
    styles: StyleRecord[];
    /** 这一行的订单图（缩略图 dataUrl）；取不到时空占位 */
    orderImage?: string;
    orderNo?: string;
    shop?: string;
    size?: string;
    /** 订单自己的颜色（只作提示，**不预选**：它可能不在该款色卡里） */
    orderColor?: string;
    currentStyle?: string;
    currentColor?: string;
    /** 这一行保存后还有下一行（决定主按钮文案「保存并下一条」/「保存」） */
    hasNext?: boolean;
    /** 父层正在落库（期间禁用全部动作，避免连点写出两次） */
    busy?: boolean;
    /**
     * 新建款时编码的预填值（父层用 `productNextCode` 取，如 `STYLE-014`）。
     *
     * ⚠️ 只预填、**不代替用户提交**：空编码在宿主会判"编码不能为空"，
     *    与其让它失败一次不如按钮就按不动（见模板 `sp-new-ok` 的 disabled）。
     */
    suggestedCode?: string;
  }>(),
  {
    orderImage: '',
    orderNo: '',
    shop: '',
    size: '',
    orderColor: '',
    currentStyle: '',
    currentColor: '',
    hasNext: false,
    busy: false,
    suggestedCode: '',
  }
);

const emit = defineEmits<{
  close: [];
  /**
   * 选中「款 + 色」。
   * `save` = true 表示"现在就落库"（父层 `saveCorrection`）；false = 只回填草稿。
   * `color` **必非空**：款已有色 ⇒ 点一个；款没有 ⇒ 从颜色库点一个（保存时宿主建款色）。
   */
  pick: [value: { styleCode: string; color: string }, save: boolean];
  /** 不点名款（回到自动匹配） */
  clear: [];
  /** 请求父层把订单图放大（复用父层已有的原图弹层） */
  zoomOrder: [];
  /**
   * 请求父层在**产品库**建一个款（真主数据）。
   *
   * 父层落库成功后必须调 `acceptCreated(rec)`，失败调 `failCreate(msg)` ——
   * 这个弹层不自己调 IPC，也不自己判断成功（"写库只有一处实现"）。
   */
  create: [value: { code: string; name: string }];
}>();

const picked = ref(props.currentStyle || '');
const color = ref(props.currentColor || '');
const listEl = ref<InstanceType<typeof StyleList> | null>(null);
/** 「刚刚就地建好了这个款」——只影响颜色区那句提示，别处不读它 */
const justCreated = ref(false);
/** 「已加进颜色库」这类说明；换款/换色后清掉 */
const colorNote = ref('');

const pickedRow = computed(() => props.styles.find((s) => s.code === picked.value) ?? null);

/**
 * 能不能提交：款必须有；颜色按"这个款有没有色卡"分两种判据，但**结论都是必须非空**。
 *
 * ⚠️ 判据刻意不合并成 `colorMissing`（父层那条是落库守卫，必须独立成立）——
 *    这里只是"提前告诉他"，两处各判一次的风险是文案漂移，不是数据错。
 */
const needColor = computed(() => {
  if (!pickedRow.value) return false;
  return !color.value.trim();
});

// ───────────────────────────────────────── 新建款（就地建档）
/** 建款表单摊开了没有 */
const creating = ref(false);
const newCode = ref('');
const newName = ref('');
const createBusy = ref(false);
/** 宿主的拒绝原话（编码被占用 / 编码不能为空…）—— 必须显示原话，不能统一写成"新建失败" */
const createError = ref('');

function startCreate(keyword: string): void {
  creating.value = true;
  createError.value = '';
  newCode.value = props.suggestedCode || '';
  newName.value = keyword || '';
}

function cancelCreate(): void {
  if (createBusy.value) return;
  creating.value = false;
  createError.value = '';
}

function submitCreate(): void {
  if (createBusy.value) return;
  const code = newCode.value.trim();
  if (!code) {
    createError.value = '编码不能为空';
    return;
  }
  createBusy.value = true;
  createError.value = '';
  emit('create', { code, name: newName.value.trim() });
}

/**
 * 父层建款成功：**选中它**，并把注意力引到颜色区。
 *
 * 为什么不再自动摊开一个输入框（2026-11-02 改）：颜色现在只能从颜色库点选，
 * 没有"摊开输入框"这回事了；该做的事变成"把话说清楚 —— 点一个颜色就能存"。
 * 那句提示由 `colorsHint` 的 `justCreated` 分支给，选完色自动收回去。
 */
function acceptCreated(rec: StyleRecord): void {
  createBusy.value = false;
  creating.value = false;
  createError.value = '';
  newCode.value = '';
  newName.value = '';
  picked.value = rec.code;
  color.value = '';
  colorNote.value = '';
  justCreated.value = true;
}

/** 父层建款失败：**不关弹层**、不清输入（用户改一个字符就能重试） */
function failCreate(msg: string): void {
  createBusy.value = false;
  createError.value = msg || '新建款失败';
}

// ───────────────────────────────────────── 选色（只从颜色库点选）
/**
 * 颜色区要展示的色名 = **这个款已有的色**（排前面）+ **颜色库里的其余色**。
 *
 * 为什么两张表要并起来（而不是只显示其中一张）：
 *   · 只显示款色 ⇒ 缺色时仍然没有出口（第一版的死路）；
 *   · 只显示库色 ⇒ 款色里那些"库里还没有"的名字会消失，用户看得见订单上写着「黑」，
 *     界面上却点不到它 —— 比死路更难理解，因为屏幕上没有"缺"的迹象。
 * 重复的只留一份（款色优先）：同一个色名在两处都会出现，摊开两遍会让人以为要选两次。
 *
 * ⚠️ 字典**没读到**时只列款色：`colorDictNames` 在那种情况下会回落内置常用色
 *    （`黑`/`白`/`灰`），而字典种子是 `黑色`/`白色`/`灰色` —— 在回落表上点一下，
 *    写进 `oi_style_colors` 的就是一个字典里没有的款色，颜色库从此多一份重复。
 *    这正是用户这次要治的病，界面不能自己制造一个入口。
 */
const paletteColors = computed<string[]>(() => {
  const own = pickedRow.value?.colors ?? [];
  if (!colorDictLoaded.value) return [...own];
  const dict = colorDictNames.value;
  const seen = new Set(own);
  return [...own, ...dict.filter((c) => !seen.has(c))];
});

/** 「这个款有几个色不在颜色库里」——决定提示里要不要多说一句（见 `colorsHint`） */
const offDictCount = computed(() => {
  if (!colorDictLoaded.value) return 0;
  const known = new Set(colorDictNames.value);
  return (pickedRow.value?.colors ?? []).filter((c) => !known.has(c)).length;
});

/** 颜色区顶部的一句说明：把"打勾是什么意思""没有的去哪加"一次说完 */
const colorsHint = computed(() => {
  const row = pickedRow.value;
  if (!row) return '';
  if (!colorDictLoaded.value) {
    return row.colors.length
      ? '颜色库还没读到 —— 这个款已有的色照常可选；要加新色请关掉这一格重开'
      : '颜色库还没读到 —— 关掉这一格重开；仍读不到就不能在这一页定色（免得写出库里没有的色名）';
  }
  if (justCreated.value) return '款建好了 —— 点一个颜色（颜色库里没有再点末尾「＋ 新增颜色」）';
  const own = row.colors;
  if (!own.length) return '这个款还没选过颜色 —— 从颜色库点一个，保存后它就是该款的色卡';
  const orderOwn = String(props.orderColor || '').trim();
  if (orderOwn && !own.includes(orderOwn)) {
    return `订单色「${orderOwn}」不在这个款的色卡里 —— 从下面点一个给它（会记住这个对应关系）`;
  }
  return offDictCount.value
    ? `打勾 = 这个款已有；另有 ${offDictCount.value} 个款色不在颜色库里（去「基础数据」可以合并成同一个色）`
    : '打勾 = 这个款已有；点没打勾的 = 保存时给它加上';
});

/** 色点胶囊的 title：把"点了会发生什么"说在鼠标停的地方 */
function colorTitle(c: string): string {
  const own = pickedRow.value?.colors ?? [];
  return own.includes(c)
    ? `这个款已经有「${c}」—— 点一下就用它`
    : `用「${c}」—— 保存后它成为这个款的色卡`;
}

function pickColor(c: string): void {
  color.value = c;
  colorNote.value = '';
  justCreated.value = false;
}

/**
 * 颜色库里**新增**了一个色（`ColorPalette` 的「＋ 新增颜色」走 `addColorToDict`，同名幂等）。
 *
 * 新增完直接选中它：用户点这个按钮的意图就是"我要用这个色"，再让他回列表里找一遍
 * 等于把一步拆成两步。注意它此刻只进了**颜色库**，成为这个款的色仍是保存那一步的事。
 */
function onColorAdded(name: string): void {
  const n = String(name ?? '').trim();
  if (!n) return;
  color.value = n;
  justCreated.value = false;
  colorNote.value = `「${n}」已加进颜色库 —— 保存后成为这个款的色（别的款也能选到它）`;
}

/** 颜色字典是模块级单例：弹层打开时对齐一次（别的页面刚加过色也能立刻选到） */
onMounted(() => {
  void loadColorDict();
});

/**
 * 列表回填。换款后旧颜色落在新色卡里就保留（省一次点击），不在就清空（父层同规则）。
 *
 * ⚠️ `via === 'enter'` 时**直接提交**（`sp-confirm` 那条路，即只填上）：搜索框里敲编码 + 回车
 *    是一条"我看见就是这个款"的快路径，让它停在"还要再点一下"没有意义。
 *    注意这里提交的是 `save=false`（旧语义）—— 敲回车不等于"我要把它存进库"，
 *    真要存的人会去按那个写着「保存」的按钮。
 */
function onPick(s: StyleRecord, via: 'click' | 'enter'): void {
  picked.value = s.code;
  // 换了款：那句"已加进颜色库 / 款建好了"的说明是按上一个款说的，留着会指向错对象
  colorNote.value = '';
  justCreated.value = false;
  if (s.colors.length && !s.colors.includes(color.value)) color.value = '';
  if (via === 'enter' && !needColor.value) submit(false);
}

function submit(save: boolean): void {
  if (!picked.value || needColor.value || props.busy) return;
  emit('pick', { styleCode: picked.value, color: color.value.trim() }, save);
}

defineExpose({
  focusSearch: (): void => listEl.value?.focusSearch(),
  /** 父层建款成功后的回执入口（见 `create` 事件） */
  acceptCreated,
  /** 父层建款失败后的回执入口 */
  failCreate,
});
</script>

<style scoped>
.sp-dialog {
  width: min(92vw, 780px);
}

.sp-head__no {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}

/* 两栏：左订单图（固定）+ 右选择区。左栏窄而固定，右栏吃掉剩余宽度 */
.sp-body {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.sp-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: sticky;
  top: 0;
}

.sp-order {
  position: relative;
  display: block;
  width: 132px;
  height: 132px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  line-height: 0;
  cursor: zoom-in;
  overflow: hidden;
}

.sp-order img {
  width: 100%;
  height: 100%;
  /* 与表格同一条口径：核对要看**整张图**，不裁 */
  object-fit: contain;
}

.sp-order__zoom {
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

.sp-side__meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--wb-text-muted, var(--wb-muted, #888));
}

.sp-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.sp-colors {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  min-height: 40px;
}

.sp-colors__label {
  font-size: 12px;
  margin-right: 2px;
}

.sp-colors__hint {
  font-size: 12px;
}

.sp-foot__left {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: auto;
  flex-wrap: wrap;
}

.sp-blocked {
  font-size: 12px;
}

/* ── 就地建款（2026-11-02）────────────────────────────────────────────────
   它挂在款列表的**尾巴**上：搜不到时视线就停在"没有匹配的款"那一行，出口必须紧接着它。
   虚线 + 无底色，是为了与"已存在的款"区分开 —— 这一行点了会写出新数据，
   不能长得跟上面那些"选了就完事"的行一样。 */
.sp-new {
  padding: 6px 0 2px;
}

.sp-new__btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: transparent;
  color: var(--wb-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.sp-new__btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.sp-new__plus {
  font-size: 14px;
  line-height: 1;
}

.sp-new__sub {
  margin-left: auto;
  font-size: 12px;
}

.sp-new__form {
  padding: 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-new__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sp-new__k {
  width: 32px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--wb-text-muted, var(--wb-muted, #888));
}

.sp-new__code {
  width: 150px;
}

.sp-new__name {
  flex: 1;
  min-width: 0;
}

.sp-new__err {
  margin: 0;
  font-size: 12px;
}

.sp-new__acts {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sp-new__note {
  font-size: 12px;
}

.sp-colors__note {
  flex-basis: 100%;
  font-size: 12px;
}
</style>
