<template>
  <div class="wb-mask" @click.self="$emit('close')">
    <div class="wb-dialog wb-dialog--md" role="dialog" aria-modal="true">
      <div class="wb-dialog__head">{{ title }}</div>

      <div class="wb-dialog__body pk-body">
        <div class="pk-toolbar">
          <input
            v-model="keyword"
            class="wb-input pk-search"
            type="search"
            placeholder="搜索款编码 / 款式名 / 类目…"
            aria-label="搜索产品"
          />
          <label class="pk-check">
            <input v-model="includeArchived" type="checkbox" />
            含停用
          </label>
          <span v-if="loading" class="wb-muted">读取中…</span>
        </div>

        <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

        <div class="pk-list">
          <label
            v-for="p in rows"
            :key="p.id"
            class="pk-item"
            :class="{ 'is-picked': picked === p.id }"
          >
            <input type="radio" :checked="picked === p.id" @change="picked = p.id" />
            <!-- 产品主图：认款靠肉眼比图（款编码 / 名称常常也认不出来），弹层里没有图就只能靠记忆 ——
                 而队列那边的商品图是**有**的，只有一边的图等于白给。取图失败渲染空占位，
                 **不是**整列空掉（图取不到不该让人连产品都选不了）。
                 复用全局 `.wb-thumb`（与产品列表 / 队列同一套尺寸与边框，不另立一套）。 -->
            <img
              v-if="thumbs.get(p.id)"
              :src="thumbs.get(p.id) || ''"
              class="wb-thumb"
              data-act="pick-thumb"
              alt=""
            />
            <span
              v-else
              class="wb-thumb wb-thumb--empty"
              data-act="pick-thumb-empty"
              title="这款没有主图"
            ></span>
            <span class="wb-mono pk-code">{{ p.code }}</span>
            <span class="pk-name">{{ p.name || '—' }}</span>
            <span class="pk-meta wb-muted">
              {{ p.category || '无类目' }}{{ p.status === 'archived' ? ' · 停用' : '' }}
            </span>
          </label>
          <p v-if="!rows.length && !loading" class="pk-empty wb-muted">
            {{ keyword ? '没有匹配的产品' : '产品库还是空的 —— 先在产品页导入或新增产品' }}
          </p>
        </div>

        <p class="pk-count wb-muted">
          共 {{ total }} 条{{ total > rows.length ? `，仅列出前 ${rows.length} 条（用搜索缩小范围）` : '' }}
        </p>
      </div>

      <div class="wb-dialog__foot">
        <!-- 颜色（D4 起承载在映射的 `spec` 上）：颜色是**商品ID 的属性**，不是每单的属性。
             配一次，之后该商品的所有订单自动带色 —— 不配则仍需人工逐单看图。故默认给出后果提示。 -->
        <label class="pk-color">
          <span class="wb-muted pk-color__label">颜色</span>
          <select v-model="color" class="wb-input wb-input--sm" data-act="pick-color">
            <option value="">不指定（订单仍需人工看色）</option>
            <option v-for="c in COLOR_OPTIONS" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <button class="wb-btn" type="button" @click="$emit('close')">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          :disabled="!picked || busy"
          @click="confirm"
        >
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 产品选择器：映射 / 改绑都从这里选目标产品。
//
// 为什么不用表格里的 `<select>`：产品数量无上限（导入一次就是几百到上千行），
// 原生下拉在千级选项下既难找又卡。这里是「搜索 + 单选列表」，搜索走 `list` 的
// `search` 过滤（同一个接口，不新增契约）。
//
// 只回传选中的产品 —— **不在这里写库**：写映射的事务/批量语义/行级失败上报都由
// 调用方统一处理，弹层只负责"选谁"。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api';
import { COLOR_SWATCH } from '@/lib/colorSwatch';
import type { ProductListItem } from '@/types';

const props = withDefaults(
  defineProps<{
    title?: string;
    confirmText?: string;
    /** 改绑时预填原色（不预填的话一次改绑会把人配好的颜色冲成"未指定"） */
    initialColor?: string;
  }>(),
  { title: '选择产品', confirmText: '确定', initialColor: '' }
);

