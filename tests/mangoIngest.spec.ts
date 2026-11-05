import { describe, expect, it } from 'vitest';
import {
  buildShopMatchIndex,
  mangoCents,
  mangoLabels,
  mangoTime,
  matchShop,
  toInternal,
} from '../electron/mango-ingest';

/**
 * 芒果帧 → 内部结构的守卫。
 *
 * 夹具形状**照抄真机抓包**（`SellerKitExtensions/tests/fixtures/mango-search.sample.json` 的
 * 字段名与取值形态），但这里内联构造 —— 只为能造出边界（缺字段 / 塌陷 / 空明细），
 * 而端到端那条线由 `scripts/mango-ingest-smoke.cjs` 吃**真实完整帧**，两者互补。
 *
 * 断言原则：每一条都成对（该收的收、该拒的拒、该空的是空），单边断言等于没断言。
 */

/** 真实响应里的一单（字段名逐个照抄，含毫秒时间戳与结构化 attrMap） */
function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4186501874,
    orderId: '3077508596852457',
    site: 'ae',
    alias: '十店',
    countryCN: '英国（UK）',
    countryCode: 'UK',
    buyerName: 'Je**********',
    aeGmtCreate: 1793450497000,
    gmtPayTime: 1793450503000,
    payAmount: 127.48,
    sendGoodExpiredDate: 1794368451000,
    status: 'normal',
    labelMap: { normal: [{ color: '#1388bb', name: '72h时效考核订单', id: 1362457 }] },
    orderItemList: [
      {
        id: 5158288461,
        authId: '32958002',
        productId: '1005012742360018',
        productImgUrl:
          'https://ae-pic-a1.aliexpress-media.com/kf/Secda2766378947e8a88be790e6e5453cE.jpg',
        skuCode: '12000059187655796',
        productCount: 1,
        attrMap: { 'Ships From': 'China Mainland', Size: 'M', Color: '6' },
      },
    ],
    cnOrderStatus: '等待卖家发货',
    orderStatus: 'WAIT_SELLER_SEND_GOODS',
    authId: '32958002',
    weight: 0.7,
    aeInternetInfoDTO: {
      orderId: '3077508596852457',
      qualifiedTime: 1793850108746,
      timeoutType: 72,
    },
    ...over,
  };
}

describe('toInternal · 正常单', () => {
  it('一单一行：订单级字段、行级字段、两个时效时点全部落位', () => {
    const { order: d, reason, warnings } = toInternal(order());
    expect(reason).toBe('');
    expect(warnings).toEqual([]);
    expect(d).not.toBeNull();
    expect(d!.orderNo).toBe('3077508596852457');
    expect(d!.shop).toBe('十店');
    expect(d!.shopAuthId).toBe('32958002');
    expect(d!.bizStatus).toBe('等待卖家发货');
    expect(d!.amountCents).toBe(12748);
    expect(d!.lines).toHaveLength(1);
    const l = d!.lines[0];
    expect(l.itemId).toBe('1005012742360018');
    expect(l.color).toBe('6'); // attrMap 是结构化的，不需要解析规格文本
    expect(l.size).toBe('M');
    expect(l.skuCode).toBe('12000059187655796'); // 图案绑定的首选锚点
    expect(l.qty).toBe(1);
    expect(l.imageUrl).toContain('/kf/Secda2766378947e8a88be790e6e5453cE.jpg');
  });

  it('两个时效时点**都存**且**不相同**（实测差 6 天，核对前不替用户选）', () => {
    const d = toInternal(order()).order!;
    expect(d.dealDeadline).not.toBe('');
    expect(d.timeoutAt).not.toBe('');
    expect(d.dealDeadline).not.toBe(d.timeoutAt);
    // 具体值由 `mangoTime` 按本地时区格式化，这里钉"晚于付款时刻"这条语义
    expect(d.payTime < d.dealDeadline).toBe(true);
  });

  it('raw_fields 保真整帧 + 人要看的三项（目的地/标签/重量）', () => {
    const d = toInternal(order()).order!;
    const frame = JSON.parse(String(d.rawFields['采集帧']));
    expect(frame.orderId).toBe('3077508596852457');
    expect(d.rawFields['目的地国家']).toBe('UK');
    expect(d.rawFields['订单标签']).toBe('72h时效考核订单');
    expect(d.rawFields['重量kg']).toBe('0.7');
    // ⚠️ 行级字段不在这里加（一单多商品时加在这里会让整单的键塌成第一行的值）
    expect(d.rawFields['商品ID']).toBeUndefined();
    expect(d.rawFields['产品属性']).toBeUndefined();
  });
});

