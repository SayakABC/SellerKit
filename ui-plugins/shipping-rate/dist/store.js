// dist/store.js
// 岛状态层：无框架的等价 pinia store（纯对象 + 变更广播）。
//
// 状态分两类，落盘策略不同：
//   · **持久**：来源信息 / 上次打开的文件与其体检结果 / 查询偏好 → 写 modules.shipping-rate；
//   · **不落盘**：运价表本身、查询结果、加载态。
//
// ⚠️ **运价表归宿主**（M6 运价表回迁，2026-09-30）：真源是宿主快照表 `sr_rate_snapshots`
//   （ADR-002 C3 要求主数据挂中立层 —— 存在可卸载的岛私有 storage 里，任何跨域算运费都够不到，
//   且"只留当前一份"会让历史订单的运费随报价单更新而变、不可复算）。
//   本岛 `S.table` 只是**从宿主取来渲染用的副本**，不再持久化、也不再传回宿主做计价。
//   升级路径：旧的岛内表在首次打开时**一次性迁移**到宿主（`rateAdopt`），随后本地副本抹掉。
//
// 变更广播：改完状态调 bump(reason)，订阅方按 reason 决定重绘范围。
// 刻意不做"无脑全量重绘"——查询页有克重输入框，整体重绘会丢焦点（见 views/quote.js）。

import { notify } from './bridge.js';
import * as api from './api.js';

/** 默认克重（报价单小包最常见的起步档） */
export const DEFAULT_WEIGHT = 100;

/** 旧的岛内运价表（只读一次，用于首次迁移；迁完置空） */
let legacyTable = null;
let legacySource = null;

/** 岛状态（可原地修改；改完记得 bump()） */
export const S = {
  /** 运价表（**宿主快照的只读副本**，只为渲染；不落盘、不回传） */
  table: null,
  /** 来源信息（由宿主快照给出）：{ filePath, fileName, sheetName, effectiveFrom } */
  source: null,
  /** 该 Excel 内全部 sheet 名（换 sheet 用） */
  sheetNames: [],
  /**
   * 上次**打开过**的文件（不论解析成功与否）。
   *
   * 和 `source` 的区别是关键的：`source` 记的是"当前运价表出自哪个文件的哪张 sheet"，
   * 而用户刚导入的那个文件和它可能不是同一个（导入失败时尤其如此）。
   * 导入失败后的"手动指定工作表"必须针对 `lastFile`，否则会去重读上一份旧文件。
   */
  lastFile: null,
  /** 上次体检的全部 sheet（含不可用的，各带 country 数与原因），供选表界面展示 */
  candidates: [],
  /** 查询偏好 */
  weight: DEFAULT_WEIGHT,
  category: 'auto',
  variant: '',
  rounding: 'round',

  // —— 临时部分 ——
  /** 查询结果（宿主 quote op 的返回） */
  results: [],
  /** 结果表过滤词 */
  filter: '',
  /** 结果是否针对当前克重（false 时表格显示的是旧结果，避免误读） */
  resultWeight: 0,
  isLoading: false,
  ready: false,
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
      console.error('[shipping-rate] store listener failed:', e);
    }
  });
}

// ---------------------------------------------------------------- 持久化

/**
 * 收集需要落盘的字段。
 *
 * ⚠️ **运价表与来源信息都不落盘**（M6 起真源在宿主 `sr_rate_snapshots`）——
 * 岛内再存一份就会出现两份真相，且"只留当前一份"会让历史订单的运费不可复算。
 * 查询结果同样不落盘：它随时可由运价表 + 克重复现，存下来只会让配置膨胀且过期。
 * 落盘的只有**纯界面状态**：上次打开的文件与其体检结果 + 查询偏好。
 */
function collect() {
  return {
    sheetNames: S.sheetNames,
    lastFile: S.lastFile,
    candidates: S.candidates,
    weight: S.weight,
    category: S.category,
    variant: S.variant,
    rounding: S.rounding,
  };
}

