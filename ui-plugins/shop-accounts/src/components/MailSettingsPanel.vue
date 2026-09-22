<script setup lang="ts">
// extensions/shop-accounts/src/components/MailSettingsPanel.vue
// 「设置 → 店铺账号 → 邮件收件箱」：自动轮询间隔 / 默认缓存窗口 / 单封正文上限 / 立即操作。
// 只调 mailStore 的偏好与统计，不碰店铺套数据（同 settings 页面的其它面板一致）。

import { computed, onMounted, ref, watch } from 'vue';
import type { MailRemoteFolder } from '@/types';
import { useMailStore } from '../mailStore';
import IconGlyph from './IconGlyph.vue';

const mail = useMailStore();

/** 面板形态：设置页内嵌时不额外渲染卡片外壳 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: true });

const pollMinutes = ref(mail.prefs.pollMinutes);
const defaultSyncDays = ref(mail.prefs.defaultSyncDays);
const defaultMaxBodyKb = ref(mail.prefs.defaultMaxBodyKb);

onMounted(() => {
  void mail.ensureReady().then(() => {
    syncFromPrefs();
    void mail.loadCacheStatus();
    void mail.loadFtsStatus();
  });
});

watch(
  () => mail.prefs,
  () => syncFromPrefs(),
  { deep: true },
);

function syncFromPrefs(): void {
  pollMinutes.value = mail.prefs.pollMinutes;
  defaultSyncDays.value = mail.prefs.defaultSyncDays;
  defaultMaxBodyKb.value = mail.prefs.defaultMaxBodyKb;
}

async function savePrefs(): Promise<void> {
  await mail.setPrefs({
    pollMinutes: Math.max(0, Math.min(1440, Math.round(Number(pollMinutes.value) || 0))),
    defaultSyncDays: Math.max(1, Math.min(365, Math.round(Number(defaultSyncDays.value) || 30))),
    defaultMaxBodyKb: Math.max(16, Math.min(4096, Math.round(Number(defaultMaxBodyKb.value) || 200))),
  });
  syncFromPrefs();
}

const lastSyncedText = ref('');
watch(
  () => mail.stats.lastSyncedAt,
  (v) => {
    lastSyncedText.value = v || '从未同步';
  },
  { immediate: true },
);

/* ---------- M3-1 附件本地缓存 ---------- */

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const cacheUsageText = computed(() => {
  const s = mail.cacheStatus;
  if (!s) return '读取中…';
  const quota = s.maxBytes ? ` / 上限 ${formatBytes(s.maxBytes)}` : '';
  return `${s.files} 个文件 · ${formatBytes(s.bytes)}${quota}`;
});

const cachePercent = computed(() => {
  const s = mail.cacheStatus;
  if (!s || !s.maxBytes) return 0;
  return Math.min(100, Math.round((s.bytes / s.maxBytes) * 100));
});

/* ---------- M3-2 全文检索索引 ---------- */

const ftsText = computed(() => {
  const s = mail.ftsStatus;
  if (!s) return '读取中…';
  if (!s.available) return '当前构建不支持 FTS5，已降级为模糊匹配';
  return `已索引 ${s.indexed} / ${s.total} 封`;
});

/* ---------- M3-3 多文件夹同步 ---------- */

const folderAccountId = ref(0);
const remoteFolders = ref<MailRemoteFolder[]>([]);
const selectedFolders = ref<string[]>([]);
const loadingFolders = ref(false);
const savingFolders = ref(false);

/** 未拉取时回显账号已选文件夹，拉取后并入服务端列表 */
const folderCandidates = computed(() => {
  const fromServer = remoteFolders.value.map((f) => f.path);
  const account = mail.accountById.get(folderAccountId.value);
  const saved = account?.folders || [];
  return [...new Set([...fromServer, ...saved, ...selectedFolders.value])];
});

watch(folderAccountId, (id) => {
  remoteFolders.value = [];
  selectedFolders.value = [...(mail.accountById.get(id)?.folders || [])];
});

/** 拉取服务端文件夹（只读连接，不落库） */
async function loadRemoteFolders(): Promise<void> {
  if (!folderAccountId.value) return;
  loadingFolders.value = true;
  try {
    const list = await mail.loadRemoteFolders(folderAccountId.value);
    if (list) remoteFolders.value = list;
  } finally {
    loadingFolders.value = false;
  }
}

/** 保存文件夹清单：回传账号完整字段，避免覆盖其它配置 */
async function saveFolders(): Promise<void> {
  const account = mail.accountById.get(folderAccountId.value);
  if (!account) return;
  savingFolders.value = true;
  try {
    await mail.saveAccount({
      shopSetId: account.shopSetId,
      email: account.email,
      providerId: account.providerId,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      folder: account.folder,
      folders: [...selectedFolders.value],
      syncEnabled: account.syncEnabled,
      syncDays: account.syncDays,
      maxBodyBytes: account.maxBodyBytes,
    });
    await mail.syncNow(account.id);
  } finally {
    savingFolders.value = false;
  }
}
</script>

