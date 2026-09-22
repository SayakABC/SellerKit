// dist/store.js
// 岛状态层：内建 pinia store 的等价实现（无框架，纯对象 + 变更广播）。
//
// 与内建版的关系：
//   · 持久化命名空间 modules.excel-copy **完全一致** → 老用户配置自动继承；
//   · 计算属性（filteredRecords / allHeaders / preview…）改成函数，语义不变；
//   · 规则求值与 Excel 解析改为调宿主（岛 CSP 禁 eval、不打包 xlsx），其余逻辑逐条对照内建实现。
//
// 变更广播：任何状态变更后调用 bump(reason)，订阅方按 reason 决定重绘哪些区域。
// 不提供"无脑全量重绘"——工作台有搜索框、设置页有正在编辑的 textarea，整体重绘会丢焦点。

import { notify } from './bridge.js';
import * as api from './api.js';
import { previewTemplate, renderTemplate } from './util.js';

/** 与内建 extensions/excel-copy/src/store.ts 保持一致的兜底模板 */
const DEFAULT_TEMPLATE_CONTENT = `http://{{domain}}.beuaya.com/get.php?username={{Username}}&password={{Password}}&type=m3u_plus&output=mpegts

👤 Username: {{Username}}
🔑 Password: {{Password}}
🔗 DNS (URL): http://{{DNS}}
📺 Samsung & LG DNS (IPTV Smarters): http://{{domain}}.yufengsmart.com
📦 Package: {{Package}}
📅 Expiry Date: {{Package}}`;

const DEFAULT_TEMPLATE = {
  id: 'default',
  name: '默认模板',
  filePath: '',
  content: DEFAULT_TEMPLATE_CONTENT,
  isBuiltIn: true,
};

/** 默认规则：从 DNS 列取出首段域名（内建版同名同配置，老用户数据里已有则用旧的） */
const DEFAULT_DOMAIN_RULE = {
  id: 'default_domain',
  name: '域名解析',
  enabled: true,
  targetField: 'domain',
  type: 'jsExpression',
  order: 1,
  config: { code: `fields["DNS"].split('.').slice(0, 1)[0]` },
};

/** 规则类型 → 中文标签（列表徽标用） */
export const RULE_TYPES = {
  dateOffset: '日期偏移',
  template: '模板拼接',
  math: '数值运算',
  jsExpression: '自定义JS',
};

/** 岛状态（可原地修改；改完记得 bump()） */
export const S = {
  records: [],
  headers: [],
  selectedId: null,
  searchQuery: '',
  filterMode: 'all', // all | unused | used
  templateConfigs: [],
  activeTemplateId: 'default',
  lastExcelPath: '',
  lastTemplatePath: '',
  isLoading: false,
  undoStack: [],
  ready: false,
  // 字段规则
  processingRules: [],
  visibleColumns: [],
  derivedHeaders: [],
  lastAppliedRulesHash: '',
};

// ---------------------------------------------------------------- 变更广播

const listeners = new Set();

/** 订阅状态变更；返回退订函数 */
export function onStoreChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 广播变更（reason 供订阅方判断重绘范围） */
export function bump(reason = '') {
  listeners.forEach((cb) => {
    try {
      cb(reason);
    } catch (e) {
      console.error('[excel-copy] store listener failed:', e);
    }
  });
}

// ---------------------------------------------------------------- 持久化

/** 收集需要落盘的字段（与内建 AppState 完全同名，保证双向兼容） */
function collect() {
  return {
    lastExcelPath: S.lastExcelPath,
    lastTemplatePath: S.lastTemplatePath,
    records: S.records,
    templateConfigs: S.templateConfigs,
    activeTemplateId: S.activeTemplateId,
    processingRules: S.processingRules,
    visibleColumns: [...S.visibleColumns],
  };
}

let saveTimer = null;
let saving = null;

/** 防抖落盘（500ms，与内建 scheduleSave 一致） */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush();
  }, 500);
}

/** 立即落盘（关键动作后调用，避免用户操作完立刻关窗丢数据） */
export async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // 串行化：并发 flush 只保留最后一次（后写的必然包含前一次的内容，因为 collect() 读的是当前状态）
  saving = (saving || Promise.resolve()).then(
    () => api.saveConfig(collect()),
    () => api.saveConfig(collect()),
  );
  try {
    await saving;
  } catch (e) {
    console.error('[excel-copy] save failed:', e);
  }
}

