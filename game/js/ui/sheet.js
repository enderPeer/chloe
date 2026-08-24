/* CHLOE — ui/sheet.js  (Progression v3, spec §12 — character sheet)
   Rendered inside the menu overlay (Party -> member). Shows the 4 resource
   bars (life/stamina/magic/faith), the 8 core stats from effectiveStats, a
   compact 11-type resistance grid (non-1.0 highlighted), equipped moves per
   phase, skill points and weapon.
   Renders ONLY — stats come from CHLOE.engine.tree.effectiveStats(member)
   when present (base+growth+weapon+tree) and degrade to party.effStats. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.sheet = (function(){
  'use strict';
  var ui;

  var TYPES = ['physical','magical','lightning','fire','occult','blood','poison','divine','virus','ghost','biological'];
  var TYPE_LABEL = {
    physical:'Physical', magical:'Magical', lightning:'Lightning', fire:'Fire',
    occult:'Occult', blood:'Blood', poison:'Poison', divine:'Divine',
    virus:'Virus', ghost:'Ghost', biological:'Biological'
  };
  var TYPE_SHORT = {
    physical:'PHY', magical:'MAG', lightning:'LTN', fire:'FIR', occult:'OCC',
    blood:'BLD', poison:'PSN', divine:'DIV', virus:'VIR', ghost:'GHO', biological:'BIO'
  };
  var OLD2NEW = { none:'physical', ember:'fire', volt:'lightning', shadow:'occult', light:'divine', frost:'magical' };
  var PHASE_ORDER = ['neutral','aggressive','guarded','staggered','charged'];
  var PHASE_LABEL = { neutral:'Neutral', aggressive:'Aggressive', guarded:'Guarded', staggered:'Staggered', charged:'Charged' };

  function party(){ return CHLOE.engine.party; }
  function charDef(id){ return (CHLOE.data.characters || {})[id] || {}; }

  function pickNum(){
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'number' && isFinite(arguments[i])) return arguments[i];
    }
    return null;
  }

  /* effectiveStats: tree engine first (base+growth+weapon+tree), else party. */
  function effAll(m){
    var t = (CHLOE.engine || {}).tree;
    if (t && typeof t.effectiveStats === 'function') {
      try { var r = t.effectiveStats(m); if (r && typeof r === 'object') return r; } catch (e) {}
    }
    try { return party().effStats(m) || {}; } catch (e2) { return {}; }
  }

  function typeOf(m){
    var def = charDef(m.id);
    if (def.type && TYPE_LABEL[def.type]) return def.type;
    return OLD2NEW[def.element || 'none'] || 'physical';
  }

  /* Skill points for a character — engine.tree first, then party-state shapes. */
  function pointsOf(charId){
    var eng = (CHLOE.engine || {}).tree;
    var names = ['points', 'getPoints', 'pointsOf', 'skillPoints'];
    if (eng) {
      for (var i = 0; i < names.length; i++) {
        if (typeof eng[names[i]] === 'function') {
          try {
            var r = eng[names[i]](charId);
            if (typeof r === 'number' && isFinite(r)) return r;
          } catch (e) {}
        }
      }
    }
    var st = (party() && party().state) || {};
    if (st.skillPoints && typeof st.skillPoints[charId] === 'number') return st.skillPoints[charId];
    var m = party().get ? party().get(charId) : null;
    if (m && typeof m.skillPoints === 'number') return m.skillPoints;
    return 0;
  }

  /* Defender shape for types.multiplier(atkType, defender). */
  function defenderLike(m, eff){
    var def = charDef(m.id);
    var resists = (eff && eff.resists && typeof eff.resists === 'object') ? eff.resists
      : (def.resists && typeof def.resists === 'object') ? def.resists : {};
    return { type: typeOf(m), resists: resists };
  }

  function fmtMult(v){
    if (v === 0) return 'x0';
    if (v === 0.5) return 'x½';
    if (Math.round(v) === v) return 'x' + v;
    return 'x' + v;
  }

  function resourceRow(label, cls, cur, max){
    var row = ui.el('div', 'sheet-bar-row');
    row.appendChild(ui.el('span', 'sheet-bar-lbl', label));
    // 'mp' token opts out of the router's automatic hp-ok/hp-warn coloring;
    // the res-* class paints the real color (appended CSS wins by order).
    var bar = ui.makeBar('mp ' + cls);
    ui.setBar(bar, cur, max);
    row.appendChild(bar);
    row.appendChild(ui.el('span', 'sheet-bar-val', cur + ' / ' + max));
    return row;
  }

  /* ---------- main render ---------- */
  function renderInto(node, charId, opts){
    ui = CHLOE.ui;
    opts = opts || {};
    var m = party().get ? party().get(charId) : null;
    if (!m) {
      node.appendChild(ui.el('div', 'menu-note', 'No one answers to that name.'));
      return;
    }
    var def = charDef(m.id);
    var eff = effAll(m);
    var w = party().weaponOf ? party().weaponOf(m) : null;
    var wrap = ui.el('div', 'sheet-wrap');

    /* head: portrait, name, level, type, weapon */
    var head = ui.el('div', 'sheet-head');
    var port = ui.el('div', 'sheet-portrait');
    port.appendChild(ui.portraitNode(def.portraitKey || m.id, def.name || m.id));
    head.appendChild(port);
    var hInfo = ui.el('div', 'sheet-head-info');
    var nameRow = ui.el('div', 'sheet-name');
    nameRow.appendChild(ui.el('span', 'nm', def.name || m.id));
    nameRow.appendChild(ui.el('span', 'lv', 'Lv ' + m.level));
    hInfo.appendChild(nameRow);
    var t = typeOf(m);
    var tagRow = ui.el('div', 'sheet-tags');
    var tTag = ui.el('span', 'sheet-tag t-tag');
    var tDot = ui.el('span', 't-dot t-' + t);
    tTag.appendChild(tDot);
    tTag.appendChild(ui.el('span', null, TYPE_LABEL[t] || t));
    tagRow.appendChild(tTag);
    tagRow.appendChild(ui.el('span', 'sheet-tag', '🎸 ' + (w ? w.name : 'Bare hands')));
    hInfo.appendChild(tagRow);
    head.appendChild(hInfo);
    wrap.appendChild(head);

    /* 4 resource bars */
    var life = { cur: pickNum(m.life, m.hp, 0), max: pickNum(eff.maxLife, eff.life, eff.maxHp, eff.hp, 1) };
    var sta  = { cur: pickNum(m.stamina, m.sta), max: pickNum(eff.maxStamina, eff.stamina, null) };
    var mag  = { cur: pickNum(m.magic, m.mp, 0), max: pickNum(eff.maxMagic, eff.magic, eff.maxMp, eff.mp, 1) };
    var fai  = { cur: pickNum(m.faith, null), max: pickNum(eff.maxFaith, eff.faith, null) };
    var bars = ui.el('div', 'sheet-bars');
    bars.appendChild(resourceRow('LIFE', 'res-life', life.cur, life.max));
    if (sta.max !== null || sta.cur !== null) {
      bars.appendChild(resourceRow('STA', 'res-sta',
        sta.cur !== null ? sta.cur : (sta.max || 0), sta.max !== null ? sta.max : (sta.cur || 1)));
    }
    bars.appendChild(resourceRow('MAG', 'res-mag', mag.cur, mag.max));
    if (fai.max !== null || fai.cur !== null) {
      var fMax = fai.max !== null ? fai.max : Math.max(fai.cur || 0, 3);
      bars.appendChild(resourceRow('FTH', 'res-faith', fai.cur !== null ? fai.cur : fMax, fMax));
    }
    wrap.appendChild(bars);

    /* 8 core stats from effectiveStats */
    wrap.appendChild(ui.el('div', 'sheet-sec-title', 'Stats'));
    var grid = ui.el('div', 'sheet-stats');
    var addStat = function(lbl, val){
      if (val === null || val === undefined) return;
      var c = ui.el('div', 'stat-cell');
      c.appendChild(ui.el('span', 'sl', lbl));
      c.appendChild(ui.el('b', 'sv', String(val)));
      grid.appendChild(c);
    };
    // effStats/effectiveStats fold weaponAtk into atk — show the breakdown
    var wAtk = pickNum(eff.weaponAtk, 0);
    var atkTotal = pickNum(eff.atk, 1);
    addStat('ATK', wAtk ? (atkTotal - wAtk) + '+' + wAtk : atkTotal);
    addStat('DEF', pickNum(eff.def, 0));
    addStat('SPD', pickNum(eff.spd, 1));
    addStat('MAG', pickNum(eff.mag, 1));
    addStat('LIFE', life.max);
    if (sta.max !== null) addStat('STA', sta.max);
    addStat('MANA', mag.max);
    if (fai.max !== null) addStat('FTH', fai.max);
    wrap.appendChild(grid);

    /* 11-type resistance grid (only when the v3 type chart is loaded) */
    var types = CHLOE.data.types;
    if (types && typeof types.multiplier === 'function') {
      wrap.appendChild(ui.el('div', 'sheet-sec-title', 'Takes from each type'));
      var rs = ui.el('div', 'rs-grid');
      var defender = defenderLike(m, eff);
      // tree passives grant percent damage reduction on top of the type chart
      var passiveRes = {};
      var engT = (CHLOE.engine || {}).tree;
      if (engT && typeof engT.passives === 'function') {
        try {
          var pv = engT.passives(m.id);
          if (pv && pv.resists && typeof pv.resists === 'object') passiveRes = pv.resists;
        } catch (e0) {}
      }
      for (var i = 0; i < TYPES.length; i++) {
        var tp = TYPES[i];
        var mult = 1;
        try {
          var mm = types.multiplier(tp, defender);
          if (typeof mm === 'number' && isFinite(mm)) mult = mm;
        } catch (e) {}
        var pct = passiveRes[tp];
        if (typeof pct === 'number' && pct) {
          mult = Math.round(mult * (1 - pct / 100) * 100) / 100;
        }
        var cls = 'rs-cell' + (mult === 0 ? ' immune' : (mult > 1 ? ' weak' : (mult < 1 ? ' res' : '')));
        var cell = ui.el('div', cls);
        cell.appendChild(ui.el('span', 't-dot t-' + tp));
        cell.appendChild(ui.el('span', 'rs-nm', TYPE_SHORT[tp]));
        cell.appendChild(ui.el('span', 'rs-x', fmtMult(mult)));
        cell.title = TYPE_LABEL[tp] + ' damage: ' + fmtMult(mult);
        rs.appendChild(cell);
      }
      wrap.appendChild(rs);
    }

    /* equipped moves per phase */
    var lo = (CHLOE.ui.loadout && CHLOE.ui.loadout.getLoadouts) ? CHLOE.ui.loadout.getLoadouts(m.id) : null;
    if (lo) {
      var learned = (CHLOE.ui.loadout.learnedIds ? CHLOE.ui.loadout.learnedIds(m.id, m.level) : []);
      wrap.appendChild(ui.el('div', 'sheet-sec-title', 'Moves — ' + learned.length + ' learned'));
      var pRow = ui.el('div', 'phase-chips');
      PHASE_ORDER.forEach(function(ph){
        var n = (lo[ph] || []).length;
        var chip = ui.el('span', 'pchip p-' + ph, PHASE_LABEL[ph] + ' ' + n + '/5');
        chip.title = n + ' of 5 moves equipped for the ' + PHASE_LABEL[ph] + ' phase.';
        pRow.appendChild(chip);
      });
      wrap.appendChild(pRow);
    }

    /* skill points + tree link */
    var pts = pointsOf(m.id);
    var spRow = ui.el('div', 'sheet-points');
    var pill = ui.el('span', 'points-pill', pts + ' skill point' + (pts === 1 ? '' : 's'));
    spRow.appendChild(pill);
    var treeBtn = ui.el('button', null, 'Skill Tree');
    treeBtn.addEventListener('click', function(){
      if (typeof opts.onOpenTree === 'function') { opts.onOpenTree(m.id); return; }
      if (CHLOE.ui.tree && CHLOE.ui.tree.open) {
        if (CHLOE.ui.menu && CHLOE.ui.menu.close) CHLOE.ui.menu.close();
        CHLOE.ui.tree.open(m.id);
      } else {
        ui.toast('The tree is still growing in the dark.');
      }
    });
    spRow.appendChild(treeBtn);
    wrap.appendChild(spRow);

    /* xp */
    var prog = CHLOE.engine.progression;
    if (prog && prog.xpToNext) {
      var next = prog.xpToNext(m.level);
      var xpBar = ui.makeBar('mp res-mag');
      ui.setBar(xpBar, m.xp, next);
      wrap.appendChild(xpBar);
      var xt = ui.el('div', 'bar-txt');
      xt.appendChild(ui.el('span', null, 'XP ' + m.xp + ' / ' + next));
      xt.appendChild(ui.el('span', null, 'Lv ' + m.level));
      wrap.appendChild(xt);
    }

    node.appendChild(wrap);
  }

  return { renderInto: renderInto, pointsOf: pointsOf };
})();
