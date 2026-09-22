<script setup lang="ts">
// 设置面板（设置 → 账号安全）：安全存储状态、店铺套数据概览、复制模板说明。
// 设置面板（设置 → 账号安全）：安全存储状态、店铺套数据概览、复制模板说明。
// 布局契约（2026-09-18 修复样式错乱）：本组件只是「一叠卡片」（flex 列 + gap），
// 不自带 height/overflow/padding——页面滚动与留白统一由父级（SettingsView 的 .settings-page）提供。
// 背景：根节点曾写 height:100% + overflow-y:auto，在某些 flex 容器里百分比高度坍缩为 0，
// 内容溢出绘制到容器外，表现为面板消失/与后续面板重叠。
import { onMounted } from 'vue';
import { COPY_TEMPLATES, STATUS_META, useShopAccountsStore } from '../store';
import IconGlyph from './IconGlyph.vue';

const store = useShopAccountsStore();

onMounted(async () => {
  if (!store.initialized) {
    await store.init();
    return;
  }
  await store.loadSummary();
});
</script>

<template>
  <div class="security-settings">
    <section class="panel">
      <h3 class="panel-title">
        <IconGlyph name="shield" :size="14" />
        密码存储安全
      </h3>
      <div class="status-card" :class="store.secureStorage ? 'is-ok' : 'is-warn'">
        <IconGlyph :name="store.secureStorage ? 'check' : 'alert'" :size="14" />
        <div class="status-text">
          <strong>{{ store.secureStorage ? '系统安全存储可用' : '系统安全存储不可用' }}</strong>
          <p>
            {{
              store.secureStorage
                ? '店铺密码 / 邮箱密码 / 支付宝支付密码 / 紫鸟密码 / ERP密码均通过系统钥匙串（Keychain / DPAPI）加密后落库，界面列表不返回明文。'
                : '当前系统无法提供加密存储，密码将以降级方式保存，存在被本机其它程序读取的风险，建议尽快修复系统钥匙串后重新保存密码。'
            }}
          </p>
        </div>
      </div>
      <ul class="rule-list">
        <li>列表接口永不返回明文密码，仅在「临时查看」（8 秒自动隐藏）或「复制密码」时按需解密。</li>
        <li>编辑时留空表示不修改该密码，填写新值才会覆盖。</li>
        <li>隐私模式可一键全局隐藏所有密码，适合投屏 / 直播 / 录屏场景。</li>
      </ul>
    </section>

    <section class="panel">
      <h3 class="panel-title">
        <IconGlyph name="table" :size="14" />
        数据概览
      </h3>
      <div class="overview">
        <div class="overview-total">
          <span class="overview-num">{{ store.summary.total }}</span>
          <span class="overview-label">店铺套总数</span>
        </div>
        <div class="overview-status">
          <div v-for="s in STATUS_META" :key="s.value" class="status-item">
            <span class="dot" :class="`tone-${s.tone}`" />
            <span class="status-name">{{ s.label }}</span>
            <span class="status-count">{{ store.summary.byStatus[s.value] || 0 }}</span>
          </div>
        </div>
      </div>
      <div v-if="store.summary.platforms.length" class="platform-block">
        <span class="block-label">平台分布</span>
        <div class="platform-tags">
          <span v-for="p in store.summary.platforms" :key="p.platform" class="platform-tag">
            {{ p.platform }}（{{ p.count }}）
          </span>
        </div>
      </div>
      <p v-else class="empty-tip">暂无平台数据。</p>
    </section>

    <section class="panel">
      <h3 class="panel-title">
        <IconGlyph name="copy" :size="14" />
        一键复制模板
      </h3>
      <p class="block-hint">
        列表的「复制」按钮按以下模板拼装文本，可直接粘贴使用；「全部字段」会跳过未填写的项。
      </p>
      <div class="template-list">
        <div v-for="t in COPY_TEMPLATES" :key="t.id" class="template-item">
          <span class="template-name">{{ t.label }}</span>
          <span class="template-fields">{{ t.fields.map((f) => f.label).join(' + ') }}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <h3 class="panel-title">
        <IconGlyph name="lock" :size="14" />
        邮箱统一收件
      </h3>
      <div class="coming-soon">
        <span class="tag">已上线</span>
        <p>
          已支持只读接入 IMAP 邮箱（163/126 等），在应用内集中查看各店铺邮箱的收件。
          到「账号库」任选一行点「接入邮箱」，或在本分类切换到「邮件收件箱」页调整轮询与缓存。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.security-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--wb-text);
}
.panel {
  padding: 14px 16px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}
.panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.status-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  font-size: 12.5px;
}
.status-card.is-ok {
  border-color: var(--wb-success);
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.status-card.is-warn {
  border-color: var(--wb-warning);
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.status-text strong {
  font-size: 12.5px;
}
.status-text p {
  margin: 4px 0 0;
  color: var(--wb-text-muted);
  line-height: 1.6;
}
.rule-list {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 1.9;
}
.overview {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.overview-total {
  display: flex;
  flex-direction: column;
}
.overview-num {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
}
.overview-label {
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.overview-status {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.status-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wb-text-muted);
}
.dot.tone-success {
  background: var(--wb-success);
}
.dot.tone-warning {
  background: var(--wb-warning);
}
.dot.tone-danger {
  background: var(--wb-danger);
}
.status-name {
  color: var(--wb-text-muted);
}
.status-count {
  font-weight: 600;
}
.platform-block {
  margin-top: 12px;
}
.block-label {
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.block-hint {
  margin: 0 0 8px;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.platform-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.platform-tag {
  padding: 2px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11.5px;
}
.empty-tip {
  margin: 8px 0 0;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.template-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.template-item {
  display: flex;
  /* 字段多的模板（全部字段）会换行，改为顶部对齐更整齐 */
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface-2);
  font-size: 12.5px;
}
.template-name {
  flex-shrink: 0;
  font-weight: 600;
}
.template-fields {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--wb-text-muted);
  line-height: 1.6;
  word-break: break-word;
}
.coming-soon {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.7;
}
.tag {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent);
  font-size: 11px;
}
</style>
