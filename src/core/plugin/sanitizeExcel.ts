// src/core/plugin/sanitizeExcel.ts
// 「TV 模版」（excel-copy）业务域的入参消毒 —— 从 host.ts 抽出的纯函数模块（无副作用、可单测）。
//
// 为什么独立成文件：
//   ① host.ts 已 503 行，超 AGENTS §1 的「单文件 ≤ 300 行」门禁，而这段消毒逻辑自成一体；
//   ② 它是**纯函数**（只吃 unknown、吐结构化对象），本就该与依赖 ipc / axios 的 host.ts 解耦，
//      这样门禁测试不必 mock 整个宿主能力面（与 payloadBudget.ts 同构）。
//
// iframe 消息不可信（红线 3）：插件可以往 db.call 里塞任意形状的载荷，
// 而 excel-copy 的 op 会把载荷喂给 xlsx 解析与规则引擎，故一律先做结构 + 规模约束。

/** ① 配置类上限：超限 = 配置/结构异常 → 拒绝并报错 */
export const EC_MAX_RULES = 64;
export const EC_MAX_HEADERS = 256;
export const EC_MAX_FIELDS = 256;
export const EC_MAX_EXCEL_BYTES = 64 * 1024 * 1024;

/** ② 数据类上限：真实大文件会踩到 → 截断，但必须可感知 */
export const EC_MAX_RECORDS = 50000;
export const EC_MAX_STR = 20000;

const EC_RULE_TYPES = new Set(['dateOffset', 'template', 'math', 'jsExpression']);

/** 字符串化 + 长度收口（数据类：截断，不抛错） */
export const ecStr = (v: unknown, max = EC_MAX_STR): string =>
  typeof v === 'string' ? v.slice(0, max) : '';

/**
 * 配置类超限：抛出（岛侧 try/catch → 弹错误提示）。
 *
 * 为什么不静默截断：静默会让用户拿到一份"看起来正常但结果不对"的数据——
 * 改了规则没生效、少了几列——且没有任何线索可查。明确失败优于静默降级。
 */
export function rejectOverLimit(what: string, actual: number, max: number): never {
  throw new Error(`${what} 超限：${actual} > ${max}。请减少${what}后重试，或联系插件作者调整上限。`);
}

/** ① 配置类：Excel 体积上限（excel-copy 域；原 order-insight 域同一阈值，该域已于 2026-10-05 下架） */
export function assertExcelBytes(buf: ArrayBuffer): void {
  if (buf.byteLength > EC_MAX_EXCEL_BYTES) {
    rejectOverLimit('Excel 文件大小', buf.byteLength, EC_MAX_EXCEL_BYTES);
  }
}

/** 数据类截断的计数（只统计，不阻断） */
export interface EcTruncation {
  /** 因超过 EC_MAX_RECORDS 被丢弃的行数 */
  droppedRecords: number;
  /** 因超过 EC_MAX_STR 被截断的单元格个数 */
  truncatedStrings: number;
}

export interface EcSanitizedRule {
  id: string;
  name: string;
  enabled: boolean;
  targetField: string;
  type: string;
  order: number;
  config: Record<string, string>;
}

export interface EcSanitizedRecord {
  id: number;
  used: boolean;
  order: number;
  fields: Record<string, string>;
}

export interface EcSanitizeRecordsResult {
  records: EcSanitizedRecord[];
  /** 数据类截断统计（②）；全 0 表示未发生截断 */
  truncation: EcTruncation;
}

/** 规则消毒：丢弃形状非法的条目（宁缺勿滥，绝不把未校验对象透给规则引擎） */
export function sanitizeRules(raw: unknown): EcSanitizedRule[] {
  if (!Array.isArray(raw)) return [];
  // ① 配置类：规则是用户在设置页手配的，64 条已是极端。超限说明配置异常或载荷伪造。
  if (raw.length > EC_MAX_RULES) rejectOverLimit('规则条数', raw.length, EC_MAX_RULES);
  const out: EcSanitizedRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const type = ecStr((r as { type?: unknown }).type, 32);
    if (!EC_RULE_TYPES.has(type)) continue;
    const cfgIn = (r as { config?: unknown }).config;
    const cfg: Record<string, string> = {};
    if (cfgIn && typeof cfgIn === 'object' && !Array.isArray(cfgIn)) {
      for (const k of ['sourceField', 'packageField', 'outputFormat', 'template', 'expression', 'code']) {
        const v = (cfgIn as Record<string, unknown>)[k];
        if (typeof v === 'string') cfg[k] = v.slice(0, EC_MAX_STR);
      }
    }
    out.push({
      id: ecStr((r as { id?: unknown }).id, 128) || `rule_${out.length + 1}`,
      name: ecStr((r as { name?: unknown }).name, 200),
      enabled: (r as { enabled?: unknown }).enabled !== false,
      targetField: ecStr((r as { targetField?: unknown }).targetField, 200),
      type,
      order: Number.isFinite(Number((r as { order?: unknown }).order))
        ? Math.trunc(Number((r as { order?: unknown }).order))
        : out.length + 1,
      config: cfg,
    });
  }
  return out;
}

/** 记录消毒：仅保留 id/used/order + 字符串字段表 */
export function sanitizeRecords(raw: unknown): EcSanitizeRecordsResult {
  const truncation: EcTruncation = { droppedRecords: 0, truncatedStrings: 0 };
  if (!Array.isArray(raw)) return { records: [], truncation };
  // ② 数据类：大文件是真实场景，整体拒绝等于让用户什么都做不了 → 截断但记账。
  truncation.droppedRecords = Math.max(0, raw.length - EC_MAX_RECORDS);
  const out: EcSanitizedRecord[] = [];
  for (const r of raw.slice(0, EC_MAX_RECORDS)) {
    if (!r || typeof r !== 'object') continue;
    const fieldsIn = (r as { fields?: unknown }).fields;
    const fields: Record<string, string> = {};
    if (fieldsIn && typeof fieldsIn === 'object' && !Array.isArray(fieldsIn)) {
      const entries = Object.entries(fieldsIn as Record<string, unknown>);
      // ① 配置类：列数由表头决定，256 列已是极端；超限说明载荷伪造或文件结构异常。
      if (entries.length > EC_MAX_FIELDS) rejectOverLimit('单条记录字段数', entries.length, EC_MAX_FIELDS);
      for (const [k, v] of entries) {
        if (typeof v !== 'string') continue;
        // ② 数据类：超长单元格截断，但记数，供岛侧提示"有内容被截断"。
        if (v.length > EC_MAX_STR) truncation.truncatedStrings++;
        fields[String(k).slice(0, EC_MAX_HEADERS)] = v.slice(0, EC_MAX_STR);
      }
    }
    const rid = (r as { id?: unknown }).id;
    const rorder = (r as { order?: unknown }).order;
    out.push({
      id: Number.isFinite(Number(rid)) ? Math.trunc(Number(rid)) : out.length + 1,
      used: (r as { used?: unknown }).used === true,
      order: Number.isFinite(Number(rorder)) ? Math.trunc(Number(rorder)) : out.length + 1,
      fields,
    });
  }
  return { records: out, truncation };
}