const emit = defineEmits<{
  close: [];
  /** `color` 为空串 = 未指定色（映射的 `spec` 落 `'*'`，与一期行为等价） */
  pick: [product: { id: number; code: string; name: string; color: string }];
}>();

/** 颜色选项：直接复用款色色块字典的键 —— 它就是现有色名词汇（`oi_style_colors.color` 同口径），
 *  另起一份枚举必然出现"这里能选、那边认不出"（`colorCode` 对表外色名回落 ASCII/OTHER）。 */
const COLOR_OPTIONS = Object.keys(COLOR_SWATCH);

/** 一次最多取多少（`productList` 上限 500；这里再收一档，避免弹层里塞进整库） */
const PICKER_LIMIT = 100;

const keyword = ref('');
const applied = ref('');
const includeArchived = ref(false);
const rows = ref<ProductListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const picked = ref(0);
const color = ref(props.initialColor || '');
const busy = ref(false);

/**
 * 产品主图缩略图（`id → dataUrl`）。
 *
 * 合批取（一屏一次调用，不是每行一次）—— 与产品列表 / 队列用**同一条**通道（`image-thumb-batch`），
 * 因此不新增 IPC。单项失败为 `null` ⇒ 界面空占位：图是"帮你认"，不是"能不能选"的前提。
 */
const thumbs = ref(new Map<number, string>());

async function loadThumbs(): Promise<void> {
  const items = rows.value.filter((p) => p.imagePath).map((p) => ({ key: p.id, path: p.imagePath }));
  const next = new Map<number, string>();
  if (items.length) {
    try {
      const r = await api.imageThumbBatch(items.map((it) => ({ localPath: it.path })));
      (r?.dataUrls ?? []).forEach((url, i) => {
        if (url) next.set(items[i].key, url);
      });
    } catch {
      // 取图失败不挡选择：退化成整列空占位，产品照样能选
    }
  }
  thumbs.value = next;
}

/** 搜索防抖（与产品页同一节奏；每次按键都发一次 IPC 会让弹层发顿） */
let timer: ReturnType<typeof setTimeout> | null = null;
watch(keyword, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    applied.value = v.trim();
    void load();
  }, 300);
});
watch(includeArchived, () => void load());
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.list({
      offset: 0,
      limit: PICKER_LIMIT,
      search: applied.value,
      status: includeArchived.value ? '' : 'active',
      supplierId: 0,
    });
    rows.value = res?.rows ?? [];
    total.value = res?.total ?? 0;
    // 选中项被筛掉了就清掉 —— 否则"看不见却仍然选中"，改绑会落到意外的产品上
    if (picked.value && !rows.value.some((p) => p.id === picked.value)) picked.value = 0;
    // 拉完行才知道要取哪些图（图不挡列表：整列先空占位，拿到再填）
    void loadThumbs();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function confirm(): void {
  const hit = rows.value.find((p) => p.id === picked.value);
  if (!hit) return;
  busy.value = true;
  emit('pick', { id: hit.id, code: hit.code, name: hit.name, color: color.value });
}

onMounted(() => void load());
</script>

<style scoped>
.pk-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pk-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.pk-search {
  flex: 1;
}

.pk-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.pk-list {
  min-height: 220px;
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.pk-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--wb-border);
}
.pk-item:last-child {
  border-bottom: none;
}
.pk-item:hover {
  background: var(--wb-hover);
}
.pk-item.is-picked {
  background: var(--wb-primary-soft);
}

.pk-code {
  width: 130px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-meta {
  flex-shrink: 0;
  font-size: 12px;
}
.pk-empty {
  padding: 40px 0;
  text-align: center;
  margin: 0;
}
.pk-count {
  margin: 0;
  font-size: 12px;
}

/* 颜色选择靠左，两个按钮保持右对齐 */
.pk-color {
  margin-right: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pk-color__label {
  font-size: 13px;
  white-space: nowrap;
}
</style>
