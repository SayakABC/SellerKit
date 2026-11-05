<script setup lang="ts">
// 「基础数据 › 店铺账号 › 工具账号」—— 紫鸟 / ERP 登录名 + 密码库（2026-10-22 物理合并新增）。
//
// 为什么单列一页：一套紫鸟 / ERP 可以管多家店。原先这些登录名与密码存在**每家店的行上**，
// 每新增一家店就要重新敲一遍 —— 本页把"工具登录"提成一等公民，店里只选引用（账号密码自动带出）。
//
// 纪律：
//   ① 密码只进不出：写入后由主进程加密落库，明文永不回读；本页只有「设置密码 / 改密码」，
//      展示位是「已设置 / 未设置」，与账号库行内的密码列同一口径。
//   ② 删除保护：被 N 家店引用（usageCount > 0）时不可删除 —— 主进程硬拦，本页按钮同步置灰并
//      说明原因（"灰按钮无灰因"是本仓既有结论）。
//   ③ kind（紫鸟 / ERP）新增后不可改：改 kind 等于把一条登录记录偷换成另一类工具的登录记录，
//      引用它的店铺不会跟着变。要换就新建一条、店里改选引用。
import { computed, onMounted, reactive, ref } from 'vue';
import { toast } from '@/core/services/toast';
import {
  toolAccountDelete,
  toolAccountList,
  toolAccountReveal,
  toolAccountUpsert,
} from '@/core/services/ipc';
import { useShopAccountsStore } from '../store';
import IconGlyph from '@/core/components/IconGlyph.vue';
import type { ToolAccountItem, ToolAccountKind } from '@/types';

const store = useShopAccountsStore();

const rows = ref<ToolAccountItem[]>([]);
const loading = ref(true);
const loadError = ref('');
const kindFilter = ref<ToolAccountKind | ''>('');

/** 密码明文的 8 秒展示窗（与账号库行内「看一眼」同纪律：看完自动盖回） */
const revealed = ref<Map<number, string>>(new Map());
const revealTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 编辑抽屉：id=0 为新增；kind 新增后不可改 */
const editor = reactive({
  open: false,
  id: 0,
  kind: 'ziniao' as ToolAccountKind,
  account: '',
  note: '',
  /** 留空 = 不改密码（编辑态）；新增时必填 */
  password: '',
});

const filtered = computed(() =>
  kindFilter.value ? rows.value.filter((r) => r.kind === kindFilter.value) : rows.value,
);

const ziniaoCount = computed(() => rows.value.filter((r) => r.kind === 'ziniao').length);
const erpCount = computed(() => rows.value.filter((r) => r.kind === 'erp').length);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await toolAccountList({ kind: kindFilter.value || undefined });
    if (!res.success) throw new Error(res.error || '读取失败');
    rows.value = res.data ?? [];
    // 保持两侧数据源一致：store.toolAccounts 是编辑器 / 批量 / 筛选下拉的取处
    await store.loadToolAccounts();
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function kindLabel(kind: ToolAccountKind): string {
  return kind === 'ziniao' ? '紫鸟' : 'ERP';
}

function openCreate(kind: ToolAccountKind): void {
  editor.open = true;
  editor.id = 0;
  editor.kind = kind;
  editor.account = '';
  editor.note = '';
  editor.password = '';
}

function openEdit(row: ToolAccountItem): void {
  editor.open = true;
  editor.id = row.id;
  editor.kind = row.kind;
  editor.account = row.account;
  editor.note = row.note;
  // 密码不回读：留空 = 保持原值
  editor.password = '';
}

function closeEditor(): void {
  editor.open = false;
}

/** 保存被拦下的原因（渲染在保存同行；'' = 可保存） */
const editorBlocked = computed(() => {
  if (!editor.account.trim()) return '登录名不能为空';
  if (editor.id === 0 && !editor.password.trim()) return '首次保存必须设置密码（之后可单独改）';
  return '';
});

async function submit(): Promise<void> {
  if (editorBlocked.value) return;
  const res = await toolAccountUpsert({
    id: editor.id || undefined,
    kind: editor.id ? undefined : editor.kind,
    account: editor.account.trim(),
    note: editor.note.trim(),
    password: editor.password.trim() || undefined,
  });
  if (!res.success) {
    toast(res.error || '保存失败', 'error');
    return;
  }
  toast(editor.id ? '已更新' : `已新增${kindLabel(editor.kind)}账号`, 'success');
  closeEditor();
  await load();
}

