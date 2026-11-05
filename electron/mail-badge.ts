// electron/mail-badge.ts
// 把「未读邮件数」推到侧栏徽标（主进程 → `nav-badge` 广播）。
//
// ---- 为什么单独一个文件 ----
// 未读数有三个触发点，但**只能有一处口径**：
//   ① 同步收尾（`mail-engine.ts` 的 done）—— 服务端可能把信标成已读，新收的信也在这里进来；
//   ② 本地已读标记（`mail-handlers.ts` 的 mail-message-read）—— 用户在界面上点开一封；
//   ③ 删除类操作（清理超窗邮件 / 解绑账号）—— 行没了，未读数会掉。
// 三处都调本函数，函数内部只读 `mailStats().unread`（与邮件页页头、列表角标同一实现），
// 于是"侧栏显示 3"和"页头显示 3"结构上不可能对不上。
//
// 不做任何"未读数 ±1"的增量推算：读状态也可能是服务端改的（IMAP 只读，我们只在同步时把
// 服务端 seen 落库），增量推算在这种场景下必然漂移。每次重算整条 SQL 的代价是三次 COUNT，
// 与本机的其它统计查询同量级 —— 用确定性换那点开销，值得。

export {};

import { mailStats } from './mail-db';
import { pushNavBadge } from './ui-bridge';

/**
 * 重算未读数并推一次徽标。
 * @returns 当前未读数（调用方多半用不到，便于自测断言）
 */
export function publishMailUnreadBadge(): number {
  let unread = 0;
  try {
    unread = mailStats().unread;
  } catch (err: any) {
    // schema 还没建好 / 库被锁：不推，等下一次触发 —— 徽标是锦上添花，不许影响业务调用链
    console.warn('[mail-badge] 读未读数失败：', err?.message || err);
    return 0;
  }
  if (unread > 0) {
    pushNavBadge('mail', { count: unread, title: `${unread} 封未读邮件`, todo: true });
  } else {
    pushNavBadge('mail', null);
  }
  return unread;
}
