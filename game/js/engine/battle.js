/* CHLOE — engine/battle.js — Combat v2 (spec §10: phases & moves)
   1 active party member vs 1 enemy. Sequential turns by spd (tie -> player).
   Every combatant is always in one phase: neutral | aggressive | guarded |
   staggered | charged (modifiers table in progression.PHASE_MODS).

   API contract (battle.js owns ALL state & rules; battleui.js only renders):
     start(enemyId, opts) -> state
       state: { enemy:{hp,mp,maxHp,maxMp}, playerPhase, enemyPhase,
                blocks:{p,e}, over, result, turn, boss, enemyDef, rewards }
     act(moveId) / item(itemId, targetId) / switchTo(charId) / flee()
       -> ordered event array for the UI to animate. Each resolves the full
       exchange; a move pick that is not on the current menu (or MP-disabled)
       returns a lone log event WITHOUT consuming the exchange.
     menu() -> current <=5 equipped+usable moves (+failsafes) with disabled flags.
     getLoadout(charId) / setLoadout(charId, phase, ids<=5) — loadout editor I/O.
     canSwitch() / canFlee() / phases() — rule lookups so the UI never computes.

   Event types (ordered array; side is 'p' | 'e'):
     {t:'log',    text, cls}                                   — battle log line
     {t:'move',   side, moveId, name, cat}                     — a move is used
     {t:'mp',     side, memberId?, mpAfter}                    — MP paid/restored
     {t:'dmg',    side (the RECEIVER), amount, mult, hpAfter, maxHp,
                  memberId?, blocked?, dot?, label? ('SUPER'|'RESIST')}
     {t:'block',  side, kind:'set'|'hit', cats?, elements?, moveId?, label?}
     {t:'miss',   side (the attacker), moveId, label:'WHIFF'}
     {t:'phase',  side, phase, from, reason}                   — phase badge update
     {t:'status', side, kind:'buff'|'debuff'|'dot'|'dot_tick', stat?, amount?, turns?, name?}
     {t:'heal',   side, amount, kind:'hp'|'mp', hpAfter?, mpAfter?, memberId?}
     {t:'ko',     side, memberId?}
     {t:'switch', side:'p', memberId, forced?}
     {t:'end',    result:'victory'|'defeat'|'fled', rewards?}

   Resolution order per move (spec §10.4, implemented exactly):
     1 MP  2 stance  3 status  4 defense (block until own next turn)
     5 attack (whiff->staggered; matching block->x0.2 + attacker staggered,
       defender stays guarded; else v1 formula x elem x deal-mod x take-mod,
       charged x1.5 consumed -> neutral; raw elem >=2: defender staggered +
       attacker aggressive; <=0.5: defender aggressive + attacker aggr->neutral)
     6 staggered auto-recovery at the start of the turn after a turn spent staggered
     7 failsafes Struggle (always) / Recover (only while staggered) always appended.
   Unchanged from v1: items/switch/flee rules, boss no-flee, victory rewards,
   defeat/respawn, autosave on battle end. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.battle = (function(){
  'use strict';

  var state = null;

  /* ---------- shorthands ---------- */
  function party(){ return CHLOE.engine.party; }
  function prog(){ return CHLOE.engine.progression; }
  function elements(){ return CHLOE.data.elements; }
  function moveDef(id){ return prog().getMove(id); }
  function charName(id){
    var c = (CHLOE.data.characters || {})[id];
    return c ? c.name : id;
  }
  function rand(){ return 0.85 + Math.random() * 0.30; }
  function other(s){ return s === 'p' ? 'e' : 'p'; }
  function log(ev, text, cls){ ev.push({ t: 'log', text: text, cls: cls || '' }); }
  function pick(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

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
      enemy: { hp: def.stats.hp, mp: def.stats.mp, maxHp: def.stats.hp, maxMp: def.stats.mp },
      playerPhase: 'neutral',   // battle always starts both sides neutral
      enemyPhase: 'neutral',
      blocks: { p: null, e: null },     // {cats:[], elements:[], moveId} | null
      effects: { p: [], e: [] },        // [{kind:'buff'|'debuff'|'dot', stat?, amount, turns, name?}]
      recover: { p: false, e: false },  // staggered auto-recovery pending
      boss: !!(def.boss || (opts && opts.boss)),
      over: false,
      result: null,
      rewards: null,
      turn: 0
    };
    return state;
  }
  function getState(){ return state; }
  function isOver(){ return !state || state.over; }
  function phases(){ return prog().PHASE_MODS; }

  /* ---------- phase & side helpers ---------- */
  function getPhase(s){ return s === 'p' ? state.playerPhase : state.enemyPhase; }
  function setPhase(ev, s, phase, reason){
    var from = getPhase(s);
    if (from === phase) return;
    if (s === 'p') state.playerPhase = phase; else state.enemyPhase = phase;
    ev.push({ t: 'phase', side: s, phase: phase, from: from, reason: reason || '' });
  }

  function actorName(s){
    if (s === 'e') return state.enemyDef.name;
    var m = party().active();
    return m ? charName(m.id) : '???';
  }
  function playerElement(){
    var m = party().active();
    var cd = m && (CHLOE.data.characters || {})[m.id];
    return (cd && cd.element) || 'none';
  }
  function sideElement(s){
    return s === 'e' ? (state.enemyDef.element || 'none') : playerElement();
  }

  function baseStats(s){
    if (s === 'e') {
      var st = state.enemyDef.stats || {};
      return { atk: st.atk || 1, def: st.def || 0, spd: st.spd || 1, mag: st.mag || 1 };
    }
    var m = party().active();
    if (!m) return { atk: 1, def: 0, spd: 1, mag: 1 };
    var eff = party().effStats(m);
    return { atk: eff.atk, def: eff.def, spd: eff.spd, mag: eff.mag };
  }
  function statMod(s, stat){
    var list = state.effects[s], mod = 1;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if ((e.kind === 'buff' || e.kind === 'debuff') && e.stat === stat) {
        mod += (e.kind === 'buff' ? 1 : -1) * (e.amount || 0) / 100;
      }
    }
    return Math.max(0.25, mod);
  }
  function effStat(s, stat){ return baseStats(s)[stat] * statMod(s, stat); }
  function weaponAtkOf(s){
    if (s === 'e') return 0;
    var m = party().active();
    return m ? party().effStats(m).weaponAtk : 0;
  }
  function maxHpOf(s){
    if (s === 'e') return state.enemy.maxHp;
    var m = party().active();
    return m ? party().effStats(m).maxHp : 1;
  }
  function hpOf(s){
    if (s === 'e') return state.enemy.hp;
    var m = party().active();
    return m ? m.hp : 0;
  }

  // Voluntary/forced switch and KO reset the player side's battle state.
  function resetSideCombat(ev, s, reason){
    state.blocks[s] = null;
    state.effects[s] = [];
    state.recover[s] = false;
    setPhase(ev, s, 'neutral', reason);
  }

  /* ---------- damage & healing ---------- */
  // Returns true if the ORIGINAL target was KO'd by this damage (even when a
  // forced switch immediately brings in a fresh member on the player side).
  function applyDamage(ev, s, amount, mult, extra){
    extra = extra || {};
    if (s === 'e') {
      state.enemy.hp = Math.max(0, state.enemy.hp - amount);
      ev.push({ t: 'dmg', side: 'e', amount: amount, mult: mult, hpAfter: state.enemy.hp,
                maxHp: state.enemy.maxHp, blocked: !!extra.blocked, dot: !!extra.dot, label: extra.label || '' });
      if (state.enemy.hp <= 0) { ev.push({ t: 'ko', side: 'e' }); return true; }
      return false;
    }
    var m = party().active();
    if (!m) return false;
    var eff = party().effStats(m);
    m.hp = Math.max(0, m.hp - amount);
    ev.push({ t: 'dmg', side: 'p', amount: amount, mult: mult, hpAfter: m.hp, maxHp: eff.maxHp,
              memberId: m.id, blocked: !!extra.blocked, dot: !!extra.dot, label: extra.label || '' });
    if (m.hp <= 0) {
      log(ev, charName(m.id) + ' goes down!', 'sys');
      ev.push({ t: 'ko', side: 'p', memberId: m.id });
      var next = party().firstAliveOther(m.id);
      if (next) {
        // fallen ally auto-forces Switch (v1 rule, unchanged)
        party().setActive(next.id);
        log(ev, charName(next.id) + ' rushes in!', 'hot');
        ev.push({ t: 'switch', side: 'p', memberId: next.id, forced: true });
        resetSideCombat(ev, 'p', 'switch');
      }
      return true;
    }
    return false;
  }

  function healSide(ev, s, amount){
    if (!(amount > 0)) return;
    if (s === 'e') {
      var before = state.enemy.hp;
      state.enemy.hp = Math.min(state.enemy.maxHp, state.enemy.hp + amount);
      ev.push({ t: 'heal', side: 'e', amount: state.enemy.hp - before, kind: 'hp', hpAfter: state.enemy.hp });
      return;
    }
    var m = party().active();
    if (!m) return;
    var maxHp = party().effStats(m).maxHp;
    var b = m.hp;
    m.hp = Math.min(maxHp, m.hp + amount);
    ev.push({ t: 'heal', side: 'p', amount: m.hp - b, kind: 'hp', hpAfter: m.hp, memberId: m.id });
  }

  function restoreMp(ev, s, amount){
    if (!(amount > 0)) return;
    if (s === 'e') {
      state.enemy.mp = Math.min(state.enemy.maxMp, state.enemy.mp + amount);
      ev.push({ t: 'heal', side: 'e', amount: amount, kind: 'mp', mpAfter: state.enemy.mp });
      return;
    }
    var m = party().active();
    if (!m) return;
    var maxMp = party().effStats(m).maxMp;
    var b = m.mp;
    m.mp = Math.min(maxMp, m.mp + amount);
    ev.push({ t: 'heal', side: 'p', amount: m.mp - b, kind: 'mp', mpAfter: m.mp, memberId: m.id });
  }

  function payMp(ev, s, cost){
    if (!cost) return true;
    if (s === 'e') {
      if (state.enemy.mp < cost) return false;
      state.enemy.mp -= cost;
      ev.push({ t: 'mp', side: 'e', mpAfter: state.enemy.mp });
      return true;
    }
    var m = party().active();
    if (!m || m.mp < cost) return false;
    m.mp -= cost;
    ev.push({ t: 'mp', side: 'p', memberId: m.id, mpAfter: m.mp });
    return true;
  }

  /* ---------- move resolution (spec §10.4, steps 1-5) ---------- */
  function applyEffect(ev, s, mv){
    var eff = mv.effect;
    if (!eff) return;
    var t = other(s);
    // legacy skills.js heal adapter: % of mag, like the v1 heal formula
    if (eff.healPower) {
      healSide(ev, s, Math.max(1, Math.round(effStat(s, 'mag') * (eff.healPower / 100) * rand())));
    }
    if (eff.hpPct) healSide(ev, s, Math.max(1, Math.round(maxHpOf(s) * eff.hpPct / 100)));
    if (eff.hp)    healSide(ev, s, Math.round(eff.hp));
    if (eff.mp)    restoreMp(ev, s, Math.round(eff.mp));
    if (eff.buff) {
      var bStat = eff.stat || (typeof eff.buff === 'string' ? eff.buff : 'atk');
      var bAmt = eff.amount || 20, bTurns = eff.turns || 3;
      state.effects[s].push({ kind: 'buff', stat: bStat, amount: bAmt, turns: bTurns, name: mv.name });
      log(ev, actorName(s) + "'s " + bStat + ' rises!', s === 'p' ? 'hot' : '');
      ev.push({ t: 'status', side: s, kind: 'buff', stat: bStat, amount: bAmt, turns: bTurns, name: mv.name });
    }
    if (eff.debuff) {
      var dStat = eff.stat || (typeof eff.debuff === 'string' ? eff.debuff : 'atk');
      var dAmt = eff.amount || 20, dTurns = eff.turns || 3;
      state.effects[t].push({ kind: 'debuff', stat: dStat, amount: dAmt, turns: dTurns, name: mv.name });
      log(ev, actorName(t) + "'s " + dStat + ' falls!', 'sys');
      ev.push({ t: 'status', side: t, kind: 'debuff', stat: dStat, amount: dAmt, turns: dTurns, name: mv.name });
    }
    if (eff.dot) {
      var oAmt = eff.amount || 5, oTurns = eff.turns || 3;
      state.effects[t].push({ kind: 'dot', amount: oAmt, turns: oTurns, name: mv.name });
      log(ev, actorName(t) + ' is afflicted by ' + mv.name + '!', 'sys');
      ev.push({ t: 'status', side: t, kind: 'dot', amount: oAmt, turns: oTurns, name: mv.name });
    }
  }

  function doAttack(ev, a, mv){
    var b = other(a);
    // accuracy roll — miss => attacker staggered ("whiff")
    var acc = (mv.accuracy === undefined || mv.accuracy === null) ? 1 : mv.accuracy;
    if (Math.random() >= acc) {
      log(ev, actorName(a) + "'s " + mv.name + ' whiffs!', 'sys');
      ev.push({ t: 'miss', side: a, moveId: mv.id, label: 'WHIFF' });
      setPhase(ev, a, 'staggered', 'whiff');
      return;
    }

    var elemMult = elements().multiplier(mv.element || 'none', sideElement(b));
    var aPhase = getPhase(a), bPhase = getPhase(b);
    var mods = phases();
    var base = mv.usesMag ? effStat(a, 'mag') : (effStat(a, 'atk') + weaponAtkOf(a));
    var dmg = Math.max(1, Math.round(
      base * ((mv.power || 100) / 100) * elemMult *
      mods[aPhase].deal * mods[bPhase].take * rand() -
      effStat(b, 'def') * 0.5
    ));

    // active block matching cat OR element: x0.2, attacker staggered, defender stays guarded
    var blk = state.blocks[b];
    var blocked = !!(blk && (
      (blk.cats && blk.cats.indexOf(mv.cat || 'attack') !== -1) ||
      (blk.elements && blk.elements.indexOf(mv.element || 'none') !== -1)
    ));
    if (blocked) {
      dmg = Math.max(1, Math.round(dmg * 0.2));
      log(ev, actorName(b) + ' blocks it!', 'sys');
      ev.push({ t: 'block', side: b, kind: 'hit', moveId: blk.moveId, label: 'BLOCKED' });
      applyDamage(ev, b, dmg, elemMult, { blocked: true });
      setPhase(ev, a, 'staggered', 'blocked');
      return;
    }

    if (elemMult >= 2) log(ev, "It's devastating!", 'sys');
    var koed = applyDamage(ev, b, dmg, elemMult,
      { label: elemMult >= 2 ? 'SUPER' : (elemMult <= 0.5 ? 'RESIST' : '') });
    if (elemMult <= 0.5 && !koed) log(ev, actorName(b) + ' shrugs it off...', '');

    // charged is consumed by the attack (x1.5 already applied via deal-mod)
    if (aPhase === 'charged') setPhase(ev, a, 'neutral', 'charge spent');

    // phase shifts by RAW element multiplier. A KO'd defender gets none — a
    // freshly switched-in member must not inherit the fallen one's stagger.
    if (elemMult >= 2) {
      if (!koed) setPhase(ev, b, 'staggered', 'super-effective hit');
      setPhase(ev, a, 'aggressive', 'super-effective hit');
    } else if (elemMult <= 0.5) {
      if (!koed) setPhase(ev, b, 'aggressive', 'shrugged it off');
      if (getPhase(a) === 'aggressive') setPhase(ev, a, 'neutral', 'attack resisted');
    }
  }

  function useMove(ev, s, mv){
    if (!mv) { log(ev, 'Nothing happens.', 'sys'); return; }
    if (!payMp(ev, s, mv.mpCost || 0)) { log(ev, actorName(s) + ' has no MP left for that!', 'sys'); return; }
    var cat = mv.cat || 'attack';
    ev.push({ t: 'move', side: s, moveId: mv.id, name: mv.name, cat: cat });
    if (mv.id === '_basic') log(ev, actorName(s) + ' lashes out!', '');
    else if (mv.id === 'struggle') log(ev, actorName(s) + ' struggles!', s === 'p' ? 'hot' : '');
    else log(ev, actorName(s) + ' uses ' + mv.name + '!', s === 'p' ? 'hot' : '');

    if (cat === 'stance') {
      if (mv.stanceTo) setPhase(ev, s, mv.stanceTo, 'stance');
      applyEffect(ev, s, mv);
      return;
    }
    if (cat === 'status') {
      applyEffect(ev, s, mv);
      return;
    }
    if (cat === 'defense') {
      setPhase(ev, s, 'guarded', 'defense');
      var b = mv.blocks || {};
      state.blocks[s] = {
        cats: (b.cats || []).slice(),
        elements: (b.elements || []).slice(),
        moveId: mv.id
      };
      ev.push({ t: 'block', side: s, kind: 'set', cats: state.blocks[s].cats,
                elements: state.blocks[s].elements, moveId: mv.id });
      applyEffect(ev, s, mv);
      return;
    }
    doAttack(ev, s, mv); // 'attack' (and unknown cats default to attack)
  }

  /* ---------- turn frame (block expiry, dots, staggered recovery) ---------- */
  function beginTurn(ev, s){
    // a registered block lasts until the start of this combatant's NEXT turn
    state.blocks[s] = null;
    // staggered recovery: back to neutral at the start of the turn after a
    // turn finished while staggered
    if (state.recover[s]) {
      state.recover[s] = false;
      if (getPhase(s) === 'staggered') setPhase(ev, s, 'neutral', 'recovered');
    }
  }

  function endTurn(ev, s){
    // dots tick at the end of the afflicted side's turn; buffs/debuffs count down
    var list = state.effects[s], keep = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.kind === 'dot' && hpOf(s) > 0 && !state.over) {
        var amt = Math.max(1, Math.round(e.amount || 1));
        log(ev, actorName(s) + ' suffers from ' + (e.name || 'the affliction') + '!', 'sys');
        ev.push({ t: 'status', side: s, kind: 'dot_tick', amount: amt, name: e.name });
        applyDamage(ev, s, amt, 1, { dot: true });
      }
      e.turns -= 1;
      if (e.turns > 0) keep.push(e);
    }
    state.effects[s] = keep;
    if (getPhase(s) === 'staggered') state.recover[s] = true;
  }

  /* ---------- player turn ---------- */
  function menuEntry(mv, m){
    var cost = mv.mpCost || 0;
    var short = m.mp < cost;
    return {
      id: mv.id, name: mv.name, cat: mv.cat || 'attack', element: mv.element || 'none',
      power: mv.power, usesMag: !!mv.usesMag,
      accuracy: (mv.accuracy === undefined || mv.accuracy === null) ? 1 : mv.accuracy,
      mpCost: cost, desc: mv.desc || '', failsafe: !!mv.failsafe,
      disabled: short, reason: short ? 'Not enough MP' : ''
    };
  }

  /* The current phase's equipped+usable moves (<=5) with failsafes ALWAYS
     appended: Struggle (every phase), Recover (only while staggered). A phase
     with 0 equipped usable moves still offers these. */
  function menu(){
    var out = [];
    if (!state || state.over) return out;
    var m = party().active();
    if (!m) return out;
    var phase = state.playerPhase;
    var lo = party().getLoadout(m.id);
    var ids = (lo && lo[phase]) || [];
    var seen = {};
    for (var i = 0; i < ids.length && out.length < 5; i++) {
      var mv = moveDef(ids[i]);
      if (!mv || seen[mv.id]) continue;
      if (!prog().usableInPhase(mv, phase)) continue;
      seen[mv.id] = true;
      out.push(menuEntry(mv, m));
    }
    var st = moveDef('struggle');
    if (st && !seen[st.id]) out.push(menuEntry(st, m));
    if (phase === 'staggered') {
      var rc = moveDef('recover');
      if (rc && !seen[rc.id]) out.push(menuEntry(rc, m));
    }
    return out;
  }

  function playerItem(ev, itemId, targetId){
    var m = party().active();
    if (!m || m.hp <= 0) return;
    var target = targetId ? party().get(targetId) : m;
    if (!target) target = m;
    var res = CHLOE.engine.inventory.use(itemId, target);
    log(ev, res.text, res.ok ? 'hot' : 'sys');
    if (res.ok) {
      if (res.revived || res.hp) ev.push({ t: 'heal', side: 'p', amount: res.hp || 0, kind: 'hp', hpAfter: target.hp, memberId: target.id });
      if (res.mp) ev.push({ t: 'heal', side: 'p', amount: res.mp, kind: 'mp', mpAfter: target.mp, memberId: target.id });
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
    ev.push({ t: 'switch', side: 'p', memberId: toId });
    resetSideCombat(ev, 'p', 'switch');
  }

  /* The move pick was validated in act() against the SAME menu the UI rendered.
     If a forced switch happened earlier in this exchange (enemy went first and
     KO'd the chooser), the incoming member does NOT execute the fallen one's
     move — the switch-in ate the action. */
  function playerTurn(ev, action){
    beginTurn(ev, 'p');
    var m = party().active();
    if (m && m.hp > 0) {
      if (action.type === 'move') {
        if (action.memberId && m.id !== action.memberId) {
          log(ev, charName(m.id) + ' is still finding the beat...', 'sys');
        } else {
          useMove(ev, 'p', action.move || moveDef(action.id));
        }
      } else if (action.type === 'item') {
        playerItem(ev, action.id, action.targetId);
      } else if (action.type === 'switch') {
        playerSwitch(ev, action.id);
      }
    }
    endTurn(ev, 'p');
  }

  /* ---------- enemy turn (AI 'phased', spec §10.5) ---------- */
  function enemyMoveDefs(){
    var d = state.enemyDef;
    var ids = d.moveset || d.skills || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var mv = moveDef(ids[i]);
      if (mv) out.push(mv);
    }
    return out;
  }
  function enemyUsable(){
    var phase = state.enemyPhase, all = enemyMoveDefs(), out = [];
    for (var i = 0; i < all.length; i++) {
      if (prog().usableInPhase(all[i], phase) && state.enemy.mp >= (all[i].mpCost || 0)) out.push(all[i]);
    }
    return out;
  }
  function isHealish(mv){
    return mv.cat === 'status' ||
      !!(mv.effect && (mv.effect.hpPct || mv.effect.hp || mv.effect.healPower));
  }
  function bestAttack(attacks){
    var pe = playerElement(), best = null, bestScore = -1;
    for (var i = 0; i < attacks.length; i++) {
      var score = (attacks[i].power || 100) * elements().multiplier(attacks[i].element || 'none', pe);
      if (score > bestScore) { bestScore = score; best = attacks[i]; }
    }
    return best;
  }

  function pickEnemyMove(){
    var usable = enemyUsable();
    var attacks = usable.filter(function(mv){ return (mv.cat || 'attack') === 'attack'; });

    // staggered: Recover or best attack
    if (state.enemyPhase === 'staggered') {
      if (!attacks.length || Math.random() < 0.5) return moveDef('recover');
      return bestAttack(attacks);
    }

    if (state.enemyDef.ai === 'phased' || state.enemyDef.moveset) {
      // player charged + a defense move in the kit -> 60% guard
      if (state.playerPhase === 'charged') {
        var defs = usable.filter(function(mv){ return mv.cat === 'defense'; });
        if (defs.length && Math.random() < 0.6) return pick(defs);
      }
      // low HP + heal/status available -> 40% use it
      if (state.enemy.hp < state.enemy.maxHp * 0.3) {
        var help = usable.filter(isHealish);
        if (help.length && Math.random() < 0.4) return pick(help);
      }
      // prefer super-effective vs the current player element
      var pe = playerElement();
      var supers = attacks.filter(function(mv){
        return elements().multiplier(mv.element || 'none', pe) >= 2;
      });
      if (supers.length) return pick(supers);
      if (attacks.length) return pick(attacks);
      return moveDef('struggle');
    }

    // legacy 'basic' AI: 65% random usable attack move, else a plain hit
    if (attacks.length && Math.random() < 0.65) return pick(attacks);
    return {
      id: '_basic', name: 'attack', cat: 'attack',
      element: state.enemyDef.element || 'none', power: 100, usesMag: false,
      accuracy: 1, mpCost: 0, usableIn: prog().PHASES.slice()
    };
  }

  function enemyTurn(ev){
    if (state.over || state.enemy.hp <= 0) return;
    beginTurn(ev, 'e');
    var mv = pickEnemyMove();
    if (mv) useMove(ev, 'e', mv);
    endTurn(ev, 'e');
  }

  /* ---------- outcome (unchanged v1 rewards/defeat rules) ---------- */
  function tryAutosave(){
    try {
      var sv = CHLOE.engine.save;
      if (sv && sv.getCurrent && sv.getCurrent()) sv.autosave();
    } catch(e){}
  }

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
        var l = res.learned[k];
        rewards.learned.push({ memberId: m.id, moveId: l.id, name: l.name,
                               equipped: l.equipped, unequipped: l.unequipped });
        log(ev, charName(m.id) + ' learned ' + l.name + '!' +
                (l.unequipped ? ' (loadout full — not equipped)' : ''), 'sys');
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
    tryAutosave();
  }

  function defeat(ev){
    state.over = true;
    state.result = 'defeat';
    log(ev, 'The dark closes in...', 'sys');
    ev.push({ t: 'end', result: 'defeat' });
    tryAutosave();
  }

  function checkOutcome(ev){
    if (state.over) return true;
    if (state.enemy.hp <= 0) { victory(ev); return true; }
    if (party().allDown()) { defeat(ev); return true; }
    return false;
  }

  /* ---------- exchange resolver ---------- */
  function doFlee(ev){
    // Give Up: 70% flee, else enemy free hit. Boss fights: no leaving.
    if (state.boss) {
      log(ev, 'The doors are gone. There is no leaving this one.', 'sys');
      return ev;
    }
    state.turn++;
    var chance = (CHLOE.data.config && CHLOE.data.config.fleeChance) || 0.7;
    if (Math.random() < chance) {
      state.over = true;
      state.result = 'fled';
      log(ev, 'You slip back into the dark between songs.', 'hot');
      ev.push({ t: 'end', result: 'fled' });
      tryAutosave();
    } else {
      log(ev, 'The corridor loops you straight back!', 'sys');
      enemyTurn(ev);
      checkOutcome(ev);
    }
    return ev;
  }

  // Accepts the v2 contract (a moveId string) and, defensively, the legacy v1
  // action objects ({type:'attack'|'skill'|'item'|'switch'|'giveup', ...}).
  function normalizeAction(arg){
    if (typeof arg === 'string') return { type: 'move', id: arg };
    if (arg && typeof arg === 'object') {
      switch (arg.type) {
        case 'move':   return { type: 'move', id: arg.id };
        case 'attack': return { type: 'move', id: 'struggle' };
        case 'skill':  return { type: 'move', id: arg.id };
        case 'item':   return { type: 'item', id: arg.id, targetId: arg.targetId };
        case 'switch': return { type: 'switch', id: arg.id };
        case 'flee':
        case 'giveup': return { type: 'flee' };
      }
    }
    return null;
  }

  function act(arg){
    var ev = [];
    if (!state || state.over) return ev;
    var action = normalizeAction(arg);
    if (!action) return ev;
    if (action.type === 'flee') return doFlee(ev);

    /* Validate a move pick NOW, against the exact menu the UI rendered (state
       has not mutated since render — only act() mutates it). A pick that is
       not offered / MP-disabled does NOT consume the exchange. The resolved
       move def + chooser are pinned so mid-exchange phase changes (enemy goes
       first, staggers or KOs the chooser) can't void a legitimate choice. */
    if (action.type === 'move') {
      var list = menu(), entry = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === action.id) { entry = list[i]; break; }
      if (!entry) { log(ev, 'Nothing happens.', 'sys'); return ev; }
      if (entry.disabled) { log(ev, 'Not enough MP!', 'sys'); return ev; }
      action.move = moveDef(entry.id);
      var chooser = party().active();
      action.memberId = chooser ? chooser.id : null;
    }

    state.turn++;
    var pSpd = effStat('p', 'spd'), eSpd = effStat('e', 'spd');
    var playerFirst = pSpd >= eSpd; // tie -> player

    if (playerFirst) {
      playerTurn(ev, action);
      if (!checkOutcome(ev)) { enemyTurn(ev); checkOutcome(ev); }
    } else {
      enemyTurn(ev);
      if (!checkOutcome(ev)) { playerTurn(ev, action); checkOutcome(ev); }
    }
    return ev;
  }

  /* ---------- action surface (contract) ---------- */
  function item(itemId, targetId){ return act({ type: 'item', id: itemId, targetId: targetId }); }
  function switchTo(charId){ return act({ type: 'switch', id: charId }); }
  function flee(){
    var ev = [];
    if (!state || state.over) return ev;
    return doFlee(ev);
  }

  function canSwitch(){
    var p = party();
    return !!(p && p.state.members.length > 1 && p.firstAliveOther(p.state.activeId));
  }
  function canFlee(){ return !!state && !state.over && !state.boss; }

  /* Loadout editor I/O (validated: <=5, learned, phase-legal; autosaves). */
  function getLoadout(charId){ return party().getLoadout(charId); }
  function setLoadout(charId, phase, ids){ return party().setLoadout(charId, phase, ids); }

  return {
    start: start,
    act: act,
    item: item,
    switchTo: switchTo,
    flee: flee,
    menu: menu,
    state: getState,
    isOver: isOver,
    canSwitch: canSwitch,
    canFlee: canFlee,
    phases: phases,
    getLoadout: getLoadout,
    setLoadout: setLoadout
  };
})();
