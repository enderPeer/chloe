/**
 * CHLOE API — Cloudflare Worker (ES module, zero dependencies).
 *
 * THE LIVE PART — the world record board (GAME_SPEC.md §27E):
 *   GET  /records[?limit=N]                -> 200 {ok:true, records:[...]}
 *   POST /records  {name, round, timeMs, patch}
 *                                          -> 200 {ok:true, record, records:[...]}
 *
 * THE MOTHBALLED PART — cloud saves, kept intact for reference. CHLOE became a
 * roguelike in §15 (no accounts, no saves) and nothing in the game calls these
 * any more. They are left standing rather than deleted because the record board
 * reuses the same deploy, the same KV namespace and the same CORS contract, and
 * a working example of the auth shape is worth more in the file than in git
 * history. Do not wire them back up without revisiting §15.
 *   POST /register  {name, pinHash}        -> 200 {ok:true} | 409 if name taken
 *   POST /login     {name, pinHash}        -> 200 {ok:true, savedAt}
 *   POST /save      {name, pinHash, save}  -> 200 {ok:true, savedAt}
 *   POST /load      {name, pinHash}        -> 200 {ok:true, save, savedAt}
 *
 * Storage: KV binding CHLOE_KV.
 *   'acct:<name lowercased>'  {pinHash, save, savedAt}   (mothballed)
 *   'records:v1'              {v:1, rows:[...]}          (the board)
 *   'rl:<ip>'                 {n, until}                 (rate limiter)
 * pinHash is never echoed back.
 */

const MAX_NAME_LEN = 16;
const MAX_SAVE_BYTES = 64 * 1024;      // 64KB cap on the save payload
const MAX_BODY_BYTES = 72 * 1024;      // raw request body guard (save + envelope)

/* ---- record board limits (mirror engine/records.js — see README) ---- */
const REC_KEY = 'records:v1';
const REC_SCHEMA = 1;
const REC_NAME_MAX = 12;               // §27E: 1-12 chars, same as the client
const REC_TABLE_CAP = 100;             // how many the table KEEPS
const REC_PAGE_DEFAULT = 10;           // how many a bare GET returns (§27E top 10)
const REC_MAX_ROUND = 100000;
const REC_MAX_TIME_MS = 30 * 86400000; // 30 days; anything longer is not a run
const REC_BODY_BYTES = 2 * 1024;       // a record is tiny — refuse anything bigger

/* ---- rate limiting ----
   Per-IP, and only on the WRITE path. Reads are not metered because metering a
   read would require a KV write per read, which costs more of the free tier
   (1,000 writes/day) than the abuse it prevents. */
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX_WRITES = 5;               // 5 submitted records per IP per minute

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // GET joined POST when the board landed — the browser preflights the POST and
  // will reject the whole route if the method is not listed here.
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/** Read + parse a JSON object body under `maxBytes`. Returns {body} or {error}. */
async function readJson(request, maxBytes) {
  const text = await request.text();
  if (byteLen(text) > maxBytes) {
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
  return { body };
}

async function readBody(request) {
  const { body, error } = await readJson(request, MAX_BODY_BYTES);
  if (error) return { error };
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

/* =======================================================================
   THE RECORD BOARD (§27E)
   No auth by design. A record is a name and a number on a wall, not an
   account — asking a player to register before they can be on the board
   would cost more than the board is worth. The defences are therefore
   shape validation, a per-IP write limit and a hard table cap, and the
   honest expectation is a small friendly board, not a tamper-proof one.
   That trade is stated in worker/README.md so nobody is surprised by it.
   ===================================================================== */

/** Same scrub as engine/records.js sanitiseName: control chars, markup, then
 *  collapse and cap. Server-side because a client is never a validator. */
function cleanRecName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REC_NAME_MAX)
    .trim();
}

/** Validate an incoming record. Returns the stored shape, or null. */
function cleanRecord(r, receivedAt) {
  if (!r || typeof r !== 'object') return null;
  const name = cleanRecName(r.name);
  if (!name) return null;

  const round = Math.floor(Number(r.round));
  if (!Number.isFinite(round) || round < 1 || round > REC_MAX_ROUND) return null;

  let timeMs = Math.floor(Number(r.timeMs));
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > REC_MAX_TIME_MS) return null;

  // Patch is a display string, so it is whitelisted rather than escaped —
  // it goes straight onto a canvas in someone else's browser.
  const patch = (typeof r.patch === 'string' && /^[\w.\-+ ]{1,16}$/.test(r.patch.trim()))
    ? r.patch.trim()
    : '?';

  // The server stamps the date. A client-supplied timestamp is the one field
  // a cheat would reach for first, and nothing needs it to be the client's.
  return { name, round, timeMs, patch, dateISO: new Date(receivedAt).toISOString() };
}

