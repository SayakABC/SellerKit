<script setup lang="ts">
// 店铺套编辑抽屉：新增 / 编辑一套店铺（邮箱为主标识）。
// 基本信息 / 账号信息 / 敏感信息（5 类密码）三段式；密码留空表示不修改。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  PLATFORM_OPTIONS,
  SECRET_FIELDS,
  STATUS_META,
  openedDaysOf,
  useShopAccountsStore,
} from '../store';
import IconGlyph from './IconGlyph.vue';
import type {
  ShopAccountSecretField,
  ShopAccountSecretKey,
  ShopAccountStatus,
  ShopAccountUpsertInput,
} from '@/types';

const store = useShopAccountsStore();

/** 平台下拉中「自定义」的哨兵值（含双下划线，不会与真实平台名冲突） */
const CUSTOM_PLATFORM_VALUE = '__custom__';

const form = reactive({
  email: '',
  phone: '',
  company: '',
  /** 关联企业 id（企业管理主键；0 = 未关联） */
  companyId: 0,
  alipay: '',
  ziniaoAccount: '',
  erpAccount: '',
  openedAt: '',
  status: 'active' as ShopAccountStatus,
  tags: '',
  note: '',
});

const platforms = ref<string[]>([]);
/** 平台下拉当前选中值：空串 = 占位项，CUSTOM_PLATFORM_VALUE = 自定义 */
const platformSelect = ref('');
/** 自定义平台的临时输入（回车 / 点「添加」/ 保存时统一提交） */
const customPlatform = ref('');
const customPlatformMode = ref(false);
const customPlatformRef = ref<HTMLInputElement | null>(null);

// 注：不含 mailAuthPwd（IMAP 授权码由「收件箱接入」单独维护）
const secrets = reactive<Record<ShopAccountSecretField, string>>({
  shopPwd: '',
  emailPwd: '',
  alipayPwd: '',
  ziniaoPwd: '',
  erpPwd: '',
});
/** 打开时的敏感字段快照：提交时仅回传有变更的字段（未改动 = 保持原值） */
const initialSecrets = reactive<Record<ShopAccountSecretField, string>>({
  shopPwd: '',
  emailPwd: '',
  alipayPwd: '',
  ziniaoPwd: '',
  erpPwd: '',
});
const visible = reactive<Record<ShopAccountSecretField, boolean>>({
  shopPwd: false,
  emailPwd: false,
  alipayPwd: false,
  ziniaoPwd: false,
  erpPwd: false,
});

const isEdit = computed(() => !!store.editorDetail);
const emailValid = computed(() => form.email.includes('@') && !!form.email.trim());
/** 开店时间的辅助说明：已填则回显开店天数，未填说明用途 */
const openedAtHint = computed(() => {
  const days = openedDaysOf(form.openedAt);
  if (days === null) return '留空则不统计；列表会展示开店至今的天数';
  return days === 0 ? '今天开店' : `已开 ${days} 天`;
});
const canSave = computed(() => emailValid.value && !store.saving);
/**
 * 平台下拉候选 = 预设枚举 + 历史数据里出现过的自定义平台（去重，且排除已选）。
 * 这样既能把平台名收敛到枚举，又不会让旧数据里的自定义平台无法再次选择。
 */
const platformChoices = computed(() => {
  const picked = new Set(platforms.value);
  const extras = store.summary.platforms
    .map((p) => p.platform)
    .filter((p) => !!p && !PLATFORM_OPTIONS.includes(p) && !picked.has(p));
  return [...PLATFORM_OPTIONS.filter((p) => !picked.has(p)), ...extras];
});

function isConfigured(field: ShopAccountSecretField): boolean {
  return !!store.editorDetail?.secretKeys.includes(field);
}

/** 当前关联的企业是否仍在企业管理列表中；不在则下拉渲染「已删除」占位项（异步列表未到时也会短暂命中） */
const companyExists = computed(() => store.companies.some((c) => c.id === form.companyId));

function hydrate(): void {
  const detail = store.editorDetail;
  form.email = detail?.email ?? '';
  form.phone = detail?.phone ?? '';
  form.company = detail?.company ?? '';
  // 关联企业 id 原样回显（0 = 未关联）；企业列表异步加载，即使暂时没命中也保持选中，
  // 由 companyExists 在下拉中渲染「已删除」占位项，避免列表晚到时误清关联
  form.companyId = Number(detail?.companyId ?? 0) || 0;
  form.alipay = detail?.alipay ?? '';
  form.ziniaoAccount = detail?.ziniaoAccount ?? '';
  form.erpAccount = detail?.erpAccount ?? '';
  form.openedAt = detail?.openedAt ?? '';
  form.status = detail?.status ?? 'active';
  form.tags = detail?.tags ?? '';
  form.note = detail?.note ?? '';
  platforms.value = detail ? [...detail.platforms] : [];
  platformSelect.value = '';
  customPlatform.value = '';
  customPlatformMode.value = false;
  for (const f of SECRET_FIELDS) {
    const value = detail?.secrets[f.key] ?? '';
    secrets[f.key] = value;
    initialSecrets[f.key] = value;
    visible[f.key] = false;
  }
}

