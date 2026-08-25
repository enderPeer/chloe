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

  /* THE ROUND BASELINE (§28 A). Every existing caller keeps reading this and
     keeps getting what it always got: the poster headline, `combat3`'s
     opening enemy stats, the HUD plate and the pattern pool a round rolls
     from. What changed is what it MEANS — it is the level the ROUND is worth,
     not the level any particular knight currently is. A knight's own number
     comes from levelFor() below and is capped against this one. */
  function level() {
    return levelForRound(round());
  }

  function round() {
    var p = CHLOE.engine.party;
    var rs = p && p.state ? p.state.runStats : null;
    return (rs && rs.round) || 1;
  }

  /* ---------- §28 A: the per-knight ladder ----------
     A knight's level is his own: he spawns at 1 (a brute at 2) and climbs on
     seconds alive at a rate his §22 personality sets, capped `overCap` levels
     past the round's baseline so a fight nobody ends cannot spiral.

     These are PURE FUNCTIONS of (personality, seconds, round) exactly like
     everything else in this file — no state, nothing to save or de-sync
     (§15). The knight instance owns the seconds; this owns what they mean. */
  var GROWTH_DEFAULT = {
    startLevel: 1, secondsPerLevel: 6, overCap: 2, tellMs: 800,
    rate: {}, baseBonus: {}
  };
  function growth() {
    var g = T().growth || {};
    var out = {}, k;
    for (k in GROWTH_DEFAULT) out[k] = GROWTH_DEFAULT[k];
    for (k in g) out[k] = g[k];
    return out;
  }

  /* Where a knight of this temperament starts. An unknown personality (or
     none, on the fallback totem) is treated as the plain baseline rather than
     refused — a knight who cannot level is worse than one who levels dully. */
  function spawnLevel(personality) {
    var g = growth();
    return clamp((g.startLevel || 1) + (g.baseBonus[personality] || 0));
  }

  // How far past the round's own baseline any knight is allowed to climb.
  function capForRound(r) {
    return clamp(levelForRound(r) + (growth().overCap || 0));
  }

  /* Seconds ALIVE in this fight -> his level. Floor, not round: a knight is
     what he has finished earning, so the tell fires on a boundary the player
     can be shown rather than halfway through one. */
  function levelFor(personality, seconds, r) {
    var g = growth();
    var per = Math.max(0.1, (g.secondsPerLevel || 6) * (g.rate[personality] || 1));
    var lv = spawnLevel(personality) + Math.floor(Math.max(0, seconds || 0) / per);
    var cap = capForRound(r == null ? round() : r);
    return Math.min(cap, clamp(lv));
  }

  // Seconds per level for this temperament — for the tell, and for a test.
  function secondsPerLevel(personality) {
    var g = growth();
    return Math.max(0.1, (g.secondsPerLevel || 6) * (g.rate[personality] || 1));
  }
  function tellMs() { return growth().tellMs || 800; }

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
    levelForRound: levelForRound, level: level, round: round, rowsUpTo: rowsUpTo,
    patterns: patterns, stats: stats, mults: mults, rowAt: rowAt, nextRow: nextRow,
    // §28 A — the per-knight ladder; compose with patterns()/stats() above
    spawnLevel: spawnLevel, levelFor: levelFor, capForRound: capForRound,
    secondsPerLevel: secondsPerLevel, tellMs: tellMs
  };
})();
