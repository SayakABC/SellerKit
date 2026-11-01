<script setup>
// src/components/CompanyManageView.vue
// 企业管理：企业基本信息维护 + 企业下关联的跨境合规资料（欧代 / 土代 / 德国包装法）。
// 数据经宿主 db 能力域读写（与账号库同一份 SQLite）；本域无密码类凭据，字段均为明文合规信息。
// 实现来源：原岛内 dist/companies.js（vanilla 版），随岛工程 Vue 化整体迁移，功能与交互保持不变。

import { computed, onMounted, reactive, ref } from 'vue';
import { toast } from '@/core/services/toast';
import {
  companyList,
  companySummary,
  companyGet,
  companyUpsert,
  companyDelete,
  companyProfileUpsert,
  companyProfileDelete,
} from '@/core/services/ipc';
import IconGlyph from '@/core/components/IconGlyph.vue';
import { useShopAccountsStore } from '../store';

/** 合规资料类型定义（岛内表单口径；增删类型需同步主进程 COMPLIANCE_TYPES 白名单） */
const PROFILE_DEFS = [
  {
    type: 'eu_rep',
    title: '欧代（欧盟授权代表）',
    short: '欧代',
    nameLabel: '欧代公司名称',
    regNoLabel: '协议号 / 注册号',
    extra: [{ key: 'scope', label: '适用产品 / 类目' }],
  },
  {
    type: 'tr_rep',
    title: '土代（土耳其授权代表）',
    short: '土代',
    nameLabel: '土代公司名称',
    regNoLabel: '土代注册号',
    extra: [{ key: 'scope', label: '适用产品 / 类目' }],
  },
  {
    type: 'de_packaging',
    title: '德国包装法（LUCID + 双元系统）',
    short: '德国包装法',
    nameLabel: '双元系统 / 回收商',
    regNoLabel: 'LUCID 注册号',
    extra: [
      { key: 'contractNo', label: '回收合同号' },
      { key: 'declareYear', label: '申报年度' },
      { key: 'weightKg', label: '申报重量（kg）' },
    ],
  },
];

/** 到期预警天数（与宿主 EXPIRING_SOON_DAYS 保持一致，仅用于岛内标红提示） */
const EXPIRING_SOON_DAYS = 30;

const COMPANY_STATUS_LABEL = { active: '启用', inactive: '停用' };
const PROFILE_STATUS_LABEL = { valid: '有效', pending: '办理中', expired: '已过期' };

// 店铺账号模块共享的关联企业下拉缓存（store.companies）与本页列表(items)是两份独立数据；
// 本页新增/删除企业后需主动同步 store 的缓存，否则账号编辑器的「关联企业」下拉看不到新企业。
const shopAccountsStore = useShopAccountsStore();

const items = ref([]);
const summary = reactive({ total: 0, byStatus: {}, byType: {}, expiringSoon: 0 });
const search = ref('');
const status = ref('');
const loading = ref(false);
/** 宿主不支持企业管理能力（版本过旧 / 主进程未注册 company-* IPC）时的降级说明 */
const unsupported = ref('');
/** 当前打开的弹层：'' | 'detail' | 'company' | 'profile' */
const modal = ref('');
const detail = ref(null);
const companyForm = reactive({ ...emptyCompany() });
const profileForm = reactive({ id: 0, type: 'eu_rep', ...emptyProfile() });

function emptyCompany() {
  return {
    id: 0,
    name: '',
    unifiedCode: '',
    country: '',
    address: '',
    legalPerson: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    vatNo: '',
    eoriNo: '',
    status: 'active',
    note: '',
  };
}

function emptyProfile() {
  return {
    name: '',
    regNo: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    address: '',
    effectiveAt: '',
    expireAt: '',
    status: 'valid',
    note: '',
    extra: {},
  };
}

/* ------------------------------ 工具 ------------------------------ */

/**
 * 判断失败是否源于「宿主缺少企业管理能力」，而非数据/网络问题。
 * 典型场景：宿主未重启（主进程还没注册 company-* IPC 通道），或宿主版本早于企业管理功能。
 */