watch(
  [() => store.editorOpen, () => store.editorDetail],
  ([open]) => {
    if (!open || store.editorLoading) return;
    hydrate();
  },
  { immediate: true },
);

function addPlatform(value: string): void {
  const next = value.trim();
  if (!next) return;
  if (!platforms.value.includes(next)) platforms.value = [...platforms.value, next];
}

function removePlatform(value: string): void {
  platforms.value = platforms.value.filter((p) => p !== value);
}

/**
 * 用户手选关联企业：自动回填企业名称（与占位提示一致）。
 * 走 @change 而非 watch companyId：编辑回显（hydrate）不触发，避免覆盖库内已存名称；
 * 切回「不关联」时不清空名称，保留用户已填内容。
 */
function onCompanyPicked(): void {
  const hit = store.companies.find((c) => c.id === form.companyId);
  if (hit) form.company = hit.name;
}

/** 下拉选择：命中枚举直接加入；选「自定义…」则展开输入框并聚焦 */
function onPlatformSelect(): void {
  const value = platformSelect.value;
  platformSelect.value = '';
  if (!value) return;
  if (value === CUSTOM_PLATFORM_VALUE) {
    customPlatformMode.value = true;
    void nextTick(() => customPlatformRef.value?.focus());
    return;
  }
  addPlatform(value);
}

/** 提交自定义平台（回车 / 点「添加」/ 保存前统一调用）；无内容时仅收起输入框 */
function commitCustomPlatform(): void {
  const next = customPlatform.value.trim();
  customPlatform.value = '';
  customPlatformMode.value = false;
  platformSelect.value = '';
  if (next) addPlatform(next);
}

/** 自定义输入回车提交；中文输入法组词中（isComposing）的回车用于选词，不能当作添加 */
function onCustomPlatformKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.key !== 'Enter') return;
  event.preventDefault();
  commitCustomPlatform();
}

