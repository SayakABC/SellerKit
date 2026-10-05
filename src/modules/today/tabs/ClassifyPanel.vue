<template>
  <div class="wb-page cl-view" data-act="classify-panel">
    <!-- 指标条：全是**计数**（有多少活要干）。
         ⚠️ 每格必须是「标签 + 空格 + <b>数字</b>」同一串文本（冒烟按 textContent 取子串）。 -->
    <div class="wb-metabar cl-stats" data-act="cl-stats">
      <span class="wb-metric">待核对 <b>{{ total }}</b></span>
      <span class="wb-metric" :class="{ 'is-warn': counts.unclassified > 0 }" data-act="cl-metric-unclassified">
        未归类 <b>{{ counts.unclassified }}</b>
      </span>
      <span class="wb-metric">识别库 <b>{{ counts.styles }}</b> 款</span>
    </div>

    <!-- 工具条：查询 + 刷新 + 批量识别。
         识别按钮放主位（这是本页唯一的"批量动作"，其余都是逐行的）。 -->
    <div class="cl-bar">
      <input
        v-model="search"
        class="wb-input wb-input--sm cl-search"
        data-act="cl-search"
        placeholder="搜索订单号 / 店铺 / 款式 / 颜色…"
        @keyup.enter="doSearch"
      />
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-query" @click="doSearch">查询</button>
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-reload" :disabled="loading" @click="reload">
        刷新
      </button>
      <span class="cl-grow"></span>
      <button
        type="button"
        class="wb-btn wb-btn--sm wb-btn--primary"
        data-act="cl-recognize"
        :disabled="loading || running || !rows.length"
        @click="recognizeAll"
      >
        {{ running ? `识别中 ${done}/${queue.length}…` : '识别未归类' }}
      </button>
      <button v-if="running" type="button" class="wb-btn wb-btn--sm" data-act="cl-stop" @click="stop">
        停止
      </button>
    </div>

    <p v-if="progress" class="wb-notice" data-act="cl-progress">{{ progress }}</p>
    <p v-if="error" class="wb-notice wb-notice--error" data-act="cl-error">{{ error }}</p>

    <section class="wb-panel">
      <div class="wb-panel__head">
        <span>待核对订单</span>
        <span class="wb-muted">
          改完点「保存」重归类；识别结果没问题的点「确认无误」，之后不再出现在这里
        </span>
        <span class="cl-actions">
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="cl-all-ok"
            :disabled="busy || !total"
            @click="confirmAll"
          >
            全部确认无误
          </button>
        </span>
      </div>

      <div v-if="rows.length" class="wb-panel__body wb-table-wrap">
        <table class="wb-table cl-table" data-act="cl-table">
          <thead>
            <tr>
              <th class="cl-thumb-col">图</th>
              <th>订单号</th>
              <th>店铺</th>
              <th>品类</th>
              <th>颜色</th>
              <th>Logo</th>
              <th>尺码</th>
              <th class="cl-style-col">归属款</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in rows" :key="o.id">
              <td>
                <!-- 核对必须看得见图：识别结果对不对，是**拿图比**出来的而不是读文字读出来的 -->
                <img
                  v-if="thumbs[o.localPath || '']"
                  class="wb-thumb"
                  :src="thumbs[o.localPath || '']"
                  :alt="o.orderNo"
                />
                <span v-else class="wb-thumb wb-thumb--empty" title="这条订单没有主图"></span>
              </td>
              <td class="wb-mono">{{ o.orderNo }}</td>
              <td>{{ o.shop || '—' }}</td>
              <td>
                <input
                  v-model="draftOf(o).category"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-cat-${o.id}`"
                />
              </td>
              <td>
                <input
                  v-model="draftOf(o).color"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-color-${o.id}`"
                />
              </td>
              <td>
                <input
                  v-model="draftOf(o).logo"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-logo-${o.id}`"
                />
              </td>
              <td>{{ o.size || '—' }}</td>
              <td>
                <select
                  v-if="styles.length"
                  v-model.number="draftOf(o).styleId"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-style-${o.id}`"
                >
                  <option :value="0">自动匹配{{ o.styleCode ? `（当前 ${o.styleCode}）` : '（未归类）' }}</option>
                  <option v-for="s in styles" :key="s.id" :value="s.id">
                    {{ s.code }}{{ s.name ? ` · ${s.name}` : '' }}
                  </option>
                </select>
                <span v-else class="wb-muted">识别库为空</span>
              </td>
              <td class="cl-ops">
                <button
                  type="button"
                  class="wb-link"
                  :data-act="`cl-save-${o.id}`"
                  :disabled="busy || !isDirty(o)"
                  @click="saveOne(o)"
                >
                  保存
                </button>
                <button
                  type="button"
                  class="wb-link"
                  :data-act="`cl-ok-${o.id}`"
                  :disabled="busy"
                  @click="confirmOne(o)"
                >
                  确认无误
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="wb-empty" data-act="cl-empty">
        <p class="wb-empty__title">{{ emptyTitle }}</p>
        <p class="wb-empty__desc">{{ emptyDesc }}</p>
        <div v-if="!hasOrders" class="wb-empty__actions">
          <button type="button" class="wb-btn wb-btn--primary" data-act="cl-goto-import" @click="go('import')">
            去导入订单
          </button>
        </div>
      </div>

      <div v-if="total > PAGE_SIZE" class="wb-panel__foot wb-pager" data-act="cl-pager">
        <span>共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-prev"
          :disabled="page <= 0 || loading"
          @click="gotoPage(page - 1)"
        >
          上一页
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-next"
          :disabled="page >= totalPages - 1 || loading"
          @click="gotoPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
