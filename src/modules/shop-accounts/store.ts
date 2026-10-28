// src/modules/shop-accounts/store.ts
// 「店铺账号」状态层：合并列表（一行 = 店铺 + 账号）/ 联动筛选 / 编辑态 / 复制与批量。
//
// 业务模型：一行 = 一家店铺 + 它的账号（`sk_shops` 物理合并，见
// docs/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md）。只有邮箱 = 还没建店铺；只有店名 = 账号待补。
// 手机号 / 支付宝 / 企业名从企业表带出（只读）；紫鸟 / ERP 是工具账号（共享登录）。
//
// 列表一次全量加载，筛选与分面计数在内存完成（数据量级 = 店群规模，不做分页）。
//
// 安全约定：列表接口永不返回明文密码；仅在「临时查看」或「复制密码」时经
// shopAccountReveal / toolAccountReveal 单字段按需解密，明文不落入持久化状态。

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
  companyList,
  toolAccountList,
  toolAccountReveal,
} from '@/core/services/ipc';
import { writeClipboard } from '@/core/services/clipboard';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';
import type {
  ShopAccountBatchFieldPatch,
  ShopAccountDetail,
  ShopAccountItem,
  ShopAccountSecretKey,
  ShopAccountStatus,
  ShopAccountSummary,
  ShopAccountUpsertInput,
  ToolAccountItem,
  ToolAccountKind,
} from '@/types';

/** 密码明文临时显现时长（毫秒），到时自动掩码 */
const SECRET_REVEAL_MS = 8000;

/** 搜索输入防抖时长（毫秒） */
const SEARCH_DEBOUNCE_MS = 250;

/** 可一键复制的明文字段（列表点击即复制） */
export type PlainField =
  | 'name'
  | 'email'
  | 'companyName'
  | 'phone'
  | 'alipay'
  | 'ziniaoAccount'
  | 'erpAccount'
  | 'platformShopId'
  | 'openedAt'
  | 'tags'
  | 'note';

/**
 * 店铺行上直接维护的敏感字段元信息（列表徽标 / 编辑表单共用）。
 * 仅 3 项：紫鸟 / ERP 密码在工具账号表，IMAP 授权码（mailAuthPwd）走收件箱接入流程。
 */
export interface SecretFieldMeta {
  key: ShopAccountSecretKey;
  label: string;
}

export const SECRET_FIELDS: SecretFieldMeta[] = [
  { key: 'shopPwd', label: '店铺密码' },
  { key: 'emailPwd', label: '邮箱密码' },
  { key: 'alipayPwd', label: '国际支付宝密码' },
];

export type StatusTone = 'success' | 'muted' | 'warning' | 'danger';

/** 状态元信息（值 / 中文名 / 语义色）——启用 / 停用 / 封店 / 退店 */
export interface StatusMeta {
  value: ShopAccountStatus;
  label: string;
  tone: StatusTone;
}

export const STATUS_META: StatusMeta[] = [
  { value: 'active', label: '启用', tone: 'success' },
  { value: 'archived', label: '停用', tone: 'muted' },
  { value: 'banned', label: '封店', tone: 'danger' },
  { value: 'exited', label: '退店', tone: 'warning' },
];

/**
 * 一键复制模板条目：明文字段 / 店铺行敏感字段 / 工具账号（登录名 + 密码，密码按需解密）/ 状态。
 * 用判别键（plain / secret / tool / status）区分，便于 copyTemplate 逐类解析。
 */
export type CopyTemplateField =
  | { label: string; plain: PlainField }
  | { label: string; secret: ShopAccountSecretKey }
  | { label: string; tool: ToolAccountKind }
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
 * 默认复制模板（按运营高频场景预定：ERP 登录 / 紫鸟登录 / 店铺与账号）。
 * 工具登录的两行（账号 + 密码）由 `{ tool }` 一条目解析，密码按工具账号 id 缓存复用。
 */
