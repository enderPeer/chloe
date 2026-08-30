/**
 * CHLOE API — Cloudflare Worker (ES module, zero dependencies).
 *
 * THE LIVE PART — the world record board (GAME_SPEC.md §27E):
 *   GET  /records[?limit=N]                -> 200 {ok:true, records:[...]}
 *   POST /records  {name, round, timeMs, patch}
 *                                          -> 200 {ok:true, record, records:[...]}
 *
 * THE OTHER LIVE PART — the PvP relay (GAME_SPEC.md §32):
 *   GET  /pvp?room=CODE  (Upgrade: websocket)
 *                                          -> 101, joined to one PvpRoom
 * Dumb fan-out, not a simulation: the room hands every frame to the other
 * sockets and knows nothing about the match. Authority lives on the clients.
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
 *
 * Plus Durable Object binding PVP_ROOM (class PvpRoom, SQLite-backed): one
 * object per room code, holding live sockets and persisting nothing at all.
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

/* ---- the PvP relay (§32) ----
   Every limit below is enforced inside the Durable Object, in memory. None of
   it goes through rateLimited(): that costs a KV write per call against a
   1,000-writes/day budget, and one full room carries ~120 messages a second. */
const ROOM_MAX_SOCKETS = 8;            // §32: eight players, one Ring, one life
const ROOM_CODE_MIN = 3;               // the client mints 4 (data/pvp.js roomCodeLen);
const ROOM_CODE_MAX = 8;               // both bounds are loose so changing that
                                       // length never needs a redeploy here
const PVP_MSG_CHARS = 2 * 1024;        // a `state` frame is ~120 chars. Characters,
                                       // not bytes: the cheap check is the right
                                       // one 120 times a second, and the cap is far
                                       // above anything the protocol sends
const PVP_ID_MAX = 40;                 // peer ids are minted client-side; bound them
                                       // before one is echoed back to seven browsers
const PVP_RL_WINDOW_MS = 1000;
const PVP_RL_MAX_MSGS = 60;            // 15 Hz of `state` (data/pvp.js sendHz) is the
                                       // hot path; 60/s leaves four times that for
                                       // swings, hits and roster chatter
const PVP_RL_KILL_MSGS = 600;          // 10x over budget for a whole second is a send
                                       // loop, not a lag spike — that one gets closed
const PVP_CLOSE_FULL = 4001;           // WebSocket application close codes must sit
const PVP_CLOSE_FLOOD = 4002;          // in 4000-4999; anything else is refused

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
  // the same instant can lose one. Still accepted deliberately, but the reason
  // written here has expired: it used to say the alternative was a Durable
  // Object, "which is not on the free plan this game is hosted from". That
  // stopped being true in April 2025, when Cloudflare opened SQLite-backed
  // Durable Objects to the Workers Free plan — PvpRoom below is one, on this
  // very deploy. Moving the board onto a DO is now merely a migration nobody
  // has needed: a rare lost record on a hobby board is cheaper than the churn.
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

/* =======================================================================
   THE PvP RELAY (§32)
   `GET /pvp?room=CODE` upgrades to a WebSocket served by one Durable Object
   per room code. The object does not simulate the match — it fans each frame
   out to the other sockets in the room and nothing else. Authority lives on
   the clients (§32 ownership table), which is the same friendly-not-tamper-
   proof trade the record board above makes: a modified client can lie about
   damage or refuse to die, because an authoritative simulation cannot run on
   the free static hosting this game is built for. Written down in
   worker/README.md so nobody is surprised by it.
   ===================================================================== */

/** Room codes get read off one screen and typed into another, so fold case and
 *  drop everything that is not a letter or a digit before the string is used
 *  as a Durable Object name — `abcd`, `AB-CD` and `abcd ` must all be the same
 *  room. Same shape as cleanRecName: scrub, then bound. Server-side because a
 *  client is never a validator, and this string decides which object a player
 *  lands in. */
function cleanRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_MAX);
  return code.length >= ROOM_CODE_MIN ? code : '';
}

/** Scrub every display name in a message, in place. Returns true if anything
 *  changed, so the caller can forward the original frame verbatim when nothing
 *  did — a `state` message carries no name at all, and proving that with a
 *  stringify 120 times a second is not worth the CPU.
 *
 *  A PvP name lands on a canvas in seven other browsers, which is exactly the
 *  path `patch` and a record name take, so it gets exactly the same scrub:
 *  cleanRecName itself, deliberately not a copy of it. A fix to one of these
 *  must not be able to miss the other. Note the host's `roster` is scrubbed
 *  too — the host is a client, and a client is never a validator. */
