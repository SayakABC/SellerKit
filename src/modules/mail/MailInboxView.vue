<script setup lang="ts">
// src/modules/mail/MailInboxView.vue
// 集中邮件收件箱主视图：待办队列 + 单据工作区（左侧队列 / 右侧正文）。
// 所有数据来自本地 SQLite（mail-* IPC），列表筛选不触网；只有「同步」按钮会联网。
//
// ⚠️ 2026-11-05 布局改版（本次）：原来是「待办面板压在上面 + 邮件列表 / 详情并排」的竖向堆叠，
//   三条原因让「点开待办只看得到一小块正文」：
//   ① 待办面板 `max-height: 42vh` 在详情**上方**，待办越多正文越矮（900px 窗口 10 单时只剩 ~216px）；
//   ② `.detail-body{overflow:auto}` + iframe `min-height:320px` ⇒ 内外双层滚动，第一屏只看到 1/3 封；
//   ③ `openTodo` 只打开 `t.messageId`（该单最新一封），`t.events` 里的同单历史邮件**没有任何入口**。
//   现改成左右主从：左栏是队列（待办 / 全部邮件 两个模式），右栏是「一张单据」——
//   单据头 + 同单邮件时间线 + 正文（唯一滚动区）。待办不再是"横在上面的一条"，
//   所以它既不占正文高度，也不会把邮件列表挤走（旧版靠 `listCollapsed` 折叠列表来让位）。
//
// 身份口径：右栏的"当前单据"由 `selectedId` **派生**（见 `activeTodo`），不新开一份状态 ——
//   否则"选中邮件"和"选中单据"迟早对不上（本项目已有三次同类实证，见 docs/notes 铁律 ①）。

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useMailStore } from './mailStore';
import IconGlyph from '@/core/components/IconGlyph.vue';
import { isKeyTarget, useRowNav } from '@/core/composables/useRowNav';
import { writeClipboard } from '@/core/services/clipboard';
import { toast, toastAction } from '@/core/services/toast';
import { openSettings, switchModule } from '@/core/services/shell';
import type { MailTodoItem, MailTodoKind } from '@/types';

const mail = useMailStore();

/**
 * 左栏模式。
 * 默认「待办」，但**没有要动手的待办时落到「全部邮件」**（见 onMounted）——
 * 让用户进来就看见一片"没有要处理的单"是浪费一屏；他这时候要看的是信。
 */
const mode = ref<'todo' | 'mail'>('todo');

// ---- 待办分组（三类：罚单 / 纠纷·仲裁 / 订单关闭）----
/** 已了结的（协议取消这类）默认折叠：它们的价值是"知道"不是"动手" */
const showSettled = ref(false);
/**
 * 已手工划掉的（默认收起）。
 * **必须有这个入口**：划错一次就再也看不见的话，等于给待办加了一个"永久静默"的坑。
 */
const showDismissed = ref(false);

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

const KIND_LABEL: Record<MailTodoKind, string> = {
  penalty: '罚单',
  dispute: '纠纷',
  closed: '关单',
};

function kindLabel(kind: MailTodoKind): string {
  return KIND_LABEL[kind] || '待办';
}

/**
 * 相对时间："3 天前 / 5 小时前"。
 * 待办的紧迫度全在"多久了"上（罚单有申诉期），绝对时间要用户自己减一遍。
 */
function ageText(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const minutes = Math.floor((Date.now() - t) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

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

/** 时间线 chip 用的紧凑时间：跨天要带上月-日，否则同一单的三封看起来像同一天 */
function formatChipTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    return list
      .map((it) => it?.name || it?.address || '')
      .filter(Boolean)
      .join('、');
  } catch {
    return json;
  }
}

/**
 * 当前单据 = 选中邮件所属的那张单。
 *
 * 判据取 `events`（含同单全部历史邮件）而不是只比 `t.messageId`：
 * 用户点时间线上第三封时，`selectedId` 不是最新那封，只比 `messageId` 会让单据头整块消失。
 */
const activeTodo = computed<MailTodoItem | null>(() => {
  const id = mail.selectedId;
  if (!id) return null;
  return mail.todos.find((t) => t.events.some((e) => e.messageId === id)) || null;
});

