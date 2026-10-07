'use strict';

/**
 * 看板客户端：
 * - 首次订阅收到完整快照；之后只应用严格连续的增量（revision + 1）。
 * - 网络断线时 EventSource 自动携带 Last-Event-ID 重连，由服务端补发保留记录。
 * - 检测到修订缺口（或游标过旧被重置）时主动重连，服务端会补发或下发新快照。
 * 两条路径最终都收敛到服务端相同的分通道剂量与修订号。
 */

const state = { revision: null, channels: {} };
let eventSource = null;

const connEl = document.getElementById('conn');
const revisionEl = document.getElementById('revision');
const channelCountEl = document.getElementById('channel-count');
const tbody = document.querySelector('#channels tbody');
const emptyEl = document.getElementById('empty');
const form = document.getElementById('reading-form');
const resultEl = document.getElementById('submit-result');
const conflictsEl = document.getElementById('conflicts');
const noConflictsEl = document.getElementById('no-conflicts');
const eventsEl = document.getElementById('events');

const CONN_LABELS = {
  connecting: ['连接中…', 'conn-connecting'],
  online: ['在线', 'conn-online'],
  reconnecting: ['重连中…', 'conn-reconnecting'],
  closed: ['已断开', 'conn-closed'],
};

function setConn(status) {
  const [text, cls] = CONN_LABELS[status];
  connEl.textContent = text;
  connEl.className = `badge ${cls}`;
}

function render() {
  revisionEl.textContent = state.revision === null ? '–' : String(state.revision);
  const channels = Object.keys(state.channels).sort();
  channelCountEl.textContent = String(channels.length);
  emptyEl.style.display = channels.length ? 'none' : '';
  tbody.innerHTML = '';
  for (const ch of channels) {
    const tr = document.createElement('tr');
    const tdCh = document.createElement('td');
    tdCh.textContent = ch;
    const tdDose = document.createElement('td');
    tdDose.className = 'num';
    tdDose.textContent = String(state.channels[ch]);
    tr.append(tdCh, tdDose);
    tbody.appendChild(tr);
  }
}

function logEvent(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
  eventsEl.prepend(li);
  while (eventsEl.children.length > 30) eventsEl.lastChild.remove();
}

function addConflict(readingId, detail) {
  noConflictsEl.style.display = 'none';
  const li = document.createElement('li');
  li.className = 'conflict';
  const badge = document.createElement('span');
  badge.className = 'badge badge-conflict';
  badge.textContent = '未计入';
  const strong = document.createElement('strong');
  strong.textContent = readingId;
  li.append(badge, strong);
  if (detail && detail.existing) {
    const info = document.createElement('span');
    info.className = 'muted';
    info.textContent = ` 已登记：通道 ${detail.existing.channel} / 剂量 ${detail.existing.dose} µGy（修订 ${detail.revision}）`;
    li.appendChild(info);
  }
  conflictsEl.prepend(li);
}

function connect() {
  if (eventSource) eventSource.close();
  setConn('connecting');
  eventSource = new EventSource('/api/readings/stream');

  eventSource.onopen = () => setConn('online');
  eventSource.onerror = () => {
    setConn(eventSource.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  };

  eventSource.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    state.revision = snap.revision;
    state.channels = { ...snap.channels };
    render();
    logEvent(`快照重置：修订 ${snap.revision}，${Object.keys(snap.channels).length} 个通道`);
  });

  eventSource.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    if (state.revision !== null && d.revision !== state.revision + 1) {
      // 增量不连续：主动重连，由服务端补发保留记录或快照重置
      logEvent(`检测到修订缺口（期望 ${state.revision + 1}，收到 ${d.revision}），重新订阅`);
      connect();
      return;
    }
    state.revision = d.revision;
    state.channels[d.channel] = d.channelTotal;
    render();
    logEvent(`修订 ${d.revision}：${d.channel} +${d.dose} µGy → 累计 ${d.channelTotal} µGy`);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const readingId = String(fd.get('readingId') || '').trim();
  const channel = String(fd.get('channel') || '').trim();
  const dose = Number(fd.get('dose'));
  let res;
  let body;
  try {
    res = await fetch('/api/readings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readingId, channel, dose }),
    });
    body = await res.json();
  } catch {
    resultEl.textContent = '提交失败：网络错误';
    return;
  }
  if (res.status === 201) {
    resultEl.textContent = `已接受 · 修订号 ${body.revision}`;
  } else if (res.status === 200) {
    resultEl.textContent = `重复上报 · 未重复累计（原修订号 ${body.revision}）`;
  } else if (res.status === 409) {
    resultEl.textContent = '冲突 · 该读数未计入';
    addConflict(readingId, body);
  } else {
    resultEl.textContent = `被拒绝（${res.status}）：${body && body.error ? body.error : '未知原因'}`;
  }
});

connect();
