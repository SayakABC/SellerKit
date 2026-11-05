// dist/views/settings.js
// 设置视图：三个子页签 —— 模板配置 / 字段规则 / 显示列。
// 对照内建 TemplateManager.vue + FieldRuleManager.vue + ColumnSelector.vue（embedded 形态）。
//
// 渲染策略（本视图最容易踩的坑）：
//   这里同时存在「正在编辑的 textarea」与「会被 store 变更刷新的列表」。
//   若订阅到 store 变更就整体重绘，用户每敲一个字（或每次改规则）都会丢焦点、丢光标。
//   因此每个子页签都拆成 列表区 + 编辑区 两块，store 变更只重绘**列表区**；
//   编辑区的重绘只由显式动作触发（选中/新建/删除/切子页签）。
//
// 编辑草稿（st.draft）与 store 是分离的：改草稿不影响数据，只有点「保存」才落库 ——
// 与内建"深拷贝以允许取消"的语义一致。

import { activate, onClick, state } from '../app.js';
import { confirm, esc } from '../util.js';
import * as S from '../store.js';

const st = state('settings');
st.tab = st.tab || 'template';

let root = null;

/** 草稿：模板 */
st.draftTplId = st.draftTplId || null;
st.draftTpl = st.draftTpl || null;
/** 草稿：规则 */
st.draftRuleId = st.draftRuleId || null;
st.draftRule = st.draftRule || null;

const SUBS = [
  { id: 'template', label: '模板配置' },
  { id: 'rules', label: '字段规则' },
  { id: 'columns', label: '显示列' },
];

const RULE_FIELDS = [
  ['sourceField', '源日期字段'],
  ['packageField', '时长/套餐字段'],
  ['outputFormat', '输出格式'],
  ['template', '拼接模板'],
  ['expression', '运算表达式'],
  ['code', 'JavaScript 代码'],
];