function hostUnsupportedReason(e) {
  const m = String((e && e.message) || e || '');
  if (/db 操作未登记|操作未登记|company(Db|Ensure|List|Get|Summary|Upsert|Delete|Profile)/i.test(m)) {
    return '宿主未提供企业管理的数据接口（可能为宿主版本过旧）';
  }
  if (/No handler registered|no handler/i.test(m)) return '宿主主进程未注册企业管理通道';
  if (/不在声明白名单|权限被拒/.test(m)) return '宿主未授予企业管理所需权限';
  return '';
}

/** 距离到期天数（无到期日 / 非法日期返回 null） */
function daysToExpire(expireAt) {
  const s = String(expireAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const target = new Date(`${s}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 到期提示（已过期 / 剩余 N 天 / 长期有效） */
function expireHint(expireAt) {
  const days = daysToExpire(expireAt);
  if (days === null) return { text: '长期有效', cls: 'muted' };
  if (days < 0) return { text: `已过期 ${Math.abs(days)} 天`, cls: 'exp is-bad' };
  if (days <= EXPIRING_SOON_DAYS) return { text: `${days} 天后到期`, cls: 'exp is-warn' };
  return { text: `${days} 天后到期`, cls: 'exp' };
}

function defOf(type) {
  return PROFILE_DEFS.find((d) => d.type === type) || PROFILE_DEFS[0];
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(s);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 统一解包：失败抛错，成功返回 data */
async function unwrap(promise, fallbackError) {
  const r = await promise;
  if (!r.success) throw new Error(r.error || fallbackError);
  return r.data;
}

const statusChips = computed(() => [
  { label: '全部', value: '', count: summary.total || 0 },
  ...Object.keys(COMPANY_STATUS_LABEL).map((k) => ({
    label: COMPANY_STATUS_LABEL[k],
    value: k,
    count: (summary.byStatus || {})[k] || 0,
  })),
]);

const lastUpdated = computed(() =>
  items.value.length ? fmtTime(items.value[0].updatedAt) : '',
);

/* ------------------------------ 列表 ------------------------------ */

async function refresh() {
  loading.value = true;
  try {
    const [list, sum] = await Promise.all([
      unwrap(
        companyList({ search: search.value || undefined, status: status.value || undefined }),
        '读取企业列表失败',
      ),
      unwrap(companySummary(), '读取企业汇总失败'),
    ]);
    items.value = list || [];
    Object.assign(summary, sum || {});
    unsupported.value = '';
  } catch (e) {
    const reason = hostUnsupportedReason(e);
    if (reason) unsupported.value = `${reason}：${e.message}`;
    else toast.error(e.message);
  } finally {
    loading.value = false;
  }
}

/** 切换状态筛选并刷新 */
function setStatus(value) {
  status.value = value;
  void refresh();
}

function contactText(c) {
  return [c.contactName, c.contactPhone].filter(Boolean).join(' / ') || '—';
}

function taxText(c) {
  return [c.vatNo, c.eoriNo].filter(Boolean).join(' / ') || '—';
}

/* ------------------------------ 企业编辑 ------------------------------ */

function openCompanyEditor(company) {
  Object.assign(companyForm, emptyCompany(), company || {});
  modal.value = 'company';
}

async function openCompanyEditorById(id) {
  if (detail.value && detail.value.id === id) {
    openCompanyEditor(detail.value);
    return;
  }
  try {
    const data = await unwrap(companyGet(id), '读取企业详情失败');
    if (!data || !data.company) {
      toast.error('企业不存在或已被删除');
      return;
    }
    openCompanyEditor(data.company);
  } catch (e) {
    toast.error(e.message);
  }
}

async function saveCompany() {
  if (!companyForm.name.trim()) {
    toast.error('企业名称必填');
    return;
  }
  const payload = { ...companyForm, name: companyForm.name.trim() };
  if (!payload.id) delete payload.id;
  try {
    await unwrap(companyUpsert(payload), '保存企业失败');
    toast.success('已保存');
    const keepDetailId = modal.value === 'company' && detail.value ? detail.value.id : 0;
    modal.value = '';
    await refresh();
    // 同步刷新店铺账号模块的「关联企业」下拉缓存（新建/重命名后立即在账号编辑器可选）
    void shopAccountsStore.loadCompanies();
    if (keepDetailId) await openDetail(keepDetailId);
  } catch (e) {
    toast.error(e.message);
  }
}

async function removeCompany(id) {
  const target = items.value.find((i) => i.id === id);
  if (
    !window.confirm(
      `确认删除企业「${target?.name || id}」？其名下的欧代 / 土代 / 包装法资料会一并删除。`,
    )
  ) {
    return;
  }
  try {
    await unwrap(companyDelete(id), '删除企业失败');
    toast.success('已删除');
    await refresh();
    // 同步刷新店铺账号模块的「关联企业」下拉缓存（避免已删除企业残留在候选中）
    void shopAccountsStore.loadCompanies();
  } catch (e) {
    toast.error(e.message);
  }
}

/* ------------------------------ 企业详情 ------------------------------ */

async function openDetail(id) {
  try {
    const data = await unwrap(companyGet(id), '读取企业详情失败');
    if (!data) {
      toast.error('企业不存在或已被删除');
      return;
    }
    // 主进程 getCompany 返回摊平对象：公司字段 + profiles 数组（CompanyDetail）
    detail.value = data;
    modal.value = 'detail';
  } catch (e) {
    toast.error(e.message);
  }
}

const infoRows = computed(() => {
  const c = detail.value;
  if (!c) return [];
  return [
    ['统一社会信用代码', c.unifiedCode],
    ['注册国家 / 地区', c.country],
    ['注册地址', c.address],
    ['法定代表人', c.legalPerson],
    ['联系人', c.contactName],
    ['联系电话', c.contactPhone],
    ['联系邮箱', c.contactEmail],
    ['VAT 税号', c.vatNo],
    ['EORI 号', c.eoriNo],
  ].filter(([, v]) => String(v || '').trim());
});

/** 某合规类型下已维护的资料列表 */
function profilesOf(type) {
  return ((detail.value && detail.value.profiles) || []).filter((p) => p.type === type);
}

function extraRowsOf(def, profile) {
  return def.extra
    .map((f) => [f.label, profile.extra ? profile.extra[f.key] : ''])
    .filter(([, v]) => String(v || '').trim());
}

function contactTextOf(p) {
  return [p.contactName, p.contactPhone, p.contactEmail].filter(Boolean).join(' / ') || '—';
}

/* ------------------------------ 合规资料编辑 ------------------------------ */

function openProfileEditor(type, profile) {
  Object.assign(profileForm, emptyProfile(), { id: 0, type });
  if (profile) Object.assign(profileForm, profile, { extra: { ...(profile.extra || {}) } });
  modal.value = 'profile';
}

function editProfile(id) {
  const profile = ((detail.value && detail.value.profiles) || []).find((p) => p.id === id);
  if (profile) openProfileEditor(profile.type, profile);
}

async function saveProfile() {
  const def = defOf(profileForm.type);
  const extra = {};
  for (const f of def.extra) {
    const v = String(profileForm.extra[f.key] || '').trim();
    if (v) extra[f.key] = v;
  }
  const payload = { ...profileForm, extra, companyId: detail.value ? detail.value.id : 0 };
  if (!payload.id) delete payload.id;
  delete payload.type_ex;
  try {
    await unwrap(companyProfileUpsert(payload), '保存合规资料失败');
    toast.success('已保存');
    const companyId = payload.companyId;
    await refresh();
    await openDetail(companyId);
  } catch (e) {
    toast.error(e.message);
  }
}

async function removeProfile(id) {
  if (!window.confirm('确认删除该合规资料？')) return;
  const companyId = detail.value ? detail.value.id : 0;
  try {
    await unwrap(companyProfileDelete(id), '删除合规资料失败');
    toast.success('已删除');
    await refresh();
    if (companyId) await openDetail(companyId);
  } catch (e) {
    toast.error(e.message);
  }
}

function closeModal() {
  modal.value = '';
}

/** 搜索防抖（250ms），避免每次按键都打一次宿主 */
let searchTimer = null;
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void refresh();
  }, 250);
}

/** 当前合规资料弹窗用到的类型定义 */
const activeDef = computed(() => defOf(profileForm.type));

onMounted(() => {
  void refresh();
});
</script>

<template>
  <section class="panel">
    <div v-if="unsupported" class="unsupported">
      <p class="empty">企业管理不可用：{{ unsupported }}</p>
      <p class="muted">
        企业管理依赖宿主侧的 <code>company-*</code> 数据通道。请重启 SellerKit（宿主）后重试；
        若仍不可用，说明宿主版本早于企业管理功能，请升级宿主到最新版本。
      </p>
      <div class="bar">
        <button class="btn" type="button" @click="refresh()">重试</button>
      </div>
    </div>

    <template v-else>
      <div class="bar">
        <button
          v-for="c in statusChips"
          :key="c.value"
          class="chip"
          :class="{ 'is-active': status === c.value }"
          type="button"
          @click="status = c.value; refresh()"
        >
          {{ c.label }} {{ c.count }}
        </button>
        <span v-if="Number(summary.expiringSoon) || 0" class="warn-chip">
          {{ summary.expiringSoon }} 项合规资料将在 {{ EXPIRING_SOON_DAYS }} 天内到期或已过期
        </span>
        <span class="grow"></span>
        <input
          v-model="search"
          class="wb-input search"
          type="search"
          placeholder="搜索企业 / 信用代码 / 联系人 / 税号"
          @input="onSearchInput"
        />
        <button class="btn primary" type="button" @click="openCompanyEditor(null)">
          <IconGlyph name="plus" :size="13" />
          <span>新增企业</span>
        </button>
      </div>

      <p v-if="loading" class="muted">加载中…</p>
      <table v-else-if="items.length" class="grid">
        <thead>
          <tr>
            <th>企业名称</th>
            <th>统一社会信用代码</th>
            <th>国家 / 地区</th>
            <th>联系人</th>
            <th>VAT / EORI</th>
            <th>合规资料</th>
            <th>状态</th>
            <th class="w140">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in items" :key="i.id">
            <td>
              <button class="link" type="button" @click="openDetail(i.id)">{{ i.name }}</button>
            </td>
            <td class="mono">{{ i.unifiedCode || '—' }}</td>
            <td>{{ i.country || '—' }}</td>
            <td>{{ contactText(i) }}</td>
            <td class="mono">{{ taxText(i) }}</td>
            <td>
              <span
                v-for="d in PROFILE_DEFS"
                :key="d.type"
                class="tag"
                :class="{ 'is-on': (i.profileTypes || []).includes(d.type) }"
                :title="d.title"
              >
                {{ d.short }}
              </span>
            </td>
            <td>
              <span class="status" :class="`s-${i.status}`">
                {{ COMPANY_STATUS_LABEL[i.status] || i.status }}
              </span>
            </td>
            <td>
              <button class="mini" type="button" @click="openCompanyEditorById(i.id)">编辑</button>
              <button class="mini danger" type="button" @click="removeCompany(i.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">
        暂无企业{{ search ? '（可清空搜索条件重试）' : '，点右上角「新增企业」创建' }}。
      </p>

      <p class="muted">
        共 {{ items.length }} 家企业{{ lastUpdated ? ` · 最近更新 ${lastUpdated}` : '' }}
      </p>
    </template>

    <!-- 企业编辑（右侧抽屉，与账号库 AccountEditor 同一设计语言） -->
    <div v-if="modal === 'company'" class="editor-overlay" @click.self="closeModal">
      <aside class="editor-drawer">
        <header class="editor-head">
          <div class="editor-title">
            <span>{{ companyForm.id ? '编辑企业' : '新增企业' }}</span>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="closeModal">×</button>
        </header>
        <div class="editor-body">
          <section class="form-section">
            <h3 class="section-title">基本信息</h3>
            <div class="form-row">
              <label class="form-label required">企业名称</label>
              <div class="field-wrap">
                <input
                  v-model="companyForm.name"
                  class="wb-input"
                  type="text"
                  placeholder="营业执照主体名称，作为企业唯一标识"
                />
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">状态</label>
              <div class="status-picker">
                <button
                  v-for="(v, k) in COMPANY_STATUS_LABEL"
                  :key="k"
                  class="status-option"
                  :class="{ 'is-active': companyForm.status === k }"
                  type="button"
                  @click="companyForm.status = k"
                >
                  {{ v }}
                </button>
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">注册国家 / 地区</label>
              <input v-model="companyForm.country" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">统一社会信用代码</label>
              <input v-model="companyForm.unifiedCode" class="wb-input" type="text" placeholder="注册号 / 税号" />
            </div>
            <div class="form-row">
              <label class="form-label">法定代表人</label>
              <input v-model="companyForm.legalPerson" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">注册地址</label>
              <input v-model="companyForm.address" class="wb-input" type="text" />
            </div>
          </section>
          <section class="form-section">
            <h3 class="section-title">联系与税务</h3>
            <div class="form-row">
              <label class="form-label">联系人</label>
              <input v-model="companyForm.contactName" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">联系电话</label>
              <input v-model="companyForm.contactPhone" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">联系邮箱</label>
              <input v-model="companyForm.contactEmail" class="wb-input" type="email" />
            </div>
            <div class="form-row">
              <label class="form-label">VAT 税号</label>
              <input v-model="companyForm.vatNo" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">EORI 号</label>
              <input v-model="companyForm.eoriNo" class="wb-input" type="text" />
            </div>
          </section>
          <section class="form-section">
            <h3 class="section-title">备注</h3>
            <textarea v-model="companyForm.note" class="wb-input ta" rows="3"></textarea>
          </section>
        </div>
        <footer class="editor-foot">
          <button class="btn-ghost" type="button" @click="closeModal">取消</button>
          <button class="btn-primary" type="button" @click="saveCompany">保存</button>
        </footer>
      </aside>
    </div>

    <!-- 企业详情 + 合规资料（右侧抽屉，比编辑抽屉稍宽） -->
    <div v-if="modal === 'detail' && detail" class="editor-overlay" @click.self="closeModal">
      <aside class="editor-drawer wide">
        <header class="editor-head">
          <div class="editor-title">
            <span>{{ detail.name }}</span>
            <span class="status" :class="`s-${detail.status}`">
              {{ COMPANY_STATUS_LABEL[detail.status] || detail.status }}
            </span>
          </div>
          <button class="mini" type="button" @click="openCompanyEditor(detail)">编辑信息</button>
          <button class="icon-btn" type="button" title="关闭" @click="closeModal">×</button>
        </header>
        <div class="editor-body">
          <section class="form-section">
            <h3 class="section-title">企业基本信息</h3>
            <div v-if="infoRows.length" class="kv">
              <div v-for="[k, v] in infoRows" :key="k" class="kv-row">
                <span class="kv-k">{{ k }}</span>
                <span class="kv-v">{{ v }}</span>
              </div>
            </div>
            <p v-else class="muted">未填写补充信息，点右上角「编辑信息」补充。</p>
          </section>
          <section class="form-section">
            <h3 class="section-title">跨境合规资料</h3>
            <div v-for="def in PROFILE_DEFS" :key="def.type" class="card">
              <template v-if="profilesOf(def.type).length">
                <div v-for="p in profilesOf(def.type)" :key="p.id" class="profile-block">
                  <div class="card-head">
                    <b>{{ def.title }}</b>
                    <span class="status" :class="`s-${p.status}`">
                      {{ PROFILE_STATUS_LABEL[p.status] || p.status }}
                    </span>
                    <span class="grow"></span>
                    <button class="mini" type="button" @click="editProfile(p.id)">编辑</button>
                    <button class="mini danger" type="button" @click="removeProfile(p.id)">删除</button>
                  </div>
                  <div class="kv">
                    <div class="kv-row">
                      <span class="kv-k">{{ def.nameLabel }}</span>
                      <span class="kv-v">{{ p.name || '—' }}</span>
                    </div>
                    <div class="kv-row">
                      <span class="kv-k">{{ def.regNoLabel }}</span>
                      <span class="kv-v mono">{{ p.regNo || '—' }}</span>
                    </div>
                    <div class="kv-row">
                      <span class="kv-k">联系人</span>
                      <span class="kv-v">{{ contactTextOf(p) }}</span>
                    </div>
                    <div class="kv-row">
                      <span class="kv-k">地址</span>
                      <span class="kv-v">{{ p.address || '—' }}</span>
                    </div>
                    <div class="kv-row">
                      <span class="kv-k">有效期</span>
                      <span class="kv-v">
                        {{ p.effectiveAt || '—' }} ~ {{ p.expireAt || '长期' }}
                        <span :class="expireHint(p.expireAt).cls">
                          {{ expireHint(p.expireAt).text }}
                        </span>
                      </span>
                    </div>
                    <div v-for="[k, v] in extraRowsOf(def, p)" :key="k" class="kv-row">
                      <span class="kv-k">{{ k }}</span>
                      <span class="kv-v">{{ v }}</span>
                    </div>
                    <div v-if="p.note" class="kv-row">
                      <span class="kv-k">备注</span>
                      <span class="kv-v">{{ p.note }}</span>
                    </div>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="card-head">
                  <b>{{ def.title }}</b>
                  <span class="grow"></span>
                  <button class="mini" type="button" @click="openProfileEditor(def.type, null)">
                    补充
                  </button>
                </div>
                <p class="muted">尚未维护{{ def.short }}资料。</p>
              </template>
            </div>
          </section>
        </div>
        <footer class="editor-foot">
          <button class="btn-ghost" type="button" @click="closeModal">关闭</button>
        </footer>
      </aside>
    </div>

    <!-- 合规资料编辑（右侧抽屉） -->
    <div v-if="modal === 'profile'" class="editor-overlay" @click.self="closeModal">
      <aside class="editor-drawer">
        <header class="editor-head">
          <div class="editor-title">
            <span>{{ profileForm.id ? '编辑' : '补充' }}{{ activeDef.title }}</span>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="closeModal">×</button>
        </header>
        <div class="editor-body">
          <section class="form-section">
            <h3 class="section-title">基本信息</h3>
            <div class="form-row">
              <label class="form-label required">{{ activeDef.nameLabel }}</label>
              <div class="field-wrap">
                <input v-model="profileForm.name" class="wb-input" type="text" />
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">{{ activeDef.regNoLabel }}</label>
              <input v-model="profileForm.regNo" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">状态</label>
              <div class="status-picker">
                <button
                  v-for="(v, k) in PROFILE_STATUS_LABEL"
                  :key="k"
                  class="status-option"
                  :class="{ 'is-active': profileForm.status === k }"
                  type="button"
                  @click="profileForm.status = k"
                >
                  {{ v }}
                </button>
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">有效期</label>
              <div class="field-wrap date-pair">
                <input v-model="profileForm.effectiveAt" class="wb-input" type="date" />
                <span class="date-sep">~</span>
                <input v-model="profileForm.expireAt" class="wb-input" type="date" />
              </div>
            </div>
            <p class="field-hint">到期日期留空 = 长期有效；填写后列表汇总会做 {{ EXPIRING_SOON_DAYS }} 天到期预警。</p>
            <div class="form-row">
              <label class="form-label">地址</label>
              <input v-model="profileForm.address" class="wb-input" type="text" />
            </div>
          </section>
          <section class="form-section">
            <h3 class="section-title">联系人</h3>
            <div class="form-row">
              <label class="form-label">联系人</label>
              <input v-model="profileForm.contactName" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">联系电话</label>
              <input v-model="profileForm.contactPhone" class="wb-input" type="text" />
            </div>
            <div class="form-row">
              <label class="form-label">联系邮箱</label>
              <input v-model="profileForm.contactEmail" class="wb-input" type="email" />
            </div>
          </section>
          <section v-if="activeDef.extra.length" class="form-section">
            <h3 class="section-title">{{ activeDef.title }}扩展信息</h3>
            <div v-for="f in activeDef.extra" :key="f.key" class="form-row">
              <label class="form-label">{{ f.label }}</label>
              <input v-model="profileForm.extra[f.key]" class="wb-input" type="text" />
            </div>
          </section>
          <section class="form-section">
            <h3 class="section-title">备注</h3>
            <textarea v-model="profileForm.note" class="wb-input ta" rows="3"></textarea>
          </section>
        </div>
        <footer class="editor-foot">
          <button class="btn-ghost" type="button" @click="modal = 'detail'">返回</button>
          <button class="btn-primary" type="button" @click="saveProfile">保存</button>
        </footer>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.grow {
  flex: 1 1 auto;
}
.search {
  width: 240px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.btn.primary {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  color: var(--wb-primary-contrast);
}

.mini {
  height: 24px;
  padding: 0 8px;
  margin-right: 4px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 11.5px;
  cursor: pointer;
}
.mini:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}
.mini.danger:hover {
  color: var(--wb-danger);
  border-color: var(--wb-danger);
}

.chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 11.5px;
  cursor: pointer;
}
.chip.is-active {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  border-color: transparent;
}

.warn-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-warning-soft, rgba(217, 139, 10, 0.14));
  color: var(--wb-warning);
  font-size: 11px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.grid th,
.grid td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--wb-border);
  text-align: left;
  vertical-align: middle;
}
.grid th {
  color: var(--wb-text-muted);
  font-weight: 500;
  white-space: nowrap;
}
.w140 {
  width: 140px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  margin: 0;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--wb-text-muted);
}

.link {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--wb-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.link:hover {
  color: var(--wb-primary);
  text-decoration: underline;
}

.tag {
  display: inline-block;
  padding: 0 6px;
  margin-right: 4px;
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11px;
}
.tag.is-on {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

.status {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}
.status.s-active,
.status.s-valid {
  background: var(--wb-success-soft, rgba(23, 163, 74, 0.14));
  color: var(--wb-success);
}
.status.s-inactive,
.status.s-pending {
  background: var(--wb-warning-soft, rgba(217, 139, 10, 0.14));
  color: var(--wb-warning);
}
.status.s-expired {
  background: var(--wb-danger-soft, rgba(229, 72, 77, 0.12));
  color: var(--wb-danger);
}

.card {
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--wb-surface-2);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.card-head b {
  font-size: 12px;
}
.profile-block + .profile-block {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--wb-border);
}

.kv {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px 12px;
}
.kv-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.kv-k {
  flex: 0 0 132px;
  color: var(--wb-text-muted);
  font-size: 11px;
}
.kv-v {
  flex: 1 1 auto;
  word-break: break-word;
}

.exp {
  margin-left: 6px;
  font-size: 11px;
  color: var(--wb-text-muted);
}
.exp.is-warn {
  color: var(--wb-warning);
}
.exp.is-bad {
  color: var(--wb-danger);
}

.unsupported {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.unsupported code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--wb-surface-2);
}

/* ============================================================
   弹层：右侧抽屉（与账号库 AccountEditor 同一设计语言）
   ============================================================ */
.editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  background: var(--wb-overlay);
}
.editor-drawer {
  display: flex;
  flex-direction: column;
  width: 560px;
  max-width: 92vw;
  height: 100%;
  background: var(--wb-surface);
  border-left: 1px solid var(--wb-border);
}
.editor-drawer.wide {
  width: 640px;
}
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 14px 18px;
  border-bottom: 1px solid var(--wb-border);
}
.editor-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
  min-width: 0;
}
.editor-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 18px 18px;
}
.editor-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-shrink: 0;
  padding: 12px 18px;
  border-top: 1px solid var(--wb-border);
}

/* 表单分组与行（label 左对齐右、控件右，紧凑 32px 输入） */
.form-section {
  padding: 14px 0;
  border-bottom: 1px dashed var(--wb-border);
}
.form-section:last-child {
  border-bottom: none;
}
.section-title {
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--wb-text);
}
.form-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.form-label {
  flex-shrink: 0;
  width: 110px;
  padding-top: 7px;
  color: var(--wb-text-muted);
  font-size: 12.5px;
  text-align: right;
}
.form-label.required::after {
  content: ' *';
  color: var(--wb-danger);
}
.field-wrap {
  flex: 1 1 auto;
  min-width: 0;
}
.form-row > .wb-input,
.field-wrap > .wb-input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
}
.wb-input.ta {
  width: 100%;
  height: auto;
  min-height: 64px;
  padding: 6px 10px;
  font-size: 12.5px;
  line-height: 1.55;
  resize: vertical;
}
.field-hint {
  margin: -4px 0 10px 122px;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.date-pair {
  display: flex;
  align-items: center;
  gap: 6px;
}
.date-pair .wb-input {
  flex: 1 1 auto;
  min-width: 0;
}
.date-sep {
  flex-shrink: 0;
  color: var(--wb-text-muted);
}

/* 分段式状态选择（与原版 status-option 同款） */
.status-picker {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.status-option {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.status-option:hover {
  border-color: var(--wb-primary);
}
.status-option.is-active {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}

/* 抽屉头部按钮 */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}

/* 抽屉底部按钮 */
.btn-primary {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 18px;
  border: 1px solid var(--wb-primary);
  border-radius: var(--wb-radius);
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover {
  background: var(--wb-primary-hover);
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.btn-ghost:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
</style>