// 「归类核对」页签 = 发货流程第 2 步（2026-10-05 从「订单归类」岛内建过来）。
//
// **这一页干什么**：订单导进来只是"有这些单"，还不知道每单是什么款 —— 本页把"还没归到款的行"
// 逐条核对/修正。两条归类路径**互为补充**，页面上都要给：
//   · **批量**：识别未归类的图（宿主「设置 › 识别」配引擎 + Key，本页只调用）——
//     走的是与导入/产品库**同一份**归一化与指纹算法，所以识别出来的款与人工核对的款
//     会落到同一个款编码上；
//   · **逐行**：改品类/颜色/Logo，或在下拉里直接点名某个款编码。改字段 → 按指纹重归类；
//     点名 → 挂到该款并把指纹记入它（**后续自动识别会命中同一款**）。
//
// **照功能不照样式**：移植自原「订单归类」岛的**纠正页**（该岛已于 2026-10-05 整体下架，
// 源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的 `.panel/.bar/.btn`；
// 内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
//
// **这一页砍掉了什么（"哪些在流程里有用的"的裁量，2026-10-05）**：
//   · 岛里的「导入与识别」队列页（`oi_queue` 中间表 + 断点续跑）—— 宿主的导入**直落订单表**，
//     队列是多余的中间层；本页的批量识别直接对"已在库里的未归类订单"跑，不需要队列。
//   · 行内改**款式展示名** —— 展示名是主数据，维护在「货与成本 › 产品」；本页只做"核对归类"，
//     一个输入框能改的东西越少，核对这件事越不容易被误操作。
//   · 岛的「识别库 / 透视 / 明细 / 设置」四个页 —— 都不是每日动作（主数据 / 分析 / 配置）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import type { OrderRecord, StyleRecord } from '@/types';
import { useShipping } from '../flowCtx';
import {
  PAGE_SIZE,
  listPending,
  listStyles,
  markCorrected,
  pendingCounts,
  readEngine,
  recognizeOrder,
  saveCorrection,
} from '../classify';

const { token, go, bump } = useShipping();

interface Draft {
  category: string;
  color: string;
  logo: string;
  /** 归属款 id；0 = 自动匹配（保持/重建当前归属） */
  styleId: number;
}

const loading = ref(false);
const busy = ref(false);
const error = ref('');
const search = ref('');
/** 已提交给主进程的关键字（与输入框里正在敲的 `search` 分开 —— 否则每次输入都会触发分页重置） */
const applied = ref('');
const page = ref(0);

