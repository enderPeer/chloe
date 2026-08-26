/* CHLOE — engine/cloneai.js
   Clone AI: the mirror-fight enemy that uses the PLAYER's abilities.
   Separate from combat3 (which owns the player's own state) — the clone
   carries its own cooldowns, resources, and decision loop so neither side
   shares a clock or a bar.

   API
     init(stats, abilities)    snapshot the player's stats + ability list
     tick(dt)                  advance cooldowns and regen
     pickAbility(dist)         choose an ability for the current distance
     spend(id)                 deduct cost and arm cooldown
     takeDamage(dmg)           apply damage to the clone's HP, returns true on kill
     abilityToPattern(id)      map a player ability id to a clone attack pattern id
     state()                   read-only access to the live state
     reset()                   tear down for next fight
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.cloneai = (function () {
  'use strict';

  var ABIL = function () { return CHLOE.data.abilities || {}; };
  var PATTERNS = function () {
    return (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
  };

  var st = null;

  /* Ability -> attack-pattern mapping.  The pattern ids are defined in
     data/arena3d.js under the `clone_*` namespace.  Each mirrors the range,
     timing and power of the player ability it represents, expressed as a
     knight-style pattern the existing telegraph/strike pipeline can drive. */
  var PATTERN_MAP = {
    punch:        'clone_punch',
    gun_9mm:      'clone_gun',
    fire_tornado: 'clone_tornado',
    asteroid:     'clone_asteroid',
    water_wave:   'clone_wave',
    killer_fist:  'clone_killer'
  };

  /* ---- lifecycle ---- */

  function init(stats, abilities) {
    st = {
      hp:     stats.hp  || 62,
      maxHp:  stats.hp  || 62,
      mana:   stats.mana || 20,
      maxMana: stats.mana || 20,
      sta:    stats.sta  || 40,
      maxSta: stats.sta  || 40,
      atk:    stats.atk  || 12,
      mag:    stats.mag  || 11,
      def:    stats.def  || 8,
      type:   stats.type || 'fire',
      loadout: (abilities || []).slice(0, 6),
      cd: {},
      alive: true
    };
  }

  function reset() { st = null; }

  function tick(dt) {
    if (!st || !st.alive) return;
    for (var id in st.cd) {
      if (st.cd[id] > 0) st.cd[id] = Math.max(0, st.cd[id] - dt);
    }
    /* Regen: same rates as the player's out-of-combat regen.  The clone
       fights alone, so there is no "out of combat" gate — it always ticks. */
    st.sta  = Math.min(st.maxSta,  st.sta  + 9 * dt);
    st.mana = Math.min(st.maxMana, st.mana + 2.5 * dt);
  }

  /* ---- decision ---- */

  function pickAbility(dist) {
    if (!st || !st.alive) return null;
    var candidates = [];
    for (var i = 0; i < st.loadout.length; i++) {
      var id = st.loadout[i];
      var ab = ABIL()[id];
      if (!ab) continue;
      if (st.cd[id] > 0) continue;
      /* Cost gate. */
      if (ab.cost) {
        if (ab.cost.sta  && st.sta  < ab.cost.sta)  continue;
        if (ab.cost.mana && st.mana < ab.cost.mana) continue;
      }
      /* Range gate: the ability must reach the player.  Allow 20 % slack
         so close-range abilities stay in the pool while the clone closes. */
      var rng = ab.range || 3;
      if (dist > rng * 1.2 && !ab.hitscan) continue;
      candidates.push(id);
    }
    if (!candidates.length) return null;
    /* Weighted random: melee abilities preferred when close, ranged when far.
       A simple linear blend — nothing fancy, just enough to feel deliberate. */
    var weights = [];
    var total = 0;
    for (var j = 0; j < candidates.length; j++) {
      var a = ABIL()[candidates[j]];
      var r = (a && a.range) || 3;
      var w = r > 6 ? (dist > 8 ? 3 : 1) : (dist < 5 ? 3 : 1);
      weights.push(w);
      total += w;
    }
    var roll = Math.random() * total;
    for (var k = 0; k < weights.length; k++) {
      roll -= weights[k];
      if (roll <= 0) return candidates[k];
    }
    return candidates[0];
  }

  function spend(id) {
    if (!st) return;
    var ab = ABIL()[id];
    if (!ab) return;
    if (ab.cost) {
      if (ab.cost.sta)  st.sta  = Math.max(0, st.sta  - ab.cost.sta);
      if (ab.cost.mana) st.mana = Math.max(0, st.mana - ab.cost.mana);
    }
    st.cd[id] = (ab.cooldownMs || 1000) / 1000;
  }

  function takeDamage(dmg) {
    if (!st || !st.alive) return true;
    st.hp = Math.max(0, st.hp - dmg);
    if (st.hp <= 0) { st.alive = false; return true; }
    return false;
  }

  function abilityToPattern(id) {
    return PATTERN_MAP[id] || 'clone_punch';
  }

  function state() { return st; }

  return {
    init: init, tick: tick, pickAbility: pickAbility,
    spend: spend, takeDamage: takeDamage,
    abilityToPattern: abilityToPattern,
    state: state, reset: reset
  };
})();
