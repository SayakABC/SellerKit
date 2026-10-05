<script setup lang="ts">
// extensions/shop-accounts/src/components/MailInboxView.vue
// 集中邮件收件箱主视图：本地缓存列表 + 详情只读预览 + 手动同步/清理。
// 所有数据来自本地 SQLite（mail-* IPC），列表筛选不触网；只有「同步」按钮会联网。

import { computed, onMounted, ref } from 'vue';
import { useMailStore } from '../mailStore';
import IconGlyph from './IconGlyph.vue';

const mail = useMailStore();

const purgeDays = ref(0);
const showPurge = ref(false);
/** 正在下载附件的 id（用于按钮 loading 态，0 = 空闲） */
const savingAttachmentId = ref(0);
/**
 * 是否放行远程图片（**默认放行**）。
 * 正文文档的图片由 sk-mail:// 通道渲染，`?remote=1` 才在正文文档的 CSP 里放行 http(s)。
 *
 * 为什么默认放行：本项目的邮件收件箱里，正文图**几乎全是远程图**（实测 103/103 封，
 * 附件表 0 行、`cid:` 0 条）——例如网易 goods 的商品长图。默认拦截的净效果是
 * "用户打开任何一封邮件都是空白"，而绝大多数邮件客户端的默认行为也是直接加载。
 * 反追踪需求保留为一次点击：点「拦截远程图片」即回到 `?remote=` 缺省态。
 */
const showRemote = ref(true);

onMounted(() => {
  void mail.ensureReady().then(() => mail.loadMessages());
});

/**
 * 换邮件**不重置**这个开关：它是用户的一次性偏好（"我不想让发件方看到我打开了邮件"），
 * 不是每封邮件的状态。之前每封重置，用户拦住一封后换一封又要再点一次。
 */

/**
 * 正文文档地址。**必须走 sk-mail:// 而不是 iframe srcdoc**：
 * srcdoc 文档会继承岛页面的 CSP（`img-src 'self' data:`），邮件里的图和 `cid:` 引用全被拦。
 */
const bodyUrl = computed(() => {
  const id = mail.detail?.id;
  if (!id) return 'about:blank';
  return `sk-mail://body/${id}${showRemote.value ? '?remote=1' : ''}`;
});

/**
 * 正文里的远程图数量：决定要不要出「拦截/显示远程图片」这一行的数字。
 * 只做提示判据，计数口径与宿主侧一致即可——img 标签 + CSS 背景图 url()。
 */
