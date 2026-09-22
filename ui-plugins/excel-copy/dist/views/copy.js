// dist/views/copy.js
// 主视图：复制工作台（左列表 + 右预览）。
// 对照内建 ExcelCopyView + ToolBar + DropZone + RecordList + RecordItem + PreviewPanel 的分工，
// 合并为一个自渲染视图；交互语义逐条对齐（含键盘、双击复制、拖拽导入、撤销栈）。

import { onClick, state } from '../app.js';
import { esc, truncate } from '../util.js';
import * as S from '../store.js';

/** 视图私有状态 */
const st = state('copy');

/** 当前挂载点（重绘时更新，供局部渲染定位） */
let root = null;

/** document 级键盘监听（每次 mount 前先摘掉旧的，避免随重绘累加） */
let keyHandler = null;

/** 拖拽高亮标记（避免 dragleave 在子元素间反复触发导致闪烁） */
let dragDepth = 0;

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'unused', label: '未使用' },
  { id: 'used', label: '已使用' },
];

/** 当前应显示的列：没选过就用前 2 列（与内建 RecordItem 一致） */
function displayFields(rec) {
  const cols = S.S.visibleColumns.length > 0 ? S.S.visibleColumns : Object.keys(rec.fields).slice(0, 2);
  return cols.filter((k) => k in rec.fields);
}

function counts() {
  return { all: S.totalCount(), unused: S.unusedCount(), used: S.usedCount() };
}

/** 顶部筛选条（只重绘自身，不碰搜索框，避免输入时丢焦点） */
function segHtml() {
  const c = counts();
  return FILTERS.map(
    (f) =>
      `<button data-act="filter" data-val="${f.id}" class="${f.id === S.S.filterMode ? 'is-active' : ''}">${f.label} (${c[f.id]})</button>`,
  ).join('');
}

