<script setup lang="ts">
// src/core/settings/RecognitionSettings.vue
// 宿主「设置 › 识别」：视觉识别引擎（服务商 / 模型 / 接口地址 / 温度）与 API Key。
//
// 为什么这些**从岛上搬进宿主**（C4，2026-09-30）：它们不是"某一块业务"的设置，而是**全局基础设施** ——
// 识别引擎与密钥一旦只存在于某个可卸载/可停用的业务岛里，就变成"设置藏在业务岛里"（UX 审查 M7）。
// 列映射与「本次导入店铺」当时仍留在「订单归类」岛内（那类设置"改完必须立刻看预览"，离开订单预览页
// 去改就断了反馈回路，ADR-001 的适用范围）—— 该岛已于 **2026-10-05 整体下架**，列映射随后由内建
// 「今天 › 归类核对」页承接（同一命名空间的 `imageColumn` 等键）。
//
// ⚠️ **存储命名空间仍叫 `order-insight`，这是有意保留的**：它是**已落盘的用户数据键**
//   （`modules.order-insight.engine` + 四个列名 + 两个透视维度）。岛已经没有了，但键不能跟着改名 ——
//   改名的效果是"用户配好的引擎 API Key 与列映射静默消失"，而他只会看到设置页变空。
//   所以：**命名空间名 ≠ 模块是否存在**，别顺手"清理"成 `recognition` 之类。
//
// 存储口径：本页与内建「归类核对」页共用同一命名空间（两边可互通、不会各写一份）：
//   · 引擎 → electron-store `modules.order-insight.engine`（`{provider, baseUrl, model, temperature}`）
//   · 密钥 → 宿主机密存储（`orderApiKeySet`，safeStorage 加密）；本页只判断"有没有配过"，不回显明文。

import { computed, onMounted, ref } from 'vue';
import { useModuleStorage } from '@/core/services/storage';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import type { VisionEngineConfig } from '@/core/ai/types';

const PROVIDERS: { id: VisionEngineConfig['provider']; label: string; hint: string }[] = [
  { id: 'qwen', label: '通义千问 Qwen-VL', hint: '阿里百炼（DashScope）兼容端点' },
  { id: 'openai', label: 'OpenAI 兼容', hint: 'OpenAI 官方或任何兼容 /v1/chat/completions 的服务' },
  { id: 'custom', label: '自定义端点', hint: '自己填接口地址与模型名' },
];

const DEFAULT_ENGINE: Omit<VisionEngineConfig, 'apiKey'> = {
  provider: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  temperature: 0.1,
};

const engine = ref<Omit<VisionEngineConfig, 'apiKey'>>({ ...DEFAULT_ENGINE });
const apiKey = ref('');
const keyConfigured = ref(false);
const loading = ref(true);
const saving = ref(false);

const providerHint = computed(
  () => PROVIDERS.find((p) => p.id === engine.value.provider)?.hint ?? ''
);

const storage = useModuleStorage<{ engine?: Partial<VisionEngineConfig> }>('order-insight');

