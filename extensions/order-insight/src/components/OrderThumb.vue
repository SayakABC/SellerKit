<template>
  <span ref="rootEl" :class="rootClass">
    <img v-if="src" :src="src" alt="主图" class="absolute inset-0 h-full w-full object-cover" />
    <span v-else-if="placeholder" class="px-1 text-center text-xs leading-snug text-[var(--wb-text-muted)]">
      {{ placeholder }}
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useOrderInsightStore } from '../store';

const props = defineProps<{
  path?: string;
  size?: 'sm' | 'md' | 'lg';
  /** 填满父容器（父需给定宽高），封面等大展示区用；此时忽略 size 尺寸与描边 */
  fill?: boolean;
  /** 展示目标边长（px），覆盖默认推导；主进程据此等比缩放（16~256 钳制） */
  maxEdge?: number;
  /** 无图时居中展示的占位文案（缺省为空块） */
  placeholder?: string;
  /** 立即加载（跳过 IntersectionObserver），用于首屏确定可见的小图 */
  eager?: boolean;
}>();
const store = useOrderInsightStore();
const src = ref('');
const rootEl = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let loaded = false;

const sizeClass = computed(() => {
  switch (props.size ?? 'sm') {
    case 'md':
      return 'h-16 w-16 rounded-lg';
    case 'lg':
      return 'h-24 w-24 rounded-xl';
    default:
      return 'h-12 w-12 rounded-md';
  }
});

const rootClass = computed(() => {
  const base =
    'relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-[var(--wb-surface-2)]';
  const border = props.fill ? '' : ' border border-[var(--wb-border)]';
  const size = props.fill ? 'h-full w-full' : sizeClass.value;
  return `${base}${border} ${size}`;
});

/** 展示级目标边长（约 2x 设备像素，供主进程等比缩放；图片本身小则原样返回） */
const maxEdge = computed(() => {
  if (props.maxEdge) return props.maxEdge;
  if (props.fill) return 256;
  switch (props.size ?? 'sm') {
    case 'md':
      return 128;
    case 'lg':
      return 192;
    default:
      return 96;
  }
});

async function load() {
  if (loaded) return;
  loaded = true;
  observer?.disconnect();
  observer = null;
  if (!props.path) {
    src.value = '';
    return;
  }
  // 缩略图走 order-image-thumb（主进程缩放 + LRU），列表/封面场景不再传整张原图
  src.value = await store.getThumbDataUrl(props.path, maxEdge.value);
}

watch(
  () => props.path,
  () => {
    loaded = false;
    if (props.path) src.value = '';
    // path 变化后重新懒加载（若已进入可视区则立即加载）
    if (props.eager) load();
    else observe();
  },
);

function observe() {
  const el = rootEl.value;
  if (!el) return;
  if (props.eager || typeof IntersectionObserver === 'undefined') {
    load();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting)) load();
    },
    { rootMargin: '120px' },
  );
  observer.observe(el);
}

onMounted(observe);
onBeforeUnmount(() => observer?.disconnect());
</script>
