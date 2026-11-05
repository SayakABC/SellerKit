// 表格键盘动线 × 按键意图解析 —— 钉住"手不离键"里最容易写错的四个边界。
//
// 背景（2026-11-03 界面方案 §6）：这套软件一天用很多次、每次做同样几件事，
// 效率天花板在键盘上。但键盘行为的 bug **从截图上永远看不出来** —— 它只在
// "按了没反应"或"按了反应两次"的时候才现身，而这两种都很难被复现出来描述。
//
// 所以把"按键 ⇒ 该做什么"抽成纯函数（`resolveRowKey`）在这里逐条钉：
//   ① 空表：任何键都不做事（不是"选中第一行"）；
//   ② 没有当前行：↓ 从第一行、↑ 从最后一行开始；**Space / Enter 不做事**
//      —— 用户只是在试按键，不该因此多出一个落点（那会顺手勾上一行）；
//   ③ 首尾不环绕：到底停住（环绕会让人在长表里瞬间失去位置感）；
//   ④ 下标越界（筛选后行变少、当前行还没被清掉）不能算出负数或抛异常。
//
// ⚠️ 另有一条与它配套、但只能在真产物里验的：焦点在行内 checkbox / 按钮上时**不接管**
//    （不判的话 Space 会"原生切换 + 又一次"⇒ 勾上又立刻取消，看起来像点了没反应）。
//    那条在 `scripts/goods-ui-smoke.mjs` 里用真 keydown 验，本文件只守纯函数部分
//    （`isKeyTarget` 的判据在这里单测，DOM 传入的是最小假对象）。
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { resolveRowKey, isKeyTarget, useRowNav } from '@/core/composables/useRowNav';

describe('按键 ⇒ 意图：空表', () => {
  it('没有行时任何键都不做事（不"顺手选第一行"）', () => {
    for (const key of ['ArrowDown', 'ArrowUp', ' ', 'Spacebar', 'Enter']) {
      expect(resolveRowKey(key, 0, -1), key).toBeNull();
    }
  });
});

describe('按键 ⇒ 意图：还没有当前行', () => {
  it('↓ 从第一行开始，↑ 从最后一行开始（两个方向都该"进得来"）', () => {
    expect(resolveRowKey('ArrowDown', 5, -1)).toEqual({ kind: 'move', index: 0 });
    expect(resolveRowKey('ArrowUp', 5, -1)).toEqual({ kind: 'move', index: 4 });
  });

  it('Space / Enter 在没有当前行时**不做事**（否则一次试按键就勾上了一行）', () => {
    expect(resolveRowKey(' ', 5, -1)).toBeNull();
    expect(resolveRowKey('Spacebar', 5, -1)).toBeNull();
    expect(resolveRowKey('Enter', 5, -1)).toBeNull();
  });
});

describe('按键 ⇒ 意图：移动', () => {
  it('↓ / ↑ 各走一行', () => {
    expect(resolveRowKey('ArrowDown', 5, 1)).toEqual({ kind: 'move', index: 2 });
    expect(resolveRowKey('ArrowUp', 5, 3)).toEqual({ kind: 'move', index: 2 });
  });

  it('首尾**不环绕**：到底就停在原地（返回值仍是那一个下标，不是 null）', () => {
    expect(resolveRowKey('ArrowDown', 5, 4)).toEqual({ kind: 'move', index: 4 });
    expect(resolveRowKey('ArrowUp', 5, 0)).toEqual({ kind: 'move', index: 0 });
  });

  it('下标越界（筛选后行变少）收敛到合法范围，不返回负数', () => {
    // 当前行 id 还挂在第 9 行上，但列表只剩 3 行
    expect(resolveRowKey('ArrowDown', 3, 9)).toEqual({ kind: 'move', index: 2 });
    expect(resolveRowKey('ArrowUp', 3, 9)).toEqual({ kind: 'move', index: 1 });
    expect(resolveRowKey(' ', 3, 9)).toEqual({ kind: 'toggle' });
  });
});

