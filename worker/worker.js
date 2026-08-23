/**
 * CHLOE cloud-save API — Cloudflare Worker (ES module, zero dependencies).
 *
 * Routes (all POST, JSON bodies):
 *   POST /register  {name, pinHash}        -> 200 {ok:true} | 409 if name taken
 *   POST /login     {name, pinHash}        -> 200 {ok:true, savedAt}
 *   POST /save      {name, pinHash, save}  -> 200 {ok:true, savedAt}
 *   POST /load      {name, pinHash}        -> 200 {ok:true, save, savedAt}
 *
 * Storage: KV binding CHLOE_KV, key 'acct:' + name.toLowerCase(),
 * value JSON {pinHash, save, savedAt}. pinHash is never echoed back.
 */

const MAX_NAME_LEN = 16;
const MAX_SAVE_BYTES = 64 * 1024;      // 64KB cap on the save payload
const MAX_BODY_BYTES = 72 * 1024;      // raw request body guard (save + envelope)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function byteLen(str) {
  return new TextEncoder().encode(str).length;
}

/** Constant-time string comparison (avoids trivial timing leaks on pinHash). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validName(name) {
  return typeof name === 'string'
    && name.length >= 1
    && name.length <= MAX_NAME_LEN
    && name.trim().length >= 1;
}

function validPinHash(pinHash) {
  // SHA-256 hex from the client; accept any reasonable hex-ish token.
  return typeof pinHash === 'string' && pinHash.length >= 16 && pinHash.length <= 128;
}

function kvKey(name) {
  return 'acct:' + name.toLowerCase();
}

async function readBody(request) {
  const text = await request.text();
  if (byteLen(text) > MAX_BODY_BYTES) {
    return { error: json(413, { ok: false, error: 'Request body too large' }) };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: json(400, { ok: false, error: 'Invalid JSON body' }) };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: json(400, { ok: false, error: 'Body must be a JSON object' }) };
  }
  if (!validName(body.name)) {
    return { error: json(400, { ok: false, error: 'Invalid name (1-16 characters required)' }) };
  }
  if (!validPinHash(body.pinHash)) {
    return { error: json(400, { ok: false, error: 'Invalid pinHash' }) };
  }
  return { body };
}

/** Load the account record and check credentials. Returns {acct} or {error}. */
async function authenticate(env, name, pinHash) {
  const raw = await env.CHLOE_KV.get(kvKey(name));
  if (raw === null) {
    return { error: json(401, { ok: false, error: 'Unknown account or wrong PIN' }) };
  }
  let acct;
  try {
    acct = JSON.parse(raw);
  } catch {
    return { error: json(500, { ok: false, error: 'Corrupt account record' }) };
  }
  if (!safeEqual(acct.pinHash, pinHash)) {
    return { error: json(401, { ok: false, error: 'Unknown account or wrong PIN' }) };
  }
  return { acct };
}

async function handleRegister(env, body) {
  const key = kvKey(body.name);
  const existing = await env.CHLOE_KV.get(key);
  if (existing !== null) {
    return json(409, { ok: false, error: 'Name already taken' });
  }
  const record = { pinHash: body.pinHash, save: null, savedAt: 0 };
  await env.CHLOE_KV.put(key, JSON.stringify(record));
  return json(200, { ok: true });
}

async function handleLogin(env, body) {
  const { acct, error } = await authenticate(env, body.name, body.pinHash);
  if (error) return error;
  return json(200, { ok: true, savedAt: acct.savedAt || 0 });
}

async function handleSave(env, body) {
  const { acct, error } = await authenticate(env, body.name, body.pinHash);
  if (error) return error;

  if (body.save === undefined || body.save === null) {
    return json(400, { ok: false, error: 'Missing save payload' });
  }
  const saveStr = JSON.stringify(body.save);
  if (byteLen(saveStr) > MAX_SAVE_BYTES) {
    return json(413, { ok: false, error: 'Save payload exceeds 64KB' });
  }

  const savedAt = (body.save && typeof body.save.savedAt === 'number')
    ? body.save.savedAt
    : Date.now();

  const record = { pinHash: acct.pinHash, save: body.save, savedAt };
  await env.CHLOE_KV.put(kvKey(body.name), JSON.stringify(record));
  return json(200, { ok: true, savedAt });
}

async function handleLoad(env, body) {
  const { acct, error } = await authenticate(env, body.name, body.pinHash);
  if (error) return error;
  return json(200, {
    ok: true,
    save: acct.save !== undefined ? acct.save : null,
    savedAt: acct.savedAt || 0,
  });
}

const ROUTES = {
  '/register': handleRegister,
  '/login': handleLogin,
  '/save': handleSave,
  '/load': handleLoad,
};

export default {
  async fetch(request, env) {
    // CORS preflight — answer for any path so the browser never chokes.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const handler = ROUTES[path];

    if (!handler || request.method !== 'POST') {
      return json(404, { ok: false, error: 'Not found' });
    }

    try {
      const { body, error } = await readBody(request);
      if (error) return error;
      return await handler(env, body);
    } catch (err) {
      return json(500, { ok: false, error: 'Internal error' });
    }
  },
};
