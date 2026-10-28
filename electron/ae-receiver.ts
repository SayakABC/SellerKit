// electron/ae-receiver.ts
// 「速卖通利润追踪」localhost 接收端（M0 POC 通道，正式通道为 Chrome Native Messaging，见 docs/features/PROFIT_TRACKER.md D2）。
//
// 安全设计（对本机其他进程开放 HTTP 的最小暴露面）：
//   - 仅监听 127.0.0.1 loopback，不绑定 0.0.0.0；
//   - 固定协议路径白名单（GET /ae/ping、POST /ae/ingest），其余 404；
//   - X-Ae-Token 头鉴权（默认常量，可用环境变量 AE_RECEIVER_TOKEN 覆盖；扩展侧 options 同步配置）；
//   - body ≤1MB、orders ≤100/批、单条 schema 校验失败跳过（双防线：扩展 protocol.js 同限）；
//   - 简单滑动窗口限速（60 次/分），超限 429。
//
// 入站链路：Chrome 扩展 background → 本服务 → ae-db.ts（ensureAeSchema + upsertOrderBatch）。
// 出站（渲染层查询）不经过本服务，一律走语义化 IPC（ae-handlers.ts）。

export {};

import * as http from 'http';
import { ensureAeSchema, upsertOrderBatch, sanitizeIngestOrder } from './ae-db';
import type { AeIngestOrder } from './ae-db';
import {
  ensureShopItemSchema,
  upsertShopItems,
  sanitizeShopItem,
  listScrapedItemIds,
} from './shop-item-db';

const { app } = require('electron');

const DEFAULT_PORT = 46211;
const DEFAULT_TOKEN = 'sk-ae-dev-token';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH = 100;
const RATE_LIMIT_PER_MIN = 60;

const PORT = Number(process.env.AE_RECEIVER_PORT) > 0 ? Number(process.env.AE_RECEIVER_PORT) : DEFAULT_PORT;
const TOKEN = (process.env.AE_RECEIVER_TOKEN || DEFAULT_TOKEN).slice(0, 256);

// 与扩展 src/protocol.js 的 PROTOCOL 常量保持一致
const PATH_PING = '/ae/ping';
const PATH_INGEST = '/ae/ingest';
const PATH_ITEMS_INGEST = '/ae/shop-items/ingest';
/** 只读：问「这家店已经采过哪些款」（扩展跨轮去重的真源头，2026-10-18） */
const PATH_ITEMS_KNOWN = '/ae/shop-items/known';
/** 接受 v1（顶层费用便捷字段）与 v2（结构化 fees 数组）两版 schema，字段演进不阻断老扩展 */
const ACCEPT_SCHEMAS = ['ae-order/v1', 'ae-order/v2'];
const SCHEMA_SHOP_ITEM = 'ae-shop-item/v1';
const HEADER_TOKEN = 'X-Ae-Token';

let server: http.Server | null = null;
let started = false;
let startedAt = '';
let lastIngestAt = '';
let lastItemsIngestAt = '';
let lastError = '';
/** 主窗口引用（main.ts 创建窗口后注入）—— 用于把「采集已入库」推给渲染层 */
let getWindow: (() => any) | null = null;
/** 最近一批订单里因**缺汇率**金额落 NULL 的单数（0 = 全部算出钱了） */
let lastRateMissing = 0;
/** 限速滑动窗口：最近 60s 内请求时间戳 */
const hits: number[] = [];

export interface AeReceiverStatus {
  running: boolean;
  port: number;
  startedAt: string;
  lastIngestAt: string;
  lastItemsIngestAt: string;
  lastError: string;
  /**
   * 最近一批订单里因缺汇率算不出金额的单数。
   *
   * 采集合单是**外币**帧，`ae_rates` 查不到该币种时整单金额只能落 NULL —— 那不是失败，
   * 但也不能当成功：界面/扩展要能把"这批有 N 单缺汇率"说出口，否则利润永远缺一块而没人知道。
   */
  lastRateMissing: number;
}

export function getAeReceiverStatus(): AeReceiverStatus {
  return { running: started, port: PORT, startedAt, lastIngestAt, lastItemsIngestAt, lastError, lastRateMissing };
}

/** 注入主窗口引用（main.ts 创建窗口后调用），用于向渲染层广播采集入库事件 */
export function setAeEventWindow(fn: () => any): void {
  getWindow = fn;
}

/**
 * 广播「采集已入库」（窗口已销毁时静默忽略）。
 *
 * 为什么必须广播：采集是**外部进程**（Chrome 扩展）写库，宿主界面本来一无所知 ——
 * 已打开「店铺商品」段的页面不重拉就永远停在旧状态，用户看到的是「采集到 8 条，
 * 应用里却没有数据」。广播让已挂载的页面在落库那一刻就知道该重拉了。
 */
