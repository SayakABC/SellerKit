const fs = require('fs');
const path = require('path');

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
};
