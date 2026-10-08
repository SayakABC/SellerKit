<template>
  <!-- 「货与成本 › 店铺登记」—— 把历史自由文本里的店铺名归一到 `sk_shops` 实体。
       2026-10-08 从市场岛「店铺账号管家」收进内建（方案 R1 / UX-G6）。

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
      <!-- 汇总 chips：店铺家数 + 三处历史文本的归一进度。
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
        <button class="wb-btn wb-btn--primary" type="button" data-act="reg-new" :disabled="busy" @click="startNew">
          新建店铺
        </button>
      </div>
    </div>

    <!-- 失败态：给原因 + 重试，**不清掉**上一次成功的内容（清空会让人以为数据没了） -->
    <p v-if="loadError" class="wb-notice wb-notice--error" data-act="reg-error">
      {{ loadError }}
      <button class="wb-link" type="button" @click="load">重试</button>
    </p>

    <!-- ── 未归一名单 ────────────────────────────────────────────── -->
    <section class="wb-panel gd-reg__panel">
      <div class="wb-panel__head">
        <span>还没登记的店铺名</span>
        <span class="wb-muted">订单 / 采购 / 利润三处的历史文本实时汇总（不是缓存名单）</span>
      </div>
      <div class="wb-panel__body">
        <p v-if="loading && !unmappedRows.length" class="wb-muted gd-reg__pad">正在读取…</p>
        <div v-else-if="!unmappedRows.length" class="wb-empty gd-reg__pad" data-act="reg-unmapped-none">
          <p class="wb-empty__title">没有待登记的店铺名</p>
          <p class="wb-empty__desc">
            导入订单、采购对账或利润数据后，这里会自动列出它们用过的店铺名 —— 同一家店在不同文件里
            写法不一致时，也一并列出来让你认。
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
                      {{ s.platform ? `[${s.platform}] ` : '' }}{{ s.name }}
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

                  <button
                    class="wb-btn wb-btn--sm"
                    type="button"
                    data-act="reg-create-bind"
                    :disabled="busy"
                    @click="startCreate(r.key)"
                  >
                    新建店铺并绑定
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

    <!-- ── 店铺实体 ──────────────────────────────────────────────── -->
    <section class="wb-panel gd-reg__panel">
      <div class="wb-panel__head">
        <span>已登记的店铺（{{ shops.length }}）</span>
        <span class="wb-muted">「已归一店名」= 有多少种历史写法被认到了这家店</span>
      </div>
      <div class="wb-panel__body">
        <div v-if="!loading && !shops.length" class="wb-empty gd-reg__pad" data-act="reg-shops-none">
          <p class="wb-empty__title">还没有登记任何店铺</p>
          <p class="wb-empty__desc">
            两家来源：① 上面名单里的店，点「新建店铺并绑定」（建完顺手把那个写法认上去）；
            ② 右上角「新建店铺」直接建一家。
          </p>
        </div>
        <table v-else class="wb-table gd-reg__tbl" data-act="reg-shop-table">
          <thead>
            <tr>
              <th>平台</th>
              <th>店铺名</th>
              <th>站点</th>
              <th>状态</th>
              <th class="gd-reg__num">已归一店名</th>
              <th class="gd-reg__ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shops" :key="s.id" :data-shop-id="s.id">
              <td>{{ s.platform || '—' }}</td>
              <td>
                <span>{{ s.name }}</span>
                <span v-if="s.platformShopId" class="wb-muted gd-reg__keyhint">{{ s.platformShopId }}</span>
              </td>
              <td>{{ s.site || '—' }}</td>
              <td>
                <span class="wb-tag" :class="{ 'is-warn': s.status !== 'active' }">
                  {{ s.status === 'active' ? '在营' : '停用' }}
                </span>
              </td>
              <td class="gd-reg__num">{{ s.aliasCount }}</td>
              <td class="gd-reg__ops">
                <button class="wb-link" type="button" data-act="reg-edit" :disabled="busy" @click="startEdit(s)">
                  编辑
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 过期映射（只在非零时出现）────────────────────────────────
         ⚠️ 这里**刻意不给"清理"按钮**：能清理的只有映射记录，而主进程没有任何通道能**枚举**
         过期映射的原始键（`shop-summary` 只给个数，`shop-unmapped` 排除已归一的）。
         岛时代的原文写着"可在店铺行里用「撤销归一」逐条清理" —— 那个按钮**从来没有渲染过**
         （`doUnmap` 在岛里定义了却没人调），是一句把人指向空处的提示（本仓既有结论
         「提示不是入口」）。所以这里只如实说明"它们不影响任何计算"，不承诺一个做不到的动作。 -->
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

    <!-- 店铺编辑 / 新建 -->
    <div v-if="form.open" class="wb-mask" @click.self="closeForm">
      <aside class="wb-drawer" role="dialog" aria-modal="true" aria-label="店铺登记">
        <div class="wb-dialog__head">
          <span>{{ form.id ? '编辑店铺' : '新建店铺' }}</span>
          <button class="gd-reg__x" type="button" aria-label="关闭" @click="closeForm">✕</button>
        </div>

        <div class="wb-dialog__body gd-reg__form">
          <p v-if="creatingFor" class="wb-notice" data-act="reg-bind-hint">
            保存后会自动把「<b class="wb-mono">{{ creatingFor }}</b>」这个历史店名归一到新店铺。
          </p>

          <label class="wb-field">
            <span class="wb-field__label">店铺名 <i class="wb-field__req">*</i></span>
            <input
              v-model="form.name"
              class="wb-input"
              type="text"
              maxlength="200"
              placeholder="与平台上一致的名字"
              data-act="reg-name"
            />
            <span class="wb-field__hint">
              前后空白、全角空格与零宽字符会被自动忽略 —— 不会因为多打一个空格就变成两家店。
            </span>
          </label>

          <label class="wb-field">
            <span class="wb-field__label">平台 <i class="wb-field__req">*</i></span>
            <select v-model="form.platform" class="wb-input" data-act="reg-platform">
              <option value="">— 请选择 —</option>
              <option v-for="p in PLATFORM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
            <span class="wb-field__hint">
              历史数据里**没有**平台字段，所以无法替你猜 —— 同名店铺可以同时存在于不同平台，
              猜错会把两家店并成一家。
            </span>
          </label>

          <label class="wb-field">
            <span class="wb-field__label">店铺标识</span>
            <input
              v-model="form.platformShopId"
              class="wb-input"
              type="text"
              maxlength="100"
              placeholder="平台店铺ID（可选，如 Shop1105228632）"
              data-act="reg-platform-shop-id"
            />
            <span class="wb-field__hint">
              稳定业务键：店铺改名后标识不变、历史关联不断链；同一平台内不可重复，留空不参与校验。
            </span>
          </label>

          <div class="gd-reg__row">
            <label class="wb-field">
              <span class="wb-field__label">站点</span>
              <input v-model="form.site" class="wb-input" type="text" maxlength="40" placeholder="如 RU / US" />
            </label>
            <label class="wb-field">
              <span class="wb-field__label">状态</span>
              <select v-model="form.status" class="wb-input">
                <option value="active">在营</option>
                <option value="archived">停用</option>
              </select>
            </label>
          </div>

          <label class="wb-field">
            <span class="wb-field__label">开店时间</span>
            <input
              v-model="form.openedAt"
              class="wb-input"
              type="text"
              maxlength="40"
              placeholder="如 2024-03-01（可留空）"
            />
          </label>

          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <textarea v-model="form.note" class="wb-input" rows="3" maxlength="2000"></textarea>
          </label>

          <!-- 账号套装的关联**不在这里改**（但保存时会原样送回去）：
               ① 它是「店铺账号管家」岛的字段（`sk_shop_sets`），宿主其它页面一处都不读；
               ② `shopUpsert` 是**全量提交** —— 界面若不透传，编辑一次就把已登记的套装关联静默清空。
               所以：字段留在表单里透传，但不在这一页给人一个"看不懂又删不掉"的下拉。 -->
          <p class="wb-field__hint gd-reg__note">
            账号套装的关联在「店铺账号管家」里维护（装了才有）；这里编辑店铺不会动它。
          </p>
        </div>

        <div class="wb-dialog__foot">
          <!-- 保存被禁用时**必须**在同一行说明原因（"灰按钮 + 无原因"会逼用户点 ✕ 静默丢弃） -->
          <span v-if="formBlocked" class="wb-muted gd-reg__blocked" data-act="reg-blocked">
            {{ formBlocked }}
          </span>
          <button class="wb-btn" type="button" :disabled="busy" data-act="reg-cancel" @click="closeForm">
            取消
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="reg-save"
            :disabled="busy || !!formBlocked"
            @click="submitForm"
          >
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
// 逻辑与岛的 `ShopRegistryView.vue` 对应到行（便于比对），三处改动都记在这里：
//   ① 取数改走 `./shopApi`（内建的同进程信任域，不再过 `window.__sk` 桥）；
//   ② 账号套装那一列**不再渲染**，但表单里保留字段做**透传**（全量提交会清空它）；
//   ③ 过期映射段的文案不再承诺「撤销归一」按钮（它从来没渲染过，见模板里那段注释）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { SHOP_PLATFORM_OPTIONS as PLATFORM_OPTIONS } from '../shopApi';
import * as shopApi from '../shopApi';
import type { ShopListItem, UnmappedShopRow } from '@/types';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（与左栏 `useProductList` / 右栏 `useSkuPool` 同一条管线） */
  refreshNonce?: number;
}>();

