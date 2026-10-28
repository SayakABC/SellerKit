<template>
  <!-- 「基础数据 › 店名归一」—— 把历史自由文本里的店铺名归一到 `sk_shops` 实体。
       2026-10-08 从市场岛「店铺账号管家」收进内建（方案 R1 / UX-G6）；
       2026-10-14 随「基础数据」整合从「货与成本」页签搬来（左导航的一项，`MasterDataView` 渲染）；
       2026-10-22 店铺账号物理合并（SHOP_ACCOUNT_REDESIGN_PLAN.md §3.7）：**只留「还没登记的店铺名」队列**，
       已登记店铺表与编辑表单删掉 —— 店铺信息统一去「店铺」页看与改。

       为什么必须收进内建（原 D1 死锁）：待关联队列里"店铺未归一"的那几行**不能写映射**
       （订单里没有平台字段，硬塞会把两家店并到同一个键上），提示原文是"请先到「店铺账号管家」
       的「店铺登记」…" —— 而那个岛**不在默认包里**，全新安装侧边栏根本没有它。
       于是新手在这里遇到一个**两端都不可点**的死胡同：提示是纯文本、目的地不存在。
       收进内建 = 把"原始店名 → 规范店名"这件小事做在需要它的那一页上（它本来就只是一条旁挂映射）。

       三条界面纪律（岛时代被真实数据逼出来的，迁移时一条没放宽）：
         ① **不预选店铺**：指派的默认值必须是"未选择"。预选第一家店（按位置取默认）会把
            "读错了对象"伪装成"对象本身有问题" —— 用户点一下就静默把名字归到错误的店上。
         ② **不猜歧义**：只有恰好唯一命中一家店时才给「采纳」（主进程算的 autoShopId）；
            同名可以合法地存在于不同平台，此时必须让人来选。
         ③ **失败态不是死路**：加载失败要显示原因 + 重试，并保留上一次成功的数据可见。 -->
  <div class="gd-reg" data-act="registry-view">
    <div class="gd-reg__bar">
      <!-- 汇总 chips：店铺家数 + 两处历史文本的归一进度。
           `可一键采纳` / `映射过期` 两个只在非零时才渲染 —— "全零不是正确表达"（本仓既有结论）。 -->
      <div class="gd-reg__chips" data-act="reg-stats">
        <span class="gd-reg__chip">店铺 <b>{{ summary?.total ?? 0 }}</b> 家</span>
        <span class="gd-reg__chip">历史店名 <b>{{ names?.total ?? 0 }}</b> 条</span>
        <span class="gd-reg__chip">已归一 <b>{{ names?.mapped ?? 0 }}</b></span>
        <span class="gd-reg__chip" :class="{ 'is-warn': !!names?.unmapped }">
          未归一 <b>{{ names?.unmapped ?? 0 }}</b>
        </span>
        <span v-if="names?.ignored" class="gd-reg__chip">已忽略 <b>{{ names.ignored }}</b></span>
        <span v-if="names?.autoMatched" class="gd-reg__chip is-ok">
          可一键采纳 <b>{{ names.autoMatched }}</b>
        </span>
        <span v-if="names?.stale" class="gd-reg__chip is-warn">映射过期 <b>{{ names.stale }}</b></span>
      </div>
      <div class="gd-reg__acts">
        <button class="wb-btn" type="button" data-act="reg-refresh" :disabled="loading" @click="load">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
        <button class="wb-btn wb-btn--primary" type="button" data-act="reg-new" :disabled="busy" @click="openCreate">
          新建店铺
        </button>
      </div>
    </div>

    <!-- 失败态：给原因 + 重试，**不清掉**上一次成功的内容（清空会让人以为数据没了） -->
    <p v-if="loadError" class="wb-notice wb-notice--error" data-act="reg-error">
      {{ loadError }}
      <button class="wb-link" type="button" @click="load">重试</button>
    </p>

    <!-- ── 未归一名单（本页唯一的主内容）────────────────────────── -->
    <section class="wb-panel gd-reg__panel">
      <div class="wb-panel__head">
        <span>还没登记的店铺名</span>
        <span class="wb-muted">订单 / 采购两处的历史文本实时汇总（不是缓存名单）</span>
      </div>
      <div class="wb-panel__body">
        <p v-if="loading && !unmappedRows.length" class="wb-muted gd-reg__pad">正在读取…</p>
        <div v-else-if="!unmappedRows.length" class="wb-empty gd-reg__pad" data-act="reg-unmapped-none">
          <p class="wb-empty__title">没有待登记的店铺名</p>
          <p class="wb-empty__desc">
            导入订单、采购对账或利润数据后，这里会自动列出它们用过的店铺名 —— 同一家店在不同文件里
            写法不一致时，也一并列出来让你认。已登记的店铺统一去「店铺」页查看与编辑。
          </p>
        </div>
        <table v-else class="wb-table gd-reg__tbl" data-act="reg-unmapped-table">
          <thead>
            <tr>
              <th>名称（原文）</th>
              <th class="gd-reg__num">出现次数</th>
              <th>来源</th>
              <th class="gd-reg__ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in unmappedRows" :key="r.key" :data-shop-key="r.key">
              <td>
                <span class="wb-mono">{{ r.raw }}</span>
                <span v-if="r.raw !== r.key" class="wb-muted gd-reg__keyhint" title="归一后的匹配键">
                  → {{ r.key }}
                </span>
              </td>
              <td class="gd-reg__num">{{ r.occurrences }}</td>
              <td>
                <span v-for="s in r.sources" :key="s" class="gd-reg__src">{{ s }}</span>
              </td>
              <td class="gd-reg__ops">
                <div class="gd-reg__rowacts">
                  <!-- 只在**恰好唯一命中**一家店时出现：同名店铺可以存在于不同平台，
                       歧义时主进程恒给 0，那时不该有"一键采纳"这种话术 -->
                  <button
                    v-if="r.autoShopId"
                    class="wb-btn wb-btn--sm wb-btn--primary"
                    type="button"
                    data-act="reg-take"
                    :disabled="busy"
                    :title="`精确命中唯一一家店铺（${r.autoShopPlatform || '未填平台'}）`"
                    @click="doMap(r.key, r.autoShopId)"
                  >
                    采纳：{{ r.autoShopName }}
                  </button>

                  <!-- ⚠️ 默认值恒为空串（不预选）—— 见文件头纪律 ① -->
                  <select
                    v-model="pick[r.key]"
                    class="wb-input wb-input--sm gd-reg__sel"
                    :disabled="busy"
                    :aria-label="`把 ${r.raw} 指派到店铺`"
                  >
                    <option value="">— 选择店铺 —</option>
                    <option v-for="s in shops" :key="s.id" :value="String(s.id)">
                      {{ s.name }}
                    </option>
                  </select>
                  <button
                    class="wb-btn wb-btn--sm"
                    type="button"
                    data-act="reg-assign"
                    :disabled="busy || !canAssign(r.key)"
                    @click="doMap(r.key, Number(pick[r.key]))"
                  >
                    指派
                  </button>

                  <!-- 创建一行（店名 = 原文）+ 写映射，然后直接打开合并编辑器补账号信息
                       （方案 §3.7：不再要求用户去另一个页签重复操作） -->
                  <button
                    class="wb-btn wb-btn--sm"
                    type="button"
                    data-act="reg-create-bind"
                    :disabled="busy"
                    @click="startCreate(r.key)"
                  >
                    新建店铺并关联
                  </button>
                  <button
                    class="wb-link gd-reg__ignore"
                    type="button"
                    data-act="reg-ignore"
                    :disabled="busy"
                    title="不是店铺（如平台名、占位符）时用；可撤销，记录会保留"
                    @click="doMap(r.key, 0, true)"
                  >
                    忽略
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 过期映射（只在非零时出现）────────────────────────────────
         ⚠️ 这里**刻意不给"清理"按钮**：能清理的只有映射记录，而主进程没有任何通道能**枚举**
         过期映射的原始键（`shop-summary` 只给个数，`shop-unmapped` 排除已归一的）。
         岛时代的原文写着"可在店铺行里用「撤销归一」逐条清理" —— 那个按钮**从来没有渲染过**，
         是一句把人指向空处的提示（本仓既有结论「提示不是入口」）。所以这里只如实说明
         "它们不影响任何计算"，不承诺一个做不到的动作。 -->
    <section v-if="names?.stale" class="wb-panel gd-reg__panel" data-act="reg-stale">
      <div class="wb-panel__head">
        <span>历史里找不到的归一记录（{{ names.stale }}）</span>
      </div>
      <div class="wb-panel__body gd-reg__pad">
        <p class="wb-muted">
          这些归一记录指向的店铺还在，但它们对应的原始店名已经不出现在订单 / 采购 / 利润任何一处文本里
          （订单被删掉或重新导入过）。它们不参与任何计算，也不会把账算错 —— 留在名单上只是多几条记录；
          对应写法再出现时，归一会自动重新生效。
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
// 2026-10-22 物理合并收口：本页只留「未归一名单」。已登记店铺表 + 店铺编辑表单删除，
// 店铺信息统一去「店铺」页（合并列表 + 合并编辑器）。「新建店铺」与「新建店铺并关联」
// 都走合并编辑器 / 合并行创建，不再经过 shop 域的全量 upsert。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { shopAccountUpsert } from '@/core/services/ipc';
// ⚠️ 取数仍走 goods 域的 shopApi（sk_shops / sk_name_map 的 shop 侧读写没动）；
//    新建店铺行走账号域 upsert（同一行的两种入口，数据落在同一张表）。
import * as shopApi from '@/modules/goods/shopApi';
import { useShopAccountsStore } from '../store';
import type { ShopListItem, UnmappedShopRow } from '@/types';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（与左栏 `useProductList` / 右栏 `useSkuPool` 同一条管线） */
  refreshNonce?: number;
}>();

