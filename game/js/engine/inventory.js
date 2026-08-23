/* CHLOE — engine/inventory.js
   Item bag {itemId: count}. Items usable in & out of battle.
   v3 item effects: hp / mp / sta (restore pools), revivePct, and
   cure:[statusIds] — cures active battle statuses & their buildup on the
   ACTIVE member (statuses only exist inside battles; outside one, or on a
   benched target, a pure-cure item is refused as "wasted"). */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.inventory = (function(){
  'use strict';

  var bag = {}; // itemId -> count

  function itemDef(id){ return (CHLOE.data.items || {})[id] || null; }

  function reset(){ bag = {}; }
  function load(obj){
    bag = {};
    obj = obj || {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] > 0) bag[k] = Math.floor(obj[k]);
    }
  }
  function serialize(){
    var out = {};
    for (var k in bag) if (Object.prototype.hasOwnProperty.call(bag, k) && bag[k] > 0) out[k] = bag[k];
    return out;
  }

  function count(id){ return bag[id] || 0; }
  function add(id, n){
    if (!itemDef(id)) { console.warn('[CHLOE] unknown item id: ' + id); return false; }
    bag[id] = (bag[id] || 0) + (n === undefined ? 1 : n);
    if (bag[id] <= 0) delete bag[id];
    return true;
  }
  function remove(id, n){
    if (!bag[id]) return false;
    bag[id] -= (n === undefined ? 1 : n);
    if (bag[id] <= 0) delete bag[id];
    return true;
  }
  function list(){
    var out = [];
    for (var k in bag) {
      if (Object.prototype.hasOwnProperty.call(bag, k) && bag[k] > 0) {
        var def = itemDef(k);
        if (def) out.push({ def: def, count: bag[k] });
      }
    }
    out.sort(function(a, b){ return (a.def.price || 0) - (b.def.price || 0); });
    return out;
  }

  /* Use an item on a party member. Returns {ok, text, hp?, mp?, revived?}. */
  function use(id, member){
    var def = itemDef(id);
    if (!def) return { ok: false, text: 'Nothing happens.' };
    if (!count(id)) return { ok: false, text: 'None left.' };
    if (!member) return { ok: false, text: 'No target.' };

    var party = CHLOE.engine.party;
    var max = party.maxStats(member);
    var eff = def.effect || {};
    var name = (CHLOE.data.characters[member.id] || {}).name || member.id;

    if (eff.revivePct) {
      if (member.hp > 0) return { ok: false, text: name + " is still standing." };
      member.hp = Math.max(1, Math.round(max.hp * eff.revivePct / 100));
      remove(id, 1);
      return { ok: true, revived: true, hp: member.hp, text: name + ' is back on their feet! (' + member.hp + ' HP)' };
    }
    if (member.hp <= 0) return { ok: false, text: name + ' is down — that won\'t help.' };

    var healedHp = 0, healedMp = 0, healedSta = 0, cured = [];
    if (eff.hp) {
      var beforeHp = member.hp;
      member.hp = Math.min(max.hp, member.hp + eff.hp);
      healedHp = member.hp - beforeHp;
    }
    if (eff.mp) {
      var beforeMp = member.mp;
      member.mp = Math.min(max.mp, member.mp + eff.mp);
      healedMp = member.mp - beforeMp;
    }
    if (eff.sta) {
      var beforeSta = member.stamina || 0;
      member.stamina = Math.min(max.sta || 0, beforeSta + eff.sta);
      healedSta = member.stamina - beforeSta;
    }
    // cure:[statusIds] — only meaningful mid-battle on the active member
    // (battle.js owns status state; guarded so out-of-battle use never throws)
    if (eff.cure && eff.cure.length) {
      try {
        var battle = CHLOE.engine.battle;
        if (battle && !battle.isOver() && party.state.activeId === member.id &&
            typeof battle.cureStatuses === 'function') {
          cured = battle.cureStatuses(eff.cure) || [];
        }
      } catch(e){}
    }
    if (!healedHp && !healedMp && !healedSta && !cured.length) {
      return { ok: false, text: 'It would be wasted right now.' };
    }
    remove(id, 1);
    var bits = [];
    if (healedHp) bits.push('+' + healedHp + ' HP');
    if (healedMp) bits.push('+' + healedMp + ' MP');
    if (healedSta) bits.push('+' + healedSta + ' STA');
    for (var c = 0; c < cured.length; c++) bits.push(cured[c] + ' cured');
    return { ok: true, hp: healedHp, mp: healedMp, sta: healedSta, cured: cured,
             text: name + ': ' + bits.join(', ') + '.' };
  }

  return {
    reset: reset,
    load: load,
    serialize: serialize,
    count: count,
    add: add,
    remove: remove,
    list: list,
    use: use
  };
})();
