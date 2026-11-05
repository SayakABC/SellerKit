// 规则求值隔离窗口冒烟（S0 的验收）：真 Electron + 真窗口 + 真 CSP，**不联网、不需凭据**。
//
//   npm run rule-eval:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/rule-eval-smoke.cjs
//   # 受限/沙箱环境（起不了 Chromium sandbox）加：--no-sandbox --disable-gpu
//
// 为什么必须有它：`tests/fieldProcessor.spec.ts` 验的是**编排**（分批、写回、错误聚合），
// 那里注入的求值器是 Node 里的 `new Function` —— 它既没有 CSP 也没有 electronAPI，
// 所以「能力隔离」在单测里是**结构性盲区**：把窗口换成 `new Function` 单测照样全绿。
// 本脚本验的正是单测测不到的三条不变量：
//   ① 窗口内 `window.electronAPI === undefined`（没有主 preload 的能力面）
//   ② 窗口内无 Node 能力（require / process 都取不到）
//   ③ 窗口不能出网（fetch 触发 CSP 违规，违规计数 > 0）
// 另加「与旧实现逐条一致」的一致性夹具，防"隔离之后算错了"。
//
// 反向判别（防恒绿）：
//   · ③ 不能只断言"表达式抛错"——连接被拒同样抛错，那会让"没拦"也通过；
//     故判据取窗口回传的 `cspViolations` 计数（规则若真能连网，计数恒 0）。
//   · 超时用例之后必须再跑一条正常求值，证明窗口已被重建（否则"崩了就再也不可用"是静默故障）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rule-eval-smoke-'));
app.setPath('userData', tmpDir);

const mod = require(path.join(ROOT, 'dist', 'electron', 'rule-eval-window.js'));

const results = [];

function record(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 旧实现（主窗口 `new Function`）的对照基线：只在本脚本里用于一致性比对 */
function legacyEval(code, fields) {
  const fn = new Function('fields', `"use strict"; return (${code})`);
  const v = fn(Object.freeze({ ...fields }));
  return v !== null && v !== undefined ? String(v) : null;
}

async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message ? err.message.slice(0, 260) : String(err));
    if (process.env.SK_SMOKE_TRACE) console.error(err && err.stack);
  }
}

/** 临时目录清理：Windows/沙箱下偶发 ENOTEMPTY，不该让清理失败改写退出码 */
function cleanupTmp() {
  try {
    cleanupTmp();
  } catch {
    /* 留着的临时目录不会影响结论 */
  }
}