const store = useShopAccountsStore();

const loading = ref(true);
const busy = ref(false);
/** 上一次加载失败的原因（有值时顶部显示原因 + 重试，而不是一张空表） */
const loadError = ref('');

/** 指派候选（店铺全集，仅渲染下拉用；本页不再展示店铺表） */
const shops = ref<ShopListItem[]>([]);
const unmappedRows = ref<UnmappedShopRow[]>([]);
const summary = ref<Awaited<ReturnType<typeof shopApi.summary>> | null>(null);

/** 每个未归一名称的「指派到已有店铺」选择值：key → shopId 字符串。**恒以空串起始，不预选** */
const pick = reactive<Record<string, string>>({});

const names = computed(() => summary.value?.names ?? null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    await shopApi.ensure();
    const [listRes, unmappedRes, summaryRes] = await Promise.all([
      shopApi.list({ limit: 500 }),
      shopApi.unmapped(),
      shopApi.summary(),
    ]);
    shops.value = listRes?.rows ?? [];
    unmappedRows.value = unmappedRes ?? [];
    summary.value = summaryRes ?? null;
    // 清掉已不在名单里的残留选择 —— 否则下拉里会留着幽灵 key（对象长得像还在）
    const live = new Set(unmappedRows.value.map((r) => r.key));
    for (const k of Object.keys(pick)) if (!live.has(k)) delete pick[k];
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function canAssign(key: string): boolean {
  return Number(pick[key]) > 0;
}

/** 指派 / 采纳 / 忽略三处**同一条写路径**（岛时代就是如此，迁移时没拆） */
async function doMap(key: string, refId: number, ignored = false): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await shopApi.map({ raw: key, refId, ignored });
    toast(ignored ? '已标记忽略（可撤销）' : '已归一', 'success');
    await load();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
  }
}