/** 读取持久化状态（含全新安装的默认值兜底） */
export async function loadState() {
  try {
    const d = await api.loadConfig();
    S.lastExcelPath = d.lastExcelPath || '';
    S.lastTemplatePath = d.lastTemplatePath || '';
    S.records = Array.isArray(d.records) ? d.records : [];
    S.activeTemplateId = d.activeTemplateId || 'default';
    S.processingRules = Array.isArray(d.processingRules) ? d.processingRules : [];
    S.visibleColumns = Array.isArray(d.visibleColumns) ? d.visibleColumns : [];
    if (Array.isArray(d.templateConfigs) && d.templateConfigs.length) {
      S.templateConfigs = d.templateConfigs;
    }
  } catch (e) {
    console.error('[excel-copy] load state failed:', e);
  }
  // 全新安装 / 数据缺失时补默认（等价于内建 store 的默认值）
  if (S.templateConfigs.length === 0) S.templateConfigs = [{ ...DEFAULT_TEMPLATE }];
  if (S.processingRules.length === 0) S.processingRules = [{ ...DEFAULT_DOMAIN_RULE }];
}

// ---------------------------------------------------------------- 派生视图

export function activeTpl() {
  return S.templateConfigs.find((t) => t.id === S.activeTemplateId) || null;
}

export function getTemplate(id) {
  return S.templateConfigs.find((t) => t.id === id) || null;
}

export function selectRecord(id) {
  S.selectedId = id;
  bump('selection');
}

export function setFilter(mode) {
  S.filterMode = mode;
  bump('filter');
}

export function setSearch(q) {
  S.searchQuery = q;
  bump('search');
}

/** 当前筛选 + 搜索下的记录（按 order 升序） */
export function filtered() {
  let list = S.records.slice();
  if (S.filterMode === 'unused') list = list.filter((r) => !r.used);
  else if (S.filterMode === 'used') list = list.filter((r) => r.used);
  const q = S.searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((r) =>
      Object.values(r.fields || {}).some((v) => String(v).toLowerCase().includes(q)),
    );
  }
  return list.sort((a, b) => a.order - b.order);
}

export function selected() {
  return S.records.find((r) => r.id === S.selectedId) || null;
}

export function totalCount() {
  return S.records.length;
}
export function usedCount() {
  return S.records.filter((r) => r.used).length;
}
export function unusedCount() {
  return S.records.filter((r) => !r.used).length;
}

/** 所有可用列名 = 原始列 + 衍生列 */
export function allHeaders() {
  return [...new Set([...S.headers, ...S.derivedHeaders])];
}

/** 当前选中记录的模板预览 { html, hasMissing } */
export function preview() {
  const rec = selected();
  const tpl = activeTpl();
  if (!rec || !tpl) return { html: '', hasMissing: false };
  return previewTemplate(tpl.content, rec.fields);
}

/**
 * 规则哈希（与宿主 fieldProcessor#computeRulesHash 同构）。
 * 用途仅是「本次导入前 vs 导入后，规则有没有变」的**岛内自比**，
 * 因此不需要与宿主返回值逐字节相同；也不能省成"读过宿主返回的 hash"——
 * 那样在没调用过 applyRules 时拿不到基准值。
 */
export function rulesHash() {
  return JSON.stringify(
    S.processingRules.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      targetField: r.targetField,
      type: r.type,
      config: r.config,
      order: r.order,
    })),
  );
}

// ---------------------------------------------------------------- 字段规则

/**
 * 执行启用的规则（求值在宿主），更新衍生列。
 * @param {boolean} silent 静默模式（导入流程内部调用，不单独提示）
 */
