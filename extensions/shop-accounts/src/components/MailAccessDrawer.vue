<script setup lang="ts">
// extensions/shop-accounts/src/components/MailAccessDrawer.vue
// 「接入邮箱」抽屉：选择服务商 → 填写 IMAP 授权码 → 测试连接 → 保存并立即同步。
// 授权码只进不出：写入后由主进程加密落库（secrets.mailAuthPwd），渲染层永不回读明文。

import { computed, reactive, ref, watch } from 'vue';
import { useMailStore } from '../mailStore';
import { useShopAccountsStore } from '../store';
import type { MailConnectionTestResult } from '@/types';
import IconGlyph from './IconGlyph.vue';

const mail = useMailStore();
const accounts = useShopAccountsStore();

const emit = defineEmits<{ (e: 'close'): void }>();

const open = computed(() => mail.accessShopSetId !== null);
const shopSetId = computed(() => mail.accessShopSetId || 0);
const shopSet = computed(() => accounts.items.find((it) => it.id === shopSetId.value) || null);
const existing = computed(
  () => mail.accounts.find((a) => a.shopSetId === shopSetId.value) || null,
);

const form = reactive({
  email: '',
  providerId: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  folder: 'INBOX',
  syncDays: 30,
  maxBodyKb: 200,
  syncEnabled: true,
});

const authPassword = ref('');
const showPwd = ref(false);
const testing = ref(false);
const saving = ref(false);
const testResult = ref<MailConnectionTestResult | null>(null);

const STATUS_TEXT: Record<string, string> = {
  idle: '已接入',
  syncing: '同步中',
  error: '异常',
  paused: '已停用',
};

const isCustom = computed(() => form.providerId === 'custom');
const provider = computed(() => mail.providerById(form.providerId));
const presets = computed(() => mail.providers);
/** 未接授权码时不能同步（邮箱地址可沿用，授权码必填） */
const canSave = computed(() => !!form.email.trim() && (!!existing.value || !!authPassword.value));

watch(open, (next) => {
  if (!next) return;
  initForm();
});

/**
 * 打开时填充表单：优先用邮箱账号已有配置，否则用店铺套邮箱 + 服务商预设默认值。
 */
function initForm(): void {
  testing.value = false;
  testResult.value = null;
  authPassword.value = '';
  showPwd.value = false;

  const account = existing.value;
  const email = account?.email || shopSet.value?.email || '';
  form.email = email;
  form.providerId = account?.providerId || mail.detectProviderId(email);
  form.imapHost = account?.imapHost || '';
  form.imapPort = account?.imapPort || 993;
  form.imapSecure = account ? account.imapSecure : true;
  form.folder = account?.folder || 'INBOX';
  form.syncDays = account?.syncDays || mail.prefs.defaultSyncDays;
  form.maxBodyKb = account
    ? Math.max(16, Math.round(account.maxBodyBytes / 1024))
    : mail.prefs.defaultMaxBodyKb;
  form.syncEnabled = account ? account.syncEnabled : true;

  applyPresetDefaults();
}

watch(
  () => form.providerId,
  () => applyPresetDefaults(),
);

/** 切换到预设服务商时带上其默认 host/port/secure（自定义时留给用户输入） */
function applyPresetDefaults(): void {
  const preset = mail.providerById(form.providerId);
  if (!preset || preset.id === 'custom') return;
  form.imapHost = preset.host;
  form.imapPort = preset.port;
  form.imapSecure = preset.secure;
}

async function runTest(): Promise<void> {
  if (!form.email.trim()) return;
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await mail.testConnection({
      email: form.email.trim(),
      authPassword: authPassword.value,
      providerId: form.providerId,
      host: isCustom.value ? form.imapHost.trim() : undefined,
      port: isCustom.value ? Number(form.imapPort) : undefined,
      secure: isCustom.value ? form.imapSecure : undefined,
    });
  } finally {
    testing.value = false;
  }
}

