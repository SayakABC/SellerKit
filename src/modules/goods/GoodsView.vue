<template>
  <div class="wb-page gd-view">
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">货与成本</h1>
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
                  打开「店铺登记」
                </button>
              </div>
            </div>
          </div>
        </div>
        <!-- ⭐ 简洁模式开关（2026-10-08 报告 P1-1 / 待拍板 UX-G2）。
             默认**开**：不渲染左栏勾选框 + 批量条、右栏统计条（理由与边界写在 `./simple.ts` 顶部）。
             ⚠️ 只在工作台形态下渲染 —— 回退形态那两个组件的契约是"与重构前逐字一致"，
             给它一个按下去什么都不变的按钮就是本仓最反对的**假动作**（宁可不给）。
             形态名挂在按钮上而不是藏在 title 里：用户要能一眼看出"我现在看到的是精简过的"。 -->
        <button
          v-if="GOODS_LAYOUT === 'workbench'"
          class="wb-btn"
          type="button"
          data-act="simple-toggle"
          :class="{ 'is-on': goodsSimple }"
          :aria-pressed="goodsSimple"
          :title="
            goodsSimple
              ? '当前是简洁模式：已收起勾选框、批量条与统计条 —— 点一下全部显示'
              : '当前是完整模式：点一下收起勾选框、批量条与统计条'
          "
          @click="toggleSimple"
        >
          简洁模式
        </button>
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
         合并为「建档与关联」（`data-act="tab-workbench"`）。页签表按形态分叉，理由见 `TABS` 上方的注释。 -->
    <nav class="gd-tabs" role="tablist" aria-label="货与成本">
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

           `@navigate` 是**页签级导航的回调**（右栏的「现在登记」要用）：外壳转手递给右栏，
           免得右栏为了切到自己这一页的另一个页签去 import 外壳的页签枚举。
           命名刻意不含任何具体页签名 —— 外壳不需要知道有哪几个页签，只知道"能请求导航"。 -->
      <GoodsWorkbenchView
        v-if="GOODS_LAYOUT === 'workbench' && tab === 'workbench'"
        :refresh-nonce="refreshNonce"
        :navigate="goTab"
      />
      <!-- 「店铺登记」：2026-10-08 从市场岛「店铺账号管家」收进内建（方案 R1 / UX-G6）。
           判据不是"少一个岛更省事"，而是：待关联队列里"店铺未归一"的行**必须**先来这里登记才能动，
           而那个岛**不在默认包里** —— 提示指着一个全新安装根本没有的目的地（真机走查 D1 死锁）。
           它只是"原始店名 → 规范店名"的一条旁挂映射，做在需要它的这一页上，比引导人去装一个岛诚实。 -->
      <ShopRegistryView v-else-if="tab === 'registry'" :refresh-nonce="refreshNonce" />
      <SupplierView v-else-if="tab === 'suppliers'" />
      <!-- 「商品清单」页签当前**收起**（见 `SHOP_PRODUCTS_TAB_ENABLED`）：分支与组件保留在这里，
           是为了要放回来时只改那一个常量。`tab` 永远取不到这个值，所以这段是不渲染的死代码 ——
           别当成"多余的 else-if"清掉，那是恢复开关的另一半。 -->
      <ShopProductView v-else-if="tab === 'shop-products'" />
      <!-- 「进价」（P4 成本维护）：款级成本的**唯一手工写入口**。
           放在这一页而不是算钱页：成本是主数据，这一页是主数据的家。
           ⚠️ 2026-10-10 起产品列表**不再有「进价」列**（用户口径：产品列表不展示 SKU 与进价）——
           本页签因此是这个数字唯一的界面入口：切过来就能看「当前生效价」与「还没维护进价的款」
           （后者比列表里一个「—」可操作）。算钱页那边的成本表仍是**只读诊断**。 -->
      <CostPane v-else-if="tab === 'cost'" :refresh-nonce="refreshNonce" />
      <!-- 以下两支是 `GOODS_LAYOUT === 'tabs'` 的**回退路径**（与重构前逐字一致），不是死代码。 -->
      <ProductListView v-else-if="tab === 'products'" :refresh-nonce="refreshNonce" />
      <SkuMappingView v-else :refresh-nonce="refreshNonce" :navigate="goTab" />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「货与成本」外壳：页头 + 三页签（「商品清单」已收起）。