/** 时间线：同单邮件按时间升序（主进程给的是事件顺序，这里不假设它已排序） */
const activeEvents = computed(() => {
  const t = activeTodo.value;
  if (!t) return [];
  return t.events.slice().sort((a, b) => {
    const ta = new Date(a.receivedAt).getTime();
    const tb = new Date(b.receivedAt).getTime();
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
});

/** 左栏标题右侧那句：待办的"算得全不全"（与分段控件上的"几单"是两个问题） */
const todoMetaText = computed(() => {
  const { mails, unattributed } = mail.todoMeta;
  return unattributed ? `${mails} 封参与判定 · ${unattributed} 封未归属` : `${mails} 封参与判定`;
});

/** 左栏画出来的行：要动手的 → （展开时）已了结 → （展开时）已划掉 */
const visibleTodos = computed<MailTodoItem[]>(() => {
  const list = mail.todoActions.slice();
  if (showSettled.value) list.push(...mail.todoInfo);
  if (showDismissed.value) list.push(...mail.todoDismissed);
  return list;
});

/** 划掉时的时间文案（"3 天前划掉"）—— 只显示"3 天前"会让人以为是邮件时间 */
function dismissedText(iso: string): string {
  const t = ageText(iso);
  return t ? `${t}划掉` : '已划掉';
}

/** 点待办 = 打开该单最新那封邮件（右栏随即变成这张单的工作区） */
function openTodo(t: MailTodoItem): void {
  void mail.openMessage(t.messageId);
}

/** 点时间线 = 换邮件的"那一封"，但**不换单**（右栏身份是单据，不是邮件） */
function openEvent(messageId: number): void {
  void mail.openMessage(messageId);
}

/** 复制订单号：用户下一步基本都要拿它去后台/ERP 里查，手选一串数字很烦 */
async function copyOrder(t: MailTodoItem): Promise<void> {
  const ok = await writeClipboard(t.orderNo);
  toast(ok ? `已复制订单号 ${t.orderNo}` : '复制失败，请手动选中', ok ? 'success' : 'error');
}

/**
 * 标记已处理：写库成功之后**自动选中队列下一条**，并给一次撤销。
 *
 * 为什么自动跳：待办是一条流水线，用户的动线是"处理完这条 → 下一条"。
 * 不跳的话每次都要把眼睛从正文挪回左栏重新找位置，划掉三单就是三次多余的定位。
 * 为什么必须有撤销：划掉是**一次点击就改变列表**的动作，误点一次那条就从视野里消失；
 * 旧版只能到「已划掉」里翻回来，等于点错了还得多走三步。
 */
async function dismissTodo(t: MailTodoItem): Promise<void> {
  if (mail.todoBusyKey) return;
  const list = visibleTodos.value;
  const idx = list.findIndex((x) => x.orderNo === t.orderNo);
  // 下一个优先取"下面那条"，到底了就取"上面那条" —— 总比停在原地强
  const next = list[idx + 1] || list[idx - 1] || null;
  const ok = await mail.dismissTodo(t);
  if (!ok) return;
  if (next) void mail.openMessage(next.messageId);
  else {
    mail.selectedId = 0;
    mail.detail = null;
  }
  toastAction(`已标记「${t.orderNo}」为已处理`, {
    label: '撤销',
    run: () => void undoDismiss(t),
  });
}

/** 撤销划掉：恢复这条，并把它重新打开（用户点撤销时正在看的就是它） */
async function undoDismiss(t: MailTodoItem): Promise<void> {
  const ok = await mail.restoreTodo(t);
  if (!ok) return;
  void mail.openMessage(t.messageId);
}

/**
 * 键盘动线：↑↓ 换单、Enter 打开、D 标记已处理。
 * 复用 `useRowNav`（全仓一致的行动线，含"焦点在输入控件上就让路"的判定），
 * 但**挂在 window 上**：这页没有一个"表格"容器能稳拿焦点，
 * 挂在某个 div 上等于"点了别处以后 ↑↓ 就失效"。
 */
const navCurrent = computed<string>({
  get: () => activeTodo.value?.orderNo || '',
  // useRowNav 只读不写；这里仍给出正确语义（写入 = 选中该单），不做静默丢弃
  set: (orderNo: string) => {
    const t = visibleTodos.value.find((x) => x.orderNo === orderNo);
    if (t) openTodo(t);
  },
});

const { onKeydown: onRowKeydown } = useRowNav<MailTodoItem, string>({
  rows: visibleTodos,
  idOf: (t) => t.orderNo,
  currentId: navCurrent,
  onSelect: (orderNo) => {
    const t = visibleTodos.value.find((x) => x.orderNo === orderNo);
    if (t) openTodo(t);
  },
  onOpen: (orderNo) => {
    const t = visibleTodos.value.find((x) => x.orderNo === orderNo);
    if (t) openTodo(t);
  },
  rowEl: (orderNo) => document.querySelector<HTMLElement>(`.todo-row[data-order="${orderNo}"]`),
});

function handleKeydown(e: KeyboardEvent): void {
  // 键盘动线只服务待办队列；「全部邮件」模式没有"当前单"这个概念
  if (mode.value !== 'todo' || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isKeyTarget(e.target)) return;
  // 有模态开着（设置 / 确认框）就不接管：那几个键属于弹层，不属于背后的队列。
  // 判据取 `aria-modal`（弹层本来的语义），不靠 class 名 —— 改样式不该改行为。
  if (document.querySelector('[aria-modal="true"]')) return;
  if (e.key === 'd' || e.key === 'D') {
    const t = activeTodo.value;
    if (!t) return;
    e.preventDefault();
    void dismissTodo(t);
    return;
  }
  onRowKeydown(e);
}

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
    /src\s*=\s*["']?\s*(?:https?:)?\/\//i.test(t)
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

function openMailSettings(): void {
  // 2026-10-17：设置分类从 `shop-accounts:settings` 的「邮件收件箱」页签搬成 `mail:settings`。
  // 这里刻意用 shell 的 openSettings（整串分类 id + 页签 id）—— 原来手写 CustomEvent 时
  // 传的是 `category: 'shop-accounts'`，而 SettingsModal 是按 **categoryId 全串**匹配的
  // （`shop-accounts:settings`），于是那个齿轮点了其实什么都没发生。同一次一并修掉。
  openSettings('mail:settings', 'inbox');
}

function goAccounts(): void {
  // 收件箱空态「去账号库接入」：账号库现在在**另一个模块**（基础数据），
  // 所以是真跳转 —— `shop-accounts:goto` 只在同一模块内有效（目标不在场时没人接这个事件）。
  switchModule('shop-accounts', 'accounts');
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
  (mail.stats.folders || []).filter((f) => f.path && f.count > 0)
);

onMounted(() => {
  void (async () => {
    await mail.ensureReady();
    await mail.loadMessages();
    // 首次进入的落点：没有要动手的待办就直奔邮件列表（空队列不值得占一屏）
    if (!mail.todoActions.length) mode.value = 'mail';
  })();
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div class="mail-view">
    <header class="mail-head">
      <div class="head-info">
        <span v-if="mail.isSyncing" class="sync-dot" title="正在同步" />
        <span class="meta">{{ lastSyncedText }}</span>
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
        <button
          class="btn-primary"
          type="button"
          :disabled="mail.isSyncing"
          @click="mail.syncNow()"
        >
          <IconGlyph name="refresh" :size="14" />
          {{ mail.isSyncing ? '同步中…' : '同步全部' }}
        </button>
        <button
          class="icon-btn"
          type="button"
          title="清理窗口外邮件"
          @click="showPurge = !showPurge"
        >
          <IconGlyph name="trash" :size="16" />
        </button>
        <button class="icon-btn" type="button" title="收件箱设置" @click="openMailSettings">
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

    <div v-if="!mail.hasAccount" class="mail-empty">
      <IconGlyph name="mail" :size="28" />
      <p>还没有接入邮箱</p>
      <p class="muted">到「店铺账号」任选一行点「接入邮箱」，填写 IMAP 授权码即可收信。</p>
      <button class="btn-primary" type="button" @click="goAccounts">去店铺账号接入</button>
    </div>

    <div v-else class="mail-shell">
      <!-- ================= 左：队列（待办 / 全部邮件） ================= -->
      <aside class="mail-rail">
        <div class="rail-head">
          <div class="rail-title">
            <h2>{{ mode === 'todo' ? '待办' : '全部邮件' }}</h2>
            <span class="grow" />
            <!--
              计数只在分段控件上出现一次。这里改成放"参与判定多少封"——
              它回答的是"这个数算得全不全"，与上面那个"几单"不是同一个问题。
            -->
            <span v-if="mode === 'todo'" class="rail-meta" :title="todoMetaText">{{
              todoMetaText
            }}</span>
            <span v-else class="rail-meta" :title="accountLabel">{{ accountLabel }}</span>
          </div>

          <!-- 两个模式，取代旧版「待办面板 + 可折叠邮件列表」的上下堆叠 -->
          <div class="seg" role="tablist" aria-label="收件箱视图">
            <button
              class="seg-btn"
              :class="{ on: mode === 'todo' }"
              type="button"
              role="tab"
              data-act="mail-mode-todo"
              :aria-selected="mode === 'todo'"
              @click="mode = 'todo'"
            >
              待办
              <span class="seg-n" data-act="mail-todo-count">{{ mail.todoActions.length }}</span>
            </button>
            <button
              class="seg-btn"
              :class="{ on: mode === 'mail' }"
              type="button"
              role="tab"
              data-act="mail-mode-mail"
              :aria-selected="mode === 'mail'"
              @click="mode = 'mail'"
            >
              全部邮件 <span class="seg-n">{{ mail.total }}</span>
            </button>
          </div>

          <div class="rail-filters">
            <div v-if="mode === 'mail'" class="search-box">
              <IconGlyph name="search" :size="14" />
              <input
                v-model="mail.keyword"
                class="wb-input"
                type="text"
                placeholder="搜索主题 / 发件人 / 正文"
              />
            </div>
            <select
              v-model="mail.accountFilter"
              class="wb-input narrow"
              :class="{ full: mode === 'todo' }"
            >
              <option :value="0">全部邮箱</option>
              <option v-for="a in mail.accountOptions" :key="a.id" :value="a.id">
                {{ a.email }}
              </option>
            </select>
            <template v-if="mode === 'mail'">
              <select
                v-if="folderOptions.length"
                v-model="mail.folderFilter"
                class="wb-input narrow"
              >
                <option value="">全部文件夹</option>
                <option v-for="f in folderOptions" :key="f.path" :value="f.path">
                  {{ f.path }}（{{ f.count }}）
                </option>
              </select>
              <label class="inline-check">
                <input v-model="mail.unreadOnly" type="checkbox" />
                <span>只看未读</span>
              </label>
            </template>
          </div>
        </div>

        <div class="rail-body">
          <!-- ---------- 待办队列 ---------- -->
          <div v-if="mode === 'todo'" class="todo-panel" data-act="mail-todo-panel">
            <p v-if="mail.todoLoading && !mail.todos.length" class="list-hint">读取待办…</p>
            <div v-else-if="!mail.todoActions.length" class="queue-empty">
              <b>没有要处理的单</b>
              <p>
                {{
                  mail.todoDismissed.length
                    ? `都处理完了 —— 已划掉 ${mail.todoDismissed.length} 单，可展开核对。`
                    : '罚单、纠纷与关单都清空了。'
                }}
              </p>
              <button class="btn-mini" type="button" @click="mode = 'mail'">去看全部邮件</button>
            </div>

            <article
              v-for="t in mail.todoActions"
              :key="t.orderNo"
              class="todo-row"
              :class="['sev' + t.severity, { active: t.orderNo === activeTodo?.orderNo }]"
              :data-order="t.orderNo"
              :title="t.subject"
              @click="openTodo(t)"
            >
              <div class="tr-l1">
                <span class="todo-kind" :class="t.kind">{{ kindLabel(t.kind) }}</span>
                <span class="todo-order">{{ t.orderNo }}</span>
                <span
                  v-if="t.resurfaced"
                  class="todo-flag"
                  title="划掉之后这单又来了新邮件，所以重新浮出"
                >
                  有新进展
                </span>
                <span class="grow" />
                <span class="todo-when" :class="{ hot: t.severity >= 3 }">{{
                  ageText(t.receivedAt)
                }}</span>
              </div>
              <div class="todo-label">{{ t.label }}</div>
              <div class="tr-l3">
                <span>共 {{ t.events.length }} 封</span>
                <span class="dot-sep">·</span>
                <span class="ellipsis">{{ t.accountEmail }}</span>
                <span class="grow" />
                <!-- 「已处理」常显不隐藏：这是唯一能让人发现"可以划掉"的入口，藏进 hover 等于没做 -->
                <button
                  class="btn-mini todo-dismiss"
                  type="button"
                  data-act="mail-todo-dismiss"
                  :data-key="t.orderNo"
                  :disabled="mail.todoBusyKey === t.orderNo"
                  title="标记为已处理（之后这单有新邮件会自动浮出）"
                  @click.stop="dismissTodo(t)"
                >
                  已处理
                </button>
              </div>
            </article>

            <!-- 已了结（sev<2）：折在队列末尾，位置固定在"往下就看见"，不用去头部找 -->
            <button
              v-if="mail.todoInfo.length"
              class="btn-mini todo-more"
              type="button"
              @click="showSettled = !showSettled"
            >
              {{ showSettled ? '收起已了结' : '另有 ' + mail.todoInfo.length + ' 单已了结' }}
            </button>
            <template v-if="showSettled">
              <article
                v-for="t in mail.todoInfo"
                :key="'s-' + t.orderNo"
                class="todo-row is-settled"
                :class="'sev' + t.severity"
                :data-order="t.orderNo"
                :title="t.subject"
                @click="openTodo(t)"
              >
                <div class="tr-l1">
                  <span class="todo-kind" :class="t.kind">{{ kindLabel(t.kind) }}</span>
                  <span class="todo-order">{{ t.orderNo }}</span>
                  <span class="grow" />
                  <span class="todo-when">{{ ageText(t.receivedAt) }}</span>
                </div>
                <div class="todo-label">{{ t.label }}</div>
              </article>
            </template>

            <!-- 已划掉的：能看见、能恢复（划错了不该变成永久静默） -->
            <button
              v-if="mail.todoDismissed.length"
              class="btn-mini todo-more"
              type="button"
              data-act="mail-todo-dismissed-toggle"
              @click="showDismissed = !showDismissed"
            >
              {{ showDismissed ? '收起已划掉' : '已划掉 ' + mail.todoDismissed.length + ' 单' }}
            </button>
            <template v-if="showDismissed">
              <article
                v-for="t in mail.todoDismissed"
                :key="'d-' + t.orderNo"
                class="todo-row is-dismissed"
                :class="'sev' + t.severity"
                :data-order="t.orderNo"
                :title="t.subject"
                data-act="mail-todo-dismissed"
                @click="openTodo(t)"
              >
                <div class="tr-l1">
                  <span class="todo-kind" :class="t.kind">{{ kindLabel(t.kind) }}</span>
                  <span class="todo-order">{{ t.orderNo }}</span>
                  <span class="grow" />
                  <span class="todo-when">{{ dismissedText(t.dismissedAt) }}</span>
                  <button
                    class="btn-mini"
                    type="button"
                    data-act="mail-todo-restore"
                    :data-key="t.orderNo"
                    :disabled="mail.todoBusyKey === t.orderNo"
                    title="恢复这条待办"
                    @click.stop="undoDismiss(t)"
                  >
                    恢复
                  </button>
                </div>
                <div class="todo-label">{{ t.label }}</div>
              </article>
            </template>
          </div>

          <!-- ---------- 全部邮件 ---------- -->
          <div v-else class="mail-list">
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
                <span class="to ellipsis">{{ m.accountEmail }}</span>
                <IconGlyph v-if="m.hasAttachment" name="paperclip" :size="13" />
              </div>
            </article>
          </div>
        </div>

        <div v-if="mode === 'mail'" class="rail-foot">
          <span class="ellipsis">{{ mail.total }} 封</span>
          <span class="grow" />
          <button
            v-if="mail.unread"
            class="btn-mini"
            type="button"
            title="把当前筛选范围内的邮件全部标为已读"
            @click="mail.markAllRead()"
          >
            全部已读
          </button>
        </div>
      </aside>

      <!-- ================= 右：一张单据的工作区 ================= -->
      <section class="mail-work">
        <!-- 单据头：只在"当前邮件属于某张单"时出现；单封无关邮件不假装有单据 -->
        <header v-if="activeTodo" class="doc-head">
          <div class="dh-l1">
            <span class="todo-kind" :class="activeTodo.kind">{{ kindLabel(activeTodo.kind) }}</span>
            <button
              class="doc-order"
              type="button"
              data-act="mail-copy-order"
              :title="'复制订单号 ' + activeTodo.orderNo"
              @click="copyOrder(activeTodo)"
            >
              {{ activeTodo.orderNo }}
              <IconGlyph name="copy" :size="12" />
            </button>
            <span class="grow" />
            <button
              class="btn-mini doc-done"
              type="button"
              data-act="mail-todo-done"
              :disabled="mail.todoBusyKey === activeTodo.orderNo"
              title="标记为已处理，并跳到下一条"
              @click="dismissTodo(activeTodo)"
            >
              <IconGlyph name="check" :size="12" />
              标记已处理
            </button>
          </div>
          <div class="dh-l2">
            <b>{{ activeTodo.label }}</b>
            <span class="sep">·</span>
            <span class="ellipsis">{{ activeTodo.accountEmail }}</span>
            <span class="sep">·</span>
            <span :class="{ overdue: activeTodo.severity >= 3 }">{{
              ageText(activeTodo.receivedAt)
            }}</span>
            <span class="sep">·</span>
            <span>同一单 {{ activeTodo.events.length }} 封邮件</span>
          </div>
        </header>

        <!-- 同单邮件时间线：点 chip 换邮件，不换单 -->
        <div v-if="activeEvents.length > 1" class="thread" data-act="mail-todo-thread">
          <span class="thread-label">本单邮件</span>
          <button
            v-for="(ev, i) in activeEvents"
            :key="ev.messageId"
            class="chip"
            :class="{ on: ev.messageId === mail.selectedId }"
            type="button"
            :data-msg-id="ev.messageId"
            :title="ev.subject"
            @click="openEvent(ev.messageId)"
          >
            <span class="chip-time">{{ formatChipTime(ev.receivedAt) }}</span>
            <span class="chip-kind" :class="ev.kind">{{ kindLabel(ev.kind) }}</span>
            <span v-if="i === activeEvents.length - 1" class="chip-new">最新</span>
          </button>
        </div>

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
                  <button v-if="canMarkUnread" class="btn-mini" type="button" @click="markUnread">
                    标记未读
                  </button>
                </div>
                <div>
                  <strong>{{ mail.detail.fromName || mail.detail.fromAddr }}</strong>
                  <span class="muted"> &lt;{{ mail.detail.fromAddr }}&gt;</span>
                </div>
                <div class="muted">
                  收件：{{ formatAddrList(mail.detail.toJson) || mail.detail.accountEmail }}
                </div>
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
            <!-- 正文区是**唯一**的滚动面：iframe 铺满，内部自己滚（不再叠加外层滚动条） -->
            <div class="detail-body">
              <iframe
                v-if="mail.detail.htmlBody"
                class="html-frame"
                title="邮件正文"
                sandbox=""
                :src="bodyUrl"
              />
              <div v-else class="text-scroll">
                <pre class="text-body">{{ mail.detail.textBody || '（无正文）' }}</pre>
              </div>
            </div>
            <div v-if="mail.detail.truncated" class="detail-notes">
              <p class="warn">正文超过单封缓存上限，已截断保存。</p>
            </div>
            <div v-if="!mail.detail.bodyCached" class="detail-notes">
              <div class="uncached">
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
                  <button
                    class="btn-mini"
                    :disabled="savingAttachmentId === att.id"
                    @click="downloadAttachment(att)"
                  >
                    {{ savingAttachmentId === att.id ? '下载中…' : '另存' }}
                  </button>
                </li>
              </ul>
              <div v-if="mail.attachmentPreview" class="attach-preview">
                <div class="preview-head">
                  <span>{{ mail.attachmentPreview.filename }}</span>
                  <button class="btn-mini" type="button" @click="mail.closeAttachmentPreview">
                    收起
                  </button>
                </div>
                <img
                  v-if="mail.attachmentPreview.previewable"
                  class="preview-img"
                  :src="mail.attachmentPreview.dataUrl"
                  :alt="mail.attachmentPreview.filename"
                />
                <p v-else class="warn">
                  该附件不支持内联预览（{{
                    mail.attachmentPreview.mime || '未知类型'
                  }}），请用「打开 / 另存」。
                </p>
              </div>
            </footer>
          </template>
          <div v-else class="detail-empty">
            <b>{{ mode === 'todo' ? '点左侧待办，看这张单的全部邮件' : '选一封邮件查看正文' }}</b>
            <p v-if="mode === 'todo' && activeEvents.length > 1">
              同一单的多封邮件会在顶部排成时间线，点一下就能换。
            </p>
          </div>
        </section>
      </section>
    </div>
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

/* ---- 页头：只留同步状态与动作（标题在模块页壳上，不再重复一遍） ---- */
.mail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  flex: 0 0 auto;
}

.head-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--wb-primary);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.unread-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  white-space: nowrap;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text-muted);
  transition:
    background 0.14s ease,
    color 0.14s ease;
}

.icon-btn:hover {
  background: var(--wb-hover);
  color: var(--wb-text);
}

.purge-bar {
  flex: 0 0 auto;
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

/* ---- 左右主从 ---- */
.mail-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 10px;
}

.mail-rail {
  /* 固定基准、不参与伸缩：队列宽度随字号变化会让正文宽度跟着跳 */
  width: clamp(300px, 26vw, 360px);
  flex: 0 0 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  overflow: hidden;
}

.rail-head {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px 8px;
  border-bottom: 1px solid var(--wb-border);
}

.rail-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.rail-title h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  letter-spacing: 0.01em;
}

