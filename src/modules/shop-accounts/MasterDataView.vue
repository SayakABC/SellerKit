<script setup lang="ts">
// src/modules/shop-accounts/MasterDataView.vue
// 「基础数据」主视图（2026-10-14 整合重设计，取代原 ShopAccountsView.vue 的顶部页签形态）。
//
// ── 这一版改的是什么 ──────────────────────────────────────────────────────
// 过去：维护功能散在**三个模块的页签**里 —— 账号库 / 邮件 / 企业 / 店铺登记在「店铺账号管家」，
//   供应商 / 进价 / 店铺登记在「货与成本」，汇率在「算钱」。用户为了"记一家供应商"要先猜
//   "它在哪个模块的第几个页签"；店铺登记甚至有两个家（两边各一份，改一处忘一处）。
// 现在：**一个入口、一个左导航、七类资料**。左边永远看得见"这个店里都维护了什么、各多少、
//   什么还欠着"（徽标 = 待办数），右边就是那一类资料的名单。维护这件事不再需要"找"。
// 2026-10-15：第七类「物流运费」——「无忧物流运费」UI 岛回收为内建资料项
//   （报价单导入 / 运费查询 / 按订单试算 / 按产品试算，见 components/ShippingRatePane.vue）。
// 2026-10-17：同一批两处搬家（用户口径「邮件功能独立出来放一级菜单；货与成本归拢到基础数据中」，
//   见 docs/notes/2026-10-30-goods-ux-refactor.md）：
//   · 「邮件」**搬出去**成一级模块（`src/modules/mail`）：读信不是"维护一份资料"，
//     它有自己的动线（而且未读是每天要看的东西），留在左导航里等于让用户先猜"信属于哪类资料"。
//   · 「货与成本」**搬进来**成第二项「货品档案」（`GoodsView.vue` 以 embedded 形态渲染）：
//     款 / 采集商品 / 映射是**资料本身**，与供应商、店铺登记同类。它的模块外壳
//     （`goods/meta.ts` + `index.ts`）随之撤掉 —— 侧栏不再有第二个"货"入口。
//
// ── 交互设计上的几条纪律 ──────────────────────────────────────────────────
// ① **左导航即仪表盘**：每项右侧的徽标不是装饰 —— 未归一的店名、缺进价的款
//    都是"还欠的事"，欠着时用警示色。老用户靠它决定"今天要不要进基础数据"。
// ② **不写说明文**：本视图没有一句"这个模块是干什么的"—— 左导航七项自解释，
//    每类资料页自己的空态/按钮说话。对不会用电脑的人，说明文字是噪音；
//    对老用户，是每次都要跳过的重复。（各资料页顶部的长说明已一并撤掉。）
// ③ **跨模块跳转有来有回**：别处（如「货与成本」的待关联队列）用 switch-module + action
//    跳到指定资料项，TitleBar 的「返回」负责把人送回去（AppShell 的 backId 机制）。
// ④ **页签状态即左导航当前项**：仍用 store.mainTab（持久化），用户下次进来停在他上次的位置。
//
// ── 2026-10-17 第三次收拢：七项 → 三组（用户口径）─────────────────────────
// 用户口径：「① 店铺登记、企业收拢到店铺账号中；② 成本与费率、供应商收拢到货品档案中」。
// 也就是侧栏二级菜单从**七个并列项**收到**三项**，项内再分资料页面：
//   店铺账号（账号库 / 店铺登记 / 企业）· 货品档案（款与商品 / 成本 / 供应商）
//   · 物流运费（只一项，不画页内页签条）。
//
// ── 2026-10-19 第四次新增：第八类「待补清单」（第四组）──────────────────────
// 前面七项回答"这类资料里有什么"，它回答**"这些资料还欠什么"**，而欠的东西横跨三个域
// （订单没认款/没定色在发货台，款/尺码/克重在产品管理，进价在进价页）。清单本身在
// `components/HealthPane.vue`，判定在 `src/lib/dataHealth.ts`（纯函数 + 单测）。
// ⚠️ 它与 `goods` 同例**不带徽标**（理由见 KINDS 里那条注释：算一次要扫全部订单 + 全部 SKU，
//   而 `loadCounts` 每次进模块都跑）。
// 为什么这样收：这七项不是"同一层级的七件事"，而是**两簇加一个单独**——
//   "这家店 / 这家公司"归店铺，"这款货 / 用哪家厂 / 多少钱拿"归货品；物流运费自成一条动线。
//   七项平铺让侧栏读起来像七件并列的事，用户每次都要在七个名字里找"记一家供应商该点哪个"。
// 判据（与本仓既有纪律同向）：**同一件事只留一个入口**，而"它们属于同一件事"这层信息
//   要么体现在结构上，要么就丢了。收进项内页签 = 结构上表达出来，且不新增一层导航。
// ⚠️ kind id **一个都没改**：`store.mainTab` 的七个值仍是七类资料（含持久化偏好与跨模块
//   action 的字符串协议）。侧栏点的是**组**，页内页签点的才是 kind —— 两层各有锚点、
//   **各有各的入口函数**（selectGroup / selectKind，见两者上面的注释）：
//   侧栏 `kind-<groupId>`（AppShell 生成）、页内 `kind-tab-<kindId>`。两组锚点不重名。
// ⚠️⚠️ 组 id 与 kind id 有**两个字面量撞车**（组 accounts ⇄ kind accounts、组 goods ⇄ kind
//   goods）。所以"一个函数两种 id 都认"是错的：页签点 kind 'accounts' 会被组解释吞掉
//   （命中"已在这组"早退 = 点什么都没反应，2026-10-17 当晚实测）。入口按来源分函数。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useShopAccountsStore, type ShopAccountsMainTab } from './store';
import IconGlyph from '@/core/components/IconGlyph.vue';
import type { IconName } from '@/core/components/icons';
import AccountsPanel from './components/AccountsPanel.vue';
import ShopRegistryView from './components/ShopRegistryView.vue';
import ToolsPanel from './components/ToolsPanel.vue';
import ColorPanel from './components/ColorPanel.vue';
import CompanyManageView from './components/CompanyManageView.vue';
import SupplierView from './components/SupplierView.vue';
import ShippingRatePane from './components/ShippingRatePane.vue';
import HealthPane from './components/HealthPane.vue';
import AccountEditor from './components/AccountEditor.vue';
import BatchEditDrawer from './components/BatchEditDrawer.vue';
import GoodsView from '@/modules/goods/GoodsView.vue';
import { GOODS_TAB_LABEL } from '@/modules/goods/tabs';
import MailAccessDrawer from './components/MailAccessDrawer.vue';
import { useMailStore } from '@/modules/mail/mailStore';
import { companySummary, productList } from '@/core/services/ipc';
import { unwrapApi } from '@/modules/goods/unwrapApi';
import * as shopApi from '@/modules/goods/shopApi';
import { supplierList } from '@/modules/goods/api';
import { reportSubNav } from '@/core/services/subNav';