const remoteImageCount = computed(() => {
  const html = mail.detail?.htmlBody || '';
  if (!html) return 0;
  const byTag = (html.match(/<img\b[^>]*>/gi) || []).filter((t) =>
    /src\s*=\s*["']?\s*(?:https?:)?\/\//i.test(t),
  ).length;
  const byCss = (html.match(/url\(\s*["']?\s*(?:https?:)?\/\//gi) || []).length;
  return byTag + byCss;
});

const accountLabel = computed(() => {
  if (!mail.accountFilter) return '全部邮箱';
  return mail.accountById.get(mail.accountFilter)?.email || '全部邮箱';
});

const lastSyncedText = computed(() => {
  const raw = mail.stats.lastSyncedAt;
  if (!raw) return '从未同步';
  return `上次同步 ${formatTime(raw)}`;
});

/** 收件时间：今天显示时分，更早显示月-日 */
function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatFull(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 收件人 JSON → 展示串（容错：脏数据直接原文返回） */
function formatAddrList(json: string): string {
  if (!json) return '';
  try {
    const list = JSON.parse(json) as { name?: string; address?: string }[];
    if (!Array.isArray(list)) return json;
    return list.map((it) => it?.name || it?.address || '').filter(Boolean).join('、');
  } catch {
    return json;
  }
}

function openSettings(): void {
  window.dispatchEvent(
    new CustomEvent('open-settings', { detail: { category: 'shop-accounts', tab: 'mail' } }),
  );
}

function goAccounts(): void {
  window.dispatchEvent(new CustomEvent('shop-accounts:goto', { detail: { tab: 'accounts' } }));
}

async function runPurge(): Promise<void> {
  await mail.purge(purgeDays.value || undefined);
  showPurge.value = false;
}

/** 正文未缓存（超大邮件同步时只存预览）→ 现拉原文解析入库 */
function fetchFullBody(): void {
  const id = mail.detail?.id;
  if (!id) return;
  void mail.fetchBodyOnDemand(id, mail.detail?.accountId);
}

async function downloadAttachment(att: { id: number }): Promise<void> {
  const id = mail.detail?.id;
  if (!id) return;
  savingAttachmentId.value = att.id;
  try {
    await mail.saveAttachment(id, att.id);
  } finally {
    savingAttachmentId.value = 0;
  }
}

/** 内联预览（图片类返回 data URL；非图片类退化为打开/下载） */
async function previewAttachment(att: { id: number }): Promise<void> {
  const id = mail.detail?.id;
  if (!id) return;
  const preview = await mail.previewAttachment(id, att.id);
  if (preview && !preview.previewable) {
    await mail.openAttachment(id, att.id);
  }
}

function openAttachment(att: { id: number }): void {
  const id = mail.detail?.id;
  if (!id) return;
  void mail.openAttachment(id, att.id);
}

/**
 * 有效未读：服务端 seen 为假且本地也没标记过已读。
 * IMAP 只读改不了服务端 flag，"已读"只能由本地 read_at 兜底，故两者取或。
 */
function isUnread(m: { seen: boolean; read?: boolean }): boolean {
  return !m.seen && !m.read;
}

/** 恢复未读：仅"本地读过、服务端仍是未读"的邮件可回退 */
const canMarkUnread = computed(() => !!mail.detail && mail.detail.read && !mail.detail.seen);

function markUnread(): void {
  const id = mail.detail?.id;
  if (!id) return;
  void mail.markRead([id], false);
}
const folderOptions = computed(() =>
  (mail.stats.folders || []).filter((f) => f.path && f.count > 0),
);
</script>

<template>
  <div class="mail-view">
    <header class="mail-head">
      <div class="title-group">
        <IconGlyph name="inbox" :size="18" />
        <h2>邮件收件箱</h2>
        <span v-if="mail.unread" class="unread-badge">{{ mail.unread }} 未读</span>
      </div>
      <div class="head-actions">
        <button
          v-if="mail.isSyncing"
          class="btn-ghost"
          type="button"
          @click="mail.cancelSync(mail.syncingIds[0])"
        >
          <IconGlyph name="x" :size="14" />
          停止同步
        </button>
        <button class="btn-primary" type="button" :disabled="mail.isSyncing" @click="mail.syncNow()">
          <IconGlyph name="refresh" :size="14" />
          {{ mail.isSyncing ? '同步中…' : '同步全部' }}
        </button>
        <button class="icon-btn" type="button" title="清理窗口外邮件" @click="showPurge = !showPurge">
          <IconGlyph name="trash" :size="16" />
        </button>
        <button class="icon-btn" type="button" title="收件箱设置" @click="openSettings">
          <IconGlyph name="settings" :size="16" />
        </button>
      </div>
    </header>

    <div v-if="showPurge" class="purge-bar">
      <span>清理</span>
      <input v-model.number="purgeDays" class="wb-input tiny" type="number" min="0" max="365" />
      <span>天之前的缓存邮件（0 = 按各邮箱窗口）</span>
      <button class="btn-ghost danger" type="button" @click="runPurge">确认清理</button>
    </div>

    <template v-if="!mail.hasAccount">
      <div class="mail-empty">
        <IconGlyph name="mail" :size="28" />
        <p>还没有接入邮箱</p>
        <p class="muted">到「账号库」任选一行点「接入邮箱」，填写 IMAP 授权码即可收信。</p>
        <button class="btn-primary" type="button" @click="goAccounts">去账号库接入</button>
      </div>
    </template>

    <template v-else>
      <div class="mail-filter">
        <div class="search-box">
          <IconGlyph name="search" :size="14" />
          <input
            v-model="mail.keyword"
            class="wb-input"
            type="text"
            placeholder="全文搜索：主题 / 发件人 / 正文"
          />
        </div>
        <select v-model="mail.accountFilter" class="wb-input narrow">
          <option :value="0">全部邮箱</option>
          <option v-for="a in mail.accountOptions" :key="a.id" :value="a.id">{{ a.email }}</option>
        </select>
        <select v-if="folderOptions.length" v-model="mail.folderFilter" class="wb-input narrow">
          <option value="">全部文件夹</option>
          <option v-for="f in folderOptions" :key="f.path" :value="f.path">
            {{ f.path }}（{{ f.count }}）
          </option>
        </select>
        <label class="inline-check">
          <input v-model="mail.unreadOnly" type="checkbox" />
          <span>只看未读</span>
        </label>
        <button
          v-if="mail.unread"
          class="btn-mini"
          type="button"
          title="把当前筛选范围内的邮件全部标为已读"
          @click="mail.markAllRead()"
        >
          全部已读
        </button>
        <span class="meta">{{ mail.total }} 封 · {{ accountLabel }} · {{ lastSyncedText }}</span>
      </div>

      <div class="mail-body">
        <aside class="mail-list">
          <p v-if="mail.loading" class="list-hint">加载中…</p>
          <p v-else-if="!mail.messages.length" class="list-hint">没有匹配的邮件</p>
          <article
            v-for="m in mail.messages"
            v-else
            :key="m.id"
            class="mail-item"
            :class="{ active: m.id === mail.selectedId, unread: isUnread(m) }"
            @click="mail.openMessage(m.id)"
          >
            <div class="item-top">
              <span v-if="isUnread(m)" class="dot" />
              <span class="sender">{{ m.fromName || m.fromAddr }}</span>
              <span class="time">{{ formatTime(m.receivedAt) }}</span>
            </div>
            <div class="subject">{{ m.subject || '(无主题)' }}</div>
            <div class="preview">{{ m.preview || (m.bodyCached ? '' : '正文未缓存') }}</div>
            <div class="item-foot">
              <span class="to">{{ m.accountEmail }}</span>
              <IconGlyph v-if="m.hasAttachment" name="paperclip" :size="13" />
            </div>
          </article>
        </aside>

        <section class="mail-detail">
          <template v-if="mail.loadingDetail">
            <p class="list-hint">加载正文…</p>
          </template>
          <template v-else-if="mail.detail">
            <header class="detail-head">
              <h3>{{ mail.detail.subject || '(无主题)' }}</h3>
              <div class="detail-meta">
                <div v-if="mail.detail.read" class="read-line">
                  <span class="read-flag">已读</span>
                  <button v-if="canMarkUnread" class="btn-mini" type="button" @click="markUnread">标记未读</button>
                </div>
                <div>
                  <strong>{{ mail.detail.fromName || mail.detail.fromAddr }}</strong>
                  <span class="muted"> &lt;{{ mail.detail.fromAddr }}&gt;</span>
                </div>
                <div class="muted">收件：{{ formatAddrList(mail.detail.toJson) || mail.detail.accountEmail }}</div>
                <div class="muted">
                  {{ formatFull(mail.detail.receivedAt) }} · {{ mail.detail.accountEmail }} ·
                  {{ formatSize(mail.detail.size) }}
                </div>
              </div>
            </header>
            <div v-if="mail.detail.htmlBody && remoteImageCount" class="remote-hint">
              <IconGlyph name="eye" :size="13" />
              <span v-if="showRemote">已加载 {{ remoteImageCount }} 张远程图片</span>
              <span v-else>已拦截 {{ remoteImageCount }} 张远程图片（防发件方追踪）</span>
              <button class="btn-mini" type="button" @click="showRemote = !showRemote">
                {{ showRemote ? '拦截远程图片' : '显示远程图片' }}
              </button>
            </div>
            <div class="detail-body">
              <iframe
                v-if="mail.detail.htmlBody"
                class="html-frame"
                title="邮件正文"
                sandbox=""
                :src="bodyUrl"
              />
              <pre v-else class="text-body">{{ mail.detail.textBody || '（无正文）' }}</pre>
              <p v-if="mail.detail.truncated" class="warn">正文超过单封缓存上限，已截断保存。</p>
              <div v-if="!mail.detail.bodyCached" class="uncached">
                <span>正文未缓存（超过账号单封上限，同步时只保留了预览）。</span>
                <button class="btn-mini" :disabled="mail.loadingDetail" @click="fetchFullBody">
                  拉取完整正文
                </button>
              </div>
            </div>
            <footer v-if="mail.detail.attachments.length" class="detail-attach">
              <div class="attach-title">
                <IconGlyph name="paperclip" :size="13" />
                附件 {{ mail.detail.attachments.length }} 个（图片可直接预览，其余调用系统应用打开）
              </div>
              <ul>
                <li v-for="att in mail.detail.attachments" :key="att.id">
                  <span class="att-name">{{ att.filename }}</span>
                  <span class="muted">{{ formatSize(att.size) }}</span>
                  <button
                    class="btn-mini"
                    :disabled="mail.previewingAttachmentId === att.id"
                    @click="previewAttachment(att)"
                  >
                    {{ mail.previewingAttachmentId === att.id ? '读取中…' : '预览' }}
                  </button>
                  <button class="btn-mini" @click="openAttachment(att)">打开</button>
                  <button class="btn-mini" :disabled="savingAttachmentId === att.id" @click="downloadAttachment(att)">
                    {{ savingAttachmentId === att.id ? '下载中…' : '另存' }}
                  </button>
                </li>
              </ul>
              <div v-if="mail.attachmentPreview" class="attach-preview">
                <div class="preview-head">
                  <span>{{ mail.attachmentPreview.filename }}</span>
                  <button class="btn-mini" type="button" @click="mail.closeAttachmentPreview">收起</button>
                </div>
                <img
                  v-if="mail.attachmentPreview.previewable"
                  class="preview-img"
                  :src="mail.attachmentPreview.dataUrl"
                  :alt="mail.attachmentPreview.filename"
                />
                <p v-else class="warn">
                  该附件不支持内联预览（{{ mail.attachmentPreview.mime || '未知类型' }}），请用「打开 / 另存」。
                </p>
              </div>
            </footer>
          </template>
          <p v-else class="list-hint">选择左侧邮件查看正文</p>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mail-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 10px;
}

.mail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-primary);
}

.title-group h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}

.unread-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
}

.read-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.read-flag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.purge-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface-2);
  font-size: 12px;
  color: var(--wb-text-muted);
}

