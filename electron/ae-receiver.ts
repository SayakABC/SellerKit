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
/** 接受 v1（顶层费用便捷字段）与 v2（结构化 fees 数组）两版 schema，字段演进不阻断老扩展 */
const ACCEPT_SCHEMAS = ['ae-order/v1', 'ae-order/v2'];
const HEADER_TOKEN = 'X-Ae-Token';

let server: http.Server | null = null;
let started = false;
let startedAt = '';
let lastIngestAt = '';
let lastError = '';
/** 限速滑动窗口：最近 60s 内请求时间戳 */
const hits: number[] = [];

export interface AeReceiverStatus {
  running: boolean;
  port: number;
  startedAt: string;
  lastIngestAt: string;
  lastError: string;
}

export function getAeReceiverStatus(): AeReceiverStatus {
  return { running: started, port: PORT, startedAt, lastIngestAt, lastError };
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
      writeJson(res, 200, { ok: true, received: p.orders.length, ...result, skipped });
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      writeJson(res, msg.includes('1MB') ? 413 : 400, { ok: false, error: msg });
    });
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