const store = useShopAccountsStore();
const mail = useMailStore();

/** 资料页面（组内的一项，也是 `store.mainTab` 的取值与跨模块 action 的字符串） */
interface KindDef {
  id: ShopAccountsMainTab;
  name: string;
  icon: IconName;
  /** 徽标的含义（tooltip 用）；undefined = 不显示徽标 */
  countTitle?: (n: number) => string;
  /** 徽标为"待办"性质：>0 时用警示色 */
  todo?: boolean;
}

/**
 * 八类资料（**唯一清单**：内容分支、页内页签、跨模块 action 校验都吃它）。
 *
 * ⚠️ 2026-10-19：第八类 `health`（待补清单）加入，侧栏因此从三组变四组。
 *    它是**唯一不属于"某类资料"的一项** —— 它看的是所有资料的完整性（见下面 KINDS 里的注释）。
 *
 * ⚠️ 2026-10-17 收拢成三组后，其中两项的名字**不再是进这一项时的读法**：
 *   · `accounts` → 「账号库」：它现在挂在「店铺账号」这一组里，组名已经回答了"这是哪一类"，
 *     页签名再叫「店铺账号」就是「店铺账号 › 店铺账号」；
 *   · `goods` → 「款与商品」：同页页签名，取 `GOODS_TAB_LABEL.workbench`（与「货品档案」里
 *     那条页签同一个字符串来源，别在这里写裸字面量）。
 * ⚠️ 2026-10-17 晚间二次调整：`cost` 的页签名「成本与费率」→「成本」（用户口径"修改为成本"）。
 *    同日三次调整：「成本」→「进价」（用户口径"成本修改为进价"）。
 *    改名只动**呈现层**：`store.mainTab` 的值与跨模块 action 的字符串协议都没变（老用户偏好、
 *     算钱页的「去维护」全部照旧）。用户可见文案里再写「成本与费率」或「成本」= 悬空入口名
 *    （uxEntryNames 会红）。
 * `store.mainTab` 的值一个都没变 ⇒ 用户本地偏好、跨模块 action 全部照旧可用。
 */
