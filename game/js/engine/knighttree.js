/* CHLOE — engine/knighttree.js  (spec §21)
   Reads the Hollow Black Knight's ladder. Same shape as engine/skilltree.js:
   pure functions of a level, no state of its own, so there is nothing to save
   or de-sync (§15).

   API
     levelForRound(round)   -> n              his level this round
     level()                -> n              from the CURRENT runStats.round
     rowsUpTo(level)        -> [{level,row}]
     patterns(level)        -> [patternId]    the swings he has learned
     stats(level, baseDef)  -> {life,atk,def} base stats with the multipliers on
     rowAt(level)           -> row            for the poster's headline
     nextRow(level)         -> {level,row}
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.knighttree = (function () {
  'use strict';

  function T() { return CHLOE.data.knighttree || { rows: {}, maxLevel: 100, levelPerRound: 1 }; }

  function clamp(L) {
    var max = T().maxLevel || 100;
    return Math.max(1, Math.min(max, Math.round(L)));
  }

  function levelForRound(round) {
    return clamp(1 + ((round || 1) - 1) * (T().levelPerRound || 1));
  }

  /* His level is the round you are on — beating him is what makes him worse. */
  function level() {
    var p = CHLOE.engine.party;
    var rs = p && p.state ? p.state.runStats : null;
    return levelForRound((rs && rs.round) || 1);
  }

  function rowsUpTo(L) {
    var rows = T().rows || {}, out = [];
    L = clamp(L);
    for (var i = 1; i <= L; i++) {
      if (rows[i]) out.push({ level: i, row: rows[i] });
    }
    return out;
  }

  /* Every pattern unlocked so far. He always has at least the first one —
     a knight with no moves would stand there. */
  function patterns(L) {
    var out = [];
    rowsUpTo(L).forEach(function (e) {
      if (e.row.pattern && out.indexOf(e.row.pattern) === -1) out.push(e.row.pattern);
    });
    if (!out.length) out.push('slash');
    return out;
  }

  /* The LAST row that set a multiplier wins — they are absolute, not
     cumulative, so the table reads as "what he is at level N" rather than
     needing you to multiply nine numbers together in your head. */
  function mults(L) {
    var m = { life: 1, atk: 1, def: 1 };
    rowsUpTo(L).forEach(function (e) {
      if (e.row.life != null) m.life = e.row.life;
      if (e.row.atk != null) m.atk = e.row.atk;
      if (e.row.def != null) m.def = e.row.def;
    });
    return m;
  }

  function stats(L, baseDef) {
    var base = (baseDef && baseDef.stats) || {};
    var m = mults(L);
    var out = {};
    for (var k in base) out[k] = base[k];
    out.life = Math.max(1, Math.round((base.life || 40) * m.life));
    out.atk = Math.max(1, Math.round((base.atk || 10) * m.atk));
    out.def = Math.max(0, Math.round((base.def || 5) * m.def));
    return out;
  }

  function rowAt(L) {
    var rows = T().rows || {};
    L = clamp(L);
    for (var i = L; i >= 1; i--) if (rows[i]) return rows[i];
    return null;
  }

  function nextRow(L) {
    var rows = T().rows || {}, max = T().maxLevel || 100;
    for (var i = clamp(L) + 1; i <= max; i++) if (rows[i]) return { level: i, row: rows[i] };
    return null;
  }

  return {
    levelForRound: levelForRound, level: level, rowsUpTo: rowsUpTo,
    patterns: patterns, stats: stats, mults: mults, rowAt: rowAt, nextRow: nextRow
  };
})();