/** 「看一眼」密码：8 秒后自动盖回；同一账号重复点先重置计时 */
async function peekPassword(row: ToolAccountItem): Promise<void> {
  if (revealed.value.has(row.id)) {
    revealed.value.delete(row.id);
    const t = revealTimers.get(row.id);
    if (t) clearTimeout(t);
    revealTimers.delete(row.id);
    return;
  }
  const res = await toolAccountReveal(row.id);
  if (!res.success || !res.data) {
    toast(res.error || '读取失败', 'error');
    return;
  }
  const next = new Map(revealed.value);
  next.set(row.id, res.data.value);
  revealed.value = next;
  const t = setTimeout(() => {
    const m = new Map(revealed.value);
    m.delete(row.id);
    revealed.value = m;
    revealTimers.delete(row.id);
  }, 8000);
  revealTimers.set(row.id, t);
}

async function remove(row: ToolAccountItem): Promise<void> {
  if (row.usageCount > 0) return; // 主进程也硬拦；这里只是不让按钮可点
  const res = await toolAccountDelete(row.id);
  if (!res.success) {
    toast(res.error || '删除失败', 'error');
    return;
  }
  toast(`已删除${kindLabel(row.kind)}账号「${row.account}」`, 'success');
  await load();
}

onMounted(load);
</script>

