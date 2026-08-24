/* CHLOE — engine/arena.js  (Arena battles, spec §16)
   Round-based rules for the 3D church battles. Owns ALL battle math; the 3D
   layer (engine/arena3d.js) only plays visuals and answers "did the strike
   land?", the HUD (ui/battle3d.js) only renders.

   A round:
     1. every living party member picks one attack (or an item / Give Up)
     2. the attacks resolve in SPD order (playerAttack per choice)
     3. the enemy picks a pattern (pickPattern) and swings; the 3D layer
        resolves the dodge and reports hit=true/false into enemyStrike()
     4. stamina regen ticks (startRound), back to 1 — until victory/defeat.

   The player's BODY is the active party member: enemy hits land on them.
   When the body falls, the next living member becomes the body. All down ->
   defeat (roguelike §15: the run ends).
   Statuses/buildup (§12) do not run in the arena (v1) — documented in §16. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.arena = (function(){
  'use strict';

  var state = null;

  function party(){ return CHLOE.engine.party; }
  function prog(){ return CHLOE.engine.progression; }
  function types(){ return CHLOE.data.types; }
  function cfgPatterns(){
    return (CHLOE.data.arena3d && CHLOE.data.arena3d.patterns) || {};
  }
  function charName(id){
    var c = (CHLOE.data.characters || {})[id];
    return (c && c.name) || id;
  }

  /* ---------- lifecycle ---------- */
  function start(enemyId){
    var def = (CHLOE.data.enemies || {})[enemyId];
    if (!def) return null;
    var st = def.stats || {};
    state = {
      enemyId: enemyId,
      enemyDef: def,
      enemy: { life: st.life || 40, max: st.life || 40 },
      round: 1,
      over: false,
      result: null,
      rewards: null,
      lastPattern: null,
      patternStreak: 0
    };
    // body = first living member
    ensureBody();
    return state;
  }

  function get(){ return state; }
  function isOver(){ return !state || state.over; }

  /* ---------- body (who the knight is swinging at) ---------- */
  function body(){
    var p = party();
    var m = p.active();
    return (m && m.life !== 0 && m.hp > 0) ? m : null;
  }
  function ensureBody(){
    var p = party();
    var m = p.active();
    if (m && m.hp > 0) return m;
    var alive = p.aliveMembers();
    if (alive.length) { p.setActive(alive[0].id); return alive[0]; }
    return null;
  }

  /* ---------- choices ---------- */
  /* Attack options for one member: learned attack-cat moves (learnset + tree)
     + the Struggle failsafe. Each: {move, disabled, reason, mult}. */
  function attackOptions(member){
    var p = party(), out = [], seen = {};
    var ids = p.movesOf(member) || [];
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.treeMoves === 'function') {
      var extra = tr.treeMoves(member.id) || [];
      for (var e = 0; e < extra.length; e++) {
        if (ids.indexOf(extra[e]) === -1) ids.push(extra[e]);
      }
    }
    for (var i = 0; i < ids.length; i++) {
      var mv = prog().getMove(ids[i]);
      if (!mv || mv.cat !== 'attack' || seen[mv.id]) continue;
      seen[mv.id] = true;
      out.push(describeOption(member, mv));
    }
    var struggle = prog().getMove('struggle');
    if (struggle && !seen.struggle) out.push(describeOption(member, struggle));
    return out;
  }

  function costOf(mv){
    var c = mv.cost || {};
    return {
      sta: c.sta || 0,
      mp: c.mp || (mv.mpCost || 0),
      faith: c.faith || 0
    };
  }

  function canAfford(member, mv){
    var c = costOf(mv);
    if ((member.stamina || 0) < c.sta) return { ok: false, reason: 'Not enough stamina' };
    if ((member.mp || 0) < c.mp) return { ok: false, reason: 'Not enough magic' };
    if ((member.faith || 0) < c.faith) return { ok: false, reason: 'Not enough faith' };
    return { ok: true };
  }

  function describeOption(member, mv){
    var afford = canAfford(member, mv);
    return {
      move: mv,
      cost: costOf(mv),
      mult: types().multiplier(mv.type || mv.element, state ? state.enemyDef : 'physical'),
      disabled: !afford.ok,
      reason: afford.ok ? null : afford.reason
    };
  }

  /* ---------- player attacks ---------- */
  /* Resolve one member's chosen attack against the enemy.
     Returns {member, move, dmg, mult, missed, killed, log}. */
  function playerAttack(memberId, moveId){
    if (isOver()) return null;
    var p = party();
    var member = p.get(memberId);
    var mv = prog().getMove(moveId);
    if (!member || member.hp <= 0 || !mv) return null;

    var c = costOf(mv);
    member.stamina = Math.max(0, (member.stamina || 0) - c.sta);
    member.mp = Math.max(0, (member.mp || 0) - c.mp);
    member.faith = Math.max(0, (member.faith || 0) - c.faith);

    var res = { member: member, move: mv, dmg: 0, mult: 1, missed: false, killed: false, log: '' };
    var acc = (typeof mv.accuracy === 'number') ? mv.accuracy : 1;
    if (Math.random() > acc) {
      res.missed = true;
      res.log = charName(member.id) + '’s ' + mv.name + ' cuts nothing but incense.';
      return res;
    }

    var eff = p.effStats(member);
    var base = mv.usesMag ? eff.mag : eff.atk;
    var mult = types().multiplier(mv.type || mv.element, state.enemyDef);
    var rand = 0.85 + Math.random() * 0.3;
    var def = (state.enemyDef.stats && state.enemyDef.stats.def) || 0;
    var dmg = Math.max(1, Math.round(base * ((mv.power || 60) / 100) * mult * rand - def * 0.5));

    state.enemy.life = Math.max(0, state.enemy.life - dmg);
    res.dmg = dmg; res.mult = mult;
    res.log = charName(member.id) + ' — ' + mv.name + ': ' + dmg +
      (mult >= 2 ? ' (SUPER)' : (mult <= 0.5 ? ' (resisted)' : ''));
    if (state.enemy.life <= 0) {
      res.killed = true;
      // tree keystone onKillLifePct: the kill feeds the killer (like battle.js)
      var tr = CHLOE.engine.tree;
      if (tr && typeof tr.passives === 'function') {
        var lifePct = (tr.passives(member.id) || {}).onKillLifePct || 0;
        if (lifePct) {
          var mx = p.maxStats(member);
          member.hp = Math.min(mx.hp, member.hp + Math.max(1, Math.round(mx.hp * lifePct / 100)));
        }
      }
      victory();
    }
    return res;
  }

  /* ---------- items (using one costs that member's pick) ---------- */
  function useItem(memberId, itemId){
    if (isOver()) return { ok: false, text: 'The fight is over.' };
    var p = party();
    var member = p.get(memberId);
    if (!member) return { ok: false, text: 'No such member.' };
    // revive items target a FALLEN bandmate, not the (alive) chooser
    var def = (CHLOE.data.items || {})[itemId];
    var target = member;
    if (def && def.effect && def.effect.revivePct) {
      var members = p.state.members;
      for (var i = 0; i < members.length; i++) {
        if (members[i].hp <= 0) { target = members[i]; break; }
      }
    }
    return CHLOE.engine.inventory.use(itemId, target);
  }

  /* ---------- enemy turn ---------- */
  /* Pick a pattern id (weighted, never the same twice in a row after a streak). */
  function pickPattern(){
    if (isOver()) return null;
    var pats = cfgPatterns(), pool = [], id;
    for (id in pats) {
      if (!Object.prototype.hasOwnProperty.call(pats, id)) continue;
      if (id === state.lastPattern && state.patternStreak >= 1) continue;
      var w = pats[id].weight || 1;
      for (var i = 0; i < w; i++) pool.push(id);
    }
    if (!pool.length) { for (id in pats) pool.push(id); }
    if (!pool.length) return null;
    var pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick === state.lastPattern) state.patternStreak++;
    else { state.lastPattern = pick; state.patternStreak = 0; }
    return pats[pick];
  }

  /* The 3D layer resolved the dodge: apply the outcome.
     Returns {hit, dmg, target, koed, bodySwitch, log}. */
  function enemyStrike(pattern, hit){
    if (isOver()) return null;
    var p = party();
    var target = ensureBody();
    var res = { hit: !!hit, dmg: 0, target: target, koed: false, bodySwitch: null, log: '' };
    if (!target) { defeat(); return res; }

    if (!hit) {
      res.log = 'The blade splits empty air. EVADED.';
      return res;
    }

    var estats = state.enemyDef.stats || {};
    var eff = p.effStats(target);
    // chart multiplier vs the member's OWN type/resists (like battle.js);
    // tree resist nodes are PERCENT damage cuts and apply after, never as
    // chart multipliers (they're 5-20 "percent", not 0.5-2.0 multipliers)
    var cdef = (CHLOE.data.characters || {})[target.id] || {};
    var atkType = state.enemyDef.type || state.enemyDef.element;
    var mult = types().multiplier(atkType,
      { type: cdef.type || cdef.element, resists: cdef.resists || null });
    var rand = 0.85 + Math.random() * 0.3;
    var dmg = Math.max(1, Math.round((estats.atk || 6) * ((pattern.power || 100) / 100) * mult * rand - eff.def * 0.5));
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.passives === 'function') {
      var pv = tr.passives(target.id);
      var cut = (pv && pv.resists && pv.resists[types().migrate ? types().migrate(atkType) : atkType]) || 0;
      if (cut) dmg = Math.max(1, Math.round(dmg * (1 - Math.min(90, cut) / 100)));
    }

    target.hp = Math.max(0, target.hp - dmg);
    res.dmg = dmg;
    res.log = pattern.name + ' lands on ' + charName(target.id) + ': ' + dmg + '.';

    if (target.hp <= 0) {
      res.koed = true;
      var next = p.firstAliveOther(target.id);
      if (next) {
        p.setActive(next.id);
        res.bodySwitch = next;
        res.log += ' ' + charName(target.id) + ' falls — ' + charName(next.id) + ' steps in!';
      } else {
        defeat();
        res.log += ' ' + charName(target.id) + ' falls. The nave goes quiet.';
      }
    }
    return res;
  }

  /* ---------- round tick ---------- */
  function startRound(){
    if (isOver()) return;
    state.round++;
    // §12 stamina regen: 20% of max (× tree staminaRegenPct, like battle.js) + faith +1
    var p = party(), members = p.state.members;
    var tr = CHLOE.engine.tree;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (m.hp <= 0) continue;
      var mx = p.maxStats(m);
      var regen = 0;
      if (tr && typeof tr.passives === 'function') {
        regen = (tr.passives(m.id) || {}).staminaRegenPct || 0;
      }
      var pct = 20 * (1 + regen / 100);
      m.stamina = Math.min(mx.sta || 0,
        (m.stamina || 0) + Math.max(1, Math.round((mx.sta || 0) * pct / 100)));
      m.faith = Math.min(mx.faith || 0, (m.faith || 0) + 1);
    }
  }

  /* ---------- flee ---------- */
  function flee(){
    if (isOver()) return { fled: false, over: true };
    var chance = (CHLOE.data.config && CHLOE.data.config.fleeChance) || 0.7;
    if (state.enemyDef.boss) return { fled: false, boss: true };
    if (Math.random() < chance) {
      state.over = true;
      state.result = 'fled';
      return { fled: true };
    }
    return { fled: false }; // UI owes the knight a free swing
  }

  /* ---------- outcomes ---------- */
  function victory(){
    state.over = true;
    state.result = 'victory';
    var p = party();
    var st = p.state;
    if (st.runStats) st.runStats.kills = (st.runStats.kills || 0) + 1;

    var def = state.enemyDef;
    var rw = def.rewards || {};
    var xp = prog().enemyXp(def), shards = rw.shards || 0;
    var rewards = { xp: xp, shards: shards, drops: [], levelUps: [], learned: [] };
    p.addShards(shards);

    var members = st.members;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var res = prog().grantXp(m, xp);
      for (var j = 0; j < res.levelsGained.length; j++) {
        rewards.levelUps.push({ memberId: m.id, level: res.levelsGained[j] });
      }
      for (var k = 0; k < res.learned.length; k++) {
        var l = res.learned[k];
        rewards.learned.push({ memberId: m.id, moveId: l.id, name: l.name, unequipped: l.unequipped });
      }
    }
    var drops = rw.drops || [];
    for (var d = 0; d < drops.length; d++) {
      if (Math.random() < (drops[d].chance || 0)) {
        var item = (CHLOE.data.items || {})[drops[d].itemId];
        if (item) { CHLOE.engine.inventory.add(item.id, 1); rewards.drops.push(item.name); }
      }
    }
    state.rewards = rewards;
    return rewards;
  }

  function defeat(){
    state.over = true;
    state.result = 'defeat';
  }

  return {
    start: start,
    get: get,
    isOver: isOver,
    body: body,
    ensureBody: ensureBody,
    attackOptions: attackOptions,
    playerAttack: playerAttack,
    useItem: useItem,
    pickPattern: pickPattern,
    enemyStrike: enemyStrike,
    startRound: startRound,
    flee: flee
  };
})();