app.whenReady().then(async () => {
  try {
    console.log('规则求值隔离窗口冒烟');

    // ---- 1. 基本求值 + 与旧实现一致（默认规则就是 fields["DNS"].split('.').slice(0,1)[0]）----
    const fixtures = [
      { fields: { a: '2', b: '3' }, code: 'Number(fields.a) * Number(fields.b)' },
      { fields: { DNS: 'aliexpress.com' }, code: `fields["DNS"].split('.').slice(0, 1)[0]` },
      { fields: { DNS: 'www.taobao.com.cn' }, code: `fields["DNS"].split('.').slice(0, 1)[0]` },
      { fields: { note: '  abc  ' }, code: 'fields.note.trim().toUpperCase()' },
      { fields: { price: '¥1,234.00', qty: '2' }, code: `String(parseFloat(fields.price.replace(/[^0-9.]/g, '')) * Number(fields.qty))` },
      { fields: { a: '1' }, code: 'null' },
      { fields: { a: '1' }, code: 'fields.missing' },
    ];

    await check('与旧实现逐条一致（7 条夹具）', async () => {
      for (const f of fixtures) {
        const r = await mod.evalJsExpressionBatch({ id: 'parity', code: f.code }, [f.fields]);
        const got = r.values[0] === undefined ? null : r.values[0];
        const want = legacyEval(f.code, f.fields);
        assert.strictEqual(got, want, `code=${f.code} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
      }
    });

    // ---- 2. 不变量 ①：窗口内没有 electronAPI ----
    await check('窗口内 window.electronAPI 不存在', async () => {
      const r = await mod.evalJsExpressionBatch({ id: 'cap1', code: 'typeof window.electronAPI' }, [{}]);
      assert.strictEqual(r.values[0], 'undefined', `实际是 ${r.values[0]}`);
    });

    // ---- 3. 不变量 ②：窗口内没有 Node 能力 ----
    await check('窗口内 require / process 不可达', async () => {
      const r = await mod.evalJsExpressionBatch(
        { id: 'cap2', code: '[typeof require, typeof process, typeof module].join(",")' },
        [{}],
      );
      assert.strictEqual(r.values[0], 'undefined,undefined,undefined', `实际是 ${r.values[0]}`);
    });

    // ---- 4. 不变量 ③：不能出网（判据是 CSP 违规计数，不是"抛错了"）----
    // fetch 是异步的，值取不到无所谓；关键是它必须被 CSP 拦下并触发违规事件。
    await check('窗口内 fetch 被 CSP 拦下（违规计数 > 0）', async () => {
      const r1 = await mod.evalJsExpressionBatch(
        { id: 'net1', code: `fetch('http://127.0.0.1:9/sk-should-be-blocked').then(()=>1).catch(()=>2)` },
        [{}],
      );
      // 给违规事件派发留一帧；下一批的返回值里能看到累计计数
      const r2 = await mod.evalJsExpressionBatch({ id: 'net2', code: '1+1' }, [{}]);
      assert.ok(
        r2.cspViolations > 0,
        `CSP 未拦截出网请求（cspViolations=${r2.cspViolations}）；若 fetch 被静默忽略，先确认窗口 CSP 是否还在`,
      );
      void r1;
    });

    // ---- 5. 每行错误只影响该行（不中断整批）----
    await check('单行抛错只让该行留空，其余行照常求值', async () => {
      const r = await mod.evalJsExpressionBatch(
        { id: 'rowerr', code: 'fields.a === "boom" ? (function(){ throw new Error("炸了") })() : fields.a' },
        [{ a: '1' }, { a: 'boom' }, { a: '3' }],
      );
      assert.deepStrictEqual(r.values, ['1', null, '3']);
      assert.strictEqual(r.errors.length, 1);
      assert.strictEqual(r.errors[0].index, 1);
    });

    // ---- 6. 编译失败要明确报错（不静默返回空）----
    await check('语法错误的规则 → 明确抛错，不是静默全空', async () => {
      await assert.rejects(
        () => mod.evalJsExpressionBatch({ id: 'badsyntax', code: '这是 不合法 的 表达式' }, [{ a: '1' }]),
        /编译失败/,
      );
    });

    // ---- 7. 死循环被超时打断，且窗口能重建 ----
    await check('死循环在超时内被终止，随后窗口可正常复用', async () => {
      const t0 = Date.now();
      await assert.rejects(
        // 死循环必须写成**表达式**（规则体是 `return (...)`，语句形式会先编译失败）
        () => mod.evalJsExpressionBatch({ id: 'loop', code: '(function(){while(true){}})()' }, [{}]),
        /超时/,
      );
      const cost = Date.now() - t0;
      assert.ok(cost >= 1500 && cost < 8000, `超时耗时异常：${cost}ms`);
      // 崩掉之后必须能重建 —— 否则"一次坏规则让整份导入从此不可用"是静默故障
      const r = await mod.evalJsExpressionBatch({ id: 'after-crash', code: 'fields.a' }, [{ a: 'ok' }]);
      assert.strictEqual(r.values[0], 'ok', '超时后窗口未恢复');
    });

    // ---- 8. 主进程侧入参兜底（不信任渲染层）----
    await check('超长 code 被拒（主进程侧上限）', async () => {
      await assert.rejects(
        () => mod.evalJsExpressionBatch({ id: 'huge', code: '1'.repeat(20001) }, [{}]),
        /超长/,
      );
    });
    await check('单批记录数超限被拒', async () => {
      await assert.rejects(
        () => mod.evalJsExpressionBatch({ id: 'many', code: '1' }, new Array(1001).fill({ a: '1' })),
        /超限/,
      );
    });

    const failed = results.filter((r) => !r).length;
    console.log('\n' + (failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`));
    mod.shutdownRuleEval();
    cleanupTmp();
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('SMOKE_THREW:', err && err.stack ? err.stack : err);
    try {
      mod.shutdownRuleEval();
    } catch {
      /* 关不掉不影响退出码 */
    }
    cleanupTmp();
    app.exit(2);
  }
});