export async function applyRules(silent = false) {
  if (S.processingRules.length === 0) return;
  const enabled = S.processingRules.filter((r) => r.enabled);
  if (S.records.length === 0 || enabled.length === 0) {
    // 没有可处理的数据：仍然刷新衍生列名，避免列表显示上一次的幽灵列
    refreshDerivedHeaders();
    if (!silent) notify(enabled.length === 0 ? '没有启用的规则' : '没有数据可处理', 'info');
    return;
  }

  const res = await api.applyRules(S.records, S.headers, S.processingRules);
  S.records = res.records || S.records;
  S.derivedHeaders = res.newHeaders || [];
  S.lastAppliedRulesHash = rulesHash();

  // 新衍生列自动加入可见列（visibleColumns 为空时不加，保持"用户没选过就不选"的语义）
  if (S.visibleColumns.length > 0) {
    for (const h of S.derivedHeaders) {
      if (!S.visibleColumns.includes(h)) S.visibleColumns.push(h);
    }
  }

  const errs = res.errors || [];
  if (errs.length) {
    const first = errs[0];
    const rule = S.processingRules.find((r) => r.id === first.ruleId);
    notify(`${errs.length} 条规则执行出错：${rule ? rule.name : first.ruleId} ${first.message}`, 'error');
  } else if (!silent) {
    notify(`已执行 ${enabled.length} 条规则`, 'success');
  }
  scheduleSave();
  bump('rules');
}

/** 从规则定义刷新衍生列名（删除规则后调用，干净地摘掉不再存在的列） */
export function refreshDerivedHeaders() {
  S.derivedHeaders = [...new Set(S.processingRules.filter((r) => r.enabled).map((r) => r.targetField))];
}

export function addRule(rule) {
  S.processingRules.push(rule);
  scheduleSave();
  bump('rules');
}

export function removeRule(id) {
  S.processingRules = S.processingRules.filter((r) => r.id !== id);
  refreshDerivedHeaders();
  // 同步把该规则的衍生列移出可见列（否则显示列里残留一个永远为空的列名）
  S.visibleColumns = S.visibleColumns.filter((c) => !S.derivedHeaders.includes(c) || S.headers.includes(c));
  scheduleSave();
  bump('rules');
}

export function updateRule(id, patch) {
  const i = S.processingRules.findIndex((r) => r.id === id);
  if (i === -1) return;
  S.processingRules[i] = { ...S.processingRules[i], ...patch };
  refreshDerivedHeaders();
  scheduleSave();
  bump('rules');
}

export function toggleRuleEnabled(id) {
  const r = S.processingRules.find((x) => x.id === id);
  if (!r) return;
  r.enabled = !r.enabled;
  refreshDerivedHeaders();
  scheduleSave();
  bump('rules');
}

// ---------------------------------------------------------------- 显示列

export function toggleColumn(field) {
  const i = S.visibleColumns.indexOf(field);
  if (i !== -1) S.visibleColumns.splice(i, 1);
  else S.visibleColumns.push(field);
  scheduleSave();
  bump('columns');
}

export function isColumnVisible(field) {
  return S.visibleColumns.includes(field);
}

/** 未选过显示列时默认取前 2 个原始列（内建语义） */
export function ensureVisibleColumns() {
  if (S.visibleColumns.length === 0 && S.headers.length > 0) {
    S.visibleColumns = S.headers.slice(0, 2);
    scheduleSave();
  }
}

export function selectAllColumns() {
  allHeaders().forEach((h) => {
    if (!S.visibleColumns.includes(h)) S.visibleColumns.push(h);
  });
  scheduleSave();
  bump('columns');
}

export function selectDefaultColumns() {
  S.visibleColumns = S.headers.slice(0, 2);
  scheduleSave();
  bump('columns');
}

// ---------------------------------------------------------------- 记录操作

/**
 * 复制并标记已使用。
 *
 * 关键实现细节（与内建一致，勿简化）：
 *   · 复制失败时**不得**标记 used —— 否则用户以为拿到了内容，实际上剪贴板是空的；
 *   · 已使用的记录再复制只提示、不改 order，避免把用户的排序搅乱；
 *   · 标记时把 order 推到"所有已使用记录的最大 order + 1"，让已用项自然沉到列表尾部。
 */
