/* CHLOE — ui/battle3d.js  (Combat v3, spec §17 — real-time HUD + input)
   Owns #screen-battle3d: the arena canvas (engine/arena3d.js renders into it)
   plus the live HUD — enemy bar, life/magic/stamina bars, the 1-9 hotbar with
   cooldown sweeps, evade readiness, cast bar and floating damage.
   Rules live in engine/combat3.js; the 3D layer answers hit tests. Ends funnel
   through CHLOE.ui.scene.onBattleEnd(result) exactly like the 2D battle screen,
   so ui/room3d.js's wrapper handles the roguelike outcomes (§15).
   §23 adds pockets: a hotbar key may hold a consumable instead of an ability,
   and the asteroid's impact stun floats its own label over the knights it
   catches. Both read the engine defensively — see slotView() and floatStun().
   §24 makes this the place the round's STAGE is resolved and applied, before
   the arena is built — see resolveStage()/applyStage(), and keep them in step
   with the room board that promised the player that stage. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.battle3d = (function () {
  'use strict';

  var ui, party, C3, a3d;
  var els = {};
  var built = false, inited3d = false, active = false;
  /* §24: the stage THIS fight is being fought on, kept because the result card
     is written after `stage` has gone out of startFight's scope and a card that
     names the church over a body lying in the Ring is the same lie the loading
     gate copy was fixed for. null = no stages data; the old wording stands. */
  var curStage = null;
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
  function nowMs() { return window.performance ? performance.now() : Date.now(); }

  /* ---------------------------------------------- §23 pockets: reading a slot
     A hotbar key may now carry a consumable. The engine publishes a resolved
     slot list for it, but this screen has to keep working against an engine
     that has not grown that surface yet — so nothing here asks "is this the
     new build", it asks "did anyone tell me this slot is an item", and when
     nobody did it falls through to the ability rendering that has always run.

     Every spelling we accept, and why each one exists:
       s.kind === 'item'   the resolved slot list, once it lands
       s.itemId            the same list, if it separates id from kind
       s.id = 'item:<id>'  §23's bind encoding leaking through unparsed
       binds[i]            the bind string read straight out of party state,
                           for a snapshot that only reports {key, id:null}
     Counts, names and icons work the same way: take what the slot says, and
     otherwise ask the bag and data/items.js directly. */
  function ITEMS() { return CHLOE.data.items || {}; }
  function itemDef(id) { return ITEMS()[id] || null; }
  function bagCount(id) {
    var inv = CHLOE.engine.inventory;
    return (inv && typeof inv.count === 'function') ? (inv.count(id) || 0) : 0;
  }
  function stripItem(v) {
    return (typeof v === 'string' && v.indexOf('item:') === 0) ? v.slice(5) : null;
  }
  function boundRaw(i) {
    var s = (C3 && C3.get) ? C3.get() : null;
    var binds = (party && party.state && party.state.binds) || null;
    var list = (s && s.charId && binds) ? binds[s.charId] : null;
    return (list && typeof list[i] === 'string') ? list[i] : null;
  }
  function itemIdOf(s, i) {
    if (!s) return null;
    /* When the slot says it is an item, `id` is the ITEM id — the 'item:'
       encoding stops at the engine boundary — so take it as-is. Falling
       through to stripItem here (an early version did) quietly re-classified
       every pocket as an ability, which renders the icon but prices it like a
       spell: no count, and permanently "broke". */
    if (s.kind === 'item') return s.itemId || stripItem(s.id) || s.id || null;
    if (typeof s.itemId === 'string' && s.itemId) return s.itemId;
    return stripItem(s.id) || stripItem(boundRaw(i));
  }

  /* The shared consumable cooldown, mirrored locally. The engine owns it, but
     if it never publishes one per slot the pockets would sit there looking
     armed through the whole lockout — so a successful press starts a shadow
     timer and the engine's own number wins the moment there is one. */
  var itemCd = { until: 0, span: 0 };
  function itemCooldownMs() {
    var g = CHLOE.data.config || {}, a = CHLOE.data.abilityConfig || {};
    return g.itemCooldownMs || a.itemCooldownMs || 2500;
  }
  function shadowCd() {
    var left = (itemCd.until - nowMs()) / 1000;
    if (left <= 0) return { pct: 0, left: 0 };
    return { pct: Math.max(0, Math.min(1, left / Math.max(0.001, itemCd.span / 1000))), left: left };
  }

  /* One uniform view of a slot for both build and refresh. Ability slots pass
     through untouched (`raw` is the snapshot entry the old code already knew
     how to read); item slots arrive resolved. */
  function slotView(s, i) {
    var v = { key: (s && s.key) || (i + 1), kind: 'ability', id: s ? s.id : null, raw: s };
    var id = itemIdOf(s, i);
    if (!id) return v;
    var def = itemDef(id) || {};
    var n = (s && typeof s.count === 'number') ? s.count : bagCount(id);
    var cd = shadowCd();
    v.kind = 'item';
    v.id = id;
    v.name = (s && s.name) || def.name || id;
    v.icon = (s && s.icon) || def.icon || '🎒';
    v.desc = def.desc || '';
    v.count = n;
    v.cdPct = (s && s.cdPct > 0) ? s.cdPct : cd.pct;
    v.cdLeft = (s && s.cdLeft > 0) ? s.cdLeft : cd.left;
    /* Dim on either half of the rule: nothing left to drink, or the shared
       lockout is still running. An engine that says `ready:false` for a reason
       of its own (mid-use lock) is believed; one that says nothing is not
       assumed to mean no. */
    v.ready = n > 0 && v.cdPct <= 0 && (!s || s.ready !== false);
    v.reason = (s && s.reason) || (n <= 0 ? 'None left.' : (v.cdPct > 0 ? 'Still fumbling.' : ''));
    return v;
  }
  function slotViews(snap) {
    return (snap && snap.slots ? snap.slots : []).map(slotView);
  }
  /* What the hotbar was BUILT for. A pocket key appearing (or an item bind
     changing) has to rebuild the DOM; a count ticking down must not. */
  function hotbarSig(views) {
    return views.map(function (v) { return v.kind + ':' + (v.id || '-'); }).join('|');
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
      'WASD move · mouse look · Shift sprint · Ctrl/C crouch · SPACE evade · 1-9 abilities & pockets'));

    /* The canvas is sized ONCE, in begin(). Drag the window while the fight is
       running and the CSS box follows but the drawing buffer does not, so the
       church stretches and the crosshair stops sitting where the hit test
       thinks it does. ui/room3d.js has always had this listener; the arena
       never did. Bound here rather than in begin() because build() runs once
       per page — begin() runs once per fight, and nine rounds would stack nine
       listeners on the same window. Guarded on `built` for the same reason
       every other a3d call here is: a resize can arrive before the first
       fight, or after a stop(). */
    window.addEventListener('resize', function () {
      if (!built || !a3d || typeof a3d.resize !== 'function') return;
      if (ui.current() !== 'battle3d') return;
      try { a3d.resize(); } catch (e) {}
    });

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
  var builtSig = null;

  function buildHotbar(snap) {
    ui.clear(els.hotbar);
    slotEls = [];
    var views = slotViews(snap);
    builtSig = hotbarSig(views);
    views.forEach(function (v, i) {
      if (v.kind === 'item') { els.hotbar.appendChild(buildItemSlot(v, i)); return; }
      var s = v.raw || {};
      var d = ui.el('div', 'b3d-slot' + (s.id ? '' : ' empty'));
      d.appendChild(ui.el('span', 'key', String(v.key)));
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

  /* §23: a pocket key. The item's icon sits where the ability icon sits and
     its REMAINING COUNT takes the corner the cost chip owns on an ability —
     a consumable's only question is how many are left, and the two labels
     must never fight for the same strip. The slot keeps the cooldown sweep
     because the shared lockout is exactly the thing that stops you chugging
     three bandages in a second, and it has to be visible while it runs. */
  function buildItemSlot(v, i) {
    var d = ui.el('div', 'b3d-slot item');
    d.appendChild(ui.el('span', 'key', String(v.key)));
    d.appendChild(ui.el('span', 'icon', v.icon));
    d.appendChild(ui.el('span', 'nm', v.name));
    var cnt = ui.el('span', 'cost count', '');
    d.appendChild(cnt);
    var sweep = ui.el('div', 'sweep');
    d.appendChild(sweep);
    var cd = ui.el('span', 'cd', '');
    d.appendChild(cd);
    d._count = cnt; d._sweep = sweep; d._cd = cd; d._item = v.id;
    d.addEventListener('click', function () { fire(i); });
    slotEls.push(d);
    paintItemSlot(d, v);
    return d;
  }

  /* Called every frame, so the count is live: it drops the moment one is
     drunk and climbs again the moment one is picked up, without rebuilding
     the bar. An emptied slot stays BOUND — icon, name and key all remain, it
     just reads as spent — because the bind is a decision the player made and
     finding another bandage must re-arm it, not ask them to bind it again. */
  function paintItemSlot(d, v) {
    if (d._count) d._count.textContent = '×' + v.count;
    if (d._sweep) d._sweep.style.height = Math.round(v.cdPct * 100) + '%';
    if (d._cd) d._cd.textContent = v.cdLeft > 0.05 ? v.cdLeft.toFixed(1) : '';
    d.classList.toggle('ready', !!v.ready);
    d.classList.toggle('cooling', v.cdPct > 0);
    d.classList.toggle('out', v.count <= 0);
    d.classList.toggle('dim', !v.ready);
    d.title = v.name + ' — ' + v.count + ' carried' + (v.reason ? ' · ' + v.reason : '') +
              (v.desc ? '\n' + v.desc : '');
  }

  function refreshHotbar(snap) {
    var views = slotViews(snap);
    /* A key can change WHAT it holds mid-fight — pocket slots arriving on a
       level-up, a leader swap, an item bind. Rebuild only when the shape
       actually changed, never for a count tick. */
    if (hotbarSig(views) !== builtSig) { buildHotbar(snap); return; }
    for (var i = 0; i < slotEls.length && i < views.length; i++) {
      var v = views[i], d = slotEls[i];
      if (v.kind === 'item') { paintItemSlot(d, v); continue; }
      var s = v.raw;
      if (!s || !s.id) continue;
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
    /* §21: name it with the level it actually is, and how many. The plate
       is the only place the fight tells you he has grown. */
    var kt = CHLOE.engine.knighttree;
    var kL = kt ? kt.level() : null;
    els.enemyName.textContent = snap.enemy.name +
      (kL ? '  ·  Lv ' + kL : '') +
      (snap.enemy.count > 1 ? '  ·  ' + snap.enemy.alive + '/' + snap.enemy.count : '');
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

  /* ---------- the centre line ----------
     One line of text, several things competing for it: a dodge warning for
     every swing IN FLIGHT (with a squad two knights are often winding up at
     once, and §22's thrust_combo puts up a fresh warning per stab) plus
     banners like the round title. They go on a stack, the newest owns the
     line, and when one clears whatever is still live underneath comes back up.
     It used to be a single element written blind, which lost the line two
     ways: a strike hid it unconditionally, so knight A's blow blanked knight
     B's warning while B was still mid-wind-up, and the round banner's own hide
     timer fired straight through the first dodge warning of the fight — after
     which the knight attacked with no tell at all. */
  var promptStack = [];   // [{id, text, cls}] — newest last
  var promptSeq = 0;

  function renderPrompt() {
    var top = promptStack.length ? promptStack[promptStack.length - 1] : null;
    if (!top) { els.prompt.classList.add('hidden'); return; }
    els.prompt.className = 'b3d-prompt ' + (top.cls || '');
    els.prompt.textContent = top.text;
  }

  function prompt(text, cls, ms) {
    var e = { id: ++promptSeq, text: text, cls: cls || '' };
    promptStack.push(e);
    renderPrompt();
    if (ms) later(function () { dropPrompt(e.id); }, ms);
    return e.id;
  }

  /* Retire ONE prompt by id; anything else still live stays on screen. */
  function dropPrompt(id) {
    for (var i = promptStack.length - 1; i >= 0; i--) {
      if (promptStack[i].id === id) { promptStack.splice(i, 1); break; }
    }
    renderPrompt();
  }

  /* Clear the line completely — used when the fight itself ends. */
  function hidePrompt() { promptStack.length = 0; renderPrompt(); }

  function splash(text, cls) {
    var s = ui.el('div', 'b3d-splash ' + (cls || ''), text);
    root().appendChild(s);
    later(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 1100);
  }

  /* ------------------------------------------------- §23 the "STUNNED" float
     The rock does not just hurt: everyone in the crater drops what they were
     winding up and cannot act for `stun.ms`. That has to read as its OWN
     thing. §22's stagger is a punish window you EARNED with one heavy hit and
     it prints amber "STAGGERED"; the stun is a crowd-control effect you BOUGHT
     with a key, it lands on several knights at once, and it is cold white-blue
     and heavier. Same fight, two different rules — if the two labels looked
     alike the player would never learn which one the rock is for.

     Where it goes: over the knight, not in the centre where the damage splash
     already lives. arena3d publishes no projection helper and no per-knight
     world position on its public surface, so this anchors on what IS public —
     the crater (`asteroidPoint`), which by definition is within splashRadius
     of every knight it stunned — and fans a squad around it so N labels read
     as N knights. If the engine ever grows a real projection or a per-knight
     point, they win: this is the floor, not the design. */
  var FOV_Y = 72;   // must match arena3d's PerspectiveCamera(72, ...)

  /* World -> percentage of the canvas. Built the same way arena3d builds the
     camera: forward is (-sin yaw, -cos yaw), rotation order YXZ. Percentages
     rather than pixels so a resize mid-float does not strand the label. */
  function project(x, y, z) {
    var d = a3d.debug ? a3d.debug() : null;
    if (!d || !els.canvas || typeof d.x !== 'number' || typeof d.yaw !== 'number') return null;
    var vx = x - d.x, vy = y - (typeof d.eye === 'number' ? d.eye : 1.6), vz = z - d.z;
    var cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
    var ux = vx * cy - vz * sy;
    var uz = vx * sy + vz * cy;
    var p = d.pitch || 0, cp = Math.cos(p), sp = Math.sin(p);
    var wy = vy * cp + uz * sp;
    var depth = vy * sp - uz * cp;          // camera looks down -Z
    if (!(depth > 0.4)) return null;        // behind you, or on the lens
    var W = els.canvas.clientWidth || 1, H = els.canvas.clientHeight || 1;
    var f = (H / 2) / Math.tan((FOV_Y * Math.PI / 180) / 2);
    return {
      x: 100 * (W / 2 + f * (ux / depth)) / W,
      y: 100 * (H / 2 - f * (wy / depth)) / H
    };
  }

  function knightAnchor(index, ordinal) {
    var pt = null;
    if (typeof a3d.knightPoint === 'function') pt = a3d.knightPoint(index);
    /* debug() publishes the LEADER's position and only his, so it is exact for
       index 0 — which is the whole fight for the first rounds, and the rounds
       where you first meet the rock. */
    if (!pt && index === 0 && a3d.debug) {
      var dbg = a3d.debug();
      if (dbg && dbg.knightPos) pt = { x: dbg.knightPos[0], z: dbg.knightPos[1] };
    }
    if (!pt && typeof a3d.asteroidPoint === 'function') {
      var c = a3d.asteroidPoint();
      if (c) {
        var ang = ordinal * 2.4;            // ~137°, so the fan never doubles up
        var rad = ordinal ? 1.5 : 0;
        pt = { x: c.x + Math.cos(ang) * rad, z: c.z + Math.sin(ang) * rad };
      }
    }
    var s = pt ? project(pt.x, (pt.y != null ? pt.y : 1.85), pt.z) : null;
    /* Nothing to project — the crater is behind you, or the 3D layer is the
       no-WebGL stub. Fan them across the upper band instead: the label still
       has to appear, because "he cannot swing for 1.5s" is the whole reason
       you spent the key. */
    if (!s) s = { x: 50 + ((ordinal % 3) - 1) * 16, y: 26 + Math.floor(ordinal / 3) * 7 };
    return {
      x: Math.max(6, Math.min(94, s.x)),
      y: Math.max(8, Math.min(80, s.y))
    };
  }

  function floatStun(index, ordinal) {
    var p = knightAnchor(index, ordinal);
    var e = ui.el('div', 'b3d-float stunned', 'STUNNED');
    e.style.left = p.x.toFixed(2) + '%';
    e.style.top = p.y.toFixed(2) + '%';
    root().appendChild(e);
    later(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 1400);
  }

  /* How long this ability stuns, in seconds. Read off the ability data rather
     than the id, so the next thing that stuns needs no code here. */
  function stunSeconds(abilityId) {
    var ab = (CHLOE.data.abilities || {})[abilityId];
    var ms = ab && ab.stun && ab.stun.ms;
    return ms > 0 ? ms / 1000 : 0;
  }

  function flashHurt() {
    els.hurt.classList.remove('on');
    void els.hurt.offsetWidth;
    els.hurt.classList.add('on');
  }

  /* ---------- actions ---------- */
  function fire(slotIndex) {
    if (!active || C3.isOver()) return;
    var snapNow = C3.snapshot();
    var view = snapNow ? slotView(snapNow.slots[slotIndex], slotIndex) : null;
    var r = C3.press(slotIndex);
    if (!r.ok) { log(r.reason || 'Not ready.'); return; }
    /* §23: a pocket key does not cast. An item press comes back with the same
       {ok, reason} shape but no `ability`, and reaching for a.hitAtMs on it
       would throw mid-fight — so the branch is decided by what the RESULT
       carries first and what we thought was bound only second. */
    if (r.kind === 'item' || r.item || r.itemId || (!r.ability && view && view.kind === 'item')) {
      itemUsed(r, view);
      return;
    }
    var a = r.ability;
    if (!a) { log('Nothing happens.'); return; }   // unknown press shape: no crash, no lie
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

  /* One consumable went down. The bag is the engine's to decrement — this only
     reports it and starts the local shadow of the shared lockout, so the other
     pockets grey out on the same frame even if the engine publishes nothing
     per-slot. No cast, no animation: the cost of a bandage is that you are
     standing still and hittable while you use it. */
  function itemUsed(r, view) {
    var id = r.itemId || (r.item && r.item.id) || (view && view.id);
    var def = itemDef(id) || (r.item || {});
    var name = def.name || (view && view.name) || 'Item';
    var span = (typeof r.cooldownMs === 'number' && r.cooldownMs > 0) ? r.cooldownMs : itemCooldownMs();
    itemCd.span = span;
    itemCd.until = nowMs() + span;
    /* The engine names the magic it gave back `mana`; data/items.js spells the
       same pool `mp` in its effect block. Read both — the number in the log is
       the only proof the drink did anything. */
    var mag = (r.mana > 0) ? r.mana : (r.mp > 0 ? r.mp : 0);
    var gain = [];
    if (r.hp > 0) gain.push('+' + Math.round(r.hp) + ' life');
    if (mag > 0) gain.push('+' + Math.round(mag) + ' magic');
    log(name + (gain.length ? ' — ' + gain.join(', ') : ' used') + '.');
    refresh();
  }

  function doEvade() {
    if (!active || C3.isOver()) return;
    var r = C3.evade();
    if (!r.ok) { log(r.reason || 'Cannot evade.'); return; }
    a3d.doEvade(r.distance, r.durationMs);
    splash('EVADE', 'evade');
  }

  /* ---------- enemy AI loop ---------- */
  /* Resolve one hit window. Two shapes:
       - arc abilities hit whoever is inside your reach/facing cone
       - §21 SPLASH abilities (the asteroid) hit whoever is standing in the
         crater, regardless of where you happen to be looking by then
     The asteroid also DELAYS its damage until the rock actually lands, so the
     number and the impact are the same moment rather than the number arriving
     while the rock is still in the air. */
  function resolveStrike(ab, e) {
    if (ab && ab.vfx === 'asteroid') {
      a3d.showSign(false);
      splash('ASTEROID', 'super');
      var abilityId = e.abilityId;
      var radius = ab.splashRadius || 3.4;
      a3d.spawnAsteroid(function () {
        if (!active || C3.isOver()) return;
        var hitList = a3d.asteroidTargets ? a3d.asteroidTargets(radius) : [];
        applyHits(abilityId, hitList, 'CRATER');
      });
      return;
    }
    var targets = (ab && a3d.abilityTargets) ? a3d.abilityTargets(ab) : [];
    applyHits(e.abilityId, targets, null);
  }

  function applyHits(abilityId, targets, tag) {
    if (!targets || !targets.length) { splash('miss', 'miss'); return; }
    var shown = 0;
    /* §23: what the rock does after the damage. combat3.hitEnemy owns this —
       it reads the ability's own `stun` block and has already called
       arena3d.stun — and it says so in `res.stunned`. So the label follows the
       ENGINE's answer rather than guessing from the data, and only falls back
       to applying the stun here when the result is silent about it (an engine
       that predates §23). arena3d.stun refreshes rather than stacks by
       contract, so neither path can double up. A dead knight is never stunned;
       he is dead, and the death animation owns that body. */
    var stunSecs = stunSeconds(abilityId);
    var canStun = stunSecs > 0 && typeof a3d.stun === 'function';
    var stunned = 0, stunShown = stunSecs;
    targets.forEach(function (ti) {
      /* §22: a reeling knight takes staggerTakeMult more, and this is the only
         place that can price it. The 3D layer knows he is reeling but not what
         a hit is worth; combat3 owns the damage sum but knows nothing about
         his footing. The multiplier crosses here or the punish window is a
         pose with no payoff — which is exactly what it was.
         `a3d` degrades to the no-WebGL surface, which answers 1. */
      var mult = a3d.staggerMult ? (a3d.staggerMult(ti) || 1) : 1;
      var res = C3.hitEnemy(abilityId, mult, ti);
      if (!res) return;
      a3d.flinch(res.dmg, res.killed, ti);
      if (!shown++) {
        splash('-' + res.dmg + (mult > 1 ? ' STAGGERED' : '') +
               (res.mult >= 2 ? ' SUPER' : '') +
               (targets.length > 1 ? ' x' + targets.length : ''),
               res.mult >= 2 ? 'super' : 'dmg');
      }
      var didStun = (res.stunned === true);
      if (res.stunned === undefined && canStun && !res.killed) {
        didStun = a3d.stun(ti, stunSecs) !== false;
      }
      if (didStun) {
        if (res.stunMs > 0) stunShown = res.stunMs / 1000;
        floatStun(ti, stunned++);
      }
      if (res.killed) log('A Hollow Knight falls. ' + C3.aliveCount() + ' left.');
    });
    if (tag && targets.length > 1) log(tag + ' — ' + targets.length + ' caught in it.');
    /* The stun line owns the log last, on purpose: it is the only one that
       tells you how long the opening lasts, and it is worded apart from §22's
       stagger for the same reason the label is coloured apart. */
    if (stunned) {
      log(stunned + (stunned === 1 ? ' knight is STUNNED' : ' knights are STUNNED') +
          ' — no swing, no step for ' + stunShown.toFixed(1) + 's.');
    }
  }

  function scheduleSwing(now) {
    /* §20: with a squad, swings are staggered — more knights means a faster
       drumbeat, but never all of them winding up on the same frame. */
    var alive = Math.max(1, C3.aliveCount ? C3.aliveCount() : 1);
    var base = 1700 + Math.random() * 1300;
    nextSwingAt = now + Math.max(650, base / Math.sqrt(alive));
  }

  /* §22: what the centre line tells you to DO about the swing coming at you.
     The pattern's own `hint` wins — the copy belongs in data/arena3d.js — but
     every evade KIND carries a hint here as the floor under it. A pattern that
     reaches the HUD without a hint used to print "Ground Slam — undefined",
     and a blank or wrong instruction is worse than none: the hint is the only
     thing that says WHICH way to move, and 'backoff' (ground_slam's shockwave
     rolls out from his feet) is the one kind where a clean sidestep still
     leaves you standing in it. */
  var EVADE_HINT = {
    crouch:   'CROUCH!',
    sidestep: 'SIDESTEP!',
    backoff:  'GET BACK!'
  };
  function evadeHint(p) {
    if (!p) return 'EVADE!';
    return p.hint || EVADE_HINT[p.evade] || 'EVADE!';
  }

  /* When window `i` of this pattern is due, measured from the start of the
     swing — thrust_combo's `hits` schedule states it as `atMs` off the same
     atk.t0 the strike timer counts from (§21). `hitAtMs` is the ability-side
     spelling of the same idea; null means the pattern never said. */
  function windowAtMs(p, i) {
    var h = p.hits && p.hits.length > i ? p.hits[i] : null;
    if (h && typeof h.atMs === 'number') return h.atMs;
    if (p.hitAtMs && p.hitAtMs.length > i) return p.hitAtMs[i];
    return null;
  }

  /* How many separate hit windows one pattern lands. thrust_combo is the first
     with more than one; fall back to a single window so every pattern written
     before §22 behaves exactly as it always has. */
  function hitWindows(p) {
    if (!p) return 1;
    if (p.hits && p.hits.length) return p.hits.length;
    if (p.hitAtMs && p.hitAtMs.length) return p.hitAtMs.length;
    return (typeof p.hits === 'number' && p.hits > 1) ? p.hits : 1;
  }

  /* How long window `i`'s warning may stay up before it is stale by
     definition. The 3D layer normally retires it by calling back at the
     strike, but a knight killed mid-wind-up never calls back at all, and a
     warning that outlives its swing is a lie about what is about to hit you.
     §22 feints stop at the apex and hold, so that hold counts toward the wait;
     the extra slack is there so the callback normally wins this race. */
  function windowWaitMs(p, i) {
    var hold = (p.feint && p.feint.holdMs) || 0;
    var at = windowAtMs(p, i), prev = i > 0 ? windowAtMs(p, i - 1) : 0;
    var wait;
    if (at !== null && prev !== null) wait = at - prev;
    else wait = i > 0 ? (p.hitGapMs || 500) : (p.telegraphMs || 1500);
    return wait + hold + 900;
  }

  /* One warning for one hit window. Multi-hit patterns count the stabs so you
     know another is coming after the one you just dodged. */
  function warnSwing(p, i, n) {
    return prompt(p.name + ' — ' + evadeHint(p) +
                  (n > 1 ? '  ·  ' + (i + 1) + '/' + n : ''),
                  'telegraph ev-' + (p.evade || 'any'),
                  windowWaitMs(p, i));
  }

  /* §22: a multi-hit pattern states a power PER window — thrust_combo's two
     jabs are 70 and the step-through is 95 — but combat3.takeHit prices a
     swing off `pattern.power`, which is only the single-window fallback. Hand
     it a shallow view carrying THIS window's number, or the combo's heavy
     third stab quietly lands for the same as a jab and the data lies. */
  function windowPattern(p, res) {
    if (!p || res.power == null || res.power === p.power) return p;
    var out = {};
    for (var k in p) out[k] = p[k];
    out.power = res.power;
    return out;
  }

  function enemySwing() {
    if (!active || C3.isOver()) return;
    var pattern = pickPattern();
    if (!pattern) return;
    // pick a living knight to make the attack
    var snap = C3.snapshot();
    var living = [];
    snap.enemy.each.forEach(function (e, i) { if (e.alive) living.push(i); });
    if (!living.length) return;
    var who = living[Math.floor(Math.random() * living.length)];
    /* §22: a multi-hit pattern gets ONE warning per hit window. The warning is
       retired the moment its own stab arrives and the next one goes up in its
       place, so the line never sits there telling you to dodge a stab that has
       already landed. */
    var windows = hitWindows(pattern);
    var landed = 0;
    var warn = warnSwing(pattern, 0, windows);
    a3d.telegraph(pattern, function (res) {
      dropPrompt(warn);                 // this window is spent, hit or miss
      if (!active || C3.isOver()) return;
      landed++;
      var out = C3.takeHit(res.hit ? windowPattern(pattern, res) : null);
      if (!res.hit || (out && out.evaded)) {
        splash(out && out.evaded ? 'DODGED!' : 'EVADED!', 'evade');
        log('The blade splits empty air.');
      } else if (out) {
        splash('-' + out.dmg, 'hurt');
        flashHurt();
        log(pattern.name + ' lands: ' + out.dmg + '.' +
            (windows > 1 ? '  (' + landed + '/' + windows + ')' : ''));
        // §19: leader fell but someone else is still standing — take over
        if (out.leaderSwap) {
          var nm = (CHLOE.data.characters[out.leaderSwap] || {}).name || out.leaderSwap;
          prompt(nm.toUpperCase() + ' TAKES OVER', 'banner', 1800);
          log(nm + ' steps over the body and keeps swinging.');
          buildHotbar(C3.snapshot());   // their level, their abilities, their keys
          /* §22: he just put a leader down — roll the beat of contempt. It has
             to WAIT for his own follow-through: a3d.taunt refuses a knight who
             is still mid-swing, which is every knight at the instant his blow
             lands, so rolling it here and now would never once succeed. The
             whiffed-attack half of the same rule lives in the engine, where the
             miss is already known. */
          var slow = who;
          later(function () {
            if (active && !C3.isOver() && a3d.taunt) a3d.taunt(slow);
          }, (pattern.recoverMs || 800) + 320);
        }
      }
      if (landed < windows) warn = warnSwing(pattern, landed, windows);
      refresh();
      if (C3.isOver()) { finish(); return; }
    }, who);
  }

  /* §21: he only swings what his level has taught him. Round 1 is one
     pattern; the charge does not exist until he has learned it. */
  function knownPatterns() {
    var all = (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
    var kt = CHLOE.engine.knighttree;
    if (!kt) return all;
    var ids = kt.patterns(kt.level());
    var out = {};
    ids.forEach(function (id) { if (all[id]) out[id] = all[id]; });
    return Object.keys(out).length ? out : all;
  }

  function pickPattern() {
    var pats = knownPatterns();
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
        resolveStrike(ab, e);
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

  /* ------------------------------------------------ §24: where we are fighting
     KEEP THIS IN STEP with engine/world3d.js nextStagePlan(): the south poster
     in the room paints its board from these same three rules, and a board that
     names a different floor than the one you land on is the single failure
     that makes the whole feature worthless. The rules, in order:
       1. CHLOE.engine.stages.forRound(n) — the stateful selector, if it is
          there. Once it exists it owns the cycle.
       2. CHLOE.data.stagePick — the pure round -> stage half that lives in data.
       3. neither -> the church, i.e. exactly what every fight was before §24.
     All of it is gated on arena3d.setStage EXISTING, because that is the only
     thing that can move the fight: on a build without it every round is still
     in the church, and the board is gated the same way so it says so. */
  function stageEntry(v) {
    if (!v) return null;                 // forRound may hand back an id
    if (typeof v === 'string') return ((CHLOE.data && CHLOE.data.stages) || {})[v] || null;
    return v.id ? v : null;
  }

  function resolveStage(round) {
    if (!a3d || typeof a3d.setStage !== 'function') return null;
    var def = null;
    var sel = CHLOE.engine.stages;
    if (sel && typeof sel.forRound === 'function') def = stageEntry(sel.forRound(round));
    var pick = !def && CHLOE.data && CHLOE.data.stagePick;
    if (pick && typeof pick.stageForRound === 'function') def = stageEntry(pick.stageForRound(round));
    else if (pick && typeof pick.forRound === 'function') def = stageEntry(pick.forRound(round));
    if (!def) def = ((CHLOE.data && CHLOE.data.stages) || {}).church || null;
    return def;
  }

  /* What the arena says it is standing on, or null if it does not publish it. */
  function appliedStageId() {
    try {
      var d = a3d.debug && a3d.debug();
      var s = d && d.stage;
      if (!s) return null;
      return (typeof s === 'string') ? s : (s.id || null);
    } catch (e) { return null; }
  }

  /* Apply it BEFORE anything builds. On the first fight arena3d has not been
     init'd yet, so this only records the pick and init() builds the right
     stage; on later fights setStage has to tear the previous one down. Either
     way the arena must never be constructed and then re-pointed.
     setStage's argument shape belongs to the arena, so try the id and then the
     entry itself, and VERIFY against debug().stage instead of assuming it took
     — a silent mismatch here is exactly the lie the board must never tell. */
  function applyStage(def) {
    if (!def || !a3d || typeof a3d.setStage !== 'function') return null;
    var forms = [def.id, def], got = null;
    for (var i = 0; i < forms.length; i++) {
      try { a3d.setStage(forms[i]); } catch (e) { continue; }
      got = appliedStageId();
      // null = this arena publishes no debug().stage to check against, so the
      // call is all we have; take it rather than re-setting the stage twice.
      if (got === null || got === def.id) return def;
    }
    console.warn('[battle3d] stage "' + def.id + '" did not take — arena reports "' + got + '"');
    return null;
  }

  /* ---------- lifecycle ---------- */
  function begin(enemyId) {
    ui = CHLOE.ui; party = CHLOE.engine.party;
    C3 = CHLOE.engine.combat3; a3d = CHLOE.engine.arena3d;

    // §20: round N puts N knights on the floor
    var round = (party.state.runStats && party.state.runStats.round) || 1;
    var s = C3.start(enemyId, round);
    if (!s) { console.warn('[battle3d] cannot start ' + enemyId); return; }
    if (!built) build();
    active = true;

    // §24: the stage the room's board has been announcing, applied before the
    // arena exists. Nothing below this line may run first.
    var stage = applyStage(resolveStage(round));
    curStage = stage;

    ui.show('battle3d');
    if (!inited3d) { a3d.init(els.canvas); inited3d = true; }
    a3d.reset();
    if (a3d.spawnSquad) a3d.spawnSquad(round);
    a3d.resize();

    /* §21: hold the fight behind the loading gate. The church is 26MB;
       starting the clock before it arrives spawned you in grey nothing with an
       invisible knight already walking you down. The gate also warms every
       shader, which is what stops the first Fire Tornado from hitching. */
    var load = CHLOE.ui.loading;
    /* The gate copy names the floor you are about to stand on: "Unsealing the
       church" over a bare disc of stone read as a bug the moment §24 gave the
       run somewhere else to go. */
    var churchy = !stage || stage.id === 'church';
    var opening = churchy ? 'Unsealing the church…' : ('Opening ' + (stage.name || 'the floor') + '…');
    var settled = churchy ? 'Lighting the candles…' : 'Lighting the rim…';
    if (load && a3d.assetsReady && !a3d.assetsReady()) {
      load.show(opening);
      load.waitFor(
        function () { return a3d.assetsReady(); },
        function (setProgress) {
          var pr = a3d.assetProgress ? a3d.assetProgress() : null;
          if (pr) setProgress(pr.done, pr.total + 1, pr.done >= pr.total ? settled : opening);
        },
        function () { load.hide(); startFight(round, stage); }
      );
      return;
    }
    startFight(round, stage);
  }

  /* Everything that must not happen until the scene is actually on screen. */
  function startFight(round, stage) {
    if (!active) return;
    a3d.start();
    a3d.stopAbility();

    buildHotbar(C3.snapshot());
    refresh();
    // naming the stage in the log is the player-visible half of §24's promise:
    // the board said this floor, and here it is.
    if (stage && stage.name) log(stage.name + (stage.blurb ? ' — ' + stage.blurb : ''));
    log('The doors seal. Keys 1-9 to strike, SPACE to evade.');
    var snap0 = C3.snapshot();
    prompt(round > 1
      ? ('ROUND ' + round + ' — ' + snap0.enemy.count + ' HOLLOW KNIGHTS')
      : (snap0.enemy.name.toUpperCase() + ' RISES'), 'banner', 2200);

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
    /* §21: the fight is over, so put the player in cursor mode BEFORE the
       result card goes up. Pointer lock hides the mouse and eats clicks, so
       the Continue button was unreachable until you knew to press Escape.
       Drop OUR keys too rather than relying on the `active` flag having been
       cleared first: this handler calls preventDefault on Space, which is the
       key that would activate the card's focused button. */
    unwireKeys();
    hidePrompt();
    if (a3d.releaseLock) a3d.releaseLock();
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
      /* §21: nothing to spend any more — say what the level actually GAVE,
         and where the new move already is. Reading binds() is what triggers
         the auto-bind, so ask for it before asking what moved. */
      (rw.levelUps || []).forEach(function (l) {
        try { C3.binds(l.memberId); } catch (e) {}
      });
      var auto = C3.takeAutoBound ? C3.takeAutoBound() : null;
      if (auto && auto.placed.length) {
        auto.placed.forEach(function (pl) {
          var ad = (CHLOE.data.abilities || {})[pl.abilityId] || {};
          lines.appendChild(ui.el('div', 'lvl',
            (ad.icon || '•') + ' ' + (ad.name || pl.abilityId) +
            ' — ready on key ' + (pl.slot + 1)));
        });
      }
      var sk = CHLOE.engine.skilltree;
      var lead = party.active();
      var nxt = (sk && lead) ? sk.nextRow(lead.level) : null;
      if (nxt) {
        lines.appendChild(ui.el('div', null,
          'Next at Lv ' + nxt.level + ': ' + (nxt.row.name || '—')));
      }
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
    dl.appendChild(ui.el('div', null,
      ((curStage && curStage.name) || 'The church') + ' keeps what it takes...'));
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
    _swing: enemySwing,
    /* §22: what the centre line is actually saying right now ('' = nothing),
       so "a multi-hit pattern never leaves a stale dodge warning up" is a
       measurement rather than an opinion. _hint proves the evade->hint map
       covers a kind without having to drive a whole swing for it. */
    _prompt: function () {
      return (els.prompt && !els.prompt.classList.contains('hidden'))
        ? els.prompt.textContent : '';
    },
    _hint: evadeHint,
    /* The damage+stun resolve for one hit window. Exported for the same reason
       _finish is: everything that leads here runs off rAF, which is frozen in
       any tab that is not compositing, so without it "the crater stuns every
       knight in it and floats one label each" cannot be checked headlessly. */
    _hits: applyHits,
    /* §23: what the hotbar believes it is showing, so "the pocket key shows a
       count and dims when it runs out" is a measurement. Mirrors the DOM, not
       the engine: it reports what was RENDERED. */
    _slots: function () {
      var snap = C3 && C3.snapshot ? C3.snapshot() : null;
      return slotViews(snap).map(function (v, i) {
        var d = slotEls[i];
        return {
          key: v.key, kind: v.kind, id: v.id, count: v.count, ready: v.ready,
          badge: (d && d._count) ? d._count.textContent : null,
          dim: !!(d && d.classList.contains('dim')),
          out: !!(d && d.classList.contains('out'))
        };
      });
    },
    /* How many "STUNNED" labels are on screen right now — distinct element and
       distinct class from anything §22 puts up. */
    _stunFloats: function () {
      if (!ui || !built) return 0;
      return root().querySelectorAll('.b3d-float.stunned').length;
    },
    /* The resolve path only runs off rAF, which is frozen whenever the tab
       is not compositing — so without this the victory/defeat card and the
       mode switch that goes with it cannot be tested headlessly at all. */
    _finish: finish
  };
})();