<template>
  <div class="mail-settings" :class="{ embedded: props.embedded }">
    <h3 class="panel-title">邮件收件箱</h3>
    <p class="panel-desc">
      只读收取：连上 IMAP 后把邮件缓存到本机，列表筛选与正文预览全部走本地库，不重复联网。
    </p>

    <div class="stat-row">
      <div class="stat">
        <span class="num">{{ mail.stats.accounts }}</span>
        <span class="label">已接入邮箱</span>
      </div>
      <div class="stat">
        <span class="num">{{ mail.stats.messages }}</span>
        <span class="label">缓存邮件</span>
      </div>
      <div class="stat">
        <span class="num">{{ mail.stats.unread }}</span>
        <span class="label">未读</span>
      </div>
      <div class="stat wide">
        <span class="num small">{{ lastSyncedText }}</span>
        <span class="label">最近同步</span>
      </div>
    </div>

    <div class="field-grid">
      <label class="field">
        <span>自动轮询间隔（分钟）</span>
        <input v-model.number="pollMinutes" class="wb-input" type="number" min="0" max="1440" />
        <small>0 = 关闭自动轮询，只在打开收件箱时手动同步</small>
      </label>
      <label class="field">
        <span>新邮箱默认同步窗口（天）</span>
        <input v-model.number="defaultSyncDays" class="wb-input" type="number" min="1" max="365" />
        <small>窗口外的邮件会被清理，已接入邮箱按各自设置执行</small>
      </label>
      <label class="field">
        <span>新邮箱单封正文上限（KB）</span>
        <input v-model.number="defaultMaxBodyKb" class="wb-input" type="number" min="16" max="4096" />
        <small>超限只保存元数据，避免大附件撑爆本地库</small>
      </label>
    </div>

    <section class="block">
      <div class="block-head">
        <h4>同步文件夹</h4>
        <span class="muted">不选则只同步主文件夹（默认 INBOX）</span>
      </div>
      <div class="folder-bar">
        <select v-model.number="folderAccountId" class="wb-input narrow">
          <option :value="0">选择邮箱</option>
          <option v-for="a in mail.accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
        </select>
        <button
          class="btn-ghost"
          type="button"
          :disabled="!folderAccountId || loadingFolders"
          @click="loadRemoteFolders"
        >
          {{ loadingFolders ? '读取中…' : '读取服务器文件夹' }}
        </button>
        <button class="btn-ghost" type="button" :disabled="!folderAccountId || savingFolders" @click="saveFolders">
          {{ savingFolders ? '保存中…' : '保存并重同步' }}
        </button>
      </div>
      <div v-if="folderCandidates.length" class="folder-list">
        <label v-for="path in folderCandidates" :key="path" class="folder-item">
          <input v-model="selectedFolders" type="checkbox" :value="path" />
          <span>{{ path }}</span>
        </label>
      </div>
      <p v-else-if="folderAccountId" class="muted">
        点「读取服务器文件夹」拉取该邮箱的目录清单（只读连接，不落库）。
      </p>
    </section>

    <section class="block">
      <div class="block-head">
        <h4>附件缓存</h4>
        <span class="muted">下载过的附件留在本机，重复查看不联网</span>
      </div>
      <p class="mono muted">{{ mail.cacheStatus?.dir || '缓存目录未初始化' }}</p>
      <div class="usage">
        <div class="bar"><i :style="{ width: `${cachePercent}%` }" /></div>
        <span class="muted">{{ cacheUsageText }}</span>
      </div>
      <div class="row-actions">
        <button class="btn-ghost" type="button" @click="mail.loadCacheStatus()">刷新</button>
        <button class="btn-ghost danger" type="button" @click="mail.clearCache()">清空缓存</button>
        <button class="btn-ghost" type="button" @click="mail.openCacheDir()">打开缓存目录</button>
      </div>
    </section>

    <section class="block">
      <div class="block-head">
        <h4>全文检索索引</h4>
        <span class="muted">FTS5 索引随同步增量维护</span>
      </div>
      <p class="muted">{{ ftsText }}</p>
      <div class="row-actions">
        <button class="btn-ghost" type="button" @click="mail.loadFtsStatus()">刷新</button>
        <button class="btn-ghost" type="button" @click="mail.rebuildFts()">重建索引</button>
      </div>
    </section>

    <div class="row-actions">
      <button class="btn-primary" type="button" @click="savePrefs">保存设置</button>
      <button class="btn-ghost" type="button" :disabled="mail.isSyncing" @click="mail.syncNow()">
        <IconGlyph name="refresh" :size="14" />
        {{ mail.isSyncing ? '同步中…' : '立即同步全部' }}
      </button>
      <button class="btn-ghost danger" type="button" @click="mail.purge()">清理过期邮件</button>
    </div>
  </div>
</template>

<style scoped>
.mail-settings {
  font-size: 13px;
  color: var(--wb-text);
}

.mail-settings:not(.embedded) {
  padding: 14px 16px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius, 12px);
}

.panel-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.panel-desc {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}

.stat-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.stat {
  flex: 0 0 auto;
  min-width: 92px;
  padding: 8px 12px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat.wide {
  min-width: 160px;
}

.stat .num {
  font-size: 18px;
  font-weight: 600;
  color: var(--wb-text);
}

.stat .num.small {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat .label {
  font-size: 11px;
  color: var(--wb-text-muted);
}

.field-grid {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.field .wb-input {
  max-width: 220px;
}

.field small {
  font-size: 11px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.block {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--wb-border);
}

.block-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.block-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}

.muted {
  font-size: 11px;
  color: var(--wb-text-muted);
}

.mono {
  margin: 0 0 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.narrow {
  max-width: 260px;
}

.folder-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.folder-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px;
  max-height: 160px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface-2);
}

.folder-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--wb-text);
  min-width: 0;
}

.folder-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.usage .bar {
  flex: 0 0 180px;
  height: 6px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  border: 1px solid var(--wb-border);
  overflow: hidden;
}

.usage .bar i {
  display: block;
  height: 100%;
  background: var(--wb-primary);
}

.btn-ghost.danger {
  color: var(--wb-danger);
}
</style>
