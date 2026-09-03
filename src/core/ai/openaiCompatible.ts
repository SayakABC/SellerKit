// src/core/ai/openaiCompatible.ts
// OpenAI 兼容视觉引擎实现（Qwen 百炼 / GLM / OpenAI 均走该协议）。
// 请求链路：axios（IPC adapter）→ 主进程 Electron net → 云 API（见 AGENTS.md §1.7）。
// 提示词约束模型输出结构化 JSON，解析失败抛错由调用方处理。

import http from '@/core/network/request';
import type { VisionEngine, VisionEngineConfig, RecognitionResult } from './types';
import { CATEGORY_WHITELIST } from '@/lib/orderClassifier';

/** 视觉模型单次请求超时：识图推理通常 20-60s，需远大于普通接口的默认 15s */
const VISION_TIMEOUT_MS = 120000;

/** 各 provider 的预设端点与默认模型（可被配置覆盖） */
const PROVIDER_PRESETS: Record<VisionEngineConfig['provider'], { baseUrl: string; model: string }> = {
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { baseUrl: '', model: '' },
};

/** 服装图片识别提示词：要求模型只输出 JSON，字段与 RecognitionResult 对齐 */
/** export const VISION_PROMPT = `你是服装电商订单图片识别助手。请识别图片中服装的信息，只输出 JSON 对象（不要输出任何多余文字或代码块标记），字段如下：
{
  "category": "款式大类，必须从以下固定列表中选择且不要附加任何修饰词：短袖T恤/长袖T恤/卫衣/外套/衬衫/连衣裙/长裤/短裤/马甲/西装/毛衣/风衣/牛仔裤/运动套装/其他（若款式明显不属于任一枚举，选最接近的）",
  "features": "用于区分同一大类下不同款式的关键特征数组，3-6个词，越具体越好，逐维度检查：版型（宽松/修身/oversize/直筒/收腰/廓形）、领型（圆领/V领/高领/连帽/立领/翻领/拉链领/一字肩）、图案（纯色/条纹/格纹/印花/字母/卡通/迷彩/泼墨）、工艺（刺绣/拼接/破洞/水洗/做旧/加绒/夹棉/绗缝/压花）、长度（短款/中长款/及膝/长款/拖地）、袖型（长袖/短袖/七分袖/蝙蝠袖/落肩/无袖）、材质肌理（针织/摇粒绒/牛仔/灯芯绒/丝绒/呢料/皮革/网纱）等维度；只有确实没有明显特征时才返回空数组。示例：["oversize","连帽","字母印花","加绒"]、["修身","V领","格纹","长袖"]、["直筒","破洞","水洗","牛仔裤"]",
  "color": "主颜色，如：黑色/白色/灰色/藏蓝/卡其/红色/粉色/紫色/绿色/印花多色",
  "logo": "logo或印花文字内容，没有则为空字符串",
  "confidence": 0到1的小数，表示你对识别结果的置信度
}`;
*/

export const VISION_PROMPT = `你是资深服装电商视觉识别专家。请精准分析图片中的服装，仅输出纯JSON对象（无Markdown标记、无额外文字）。

## 核心任务
提取能唯一锁定该款式的"视觉指纹"，确保运营人员看到简短款式名+特征即可在脑海中还原实物，并能与同大类其他商品明确区分。

## 输出字段规范
{
  "category": "严格从以下枚举中选择一项：${CATEGORY_WHITELIST.join('|')}",
  "style_name": "3-8字精炼款式命名，格式为[核心版型/风格]+[最强识别点]+[品类]。示例：美式复古字母印花卫衣、修身侧条纹瑜伽裤、法式方领泡泡袖连衣裙。禁止使用'新款''百搭'等无效营销词",
  "features": "高区分度特征数组(3-6项)。⚠️必须遵循排他性原则：只保留能将该款与同品类基础款区分开的视觉锚点。按优先级提取：①独特结构(抽绳/绑带/异形扣/开叉位置) ②标志性图案/IP/定位印花 ③特殊工艺(重工刺绣/扎染/磨破) ④辨识性廓形(茧型/A字/鱼尾)。❌过滤掉该品类的默认属性(如T恤的'圆领'、牛仔裤的'丹宁')，除非其形态异常",
  "color": "主色调，多色用'底色+花色'描述，如'藏蓝底白色条纹'",
  "logo": "清晰可辨的品牌标识或装饰性文字内容，无则返回空字符串",
  "confidence": 0.0-1.0，对款式识别准确性的置信度"
}

## 质量红线
1. features中若出现3个以上通用词(如宽松/纯色/长袖)，视为识别失败，需重新聚焦细节
2. style_name必须包含至少1个features中的核心识别点
3. 不确定时宁可少填也不要编造，对应字段留空或置为默认值`;

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
