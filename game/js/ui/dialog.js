/* CHLOE — ui/dialog.js
   Bottom dialog box: typewriter text + portrait. Plays arrays of lines
   ({speaker, text, portrait?}) or a dialogId from CHLOE.data.dialogs. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.dialog = (function(){
  'use strict';
  var ui;
  var lines = [], idx = 0, onDone = null;
  var typing = false, typeTimer = null, fullText = '';
  var active = false;

  function layer(){ return CHLOE.ui.byId('dialog-layer'); }

  function speakerLabel(sp){
    if (!sp) return '';
    var c = (CHLOE.data.characters || {})[String(sp).toLowerCase()];
    if (c) return c.name;
    return sp;
  }
  function portraitKeyFor(line){
    if (line.portrait) return line.portrait;
    var sp = String(line.speaker || '').toLowerCase();
    if (sp === 'chloe' || sp === 'ash') return sp;
    return null;
  }

  /* Play by dialog id (STORY data) or an array of lines. Missing ids warn, never crash. */
  function play(src, done){
    var arr = null;
    if (Array.isArray(src)) {
      arr = src;
    } else if (typeof src === 'string') {
      var dialogs = CHLOE.data.dialogs || {};
      if (dialogs[src]) {
        arr = dialogs[src];
      } else {
        console.warn('[CHLOE] dialog: missing dialog id "' + src + '"');
      }
    }
    if (!arr || !arr.length) {
      if (done) done();
      return;
    }
    lines = arr; idx = 0; onDone = done || null; active = true;
    layer().classList.remove('hidden');
    renderLine();
  }

  function isActive(){ return active; }

  function renderLine(){
    var box = ui.clear(layer());
    var line = lines[idx];
    if (!line) { finish(); return; }

    var dlg = ui.el('div', 'dialog-box');

    var pKey = portraitKeyFor(line);
    if (pKey) {
      var pWrap = ui.el('div', 'dialog-portrait');
      pWrap.appendChild(ui.portraitNode(pKey, speakerLabel(line.speaker)));
      dlg.appendChild(pWrap);
    }

    var main = ui.el('div', 'dialog-main');
    var label = speakerLabel(line.speaker);
    if (label) main.appendChild(ui.el('div', 'dialog-speaker', label));
    var txt = ui.el('div', 'dialog-text', '');
    main.appendChild(txt);
    main.appendChild(ui.el('div', 'dialog-next', '▼'));
    dlg.appendChild(main);
    box.appendChild(dlg);

    // typewriter
    fullText = String(line.text || '');
    typing = true;
    var i = 0;
    var speed = (CHLOE.data.config && CHLOE.data.config.typewriterMs) || 16;
    if (typeTimer) window.clearInterval(typeTimer);
    typeTimer = window.setInterval(function(){
      i++;
      txt.textContent = fullText.slice(0, i);
      if (i >= fullText.length) {
        window.clearInterval(typeTimer);
        typeTimer = null;
        typing = false;
      }
    }, speed);
  }

  function advance(){
    if (!active) return;
    if (typing) {
      // finish the line instantly
      if (typeTimer) { window.clearInterval(typeTimer); typeTimer = null; }
      typing = false;
      var txt = layer().querySelector('.dialog-text');
      if (txt) txt.textContent = fullText;
      return;
    }
    idx++;
    if (idx >= lines.length) finish();
    else renderLine();
  }

  function finish(){
    active = false;
    lines = []; idx = 0;
    if (typeTimer) { window.clearInterval(typeTimer); typeTimer = null; }
    layer().classList.add('hidden');
    ui.clear(layer());
    var cb = onDone; onDone = null;
    if (cb) cb();
  }

  function init(){
    ui = CHLOE.ui;
    layer().addEventListener('click', advance);
    document.addEventListener('keydown', function(e){
      if (!active) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
    });
  }

  return { init: init, play: play, isActive: isActive };
})();
