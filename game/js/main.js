/* CHLOE — main.js
   Boot: wire up UI, sanity-check data, show title.
   Flow (roguelike mode, spec sec 15): title -> fresh run in the 3D room <-> battle.
   No accounts, no saves: every page load starts clean, and death starts a
   brand-new run. The 2D scene flow below stays as a fallback but is no longer
   routed. */
window.CHLOE = window.CHLOE || {};

CHLOE.game = (function(){
  'use strict';

  function story(){ return CHLOE.data.story || null; }

  /* Room3D mode (spec sec 13): the run happens in the first-person room —
     no intro dialog, no 2D scene routing. */
  function room3dAvailable(){
    return !!(CHLOE.ui.room3d && typeof CHLOE.ui.room3d.enter === 'function');
  }
  function enterRoom3d(){
    CHLOE.engine.party.state.scene = 'room3d';
    CHLOE.ui.room3d.enter();
  }

  /* Start a fresh run (spec sec 15). Called from the title screen on page
     load AND from the defeat panel after death — both land on a clean
     level-1 solo Chloe with nothing carried over. */
  function startNew(){
    CHLOE.engine.party.newGame();
    try { sessionStorage.setItem('chloe.started', '1'); } catch (e) {}
    /* §27E: the run clock starts HERE, next to newGame(), because this is the
       one function both entry points go through — the title screen on load and
       "Begin again" on the defeat panel. engine/records.js falls back to
       time-since-page-load when nobody calls start(), which reads correctly for
       the first run of a page and silently bills the second run for the first
       one's minutes; this is the line that stops that. Guarded because a build
       without engine/records.js must still start a run. */
    var rec = CHLOE.engine.records;
    if (rec && typeof rec.start === 'function') { rec.start(); }

    if (room3dAvailable()) { enterRoom3d(); return; }

    // legacy 2D flow (unrouted fallback — kept working, spec sec 13)
    var st = story();
    var startScene = st && st.startScene;
    if (!startScene) {
      console.warn('[CHLOE] story data missing or has no startScene — showing fallback scene.');
    }
    // Enter the start scene, then play the intro dialog over it.
    CHLOE.ui.scene.goto(startScene || '__missing__', { skipIntro: !!(st && st.introDialog) });
    if (st && st.introDialog) {
      CHLOE.ui.dialog.play(st.introDialog);
    }
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
    startNew: startNew
  };
})();