function emitItemsIngested(payload: { received: number; inserted: number; updated: number; skipped: number }): void {
  const win = getWindow?.();
  if (!win || win.isDestroyed?.()) return;
  try {
    win.webContents.send('ae-items-ingested', { ...payload, at: new Date().toISOString() });
  } catch {
    /* 窗口关闭中，忽略 */
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body 超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

/** 简单滑动窗口限速：60 次/分钟。 */
function rateLimited(): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  while (hits.length && hits[0] <= windowStart) hits.shift();
  if (hits.length >= RATE_LIMIT_PER_MIN) return true;
  hits.push(now);
  return false;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function handlePing(res: http.ServerResponse): void {
  writeJson(res, 200, { ok: true, service: 'sellerkit-ae-receiver', port: PORT, startedAt, lastIngestAt });
}

function handleIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // 鉴权
  const header = req.headers[HEADER_TOKEN.toLowerCase()];
  const provided = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  if (String(provided) !== TOKEN) {
    writeJson(res, 401, { ok: false, error: 'token 无效' });
    return;
  }
  if (rateLimited()) {
    writeJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
    return;
  }

  readBody(req)
    .then((buf) => {
      let payload: unknown;
      try {
        payload = JSON.parse(buf.toString('utf-8'));
      } catch {
        writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { ok: false, error: 'payload 必须是对象' });
        return;
      }
      const p = payload as Record<string, unknown>;
      if (typeof p.schema !== 'string' || !ACCEPT_SCHEMAS.includes(p.schema)) {
        writeJson(res, 400, { ok: false, error: `不支持的 schema：${String(p.schema)}（支持 ${ACCEPT_SCHEMAS.join(' / ')}）` });
        return;
      }
      if (!Array.isArray(p.orders) || p.orders.length === 0 || p.orders.length > MAX_BATCH) {
        writeJson(res, 400, { ok: false, error: `orders 必须是 1~${MAX_BATCH} 的数组` });
        return;
      }
      const clean: AeIngestOrder[] = [];
      let skipped = 0;
      for (const raw of p.orders) {
        const { order, error } = sanitizeIngestOrder(raw);
        if (order) clean.push(order);
        else skipped += 1;
      }
      if (!clean.length) {
        writeJson(res, 200, { ok: true, received: p.orders.length, inserted: 0, updated: 0, skipped: p.orders.length, error: '全部订单校验失败' });
        return;
      }
      ensureAeSchema();
      const result = upsertOrderBatch(clean);
      lastIngestAt = new Date().toISOString();
      lastRateMissing = result.rateMissing;
      // 缺汇率不是失败（单已落库），但必须**说出口**：回执带上计数，扩展可据此提示"去补汇率"。
      writeJson(res, 200, { ok: true, received: p.orders.length, ...result, skipped });
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      writeJson(res, msg.includes('1MB') ? 413 : 400, { ok: false, error: msg });
    });
}

/** 商品采集帧（ae-shop-item/v1）：store + items[]，逐条消毒后落 pl_shop_items 快照。 */
function handleItemsIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // 鉴权 + 限速（与订单端点同一道防线，缺一不可）
  const header = req.headers[HEADER_TOKEN.toLowerCase()];
  const provided = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  if (String(provided) !== TOKEN) {
    writeJson(res, 401, { ok: false, error: 'token 无效' });
    return;
  }
  if (rateLimited()) {
    writeJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
    return;
  }

  readBody(req)
    .then((buf) => {
      let payload: unknown;
      try {
        payload = JSON.parse(buf.toString('utf-8'));
      } catch {
        writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { ok: false, error: 'payload 必须是对象' });
        return;
      }
      const p = payload as Record<string, unknown>;
      if (p.schema !== SCHEMA_SHOP_ITEM) {
        writeJson(res, 400, { ok: false, error: `不支持的 schema：${String(p.schema)}（支持 ${SCHEMA_SHOP_ITEM}）` });
        return;
      }
      if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_BATCH) {
        writeJson(res, 400, { ok: false, error: `items 必须是 1~${MAX_BATCH} 的数组` });
        return;
      }
      const clean: Parameters<typeof upsertShopItems>[0]['items'] = [];
      let skipped = 0;
      for (const raw of p.items as unknown[]) {
        const item = sanitizeShopItem(raw);
        if (item) clean.push(item);
        else skipped += 1;
      }
      if (!clean.length) {
        writeJson(res, 200, { ok: true, received: p.items.length, inserted: 0, updated: 0, skipped: p.items.length, error: '全部商品校验失败' });
        return;
      }
      ensureShopItemSchema();
      const result = upsertShopItems({ schema: SCHEMA_SHOP_ITEM, store: (p.store as any) || {}, items: clean });
      lastItemsIngestAt = new Date().toISOString();
      const skippedTotal = skipped + result.skipped;
      // 落库成功即广播：已打开的「店铺商品」段页面收到后重拉（外部写入 → 界面可见的桥）
      emitItemsIngested({
        received: p.items.length,
        inserted: result.inserted,
        updated: result.updated,
        skipped: skippedTotal,
      });
      // received = 帧里收到的条数；accepted = 通过消毒的条数；skipped = 丢弃条数（两者相加 = received）
      writeJson(res, 200, {
        ok: true,
        received: p.items.length,
        accepted: result.received,
        inserted: result.inserted,
        updated: result.updated,
        skipped: skippedTotal,
      });
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      writeJson(res, msg.includes('1MB') ? 413 : 400, { ok: false, error: msg });
    });
}

