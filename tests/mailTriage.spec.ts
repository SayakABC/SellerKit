// tests/mailTriage.spec.ts
// 「邮件 · 待办」判定守卫（2026-11-04）。
//
// 守的是什么：
//   ① 三类待办的判定只认主题，且**顺序敏感**——"未付款关单"必须被排除，
//      否则它会落到下面的通用"关闭"规则上，256 封自动关单会瞬间淹没待办；
//   ② 订单号解析必须**先掐 CaseNo / Service No**：那些也是 15–16 位纯数字，
//      一旦主题没有单号就会把客服单号当成订单号，而且**看起来完全正常**（不报错、格式也对）；
//   ③ 取不到单号时宁可返回空，也不从正文里随便抓一个长数字（物流单号 / 电话）。
//
// 夹具取自本机真实邮件（2026-11-04 快照），不是编的。

import { describe, expect, it } from 'vitest';
import { classifyMailTodo, extractOrderNo, isTodoSuppressed } from '../electron/mail-triage-rules';

describe('classifyMailTodo · 三类待办判定', () => {
  it('罚单待处理 → penalty / 3（有申诉期，最高优先级）', () => {
    const r = classifyMailTodo('违背发货承诺订单预扣罚单待处理');
    expect(r?.kind).toBe('penalty');
    expect(r?.severity).toBe(3);
  });

  it('罚单申诉失败 → penalty / 2（已成事实，但仍要核对处罚）', () => {
    const r = classifyMailTodo('违背发货承诺订单预扣罚单申诉失败');
    expect(r?.kind).toBe('penalty');
    expect(r?.severity).toBe(2);
  });

  it('纠纷处理结果 → dispute / 2', () => {
    const r = classifyMailTodo('订单3077221327626784纠纷处理结果');
    expect(r?.kind).toBe('dispute');
    expect(r?.severity).toBe(2);
  });

  it('仲裁判决 → dispute / 2', () => {
    expect(classifyMailTodo('NR老仲裁-判决-卖家邮件')?.kind).toBe('dispute');
  });

  it('英文 Resolution for Order 也算纠纷结论', () => {
    expect(classifyMailTodo('Resolution for Order 3077090273647695')?.kind).toBe('dispute');
  });

  it('卖家未发货关单 → closed / 2（履约事故，比协议取消重）', () => {
    const r = classifyMailTodo('订单1123236682794896，卖家未发货订单关闭');
    expect(r?.kind).toBe('closed');
    expect(r?.severity).toBe(2);
  });

  it('协议取消关单 → closed / 1（仅知会）', () => {
    const r = classifyMailTodo('订单3077947352804002关闭');
    expect(r?.kind).toBe('closed');
    expect(r?.severity).toBe(1);
  });

  // ↓ 这条是整张规则表最容易写错的地方：少了排除项，它会落到通用"关闭"上变成待办
  it('买家未付款自动关单 **不进待办**（不会被通用"关闭"规则吃掉）', () => {
    expect(classifyMailTodo('订单1123344116854443，买家未付款订单关闭')).toBeNull();
    expect(classifyMailTodo('订单8215268080271096，买家未付款订单关闭')).toBeNull();
  });

  it('订单流水通知一律不进待办', () => {
    const noise = [
      '您有一张新订单3077653086000493',
      '订单1123197878735490，买家确认收到货物',
      '订单已通过风控审核，您可以开始发货',
      '您的AliExpress验证码',
    ];
    for (const s of noise) expect(classifyMailTodo(s), s).toBeNull();
  });

  it('空主题不抛异常', () => {
    expect(classifyMailTodo('')).toBeNull();
    expect(classifyMailTodo(undefined as unknown as string)).toBeNull();
  });
});

describe('extractOrderNo · 订单号解析', () => {
  it('主题带"订单"前缀', () => {
    expect(extractOrderNo('订单8215474754094252关闭')).toEqual({
      orderNo: '8215474754094252',
      source: 'subject',
    });
  });

  it('主题裸号（"您有一张新订单3077…"）', () => {
    expect(extractOrderNo('您有一张新订单3077653086000493').orderNo).toBe('3077653086000493');
  });

  it('主题无单号 → 从正文取（纠纷邮件就是这样）', () => {
    const html = '<p>尊敬的Store，订单3077221327626784的纠纷已处理完成。</p>';
    expect(extractOrderNo('订单3077221327626784纠纷处理结果', '')).toMatchObject({
      orderNo: '3077221327626784',
      source: 'subject',
    });
    expect(extractOrderNo('Resolution for Order', html)).toMatchObject({
      orderNo: '3077221327626784',
      source: 'body',
    });
  });

  // ↓ 核心陷阱：正文里同时有订单号和 16 位 CaseNo，取第一个长数字就错了
  it('正文里 16 位 CaseNo 不会被当成订单号', () => {
    const html = `
      <p>订单号3077090273647695的请求已处理完毕。</p>
      <p>Your current Service No. is:#CaseNo:1143809062350955#</p>`;
    expect(extractOrderNo('Resolution for Order 3077090273647695', html).orderNo).toBe('3077090273647695');

    // 主题**完全没有**单号时，也必须是订单号而不是 CaseNo
    const onlyBody = `<p>订单号3077090273647695 已处理</p><p>#CaseNo:1143809062350955#</p>`;
    expect(extractOrderNo('Resolution for Order', onlyBody)).toEqual({
      orderNo: '3077090273647695',
      source: 'body',
    });
  });

  it('正文只有 CaseNo 时返回空，不瞎猜', () => {
    expect(extractOrderNo('Resolution for Order', '<p>#CaseNo:1143809062350955#</p>')).toEqual({
      orderNo: '',
      source: 'none',
    });
  });

  it('正文里不带"订单"前缀的长数字不取（可能是物流号/电话）', () => {
    expect(extractOrderNo('Some notice', '<p>Tracking 123456789012345 freight</p>').source).toBe('none');
  });

  it('17 位串里不截 15–16 位出来', () => {
    expect(extractOrderNo('编号 12345678901234567 的记录', '').source).toBe('none');
  });

  it('标签把数字切开也能取到（正文按纯文本再匹配）', () => {
    const html = '<p>订单号<span>3077</span><b>091357151838</b> 已处理</p>';
    expect(extractOrderNo('Resolution for Order', html).orderNo).toBe('3077091357151838');
  });
});

// 「手工划掉」的水位线判定（2026-11-05）。
// 单独提成纯函数来守，是因为这一处写反了**两个方向都是静默的**：
// 写成 `<` ⇒ 划掉的那封自己漏出来（用户以为没生效，反复点）；
// 写成"永久压住" ⇒ 罚单升级、纠纷判决被吞掉（用户以为没事，实际在扣钱）。
describe('isTodoSuppressed · 划掉记号的水位线', () => {
  it('划掉的那一封（id 相等）被压住', () => {
    expect(isTodoSuppressed(11, 11)).toBe(true);
  });

  it('划掉之前的历史邮件也被压住', () => {
    expect(isTodoSuppressed(11, 9)).toBe(true);
  });

  it('划掉之后来了新邮件（id 更大）⇒ 浮出', () => {
    expect(isTodoSuppressed(11, 12)).toBe(false);
  });

  it('水位线为 0（脏数据）压不住任何真实邮件', () => {
    expect(isTodoSuppressed(0, 1)).toBe(false);
  });

  it('入参不是数字时按 0 处理，不抛异常', () => {
    expect(isTodoSuppressed(Number.NaN, 3)).toBe(false);
    expect(isTodoSuppressed(11, Number.NaN)).toBe(true);
  });
});
