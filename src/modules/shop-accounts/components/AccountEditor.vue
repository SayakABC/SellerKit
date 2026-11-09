<script setup lang="ts">
// 店铺编辑抽屉：新增 / 编辑一行（店铺 + 账号物理合并，见 SHOP_ACCOUNT_REDESIGN_PLAN.md §3.4）。
// 五个区块一次保存：店铺 / 账号 / 企业（手机号·支付宝只读带出 + 国际支付宝密码）/
// 工具账号（紫鸟·ERP 下拉，可就地新建）/ 资金（可用·待结算·冻结，单位元）/ 其他（状态·保证金到账·开店时间·记分·标签·备注）。
// 保证金到账时间仅「退店」状态有输入位——状态非退店时保留库里原值，只是不展示。
// 校验底线：店名与邮箱至少填一个；邮箱填了就必须含 @。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { SECRET_FIELDS, STATUS_META, openedDaysOf, useShopAccountsStore } from '../store';
import { toolAccountUpsert } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import IconGlyph from '@/core/components/IconGlyph.vue';
import type {
  ShopAccountSecretKey,
  ShopAccountStatus,
  ShopAccountUpsertInput,
  ToolAccountKind,
} from '@/types';

const store = useShopAccountsStore();

const form = reactive({
  name: '',
  platformShopId: '',
  shopUrl: '',
  site: '',
  email: '',
  /** 关联企业 id（0 = 不关联） */
  companyId: 0,
  /** 紫鸟 / ERP 工具账号 id（0 = 不使用） */
  ziniaoAccountId: 0,
  erpAccountId: 0,
  openedAt: '',
  /** 保证金到账日期（仅退店时有意义；状态非退店时保留原值但不展示） */
  depositReceivedAt: '',
  /** 资金三项（单位元）：用字符串承接输入框，空串 = 未填（提交时按 0 / 未记录处理） */
  fundAvailable: '',
  fundPendingSettlement: '',
  fundFrozen: '',
  status: 'active' as ShopAccountStatus,
  /** 记分分值（0 = 未记录） */
  score: 0,
  tags: '',
  note: '',
});

// 店铺行的 3 类密码：留空表示不修改；改为空串则清空（在 submit 里与快照比对）
// 注：不含 mailAuthPwd（IMAP 授权码由「收件箱接入」单独维护）
const SECRET_KEYS = ['shopPwd', 'emailPwd', 'alipayPwd'] as const;
type EditableSecret = (typeof SECRET_KEYS)[number];

const secrets = reactive<Record<EditableSecret, string>>({
  shopPwd: '',
  emailPwd: '',
  alipayPwd: '',
});
/** 打开时的敏感字段快照：提交时仅回传有变更的字段（未改动 = 保持原值） */
const initialSecrets = reactive<Record<EditableSecret, string>>({
  shopPwd: '',
  emailPwd: '',
  alipayPwd: '',
});
const visible = reactive<Record<EditableSecret, boolean>>({
  shopPwd: false,
  emailPwd: false,
  alipayPwd: false,
});

const isEdit = computed(() => !!store.editorDetail);
/** 纯账号行（还没建店铺）：店铺区块顶部给「补建店铺」引导 */
const shopMissing = computed(() => isEdit.value && !(store.editorDetail?.name ?? '').trim());
/** 纯店铺行（账号待补）：账号区块顶部给引导 */
const emailMissing = computed(() => isEdit.value && !(store.editorDetail?.email ?? '').trim());

const nameFilled = computed(() => !!form.name.trim());
const emailFilled = computed(() => !!form.email.trim());
const emailValid = computed(() => !emailFilled.value || (form.email.includes('@') && !!form.email.trim()));
/** 资金三项的输入合法性：空 = 未记录；填了就必须是 ≥ 0 的有限数（负数不许保存） */
const FUND_KEYS = ['fundAvailable', 'fundPendingSettlement', 'fundFrozen'] as const;
const fundsValid = computed(() =>
  FUND_KEYS.every((key) => {
    const raw = String(form[key] ?? '').trim();
    if (!raw) return true;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0;
  }),
);