let saveTimer = null;
let saving = null;

/** 防抖落盘（400ms） */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush();
  }, 400);
}

/** 立即落盘（关键动作后调用，避免用户操作完立刻关窗丢数据） */
export async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // 串行化：并发 flush 只保留最后一次（collect() 读的是当前状态，后写的必然更全）
  saving = (saving || Promise.resolve()).then(
    () => api.saveConfig(collect()),
    () => api.saveConfig(collect()),
  );
  try {
    await saving;
  } catch (e) {
    console.error('[shipping-rate] save failed:', e);
  }
}

/** 读取持久化状态（含全新安装的默认值兜底） */
export async function loadState() {
  try {
    const d = await api.loadConfig();
    // 旧的岛内运价表：**只记下来用于迁移**，不直接当状态用（真源在宿主）
    legacyTable =
      d.table && Array.isArray(d.table.countries) && d.table.countries.length ? d.table : null;
    legacySource = d.source && typeof d.source === 'object' ? d.source : null;
    S.sheetNames = Array.isArray(d.sheetNames) ? d.sheetNames : [];
    S.lastFile =
      d.lastFile && typeof d.lastFile === 'object' && d.lastFile.filePath ? d.lastFile : null;
    S.candidates = Array.isArray(d.candidates) ? d.candidates : [];
    const w = Number(d.weight);
    S.weight = Number.isFinite(w) && w > 0 ? Math.round(w) : DEFAULT_WEIGHT;
    S.category = ['auto', 'general', 'special', 'bulk'].includes(d.category) ? d.category : 'auto';
    S.variant = typeof d.variant === 'string' ? d.variant : '';
    S.rounding = d.rounding === 'ceil' ? 'ceil' : 'round';
  } catch (e) {
    console.error('[shipping-rate] load state failed:', e);
  }
}

/** 从宿主取"当前运价表"（唯一真源）；首次运行顺带把旧的岛内表迁移上去 */
export async function syncTableFromHost() {
  try {
    let cur = await api.rateCurrent();
    if (!cur && legacyTable) {
      // 升级路径：把留在岛存储里的那张表**一次性**交给宿主（宿主按内容去重，重入安全）
      await api.rateAdopt(legacyTable, legacySource || {});
      cur = await api.rateCurrent();
    }
    S.table = cur && cur.table && Array.isArray(cur.table.countries) ? cur.table : null;
    S.source = cur
      ? {
          filePath: String(cur.sourceFile || ''),
          fileName: String(cur.sourceFile || '').split(/[\\/]/).pop() || '',
          sheetName: String(cur.sheetName || ''),
          effectiveFrom: String(cur.effectiveFrom || ''),
        }
      : null;
    // 迁移成功（或宿主本来就有表）→ 抹掉岛内那份陈旧副本：留着只会在下次排查时误导人
    if (S.table && legacyTable) {
      await api.saveConfig({ table: null, source: null });
      legacyTable = null;
      legacySource = null;
    }
  } catch (e) {
    console.error('[shipping-rate] sync rate table failed:', e);
    notify(`读取运价表失败：${(e && e.message) || e}`, 'error');
  }
}

// ---------------------------------------------------------------- 派生

/** 是否已有可用运价表 */
export const hasTable = () => !!(S.table && S.table.countries && S.table.countries.length);

/** 运价表里的国家（按中文名排序，供"按国家看档位"用） */
export function countriesSorted() {
  const list = hasTable() ? S.table.countries.slice() : [];
  return list.sort((a, b) => a.nameCn.localeCompare(b.nameCn, 'zh-Hans-CN'));
}

/** 结果表按过滤词筛选（匹配中文名 / 英文名 / Code） */
export function filteredResults() {
  const q = S.filter.trim().toLowerCase();
  if (!q) return S.results;
  return S.results.filter(
    (r) =>
      String(r.nameCn).toLowerCase().includes(q) ||
      String(r.nameEn).toLowerCase().includes(q) ||
      String(r.code).toLowerCase().includes(q),
  );
}

