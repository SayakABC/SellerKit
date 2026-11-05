// orderClassifier 单测 —— 列自动探测决定"哪一列被当作主图/订单号/时间"，
// 探错列不会报错，只会把无关文本当订单号入库；颜色/款式归一化决定后续是否误合并。
import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  normalizeColor,
  normalizeCategory,
  CATEGORY_WHITELIST,
  COLOR_WHITELIST,
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
    expect(normalizeColor('橙')).toBe('橙');
  });

  it('空值返回空串', () => {
    expect(normalizeColor('')).toBe('');
    expect(normalizeColor('   ')).toBe('');
  });

  // ---- 描述式（这是"两头打架"里被打坏的那一头）----
  // 每个分支都用**只有那条路能到达**的输入，避免"两条路互为兜底"时断言蒙对。
  describe('描述式颜色（底色+花色）只取底色', () => {
    it('「底」连接：藏蓝底白色条纹 → 藏蓝（只有分段能到，整串与前缀都认不出）', () => {
      expect(normalizeColor('藏蓝底白色条纹')).toBe('藏蓝');
    });

    it('深浅同义：黑底白条纹 → 黑色；深蓝底白点 → 藏蓝', () => {
      expect(normalizeColor('黑底白条纹')).toBe('黑色');
      expect(normalizeColor('深蓝底白点')).toBe('藏蓝');
    });

    it('`+` 分隔（提示词里定死的多色写法）→ 取底色', () => {
      expect(normalizeColor('白+黑')).toBe('白色');
      expect(normalizeColor('藏蓝+白')).toBe('藏蓝');
    });

    it('顿号 / 斜杠分隔同样按"底色在前"取第一段', () => {
      expect(normalizeColor('红、白')).toBe('红色');
      expect(normalizeColor('军绿/卡其')).toBe('军绿');
    });

    it('前缀回退：主色当短语开头时也认得出（白条纹 → 白色；军绿色 → 军绿）', () => {
      expect(normalizeColor('白条纹')).toBe('白色');
      expect(normalizeColor('军绿色')).toBe('军绿');
      expect(normalizeColor('藏蓝白条纹')).toBe('藏蓝');
    });

    it('⚠️ 不扫"任意位置"：灰蓝色按"主色在前"判成灰色，不是蓝色', () => {
      // 这条固化的是一条**取舍**：扫任意位置会把 灰蓝 → 蓝、粉绿 → 绿…全靠猜。
      // 认不出宁可原样保留（款色拆开，看得见、能改），也不要错并（两色合一色，最难发现）。
      expect(normalizeColor('灰蓝色')).toBe('灰色');
    });

    it('整段认不出仍原样保留（不做二次猜）', () => {
      expect(normalizeColor('香槟金')).toBe('香槟金');
      expect(normalizeColor('纯棉黑色')).toBe('纯棉黑色');
    });
  });
});

describe('COLOR_WHITELIST', () => {
  it('是标准色名的集合，且覆盖常用色（防"派生逻辑被换成残缺手写列表"）', () => {
    expect(COLOR_WHITELIST).toEqual(
      expect.arrayContaining(['黑色', '白色', '藏蓝', '粉色', '印花']),
    );
    // 至少 20 项：数量级塌掉说明值域被削过（词表与提示词枚举会一起变窄，模型没得选）
    expect(COLOR_WHITELIST.length).toBeGreaterThan(20);
  });

  it('每一项都能被自身归一命中（词表是"自洽"的 —— 否则提示词让模型选一个归不了的词）', () => {
    for (const c of COLOR_WHITELIST) {
      expect(normalizeColor(c)).toBe(c);
    }
  });

  it('无重复（派生用了 Set，但别让后来者改成数组字面量时漏掉）', () => {
    expect(new Set(COLOR_WHITELIST).size).toBe(COLOR_WHITELIST.length);
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
