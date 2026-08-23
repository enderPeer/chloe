/* CHLOE — engine/battle.js
   1 active party member vs 1 enemy. Turn order by spd (tie -> player).
   Damage: max(1, round((usesMag?mag:atk+weaponAtk) * power/100 * elemMult * rand(0.85..1.15) - def*0.5))
   Player commands: attack / skill / item / switch / giveup.
   act(action) resolves the whole round and returns a list of events for the UI:
     {t:'log', text, cls?}                          — battle log line
     {t:'dmg', side:'enemy'|'party', amount, mult, hpAfter, maxHp, memberId?}
     {t:'heal', side, amount, kind:'hp'|'mp', hpAfter?, mpAfter?, memberId?}
     {t:'mp', memberId, mpAfter}                    — mp spent (bar refresh)
     {t:'switch', memberId, forced?}
     {t:'ko', side, memberId?}
     {t:'end', result:'victory'|'defeat'|'fled', rewards?}                       */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.battle = (function(){
  'use strict';

  var state = null;

  function party(){ return CHLOE.engine.party; }
  function elements(){ return CHLOE.data.elements; }
  function skillDef(id){ return (CHLOE.data.skills || {})[id] || null; }
  function charName(id){
    var c = (CHLOE.data.characters || {})[id];
    return c ? c.name : id;
  }

  /* ---------- lifecycle ---------- */
  function start(enemyId, opts){
    var def = (CHLOE.data.enemies || {})[enemyId];
    if (!def) {
      console.warn('[CHLOE] battle: unknown enemy id "' + enemyId + '"');
      return null;
    }
    state = {
      enemyId: enemyId,
      enemyDef: def,
      enemy: {
        hp: def.stats.hp, mp: def.stats.mp,
        maxHp: def.stats.hp, maxMp: def.stats.mp
      },
      boss: !!(def.boss || (opts && opts.boss)),
      over: false,
      result: null,
      rewards: null,
      round: 0
    };
    return state;
  }
  function getState(){ return state; }
  function isOver(){ return !state || state.over; }

  /* ---------- helpers ---------- */
  function rand(){ return 0.85 + Math.random() * 0.30; }

  function computeDamage(attStats, weaponAtk, defenderDef, skill, attElem, defElem){
    var base = skill.usesMag ? attStats.mag : (attStats.atk + (weaponAtk || 0));
    var mult = elements().multiplier(skill.element || 'none', defElem || 'none');
    var dmg = Math.max(1, Math.round(base * (skill.power / 100) * mult * rand() - defenderDef * 0.5));
    return { dmg: dmg, mult: mult };
  }

  function log(ev, text, cls){
    ev.push({ t: 'log', text: text, cls: cls || '' });
  }

  function activeMember(){ return party().active(); }

  /* ---------- player-side actions ---------- */
  function playerAttack(ev, skill, skillName){
    var m = activeMember();
    if (!m || m.hp <= 0) return; // fizzles (KO'd before their action)
    var eff = party().effStats(m);
    if (skill.mpCost > 0) {
      if (m.mp < skill.mpCost) { log(ev, 'Not enough MP!', 'sys'); return; }
      m.mp -= skill.mpCost;
      ev.push({ t: 'mp', memberId: m.id, mpAfter: m.mp });
    }

    if (skill.kind === 'heal') {
      var maxHp = eff.maxHp;
      var amount = Math.max(1, Math.round(eff.mag * (skill.power / 100) * rand()));
      var before = m.hp;
      m.hp = Math.min(maxHp, m.hp + amount);
      log(ev, charName(m.id) + ' uses ' + skillName + '!', 'hot');
      ev.push({ t: 'heal', side: 'party', amount: m.hp - before, kind: 'hp', hpAfter: m.hp, memberId: m.id });
      return;
    }

    var def = state.enemyDef;
    var r = computeDamage(
      { atk: eff.atk, mag: eff.mag },
      skill.usesMag ? 0 : eff.weaponAtk,
      def.stats.def, skill, null, def.element
    );
    state.enemy.hp = Math.max(0, state.enemy.hp - r.dmg);
    log(ev, charName(m.id) + (skill.id === 'strike' && skill.mpCost === 0 && skillName === 'Attack'
      ? ' attacks!' : ' uses ' + skillName + '!'), 'hot');
    if (r.mult > 1) log(ev, "It's devastating!", 'sys');
    else if (r.mult < 1) log(ev, def.name + ' shrugs it off...', '');
    ev.push({ t: 'dmg', side: 'enemy', amount: r.dmg, mult: r.mult, hpAfter: state.enemy.hp, maxHp: state.enemy.maxHp });
  }

  function playerItem(ev, itemId, targetId){
    var m = activeMember();
    if (!m || m.hp <= 0) return;
    var target = targetId ? party().get(targetId) : m;
    if (!target) target = m;
    var res = CHLOE.engine.inventory.use(itemId, target);
    log(ev, res.text, res.ok ? 'hot' : 'sys');
    if (res.ok) {
      if (res.revived || res.hp) ev.push({ t: 'heal', side: 'party', amount: res.hp || 0, kind: 'hp', hpAfter: target.hp, memberId: target.id });
      if (res.mp) ev.push({ t: 'heal', side: 'party', amount: res.mp, kind: 'mp', mpAfter: target.mp, memberId: target.id });
    }
  }

  function playerSwitch(ev, toId){
    var to = party().get(toId);
    if (!to || to.hp <= 0 || toId === party().state.activeId) {
      log(ev, "Can't switch there.", 'sys');
      return;
    }
    party().setActive(toId);
    log(ev, charName(toId) + ' steps up!', 'hot');
    ev.push({ t: 'switch', memberId: toId });
  }

  /* ---------- enemy side ---------- */
  function enemyPickSkill(){
    var def = state.enemyDef;
    var usable = [];
    var ids = def.skills || [];
    for (var i = 0; i < ids.length; i++) {
      var s = skillDef(ids[i]);
      if (s && state.enemy.mp >= (s.mpCost || 0)) usable.push(s);
    }
    // 65%: use a skill if any is affordable, else basic hit
    if (usable.length && Math.random() < 0.65) {
      return usable[Math.floor(Math.random() * usable.length)];
    }
    return { id: '_basic', name: 'attack', element: def.element || 'none', kind: 'attack', power: 100, usesMag: false, mpCost: 0 };
  }

  function enemyAct(ev){
    if (state.over || state.enemy.hp <= 0) return;
    var m = activeMember();
    if (!m || m.hp <= 0) m = party().aliveMembers()[0];
    if (!m) return;

    var def = state.enemyDef;
    var skill = enemyPickSkill();
    if (skill.mpCost) state.enemy.mp = Math.max(0, state.enemy.mp - skill.mpCost);

    var memberDef = (CHLOE.data.characters || {})[m.id] || {};
    var eff = party().effStats(m);
    var r = computeDamage(
      { atk: def.stats.atk, mag: def.stats.mag },
      0, eff.def, skill, null, memberDef.element
    );
    m.hp = Math.max(0, m.hp - r.dmg);

    log(ev, def.name + (skill.id === '_basic' ? ' lashes out!' : ' uses ' + skill.name + '!'), '');
    if (r.mult > 1) log(ev, charName(m.id) + " can't take this kind of hit!", 'sys');
    ev.push({ t: 'dmg', side: 'party', amount: r.dmg, mult: r.mult, hpAfter: m.hp, maxHp: eff.maxHp, memberId: m.id });

    if (m.hp <= 0) {
      log(ev, charName(m.id) + ' goes down!', 'sys');
      ev.push({ t: 'ko', side: 'party', memberId: m.id });
      var next = party().firstAliveOther(m.id);
      if (next) {
        // fallen ally auto-forces Switch
        party().setActive(next.id);
        log(ev, charName(next.id) + ' rushes in!', 'hot');
        ev.push({ t: 'switch', memberId: next.id, forced: true });
      }
    }
  }

  /* ---------- outcome ---------- */
  function victory(ev){
    state.over = true;
    state.result = 'victory';
    var def = state.enemyDef;
    var rw = def.rewards || {};
    var xp = rw.xp || 0, shards = rw.shards || 0;
    var rewards = { xp: xp, shards: shards, drops: [], levelUps: [], learned: [] };

    party().addShards(shards);
    log(ev, def.name + ' dissolves into static.', 'hot');
    log(ev, '+' + xp + ' XP · +' + shards + ' ◆ shards', 'hot');

    var members = party().state.members;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var res = CHLOE.engine.progression.grantXp(m, xp);
      for (var j = 0; j < res.levelsGained.length; j++) {
        rewards.levelUps.push({ memberId: m.id, level: res.levelsGained[j] });
        log(ev, charName(m.id) + ' reached Lv ' + res.levelsGained[j] + '!', 'sys');
      }
      for (var k = 0; k < res.learned.length; k++) {
        var sd = skillDef(res.learned[k]);
        var nm = sd ? sd.name : res.learned[k];
        rewards.learned.push({ memberId: m.id, skill: nm });
        log(ev, charName(m.id) + ' learned ' + nm + '!', 'sys');
      }
    }

    var drops = rw.drops || [];
    for (var d = 0; d < drops.length; d++) {
      if (Math.random() < (drops[d].chance || 0)) {
        var item = (CHLOE.data.items || {})[drops[d].itemId];
        if (item) {
          CHLOE.engine.inventory.add(item.id, 1);
          rewards.drops.push(item.name);
          log(ev, 'Found: ' + item.icon + ' ' + item.name + '!', 'hot');
        }
      }
    }

    state.rewards = rewards;
    ev.push({ t: 'end', result: 'victory', rewards: rewards });
  }

  function defeat(ev){
    state.over = true;
    state.result = 'defeat';
    log(ev, 'The dark closes in...', 'sys');
    ev.push({ t: 'end', result: 'defeat' });
  }

  function checkOutcome(ev){
    if (state.over) return true;
    if (state.enemy.hp <= 0) { victory(ev); return true; }
    if (party().allDown()) { defeat(ev); return true; }
    return false;
  }

  /* ---------- main round resolver ---------- */
  function act(action){
    var ev = [];
    if (!state || state.over || !action) return ev;
    state.round++;

    // Give Up is resolved outside spd order: 70% flee, else enemy free hit.
    if (action.type === 'giveup') {
      if (state.boss) { log(ev, 'The doors are gone. There is no leaving this one.', 'sys'); return ev; }
      var chance = (CHLOE.data.config && CHLOE.data.config.fleeChance) || 0.7;
      if (Math.random() < chance) {
        state.over = true;
        state.result = 'fled';
        log(ev, 'You slip back into the dark between songs.', 'hot');
        ev.push({ t: 'end', result: 'fled' });
      } else {
        log(ev, 'The corridor loops you straight back!', 'sys');
        enemyAct(ev);
        checkOutcome(ev);
      }
      return ev;
    }

    var doPlayer = function(){
      if (action.type === 'attack') {
        playerAttack(ev, { id: 'strike', name: 'Attack', element: 'none', kind: 'attack', power: 100, usesMag: false, mpCost: 0 }, 'Attack');
      } else if (action.type === 'skill') {
        var s = skillDef(action.id);
        if (!s) { log(ev, 'Nothing happens.', 'sys'); return; }
        playerAttack(ev, s, s.name);
      } else if (action.type === 'item') {
        playerItem(ev, action.id, action.targetId);
      } else if (action.type === 'switch') {
        playerSwitch(ev, action.id);
      }
    };

    var m = activeMember();
    var pSpd = m ? party().effStats(m).spd : 0;
    var eSpd = state.enemyDef.stats.spd || 0;
    var playerFirst = pSpd >= eSpd; // tie -> player

    if (playerFirst) {
      doPlayer();
      if (!checkOutcome(ev)) { enemyAct(ev); checkOutcome(ev); }
    } else {
      enemyAct(ev);
      if (!checkOutcome(ev)) { doPlayer(); checkOutcome(ev); }
    }
    return ev;
  }

  return {
    start: start,
    act: act,
    state: getState,
    isOver: isOver
  };
})();
