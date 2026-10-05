<script setup>
// src/components/ShopRegistryView.vue
// 店铺登记（DOMAIN_INTEGRATION_PLAN S1）—— 把历史自由文本里的店铺名归一到 `sk_shops` 实体。
//
// 背景（该计划 D1/D2）：店铺实体原先**根本不存在**，店名以自由文本各存三处且互相拷贝
// （`oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name`）。本页补实体层，
// **不改写任何历史文本**（G2）：归一是一条旁挂映射（`sk_name_map`），随时可撤销。
//
// 三条界面纪律（都是被真实数据逼出来的）：
//   1. **不预选店铺**：指派的默认值必须是"未选择"。预选第一家店（按位置取默认）会把
//      "读错了对象"伪装成"对象本身有问题" —— 用户点一下就静默把名字归到错误的店上。
//   2. **不猜歧义**：只有恰好唯一命中一家店时才给「采纳」按钮（宿主算的 autoShopId）；
//      同名可以合法地存在于不同平台，此时必须让人来选。
//   3. **失败态不是死路**：加载失败要显示原因 + 重试，并保留上一次成功的数据可见。

import { computed, onMounted, reactive, ref } from 'vue';
import { toast } from '@/core/services/toast';
import { SHOP_PLATFORM_OPTIONS as PLATFORM_OPTIONS } from '../store';
import {
  shopAccountList,
  shopDbEnsure,
  shopList,
  shopMap,
  shopSummary,
  shopUnmapped,
  shopUpsert,
  shopUnmap,
} from '../api.js';
import IconGlyph from './IconGlyph.vue';

const loading = ref(true);
const busy = ref(false);
/** 上一次加载失败的原因（有值时界面顶部显示重试，而不是空白的表格） */
const loadError = ref('');

const rows = ref([]); // 店铺列表
const unmapped = ref([]); // 未归一名单
const summary = ref(null);
const accounts = ref([]); // 账号套装下拉（label 用 email）

/** 每个未归一名称的「指派到已有店铺」选择值：key → shopId（**恒以空串起始，不预选**） */
const pick = reactive({});
/** 「新建店铺并绑定」表单：正在为哪个 key 建店（'' = 未打开） */
const creatingFor = ref('');
/** 归一指派的备注（可选） */
const mapNote = ref('');

/** 店铺编辑表单（id=0 为新增） */
const form = reactive({
  open: false,
  id: 0,
  platform: 'ae',
  name: '',
  // 平台店铺ID（可空）。⚠️ upsert 是**全量提交**：这里不透传，编辑一次就会把已登记的标识静默清空
  platformShopId: '',
  site: '',
  shopSetId: 0,
  status: 'active',
  openedAt: '',
  note: '',
});

const label = (it) => it?.email || it?.company || (it?.id ? `账号套装 #${it.id}` : '');

const stats = computed(() => summary.value?.names ?? null);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    await shopDbEnsure();
    const [listRes, unmappedRes, summaryRes] = await Promise.all([
      shopList({ limit: 500 }),
      shopUnmapped(),
      shopSummary(),
    ]);
    if (!listRes.success) throw new Error(listRes.error || '读取店铺列表失败');
    if (!unmappedRes.success) throw new Error(unmappedRes.error || '读取未归一名单失败');
    if (!summaryRes.success) throw new Error(summaryRes.error || '读取汇总失败');
    rows.value = listRes.data?.rows ?? [];
    unmapped.value = unmappedRes.data ?? [];
    summary.value = summaryRes.data ?? null;
    // 清理已不在名单里的残留选择，避免下拉里留着幽灵 key
    const live = new Set(unmapped.value.map((r) => r.key));
    for (const k of Object.keys(pick)) if (!live.has(k)) delete pick[k];
    // 账号套装下拉失败不影响主流程（可留空 = 未关联）
    // ⚠️ 两个域的 `list` 返回形状不同：`shop` 域是 `{ rows, total }`，
    //    `shop-accounts` 域是**裸数组**（本岛 store.ts 的 refresh() 就按数组用的）。
    //    这里此前写成 `acc.data?.rows ?? []`，对数组取 .rows 恒为 undefined → 下拉永远只有「未关联」。
    const acc = await shopAccountList({ limit: 500 });
    const accData = acc.success ? acc.data : null;
    accounts.value = Array.isArray(accData) ? accData : (accData?.rows ?? []);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 只在用户显式选了店铺时才允许指派 */