const KINDS: KindDef[] = [
  // 2026-10-22 物理合并：一行 = 一家店（含账号），「账号库」改名「店铺」；
  // 它的"还欠什么"已由行内「未建店铺 / 待补账号」两个角标回答，侧栏不再另算。
  { id: 'accounts', name: '店铺', icon: 'key', countTitle: (n) => `${n} 家店` },
  // 2026-10-17 新增（原「货与成本」模块）。**刻意不给徽标**：它的"还欠什么"就是
  // 「待关联采集商品」那个队列表格（右栏分段 + 状态条），侧栏再算一遍等于同一个数
  // 摆两个地方（同 2026-10-08 撤掉指标条的理由）。要加就先问"这个数在右栏是不是已经有了"。
  { id: 'goods', name: GOODS_TAB_LABEL.workbench, icon: 'box' },
  // 2026-10-30 新增：颜色板与合并（`ColorPanel.vue`）。同一个颜色在款色 / SKU 里以
  // `黑` / `黑色` 两种写法各占一行，本页是唯一能把它们归一的地方（拖一行到另一行）。
  // **刻意不给徽标**：色名总量是低频变化的，不是待办（同 `goods` / `tools` 的判据）。
  { id: 'colors', name: '颜色', icon: 'palette' },
  // 2026-10-22：「店铺登记」改名「店名归一」—— 它只负责认历史文本里的名字，
  // 实体增改在「店铺」页签（合并编辑器）。
  { id: 'registry', name: '店名归一', icon: 'table', countTitle: (n) => `${n} 个店名待认领`, todo: true },
  { id: 'companies', name: '企业', icon: 'shield', countTitle: (n) => `${n} 家企业` },
  // 2026-10-22 新增：紫鸟 / ERP 登录名 + 密码库（一套工具管多家店，避免每家店重复录入）。
  // **刻意不给徽标**：它不是"待办"，是低频维护的资料库（同 `goods` 的判据）。
  { id: 'tools', name: '工具账号', icon: 'wrench' },
  { id: 'suppliers', name: '供应商', icon: 'factory', countTitle: (n) => `${n} 家供应商` },
  { id: 'shipping', name: '物流运费', icon: 'truck' },
  // 2026-10-19 新增第八类资料：「待补清单」。
  //
  // 为什么它算"一类资料"：前面七项回答"这一类资料里有什么"，它回答**"这些资料还欠什么"** ——
  //   而欠的那些东西**横跨三个域**（订单没认款/没定色在发货台，款/尺码/克重在产品管理，
  //   进价在进价页）。用户要回答"现在最该补哪一样"得跑三页数三遍，这正是"同一件事只留一个入口"
  //   被违反的地方（散着的是问题，不是入口）。
  //
  // ⚠️ **刻意不给徽标**（与上面 `goods` 同例，也不同于 `cost` 那几项）：算这个数要把
  //   全部订单投影 + 全部 SKU 拉一遍（`order-shipping-rows` 单次上限 2000 行、变体按批取），
  //   而 `loadCounts` 会在**每次进本模块**时跑 —— 为一个"专门点进去才看"的页面付这份取数成本
  //   不划算。页内自己报"还欠几类"，需要时点进去看一眼即可。
  { id: 'health', name: '待补清单', icon: 'alert' },
];

/** 侧栏二级菜单的分组 id（**不是** kind id —— 两套锚点各走各的） */
type MasterGroupId = 'accounts' | 'goods' | 'shipping' | 'health';

interface GroupDef {
  id: MasterGroupId;
  name: string;
  icon: IconName;
  /** 组内资料页面（顺序 = 页签顺序 = 维护频率） */
  kinds: ShopAccountsMainTab[];
}

/**
 * 侧栏的三项（2026-10-17 收拢；用户口径见文件头）。
 *
 * 判据是"同一件事"：店铺类（账号 / 登记 / 企业）· 货品类（款与 SKU / 成本 / 供应商）·
 * 物流运费（自成一条动线，没有同类可并）。
 * ⚠️ 组的 `kinds` 必须覆盖 `KINDS`（单测钉：两边一旦漂开，某个资料页就没有入口了）。
 * 顺序 = 维护频率：先"天天要看的那份"，再"按需维护的那份"。
 */
