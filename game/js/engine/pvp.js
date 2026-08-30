/* CHLOE — engine/pvp.js  (spec §32)
   The Ring with people in it: the match state machine, the seat book and the
   ownership rules for the eight-player deathmatch.

   ---------------------------------------------------------------------------
   THE ONE RULE THIS FILE EXISTS TO ENFORCE
   Remote players are NEVER added to CHLOE.engine.party.state.members. That
   array is the LOCAL party — the people whose bodies you can wake up in. Three
   things read it and every one of them would be wrong about a stranger in it:
     party.firstAliveOther  combat3's death branch swaps the camera into the
                            next living member, so a remote player in there
                            means dying drops you into someone else's body
     party.ensureAllies     hands out characters by the local leader's level
     combat3.victory()      pays XP to every member of the party
   So `pvp` keeps its OWN registry, keyed by peer id, and the only contact it
   has with `party` is the local member's level (the kill reward) and a read of
   the leader for that grant. This is exactly the shape engine/cloneai.js
   already proved for the mirror fight: a humanoid opponent that lives outside
   the party with its own resources, its own clock and its own life.
   ---------------------------------------------------------------------------

   OWNERSHIP — one authority per fact (§32.2). There is no server simulation;
   the relay is dumb fan-out, so authority is partitioned instead of arbitrated
   and two peers can never contradict each other about the same fact:

     my position / yaw / pitch / crouch / anim   me
     my life, and whether I am alive            me
     "my swing connected with you for N"        the attacker
     "I died, and X killed me"                  the victim
     roster, seats, match start, match end      the host

   The victim owning its own death is what makes kill attribution consistent:
   exactly ONE peer ever says "I died", and it names the killer, so every
   client applies the same +1 level to the same player with no round trip and
   no vote. The attacker owning the hit is what makes a swing feel instant.

   THIS IS NOT CHEAT-PROOF, AND THAT IS A DELIBERATE TRADE. A modified client
   can lie about damage or refuse to die. The alternative is an authoritative
   server simulation, which cannot run on the free static hosting this game is
   built for — the same trade worker/README.md already makes in writing for the
   record board ("a small friendly board, not a tamper-proof one").

   API (§32.5)
     state()        'idle'|'lobby'|'starting'|'match'|'dead'|'over'
     host(name, cb)                 open a lobby -> cb(err, roomCode)
     join(code, name, cb)           join one     -> cb(err, roomCode)
     leave()                        say goodbye and go back to 'idle'
     roster()                       [{id,name,seat,ready,alive,level,kills,isMe,isHost}]
     setReady(b) / canStart() / start()
     me() / isHost() / seatOf(id) / alive()
     on(evt, fn) / off(evt, fn)     'roster' 'start' 'kill' 'died' 'over'
                                    'peer' 'error' 'hit' 'swing'
     takeEvents()                   read-and-clear feed of the same events
     tickSend()                     once per rAF; rate-limits to data.pvp.sendHz
     declareHit(seat, dmg, dtype, abilityId)
     declareSwing(pattern)
     declareDeath(byId)             the victim's own announcement
     remoteOf(seat)                 SMOOTHED remote transform, or null
     bodyOf(seat) / seatOfBody(i)   the seat <-> arena body index book
     inMatch() / active()           the predicate other files gate on
     debug()

   No DOM in here, ever (layer rule). The one call outward is CHLOE.ui.toast
   through notify(), which engine/party.js and engine/progression.js already do
   for exactly the same reason: an engine may ask the UI to say something, it
   may not go and write it itself. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.pvp = (function () {
  'use strict';

  /* ---------------- tuning, and where it lives ----------------
     Every number the mode is tuned by lives in data/pvp.js (house rule: no
     magic numbers in an engine). This table is NOT a second tuning surface —
     each entry is the value data/pvp.js ships, kept here only so a build that
     is missing the file, or a key added later than this module, degrades to a
     playable default instead of dividing by `undefined`. Read through D(). */
  var FALLBACK = {
    maxPlayers: 8, minPlayers: 2, sendHz: 15, interpMs: 100,
    peerTimeoutMs: 5000, connectTimeoutMs: 4000,
    levelsPerKill: 1, startLevel: 1,
    roomCodeLen: 4, roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    nameMaxLen: 12, posDecimals: 2, angDecimals: 3,
    protocolVersion: 1,
    /* The one key with no counterpart in data/pvp.js, because it is not a
       tuning knob: it caps the read-and-clear feed so a consumer that never
       drains cannot grow it without bound. */
    eventQueueMax: 64
  };

  function D(key) {
    var d = (CHLOE.data && CHLOE.data.pvp) || null;
    var v = d ? d[key] : undefined;
    return (v === undefined || v === null) ? FALLBACK[key] : v;
  }

  /* Wire precision, straight off data/pvp.js: 2 decimals on metres, 3 on
     radians. Read through the data rather than baked in here, because the
     `an` hint below measures movement against exactly this resolution — the
     rounding and "did it move" have to be the same number or a body can report
     itself walking while transmitting the same position over and over. */
  function roundTo(v, decimals) {
    var f = Math.pow(10, decimals);
    return Math.round((+v || 0) * f) / f;
  }

  /* ---------------- siblings, every one of them optional ----------------
     A missing module degrades to a no-op here. That is not politeness: §32
     requires that a build with the multiplayer files deleted still boots and
     plays, and the same discipline in reverse means a PvP build whose net.js
     failed to load loses the mode, not the game. */
  function net()   { var n = CHLOE.engine.net;   return (n && typeof n.open === 'function') ? n : null; }
  function pty()   { var p = CHLOE.engine.party; return p || null; }
  function prog()  { var p = CHLOE.engine.progression; return (p && typeof p.grantXp === 'function') ? p : null; }
  function cmb()   { return CHLOE.engine.combat3 || null; }
  function a3d()   { return CHLOE.engine.arena3d || null; }

  function notify(text) {
    try {
      if (CHLOE.ui && typeof CHLOE.ui.toast === 'function') { CHLOE.ui.toast(text); }
    } catch (e) { /* a toast is never worth a match */ }
  }

  function now() {
    /* Monotonic: a system clock nudge mid-match must never hand the
       interpolator a snapshot from the future. Same reasoning as records.js. */
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  /* ---------------- live state ----------------
     `phase` is the state machine. `peers` is the registry — the whole roster
     INCLUDING me, keyed by peer id, and deliberately not an array: seats are
     frozen at match start and a leaver keeps his, so nothing here may ever be
     spliced or renumbered (the arena's body indices are derived from this and
     an index IS a body identity). */
  var phase = 'idle';
  var peers = {};           // id -> peer record
  var myId = null;
  var myName = '';
  var hostId = null;
  var roomCode = null;
  var mySeat = -1;

  var bodyBySeat = {};      // seat -> arena knights[] index (frozen at start)
  var seatByBody = {};      // and back
  var seatsFrozen = false;

  var lastSendAt = 0;
  var lastSentPos = null;   // {x, z} last SENT — the `an` hint is measured, not guessed
  var lastHitBy = null;     // who touched me last, for an unattributed death
  var lastHitAt = 0;
  var heartbeat = null;     // window interval: pings + the timeout sweep
  var joinTimer = null;
  var joinCb = null;
  var sent = 0, recv = 0;
  var versionWarned = {};   // one complaint per bad protocol version, not per packet
  var handlers = {};        // evt -> [fn]
  var feed = [];            // read-and-clear mirror of every emit()

  function peer(id) { return (id && peers[id]) ? peers[id] : null; }
  function meRec() { return peer(myId); }

  /* My roster row's level is the LOCAL party member's, not a number the mode
     invents: a player walks into the Ring carrying whatever the PvE ladder has
     already given them, and grantXp is what moves it afterwards. Pulled up
     before anything reads or ships the roster, so the registry never disagrees
     with the character sheet. Monotonic on purpose — if progression.js is
     absent, localLevel() answers 1 forever and the kill bumps still show. */
  function syncMe() {
    var p = meRec();
    if (!p) { return; }
    var lv = localLevel();
    if (lv > (p.level || 1)) { p.level = lv; }
  }

  /* ---------------- events ----------------
     Two ways to read the same stream, on purpose. `on()` is for anything that
     wants to react the moment something happens; takeEvents() is the
     read-and-clear feed a per-frame consumer drains (combat3.takeRevive is the
     existing model), so a kill that lands between two frames cannot be missed
     by a HUD that only looks once a frame. */
  function on(evt, fn) {
    if (!evt || typeof fn !== 'function') { return; }
    if (!handlers[evt]) { handlers[evt] = []; }
    if (handlers[evt].indexOf(fn) === -1) { handlers[evt].push(fn); }
  }

  function off(evt, fn) {
    var list = handlers[evt];
    if (!list) { return; }
    var i = list.indexOf(fn);
    if (i !== -1) { list.splice(i, 1); }
  }

  function emit(evt, payload) {
    feed.push({ type: evt, at: now(), data: payload });
    var capacity = D('eventQueueMax');
    while (feed.length > capacity) { feed.shift(); }
    var list = handlers[evt] || [];
    for (var i = 0; i < list.length; i++) {
      /* Every handler is wrapped: one bad listener must not be able to kill
         the message pump, which is the same rule net.js holds itself to. */
      try { list[i](payload); } catch (e) { /* listener's problem */ }
    }
    var all = handlers['*'] || [];
    for (var j = 0; j < all.length; j++) {
      try { all[j](evt, payload); } catch (e) { /* listener's problem */ }
    }
  }

  function takeEvents() {
    var out = feed;
    feed = [];
    return out;
  }

  function fail(code, message) {
    var e = { code: code, message: message };
    emit('error', e);
    return e;
  }

  /* ---------------- names ----------------
     A display name lands in someone else's browser, so it is scrubbed at the
     door exactly the way engine/records.js scrubs a record name: control
     characters and markup out, whitespace collapsed, hard-capped. The relay
     scrubs again server-side (a client is never a validator) — but on the
     BroadcastChannel transport there IS no server, and the lobby renders these
     into the DOM, so the check has to exist here too. */
  function cleanName(raw) {
    if (typeof raw !== 'string') { return ''; }
    var s = raw
      .replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')  // control chars, zero-widths, RTL overrides
      .replace(/[<>&"'`\\]/g, '')                                          // markup / quoting
      .replace(/\s+/g, ' ')
      .trim();
    var cap = D('nameMaxLen');
    if (s.length > cap) { s = s.slice(0, cap).trim(); }
    return s;
  }

  function cleanCode(raw) {
    if (typeof raw !== 'string') { return ''; }
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, D('roomCodeLen'));
  }

  /* The alphabet is data/pvp.js's roomCodeChars — no O/0 or I/1, because a
     room code's whole job is surviving being read down a voice call. */
  function makeCode() {
    var n = D('roomCodeLen'), chars = String(D('roomCodeChars')), out = '';
    for (var i = 0; i < n; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  /* ---------------- the registry ---------------- */

  function addPeer(id, name, seat) {
    var p = {
      id: id, name: cleanName(name) || 'Nameless', seat: seat,
      ready: false, alive: true, level: D('startLevel'), kills: 0,
      lastSeenAt: now(), left: false,
      buf: []                 // interpolation snapshots, newest last
    };
    peers[id] = p;
    return p;
  }

  function seatTaken(seat) {
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && peers[id].seat === seat) { return true; }
    }
    return false;
  }

  function nextFreeSeat() {
    var max = D('maxPlayers');
    for (var s = 0; s < max; s++) {
      if (!seatTaken(s)) { return s; }
    }
    return -1;
  }

  function peerCount() {
    var n = 0;
    for (var id in peers) { if (peers.hasOwnProperty(id)) { n++; } }
    return n;
  }

  function peerBySeat(seat) {
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && peers[id].seat === seat) { return peers[id]; }
    }
    return null;
  }

  function occupiedSeats() {
    var out = [];
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && peers[id].seat >= 0) { out.push(peers[id].seat); }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function aliveCount() {
    var n = 0;
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && peers[id].alive && !peers[id].left) { n++; }
    }
    return n;
  }

  function lastAlive() {
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && peers[id].alive && !peers[id].left) { return peers[id]; }
    }
    return null;
  }

  function roster() {
    syncMe();
    var out = [];
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      var p = peers[id];
      out.push({
        id: p.id, name: p.name, seat: p.seat, ready: !!p.ready,
        alive: !!p.alive && !p.left, level: p.level || D('startLevel'), kills: p.kills || 0,
        isMe: p.id === myId, isHost: p.id === hostId, left: !!p.left
      });
    }
    return out.sort(function (a, b) { return a.seat - b.seat; });
  }

  function me() {
    syncMe();
    var p = meRec();
    if (!p) { return null; }
    return { id: p.id, name: p.name, seat: p.seat, alive: !!p.alive,
             level: p.level || 1, kills: p.kills || 0 };
  }

  function isHost() { return !!myId && myId === hostId; }
  function seatOf(id) { var p = peer(id); return p ? p.seat : -1; }

  /* The predicates every non-PvP file should gate on, so nothing has to know
     the phase names. `inMatch()` is the one that means "the one-life rules are
     in force" — the ally suppression and combat3's bypassed leader swap both
     want this, not `active()`, which is also true while a lobby sits open. */
  function active()  { return phase !== 'idle'; }
  function inMatch() { return phase === 'starting' || phase === 'match' || phase === 'dead' || phase === 'over'; }

  /* ---------------- the seat <-> body book ----------------
     A seat owns an arena body index for the WHOLE match. arena3d never splices
     knights[] — the array index is the only body identity there, every command
     is A.thing(..., index), and the attack timers capture the body rather than
     the index — so renumbering after a death would silently re-target every
     in-flight callback. Frozen once, at start, and never touched again.

     Remote bodies begin at index 1: knights[0] is structurally special in
     arena3d (aliased as `knight`, keeps the source GLB's own materials instead
     of a clone, feeds debug()), so tinting it would mutate the shared source
     materials for every body in the scene. My own seat has no body — the
     camera is standing in it — which is why the count comes out at n-1 and
     matches battle3d's a3d.spawnRemotes(n - 1) exactly. */
  function freezeSeats() {
    bodyBySeat = {};
    seatByBody = {};
    var seats = occupiedSeats(), idx = 1;
    for (var i = 0; i < seats.length; i++) {
      if (seats[i] === mySeat) { continue; }
      bodyBySeat[seats[i]] = idx;
      seatByBody[idx] = seats[i];
      idx++;
    }
    seatsFrozen = true;
  }

  function bodyOf(seat) {
    var b = bodyBySeat[seat];
    return (b === undefined) ? -1 : b;
  }

  function seatOfBody(index) {
    var s = seatByBody[index];
    return (s === undefined) ? -1 : s;
  }

  /* ---------------- transport ---------------- */

  function tx(msg) {
    var n = net();
    if (!n || !msg) { return false; }
    /* net.js stamps `v` (and `id`) onto its own copy on the way out, so this
       is a belt: a transport that did not would otherwise put frames on the
       wire that every receiver refuses, and the mode would fail silently in
       the one direction nobody tests. Same value either way. */
    msg.v = D('protocolVersion');
    var ok = false;
    try { ok = !!n.send(msg); } catch (e) { ok = false; }
    if (ok) { sent++; }
    return ok;
  }

  function openRoom(code, name, asHost, cb) {
    var n = net();
    if (!n) {
      var e = fail('no-transport', 'Multiplayer is not available in this build.');
      if (typeof cb === 'function') { try { cb(e, null); } catch (x) {} }
      return;
    }
    roomCode = code;
    myName = cleanName(name) || 'Nameless';
    peers = {};
    hostId = null;
    mySeat = -1;
    seatsFrozen = false;
    bodyBySeat = {}; seatByBody = {};
    lastHitBy = null; lastSentPos = null;
    sent = 0; recv = 0;
    versionWarned = {};

    try { n.on('*', onWire); } catch (e2) { /* a transport with no pump is a dead one */ }

    /* 'lobby' the moment the attempt starts, not when it succeeds: a relay
       socket takes a real handshake to come up, and leaving the phase at
       'idle' for that window would let a second host()/join() through the
       guard above and open two rooms on one client. */
    phase = 'lobby';

    n.open(code, { name: myName }, function (err) {
      if (err) {
        detach();
        phase = 'idle';
        var e3 = fail('open-failed', (err && err.message) || 'Could not reach the room.');
        if (typeof cb === 'function') { try { cb(e3, null); } catch (x) {} }
        return;
      }
      myId = null;
      try { myId = n.id(); } catch (e4) { myId = null; }
      if (!myId) { myId = 'p' + Math.floor(Math.random() * 1e9).toString(36); }

      startHeartbeat();

      if (asHost) {
        /* The lobby exists the moment you own it, so the host's callback fires
           now rather than waiting for company. */
        hostId = myId;
        mySeat = 0;
        var p = addPeer(myId, myName, 0);
        p.ready = true;          // you cannot un-ready the room you opened
        phase = 'lobby';
        emit('roster', roster());
        if (typeof cb === 'function') { try { cb(null, roomCode); } catch (x) {} }
        return;
      }

      /* A joiner has nothing until a host answers. On BroadcastChannel there
         is no server to ask whether a room exists, so "does this code lead
         anywhere" is answered by the roster arriving — or not arriving, which
         is a readable error rather than a lobby of one that looks joined. */
      phase = 'lobby';
      joinCb = cb;
      joinTimer = later(function () {
        joinTimer = null;
        var e5 = fail('no-lobby', 'No lobby answered on ' + roomCode + '.');
        finishJoin(e5, null);
        leave();
      }, D('connectTimeoutMs'));
      tx({ t: 'hello', id: myId, name: myName });
    });
  }

  function finishJoin(err, code) {
    var cb = joinCb;
    joinCb = null;
    if (joinTimer !== null) { clearLater(joinTimer); joinTimer = null; }
    if (typeof cb === 'function') { try { cb(err, code); } catch (e) {} }
  }

  function detach() {
    var n = net();
    if (n) {
      try { n.off('*', onWire); } catch (e) {}
      try { n.close(); } catch (e2) {}
    }
    stopHeartbeat();
  }

  /* window timers, feature-detected. arena3d already uses window.setTimeout
     from the engine layer — a timer is not the DOM. */
  function later(fn, ms) {
    try {
      if (typeof window !== 'undefined' && window.setTimeout) { return window.setTimeout(fn, ms); }
    } catch (e) {}
    return null;
  }
  function clearLater(h) {
    try { if (h !== null && typeof window !== 'undefined' && window.clearTimeout) { window.clearTimeout(h); } } catch (e) {}
  }

  /* THE SWEEP RUNS ON ITS OWN CLOCK, not off tickSend, because a lobby never
     reaches a frame loop: battle3d is what calls tickSend, and in the lobby
     battle3d is not running.

     It does NOT ping. engine/net.js already runs its own ping schedule on both
     transports and says why in writing — the pipe measures itself, and its
     pings are what keep an idle lobby's peers from ageing out. Those pings
     arrive here like any other message and refresh lastSeenAt, so a second
     pinger in this file would be a second clock on the same fact. */
  function startHeartbeat() {
    stopHeartbeat();
    var every = Math.max(200, Math.round(D('peerTimeoutMs') / 3));
    try {
      if (typeof window !== 'undefined' && window.setInterval) {
        heartbeat = window.setInterval(pulse, every);
      }
    } catch (e) { heartbeat = null; }
  }

  function stopHeartbeat() {
    try {
      if (heartbeat !== null && typeof window !== 'undefined' && window.clearInterval) {
        window.clearInterval(heartbeat);
      }
    } catch (e) {}
    heartbeat = null;
  }

  function pulse() {
    if (phase === 'idle') { return; }
    sweep();
  }

  function sweep() {
    var limit = D('peerTimeoutMs'), t = now();
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      if (id === myId) { continue; }
      var p = peers[id];
      if (p.left) { continue; }
      if (t - p.lastSeenAt > limit) { peerGone(id, 'timeout'); }
    }
  }

  /* ---------------- inbound ---------------- */

  function onWire(msg) {
    if (!msg || typeof msg !== 'object') { return; }
    if (phase === 'idle') { return; }
    recv++;

    /* A protocol mismatch is refused with something readable rather than
       allowed to produce a subtly broken match (§32.4). engine/net.js already
       refuses one at the transport and hands up a synthetic 'error' (handled
       below), so in a normal build this branch never fires — it is the
       backstop for a transport that passes everything through. Once per
       version, not once per packet: a mismatched peer sends 15 a second. */
    if (msg.v !== D('protocolVersion')) {
      var key = String(msg.v);
      if (!versionWarned[key]) {
        versionWarned[key] = true;
        fail('version', 'Someone is on a different build of the game (protocol ' +
             key + ', this build speaks ' + D('protocolVersion') + ').');
      }
      return;
    }

    /* A relay may fan a message back to its sender; BroadcastChannel does not.
       Dropping my own id here means neither transport can double-apply
       anything, and the host-authored types (roster/start/over) carry no `id`
       and are made idempotent instead. */
    if (msg.id && msg.id === myId) { return; }

    var p = peer(msg.id);
    if (p) {
      p.lastSeenAt = now();
      /* A late packet un-marks a peer that merely stuttered — but only in the
         lobby. Mid-match a peer that was called gone is DEAD, and a straggling
         packet must not put it back in the running (or, through
         maybePromoteHost, back in charge). */
      if (!inMatch()) { p.left = false; }
    }

    switch (msg.t) {
      case 'hello':  onHello(msg);  break;
      case 'roster': onRoster(msg); break;
      case 'ready':  onReady(msg);  break;
      case 'start':  onStart(msg);  break;
      case 'state':  onState(msg);  break;
      case 'swing':  onSwing(msg);  break;
      case 'hit':    onHit(msg);    break;
      case 'died':   onDied(msg);   break;
      case 'over':   onOver(msg);   break;
      case 'bye':    if (msg.id) { peerGone(msg.id, 'bye'); } break;
      case 'full':   onFull(msg);   break;
      /* net.js's own synthetic message — it refuses a protocol mismatch at the
         transport and hands up a readable line rather than letting a subtly
         broken match happen. It has no `id`, so it is nobody's peer traffic;
         passing it straight through is what puts the sentence in front of the
         player in the lobby instead of dropping it in `default`. */
      case 'error':  fail(msg.code || 'net', msg.message || 'The connection reported a problem.'); break;
      /* 'ping'/'pong' are net.js's business — it answers pings itself and
         keeps rttMs in stats(). They still arrive here, and the only thing
         this file wants from them is the lastSeenAt touch above. */
      case 'ping':   break;
      case 'pong':   break;
      default:       break;         // an unknown type is ignored, never thrown on
    }
  }

  function onHello(msg) {
    if (!isHost() || !msg.id) { return; }
    var p = peer(msg.id);
    if (p) {
      /* A re-hello is a peer that missed the roster (a tab that reloaded, a
         socket that reconnected). Answer it rather than ignoring it. */
      p.name = cleanName(msg.name) || p.name;
      broadcastRoster();
      return;
    }
    if (phase !== 'lobby') {
      tx({ t: 'full', to: msg.id, reason: 'started' });
      return;
    }
    var seat = nextFreeSeat();
    if (seat < 0) {
      tx({ t: 'full', to: msg.id, reason: 'full' });
      return;
    }
    addPeer(msg.id, msg.name, seat);
    broadcastRoster();
  }

  function onFull(msg) {
    if (msg.to !== myId) { return; }
    var why = (msg.reason === 'started')
      ? 'That match has already started.'
      : 'That lobby is full (' + D('maxPlayers') + ' players).';
    var e = fail('refused', why);
    finishJoin(e, null);
    leave();
  }

  function onRoster(msg) {
    if (!msg.host) { return; }

    /* Two hosts, one code — possible when two players generate the same room
       code, and fatal if both keep believing themselves authoritative. Settle
       it the way every other tie here is settled: deterministically, on the
       ids, so both sides reach the same answer without negotiating. */
    if (isHost() && msg.host !== myId) {
      if (String(msg.host) > String(myId)) { return; }
    }
    if (isHost() && msg.host === myId) { return; }   // my own echo

    /* Seats are frozen at start, deaths belong to their victims, and levels
       come from the kill feed — so once a match is running the roster message
       has nothing left to say that is not already known better locally. */
    if (inMatch()) { return; }

    hostId = msg.host;
    var rows = (Object.prototype.toString.call(msg.players) === '[object Array]') ? msg.players : [];
    var seen = {}, i;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.id) { continue; }
      seen[r.id] = true;
      var p = peer(r.id);
      if (!p) { p = addPeer(r.id, r.name, r.seat); }
      /* Names, seats and ready ticks are the host's to state. `kills` and the
         interpolation buffer are LOCAL derivations and are deliberately left
         alone — every client counts kills off the same death messages. */
      p.name = cleanName(r.name) || p.name;
      p.seat = (typeof r.seat === 'number') ? r.seat : p.seat;
      p.ready = !!r.ready;
      p.alive = (r.alive === undefined) ? p.alive : !!r.alive;
      p.level = r.level || p.level || 1;
    }
    for (var id in peers) {
      if (peers.hasOwnProperty(id) && !seen[id]) { delete peers[id]; }
    }
    if (!peer(myId)) {
      /* The host does not know me yet — say hello again rather than sitting in
         a lobby I am not actually in. */
      tx({ t: 'hello', id: myId, name: myName });
      return;
    }
    mySeat = peers[myId].seat;
    if (joinCb) { finishJoin(null, roomCode); }
    emit('roster', roster());
  }

  function onReady(msg) {
    var p = peer(msg.id);
    if (!p) { return; }
    p.ready = !!msg.ready;
    if (isHost()) { broadcastRoster(); }
    else { emit('roster', roster()); }
  }

  function onStart(msg) {
    applyStart(msg.seats, msg.stage);
  }

  function onState(msg) {
    var p = peer(msg.id);
    if (!p || !inMatch()) { return; }
    p.buf.push({
      t: now(),
      x: +msg.x || 0, z: +msg.z || 0,
      yaw: +msg.yaw || 0, pitch: +msg.pitch || 0,
      cr: !!msg.cr, an: msg.an || 'idle',
      hp: (typeof msg.hp === 'number') ? msg.hp : null,
      lv: msg.lv || p.level || 1
    });
    while (p.buf.length > bufDepth()) { p.buf.shift(); }
    p.level = msg.lv || p.level;
  }

  /* How many snapshots the interpolator has to keep: enough to span the render
     delay, plus one on each side of it. DERIVED, never a fixed three — a fixed
     depth silently stops interpolating the moment anyone raises
     data.pvp.sendHz, because the whole buffer would then be newer than the
     render clock and every read would fall through to "hold the newest
     packet". That is the no-smoothing case wearing the same code path, which
     is exactly the kind of failure this codebase cannot see. */
  function bufDepth() {
    return Math.max(3, Math.ceil(D('interpMs') / 1000 * D('sendHz')) + 2);
  }

  function onSwing(msg) {
    var p = peer(msg.id);
    if (!p || !inMatch()) { return; }
    emit('swing', { id: p.id, seat: p.seat, body: bodyOf(p.seat), pattern: msg.pattern });
  }

  function onHit(msg) {
    if (!inMatch()) { return; }
    var from = peer(msg.id);
    var mine = msg.target === myId;
    emit('hit', {
      id: msg.id, target: msg.target, mine: mine,
      seat: from ? from.seat : -1,
      targetSeat: seatOf(msg.target),
      dmg: msg.dmg, dtype: msg.dtype || null, ability: msg.ability || null
    });
    if (!mine) { return; }            // someone else's life is theirs to keep

    var self = meRec();
    if (!self || !self.alive) { return; }
    lastHitBy = msg.id;
    lastHitAt = now();
    var res = applyDeclaredDamage(msg.dmg, msg.dtype, msg.ability, msg.id);
    if (res && res.dead) { declareDeath(msg.id); }
  }

  /* The attacker declared a number; combat3 spends it on the local player.
     The exact entry point is combat3's to name (§32.5 gives it a declared-hit
     path), so it is feature-detected in order of specificity rather than
     assumed — a build whose combat3 has not landed that path yet loses the
     damage, not the frame. The §25 miss guard and the evade i-frames still
     apply on the far side: a declared hit that arrives during an evade must
     still miss, or evade stops meaning anything in PvP. */
  function applyDeclaredDamage(dmg, dtype, ability, byId) {
    var c = cmb();
    var n = Math.max(0, Math.round(+dmg || 0));
    if (!c || !n) { return null; }
    var out = null;
    try {
      if (typeof c.takeDeclaredHit === 'function') {
        out = c.takeDeclaredHit(n, dtype || null, ability || null, byId || null);
      } else if (typeof c.takeHit === 'function') {
        out = c.takeHit({ declared: true, dmg: n, dtype: dtype || null,
                          ability: ability || null, by: byId || null });
      }
    } catch (e) { out = null; }
    return out;
  }

  function onDied(msg) {
    if (!msg.id) { return; }
    applyDeath(msg.id, msg.by || null, false);
  }

  function onOver(msg) {
    concludeMatch(msg.winner || null);
  }

  /* ---------------- leaving, and being left ---------------- */

  function peerGone(id, reason) {
    var p = peer(id);
    if (!p || p.left) { return; }
    p.left = true;
    p.lastSeenAt = now();
    emit('peer', { id: id, seat: p.seat, name: p.name, gone: true, reason: reason });

    if (inMatch()) {
      /* A leaver is dead for match purposes — the alternative is a match that
         waits forever for a browser tab that is already closed. No killer, so
         no level: nobody earned it. The body is marked dead in place and keeps
         its seat and its arena index; splicing it out would renumber every
         body below it. */
      if (p.alive) {
        p.alive = false;
        emit('died', { id: id, seat: p.seat, name: p.name, by: null, isMe: false, left: true });
        checkOver();
      }
    } else {
      delete peers[id];
      if (isHost()) { broadcastRoster(); }
      else { emit('roster', roster()); }
    }
    if (id === hostId) { maybePromoteHost(); }
  }

  /* The host left. On paper the host owns the roster and the match end; in
     practice a lobby whose opener closed a tab must not become unusable, so
     the lowest surviving seat inherits the role. Deterministic on seat then
     id, so every client promotes the same peer without a vote. */
  function maybePromoteHost() {
    var best = null;
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      var p = peers[id];
      if (p.left) { continue; }
      if (!best || p.seat < best.seat || (p.seat === best.seat && String(p.id) < String(best.id))) {
        best = p;
      }
    }
    if (!best) { return; }
    hostId = best.id;
    if (isHost() && !inMatch()) { broadcastRoster(); }
    else { emit('roster', roster()); }
  }

  function leave() {
    if (phase === 'idle') { return; }
    tx({ t: 'bye', id: myId });
    finishJoin({ code: 'left', message: 'You left the lobby.' }, null);
    detach();
    phase = 'idle';
    peers = {};
    hostId = null; roomCode = null; mySeat = -1; myId = null;
    bodyBySeat = {}; seatByBody = {}; seatsFrozen = false;
    lastHitBy = null; lastSentPos = null; lastSendAt = 0;
    emit('roster', []);
  }

  /* ---------------- lobby ---------------- */

  function host(name, cb) {
    if (phase !== 'idle') {
      var e = fail('busy', 'You are already in a lobby.');
      if (typeof cb === 'function') { try { cb(e, null); } catch (x) {} }
      return;
    }
    openRoom(makeCode(), name, true, cb);
  }

  function join(code, name, cb) {
    if (phase !== 'idle') {
      var e = fail('busy', 'You are already in a lobby.');
      if (typeof cb === 'function') { try { cb(e, null); } catch (x) {} }
      return;
    }
    var c = cleanCode(code);
    if (c.length !== D('roomCodeLen')) {
      var e2 = fail('bad-code', 'A room code is ' + D('roomCodeLen') + ' letters and numbers.');
      if (typeof cb === 'function') { try { cb(e2, null); } catch (x) {} }
      return;
    }
    openRoom(c, name, false, cb);
  }

  function setReady(b) {
    var p = meRec();
    if (!p || phase !== 'lobby') { return; }
    p.ready = !!b;
    if (isHost()) { broadcastRoster(); }
    else { tx({ t: 'ready', id: myId, ready: p.ready }); emit('roster', roster()); }
  }

  function canStart() {
    if (!isHost() || phase !== 'lobby') { return false; }
    var n = 0, ready = 0;
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      n++;
      if (peers[id].ready) { ready++; }
    }
    return n >= D('minPlayers') && ready === n;
  }

  function broadcastRoster() {
    if (!isHost()) { return; }
    syncMe();
    var rows = [];
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      var p = peers[id];
      rows.push({ id: p.id, name: p.name, seat: p.seat, ready: !!p.ready,
                  alive: !!p.alive, level: p.level || 1 });
    }
    tx({ t: 'roster', host: myId, players: rows });
    emit('roster', roster());
  }

  function start() {
    if (!canStart()) { return; }
    var seats = {};
    for (var id in peers) {
      if (peers.hasOwnProperty(id)) { seats[id] = peers[id].seat; }
    }
    tx({ t: 'start', stage: 'ring', seats: seats });
    applyStart(seats, 'ring');
  }

  function applyStart(seats, stage) {
    if (phase !== 'lobby') { return; }        // idempotent: a re-sent start is a no-op
    if (seats && typeof seats === 'object') {
      for (var id in seats) {
        if (!seats.hasOwnProperty(id)) { continue; }
        var p = peer(id);
        if (!p) { p = addPeer(id, 'Nameless', seats[id]); }
        p.seat = seats[id];
      }
    }
    var self = meRec();
    if (!self) { return; }
    mySeat = self.seat;
    for (var k in peers) {
      if (!peers.hasOwnProperty(k)) { continue; }
      peers[k].alive = !peers[k].left;
      peers[k].kills = 0;
      peers[k].buf = [];
    }
    freezeSeats();
    lastHitBy = null;
    lastSentPos = null;
    lastSendAt = 0;
    phase = 'starting';
    emit('start', {
      stage: stage || 'ring',
      seat: mySeat,
      body: -1,                       // my own seat has no remote body
      count: peerCount(),
      remotes: peerCount() - 1,
      seats: occupiedSeats()
    });
  }

  /* ---------------- the fight ---------------- */

  /* Called once per rAF by battle3d; the rate limit lives HERE so no caller
     has to remember it. The first call is also what turns 'starting' into
     'match': battle3d only ticks once its own frame loop is running, which is
     precisely the moment the local player is actually in the Ring. */
  function tickSend() {
    if (phase === 'starting') { phase = 'match'; }
    if (!inMatch()) { return; }
    sweep();
    if (phase !== 'match') { return; }

    /* Backstop for a death that arrived by some path other than a declared hit
       (a combat3 build that reports the kill through its own snapshot rather
       than a return value). Idempotent — declareDeath only ever fires once. */
    var snap = null;
    try { var c = cmb(); snap = (c && typeof c.snapshot === 'function') ? c.snapshot() : null; } catch (e) { snap = null; }
    if (snap && typeof snap.hp === 'number' && snap.hp <= 0) { declareDeath(lastHitBy); return; }

    var t = now();
    var every = 1000 / Math.max(1, D('sendHz'));
    if (t - lastSendAt < every) { return; }
    lastSendAt = t;

    var A = a3d();
    var d = null;
    try { d = (A && typeof A.debug === 'function') ? A.debug() : null; } catch (e2) { d = null; }
    if (!d || typeof d.x !== 'number') { return; }
    syncMe();

    /* Rounded before it goes out (§32.4), to data/pvp.js's own precisions.
       Bandwidth, and quiet — an unrounded float makes every idle tick look
       like movement to anything watching for change. */
    var x = roundTo(d.x, D('posDecimals'));
    var z = roundTo(d.z, D('posDecimals'));
    tx({
      t: 'state', id: myId,
      x: x, z: z,
      yaw: roundTo(d.yaw, D('angDecimals')),
      pitch: roundTo(d.pitch, D('angDecimals')),
      cr: !!d.crouch,
      an: animHint(x, z, !!d.crouch),
      hp: (snap && typeof snap.hp === 'number') ? Math.round(snap.hp) : null,
      lv: localLevel()
    });
  }

  /* The `an` field is a WORD, not a pose id: the arena owns the pose table and
     a remote rig can legitimately be null, so the wire says what a body is
     DOING and the far side decides how to draw it. Measured from the ROUNDED
     positions actually sent, which is what makes the test free of invented
     constants: "moving" means the position changed by more than the wire can
     represent. A walk/run threshold would be a tuning number, and tuning
     numbers belong in data/ — the receiver already has every transform this
     body has occupied and can tell a walk from a sprint off its own speeds,
     which live in the arena where the rest of the pose table lives. */
  function animHint(x, z, crouching) {
    var moving = !!lastSentPos && (x !== lastSentPos.x || z !== lastSentPos.z);
    lastSentPos = { x: x, z: z };
    if (crouching) { return moving ? 'crouchmove' : 'crouch'; }
    return moving ? 'move' : 'idle';
  }

  function localLevel() {
    var p = pty();
    var m = null;
    try { m = (p && typeof p.active === 'function' && p.active()) || null; } catch (e) { m = null; }
    if (!m && p && p.state && p.state.members && p.state.members.length) { m = p.state.members[0]; }
    return (m && m.level) || D('startLevel');
  }

  /* The attacker owns "my swing connected with you for N". Sent, never
     applied locally: the target's life is the target's to spend, and its next
     state packet (67 ms at 15 Hz) is the correction. */
  function declareHit(targetSeat, dmg, dtype, abilityId) {
    if (phase !== 'match') { return false; }
    var p = peerBySeat(targetSeat);
    if (!p || p.id === myId || !p.alive || p.left) { return false; }
    return tx({
      t: 'hit', id: myId, target: p.id,
      dmg: Math.max(1, Math.round(+dmg || 0)),
      dtype: dtype || null, ability: abilityId || null
    });
  }

  function declareSwing(pattern) {
    if (!inMatch() || !pattern) { return false; }
    return tx({ t: 'swing', id: myId, pattern: String(pattern) });
  }

  /* THE VICTIM OWNS THE DEATH. Exactly one peer ever says "I died", and it
     names the killer, which is what makes every client credit the same kill to
     the same player without another round trip. Fires once: a second call on a
     body that is already down is a no-op, so the snapshot backstop in
     tickSend and a declared hit's return value can both call it. */
  function declareDeath(byId) {
    var self = meRec();
    if (!self || !self.alive || !inMatch()) { return false; }
    var by = byId || null;
    if (!by && lastHitBy && (now() - lastHitAt) < D('peerTimeoutMs')) { by = lastHitBy; }
    phase = 'dead';
    tx({ t: 'died', id: myId, by: by });
    applyDeath(myId, by, true);
    return true;
  }

  /* Every client runs THIS, on the same message, in the same order — which is
     why nobody has to agree about anything afterwards. */
  function applyDeath(victimId, byId, isMe) {
    var v = peer(victimId);
    if (!v || !v.alive) { return; }          // idempotent: a re-sent death is a no-op
    v.alive = false;
    v.diedAt = now();
    if (isMe && phase === 'match') { phase = 'dead'; }

    var killer = (byId && byId !== victimId) ? peer(byId) : null;
    if (killer) {
      killer.kills = (killer.kills || 0) + 1;
      applyKillLevel(killer);
      emit('kill', {
        killer: killer.id, killerName: killer.name, killerSeat: killer.seat,
        victim: v.id, victimName: v.name, victimSeat: v.seat,
        mine: killer.id === myId, kills: killer.kills, level: killer.level
      });
    }
    emit('died', {
      id: v.id, seat: v.seat, name: v.name, body: bodyOf(v.seat),
      by: killer ? killer.id : null, byName: killer ? killer.name : null,
      isMe: !!isMe, left: false
    });
    checkOver();
  }

  /* ---------------- the kill -> level rule ----------------
     A kill raises the killer one level, immediately, mid-match. Every client
     applies it to its own copy of the roster so the scoreboard agrees; the one
     client whose player IS the killer also spends it on the real party member,
     which is the only place a level means anything mechanically. */
  function applyKillLevel(killer) {
    var per = D('levelsPerKill');
    killer.level = (killer.level || 1) + per;
    if (killer.id !== myId) { return; }      // a remote killer's level is a label
    levelUpLocal(per);
  }

  /* Verified live to land exactly one level per call: topping the bar up to
     the next threshold is the only grant that cannot overshoot into two. */
  function levelUpLocal(levels) {
    var p = pty(), pr = prog();
    if (!p || !pr) { return 0; }
    var m = null;
    try { m = (typeof p.active === 'function' && p.active()) || null; } catch (e) { m = null; }
    if (!m && p.state && p.state.members && p.state.members.length) { m = p.state.members[0]; }
    if (!m) { return 0; }

    var membersBefore = (p.state && p.state.members) ? p.state.members.length : 0;
    var unmute = muteToasts();
    var gained = 0;
    try {
      for (var i = 0; i < levels; i++) {
        var was = m.level;
        pr.grantXp(m, Math.max(1, pr.xpToNext(m.level) - m.xp));
        gained += Math.max(0, m.level - was);
      }
    } catch (e2) { /* a level is never worth the match */ }
    unmute();

    guardAgainstAlly(p, membersBefore);

    /* A mid-fight level buys +life/+stamina/+magic that combat3 caches in
       st.max at start() and nowhere else, so without this the level is
       invisible on the bars for the rest of the match. Guarded: the export
       arrives with §32's combat3 edit. */
    var c = cmb();
    if (c && typeof c.refreshLeaderStats === 'function') {
      try { c.refreshLeaderStats(); } catch (e3) {}
    }

    if (gained) { notify('LEVEL ' + m.level); }
    return gained;
  }

  /* Level-up is noisy by design in the PvE run — a skill point, a line per
     learnset move — and the FIRST kill alone fires three toasts. A deathmatch
     wants one clean "LEVEL n" instead, so the toast sink is muted for the
     duration of the grant and restored unconditionally afterwards.

     The primary suppression belongs in progression.js, which knows a PvP match
     is running and can skip the announcements at the source. This is the
     second line, and it is here for the same reason party.resetBinds() has a
     self-heal behind it: both, not either. Muting an already-silent sink costs
     nothing, and a build where the progression edit is missing still reads
     cleanly instead of shouting. */
  function muteToasts() {
    var ui = CHLOE.ui;
    if (!ui || typeof ui.toast !== 'function') { return function () {}; }
    var real = ui.toast;
    try { ui.toast = function () {}; } catch (e) { return function () {}; }
    return function () { try { ui.toast = real; } catch (e2) {} };
  }

  /* THE TRAP THAT WOULD SILENTLY BREAK ONE LIFE.
     progression.grantXp calls party.ensureAllies() on every level-up, and
     ladder row 4 carries ally:'ash'. A player's THIRD kill therefore puts an
     AI ally in the party — and combat3's death branch then finds
     firstAliveOther and swaps the player into Ash INSTEAD of killing them.
     From the third kill on, "exactly one life" is quietly false.

     The fix belongs at the choke point in party.ensureAllies (§32's
     progression edit). This is the backstop, and it is deliberately blunt:
     party.add() only ever pushes, so truncating back to the length we measured
     removes exactly what the grant added and nothing else. It never runs
     outside a PvP match, so PvE keeps its ally. */
  function guardAgainstAlly(p, before) {
    if (!inMatch()) { return; }
    var mem = p.state && p.state.members;
    if (!mem || mem.length <= before) { return; }
    mem.length = before;
    try {
      if (typeof p.get === 'function' && !p.get(p.state.activeId) && mem.length) {
        p.state.activeId = mem[0].id;
      }
    } catch (e) {}
  }

  /* ---------------- the end ----------------
     One life means the match ends when one player is left standing. Zero is a
     real outcome too — two players can kill each other inside the same 67 ms
     window, and the last player standing can also be the one who closed their
     tab — and it resolves as a DRAW with no winner rather than a match that
     hangs waiting for a survivor who cannot arrive.

     The host owns match end on paper. In practice every client reaches the
     same verdict from the same death messages, so each concludes locally as
     well; the host's 'over' is the tiebreak that arrives, not the permission
     that is waited for. That redundancy is what stops a host who left from
     freezing everyone else in a finished match. */
  function checkOver() {
    if (phase !== 'match' && phase !== 'dead' && phase !== 'starting') { return; }
    if (aliveCount() > 1) { return; }
    var w = lastAlive();
    if (isHost()) { tx({ t: 'over', winner: w ? w.id : null }); }
    concludeMatch(w ? w.id : null);
  }

  function concludeMatch(winnerId) {
    if (phase === 'over' || phase === 'idle' || phase === 'lobby') { return; }
    phase = 'over';
    var w = peer(winnerId);
    emit('over', {
      winner: winnerId || null,
      winnerName: w ? w.name : null,
      winnerSeat: w ? w.seat : -1,
      isMe: !!winnerId && winnerId === myId,
      draw: !winnerId
    });
  }

  /* ---------------- reading a remote body ----------------
     The arena asks for this every frame, so it returns a SMOOTHED transform,
     never the raw last packet: at 15 Hz the raw values would step four times a
     second and the body would teleport between them.

     Snapshot interpolation, the standard shape — render `interpMs` behind the
     newest packet and walk between the two snapshots that straddle that
     moment. The delay is what buys the smoothing: it means there is almost
     always a packet on BOTH sides of the render clock, so the position is
     interpolated rather than guessed forward. Past the newest snapshot it
     HOLDS rather than extrapolating; a body frozen for 60 ms reads as lag,
     while a body that slid somewhere its player never went reads as a bug. */
  function remoteOf(seat) {
    var p = peerBySeat(seat);
    if (!p || p.id === myId || !p.buf.length) { return null; }
    var target = now() - D('interpMs');
    var a = null, b = null, i;
    for (i = 0; i < p.buf.length; i++) {
      if (p.buf[i].t <= target) { a = p.buf[i]; }
      else { b = p.buf[i]; break; }
    }
    var s;
    if (a && b) {
      var span = b.t - a.t;
      var k = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
      s = {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        yaw: a.yaw + shortestArc(a.yaw, b.yaw) * k,
        pitch: a.pitch + (b.pitch - a.pitch) * k,
        cr: k < 0.5 ? a.cr : b.cr,
        an: k < 0.5 ? a.an : b.an,
        hp: (b.hp === null) ? a.hp : b.hp,
        lv: b.lv
      };
    } else {
      s = a || p.buf[p.buf.length - 1];
    }
    return {
      id: p.id, name: p.name, seat: p.seat, body: bodyOf(p.seat),
      x: s.x, z: s.z, yaw: s.yaw, pitch: s.pitch,
      cr: !!s.cr, an: s.an || 'idle',
      hp: s.hp, lv: s.lv || p.level || 1,
      alive: !!p.alive && !p.left
    };
  }

  /* Yaw is an angle, so it is walked the short way round: lerping 3.10 to
     -3.10 the naive way spins the body a full turn on the spot every time a
     player crosses due south. */
  function shortestArc(from, to) {
    var d = to - from;
    while (d > Math.PI) { d -= Math.PI * 2; }
    while (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  }

  /* ---------------- debug (mirrors arena3d.debug()'s spirit) ----------------
     Everything a "is this actually working?" probe needs, counted off the live
     registry rather than asserted: who is in, which body each seat drives, how
     stale each peer is, and how much traffic has moved. */
  function debug() {
    var n = net(), t = now();
    var players = [];
    for (var id in peers) {
      if (!peers.hasOwnProperty(id)) { continue; }
      var p = peers[id];
      players.push({
        id: p.id, name: p.name, seat: p.seat, body: bodyOf(p.seat),
        ready: !!p.ready, alive: !!p.alive && !p.left, left: !!p.left,
        level: p.level || 1, kills: p.kills || 0,
        isMe: p.id === myId, isHost: p.id === hostId,
        /* No per-peer rtt here on purpose: net.stats() is the one place the
           pipe measures itself, and it rides along below as `net`. */
        seenAgoMs: Math.round(t - p.lastSeenAt),
        buffered: p.buf.length
      });
    }
    players.sort(function (a, b) { return a.seat - b.seat; });
    var stats = null;
    try { stats = (n && typeof n.stats === 'function') ? n.stats() : null; } catch (e) { stats = null; }
    return {
      state: phase, room: roomCode, protocol: D('protocolVersion'),
      transport: (function () {
        try { return (n && typeof n.transport === 'function') ? n.transport() : null; }
        catch (e2) { return null; }
      })(),
      me: me(), isHost: isHost(), host: hostId,
      players: players, count: peerCount(), alive: aliveCount(),
      seatsFrozen: seatsFrozen, bodies: seatByBody,
      sendHz: D('sendHz'), interpMs: D('interpMs'),
      sentSinceOpen: sent, recvSinceOpen: recv,
      lastSendAgoMs: lastSendAt ? Math.round(t - lastSendAt) : null,
      lastHitBy: lastHitBy, queued: feed.length,
      net: stats
    };
  }

  return {
    state: function () { return phase; },
    host: host, join: join, leave: leave,
    roster: roster, setReady: setReady, canStart: canStart, start: start,
    me: me, isHost: isHost, seatOf: seatOf, alive: aliveCount,
    on: on, off: off, takeEvents: takeEvents,
    tickSend: tickSend,
    declareHit: declareHit, declareSwing: declareSwing, declareDeath: declareDeath,
    remoteOf: remoteOf,
    /* The seat <-> arena body book. A seat owns its index for the whole match;
       ask here rather than assuming seat === index, because the local player's
       seat has no body and every seat above it therefore shifts down one. */
    bodyOf: bodyOf, seatOfBody: seatOfBody,
    /* The predicates a non-PvP file gates on, so no other module has to know
       the phase names: inMatch() is "the one-life rules are in force". */
    inMatch: inMatch, active: active,
    debug: debug
  };
})();