<template>
  <div class="tools-panel" data-act="tools-panel">
    <div class="tools-bar">
      <div class="tools-chips" data-act="tools-stats">
        <span class="tools-chip">紫鸟 <b>{{ ziniaoCount }}</b> 套</span>
        <span class="tools-chip">ERP <b>{{ erpCount }}</b> 套</span>
        <span class="tools-chip is-dim">被店铺引用数实时统计</span>
      </div>
      <div class="tools-acts">
        <select v-model="kindFilter" class="wb-input tools-kind" data-act="tools-kind-filter" @change="load">
          <option value="">全部类型</option>
          <option value="ziniao">紫鸟</option>
          <option value="erp">ERP</option>
        </select>
        <button class="wb-btn wb-btn--primary" type="button" data-act="tools-new" @click="openCreate('ziniao')">
          新建工具账号
        </button>
      </div>
    </div>

    <p v-if="loadError" class="wb-notice wb-notice--error" data-act="tools-error">
      {{ loadError }}
      <button class="wb-link" type="button" @click="load">重试</button>
    </p>

    <div v-if="loading && !rows.length" class="wb-muted tools-pad">正在读取…</div>
    <div v-else-if="!filtered.length" class="wb-empty tools-pad" data-act="tools-empty">
      <p class="wb-empty__title">{{ kindFilter ? `还没有${kindLabel(kindFilter)}账号` : '还没有工具账号' }}</p>
      <p class="wb-empty__desc">
        紫鸟 / ERP 的登录名与密码在这里登记一次，店里只选引用 —— 新增店铺不必再重复敲。
      </p>
      <button class="wb-btn wb-btn--primary" type="button" @click="openCreate(kindFilter === 'erp' ? 'erp' : 'ziniao')">
        新建{{ kindFilter === 'erp' ? 'ERP' : '紫鸟' }}账号
      </button>
    </div>

    <table v-else class="wb-table tools-tbl" data-act="tools-table">
      <thead>
        <tr>
          <th class="tools-col-kind">类型</th>
          <th>登录名</th>
          <th class="tools-col-pwd">密码</th>
          <th class="tools-col-usage">被使用</th>
          <th>备注</th>
          <th class="tools-col-ops">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in filtered" :key="r.id" :data-tool-id="r.id">
          <td>
            <span class="tools-kindtag" :class="`is-${r.kind}`">{{ kindLabel(r.kind) }}</span>
          </td>
          <td><span class="wb-mono">{{ r.account }}</span></td>
          <td>
            <span v-if="revealed.has(r.id)" class="tools-pwd wb-mono">{{ revealed.get(r.id) }}</span>
            <span v-else class="wb-muted">{{ r.hasPassword ? '已设置' : '未设置' }}</span>
            <button
              v-if="r.hasPassword"
              class="wb-link tools-peek"
              type="button"
              :data-act="`tools-peek-${r.id}`"
              :title="revealed.has(r.id) ? '盖回' : '看一眼（8 秒后自动隐藏）'"
              @click="peekPassword(r)"
            >
              <IconGlyph :name="revealed.has(r.id) ? 'eye-off' : 'eye'" :size="12" />
            </button>
          </td>
          <td class="tools-usage">
            <b>{{ r.usageCount }}</b> 家店
          </td>
          <td><span class="wb-muted">{{ r.note || '—' }}</span></td>
          <td class="tools-ops">
            <button class="wb-link" type="button" data-act="tools-edit" @click="openEdit(r)">编辑</button>
            <button
              class="wb-link tools-del"
              type="button"
              data-act="tools-delete"
              :disabled="r.usageCount > 0"
              :title="r.usageCount > 0 ? `被 ${r.usageCount} 家店引用，先在店铺行改选其它账号再删` : '删除'"
              @click="remove(r)"
            >
              删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 新建 / 编辑抽屉 -->
    <div v-if="editor.open" class="wb-mask" @click.self="closeEditor">
      <aside class="wb-drawer" role="dialog" aria-modal="true" aria-label="工具账号">
        <div class="wb-dialog__head">
          <span>{{ editor.id ? `编辑${kindLabel(editor.kind)}账号` : '新建工具账号' }}</span>
          <button class="tools-x" type="button" aria-label="关闭" @click="closeEditor">✕</button>
        </div>

        <div class="wb-dialog__body">
          <label class="wb-field">
            <span class="wb-field__label">类型 <i class="wb-field__req">*</i></span>
            <select v-model="editor.kind" class="wb-input" data-act="tools-form-kind" :disabled="editor.id > 0">
              <option value="ziniao">紫鸟</option>
              <option value="erp">ERP</option>
            </select>
            <span v-if="editor.id > 0" class="wb-field__hint">
              类型保存后不可改 —— 改 kind 等于把登录记录偷换成另一类工具的，引用它的店铺不会跟着变。
            </span>
          </label>

          <label class="wb-field">
            <span class="wb-field__label">登录名 <i class="wb-field__req">*</i></span>
            <input
              v-model="editor.account"
              class="wb-input"
              type="text"
              maxlength="200"
              placeholder="紫鸟 / ERP 的登录账号"
              data-act="tools-form-account"
            />
          </label>

          <label class="wb-field">
            <span class="wb-field__label">{{ editor.id ? '改密码（留空 = 保持原密码）' : '密码' }}</span>
            <input
              v-model="editor.password"
              class="wb-input"
              type="password"
              maxlength="200"
              autocomplete="new-password"
              :placeholder="editor.id ? '不填则保持原密码' : '首次保存必填'"
              data-act="tools-form-password"
            />
            <span class="wb-field__hint">密码只进不出：保存后无法再回读，忘了只能重设。</span>
          </label>

          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <textarea v-model="editor.note" class="wb-input" rows="3" maxlength="500" placeholder="如：主账号 / 备用"></textarea>
          </label>
        </div>

        <div class="wb-dialog__foot">
          <span v-if="editorBlocked" class="wb-muted tools-blocked" data-act="tools-blocked">
            {{ editorBlocked }}
          </span>
          <button class="wb-btn" type="button" data-act="tools-cancel" @click="closeEditor">取消</button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="tools-save"
            :disabled="!!editorBlocked"
            @click="submit"
          >
            保存
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.tools-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tools-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.tools-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tools-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 12px;
}
.tools-chip b {
  color: var(--wb-text);
  font-weight: 600;
}
.tools-chip.is-dim {
  background: transparent;
}
.tools-acts {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tools-kind {
  height: 30px;
  padding: 0 8px;
  font-size: 12.5px;
}
.tools-pad {
  padding: 28px 16px;
}
.tools-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.tools-tbl {
  width: 100%;
}
.tools-col-kind {
  width: 72px;
}
.tools-col-pwd {
  width: 200px;
}
.tools-col-usage {
  width: 90px;
  text-align: right;
}
.tools-col-ops {
  width: 110px;
}
.tools-kindtag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 600;
}
.tools-kindtag.is-ziniao {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}
.tools-kindtag.is-erp {
  background: var(--wb-accent-soft, var(--wb-surface-2));
  color: var(--wb-accent, var(--wb-text));
}
.tools-pwd {
  color: var(--wb-text);
}
.tools-peek {
  margin-left: 6px;
  vertical-align: middle;
}
.tools-usage {
  text-align: right;
}
.tools-usage b {
  font-weight: 600;
}
.tools-ops {
  white-space: nowrap;
}
.tools-ops .wb-link + .wb-link {
  margin-left: 10px;
}
.tools-del:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tools-x {
  border: none;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 13px;
  cursor: pointer;
}
.tools-x:hover {
  color: var(--wb-text);
}
.tools-blocked {
  margin-right: auto;
  font-size: 12px;
}
</style>
