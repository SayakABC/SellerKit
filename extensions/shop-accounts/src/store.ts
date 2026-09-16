// extensions/shop-accounts/src/store.ts
// 「店铺账号管家」状态层：店铺套列表 / 筛选 / 汇总、编辑态、隐私模式与按需解密复制。
//
// 业务模型：一行 = 一套店铺（邮箱为主标识），含店铺密码 / 邮箱密码 / 手机号 / 企业名称 /
// 支付宝 + 支付密码 / 紫鸟账号 + 紫鸟密码 / ERP账号 + ERP密码 / 关联平台 / 状态 / 标签 / 备注。
//
// 安全约定：列表接口永不返回明文密码；仅在「临时查看」或「复制密码」时经
// shopAccountReveal 单字段按需解密，且明文不落入持久化状态（仅在界面存活期内保留）。

import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  shopAccountBatchUpdate,
  shopAccountDbEnsure,
  shopAccountDelete,
  shopAccountGet,
  shopAccountList,
  shopAccountReveal,
  shopAccountSecurity,
  shopAccountSummary,
  shopAccountUpsert,
} from '@/core/services/ipc';
import { writeClipboard } from '@/core/services/clipboard';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';
import type {
  ShopAccountBatchFieldPatch,
  ShopAccountDetail,
  ShopAccountItem,
  ShopAccountPlatformCount,
  ShopAccountSecretField,
  ShopAccountSecretKey,
  ShopAccountStatus,
  ShopAccountUpsertInput,
} from '@/types';

/** 密码明文临时显现时长（毫秒），到时自动掩码 */
const SECRET_REVEAL_MS = 8000;

/** 搜索输入防抖时长（毫秒） */
const SEARCH_DEBOUNCE_MS = 250;

/** 可一键复制的明文字段（列表点击即复制） */
export type PlainField =
  | 'email'
  | 'phone'
  | 'company'
  | 'alipay'
  | 'ziniaoAccount'
  | 'erpAccount'
  | 'openedAt'
  | 'tags'
  | 'note';

/**
 * 敏感字段元信息（列表徽标 / 编辑表单共用）。
 * 仅含店铺套直接维护的 5 类密码：IMAP 授权码（mailAuthPwd）走收件箱接入流程，不在此列。
 */
export interface SecretFieldMeta {
  key: ShopAccountSecretField;
  label: string;
}

export const SECRET_FIELDS: SecretFieldMeta[] = [
  { key: 'shopPwd', label: '店铺密码' },
  { key: 'emailPwd', label: '邮箱密码' },
  { key: 'alipayPwd', label: '支付宝密码' },
  { key: 'ziniaoPwd', label: '紫鸟密码' },
  { key: 'erpPwd', label: 'ERP密码' },
];

export type StatusTone = 'success' | 'muted' | 'warning' | 'danger';

/** 状态元信息（值 / 中文名 / 语义色） */
export interface StatusMeta {
  value: ShopAccountStatus;
  label: string;
  tone: StatusTone;
}

export const STATUS_META: StatusMeta[] = [
  { value: 'active', label: '在用', tone: 'success' },
  { value: 'paused', label: '停用', tone: 'muted' },
  { value: 'banned', label: '封店', tone: 'warning' },
  { value: 'closed', label: '已注销', tone: 'danger' },
];

/**
 * 一键复制模板条目：明文字段 / 敏感字段（按需解密）/ 关联平台（多值拼接）/ 状态（枚举转中文）。
 * 用判别键（plain / secret / platforms / status）区分，便于 copyTemplate 逐类解析。
 */
export type CopyTemplateField =
  | { label: string; plain: PlainField }
  | { label: string; secret: ShopAccountSecretKey }
  | { label: string; platforms: true }
  | { label: string; status: true };

/** 一键复制模板：把高频登录组合拼成可直接粘贴的文本 */
export interface CopyTemplate {
  id: string;
  label: string;
  fields: CopyTemplateField[];
  /**
   * 缺失字段处理策略：
   * - false（默认）：任一字段为空即中断并提示，适合「ERP 登录」这类少字段强关联场景；
   * - true：空字段直接跳过，只复制有值项（全字段模板用，避免因备注/标签为空整单失败）。
   */
  skipMissing?: boolean;
}

/**
 * 默认复制模板（按运营高频场景预定：ERP 登录 / 紫鸟登录 / 全字段）。
 * 后续如需「注册用 / 付款用」等组合，在此追加即可，视图与设置无需改动。
 */