/** 底线：店名与邮箱至少填一个（两者都空拒绝保存） + 资金不能为负 */
const canSave = computed(
  () =>
    (nameFilled.value || emailFilled.value) &&
    emailValid.value &&
    fundsValid.value &&
    !store.saving,
);

/** 开店时间的辅助说明：已填则回显开店天数，未填说明用途 */
const openedAtHint = computed(() => {
  const days = openedDaysOf(form.openedAt);
  if (days === null) return '留空则不统计';
  return days === 0 ? '今天开店' : `已开 ${days} 天`;
});

function isConfigured(field: ShopAccountSecretKey): boolean {
  return !!store.editorDetail?.secretKeys.includes(field);
}

/** 敏感字段输入行（账号区 2 个 + 企业区国际支付宝密码 1 个共用模板结构） */
function secretMeta(key: EditableSecret) {
  return SECRET_FIELDS.find((f) => f.key === key)!;
}

/** 当前关联的企业是否仍在企业管理列表中；不在则下拉渲染「已删除」占位项 */
const companyExists = computed(() => store.companies.some((c) => c.id === form.companyId));

/** 选中企业的带出值（手机号 / 支付宝只读展示；要改去「企业」页） */
const pickedCompany = computed(() => store.companies.find((c) => c.id === form.companyId));

const ziniaoOptions = computed(() => store.toolAccounts.filter((t) => t.kind === 'ziniao'));
const erpOptions = computed(() => store.toolAccounts.filter((t) => t.kind === 'erp'));

// ── 工具账号就地新建（只填登录名 + 密码；保存成功后回填选中）─────────────────

const toolCreating = reactive<Record<ToolAccountKind, boolean>>({ ziniao: false, erp: false });
const toolForm = reactive<Record<ToolAccountKind, { account: string; password: string }>>({
  ziniao: { account: '', password: '' },
  erp: { account: '', password: '' },
});

async function submitToolCreate(kind: ToolAccountKind): Promise<void> {
  const entry = toolForm[kind];
  const account = entry.account.trim();
  const password = entry.password;
  if (!account) {
    toast(`请填写${kind === 'ziniao' ? '紫鸟' : 'ERP'}登录名`, 'error');
    return;
  }
  if (!password) {
    toast('请填写登录密码', 'error');
    return;
  }
  toolCreating[kind] = true;
  try {
    const res = await toolAccountUpsert({ kind, account, password });
    if (!res.success || !res.data) throw new Error(res.error || '保存失败');
    toast('已新建工具账号', 'success');
    entry.account = '';
    entry.password = '';
    toolCreating[kind] = false;
    await store.loadToolAccounts();
    if (kind === 'ziniao') form.ziniaoAccountId = res.data.id;
    else form.erpAccountId = res.data.id;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    toolCreating[kind] = false;
  }
}

/** 去「企业」页维护手机号 / 支付宝（本抽屉内只读带出，唯一编辑入口在企业页） */
function goCompanies(): void {
  store.mainTab = 'companies';
  store.closeEditor();
}

function hydrate(): void {
  const detail = store.editorDetail;
  form.name = detail?.name ?? '';
  form.platformShopId = detail?.platformShopId ?? '';
  form.shopUrl = detail?.shopUrl ?? '';
  form.site = detail?.site ?? '';
  form.email = detail?.email ?? '';
  // 新建默认值：带出上一次保存时的选择（可见可改；密码永远不复制）
  form.companyId = Number(detail?.companyId ?? store.lastUsed.companyId ?? 0) || 0;
  form.ziniaoAccountId = Number(detail?.ziniaoAccountId ?? store.lastUsed.ziniaoAccountId ?? 0) || 0;
  form.erpAccountId = Number(detail?.erpAccountId ?? store.lastUsed.erpAccountId ?? 0) || 0;
  form.openedAt = detail?.openedAt ?? '';
  form.depositReceivedAt = detail?.depositReceivedAt ?? '';
  // 新增时留空（placeholder 0.00 说明「未记录」），编辑时回填库里的数
  form.fundAvailable = detail ? String(detail.fundAvailable ?? 0) : '';
  form.fundPendingSettlement = detail ? String(detail.fundPendingSettlement ?? 0) : '';
  form.fundFrozen = detail ? String(detail.fundFrozen ?? 0) : '';
  form.status = detail?.status ?? 'active';
  form.score = Number(detail?.score ?? 0) || 0;
  form.tags = detail?.tags ?? '';
  form.note = detail?.note ?? '';
  for (const key of SECRET_KEYS) {
    const value = detail?.secrets[key] ?? '';
    secrets[key] = value;
    initialSecrets[key] = value;
    visible[key] = false;
  }
  toolCreating.ziniao = false;
  toolCreating.erp = false;
  toolForm.ziniao = { account: '', password: '' };
  toolForm.erp = { account: '', password: '' };
}

