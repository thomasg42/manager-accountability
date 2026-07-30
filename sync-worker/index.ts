/**
 * Manager Accountability sync worker.
 *
 * D1 is the ledger; the PWA treats localStorage as a cache only. Records are
 * stored as JSON blobs in one generic `records` table keyed by collection, so
 * adding a checklist or report type needs no migration.
 *
 * Two shared credentials, set once via /api/auth/claim and stored as salted
 * SHA-256 hashes — never in this repo:
 *   access code -> scope "staff" (submit shifts, run audits, read history)
 *   admin PIN   -> scope "admin" (staff rights + roster, roles, notes, videos,
 *                  deletes, completion messages)
 */

interface Env {
  DB: D1Database;
}

type Scope = 'admin' | 'staff';
type Dict = Record<string, unknown>;

const ALLOWED_ORIGINS = ['https://thomasg42.github.io'];
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Collections a staff-scope credential may write. Videos are staff-writable so
 *  profile #177 can update training links without the device admin PIN; the UI
 *  still only shows the URL fields to #177. */
const STAFF_WRITABLE = new Set(['profiles', 'shifts', 'notes', 'audits', 'videos']);
/** Collections only the admin PIN may write. */
const ADMIN_WRITABLE = new Set(['messages']);
const COLLECTIONS = new Set([...STAFF_WRITABLE, ...ADMIN_WRITABLE]);

/** Staff access code may be short (employee number). Admin PIN stays longer. */
const MIN_ACCESS_CODE = 3;
const MIN_ADMIN_PIN = 6;

const MAX_PHOTO_BYTES = 900_000;

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (LOCALHOST.test(origin)) return origin;
  return null;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  const origin = allowedOrigin(request);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(request: Request, payload: unknown, status = 200): Response {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
}

function fail(request: Request, message: string, status: number): Response {
  return json(request, { error: message }, status);
}

/* ------------------------------- credentials ------------------------------ */

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashCode(salt: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${code}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

type CredentialRow = { name: string; salt: string; hash: string };

async function readCredential(env: Env, name: string): Promise<CredentialRow | null> {
  return env.DB.prepare('SELECT name, salt, hash FROM credentials WHERE name = ?')
    .bind(name)
    .first<CredentialRow>();
}

async function writeCredential(env: Env, name: string, code: string): Promise<void> {
  const salt = randomSalt();
  const hash = await hashCode(salt, code);
  await env.DB.prepare(
    `INSERT INTO credentials (name, salt, hash, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated_at = excluded.updated_at`,
  )
    .bind(name, salt, hash, new Date().toISOString())
    .run();
}

async function claimed(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM credentials').first<{ total: number }>();
  return Boolean(row && row.total > 0);
}

async function scopeFor(env: Env, request: Request): Promise<Scope | null> {
  const header = request.headers.get('Authorization') || '';
  const code = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!code) return null;

  const admin = await readCredential(env, 'admin_pin');
  if (admin && sameHash(await hashCode(admin.salt, code), admin.hash)) return 'admin';

  const staff = await readCredential(env, 'access_code');
  if (staff && sameHash(await hashCode(staff.salt, code), staff.hash)) return 'staff';

  return null;
}

function validCode(value: unknown, minLength: number): value is string {
  return typeof value === 'string' && value.trim().length >= minLength && value.trim().length <= 64;
}

/* --------------------------------- routing -------------------------------- */

function collectionRoute(pathname: string): { collection: string; id?: string } | null {
  const single = /^\/api\/([a-z]+)$/.exec(pathname);
  if (single && COLLECTIONS.has(single[1])) return { collection: single[1] };
  const withId = /^\/api\/([a-z]+)\/([^/]+)$/.exec(pathname);
  if (withId && COLLECTIONS.has(withId[1])) return { collection: withId[1], id: decodeURIComponent(withId[2]) };
  return null;
}