const rows = ref<OrderRecord[]>([]);
const total = ref(0);
const styles = ref<StyleRecord[]>([]);
const counts = reactive({ pending: 0, unclassified: 0, styles: 0 });
const thumbs = ref<Record<string, string>>({});
const drafts = reactive<Record<number, Draft>>({});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
/** 库里到底有没有订单（区分"没有待核对"与"压根还没导入"两种空态） */
const hasOrders = computed(() => counts.unclassified > 0 || counts.pending > 0 || total.value > 0);
const emptyTitle = computed(() => {
  if (!hasOrders.value) return '还没有订单';
  if (applied.value) return '没有匹配的订单';
  return '全部订单都核对完了';
});
const emptyDesc = computed(() => {
  if (!hasOrders.value) {
    return '核对的对象是导入进来的订单行。先在第 1 步「导入订单」把平台导出的订单报表导进来。';
  }
  if (applied.value) return '换个关键字试试，或清空搜索框看全部待核对订单。';
  return '这里的每一行都点过「保存」或「确认无误」。新导入的订单会重新出现在这里。';
});

/** 当前订单归属款对应的款 id（无归属为 0） */
function currentStyleId(o: OrderRecord): number {
  return styles.value.find((s) => s.code === o.styleCode)?.id ?? 0;
}

/** 取（并按需建立）一行的草稿 —— 行是主进程给的只读快照，编辑态单独放，避免和"刷新"打架 */
function draftOf(o: OrderRecord): Draft {
  const id = Number(o.id ?? 0);
  const cur = drafts[id];
  if (cur) return cur;
  const d: Draft = {
    category: o.category ?? '',
    color: o.color ?? '',
    logo: o.logo ?? '',
    styleId: currentStyleId(o),
  };
  drafts[id] = d;
  return d;
}

/** 有改动才允许保存（"点保存但什么也没改"是噪音；也让脏值一眼看得出来） */
function isDirty(o: OrderRecord): boolean {
  const d = draftOf(o);
  return (
    d.category !== (o.category ?? '') ||
    d.color !== (o.color ?? '') ||
    d.logo !== (o.logo ?? '') ||
    d.styleId !== currentStyleId(o)
  );
}

/** 选款后清空品类/颜色输入里的"旧值干扰"不做：字段是字段，归属是归属，各改各的 */

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [pend, st, cnt] = await Promise.all([
      listPending({ offset: page.value * PAGE_SIZE, limit: PAGE_SIZE, search: applied.value }),
      listStyles(),
      pendingCounts(),
    ]);
    rows.value = pend.rows;
    total.value = pend.total;
    if (total.value > 0 && page.value > totalPages.value - 1) {
      // 删除/确认后当前页可能超出范围 —— 回退一页重取，别停在空白页
      page.value = totalPages.value - 1;
      loading.value = false;
      await load();
      return;
    }
    styles.value = st;
    counts.pending = cnt.pending;
    counts.unclassified = cnt.unclassified;
    counts.styles = cnt.styles;
    // 草稿按行重建：主进程回来的才是真值，旧的编辑态一律作废
    for (const k of Object.keys(drafts)) delete drafts[Number(k)];
    for (const o of rows.value) draftOf(o);
    await loadThumbs();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取待核对订单失败';
  } finally {
    loading.value = false;
  }
}

/** 缩略图合批一次往返（路径去重；`orderImageThumbBatch` 内部已按上限拆批） */
async function loadThumbs(): Promise<void> {
  const paths = [...new Set(rows.value.map((o) => String(o.localPath ?? '')).filter(Boolean))];
  thumbs.value = {};
  if (!paths.length) return;
  const t = await ipc.orderImageThumbBatch(paths.map((localPath) => ({ localPath, maxEdge: 96 })));
  if (!t.success) return;
  paths.forEach((p, i) => {
    const url = t.data?.dataUrls?.[i];
    if (url) thumbs.value[p] = url;
  });
}

function doSearch(): void {
  applied.value = search.value.trim();
  page.value = 0;
  void load();
}

function gotoPage(p: number): void {
  page.value = p;
  void load();
}

function reload(): void {
  void load();
}