.rail-title .grow,
.grow {
  flex: 1 1 auto;
}

.rail-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--wb-text-muted);
}

/* 分段控件：待办 / 全部邮件 —— 两个视图，不是一个可以折叠的区块 */
.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.seg-btn {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: var(--wb-radius-sm);
  font-size: 12px;
  color: var(--wb-text-muted);
  white-space: nowrap;
  transition:
    background 0.14s ease,
    color 0.14s ease;
}

.seg-btn:hover {
  color: var(--wb-text);
}

.seg-btn.on {
  background: var(--wb-primary-soft);
  color: var(--wb-text);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--wb-border-strong);
}

.seg-n {
  font-size: 10.5px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.rail-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.rail-filters > * {
  flex: 0 0 auto;
}

.search-box {
  position: relative;
  flex: 1 1 100%;
  color: var(--wb-text-muted);
}

.search-box .wb-input {
  width: 100%;
  padding-left: 26px;
}

.search-box svg {
  position: absolute;
  left: 7px;
  top: 50%;
  transform: translateY(-50%);
}

.wb-input.narrow {
  width: 132px;
  font-size: 12px;
}

.wb-input.narrow.full {
  width: 100%;
}

.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--wb-text);
}

.rail-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 6px 6px;
}

.rail-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--wb-border);
  font-size: 10.5px;
  color: var(--wb-text-muted);
  min-width: 0;
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ---- 待办队列行：三行（类型+单号+时效 / 状态短句 / 共N封+邮箱+已处理） ---- */
.todo-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.todo-row {
  position: relative;
  padding: 8px 10px 8px 12px;
  border-radius: var(--wb-radius-md);
  cursor: pointer;
  transition:
    background 0.14s ease,
    box-shadow 0.14s ease;
}