export const COPY_TEMPLATES: CopyTemplate[] = [
  {
    id: 'erp',
    label: 'ERP 登录',
    fields: [
      { label: 'ERP账号', plain: 'erpAccount' },
      { label: 'ERP密码', secret: 'erpPwd' },
    ],
  },
  {
    id: 'ziniao',
    label: '紫鸟登录',
    fields: [
      { label: '紫鸟账号', plain: 'ziniaoAccount' },
      { label: '紫鸟密码', secret: 'ziniaoPwd' },
    ],
  },
  {
    id: 'full',
    label: '全部字段',
    // 全字段必然存在空项（标签/备注等），缺失即跳过而非中断
    skipMissing: true,
    fields: [
      { label: '店铺邮箱', plain: 'email' },
      { label: '店铺密码', secret: 'shopPwd' },
      { label: '邮箱密码', secret: 'emailPwd' },
      { label: '关联手机号', plain: 'phone' },
      { label: '关联企业名称', plain: 'company' },
      { label: '关联支付宝', plain: 'alipay' },
      { label: '支付宝密码', secret: 'alipayPwd' },
      { label: '紫鸟账号', plain: 'ziniaoAccount' },
      { label: '紫鸟密码', secret: 'ziniaoPwd' },
      { label: 'ERP账号', plain: 'erpAccount' },
      { label: 'ERP密码', secret: 'erpPwd' },
      { label: '关联平台', platforms: true },
      { label: '开店时间', plain: 'openedAt' },
      { label: '状态', status: true },
      { label: '标签', plain: 'tags' },
      { label: '备注', plain: 'note' },
    ],
  },
];

/** 按状态值取元信息（未知值兜底「在用」） */
export function statusMeta(value: ShopAccountStatus): StatusMeta {
  return STATUS_META.find((m) => m.value === value) || STATUS_META[0];
}

/** 一天毫秒数（开店至今天数计算用） */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 开店时间格式（YYYY-MM-DD，用于判定是否为可计算的有效值） */
const OPENED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 开店至今的天数（按自然日算：今天开店 = 0 天）。
 * 未填写 / 格式非法 / 未来日期一律返回 null，交由调用方决定展示占位。
 * @param openedAt 开店时间（YYYY-MM-DD）
 * @returns 天数；不可计算时返回 null
 */
export function openedDaysOf(openedAt: string): number | null {
  const value = String(openedAt || '').trim();
  if (!OPENED_AT_PATTERN.test(value)) return null;
  // 按本地零点解析，避免时区偏移导致差一天
  const startedAt = new Date(`${value}T00:00:00`).getTime();
  if (Number.isNaN(startedAt)) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((todayStart - startedAt) / MS_PER_DAY);
  return days >= 0 ? days : null;
}

/**
 * 开店天数的展示文案：无效返回空串，有效返回「已开 N 天」（当天开店显示「今天开店」）。
 * @param openedAt 开店时间（YYYY-MM-DD）
 * @returns 展示文案，如 '已开 365 天'
 */
export function openedDaysText(openedAt: string): string {
  const days = openedDaysOf(openedAt);
  if (days === null) return '';
  return days === 0 ? '今天开店' : `已开 ${days} 天`;
}

/**
 * 关联平台预设枚举（常见跨境 / 国内电商平台）。
 * 仅作为编辑抽屉下拉的候选，**不做数据层白名单校验**：
 * 历史数据中的自定义平台名仍原样保留，列表筛选同样按实际数据生成。
 */
export const PLATFORM_OPTIONS: string[] = [
  'Amazon',
  '速卖通',
  'Temu',
  'TikTok Shop',
  'SHEIN',
  'eBay',
  'Walmart',
  'Shopee',
  'Lazada',
  'Ozon',
  'Mercado Libre',
  'Coupang',
  'Wish',
  '独立站',
];

// ── 分组归类模型（以自选字段为维度查看账号组）────────────────────────────────
//
// 分组只作用于**当前筛选结果**（items），因此可先按状态/平台/关键词收窄，
// 再按自选字段归类看每组有多少套店铺、状态分布如何。

/** 列表视图模式：表格 / 卡片 / 分组归类 */
export type ShopAccountsViewMode = 'table' | 'card' | 'group';

/** 可作分组维度的字段 */
export type GroupField =
  | 'status'
  | 'platforms'
  | 'company'
  | 'phone'
  | 'emailDomain'
  | 'alipay'
  | 'ziniaoAccount'
  | 'erpAccount'
  | 'tags';

/** 分组维度元信息 */
export interface GroupFieldMeta {
  field: GroupField;
  label: string;
  /** 多值维度：一套店铺可同时归入多个组（关联平台 / 标签） */
  multi?: boolean;
}