//
// 这一页在 2026-10-01 之前是**薄内建**（只看产品/SKU/克重，重手段在「产品库」UI 岛）。
// 岛与宿主共用同一批数据、同一批 IPC，却因为"岛要单独发布 + 三个版本坐标要同步"而维护成本很高，
// 于是把岛的功能整体收回内建 —— 界面与交互按**单一工作台**重新组织（不再有"这功能在岛里"的心理负担）。
//
// 分工：
//   · 外壳（本文件）只负责**页头、页签、跨页签跳转**；
//   · 各页签自己取自己那份数据，外壳**不再**汇总任何页级数字。
//
// ⚠️ 2026-10-08 撤掉了两层页级 UI（指标条 + 起点引导条）和页签徽标（见模板中间那段注释）。
//    连带把 `stats` / `loadStats` / `flow.ts` / 子视图→外壳的回报链整条移除：它们唯一的消费者
//    就是那两层，留着只会是"每次刷新都多打几次 IPC、却没有任何人看"的页级空转。
import { onMounted, ref } from 'vue';
import * as api from './api';
import ProductListView from './components/ProductListView.vue';
import GoodsWorkbenchView from './components/GoodsWorkbenchView.vue';
import ShopProductView from './components/ShopProductView.vue';
import CostPane from './components/CostPane.vue';
import ShopRegistryView from './components/ShopRegistryView.vue';
import SkuMappingView from './components/SkuMappingView.vue';
import SupplierView from './components/SupplierView.vue';
import { GOODS_TAB_LABEL, GOODS_TAB_REGISTRY, type GoodsTabId } from './tabs';
import { gloss } from './glossary';
import { FIRST_RUN_STEPS } from './firstRun';
import { goodsSimple, setGoodsSimple } from './simple';
import { switchModule } from '@/core/services/shell';

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
 * 页签表（2026-10-08 重构 S4：3 → 2；同日 R1 又新增「店铺登记」）。
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
 * 「店铺登记」**两种形态都有**，且紧跟在建档页签后面：它不是"回退形态才有的东西"，
 * 而是右栏"店铺未归一"那几行的**唯一出口**（写在提示条上、也在行内）—— 摆得离它越远，
 * 那个出口就越像没有。
 *
 * ⚠️ `'workbench'` 那一支里没有「商品清单」：该页签的产出（`pl_shop_sku` 的池行）
 *    没有下游消费方，`SHOP_PRODUCTS_TAB_ENABLED` 的判据见下。
 * ⚠️ 页签名一律从 `./tabs` 的 `GOODS_TAB_LABEL` 取，**别在这里写裸字符串** ——
 *    页签名是文案里会被点名的**入口名**，两处各写一遍必然有一天漂开。
 */
const TABS: { id: TabId; label: string }[] =
  GOODS_LAYOUT === 'workbench'
    ? [
        { id: 'workbench', label: GOODS_TAB_LABEL.workbench },
        { id: 'registry', label: GOODS_TAB_LABEL.registry },
        { id: 'suppliers', label: GOODS_TAB_LABEL.suppliers },
        { id: 'cost', label: GOODS_TAB_LABEL.cost },
      ]
    : [
        { id: 'products', label: GOODS_TAB_LABEL.products },
        ...(SHOP_PRODUCTS_TAB_ENABLED
          ? [{ id: 'shop-products' as TabId, label: GOODS_TAB_LABEL['shop-products'] }]
          : []),
        { id: 'mappings', label: GOODS_TAB_LABEL.mappings },
        { id: 'registry', label: GOODS_TAB_LABEL.registry },
        { id: 'suppliers', label: GOODS_TAB_LABEL.suppliers },
        { id: 'cost', label: GOODS_TAB_LABEL.cost },
      ];

