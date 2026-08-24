/* CHLOE — ui/battle3d.js  (Combat v3, spec §17 — real-time HUD + input)
   Owns #screen-battle3d: the arena canvas (engine/arena3d.js renders into it)
   plus the live HUD — enemy bar, life/magic/stamina bars, the 1-9 hotbar with
   cooldown sweeps, evade readiness, cast bar and floating damage.
   Rules live in engine/combat3.js; the 3D layer answers hit tests. Ends funnel
   through CHLOE.ui.scene.onBattleEnd(result) exactly like the 2D battle screen,
   so ui/room3d.js's wrapper handles the roguelike outcomes (§15). */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.battle3d = (function () {
  'use strict';

  var ui, party, C3, a3d;
  var els = {};
  var built = false, inited3d = false, active = false;
  var rafId = 0, lastT = 0;
  var enemyTimer = null, nextSwingAt = 0;
  var slotEls = [];
  var timers = [];

  function later(fn, ms) { var t = window.setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers() {
    for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
    timers.length = 0;
  }
  function typeColor(t) {
    var c = (CHLOE.data.types && CHLOE.data.types.colors) || {};
    return c[t] || '#9a939c';
  }

  /* ---------- screen ---------- */
  function root() {
    var r = ui.byId('screen-battle3d');
    if (!r) {
      r = ui.el('div', 'screen');
      r.id = 'screen-battle3d';
      var app = ui.byId('app');
      app ? app.insertBefore(r, ui.byId('dialog-layer') || null) : document.body.appendChild(r);
    }
    return r;
  }

  function build() {
    var r = ui.clear(root());
    els.canvas = document.createElement('canvas');
    els.canvas.id = 'battle3d-canvas';
    r.appendChild(els.canvas);
    r.appendChild(ui.el('div', 'r3d-vignette'));
    els.hurt = ui.el('div', 'b3d-hurt');
    r.appendChild(els.hurt);

    // enemy plate
    els.enemyPlate = ui.el('div', 'b3d-enemy-plate');
    els.enemyName = ui.el('div', 'b3d-enemy-name', '');
    els.enemyBar = ui.makeBar('');
    els.enemyPlate.appendChild(els.enemyName);
    els.enemyPlate.appendChild(els.enemyBar);
    r.appendChild(els.enemyPlate);

    // crosshair + in-reach ring
    els.cross = ui.el('div', 'b3d-cross');
    r.appendChild(els.cross);

    // centre prompt (telegraph warnings)
    els.prompt = ui.el('div', 'b3d-prompt hidden', '');
    r.appendChild(els.prompt);

    // cast bar
    els.castWrap = ui.el('div', 'b3d-cast hidden');
    els.castFill = ui.el('div', 'fill');
    els.castWrap.appendChild(els.castFill);
    r.appendChild(els.castWrap);

    // player resource bars
    var res = ui.el('div', 'b3d-res');
    els.hpBar = resBar(res, 'hp', 'LIFE');
    els.manaBar = resBar(res, 'mana', 'MAGIC');
    els.staBar = resBar(res, 'sta', 'STAMINA');
    r.appendChild(res);

    // hotbar
    els.hotbar = ui.el('div', 'b3d-hotbar');
    r.appendChild(els.hotbar);

    // evade pip
    els.evade = ui.el('div', 'b3d-evade');
    els.evade.innerHTML = '<b>SPACE</b><span>EVADE</span>';
    r.appendChild(els.evade);

    els.log = ui.el('div', 'b3d-log', '');
    r.appendChild(els.log);

    r.appendChild(ui.el('div', 'b3d-controls',
      'WASD move · mouse look · Shift sprint · Ctrl/C crouch · SPACE evade · 1-9 abilities'));

    built = true;
  }

  function resBar(parent, cls, label) {
    var row = ui.el('div', 'b3d-res-row ' + cls);
    row.appendChild(ui.el('span', 'lbl', label));
    var bar = ui.el('div', 'b3d-res-bar');
    var fill = ui.el('div', 'fill');
    bar.appendChild(fill);
    row.appendChild(bar);
    var num = ui.el('span', 'num', '');
    row.appendChild(num);
    parent.appendChild(row);
    return { fill: fill, num: num };
  }

  function setRes(b, val, max) {
    var pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
    b.fill.style.width = pct + '%';
    b.num.textContent = Math.round(val) + '/' + Math.round(max);
  }

  /* ---------- hotbar ---------- */
  function buildHotbar(snap) {
    ui.clear(els.hotbar);
    slotEls = [];
    snap.slots.forEach(function (s, i) {
      var d = ui.el('div', 'b3d-slot' + (s.id ? '' : ' empty'));
      d.appendChild(ui.el('span', 'key', String(s.key)));
      if (s.id) {
        var ic = ui.el('span', 'icon', s.icon || '•');
        ic.style.color = typeColor(s.type);
        d.appendChild(ic);
        d.appendChild(ui.el('span', 'nm', s.name));
        // §18: every slot states what it costs and how long until it's back
        var cost = ui.el('span', 'cost', s.costText || '');
        if (s.cost && s.cost.mana) cost.classList.add('mana');
        d.appendChild(cost);
        var sweep = ui.el('div', 'sweep');
        d.appendChild(sweep);
        var cd = ui.el('span', 'cd', '');
        d.appendChild(cd);
        var ch = ui.el('span', 'ch', '');
        d.appendChild(ch);
        d._sweep = sweep; d._ch = ch; d._cd = cd; d._cost = cost;
        d.title = s.name + ' — ' + s.costText;
      } else {
        d.appendChild(ui.el('span', 'nm', '—'));
      }
      d.addEventListener('click', function () { fire(i); });
      els.hotbar.appendChild(d);
      slotEls.push(d);
    });
  }

  function refreshHotbar(snap) {
    for (var i = 0; i < slotEls.length && i < snap.slots.length; i++) {
      var s = snap.slots[i], d = slotEls[i];
      if (!s.id) continue;
      d.classList.toggle('ready', !!s.ready);
      d.classList.toggle('cooling', s.cdPct > 0);
      d.classList.toggle('broke', !s.affordable && s.cdPct <= 0);
      if (d._sweep) d._sweep.style.height = Math.round(s.cdPct * 100) + '%';
      if (d._ch) d._ch.textContent = s.maxCharges > 1 ? String(s.charges) : '';
      if (d._cd) d._cd.textContent = s.cdLeft > 0.05 ? s.cdLeft.toFixed(1) : '';
    }
  }

  /* ---------- HUD refresh ---------- */
  function refresh() {
    var snap = C3.snapshot();
    if (!snap) return;
    setRes(els.hpBar, snap.hp, snap.max.hp);
    setRes(els.manaBar, snap.mana, snap.max.mana);
    setRes(els.staBar, snap.sta, snap.max.sta);
    ui.setBar(els.enemyBar, snap.enemy.life, snap.enemy.max);
    els.enemyName.textContent = snap.enemy.name;
    refreshHotbar(snap);

    els.evade.classList.toggle('ready', snap.evade.ready);
    els.evade.classList.toggle('iframe', snap.iframe);

    if (snap.casting) {
      els.castWrap.classList.remove('hidden');
      els.castFill.style.width = Math.round(snap.casting.pct * 100) + '%';
    } else {
      els.castWrap.classList.add('hidden');
    }

    // crosshair turns hot when the knight is in reach of slot 1
    var d = a3d.debug ? a3d.debug() : null;
    els.cross.classList.toggle('in-reach', !!(d && d.knightDist <= 2.8));
  }

  function log(t) { els.log.textContent = t || ''; }

  function prompt(text, cls, ms) {
    els.prompt.className = 'b3d-prompt ' + (cls || '');
    els.prompt.textContent = text;
    if (ms) later(function () { els.prompt.classList.add('hidden'); }, ms);
  }
  function hidePrompt() { els.prompt.classList.add('hidden'); }

  function splash(text, cls) {
    var s = ui.el('div', 'b3d-splash ' + (cls || ''), text);
    root().appendChild(s);
    later(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 1100);
  }

  function flashHurt() {
    els.hurt.classList.remove('on');
    void els.hurt.offsetWidth;
    els.hurt.classList.add('on');
  }

  /* ---------- actions ---------- */
  function fire(slotIndex) {
    if (!active || C3.isOver()) return;
    var r = C3.press(slotIndex);
    if (!r.ok) { log(r.reason || 'Not ready.'); return; }
    var a = r.ability;
    var total = (a.hitAtMs && a.hitAtMs.length) ? a.hitAtMs[a.hitAtMs.length - 1] : a.castMs;
    if (a.cast === 'sign') {
      // §18: raise the hand and trace the sigil; the funnel drops on the
      // first hit window (handled in frame()).
      a3d.showSign(true);
    } else {
      a3d.playAbility(a.id, a.anim, a.animSpeed, total + (a.recoverMs || 0));
    }
    log(a.name);
  }

  function doEvade() {
    if (!active || C3.isOver()) return;
    var r = C3.evade();
    if (!r.ok) { log(r.reason || 'Cannot evade.'); return; }
    a3d.doEvade(r.distance, r.durationMs);
    splash('EVADE', 'evade');
  }

  /* ---------- enemy AI loop ---------- */
  function scheduleSwing(now) {
    // the knight paces its attacks; distance gates whether it commits
    nextSwingAt = now + 1600 + Math.random() * 1400;
  }

  function enemySwing() {
    if (!active || C3.isOver()) return;
    var pattern = pickPattern();
    if (!pattern) return;
    prompt(pattern.name + ' — ' + pattern.hint, 'telegraph');
    a3d.telegraph(pattern, function (res) {
      if (!active || C3.isOver()) { hidePrompt(); return; }
      hidePrompt();
      var out = C3.takeHit(res.hit ? pattern : null);
      if (!res.hit || (out && out.evaded)) {
        splash(out && out.evaded ? 'DODGED!' : 'EVADED!', 'evade');
        log('The blade splits empty air.');
      } else if (out) {
        splash('-' + out.dmg, 'hurt');
        flashHurt();
        log(pattern.name + ' lands: ' + out.dmg + '.');
      }
      refresh();
      if (C3.isOver()) { finish(); return; }
    });
  }

  function pickPattern() {
    var pats = (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
    var pool = [];
    for (var id in pats) {
      var w = pats[id].weight || 1;
      for (var i = 0; i < w; i++) pool.push(id);
    }
    return pool.length ? pats[pool[Math.floor(Math.random() * pool.length)]] : null;
  }

  /* ---------- main loop ---------- */
  function frame(now) {
    if (!active) return;
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)) || 0.016;
    lastT = now;

    var events = C3.tick(dt);
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.t === 'strike') {
        var ab = (CHLOE.data.abilities || {})[e.abilityId];
        // §18: the first hit window of a vfx ability spawns its effect
        if (ab && ab.vfx === 'tornado' && e.index === 1) {
          a3d.showSign(false);
          var span = (ab.hitAtMs[ab.hitAtMs.length - 1] - ab.hitAtMs[0]) + 900;
          a3d.spawnTornado(span);
          splash('FIRE TORNADO', 'super');
        }
        if (ab && a3d.abilityHits(ab)) {
          var res = C3.hitEnemy(e.abilityId, 1);
          if (res) {
            a3d.flinch(res.dmg, res.killed);
            splash('-' + res.dmg + (res.mult >= 2 ? ' SUPER' : ''), res.mult >= 2 ? 'super' : 'dmg');
          }
        } else {
          splash('miss', 'miss');
        }
      } else if (e.t === 'castEnd') {
        a3d.stopAbility();
      }
    }

    if (!C3.isOver() && now >= nextSwingAt) {
      scheduleSwing(now);
      enemySwing();
    }

    refresh();
    if (C3.isOver()) { finish(); return; }
  }

  /* ---------- lifecycle ---------- */
  function begin(enemyId) {
    ui = CHLOE.ui; party = CHLOE.engine.party;
    C3 = CHLOE.engine.combat3; a3d = CHLOE.engine.arena3d;

    var s = C3.start(enemyId);
    if (!s) { console.warn('[battle3d] cannot start ' + enemyId); return; }
    if (!built) build();
    active = true;

    ui.show('battle3d');
    if (!inited3d) { a3d.init(els.canvas); inited3d = true; }
    a3d.reset(); a3d.resize(); a3d.start();
    a3d.stopAbility();

    buildHotbar(C3.snapshot());
    refresh();
    log('The doors seal. Keys 1-9 to strike, SPACE to evade.');
    prompt(C3.snapshot().enemy.name.toUpperCase() + ' RISES', 'banner', 1800);

    wireKeys();
    lastT = performance.now();
    scheduleSwing(lastT + 1200);
    rafId = requestAnimationFrame(frame);
  }

  var keyHandler = null;
  function wireKeys() {
    if (keyHandler) return;
    keyHandler = function (e) {
      if (!active || ui.current() !== 'battle3d') return;
      if (e.code === 'Space') { e.preventDefault(); doEvade(); return; }
      var m = /^Digit([1-9])$/.exec(e.code);
      if (m) { e.preventDefault(); fire(parseInt(m[1], 10) - 1); }
    };
    window.addEventListener('keydown', keyHandler);
  }
  function unwireKeys() {
    if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  }

  function finish() {
    if (!active) return;
    var snap = C3.snapshot();
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    a3d.stopAbility();
    if (snap && snap.result === 'victory') showVictory();
    else if (snap && snap.result === 'defeat') showDefeat();
    else end(snap ? snap.result : 'fled');
  }

  function showVictory() {
    var stt = C3.get();
    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card');
    card.appendChild(ui.el('h2', null, 'Encore!'));
    var lines = ui.el('div', 'result-lines');
    var rw = (stt && stt.rewards) || {};
    lines.appendChild(ui.el('div', 'big', '+' + (rw.xp || 0) + ' XP · +' + (rw.shards || 0) + ' ◆'));
    (rw.levelUps || []).forEach(function (l) {
      var def = (CHLOE.data.characters || {})[l.memberId] || {};
      lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' reached Lv ' + l.level + '!'));
    });
    if ((rw.levelUps || []).length) {
      lines.appendChild(ui.el('div', null, 'Spend the point in Menu → Skill Tree to unlock a new ability or keybind.'));
    }
    (rw.drops || []).forEach(function (d) { lines.appendChild(ui.el('div', null, 'Found: ' + d)); });
    card.appendChild(lines);
    var b = ui.el('button', null, 'Continue');
    b.addEventListener('click', function () {
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      end('victory');
    });
    card.appendChild(b);
    veil.appendChild(card);
    root().appendChild(veil);
  }

  function showDefeat() {
    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card defeat');
    card.appendChild(ui.el('h2', null, 'The Night Wins'));
    var dl = ui.el('div', 'result-lines');
    dl.appendChild(ui.el('div', null, 'The church keeps what it takes...'));
    var s = party.state, topLv = 1;
    (s.members || []).forEach(function (m) { if (m.level > topLv) topLv = m.level; });
    var kills = (s.runStats && s.runStats.kills) || 0;
    dl.appendChild(ui.el('div', 'big', 'Run over — Lv ' + topLv + ' · ◆ ' + (s.shards || 0) +
      ' · ' + kills + (kills === 1 ? ' fight won' : ' fights won')));
    dl.appendChild(ui.el('div', null, 'Every night starts from nothing.'));
    card.appendChild(dl);
    var b = ui.el('button', null, 'Begin again');
    b.addEventListener('click', function () {
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      end('defeat');
    });
    card.appendChild(b);
    veil.appendChild(card);
    root().appendChild(veil);
  }

  function end(result) {
    active = false;
    clearTimers();
    unwireKeys();
    hidePrompt();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    a3d.stop();
    CHLOE.ui.scene.onBattleEnd(result);
  }

  return {
    begin: begin,
    /* test hooks */
    _fire: fire, _evade: doEvade, _active: function () { return active; },
    _swing: enemySwing
  };
})();