/** 可选分组维度（数组顺序 = 候选面板展示顺序，实际层级顺序取决于用户勾选顺序） */
export const GROUP_FIELDS: GroupFieldMeta[] = [
  { field: 'status', label: '店铺状态' },
  { field: 'platforms', label: '关联平台', multi: true },
  { field: 'company', label: '关联企业' },
  { field: 'phone', label: '关联手机号' },
  { field: 'emailDomain', label: '邮箱域名' },
  { field: 'alipay', label: '关联支付宝' },
  { field: 'ziniaoAccount', label: '紫鸟账号' },
  { field: 'erpAccount', label: 'ERP账号' },
  { field: 'tags', label: '标签', multi: true },
];

/** 维度值缺失时的兜底组名 */
export const UNGROUPED_LABEL = '未填写';

/** 取分组维度中文名（未知维度兜底回显原键） */
export function groupFieldLabel(field: GroupField): string {
  return GROUP_FIELDS.find((m) => m.field === field)?.label || field;
}

/** 该维度是否多值（一套店铺可落入多个组） */
export function isMultiGroupField(field: GroupField): boolean {
  return GROUP_FIELDS.some((m) => m.field === field && m.multi === true);
}

/** 取邮箱域名（最后一个 @ 之后部分）；无 @ 返回空串 */
function emailDomainOf(email: string): string {
  const at = (email || '').lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim() : '';
}

/** 取一套店铺在某维度下的全部取值（空数组 = 归入「未填写」组；已去重） */
function groupValuesOf(item: ShopAccountItem, field: GroupField): string[] {
  if (field === 'status') return [statusMeta(item.status).label];
  if (field === 'platforms') {
    return [...new Set((item.platforms || []).map((p) => p.trim()).filter(Boolean))];
  }
  // 标签是「逗号分隔的自由文本」，按中英文逗号 / 顿号拆分才能形成有意义的组
  if (field === 'tags') {
    const parts = (item.tags || '')
      .split(/[,，、]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return [...new Set(parts)];
  }
  if (field === 'emailDomain') {
    const domain = emailDomainOf(item.email);
    return domain ? [domain] : [];
  }
  const raw = String(item[field] ?? '').trim();
  return raw ? [raw] : [];
}

/** 分组节点（dims 依次下钻；children 为空即叶子组，items 为该组命中的店铺） */
export interface GroupNode {
  /** 全局唯一键（父键 + 本层维度值），用于展开态与 v-for key */
  key: string;
  /** 本层维度值（组名） */
  label: string;
  /** 本层维度字段 */
  field: GroupField;
  /** 本组命中的店铺（多值维度下同一店铺可出现在多个组） */
  items: ShopAccountItem[];
  children: GroupNode[];
}

/**
 * 分组选中态（左栏导航复选框三态）：
 * - none    该组（含子组）无任何店铺被勾选
 * - partial 部分勾选（indeterminate）
 * - all     全部勾选
 */
export type SelectionState = 'none' | 'partial' | 'all';

/**
 * 按维度顺序逐层分桶构造分组树。
 * 组间排序：先按店铺数降序，同数量按组名升序（用中文排序规则）。
 * @param parentKey 父级路径键，用于保证跨层级 key 唯一（折叠态不串台）
 */
function buildGroupTree(list: ShopAccountItem[], dims: GroupField[], parentKey: string): GroupNode[] {
  if (!dims.length || !list.length) return [];
  const [field, ...rest] = dims;
  const buckets = new Map<string, ShopAccountItem[]>();
  for (const item of list) {
    const values = groupValuesOf(item, field);
    for (const value of values.length ? values : [UNGROUPED_LABEL]) {
      const bucket = buckets.get(value);
      if (bucket) bucket.push(item);
      else buckets.set(value, [item]);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([label, bucketItems]) => {
      const key = `${parentKey}/${field}:${label}`;
      return {
        key,
        label,
        field,
        items: bucketItems,
        children: buildGroupTree(bucketItems, rest, key),
      };
    });
}

/** 在分组树中按 key 查找节点（左栏导航 → 右侧详情的定位依据；未命中返回 null） */
function findGroupNode(nodes: GroupNode[], key: string): GroupNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    const hit = findGroupNode(node.children, key);
    if (hit) return hit;
  }
  return null;
}

/**
 * 取从根到目标分组的节点路径（面包屑用，含目标自身）；未命中返回空数组。
 * 路径长度即层级深度，元素自带 field 可回显维度名。
 */
function groupNodeTrail(nodes: GroupNode[], key: string, trail: GroupNode[] = []): GroupNode[] {
  for (const node of nodes) {
    const next = [...trail, node];
    if (node.key === key) return next;
    const hit = groupNodeTrail(node.children, key, next);
    if (hit.length) return hit;
  }
  return [];
}

/** 统计分组节点总数（含各层级） */
function countGroupNodes(nodes: GroupNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countGroupNodes(n.children), 0);
}

/** 收集全部分组键（「收起全部」用） */
function collectGroupKeys(nodes: GroupNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.key);
    collectGroupKeys(node.children, out);
  }
  return out;
}

