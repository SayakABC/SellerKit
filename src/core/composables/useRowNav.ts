/*
 * 表格键盘动线（方案 §6「手不离键」）。
 *
 * 约定（全仓一致，新增表只需接一次）：
 *   ↑ / ↓  移动"当前行"        —— **不改勾选**：选中是"标记要处理"，移动是"看下一行"
 *   Space  勾选 / 取消当前行
 *   Enter  进详情（等价于点那一行的主入口）
 *
 * 三条必须放在这里、而不是各自组件里写的理由：
 *   ① **焦点在控件上时不接管**：表格里布满 checkbox / 行内按钮，keydown 会从它们冒泡上来。
 *      不判的话按一下 Space 会"原生切换 + 我们又一次" ⇒ 勾上又立刻被取消（看起来像点了没反应），
 *      Enter 则会把行内按钮点一遍。这是这套动线最容易写错、也最难从截图上发现的一处。
 *   ② **没有当前行时的起点**：↓ 从第一行开始、↑ 从最后一行开始；都没有就什么都不做
 *      （不要"顺手选第一行" —— 用户只是在试按键，不该因此多一个落点）。
 *   ③ **首尾不环绕**：到底停住。环绕意味着"再按一下跳回顶部"，在长表里会让人瞬间失去位置感。
 *
 * ⚠️ 这里刻意**不**碰 `preventDefault` 之外的浏览器行为、不接 `Alt/Ctrl/⌘`（那些是全局快捷键的地盘），
 * 也不做撤销 —— ⌘Z 需要一层撤销栈，属独立一轮。
 */
import { nextTick, type ComputedRef, type Ref } from 'vue';

/** 一个按键算出来的意图。抽成纯函数是为了能单测：键盘的 bug 全在边界（空表 / 无当前行 / 首尾）。 */
export type RowKeyIntent =
  | { kind: 'move'; index: number }
  | { kind: 'toggle' }
  | { kind: 'open' };

/** 行 id：数字或字符串（订单侧是商品ID字符串，商品侧是自增数字）。`0` / `''` 表示"没有当前行"。 */
export type RowKey = string | number;

function isBlank(id: RowKey | null | undefined): boolean {
  return id === null || id === undefined || id === 0 || id === '';
}

/**
 * 纯函数：`key` + 行数 + 当前行下标 ⇒ 该做什么。
 * `index = -1` 表示"当前没有落在任何一行上"。
 */
export function resolveRowKey(key: string, count: number, index: number): RowKeyIntent | null {
  if (count <= 0) return null;
  const at = index < 0 ? -1 : Math.min(index, count - 1);
  switch (key) {
    case 'ArrowDown':
      return { kind: 'move', index: at < 0 ? 0 : Math.min(count - 1, at + 1) };
    case 'ArrowUp':
      return { kind: 'move', index: at < 0 ? count - 1 : Math.max(0, at - 1) };
    case ' ':
    case 'Spacebar': // 老 WebKit 的 key 值
      return at < 0 ? null : { kind: 'toggle' };
    case 'Enter':
      return at < 0 ? null : { kind: 'open' };
    default:
      return null;
  }
}

/**
 * 焦点是否落在一个"自己会吃按键"的元素上。
 * 命中即整条动线让路 —— 见文件头 ①。
 */
export function isKeyTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') {
    return true;
  }
  return node.isContentEditable === true;
}

export interface RowNavOptions<T, K extends RowKey> {
  /** 屏幕上**看得见**的那些行（分页 / 筛选之后的结果，不是全量）。可传 `computed` —— 只读也够用 */
  rows: Ref<T[]> | ComputedRef<T[]>;
  idOf: (row: T) => K;
  /** 当前行 id（表自己的状态，不是勾选态） */
  currentId: Ref<K>;
  /** 移动当前行 */
  onSelect: (id: K) => void;
  /**
   * 勾选 / 取消当前行。**没有勾选概念的表不要传**（如已认映射表：没有 checkbox、没有批量出口）。
   * 不传时 `Space` 整条交还给页面（滚动），而不是"抢下按键、然后什么也不做"——
   * 后者就是标准的"按了没反应"，而且按一次还少滚一屏。
   */
  onToggle?: (id: K) => void;
  onOpen: (id: K) => void;
  /** 找行元素（滚动用）。给不出来就只是不滚动，不影响其余行为。 */
  rowEl?: (id: K) => HTMLElement | null;
}

export function useRowNav<T, K extends RowKey>(opts: RowNavOptions<T, K>) {
  function reveal(id: K): void {
    // 认不出行元素就只是不滚动 —— 不拿"第一行"顶替（那会把当前行滚错位置，比不滚更糟）
    if (!opts.rowEl) return;
    // `block: 'nearest'`：已经在视口里就一动不动 —— 用 `center` 会把整张表上下跳。
    opts.rowEl(id)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(e: KeyboardEvent): void {
    // 全局快捷键（⌘K / ⌘Z / Ctrl 组合）不在这里抢
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isKeyTarget(e.target)) return;

    const list = opts.rows.value;
    const cur = opts.currentId.value;
    const index = isBlank(cur) ? -1 : list.findIndex((r) => opts.idOf(r) === cur);
    const intent = resolveRowKey(e.key, list.length, index);
    if (!intent) return;

    // 这张表没有勾选概念（没传 `onToggle`）⇒ Space 不接管：连 `preventDefault` 都不做，
    // 让页面照常滚。抢下按键再静默返回，用户会觉得"按键坏了"。
    if (intent.kind === 'toggle' && !opts.onToggle) return;

    // 先抢下按键再干活：Space 不抢会滚屏、Enter 不抢会触发外层默认动作
    e.preventDefault();

    if (intent.kind === 'move') {
      const next = opts.idOf(list[intent.index]);
      opts.onSelect(next);
      // 等 DOM 更新出 `.is-on` 再滚（行高由内容决定，算早了会差一两行）
      void nextTick(() => reveal(next));
      return;
    }

    if (isBlank(cur)) return;
    if (intent.kind === 'toggle') opts.onToggle?.(cur);
    else opts.onOpen(cur);
  }

  return { onKeydown };
}
