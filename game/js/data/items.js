/* CHLOE — data/items.js — usable in & out of battle
   effect conventions:
     { hp:n }         -> restore n life
     { mp:n }         -> restore n magic
     { revivePct:n }  -> revive fallen ally at n% life
     { cure:[...] }   -> clear the listed §12 statuses (and their buildup meters)

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

/* ---- Bindable / combat-usable rule (§23) --------------------------------
   An item may be bound to a number key and used mid-fight if its effect
   restores a pool on the person drinking it — today that is `hp` or `mp`, so
   bandage and energy_drink qualify and a future Greater Potion needs no code
   in combat3, binds.js or battle3d.js. The list of keys is the rule; keep the
   knowledge here rather than letting call sites test for two hardcoded ids.

   Deliberately NOT combat-usable, and why:
     revivePct (adrenaline_shot) — it acts on a FALLEN OTHER member, so pressing
       a key is ambiguous: it needs a target picker, and inventing one mid-fight
       is a bigger feature than pockets. Out of scope for this pass, not
       forever — when the picker exists, add 'revivePct' to the list below.
     cure:[...]  — only meaningful against a status the knight cannot yet
       inflict (§12 statuses come from enemies that do not exist in the arena),
       so a bound cure item would be a permanently dead key.

   ES5 note for consumers: this is a plain IIFE-built namespace, no modules. The
   same three members are also mirrored onto CHLOE.data.items as NON-enumerable
   properties, so `CHLOE.data.items.isCombatUsable(id)` works too and anything
   walking the table with for-in / Object.keys still sees only real items. */
CHLOE.data.itemRules = (function(){
  'use strict';

  /* The rule, as data. Any effect key here means "usable on yourself, now". */
  var COMBAT_EFFECT_KEYS = ['hp', 'mp'];

  /* Accepts an item id or an item def, because callers have one or the other
     depending on whether they came from a bind string or the bag. */
  function defOf(item){
    if (!item) return null;
    if (typeof item === 'string') return CHLOE.data.items[item] || null;
    return item;
  }

  function isCombatUsable(item){
    var def = defOf(item), eff = def && def.effect;
    if (!eff) return false;
    for (var i = 0; i < COMBAT_EFFECT_KEYS.length; i++) {
      /* > 0, not just "present": an effect of 0 restores nothing, and a key
         that fires and does nothing reads as a bug to the player. */
      if (eff[COMBAT_EFFECT_KEYS[i]] > 0) return true;
    }
    return false;
  }

  /* Every bindable id, in the order this file declares them. That order is the
     auto-bind order §23 asks for (bandage, then energy_drink) — so auto-bind can
     walk this list instead of naming ids. Reorder the table above to change it. */
  function combatUsableIds(){
    var out = [], id;
    for (id in CHLOE.data.items) {
      if (Object.prototype.hasOwnProperty.call(CHLOE.data.items, id) && isCombatUsable(id)) out.push(id);
    }
    return out;
  }

  return {
    COMBAT_EFFECT_KEYS: COMBAT_EFFECT_KEYS,
    isCombatUsable: isCombatUsable,
    combatUsableIds: combatUsableIds
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
