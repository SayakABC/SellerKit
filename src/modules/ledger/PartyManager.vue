<template>
  <div class="wb-mask" @click.self="close">
    <div class="wb-dialog wb-dialog--lg" role="dialog" aria-modal="true" data-act="party-manager">
      <div class="wb-dialog__head">
        <template v-if="mode === 'list'">资金相关人</template>
        <template v-else-if="mode === 'form'">{{ form.id ? `编辑相关人 · ${original?.name ?? ''}` : '新增相关人' }}</template>
        <template v-else>合并相关人</template>
      </div>

      <div class="wb-dialog__body">
        <p v-if="error" class="wb-notice wb-notice--error" data-act="party-error">{{ error }}</p>

        <template v-if="mode === 'list'">
          <p class="wb-field__hint">
            条目上的「该收谁 / 该付谁」就是这里的相关人。<b>改名不影响历史条目</b>（条目记的是 id）；停用后新条目选不到，历史与往来照常显示。
          </p>
          <div class="wb-table-wrap">
            <table class="wb-table" data-act="party-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th class="lg-c-kind">类型</th>
                  <th>电话</th>
                  <th>备注</th>
                  <th class="wb-num lg-c-cnt">条目</th>
                  <th class="lg-c-state">状态</th>
                  <th class="lg-c-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in rows" :key="p.id" :data-party-id="p.id" :class="{ 'is-archived': p.archived }">
                  <td class="wb-mono" data-act="party-name">{{ p.name }}</td>
                  <td class="wb-muted">{{ PARTY_KIND_LABEL[p.kind] }}</td>
                  <td :class="{ 'wb-muted': !p.phone }">{{ p.phone || '—' }}</td>
                  <td class="lg-c-note" :class="{ 'wb-muted': !p.note }">
                    <span class="lg-note" :title="p.note">{{ p.note || '—' }}</span>
                  </td>
                  <td class="wb-num" data-act="party-count">{{ p.entryCount }}</td>
                  <td>
                    <!-- 「已并入」与「已停用」是两回事：前者能顺着名字找过去，后者只能重启用。
                         只写一个「已停用」的话，用户看到两个停用的人分不清哪个是被合并掉的（审查 §5-4）。 -->
                    <span
                      v-if="p.archived && p.mergedTo"
                      class="wb-tag is-warn"
                      data-act="party-merged"
                      :title="`已合并进「${partyNameOf(p.mergedTo)}」，历史条目与结算单留在原处`"
                    >
                      已并入 → {{ partyNameOf(p.mergedTo) }}
                    </span>
                    <span v-else-if="p.archived" class="wb-tag">已停用</span>
                    <span v-else class="wb-tag is-on">在用</span>
                  </td>
                  <td class="lg-c-ops">
                    <button class="wb-link" type="button" data-act="party-edit" @click="openForm(p)">编辑</button>
                    <button class="wb-link" type="button" data-act="party-merge" @click="openMerge(p)">合并</button>
                    <button class="wb-link" type="button" data-act="party-archive" @click="askToggle(p)">
                      {{ p.archived ? '启用' : '停用' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="!rows.length && !loading">
                  <td colspan="7" class="lg-empty">
                    <div class="wb-empty">
                      <p class="wb-empty__title">还没有相关人</p>
                      <p class="wb-empty__desc">记一笔时必须选一个相关人，所以先在这里加上：供应商、员工、房东、平台都可以。</p>
                      <div class="wb-empty__actions">
                        <button class="wb-btn wb-btn--primary" type="button" @click="openForm(null)">新增相关人</button>
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="loading" class="wb-field__hint">读取中…</p>
        </template>

        <form v-else-if="mode === 'form'" class="lg-form" @submit.prevent="saveForm">
          <label class="wb-field">
            <span class="wb-field__label">名称 <i class="wb-field__req">*</i></span>
            <input v-model="form.name" class="wb-input" data-act="party-form-name" placeholder="如：张伟 / 广州某某服装厂" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">类型</span>
            <select v-model="form.kind" class="wb-input" data-act="party-form-kind">
              <option v-for="k in PARTY_KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">电话</span>
            <input v-model="form.phone" class="wb-input" data-act="party-form-phone" placeholder="选填" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <input v-model="form.note" class="wb-input" data-act="party-form-note" placeholder="选填：同名不同人时靠它区分" />
          </label>
          <p v-if="formError" class="wb-notice wb-notice--error">{{ formError }}</p>
        </form>

        <div v-else class="lg-form">
          <p class="wb-field__hint">
            把 <b class="wb-mono">{{ mergeFrom?.name }}</b> 并入另一个相关人。未结算条目会改挂过去；
            <b>已结算条目留在原处</b>（结算单的金额与归属不变，否则原单就对不上了）；合并后
            「{{ mergeFrom?.name }}」会被停用，历史记录保留。
          </p>
          <label class="wb-field">
            <span class="wb-field__label">并入到 <i class="wb-field__req">*</i></span>
            <select v-model.number="mergeToId" class="wb-input" data-act="party-merge-target">
              <option :value="0">请选择目标相关人</option>
              <option v-for="p in mergeTargets" :key="p.id" :value="p.id">
                {{ p.name }} · {{ PARTY_KIND_LABEL[p.kind] }}
              </option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">合并备注</span>
            <input v-model="mergeNote" class="wb-input" data-act="party-merge-note" placeholder="选填（有承接余额时会写进往来记录）" />
          </label>
          <p class="wb-notice wb-notice--warn">合并不可撤销。若只是同一人两种写法，合并是对的；若是两个不同的人，请改用「编辑」改备注。</p>
          <p v-if="formError" class="wb-notice wb-notice--error">{{ formError }}</p>
        </div>
      </div>

      <div class="wb-dialog__foot">
        <template v-if="mode === 'list'">
          <button class="wb-btn" type="button" data-act="party-close" @click="close">关闭</button>
          <button class="wb-btn wb-btn--primary" type="button" data-act="party-add" @click="openForm(null)">
            新增相关人
          </button>
        </template>
        <template v-else>
          <button class="wb-btn" type="button" :disabled="busy" @click="backToList">返回</button>
          <button
            v-if="mode === 'form'"
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="party-form-save"
            :disabled="busy || !form.name.trim()"
            @click="saveForm"
          >
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <button
            v-else
            class="wb-btn wb-btn--danger"
            type="button"
            data-act="party-merge-confirm"
            :disabled="busy || !mergeToId"
            @click="doMerge"
          >
            {{ busy ? '合并中…' : '确认合并' }}
          </button>
        </template>
      </div>
    </div>
  </div>

  <ConfirmDialog
    v-if="pendingToggle"
    :title="pendingToggle.archived ? '启用相关人' : '停用相关人'"
    :confirm-text="pendingToggle.archived ? '确认启用' : '确认停用'"
    :busy-text="'处理中…'"
    :busy="busy"
    :danger="!pendingToggle.archived"
    @close="pendingToggle = null"
    @confirm="confirmToggle"
  >
    <p>
      {{ pendingToggle.archived ? '启用' : '停用' }} <b class="wb-mono">{{ pendingToggle.name }}</b>。
    </p>
    <p v-if="!pendingToggle.archived" class="wb-field__hint">
      停用后：新建条目时选不到这个人；已有条目、往来余额与结算记录都不受影响，随时可以再启用。
    </p>
  </ConfirmDialog>
</template>

<script setup lang="ts">
// 「相关人管理」（P1）。身份用 id 这个原则在这里最直观：
// 改名只改 `bk_parties.name`，条目按 `party_id` 关联，历史一个都不会错位；
// 合并才有"搬历史"的问题，所以合并单独一屏、把后果逐条讲清。
import { computed, onMounted, reactive, ref } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import { formatCents } from '@/lib/ledger';
import * as api from './api';
import { PARTY_KIND_LABEL, PARTY_KIND_OPTIONS } from './labels';
import type { LedgerPartyKind, LedgerPartyRow } from '@/types';

const emit = defineEmits<{ close: []; changed: [] }>();

const rows = ref<LedgerPartyRow[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');

const mode = ref<'list' | 'form' | 'merge'>('list');
const original = ref<LedgerPartyRow | null>(null);
const form = reactive<{ id: number; name: string; kind: LedgerPartyKind; phone: string; note: string }>({
  id: 0,
  name: '',
  kind: 'supplier',
  phone: '',
  note: '',
});
const formError = ref('');

const mergeFrom = ref<LedgerPartyRow | null>(null);
const mergeToId = ref(0);
const mergeNote = ref('');

const pendingToggle = ref<LedgerPartyRow | null>(null);

const mergeTargets = computed(() =>
  rows.value.filter((p) => !p.archived && p.id !== mergeFrom.value?.id)
);

/**
 * 「并入到谁」只做展示查询：找不到（目标已被物理删除，理论上不会发生）就退回 id，
 * **绝不因为查不到名字就把它显示成「已停用」** —— 那正是这条要修的歧义。
 */
function partyNameOf(id: number): string {
  const hit = rows.value.find((p) => p.id === id);
  return hit ? hit.name : `#${id}`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    rows.value = await api.parties(true);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function backToList(): void {
  if (busy.value) return;
  mode.value = 'list';
  formError.value = '';
}

function openForm(p: LedgerPartyRow | null): void {
  original.value = p;
  form.id = p?.id ?? 0;
  form.name = p?.name ?? '';
  form.kind = p?.kind ?? 'supplier';
  form.phone = p?.phone ?? '';
  form.note = p?.note ?? '';
  formError.value = '';
  mode.value = 'form';
}

async function saveForm(): Promise<void> {
  if (busy.value) return;
  const name = form.name.trim();
  if (!name) {
    formError.value = '请填写名称';
    return;
  }
  busy.value = true;
  formError.value = '';
  try {
    await api.partyUpsert({
      id: form.id || undefined,
      name,
      kind: form.kind,
      phone: form.phone.trim(),
      note: form.note.trim(),
    });
    toast(form.id ? '相关人已更新' : `相关人「${name}」已创建`, 'success');
    mode.value = 'list';
    await load();
    emit('changed');
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function openMerge(p: LedgerPartyRow): void {
  mergeFrom.value = p;
  mergeToId.value = 0;
  mergeNote.value = '';
  formError.value = '';
  mode.value = 'merge';
}

async function doMerge(): Promise<void> {
  const from = mergeFrom.value;
  if (busy.value || !from || !mergeToId.value) return;
  busy.value = true;
  formError.value = '';
  try {
    const r = await api.partyMerge({
      fromId: from.id,
      toId: mergeToId.value,
      note: mergeNote.value.trim() || undefined,
    });
    const moved = r.movedEntries ? `改挂 ${r.movedEntries} 条` : '没有需要改挂的条目';
    const transfer =
      r.transferredCents !== 0
        ? `；承接余额 ${r.transferredCents > 0 ? '+' : '−'}¥${formatCents(Math.abs(r.transferredCents))}`
        : '';
    toast(`已合并：${moved}${transfer}`, 'success');
    mode.value = 'list';
    mergeFrom.value = null;
    await load();
    emit('changed');
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function askToggle(p: LedgerPartyRow): void {
  pendingToggle.value = p;
}

async function confirmToggle(): Promise<void> {
  const p = pendingToggle.value;
  if (!p || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.partyUpsert({ id: p.id, name: p.name, archived: !p.archived });
    toast(p.archived ? `已启用「${p.name}」` : `已停用「${p.name}」`, 'success');
    pendingToggle.value = null;
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    pendingToggle.value = null;
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (busy.value) return;
  emit('close');
}

onMounted(() => void load());
</script>

<style scoped>
.lg-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lg-c-kind {
  width: 80px;
}
.lg-c-cnt {
  width: 64px;
}
.lg-c-state {
  width: 76px;
}
.lg-c-ops {
  width: 150px;
  white-space: nowrap;
}
.lg-c-note {
  max-width: 220px;
}
.lg-note {
  display: inline-block;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}
tr.is-archived td {
  color: var(--wb-text-muted);
}
.lg-empty {
  padding: 0;
}
</style>
