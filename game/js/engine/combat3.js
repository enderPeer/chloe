/* CHLOE — engine/combat3.js  (Combat v3, spec §17)
   Real-time fight rules. Owns resources, cast/cooldown/charge state, evade
   windows and damage math. Knows nothing about DOM or Three.js: the 3D layer
   (engine/arena3d.js) asks "may I cast?" and reports "the strike connected",
   the HUD (ui/battle3d.js) only renders what `snapshot()` returns.

   Frame contract:
     start(enemyId)            -> state
     tick(dt)                  -> events[]   (drives regen, casts, cooldowns)
     press(slot)               -> {ok, reason?, ability?|item?}  slot is a key
                                  index 0-8 or 'mouseL'/'mouseR' (§27B)
     mousePress(side)          -> {handled, result?}  the ROOM/ARENA split
     evade()                   -> {ok, reason?, dirLocked?}
     spendSprint(dt)           -> bool       (false = out of stamina)
     hitEnemy(ability, mult)   -> {dmg, killed}   called by the 3D hit test
     takeHit(pattern)          -> {dmg, dead, evaded|missed}   null = a miss, costs nothing (§25)
     snapshot()                -> everything the HUD needs

   Events are plain objects the UI animates:
     {t:'cast'|'hit'|'miss'|'evade'|'resource'|'cooldown'|'die'|'win', ...}
     §29 adds {t:'reload', abilityId, charges} — a MAGAZINE came back whole,
     which is a different thing from 'charge' (one more use trickled in) and
     is the event the reload tell hangs off. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.combat3 = (function () {
  'use strict';

  var st = null;

  function party() { return CHLOE.engine.party; }
  function prog() { return CHLOE.engine.progression; }
  function types() { return CHLOE.data.types; }
  function ABIL() { return CHLOE.data.abilities || {}; }
  function CFG() { return CHLOE.data.abilityConfig || {}; }
  function GCFG() { return CHLOE.data.config || {}; }
  function ITEMS() { return CHLOE.data.items || {}; }

  /* ---------- pockets: consumables on the hotbar (§23) ---------- */

  /* A slot holds either a bare ability id or the string 'item:<itemId>'. One
     flat array of strings keeps party.state.binds a dumb, printable thing —
     and there is no save to migrate (§15), so the encoding may stay this
     simple. Everything that reads a slot goes through here rather than
     sniffing for a colon in five places. */
  var ITEM_PREFIX = 'item:';
  function itemIdOf(entry) {
    return (typeof entry === 'string' && entry.indexOf(ITEM_PREFIX) === 0)
      ? entry.slice(ITEM_PREFIX.length) : null;
  }
  function itemKey(itemId) { return ITEM_PREFIX + itemId; }

  /* Whether an item may sit on a key at all. The RULE lives in data/items.js
     (`CHLOE.data.itemRules.isCombatUsable`, mirrored onto CHLOE.data.items) so
     that adding a bigger potion is a data edit and nothing else — never a list
     of ids in here. The inline fallback exists only so an older data/items.js
     degrades to "restores a pool you carry" instead of dropping every bind. */
  function rules() { return CHLOE.data.itemRules || ITEMS(); }
  function bindableItem(itemId) {
    var def = ITEMS()[itemId];
    if (!def) return false;
    var r = rules();
    if (r && typeof r.isCombatUsable === 'function') return !!r.isCombatUsable(itemId);
    var eff = def.effect || {};
    return (eff.hp > 0 || eff.mp > 0 || (eff.self && eff.revivePct > 0));
  }

  /* §27C splits "bindable" in two. A PRESSABLE item answers a key press by
     putting a number back in a pool. A PASSIVE one answers nothing: it sits
     there armed and spends itself when the killing blow lands. Both are
     bindable; only one is pressable, and useItem() has to refuse the other or
     a fumbled key would burn the most expensive item in the game for nothing.
     Same story as bindableItem: the rule is data, the fallback is the same
     rule spelled inline for an older data/items.js. */
  function pressableItem(itemId) {
    var def = ITEMS()[itemId];
    if (!def) return false;
    var r = rules();
    if (r && typeof r.isPressable === 'function') return !!r.isPressable(itemId);
    var eff = def.effect || {};
    return (eff.hp > 0 || eff.mp > 0);
  }
  function passiveItem(itemId) {
    var def = ITEMS()[itemId];
    if (!def) return false;
    var r = rules();
    if (r && typeof r.isPassiveCombat === 'function') return !!r.isPassiveCombat(itemId);
    var eff = def.effect || {};
    return !!(eff.self && eff.revivePct > 0);
  }

  /* ---------- known abilities & bound slots ---------- */

  /* Everything this character may bind: punch always, plus whatever the skill
     tree granted (tree nodes with grant.ability). */
  /* §19: the shared 1-100 ladder is the source of truth — a character knows
     exactly what their OWN level has unlocked. */
  function knownAbilities(charId) {
    var out = [], seen = {}, i;
    var sk = CHLOE.engine.skilltree;
    if (sk && typeof sk.abilities === 'function') {
      var lvl = sk.abilities(charId) || [];
      for (i = 0; i < lvl.length; i++) {
        if (ABIL()[lvl[i]] && !seen[lvl[i]]) { out.push(lvl[i]); seen[lvl[i]] = 1; }
      }
    }
    // legacy point-buy nodes still count if a save/tree granted them
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.abilities === 'function') {
      var granted = tr.abilities(charId) || [];
      for (i = 0; i < granted.length; i++) {
        if (ABIL()[granted[i]] && !seen[granted[i]]) { out.push(granted[i]); seen[granted[i]] = 1; }
      }
    }
    if (!out.length) out.push('punch');   // never leave a character empty-handed
    return out;
  }

  /* How many number keys this character may use: base + tree slot nodes +
     §23 POCKETS.

     The pockets are keys the ladder never granted. They exist because
     abilities and their keys arrive together (§19), so every key a character
     owns is already spoken for and binding a bandage would cost you a move.
     They are NOT a second, item-only hotbar: the slots are generic and the
     player may put an ability in one, or a bandage on key 1. The extra room is
     the whole feature.

     `pocketSlots` is one named constant in data/config.js. A missing config
     degrades to zero pockets rather than to a duplicated literal — the feature
     quietly does not exist, which beats it silently disagreeing with data. */
  function pocketSlots() {
    var n = GCFG().pocketSlots;
    return (typeof n === 'number' && n > 0) ? n : 0;
  }
  function slotCount(charId) {
    var cfg = CFG();
    var n = cfg.baseSlots || 1;
    var sk = CHLOE.engine.skilltree;
    if (sk && typeof sk.slots === 'function') n += sk.slots(charId) || 0;
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.abilitySlots === 'function') n += tr.abilitySlots(charId) || 0;
    n += pocketSlots();
    // the 9-key cap is untouched: pockets push you toward it, they do not lift it
    return Math.max(1, Math.min(cfg.maxSlots || 9, n));
  }

  /* ---------- mouse slots (§27B) ---------- */

  /* LMB and RMB are bind targets alongside keys 1-9: 9 + 2 = 11 slots, any of
     which may hold an ability OR an item.

     THEY ARE IDS, NOT INDICES. 'mouseL'/'mouseR', never 9 and 10 — see the
     comment on config.mouseSlots for why a numeric encoding here is the kind
     of off-by-one that fires the wrong ability instead of failing. Everything
     below treats a slot as "a number, or one of these two strings", and a
     number that is out of range is refused rather than reinterpreted.

     They are also OUTSIDE abilityConfig.maxSlots on purpose: that cap counts
     number keys the ladder may grant (data/skilltree.js does the arithmetic
     against it), and slotCount() is untouched by any of this. */
  function MOUSE_SLOTS() {
    var m = GCFG().mouseSlots;
    return (m && m.length) ? m : ['mouseL', 'mouseR'];
  }
  function isMouseSlot(slot) {
    return typeof slot === 'string' && MOUSE_SLOTS().indexOf(slot) !== -1;
  }
  function mouseLabel(slot) {
    var l = GCFG().mouseSlotLabels || {};
    return l[slot] || (slot === 'mouseR' ? 'RMB' : 'LMB');
  }
  /* 'l'/'r', 'left'/'right', or a DOM MouseEvent.button (0 / 2) -> a slot id.
     The input layer speaks all three depending on where the click came from,
     and this is the only place that has to know that. */
  function mouseSlotOf(side) {
    if (isMouseSlot(side)) return side;
    if (side === 0 || side === 'l' || side === 'left' || side === 'L') return 'mouseL';
    if (side === 2 || side === 'r' || side === 'right' || side === 'R') return 'mouseR';
    return null;
  }
  /* {mouseL, mouseR} for one character, validated the same way the number keys
     are: an ability they no longer know, or an item the rules refuse, is
     dropped rather than left to fire into nothing. */
  function mouseBinds(charId) {
    var p = party();
    if (!p.state.mouseBinds || typeof p.state.mouseBinds !== 'object') p.state.mouseBinds = {};
    var cur = p.state.mouseBinds[charId];
    if (!cur || typeof cur !== 'object') cur = {};
    var known = knownAbilities(charId), ids = MOUSE_SLOTS(), out = {};
    for (var i = 0; i < ids.length; i++) {
      var entry = cur[ids[i]], itemId = itemIdOf(entry);
      if (itemId) out[ids[i]] = bindableItem(itemId) ? entry : null;
      else out[ids[i]] = (entry && known.indexOf(entry) !== -1) ? entry : null;
    }
    p.state.mouseBinds[charId] = out;
    return out;
  }
  /* Every slot id this character has, keys first then buttons — the order the
     HUD and the bind screen draw them in. */
  function slotIds(charId) {
    var out = [], n = slotCount(charId), i;
    for (i = 0; i < n; i++) out.push(i);
    var m = MOUSE_SLOTS();
    for (i = 0; i < m.length; i++) out.push(m[i]);
    return out;
  }
  /* What is on one slot, whichever kind of slot it is. */
  function entryAt(charId, slot) {
    if (isMouseSlot(slot)) return mouseBinds(charId)[slot] || null;
    var list = binds(charId);
    return (typeof slot === 'number' && slot >= 0 && slot < list.length) ? list[slot] : null;
  }
  /* Every entry bound anywhere — used by the §27C revive scan, which does not
     care whether your potion is on key 4 or on RMB. */
  function allEntries(charId) {
    return binds(charId).concat(mouseEntries(charId));
  }

  /* ---------- the player's own memory (§27A) ---------- */

  /* `bindsCleared` is "the player emptied this off a key on purpose", and it is
     DELIBERATELY a different list from `autoBound`.

     That conflation was the bug. One list meaning "already offered once" had to
     answer two different questions — "is this new?" and "did they say no?" —
     and answered both with the same yes, so an ability that went missing for
     any reason at all was indistinguishable from one the player had thrown
     away, and never came back. Split in two, each list answers only its own
     question and the self-heal below can be aggressive without ever overruling
     a choice. */
  function clearedOf(charId) {
    var p = party();
    if (!p.state.bindsCleared || typeof p.state.bindsCleared !== 'object') p.state.bindsCleared = {};
    var list = p.state.bindsCleared[charId];
    if (!Array.isArray(list)) list = [];
    p.state.bindsCleared[charId] = list;
    return list;
  }
  function markCleared(charId, entry) {
    if (!entry) return;
    var list = clearedOf(charId);
    if (list.indexOf(entry) === -1) list.push(entry);
  }
  function unmarkCleared(charId, entry) {
    if (!entry) return;
    var list = clearedOf(charId), i = list.indexOf(entry);
    if (i !== -1) list.splice(i, 1);
  }
  function autoBoundOf(charId) {
    var p = party();
    if (!p.state.autoBound || typeof p.state.autoBound !== 'object') p.state.autoBound = {};
    var list = p.state.autoBound[charId];
    if (!Array.isArray(list)) list = [];
    p.state.autoBound[charId] = list;
    return list;
  }

  /* Bound slots live in party.state.binds[charId] = [entry|null, ...], where an
     entry is an ability id ('punch') or a consumable ('item:bandage', §23).
     Invalid entries are dropped: an ability the character does not know, an
     item that does not exist, or an item whose effect is not combat-usable
     (data/items.js owns that rule). Slot 0 still defaults to punch so a fresh
     run always has something on key 1 — but only when it is EMPTY, so a player
     who deliberately put a bandage there keeps it.

     §27A: THIS READ SELF-HEALS. Any ability the character knows that is not on
     a key, while a key is free, gets placed — every time, not once. The old
     code placed each ability exactly once ever and remembered that it had, so
     any path that rebuilt the array afterwards left every earlier ability
     marked "done" with nowhere to be. That is not a hypothetical: the ladder
     fills the bar EXACTLY (7 abilities + 2 pockets = 9 = maxSlots at level 9,
     and it is exact at every ability level below that too), so the cheapest
     everyday way to hit it is the Moves screen — drag a move onto a key that
     already holds another one and the displaced move used to be gone for the
     rest of the run. Now it lands in whatever key was freed by the same drag.

     The player's own "no" still wins: bindsCleared is checked first and is
     never written by anything except an explicit clear. */
  function binds(charId) {
    var p = party();
    if (!p.state.binds) p.state.binds = {};
    var known = knownAbilities(charId);
    var n = slotCount(charId);
    var cur = p.state.binds[charId];
    if (!Array.isArray(cur)) cur = [];
    var out = [];
    for (var i = 0; i < n; i++) {
      var id = cur[i], itemId = itemIdOf(id);
      if (itemId) out.push(bindableItem(itemId) ? id : null);
      else out.push((id && known.indexOf(id) !== -1) ? id : null);
    }
    /* Key 1 defaults to the first thing you know — unless it is already bound
       elsewhere (putting punch on key 5 used to leave a duplicate on key 1 and
       waste the key) or you cleared it on purpose. */
    /* §31 added the third condition. The comment above has always promised
       "unless it is already bound elsewhere", but the check only ever looked
       at `out` — the KEY array — and a button was invisible to it. Nothing
       could put an ability on a button at run start until party.newGame began
       seeding the fist onto LMB, so the gap was unreachable rather than
       harmless; the moment it was reachable, punch sat on both LMB and key 1
       and wasted the key exactly as the comment warned. */
    if (!out[0] && known.length && out.indexOf(known[0]) === -1 &&
        mouseEntries(charId).indexOf(known[0]) === -1 &&
        clearedOf(charId).indexOf(known[0]) === -1) {
      out[0] = known[0];
    }
    p.state.binds[charId] = out;
    /* §29: the gun claims its button BEFORE the keys are filled, so that when
       autoBind() below looks for homeless abilities the gun already has one
       and does not get parked on a number key it never asked for. */
    autoBindMouse(charId, known);
    /* A button counts as bound (§27B). Without this the self-heal would look
       at a hotbar whose asteroid is on RMB, decide asteroid has no slot, and
       helpfully put a SECOND copy on a key — one entry, two slots, which is
       the rule bind() has always enforced. */
    var onMouse = mouseEntries(charId);
    autoBind(charId, known, out, onMouse);
    autoBindItems(charId, out, onMouse);
    /* Last line: a character with NOTHING to press cannot fight, and that is
       worse than overriding one clear. Only reachable if the player has
       emptied every ability off every slot by hand. */
    if (!hasAnyAbility(out.concat(onMouse), known) && known.length) {
      var free = out.indexOf(null);
      if (free !== -1) out[free] = known[0];
    }
    return out;
  }
  function mouseEntries(charId) {
    var mb = mouseBinds(charId), ids = MOUSE_SLOTS(), out = [];
    for (var i = 0; i < ids.length; i++) if (mb[ids[i]]) out.push(mb[ids[i]]);
    return out;
  }
  function hasAnyAbility(list, known) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && !itemIdOf(list[i]) && known.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  /* §21: a level that hands you a move should hand it to you READY. The
     ladder grants an ability and its key on the same level, so a new move
     drops straight onto the new key and you can use it the moment you walk
     back into the church - no trip through the menu to arm your reward.

     §27A made this the SELF-HEAL rather than a one-shot: it runs on every read
     and places any known, uncleared ability that has no key while a key is
     free. `autoBound` survives, but it no longer decides whether to place —
     only whether to ANNOUNCE. An entry in it has been placed before, so the
     victory card must not call it a new move; an entry missing from it is
     genuinely new and gets reported to takeAutoBound(). That is the whole of
     what that memory is for now, and it is why it can no longer strand a move.

     Mouse slots are NOT auto-filled from here, and that rule stands: a mouse
     button already has a job in the room (§16 hands and grab), so the engine
     may offer a key it granted you and must not quietly take a button you use
     for something else. LMB/RMB stay opt-in from the bind screen — with the
     one §29 exception below, which the ABILITY has to ask for by name. */
  function autoBind(charId, known, out, onMouse) {
    var p = party();
    var seen = autoBoundOf(charId);
    var cleared = clearedOf(charId);
    onMouse = onMouse || [];

    var placed = [];
    for (var k = 0; k < known.length; k++) {
      var id = known[k];
      if (out.indexOf(id) !== -1) continue;       // already on a key
      if (onMouse.indexOf(id) !== -1) continue;   // already on a button (§27B)
      if (cleared.indexOf(id) !== -1) continue;   // the player said no
      var slot = placeAbility(charId, out, id);
      if (slot === -1) continue;                  // no free key: leave it in the pool
      var isNew = seen.indexOf(id) === -1;
      if (isNew) seen.push(id);
      // only a first placement is a REWARD; a re-place is a repair, silently
      if (isNew) placed.push({ abilityId: id, slot: slot });
    }
    p.state.autoBound[charId] = seen;
    p.state.binds[charId] = out;
    /* §29: APPEND, do not replace. autoBindMouse() runs first in the same
       binds() pass and may have just parked the gun on RMB; overwriting the
       feed here would mean a level that grants both a move and the gun
       announces only the move, and the button placement — the surprising half
       — is the one that goes unsaid. noteAutoBound() owns that folding now,
       across characters as well as within one. */
    noteAutoBound(charId, placed);
    return placed;
  }

  /* §29: THE ONE ABILITY THAT BINDS ITSELF TO A BUTTON.

     The gun exists on the ladder at all because it costs no number key (§27B
     put mouseL/mouseR outside the nine), and an ability that arrives with
     nowhere to press it reads as a bug (§21). So it takes a button — but only
     because `data/abilities.js` says so, in `bindsTo.mouse`, as an ordered
     preference. No id appears in this engine; a second mouse-bound weapon is a
     data edit and nothing else.

     The order matters and it is `['mouseR','mouseL']`: mouseL is the hand you
     already open, close and grab with back in the room (§16), and taking it
     would mean the game silently rebound the button the player has spent the
     whole run using. Right first, left only if right is spoken for.

     THREE THINGS IT WILL NOT DO, all for the same reason — the engine offers,
     it never overrules (same principle as autoBind and the pocket shuffle):
       - it never EVICTS. A button already holding something is skipped, and
         if both are, the gun falls through to autoBind() and takes a number
         key, which is worse than what it wanted and much better than nothing
         (§25's rule: known and unbound while a slot is free is the bug).
       - it never fights a CLEAR. bindsCleared is the player saying no; a
         player who dragged the gun off RMB does not get it put back.
       - it places each ability ONCE per button-freeing, not once ever: like
         the rest of §27A this is a self-heal, so a rebuild from empty at any
         level puts the gun back where it belongs.

     Returns what it placed, so the level-up card can say "the 9mm went on
     RMB" in the same breath the ladder announces the row. */
  function autoBindMouse(charId, known) {
    var p = party();
    var mouse = mouseBinds(charId);
    var ids = MOUSE_SLOTS();
    var cleared = clearedOf(charId);
    var seen = autoBoundOf(charId);
    var keys = binds_raw(charId);
    var placed = [];

    for (var k = 0; k < known.length; k++) {
      var id = known[k];
      var a = ABIL()[id];
      var pref = a && a.bindsTo && a.bindsTo.mouse;
      if (!pref || !pref.length) continue;
      if (cleared.indexOf(id) !== -1) continue;         // the player said no
      if (keys.indexOf(id) !== -1) continue;            // already on a key
      var already = false, s;
      for (s = 0; s < ids.length; s++) if (mouse[ids[s]] === id) already = true;
      if (already) continue;
      for (s = 0; s < pref.length; s++) {
        var slot = pref[s];
        if (ids.indexOf(slot) === -1) continue;         // a button this build has no concept of
        if (mouse[slot]) continue;                      // occupied: never evict
        mouse[slot] = id;
        if (seen.indexOf(id) === -1) seen.push(id);
        placed.push({ abilityId: id, slot: slot });
        break;
      }
    }
    p.state.mouseBinds[charId] = mouse;
    p.state.autoBound[charId] = seen;
    noteAutoBound(charId, placed);
    return placed;
  }
  /* The key array as it is STORED, without triggering the full binds() rebuild
     — autoBindMouse runs from inside that rebuild and calling it again here
     would recurse. All it needs to know is "is this ability already sitting on
     a key", and the stored array answers that. */
  function binds_raw(charId) {
    var cur = party().state.binds && party().state.binds[charId];
    return Array.isArray(cur) ? cur : [];
  }

  /* Where a newly granted ability goes — the first free key, EXCEPT when a
     pocket is squatting on a lower one.

     The ladder does not just hand you asteroid, it hands you "asteroid, key 3"
     (§21), and the level screen says so in those words. Pockets exist from
     level 1, so they get to keys 2 and 3 long before the abilities that were
     promised them, and without this the level-3 reward silently landed on
     key 5 while the bandage kept key 2. Abilities settle LEFT and pockets are
     pushed right.

     The item is MOVED, never dropped: the same level that grants an ability
     grants its key, so there is always a free slot to move the bandage into.
     If there genuinely is no free key (the 9-cap, deep in the generated
     levels), nothing is displaced and the ability waits in the pool exactly as
     it did before — a bar that full is one the player is already curating.

     Only a pocket WE placed is moved, checked against `pocketAt`: if the
     player has since dragged that bandage somewhere themselves, the record no
     longer matches the slot and their choice is left alone. Same principle as
     the `autoBound` memory — the engine offers, it never overrules. */
  function pocketAt(charId) {
    var p = party();
    if (!p.state.pocketAt) p.state.pocketAt = {};
    if (!p.state.pocketAt[charId]) p.state.pocketAt[charId] = {};
    return p.state.pocketAt[charId];
  }
  function rememberPocket(charId, entry, slot) { pocketAt(charId)[entry] = slot; }
  function lentPocketSlot(out, charId, below) {
    var at = pocketAt(charId);
    for (var i = 0; i < out.length && i < below; i++) {
      if (itemIdOf(out[i]) && at[out[i]] === i) return i;
    }
    return -1;
  }
  function placeAbility(charId, out, id) {
    var free = out.indexOf(null);
    if (free === -1) return -1;
    var lent = lentPocketSlot(out, charId, free);
    if (lent !== -1) {
      out[free] = out[lent];                 // the pocket shuffles right
      rememberPocket(charId, out[free], free);
      out[lent] = id;
      return lent;
    }
    out[free] = id;
    return free;
  }

  /* §23: pockets are only a feature if you find them. A run starts holding two
     bandages and an energy drink, and a key nobody knows to press is an
     undiscovered feature — so the consumables bind themselves into whatever
     keys are still free once the abilities have had their pick.

     ABILITIES ALWAYS WIN. This runs AFTER autoBind() and only ever writes into
     a null slot, so a consumable can never be evicting a move — which is the
     failure this whole design exists to avoid. When the ladder eventually
     fills every key, the items simply stop being placed; the player decides
     from there whether a bandage is worth a move.

     Order comes from data/items.js (`pressableIds()` walks the table in
     declaration order: bandage, then energy_drink), so no ids appear here.

     PRESSABLE ONLY, and that is a §27C decision. A passive like the revive
     potion is bindable but not pressable, and there are exactly two pocket
     keys — letting a potion you have not bought yet reserve one of them would
     spend the feature's whole budget on an empty slot. A passive is a shop
     purchase, and a shop purchase gets a key you chose.

     §27A: THIS SELF-HEALS TOO, for the same reason the abilities do — "the
     pockets are lost as well" was half of the reported bug. A bandage that has
     no key while a key is free goes back on one, every read, not once ever.
     The old once-ever gate could also be spent WITHOUT the item ever landing
     (marked "offered" while the bar was full), which is the never-comes-back
     trap in miniature.

     It is safe to be this eager only because the list is PRESSABLE ids. The
     two things it can ever place are the bandage and the drink you start the
     run holding, so the worst case is that the feature works. Walking every
     bindable id instead would let a passive you do not own drop itself onto
     the key you just deliberately emptied, which is the engine filling in
     space the player made on purpose.

     `autoBound` still records what has landed — it is announce-only now (see
     autoBind), and pockets are deliberately never announced. */
  function autoBindItems(charId, out, onMouse) {
    var p = party();
    var r = rules();
    onMouse = onMouse || [];
    var ids = (r && typeof r.pressableIds === 'function')
      ? (r.pressableIds() || [])
      : ((r && typeof r.combatUsableIds === 'function') ? (r.combatUsableIds() || []) : []);
    if (!ids.length) return [];
    var seen = autoBoundOf(charId);
    var cleared = clearedOf(charId);

    var placed = [];
    for (var i = 0; i < ids.length; i++) {
      var key = itemKey(ids[i]);
      if (cleared.indexOf(key) !== -1) continue;  // the player said no
      if (out.indexOf(key) !== -1) continue;      // already on a key
      if (onMouse.indexOf(key) !== -1) continue;  // already on a button (§27B)
      var slot = out.indexOf(null);
      if (slot === -1) continue;                  // no free key: the moves won
      out[slot] = key;
      if (seen.indexOf(key) === -1) seen.push(key);
      rememberPocket(charId, key, slot);          // ours to shuffle, until moved
      placed.push({ itemId: ids[i], slot: slot });
    }
    p.state.autoBound[charId] = seen;
    p.state.binds[charId] = out;
    /* Deliberately NOT reported through takeAutoBound(): that feed is the
       victory card announcing "your new move went on key 4", and it reads
       `abilityId`. Pockets fill at run start, not on a level-up, so there is
       no card to put them on. */
    return placed;
  }

  /* What the auto-binds put where since the card last asked, so the victory
     card can say so. Read-and-clear.

     ONE RECORD PER CHARACTER, not one record. It was a single slot, and the
     card reads it after calling binds() for EVERY member who levelled — so the
     last member to be rebuilt overwrote everyone before them and the card
     announced exactly one person's new move.

     §29 is what turned that from untidy into a hole. Ash joins at level 4 and
     the 9mm arrives at 5, so the fight that hands you the pistol is very
     often the same fight Ash crosses her own level on; her row won the race
     and the card said "Fire Tornado — ready on key 2" while saying nothing at
     all about the gun. The gun's row grants no number key ON PURPOSE, which
     makes this line the only place the game ever names the button it went to.
     Losing it is losing the feature.

     `placed` entries keep their `charId` so the card can attribute them when
     more than one person levelled. Accumulate, never replace. */
  var lastAutoBound = [];
  function takeAutoBound() {
    var v = lastAutoBound;
    lastAutoBound = [];
    if (!v.length) return null;
    /* The old shape, still: {charId, placed} with the FIRST character's id, so
       a caller that predates this keeps working and simply sees more entries
       than it used to. Each entry also carries its own charId. */
    var all = [];
    for (var i = 0; i < v.length; i++) all = all.concat(v[i].placed);
    return { charId: v[0].charId, placed: all, byChar: v };
  }
  /* Fold a fresh placement into the feed: same character, same record. */
  function noteAutoBound(charId, placed) {
    if (!placed || !placed.length) return;
    var stamped = [];
    for (var i = 0; i < placed.length; i++) {
      var e = placed[i], c = {};
      for (var k in e) c[k] = e[k];
      c.charId = charId;
      stamped.push(c);
    }
    for (var j = 0; j < lastAutoBound.length; j++) {
      if (lastAutoBound[j].charId === charId) {
        lastAutoBound[j].placed = lastAutoBound[j].placed.concat(stamped);
        return;
      }
    }
    lastAutoBound.push({ charId: charId, placed: stamped });
  }

  /* `entry` is an ability id, an 'item:<id>' string (§23), or null to clear.
     `slot` is a key index 0-8 OR a mouse slot id (§27B) — never a number that
     stands for a button. Named `abilityId` for years and kept callable exactly
     as before. */
  function bind(charId, slot, entry) {
    var list = binds(charId), mouse = mouseBinds(charId);
    var onMouse = isMouseSlot(slot);
    if (!onMouse && !(typeof slot === 'number' && slot >= 0 && slot < list.length)) {
      return { ok: false, reason: 'No such slot.' };
    }
    var itemId = itemIdOf(entry);
    if (itemId) {
      if (!ITEMS()[itemId]) return { ok: false, reason: 'No such item.' };
      // "carried" is not the test — an empty slot stays bound and re-arms when
      // you find another. Whether it CAN be used in a fight is (data/items.js).
      if (!bindableItem(itemId)) return { ok: false, reason: 'Not usable in a fight.' };
    } else if (entry && knownAbilities(charId).indexOf(entry) === -1) {
      return { ok: false, reason: 'Not learned yet.' };
    }
    var i, ids = MOUSE_SLOTS();
    // an ability — or an item — lives in ONE slot at a time, across all eleven
    if (entry) {
      for (i = 0; i < list.length; i++) if (list[i] === entry) list[i] = null;
      for (i = 0; i < ids.length; i++) if (mouse[ids[i]] === entry) mouse[ids[i]] = null;
    }
    /* Touching a key by hand makes the player's placement authoritative: drop
       our "we lent this pocket that slot" record for both the entry going in
       and whatever was sitting there, so placeAbility will never shuffle a
       bandage the player put somewhere on purpose. */
    var at = pocketAt(charId);
    var was = onMouse ? mouse[slot] : list[slot];
    if (entry) delete at[entry];
    if (was) delete at[was];

    /* §27A: the two halves of the player's intent, recorded separately.
         clearing a slot (entry === null)  -> "I do not want this on a key" and
           the self-heal must never undo it.
         dropping something ON TOP of it   -> NOT a refusal. They wanted the new
           thing HERE; they never said the old thing should go in the bin, so
           it stays eligible and the self-heal parks it in whatever key this
           move just freed. Losing a move to a rearrange was the everyday face
           of the §27A bug.
       Binding something also un-clears it: putting it back on a key is the
       plainest possible statement that you want it. */
    if (entry) unmarkCleared(charId, entry);
    else markCleared(charId, was);

    if (onMouse) mouse[slot] = entry || null;
    else list[slot] = entry || null;
    /* Both stores are written on every path, not just the one that changed:
       moving an entry from key 3 to RMB edits BOTH lists above, and writing
       back only the one the slot id pointed at is how half a move gets lost. */
    party().state.binds[charId] = list;
    party().state.mouseBinds[charId] = mouse;
    return { ok: true, binds: list.slice(), mouse: mouse, slot: slot };
  }

  /* ---------- lifecycle ---------- */
  /* §20: `count` knights fight you at once. Round N spawns N of them. */
  function start(enemyId, count) {
    var def = (CHLOE.data.enemies || {})[enemyId];
    if (!def) return null;
    count = Math.max(1, count || 1);
    var p = party();
    var m = p.active() || (p.state.members[0]);
    if (!m) return null;
    var eff = p.effStats(m);
    /* §21: the knight levels because YOU do — his level is the round you are
       on, so the thing you beat at round 1 is not what meets you at round 8.
       A squad that only ever grew in NUMBER stopped being a threat and became
       a chore. Falls back to the flat def if the ladder is missing. */
    var kt = CHLOE.engine.knighttree;
    var enemyLevel = kt ? kt.level() : (def.level || 1);
    var es = kt ? kt.stats(enemyLevel, def) : (def.stats || {});

    st = {
      enemyId: enemyId,
      enemyDef: def,
      enemyLevel: enemyLevel,
      enemyStats: es,
      /* One entry per knight on the floor. §28 A: each carries its OWN level
         and its own stat line, because they no longer share one. They all
         open on the §30 SENIORITY ladder and diverge from there —
         `syncLevels` below reprices them every tick off what the 3D layer
         says each knight has grown to. `enemyStats` above stays as the
         ROUND's stat block: it is what the poster shows and what a caller
         with no per-knight index still gets.

         §30: the squad no longer opens flat. Round N fields N knights and
         adds exactly one per round, so the index IS a join date — index 0
         has been coming since round 1 and opens at level N, the last index
         walked in tonight and opens at 1. The personality bonus cannot be
         applied here and the empty string is deliberate: temperaments are
         dealt by the §22 brain in the 3D layer, which does not exist yet
         when start() runs. The brute's +1 arrives on the first syncLevels
         tick, from the layer that actually knows what he is.

         `os` is built INSIDE the loop. Every entry used to share one stats
         object by reference, which was harmless while they all had the same
         level and is a corruption the moment they do not. */
      enemies: (function () {
        var arr = [];
        for (var q = 0; q < count; q++) {
          var sen = kt ? kt.seniorityFor(q, count) : 1;
          var open = kt ? kt.spawnLevel('', sen) : enemyLevel;
          var os = kt ? kt.stats(open, def) : es;
          arr.push({ index: q, life: os.life || 40, max: os.life || 40, alive: true,
                     level: open, seniority: sen, stats: os });
        }
        return arr;
      })(),
      charId: m.id,
      max: { hp: eff.life, mana: eff.magic, sta: eff.stamina },
      hp: Math.max(1, m.hp),
      mana: eff.magic,
      sta: eff.stamina,
      cast: null,            // {id, t, dur, hitsDone, recoverUntil}
      lockUntil: 0,          // cast+recover lock
      cd: {},                // abilityId -> {charges, nextAt}
      /* §23: ONE cooldown across every consumable key. It belongs to your
         hands, not to the item, which is why it is a single timer and why a
         leader swap does not clear it — the bag is the party's. */
      itemReadyAt: 0,
      evadeReadyAt: 0,
      iframeUntil: 0,
      lastSpendAt: 0,
      now: 0,
      over: false,
      result: null,
      rewards: null,
      slots: binds(m.id).slice()
    };
    var known = knownAbilities(m.id);
    for (var i = 0; i < known.length; i++) {
      var a = ABIL()[known[i]];
      st.cd[known[i]] = { charges: a.charges || 1, nextAt: 0 };
    }
    return st;
  }

  function get() { return st; }
  function isOver() { return !st || st.over; }
  function allDown() {
    if (!st) return false;
    for (var i = 0; i < st.enemies.length; i++) if (st.enemies[i].alive) return false;
    return true;
  }
  function aliveCount() {
    var n = 0;
    if (st) for (var i = 0; i < st.enemies.length; i++) if (st.enemies[i].alive) n++;
    return n;
  }

  /* ---------- resources ---------- */
  function spend(cost) {
    cost = cost || {};
    if ((cost.sta || 0) > st.sta) return false;
    if ((cost.mana || 0) > st.mana) return false;
    st.sta -= (cost.sta || 0);
    st.mana -= (cost.mana || 0);
    st.lastSpendAt = st.now;
    return true;
  }

  /* §31: what an ability costs THIS character, after the ladder has had its
     say. data/skilltree.js row 5 discounts the 9mm from 18 stamina to 10, so
     the price is a function of level and not a constant on the ability. Every
     reader goes through here — the readiness check, the spend, and the three
     the hotbar draws from — because a HUD that shows 18 while the engine
     charges 10 is the same class of lie as a board naming the wrong stage. */
  function costOf(a) {
    if (!a) return {};
    var tree = CHLOE.engine.skilltree;
    if (!tree || typeof tree.costFor !== 'function' || !st) return a.cost || {};
    return tree.costFor(st.charId, a.id, a.cost) || a.cost || {};
  }

  function canPay(cost) {
    cost = cost || {};
    return (cost.sta || 0) <= st.sta && (cost.mana || 0) <= st.mana;
  }

  /* Sprint drains stamina continuously; returns false when it runs dry. */
  function spendSprint(dt) {
    if (isOver()) return false;
    var rate = (CFG().sprint && CFG().sprint.staPerSec) || 12;
    var need = rate * dt;
    if (st.sta < need) return false;
    st.sta -= need;
    st.lastSpendAt = st.now;
    return true;
  }

  /* ---------- casting ---------- */
  /* Read the bound slots LIVE from party state — a snapshot taken at start()
     meant rebinding during a fight silently did nothing. */
  function liveSlots() {
    return st ? binds(st.charId) : [];
  }
  /* What a slot id resolves to right now — the one place that turns "key 3" or
     "mouseR" into an entry. A number outside the key range resolves to NOTHING
     rather than falling through to a button: §27B's whole reason for string
     ids is that a stray 9 or 10 must fire nothing, loudly, instead of firing
     LMB by accident. */
  function liveEntry(slot) {
    if (!st) return null;
    if (isMouseSlot(slot)) return mouseBinds(st.charId)[slot] || null;
    if (typeof slot !== 'number') return null;
    var list = liveSlots();
    return (slot >= 0 && slot < list.length) ? (list[slot] || null) : null;
  }
  function slotAbility(slot) {
    var id = liveEntry(slot);
    if (!id || itemIdOf(id)) return null;    // §23: an item is not an ability
    return ABIL()[id];
  }

  function readiness(id) {
    if (!st.cd[id] && ABIL()[id]) {
      st.cd[id] = { charges: ABIL()[id].charges || 1, nextAt: 0 };
    }
    var c = st.cd[id];
    if (!c) return { ready: false, reason: 'Unknown ability.' };
    var a = ABIL()[id];
    if (c.charges <= 0) {
      /* §29: an empty MAGAZINE is its own refusal, flagged rather than merely
         worded, because the input layer owes it a dry click and a reload tell
         and must not have to string-match 'Recharging' to know which it is.
         `empty` is the fact; `reason` is only the copy. */
      if (a.magazine) {
        return { ready: false, empty: true, reason: 'Reloading', pct: cooldownPct(id) };
      }
      return { ready: false, reason: 'Recharging', pct: cooldownPct(id) };
    }
    if (st.now < c.nextAt) return { ready: false, reason: 'Cooling down', pct: cooldownPct(id) };
    var payFor = costOf(a);
    if (!canPay(payFor)) return { ready: false, reason: 'Not enough ' + (payFor.mana ? 'magic' : 'stamina') };
    return { ready: true };
  }

  function cooldownPct(id) {
    var c = st.cd[id], a = ABIL()[id];
    if (!c || !a) return 0;
    var span = a.rechargeMs || a.cooldownMs || 1;
    var left = Math.max(0, c.nextAt - st.now);
    return Math.max(0, Math.min(1, left / span));
  }

  /* ---------- using a consumable (§23) ---------- */

  /* Everything about this path is deliberately NOT the ability path: no
     readiness check, no charges, no mana or stamina. What it costs is TIME
     while you are standing in his reach.

     The clamp is done here rather than through engine/inventory.js's use(),
     which is the out-of-battle path: it clamps against `member.mp`, and
     combat3 does not keep that in step during a fight — only `m.hp` is
     mirrored (see takeHit). st.mana is the live magic pool, so an energy drink
     routed through use() would compare against a resting-full member.mp,
     restore nothing, and refuse itself as "wasted" while your real pool sat
     empty. The pools that matter mid-fight live in `st`, so the clamp lives
     here too, and inventory is asked only to count and to remove. */
  function useItem(itemId) {
    var def = ITEMS()[itemId];
    if (!def) return { ok: false, reason: 'Nothing bound to that key.' };
    /* §27C: a passive is armed, not pressable. Refused FIRST and without
       touching the bag, the cooldown or the lock — a fumbled key must cost the
       most expensive item in the game exactly nothing. The reason string is
       written to be read on the HUD: it explains the key rather than scolding
       the press. */
    if (passiveItem(itemId)) {
      return { ok: false, passive: true, itemId: itemId,
               reason: (def.name || 'It') + ' is armed — it drinks itself if you fall.' };
    }
    var inv = CHLOE.engine.inventory;
    var have = (inv && typeof inv.count === 'function') ? inv.count(itemId) : 0;
    /* Checked BEFORE the cooldown, so an empty pocket reads "None left." (go
       find one) rather than "cooling down" (wait), which would be a lie. */
    if (have <= 0) return { ok: false, reason: 'None left.' };
    if (st.now < st.itemReadyAt) return { ok: false, reason: 'Pockets cooling down' };

    var eff = def.effect || {};
    var hp = Math.max(0, Math.min(st.max.hp - st.hp, eff.hp || 0));
    var mana = Math.max(0, Math.min(st.max.mana - st.mana, eff.mp || 0));
    /* §31: stamina is a pool like the other two and the smelling salts put a
       number back in it. Without this branch a {sta:n} item was bindable
       (data/items.js decides that), pressable, and then refused as "Already
       full." at full health — the item worked everywhere except the fight it
       was for. Clamped to the headroom exactly like hp and mana, so drinking
       at 39/40 wastes 27 of the 28 and refuses at 40. */
    var sta = Math.max(0, Math.min(st.max.sta - st.sta, eff.sta || 0));
    /* Refuse before consuming, never after. A bandage pressed at full life is
       a fumbled key, not a decision, and eating the last one for zero healing
       is the single most annoying thing this feature could do. "Never refund
       on a failed press" is satisfied by never taking it in the first place. */
    if (hp <= 0 && mana <= 0 && sta <= 0) return { ok: false, reason: 'Already full.' };

    st.hp += hp;
    st.mana += mana;
    st.sta += sta;   // §31: the third pool, applied like the other two
    var m = party().get(st.charId);
    if (m) m.hp = st.hp;          // same mirror takeHit keeps
    inv.remove(itemId, 1);

    var cfg = GCFG();
    /* The lock is the whole price: it uses the SAME lockUntil abilities pay
       into, so a bandage cannot be cancelled into a punch — and it does not
       grant i-frames, so his swing lands on you while you wrap it. That is
       the point (§23), not an oversight. */
    st.lockUntil = st.now + (cfg.itemUseMs || 350);
    st.itemReadyAt = st.now + (cfg.itemCooldownMs || 2500);
    /* Regen is untouched on purpose: an item costs no mana or stamina, so it
       must not push out `lastSpendAt` and stall the pools it did not spend. */
    /* `kind` and `cooldownMs` are for the HUD: it has to tell an item press
       from a cast without re-reading the bind, and it sweeps the pocket dial
       against the same span this pressed. */
    /* §31 reports `sta` beside hp/mana so the HUD can float "+28 STA" the
       same way it floats the other two. A restore the engine performs and
       does not report is a number the player has to infer from a bar. */
    return { ok: true, kind: 'item', item: def, itemId: itemId,
             hp: hp, mana: mana, sta: sta, count: inv.count(itemId),
             lockMs: (cfg.itemUseMs || 350), cooldownMs: (cfg.itemCooldownMs || 2500) };
  }

  /* Number key pressed. Returns {ok} and, on success, starts the cast — the
     3D layer plays the animation and calls hitEnemy() at each hit moment.
     §23: the same key may hold a consumable, which takes the useItem() path
     and never touches ability readiness or cost. */
  function press(slot) {
    if (isOver()) return { ok: false, reason: 'The fight is over.' };
    if (st.cast) return { ok: false, reason: 'Already casting.' };
    if (st.now < st.lockUntil) return { ok: false, reason: 'Recovering.' };
    var itemId = itemIdOf(liveEntry(slot));
    if (itemId) return useItem(itemId);
    var a = slotAbility(slot);
    if (!a) return { ok: false, reason: 'Nothing bound to that key.' };
    var r = readiness(a.id);
    /* §29: carry the refusal's SHAPE out, not just its sentence. An empty
       magazine is the one "not ready" that has a picture attached (dry click,
       reload tell), and the input layer decides that off `empty` — never off
       the wording, which is copy and may change. `ability` rides along so the
       caller can tell WHICH slot clicked dry without re-resolving the bind. */
    if (!r.ready) return { ok: false, reason: r.reason, empty: !!r.empty, ability: a };
    if (!spend(costOf(a))) return { ok: false, reason: 'Not enough resources.' };

    var c = st.cd[a.id];
    c.charges = Math.max(0, c.charges - 1);
    if (c.charges <= 0) c.nextAt = st.now + (a.rechargeMs || a.cooldownMs || 1000);
    else c.nextAt = st.now + (a.cooldownMs || 600);

    var total = (a.hitAtMs && a.hitAtMs.length)
      ? a.hitAtMs[a.hitAtMs.length - 1] : (a.castMs || 0);
    st.cast = { id: a.id, t: 0, dur: total, hitsDone: 0 };
    st.lockUntil = st.now + total + (a.recoverMs || 0);
    return { ok: true, ability: a };
  }

  /* ---------- the mouse, and where it is allowed to fire (§27B) ----------

     THE SPLIT, STATED ONCE, HERE.
       IN THE ROOM the mouse is your hands. Left click closes the left hand,
         right click the right, and looking at something and clicking takes it
         (§16). That is not negotiable and it is not shared: a bind must never
         fire in the room, because the room is where you pick things up.
       IN THE ARENA the same two buttons are hotbar slots, and only there.

     A LIVE `st` IS the arena, and the test is `isOver()`, not `st`. A finished
     fight leaves its state object lying around until the next start(), and
     you walk back into the room with it still there — gating on `st` alone
     would mean a bound button ate the first grab of every trip home.

     The contract for whoever owns the input layer (ui/battle3d.js, and
     engine/world3d.js for the room) is `handled`:
       handled === false  -> this click is NOT a bind. Do whatever you would
                             have done: grab in the room, click-to-engage in
                             the arena. Nothing here has run.
       handled === true   -> the button fired its slot. Do NOT also grab and do
                             NOT also engage; `result` is the same {ok,...}
                             shape press() returns, refusals included, because
                             a bound button that is on cooldown is still bound
                             and must not fall through to grabbing something.
     That is the whole of "a bound mouse button must not also trigger a grab,
     and must not collide with click-to-engage": both rules fall out of one
     boolean, and the caller never has to ask what screen it is on. */
  /* §31: the wheel, and why it does NOT go through mouseSlotOf.
     A WheelEvent's `button` property reads 0 — structurally valid, semantically
     a left click — so routing a notch through the button mapper would fire
     mouseL every time and never fail loudly. This mapper takes a DIRECTION,
     not an event: a number whose sign is the direction (deltaY convention:
     negative is up), or the strings 'up'/'down'. */
  function wheelSlotOf(dir) {
    if (dir === 'up' || dir === 'wheelUp') return 'wheelUp';
    if (dir === 'down' || dir === 'wheelDown') return 'wheelDown';
    if (typeof dir === 'number' && dir !== 0) return dir < 0 ? 'wheelUp' : 'wheelDown';
    return null;
  }

  /* Same contract as mousePress, deliberately: `handled` decides whether the
     input layer swallows the event. An UNBOUND direction must come back
     handled:false so ui/battle3d.js does not preventDefault — for a wheel that
     means the page is still allowed to scroll, which the bind screen and the
     shop both depend on. */
  function wheelPress(dir) {
    var slot = wheelSlotOf(dir);
    if (!slot) return { handled: false, reason: 'Not a wheel direction.' };
    if (!isMouseSlot(slot)) return { handled: false, slot: slot, reason: 'This build has no wheel slots.' };
    if (isOver()) return { handled: false, slot: slot, reason: 'The wheel fires binds only in the arena.' };
    if (!mouseBinds(st.charId)[slot]) {
      return { handled: false, slot: slot, reason: 'Nothing bound to that direction.' };
    }
    return { handled: true, slot: slot, result: press(slot) };
  }

  function mousePress(side) {
    var slot = mouseSlotOf(side);
    if (!slot) return { handled: false, reason: 'Not a bindable button.' };
    // No live fight: the room owns the mouse. §16 hands and grab, untouched.
    if (isOver()) return { handled: false, slot: slot, reason: 'Mouse binds fire only in the arena.' };
    var charId = st.charId;
    if (!mouseBinds(charId)[slot]) {
      // Nothing on this button — leave click-to-engage its click.
      return { handled: false, slot: slot, reason: 'Nothing bound to that button.' };
    }
    return { handled: true, slot: slot, result: press(slot) };
  }

  /* Is this button carrying a bind for the fighter on screen right now? The
     input layer can ask before it even builds a grab, which is the cheap way
     to keep a bound button from starting an animation it will not finish. */
  function mouseArmed(side) {
    var slot = mouseSlotOf(side);
    return !!(slot && !isOver() && mouseBinds(st.charId)[slot]);
  }

  /* ---------- evade ---------- */
  function evade() {
    if (isOver()) return { ok: false, reason: 'The fight is over.' };
    var cfg = CFG().evade || {};
    if (st.now < st.evadeReadyAt) return { ok: false, reason: 'Evade cooling down' };
    if (!canPay(cfg.cost)) return { ok: false, reason: 'Not enough stamina' };
    if (st.cast) return { ok: false, reason: 'Mid-swing' };
    spend(cfg.cost);
    st.evadeReadyAt = st.now + (cfg.cooldownMs || 900);
    st.iframeUntil = st.now + (cfg.iframeMs || 200);
    return { ok: true, distance: cfg.distance || 3.4, durationMs: cfg.durationMs || 260 };
  }

  function invulnerable() { return !!st && st.now < st.iframeUntil; }

  /* ---------- damage ---------- */
  /* Called by the 3D layer when a cast's hit window connects with the knight.
     `mult` lets the caller pass a positional bonus (e.g. behind = more). */
  function hitEnemy(abilityId, mult, target) {
    if (isOver()) return null;
    var a = ABIL()[abilityId];
    if (!a) return null;
    var p = party();
    var m = p.get(st.charId);
    if (!m) return null;
    var eff = p.effStats(m);
    var base = a.usesMag ? eff.mag : eff.atk;
    var chart = types().multiplier(a.type, st.enemyDef);
    var rand = 0.9 + Math.random() * 0.2;
    var idx = (typeof target === 'number') ? target : 0;
    var e = st.enemies[idx];
    if (!e || !e.alive) return null;
    /* §21 gave him a LEVELLED defence instead of the flat number in
       data/enemies.js; §28 A makes it HIS defence rather than the squad's.
       Read off the knight that was actually hit — a level-1 knight next to a
       level-7 one must not be as hard to cut, or the spread is a light show.
       Falls back through the round stat block to the flat def, so a target
       index the 3D layer never levelled still prices honestly. */
    var def = (e.stats && e.stats.def) ||
              (st.enemyStats && st.enemyStats.def) ||
              (st.enemyDef.stats && st.enemyDef.stats.def) || 0;
    var dmg = Math.max(1, Math.round(
      base * ((a.power || 50) / 100) * chart * (mult || 1) * rand - def * 0.5));
    e.life = Math.max(0, e.life - dmg);
    var killed = e.life <= 0;
    if (killed) e.alive = false;

    /* §23: an ability may STUN what it damaged — the asteroid does, and that,
       not its damage, is what makes the rock worth one of the nine keys
       against a squad. Read off the ability's own `stun` block, so a future
       splash weapon inherits this by being data and no id is named here.

       Why in combat3 and not at the splash call site: this is the ONLY place
       that knows both which knight was actually damaged and by what. It is a
       one-way, fully-guarded poke at the 3D layer (which owns the §22 stagger
       state) — the same direction as the flinch the UI already forwards, and
       it degrades to nothing on the no-WebGL surface. Seconds, not ms, because
       arena3d's timers are all seconds.

       Not applied to a knight the hit KILLED: he is already going down and
       stunning a corpse would fight the death animation for the same body. */
    var stunMs = (a.stun && a.stun.ms) || 0;
    if (stunMs && !killed) {
      var a3d = CHLOE.engine.arena3d;
      if (a3d && typeof a3d.stun === 'function') a3d.stun(idx, stunMs / 1000);
    }
    if (allDown()) victory();
    return { dmg: dmg, killed: killed, mult: chart, index: idx, cleared: allDown(),
             // so the HUD can float "STUNNED" without re-reading the ability
             stunned: !!(stunMs && !killed), stunMs: killed ? 0 : stunMs };
  }

  /* §25: a pattern that reaches the damage maths with no `power` was priced at
     100 by a `|| 100` fallback, which made a data bug look like a design
     choice — an unauthored swing hit exactly as hard as a full-power one and
     nothing anywhere said so. Report it instead, and only ONCE per pattern:
     this runs inside the swing loop, so a warn per hit would bury the console
     under the same line. Still returns 100 afterwards, because a bad row in
     data/arena3d.js must not be able to stop a fight mid-round. */
  var warnedPower = {};
  function patternPower(pattern) {
    var pw = pattern.power;
    if (typeof pw === 'number' && pw > 0) return pw;
    var id = pattern.id || pattern.name || '(unnamed pattern)';
    if (!warnedPower[id]) {
      warnedPower[id] = true;
      if (window.console && console.warn) {
        console.warn('CHLOE combat3: knight pattern "' + id + '" reached takeHit() ' +
                     'with no `power` — pricing this swing at 100. Fix the row in data/arena3d.js.');
      }
    }
    return 100;
  }

  /* §28 A: whose swing this is. An explicit index always wins; without one,
     ask the 3D layer which knight is mid-strike-callback RIGHT NOW. arena3d
     clears that the instant the callback returns, so the worst a deferred
     caller can get is -1 and the round baseline — never a stale knight, which
     would be wrong in a way nobody could see. */
  function strikerIndex() {
    var a3d = CHLOE.engine.arena3d;
    var i = (a3d && typeof a3d.striker === 'function') ? a3d.striker() : -1;
    return (i >= 0 && st.enemies[i]) ? i : -1;
  }

  /* The knight's swing landed, missed, or was evaded. `index` is optional and
     names WHICH knight swung: with the §28 spread on the floor, a level-1
     knight and a level-7 one no longer hit for the same number. */
  function takeHit(pattern, index) {
    if (isOver()) return null;
    /* §25 THE BUG: no pattern means no hit, and a miss must cost NOTHING.
       ui/battle3d.js used to hand us `null` on a geometric miss; with only the
       isOver/invulnerable guards we fell straight through to the damage maths,
       priced the swing at the old `|| 100` fallback, and `Math.max(1, ...)`
       guaranteed at least a point off the bar — while the HUD, branching on
       its own miss flag, printed that the blade split empty air. The feedback
       and the health bar disagreed and every clean dodge quietly cost life.

       This guard sits BEFORE any maths, any HP write and any leader-swap
       check, so a miss has no side effects at all. The caller no longer calls
       us on a miss (defence in depth, §25) — this is the backstop for the next
       caller, which is the one that would otherwise re-arm the trap. */
    if (!pattern) return { dmg: 0, missed: true, dead: false };
    if (invulnerable()) return { dmg: 0, evaded: true, dead: false };
    var p = party();
    var m = p.get(st.charId);
    var eff = p.effStats(m);
    /* §21 gave him a LEVELLED attack — round 8 is not round 1. §28 A makes it
       HIS attack: the striker's own stat line if we can tell who swung, the
       round's baseline if we cannot. */
    var who = (typeof index === 'number' && st.enemies[index]) ? index : strikerIndex();
    var es = (who >= 0 && st.enemies[who] && st.enemies[who].stats) ||
             st.enemyStats || st.enemyDef.stats || {};
    var cdef = (CHLOE.data.characters || {})[st.charId] || {};
    var atkType = st.enemyDef.type || st.enemyDef.element;
    var chart = types().multiplier(atkType, { type: cdef.type || cdef.element, resists: cdef.resists || null });
    var rand = 0.9 + Math.random() * 0.2;
    var dmg = Math.max(1, Math.round(
      (es.atk || 8) * (patternPower(pattern) / 100) * chart * rand - eff.def * 0.5));
    // tree resist nodes are PERCENT cuts, applied after the chart (like §16)
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.passives === 'function') {
      var pv = tr.passives(st.charId);
      var key = types().migrate ? types().migrate(atkType) : atkType;
      var cut = (pv && pv.resists && pv.resists[key]) || 0;
      if (cut) dmg = Math.max(1, Math.round(dmg * (1 - Math.min(90, cut) / 100)));
    }
    st.hp = Math.max(0, st.hp - dmg);
    if (m) m.hp = st.hp;

    /* §27C: THE ORDER HERE IS THE FEATURE.
       The revive is checked BEFORE §19's swap, and that single line of
       sequencing is what the potion actually buys. Swap first and the potion
       could only ever be poured over a body that has already lost the fight —
       it would save the corpse. Revive first and the leader stays the leader:
       her level, her hotbar, her cooldowns, the run intact. If she has no
       potion bound, or none left in the bag, nothing here happens at all and
       the swap below runs exactly as it did before. */
    var revived = (st.hp <= 0) ? tryPassiveRevive() : null;

    /* §19: the leader falling does NOT end the run while someone else can
       still fight — the next member takes over as leader mid-fight and the
       camera keeps going with their stats and their own hotbar. */
    var swapped = null;
    if (st.hp <= 0) {
      var next = p.firstAliveOther(st.charId);
      if (next) {
        p.setActive(next.id);
        st.charId = next.id;
        var neff = p.effStats(next);
        st.max = { hp: neff.life, mana: neff.magic, sta: neff.stamina };
        st.hp = next.hp;
        st.mana = neff.magic;
        st.sta = neff.stamina;
        st.cast = null;
        st.lockUntil = 0;
        st.cd = {};                       // fresh cooldowns for the new fighter
        st.iframeUntil = st.now + 900;    // a breath to recover, not a free kill
        swapped = next.id;
      } else {
        defeat();
      }
    }
    return { dmg: dmg, dead: st.hp <= 0 && !swapped, evaded: false,
             leaderSwap: swapped,
             /* Non-null only on the frame the potion fired, so the HUD can
                splash it without diffing anything: {itemId, name, pct, hp,
                count, charId}. */
             revived: revived };
  }

  /* ---------- §27C: the potion you never press ----------

     Reached ONLY from the killing-blow branch of takeHit, which is what makes
     "never consumed on a survivable hit" true by construction rather than by a
     check that could drift: a hit you walk away from never gets here. And
     because it puts hp back above zero, the next fall is a genuinely new fall
     and takes a second potion — one per fall, exactly, with no counter to keep
     in step.

     It scans the whole eleven-slot hotbar (§27B), keys and buttons alike: the
     potion works because it is BOUND, and which slot it is bound to is the
     player's business. First bound one that is actually carried wins; a bind
     with an empty bag is a slot waiting to re-arm, not a save.

     Returns null when nothing saved you — the caller reads that as "carry on
     to the leader swap". */
  function tryPassiveRevive() {
    var p = party();
    var inv = CHLOE.engine.inventory;
    if (!inv || typeof inv.count !== 'function') return null;
    var entries = allEntries(st.charId);
    for (var i = 0; i < entries.length; i++) {
      var itemId = itemIdOf(entries[i]);
      if (!itemId || !passiveItem(itemId)) continue;
      if (inv.count(itemId) <= 0) continue;

      var def = ITEMS()[itemId] || {};
      var r = rules();
      var pct = (r && typeof r.revivePctOf === 'function')
        ? r.revivePctOf(itemId) : ((def.effect || {}).revivePct || 0);
      if (!(pct > 0)) continue;

      inv.remove(itemId, 1);
      st.hp = Math.max(1, Math.round(st.max.hp * pct / 100));
      var m = p.get(st.charId);
      if (m) m.hp = st.hp;                       // the same mirror takeHit keeps
      /* A breath, not a reset — see config.reviveIframeMs. Without it the very
         next hit window of the swing that just killed you kills you again and
         the potion bought one frame. */
      st.iframeUntil = st.now + ((GCFG().reviveIframeMs) || 900);
      /* The cast is dropped for the same reason the leader swap drops it: you
         were mid-animation when you died, and coming back up finishing it
         reads as a rewind. Resources are NOT restored — you are alive, not
         fresh. */
      st.cast = null;
      st.lockUntil = 0;
      lastRevive = {
        charId: st.charId, itemId: itemId, name: def.name || itemId,
        icon: def.icon || '🧿', pct: pct, hp: st.hp, max: st.max.hp,
        count: inv.count(itemId)
      };
      /* Guarded, DOM-free, exactly like every other engine->UI ping in here.
         The splash is the UI's job; this is the line in the log. */
      try {
        if (CHLOE.ui && typeof CHLOE.ui.toast === 'function') {
          CHLOE.ui.toast('ADRENALINE — ' + lastRevive.name + ' brings you back at ' +
                         st.hp + ' life.');
        }
      } catch (e) {}
      return lastRevive;
    }
    return null;
  }

  /* What the last potion did, for a HUD that renders off snapshot() rather
     than off the takeHit return. Read-and-clear, like takeAutoBound(). */
  var lastRevive = null;
  function takeRevive() { var v = lastRevive; lastRevive = null; return v; }

  /* ---------- tick ---------- */
  /* §28 A: every knight levels on his own clock while the fight runs, so the
     numbers have to follow. The 3D layer owns the clock (it owns the
     personality, the seconds alive and the moment of death), so this PULLS —
     the same direction combat3 already reaches for the §23 stun, and it
     degrades through arena3d's disabled API to the round baseline on a
     machine with no WebGL rather than needing a second path here.

     LIFE IS SCALED BY RATIO, NOT REWRITTEN. A knight at half health who
     levels up must come out at half of his NEW maximum: assigning the new
     max would heal him to full every level, and leaving `max` alone would
     make the bar lie about how much is left. A level-up is therefore worth a
     real chunk of effective health, which is most of what makes the ramp in
     data/knighttree.js bite — and it can never kill him, because a ratio of
     a positive maximum is positive.

     Emitted as an event so a HUD can float "LEVEL 4" over the right body.
     Still nobody floats it per body — but as of §30 the plate DOES render
     the spread (it names the living range, `Lv 2-5`, off `each[].level`), so
     this is no longer an event with no consumer anywhere: the numbers it
     carries are on screen, just aggregated rather than per knight. */
  function syncLevels() {
    var kt = CHLOE.engine.knighttree;
    var a3d = CHLOE.engine.arena3d;
    if (!kt || !a3d || typeof a3d.knightLevels !== 'function') return null;
    var levels = a3d.knightLevels(st.enemies.length);
    var out = null;
    for (var i = 0; i < st.enemies.length; i++) {
      var e = st.enemies[i];
      var want = levels[i];
      if (!e.alive || want == null || want === e.level) continue;
      var ns = kt.stats(want, st.enemyDef);
      var ratio = e.max > 0 ? (e.life / e.max) : 1;
      e.level = want;
      e.stats = ns;
      e.max = ns.life || e.max;
      e.life = Math.max(1, Math.round(e.max * ratio));
      (out = out || []).push({ t: 'enemyLevel', index: i, level: want });
    }
    return out;
  }

  function tick(dt) {
    if (!st || st.over) return [];
    var ev = [];
    st.now += dt * 1000;
    var lv = syncLevels();
    if (lv) for (var li = 0; li < lv.length; li++) ev.push(lv[li]);

    // cast progress -> hit windows
    if (st.cast) {
      st.cast.t += dt * 1000;
      var a = ABIL()[st.cast.id];
      var marks = (a && a.hitAtMs) || [a ? a.castMs || 0 : 0];
      while (st.cast.hitsDone < marks.length && st.cast.t >= marks[st.cast.hitsDone]) {
        st.cast.hitsDone++;
        ev.push({ t: 'strike', abilityId: st.cast.id, index: st.cast.hitsDone });
      }
      if (st.cast.hitsDone >= marks.length) {
        ev.push({ t: 'castEnd', abilityId: st.cast.id });
        st.cast = null;
      }
    }

    // charge recovery
    for (var id in st.cd) {
      var c = st.cd[id], ab = ABIL()[id];
      if (!ab) continue;
      var maxCh = ab.charges || 1;
      /* §29: A MAGAZINE IS NOT A TRICKLE, and the difference is the whole
         feel of the gun. The branch below dribbles charges back one at a
         time, each costing rechargeMs — right for ember-jab-shaped abilities,
         and wrong for a pistol, where six rounds at 3.2s each would mean the
         magazine is never full again inside one fight and every shot after
         the first is rationed instead of spent.

         `magazine` reloads as a BLOCK, and only from empty. The `<= 0` test is
         load-bearing, not defensive: press() writes nextAt for two different
         reasons — the fire rate between rounds, and the reload after the last
         one — and a magazine that refilled on any expired nextAt would top
         itself up 280ms after every single shot. Empty is the only state a
         reload may start from, which is also what makes running dry a
         DECISION (see data/abilities.js) rather than an accident. */
      if (ab.magazine) {
        if (c.charges <= 0 && st.now >= c.nextAt) {
          c.charges = maxCh;
          /* Its own event, not 'charge': the HUD has to tell "one more use
             came back" from "the weapon is loaded again", because only the
             second one gets a reload tell (§29 feedback). */
          ev.push({ t: 'reload', abilityId: id, charges: maxCh });
        }
        continue;
      }
      if (c.charges < maxCh && st.now >= c.nextAt) {
        c.charges++;
        if (c.charges < maxCh) c.nextAt = st.now + (ab.rechargeMs || ab.cooldownMs || 1000);
        ev.push({ t: 'charge', abilityId: id, charges: c.charges });
      }
    }

    // out-of-combat-ish regen: pauses briefly after spending
    var rg = CFG().regen || {};
    if (st.now - st.lastSpendAt > (rg.delayAfterUseMs || 700)) {
      st.sta = Math.min(st.max.sta, st.sta + (rg.staPerSec || 9) * dt);
      st.mana = Math.min(st.max.mana, st.mana + (rg.manaPerSec || 2.5) * dt);
    }
    return ev;
  }

  /* ---------- outcomes ---------- */
  function victory() {
    st.over = true;
    st.result = 'victory';
    var p = party(), state = p.state;
    if (state.runStats) {
      var cleared = state.runStats.round || 1;
      state.runStats.kills = (state.runStats.kills || 0) + st.enemies.length;
      /* §20: every cleared floor is hung on the dressing-room wall. The
         trophy list IS the round history - one entry per Hollow Knight
         squad put down, in order, and it dies with the run like everything
         else (§15). */
      state.runStats.trophies = state.runStats.trophies || [];
      state.runStats.trophies.push({
        round: cleared,
        knights: st.enemies.length,
        by: st.charId,
        hpLeft: Math.max(0, Math.round(st.hp)),
        hpMax: Math.round(st.hpMax || st.hp)
      });
      // clearing the floor advances the round - the next fight is bigger
      state.runStats.round = cleared + 1;
    }
    var def = st.enemyDef, rw = def.rewards || {};
    var squad = st.enemies.length;
    var xp = prog().enemyXp(def) * squad, shards = (rw.shards || 0) * squad;
    var rewards = { xp: xp, shards: shards, drops: [], levelUps: [], learned: [] };
    p.addShards(shards);
    var members = state.members;
    for (var i = 0; i < members.length; i++) {
      var res = prog().grantXp(members[i], xp);
      for (var j = 0; j < res.levelsGained.length; j++) {
        rewards.levelUps.push({ memberId: members[i].id, level: res.levelsGained[j] });
      }
    }
    var drops = rw.drops || [];
    for (var d = 0; d < drops.length; d++) {
      if (Math.random() < (drops[d].chance || 0)) {
        var item = (CHLOE.data.items || {})[drops[d].itemId];
        if (item) { CHLOE.engine.inventory.add(item.id, 1); rewards.drops.push(item.name); }
      }
    }
    st.rewards = rewards;
  }

  function defeat() {
    st.over = true;
    st.result = 'defeat';
  }

  function flee() {
    if (isOver()) return { fled: false };
    if (st.enemyDef.boss) return { fled: false, boss: true };
    st.over = true; st.result = 'fled';
    return { fled: true };
  }

  /* ---------- resolved hotbar ---------- */
  /* ONE builder for the HUD and for tests, so what a test asserts is exactly
     what ui/battle3d.js draws. Every slot carries `slot`, `key` and `kind`;
     `kind` is 'ability', 'item' or null for an empty key. `id` is the ability
     id or the ITEM id (never the raw 'item:' string — that encoding stops at
     this boundary). Ability entries keep every field they have always had. */
  function resolveSlot(entry, slot, key) {
    var itemId = itemIdOf(entry);
    if (itemId) {
      var def = ITEMS()[itemId] || {};
      var inv = CHLOE.engine.inventory;
      var have = (inv && typeof inv.count === 'function') ? inv.count(itemId) : 0;
      /* §27C: a passive never reads as pressable. It has no cooldown dial (it
         does not share the pockets' timer, because you never spend it on
         purpose) and its state is ARMED / EMPTY, not READY / COOLING. `ready`
         stays false so nothing that draws a pressable key lights it up, and
         `armed` is the flag the HUD should render instead — a ring, not a
         countdown. The count is still shown: it is how many falls you have
         left in your pocket, which is the only number that matters. */
      if (passiveItem(itemId)) {
        return {
          slot: slot, key: key, kind: 'item', id: itemId,
          name: def.name || itemId, icon: def.icon || '•',
          desc: def.desc || '', effect: def.effect || {},
          count: have,
          passive: true, armed: have > 0,
          cdPct: 0, cdLeft: 0, ready: false,
          reason: have > 0 ? 'Armed — spends itself if you fall.' : 'None left.'
        };
      }
      var cdLeft = Math.max(0, (st.itemReadyAt - st.now) / 1000);
      var span = (GCFG().itemCooldownMs || 2500);
      /* An empty pocket stays BOUND and greys out — it re-arms the moment
         you pick another one up, so the key never moves under the player. */
      var ready = have > 0 && st.now >= st.itemReadyAt;
      return {
        slot: slot, key: key, kind: 'item', id: itemId,
        name: def.name || itemId, icon: def.icon || '•',
        desc: def.desc || '', effect: def.effect || {},
        count: have,
        passive: false, armed: false,
        cdPct: Math.max(0, Math.min(1, cdLeft * 1000 / span)),
        cdLeft: cdLeft,
        ready: ready,
        reason: ready ? null : (have <= 0 ? 'None left.' : 'Pockets cooling down')
      };
    }
    var a = entry ? ABIL()[entry] : null;
    if (!a) return { slot: slot, key: key, kind: null, id: null, ready: false };
    var r = readiness(entry);
    return {
      slot: slot, key: key, kind: 'ability',
      id: entry, name: a.name, icon: a.icon, type: a.type,
      cost: costOf(a),
      // "8 STA" / "14 MAG" / "14 MAG + 6 STA" for the HUD chip
      costText: (function (c) {
        var b = [];
        if (c.mana) b.push(c.mana + ' MAG');
        if (c.sta) b.push(c.sta + ' STA');
        return b.join(' + ') || 'free';
      })(costOf(a)),
      charges: st.cd[entry] ? st.cd[entry].charges : 0,
      maxCharges: a.charges || 1,
      /* §29: the HUD draws a magazine as "4/6" and a charge stack as "2", and
         it must not guess which from the count alone. */
      magazine: !!a.magazine,
      empty: !!(a.magazine && st.cd[entry] && st.cd[entry].charges <= 0),
      cdPct: cooldownPct(entry),
      cdLeft: st.cd[entry] ? Math.max(0, (st.cd[entry].nextAt - st.now) / 1000) : 0,
      affordable: canPay(costOf(a)),
      ready: r.ready,
      reason: r.ready ? null : r.reason
    };
  }

  function resolvedSlots() {
    if (!st) return [];
    var out = [], live = liveSlots();
    for (var i = 0; i < live.length; i++) out.push(resolveSlot(live[i], i, i + 1));
    return out;
  }

  /* §27B: the two mouse slots, resolved the same way and returned SEPARATELY.
     Not appended to resolvedSlots(), and that is deliberate — ui/battle3d.js
     draws the hotbar with the array INDEX as the thing it presses, so two
     extra entries on the end of that array would become press(9) and press(10)
     the moment anyone rendered them. Keeping them in their own list means a
     caller has to reach for `.slot` ('mouseL'/'mouseR') to fire one, which is
     exactly the encoding §27B asks for. `key` is 'LMB'/'RMB', never a number:
     a "10" on that slot would be a lie about how you press it. */
  function resolvedMouseSlots() {
    if (!st) return [];
    var mb = mouseBinds(st.charId), ids = MOUSE_SLOTS(), out = [];
    for (var i = 0; i < ids.length; i++) {
      out.push(resolveSlot(mb[ids[i]], ids[i], mouseLabel(ids[i])));
    }
    return out;
  }

  /* ---------- HUD snapshot ---------- */
  function snapshot() {
    if (!st) return null;
    var slots = resolvedSlots();
    var cfg = CFG().evade || {};
    return {
      hp: st.hp, mana: st.mana, sta: st.sta, max: st.max,
      enemy: (function () {
        // aggregate bar across the whole squad + a per-knight breakdown
        var life = 0, max = 0;
        for (var i = 0; i < st.enemies.length; i++) { life += st.enemies[i].life; max += st.enemies[i].max; }
        return {
          life: life, max: max,
          count: st.enemies.length, alive: aliveCount(),
          /* §28 A: `level` per entry, and the round's baseline alongside it.
             ui/battle3d.js still names `knighttree.level()` on the plate,
             which is correct for "what round is this" — but the spread is
             here the moment that plate wants to show a range instead. */
          each: st.enemies.map(function (e) {
            // §30: seniority rides along so a HUD (or a test) can tell the
            // veteran from the newcomer without re-deriving it from the index
            return { life: e.life, max: e.max, alive: e.alive,
                     level: e.level || 1, seniority: e.seniority || 1 };
          }),
          roundLevel: st.enemyLevel,
          levels: st.enemies.map(function (e) { return e.level || 1; }),
          name: (CHLOE.data.arena3d && CHLOE.data.arena3d.knight && CHLOE.data.arena3d.knight.name) || st.enemyDef.name
        };
      })(),
      slots: slots,
      // §27B: the buttons ride alongside the keys, never inside their array
      mouseSlots: resolvedMouseSlots(),
      casting: st.cast ? { id: st.cast.id, pct: Math.min(1, st.cast.t / Math.max(1, st.cast.dur)) } : null,
      evade: {
        ready: st.now >= st.evadeReadyAt && canPay(cfg.cost),
        pct: Math.max(0, Math.min(1, (st.evadeReadyAt - st.now) / (cfg.cooldownMs || 900))),
        cost: (cfg.cost && cfg.cost.sta) || 0
      },
      iframe: invulnerable(),
      over: st.over, result: st.result
    };
  }

  return {
    start: start, get: get, isOver: isOver, tick: tick,
    press: press, evade: evade, spendSprint: spendSprint,
    hitEnemy: hitEnemy, takeHit: takeHit, invulnerable: invulnerable,
    aliveCount: aliveCount, allDown: allDown,
    flee: flee, snapshot: snapshot,
    knownAbilities: knownAbilities, slotCount: slotCount, binds: binds, bind: bind,
    takeAutoBound: takeAutoBound,
    /* §27B mouse binds. `slotIds` is the full eleven (0..n-1, 'mouseL',
       'mouseR') in draw order; `press` and `bind` take any of them. `mousePress`
       is the input layer's entry point and owns the room/arena split — read its
       comment before wiring a click to anything. */
    MOUSE_SLOTS: MOUSE_SLOTS, isMouseSlot: isMouseSlot, mouseSlotOf: mouseSlotOf,
    mouseLabel: mouseLabel, mouseBinds: mouseBinds, mouseSlots: resolvedMouseSlots,
    mousePress: mousePress,
    // §31 the wheel: a DIRECTION, never an event (a WheelEvent.button reads 0)
    wheelPress: wheelPress, wheelSlotOf: wheelSlotOf, mouseArmed: mouseArmed,
    slotIds: slotIds, entryAt: entryAt,
    /* §27C. `passiveItem` is what tells a HUD to draw a slot armed instead of
       pressable; `takeRevive` is the read-and-clear feed for a splash. */
    passiveItem: passiveItem, pressableItem: pressableItem, takeRevive: takeRevive,
    /* §23 verification/HUD surface: the hotbar as it actually resolves, item
       entries included. Empty outside a fight — it prices readiness against
       live pools and cooldowns, which only exist while one is running. */
    slots: resolvedSlots,
    /* Predicates the bind screen needs, so it never has to know the encoding.
       itemKey('bandage') -> 'item:bandage' is the string bind() expects. */
    itemKey: itemKey, itemIdOf: itemIdOf, bindableItem: bindableItem,
    readiness: function (id) { return st ? readiness(id) : { ready: false }; }
  };
})();