function scrubPvpNames(msg) {
  let changed = false;
  if (typeof msg.name === 'string') {           // `hello`
    const clean = cleanRecName(msg.name);
    if (clean !== msg.name) { msg.name = clean; changed = true; }
  }
  if (Array.isArray(msg.players)) {             // `roster`, minted by the host
    for (const p of msg.players) {
      if (!p || typeof p.name !== 'string') continue;
      const clean = cleanRecName(p.name);
      if (clean !== p.name) { p.name = clean; changed = true; }
    }
  }
  return changed;
}

/** GET /pvp — validate, then hand the untouched Request to the room object so
 *  the WebSocket handshake completes inside it. */
async function handlePvpUpgrade(env, request, url) {
  // This route lives in REC_ROUTES, and it has to: a ROUTES handler is called
  // as (env, body) *after* readBody() has drained the request, and the Upgrade
  // header would have gone with it.
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return json(426, { ok: false, error: 'GET /pvp is a WebSocket endpoint (Upgrade: websocket)' });
  }

  // Three spellings of the same parameter. The relay does not care which one a
  // client picked, and a disagreement here is a room nobody can ever join.
  const code = cleanRoomCode(url.searchParams.get('room')
    || url.searchParams.get('code')
    || url.searchParams.get('r'));
  if (!code) {
    return json(400, {
      ok: false,
      error: 'Invalid room code (' + ROOM_CODE_MIN + '-' + ROOM_CODE_MAX + ' letters or digits)',
    });
  }

  // No binding means this Worker was deployed from a wrangler.toml without the
  // durable_objects block. Say so plainly instead of letting the top-level
  // catch turn a missing binding into an opaque 500.
  if (!env.PVP_ROOM) {
    return json(503, { ok: false, error: 'PvP relay is not deployed on this Worker' });
  }

  // idFromName is the entire matchmaker: everybody who types the same code
  // resolves to the same object, from anywhere in the world.
  const stub = env.PVP_ROOM.get(env.PVP_ROOM.idFromName(code));
  return stub.fetch(request);
}

/** One room. Holds up to ROOM_MAX_SOCKETS live sockets and no durable state
 *  whatsoever: when the last player leaves, there is nothing left to forget. */
