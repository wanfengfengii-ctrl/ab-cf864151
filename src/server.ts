import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DoseStore, type ReadingEvent } from './store.js';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_MS = 25_000;

/** 兼容 dist/ 与 dist-test/ 两种编译输出布局，定位 public/index.html */
function resolveIndexHtml(): URL {
  const candidates = [
    new URL('../public/index.html', import.meta.url),
    new URL('../../public/index.html', import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) return url;
  }
  return candidates[0]!;
}

interface SseClient {
  res: http.ServerResponse;
  /** 握手期间为非 null：新事件先进缓冲，保证快照/补发与后续增量之间严格连续 */
  buffer: ReadingEvent[] | null;
}

export interface ServerOptions {
  store?: DoseStore;
  heartbeatMs?: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

export function createDoseServer(options: ServerOptions = {}) {
  const store =
    options.store ?? new DoseStore(Number(process.env.LOG_RETENTION ?? 1000));
  const clients = new Set<SseClient>();
  const indexHtmlUrl = resolveIndexHtml();
  let indexCache: Buffer | null = null;

  function writeSse(res: http.ServerResponse, id: number, event: string, payload: unknown): void {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(event: ReadingEvent): void {
    for (const client of clients) {
      if (client.buffer) {
        client.buffer.push(event);
        continue;
      }
      try {
        writeSse(client.res, event.revision, 'reading', event);
      } catch {
        clients.delete(client);
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': hb\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  /**
   * SSE 订阅：
   *  - 无 Last-Event-ID（或 ?fresh=1）=> 先下发带修订号的完整快照；
   *  - Last-Event-ID 且游标在保留窗口内 => 只补发其后的保留记录；
   *  - 游标过旧或非法 => 发送新快照重置客户端。
   * 握手全程同步执行，期间新事件进入缓冲，随后按修订号去重补发，
   * 因此客户端收到的增量严格连续、无空洞、无重复。
   */
  function handleStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const fresh = url.searchParams.get('fresh') === '1';
    const rawLastId = req.headers['last-event-id'];
    const lastEventId =
      typeof rawLastId === 'string' && rawLastId.trim() !== '' ? Number(rawLastId) : null;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const client: SseClient = { res, buffer: [] };
    clients.add(client);
    res.on('close', () => clients.delete(client));
    res.on('error', () => clients.delete(client));

    const snapshot = store.getSnapshot();
    let watermark: number;

    if (!fresh && lastEventId !== null && store.canServeFrom(lastEventId)) {
      // 补发保留记录：只发 lastEventId 之后的增量
      for (const event of store.eventsAfter(lastEventId)) {
        writeSse(res, event.revision, 'reading', event);
      }
      watermark = snapshot.revision;
    } else {
      // 首次订阅或游标过旧：发送带修订号的完整快照
      writeSse(res, snapshot.revision, 'snapshot', { type: 'snapshot', ...snapshot });
      watermark = snapshot.revision;
    }

    // 冲刷握手期间缓冲的事件（只发 watermark 之后的）
    const buffered = client.buffer ?? [];
    client.buffer = null;
    for (const event of buffered) {
      if (event.revision > watermark) {
        writeSse(res, event.revision, 'reading', event);
        watermark = event.revision;
      }
    }
  }

  async function handlePostReading(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'payload_too_large';
      sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'payload_too_large' : 'invalid_json' });
      return;
    }

    if (typeof body !== 'object' || body === null) {
      sendJson(res, 400, { error: 'invalid_body', message: '请求体须为 JSON 对象' });
      return;
    }
    const { readingId, channel, dose } = body as Record<string, unknown>;
    if (typeof readingId !== 'string' || readingId.length === 0 || readingId.length > 200) {
      sendJson(res, 400, { error: 'invalid_reading_id', message: 'readingId 须为 1..200 字符的字符串' });
      return;
    }
    if (typeof channel !== 'string' || channel.trim().length === 0 || channel.length > 100) {
      sendJson(res, 400, { error: 'invalid_channel', message: 'channel 须为 1..100 字符的字符串' });
      return;
    }
    if (typeof dose !== 'number') {
      sendJson(res, 400, { error: 'invalid_dose', message: 'dose 须为正整数（微戈瑞 µGy）' });
      return;
    }

    const result = store.submit(readingId, channel.trim(), dose);
    switch (result.kind) {
      case 'accepted': {
        broadcast(result.event);
        sendJson(res, 201, {
          readingId,
          channel: result.event.channel,
          dose,
          revision: result.event.revision,
          total: result.event.total,
          deduplicated: false,
        });
        return;
      }
      case 'duplicate':
        sendJson(res, 200, {
          readingId,
          channel,
          dose,
          revision: result.revision,
          total: result.total,
          deduplicated: true,
        });
        return;
      case 'conflict':
        sendJson(res, 409, {
          error: 'conflict',
          message: 'readingId 已存在且内容不同，本次读数未计入',
          existing: result.existing,
        });
        return;
      case 'invalid':
        sendJson(res, 400, { error: 'invalid_dose', message: result.reason });
        return;
      case 'overflow':
        sendJson(res, 422, {
          error: 'dose_overflow',
          message: '累计剂量超出安全整数上限 (2^53-1)，本次读数未计入',
        });
        return;
    }
  }

  async function serveIndex(res: http.ServerResponse): Promise<void> {
    try {
      indexCache ??= await readFile(indexHtmlUrl);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': indexCache.length,
      });
      res.end(indexCache);
    } catch {
      sendJson(res, 500, { error: 'index_unavailable' });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, {
        ...store.getSnapshot(),
        retention: store.retention,
        oldestRetainedRevision: store.oldestRetainedRevision,
      });
      return;
    }
    if (req.method === 'GET' && path === '/api/readings/stream') {
      handleStream(req, res, url);
      return;
    }
    if (req.method === 'POST' && path === '/api/readings') {
      handlePostReading(req, res).catch((err) => {
        console.error('handlePostReading failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.end();
      });
      return;
    }
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      serveIndex(res).catch((err) => {
        console.error('serveIndex failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.end();
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });

  return { server, store };
}

// 直接运行（非被测试 import）时启动服务
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  const { server } = createDoseServer();
  server.listen(port, () => {
    console.log(`dose-dashboard listening on :${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
