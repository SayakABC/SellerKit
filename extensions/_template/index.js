// extensions/__PLUGIN_ID__/index.js —— 脚手架插件入口（自包含单文件 ESM，无任何 import）
// 沙箱边界（信任分级 L2）：无 window/DOM/electronAPI/Node；一切能力走 ctx.host.*，
//   未在 manifest.capabilities 声明的调用会被权限门拒绝（PluginPermissionError + 审计）。
// 宿主加载约定：
//   - 目录 <userData>/plugins/__PLUGIN_ID__/，entry = ./index.js（manifest.entry，仅 ./ 相对路径）；
//   - default 导出 PluginLifecycle = { activate(ctx), deactivate?(ctx) }；
//   - 外置插件为后台贡献型：命令进 ⌘K「外置插件命令」，不支持视图。

let disposers = [];

export default {
  async activate(ctx) {
    const { log } = ctx;
    log.info('__PLUGIN_ID__ activate');

    // 1) ⌘K 命令（order 控制显示顺序，升序、缺省 0）
    disposers.push(
      ctx.contributions.registerCommand({
        id: 'hello',
        title: '__PLUGIN_ID__: 打招呼',
        order: 1,
        run: async () => {
          const visits = (await ctx.storage.load('visits')) ?? 0;
          await ctx.storage.save('visits', Number(visits) + 1);
          ctx.host.ui.notify({
            kind: 'success',
            text: `👋 来自插件 __PLUGIN_ID__（第 ${Number(visits) + 1} 次调用）`,
          });
        },
      }),
    );

    // 2) 事件订阅（type 以 * 结尾为通配订阅，如监听全部插件生命周期事件）
    disposers.push(
      ctx.bus.on('plugin:*', (payload, meta) => {
        log.info('bus plugin:* →', meta && meta.eventType, payload);
      }),
    );

    // 3) 需要更多宿主能力时：先在 manifest.json capabilities 显式声明
    //    合法能力域仅：storage（跨命名空间）/ http / clipboard / dialog；
    //    ctx.storage 自身命名空间直通、ui/env 默认放行——均无需且不可声明（写了安装校验会失败）。
  },
  async deactivate(ctx) {
    // 停用钩子：清理命令/订阅等资源
    while (disposers.length) disposers.pop()();
    ctx.log.info('__PLUGIN_ID__ deactivate');
  },
};