function listHtml() {
  if (S.S.isLoading) return '<div class="empty">加载中…</div>';
  if (S.S.records.length === 0) {
    return `
      <div class="dropzone" data-act="import">
        <div class="dropzone-card">
          <h3>点击或拖拽 Excel 文件到此处</h3>
          <p>支持 .xlsx / .xls 格式</p>
        </div>
      </div>`;
  }
  const list = S.filtered();
  if (list.length === 0) {
    return `<div class="empty">当前筛选下没有记录${S.S.searchQuery ? `（搜索：${esc(S.S.searchQuery)}）` : ''}</div>`;
  }
  return list
    .map((r) => {
      const cls = [
        'rec',
        r.id === S.S.selectedId ? 'is-selected' : '',
        r.used ? 'is-used' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const mark = r.used
        ? '<span class="rec-mark is-used">✓</span>'
        : '<span class="rec-mark is-unused">○</span>';
      const fields = displayFields(r)
        .map(
          (k) =>
            `<span><span class="rec-key">${esc(k)}:</span><span class="rec-val">${esc(truncate(r.fields[k] || '', 30))}</span></span>`,
        )
        .join('');
      return `
        <div class="${cls}" data-act="select" data-id="${r.id}">
          ${mark}
          <div class="rec-main">${fields}</div>
          <button class="btn is-bare is-sm" data-act="copy" data-id="${r.id}"
                  title="${r.used ? '仅复制' : '复制并标记'}">复制</button>
        </div>`;
    })
    .join('');
}

function previewHtml() {
  const rec = S.selected();
  if (!rec) {
    return '<div class="empty">点击左侧记录预览内容</div>';
  }
  const tpl = S.activeTpl();
  const p = S.preview();
  const fields = Object.entries(rec.fields || {})
    .map(
      ([k, v]) =>
        `<div><span class="k">${esc(k)}:</span><span class="v">${esc(v)}</span></div>`,
    )
    .join('');
  return `
    <div class="preview-head">
      <div class="grow">
        <div class="panel-title" style="margin:0">内容预览</div>
        <div class="small muted">模板: ${esc(tpl ? tpl.name : '未选择')}</div>
      </div>
      <span class="chip ${rec.used ? 'is-ok' : ''}">${rec.used ? '已使用' : '未使用'}</span>
    </div>
    <div class="preview-body">
      <div class="small muted" style="margin-bottom:6px">模板替换结果</div>
      <pre class="preview-out">${p.html}</pre>
      ${p.hasMissing ? '<p class="hint is-warn">存在缺失字段（红色标记），复制结果里会保留 [字段缺失: …] 占位。</p>' : ''}
      <details class="fields" style="margin-top:12px">
        <summary>字段详情</summary>
        <div class="fields-grid">${fields}</div>
      </details>
    </div>
    <div class="preview-foot">
      <button class="btn is-primary grow-btn" data-act="copy" data-id="${rec.id}">
        ${rec.used ? '仅复制' : '复制并标记已使用'}
      </button>
      ${rec.used ? '<button class="btn" data-act="undo-one" data-id="' + rec.id + '">撤销标记</button>' : ''}
    </div>`;
}

/** 局部渲染：列表 / 预览 / 筛选条 / 按钮可用态 */
function paint(what = 'all') {
  if (!root) return;
  if (what === 'all' || what === 'list') {
    const el = root.querySelector('#rec-list');
    if (el) el.innerHTML = listHtml();
  }
  if (what === 'all' || what === 'preview') {
    const el = root.querySelector('#preview');
    if (el) el.innerHTML = previewHtml();
  }
  if (what === 'all' || what === 'toolbar') {
    const el = root.querySelector('#seg');
    if (el) el.innerHTML = segHtml();
    const undo = root.querySelector('[data-act="undo"]');
    if (undo) undo.disabled = S.S.undoStack.length === 0;
    const reset = root.querySelector('[data-act="reset"]');
    if (reset) reset.disabled = S.usedCount() === 0;
  }
}

/** 让当前选中项滚入视野（键盘切换时用，否则选到列表外的行用户看不到） */
function scrollSelectedIntoView() {
  if (!root) return;
  const el = root.querySelector('.rec.is-selected');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

/** 键盘操作：↑↓ 切换 / Enter 复制并标记 / Ctrl(Cmd)+Z 撤销 */
function bindKeys() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e) => {
    // 输入控件内的按键归输入控件（否则搜索框里按 ↓ 会跳记录、按 Enter 会误复制）
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) {
      return;
    }
    const list = S.filtered();
    if (!list.length) return;
    const idx = list.findIndex((r) => r.id === S.S.selectedId);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      S.selectRecord(list[idx < list.length - 1 ? idx + 1 : 0].id);
      scrollSelectedIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      S.selectRecord(list[idx > 0 ? idx - 1 : list.length - 1].id);
      scrollSelectedIntoView();
    } else if (e.key === 'Enter') {
      const rec = S.selected();
      if (!rec) return;
      e.preventDefault();
      void S.copyAndMark(rec);
    } else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      S.undo();
    }
  };
  document.addEventListener('keydown', keyHandler);
}

/** 拖拽导入（整个左栏都是投放区） */
function bindDrop(el) {
  const setOver = (on) => el.classList.toggle('is-dragover', on);
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    setOver(true);
  });
  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    setOver(true);
  });
  el.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setOver(false);
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    setOver(false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      void import('../bridge.js').then((m) => m.notify('仅支持 .xlsx / .xls 格式', 'error'));
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      await S.importByBuffer(buf, file.name);
    } catch (err) {
      void import('../bridge.js').then((m) => m.notify(`读取文件失败：${(err && err.message) || err}`, 'error'));
    }
  });
}