async function submitAndSync(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const id = await mail.saveAccount({
      shopSetId: shopSetId.value,
      email: form.email.trim(),
      providerId: form.providerId,
      imapHost: form.imapHost.trim(),
      imapPort: Number(form.imapPort),
      imapSecure: form.imapSecure,
      folder: form.folder.trim() || 'INBOX',
      syncEnabled: form.syncEnabled,
      syncDays: Number(form.syncDays),
      maxBodyBytes: Math.max(16, Math.round(Number(form.maxBodyKb) * 1024)),
      secrets: authPassword.value ? { mailAuthPwd: authPassword.value } : undefined,
    });
    if (id === null) return;
    authPassword.value = '';
    await mail.syncNow(id);
    emit('close');
  } finally {
    saving.value = false;
  }
}

async function removeAccess(): Promise<void> {
  if (!existing.value) return;
  await mail.removeAccount(existing.value.id);
  emit('close');
}

function close(): void {
  emit('close');
}
</script>

<template>
  <div v-if="open" class="editor-overlay" @click.self="close">
    <div class="editor-drawer" role="dialog" aria-modal="true">
      <header class="editor-head">
        <div class="head-title">
          <IconGlyph name="mail" :size="18" />
          <h3>接入邮箱</h3>
          <span v-if="existing" class="status-chip" :class="existing.status">
            {{ STATUS_TEXT[existing.status] || existing.status }}
          </span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="close">
          <IconGlyph name="x" :size="16" />
        </button>
      </header>

      <div class="editor-body">
        <p class="banner">
          只读取用：连上 IMAP 后仅下载并缓存邮件到本机，不会回写、不会删除服务器邮件。
        </p>

        <div class="form-section">
          <div class="section-title">邮箱</div>
          <div class="form-row">
            <label class="form-label">邮箱地址</label>
            <input v-model="form.email" class="wb-input" type="text" placeholder="name@163.com" />
          </div>
          <div class="form-row">
            <label class="form-label">服务商</label>
            <select v-model="form.providerId" class="wb-input">
              <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>
          <p v-if="provider && provider.authHint" class="field-hint">
            {{ provider.authHint }}
            <a v-if="provider.helpUrl" :href="provider.helpUrl" target="_blank" rel="noreferrer">
              查看开启指引
            </a>
          </p>
          <template v-if="isCustom">
            <div class="form-row three">
              <input v-model="form.imapHost" class="wb-input" type="text" placeholder="IMAP 主机" />
              <input v-model="form.imapPort" class="wb-input" type="number" placeholder="端口" />
              <label class="inline-check">
                <input v-model="form.imapSecure" type="checkbox" />
                <span>SSL</span>
              </label>
            </div>
            <div class="form-row">
              <label class="form-label">邮箱文件夹</label>
              <input v-model="form.folder" class="wb-input" type="text" placeholder="INBOX" />
            </div>
          </template>
        </div>

        <div class="form-section">
          <div class="section-title">IMAP 授权码</div>
          <div class="form-row pwd-row">
            <input
              v-model="authPassword"
              class="wb-input"
              :type="showPwd ? 'text' : 'password'"
              :placeholder="existing ? '留空表示保持不变' : '在此粘贴 IMAP 授权码'"
              autocomplete="new-password"
            />
            <button class="icon-btn" type="button" :title="showPwd ? '隐藏' : '显示'" @click="showPwd = !showPwd">
              <IconGlyph :name="showPwd ? 'eye-off' : 'eye'" :size="16" />
            </button>
          </div>
          <p class="field-hint">
            不是网页登录密码。163/126 需在「设置 → POP3/SMTP/IMAP」单独开启 IMAP 并拿到授权码。
          </p>
          <div class="row-actions">
            <button class="btn-ghost" type="button" :disabled="testing || !form.email.trim()" @click="runTest">
              <IconGlyph name="plug" :size="14" />
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>
          <div v-if="testResult" class="test-result" :class="{ ok: testResult.ok }">
            <template v-if="testResult.ok">
              <div class="line">
                <strong>连接成功</strong>
                <span>收件箱 {{ testResult.messageCount }} 封</span>
              </div>
              <div class="line muted">
                IDLE 长连接：{{ testResult.idle ? '支持（可实时推送）' : '不支持（走定时轮询）' }}
              </div>
              <div class="line muted">能力：{{ testResult.capabilities.join(' / ') || '无' }}</div>
            </template>
            <template v-else>
              <div class="line"><strong>连接失败</strong></div>
              <div class="line muted">{{ testResult.error }}</div>
            </template>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title">同步与缓存</div>
          <div class="form-row two">
            <div>
              <label class="form-label">同步窗口（天）</label>
              <input v-model="form.syncDays" class="wb-input" type="number" min="1" max="365" />
            </div>
            <div>
              <label class="form-label">单封正文上限（KB）</label>
              <input v-model="form.maxBodyKb" class="wb-input" type="number" min="16" max="4096" />
            </div>
          </div>
          <label class="inline-check">
            <input v-model="form.syncEnabled" type="checkbox" />
            <span>启用自动同步</span>
          </label>
          <p v-if="existing" class="field-hint">
            上次同步：{{ existing.lastSyncedAt || '从未' }}
            <template v-if="existing.lastError"> · 最近错误：{{ existing.lastError }}</template>
          </p>
        </div>
      </div>

      <footer class="editor-foot">
        <button v-if="existing" class="btn-ghost danger" type="button" @click="removeAccess">
          取消接入
        </button>
        <span class="spacer" />
        <button class="btn-ghost" type="button" @click="close">关闭</button>
        <button class="btn-primary" type="button" :disabled="saving || !canSave" @click="submitAndSync">
          {{ saving ? '保存中…' : '保存并同步' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.editor-overlay {
  position: fixed;
  inset: 0;
  background: var(--wb-overlay);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}

.editor-drawer {
  width: min(520px, 100vw);
  height: 100%;
  background: var(--wb-surface);
  border-left: 1px solid var(--wb-border);
  display: flex;
  flex-direction: column;
  box-shadow: -18px 0 48px rgb(0 0 0 / 18%);
}

.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--wb-border);
}

