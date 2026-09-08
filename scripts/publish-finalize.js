// scripts/publish-finalize.js
// 发布后置步骤：把 electron-builder 创建的 draft（草稿）Release 转正为 published。
//
// 背景：electron-builder 在本地没有对应 git tag 时会创建草稿 Release，
// 而 electron-updater 只认 published Release（"检查更新"读不到草稿）。
// 用 Node fetch 调 GitHub API，避免 shell 中文/引号/变量展开的坑。
//
// 用法: node scripts/publish-finalize.js
// 依赖: package.json 的 version（拼 tag vX.Y.Z）；环境变量 GH_TOKEN 或 GITHUB_TOKEN

'use strict';

const path = require('path');

const { version } = require(path.join(__dirname, '..', 'package.json'));
const TAG = `v${version}`;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO = 'SayakABC/SellerKit';
const API = `https://api.github.com/repos/${REPO}`;

if (!TOKEN) {
  console.error('[publish-finalize] 缺少 GH_TOKEN / GITHUB_TOKEN 环境变量');
  process.exit(1);
}

async function main() {
  // 1) 列出 releases，找 tag 匹配的草稿
  const listResp = await fetch(`${API}/releases?per_page=20`, {
    headers: { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!listResp.ok) {
    console.error(`[publish-finalize] 查询 releases 失败 HTTP ${listResp.status}`);
    process.exit(1);
  }
  const releases = await listResp.json();
  const target = (releases || []).find((r) => r.tag_name === TAG && r.draft);

  if (!target) {
    console.log(`[publish-finalize] 未找到 tag=${TAG} 的草稿 Release（已直接发布则无需处理）`);
    return;
  }

  // 2) 转正
  const patchResp = await fetch(`${API}/releases/${target.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ draft: false }),
  });
  if (!patchResp.ok) {
    const text = await patchResp.text();
    console.error(`[publish-finalize] 转正失败 HTTP ${patchResp.status}: ${text}`);
    process.exit(1);
  }
  const rel = await patchResp.json();
  console.log(`[publish-finalize] 已转正: tag=${rel.tag_name} | assets=${rel.assets.length}`);
  console.log(`[publish-finalize] ${rel.html_url}`);
}

main().catch((e) => {
  console.error('[publish-finalize] 异常:', e instanceof Error ? e.message : e);
  process.exit(1);
});
