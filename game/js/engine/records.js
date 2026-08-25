/* CHLOE — engine/records.js  (spec §27E)
   The record board: the top 10 nights anyone has survived on this machine.

   Why this is its OWN module and not a fourth function in engine/displays.js:
   displays.js is pure drawing over live game state — hand it the party and it
   paints. The board is different in kind. It owns a clock, it owns the only
   localStorage key in the game, and it talks (optionally) to a server. Bolting
   that onto the panel painter would drag persistence and networking into a file
   whose whole contract is "no state of its own". So records.js paints its own
   canvas in the same house style instead, and world3d wraps it exactly like the
   others.

   ---------------------------------------------------------------------------
   THE §15 LINE, AND WHY THIS DOES NOT CROSS IT
   §15 is absolute: no run saves, permadeath, one run per page load. What §15
   forbids is persisting PROGRESS — anything that would let a dead run come
   back. A record is the opposite of that: it is a headstone, not a save file.
   It stores five dead facts (a name, how far they got, how long it took, which
   build, when) and there is no code path anywhere in this module that writes
   to party, inventory, the tree, or any other run state. Reading the current
   round for a footer line is the only contact it has with the live game, and
   that read is one-way. If you ever find yourself adding a restore() here,
   you have misread §15 — stop.
   ---------------------------------------------------------------------------

   API (the Room / verify agent calls these)
     start()                     begin (or restart) the run clock
     elapsed()                   ms since the run began — frozen once stop()'d
     stop()                      freeze the clock at the moment the run ended
     list()                      the board, best first (remote if live, else local)
     isRecord(round)             true ONLY if `round` beats the best ever seen
     submit(name, round, timeMs) sanitise + insert + persist -> the record, or null
     prompt(round, timeMs, done) name-entry overlay -> done(record|null)
     board()                     a <canvas> in the house style of the wall panels
     refresh(done)               pull the remote list if config.apiUrl is set
     source()                    'local' | 'world' — what list() is showing
     clear()                     wipe the local board (tests / a reset button)

   Storage: localStorage['chloe.records.v1'], value
     {v:1, rows:[{name, round, timeMs, patch, dateISO}, ...]}
   Sorted round DESC then timeMs ASC, capped at 10. Every read is defensive:
   junk in that key can never throw, it just reads as an empty board. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.records = (function () {
  'use strict';

  /* Versioned key. If the record shape ever changes incompatibly, bump the
     suffix rather than migrating — old boards are not worth a migration path,
     and a stale key under a new name is harmless. */
  var KEY = 'chloe.records.v1';
  var SCHEMA = 1;
  var CAP = 10;             // top ten, per §27E
  var NAME_MAX = 12;        // §27E: 1-12 chars
  var REQUEST_MS = 4000;    // a slow server must never hold up the room

  /* House palette, copied from engine/displays.js rather than imported: that
     module keeps panel() private, and duplicating five colour constants is a
     smaller sin than widening its public surface for a file it does not know
     about. If displays.js ever repaints, match it here by hand. */
  var BG = '#0d0a0c', RED = '#e5173f', TXT = '#f2eef0', DIM = '#9a939c';
  /* Brass. The mirror is cold blue, the knight poster is red, the stage board
     is amber — this needed a fourth accent that reads as an engraved plaque
     from across the room and cannot be mistaken for any of the three. */
  var BRASS = '#d9c9a3';

  /* ---------------- the run clock ----------------
     §15 says one run per page load, but "Begin again" on the defeat panel
     restarts a run WITHOUT a reload, so the clock has to be resettable — a
     module-load timestamp alone would silently time the second run from the
     first one's start. `loadedAt` is still the fallback, because for the
     ordinary case (open the page, play, die) time-since-load IS the run time,
     and that makes a forgotten start() call read correctly instead of zero. */
  var loadedAt = now();
  var startedAt = null;
  var frozenAt = null;

  function now() {
    /* performance.now() is monotonic — a system clock nudge mid-run cannot
       hand us a negative run time. Date.now() only where it is absent. */
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  function start() {
    startedAt = now();
    frozenAt = null;
  }

  /* Freeze the clock the instant the run ends, so the minutes the player
     spends typing their name are not billed to the run. */
  function stop() {
    if (frozenAt === null) { frozenAt = elapsed(); }
    return frozenAt;
  }

  function elapsed() {
    if (frozenAt !== null) { return frozenAt; }
    var t0 = (startedAt === null) ? loadedAt : startedAt;
    var ms = now() - t0;
    return ms > 0 ? Math.round(ms) : 0;
  }

  function started() { return startedAt !== null; }

  /* ---------------- sanitising ---------------- */

  /* Names land on a canvas and (with a backend) in other people's browsers, so
     they are scrubbed at the door: control characters out, angle brackets and
     ampersands out so nothing can ever read as markup downstream, whitespace
     collapsed, then hard-capped. Returns '' for anything that survives as
     nothing — the caller treats '' as "rejected". */
  function sanitiseName(raw) {
    if (typeof raw !== 'string') { return ''; }
    var s = raw
      .replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')  // control chars, zero-widths, RTL overrides
      .replace(/[<>&"'`\\]/g, '')                     // markup / quoting
      .replace(/\s+/g, ' ')                           // collapse whitespace
      .trim();
    if (s.length > NAME_MAX) { s = s.slice(0, NAME_MAX).trim(); }
    return s;
  }

  function patch() {
    try {
      var v = CHLOE.data && CHLOE.data.version;
      return (v && typeof v.string === 'function') ? String(v.string()) : '?';
    } catch (e) { return '?'; }
  }

  /* A record is only a record if every field survives inspection. Used on the
     way in (submit) AND on the way out (a corrupt localStorage blob, an
     unexpected server payload) — one gate, so junk cannot enter from any
     direction. Returns a NEW clean object, or null. */
  function clean(r) {
    if (!r || typeof r !== 'object') { return null; }
    var name = sanitiseName(r.name);
    if (!name) { return null; }
    var round = Math.floor(Number(r.round));
    if (!isFinite(round) || round < 1) { return null; }
    if (round > 100000) { round = 100000; }              // absurd -> clamped, not dropped
    var ms = Math.floor(Number(r.timeMs));
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    if (ms > 86400000 * 30) { ms = 86400000 * 30; }      // 30 days is already a lie
    var p = (typeof r.patch === 'string') ? r.patch.replace(/[^\w.\-+ ]/g, '').slice(0, 16) : '';
    var d = (typeof r.dateISO === 'string' && !isNaN(Date.parse(r.dateISO)))
      ? r.dateISO : new Date().toISOString();
    return { name: name, round: round, timeMs: ms, patch: p || '?', dateISO: d };
  }

  /* Round DESC, then time ASC, then oldest claim first — the third key is not
     cosmetic: without it two identical runs could swap places on every repaint
     and the frame would flicker. */
  function order(rows) {
    return rows.slice().sort(function (a, b) {
      if (b.round !== a.round) { return b.round - a.round; }
      if (a.timeMs !== b.timeMs) { return a.timeMs - b.timeMs; }
      return String(a.dateISO) < String(b.dateISO) ? -1 : 1;
    });
  }

  function normalise(rows) {
    var out = [];
    if (Object.prototype.toString.call(rows) !== '[object Array]') { return out; }
    for (var i = 0; i < rows.length; i++) {
      var c = clean(rows[i]);
      if (c) { out.push(c); }
    }
    return order(out).slice(0, CAP);
  }

  /* ---------------- local storage ----------------
     Every access is wrapped. localStorage throws on its own in private-mode
     Safari and when a quota is full, and the board is decoration — it must
     never be the thing that takes the room down. */

  function store() {
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) { return null; }
  }

  function readLocal() {
    var s = store();
    if (!s) { return []; }
    var raw;
    try { raw = s.getItem(KEY); } catch (e) { return []; }
    if (!raw) { return []; }
    var blob;
    try { blob = JSON.parse(raw); } catch (e) { return []; }   // junk -> empty board
    if (!blob || typeof blob !== 'object') { return []; }
    var isArray = Object.prototype.toString.call(blob) === '[object Array]';
    /* A schema from the future. Show an empty board rather than guessing at
       rows we do not understand. This should never fire in practice — the
       policy above is to BUMP THE KEY on an incompatible change, so a newer
       build writes elsewhere and this key is only ever ours — which is why it
       is safe for a later write to replace whatever is here. It exists for the
       hand-edited case. */
    if (!isArray && Number(blob.v) > SCHEMA) { return []; }
    /* A bare array (an older key, or one written by hand) degrades to "read
       what is there" rather than to nothing. */
    return normalise(isArray ? blob : blob.rows);
  }

  function writeLocal(rows) {
    var s = store();
    if (!s) { return false; }
    try {
      s.setItem(KEY, JSON.stringify({ v: SCHEMA, rows: normalise(rows) }));
      return true;
    } catch (e) { return false; }   // quota / private mode: the run still ends fine
  }

  function clear() {
    var s = store();
    if (s) { try { s.removeItem(KEY); } catch (e) { /* nothing to do */ } }
    remote = null;
    return true;
  }

  /* ---------------- remote (optional, §27E) ----------------
     `remote` is null until a GET /records actually succeeds. While it is null
     the board is honestly local, and every remote path is fire-and-forget:
     nothing here is ever awaited by the UI. */
  var remote = null;

  function api() {
    try {
      var u = CHLOE.data && CHLOE.data.config && CHLOE.data.config.apiUrl;
      if (typeof u !== 'string' || !u) { return ''; }
      return u.replace(/\/+$/, '');
    } catch (e) { return ''; }
  }

  /* XMLHttpRequest rather than fetch, deliberately: nothing else in this
     codebase uses a Promise, the ES5 rule in §1 means no async/await, and XHR
     gives a real timeout in one property. Callback-only, never throws. */
  function send(method, url, body, done) {
    var fired = false;
    function finish(ok, data) {
      if (fired) { return; }
      fired = true;
      if (typeof done === 'function') { try { done(ok, data); } catch (e) { /* caller's problem, not ours */ } }
    }
    var xhr;
    try { xhr = new XMLHttpRequest(); } catch (e) { finish(false, null); return; }
    try {
      xhr.open(method, url, true);
      xhr.timeout = REQUEST_MS;
      if (body !== null && body !== undefined) {
        xhr.setRequestHeader('Content-Type', 'application/json');
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        if (xhr.status < 200 || xhr.status >= 300) { finish(false, null); return; }
        var parsed = null;
        try { parsed = JSON.parse(xhr.responseText); } catch (e) { finish(false, null); return; }
        finish(true, parsed);
      };
      xhr.ontimeout = function () { finish(false, null); };
      xhr.onerror = function () { finish(false, null); };
      xhr.send(body === null || body === undefined ? null : JSON.stringify(body));
    } catch (e) { finish(false, null); }
  }

  /* Pull the world board. Silent on every failure — an offline player gets
     their own records and no error, which is the whole contract. */
  function refresh(done) {
    var base = api();
    if (!base) { if (typeof done === 'function') { done(false, list()); } return; }
    send('GET', base + '/records', null, function (ok, data) {
      if (ok && data && data.ok && data.records) {
        var rows = normalise(data.records);
        remote = rows;
      }
      if (typeof done === 'function') { try { done(!!remote, list()); } catch (e) { /* ignore */ } }
    });
  }

  function source() { return remote ? 'world' : 'local'; }

  /* ---------------- the board itself ---------------- */

  function list() {
    return remote ? remote.slice() : readLocal();
  }

  function best() {
    var rows = list();
    return rows.length ? rows[0].round : 0;
  }

  /* §27E: the prompt fires only for a run that beat the highest round EVER
     recorded — strictly greater, so equalling the record does not re-ask for a
     name. A round under 1, a NaN, or an empty board are all handled here so no
     caller has to special-case the first night. */
  function isRecord(round) {
    var r = Math.floor(Number(round));
    if (!isFinite(r) || r < 1) { return false; }
    return r > best();
  }

  /* The only writer on the board. Returns the stored record, or null if the
     name did not survive sanitising (the caller re-prompts). */
  function submit(name, round, timeMs) {
    var rec = clean({
      name: name,
      round: round,
      timeMs: (timeMs === undefined || timeMs === null) ? elapsed() : timeMs,
      patch: patch(),
      dateISO: new Date().toISOString()
    });
    if (!rec) { return null; }

    var rows = normalise(readLocal().concat([rec]));
    writeLocal(rows);

    /* Push to the world board if one exists. Fire-and-forget: the local insert
       above already happened, so a server that is down, slow or rejecting
       costs the player nothing. */
    var base = api();
    if (base) {
      send('POST', base + '/records', {
        name: rec.name, round: rec.round, timeMs: rec.timeMs, patch: rec.patch
      }, function (ok, data) {
        if (ok && data && data.ok && data.records) { remote = normalise(data.records); }
      });
    }
    return rec;
  }

  /* ---------------- formatting ---------------- */

  function fmtTime(ms) {
    var t = Math.max(0, Math.floor(Number(ms) || 0));
    var s = Math.floor(t / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(sec)) : (m + ':' + p2(sec));
  }

  /* Date only — the board is a wall, not a log. */
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }
    return d.getFullYear() + '-' +
           ((d.getMonth() + 1) < 10 ? '0' : '') + (d.getMonth() + 1) + '-' +
           (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  /* ---------------- canvas painter ----------------
     512x700, the same portrait size as the knight poster and the stage board,
     because it hangs on the same wall in the same size of frame. */

  function make(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* The house panel: black ground, vignette so it reads as a lit surface
     rather than a flat sticker, a heavy accent border, centred Impact title.
     Deliberately identical in construction to displays.panel() — see the
     colour note above for why it is copied rather than shared. */
  function panel(g, w, h, title, accent) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    var v = g.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
    v.addColorStop(0, 'rgba(255,255,255,0.05)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
    g.strokeStyle = accent || RED; g.lineWidth = 6;
    g.strokeRect(10, 10, w - 20, h - 20);
    g.fillStyle = accent || RED;
    g.font = 'bold ' + Math.round(h * 0.075) + 'px Impact, "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.fillText(title, w / 2, h * 0.115);
    g.textAlign = 'left';
  }

  function board() {
    var W = 512, H = 700, c = make(W, H), g = c.getContext('2d');
    var rows = list();
    panel(g, W, H, 'THE RECORD', BRASS);

    /* Column header, so the five fields are named once instead of guessed at
       ten times. */
    var L = 34, R = W - 34;
    var y = 108;
    g.font = '13px "Consolas", monospace';
    g.fillStyle = DIM;
    g.fillText('NAME', L, y);
    g.textAlign = 'right';
    g.fillText('ROUND', L + 250, y);
    g.fillText('TIME', R, y);
    g.textAlign = 'left';
    g.strokeStyle = 'rgba(217,201,163,0.45)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y + 9); g.lineTo(R, y + 9); g.stroke();

    if (!rows.length) {
      /* The empty state is written to be read once and never again. */
      g.textAlign = 'center';
      g.fillStyle = DIM; g.font = '19px system-ui, sans-serif';
      g.fillText('Nobody has lasted a night', W / 2, H * 0.44);
      g.fillText('worth writing down.', W / 2, H * 0.44 + 28);
      g.fillStyle = BRASS; g.font = 'italic 16px system-ui, sans-serif';
      g.fillText('Be the first.', W / 2, H * 0.44 + 68);
      g.textAlign = 'left';
      footer(g, W, H, rows);
      return c;
    }

    y = 148;
    var step = 52;
    for (var i = 0; i < rows.length && i < CAP; i++) {
      var r = rows[i];
      var top = i === 0;

      /* The leader gets a lit band behind it. One row of emphasis, not ten. */
      if (top) {
        g.fillStyle = 'rgba(217,201,163,0.10)';
        g.fillRect(L - 8, y - 24, R - L + 16, step - 6);
      }

      g.fillStyle = top ? BRASS : DIM;
      g.font = 'bold 15px "Consolas", monospace';
      g.fillText((i + 1) + '.', L, y);

      g.fillStyle = top ? '#ffffff' : TXT;
      g.font = 'bold 24px Impact, "Arial Narrow", sans-serif';
      g.fillText(r.name.toUpperCase(), L + 34, y);

      g.textAlign = 'right';
      g.fillStyle = RED;
      g.font = 'bold 26px Impact, "Arial Narrow", sans-serif';
      g.fillText(String(r.round), L + 250, y);

      g.fillStyle = top ? BRASS : TXT;
      g.font = '19px "Consolas", monospace';
      g.fillText(fmtTime(r.timeMs), R, y);
      g.textAlign = 'left';

      /* Second line: when, and on which build. The patch matters — a round 9
         set before a rebalance is not the same round 9 as one set after it,
         and the board should say so rather than pretend the runs compare. */
      g.fillStyle = DIM; g.font = '13px "Consolas", monospace';
      g.fillText(fmtDate(r.dateISO) + '  ·  ' + r.patch, L + 34, y + 19);

      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, y + 30); g.lineTo(R, y + 30); g.stroke();

      y += step;
    }

    footer(g, W, H, rows);
    return c;
  }

  /* The honest limit, on the board itself (§27E). Until someone deploys the
     worker, these ten names came from ONE browser — saying so on the wall is
     cheaper than a player discovering it and assuming the game lost their
     record. */
  function footer(g, W, H, rows) {
    var world = !!remote;
    g.textAlign = 'center';
    g.fillStyle = world ? BRASS : DIM;
    g.font = 'bold 14px "Consolas", monospace';
    g.fillText(world ? 'WORLD RECORDS' : 'THIS BROWSER ONLY', W / 2, H - 46);
    if (!world) {
      g.fillStyle = DIM; g.font = 'italic 13px system-ui, sans-serif';
      g.fillText('no world board until one is hosted', W / 2, H - 27);
    } else {
      g.fillStyle = DIM; g.font = 'italic 13px system-ui, sans-serif';
      g.fillText(rows.length + ' of ' + CAP + ' places claimed', W / 2, H - 27);
    }
    g.textAlign = 'left';
  }

  /* ---------------- name entry ----------------
     Built and styled in JS on purpose: game.css belongs to another file owner,
     and an overlay that carries its own look cannot be broken by a stylesheet
     that does not know it exists. It is also the only DOM this module owns —
     one node in, one node out.

     prompt(round, timeMs, done) -> done(record | null)
       done(record) after a successful submit, done(null) if the player skips.
     Also callable as prompt({round, timeMs}, done). */
  var openEl = null;

  function prompt(round, timeMs, done) {
    if (round && typeof round === 'object') {
      done = timeMs;
      timeMs = round.timeMs;
      round = round.round;
    }
    if (typeof timeMs === 'function') { done = timeMs; timeMs = undefined; }
    if (timeMs === undefined || timeMs === null) { timeMs = stop(); }

    function finish(rec) {
      close();
      if (typeof done === 'function') { try { done(rec || null); } catch (e) { /* caller's */ } }
    }
    if (typeof document === 'undefined' || !document.body) { finish(null); return null; }
    if (openEl) { close(); }                 // never stack two prompts

    /* Typing under pointer lock works, but the player cannot see a cursor and
       Escape would eat the lock instead of the dialog. Release it first; the
       room re-locks on the next click, as it does after any overlay. */
    try { if (document.pointerLockElement && document.exitPointerLock) { document.exitPointerLock(); } }
    catch (e) { /* not locked, or not supported */ }

    var wrap = document.createElement('div');
    wrap.id = 'records-prompt';
    wrap.setAttribute('style', 'position:fixed;inset:0;z-index:9999;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(5,4,6,0.82);' +
      'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;');

    var box = document.createElement('div');
    box.setAttribute('style', 'width:min(420px,86vw);padding:26px 28px;background:' + BG + ';' +
      'border:3px solid ' + BRASS + ';box-shadow:0 0 40px rgba(0,0,0,0.8);text-align:center;');

    var h = document.createElement('div');
    h.textContent = 'A NEW RECORD';
    h.setAttribute('style', 'font-family:Impact,"Arial Narrow",sans-serif;font-size:34px;' +
      'letter-spacing:2px;color:' + BRASS + ';margin-bottom:6px;');

    var sub = document.createElement('div');
    sub.textContent = 'Round ' + Math.max(1, Math.floor(Number(round) || 1)) +
      '  ·  ' + fmtTime(timeMs) + '  ·  ' + patch();
    sub.setAttribute('style', 'color:' + DIM + ';font-size:14px;margin-bottom:18px;');

    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.placeholder = 'your name';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('style', 'width:100%;box-sizing:border-box;padding:10px 12px;' +
      'background:#141317;border:1px solid ' + RED + ';color:' + TXT + ';font-size:20px;' +
      'text-align:center;letter-spacing:2px;outline:none;');

    var err = document.createElement('div');
    err.setAttribute('style', 'min-height:18px;color:' + RED + ';font-size:13px;margin-top:8px;');

    var rowEl = document.createElement('div');
    rowEl.setAttribute('style', 'display:flex;gap:10px;margin-top:14px;');

    function button(label, primary) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('style', 'flex:1;padding:10px 0;cursor:pointer;font-size:15px;' +
        'letter-spacing:1px;border:1px solid ' + (primary ? RED : '#3a3540') + ';' +
        'background:' + (primary ? RED : 'transparent') + ';color:' +
        (primary ? '#fff' : DIM) + ';font-family:inherit;');
      return b;
    }
    var skip = button('Skip', false);
    var ok = button('Carve it', true);

    function attempt() {
      var name = sanitiseName(input.value);
      if (!name) {
        /* Empty (or all-markup) is rejected rather than defaulted: a board of
           anonymous entries is worse than a board with one fewer. */
        err.textContent = 'Type a name — 1 to 12 characters.';
        input.focus();
        return;
      }
      finish(submit(name, round, timeMs));
    }

    ok.addEventListener('click', attempt);
    skip.addEventListener('click', function () { finish(null); });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();                 // the room is still listening for WASD
      if (ev.key === 'Enter') { ev.preventDefault(); attempt(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(null); }
    });
    /* Swallow the rest so a name containing 'w' does not walk the player into
       a wall behind the dialog. */
    wrap.addEventListener('keyup', function (ev) { ev.stopPropagation(); });
    wrap.addEventListener('keypress', function (ev) { ev.stopPropagation(); });

    rowEl.appendChild(skip); rowEl.appendChild(ok);
    box.appendChild(h); box.appendChild(sub); box.appendChild(input);
    box.appendChild(err); box.appendChild(rowEl);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    openEl = wrap;
    try { input.focus(); } catch (e) { /* headless */ }

    /* Handed back so a test can drive the flow without synthetic mouse events. */
    return { el: wrap, input: input, accept: attempt, cancel: function () { finish(null); } };
  }

  function close() {
    if (!openEl) { return; }
    try { if (openEl.parentNode) { openEl.parentNode.removeChild(openEl); } } catch (e) { /* gone */ }
    openEl = null;
  }

  function isOpen() { return !!openEl; }

  /* ---------------- debug ---------------- */
  function debug() {
    var rows = list();
    return {
      key: KEY, schema: SCHEMA, cap: CAP,
      source: source(), count: rows.length, best: best(),
      elapsedMs: elapsed(), running: started() && frozenAt === null,
      apiUrl: api() || null, promptOpen: isOpen()
    };
  }

  return {
    start: start, stop: stop, elapsed: elapsed, started: started,
    list: list, best: best, isRecord: isRecord, submit: submit,
    sanitiseName: sanitiseName, clear: clear,
    board: board, prompt: prompt, close: close, isOpen: isOpen,
    refresh: refresh, source: source,
    fmtTime: fmtTime, fmtDate: fmtDate,
    storageKey: KEY, cap: CAP, nameMax: NAME_MAX,
    debug: debug
  };
})();
