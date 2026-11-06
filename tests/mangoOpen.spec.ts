// tests/mangoOpen.spec.ts
// 「打开芒果的哪个列表页」这件事的守卫。
//
// 为什么值得单测：这个模块的**全部内容就是两个字符串**，而写错它不会有任何报错 ——
// 按钮照样能点、窗口照样弹出来，只是打开的是另一个列表（用户看到的仍然是"芒果"，
// 会以为是芒果的问题）。最现实的错法是「复制待发货那一行、忘了改路径段」，
// 所以断言的重点不是"等于某个字面量"，而是**两个地址必须指向两个不同的列表**。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openExternal: vi.fn(), toast: vi.fn() }));
vi.mock('@/core/services/ipc', () => ({ openExternal: h.openExternal }));
vi.mock('@/core/services/toast', () => ({ toast: h.toast }));

import {
  MANGO_PENDING_URL,
  MANGO_SHIPPED_URL,
  openMangoPending,
  openMangoShipped,
} from '../src/modules/today/mangoOpen';

beforeEach(() => {
  h.openExternal.mockReset();
  h.toast.mockReset();
});

describe('两个芒果列表地址', () => {
  it('同源、都走 hash 路由（换了域名就是打开别的系统，而用户不会察觉）', () => {
    for (const u of [MANGO_PENDING_URL, MANGO_SHIPPED_URL]) {
      const url = new URL(u);
      expect(url.origin).toBe('https://www.mangoerp.com');
      expect(url.hash.startsWith('#/erp/order/')).toBe(true);
      expect(u).not.toMatch(/\s/);
    }
  });

  it('**必须是两个不同的列表**：待发货走 order/list，已发货走 order/shipment', () => {
    // 这条是整份用例的主守卫。复制粘贴忘改路径 ⇒ 两个常量相等（或模块段相同）⇒ 这里红。
    expect(MANGO_SHIPPED_URL).not.toBe(MANGO_PENDING_URL);
    expect(MANGO_PENDING_URL).toContain('/erp/order/list/search/');
    expect(MANGO_SHIPPED_URL).toContain('/erp/order/shipment/search/');
  });

  it('已发货的筛选段解码后是「已发货/delivered」（百分号编码写坏会静默落到别的筛选）', () => {
    const hash = decodeURIComponent(new URL(MANGO_SHIPPED_URL).hash);
    expect(hash).toContain('/status/已发货/delivered');
    // 中文与英文码必须成对出现：只改一个（比如照抄成 status/已发货/normal）会打开另一个筛选
    expect(hash).not.toContain('/normal');
  });

  it('待发货的筛选段是「正常/normal」（与扩展抓取同源，改了就抓错批）', () => {
    const hash = decodeURIComponent(new URL(MANGO_PENDING_URL).hash);
    expect(hash).toContain('/status/正常/normal');
  });
});

describe('打开失败必须说出来（这一步失败的唯一表现就是"没反应"）', () => {
  it('成功：返回 true，不弹提示', async () => {
    h.openExternal.mockResolvedValue({ success: true });
    await expect(openMangoShipped()).resolves.toBe(true);
    expect(h.openExternal).toHaveBeenCalledWith(MANGO_SHIPPED_URL);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('系统拒绝：返回 false，且提示里说清是「已发货」页 + 原因', async () => {
    h.openExternal.mockResolvedValue({ success: false, error: 'no browser' });
    await expect(openMangoShipped()).resolves.toBe(false);
    const [msg, kind] = h.toast.mock.calls[0]!;
    expect(msg).toContain('已发货');
    expect(msg).toContain('no browser');
    expect(kind).toBe('error');
  });

  it('抛异常：同样返回 false 并有提示（不许把异常吞掉留一个没反应的按钮）', async () => {
    h.openExternal.mockRejectedValue(new Error('boom'));
    await expect(openMangoShipped()).resolves.toBe(false);
    expect(String(h.toast.mock.calls[0]![0])).toContain('boom');
  });

  it('两个入口各打各的地址（共用一份失败处理，但不能共用地址）', async () => {
    h.openExternal.mockResolvedValue({ success: true });
    await openMangoPending();
    await openMangoShipped();
    expect(h.openExternal.mock.calls.map((c) => c[0])).toEqual([MANGO_PENDING_URL, MANGO_SHIPPED_URL]);
  });
});