/** 左右分栏拖拽调宽 */
function bindSplitter(el) {
  const bar = el.querySelector('.split-bar');
  const left = el.querySelector('.split-left');
  if (!bar || !left) return;
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const box = el.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(85, Math.max(20, ((ev.clientX - box.left) / box.width) * 100));
      left.style.flexBasis = `${pct}%`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

export default {
  id: 'copy',
  title: '复制工作台',
  order: 1,

  async enter() {
    await S.init();
  },

  render() {
    return `
      <div class="split">
        <div class="split-left">
          <div class="list-toolbar">
            <div class="seg" id="seg">${segHtml()}</div>
            <input class="input" id="search" type="search" placeholder="搜索记录…"
                   value="${esc(S.S.searchQuery)}" style="width:150px" />
            <div class="grow"></div>
            <button class="btn is-sm" data-act="import">导入</button>
            <button class="btn is-bare is-sm" data-act="open-columns" title="选择显示列">显示列</button>
            <button class="btn is-sm" data-act="undo" title="撤销 (Ctrl+Z)" ${S.S.undoStack.length === 0 ? 'disabled' : ''}>撤销</button>
            <button class="btn is-danger is-sm" data-act="reset" ${S.usedCount() === 0 ? 'disabled' : ''}>重置</button>
          </div>
          <div class="list-body" id="rec-list">${listHtml()}</div>
        </div>
        <div class="split-bar" title="拖动调整宽度"></div>
        <div class="split-right preview" id="preview">${previewHtml()}</div>
      </div>`;
  },

  mount(el) {
    root = el;
    bindKeys();
    bindSplitter(el);
    bindDrop(el.querySelector('.split-left'));

    // 点击目标有四类：data-act（操作）/ .rec 的选中 / 过滤与子页签同属 data-act。
    // app.onClick 默认只代理 [data-act]；本视图所有点击目标都带 data-act
    //（行本身 data-act="select"，行内按钮 data-act="copy"），故默认选择器即可。
    // 显式写出是为了留下意图：日后给行内容再加 data-* 属性时，别忘了它会绕过代理。
    onClick(
      el,
      async (act, target) => {
        const id = Number(target.dataset.id);
        try {
          switch (act) {
            case 'filter':
              S.setFilter(target.dataset.val);
              paint('toolbar');
              paint('list');
              break;
            case 'select':
              // 行内"复制"按钮也是 .rec 的子元素：data-act 判定优先，不会落到这里
              S.selectRecord(id);
              break;
            case 'copy': {
              const rec = S.S.records.find((r) => r.id === id);
              if (rec) await S.copyAndMark(rec);
              break;
            }
            case 'undo':
              S.undo();
              break;
            case 'reset': {
              const { confirm } = await import('../util.js');
              if (await confirm('确定要重置所有记录的使用状态吗？（该项不可撤销）', '重置')) S.resetAll();
              break;
            }
            case 'import':
              await S.importByDialog();
              break;
            case 'open-columns':
              // 跳到设置页的「显示列」页签（视图间跳转，不重绘本视图）
              state('settings').tab = 'columns';
              await import('../app.js').then((m) => m.activate('settings'));
              break;
            case 'undo-one':
              S.undo();
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

    // 搜索：只重绘列表（搜索框自身不受影响，焦点与光标位置保留）
    const search = el.querySelector('#search');
    if (search) {
      search.addEventListener('input', () => S.setSearch(search.value));
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          search.value = '';
          S.setSearch('');
        }
      });
    }

    // 双击记录 = 复制并标记（与内建 RecordItem 的 dblclick 一致）。
    // 注意别把"行内复制按钮"也算进来：按钮自带 data-act="copy"，本身已处理点击。
    ["#rec-list"].forEach((sel) => {
      const box = el.querySelector(sel);
      if (!box) return;
      box.addEventListener('dblclick', (e) => {
        const row = e.target.closest ? e.target.closest('[data-act="select"]') : null;
        if (!row) return;
        const rec = S.S.records.find((r) => r.id === Number(row.dataset.id));
        if (rec) void S.copyAndMark(rec);
      });
    });

    // 订阅状态变更：按 reason 决定重绘范围
    if (st.unsub) st.unsub();
    st.unsub = S.onStoreChange((reason) => {
      if (reason === 'loading' || reason === 'init') paint('all');
      else if (reason === 'selection' || reason === 'templates') paint('preview');
      else if (reason === 'filter' || reason === 'search') paint('list');
      else if (reason === 'records') {
        paint('list');
        paint('preview');
        paint('toolbar');
      } else if (reason === 'columns') paint('list');
      else paint('all');
    });
    paint('all');
  },

  /** 视图切走时解绑（避免离开后仍响应快捷键/状态变更） */
  leave() {
    if (st.unsub) {
      st.unsub();
      st.unsub = null;
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    root = null;
  },
};
