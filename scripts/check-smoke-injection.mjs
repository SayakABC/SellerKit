// scripts/check-smoke-injection.mjs
// 守卫：`*-ui-smoke.mjs` 里那两段**注入用的模板字符串**内部不许出现反引号。
//
//   node scripts/check-smoke-injection.mjs      （也挂在 `npm run verify` 上）
//
// 为什么需要它（2026-11-01 一天内踩了三次）：
//   `const FAKE_BRIDGE = \`<script> ... </script>\`;` 这种写法把一个 JS 脚本塞进模板字符串，
//   于是在里面写注释时**顺手用反引号标代码**（"用 \`waitFor\` 等"）就会把字符串提前结束。
//   症状是 `node --check` 报一句莫名其妙的 `SyntaxError: Unexpected identifier 'waitFor'`，
//   而报错行号指向注释中间 —— 排查方向容易被带到"这行注释哪里错了"，而不是"这个反引号不是注释"。
//
//   靠人记不管用（一天三次已经证明），所以做成检查：报错时**直接指出行号和那个反引号**，
//   并给出改法（改用「」/去掉反引号）。
//
// 判定方式：从 `= \`<script` 开始，到第一个 `</script>\`;` 结束，取中间那段**文件原文**，
//   只要里面还有反引号就是违规。注意这里读的是文件文本（不是解析后的值）——
//   正因为字符串会被提前结束，反引号在原文里是**看得见**的。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

/**
 * 打开/闭合标记：注入脚本一定以 `<script` 开头，以 `</script>` + 反引号收尾。
 *
 * ⚠️ 闭合标记**不能带分号**：有的文件写成 `</script>`.replace('__X__', v)`（先收尾再替换占位符），
 *    带分号的版本匹配不到它，于是会一路找到**下一个**注入块的结尾 —— 把中间正常代码里的
 *    反引号误报成违规（第一次跑就误报了 `shipping-rate-ui-smoke.mjs`）。
 */
const OPEN = /= `<script[^>]*>/g;
const CLOSE = '</script>`';

const targets = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('-smoke.mjs'))
  .sort();

const problems = [];
let scannedBlocks = 0;

for (const file of targets) {
  const full = path.join(SCRIPTS, file);
  const src = readFileSync(full, 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  OPEN.lastIndex = 0;
  let m;
  while ((m = OPEN.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf(CLOSE, start);
    if (end < 0) continue; // 没有闭合标记：交给 node --check 报语法错，这里不重复
    scannedBlocks += 1;
    const body = src.slice(start, end);
    const at = body.indexOf('`');
    if (at >= 0) {
      const abs = start + at;
      const line = lineOf(abs);
      const text = src.split('\n')[line - 1] || '';
      problems.push({ file, line, text: text.trim() });
    }
  }
}

if (problems.length) {
  console.error('✗ 注入模板里有反引号 —— 它会把模板字符串提前结束（`node --check` 只会报一句莫名其妙的语法错）：\n');
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    ${p.text}`);
    console.error('    ↑ 这里把这段注释或字符串里的反引号改掉（用「」代替，或直接去掉）\n');
  }
  console.error(`共 ${problems.length} 处。这两段是「把脚本塞进模板字符串」的写法，内部只能用单/双引号。`);
  process.exit(1);
}

console.log(`✅ 注入模板无反引号（扫了 ${targets.length} 个 *-smoke.mjs，${scannedBlocks} 段注入脚本）`);
