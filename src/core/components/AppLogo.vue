<script setup lang="ts">
/**
 * 品牌标识在界面内的展示位。
 *
 * 唯一引用点：brand/logo-icon.svg。侧栏与「设置 › 关于」都走这里，
 * 不要各自再写一份 `<img>` / 内联 SVG —— 否则改图标时要改两处（本项目已踩过多次）。
 *
 * 用固定色的应用图标，不随主题反相：它与 Dock / 安装包里的图标是同一个东西，
 * 主题切换时保持同一张脸才是「应用标识」该有的行为。底板自带 16% 白描边，
 * 深色侧栏上仍能看清轮廓，不需要再套一层 --wb-primary 底。
 *
 * alt 默认空（装饰性）：可访问名称由外层按钮 / 标题提供，避免读屏重复播报。
 */
import logoUrl from '../../../brand/logo-icon.svg';

withDefaults(
  defineProps<{
    size?: number;
    alt?: string;
  }>(),
  { size: 32, alt: '' }
);
</script>

<template>
  <img
    :src="logoUrl"
    :width="size"
    :height="size"
    :alt="alt"
    draggable="false"
    class="block select-none"
  />
</template>