function photoRoute(pathname: string): string | null {
  const match = /^\/api\/photos\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (!allowedOrigin(request)) {
      return fail(request, 'Origin not allowed', 403);
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/api/status' && request.method === 'GET') {
      return json(request, { claimed: await claimed(env) });
    }

    if (pathname === '/api/auth/claim' && request.method === 'POST') {
      if (await claimed(env)) return fail(request, 'Already set up. Use rotate instead.', 409);
      const body = (await request.json().catch(() => ({}))) as Dict;
      if (!validCode(body.accessCode, MIN_ACCESS_CODE)) return fail(request, `Access code must be at least ${MIN_ACCESS_CODE} characters`, 400);
      if (!validCode(body.adminPin, MIN_ADMIN_PIN)) return fail(request, `Admin PIN must be at least ${MIN_ADMIN_PIN} characters`, 400);
      if (String(body.accessCode).trim() === String(body.adminPin).trim()) {
        return fail(request, 'Access code and admin PIN must be different', 400);
      }
      await writeCredential(env, 'access_code', String(body.accessCode).trim());
      await writeCredential(env, 'admin_pin', String(body.adminPin).trim());
      return json(request, { claimed: true }, 201);
    }

    if (pathname === '/api/auth/verify' && request.method === 'POST') {
      const scope = await scopeFor(env, request);
      if (!scope) return fail(request, 'Wrong code', 401);
      return json(request, { scope });
    }

    const scope = await scopeFor(env, request);
    if (!scope) return fail(request, 'Not unlocked', 401);

    if (pathname === '/api/auth/rotate' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Dict;
      const admin = await readCredential(env, 'admin_pin');
      if (!admin || !sameHash(await hashCode(admin.salt, String(body.currentAdminPin || '')), admin.hash)) {
        return fail(request, 'Current admin PIN is wrong', 401);
      }
      if (body.accessCode !== undefined) {
        if (!validCode(body.accessCode, MIN_ACCESS_CODE)) return fail(request, `Access code must be at least ${MIN_ACCESS_CODE} characters`, 400);
        await writeCredential(env, 'access_code', String(body.accessCode).trim());
      }
      if (body.adminPin !== undefined) {
        if (!validCode(body.adminPin, MIN_ADMIN_PIN)) return fail(request, `Admin PIN must be at least ${MIN_ADMIN_PIN} characters`, 400);
        await writeCredential(env, 'admin_pin', String(body.adminPin).trim());
      }
      return json(request, { rotated: true });
    }

    /* -------------------------------- photos ------------------------------- */

    const photoId = photoRoute(pathname);
    if (photoId) {
      if (request.method === 'GET') {
        const row = await env.DB.prepare('SELECT mime_type, data_base64 FROM photos WHERE id = ?')
          .bind(photoId)
          .first<{ mime_type: string; data_base64: string }>();
        if (!row) return fail(request, 'Not found', 404);
        return json(request, { id: photoId, mimeType: row.mime_type, dataBase64: row.data_base64 });
      }
      if (request.method === 'PUT') {
        const body = (await request.json().catch(() => ({}))) as Dict;
        const data = String(body.dataBase64 || '');
        const mime = String(body.mimeType || 'image/jpeg');
        if (!data) return fail(request, 'dataBase64 is required', 400);
        if (data.length > MAX_PHOTO_BYTES) {
          return fail(request, 'Photo too large — downscale before upload', 413);
        }
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) return fail(request, 'Unsupported image type', 400);
        await env.DB.prepare(
          `INSERT INTO photos (id, mime_type, data_base64, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET mime_type = excluded.mime_type, data_base64 = excluded.data_base64, updated_at = excluded.updated_at`,
        )
          .bind(photoId, mime, data, new Date().toISOString())
          .run();
        return json(request, { id: photoId, saved: true });
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run();
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
    }

    /* ------------------------------ collections ---------------------------- */

    const route = collectionRoute(pathname);
    if (!route) return fail(request, 'Not found', 404);

    const canWrite = scope === 'admin' || STAFF_WRITABLE.has(route.collection);

    if (!route.id && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT data FROM records WHERE collection = ? ORDER BY updated_at DESC',
      )
        .bind(route.collection)
        .all<{ data: string }>();
      return json(request, (rows.results || []).map((row) => JSON.parse(row.data)));
    }

    if (route.id && request.method === 'PUT') {
      if (!canWrite) return fail(request, 'Admin PIN required', 403);
      const incoming = (await request.json().catch(() => null)) as Dict | null;
      if (!incoming) return fail(request, 'Body must be a JSON object', 400);

      const existing = await env.DB.prepare('SELECT data FROM records WHERE collection = ? AND id = ?')
        .bind(route.collection, route.id)
        .first<{ data: string }>();
      const current = existing ? (JSON.parse(existing.data) as Dict) : null;

      // A submitted shift is a signed record — refuse edits from staff scope so
      // a later draft auto-save cannot quietly rewrite a filed submission.
      if (current && current.isFinal === true && route.collection === 'shifts' && scope !== 'admin') {
        return fail(request, 'That shift is already submitted', 409);
      }

      const merged: Dict = { ...(current || {}), ...incoming, id: route.id, updatedAt: new Date().toISOString() };
      await env.DB.prepare(
        `INSERT INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
        .bind(route.collection, route.id, JSON.stringify(merged), String(merged.updatedAt))
        .run();
      return json(request, merged);
    }

    if (route.id && request.method === 'DELETE') {
      if (scope !== 'admin') return fail(request, 'Admin PIN required', 403);
      await env.DB.prepare('DELETE FROM records WHERE collection = ? AND id = ?')
        .bind(route.collection, route.id)
        .run();
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    return fail(request, 'Not found', 404);
  },
};
