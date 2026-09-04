import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { RecordItem, TemplateConfig, AppState, ProcessingRule } from '@/types';
import { renderTemplate, previewTemplate } from '@/lib/templateEngine';
import { applyFieldProcessor, computeRulesHash } from '@/lib/fieldProcessor';
import { toast } from '@/core/services/toast';
import { useModuleStorage } from '@/core/services/storage';
import { writeClipboard } from '@/core/services/clipboard';
import { selectExcelFile as dialogSelectExcel, selectTemplateFile } from '@/core/services/dialog';
import type { HostApi } from '@/core/plugin/sdk';
import { importExcelFromFile, parseExcelBuffer, type ParseResult } from '@/core/services/excel';
import { ipc } from '@/core/services/ipc';

const MODULE_ID = 'excel-copy';
const storage = useModuleStorage<AppState>(MODULE_ID);

const DEFAULT_TEMPLATE_CONTENT = `http://{{domain}}.beuaya.com/get.php?username={{Username}}&password={{Password}}&type=m3u_plus&output=mpegts

👤 Username: {{Username}}
🔑 Password: {{Password}}
🔗 DNS (URL): http://{{DNS}}
📺 Samsung & LG DNS (IPTV Smarters): http://{{domain}}.yufengsmart.com
📦 Package: {{Package}}
📅 Expiry Date: {{Package}}`;

const defaultTemplateConfig: TemplateConfig = {
  id: 'default',
  name: '默认模板',
  filePath: '',
  content: DEFAULT_TEMPLATE_CONTENT,
  isBuiltIn: true,
};

const defaultDomainRule: ProcessingRule = {
  id: 'default_domain',
  name: '域名解析',
  enabled: true,
  targetField: 'domain',
  type: 'jsExpression',
  order: 1,
  config: { code: `fields["DNS"].split('.').slice(0, 1)[0]` },
};

// --- Phase 2（SDK 收敛示范）：宿主能力经 ctx.host 注入（见 index.ts activate），
// 剪贴板写入路径以此为优先；旧通道 writeClipboard 保留为未激活/回退形态（兼容别名） ---
let clipboardHost: HostApi | null = null;

/** 模块激活时由 index.ts 注入 ctx.host；停用传 null 回退旧通道 */
export function setClipboardHost(host: HostApi | null): void {
  clipboardHost = host;
}

