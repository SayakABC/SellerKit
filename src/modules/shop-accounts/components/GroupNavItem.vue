<script setup lang="ts">
// src/modules/shop-accounts/components/GroupNavItem.vue
// 分组导航树节点（递归）：折叠箭头 + 三态整组勾选 + 组名 + 店铺数 + 子组递归渲染。
// 样式由宿主 ShopAccountsView.vue 的 .group-nav 统一提供（跨组件 :deep），此处只负责结构与交互。
import { computed } from 'vue';
import { groupFieldLabel, useShopAccountsStore, type GroupNode } from '../store';
import IconGlyph from '@/core/components/IconGlyph.vue';

const props = withDefaults(defineProps<{ node: GroupNode; depth?: number }>(), {
  depth: 0,
});

const store = useShopAccountsStore();

/** 是否折叠（折叠时整棵子树不渲染） */
const collapsed = computed(() => store.isGroupCollapsed(props.node.key));
/** 是否被聚焦（决定高亮态与点击语义） */
const active = computed(() => store.activeGroupKey === props.node.key);
/** 整组选中态：none / partial / all */
const selectionState = computed(() => store.groupSelectionState(props.node));

/** 层级缩进（每级 13px，与折叠箭头列对齐） */
const indent = computed(() => `${10 + props.depth * 13}px`);

/** 点击已聚焦的分组 = 取消聚焦，回到「全部分组」 */
function focus(): void {
  store.setActiveGroup(active.value ? '' : props.node.key);
}
</script>

<template>
  <div class="nav-node">
    <div
      class="nav-item"
      :class="{ 'is-active': active }"
      :style="{ paddingLeft: indent }"
      @click="focus()"
    >
      <button
        v-if="node.children.length"
        class="nav-caret"
        type="button"
        :title="collapsed ? '展开子分组' : '收起子分组'"
        @click.stop="store.toggleGroupCollapse(node.key)"
      >
        <IconGlyph :name="collapsed ? 'chevron-right' : 'chevron-down'" :size="11" />
      </button>
      <span v-else class="nav-caret is-leaf"></span>

      <input
        class="nav-check"
        type="checkbox"
        :checked="selectionState === 'all'"
        :indeterminate="selectionState === 'partial'"
        :title="`全选 / 取消「${node.label}」下的 ${node.items.length} 套店铺`"
        @click.stop
        @change="store.toggleSelectGroup(node)"
      />

      <span class="nav-label" :title="`${groupFieldLabel(node.field)}：${node.label}`">
        {{ node.label }}
      </span>
      <span class="nav-count">{{ node.items.length }}</span>
    </div>

    <template v-if="node.children.length && !collapsed">
      <GroupNavItem
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
      />
    </template>
  </div>
</template>
