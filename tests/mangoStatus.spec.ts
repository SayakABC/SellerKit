// 发货台状态分桶的契约用例（M2 / T2-1）。
//
// 这一层只有一个职责：**这单现在轮到我动手了吗**。它错了不会报错，只会让数字安静地偏大或偏小：
//   · 把「已发货/在途」算进待发 ⇒ 「今天要发 8 单」里混着已经在路上的单，数字永远对不上真相；
//   · 把认不出的状态算进待发 ⇒ 清单里会出现永远不会消失的行（那单可能早就关闭了）；
//   · 把「待发货」算进已结束 ⇒ 该发的单从清单里消失，最坏是漏发。
//
// 所以断言分三层：
//   ① 8 种真实原文全覆盖（每种落到唯一的桶）；
//   ② **未知值必须落 `unknown`，不许落 `pending`** —— 这条是变异测试的重点；
//   ③ 与 `orderCost.bucketOfStatus`（利润/拣货口径）在"结束/取消"上必须一致：
//      两个口径对"这单结束了没"判断不同的话，拣货单说"不用拣"而发货台说"要发"，人只会信一个。
import { describe, expect, it } from 'vitest';
import {
  MANGO_BUCKET_LABELS,
  isWaitingShip,
  mangoBucketOf,
  mangoStatusLabel,
  type MangoBucket,
} from '../src/lib/mangoStatus';
import { bucketOfStatus } from '../src/lib/orderCost';

describe('mangoStatus：状态原文 → 分桶', () => {
  /** 真实出现过的原文（芒果 `cnOrderStatus`）+ 平台英文码 `orderStatus` */
  const CASES: [string, MangoBucket][] = [
    ['等待卖家发货', 'pending'],
    ['待发货', 'pending'],
    ['待卖家发货', 'pending'],
    ['部分发货', 'shipped'],
    ['已发货', 'shipped'],
    ['运输中', 'shipped'],
    ['待收货', 'shipped'],
    ['交易成功', 'finished'],
    ['已完成', 'finished'],
    ['已关闭', 'cancelled'],
    ['已取消', 'cancelled'],
    ['退款中', 'cancelled'],
    // 英文码（`orderStatus`；录入时是大写下划线）
    ['WAIT_SELLER_SEND_GOODS', 'pending'],
    ['SELLER_PART_SEND_GOODS', 'shipped'],
    ['FINISH', 'finished'],
    ['CANCEL', 'cancelled'],
  ];

  for (const [raw, want] of CASES) {
    it(`${raw} → ${want}`, () => {
      expect(mangoBucketOf(raw)).toBe(want);
    });
  }

  it('空值 / 非字符串 → unknown（不是 pending）', () => {
    expect(mangoBucketOf('')).toBe('unknown');
    expect(mangoBucketOf('   ')).toBe('unknown');
    expect(mangoBucketOf(null)).toBe('unknown');
    expect(mangoBucketOf(undefined)).toBe('unknown');
    expect(mangoBucketOf({})).toBe('unknown');
  });

  it('认不出的原文 → unknown，**绝不落 pending**', () => {
    for (const raw of ['待核对', '异常', '风控审核中', 'SOMETHING_NEW', '买家申请修改地址']) {
      expect(mangoBucketOf(raw), `${raw} 不该被当成待发货`).toBe('unknown');
    }
  });

  it('前后空白不影响判定（采集帧里带空格是常态）', () => {
    expect(mangoBucketOf('  等待卖家发货  ')).toBe('pending');
  });

  it('「待收货」不许被判成待发货（含"待"字，顺序错了就中招）', () => {
    expect(mangoBucketOf('等待买家收货')).toBe('shipped');
    expect(isWaitingShip('等待买家收货')).toBe(false);
  });
});

describe('mangoStatus：与利润/拣货口径的一致性', () => {
  // 两个口径可以**分桶不同**（发货台要区分待发/在途，利润不用），但对"这单结束了没"必须一致。
  const SAMPLE = [
    '已关闭',
    '已取消',
    '退款中',
    '交易成功',
    '已完成',
    '等待卖家发货',
    '待发货',
    '已发货',
    '部分发货',
    '待收货',
    '不认识的字符串',
    '',
  ];

  it('利润口径说 closed ⇒ 发货台必须说 cancelled；说 completed ⇒ 必须说 finished', () => {
    for (const raw of SAMPLE) {
      const profit = bucketOfStatus(raw);
      const shop = mangoBucketOf(raw);
      if (profit === 'closed') {
        expect(shop, `${raw}：利润口径判了关闭，发货台却给了 ${shop}`).toBe('cancelled');
      }
      if (profit === 'completed') {
        expect(shop, `${raw}：利润口径判了完成，发货台却给了 ${shop}`).toBe('finished');
      }
    }
  });

  it('发货台说待发 ⇒ 利润口径不许说已关闭/已完成（否则拣货单不拣、发货台要发）', () => {
    for (const raw of SAMPLE) {
      if (mangoBucketOf(raw) !== 'pending') continue;
      const profit = bucketOfStatus(raw);
      expect(['closed', 'completed']).not.toContain(profit);
    }
  });
});

describe('mangoStatus：界面接口', () => {
  it('每个桶都有中文标签（少一个界面就会显示 undefined）', () => {
    const buckets: MangoBucket[] = ['pending', 'shipped', 'finished', 'cancelled', 'unknown'];
    for (const b of buckets) {
      expect(MANGO_BUCKET_LABELS[b], `${b} 缺文案`).toBeTruthy();
    }
  });

  it('mangoStatusLabel 直接给可显示的词', () => {
    expect(mangoStatusLabel('等待卖家发货')).toBe('待发货');
    expect(mangoStatusLabel('随便什么')).toBe('未知状态');
  });

  it('isWaitingShip 只认 pending', () => {
    expect(isWaitingShip('待发货')).toBe(true);
    expect(isWaitingShip('已发货')).toBe(false);
    expect(isWaitingShip('')).toBe(false);
  });
});
