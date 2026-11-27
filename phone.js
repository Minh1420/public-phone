'use strict';

/* MeApp Phone — local-first PWA. The phone never depends on a PC to open. */

const LS_STATE = 'meapp.phone.state';
const LS_PASS = 'meapp.phone.passphrase';
const DB_NAME = 'meapp-phone-files';
const STORE = 'html';

const DEFAULT = {
  notes: [], tasks: [], shortcuts: [], favorites: {}, hidden: {}, tags: {},
  profile: {}, interests: {}, lastOpen: {},
  events: [], queries: [], pomodoro: { sessions: [], totalMinutes: 0 },
  docs: [], saved: {},
  sync: { clientId: '', enabled: false },
  pcUrl: '',
  rev: 0, updatedAt: null, tombstones: []
};

let S = load();
let view = 'home';
let applyingRemote = false;
let syncTimer = null;

/* ------------------------------------------------------------------ utils */

function load() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    return raw ? { ...structuredClone(DEFAULT), ...JSON.parse(raw) } : structuredClone(DEFAULT);
  } catch { return structuredClone(DEFAULT); }
}

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rel(ts) {
  if (!ts) return 'chưa có';
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)}p trước`;
  if (s < 86400) return `${Math.floor(s / 3600)}h trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${kind === 'ok' ? '✅' : kind === 'err' ? '⚠️' : '💡'}</span><span>${esc(message)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(12px)'; }, 3400);
  setTimeout(() => el.remove(), 3800);
}

function $(sel) { return document.querySelector(sel); }

function save(opts = {}) {
  if (!opts.keepTime) S.updatedAt = new Date().toISOString();
  localStorage.setItem(LS_STATE, JSON.stringify(S));
  if (!applyingRemote && !opts.noDirty) {
    window.MeSync?.markDirty();
    scheduleSync();
  }
  if (!opts.noRender) render();
}

function stateSignature() {
  return JSON.stringify({
    notes: S.notes, tasks: S.tasks, shortcuts: S.shortcuts, favorites: S.favorites,
    hidden: S.hidden, tags: S.tags, profile: S.profile, interests: S.interests,
    lastOpen: S.lastOpen, events: S.events, pomodoro: S.pomodoro
  });
}

function scheduleSync() {
  if (!S.sync.enabled || !window.MeSync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => window.MeSync.syncNow().catch(() => {}), 2500);
}

/* ----------------------------------------------------------- IndexedDB */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putFile(id, html) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id, html, updatedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------- PC access */

function phoneId() {
  let id = localStorage.getItem('meapp.phone.deviceId');
  if (!id) { id = uid(); localStorage.setItem('meapp.phone.deviceId', id); }
  return id;
}

function pcBase() {
  return (S.pcUrl || '').trim().replace(/\/+$/, '');
}

