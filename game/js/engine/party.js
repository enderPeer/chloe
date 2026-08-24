/* CHLOE — engine/party.js
   Runtime party state: members, active member, shards, story flags, current
   scene, per-character move loadouts (Combat v2, spec §10.3).
   §11: a new game starts SOLO Chloe. Ash joins when the 'roomCleared' flag is
   set (hooked in setFlag — the battle-end path sets that flag) and, defensively,
   when the party enters scene 'stage' with the flag set (scene assignment is
   intercepted via a property setter) or when a cleared save loads without her. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.party = (function(){
  'use strict';

  var _scene = null;
  var _loading = false; // suppress join toasts while applying a save blob

  var state = {
    members: [],   // [{id, level, xp, hp, mp, stamina, faith, weaponId}]  (v3
                   //  pools: hp=life, mp=magic; saved as 'sta' in the blob)
    activeId: null,
    shards: 0,
    flags: {},
    loadouts: {},  // charId -> { phaseId: [<=5 moveIds] }  (Combat v2)
    skillPoints: {}, // charId -> unspent skill points        (Progression v3)
    tree: {}         // charId -> [owned nodeIds]             (Progression v3)
  };

  // scene.js assigns `party.state.scene = id` directly — intercept it so Ash
  // can be added defensively on entering 'stage' after the Room is cleared.
  try {
    Object.defineProperty(state, 'scene', {
      enumerable: true, configurable: true,
      get: function(){ return _scene; },
      set: function(v){
        _scene = v;
        if (v === 'stage') ensureAsh(_loading);
      }
    });
  } catch(e){ state.scene = null; }

  function prog(){ return CHLOE.engine.progression; }
  function charDef(id){ return (CHLOE.data.characters || {})[id]; }

  // Engine -> UI notification (toast) — guarded, never throws, no DOM here.
  function notify(text){
    try {
      if (CHLOE.ui && typeof CHLOE.ui.toast === 'function') CHLOE.ui.toast(text);
    } catch(e){}
  }

  function makeMember(id){
    var def = charDef(id);
    if (!def) { console.warn('[CHLOE] unknown character id: ' + id); return null; }
    var s = prog().statsAt(def, 1);
    return { id: id, level: 1, xp: 0, hp: s.hp, mp: s.mp,
             stamina: s.stamina || 0, faith: s.faith || 0, weaponId: def.weaponId || null };
  }

  function ensureLoadout(m){
    if (!m) return;
    if (!state.loadouts[m.id]) {
      state.loadouts[m.id] = prog().sanitizeLoadouts(m.id, m.level, null);
    }
  }

  // v3 per-character progression stores (resource init lives in makeMember)
  function ensureProgress(m){
    if (!m) return;
    if (typeof state.skillPoints[m.id] !== 'number') state.skillPoints[m.id] = 0;
    if (!Array.isArray(state.tree[m.id])) state.tree[m.id] = [];
  }

  function newGame(){
    state.members = [];
    state.loadouts = {};
    state.skillPoints = {};
    state.tree = {};
    // §11: new game starts solo Chloe; Ash joins once the Room is cleared.
    var m = makeMember('chloe');
    if (m) { state.members.push(m); ensureLoadout(m); ensureProgress(m); }
    state.activeId = state.members.length ? state.members[0].id : null;
    state.shards = 0;
    state.flags = {};
    var story = CHLOE.data.story;
    state.scene = (story && story.startScene) || null;
    if (CHLOE.engine.inventory) CHLOE.engine.inventory.reset();
    // a little starting kit
    if (CHLOE.engine.inventory) {
      CHLOE.engine.inventory.add('bandage', 2);
      CHLOE.engine.inventory.add('energy_drink', 1);
    }
  }

  /* ---------- membership ---------- */
  function get(id){
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].id === id) return state.members[i];
    }
    return null;
  }

  /* Add a character to the party at runtime (e.g. Ash after the Room).
     Idempotent. opts.silent suppresses the "joined" toast. */
  function add(id, opts){
    if (get(id)) return false;
    var m = makeMember(id);
    if (!m) return false;
    state.members.push(m);
    ensureLoadout(m);
    ensureProgress(m);
    if (!state.activeId) state.activeId = m.id;
    if (!(opts && opts.silent)) {
      var def = charDef(id);
      notify((def ? def.name : id) + ' joined the party!');
    }
    return true;
  }

  // §11 hook: if the Room is cleared and Ash is missing, she joins.
  function ensureAsh(silent){
    if (!state.flags || !state.flags.roomCleared) return false;
    if (get('ash') || !charDef('ash')) return false;
    return add('ash', { silent: !!silent });
  }

  function active(){ return get(state.activeId); }
  function setActive(id){
    var m = get(id);
    if (m && m.hp > 0) { state.activeId = id; return true; }
    return false;
  }

  /* ---------- stats ---------- */
  // Maximum pools & core stats, TREE-AWARE (v3): base + growth + tree grants.
  // Keys: hp/mp aliases of life/magic, plus sta/faith and the 8 v3 keys.
  function maxStats(member){
    var e = effStats(member);
    return { hp: e.life, mp: e.magic, sta: e.stamina, faith: e.faith,
             life: e.life, stamina: e.stamina, magic: e.magic,
             atk: e.atk, def: e.def, spd: e.spd, mag: e.mag };
  }
  function weaponOf(member){
    return (CHLOE.data.weapons || {})[member.weaponId] || null;
  }
  /* Effective combat stats — delegates to CHLOE.engine.tree.effectiveStats
     (spec §12: base + growth + weapon + tree; battle, sheet and save all
     consume this, never raw base). NOTE: atk INCLUDES weaponAtk now;
     weaponAtk stays as a separate field for display breakdowns only. */
  function effStats(member){
    var tree = CHLOE.engine.tree;
    if (tree && typeof tree.effectiveStats === 'function') return tree.effectiveStats(member);
    // fallback (tree.js not loaded): base + growth + weapon, no tree grants
    var def = charDef(member.id);
    var s = def ? prog().statsAt(def, member.level)
                : { hp: 1, mp: 0, stamina: 0, faith: 0, atk: 1, def: 0, spd: 1, mag: 1 };
    var w = weaponOf(member);
    var wAtk = w ? (w.atkBonus || 0) : 0;
    return {
      life: s.hp, stamina: s.stamina || 0, magic: s.mp, faith: s.faith || 0,
      maxHp: s.hp, maxMp: s.mp,
      atk: s.atk + wAtk, def: s.def, spd: s.spd, mag: s.mag,
      weaponAtk: wAtk
    };
  }
  // Learned move ids at the member's current level (learnset union).
  function movesOf(member){
    var def = charDef(member.id);
    if (!def) return [];
    return prog().movesAt(def, member.level);
  }

  /* ---------- loadouts (Combat v2) ---------- */
  /* Sanitized copy of a character's loadouts: { phaseId: [<=5 moveIds] } for
     all 5 phases. Returns null for characters not in the party. */
  function getLoadout(charId){
    var m = get(charId);
    if (!m) return null;
    ensureLoadout(m);
    // re-sanitize on read (level may have risen; invalid entries silently rebuild)
    state.loadouts[charId] = prog().sanitizeLoadouts(charId, m.level, state.loadouts[charId]);
    try { return JSON.parse(JSON.stringify(state.loadouts[charId])); }
    catch(e){ return state.loadouts[charId]; }
  }

  /* Replace one phase's equipped list. ids: array of <=5 move ids; unknown,
     unlearned, failsafe, wrong-phase or duplicate ids are dropped (reported in
     `rejected`). Returns {ok, loadout?, rejected?, error?}. Autosaves. */
  function setLoadout(charId, phase, ids){
    var m = get(charId);
    if (!m) return { ok: false, error: 'No such party member.' };
    if (prog().PHASES.indexOf(phase) === -1) return { ok: false, error: 'Unknown phase.' };
    if (!Array.isArray(ids)) return { ok: false, error: 'Moves must be a list.' };

    var learned = movesOf(m), clean = [], rejected = [], seen = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (typeof id !== 'string' || seen[id]) continue;
      seen[id] = true;
      var mv = prog().getMove(id);
      if (mv && !mv.failsafe && learned.indexOf(id) !== -1 && prog().usableInPhase(mv, phase)) {
        clean.push(id);
      } else {
        rejected.push(id);
      }
    }
    if (clean.length > 5) return { ok: false, error: 'Max 5 moves per phase.' };

    ensureLoadout(m);
    state.loadouts[charId][phase] = clean;
    try {
      var sv = CHLOE.engine.save;
      if (sv && sv.getCurrent && sv.getCurrent()) sv.autosave();
    } catch(e){}
    return { ok: true, loadout: getLoadout(charId), rejected: rejected };
  }

  /* ---------- liveness ---------- */
  function aliveMembers(){
    return state.members.filter(function(m){ return m.hp > 0; });
  }
  function firstAliveOther(exceptId){
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      if (m.id !== exceptId && m.hp > 0) return m;
    }
    return null;
  }
  function allDown(){ return aliveMembers().length === 0; }

  function fullHeal(member){
    var list = member ? [member] : state.members;
    for (var i = 0; i < list.length; i++) {
      var s = maxStats(list[i]);
      list[i].hp = s.hp;
      list[i].mp = s.mp;
      list[i].stamina = s.sta || 0;
      list[i].faith = s.faith || 0;
    }
  }

  /* ---------- shards & flags ---------- */
  function addShards(n){
    state.shards = Math.max(0, Math.round(state.shards + (n || 0)));
  }
  function loseShardsPct(pct){
    var lost = Math.floor(state.shards * (pct / 100));
    state.shards -= lost;
    return lost;
  }

  function setFlag(name, val){
    if (!name) return;
    state.flags[name] = (val === undefined) ? true : val;
    // §11: battle-end path sets 'roomCleared' (scene.js applies the hotspot's
    // setsFlag after victory) — Ash joins the moment it lands.
    if (name === 'roomCleared' && state.flags[name]) ensureAsh(false);
  }
  function getFlag(name){ return !!state.flags[name]; }

  // Defeat: respawn at start scene with full HP, lose 30% shards.
  function respawn(){
    var pct = (CHLOE.data.config && CHLOE.data.config.defeatShardLossPct) || 30;
    var lost = loseShardsPct(pct);
    fullHeal();
    if (!active() || active().hp <= 0) {
      state.activeId = state.members.length ? state.members[0].id : null;
    }
    var story = CHLOE.data.story;
    if (story && story.startScene) state.scene = story.startScene;
    return lost;
  }

  /* ---------- save blob <-> state ---------- */
  function applyBlob(blob){
    if (!blob) return false;
    _loading = true;
    try {
      state.members = [];
      var arr = blob.party || [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        if (!p || typeof p !== 'object') { console.warn('[CHLOE] save contains a malformed party entry'); continue; }
        if (!charDef(p.id)) { console.warn('[CHLOE] save references unknown character: ' + p.id); continue; }
        state.members.push({
          id: p.id,
          level: Math.max(1, p.level || 1),
          xp: Math.max(0, p.xp || 0),
          hp: Math.max(0, p.hp || 0),
          mp: Math.max(0, p.mp || 0),
          // blob field is 'sta' (v3 snapshot); runtime field is 'stamina'
          stamina: (typeof p.sta === 'number') ? Math.max(0, p.sta)
                 : ((typeof p.stamina === 'number') ? Math.max(0, p.stamina) : null), // null -> fill below
          faith: (typeof p.faith === 'number') ? Math.max(0, p.faith) : null,
          weaponId: p.weaponId || (charDef(p.id).weaponId || null)
        });
      }
      if (!state.members.length) { newGame(); return false; }

      /* Skill tree state FIRST (v3) — tree moves must count as learned before
         loadouts are validated. v1/v2 migration: save.migrate seeded
         skillPoints = level-1 per member and an empty tree; here node ids are
         validated per character (unknown ids dropped, points refunded). */
      state.skillPoints = {};
      state.tree = {};
      var rawPts = (blob.skillPoints && typeof blob.skillPoints === 'object') ? blob.skillPoints : {};
      var rawTree = (blob.tree && typeof blob.tree === 'object') ? blob.tree : {};
      var treeEng = CHLOE.engine.tree;
      for (var t = 0; t < state.members.length; t++) {
        var tm = state.members[t];
        if (treeEng && typeof treeEng.sanitizeState === 'function') {
          var clean = treeEng.sanitizeState(tm.id, tm.level, rawTree[tm.id], rawPts[tm.id]);
          state.tree[tm.id] = clean.owned;
          state.skillPoints[tm.id] = clean.points;
        } else {
          state.tree[tm.id] = Array.isArray(rawTree[tm.id]) ? rawTree[tm.id].slice() : [];
          state.skillPoints[tm.id] = Math.max(0, Math.floor(rawPts[tm.id] || 0));
        }
      }

      // v1/v2 members carried no sta/faith — fill from (tree-aware) maxima,
      // then clamp everything to the current caps.
      for (var r = 0; r < state.members.length; r++) {
        var rm = state.members[r], mx = maxStats(rm);
        if (rm.stamina === null || rm.stamina === undefined) rm.stamina = mx.sta || 0;
        if (rm.faith === null || rm.faith === undefined) rm.faith = mx.faith || 0;
        if (rm.stamina > (mx.sta || 0)) rm.stamina = mx.sta || 0;
        if (rm.faith > (mx.faith || 0)) rm.faith = mx.faith || 0;
      }

      // Loadouts: silently validate/rebuild per character (save v2 migration —
      // v1 blobs arrive with loadouts:{} and get pure defaults + learned level).
      state.loadouts = {};
      var rawLo = (blob.loadouts && typeof blob.loadouts === 'object') ? blob.loadouts : {};
      for (var j = 0; j < state.members.length; j++) {
        var m = state.members[j];
        state.loadouts[m.id] = prog().sanitizeLoadouts(m.id, m.level, rawLo[m.id]);
      }

      state.activeId = blob.activeId && get(blob.activeId) ? blob.activeId : state.members[0].id;
      if (!active() || active().hp <= 0) {
        var alive = aliveMembers();
        state.activeId = alive.length ? alive[0].id : state.members[0].id;
      }
      state.shards = Math.max(0, blob.shards || 0);
      state.flags = blob.flags || {};
      state.scene = blob.scene || ((CHLOE.data.story && CHLOE.data.story.startScene) || null);
      if (CHLOE.engine.inventory) CHLOE.engine.inventory.load(blob.inventory || {});
      // Defensive §11: a solo save with the Room already cleared gets Ash back.
      ensureAsh(true);
      return true;
    } finally {
      _loading = false;
    }
  }

  return {
    state: state,
    newGame: newGame,
    get: get,
    add: add,
    ensureAsh: ensureAsh,
    active: active,
    setActive: setActive,
    maxStats: maxStats,
    effStats: effStats,
    weaponOf: weaponOf,
    movesOf: movesOf,
    skillsOf: movesOf,   // legacy alias (returns move ids)
    getLoadout: getLoadout,
    setLoadout: setLoadout,
    aliveMembers: aliveMembers,
    firstAliveOther: firstAliveOther,
    allDown: allDown,
    fullHeal: fullHeal,
    addShards: addShards,
    loseShardsPct: loseShardsPct,
    setFlag: setFlag,
    getFlag: getFlag,
    respawn: respawn,
    applyBlob: applyBlob
  };
})();
