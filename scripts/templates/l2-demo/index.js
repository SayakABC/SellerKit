// sk-hello：外置插件示例入口（自包含单文件 ESM，无任何 import）
// 宿主加载约定：
//  - 目录 <userData>/plugins/sk-hello/，entry = ./index.js（manifest.entry）；
//  - 入口 default 导出 PluginLifecycle = { activate(ctx), deactivate?(ctx) }；
//  - ctx.manifest 为校验后的 manifest；ctx.host 已过权限门（未声明的能力调用会抛 PluginPermissionError 并写审计）。
// 演示点：
//  1. ⌘K 命令（后台贡献型，激活即注册）；
//  2. ctx.storage 命名空间数据读写（隔离即安全，不过权限门）；
//  3. ctx.host.clipboard.writeText（已声明 clipboard → 放行）；
//  4. ctx.host.dialog.openFile / 越权命名空间（未声明 → 拒绝，异常 message 可读 + 审计）。

export default {
  async activate(ctx) {
    const { log } = ctx;
    log.info('sk-hello activate');
    ctx.contributions.registerCommand({
      id: 'hello',
      title: '外置插件 · 你好',
      run: () => {
        ctx.host.ui.notify({ kind: 'success', text: '👋 来自外置插件 sk-hello' });
      },
    });
    ctx.contributions.registerCommand({
      id: 'counter',
      title: '外置插件 · 计数（数据读写）',
      run: async () => {
        const visits = (await ctx.storage.load('visits')) ?? 0;
        const next = Number(visits) + 1;
        await ctx.storage.save('visits', next);
        ctx.host.ui.notify({ kind: 'info', text: `sk-hello 被调用 ${next} 次（数据落 modules.sk-hello）` });
      },
    });
    ctx.contributions.registerCommand({
      id: 'copy',
      title: '外置插件 · 复制文本（已声明能力 → 放行）',
      run: async () => {
        await ctx.host.clipboard.writeText('来自外置插件 sk-hello 的剪贴板内容');
        ctx.host.ui.notify({ kind: 'success', text: '已写入剪贴板（clipboard 能力放行）' });
      },
    });
    ctx.contributions.registerCommand({
      id: 'deny',
      title: '外置插件 · 权限演示（未声明 → 拒绝）',
      run: async () => {
        // 1) dialog 未声明 → 权限门拒绝
        try {
          await ctx.host.dialog.openFile({ kind: 'directory' });
          ctx.host.ui.notify({ kind: 'info', text: '意外：dialog 竟然放行了？' });
        } catch (e) {
          ctx.host.ui.notify({ kind: 'error', text: `dialog 被拒: ${e instanceof Error ? e.message : String(e)}` });
        }
        // 2) 越权命名空间：app-shell 不属于 sk-hello → 拒绝（自身命名空间则恒放行）
        try {
          await ctx.host.storage.load('app-shell');
          ctx.host.ui.notify({ kind: 'info', text: '意外：越权命名空间竟然放行了？' });
        } catch (e) {
          ctx.host.ui.notify({ kind: 'error', text: `越权命名空间被拒: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
    });
  },
  async deactivate(ctx) {
    ctx.log.info('sk-hello deactivate');
  },
};