async function load(): Promise<void> {
  loading.value = true;
  try {
    // 与岛同一命名空间同一键：岛改过的引擎配置这里看得到，反之亦然
    const cfg = await storage.load();
    const saved = cfg?.engine && typeof cfg.engine === 'object' ? cfg.engine : {};
    const merged = { ...DEFAULT_ENGINE, ...saved } as Omit<VisionEngineConfig, 'apiKey'>;
    delete (merged as { apiKey?: string }).apiKey; // 老版本曾把空 key 一起落盘，读出口径统一清掉
    engine.value = merged;
    const r = await ipc.orderApiKeyGet();
    keyConfigured.value = !!(r.success && r.data?.apiKey);
  } catch (e: unknown) {
    toast(`读取识别设置失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function saveEngine(): Promise<void> {
  saving.value = true;
  try {
    const next = { ...engine.value };
    const temp = Number(next.temperature);
    next.temperature =
      Number.isFinite(temp) && temp >= 0 && temp <= 2 ? temp : DEFAULT_ENGINE.temperature;
    const payload: Record<string, unknown> = { engine: next };
    await storage.save(payload as { engine?: Partial<VisionEngineConfig> });
    toast('识别引擎配置已保存（下次识别即生效）', 'success');
  } catch (e: unknown) {
    toast(`保存失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

async function saveKey(): Promise<void> {
  const key = apiKey.value.trim();
  if (!key) {
    toast('请先填写 API Key', 'error');
    return;
  }
  const r = await ipc.orderApiKeySet(key);
  if (r.success) {
    apiKey.value = '';
    keyConfigured.value = true;
    toast('API Key 已加密保存（此后不再回显）', 'success');
  } else {
    toast(`保存密钥失败：${r.error ?? '未知错误'}`, 'error');
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="rs">
    <div v-if="loading" class="rs-muted">读取中…</div>
    <template v-else>
      <section class="rs-block">
        <div class="rs-title">视觉识别引擎</div>
        <div class="rs-note">用于 Excel 导入后的款式 / 颜色识别（在「今天」的「归类核对」页签里跑）。</div>
        <div class="rs-grid">
          <label class="rs-field">
            <span>服务商</span>
            <select v-model="engine.provider" data-act="rs-provider" class="wb-input rs-input">
              <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="rs-field">
            <span>模型</span>
            <input
              v-model="engine.model"
              data-act="rs-model"
              class="wb-input rs-input"
              placeholder="如 qwen-vl-max"
            />
          </label>
          <label class="rs-field rs-field--wide">
            <span>接口地址</span>
            <input
              v-model="engine.baseUrl"
              data-act="rs-base-url"
              class="wb-input rs-input"
              placeholder="https://…（留空按服务商预设）"
            />
          </label>
          <label class="rs-field">
            <span>温度</span>
            <input
              v-model="engine.temperature"
              data-act="rs-temperature"
              class="wb-input rs-input rs-input--num"
              type="number"
              step="0.1"
              min="0"
              max="2"
            />
          </label>
        </div>
        <div class="rs-note">{{ providerHint }}</div>
        <button
          class="wb-btn wb-btn--primary rs-btn"
          data-act="rs-save-engine"
          :disabled="saving"
          @click="saveEngine"
        >
          {{ saving ? '保存中…' : '保存引擎配置' }}
        </button>
      </section>

      <section class="rs-block">
        <div class="rs-title">API Key</div>
        <div class="rs-note">
          加密保存在本机（只写不读，保存后不再回显）。当前：
          <b data-act="rs-key-state">{{ keyConfigured ? '已配置' : '未配置' }}</b>
        </div>
        <div class="rs-row">
          <input
            v-model="apiKey"
            data-act="rs-api-key"
            class="wb-input rs-input rs-input--grow"
            type="password"
            placeholder="粘贴 API Key"
            autocomplete="off"
          />
          <button class="wb-btn wb-btn--primary rs-btn" data-act="rs-save-key" @click="saveKey">
            保存密钥
          </button>
        </div>
      </section>

      <section class="rs-block">
        <div class="rs-title">列映射 · 本次导入店铺</div>
        <div class="rs-note">
          这两项在「今天」的「归类核对」页签里改 —— 它们改完要立刻看导入预览，从那一页拆出来会断掉反馈回路
          （决策记录：docs/decisions/ADR-001-island-settings-stay-in-island.md）。
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.rs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}
.rs-block {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  padding: 14px;
}
.rs-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.rs-note {
  font-size: 12px;
  color: var(--wb-text-muted);
  margin-bottom: 8px;
  line-height: 1.7;
}
.rs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.rs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.rs-field--wide {
  grid-column: 1 / -1;
}
/* 输入框 / 按钮的基座统一来自全局 .wb-input 与 .wb-btn（见 src/styles/index.css）。
   这里只留本页的**布局**约束 —— 原先本页自写一套 13px 字 / 6px 圆角 / transparent 底，
   与同为"设置页控件"的「通用」页按钮(8px 圆角、12px 字)明显不同源。 */
.rs-input--num {
  max-width: 120px;
}
.rs-input--grow {
  flex: 1;
  min-width: 0;
}
.rs-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rs-btn {
  margin-top: 10px;
}
/* 与输入框同处一行的按钮不能带 margin-top，否则整行错位 10px（原实现就是这样） */
.rs-row .rs-btn {
  margin-top: 0;
  flex-shrink: 0;
}
.rs-muted {
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
