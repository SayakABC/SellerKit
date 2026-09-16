// templateEngine 单测 —— 占位符替换是"静默产出错误文本"的高危区：
// 替换失败不会抛错，只会让用户复制到一份字段缺失的文案，所以边界必须逐条钉死。
import { describe, it, expect } from 'vitest';
import { renderTemplate, previewTemplate, extractPlaceholders } from '../src/lib/templateEngine';

describe('renderTemplate', () => {
  it('替换单个占位符', () => {
    expect(renderTemplate('款号：{{sku}}', { sku: 'A123' })).toBe('款号：A123');
  });

  it('替换多个占位符（含同一字段重复出现）', () => {
    expect(renderTemplate('{{a}}-{{b}}-{{a}}', { a: '1', b: '2' })).toBe('1-2-1');
  });

  it('占位符内部的空白会被 trim', () => {
    expect(renderTemplate('{{  sku  }}', { sku: 'A123' })).toBe('A123');
  });

  it('字段缺失时输出可见的缺失标记，而不是留空', () => {
    expect(renderTemplate('色号：{{color}}', {})).toBe('色号：[字段缺失: color]');
  });

  it('字段值为空串算"存在"，不应报缺失（否则用户会误以为列没识别到）', () => {
    expect(renderTemplate('[{{note}}]', { note: '' })).toBe('[]');
  });

  it('字段值为 "0" 时不应被当成缺失', () => {
    expect(renderTemplate('{{qty}}', { qty: '0' })).toBe('0');
  });

  it('只做一轮替换：字段值里的 {{...}} 不会被二次展开', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'X' })).toBe('{{b}}');
  });

  it('中文/含点号的字段名可正常匹配', () => {
    expect(renderTemplate('{{商品.名称}}', { '商品.名称': 'T恤' })).toBe('T恤');
  });

  it('未闭合或空占位符原样保留，不做任何替换', () => {
    expect(renderTemplate('{{}} 与 {{未闭合', {})).toBe('{{}} 与 {{未闭合');
  });

  it('模板不含占位符时原样返回', () => {
    expect(renderTemplate('纯文本', { a: '1' })).toBe('纯文本');
  });
});

describe('extractPlaceholders', () => {
  it('去重且保持首次出现顺序', () => {
    expect(extractPlaceholders('{{b}}{{a}}{{b}}')).toEqual(['b', 'a']);
  });

  it('返回 trim 后的字段名', () => {
    expect(extractPlaceholders('{{ a }}')).toEqual(['a']);
  });

  it('无占位符时返回空数组', () => {
    expect(extractPlaceholders('无')).toEqual([]);
  });
});

describe('previewTemplate', () => {
  it('命中的字段渲染为主色 span，hasMissing=false', () => {
    const { html, hasMissing } = previewTemplate('{{sku}}', { sku: 'A1' });
    expect(hasMissing).toBe(false);
    expect(html).toBe('<span class="text-[var(--wb-primary)] font-medium">A1</span>');
  });

  it('缺失字段渲染为危险色 span，并把 hasMissing 置为 true', () => {
    const { html, hasMissing } = previewTemplate('{{sku}}', {});
    expect(hasMissing).toBe(true);
    expect(html).toContain('text-[var(--wb-danger)]');
    expect(html).toContain('[字段缺失: sku]');
  });

  it('模板与字段值中的 HTML 都被转义（防注入）', () => {
    const { html } = previewTemplate('<b>{{v}}</b>', { v: '<script>alert(1)</script>&' });
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
