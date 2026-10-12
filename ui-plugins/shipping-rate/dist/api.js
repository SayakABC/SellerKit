// dist/api.js
// 业务 API 层：把宿主 db 能力域调用收敛为语义化函数（视图层不直接拼 op 名）。
// 本岛只用一个能力域：shipping-rate（宿主 DB_OPS 白名单登记）。
//
// 为什么解析与计价都在宿主（本文件不提供任何本地计算实现）：
//   ① 岛运行在 iframe，CSP 为 script-src 'self'（无 'unsafe-eval'），也不该为读 Excel 打包 xlsx；
//   ② 归一化要处理 17 段列结构互不相同的价卡，取整/档位/类别优先级这些口径
//      "只要有两份实现就一定会漂移"，所以统一收在 @/lib/shipRate 与 @/lib/shipRateQuote。
// 因此岛只负责「收集参数 → 调宿主 → 渲染结果」。
//
// ⚠️ 下面 `export const sr = (op, payload) => db('shipping-rate', op, payload)` 的写法
//    被 tests/pluginTriage.spec.ts 用正则解析（helper → 能力域映射），改写法会让守卫失效。

import { db, store } from './bridge.js';

/** shipping-rate 业务域调用 */
export const sr = (op, payload) => db('shipping-rate', op, payload);

/**
 * 读 Excel 并归一化为运价表（解析在宿主完成）。
 *
 * 两个参数的语义**必须分清**（混用会把"换了个文件"变成硬失败）：
 *   · `sheetName`：**显式点名**。用户在「切换工作表」下拉里选了哪张就读哪张；
 *     宿主严格按它解析，点名的 sheet 不存在会直接报错，不会静默改判。
 *   · `prefer`：**名称提示**。一般传"上次用的那张表"；宿主优先它，
 *     但认不出来时会自动挑一张可用的（报价单换版后 sheet 改名/增删是常态）。
 *   两个都不传 → 宿主按默认提示（`无忧物流-标准`）自动选表。
 *
 * @param {string} filePath 宿主对话框选出的绝对路径
 * @param {{sheetName?:string, prefer?:string}} [opts]
 * @returns {Promise<{sheetNames:string[], sheetName:string, picked:'explicit'|'auto'|'none',
 *   table:object|null, candidates:Array<{sheetName:string,countries:number,cards:number,reason:string}>}>}
 *   `table` 为 null 表示**整本工作簿里没有可用的报价单 sheet**；
 *   此时 `candidates` 列出全部体检过的 sheet 及各自原因，供界面给出可读解释。
 */
export const parseRateSheet = (filePath, opts = {}) =>
  sr('parseRateSheet', {
    filePath,
    sheetName: opts.sheetName || '',
    prefer: opts.prefer || '',
  });

/**
 * 当前运价表（**只为显示**）：宿主快照里生效日最新的一份，连带来源文件/工作表。
 *
 * M6（2026-09-30）起运价表**归宿主**（`sr_rate_snapshots`）：本岛不再存表、也不再把它传回宿主。
 * 岛拿这份只用于渲染「国家运价 / 档位 / 告警」，以及给"换工作表"提示上次那张表名。
 * @returns {Promise<{id:number, effectiveFrom:string, sourceFile:string, sheetName:string, table:object}|null>}
 *   `null` = 还没有任何运价表（渲染空态，不要去算）
 */
export const rateCurrent = () => sr('rateCurrent', {});

/**
 * **一次性迁移口**：把本岛私有 storage 里的旧运价表交给宿主快照（升级后第一次打开时用）。
 * 宿主按内容 sha256 去重，重复调用是空操作；稳态下本岛**不写**运价表。
 * @param {object} table 归一化运价表
 * @param {{filePath?:string, sheetName?:string}} [source]
 */
export const rateAdopt = (table, source = {}) =>
  sr('rateAdopt', {
    table,
    sourceFile: source.filePath || '',
    sheetName: source.sheetName || '',
  });

/**
 * 按克重算出到**每个国家**的运费（一次调用拿全量结果，岛侧不做算术）。
 * 运价表由**宿主自取当前快照** —— 岛不传表（M6）。
 * @param {number} grams 实际克重
 * @param {{category?:string, variant?:string, rounding?:string}} [opts]
 * @returns {Promise<{grams:number, results:object[]}>}
 */
export const quote = (grams, opts = {}) =>
  sr('quote', {
    grams,
    category: opts.category || 'auto',
    variant: opts.variant || '',
    rounding: opts.rounding === 'ceil' ? 'ceil' : 'round',
  });

/**
 * 按订单批量试算：宿主自取最近订单（最小投影）→ 提取收货国家 + 款色码 →
 * 联产品库 SKU 克重 → 逐单计价。运价表同样由宿主自取（岛不传表）。
 * @param {{limit?:number, rounding?:string}} [opts]
 * @returns {Promise<{rows:Array, summary:{total,ok,noWeight,noCountry,unknownCountry,noPrice,refused}}>}
 */
export const quoteOrders = (opts = {}) =>
  sr('quoteOrders', {
    limit: opts.limit || 500,
    rounding: opts.rounding === 'ceil' ? 'ceil' : 'round',
  });

/**
 * 按产品批量试算：宿主自取产品库（pl_products + pl_variants 克重）× 点名目的国 → 逐 SKU 运费。
 * 重量锚点同为产品库 SKU 子表 —— 与「按订单试算」读**同一份克重**（不再有第二条重量链）。
 * 运价表同样由宿主自取（岛不传表）。
 * @param {string} country 目的国（运价表国家下拉里点名的中文名/英文名/ISO 均可）
 * @param {{limit?:number, rounding?:string}} [opts]
 * @returns {Promise<{rows:Array, summary:{total,ok,noWeight,unknownCountry,noPrice,refused}}>}
 */
export const quoteProducts = (country, opts = {}) =>
  sr('quoteProducts', {
    country,
    limit: opts.limit || 1000,
    rounding: opts.rounding === 'ceil' ? 'ceil' : 'round',
  });

// ---------- 配置（modules.shipping-rate） ----------

/** 全量读取模块配置 */
export function loadConfig() {
  return store.all();
}

/** 合并写回模块配置 */
export function saveConfig(patch) {
  return store.patch(patch);
}