/** 新建规则时的空配置（与内建 createEmptyConfig 一致） */
function emptyConfig() {
  return {
    sourceField: '',
    packageField: '',
    outputFormat: 'YYYY-MM-DD HH:mm',
    template: '',
    expression: '',
    code: '',
  };
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 可用占位符 = 原始列 + 衍生列 */
function placeholderFields() {
  return [...S.S.headers, ...S.S.derivedHeaders];
}

function statHtml() {
  return `${S.S.headers.length} 个原始字段 · ${S.S.derivedHeaders.length} 个衍生字段`;
}

// ============================================================ 模板配置

function tplListHtml() {
  const items = S.S.templateConfigs
    .map((t) => {
      const active = t.id === S.S.activeTemplateId;
      const cls = ['opt', t.id === st.draftTplId ? 'is-active' : ''].filter(Boolean).join(' ');
      return `
        <div class="${cls}" data-act="tpl-select" data-id="${esc(t.id)}">
          <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${active ? 'font-weight:600' : ''}">${esc(t.name)}</span>
          ${active ? '<span class="chip is-primary">当前</span>' : ''}
        </div>
        ${t.content ? '' : '<p class="hint is-warn" style="padding:0 10px 6px">模板内容为空</p>'}`;
    })
    .join('');
  return `
    <div class="settings-list-head">模板列表</div>
    <div class="settings-list-body">${items || '<div class="empty small">暂无模板</div>'}</div>
    <div class="settings-list-foot">
      <button class="btn is-bare is-sm" data-act="tpl-import" style="width:100%;justify-content:flex-start">+ 导入模板文件</button>
      <button class="btn is-bare is-sm" data-act="tpl-blank" style="width:100%;justify-content:flex-start">+ 新建空白模板</button>
    </div>`;
}

function tplMainHtml() {
  const d = st.draftTpl;
  if (!d) return '<div class="empty">选择左侧模板进行编辑</div>';
  const isActive = d.id === S.S.activeTemplateId;
  return `
    <div class="bar" style="padding:10px 12px;border-bottom:1px solid var(--wb-border)">
      <input class="input grow" id="tpl-name" value="${esc(d.name)}" placeholder="模板名称" />
      ${
        isActive
          ? '<span class="chip is-primary">当前使用</span>'
          : '<button class="btn is-sm is-primary" data-act="tpl-use">设为当前</button>'
      }
    </div>
    <div class="tpl-editor-wrap">
      <textarea class="tpl-textarea" id="tpl-content" spellcheck="false"
                placeholder="模板内容，使用 {{列名}} 作为占位符">${esc(d.content)}</textarea>
      <div class="autocomplete hidden" id="tpl-ac"></div>
    </div>
    <div class="settings-main-foot">
      <button class="btn is-primary" data-act="tpl-save">保存</button>
      ${d.id === 'default' ? '' : '<button class="btn is-danger" data-act="tpl-del">删除</button>'}
      <div class="grow"></div>
      <span class="small muted">占位符: {{列名}}</span>
    </div>`;
}

function paintTemplate(what = 'all') {
  if (what === 'all' || what === 'list') {
    const el = root.querySelector('#tpl-list');
    if (el) el.innerHTML = tplListHtml();
  }
  if (what === 'all' || what === 'main') {
    const el = root.querySelector('#tpl-main');
    if (el) el.innerHTML = tplMainHtml();
    bindTplEditor();
  }
}

/** 选中模板（草稿 = 深拷贝，未保存前不影响数据） */
function selectTemplate(id) {
  const t = S.getTemplate(id);
  if (!t) return;
  st.draftTplId = id;
  st.draftTpl = clone(t);
  paintTemplate('all');
}

/**
 * 模板内容输入的 `{{` 自动补全。
 * textarea 是整段重绘的，所以每次渲染后都要重新绑定 —— 由 bindTplEditor 统一负责，
 * 且只绑一次当前节点（节点是新的，旧监听器随 innerHTML 一起回收）。
 */
function bindTplEditor() {
  const wrap = root.querySelector('.tpl-editor-wrap');
  const ta = root.querySelector('#tpl-content');
  const ac = root.querySelector('#tpl-ac');
  const nameEl = root.querySelector('#tpl-name');
  if (!ta || !ac) return;

  if (nameEl) {
    nameEl.addEventListener('input', () => {
      st.draftTpl.name = nameEl.value;
    });
  }

  const hideAc = () => ac.classList.add('hidden');

  ta.addEventListener('input', () => {
    st.draftTpl.content = ta.value;
    const pos = ta.selectionStart;
    // 触发条件：光标前恰好是 `{{`
    if (ta.value.slice(pos - 2, pos) === '{{') {
      const opts = placeholderFields();
      if (!opts.length) {
        hideAc();
        return;
      }
      ac.innerHTML = opts.map((h) => `<div data-act="tpl-ph" data-val="${esc(h)}">${esc(h)}</div>`).join('');
      // 粗测光标位置（等宽字体下 lineHeight/charWidth 足够准；偏一点也不影响可用性）
      const lines = ta.value.slice(0, pos).split('\n');
      const lineNo = lines.length;
      const col = lines[lines.length - 1].length;
      ac.style.top = `${(lineNo - 1) * 20 + 12}px`;
      ac.style.left = `${Math.min(col * 8 + 16, Math.max(0, wrap.clientWidth - 180))}px`;
      ac.classList.remove('hidden');
    } else {
      hideAc();
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideAc();
  });
  ta.addEventListener('blur', () => setTimeout(hideAc, 150));
}

/** 把占位符插入光标处（补上被 `{{` 打开的后半截 `}}`） */
function insertPlaceholder(field) {
  const ta = root.querySelector('#tpl-content');
  const ac = root.querySelector('#tpl-ac');
  if (!ta || !st.draftTpl) return;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  ta.value = `${before}${field}}}${after}`;
  st.draftTpl.content = ta.value;
  const caret = before.length + field.length + 2;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  if (ac) ac.classList.add('hidden');
}

// ============================================================ 字段规则

function sortedRules() {
  return S.S.processingRules.slice().sort((a, b) => a.order - b.order);
}

function ruleListHtml() {
  const items = sortedRules()
    .map((r) => {
      const cls = ['opt', r.id === st.draftRuleId ? 'is-active' : ''].filter(Boolean).join(' ');
      const badge =
        r.type === 'jsExpression' ? 'is-danger' : r.type === 'math' ? 'is-warn' : r.type === 'template' ? 'is-ok' : 'is-accent';
      return `
        <div class="${cls}" data-act="rule-select" data-id="${esc(r.id)}">
          <input type="checkbox" data-act="rule-toggle" data-id="${esc(r.id)}" ${r.enabled ? 'checked' : ''} />
          <span class="grow" style="min-width:0">
            <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${r.enabled ? 'var(--wb-text)' : 'var(--wb-text-muted)'}">${esc(r.name)}</span>
            <span class="chip ${badge}" style="margin-top:2px">${esc(S.RULE_TYPES[r.type] || r.type)}</span>
            <span class="small muted"> #${r.order}</span>
          </span>
        </div>`;
    })
    .join('');
  return `
    <div class="settings-list-head">规则列表</div>
    <div class="settings-list-body">${items || '<div class="empty small">暂无规则</div>'}</div>
    <div class="settings-list-foot">
      <button class="btn is-bare is-sm" data-act="rule-new" style="width:100%;justify-content:flex-start">+ 新建规则</button>
    </div>`;
}

/** 数字型字段下拉（原始列） */
function headerOptions(current) {
  return [
    '<option value="">— 选择字段 —</option>',
    ...S.S.headers.map(
      (h) => `<option value="${esc(h)}" ${h === current ? 'selected' : ''}>${esc(h)}</option>`,
    ),
  ].join('');
}

function ruleMainHtml() {
  const d = st.draftRule;
  if (!d) return '<div class="empty">选择左侧规则进行编辑，或点击「+ 新建规则」</div>';
  const conflict = S.S.headers.includes(d.targetField);
  const cfg = d.config || {};

  let extra = '';
  if (d.type === 'dateOffset') {
    extra = `
      <div class="form-grid">
        <div class="field"><label>源日期字段</label>
          <select class="input" data-cfg="sourceField">${headerOptions(cfg.sourceField)}</select></div>
        <div class="field"><label>时长/套餐字段</label>
          <select class="input" data-cfg="packageField">${headerOptions(cfg.packageField)}</select></div>
        <div class="field"><label>输出格式</label>
          <input class="input" data-cfg="outputFormat" value="${esc(cfg.outputFormat || 'YYYY-MM-DD HH:mm')}" placeholder="YYYY-MM-DD HH:mm" />
          <p class="hint">支持: YYYY MM DD HH mm ss</p></div>
      </div>`;
  } else if (d.type === 'template') {
    extra = `
      <div class="field"><label>拼接模板</label>
        <textarea class="code-area" data-cfg="template" placeholder="例如：{{姓名}}-{{手机号}}">${esc(cfg.template || '')}</textarea>
        <div class="bar" style="margin-top:6px">
          ${placeholderFields()
            .map((h) => `<button class="btn is-sm" data-act="rule-ph" data-val="${esc(h)}">{{${esc(h)}}}</button>`)
            .join('')}
        </div>
      </div>`;
  } else if (d.type === 'math') {
    extra = `
      <div class="field"><label>运算表达式</label>
        <input class="input mono" data-cfg="expression" value="${esc(cfg.expression || '')}" placeholder='例如: \${price} * \${qty}' />
        <p class="hint">用 <code class="mono">\${字段名}</code> 引用字段，支持 + - * / 和 ()</p>
      </div>`;
  } else if (d.type === 'jsExpression') {
    extra = `
      <div class="field"><label>JavaScript 代码</label>
        <textarea class="code-area" data-cfg="code" placeholder='例如: fields["price"] > 100 ? "高价" : "低价"'>${esc(cfg.code || '')}</textarea>
        <p class="hint is-warn">代码中通过 <code class="mono">fields["字段名"]</code> 访问数据，需返回字符串或数字。</p>
        <p class="hint">求值在宿主完成（岛所在 iframe 的 CSP 禁止 eval），与内建版共用同一份规则引擎。</p>
      </div>`;
  }

  return `
    <div class="settings-main-body">
      <div class="field"><label>规则名称</label>
        <input class="input" data-rule="name" value="${esc(d.name)}" placeholder="例如：计算到期时间" /></div>
      <div class="field" style="margin-top:10px"><label>目标字段名${conflict ? '<span style="color:var(--wb-danger)"> （与原始列名冲突）</span>' : ''}</label>
        <input class="input" data-rule="targetField" value="${esc(d.targetField)}" placeholder="例如：到期时间"
               style="${conflict ? 'border-color:var(--wb-danger)' : ''}" /></div>
      <div class="field" style="margin-top:10px"><label>处理类型</label>
        <select class="input" data-rule="type">
          ${Object.entries(S.RULE_TYPES)
            .map(([k, v]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${v} (${k})</option>`)
            .join('')}
        </select></div>
      ${extra ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--wb-border)">${extra}</div>` : ''}
    </div>
    <div class="settings-main-foot">
      <button class="btn is-primary" data-act="rule-save" ${!d.name.trim() || !d.targetField.trim() ? 'disabled' : ''}>保存规则</button>
      <button class="btn is-danger" data-act="rule-del">删除规则</button>
      <div class="grow"></div>
      <span class="small muted">${esc(statHtml())}</span>
    </div>`;
}

function paintRules(what = 'all') {
  if (what === 'all' || what === 'list') {
    const el = root.querySelector('#rule-list');
    if (el) el.innerHTML = ruleListHtml();
  }
  if (what === 'all' || what === 'main') {
    const el = root.querySelector('#rule-main');
    if (el) el.innerHTML = ruleMainHtml();
    bindRuleEditor();
  }
}

function selectRule(id) {
  const r = S.S.processingRules.find((x) => x.id === id);
  if (!r) return;
  st.draftRuleId = id;
  st.draftRule = clone(r);
  paintRules('all');
}

/** 编辑器输入：只更新草稿（不落库、不重绘），保存时才写回 store */
function bindRuleEditor() {
  const main = root.querySelector('#rule-main');
  if (!main || !st.draftRule) return;
  main.querySelectorAll('[data-rule]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.rule;
      st.draftRule[k] = el.value;
      // 名称/目标字段会影响「保存」按钮可用态，需即时反映；类型会换配置表单
      if (k === 'name' || k === 'targetField') {
        const btn = main.querySelector('[data-act="rule-save"]');
        if (btn) btn.disabled = !st.draftRule.name.trim() || !st.draftRule.targetField.trim();
      }
    });
  });
  main.querySelectorAll('[data-cfg]').forEach((el) => {
    el.addEventListener('input', () => {
      st.draftRule.config = { ...st.draftRule.config, [el.dataset.cfg]: el.value };
    });
  });
  const typeSel = main.querySelector('[data-rule="type"]');
  if (typeSel) {
    typeSel.addEventListener('change', () => {
      // 切换类型必须重置配置（否则 dateOffset 的 sourceField 会残留在 math 规则里）
      st.draftRule.type = typeSel.value;
      st.draftRule.config = emptyConfig();
      paintRules('main');
    });
  }
}

// ============================================================ 显示列

function colHtml() {
  const all = S.allHeaders();
  if (!all.length) return '<div class="empty">暂无列数据，请先在「复制工作台」导入 Excel 文件</div>';
  return `
    <div class="settings-main-body" style="max-width:520px">
      <p class="small muted" style="margin:0 0 8px">勾选的列会显示在「复制工作台」的记录行上。紫标为字段规则生成的衍生列。</p>
      ${all
        .map((h) => {
          const derived = S.S.derivedHeaders.includes(h);
          return `
            <label class="check">
              <input type="checkbox" data-act="col-toggle" data-val="${esc(h)}" ${S.isColumnVisible(h) ? 'checked' : ''} />
              <span style="${derived ? 'color:var(--wb-accent)' : ''}">${esc(h)}</span>
              ${derived ? '<span class="chip is-accent" style="margin-left:auto">衍生</span>' : ''}
            </label>`;
        })
        .join('')}
    </div>
    <div class="settings-main-foot">
      <button class="btn is-sm" data-act="col-all">全选</button>
      <button class="btn is-sm" data-act="col-default">默认（前 2 列）</button>
      <div class="grow"></div>
      <span class="small muted">已选 ${S.S.visibleColumns.length} / ${all.length}</span>
    </div>`;
}

function paintColumns() {
  const el = root.querySelector('#col-list');
  if (el) el.innerHTML = colHtml();
}

// ============================================================ 外壳

function bodyHtml() {
  if (st.tab === 'rules') {
    return `
      <div class="settings-body" id="settings-body">
        <div class="settings-list" id="rule-list">${ruleListHtml()}</div>
        <div class="settings-main" id="rule-main">${ruleMainHtml()}</div>
      </div>`;
  }
  if (st.tab === 'columns') {
    return `
      <div class="settings-body" id="settings-body">
        <div class="settings-main" id="col-list" style="flex:1">${colHtml()}</div>
      </div>`;
  }
  return `
    <div class="settings-body" id="settings-body">
      <div class="settings-list" id="tpl-list">${tplListHtml()}</div>
      <div class="settings-main" id="tpl-main">${tplMainHtml()}</div>
    </div>`;
}

export default {
  id: 'settings',
  title: '设置',
  order: 2,

  async enter() {
    // 数据由「复制工作台」的 init 加载；这里只在尚未加载时补一次
    if (!S.S.ready) await S.init();
    if (!st.draftTplId && S.S.templateConfigs.length) {
      st.draftTplId = S.S.activeTemplateId;
      const t = S.getTemplate(st.draftTplId);
      st.draftTpl = t ? clone(t) : null;
    }
  },

  render() {
    return `
      <div class="settings">
        <div class="settings-head">
          <div class="seg" id="subseg">
            ${SUBS.map(
              (s) =>
                `<button data-act="sub" data-val="${s.id}" class="${s.id === st.tab ? 'is-active' : ''}">${s.label}</button>`,
            ).join('')}
          </div>
          <div class="grow"></div>
          <button class="btn is-sm" data-act="reprocess">立即应用</button>
          <button class="btn is-bare is-sm" data-act="back">← 返回工作台</button>
        </div>
        ${bodyHtml()}
      </div>`;
  },

  mount(el) {
    root = el;
    if (st.tab === 'template') bindTplEditor();
    if (st.tab === 'rules') bindRuleEditor();

    onClick(
      el,
      async (act, target) => {
        const id = target.dataset.id;
        const val = target.dataset.val;
        try {
          switch (act) {
            // ---------- 子页签 ----------
            case 'sub':
              if (st.tab === val) break;
              st.tab = val;
              el.querySelector('#subseg').innerHTML = SUBS.map(
                (s) => `<button data-act="sub" data-val="${s.id}" class="${s.id === st.tab ? 'is-active' : ''}">${s.label}</button>`,
              ).join('');
              el.querySelector('#settings-body').outerHTML = bodyHtml();
              refreshRefs();
              break;
            case 'back':
              await activate('copy');
              break;
            case 'reprocess':
              await S.reprocessRules();
              paintColumns();
              break;

            // ---------- 模板 ----------
            case 'tpl-select':
              selectTemplate(id);
              break;
            case 'tpl-use': {
              // 先落盘草稿再设为当前：否则「当前模板」还是旧内容，预览会不一致
              if (!(await saveTemplateDraft())) break;
              S.setActiveTemplate(st.draftTpl.id);
              paintTemplate('all');
              break;
            }
            case 'tpl-save':
              if (await saveTemplateDraft()) {
                paintTemplate('all');
                const { notify } = await import('../bridge.js');
                notify('模板已保存', 'success');
              }
              break;
            case 'tpl-del': {
              const d = st.draftTpl;
              if (!d) break;
              if (!(await confirm(`确定删除模板「${d.name}」吗？`, '删除'))) break;
              if (S.removeTemplate(d.id)) {
                st.draftTplId = null;
                st.draftTpl = null;
                paintTemplate('all');
              }
              break;
            }
            case 'tpl-import': {
              await S.importTemplateFile();
              const last = S.S.templateConfigs[S.S.templateConfigs.length - 1];
              if (last) selectTemplate(last.id);
              break;
            }
            case 'tpl-blank': {
              const t = { id: `tpl_${Date.now()}`, name: '新模板', filePath: '', content: '' };
              S.addTemplate(t);
              selectTemplate(t.id);
              break;
            }
            case 'tpl-ph':
              insertPlaceholder(val);
              break;

            // ---------- 字段规则 ----------
            case 'rule-select':
              selectRule(id);
              break;
            case 'rule-new': {
              const maxOrder = S.S.processingRules.reduce((m, r) => Math.max(m, r.order), 0);
              const r = {
                id: `rule_${Date.now()}`,
                name: '新规则',
                enabled: true,
                targetField: '',
                type: 'dateOffset',
                order: maxOrder + 1,
                config: emptyConfig(),
              };
              S.addRule(r);
              selectRule(r.id);
              break;
            }
            case 'rule-save': {
              const d = st.draftRule;
              if (!d) break;
              S.updateRule(d.id, {
                name: d.name,
                targetField: d.targetField,
                type: d.type,
                config: d.config,
              });
              const { notify } = await import('../bridge.js');
              notify('规则已保存', 'success');
              // 规则变了，衍生列可能变；有数据就直接重算，让用户立刻看到结果
              if (S.S.records.length) await S.applyRules(true);
              paintRules('all');
              break;
            }
            case 'rule-del': {
              const d = st.draftRule;
              if (!d) break;
              if (!(await confirm(`确定删除规则「${d.name}」吗？`, '删除'))) break;
              S.removeRule(d.id);
              st.draftRuleId = null;
              st.draftRule = null;
              paintRules('all');
              break;
            }
            case 'rule-ph':
              // 规则表单里的占位符快捷插入：追加到拼接模板末尾
              if (st.draftRule) {
                st.draftRule.config = {
                  ...st.draftRule.config,
                  template: `${st.draftRule.config.template || ''}{{${val}}}`,
                };
                paintRules('main');
              }
              break;
            case 'rule-toggle':
              // 正常情况下走不到这里：启用开关由 bindRuleListGuard() 在捕获阶段拦下并处理
              // （见该函数注释）。保留作兜底，避免将来换绑方式后开关彻底失效。
              S.toggleRuleEnabled(id);
              break;

            // ---------- 显示列 ----------
            case 'col-toggle':
              S.toggleColumn(val);
              break;
            case 'col-all':
              S.selectAllColumns();
              paintColumns();
              break;
            case 'col-default':
              S.selectDefaultColumns();
              paintColumns();
              break;
            default:
              break;
          }
        } catch (e) {
          const { notify } = await import('../bridge.js');
          notify(`操作失败：${(e && e.message) || e}`, 'error');
        }
      },
      '[data-act]',
    );

    // 规则列表里的启用开关是 checkbox，且嵌在「点击即选中规则」的行内。
    // 需要拦下它的 click，否则"只想勾一下"会顺带把规则切到编辑态。
    bindRuleListGuard();

    // store 变更：只重绘列表区（编辑区交给显式动作，避免打断输入）
    if (st.unsub) st.unsub();
    st.unsub = S.onStoreChange((reason) => {
      if (reason === 'columns') paintColumns();
      else if (reason === 'rules') {
        const l = el.querySelector('#rule-list');
        if (l) l.innerHTML = ruleListHtml();
        const stat = el.querySelector('#rule-main .settings-main-foot .muted');
        if (stat) stat.textContent = statHtml();
      } else if (reason === 'templates') {
        const l = el.querySelector('#tpl-list');
        if (l) l.innerHTML = tplListHtml();
      }
    });
  },

  leave() {
    if (st.unsub) {
      st.unsub();
      st.unsub = null;
    }
    root = null;
  },
};

/** 子页签切换 / 首次挂载后重新定位并绑定（body 被整体替换，旧节点引用与监听器全部失效） */
function refreshRefs() {
  if (!root) return;
  if (st.tab === 'template') bindTplEditor();
  if (st.tab === 'rules') {
    bindRuleEditor();
    bindRuleListGuard();
  }
}

/**
 * 规则启用开关的点击拦截。
 *
 * 开关是嵌在 `[data-act="rule-select"]` 行内的 checkbox，click 会冒泡到根容器的代理，
 * 于是"勾一下启用"会顺带把该规则切到编辑态（草稿被覆盖，用户正在填的内容丢失）。
 *
 * 做法：在**捕获阶段**对该容器 `stopPropagation()`，让事件不再抵达根代理。
 * 注意 `stopPropagation` 只阻断传播、不取消默认行为，checkbox 仍会正常勾选；
 * 数据侧另用 setTimeout 推迟到本轮派发结束后再写 —— 否则 store 的同步重绘会把正在
 * 派发事件的节点从文档里换掉（浅层看是"勾了没反应/位置跳"）。
 *
 * 必须每次页面重建后重新调用（节点会被 outerHTML 替换掉）。
 */
function bindRuleListGuard() {
  const listWrap = root && root.querySelector('#rule-list');
  if (!listWrap || listWrap.dataset.guard === '1') return;
  listWrap.dataset.guard = '1';
  listWrap.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || !t.dataset || t.dataset.act !== 'rule-toggle') return;
      e.stopPropagation();
      const id = t.dataset.id;
      setTimeout(() => S.toggleRuleEnabled(id), 0);
    },
    true,
  );
}

/**
 * 保存模板草稿：内容先落库，有来源文件则同步写回文件。
 * @returns {Promise<boolean>} 是否成功（失败时调用方不应继续改"当前模板"）
 */
async function saveTemplateDraft() {
  const d = st.draftTpl;
  if (!d) return false;
  return S.saveTemplateToFile(d);
}