/** 主视图顶部页签：账号库 / 邮件收件箱 */
export type ShopAccountsMainTab = 'accounts' | 'mail';

/** 分组视图偏好（持久化到 modules.shop-accounts，与业务数据隔离） */
export interface ShopAccountsPrefs {
  viewMode?: ShopAccountsViewMode;
  groupFields?: GroupField[];
  mainTab?: ShopAccountsMainTab;
}

export const useShopAccountsStore = defineStore('shop-accounts', () => {
  const items = ref<ShopAccountItem[]>([]);
  const loading = ref(false);
  const initialized = ref(false);
  const saving = ref(false);
  /** 系统安全存储是否可用（false = 密码降级存储，需警示） */
  const secureStorage = ref(true);

  // 筛选与视图
  const search = ref('');
  const statusFilter = ref<ShopAccountStatus | ''>('');
  const platformFilter = ref('');
  const viewMode = ref<ShopAccountsViewMode>('table');
  /** 顶部页签：账号库 / 邮件收件箱（邮件为独立 store，见 mailStore.ts） */
  const mainTab = ref<ShopAccountsMainTab>('accounts');
  /** 隐私模式：全局隐藏所有密码，防投屏/录屏泄露 */
  const privacyMode = ref(false);

  // 分组归类（以自选字段为维度查看账号组）：数组顺序 = 分组层级顺序
  const groupFields = ref<GroupField[]>([]);
  /** 已折叠的分组键（含父级路径，层级间不冲突） */
  const collapsedGroupKeys = ref<string[]>([]);
  /** 分组视图中当前聚焦的分组键（'' = 全部分组；维度调整后失效会自动回落为全部分组） */
  const activeGroupKey = ref('');

  const summary = reactive<{
    total: number;
    byStatus: Partial<Record<ShopAccountStatus, number>>;
    platforms: ShopAccountPlatformCount[];
  }>({ total: 0, byStatus: {}, platforms: [] });

  // 编辑抽屉
  const editorOpen = ref(false);
  const editorDetail = ref<ShopAccountDetail | null>(null);
  const editorLoading = ref(false);

  // 批量修改：选中集合 + 抽屉开关 + 提交中标记
  const selectedIds = ref<Set<number>>(new Set());
  const batchEditOpen = ref(false);
  const batchSaving = ref(false);

  // 临时显现的明文（key = `${id}:${field}`），到时由定时器自动清除
  const revealed = ref<Record<string, string>>({});
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const statusCounts = computed(() =>
    STATUS_META.map((meta) => ({ ...meta, count: summary.byStatus[meta.value] || 0 })),
  );
  const isEmpty = computed(() => !loading.value && items.value.length === 0);
  const hasFilter = computed(
    () => !!search.value.trim() || !!statusFilter.value || !!platformFilter.value,
  );

  // ── 分组归类 computed ─────────────────────────────────────────────────────

  /** 有效分组维度（顺带过滤历史脏数据里的未知字段） */
  const activeGroupFields = computed(() =>
    groupFields.value.filter((f) => GROUP_FIELDS.some((m) => m.field === f)),
  );
  const grouping = computed(() => activeGroupFields.value.length > 0);
  /** 分组树（作用于当前筛选结果，非全量） */
  const groupTree = computed(() => buildGroupTree(items.value, activeGroupFields.value, ''));
  /** 分组总数（含各层级） */
  const groupNodeCount = computed(() => countGroupNodes(groupTree.value));
  /** 是否含多值维度（同一店铺可出现在多个分组，需提示避免误读合计数） */
  const hasMultiGroup = computed(() => activeGroupFields.value.some(isMultiGroupField));

  /** 当前聚焦的分组节点（key 为空或维度调整后失效时为 null，视为「全部」） */
  const activeGroupNode = computed<GroupNode | null>(() =>
    activeGroupKey.value ? findGroupNode(groupTree.value, activeGroupKey.value) : null,
  );
  /**
   * 详情区实际展示的店铺列表。
   * - 聚焦某分组时：该组 node.items（已含全部后代店铺的并集，故父组天然涵盖子组）
   * - 未聚焦 / 键失效时：当前筛选结果全集
   */
  const activeGroupItems = computed(() =>
    viewMode.value === 'group' && activeGroupNode.value
      ? activeGroupNode.value.items
      : items.value,
  );
  /** 当前分组的面包屑路径（含各层级 field 与组名；「全部」时为空数组） */
  const activeGroupTrail = computed(() =>
    activeGroupNode.value ? groupNodeTrail(groupTree.value, activeGroupNode.value.key) : [],
  );
  /** 全量选中态（左栏「全部店铺」复选框三态） */
  const allSelectionState = computed<SelectionState>(() => {
    if (!items.value.length || selectedIds.value.size === 0) return 'none';
    return items.value.every((it) => selectedIds.value.has(it.id)) ? 'all' : 'partial';
  });

  // ── 视图偏好持久化（命名空间 modules.shop-accounts）─────────────────────

  const prefs = useModuleStorage<ShopAccountsPrefs>('shop-accounts');

  function savePrefs(): void {
    prefs.scheduleSave({
      viewMode: viewMode.value,
      groupFields: [...groupFields.value],
      mainTab: mainTab.value,
    });
  }

  /** 读取视图偏好（缺失 / 非法值一律保持默认，保证向后兼容） */
  async function loadPrefs(): Promise<void> {
    try {
      const data = await prefs.load();
      if (!data) return;
      if (data.viewMode === 'table' || data.viewMode === 'card' || data.viewMode === 'group') {
        viewMode.value = data.viewMode;
      }
      if (Array.isArray(data.groupFields)) {
        groupFields.value = data.groupFields.filter((f) =>
          GROUP_FIELDS.some((m) => m.field === f),
        );
      }
      if (data.mainTab === 'accounts' || data.mainTab === 'mail') {
        mainTab.value = data.mainTab;
      }
    } catch (e: unknown) {
      console.error('[shop-accounts] 读取视图偏好失败:', e);
    }
  }

  function normalizeError(e: unknown): string {
    return e instanceof Error ? e.message : '未知错误';
  }

  function revealKey(id: number, field: ShopAccountSecretKey): string {
    return `${id}:${field}`;
  }

  /** 是否处于「临时显现」状态（隐私模式下恒为 false） */
  function isRevealed(id: number, field: ShopAccountSecretKey): boolean {
    if (privacyMode.value) return false;
    return !!revealed.value[revealKey(id, field)];
  }

  /** 取当前临时显现的明文（未显现返回空串） */
  function revealedValue(id: number, field: ShopAccountSecretKey): string {
    if (privacyMode.value) return '';
    return revealed.value[revealKey(id, field)] || '';
  }

  function clearReveal(id: number, field: ShopAccountSecretKey): void {
    const key = revealKey(id, field);
    const timer = revealTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(key);
    }
    if (key in revealed.value) {
      const next = { ...revealed.value };
      delete next[key];
      revealed.value = next;
    }
  }

  /** 清除全部临时显现（隐私模式开启 / 模块切换时调用） */
  function clearAllReveals(): void {
    for (const timer of revealTimers.values()) clearTimeout(timer);
    revealTimers.clear();
    if (Object.keys(revealed.value).length > 0) revealed.value = {};
  }

  function setPrivacyMode(value: boolean): void {
    privacyMode.value = value;
    if (value) clearAllReveals();
  }

  async function loadSummary(): Promise<void> {
    const result = await shopAccountSummary();
    if (!result.success || !result.data) return;
    summary.total = result.data.total;
    summary.byStatus = result.data.byStatus || {};
    summary.platforms = result.data.platforms || [];
  }

  async function loadSecurity(): Promise<void> {
    const result = await shopAccountSecurity();
    if (result.success && result.data) secureStorage.value = !!result.data.secureStorage;
  }

  /** 按当前筛选条件拉取列表 */
  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const result = await shopAccountList({
        search: search.value.trim(),
        status: statusFilter.value,
        platform: platformFilter.value,
      });
      if (!result.success) {
        toast(result.error || '加载失败', 'error');
        return;
      }
      items.value = result.data || [];
    } catch (e: unknown) {
      toast(`加载失败: ${normalizeError(e)}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  /** 首次激活初始化（建表 + 汇总 + 安全状态 + 列表） */
  async function init(): Promise<void> {
    if (initialized.value) return;
    loading.value = true;
    try {
      const ensure = await shopAccountDbEnsure();
      if (!ensure.success) throw new Error(ensure.error || '初始化失败');
      initialized.value = true;
      await Promise.all([loadSummary(), loadSecurity(), loadPrefs()]);
      await refresh();
    } catch (e: unknown) {
      toast(`初始化失败: ${normalizeError(e)}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  /** 重新进入模块时刷新（保留筛选条件） */
  async function reload(): Promise<void> {
    await Promise.all([refresh(), loadSummary()]);
  }

  function resetFilters(): void {
    search.value = '';
    statusFilter.value = '';
    platformFilter.value = '';
  }

  // ── 分组操作 ─────────────────────────────────────────────────────────────

  /** 切换某维度是否参与分组（勾选顺序 = 分组层级顺序） */
  function toggleGroupField(field: GroupField): void {
    groupFields.value = groupFields.value.includes(field)
      ? groupFields.value.filter((f) => f !== field)
      : [...groupFields.value, field];
    collapsedGroupKeys.value = [];
    // 维度变了，旧的分组键不再有效，回到「全部分组」
    activeGroupKey.value = '';
  }

  /** 调整维度层级顺序（delta = -1 上移 / +1 下移） */
  function moveGroupField(field: GroupField, delta: number): void {
    const next = [...groupFields.value];
    const from = next.indexOf(field);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    groupFields.value = next;
    collapsedGroupKeys.value = [];
    activeGroupKey.value = '';
  }

  function clearGroupFields(): void {
    groupFields.value = [];
    collapsedGroupKeys.value = [];
    activeGroupKey.value = '';
  }

  function isGroupCollapsed(key: string): boolean {
    return collapsedGroupKeys.value.includes(key);
  }

  function toggleGroupCollapse(key: string): void {
    collapsedGroupKeys.value = isGroupCollapsed(key)
      ? collapsedGroupKeys.value.filter((k) => k !== key)
      : [...collapsedGroupKeys.value, key];
  }

  function expandAllGroups(): void {
    collapsedGroupKeys.value = [];
  }

  function collapseAllGroups(): void {
    collapsedGroupKeys.value = collectGroupKeys(groupTree.value);
  }

  /** 复制一批店铺的邮箱（去重、每行一个，便于批量派单 / 导入） */
  async function copyEmails(list: ShopAccountItem[], label: string): Promise<void> {
    const emails = [...new Set(list.map((i) => (i.email || '').trim()).filter(Boolean))];
    if (!emails.length) {
      toast('没有可复制的邮箱', 'info');
      return;
    }
    await copyText(emails.join('\n'), `${label} 的 ${emails.length} 个邮箱`);
  }

  // ── 分组导航（左栏）──────────────────────────────────────────────────────

  /** 聚焦某个分组（'' = 回到全部分组） */
  function setActiveGroup(key: string): void {
    activeGroupKey.value = key;
  }

  /** 某分组（含子组）的选中态，供左栏复选框三态展示 */
  function groupSelectionState(node: GroupNode): SelectionState {
    if (!node.items.length) return 'none';
    let hit = 0;
    for (const item of node.items) if (selectedIds.value.has(item.id)) hit += 1;
    if (hit === 0) return 'none';
    return hit === node.items.length ? 'all' : 'partial';
  }

  /** 整组选中 / 取消（三态语义：已全选 → 取消本组；其余 → 全选本组） */
  function toggleSelectGroup(node: GroupNode): void {
    const next = new Set(selectedIds.value);
    const deselect = groupSelectionState(node) === 'all';
    for (const item of node.items) {
      if (deselect) next.delete(item.id);
      else next.add(item.id);
    }
    selectedIds.value = next;
  }

  // 筛选条件变化时自动防抖重查
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  watch(search, () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refresh(), SEARCH_DEBOUNCE_MS);
  });
  watch([statusFilter, platformFilter], () => void refresh());
  // 视图模式 / 分组维度 / 顶部页签变化即持久化，下次进入模块沿用
  watch([viewMode, groupFields, mainTab], savePrefs);

  // ── 复制 ──────────────────────────────────────────────────────────────────

  async function copyText(text: string, label: string): Promise<boolean> {
    if (!text) {
      toast(`${label}为空`, 'info');
      return false;
    }
    const ok = await writeClipboard(text);
    if (!ok) {
      toast('复制失败', 'error');
      return false;
    }
    toast(`已复制${label}`, 'success');
    return true;
  }

  /** 点击即复制明文字段 */
  async function copyPlain(item: ShopAccountItem, field: PlainField, label: string): Promise<void> {
    await copyText(String(item[field] || '').trim(), label);
  }

  /** 复制密码：解密后直接写入剪贴板，不在界面显示明文 */
  async function copySecret(
    item: ShopAccountItem,
    field: ShopAccountSecretKey,
    label: string,
  ): Promise<void> {
    try {
      const result = await shopAccountReveal(item.id, field);
      if (!result.success) {
        toast(result.error || '读取失败', 'error');
        return;
      }
      await copyText(result.data?.value || '', label);
    } catch (e: unknown) {
      toast(`读取失败: ${normalizeError(e)}`, 'error');
    }
  }

  /**
   * 解析单个模板条目为可复制文本。
   * @returns ok=false 表示读密码失败（已 toast，调用方应中断）；value 为空串表示该项无值。
   */
  async function resolveTemplateField(
    item: ShopAccountItem,
    field: CopyTemplateField,
  ): Promise<{ ok: boolean; value: string }> {
    if ('secret' in field) {
      // 列表行带 secretKeys 标记，未配置的密码无需发起解密
      if (!item.secretKeys.includes(field.secret)) return { ok: true, value: '' };
      const result = await shopAccountReveal(item.id, field.secret);
      if (!result.success) {
        toast(result.error || '读取密码失败', 'error');
        return { ok: false, value: '' };
      }
      return { ok: true, value: result.data?.value || '' };
    }
    if ('platforms' in field) return { ok: true, value: (item.platforms || []).join('、') };
    if ('status' in field) return { ok: true, value: statusMeta(item.status).label };
    return { ok: true, value: String(item[field.plain] || '').trim() };
  }

  /** 按模板一键复制（如 ERP 登录 = ERP账号 + ERP密码；全部字段 = 有值项逐行拼装） */
  async function copyTemplate(item: ShopAccountItem, templateId: string): Promise<void> {
    const template = COPY_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const skipMissing = template.skipMissing === true;
    const lines: string[] = [];
    for (const field of template.fields) {
      const resolved = await resolveTemplateField(item, field);
      if (!resolved.ok) return;
      if (!resolved.value) {
        if (skipMissing) continue;
        toast(`${field.label}${'secret' in field ? '未配置' : '未填写'}`, 'info');
        return;
      }
      lines.push(`${field.label}: ${resolved.value}`);
    }
    if (!lines.length) {
      toast('没有可复制的字段', 'info');
      return;
    }
    await copyText(lines.join('\n'), `${template.label}信息`);
  }

  /** 切换临时显现（再次点击或到时后自动掩码） */
  async function toggleReveal(
    item: ShopAccountItem,
    field: ShopAccountSecretKey,
    label: string,
  ): Promise<void> {
    if (privacyMode.value) {
      toast('隐私模式已开启，请先关闭再查看密码', 'info');
      return;
    }
    if (revealed.value[revealKey(item.id, field)]) {
      clearReveal(item.id, field);
      return;
    }
    try {
      const result = await shopAccountReveal(item.id, field);
      if (!result.success) {
        toast(result.error || '读取失败', 'error');
        return;
      }
      const value = result.data?.value || '';
      if (!value) {
        toast(`${label}未配置`, 'info');
        return;
      }
      revealed.value = { ...revealed.value, [revealKey(item.id, field)]: value };
      const timer = setTimeout(() => clearReveal(item.id, field), SECRET_REVEAL_MS);
      revealTimers.set(revealKey(item.id, field), timer);
    } catch (e: unknown) {
      toast(`读取失败: ${normalizeError(e)}`, 'error');
    }
  }

  // ── 编辑 / 删除 ───────────────────────────────────────────────────────────

  function openCreate(): void {
    editorDetail.value = null;
    editorOpen.value = true;
  }

  async function openEdit(id: number): Promise<void> {
    editorOpen.value = true;
    editorLoading.value = true;
    editorDetail.value = null;
    try {
      const result = await shopAccountGet(id);
      if (!result.success) throw new Error(result.error || '读取失败');
      editorDetail.value = result.data ?? null;
    } catch (e: unknown) {
      toast(`读取详情失败: ${normalizeError(e)}`, 'error');
      editorOpen.value = false;
    } finally {
      editorLoading.value = false;
    }
  }

  function closeEditor(): void {
    editorOpen.value = false;
    editorDetail.value = null;
  }

  async function save(payload: ShopAccountUpsertInput): Promise<boolean> {
    saving.value = true;
    try {
      // IPC 走结构化克隆，Vue 响应式代理（Proxy）无法被克隆：此处统一展开为纯值，
      // 避免调用报 "An object could not be cloned."（platforms / secrets 为对象型字段）。
      const plain: ShopAccountUpsertInput = {
        ...payload,
        platforms: payload.platforms ? [...payload.platforms] : undefined,
        secrets: payload.secrets ? { ...payload.secrets } : undefined,
      };
      const result = await shopAccountUpsert(plain);
      if (!result.success) {
        toast(result.error || '保存失败', 'error');
        return false;
      }
      if (typeof result.data?.secureStorage === 'boolean') {
        secureStorage.value = result.data.secureStorage;
      }
      toast(payload.id ? '已保存修改' : '已新增店铺套', 'success');
      closeEditor();
      await Promise.all([refresh(), loadSummary()]);
      return true;
    } catch (e: unknown) {
      toast(`保存失败: ${normalizeError(e)}`, 'error');
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function remove(item: ShopAccountItem): Promise<void> {
    try {
      const result = await shopAccountDelete(item.id);
      if (!result.success) throw new Error(result.error || '删除失败');
      for (const field of SECRET_FIELDS) clearReveal(item.id, field.key);
      toggleSelect(item.id, false);
      toast('已删除该店铺套', 'success');
      await Promise.all([refresh(), loadSummary()]);
    } catch (e: unknown) {
      toast(`删除失败: ${normalizeError(e)}`, 'error');
    }
  }

  // ── 批量修改 ─────────────────────────────────────────────────────────────

  /** 选中条数（工具栏徽标 / 抽屉确认文案共用） */
  const selectionCount = computed(() => selectedIds.value.size);
  const hasSelection = computed(() => selectedIds.value.size > 0);

  /** 是否选中（行复选框绑定） */
  function isSelected(id: number): boolean {
    return selectedIds.value.has(id);
  }

  /** 勾选 / 取消勾选单条（force 可强制指定目标态） */
  function toggleSelect(id: number, force?: boolean): void {
    const next = new Set(selectedIds.value);
    const target = force ?? !next.has(id);
    if (target) next.add(id);
    else next.delete(id);
    selectedIds.value = next;
  }

  /** 纯全选（不反选）：分组级批量操作前自动选中整组用 */
  function selectAll(): void {
    selectedIds.value = new Set(items.value.map((it) => it.id));
  }

  /** 当前列表全选 / 取消全选（作用于当前筛选结果 items） */
  function toggleSelectAll(): void {
    const allSelected =
      items.value.length > 0 && items.value.every((it) => selectedIds.value.has(it.id));
    const next = new Set(selectedIds.value);
    if (allSelected) {
      for (const it of items.value) next.delete(it.id);
    } else {
      for (const it of items.value) next.add(it.id);
    }
    selectedIds.value = next;
  }

  /** 当前列表是否已全选（表头复选框态） */
  function isAllSelected(): boolean {
    return (
      items.value.length > 0 && items.value.every((it) => selectedIds.value.has(it.id))
    );
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  function openBatchEdit(): void {
    if (selectedIds.value.size === 0) {
      toast('请先勾选要批量修改的店铺套', 'info');
      return;
    }
    batchEditOpen.value = true;
  }

  function closeBatchEdit(): void {
    batchEditOpen.value = false;
  }

  /**
   * 提交批量修改（patch 中未声明字段不动）
   * 成功后：清空选择、关闭抽屉、刷新列表与汇总
   */
  async function batchUpdate(patch: ShopAccountBatchFieldPatch): Promise<boolean> {
    const ids = Array.from(selectedIds.value);
    if (ids.length === 0) {
      toast('请先勾选要批量修改的店铺套', 'error');
      return false;
    }
    batchSaving.value = true;
    try {
      const result = await shopAccountBatchUpdate({ ids, patch });
      if (!result.success) throw new Error(result.error || '批量修改失败');
      toast(`已批量修改 ${result.data?.updated ?? 0} 套店铺`, 'success');
      clearSelection();
      batchEditOpen.value = false;
      await Promise.all([refresh(), loadSummary()]);
      return true;
    } catch (e: unknown) {
      toast(`批量修改失败: ${normalizeError(e)}`, 'error');
      return false;
    } finally {
      batchSaving.value = false;
    }
  }

  // 列表刷新后剔除已不存在的选中项，避免悬挂 id 进入批量提交
  watch(items, (nextItems) => {
    if (selectedIds.value.size === 0) return;
    const alive = new Set(nextItems.map((it) => it.id));
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)));
    if (next.size !== selectedIds.value.size) selectedIds.value = next;
  });

  return {
    // state
    items,
    loading,
    initialized,
    saving,
    secureStorage,
    search,
    statusFilter,
    platformFilter,
    viewMode,
    mainTab,
    privacyMode,
    summary,
    groupFields,
    collapsedGroupKeys,
    activeGroupKey,
    editorOpen,
    editorDetail,
    editorLoading,
    selectedIds,
    batchEditOpen,
    batchSaving,
    // computed
    statusCounts,
    selectionCount,
    hasSelection,
    isEmpty,
    hasFilter,
    activeGroupFields,
    grouping,
    groupTree,
    groupNodeCount,
    hasMultiGroup,
    activeGroupNode,
    activeGroupItems,
    activeGroupTrail,
    allSelectionState,
    // actions
    init,
    reload,
    refresh,
    loadSummary,
    resetFilters,
    toggleGroupField,
    moveGroupField,
    clearGroupFields,
    isGroupCollapsed,
    toggleGroupCollapse,
    expandAllGroups,
    collapseAllGroups,
    copyEmails,
    setActiveGroup,
    groupSelectionState,
    toggleSelectGroup,
    setPrivacyMode,
    clearAllReveals,
    isRevealed,
    revealedValue,
    clearReveal,
    toggleReveal,
    copyPlain,
    copySecret,
    copyTemplate,
    statusMeta,
    openCreate,
    openEdit,
    closeEditor,
    save,
    remove,
    // 批量修改
    isSelected,
    toggleSelect,
    selectAll,
    toggleSelectAll,
    isAllSelected,
    clearSelection,
    openBatchEdit,
    closeBatchEdit,
    batchUpdate,
  };
});
