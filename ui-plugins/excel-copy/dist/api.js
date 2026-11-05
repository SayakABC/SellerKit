// dist/api.js
// 业务 API 层：把宿主 db 能力域调用收敛为语义化函数（视图层不直接拼 op 名）。
// 本岛只用一个能力域：excel-copy（宿主 DB_OPS 白名单登记）。
//
// 为什么 Excel 解析与规则求值要放在宿主：
//   ① 岛运行在 iframe，CSP 为 script-src 'self'（无 'unsafe-eval'），
//      jsExpression 规则用的是 new Function —— 岛内**根本无法执行**；
//   ② 岛内不打包 xlsx 依赖（宿主已有解析器，重复引入会拖大产物且口径可能漂移）。
// 因此岛只负责「收集参数 → 调宿主 → 渲染结果」，两边共用同一份 fieldProcessor。

import { db, store } from './bridge.js';

/** excel-copy 业务域调用 */
export const ec = (op, payload) => db('excel-copy', op, payload);

// ---------- 配置（modules.excel-copy，与内建版同命名空间） ----------

/**
 * 全量读取模块配置。
 * 与内建 `useModuleStorage('excel-copy')` 同一命名空间 —— 从内建版升级过来的用户，
 * 其已保存的模板 / 字段规则 / 显示列 / 记录使用状态会被岛直接继承，无需重配。
 */
export function loadConfig() {
  return store.all();
}

/** 合并写回模块配置（宿主侧 {...old, ...patch}） */
export function saveConfig(patch) {
  return store.patch(patch);
}

// ---------- Excel ----------

/**
 * 按路径导入（对话框选用、以及启动时重载上次文件）。
 * @returns {Promise<{headers:string[], records:Array}>}
 */
export function parseExcel(filePath) {
  return ec('parseExcel', { filePath });
}

/**
 * 按字节导入（拖拽用）。
 * iframe 里的 File 对象拿不到真实磁盘路径，只能把 ArrayBuffer 传过去。
 * ⚠️ 必须传字节本体：结构化克隆支持 ArrayBuffer，但不支持 File 的路径语义。
 */
export function parseExcelBuffer(data) {
  return ec('parseExcelBuffer', { data });
}

/**
 * 执行字段规则（衍生列）——求值在宿主完成（岛 CSP 禁 eval）。
 * @param {object[]} records 记录（含 fields）
 * @param {string[]} headers 原始列名
 * @param {object[]} rules 规则（含未启用的，宿主按 enabled 过滤）
 * @returns {Promise<{records:object[], newHeaders:string[], errors:object[], rulesHash:string}>}
 */
export function applyRules(records, headers, rules) {
  return ec('applyRules', { records, headers, rules });
}

// ---------- 文件 ----------

/** 读取文本文件内容（导入模板文件后取 content，省一次 dialog） */
export function readTextFile(filePath) {
  return ec('readTextFile', { filePath });
}

/** 读取宿主内置模板（把 template.txt 当前内容同步进来） */
export function readDefaultTemplate() {
  return ec('readDefaultTemplate', {});
}

/** 检查文件是否存在（启动时判断"上次的 Excel 还在不在"） */
export function checkFileExists(filePath) {
  return ec('checkFileExists', { filePath });
}

/** 把模板内容写回其来源文件（模板带 filePath 时才有意义） */
export function saveTemplateFile(filePath, content) {
  return ec('saveTemplateFile', { filePath, content });
}