describe('按键 ⇒ 意图：勾选与进入', () => {
  it('Space / Spacebar 都是勾选（老 WebKit 的 key 值是 Spacebar）', () => {
    expect(resolveRowKey(' ', 5, 2)).toEqual({ kind: 'toggle' });
    expect(resolveRowKey('Spacebar', 5, 2)).toEqual({ kind: 'toggle' });
  });

  it('Enter 是"进详情"', () => {
    expect(resolveRowKey('Enter', 5, 2)).toEqual({ kind: 'open' });
  });

  it('其余键一律不接管（Tab / Esc / 字母留给浏览器与全局快捷键）', () => {
    for (const key of ['Tab', 'Escape', 'a', 'ArrowLeft', 'ArrowRight', 'PageDown']) {
      expect(resolveRowKey(key, 5, 2), key).toBeNull();
    }
  });
});

describe('焦点让路：行内控件自己会吃按键', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, isContentEditable: false, ...extra }) as unknown as HTMLElement;

  it('输入类 / 按钮 / 链接 ⇒ 让路（否则 Space 勾上又被原生切回去）', () => {
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']) {
      expect(isKeyTarget(el(tag)), tag).toBe(true);
    }
  });

  it('可编辑容器同样让路', () => {
    expect(isKeyTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('表格本体 / 行 / 单元格 ⇒ 不接管是错的（这些正是动线的宿主）', () => {
    for (const tag of ['TABLE', 'TBODY', 'TR', 'TD', 'DIV', 'SPAN']) {
      expect(isKeyTarget(el(tag)), tag).toBe(false);
    }
  });

  it('拿不到元素（null / 无 tagName）不抛，按"不让路"处理', () => {
    expect(isKeyTarget(null)).toBe(false);
    expect(isKeyTarget({} as unknown as EventTarget)).toBe(false);
  });
});

/*
 * 「没有勾选概念的表」：已认映射表（`PoolPane` 右栏）没有 checkbox、也没有批量出口。
 *
 * 那里的 `Space` 必须**整条交还页面**（照常滚动），而不是"抢下按键、然后什么也不做"。
 * 后者有两个可观察的坏处：按一次少滚一屏（用户以为键盘坏了），
 * 而且一旦哪天有人补上 `onToggle`，行为会从"没反应"直接变成"勾上了"，
 * 中间没有任何"这张表不支持勾选"的痕迹。
 *
 * ⚠️ 三条必须成对写：只断言"Space 什么也没做"的话，把整段 `onKeydown` 删掉也全绿。
 */
describe('没有 onToggle 的表：Space 交还页面，其余照旧', () => {
  function setup() {
    const rows = ref([{ id: 11 }, { id: 22 }, { id: 33 }]);
    const currentId = ref(0);
    const calls: string[] = [];
    const nav = useRowNav({
      rows,
      idOf: (r) => r.id,
      currentId,
      onSelect: (id) => {
        currentId.value = id;
        calls.push('select:' + id);
      },
      // 刻意**不传** onToggle
      onOpen: (id) => calls.push('open:' + id),
    });
    function press(key: string) {
      let prevented = false;
      const e = {
        key,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as KeyboardEvent;
      nav.onKeydown(e);
      return prevented;
    }
    return { rows, currentId, calls, press };
  }

  it('Space 不接管：不 preventDefault、不调任何回调', () => {
    const t = setup();
    t.press('ArrowDown'); // 先有当前行 —— 没有当前行时 Space 本来就不做事，那样测不出这条
    expect(t.currentId.value).toBe(11);
    t.calls.length = 0;

    expect(t.press(' '), 'Space 不该 preventDefault（页面要照常滚）').toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.currentId.value).toBe(11);
  });

  it('同一张表 Enter 仍然进详情（证明上面那条不是"整条 onKeydown 没接上"）', () => {
    const t = setup();
    t.press('ArrowDown');
    t.calls.length = 0;
    expect(t.press('Enter')).toBe(true);
    expect(t.calls).toEqual(['open:11']);
  });

  it('同一张表 ↑ / ↓ 仍然移动当前行', () => {
    const t = setup();
    t.press('ArrowDown');
    t.press('ArrowDown');
    expect(t.currentId.value).toBe(22);
    t.press('ArrowUp');
    expect(t.currentId.value).toBe(11);
  });
});
