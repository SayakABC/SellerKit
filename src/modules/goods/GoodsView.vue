<template>
  <div class="wb-page gd-view" :class="{ 'is-embedded': embedded }">
    <header class="wb-head">
      <div class="wb-head__main">
        <!-- 2026-10-17：本页并入「基础数据」左导航的「货品档案」一项。在那一层里
             左导航已经是"我在哪"的答案，再画一个 h1 就是两个标题。所以 embedded 时不画标题，
             但**保留说明 + 全部动作**（帮助 / 简洁模式 / 刷新）—— 它们不是标题的装饰。 -->
        <h1 v-if="!embedded" class="wb-head__title">货与成本</h1>
        <!-- 说明随页签走：一句话回答"这页是干什么的、我什么时候该来这"。
             比原来那句固定枚举（"款式 · SKU · 克重 · 厂家 · 商品ID 映射"）有用 —— 那句话
             在切了页签之后就不成立了，而用户切页签时正是最需要一句解释的时刻。 -->
        <p class="wb-head__desc">{{ TAB_DESC[tab] }}</p>
      </div>
      <div class="wb-head__actions">
        <!-- ⭐ 应用内帮助（2026-10-08 R3 · UX-G5）：全仓原先**没有任何用户可见的帮助入口**
             （扫描"教|教程|帮助|引导|新手|指南"在 `src/**` 的命中全是代码注释）。
             不新建长文档：就把三句话 + 一张三步图放在这里，够回答"这页怎么用"。
             ⚠️ 面板里那两步**都带真按钮**（去「发货台」导订单 / 打开店铺登记）——
             本仓既有结论是"提示不是入口"，一份只说"你应该先去别处"的帮助就是那句话的现行犯。 -->
        <div class="gd-help">
          <button
            class="wb-btn gd-help__btn"
            type="button"
            data-act="help"
            aria-label="这一页怎么用"
            :aria-expanded="helpOpen"
            @click="helpOpen = !helpOpen"
          >
            ?
          </button>
          <div v-if="helpOpen" class="gd-help__panel" data-act="help-panel" role="dialog">
            <div class="wb-panel__head gd-help__head">
              <span>这一页怎么用</span>
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="help-close"
                aria-label="关闭"
                @click="helpOpen = false"
              >
                ✕
              </button>
            </div>
            <div class="gd-help__body">
              <p>
                这一页管两件事：<b>左边</b>给自己立款（款 = 你自己定义的产品），
                <b>右边</b>把店铺里卖的那个商品认到款上（这叫映射 / 认款）。
              </p>
              <p>
                右边那些商品不是导入进来的，是从<b>订单</b>里长出来的 ——
                「发货台」导过订单，这里才会有待办；订单里没有商品ID的行会单独报出来，不会静默丢掉。
              </p>
              <p>
                左边点开任意一行就能看到它的规格与已认的商品。<b>认款入口左右各有一个</b>，
                但落到哪一款只看<b>左边展开的那一行</b>（不是列表里高亮的第一行）。
              </p>
              <p class="gd-help__sub">从零开始的话，顺序是这三步：</p>
              <ol class="gd-help__steps">
                <li v-for="(st, i) in helpSteps" :key="st.id">
                  <span class="gd-help__no">{{ i + 1 }}</span>
                  <span><b>{{ st.title }}</b> —— {{ st.desc }}</span>
                </li>
              </ol>
              <div class="gd-help__acts">
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="help-go-today"
                  @click="goImportOrders"
                >
                  去「发货台」导入订单
                </button>
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="help-go-registry"
                  @click="goRegistry"
                >
                  打开「店名归一」
                </button>
                <!-- 第三步（2026-10-28 起是"看要拿什么"）的出口：帮到这里的人一次跳到落点，
                     而不是让他自己在「发货台」里找页签。 -->
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="help-go-purchase"
                  @click="goPurchase"
                >
                  去「发货台」看要拿什么
                </button>
              </div>
            </div>
          </div>
        </div>
        <!-- ⭐ 简洁模式开关已撤（2026-10-25 用户口径）：一个"默认藏起勾选框 / 批量条 / 统计条"
             的开关让大多数用户永远见不到那些能力。完整形态从现在起是唯一形态。 -->
        <!-- 页级不再自己取数，所以这里没有"读取中…"可报（那是各视图自己的状态，
             它们在各自的工具栏里显示）。按钮只负责发一个刷新信号。 -->
        <button class="wb-btn" data-act="refresh" @click="refresh">刷新</button>
      </div>
    </header>

    <!-- 页签：紧贴主体 —— 页面顶部只剩「页头 + 页签」两层。
         ⚠️ 这里原先还有一条**指标条**（产品 / SKU / 缺克重 / 未关联供应商 / 已映射商品ID）
         与一条**起点引导条**（立款 → 补克重 → 认货），2026-10-08 按用户要求整块撤掉：
           · 指标条那五个数字，左栏每一行本来就带着（`n · 缺 m`、状态列），单独再汇总一行是重复；
           · 引导条的三步，点一遍页签就知道顺序，常驻一条占着一行高度没有换来新的信息。
         配套改动：页签上的**数字徽标**一并去掉（徽标与被撤的指标条同源，留着就要保留整套页级
         汇总取数）；「缺克重 / 未关联供应商」这两个筛选的入口搬进了左栏工具栏（`filter-issue`）。

         ⚠️ 同日 S4：`'workbench'` 形态下**页签由 3 个收成 2 个** ——「产品」与「映射与关联」
         合并为「款与商品」（`data-act="tab-workbench"`）。页签表按形态分叉，理由见 `TABS` 上方的注释。 -->
    <nav v-if="showTabs" class="gd-tabs" role="tablist" aria-label="货与成本">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="gd-tab"
        :class="{ 'is-active': tab === t.id }"
        :aria-selected="tab === t.id"
        :data-act="`tab-${t.id}`"
        @click="goTab(t.id)"
      >
        {{ t.label }}
      </button>
    </nav>

    <p v-if="error" class="wb-notice wb-notice--error gd-error">{{ error }}</p>

    <div class="gd-tabpanel">
      <!-- 工作台形态（S0 骨架 → S4 定型）：左「产品」右「商品池」**恒同屏**。
           S4 把「产品」与「映射与关联」合成一个页签后，池栏不再有"当前看不见"的时候 ——
           于是 `pool` 这个懒挂载开关也一并撤掉（它的唯一理由是"首屏停在产品页签、池栏看不见"，
           合并后该前提消失）。判据与代价见 `GoodsWorkbenchView.vue` 顶部注释。

           `@go-registry` 是**跨模块跳转的回调**（右栏的「现在登记」要用）：外壳转手递给右栏，
           免得右栏为了跳去「基础数据」去 import 模块表与 action 字符串。
           命名刻意不含任何具体目标 —— 外壳不需要知道那边有哪几个资料项，只知道"能请求跳转"。
           2026-10-14 整合前它是"切到本页另一个页签"的回调（`navigate(tab)`），目标模块化后改名。 -->
      <GoodsWorkbenchView
        v-if="GOODS_LAYOUT === 'workbench' && tab === 'workbench'"
        :refresh-nonce="refreshNonce"
        :go-registry="goRegistry"
      />
      <!-- 「商品清单」页签当前**收起**（见 `SHOP_PRODUCTS_TAB_ENABLED`）：分支与组件保留在这里，
           是为了要放回来时只改那一个常量。`tab` 永远取不到这个值，所以这段是不渲染的死代码 ——
           别当成"多余的 else-if"清掉，那是恢复开关的另一半。 -->
      <ShopProductView v-else-if="tab === 'shop-products'" />
      <!-- 以下两支是 `GOODS_LAYOUT === 'tabs'` 的**回退路径**（与重构前逐字一致），不是死代码。
           ⚠️ 2026-10-14：回退形态同样**不再有**「店铺登记 / 供应商 / 进价」三个页签 ——
           它们已搬进「基础数据」模块（见 `./tabs.ts` 头部）。回退只回"这一页的布局"，
           不回"维护功能散在三个模块"——那正是这次整合要消除的东西。 -->
      <ProductListView v-else-if="tab === 'products'" :refresh-nonce="refreshNonce" />
      <SkuMappingView v-else :refresh-nonce="refreshNonce" :go-registry="goRegistry" />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「货与成本」外壳：页头 + 页签（工作台形态 1 个 / 回退形态 3 个，「商品清单」已收起）。
