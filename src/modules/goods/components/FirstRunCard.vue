<template>
  <!-- 空库一次性引导卡（2026-10-08 R3 · UX-G4）。
       ⚠️ 只在**全新库**（零款 + 队列已拉过且为空）出现 —— 判据在 `../firstRun.ts`，
       不写在这里：它只有一行，但两个数各有"不知道"这一态，写成纯函数才有单测兜着。
       一旦有了款、或订单进了队列，它自己就消失，所以它不占常驻高度，也不需要"我知道了"按钮
       （那种按钮只会制造一个查不出原因的持久状态 —— 用户下次进来看到的是"我明明关过它"）。 -->
  <section class="wb-panel gd-firstrun" data-act="first-run-card">
    <div class="wb-panel__head">
      <span>这一页还是空的 —— 它靠两样东西喂起来</span>
      <span class="wb-muted">（做完第 1 步这张卡就会自己消失）</span>
    </div>
    <ol class="wb-panel__body gd-firstrun__steps">
      <li
        v-for="(s, i) in steps"
        :key="s.id"
        class="gd-firstrun__step"
        :data-act="`fr-step-${s.id}`"
      >
        <span class="gd-firstrun__no">{{ i + 1 }}</span>
        <div class="gd-firstrun__body">
          <p class="gd-firstrun__t">{{ s.title }}</p>
          <p class="wb-muted gd-firstrun__d">{{ s.desc }}</p>
        </div>
        <!-- 三步的按钮分别指向**真的在别处**的东西（另两个模块）——
             这正是本仓"提示不是入口"那条结论要求的形态。
             ⚠️ 第三步 2026-10-28 起也带按钮了：它从"回到这一页点开左边一款"（假动作，
                用户本来就在这一页）改成了"去发货台的拿货页看要拿什么"—— 归款已经自动完成，
                这一页没有"第三件事"可做。**别再改回"就在这一页"那种说明**：
                那会让这一步既没有出口、也说不清它在讲什么。
             2026-10-14：「打开店铺登记」从"同页另一个页签"改为**跨模块**跳「基础数据」。 -->
        <button
          v-if="s.id === 'orders'"
          class="wb-btn wb-btn--primary gd-firstrun__act"
          type="button"
          data-act="fr-import-orders"
          @click="emit('import-orders')"
        >
          去「发货台」导入订单
        </button>
        <button
          v-else-if="s.id === 'shops'"
          class="wb-btn gd-firstrun__act"
          type="button"
          data-act="fr-open-registry"
          @click="emit('open-registry')"
        >
          打开「店名归一」
        </button>
        <button
          v-else
          class="wb-btn gd-firstrun__act"
          type="button"
          data-act="fr-goto-purchase"
          @click="emit('goto-purchase')"
        >
          去「发货台」看要拿什么
        </button>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
// 首次动线引导卡。**只渲染，不判断** —— 该不该出现由外壳算（`shouldShowFirstRunCard`），
// 三个步骤的文案来自 `../firstRun.ts` 的 `FIRST_RUN_STEPS`（与页头「?」共用同一份，
// 所以"这一页怎么开始"这句话在这两个地方不可能漂成两种说法）。
import { FIRST_RUN_STEPS } from '../firstRun';

const steps = FIRST_RUN_STEPS;

const emit = defineEmits<{
  /** 去「发货台」导入订单（跨模块跳转由外壳执行 —— 本组件不认识模块表） */
  'import-orders': [];
  /** 跳去「基础数据」的「店名归一」项（跨模块跳转由外壳执行，2026-10-14 前是同页页签） */
  'open-registry': [];
  /** 去「发货台」的「拿货」页签看要拿什么（第三步；归款已自动完成，这一页没有第三步可做） */
  'goto-purchase': [];
}>();
</script>

<style scoped>
/* 卡本身按内容定高：它上面还有两栏工作台要占满剩余高度（外壳是 flex 列）。 */
.gd-firstrun {
  flex: none;
}

.gd-firstrun__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.gd-firstrun__step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--wb-border);
}
.gd-firstrun__step:last-child {
  border-bottom: none;
}

.gd-firstrun__no {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 12px;
  font-weight: 600;
}

.gd-firstrun__body {
  flex: 1;
  min-width: 0;
}
.gd-firstrun__t {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
/* ⚠️ 说明文字必须允许换行：全局 `.wb-table td` 那类 `nowrap` 不在这里，
   但窄窗口下这行有 60 多个字 —— 不留换行会让按钮被顶出可视区（B 类裁切）。 */
.gd-firstrun__d {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.gd-firstrun__act,
.gd-firstrun__here {
  flex: none;
}
</style>