export async function copyAndMark(rec) {
  const tpl = activeTpl();
  if (!tpl) {
    notify('请先配置模板', 'error');
    return;
  }
  const text = renderTemplate(tpl.content, rec.fields);
  try {
    const { copy } = await import('./bridge.js');
    await copy(text);
  } catch {
    notify('复制到剪贴板失败，请手动复制', 'error');
    return;
  }

  if (!rec.used) {
    S.undoStack.push({ id: rec.id, prevUsed: rec.used, prevOrder: rec.order });
    const maxUsedOrder = S.records
      .filter((r) => r.used)
      .reduce((max, r) => Math.max(max, r.order), 10000);
    rec.used = true;
    rec.order = maxUsedOrder + 1;
    scheduleSave();
    bump('records');
    notify('已复制并标记为已使用', 'success');
  } else {
    bump('records');
    notify('已复制到剪贴板', 'info');
  }
}

/** 撤销上一次「复制并标记」 */
export function undo() {
  const last = S.undoStack.pop();
  if (!last) {
    notify('没有可撤销的操作', 'info');
    return;
  }
  const rec = S.records.find((r) => r.id === last.id);
  if (!rec) {
    bump('records');
    return;
  }
  rec.used = last.prevUsed;
  rec.order = last.prevOrder;
  scheduleSave();
  bump('records');
  notify('已撤销', 'info');
}

/** 重置所有使用状态（order 回到 id，即原始行序） */
export function resetAll() {
  S.records.forEach((r) => {
    r.used = false;
    r.order = r.id;
  });
  S.undoStack = [];
  scheduleSave();
  bump('records');
  notify('已重置所有状态', 'info');
}

// ---------------------------------------------------------------- Excel 导入

/**
 * 导入解析结果。
 *
 * 幂等性（与内建一致）：**同一路径 + 同行数 + 规则未变**时，逐 id 继承旧的 used/order。
 * 这解决了「清空重导同一份表，之前的勾选全丢」的痛点；
 * 一旦规则变了就不继承——衍生列会变，行与行的对应关系不再可靠。
 *
 * @param {{headers:string[], records:object[]}} parsed 宿主解析结果
 * @param {string} filePath 来源路径（拖拽时退化为文件名）
 */
export async function importExcel(parsed, filePath) {
  S.isLoading = true;
  bump('loading');
  try {
    S.headers = parsed.headers || [];
    const rulesChanged =
      !!S.lastAppliedRulesHash && S.lastAppliedRulesHash !== rulesHash();

    if (!rulesChanged && filePath === S.lastExcelPath && S.records.length === parsed.records.length) {
      parsed.records.forEach((newRec) => {
        const old = S.records.find((r) => r.id === newRec.id);
        if (old) {
          newRec.used = old.used;
          newRec.order = old.order;
        }
      });
    }

    S.records = parsed.records || [];
    S.lastExcelPath = filePath;
    S.selectedId = null;
    S.undoStack = [];
    S.derivedHeaders = [];

    await applyRules(true);
    ensureVisibleColumns();
    await flush();
    notify(`Excel 导入成功（${S.records.length} 条）`, 'success');
  } catch (e) {
    notify(`解析失败：${(e && e.message) || e}`, 'error');
  } finally {
    S.isLoading = false;
    bump('records');
  }
}

/** 按路径导入（启动时重载上次文件 / 拖拽得到路径时） */
export async function importByPath(filePath) {
  return importExcel(await api.parseExcel(filePath), filePath);
}

/** 走宿主对话框选文件导入 */
export async function importByDialog() {
  const { openFile } = await import('./bridge.js');
  const sel = await openFile('excel');
  if (!sel) return;
  await importExcel(await api.parseExcel(sel.filePath), sel.filePath);
}

/**
 * 拖拽导入：iframe 里 File 拿不到磁盘路径，只能把 ArrayBuffer 交给宿主解析。
 * filePath 用文件名占位（不参与存在性判断，仅用于幂等性比较）。
 */
export async function importByBuffer(arrayBuffer, name) {
  await importExcel(await api.parseExcelBuffer(arrayBuffer), name);
}

/** 手动重新执行全部规则（设置页「立即应用」） */
export async function reprocessRules() {
  if (S.records.length === 0) {
    notify('没有数据可处理', 'info');
    return;
  }
  const enabled = S.processingRules.filter((r) => r.enabled).length;
  if (enabled === 0) {
    notify('没有启用的规则', 'info');
    return;
  }
  await applyRules(false);
  bump('records');
}

// ---------------------------------------------------------------- 模板管理