//
// 这一页在 2026-10-01 之前是**薄内建**（只看产品/SKU/克重，重手段在「产品库」UI 岛）。
// 岛与宿主共用同一批数据、同一批 IPC，却因为"岛要单独发布 + 三个版本坐标要同步"而维护成本很高，
// 于是把岛的功能整体收回内建 —— 界面与交互按**单一工作台**重新组织（不再有"这功能在岛里"的心理负担）。
//
// 分工：
//   · 外壳（本文件）只负责**页头、页签、跨模块跳转**；
//   · 各页签自己取自己那份数据，外壳**不再**汇总任何页级数字。
//
// ⚠️ 2026-10-14「基础数据」整合：本页只保留"货"本身（建档与认款）。
//    店铺登记 / 供应商 / 进价三类主数据维护搬进「基础数据」模块，见 `./tabs.ts` 头部与 `goRegistry`。
//
// ⚠️ 2026-10-08 撤掉了两层页级 UI（指标条 + 起点引导条）和页签徽标（见模板中间那段注释）。
//    连带把 `stats` / `loadStats` / `flow.ts` / 子视图→外壳的回报链整条移除：它们唯一的消费者
//    就是那两层，留着只会是"每次刷新都多打几次 IPC、却没有任何人看"的页级空转。
import { computed, onMounted, ref } from 'vue';
import * as api from './api';
import ProductListView from './components/ProductListView.vue';
import GoodsWorkbenchView from './components/GoodsWorkbenchView.vue';
import ShopProductView from './components/ShopProductView.vue';
import SkuMappingView from './components/SkuMappingView.vue';
import { GOODS_TAB_LABEL, type GoodsTabId } from './tabs';
import { FIRST_RUN_STEPS } from './firstRun';
import { switchModule } from '@/core/services/shell';

