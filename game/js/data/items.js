/* CHLOE — data/items.js — usable in & out of battle
   effect conventions:
     { hp:n }                 -> restore n life
     { mp:n }                 -> restore n magic
     { revivePct:n }          -> revive at n% life
     { revivePct:n, self:1 }  -> §27C: revive the DRINKER, and do it by itself
     { cure:[...] }           -> clear the listed §12 statuses (and their buildup meters)

   COMBAT-USABLE / BINDABLE (§23): whether an item may sit on a hotbar key is a
   property of its EFFECT, never of its id. See CHLOE.data.itemRules below the
   table — the engine asks it, so adding a bigger potion here is a data edit and
   nothing else.
*/
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.items = {
  bandage: {
    id: 'bandage', name: 'Bandage', effect: { hp: 30 }, price: 15, icon: '🩹',
    desc: 'Backstage first aid. Restores 30 HP.'
  },
  energy_drink: {
    id: 'energy_drink', name: 'Energy Drink', effect: { mp: 20 }, price: 20, icon: '🥤',
    desc: 'Tastes like neon. Restores 20 MP.'
  },
  adrenaline_shot: {
    id: 'adrenaline_shot', name: 'Adrenaline Shot', effect: { revivePct: 50 }, price: 60, icon: '💉',
    desc: 'Brings a fallen bandmate back at 50% HP.'
  },
  /* §27C — the one you never press.
     `self:1` is what separates it from the adrenaline shot above: that one is
     aimed at a body already on the floor, this one is drunk by the body the
     knight is currently hunting, and it goes off on its own the instant that
     body would fall. Same `revivePct` convention, same meaning (percent of the
     drinker's MAX life), so nothing new to learn about the number.

     PRICE — 90, and here is the arithmetic. A bandage is 15 for 30 life; the
     adrenaline shot is 60 to stand an ALREADY-fallen ally back up after the
     fact. This is worth more than the shot for one reason: §27C fires it
     BEFORE §19's leader swap, so it does not save the corpse, it saves the
     RUN — the leader keeps the fight, keeps her level and keeps her hotbar.
     An early round pays about 6 shards a knight, so 90 is roughly three
     cleared floors: enough that carrying two instead of six bandages is a real
     decision, and cheap enough to be the thing you save up for after your
     first bad night. It is the most expensive thing on the shelf on purpose. */
  revive_potion: {
    id: 'revive_potion', name: 'Revive Potion', effect: { revivePct: 50, self: 1 },
    price: 90, icon: '🧿',
    desc: 'Bind it and forget it. The moment a killing blow lands it drinks ' +
          'itself and puts you back on your feet at half life. One per fall.'
  },
  /* antidote + tourniquet are SHOP-RESERVED for a future vendor: no drop table
     or pickup grants them yet, and no current enemy inflicts the statuses they
     cure. (sage_smoke IS obtainable — the_hollow drops it; shade_touch curses.) */
  antidote: {
    id: 'antidote', name: 'Antidote', effect: { cure: ['poisoned', 'infection'] }, price: 25, icon: '🧪',
    desc: 'Bitter as a bad review. Cures poison and infection.'
  },
  tourniquet: {
    id: 'tourniquet', name: 'Tourniquet', effect: { cure: ['bleed', 'burn'] }, price: 25, icon: '🩸',
    desc: 'A guitar strap pulled tight. Stops bleeding and cools burns.'
  },
  sage_smoke: {
    id: 'sage_smoke', name: 'Sage Smoke', effect: { cure: ['curse', 'haunt', 'shock'] }, price: 40, icon: '🕯️',
    desc: 'Smells like every backstage superstition. Lifts curses, hauntings, and shocks.'
  }
};

