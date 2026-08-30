/* CHLOE — engine/net.js  (spec §32)
   The transport for the deathmatch: two ways to move JSON between players, one
   interface, and a game that plays perfectly when neither of them exists.

   ---------------------------------------------------------------------------
   THE LAW THIS FILE INHERITS
   engine/records.js is the only other module in this game that talks to a
   server, and its header states the terms: a config-gated URL, a hard timeout,
   callbacks only, silence on every failure path, and a game that does not care
   when the server is absent. Netcode obeys the same law. Nothing here returns
   a Promise, nothing here is awaited by the UI, nothing here blocks a frame,
   and no entry point below throws — a caller that gets it wrong gets `false`,
   `null` or an empty list, never an exception.

   records.js answers "no Promises, no async/await (§1)" with XMLHttpRequest.
   Our answer is WebSocket and BroadcastChannel, which are pure event emitters
   and need no Promise to drive. Both are feature-detected: a browser with
   neither reports a transport of `null` and the lobby says so out loud.
   ---------------------------------------------------------------------------

   WHAT THIS MODULE KNOWS ABOUT THE GAME: nothing. It moves objects. It keeps
   no roster, no seats, no rules, and — deliberately — no list of valid message
   types (see dispatch()). §32's ownership model lives in engine/pvp.js. If a
   change here needs to know what a message MEANS, it belongs in that file.

   API
     available()             -> {local, relay}  can each one actually be used
     transport()             -> 'local'|'relay'|null   what open() WOULD use,
                                answerable before open() is called, because the
                                lobby has to state which one it is on
     open(room, opts, cb)    -> void   opts {name}; cb(err, info), always async
     send(msg)               -> bool   false before open(); never throws
     on(type, fn)            -> void   one list per type; '*' hears everything
     off(type, fn)           -> void
     close()                 -> void   hang up; listeners survive, counters stay
     id()                    -> string this peer's id, stable for the page load
     peers()                 -> [id]   ids heard from inside peerTimeoutMs
     stats()                 -> the console surface (also exported as debug())

   TWO TRANSPORTS, chosen automatically (§3)
     local   BroadcastChannel('chloe.pvp.<room>'). Needs no server at all, so
             the mode is playable and testable the moment the files land. A
             BroadcastChannel does NOT echo to its sender — the tab that posts
             a message never receives it. That is load-bearing for the match
             layer, so it is normalised rather than papered over: see the
             self-echo note in handleText().
     relay   A WebSocket to CHLOE.data.config.netUrl. `netUrl` is ABSENT from
             config.js by default, exactly as `apiUrl` is, so the relay is
             unavailable until somebody adds one line — and removing it is one
             line back to local.

   WIRE (§4). Every message is JSON, one object, carrying `v` and `t`. This
   module stamps `v` and (unless the caller set one) `id` on the way out, and
   refuses a `v` mismatch on the way in with a readable error rather than
   letting a subtly different build play half a match. It mints exactly two
   messages of its own: `pong`, which is a transport-level answer to a
   transport-level question, and a local-only `{t:'error'}` that is never sent
   anywhere — see refuseVersion(). Everything else on the wire comes from
   engine/pvp.js. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.net = (function () {
  'use strict';

  /* ---------------- transport mechanics ----------------
     Every number the GAME tunes — how often to ping, how long to wait on the
     relay, how long silence is allowed, which protocol version we speak, what
     the channel is called — lives in data/pvp.js (rule 7) and is read through
     the accessors below. What is left here describes the pipe itself, the
     kind of number records.js keeps as REQUEST_MS, plus the fallbacks that
     keep a build with no data/pvp.js from throwing. */

  var ID_BYTES = 8;         // 16 hex chars — collision-proof enough for 8 seats

  /* A socket whose far end has stopped draining buffers forever if we keep
     writing. At data.pvp.sendHz this is thousands of queued ticks — nothing
     that stale is worth sending, so we drop and count instead. */
  var MAX_BUFFERED = 262144;

  /* Deliberately LONGER than data.pvp.roomCodeLen, and deliberately not read
     from it: the code alphabet and length are the lobby's policy, and a
     transport that enforced them would corrupt a longer code some later
     version passes down instead of carrying it. All net needs is a string
     that is safe as a channel name and as a query value. */
  var ROOM_MAX = 12;

  /* Used ONLY when data/pvp.js is missing entirely — a build with the
     multiplayer data file deleted must still not throw (rule 6). Each one
     mirrors that file's authored value rather than inventing a second
     opinion; when the file is present, the file wins. */
  var FALLBACK_VERSION = 1;
  var FALLBACK_PEER_TIMEOUT_MS = 5000;
  var FALLBACK_CONNECT_MS = 4000;
  var FALLBACK_CHANNEL_PREFIX = 'chloe.pvp.';

  /* ---------------- reading the data layer ----------------
     Every read is wrapped exactly the way records.js wraps config.apiUrl: a
     missing module, a missing key or a hand-broken value degrades to the
     fallback, and no boundary here is allowed to throw. */

  function data() {
    try { return (CHLOE.data && CHLOE.data.pvp) || null; } catch (e) { return null; }
  }

  function protocolVersion() {
    var d = data();
    var v = d ? Math.floor(Number(d.protocolVersion)) : NaN;
    return isFinite(v) && v > 0 ? v : FALLBACK_VERSION;
  }

  /* One reader for every millisecond count in data/pvp.js: a key that is
     missing, NaN or zero reads as the fallback rather than as a timer that
     fires forever or never. */
  function ms(key, fallback) {
    var d = data();
    var n = d ? Math.floor(Number(d[key])) : NaN;
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function peerTimeoutMs() { return ms('peerTimeoutMs', FALLBACK_PEER_TIMEOUT_MS); }
  function connectMs() { return ms('connectTimeoutMs', FALLBACK_CONNECT_MS); }

  function channelPrefix() {
    var d = data();
    var p = d ? d.channelPrefix : null;
    return (typeof p === 'string' && p) ? p : FALLBACK_CHANNEL_PREFIX;
  }

  function netBase() {
    try {
      var u = CHLOE.data && CHLOE.data.config && CHLOE.data.config.netUrl;
      if (typeof u !== 'string' || !u) { return ''; }
      return u.replace(/\/+$/, '');
    } catch (e) { return ''; }
  }

  /* performance.now() for the same reason records.js uses it: monotonic, so a
     system clock nudge mid-match cannot hand us a negative round-trip time. */
  function now() {
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* cb is ALWAYS delivered on a later turn, on both transports. Local is
     ready the instant BroadcastChannel is constructed, and a callback that
     fires synchronously on one transport and asynchronously on the other is
     an invitation to write a lobby that only works on one of them. */
  function defer(fn) {
    try { setTimeout(fn, 0); } catch (e) { /* no timers: the caller waits forever, which beats throwing */ }
  }

  /* ---------------- identity ----------------
     One id per page load, minted lazily and never re-minted: seats, kills and
     the whole of §4's attribution hang off it, so an id that changed mid-match
     would silently split one player into two. */
  var myId = null;

  function id() {
    if (myId) { return myId; }
    myId = mintId();
    return myId;
  }

  function mintId() {
    try {
      var c = (typeof crypto !== 'undefined') ? crypto : null;
      if (c && c.getRandomValues && typeof Uint8Array === 'function') {
        var a = new Uint8Array(ID_BYTES);
        c.getRandomValues(a);
        var s = '';
        for (var i = 0; i < a.length; i++) { s += (a[i] + 256).toString(16).slice(1); }
        return s;
      }
    } catch (e) { /* fall through to the arithmetic one */ }
    /* No crypto: two tabs still get independent Math.random streams, and the
       time suffix makes a same-millisecond collision the only way to clash. */
    return (Math.random().toString(36).slice(2, 10) +
            Math.random().toString(36).slice(2, 6) +
            (Date.now() % 100000).toString(36));
  }

  /* ---------------- url + room ---------------- */

  /* The room code is cleaned identically on both transports so the same typed
     string always names the same room: it becomes the BroadcastChannel name on
     one and the `room` query parameter on the other. Upper-case alphanumerics
     only, because a room code is read aloud. */
  function cleanRoom(raw) {
    if (typeof raw !== 'string') { return ''; }
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_MAX);
  }

  /* worker/README.md documents the configured base as
     'https://chloe-api.<subdomain>.workers.dev' with no trailing slash, and
     netUrl is the same shape — so the scheme is swapped rather than demanded:
     http -> ws, https -> wss, an already-ws base left alone, a bare host
     assumed secure. The path is exactly '/pvp' because worker.js routes on the
     full path (REC_ROUTES is keyed 'METHOD /path'), which is also why the room
     travels as a query parameter and not as a path segment.

     The display name is deliberately NOT in this URL. §4's `hello` already
     carries it, and one fact with two sources on the wire is a fact that can
     disagree with itself. */
  function socketUrl(code) {
    var base = netBase();
    if (!base) { return ''; }
    var u = base;
    if (!/^[a-z][a-z0-9+.\-]*:/i.test(u)) { u = 'wss://' + u; }
    u = u.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    if (!/^wss?:/i.test(u)) { return ''; }        // some scheme we do not speak
    if (!/\/pvp$/i.test(u)) { u += '/pvp'; }      // a base already pointed at
    return u + '?room=' + encodeURIComponent(code);  // /pvp is not doubled
  }

  /* ---------------- selection ----------------
     "Available" means usable, not merely supported: a browser with WebSocket
     and no netUrl has nowhere to connect to, and telling the lobby "relay:
     true" there would put a dead option on screen. The pure feature answers
     are in stats() as wsSupported / bcSupported. */
  function available() {
    var local = false, relay = false;
    try { local = (typeof BroadcastChannel === 'function'); } catch (e) { local = false; }
    try { relay = (typeof WebSocket === 'function') && !!socketUrl('X'); } catch (e) { relay = false; }
    return { local: local, relay: relay };
  }

  function transport() {
    var a = available();
    if (a.relay) { return 'relay'; }
    if (a.local) { return 'local'; }
    return null;
  }

  /* ---------------- listeners ----------------
     One list per type, plus '*'. Registration survives close(), because a
     listener belongs to the module that registered it and not to a socket —
     and on() de-duplicates by function reference so a pvp module that
     registers on every open() cannot stack ten copies of its own handler. */
  var listeners = {};

  function on(type, fn) {
    try {
      if (typeof type !== 'string' || !type || typeof fn !== 'function') { return; }
      var arr = has(listeners, type) ? listeners[type] : (listeners[type] = []);
      for (var i = 0; i < arr.length; i++) { if (arr[i] === fn) { return; } }
      arr.push(fn);
    } catch (e) { /* a listener that could not be registered simply never fires */ }
  }

  function off(type, fn) {
    try {
      if (!has(listeners, type)) { return; }
      var arr = listeners[type];
      for (var i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === fn) { arr.splice(i, 1); }
      }
    } catch (e) { /* nothing to remove */ }
  }

  /* Iterate a COPY: a handler is allowed to call off() (or on()) on itself
     while it runs, and mutating the live array mid-loop would skip its
     neighbour. Each call is wrapped — one bad handler must never be able to
     kill the message pump for every other listener. */
  function fire(type, msg) {
    var arr = has(listeners, type) ? listeners[type] : null;
    if (!arr || !arr.length) { return; }
    var copy = arr.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](msg); } catch (e) { /* swallowed on purpose — see above */ }
    }
  }

  /* No type whitelist anywhere in this file. §4 says an unknown `t` is ignored
     and never thrown on, and "ignored" is what a type with no listeners
     already is — so the rule costs nothing to keep, and adding a message type
     to §4 never means editing this module. */
  function dispatch(msg) {
    fire(msg.t, msg);
    fire('*', msg);
  }

  /* ---------------- connection state ----------------
     `st` is the live connection (null when closed). `last` keeps the counters
     of the connection that just ended so stats() still answers honestly after
     close() — a verification pass usually wants to read them once the match
     is over. `lastError` is module-level for the same reason: an open() that
     never produced a connection has no st to hang its error on. */
  var st = null;
  var last = null;
  var lastError = null;

  function fresh(mode, code, name, url) {
    return {
      transport: mode, room: code, name: name, url: url || null,
      ch: null, ws: null,
      open: false, openedAt: null,
      sent: 0, recv: 0, dropped: 0, echo: 0, badVersion: 0, overflow: 0,
      rttMs: null, pingTs: null,
      seen: {},                 // peer id -> last time we heard from it
      timer: null, pinger: null,
      cb: null, cbDone: false,
      versionWarned: false
    };
  }

  /* ---------------- open ---------------- */

  function open(roomCode, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null; }
    var name = '';
    try { name = (opts && typeof opts.name === 'string') ? opts.name : ''; } catch (e) { name = ''; }

    try {
      close();                                   // never stack two connections
      var code = cleanRoom(roomCode);
      if (!code) {
        failNow(cb, 'room', 'A room code is 1–12 letters or numbers.');
        return;
      }
      var mode = transport();
      if (!mode) {
        failNow(cb, 'unsupported',
          'This browser cannot open a room: it has no BroadcastChannel, and no relay is configured.');
        return;
      }
      var url = (mode === 'relay') ? socketUrl(code) : '';
      st = fresh(mode, code, name, url);
      st.cb = cb;
      if (mode === 'relay') { openRelay(); } else { openLocal(); }
    } catch (e) {
      /* Construction itself failed (a blocked BroadcastChannel, a URL the
         browser rejects). The mode is simply unavailable; nothing is thrown. */
      st = null;
      failNow(cb, 'open', 'Could not open the room on this browser.');
    }
  }

  function openLocal() {
    var s = st;
    /* The prefix is data/pvp.js's, and its comment explains why it carries no
       version: two mismatched builds must MEET on one channel so the version
       check in handleText() can say the true thing, rather than sit in two
       empty rooms wondering where everyone is. */
    s.ch = new BroadcastChannel(channelPrefix() + s.room);
    s.ch.onmessage = function (ev) {
      try { handleText(ev && ev.data); } catch (e) { /* never let the pump die */ }
    };
    /* A message that failed to deserialise between tabs. Counted, not thrown:
       the next tick replaces whatever it was. */
    s.ch.onmessageerror = function () { if (st === s) { s.dropped++; } };
    s.open = true;
    s.openedAt = now();
    startPings(s);
    settle(s, null, info(s));
  }

  function openRelay() {
    var s = st;
    s.ws = new WebSocket(s.url);
    s.ws.onopen = function () {
      if (st !== s) { return; }
      clearTimer(s);
      s.open = true;
      s.openedAt = now();
      startPings(s);
      settle(s, null, info(s));
    };
    s.ws.onmessage = function (ev) {
      try { handleText(ev && ev.data); } catch (e) { /* never let the pump die */ }
    };
    /* onerror and onclose are the same event as far as we are concerned: a
       socket that is not open. Before the handshake lands that is a failed
       connect and the answer is cb(err) — a dead relay leaves the game fully
       playable, it does not throw and it does not retry. After the handshake
       it is a drop, and the match layer hears about it as a local error. */
    s.ws.onerror = function () { if (st === s) { relayDown(s, 'The connection to the relay failed.'); } };
    s.ws.onclose = function () { if (st === s) { relayDown(s, 'The relay closed the connection.'); } };

    s.timer = setTimeout(function () {
      if (st !== s || s.open) { return; }
      try { if (s.ws) { s.ws.close(); } } catch (e) { /* already gone */ }
      settle(s, err('timeout', 'The relay did not answer in time.'), null);
    }, connectMs());
  }

  function relayDown(s, message) {
    clearTimer(s);
    stopPings(s);
    if (!s.open) {
      settle(s, err('connect', message), null);   // never connected at all
      return;
    }
    s.open = false;
    lastError = message;
    /* A local-only notice, minted here and sent nowhere: the far end already
       knows it went away. The lobby and the match layer both listen on
       'error', which is why it wears that type. */
    dispatch({ v: protocolVersion(), t: 'error', code: 'closed', message: message });
  }

  /* ---------------- callbacks + errors ---------------- */

  function err(code, message) {
    var e;
    /* An Error (rather than a bare object) because a lobby that renders it
       with String(err) gets a sentence instead of "[object Object]". */
    try { e = new Error(message); e.code = code; }
    catch (x) { e = { code: code, message: message }; }
    return e;
  }

  function failNow(cb, code, message) {
    lastError = message;
    var e = err(code, message);
    defer(function () {
      if (typeof cb !== 'function') { return; }
      try { cb(e, null); } catch (x) { /* the caller's handler is the caller's problem */ }
    });
  }

  /* cb fires exactly once per open(): a relay can hit the connect timeout and
     onerror in the same breath, and a lobby told twice that it failed would
     show two dialogs. */
  function settle(s, e, inf) {
    if (s.cbDone) { return; }
    s.cbDone = true;
    if (e) { lastError = e.message || String(e); }
    var cb = s.cb;
    s.cb = null;
    if (typeof cb !== 'function') { return; }
    defer(function () {
      try { cb(e || null, inf || null); } catch (x) { /* caller's problem */ }
    });
  }

  function info(s) {
    return { transport: s.transport, room: s.room, id: id(), url: s.url };
  }

  /* ---------------- liveness ----------------
     data.pvp.pingMs owns the schedule, and its comment states the measured
     reason it is a TIMER and not a frame-loop job: rAF stops in a hidden tab,
     and the local transport's whole premise is two tabs of which only one can
     be in front. A hidden tab that stopped pinging would be timed out of its
     own match. With the data file absent the fallback is derived from
     peerTimeoutMs instead — answering twice inside the silence window is the
     cheapest schedule that still keeps a quiet peer in peers(). */
  function pingEvery() {
    return ms('pingMs', Math.max(1000, Math.round(peerTimeoutMs() / 2)));
  }

  function startPings(s) {
    stopPings(s);
    try {
      s.pinger = setInterval(function () {
        if (st !== s || !s.open) { return; }
        /* One outstanding ping at a time. rtt is a single headline number, so
           the first peer to answer sets it; there is no map to leak. `ts` is
           rounded because it comes back through JSON and is compared for
           equality below. */
        s.pingTs = Math.round(now());
        sendRaw({ t: 'ping', ts: s.pingTs });
      }, pingEvery());
    } catch (e) { s.pinger = null; }   // no timers: rttMs simply stays null
  }

  function stopPings(s) {
    try { if (s.pinger) { clearInterval(s.pinger); } } catch (e) { /* gone */ }
    s.pinger = null;
  }

  function clearTimer(s) {
    try { if (s.timer) { clearTimeout(s.timer); } } catch (e) { /* gone */ }
    s.timer = null;
  }

  function noteRtt(s, msg) {
    /* `re` names the peer whose ping this answers. When it is present and it
       is not us, the pong belongs to somebody else's measurement and must not
       set our number — two peers can mint the same rounded millisecond. */
    if (typeof msg.re === 'string' && msg.re && msg.re !== id()) { return; }
    if (s.pingTs === null || Number(msg.ts) !== s.pingTs) { return; }
    var dt = Math.round(now() - s.pingTs);
    s.rttMs = dt >= 0 ? dt : 0;
    s.pingTs = null;
  }

  /* ---------------- sending ---------------- */

  function send(msg) {
    try {
      if (!st || !st.open) { return false; }        // send() before open(): false, not a throw
      if (!msg || typeof msg !== 'object') { return false; }
      if (typeof msg.t !== 'string' || !msg.t) { return false; }  // untyped: undispatchable at the far end
      return sendRaw(msg);
    } catch (e) { return false; }
  }

  function sendRaw(msg) {
    var s = st;
    if (!s || !s.open) { return false; }

    /* A shallow COPY, so stamping `v` and `id` cannot mutate a live object the
       caller is reusing tick after tick (pvp.tickSend() has every reason to
       keep one `state` object around rather than allocating at 15 Hz). */
    var out = {}, k;
    for (k in msg) { if (has(msg, k)) { out[k] = msg[k]; } }
    out.v = protocolVersion();
    /* The sender is always us, so a message that forgot its id is stamped
       rather than arriving unattributable. A caller that set one keeps it. */
    if (out.id === undefined || out.id === null) { out.id = id(); }

    var text;
    try { text = JSON.stringify(out); }
    catch (e) { s.dropped++; return false; }     // cyclic / unserialisable: dropped, never thrown

    try {
      if (s.transport === 'local') {
        if (!s.ch) { return false; }
        /* JSON over BroadcastChannel too, even though structured clone would
           carry the object as-is. The point is that `local` rehearses `relay`
           exactly: anything that will not survive the wire (a THREE.Vector3, a
           closure, a cycle) fails in the same place on both transports instead
           of working in two tabs and breaking on the internet. */
        s.ch.postMessage(text);
      } else {
        if (!s.ws || s.ws.readyState !== 1) { return false; }   // 1 === OPEN
        if (s.ws.bufferedAmount > MAX_BUFFERED) { s.overflow++; return false; }
        s.ws.send(text);
      }
    } catch (e) { s.dropped++; return false; }

    s.sent++;
    return true;
  }

  /* ---------------- receiving ---------------- */

  function handleText(raw) {
    var s = st;
    if (!s) { return; }

    var msg = null;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch (e) { msg = null; }
    } else if (raw && typeof raw === 'object') {
      msg = raw;             // a peer that posted an object rather than JSON
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !msg.t) {
      s.dropped++;
      return;
    }

    if (Number(msg.v) !== protocolVersion()) { refuseVersion(s, msg); return; }

    /* A BroadcastChannel never echoes to its sender, and the match layer is
       written against that. A relay is fan-out and may or may not exclude the
       sender depending on who wrote it, so the two transports are normalised
       HERE: you never receive your own message on either. Without this, a
       relay that echoes would make every peer see itself as a second player. */
    if (typeof msg.id === 'string' && msg.id === id()) { s.echo++; return; }

    s.recv++;

    if (typeof msg.id === 'string' && msg.id) {
      /* peers() is transport-level "who have I heard from", so it is bookkept
         from traffic rather than from any roster. A `bye` is the one message
         whose meaning we act on, and only to forget an id — a leaver should
         not have to time out. */
      if (msg.t === 'bye') { delete s.seen[msg.id]; }
      else { s.seen[msg.id] = now(); }
    }

    if (msg.t === 'ping') {
      /* Answered here rather than in pvp.js: ping/pong is the pipe measuring
         itself, and the answer must not depend on a match being in progress.
         The `ts` is echoed verbatim — only the peer that minted it knows what
         clock it came from. */
      sendRaw({ t: 'pong', ts: msg.ts, re: msg.id });
    } else if (msg.t === 'pong') {
      noteRtt(s, msg);
    }

    dispatch(msg);
  }

  /* §4: a `v` mismatch is refused with a readable error rather than allowed to
     produce a subtly broken match. It fires ONCE per connection — a mismatched
     peer sends `state` fifteen times a second, and fifteen dialogs a second is
     not a better diagnosis than one. The count keeps rising in stats(). */
  function refuseVersion(s, msg) {
    s.badVersion++;
    if (s.versionWarned) { return; }
    s.versionWarned = true;
    var mine = protocolVersion();
    var theirs = (msg && msg.v !== undefined && msg.v !== null) ? String(msg.v) : 'nothing';
    var message = 'Another player is on a different version of the game ' +
      '(this build speaks protocol v' + mine + ', theirs speaks ' + theirs +
      '). You both need the same build to play.';
    lastError = message;
    dispatch({ v: mine, t: 'error', code: 'version', message: message, mine: mine, theirs: msg ? msg.v : null });
  }

  /* ---------------- peers ----------------
     Pruned lazily, on read, so there is no second timer running for the whole
     match just to expire a name nobody is asking about. */
  function peers() {
    var out = [];
    try {
      if (!st) { return out; }
      var limit = peerTimeoutMs(), t = now(), stale = [], k;
      for (k in st.seen) {
        if (!has(st.seen, k)) { continue; }
        if (t - st.seen[k] <= limit) { out.push(k); } else { stale.push(k); }
      }
      for (var i = 0; i < stale.length; i++) { delete st.seen[stale[i]]; }
    } catch (e) { /* an empty list is the honest degraded answer */ }
    return out;
  }

  /* ---------------- close ---------------- */

  function close() {
    var s = st;
    if (!s) { return; }
    st = null;              // cleared FIRST, so a handler firing during teardown
                            // sees a closed transport instead of half of one
    try {
      clearTimer(s);
      stopPings(s);
      if (s.ch) {
        try { s.ch.onmessage = null; s.ch.onmessageerror = null; } catch (e) { /* ignore */ }
        try { s.ch.close(); } catch (e) { /* already closed */ }
      }
      if (s.ws) {
        try { s.ws.onopen = null; s.ws.onmessage = null; s.ws.onclose = null; s.ws.onerror = null; } catch (e) { /* ignore */ }
        try { if (s.ws.readyState < 2) { s.ws.close(); } } catch (e) { /* already closing */ }
      }
    } catch (e) { /* teardown never throws — there is nothing left to fail into */ }
    s.open = false;
    s.ch = null;
    s.ws = null;
    /* An open() that never settled (closed while still connecting) still owes
       its caller exactly one callback, or a lobby waits forever on a spinner. */
    settle(s, err('closed', 'The room was closed.'), null);
    last = s;               // counters stay readable for the console
  }

  /* ---------------- the console surface ----------------
     Rich enough to answer "is this actually connected, and to what" from a
     browser console without a debugger: the five keys §5 names, plus the
     numbers that distinguish "quiet" from "broken" — dropped, echo,
     badVersion and overflow are four different failures with four different
     fixes, and one shared "errors" counter would hide every one of them. */
  function stats() {
    var s = st || last;
    var a = available();
    var wsOk = false, bcOk = false;
    try { wsOk = (typeof WebSocket === 'function'); } catch (e) { wsOk = false; }
    try { bcOk = (typeof BroadcastChannel === 'function'); } catch (e) { bcOk = false; }
    var types = [], k;
    try { for (k in listeners) { if (has(listeners, k) && listeners[k].length) { types.push(k); } } }
    catch (e) { types = []; }
    var live = peers();   // one prune per read, not two

    return {
      /* §5's contract */
      sent: s ? s.sent : 0,
      recv: s ? s.recv : 0,
      rttMs: s ? s.rttMs : null,
      transport: st ? st.transport : transport(),
      open: !!(st && st.open),

      /* the rest of the picture */
      id: id(),
      room: s ? s.room : null,
      name: s ? s.name : null,
      url: s ? s.url : null,
      peers: live,
      peerCount: live.length,
      upMs: (st && st.openedAt !== null) ? Math.round(now() - st.openedAt) : 0,
      dropped: s ? s.dropped : 0,       // unparsable / unsendable messages
      echo: s ? s.echo : 0,             // our own messages a relay sent back
      badVersion: s ? s.badVersion : 0, // refused by refuseVersion()
      overflow: s ? s.overflow : 0,     // dropped against MAX_BUFFERED
      lastError: lastError,

      /* what a connect() would do right now, and why */
      wouldUse: transport(),
      available: a,
      relayConfigured: !!netBase(),
      relayUrl: netBase() || null,
      wsSupported: wsOk,
      bcSupported: bcOk,
      protocolVersion: protocolVersion(),
      peerTimeoutMs: peerTimeoutMs(),
      pingEveryMs: pingEvery(),
      connectTimeoutMs: connectMs(),
      channelPrefix: channelPrefix(),
      listening: types
    };
  }

  return {
    available: available, transport: transport,
    open: open, close: close, send: send,
    on: on, off: off,
    id: id, peers: peers,
    stats: stats,
    /* Every engine here publishes debug(); stats() IS that surface, and the
       alias means the console habit works on this module too. */
    debug: stats
  };
})();
