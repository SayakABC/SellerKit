// src/core/ai/openaiCompatible.ts
// OpenAI 兼容视觉引擎实现（Qwen 百炼 / GLM / OpenAI 均走该协议）。
// 请求链路：axios（IPC adapter）→ 主进程 Electron net → 云 API（见 AGENTS.md §1.7）。
// 提示词约束模型输出结构化 JSON，解析失败抛错由调用方处理。

import http from '@/core/network/request';
import type { VisionEngine, VisionEngineConfig, RecognitionResult } from './types';
// 提示词单独成文件（纯模块）—— 见该文件头注释：本文件碰 `@/core/network`，node 环境 import 不了，
// 提示词留在本文件里就无法被单测断言"枚举与归一化词表同源"。
import { VISION_PROMPT } from './visionPrompt';

/** 视觉模型单次请求超时：识图推理通常 20-60s，需远大于普通接口的默认 15s */
const VISION_TIMEOUT_MS = 120000;

/** 各 provider 的预设端点与默认模型（可被配置覆盖） */
const PROVIDER_PRESETS: Record<VisionEngineConfig['provider'], { baseUrl: string; model: string }> = {
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { baseUrl: '', model: '' },
};

/** 截断文本（错误信息携带模型输出摘要，便于排查失败行） */
function truncate(s: string, n = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从模型输出中提取 JSON（兼容 ```json 代码块包裹） */
function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`模型输出缺少 JSON 对象：${truncate(raw)}`);
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`模型输出不是有效 JSON：${truncate(raw)}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 解析字符串数组（兼容数组或逗号/顿号分隔字符串；去重 + 上限 8 个防指纹膨胀） */
function toStrArray(v: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(v)) list = v.map(toStr).filter(Boolean);
  else if (typeof v === 'string') {
    list = v
      .split(/[,，、;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...new Set(list)].slice(0, 8);
}

/**
 * 从 OpenAI 兼容响应的 message.content 中提取文本。
 * 兼容两种形态：字符串，或多模态 part 数组（{type:'text',text} / {type:'file',...}）。
 * 文生图等模型会把生成的图片以 file part 返回、不含 text，此时返回空串。
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const p = part as Record<string, unknown>;
        return typeof p.text === 'string' ? p.text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * 测试用图片 data URL（64×64 纯色 PNG），用于验证视觉通道。
 * 部分 VL 模型（如百炼 qwen-vl 系列）拒绝过小的图片（要求宽高 >10px），故不能用 1x1 图。
 * 渲染进程用 canvas 惰性生成，避免硬编码大段 base64。
 */
let cachedTestImage = '';
function getTestImageDataUrl(): string {
  if (cachedTestImage) return cachedTestImage;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建画布生成测试图片');
  // 非 UI 颜色：这是发给视觉模型的探针像素，不是界面配色，故刻意用固定色值
  ctx.fillStyle = '#e05a3a';
  ctx.fillRect(0, 0, 64, 64);
  cachedTestImage = c.toDataURL('image/png');
  return cachedTestImage;
}

/**
 * 测试引擎配置是否正确可用（连通性 / API Key 权限 / 模型名是否支持视觉对话）。
 * 发送一个带 1x1 测试图的 chat/completions 请求，成功则说明配置可直接用于识别。
 * @param config 待校验的引擎配置（读取后构造纯对象，不直接透传 reactive 给 IPC）
 * @returns { ok: true, message: 模型回复摘要 } 或 { ok: false, message: 具体原因（含云 API 原始错误） }
 */
export async function testEngineConnection(
  config: VisionEngineConfig,
): Promise<{ ok: boolean; message: string }> {
  const preset = PROVIDER_PRESETS[config.provider] ?? PROVIDER_PRESETS.custom;
  const baseUrl = (config.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const model = config.model || preset.model;
  const apiKey = (config.apiKey || '').trim();

  if (!apiKey) return { ok: false, message: '未填写 API Key' };
  if (!baseUrl) return { ok: false, message: '未填写 Base URL（或所选引擎无默认端点）' };
  if (!model) return { ok: false, message: '未填写模型名（或所选引擎无默认模型）' };

  try {
    const res = await http.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0,
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是一张用于测试连接的图片，请只回复两个字：OK' },
              { type: 'image_url', image_url: { url: getTestImageDataUrl() } },
            ],
          },
        ],
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: VISION_TIMEOUT_MS },
    );
    const resp = res.data as Record<string, unknown>;
    const text = extractMessageText(
      (resp as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
        ?.content,
    );
    if (!text) {
      // 展示完整原始响应体：某些模型（如文生图）把结果放在非标准字段，只打印 content 看不到真相
      let rawJson = '(无响应体)';
      try {
        rawJson = JSON.stringify(resp ?? null);
      } catch {
        rawJson = '(响应体无法序列化)';
      }
      return {
        ok: false,
        message: `模型「${model}」连接成功但未返回文本内容。完整原始响应: ${rawJson}`,
      };
    }
    const snippet = text.replace(/\s+/g, ' ').slice(0, 60);
    return { ok: true, message: `连接成功，模型回复：${snippet}` };
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: { message?: unknown } } }; message?: string };
    const apiMsg =
      typeof err.response?.data?.error?.message === 'string' && err.response.data.error.message
        ? err.response.data.error.message
        : '';
    return {
      ok: false,
      message: apiMsg ? `配置不可用：${apiMsg}` : `请求失败：${err.message || '未知错误'}`,
    };
  }
}

