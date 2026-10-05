<template>
  <!-- 直接复用「拣货」模块的整页视图（`embedded` = 藏掉它自己的页头，避免双层标题）。
       **不复制一份精简版**：同一件事两处摆，迟早两套口径（2026-10-05 岛内「拣货」页签
       发布前撤回就是这个理由）。这里只做"包一层 + 传刷新信号"。 -->
  <PickingView embedded :refresh-token="token" @go-import="go('import')" />
</template>

<script setup lang="ts">
import PickingView from '@/modules/picking/PickingView.vue';
import { useShipping } from '../flowCtx';

// `token` 是容器给的**数据版本号**：导入订单后 +1 ⇒ 拣货单跟着重算。
// 没有它，`KeepAlive` 保活会让用户看到"还是刚才那份清单"—— 保活的代价必须这样还回去。
//
// `@go-import`：拣货页空态里的「去导订单」按钮。内嵌时**不能**让它 `switchModule('today')`
// （跳到本页再跳回来，等于没动），改由这里切到「导入订单」页签。
const { token, go } = useShipping();
</script>
