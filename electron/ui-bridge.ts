// electron/ui-bridge.ts
// 主进程 →「界面意图」的单向下发通道（打开某个模块 / 侧栏徽标）。
//
// ---- 为什么需要它（2026-11-04）----
// 两件事都发生在**渲染层看不见的地方**，而它们的后果都在界面上：
//   ① 后台自动收信收到新邮件 → 弹系统通知；用户点通知时人可能正停在别的模块上，
//      只把窗口拿出来（旧行为）等于"我点了通知，它把我扔回上次那页"。
//   ② 侧栏的「邮件」角标要显示未读数，而收件箱模块**没被打开时**根本不存在，
//      它自己的 store 无从上报 —— 只能由主进程（未读数的唯一来源）推给外壳。
//
// ---- 三条纪律 ----
// ① **主进程不猜界面状态**：本层只发"打开 mail"这种**意图**，不做"当前在哪个模块"的判断
//    （渲染层的 activate 对同模块本来就会早退，重复下发无副作用）。
// ② **不许丢消息**：窗口可能在 (a) 还没建 (b) 正在加载 (c) 已销毁。三种情况 `send` 都发不出去，
//    而丢一条的后果是"点了通知没反应"—— 最难查的一类。所以这里保留最后一份状态：
//    `did-finish-load` 时 `flushUiBridge()` 重放（徽标按模块去重，只补最后一份；打开意图只留一条）。
// ③ **徽标缺席 ≠ 0**：`count: null` 明确表示"没有徽标"，渲染层据此**不渲染**，
//    而不是画一个 0（"还没数完"和"确实是零"在用户眼里会一模一样）。

export {};

/** 单个模块入口的徽标（`count: null` = 清掉，不画） */
export interface NavBadgePayload {
  /** 数值；null = 该模块此刻没有徽标 */
  count: number | null;
  /** 悬停说明（"12 封未读邮件"） */
  title?: string;
  /** 待办性质：> 0 时用警示色（与侧栏二级项同一套配色语义） */
  todo?: boolean;
}

type OpenModuleIntent = { moduleId: string; action?: string };

/** 各模块最后一份徽标（重放用；按 moduleId 去重，后到的覆盖先到的） */
const badges = new Map<string, NavBadgePayload>();
/** 还没送出去的"打开模块"意图（至多一条：用户连点两次通知，只认最后一次） */
let pendingOpen: OpenModuleIntent | null = null;
let getWindow: (() => any) | null = null;

/** 注入主窗口引用（`main.ts` 创建窗口后调用） */
export function setUiBridgeWindow(fn: () => any): void {
  getWindow = fn;
}

/**
 * 发一条消息。
 * @param force 跳过"页面是否加载中"的判断。只在 `did-finish-load` 的重放里用：
 *   该事件触发时 `webContents.isLoading()` **仍然是 true**（它要等到 `did-stop-loading`
 *   才翻转），照常判断会让重放整批被挡掉 —— 表现是"侧栏没有角标、点通知没反应"。
 *   重放时机本身已经证明页面就绪（preload 在 document start 就注册好了监听）。
 * @returns true = 已送到渲染层；false = 窗口不可用（需要调用方自己留着，等 `flushUiBridge`）
 */
function send(channel: string, payload: unknown, force = false): boolean {
  const win = getWindow?.();
  if (!win || win.isDestroyed?.()) return false;
  try {
    // 加载中的 webContents 收不到消息（Electron 直接丢弃，不报错）—— 必须当成"没送到"
    if (!force && win.webContents?.isLoading?.()) return false;
    win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * 页面就绪后重放"最后一份状态"。
 * 调用点：`main.ts` 的 `did-finish-load`（窗口新建 / 刷新 / 崩溃重载都会走到）。
 */
export function flushUiBridge(): void {
  for (const [moduleId, badge] of badges) {
    send('nav-badge', { moduleId, ...badge }, true);
  }
  if (!pendingOpen) return;
  const intent = pendingOpen;
  pendingOpen = null;
  if (!send('open-module', intent, true)) pendingOpen = intent;
}

/**
 * 请求外壳切到某个模块（通知点击 / 托盘菜单等"用户不在界面前"的入口）。
 *
 * @param moduleId 模块 id（`src/registry.generated.ts` 里的键，如 `mail`）
 * @param action 模块内二级动作（交给目标模块的 switch-module 消费，见 `src/core/services/shell.ts`）
 */
export function openModule(moduleId: string, action?: string): void {
  const id = String(moduleId || '').trim();
  if (!id) return;
  const intent: OpenModuleIntent = action ? { moduleId: id, action } : { moduleId: id };
  pendingOpen = intent;
  if (send('open-module', intent)) pendingOpen = null;
}

/** 推送某模块的侧栏徽标（`badge = null` 撤销） */
export function pushNavBadge(moduleId: string, badge: NavBadgePayload | null): void {
  const id = String(moduleId || '').trim();
  if (!id) return;
  const payload: NavBadgePayload = badge
    ? {
        count: Number.isFinite(Number(badge.count)) ? Number(badge.count) : 0,
        title: badge.title ? String(badge.title).slice(0, 80) : undefined,
        todo: Boolean(badge.todo),
      }
    : { count: null };
  if (badge) badges.set(id, payload);
  else badges.delete(id);
  send('nav-badge', { moduleId: id, ...payload });
}

/** 当前缓存的徽标（诊断 / 测试用） */
export function getUiBridgeState(): { badges: Record<string, NavBadgePayload>; pendingOpen: OpenModuleIntent | null } {
  return { badges: Object.fromEntries(badges), pendingOpen };
}