const GROUPS: GroupDef[] = [
  // 2026-10-22：组内加 `tools`（工具账号库）。顺序 = 维护频率：店铺天天看，
  // 店名归一 / 企业 / 工具账号按需维护。
  { id: 'accounts', name: '店铺账号', icon: 'key', kinds: ['accounts', 'registry', 'companies', 'tools'] },
  { id: 'goods', name: '产品管理', icon: 'box', kinds: ['goods', 'colors', 'suppliers'] },
  { id: 'shipping', name: '物流运费', icon: 'truck', kinds: ['shipping'] },
  // 2026-10-19：第四组「待补清单」—— 只有一项，故不画组内页签条（同物流运费）。
  // 独立成组而不是塞进「产品管理」：它的六类检查里有两类在**订单侧**（没认款 / 颜色未分类），
  // 塞进产品组会让"点产品管理却掉进订单的待办"—— 组名就成了假的。
  { id: 'health', name: '待补清单', icon: 'alert', kinds: ['health'] },
];

/** kind id → 定义（未知 id 兜底第一项，只为类型收窄；调用方都先校验过） */
function kindDef(id: ShopAccountsMainTab): KindDef {
  return KINDS.find((k) => k.id === id) ?? KINDS[0];
}

/** kind id → 它属于哪一组（侧栏高亮问的就是这个） */
function groupOfKind(id: ShopAccountsMainTab): GroupDef {
  return GROUPS.find((g) => g.kinds.includes(id)) ?? GROUPS[0];
}

const kind = computed(() => store.mainTab);
/** 当前组 */
const currentGroup = computed(() => groupOfKind(kind.value));
/** 当前组里要画的资料页面（>1 才画页内页签条；物流运费只有一项，画了就是一条没用的条） */
const groupKinds = computed<KindDef[]>(() => currentGroup.value.kinds.map(kindDef));

/** 各资料项的徽标数（undefined = 读不到数，不显示徽标 —— 不拿 0 冒充"没有"） */
const counts = ref<Partial<Record<ShopAccountsMainTab, number>>>({});

/** 账号库的数来自 store（已在内存），其余几类现取 */
async function loadCounts(): Promise<void> {
  const next: Partial<Record<ShopAccountsMainTab, number>> = {
    accounts: store.summary.total,
  };
  // 店铺登记：还没归一的店名数（订单 / 采购两处历史文本实时汇总）
  try {
    const sum = await shopApi.summary();
    next.registry = sum?.names?.unmapped ?? 0;
  } catch {
    /* 读不到就不显示徽标，不用 0 冒充 */
  }
  // 企业
  try {
    const r = await companySummary();
    if (r.success && r.data) next.companies = Number(r.data.total) || 0;
  } catch {
    /* 同上 */
  }
  // 供应商
  try {
    const list = await supplierList();
    if (Array.isArray(list)) next.suppliers = list.length;
  } catch {
    /* 同上 */
  }
  counts.value = next;
}

/**
 * 侧栏点的是**组** id（`accounts` / `goods` / `shipping`）。
 *
 * 已在这一组里时**保持当前页**：用户点「货品档案」只是想确认"我在这组"，
 * 不该把他弹回第一页。认不出就原样不动（侧栏传什么都不能把页面切成空白）。
 */
function selectGroup(id: string): void {
  const group = GROUPS.find((g) => g.id === id);
  if (!group) return;
  if (group.kinds.includes(store.mainTab)) return; // 已在这组：点组名不等于"回到第一页"
  store.mainTab = group.kinds[0];
  void loadCounts(); // 徽标跟着现状走
}

/**
 * 组内页签点的是**kind** id（`accounts` / `registry` / `cost` …）。**只认 kind**。
 *
 * ⚠️ 2026-10-17 收拢当晚的 bug：组 id 与 kind id 有**两个字面量撞车** ——
 *    组 `accounts` ⇄ kind `accounts`、组 `goods` ⇄ kind `goods`。旧实现一个函数
 *    先查组表再接 kind 表，于是在「店铺账号」组里点「账号库」页签被解释成"点组名"，
 *    命中"已在这组"的早退 ⇒ **点什么都没反应**（货品档案组的「款与商品」同样）。
 *    两个入口各有各的 id 语义，**不许互相解释**（同"点名参数要 pin 住"：
 *    页签传进来的一定是 kind，按组解一遍就是把用户的点击吞掉）。
 */