export const COPY_TEMPLATES: CopyTemplate[] = [
  {
    id: 'erp',
    label: 'ERP 登录',
    fields: [{ label: 'ERP', tool: 'erp' }],
  },
  {
    id: 'ziniao',
    label: '紫鸟登录',
    fields: [{ label: '紫鸟', tool: 'ziniao' }],
  },
  {
    id: 'full',
    label: '店铺与账号',
    // 全字段必然存在空项（标签/备注等），缺失即跳过而非中断
    skipMissing: true,
    fields: [
      { label: '店铺名称', plain: 'name' },
      { label: '店铺邮箱', plain: 'email' },
      { label: '店铺密码', secret: 'shopPwd' },
      { label: '邮箱密码', secret: 'emailPwd' },
      { label: '手机号', plain: 'phone' },
      { label: '企业', plain: 'companyName' },
      { label: '支付宝账号', plain: 'alipay' },
      { label: '国际支付宝密码', secret: 'alipayPwd' },
      { label: '紫鸟', tool: 'ziniao' },
      { label: 'ERP', tool: 'erp' },
      { label: '开店时间', plain: 'openedAt' },
      { label: '状态', status: true },
      { label: '标签', plain: 'tags' },
      { label: '备注', plain: 'note' },
    ],
  },
];

/** 按状态值取元信息（未知值兜底「启用」） */
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
 * 关联企业下拉选项（来自「企业管理」页签的企业列表，仅取下拉所需字段）。
 */
export interface CompanyOption {
  id: number;
  name: string;
  /** 手机号（带出只读展示；允许为空） */
  phone: string;
  /** 支付宝账号（带出只读展示；允许为空） */
  alipay: string;
}

// ── 联动筛选模型 ────────────────────────────────────────────────────────────
//
// 企业 / 手机号 / 支付宝三个下拉共享同一个 `companyFilter`（三选一即锁定同一企业，
// 不允许「企业 A + 手机号属于企业 B」的互斥组合）；紫鸟 / ERP 各自独立。
// 选项计数 = 标准分面：其他筛选都生效、本维度不生效；当前选中项计数为 0 也保留在选项里。

/** 筛选状态：undefined = 不筛选；0 = 未关联 / 未使用；> 0 = 指定项 */
export type EntityFilter = number | undefined;

export interface CompanyFacetOption {
  /** 0 = （未关联） */
  id: number;
  name: string;
  phone: string;
  alipay: string;
  count: number;
}

export interface PhoneFacetOption {
  /** 展示值（手机号或支付宝账号） */
  phone: string;
  /** 归属企业（选中即锁定该企业，与企业下拉共享同一筛选状态） */
  companyId: number;
  companyName: string;
  /** 同一号码被多家企业使用：选项文案需带企业名消歧 */
  shared: boolean;
  count: number;
}

export interface ToolFacetOption {
  /** 0 = （未使用） */
  id: number;
  account: string;
  count: number;
}

/** 与主进程 `normalizeSearch` 同口径（改一处要同步另一处） */
function normalizeSearch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-()（）+]/g, '');
}

/** 列表行搜索匹配（字段集合与主进程 `listShopAccounts` 一致） */
function matchesSearch(item: ShopAccountItem, search: string): boolean {
  const haystack = normalizeSearch(
    [
      item.name,
      item.email,
      item.companyName,
      item.phone,
      item.alipay,
      item.ziniaoAccount,
      item.erpAccount,
      item.platformShopId,
      item.tags,
      item.note,
    ].join(' '),
  );
  return haystack.includes(search);
}

// ── 分组归类模型（以自选字段为维度查看账号组）────────────────────────────────

/** 列表视图模式：表格 / 卡片 / 分组归类 */
export type ShopAccountsViewMode = 'table' | 'card' | 'group';

/** 可作分组维度的字段（企业按名称分组；手机号 / 支付宝是企业带出值） */
export type GroupField =
  | 'status'
  | 'companyName'
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
  /** 多值维度：一行可同时归入多个组（标签） */
  multi?: boolean;
}

/** 可选分组维度（数组顺序 = 候选面板展示顺序，实际层级顺序取决于用户勾选顺序） */
export const GROUP_FIELDS: GroupFieldMeta[] = [
  { field: 'status', label: '状态' },
  { field: 'companyName', label: '企业' },
  { field: 'phone', label: '手机号' },
  { field: 'emailDomain', label: '邮箱域名' },
  { field: 'alipay', label: '支付宝' },
  { field: 'ziniaoAccount', label: '紫鸟' },
  { field: 'erpAccount', label: 'ERP' },
  { field: 'tags', label: '标签', multi: true },
];

