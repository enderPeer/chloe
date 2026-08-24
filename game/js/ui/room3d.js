/* CHLOE — ui/room3d.js  (Room3D — first-person mode, spec sec 13)
   Owns the #screen-room3d div + HUD: full-viewport canvas, center crosshair
   (recolors + "click to engage" hint when the enemy is hovered in range),
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
  var RESPAWN_MS = 15000;

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

    // center crosshair dot + engage hint
    els.crosshair = ui.el('div', 'r3d-crosshair');
    r.appendChild(els.crosshair);
    els.hint = ui.el('div', 'r3d-hint hidden', 'click to engage');
    r.appendChild(els.hint);

    // bottom control hints
    els.controls = ui.el('div', 'r3d-controls',
      'WASD move · mouse look · Shift sprint · arrows/Q/E turn · M menu');
    r.appendChild(els.controls);

    // lock overlay (informational — clicks pass through to the canvas,
    // which requests pointer lock; keyboard fallback works without it)
    els.overlay = ui.el('div', 'r3d-lock-overlay');
    var card = ui.el('div', 'r3d-lock-card');
    card.appendChild(ui.el('div', 'r3d-lock-title', 'The Dressing Room'));
    card.appendChild(ui.el('div', 'r3d-lock-line',
      'Click to look around · WASD move · Shift sprint · ESC release · M menu'));
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
  function poll(){
    // left the screen through a path we don't control (e.g. logout) — halt
    if (ui.current() !== 'room3d') { pause(); return; }
    if (inBattle) return;

    var w = world();
    var d = null;
    if (w && typeof w.debug === 'function') {
      try { d = w.debug(); } catch (e) {}
    }
    var hover = !!(d && d.enemyAlive && typeof d.enemyDist === 'number' &&
                   d.enemyDist <= ENGAGE_RANGE);
    if (els.crosshair) els.crosshair.classList.toggle('in-range', hover);
    if (els.hint) els.hint.classList.toggle('hidden', !hover);
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
        inited = true;
      } catch (e) {
        console.warn('[CHLOE] world3d.init failed', e);
        return false;
      }
    }
    return true;
  }

  function resume(){
    if (!ensureInit()) return;
    var w = world();
    try {
      if (typeof w.resize === 'function') w.resize();
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
    // the exact battle entry scene hotspots use (scene.js runAction 'battle')
    CHLOE.ui.battle.begin(id, { boss: false });
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
      // existing defeat flow (shard loss + full heal), but respawn INTO the
      // room with the enemy reset instead of the 2D start scene.
      var lost = party.respawn();
      if (w) {
        try {
          if (typeof w.setEnemyAlive === 'function') w.setEnemyAlive(true);
          if (typeof w.respawn === 'function') w.respawn(); // optional API
        } catch (e) {}
      }
      if (respawnTimer) { window.clearTimeout(respawnTimer); respawnTimer = null; }
      backToRoom();
      ui.toast(lost > 0 ? ('You lost ' + lost + ' ◆ in the dark.')
                        : 'You wake up back in the room.');
      CHLOE.engine.save.autosave();
      return;
    }

    if (result === 'victory') {
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
    CHLOE.engine.save.autosave();
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
    _resume: resume
  };
})();
