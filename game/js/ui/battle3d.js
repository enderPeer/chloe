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
   with the room board that promised the player that stage.
   §25 fixes the miss: a swing the 3D layer says did NOT connect never reaches
   combat3 at all (see enemySwing), and the Water Wave throws what its cone
   catches sideways instead of back — see shovePlan()/applyShove(). */
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
    /* §27C: a passive is ARMED, not pressable — the revive potion has no
       cooldown dial and lighting it up like a bandage would invite the one
       press that must never happen. The engine decides which it is (it owns
       the item rule); we only ask, and fall back to asking combat3 directly if
       an older snapshot has no `passive` field. */
    v.passive = (s && typeof s.passive === 'boolean')
      ? s.passive
      : !!(C3 && C3.passiveItem && C3.passiveItem(id));
    if (v.passive) {
      v.cdPct = 0; v.cdLeft = 0;
      v.armed = n > 0;
      v.ready = false;
      v.reason = (s && s.reason) || (n > 0 ? 'Armed — spends itself if you fall.' : 'None left.');
      return v;
    }
    /* Dim on either half of the rule: nothing left to drink, or the shared
       lockout is still running. An engine that says `ready:false` for a reason
       of its own (mid-use lock) is believed; one that says nothing is not
       assumed to mean no. */
    v.ready = n > 0 && v.cdPct <= 0 && (!s || s.ready !== false);
    v.reason = (s && s.reason) || (n <= 0 ? 'None left.' : (v.cdPct > 0 ? 'Still fumbling.' : ''));
    return v;
  }
  /* §27B: the eleven slots the player actually has — the nine number keys, then
     LMB and RMB.

     `slot` is what gets PRESSED and it is deliberately not the array index.
     combat3 addresses the buttons by the strings 'mouseL'/'mouseR' precisely so
     a stray 9 or 10 fires nothing instead of firing the wrong ability, and the
     moment this list is drawn as one strip the index and the slot stop being
     the same number. Every call site below reaches for `v.slot`.

     The buttons ride on the END of the strip, never inside the numbers, so the
     nine keys keep the positions the player's hand already knows. */
  function slotViews(snap) {
    var keys = (snap && snap.slots ? snap.slots : []).map(slotView);
    keys.forEach(function (v, i) { v.slot = i; });
    var mice = (snap && snap.mouseSlots ? snap.mouseSlots : []).map(function (s, i) {
      /* -1, not i: slotView's last-resort item lookup reads party.state.binds
         BY INDEX, and a button handed 0 or 1 would inherit whatever is on key
         1 or key 2. A button is never in that array, so it must never index
         into it. */
      var v = slotView(s, -1);
      v.slot = (s && s.slot) || (i === 0 ? 'mouseL' : 'mouseR');
      v.key = (s && s.key) || (v.slot === 'mouseR' ? 'RMB' : 'LMB');
      v.mouse = true;
      return v;
    });
    return keys.concat(mice);
  }
  /* What the hotbar was BUILT for. A pocket key appearing (or an item bind
     changing) has to rebuild the DOM; a count ticking down must not. */
  function hotbarSig(views) {
    // the slot id is part of the shape: binding an ability to RMB changes the
    // strip even when the nine keys are untouched
    return views.map(function (v) { return v.slot + '/' + v.kind + ':' + (v.id || '-'); }).join('|');
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
    views.forEach(function (v) {
      if (v.kind === 'item') { els.hotbar.appendChild(buildItemSlot(v)); return; }
      var s = v.raw || {};
      var d = ui.el('div', 'b3d-slot' + (s.id ? '' : ' empty') + (v.mouse ? ' mouse' : ''));
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
      (function (slot) { d.addEventListener('click', function () { fire(slot); }); })(v.slot);
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
  function buildItemSlot(v) {
    var d = ui.el('div', 'b3d-slot item' + (v.mouse ? ' mouse' : '') +
      (v.passive ? ' passive' : ''));
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
    (function (slot) { d.addEventListener('click', function () { fire(slot); }); })(v.slot);
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
    /* §27C: a passive reads ARMED, never READY. `ready` is the class that says
       "press this", so a potion must never wear it; `armed` is its own light
       and it is the whole difference between a key you push and a key that
       pushes itself. `dim` still tracks an empty pocket, because an unarmed
       potion IS spent — it just has nothing to say about cooldowns. */
    if (v.passive) {
      d.classList.add('passive');
      d.classList.remove('ready', 'cooling');
      d.classList.toggle('armed', !!v.armed);
      d.classList.toggle('out', v.count <= 0);
      d.classList.toggle('dim', !v.armed);
      d.title = v.name + ' — ' + v.count + ' carried · ' +
                (v.armed ? 'ARMED: it spends itself if you fall.' : 'None left.') +
                (v.desc ? '\n' + v.desc : '');
      return;
    }
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

  /* Where knight `index` is STANDING, or null if this build cannot say.
     Two rungs, best first, and both are feature-detected because the 3D layer
     publishes neither on the no-WebGL stub. Split out of knightAnchor so §25's
     wave can ask the same question for a completely different reason — it
     needs the knight's position to decide which way to throw him, not where to
     hang a label — and so a real per-knight accessor only has to land once. */
  function knightWorldPos(index) {
    if (typeof a3d.knightPoint === 'function') {
      var p = a3d.knightPoint(index);
      if (p) return p;
    }
    /* debug() publishes the LEADER's position and only his, so it is exact for
       index 0 — which is the whole fight for the first rounds, and the rounds
       where you first meet the rock. */
    if (index === 0 && a3d.debug) {
      var dbg = a3d.debug();
      if (dbg && dbg.knightPos) return { x: dbg.knightPos[0], z: dbg.knightPos[1] };
    }
    return null;
  }

  function knightAnchor(index, ordinal) {
    var pt = knightWorldPos(index);
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

  /* ---------- actions ----------
     §27B: `slot` is a key index 0-8 OR 'mouseL'/'mouseR'. It is handed straight
     to combat3, which is the only thing that knows how to resolve either — the
     one rule being that we never turn a button into a number on the way. */
  function viewOf(snapNow, slot) {
    if (!snapNow) return null;
    var all = slotViews(snapNow);
    for (var i = 0; i < all.length; i++) if (all[i].slot === slot) return all[i];
    return null;
  }
  function fire(slot) {
    if (!active || C3.isOver()) return;
    var snapNow = C3.snapshot();
    var view = viewOf(snapNow, slot);
    /* §27C: a passive is never pressed. Refused here as well as in the engine
       so the fumbled key reads as an explanation instead of a failure — and so
       the click never even reaches the bag. */
    if (view && view.passive) {
      log(view.name + ' is armed — it drinks itself if you fall.');
      return;
    }
    var r = C3.press(slot);
    if (!r.ok) { log(r.reason || 'Not ready.'); return; }
    fireResult(r, view);
  }

  /* Everything that happens AFTER a successful press, split out so the mouse
     path (§27B) plays the identical animation and log instead of a second,
     drifting copy of it. */
  function fireResult(r, view) {
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

  /* ------------------------------------------------ §25 Water Wave: the lane
     The wave's damage is a courtesy — power 40, the lowest in the kit, less
     than one punch. What the key actually buys is the DISPLACEMENT, and the
     displacement is LATERAL: every knight the cone catches is thrown
     perpendicular to your facing, toward whichever side he is already nearest,
     so the line PARTS and you can walk down the middle. Shoving them straight
     back would only re-form the same wall three metres further on and leave
     you exactly as cornered, which is the situation you cast it in.

     Both halves are feature-detected, independently:
       - `ab.shove` in the ability data — no block, no displacement, and every
         other arc ability keeps falling through this branch untouched.
       - `arena3d.shove` — the engine surface that owns containment. Without it
         the wave still casts, still damages, still reads on screen; it simply
         moves nobody. It cannot be allowed to throw: this ability ships on the
         level-4 ladder row, and the 3D layer may be the no-WebGL stub.
     Deliberately NOT ours: breaking his wind-up (`shove.breaksWindup`) and
     clamping the throw to the navgrid or the Ring's kerb. Those belong to
     arena3d.shove, which owns clearAttack and the §22/§24 containment rules —
     its signature takes no flags because it reads them off the same data. And
     there is no stun here: that is the asteroid's (§23). He loses his footing,
     then he comes back. */

  /* The camera's RIGHT in world XZ, with the player's position along for the
     ride so a caller needs one debug() read rather than two. arena3d builds
     forward as (-sin yaw, -cos yaw) and strafe-right as (cos yaw, -sin yaw)
     — see its doEvade — so this is that same right-hand side rather than a
     fresh convention that would silently mirror the wave the first time either
     file moved. Unit length by construction. null = this build publishes no
     yaw, and without a facing there is no perpendicular to throw along. */
  function cameraRight() {
    var d = a3d.debug ? a3d.debug() : null;
    if (!d || typeof d.yaw !== 'number') return null;
    return { x: Math.cos(d.yaw), z: -Math.sin(d.yaw),
             px: d.x || 0, pz: d.z || 0 };
  }

  /* Inside this band, "which side is he on" is noise: a knight walking a
     beeline at you stands ON the centre line, and taking the sign of a number
     that small would throw him left one cast and right the next. So within
     15cm the side comes from his squad INDEX instead — fixed for the whole
     fight, never jittering, and it splits a stack of centred knights to both
     sides rather than firing them all the same way, which is the parting the
     ability is named for. */
  var WAVE_CENTRE_EPS = 0.15;

  /* Which way each caught knight goes. Built BEFORE anything is applied, so
     every side is decided against the same pre-wave snapshot of the floor.

     Two sources, and the ENGINE's answer wins when it has one — the same rule
     the stun follows with `res.stunned`. arena3d.waveTargets sees the yaw and
     every knight's position first-hand; this screen only sees what the 3D
     layer chooses to publish, and without a per-knight accessor that is the
     leader alone. Identical rule either way (perpendicular to your facing,
     toward the side he is already nearest, index as the tie-break), so the two
     agree — the fallback exists so the wave still parts a line on a build
     whose arena predates §25, not to second-guess one that does not. */
  function shovePlan(ab, targets) {
    var plan = [], i;
    if (typeof a3d.waveTargets === 'function') {
      var list = a3d.waveTargets(ab) || [];
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        plan.push({ index: t.index, sign: t.side < 0 ? -1 : 1,
                    dx: t.dirX, dz: t.dirZ,
                    distance: t.distance, ms: t.ms });
      }
      return plan;
    }
    var right = cameraRight();
    if (!right || !targets) return plan;
    for (i = 0; i < targets.length; i++) {
      var ti = targets[i];
      var pt = knightWorldPos(ti);
      /* Signed distance from your centre line: positive is your right. */
      var side = pt ? (pt.x - right.px) * right.x + (pt.z - right.pz) * right.z : 0;
      /* A knight this build cannot locate lands in the same branch as one
         standing dead centre, on purpose: one deterministic rule, no random,
         and a squad still comes apart instead of drifting one way. */
      var sign = (Math.abs(side) > WAVE_CENTRE_EPS) ? (side > 0 ? 1 : -1)
                                                    : ((ti % 2) ? -1 : 1);
      plan.push({ index: ti, sign: sign, dx: right.x * sign, dz: right.z * sign });
    }
    return plan;
  }

  /* Throw them. Runs AFTER the damage so a knight the wave killed is never
     shoved — the same rule §23 keeps for the stun: he is going down and the
     death animation owns that body. `shove` is read defensively the way
     `stun` is: only an explicit `false` counts as a refusal, so an engine that
     returns nothing is still taken at its word that it moved him — but here a
     `false` is also a real and expected answer, because a knight already flat
     against the stone on the side the wave throws him has not been thrown. */
  function applyShove(ab, plan) {
    var out = { moved: 0, left: 0, right: 0 };
    var sh = ab && ab.shove;
    if (!sh || !plan.length || typeof a3d.shove !== 'function') return out;
    var snap = C3.snapshot();
    var each = (snap && snap.enemy && snap.enemy.each) || null;
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      var e = each ? each[p.index] : null;
      if (e && e.alive === false) continue;
      // the metres and the flight time are the ability's; a plan built by the
      // engine already carries them, and both spell the same data.
      var dist = p.distance != null ? p.distance : (sh.distance || 3.2);
      var ms = p.ms != null ? p.ms : (sh.ms || 300);
      if (a3d.shove(p.index, p.dx, p.dz, dist, ms) === false) continue;
      out.moved++;
      if (p.sign > 0) out.right++; else out.left++;
    }
    return out;
  }

  /* ---------- enemy AI loop ---------- */
  /* Resolve one hit window. Three shapes:
       - arc abilities hit whoever is inside your reach/facing cone
       - §21 SPLASH abilities (the asteroid) hit whoever is standing in the
         crater, regardless of where you happen to be looking by then
       - §25 SHOVE abilities (the wave) hit the same cone as an arc ability
         and then throw what they caught out of the way
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
    /* §25: the wave. Its DAMAGE goes through the ordinary arc path — the same
       abilityTargets cone every other reach/arc ability is priced by, so it
       gains nothing by being special. data/abilities.js states that cone twice
       on purpose: `range`/`arc` for this test, `cone.reach`/`cone.halfAngle`
       for the water and the throw, the same shape by construction.
       Order matters. The plan (which way each of them goes) is built from the
       pre-wave floor, the damage lands next, and only then are the survivors
       thrown — so nobody's position is read after he has started moving and
       nobody is thrown after he has been killed. */
    if (ab && ab.shove) {
      a3d.showSign(false);          // cast:'sign' — the hands drop as it goes out
      /* Green, not the gold the tornado and the rock get: this splash is
         announcing an ESCAPE, and a gold number-flash would promise damage the
         wave deliberately does not do. */
      splash('WATER WAVE', 'evade');
      // the sheet of water itself, if this arena can draw one. It takes the
      // whole ability: the cone it fills and how long it takes to cross are
      // the same numbers the shove is paid out on.
      if (typeof a3d.spawnWave === 'function') a3d.spawnWave(ab);
      var plan = shovePlan(ab, targets);
      applyHits(e.abilityId, targets, null);
      var thrown = applyShove(ab, plan);
      if (thrown.moved) {
        log('The water throws ' + thrown.moved +
            (thrown.moved === 1 ? ' knight' : ' knights') + ' aside' +
            (thrown.left && thrown.right ? ' — ' + thrown.left + ' left, ' +
             thrown.right + ' right' : '') + '. The lane is open.');
      }
      return;
    }
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
      /* §25: on a geometric MISS the engine is not asked at all. It used to be
         called with `null` "so the miss went through one path", and that null
         fell through combat3's guards into the damage maths — the bar dropped
         while this very line said the blade found nothing. The rule is now
         flat: damage is only ever requested on a TRUE hit test, and the dodge
         feedback is rendered from `res.hit` alone. combat3 keeps its own null
         guard as the backstop; neither end relies on the other.

         Two different things happen here and they are named apart on purpose:
           DODGED! — his blade never reached you. You were out of reach or out
                     of the arc when the window opened; footwork won it, and
                     it cost nothing but the ground you gave up.
           EVADED! — it WOULD have landed and the i-frames from SPACE ate it.
                     You paid stamina for that one, and the timing was yours. */
      var out = res.hit ? C3.takeHit(windowPattern(pattern, res)) : null;
      if (!res.hit || (out && (out.evaded || out.missed))) {
        splash(res.hit ? 'EVADED!' : 'DODGED!', 'evade');
        log('The blade splits empty air.');
      } else if (out) {
        splash('-' + out.dmg, 'hurt');
        flashHurt();
        log(pattern.name + ' lands: ' + out.dmg + '.' +
            (windows > 1 ? '  (' + landed + '/' + windows + ')' : ''));
        /* §27C: that blow killed you and a bound potion spent itself instead.
           It gets its own banner rather than a line in the log, because the
           player has to know INSTANTLY that they are still alive and still
           the leader — the alternative reading of a full-screen hurt flash at
           zero life is "the run is over", and they will stop playing. Read
           from the takeHit return, which is the only frame it is non-null. */
        if (out.revived) {
          prompt('ADRENALINE', 'banner', 1600);
          splash('+' + out.revived.hp, 'evade');
          log(out.revived.name + ' drinks itself — back up at ' + out.revived.hp +
              ' life.  (' + out.revived.count + ' left)');
          refresh();                       // the potion slot's count, this frame
        }
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
  var mouseHandler = null, ctxHandler = null;
  function wireKeys() {
    if (keyHandler) return;
    keyHandler = function (e) {
      if (!active || ui.current() !== 'battle3d') return;
      if (e.code === 'Space') { e.preventDefault(); doEvade(); return; }
      var m = /^Digit([1-9])$/.exec(e.code);
      if (m) { e.preventDefault(); fire(parseInt(m[1], 10) - 1); }
    };
    window.addEventListener('keydown', keyHandler);

    /* §27B: LMB and RMB are hotbar slots — IN THE ARENA ONLY.
       That restriction is not enforced here by checking a screen name; it is
       enforced by WHERE this listener lives. It is added when a fight begins
       and removed in unwireKeys() when it ends, so in the room these two
       buttons are never anything but §16's hands and grab — the room's own
       handlers in engine/world3d.js are untouched and never consult combat3.

       `handled` from combat3.mousePress() is the whole protocol: false means
       this click was not a bind and the arena's own click (pointer lock,
       click-to-engage) must run exactly as before; true means the button fired
       its slot — refusals included — and nothing else may also happen on it.
       That is what stops a bound button from ALSO grabbing or engaging.

       Bound to the window in the capture phase so it beats the canvas's own
       click handler, and `handled` decides whether that handler ever sees it. */
    mouseHandler = function (e) {
      if (!active || ui.current() !== 'battle3d') return;
      if (!C3.mousePress) return;                    // older engine: keys only
      /* Not while the cursor is loose. An unlocked arena click is the player
         asking for the mouse back — engine/arena3d.js turns it into a
         requestPointerLock — and firing a spell on it would spend a cooldown
         on the click that only got them moving again. Same rule the room uses
         for grabs, for the same reason. */
      var dbg = a3d && a3d.debug ? a3d.debug() : null;
      if (dbg && dbg.locked === false) return;
      var res = C3.mousePress(e.button);
      if (!res || !res.handled) return;              // not a bind — let it through
      e.preventDefault();
      e.stopPropagation();
      var r = res.result || {};
      if (!r.ok) { log(r.reason || 'Not ready.'); return; }
      fireResult(r, viewOf(C3.snapshot(), res.slot));
    };
    // RMB opens the context menu over the canvas otherwise, which eats the fight
    ctxHandler = function (e) { if (active && ui.current() === 'battle3d') e.preventDefault(); };
    window.addEventListener('mousedown', mouseHandler, true);
    window.addEventListener('contextmenu', ctxHandler, true);
  }
  function unwireKeys() {
    if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (mouseHandler) { window.removeEventListener('mousedown', mouseHandler, true); mouseHandler = null; }
    if (ctxHandler) { window.removeEventListener('contextmenu', ctxHandler, true); ctxHandler = null; }
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

  /* §27E: the ONLY place a run can end, so the only place a record can be
     claimed. The clock is frozen the instant the panel is built — before the
     player reads a word of it — so the seconds they spend deciding whether to
     type a name are not billed to the run. The prompt itself is deferred to
     the "Begin again" click for one reason: the defeat card is the story
     beat, and stacking a name box over it turns the end of a run into a form.

     `runStats.round` is the round they were ON when they fell, which is the
     round REACHED — combat3 only bumps it after a round is cleared.

     Nothing here reads or restores run state; the record is written, then
     end('defeat') runs exactly as it always did and scene.onBattleEnd()
     starts a brand-new run (§15 permadeath is untouched by any of this). */
  function records() { return CHLOE.engine.records; }
  function runRound() {
    return Math.max(1, (party.state.runStats && party.state.runStats.round) || 1);
  }
  /* Freeze now, ask later. Returns the frozen ms so the panel can show it. */
  function freezeRun() {
    var r = records();
    return (r && typeof r.stop === 'function') ? r.stop() : 0;
  }
  /* Claim the record if this run earned one, THEN carry on. `after` always
     runs — skipped name, rejected name, missing module, thrown prompt — because
     it is the thing that starts the next run, and a player must never be
     stranded on a dead panel by a board that failed to open. */
  function claimRecord(round, timeMs, after) {
    var r = records();
    if (!r || typeof r.isRecord !== 'function' || !r.isRecord(round)) { after(); return; }
    var done = false;
    function once() { if (done) { return; } done = true; after(); }
    try {
      r.prompt(round, timeMs, function () {
        /* Repaint the wall so the board in the room already carries the new
           row when the fresh run walks in. Guarded: world3d owns the frame and
           may not be up yet on this path. */
        try {
          var w = CHLOE.engine.world3d;
          if (w && typeof w.refreshPanels === 'function') { w.refreshPanels(); }
        } catch (e) { /* the room will repaint on entry anyway */ }
        once();
      });
    } catch (e) {
      console.warn('CHLOE battle3d: the record prompt failed to open — ' + e.message);
      once();
    }
  }

  function showDefeat() {
    var runMs = freezeRun();
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
    var round = runRound();
    var rec = records();
    if (rec && typeof rec.isRecord === 'function' && rec.isRecord(round)) {
      dl.appendChild(ui.el('div', 'lvl', '🏆 Round ' + round + ' in ' + rec.fmtTime(runMs) +
        ' — the best this browser has seen. Name it on the way out.'));
    }
    card.appendChild(dl);
    var b = ui.el('button', null, 'Begin again');
    b.addEventListener('click', function () {
      if (b.disabled) { return; }
      b.disabled = true;                     // one run-end, one record
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      claimRecord(round, runMs, function () { end('defeat'); });
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
    /* §27B/C added `slot`, `mouse`, `passive`/`armed` — the two mouse buttons
       ride on the end of this list exactly as they do on the strip, so a test
       can prove they were LABELLED (key 'LMB'/'RMB', never a number) and that
       an armed potion never wears the pressable light. */
    _slots: function () {
      var snap = C3 && C3.snapshot ? C3.snapshot() : null;
      return slotViews(snap).map(function (v, i) {
        var d = slotEls[i];
        return {
          slot: v.slot, key: v.key, kind: v.kind, id: v.id, count: v.count,
          ready: v.ready, mouse: !!v.mouse, passive: !!v.passive, armed: !!v.armed,
          badge: (d && d._count) ? d._count.textContent : null,
          cls: d ? d.className : null,
          dim: !!(d && d.classList.contains('dim')),
          out: !!(d && d.classList.contains('out'))
        };
      });
    },
    /* §27B: fire a slot the way an input event would, so "LMB casts in the
       arena" is driven through the same code a click reaches. */
    _press: fire,
    _mouse: function (button) {
      if (!C3 || !C3.mousePress) return { handled: false };
      var res = C3.mousePress(button);
      if (res && res.handled && res.result && res.result.ok) {
        fireResult(res.result, viewOf(C3.snapshot(), res.slot));
      }
      return res;
    },
    /* §25: the wave's two halves, exported for the same reason _hits is — the
       only route to them is resolveStrike, which runs off rAF and paints. Both
       wire the layer refs the way begin() does, so a test can stand a squad up
       in a stub arena with no canvas at all and read back which side each
       caught knight was thrown toward (_wavePlan) and who actually moved
       (_waveShove, which is also where "a knight the wave killed is never
       thrown" and "no arena3d.shove means no displacement" are provable). */
    _wavePlan: function (ab, targets) {
      C3 = C3 || CHLOE.engine.combat3; a3d = a3d || CHLOE.engine.arena3d;
      return shovePlan(ab, targets);
    },
    _waveShove: function (ab, plan) {
      C3 = C3 || CHLOE.engine.combat3; a3d = a3d || CHLOE.engine.arena3d;
      return applyShove(ab, plan);
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
