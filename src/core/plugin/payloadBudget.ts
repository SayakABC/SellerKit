// src/core/plugin/payloadBudget.ts
// 桥层载荷体积预算（M-02）。
//
// ---- 为什么需要 ----
// UI 岛 → 宿主的 `__sk.call` 载荷原来是**完全无上限**的：桥只校验 arity，不看体积。
// 而宿主侧 excel-copy 域的规模约束是"记录数 × 字段数 × 单值长度"三个独立上限
// （50000 × 256 × 20000 字符）—— 组合起来约 250 GB，这不是约束，只是"防止无限"。
// 岛（或岛的 bug，例如把整个记录集重复拼进载荷）发出这种量级的数据时，
// 结构化克隆、消毒逐字段切片、规则引擎三轮遍历都会压在执行线程上，
// 中间没有任何一道防线会先停下它。
//
// ---- 这不是万能的 ----
// `postMessage` 的结构化克隆发生在**本函数之前**（载荷已到宿主才轮到这里），
// 所以它拦不住克隆本身的开销；它的价值在于**不让超限载荷继续进入下游**：
// 消毒（每个字段再复制一份字符串）+ 规则引擎（对每条记录逐规则求值）。
// 要连克隆一起挡住，只能把限制做到岛侧（不可信，等于不设）或改用可计量的传输协议。
//
// ---- 为什么用"估算"而不是 JSON.stringify ----
// stringify 本身就要完整遍历并分配一个巨大字符串 —— 拿它做门禁是把攻击代价转嫁给自己。
// 这里做的是**带早退**的估算：一旦累计超预算或节点数异常即返回，
// 最坏代价与预算成正比，而不是与载荷大小成正比。

/** 单次调用的载荷体积上限（近似字节）。正常业务量级为 MB 级，此处留足余量只拦病态载荷 */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/**
 * 估算 value 的近似体积是否超过 budget。超过即返回 true（**提前返回**，不遍历完整个对象）。
 *
 * 口径：字符串按字符数、其他原始值按固定 8 字节、容器不计自身开销。
 * 对 UTF-16 内存占用而言是偏低估计，作为门禁够用（真要卡精度得看实际编码）。
 *
 * `maxNodes` 防的是另一种病态：海量小值（如 1280 万个空串）体积估算为 0，
 * 却能把估算本身的遍历变成新的耗时点。
 *
 * @param value 待估算的值（通常是桥载荷的 args 数组）
 * @param budget 字节预算
 * @param maxNodes 最多访问多少个节点，超出即视为超预算
 */
export function exceedsByteBudget(
  value: unknown,
  budget: number = MAX_PAYLOAD_BYTES,
  maxNodes = 50000,
): boolean {
  let bytes = 0;
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    if (++nodes > maxNodes) return true;
    const cur = stack.pop();
    if (typeof cur === 'string') {
      bytes += cur.length;
    } else if (typeof cur === 'number' || typeof cur === 'boolean') {
      bytes += 8;
    } else if (Array.isArray(cur)) {
      // 先看长度：1280 万的数组不该先被逐项塞进栈里
      if (cur.length > maxNodes) return true;
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
    } else if (cur && typeof cur === 'object') {
      const vals = Object.values(cur as Record<string, unknown>);
      if (vals.length > maxNodes) return true;
      for (let i = 0; i < vals.length; i++) stack.push(vals[i]);
    }
    if (bytes > budget) return true;
  }
  return false;
}