export function addTemplate(tpl) {
  S.templateConfigs.push(tpl);
  scheduleSave();
  bump('templates');
}

export function removeTemplate(id) {
  if (id === S.activeTemplateId) {
    notify('不能删除当前激活的模板', 'error');
    return false;
  }
  S.templateConfigs = S.templateConfigs.filter((t) => t.id !== id);
  scheduleSave();
  bump('templates');
  return true;
}

export function updateTemplate(id, patch) {
  const i = S.templateConfigs.findIndex((t) => t.id === id);
  if (i === -1) return;
  S.templateConfigs[i] = { ...S.templateConfigs[i], ...patch };
  scheduleSave();
  bump('templates');
}

export function setActiveTemplate(id) {
  S.activeTemplateId = id;
  scheduleSave();
  bump('templates');
}

/** 导入模板文件：选文件 → 读内容 → 追加为新模板并设为当前 */
export async function importTemplateFile() {
  const { openFile } = await import('./bridge.js');
  const sel = await openFile('template');
  if (!sel) return;
  const f = await api.readTextFile(sel.filePath);
  const name = sel.filePath.split('/').pop()?.replace(/\.txt$/i, '') || '导入模板';
  const id = `tpl_${Date.now()}`;
  addTemplate({ id, name, filePath: sel.filePath, content: (f && f.content) || '' });
  setActiveTemplate(id);
  notify('模板导入成功', 'success');
}

/**
 * 保存模板：若模板有来源文件则同步写回文件，再更新内存副本。
 *
 * ⚠️ 必须连 **name** 一起写回。早期版本这里只落 content，结果是：
 * 用户改了模板名点保存，界面看着已经改了（草稿态），但落库的还是旧名 ——
 * 重启后名字回退，而内容却是新的，属于"半保存"这种最难排查的错。
 * 同时把 isBuiltIn 置 false（用户改过的内置模板不再被启动时的文件同步覆盖，与内建版一致）。
 */
export async function saveTemplateToFile(tpl) {
  if (tpl.filePath) {
    try {
      await api.saveTemplateFile(tpl.filePath, tpl.content);
      notify('模板已保存到文件', 'success');
    } catch (e) {
      notify(`保存模板失败：${(e && e.message) || e}`, 'error');
      return false;
    }
  }
  updateTemplate(tpl.id, { name: tpl.name, content: tpl.content, isBuiltIn: false });
  return true;
}

/** 从宿主内置模板文件同步内容（内置模板每次启动都拉最新） */
export async function loadDefaultTemplate() {
  try {
    const r = await api.readDefaultTemplate();
    if (!r) return;
    const tpl = S.templateConfigs.find((t) => t.id === 'default');
    if (tpl) {
      tpl.content = r.content || tpl.content;
      tpl.filePath = r.filePath;
      tpl.isBuiltIn = true;
    } else {
      S.templateConfigs.unshift({
        id: 'default',
        name: '默认模板',
        filePath: r.filePath,
        content: r.content || '',
        isBuiltIn: true,
      });
    }
    scheduleSave();
  } catch (e) {
    // 拿不到内置模板不算致命（可能打包形态不同），静默即可
    console.warn('[excel-copy] load default template failed:', e);
  }
}

// ---------------------------------------------------------------- 启动

/**
 * 初始化：读配置 → 同步内置模板 → 重载上次 Excel → 补默认显示列。
 * 任何一步失败都不阻断启动（岛要能打开，只是缺数据）。
 */
export async function init() {
  S.isLoading = true;
  bump('loading');
  try {
    await loadState();

    // 内置模板每次启动从文件同步最新内容（用户若改过则 isBuiltIn=false，不再覆盖）
    const tpl = S.templateConfigs.find((t) => t.id === 'default');
    if (tpl && tpl.isBuiltIn !== false) await loadDefaultTemplate();

    if (S.lastExcelPath) {
      try {
        const r = await api.checkFileExists(S.lastExcelPath);
        if (r) await importByPath(S.lastExcelPath);
      } catch (e) {
        console.warn('[excel-copy] reload last excel failed:', e);
      }
    }
    ensureVisibleColumns();
    S.ready = true;
  } catch (e) {
    console.error('[excel-copy] init failed:', e);
  } finally {
    S.isLoading = false;
    bump('init');
  }
}
