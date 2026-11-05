<script setup lang="ts">
// src/modules/mail/MailView.vue
// 「邮件」一级模块的页壳（2026-10-17 从「基础数据」左导航的第二项独立出来）。
//
// 这一层只做两件事：**页头**（标题 / 一句说明 / 未读计数）与收件箱的容器。
// 收件箱本体仍是 `MailInboxView.vue`（列表 + 详情 + 同步/清理，一个字节没改）。
// 为什么页头在这儿而不是在收件箱里：收件箱以后可能多出「发件箱 / 归档」这类同级视图，
// 标题属于模块，不属于其中某一个视图。
//
// ⚠️ 「接入邮箱」抽屉**不在这里**：它的触发点是账号行（`AccountsPanel.vue`），
//    挂到本页会造成两个蒙层，且从账号页点开时本模块根本不在场。见该组件头注释。
//
// 未读计数：左导航不再有徽标位（那是「基础数据」左导航的资料项才有的东西），
// 所以把"有几封没读"放在页头 —— 它是用户进这一页最想知道的一个数。
import { onMounted } from 'vue';
import MailInboxView from './MailInboxView.vue';
import { useMailStore } from './mailStore';

const mail = useMailStore();

onMounted(() => {
  // 未读计数要用；收件箱自己也会 ensureReady（幂等，见 store 实现）
  void mail.ensureReady();
});
</script>

<template>
  <div class="wb-page mv-view">
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">邮件</h1>
        <p class="wb-head__desc">
          店铺邮箱的收件箱：本地缓存、只读预览，筛选不触网 —— 只有点「同步全部」才联网。
        </p>
      </div>
      <div class="wb-head__actions">
        <span v-if="mail.unread" class="mv-unread" data-act="mail-unread">{{ mail.unread }} 封未读</span>
      </div>
    </header>

    <MailInboxView />
  </div>
</template>

<style scoped>
.mv-unread {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
</style>
