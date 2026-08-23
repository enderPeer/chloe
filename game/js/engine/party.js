/* CHLOE — engine/party.js
   Runtime party state: members, active member, shards, story flags, current scene. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.party = (function(){
  'use strict';

  var state = {
    members: [],   // [{id, level, xp, hp, mp, weaponId}]
    activeId: null,
    shards: 0,
    flags: {},
    scene: null
  };

  function prog(){ return CHLOE.engine.progression; }
  function charDef(id){ return (CHLOE.data.characters || {})[id]; }

  function makeMember(id){
    var def = charDef(id);
    if (!def) { console.warn('[CHLOE] unknown character id: ' + id); return null; }
    var s = prog().statsAt(def, 1);
    return { id: id, level: 1, xp: 0, hp: s.hp, mp: s.mp, weaponId: def.weaponId || null };
  }

  function newGame(){
    state.members = [];
    var order = ['chloe', 'ash'];
    for (var i = 0; i < order.length; i++) {
      var m = makeMember(order[i]);
      if (m) state.members.push(m);
    }
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

  function get(id){
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].id === id) return state.members[i];
    }
    return null;
  }
  function active(){ return get(state.activeId); }
  function setActive(id){
    var m = get(id);
    if (m && m.hp > 0) { state.activeId = id; return true; }
    return false;
  }

  function maxStats(member){
    var def = charDef(member.id);
    if (!def) return { hp: 1, mp: 0, atk: 1, def: 0, spd: 1, mag: 1 };
    return prog().statsAt(def, member.level);
  }
  function weaponOf(member){
    return (CHLOE.data.weapons || {})[member.weaponId] || null;
  }
  // Effective combat stats incl. weapon atk bonus.
  function effStats(member){
    var s = maxStats(member);
    var w = weaponOf(member);
    return {
      maxHp: s.hp, maxMp: s.mp,
      atk: s.atk, def: s.def, spd: s.spd, mag: s.mag,
      weaponAtk: w ? (w.atkBonus || 0) : 0
    };
  }
  function skillsOf(member){
    var def = charDef(member.id);
    if (!def) return [];
    return prog().skillsAt(def, member.level);
  }

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
    }
  }

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

  function applyBlob(blob){
    if (!blob) return false;
    state.members = [];
    var arr = blob.party || [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!charDef(p.id)) { console.warn('[CHLOE] save references unknown character: ' + p.id); continue; }
      state.members.push({
        id: p.id,
        level: Math.max(1, p.level || 1),
        xp: Math.max(0, p.xp || 0),
        hp: Math.max(0, p.hp || 0),
        mp: Math.max(0, p.mp || 0),
        weaponId: p.weaponId || (charDef(p.id).weaponId || null)
      });
    }
    if (!state.members.length) { newGame(); return false; }
    state.activeId = blob.activeId && get(blob.activeId) ? blob.activeId : state.members[0].id;
    if (!active() || active().hp <= 0) {
      var alive = aliveMembers();
      state.activeId = alive.length ? alive[0].id : state.members[0].id;
    }
    state.shards = Math.max(0, blob.shards || 0);
    state.flags = blob.flags || {};
    state.scene = blob.scene || ((CHLOE.data.story && CHLOE.data.story.startScene) || null);
    if (CHLOE.engine.inventory) CHLOE.engine.inventory.load(blob.inventory || {});
    return true;
  }

  return {
    state: state,
    newGame: newGame,
    get: get,
    active: active,
    setActive: setActive,
    maxStats: maxStats,
    effStats: effStats,
    weaponOf: weaponOf,
    skillsOf: skillsOf,
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