/**
 * 有价 / 无价统计（结果页摘要用）。
 *
 * ⚠️ 无价必须分两种报：**档位不覆盖**（`card` 为 null）与**该线路不是人民币报价**
 * （`card` 非 null 但宿主拒算）。合成一句"该克重无价"会让用户以为是自己克重输错了，
 * 实际是那条线路还没接汇率（见宿主 shipRateQuote.ts 的 QUOTE_CURRENCY）。
 */
export function resultStats() {
  const total = S.results.length;
  const ok = S.results.filter((r) => r.ok).length;
  const refused = S.results.filter((r) => !r.ok && r.card).length;
  return { total, ok, refused, noPrice: total - ok - refused };
}

// ---------------------------------------------------------------- 动作

/** 改克重（仅内存，调用方负责防抖后调 refreshQuote） */
export function setWeight(g) {
  const n = Number(g);
  S.weight = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  scheduleSave();
}

export function setCategory(c) {
  S.category = ['auto', 'general', 'special', 'bulk'].includes(c) ? c : 'auto';
  scheduleSave();
}

export function setVariant(v) {
  S.variant = typeof v === 'string' ? v : '';
  scheduleSave();
}

export function setRounding(r) {
  S.rounding = r === 'ceil' ? 'ceil' : 'round';
  scheduleSave();
}

export function setFilter(q) {
  S.filter = String(q ?? '');
}

/** 按当前条件重新问宿主要一遍全表报价 */
export async function refreshQuote() {
  if (!hasTable()) {
    S.results = [];
    bump('quote');
    return;
  }
  if (!(S.weight > 0)) {
    S.results = [];
    S.resultWeight = 0;
    bump('quote');
    return;
  }
  try {
    const r = await api.quote(S.weight, {
      category: S.category,
      variant: S.variant,
      rounding: S.rounding,
    });
    S.results = Array.isArray(r && r.results) ? r.results : [];
    S.resultWeight = Number(r && r.grams) || S.weight;
  } catch (e) {
    S.results = [];
    notify(`计算失败：${(e && e.message) || e}`, 'error');
  }
  bump('quote');
}

/** 体检结果里真正能用的那几张（候选卡片/按钮只展示这些） */
export function usableCandidates() {
  return (S.candidates || []).filter((c) => c && c.countries > 0);
}

/**
 * 导入 / 更新运价表。
 *
 * 覆盖语义：整表替换（不是合并）。换版时旧国家若已下架就该消失，
 * 合并会让用户看到一份"历史累积的幽灵价"。
 *
 * ⚠️ 这里传的是 `prefer`（名称提示）而**不是** `sheetName`（显式点名）：
 *    运营商报价单是一本 21 张 sheet 的工作簿，目标表在第 10 张；
 *    点名"上次那张"会在换版改名时直接失败，传提示则能自动落到可用的表上。
 *
 * @param {string} [prefer] 名称提示；一般传当前来源的 sheet 名
 */
