<script setup lang="ts">
// 批量修改抽屉：对已勾选的 N 家店铺应用同一组字段修改（2026-10-22 物理合并后裁剪）：
// - 可批量：状态 / 关联企业 / 紫鸟工具账号 / ERP 工具账号 / 标签 / 备注
// - 手机号 / 支付宝已随企业表迁出（在企业页维护，不在店铺行上批量改）
// - 平台固定为速卖通，不再有平台集合操作
// - 密码类字段与主邮箱（email）不支持批量覆盖（见 src/types.ts 该接口头注释）
// - 每个字段独立启用：未启用 = 不改；工具账号 / 企业为引用关系，仅覆盖（0 = 取消关联）
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue';
import { STATUS_META, useShopAccountsStore } from '../store';
import IconGlyph from '@/core/components/IconGlyph.vue';
import type { ShopAccountBatchFieldPatch, ShopAccountStatus } from '@/types';

const store = useShopAccountsStore();

const form = reactive({
  statusEnabled: false,
  status: 'active' as ShopAccountStatus,
  /** 选中的关联企业 id：-1 = 尚未选择（不提交）；0 = 不关联（清空）；> 0 = 该企业 */
  companyEnabled: false,
  companyId: -1,
  /** 工具账号同理：-1 = 不提交；0 = 取消关联；> 0 = 该工具账号 */
  ziniaoEnabled: false,
  ziniaoAccountId: -1,
  erpEnabled: false,
  erpAccountId: -1,
  tagsEnabled: false,
  tagsMode: 'set' as 'set' | 'append',
  tagsValue: '',
  noteEnabled: false,
  noteMode: 'set' as 'set' | 'append',
  noteValue: '',
});

const modeOptions: { value: 'set' | 'append'; label: string }[] = [
  { value: 'set', label: '覆盖' },
  { value: 'append', label: '追加' },
];

/** 是否有可提交的修改项（至少启用一个字段且其值有效） */
const hasPatch = computed(
  () =>
    (form.statusEnabled && !!form.status) ||
    (form.companyEnabled && form.companyId >= 0) ||
    (form.ziniaoEnabled && form.ziniaoAccountId >= 0) ||
    (form.erpEnabled && form.erpAccountId >= 0) ||
    (form.tagsEnabled && !!form.tagsValue.trim()) ||
    (form.noteEnabled && !!form.noteValue.trim()),
);

const canSubmit = computed(() => hasPatch.value && !store.batchSaving && store.selectionCount > 0);

/** 紫鸟 / ERP 候选 = 工具账号库里对应 kind 的条目（usageCount 提示被几家店使用） */
function toolOptions(kind: 'ziniao' | 'erp') {
  return store.toolAccounts.filter((t) => t.kind === kind);
}

/** 汇总预览文案（确认按钮上直接展示影响范围） */
const summaryText = computed(() => {
  const parts: string[] = [];
  if (form.statusEnabled) parts.push('状态');
  if (form.companyEnabled && form.companyId >= 0) parts.push('关联企业');
  if (form.ziniaoEnabled && form.ziniaoAccountId >= 0) parts.push('紫鸟账号');
  if (form.erpEnabled && form.erpAccountId >= 0) parts.push('ERP 账号');
  if (form.tagsEnabled && form.tagsValue.trim()) parts.push('标签');
  if (form.noteEnabled && form.noteValue.trim()) parts.push('备注');
  return parts.length ? `将修改：${parts.join('、')}` : '未启用任何修改项';
});

watch(
  () => store.batchEditOpen,
  (open) => {
    if (!open) return;
    resetForm();
    // 候选与企业管理 / 工具账号列表同源：每次打开刷新，新建的立即可选
    void store.loadCompanies();
    void store.loadToolAccounts();
  },
);

