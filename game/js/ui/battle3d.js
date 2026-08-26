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
  var cloneFight = false;          // mirror-fight mode
  var cloneTimer = null, nextCloneSwingAt = 0;
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
      /* §29: a magazine reads "4/6" and a charge stack reads "2". They are
         different questions — a stack asks "how many uses do I have banked",
         a magazine asks "how much is left before the reload" — and the
         denominator is the only thing that makes the second one answerable at
         a glance mid-burst. The engine says which it is (`s.magazine`); this
         never infers it from the count. */
      if (d._ch) {
        d._ch.textContent = s.magazine ? (s.charges + '/' + s.maxCharges)
                          : (s.maxCharges > 1 ? String(s.charges) : '');
      }
      // an empty magazine is not merely "cooling down": it is out
      d.classList.toggle('out', !!s.empty);
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
    /* §30: the plate names what is ACTUALLY on the floor, not the round.
       It used to print knighttree.level() — the round baseline — which was
       already only approximately true under §28 and becomes a flat lie once
       the squad is a ladder: round 5 would read 'Lv 5' while four of the
       five knights are below it. The per-knight numbers have been in the
       snapshot since §28 (`each[].level`, `levels`) with nothing reading
       them; this reads them.
       A RANGE, not the list: nine numbers do not fit a 420px plate, and the
       range is what the player needs — the top of it is the knight who will
       hurt them. Dead knights drop out, so as the veteran falls the ceiling
       visibly comes down with him. */
    var pool = (snap.enemy.each || [])
      .filter(function (e) { return e.alive; })
      .map(function (e) { return e.level || 1; });
    /* The fallbacks are for a build whose snapshot has no per-knight data
       (an engine older than §28), NOT for an empty floor. Falling back to
       `levels` when nothing is alive re-admitted the dead: refresh() runs
       once more before finish(), so the plate flashed the whole historical
       ladder — 'Lv 1-8' — on the exact frame the last knight fell. With no
       living knight there is no level to name, and the plate says so by
       saying nothing. */
    if (!pool.length && !(snap.enemy.each && snap.enemy.each.length)) {
      pool = (snap.enemy.levels || []).slice();
      if (!pool.length && kt) { pool = [kt.level()]; }
    }
    var lo = pool.length ? Math.min.apply(null, pool) : null;
    var hi = pool.length ? Math.max.apply(null, pool) : null;
    var lvText = (lo == null) ? ''
               : ('  ·  Lv ' + (lo === hi ? lo : lo + '-' + hi));
    els.enemyName.textContent = snap.enemy.name + lvText +
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

  /* ------------------------------------------------- §29 the hit marker
     The third of the three pictures a hitscan shot owes the player (the flash
     and the tracer are arena3d's; see its §29 block). It answers a question
     none of the others can: the tracer proves the round went where you aimed,
     the damage number proves SOMETHING was hurt — but the number floats over
     the knight, several metres from where you are looking, and at 3.5 rounds
     a second you cannot track it. The marker is on the crosshair, which is
     the one place on screen your eye is already fixed, so a burst reads as
     four ticks and two blanks instead of as a wall of numbers.

     Styled inline rather than through a class on purpose: this is the only
     element in the file that has to live exactly on the centre of the canvas,
     the CSS for this screen is another session's file, and a marker that
     depends on a rule somebody else has to add first is a marker that ships
     invisible. Two bars, an X, one animation, no keyframes. */
  function hitMark(killed) {
    var wrap = ui.el('div', 'b3d-hitmark');
    wrap.style.cssText = 'position:absolute;left:50%;top:50%;width:30px;height:30px;' +
      'margin:-15px 0 0 -15px;pointer-events:none;z-index:45;opacity:1;' +
      'transform:scale(0.62);transition:opacity 200ms linear,transform 200ms ease-out;';
    /* A kill goes red and a touch bigger — the one distinction worth drawing,
       because "he is down" changes what you do next and "he is hurt" does not. */
    var col = killed ? '#ff6a5a' : '#ffe9c2';
    var glow = killed ? 'rgba(255,80,60,.95)' : 'rgba(255,190,90,.9)';
    for (var i = 0; i < 2; i++) {
      var bar = ui.el('div');
      bar.style.cssText = 'position:absolute;left:50%;top:50%;width:2px;height:26px;' +
        'margin:-13px 0 0 -1px;background:' + col + ';box-shadow:0 0 7px ' + glow + ';' +
        'transform:rotate(' + (i ? -45 : 45) + 'deg);';
      wrap.appendChild(bar);
    }
    root().appendChild(wrap);
    // one frame later, so the transition has a start state to run from
    later(function () {
      wrap.style.opacity = '0';
      wrap.style.transform = killed ? 'scale(1.5)' : 'scale(1.15)';
    }, 16);
    later(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 260);
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
    if (!r.ok) { pressRefused(r, view); return; }
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
    } else if (a.hitscan) {
      /* §29: the gun does NOT go through playAbility, and this is the one
         branch that has to be here rather than in the engine. playAbility
         falls back to the `Punch` clip for any ability that names no `anim`
         (§17: several abilities share one clip), so routing the pistol through
         it would put the fists on screen throwing a flurry while the gun in
         the same hand fired — and engine/gunrig.js would keep the pistol drawn
         through it, because it correctly reads "the arms are busy with MY
         cast". The pistol's own recoil is the animation, so ask for that and
         nothing else. */
      if (typeof a3d.gunFire === 'function') a3d.gunFire();
    } else {
      a3d.playAbility(a.id, a.anim, a.animSpeed, total + (a.recoverMs || 0));
    }
    log(a.name);
    /* §29: the round that empties the magazine starts the reload, and the
       reload is 3.2 seconds you have to be told about — the hotbar dial shows
       WHEN it ends, this says THAT it started. Asked of the engine rather than
       counted here, because the engine owns the magazine and a second count
       would be a second thing to keep true. */
    if (a.magazine && C3.readiness) {
      var rd = C3.readiness(a.id);
      if (rd && rd.empty) prompt('RELOADING', 'banner', a.rechargeMs || 3000);
    }
  }

  /* §29: a press that was refused. Almost all of them are one line of HUD
     text — but an empty magazine is a REFUSAL WITH A PICTURE, and it has to
     be, because it is the only one the player caused on purpose and the only
     one they have to plan around. The dry click is diegetic (arena3d kicks a
     spark of a flash with no tracer behind it) so the message is "the weapon
     is empty" rather than "the game ignored you".

     Decided off `r.empty`, never off the wording: combat3 sets that flag
     precisely so this branch does not have to string-match 'Reloading'. */
  function pressRefused(r, view) {
    if (r && r.empty) {
      if (typeof a3d.gunDry === 'function') a3d.gunDry();
      splash('*click*', 'miss');
      var nm = (r.ability && r.ability.name) || (view && view.name) || 'It';
      log(nm + ' is empty. Reloading — you do not get to choose when.');
      return;
    }
    log((r && r.reason) || 'Not ready.');
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
    /* Clone fight: ALL player ability hits land on the single clone, not the
       knight squad. The damage pipeline bypasses combat3.hitEnemy entirely and
       goes straight to cloneai.takeDamage, so no knight needs to exist. */
    if (cloneFight && ab) {
      var cloneai = CHLOE.engine.cloneai;
      var cs = cloneai && cloneai.state();
      if (cs && cs.alive) {
        var dmg = C3.playerDamage ? C3.playerDamage(ab) : 0;
        if (dmg > 0) {
          var killed = cloneai.takeDamage(dmg);
          splash('-' + dmg, 'dmg');
          log(ab.name + ': ' + dmg + '.');
          if (killed) { if (C3.cloneEnd) C3.cloneEnd('victory'); finish(); }
        }
      }
      return;
    }
    /* §29 FIRST, because a hitscan shares nothing with the paths below. It has
       no cone, no splash, no travel time and no ability to be dodged by
       walking out of an arc — the ray was solved and answered in one call, and
       everything after that is reporting. */
    if (ab && ab.hitscan) { resolveShot(ab, e); return; }
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

  /* §29 THE SHOT, START TO FINISH, ON ONE FRAME.

     Everything here happens inside the `strike` event, which is the tick
     combat3 says the hit window opened on — §21's one clock. That matters more
     for this ability than for any other in the game: a tornado can afford its
     picture to be a frame off because you watch it for two seconds, and a
     bullet cannot, because the flash, the tracer, the marker and the number
     ARE the whole event. Resolve, draw, report, in that order, once.

     THE RAY IS ASKED FOR EXACTLY ONCE. arena3d answers with the hit AND the
     line it travelled, and that same object is handed to gunShot() — so the
     tracer is the ray drawn rather than a second line rebuilt from the same
     inputs. Two calls would be two rays: the camera moves every frame, and the
     second one would be aimed a few milliradians from the one that decided the
     damage. The picture would be a lie about the hit test roughly a third of
     the time, and it would be a subtle enough lie to be blamed on the netcode
     of a game that has none.

     A MISS STILL DRAWS. The flash and the tracer fire whether or not anything
     was hit — that is the entire reason they exist (see arena3d's §29 block):
     without them a missed shot is indistinguishable from a press that never
     registered, and the player learns "the gun is unreliable" instead of "I
     was aiming left". */
  function resolveShot(ab, e) {
    var info = (typeof a3d.hitscan === 'function') ? a3d.hitscan(ab) : null;
    if (!info) { applyHits(e.abilityId, [], null); return; }
    if (typeof a3d.gunShot === 'function') a3d.gunShot(info);

    if (!info.hit) {
      splash('miss', 'miss');
      /* Name WHY, because the two misses ask for different corrections: wide
         means aim, stone means move. */
      log(info.blocked ? 'The round buries itself in the stone.'
                       : 'The round goes wide into the dark.');
      return;
    }
    /* `info.mult` is the distance falloff (data/abilities.js `falloff`),
       carried into applyHits as a plain multiplier so it multiplies WITH the
       §22 stagger bonus rather than replacing it — a staggered knight shot at
       20m is both further away and still reeling, and both facts should be in
       the number. */
    applyHits(e.abilityId, [info.index], null, info.mult);
    hitMark(shotKilled);
    if (info.headshot) {
      splash('HEADSHOT', 'super');
      log('Headshot — double damage!');
    } else if (info.dist > (ab.falloff && ab.falloff.full ? ab.falloff.full : info.dist)) {
      log('Long shot — ' + info.dist.toFixed(1) + 'm, and it landed soft.');
    }
  }
  /* Set by applyHits for the one caller that needs it. A return value would be
     cleaner, but applyHits is called from four places that all ignore what it
     returns and this stays a one-line change to the shared path rather than a
     new contract three callers have to start honouring. */
  var shotKilled = false;

  function applyHits(abilityId, targets, tag, extraMult) {
    shotKilled = false;
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
      var stag = a3d.staggerMult ? (a3d.staggerMult(ti) || 1) : 1;
      /* §29: the caller may add a multiplier of its own — today that is the
         9mm's distance falloff. It MULTIPLIES with the stagger bonus instead
         of replacing it, and the label below still reads `stag` alone, or a
         long shot at a reeling knight would come back under 1.0 and silently
         stop saying STAGGERED while he was very much staggered. */
      var mult = stag * (extraMult > 0 ? extraMult : 1);
      var res = C3.hitEnemy(abilityId, mult, ti);
      if (!res) return;
      if (res.killed) shotKilled = true;
      a3d.flinch(res.dmg, res.killed, ti);
      if (!shown++) {
        splash('-' + res.dmg + (stag > 1 ? ' STAGGERED' : '') +
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
    /* §30: WHO swings is chosen BEFORE what he swings, and the pattern is
       rolled from his own level. Rolling the round's pool first and handing
       it to whoever was picked is what left arena3d's one open downgrade gap
       standing: ground_slam is the only 'backoff' pattern, so a knight below
       level 5 handed one throws it unchanged — the weakest knight on the
       floor landing the heaviest swing in the game. §28 could accept that
       because every knight climbed past 5 within ~35s; under §30's ladder
       the junior end never gets there, so the gap had to close at the roll
       instead. arena3d's own comment prescribed exactly this fix. */
    var snap = C3.snapshot();
    var living = [];
    snap.enemy.each.forEach(function (e, i) { if (e.alive) living.push(i); });
    if (!living.length) return;
    var who = living[Math.floor(Math.random() * living.length)];
    var swingerLevel = null;
    if (a3d && typeof a3d.knightLevels === 'function') {
      swingerLevel = a3d.knightLevels(snap.enemy.count)[who];
    }
    if (swingerLevel == null && snap.enemy.each[who]) {
      swingerLevel = snap.enemy.each[who].level;
    }
    var pattern = pickPattern(swingerLevel);
    if (!pattern) return;
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
      /* §30: name the striker. takeHit has taken an index since §28 and this
         call never passed one, so it fell back to arena3d.striker() — which
         answers -1 on the no-WebGL API, pricing every knight's blow off the
         round baseline. That was self-consistent while the stub also reported
         every knight at the baseline; now that the stub returns the ladder,
         a level-1 newcomer would have kept hitting like the veteran. `who` is
         already in hand, so there is no reason to guess. */
      var out = res.hit ? C3.takeHit(windowPattern(pattern, res), who) : null;
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
  function knownPatterns(level) {
    var all = (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
    var kt = CHLOE.engine.knighttree;
    if (!kt) return all;
    /* §30: the pool is HIS, not the round's. Passing a level rolls from what
       that knight has actually learned; omitting it keeps the round baseline
       for any caller that does not know who is swinging. */
    var ids = kt.patterns(level == null ? kt.level() : level);
    var out = {};
    ids.forEach(function (id) { if (all[id]) out[id] = all[id]; });
    return Object.keys(out).length ? out : all;
  }

  function pickPattern(level) {
    var pats = knownPatterns(level);
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
      } else if (e.t === 'reload') {
        /* §29: a MAGAZINE came back whole. Distinct from combat3's 'charge'
           event (one more use trickled in) because only this one is worth
           saying out loud — it is the end of the 3.2 seconds the player spent
           unable to shoot, and they are usually looking at the knight rather
           than at the hotbar dial when it lands. */
        var rab = (CHLOE.data.abilities || {})[e.abilityId];
        splash('RELOADED', 'evade');
        log((rab && rab.name ? rab.name : 'Magazine') + ' — ' + e.charges + ' rounds.');
      }
    }

    if (!C3.isOver() && now >= nextSwingAt) {
      scheduleSwing(now);
      enemySwing();
    }

    /* Clone fight: tick the AI and swing on its own cadence. */
    if (cloneFight && !C3.isOver()) {
      var cloneai = CHLOE.engine.cloneai;
      if (cloneai) {
        cloneai.tick(dt);
        var cs = cloneai.state();
        if (cs && cs.alive && now >= nextCloneSwingAt) {
          scheduleCloneSwing(now);
          cloneSwing();
        }
        /* The clone is a single enemy — end the fight if the player kills it. */
        if (cs && !cs.alive && !C3.isOver()) {
          if (C3.cloneEnd) C3.cloneEnd('victory');
          finish();
        }
      }
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
  /* §31 wheel state. NOTCH_DELTA is the travel one detent is worth: a classic
     mouse wheel reports 100 per notch in Chrome and a trackpad reports a
     stream of small deltas, so 100 fires once per notch on the former and
     once per deliberate flick on the latter. WHEEL_OPTS is a shared constant
     because add and remove must be handed the SAME options object. */
  var wheelHandler = null, wheelAccum = 0;
  var NOTCH_DELTA = 100;
  var WHEEL_OPTS = { passive: false, capture: true };
  var mouseHandler = null, ctxHandler = null;
  function wireKeys() {
    if (keyHandler) return;
    wheelAccum = 0;
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
      var mv = viewOf(C3.snapshot(), res.slot);
      if (!r.ok) { pressRefused(r, mv); return; }
      fireResult(r, mv);
    };
    // RMB opens the context menu over the canvas otherwise, which eats the fight
    ctxHandler = function (e) { if (active && ui.current() === 'battle3d') e.preventDefault(); };
    /* §31 THE WHEEL. Same arena-only enforcement as the buttons above — it
       lives and dies with the fight, so in the room a notch is nothing.

       THREE THINGS THIS HANDLER HAS TO GET RIGHT, and each of them is a bug
       if it does not:
       1. ONE NOTCH IS SEVERAL EVENTS. Trackpads and free-spin wheels emit a
          stream of small deltas; a naive handler spends a bandage on the
          first and then prints 'Pockets cooling down' for every one after it.
          Deltas accumulate and fire once per NOTCH_DELTA worth of travel, and
          the accumulator resets on direction change so a flick back the other
          way is immediate rather than having to unwind the first flick.
       2. UNBOUND MUST NOT preventDefault. `handled:false` means the page keeps
          its scroll — the bind screen and the shop are scrollable containers
          and a greedy wheel handler would freeze both.
       3. PASSIVE LISTENERS CANNOT preventDefault. Chrome makes window-level
          wheel passive by default, so {passive:false} is required, and
          removeEventListener must be given the identical options object or
          the listener outlives the fight. */
    wheelHandler = function (e) {
      if (!active || ui.current() !== 'battle3d') return;
      if (!C3.wheelPress) return;                    // older engine: no wheel
      var dy = e.deltaY || 0;
      if (!dy) return;
      if ((dy > 0) !== (wheelAccum > 0)) wheelAccum = 0;   // direction change
      wheelAccum += dy;
      if (Math.abs(wheelAccum) < NOTCH_DELTA) return;
      var dir = wheelAccum;
      wheelAccum = 0;
      var res = C3.wheelPress(dir);
      if (!res || !res.handled) return;              // not a bind — let it scroll
      e.preventDefault();
      e.stopPropagation();
      var r = res.result || {};
      if (!r.ok) { log(r.reason || 'Not ready.'); return; }
      fireResult(r, viewOf(C3.snapshot(), res.slot));
    };
    window.addEventListener('wheel', wheelHandler, WHEEL_OPTS);
    window.addEventListener('mousedown', mouseHandler, true);
    window.addEventListener('contextmenu', ctxHandler, true);
  }
  function unwireKeys() {
    if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (mouseHandler) { window.removeEventListener('mousedown', mouseHandler, true); mouseHandler = null; }
    /* WHEEL_OPTS is a module constant rather than a fresh object literal for
       exactly this line: an options object that does not match the one used to
       add is a listener that never comes off, and it would then eat scrolling
       in the menus for the rest of the session. */
    if (wheelHandler) { window.removeEventListener('wheel', wheelHandler, WHEEL_OPTS); wheelHandler = null; }
    if (ctxHandler) { window.removeEventListener('contextmenu', ctxHandler, true); ctxHandler = null; }
  }

  function finish() {
    if (!active) return;
    var snap = C3.snapshot();
    active = false;
    if (cloneFight) finishClone();
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

  /* Where an auto-bound ability landed, said out loud. A slot is a NUMBER or
     one of the §27B button ids, and the level-up card below used to format it
     as `'key ' + (slot + 1)` — correct for the whole game right up until §29,
     because until §29 nothing was ever auto-bound to a button. The 9mm is, and
     'mouseR' + 1 is the string "mouseR1": the level-5 card announced the gun as
     "ready on key mouseR1". That is the §25 bug class exactly — a string
     arriving where a number was assumed — and it lands on the one line whose
     entire job is telling the player which button their new weapon is on.

     The label comes from combat3.mouseLabel, the same source ui/binds.js reads,
     so the card and the bind screen cannot drift into calling one button two
     names. A build whose engine predates §27B degrades to the id itself, which
     is wrong-looking but readable — never arithmetic on a string. */
  function placedSlotLabel(slot) {
    if (C3.isMouseSlot && C3.isMouseSlot(slot)) {
      return (C3.mouseLabel ? C3.mouseLabel(slot) : String(slot));
    }
    return 'key ' + (slot + 1);
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
        /* Whose key it is, but only when that is a live question. One member
           levelled is the ordinary case and "key 4" means yours; two members
           levelled and an unattributed key 4 is worse than no line, because
           the player goes and looks at their own key 4 and finds it empty. */
        var manyChars = !!(auto.byChar && auto.byChar.length > 1);
        auto.placed.forEach(function (pl) {
          var ad = (CHLOE.data.abilities || {})[pl.abilityId] || {};
          var who = '';
          if (manyChars && pl.charId) {
            var cd = (CHLOE.data.characters || {})[pl.charId] || {};
            who = (cd.name || pl.charId) + ': ';
          }
          lines.appendChild(ui.el('div', 'lvl',
            who + (ad.icon || '•') + ' ' + (ad.name || pl.abilityId) +
            ' — ready on ' + placedSlotLabel(pl.slot)));
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

  /* ---------- clone fight ---------- */
  function startCloneFight() {
    if (!active) return;
    a3d.start();
    a3d.stopAbility();

    buildHotbar(C3.snapshot());
    refresh();
    log('You face your reflection.');
    log('Keys 1-9 to strike, SPACE to evade.');
    var snap0 = C3.snapshot();
    prompt('YOUR REFLECTION', 'banner', 2200);

    wireKeys();
    lastT = performance.now();
    nextCloneSwingAt = lastT + 1500;
    rafId = requestAnimationFrame(frame);
  }

  function cloneSwing() {
    if (!active || C3.isOver()) return;
    var cloneai = CHLOE.engine.cloneai;
    if (!cloneai) return;
    var cs = cloneai.state();
    if (!cs || !cs.alive) return;

    var snap = C3.snapshot();
    var dist = (snap && snap.enemy && snap.enemy.dist) || 4;
    var abId = cloneai.pickAbility(dist);
    if (!abId) return;

    var patternId = cloneai.abilityToPattern(abId);
    var allPats = (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
    var pattern = allPats[patternId];
    if (!pattern) return;

    cloneai.spend(abId);
    var ab = (CHLOE.data.abilities || {})[abId];
    var abName = (ab && ab.name) || abId;

    var windows = hitWindows(pattern);
    var landed = 0;
    var warn = warnSwing(pattern, 0, windows);
    a3d.telegraph(pattern, function (res) {
      dropPrompt(warn);
      if (!active || C3.isOver()) return;
      landed++;
      var out = res.hit ? C3.takeHit(windowPattern(pattern, res), -1) : null;
      if (!res.hit || (out && (out.evaded || out.missed))) {
        splash(res.hit ? 'EVADED!' : 'DODGED!', 'evade');
        log('The reflection splits empty air.');
      } else if (out) {
        splash('-' + out.dmg, 'hurt');
        flashHurt();
        log(abName + ' lands: ' + out.dmg + '.' +
            (windows > 1 ? '  (' + landed + '/' + windows + ')' : ''));
        if (out.revived) {
          prompt('ADRENALINE', 'banner', 1600);
          splash('+' + out.revived.hp, 'evade');
          refresh();
        }
      }
      if (landed < windows) warn = warnSwing(pattern, landed, windows);
      refresh();
      if (C3.isOver()) { finish(); return; }
    }, -1);
  }

  function scheduleCloneSwing(now) {
    nextCloneSwingAt = now + 1200 + Math.random() * 800;
  }

  function finishClone() {
    cloneFight = false;
    var cloneai = CHLOE.engine.cloneai;
    if (cloneai) cloneai.reset();
    cloneTimer = null;
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
    /* §31: the wheel's headless entry point. Everything downstream of the
       listener runs off rAF, which is frozen in a non-compositing tab, so
       without this the wheel would be the one input in the game whose only
       test is a human scrolling. Takes a DIRECTION ('up'/'down' or a signed
       number), not an event — the same argument wheelPress takes, and for the
       same reason: a WheelEvent.button reads 0 and would fire mouseL. */
    _wheel: function (dir) {
      if (!C3 || !C3.wheelPress) return { handled: false };
      var res = C3.wheelPress(dir);
      if (res && res.handled && res.result && res.result.ok) {
        fireResult(res.result, viewOf(C3.snapshot(), res.slot));
      }
      return res;
    },
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
    _finish: finish,

    /* ---------- mirror fight API ---------- */
    beginClone: function () {
      ui = CHLOE.ui; party = CHLOE.engine.party;
      C3 = CHLOE.engine.combat3; a3d = CHLOE.engine.arena3d;
      var cloneai = CHLOE.engine.cloneai;
      if (!cloneai) { console.warn('[battle3d] cloneai.js not loaded'); return; }

      /* Snapshot the player's current stats and loadout so the clone
         mirrors exactly what the player has right now. */
      var mem = party && party.activeMember && party.activeMember();
      var eff = (party && party.effStats) ? party.effStats(mem) : null;
      var stats = {
        hp:   (eff && eff.life) || 62,
        mana: (eff && eff.magic) || 20,
        sta:  (eff && eff.stamina) || 40,
        atk:  (eff && eff.atk) || 12,
        mag:  (eff && eff.mag) || 11,
        def:  (eff && eff.def) || 8,
        type: (eff && eff.type) || 'fire'
      };
      var abilities = [];
      if (C3 && typeof C3.knownAbilities === 'function' && mem) {
        abilities = C3.knownAbilities(mem);
      }
      cloneai.init(stats, abilities);

      /* Start the fight with the clone entry. */
      var cloneId = 'clone';
      var round = 1;
      var s = C3.start(cloneId, round);
      if (!s) { console.warn('[battle3d] cannot start clone fight'); cloneai.reset(); return; }
      if (!built) build();
      active = true;
      cloneFight = true;

      ui.show('battle3d');
      if (!inited3d) { a3d.init(els.canvas); inited3d = true; }

      /* Apply the church stage (default) so the arena has its ring, lighting
         and floor.  Without this the clone fight loads into a black void. */
      var stage = applyStage(resolveStage(round));
      curStage = stage;

      a3d.reset();
      a3d.resize();

      /* Load the arena scene (same gate as a normal fight). */
      var load = CHLOE.ui.loading;
      if (load && a3d.assetsReady && !a3d.assetsReady()) {
        load.show('Opening the mirror…');
        load.waitFor(
          function () { return a3d.assetsReady(); },
          function (setProgress) {
            var pr = a3d.assetProgress ? a3d.assetProgress() : null;
            if (pr) setProgress(pr.done, pr.total + 1, pr.done >= pr.total ? 'Lighting the candles…' : 'Opening the mirror…');
          },
          function () { load.hide(); startCloneFight(); }
        );
        return;
      }
      startCloneFight();
    }
  };
})();
