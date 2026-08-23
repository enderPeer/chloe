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
    els.enemyMaxHp = en.maxHp || en.hp || (curEnemyDef.stats && curEnemyDef.stats.hp) || 1;
    ui.setBar(els.enemyHp, (en.hp !== undefined ? en.hp : els.enemyMaxHp), els.enemyMaxHp);
    hpRow.appendChild(els.enemyHp);
    els.enemyBadge = makePhaseBadge();
    hpRow.appendChild(els.enemyBadge);
    wrap.appendChild(hpRow);

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
  }

  function renderMember(){
    var m = party.active();
    var panel = ui.clear(els.memberPanel);
    if (!m) return;
    var eff = party.effStats(m);
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
    ui.setBar(els.hpBar, m.hp, eff.maxHp);
    hpRow.appendChild(els.hpBar);
    els.playerBadge = makePhaseBadge();
    hpRow.appendChild(els.playerBadge);
    info.appendChild(hpRow);

    els.hpTxt = ui.el('div', 'bar-txt');
    els.hpTxt.appendChild(ui.el('span', null, 'HP'));
    els.hpVal = ui.el('span', null, m.hp + ' / ' + eff.maxHp);
    els.hpTxt.appendChild(els.hpVal);
    info.appendChild(els.hpTxt);

    els.mpBar = ui.makeBar('mp');
    ui.setBar(els.mpBar, m.mp, eff.maxMp);
    info.appendChild(els.mpBar);
    els.mpTxt = ui.el('div', 'bar-txt');
    els.mpTxt.appendChild(ui.el('span', null, 'MP'));
    els.mpVal = ui.el('span', null, m.mp + ' / ' + eff.maxMp);
    els.mpTxt.appendChild(els.mpVal);
    info.appendChild(els.mpTxt);

    panel.appendChild(info);
    updatePhaseBadges();
  }

  function refreshBars(){
    var m = party.active();
    if (!m || !els.hpBar) return;
    var eff = party.effStats(m);
    ui.setBar(els.hpBar, m.hp, eff.maxHp);
    ui.setBar(els.mpBar, m.mp, eff.maxMp);
    if (els.hpVal) els.hpVal.textContent = m.hp + ' / ' + eff.maxHp;
    if (els.mpVal) els.mpVal.textContent = m.mp + ' / ' + eff.maxMp;
  }
  function refreshEnemyBar(hpAfter, maxHp){
    var st = state() || {};
    var en = st.enemy || {};
    var max = maxHp || en.maxHp || els.enemyMaxHp || 1;
    var hp = (hpAfter !== undefined) ? hpAfter : (en.hp !== undefined ? en.hp : max);
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
    var disabled = (e.disabled !== undefined) ? !!e.disabled : !!(m && (m.mp || 0) < mp);
    return {
      id: e.id,
      name: e.name || def.name || e.id,
      cat: e.cat || def.cat || 'attack',
      element: e.element || def.element || 'none',
      mpCost: mp,
      desc: e.desc || def.desc || '',
      disabled: disabled
    };
  }

  function moveButton(mv){
    var b = ui.el('button', 'move-btn');
    var icon = ui.el('span', 'mcat', CAT_ICON[mv.cat] || CAT_ICON.attack);
    icon.title = CAT_LABEL[mv.cat] || mv.cat;
    b.appendChild(icon);
    var dot = ui.el('span', 'el-dot el-' + (mv.element || 'none'));
    dot.title = ((CHLOE.data.elements || {}).labels || {})[mv.element] || mv.element || '';
    b.appendChild(dot);
    b.appendChild(ui.el('span', 'mname', mv.name));
    b.appendChild(ui.el('span', 'mp-chip' + (mv.mpCost ? '' : ' free'), mv.mpCost ? mv.mpCost + ' MP' : '—'));
    b.title = mv.desc + (mv.disabled && mv.mpCost ? ' (Not enough MP)' : '');
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
      if (def.effect && def.effect.revivePct) {
        var fallen = party.state.members.filter(function(mm){ return mm.hp <= 0; });
        if (!fallen.length) b.disabled = true;
      }
      b.addEventListener('click', function(){ if (!playing) doItem(def.id); });
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
  function doItem(itemId){
    if (playing || isOver()) return;
    play(runEngine('item', itemId, { type: 'item', id: itemId }));
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
      updatePhaseBadges();
      renderCommands();
      return;
    }
    var ev = events[i] || {};
    var delay = 100;
    try { delay = handleEvent(ev); } catch (e) { console.warn('[CHLOE] battle event failed', ev, e); }
    updatePhaseBadges();
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

      case 'move':
        logLine(ev.text || ((side === 'e' ? enemyName() : activeName()) + ' uses ' + moveName(ev) + '!'),
          side === 'e' ? '' : 'hot');
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
        var anchor = side === 'e' ? els.enemyBox : (els.portrait || els.memberPanel);
        floatLabel(anchor, 'BLOCKED', 'blocked');
        logLine(ev.text || ((side === 'e' ? enemyName() : activeName()) + ' blocks it!'), 'hot');
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

      case 'status':
        refreshBars();
        refreshEnemyBar();
        if (ev.amount && side === 'p') {
          popNumber(els.portrait || els.memberPanel, (ev.amount > 0 ? '+' : '') + ev.amount,
            ev.kind === 'mp' ? 'mp' : 'heal');
        } else if (ev.amount && side === 'e') {
          popNumber(els.enemyBox, (ev.amount > 0 ? '+' : '') + ev.amount, 'heal');
        }
        if (ev.text) logLine(ev.text);
        return STEP_MS;

      case 'heal': { // legacy shape kept working
        refreshBars();
        if (side === 'p' && els.portrait) {
          popNumber(els.portrait, '+' + ev.amount, ev.kind === 'mp' ? 'mp' : 'heal');
        }
        return STEP_MS;
      }

      case 'switch':
        renderMember();
        refreshBars();
        logLine(ev.text || (activeName() + ' steps up!'), 'hot');
        return 380;

      case 'ko':
        logLine(ev.text || ((side === 'e' ? enemyName() : activeName()) + ' goes down!'), 'sys');
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
    // autosave on battle end (scene.onBattleEnd saves again after flags/respawn)
    if (CHLOE.engine.save.getCurrent()) CHLOE.engine.save.autosave();

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
        lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' learned ' + (l.move || l.skill) + '!'));
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
      card.appendChild(ui.el('h2', null, 'The Night Wins'));
      var dl = ui.el('div', 'result-lines');
      dl.appendChild(ui.el('div', null, 'The Backstage Between swallows the stage...'));
      dl.appendChild(ui.el('div', null, 'You lose ' +
        ((CHLOE.data.config && CHLOE.data.config.defeatShardLossPct) || 30) + '% of your shards.'));
      card.appendChild(dl);
      var re = ui.el('button', null, 'Crawl back');
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
