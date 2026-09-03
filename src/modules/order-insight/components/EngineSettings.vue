<template>
  <div class="p-5 overflow-y-auto h-full">
    <div class="max-w-2xl mx-auto space-y-6">
      <!-- 识别引擎 -->
      <section>
        <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">识别引擎</div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">引擎</span>
            <select v-model="cfg.engine.provider" class="wb-input mt-1" @change="save">
              <option value="qwen">Qwen3-VL（阿里百炼，推荐）</option>
              <option value="openai">GPT-4o-mini（OpenAI）</option>
              <option value="custom">自定义 OpenAI 兼容端点</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">模型名（留空用默认）</span>
            <input
              v-model="cfg.engine.model"
              list="vl-model-suggestions"
              class="wb-input mt-1"
              placeholder="qwen3-vl-flash / qwen-vl-plus"
              @change="save"
            />
            <datalist id="vl-model-suggestions">
              <option value="qwen3-vl-flash" />
              <option value="qwen3-vl-plus" />
              <option value="qwen-vl-plus" />
              <option value="qwen-vl-max" />
              <option value="gpt-4o-mini" />
              <option value="gpt-4o" />
            </datalist>
          </label>
          <label class="block col-span-2">
            <span class="text-xs text-[var(--wb-text-muted)]">API Key</span>
            <input
              :value="store.apiKey"
              type="password"
              class="wb-input mt-1"
              placeholder="sk-…"
              autocomplete="off"
              @change="onApiKeyChange"
            />
            <span class="text-[11px] text-[var(--wb-text-muted)] mt-1 block">
              {{ store.apiKey ? '已保存（系统钥匙串加密存储，不在本地明文落盘）' : '未配置；保存后经系统钥匙串加密' }}
            </span>
          </label>
          <label class="block col-span-2">
            <span class="text-xs text-[var(--wb-text-muted)]">Base URL（留空用引擎默认）</span>
            <input
              v-model="cfg.engine.baseUrl"
              class="wb-input mt-1"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              @change="save"
            />
          </label>
          <div class="col-span-2 flex items-center gap-3 mt-1">
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-[var(--wb-primary)] border border-[var(--wb-border)] hover:bg-[var(--wb-primary-soft)] rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="testing"
              @click="runTest"
            >
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <span
              v-if="testResult"
              class="text-xs break-all"
              :style="{ color: testResult.ok ? 'var(--wb-success)' : 'var(--wb-danger)' }"
            >
              {{ testResult.message }}
            </span>
          </div>
        </div>
        <p class="text-xs text-[var(--wb-text-muted)] mt-2">
          识别走 OpenAI 兼容接口，图片经主进程 Electron net 转发，规避 CORS。识别结果按图片指纹缓存，重复导入不重复扣费。模型名可直接填写任意值，点下方「测试连接」可查看模型实际返回内容。
        </p>
      </section>

      <!-- 字段列 -->
      <section>
        <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">Excel 列</div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">主图列</span>
            <input v-model="cfg.imageColumn" class="wb-input mt-1" placeholder="导入后自动识别" @change="save" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">订单号列</span>
            <input v-model="cfg.orderNoColumn" class="wb-input mt-1" placeholder="可留空" @change="save" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">店铺列</span>
            <input v-model="cfg.shopColumn" class="wb-input mt-1" placeholder="可留空" @change="save" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">尺寸列</span>
            <input v-model="cfg.sizeColumn" class="wb-input mt-1" placeholder="可留空" @change="save" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">下单时间列</span>
            <input v-model="cfg.orderTimeColumn" class="wb-input mt-1" placeholder="可留空" @change="save" />
          </label>
        </div>
      </section>

      <!-- 分组维度 -->
      <section>
        <div class="text-xs font-medium text-[var(--wb-text-muted)] mb-2">分组维度</div>
        <div class="flex gap-4">
          <label
            v-for="d in dimOptions"
            :key="d.value"
            class="flex items-center gap-1.5 text-sm text-[var(--wb-text)] cursor-pointer"
          >
            <input
              type="checkbox"
              :checked="cfg.groupDimensions.includes(d.value)"
              class="accent-[var(--wb-primary)]"
              @change="toggleDim(d.value)"
            />
            {{ d.label }}
          </label>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { testEngineConnection } from '@/core/ai';
import { toast } from '@/core/services/toast';
import { useOrderInsightStore } from '../store';

defineProps<{ embedded?: boolean }>();

// Pinia setup store 的 ref 属性会被自动解包，store.config 即 OrderInsightConfig
const store = useOrderInsightStore();
const cfg = computed(() => store.config);

const dimOptions = [
  { label: '款式', value: 'category' },
  { label: '颜色', value: 'color' },
  { label: '店铺', value: 'shop' },
];

function toggleDim(v: string) {
  const arr = store.config.groupDimensions.slice();
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(v);
  store.config = { ...store.config, groupDimensions: arr };
  save();
}

function save() {
  store.saveState();
}

/** API Key 变更：经主进程 safeStorage 加密落盘（空值 = 清除），不写 electron-store 明文 */
async function onApiKeyChange(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  const ok = await store.setApiKey(v);
  if (ok) toast(v.trim() ? 'API Key 已加密保存' : '已清除 API Key', 'success');
}

const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function runTest() {
  if (testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    // config.engine 中不持有明文 apiKey → 测试时注入运行时值
    testResult.value = await testEngineConnection({ ...store.config.engine, apiKey: store.apiKey });
  } finally {
    testing.value = false;
  }
}
</script>
