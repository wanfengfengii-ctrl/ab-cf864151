'use strict';

/**
 * 冒烟测试：针对运行中的服务验证
 *   1. 并发上报 → 修订号唯一且严格连续、分通道累计正确
 *   2. 幂等重报与冲突 → 状态不变
 *   3. 非法剂量与整数溢出 → 状态不变
 *   4. SSE 首订阅快照 + 实时严格连续增量
 *   5. 断线续接：Last-Event-ID 补发保留记录
 *   6. 游标过旧 → 快照重置，看板收敛到服务端状态
 * 全部通过退出码 0，否则 1。
 */

const { openStream } = require('./sse-client');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

async function waitHealthy() {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error('等待服务健康检查超时');
    await sleep(1000);
  }
}

async function getState() {
  const res = await fetch(`${BASE}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state → HTTP ${res.status}`);
  return res.json();
}

async function postReading(body) {
  const res = await fetch(`${BASE}/api/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body: json };
}

function rid() {
  return `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// 每次运行使用独立通道名，保证冒烟可重复执行（服务端状态跨运行保留）
const RUN = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  console.log(`冒烟目标：${BASE}`);
  await waitHealthy();
  console.log('✔ 服务健康\n');

  // —— 1. 并发上报 ——
  console.log('[1] 并发上报：修订唯一递增、累计正确');
  const before = await getState();
  const N = 60;
  const jobs = Array.from({ length: N }, (_, i) => ({
    readingId: rid(),
    channel: `smoke-ch-${i % 5}`,
    dose: (i % 9) + 1,
  }));
  const expectedByChannel = {};
  for (const j of jobs) expectedByChannel[j.channel] = (expectedByChannel[j.channel] || 0) + j.dose;
  const results = await Promise.all(jobs.map(postReading));
  check('全部接受（201）', results.every((r) => r.status === 201));
  const revisions = results.map((r) => r.body && r.body.revision);
  check('修订号唯一', new Set(revisions).size === N);
  const sorted = [...revisions].sort((a, b) => a - b);
  check(
    '修订号严格连续',
    sorted[0] === before.revision + 1 && sorted[N - 1] === before.revision + N,
    `got ${sorted[0]}..${sorted[N - 1]}, 期望 ${before.revision + 1}..${before.revision + N}`
  );
  const after = await getState();
  check('服务端修订号收敛', after.revision === before.revision + N);
  check(
    '分通道累计一致',
    Object.entries(expectedByChannel).every(
      ([ch, sum]) => after.channels[ch] === (before.channels[ch] || 0) + sum
    )
  );

  // —— 2. 幂等重报与冲突 ——
  console.log('\n[2] 幂等重报与冲突');
  const dup = await postReading(jobs[0]);
  check(
    '相同 readingId + 相同内容 → 200 且返回原修订',
    dup.status === 200 && dup.body && dup.body.revision === results[0].body.revision
  );
  const conflict = await postReading({ ...jobs[1], dose: jobs[1].dose + 100 });
  check('相同 readingId + 不同内容 → 409 冲突', conflict.status === 409);
  const afterDup = await getState();
  check(
    '幂等/冲突不改变状态',
    afterDup.revision === after.revision && canonical(afterDup.channels) === canonical(after.channels)
  );

  // —— 3. 非法剂量与整数溢出 ——
  console.log('\n[3] 非法剂量与整数溢出');
  for (const dose of [0, -5, 2.5, '12']) {
    const bad = await postReading({ readingId: rid(), channel: 'smoke-ch-0', dose });
    check(`非法剂量 ${JSON.stringify(dose)} → 400`, bad.status === 400);
  }
  const overflowChannel = `${RUN}-overflow`;
  const big = await postReading({ readingId: rid(), channel: overflowChannel, dose: Number.MAX_SAFE_INTEGER });
  check('边界剂量 2^53-1 被接受', big.status === 201);
  const over = await postReading({ readingId: rid(), channel: overflowChannel, dose: 1 });
  check('累计溢出 → 422', over.status === 422);
  const afterOver = await getState();
  check(
    '非法/溢出未改变状态',
    afterOver.revision === afterDup.revision + 1 &&
      afterOver.channels[overflowChannel] === Number.MAX_SAFE_INTEGER
  );

  // —— 4. SSE 首订阅快照 + 实时严格连续增量 ——
  console.log('\n[4] SSE：首订阅快照 + 严格连续增量');
  const stream = await openStream(`${BASE}/api/readings/stream`);
  try {
    const snap = await stream.waitFor((e) => e.event === 'snapshot', 5000, '快照');
    const snapData = JSON.parse(snap.data);
    const cur = await getState();
    check('快照修订号与服务端一致', snapData.revision === cur.revision && snap.id === String(cur.revision));
    check('快照通道与服务端一致', canonical(snapData.channels) === canonical(cur.channels));

    const live = { readingId: rid(), channel: `${RUN}-live`, dose: 3 };
    const posted = await postReading(live);
    const delta = await stream.waitFor(
      (e) => e.event === 'delta' && e.id === String(posted.body.revision),
      5000,
      '实时增量'
    );
    const deltaData = JSON.parse(delta.data);
    check('增量严格连续（快照修订+1）', deltaData.revision === snapData.revision + 1);
    check(
      '增量内容正确',
      deltaData.channel === live.channel && deltaData.dose === live.dose && deltaData.channelTotal === live.dose
    );
  } finally {
    await stream.close();
  }

  // —— 5. 断线续接：Last-Event-ID 补发 ——
  console.log('\n[5] 断线续接：Last-Event-ID 补发保留记录');
  const mark = await getState();
  const R = mark.revision;
  for (let i = 1; i <= 3; i += 1) {
    const resp = await postReading({ readingId: rid(), channel: 'smoke-replay', dose: i });
    if (resp.status !== 201) throw new Error('补发准备阶段上报失败');
  }
  const replayStream = await openStream(`${BASE}/api/readings/stream`, { lastEventId: R });
  try {
    await replayStream.waitFor((e) => e.event === 'delta' && e.id === String(R + 3), 5000, '补发增量');
    const deltas = replayStream.events.filter((e) => e.event === 'delta');
    check('补发数量正确', deltas.length === 3, `收到 ${deltas.length} 条`);
    check(
      '补发严格连续',
      JSON.stringify(deltas.map((e) => Number(e.id))) === JSON.stringify([R + 1, R + 2, R + 3])
    );
    check('补发期间无快照重置', !replayStream.events.some((e) => e.event === 'snapshot'));
  } finally {
    await replayStream.close();
  }

  // —— 6. 游标过旧 → 快照重置并收敛 ——
  console.log('\n[6] 游标过旧：快照重置，看板收敛');
  const st = await getState();
  const cap = st.logCapacity;
  console.log(`  （保留容量 ${cap}，生成 ${cap + 10} 条新读数以触发裁剪）`);
  const total = cap + 10;
  const batchSize = 100;
  for (let done = 0; done < total; done += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, total - done) }, () => ({
      readingId: rid(),
      channel: 'smoke-trim',
      dose: 1,
    }));
    const res = await Promise.all(batch.map(postReading));
    if (!res.every((r) => r.status === 201)) throw new Error('裁剪准备阶段上报失败');
  }
  const trimmed = await getState();
  check('保留窗口已滑动', trimmed.retainedFrom > 1);
  const stale = await openStream(`${BASE}/api/readings/stream`, { lastEventId: 0 });
  try {
    const snap2 = await stale.waitFor((e) => e.event === 'snapshot', 5000, '快照重置');
    const snap2Data = JSON.parse(snap2.data);
    const cur2 = await getState();
    check('过旧游标收到快照重置', snap2Data.revision === cur2.revision);
    check(
      '快照重置后分通道剂量收敛',
      canonical(snap2Data.channels) === canonical(cur2.channels)
    );
  } finally {
    await stale.close();
  }

  console.log(`\n冒烟结果：${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`冒烟执行异常：${err.stack || err}`);
  process.exit(1);
});