.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--wb-primary);
}

.head-title h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}

.status-chip {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}

.status-chip.idle {
  background: var(--wb-success);
  color: #fff;
}

.status-chip.error {
  background: var(--wb-danger);
  color: #fff;
}

.editor-body {
  flex: 1;
  overflow: auto;
  padding: 16px 18px 24px;
}

.banner {
  margin: 0 0 16px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  background: var(--wb-primary-soft);
  color: var(--wb-text);
}

.form-section {
  margin-bottom: 22px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text-muted);
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--wb-border);
}

.form-row {
  margin-bottom: 10px;
}

.form-row.two,
.form-row.three {
  display: grid;
  gap: 10px;
}

.form-row.two {
  grid-template-columns: 1fr 1fr;
}

.form-row.three {
  grid-template-columns: 2fr 1fr auto;
  align-items: center;
}

.form-label {
  display: block;
  font-size: 12px;
  color: var(--wb-text-muted);
  margin-bottom: 4px;
}

.field-hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}

.field-hint a {
  color: var(--wb-primary);
  text-decoration: none;
}

.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--wb-text);
  margin-top: 4px;
}

.pwd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pwd-row .wb-input {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.row-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.test-result {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  font-size: 12px;
}

.test-result.ok {
  border-color: var(--wb-success);
}

.test-result .line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  line-height: 1.8;
}

.test-result .muted {
  color: var(--wb-text-muted);
}

.editor-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
}

.spacer {
  flex: 1;
}

.btn-ghost.danger {
  color: var(--wb-danger);
}
</style>