/** Round DESC, time ASC, oldest claim first — identical to the client sort so
 *  the local and world boards never disagree about who is first. */
function sortRecords(rows) {
  return rows.slice().sort((a, b) => {
    if (b.round !== a.round) return b.round - a.round;
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return String(a.dateISO) < String(b.dateISO) ? -1 : 1;
  });
}

/** Read the table. Corrupt or missing reads as empty — the board must never be
 *  the reason a request 500s. */
async function readRecords(env) {
  let raw;
  try {
    raw = await env.CHLOE_KV.get(REC_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let blob;
  try {
    blob = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(blob) ? blob : (blob && blob.rows);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    // Re-validate on the way OUT as well: a row written by an older, looser
    // build must not be able to serve markup to a current client.
    const c = cleanRecord(r, Date.parse(r && r.dateISO) || Date.now());
    if (c) out.push(c);
  }
  return sortRecords(out).slice(0, REC_TABLE_CAP);
}

async function writeRecords(env, rows) {
  await env.CHLOE_KV.put(REC_KEY, JSON.stringify({
    v: REC_SCHEMA,
    rows: sortRecords(rows).slice(0, REC_TABLE_CAP),
  }));
}

/** Per-IP write limiter. KV is eventually consistent, so this is a speed bump
 *  rather than a lock — enough to stop a loop, not a determined attacker. */
async function rateLimited(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = 'rl:' + ip;
  const nowMs = Date.now();
  let rec = null;
  try {
    const raw = await env.CHLOE_KV.get(key);
    if (raw) rec = JSON.parse(raw);
  } catch {
    rec = null;
  }
  if (!rec || typeof rec.until !== 'number' || rec.until < nowMs) {
    rec = { n: 0, until: nowMs + RL_WINDOW_MS };
  }
  rec.n += 1;
  try {
    // expirationTtl keeps the limiter from growing the namespace forever.
    await env.CHLOE_KV.put(key, JSON.stringify(rec), { expirationTtl: 120 });
  } catch {
    // If the limiter cannot be written, let the request through rather than
    // locking everyone out on a KV hiccup.
    return false;
  }
  return rec.n > RL_MAX_WRITES;
}

function pageSize(url) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return REC_PAGE_DEFAULT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return REC_PAGE_DEFAULT;
  return Math.min(n, REC_TABLE_CAP);
}

async function handleGetRecords(env, request, url) {
  const rows = await readRecords(env);
  return json(200, { ok: true, records: rows.slice(0, pageSize(url)) });
}

async function handlePostRecord(env, request, url) {
  if (await rateLimited(env, request)) {
    return json(429, { ok: false, error: 'Too many records submitted — try again in a minute' });
  }
  const { body, error } = await readJson(request, REC_BODY_BYTES);
  if (error) return error;

  const rec = cleanRecord(body, Date.now());
  if (!rec) {
    return json(400, {
      ok: false,
      error: 'Invalid record (name 1-12 chars, round >= 1, timeMs >= 0)',
    });
  }

  // Read-modify-write. KV offers no compare-and-set, so two records landing in
  // the same instant can lose one. Accepted deliberately: the alternative is a
  // Durable Object, which is not on the free plan this game is hosted from.
  const rows = await readRecords(env);
  rows.push(rec);
  await writeRecords(env, rows);

  const fresh = sortRecords(rows).slice(0, REC_TABLE_CAP);
  return json(200, {
    ok: true,
    record: rec,
    records: fresh.slice(0, pageSize(url)),
  });
}

/** method + path -> handler, for the routes that are not the POST-only,
 *  name+pinHash-shaped cloud-save ones. */
const REC_ROUTES = {
  'GET /records': handleGetRecords,
  'POST /records': handlePostRecord,
};

export default {
  async fetch(request, env) {
    // CORS preflight — answer for any path so the browser never chokes.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // The record board first: it has its own body shape (no pinHash) and its
      // own methods, so it is routed before the cloud-save envelope is applied.
      const recHandler = REC_ROUTES[request.method + ' ' + path];
      if (recHandler) return await recHandler(env, request, url);

      const handler = ROUTES[path];
      if (!handler || request.method !== 'POST') {
        return json(404, { ok: false, error: 'Not found' });
      }
      const { body, error } = await readBody(request);
      if (error) return error;
      return await handler(env, body);
    } catch (err) {
      return json(500, { ok: false, error: 'Internal error' });
    }
  },
};
