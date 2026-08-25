/* CHLOE — engine/shop.js  (§27D — the giftbox vendor)
   Spend Shards ◆ on consumables between fights. Rules only: no DOM, no
   Three.js. ui/shop.js renders whatever stock() returns.

   WHY A DERIVED STOCK, NOT A LIST
   A hardcoded shelf is a second place to remember an item exists, and the §12
   cure items prove what that costs — antidote, tourniquet and sage_smoke were
   authored with prices, descriptions and icons and have been UNBUYABLE ever
   since, because nothing but a drop table ever named them. So the shelf is a
   RULE over data/items.js: anything with a real price is for sale unless its
   def opts out. Adding a potion to data/items.js puts it on the counter, and
   `revive_potion` (§27C, landing in items.js in a parallel pass) will appear
   here the moment it does — this file does not mention it by name and must not
   start to.

   Opt-out, for when something needs a price but not a shelf (a quest token, a
   boss-only drop priced for sell value):
     CHLOE.data.items.foo = { ..., price: 40, noShop: true }

   ATOMICITY (§27D "never partially apply a purchase")
   Every reason to refuse is checked BEFORE anything is written, so buy() is
   either a full purchase or a no-op. The one write that can still fail —
   inventory.add() rejecting an id it does not know — happens before the debit,
   never after, so a bad id can never take your Shards.

   Shards are run-scoped by §15: party.newGame() zeroes them and nothing here
   persists. Buying is exactly as permanent as the run is.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.shop = (function(){
  'use strict';

  function party(){ return CHLOE.engine.party; }
  function inventory(){ return CHLOE.engine.inventory; }
  function items(){ return (CHLOE.data && CHLOE.data.items) || {}; }

  function itemDef(id){
    if (!id) return null;
    var t = items();
    /* hasOwnProperty, not a truth test: data/items.js hangs the itemRules
       helpers off the same object as non-enumerable properties, so
       items()['isCombatUsable'] is a FUNCTION, not an item. Asking for own
       keys only would still find them; asking the table for a def and then
       type-checking it is what actually keeps a helper off the shelf. */
    if (!Object.prototype.hasOwnProperty.call(t, id)) return null;
    var def = t[id];
    return (def && typeof def === 'object') ? def : null;
  }

  /* The shelf rule. Kept as one predicate so stock(), canBuy() and buy() can
     never disagree about what is for sale. */
  function isStocked(def){
    if (!def || typeof def !== 'object') return false;
    if (def.noShop) return false;
    return priceOf(def) > 0;
  }

  /* Shards are whole numbers (party.addShards rounds), so a price is too.
     Anything non-numeric or <= 0 means "not for sale" rather than "free" —
     a free row would let a typo drain the shelf. */
  function priceOf(def){
    var p = def && def.price;
    if (typeof p !== 'number' || !isFinite(p) || p <= 0) return 0;
    return Math.round(p);
  }

  function shards(){
    var p = party();
    return (p && p.state && p.state.shards) || 0;
  }

  /* One row's worth of everything the UI needs, so ui/shop.js never has to
     re-derive affordability and drift from canBuy(). */
  function row(def){
    var price = priceOf(def);
    var have = shards();
    var inv = inventory();
    return {
      id: def.id,
      def: def,
      name: def.name || def.id,
      icon: def.icon || '▪',
      desc: def.desc || '',
      price: price,
      count: (inv && inv.count) ? inv.count(def.id) : 0,
      affordable: have >= price,
      shortfall: Math.max(0, price - have)
    };
  }

  /* Cheapest first, then alphabetical — a stable order that reads as a price
     list and, more importantly, does not reshuffle under the player's cursor
     when an item is added to data/items.js or bought out. */
  function stock(){
    var t = items(), out = [], id, def;
    for (id in t) {
      if (!Object.prototype.hasOwnProperty.call(t, id)) continue;
      def = itemDef(id);
      if (!isStocked(def)) continue;
      out.push(row(def));
    }
    out.sort(function(a, b){
      if (a.price !== b.price) return a.price - b.price;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return out;
  }

  /* {ok, reason, shortfall, price} — `reason` is a machine tag; the UI writes
     the sentence, because the shortfall reads differently on a dimmed row than
     it does in a toast. */
  function canBuy(id){
    var def = itemDef(id);
    if (!def) return { ok: false, reason: 'unknown', shortfall: 0, price: 0 };
    if (!isStocked(def)) return { ok: false, reason: 'not-stocked', shortfall: 0, price: 0 };
    var price = priceOf(def);
    var have = shards();
    if (have < price) {
      return { ok: false, reason: 'poor', shortfall: price - have, price: price };
    }
    var inv = inventory();
    if (!inv || typeof inv.add !== 'function') {
      return { ok: false, reason: 'no-bag', shortfall: 0, price: price };
    }
    return { ok: true, reason: 'ok', shortfall: 0, price: price };
  }

  /* Buy one. Returns {ok, reason, price?, count?, shards?}.
     Validate -> add -> debit. Never the other order: the debit is the only
     step that cannot fail once canBuy() has passed (pure arithmetic on a
     number we just proved is big enough), so it goes last and the purchase has
     no half-state. */
  function buy(id){
    var check = canBuy(id);
    if (!check.ok) return { ok: false, reason: check.reason, shortfall: check.shortfall, price: check.price };

    var def = itemDef(id);
    var price = check.price;
    var p = party();
    var inv = inventory();

    if (!inv.add(def.id, 1)) {
      /* inventory.add already warned. Nothing was debited, so the player is
         exactly where they started. */
      return { ok: false, reason: 'bag-refused', shortfall: 0, price: price };
    }

    /* party.addShards clamps at 0 — we deliberately do NOT lean on that clamp.
       canBuy() proved shards >= price, so this subtraction lands exactly; if it
       ever needed the clamp, the balance shown to the player and the balance
       charged would have disagreed, and the clamp would have hidden it. */
    p.addShards(-price);

    return {
      ok: true,
      reason: 'ok',
      price: price,
      count: inv.count(def.id),
      shards: shards()
    };
  }

  return {
    stock: stock,
    canBuy: canBuy,
    buy: buy,
    /* small reads the UI (and tests) want without reaching into party.state */
    shards: shards,
    priceOf: function(id){ return priceOf(itemDef(id)); },
    isStocked: function(id){ return isStocked(itemDef(id)); }
  };
})();