function resetForm(): void {
  form.statusEnabled = false;
  form.status = 'active';
  form.companyEnabled = false;
  form.companyId = -1;
  form.ziniaoEnabled = false;
  form.ziniaoAccountId = -1;
  form.erpEnabled = false;
  form.erpAccountId = -1;
  form.tagsEnabled = false;
  form.tagsMode = 'set';
  form.tagsValue = '';
  form.noteEnabled = false;
  form.noteMode = 'set';
  form.noteValue = '';
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;

  const patch: ShopAccountBatchFieldPatch = {};
  if (form.statusEnabled && form.status) patch.status = form.status;
  // 0 = 批量取消关联；> 0 = 批量覆盖（企业名称 / 工具登录名由主进程按引用同步写入）
  if (form.companyEnabled && form.companyId >= 0) patch.companyId = form.companyId;
  if (form.ziniaoEnabled && form.ziniaoAccountId >= 0) patch.ziniaoAccountId = form.ziniaoAccountId;
  if (form.erpEnabled && form.erpAccountId >= 0) patch.erpAccountId = form.erpAccountId;
  if (form.tagsEnabled && form.tagsValue.trim()) {
    patch.tags = { mode: form.tagsMode, value: form.tagsValue.trim() };
  }
  if (form.noteEnabled && form.noteValue.trim()) {
    patch.note = { mode: form.noteMode, value: form.noteValue.trim() };
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
          <span class="title-count">已选 {{ store.selectionCount }} 家</span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="store.closeBatchEdit()">
          <IconGlyph name="x" :size="14" />
        </button>
      </header>

      <div class="editor-body">
        <p class="batch-tip">
          勾选要修改的字段并填写内容，未勾选的字段保持原值不变；企业与紫鸟 / ERP 是从名单里选引用
          （仅覆盖，选「不关联」即清空）；手机号 / 支付宝在企业上维护、密码与主邮箱不支持批量修改。
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
              <p class="field-hint">将所选店铺的状态统一覆盖为该值</p>
            </template>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">引用关系（仅覆盖）</h3>

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
              <p class="field-hint">候选取自「企业」名单；选「不关联」将清空所选店铺的关联企业。</p>
            </template>
          </div>

          <div class="field-block" :class="{ 'is-enabled': form.ziniaoEnabled }">
            <label class="field-toggle">
              <input v-model="form.ziniaoEnabled" type="checkbox" />
              <span>紫鸟账号</span>
            </label>
            <template v-if="form.ziniaoEnabled">
              <select v-model.number="form.ziniaoAccountId" class="wb-input company-select">
                <option :value="-1">选择紫鸟账号…</option>
                <option :value="0">不关联（清空紫鸟关联）</option>
                <option v-for="t in toolOptions('ziniao')" :key="t.id" :value="t.id">
                  {{ t.account }}（{{ t.usageCount }} 家店）
                </option>
              </select>
              <p class="field-hint">
                一套紫鸟可以管多家店，改的是「用哪套紫鸟」，不是紫鸟的登录名本身（在「工具账号」页维护）。
              </p>
            </template>
          </div>

          <div class="field-block" :class="{ 'is-enabled': form.erpEnabled }">
            <label class="field-toggle">
              <input v-model="form.erpEnabled" type="checkbox" />
              <span>ERP 账号</span>
            </label>
            <template v-if="form.erpEnabled">
              <select v-model.number="form.erpAccountId" class="wb-input company-select">
                <option :value="-1">选择 ERP 账号…</option>
                <option :value="0">不关联（清空 ERP 关联）</option>
                <option v-for="t in toolOptions('erp')" :key="t.id" :value="t.id">
                  {{ t.account }}（{{ t.usageCount }} 家店）
                </option>
              </select>
              <p class="field-hint">
                同紫鸟：改的是「用哪套 ERP」；登录名与密码在「工具账号」页维护。
              </p>
            </template>
          </div>
        </section>

        <section class="form-section">
          <h3 class="section-title">文本字段</h3>

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
      </div>

      <footer class="editor-foot">
        <div class="foot-summary">{{ summaryText }}</div>
        <button class="btn-ghost" type="button" @click="store.closeBatchEdit()">取消</button>
        <button class="btn-primary" type="button" :disabled="!canSubmit" @click="submit">
          {{ store.batchSaving ? '提交中…' : `应用到 ${store.selectionCount} 家` }}
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
/* 模式切换（覆盖 / 追加） */
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
.company-select {
  height: 32px;
  padding: 0 8px;
  font-size: 12.5px;
  cursor: pointer;
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
