// 拆 `ApiResult` 的小工具（`api.ts` / `productIo.ts` / 各视图共用）。
//
// `ipc.*` 一律返回 `ApiResult<T>` = `{ success, data?, error? }`，而视图层关心的是
// "要么拿到数据、要么抛异常"，于是各页都要写一遍 `if (!r.success) throw ...`。
//
// 为什么保留原始 `error` 文案：主进程的报错**本来就是给人看的**（"该编码已存在"、
// "已有拿货单/付款记录，不能删除"），换一句泛化的"操作失败"会把可行动的线索丢掉。
import type { ApiResult } from '@/core/services/ipc';

export function unwrapApi<T>(r: ApiResult<T>): T {
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

/**
 * 同上，但直接吃 `ipc.*(...)` 返回的 Promise。
 *
 * 为什么要有这一个：`unwrapApi(ipc.foo())` 是**编译得过但推理错**的写法 ——
 * TS 会拿 `Promise<ApiResult<T>>` 去匹配 `ApiResult<T>`，匹配不上就退化成
 * `T = Promise<ApiResult<...>>`，于是返回类型变成 `Promise<ApiResult<...>>`，
 * 一路把调用方的字段访问变成 `any`/报错（本轮 `vue-tsc` 一次抓出 30 处）。
 * 分成两个函数后，"传结果"和"传 promise"各有各的重载，不会静默退化。
 */
export async function unwrapAsync<T>(p: Promise<ApiResult<T>>): Promise<T> {
  return unwrapApi(await p);
}

/**
 * 用户取消文件对话框 —— 主进程回的是 `{ success:false, error:'User canceled' }`。
 *
 * ⚠️ 这**不是失败**：取消是正常操作，既不该 `unwrapApi` 抛异常，也不该弹错误提示。
 *    之前的写法 `const sel = unwrapApi(await ipc.selectExcel()); if (!sel) return;`
 *    会被看成"取消即报错"，用户点取消后界面上出现一个红条（实测主进程
 *    `select-excel` / `select-image` 都会在这条路径上返回 success=false）。
 */
export function isCanceled(r: { success: boolean; error?: string }): boolean {
  return !r.success && /cancel/i.test(r.error ?? '');
}
