'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openStream } = require('../scripts/sse-client');

async function startApp(options = {}) {
  const app = createApp(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    base,
    close: async () => {
      app.server.closeAllConnections?.(); // 断开挂起的 SSE 连接
      await new Promise((r) => app.server.close(r));
    },
  };
}

async function post(base, body) {
  const res = await fetch(`${base}/api/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('健康检查与静态页面', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const health = await fetch(`${app.base}/healthz`);
  assert.equal(health.status, 200);
  const index = await fetch(`${app.base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /实时剂量看板/);
});

test('POST 流程：接受 / 幂等 / 冲突 / 非法 / 溢出', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const ok = await post(app.base, { readingId: 'r1', channel: 'CH-1', dose: 10 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.revision, 1);

  const dup = await post(app.base, { readingId: 'r1', channel: 'CH-1', dose: 10 });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.revision, 1);

  const conflict = await post(app.base, { readingId: 'r1', channel: 'CH-1', dose: 11 });
  assert.equal(conflict.status, 409);

  for (const dose of [0, -2, 1.5, '9']) {
    const bad = await post(app.base, { readingId: `bad-${dose}`, channel: 'CH-1', dose });
    assert.equal(bad.status, 400, `dose=${dose}`);
  }

  const big = await post(app.base, { readingId: 'big', channel: 'CH-2', dose: Number.MAX_SAFE_INTEGER });
  assert.equal(big.status, 201);
  const over = await post(app.base, { readingId: 'over', channel: 'CH-2', dose: 1 });
  assert.equal(over.status, 422);

  const state = await (await fetch(`${app.base}/api/state`)).json();
  assert.equal(state.revision, 2);
  assert.deepEqual(state.channels, { 'CH-1': 10, 'CH-2': Number.MAX_SAFE_INTEGER });
});

test('并发上报：修订唯一且严格递增', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const N = 50;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      post(app.base, { readingId: `c${i}`, channel: `CH-${i % 4}`, dose: 2 })
    )
  );
  assert.ok(results.every((r) => r.status === 201));
  const revisions = results.map((r) => r.body.revision);
  assert.equal(new Set(revisions).size, N);
  assert.deepEqual([...revisions].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
  const state = await (await fetch(`${app.base}/api/state`)).json();
  assert.equal(state.revision, N);
});

test('SSE：首次订阅先收快照，随后增量严格连续', async (t) => {
  const app = await startApp();
  t.after(app.close);
  await post(app.base, { readingId: 's1', channel: 'CH-1', dose: 4 });

  const stream = await openStream(`${app.base}/api/readings/stream`);
  t.after(() => stream.close());
  const snap = await stream.waitFor((e) => e.event === 'snapshot', 3000, '快照');
  assert.equal(JSON.parse(snap.data).revision, 1);
  assert.equal(snap.id, '1');

  await post(app.base, { readingId: 's2', channel: 'CH-1', dose: 6 });
  await post(app.base, { readingId: 's3', channel: 'CH-2', dose: 1 });
  const d1 = await stream.waitFor((e) => e.event === 'delta' && e.id === '2', 3000, 'delta 2');
  const d2 = await stream.waitFor((e) => e.event === 'delta' && e.id === '3', 3000, 'delta 3');
  assert.equal(JSON.parse(d1.data).channelTotal, 10);
  assert.equal(JSON.parse(d2.data).channel, 'CH-2');
});

test('SSE：Last-Event-ID 重连补发保留记录', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (let i = 1; i <= 5; i += 1) {
    await post(app.base, { readingId: `r${i}`, channel: 'CH-1', dose: i });
  }

  const stream = await openStream(`${app.base}/api/readings/stream`, { lastEventId: 2 });
  t.after(() => stream.close());
  await stream.waitFor((e) => e.event === 'delta' && e.id === '5', 3000, '补发 delta 5');
  const deltas = stream.events.filter((e) => e.event === 'delta');
  assert.deepEqual(deltas.map((e) => e.id), ['3', '4', '5']);
  assert.equal(stream.events.some((e) => e.event === 'snapshot'), false);
});

test('SSE：游标过旧 → 快照重置', async (t) => {
  const app = await startApp({ storeOptions: { logCapacity: 3 } });
  t.after(app.close);
  for (let i = 1; i <= 6; i += 1) {
    await post(app.base, { readingId: `r${i}`, channel: 'CH-1', dose: 1 });
  }

  const stream = await openStream(`${app.base}/api/readings/stream`, { lastEventId: 1 });
  t.after(() => stream.close());
  const snap = await stream.waitFor((e) => e.event === 'snapshot', 3000, '快照重置');
  const data = JSON.parse(snap.data);
  assert.equal(data.revision, 6);
  assert.equal(data.channels['CH-1'], 6);
});

test('SSE：查询参数 lastEventId 同样生效', async (t) => {
  const app = await startApp();
  t.after(app.close);
  for (let i = 1; i <= 3; i += 1) {
    await post(app.base, { readingId: `q${i}`, channel: 'CH-1', dose: 1 });
  }
  const stream = await openStream(`${app.base}/api/readings/stream?lastEventId=1`);
  t.after(() => stream.close());
  await stream.waitFor((e) => e.event === 'delta' && e.id === '3', 3000, 'delta 3');
  const deltas = stream.events.filter((e) => e.event === 'delta');
  assert.deepEqual(deltas.map((e) => e.id), ['2', '3']);
});
