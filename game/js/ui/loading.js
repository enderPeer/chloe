/* CHLOE — ui/loading.js  (spec §21)
   A loading gate for the 3D scenes.

   Why this exists: the church is 26MB and the knight 6.6MB, and both used to
   stream in AFTER the fight had already started — you spawned into an empty
   grey void while the knight walked at you out of nothing, and the first cast
   of any spell stalled for several frames while its shader compiled. Nothing
   should move until the scene is actually there.

   So: show(), let the scene report progress, and only start the simulation on
   done(). The engines also warm their shaders before reporting ready, which is
   what removes the hitch on the first Fire Tornado.

   Pure DOM, no THREE. Deliberately cheap to draw — it is on screen precisely
   when the GPU and main thread are busy with something else. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.loading = (function () {
  'use strict';

  var el = null, bar = null, label = null, tip = null, veil = null;
  var shown = false, tipTimer = 0, tipIndex = 0;

  /* Shown while you wait, so the wait says something about the game. */
  var TIPS = [
    'The fight is real time. Nothing waits for your turn.',
    'Watch his arms — the sword going up means the overhead is coming.',
    'SPACE throws you clear and makes you briefly untouchable.',
    'Crouch under a wide slash. Sidestep an overhead.',
    'Every level hands you its row. There is nothing to spend.',
    'Round N brings N Hollow Knights. They do not come alone for long.',
    'Nothing is saved. Ever. Make the night count.'
  ];

  function build() {
    var d = document;
    veil = d.createElement('div');
    veil.className = 'loading-veil';

    var card = d.createElement('div');
    card.className = 'loading-card';

    var title = d.createElement('div');
    title.className = 'loading-title';
    title.textContent = 'CHLOE';
    card.appendChild(title);

    label = d.createElement('div');
    label.className = 'loading-label';
    label.textContent = 'Opening the doors…';
    card.appendChild(label);

    var track = d.createElement('div');
    track.className = 'loading-track';
    bar = d.createElement('div');
    bar.className = 'loading-bar';
    track.appendChild(bar);
    card.appendChild(track);

    /* Three drifting embers. CSS-only: a canvas or rAF loop here would be
       competing for the very frames we are waiting on. */
    var em = d.createElement('div');
    em.className = 'loading-embers';
    for (var i = 0; i < 3; i++) {
      var s = d.createElement('span');
      s.style.animationDelay = (i * 0.55) + 's';
      em.appendChild(s);
    }
    card.appendChild(em);

    tip = d.createElement('div');
    tip.className = 'loading-tip';
    card.appendChild(tip);

    veil.appendChild(card);
    el = veil;
  }

  function nextTip() {
    if (!tip) return;
    tip.textContent = TIPS[tipIndex % TIPS.length];
    tipIndex++;
  }

  function show(what) {
    if (!el) build();
    if (label) label.textContent = what || 'Opening the doors…';
    if (bar) bar.style.width = '0%';
    tipIndex = Math.floor(Math.random() * TIPS.length);
    nextTip();
    if (tipTimer) window.clearInterval(tipTimer);
    tipTimer = window.setInterval(nextTip, 3200);
    if (!shown) {
      document.body.appendChild(el);
      shown = true;
    }
    el.classList.remove('out');
  }

  /* done/total drives the bar; `what` relabels it. Safe to call every frame. */
  function progress(done, total, what) {
    if (!shown) return;
    var pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    if (bar) bar.style.width = Math.round(pct * 100) + '%';
    if (what && label) label.textContent = what;
  }

  function hide() {
    if (!shown || !el) return;
    if (tipTimer) { window.clearInterval(tipTimer); tipTimer = 0; }
    if (bar) bar.style.width = '100%';
    el.classList.add('out');
    // let the fade finish before pulling it out of the tree
    window.setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      shown = false;
    }, 320);
  }

  function isShown() { return shown; }

  /* Poll `test()` until it returns true, then call done(). Used by the room
     and the arena to wait on their own asset counters without either of them
     needing to know how the overlay works.
     `tick(setProgress)` is called each poll so the caller can drive the bar. */
  function waitFor(test, tick, done, timeoutMs) {
    var t0 = Date.now();
    var limit = timeoutMs || 25000;
    var iv = window.setInterval(function () {
      var late = Date.now() - t0 > limit;
      if (tick) { try { tick(progress); } catch (e) {} }
      if (!test() && !late) return;
      window.clearInterval(iv);
      if (late) console.warn('[loading] gave up waiting after ' + limit + 'ms — starting anyway');
      done(!late);
    }, 80);
    return function cancel() { window.clearInterval(iv); };
  }

  return { show: show, hide: hide, progress: progress, isShown: isShown, waitFor: waitFor };
})();
