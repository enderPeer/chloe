/* CHLOE — ui/battleui.js
   Battle screen: enemy image top/right, party portrait + HP/MP bars,
   command buttons, scrolling log, damage pop numbers, screen shake. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.battle = (function(){
  'use strict';
  var ui, party, engine;
  var els = {};        // live node refs
  var playing = false; // event playback lock
  var STEP_MS = 520;

  function root(){ return CHLOE.ui.byId('screen-battle'); }

  /* ---------- entry ---------- */
  function begin(enemyId, opts){
    ui = CHLOE.ui; party = CHLOE.engine.party; engine = CHLOE.engine.battle;
    var st = engine.start(enemyId, opts);
    if (!st) {
      ui.toast('Something stirs... then nothing. (missing enemy data)');
      return;
    }
    build(st);
    ui.show('battle');
    logLine(st.enemyDef.name + ' blocks the way!', 'sys');
    if (st.boss) logLine('The exits are gone.', 'sys');
  }

  /* ---------- build ---------- */
  function build(st){
    var r = ui.clear(root());
    els = {};

    // top: enemy
    var top = ui.el('div', 'battle-top');
    var wrap = ui.el('div', 'enemy-wrap');
    els.enemyBox = ui.enemyImageNode(st.enemyDef); // <img> with silhouette fallback inside
    wrap.appendChild(els.enemyBox);
    var nm = ui.el('div', 'enemy-name', st.enemyDef.name);
    var lv = ui.el('span', 'lv', 'Lv ' + (st.enemyDef.level || 1) + (st.boss ? ' · BOSS' : ''));
    nm.appendChild(lv);
    wrap.appendChild(nm);
    els.enemyHp = ui.makeBar('');
    els.enemyHp.classList.add('enemy-hpbar');
    ui.setBar(els.enemyHp, st.enemy.hp, st.enemy.maxHp);
    wrap.appendChild(els.enemyHp);
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

    els.hpBar = ui.makeBar('');
    ui.setBar(els.hpBar, m.hp, eff.maxHp);
    info.appendChild(els.hpBar);
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

  /* ---------- command menus ---------- */
  function renderCommands(){
    var st = engine.state();
    var panel = ui.clear(els.cmdPanel);
    if (!st || st.over) return;

    var mk = function(label, fn, disabled){
      var b = ui.el('button', null, label);
      if (disabled) b.disabled = true;
      b.addEventListener('click', function(){ if (!playing) fn(); });
      panel.appendChild(b);
      return b;
    };
    mk('Attack', function(){ doAction({ type: 'attack' }); });
    mk('Skills', renderSkillMenu);
    mk('Items', renderItemMenu);
    mk('Switch', renderSwitchMenu, party.aliveMembers().length < 2);
    if (!st.boss) mk('Give Up', function(){ doAction({ type: 'giveup' }); });
  }

  function subHeader(panel, title){
    panel.appendChild(ui.el('div', 'cmd-title', title));
  }
  function backBtn(panel){
    var b = ui.el('button', null, '‹ Back');
    b.addEventListener('click', renderCommands);
    panel.appendChild(b);
  }

  function renderSkillMenu(){
    var panel = ui.clear(els.cmdPanel);
    subHeader(panel, 'Skills');
    var m = party.active();
    var list = ui.el('div', 'cmd-list');
    var ids = m ? party.skillsOf(m) : [];
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      (function(sk){
        if (!sk) return;
        any = true;
        var b = ui.el('button');
        var left = ui.el('span', null, sk.name);
        var cost = ui.el('span', 'cost' + (sk.mpCost ? '' : ' free'), sk.mpCost ? sk.mpCost + ' MP' : '—');
        b.appendChild(left);
        b.appendChild(cost);
        b.title = sk.desc || '';
        if (m.mp < (sk.mpCost || 0)) b.disabled = true;
        b.addEventListener('click', function(){ if (!playing) doAction({ type: 'skill', id: sk.id }); });
        list.appendChild(b);
      })((CHLOE.data.skills || {})[ids[i]]);
    }
    if (!any) list.appendChild(ui.el('div', 'menu-note', 'No skills yet.'));
    panel.appendChild(list);
    backBtn(panel);
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

      var targetId = null;
      if (def.effect && def.effect.revivePct) {
        var fallen = party.state.members.filter(function(mm){ return mm.hp <= 0; });
        if (!fallen.length) b.disabled = true;
        else targetId = fallen[0].id;
      } else {
        var m = party.active();
        targetId = m ? m.id : null;
      }
      b.addEventListener('click', function(){
        if (!playing) doAction({ type: 'item', id: def.id, targetId: targetId });
      });
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
      b.addEventListener('click', function(){ if (!playing) doAction({ type: 'switch', id: m.id }); });
      list.appendChild(b);
    });
    panel.appendChild(list);
    backBtn(panel);
  }

  /* ---------- action -> event playback ---------- */
  function doAction(action){
    if (playing || engine.isOver()) return;
    var events = engine.act(action);
    if (!events.length) return;
    playing = true;
    ui.clear(els.cmdPanel); // lock commands during playback
    playEvents(events, 0);
  }

  function playEvents(events, i){
    if (i >= events.length) {
      playing = false;
      renderMember();
      renderCommands();
      return;
    }
    var ev = events[i];
    var delay = handleEvent(ev);
    window.setTimeout(function(){ playEvents(events, i + 1); }, delay);
  }

  function handleEvent(ev){
    switch (ev.t) {
      case 'log':
        logLine(ev.text, ev.cls);
        return 260;

      case 'mp':
        refreshBars();
        return 120;

      case 'dmg':
        if (ev.side === 'enemy') {
          ui.setBar(els.enemyHp, ev.hpAfter, ev.maxHp);
          popNumber(els.enemyBox, '-' + ev.amount, ev.mult > 1 ? 'weak' : (ev.mult < 1 ? 'resist' : ''));
          flash(els.enemyBox, 'enemy-hit');
          if (ev.hpAfter <= 0) els.enemyWrap.classList.add('enemy-dead');
        } else {
          refreshBars();
          popNumber(els.portrait || els.memberPanel, '-' + ev.amount, ev.mult > 1 ? 'weak' : '');
          flash(els.memberPanel, 'member-hit');
          shake();
        }
        return STEP_MS;

      case 'heal': {
        var activeId = party.state.activeId;
        refreshBars();
        if (ev.memberId === activeId && els.portrait) {
          popNumber(els.portrait, '+' + ev.amount, ev.kind === 'mp' ? 'mp' : 'heal');
        }
        return STEP_MS;
      }

      case 'switch':
        renderMember();
        refreshBars();
        return 380;

      case 'ko':
        return 300;

      case 'end':
        window.setTimeout(function(){ showEnd(ev); }, 500);
        return 600;

      default:
        return 100;
    }
  }

  /* ---------- fx ---------- */
  function logLine(text, cls){
    if (!els.log) return;
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

  /* ---------- end panels ---------- */
  function showEnd(ev){
    playing = false;
    // autosave on battle end (scene.onBattleEnd saves again after flags/respawn)
    if (CHLOE.engine.save.getCurrent()) CHLOE.engine.save.autosave();

    if (ev.result === 'fled') {
      CHLOE.ui.scene.onBattleEnd('fled');
      return;
    }

    var veil = ui.el('div', 'battle-panel-veil');
    var card = ui.el('div', 'result-card' + (ev.result === 'defeat' ? ' defeat' : ''));

    if (ev.result === 'victory') {
      card.appendChild(ui.el('h2', null, 'Encore!'));
      var lines = ui.el('div', 'result-lines');
      var rw = ev.rewards || {};
      lines.appendChild(ui.el('div', 'big', '+' + (rw.xp || 0) + ' XP · +' + (rw.shards || 0) + ' ◆'));
      (rw.levelUps || []).forEach(function(l){
        var def = (CHLOE.data.characters || {})[l.memberId] || {};
        lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' reached Lv ' + l.level + '!'));
      });
      (rw.learned || []).forEach(function(l){
        var def = (CHLOE.data.characters || {})[l.memberId] || {};
        lines.appendChild(ui.el('div', 'lvl', (def.name || l.memberId) + ' learned ' + l.skill + '!'));
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
