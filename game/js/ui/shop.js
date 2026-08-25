/* CHLOE — ui/shop.js  (§27D — the giftbox overlay)
   The shop screen: an overlay in the exact house style of the menu overlay
   (same veil, same card, same .menu-body), listing engine/shop.js's stock.
   Rules live in engine/shop.js; this file only draws them and takes the click.

   HOW THE ROOM OPENS IT
   ui/room3d.js is held by another session, so this module publishes the whole
   contract and room3d needs two lines:
       CHLOE.ui.shop.open();                      // on the giftbox click
       // and, in its wire() block, the same close-wrapper it already uses for
       // the menu:
       var origClose = CHLOE.ui.shop.close;
       CHLOE.ui.shop.close = function(){
         var r = origClose.apply(CHLOE.ui.shop, arguments);
         if (ui.current() === 'room3d' && !inBattle) resume();
         return r;
       };

   PAUSE / RESUME — AND THE §22 FREEZE
   §22 froze the room permanently because something closed an overlay by
   calling the module's INNER close function directly; room3d's wrapper — the
   only thing that restarts the render loop — never ran, and the world stayed
   stopped with the pointer unlocked forever. So the rule this file obeys, the
   same one menu.js states above its tab handler:

     EVERY close path in here goes through CHLOE.ui.shop.close() — the live
     public export — never through the local `close` binding.

   The ✕, the Esc key and the backdrop click all do that, so whatever room3d
   wraps around the export is guaranteed to run.

   And because room3d may not have been wired yet (or may be wired by a
   session that lands after this one), close() SELF-RESUMES when — and only
   when — nobody has wrapped it: it compares the live export against its own
   function. Wrapped -> the wrapper owns resume, we keep our hands off.
   Unwrapped -> we resume ourselves rather than leave the player frozen. That
   check is the difference between a defensive fallback and a double-start.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.shop = (function(){
  'use strict';

  var LAYER_ID = 'overlay-shop';

  var ui, shop;
  var wired = false;
  var flashId = null;      // itemId to pulse after a successful buy
  var feedback = null;     // {text, kind} shown under the header
  var feedbackTimer = null;

  /* ---------- the layer ----------
     game/index.html ships #overlay-menu but has no #overlay-shop, and that
     file is not ours this pass — so build the layer on first open, the same
     way ui/battle3d.js conjures its own screen div. Inserted before
     #toast-layer so toasts still land on top of the shop. */
  function layer(){
    var l = document.getElementById(LAYER_ID);
    if (l) return l;
    l = document.createElement('div');
    l.id = LAYER_ID;
    l.className = 'hidden';
    var app = document.getElementById('app');
    if (app) app.insertBefore(l, document.getElementById('toast-layer') || null);
    else document.body.appendChild(l);
    return l;
  }

  function isOpen(){
    var l = document.getElementById(LAYER_ID);
    return !!(l && !l.classList.contains('hidden'));
  }

  /* ---------- world pause/resume ----------
     room3d keeps pause()/resume() private and exports them as _pause/_resume
     "for tests/debugging". They are the only handles that exist from out here
     and the file is embargoed, so we use them — and fall back to stopping the
     world directly if room3d is absent (the shop can be opened from a test
     harness with no room around it). */
  function room(){ return CHLOE.ui.room3d; }

  function pauseWorld(){
    var r = room();
    if (r && typeof r._pause === 'function') { try { r._pause(); } catch (e) {} return; }
    var w = CHLOE.engine && CHLOE.engine.world3d;
    if (w && typeof w.stop === 'function') { try { w.stop(); } catch (e) {} }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  }

  function resumeWorld(){
    if (!ui || ui.current() !== 'room3d') return;   // router moved on; not ours to restart
    var r = room();
    if (r && typeof r._resume === 'function') { try { r._resume(); } catch (e) {} }
  }

  /* Has someone wrapped our public close? See the header comment. */
  function closeIsWrapped(){
    return !!(CHLOE.ui.shop && CHLOE.ui.shop.close !== close);
  }

  /* ---------- open / close ---------- */
  function open(){
    ui = CHLOE.ui;
    shop = CHLOE.engine.shop;
    if (!shop) { if (ui && ui.toast) ui.toast('The box is nailed shut.'); return; }
    if (isOpen()) return;

    /* Stop the room before the overlay paints, exactly as room3d.openMenu
       does — a running render loop behind a modal keeps eating the mouse. */
    pauseWorld();

    flashId = null;
    setFeedback(null);
    render();
    layer().classList.remove('hidden');
    wire();
  }

  function close(){
    var l = document.getElementById(LAYER_ID);
    if (!l) return;
    l.classList.add('hidden');
    if (ui && ui.clear) ui.clear(l); else l.innerHTML = '';
    clearFeedbackTimer();
    flashId = null;
    /* Only when nobody wrapped us — otherwise the wrapper resumes and calling
       it here too would start the loop twice. */
    if (!closeIsWrapped()) resumeWorld();
  }

  /* ---------- input ---------- */
  function wire(){
    if (wired) return;
    wired = true;

    /* CAPTURE phase on purpose. room3d listens for M / Tab on document in the
       bubble phase and has no idea this overlay exists (its guard only knows
       #overlay-menu), so a bubble-phase listener here could not stop it
       opening the menu on top of the shop. Capture runs first, which is what
       makes stopPropagation actually mean something. */
    document.addEventListener('keydown', function(e){
      if (!isOpen()) return;
      var k = e.key;
      if (k === 'Escape' || k === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        CHLOE.ui.shop.close();   // public export — see header
        return;
      }
      /* Swallow the room's roaming keys while the counter is open so nothing
         moves, opens or fires behind the card. */
      if (k === 'm' || k === 'M' || k === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* ---------- render ---------- */
  function render(){
    var l = ui.clear(layer());

    /* Clicking the veil beside the card closes too. Guarded on target === l so
       a click that started inside the card (a mis-aimed Buy, a drag over a
       row) can never fall through and shut the shop under the player. */
    l.onclick = function(e){ if (e.target === l) CHLOE.ui.shop.close(); };

    var card = ui.el('div', 'menu-card shop-card');

    card.appendChild(buildHead());

    var body = ui.el('div', 'menu-body shop-body');
    if (feedback) {
      body.appendChild(ui.el('div', 'shop-feedback ' + (feedback.kind || ''), feedback.text));
    }

    var rows = shop.stock();
    if (!rows.length) {
      body.appendChild(ui.el('div', 'inv-empty', 'The box is empty tonight. Come back bleeding.'));
    } else {
      for (var i = 0; i < rows.length; i++) body.appendChild(buildRow(rows[i]));
    }
    card.appendChild(body);

    card.appendChild(ui.el('div', 'shop-foot',
      'Shards are yours until the run ends — death spends them all. Esc closes.'));

    l.appendChild(card);
  }

  function buildHead(){
    var head = ui.el('div', 'shop-head');
    head.appendChild(ui.el('div', 'shop-title', 'The Giftbox'));

    /* The balance is the number the player is actually doing arithmetic with,
       so it sits in the header where it cannot scroll away, and it is
       re-read from the engine on every repaint rather than cached. */
    var bal = ui.el('div', 'shop-balance');
    bal.appendChild(ui.el('span', 'sym', '◆'));
    bal.appendChild(ui.el('b', null, String(shop.shards())));
    head.appendChild(bal);

    var x = ui.el('button', 'shop-close', '✕');
    x.title = 'Close (Esc)';
    // NOTE: the public export — ui/room3d.js wraps CHLOE.ui.shop.close() to
    // resume the 3D world. Calling the local close() here would reproduce the
    // §22 freeze exactly.
    x.addEventListener('click', function(){ CHLOE.ui.shop.close(); });
    head.appendChild(x);
    return head;
  }

  function buildRow(r){
    var row = ui.el('div', 'shop-row' + (r.affordable ? '' : ' poor') +
                           (flashId === r.id ? ' bought' : ''));
    row.appendChild(ui.el('div', 'shop-icon', r.icon));

    var main = ui.el('div', 'shop-main');
    main.appendChild(ui.el('div', 'nm', r.name));
    main.appendChild(ui.el('div', 'fx', effectText(r.def)));
    if (r.desc) main.appendChild(ui.el('div', 'ds', r.desc));
    row.appendChild(main);

    var right = ui.el('div', 'shop-right');
    var price = ui.el('div', 'shop-price');
    price.appendChild(ui.el('span', 'sym', '◆'));
    price.appendChild(ui.el('b', null, String(r.price)));
    right.appendChild(price);

    /* Say WHY it is dim. "Need ◆ 7 more" is a plan; a greyed-out button is a
       shrug, and the player cannot tell it from a sold-out row. */
    if (!r.affordable) right.appendChild(ui.el('div', 'shop-short', 'need ◆ ' + r.shortfall + ' more'));
    right.appendChild(ui.el('div', 'shop-have', r.count ? 'carrying ' + r.count : 'carrying none'));
    row.appendChild(right);

    var buy = ui.el('button', 'shop-buy', 'Buy');
    buy.disabled = !r.affordable;
    buy.addEventListener('click', function(){ doBuy(r.id); });
    row.appendChild(buy);

    return row;
  }

  /* A one-line reading of effect{}, so the shelf states what the thing DOES
     without making the player parse flavour text. Derived from the effect
     object rather than a per-item string: a new potion gets a correct line for
     free, the same way engine/shop.js gets it a shelf slot for free. */
  function effectText(def){
    var eff = (def && def.effect) || {}, bits = [];
    if (eff.hp) bits.push('+' + eff.hp + ' Life');
    if (eff.mp) bits.push('+' + eff.mp + ' Magic');
    if (eff.sta) bits.push('+' + eff.sta + ' Stamina');
    if (eff.revivePct) bits.push('Back up at ' + eff.revivePct + '% Life');
    if (eff.cure && eff.cure.length) bits.push('Cures ' + eff.cure.map(prettyStatus).join(', '));
    return bits.length ? bits.join(' · ') : '—';
  }

  /* §12 status ids have no label table anywhere in data/, so prettify them
     here rather than inventing one this pass — a shop row is not the right
     place to define the game's status vocabulary. */
  function prettyStatus(id){
    var s = String(id).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---------- buying ---------- */
  function doBuy(id){
    var res = shop.buy(id);
    var def = (CHLOE.data.items || {})[id] || {};
    var name = def.name || id;

    if (res.ok) {
      flashId = id;
      setFeedback(name + ' — bought for ◆ ' + res.price + '. Carrying ' + res.count + '.', 'good');
    } else if (res.reason === 'poor') {
      flashId = null;
      setFeedback('Not enough shards for ' + name + ' — ◆ ' + res.shortfall + ' short.', 'bad');
    } else {
      flashId = null;
      setFeedback('The box refuses ' + name + '.', 'bad');
    }
    /* Full repaint: the balance, every row's affordability and the carried
       count all moved off one purchase, and re-reading the engine is the only
       way they cannot drift apart. */
    render();
  }

  function setFeedback(text, kind){
    clearFeedbackTimer();
    feedback = text ? { text: text, kind: kind } : null;
    if (!text) return;
    feedbackTimer = window.setTimeout(function(){
      feedbackTimer = null;
      feedback = null;
      flashId = null;
      if (isOpen()) render();
    }, 2600);
  }

  function clearFeedbackTimer(){
    if (feedbackTimer) { window.clearTimeout(feedbackTimer); feedbackTimer = null; }
    feedback = null;
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