function selectKind(id: string): void {
  if (!KINDS.some((k) => k.id === id)) return; // 认不出就原样不动
  store.mainTab = id as ShopAccountsMainTab;
  void loadCounts(); // 徽标跟着现状走（刚登记完一家店，未归一的数要立刻变）
}

/** 徽标文案（title 属性用） */
function countTitle(def: KindDef, n: number): string {
  return def.countTitle ? def.countTitle(n) : '';
}

/**
 * 侧栏那一项的徽标（2026-10-17 收拢后**只在组上画一个**）。
 *
 * 三条规矩，都是从前几轮踩出来的：
 *   ① **待办优先**：组里任何一项有"还欠着"的数（未归一店名 / 缺进价），组上就用待办色 —
 *      收拢之后那些数只剩页内页签一条去处，侧栏不再体现就等于**把仪表盘藏起来了**；
 *   ② 没有待办时才显示"这类有多少"（只对店铺账号做：它是用户最常数的那个数）；
 *   ③ 读不到数（undefined）就**不画**，不拿 0 冒充"没有"。
 * ⚠️ 别把组内各项的数**加起来**：账号套数 + 待登记店名 + 企业数相加没有任何含义。
 */
function groupBadge(g: GroupDef): { count?: number; countTitle?: string; todo?: boolean } {
  if (g.id === 'accounts') {
    const pending = counts.value.registry;
    if (pending) return { count: pending, countTitle: `${pending} 个店名待登记`, todo: true };
    const total = counts.value.accounts;
    return total === undefined
      ? {}
      : { count: total, countTitle: `${total} 套店铺账号` };
  }
  return {};
}

/**
 * 跨模块跳转（switch-module + action）的落地。
 *
 * 两条路径都要覆盖：
 *   · 模块**不在场** → AppShell 把 action 存进 `window.__switchModuleAction`，本视图 onMounted 消费；
 *   · 模块**已在场** → AppShell 的 activateCore 会早退（同模块不重复激活），marker 不会有人消费，
 *     所以要监听 window 事件自己接。漏任一条 = "点了『现在登记』没反应"。
 *   · 2026-10-17：原来还有一个 `shop-accounts:goto`（同一模块内切资料项）。它的唯一发送方是
 *     收件箱空态，而邮件已搬出去、改成真跳模块 ⇒ 该事件没有发送方了，一并删掉
 *     （留着一个没人发的监听，下一个人会以为还有人在用）。
 * 消费后**必须清掉 marker**：否则用户下次从侧栏进本模块，会被一个过期的 action 弹到别的资料项。
 */
function applySwitchAction(detail: { moduleId?: string; action?: string } | undefined): void {
  if (!detail || detail.moduleId !== 'shop-accounts' || !detail.action) return;
  (window as unknown as { __switchModuleAction?: unknown }).__switchModuleAction = null;
  // action 既可能是 kind id 也可能是组 id（跨模块字符串协议，两种都有发送方）。
  // **先按 kind 解**：'accounts' / 'goods' 两种解释落到同一页（组 → 第一页恰好就是它），
  // 其余 action（registry / cost / suppliers …）只有 kind 一种解释 ⇒ 解析顺序不影响结果。
  // 但**不能**再走"一个函数先查组表"的老路：页签点 kind 'accounts' 会被组解释吞掉（见 selectKind）。
  const action = detail.action;
  if (KINDS.some((k) => k.id === action)) selectKind(action);
  else selectGroup(action);
}

function onSwitchModule(e: Event): void {
  applySwitchAction((e as CustomEvent<{ moduleId?: string; action?: string }>).detail);
}