describe('toInternal · 扩展真正推的规整帧（2026-11-02 事故的回归）', () => {
  /**
   * 形状**照抄** `SellerKitExtensions/extensions/mango-order/src/mango-parse.js` 的 `toOrder` 输出：
   * `orderNo` / `shopName` / `shopAuthId` / `platformStatusCn` / 已格式化的本地时间串 /
   * `amountCents`（已经是分）/ `lines[]`（`itemId` + 行上 `color`/`size` + `imgUrl`）。
   *
   * 事故现场：宿主当时只认原始响应键名（`orderId` / `alias` / `orderItemList`），
   * 于是线上 4 单全部 `缺少 orderId` 被跳过，而 HTTP 仍是 `ok:true` ⇒ popup 显示"推送 成功（新 0 / 更新 0）"。
   */
  function extensionOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      orderNo: '3077508596852457',
      shopName: '十店',
      shopAuthId: '32958002',
      site: 'ae',
      orderTime: '2026-11-01 12:00:00',
      payTime: '2026-11-01 12:00:00',
      deadline: '2026-11-11 23:59:59',
      status: 'normal',
      platformStatus: 'WAIT_SELLER_SEND_GOODS',
      platformStatusCn: '等待卖家发货',
      currency: 'CNY',
      amountCents: 12748,
      labels: ['72h时效考核订单', '地址异常'],
      timeoutType: 72,
      timeoutAt: '2026-11-06 12:00:00',
      countryCode: 'UK',
      countryCn: '英国（UK）',
      weightGram: 700,
      lines: [
        {
          itemId: '1005012742360018',
          skuCode: '12000059187655796',
          skuKey: '',
          qty: 2,
          color: '6',
          size: 'M',
          shipsFrom: 'China Mainland',
          imgUrl: 'https://ae-pic-a1.aliexpress-media.com/kf/Secda2766378947e8a88be790e6e5453cE.jpg',
          title: '定制拖鞋',
          unitPriceCents: 6374,
          attrs: { Size: 'M', Color: '6' },
        },
      ],
      ...over,
    };
  }

  it('认规整帧的键名：单号 / 店 / 状态 / 金额 / 两个时效 / 明细全部落位', () => {
    const { order: d, reason, warnings } = toInternal(extensionOrder());
    expect(reason).toBe('');
    expect(warnings).toEqual([]);
    expect(d!.orderNo).toBe('3077508596852457');
    expect(d!.shop).toBe('十店');
    expect(d!.shopAuthId).toBe('32958002');
    expect(d!.bizStatus).toBe('等待卖家发货'); // platformStatusCn 优先，不是英文码
    // 扩展已经算好"分"，**不许再乘一次 100**（127.48 元 = 12748 分）
    expect(d!.amountCents).toBe(12748);
    // 扩展交的是格式化好的本地时间串，不能因为 mangoTime(字符串)=NaN 就整列变空
    for (const t of [d!.orderTime, d!.payTime, d!.dealDeadline, d!.timeoutAt]) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    expect(d!.payTime < d!.dealDeadline).toBe(true);
    expect(d!.lines).toHaveLength(1);
    const l = d!.lines[0];
    expect(l.itemId).toBe('1005012742360018');
    expect(l.skuCode).toBe('12000059187655796');
    expect(l.qty).toBe(2); // 规整帧是 qty，不是 productCount
    expect(l.color).toBe('6');
    expect(l.size).toBe('M');
    expect(l.imageUrl).toContain('/kf/Secda2766378947e8a88be790e6e5453cE.jpg'); // imgUrl
    // 人要看的三项：countryCn / labels[] / weightGram(克→千克)
    expect(d!.rawFields['目的地国家']).toBe('UK');
    expect(d!.rawFields['订单标签']).toBe('72h时效考核订单、地址异常');
    expect(d!.rawFields['重量kg']).toBe('0.700');
  });

  it('规整帧缺单号 ⇒ 拒绝，且原因同时点出两个键名（免得下次只改一半）', () => {
    for (const bad of [{}, { orderNo: '' }, { orderNo: '  ', orderId: '' }]) {
      const r = toInternal(bad);
      expect(r.order).toBeNull();
      expect(r.reason).toContain('orderId');
      expect(r.reason).toContain('orderNo');
    }
  });

  it('规整帧的币种非 CNY ⇒ 金额 null（即使扩展给了 amountCents 也不猜汇率）', () => {
    const r = toInternal(extensionOrder({ currency: 'USD', amountCents: 1850 }));
    expect(r.order!.amountCents).toBeNull();
    expect(r.warnings.join()).toContain('USD');
  });

  it('规整帧空明细 ⇒ 不拒绝（与原始帧同口径）', () => {
    const r = toInternal(extensionOrder({ lines: [] }));
    expect(r.order).not.toBeNull();
    expect(r.order!.lines).toHaveLength(0);
    expect(r.warnings.join()).toContain('明细为空');
  });
});