.wb-input.tiny {
  width: 72px;
  padding: 2px 6px;
}

.wb-input.narrow {
  width: 180px;
}

.mail-filter {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 筛选项一律不伸缩（下拉/按钮宽度固定），宽度的唯一变量只有换行 */
.mail-filter > :not(.search-box) {
  flex: 0 0 auto;
}

/* 固定基准、不参与伸缩：否则剩余空间会随「文件夹下拉 / 全部已读按钮 / 统计文案长度」变化，
   导致切换邮箱后搜索框宽度忽宽忽窄 */
.search-box {
  position: relative;
  flex: 0 0 260px;
  max-width: 100%;
  color: var(--wb-text-muted);
}

.search-box .wb-input {
  width: 100%;
  padding-left: 28px;
}

.search-box svg {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.meta {
  font-size: 12px;
  color: var(--wb-text-muted);
  /* 推到行尾，避免文案长度变化反过来挤压搜索框 */
  margin-left: auto;
  white-space: nowrap;
}

.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--wb-text);
}

.mail-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 10px;
}

.mail-list {
  width: 340px;
  flex: 0 0 340px;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface);
  padding: 6px;
}

.mail-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid var(--wb-border);
}

.mail-item:last-child {
  border-bottom: none;
}

.mail-item:hover {
  background: var(--wb-hover);
}