/**
 * 形态：
 *   · `embedded = false`（默认，独立模块时期）—— 完整页头带 h1「货与成本」；
 *   · `embedded = true` —— 被别人当**内嵌视图**渲染（2026-10-17 起由「基础数据 › 货品档案」用），
 *     只去掉 h1，其余页头动作与页签一字不动。
 *   · `hideTabs = true` —— 2026-10-17 收拢后由「货品档案」传：本页的页签条**交给外层画**
 *     （外层把「款与商品 / 成本 / 供应商」并成一条）。不这么做会出现两条并排的页签条，
 *     而它们说的是同一件事 —— 用户会以为其中一条是"别的层"。
 *
 * ⚠️ 只在**页签数 ≤ 1** 时才允许隐藏（`showTabs` 那个判据）：`GOODS_LAYOUT` 回退成 `'tabs'`
 *    时页签是 2~3 个，隐藏它们等于把产品表与映射队列的入口抹掉，"改一个常量回退"就成了一句假话。
 * ⚠️ 为什么不干脆删掉 h1、让它永远内嵌：本页仍可能被单独打开（`goods:ui` 冒烟直接挂 `.gd-view`，
 *    以及将来"把这个资料项拎出去做独立页"的可能），一个恒缺标题的页面在那种场景下是残的。
 */
const props = withDefaults(defineProps<{ embedded?: boolean; hideTabs?: boolean }>(), {
  embedded: false,
  hideTabs: false,
});
const embedded = props.embedded;

type TabId = GoodsTabId;

