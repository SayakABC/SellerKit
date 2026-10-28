// electron/browser-open.ts
// 「打开网页」的统一出口 —— `open-external` 通道的唯一实现（见 clipboard-handlers.ts）。
//
// 行为：**优先交给 Chrome**打开；Chrome 用不了（没装 / 起不来）时才回落
// `shell.openExternal`（系统默认浏览器）。绝不返回"打开失败"。
//
// 为什么优先 Chrome（2026-10-16）：SellerKit 的采集能力由 Chrome MV3 扩展
// （SellerKitExtensions / ae-profit）提供，「打开店铺」这个按钮的**下一步动作**就是点扩展的采集按钮。
// 落到别的浏览器 = 那个浏览器里没装扩展 = 动线断在"页面开了但找不到按钮"，而用户看不出原因。
//
// ⚠️ 注意这两件事不是一回事，别合并：
//   · 「用哪个浏览器」在本次实现里是**固定的策略**（Chrome 优先），不是用户偏好（无设置项）；
//   · 「Chrome 到底能不能用」是**运行时事实**（探测结果），随时可能为假 ⇒ 探测失败必须回落，
//     而不是把一个点了没反应的按钮留在界面上。回落代价只是"少了采集扩展"，报错代价是"入口失效"。
//
// 平台差异（判据不同，别抄一份）：
//   · macOS：`open -b <bundle-id>`。找不到 app 时**命令本身是成功的**，失败只体现在退出码上 ⇒ 必须看退出码。
//   · Windows：先按已知安装路径找 `chrome.exe`（用户级安装最常见，不能只看 Program Files）。
//     chrome.exe 若已在运行，它自己就是常驻进程，`exit` 可能永远不来 ⇒ 靠超时判成功。
//   · Linux：按 PATH 依次试常见命令名，靠 `error`(ENOENT) 判定"这个命令不存在"。

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { shell } from 'electron';

/** Chrome 的 bundle id（macOS 用 `open -b` 定位：比 app 显示名稳，改名/中文系统名都不影响命中） */
const CHROME_BUNDLE_ID = 'com.google.Chrome';

/** Linux 下按 PATH 依次尝试的 Chrome 命令名 */
const LINUX_CHROME_CMDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * 探针最长等待（ms）：到点仍无 error / exit ⇒ 进程还活着 ⇒ 认为是浏览器本身起来了，判成功。
 * 取值只要覆盖"命令已启动但还没退出"这一档即可，故意短（用户在等，不是后台任务）。
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * 起一个分离的进程并判断是否**确认启动成功**。
 * 失败只有两条路：`error`（命令不存在 / 无权限）或 `exit` 退出码非 0（macOS 的 `open -b` 找不到 app）。
 */
function spawnProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    let child: ChildProcess;
    try {
      // detached + stdio:'ignore'：浏览器是常驻进程，别让它的生命周期挂在本应用上；
      // windowsHide：避免 spawn chrome.exe 时闪一个控制台窗口。
      child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    } catch {
      // spawn 同步抛出（命令名非法等）—— 直接按"起不来"计，绝不外抛
      settled = true;
      resolve(false);
      return;
    }

    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    // 让 Electron 退出时不被这个子进程拦住（exit 监听仍在，只在还活着时生效）
    child.unref();
  });
}

/** Windows 上 Chrome 的已知安装位置（用户级安装优先：`%LOCALAPPDATA%` 才是默认落点） */
function winChromePaths(): string[] {
  const out: string[] = [];
  const local = process.env['LOCALAPPDATA'];
  const pf = process.env['ProgramFiles'];
  const pf86 = process.env['ProgramFiles(x86)'];
  if (local) out.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf) out.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf86) out.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return out;
}

/** 尝试交给 Chrome 打开；返回是否**确认**已由 Chrome 接管（false = 交给调用方回落） */
async function openInChrome(url: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    return spawnProbe('open', ['-b', CHROME_BUNDLE_ID, url]);
  }
  if (process.platform === 'win32') {
    for (const exe of winChromePaths()) {
      if (existsSync(exe)) return spawnProbe(exe, [url]);
    }
    return false;
  }
  for (const cmd of LINUX_CHROME_CMDS) {
    if (await spawnProbe(cmd, [url])) return true;
  }
  return false;
}

/**
 * 打开一个 http/https 链接（协议白名单由调用方 `open-external` 先做）。
 * 返回实际接管方，供日志 / 将来界面提示用；**不**用于决定成败（两种结果都是成功）。
 */
export async function openUrlInPreferredBrowser(url: string): Promise<'chrome' | 'system'> {
  if (await openInChrome(url)) return 'chrome';
  // 回落：系统默认浏览器。这里不 catch —— 打不开时由 handler 统一转成用户能看懂的提示。
  await shell.openExternal(url);
  return 'system';
}
