/* CHLOE — ui/title.js */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.title = (function(){
  'use strict';
  var ui;

  function build(){
    ui = CHLOE.ui;
    var root = ui.byId('screen-title');
    ui.clear(root);

    var bg = ui.el('div', 'title-bg');
    bg.style.backgroundImage = "url('assets/chloe/Chloe001.jpg')";
    root.appendChild(bg);

    var inner = ui.el('div', 'title-inner');
    inner.appendChild(ui.el('div', 'title-logo', 'CHLOE'));
    inner.appendChild(ui.el('div', 'title-sub', 'The Backstage Between'));

    var start = ui.el('button', 'title-start', 'Press Start');
    start.addEventListener('click', function(){
      // roguelike (spec sec 14): no accounts — straight into a fresh run
      CHLOE.game.startNew();
    });
    inner.appendChild(start);
    root.appendChild(inner);

    /* Patch notes: shown until the player has started at least one run, then
       hidden for subsequent visits so the title stays clean. */
    var started = false;
    try { started = sessionStorage.getItem('chloe.started'); } catch (e) {}
    if (!started) {
      var notes = ui.el('div', 'title-notes');
      notes.innerHTML =
        '<b>v0.31.4 — Fluidity</b>' +
        '<ul>' +
        '<li>Tornado fragment shaders are now pre-compiled during the loading gate — the first cast no longer pays a GPU stall.</li>' +
        '<li>VFX assets (tornado, asteroid, hand sign) are fetched while you walk the room, so the loading bar fills faster.</li>' +
        '<li>Per-frame material writes are skipped when opacity has not changed.</li>' +
        '<li>CSS compositor layers are pre-promoted for the grain overlay and screen shake.</li>' +
        '</ul>';
      root.appendChild(notes);
    }

    var foot = ui.el('div', 'title-foot',
      'The Velvet District after midnight · ' +
      /* from data/version.js, bumped on every push by tools/hooks/pre-commit */
      (CHLOE.data.version ? CHLOE.data.version.full() : 'v?'));
    root.appendChild(foot);
  }

  return { build: build };
})();