.todo-row:hover {
  background: var(--wb-hover);
}

/* 左边缘 3px **只表达紧急度**；选中不抢这条边（否则两个含义压在同一条线上） */
.todo-row::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--wb-border-strong);
}

.todo-row.sev3::before {
  background: var(--wb-danger);
}

.todo-row.sev2::before {
  background: var(--wb-warning);
}

/*
  选中态三重编码：深色下 `#22262e` 与 `#191c22` 只差约 4%，
  只靠底色变化在真实屏幕上看不出来 —— 必须再叠一道描边环 + 单号加粗。
*/
.todo-row.active {
  background: var(--wb-primary-soft);
  box-shadow: inset 0 0 0 1px var(--wb-border-strong);
}

.tr-l1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.todo-kind {
  flex: 0 0 auto;
  font-size: 10.5px;
  line-height: 1.6;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}

.todo-kind.penalty {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}

.todo-kind.dispute {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.todo-kind.closed {
  background: var(--wb-accent-soft);
  color: var(--wb-accent);
}

.todo-order {
  flex: 0 0 auto;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--wb-text);
  letter-spacing: 0.01em;
}

.todo-row.active .todo-order {
  font-weight: 600;
}

.todo-flag {
  flex: 0 0 auto;
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent);
}

.todo-when {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 有申诉期的单：滞留时长本身就是风险信号，给它颜色 */
.todo-when.hot {
  color: var(--wb-danger);
}

/* 状态短句：两行折行 —— 单行 ellipsis 会把"罚单/纠纷到底怎么了"截在最关键处 */
.todo-label {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--wb-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tr-l3 {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--wb-text-muted);
  min-width: 0;
}

.dot-sep {
  opacity: 0.5;
}

.todo-dismiss {
  flex: 0 0 auto;
  color: var(--wb-text-muted);
  white-space: nowrap;
}

.todo-dismiss:hover:not(:disabled) {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
}

.todo-more {
  margin-top: 4px;
  color: var(--wb-text-muted);
  border-style: dashed;
  white-space: nowrap;
}

.todo-row.is-settled,
.todo-row.is-dismissed {
  opacity: 0.55;
}

.todo-row.is-settled::before,
.todo-row.is-dismissed::before {
  background: var(--wb-border-strong);
}

.queue-empty {
  padding: 22px 12px;
  text-align: center;
  color: var(--wb-text-muted);
  font-size: 11.5px;
  line-height: 1.8;
}

.queue-empty b {
  display: block;
  color: var(--wb-text);
  font-size: 12.5px;
  margin-bottom: 4px;
}

.queue-empty p {
  margin: 0 0 8px;
}

/* ---- 邮件列表（全部邮件模式） ---- */
.mail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mail-item {
  padding: 7px 9px;
  border-radius: var(--wb-radius-md);
  cursor: pointer;
  transition: background 0.14s ease;
}

.mail-item:hover {
  background: var(--wb-hover);
}

.mail-item.active {
  background: var(--wb-primary-soft);
  box-shadow: inset 0 0 0 1px var(--wb-border-strong);
}

.item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
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
  font-size: 10.5px;
  white-space: nowrap;
}

