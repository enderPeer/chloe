/* CHLOE — engine/tree.js  (Progression v3, spec §12: skill trees)
   Owns skill-tree rules & the ONE stat aggregator the whole game consumes:
     owned(charId)            -> [nodeIds] (copy)
     points(charId)           -> unspent skill points
     spent(charId)            -> points sunk into owned nodes
     canBuy(charId, nodeId)   -> {ok:bool, reason:string}
     buy(charId, nodeId)      -> {ok, node?, error?}  (spends points, persists
                                 party.state.tree, toast; stat grants
                                 bump current pools; move grants auto-equip)
     respecCost(charId)       -> shards (10 * level)
     respec(charId)           -> {ok, refunded?, cost?, error?} (refund ALL)
     treeMoves(charId)        -> [moveIds] granted by owned move nodes
     passives(charId)         -> aggregated passive grants:
                                 { resists:{type:pct}, statusResist:{status:pct},
                                   staminaRegenPct:0, onKillLifePct:0, blockPower:1, ... }
                                 (numbers sum; blockPower values multiply)
     effectiveStats(member)   -> ALL 8 stats: base + growth*(level-1) + weapon atk
                                 + tree stat grants. Shape:
                                 { life, stamina, magic, faith, atk, def, spd, mag,
                                   weaponAtk, maxHp(=life), maxMp(=magic) }
                                 NOTE: atk INCLUDES weaponAtk (battle.js no longer
                                 re-adds it); weaponAtk kept for display breakdowns.
   Tree DATA lives in game/js/data/tree.js as CHLOE.data.trees (data agent).
   Node: { id, branch, name, desc, cost, requires:[any-of; []=root], pos,
           kind:'stat'|'move'|'passive'|'keystone', grant }
   Everything here is defensive: with no tree data loaded the module is a
   well-behaved no-op and effectiveStats degrades to base+growth+weapon. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.tree = (function(){
  'use strict';

  var STAT_KEYS = ['life', 'stamina', 'magic', 'faith', 'atk', 'def', 'spd', 'mag'];

  function prog(){ return CHLOE.engine.progression; }
  function party(){ return CHLOE.engine.party; }
  function charDef(id){ return (CHLOE.data.characters || {})[id]; }

  function notify(text){
    try {
      if (CHLOE.ui && typeof CHLOE.ui.toast === 'function') CHLOE.ui.toast(text);
    } catch(e){}
  }

  /* ---------- tree data access (shape-tolerant: array, map, or {nodes}) ---------- */
  function nodesOf(charId){
    var t = (CHLOE.data && CHLOE.data.trees || {})[charId];
    if (!t) return null;
    var src = Array.isArray(t) ? t : (Array.isArray(t.nodes) ? t.nodes :
              (t.nodes && typeof t.nodes === 'object' ? t.nodes : t));
    var map = {};
    if (Array.isArray(src)) {
      for (var i = 0; i < src.length; i++) {
        if (src[i] && src[i].id) map[src[i].id] = src[i];
      }
    } else {
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) {
          var n = src[k];
          if (n && typeof n === 'object' && (n.kind || n.grant || n.cost !== undefined)) {
            if (!n.id) n.id = k;
            map[n.id] = n;
          }
        }
      }
    }
    return map;
  }
  function node(charId, nodeId){
    var map = nodesOf(charId);
    return (map && map[nodeId]) || null;
  }

  /* ---------- owned / points (runtime home: party.state, run-scoped) ---------- */
  function ownedList(charId){
    var st = party() && party().state;
    var arr = st && st.tree && st.tree[charId];
    return Array.isArray(arr) ? arr : [];
  }
  function owned(charId){ return ownedList(charId).slice(); }
  function isOwned(charId, nodeId){ return ownedList(charId).indexOf(nodeId) !== -1; }

  function points(charId){
    var st = party() && party().state;
    var n = st && st.skillPoints && st.skillPoints[charId];
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : 0;
  }
  function spent(charId){
    var list = ownedList(charId), sum = 0;
    for (var i = 0; i < list.length; i++) {
      var n = node(charId, list[i]);
      sum += n ? (n.cost || 1) : 0;
    }
    return sum;
  }

  /* ---------- canBuy / buy ---------- */
  function requiresMet(charId, def){
    var req = def.requires;
    if (!req || !req.length) return true; // [] = root
    for (var i = 0; i < req.length; i++) {
      if (isOwned(charId, req[i])) return true; // any-of
    }
    return false;
  }

  function canBuy(charId, nodeId){
    var def = node(charId, nodeId);
    if (!def) return { ok: false, reason: 'Unknown node.' };
    var m = party() && party().get(charId);
    if (!m) return { ok: false, reason: 'Not in the party.' };
    if (isOwned(charId, nodeId)) return { ok: false, reason: 'Already owned.' };
    if (!requiresMet(charId, def)) return { ok: false, reason: 'Requires a connected node.' };
    if (points(charId) < (def.cost || 1)) return { ok: false, reason: 'Not enough skill points.' };
    return { ok: true, reason: '' };
  }

  function buy(charId, nodeId){
    var chk = canBuy(charId, nodeId);
    if (!chk.ok) return { ok: false, error: chk.reason };
    var def = node(charId, nodeId);
    var st = party().state;
    st.skillPoints[charId] = points(charId) - (def.cost || 1);
    if (!Array.isArray(st.tree[charId])) st.tree[charId] = [];
    st.tree[charId].push(nodeId);

    var g = def.grant || {};
    // stat grants raise maximums — bump the matching CURRENT pools too, so
    // buying +life mid-run doesn't leave you "wounded" by the new max.
    if (g.stat) {
      var m = party().get(charId);
      if (m) {
        if (g.stat.life)    m.hp    = Math.max(0, m.hp) + Math.round(g.stat.life);
        if (g.stat.magic)   m.mp    = Math.max(0, m.mp) + Math.round(g.stat.magic);
        if (g.stat.stamina) m.stamina = Math.max(0, m.stamina || 0) + Math.round(g.stat.stamina);
        if (g.stat.faith)   m.faith = Math.max(0, m.faith || 0) + Math.round(g.stat.faith);
      }
    }
    // move grants join the learned pool (progression.movesAt unions tree moves);
    // auto-equip into matching phases with a free slot, like level-up learns.
    if (g.move) {
      var mv = prog().getMove(g.move);
      if (!st.loadouts[charId]) party().getLoadout(charId); // ensure the store exists
      var eq = prog().autoEquip(st.loadouts, charId, g.move);
      if (mv) {
        notify((charDef(charId) ? charDef(charId).name : charId) + ' learned ' + mv.name + '!' +
               (eq.unequipped ? ' (loadout full — not equipped)' : ''));
      }
    }
    notify((def.name || nodeId) + ' unlocked!');
    return { ok: true, node: def };
  }

  /* ---------- respec ---------- */
  function respecCost(charId){
    var m = party() && party().get(charId);
    return 10 * (m ? m.level : 1);
  }

  function respec(charId){
    var m = party() && party().get(charId);
    if (!m) return { ok: false, error: 'Not in the party.' };
    var refund = spent(charId);
    if (!refund && !ownedList(charId).length) return { ok: false, error: 'Nothing to refund.' };
    var cost = respecCost(charId);
    if (party().state.shards < cost) return { ok: false, error: 'Not enough shards (' + cost + ' ◆).' };

    party().addShards(-cost);
    var st = party().state;
    st.tree[charId] = [];
    st.skillPoints[charId] = points(charId) + refund;

    // maxima shrank: clamp current pools, rebuild loadouts (tree moves are gone)
    var eff = effectiveStats(m);
    if (m.hp > eff.life) m.hp = eff.life;
    if (m.mp > eff.magic) m.mp = eff.magic;
    if ((m.stamina || 0) > eff.stamina) m.stamina = eff.stamina;
    if ((m.faith || 0) > eff.faith) m.faith = eff.faith;
    st.loadouts[charId] = prog().sanitizeLoadouts(charId, m.level, st.loadouts[charId]);

    notify('Respec: ' + refund + ' point' + (refund === 1 ? '' : 's') + ' refunded (-' + cost + ' ◆).');
    return { ok: true, refunded: refund, cost: cost };
  }

  /* ---------- aggregation ---------- */
  function treeMoves(charId){
    var list = ownedList(charId), out = [];
    for (var i = 0; i < list.length; i++) {
      var n = node(charId, list[i]);
      if (n && n.grant && n.grant.move && out.indexOf(n.grant.move) === -1) out.push(n.grant.move);
    }
    return out;
  }

  /* §17 Combat v3: nodes may grant a real-time ability (grant.ability) and
     extra number-key slots (grant.abilitySlot). */
  function abilities(charId){
    var list = ownedList(charId), out = [];
    for (var i = 0; i < list.length; i++) {
      var n = node(charId, list[i]);
      if (n && n.grant && n.grant.ability && out.indexOf(n.grant.ability) === -1) {
        out.push(n.grant.ability);
      }
    }
    return out;
  }

  function abilitySlots(charId){
    var list = ownedList(charId), n = 0;
    for (var i = 0; i < list.length; i++) {
      var d = node(charId, list[i]);
      if (d && d.grant && d.grant.abilitySlot) n += d.grant.abilitySlot;
    }
    return n;
  }

  function statGrants(charId){
    var out = {}, i, k;
    for (i = 0; i < STAT_KEYS.length; i++) out[STAT_KEYS[i]] = 0;
    var list = ownedList(charId);
    for (i = 0; i < list.length; i++) {
      var n = node(charId, list[i]);
      var s = n && n.grant && n.grant.stat;
      if (!s) continue;
      for (k in s) {
        if (Object.prototype.hasOwnProperty.call(s, k) && typeof s[k] === 'number') {
          out[k] = (out[k] || 0) + s[k];
        }
      }
    }
    return out;
  }

  /* Aggregated passive/keystone grants. Numbers SUM, blockPower percent grants
     compound multiplicatively (each grant of n => x(1+n/100) on the 80% block
     reduction), resists/statusResist merge by summed pct. */
  function passives(charId){
    var out = { resists: {}, statusResist: {}, staminaRegenPct: 0, onKillLifePct: 0, blockPower: 1 };
    var list = ownedList(charId);
    for (var i = 0; i < list.length; i++) {
      var n = node(charId, list[i]);
      var p = n && n.grant && n.grant.passive;
      if (!p) continue;
      for (var k in p) {
        if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
        var v = p[k];
        if (k === 'resist' || k === 'resists') {
          for (var t in v) if (Object.prototype.hasOwnProperty.call(v, t)) {
            out.resists[t] = (out.resists[t] || 0) + v[t];
          }
        } else if (k === 'statusResist') {
          for (var s in v) if (Object.prototype.hasOwnProperty.call(v, s)) {
            out.statusResist[s] = (out.statusResist[s] || 0) + v[s];
          }
        } else if (k === 'blockPower') {
          // grants are PERCENTAGES (blockPower:15 => x1.15 on the 80% block
          // reduction); battle.js multiplies 0.8 by the aggregated factor
          out.blockPower *= (typeof v === 'number' && v > 0) ? 1 + v / 100 : 1;
        } else if (typeof v === 'number') {
          out[k] = (out[k] || 0) + v;
        } else {
          out[k] = v; // non-numeric flags pass through (last one wins)
        }
      }
    }
    return out;
  }

  /* ---------- THE stat aggregator ---------- */
  function effectiveStats(member){
    var def = charDef(member.id);
    var s = prog().statsAt(def || {}, member.level); // 8 pools, base+growth
    var g = statGrants(member.id);
    var w = (CHLOE.data.weapons || {})[member.weaponId];
    var weaponAtk = w ? (w.atkBonus || 0) : 0;
    // §19: the shared 1-100 ladder also grants stats, at the member's own level
    var lad = {};
    var sk = CHLOE.engine.skilltree;
    if (sk && typeof sk.stats === 'function') lad = sk.stats(member.id) || {};
    var out = {};
    for (var i = 0; i < STAT_KEYS.length; i++) {
      var k = STAT_KEYS[i];
      out[k] = Math.max(0, Math.round((s[k] || 0) + (g[k] || 0) + (lad[k] || 0)));
    }
    out.atk += weaponAtk;          // weapon folded in (battle.js does NOT re-add)
    out.weaponAtk = weaponAtk;     // kept for display breakdowns
    out.maxHp = out.life;          // legacy aliases (battleui/menu bars)
    out.maxMp = out.magic;
    return out;
  }

  return {
    owned: owned,
    isOwned: isOwned,
    points: points,
    spent: spent,
    canBuy: canBuy,
    buy: buy,
    respecCost: respecCost,
    respec: respec,
    treeMoves: treeMoves,
    abilities: abilities,
    abilitySlots: abilitySlots,
    statGrants: statGrants,
    passives: passives,
    effectiveStats: effectiveStats,
    node: node,
    nodesOf: nodesOf
  };
})();