onMounted(async () => {
  // 2026-10-17：七项资料从**页面内左导航**搬到**主侧栏的二级菜单**（省下 212px 内容宽度，
  // 见 docs/notes/2026-10-30-ui-nav-and-tabs.md）。这里把菜单报给外壳，越早越好：
  // 跨模块跳转（如发货台「去「货品档案」补 SKU 克重」）落地时，用户第一眼就该看见
  // 侧栏已经在「货品档案」上 —— 晚一步上报会先闪一行孤零零的「基础数据」。
  // `items` / `activeId` 是 getter 而不是快照：徽标数（未归一店名、缺进价）随 `loadCounts`
  // 变化，当前项随 `store.mainTab` 变化，外壳每次重算都会拿到最新值。
  reportSubNav('shop-accounts', {
    // 2026-10-17 收拢后侧栏只剩**三项**（组），组内资料页由下面的页签条承担。
    // 徽标与当前项仍是 getter（见文件头约束 2）：数一变、当前项一变，侧栏下次重算就拿到最新值。
    items: () =>
      GROUPS.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        ...groupBadge(g),
      })),
    // 高亮的是**组**（用户停在哪一组的哪一页，侧栏只知道组；页内页签自己知道具体是哪一页）
    activeId: () => currentGroup.value.id,
    // 模块自己校验 id（`selectGroup` 里那条 GROUPS.find）—— 侧栏传什么都不能把页面切成空白
    onSelect: (id) => selectGroup(id),
    // 2026-10-17 下午：原「设置」这一行**去掉**（用户口径「二级菜单中的设置去掉」）。
    // 它不是第八类资料，混在资料项里既容易被读成"又一个页面"，也让收起态的阅读更杂。
    // 安全设置仍在宿主设置中心：侧栏底部齿轮 →「基础数据」分类（`shop-accounts:settings`）。
  });

  window.addEventListener('switch-module', onSwitchModule as EventListener);
  // 落地跳转意图（在数据初始化之前，免得用户先看到一堆空表再被弹走）
  applySwitchAction(
    (window as unknown as { __switchModuleAction?: { moduleId?: string; action?: string } })
      .__switchModuleAction
  );

  // 账号行上要显示「已接入 / 未接入」——`AccountsPanel` 读的是邮件 store 的账号清单。
  // 冷启动直接落在本模块时「邮件」页从没打开过，没人初始化它 ⇒ 每行都报「未接入」、
  // 接入抽屉也是空表单（2026-10-25 修：此前注释以为 MailAccessDrawer 负责，实际它也没做）。
  void mail.ensureAccountState();
  if (!store.initialized) {
    await store.init();
  } else {
    // 再次进入模块时刷新列表与汇总（保留筛选条件）
    await store.reload();
  }
  void loadCounts();
});

onBeforeUnmount(() => {
  window.removeEventListener('switch-module', onSwitchModule as EventListener);
  store.clearAllReveals();
});
</script>