watch(
  [() => store.editorOpen, () => store.editorDetail],
  ([open]) => {
    if (!open || store.editorLoading) return;
    hydrate();
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  if (!canSave.value) return;
  // 仅回传已变更的敏感字段：未改动不发送（保持原值），改为空串则清空，其余覆盖
  const secretsPatch: Partial<Record<ShopAccountSecretKey, string>> = {};
  for (const key of SECRET_KEYS) {
    if (secrets[key] !== initialSecrets[key]) secretsPatch[key] = secrets[key];
  }
  const payload: ShopAccountUpsertInput = {
    id: store.editorDetail?.id,
    name: form.name.trim(),
    platformShopId: form.platformShopId.trim(),
    shopUrl: form.shopUrl.trim(),
    site: form.site.trim(),
    email: form.email.trim(),
    companyId: form.companyId,
    ziniaoAccountId: form.ziniaoAccountId,
    erpAccountId: form.erpAccountId,
    status: form.status,
    score: Number(form.score) || 0,
    openedAt: form.openedAt,
    depositReceivedAt: form.depositReceivedAt,
    fundAvailable: Number(form.fundAvailable) || 0,
    fundPendingSettlement: Number(form.fundPendingSettlement) || 0,
    fundFrozen: Number(form.fundFrozen) || 0,
    tags: form.tags.trim(),
    note: form.note.trim(),
    secrets: secretsPatch,
  };
  await store.save(payload);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') store.closeEditor();
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="editor-overlay" @click.self="store.closeEditor()">
    <aside class="editor-drawer">
      <header class="editor-head">
        <div class="editor-title">
          <IconGlyph name="key" :size="16" />
          <span>{{ isEdit ? '编辑店铺' : '新增店铺' }}</span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="store.closeEditor()">
          <IconGlyph name="x" :size="14" />
        </button>
      </header>

      <div v-if="store.editorLoading" class="editor-loading">加载中…</div>

      <div v-else class="editor-body">
        <!-- ① 店铺 -->
        <section class="form-section">
          <h3 class="section-title">店铺</h3>
          <p v-if="shopMissing" class="section-banner">
            <IconGlyph name="alert" :size="12" />
            <span>这一行只有账号、还没建店铺：填上店名保存后，即成为正式店铺。</span>
          </p>
          <div class="form-row">
            <label class="form-label" :class="{ required: !emailFilled }">店铺名</label>
            <div class="field-wrap">
              <input
                v-model="form.name"
                class="wb-input"
                type="text"
                placeholder="店铺名称（与邮箱至少填一个）"
              />
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">平台</label>
            <span class="static-value">速卖通</span>
          </div>
          <div class="form-row">
            <label class="form-label">平台店铺 ID</label>
            <input
              v-model="form.platformShopId"
              class="wb-input"
              type="text"
              placeholder="平台给的店铺标识（可选，改名不影响）"
            />
          </div>
          <div class="form-row">
            <label class="form-label">店铺地址</label>
            <input
              v-model="form.shopUrl"
              class="wb-input"
              type="text"
              placeholder="店铺链接（可选，用于识别采集到的商品）"
            />
          </div>
          <div class="form-row">
            <label class="form-label">站点</label>
            <input v-model="form.site" class="wb-input" type="text" placeholder="如 西班牙站（可选）" />
          </div>
        </section>

        <!-- ② 账号 -->
        <section class="form-section">
          <h3 class="section-title">账号</h3>
          <p v-if="emailMissing" class="section-banner">
            <IconGlyph name="alert" :size="12" />
            <span>这一家还没配账号：填上邮箱保存后，即可接入邮件与日常登录。</span>
          </p>
          <div class="form-row">
            <label class="form-label" :class="{ required: !nameFilled }">店铺邮箱</label>
            <div class="field-wrap">
              <input
                v-model="form.email"
                class="wb-input"
                type="text"
                placeholder="店铺主邮箱（与店名至少填一个）"
              />
              <p v-if="form.email && !emailValid" class="field-error">邮箱格式不正确</p>
              <p v-else class="field-hint">同一邮箱只能属于一家店铺</p>
            </div>
          </div>
          <div v-for="key in ['shopPwd', 'emailPwd'] as const" :key="key" class="form-row">
            <label class="form-label">
              {{ secretMeta(key).label }}
              <span v-if="isConfigured(key)" class="saved-badge">已保存</span>
            </label>
            <div class="secret-input">
              <input
                v-model="secrets[key]"
                class="wb-input"
                :type="visible[key] ? 'text' : 'password'"
                :placeholder="isConfigured(key) ? '已保存，留空则保持不变' : `填写${secretMeta(key).label}`"
                autocomplete="new-password"
              />
              <button
                class="icon-btn"
                type="button"
                :title="visible[key] ? '隐藏' : '显示'"
                @click="visible[key] = !visible[key]"
              >
                <IconGlyph :name="visible[key] ? 'eye-off' : 'eye'" :size="13" />
              </button>
            </div>
          </div>
        </section>

        <!-- ③ 企业：手机号 / 支付宝唯一落点在企业表，这里只读带出；要改去「企业」页 -->
        <section class="form-section">
          <h3 class="section-title">企业</h3>
          <div class="form-row">
            <label class="form-label">关联企业</label>
            <div class="field-wrap">
              <select v-model.number="form.companyId" class="wb-input company-select">
                <option :value="0">不关联</option>
                <option
                  v-if="form.companyId > 0 && !companyExists"
                  :value="form.companyId"
                >
                  已删除的企业
                </option>
                <option v-for="c in store.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <p v-if="store.companies.length === 0" class="field-hint">
                企业名单还是空的，可在「企业」页签新增后再来关联
              </p>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">手机号</label>
            <div class="field-wrap readonly-line">
              <span class="static-value">{{ pickedCompany?.phone || '—' }}</span>
              <button
                class="mini-link"
                type="button"
                :disabled="form.companyId <= 0"
                title="手机号在「企业」页维护，改一次所有店铺同步"
                @click="goCompanies"
              >
                去企业修改
              </button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">支付宝</label>
            <div class="field-wrap readonly-line">
              <span class="static-value">{{ pickedCompany?.alipay || '—' }}</span>
              <button
                class="mini-link"
                type="button"
                :disabled="form.companyId <= 0"
                title="扣运费的支付宝账号在「企业」页维护，改一次所有店铺同步"
                @click="goCompanies"
              >
                去企业修改
              </button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">
              {{ secretMeta('alipayPwd').label }}
              <span v-if="isConfigured('alipayPwd')" class="saved-badge">已保存</span>
            </label>
            <div class="secret-input">
              <input
                v-model="secrets.alipayPwd"
                class="wb-input"
                :type="visible.alipayPwd ? 'text' : 'password'"
                :placeholder="
                  isConfigured('alipayPwd') ? '已保存，留空则保持不变' : '每家店铺可不同'
                "
                autocomplete="new-password"
              />
              <button
                class="icon-btn"
                type="button"
                :title="visible.alipayPwd ? '隐藏' : '显示'"
                @click="visible.alipayPwd = !visible.alipayPwd"
              >
                <IconGlyph :name="visible.alipayPwd ? 'eye-off' : 'eye'" :size="13" />
              </button>
            </div>
          </div>
        </section>

        <!-- ④ 工具账号：下拉选已有登录；密码只在「工具账号」页维护，这里不重复输入 -->
        <section class="form-section">
          <h3 class="section-title">工具账号</h3>
          <div class="form-row">
            <label class="form-label">紫鸟</label>
            <div class="field-wrap">
              <div class="tool-line">
                <select v-model.number="form.ziniaoAccountId" class="wb-input company-select">
                  <option :value="0">不使用</option>
                  <option v-for="t in ziniaoOptions" :key="t.id" :value="t.id">{{ t.account }}</option>
                </select>
                <button
                  class="mini-link"
                  type="button"
                  @click="toolCreating.ziniao = !toolCreating.ziniao"
                >
                  {{ toolCreating.ziniao ? '收起' : '新建' }}
                </button>
              </div>
              <div v-if="toolCreating.ziniao" class="tool-create">
                <input
                  v-model="toolForm.ziniao.account"
                  class="wb-input"
                  type="text"
                  placeholder="紫鸟登录名"
                />
                <input
                  v-model="toolForm.ziniao.password"
                  class="wb-input"
                  type="password"
                  placeholder="登录密码"
                  autocomplete="new-password"
                />
                <button
                  class="btn-ghost btn-mini"
                  type="button"
                  :disabled="store.saving"
                  @click="submitToolCreate('ziniao')"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">ERP</label>
            <div class="field-wrap">
              <div class="tool-line">
                <select v-model.number="form.erpAccountId" class="wb-input company-select">
                  <option :value="0">不使用</option>
                  <option v-for="t in erpOptions" :key="t.id" :value="t.id">{{ t.account }}</option>
                </select>
                <button
                  class="mini-link"
                  type="button"
                  @click="toolCreating.erp = !toolCreating.erp"
                >
                  {{ toolCreating.erp ? '收起' : '新建' }}
                </button>
              </div>
              <div v-if="toolCreating.erp" class="tool-create">
                <input
                  v-model="toolForm.erp.account"
                  class="wb-input"
                  type="text"
                  placeholder="ERP 登录名"
                />
                <input
                  v-model="toolForm.erp.password"
                  class="wb-input"
                  type="password"
                  placeholder="登录密码"
                  autocomplete="new-password"
                />
                <button
                  class="btn-ghost btn-mini"
                  type="button"
                  :disabled="store.saving"
                  @click="submitToolCreate('erp')"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
          <p class="field-hint tool-hint">
            一个紫鸟 / ERP 登录可管多家店铺；改密码去「工具账号」页改一次，所有引用店铺生效。
          </p>
        </section>

        <!-- ⑤ 资金：平台后台资金账户三项抄录（单位元；0 / 留空 = 未记录） -->
        <section class="form-section">
          <h3 class="section-title">资金</h3>
          <div class="form-row">
            <label class="form-label">可用资金</label>
            <div class="field-wrap">
              <input
                v-model="form.fundAvailable"
                class="wb-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                data-act="shop-fund-available"
              />
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">待结算资金</label>
            <div class="field-wrap">
              <input
                v-model="form.fundPendingSettlement"
                class="wb-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                data-act="shop-fund-pending"
              />
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">冻结资金</label>
            <div class="field-wrap">
              <input
                v-model="form.fundFrozen"
                class="wb-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                data-act="shop-fund-frozen"
              />
            </div>
          </div>
          <p :class="fundsValid ? 'field-hint' : 'field-error'" class="funds-hint">
            {{
              fundsValid
                ? '单位：元。按平台后台资金账户填写；留空或 0 表示未记录。'
                : '资金金额不能为负数，请核对后再保存'
            }}
          </p>
        </section>

        <!-- ⑥ 其他 -->
        <section class="form-section">
          <h3 class="section-title">其他</h3>
          <div class="form-row">
            <label class="form-label">状态</label>
            <div class="status-picker">
              <button
                v-for="s in STATUS_META"
                :key="s.value"
                class="status-option"
                :class="{ 'is-active': form.status === s.value }"
                type="button"
                :data-status="s.value"
                @click="form.status = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>
          <div v-if="form.status === 'exited'" class="form-row">
            <label class="form-label">保证金到账时间</label>
            <div class="field-wrap">
              <input
                v-model="form.depositReceivedAt"
                class="wb-input date-input"
                type="date"
                title="退店后保证金退回的到账日期"
                data-act="shop-deposit"
              />
              <p class="field-hint">只在退店时展示在列表里；还没到账可以留空</p>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">记分分值</label>
            <div class="field-wrap">
              <input
                v-model.number="form.score"
                class="wb-input"
                type="number"
                min="0"
                step="1"
                placeholder="0（未记录）"
                data-act="shop-score"
              />
              <p class="field-hint">平台记分 / 扣分；0 表示未记录</p>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">开店时间</label>
            <div class="field-wrap">
              <input
                v-model="form.openedAt"
                class="wb-input date-input"
                type="date"
                :title="openedAtHint"
              />
              <p class="field-hint">{{ openedAtHint }}</p>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">标签</label>
            <input v-model="form.tags" class="wb-input" type="text" placeholder="多个标签用逗号分隔，如 主推、新店" />
          </div>
          <div class="form-row">
            <label class="form-label">备注</label>
            <textarea
              v-model="form.note"
              class="wb-input"
              rows="3"
              placeholder="补充说明（如 注册时间、注意事项）"
            />
          </div>
        </section>
      </div>

      <footer class="editor-foot">
        <button class="btn-ghost" type="button" @click="store.closeEditor()">取消</button>
        <button class="btn-primary" type="button" :disabled="!canSave" @click="submit">
          {{ store.saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
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
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
}
.editor-loading {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--wb-text-muted);
  font-size: 13px;
}
.editor-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 18px 18px;
}
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
/* 空态引导条（纯账号行补建店铺 / 纯店铺行补账号） */
.section-banner {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: var(--wb-radius);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11.5px;
  line-height: 1.6;
}
.section-banner span {
  flex: 1 1 auto;
}
.form-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.form-label {
  flex-shrink: 0;
  width: 96px;
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
.form-row > input,
.form-row > textarea,
.field-wrap > input,
.secret-input input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  font-size: 12.5px;
}
.form-row > input,
.field-wrap > input,
.secret-input input {
  height: 32px;
  padding: 0 10px;
}
/* 只读带出值（企业手机号 / 支付宝、固定平台） */
.static-value {
  flex-shrink: 0;
  padding-top: 7px;
  color: var(--wb-text);
  font-size: 12.5px;
}
.readonly-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.readonly-line .static-value {
  padding-top: 0;
}
/* 日期控件：底色/文字/日历图标跟随宿主主题（UA 默认在深色主题下会渲染浅色面板 + 深色图标，几乎看不清）
   必须 inherit——宿主把主题 color-scheme 以**内联样式**写到 <html>，元素级写死 light 会盖过它 */
.date-input {
  color-scheme: inherit;
}
.form-row > textarea {
  min-height: 72px;
  line-height: 1.55;
  resize: vertical;
}
/* 密码框不在全局 .wb-input 主题化选择器内（type=password），显式补齐边框与底色 */
.secret-input input {
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface-2);
  color: var(--wb-text);
}
.secret-input input:focus {
  outline: none;
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 1px var(--wb-primary);
}
.field-hint {
  margin: 4px 0 0;
  color: var(--wb-text-muted);
  font-size: 11px;
}
.field-error {
  margin: 4px 0 0;
  color: var(--wb-danger);
  font-size: 11px;
}
.saved-badge {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--wb-success-soft);
  color: var(--wb-success);
  font-size: 10px;
}
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
/* select 已带 .wb-input（边框/圆角/focus 环），这里只补抽屉内的紧凑尺寸 */
.company-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.secret-input {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}
.secret-input input {
  flex: 1 1 auto;
  min-width: 0;
}
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
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}
.editor-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-shrink: 0;
  padding: 12px 18px;
  border-top: 1px solid var(--wb-border);
}
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
.btn-primary:hover:not(:disabled) {
  background: var(--wb-primary-hover);
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.mini-link {
  flex-shrink: 0;
  padding: 0 8px;
  height: 24px;
  border: 1px dashed var(--wb-border);
  border-radius: 4px;
  background: transparent;
  color: var(--wb-primary);
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.mini-link:hover:not(:disabled) {
  border-color: var(--wb-primary);
  border-style: solid;
  background: var(--wb-primary-soft);
}
.mini-link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tool-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tool-line .company-select {
  flex: 1 1 auto;
  min-width: 0;
}
.tool-create {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.tool-create input {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
}
.tool-create .btn-mini {
  flex-shrink: 0;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
}
.tool-hint {
  margin-top: 2px;
}
</style>