/**
 * 「这家店已经采过哪些款」只读端点（GET /ae/shop-items/known?storeId=&url=&name=）。
 *
 * ⭐ 这是**扩展跨轮去重的真源头**（2026-10-18 用户报障「库里已有 40 条，第二次点采集
 * 仍全量重采 63 条」时加的）。扩展自己那份 `aeWalkSeen` 台账只认「这套扩展在这个浏览器
 * 采过的款」—— 旧版扩展采的历史、换浏览器、清扩展数据，它统统不知道。事实（采没采过）
 * 在库里，所以由宿主回答。
 *
 * ⚠️ 匹配口径必须与 `upsertShopItems` 同源（同调 `matchShopByStore`）：问的时候算 A 店、
 *   写的时候算 B 桶，去重会「问的和写的不是一家」而静默失效（已刻意不加缓存，避免口径漂）。
 * ⚠️ token 两处都收（header 优先，query 兜底）：扩展 background 的 GET 走 header，
 *   但 query 让 curl / 手测不用构造 header。限速**刻意不加**：这是只读小查询，
 *   与 ingest 共用 60 次/分的窗口会在大店铺批量采集时被自家 ingest 挤掉（而它恰好
 *   是「少采」的那一环 —— 挤掉了就退化成全量重采）。仅监听 loopback + token 鉴权。
 */
function handleItemsKnown(req: http.IncomingMessage, res: http.ServerResponse): void {
  const header = req.headers[HEADER_TOKEN.toLowerCase()];
  const providedHeader = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  let query: URLSearchParams;
  try {
    query = new URL(req.url || '', 'http://127.0.0.1').searchParams;
  } catch {
    writeJson(res, 400, { ok: false, error: 'query 解析失败' });
    return;
  }
  const provided = String(providedHeader) || query.get('token') || '';
  if (String(provided) !== TOKEN) {
    writeJson(res, 401, { ok: false, error: 'token 无效' });
    return;
  }
  try {
    const r = listScrapedItemIds({
      url: query.get('url') || '',
      storeId: query.get('storeId') || '',
      name: query.get('name') || '',
    });
    // ⚠️ shopId=0 = 匹配落未登记桶（店还没登记），这是**合法结果**，不是错误：
    //   那批行同样采过、同样该被去重。只报 ok + 计数，让扩展能说清"跳过 N 款"。
    writeJson(res, 200, {
      ok: true,
      shopId: r.shopId,
      storeKey: r.storeKey,
      matched: r.shopId > 0,
      count: r.itemIds.length,
      itemIds: r.itemIds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError = msg;
    writeJson(res, 500, { ok: false, error: msg });
  }
}

/** 启动接收端（幂等）：随应用就绪自动调用，也可显式调用。 */
export function startAeReceiver(): boolean {
  if (started) return true;
  try {
    server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      try {
        if (req.method === 'GET' && url === PATH_PING) {
          handlePing(res);
        } else if (req.method === 'POST' && url === PATH_INGEST) {
          handleIngest(req, res);
        } else if (req.method === 'POST' && url === PATH_ITEMS_INGEST) {
          handleItemsIngest(req, res);
        } else if (req.method === 'GET' && url === PATH_ITEMS_KNOWN) {
          handleItemsKnown(req, res);
        } else {
          writeJson(res, 404, { ok: false, error: 'not found' });
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        writeJson(res, 500, { ok: false, error: 'internal error' });
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      started = true;
      startedAt = new Date().toISOString();
      console.log(`[ae-receiver] listening on http://127.0.0.1:${PORT}${PATH_PING}`);
    });
    server.on('error', (e) => {
      lastError = e.message;
      started = false;
      console.error('[ae-receiver] server error:', e.message);
    });
    return true;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

// 模块级注册：应用就绪后自动启动（main.ts 顶部 require 本文件即生效）
app.whenReady().then(() => startAeReceiver()).catch(() => startAeReceiver());
