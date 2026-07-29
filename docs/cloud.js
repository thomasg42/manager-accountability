/**
 * Cloud-first data layer.
 *
 * The Cloudflare Worker + D1 database is the ledger. localStorage is a
 * read-through cache so a manager mid-close on bad restaurant wifi still sees
 * the checklist, plus an outbox so a tick or a photo is never lost.
 *
 * Two credentials, set by the owner on first run and stored server-side as
 * salted SHA-256 hashes — never in this repo:
 *   access code : any manager, submits shifts and runs audits
 *   admin PIN   : roster, roles, GM notes, videos, completion messages, deletes
 */

const API_BASE = 'https://manager-accountability-sync.forevergoldai.workers.dev';

/** Collections mirrored from the worker. */
export const COLLECTIONS = ['profiles', 'shifts', 'notes', 'audits', 'messages', 'videos'];

const LS = {
  scope: 'ma_scope',
  token: 'ma_token',
  profile: 'ma_profile',
  cache: (name) => `ma_cache_${name}`,
  outbox: 'ma_outbox',
};

let onlineState = true;
const listeners = new Set();

export function onConnectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setOnline(next) {
  if (onlineState === next) return;
  onlineState = next;
  listeners.forEach((fn) => fn(onlineState));
}

export function isOnline() {
  return onlineState;
}

/* ----------------------------------- auth ---------------------------------- */

export function storedToken() {
  return localStorage.getItem(LS.token) || '';
}

export function storedScope() {
  return localStorage.getItem(LS.scope) || '';
}

export function isAdmin() {
  return storedScope() === 'admin';
}

export function signOut() {
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.scope);
  localStorage.removeItem(LS.profile);
}

export function dropAdmin() {
  if (storedScope() === 'admin') localStorage.setItem(LS.scope, 'staff');
}

