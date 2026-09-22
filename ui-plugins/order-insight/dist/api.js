// dist/api.js
// 业务 API 层：把宿主 db 能力域调用收敛为语义化函数（视图层不直接拼 op 名）。
// order-insight = 订单归类业务域；purchase = 拿货对账业务域（均需宿主 DB_OPS 白名单登记）。

import { db, store } from './bridge.js';

/** 订单归类业务域调用 */
export const oi = (op, payload) => db('order-insight', op, payload);

/** 拿货对账业务域调用 */
export const purchase = (op, payload) => db('purchase', op, payload);

/** 识别引擎默认配置（provider 预设与主进程/渲染层 core/ai 保持一致） */
export const DEFAULT_ENGINE = {
  provider: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  temperature: 0.1,
};

/**
 * 全量读取模块配置（modules.order-insight）。
 * 与内建 `useModuleStorage('order-insight')` 同一命名空间 —— 从内建版升级过来的用户，
 * 其已保存的列映射 / 分组维度 / 引擎配置会被岛直接继承，无需重填。
 */
export function loadConfig() {
  return store.all();
}

/** 合并写回模块配置（只覆盖传入的字段，其余保持） */
export function saveConfig(patch) {
  return store.patch(patch);
}

/** 读取识别引擎配置（不含密钥：Key 由宿主加密存储，岛内不可读、只能写入） */
export async function loadEngine() {
  const cfg = await store.all();
  const saved = cfg.engine && typeof cfg.engine === 'object' ? cfg.engine : {};
  const next = { ...DEFAULT_ENGINE, ...saved };
  delete next.apiKey; // 内建版曾把空的 apiKey 一起落盘，读出口径统一清理
  return next;
}

/** 保存识别引擎配置（密钥单独走 apiKeySet，不落岛内偏好） */
export async function saveEngine(engine) {
  const next = { ...DEFAULT_ENGINE, ...engine };
  delete next.apiKey;
  await store.patch({ engine: next });
  return next;
}

/** 写入视觉模型 API Key（宿主 safeStorage 加密，只写不读） */
export function setApiKey(apiKey) {
  return oi('apiKeySet', { apiKey });
}

/**
 * 视觉识别：由宿主补齐密钥后发起调用，岛内全程不接触明文 Key。
 * @param {string} dataUrl 图片 data URL
 * @param {object} engine 引擎配置（provider/baseUrl/model/temperature）
 */
export function analyze(dataUrl, engine) {
  return oi('analyze', { ...engine, dataUrl });
}
