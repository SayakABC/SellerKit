<template>
  <div class="wb-page pk-view" :class="{ 'is-embedded': embedded }">
    <!-- 页头：原先整页**没有标题**，只有一行统计数字 + 一排按钮，用户不知道这是什么页面。
         `embedded` 时只藏**标题那两行**（外层页签已经交代了"这是哪一步"），
         ⚠️ **绝不能整块藏掉**：生成 / 导出 / 更多三个按钮就在这个 header 里，
         整块藏掉等于把它们一起藏了（实测：内嵌后页签里没有"生成待拣清单"按钮，
         打开就是空态且没法操作 —— 这是变异测试顺带抓到的真 bug）。 -->
    <header class="wb-head" :class="{ 'is-toolbar': embedded }">
      <div v-if="!embedded" class="wb-head__main">
        <h1 class="wb-head__title">拣货</h1>
        <p class="wb-head__desc">
          按未发货订单汇总「要拣什么、各几件、图与供应商在哪、大概多少钱」，按厂家分组，可导出带图
          xlsx
        </p>
      </div>
      <div class="wb-head__actions">
        <button
          class="wb-btn wb-btn--primary"
          data-act="generate"
          :disabled="loading"
          @click="generate"
        >
          {{ loading ? '生成中…' : summary.groups.length ? '重新生成' : '生成待拣清单' }}
        </button>
        <button
          class="wb-btn"
          data-act="export"
          :disabled="loading || !summary.groups.length"
          @click="exportXlsx"
        >
          导出带图 xlsx
        </button>
        <button
          class="wb-btn"
          data-act="more"
          :class="{ 'is-on': showMore }"
          @click="showMore = !showMore"
        >
          {{ showMore ? '收起' : '更多' }}
        </button>
      </div>
    </header>

    <!-- 指标条。⚠️ `.pk-topbar` 类名与 "SKU 2 / 件数 7 / 涉及订单 4" 的子串都不可改：冒烟按此断言 -->
    <div class="wb-metabar pk-topbar">
      <span class="wb-metric"
        >SKU <b>{{ summary.groups.length }}</b></span
      >
      <span class="wb-metric"
        >件数 <b>{{ summary.pieces }}</b></span
      >
      <span class="wb-metric"
        >涉及订单 <b>{{ summary.orders }}</b></span
      >
      <!-- 预估金额：**有价部分**的合计。缺价时另起一条说明，不把"没查到价"混进这个数。
           ⚠️ 一件价都没查到时不写 `¥0.00` —— 那等于说"这批货值 0 元"，与事实相反；
           改为 `—` + 「全部无进价」（口径统一在 `amountText` / `noPriceNote` 两个函数里）。 -->
      <span class="wb-metric" data-act="amount"
        >预估金额 <b>{{ amountText(summary.amount, summary.noPricePieces, summary.pieces) }}</b>
        <span v-if="summary.noPricePieces" class="wb-muted">{{ noPriceNote(summary.noPricePieces, summary.pieces) }}</span>
      </span>
    </div>

    <!-- 默认条件**写在界面上**（不藏进设置）：看不到默认值，用户就会怀疑数字 -->
    <div class="pk-scope" data-act="scope">
      <span class="wb-tag pk-tag is-on">未发货</span>
      <span class="wb-tag pk-tag is-on">近 {{ days }} 天</span>
      <span v-if="shopPick" class="wb-tag pk-tag is-on">{{ shopPick }}</span>
      <span v-if="summary.excludedFinished" class="wb-tag pk-tag" data-act="excluded-finished">
        已排除已终结 {{ summary.excludedFinished }} 行（关闭/已完成 —— 不用拣）
      </span>
      <span v-if="summary.excludedOld" class="wb-tag pk-tag"
        >超窗剔除 {{ summary.excludedOld }} 行</span
      >
      <span v-if="summary.undated" class="wb-tag pk-tag is-warn" data-act="undated-hint">
        无下单日期 {{ summary.undated }} 行（照收，未按天数窗过滤）
      </span>
      <span v-if="summary.shippedRows" class="wb-tag pk-tag is-warn"
        >含已发货 {{ summary.shippedRows }} 行</span
      >
    </div>

    <div v-if="showMore" class="pk-more">
      <div class="pk-actions--wrap">
        <label class="pk-field">
          天数窗
          <input
            v-model.number="days"
            class="wb-input wb-input--sm pk-input--num"
            type="number"
            min="0"
            max="3650"
          />
          天（0 = 不限）
        </label>
        <select
          v-model="shopPick"
          class="wb-input wb-input--sm"
          data-act="shop-pick"
          :disabled="loading"
        >
          <option value="">全部店铺</option>
          <option v-for="s in shops" :key="s" :value="s">{{ s }}</option>
        </select>
        <label class="pk-field">
          <input v-model="includeShipped" type="checkbox" data-act="include-shipped" />
          连已发货一起看（对照用）
        </label>
      </div>
    </div>

    <p v-if="error" class="pk-error">{{ error }}</p>

    <!-- 空态分两种（UX 审查 D3/P0-3）：「还没生成过」是引导动作；「生成过但没货可拣」要说清为什么空。
         2026-10-01：换用标准空态骨架（图标 + 标题 + 说明 + 动作）—— 原先是一段居中灰字，
         四周全是空白，"空"与"坏"在视觉上分不开。文案逐字保留（冒烟按 textContent 断言）。 -->
    <div v-if="!summary.groups.length && !loading" class="wb-empty pk-empty" data-act="empty">
      <span class="wb-empty__icon" v-html="ICON.empty"></span>
      <template v-if="!generated">
        <p class="wb-empty__title">还没生成过待拣清单</p>
        <p class="wb-empty__desc">
          点「生成待拣清单」→ 按未发货订单汇总出 图 / 款色码 / 件数 / 供应商
        </p>
      </template>
      <template v-else-if="summary.scanned">
        <p class="wb-empty__title">没有要拣的货</p>
        <p class="wb-empty__desc">
          扫了 {{ summary.scanned }} 行未发货订单，都被「已终结 / 超窗」排除了（见上方标签）；
          要放宽就去「更多」把天数窗调大，或勾上「连已发货一起看」对照。
        </p>
      </template>
      <template v-else>
        <p class="wb-empty__title">一行订单都没扫到</p>
        <p class="wb-empty__desc">
          这批条件下一行订单都没扫到 —— 若还没导过订单，去「今天」页点「导入 Excel」导一份订单报表。
        </p>
        <div class="wb-empty__actions">
          <button class="wb-btn wb-btn--primary" data-act="empty-import" @click="goImport">
            去「今天」导入
          </button>
        </div>
      </template>
    </div>

    <section v-else class="wb-panel pk-panel">
      <div class="pk-gaps">
        <span class="pk-gaps__title">缺哪一环：</span>
        <span
          class="wb-tag pk-tag"
          :class="{ 'is-on': !summary.missingQty }"
          data-act="missing-qty"
        >
          缺件数 {{ summary.missingQty }}
        </span>
        <span
          class="wb-tag pk-tag"
          :class="{ 'is-on': !summary.missingImage }"
          data-act="missing-image"
        >
          缺图 {{ summary.missingImage }}
        </span>
        <span
          class="wb-tag pk-tag"
          :class="{ 'is-on': !summary.missingSupplier }"
          data-act="missing-supplier"
        >
          缺供应商 {{ summary.missingSupplier }}
        </span>
        <span
          class="wb-tag pk-tag"
          :class="{ 'is-on': !summary.missingStyle }"
          data-act="missing-style"
        >
          未识别款 {{ summary.missingStyle }}
        </span>
        <!-- 无进价：**件数**不是组数（"还有几件货算不出钱"才是执行时要看的） -->
        <span
          class="wb-tag pk-tag"
          :class="{ 'is-on': !summary.noPricePieces }"
          data-act="missing-price"
        >
          无进价 {{ summary.noPricePieces }} 件
        </span>
      </div>

      <!-- 按厂家分组（一个厂家一段；未指定厂家的整段排最后）—— 订单是发给厂家拣货的，
           所以"哪家要拿什么、大概多少钱"必须一眼看到，而不是自己去筛一列供应商。
           ⚠️ 必须套 `.wb-table-wrap`：`.wb-panel` 是 `overflow: hidden`，加了两列（进价/金额）后
           窄窗口下右半截会被**静默裁掉**（既看不见、也没有滚动条）。 -->
      <div class="wb-panel__body wb-table-wrap">
        <table class="wb-table pk-table" data-act="picking-table">
          <thead>
            <tr>
              <th>图</th>
              <th>款 / 色 / 码</th>
              <th class="wb-num">件数</th>
              <th class="wb-num">订单数</th>
              <th class="wb-num">进价</th>
              <th class="wb-num">预估金额</th>
              <th>缺</th>
            </tr>
          </thead>
          <tbody
            v-for="sg in summary.suppliers"
            :key="sg.supplierId"
            :data-supplier="sg.supplierName || '(未指定厂家)'"
          >
            <tr
              class="pk-supplier-row"
              :class="{ 'is-missing': !sg.supplierId }"
              :data-act="sg.supplierId ? 'supplier-head' : 'supplier-head-none'"
            >
              <td colspan="7">
                <b>{{ sg.supplierName || '(未指定厂家)' }}</b>
                <span class="pk-supplier-row__meta">{{ supplierMeta(sg) }}</span>
                <span v-if="!sg.supplierId" class="pk-supplier-row__meta"
                  >— 给产品补上供应商，这些货才会归到厂家名下</span
                >
              </td>
            </tr>
            <tr v-for="g in sg.groups" :key="g.key" :data-key="g.key">
              <td>
                <img
                  v-if="thumbs[g.imagePath]"
                  class="pk-thumb"
                  :src="thumbs[g.imagePath]"
                  alt=""
                />
                <span v-else class="pk-muted">—</span>
              </td>
              <td class="wb-mono">{{ g.key }}</td>
              <td class="wb-num pk-strong" data-act="pieces">{{ g.pieces }}</td>
              <td class="wb-num">{{ g.orders }}</td>
              <td class="wb-num pk-muted" data-act="unit-price">
                {{ g.unitPrice === null ? '—' : money(g.unitPrice) }}
              </td>
              <td class="wb-num pk-amount" data-act="amount-cell">
                {{ g.unitPrice === null ? '—' : money(g.amount) }}
              </td>
              <td>
                <span v-if="!groupGaps(g).length" class="pk-ok">齐</span>
                <span v-else class="wb-tag pk-tag is-warn">{{ groupGaps(g).join(' · ') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
// 「拣货」视图：一键生成 → 按 SKU 汇总"要拣什么、各几件、图与供应商在哪、大概多少钱"
// → 按厂家分组看 → 导出带图 xlsx（一家一张表）。
//
// 口径（别改，与订单利润页**同一份实现**）：
//   · 件数 `resolveQty`（结算商品行真值 → 报表块 `商品数量` → 按 1 件并标缺）；
//   · 分组键 `skuKey`（款 × 色 × 码，缺哪段标哪段）；
//   · 进价 `pickUnitCost`（款级成本区间 `ae_cost_map`，按该行下单日期取当时生效的那条）——
//     所以同一条订单在「拣货」与「算钱」两页上的成本是同一个数；
//   · 范围：**未发货**（宿主按机械事实筛）+ **近 30 天** + **已终结（关闭/已完成）不拣**（`bucketOfStatus`）。
// 界面上把默认条件写成标签（含被剔除的行数），缺件数/缺图/缺供应商/无进价逐行标 ——
// 拣货单是"照它干活"的东西，少一行就是少发一件货、漏一个价就是少带一笔钱。
//
// 取数四路（全部经 core 服务，视图内零算术）：
//   1. 订单行投影（含三层回落后的图）→ `pickingRows`
//   2. 结算商品行件数                → `settleOrders`（键口径 `settleQtyKey`）
//   3. 款级成本区间（进价唯一来源）  → `aeCostMapList`
//   4. 缩略图（合批一次往返）        → `orderImageThumbBatch`
//   导出：`pickingExportExcel` → 主进程 exceljs（带图 + 按厂家分表）
import { onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import * as ipc from '@/core/services/ipc';
import {
  aggregatePicking,
  DEFAULT_PICKING_DAYS,
  type PickingGroup,
  type PickingSupplierGroup,
  type PickingSummary,
} from '@/lib/picking';
import { settleQtyKey, type CostInterval, type SettleQtyInfo } from '@/lib/orderCost';
import { domToJpeg, encodeImagesForExport } from '@/lib/pickingExport';

/**
 * `embedded` = 被「今天」页的页签内嵌（藏掉本页自己的页头，避免"标题下面又一个标题"）。
 * `refreshToken` = 宿主的数据版本号：订单/映射一变，`today` 那边 +1 ⇒ 本页跟着重算。
 *   为什么必须有它：页签是 `KeepAlive` 保活的，不重算就会**一直显示刚才那份清单**——
 *   保活的代价（看到旧数据）必须这样还回去。
 */
const props = withDefaults(
  defineProps<{ embedded?: boolean; refreshToken?: number }>(),
  { embedded: false, refreshToken: 0 }
);

/** 内嵌时"去导订单"由外层页签系统接管（本组件不认识页签，只发一个意图） */
const emit = defineEmits<{ (e: 'go-import'): void }>();

/** 空态图标（内联 SVG，跟随 currentColor） */
const ICON = {
  empty:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/><path d="M8 10.2v4"/></svg>',
};

const loading = ref(false);
const error = ref('');
/** 本页是否**生成过**：空态要分"还没点过"与"点了但没货可拣"两种（后者得说清为什么空） */
const generated = ref(false);
/** 低频筛选默认收起（界面精简）：天数窗 / 店铺 / 含已发货 */
const showMore = ref(false);
const days = ref(DEFAULT_PICKING_DAYS);
const shopPick = ref('');
const includeShipped = ref(false);
const shops = ref<string[]>([]);

/** 缩略图边长：96 太小 —— 导出时要以它为准转 JPEG 嵌进 Excel（发厂家看图认货），160 在 40px 显示框里也更清晰 */
const THUMB_EDGE = 160;
/** 缩略图缓存：本地路径 → dataUrl（同 SKU 的多行共用一张，合批只取一次） */
const thumbs = ref<Record<string, string>>({});

const EMPTY: PickingSummary = aggregatePicking([], { today: '' });
const summary = ref<PickingSummary>(EMPTY);

/** 逐组的"缺什么"标签（界面按它出提示；齐的不显示）。
 *  ⚠️ 「无进价」也进这里 —— 它和缺图/缺件数同类："这行的数不全，别拿它当完整清单用"。 */
function groupGaps(g: PickingGroup): string[] {
  const out: string[] = [];
  if (g.missingQty) out.push(`缺件数 ${g.missingQty}`);
  if (g.missingImage) out.push(`缺图 ${g.missingImage}`);
  if (!g.supplierId) out.push('缺供应商');
  if (g.missingStyle) out.push('未识别款');
  if (g.unitPrice === null) out.push('无进价');
  return out;
}

/** 金额展示：两位小数（**不写 ¥ 前缀** —— 列头已写「进价(元)/金额(元)」，重复缀符号会挤掉数字宽度） */
function money(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

/**
 * 「合计金额」怎么显示 —— 与 `noPriceNote` 是一对，凡是并列展示金额的地方都走这两个函数。
 * ⚠️ 一件价都没查到（缺价件数 ≥ 总件数）时**不写 `¥0.00`**：0 有两种含义
 * （"真的不要钱" / "没查到价"），写 0 会让"估算偏低"和"真的很便宜"长得一模一样。
 */
function amountText(amount: number, noPricePieces: number, pieces: number): string {
  if (noPricePieces > 0 && noPricePieces >= pieces) return '—';
  return `¥${money(amount)}`;
}

/** 与 `amountText` 配套的说明文字：只有**部分**缺价才叫"不含"，全缺时说的是"全部" */
function noPriceNote(noPricePieces: number, pieces: number): string {
  if (noPricePieces <= 0) return '';
  return noPricePieces >= pieces
    ? `（${noPricePieces} 件全部无进价）`
    : `（不含 ${noPricePieces} 件无进价）`;
}

/** 厂家段标题上的「N 个 SKU · N 件 · 金额」。（用单串文本而不是几个元素拼 —— 相邻元素的
 *  `textContent` 之间不插分隔符，拆开拼出来的字符串会缺空格、也让冒烟断言变脆。） */
function supplierMeta(sg: PickingSupplierGroup): string {
  const head = `${sg.groups.length} 个 SKU · ${sg.pieces} 件 · `;
  if (sg.pieces - sg.noPricePieces <= 0) return `${head}无进价（${sg.noPricePieces} 件）`;
  const tail = sg.noPricePieces > 0 ? `（另有 ${sg.noPricePieces} 件无进价）` : '';
  return `${head}预估 ¥${money(sg.amount)}${tail}`;
}

function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一键生成：取数 → 汇总 → 取缩略图（三路都在这里，界面只读结果） */
/** 空态里的下一步：去导订单 —— 一行订单都没有时，用户其实缺的是"先导订单"。
 *  内嵌时发事件交给「今天」页切到导入页签（`switchModule('today')` 会跳到本页再跳回来，等于没动）。 */
function goImport(): void {
  if (props.embedded) {
    emit('go-import');
    return;
  }
  switchModule('today');
}

async function generate(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await ipc.pickingRows({
      shop: shopPick.value,
      includeShipped: includeShipped.value,
    });
    if (!res.success || !res.data) throw new Error(res.error || '读取待拣订单失败');
    const rows = res.data.rows;

    // 结算商品行的件数（真值）：按可见订单号批量取一次，铺成查表（键口径由 `settleQtyKey` 单源给出）
    const settleQty: Record<string, SettleQtyInfo> = {};
    const orderNos = [...new Set(rows.map((r) => String(r.orderNo ?? '')).filter(Boolean))];
    if (orderNos.length) {
      const st = await ipc.settleOrders({ orderNos });
      if (st.success) {
        for (const row of st.data?.rows ?? []) {
          for (const it of row.items ?? []) {
            settleQty[settleQtyKey(row.orderNo, it.itemId)] = { lines: it.lines, qty: it.qty };
          }
        }
      }
    }

    // 进价/预估金额：取**款级成本区间**（`ae_cost_map`），与「算钱」页同一张表、同一份取价实现。
    // 读不到就传空数组 → 全部行标「无进价」（**不按 0 算**），不影响清单本身可用。
    const c = await ipc.aeCostMapList();
    const costs: CostInterval[] = (c.success ? (c.data ?? []) : []).map((x) => ({
      styleCode: String(x.styleCode ?? ''),
      effectiveFrom: String(x.effectiveFrom ?? ''),
      unitPrice: (Number(x.unitPriceCents) || 0) / 100,
      source: String(x.source ?? ''),
    }));

    summary.value = aggregatePicking(rows, {
      settleQty,
      costs,
      days: days.value,
      today: todayLocal(),
    });
    generated.value = true;

    // 缩略图：只取"清单上真正要看的"那些图，合批一次往返（路径去重）
    const paths = [...new Set(summary.value.groups.map((g) => g.imagePath).filter(Boolean))];
    thumbs.value = {};
    if (paths.length) {
      const t = await ipc.orderImageThumbBatch(
        paths.map((localPath) => ({ localPath, maxEdge: THUMB_EDGE }))
      );
      if (t.success) {
        paths.forEach((p, i) => {
          const url = t.data?.dataUrls?.[i];
          if (url) thumbs.value[p] = url;
        });
      }
    }
  } catch (e: unknown) {
    error.value = `生成失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 导出拣货单（**带图 + 按厂家分表**，供直接转发厂家）。
 *
 * 为什么不在渲染层用 `xlsx` 生成了：Excel 没有"图片作为单元格内容"的格式，嵌图必须走浮动图 +
 * 图片部件，社区版 SheetJS 不支持；主进程已有 `exceljs` 的嵌图先例（拿货单导出）。
 * **口径不搬家**：这里把已算好的行原样传过去（件数/进价/金额/缺口文案），主进程只画表 ——
 * 于是"导出的数"与"屏幕上的数"不可能不一致。
 *
 * 图：复用页面上**已经取回的缩略图**（不额外发 IPC），再用 canvas 统一转成 JPEG ——
 * 真实订单图大半是 WebP，而 Excel 嵌入的 WebP 在旧版 Office/WPS 里显示不出来（详见 `lib/pickingExport`）。
 *
 * 行的顺序 = 界面顺序（有厂家的在前、未指定的最后），主进程按 `supplierName` 切表。
 */
async function exportXlsx(): Promise<void> {
  const groups = summary.value.groups;
  if (!groups.length) return;
  try {
    // 图先编码（顺序、失败不抛）：取不到的只是一行没图，不该让整个导出失败
    const images = await encodeImagesForExport(
      groups.map((g) => g.imagePath),
      { loadDataUrl: (p) => thumbs.value[p] ?? '', toJpeg: domToJpeg },
      THUMB_EDGE,
    );
    const rows = groups.map((g) => ({
      supplierName: g.supplierId ? g.supplierName : '',
      styleCode: g.styleCode,
      color: g.color,
      size: g.size,
      pieces: g.pieces,
      orders: g.orders,
      unitPrice: g.unitPrice,
      amount: g.unitPrice === null ? null : g.amount,
      gaps: groupGaps(g).join(' · '),
      image: images[g.imagePath] ?? null,
    }));
    const r = await ipc.pickingExportExcel({ rows, defaultName: `拣货单-${todayLocal()}` });
    if (!r.success) {
      if (r.error === '__canceled__') return; // 用户点了取消：不算失败
      throw new Error(r.error || '导出失败');
    }
    const withImg = rows.filter((x) => x.image).length;
    toast(
      `已导出 ${groups.length} 个 SKU（共 ${summary.value.pieces} 件）· 按厂家分了 ${
        summary.value.suppliers.length
      } 张表 · ${withImg} 张图`,
      'success',
    );
  } catch (e: unknown) {
    const msg = `导出失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  }
}

// 数据变了（导入了订单 / 配了映射 / 改了成本）→ **已经生成过**的清单跟着重算；
// 没生成过就保持空态（本页的"一键语义"：进页不自动取数，冒烟有断言钉着）。
watch(
  () => props.refreshToken,
  () => {
    if (generated.value) void generate();
  }
);

onMounted(async () => {
  // 店铺清单（可选：读不到就只是不能按店铺筛，不影响生成）
  try {
    await ipc.shopDbEnsure();
    const sl = await ipc.shopList({ status: 'active' });
    if (sl.success)
      shops.value = (sl.data?.rows ?? []).map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    /* 店铺域不可用不影响拣货 */
  }
});
</script>

<style scoped>
/* 页面外壳由全局 .wb-page 提供；`.pk-topbar` 交给全局 .wb-metabar（类名保留供冒烟断言）。 */

/* 内嵌在「今天」页签里：顶上紧邻页签栏，全局那 18px 顶部留白会跟页签栏叠成一大块，
   收一点（其余边距不动 —— 与独立打开时保持同一套栅格）。 */
.pk-view.is-embedded {
  padding-top: 12px;
}

/* 内嵌时页头只剩动作按钮（标题两行由外层页签交代）⇒ 当工具栏用：靠左，别留 `margin-left:auto`
   顶到右边去（那会看着像"这页的按钮飞了"）。 */
.pk-view.is-embedded .wb-head__actions {
  margin-left: 0;
}

/* 条件条：把 5–7 个条件标签装进一张白卡。
   放在画布上时，激活标签用的 --wb-primary-soft 与画布色几乎同色 → 标签会"消失"；
   装进白卡后两种标签（浅底激活 / 灰底中性）都能读出来。 */
.pk-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.pk-tag {
  flex-shrink: 0;
}

.pk-more {
  padding: 11px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.pk-actions--wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.pk-field {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.pk-input--num {
  width: 68px;
  text-align: right;
}

.pk-error {
  margin: 0;
  font-size: 13px;
  color: var(--wb-danger);
}

/* 空态：面板化，避免"一段灰字飘在大片空白中央" */
.pk-empty {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.pk-panel {
  flex: 1;
  min-height: 0;
}

/* 表内"缺哪一环"条：面板顶部工具条 */
.pk-gaps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  font-size: 13px;
}

/* 厂家分组行：跨列的分段标题（不是数据行）。
   ⚠️ 选择器必须带 `.wb-table-wrap .pk-table` 前缀：全局有
   `.wb-table-wrap .wb-table td:first-child{ position:sticky; left:0; background:var(--wb-surface) }`
   与 `.wb-table td{ white-space:nowrap }`，特异性都比裸 `.pk-supplier-row td` 高 ——
   不抬头就会看到"分组行白底、且文字不换行被截断"（而它恰恰是唯一需要换行的行）。 */
.wb-table-wrap .pk-table .pk-supplier-row td {
  background: var(--wb-surface-2);
  border-bottom: 1px solid var(--wb-border-strong);
  font-size: 13px;
  color: var(--wb-text);
  white-space: normal;
}

.wb-table-wrap .pk-table .pk-supplier-row.is-missing td {
  background: var(--wb-warning-soft);
  color: var(--wb-text-muted);
}

.pk-supplier-row__meta {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

/* 分组表：`tbody` 一段一段，全局的 `tbody tr:last-child td{border-bottom:0}` 会把每段末行
   的横线去掉，看起来像"表格断了" → 只在最后一段去掉。 */
.pk-table tbody tr:last-child td {
  border-bottom: 1px solid var(--wb-border);
}

.pk-table tbody:last-child tr:last-child td {
  border-bottom: 0;
}

.pk-amount {
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

.pk-gaps__title {
  color: var(--wb-text-muted);
}

.pk-thumb {
  display: block;
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
}

.pk-strong {
  color: var(--wb-text);
  font-weight: 600;
}

.pk-muted {
  color: var(--wb-text-muted);
}

.pk-ok {
  color: var(--wb-success);
  font-size: 12px;
}
</style>