async function request(path, { method = 'GET', body, token, allowAnonymous = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const bearer = token ?? storedToken();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (!allowAnonymous) throw new Error('Not unlocked');

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.error || `${method} ${path} failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function fetchStatus() {
  try {
    const status = await request('/api/status', { allowAnonymous: true });
    setOnline(true);
    return status;
  } catch (error) {
    setOnline(false);
    throw error;
  }
}

export async function claim(accessCode, adminPin) {
  return request('/api/auth/claim', { method: 'POST', body: { accessCode, adminPin }, allowAnonymous: true });
}

export async function unlock(code) {
  const result = await request('/api/auth/verify', { method: 'POST', body: { code }, token: code });
  localStorage.setItem(LS.token, code);
  localStorage.setItem(LS.scope, result.scope);
  setOnline(true);
  return result.scope;
}

export async function rotateCredentials({ currentAdminPin, accessCode, adminPin }) {
  const result = await request('/api/auth/rotate', {
    method: 'POST',
    body: { currentAdminPin, accessCode, adminPin },
  });
  if (adminPin && storedScope() === 'admin') localStorage.setItem(LS.token, adminPin);
  return result;
}

/* ---------------------------------- cache ---------------------------------- */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — the server still holds the record */
  }
}

export function cached(collection) {
  return readJson(LS.cache(collection), []);
}

/* ---------------------------------- outbox --------------------------------- */

function readOutbox() {
  return readJson(LS.outbox, []);
}

export function pendingWrites() {
  return readOutbox().length;
}

function queue(entry) {
  const entries = readOutbox().filter((item) => item.dedupeKey !== entry.dedupeKey);
  entries.push({ ...entry, queuedAt: new Date().toISOString() });
  writeJson(LS.outbox, entries);
}

export async function flushOutbox() {
  const entries = readOutbox();
  if (!entries.length || !storedToken()) return { flushed: 0, remaining: entries.length };

  const remaining = [];
  let flushed = 0;
  for (const entry of entries) {
    try {
      await request(entry.path, { method: entry.method, body: entry.body });
      flushed += 1;
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 429) continue;
      remaining.push(entry);
    }
  }
  writeJson(LS.outbox, remaining);
  setOnline(remaining.length === 0 || flushed > 0);
  return { flushed, remaining: remaining.length };
}

/* -------------------------------- collections ------------------------------ */

export async function list(collection) {
  try {
    const records = await request(`/api/${collection}`);
    writeJson(LS.cache(collection), records);
    setOnline(true);
    return { records, stale: false };
  } catch (error) {
    setOnline(false);
    return { records: cached(collection), stale: true, error };
  }
}

/** Loads every collection at once; each falls back to cache independently. */
export async function listAll() {
  const results = await Promise.all(COLLECTIONS.map((name) => list(name)));
  const data = {};
  let stale = false;
  COLLECTIONS.forEach((name, index) => {
    data[name] = results[index].records || [];
    if (results[index].stale) stale = true;
  });
  return { data, stale };
}

export async function save(collection, record) {
  const stamped = { ...record, updatedAt: new Date().toISOString() };
  const rows = cached(collection).filter((item) => item.id !== stamped.id);
  rows.unshift(stamped);
  writeJson(LS.cache(collection), rows);

  const path = `/api/${collection}/${encodeURIComponent(stamped.id)}`;
  try {
    const saved = await request(path, { method: 'PUT', body: stamped });
    writeJson(LS.cache(collection), cached(collection).map((item) => (item.id === saved.id ? saved : item)));
    setOnline(true);
    return saved;
  } catch (error) {
    if (error.status === 409) throw error; // already-submitted shift — surface it
    queue({ dedupeKey: `${collection}:${stamped.id}`, path, method: 'PUT', body: stamped });
    setOnline(false);
    return stamped;
  }
}

export async function remove(collection, id) {
  writeJson(LS.cache(collection), cached(collection).filter((item) => item.id !== id));
  const path = `/api/${collection}/${encodeURIComponent(id)}`;
  try {
    await request(path, { method: 'DELETE' });
  } catch {
    queue({ dedupeKey: `${collection}-delete:${id}`, path, method: 'DELETE' });
  }
}

/* ---------------------------------- photos --------------------------------- */

const MAX_PHOTO_BYTES = 900_000;

/**
 * Downscales to fit comfortably under the worker's per-image cap. Phone camera
 * originals are several MB, so uploading them raw would just 413.
 */
export async function compressImage(file, maxEdge = 1280) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  for (const quality of [0.82, 0.7, 0.58, 0.45, 0.34]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.split(',')[1] || '';
    if (base64.length <= MAX_PHOTO_BYTES) return { dataBase64: base64, mimeType: 'image/jpeg' };
  }
  throw new Error('Could not compress that photo small enough — try a tighter crop.');
}

export async function savePhoto(id, { dataBase64, mimeType }) {
  const path = `/api/photos/${encodeURIComponent(id)}`;
  try {
    await request(path, { method: 'PUT', body: { dataBase64, mimeType } });
    setOnline(true);
    return true;
  } catch (error) {
    if (error.status === 413) throw error;
    queue({ dedupeKey: `photo:${id}`, path, method: 'PUT', body: { dataBase64, mimeType } });
    setOnline(false);
    return false;
  }
}

export async function loadPhoto(id) {
  try {
    const photo = await request(`/api/photos/${encodeURIComponent(id)}`);
    return `data:${photo.mimeType};base64,${photo.dataBase64}`;
  } catch {
    return null;
  }
}

export async function deletePhoto(id) {
  try {
    await request(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* orphaned rows are harmless; the reference is already gone */
  }
}

/* ------------------------------ active profile ----------------------------- */

export function activeProfile() {
  return readJson(LS.profile, null);
}

export function setActiveProfile(profile) {
  if (profile) writeJson(LS.profile, profile);
  else localStorage.removeItem(LS.profile);
}

window.addEventListener('online', () => {
  flushOutbox().catch(() => {});
});
