'use strict';

/**
 * MeApp Google Drive sync (browser side).
 * Uses Google Identity Services token model — no client secret needed.
 * Payload is AES-GCM encrypted with a passphrase before touching Drive.
 */

(function () {
  const FILE_NAME = 'meapp-sync.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const GIS_URL = 'https://accounts.google.com/gsi/client';
  const LS_CONSENT = 'meapp.drive.consent';
  const LS_DIRTY = 'meapp.syncDirty';

  let hooks = {};
  let clientId = '';
  let passphrase = '';
  let enabled = false;
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let pendingToken = null;
  let busy = false;
  let lastSync = null;
  let error = null;

  function status() {
    return {
      enabled, busy, lastSync, error,
      pending: !!localStorage.getItem(LS_DIRTY),
      connected: !!accessToken && Date.now() < tokenExpiry
    };
  }

  function report() {
    hooks.onStatus?.(status());
  }

  function loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Không tải được Google Identity Services (cần Internet)'));
      document.head.appendChild(script);
    });
  }

  async function ensureToken(interactive = false) {
    if (!clientId) throw new Error('Chưa nhập Google Client ID');
    await loadGIS();
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (response) => {
          const resolve = pendingToken;
          pendingToken = null;
          if (!resolve) return;
          if (response?.access_token) {
            accessToken = response.access_token;
            tokenExpiry = Date.now() + ((response.expires_in || 3600) - 120) * 1000;
            localStorage.setItem(LS_CONSENT, '1');
            error = null;
            resolve(response.access_token);
          } else {
            error = response?.error || 'Không lấy được token Google';
            resolve(null);
          }
          report();
        }
      });
    }
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    if (!interactive && !localStorage.getItem(LS_CONSENT)) return null;

    return new Promise((resolve, reject) => {
      pendingToken = (token) => token ? resolve(token) : reject(new Error(error || 'Cần kết nối lại Google'));
      try {
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (err) {
        pendingToken = null;
        reject(err);
      }
    });
  }

  function driveHeaders(token) {
    return { Authorization: `Bearer ${token}` };
  }

  async function findFile(token) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&pageSize=100`, { headers: driveHeaders(token) });
    if (!res.ok) throw new Error(`Drive list: HTTP ${res.status}`);
    const json = await res.json();
    return (json.files || []).find((f) => f.name === FILE_NAME) || null;
  }

  async function readFile(token, id) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: driveHeaders(token) });
    if (!res.ok) throw new Error(`Drive read: HTTP ${res.status}`);
    return res.text();
  }

  async function writeFile(token, id, text) {
    const boundary = `----MeApp${Date.now()}`;
    const metadata = JSON.stringify(id
      ? { name: FILE_NAME, mimeType: 'application/octet-stream' }
      : { name: FILE_NAME, mimeType: 'application/octet-stream', parents: ['appDataFolder'] });
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`
      + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--\r\n`;
    const url = id
      ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await fetch(url, {
      method: id ? 'PATCH' : 'POST',
      headers: { ...driveHeaders(token), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    if (!res.ok) throw new Error(`Drive write: HTTP ${res.status}`);
    return res.json();
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  async function deriveKey(salt) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptObject(object) {
    if (!passphrase) throw new Error('Đặt passphrase để mã hoá dữ liệu trước khi lên Drive');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(salt);
    const plain = new TextEncoder().encode(JSON.stringify(object));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return JSON.stringify({ v: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(cipher)) });
  }

  async function decryptObject(text) {
    if (!passphrase) throw new Error('Chưa có passphrase để giải mã dữ liệu Drive');
    const payload = JSON.parse(text);
    if (payload.v !== 1) throw new Error('Phiên bản dữ liệu Drive không hỗ trợ');
    const key = await deriveKey(base64ToBytes(payload.salt));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
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

  function mergeSnapshots(local, remote) {
    const tombstones = [...(local.tombstones || []), ...(remote.tombstones || [])].slice(-400);
    const data = { ...(local.data || {}) };
    for (const key of ['notes', 'tasks', 'shortcuts']) {
      data[key] = mergeArray(key, local.data?.[key], remote.data?.[key], tombstones);
    }
    const newerRemote = new Date(remote.updatedAt || 0).getTime() >= new Date(local.updatedAt || 0).getTime();
    if (newerRemote) {
      for (const key of ['favorites', 'hidden', 'tags', 'profile', 'interests', 'lastOpen', 'events', 'queries', 'pomodoro', 'theme', 'weights']) {
        if (remote.data?.[key] !== undefined) data[key] = remote.data[key];
      }
    }
    return {
      rev: Math.max(Number(local.rev) || 0, Number(remote.rev) || 0),
      updatedAt: newerRemote ? remote.updatedAt : local.updatedAt,
      tombstones,
      data
    };
  }

  async function syncNow(forcePush = false) {
    if (busy) return null;
    if (!enabled) return null;
    busy = true; error = null; report();
    try {
      const token = await ensureToken(false);
      if (!token) throw new Error('Chưa có quyền truy cập Drive');
      const local = hooks.getLocalSnapshot();
      const file = await findFile(token);
      let remote = null;
      if (file) {
        try { remote = await decryptObject(await readFile(token, file.id)); }
        catch (err) { throw new Error(`Không giải mã được dữ liệu Drive: ${err.message}`); }
      }
      const merged = mergeSnapshots(local, remote || { rev: 0, data: {} });
      const changed = !remote || forcePush || JSON.stringify(merged.data) !== JSON.stringify(remote.data);
      if (changed) {
        merged.rev = Math.max(merged.rev, (remote?.rev || 0)) + 1;
        merged.updatedAt = new Date().toISOString();
        await writeFile(token, file?.id, await encryptObject(merged));
      }
      // Always converge the browser state with the merged result. app.js
      // compares a signature first, so an unchanged snapshot will not
      // re-render or steal focus while the user is typing.
      hooks.applyRemote?.(merged);
      localStorage.removeItem(LS_DIRTY);
      lastSync = new Date().toISOString();
      report();
      return merged;
    } catch (err) {
      error = err.message;
      report();
      throw err;
    } finally {
      busy = false;
      report();
    }
  }

  function configure(options = {}) {
    if ('clientId' in options) clientId = options.clientId || '';
    if ('passphrase' in options) passphrase = options.passphrase || '';
    if ('enabled' in options) enabled = !!options.enabled;
    report();
  }

  function init(options = {}) {
    hooks = options;
    clientId = options.clientId || '';
    passphrase = options.passphrase || '';
    enabled = !!options.enabled;
    // No polling: a network restore only pushes changes that were queued while
    // offline, never an unchanged snapshot.
    window.addEventListener('online', () => {
      if (enabled && localStorage.getItem(LS_DIRTY) && navigator.onLine) {
        syncNow().catch(() => {});
      }
    });
  }

  window.MeSync = {
    init,
    configure,
    status,
    markDirty() { localStorage.setItem(LS_DIRTY, '1'); report(); },
    connect: () => ensureToken(true),
    syncNow,
    disconnect() {
      if (accessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(accessToken);
      accessToken = null;
      tokenExpiry = 0;
      localStorage.removeItem(LS_CONSENT);
      report();
    }
  };
})();
