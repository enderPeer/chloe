/* CHLOE — ui/battleui.js  (Combat v2 — phases & moves)
   Battle screen: enemy image top/right, party portrait + HP/MP bars,
   PHASE BADGES beside each HP bar, up-to-5 move buttons for the current
   phase (cat icon + element dot + MP cost) + failsafes + Items/Switch/
   Give Up/Moves, scrolling log, damage pops, floating SUPER/BLOCKED/
   STAGGERED! labels, screen shake.
   Renders ONLY — all rules live in CHLOE.engine.battle (spec sec 10):
     start(enemyId,opts) -> state {enemy, playerPhase, enemyPhase, over, ...}
     menu() -> <=5 equipped+usable moves (+failsafes) with disabled flags
     act(moveId) / item(itemId) / switchTo(charId) / flee()
       -> ordered event array [{t, side:'p'|'e', ...}] played sequentially. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.battle = (function(){
  'use strict';
  var ui, party, engine;
  var els = {};        // live node refs
  var playing = false; // event playback lock
  var STEP_MS = 520;
  var curState = null;
  var curEnemyDef = null;

  var PHASES = {
    neutral:    { label: 'Neutral',    tip: 'Balanced. Deals and takes normal damage.' },
    aggressive: { label: 'Aggressive', tip: 'Deals x1.25 damage, but takes x1.15.' },
    guarded:    { label: 'Guarded',    tip: 'Takes only x0.60 damage.' },
    staggered:  { label: 'Staggered',  tip: 'Deals x0.75, takes x1.25 — recovers next turn.' },
    charged:    { label: 'Charged',    tip: 'Next attack hits for x1.5.' }
  };
  var CAT_ICON = { attack: '⚔', defense: '🛡', stance: '👣', status: '✨' };
  var CAT_LABEL = { attack: 'Attack', defense: 'Defense', stance: 'Stance', status: 'Status' };
  // Failsafe display data if moves.js lacks the ids (engine still resolves them).
  var FAILSAFE = {
    struggle: { name: 'Struggle', cat: 'attack', element: 'none', mpCost: 0,
                desc: 'A desperate free hit. Always available.' },
    recover:  { name: 'Recover', cat: 'stance', element: 'none', mpCost: 0,
                desc: 'Steady yourself back to Neutral. Restores a little HP.' }
  };

  /* ---- Progression v3 display data (11 damage types, costs, statuses) ---- */
  var OLD2NEW = { none:'physical', ember:'fire', volt:'lightning', shadow:'occult', light:'divine', frost:'magical' };
  var TYPE_LABEL = {
    physical:'Physical', magical:'Magical', lightning:'Lightning', fire:'Fire',
    occult:'Occult', blood:'Blood', poison:'Poison', divine:'Divine',
    virus:'Virus', ghost:'Ghost', biological:'Biological'
  };
  var STATUS_ORDER = ['burn','shock','bleed','poisoned','curse','infection','haunt'];
  var STATUS_META = {
    burn:      { icon:'🔥', label:'Burn',      color:'#ff5a2c' },
    shock:     { icon:'⚡', label:'Shock',     color:'#f2d024' },
    bleed:     { icon:'🩸', label:'Bleed',     color:'#c1121f' },
    poisoned:  { icon:'☠',  label:'Poisoned',  color:'#3fae4a' },
    curse:     { icon:'🌑', label:'Curse',     color:'#a44ce0' },
    infection: { icon:'🦠', label:'Infection', color:'#2ec4a6' },
    haunt:     { icon:'👻', label:'Haunt',     color:'#9ad7e8' }
  };

  function typeOfMove(entry, def){
    var t = (entry && entry.type) || (def && def.type) || null;
    if (t && TYPE_LABEL[t]) return t;
    var el = (entry && entry.element) || (def && def.element) || 'none';
    return OLD2NEW[el] || 'physical';
  }
  function typeDot(t){
    var d = ui.el('span', 't-dot t-' + t);
    d.title = TYPE_LABEL[t] || t;
    return d;
  }
  function normCosts(cost, legacyMp){
    var c = { sta: 0, mp: 0, faith: 0 };
    if (cost && typeof cost === 'object') {
      c.sta   = cost.sta   || cost.stamina || 0;
      c.mp    = cost.mp    || cost.magic   || 0;
      c.faith = cost.faith || 0;
    } else if (typeof cost === 'number') {
      c.mp = cost;
    }
    if (!c.mp && !c.sta && !c.faith && legacyMp) c.mp = legacyMp;
    return c;
  }
  function costChips(c){
    var wrap = ui.el('span', 'cost-chips');
    if (c.sta)   wrap.appendChild(ui.el('span', 'cost-chip c-sta',   c.sta + ' STA'));
    if (c.mp)    wrap.appendChild(ui.el('span', 'cost-chip c-mp',    c.mp + ' MP'));
    if (c.faith) wrap.appendChild(ui.el('span', 'cost-chip c-faith', c.faith + ' FTH'));
    if (!wrap.firstChild) wrap.appendChild(ui.el('span', 'cost-chip free', '—'));
    return wrap;
  }
  function curFaith(){
    var st = state() || {};
    if (typeof st.playerFaith === 'number') return st.playerFaith;
    if (st.faith && typeof st.faith === 'object' && typeof st.faith.p === 'number') return st.faith.p;
    if (typeof st.faith === 'number') return st.faith;
    var m = party.active();
    if (m && typeof m.faith === 'number') return m.faith;
    return null;
  }
  function affordable(m, c){
    if (c.mp) {
      var mag = (m.magic !== undefined) ? m.magic : m.mp;
      if ((mag || 0) < c.mp) return false;
    }
    if (c.sta) {
      var sv = (typeof m.stamina === 'number') ? m.stamina : m.sta;
      if (typeof sv === 'number' && sv < c.sta) return false;
    }
    if (c.faith) {
      var f = curFaith();
      if (f !== null && f < c.faith) return false;
    }
    return true;
  }
  /* 2x/0.5x arrow data vs the CURRENT enemy — via CHLOE.data.types.multiplier
     (defender = enemy with type+resists). UI shows, engine decides. */
  function effMultVsEnemy(atkType){
    var types = CHLOE.data.types;
    if (!types || typeof types.multiplier !== 'function') return 1;
    var st = state() || {};
    var defender = (st.enemy && (st.enemy.type || st.enemy.resists)) ? st.enemy : (curEnemyDef || {});
    try {
      var m = types.multiplier(atkType, defender);
      if (typeof m === 'number' && isFinite(m)) return m;
    } catch (e) {}
    return 1;
  }

  function root(){ return CHLOE.ui.byId('screen-battle'); }

  function state(){
    if (engine) {
      try {
        if (typeof engine.state === 'function') return engine.state() || curState;
        if (typeof engine.getState === 'function') return engine.getState() || curState;
      } catch (e) {}
    }
    return curState;
  }
  function normSide(s){
    if (s === 'e' || s === 'enemy') return 'e';
    return 'p'; // 'p' | 'party' | 'player' | undefined
  }
  function phaseOf(side){
    var st = state() || {};
    var ph = side === 'e' ? st.enemyPhase : st.playerPhase;
    return PHASES[ph] ? ph : 'neutral';
  }
  function enemyName(){ return (curEnemyDef && curEnemyDef.name) || 'The enemy'; }
  function activeName(){
    var m = party.active();
    if (!m) return '???';
    var def = (CHLOE.data.characters || {})[m.id] || {};
    return def.name || m.id;
  }
  function moveName(ev){
    if (ev.name) return ev.name;
    var id = ev.moveId || ev.id;
    var def = (CHLOE.data.moves || {})[id] || FAILSAFE[id];
    return (def && def.name) || id || 'a move';
  }

  /* ---------- entry ---------- */
  function begin(enemyId, opts){
    ui = CHLOE.ui; party = CHLOE.engine.party; engine = CHLOE.engine.battle;
    var st = null;
    try { st = engine.start(enemyId, opts); } catch (e) { console.warn('[CHLOE] battle.start failed', e); }
    if (!st) {
      ui.toast('Something stirs... then nothing. (missing enemy data)');
      return;
    }
    curState = st;
    curEnemyDef = st.enemyDef || (CHLOE.data.enemies || {})[enemyId] || { name: 'Something', level: 1 };
    playing = false;
    build(st);
    ui.show('battle');
    logLine(curEnemyDef.name + ' blocks the way!', 'sys');
    if (st.boss) logLine('The exits are gone.', 'sys');
  }

  /* ---------- phase badges ---------- */
  function makePhaseBadge(){
    var b = ui.el('span', 'phase-badge phase-neutral', 'Neutral');
    b.title = PHASES.neutral.tip;
    return b;
  }
  function setBadge(badge, phaseId){
    if (!badge) return;
    var meta = PHASES[phaseId] || PHASES.neutral;
    badge.className = 'phase-badge phase-' + (PHASES[phaseId] ? phaseId : 'neutral');
    badge.textContent = meta.label;
    badge.title = meta.tip;
  }
  function updatePhaseBadges(){
    setBadge(els.playerBadge, phaseOf('p'));
    setBadge(els.enemyBadge, phaseOf('e'));
  }

  /* ---------- v3 resources (life/stamina/magic/faith) ---------- */
  function pickNum(){
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'number' && isFinite(arguments[i])) return arguments[i];
    }
    return null;
  }
  function effAll(m){
    var t = CHLOE.engine.tree;
    if (t && typeof t.effectiveStats === 'function') {
      try { var r = t.effectiveStats(m); if (r && typeof r === 'object') return r; } catch (e) {}
    }
    return party.effStats(m) || {};
  }
  function poolsOf(m){
    var eff = effAll(m);
    var v3 = (m.life !== undefined || typeof m.sta === 'number' ||
              typeof m.stamina === 'number' || typeof m.faith === 'number' ||
              eff.life !== undefined);
    var life = {
      cur: pickNum(m.life, m.hp, 0),
      max: pickNum(eff.maxLife, eff.life, eff.maxHp, eff.hp, 1),
      label: v3 ? 'LIFE' : 'HP'
    };
    var magicCur = pickNum(m.magic, m.mp);
    var magic = (magicCur === null) ? null : {
      cur: magicCur,
      max: pickNum(eff.maxMagic, eff.magic, eff.maxMp, eff.mp, 1),
      label: (m.magic !== undefined) ? 'MAG' : 'MP'
    };
    var staCur = (typeof m.stamina === 'number') ? m.stamina
               : (typeof m.sta === 'number') ? m.sta : null;
    var sta = (staCur === null) ? null : {
      cur: staCur, max: pickNum(eff.maxStamina, eff.stamina, 1), label: 'STA'
    };
    var f = curFaith();
    var faith = (f === null) ? null : {
      cur: f,
      max: pickNum(eff.maxFaith, eff.faith) || Math.max(f, 5),
      label: 'FTH'
    };
    return { life: life, stamina: sta, magic: magic, faith: faith };
  }

  /* stamina/magic/faith mini-bars under the life bar (player side only). */
  function renderMiniRes(m){
    if (!els.miniRes) return;
    var box = ui.clear(els.miniRes);
    var p = poolsOf(m);
    var mk = function(cls, pool){
      if (!pool) return;
      var row = ui.el('div', 'mini-row');
      row.appendChild(ui.el('span', 'mini-lbl', pool.label));
      // 'mp' token opts the bar out of the automatic hp-ok/hp-warn recoloring
      var bar = ui.makeBar('mp mini ' + cls);
      ui.setBar(bar, pool.cur, pool.max);
      row.appendChild(bar);
      row.appendChild(ui.el('span', 'mini-val', pool.cur + '/' + pool.max));
      row.title = pool.label + ' ' + pool.cur + ' / ' + pool.max;
      box.appendChild(row);
    };
    mk('res-sta', p.stamina);
    mk('res-mag', p.magic);
    mk('res-faith', p.faith);
  }

  /* ---------- v3 status meters (buildup rings + active-turns) ---------- */
  function sidePick(o, side){
    if (!o || typeof o !== 'object') return null;
    return side === 'e' ? (o.e || o.enemy) : (o.p || o.player || o.party);
  }
  /* Normalized [{id, buildup 0-100, active, turns}] for one side; tolerant of
     several engine state shapes, empty when the v3 engine isn't there yet. */
  function statusesOf(side){
    var st = state() || {};
    var m = party.active();
    var raw =
      (side === 'e' ? (st.enemyStatuses || st.enemyStatus) : (st.playerStatuses || st.playerStatus)) ||
      sidePick(st.statuses, side) || sidePick(st.status, side) ||
      (side === 'e'
        ? (st.enemy && (st.enemy.statuses || st.enemy.status))
        : (m && (m.statuses || m.status))) || null;
    if (!raw || typeof raw !== 'object') return [];
    var buildup = (raw.buildup && typeof raw.buildup === 'object') ? raw.buildup : raw;
    var active  = (raw.active  && typeof raw.active  === 'object') ? raw.active  : null;
    var out = [];
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      var id = STATUS_ORDER[i];
      var b = buildup[id];
      var a = active ? active[id] : null;
      var e = { id: id, buildup: 0, active: false, turns: 0 };
      if (typeof b === 'number') e.buildup = b;
      else if (b && typeof b === 'object') {
        e.buildup = b.buildup || b.amount || b.value || 0;
        e.turns = b.turns || b.left || 0;
        e.active = !!(b.active || e.turns > 0);
      }
      if (typeof a === 'number' && a > 0) { e.active = true; e.turns = a; }
      else if (a === true) e.active = true;
      else if (a && typeof a === 'object') { e.active = true; e.turns = a.turns || a.left || e.turns; }
      if (e.active || e.buildup > 0) out.push(e);
    }
    return out;
  }
  function renderStatusRow(side){
    var host = side === 'e' ? els.statusRowE : els.statusRowP;
    if (!host) return;
    var box = ui.clear(host);
    var list = statusesOf(side);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var meta = STATUS_META[s.id] || { icon: '✳', label: s.id, color: '#9a939c' };
      var chip = ui.el('span', 'status-chip' + (s.active ? ' on' : ''));
      chip.style.color = meta.color;
      var ring = ui.el('span', 'status-ring');
      var pct = Math.max(0, Math.min(100, s.active ? 100 : (s.buildup || 0)));
      ring.style.background = 'conic-gradient(' + meta.color + ' ' + pct + '%, rgba(255,255,255,.09) 0)';
      chip.appendChild(ring);
      chip.appendChild(ui.el('span', 'status-icn', meta.icon));
      if (s.active && s.turns) chip.appendChild(ui.el('span', 'status-turns', String(s.turns)));
      chip.title = meta.label + (s.active
        ? ' — active' + (s.turns ? ', ' + s.turns + ' turn' + (s.turns > 1 ? 's' : '') + ' left' : '')
        : ' — ' + Math.round(pct) + '% buildup');
      box.appendChild(chip);
    }
  }
  function refreshStatusRows(){
    renderStatusRow('p');
    renderStatusRow('e');
  }

  /* ---------- build ---------- */
  function build(st){
    var r = ui.clear(root());
    els = {};

    // top: enemy
    var top = ui.el('div', 'battle-top');
    var wrap = ui.el('div', 'enemy-wrap');
    els.enemyBox = ui.enemyImageNode(curEnemyDef); // <img> with silhouette fallback inside
    wrap.appendChild(els.enemyBox);
    var nm = ui.el('div', 'enemy-name', curEnemyDef.name);
    var lv = ui.el('span', 'lv', 'Lv ' + (curEnemyDef.level || 1) + (st.boss ? ' · BOSS' : ''));
    nm.appendChild(lv);
    wrap.appendChild(nm);

    var hpRow = ui.el('div', 'enemy-hprow');
    els.enemyHp = ui.makeBar('');
    els.enemyHp.classList.add('enemy-hpbar');
    var en = st.enemy || {};
    els.enemyMaxHp = en.maxHp || en.maxLife || en.hp || en.life ||
      (curEnemyDef.stats && (curEnemyDef.stats.hp || curEnemyDef.stats.life)) || 1;
    var enCur = (en.hp !== undefined) ? en.hp : en.life;
    ui.setBar(els.enemyHp, (enCur !== undefined ? enCur : els.enemyMaxHp), els.enemyMaxHp);
    hpRow.appendChild(els.enemyHp);
    els.enemyBadge = makePhaseBadge();
    hpRow.appendChild(els.enemyBadge);
    wrap.appendChild(hpRow);

    // enemy side: life bar only (§12) + status meters
    els.statusRowE = ui.el('div', 'status-row enemy-status');
    wrap.appendChild(els.statusRowE);

    els.enemyWrap = wrap;
    top.appendChild(wrap);
    r.appendChild(top);

    // bottom: member / commands / log
    var bottom = ui.el('div', 'battle-bottom');

    els.memberPanel = ui.el('div', 'bpanel member-panel');
    bottom.appendChild(els.memberPanel);
    renderMember();

    els.cmdPanel = ui.el('div', 'bpanel cmd-panel');
    bottom.appendChild(els.cmdPanel);
    renderCommands();

    els.log = ui.el('div', 'bpanel log-panel');
    bottom.appendChild(els.log);

    r.appendChild(bottom);
    updatePhaseBadges();
    refreshStatusRows();
  }

  function renderMember(){
    var m = party.active();
    var panel = ui.clear(els.memberPanel);
    if (!m) return;
    var pools = poolsOf(m);
    var def = (CHLOE.data.characters || {})[m.id] || {};

    els.portrait = ui.el('div', 'member-portrait');
    els.portrait.appendChild(ui.portraitNode(def.portraitKey || m.id, def.name || m.id));
    panel.appendChild(els.portrait);

    var info = ui.el('div', 'member-info');
    var nameRow = ui.el('div', 'member-name');
    nameRow.appendChild(ui.el('span', null, def.name || m.id));
    nameRow.appendChild(ui.el('span', 'lv', 'Lv ' + m.level));
    info.appendChild(nameRow);

    var hpRow = ui.el('div', 'bar-row');
    els.hpBar = ui.makeBar('');
    ui.setBar(els.hpBar, pools.life.cur, pools.life.max);
    hpRow.appendChild(els.hpBar);
    els.playerBadge = makePhaseBadge();
    hpRow.appendChild(els.playerBadge);
    info.appendChild(hpRow);

    els.hpTxt = ui.el('div', 'bar-txt');
    els.hpTxt.appendChild(ui.el('span', null, pools.life.label));
    els.hpVal = ui.el('span', null, pools.life.cur + ' / ' + pools.life.max);
    els.hpTxt.appendChild(els.hpVal);
    info.appendChild(els.hpTxt);

    // §12: stamina (green) / magic (blue) / faith (gold) mini-bars under life
    els.miniRes = ui.el('div', 'mini-res');
    info.appendChild(els.miniRes);
    renderMiniRes(m);

    els.statusRowP = ui.el('div', 'status-row');
    info.appendChild(els.statusRowP);
    renderStatusRow('p');

    panel.appendChild(info);
    updatePhaseBadges();
  }

  function refreshBars(){
    var m = party.active();
    if (!m || !els.hpBar) return;
    var pools = poolsOf(m);
    ui.setBar(els.hpBar, pools.life.cur, pools.life.max);
    if (els.hpVal) els.hpVal.textContent = pools.life.cur + ' / ' + pools.life.max;
    renderMiniRes(m);
  }
  function refreshEnemyBar(hpAfter, maxHp){
    var st = state() || {};
    var en = st.enemy || {};
    var max = maxHp || en.maxHp || en.maxLife || els.enemyMaxHp || 1;
    var cur = (en.hp !== undefined) ? en.hp : en.life;
    var hp = (hpAfter !== undefined) ? hpAfter : (cur !== undefined ? cur : max);
    els.enemyMaxHp = max;
    ui.setBar(els.enemyHp, hp, max);
    return hp;
  }

  /* ---------- move menu (engine.menu is the source of truth) ---------- */
  function getMenu(){
    var list = null;
    try {
      if (engine && typeof engine.menu === 'function') list = engine.menu();
    } catch (e) { console.warn('[CHLOE] battle.menu() failed', e); }
    if (list && !Array.isArray(list) && Array.isArray(list.moves)) list = list.moves;
    if (!Array.isArray(list)) list = fallbackMenu();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = normEntry(list[i]);
      if (n) out.push(n);
    }
    return out;
  }
  // Only used if the engine doesn't expose menu(): equipped moves for the
  // current phase from the loadout + failsafes. No rules computed here.
  function fallbackMenu(){
    var m = party.active();
    if (!m) return [];
    var phase = phaseOf('p');
    var lo = (CHLOE.ui.loadout && CHLOE.ui.loadout.getLoadouts) ? CHLOE.ui.loadout.getLoadouts(m.id) : {};
    var ids = (lo && lo[phase]) ? lo[phase].slice(0, 5) : [];
    if (ids.indexOf('struggle') === -1) ids.push('struggle');
    if (phase === 'staggered' && ids.indexOf('recover') === -1) ids.push('recover');
    return ids;
  }
  function normEntry(e){
    if (!e) return null;
    if (typeof e === 'string') e = { id: e };
    var def = (CHLOE.data.moves || {})[e.id] || FAILSAFE[e.id] || {};
    var m = party.active();
    var mp = (e.mpCost !== undefined) ? e.mpCost : (def.mpCost || 0);
    var costs = normCosts((e.cost !== undefined) ? e.cost : def.cost, mp);
    var disabled = (e.disabled !== undefined) ? !!e.disabled : !!(m && !affordable(m, costs));
    return {
      id: e.id,
      name: e.name || def.name || e.id,
      cat: e.cat || def.cat || 'attack',
      element: e.element || def.element || 'none',
      type: typeOfMove(e, def),
      mult: (typeof e.mult === 'number' && isFinite(e.mult)) ? e.mult : null,
      mpCost: mp,
      costs: costs,
      desc: e.desc || def.desc || '',
      disabled: disabled,
      reason: e.reason || ''
    };
  }

  function moveButton(mv){
    var b = ui.el('button', 'move-btn');
    var icon = ui.el('span', 'mcat', CAT_ICON[mv.cat] || CAT_ICON.attack);
    icon.title = CAT_LABEL[mv.cat] || mv.cat;
    b.appendChild(icon);
    b.appendChild(typeDot(mv.type));
    b.appendChild(ui.el('span', 'mname', mv.name));
    // §12: 2x/0.5x effectiveness arrow vs the current enemy (attacks only)
    if (mv.cat === 'attack') {
      var mult = (mv.mult !== null && mv.mult !== undefined) ? mv.mult : effMultVsEnemy(mv.type);
      if (mult >= 2) {
        var up = ui.el('span', 'eff-arrow eff-up', '▲');
        up.title = 'Super effective vs ' + enemyName() + ' (x' + mult + ')';
        b.appendChild(up);
      } else if (mult > 0 && mult <= 0.5) {
        var dn = ui.el('span', 'eff-arrow eff-down', '▼');
        dn.title = 'Weak vs ' + enemyName() + ' (x' + mult + ')';
        b.appendChild(dn);
      }
    }
    b.appendChild(costChips(mv.costs));
    b.title = mv.desc + (mv.disabled ? ' (' + (mv.reason || "Can't pay the cost right now") + ')' : '');
    if (mv.disabled) b.disabled = true;
    b.addEventListener('click', function(){ if (!playing) doMove(mv.id); });
    return b;
  }

  /* ---------- command menus ---------- */
  function renderCommands(){
    var st = state();
    var panel = ui.clear(els.cmdPanel);
    if (!st || st.over) return;

    // phase header
    var ph = phaseOf('p');
    var head = ui.el('div', 'cmd-title cmd-phase', PHASES[ph].label + ' moves');
    head.title = PHASES[ph].tip;
    panel.appendChild(head);

    // up to 5 equipped moves for the current phase + failsafes
    var list = ui.el('div', 'cmd-list move-list');
    var moves = getMenu();
    if (!moves.length) list.appendChild(ui.el('div', 'menu-note', 'No moves. The night ate them.'));
    for (var i = 0; i < moves.length; i++) list.appendChild(moveButton(moves[i]));
    panel.appendChild(list);

    // utility commands
    var util = ui.el('div', 'cmd-util');
    var mk = function(label, fn, disabled){
      var b = ui.el('button', null, label);
      if (disabled) b.disabled = true;
      b.addEventListener('click', function(){ if (!playing) fn(); });
      util.appendChild(b);
      return b;
    };
    mk('Items', renderItemMenu);
    // Switch hidden entirely while the party has one member (spec sec 11)
    if (party.state.members.length > 1) {
      mk('Switch', renderSwitchMenu, party.aliveMembers().length < 2);
    }
    mk('Moves', function(){
      if (CHLOE.ui.loadout) CHLOE.ui.loadout.open({ readOnly: true });
    });
    if (!st.boss) mk('Give Up', doFlee);
    panel.appendChild(util);
  }

  function subHeader(panel, title){
    panel.appendChild(ui.el('div', 'cmd-title', title));
  }
  function backBtn(panel){
    var b = ui.el('button', null, '‹ Back');
    b.addEventListener('click', renderCommands);
    panel.appendChild(b);
  }

  function renderItemMenu(){
    var panel = ui.clear(els.cmdPanel);
    subHeader(panel, 'Items');
    var list = ui.el('div', 'cmd-list');
    var items = CHLOE.engine.inventory.list();
    if (!items.length) list.appendChild(ui.el('div', 'menu-note', 'Bag is empty.'));
    items.forEach(function(entry){
      var def = entry.def;
      var b = ui.el('button');
      b.appendChild(ui.el('span', null, (def.icon ? def.icon + ' ' : '') + def.name));
      b.appendChild(ui.el('span', 'cost free', 'x' + entry.count));
      b.title = def.desc || '';
      // revive items must target a FALLEN member — the engine defaults to the
      // (alive) active member when no target is passed, which can never revive
      var targetId = null;
      if (def.effect && def.effect.revivePct) {
        var fallen = party.state.members.filter(function(mm){ return mm.hp <= 0; });
        if (!fallen.length) b.disabled = true;
        else targetId = fallen[0].id;
      }
      b.addEventListener('click', function(){ if (!playing) doItem(def.id, targetId); });
      list.appendChild(b);
    });
    panel.appendChild(list);
    backBtn(panel);
  }

  function renderSwitchMenu(){
    var panel = ui.clear(els.cmdPanel);
    subHeader(panel, 'Switch to');
    var list = ui.el('div', 'cmd-list');
    var activeId = party.state.activeId;
    var others = party.state.members.filter(function(m){ return m.id !== activeId; });
    others.forEach(function(m){
      var def = (CHLOE.data.characters || {})[m.id] || {};
      var b = ui.el('button');
      b.appendChild(ui.el('span', null, def.name || m.id));
      b.appendChild(ui.el('span', 'cost free', m.hp > 0 ? m.hp + ' HP' : 'K.O.'));
      if (m.hp <= 0) b.disabled = true;
      b.addEventListener('click', function(){ if (!playing) doSwitch(m.id); });
      list.appendChild(b);
    });
    panel.appendChild(list);
    backBtn(panel);
  }

  /* ---------- action -> event playback ---------- */
  function isOver(){
    try {
      if (engine && typeof engine.isOver === 'function') return engine.isOver();
    } catch (e) {}
    var st = state();
    return !st || !!st.over;
  }
  function runEngine(fnName, arg, legacyAction){
    var events = null;
    try {
      if (engine && typeof engine[fnName] === 'function') events = engine[fnName](arg);
      else if (engine && typeof engine.act === 'function') events = engine.act(legacyAction || arg);
    } catch (e) { console.warn('[CHLOE] battle action failed', e); }
    return Array.isArray(events) ? events : [];
  }
  function doMove(moveId){
    if (playing || isOver()) return;
    play(runEngine('act', moveId));
  }
  function doItem(itemId, targetId){
    if (playing || isOver()) return;
    var events = null;
    try {
      if (engine && typeof engine.item === 'function') events = engine.item(itemId, targetId);
      else if (engine && typeof engine.act === 'function') events = engine.act({ type: 'item', id: itemId, targetId: targetId });
    } catch (e) { console.warn('[CHLOE] battle action failed', e); }
    play(Array.isArray(events) ? events : []);
  }
  function doSwitch(charId){
    if (playing || isOver()) return;
    play(runEngine('switchTo', charId, { type: 'switch', id: charId }));
  }
  function doFlee(){
    if (playing || isOver()) return;
    play(runEngine('flee', undefined, { type: 'giveup' }));
  }

  function play(events){
    if (!events.length) return;
    playing = true;
    ui.clear(els.cmdPanel); // lock commands during playback
    playEvents(events, 0);
  }

  function playEvents(events, i){
    if (i >= events.length) {
      playing = false;
      renderMember();
      refreshBars();
      refreshEnemyBar();
      updatePhaseBadges();
      refreshStatusRows();
      renderCommands();
      return;
    }
    var ev = events[i] || {};
    var delay = 100;
    try { delay = handleEvent(ev); } catch (e) { console.warn('[CHLOE] battle event failed', ev, e); }
    updatePhaseBadges();
    refreshStatusRows();
    window.setTimeout(function(){ playEvents(events, i + 1); }, delay);
  }

  function handleEvent(ev){
    var side = normSide(ev.side);
    switch (ev.t) {
      case 'log':
        logLine(ev.text, ev.cls);
        return 260;

      case 'mp':
        refreshBars();
        return 120;

      case 'res': // v3 stamina/faith change ({t:'res', side, kind, after})
        refreshBars();
        return 120;

      case 'move':
        // The engine follows every 'move' with its own 'log' line — only log
        // here if this event carries its own text (avoids duplicate lines).
        if (ev.text) logLine(ev.text, side === 'e' ? '' : 'hot');
        return 300;

      case 'dmg': {
        var mult = (ev.mult !== undefined) ? ev.mult : 1;
        if (side === 'e') {
          var hp = refreshEnemyBar(ev.hpAfter, ev.maxHp);
          popNumber(els.enemyBox, '-' + ev.amount, mult >= 2 ? 'weak' : (mult <= 0.5 ? 'resist' : ''));
          flash(els.enemyBox, 'enemy-hit');
          if (mult >= 2) floatLabel(els.enemyBox, 'SUPER', 'super');
          if (hp <= 0) els.enemyWrap.classList.add('enemy-dead');
        } else {
          refreshBars();
          popNumber(els.portrait || els.memberPanel, '-' + ev.amount, mult >= 2 ? 'weak' : '');
          flash(els.memberPanel, 'member-hit');
          if (mult >= 2) floatLabel(els.portrait || els.memberPanel, 'SUPER', 'super');
          shake();
        }
        if (ev.text) logLine(ev.text);
        else {
          logLine((side === 'e' ? enemyName() : activeName()) + ' takes ' + ev.amount + '.');
          if (mult >= 2) logLine("It's super effective!", 'hot');
          else if (mult > 0 && mult <= 0.5) logLine('Not very effective...', '');
        }
        return STEP_MS;
      }

      case 'block': {
        // kind 'set' = a defense move REGISTERED a block (the engine already
        // logged the move line) — no "blocked" cue. kind 'hit' = an attack was
        // actually blocked: float the label; the engine logs 'blocks it!' itself.
        if (ev.kind === 'set') return 160;
        var anchor = side === 'e' ? els.enemyBox : (els.portrait || els.memberPanel);
        floatLabel(anchor, 'BLOCKED', 'blocked');
        if (ev.text) logLine(ev.text, 'hot');
        return STEP_MS;
      }

      case 'miss': {
        var a2 = side === 'e' ? els.enemyBox : (els.portrait || els.memberPanel);
        popNumber(a2, 'MISS', 'resist');
        logLine(ev.text || ((side === 'e' ? enemyName() : activeName()) + ' whiffs!'));
        return STEP_MS;
      }

      case 'phase': {
        var to = ev.to || ev.phase || phaseOf(side);
        var meta = PHASES[to] || PHASES.neutral;
        if (to === 'staggered') {
          floatLabel(side === 'e' ? els.enemyBox : (els.portrait || els.memberPanel), 'STAGGERED!', 'stagger');
        }
        logLine(ev.text || ((side === 'e' ? enemyName() : activeName()) +
          (to === 'charged' ? ' charges up!' : ' is ' + meta.label + '.')),
          to === 'staggered' ? 'sys' : '');
        return 340;
      }

      case 'status': {
        // v3 named status events ({t:'status', status:'burn', ...}) — floating
        // "BURN!" label on activation + a log line; ticks/decay just refresh.
        if (typeof ev.status === 'string') {
          var smeta = STATUS_META[ev.status] || { label: ev.status };
          var stage = ev.stage || ev.kind || '';
          var anchorS = side === 'e' ? els.enemyBox : (els.portrait || els.memberPanel);
          // trigger/skip get the floating "BLEED!"-style label; buildup, per-turn
          // ticks and clears just refresh the chips (the engine logs its own lines).
          var activation = (stage !== 'tick' && stage !== 'end' && stage !== 'clear' &&
                            stage !== 'buildup' && stage !== 'decay' && ev.buildup === undefined);
          if (activation) {
            floatLabel(anchorS, ev.label || (smeta.label.toUpperCase() + '!'), 'status-pop');
          }
          if (ev.text) logLine(ev.text, activation ? 'sys' : '');
          refreshBars();
          refreshEnemyBar();
          return activation ? STEP_MS : 200;
        }
        refreshBars();
        refreshEnemyBar();
        // legacy heal-ish shapes only pop a number (buffs/debuffs/dots log instead)
        var popKind = ev.kind || '';
        if (popKind === '' || popKind === 'hp' || popKind === 'mp' || popKind === 'heal') {
          if (ev.amount && side === 'p') {
            popNumber(els.portrait || els.memberPanel, (ev.amount > 0 ? '+' : '') + ev.amount,
              popKind === 'mp' ? 'mp' : 'heal');
          } else if (ev.amount && side === 'e') {
            popNumber(els.enemyBox, (ev.amount > 0 ? '+' : '') + ev.amount, 'heal');
          }
        }
        if (ev.text) logLine(ev.text);
        return STEP_MS;
      }

      case 'heal': { // legacy shape kept working
        if (side === 'e') {
          if (ev.kind !== 'mp') refreshEnemyBar(ev.hpAfter);
          if (ev.amount) popNumber(els.enemyBox, '+' + ev.amount, ev.kind === 'mp' ? 'mp' : 'heal');
        } else {
          refreshBars();
          if (els.portrait && ev.amount) {
            popNumber(els.portrait, '+' + ev.amount, ev.kind === 'mp' ? 'mp' : 'heal');
          }
        }
        return STEP_MS;
      }

      case 'switch':
        renderMember();
        refreshBars();
        // the engine already logs 'steps up!' / 'rushes in!' — no fallback line
        if (ev.text) logLine(ev.text, 'hot');
        return 380;

      case 'ko':
        // Player-side KOs are logged by the engine with the RIGHT name (state
        // has already force-switched, so activeName() here would be wrong).
        if (ev.text) logLine(ev.text, 'sys');
        else if (side === 'e') logLine(enemyName() + ' goes down!', 'sys');
        return 300;

      case 'end':
        window.setTimeout(function(){ showEnd(ev); }, 500);
        return 600;

      default:
        if (ev.text) logLine(ev.text, ev.cls);
        return 100;
    }
  }

  /* ---------- fx ---------- */
  function logLine(text, cls){
    if (!els.log || !text) return;
    var ln = ui.el('div', 'ln' + (cls ? ' ' + cls : ''), text);
    els.log.appendChild(ln);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function shake(){
    var r = root();
    r.classList.remove('shake');
    void r.offsetWidth;
    r.classList.add('shake');
  }

  function flash(node, cls){
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  function popNumber(anchor, text, extraCls){
    if (!anchor) return;
    var r = root();
    var rb = r.getBoundingClientRect();
    var ab = anchor.getBoundingClientRect();
    var pop = ui.el('div', 'dmg-pop' + (extraCls ? ' ' + extraCls : ''), text);
    pop.style.left = (ab.left - rb.left + ab.width / 2 + (Math.random() * 30 - 15)) + 'px';
    pop.style.top = (ab.top - rb.top + ab.height * 0.35) + 'px';
    r.appendChild(pop);
    window.setTimeout(function(){ if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1050);
  }

  function floatLabel(anchor, text, cls){
    if (!anchor) return;
    var r = root();
    var rb = r.getBoundingClientRect();
    var ab = anchor.getBoundingClientRect();
    var lab = ui.el('div', 'float-label ' + (cls || ''), text);
    lab.style.left = (ab.left - rb.left + ab.width / 2) + 'px';
    lab.style.top = (ab.top - rb.top + ab.height * 0.12) + 'px';
    r.appendChild(lab);
    window.setTimeout(function(){ if (lab.parentNode) lab.parentNode.removeChild(lab); }, 1250);
  }

  /* ---------- end panels ---------- */
  function showEnd(ev){
    playing = false;

    var result = ev.result || ((state() || {}).result) || 'victory';
    if (result === 'fled') {
      CHLOE.ui.scene.onBattleEnd('fled');
      return;
    }

    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card' + (result === 'defeat' ? ' defeat' : ''));

    if (result === 'victory') {
      card.appendChild(ui.el('h2', null, 'Encore!'));
      var lines = ui.el('div', 'result-lines');
      var rw = ev.rewards || (state() || {}).rewards || {};
      lines.appendChild(ui.el('div', 'big', '+' + (rw.xp || 0) + ' XP · +' + (rw.shards || 0) + ' ◆'));
      (rw.levelUps || []).forEach(function(l){
        var def = (CHLOE.data.characters || {})[l.memberId] || {};
        lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' reached Lv ' + l.level + '!'));
      });
      (rw.learned || []).forEach(function(l){
        var def = (CHLOE.data.characters || {})[l.memberId] || {};
        lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' learned ' + (l.name || l.move || l.skill || l.moveId) + '!'));
      });
      (rw.drops || []).forEach(function(d){
        lines.appendChild(ui.el('div', null, 'Found: ' + d));
      });
      card.appendChild(lines);
      var cont = ui.el('button', null, 'Continue');
      cont.addEventListener('click', function(){
        if (veil.parentNode) veil.parentNode.removeChild(veil);
        CHLOE.ui.scene.onBattleEnd('victory');
      });
      card.appendChild(cont);
    } else {
      // roguelike (spec §15): death ends the run — show the run summary
      card.appendChild(ui.el('h2', null, 'The Night Wins'));
      var dl = ui.el('div', 'result-lines');
      dl.appendChild(ui.el('div', null, 'The Backstage Between swallows the stage...'));
      var p = CHLOE.engine.party, st = (p && p.state) || {};
      var topLv = 1;
      (st.members || []).forEach(function(m){ if (m.level > topLv) topLv = m.level; });
      var kills = (st.runStats && st.runStats.kills) || 0;
      dl.appendChild(ui.el('div', 'big', 'Run over — Lv ' + topLv + ' · ◆ ' + (st.shards || 0) +
        ' · ' + kills + (kills === 1 ? ' fight won' : ' fights won')));
      dl.appendChild(ui.el('div', null, 'Every night starts from nothing.'));
      card.appendChild(dl);
      var re = ui.el('button', null, 'Begin again');
      re.addEventListener('click', function(){
        if (veil.parentNode) veil.parentNode.removeChild(veil);
        CHLOE.ui.scene.onBattleEnd('defeat');
      });
      card.appendChild(re);
    }

    veil.appendChild(card);
    root().appendChild(veil);
  }

  return { begin: begin };
})();