/* ---- Bindable / combat-usable rule (§23, extended by §27C) ---------------
   An item may be bound to a hotbar key if it does something for the person
   carrying it, in a fight, without needing a target picker. There are now TWO
   ways to qualify, and the difference matters to every consumer:

     PRESSABLE  — restores a pool on the drinker, right now. `hp` or `mp`.
                  bandage, energy_drink. You press the key, it happens.
     PASSIVE    — §27C. `revivePct` with `self`. It sits on the key ARMED and
                  spends itself when the killing blow lands. Pressing it does
                  nothing, on purpose, and combat3 refuses the press rather
                  than wasting it.

   Both are BINDABLE (isCombatUsable), so the bind screen offers both and
   combat3.bind() accepts both. Only PRESSABLE ones are auto-placed into the
   §23 pockets at run start (see pressableIds) — a passive you have not bought
   yet must not squat on one of the two pocket keys, and one you have bought is
   a deliberate purchase that deserves a deliberate key.

   The rule is still a property of the EFFECT, never of the id: a bigger potion,
   or a second passive, is a data edit here and nothing else.

   Deliberately NOT bindable, and why:
     revivePct WITHOUT `self` (adrenaline_shot) — it acts on a FALLEN OTHER
       member, so pressing a key is ambiguous: it needs a target picker, and
       inventing one mid-fight is a bigger feature than pockets.
     cure:[...]  — only meaningful against a status the knight cannot yet
       inflict (§12 statuses come from enemies that do not exist in the arena),
       so a bound cure item would be a permanently dead key.

   ONE HONEST OVERLAP: engine/inventory.js's out-of-battle `use()` predates this
   file's rules and branches on `eff.revivePct` alone, so the Items menu will
   also let you pour a revive_potion into a fallen ally between fights. That is
   a strictly weaker use of it than the one it was made for and it cannot break
   anything — but "the one you never press" would read better with a one-line
   `if (eff.self) return refused` guard in inventory.js. Left to that file's
   owner rather than reached into from here.

   ES5 note for consumers: this is a plain IIFE-built namespace, no modules. The
   same members are also mirrored onto CHLOE.data.items as NON-enumerable
   properties, so `CHLOE.data.items.isCombatUsable(id)` works too and anything
   walking the table with for-in / Object.keys still sees only real items. */
CHLOE.data.itemRules = (function(){
  'use strict';

  /* The rule, as data. Any effect key here means "restores a pool on yourself,
     the moment you press it". */
  var COMBAT_EFFECT_KEYS = ['hp', 'mp'];

  /* Accepts an item id or an item def, because callers have one or the other
     depending on whether they came from a bind string or the bag. */
  function defOf(item){
    if (!item) return null;
    if (typeof item === 'string') return CHLOE.data.items[item] || null;
    return item;
  }

  /* Pressable: a key you push, that puts a number back into a pool. */
  function isPressable(item){
    var def = defOf(item), eff = def && def.effect;
    if (!eff) return false;
    for (var i = 0; i < COMBAT_EFFECT_KEYS.length; i++) {
      /* > 0, not just "present": an effect of 0 restores nothing, and a key
         that fires and does nothing reads as a bug to the player. */
      if (eff[COMBAT_EFFECT_KEYS[i]] > 0) return true;
    }
    return false;
  }

  /* Passive: armed on the key, spends itself. Today that is exactly "revives
     the person carrying it" — `self` is the flag that says the target is the
     drinker, which is also what makes it unambiguous enough to bind at all. */
  function isPassiveCombat(item){
    var def = defOf(item), eff = def && def.effect;
    return !!(eff && eff.self && eff.revivePct > 0);
  }

  /* What may sit on a hotbar key at all — the predicate combat3.bind() and the
     bind screen both ask. */
  function isCombatUsable(item){
    return isPressable(item) || isPassiveCombat(item);
  }

  function idsWhere(pred){
    var out = [], id;
    for (id in CHLOE.data.items) {
      if (Object.prototype.hasOwnProperty.call(CHLOE.data.items, id) && pred(id)) out.push(id);
    }
    return out;
  }

  /* Every bindable id, in the order this file declares them. */
  function combatUsableIds(){ return idsWhere(isCombatUsable); }

  /* The auto-bind order §23 asks for (bandage, then energy_drink) — so
     auto-bind can walk this list instead of naming ids. Reorder the table above
     to change it. Passives are excluded: see the header. */
  function pressableIds(){ return idsWhere(isPressable); }

  /* What combat3 scans a bound hotbar for when a killing blow lands (§27C). */
  function passiveReviveIds(){ return idsWhere(isPassiveCombat); }

  /* Percent of MAX life a passive revive stands you back up at. Reads the same
     `revivePct` convention every other revive item uses. */
  function revivePctOf(item){
    var def = defOf(item), eff = def && def.effect;
    return (eff && eff.revivePct > 0) ? eff.revivePct : 0;
  }

  return {
    COMBAT_EFFECT_KEYS: COMBAT_EFFECT_KEYS,
    isCombatUsable: isCombatUsable,
    isPressable: isPressable,
    isPassiveCombat: isPassiveCombat,
    combatUsableIds: combatUsableIds,
    pressableIds: pressableIds,
    passiveReviveIds: passiveReviveIds,
    revivePctOf: revivePctOf
  };
})();

/* Mirror onto the table itself. Non-enumerable on purpose: CHLOE.data.items is
   iterated as a pure id->def map (shop lists, drop tables), and a function that
   showed up as an "item" there would be a nasty bug to chase. */
(function(){
  var rules = CHLOE.data.itemRules, k;
  for (k in rules) {
    if (Object.prototype.hasOwnProperty.call(rules, k)) {
      Object.defineProperty(CHLOE.data.items, k, {
        value: rules[k], enumerable: false, writable: true, configurable: true
      });
    }
  }
})();
