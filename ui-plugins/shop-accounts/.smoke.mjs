// 岛产物 jsdom 冒烟：四页签 + 企业三抽屉
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.dirname(path.fromFileUrl ? path.fromFileUrl(import.meta.url) : import.meta.url.replace('file://',''));
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const jsSrc = process.env.SMOKE_JS || html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1];
const jsBase = process.env.SMOKE_DIR || './dist';
const js = fs.readFileSync(path.resolve(root, jsBase, jsSrc), 'utf8');

const errors = [];
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'MutationObserver', 'CSS', 'SVGSVGElement', 'localStorage']) {
  try {
    if (window[k] !== undefined) global[k] = window[k];
  } catch {}
}
global.window = window;
window.confirm = () => true;

const COMPANIES = [
  { id: 1, name: '示例企业', unifiedCode: '91310000MA1FL2XY7B', country: '中国', address: '上海市浦东新区', legalPerson: '张三', contactName: '李四', contactPhone: '13800000001', contactEmail: 'a@example.com', vatNo: 'DE123456789', eoriNo: 'CN123456789', status: 'active', note: '', updatedAt: '2026-01-01 10:00:00', profileTypes: ['eu_rep'] },
];
const PROFILES = [
  { id: 1, companyId: 1, type: 'eu_rep', name: 'EU Rep GmbH', regNo: 'EU-2026-001', contactName: 'Mueller', contactPhone: '+49 30 123456', contactEmail: 'mueller@example.com', address: 'Berlin, Germany', effectiveAt: '2026-01-01', expireAt: '2027-01-01', status: 'valid', extra: JSON.stringify({ products: '全品类' }), note: '欧代备注', updatedAt: '2026-01-01 10:00:00' },
];

window.__sk = {
  ready: true,
  env: { pluginId: 'shop-accounts', version: '1.2.2' },
  host: {
  ui: { notify: (m) => void m },
  clipboard: { writeText: () => Promise.resolve() },
  storage: { get: () => Promise.resolve({}), set: () => Promise.resolve({}) },
  secrets: { status: () => Promise.resolve({ secureStorage: true, platforms: [] }) },
  db: {
    call: (_domain, op) => {
      switch (op) {
        case 'ensure': return Promise.resolve(true);
        case 'list': return Promise.resolve([
          { id: 1, email: 'shop01@example.com', status: 'active', platforms: ['Amazon'], company: '', phone: '', alipay: '', ziniaoAccount: '', erpAccount: '', tags: '', note: '', openedAt: '2026-01-01', secrets: {}, secretKeys: ['emailPwd'], createdAt: '', updatedAt: '2026-01-01 10:00:00' },
        ]);
        case 'get': return Promise.resolve(null);
        case 'summary': return Promise.resolve({ total: 1, byStatus: { active: 1 }, platforms: [{ platform: 'Amazon', count: 1 }] });
        case 'security': return Promise.resolve({ secureStorage: true, platforms: [] });
        case 'companyEnsure': return Promise.resolve(true);
        case 'companyList': return Promise.resolve(COMPANIES);
        case 'companyGet': return Promise.resolve(Object.assign({}, COMPANIES[0], { profiles: PROFILES }));
        case 'companySummary': return Promise.resolve({ total: 1, byStatus: { active: 1 }, byType: { eu_rep: 1 }, expiringSoon: 1 });
        default: return Promise.resolve({});
      }
    },
  },
  mail: { call: (_op) => Promise.resolve(null) },
  },
};

window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

const origErr = console.error.bind(console);
console.error = (...args) => {
  for (const a of args) if (a instanceof Error) errors.push(a.stack || String(a));
  origErr(...args);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.getElementById('app').textContent.replace(/\s+/g, ' ');
const byText = (t) => [...window.document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t);
const click = async (label) => {
  const b = byText(label);
  if (!b) return null;
  b.click();
  await sleep(400);
  return text();
};

// 挂载（jsdom 不执行 appendChild 注入的脚本，直接在全局上下文 eval）
(0, eval)(js);
await sleep(900);

let ok = true;
const check = (cond, label) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) ok = false;
};

check(text().includes('账号库'), '默认账号库页签');
await click('企业管理');
check(text().includes('示例企业'), '企业管理：企业列表');
await click('新增企业');
check(text().includes('基本信息') && text().includes('联系与税务'), '新增企业抽屉：分组表单');
check(!!window.document.querySelector('.editor-drawer'), '抽屉容器渲染');
check(text().includes('统一社会信用代码'), '表单字段齐全');
window.document.querySelector('.icon-btn')?.click();
await sleep(250);
await click('示例企业');
check(text().includes('跨境合规资料'), '企业详情抽屉：合规资料区块');
check(text().includes('示例企业'), '详情标题显示企业名');
check(text().includes('EU Rep GmbH'), '欧代资料明细');
await click('补充');
check(text().includes('扩展信息'), '合规资料编辑抽屉');
await click('邮件收件箱');
check(text().includes('邮箱接入') || text().includes('收件箱'), '收件箱页签可打开');
await click('设置');
check(text().includes('密码存储安全'), '设置页签');
await click('账号库');
check(text().includes('shop01@example.com'), '回到账号库');

check(errors.length === 0, `全程无运行时错误${errors.length ? '：' + errors[0].slice(0, 300) : ''}`);
process.exit(ok ? 0 : 1);