/** 创建 OpenAI 兼容视觉引擎实例 */
export function createOpenAICompatibleEngine(config: VisionEngineConfig): VisionEngine {
  const preset = PROVIDER_PRESETS[config.provider] ?? PROVIDER_PRESETS.custom;
  const baseUrl = (config.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const model = config.model || preset.model;

  return {
    async analyze(dataUrl: string): Promise<RecognitionResult> {
      if (!config.apiKey) throw new Error('未配置 API Key，请到 设置 → 订单归类 中填写');
      if (!baseUrl) throw new Error('未配置 Base URL');

      let data: unknown;
      try {
        const res = await http.post(
          `${baseUrl}/chat/completions`,
          {
            model,
            temperature: config.temperature ?? 0.1,
            max_tokens: 512,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: VISION_PROMPT },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            response_format: { type: 'json_object' },
          },
          { headers: { Authorization: `Bearer ${config.apiKey}` }, timeout: VISION_TIMEOUT_MS },
        );
        data = res.data;
      } catch (e: unknown) {
        // 透出云 API 实际错误（如模型名不存在/不支持等），便于用户排查配置
        const err = e as { response?: { data?: { error?: { message?: unknown } } }; message?: string };
        const apiMsg =
          typeof err.response?.data?.error?.message === 'string' && err.response.data.error.message
            ? err.response.data.error.message
            : '';
        throw new Error(
          apiMsg
            ? `AI 识别接口错误：${apiMsg}`
            : `AI 识别接口请求失败：${err.message || '未知错误'}`,
        );
      }

      const text = extractMessageText(
        (data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })
          ?.choices?.[0]?.message?.content,
      );
      if (!text) {
        const finish = (
          data as { choices?: { finish_reason?: unknown }[] }
        )?.choices?.[0]?.finish_reason;
        // 展示完整原始响应体：不截断、不下结论，让用户看到模型真实返回的结构
        let rawJson = '(无响应体)';
        try {
          rawJson = JSON.stringify((data as Record<string, unknown>) ?? null);
        } catch {
          rawJson = '(响应体无法序列化)';
        }
        throw new Error(
          `模型「${model}」未返回文本内容（finish_reason=${String(finish ?? 'unknown')}）。完整原始响应: ${rawJson}`,
        );
      }
      const json = extractJson(text);
      return {
        category: toStr(json.category),
        features: toStrArray(json.features),
        color: toStr(json.color),
        logo: toStr(json.logo),
        styleName: toStr(json.style_name),
        confidence: Math.min(1, Math.max(0, toNum(json.confidence))),
        raw: text,
      };
    },
  };
}
