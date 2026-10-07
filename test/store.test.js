'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/state');

test('新读数被接受：修订唯一递增、分通道累计', () => {
  const s = createStore();
  const r1 = s.submit({ readingId: 'a', channel: 'CH-1', dose: 5 });
  assert.equal(r1.status, 'accepted');
  assert.equal(r1.revision, 1);
  const r2 = s.submit({ readingId: 'b', channel: 'CH-1', dose: 7 });
  const r3 = s.submit({ readingId: 'c', channel: 'CH-2', dose: 3 });
  assert.equal(r2.revision, 2);
  assert.equal(r3.revision, 3);
  assert.deepEqual(s.snapshot().channels, { 'CH-1': 12, 'CH-2': 3 });
  assert.equal(s.snapshot().revision, 3);
});

test('幂等：相同 readingId 与内容返回原修订且不重复累计', () => {
  const s = createStore();
  s.submit({ readingId: 'a', channel: 'CH-1', dose: 5 });
  const dup = s.submit({ readingId: 'a', channel: 'CH-1', dose: 5 });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.revision, 1);
  assert.equal(s.snapshot().revision, 1);
  assert.deepEqual(s.snapshot().channels, { 'CH-1': 5 });
});

test('冲突：相同 readingId 不同内容 → conflict，状态不变', () => {
  const s = createStore();
  s.submit({ readingId: 'a', channel: 'CH-1', dose: 5 });
  const c1 = s.submit({ readingId: 'a', channel: 'CH-1', dose: 6 });
  const c2 = s.submit({ readingId: 'a', channel: 'CH-2', dose: 5 });
  assert.equal(c1.status, 'conflict');
  assert.equal(c2.status, 'conflict');
  assert.equal(c1.existing.dose, 5);
  assert.equal(s.snapshot().revision, 1);
  assert.deepEqual(s.snapshot().channels, { 'CH-1': 5 });
});

test('非法剂量被拒绝且状态不变', () => {
  const s = createStore();
  const badDoses = [0, -1, 1.5, NaN, Infinity, '5', null, undefined, Number.MAX_SAFE_INTEGER + 1];
  for (const dose of badDoses) {
    const r = s.submit({ readingId: `x-${String(dose)}`, channel: 'CH-1', dose });
    assert.equal(r.status, 'invalid', `dose=${String(dose)}`);
  }
  const badIds = s.submit({ readingId: '', channel: 'CH-1', dose: 1 });
  assert.equal(badIds.status, 'invalid');
  const badChannel = s.submit({ readingId: 'ok', channel: '', dose: 1 });
  assert.equal(badChannel.status, 'invalid');
  assert.equal(s.snapshot().revision, 0);
  assert.deepEqual(s.snapshot().channels, {});
});

test('整数溢出被拒绝且状态不变', () => {
  const s = createStore();
  const big = s.submit({ readingId: 'big', channel: 'CH-1', dose: Number.MAX_SAFE_INTEGER });
  assert.equal(big.status, 'accepted');
  const over = s.submit({ readingId: 'over', channel: 'CH-1', dose: 1 });
  assert.equal(over.status, 'overflow');
  assert.equal(s.snapshot().revision, 1);
  assert.equal(s.snapshot().channels['CH-1'], Number.MAX_SAFE_INTEGER);
});

test('并发接纳产生唯一递增修订', () => {
  const s = createStore();
  const N = 200;
  const revisions = [];
  for (let i = 0; i < N; i += 1) {
    revisions.push(s.submit({ readingId: `r${i}`, channel: `CH-${i % 5}`, dose: 1 }).revision);
  }
  assert.deepEqual([...revisions].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
});

test('eventsAfter：补发保留记录 / 游标过旧 / 未来游标', () => {
  const s = createStore({ logCapacity: 3 });
  for (let i = 1; i <= 5; i += 1) s.submit({ readingId: `r${i}`, channel: 'CH-1', dose: 1 });
  // 保留窗口为修订 3,4,5
  assert.deepEqual(s.eventsAfter(2).map((e) => e.revision), [3, 4, 5]);
  assert.deepEqual(s.eventsAfter(5), []);
  assert.equal(s.eventsAfter(1), null); // 过旧：修订 2 已被裁剪
  assert.equal(s.eventsAfter(9), null); // 来自未来：要求快照重置
});

test('订阅者按提交顺序收到增量', () => {
  const s = createStore();
  const got = [];
  const unsub = s.subscribe((e) => got.push(e.revision));
  s.submit({ readingId: 'a', channel: 'CH-1', dose: 1 });
  s.submit({ readingId: 'b', channel: 'CH-1', dose: 1 });
  unsub();
  s.submit({ readingId: 'c', channel: 'CH-1', dose: 1 });
  assert.deepEqual(got, [1, 2]);
});
