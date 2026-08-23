/* CHLOE — ui/ui.js
   Screen router + shared DOM helpers, toasts, portrait resolution. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

(function(ui){
  'use strict';

  var currentScreen = null;

  /* ---------- tiny DOM helpers ---------- */
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node){
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function byId(id){ return document.getElementById(id); }

  /* ---------- router ---------- */
  function show(name){
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    var target = byId('screen-' + name);
    if (!target) {
      console.warn('[CHLOE] ui.show: no screen "' + name + '"');
      return;
    }
    currentScreen = name;
    target.classList.add('active');
    if (ui._onShow && ui._onShow[name]) {
      try { ui._onShow[name](); } catch(e){ console.warn('[CHLOE] onShow handler failed for ' + name, e); }
    }
  }
  function onShow(name, fn){
    ui._onShow = ui._onShow || {};
    ui._onShow[name] = fn;
  }
  function current(){ return currentScreen; }

  /* ---------- portraits (STORY-agent data, resolved at use) ---------- */
  function portraitSrc(key){
    var p = CHLOE.data.portraits;
    if (p && typeof p[key] === 'string' && p[key]) return p[key];
    return null;
  }
  /* Returns a node: <img> with silhouette fallback, or a styled initial avatar. */
  function portraitNode(key, label){
    var src = portraitSrc(key);
    var initial = (label || key || '?').charAt(0).toUpperCase();
    if (!src) {
      return el('div', 'avatar-fallback', initial);
    }
    var img = document.createElement('img');
    img.alt = label || key;
    img.onerror = function(){
      var fb = el('div', 'avatar-fallback', initial);
      if (img.parentNode) img.parentNode.replaceChild(fb, img);
    };
    img.src = src;
    return img;
  }

  /* Enemy image with a styled silhouette div fallback on load error. */
  function enemyImageNode(enemyDef){
    var wrap = el('div', 'enemy-imgbox');
    var sil = el('div', 'enemy-silhouette hidden');
    var eyes = el('div', 'sil-eyes');
    eyes.appendChild(el('i'));
    eyes.appendChild(el('i'));
    sil.appendChild(eyes);
    var img = document.createElement('img');
    img.alt = enemyDef.name || 'enemy';
    img.onerror = function(){
      img.classList.add('hidden');
      sil.classList.remove('hidden');
    };
    img.src = enemyDef.image || '';
    if (!enemyDef.image) { img.classList.add('hidden'); sil.classList.remove('hidden'); }
    wrap.appendChild(img);
    wrap.appendChild(sil);
    return wrap;
  }

  /* ---------- bars ---------- */
  function makeBar(cls){
    var bar = el('div', 'bar ' + (cls || ''));
    var fill = el('div', 'fill');
    bar.appendChild(fill);
    bar._fill = fill;
    return bar;
  }
  function setBar(bar, val, max){
    if (!bar || !bar._fill) return;
    var pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
    bar._fill.style.width = pct + '%';
    if (bar.className.indexOf('mp') === -1) {
      bar.classList.remove('hp-ok', 'hp-warn');
      if (pct > 55) bar.classList.add('hp-ok');
      else if (pct > 25) bar.classList.add('hp-warn');
    }
  }

  /* ---------- toasts ---------- */
  function toast(text, ms){
    var layer = byId('toast-layer');
    if (!layer) return;
    var t = el('div', 'toast', text);
    layer.appendChild(t);
    window.setTimeout(function(){
      t.classList.add('out');
      window.setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 420);
    }, ms || 2400);
  }

  ui.el = el;
  ui.clear = clear;
  ui.byId = byId;
  ui.show = show;
  ui.onShow = onShow;
  ui.current = current;
  ui.portraitSrc = portraitSrc;
  ui.portraitNode = portraitNode;
  ui.enemyImageNode = enemyImageNode;
  ui.makeBar = makeBar;
  ui.setBar = setBar;
  ui.toast = toast;
})(CHLOE.ui);
