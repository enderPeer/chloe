/* CHLOE — ui/room3d.js  (Room3D — first-person mode, spec sec 13 + 14)
   Owns the #screen-room3d div + HUD: full-viewport canvas, center crosshair
   (red + "CLICK TO ENGAGE" when the enemy is hovered in range; white +
   "TV — click to turn on/off" when the TV is hovered, or "◀ THE CHURCH" on
   the stage board's picker arrows (§26) — enemy wins, then the TV),
   top bar (shards / active char level / Menu — reuses the .hud style),
   bottom control-hints line, and the lock overlay shown while the pointer
   is not locked. All Three.js logic lives in CHLOE.engine.world3d; this file
   only wires: show -> init+start, engage -> battle, battle end -> back here,
   M/Tab -> menu overlay (pause + release lock; resume on close).
   Renders/wires ONLY — no world rules, no battle rules. */
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
  var pollTimer = null;
  var respawnTimer = null;
  var warned = false;
  var ENGAGE_RANGE = 3.5;    // meters (spec sec 13)
  var TV_RANGE = 2.5;        // meters (spec sec 14)
  var RESPAWN_MS = 15000;
  var cbHover = null;        // last hover kind from world3d.onHover: 'enemy'|'tv'|null

  function world(){ return (CHLOE.engine && CHLOE.engine.world3d) || null; }
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
    var right = ui.el('div', 'hud-right');
    els.level = ui.el('div', 'r3d-level', '');
    right.appendChild(els.level);
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
      'WASD move · mouse look · Space jump · Ctrl or C crouch · clicks close your hands · M menu');
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
  function setHint(kind, label){ // 'enemy' | 'tv' | 'item' | 'stage' | null
    if (els.crosshair) {
      els.crosshair.classList.toggle('in-range', kind === 'enemy' || kind === 'item');
      // §26: the board's arrows borrow the TV's white crosshair — both are
      // panels you press, neither is something you fight
      els.crosshair.classList.toggle('tv-range', kind === 'tv' || kind === 'stage');
    }
    if (els.hint) {
      els.hint.classList.toggle('hidden', !kind);
      els.hint.classList.toggle('tv', kind === 'tv' || kind === 'stage');
      if (kind) {
        var text = kind === 'tv' ? 'TV — click to turn on/off'
                 : (kind === 'item' ? ('take the ' + (label || 'item'))
                 : (kind === 'stage' ? (label || 'change the floor') : 'CLICK TO ENGAGE'));
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
    // §16: a glinting item under the crosshair — enemy, TV and board first
    var pk = (!enemyHover && !tvHovered(d) && !arrow && d) ? d.pickupHover : null;
    setHint(enemyHover ? 'enemy'
          : (tvHovered(d) ? 'tv' : (arrow ? 'stage' : (pk ? 'item' : null))),
            arrow ? stageArrowLabel(arrow) : (pk && pk.label));
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

  function backToRoom(){
    party.state.scene = 'room3d';
    ui.show('room3d'); // onShow handler resumes the loop
  }

  /* battle finished (battleui funnels every end through scene.onBattleEnd —
     wrapped below so room-engaged battles land here instead). */
  function onBattleEnd(result){
    inBattle = false;
    var w = world();

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
        if (inBattle) { onBattleEnd(result); return; }
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
  }

  return {
    enter: enter,
    openMenu: openMenu,
    /* exposed for tests/debugging */
    _pause: pause,
    _resume: resume,
    _engage: engage
  };
})();
