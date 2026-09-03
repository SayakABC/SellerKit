// src/core/ai/types.ts
// 视觉识别引擎的统一抽象（渲染层公共能力，未来其他模块可复用）。
// 设计：引擎可插拔 —— 首版实现 OpenAI 兼容 API（Qwen/GLM/OpenAI 均为兼容端点），
//       本地 CLIP+OCR 作为预留引擎类型，通过 createVisionEngine 工厂切换，业务无感。

/** 视觉识别引擎配置 */
export interface VisionEngineConfig {
  /** 引擎类型：qwen（阿里百炼）/ openai（OpenAI）/ custom（任意 OpenAI 兼容端点） */
  provider: 'qwen' | 'openai' | 'custom';
  /** API Base URL（OpenAI 兼容，不含末尾斜杠）；留空时按 provider 取预设 */
  baseUrl: string;
  /** 模型名；留空时按 provider 取预设 */
  model: string;
  /** API Key */
  apiKey: string;
  /** 采样温度，默认 0.1（识别任务偏低保证稳定） */
  temperature?: number;
}

/** 服装订单图片识别结果（结构化） */
export interface RecognitionResult {
  /** 款式大类，如：短袖T恤 / 卫衣 / 外套 */
  category: string;
  /** 精炼款式名（模型 style_name，如"美式复古字母印花卫衣"）；未提供则空串，由 category+features 兜底 */
  styleName: string;
  /** 区分特征（款式匹配指纹用），如：['圆领','条纹'] */
  features: string[];
  /** 主颜色，如：黑色 / 白色 */
  color: string;
  /** logo / 印花文字，无则为空串 */
  logo: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 模型原始输出（调试用） */
  raw: string;
}

/** 视觉识别引擎统一接口 */
export interface VisionEngine {
  /**
   * 识别一张图片（base64 data URL）。
   * @param dataUrl data:image/*;base64,... 的图片数据
   * @throws 请求失败 / 解析失败时抛出，调用方负责状态记录
   */
  analyze(dataUrl: string): Promise<RecognitionResult>;
}
