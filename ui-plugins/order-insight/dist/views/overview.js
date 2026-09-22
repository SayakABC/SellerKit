// dist/views/overview.js
// 「导入与识别」：Excel 读取 → 列映射 → 入队 → 批量视觉识别 → 断点续跑 → 缺图补链接。
// 岛内不持有 API Key、不打包 xlsx：读表走宿主 parseExcel，识别走宿主 analyze（Key 只入不出）。

import { oi, analyze, loadEngine, loadConfig, saveConfig } from '../api.js';
import { openFile, notify } from '../bridge.js';
import { state, refresh, onClick } from '../app.js';
import { esc, num, newBatchNo } from '../util.js';
import {
  detectImageColumn,
  detectOrderNoColumn,
  detectShopColumn,
  detectSizeColumn,
  detectOrderTimeColumn,
  classifyResult,
  buildStyleFingerprint,
  buildStyleDisplayName,
} from '../lib.js';
import { detectMultiProductColumns, expandOrderRows } from '../splitter.js';

const S = () => state('overview');

function pick(list) {
  return Array.isArray(list) ? list : list && Array.isArray(list.rows) ? list.rows : [];
}

function log(s, text) {
  s.logs = s.logs || [];
  s.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN')}] ${text}`);
  s.logs = s.logs.slice(0, 200);
}

/** 载入队列统计与缺图列表 */
async function loadQueue(s) {
  s.stats = await oi('queueStats', { batchNo: s.batchNo });
  s.missing = pick(await oi('queueList', { batchNo: s.batchNo, missingOnly: true, offset: 0, limit: 100 }));
}

/** 从队列行字段中取列值（优先 rawFields） */
function fieldOf(s, row, col) {
  const rf = row.rawFields && typeof row.rawFields === 'object' ? row.rawFields : {};
  if (s.cols && s.cols[col] && rf[s.cols[col]] !== undefined) return String(rf[s.cols[col]] ?? '');
  return String(row[col] ?? '');
}

/** 处理单条队列：下载主图 → 复用/识别 → 款式归并 → 落订单 */
async function processRow(s, row, engine) {
  const url = String(row.url || '').trim();
  if (!url) {
    await oi('queueSetResult', { id: row.id, status: 'missing', error: '缺少主图链接' });
    log(s, `#${row.id} 缺图（无主图链接）`);
    return 'missing';
  }

  const img = await oi('downloadImage', { url });
  if (!img || !img.localPath) throw new Error('主图下载失败');

  // 1) 复用已有识别结果（URL 指纹 / 内容指纹命中）
  let result = img.result;
  if (!result && img.resultJson) {
    try {
      result = JSON.parse(img.resultJson);
    } catch (e) {
      result = undefined;
    }
  }

  // 2) 未命中则调用视觉模型（Key 在宿主机密存储，岛侧不接触）
  if (!result) {
    const dataUrl = await oi('readImage', { localPath: img.localPath });
    if (!dataUrl) throw new Error('主图读取失败');
    result = await analyze(dataUrl, engine);
    await oi('imageSave', {
      imageId: img.id,
      fingerprint: img.fingerprint || '',
      result,
      resultJson: JSON.stringify(result),
    });
  }

  // 3) 分类归并与款式指纹：品类 + 排序特征，避免模型命名漂移拆款
  const c = classifyResult(result);
  const features = Array.isArray(result.features) ? result.features : [];
  const fp = buildStyleFingerprint(c.category, features);
  let style = null;
  if (fp) {
    style = await oi('styleResolve', {
      imageId: img.id,
      fingerprint: fp,
      category: c.category,
      color: c.color,
      features,
      styleName: buildStyleDisplayName(c.category, features),
    });
  }

  await oi('insert', {
    imageId: img.id,
    orderNo: String(row.orderNo || ''),
    shop: fieldOf(s, row, 'shop'),
    size: fieldOf(s, row, 'size'),
    orderTime: fieldOf(s, row, 'orderTime'),
    rawFields: row.rawFields || {},
    category: c.category,
    color: c.color,
    logo: c.logo,
    fingerprint: fp || '',
    features,
    styleCode: style && style.styleCode ? style.styleCode : '',
    styleColorCode: style && style.styleColorCode ? style.styleColorCode : '',
  });

  await oi('queueSetResult', { id: row.id, status: 'done' });
  log(s, `#${row.id} ${c.category} / ${c.color}${style && style.styleCode ? ` → ${style.styleCode}` : ''}`);
  return 'done';
}