describe('toInternal · 拒绝与降级', () => {
  it('缺订单号 ⇒ 整帧拒绝（空单号会撞主表 UNIQUE，且无从合并）', () => {
    for (const bad of [{}, { orderId: '' }, { orderId: '   ' }, { orderId: null }]) {
      const r = toInternal(bad);
      expect(r.order).toBeNull();
      expect(r.reason).toContain('orderId');
    }
    expect(toInternal(null).order).toBeNull();
    expect(toInternal('字符串不是订单').order).toBeNull();
  });

  it('缺店名 ⇒ **不拒绝**，落未登记桶 + 给提示（认不出店是数据问题，不该让订单进不来）', () => {
    const r = toInternal(order({ alias: '' }));
    expect(r.order).not.toBeNull();
    expect(r.order!.shop).toBe('');
    expect(r.order!.shopAuthId).toBe('32958002'); // authId 还在，后续能补
    expect(r.warnings.join()).toContain('店铺别名为空');
  });

  it('空明细 ⇒ 不拒绝，插一行占位（订单数不能被帧的空误吞）', () => {
    const r = toInternal(order({ orderItemList: [] }));
    expect(r.order).not.toBeNull();
    expect(r.order!.lines).toHaveLength(0); // 占位行由 upsertCollectedOrder 补，本层不造假数据
    expect(r.warnings.join()).toContain('明细为空');
    // 明细字段不是数组（脏帧）同样当空处理，不抛
    expect(toInternal(order({ orderItemList: null })).order!.lines).toHaveLength(0);
    expect(toInternal(order({ orderItemList: 'x' })).order!.lines).toHaveLength(0);
  });

  it('币种非 CNY ⇒ 金额 null（缺汇率），不猜 1:1', () => {
    const r = toInternal(order({ currencyCode: 'USD', payAmount: 18.5 }));
    expect(r.order!.amountCents).toBeNull();
    expect(r.warnings.join()).toContain('USD');
    // 缺 payAmount 同样是 null，且**不是 0**
    const r2 = toInternal(order({ payAmount: null }));
    expect(r2.order!.amountCents).toBeNull();
    expect(r2.order!.amountCents).not.toBe(0);
  });
});