/** 右上角「新建店铺」：直接开合并编辑器（店铺信息 + 账号一个表单维护） */
function openCreate(): void {
  store.openCreate();
}

/**
 * 「新建店铺并关联」：创建一行（店名 = 原文、平台默认速卖通）+ 写名称映射，
 * 然后直接打开合并编辑器补账号信息 —— 用户不用再去别的页签重复操作（方案 §3.7）。
 */
async function startCreate(key: string): Promise<void> {
  if (busy.value) return;
  const row = unmappedRows.value.find((r) => r.key === key);
  const name = (row?.raw || key).trim();
  if (!name) return;
  busy.value = true;
  try {
    // 显式 `name: name`（守卫只认命名字段，简写会被跳过——见 check-shop-upsert-fields）
    const res = await shopAccountUpsert({ name: name });
    if (!res.success || !res.data) throw new Error(res.error || '创建店铺失败');
    try {
      await shopApi.map({ raw: key, refId: res.data.id, ignored: false });
    } catch (e: unknown) {
      // 店已建、映射失败：把店留着并打开编辑器，提示用户稍后手动指派
      toast(
        `店铺已建，但归一失败：${e instanceof Error ? e.message : '未知错误'}（可在此页手动指派）`,
        'error',
      );
    }
    toast('已新建店铺并关联，接着补齐账号信息', 'success');
    await load();
    store.openEdit(res.data.id);
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
watch(() => props.refreshNonce, () => void load());
</script>

<style scoped>
.gd-reg {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gd-reg__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-reg__chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.gd-reg__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.gd-reg__chip b {
  color: var(--wb-text);
}
.gd-reg__chip.is-warn {
  border-color: var(--wb-warning);
}
.gd-reg__chip.is-ok {
  border-color: var(--wb-primary);
}
.gd-reg__acts {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

/* 用 .wb-panel（画布上的白卡），去掉最小高度让内容决定高度。 */
.gd-reg__panel {
  flex: none;
}
.gd-reg__pad {
  padding: 10px 0;
  margin: 0;
}
.gd-reg__tbl {
  table-layout: auto;
}
/* ⚠️ `.wb-table td` 全局是 `nowrap`。两处必须放开换行，否则**行内动作**那一格的最小内容宽
   就等于"几个按钮 + 一个下拉并排摊平"的宽度 —— 在窄一点的窗口下整张表比容器还宽，
   而 `.wb-panel` 是 `overflow: hidden` ⇒ 右半截（含「采纳」）被**静默裁掉**：
   DOM 里一个元素都不少，只有用户点不到（本仓 2026-10-08 B4 的同一形状）。 */
.gd-reg__tbl td:first-child,
.gd-reg__ops {
  white-space: normal;
}
.gd-reg__num {
  width: 88px;
  text-align: right;
  white-space: nowrap;
}
.gd-reg__ops-col {
  width: 340px;
  text-align: right;
}
.gd-reg__rowacts {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.gd-reg__sel {
  width: auto;
  min-width: 140px;
  max-width: 220px;
}
.gd-reg__ignore {
  font-size: 12px;
}
.gd-reg__src {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 6px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  color: var(--wb-text-muted);
  font-size: 11px;
}
.gd-reg__keyhint {
  margin-left: 6px;
  font-size: 11.5px;
}
</style>