/** 维度值缺失时的兜底组名 */
export const UNGROUPED_LABEL = '未填写';

/** 取分组维度中文名（未知维度兜底回显原键） */
export function groupFieldLabel(field: GroupField): string {
  return GROUP_FIELDS.find((m) => m.field === field)?.label || field;
}

/** 该维度是否多值（一行可落入多个组） */
export function isMultiGroupField(field: GroupField): boolean {
  return GROUP_FIELDS.some((m) => m.field === field && m.multi === true);
}

/** 取邮箱域名（最后一个 @ 之后部分）；无 @ 返回空串 */
function emailDomainOf(email: string): string {
  const at = (email || '').lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim() : '';
}

/** 取一行在某维度下的全部取值（空数组 = 归入「未填写」组；已去重） */
function groupValuesOf(item: ShopAccountItem, field: GroupField): string[] {
  if (field === 'status') return [statusMeta(item.status).label];
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

/** 主视图顶部页签：店铺 / 店名归一 / 企业 / 工具账号 / …（其余组不变） */
/**
 * 资料项的**唯一清单**（顺序 = 类型定义来源，不参与界面排序 —— 界面排序在 `MasterDataView.GROUPS`）。
 *
 * ⚠️ 为什么是数组而不是纯联合类型（2026-10-19）：`loadPrefs` 要判断"存下来的那个值还算不算数"，
 *    原来那里是**手写的 if 长链**，于是每加一项都得记得同步改它 —— 而 `shipping`（2026-10-15 加的）
 *    就一直漏着：用户最后停在「物流运费」，下次进模块被弹回「店铺账号」，不报错、也没人发现。
 *    现在类型从这里派生，白名单也读它 ⇒ 加一项只改这一处（同"必填清单做成门禁读得出的单一来源"）。
 */
export const SHOP_ACCOUNTS_MAIN_TABS = [
  'accounts',
  // 2026-10-17：原 'mail' 一项随「邮件」独立成一级模块**搬走**（不在本模块了）。
  // 存量偏好里的 'mail' 会在这个白名单里落空 ⇒ 回落到默认项『店铺账号』。
  // 这是**有意的**：让用户落到一个真实存在的地方，而不是一个空面板。
  'goods',
  'registry',
  'companies',
  'tools',
  'suppliers',
  // 2026-10-15：「无忧物流运费」UI 岛回收为内建资料项。
  'shipping',
  // 2026-10-19：第八类，跨域汇总"资料还欠什么"（见 `MasterDataView` 的 KINDS）。
  'health',
] as const;

/**
 * 左侧资料导航的当前项（「基础数据」模块左导航的当前种类）。
 *
 * ⚠️ 这个联合类型是**跨模块 action 的字符串协议**（`switchModule('shop-accounts', <kind>)`）：
 *    增删一项要同批看 `MasterDataView.KINDS/GROUPS` 与 `tests/shopAccountsIntake.spec.ts`。
 */
export type ShopAccountsMainTab = (typeof SHOP_ACCOUNTS_MAIN_TABS)[number];

/** 新建默认值：上一次保存成功时选的企业 / 工具账号（下拉里可见可改，不自动复制密码） */
export interface LastUsedRefs {
  companyId?: number;
  ziniaoAccountId?: number;
  erpAccountId?: number;
}

/** 分组视图偏好（持久化到 modules.shop-accounts，与业务数据隔离） */
export interface ShopAccountsPrefs {
  viewMode?: ShopAccountsViewMode;
  groupFields?: GroupField[];
  mainTab?: ShopAccountsMainTab;
  lastUsed?: LastUsedRefs;
}

export const useShopAccountsStore = defineStore('shop-accounts', () => {
  /** 全量列表（一次加载；筛选与分面计数在内存完成） */
  const items = ref<ShopAccountItem[]>([]);
  const loading = ref(false);
  const initialized = ref(false);
  const saving = ref(false);
  /** 系统安全存储是否可用（false = 密码降级存储，需警示） */
  const secureStorage = ref(true);

  // 筛选与视图
  const search = ref('');
  const statusFilter = ref<ShopAccountStatus | ''>('');
  /** 企业维度筛选：企业 / 手机号 / 支付宝三下拉共享（undefined = 不筛选；0 = 未关联） */
  const companyFilter = ref<EntityFilter>(undefined);
  const ziniaoFilter = ref<EntityFilter>(undefined);
  const erpFilter = ref<EntityFilter>(undefined);
  const viewMode = ref<ShopAccountsViewMode>('table');
  /** 左侧资料导航的当前项（「基础数据」资料项；邮件为独立 store，见 mailStore.ts） */
  const mainTab = ref<ShopAccountsMainTab>('accounts');
  /** 隐私模式：全局隐藏所有密码，防投屏/录屏泄露 */
  const privacyMode = ref(false);

  // 分组归类（以自选字段为维度查看账号组）：数组顺序 = 分组层级顺序
  const groupFields = ref<GroupField[]>([]);
  /** 已折叠的分组键（含父级路径，层级间不冲突） */
  const collapsedGroupKeys = ref<string[]>([]);
  /** 分组视图中当前聚焦的分组键（'' = 全部分组；维度调整后失效会自动回落为全部分组） */
  const activeGroupKey = ref('');

  const summary = reactive<ShopAccountSummary>({
    total: 0,
    byStatus: {},
    complete: 0,
    shopOnly: 0,
    accountOnly: 0,
  });

  // 编辑抽屉
  const editorOpen = ref(false);
  const editorDetail = ref<ShopAccountDetail | null>(null);
  const editorLoading = ref(false);

  // 关联企业下拉候选（企业管理列表；打开编辑器时刷新，保证新建企业立即可选）
  const companies = ref<CompanyOption[]>([]);
  /** 工具账号全集（紫鸟 / ERP 下拉候选 + 工具账号页） */
  const toolAccounts = ref<ToolAccountItem[]>([]);

  // 批量修改：选中集合 + 抽屉开关 + 提交中标记
  const selectedIds = ref<Set<number>>(new Set());
  const batchEditOpen = ref(false);
  const batchSaving = ref(false);

  // 新建默认值（上一次保存成功时的选择；保存成功后写入偏好）
  const lastUsed = ref<LastUsedRefs>({});

  // 临时显现的明文（key = `${id}:${field}`），到时由定时器自动清除
  const revealed = ref<Record<string, string>>({});
  const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const statusCounts = computed(() =>
    STATUS_META.map((meta) => ({ ...meta, count: summary.byStatus[meta.value] || 0 })),
  );
  const isEmpty = computed(() => !loading.value && items.value.length === 0);
  const hasFilter = computed(
    () =>
      !!search.value.trim() ||
      !!statusFilter.value ||
      companyFilter.value !== undefined ||
      ziniaoFilter.value !== undefined ||
      erpFilter.value !== undefined,
  );

  // ── 内存筛选与分面计数 ────────────────────────────────────────────────────

  const normSearch = computed(() => normalizeSearch(search.value));

  /** 搜索 + 状态过滤后的行（分面计数的公共底座） */
  const baseRows = computed(() => {
    const status = statusFilter.value;
    const s = normSearch.value;
    return items.value.filter((item) => {
      if (status && item.status !== status) return false;
      return !s || matchesSearch(item, s);
    });
  });

  /** 企业维度分面底座：底座 + 工具筛选（不含企业维度自身） */
  const companyFacetRows = computed(() =>
    baseRows.value.filter(
      (item) =>
        (ziniaoFilter.value === undefined || item.ziniaoAccountId === ziniaoFilter.value) &&
        (erpFilter.value === undefined || item.erpAccountId === erpFilter.value),
    ),
  );

  /** 紫鸟 / ERP 分面底座：底座 + 企业维度筛选（不含工具维度自身） */
  const toolFacetRows = computed(() =>
    baseRows.value.filter(
      (item) => companyFilter.value === undefined || item.companyId === companyFilter.value,
    ),
  );

  /** 企业下拉：distinct companyId（0 = 未关联），计数 = 企业维度不生效时的命中数 */
  const companyOptions = computed<CompanyFacetOption[]>(() => {
    const map = new Map<number, CompanyFacetOption>();
    for (const item of companyFacetRows.value) {
      const id = item.companyId;
      const opt = map.get(id);
      if (opt) {
        opt.count += 1;
      } else {
        map.set(id, {
          id,
          name: id === 0 ? '（未关联）' : item.companyName || `企业 #${id}`,
          phone: item.phone,
          alipay: item.alipay,
          count: 1,
        });
      }
    }
    const list = [...map.values()].sort((a, b) => b.count - a.count || a.id - b.id);
    // 当前选中项计数为 0 也保留，防止下拉「跳值」（标准分面承诺）
    const cid = companyFilter.value;
    if (cid !== undefined && !list.some((o) => o.id === cid)) {
      const row = items.value.find((it) => it.companyId === cid);
      list.unshift({
        id: cid,
        name: cid === 0 ? '（未关联）' : row?.companyName || `企业 #${cid}`,
        phone: row?.phone || '',
        alipay: row?.alipay || '',
        count: 0,
      });
    }
    return list;
  });

  /**
   * 手机号下拉：distinct（手机号 × 归属企业）（为空的不进选项），选中即反查锁定企业。
   * 选项计数 = 企业维度不生效时的命中数；当前选中项计数为 0 也保留，防止下拉「跳值」。
   */
  const phoneOptions = computed<PhoneFacetOption[]>(() => {
    const map = new Map<string, PhoneFacetOption>();
    for (const item of companyFacetRows.value) {
      const phone = (item.phone || '').trim();
      if (!phone) continue;
      // 「#」作分隔符：手机号 / 支付宝账号里都不会出现它，企业 id 恒为数字 ⇒ 组合键不穿模
      const key = `${phone}#${item.companyId}`;
      const opt = map.get(key);
      if (opt) {
        opt.count += 1;
      } else {
        map.set(key, {
          phone,
          companyId: item.companyId,
          companyName: item.companyName,
          shared: false,
          count: 1,
        });
      }
    }
    const list = [...map.values()];
    const byPhone = new Map<string, number>();
    for (const o of list) byPhone.set(o.phone, (byPhone.get(o.phone) || 0) + 1);
    for (const o of list) o.shared = (byPhone.get(o.phone) || 0) > 1;
    list.sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone));
    return keepSelectedPhoneOption(list, (item) => (item.phone || '').trim());
  });

  /**
   * 支付宝下拉：distinct（支付宝 × 归属企业）（为空的不进选项），选中即反查锁定企业。
   * 口径与手机号下拉一致。
   */
  const alipayOptions = computed<PhoneFacetOption[]>(() => {
    const map = new Map<string, PhoneFacetOption>();
    for (const item of companyFacetRows.value) {
      const alipay = (item.alipay || '').trim();
      if (!alipay) continue;
      const key = `${alipay}#${item.companyId}`;
      const opt = map.get(key);
      if (opt) {
        opt.count += 1;
      } else {
        map.set(key, {
          phone: alipay,
          companyId: item.companyId,
          companyName: item.companyName,
          shared: false,
          count: 1,
        });
      }
    }
    const list = [...map.values()];
    const byPhone = new Map<string, number>();
    for (const o of list) byPhone.set(o.phone, (byPhone.get(o.phone) || 0) + 1);
    for (const o of list) o.shared = (byPhone.get(o.phone) || 0) > 1;
    list.sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone));
    return keepSelectedPhoneOption(list, (item) => (item.alipay || '').trim());
  });

  /**
   * 企业维度已锁定某公司、但该公司在当前分面底座里计数为 0（或没有该号码）时，
   * 从全量列表补一个计数 0 的选项，保住当前选中项（标准分面的「不跳值」承诺）。
   */
  function keepSelectedPhoneOption(
    list: PhoneFacetOption[],
    valueOf: (item: ShopAccountItem) => string,
  ): PhoneFacetOption[] {
    const cid = companyFilter.value;
    if (cid === undefined || list.some((o) => o.companyId === cid)) return list;
    const row = items.value.find((it) => it.companyId === cid && valueOf(it));
    if (!row) return list;
    const value = valueOf(row);
    return [
      {
        phone: value,
        companyId: cid,
        companyName: row.companyName,
        shared: list.some((o) => o.phone === value),
        count: 0,
      },
      ...list,
    ];
  }

  /** 工具账号分面选项（kind 过滤 + 计数；0 = 未使用；当前选中项计数为 0 也保留） */
  function toolFacetOptions(kind: ToolAccountKind, filter: EntityFilter): ToolFacetOption[] {
    const rows = toolFacetRows.value;
    const map = new Map<number, ToolFacetOption>();
    for (const item of rows) {
      const id = kind === 'ziniao' ? item.ziniaoAccountId : item.erpAccountId;
      const opt = map.get(id);
      if (opt) opt.count += 1;
      else map.set(id, { id, account: '', count: 1 });
    }
    // 名称从工具账号全集补（未使用项没有名字）
    const byId = new Map(toolAccounts.value.filter((t) => t.kind === kind).map((t) => [t.id, t]));
    const list = [...map.values()]
      .map((opt) => ({
        ...opt,
        account: opt.id === 0 ? '（未使用）' : (byId.get(opt.id)?.account ?? `账号 #${opt.id}`),
      }))
      .sort((a, b) => b.count - a.count || a.id - b.id);
    if (filter !== undefined && !list.some((o) => o.id === filter)) {
      const account =
        filter === 0 ? '（未使用）' : (byId.get(filter)?.account ?? `账号 #${filter}`);
      list.unshift({ id: filter, account, count: 0 });
    }
    return list;
  }

  const ziniaoOptions = computed(() => toolFacetOptions('ziniao', ziniaoFilter.value));
  const erpOptions = computed(() => toolFacetOptions('erp', erpFilter.value));

  /** 当前筛选结果（列表实际渲染的数据） */
  const filteredItems = computed(() =>
    companyFacetRows.value.filter(
      (item) => companyFilter.value === undefined || item.companyId === companyFilter.value,
    ),
  );

  // ── 分组归类 computed ─────────────────────────────────────────────────────

  /** 有效分组维度（顺带过滤历史脏数据里的未知字段） */
  const activeGroupFields = computed(() =>
    groupFields.value.filter((f) => GROUP_FIELDS.some((m) => m.field === f)),
  );
  const grouping = computed(() => activeGroupFields.value.length > 0);
  /** 分组树（作用于当前筛选结果，非全量） */
  const groupTree = computed(() => buildGroupTree(filteredItems.value, activeGroupFields.value, ''));
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
      : filteredItems.value,
  );
  /** 当前分组的面包屑路径（含各层级 field 与组名；「全部」时为空数组） */
  const activeGroupTrail = computed(() =>
    activeGroupNode.value ? groupNodeTrail(groupTree.value, activeGroupNode.value.key) : [],
  );
  /** 全量选中态（左栏「全部店铺」复选框三态） */
  const allSelectionState = computed<SelectionState>(() => {
    if (!filteredItems.value.length || selectedIds.value.size === 0) return 'none';
    return filteredItems.value.every((it) => selectedIds.value.has(it.id)) ? 'all' : 'partial';
  });

  // ── 视图偏好持久化（命名空间 modules.shop-accounts）─────────────────────

  const prefs = useModuleStorage<ShopAccountsPrefs>('shop-accounts');

  function savePrefs(): void {
    prefs.scheduleSave({
      viewMode: viewMode.value,
      groupFields: [...groupFields.value],
      mainTab: mainTab.value,
      lastUsed: { ...lastUsed.value },
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
      // 历史偏好里的 'settings' 已废弃：回落到默认页签（accounts）。
      // 'shops' 是旧页签 id（店铺登记）——2026-10-14 整合后改名 'registry'，做映射而不是丢弃。
      // ⚠️ 强转成 string 再比：`data.mainTab` 的类型是**新**联合（不含 'shops'），
      //    直接 `=== 'shops'` 会被 TS 判成"永假"而砍掉这条迁移（TS2367）。
      const legacyTab =
        (data.mainTab as string | undefined) === 'shops'
          ? 'registry'
          : data.mainTab;
      // 白名单读 `SHOP_ACCOUNTS_MAIN_TABS`（唯一清单）：手写 if 长链漏掉一项的后果是
      // "用户上次停的那一页下次进不来"，而它**不报错**（2026-10-15→10-19 `shipping` 就这么漏了两轮）。
      if (
        typeof legacyTab === 'string' &&
        (SHOP_ACCOUNTS_MAIN_TABS as readonly string[]).includes(legacyTab)
      ) {
        mainTab.value = legacyTab as ShopAccountsMainTab;
      }
      if (data.lastUsed && typeof data.lastUsed === 'object') {
        const lu = data.lastUsed;
        lastUsed.value = {
          companyId: typeof lu.companyId === 'number' && lu.companyId >= 0 ? lu.companyId : undefined,
          ziniaoAccountId:
            typeof lu.ziniaoAccountId === 'number' && lu.ziniaoAccountId >= 0
              ? lu.ziniaoAccountId
              : undefined,
          erpAccountId:
            typeof lu.erpAccountId === 'number' && lu.erpAccountId >= 0
              ? lu.erpAccountId
              : undefined,
        };
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
    summary.complete = result.data.complete || 0;
    summary.shopOnly = result.data.shopOnly || 0;
    summary.accountOnly = result.data.accountOnly || 0;
  }

  async function loadSecurity(): Promise<void> {
    const result = await shopAccountSecurity();
    if (result.success && result.data) secureStorage.value = !!result.data.secureStorage;
  }

  /** 拉取企业管理企业列表（关联企业下拉候选；失败静默降级为空列表，不阻塞编辑器） */
  async function loadCompanies(): Promise<void> {
    try {
      const result = await companyList({});
      companies.value = result.success
        ? (result.data || []).map((c) => ({ id: c.id, name: c.name, phone: c.contactPhone, alipay: c.alipayAccount }))
        : [];
    } catch {
      companies.value = [];
    }
  }

  /** 拉取工具账号全集（编辑器下拉 + 筛选分面 + 工具账号页共用） */
  async function loadToolAccounts(): Promise<void> {
    try {
      const result = await toolAccountList();
      toolAccounts.value = result.success ? result.data || [] : [];
    } catch {
      toolAccounts.value = [];
    }
  }

  /** 按当前筛选条件拉取列表（一次全量；筛选本身在内存完成） */
  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const result = await shopAccountList({});
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
      await Promise.all([loadSummary(), loadSecurity(), loadPrefs(), loadToolAccounts()]);
      await refresh();
    } catch (e: unknown) {
      toast(`初始化失败: ${normalizeError(e)}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  /** 重新进入模块时刷新（保留筛选条件） */
  async function reload(): Promise<void> {
    await Promise.all([refresh(), loadSummary(), loadToolAccounts()]);
  }

  function resetFilters(): void {
    search.value = '';
    statusFilter.value = '';
    companyFilter.value = undefined;
    ziniaoFilter.value = undefined;
    erpFilter.value = undefined;
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

  // 视图模式 / 分组维度 / 顶部页签 / 新建默认值变化即持久化，下次进入模块沿用
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
   * @param toolPwdCache 工具账号 id → 已解密密码（同一次复制内复用，避免同一密码重复解密）
   * @returns ok=false 表示读密码失败（已 toast，调用方应中断）；value 为空串表示该项无值。
   */
  async function resolveTemplateField(
    item: ShopAccountItem,
    field: CopyTemplateField,
    toolPwdCache: Map<number, string>,
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
    if ('tool' in field) {
      const toolId = field.tool === 'ziniao' ? item.ziniaoAccountId : item.erpAccountId;
      if (!toolId) return { ok: true, value: '' };
      const account = toolAccounts.value.find((t) => t.id === toolId);
      if (!account) return { ok: true, value: '' };
      let pwd = toolPwdCache.get(toolId);
      if (pwd === undefined) {
        if (!account.hasPassword) return { ok: true, value: '' };
        const result = await toolAccountReveal(toolId);
        if (!result.success) {
          toast(result.error || '读取密码失败', 'error');
          return { ok: false, value: '' };
        }
        pwd = result.data?.value || '';
        toolPwdCache.set(toolId, pwd);
      }
      return { ok: true, value: `${field.label}账号: ${account.account}\n${field.label}密码: ${pwd}` };
    }
    if ('status' in field) return { ok: true, value: statusMeta(item.status).label };
    return { ok: true, value: String(item[field.plain] || '').trim() };
  }

  /** 按模板一键复制（如 ERP 登录 = 账号 + 密码；店铺与账号 = 有值项逐行拼装） */
  async function copyTemplate(item: ShopAccountItem, templateId: string): Promise<void> {
    const template = COPY_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const skipMissing = template.skipMissing === true;
    const lines: string[] = [];
    const toolPwdCache = new Map<number, string>();
    for (const field of template.fields) {
      const resolved = await resolveTemplateField(item, field, toolPwdCache);
      if (!resolved.ok) return;
      if (!resolved.value) {
        if (skipMissing) continue;
        toast(`${field.label}${'secret' in field ? '未配置' : '未填写'}`, 'info');
        return;
      }
      lines.push(resolved.value);
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
    // 刷新关联企业 / 工具账号下拉候选（企业管理 / 工具账号页可能刚有增删）
    void loadCompanies();
    void loadToolAccounts();
  }

  async function openEdit(id: number): Promise<void> {
    editorOpen.value = true;
    editorLoading.value = true;
    editorDetail.value = null;
    void loadCompanies();
    void loadToolAccounts();
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
      // IPC 走结构化克隆，Vue 响应式代理（Proxy）无法被克隆：此处统一展开为纯值
      const plain: ShopAccountUpsertInput = {
        ...payload,
        secrets: payload.secrets ? { ...payload.secrets } : undefined,
        clearSecrets: payload.clearSecrets ? [...payload.clearSecrets] : undefined,
      };
      const result = await shopAccountUpsert(plain);
      if (!result.success) {
        toast(result.error || '保存失败', 'error');
        return false;
      }
      if (typeof result.data?.secureStorage === 'boolean') {
        secureStorage.value = result.data.secureStorage;
      }
      // 记住本次选择，下次新建默认带出（可见可改；密码永远不复制）
      lastUsed.value = {
        companyId: payload.companyId,
        ziniaoAccountId: payload.ziniaoAccountId,
        erpAccountId: payload.erpAccountId,
      };
      savePrefs();
      toast(payload.id ? '已保存修改' : '已新增店铺账号', 'success');
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
      toast('已删除该店铺账号', 'success');
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
    selectedIds.value = new Set(filteredItems.value.map((it) => it.id));
  }

  /** 当前列表全选 / 取消全选（作用于当前筛选结果） */
  function toggleSelectAll(): void {
    const allSelected =
      filteredItems.value.length > 0 &&
      filteredItems.value.every((it) => selectedIds.value.has(it.id));
    const next = new Set(selectedIds.value);
    if (allSelected) {
      for (const it of filteredItems.value) next.delete(it.id);
    } else {
      for (const it of filteredItems.value) next.add(it.id);
    }
    selectedIds.value = next;
  }

  /** 当前列表是否已全选（表头复选框态） */
  function isAllSelected(): boolean {
    return (
      filteredItems.value.length > 0 &&
      filteredItems.value.every((it) => selectedIds.value.has(it.id))
    );
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  function openBatchEdit(): void {
    if (selectedIds.value.size === 0) {
      toast('请先勾选要批量修改的店铺账号', 'info');
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
      toast('请先勾选要批量修改的店铺账号', 'error');
      return false;
    }
    batchSaving.value = true;
    try {
      const result = await shopAccountBatchUpdate({ ids, patch });
      if (!result.success) throw new Error(result.error || '批量修改失败');
      toast(`已批量修改 ${result.data?.updated ?? 0} 条店铺`, 'success');
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
    companyFilter,
    ziniaoFilter,
    erpFilter,
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
    companies,
    toolAccounts,
    selectedIds,
    batchEditOpen,
    batchSaving,
    lastUsed,
    // computed（筛选 / 分面）
    filteredItems,
    companyOptions,
    phoneOptions,
    alipayOptions,
    ziniaoOptions,
    erpOptions,
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
    loadCompanies,
    loadToolAccounts,
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
