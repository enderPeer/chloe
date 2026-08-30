/* CHLOE — ui/room3d.js  (Room3D — first-person mode, spec sec 13 + 14)
   Owns the #screen-room3d div + HUD: full-viewport canvas, center crosshair
   (red + "CLICK TO ENGAGE" when the enemy is hovered in range; white +
   "TV — click to turn on/off" when the TV is hovered, "◀ THE CHURCH" on the
   stage board's picker arrows (§26), or "open the giftbox" on §27's shop box
   — enemy wins, then the TV, then the board, then the box),
   top bar (shards / active char level / Menu — reuses the .hud style),
   bottom control-hints line, and the lock overlay shown while the pointer
   is not locked. All Three.js logic lives in CHLOE.engine.world3d; this file
   only wires: show -> init+start, engage -> battle, battle end -> back here,
   M/Tab -> menu overlay (pause + release lock; resume on close).
   Renders/wires ONLY — no world rules, no battle rules.

   §32 adds the hub's half of the deathmatch: a door into ui/lobby.js, a
   "N still standing" line in the top bar for a player watching from here after
   being eliminated, and a THIRD branch in onBattleEnd that takes a dead
   fighter back without ending their run. See inPvp below for why that is a
   separate flag and not the one above it. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.room3d = (function(){
  'use strict';
  var ui, party;
  var els = {};              // canvas, crosshair, hint, overlay, shards, level
  var inited = false;        // world3d.init(canvas) done
  var wired = false;         // one-time wraps + listeners done
  var running = false;       // we believe the world loop is running
  var inBattle = false;      // battle engaged from the room is in progress
  /* §32: a PvP match is running and WE are still in it. Deliberately NOT
     inBattle: poll() early-returns on that flag, so reusing it would freeze
     the crosshair, the hint caption, the lock overlay and the shards/level bar
     for the whole match — including the stretch after you die, which is
     exactly when the hub has something to show you. This flag is read in only
     two places (the scene.onBattleEnd wrapper, and the handoff guard) and is
     cleared the moment the match hands us back. */
  var inPvp = false;
  var pollTimer = null;
  var respawnTimer = null;
  var warned = false;
  var ENGAGE_RANGE = 3.5;    // meters (spec sec 13)
  var TV_RANGE = 2.5;        // meters (spec sec 14)
  var RESPAWN_MS = 15000;
  var cbHover = null;        // last hover kind from world3d.onHover: 'enemy'|'tv'|null

  function world(){ return (CHLOE.engine && CHLOE.engine.world3d) || null; }
  /* §32: optional in every build. Every read of it is guarded, so a checkout
     with the multiplayer files deleted gets exactly today's dressing room. */
  function pvp(){ return (CHLOE.engine && CHLOE.engine.pvp) || null; }
  function enemyId(){
    var cfg = CHLOE.data && CHLOE.data.room3d;
    return (cfg && cfg.enemy && (cfg.enemy.id || cfg.enemy.enemyId)) || 'the_hollow';
  }

  function root(){
    var r = CHLOE.ui.byId('screen-room3d');
    if (!r) { // defensive: create the screen div if index.html lacks it
      r = CHLOE.ui.el('div', 'screen');
      r.id = 'screen-room3d';
      var app = CHLOE.ui.byId('app');
      var dlg = CHLOE.ui.byId('dialog-layer');
      if (app) app.insertBefore(r, dlg || null);
      else document.body.appendChild(r);
    }
    return r;
  }

  /* ---------- build (once) ---------- */
  function build(){
    var r = ui.clear(root());

    els.canvas = document.createElement('canvas');
    els.canvas.id = 'room3d-canvas';
    r.appendChild(els.canvas);

    // soft vignette over the scene (atmosphere, spec sec 13)
    r.appendChild(ui.el('div', 'r3d-vignette'));

    // top bar — same .hud styling as the 2D scene
    var hud = ui.el('div', 'hud r3d-hud');
    els.shards = ui.el('div', 'hud-shards', '◆ 0');
    hud.appendChild(els.shards);
    /* §32: the deathmatch score, for a player watching from the hub after
       being eliminated. Third child of the .hud flex row, so space-between
       lands it in the middle; .hidden is display:none, so when no match is
       running it is out of the layout entirely and the bar reads as it does
       today. */
    els.standing = ui.el('div', 'r3d-standing hidden', '');
    hud.appendChild(els.standing);
    var right = ui.el('div', 'hud-right');
    els.level = ui.el('div', 'r3d-level', '');
    right.appendChild(els.level);
    /* §32: the door into the lobby. Appended only when ui/lobby.js actually
       shipped — with the multiplayer files removed the top bar keeps exactly
       the two controls it has today, rather than growing a dead button. */
    if (CHLOE.ui.lobby && typeof CHLOE.ui.lobby.open === 'function') {
      var ringBtn = ui.el('button', 'r3d-ring', '⚔ The Ring');
      ringBtn.title = 'Deathmatch — up to eight fighters, one life each';
      ringBtn.addEventListener('click', openLobby);
      right.appendChild(ringBtn);
    }
    var menuBtn = ui.el('button', null, '☰ Menu');
    menuBtn.addEventListener('click', openMenu);
    right.appendChild(menuBtn);
    hud.appendChild(right);
    r.appendChild(hud);

    // center crosshair dot + interaction hint (enemy / TV)
    els.crosshair = ui.el('div', 'r3d-crosshair');
    r.appendChild(els.crosshair);
    els.hint = ui.el('div', 'r3d-hint hidden', 'CLICK TO ENGAGE');
    r.appendChild(els.hint);

    // bottom control hints
    els.controls = ui.el('div', 'r3d-controls',
      'WASD move · mouse look · Space jump · Ctrl or C crouch · clicks close your hands here — your binds fire in the arena · M menu');
    r.appendChild(els.controls);

    // lock overlay (informational — clicks pass through to the canvas,
    // which requests pointer lock; keyboard fallback works without it)
    els.overlay = ui.el('div', 'r3d-lock-overlay');
    var card = ui.el('div', 'r3d-lock-card');
    card.appendChild(ui.el('div', 'r3d-lock-title', 'The Dressing Room'));
    card.appendChild(ui.el('div', 'r3d-lock-line',
      'Click to look around · WASD move · Space jump · Ctrl or C crouch · ESC release · M menu'));
    els.overlayLine = card.lastChild;
    els.overlay.appendChild(card);
    r.appendChild(els.overlay);
  }

  function refreshHud(){
    if (els.shards) els.shards.textContent = '◆ ' + (party.state.shards || 0);
    if (els.level) {
      var m = party.active();
      if (m) {
        var def = (CHLOE.data.characters || {})[m.id] || {};
        els.level.textContent = (def.name || m.id) + ' · Lv ' + m.level;
      } else {
        els.level.textContent = '';
      }
    }
    paintStanding();
  }

  /* ---------- §32 spectator line ----------
     How many fighters are still up, read straight from engine/pvp.js on every
     repaint. A cached count goes stale the instant somebody else falls, and a
     spectator who cannot see the score is just watching an empty room. Returns
     null — meaning "say nothing" — whenever no match is live, which is every
     frame of a normal PvE night. */
  function pvpStanding(){
    var P = pvp();
    if (!P || typeof P.state !== 'function' || typeof P.alive !== 'function') return null;
    var st, n;
    try { st = P.state(); n = P.alive(); } catch (e) { return null; }
    if (st !== 'match' && st !== 'starting' && st !== 'dead') return null;
    return (typeof n === 'number' && n >= 0) ? n : null;
  }
  function paintStanding(){
    if (!els.standing) return;
    var n = pvpStanding();
    els.standing.classList.toggle('hidden', n === null);
    if (n === null) return;
    var t = '⚔ ' + n + ' still standing';
    if (els.standing.textContent !== t) els.standing.textContent = t;
  }

  /* ---------- pointer lock state ---------- */
  function isLocked(){
    var w = world();
    if (w && typeof w.debug === 'function') {
      try {
        var d = w.debug();
        if (d && typeof d.locked === 'boolean') return d.locked;
      } catch (e) {}
    }
    return document.pointerLockElement === els.canvas;
  }

  /* ---------- HUD poll (crosshair, hint, overlay, HUD, screen watch) ---------- */
  // world3d hover info distinguishes enemy vs TV (spec sec 14); the debug()
  // fields and the onHover callback are both consulted so either engine
  // shape works. Enemy takes priority when both are hovered.
  function tvHovered(d){
    if (cbHover === 'tv') return true;
    if (!d) return false;
    if (d.tvHover === true || d.hoverTv === true) return true;
    if (d.hover === 'tv' || d.hoverTarget === 'tv') return true;
    if (typeof d.tvDist === 'number' && d.tvDist <= TV_RANGE) return true;
    return false;
  }
  /* "◀ THE RING" — the arrow under the crosshair and the floor it hands
     you. A board that only said "click" would make you click to find out
     what you were choosing, which is the one thing a picker must not do. */
  function stageArrowLabel(a){
    var mark = a.which === 'left' ? '◀' : '▶';
    return a.name ? (mark + ' ' + String(a.name).toUpperCase())
                  : (mark + ' ANOTHER FLOOR');
  }
  function setHint(kind, label){ // 'enemy' | 'tv' | 'item' | 'stage' | 'gift' | 'door' | null
    if (els.crosshair) {
      els.crosshair.classList.toggle('in-range', kind === 'enemy' || kind === 'item');
      /* §26/§27D: the board's arrows and the giftbox borrow the TV's white
         crosshair — all three are things you PRESS, none is something you
         fight, and the red reticle is reserved for what you can attack. */
      els.crosshair.classList.toggle('tv-range',
        kind === 'tv' || kind === 'stage' || kind === 'gift' || kind === 'door');
    }
    if (els.hint) {
      els.hint.classList.toggle('hidden', !kind);
      els.hint.classList.toggle('tv', kind === 'tv' || kind === 'stage' || kind === 'gift' || kind === 'door');
      if (kind) {
        /* §27D names the ACTION, not the object: "the giftbox" alone leaves
           you to guess whether it opens, is taken, or is kicked — and the box
           is the only way to spend Shards, so a player who never guesses
           never finds the shop. */
        var text = kind === 'tv' ? 'TV — click to turn on/off'
                 : (kind === 'item' ? ('take the ' + (label || 'item'))
                 : (kind === 'stage' ? (label || 'change the floor')
                 : (kind === 'gift' ? 'open ' + (label || 'the giftbox') + ' — the shop'
                 : (kind === 'door' ? 'Open the door — face your reflection'
                 : 'CLICK TO ENGAGE'))));
        if (els.hint.textContent !== text) els.hint.textContent = text;
      }
    }
  }
  function poll(){
    // left the screen through a path we don't control (e.g. logout) — halt
    if (ui.current() !== 'room3d') { pause(); return; }
    if (inBattle) return;

    var w = world();
    var d = null;
    if (w && typeof w.debug === 'function') {
      try { d = w.debug(); } catch (e) {}
    }
    // world3d only fires engage when the crosshair RAY hits the enemy mesh, so
    // the hint must follow the real aim signal (cbHover), not distance alone —
    // otherwise "CLICK TO ENGAGE" shows while clicks do nothing.
    var enemyHover = cbHover === 'enemy' && !!(d && d.enemyAlive) &&
                     !(typeof d.enemyDist === 'number' && d.enemyDist > ENGAGE_RANGE);
    /* §26: the stage board's picker arrows. The engine publishes which one
       is under the crosshair AND the floor it would pick, so the hint names
       the stage rather than saying "click". They outrank a pickup for the
       same reason they do in the engine — you are standing at the wall. */
    var arrow = (!enemyHover && !tvHovered(d) && d) ? d.stageArrow : null;
    /* §27D: the shop giftbox. world3d ranks it enemy -> TV -> board -> box in
       BOTH click paths, so the hint is ranked the same way — a prompt that
       named a target the click would not act on is worse than no prompt. */
    var gift = (!enemyHover && !tvHovered(d) && !arrow && d) ? d.giftHover : null;
    // §16: a glinting item under the crosshair — enemy, TV, board and box first
    var pk = (!enemyHover && !tvHovered(d) && !arrow && !gift && d) ? d.pickupHover : null;
    var doorH = (!enemyHover && !tvHovered(d) && !arrow && !gift && !pk && d && d.doorHover);
    setHint(enemyHover ? 'enemy'
          : (tvHovered(d) ? 'tv'
          : (doorH ? 'door'
          : (arrow ? 'stage' : (gift ? 'gift' : (pk ? 'item' : null))))),
            arrow ? stageArrowLabel(arrow) : (gift ? gift.label : (pk && pk.label)));
    if (els.overlay) els.overlay.classList.toggle('hidden', isLocked());
    refreshHud();
  }

  /* ---------- start/stop ---------- */
  function ensureInit(){
    var w = world();
    if (!w) {
      if (!warned) {
        warned = true;
        console.warn('[CHLOE] engine/world3d.js not loaded — the room stays dark.');
        if (els.overlayLine) els.overlayLine.textContent = 'The room is still being built...';
      }
      return false;
    }
    if (!inited) {
      try {
        w.init(els.canvas);
        if (typeof w.onEngage === 'function') w.onEngage(engage);
        if (typeof w.onHover === 'function') w.onHover(onWorldHover);
        if (typeof w.onDoor === 'function') w.onDoor(onDoorOpen);
        /* §27D: the box publishes its own hover edge rather than joining
           onHover's (enemy, dist, tv) signature. Nothing is stored from it —
           poll() still reads debug().giftHover, the single source — this only
           wakes the HUD on the edge so the prompt does not trail the aim. */
        if (typeof w.onGiftHover === 'function') {
          w.onGiftHover(function(){
            if (ui && ui.current() === 'room3d' && !inBattle) poll();
          });
        }
        if (typeof w.onPickup === 'function') {
          w.onPickup(function(itemId, label){
            var item = (CHLOE.data.items || {})[itemId];
            if (!item) return;
            CHLOE.engine.inventory.add(itemId, 1);
            ui.toast('Taken: ' + (item.icon ? item.icon + ' ' : '') + (item.name || label));
          });
        }
        inited = true;
      } catch (e) {
        console.warn('[CHLOE] world3d.init failed', e);
        return false;
      }
    }
    return true;
  }

  /* world3d hover callback — v2 passes a target kind ('enemy'|'tv') either as
     an extra arg or an object; v1 passed (hovering, dist) for the enemy only.
     Accept every shape, remember the kind, and refresh the HUD right away. */
  function onWorldHover(a, b, c){
    var hovering, kind = null;
    if (a && typeof a === 'object') {
      hovering = (a.hovering !== undefined) ? !!a.hovering : !!a.hover;
      kind = a.kind || a.target || null;
    } else {
      hovering = !!a;
      if (typeof c === 'string') kind = c;
      else if (typeof b === 'string') kind = b;
      // engine v2 shape: (enemyHovered:bool, enemyDist:number, tvHovered:bool)
      else if (c === true && !hovering) { hovering = true; kind = 'tv'; }
    }
    cbHover = hovering ? (kind || 'enemy') : null;
    if (ui && ui.current() === 'room3d' && !inBattle) poll();
  }

  function resume(){
    if (!ensureInit()) return;
    var w = world();
    try { if (typeof w.resize === 'function') w.resize(); }
    catch (e) { console.warn('[CHLOE] world3d.resize failed', e); }

    /* §21: hold the room behind the loading gate until its models are in and
       its shaders are compiled. Walking into a half-built room - furniture
       popping in around you, the first turn of the head stuttering - was the
       worst first impression the game made. */
    var load = CHLOE.ui.loading;
    if (load && w.assetsReady && !w.assetsReady() && !load.isShown()) {
      load.show('Waking the room…');
      load.waitFor(
        function () { return w.assetsReady(); },
        function (setProgress) {
          var pr = w.assetProgress ? w.assetProgress() : null;
          if (pr) setProgress(pr.done, pr.total + 1,
            pr.done >= pr.total ? 'Turning on the lights…' : 'Waking the room…');
        },
        function () {
          load.hide();
          // the router may have moved on while we waited
          if (ui && ui.current() === 'room3d' && !inBattle) startRoom();
        }
      );
      return;
    }
    startRoom();
  }

  /* The room is on screen and ready: start the loop and let the player move. */
  function startRoom(){
    var w = world();
    try {
      w.start();
      running = true;
    } catch (e) { console.warn('[CHLOE] world3d.start failed', e); }
    if (!pollTimer) pollTimer = window.setInterval(poll, 120);
    poll();
  }

  function pause(){
    var w = world();
    if (w && running) {
      try { w.stop(); } catch (e) {}
    }
    running = false;
    cbHover = null; // hover state can't survive a stopped loop
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
    releaseLock();
  }

  function releaseLock(){
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  }

  /* ---------- menu ---------- */
  function menuOpenNow(){
    var m = CHLOE.ui.byId('overlay-menu');
    return !!(m && !m.classList.contains('hidden'));
  }
  function openMenu(){
    if (inBattle || menuOpenNow()) return;
    var w = world();
    if (w && running) { try { w.stop(); } catch (e) {} running = false; }
    releaseLock();
    CHLOE.ui.menu.open();
  }

  /* ---------- battle handoff ---------- */
  function engage(){
    if (inBattle) return;
    var id = enemyId();
    if (!(CHLOE.data.enemies || {})[id]) {
      console.warn('[CHLOE] room3d: unknown enemy "' + id + '"');
      return;
    }
    inBattle = true;
    pause();
    /* §16: battles happen in the 3D arena (fallback: 2D battle screen).
       §24: which STAGE that arena is does not get decided here. battle3d.begin
       resolves the round's stage and applies it before the arena builds, so
       every caller of begin() lands on the floor the room's board announced —
       a second resolution on this side is a second thing to drift. */
    if (CHLOE.ui.battle3d && typeof CHLOE.ui.battle3d.begin === 'function') {
      CHLOE.ui.battle3d.begin(id);
    } else {
      CHLOE.ui.battle.begin(id, { boss: false });
    }
  }

  /* The south wall door: opens the mirror fight. */
  function onDoorOpen(){
    if (inBattle) return;
    inBattle = true;
    pause();
    if (CHLOE.ui.battle3d && typeof CHLOE.ui.battle3d.beginClone === 'function') {
      CHLOE.ui.battle3d.beginClone();
    } else {
      /* Fallback: fight the room enemy instead. */
      inBattle = false;
      engage();
    }
  }

  /* ---------- §32 the Ring ---------- */
  /* The lobby's door. lobby.open() stops the world itself (it calls _pause,
     the same handle ui/shop.js uses), so this is only the click. */
  function openLobby(){
    if (inBattle || inPvp || menuOpenNow()) return;
    var L = CHLOE.ui.lobby;
    if (!L || typeof L.open !== 'function') return;
    try { L.open(); } catch (e) { console.warn('[CHLOE] lobby.open failed', e); }
  }

  /* ui/lobby.js hands the match over HERE rather than straight to the arena,
     because this file owns the flag that brings a dead fighter back to the
     dressing room afterwards — a match entered around it would end up in
     ui/scene.js's routing and start a new night. Returns false when there is
     no arena to hand it to, so the lobby can put the player back where they
     came from instead of onto a blank screen. */
  function pvpEngage(opts){
    if (inBattle || inPvp) return false;
    var b3d = CHLOE.ui.battle3d;
    if (!b3d || typeof b3d.beginPvp !== 'function') {
      console.warn('[CHLOE] room3d: battle3d.beginPvp is missing — the Ring cannot open.');
      return false;
    }
    inPvp = true;
    pause();
    var ok;
    try {
      ok = b3d.beginPvp(opts || {});
    } catch (e) {
      ok = false;
      console.warn('[CHLOE] battle3d.beginPvp failed', e);
    }
    /* Compared against false rather than tested for truth: battle3d answers
       false when it could not open the fight, and a version that simply
       returns nothing on success must still be believed. A refused handoff
       has to clear the flag, or the next PvE battle's end would be routed
       here as a deathmatch. */
    if (ok === false) { inPvp = false; return false; }
    return true;
  }

  /* ui/battle3d.js PUBLISHES the string an eliminated player comes home with,
     precisely so the two ends of this event cannot drift into two spellings of
     it — so ask for it rather than hard-coding a copy. The 'pvp' prefix is the
     fallback for a battle3d that predates the export, and it is the same line
     onWorldHover takes with the engine's hover shapes: be liberal about what a
     sibling hands you, strict about what you do with it. */
  function isPvpEnd(result){
    if (typeof result !== 'string' || !result) return false;
    var b3d = CHLOE.ui.battle3d;
    if (b3d && typeof b3d.PVP_RESULT === 'string' && result === b3d.PVP_RESULT) return true;
    return result.indexOf('pvp') === 0;
  }

  /* Won or eliminated — asked of engine/pvp.js rather than parsed out of the
     result string, so a new ending spelling cannot make the line lie. */
  function pvpEndLine(){
    var P = pvp(), m = null;
    if (P && typeof P.me === 'function') { try { m = P.me(); } catch (e) {} }
    if (m && m.alive) return 'The Ring is yours. Last one standing.';
    return 'You are out. The Ring goes on without you.';
  }

  function backToRoom(){
    party.state.scene = 'room3d';
    ui.show('room3d'); // onShow handler resumes the loop
  }

  /* battle finished (battleui funnels every end through scene.onBattleEnd —
     wrapped below so room-engaged battles land here instead). */
  function onBattleEnd(result){
    inBattle = false;
    var w = world();

    /* §32: a deathmatch ending — you were eliminated, or the match finished
       under you. Ahead of the 'defeat' branch ON PURPOSE: it IS a death, but
       it must not take the run's death path.
         · No CHLOE.game.startNew(). party.newGame() wipes members, levels, the
           tree, the skill points, all five bind stores, shards, flags and
           runStats — and the levels your kills paid for are the entire point
           of the mode.
         · No record claim: the board is about the knight ladder, and a PvP
           round is not a round of it.
         · No setEnemyAlive(true). The Hollow's respawn clock belongs to the
           room's own fight; re-arming it from here would stand him back up in
           the middle of somebody else's match, and the respawnTimer already
           running for the room is left exactly as it was.
       backToRoom() is the whole return: it sets party.state.scene and shows
       the room, and the room's OWN onShow handler resumes the world loop. */
    if (isPvpEnd(result)) {
      inPvp = false;
      ui.toast(pvpEndLine());
      backToRoom();
      return;
    }

    if (result === 'defeat') {
      // roguelike (spec §15): death ends the run. Reset the room (enemy back,
      // player at spawn, pickups restored) and start a brand-new level-1 run.
      if (respawnTimer) { window.clearTimeout(respawnTimer); respawnTimer = null; }
      if (w) {
        try {
          if (typeof w.setEnemyAlive === 'function') w.setEnemyAlive(true);
          if (typeof w.resetPlayer === 'function') w.resetPlayer();
        } catch (e) {}
      }
      CHLOE.game.startNew();
      ui.toast('A new night begins. Nothing came with you.');
      return;
    }

    if (result === 'victory') {
      // §11 via §13: clearing the room's enemy sets roomCleared, which is the
      // hook that brings Ash into the party. Run-scoped — re-earned each run.
      if (!party.getFlag('roomCleared')) party.setFlag('roomCleared');
      if (w) { try { if (typeof w.setEnemyAlive === 'function') w.setEnemyAlive(false); } catch (e) {} }
      if (respawnTimer) window.clearTimeout(respawnTimer);
      respawnTimer = window.setTimeout(function(){
        respawnTimer = null;
        var w2 = world();
        if (w2) { try { if (typeof w2.setEnemyAlive === 'function') w2.setEnemyAlive(true); } catch (e) {} }
      }, RESPAWN_MS);
    }
    // victory or fled: back into the room
    backToRoom();
  }

  /* ---------- one-time wiring ---------- */
  function wire(){
    if (wired) return;
    wired = true;

    // battle end: room-engaged battles bypass the 2D scene routing
    var scn = CHLOE.ui.scene;
    if (scn && typeof scn.onBattleEnd === 'function') {
      var origEnd = scn.onBattleEnd;
      scn.onBattleEnd = function(result){
        /* §32: inPvp too. A deathmatch is entered from the lobby, not from the
           room's crosshair, so inBattle is false for it — without this the end
           would fall through to the 2D scene routing and start a new night. */
        if (inBattle || inPvp) { onBattleEnd(result); return; }
        return origEnd.apply(scn, arguments);
      };
    }

    // menu close: resume the world if we're still on the room screen
    var menu = CHLOE.ui.menu;
    if (menu && typeof menu.close === 'function') {
      var origClose = menu.close;
      menu.close = function(){
        var r = origClose.apply(menu, arguments);
        if (ui.current() === 'room3d' && !inBattle) resume();
        return r;
      };
    }

    // M / Tab open the menu while roaming
    document.addEventListener('keydown', function(e){
      if (ui.current() !== 'room3d' || inBattle) return;
      if (menuOpenNow()) return;
      if (CHLOE.ui.dialog && CHLOE.ui.dialog.isActive && CHLOE.ui.dialog.isActive()) return;
      var k = e.key;
      if (k === 'm' || k === 'M' || k === 'Tab') {
        e.preventDefault();
        openMenu();
      }
    });

    // overlay visibility tracks pointer lock (poll also covers it)
    document.addEventListener('pointerlockchange', function(){
      if (ui.current() === 'room3d') poll();
    });

    window.addEventListener('resize', function(){
      var w = world();
      if (inited && w && typeof w.resize === 'function') {
        try { w.resize(); } catch (e) {}
      }
    });

    // router hook: (re)entering the screen starts the loop
    ui.onShow('room3d', function(){
      refreshHud();
      /* §19/§20/§24: the mirror and the west poster show live stats, the
         picture shows the round you are standing in, and the south board
         announces the stage the NEXT fight uses — all of which moved while you
         were away. One repaint on every entry covers the lot, which is why the
         board must hang off refreshPanels rather than its own hook. */
      var w = world();
      if (w && typeof w.refreshPanels === 'function') { try { w.refreshPanels(); } catch(e){} }
      resume();
    });
  }

  /* ---------- entry ---------- */
  function enter(){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    if (!els.canvas) build();
    wire();
    party.state.scene = 'room3d';
    ui.show('room3d'); // onShow -> resume()
    /* Pre-fetch the tornado / asteroid / hand-sign GLBs while the player
       walks the room. By the time they pick a floor the browser cache is
       warm and the loading gate skips the network round-trip. */
    var a3d = CHLOE.engine && CHLOE.engine.arena3d;
    if (a3d && typeof a3d.preloadVfx === 'function') a3d.preloadVfx();
  }

  return {
    enter: enter,
    openMenu: openMenu,
    /* §32: the lobby's two handles into the hub. openLobby is the same click
       the top-bar button makes; pvpEngage is the handoff that arms the flag
       bringing a dead fighter back here. */
    openLobby: openLobby,
    pvpEngage: pvpEngage,
    /* exposed for tests/debugging.
       LOAD-BEARING, NOT HOUSEKEEPING: _pause/_resume are the only handles that
       exist from outside this module — ui/shop.js's pauseWorld/resumeWorld and
       ui/lobby.js's pauseWorld both hang off them. Tidying either away is a
       shipped freeze bug (§28 D, and AGENTS.md's traps table). */
    _pause: pause,
    _resume: resume,
    _engage: engage,
    _standing: pvpStanding
  };
})();
