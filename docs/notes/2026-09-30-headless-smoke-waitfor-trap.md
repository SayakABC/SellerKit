# 无头冒烟的 `waitFor` 陷阱：轮询回调抛错 = 结果一个字都写不出来

**结论**：写假桥无头冒烟（`--dump-dom` 取 `#smoke-result` 那一类）时，`waitFor` 的**轮询回调必须 try/catch**；
回调里对 `null` 元素取属性会抛错，而 Promise **既不 resolve 也不 reject** → 外层 `await` 永久挂起 →
断言脚本走不到"把结果写进 `<pre id="smoke-result">`"那一步。

**症状极具误导性**：脚本只报「✗ 没抓到 #smoke-result（页面可能没挂载）」——
于是排查方向会被带到"产物是不是旧的 / 注入脚本是不是有语法错 / 假桥缺键"上，而**真正的错在断言代码自己**。

**正确写法**：

```js
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      var v;
      try { v = fn(); } catch (e) { return reject(e); }   // ← 这一行是关键的
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
```

## 取证（2026-09-30，写「今天」首页冒烟时踩到）

- 断言脚本里有一行 `card('go-picking').querySelector(...)`：`card()` 返回 `null`（元素不存在）→ 回调抛
  `Cannot read properties of null` → Promise 永不落地 → 页面无 `#smoke-result`。
- 同一份夹具下，加了 `try/catch` 后立刻报出**真实错误**：`SMOKE: FAILED at [nav] - Cannot read properties of null`。
- 另一个同源错误：**跳转类断言放在前面会让页面卸载** —— 点「生成待拣清单」会派发 `switch-module`，
  宿主要求切到别的模块，本页 DOM 随之消失；后续步骤再 `querySelector` 本页元素就是 `null`。
  ⇒ 涉及"切走"的断言**一律放最后一步**。
- 加固已同步到各内联副本：`picking-ui-smoke` / `order-profit-ui-smoke` / `today-ui-smoke` / `goods-ui-smoke` /
  `shipping-rate-ui-smoke`（岛侧冒烟一律照抄这段 `waitFor`）。

> 关联：技能 `esm-spa-headless-smoke`（file:// 被 CORS 拦、stale 节点、表单值不在 textContent 里）、
> `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md` §2（岛侧同类检查项）。