/** 批量识别主循环（单条串行，失败不中断，支持停止后续跑） */
async function runQueue(s) {
  if (s.running) return;
  s.running = true;
  s.afterId = s.afterId || 0;
  s.run = { done: 0, fail: 0, missing: 0 };
  refresh();
  let engine = null;
  try {
    engine = await loadEngine();
    for (;;) {
      if (!s.running) break;
      const batch = await oi('queueNextPending', { batchNo: s.batchNo, afterId: s.afterId, limit: 1 });
      const rows = pick(batch);
      if (!rows.length) break;
      const row = rows[0];
      s.afterId = row.id;
      try {
        const r = await processRow(s, row, engine);
        s.run[r] = (s.run[r] || 0) + 1;
      } catch (e) {
        s.run.fail += 1;
        await oi('queueSetResult', { id: row.id, status: 'error', error: String((e && e.message) || e).slice(0, 500) });
        log(s, `#${row.id} 失败：${(e && e.message) || e}`);
      }
      await loadQueue(s);
      refresh();
    }
  } catch (e) {
    notify(`识别中断：${(e && e.message) || e}`, 'error');
  } finally {
    s.running = false;
    s.afterId = 0;
    await loadQueue(s).catch(() => {});
    refresh();
  }
}

export default {
  id: 'overview',
  title: '导入与识别',
  order: 10,

  async enter() {
    const s = S();
    if (!s.batchNo) {
      s.batchNo = newBatchNo();
      const last = await oi('queueLastActive');
      if (last && last.batchNo) s.batchNo = last.batchNo;
    }
    if (!s.logs) s.logs = [];
    await oi('ensure');
    await loadQueue(s).catch(() => {});
  },

  render() {
    const s = S();
    const st = s.stats || {};
    const total = num(st.total ?? (st.pending || 0) + (st.done || 0) + (st.error || 0) + (st.missing || 0));
    const pct = total ? Math.round(((st.done || 0) / total) * 100) : 0;
    const headers = s.headers || [];

    const opt = (cur) =>
      `<option value="">— 不使用 —</option>` +
      headers.map((h) => `<option value="${esc(h)}"${h === cur ? ' selected' : ''}>${esc(h)}</option>`).join('');

    const source = `
      <div class="panel">
        <div class="panel-title">数据源</div>
        <div class="bar">
          <button class="btn" data-act="pick">选择 Excel 文件</button>
          <span class="muted small" style="flex:1 1 auto">${s.filePath ? esc(s.filePath) : '未选择文件'}</span>
          ${s.filePath ? '<button class="btn is-primary" data-act="parse">解析表格</button>' : ''}
        </div>
        <div class="bar" style="align-items:flex-start">
          <textarea class="input" id="ovUrls" rows="2" style="flex:1 1 320px" placeholder="或粘贴主图链接（每行一个 / 逗号分号空格分隔），直接入队识别"></textarea>
          <button class="btn" data-act="enqueue-text">粘链入队</button>
        </div>
      </div>`;

    const cols = headers.length
      ? `
      <div class="panel">
        <div class="panel-title">
          列映射 <span class="chip">${num((s.records || []).length)} 行</span>
          ${s.multi ? '<span class="chip is-ok">已展开多产品行</span>' : ''}
        </div>
        <div class="form-grid">
          <div class="field"><label>主图列</label><select class="input" id="cImage">${opt(s.cols.image)}</select></div>
          <div class="field"><label>订单号列</label><select class="input" id="cOrderNo">${opt(s.cols.orderNo)}</select></div>
          <div class="field"><label>店铺列</label><select class="input" id="cShop">${opt(s.cols.shop)}</select></div>
          <div class="field"><label>尺码列</label><select class="input" id="cSize">${opt(s.cols.size)}</select></div>
          <div class="field"><label>下单时间列</label><select class="input" id="cTime">${opt(s.cols.orderTime)}</select></div>
        </div>
        <div class="bar" style="margin-top:10px">
          <span class="muted small">批次号</span>
          <input class="input" id="ovBatch" value="${esc(s.batchNo)}" style="width:160px" />
          <button class="btn is-primary" data-act="import">导入到队列</button>
        </div>
      </div>`
      : '';

    const missing = (s.missing || []).length
      ? `
      <div class="panel">
        <div class="panel-title">缺图待补 <span class="chip is-warn">${num((s.missing || []).length)}</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>ID</th><th>订单号</th><th>补填主图链接</th><th style="width:90px"></th></tr></thead>
            <tbody>
              ${(s.missing || [])
                .map(
                  (r) => `<tr>
                    <td>${esc(r.id)}</td>
                    <td>${esc(r.orderNo || '')}</td>
                    <td><input class="input" data-murl="${esc(r.id)}" placeholder="https://..." value="" /></td>
                    <td><button class="btn is-primary" data-act="fix-url" data-id="${esc(r.id)}">补图</button></td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`
      : '';

    return (
      source +
      cols +
      `
      <div class="panel">
        <div class="panel-title">识别队列</div>
        <div class="grid stats">
          <div class="stat"><div class="stat-label">待处理</div><div class="stat-value">${num(st.pending)}</div></div>
          <div class="stat"><div class="stat-label">已完成</div><div class="stat-value is-ok">${num(st.done)}</div></div>
          <div class="stat"><div class="stat-label">失败</div><div class="stat-value is-danger">${num(st.error)}</div></div>
          <div class="stat"><div class="stat-label">缺图</div><div class="stat-value is-warn">${num(st.missing)}</div></div>
          <div class="stat"><div class="stat-label">合计</div><div class="stat-value">${total}</div></div>
        </div>
        <div class="progress" style="margin:10px 0"><i style="width:${pct}%"></i></div>
        <div class="bar">
          <button class="btn is-primary" data-act="${s.running ? 'stop' : 'start'}">${s.running ? '停止' : '开始识别'}</button>
          <button class="btn" data-act="retry">重试失败</button>
          <button class="btn" data-act="purge">清理已完成</button>
          <button class="btn" data-act="reload">刷新</button>
          <span class="grow"></span>
          ${s.run ? `<span class="muted small">本次 成功 ${num(s.run.done)} · 失败 ${num(s.run.fail)} · 缺图 ${num(s.run.missing)}</span>` : ''}
        </div>
      </div>` +
      missing +
      `
      <div class="panel">
        <div class="panel-title">日志</div>
        <div class="scroll-y" style="max-height:220px">
          ${(s.logs || []).length ? (s.logs || []).map((l) => `<div class="small">${esc(l)}</div>`).join('') : '<div class="empty">暂无日志</div>'}
        </div>
      </div>`
    );
  },

  mount(root) {
    const s = S();
    onClick(root, async (act, el) => {
      try {
        if (act === 'pick') {
          const file = await openFile('excel');
          if (!file || !file.filePath) return;
          s.filePath = file.filePath;
          s.headers = [];
          s.records = [];
          refresh();
        } else if (act === 'parse') {
          const r = await oi('parseExcel', { filePath: s.filePath });
          s.headers = r.headers || [];
          s.records = r.records || [];
          // 已保存的列映射优先（内建版或上次导入留下的配置），列名已不在表头时回落到自动探测
          const cfg = await loadConfig();
          const keep = (saved, detected) => (saved && s.headers.includes(saved) ? saved : detected || '');
          s.cols = {
            image: keep(cfg.imageColumn, detectImageColumn(s.headers)),
            orderNo: keep(cfg.orderNoColumn, detectOrderNoColumn(s.headers)),
            shop: keep(cfg.shopColumn, detectShopColumn(s.headers)),
            size: keep(cfg.sizeColumn, detectSizeColumn(s.headers)),
            orderTime: keep(cfg.orderTimeColumn, detectOrderTimeColumn(s.headers)),
          };
          s.multi = !!detectMultiProductColumns(s.headers, s.records, s.cols);
          notify(`解析完成：${s.records.length} 行`, 'success');
          refresh();
        } else if (act === 'enqueue-text') {
          const box = root.querySelector('#ovUrls');
          const urls = String((box && box.value) || '')
            .split(/[,;\s]+/)
            .map((u) => u.trim())
            .filter(Boolean);
          if (!urls.length) return notify('请粘贴至少一个链接', 'warn');
          await oi('queueEnqueue', {
            batchNo: s.batchNo,
            rows: urls.map((u) => ({ url: u, orderNo: '', info: {}, rawFields: {} })),
          });
          if (box) box.value = '';
          notify(`已入队 ${urls.length} 条`, 'success');
          await loadQueue(s);
          refresh();
        } else if (act === 'import') {
          s.cols = {
            image: (root.querySelector('#cImage') || {}).value || '',
            orderNo: (root.querySelector('#cOrderNo') || {}).value || '',
            shop: (root.querySelector('#cShop') || {}).value || '',
            size: (root.querySelector('#cSize') || {}).value || '',
            orderTime: (root.querySelector('#cTime') || {}).value || '',
          };
          s.batchNo = (root.querySelector('#ovBatch') || {}).value || s.batchNo;
          if (!s.cols.image) return notify('请先选择「主图列」', 'warn');
          // 列映射持久化：键名与内建 useModuleStorage('order-insight') 完全一致，两边配置双向互通
          await saveConfig({
            imageColumn: s.cols.image,
            orderNoColumn: s.cols.orderNo,
            shopColumn: s.cols.shop,
            sizeColumn: s.cols.size,
            orderTimeColumn: s.cols.orderTime,
          });
          const multi = detectMultiProductColumns(s.headers, s.records, s.cols);
          const flat = multi ? expandOrderRows(s.records, multi) : s.records;
          s.multi = !!multi;
          const rows = [];
          for (const f of flat) {
            const url = String(f[s.cols.image] || '').trim();
            if (!url) continue;
            rows.push({
              url,
              orderNo: String(f[s.cols.orderNo] || '').trim(),
              info: {
                shop: String(f[s.cols.shop] || '').trim(),
                size: String(f[s.cols.size] || '').trim(),
                orderTime: String(f[s.cols.orderTime] || '').trim(),
              },
              rawFields: { ...f },
            });
          }
          if (!rows.length) return notify('未解析到主图链接', 'warn');
          await oi('queueEnqueue', { batchNo: s.batchNo, rows });
          notify(`已入队 ${rows.length} 条`, 'success');
          await loadQueue(s);
          refresh();
        } else if (act === 'start') {
          runQueue(s);
        } else if (act === 'stop') {
          s.running = false;
          refresh();
        } else if (act === 'retry') {
          const r = await oi('queueRetryErrors', { batchNo: s.batchNo });
          notify(`已重置 ${r && r.count ? r.count : 0} 条失败任务`, 'success');
          await loadQueue(s);
          refresh();
        } else if (act === 'purge') {
          const r = await oi('queuePurgeDone', { batchNo: s.batchNo });
          notify(`已清理 ${r && r.count ? r.count : 0} 条`, 'success');
          await loadQueue(s);
          refresh();
        } else if (act === 'reload') {
          await loadQueue(s);
          refresh();
        } else if (act === 'fix-url') {
          const id = Number(el.dataset.id);
          const input = root.querySelector(`[data-murl="${id}"]`);
          const url = String((input && input.value) || '').trim();
          if (!url) return notify('请填写主图链接', 'warn');
          const row = await oi('queueGet', { id });
          await oi('queuePatch', { id, url, rawFields: (row && row.rawFields) || {} });
          notify('已补图，可继续识别', 'success');
          await loadQueue(s);
          refresh();
        }
      } catch (e) {
        notify(`操作失败：${(e && e.message) || e}`, 'error');
      }
    });
  },
};
