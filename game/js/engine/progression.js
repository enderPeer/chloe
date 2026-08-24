/* CHLOE — engine/progression.js  (Progression v3, spec §6 + §10 + §12)
   xpToNext(level) = round(22 * level^1.75). Level cap 100.
   Enemy xp reward = round(baseXp * enemyLevel^1.35 / 2 + 10)  -> enemyXp(def).
   On level-up: stats += growth, +1 skill point (toast), learned moves = union
   of learnset entries <= level (falls back to legacy skillsByLevel) UNION
   tree-granted moves; new learnset moves auto-equipped into matching phase
   loadouts with a free slot (else left unequipped, toast).
   statsAt covers all 8 v3 stats (life/stamina/magic/faith/atk/def/spd/mag) with
   silent v2 fallbacks (life<-hp, magic<-mp, stamina/faith defaults) and keeps
   hp/mp aliases so v2 callers keep working.
   Also owns the shared Combat v2 vocabulary: PHASES, PHASE_MODS, move lookup
   (moves.js -> engine failsafes -> legacy skills.js adapter) and loadout
   validation/defaults used by party.js and battle.js. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.progression = (function(){
  'use strict';

  /* ---------- Combat v2 vocabulary ---------- */
  var PHASES = ['neutral', 'aggressive', 'guarded', 'staggered', 'charged'];

  // Damage modifiers per phase. charged.deal (x1.5) applies to the next attack
  // only — battle.js consumes charged -> neutral after that attack resolves.
  var PHASE_MODS = {
    neutral:    { deal: 1.0,  take: 1.0  },
    aggressive: { deal: 1.25, take: 1.15 },
    guarded:    { deal: 1.0,  take: 0.60 },
    staggered:  { deal: 0.75, take: 1.25 },
    charged:    { deal: 1.5,  take: 1.0  }
  };

  // Failsafe moves (spec §10.7): ALWAYS appended to the battle menu, never
  // equippable in loadouts. Data may override by defining the same ids in moves.js.
  var FAILSAFES = {
    struggle: {
      id: 'struggle', name: 'Struggle', cat: 'attack', element: 'none',
      power: 60, usesMag: false, accuracy: 1.0, mpCost: 0,
      usableIn: PHASES.slice(), failsafe: true,
      desc: 'Swing with whatever is left. Never pretty, always there.'
    },
    recover: {
      id: 'recover', name: 'Recover', cat: 'stance', element: 'none',
      stanceTo: 'neutral', accuracy: 1.0, mpCost: 0,
      usableIn: ['staggered'], effect: { hpPct: 5 }, failsafe: true,
      desc: 'Find your feet. Back to neutral, +5% HP.'
    }
  };

  function cap(){
    var c = CHLOE.data && CHLOE.data.config && CHLOE.data.config.levelCap;
    return c || 100; // spec §12: cap 100 (config.js is the single source of truth)
  }

  function xpToNext(level){
    return Math.round(22 * Math.pow(level, 1.75));
  }

  // Enemy xp reward scaling (spec §12): round(baseXp * level^1.35 / 2 + 10).
  function enemyXp(enemyDef){
    if (!enemyDef) return 0;
    var base = (enemyDef.rewards && enemyDef.rewards.xp) || 0;
    var lvl = Math.max(1, enemyDef.level || 1);
    return Math.round(base * Math.pow(lvl, 1.35) / 2 + 10);
  }

  // Engine -> UI notification (toast) — guarded, never throws, no DOM here.
  function notify(text){
    try {
      if (CHLOE.ui && typeof CHLOE.ui.toast === 'function') CHLOE.ui.toast(text);
    } catch(e){}
  }

  /* ---------- stats ---------- */
  // v3 pools with silent v2 fallbacks: life <- hp, magic <- mp; characters
  // without stamina/faith bases get playable defaults (spec §12 migration).
  var POOL_ALIASES  = { life: 'hp', magic: 'mp' };
  var POOL_DEFAULTS = { stamina: { base: 50, growth: 5 }, faith: { base: 5, growth: 0 } };

  function baseAndGrowth(charDef, key){
    var base = charDef.base || {}, growth = charDef.growth || {};
    var alias = POOL_ALIASES[key];
    var b = (base[key] !== undefined) ? base[key] : (alias !== undefined ? base[alias] : undefined);
    var g = (growth[key] !== undefined) ? growth[key] : (alias !== undefined ? growth[alias] : undefined);
    if (b === undefined && POOL_DEFAULTS[key]) { b = POOL_DEFAULTS[key].base; g = (g === undefined) ? POOL_DEFAULTS[key].growth : g; }
    return { b: b || 0, g: g || 0 };
  }

  // Stats at a given level: base + growth * (level - 1). No weapon or tree
  // bonus here — CHLOE.engine.tree.effectiveStats is the full aggregator.
  // Returns all 8 v3 stats plus hp/mp aliases (of life/magic) for v2 callers.
  function statsAt(charDef, level){
    var out = {}, keys = ['life','stamina','magic','faith','atk','def','spd','mag'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var bg = baseAndGrowth(charDef || {}, k);
      out[k] = Math.round(bg.b + bg.g * (Math.max(1, level) - 1));
    }
    out.hp = out.life;
    out.mp = out.magic;
    return out;
  }

  /* ---------- move lookup ---------- */
  // Legacy skills.js entry -> a v2 move, so the game keeps running until
  // data/moves.js lands. Attacks stay attacks; heals become status moves.
  function adaptLegacySkill(s){
    if (s.kind === 'heal') {
      return {
        id: s.id, name: s.name, cat: 'status', element: s.element || 'none',
        accuracy: 1.0, mpCost: s.mpCost || 0, usableIn: PHASES.slice(),
        effect: { healPower: s.power || 100 }, desc: s.desc || '', legacy: true
      };
    }
    return {
      id: s.id, name: s.name, cat: 'attack', element: s.element || 'none',
      power: s.power || 100, usesMag: !!s.usesMag, accuracy: 1.0,
      mpCost: s.mpCost || 0, usableIn: PHASES.slice(), desc: s.desc || '', legacy: true
    };
  }

  // moves.js first, then engine failsafes, then legacy skills.js adapter.
  function getMove(id){
    if (!id) return null;
    var mv = (CHLOE.data && CHLOE.data.moves || {})[id];
    if (mv) return mv;
    if (FAILSAFES[id]) return FAILSAFES[id];
    var s = (CHLOE.data && CHLOE.data.skills || {})[id];
    return s ? adaptLegacySkill(s) : null;
  }

  function usableInPhase(move, phase){
    if (!move) return false;
    var u = move.usableIn;
    if (!u || !u.length) return true; // unspecified = usable everywhere
    return u.indexOf(phase) !== -1;
  }

  /* ---------- learnset ---------- */
  // Full learned move pool at a level: union of learnset entries <= level (in
  // level order) UNION tree-granted moves (spec §12). Falls back to legacy
  // skillsByLevel. Loadout validation and defaults all flow through here, so
  // tree moves are equippable everywhere automatically.
  function movesAt(charDef, level){
    var out = [], seen = {};
    var byLevel = (charDef && (charDef.learnset || charDef.skillsByLevel)) || {};
    var lvls = Object.keys(byLevel).map(Number).sort(function(a,b){ return a - b; });
    for (var i = 0; i < lvls.length; i++) {
      if (lvls[i] > level) break;
      var arr = byLevel[lvls[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        if (!seen[arr[j]]) { seen[arr[j]] = true; out.push(arr[j]); }
      }
    }
    var tree = CHLOE.engine.tree;
    if (charDef && charDef.id && tree && typeof tree.treeMoves === 'function') {
      var tm = tree.treeMoves(charDef.id);
      for (var k = 0; k < tm.length; k++) {
        if (!seen[tm[k]]) { seen[tm[k]] = true; out.push(tm[k]); }
      }
    }
    return out;
  }

  /* ---------- loadouts (5-move rule, spec §10.3) ---------- */
  function validPick(id, phase, learnedIdx){
    if (typeof id !== 'string' || !learnedIdx[id]) return false;
    var mv = getMove(id);
    return !!(mv && !mv.failsafe && usableInPhase(mv, phase));
  }

  function learnedIndex(charDef, level){
    var idx = {}, ids = movesAt(charDef, level);
    for (var i = 0; i < ids.length; i++) idx[ids[i]] = true;
    return idx;
  }

  // Defaults for one character at a level: charDef.defaultLoadouts filtered to
  // learned + usable + <=5; phases it leaves empty are auto-filled from the
  // learned list so a fresh character always has something equipped.
  function defaultLoadoutsFor(charDef, level){
    var out = {};
    if (!charDef) { for (var z = 0; z < PHASES.length; z++) out[PHASES[z]] = []; return out; }
    var dls = charDef.defaultLoadouts || {};
    var learnedIdx = learnedIndex(charDef, level);
    var learnedIds = movesAt(charDef, level);
    for (var p = 0; p < PHASES.length; p++) {
      var phase = PHASES[p], pick = [], seen = {}, i;
      var src = Array.isArray(dls[phase]) ? dls[phase] : [];
      for (i = 0; i < src.length && pick.length < 5; i++) {
        if (!seen[src[i]] && validPick(src[i], phase, learnedIdx)) {
          seen[src[i]] = true; pick.push(src[i]);
        }
      }
      if (!pick.length) {
        for (i = 0; i < learnedIds.length && pick.length < 5; i++) {
          if (!seen[learnedIds[i]] && validPick(learnedIds[i], phase, learnedIdx)) {
            seen[learnedIds[i]] = true; pick.push(learnedIds[i]);
          }
        }
      }
      out[phase] = pick;
    }
    return out;
  }

  /* Silent validation/rebuild of an in-memory loadout store: per phase, the
     list is kept only if it is a valid array (<=5, learned, non-failsafe,
     usable in that phase, no dupes); anything invalid is rebuilt from
     defaults. Pass raw = null to build pure defaults. Always returns all 5
     phase keys. */
  function sanitizeLoadouts(charId, level, raw){
    var charDef = (CHLOE.data && CHLOE.data.characters || {})[charId];
    var defaults = defaultLoadoutsFor(charDef, level);
    if (!charDef) return defaults;
    var learnedIdx = learnedIndex(charDef, level);
    var out = {};
    for (var p = 0; p < PHASES.length; p++) {
      var phase = PHASES[p];
      var arr = (raw && Array.isArray(raw[phase])) ? raw[phase] : null;
      var ok = !!arr && arr.length <= 5;
      var clean = [], seen = {};
      if (ok) {
        for (var i = 0; i < arr.length; i++) {
          if (seen[arr[i]] || !validPick(arr[i], phase, learnedIdx)) { ok = false; break; }
          seen[arr[i]] = true;
          clean.push(arr[i]);
        }
      }
      out[phase] = ok ? clean : (defaults[phase] || []).slice();
    }
    return out;
  }

  /* Auto-equip a newly learned move into every matching phase with a free slot.
     Mutates the given loadouts store. Returns {equipped:[phases], unequipped:bool}. */
  function autoEquip(loadouts, charId, moveId){
    var res = { equipped: [], unequipped: false };
    var mv = getMove(moveId);
    if (!mv || mv.failsafe || !loadouts || !loadouts[charId]) { res.unequipped = !mv || !mv.failsafe; return res; }
    var lo = loadouts[charId];
    for (var p = 0; p < PHASES.length; p++) {
      var phase = PHASES[p];
      if (!usableInPhase(mv, phase)) continue;
      if (!Array.isArray(lo[phase])) lo[phase] = [];
      if (lo[phase].indexOf(moveId) !== -1) { res.equipped.push(phase); continue; }
      if (lo[phase].length < 5) { lo[phase].push(moveId); res.equipped.push(phase); }
    }
    res.unequipped = res.equipped.length === 0;
    return res;
  }

  /* ---------- xp / level-up ---------- */
  /* Grant xp to a runtime member {id, level, xp, hp, mp}. Mutates the member,
     auto-equips new moves into party loadouts (if the party engine is up).
     Returns { levelsGained:[n...], learnedIds:[id...],
               learned:[{id, name, equipped:[phases], unequipped}] }. */
  function grantXp(member, xp){
    var res = { levelsGained: [], learnedIds: [], learned: [] };
    var charDef = CHLOE.data.characters && CHLOE.data.characters[member.id];
    if (!charDef || !(xp > 0)) return res;
    if (member.level >= cap()) return res;

    var before = movesAt(charDef, member.level);
    member.xp += Math.round(xp);

    var wasDown = member.hp <= 0; // KO'd members stay down through a level-up
    while (member.level < cap() && member.xp >= xpToNext(member.level)) {
      member.xp -= xpToNext(member.level);
      member.level += 1;
      res.levelsGained.push(member.level);
      // stats += growth; bump current pools along with the new maximums
      var g = charDef.growth || {};
      member.hp = Math.max(member.hp, 0) + Math.round((g.life !== undefined ? g.life : g.hp) || 0);
      member.mp = Math.max(member.mp, 0) + Math.round((g.magic !== undefined ? g.magic : g.mp) || 0);
      member.stamina = Math.max(member.stamina || 0, 0) + Math.round(baseAndGrowth(charDef, 'stamina').g);
      member.faith = Math.max(member.faith || 0, 0) + Math.round(baseAndGrowth(charDef, 'faith').g);
    }
    // the pool bumps must not silently revive a downed member (revive items own that)
    if (wasDown) member.hp = 0;
    if (member.level >= cap()) member.xp = 0;

    // §12: each level grants +1 skill point (spent in the skill tree screen)
    if (res.levelsGained.length) {
      var pts = res.levelsGained.length;
      res.skillPoints = pts;
      try {
        var pst = CHLOE.engine.party && CHLOE.engine.party.state;
        if (pst) {
          if (!pst.skillPoints || typeof pst.skillPoints !== 'object') pst.skillPoints = {};
          pst.skillPoints[member.id] = (pst.skillPoints[member.id] || 0) + pts;
        }
      } catch(e){}
      notify((charDef.name || member.id) + ' gained ' + (pts === 1 ? 'a skill point!' : pts + ' skill points!'));
    }

    if (res.levelsGained.length) {
      var after = movesAt(charDef, member.level);
      var partyEng = CHLOE.engine.party;
      var loadouts = (partyEng && partyEng.state) ? partyEng.state.loadouts : null;
      if (loadouts && !loadouts[member.id]) {
        loadouts[member.id] = sanitizeLoadouts(member.id, member.level, null);
      }
      for (var i = 0; i < after.length; i++) {
        var id = after[i];
        if (before.indexOf(id) !== -1) continue;
        var mv = getMove(id);
        var name = mv ? mv.name : id;
        var eq = loadouts ? autoEquip(loadouts, member.id, id) : { equipped: [], unequipped: true };
        res.learnedIds.push(id);
        res.learned.push({ id: id, name: name, equipped: eq.equipped, unequipped: eq.unequipped });
        notify((charDef.name || member.id) + ' learned ' + name + '!' +
               (eq.unequipped ? ' (loadout full — not equipped)' : ''));
      }
      // clamp to new maxima (tree-aware: tree stat grants raise the caps)
      var tree = CHLOE.engine.tree;
      var max = (tree && typeof tree.effectiveStats === 'function')
        ? tree.effectiveStats(member) : statsAt(charDef, member.level);
      var maxLife = (max.life !== undefined) ? max.life : max.hp;
      var maxMagic = (max.magic !== undefined) ? max.magic : max.mp;
      if (member.hp > maxLife) member.hp = maxLife;
      if (member.mp > maxMagic) member.mp = maxMagic;
      if (max.stamina !== undefined && (member.stamina || 0) > max.stamina) member.stamina = max.stamina;
      if (max.faith !== undefined && (member.faith || 0) > max.faith) member.faith = max.faith;
    }
    return res;
  }

  return {
    // v1 surface (kept)
    xpToNext: xpToNext,
    enemyXp: enemyXp,
    statsAt: statsAt,
    skillsAt: movesAt,          // alias — returns move ids now
    grantXp: grantXp,
    levelCap: cap,
    // Combat v2
    PHASES: PHASES,
    PHASE_MODS: PHASE_MODS,
    FAILSAFES: FAILSAFES,
    getMove: getMove,
    usableInPhase: usableInPhase,
    movesAt: movesAt,
    defaultLoadoutsFor: defaultLoadoutsFor,
    sanitizeLoadouts: sanitizeLoadouts,
    autoEquip: autoEquip
  };
})();
