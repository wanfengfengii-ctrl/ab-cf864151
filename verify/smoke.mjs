#!/usr/bin/env node
/**
 * 冒烟测试（黑盒，仅通过 HTTP 访问被测服务）：
 *   1. 并发上报：唯一递增修订、分通道累计正确
 *   2. 幂等重放：相同 readingId + 相同内容返回原修订且不重复累计
 *   3. 冲突：相同 readingId + 不同内容返回 409 且状态不变
 *   4. 非法剂量 / 整数溢出：拒绝且状态不变
 *   5. 断线续接：Last-Event-ID 补发、游标过旧快照重置
 *   6. 看板收敛：客户端按看板逻辑应用快照/增量后，与服务端状态一致
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:8080）
 * 退出码：全部通过 0，任一失败 1。
 */

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const RUN = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

async function waitHealthy(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status === 200) return;
    } catch {
      // 服务尚未就绪
    }
    if (Date.now() > deadline) throw new Error(`等待服务健康超时 (${BASE})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function getState() {
  const res = await fetch(`${BASE}/api/state`);
  if (res.status !== 200) throw new Error(`/api/state -> ${res.status}`);
  return res.json();
}

async function post(reading) {
  const res = await fetch(`${BASE}/api/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reading),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // 忽略非 JSON 响应
  }
  return { status: res.status, body };
}

/** 极简 SSE 客户端（模拟看板 EventSource 行为） */
class SseClient {
  constructor(url, { lastEventId } = {}) {
    this.url = url;
    this.lastEventId = lastEventId;
    this.events = [];
    this.controller = new AbortController();
  }

  async connect() {
    const headers = {};
    if (this.lastEventId !== undefined) headers['last-event-id'] = String(this.lastEventId);
    const res = await fetch(this.url, { headers, signal: this.controller.signal });
    if (res.status !== 200) throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    this.pump(res.body).catch(() => {});
  }

  async pump(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let cur = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
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

  async waitUntil(pred, timeoutMs = 10_000, label = 'condition') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = pred(this.events);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`等待超时: ${label}`);
  }

  close() {
    this.controller.abort();
  }
}

/** 看板客户端逻辑：应用增量，要求严格连续 */
function applyDelta(client, event) {
  const d = JSON.parse(event.data);
  if (d.revision !== client.revision + 1) {
    throw new Error(`增量空洞：期望 ${client.revision + 1}，收到 ${d.revision}`);
  }
  client.revision = d.revision;
  client.channels[d.channel] = d.total;
}

function sortedJson(obj) {
  return JSON.stringify(Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1))));
}

async function checkConverged(name, client) {
  const state = await getState();
  check(
    name,
    client.revision === state.revision && sortedJson(client.channels) === sortedJson(state.channels),
    `本地 revision=${client.revision} 服务端 revision=${state.revision}`,
  );
}

