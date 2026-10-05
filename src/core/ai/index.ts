// src/core/ai/index.ts
// 视觉识别引擎工厂：按配置创建引擎实例（当前仅 OpenAI 兼容实现，本地 CLIP 预留）。
// 使用：const engine = createVisionEngine(config); await engine.analyze(dataUrl);

import { createOpenAICompatibleEngine, testEngineConnection } from './openaiCompatible';
import type { VisionEngine, VisionEngineConfig } from './types';

export type { VisionEngine, VisionEngineConfig, RecognitionResult } from './types';
// 提示词从**纯模块**出去（`./visionPrompt` 不碰 `@/core/network`）⇒ 单测能直接断言它的枚举
// 与 `@/lib/orderClassifier` 的词表同源。别改回从 `./openaiCompatible` 导出（那条链路会碰 `window`）。
export { VISION_PROMPT } from './visionPrompt';
export { testEngineConnection } from './openaiCompatible';

/** 创建视觉识别引擎（按 provider 分发） */
export function createVisionEngine(config: VisionEngineConfig): VisionEngine {
  return createOpenAICompatibleEngine(config);
}