.subject {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--wb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview {
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--wb-text-muted);
}

/* ---- 右侧工作区 ---- */
.mail-work {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  overflow: hidden;
}

.doc-head {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 14px 8px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface);
}

.dh-l1 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dh-l1 .todo-kind {
  font-size: 10.5px;
  padding: 1px 6px;
}

.doc-order {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: -3px;
  padding: 1px 4px;
  border-radius: 4px;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  cursor: pointer;
  transition: background 0.14s ease;
}

.doc-order:hover {
  background: var(--wb-hover);
}

.doc-order svg {
  opacity: 0;
  color: var(--wb-text-muted);
  transition: opacity 0.14s ease;
}

.doc-order:hover svg,
.doc-order:focus-visible svg {
  opacity: 1;
}

.doc-done {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-color: var(--wb-border-strong);
  color: var(--wb-text);
  font-weight: 500;
}

.doc-done:hover:not(:disabled) {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  color: var(--wb-primary-contrast);
}

.dh-l2 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--wb-text-muted);
  min-width: 0;
}

.dh-l2 b {
  color: var(--wb-text);
  font-weight: 500;
}

.dh-l2 .sep {
  opacity: 0.5;
}

.dh-l2 .overdue {
  color: var(--wb-danger);
  font-variant-numeric: tabular-nums;
}

