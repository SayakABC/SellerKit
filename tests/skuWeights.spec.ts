// tests/skuWeights.spec.ts
// `loadSkuWeights` 的**拉全**契约：产品库必须分页取完（单页 500），SKU 分批取（≤5000 个 id）。
// 背景（A7 / 2026-10-21 暴露）：原先只取产品列表前 500 款，第 501 款起静默变"缺克重"，
// 界面看起来像数据没维护。本文件用 vi.mock 替掉 ipc，只验取数范围；建键/折叠规则在 orderCost.spec.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  products: [] as Array<{ id: number; code: string }>,
  variants: [] as Array<{ productId: number; color: string; size: string; weightG: number }>,
  listCalls: [] as Array<{ offset: number; limit: number }>,
  variantCalls: [] as number[][],
  /** 第几次调用失败（1 起）；0 = 不失败 */
  failListCall: 0,
  failVariantCall: 0,
}));

vi.mock('@/core/services/ipc', () => ({
  productList: vi.fn(async (payload: { offset?: number; limit?: number } = {}) => {
    const offset = Number(payload.offset) || 0;
    const limit = Number(payload.limit) || 0;
    fake.listCalls.push({ offset, limit });
    if (fake.failListCall === fake.listCalls.length) {
      return { success: false, error: '读产品库失败' };
    }
    return {
      success: true,
      data: {
        rows: fake.products.slice(offset, offset + (limit || 50)).map((p) => ({ ...p })),
        total: fake.products.length,
      },
    };
  }),
  productVariantList: vi.fn(async (productIds: number[]) => {
    fake.variantCalls.push([...productIds]);
    if (fake.failVariantCall === fake.variantCalls.length) {
      return { success: false, error: '读 SKU 失败' };
    }
    const ids = new Set(productIds);
    return {
      success: true,
      data: { rows: fake.variants.filter((v) => ids.has(v.productId)).map((v) => ({ ...v })) },
    };
  }),
}));

import { loadSkuWeights } from '@/core/services/skuWeights';
import { skuWeightKey } from '@/lib/orderCost';

beforeEach(() => {
  fake.products = [];
  fake.variants = [];
  fake.listCalls = [];
  fake.variantCalls = [];
  fake.failListCall = 0;
  fake.failVariantCall = 0;
});

describe('loadSkuWeights: 拉全产品库', () => {
  it('第 2 页的款也能查到克重（不再卡在前 500 款）', async () => {
    fake.products = Array.from({ length: 620 }, (_, i) => ({ id: i + 1, code: `P${i + 1}` }));
    fake.variants = [{ productId: 620, color: '红色', size: 'M', weightG: 777 }];

    const map = await loadSkuWeights();

    expect(fake.listCalls.map((c) => c.offset)).toEqual([0, 500]);
    expect(map[skuWeightKey('P620', '红色', 'M')]).toBe(777);
  });

  it('SKU 按每批 ≤5000 个产品 id 取', async () => {
    fake.products = Array.from({ length: 5200 }, (_, i) => ({ id: i + 1, code: `P${i + 1}` }));
    fake.variants = [
      { productId: 1, color: '黑', size: 'L', weightG: 100 },
      { productId: 5200, color: '白', size: 'L', weightG: 200 },
    ];

    const map = await loadSkuWeights();

    expect(fake.variantCalls.map((ids) => ids.length)).toEqual([5000, 200]);
    expect(map[skuWeightKey('P1', '黑', 'L')]).toBe(100);
    expect(map[skuWeightKey('P5200', '白', 'L')]).toBe(200);
  });
});

describe('loadSkuWeights: 读失败如实置空', () => {
  it('产品分页中途失败 → 空表（不给半个表）', async () => {
    fake.products = Array.from({ length: 620 }, (_, i) => ({ id: i + 1, code: `P${i + 1}` }));
    fake.variants = [{ productId: 1, color: '黑', size: 'L', weightG: 100 }];
    fake.failListCall = 2;

    expect(await loadSkuWeights()).toEqual({});
    expect(fake.variantCalls).toEqual([]);
  });

  it('SKU 分批中途失败 → 空表', async () => {
    fake.products = Array.from({ length: 5200 }, (_, i) => ({ id: i + 1, code: `P${i + 1}` }));
    fake.failVariantCall = 2;

    expect(await loadSkuWeights()).toEqual({});
  });
});
