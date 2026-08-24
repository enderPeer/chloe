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

  function abilities(charId) {
    var out = [];
    rowsUpTo(levelOf(charId)).forEach(function (e) {
      if (e.row.ability && out.indexOf(e.row.ability) === -1) out.push(e.row.ability);
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
    nextRow: nextRow,
    levelOf: levelOf
  };
})();
