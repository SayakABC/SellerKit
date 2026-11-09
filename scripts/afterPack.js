const fs = require('fs');
const path = require('path');
const { assertNativeBinary } = require('./native-binary');

// 在 appOutDir 下定位被 asarUnpack 解出来的 better_sqlite3.node。
// 不硬编码 mac/win 的目录差异（.app/Contents/Resources vs resources/），
// 直接按「文件名 + 必须在 app.asar.unpacked 下」找，避免路径猜错就静默放过。
function findNativeBinding(root) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 10 || hits.length > 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'better_sqlite3.node' && full.includes('app.asar.unpacked')) hits.push(full);
    }
  };
  walk(root, 0);
  return hits[0] || null;
}

module.exports = async function (context) {
  // Remove ElectronAsarIntegrity from Info.plist to prevent helper loading failure
  // on unsigned/ad-hoc signed macOS builds
  if (context.electronPlatformName === 'darwin') {
    const plistPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Info.plist'
    );
    if (fs.existsSync(plistPath)) {
      let content = fs.readFileSync(plistPath, 'utf-8');
      // Remove the ElectronAsarIntegrity dict block
      content = content.replace(/\s*<key>ElectronAsarIntegrity<\/key>[\s\S]*?<\/dict>\s*<\/dict>/, '');
      fs.writeFileSync(plistPath, content, 'utf-8');
      console.log('Removed ElectronAsarIntegrity from Info.plist');
    }
  }

  // 原生模块平台/架构门禁。
  // 背景见 scripts/native-binary.js 顶部：在 macOS 上打 --win 会把 Mach-O 塞进 Windows 包，
  // 历史上 release/ 里 1.0.0~1.0.4 的 win-x64 包全部中招，且一路到发布都没人发现。
  // 这里必须硬失败，不能只 console.warn —— 警告会被 electron-builder 的日志淹没。
  const nativePath = findNativeBinding(context.appOutDir);
  if (!nativePath) {
    throw new Error(
      `[afterPack] 在 ${context.appOutDir} 下找不到 app.asar.unpacked/**/better_sqlite3.node。\n` +
        `  better-sqlite3 是启动必需依赖，缺了它主进程必崩；且守卫无法校验平台，拒绝放行。\n` +
        `  请确认 electron-builder.yml 的 asarUnpack: "**/*.node" 未被改动、npm run rebuild 已执行。`
    );
  }
  const got = assertNativeBinary({
    platform: context.electronPlatformName,
    arch: context.arch,
    buffer: fs.readFileSync(nativePath),
    label: path.relative(context.appOutDir, nativePath),
  });
  console.log(
    `[afterPack] 原生模块校验通过：${context.electronPlatformName}/${context.arch} → ${got.format}/${got.arch}`
  );
};
