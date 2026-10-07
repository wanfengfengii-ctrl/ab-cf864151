import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDoseServer } from '../src/server.js';
import { DoseStore } from '../src/store.js';

// ---------- 测试辅助 ----------

async function withServer(
  run: (base: string) => Promise<void>,
  retention = 1000,
): Promise<void> {
  const { server } = createDoseServer({ store: new DoseStore(retention), heartbeatMs: 60_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, body: unknown) {
  const res = await fetch(`${base}/api/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as Record<string, unknown> | null };
}

interface StateBody {
  revision: number;
  channels: Record<string, number>;
  retention: number;
  oldestRetainedRevision: number | null;
}

async function getState(base: string): Promise<StateBody> {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  return (await res.json()) as StateBody;
}

interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

/** 极简 SSE 客户端：缓冲事件、支持 Last-Event-ID、可轮询等待 */
class SseTestClient {
  readonly events: SseEvent[] = [];
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly lastEventId?: number,
  ) {}

  async connect(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.lastEventId !== undefined) headers['last-event-id'] = String(this.lastEventId);
    const res = await fetch(this.url, { headers, signal: this.controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    if (!res.body) throw new Error('SSE 响应缺少 body');
    void this.pump(res.body).catch(() => {});
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let cur: SseEvent | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line === '') {
          if (cur && cur.data !== '') this.events.push(cur);
          cur = null;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        cur ??= { id: null, event: 'message', data: '' };
        if (field === 'id') cur.id = val;
        else if (field === 'event') cur.event = val;
        else if (field === 'data') cur.data += (cur.data === '' ? '' : '\n') + val;
      }
    }
  }

  async waitFor(pred: (events: SseEvent[]) => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred(this.events)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`等待超时: ${label}`);
  }

  close(): void {
    this.controller.abort();
  }
}

// ---------- 用例 ----------

test('健康检查与未知路由', async () =>
  withServer(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  }));

test('POST 全流程：接纳 / 幂等 / 冲突 / 非法 / 溢出，状态严格受控', async () =>
  withServer(async (base) => {
    const created = await post(base, { readingId: 'a', channel: 'CH-1', dose: 10 });
    assert.equal(created.status, 201);
    assert.equal(created.body?.revision, 1);
    assert.equal(created.body?.deduplicated, false);

    const dup = await post(base, { readingId: 'a', channel: 'CH-1', dose: 10 });
    assert.equal(dup.status, 200);
    assert.equal(dup.body?.revision, 1);
    assert.equal(dup.body?.deduplicated, true);

    const conflict = await post(base, { readingId: 'a', channel: 'CH-1', dose: 99 });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body?.existing as Record<string, unknown>)?.dose, 10);

    for (const dose of [0, -3, 2.5, '10', null, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = await post(base, { readingId: `bad-${String(dose)}`, channel: 'CH-1', dose });
      assert.equal(bad.status, 400, `dose=${String(dose)}`);
    }
    assert.equal((await post(base, { readingId: '', channel: 'CH-1', dose: 1 })).status, 400);
    assert.equal((await post(base, { readingId: 'x', channel: ' ', dose: 1 })).status, 400);

    const big = await post(base, { readingId: 'big', channel: 'CH-2', dose: Number.MAX_SAFE_INTEGER });
    assert.equal(big.status, 201);
    const overflow = await post(base, { readingId: 'overflow', channel: 'CH-2', dose: 1 });
    assert.equal(overflow.status, 422);

    const state = await getState(base);
    assert.equal(state.revision, 2, '仅 a 与 big 被计入');
    assert.deepEqual(state.channels, { 'CH-1': 10, 'CH-2': Number.MAX_SAFE_INTEGER });
  }));

test('并发上报：50 个并发 POST 产生唯一且连续的修订号', async () =>
  withServer(async (base) => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        post(base, { readingId: `c-${i}`, channel: `CH-${i % 5}`, dose: 1 }),
      ),
    );
    assert.ok(results.every((r) => r.status === 201));
    const revisions = results.map((r) => Number(r.body?.revision)).sort((a, b) => a - b);
    assert.deepEqual(revisions, Array.from({ length: 50 }, (_, i) => i + 1));
    const state = await getState(base);
    assert.equal(state.revision, 50);
    for (let ch = 0; ch < 5; ch += 1) {
      assert.equal(state.channels[`CH-${ch}`], 10);
    }
  }));

test('SSE：首次订阅收到带修订号的完整快照，随后增量严格连续', async () =>
  withServer(async (base) => {
    await post(base, { readingId: 's1', channel: 'CH-1', dose: 3 });
    const client = new SseTestClient(`${base}/api/readings/stream`);
    await client.connect();
    try {
      await client.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 5000, 'snapshot');
      const snap = client.events.find((e) => e.event === 'snapshot');
      assert.ok(snap);
      const snapData = JSON.parse(snap.data) as { revision: number; channels: Record<string, number> };
      assert.equal(snap.id, '1', '快照事件 id 即当前修订号');
      assert.equal(snapData.revision, 1);
      assert.deepEqual(snapData.channels, { 'CH-1': 3 });

      await Promise.all([
        post(base, { readingId: 's2', channel: 'CH-1', dose: 4 }),
        post(base, { readingId: 's3', channel: 'CH-2', dose: 5 }),
      ]);
      await client.waitFor((evs) => evs.filter((e) => e.event === 'reading').length >= 2, 5000, '2 deltas');
      const deltas = client.events.filter((e) => e.event === 'reading');
      assert.deepEqual(deltas.map((e) => e.id), ['2', '3'], '增量 id 严格连续');
      // 两个并发 POST 的到达顺序不定，但各自携带的通道累计值必须正确
      const byChannel = new Map(
        deltas.map((e) => {
          const d = JSON.parse(e.data) as { channel: string; total: number };
          return [d.channel, d.total];
        }),
      );
      assert.equal(byChannel.get('CH-1'), 7);
      assert.equal(byChannel.get('CH-2'), 5);
    } finally {
      client.close();
    }
  }));

test('SSE：携带 Last-Event-ID 重连时只补发错过的保留记录', async () =>
  withServer(async (base) => {
    for (let i = 1; i <= 3; i += 1) {
      await post(base, { readingId: `r${i}`, channel: 'CH-1', dose: i });
    }
    const client = new SseTestClient(`${base}/api/readings/stream`, 1);
    await client.connect();
    try {
      await client.waitFor((evs) => evs.filter((e) => e.event === 'reading').length >= 2, 5000, 'replay');
      assert.equal(client.events.some((e) => e.event === 'snapshot'), false, '不应发送快照');
      const replayed = client.events.filter((e) => e.event === 'reading');
      assert.deepEqual(replayed.map((e) => e.id), ['2', '3']);
      const last = JSON.parse(replayed[1]?.data ?? '{}') as { total: number };
      assert.equal(last.total, 6);
    } finally {
      client.close();
    }
  }));

test('SSE：游标过旧时发送新快照重置客户端', async () =>
  withServer(async (base) => {
    for (let i = 1; i <= 5; i += 1) {
      await post(base, { readingId: `r${i}`, channel: 'CH-1', dose: 1 });
    }
    // 保留窗口为 3：游标 1 之后的事件（2）已被挤出，必须快照重置
    const client = new SseTestClient(`${base}/api/readings/stream`, 1);
    await client.connect();
    try {
      await client.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 5000, 'snapshot reset');
      const snap = client.events.find((e) => e.event === 'snapshot');
      assert.ok(snap);
      const snapData = JSON.parse(snap.data) as { revision: number; channels: Record<string, number> };
      assert.equal(snap.id, '5');
      assert.equal(snapData.revision, 5);
      assert.deepEqual(snapData.channels, { 'CH-1': 5 });
    } finally {
      client.close();
    }
  }, 3));

test('SSE：未来游标同样触发快照重置', async () =>
  withServer(async (base) => {
    await post(base, { readingId: 'r1', channel: 'CH-1', dose: 1 });
    const client = new SseTestClient(`${base}/api/readings/stream`, 999);
    await client.connect();
    try {
      await client.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 5000, 'snapshot reset');
    } finally {
      client.close();
    }
  }));

test('断线续接全流程：快照 → 直播 → 断线 → 补发 → 收敛一致', async () =>
  withServer(async (base) => {
    // 客户端按看板逻辑维护本地状态
    const local = { revision: 0, channels: {} as Record<string, number> };

    // 1) 首次订阅：快照
    const a = new SseTestClient(`${base}/api/readings/stream`);
    await a.connect();
    await a.waitFor((evs) => evs.some((e) => e.event === 'snapshot'), 5000, 'initial snapshot');
    const snap = a.events.find((e) => e.event === 'snapshot');
    const snapData = JSON.parse(snap?.data ?? '{}') as { revision: number; channels: Record<string, number> };
    local.revision = snapData.revision;
    local.channels = { ...snapData.channels };

    // 2) 直播中接收 3 条增量
    await Promise.all([
      post(base, { readingId: 'live-1', channel: 'CH-1', dose: 10 }),
      post(base, { readingId: 'live-2', channel: 'CH-2', dose: 20 }),
      post(base, { readingId: 'live-3', channel: 'CH-1', dose: 5 }),
    ]);
    await a.waitFor((evs) => evs.filter((e) => e.event === 'reading').length >= 3, 5000, 'live deltas');
    for (const e of a.events.filter((e) => e.event === 'reading')) {
      const d = JSON.parse(e.data) as { revision: number; channel: string; total: number };
      assert.equal(d.revision, local.revision + 1, '增量必须严格连续');
      local.revision = d.revision;
      local.channels[d.channel] = d.total;
    }
    const lastSeen = local.revision;
    a.close();

    // 3) 断线期间产生 2 条新读数
    await post(base, { readingId: 'missed-1', channel: 'CH-2', dose: 1 });
    await post(base, { readingId: 'missed-2', channel: 'CH-1', dose: 2 });

    // 4) 携带 Last-Event-ID 重连：补发并收敛
    const b = new SseTestClient(`${base}/api/readings/stream`, lastSeen);
    await b.connect();
    try {
      await b.waitFor((evs) => evs.filter((e) => e.event === 'reading').length >= 2, 5000, 'replay');
      assert.equal(b.events.some((e) => e.event === 'snapshot'), false);
      for (const e of b.events.filter((e) => e.event === 'reading')) {
        const d = JSON.parse(e.data) as { revision: number; channel: string; total: number };
        assert.equal(d.revision, local.revision + 1, '补发必须严格连续');
        local.revision = d.revision;
        local.channels[d.channel] = d.total;
      }
      const server = await getState(base);
      assert.equal(local.revision, server.revision);
      assert.deepEqual(local.channels, server.channels, '看板状态必须收敛到服务端状态');
    } finally {
      b.close();
    }
  }));
