import { onBeforeUnmount, onMounted, type Ref } from 'vue';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 弹层的键盘可达性：Esc 关闭 + Tab 焦点陷阱 + 关闭后焦点归位。
 *
 * 为什么集中成一个 composable：四个弹层（记一笔 / 结算 / 改挂 / 导入）此前都只是
 * `role="dialog"` 声明了模态，Tab 会跑到遮罩后面，Esc 完全没反应（审查 §5-11）。
 * 各写一遍必然只有一两个生效，所以这里只留一处实现。
 *
 * @param root 弹层根元素（`.wb-dialog`）
 * @param onClose 关闭回调；调用方自己决定 busy 时是否真的关（本函数据此不重复判断）
 */
export function useDialogA11y(root: Ref<HTMLElement | null>, onClose: () => void): void {
  let previous: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    const el = root.value;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      // `offsetParent === null` 覆盖 `display:none` 与折叠容器（照按钮的可见性判断）
      (n) => n.offsetParent !== null || n === document.activeElement
    );
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!root.value) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && (active === first || !active || !root.value.contains(active))) {
      e.preventDefault();
      last.focus();
    }
  }

  onMounted(() => {
    previous = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeydown, true);
    // 焦点进弹层：已经有焦点在里面（如记一笔自动聚焦金额框）就不抢
    if (!root.value?.contains(document.activeElement)) {
      const first = focusables()[0];
      if (first) first.focus();
      else root.value?.focus();
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true);
    // 焦点归位：否则键盘用户关掉弹层后停在 body 上，得从头 Tab 一遍
    previous?.focus?.();
  });
}