export async function importByDialog(prefer) {
  const { openFile } = await import('./bridge.js');
  const sel = await openFile('excel');
  if (!sel) return false;

  S.isLoading = true;
  bump('loading');
  try {
    const r = await api.parseRateSheet(sel.filePath, { prefer });
    const table = r && r.table;
    const fileName = String(sel.filePath || '').split(/[\\/]/).pop() || '';
    // 体检结果先落状态：即使解析失败，界面也要能列出"试过哪些、各有多少国家"
    S.lastFile = { filePath: sel.filePath, fileName };
    S.sheetNames = Array.isArray(r && r.sheetNames) ? r.sheetNames : [];
    S.candidates = Array.isArray(r && r.candidates) ? r.candidates : [];

    if (!table || !Array.isArray(table.countries) || !table.countries.length) {
      const usable = usableCandidates();
      const detail = usable.length
        ? `可用工作表：${usable.map((c) => `${c.sheetName}（${c.countries} 国）`).join('、')}（可在下方手动指定）`
        : '该文件里没有任何含「运达国家/地区」表头的工作表';
      notify(`「${fileName}」没解析出运价：已体检 ${S.sheetNames.length} 张工作表，${detail}`, 'error');
      return false;
    }

    const before = hasTable() ? S.table.stats.countries : 0;
    // 解析在宿主完成、**并已由宿主留档为快照** —— 岛只把"当前那份"取回来渲染
    await syncTableFromHost();
    await refreshQuote();
    await flush();
    const after = S.table && S.table.stats ? S.table.stats.countries : table.stats.countries;
    const delta = before && before !== after ? `（原 ${before} 国 → 现 ${after} 国）` : '';
    // 多张 sheet 时说明"是我替你挑的"，否则用户会以为是文件里只有这一张
    const lead =
      r.picked === 'auto' && S.sheetNames.length > 1
        ? `已自动选择「${r.sheetName}」：`
        : '运价表已更新：';
    notify(`${lead}${after} 国 / ${table.stats.cards} 张价卡${delta}`, 'success');
    return true;
  } catch (e) {
    notify(`导入失败：${(e && e.message) || e}`, 'error');
    return false;
  } finally {
    S.isLoading = false;
    bump('rates');
  }
}

/**
 * 只换工作表（用已记住的文件路径重导，不再弹一次对话框）。
 *
 * @param {string} sheetName 目标 sheet —— **显式点名**，宿主不会改判到别的表
 * @param {string} [filePath] 指定源文件；默认用当前运价表的来源文件。
 *   导入失败后从候选列表手动指定时必须传 `S.lastFile.filePath`：
 *   那次导入没有形成运价表，`S.source` 可能仍指向更早的另一个文件。
 */
export async function switchSheet(sheetName, filePath) {
  const path =
    filePath || (S.source && S.source.filePath) || (S.lastFile && S.lastFile.filePath) || '';
  if (!sheetName || !path) {
    notify('没有记住源文件路径，请用「导入 / 更新运价表」重新选择', 'error');
    return false;
  }
  S.isLoading = true;
  bump('loading');
  try {
    const r = await api.parseRateSheet(path, { sheetName });
    const table = r && r.table;
    S.sheetNames = Array.isArray(r && r.sheetNames) ? r.sheetNames : S.sheetNames;
    S.candidates = Array.isArray(r && r.candidates) ? r.candidates : S.candidates;
    if (!table || !Array.isArray(table.countries) || !table.countries.length) {
      const why = (table && table.warnings && table.warnings[0]) || '该 sheet 不是报价单结构';
      notify(`「${sheetName}」没解析出运价：${why}`, 'error');
      return false;
    }
    const fileName =
      (S.source && S.source.fileName) ||
      (S.lastFile && S.lastFile.fileName) ||
      String(path).split(/[\\/]/).pop() ||
      '';
    // 与 importByDialog 同：解析已由宿主留档，岛只取回"当前那份"渲染
    await syncTableFromHost();
    await refreshQuote();
    await flush();
    const after = S.table && S.table.stats ? S.table.stats.countries : table.stats.countries;
    notify(`已切换到「${r.sheetName || sheetName}」：${after} 国（源文件 ${fileName || '—'}）`, 'success');
    return true;
  } catch (e) {
    notify(`切换失败：${(e && e.message) || e}`, 'error');
    return false;
  } finally {
    S.isLoading = false;
    bump('rates');
  }
}

// ---------------------------------------------------------------- 启动

/** 初始化：读配置 → 取宿主当前运价表 → 按已存偏好算一次（失败不阻断启动，岛要能打开） */
export async function init() {
  S.isLoading = true;
  bump('loading');
  try {
    await loadState();
    await syncTableFromHost();
    if (hasTable()) await refreshQuote();
  } catch (e) {
    console.error('[shipping-rate] init failed:', e);
  } finally {
    S.isLoading = false;
    S.ready = true;
    bump('init');
  }
}
