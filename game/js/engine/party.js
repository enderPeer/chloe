/* CHLOE — engine/party.js
   Runtime party state: members, active member, shards, story flags, current
   scene, per-character move loadouts (Combat v2, spec §10.3).
   Roguelike (spec §15): this state IS the run — nothing is persisted, and
   newGame() is the only way it gets (re)built.
   §11: a new game starts SOLO Chloe. Ash joins when the 'roomCleared' flag is
   set (hooked in setFlag — the battle-end path sets that flag) and, defensively,
   when the party enters scene 'stage' with the flag set (scene assignment is
   intercepted via a property setter). */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.party = (function(){
  'use strict';

  var _scene = null;

  var state = {
    members: [],   // [{id, level, xp, hp, mp, stamina, faith, weaponId}]  (v3
                   //  pools: hp=life, mp=magic)
    activeId: null,
    shards: 0,
    flags: {},
    loadouts: {},  // charId -> { phaseId: [<=5 moveIds] }  (Combat v2)
    binds: {},     // charId -> [entry|null] per number key  (Combat v3 §17;
                   //  an entry is an ability id or 'item:<id>' — §23 pockets)
    mouseBinds: {},   // charId -> {mouseL:entry|null, mouseR:entry|null} (§27B —
                      //  addressed by id, never by index; see data/config.js)
    autoBound: {},    // charId -> entries auto-bind has PLACED at least once (§21/§23)
    bindsCleared: {}, // charId -> entries the PLAYER emptied off a key (§27A)
    pocketAt: {},  // charId -> {'item:<id>': slot} auto-bind lent it (§23)
    skillPoints: {}, // charId -> unspent skill points        (Progression v3)
    tree: {},        // charId -> [owned nodeIds]             (Progression v3)
    runStats: { kills: 0, round: 1, trophies: [] } // this run only — shown on the death panel (§15)
  };

  // scene.js assigns `party.state.scene = id` directly — intercept it so Ash
  // can be added defensively on entering 'stage' after the Room is cleared.
  try {
    Object.defineProperty(state, 'scene', {
      enumerable: true, configurable: true,
      get: function(){ return _scene; },
      set: function(v){
        _scene = v;
        if (v === 'stage') ensureAsh(false);
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

  /* ---------- the hotbar, as ONE unit (§27A) ----------
     THE BUG THIS FUNCTION EXISTS TO MAKE IMPOSSIBLE.
     The hotbar is not one map, it is five that only mean anything together:
       binds        what is on each number key
       mouseBinds   what is on LMB/RMB (§27B)
       autoBound    what auto-bind has already placed, so a level-up card does
                    not re-announce a move you have had for six rounds
       bindsCleared what the PLAYER deliberately emptied off a key, so the
                    engine never puts it back
       pocketAt     which key auto-bind LENT a consumable, so it may shuffle
                    that one right and nothing the player placed by hand
     Wiping any subset of those and keeping the rest is the §27A bug in one
     move: a `binds` map cleared while `autoBound` survives leaves every
     ability that was ever auto-placed marked "done" with nowhere to be, and
     they never come back. The old code carried a comment warning that two of
     them had to move together; a comment cannot be called, so this can.

     Call it for one character, or with no id to reset the whole party. It is
     the ONLY sanctioned way to rebuild a hotbar from empty — reaching into
     party.state.binds directly is what re-arms the trap.

     (binds() self-heals as a second line of defence, so even a caller that
     ignores this recovers. Both, not either: the reset keeps the memories
     honest, the self-heal survives a caller who never learned about it.) */
  var BIND_STORES = ['binds', 'mouseBinds', 'autoBound', 'bindsCleared', 'pocketAt'];
  function resetBinds(charId){
    for (var i = 0; i < BIND_STORES.length; i++) {
      var k = BIND_STORES[i];
      if (!state[k] || typeof state[k] !== 'object') state[k] = {};
      if (charId) delete state[k][charId];
      else state[k] = {};
    }
    return true;
  }

  function newGame(){
    state.members = [];
    state.loadouts = {};
    state.skillPoints = {};
    state.tree = {};
    state.runStats = { kills: 0, round: 1, trophies: [] };
    /* Every part of the hotbar is run-scoped (§15) and goes together (§27A).
       Item binds are the reason this cannot be sloppy: 'item:bandage'
       validates against the item table, which has no idea a new run started,
       so a stale pocket layout would otherwise follow you into the next run
       with auto-bind refusing to redo it. */
    resetBinds();
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
  /* §19: allies are earned by LEVEL now, not by clearing the room. The shared
     ladder says who joins when (Ash at 3); they arrive at level 1 and level
     up on their own from there. Idempotent — safe to call every level-up. */
  function ensureAllies(silent){
    var sk = CHLOE.engine.skilltree;
    if (!sk || typeof sk.alliesAt !== 'function') return false;
    var lead = active() || state.members[0];
    if (!lead) return false;
    var want = sk.alliesAt(lead.level) || [];
    var joined = false;
    for (var i = 0; i < want.length; i++) {
      if (!get(want[i]) && charDef(want[i])) {
        if (add(want[i], { silent: !!silent })) joined = true;
      }
    }
    return joined;
  }
  // legacy name kept: older call sites still ask for Ash by the room flag
  function ensureAsh(silent){ return ensureAllies(silent); }

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
     (spec §12: base + growth + weapon + tree; battle and sheet
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
     `rejected`). Returns {ok, loadout?, rejected?, error?}. */
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

  function setFlag(name, val){
    if (!name) return;
    state.flags[name] = (val === undefined) ? true : val;
    // §11: battle-end path sets 'roomCleared' (scene.js applies the hotspot's
    // setsFlag after victory) — Ash joins the moment it lands.
    if (name === 'roomCleared' && state.flags[name]) ensureAsh(false);
  }
  function getFlag(name){ return !!state.flags[name]; }

  return {
    state: state,
    newGame: newGame,
    resetBinds: resetBinds,   // §27A: the hotbar's five maps move as one
    get: get,
    add: add,
    ensureAsh: ensureAsh,
    ensureAllies: ensureAllies,
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
    setFlag: setFlag,
    getFlag: getFlag
  };
})();
