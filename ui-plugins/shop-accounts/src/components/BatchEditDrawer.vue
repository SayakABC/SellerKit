<script setup lang="ts">
// 批量修改抽屉：对已勾选的 N 套店铺应用同一组字段修改。
// - 仅非敏感字段（状态 / 手机号 / 支付宝 / 紫鸟账号 / ERP账号 / 企业 / 标签 / 备注 / 平台）
// - 密码类字段与主邮箱（email）不支持批量覆盖
// - 每个字段独立启用：未启用 = 不改；启用后按「覆盖 / 追加」语义提交
// - 平台支持 覆盖 / 追加 / 移除 三种集合操作
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { PLATFORM_OPTIONS, STATUS_META, useShopAccountsStore } from '../store';
import IconGlyph from './IconGlyph.vue';
import type { ShopAccountBatchFieldPatch, ShopAccountStatus } from '@/types';

const store = useShopAccountsStore();

/** 平台下拉中「自定义」的哨兵值（与 AccountEditor 口径一致） */
const CUSTOM_PLATFORM_VALUE = '__custom__';

type StrMode = 'set' | 'append';
type PlatformMode = 'set' | 'append' | 'remove';

/** 批量修改中「仅覆盖」的单值账号字段（唯一标识，无追加语义） */
type AccountBatchFieldKey = 'phone' | 'alipay' | 'ziniaoAccount' | 'erpAccount';

interface AccountBatchField {
  key: AccountBatchFieldKey;
  label: string;
  shortLabel: string;
  placeholder: string;
}

const ACCOUNT_BATCH_FIELDS: AccountBatchField[] = [
  { key: 'phone', label: '关联手机号', shortLabel: '手机号', placeholder: '该店铺套绑定的手机号' },
  { key: 'alipay', label: '关联支付宝', shortLabel: '支付宝', placeholder: '运费扣款支付宝账号' },
  { key: 'ziniaoAccount', label: '紫鸟账号', shortLabel: '紫鸟账号', placeholder: '紫鸟浏览器登录账号' },
  { key: 'erpAccount', label: 'ERP 账号', shortLabel: 'ERP 账号', placeholder: 'ERP 系统登录账号' },
];

const form = reactive({
  statusEnabled: false,
  status: 'active' as ShopAccountStatus,
  accountEnabled: {
    phone: false,
    alipay: false,
    ziniaoAccount: false,
    erpAccount: false,
  } as Record<AccountBatchFieldKey, boolean>,
  accountValue: {
    phone: '',
    alipay: '',
    ziniaoAccount: '',
    erpAccount: '',
  } as Record<AccountBatchFieldKey, string>,
  companyEnabled: false,
  /** 选中的关联企业 id：-1 = 尚未选择（不提交）；0 = 不关联（清空）；> 0 = 该企业 */
  companyId: -1,
  tagsEnabled: false,
  tagsMode: 'set' as StrMode,
  tagsValue: '',
  noteEnabled: false,
  noteMode: 'set' as StrMode,
  noteValue: '',
  platformsEnabled: false,
  platformsMode: 'set' as PlatformMode,
});

const platforms = ref<string[]>([]);
const platformSelect = ref('');
const customPlatform = ref('');
const customPlatformMode = ref(false);
const customPlatformRef = ref<HTMLInputElement | null>(null);

const modeOptions: { value: StrMode; label: string }[] = [
  { value: 'set', label: '覆盖' },
  { value: 'append', label: '追加' },
];

const platformModeOptions: { value: PlatformMode; label: string }[] = [
  { value: 'set', label: '覆盖' },
  { value: 'append', label: '追加' },
  { value: 'remove', label: '移除' },
];

/** 平台候选 = 预设枚举 + 历史自定义平台（去重、排除已选） */
const platformChoices = computed(() => {
  const picked = new Set(platforms.value);
  const extras = store.summary.platforms
    .map((p) => p.platform)
    .filter((p) => !!p && !PLATFORM_OPTIONS.includes(p) && !picked.has(p));
  return [...PLATFORM_OPTIONS.filter((p) => !picked.has(p)), ...extras];
});