async function saveOne(o: OrderRecord): Promise<void> {
  const d = draftOf(o);
  if (!isDirty(o)) return;
  busy.value = true;
  try {
    const fieldsChanged = d.category !== (o.category ?? '') || d.color !== (o.color ?? '');
    const r = await saveCorrection({
      id: Number(o.id ?? 0),
      category: d.category,
      color: d.color,
      logo: d.logo,
      features: Array.isArray(o.features) ? o.features : [],
      targetStyleId: d.styleId,
      fieldsChanged,
    });
    toast(r.styleCode ? `已保存，归属 ${r.styleCode}` : '已保存（未归到款）', 'success');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '保存失败', 'error');
  } finally {
    busy.value = false;
  }
}

async function confirmOne(o: OrderRecord): Promise<void> {
  busy.value = true;
  try {
    const n = await markCorrected([Number(o.id ?? 0)]);
    if (n) toast('已确认无误', 'success');
    else toast('订单不存在或已核对', 'info');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

async function confirmAll(): Promise<void> {
  busy.value = true;
  try {
    const n = await markCorrected({ all: true });
    toast(`已把 ${n} 条订单标记为已核对`, 'success');
    page.value = 0;
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ─────────────────────────────────────────────── 批量识别

const running = ref(false);
const stopFlag = ref(false);
const queue = ref<OrderRecord[]>([]);
const done = ref(0);
const progress = ref('');
/** 逐条失败原因（只留前几条显示 —— 几十条全铺出来会把页面顶掉） */
const failed = ref<string[]>([]);

function stop(): void {
  stopFlag.value = true;
}

/**
 * 批量识别**当前页里还没归类的**订单（有图的才在队列里）。
 *
 * 串行、失败不中断（与岛里的队列主循环同策略）：识图一次 20~60s，
 * 并行只会撞限流；而一条失败就整体停，用户要自己找断点。
 */
async function recognizeAll(): Promise<void> {
  error.value = '';
  progress.value = '';
  failed.value = [];
  const { engine, reason } = await readEngine();
  if (!engine) {
    error.value = reason;
    toast(reason, 'error');
    return;
  }
  const targets = rows.value.filter((o) => !o.styleCode && o.localPath);
  if (!targets.length) {
    toast('当前页没有"有图但还没归类"的订单', 'info');
    return;
  }
  queue.value = targets;
  done.value = 0;
  stopFlag.value = false;
  running.value = true;
  try {
    for (const o of targets) {
      if (stopFlag.value) break;
      progress.value = `识别中：${done.value + 1}/${targets.length}（订单 ${o.orderNo}）…`;
      try {
        const r = await recognizeOrder(o, engine);
        done.value += 1;
        progress.value = `已识别 ${done.value}/${targets.length}${r.styleCode ? ` · 归属 ${r.styleCode}` : ''}`;
      } catch (e: unknown) {
        failed.value.push(`${o.orderNo}：${e instanceof Error ? e.message : '识别失败'}`);
        done.value += 1;
      }
    }
  } finally {
    running.value = false;
    const stopped = stopFlag.value && done.value < targets.length;
    progress.value = stopped
      ? `已停止：识别 ${done.value}/${targets.length}`
      : `识别完成：${targets.length - failed.value.length}/${targets.length} 条归到款`;
    if (failed.value.length) {
      error.value = `${failed.value.length} 条没识别成功：${failed.value.slice(0, 3).join('；')}${
        failed.value.length > 3 ? ' …' : ''
      }`;
    }
    toast(progress.value, failed.value.length ? 'error' : 'success');
    bump();
  }
}

onMounted(() => void load());
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了订单）就重取本页
watch(
  () => token.value,
  () => void load()
);
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.cl-view {
  gap: 12px;
}
.cl-stats {
  flex-shrink: 0;
}
.cl-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.cl-search {
  width: 300px;
  max-width: 40vw;
}
.cl-grow {
  flex: 1;
}
/* 面板头右侧动作区（`.wb-panel__head` 是 flex，无"推右"工具类） */
.cl-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}
.cl-table {
  width: 100%;
}
.cl-cell {
  width: 100%;
  min-width: 76px;
}
.cl-thumb-col {
  width: 48px;
}
.cl-style-col {
  min-width: 180px;
}
/* 操作列：两个文字动作排一行，窄窗口下允许换行 */
.cl-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
</style>