async function submit(): Promise<void> {
  if (!canSave.value) return;
  // 自定义输入框里已填但未回车的值一并入库，避免「填了却没保存」
  if (customPlatform.value.trim()) commitCustomPlatform();
  // 仅回传已变更的敏感字段：未改动不发送（保持原值），改为空串则清空，其余覆盖
  const secretsPatch: Partial<Record<ShopAccountSecretField, string>> = {};
  for (const f of SECRET_FIELDS) {
    if (secrets[f.key] !== initialSecrets[f.key]) secretsPatch[f.key] = secrets[f.key];
  }
  const payload: ShopAccountUpsertInput = {
    id: store.editorDetail?.id,
    email: form.email.trim(),
    phone: form.phone.trim(),
    company: form.company.trim(),
    // 关联企业 id（0 = 未关联）：显式传入，选中后保存企业 ID
    companyId: form.companyId,
    alipay: form.alipay.trim(),
    ziniaoAccount: form.ziniaoAccount.trim(),
    erpAccount: form.erpAccount.trim(),
    // 展开为纯数组：ref 的 .value 是响应式代理，直接过 IPC 会触发
    // "An object could not be cloned."（结构化克隆不支持 Proxy）
    platforms: [...platforms.value],
    openedAt: form.openedAt,
    status: form.status,
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
          <span>{{ isEdit ? '编辑店铺套' : '新增店铺套' }}</span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="store.closeEditor()">
          <IconGlyph name="x" :size="14" />
        </button>
      </header>

      <div v-if="store.editorLoading" class="editor-loading">加载中…</div>

      <div v-else class="editor-body">
        <section class="form-section">
          <h3 class="section-title">基本信息</h3>
          <div class="form-row">
            <label class="form-label required">店铺邮箱</label>
            <div class="field-wrap">
              <input
                v-model="form.email"
                class="wb-input"
                type="text"
                placeholder="店铺主邮箱，作为店铺套的唯一标识"
              />
              <p v-if="form.email && !emailValid" class="field-error">邮箱格式不正确</p>
              <p v-else class="field-hint">同一邮箱视为同一套店铺，重复将无法保存</p>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">状态</label>
            <div class="status-picker">
              <button
                v-for="s in STATUS_META"
                :key="s.value"
                class="status-option"
                :class="{ 'is-active': form.status === s.value }"
                type="button"
                @click="form.status = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">关联企业</label>
            <div class="field-wrap">
              <select v-model.number="form.companyId" class="wb-input company-select" @change="onCompanyPicked">
                <option :value="0">不关联</option>
                <option
                  v-if="form.companyId > 0 && !companyExists"
                  :value="form.companyId"
                >
                  已删除的企业（ID {{ form.companyId }}）
                </option>
                <option v-for="c in store.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <p v-if="store.companies.length === 0" class="field-hint">
                企业管理中还没有企业，可在「企业管理」页签新增后在此关联
              </p>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">企业名称</label>
            <input
              v-model="form.company"
              class="wb-input"
              type="text"
              placeholder="营业执照主体名称；选择关联企业后自动回填"
            />
          </div>

          <div class="form-row">
            <label class="form-label">关联手机号</label>
            <input v-model="form.phone" class="wb-input" type="text" placeholder="该店铺绑定的手机号" />
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
            <label class="form-label">关联平台</label>
            <div class="field-wrap">
              <div v-if="platforms.length" class="chip-input">
                <span v-for="p in platforms" :key="p" class="chip">
                  {{ p }}
                  <button
                    class="chip-close"
                    type="button"
                    :title="`移除 ${p}`"
                    @click="removePlatform(p)"
                  >
                    ×
                  </button>
                </span>
              </div>
              <div class="platform-picker">
                <select
                  v-model="platformSelect"
                  class="wb-input platform-select"
                  title="从枚举中选择平台"
                  @change="onPlatformSelect"
                >
                  <option value="">{{ platforms.length ? '＋ 继续添加平台…' : '＋ 选择平台…' }}</option>
                  <option v-for="p in platformChoices" :key="p" :value="p">{{ p }}</option>
                  <option :value="CUSTOM_PLATFORM_VALUE">自定义…</option>
                </select>
                <div v-if="customPlatformMode" class="custom-platform">
                  <input
                    ref="customPlatformRef"
                    v-model="customPlatform"
                    class="wb-input"
                    type="text"
                    placeholder="输入平台名称后回车添加"
                    @keydown="onCustomPlatformKeydown"
                  />
                  <button class="btn-ghost btn-mini" type="button" @click="commitCustomPlatform">
                    添加
                  </button>
                </div>
              </div>
              <p class="field-hint">
                枚举里没有的平台选「自定义…」手动添加；单平台只填一个，跨平台复用时填多个。
              </p>
            </div>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">账号信息</h3>
          <div class="form-row">
            <label class="form-label">关联支付宝</label>
            <input v-model="form.alipay" class="wb-input" type="text" placeholder="运费扣款支付宝账号" />
          </div>
          <div class="form-row">
            <label class="form-label">紫鸟账号</label>
            <input
              v-model="form.ziniaoAccount"
              class="wb-input"
              type="text"
              placeholder="紫鸟浏览器登录账号"
            />
          </div>
          <div class="form-row">
            <label class="form-label">ERP账号</label>
            <input v-model="form.erpAccount" class="wb-input" type="text" placeholder="ERP 系统登录账号" />
          </div>
        </section>

        <section class="form-section">
          <div class="section-head">
            <h3 class="section-title">敏感信息</h3>
            <span class="section-tip">
              <IconGlyph name="lock" :size="12" />
              留空表示不修改；加密存储于本机
            </span>
          </div>
          <div v-for="f in SECRET_FIELDS" :key="f.key" class="form-row">
            <label class="form-label">
              {{ f.label }}
              <span v-if="isConfigured(f.key)" class="saved-badge">已保存</span>
            </label>
            <div class="secret-input">
              <input
                v-model="secrets[f.key]"
                class="wb-input"
                :type="visible[f.key] ? 'text' : 'password'"
                :placeholder="isConfigured(f.key) ? '已保存，留空则保持不变' : `填写${f.label}`"
                autocomplete="new-password"
              />
              <button
                class="icon-btn"
                type="button"
                :title="visible[f.key] ? '隐藏' : '显示'"
                @click="visible[f.key] = !visible[f.key]"
              >
                <IconGlyph :name="visible[f.key] ? 'eye-off' : 'eye'" :size="13" />
              </button>
            </div>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">备注信息</h3>
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
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-title {
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--wb-text);
}
.section-head .section-title {
  margin-bottom: 10px;
}
.section-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.form-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.form-label {
  flex-shrink: 0;
  width: 86px;
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
/* 日期控件：底色/文字/日历图标跟随宿主主题（UA 默认在深色主题下会渲染浅色面板 + 深色图标，几乎看不清）
   全局 @layer components 已统一处理，这里仅显式纠正 color-scheme，避免被上层样式覆盖 */
.date-input {
  color-scheme: light;
}
:global([data-theme='dark']) .date-input {
  color-scheme: dark;
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
.chip-input {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 8px;
  border-radius: 4px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11.5px;
}
.chip-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.chip-input + .platform-picker {
  margin-top: 6px;
}
.platform-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* select 已带 .wb-input（边框/圆角/focus 环），这里只补抽屉内的紧凑尺寸 */
.platform-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.company-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.custom-platform {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.custom-platform input {
  flex: 1 1 auto;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
}
/* 复合选择器提高优先级，覆盖下方 .btn-ghost 的 padding */
.custom-platform .btn-mini {
  flex-shrink: 0;
  padding: 0 12px;
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
</style>