export class PvpRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Per-socket send budget, in memory. rateLimited() above is the wrong tool
    // here — one KV write per message against a 1,000/day budget — and this
    // counter is both free and exactly consistent, because there is only ever
    // one object per room code. It is lost when the room hibernates, which is
    // correct: a room quiet enough to hibernate has nothing to throttle.
    this.budget = new Map();
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());

    if (this.state.getWebSockets().length >= ROOM_MAX_SOCKETS) {
      // The ninth joiner is refused with a close CODE, not an HTTP status. A
      // handshake that never reaches 101 arrives in the browser as a bare 1006
      // with no reason attached, so the lobby could not tell "room full" from
      // "relay offline" — and those want very different words on screen.
      // Plain accept() rather than acceptWebSocket(): this socket is closed in
      // the same tick and never needs to hibernate.
      server.accept();
      server.close(PVP_CLOSE_FULL, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Hibernation, not server.accept(). A held socket bills Durable Object
    // duration for as long as it is open, so a ten-minute match — or worse, a
    // lobby forgotten in a background tab — would keep the object awake and
    // billing throughout. acceptWebSocket() hands the socket to the runtime,
    // which evicts the object between messages and wakes it into
    // webSocketMessage() below. On the free tier that is the whole difference;
    // worker/README.md carries the arithmetic.
    this.state.acceptWebSocket(server);

    // This response deliberately BYPASSES json() — the only one in the file
    // that does. It needs a null body and the Cloudflare-specific `webSocket`
    // ResponseInit field, and it must not carry CORS headers: browsers do not
    // preflight `new WebSocket()`, so CORS is inert on a handshake, and extra
    // headers on a 101 are a way to make one fail. Do not "fix" this back.
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- the hibernation handlers ---- */

  webSocketMessage(ws, message) {
    // Nothing may throw out of here. An exception in a socket handler resets
    // the object and takes the other seven players' match down with it, so
    // every failure below is a dropped frame instead.
    try {
      // Budget FIRST, ahead of every shape check. What costs the room is being
      // woken, and a junk frame wakes it exactly as hard as a good one — meter
      // the size check and a peer could hold the object awake all match with
      // oversized rubbish and never once be closed for it.
      const over = this.spend(ws);
      if (over === 'flood') {
        try { ws.close(PVP_CLOSE_FLOOD, 'Too many messages'); } catch { /* already gone */ }
        this.dropped(ws);
        return;
      }
      // Merely over budget: drop the frame, keep the socket. A burst is far
      // more often a lag spike catching up than an attack, and closing on one
      // would eject a player for their own bad wifi.
      if (over) return;

      if (typeof message !== 'string') return;      // the protocol is JSON text
      if (message.length > PVP_MSG_CHARS) return;

      let msg;
      try { msg = JSON.parse(message); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (typeof msg.t !== 'string') return;        // unknown shapes go nowhere

      if (msg.t === 'hello') this.remember(ws, msg);

      // Forward the original bytes when the scrub changed nothing, which is
      // every `state` frame — the hot path pays no stringify.
      this.fanOut(ws, scrubPvpNames(msg) ? JSON.stringify(msg) : message);
    } catch {
      /* a malformed frame is dropped, never fatal */
    }
  }

  webSocketClose(ws) { this.dropped(ws); }

  webSocketError(ws) { this.dropped(ws); }

  /* ---- internals ---- */

  /** Per-socket budget over a one-second window. Returns '' within budget,
   *  'drop' over it, 'flood' when the socket is so far over that it is holding
   *  the room awake on purpose. Per SOCKET rather than per room deliberately:
   *  a single room-wide counter would let one loud peer throttle the other
   *  seven, and eight sockets at PVP_RL_MAX_MSGS already bounds the room. */
  spend(ws) {
    const nowMs = Date.now();
    let b = this.budget.get(ws);
    if (!b || b.until < nowMs) {
      b = { n: 0, until: nowMs + PVP_RL_WINDOW_MS };
      this.budget.set(ws, b);
    }
    b.n += 1;
    if (b.n > PVP_RL_KILL_MSGS) return 'flood';
    return b.n > PVP_RL_MAX_MSGS ? 'drop' : '';
  }

  /** Note who a socket belongs to, off its `hello`. serializeAttachment is the
   *  only per-socket memory that survives hibernation — a plain property on
   *  `ws` would be gone the first time the room is evicted. The peer's own `v`
   *  is stored alongside its id so the relay never has to invent a protocol
   *  version for the `bye` it may have to mint in dropped(). */
  remember(ws, msg) {
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > PVP_ID_MAX) return;
    if (typeof msg.v !== 'number') return;
    try {
      ws.serializeAttachment({ id: msg.id, v: msg.v });
    } catch {
      /* the attachment is a nicety; peerTimeoutMs still covers the peer */
    }
  }

  /** A socket left, cleanly or otherwise. This is the ONE place the relay
   *  speaks on its own behalf rather than fanning out what it was given: a tab
   *  that crashes never sends `bye`, and without this every other client
   *  carries a ghost body until peerTimeoutMs (data/pvp.js) expires. What goes
   *  out is byte-for-byte the `bye` that peer would have sent, so no client
   *  needs a special case for it. */
  dropped(ws) {
    this.budget.delete(ws);
    let att = null;
    try { att = ws.deserializeAttachment(); } catch { att = null; }
    // Clear it first: a socket we closed ourselves reaches here twice (once on
    // the close call, once when the handshake completes) and the room must be
    // told it left exactly once.
    try { ws.serializeAttachment(null); } catch { /* closing; nothing to clear */ }
    if (!att || typeof att.id !== 'string' || typeof att.v !== 'number') return;
    this.fanOut(ws, JSON.stringify({ v: att.v, t: 'bye', id: att.id }));
  }

  /** Every socket in the room except the one it came from — the sender already
   *  knows what it said, and echoing would double the hot path. Each send is
   *  wrapped on its own: a socket that died between getWebSockets() and here
   *  must not stop the other six from hearing. */
  fanOut(from, frame) {
    for (const s of this.state.getWebSockets()) {
      if (s === from) continue;
      try { s.send(frame); } catch { /* dead socket; webSocketClose will tidy */ }
    }
  }
}

/** method + path -> handler, for the routes that are not the POST-only,
 *  name+pinHash-shaped cloud-save ones. These handlers take the raw
 *  (env, request, url) — which is why `GET /pvp` has to live here and cannot
 *  live in ROUTES: a ROUTES handler only ever sees an already-drained body. */
const REC_ROUTES = {
  'GET /records': handleGetRecords,
  'POST /records': handlePostRecord,
  'GET /pvp': handlePvpUpgrade,
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
      // The record board and the PvP relay first: they have their own body
      // shapes (no pinHash) and their own methods, so they are routed before
      // the cloud-save envelope is applied. For /pvp that ordering is load-
      // bearing rather than tidy — readBody() below would consume the request
      // the WebSocket handshake needs.
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