describe('toInternal · 色名塌陷链接', () => {
  it('同链接 3 行同色名（全 `Picture color`）但不同图 ⇒ 3 行都留、图各不同', () => {
    const mk = (n: number): Record<string, unknown> => ({
      productId: '1005012742360018',
      skuCode: `1200005918765579${n}`,
      productCount: 1,
      productImgUrl: `https://ae-pic-a1.aliexpress-media.com/kf/Saaa${n}.jpg`,
      attrMap: { Size: 'M', Color: 'Picture color' },
    });
    const r = toInternal(order({ orderItemList: [mk(1), mk(2), mk(3)] }));
    const d = r.order!;
    expect(d.lines).toHaveLength(3);
    expect(new Set(d.lines.map((l) => l.color)).size).toBe(1); // 色名确实塌陷成同一个
    expect(new Set(d.lines.map((l) => l.imageUrl)).size).toBe(3); // 图是唯一判别证据
    expect(new Set(d.lines.map((l) => l.skuCode)).size).toBe(3);
  });

  it('同 skuCode 的重复行合并（合并订单展开会产生重复），且**给提示**不静默', () => {
    const one = {
      productId: '1005012742360018',
      skuCode: '12000059187655796',
      productCount: 1,
      productImgUrl: 'https://x.aliexpress-media.com/kf/Saaa.jpg',
      attrMap: { Size: 'M', Color: '6' },
    };
    const r = toInternal(order({ orderItemList: [one, { ...one }] }));
    expect(r.order!.lines).toHaveLength(1);
    expect(r.warnings.join()).toContain('重复行被合并');
  });

  it('没有 skuCode 时按「商品ID+色+码」去重（宁可少一条重复，不要同一件货算两遍）', () => {
    const mk = (): Record<string, unknown> => ({
      productId: '1005',
      productImgUrl: 'https://x/kf/Saaa.jpg',
      attrMap: { Size: 'M', Color: '6' },
    });
    const d = toInternal(order({ orderItemList: [mk(), mk()] })).order!;
    expect(d.lines).toHaveLength(1);
  });
});

describe('mangoTime / mangoCents / mangoLabels', () => {
  it('毫秒与秒都认（两者差三个数量级，可确定分辨），认不出给空串不产 1970', () => {
    const ms = mangoTime(1793450497000);
    expect(ms).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(mangoTime(1793450497)).toBe(ms); // 同值的秒级写法 → 同一时刻
    for (const bad of [0, -1, null, undefined, '', 'abc', Number.NaN]) {
      expect(mangoTime(bad)).toBe('');
    }
    expect(mangoTime(1793450497000)).not.toContain('1970');
  });

  it('元→分：null 与 0 严格区分（"算不出"不能伪装成"零元"）', () => {
    expect(mangoCents(127.48)).toBe(12748);
    expect(mangoCents(0)).toBe(0); // 真的是 0 元单（赠品），不是缺失
    expect(mangoCents(null)).toBeNull();
    expect(mangoCents(undefined)).toBeNull();
    expect(mangoCents('')).toBeNull();
    expect(mangoCents('abc')).toBeNull();
    expect(mangoCents(44.635)).toBe(4464); // 浮点误差不产生 4463
  });

  it('标签展开成名字数组：多组去重、稳定排序、脏输入给空数组', () => {
    expect(
      mangoLabels({
        normal: [{ name: '72h时效考核订单' }],
        risk: [{ name: '地址异常' }, { name: '72h时效考核订单' }],
      }),
    ).toEqual(['72h时效考核订单', '地址异常'].sort());
    expect(mangoLabels(null)).toEqual([]);
    expect(mangoLabels({ normal: 'not-an-array' })).toEqual([]);
    expect(mangoLabels({ normal: [{}] })).toEqual([]);
  });
});

