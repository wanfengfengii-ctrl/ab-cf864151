import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoseStore } from '../src/store.js';

test('接纳新读数：修订号从 1 开始递增，分通道累计', () => {
  const store = new DoseStore();
  const r1 = store.submit('r-1', 'CH-1', 10);
  const r2 = store.submit('r-2', 'CH-1', 5);
  const r3 = store.submit('r-3', 'CH-2', 7);
  assert.equal(r1.kind, 'accepted');
  assert.equal(r2.kind, 'accepted');
  assert.equal(r3.kind, 'accepted');
  if (r1.kind === 'accepted' && r2.kind === 'accepted' && r3.kind === 'accepted') {
    assert.equal(r1.event.revision, 1);
    assert.equal(r2.event.revision, 2);
    assert.equal(r3.event.revision, 3);
    assert.equal(r2.event.total, 15);
  }
  const snap = store.getSnapshot();
  assert.equal(snap.revision, 3);
  assert.deepEqual(snap.channels, { 'CH-1': 15, 'CH-2': 7 });
});

test('相同 readingId + 相同内容：返回原修订，不重复累计', () => {
  const store = new DoseStore();
  store.submit('r-1', 'CH-1', 10);
  const dup = store.submit('r-1', 'CH-1', 10);
  assert.deepEqual(dup, { kind: 'duplicate', revision: 1, total: 10 });
  const snap = store.getSnapshot();
  assert.equal(snap.revision, 1);
  assert.equal(snap.channels['CH-1'], 10);
});

test('相同 readingId + 不同内容：冲突，状态不变', () => {
  const store = new DoseStore();
  store.submit('r-1', 'CH-1', 10);
  const c1 = store.submit('r-1', 'CH-1', 11);
  assert.equal(c1.kind, 'conflict');
  const c2 = store.submit('r-1', 'CH-2', 10);
  assert.equal(c2.kind, 'conflict');
  if (c1.kind === 'conflict') {
    assert.deepEqual(c1.existing, { readingId: 'r-1', channel: 'CH-1', dose: 10, revision: 1 });
  }
  const snap = store.getSnapshot();
  assert.equal(snap.revision, 1);
  assert.equal(snap.channels['CH-1'], 10);
});

test('非法剂量：0 / 负数 / 小数 / 非安全整数，一律拒绝且状态不变', () => {
  const store = new DoseStore();
  const badDoses = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY];
  for (const dose of badDoses) {
    const r = store.submit(`bad-${String(dose)}`, 'CH-1', dose);
    assert.equal(r.kind, 'invalid', `dose=${String(dose)}`);
  }
  const snap = store.getSnapshot();
  assert.equal(snap.revision, 0);
  assert.deepEqual(snap.channels, {});
});

test('整数溢出：累计超出 MAX_SAFE_INTEGER 拒绝且状态不变', () => {
  const store = new DoseStore();
  const ok = store.submit('big', 'CH-1', Number.MAX_SAFE_INTEGER);
  assert.equal(ok.kind, 'accepted');
  const overflow = store.submit('one-more', 'CH-1', 1);
  assert.equal(overflow.kind, 'overflow');
  const snap = store.getSnapshot();
  assert.equal(snap.revision, 1);
  assert.equal(snap.channels['CH-1'], Number.MAX_SAFE_INTEGER);
});

test('并发接纳：100 个并发提交产生 1..100 的唯一递增修订', async () => {
  const store = new DoseStore();
  // submit 为同步方法，交错并发在事件循环中串行完成
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      Promise.resolve().then(() => store.submit(`r-${i}`, 'CH-1', 1)),
    ),
  );
  const revisions = results
    .map((r) => (r.kind === 'accepted' ? r.event.revision : -1))
    .sort((a, b) => a - b);
  assert.deepEqual(revisions, Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(store.getSnapshot().channels['CH-1'], 100);
});

test('事件日志保留窗口：过旧游标不可补发，窗口内可补发', () => {
  const store = new DoseStore(3);
  for (let i = 1; i <= 5; i += 1) store.submit(`r-${i}`, 'CH-1', 1);
  assert.equal(store.oldestRetainedRevision, 3);
  assert.equal(store.canServeFrom(1), false); // 修订 2 已被挤出窗口
  assert.equal(store.canServeFrom(2), true); // 恰好从 3 开始补发
  assert.equal(store.canServeFrom(5), true); // 无遗漏
  assert.equal(store.canServeFrom(6), false); // 未来游标非法
  assert.equal(store.canServeFrom(-1), false);
  assert.deepEqual(store.eventsAfter(2).map((e) => e.revision), [3, 4, 5]);
  assert.deepEqual(store.eventsAfter(5), []);
});
