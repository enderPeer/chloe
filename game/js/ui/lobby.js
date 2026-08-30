/* CHLOE — ui/lobby.js  (§32 — The Ring: the deathmatch lobby)
   Owns #screen-lobby: name yourself, open a Ring or join one by code, watch up
   to eight seats fill with ready ticks, and — if you opened it — press Start.
   Rules live in engine/pvp.js and the wire lives in engine/net.js; this file
   only draws them and takes the click. Nothing here knows a message shape.

   IT IS A SCREEN, NOT AN OVERLAY, AND THAT DECIDES THE RESUME
   ui/shop.js is an overlay: it stops the room on open and has to restart it on
   close, hence its pauseWorld/resumeWorld pair. The lobby is a full screen, so
   it leaves through ui.show(returnTo) and ui/room3d.js's OWN onShow handler
   restarts the world loop. That is why only half of shop.js's pair is copied
   below: calling _resume() from here as well would start the loop twice.
   And it is why nothing in this file calls ui.onShow('room3d', …) — ui._onShow
   is a ONE-SLOT registry, so registering there would silently evict the room's
   own handler and the room would never resume again (§32, AGENTS.md traps).

   THE KEYS ARE CAPTURED, NOT LISTENED FOR
   ui/room3d.js listens for M / Tab on document in the BUBBLE phase and knows
   nothing about this screen, and a player typing a name with a 'w' in it must
   not walk into a wall. So every key handler here is capture phase with
   stopPropagation — exactly ui/shop.js's reasoning, and exactly what
   engine/records.js's name modal does for its own text field.

   THE ROOM CODE IS SELECTABLE ON PURPOSE
   game.css sets body{user-select:none} globally. Without the explicit
   user-select:text on .lobby-code (and the Copy button beside it) a player
   physically could not share the code that is the whole point of the screen.

   EVERY CALL OUT OF HERE IS GUARDED
   engine/pvp.js, engine/net.js, data/pvp.js, ui/room3d.js and ui/battle3d.js
   are all optional as far as this file is concerned: a build with the
   multiplayer files deleted must still boot, and this screen must say so in a
   sentence rather than throw. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.lobby = (function(){
  'use strict';

  /* ui is captured LAZILY inside open() — never at parse time. ui/ui.js may or
     may not have run when this script is parsed, and a stale null captured here
     would be permanent. ui/battle3d.js and ui/room3d.js both do the same. */
  var ui = null;

  var els = {};              // card, head, transport, body, foot, buttons
  var built = false;         // the screen scaffolding exists (head/body/foot)
  var wired = false;         // the capture-phase key listeners are installed
  var bound = false;         // pvp.on(...) subscriptions installed — see subscribe()
  var opened = false;        // the screen is up
  var handoff = false;       // 'start' arrived; closing must not leave the match
  var returnTo = null;       // the screen open() was called from
  var phase = null;          // what render() last drew: 'setup'|'room'|'gone'
  var rosterSig = null;      // shape of the roster the seat rows were built for
  var roomCode = '';         // remembered from host()/join(); see code()
  var nameVal = '';          // survives a phase swap, which rebuilds the field
  var msg = null;            // {text, kind} shown above the buttons
  var msgTimer = null;
  var paintTimer = null;
  var busy = false;          // a host()/join() callback is still outstanding
  var busyAt = 0;            // when it went out — see the watchdog in paint()

  /* DOM cadence, not game tuning: how often the card re-reads engine/pvp.js,
     and how long a status line stays up. The tuning numbers a lobby actually
     has — how many seats, how few can start, how long a code is — are read
     from data/pvp.js by cfg() below, per AGENTS.md rule 7. */
  var PAINT_MS = 500;
  var MSG_MS = 3600;
  /* How long a host()/join() may stay silent before the buttons come back.
     engine/pvp.js owns the real timeout; this only makes sure a callback that
     never arrives leaves a way out, which is engine/records.js's rule ("a slow
     server must never hold up the room") applied to a lobby. */
  var BUSY_MS = 8000;
  var NAME_MAX = 12;         // matches engine/records.js's board names

  /* ---------- the optional siblings ---------- */
  function pvp(){ return (CHLOE.engine && CHLOE.engine.pvp) || null; }
  function net(){ return (CHLOE.engine && CHLOE.engine.net) || null; }
  function room(){ return CHLOE.ui.room3d || null; }

  /* data/pvp.js is a file this build may not have. The fallbacks are what an
     absent data file degrades to, NOT a second set of tuning knobs — when the
     file is present it wins every time. */
  function cfg(key, dflt){
    var d = (CHLOE.data && CHLOE.data.pvp) || null;
    if (!d) return dflt;
    var v = d[key];
    return (v === undefined || v === null) ? dflt : v;
  }
  function maxSeats(){
    var n = Number(cfg('maxPlayers', 8));
    return (n > 0 && n < 64) ? Math.floor(n) : 8;
  }

  /* ---------- the screen div ---------- */
  /* Self-creating, exactly as ui/battle3d.js and ui/room3d.js do it: this file
     ships in the same drop as index.html's tag, and a screen that conjures
     itself is one fewer way for a half-applied integration to be silent. */
  function root(){
    var r = ui.byId('screen-lobby');
    if (!r) {
      r = ui.el('div', 'screen');
      r.id = 'screen-lobby';
      var app = ui.byId('app');
      if (app) app.insertBefore(r, ui.byId('dialog-layer') || null);
      else document.body.appendChild(r);
    }
    return r;
  }

  /* ---------- build (once) ----------
     Head and foot are permanent nodes, so paint() only ever writes textContent
     and toggles classes on them. Only the BODY swaps, and only when the phase
     changes — which is what keeps the name field's caret alive under a 500 ms
     repaint (ui/battle3d.js's refreshHotbar discipline, same reason). */
  function build(){
    built = true;

    els.card = ui.el('div', 'menu-card lobby-card');

    els.head = ui.el('div', 'lobby-head');
    var titles = ui.el('div', 'lobby-titles');
    titles.appendChild(ui.el('div', 'lobby-title', 'The Ring'));
    els.transport = ui.el('div', 'lobby-transport', '');
    titles.appendChild(els.transport);
    els.head.appendChild(titles);
    els.close = ui.el('button', 'lobby-close', '✕');
    els.close.title = 'Close (Esc)';
    els.close.addEventListener('click', function(){ CHLOE.ui.lobby.close(); });
    els.head.appendChild(els.close);

    els.body = ui.el('div', 'menu-body lobby-body');

    els.foot = ui.el('div', 'lobby-foot');
    els.msg = ui.el('div', 'lobby-msg', '');
    els.foot.appendChild(els.msg);
    els.btns = ui.el('div', 'lobby-btns');
    els.readyBtn = ui.el('button', 'lobby-ready', 'Ready');
    els.readyBtn.addEventListener('click', toggleReady);
    els.startBtn = ui.el('button', 'lobby-start', 'Start the Ring');
    els.startBtn.addEventListener('click', doStart);
    els.leaveBtn = ui.el('button', 'lobby-leave', 'Leave');
    els.leaveBtn.addEventListener('click', function(){ CHLOE.ui.lobby.close(); });
    els.btns.appendChild(els.readyBtn);
    els.btns.appendChild(els.startBtn);
    els.btns.appendChild(els.leaveBtn);
    els.foot.appendChild(els.btns);

    els.card.appendChild(els.head);
    els.card.appendChild(els.body);
    els.card.appendChild(els.foot);
  }

  /* ---------- transport ----------
     net.transport() answers BEFORE anything connects, which is the only reason
     this line can be honest on an empty screen. "8 players" means something
     very different on each transport, so the card says which one it is in
     words rather than leaving the player to find out by inviting a friend who
     cannot arrive. */
  function transportNow(){
    var N = net();
    if (!N || typeof N.transport !== 'function') return null;
    try { return N.transport(); } catch (e) { return null; }
  }
  function paintTransport(){
    if (!els.transport) return;
    var t = transportNow();
    var text, kind;
    if (t === 'relay') {
      text = 'Online — players can join from other machines.';
      kind = 'relay';
    } else if (t === 'local') {
      text = 'These tabs only — every player must be another tab in this browser.';
      kind = 'local';
    } else {
      text = 'No transport — this browser offers neither BroadcastChannel nor WebSocket.';
      kind = 'none';
    }
    els.transport.className = 'lobby-transport ' + kind;
    if (els.transport.textContent !== text) els.transport.textContent = text;
  }

  /* ---------- phase ----------
     Derived from engine/pvp.js's own state machine rather than tracked here,
     so a room this screen did not open (a rejoin, a host callback that raced
     the repaint) still lands on the right body. */
  function phaseNow(){
    var P = pvp();
    if (!P || typeof P.state !== 'function') return 'gone';
    var st;
    try { st = P.state(); } catch (e) { return 'gone'; }
    if (st === 'lobby' || st === 'starting') return 'room';
    if (st === 'match' || st === 'dead') return 'match';
    return 'setup';   // 'idle', 'over', or a state a newer pvp.js invented
  }
  function standing(){
    var P = pvp();
    if (!P || typeof P.alive !== 'function') return null;
    try {
      var n = P.alive();
      return (typeof n === 'number') ? n : null;
    } catch (e) { return null; }
  }

  /* ---------- render (phase swap) ---------- */
  function renderInto(node){
    ui = ui || CHLOE.ui;
    if (!ui || !node) return node;
    if (!built) build();
    ui.clear(node).appendChild(els.card);
    renderBody();
    paintTransport();
    paintFoot();
    paintMsg();
    return node;
  }

  function render(){
    if (!ui) return;
    renderInto(root());
  }

  function renderBody(){
    phase = phaseNow();
    var b = ui.clear(els.body);
    /* Everything the old body owned is detached now. Drop the refs with it, so
       nothing paints into a node that is no longer on the page. */
    els.nameIn = els.codeIn = els.roster = els.codeText = els.copyBtn = els.standing = null;
    rosterSig = null;                      // the seat rows just went away
    if (phase === 'gone') { buildGone(b); return; }
    if (phase === 'setup') { buildSetup(b); return; }
    if (phase === 'match') { buildMatch(b); return; }
    buildRoom(b);
  }

  /* The card was opened while a match this client still belongs to is running
     — which is what a player who died and walked back into the hub sees. It is
     NOT a start: handing off from here would drop a spectator into a fight
     they are already out of. So the card states the score and offers the one
     thing still theirs to do. */
  function buildMatch(b){
    b.appendChild(ui.el('div', 'lobby-note',
      'A match is running and you are out of it. The hub keeps the count while ' +
      'the others fight — leaving here drops you from it for good.'));
    els.standing = ui.el('div', 'lobby-standing', '');
    b.appendChild(els.standing);
    paintStanding();
  }
  function paintStanding(){
    if (!els.standing) return;
    var n = standing();
    var t = (n === null) ? '—' : (n + ' still standing');
    if (els.standing.textContent !== t) els.standing.textContent = t;
  }

  /* No engine/pvp.js in this build. One sentence, and the ✕ still works — the
     whole mode is additive, so its absence is a fact to state, not an error. */
  function buildGone(b){
    b.appendChild(ui.el('div', 'lobby-note',
      'The Ring is not installed in this build. The dressing room and the ' +
      'knight ladder are untouched — close this and play on.'));
  }

  function buildSetup(b){
    b.appendChild(ui.el('div', 'lobby-note',
      'Eight fighters, one life each. A kill raises you a level on the spot; ' +
      'dying sends you back to the dressing room while the others fight on.'));

    var field = ui.el('div', 'lobby-field');
    field.appendChild(ui.el('label', null, 'Your name'));
    els.nameIn = document.createElement('input');
    els.nameIn.type = 'text';
    els.nameIn.maxLength = NAME_MAX;
    els.nameIn.placeholder = 'who they will read on the feed';
    els.nameIn.setAttribute('autocomplete', 'off');
    els.nameIn.value = nameVal || defaultName();
    els.nameIn.addEventListener('input', function(){ nameVal = els.nameIn.value; });
    field.appendChild(els.nameIn);
    b.appendChild(field);

    var split = ui.el('div', 'lobby-split');

    var left = ui.el('div', 'lobby-half');
    var hostBtn = ui.el('button', 'lobby-host', 'Open a Ring');
    hostBtn.addEventListener('click', doHost);
    left.appendChild(hostBtn);
    left.appendChild(ui.el('div', 'lobby-hint', 'You host. Share the code you get.'));
    split.appendChild(left);

    split.appendChild(ui.el('div', 'lobby-or', 'or'));

    var right = ui.el('div', 'lobby-half');
    var joinRow = ui.el('div', 'lobby-joinrow');
    els.codeIn = document.createElement('input');
    els.codeIn.type = 'text';
    els.codeIn.className = 'lobby-codein';
    els.codeIn.maxLength = Math.max(1, Number(cfg('roomCodeLen', 4)) || 4);
    els.codeIn.placeholder = 'CODE';
    els.codeIn.setAttribute('autocomplete', 'off');
    /* Uppercased as it is typed rather than on submit: the code the player is
       reading off a friend's screen and the code in the box have to look like
       the same thing, or a rejected join reads as "the code is wrong". */
    els.codeIn.addEventListener('input', function(){
      var up = cleanCode(els.codeIn.value);
      if (els.codeIn.value !== up) els.codeIn.value = up;
    });
    joinRow.appendChild(els.codeIn);
    var joinBtn = ui.el('button', 'lobby-join', 'Join');
    joinBtn.addEventListener('click', doJoin);
    joinRow.appendChild(joinBtn);
    right.appendChild(joinRow);
    right.appendChild(ui.el('div', 'lobby-hint', 'Someone already opened one.'));
    split.appendChild(right);

    b.appendChild(split);
  }

  function buildRoom(b){
    var row = ui.el('div', 'lobby-code-row');
    row.appendChild(ui.el('div', 'lobby-code-label', 'Room code'));
    /* A <code> element, and .lobby-code carries user-select:text in game.css.
       Both matter: the global body{user-select:none} would otherwise make this
       string impossible to drag over, and an unselectable room code is a
       multiplayer mode nobody can be invited to. */
    els.codeText = ui.el('code', 'lobby-code', code() || '····');
    row.appendChild(els.codeText);
    els.copyBtn = ui.el('button', 'lobby-copy', 'Copy');
    els.copyBtn.addEventListener('click', copyCode);
    row.appendChild(els.copyBtn);
    b.appendChild(row);

    els.roster = ui.el('div', 'lobby-roster');
    b.appendChild(els.roster);
    paintRoster();
  }

  /* ---------- roster ---------- */
  function rosterRows(){
    var P = pvp();
    if (!P || typeof P.roster !== 'function') return [];
    var rows;
    try { rows = P.roster(); } catch (e) { return []; }
    return (rows && typeof rows.length === 'number') ? rows : [];
  }

  /* Everything the seat rows DRAW, in one string. The rows are rebuilt only
     when this changes — refreshHotbar's discipline, and the reason a 500 ms
     repaint does not fight the browser for eight divs it already has. */
  function sigOf(rows, max){
    var out = [max];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      out.push([r.id, r.name, r.seat, r.level, r.kills,
                r.ready ? 1 : 0, r.alive === false ? 0 : 1,
                r.isMe ? 1 : 0, r.isHost ? 1 : 0].join(':'));
    }
    return out.join('|');
  }

  function paintRoster(){
    if (!els.roster) return;
    var rows = rosterRows(), max = maxSeats();
    var sig = sigOf(rows, max);
    if (sig === rosterSig) return;
    rosterSig = sig;

    var host = ui.clear(els.roster);
    var i;
    for (i = 0; i < rows.length && i < max; i++) host.appendChild(seatRow(rows[i], i));
    /* The empty seats are drawn, not omitted. "3 of 8" is a number; five dim
       rows under three lit ones is the same fact you can read at a glance
       while you are deciding whether to wait for anyone else. */
    for (; i < max; i++) host.appendChild(emptyRow());
  }

  function seatRow(r, i){
    r = r || {};
    var seat = (typeof r.seat === 'number') ? r.seat : i;
    var cls = 'lobby-seat';
    if (r.isMe) cls += ' me';
    if (r.ready) cls += ' ready';
    if (r.alive === false) cls += ' out';
    var row = ui.el('div', cls);

    /* Identity is the seat TINT, the same colour data/pvp.js hands the body in
       the arena — so the name you read here is the body you are looking at
       there. Read from data, so it is never a palette colour invented in a UI
       file. */
    var dot = ui.el('i', 'seat-dot');
    var col = seatColor(seat);
    if (col) dot.style.background = col;
    row.appendChild(dot);

    row.appendChild(ui.el('span', 'nm', String(r.name || 'fighter')));
    if (r.isHost) row.appendChild(ui.el('span', 'tag host', 'HOST'));
    if (r.isMe) row.appendChild(ui.el('span', 'tag you', 'YOU'));
    if (typeof r.level === 'number') row.appendChild(ui.el('span', 'lv', 'Lv ' + r.level));
    /* A tick that is always present, lit or dim. A tick that appears and
       disappears makes the row jump, and a row that jumps while people are
       readying up is the one thing a lobby must not do. */
    row.appendChild(ui.el('span', 'tick', r.ready ? '✓' : '·'));
    return row;
  }

  function emptyRow(){
    var row = ui.el('div', 'lobby-seat empty');
    row.appendChild(ui.el('i', 'seat-dot'));
    row.appendChild(ui.el('span', 'nm', 'empty'));
    row.appendChild(ui.el('span', 'tick', '·'));
    return row;
  }

  function seatColor(seat){
    var list = cfg('colors', null);
    if (!list || typeof list.length !== 'number') return null;
    var v = list[seat];
    if (typeof v === 'string' && v) return v;
    if (typeof v !== 'number') return null;
    return '#' + ('00000' + (v >>> 0).toString(16)).slice(-6);
  }

  /* ---------- foot ---------- */
  function me(){
    var P = pvp();
    if (!P || typeof P.me !== 'function') return null;
    try { return P.me() || null; } catch (e) { return null; }
  }
  function isHost(){
    var P = pvp();
    if (!P || typeof P.isHost !== 'function') return false;
    try { return !!P.isHost(); } catch (e) { return false; }
  }
  function canStart(){
    var P = pvp();
    if (!P || typeof P.canStart !== 'function') return false;
    try { return !!P.canStart(); } catch (e) { return false; }
  }
  function myRow(){
    var rows = rosterRows();
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].isMe) return rows[i];
    return null;
  }

  function paintFoot(){
    var inRoom = (phase === 'room'), inMatch = (phase === 'match');
    /* In a running match the only button left is Leave: Ready means nothing
       once the Ring is open, and Start would be a second fight. */
    if (els.btns) els.btns.classList.toggle('hidden', !inRoom && !inMatch);
    if (els.readyBtn) els.readyBtn.classList.toggle('hidden', !inRoom);
    if (els.startBtn) els.startBtn.classList.toggle('hidden', !inRoom || !isHost());
    if (!inRoom) return;

    var mine = myRow();
    var ready = !!(mine && mine.ready);
    els.readyBtn.textContent = ready ? 'Ready ✓' : 'Ready';
    els.readyBtn.classList.toggle('on', ready);

    /* The Start button exists only for the host (hidden above), and only
       LIGHTS when pvp.canStart() says so — the roster rule (enough players,
       everyone ready) lives in the engine and is never re-derived here,
       because two copies of "can we start" is two answers the moment one of
       them ages. */
    els.startBtn.disabled = !canStart();
  }

  /* ---------- messages ---------- */
  function note(text, kind){
    clearMsgTimer();
    msg = text ? { text: text, kind: kind || '' } : null;
    paintMsg();
    if (!text) return;
    msgTimer = window.setTimeout(function(){
      msgTimer = null;
      msg = null;
      if (opened) paintMsg();
    }, MSG_MS);
  }
  function clearMsgTimer(){
    if (msgTimer) { window.clearTimeout(msgTimer); msgTimer = null; }
  }
  function paintMsg(){
    if (!els.msg) return;
    var text = msg ? msg.text : '';
    if (els.msg.textContent !== text) els.msg.textContent = text;
    els.msg.className = 'lobby-msg ' + (msg ? (msg.kind || '') : '');
  }
  /* An error can arrive as a string, an Error, or a {message}/{error} bag
     depending on which transport failed. Take every shape rather than printing
     "[object Object]" at the one moment the player needs a sentence. */
  function errText(e){
    if (!e) return 'That did not work.';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    if (e.error) return String(e.error);
    if (e.reason) return String(e.reason);
    return 'That did not work.';
  }

  /* ---------- names and codes ---------- */
  function defaultName(){
    var party = (CHLOE.engine && CHLOE.engine.party) || null;
    var m = (party && typeof party.active === 'function') ? party.active() : null;
    if (!m) return '';
    var def = ((CHLOE.data && CHLOE.data.characters) || {})[m.id] || {};
    return String(def.name || m.id || '');
  }
  /* engine/records.js already owns this game's name-scrubbing rule (control
     chars, markup, whitespace, 12 chars) and exports it. Borrowing it beats a
     second copy that drifts the day someone tightens one of them. */
  function cleanName(raw){
    var rec = CHLOE.engine && CHLOE.engine.records;
    if (rec && typeof rec.sanitiseName === 'function') {
      try { return rec.sanitiseName(raw); } catch (e) {}
    }
    return String(raw || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ')
                            .trim().slice(0, NAME_MAX).trim();
  }
  function cleanCode(raw){
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function playerName(){
    var n = cleanName(els.nameIn ? els.nameIn.value : nameVal);
    if (!n) {
      /* Empty is refused rather than defaulted, exactly as the record board
         refuses it: a kill feed of anonymous fighters is worse than a lobby
         that asked once. */
      note('Type a name — 1 to ' + NAME_MAX + ' characters.', 'bad');
      try { els.nameIn.focus(); } catch (e) {}
      return null;
    }
    nameVal = n;
    return n;
  }
  /* The code the player has to read out. Remembered from the host/join
     callback, but also asked of pvp.debug() so a rejoin — or a pvp.js that
     hands the code back some other way — still shows something real. */
  function code(){
    if (roomCode) return roomCode;
    var P = pvp();
    if (P && typeof P.debug === 'function') {
      try {
        var d = P.debug() || {};
        var c = d.code || d.roomCode || d.room;
        if (c) return String(c).toUpperCase();
      } catch (e) {}
    }
    return '';
  }

  /* ---------- actions ---------- */
  function doHost(){
    var P = pvp();
    if (!P || typeof P.host !== 'function') { note('The Ring is not installed in this build.', 'bad'); return; }
    if (busy) return;
    var n = playerName();
    if (!n) return;
    busy = true; busyAt = Date.now();
    note('Opening a room…', '');
    try {
      P.host(n, function(err, c){
        busy = false;
        if (err) { note(errText(err), 'bad'); paint(); return; }
        roomCode = cleanCode(c);
        note('Share the code. Start lights up when everyone is ready.', 'good');
        render();
      });
    } catch (e) {
      busy = false;
      note('The room refused to open.', 'bad');
      paint();
    }
  }

  function doJoin(){
    var P = pvp();
    if (!P || typeof P.join !== 'function') { note('The Ring is not installed in this build.', 'bad'); return; }
    if (busy) return;
    var n = playerName();
    if (!n) return;
    var c = cleanCode(els.codeIn ? els.codeIn.value : '');
    if (!c) {
      note('Type the code you were given.', 'bad');
      try { els.codeIn.focus(); } catch (e) {}
      return;
    }
    busy = true; busyAt = Date.now();
    note('Knocking…', '');
    try {
      P.join(c, n, function(err, info){
        busy = false;
        if (err) { note(errText(err), 'bad'); paint(); return; }
        roomCode = cleanCode((info && (info.code || info.room)) || c);
        note('You are in. Press Ready.', 'good');
        render();
      });
    } catch (e) {
      busy = false;
      note('That room would not open.', 'bad');
      paint();
    }
  }

  function toggleReady(){
    var P = pvp();
    if (!P || typeof P.setReady !== 'function') return;
    var mine = myRow();
    try { P.setReady(!(mine && mine.ready)); } catch (e) {}
    paint();
  }

  function doStart(){
    var P = pvp();
    if (!P || typeof P.start !== 'function') return;
    if (!canStart()) return;              // the button is disabled too; belt and braces
    try { P.start(); } catch (e) { note('The Ring would not open.', 'bad'); }
    /* No handoff here: the host takes the same 'start' event off the wire that
       every other seat does, so one code path opens the arena for everybody. */
  }

  function copyCode(){
    var n = els.codeText;
    if (!n) return;
    var ok = false;
    try {
      /* execCommand, not navigator.clipboard: the clipboard API is Promise-
         based and there are no Promises in game/. The selection is left in
         place either way, so a browser that refuses the copy still hands the
         player a highlighted code and a Ctrl+C. This only works because
         .lobby-code overrides the global body{user-select:none}. */
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(n);
      sel.removeAllRanges();
      sel.addRange(range);
      ok = !!document.execCommand('copy');
    } catch (e) { ok = false; }
    note(ok ? 'Code copied.' : 'Code selected — press Ctrl+C.', ok ? 'good' : '');
  }

  /* ---------- the match starts ---------- */
  /* engine/pvp.js must never reach into ui/, so the lobby is the one module
     that turns 'start' into a fight. It hands the fight to ui/room3d.js rather
     than straight to the arena, because the room owns the flag that brings a
     dead player back to the dressing room afterwards. */
  function startOpts(){
    var mine = me() || myRow() || {};
    var rows = rosterRows();
    return {
      seat: (typeof mine.seat === 'number') ? mine.seat : 0,
      players: rows.length,
      roster: rows,
      code: code()
    };
  }

  function handOff(o){
    var r = room();
    if (r && typeof r.pvpEngage === 'function') {
      try { if (r.pvpEngage(o)) return true; } catch (e) {}
    }
    /* No room around (a test harness, or a build without room3d): go straight
       to the arena. A fallback, not the normal path — a fight entered this way
       has nothing holding the hub's return flag. */
    var b = CHLOE.ui.battle3d;
    if (b && typeof b.beginPvp === 'function') {
      try { b.beginPvp(o); return true; } catch (e) {}
    }
    return false;
  }

  /* Only ever from the lobby we were SITTING in. A card opened on top of an
     already-running match must never hand off — that is a spectator, and
     re-entering the arena would put a dead player back on the floor. */
  function onStart(){
    if (!opened || handoff || phase !== 'room') return;
    handoff = true;
    var o = startOpts();
    shut(false);                          // hide, but do NOT leave the match
    if (handOff(o)) return;
    if (ui && ui.toast) ui.toast('The Ring has no arena in this build.');
    if (ui && ui.current() === 'lobby') ui.show(returnTo || 'room3d');
  }

  /* ---------- engine subscriptions ----------
     pvp.on() has no off() in the contract, so we subscribe exactly ONCE for
     the page's life and make every handler a no-op while the screen is down.
     `bound` is therefore never cleared — that is the point of it. */
  function subscribe(){
    var P = pvp();
    if (bound || !P || typeof P.on !== 'function') return;
    bound = true;
    var evts = ['roster', 'peer', 'error', 'start', 'over', 'died', 'kill'];
    for (var i = 0; i < evts.length; i++) hook(P, evts[i]);
  }
  function hook(P, evt){
    try {
      P.on(evt, function(data){
        if (!opened) return;
        if (evt === 'start') { onStart(); return; }
        if (evt === 'error') { note(errText(data), 'bad'); return; }
        paint();
      });
    } catch (e) {
      /* A pvp.js with a different on() shape: no subscription, and the paint
         timer below is exactly the fallback that makes that survivable. */
    }
  }

  /* ---------- input ---------- */
  function wire(){
    if (wired) return;
    wired = true;
    /* CAPTURE phase on purpose, the same call ui/shop.js makes and for the
       same reason: ui/room3d.js's M / Tab handler is a BUBBLE-phase listener
       on document that knows nothing about this screen. Capture runs first,
       which is what makes stopPropagation mean anything at all. */
    document.addEventListener('keydown', onKeyDown, true);
    /* keyup and keypress too — engine/records.js's name modal swallows the
       same three. A keyup that reaches the world is a movement key released,
       and a name with a 'w' in it would otherwise walk the player into a wall
       behind the card. */
    document.addEventListener('keyup', swallow, true);
    document.addEventListener('keypress', swallow, true);
  }
  function swallow(e){ if (opened) e.stopPropagation(); }
  function onKeyDown(e){
    if (!opened) return;
    e.stopPropagation();
    var k = e.key;
    if (k === 'Escape' || k === 'Esc') {
      e.preventDefault();
      CHLOE.ui.lobby.close();             // the public export — see ui/shop.js's §22 note
      return;
    }
    if (k === 'Enter') {
      if (els.codeIn && e.target === els.codeIn) { e.preventDefault(); doJoin(); }
      else if (els.nameIn && e.target === els.nameIn) { e.preventDefault(); doHost(); }
      return;
    }
    /* Tab is deliberately NOT preventDefault-ed: it is the keyboard route
       between the name field, the code field and the buttons. Stopping its
       propagation is enough — room3d's Tab handler already returns when the
       router is not on 'room3d'. */
  }

  /* ---------- the world behind the screen ----------
     Half of ui/shop.js's pair, on purpose. shop.js is an overlay and has to
     restart the room itself; this is a screen, so the room restarts through
     its own onShow when we ui.show() back to it. Calling _resume() from here
     as well would start the render loop twice. */
  function pauseWorld(){
    var r = room();
    if (r && typeof r._pause === 'function') { try { r._pause(); } catch (e) {} return; }
    var w = CHLOE.engine && CHLOE.engine.world3d;
    if (w && typeof w.stop === 'function') { try { w.stop(); } catch (e) {} }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  }

  /* ---------- open / close ---------- */
  function open(){
    ui = CHLOE.ui;
    if (!ui) return;
    if (opened) return;
    if (!built) build();
    wire();
    subscribe();

    handoff = false;
    var cur = ui.current();
    returnTo = (cur && cur !== 'lobby') ? cur : 'room3d';

    /* A finished match leaves engine/pvp.js in 'over', and host()/join() only
       accept 'idle' — so without this the first press after a deathmatch is
       answered with "you are already in a lobby". Let the dead session go
       before the form is drawn. */
    var P = pvp();
    if (P && typeof P.state === 'function' && typeof P.leave === 'function') {
      var st0 = null;
      try { st0 = P.state(); } catch (e) {}
      if (st0 === 'over') { try { P.leave(); } catch (e) {} }
    }

    /* Stop the room before the screen paints, exactly as room3d.openMenu and
       shop.open do — the router would get there within a poll tick anyway, but
       a render loop that keeps eating the mouse for 120 ms while a text field
       is asking for focus is the sort of thing nobody can reproduce later. */
    pauseWorld();

    if (!nameVal) nameVal = defaultName();
    msg = null;
    clearMsgTimer();
    opened = true;
    phase = null;
    render();
    ui.show('lobby');
    if (!paintTimer) paintTimer = window.setInterval(paint, PAINT_MS);
    try { if (els.nameIn) els.nameIn.focus(); } catch (e) {}
  }

  /* The player walking away: leave the room, then hand the router back. */
  function close(){ shut(true); }

  function shut(leave){
    if (!opened) return;
    opened = false;
    if (paintTimer) { window.clearInterval(paintTimer); paintTimer = null; }
    clearMsgTimer();
    msg = null;
    busy = false;

    if (leave) {
      var P = pvp();
      if (P && typeof P.leave === 'function') { try { P.leave(); } catch (e) {} }
      roomCode = '';
    }

    var r = ui && ui.byId('screen-lobby');
    if (r) r.classList.remove('active');
    /* On the handoff path battle3d shows its own screen a moment from now, so
       routing here would flash the room and start its loop for one frame. */
    if (!leave) return;
    if (ui && ui.current() === 'lobby') ui.show(returnTo || 'room3d');
  }

  function isOpen(){ return opened; }

  /* ---------- the cheap repaint ----------
     Everything that is not a phase swap: the transport line, the seat rows
     (rebuilt only on a signature change), the Ready/Start state and the
     message. Runs on every engine event AND on a slow timer, so a sibling that
     forgets to emit costs half a second of staleness rather than a lobby that
     never lights its Start button. */
  function paint(){
    if (!opened || !ui) return;
    /* A host()/join() whose callback never came. Hand the buttons back rather
       than leaving the player pressing a dead card — see BUSY_MS. */
    if (busy && (Date.now() - busyAt) > BUSY_MS) {
      busy = false;
      note('No answer. Try again.', 'bad');
    }
    var want = phaseNow();
    /* The lobby we were waiting in just started and we never saw the event —
       treat it as one rather than sitting on a roster over a running fight.
       Only from 'room': see onStart(). */
    if (want === 'match' && phase === 'room') { onStart(); return; }
    if (want !== phase) { render(); return; }
    paintTransport();
    if (phase === 'match') paintStanding();
    if (phase === 'room') {
      if (els.codeText) {
        var c = code() || '····';
        if (els.codeText.textContent !== c) els.codeText.textContent = c;
      }
      paintRoster();
    }
    paintFoot();
    paintMsg();
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    renderInto: renderInto,
    /* exposed for tests/debugging */
    _paint: paint,
    _phase: function(){ return phase; },
    _transport: transportNow
  };
})();