/**
 * 「商品清单」页签**暂时收起**（2026-10-08）。
 *
 * 判据是"有没有下游消费者"（同 `docs/notes/2026-10-01-ui-island-retirement` 的域删除判据）：
 * 这一页签的产出是 `pl_shop_sku` 的**池行**（`source='shop-import'` / `shop_id=0`），
 * 而订单归款 / 拣货 / 算钱一律走它的**补集** `skuMappingSql()` —— `skuPoolSql()` 全仓只有
 * `electron/shop-product-db.ts` 自己用。也就是：用户在这里导入商品、关联产品之后，
 * **其它任何页面都不会变**。
 *
 * 它还额外要求一份**独立准备**的 Excel（列名须为「产品ID」「产品图片链接」），而用户真正想要的
 * "导入后看看到底进来了哪些数据"由「映射与关联」的待关联队列（从订单实时聚出）与「发货台」页的
 * 导入回执覆盖了。留着它只会让人以为"少做了这一步所以后面算不出来"。
 *
 * **只收界面，不动数据**：`ShopProductView.vue`、`shop-product-*` 6 个 IPC 通道、`shop-product-db.ts`
 * 与存量池行全部原样保留。要放回来 = 把本常量改成 `true`（TABS 恢复四项），其余一行不用改。
 * 反向守卫在 `scripts/goods-ui-smoke.mjs`（断言页签**没有**它），防止它以"补个入口吧"的名义回来。
 */
const SHOP_PRODUCTS_TAB_ENABLED = false;

/**
 * 页面形态开关（2026-10-08，重构 S0）。
 *
 * `'workbench'` = 左右分栏工作台：左栏「产品」、右栏「商品池」，两栏同屏
 *   （方案见 `docs/plans/GOODS_WORKBENCH_PLAN.md`）。
 * `'tabs'`      = 回到旧的三页签形态（产品 / 映射与关联 / 供应商 各自独占整宽）。
 *
 * **回退 = 改这一个常量**（同 `SHOP_PRODUCTS_TAB_ENABLED` 的先例）：旧组件一个都不删，
 * `'tabs'` 分支保留的是**今天这套一模一样的 DOM**。分阶段上线期间，任何一步出问题都可以
 * 一行改成 `'tabs'` 退回原状，不用回滚代码。
 *
 * ⚠️ `'tabs'` 之外的那套 DOM 不是"死代码"，别当多余的 else 分支删掉 —— 它是回退路径的另一半。
 */
const GOODS_LAYOUT: 'workbench' | 'tabs' = 'workbench';

/**
 * 页签表（2026-10-08 重构 S4：3 → 2；2026-10-14 整合：再 → 1 / 3）。
 *
 * **按页面形态分叉** —— 不是两套界面各自任性，而是两种形态的导航结构本就不同：
 *   · `'workbench'` 把「产品」与「映射与关联」**合并成一个左右分栏的工作台**。合并的判据不是
 *     "少一个页签更清爽"，而是：分栏的全部价值在于**同屏**（左栏看着款、右栏认着货，
 *     左栏选一款右栏就能直连、就能对比）—— 分成两个页签，两侧永远不可能同时出现在屏幕上，
 *     直连与对比这两条动线在物理上就不成立。
 *   · `'tabs'` 回退形态是整宽单栏，产品表与队列必须各自独占一屏 ⇒ **仍是两个独立页签**。
 *     回退时页签跟着一起回去，否则"改一个常量回退"就是假的（会退到一个只剩两个页签、
 *     却仍然单栏渲染的表上）。
 *
 * ⚠️ 2026-10-14「基础数据」整合：原先跟在后面的「店铺登记 / 供应商 / 进价」三个页签
 *    **整体搬进「基础数据」模块**（`src/modules/shop-accounts/MasterDataView.vue` 左导航）——
 *    两类维护动作只有一个家，本页只管"货"本身（建档与认款）。搬运判据见 `./tabs.ts` 头部。
 *    回退形态同样只有这三个：回退的是布局，不是"维护功能散在三个模块"。
 * ⚠️ 页签名一律从 `./tabs` 的 `GOODS_TAB_LABEL` 取，**别在这里写裸字符串** ——
 *    页签名是文案里会被点名的**入口名**，两处各写一遍必然有一天漂开。
 */