function canAssign(key) {
  return Number(pick[key]) > 0;
}

async function doMap(key, refId, ignored = false) {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await shopMap({ raw: key, refId, ignored, note: mapNote.value });
    if (!res.success) throw new Error(res.error || '操作失败');
    toast.success(ignored ? '已标记忽略（可撤销）' : '已归一');
    mapNote.value = '';
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function doUnmap(key) {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await shopUnmap({ raw: key });
    if (!res.success) throw new Error(res.error || '撤销失败');
    if (!res.data?.removed) toast.info('没有可撤销的归一记录');
    else toast.success('已撤销归一');
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

/** 打开「新建店铺」表单，并把待归一的原文预填进名称（平台仍需人指定） */
function startCreate(key) {
  startNew();
  creatingFor.value = key;
  const row = unmapped.value.find((r) => r.key === key);
  form.name = row?.raw || key;
}

function startEdit(row) {
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

/** 新建店铺（不绑定任何历史名称） */
function startNew() {
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

function closeForm() {
  form.open = false;
  creatingFor.value = '';
}

async function submitForm() {
  if (busy.value) return;
  if (!form.name.trim()) {
    toast.error('店铺名称不能为空');
    return;
  }
  if (form.id === 0 && !form.platform) {
    toast.error('请选择平台（历史数据里没有平台信息，必须手动指定）');
    return;
  }
  busy.value = true;
  try {
    const res = await shopUpsert({
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
    if (!res.success) throw new Error(res.error || '保存失败');
    const newId = res.data?.id ?? 0;
    toast.success(form.id ? '已更新' : '已新建店铺');
    // 从「未归一 → 新建店铺」进来的，顺手把这条名称绑上去（少一步操作，且不会绑错：用的就是新建的 id）
    const bindKey = creatingFor.value;
    if (bindKey && newId) {
      const m = await shopMap({ raw: bindKey, refId: newId, ignored: false });
      if (!m.success) toast.error(`店铺已建，但归一失败：${m.error || '未知错误'}`);
    }
    closeForm();
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="registry">
    <header class="reg-head">
      <div class="reg-title">
        <h3>店铺登记</h3>
        <p class="reg-sub">
          把订单 / 采购 / 利润三处历史文本里的店铺名，归一到「店铺」实体。历史文本不会被改写，归一只是一条可撤销的映射。
        </p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load">
        <IconGlyph name="refresh" :size="14" />
        <span>{{ loading ? '读取中…' : '刷新' }}</span>
      </button>
    </header>

    <div v-if="stats" class="chips">
      <span class="chip">店铺 <b>{{ summary?.total ?? 0 }}</b> 家</span>
      <span class="chip">历史名称 <b>{{ stats.total }}</b> 条</span>
      <span class="chip ok">已归一 <b>{{ stats.mapped }}</b></span>
      <span class="chip warn">未归一 <b>{{ stats.unmapped }}</b></span>
      <span class="chip">已忽略 <b>{{ stats.ignored }}</b></span>
      <span v-if="stats.autoMatched" class="chip ok">可一键采纳 <b>{{ stats.autoMatched }}</b></span>
      <span v-if="stats.stale" class="chip warn" title="映射指向店铺，但该名称已不在历史文本里（订单被删或重导过）">
        映射过期 <b>{{ stats.stale }}</b>
      </span>
    </div>

    <div v-if="loadError" class="error-bar">
      <IconGlyph name="alert" :size="14" />
      <span>{{ loadError }}</span>
      <button class="btn btn-sm" type="button" @click="load">重试</button>
    </div>

    <!-- 未归一名单 -->
    <section class="panel">
      <div class="panel-head">
        <h4>未归一的店铺名</h4>
        <span class="muted">来自三处历史文本的实时汇总（不是缓存名单）</span>
      </div>

      <p v-if="loading" class="empty">正在读取…</p>
      <p v-else-if="!unmapped.length" class="empty">
        没有待归一的名称。导入订单、采购对账或利润数据后，这里会自动列出它们用过的店铺名。
      </p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th>名称（原文）</th>
            <th class="num">出现次数</th>
            <th>来源</th>
            <th class="act">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in unmapped" :key="r.key">
            <td>
              <code class="key">{{ r.raw }}</code>
              <span v-if="r.raw !== r.key" class="key-hint" title="归一后的匹配键">→ {{ r.key }}</span>
            </td>
            <td class="num">{{ r.occurrences }}</td>
            <td>
              <span v-for="s in r.sources" :key="s" class="src">{{ s }}</span>
            </td>
            <td class="act">
              <div class="row-actions">
                <button
                  v-if="r.autoShopId"
                  class="btn btn-sm primary"
                  type="button"
                  :disabled="busy"
                  :title="`精确命中唯一一家店铺（${r.autoShopPlatform || '未填平台'}）`"
                  @click="doMap(r.key, r.autoShopId)"
                >
                  采纳：{{ r.autoShopName }}
                </button>

                <select v-model="pick[r.key]" class="sel" :disabled="busy">
                  <option value="">— 选择店铺 —</option>
                  <option v-for="s in rows" :key="s.id" :value="s.id">
                    {{ s.platform ? `[${s.platform}] ` : '' }}{{ s.name }}
                  </option>
                </select>
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="busy || !canAssign(r.key)"
                  @click="doMap(r.key, Number(pick[r.key]))"
                >
                  指派
                </button>

                <button class="btn btn-sm" type="button" :disabled="busy" @click="startCreate(r.key)">
                  新建店铺并绑定
                </button>
                <button class="btn btn-sm ghost" type="button" :disabled="busy" @click="doMap(r.key, 0, true)">
                  忽略
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 店铺表 -->
    <section class="panel">
      <div class="panel-head">
        <h4>店铺实体（{{ rows.length }}）</h4>
        <button class="btn btn-sm primary" type="button" :disabled="busy" @click="startNew">
          <IconGlyph name="plus" :size="13" />
          <span>新建店铺</span>
        </button>
      </div>

      <p v-if="!loading && !rows.length" class="empty">
        还没有登记任何店铺。可以先在左侧名单里用「新建店铺并绑定」，或直接点右上角「新建店铺」。
      </p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th>平台</th>
            <th>店铺名</th>
            <th>站点</th>
            <th>账号套装</th>
            <th>状态</th>
            <th class="num">已归一名称</th>
            <th class="act">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in rows" :key="s.id">
            <td>{{ s.platform || '—' }}</td>
            <td>{{ s.name }}</td>
            <td>{{ s.site || '—' }}</td>
            <td>{{ label(accounts.find((a) => a.id === s.shopSetId)) || '—' }}</td>
            <td>
              <span class="chip" :class="{ warn: s.status !== 'active' }">
                {{ s.status === 'active' ? '在营' : '停用' }}
              </span>
            </td>
            <td class="num">{{ s.aliasCount }}</td>
            <td class="act">
              <button class="btn btn-sm" type="button" :disabled="busy" @click="startEdit(s)">编辑</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 汇总里的过期映射：给出可操作的说明，而不是只显示一个数字 -->
    <section v-if="stats?.stale" class="panel">
      <div class="panel-head">
        <h4>过期映射（{{ stats.stale }}）</h4>
      </div>
      <p class="muted">
        这些归一记录指向的店铺还在，但对应的名称已经不出现在任何历史文本里（订单被删除或重新导入过）。
        它们不影响任何计算，留着也不会把账算错；确认无用后可在店铺行里用「撤销归一」逐条清理。
      </p>
    </section>

    <!-- 店铺编辑 / 新建 -->
    <div v-if="form.open" class="drawer-mask" @click.self="closeForm">
      <div class="drawer">
        <header class="drawer-head">
          <h4>{{ form.id ? '编辑店铺' : '新建店铺' }}</h4>
          <button class="icon-btn" type="button" @click="closeForm"><IconGlyph name="x" :size="14" /></button>
        </header>

        <p v-if="creatingFor" class="hint">
          新建后会自动把「<code>{{ creatingFor }}</code>」这个历史名称归一到新店铺。
        </p>

        <label class="field">
          <span>平台 <b class="req">*</b></span>
          <select v-model="form.platform" class="sel">
            <option value="">— 请选择 —</option>
            <option v-for="p in PLATFORM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
          <em class="field-hint">历史数据里没有平台字段，这里必须手动指定（同名店铺可以同时存在于不同平台）</em>
        </label>

        <label class="field">
          <span>店铺名称 <b class="req">*</b></span>
          <input v-model="form.name" type="text" maxlength="200" placeholder="与平台上一致的名字" />
          <em class="field-hint">前后空白、全角空格与零宽字符会被自动忽略，不会因此变成两家店</em>
        </label>

        <label class="field">
          <span>店铺标识</span>
          <input v-model="form.platformShopId" type="text" maxlength="100" placeholder="平台店铺ID（可选，如 Shop1105228632）" />
          <em class="field-hint">稳定业务键：店铺改名后标识不变、历史关联不断链；同一平台内不可重复，留空不参与唯一校验</em>
        </label>

        <div class="field-row">
          <label class="field">
            <span>站点</span>
            <input v-model="form.site" type="text" maxlength="40" placeholder="如 RU / US" />
          </label>
          <label class="field">
            <span>账号套装</span>
            <select v-model.number="form.shopSetId" class="sel">
              <option :value="0">— 未关联 —</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ label(a) }}</option>
            </select>
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span>状态</span>
            <select v-model="form.status" class="sel">
              <option value="active">在营</option>
              <option value="archived">停用</option>
            </select>
          </label>
          <label class="field">
            <span>开店时间</span>
            <input v-model="form.openedAt" type="text" maxlength="40" placeholder="如 2024-03-01（可留空）" />
          </label>
        </div>

        <label class="field">
          <span>备注</span>
          <textarea v-model="form.note" rows="3" maxlength="2000"></textarea>
        </label>

        <footer class="drawer-foot">
          <button class="btn" type="button" :disabled="busy" @click="closeForm">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="submitForm">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.registry {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 24px;
  min-height: 0;
  overflow: auto;
  color: var(--wb-text);
}
.reg-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.reg-title h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.reg-sub {
  margin: 0;
  max-width: 720px;
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface, transparent);
  color: var(--wb-text-muted);
  font-size: 12px;
}
.chip b {
  color: var(--wb-text);
}
.chip.ok {
  border-color: var(--wb-primary);
}
.chip.warn {
  border-color: var(--wb-warning, var(--wb-border));
}
.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--wb-danger, var(--wb-border));
  border-radius: 8px;
  color: var(--wb-danger, var(--wb-text));
  font-size: 12.5px;
}
.panel {
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-surface, transparent);
  padding: 10px 12px 12px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.panel-head h4 {
  margin: 0;
  font-size: 13px;
}
.muted {
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}
.empty {
  margin: 6px 0;
  padding: 14px 0;
  color: var(--wb-text-muted);
  font-size: 12.5px;
  text-align: center;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.tbl th,
.tbl td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--wb-border);
  text-align: left;
  vertical-align: middle;
}
.tbl th {
  color: var(--wb-text-muted);
  font-weight: 500;
}
.tbl td.num,
.tbl th.num {
  text-align: right;
  white-space: nowrap;
}
.tbl td.act,
.tbl th.act {
  text-align: right;
}
.row-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.key-hint {
  margin-left: 6px;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.src {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 6px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  color: var(--wb-text-muted);
  font-size: 11px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--wb-primary);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-sm {
  padding: 3px 9px;
  font-size: 12px;
}
.btn.primary {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.btn.ghost {
  color: var(--wb-text-muted);
}
.sel,
.field input,
.field textarea {
  padding: 4px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-bg, transparent);
  color: var(--wb-text);
  font-size: 12.5px;
  font-family: inherit;
}
.sel {
  max-width: 220px;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  background: rgb(0 0 0 / 38%);
  z-index: 30;
}
.drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(460px, 92vw);
  padding: 14px 16px 18px;
  overflow: auto;
  border-left: 1px solid var(--wb-border);
  background: var(--wb-panel, var(--wb-bg, #fff));
  color: var(--wb-text);
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.drawer-head h4 {
  margin: 0;
  font-size: 14px;
}
.icon-btn {
  padding: 3px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.hint {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}
.field > span {
  color: var(--wb-text-muted);
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.field-hint {
  color: var(--wb-text-muted);
  font-size: 11.5px;
  font-style: normal;
  line-height: 1.6;
}
.req {
  color: var(--wb-danger, #d33);
}
.drawer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
