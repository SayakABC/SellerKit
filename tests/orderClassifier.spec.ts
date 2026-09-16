// orderClassifier 单测 —— 列自动探测决定"哪一列被当作主图/订单号/时间"，
// 探错列不会报错，只会把无关文本当订单号入库；颜色/款式归一化决定后续是否误合并。
import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  normalizeColor,
  normalizeCategory,
  CATEGORY_WHITELIST,
  detectImageColumn,
  detectOrderNoColumn,
  detectShopColumn,
  detectSizeColumn,
  detectOrderTimeColumn,
  classifyResult,
} from '../src/lib/orderClassifier';

describe('normalizeText / normalizeColor', () => {
  it('去掉内部空白', () => {
    expect(normalizeText(' 圆领  白 ')).toBe('圆领白');
  });

  it('颜色同义词归并到统一名称', () => {
    expect(normalizeColor('黑')).toBe('黑色');
    expect(normalizeColor('白')).toBe('白色');
    expect(normalizeColor('深蓝')).toBe('藏蓝');
    expect(normalizeColor('多色')).toBe('印花');
  });

  it('未收录的颜色原样保留（不强行归类）', () => {
    expect(normalizeColor('荧光橙')).toBe('荧光橙');
  });

  it('空值返回空串', () => {
    expect(normalizeColor('')).toBe('');
    expect(normalizeColor('   ')).toBe('');
  });
});

describe('normalizeCategory', () => {
  it('命中白名单时归并大小写与全角变体', () => {
    expect(normalizeCategory('短袖T恤')).toBe('短袖T恤');
    expect(normalizeCategory('短袖t恤')).toBe('短袖T恤');
    expect(normalizeCategory('短袖Ｔ恤')).toBe('短袖T恤');
  });

  it('命中别名映射时替换为标准名', () => {
    expect(normalizeCategory('t恤')).toBe('短袖T恤');
    expect(normalizeCategory('TEE')).toBe('短袖T恤');
    expect(normalizeCategory('套头衫')).toBe('卫衣');
    expect(normalizeCategory('阔腿裤')).toBe('长裤');
  });

  it('空值语义的识别结果统一清空', () => {
    for (const v of ['', '  ', '无', '未知', '未识别', '其他', 'None', 'NULL', 'undefined', '-']) {
      expect(normalizeCategory(v)).toBe('');
    }
  });

  it('未命中白名单/别名时保留原词', () => {
    expect(normalizeCategory('连衣裙')).toBe('连衣裙');
    expect(normalizeCategory('汉服')).toBe('汉服');
  });

  it('白名单每一项都能被自身命中——唯一例外「其他」属空值语义，归一化为空串', () => {
    for (const c of CATEGORY_WHITELIST) {
      if (c === '其他') {
        expect(normalizeCategory(c)).toBe('');
        continue;
      }
      expect(normalizeCategory(c)).toBe(c);
    }
  });

  it('「其他」同时出现在白名单与空值语义清单里，按"空值"优先（白名单该项不可达）', () => {
    // CATEGORY_WHITELIST 用于与 VISION_PROMPT 的模型选项保持同源（镜像作用），
    // 而 EMPTY_LIKE 里的「其他」表达"没识别出来" → 归一化为 ''，不参与款式指纹。
    // 两者重叠是有意的取舍，但容易让后来者误以为白名单漏映射，故在此显式固化。
    expect(normalizeCategory('其他')).toBe('');
    expect(normalizeCategory(' 其他 ')).toBe('');
  });
});

describe('列自动探测', () => {
  const headers = ['图片链接', '订单编号', '店铺名称', '尺码', '下单时间', '产品数量'];

  it('按关键词优先级命中并返回原始列名', () => {
    expect(detectOrderNoColumn(headers)).toBe('订单编号');
    expect(detectShopColumn(headers)).toBe('店铺名称');
    expect(detectSizeColumn(headers)).toBe('尺码');
    expect(detectOrderTimeColumn(headers)).toBe('下单时间');
  });

  it('匹配不区分大小写', () => {
    expect(detectOrderNoColumn(['ORDER_NO'])).toBe('ORDER_NO');
    expect(detectImageColumn(['Image URL'])).toBe('Image URL');
  });

  it('主图列无命中时回落第一列；其余探测无命中返回空串', () => {
    expect(detectImageColumn(['图片URL', '其他'])).toBe('图片URL');
    expect(detectImageColumn(['随机1', '随机2'])).toBe('随机1');
    expect(detectOrderNoColumn(['随机1', '随机2'])).toBe('');
  });

  it('关键词优先级高于列顺序（订单号先于单号）', () => {
    expect(detectOrderNoColumn(['单号备注', '订单号'])).toBe('订单号');
  });

  it('空表头数组安全返回空串', () => {
    expect(detectOrderNoColumn([])).toBe('');
    expect(detectShopColumn([])).toBe('');
  });
});

describe('classifyResult', () => {
  it('对四类字段一次性归一化', () => {
    expect(
      classifyResult({ category: 't恤', color: '白', logo: ' Nike ', styleName: ' 圆领 条纹 ' }),
    ).toEqual({ category: '短袖T恤', color: '白色', logo: 'Nike', styleName: '圆领条纹' });
  });

  it('styleName 缺失时返回空串', () => {
    expect(classifyResult({ category: '', color: '', logo: '' }).styleName).toBe('');
  });
});