async function pcApi(path, options = {}) {
  if (!pcBase()) throw new Error('Nhập địa chỉ máy tính trong tab Đồng bộ');
  if (location.protocol === 'https:' && pcBase().startsWith('http://')) {
    throw new Error('Trình duyệt chặn http:// từ trang https://. Dùng Google Drive, hoặc cài bản phone từ http://<IP-PC>:4173/phone để kết nối LAN.');
  }
  const headers = { 'Content-Type': 'application/json', 'X-MeApp-Device': phoneId() };
  const token = localStorage.getItem(`meapp.pcToken:${pcBase()}`);
  if (token) headers['X-MeApp-Token'] = token;
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(`${pcBase()}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* --------------------------------------------------------------- sync IO */

function localSnapshot() {
  return {
    rev: S.rev || 0,
    updatedAt: S.updatedAt || new Date().toISOString(),
    tombstones: S.tombstones || [],
    data: {
      notes: S.notes || [], tasks: S.tasks || [], shortcuts: S.shortcuts || [],
      favorites: S.favorites || {}, hidden: S.hidden || {}, tags: S.tags || {},
      profile: S.profile || {}, interests: S.interests || {}, lastOpen: S.lastOpen || {},
      events: (S.events || []).slice(-200), queries: (S.queries || []).slice(-60),
      pomodoro: S.pomodoro || {}, theme: 'dark', weights: {}
    }
  };
}

function mergeArray(key, local, incoming, tombstones) {
  const byId = new Map();
  for (const item of local || []) if (item?.id) byId.set(item.id, item);
  for (const item of incoming || []) {
    if (!item?.id) continue;
    const old = byId.get(item.id);
    const tNew = new Date(item.updatedAt || item.createdAt || 0).getTime();
    const tOld = new Date(old?.updatedAt || old?.createdAt || 0).getTime();
    if (!old || tNew >= tOld) byId.set(item.id, item);
  }
  for (const t of tombstones || []) if (t.collection === key) byId.delete(t.id);
  return [...byId.values()].slice(-600);
}

function applyRemote(snapshot) {
  if (!snapshot?.data) return;
  const before = stateSignature();
  applyingRemote = true;
  try {
    const data = snapshot.data;
    const tombstones = [...(S.tombstones || []), ...(snapshot.tombstones || [])].slice(-400);
    for (const key of ['notes', 'tasks', 'shortcuts']) {
      S[key] = mergeArray(key, S[key], data[key], tombstones);
    }
    for (const key of ['favorites', 'hidden', 'tags', 'profile', 'interests', 'lastOpen']) {
      if (data[key] && typeof data[key] === 'object') S[key] = data[key];
    }
    if (Array.isArray(data.events)) S.events = data.events.slice(-500);
    if (Array.isArray(data.queries)) S.queries = data.queries.slice(-120);
    if (data.pomodoro) S.pomodoro = data.pomodoro;
    S.tombstones = tombstones;
    S.rev = Math.max(S.rev || 0, snapshot.rev || 0);
    S.updatedAt = snapshot.updatedAt || S.updatedAt;
    save({ noDirty: true, keepTime: true, noRender: stateSignature() === before });
  } finally {
    applyingRemote = false;
  }
}

/* ---------------------------------------------------------------- render */

function pageHead(title, sub, actions = '') {
  return `<section class="card">
    <div class="card-head"><div><h1 style="margin:0;font-size:20px">${esc(title)}</h1>
      <div class="muted tiny">${esc(sub)}</div></div><div class="row">${actions}</div></div>
  </section>`;
}

function renderHome() {
  const st = window.MeSync?.status?.() || {};
  const openTasks = (S.tasks || []).filter((t) => !t.done).length;
  return `${pageHead('Chào bạn 👋', 'Dữ liệu nằm ngay trên điện thoại — mở được khi không có mạng.')}
  <div class="grid two">
    <div class="card"><div class="card-title">📝 Ghi chú</div><div style="font-size:28px;font-weight:750">${S.notes.length}</div></div>
    <div class="card"><div class="card-title">✅ Việc đang mở</div><div style="font-size:28px;font-weight:750">${openTasks}</div></div>
    <div class="card"><div class="card-title">📄 File offline</div><div style="font-size:28px;font-weight:750">${Object.keys(S.saved || {}).length}</div></div>
    <div class="card"><div class="card-title">☁️ Lần sync</div><div style="font-size:14px;font-weight:650">${rel(st.lastSync)}</div>
      <div class="tiny ${st.pending ? 'muted' : 'faint'}">${st.pending ? 'Có thay đổi đang chờ' : 'Không có thay đổi chờ'}</div></div>
  </div>
  <div class="card"><div class="row">
    <button class="btn primary" data-action="goto" data-view="notes">✎ Viết ghi chú</button>
    <button class="btn" data-action="goto" data-view="library">📄 Đọc file</button>
    <button class="btn" data-action="goto" data-view="sync">🔄 Đồng bộ</button>
  </div></div>`;
}

function renderNotes() {
  return `${pageHead('Ghi chú', 'Lưu trên máy, không cần mạng.', '<button class="btn primary sm" data-action="add-note">＋ Lưu</button>')}
  <div class="card">
    <div class="field"><label>Tiêu đề</label><input id="noteTitle" placeholder="Tiêu đề ghi chú"></div>
    <div class="field"><label>Nội dung</label><textarea id="noteBody" placeholder="Viết gì đó…"></textarea></div>
  </div>
  <div class="card"><div class="card-head"><h2 class="card-title">Danh sách</h2><span class="tiny faint">${S.notes.length} ghi chú</span></div>
    ${S.notes.length ? `<div class="list">${S.notes.slice().reverse().map((n) => `
      <div class="list-item"><div style="flex:1"><div style="font-weight:650">${esc(n.title || 'Không tiêu đề')}</div>
        <div class="muted tiny">${esc(String(n.body || '').slice(0, 110))}</div>
        <div class="faint tiny">${rel(n.updatedAt || n.createdAt)}</div></div>
        <div class="item-actions"><button class="btn sm danger" data-action="delete-note" data-id="${n.id}">Xoá</button></div></div>`).join('')}</div>`
      : '<p class="faint tiny">Chưa có ghi chú.</p>'}
  </div>`;
}

function renderTasks() {
  return `${pageHead('Việc cần làm', 'Check/uncheck vẫn lưu offline.', '<button class="btn primary sm" data-action="add-task">＋ Thêm</button>')}
  <div class="card">
    <div class="field-row">
      <div class="field"><label>Việc</label><input id="taskText" placeholder="Việc cần làm"></div>
      <div class="field"><label>Hạn</label><input id="taskDue" type="date"></div>
    </div>
  </div>
  <div class="card"><div class="card-head"><h2 class="card-title">Danh sách</h2>
    <span class="tiny faint">${S.tasks.filter((t) => !t.done).length} đang mở</span></div>
    ${S.tasks.length ? `<div class="list">${S.tasks.slice().reverse().map((t) => `
      <div class="list-item"><div style="flex:1">
        <div style="font-weight:650;text-decoration:${t.done ? 'line-through' : 'none'}">${esc(t.text)}</div>
        <div class="faint tiny">${t.due ? `Hạn ${esc(t.due)} · ` : ''}${rel(t.updatedAt || t.createdAt)}</div></div>
        <div class="item-actions">
          <button class="btn sm" data-action="toggle-task" data-id="${t.id}">${t.done ? '↩ Mở lại' : '✓ Xong'}</button>
          <button class="btn sm danger" data-action="delete-task" data-id="${t.id}">Xoá</button>
        </div></div>`).join('')}</div>` : '<p class="faint tiny">Chưa có việc.</p>'}
  </div>`;
}

function renderLibrary() {
  return `${pageHead('Thư viện HTML', 'Đọc file đã lưu offline. Muốn lấy thêm thì kết nối máy tính.', `
    <button class="btn sm" data-action="pc-refresh">⟳ Lấy danh sách từ PC</button>`)}
  ${S.docs.length ? `<div class="card"><div class="list">${S.docs.map((d) => `
    <div class="list-item"><div style="flex:1">
      <div style="font-weight:650">${esc(d.title || d.name)}</div>
      <div class="muted tiny">${esc(d.name)}</div>
      <div class="faint tiny">${S.saved?.[d.id] ? `Đã lưu offline · ${rel(S.saved[d.id])}` : 'Chưa lưu offline'}</div>
      </div><div class="item-actions">
        <button class="btn sm primary" data-action="read-file" data-id="${d.id}">📖 Đọc</button>
        <button class="btn sm" data-action="save-file" data-id="${d.id}">⬇ Lưu offline</button>
      </div></div>`).join('')}</div></div>`
    : `<div class="card"><h2 class="card-title">Chưa có file</h2>
        <p class="muted tiny">Vào tab <b>Đồng bộ</b>, nhập địa chỉ máy tính, bấm <b>Lấy danh sách</b>, rồi bấm <b>Lưu offline</b> cho file bạn cần mang ra ngoài.</p>
      </div>`}`;
}

function renderSync() {
  const st = window.MeSync?.status?.() || {};
  const cfg = S.sync || {};
  return `${pageHead('Đồng bộ', 'Offline vẫn dùng được. Có mạng mới đẩy/kéo dữ liệu.', '')}
  <div class="card">
    <div class="card-head"><h2 class="card-title">☁️ Google Drive</h2>
      <span class="tag ${st.connected ? 'mint' : 'warn'}">${st.connected ? 'Đã kết nối' : 'Chưa kết nối'}</span></div>
    <p class="muted tiny">Chỉ sync khi có thay đổi. Dữ liệu mã hoá bằng passphrase trước khi lên Drive.</p>
    <div class="field"><label>Google OAuth Client ID</label><input id="clientId" value="${esc(cfg.clientId || '')}" placeholder="xxxx.apps.googleusercontent.com"></div>
    <div class="field"><label>Passphrase</label><input id="passphrase" value="${esc(localStorage.getItem(LS_PASS) || '')}" placeholder="Passphrase mã hoá"></div>
    <label class="switch"><input type="checkbox" id="syncEnabled" ${cfg.enabled ? 'checked' : ''}> Bật sync khi có thay đổi</label>
    <div class="row"><button class="btn primary" data-action="save-sync">💾 Lưu & kết nối</button>
      <button class="btn" data-action="sync-now">⟳ Sync ngay</button></div>
    <div class="divider"></div>
    <div class="tiny faint">Lần cuối ${rel(st.lastSync)} · ${st.pending ? '<span style="color:var(--warn)">Có thay đổi chờ</span>' : 'Không có thay đổi chờ'} · ${st.error ? `<span style="color:var(--danger)">${esc(st.error)}</span>` : 'Không có lỗi'}</div>
  </div>
  <div class="card">
    <div class="card-head"><h2 class="card-title">🖥 Máy tính (cùng WiFi)</h2>
      <span class="tag ${pcBase() ? 'mint' : 'warn'}">${pcBase() ? 'Đã lưu' : 'Chưa có'}</span></div>
    <p class="muted tiny">Không bắt buộc. Dùng để lấy file HTML hoặc đẩy/kéo trực tiếp khi cùng WiFi.</p>
    ${location.protocol === 'https:' ? '<p class="tiny" style="color:var(--warn)">Bản đang dùng là HTTPS công khai — trình duyệt chặn gọi http:// LAN. Muốn dùng LAN, cài bản phone từ <b>http://IP-PC:4173/phone</b>; hoặc dùng Google Drive ở trên.</p>' : ''}
    <div class="field"><label>Địa chỉ máy tính</label><input id="pcUrl" value="${esc(pcBase())}" placeholder="http://192.168.1.68:4173"></div>
    <div class="field"><label>Mã ghép đôi trên PC</label><input id="pcCode" maxlength="6" placeholder="123456" inputmode="numeric"></div>
    <div class="row">
      <button class="btn" data-action="pc-pair">🔑 Ghép đôi</button>
      <button class="btn" data-action="pc-refresh">📄 Lấy danh sách</button>
      <button class="btn" data-action="pc-pull">⬇ Kéo</button>
      <button class="btn primary" data-action="pc-push">⬆ Đẩy</button>
    </div>
  </div>`;
}

function render() {
  const views = { home: renderHome, notes: renderNotes, tasks: renderTasks, library: renderLibrary, sync: renderSync };
  $('#view').innerHTML = (views[view] || renderHome)();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

/* --------------------------------------------------------------- actions */

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action], [data-view]');
  if (!el) return;
  if (el.dataset.view) { view = el.dataset.view; render(); return; }
  const action = el.dataset.action;
  const id = el.dataset.id;

  try {
    switch (action) {
      case 'goto': view = el.dataset.view; render(); break;

      case 'add-note': {
        const title = $('#noteTitle').value.trim();
        const body = $('#noteBody').value.trim();
        if (!title && !body) { toast('Nhập tiêu đề hoặc nội dung', 'err'); break; }
        const now = new Date().toISOString();
        S.notes.push({ id: uid(), title, body, createdAt: now, updatedAt: now });
        save(); toast('Đã lưu ghi chú', 'ok');
        break;
      }
      case 'delete-note':
        S.notes = S.notes.filter((n) => n.id !== id);
        S.tombstones.push({ collection: 'notes', id, ts: new Date().toISOString() });
        save(); break;

      case 'add-task': {
        const text = $('#taskText').value.trim();
        if (!text) { toast('Nhập việc cần làm', 'err'); break; }
        const now = new Date().toISOString();
        S.tasks.push({ id: uid(), text, due: $('#taskDue').value || '', done: false, createdAt: now, updatedAt: now });
        save(); toast('Đã thêm việc', 'ok');
        break;
      }
      case 'toggle-task': {
        const task = S.tasks.find((t) => t.id === id);
        if (task) { task.done = !task.done; task.updatedAt = new Date().toISOString(); }
        save(); break;
      }
      case 'delete-task':
        S.tasks = S.tasks.filter((t) => t.id !== id);
        S.tombstones.push({ collection: 'tasks', id, ts: new Date().toISOString() });
        save(); break;

      case 'pc-pair': {
        S.pcUrl = $('#pcUrl').value.trim().replace(/\/+$/, '');
        save();
        const r = await pcApi('/api/pair', { method: 'POST', body: {
          code: $('#pcCode').value.trim(), deviceId: phoneId(), label: 'MeApp Phone'
        } });
        localStorage.setItem(`meapp.pcToken:${pcBase()}`, r.token);
        toast('Đã ghép đôi với máy tính', 'ok');
        break;
      }
      case 'pc-refresh': {
        S.pcUrl = ($('#pcUrl')?.value || S.pcUrl).trim().replace(/\/+$/, '');
        save();
        const b = await pcApi('/api/bootstrap');
        S.docs = b.docs.map((d) => ({ id: d.id, name: d.name, title: d.title, kind: d.kind, kindLabel: d.kindLabel }));
        save(); toast(`Đã lấy ${S.docs.length} file`, 'ok');
        break;
      }
      case 'save-file': {
        const doc = S.docs.find((d) => d.id === id);
        if (!doc) break;
        if (location.protocol === 'https:' && pcBase().startsWith('http://')) {
          throw new Error('HTTPS không gọi được http:// LAN. Hãy cài bản phone từ http://<IP-PC>:4173/phone.');
        }
        const token = localStorage.getItem(`meapp.pcToken:${pcBase()}`);
        const res = await fetch(`${pcBase()}/api/preview?id=${encodeURIComponent(id)}`, {
          headers: token ? { 'X-MeApp-Token': token } : {}
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await putFile(id, await res.text());
        S.saved[id] = new Date().toISOString();
        save(); toast(`Đã lưu offline: ${doc.name}`, 'ok');
        break;
      }
      case 'read-file': {
        const rec = await getFile(id);
        if (!rec) { toast('File chưa được lưu offline', 'err'); break; }
        const url = URL.createObjectURL(new Blob([rec.html], { type: 'text/html;charset=utf-8' }));
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        break;
      }

      case 'save-sync': {
        S.sync = {
          clientId: $('#clientId').value.trim(),
          enabled: $('#syncEnabled').checked
        };
        localStorage.setItem(LS_PASS, $('#passphrase').value.trim());
        save();
        window.MeSync.configure({
          clientId: S.sync.clientId,
          passphrase: localStorage.getItem(LS_PASS) || '',
          enabled: S.sync.enabled
        });
        if (S.sync.enabled && S.sync.clientId) {
          try { await window.MeSync.connect(); toast('Đã kết nối Google Drive', 'ok'); }
          catch (err) { toast(err.message, 'err'); }
        }
        break;
      }
      case 'sync-now': {
        window.MeSync.configure({
          clientId: ($('#clientId')?.value || S.sync.clientId || '').trim(),
          passphrase: ($('#passphrase')?.value || localStorage.getItem(LS_PASS) || '').trim(),
          enabled: true
        });
        await window.MeSync.syncNow(true);
        toast('Đã đồng bộ', 'ok'); render();
        break;
      }
      case 'pc-pull': {
        const remote = await pcApi('/api/sync/pull');
        applyRemote(remote.snapshot);
        await pcApi('/api/sync/push', { method: 'POST', body: { snapshot: localSnapshot() } });
        toast('Đã kéo dữ liệu từ máy tính', 'ok');
        break;
      }
      case 'pc-push': {
        await pcApi('/api/sync/push', { method: 'POST', body: { snapshot: localSnapshot() } });
        toast('Đã đẩy dữ liệu lên máy tính', 'ok');
        break;
      }
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ------------------------------------------------------------------ boot */

function initClock() {
  const tick = () => {
    $('#clock').textContent = new Date().toLocaleString('vi-VN', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  tick(); setInterval(tick, 30000);
}

function initNetwork() {
  const update = () => {
    const el = $('#netBadge');
    el.textContent = navigator.onLine ? '● Online' : '● Offline';
    el.className = `net-badge ${navigator.onLine ? 'online' : 'offline'}`;
  };
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}

async function boot() {
  initClock();
  initNetwork();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  window.MeSync.init({
    getLocalSnapshot: localSnapshot,
    applyRemote,
    onStatus: () => { if (view === 'sync' || view === 'home') render(); },
    clientId: S.sync?.clientId || '',
    passphrase: localStorage.getItem(LS_PASS) || '',
    enabled: !!S.sync?.enabled
  });
  render();
}

boot();
