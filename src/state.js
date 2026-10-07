'use strict';

/**
 * 剂量看板核心状态存储。
 *
 * 语义：
 * - 每条被接纳的读数获得唯一且严格递增的修订号（Node 单线程提交，天然无竞争）。
 * - 相同 readingId + 相同内容 → duplicate，返回原修订号，不重复累计。
 * - 相同 readingId + 不同内容 → conflict，状态不变。
 * - 非法剂量（非正整数 / 非安全整数）→ invalid，状态不变。
 * - 累计将超过每通道上限（Number.MAX_SAFE_INTEGER）→ overflow，状态不变。
 * - 增量事件保留在定长日志中供断线补发；被裁剪的更早事件只能以快照重置。
 */

const DEFAULT_LOG_CAPACITY = 1000;
const MAX_TOTAL = Number.MAX_SAFE_INTEGER; // 每通道累计上限，防止整数溢出

function isValidDose(dose) {
  return typeof dose === 'number' && Number.isSafeInteger(dose) && dose >= 1;
}

function createStore(options = {}) {
  const logCapacity = options.logCapacity ?? DEFAULT_LOG_CAPACITY;
  const maxTotal = options.maxTotal ?? MAX_TOTAL;

  let revision = 0;
  const channels = new Map(); // channel -> 累计剂量 (µGy)
  const readings = new Map(); // readingId -> { readingId, channel, dose, revision }
  let log = []; // 保留的增量事件 { revision, readingId, channel, dose, channelTotal }
  let retainedFrom = 1; // log 中可用的最小修订号（更早的已被裁剪）
  const listeners = new Set();

  function snapshot() {
    return {
      revision,
      channels: Object.fromEntries(channels),
      retainedFrom,
      logCapacity,
    };
  }

  function submit(input) {
    const { readingId, channel, dose } = input ?? {};
    if (typeof readingId !== 'string' || readingId.length === 0 || readingId.length > 128) {
      return { status: 'invalid', error: 'readingId must be a non-empty string (<=128 chars)' };
    }
    if (typeof channel !== 'string' || channel.length === 0 || channel.length > 64) {
      return { status: 'invalid', error: 'channel must be a non-empty string (<=64 chars)' };
    }
    if (!isValidDose(dose)) {
      return { status: 'invalid', error: 'dose must be a positive safe integer (µGy)' };
    }

    const existing = readings.get(readingId);
    if (existing) {
      if (existing.channel === channel && existing.dose === dose) {
        return {
          status: 'duplicate',
          revision: existing.revision,
          readingId,
          channel,
          dose,
          channelTotal: channels.get(channel),
        };
      }
      return {
        status: 'conflict',
        revision: existing.revision,
        error: 'readingId already exists with different content',
        existing: { channel: existing.channel, dose: existing.dose },
      };
    }

    const prevTotal = channels.get(channel) ?? 0;
    const newTotal = prevTotal + dose;
    if (newTotal > maxTotal) {
      return { status: 'overflow', error: 'channel total would exceed maximum safe integer' };
    }

    // 提交段为同步代码：并发请求在此不会交错，修订号唯一且递增。
    revision += 1;
    const event = { revision, readingId, channel, dose, channelTotal: newTotal };
    readings.set(readingId, { readingId, channel, dose, revision });
    channels.set(channel, newTotal);
    log.push(event);
    while (log.length > logCapacity) log.shift();
    retainedFrom = log.length > 0 ? log[0].revision : revision + 1;
    for (const fn of listeners) fn(event);
    return { status: 'accepted', ...event };
  }

  /**
   * 返回 last 之后的全部保留事件（严格连续）。
   * 游标过旧（中间有缺口）或来自未来（服务端已重置）时返回 null，调用方应快照重置。
   */
  function eventsAfter(last) {
    if (last >= revision) return last === revision ? [] : null;
    if (last < retainedFrom - 1) return null;
    return log.slice(last + 1 - retainedFrom);
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { submit, snapshot, eventsAfter, subscribe };
}

module.exports = { createStore, MAX_TOTAL, DEFAULT_LOG_CAPACITY };