const TABS: { id: TabId; label: string }[] =
  GOODS_LAYOUT === 'workbench'
    ? [{ id: 'workbench', label: GOODS_TAB_LABEL.workbench }]
    : [
        { id: 'products', label: GOODS_TAB_LABEL.products },
        ...(SHOP_PRODUCTS_TAB_ENABLED
          ? [{ id: 'shop-products' as TabId, label: GOODS_TAB_LABEL['shop-products'] }]
          : []),
        { id: 'mappings', label: GOODS_TAB_LABEL.mappings },
      ];

/**
 * 页头说明：**随页签走**的一句话。
 * 页签名是导航用的短标签（要短、要能并排），没法承担解释职责；而"切过去以后不知道这页干嘛"
 * 是这一页最常见的一句话反馈。这里用页头那行**本来就有**的说明位补上，不新增任何控件。
 * 写法要求：一句人话 + 什么时候该来这（先有它 / 待办在左边 / 做完的在右边）。
 */
const TAB_DESC: Record<TabId, string> = {
  // 2026-10-25（随页签改名「款与商品」）：说明改成**只描述两侧各是什么**，
  // 不再夹带"建档 / 映射"这类动作词 —— 动作由两侧自己的按钮回答，
  // 说明只负责回答"我为什么来这一页"。同时去掉 SKU 一词（新手第一屏不需要它），
  // 连带 `./glossary` 的导入一起撤掉（它在本文件已无消费者 —— 留着就是"引了但没人用"）。
  // 历史：2026-10-08 R2（UX-G1）曾在这里给"款 / SKU / 映射"三个词各补一句括号，
  //   理由当时成立（首屏唯一说明位）；改名后这三个词里只剩"款"还在，而它已由
  //   左右两侧的列头（款编码 / 商品ID）自解释，再补括号反而是噪音。
  workbench: `左边是你要卖的款，右边是店铺里卖出去、还没认到款上的商品`,
  products: '自己的款和 SKU 在这里建档 —— 先有它，订单 / 采购 / 成本才挂得上这行货。',
  'shop-products': '从订单里认出来的店铺商品，看它们各自认到了哪个款、卖了多少行。',
  mappings: '把店铺商品认到自己的款上。左边是待办队列，右边是已经认完的。',
};

/**
 * 是否画本页自己的页签条。
 *
 * 只有一条页签时（工作台形态），内嵌方可要求把这条交给它画（见 `hideTabs` 的注释）；
 * 页签多于一条时**永远自己画** —— 那时它是唯一的导航，藏掉等于入口消失。
 */
const showTabs = computed(() => !props.hideTabs || TABS.length > 1);

const error = ref('');
// 默认页签跟着形态走：工作台形态下 `'products'` 这个值根本不在 TABS 里（渲染出来会是
// 一个高亮不上的页签 + 走 `v-else` 兜底渲染错组件），必须用两侧都存在的那一个。
const tab = ref<TabId>(GOODS_LAYOUT === 'workbench' ? 'workbench' : 'products');

/**
 * 页级「刷新」按钮的信号（自增 nonce，用法见下方 `refresh()`）。
 */
const refreshNonce = ref(0);

function goTab(id: TabId): void {
  tab.value = id;
}

/**
 * 页头「?」的开关。
 *
 * 状态放在外壳而不是子组件里：面板**横跨**页签（各形态下说的都是同一句"这页怎么用"），
 * 而且它的两个按钮都指向**别的模块**（去「发货台」导订单 / 去「基础数据」登记店铺）——
 * 两件事都只有外壳做得了。
 */
const helpOpen = ref(false);
/** 三步与首次动线引导卡**共用同一份**（`./firstRun`）：同一件事不写两遍，也就不会漂成两种说法 */
const helpSteps = FIRST_RUN_STEPS;

function goImportOrders(): void {
  switchModule('today');
}
/**
 * 「店名归一」的出口：**跨模块跳到「基础数据」的「店名归一」项**（2026-10-14 整合后）。
 *
 * 为什么是跳模块而不是本页页签：登记功能已搬进「基础数据」—— 它和「邮件 / 企业 / 供应商 /
 * 成本与费率」一样是**主数据维护**，全应用的维护动作只应该有一个家（判据见 `./tabs.ts` 头部）。
 * 队列里"店铺未归一"那几行的出口指向那里，TitleBar 的「返回」负责把人送回来（backId 机制）。
 * ⚠️ action 字符串必须与 `MasterDataView` 左导航的 kind id 一致（`shop-accounts:registry`）——
 *    写错不会报错，表现为"跳过去停在上次那个资料项"。
 */
