/* CHLOE — engine/progression.js
   xpToNext(level) = round(25 * level^1.5). Level cap 50.
   On level-up: stats += growth (current hp/mp raised too), skills = union of
   skillsByLevel <= level. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.progression = (function(){
  'use strict';

  function cap(){
    return (CHLOE.data && CHLOE.data.config && CHLOE.data.config.levelCap) || 50;
  }

  function xpToNext(level){
    return Math.round(25 * Math.pow(level, 1.5));
  }

  // Stats at a given level: base + growth * (level - 1). No weapon bonus here.
  function statsAt(charDef, level){
    var out = {}, keys = ['hp','mp','atk','def','spd','mag'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var b = (charDef.base && charDef.base[k]) || 0;
      var g = (charDef.growth && charDef.growth[k]) || 0;
      out[k] = Math.round(b + g * (Math.max(1, level) - 1));
    }
    return out;
  }

  // Full skill list at a level: union of skillsByLevel entries <= level (in level order).
  function skillsAt(charDef, level){
    var out = [], seen = {};
    var byLevel = charDef.skillsByLevel || {};
    var lvls = Object.keys(byLevel).map(Number).sort(function(a,b){ return a - b; });
    for (var i = 0; i < lvls.length; i++) {
      if (lvls[i] > level) break;
      var arr = byLevel[lvls[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        if (!seen[arr[j]]) { seen[arr[j]] = true; out.push(arr[j]); }
      }
    }
    return out;
  }

  /* Grant xp to a runtime member {id, level, xp, hp, mp}.
     Mutates the member; returns { levelsGained:[n...], learned:[skillId...] }. */
  function grantXp(member, xp){
    var res = { levelsGained: [], learned: [] };
    var charDef = CHLOE.data.characters && CHLOE.data.characters[member.id];
    if (!charDef || !(xp > 0)) return res;
    if (member.level >= cap()) return res;

    var before = skillsAt(charDef, member.level);
    member.xp += Math.round(xp);

    while (member.level < cap() && member.xp >= xpToNext(member.level)) {
      member.xp -= xpToNext(member.level);
      member.level += 1;
      res.levelsGained.push(member.level);
      // stats += growth; bump current hp/mp along with the new maximums
      var g = charDef.growth || {};
      member.hp = Math.max(member.hp, 0) + Math.round(g.hp || 0);
      member.mp = Math.max(member.mp, 0) + Math.round(g.mp || 0);
    }
    if (member.level >= cap()) member.xp = 0;

    if (res.levelsGained.length) {
      var after = skillsAt(charDef, member.level);
      for (var i = 0; i < after.length; i++) {
        if (before.indexOf(after[i]) === -1) res.learned.push(after[i]);
      }
      // clamp to new maxima
      var max = statsAt(charDef, member.level);
      if (member.hp > max.hp) member.hp = max.hp;
      if (member.mp > max.mp) member.mp = max.mp;
    }
    return res;
  }

  return {
    xpToNext: xpToNext,
    statsAt: statsAt,
    skillsAt: skillsAt,
    grantXp: grantXp,
    levelCap: cap
  };
})();
