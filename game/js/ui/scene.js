/* CHLOE — ui/scene.js
   Point-and-click scene screen: full-bleed bg, % positioned hotspots with
   a pulsing red glint marker (items must READ as items — spec sec 11),
   stronger outline + label on hover/tap, HUD (shards + menu), intro dialog
   on first visit. Missing scenes/dialogs log a warning and render a safe
   fallback — no crashes. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.scene = (function(){
  'use strict';
  var ui, party;
  var currentId = null;
  var pendingBattleAction = null; // hotspot action that started the current battle

  function root(){ return CHLOE.ui.byId('screen-scene'); }
  function scenes(){ return CHLOE.data.scenes || {}; }

  function usedFlag(sceneId, index){ return '_used.' + sceneId + '.' + index; }
  function seenFlag(sceneId){ return '_seen.' + sceneId; }

  function flagOk(req){
    if (!req) return true;
    if (typeof req === 'string' && req.charAt(0) === '!') return !party.getFlag(req.slice(1));
    return party.getFlag(req);
  }

  /* ---------- entry ---------- */
  function goto(sceneId, opts){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    var sc = scenes()[sceneId];
    if (!sc) {
      console.warn('[CHLOE] scene: missing scene id "' + sceneId + '"');
      renderFallback(sceneId);
      ui.show('scene');
      return;
    }
    currentId = sceneId;
    party.state.scene = sceneId;
    render(sc);
    ui.show('scene');

    // first-visit intro
    if (sc.intro && !party.getFlag(seenFlag(sceneId)) && !(opts && opts.skipIntro)) {
      party.setFlag(seenFlag(sceneId));
      playIntro(sc.intro);
    }
  }

  function playIntro(intro){
    var dlg = CHLOE.ui.dialog;
    if (Array.isArray(intro)) { dlg.play(intro); return; }
    if (typeof intro === 'string') {
      if ((CHLOE.data.dialogs || {})[intro]) dlg.play(intro);
      else dlg.play([{ speaker: '', text: intro }]); // plain narration string
    }
  }

  function refresh(){
    if (!currentId) return;
    var sc = scenes()[currentId];
    if (sc) render(sc);
    else renderFallback(currentId);
  }

  /* ---------- rendering ---------- */
  function renderHud(container){
    var hud = ui.el('div', 'hud');
    var shards = ui.el('div', 'hud-shards', '◆ ' + party.state.shards);
    hud.appendChild(shards);
    var right = ui.el('div', 'hud-right');
    var menuBtn = ui.el('button', null, '☰ Menu');
    menuBtn.addEventListener('click', function(){ CHLOE.ui.menu.open(); });
    right.appendChild(menuBtn);
    hud.appendChild(right);
    container.appendChild(hud);
  }

  function render(sc){
    var r = ui.clear(root());
    var stage = ui.el('div', 'scene-stage');
    var box = ui.el('div', 'scene-imgbox');

    var fallbackBg = ui.el('div', 'scene-bg-fallback');
    box.appendChild(fallbackBg);
    if (sc.bg) {
      var img = document.createElement('img');
      img.className = 'scene-bg';
      img.alt = sc.name || sc.id;
      img.onerror = function(){ if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = sc.bg;
      box.appendChild(img);
    }

    if (sc.name) box.appendChild(ui.el('div', 'scene-name', sc.name));

    var hotspots = sc.hotspots || [];
    for (var i = 0; i < hotspots.length; i++) {
      var hs = hotspots[i];
      var action = hs.action || {};
      if (!flagOk(action.requiresFlag)) continue;
      if (action.once && party.getFlag(usedFlag(sc.id || currentId, i))) continue;
      box.appendChild(makeHotspot(sc, hs, i));
    }

    stage.appendChild(box);
    r.appendChild(stage);
    renderHud(r);
  }

  function makeHotspot(sc, hs, index){
    var d = ui.el('div', 'hotspot');
    d.style.left = (hs.x || 0) + '%';
    d.style.top = (hs.y || 0) + '%';
    d.style.width = (hs.w || 10) + '%';
    d.style.height = (hs.h || 10) + '%';
    // pulsing red glint marker so interactables read as items
    var glint = ui.el('span', 'hs-glint');
    glint.appendChild(ui.el('i'));
    d.appendChild(glint);
    if (hs.label) d.appendChild(ui.el('div', 'hs-label', hs.label));
    // stronger outline + label on tap (touch devices don't hover)
    var touchTimer = null;
    d.addEventListener('touchstart', function(){
      d.classList.add('hs-touch');
      if (touchTimer) window.clearTimeout(touchTimer);
      touchTimer = window.setTimeout(function(){ d.classList.remove('hs-touch'); }, 1500);
    }, { passive: true });
    d.addEventListener('click', function(){
      if (CHLOE.ui.dialog.isActive()) return; // let the dialog finish first
      runAction(sc, hs.action || {}, index);
    });
    return d;
  }

  function renderFallback(sceneId){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    var r = ui.clear(root());
    var stage = ui.el('div', 'scene-stage');
    var box = ui.el('div', 'scene-imgbox');
    box.appendChild(ui.el('div', 'scene-bg-fallback'));
    var name = ui.el('div', 'scene-name', 'Somewhere in the dark');
    name.style.animation = 'none';
    name.style.opacity = '.8';
    box.appendChild(name);
    stage.appendChild(box);
    r.appendChild(stage);
    renderHud(r);
    console.warn('[CHLOE] rendered fallback scene for "' + sceneId + '" (story data missing?)');
  }

  /* ---------- actions ---------- */
  function completeAction(sc, action, index){
    if (action.setsFlag) party.setFlag(action.setsFlag);
    if (action.once) party.setFlag(usedFlag(sc.id || currentId, index));
    refresh();
  }

  function runAction(sc, action, index){
    var type = action.type;
    if (type === 'goto') {
      if (action.setsFlag) party.setFlag(action.setsFlag);
      if (action.once) party.setFlag(usedFlag(sc.id || currentId, index));
      if (action.scene) goto(action.scene);
      else console.warn('[CHLOE] goto action without scene', action);
      return;
    }
    if (type === 'dialog' || type === 'story') {
      var id = action.dialogId || action.storyId;
      CHLOE.ui.dialog.play(id, function(){
        completeAction(sc, action, index);
      });
      return;
    }
    if (type === 'battle') {
      if (!action.enemyId || !(CHLOE.data.enemies || {})[action.enemyId]) {
        console.warn('[CHLOE] battle action with unknown enemy', action);
        return;
      }
      pendingBattleAction = { sceneId: sc.id || currentId, action: action, index: index };
      CHLOE.ui.battle.begin(action.enemyId, { boss: !!action.boss });
      return;
    }
    if (type === 'pickup') {
      var item = (CHLOE.data.items || {})[action.itemId];
      if (item) {
        CHLOE.engine.inventory.add(item.id, 1);
        ui.toast('Picked up: ' + (item.icon ? item.icon + ' ' : '') + item.name);
      } else {
        console.warn('[CHLOE] pickup action with unknown item', action);
      }
      completeAction(sc, action, index);
      return;
    }
    if (type === 'heal') {
      party.fullHeal();
      ui.toast('The band catches its breath. Fully rested.');
      completeAction(sc, action, index);
      return;
    }
    console.warn('[CHLOE] unknown hotspot action type "' + type + '"', action);
  }

  /* Called by battle UI when a battle finishes. May run before goto() ever
     did (battles can start without the 2D scene screen) — init refs here. */
  function onBattleEnd(result){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    var ctx = pendingBattleAction;
    pendingBattleAction = null;

    if (result === 'defeat') {
      // roguelike (spec §14): death ends the run — a fresh one begins
      currentId = null;
      CHLOE.game.startNew();
      ui.toast('The night resets. Everything is gone.');
      return;
    }

    // victory or fled: return to the scene we came from
    if (result === 'victory' && ctx) {
      var sc = scenes()[ctx.sceneId];
      if (sc) {
        if (ctx.action.setsFlag) party.setFlag(ctx.action.setsFlag);
        if (ctx.action.once) party.setFlag(usedFlag(ctx.sceneId, ctx.index));
      }
    }
    refresh();
    ui.show('scene');

    if (result === 'victory') {
      // first-ever victory dialog
      var story = CHLOE.data.story;
      if (story && story.onFirstVictoryDialog && !party.getFlag('_firstVictoryShown')) {
        party.setFlag('_firstVictoryShown');
        CHLOE.ui.dialog.play(story.onFirstVictoryDialog);
      }
    }
  }

  function currentSceneId(){ return currentId; }

  return {
    goto: goto,
    refresh: refresh,
    onBattleEnd: onBattleEnd,
    currentSceneId: currentSceneId
  };
})();