const loading = ref(true);
const busy = ref(false);
/** 上一次加载失败的原因（有值时顶部显示原因 + 重试，而不是一张空表） */
const loadError = ref('');

const shops = ref<ShopListItem[]>([]);
const unmappedRows = ref<UnmappedShopRow[]>([]);
const summary = ref<Awaited<ReturnType<typeof shopApi.summary>> | null>(null);

/** 每个未归一名称的「指派到已有店铺」选择值：key → shopId 字符串。**恒以空串起始，不预选** */
const pick = reactive<Record<string, string>>({});
/** 「新建店铺并绑定」：正在为哪个 key 建店（'' = 不是从名单进来的） */
const creatingFor = ref('');

const names = computed(() => summary.value?.names ?? null);

/** 店铺编辑表单（id=0 为新增）。⚠️ **全量提交**：不透传 = 编辑一次静默清空 */
const form = reactive({
  open: false,
  id: 0,
  platform: '',
  name: '',
  platformShopId: '',
  site: '',
  shopSetId: 0,
  status: 'active',
  openedAt: '',
  note: '',
});

/**
 * 保存被拦下的原因（'' = 可以保存）。
 * 渲染在「保存」**同一行**：岛时代是提交后才 toast 一句，用户看到的是一个灰按钮 + 没有任何解释
 * （本仓 W1："灰按钮无灰因 → 点 ✕ 静默丢弃"）。校验判据本身与岛逐字一致。
 */