/**
 * 页头说明：**随页签走**的一句话。
 * 页签名是导航用的短标签（要短、要能并排），没法承担解释职责；而"切过去以后不知道这页干嘛"
 * 是这一页最常见的一句话反馈。这里用页头那行**本来就有**的说明位补上，不新增任何控件。
 * 写法要求：一句人话 + 什么时候该来这（先有它 / 待办在左边 / 做完的在右边）。
 */
const TAB_DESC: Record<TabId, string> = {
  // 合并后的说明 = 原「产品」+「映射与关联」两句的**一句话版**：左边建档、右边认货，
  // 并且点出分栏独有的那一步（左栏选一款 → 右栏直接关联过去）。
  // ⭐ 2026-10-08 R2（UX-G1）：这是**首屏唯一那段说明**，所以三个最常出现、也最容易被新手
  //    当成黑话的词（款 / SKU / 映射）在这里各补一句括号 —— 用 `./glossary` 的词表，不另写一遍。
  //    除此之外全页照旧只用术语，不在别处重复解释（每处都写一遍括号反而成了噪音）。
  workbench: `左边给${gloss('style')}和它的${gloss('sku')}建档，右边把店铺商品认到款上 —— 这就是${gloss('mapping')}。左栏选一款，右栏就能直接关联过去。`,
  products: '自己的款和 SKU 在这里建档 —— 先有它，订单 / 采购 / 成本才挂得上这行货。',
  'shop-products': '从订单里认出来的店铺商品，看它们各自认到了哪个款、卖了多少行。',
  mappings: '把店铺商品认到自己的款上。左边是待办队列，右边是已经认完的。',
  // 这句要回答"我什么时候会来这"——答案是"队列里有一行写着「需先登记店铺」的时候"。
  registry: '给订单里出现过的店名指定它是哪家店 —— 队列里写着「需先登记店铺」的商品，先在登记完才能认款。',
  suppliers: '拿货的供应商（厂）主数据 —— 产品建档与采购单据都引它。',
  // 这句要回答"我什么时候会来这"：算钱 / 拣货说"无进价"的时候，就是来这补。
  cost: '给款维护进价 —— 算钱与拣货里写着「无进价」的款，来这里补。改价只影响之后的订单，历史订单按各自下单时生效的价算。',
};

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
 * 状态放在外壳而不是子组件里：面板**横跨**页签（三个页签下说的都是同一句"这页怎么用"），
 * 而且它的两个按钮一个要切页签、一个要跳模块 —— 两件事都只有外壳做得了。
 */
const helpOpen = ref(false);
/** 三步与首次动线引导卡**共用同一份**（`./firstRun`）：同一件事不写两遍，也就不会漂成两种说法 */
const helpSteps = FIRST_RUN_STEPS;

function goImportOrders(): void {
  switchModule('today');
}
function goRegistry(): void {
  helpOpen.value = false;
  goTab(GOODS_TAB_REGISTRY);
}

/**
 * 简洁模式开关。**只有这一个控件**（刻意没在左栏再放一个「批量…」按钮）。
 *
 * 报告原文建议"批量操作收进一个「批量…」按钮里再展开"—— 这里不做，两个理由：
 *   ① 那会是**同一个布尔值的第二个控件**（本仓 2026-10-03 记过的"同一状态两套控件"：
 *      两处各能改、两处各能显，用户永远说不清"我现在到底在哪个模式"）；
 *   ② "点『批量…』其实是关掉简洁模式"本身就是个说不清的按钮 —— 它承诺的是展开一堆批量操作，
 *      实际做的是换一整套形态。按钮上写不清的事，就不该是一个按钮。
 */
function toggleSimple(): void {
  setGoodsSimple(!goodsSimple.value);
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
