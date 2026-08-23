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
      CHLOE.ui.account.open();
    });
    inner.appendChild(start);
    root.appendChild(inner);

    var foot = ui.el('div', 'title-foot',
      'The Velvet District after midnight · v' + ((CHLOE.data.config && CHLOE.data.config.version) || 1));
    root.appendChild(foot);
  }

  return { build: build };
})();
