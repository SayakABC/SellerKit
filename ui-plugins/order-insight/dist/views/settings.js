// dist/views/settings.js
// 「识别设置」：视觉引擎配置（provider / baseUrl / model / temperature）与 API Key（只写不读）。
// 安全边界：Key 经 setApiKey 单向写入宿主机密存储，岛内无法回读；识别时由宿主补齐 Key 发起调用。

import { oi, loadEngine, saveEngine, setApiKey, loadConfig, saveConfig, DEFAULT_ENGINE } from '../api.js';
import { notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, confirm, guard } from '../util.js';

const S = () => state('settings');

const PROVIDERS = [
  { id: 'qwen', label: '通义千问 Qwen-VL' },
  { id: 'openai', label: 'OpenAI 兼容' },
  { id: 'custom', label: '自定义端点' },
];

export default {
  id: 'settings',
  title: '识别设置',
  order: 90,

  async enter() {
    const s = S();
    s.engine = await loadEngine();
    // 列映射与内建 EngineSettings 同键名（imageColumn / orderNoColumn / …），两边配置双向互通
    const cfg = await loadConfig();
    s.cols = {
      imageColumn: cfg.imageColumn || '',
      orderNoColumn: cfg.orderNoColumn || '',
      shopColumn: cfg.shopColumn || '',
      sizeColumn: cfg.sizeColumn || '',
      orderTimeColumn: cfg.orderTimeColumn || '',
    };
  },

  render() {
    const s = S();
    const e = Object.assign({}, DEFAULT_ENGINE, s.engine || {});
    const c = s.cols || {};
    return `
      <div class="panel">
        <div class="panel-title">视觉识别引擎</div>
        <div class="form-grid">
          <div class="field">
            <label>服务商</label>
            <select class="input" id="seProvider">
              ${PROVIDERS.map((p) => `<option value="${p.id}"${e.provider === p.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>模型</label><input class="input" id="seModel" value="${esc(e.model || '')}" placeholder="qwen-vl-max / gpt-4o" /></div>
          <div class="field"><label>接口地址</label><input class="input" id="seBaseUrl" value="${esc(e.baseUrl || '')}" placeholder="https://..." /></div>
          <div class="field"><label>温度</label><input class="input" id="seTemp" value="${esc(String(e.temperature ?? 0.1))}" /></div>
        </div>
        <div class="bar" style="margin-top:10px">
          <button class="btn is-primary" data-act="save-engine">保存引擎配置</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">列映射</div>
        <div class="form-grid">
          <div class="field"><label>主图列</label><input class="input" id="seImageCol" value="${esc(c.imageColumn)}" placeholder="导入后自动识别" /></div>
          <div class="field"><label>订单号列</label><input class="input" id="seOrderNoCol" value="${esc(c.orderNoColumn)}" placeholder="可留空" /></div>
          <div class="field"><label>店铺列</label><input class="input" id="seShopCol" value="${esc(c.shopColumn)}" placeholder="可留空" /></div>
          <div class="field"><label>尺码列</label><input class="input" id="seSizeCol" value="${esc(c.sizeColumn)}" placeholder="可留空" /></div>
          <div class="field"><label>下单时间列</label><input class="input" id="seTimeCol" value="${esc(c.orderTimeColumn)}" placeholder="可留空" /></div>
        </div>
        <div class="bar" style="margin-top:10px">
          <button class="btn is-primary" data-act="save-cols">保存列映射</button>
        </div>
        <div class="small muted" style="margin-top:6px">留空表示每次导入时按表头自动探测；填写后导入会优先采用（列名须与表头一致，否则仍回落探测）。</div>
      </div>

      <div class="panel">
        <div class="panel-title">API Key</div>
        <div class="bar">
          <input class="input" id="seKey" type="password" placeholder="粘贴 API Key（保存后不可回读）" style="flex:1 1 280px" />
          <button class="btn is-primary" data-act="save-key">保存 Key</button>
        </div>
        <div class="small muted" style="margin-top:6px">
          Key 通过宿主加密存储单向写入，识别请求由宿主进程发起，插件页面无法读取，也不会随导出/分享外泄。
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">数据维护</div>
        <div class="bar">
          <button class="btn" data-act="cleanup">清理孤儿图片</button>
          <button class="btn is-danger" data-act="clear">清空订单数据</button>
        </div>
        <div class="small muted" style="margin-top:6px">「清理孤儿图片」删除无订单引用的缓存主图；「清空订单数据」仅清空订单表，款式库与队列保留。</div>
      </div>`;
  },

  mount(root) {
    const s = S();
    onClick(root, async (act, el) => {
      try {
        if (act === 'save-engine') {
          await guard(async () => {
            await saveEngine({
              provider: (root.querySelector('#seProvider') || {}).value || 'custom',
              model: (root.querySelector('#seModel') || {}).value || '',
              baseUrl: (root.querySelector('#seBaseUrl') || {}).value || '',
              temperature: Number((root.querySelector('#seTemp') || {}).value || 0.1),
            });
            notify('引擎配置已保存', 'success');
          }, el);
        } else if (act === 'save-cols') {
          await guard(async () => {
            const val = (sel) => {
              const input = root.querySelector(sel);
              return input ? String(input.value || '').trim() : '';
            };
            await saveConfig({
              imageColumn: val('#seImageCol'),
              orderNoColumn: val('#seOrderNoCol'),
              shopColumn: val('#seShopCol'),
              sizeColumn: val('#seSizeCol'),
              orderTimeColumn: val('#seTimeCol'),
            });
            notify('列映射已保存', 'success');
          }, el);
        } else if (act === 'save-key') {
          const key = (root.querySelector('#seKey') || {}).value || '';
          if (!key.trim()) return notify('请填写 API Key', 'warn');
          await guard(async () => {
            await setApiKey(key.trim());
            const input = root.querySelector('#seKey');
            if (input) input.value = '';
            notify('API Key 已安全保存', 'success');
          }, el);
        } else if (act === 'cleanup') {
          await guard(async () => {
            const r = await oi('cleanupOrphanImages');
            notify(`已清理 ${(r && (r.deleted ?? r.count)) || 0} 张孤儿图片`, 'success');
          }, el);
        } else if (act === 'clear') {
          if (!(await confirm('确认清空全部订单数据？该操作不可撤销。'))) return;
          await oi('clear');
          notify('订单数据已清空', 'success');
          refresh();
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