.mail-item.active {
  background: var(--wb-primary-soft);
}

.item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-primary);
  flex: 0 0 6px;
}

.sender {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-text);
}

.mail-item.unread .sender {
  font-weight: 600;
}

.time {
  color: var(--wb-text-muted);
  font-size: 11px;
}

.subject {
  margin-top: 2px;
  font-size: 13px;
  color: var(--wb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview {
  margin-top: 2px;
  font-size: 11px;
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: var(--wb-text-muted);
}

.mail-detail {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-surface);
  overflow: hidden;
}

.detail-head {
  padding: 12px 14px;
  border-bottom: 1px solid var(--wb-border);
}

.detail-head h3 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}

.detail-meta {
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text);
}

.muted {
  color: var(--wb-text-muted);
}

.detail-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
}

.html-frame {
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: none;
  background: #fff;
}

/* 远程图拦截提示：夹在详情头与正文之间的一条细横条（正文 iframe 高度不受它影响） */
.remote-hint {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  font-size: 11px;
  color: var(--wb-text-muted);
}

.remote-hint span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--wb-text);
}

.warn {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--wb-warning);
}

.detail-attach {
  border-top: 1px solid var(--wb-border);
  padding: 8px 14px 12px;
  font-size: 12px;
}

.attach-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text-muted);
  margin-bottom: 4px;
}

.detail-attach ul {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
}

.detail-attach li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.attach-preview {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface-2);
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--wb-text-muted);
}

.preview-img {
  max-width: 100%;
  max-height: 320px;
  display: block;
  border-radius: 4px;
  background: #fff;
}

.att-name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 正文未缓存提示（M2-1 按需补拉入口） */
.uncached {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--wb-text-muted);
  flex-wrap: wrap;
}

.btn-mini {
  border: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  color: var(--wb-text);
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
}

.btn-mini:hover:not(:disabled) {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.btn-mini:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.list-hint {
  margin: 16px 8px;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.mail-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--wb-primary);
}

.mail-empty p {
  margin: 0;
  font-size: 13px;
  color: var(--wb-text);
}

.mail-empty .muted {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.btn-ghost.danger {
  color: var(--wb-danger);
}
</style>
