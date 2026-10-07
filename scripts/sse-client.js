'use strict';

/**
 * 极简 SSE 客户端（供集成测试与冒烟脚本使用）。
 * openStream(url, { lastEventId }) -> { events, waitFor, close, isClosed }
 */

async function openStream(url, { lastEventId } = {}) {
  const headers = {};
  if (lastEventId !== undefined && lastEventId !== null) {
    headers['last-event-id'] = String(lastEventId);
  }
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`SSE 连接失败：HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  const events = [];
  let waiters = [];

  const notify = () => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };

  function parseEvent(raw) {
    let event = 'message';
    let id = null;
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (id === null && dataLines.length === 0) return null;
    return { event, id, data: dataLines.join('\n') };
  }

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const ev = parseEvent(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (ev) events.push(ev);
        }
        notify();
      }
    } catch {
      /* 读取失败同样唤醒等待者 */
    } finally {
      closed = true;
      notify();
    }
  })();

  async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (closed) {
        throw new Error(`SSE 连接已关闭，未等到「${label}」；已收到 ${events.length} 个事件`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待「${label}」超时；已收到 ${JSON.stringify(events)}`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now())));
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  return {
    events,
    waitFor,
    isClosed: () => closed,
    close: async () => {
      try {
        await reader.cancel();
      } catch {
        /* 已关闭 */
      }
      await pump.catch(() => {});
    },
  };
}

module.exports = { openStream };