<template>
  <div class="md-view">
    <div v-if="!store.secureStorage" class="banner">
      <IconGlyph name="alert" :size="14" />
      <span>系统安全存储不可用，密码将以降级方式保存，建议仅在受信任设备上使用。</span>
    </div>

    <!--
      ⚠️ 2026-10-17：这里原来是一个 `.md-body` 两栏容器（200px 左导航 + 内容区）。
      左导航已搬到**主侧栏的二级菜单**（`AppShell.vue` 的 `kind: 'sub'` 行），菜单内容由本视图
      的 `reportSubNav` 上报。搬家的理由只有一个数字：那 200px 是**从内容区里扣的**，
      加栏间距共 212px，让默认 1200 窗口的右内容只剩 744px —— 而「货品档案」的两栏工作台
      下限之和是 836px（上一轮因此被迫把断点抬到 1280、默认窗口变成堆叠）。
      侧栏那 208px 是已经付过的宽度，七个面挪进去等于免费。
      本视图从此**只剩内容区**（`.md-body` 这层空壳一并删掉，少一层嵌套）：
      七项的名字 / 徽标 / 当前项都在 `onMounted` 的那条上报里。
    -->
    <!--
      组内页签条（2026-10-17 收拢）：侧栏三项各自可能装着几个资料页。
      只有一项时不画（物流运费）—— 一条只有一个格子的页签条既是噪音，也让人以为还有别的页。
      ⚠️ 锚点名是 `kind-tab-<kindId>`，与侧栏的 `kind-<groupId>` 刻意不同：
        两个 `kind-accounts`（组 + 页）会让 querySelector 抓到错的那个，冒烟会静默失配。
      ⚠️ 徽标照旧挂在页签上（账号套数 / 待登记 / 缺进价 / 企业数 / 供应商数）：收拢之后
        这些数只剩这一条去处；侧栏只在"组里有待办"时汇总报一个（见 `groupBadge`）。
    -->
    <nav
      v-if="groupKinds.length > 1"
      class="md-tabs"
      role="tablist"
      :aria-label="currentGroup.name"
    >
      <button
        v-for="k in groupKinds"
        :key="k.id"
        type="button"
        role="tab"
        class="md-tab"
        :class="{ 'is-active': kind === k.id }"
        :aria-selected="kind === k.id"
        :aria-current="kind === k.id ? 'page' : undefined"
        :data-act="`kind-tab-${k.id}`"
        @click="selectKind(k.id)"
      >
        <IconGlyph :name="k.icon" :size="14" />
        <span>{{ k.name }}</span>
        <span
          v-if="counts[k.id] !== undefined"
          class="md-tab__count"
          :class="{ 'is-todo': k.todo && (counts[k.id] ?? 0) > 0 }"
          :title="countTitle(k, counts[k.id]!)"
          >{{ counts[k.id] }}</span
        >
      </button>
    </nav>

    <section class="md-content">
      <AccountsPanel v-if="kind === 'accounts'" />
      <!-- 2026-10-17：原「货与成本」整页搬到这里（embedded ⇒ 它自己的 h1 标题不渲染，
           页头由侧栏子项承担；页签、工具栏、帮助、简洁模式全部原样）。
           同日收拢：它自己的页签条交给外层（`hide-tabs`）—— 它只有一项页签，
           和「成本」「供应商」并成一条才不会出现两条并排的页签条。 -->
      <GoodsView v-else-if="kind === 'goods'" embedded hide-tabs />
      <!-- 2026-10-30：颜色板与合并（同色异名归一的唯一入口；拖一行到另一行）。 -->
      <ColorPanel v-else-if="kind === 'colors'" />
      <ShopRegistryView v-else-if="kind === 'registry'" />
      <CompanyManageView v-else-if="kind === 'companies'" />
      <!-- 2026-10-22：紫鸟 / ERP 登录名库（物理合并新增；原先这些字段每家店重复录入）。 -->
      <ToolsPanel v-else-if="kind === 'tools'" />
      <SupplierView v-else-if="kind === 'suppliers'" />
      <ShippingRatePane v-else-if="kind === 'shipping'" />
      <!-- 2026-10-19：第八类「待补清单」。判定在 `src/lib/dataHealth.ts`（纯函数、有单测），
           本页只取数 + 渲染 + 跳转（理由见 pane 头注释）。 -->
      <HealthPane v-else-if="kind === 'health'" />
    </section>

    <!-- 三个覆盖层：与资料项无关（账号编辑器 / 批量修改 / 邮箱接入），故挂视图级。
         挂内容区里会被资料切换冲掉（v-if 换组件即卸载）。 -->
    <AccountEditor v-if="store.editorOpen" />
    <BatchEditDrawer v-if="store.batchEditOpen" />
    <MailAccessDrawer />
  </div>
</template>

<style scoped>
.md-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px 18px;
  overflow: hidden;
  color: var(--wb-text);
}

/* 安全降级提示 */
.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border: 1px solid var(--wb-warning);
  border-radius: var(--wb-radius);
  background: var(--wb-warning-soft);
  color: var(--wb-text);
  font-size: 12.5px;
}

/*
  左导航（`.md-body` 两栏 + 七项 + 设置）2026-10-17 整块搬到主侧栏，样式一并删除 ——
  留在这里的 `.md-nav__count` 之类不会有人用，下一个读代码的人会以为页面里还有一条导航。
  徽标的视觉在新家：`AppShell.vue` 模板里的 `kind: 'sub'` 分支（同样的三档配色：
  普通 / 待办警示 / 激活态反白）。
*/

/* ── 组内页签条（2026-10-17 收拢后新增）────────────────────────────────────
   视觉照搬「货品档案」原来那条页签（.gd-tabs / .gd-tab）：它是同一个模块里的
   同一种控件，两处画成两个样子会让人以为"这是另一种导航"。
   `margin-bottom: -12px` 吃掉 .md-view 的 gap，让页签贴住内容区（同 .gd-tabs 的手法）。 */
.md-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin-bottom: -12px;
  border-bottom: 1px solid var(--wb-border);
}
.md-tab {
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
.md-tab:hover {
  color: var(--wb-text);
}
.md-tab.is-active {
  color: var(--wb-text);
  font-weight: 600;
  border-bottom-color: var(--wb-primary);
}
/* 页签徽标：普通 = 该类有多少；is-todo（>0）= 还欠着（未归一店名 / 缺进价） */
.md-tab__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  text-align: center;
}
.md-tab__count.is-todo {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

/* ── 右内容区 ─────────────────────────────────────────────────────────── */
.md-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
</style>
