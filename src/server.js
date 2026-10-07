'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./state');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sseWrite(res, { event, id, data }) {
  res.write(`event: ${event}\n`);
  if (id !== undefined && id !== null) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * GET /api/readings/stream
 * - 无游标：先发带修订号的完整快照，之后只推严格连续的增量。
 * - 携带 Last-Event-ID（响应头或 ?lastEventId=）：补发保留记录。
 * - 游标过旧或来自未来：发送新快照重置客户端。
 */
function handleStream(req, res, store, url) {
  const raw = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
  let last = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) last = n;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  // 先订阅再发快照/补发：本函数全程同步，Node 单线程保证两者之间不会插入新事件，
  // 因此客户端收到的增量永远严格连续、不丢不重。
  const pending = [];
  let live = false;
  const sendDelta = (e) => sseWrite(res, { event: 'delta', id: e.revision, data: e });
  const unsubscribe = store.subscribe((e) => (live ? sendDelta(e) : pending.push(e)));

  const sendSnapshot = () => {
    const snap = store.snapshot();
    sseWrite(res, { event: 'snapshot', id: snap.revision, data: snap });
  };

  if (last === null) {
    sendSnapshot();
  } else {
    const missed = store.eventsAfter(last);
    if (missed === null) sendSnapshot();
    else for (const e of missed) sendDelta(e);
  }
  live = true;
  for (const e of pending) sendDelta(e);
  pending.length = 0;

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* 连接已断开，close 事件会清理 */
    }
  }, HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handlePostReading(req, res, store) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 413, { error: 'payload too large' });
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const result = store.submit(input);
  switch (result.status) {
    case 'accepted':
      return sendJson(res, 201, result);
    case 'duplicate':
      return sendJson(res, 200, result);
    case 'conflict':
      return sendJson(res, 409, result);
    case 'overflow':
      return sendJson(res, 422, result);
    default:
      return sendJson(res, 400, result);
  }
}

function serveStatic(res, staticDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(staticDir, rel));
  if (filePath !== staticDir && !filePath.startsWith(staticDir + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(filePath, (err, content) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  });
}

function createApp(options = {}) {
  const store = options.store || createStore(options.storeOptions);
  const staticDir = options.staticDir || process.env.STATIC_DIR || path.join(__dirname, 'public');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (pathname === '/healthz') {
        return sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
      }
      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, store.snapshot());
      }
      if (pathname === '/api/readings' && req.method === 'POST') {
        return await handlePostReading(req, res, store);
      }
      if (pathname === '/api/readings/stream' && req.method === 'GET') {
        return handleStream(req, res, store, url);
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(res, staticDir, pathname);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });

  return { server, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const logCapacity = Number(process.env.LOG_CAPACITY || 1000);
  const { server } = createApp({ storeOptions: { logCapacity } });
  server.listen(port, host, () => {
    console.log(`dose-dashboard listening on http://${host}:${port} (logCapacity=${logCapacity})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
