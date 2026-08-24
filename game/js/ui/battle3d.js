/* CHLOE — ui/battle3d.js  (Arena battles, spec §15 — HUD + round flow)
   Owns #screen-battle3d: the arena canvas (engine/arena3d.js renders into it)
   plus the HUD — enemy plate, party plates, move picker, telegraph prompt,
   damage splashes, round log. Orchestrates the round loop against
   engine/arena.js (rules) and engine/arena3d.js (3D + dodge resolution).
   Ends funnel through CHLOE.ui.scene.onBattleEnd(result) exactly like the 2D
   battle screen, so ui/room3d.js's wrapper handles the roguelike outcomes
   (victory -> back to the room + Ash hook; defeat -> fresh run, §14). */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.battle3d = (function(){
  'use strict';

  var ui, party, arena, a3d;
  var els = {};
  var built = false, inited3d = false, active = false;
  var choices = [];          // [{memberId, moveId} | {memberId, itemId}]
  var chooseQueue = [];      // member ids still to pick this round
  var timers = [];

  function later(fn, ms){ var t = window.setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers(){
    for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
    timers.length = 0;
  }

  function charName(id){
    var c = (CHLOE.data.characters || {})[id];
    return (c && c.name) || id;
  }
  function typeColor(t){
    var colors = (CHLOE.data.types && CHLOE.data.types.colors) || {};
    return colors[t] || '#9a939c';
  }

  /* ---------- screen ---------- */
  function root(){
    var r = ui.byId('screen-battle3d');
    if (!r) {
      r = ui.el('div', 'screen');
      r.id = 'screen-battle3d';
      var app = ui.byId('app');
      var dlg = ui.byId('dialog-layer');
      if (app) app.insertBefore(r, dlg || null);
      else document.body.appendChild(r);
    }
    return r;
  }

  function build(){
    var r = ui.clear(root());
    els.canvas = document.createElement('canvas');
    els.canvas.id = 'battle3d-canvas';
    r.appendChild(els.canvas);
    r.appendChild(ui.el('div', 'r3d-vignette'));

    // enemy plate (top center)
    els.enemyPlate = ui.el('div', 'b3d-enemy-plate');
    els.enemyName = ui.el('div', 'b3d-enemy-name', '');
    els.enemyBar = ui.makeBar('');
    els.enemyPlate.appendChild(els.enemyName);
    els.enemyPlate.appendChild(els.enemyBar);
    r.appendChild(els.enemyPlate);

    // party plates (bottom left)
    els.party = ui.el('div', 'b3d-party');
    r.appendChild(els.party);

    // center prompt (telegraph hints, EVADED, round banners)
    els.prompt = ui.el('div', 'b3d-prompt hidden', '');
    r.appendChild(els.prompt);

    // one-line log (above the move panel)
    els.log = ui.el('div', 'b3d-log', '');
    r.appendChild(els.log);

    // move panel (bottom center)
    els.panel = ui.el('div', 'b3d-panel hidden');
    r.appendChild(els.panel);

    // controls hint
    r.appendChild(ui.el('div', 'b3d-controls',
      'WASD move · click the room to aim · Ctrl or C crouch · Shift sprint · arrows/Q/E turn'));

    built = true;
  }

  /* ---------- HUD ---------- */
  function refreshEnemy(){
    var st = arena.get();
    if (!st) return;
    els.enemyName.textContent = (CHLOE.data.arena3d && CHLOE.data.arena3d.knight &&
      CHLOE.data.arena3d.knight.name) || st.enemyDef.name;
    ui.setBar(els.enemyBar, st.enemy.life, st.enemy.max);
  }

  function refreshParty(){
    ui.clear(els.party);
    var members = party.state.members;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var mx = party.maxStats(m);
      var plate = ui.el('div', 'b3d-member' + (party.state.activeId === m.id ? ' body' : '') +
        (m.hp <= 0 ? ' down' : ''));
      var head = ui.el('div', 'b3d-member-head');
      head.appendChild(ui.el('span', 'nm', charName(m.id) + ' · Lv ' + m.level));
      head.appendChild(ui.el('span', 'hp', m.hp + '/' + mx.hp));
      plate.appendChild(head);
      var lifeBar = ui.makeBar('');
      ui.setBar(lifeBar, m.hp, mx.hp);
      plate.appendChild(lifeBar);
      var res = ui.el('div', 'b3d-member-res');
      res.appendChild(ui.el('span', 'sta', 'STA ' + (m.stamina || 0)));
      res.appendChild(ui.el('span', 'mp', 'MP ' + (m.mp || 0)));
      res.appendChild(ui.el('span', 'faith', 'FTH ' + (m.faith || 0)));
      plate.appendChild(res);
      els.party.appendChild(plate);
    }
  }

  function log(text){
    els.log.textContent = text || '';
  }

  function prompt(text, cls, ms){
    els.prompt.className = 'b3d-prompt ' + (cls || '');
    els.prompt.textContent = text;
    if (ms) later(function(){ els.prompt.classList.add('hidden'); }, ms);
  }
  function hidePrompt(){ els.prompt.classList.add('hidden'); }

  function splash(text, cls){
    var s = ui.el('div', 'b3d-splash ' + (cls || ''), text);
    root().appendChild(s);
    later(function(){ if (s.parentNode) s.parentNode.removeChild(s); }, 1200);
  }

  /* ---------- round flow ---------- */
  function begin(enemyId){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    arena = CHLOE.engine.arena; a3d = CHLOE.engine.arena3d;

    var st = arena.start(enemyId);
    if (!st) { console.warn('[battle3d] unknown enemy ' + enemyId); return; }
    if (!built) build();
    active = true;
    choices = [];

    ui.show('battle3d');
    if (!inited3d) { a3d.init(els.canvas); inited3d = true; }
    a3d.reset();
    a3d.resize();
    a3d.start();

    refreshEnemy();
    refreshParty();
    log('The church doors seal behind you.');
    prompt('THE ' + ((CHLOE.data.arena3d && CHLOE.data.arena3d.knight &&
      CHLOE.data.arena3d.knight.name) || st.enemyDef.name).toUpperCase() + ' RISES', 'banner', 2000);
    later(startChoose, 1400);
  }

  function startChoose(){
    if (!active || arena.isOver()) return;
    choices = [];
    var alive = party.aliveMembers();
    // body first, then the rest (spd order among the rest)
    alive.sort(function(a, b){
      if (a.id === party.state.activeId) return -1;
      if (b.id === party.state.activeId) return 1;
      return party.effStats(b).spd - party.effStats(a).spd;
    });
    chooseQueue = alive.map(function(m){ return m.id; });
    nextChooser();
  }

  function nextChooser(){
    if (!active || arena.isOver()) return;
    if (!chooseQueue.length) { hidePanel(); resolveRound(); return; }
    var memberId = chooseQueue.shift();
    var m = party.get(memberId);
    if (!m || m.hp <= 0) { nextChooser(); return; }
    renderMovePanel(m);
  }

  function hidePanel(){ els.panel.classList.add('hidden'); }

  // While pointer lock is held every mouse event goes to the canvas — the
  // panel buttons would be unclickable. Release it whenever a panel opens;
  // the player re-locks by clicking the room when the dodge phase comes.
  function releaseLock(){
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  }

  function renderMovePanel(member){
    releaseLock();
    var p = ui.clear(els.panel);
    p.classList.remove('hidden');
    p.appendChild(ui.el('div', 'b3d-panel-title',
      charName(member.id) + ' — choose an attack'));

    var grid = ui.el('div', 'b3d-moves');
    var opts = arena.attackOptions(member);
    opts.forEach(function(opt){
      var mv = opt.move;
      var b = ui.el('button', 'b3d-move');
      var dot = ui.el('span', 'dot');
      dot.style.background = typeColor(mv.type || mv.element);
      b.appendChild(dot);
      b.appendChild(ui.el('span', 'nm', mv.name));
      var costs = [];
      if (opt.cost.sta) costs.push(opt.cost.sta + ' STA');
      if (opt.cost.mp) costs.push(opt.cost.mp + ' MP');
      if (opt.cost.faith) costs.push(opt.cost.faith + ' FTH');
      b.appendChild(ui.el('span', 'cost', costs.join(' ') || '—'));
      if (opt.mult >= 2) b.appendChild(ui.el('span', 'eff up', '▲'));
      else if (opt.mult <= 0.5) b.appendChild(ui.el('span', 'eff down', '▼'));
      b.disabled = !!opt.disabled;
      if (opt.disabled) b.title = opt.reason || '';
      b.addEventListener('click', function(){
        choices.push({ memberId: member.id, moveId: mv.id });
        nextChooser();
      });
      grid.appendChild(b);
    });
    p.appendChild(grid);

    var rowB = ui.el('div', 'b3d-panel-row');
    var itemsB = ui.el('button', null, 'Items');
    itemsB.addEventListener('click', function(){ renderItemPanel(member); });
    rowB.appendChild(itemsB);
    // Give Up only before anyone has committed a pick — a failed flee costs
    // the knight's free swing, never attacks already chosen this round
    if (!choices.length) {
      var fleeB = ui.el('button', null, 'Give Up');
      fleeB.addEventListener('click', doFlee);
      rowB.appendChild(fleeB);
    }
    p.appendChild(rowB);
  }

  function renderItemPanel(member){
    releaseLock();
    var p = ui.clear(els.panel);
    p.appendChild(ui.el('div', 'b3d-panel-title',
      charName(member.id) + ' — use an item (this is their turn)'));
    var inv = CHLOE.engine.inventory;
    // counts minus what earlier choosers already committed this round
    var committed = {};
    choices.forEach(function(c){ if (c.itemId) committed[c.itemId] = (committed[c.itemId] || 0) + 1; });
    var items = inv.list().map(function(entry){
      return { def: entry.def, count: entry.count - (committed[entry.def.id] || 0) };
    }).filter(function(entry){ return entry.count > 0; });
    var grid = ui.el('div', 'b3d-moves');
    if (!items.length) grid.appendChild(ui.el('div', 'b3d-empty', 'The bag is empty.'));
    items.forEach(function(entry){
      var b = ui.el('button', 'b3d-move');
      b.appendChild(ui.el('span', 'nm', (entry.def.icon || '▪') + ' ' + entry.def.name + ' ×' + entry.count));
      b.addEventListener('click', function(){
        choices.push({ memberId: member.id, itemId: entry.def.id });
        nextChooser();
      });
      grid.appendChild(b);
    });
    p.appendChild(grid);
    var back = ui.el('button', null, '‹ Attacks');
    back.addEventListener('click', function(){ renderMovePanel(member); });
    p.appendChild(back);
  }

  function doFlee(){
    hidePanel();
    var r = arena.flee();
    if (r.boss) { log('The doors are sealed. There is no leaving this one.'); later(startChoose, 900); return; }
    if (r.fled) { log('You slip out through the vestry.'); later(function(){ end('fled'); }, 800); return; }
    log('The doors hold fast — and the knight is already moving!');
    later(enemyTurn, 700);
  }

  /* Player choices resolve in the order they were made (body first). */
  function resolveRound(){
    if (!active || arena.isOver()) return;
    var queue = choices.slice();
    choices = [];
    var step = function(){
      if (!active) return;
      if (arena.isOver()) { checkOver(); return; }
      var c = queue.shift();
      if (!c) { later(enemyTurn, 650); return; }
      if (c.itemId) {
        var r = arena.useItem(c.memberId, c.itemId);
        log(r.text || 'Nothing happens.');
        refreshParty();
        later(step, 750);
        return;
      }
      var ev = arena.playerAttack(c.memberId, c.moveId);
      if (ev) {
        log(ev.log);
        if (!ev.missed) {
          a3d.flinch(ev.dmg, ev.killed);
          splash('-' + ev.dmg + (ev.mult >= 2 ? ' SUPER' : ''), ev.mult >= 2 ? 'super' : 'dmg');
        } else {
          splash('MISS', 'miss');
        }
        refreshEnemy();
        refreshParty();
      }
      if (arena.isOver()) { checkOver(); return; }
      later(step, 800);
    };
    step();
  }

  function enemyTurn(){
    if (!active || arena.isOver()) { checkOver(); return; }
    var pattern = arena.pickPattern();
    if (!pattern) { later(nextRound, 400); return; }
    prompt(pattern.name + ' — ' + pattern.hint, 'telegraph');
    a3d.telegraph(pattern, function(res){
      if (!active) return;
      hidePrompt();
      var ev = arena.enemyStrike(pattern, res.hit);
      if (!ev) { checkOver(); return; }
      log(ev.log);
      if (!ev.hit) {
        splash('EVADED!', 'evade');
      } else {
        splash('-' + ev.dmg, 'hurt');
        if (ev.bodySwitch) prompt(charName(ev.bodySwitch.id).toUpperCase() + ' STEPS IN', 'banner', 1600);
      }
      refreshParty();
      if (arena.isOver()) { checkOver(); return; }
      later(nextRound, 900);
    });
  }

  function nextRound(){
    if (!active || arena.isOver()) { checkOver(); return; }
    arena.startRound();
    refreshParty();
    startChoose();
  }

  /* ---------- outcomes ---------- */
  function checkOver(){
    var st = arena.get();
    if (!st || !st.over) return;
    if (st.result === 'victory') showVictory(st);
    else if (st.result === 'defeat') showDefeat();
    else end(st.result || 'fled');
  }

  function showVictory(st){
    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card');
    card.appendChild(ui.el('h2', null, 'Encore!'));
    var lines = ui.el('div', 'result-lines');
    var rw = st.rewards || {};
    lines.appendChild(ui.el('div', 'big', '+' + (rw.xp || 0) + ' XP · +' + (rw.shards || 0) + ' ◆'));
    (rw.levelUps || []).forEach(function(l){
      lines.appendChild(ui.el('div', 'lvl', charName(l.memberId) + ' reached Lv ' + l.level + '!'));
    });
    (rw.learned || []).forEach(function(l){
      lines.appendChild(ui.el('div', 'lvl', charName(l.memberId) + ' learned ' + l.name + '!' +
        (l.unequipped ? ' (loadout full)' : '')));
    });
    (rw.drops || []).forEach(function(d){ lines.appendChild(ui.el('div', null, 'Found: ' + d)); });
    card.appendChild(lines);
    var cont = ui.el('button', null, 'Continue');
    cont.addEventListener('click', function(){
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      end('victory');
    });
    card.appendChild(cont);
    veil.appendChild(card);
    root().appendChild(veil);
  }

  function showDefeat(){
    // roguelike §14: the run summary, same as the 2D battle screen
    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card defeat');
    card.appendChild(ui.el('h2', null, 'The Night Wins'));
    var dl = ui.el('div', 'result-lines');
    dl.appendChild(ui.el('div', null, 'The church keeps what it takes...'));
    var st = party.state, topLv = 1;
    (st.members || []).forEach(function(m){ if (m.level > topLv) topLv = m.level; });
    var kills = (st.runStats && st.runStats.kills) || 0;
    dl.appendChild(ui.el('div', 'big', 'Run over — Lv ' + topLv + ' · ◆ ' + (st.shards || 0) +
      ' · ' + kills + (kills === 1 ? ' fight won' : ' fights won')));
    dl.appendChild(ui.el('div', null, 'Every night starts from nothing.'));
    card.appendChild(dl);
    var re = ui.el('button', null, 'Begin again');
    re.addEventListener('click', function(){
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      end('defeat');
    });
    card.appendChild(re);
    veil.appendChild(card);
    root().appendChild(veil);
  }

  function end(result){
    active = false;
    clearTimers();
    hidePrompt(); hidePanel();
    a3d.stop();
    // same funnel as the 2D battle: room3d's wrapper picks this up
    CHLOE.ui.scene.onBattleEnd(result);
  }

  return {
    begin: begin,
    /* test hooks */
    _active: function(){ return active; }
  };
})();
