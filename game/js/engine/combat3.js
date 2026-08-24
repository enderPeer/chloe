/* CHLOE — engine/combat3.js  (Combat v3, spec §17)
   Real-time fight rules. Owns resources, cast/cooldown/charge state, evade
   windows and damage math. Knows nothing about DOM or Three.js: the 3D layer
   (engine/arena3d.js) asks "may I cast?" and reports "the strike connected",
   the HUD (ui/battle3d.js) only renders what `snapshot()` returns.

   Frame contract:
     start(enemyId)            -> state
     tick(dt)                  -> events[]   (drives regen, casts, cooldowns)
     press(slotIndex)          -> {ok, reason?, ability?}   number keys 1-9
     evade()                   -> {ok, reason?, dirLocked?}
     spendSprint(dt)           -> bool       (false = out of stamina)
     hitEnemy(ability, mult)   -> {dmg, killed}   called by the 3D hit test
     takeHit(pattern)          -> {dmg, dead, evaded}
     snapshot()                -> everything the HUD needs

   Events are plain objects the UI animates:
     {t:'cast'|'hit'|'miss'|'evade'|'resource'|'cooldown'|'die'|'win', ...} */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.combat3 = (function () {
  'use strict';

  var st = null;

  function party() { return CHLOE.engine.party; }
  function prog() { return CHLOE.engine.progression; }
  function types() { return CHLOE.data.types; }
  function ABIL() { return CHLOE.data.abilities || {}; }
  function CFG() { return CHLOE.data.abilityConfig || {}; }

  /* ---------- known abilities & bound slots ---------- */

  /* Everything this character may bind: punch always, plus whatever the skill
     tree granted (tree nodes with grant.ability). */
  function knownAbilities(charId) {
    var out = [], seen = {}, id;
    for (id in ABIL()) {
      if (ABIL()[id].grantedBy === 'start') { out.push(id); seen[id] = 1; }
    }
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.abilities === 'function') {
      var granted = tr.abilities(charId) || [];
      for (var i = 0; i < granted.length; i++) {
        if (ABIL()[granted[i]] && !seen[granted[i]]) { out.push(granted[i]); seen[granted[i]] = 1; }
      }
    }
    return out;
  }

  /* How many number keys this character may use: base + tree slot nodes. */
  function slotCount(charId) {
    var cfg = CFG();
    var n = cfg.baseSlots || 1;
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.abilitySlots === 'function') n += tr.abilitySlots(charId) || 0;
    return Math.max(1, Math.min(cfg.maxSlots || 9, n));
  }

  /* Bound slots live in party.state.binds[charId] = [abilityId|null, ...].
     Invalid or no-longer-known entries are dropped; slot 0 defaults to punch
     so a fresh run always has something on key 1. */
  function binds(charId) {
    var p = party();
    if (!p.state.binds) p.state.binds = {};
    var known = knownAbilities(charId);
    var n = slotCount(charId);
    var cur = p.state.binds[charId];
    if (!Array.isArray(cur)) cur = [];
    var out = [];
    for (var i = 0; i < n; i++) {
      var id = cur[i];
      out.push((id && known.indexOf(id) !== -1) ? id : null);
    }
    if (!out[0] && known.length) out[0] = known[0];
    p.state.binds[charId] = out;
    return out;
  }

  function bind(charId, slot, abilityId) {
    var list = binds(charId);
    if (slot < 0 || slot >= list.length) return { ok: false, reason: 'No such slot.' };
    if (abilityId && knownAbilities(charId).indexOf(abilityId) === -1) {
      return { ok: false, reason: 'Not learned yet.' };
    }
    // an ability lives in one slot at a time
    if (abilityId) {
      for (var i = 0; i < list.length; i++) if (list[i] === abilityId) list[i] = null;
    }
    list[slot] = abilityId || null;
    party().state.binds[charId] = list;
    return { ok: true, binds: list.slice() };
  }

  /* ---------- lifecycle ---------- */
  function start(enemyId) {
    var def = (CHLOE.data.enemies || {})[enemyId];
    if (!def) return null;
    var p = party();
    var m = p.active() || (p.state.members[0]);
    if (!m) return null;
    var eff = p.effStats(m);
    var es = def.stats || {};

    st = {
      enemyId: enemyId,
      enemyDef: def,
      enemy: { life: es.life || 40, max: es.life || 40 },
      charId: m.id,
      max: { hp: eff.life, mana: eff.magic, sta: eff.stamina },
      hp: Math.max(1, m.hp),
      mana: eff.magic,
      sta: eff.stamina,
      cast: null,            // {id, t, dur, hitsDone, recoverUntil}
      lockUntil: 0,          // cast+recover lock
      cd: {},                // abilityId -> {charges, nextAt}
      evadeReadyAt: 0,
      iframeUntil: 0,
      lastSpendAt: 0,
      now: 0,
      over: false,
      result: null,
      rewards: null,
      slots: binds(m.id).slice()
    };
    var known = knownAbilities(m.id);
    for (var i = 0; i < known.length; i++) {
      var a = ABIL()[known[i]];
      st.cd[known[i]] = { charges: a.charges || 1, nextAt: 0 };
    }
    return st;
  }

  function get() { return st; }
  function isOver() { return !st || st.over; }

  /* ---------- resources ---------- */
  function spend(cost) {
    cost = cost || {};
    if ((cost.sta || 0) > st.sta) return false;
    if ((cost.mana || 0) > st.mana) return false;
    st.sta -= (cost.sta || 0);
    st.mana -= (cost.mana || 0);
    st.lastSpendAt = st.now;
    return true;
  }

  function canPay(cost) {
    cost = cost || {};
    return (cost.sta || 0) <= st.sta && (cost.mana || 0) <= st.mana;
  }

  /* Sprint drains stamina continuously; returns false when it runs dry. */
  function spendSprint(dt) {
    if (isOver()) return false;
    var rate = (CFG().sprint && CFG().sprint.staPerSec) || 12;
    var need = rate * dt;
    if (st.sta < need) return false;
    st.sta -= need;
    st.lastSpendAt = st.now;
    return true;
  }

  /* ---------- casting ---------- */
  function slotAbility(i) {
    var id = st.slots[i];
    return id ? ABIL()[id] : null;
  }

  function readiness(id) {
    var c = st.cd[id];
    if (!c) return { ready: false, reason: 'Unknown ability.' };
    var a = ABIL()[id];
    if (c.charges <= 0) {
      return { ready: false, reason: 'Recharging', pct: cooldownPct(id) };
    }
    if (st.now < c.nextAt) return { ready: false, reason: 'Cooling down', pct: cooldownPct(id) };
    if (!canPay(a.cost)) return { ready: false, reason: 'Not enough ' + ((a.cost && a.cost.mana) ? 'magic' : 'stamina') };
    return { ready: true };
  }

  function cooldownPct(id) {
    var c = st.cd[id], a = ABIL()[id];
    if (!c || !a) return 0;
    var span = a.rechargeMs || a.cooldownMs || 1;
    var left = Math.max(0, c.nextAt - st.now);
    return Math.max(0, Math.min(1, left / span));
  }

  /* Number key pressed. Returns {ok} and, on success, starts the cast — the
     3D layer plays the animation and calls hitEnemy() at each hit moment. */
  function press(slotIndex) {
    if (isOver()) return { ok: false, reason: 'The fight is over.' };
    if (st.cast) return { ok: false, reason: 'Already casting.' };
    if (st.now < st.lockUntil) return { ok: false, reason: 'Recovering.' };
    var a = slotAbility(slotIndex);
    if (!a) return { ok: false, reason: 'Nothing bound to that key.' };
    var r = readiness(a.id);
    if (!r.ready) return { ok: false, reason: r.reason };
    if (!spend(a.cost)) return { ok: false, reason: 'Not enough resources.' };

    var c = st.cd[a.id];
    c.charges = Math.max(0, c.charges - 1);
    if (c.charges <= 0) c.nextAt = st.now + (a.rechargeMs || a.cooldownMs || 1000);
    else c.nextAt = st.now + (a.cooldownMs || 600);

    var total = (a.hitAtMs && a.hitAtMs.length)
      ? a.hitAtMs[a.hitAtMs.length - 1] : (a.castMs || 0);
    st.cast = { id: a.id, t: 0, dur: total, hitsDone: 0 };
    st.lockUntil = st.now + total + (a.recoverMs || 0);
    return { ok: true, ability: a };
  }

  /* ---------- evade ---------- */
  function evade() {
    if (isOver()) return { ok: false, reason: 'The fight is over.' };
    var cfg = CFG().evade || {};
    if (st.now < st.evadeReadyAt) return { ok: false, reason: 'Evade cooling down' };
    if (!canPay(cfg.cost)) return { ok: false, reason: 'Not enough stamina' };
    if (st.cast) return { ok: false, reason: 'Mid-swing' };
    spend(cfg.cost);
    st.evadeReadyAt = st.now + (cfg.cooldownMs || 900);
    st.iframeUntil = st.now + (cfg.iframeMs || 200);
    return { ok: true, distance: cfg.distance || 3.4, durationMs: cfg.durationMs || 260 };
  }

  function invulnerable() { return !!st && st.now < st.iframeUntil; }

  /* ---------- damage ---------- */
  /* Called by the 3D layer when a cast's hit window connects with the knight.
     `mult` lets the caller pass a positional bonus (e.g. behind = more). */
  function hitEnemy(abilityId, mult) {
    if (isOver()) return null;
    var a = ABIL()[abilityId];
    if (!a) return null;
    var p = party();
    var m = p.get(st.charId);
    if (!m) return null;
    var eff = p.effStats(m);
    var base = a.usesMag ? eff.mag : eff.atk;
    var chart = types().multiplier(a.type, st.enemyDef);
    var rand = 0.9 + Math.random() * 0.2;
    var def = (st.enemyDef.stats && st.enemyDef.stats.def) || 0;
    var dmg = Math.max(1, Math.round(
      base * ((a.power || 50) / 100) * chart * (mult || 1) * rand - def * 0.5));
    st.enemy.life = Math.max(0, st.enemy.life - dmg);
    var killed = st.enemy.life <= 0;
    if (killed) victory();
    return { dmg: dmg, killed: killed, mult: chart };
  }

  /* The knight's swing landed (or was evaded). */
  function takeHit(pattern) {
    if (isOver()) return null;
    if (invulnerable()) return { dmg: 0, evaded: true, dead: false };
    var p = party();
    var m = p.get(st.charId);
    var eff = p.effStats(m);
    var es = st.enemyDef.stats || {};
    var cdef = (CHLOE.data.characters || {})[st.charId] || {};
    var atkType = st.enemyDef.type || st.enemyDef.element;
    var chart = types().multiplier(atkType, { type: cdef.type || cdef.element, resists: cdef.resists || null });
    var rand = 0.9 + Math.random() * 0.2;
    var dmg = Math.max(1, Math.round(
      (es.atk || 8) * (((pattern && pattern.power) || 100) / 100) * chart * rand - eff.def * 0.5));
    // tree resist nodes are PERCENT cuts, applied after the chart (like §16)
    var tr = CHLOE.engine.tree;
    if (tr && typeof tr.passives === 'function') {
      var pv = tr.passives(st.charId);
      var key = types().migrate ? types().migrate(atkType) : atkType;
      var cut = (pv && pv.resists && pv.resists[key]) || 0;
      if (cut) dmg = Math.max(1, Math.round(dmg * (1 - Math.min(90, cut) / 100)));
    }
    st.hp = Math.max(0, st.hp - dmg);
    if (m) m.hp = st.hp;
    var dead = st.hp <= 0;
    if (dead) defeat();
    return { dmg: dmg, dead: dead, evaded: false };
  }

  /* ---------- tick ---------- */
  function tick(dt) {
    if (!st || st.over) return [];
    var ev = [];
    st.now += dt * 1000;

    // cast progress -> hit windows
    if (st.cast) {
      st.cast.t += dt * 1000;
      var a = ABIL()[st.cast.id];
      var marks = (a && a.hitAtMs) || [a ? a.castMs || 0 : 0];
      while (st.cast.hitsDone < marks.length && st.cast.t >= marks[st.cast.hitsDone]) {
        st.cast.hitsDone++;
        ev.push({ t: 'strike', abilityId: st.cast.id, index: st.cast.hitsDone });
      }
      if (st.cast.hitsDone >= marks.length) {
        ev.push({ t: 'castEnd', abilityId: st.cast.id });
        st.cast = null;
      }
    }

    // charge recovery
    for (var id in st.cd) {
      var c = st.cd[id], ab = ABIL()[id];
      if (!ab) continue;
      var maxCh = ab.charges || 1;
      if (c.charges < maxCh && st.now >= c.nextAt) {
        c.charges++;
        if (c.charges < maxCh) c.nextAt = st.now + (ab.rechargeMs || ab.cooldownMs || 1000);
        ev.push({ t: 'charge', abilityId: id, charges: c.charges });
      }
    }

    // out-of-combat-ish regen: pauses briefly after spending
    var rg = CFG().regen || {};
    if (st.now - st.lastSpendAt > (rg.delayAfterUseMs || 700)) {
      st.sta = Math.min(st.max.sta, st.sta + (rg.staPerSec || 9) * dt);
      st.mana = Math.min(st.max.mana, st.mana + (rg.manaPerSec || 2.5) * dt);
    }
    return ev;
  }

  /* ---------- outcomes ---------- */
  function victory() {
    st.over = true;
    st.result = 'victory';
    var p = party(), state = p.state;
    if (state.runStats) state.runStats.kills = (state.runStats.kills || 0) + 1;
    var def = st.enemyDef, rw = def.rewards || {};
    var xp = prog().enemyXp(def), shards = rw.shards || 0;
    var rewards = { xp: xp, shards: shards, drops: [], levelUps: [], learned: [] };
    p.addShards(shards);
    var members = state.members;
    for (var i = 0; i < members.length; i++) {
      var res = prog().grantXp(members[i], xp);
      for (var j = 0; j < res.levelsGained.length; j++) {
        rewards.levelUps.push({ memberId: members[i].id, level: res.levelsGained[j] });
      }
    }
    var drops = rw.drops || [];
    for (var d = 0; d < drops.length; d++) {
      if (Math.random() < (drops[d].chance || 0)) {
        var item = (CHLOE.data.items || {})[drops[d].itemId];
        if (item) { CHLOE.engine.inventory.add(item.id, 1); rewards.drops.push(item.name); }
      }
    }
    st.rewards = rewards;
  }

  function defeat() {
    st.over = true;
    st.result = 'defeat';
  }

  function flee() {
    if (isOver()) return { fled: false };
    if (st.enemyDef.boss) return { fled: false, boss: true };
    st.over = true; st.result = 'fled';
    return { fled: true };
  }

  /* ---------- HUD snapshot ---------- */
  function snapshot() {
    if (!st) return null;
    var slots = [];
    for (var i = 0; i < st.slots.length; i++) {
      var id = st.slots[i];
      var a = id ? ABIL()[id] : null;
      slots.push(a ? {
        key: i + 1, id: id, name: a.name, icon: a.icon, type: a.type,
        cost: a.cost || {},
        charges: st.cd[id] ? st.cd[id].charges : 0,
        maxCharges: a.charges || 1,
        cdPct: cooldownPct(id),
        ready: readiness(id).ready
      } : { key: i + 1, id: null });
    }
    var cfg = CFG().evade || {};
    return {
      hp: st.hp, mana: st.mana, sta: st.sta, max: st.max,
      enemy: { life: st.enemy.life, max: st.enemy.max,
               name: (CHLOE.data.arena3d && CHLOE.data.arena3d.knight && CHLOE.data.arena3d.knight.name) || st.enemyDef.name },
      slots: slots,
      casting: st.cast ? { id: st.cast.id, pct: Math.min(1, st.cast.t / Math.max(1, st.cast.dur)) } : null,
      evade: {
        ready: st.now >= st.evadeReadyAt && canPay(cfg.cost),
        pct: Math.max(0, Math.min(1, (st.evadeReadyAt - st.now) / (cfg.cooldownMs || 900))),
        cost: (cfg.cost && cfg.cost.sta) || 0
      },
      iframe: invulnerable(),
      over: st.over, result: st.result
    };
  }

  return {
    start: start, get: get, isOver: isOver, tick: tick,
    press: press, evade: evade, spendSprint: spendSprint,
    hitEnemy: hitEnemy, takeHit: takeHit, invulnerable: invulnerable,
    flee: flee, snapshot: snapshot,
    knownAbilities: knownAbilities, slotCount: slotCount, binds: binds, bind: bind,
    readiness: function (id) { return st ? readiness(id) : { ready: false }; }
  };
})();