/** 是否有可提交的修改项（至少启用一个字段且其值非空） */
const hasPatch = computed(
  () =>
    (form.statusEnabled && !!form.status) ||
    ACCOUNT_BATCH_FIELDS.some(
      (f) => form.accountEnabled[f.key] && !!form.accountValue[f.key].trim(),
    ) ||
    (form.companyEnabled && form.companyId >= 0) ||
    (form.tagsEnabled && !!form.tagsValue.trim()) ||
    (form.noteEnabled && !!form.noteValue.trim()) ||
    (form.platformsEnabled && platforms.value.length > 0),
);

const canSubmit = computed(() => hasPatch.value && !store.batchSaving && store.selectionCount > 0);

/** 汇总预览文案（确认按钮上直接展示影响范围） */
const summaryText = computed(() => {
  const parts: string[] = [];
  if (form.statusEnabled) parts.push('状态');
  for (const f of ACCOUNT_BATCH_FIELDS) {
    if (form.accountEnabled[f.key] && form.accountValue[f.key].trim()) parts.push(f.shortLabel);
  }
  if (form.companyEnabled && form.companyId >= 0) parts.push('关联企业');
  if (form.tagsEnabled && form.tagsValue.trim()) parts.push('标签');
  if (form.noteEnabled && form.noteValue.trim()) parts.push('备注');
  if (form.platformsEnabled && platforms.value.length) parts.push('平台');
  return parts.length ? `将修改：${parts.join('、')}` : '未启用任何修改项';
});

watch(
  () => store.batchEditOpen,
  (open) => {
    if (!open) return;
    resetForm();
    // 候选与企业管理列表同源：每次打开刷新，新建的企业立即可选
    void store.loadCompanies();
  },
);

function resetForm(): void {
  form.statusEnabled = false;
  form.status = 'active';
  for (const f of ACCOUNT_BATCH_FIELDS) {
    form.accountEnabled[f.key] = false;
    form.accountValue[f.key] = '';
  }
  form.companyEnabled = false;
  form.companyId = -1;
  form.tagsEnabled = false;
  form.tagsMode = 'set';
  form.tagsValue = '';
  form.noteEnabled = false;
  form.noteMode = 'set';
  form.noteValue = '';
  form.platformsEnabled = false;
  form.platformsMode = 'set';
  platforms.value = [];
  platformSelect.value = '';
  customPlatform.value = '';
  customPlatformMode.value = false;
}

function addPlatform(value: string): void {
  const next = value.trim();
  if (!next || platforms.value.includes(next)) return;
  platforms.value = [...platforms.value, next];
}

function removePlatform(value: string): void {
  platforms.value = platforms.value.filter((p) => p !== value);
}

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

function commitCustomPlatform(): void {
  const next = customPlatform.value.trim();
  customPlatform.value = '';
  customPlatformMode.value = false;
  if (next) addPlatform(next);
}

function onCustomPlatformKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.key !== 'Enter') return;
  event.preventDefault();
  commitCustomPlatform();
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  if (customPlatform.value.trim()) commitCustomPlatform();

  const patch: ShopAccountBatchFieldPatch = {};
  if (form.statusEnabled && form.status) patch.status = form.status;
  for (const f of ACCOUNT_BATCH_FIELDS) {
    const value = form.accountValue[f.key].trim();
    if (form.accountEnabled[f.key] && value) patch[f.key] = value;
  }
  if (form.companyEnabled && form.companyId >= 0) {
    // 0 = 批量取消关联；> 0 = 批量覆盖为该企业（企业名称由主进程按企业库同步写入）
    patch.companyId = form.companyId;
  }
  if (form.tagsEnabled && form.tagsValue.trim()) {
    patch.tags = { mode: form.tagsMode, value: form.tagsValue.trim() };
  }
  if (form.noteEnabled && form.noteValue.trim()) {
    patch.note = { mode: form.noteMode, value: form.noteValue.trim() };
  }
  if (form.platformsEnabled && platforms.value.length) {
    patch.platforms = { mode: form.platformsMode, values: [...platforms.value] };
  }

  await store.batchUpdate(patch);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') store.closeBatchEdit();
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="editor-overlay" @click.self="store.closeBatchEdit()">
    <aside class="editor-drawer">
      <header class="editor-head">
        <div class="editor-title">
          <IconGlyph name="edit" :size="16" />
          <span>批量修改</span>
          <span class="title-count">已选 {{ store.selectionCount }} 套</span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="store.closeBatchEdit()">
          <IconGlyph name="x" :size="14" />
        </button>
      </header>

      <div class="editor-body">
        <p class="batch-tip">
          勾选要修改的字段并填写内容，未勾选的字段保持原值不变；手机号 / 支付宝 / 紫鸟账号 /
          ERP 账号为唯一标识，仅支持覆盖；关联企业从「企业管理」列表中选择（仅覆盖，选「不关联」即清空）；
          密码类敏感字段与主邮箱不支持批量修改。
        </p>

        <section class="form-section">
          <h3 class="section-title">状态</h3>
          <div class="field-block" :class="{ 'is-enabled': form.statusEnabled }">
            <label class="field-toggle">
              <input v-model="form.statusEnabled" type="checkbox" />
              <span>修改状态</span>
            </label>
            <template v-if="form.statusEnabled">
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
              <p class="field-hint">将所选店铺套的状态统一覆盖为该值</p>
            </template>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">账号信息（仅覆盖）</h3>
          <div
            v-for="f in ACCOUNT_BATCH_FIELDS"
            :key="f.key"
            class="field-block"
            :class="{ 'is-enabled': form.accountEnabled[f.key] }"
          >
            <label class="field-toggle">
              <input v-model="form.accountEnabled[f.key]" type="checkbox" />
              <span>{{ f.label }}</span>
            </label>
            <template v-if="form.accountEnabled[f.key]">
              <input
                v-model="form.accountValue[f.key]"
                class="wb-input"
                type="text"
                :placeholder="f.placeholder"
              />
              <p class="field-hint">将所选店铺套的{{ f.label }}统一覆盖为该值</p>
            </template>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">文本字段</h3>

          <div class="field-block" :class="{ 'is-enabled': form.companyEnabled }">
            <label class="field-toggle">
              <input v-model="form.companyEnabled" type="checkbox" />
              <span>关联企业</span>
            </label>
            <template v-if="form.companyEnabled">
              <select v-model.number="form.companyId" class="wb-input company-select">
                <option :value="-1">选择企业…</option>
                <option :value="0">不关联（清空关联企业）</option>
                <option v-for="c in store.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <p class="field-hint">
                候选取自「企业管理」列表，仅支持覆盖（企业是引用关系，无追加语义）；选「不关联」将清空所选店铺套的关联企业。
              </p>
            </template>
          </div>

          <div class="field-block" :class="{ 'is-enabled': form.tagsEnabled }">
            <label class="field-toggle">
              <input v-model="form.tagsEnabled" type="checkbox" />
              <span>标签</span>
            </label>
            <template v-if="form.tagsEnabled">
              <div class="mode-picker">
                <button
                  v-for="m in modeOptions"
                  :key="m.value"
                  class="mode-option"
                  :class="{ 'is-active': form.tagsMode === m.value }"
                  type="button"
                  @click="form.tagsMode = m.value"
                >
                  {{ m.label }}
                </button>
              </div>
              <input
                v-model="form.tagsValue"
                class="wb-input"
                type="text"
                placeholder="多个标签用空格分隔（如：美国站 主营服装）"
              />
            </template>
          </div>

          <div class="field-block" :class="{ 'is-enabled': form.noteEnabled }">
            <label class="field-toggle">
              <input v-model="form.noteEnabled" type="checkbox" />
              <span>备注</span>
            </label>
            <template v-if="form.noteEnabled">
              <div class="mode-picker">
                <button
                  v-for="m in modeOptions"
                  :key="m.value"
                  class="mode-option"
                  :class="{ 'is-active': form.noteMode === m.value }"
                  type="button"
                  @click="form.noteMode = m.value"
                >
                  {{ m.label }}
                </button>
              </div>
              <textarea
                v-model="form.noteValue"
                class="wb-input"
                rows="3"
                :placeholder="form.noteMode === 'append' ? '追加到现有备注末尾（换行分隔）' : '覆盖现有备注'"
              />
            </template>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">关联平台</h3>
          <div class="field-block" :class="{ 'is-enabled': form.platformsEnabled }">
            <label class="field-toggle">
              <input v-model="form.platformsEnabled" type="checkbox" />
              <span>修改关联平台</span>
            </label>
            <template v-if="form.platformsEnabled">
              <div class="mode-picker">
                <button
                  v-for="m in platformModeOptions"
                  :key="m.value"
                  class="mode-option"
                  :class="{ 'is-active': form.platformsMode === m.value }"
                  type="button"
                  @click="form.platformsMode = m.value"
                >
                  {{ m.label }}
                </button>
              </div>
              <p class="field-hint">
                {{
                  form.platformsMode === 'set'
                    ? '将所选店铺套的关联平台整体替换为下方所选平台'
                    : form.platformsMode === 'append'
                      ? '将下方平台并入所选店铺套已有的关联平台（自动去重）'
                      : '从所选店铺套已有的关联平台中移除下方所选平台'
                }}
              </p>
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
                    @change="onPlatformSelect"
                  >
                    <option value="">选择平台…</option>
                    <option v-for="p in platformChoices" :key="p" :value="p">{{ p }}</option>
                    <option :value="CUSTOM_PLATFORM_VALUE">自定义…</option>
                  </select>
                  <div v-if="customPlatformMode" class="custom-platform">
                    <input
                      ref="customPlatformRef"
                      v-model="customPlatform"
                      class="wb-input"
                      type="text"
                      placeholder="输入自定义平台名，回车确认"
                      @keydown="onCustomPlatformKeydown"
                    />
                    <button class="mini-btn" type="button" @click="commitCustomPlatform">
                      添加
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </section>
      </div>

      <footer class="editor-foot">
        <div class="foot-summary">{{ summaryText }}</div>
        <button class="btn-ghost" type="button" @click="store.closeBatchEdit()">取消</button>
        <button class="btn-primary" type="button" :disabled="!canSubmit" @click="submit">
          {{ store.batchSaving ? '提交中…' : `应用到 ${store.selectionCount} 套` }}
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
  width: 520px;
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
}
.title-count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 11.5px;
  font-weight: 500;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}