describe('matchShop · 认店顺序 authId → 店名 → 未登记桶', () => {
  const index = buildShopMatchIndex([
    { id: 1, name: '十店', erpShopId: '32958002' },
    { id: 2, name: '十一店' }, // 还没学到 authId
    { id: 3, name: '同名店' },
    { id: 4, name: '同名店' }, // 跨平台同名：按名匹配必须放弃
  ]);

  it('authId 命中优先于店名（名字改了也不掉桶）', () => {
    // 用户把芒果里的别名从「十店」改成了「十号店」—— 靠名字就认不出，靠 authId 稳
    const m = matchShop('十号店', '32958002', index);
    expect(m.shopId).toBe(1);
    expect(m.shop).toBe('十店'); // 写进订单的是**店铺规范名**，不是芒果别名
    expect(m.matchedBy).toBe('erp');
  });

  it('authId 没学到时按店名精确命中，并说明命中的路径', () => {
    const m = matchShop('十一店', '', index);
    expect(m.shopId).toBe(2);
    expect(m.shop).toBe('十一店');
    expect(m.matchedBy).toBe('name');
    // 脏字符/空格按 `toNameKey` 折叠后仍命中（与店铺归一同一口径）
    expect(matchShop(' 十一店\u200b', '', index).shopId).toBe(2);
  });

  it('同名两家店 ⇒ **不按名匹配**（取第一个就是把订单落给一个恰好同名的店）', () => {
    const m = matchShop('同名店', '', index);
    expect(m.shopId).toBe(0);
    expect(m.matchedBy).toBe('');
    expect(m.shop).toBe('同名店'); // 原文留着，店铺归一页才看得见"这家还没登记"
  });

  it('都认不出 ⇒ 未登记桶，不抛错、不猜一个店', () => {
    const m = matchShop('从未见过的店', '99999999', index);
    expect(m.shopId).toBe(0);
    expect(m.shop).toBe('从未见过的店');
    expect(m.matchedBy).toBe('');
    // 空店名同样是未登记（不是"命中第 0 家店"）
    expect(matchShop('', '', index).shopId).toBe(0);
  });

  it('一对多保护：同一个 authId 出现在两家店的行上时只认第一家（不覆盖已写的）', () => {
    const dup = buildShopMatchIndex([
      { id: 1, name: 'A', erpShopId: '777' },
      { id: 2, name: 'B', erpShopId: '777' },
    ]);
    expect(matchShop('B', '777', dup).shopId).toBe(1); // 确定性：取先出现的
  });

  it('退店/封店的店**照样认得出**（归属看下单那一刻，与店铺今天的经营状态无关）', () => {
    // 曾经按 `status='active'` 过滤过店铺清单，后果是退店前的残留单全部掉进未登记桶：
    // 订单上写芒果别名「八店」，库里那家店叫「八店-UK」，同一家店在统计里变两家。
    const withClosed = buildShopMatchIndex([
      { id: 10, name: '八店-UK', erpShopId: '4001', status: 'exited' },
      { id: 11, name: '十二店', erpShopId: '', status: 'banned' },
    ]);

    // ① authId 命中退店店 —— 不许落桶
    const byErp = matchShop('八店', '4001', withClosed);
    expect(byErp.shopId).toBe(10);
    expect(byErp.matchedBy).toBe('erp');
    expect(byErp.shop).toBe('八店-UK'); // 仍写规范名
    expect(byErp.shopStatus).toBe('exited'); // 状态**带出来**供上层计数，但不参与判定

    // ② 名字命中封店 —— 同上
    const byName = matchShop('十二店', '', withClosed);
    expect(byName.shopId).toBe(11);
    expect(byName.matchedBy).toBe('name');
    expect(byName.shopStatus).toBe('banned');

    // ③ 未命中时 shopStatus 是空串（不是"碰巧第一个店的状态"）
    expect(matchShop('没见过的店', '', withClosed).shopStatus).toBe('');

    // ④ 逐条对照：同一家店 active 与 exited 的匹配结果**必须完全一致**
    //   （除了 shopStatus）。这条守的是"状态永远不该改变归属"。
    const asActive = buildShopMatchIndex([{ id: 10, name: '八店-UK', erpShopId: '4001', status: 'active' }]);
    const asExited = buildShopMatchIndex([{ id: 10, name: '八店-UK', erpShopId: '4001', status: 'exited' }]);
    for (const [shop, erp] of [['八店', '4001'], ['八店-UK', ''], ['八店', '']] as const) {
      const x = matchShop(shop, erp, asActive);
      const y = matchShop(shop, erp, asExited);
      expect({ ...y, shopStatus: '' }).toEqual({ ...x, shopStatus: '' });
    }
  });
});