/* 时间线：本单几封邮件横排，点一下换"那一封" */
.thread {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  overflow-x: auto;
}

.thread-label {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--wb-text-muted);
  letter-spacing: 0.04em;
  margin-right: 2px;
}

.chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border-strong);
  background: var(--wb-surface);
  font-size: 10.5px;
  color: var(--wb-text-muted);
  transition:
    background 0.14s ease,
    color 0.14s ease,
    border-color 0.14s ease;
}

.chip:hover {
  color: var(--wb-text);
  border-color: var(--wb-accent);
}

.chip.on {
  background: var(--wb-primary-soft);
  border-color: var(--wb-border-strong);
  color: var(--wb-text);
  font-weight: 600;
}

.chip-time {
  font-variant-numeric: tabular-nums;
}

.chip-kind.penalty {
  color: var(--wb-danger);
}

.chip-kind.dispute {
  color: var(--wb-warning);
}

.chip-new {
  color: var(--wb-primary);
  opacity: 0.85;
}

/* ---- 详情 ---- */
.mail-detail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-head {
  flex: 0 0 auto;
  padding: 10px 14px;
  border-bottom: 1px solid var(--wb-border);
}

.detail-head h3 {
  margin: 0 0 5px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-text);
  line-height: 1.4;
}

.detail-meta {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-text);
}