/** 复制文本：ctx.host.clipboard 优先（失败 reject → 捕获返回 false），未注入时回退旧通道 */
async function clipboardWrite(text: string): Promise<boolean> {
  if (clipboardHost) {
    try {
      await clipboardHost.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return writeClipboard(text);
}

export const useExcelCopyStore = defineStore('excel-copy', () => {
  // --- State ---
  const records = ref<RecordItem[]>([]);
  const headers = ref<string[]>([]);
  const selectedId = ref<number | null>(null);
  const searchQuery = ref('');
  const filterMode = ref<'all' | 'unused' | 'used'>('all');
  const templateConfigs = ref<TemplateConfig[]>([]);
  const activeTemplateId = ref('default');
  const lastExcelPath = ref('');
  const lastTemplatePath = ref('');
  const isLoading = ref(false);
  const undoStack = ref<{ id: number; prevUsed: boolean; prevOrder: number }[]>([]);
  const showTemplateManager = ref(false);

  // --- 字段处理规则状态 ---
  const processingRules = ref<ProcessingRule[]>([]);
  const visibleColumns = ref<string[]>([]);
  const showRuleManager = ref(false);
  const lastAppliedRulesHash = ref('');
  const derivedHeaders = ref<string[]>([]);

  // --- Computed ---
  const activeTemplate = computed(() => {
    return templateConfigs.value.find((t) => t.id === activeTemplateId.value) || null;
  });

  const filteredRecords = computed(() => {
    let list = [...records.value];
    if (filterMode.value === 'unused') {
      list = list.filter((r) => !r.used);
    } else if (filterMode.value === 'used') {
      list = list.filter((r) => r.used);
    }
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.toLowerCase();
      list = list.filter((r) =>
        Object.values(r.fields).some((v) => v.toLowerCase().includes(q)),
      );
    }
    list.sort((a, b) => a.order - b.order);
    return list;
  });

  const selectedRecord = computed(() => {
    return records.value.find((r) => r.id === selectedId.value) || null;
  });

  const previewHtml = computed(() => {
    if (!selectedRecord.value || !activeTemplate.value) return { html: '', hasMissing: false };
    return previewTemplate(activeTemplate.value.content, selectedRecord.value.fields);
  });

  const usedCount = computed(() => records.value.filter((r) => r.used).length);
  const unusedCount = computed(() => records.value.filter((r) => !r.used).length);
  const totalCount = computed(() => records.value.length);

  /** 所有可用列名 = 原始列 + 衍生列 */
  const allHeaders = computed(() => {
    const set = new Set([...headers.value, ...derivedHeaders.value]);
    return Array.from(set);
  });

  // --- 持久化（通过 core/services/storage 命名空间） ---
  function collectState(): AppState {
    return {
      lastExcelPath: lastExcelPath.value,
      lastTemplatePath: lastTemplatePath.value,
      records: JSON.parse(JSON.stringify(records.value)),
      templateConfigs: JSON.parse(JSON.stringify(templateConfigs.value)),
      activeTemplateId: activeTemplateId.value,
      processingRules: JSON.parse(JSON.stringify(processingRules.value)),
      visibleColumns: [...visibleColumns.value],
    };
  }

  function scheduleSave() {
    storage.scheduleSave(collectState());
  }

  async function saveState() {
    await storage.save(collectState());
  }

  async function loadState() {
    try {
      const data = await storage.load();
      if (data) {
        const d = data as AppState;
        lastExcelPath.value = d.lastExcelPath || '';
        lastTemplatePath.value = d.lastTemplatePath || '';
        records.value = d.records || [];
        activeTemplateId.value = d.activeTemplateId || 'default';
        processingRules.value = d.processingRules || [];
        visibleColumns.value = d.visibleColumns || [];
        templateConfigs.value =
          d.templateConfigs && d.templateConfigs.length
            ? d.templateConfigs
            : [defaultTemplateConfig];
      }
      // 保证默认模板与默认规则始终存在（全新安装 / 数据缺失时回退，等价于旧 store 默认值）
      if (templateConfigs.value.length === 0) {
        templateConfigs.value = [defaultTemplateConfig];
      }
      if (processingRules.value.length === 0) {
        processingRules.value = [defaultDomainRule];
      }
    } catch (e: any) {
      console.error('Load state failed:', e);
    }
  }

  /** 自动填充 visibleColumns：如果还没有设置，默认显示前 2 个列 */
  function ensureVisibleColumns() {
    if (visibleColumns.value.length === 0 && headers.value.length > 0) {
      visibleColumns.value = headers.value.slice(0, 2);
    }
  }

  /** 对 records 执行启用的规则，更新衍生字段 */
  function applyRules() {
    if (processingRules.value.length === 0) return;

    const result = applyFieldProcessor(
      records.value,
      headers.value,
      processingRules.value,
    );

    // 更新衍生列名
    derivedHeaders.value = result.newHeaders;

    // 自动将新衍生列加入 visibleColumns（如果 visibleColumns 为空则不添加）
    if (visibleColumns.value.length > 0) {
      for (const h of result.newHeaders) {
        if (!visibleColumns.value.includes(h)) {
          visibleColumns.value.push(h);
        }
      }
    }

    // 记录规则哈希，用于检测变更
    lastAppliedRulesHash.value = computeRulesHash(processingRules.value);

    // 显示规则处理错误
    for (const err of result.errors) {
      const rule = processingRules.value.find((r) => r.id === err.ruleId);
      const ruleName = rule?.name || err.ruleId;
      console.error(`[${ruleName}] ${err.message}`);
    }
  }

  // ==========================================
  // 规则 CRUD
  // ==========================================

  function addRule(rule: ProcessingRule) {
    processingRules.value.push(rule);
    scheduleSave();
  }

  function removeRule(id: string) {
    processingRules.value = processingRules.value.filter((r) => r.id !== id);
    // 清理衍生列名
    refreshDerivedHeaders();
    scheduleSave();
  }

  function updateRule(id: string, updates: Partial<ProcessingRule>) {
    const idx = processingRules.value.findIndex((r) => r.id === id);
    if (idx !== -1) {
      processingRules.value[idx] = { ...processingRules.value[idx], ...updates };
      scheduleSave();
    }
  }

  function toggleRuleEnabled(id: string) {
    const rule = processingRules.value.find((r) => r.id === id);
    if (rule) {
      rule.enabled = !rule.enabled;
      scheduleSave();
    }
  }

  /** 从规则中刷新衍生列名 */
  function refreshDerivedHeaders() {
    const enabled = processingRules.value.filter((r) => r.enabled);
    derivedHeaders.value = [...new Set(enabled.map((r) => r.targetField))];
  }

  // ==========================================
  // 列显示控制
  // ==========================================

  function toggleColumnVisibility(field: string) {
    const idx = visibleColumns.value.indexOf(field);
    if (idx !== -1) {
      visibleColumns.value.splice(idx, 1);
    } else {
      visibleColumns.value.push(field);
    }
    scheduleSave();
  }

  function isColumnVisible(field: string): boolean {
    return visibleColumns.value.includes(field);
  }

  // ==========================================
  // Excel 导入（集成规则处理）
  // ==========================================

  async function importExcel(parsed: ParseResult, filePath: string) {
    try {
      isLoading.value = true;
      headers.value = parsed.headers;

      // 幂等性：同文件同行数时保留 used/order
      const rulesChanged =
        lastAppliedRulesHash.value &&
        lastAppliedRulesHash.value !== computeRulesHash(processingRules.value);

      if (
        !rulesChanged &&
        filePath === lastExcelPath.value &&
        records.value.length === parsed.records.length
      ) {
        parsed.records.forEach((newRec) => {
          const existing = records.value.find((r) => r.id === newRec.id);
          if (existing) {
            newRec.used = existing.used;
            newRec.order = existing.order;
          }
        });
      }

      records.value = parsed.records;
      lastExcelPath.value = filePath;
      selectedId.value = null;
      undoStack.value = [];
      derivedHeaders.value = [];

      // 执行字段处理规则
      applyRules();

      // 自动设置默认可见列
      ensureVisibleColumns();

      scheduleSave();
      toast('Excel 文件导入成功', 'success');
    } catch (e: any) {
      toast(`解析失败: ${e.message}`, 'error');
    } finally {
      isLoading.value = false;
    }
  }

  /** 手动重新执行所有规则（"立即应用"按钮） */
  function reprocessRules() {
    if (records.value.length === 0) {
      toast('没有数据可处理', 'info');
      return;
    }
    const enabledCount = processingRules.value.filter((r) => r.enabled).length;
    if (enabledCount === 0) {
      toast('没有启用的规则', 'info');
      return;
    }
    applyRules();
    toast(`已执行 ${enabledCount} 条规则`, 'success');
  }

  async function selectExcelFile() {
    try {
      const sel = await dialogSelectExcel();
      if (sel) {
        await importExcel(parseExcelBuffer(sel.data), sel.filePath);
      }
    } catch (e: any) {
      toast(`选择文件失败: ${e.message}`, 'error');
    }
  }

  async function loadExcelByPath(filePath: string) {
    try {
      const imp = await importExcelFromFile(filePath);
      if (imp) {
        await importExcel(imp.result, imp.filePath);
      }
    } catch (e: any) {
      toast(`加载文件失败: ${e.message}`, 'error');
    }
  }

  async function copyAndMark(record: RecordItem) {
    if (!activeTemplate.value) {
      toast('请先配置模板', 'error');
      return;
    }
    const text = renderTemplate(activeTemplate.value.content, record.fields);
    try {
      const ok = await clipboardWrite(text);
      if (!ok) {
        toast('复制到剪贴板失败，请手动复制', 'error');
        return;
      }
    } catch {
      toast('复制到剪贴板失败，请手动复制', 'error');
      return;
    }
    if (!record.used) {
      undoStack.value.push({ id: record.id, prevUsed: record.used, prevOrder: record.order });
      const maxUsedOrder = records.value
        .filter((r) => r.used)
        .reduce((max, r) => Math.max(max, r.order), 10000);
      record.used = true;
      record.order = maxUsedOrder + 1;
      scheduleSave();
      toast('已复制并标记为已使用', 'success');
    } else {
      toast('已复制到剪贴板', 'info');
    }
  }

  function undo() {
    const last = undoStack.value.pop();
    if (!last) {
      toast('没有可撤销的操作', 'info');
      return;
    }
    const record = records.value.find((r) => r.id === last.id);
    if (record) {
      record.used = last.prevUsed;
      record.order = last.prevOrder;
      scheduleSave();
      toast('已撤销', 'info');
    }
  }

  function resetAll() {
    records.value.forEach((r) => {
      r.used = false;
      r.order = r.id;
    });
    undoStack.value = [];
    scheduleSave();
    toast('已重置所有状态', 'info');
  }

  function selectRecord(id: number) {
    selectedId.value = id;
  }

  // --- 模板管理 ---

  function addTemplate(config: TemplateConfig) {
    templateConfigs.value.push(config);
    scheduleSave();
  }

  function removeTemplate(id: string) {
    if (id === activeTemplateId.value) {
      toast('不能删除当前激活的模板', 'error');
      return;
    }
    templateConfigs.value = templateConfigs.value.filter((t) => t.id !== id);
    scheduleSave();
  }

  function updateTemplate(id: string, updates: Partial<TemplateConfig>) {
    const idx = templateConfigs.value.findIndex((t) => t.id === id);
    if (idx !== -1) {
      templateConfigs.value[idx] = { ...templateConfigs.value[idx], ...updates };
      scheduleSave();
    }
  }

  function setActiveTemplate(id: string) {
    activeTemplateId.value = id;
    scheduleSave();
  }

  async function importTemplateFile() {
    try {
      const sel = await selectTemplateFile();
      if (sel) {
        const { filePath, content } = sel;
        const name = filePath.split('/').pop()?.replace('.txt', '') || '导入模板';
        const id = `tpl_${Date.now()}`;
        addTemplate({ id, name, filePath, content });
        setActiveTemplate(id);
        toast('模板导入成功', 'success');
      }
    } catch (e: any) {
      toast(`导入模板失败: ${e.message}`, 'error');
    }
  }

  async function saveTemplateToFile(template: TemplateConfig) {
    if (template.filePath) {
      try {
        const result = await ipc.saveTemplate(template.filePath, template.content);
        if (result.success) {
          toast('模板已保存到文件', 'success');
        }
      } catch (e: any) {
        toast(`保存模板失败: ${e.message}`, 'error');
      }
    }
    updateTemplate(template.id, { content: template.content });
  }

  async function loadDefaultTemplate() {
    try {
      const pathResult = await ipc.getDefaultTemplatePath();
      if (!pathResult.success || !pathResult.data) {
        console.error('Get default template path failed:', pathResult.error);
        return;
      }
      const defaultPath = pathResult.data;
      const readResult = await ipc.readFile(defaultPath);
      if (readResult.success && readResult.data) {
        const { content } = readResult.data;
        const defaultTpl = templateConfigs.value.find((t) => t.id === 'default');
        if (defaultTpl) {
          defaultTpl.content = content;
          defaultTpl.filePath = defaultPath;
          defaultTpl.isBuiltIn = true;
        } else {
          templateConfigs.value.unshift({
            id: 'default',
            name: '默认模板',
            filePath: defaultPath,
            content,
            isBuiltIn: true,
          });
        }
        scheduleSave();
      }
    } catch (e: any) {
      console.error('Load default template failed:', e);
    }
  }

  async function init() {
    isLoading.value = true;
    try {
      await loadState();

      // 内置模板(isBuiltIn !== false)每次启动从文件同步最新内容
      const defaultTpl = templateConfigs.value.find((t) => t.id === 'default');
      if (defaultTpl && defaultTpl.isBuiltIn !== false) {
        await loadDefaultTemplate();
      }

      // Auto-load last Excel file
      if (lastExcelPath.value) {
        const existsResult = await ipc.checkFileExists(lastExcelPath.value);
        if (existsResult.success && existsResult.data) {
          await loadExcelByPath(lastExcelPath.value);
        }
      }

      // 恢复 visibleColumns 并执行规则（在 init 后 applyRules 已被 importExcel 调用）
      ensureVisibleColumns();
    } catch (e: any) {
      console.error('Init failed:', e);
    } finally {
      isLoading.value = false;
    }
  }

  return {
    // State
    records,
    headers,
    selectedId,
    searchQuery,
    filterMode,
    templateConfigs,
    activeTemplateId,
    lastExcelPath,
    lastTemplatePath,
    isLoading,
    undoStack,
    showTemplateManager,
    // 字段规则状态
    processingRules,
    visibleColumns,
    showRuleManager,
    derivedHeaders,
    // Computed
    activeTemplate,
    filteredRecords,
    selectedRecord,
    previewHtml,
    usedCount,
    unusedCount,
    totalCount,
    allHeaders,
    // Methods - 通用
    saveState,
    loadState,
    init,
    // Methods - Excel
    importExcel,
    selectExcelFile,
    loadExcelByPath,
    applyRules,
    reprocessRules,
    // Methods - 记录操作
    copyAndMark,
    undo,
    resetAll,
    selectRecord,
    // Methods - 模板
    addTemplate,
    removeTemplate,
    updateTemplate,
    setActiveTemplate,
    importTemplateFile,
    saveTemplateToFile,
    loadDefaultTemplate,
    // Methods - 字段规则
    addRule,
    removeRule,
    updateRule,
    toggleRuleEnabled,
    refreshDerivedHeaders,
    // Methods - 列显示
    toggleColumnVisibility,
    isColumnVisible,
    ensureVisibleColumns,
  };
});
