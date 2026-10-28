<template>
  <div class="wb-page td-import">
    <!-- ── 投放区（本页的主入口）───────────────────────────────────────────────
         两个动作合成一个视觉块，用户不用先想"我该点哪"：
           · 点**整块**（不限于那个按钮）→ 拉起选文件对话框；
           · 把文件**拖到块里**（松手即导入）—— 导 Excel 最常见的动作就是"从资源管理器拖过来"。
         ⚠️ 点击 handler **只挂在区块上，按钮自己不挂**：按钮的 click 会冒泡上来触发它。
            两个 handler 并存时一次点击会导入两次，而导入**不是幂等**的（同一份订单报表导两遍
            = 订单行翻倍），所以从结构上只留一条路径，而不是靠"记得写 stopPropagation"。
         ⚠️ `data-act="import"` 仍在**按钮**上：既有断言点它，也靠它的 `disabled` 判"导入中"。
         ⚠️ 拖拽的 enter/leave 在子元素之间会反复触发 ⇒ 用计数器判定，"进出子元素"不算离开，
            否则指针划过图标/按钮时高亮会闪。 -->
    <div
      class="ti-drop"
      :class="{ 'is-over': isOver, 'is-busy': importing }"
      data-act="import-drop"
      @click="pick"
      @dragenter.prevent="onEnter"
      @dragover.prevent
      @dragleave.prevent="onLeave"
      @drop.prevent="onDrop"
    >
      <span class="ti-drop__ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M12 16V4" stroke-linecap="round" />
          <path d="m7 9 5-5 5 5" stroke-linecap="round" stroke-linejoin="round" />
          <path
            d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>

      <!-- ⚠️ 这里**只有标题一行文字**（2026-10-11 二次收口）：原先还有一行副标题
           （"点这块任意位置选文件，也可以直接把文件拖进来"）—— 它说的两件事，界面自己已经说完了：
           按钮 = 点击入口，虚线框 + 上传图标 = 可投放。**能靠形状说清的就不要再写一句。** -->
      <p class="ti-drop__title">{{ dropTitle }}</p>

      <button
        class="wb-btn wb-btn--primary ti-drop__btn"
        type="button"
        data-act="import"
        :disabled="importing"
      >
        <span v-if="importing" class="ti-spin" aria-hidden="true"></span>
        {{ importing ? '导入中…' : '选择 Excel 文件' }}
      </button>

      <!-- 能识别的四类：**不是说明文字而是能力清单** —— 用户得先知道"我手上这份算不算数"。
           原先它埋在空态那句长括号里（"（订单报表 / 待发货订单 / 结算明细 / 报价单）"），扫不动。 -->
      <ul class="ti-drop__types" aria-label="能自动识别的文件类型">
        <li v-for="t in TYPES" :key="t">{{ t }}</li>
      </ul>
    </div>

    <!-- 上次导入的回执 = **结论卡**（2026-10-11 重做）。
         用户实报「导完记录不知道去哪了、反馈信息模糊、文字太多、完全看不懂」—— 病根是这一张卡
         把**结论 / 落点 / 按钮 / 判据**四样东西用同一档字号平铺，而最长的那段判据（识别凭什么、
         拆了几行、主图成没成）排在中间：用户得整段读完才知道结果，甚至读完了也只知道"发生了什么"
         而不知道"我接下来点哪"。
         现在的层次（自上而下 = 用户关心的顺序）：
           ① 标题 —— 这是什么文件（含子类，如"芒果店长待发货订单"）
           ② `headline` —— **大字结论**："已导入 12 行订单"
           ③ `landed`  —— 一句小字回答"存哪了、去哪能看到"
           ④ `warnings` —— **只有真出事才出现**（跳过几行 / 主图没下来），平铺、不折叠
           ⑤ 下一步按钮（最多两个，主操作只有一个）
           ⑥ `message`  —— 判据，**折叠**在「怎么看出来的」里（出问题才展开）
         ⚠️ `data-act` 名沿用（`import-result` / `import-title` / `import-landed` / `import-next` /
            `import-next-<key>` / `import-detail` / `import-dismiss`）：既有断言原样重挂。
           新增的是 `import-headline` / `import-warn`（判据挂在可折叠的 `<details>` 上）。
         ⚠️ `import-detail` 现在在 `<details>` **里面**：`textContent` 仍然读得到（折叠 ≠ 移除），
            所以"判据里写了什么"那几条断言不受影响；**另加一条**断言它默认是收起的、点开能展开
            （否则"折叠"只写在样式上，用户根本看不到展开的办法）。 -->
    <div
      v-if="receipt"
      class="td-receipt"
      :class="{ 'td-receipt--nowrite': !receipt.wrote }"
      data-act="import-result"
    >
      <div class="td-receipt__head">
        <span
          class="td-receipt__badge"
          :class="receipt.wrote ? 'is-ok' : 'is-warn'"
          >{{ receipt.wrote ? '已导入' : '未写入' }}</span
        >
        <span class="td-receipt__title" data-act="import-title">{{ receipt.title }}</span>
        <button
          class="wb-btn wb-btn--sm wb-btn--ghost td-receipt__close"
          type="button"
          data-act="import-dismiss"
          title="关掉这条回执"
          aria-label="关掉这条回执"
          @click="dismiss"
        >
          ×
        </button>
      </div>

      <!-- ② 大字结论：用户扫一眼就该知道"这次成了没有、成了多少" -->
      <p class="td-receipt__headline" data-act="import-headline">{{ receipt.headline }}</p>

      <!-- ③ 落点：回答"数据去哪了"。① 只给**人话名**（订单 / 结算明细 / 运价表），
             ② 列出去哪能看到它；③ 不写库时（`landed === null`）整句不出现。 -->
      <p v-if="receipt.landed" class="td-receipt__landed" data-act="import-landed">
        存到「{{ receipt.landed.label }}」—— 在 {{ receipt.landed.views.join('、') }} 能看到
      </p>

      <!-- ④ 异常行：**只有真的出事才出现**（`warnings` 为空时这一块整块不渲染）。
             它跟下面的"判据"不同：这些是用户**要采取行动**的事（回去补报表 / 知道这几行没图），
             所以平铺、不上折叠。 -->
      <ul v-if="receipt.warnings.length" class="td-receipt__warn" data-act="import-warn">
        <li v-for="w in receipt.warnings" :key="w">{{ w }}</li>
      </ul>

      <!-- ⑤ 下一步：主操作最多一个（primary） -->
      <div v-if="receipt.next.length" class="td-receipt__next" data-act="import-next">
        <span class="td-receipt__nextlabel">下一步</span>
        <button
          v-for="a in receipt.next"
          :key="a.tab || a.moduleId || a.label"
          class="wb-btn"
          :class="{ 'wb-btn--primary': a.primary }"
          type="button"
          :data-act="`import-next-${a.tab || a.action || a.moduleId}`"
          @click="nextGo(a)"
        >
          {{ a.label }}
        </button>
      </div>

      <!-- ⑥ 判据（识别凭什么、拆了几行、主图成没成…）—— **默认折叠**。
             原先它平铺在卡片中间，是"文字太多、看不懂"的主要来源；现在出问题时才展开。 -->
      <details class="td-receipt__more">
        <summary data-act="import-detail-toggle">怎么看出来的</summary>
        <p class="td-receipt__detail" data-act="import-detail">{{ receipt.message }}</p>
      </details>
    </div>

    <!-- ── 今天导入的订单（2026-10-22 新增）─────────────────────────────────────
         用户实报：「导入后显示"已导入 16 行订单"，但不知道订单在哪」。
         病根不是"没给入口"—— 回执里那句「存到「订单」—— 在 XX 能看到」指的是**页面名**，
         用户听完还是得自己去找；而"16 行"是个**数字**，没有任何一处列出这 16 行长什么样。
         结论：第 1 步的产物必须**当场可见**。这张表就是那 16 行本身。
         ⚠️ 数据源与容器 `reload()` **同参同口径**（`orderShippingRows` + 导入日 = 今天）——
            绝不能用另一种筛法，否则"上面说 16 行、下面列 15 行"立刻又是一个缝。
            `importDate` 是**导入日**（`created_at`），不是下单日：早上下单、下午导的也算今天这批。
         ⚠️ 列表放**回执之后**：导入后第一眼是结论卡（成了没有），第二眼才是明细。
            放回执前面会把"这次成没成"挤到屏幕外。
         ⚠️ 不做金额合计：`amountCents` 是**整单**金额（`oi_orders`），一单拆多行时每行都会
            重复同一个数，加总等于把订单额翻倍 —— 表头已用 title 写明这一点。 -->
    <section ref="rowsEl" class="wb-panel ti-rows" data-act="import-rows">
      <!-- 表头**就是**原来那条"今天导入 N 行订单"现状条（2026-10-22 合并）。
           为什么合并：两个块上下相邻、说的是同一件事（今天这批有几行），而那个数字下面
           紧跟着的正是**这些行本身** —— 分开摆会让"16 行"和"16 行长什么样"之间隔着一张回执卡，
           用户报的"不知道订单在哪"就是这么来的。
           ⚠️ 计数只保留**一处**（`rows.length`，列表自己取的那一份），不再并列容器的
              `summary.orders.total` —— 两个数并排时，任何一次刷新时差都会被读成"数字不对"。
              页签徽标仍读容器那份（它与列表不同屏，且同一 IPC 参数）。
           ⚠️ `data-act="import-stock"` 挂在表头上：这个数据块并没有消失，只是换了位置和形状。 -->
      <div class="wb-panel__head ti-rows__head" data-act="import-stock">
        <span>今天导入的订单</span>
        <span class="ti-rows__count" data-act="import-rows-count">
          <template v-if="keyword">匹配 {{ filtered.length }} / 共 {{ rows.length }} 行</template>
          <template v-else>共 {{ rows.length }} 行</template>
        </span>
        <span class="ti-rows__kv">报表 <b>{{ importedCount }}</b> · 采集 <b>{{ collectCount }}</b></span>
        <span v-if="lastTime" class="ti-rows__kv">最近下单 <b>{{ lastTime }}</b></span>
        <input
          v-model="q"
          class="wb-input wb-input--sm ti-rows__search"
          data-act="import-rows-search"
          placeholder="搜订单号 / 店铺 / 款号 / 颜色"
        />
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          data-act="import-rows-refresh"
          :disabled="rowsLoading"
          @click="loadRows"
        >
          {{ rowsLoading ? '读取中…' : '刷新' }}
        </button>
      </div>

      <p v-if="rowsError" class="wb-notice wb-notice--error ti-rows__err" data-act="import-rows-error">
        {{ rowsError }}
      </p>

      <div v-else-if="shown.length" class="wb-panel__body ti-rows__body wb-table-wrap">
        <table class="wb-table" data-act="import-rows-table">
          <thead>
            <tr>
              <th>订单号</th>
              <th>店铺</th>
              <th>下单时间</th>
              <th>款号</th>
              <th>颜色</th>
              <th>尺码</th>
              <th class="wb-num">件数</th>
              <th
                class="wb-num"
                title="整单金额（订单报表原值）。同一张单拆成多行时，每行显示的都是这张单的金额，请不要把它们相加"
              >
                金额(元)
              </th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in shown" :key="o.id" :data-act="`import-row-${o.id}`">
              <td class="wb-mono">
                {{ o.orderNo || '—' }}
                <span
                  v-if="o.source === 'collect'"
                  class="wb-tag"
                  title="这一行是浏览器采集进来的，不是 Excel 导的"
                  >采集</span
                >
              </td>
              <td>{{ o.shop || '—' }}</td>
              <td class="wb-mono">{{ timeText(o.orderTime) || '—' }}</td>
              <td>
                <span v-if="o.styleCode" class="wb-mono">{{ o.styleCode }}</span>
                <span
                  v-else
                  class="wb-tag is-warn"
                  title="还没归到款式：去「归类核对」页签点名款"
                  >未归类</span
                >
              </td>
              <td>{{ o.color || '—' }}</td>
              <td>{{ o.size || '—' }}</td>
              <td class="wb-num">
                <span
                  class="ti-rows__qty"
                  :class="{ 'is-guess': qtyGuessed(o) }"
                  :title="qtyGuessed(o) ? '报表里没有件数，按 1 件计' : '报表「商品信息」块里的商品数量'"
                  >{{ qtyText(o) }}</span
                >
              </td>
              <td class="wb-num">{{ amountText(o) }}</td>
              <td class="ti-rows__status" :title="o.bizStatus">{{ o.bizStatus || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 两种"没有行"必须分开说：**今天还没导**（要去用上面的投放区）与
           **搜不到**（数据在，是这串关键字没有）—— 合成一句会让第一种人以为自己导失败了。 -->
      <div v-else class="ti-rows__empty" data-act="import-rows-empty">
        <p v-if="keyword">没有匹配「{{ q.trim() }}」的订单</p>
        <template v-else>
          <p>今天还没有导入订单</p>
          <p class="wb-muted">把订单 Excel 拖到上面的框里（或点「选择 Excel 文件」），导完这里就逐行列出来。</p>
        </template>
      </div>

      <!-- 超过 100 行先截断：本页是"确认导进来了什么"，不是翻页浏览的地方。
           要一行行过就点开，别默认把 2000 行渲染进 DOM。 -->
      <div v-if="!showAll && filtered.length > shown.length" class="wb-panel__foot ti-rows__more">
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          data-act="import-rows-more"
          @click="showAll = true"
        >
          显示全部 {{ filtered.length }} 行（当前显示前 {{ ROW_CAP }} 行）
        </button>
      </div>
    </section>

    <!-- ⚠️ 回执的下方**刻意什么都没有**（2026-10-11 二次收口）：
         这里原本挂着一张"预告卡"（`data-act="import-none"`，写着"导入后这里会留下一张回执"）——
         那是**一段解释自己的说明文字**：它占着位置、每次导入前都要读一遍，而它想说的那件事
         用户点一次就知道了。空态本来就该是**入口本身**（上面的投放区），而不是另一块文字。
         ⚠️ 连带的断言改动见 `scripts/today-ui-smoke.mjs` 的 `import-drop` 段：
            判据从"空态文案里有没有 Excel / 回执"改成"回执撤掉后入口还在、且仍可用"
            （后者才是真会坏的东西 —— 空态文案少了不影响任何人，入口没了才致命）。
         ⚠️ 2026-10-22：上面那条"回执下方刻意什么都没有"仍然成立 —— 现在那里有的是
            **订单明细表**（第 1 步的产物本身），不是又一次说明文字。 -->
  </div>
</template>

<script setup lang="ts">
// 「导入订单」页签 = 发货流程第 1 步。
//
// ⚠️ **导入动作不在本组件里**：它在容器（`TodayView.vue`）—— 因为总览页签的空态按钮
//    要能"切过来并立刻弹选文件"，而拖进来的文件也要走**同一条**识别/落库链路。
//    本组件只负责**呈现与投放**（点/拖 → 交给容器的 `importExcel` / `importFile`）。
//
// 2026-10-11：整页重排 —— 单按钮 + 灰字提示 ⇒ 投放区（可点可拖）+ 类型标签 + 库内现状条 + 回执卡。
// 2026-10-22：追加「今天导入的订单」明细表（用户："已导入 16 行订单，但不知道订单在哪"）。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import * as ipc from '@/core/services/ipc';
import type { ImportNextStep } from '@/core/services/importSheet';
import { localDayKey } from '@/lib/localDay';
import { resolveQty } from '@/lib/orderCost';
import type { UnifiedOrderRow } from '@/types';
import { useShipping } from '../flowCtx';
import { money } from '../purchase';

const { go, openModule, receipt, importing, importExcel, importFile, token } = useShipping();

/** 能自动识别的四类（与 `core/services/importSheet` 的识别分支一致；「商品信息」表刻意不列 —— 它不该导） */
const TYPES = ['订单报表', '待发货订单', '结算明细', '报价单'];

/** 投放区高亮：`dragenter`/`dragleave` 在子元素间来回触发 ⇒ 计数归零才算真的离开 */
const isOver = ref(false);
let depth = 0;

const dropTitle = computed(() => {
  if (isOver.value) return '松手就导入';
  if (importing.value) return '正在识别并入库…';
  return '把订单 Excel 拖到这里';
});

/** 选文件（**全页唯一的点击入口**）：按钮的 click 也冒泡到这里 —— 见模板上的注释 */
function pick(): void {
  if (importing.value) return;
  void importExcel();
}

function onEnter(): void {
  depth += 1;
  isOver.value = true;
}
function onLeave(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0) isOver.value = false;
}

/** 松手：把第一个文件交给容器。能同时拖多个也只认第一个（一份报表就是一天的量）。 */
function onDrop(e: DragEvent): void {
  depth = 0;
  isOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  void importFile(f);
}

/**
 * 回执里的"下一步"动作。
 *
 * ⚠️ 2026-10-11 起这一步变简单了：**绝大多数落点就是本页的一个页签**，而 `ImportNextStep.tab`
 *    把它们写明了（`classify` / `purchase`），直接 `go(tab)` 就地切。
 *    2026-10-17：算钱撤出发货台后，「归店铺 / 看毛利 / 核对运价表」三处改用 `moduleId`
 *    （`order-cost`，显示名「统计」）—— 那三处**必须真跳**，本页已经没有它们的页签。
 *
 * 原先这里挂着一张 `TAB_OF`（把模块 id 映到页签），因为它只能拿到 `moduleId`：
 * 于是回执要发 `moduleId: 'picking'`，再由本页偷偷换成「拿货」页签 —— 两处各写一半的映射。
 * 现在**映射消失在一处**（由 `importSheet` 直接给页签 id），这张表随之删掉。
 * 剩下的唯一分支：真跳别的模块（如「货与成本」这类主数据维护页，本页没有它的页签）。
 */
function nextGo(a: ImportNextStep): void {
  if (a.tab) {
    go(a.tab);
    return;
  }
  // ⚠️ `action` 必须一起带：`shop-accounts` 有七类资料，只说模块 id 会落在用户上次停的那一类上。
  if (a.moduleId) openModule(a.moduleId, a.action);
}

/** 关掉回执（写在容器那份 ref 上：总览的「待拣」卡靠它决定要不要点亮） */
function dismiss(): void {
  receipt.value = null;
}

// ── 今天导入的订单（2026-10-22 新增）─────────────────────────────────────────
//
// **本页自己取数**（不是容器）：容器的 `summary.orders` 只留了"有几行"，而这张表要的是行本身 ——
// 与 `ClassifyPanel` 同一个分工（容器管汇总，面板管自己那页的业务数据）。
//
// ⚠️ 参数必须与容器 `reload()` **逐字相同**（`orderShippingRows` + `importDate = 今天`）：
//    同一个数字在两处出现时，用户一定会拿列表行数去核对"上面那个 16" ——
//    换成另一种筛法（比如按下单日 / 不限日期），两个数立刻对不上，而**两边看起来都对**。
//
// ⚠️ 保活（`<KeepAlive>`）⇒ 切回来不会重新 `onMounted`：必须 `watch(token)`。
//    导入成功后容器 `bump()` 会把 `token` +1，这张表因此**自动**跟着刷新 ——
//    不需要在 `runImport` 里再手写一遍"刷列表"，那正是会漏掉拖放那条路的写法。

/** 一次性渲染上限（超过就折叠成「显示全部」）：本页是确认"导进来了什么"，不是翻页浏览 */
const ROW_CAP = 100;

const rows = ref<UnifiedOrderRow[]>([]);
const rowsLoading = ref(false);
const rowsError = ref('');
const q = ref('');
const showAll = ref(false);

async function loadRows(): Promise<void> {
  rowsLoading.value = true;
  rowsError.value = '';
  try {
    const r = await ipc.orderShippingRows({ limit: 2000, importDate: localDayKey() });
    if (!r.success) {
      // 读取失败要**说出来并清空**：留着上一轮的行会让人以为"库里就这些"
      rows.value = [];
      rowsError.value = `订单列表读取失败：${r.error ? String(r.error) : '未知原因'}`;
      return;
    }
    rows.value = r.data ?? [];
  } catch (e: unknown) {
    rows.value = [];
    rowsError.value = `订单列表读取失败：${e instanceof Error ? e.message : '未知错误'}`;
  } finally {
    rowsLoading.value = false;
  }
}

const keyword = computed(() => q.value.trim().toLowerCase());

/** 关键字过滤：**只筛展示**，不重新取数（库里那批不变，改一个字就变一次 IPC 是没必要的） */
const filtered = computed(() => {
  const k = keyword.value;
  if (!k) return rows.value;
  return rows.value.filter((o) =>
    [o.orderNo, o.shop, o.styleCode, o.styleColor, o.color, o.size, o.bizStatus].some((v) =>
      String(v ?? '').toLowerCase().includes(k)
    )
  );
});

const shown = computed(() => (showAll.value ? filtered.value : filtered.value.slice(0, ROW_CAP)));

/** 表头"报表 / 采集"两个数：与列表**同一份数据**算，不另取一次（口径只能有一处） */
const importedCount = computed(() => rows.value.filter((o) => o.source !== 'collect').length);
const collectCount = computed(() => rows.value.length - importedCount.value);
/** 这批里最晚的下单日（`yyyy-mm-dd`）—— 用来回答"这 16 行是哪段时间的单" */
const lastTime = computed(() => {
  const t = rows.value
    .map((o) => String(o.orderTime ?? ''))
    .filter(Boolean)
    .sort();
  return t.length ? String(t[t.length - 1]).slice(0, 10) : '';
});

/** 下单时间只显示到分钟（秒对"这单在哪"没有信息量，只会把列撑宽、逼出横向滚动） */
function timeText(v: string): string {
  return String(v ?? '').slice(0, 16);
}

/** 金额：`null` = 报表里没这一列 ⇒ 显示「—」，**不折成 0.00**（"没有"与"零"是两件事） */
function amountText(o: UnifiedOrderRow): string {
  const c = o.amountCents;
  return c === null || c === undefined ? '—' : money(c);
}

/**
 * 件数：判据单源 `resolveQty`（结算真值 → 源给的 `qty` → 报表块「商品数量」→ 按 1 件）。
 * 本页不传结算表 —— 那是"算钱"的口径，这里要的是"报表自己写了几个"，按 1 件猜出来的
 * 用灰字标出来（`is-guess`），不静默当成真值。
 */
function qtyText(o: UnifiedOrderRow): string {
  return String(resolveQty(o).qty);
}
function qtyGuessed(o: UnifiedOrderRow): boolean {
  return resolveQty(o).qtySource === 'assumed';
}

onMounted(() => void loadRows());
watch(
  () => token.value,
  () => void loadRows()
);

/**
 * 导入刚写完 ⇒ 把明细表滚进视野。
 *
 * 为什么需要：窄窗口（实测 1152×800）下，投放区 + 回执卡正好占满首屏，
 * 表格标题被压在最底、行一个都看不见 —— 这正是用户报的那句
 * 「显示『已导入 N 行订单』，但不知道订单在哪」。回执说完成之后，
 * 紧接着该出现在眼前的**就是那些行**，不该再让用户自己往下滚去猜。
 *
 * ⚠️ 只认 `wrote === true`：没写库的文件不产生新行，滚过去只会看到一批无关的旧数据。
 * ⚠️ `block: 'nearest'`：表格本来就在视野里时**不动**（别因为一次导入把页面莫名跳走）；
 *    尊重"减少动效"偏好（`smooth` 会让前庭敏感的人不适）。
 */
const rowsEl = ref<HTMLElement | null>(null);
watch(
  () => receipt.value,
  async (r) => {
    if (!r?.wrote) return;
    await nextTick();
    rowsEl.value?.scrollIntoView({
      block: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
);
</script>

<style scoped>
/* ══ 投放区 ══════════════════════════════════════════════════════════════════
   虚线框 = 约定的"可投放"语义；悬浮/拖入时变主色实线 + 浅底（**不靠背景色差**：
   深色主题下那点色差读不出来，所以边框样式本身也变）。 */
.ti-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 24px 18px;
  border: 1.5px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;
}
.ti-drop:hover {
  border-color: var(--wb-primary);
}
.ti-drop.is-over {
  border-style: solid;
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
/* 键盘走到里面的按钮时整块给反馈（区块自己不可聚焦，靠 :focus-within 代偿） */
.ti-drop:focus-within {
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 3px var(--wb-focus-ring);
}
.ti-drop.is-busy {
  cursor: progress;
}

.ti-drop__ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ti-drop__ico svg {
  width: 22px;
  height: 22px;
}
.ti-drop:hover .ti-drop__ico,
.ti-drop.is-over .ti-drop__ico {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

.ti-drop__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--wb-text);
}
.ti-drop__btn {
  margin-top: 2px;
  height: 32px;
  padding: 0 1rem;
  font-size: 13px;
}

/* 加载指示：只用 transform 动画（GPU），并尊重"减少动效"偏好 */
.ti-spin {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ti-spin 0.7s linear infinite;
}
@keyframes ti-spin {
  to {
    transform: rotate(360deg);
  }
}

.ti-drop__types {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.ti-drop__types li {
  padding: 2px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

/* ══ 今天导入的订单（2026-10-22）════════════════════════════════════════════════
   `.wb-panel` 自带边框 / 圆角 / 卡阴影；这里只补"列表自己滚、页面不用跟着长"。
   ⚠️ 原来那条独立的「今天导入 N 行订单」现状条已并进本表表头 —— 它的 `.ti-stock*`
      样式随之删除（两处都留 = 同一个数据块两种长相，改一处忘另一处）。 */
.ti-rows {
  flex-shrink: 0;
}

/* 表头一行放下：标题 + 计数 + 报表/采集 + 最近下单 + 搜索 + 刷新。
   窄窗口时换行（`flex-wrap`），但搜索永不缩成看不见的宽度。 */
.ti-rows__head {
  flex-wrap: wrap;
  row-gap: 6px;
}
/* 计数与"报表/采集"这些是**注释级**信息：压到 12px / 常色，别跟标题抢 */
.ti-rows__count {
  font-weight: 400;
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.ti-rows__kv {
  font-weight: 400;
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}
.ti-rows__kv b {
  font-weight: 600;
  color: var(--wb-text);
}

/* 搜索框与刷新推到右侧（`.wb-panel__head` 是 flex，无"推右"工具类） */
.ti-rows__search {
  width: 220px;
  max-width: 34vw;
  margin-left: auto;
}
.ti-rows__err {
  margin: 0 14px 12px;
}

/* 行多时表格**自己滚**（表头 sticky 是 `.wb-table th` 自带的）：页面继续往下长会顶走回执，
   也会让"上面说 16 行"与"下面翻两屏还没完"产生矛盾感。46vh ≈ 半屏，够看十来行。 */
.ti-rows__body {
  max-height: 46vh;
}

/* 状态列（"等待买家收货"这类长文案）：截断 + title 全文，不让它把表撑到需要横滚 */
.ti-rows__status {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 按 1 件猜出来的件数：灰一档 —— 别让"猜的"和"报表写的"长得一样 */
.ti-rows__qty.is-guess {
  color: var(--wb-text-muted);
}

.ti-rows__empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--wb-text);
}
.ti-rows__empty p {
  margin: 0;
}

.ti-rows__more {
  display: flex;
  justify-content: center;
}

/* ══ 导入回执 ═════════════════════════════════════════════════════════════
   一张常驻卡，回答"这是什么文件 / 数据去哪了 / 下一步点哪"。
   左侧色条区分"写库了 / 没写库"（不靠背景色差 —— 深色主题下那点色差读不出来）。 */
.td-receipt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-left: 3px solid var(--wb-primary);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  /* 只动 transform/opacity（GPU 加速），0.2s —— 卡片"落下来"而不是硬闪出来 */
  animation: ti-in 0.2s ease-out both;
}
@keyframes ti-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 未写库：warn 色条（它更该被看见 —— "什么也没发生"是容易漏掉的结果） */
.td-receipt--nowrite {
  border-left-color: var(--wb-warning);
}

.td-receipt__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.td-receipt__badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}
/* 状态色：写库了 = 成功绿，没写 = 警示橙（深色主题下这两组也达标） */
.td-receipt__badge.is-ok {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.td-receipt__badge.is-warn {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.td-receipt__title {
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-text);
}

.td-receipt__close {
  margin-left: auto;
}

/* 判据明细（识别凭什么这么判 + 导了多少行）—— **压在最后当脚注**：加条分隔线降一档，
   不跟"落点 / 下一步"抢注意力（它信息量最大，但用户大多是出问题时才回头核对）。 */
.td-receipt__detail {
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--wb-border);
  font-size: 12px;
  line-height: 1.55;
  color: var(--wb-text-muted);
}

/* ── 结论卡的三层（2026-10-11）──────────────────────────────────────────────
   ① 大字结论：卡片里**唯一**的大字号（与卡片标题 13.5px / 正文 12.5px 拉开三档），
      扫一眼就是结果。原先没有这一层 —— 结果混在 sentence 里，得读。 */
.td-receipt__headline {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--wb-text);
}

/* ④ 异常行：直接平铺（**要用户采取行动**的事，不能折叠）。
   左侧一条警示色边 + 逐条一行，与下面的判据（灰、折叠）在视觉上分得开。 */
.td-receipt__warn {
  margin: 0;
  padding: 6px 0 6px 10px;
  border-left: 2px solid var(--wb-warning);
  list-style: none;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wb-warning);
}

/* ⑥ 判据：**默认折叠**。`<summary>` 是唯一可见的那一行 —— 它要看起来**像可点的**
   （默认的三角标记 + hover 变主色），否则用户根本不知道里面还有内容可看。 */
.td-receipt__more {
  border-top: 1px solid var(--wb-border);
  padding-top: 8px;
}
.td-receipt__more > summary {
  font-size: 12px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.td-receipt__more > summary:hover {
  color: var(--wb-primary);
}
/* 展开后那段不该再带自己的分隔线（它上面已经是 summary 那条） */
.td-receipt__more .td-receipt__detail {
  padding-top: 6px;
  border-top: 0;
}

/* 落点：**回答"数据去哪了"**的那一行 —— 正文色，比判据重一档，但比结论轻（它是一句注释）。 */
.td-receipt__landed {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--wb-text);
}

.td-receipt__next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.td-receipt__nextlabel {
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* 「减少动效」偏好：关掉入场与旋转，不牺牲信息 */
@media (prefers-reduced-motion: reduce) {
  .td-receipt {
    animation: none;
  }
  .ti-spin {
    animation-duration: 2s;
  }
}
</style>