.editor-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.batch-tip {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-size: 12px;
  line-height: 1.6;
}
.form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text-muted);
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-surface-2);
}
.field-block.is-enabled {
  border-color: var(--wb-primary);
}
.field-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
.field-toggle input[type='checkbox'] {
  accent-color: var(--wb-primary);
  cursor: pointer;
}
.field-hint {
  margin: 0;
  color: var(--wb-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}
.field-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.form-block .wb-input,
.wb-input {
  height: 32px;
  padding: 0 10px;
}
textarea.wb-input {
  height: auto;
  min-height: 64px;
  line-height: 1.55;
  resize: vertical;
}
/* 模式切换（覆盖 / 追加 / 移除） */
.mode-picker {
  display: inline-flex;
  gap: 4px;
  width: fit-content;
  padding: 2px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface);
}
.mode-option {
  padding: 3px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 12px;
  cursor: pointer;
}
.mode-option.is-active {
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-weight: 600;
}
/* 状态选择（复用 AccountEditor 语义） */
.status-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.status-option {
  padding: 4px 14px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 12px;
  cursor: pointer;
}
.status-option.is-active {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
  font-weight: 600;
}
/* 平台 chip */
.chip-input {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  font-size: 12px;
}
.chip-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.chip-close:hover {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
.platform-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.company-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.platform-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.custom-platform {
  display: flex;
  gap: 6px;
}
.custom-platform .wb-input {
  flex: 1 1 auto;
  min-width: 0;
}
.mini-btn {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12px;
  cursor: pointer;
}
.mini-btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.editor-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 12px 18px;
  border-top: 1px solid var(--wb-border);
}
.foot-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text-muted);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
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
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.btn-ghost:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
</style>
