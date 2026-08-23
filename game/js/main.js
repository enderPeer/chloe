/* CHLOE — main.js
   Boot: wire up UI, sanity-check data, show title.
   Flow: title -> account (PIN) -> intro dialog -> scene <-> battle. */
window.CHLOE = window.CHLOE || {};

CHLOE.game = (function(){
  'use strict';

  function story(){ return CHLOE.data.story || null; }

  /* Start a brand-new game for the current account. */
  function startNew(){
    CHLOE.engine.party.newGame();

    var st = story();
    var startScene = st && st.startScene;
    if (!startScene) {
      console.warn('[CHLOE] story data missing or has no startScene — showing fallback scene.');
    }
    // Enter the start scene, then play the intro dialog over it.
    CHLOE.ui.scene.goto(startScene || '__missing__', { skipIntro: !!(st && st.introDialog) });
    CHLOE.engine.save.autosave();
    if (st && st.introDialog) {
      CHLOE.ui.dialog.play(st.introDialog);
    }
  }

  /* Continue from a save blob (local or cloud-merged). */
  function continueFrom(blob){
    var ok = CHLOE.engine.party.applyBlob(blob);
    if (!ok) { startNew(); return; }
    var sceneId = CHLOE.engine.party.state.scene;
    if (!sceneId) {
      var st = story();
      sceneId = (st && st.startScene) || '__missing__';
    }
    CHLOE.ui.scene.goto(sceneId);
    CHLOE.ui.toast('Welcome back, ' + (blob.name || 'stranger') + '.');
  }

  /* ---------- data sanity (warn, never crash) ---------- */
  function sanityCheck(){
    var d = CHLOE.data || {};
    var warn = function(msg){ console.warn('[CHLOE] ' + msg); };
    if (!d.scenes)    warn('data/scenes.js not loaded yet (STORY agent) — scenes will fall back.');
    if (!d.dialogs)   warn('data/story.js dialogs not loaded yet (STORY agent) — dialogs will be skipped.');
    if (!d.story)     warn('data/story.js not loaded yet (STORY agent) — using fallback start.');
    if (!d.portraits) warn('data/portraits.js not loaded yet (STORY agent) — using initial-letter avatars.');

    // cross-reference checks (help catch typos across agents)
    var id, i;
    for (id in (d.characters || {})) {
      var c = d.characters[id];
      if (c.weaponId && !(d.weapons || {})[c.weaponId]) warn('character ' + id + ' has unknown weaponId ' + c.weaponId);
      var byLvl = c.skillsByLevel || {};
      for (var lvl in byLvl) {
        for (i = 0; i < byLvl[lvl].length; i++) {
          if (!(d.skills || {})[byLvl[lvl][i]]) warn('character ' + id + ' references unknown skill ' + byLvl[lvl][i]);
        }
      }
    }
    for (id in (d.enemies || {})) {
      var e = d.enemies[id];
      for (i = 0; i < (e.skills || []).length; i++) {
        if (!(d.skills || {})[e.skills[i]]) warn('enemy ' + id + ' references unknown skill ' + e.skills[i]);
      }
      var drops = (e.rewards && e.rewards.drops) || [];
      for (i = 0; i < drops.length; i++) {
        if (!(d.items || {})[drops[i].itemId]) warn('enemy ' + id + ' drops unknown item ' + drops[i].itemId);
      }
    }
    if (d.scenes && d.story && d.story.startScene && !d.scenes[d.story.startScene]) {
      warn('story.startScene "' + d.story.startScene + '" not found in scenes.');
    }
  }

  /* ---------- boot ---------- */
  function boot(){
    sanityCheck();
    CHLOE.ui.dialog.init();
    CHLOE.ui.title.build();

    // #app must never scroll (overflow:hidden can still be focus-scrolled) —
    // pin it so button focus in cramped viewports can't shift the stage.
    var app = CHLOE.ui.byId('app');
    if (app) {
      app.addEventListener('scroll', function(){
        app.scrollLeft = 0;
        app.scrollTop = 0;
      });
    }

    // Escape closes the menu overlay
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') {
        var menu = CHLOE.ui.byId('overlay-menu');
        if (menu && !menu.classList.contains('hidden')) CHLOE.ui.menu.close();
      }
    });

    CHLOE.ui.show('title');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return {
    startNew: startNew,
    continueFrom: continueFrom
  };
})();
