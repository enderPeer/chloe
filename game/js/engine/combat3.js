/* CHLOE — engine/combat3.js  (Combat v3, spec §17)
   Real-time fight rules. Owns resources, cast/cooldown/charge state, evade
   windows and damage math. Knows nothing about DOM or Three.js: the 3D layer
   (engine/arena3d.js) asks "may I cast?" and reports "the strike connected",
   the HUD (ui/battle3d.js) only renders what `snapshot()` returns.

   Frame contract:
     start(enemyId)            -> state
     tick(dt)                  -> events[]   (drives regen, casts, cooldowns)
     press(slotIndex)          -> {ok, reason?, ability?|item?}  number keys 1-9
     evade()                   -> {ok, reason?, dirLocked?}
     spendSprint(dt)           -> bool       (false = out of stamina)
     hitEnemy(ability, mult)   -> {dmg, killed}   called by the 3D hit test
     takeHit(pattern)          -> {dmg, dead, evaded|missed}   null = a miss, costs nothing (§25)
     snapshot()                -> everything the HUD needs

   Events are plain objects the UI animates:
     {t:'cast'|'hit'|'miss'|'evade'|'resource'|'cooldown'|'die'|'win', ...} */
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
  function bindableItem(itemId) {
    var def = ITEMS()[itemId];
    if (!def) return false;
    var rules = CHLOE.data.itemRules || ITEMS();
    if (rules && typeof rules.isCombatUsable === 'function') return !!rules.isCombatUsable(itemId);
    var eff = def.effect || {};
    return (eff.hp > 0 || eff.mp > 0);
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

  /* Bound slots live in party.state.binds[charId] = [entry|null, ...], where an
     entry is an ability id ('punch') or a consumable ('item:bandage', §23).
     Invalid entries are dropped: an ability the character does not know, an
     item that does not exist, or an item whose effect is not combat-usable
     (data/items.js owns that rule). Slot 0 still defaults to punch so a fresh
     run always has something on key 1 — but only when it is EMPTY, so a player
     who deliberately put a bandage there keeps it. */
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
    if (!out[0] && known.length) out[0] = known[0];
    p.state.binds[charId] = out;
    autoBind(charId, known, out);
    autoBindItems(charId, out);
    return out;
  }

  /* §21: a level that hands you a move should hand it to you READY. The
     ladder grants an ability and its key on the same level, so a new move
     drops straight onto the new key and you can use it the moment you walk
     back into the church - no trip through the menu to arm your reward.

     Each ability is auto-placed ONCE, remembered in `autoBound`. Without that
     memory, deliberately clearing a key would be impossible: the next call to
     binds() would helpfully put the ability straight back. Run-scoped like
     everything else - it dies with the run. */
  function autoBind(charId, known, out) {
    var p = party();
    if (!p.state.autoBound) p.state.autoBound = {};
    var seen = p.state.autoBound[charId];
    if (!Array.isArray(seen)) seen = [];

    var placed = [];
    for (var k = 0; k < known.length; k++) {
      var id = known[k];
      if (seen.indexOf(id) !== -1) continue;      // already offered a key once
      seen.push(id);
      if (out.indexOf(id) !== -1) continue;       // the player already bound it
      var slot = placeAbility(charId, out, id);
      if (slot === -1) continue;                  // no free key: leave it in the pool
      placed.push({ abilityId: id, slot: slot });
    }
    p.state.autoBound[charId] = seen;
    p.state.binds[charId] = out;
    if (placed.length) lastAutoBound = { charId: charId, placed: placed };
    return placed;
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

     Order comes from data/items.js (`combatUsableIds()` walks the table in
     declaration order: bandage, then energy_drink), so no ids appear here.

     It shares autoBind's `autoBound` memory, keyed by the full 'item:<id>'
     string. Same reason as abilities: without that memory, clearing a bandage
     key would be impossible, because the next call to binds() would put it
     straight back. */
  function autoBindItems(charId, out) {
    var p = party();
    var rules = CHLOE.data.itemRules || ITEMS();
    var ids = (rules && typeof rules.combatUsableIds === 'function')
      ? (rules.combatUsableIds() || []) : [];
    if (!ids.length) return [];
    if (!p.state.autoBound) p.state.autoBound = {};
    var seen = p.state.autoBound[charId];
    if (!Array.isArray(seen)) seen = [];

    var placed = [];
    for (var i = 0; i < ids.length; i++) {
      var key = itemKey(ids[i]);
      if (seen.indexOf(key) !== -1) continue;     // already offered a key once
      seen.push(key);
      if (out.indexOf(key) !== -1) continue;      // the player already bound it
      var slot = out.indexOf(null);
      if (slot === -1) continue;                  // no free key: the moves won
      out[slot] = key;
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

  /* What the last auto-bind put where, so the victory card can say so. */
  var lastAutoBound = null;
  function takeAutoBound() {
    var v = lastAutoBound;
    lastAutoBound = null;
    return v;
  }

  /* `entry` is an ability id, an 'item:<id>' string (§23), or null to clear.
     Named `abilityId` for years and kept callable exactly as before. */
  function bind(charId, slot, entry) {
    var list = binds(charId);
    if (slot < 0 || slot >= list.length) return { ok: false, reason: 'No such slot.' };
    var itemId = itemIdOf(entry);
    if (itemId) {
      if (!ITEMS()[itemId]) return { ok: false, reason: 'No such item.' };
      // "carried" is not the test — an empty slot stays bound and re-arms when
      // you find another. Whether it CAN be used in a fight is (data/items.js).
      if (!bindableItem(itemId)) return { ok: false, reason: 'Not usable in a fight.' };
    } else if (entry && knownAbilities(charId).indexOf(entry) === -1) {
      return { ok: false, reason: 'Not learned yet.' };
    }
    // an ability — or an item — lives in one slot at a time
    if (entry) {
      for (var i = 0; i < list.length; i++) if (list[i] === entry) list[i] = null;
    }
    /* Touching a key by hand makes the player's placement authoritative: drop
       our "we lent this pocket that slot" record for both the entry going in
       and whatever was sitting there, so placeAbility will never shuffle a
       bandage the player put somewhere on purpose. */
    var at = pocketAt(charId);
    if (entry) delete at[entry];
    if (list[slot]) delete at[list[slot]];
    list[slot] = entry || null;
    party().state.binds[charId] = list;
    return { ok: true, binds: list.slice() };
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
      // one entry per knight on the floor
      enemies: (function () {
        var arr = [];
        for (var q = 0; q < count; q++) {
          arr.push({ index: q, life: es.life || 40, max: es.life || 40, alive: true });
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
  function slotAbility(i) {
    var id = liveSlots()[i];
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
      return { ready: false, reason: 'Recharging', pct: cooldownPct(id) };
    }
    if (st.now < c.nextAt) return { ready: false, reason: 'Cooling down', pct: cooldownPct(id) };
    if (!canPay(a.cost)) return { ready: false, reason: 'Not enough ' + ((a.cost && a.cost.mana) ? 'magic' : 'stamina') };
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
    var inv = CHLOE.engine.inventory;
    var have = (inv && typeof inv.count === 'function') ? inv.count(itemId) : 0;
    /* Checked BEFORE the cooldown, so an empty pocket reads "None left." (go
       find one) rather than "cooling down" (wait), which would be a lie. */
    if (have <= 0) return { ok: false, reason: 'None left.' };
    if (st.now < st.itemReadyAt) return { ok: false, reason: 'Pockets cooling down' };

    var eff = def.effect || {};
    var hp = Math.max(0, Math.min(st.max.hp - st.hp, eff.hp || 0));
    var mana = Math.max(0, Math.min(st.max.mana - st.mana, eff.mp || 0));
    /* Refuse before consuming, never after. A bandage pressed at full life is
       a fumbled key, not a decision, and eating the last one for zero healing
       is the single most annoying thing this feature could do. "Never refund
       on a failed press" is satisfied by never taking it in the first place. */
    if (hp <= 0 && mana <= 0) return { ok: false, reason: 'Already full.' };

    st.hp += hp;
    st.mana += mana;
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
    return { ok: true, kind: 'item', item: def, itemId: itemId,
             hp: hp, mana: mana, count: inv.count(itemId),
             lockMs: (cfg.itemUseMs || 350), cooldownMs: (cfg.itemCooldownMs || 2500) };
  }

  /* Number key pressed. Returns {ok} and, on success, starts the cast — the
     3D layer plays the animation and calls hitEnemy() at each hit moment.
     §23: the same key may hold a consumable, which takes the useItem() path
     and never touches ability readiness or cost. */
  function press(slotIndex) {
    if (isOver()) return { ok: false, reason: 'The fight is over.' };
    if (st.cast) return { ok: false, reason: 'Already casting.' };
    if (st.now < st.lockUntil) return { ok: false, reason: 'Recovering.' };
    var itemId = itemIdOf(liveSlots()[slotIndex]);
    if (itemId) return useItem(itemId);
    var a = slotAbility(slotIndex);
    if (!a) return { ok: false, reason: 'Nothing bound to that key.' };
    var r = readiness(a.id);
    if (!r.ready) return { ok: false, reason: r.reason };
    if (!spend(a.cost)) return { ok: false, reason: 'Not enough resources.' };

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
    // §21: his LEVELLED defence, not the flat number in data/enemies.js
    var def = (st.enemyStats && st.enemyStats.def) ||
              (st.enemyDef.stats && st.enemyDef.stats.def) || 0;
    var dmg = Math.max(1, Math.round(
      base * ((a.power || 50) / 100) * chart * (mult || 1) * rand - def * 0.5));
    var idx = (typeof target === 'number') ? target : 0;
    var e = st.enemies[idx];
    if (!e || !e.alive) return null;
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

  /* The knight's swing landed, missed, or was evaded. */
  function takeHit(pattern) {
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
    // §21: he hits with his LEVELLED attack - round 8 is not round 1
    var es = st.enemyStats || st.enemyDef.stats || {};
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
             leaderSwap: swapped };
  }

  /* ---------- tick ---------- */
  function tick(dt) {
    if (!st || st.over) return [];
    var ev = [];
    st.now += dt * 1000;

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
  function resolvedSlots() {
    if (!st) return [];
    var out = [], live = liveSlots(), i;
    for (i = 0; i < live.length; i++) {
      var entry = live[i], itemId = itemIdOf(entry);
      if (itemId) {
        var def = ITEMS()[itemId] || {};
        var inv = CHLOE.engine.inventory;
        var have = (inv && typeof inv.count === 'function') ? inv.count(itemId) : 0;
        var cdLeft = Math.max(0, (st.itemReadyAt - st.now) / 1000);
        var span = (GCFG().itemCooldownMs || 2500);
        /* An empty pocket stays BOUND and greys out — it re-arms the moment
           you pick another one up, so the key never moves under the player. */
        var ready = have > 0 && st.now >= st.itemReadyAt;
        out.push({
          slot: i, key: i + 1, kind: 'item', id: itemId,
          name: def.name || itemId, icon: def.icon || '•',
          desc: def.desc || '', effect: def.effect || {},
          count: have,
          cdPct: Math.max(0, Math.min(1, cdLeft * 1000 / span)),
          cdLeft: cdLeft,
          ready: ready,
          reason: ready ? null : (have <= 0 ? 'None left.' : 'Pockets cooling down')
        });
        continue;
      }
      var a = entry ? ABIL()[entry] : null;
      if (!a) { out.push({ slot: i, key: i + 1, kind: null, id: null, ready: false }); continue; }
      var r = readiness(entry);
      out.push({
        slot: i, key: i + 1, kind: 'ability',
        id: entry, name: a.name, icon: a.icon, type: a.type,
        cost: a.cost || {},
        // "8 STA" / "14 MAG" / "14 MAG + 6 STA" for the HUD chip
        costText: (function (c) {
          var b = [];
          if (c.mana) b.push(c.mana + ' MAG');
          if (c.sta) b.push(c.sta + ' STA');
          return b.join(' + ') || 'free';
        })(a.cost || {}),
        charges: st.cd[entry] ? st.cd[entry].charges : 0,
        maxCharges: a.charges || 1,
        cdPct: cooldownPct(entry),
        cdLeft: st.cd[entry] ? Math.max(0, (st.cd[entry].nextAt - st.now) / 1000) : 0,
        affordable: canPay(a.cost),
        ready: r.ready,
        reason: r.ready ? null : r.reason
      });
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
          each: st.enemies.map(function (e) { return { life: e.life, max: e.max, alive: e.alive }; }),
          name: (CHLOE.data.arena3d && CHLOE.data.arena3d.knight && CHLOE.data.arena3d.knight.name) || st.enemyDef.name
        };
      })(),
      slots: slots,
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
