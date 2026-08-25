/* CHLOE — ui/binds.js  (Combat v3, spec §17 — the Moves screen)
   Assign known abilities to number keys 1-9 before a fight. Slots beyond the
   unlocked count are shown locked, so it is obvious that levelling is what
   widens the hotbar. Renders into the menu overlay's Moves tab, alongside the
   level ladder (§21).
   §23 adds pockets: consumables are their own group here and bind exactly like
   an ability, encoded into the same bind list as 'item:<itemId>'. Every slot
   is generic — the two extra keys the ladder hands you are NOT drawn as
   special "pocket" keys, because any key takes either kind and drawing them
   apart would teach a rule that does not exist. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.binds = (function () {
  'use strict';
  var ui, sel = { slot: 0 };

  function C3() { return CHLOE.engine.combat3; }
  function ABIL() { return CHLOE.data.abilities || {}; }
  function ITEMS() { return CHLOE.data.items || {}; }
  function typeColor(t) {
    var c = (CHLOE.data.types && CHLOE.data.types.colors) || {};
    return c[t] || '#9a939c';
  }

  /* ------------------------------------------------------------- §23 pockets
     A bind entry is either a bare ability id or the string 'item:<itemId>'.
     combat3 owns that encoding and publishes `itemIdOf`/`itemKey` so this
     screen never has to spell it — but it also has to keep rendering against
     an engine that has not grown them yet, so each one falls back to the
     literal prefix. Read the encoding, never ask "is this the new build". */
  function itemIdOf(bind) {
    var c = C3();
    if (c && typeof c.itemIdOf === 'function') return c.itemIdOf(bind) || null;
    return (typeof bind === 'string' && bind.indexOf('item:') === 0) ? bind.slice(5) : null;
  }
  function itemKey(id) {
    var c = C3();
    return (c && typeof c.itemKey === 'function') ? c.itemKey(id) : ('item:' + id);
  }
  function bagCount(id) {
    var inv = CHLOE.engine.inventory;
    return (inv && typeof inv.count === 'function') ? (inv.count(id) || 0) : 0;
  }

  /* Which items may sit on a key. The rule lives in data/items.js as a
     property of the EFFECT (§23) — ask it, never name ids here, or a future
     potion needs an edit in three files. The fallback repeats the same rule
     rather than a list, for the same reason. */
  function bindableItems() {
    var rules = CHLOE.data.itemRules || CHLOE.data.items;
    var ids;
    if (rules && typeof rules.combatUsableIds === 'function') {
      ids = rules.combatUsableIds();
    } else {
      ids = [];
      var t = ITEMS();
      for (var id in t) {
        if (!Object.prototype.hasOwnProperty.call(t, id)) continue;
        var eff = t[id] && t[id].effect;
        if (eff && (eff.hp > 0 || eff.mp > 0)) ids.push(id);
      }
    }
    /* If the engine will vet the bind, vet the LIST by the same predicate —
       offering a card that bind() is going to refuse is worse than not
       offering it. */
    var c = C3();
    if (c && typeof c.bindableItem === 'function') {
      ids = ids.filter(function (x) { return c.bindableItem(x); });
    }
    return ids;
  }

  /* One line of feedback that survives the rerender — a refused bind has to
     say why, and every click here redraws the whole tab. */
  var notice = '';

  /* Write a slot and read it straight back. bind() can refuse outright, and it
     can also accept and then validate the entry away on the next read (an
     engine that does not know about 'item:' yet drops it as an unknown
     ability). Only the read-back proves the key actually holds it. */
  function put(charId, slot, entry) {
    var r = C3().bind(charId, slot, entry);
    var back = C3().binds(charId)[slot];
    notice = (back === (entry || null)) ? ''
      : ((r && r.reason) || 'Key ' + (slot + 1) + ' would not take that.');
  }

  function activeChar() {
    var p = CHLOE.engine.party;
    var m = p.active() || p.state.members[0];
    return m ? m.id : null;
  }

  function costText(a) {
    var bits = [];
    if (a.cost && a.cost.sta) bits.push(a.cost.sta + ' STA');
    if (a.cost && a.cost.mana) bits.push(a.cost.mana + ' MAG');
    return bits.join(' · ') || 'free';
  }

  function renderInto(body, opts) {
    ui = CHLOE.ui;
    var charId = (opts && opts.charId) || activeChar();
    opts = opts || {};
    if (!charId || !C3()) {
      body.appendChild(ui.el('div', 'menu-note', 'No one is ready to fight.'));
      return;
    }
    var known = C3().knownAbilities(charId);
    var slots = C3().binds(charId);
    var maxSlots = (CHLOE.data.abilityConfig && CHLOE.data.abilityConfig.maxSlots) || 9;

    body.appendChild(ui.el('div', 'menu-note',
      'Bind abilities and pocket items to number keys. In the fight: 1-9 to use, ' +
      'SPACE to evade, Shift to sprint, Ctrl or C to crouch. New moves arrive ' +
      'already bound — rearrange them here if you want them somewhere else.'));
    if (notice) body.appendChild(ui.el('div', 'menu-note warn', notice));

    /* §21: party members walk the ladder on their OWN level, so the tab has to
       say whose keys and whose levels you are looking at. */
    var members = (CHLOE.engine.party.state.members || []);
    if (members.length > 1) {
      var strip = ui.el('div', 'moves-who');
      members.forEach(function (m) {
        var def = (CHLOE.data.characters || {})[m.id] || {};
        var b = ui.el('button', m.id === charId ? 'on' : '',
          (def.name || m.id) + ' · Lv ' + m.level);
        b.addEventListener('click', function () {
          if (typeof opts.onPickChar === 'function') opts.onPickChar(m.id);
          else { opts.charId = m.id; rerender(body, opts); }
        });
        strip.appendChild(b);
      });
      body.appendChild(strip);
    }

    /* --- the 9 keys ---
       §23: an unlocked key is an unlocked key. The last two are the pocket
       slots, but they carry no badge, no tint and no separate heading, because
       any slot takes either kind — the pockets exist so that carrying a
       bandage costs you no ability, not so that two keys become item-only. */
    var row = ui.el('div', 'bind-slots');
    for (var i = 0; i < maxSlots; i++) {
      var unlocked = i < slots.length;
      var id = unlocked ? slots[i] : null;
      var itemId = itemIdOf(id);
      var a = (id && !itemId) ? ABIL()[id] : null;
      var d = ui.el('div', 'bind-slot' +
        (unlocked ? '' : ' locked') + (sel.slot === i ? ' sel' : ''));
      d.appendChild(ui.el('span', 'key', String(i + 1)));
      if (!unlocked) {
        d.appendChild(ui.el('span', 'icon', '🔒'));
        d.appendChild(ui.el('span', 'nm', 'locked'));
        d.title = 'Locked — the ladder hands you more keys as you level';
      } else if (itemId) {
        /* A carried item on a key. The count is the only extra it gets: it is
           what tells you the key is live, and a 0 here still keeps the bind —
           finding another re-arms it. */
        var idef = ITEMS()[itemId] || {};
        var n = bagCount(itemId);
        d.classList.add('item');
        if (n <= 0) d.classList.add('out');
        d.appendChild(ui.el('span', 'icon', idef.icon || '🎒'));
        d.appendChild(ui.el('span', 'nm', idef.name || itemId));
        d.appendChild(ui.el('span', 'ct', '×' + n));
        d.title = (idef.name || itemId) + ' — ' + n + ' carried';
      } else if (a) {
        var ic = ui.el('span', 'icon', a.icon || '•');
        ic.style.color = typeColor(a.type);
        d.appendChild(ic);
        d.appendChild(ui.el('span', 'nm', a.name));
      } else {
        d.appendChild(ui.el('span', 'icon', '·'));
        d.appendChild(ui.el('span', 'nm', 'empty'));
      }
      if (unlocked) {
        (function (idx) {
          d.addEventListener('click', function () { sel.slot = idx; rerender(body, opts); });
        })(i);
      }
      row.appendChild(d);
    }
    body.appendChild(row);

    // --- abilities you can put in the selected key ---
    body.appendChild(ui.el('div', 'bind-head',
      'Abilities — tap one to bind it to key ' + (sel.slot + 1)));
    var grid = ui.el('div', 'bind-grid');
    if (!known.length) {
      grid.appendChild(ui.el('div', 'menu-note', 'Nothing learned yet.'));
    }
    known.forEach(function (id) {
      var a = ABIL()[id];
      if (!a) return;
      var boundAt = slots.indexOf(id);
      var card = ui.el('div', 'bind-card' + (boundAt === sel.slot ? ' on' : ''));
      var head = ui.el('div', 'bind-card-head');
      var ic = ui.el('span', 'icon', a.icon || '•');
      ic.style.color = typeColor(a.type);
      head.appendChild(ic);
      head.appendChild(ui.el('span', 'nm', a.name));
      if (boundAt >= 0) head.appendChild(ui.el('span', 'at', 'key ' + (boundAt + 1)));
      card.appendChild(head);
      card.appendChild(ui.el('div', 'ds', a.desc || ''));
      var meta = ui.el('div', 'bind-meta');
      meta.appendChild(ui.el('span', null, costText(a)));
      meta.appendChild(ui.el('span', null, 'cd ' + ((a.cooldownMs || 0) / 1000).toFixed(1) + 's'));
      if ((a.charges || 1) > 1) meta.appendChild(ui.el('span', null, a.charges + ' charges'));
      meta.appendChild(ui.el('span', null, (a.hits || 1) + (a.hits > 1 ? ' hits' : ' hit')));
      card.appendChild(meta);
      card.addEventListener('click', function () {
        put(charId, sel.slot, id);
        rerender(body, opts);
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);

    renderPockets(body, opts, charId, slots);

    var clear = ui.el('button', null, 'Clear key ' + (sel.slot + 1));
    clear.addEventListener('click', function () {
      put(charId, sel.slot, null);
      rerender(body, opts);
    });
    body.appendChild(clear);

    renderLadder(body, charId);
  }

  /* ------------------------------------------------------------ the pockets
     §23. Its own group beside the abilities, and deliberately the SAME card
     shape: a consumable binds by exactly the same gesture (pick a key, tap a
     card) because it goes on exactly the same kind of key. What it shows
     instead of a cost is what you are carrying — a bandage's whole question is
     "how many", and an item you own none of is still bindable, since the bind
     is what makes the next one you find usable without a trip back here. */
  function renderPockets(body, opts, charId, slots) {
    var ids = bindableItems();
    if (!ids.length) return;

    body.appendChild(ui.el('div', 'bind-head',
      'Pockets — tap one to put it on key ' + (sel.slot + 1)));
    body.appendChild(ui.el('div', 'menu-note',
      'Any key takes an item instead of a move. Using one costs no magic or ' +
      'stamina — but it locks every pocket for a moment, and you can be hit ' +
      'while you do it.'));

    var grid = ui.el('div', 'bind-grid pockets');
    ids.forEach(function (id) {
      var it = ITEMS()[id];
      if (!it) return;
      var entry = itemKey(id);
      var n = bagCount(id);
      var boundAt = slots.indexOf(entry);
      var card = ui.el('div', 'bind-card item' +
        (boundAt === sel.slot ? ' on' : '') + (n <= 0 ? ' out' : ''));
      var head = ui.el('div', 'bind-card-head');
      head.appendChild(ui.el('span', 'icon', it.icon || '🎒'));
      head.appendChild(ui.el('span', 'nm', it.name || id));
      if (boundAt >= 0) head.appendChild(ui.el('span', 'at', 'key ' + (boundAt + 1)));
      card.appendChild(head);
      card.appendChild(ui.el('div', 'ds', it.desc || ''));
      var meta = ui.el('div', 'bind-meta');
      meta.appendChild(ui.el('span', 'ct', 'carried ×' + n));
      var eff = it.effect || {};
      if (eff.hp > 0) meta.appendChild(ui.el('span', null, '+' + eff.hp + ' life'));
      if (eff.mp > 0) meta.appendChild(ui.el('span', null, '+' + eff.mp + ' magic'));
      card.appendChild(meta);
      card.addEventListener('click', function () {
        put(charId, sel.slot, entry);
        rerender(body, opts);
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  /* ------------------------------------------------------------- the ladder
     §21. This replaces the Skill Tree screen. Since §19 there is nothing to
     spend and nothing to choose — reaching a level grants that level's row —
     so a whole separate screen for it was just a list you had to go and find.
     It belongs here, next to the keys the levels unlock. */
  function renderLadder(body, charId) {
    var sk = CHLOE.engine.skilltree;
    var prog = CHLOE.engine.progression;
    var m = CHLOE.engine.party.get(charId);
    if (!sk || !m) return;
    var T = CHLOE.data.skilltree || { rows: {}, maxLevel: 100 };

    body.appendChild(ui.el('div', 'bind-head', 'Levels — ' + (T.name || 'The Long Night')));
    body.appendChild(ui.el('div', 'menu-note',
      T.blurb || 'Reach the level, gain the row. Nothing to spend.'));

    // where this character is right now
    var head = ui.el('div', 'ladder-now');
    head.appendChild(ui.el('span', 'lv', 'Lv ' + m.level));
    if (prog && prog.xpToNext && m.level < (T.maxLevel || 100)) {
      var need = prog.xpToNext(m.level);
      var have = m.xp || 0;
      var track = ui.el('div', 'ladder-xp');
      var fill = ui.el('div', 'ladder-xp-fill');
      fill.style.width = Math.max(0, Math.min(100, (have / need) * 100)) + '%';
      track.appendChild(fill);
      head.appendChild(track);
      head.appendChild(ui.el('span', 'xp', have + ' / ' + need + ' XP'));
    } else {
      head.appendChild(ui.el('span', 'xp', 'Ladder complete'));
    }
    body.appendChild(head);

    /* Show the road either side of you rather than all 100 rows: the last few
       you earned, and the next few coming. A 100-row dump is not a reward. */
    var from = Math.max(1, m.level - 2);
    var to = Math.min(T.maxLevel || 100, Math.max(m.level + 4, 9));
    var list = ui.el('div', 'ladder-list');
    for (var L = from; L <= to; L++) {
      var row = T.rows[L];
      if (!row) continue;
      var earned = L <= m.level;
      var d = ui.el('div', 'ladder-row' + (earned ? ' got' : '') + (L === m.level ? ' here' : ''));
      d.appendChild(ui.el('span', 'l', String(L)));

      var mid = ui.el('div', 'b');
      mid.appendChild(ui.el('div', 'nm', row.name || ('Level ' + L)));
      mid.appendChild(ui.el('div', 'ds', row.desc || ''));
      d.appendChild(mid);

      // what it hands over, as a chip
      var give = ui.el('span', 'give');
      if (row.ability) {
        var a = ABIL()[row.ability] || {};
        give.textContent = (a.icon || '•') + ' ' + (a.name || row.ability);
        give.style.color = typeColor(a.type);
      } else if (row.ally) {
        var cd = (CHLOE.data.characters || {})[row.ally] || {};
        give.textContent = '＋ ' + (cd.name || row.ally);
      } else if (row.slot) {
        give.textContent = '⌨ +' + row.slot + ' key';
      } else if (row.stat) {
        var bits = [];
        for (var k in row.stat) bits.push('+' + row.stat[k] + ' ' + k);
        give.textContent = bits.join(', ');
      }
      d.appendChild(give);
      list.appendChild(d);
    }
    body.appendChild(list);
  }

  function rerender(body, opts) {
    ui.clear(body);
    renderInto(body, opts);
  }

  return { renderInto: renderInto };
})();