async function main() {
  console.log(`[smoke] 目标 ${BASE}，运行标识 ${RUN}`);
  await waitHealthy();
  console.log('[smoke] 服务健康，开始用例\n');

  // ---------- 1. 并发上报 ----------
  console.log('用例 1：并发上报（60 条并发 POST）');
  const s0 = await getState();
  const N = 60;
  const channels = ['alpha', 'beta', 'gamma'].map((c) => `${c}-${RUN}`);
  const readings = Array.from({ length: N }, (_, i) => ({
    readingId: `${RUN}-c${i}`,
    channel: channels[i % channels.length],
    dose: (i % 7) + 1,
  }));
  const results = await Promise.all(readings.map(post));
  check('并发 60 条全部 201', results.every((r) => r.status === 201));
  const revs = results.map((r) => r.body?.revision ?? -1).sort((a, b) => a - b);
  check('修订号唯一', new Set(revs).size === N);
  check('修订号连续且从基线 +1 开始', revs[0] === s0.revision + 1 && revs[N - 1] === s0.revision + N);
  const s1 = await getState();
  check('服务端修订号 = 基线 + 60', s1.revision === s0.revision + N);
  const expected = {};
  for (const r of readings) expected[r.channel] = (expected[r.channel] ?? 0) + r.dose;
  check(
    '分通道累计正确',
    channels.every((c) => s1.channels[c] - (s0.channels[c] ?? 0) === expected[c]),
  );

  // ---------- 2. 幂等重放 ----------
  console.log('用例 2：幂等重放');
  const dup = await post(readings[0]);
  check(
    '重复提交返回 200 + 原修订 + deduplicated',
    dup.status === 200 && dup.body?.revision === results[0].body?.revision && dup.body?.deduplicated === true,
  );
  const s2 = await getState();
  check('幂等重放不改变状态', s2.revision === s1.revision && sortedJson(s2.channels) === sortedJson(s1.channels));

  // ---------- 3. 冲突 ----------
  console.log('用例 3：冲突读数');
  const conflict = await post({ ...readings[1], dose: readings[1].dose + 100 });
  check(
    '相同 readingId 不同内容返回 409 且带已登记内容',
    conflict.status === 409 && conflict.body?.existing?.dose === readings[1].dose,
  );
  const s3 = await getState();
  check('冲突不改变状态', s3.revision === s2.revision && sortedJson(s3.channels) === sortedJson(s2.channels));

  // ---------- 4. 非法剂量与整数溢出 ----------
  console.log('用例 4：非法剂量与整数溢出');
  for (const bad of [0, -5, 1.5, '10', null, Number.MAX_SAFE_INTEGER + 1]) {
    const r = await post({ readingId: `${RUN}-bad-${String(bad)}`, channel: channels[0], dose: bad });
    check(`非法剂量 ${String(bad)} 返回 400`, r.status === 400);
  }
  const big = await post({ readingId: `${RUN}-big`, channel: `${RUN}-overflow`, dose: Number.MAX_SAFE_INTEGER });
  check('MAX_SAFE_INTEGER 单次可计入 (201)', big.status === 201);
  const overflow = await post({ readingId: `${RUN}-big2`, channel: `${RUN}-overflow`, dose: 1 });
  check('累计溢出返回 422', overflow.status === 422);
  const s4 = await getState();
  check(
    '非法/溢出不改变状态（仅 big 计入）',
    s4.revision === s3.revision + 1 && s4.channels[`${RUN}-overflow`] === Number.MAX_SAFE_INTEGER,
  );

  // ---------- 5. 断线续接 ----------
  console.log('用例 5：SSE 快照 / 直播增量 / 断线补发 / 过旧重置');
  const streamA = new SseClient(`${BASE}/api/readings/stream`);
  await streamA.connect();
  const snapEvent = await streamA.waitUntil(
    (evs) => evs.find((e) => e.event === 'snapshot'),
    10_000,
    '首次订阅快照',
  );
  const snapData = JSON.parse(snapEvent.data);
  const stateNow = await getState();
  check(
    '首次订阅收到带修订号的完整快照',
    snapEvent.id === String(stateNow.revision) && snapData.revision === stateNow.revision,
  );
  const client = { revision: snapData.revision, channels: { ...snapData.channels } };

  // 直播增量
  const live = Array.from({ length: 5 }, (_, i) => ({
    readingId: `${RUN}-live-${i}`,
    channel: channels[i % channels.length],
    dose: i + 1,
  }));
  const before = client.revision;
  await Promise.all(live.map(post));
  await streamA.waitUntil((evs) => evs.filter((e) => e.event === 'reading').length >= 5, 10_000, '5 条直播增量');
  const liveEvents = streamA.events.filter((e) => e.event === 'reading');
  check(
    '直播增量严格连续',
    liveEvents.length === 5 && liveEvents.every((e, i) => Number(e.id) === before + 1 + i),
  );
  for (const e of liveEvents) applyDelta(client, e);
  await checkConverged('看板收敛（直播增量）', client);
  const lastSeen = client.revision;
  streamA.close();

  // 断线期间产生 5 条
  const missed = Array.from({ length: 5 }, (_, i) => ({
    readingId: `${RUN}-missed-${i}`,
    channel: channels[i % channels.length],
    dose: 10 + i,
  }));
  await Promise.all(missed.map(post));

  // 携带 Last-Event-ID 重连：补发
  const streamB = new SseClient(`${BASE}/api/readings/stream`, { lastEventId: lastSeen });
  await streamB.connect();
  await streamB.waitUntil((evs) => evs.filter((e) => e.event === 'reading').length >= 5, 10_000, '补发 5 条');
  check('重连补发不重复发快照', streamB.events.every((e) => e.event !== 'snapshot'));
  const replayed = streamB.events.filter((e) => e.event === 'reading');
  check(
    '补发恰好 5 条且严格连续',
    replayed.length === 5 && replayed.every((e, i) => Number(e.id) === lastSeen + 1 + i),
  );
  check(
    '补发内容即断线期间的读数',
    JSON.stringify(replayed.map((e) => JSON.parse(e.data).readingId).sort()) ===
      JSON.stringify(missed.map((m) => m.readingId).sort()),
  );
  for (const e of replayed) applyDelta(client, e);
  await checkConverged('看板收敛（断线补发）', client);
  streamB.close();

  // 游标过旧：打爆保留窗口后重连
  const st = await getState();
  const extra = st.retention + 5;
  console.log(`  …… 写入 ${extra} 条读数以超出保留窗口 (retention=${st.retention})`);
  for (let off = 0; off < extra; off += 100) {
    const batch = Array.from({ length: Math.min(100, extra - off) }, (_, i) => ({
      readingId: `${RUN}-fill-${off + i}`,
      channel: `${RUN}-fill`,
      dose: 1,
    }));
    const rs = await Promise.all(batch.map(post));
    if (!rs.every((r) => r.status === 201)) throw new Error('填充读数写入失败');
  }
  const streamC = new SseClient(`${BASE}/api/readings/stream`, { lastEventId: lastSeen });
  await streamC.connect();
  const resetSnap = await streamC.waitUntil(
    (evs) => evs.find((e) => e.event === 'snapshot'),
    10_000,
    '过旧游标快照重置',
  );
  check('游标过旧收到新快照重置', Boolean(resetSnap));
  const resetData = JSON.parse(resetSnap.data);
  const stC = await getState();
  check(
    '重置快照与服务端状态一致',
    resetSnap.id === String(stC.revision) && resetData.revision === stC.revision && sortedJson(resetData.channels) === sortedJson(stC.channels),
  );
  client.revision = resetData.revision;
  client.channels = { ...resetData.channels };
  await checkConverged('看板收敛（快照重置）', client);
  streamC.close();

  // ---------- 汇总 ----------
  console.log('');
  if (failures === 0) {
    console.log('SMOKE RESULT: ALL PASS');
  } else {
    console.error(`SMOKE RESULT: ${failures} 项失败`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`SMOKE RESULT: 异常中止 —— ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
