// 临时调试：查 DB 完整记录 + source_url 对应
const { app } = require('electron');
app.whenReady().then(() => {
  const Database = require('better-sqlite3');
  const db = new Database('/Users/ck/Library/Application Support/seller-kit/sellerkit.db', { readonly: true });
  const rows = db.prepare('SELECT id, url_fingerprint, source_url, local_path, status FROM oi_images').all();
  for (const r of rows) {
    console.log(`id=${r.id} status=${r.status}`);
    console.log(`  src:  ${r.source_url}`);
    console.log(`  local: ${r.local_path}`);
  }
  console.log('--- userData (dev, electron .) ---');
  console.log('/Users/ck/Library/Application Support/seller-kit');
  db.close();
  app.quit();
});