function goRegistry(): void {
  helpOpen.value = false;
  switchModule('shop-accounts', 'registry');
}

/**
 * 「看要拿什么」的出口（2026-10-28 第三步改文案后加的）。
 *
 * 落到**拿货页签**（`switchModule('today', 'purchase')`），不是落在发货台的总览：
 * 这一步的动作是"看要拿什么"，而总览那四个数是"今天要发几单" —— 落在总览上，
 * 用户还得自己再点一次页签（"指路指到半路"，同 `TodayView` 里那次修的坑）。
 */
function goPurchase(): void {
  helpOpen.value = false;
  switchModule('today', 'purchase');
}

/**
 * 页级「刷新」。
 *
 * 外壳自己**不再取任何数**（指标条撤了），所以它只能"戳一下"当前挂着的那个视图：
 * 值一变，左栏（或 `'tabs'` 回退形态的产品列表）就把自己那份数据重拉一遍。
 * 用自增的 nonce 而不是布尔 —— 连点两次也要各生效一次（布尔第二次看不到变化）。
 */
function refresh(): void {
  refreshNonce.value += 1;
}

onMounted(async () => {
  // 建表必须在**任何读取之前**：`productList` 假定 `pl_products` 已存在。
  // 原岛把 ensure 放在各视图的 onMounted（Vue 子先于父），迁到内建后由外壳先 await 一次，
  // 子视图不再各自调（重复调虽然幂等，但会把"谁负责建表"这件事说糊）。
  try {
    await api.ensure();
  } catch (e: unknown) {
    error.value = `初始化失败：${e instanceof Error ? e.message : '未知错误'}`;
  }
});
</script>

<style scoped>
/* 页面外壳（内边距 / 栅格 / 滚动）由全局 .wb-page 提供。 */

/* 内嵌进「基础数据 › 货品档案」（2026-10-17）：外层 `.md-view` 已经给了 16/18 的留白，
   这里不再叠一层。**gap 必须保持 .wb-page 的 16px** —— 下面 `.gd-tabs` 用 -16px 吃掉它，
   改 gap 会让页签与主体之间凭空多出一条缝。 */
.gd-view.is-embedded {
  padding: 0;
}

/* 页签：紧贴主体（`margin-bottom` 的负值把下面那层间隙吃掉）。 */
.gd-tabs {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  margin-bottom: -16px; /* 贴住下方内容，省掉一层间隙 */
  border-bottom: 1px solid var(--wb-border);
}
.gd-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.gd-tab:hover {
  color: var(--wb-text);
}
.gd-tab.is-active {
  color: var(--wb-text);
  font-weight: 600;
  border-bottom-color: var(--wb-primary);
}

/* 页签面板：撑满剩余高度，内部各自滚动 */
.gd-tabpanel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.gd-error {
  margin: 0;
}

/* ---- 页头「?」帮助（R3 · UX-G5）---- */
.gd-help {
  position: relative;
}
/* 面板绝对定位挂在按钮下方：`z-index` 必须高于下面的页签（它们是后面的兄弟节点，
   不给层级的话会盖在面板上）。`.wb-mask` 是 40，所以弹层仍会盖住它 —— 顺序是对的。 */
.gd-help__panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  right: 0;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-2);
}
.gd-help__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gd-help__head .wb-btn {
  margin-left: auto;
}
.gd-help__body {
  padding: 12px 14px 14px;
  font-size: 13px;
  line-height: 1.7;
}
.gd-help__body p {
  margin: 0 0 8px;
}
.gd-help__sub {
  margin-top: 10px !important;
}
.gd-help__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gd-help__steps li {
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.gd-help__no {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 11px;
}
.gd-help__acts {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