const formBlocked = computed(() => {
  if (!form.name.trim()) return '店铺名不能为空';
  if (form.id === 0 && !form.platform) return '请选择平台（历史数据里没有平台字段，必须由人指定）';
  return '';
});

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

/** 打开「新建店铺」并把待归一的原文预填进名称（平台仍需人指定） */
function startCreate(key: string): void {
  startNew();
  creatingFor.value = key;
  const row = unmappedRows.value.find((r) => r.key === key);
  form.name = row?.raw || key;
}

function startEdit(row: ShopListItem): void {
  creatingFor.value = '';
  form.open = true;
  form.id = row.id;
  form.platform = row.platform;
  form.name = row.name;
  form.platformShopId = row.platformShopId ?? '';
  form.site = row.site;
  form.shopSetId = row.shopSetId;
  form.status = row.status;
  form.openedAt = row.openedAt;
  form.note = row.note;
}

function startNew(): void {
  creatingFor.value = '';
  form.open = true;
  form.id = 0;
  form.platform = '';
  form.name = '';
  form.platformShopId = '';
  form.site = '';
  form.shopSetId = 0;
  form.status = 'active';
  form.openedAt = '';
  form.note = '';
}

function closeForm(): void {
  form.open = false;
  creatingFor.value = '';
}

async function submitForm(): Promise<void> {
  if (busy.value || formBlocked.value) return;
  busy.value = true;
  try {
    const res = await shopApi.upsert({
      id: form.id,
      platform: form.platform,
      name: form.name,
      platformShopId: form.platformShopId,
      site: form.site,
      shopSetId: form.shopSetId,
      status: form.status,
      openedAt: form.openedAt,
      note: form.note,
    });
    const newId = res?.id ?? 0;
    toast(form.id ? '已更新' : '已新建店铺', 'success');
    // 从「未归一 → 新建店铺并绑定」进来的：顺手把这条名称绑上去。
    // 少一步操作，且不会绑错 —— 用的就是刚建出来的那个 id。
    const bindKey = creatingFor.value;
    if (bindKey && newId) {
      try {
        await shopApi.map({ raw: bindKey, refId: newId, ignored: false });
      } catch (e: unknown) {
        toast(`店铺已建，但归一失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
      }
    }
    closeForm();
    await load();
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

/* 两段都用 .wb-panel（画布上的白卡）。这里只去掉最小高度，让内容决定高度 ——
   「未归一名单」可能只有一行，撑到半个屏幕会把下面那张表推出视野。 */
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
.gd-reg__note {
  margin: 0;
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

.gd-reg__x {
  margin-left: auto;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 14px;
  cursor: pointer;
}
.gd-reg__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gd-reg__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.gd-reg__blocked {
  margin-right: auto;
  font-size: 12px;
}
</style>