.read-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.read-flag {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-primary-soft);
  color: var(--wb-text-muted);
}

.muted {
  color: var(--wb-text-muted);
}

/* 远程图拦截提示：夹在详情头与正文之间的一条细横条（正文高度不受它影响） */
.remote-hint {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  font-size: 10.5px;
  color: var(--wb-text-muted);
}

.remote-hint span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
  正文容器 = 唯一的滚动面。
  iframe 铺满容器、**内部**自己滚；以前给它 `min-height:320px` 又让外层 `overflow:auto`，
  于是「窗口小一点 → 外层出现滚动条 + 邮件里还有一条」—— 用户第一屏只看得到 1/3 封。
*/
.detail-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  padding: 10px 12px 12px;
}

.html-frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  /* 邮件正文本身是浅色排版：深色界面里把它当"一张纸"，而不是靠反色（反色会毁掉邮件排版） */
  background: #fff;
}

.text-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.text-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--wb-text);
}

.detail-notes {
  flex: 0 0 auto;
  padding: 0 14px 8px;
}

.warn {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--wb-warning);
}

.uncached {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--wb-text-muted);
  flex-wrap: wrap;
}

.detail-attach {
  flex: 0 0 auto;
  border-top: 1px solid var(--wb-border);
  padding: 7px 14px 10px;
  font-size: 11.5px;
  max-height: 34%;
  overflow: auto;
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
  padding-left: 16px;
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
  max-height: 260px;
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

.detail-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
  color: var(--wb-text-muted);
  font-size: 11.5px;
}

.detail-empty b {
  color: var(--wb-text);
  font-size: 13px;
  font-weight: 600;
}

.detail-empty p {
  margin: 0;
  max-width: 320px;
  line-height: 1.7;
}

/* ---- 通用小件 ---- */
.btn-mini {
  border: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  color: var(--wb-text);
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 10.5px;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    color 0.14s ease,
    background 0.14s ease;
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
  font-size: 11.5px;
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
