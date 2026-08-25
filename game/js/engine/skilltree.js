/* CHLOE — engine/skilltree.js  (spec §19)
   Reads the shared 1-100 unlock ladder for ONE character at their own level.
   No state of its own: a character's unlocks are a pure function of their
   level, so nothing to save, migrate or de-sync (roguelike §15).

   API
     rowsUpTo(level)      -> [{level, row}]   everything unlocked so far
     abilities(charId)    -> [abilityId]      bindable pool
     slots(charId)        -> n                extra number keys (beyond base)
     stats(charId)        -> {life,magic,...} summed stat grants
     alliesAt(level)      -> [charId]         party members earned by now
     nextRow(level)       -> {level, row}     what the next level gives
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.skilltree = (function () {
  'use strict';

  function T() { return CHLOE.data.skilltree || { rows: {}, maxLevel: 100 }; }

  function levelOf(charId) {
    var p = CHLOE.engine.party;
    var m = p && p.get ? p.get(charId) : null;
    return m ? Math.max(1, m.level) : 1;
  }

  function rowsUpTo(level) {
    var rows = T().rows || {}, out = [];
    for (var L = 1; L <= level; L++) {
      if (rows[L]) out.push({ level: L, row: rows[L] });
    }
    return out;
  }

  /* §31: `ability` may be an id OR an array of them. Row 1 is the only row
     that grants two — the fist and the 9mm, one per mouse button — because a
     mouse with one button bound is not a hotbar. Order is preserved, and it
     matters: known[0] is what combat3's key-1 default reaches for, and that
     must stay the fist. */
  function abilities(charId) {
    var out = [];
    rowsUpTo(levelOf(charId)).forEach(function (e) {
      var a = e.row.ability;
      if (!a) return;
      var list = (typeof a === 'string') ? [a] : a;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && out.indexOf(list[i]) === -1) out.push(list[i]);
      }
    });
    return out;
  }

  function slots(charId) {
    var n = 0;
    rowsUpTo(levelOf(charId)).forEach(function (e) { n += e.row.slot || 0; });
    return n;
  }

  function stats(charId) {
    var out = {};
    rowsUpTo(levelOf(charId)).forEach(function (e) {
      var s = e.row.stat;
      if (!s) return;
      for (var k in s) out[k] = (out[k] || 0) + s[k];
    });
    return out;
  }

  /* §31: what a row can do to an ability it did not grant.
     `costMod: { gun_9mm: { sta: 10 } }` REPLACES that ability's cost from that
     level on; later rows win, so the ladder reads top to bottom the way every
     other grant here does.

     WHY A ROW AND NOT A SECOND ABILITY: the alternative is two entries in
     data/abilities.js — a cheap gun and an expensive one — which the player
     would meet as two icons, two binds and two cooldowns for one weapon. The
     ladder already says what you have EARNED; what it costs to use is the same
     kind of statement. §21's rule that every one of levels 1-9 hands you
     something you can FEEL is satisfied by a discount as honestly as by a move
     — arguably more so, since you feel it on a weapon you already know. */
  function costFor(charId, abilityId, base) {
    var out = null;
    rowsUpTo(levelOf(charId)).forEach(function (e) {
      var m = e.row.costMod;
      if (m && m[abilityId]) out = m[abilityId];
    });
    return out || base;
  }

  /* Party members earned by a given level (the leader's level drives this). */
  function alliesAt(level) {
    var out = [];
    rowsUpTo(level).forEach(function (e) {
      if (e.row.ally && out.indexOf(e.row.ally) === -1) out.push(e.row.ally);
    });
    return out;
  }

  function nextRow(level) {
    var rows = T().rows || {};
    var max = T().maxLevel || 100;
    for (var L = level + 1; L <= max; L++) {
      if (rows[L]) return { level: L, row: rows[L] };
    }
    return null;
  }

  return {
    rowsUpTo: rowsUpTo,
    abilities: abilities,
    slots: slots,
    stats: stats,
    alliesAt: alliesAt,
    costFor: costFor,
    nextRow: nextRow,
    levelOf: levelOf
  };
})();
