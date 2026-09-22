// electron/user-file-allowlist.ts
// 「用户显式选择过的文件」白名单 —— 收紧按路径读写的四个 IPC 通道（H-02）。
//
// ---- 为什么需要它 ----
// `read-file` / `save-template` / `check-file-exists` / `order-read-local-image` 原先接受
// **任意绝对路径**（前三个连大小上限都没有）。而它们在 `src/` 里的调用点只有一处：
// 渲染层的插件内核 `src/core/plugin/host.ts` 业务库白名单 —— 也就是「声明了对应 db 域的 UI 岛」。
// 于是第三方岛只要在 manifest 里写上 db 域 + op 名，就拿到了「全盘读 + 任意文件覆写」，
// 而安装界面只展示 `db` 这样一个能力 id 标签，用户无从判断自己同意了什么。
// 收敛后，岛的正当流程（对话框选文件 → 读/写该文件）完全不受影响。
//
// ---- 判据：只有两类路径被放行 ----
//   ① 宿主自己计算出的路径（如内置模板文件），由调用方经 builtinPaths 传入 —— 不接受外部指定；
//   ② 用户在本机经文件对话框**真实选过**的文件：select-excel / select-template 落名单。
//      必须跨会话持久化 —— 模板路径会被岛写进自己的配置，重启后仍要能读写同一个文件。
//
// ---- 比较方式 ----
// 一律 realpath 归一后再比。既挡住「拿软链指向别处」的绕过，也避免 macOS 上
// /var 与 /private/var、以及大小写差异导致的同一路径被误判为不匹配。
//
// ---- 边界（有意不做的） ----
// 不做「不透明句柄」（路径永不经过插件）：那需要改 dialog 返回值协议 + 岛侧全套调用点，
// 属于破坏性改造。当前名单版把"任意文件"收成"用户点过的那几个文件"，已消掉最要紧的那一步。

import * as fs from 'fs';
import * as path from 'path';

/** electron-store 上的键名（字符串数组，存 realpath 形式的绝对路径） */
const STORE_KEY = 'approvedUserFiles';
/** 名单上限（FIFO 淘汰）：正常使用远达不到，仅为防无界增长 */
const MAX_APPROVED = 200;
/** save-template 的单次内容上限（模板是纯文本，2MB 已远超正常规模） */
export const MAX_TEMPLATE_CHARS = 2 * 1024 * 1024;

/** 所需的最小 store 接口：main.ts 的 electron-store 与 SimpleStore 都满足 */
interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

let kv: KeyValueStore | null = null;
let approved: string[] = [];

/** 归一化：能 realpath 就 realpath（解析软链 + 统一大小写/别名），否则退回绝对路径 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * 启动时装载名单。装载失败按「空名单」处理 —— 方向更严，不会误放行。
 * 必须在任何读写通道被调用之前执行（main.ts 里紧跟在 store 建好之后）。
 */
export function initApprovedUserFiles(store: KeyValueStore | null): void {
  kv = store;
  approved = [];
  if (!store) return;
  try {
    const v = store.get(STORE_KEY);
    if (Array.isArray(v)) {
      approved = v
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .slice(-MAX_APPROVED);
    }
  } catch {
    /* 读取失败 = 空名单 */
  }
}

/** 把用户经对话框选中的文件加入名单（幂等；持久化失败不影响本次会话放行） */
export function approveUserFile(filePath: unknown): void {
  if (typeof filePath !== 'string' || !filePath) return;
  const key = canonical(filePath);
  if (approved.includes(key)) return;
  approved.push(key);
  if (approved.length > MAX_APPROVED) approved = approved.slice(-MAX_APPROVED);
  try {
    kv?.set(STORE_KEY, approved);
  } catch {
    /* 持久化失败：本次会话仍放行，下次需重新选择 */
  }
}

/**
 * 是否允许按该路径读写。
 * @param builtinPaths 宿主自己计算出的、无条件放行的路径（如内置模板文件）
 */
export function isUserFileAllowed(filePath: unknown, builtinPaths: string[] = []): boolean {
  if (typeof filePath !== 'string' || !filePath) return false;
  const key = canonical(filePath);
  for (const b of builtinPaths) {
    if (b && canonical(b) === key) return true;
  }
  return approved.includes(key);
}

/** 名单长度（供诊断 / 测试断言用） */
export function approvedUserFileCount(): number {
  return approved.length;
}
