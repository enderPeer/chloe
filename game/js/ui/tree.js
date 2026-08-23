/* CHLOE — ui/tree.js  (Progression v3, spec §12 — skill tree screen)
   Own screen (#screen-tree, self-registered into #app so index.html only adds
   a script tag). Character picker, branch-colored node graph laid out by each
   node's pos:{x,y} percents inside a pan/scrollable ~1400px canvas, SVG lines
   along `requires` edges, node states owned/available/locked, tap -> bottom
   card (name/cost/grant/requires) with Buy, points counter, Respec + confirm.
   Renders ONLY — buying/refunding is CHLOE.engine.tree (owned/canBuy/buy/
   respec); with the engine missing the screen degrades to read-only. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.tree = (function(){
  'use strict';
  var ui;
  var selChar = null;
  var selNodeId = null;
  var confirmRespec = false;
  var returnTo = 'scene';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BRANCH_COLORS = {
    pyre:'#e5173f', voice:'#d8a31a', steel:'#9a939c',
    storm:'#3d9bdc', veil:'#a44ce0', toxin:'#4caf50',
    trunk:'#f2eef0', shared:'#f2eef0', core:'#f2eef0'
  };
  var KIND_GLYPH = { stat:'+', move:'⚔', passive:'◆', keystone:'★' };
  var KIND_LABEL = { stat:'Stat', move:'Move', passive:'Passive', keystone:'Keystone' };
  var STAT_LABEL = { life:'LIFE', stamina:'STA', magic:'MAG', faith:'FTH', atk:'ATK', def:'DEF', spd:'SPD', mag:'MAG' };

  function party(){ return CHLOE.engine.party; }
  function engine(){ return (CHLOE.engine || {}).tree; }
  function branchColor(b){
    // tree.js data may carry its own palette: trees[char].branches[b].color
    var t = selChar ? (CHLOE.data.trees || {})[selChar] : null;
    if (t && t.branches && t.branches[b] && t.branches[b].color) return t.branches[b].color;
    return BRANCH_COLORS[String(b || '').toLowerCase()] || '#9a939c';
  }
  function charDef(id){ return (CHLOE.data.characters || {})[id] || {}; }

  /* ---------- data access (defensive: trees.js is another agent's file) ---------- */
  function nodesOf(charId){
    var t = (CHLOE.data.trees || {})[charId];
    if (!t) return [];
    if (Array.isArray(t)) return t;
    if (Array.isArray(t.nodes)) return t.nodes;
    var out = [];
    for (var k in t) {
      if (!t.hasOwnProperty(k)) continue;
      var n = t[k];
      if (!n || typeof n !== 'object') continue;
      if (!n.id) {
        var c = {};
        for (var kk in n) if (n.hasOwnProperty(kk)) c[kk] = n[kk];
        c.id = k;
        n = c;
      }
      out.push(n);
    }
    return out;
  }

  function ownedIndex(charId){
    var idx = {};
    var eng = engine();
    var list = null;
    if (eng && typeof eng.owned === 'function') {
      try { list = eng.owned(charId); } catch (e) {}
    }
    if (!Array.isArray(list)) {
      if (list && typeof list === 'object') return list; // already an index
      var st = (party() && party().state) || {};
      var tr = st.tree || st.trees || {};
      list = Array.isArray(tr[charId]) ? tr[charId] : [];
    }
    for (var i = 0; i < list.length; i++) idx[list[i]] = true;
    return idx;
  }

  function pointsOf(charId){
    if (CHLOE.ui.sheet && CHLOE.ui.sheet.pointsOf) return CHLOE.ui.sheet.pointsOf(charId);
    var st = (party() && party().state) || {};
    return (st.skillPoints && st.skillPoints[charId]) || 0;
  }

  function reachable(node, ownedIdx){
    var req = node.requires;
    if (!req || !req.length) return true;          // root
    for (var i = 0; i < req.length; i++) if (ownedIdx[req[i]]) return true; // any-of
    return false;
  }

  /* {ok, reason} — engine.canBuy preferred, local check as display fallback. */
  function canBuyInfo(charId, node, ownedIdx, points){
    if (ownedIdx[node.id]) return { ok: false, reason: 'Already owned.' };
    var eng = engine();
    if (eng && typeof eng.canBuy === 'function') {
      try {
        var r = eng.canBuy(charId, node.id);
        if (typeof r === 'boolean') return { ok: r, reason: r ? '' : lockReason(node, ownedIdx, points) };
        if (r && typeof r === 'object') {
          return { ok: r.ok !== false && r.can !== false, reason: r.reason || r.error || '' };
        }
      } catch (e) {}
    }
    if (!reachable(node, ownedIdx)) return { ok: false, reason: lockReason(node, ownedIdx, points) };
    if (points < (node.cost || 1)) return { ok: false, reason: 'Not enough skill points.' };
    if (!eng || typeof eng.buy !== 'function') return { ok: false, reason: 'The tree engine is still waking up.' };
    return { ok: true, reason: '' };
  }
  function lockReason(node, ownedIdx, points){
    if (!reachable(node, ownedIdx)) return 'Requires a connected node first.';
    if (points < (node.cost || 1)) return 'Not enough skill points.';
    return '';
  }

  function grantSummary(node){
    var g = node.grant || {};
    if (node.kind === 'move' || g.move) {
      var mv = (CHLOE.data.moves || {})[g.move];
      return 'Learn: ' + ((mv && mv.name) || g.move || '?');
    }
    if (node.kind === 'stat' || g.stat) {
      var parts = [];
      var s = g.stat || {};
      for (var k in s) {
        if (s.hasOwnProperty(k)) parts.push('+' + s[k] + ' ' + (STAT_LABEL[k] || k.toUpperCase()));
      }
      return parts.length ? parts.join('  ') : '';
    }
    if (g.passive && typeof g.passive === 'object') {
      var pp = [], p = g.passive, kk;
      if (p.resist) for (kk in p.resist) if (p.resist.hasOwnProperty(kk)) pp.push(kk + ' resist ' + p.resist[kk] + '%');
      if (p.statusResist) for (kk in p.statusResist) if (p.statusResist.hasOwnProperty(kk)) pp.push(kk + ' buildup -' + p.statusResist[kk] + '%');
      if (p.staminaRegenPct) pp.push('+' + p.staminaRegenPct + '% stamina regen');
      if (p.onKillLifePct) pp.push('heal ' + p.onKillLifePct + '% life on kill');
      if (p.blockPower) pp.push('blocks ' + p.blockPower + '% stronger');
      for (kk in p) {
        if (p.hasOwnProperty(kk) &&
            ['resist','statusResist','staminaRegenPct','onKillLifePct','blockPower'].indexOf(kk) === -1 &&
            (typeof p[kk] === 'number' || typeof p[kk] === 'string')) {
          pp.push(kk + ' ' + p[kk]);
        }
      }
      return pp.join('  ');
    }
    return '';
  }

  /* ---------- screen div (self-registered so index.html stays script-only) ---------- */
  function ensureScreen(){
    var d = ui.byId('screen-tree');
    if (!d) {
      d = ui.el('div', 'screen');
      d.id = 'screen-tree';
      var app = ui.byId('app');
      if (app) app.insertBefore(d, ui.byId('dialog-layer') || null);
      else document.body.appendChild(d);
    }
    return d;
  }

  /* ---------- entry ---------- */
  function open(charId){
    ui = CHLOE.ui;
    var cur = ui.current && ui.current();
    if (cur && cur !== 'tree') returnTo = cur;
    var members = (party() && party().state && party().state.members) || [];
    if (charId && party().get(charId)) selChar = charId;
    if (!selChar || !party().get(selChar)) selChar = members.length ? members[0].id : null;
    selNodeId = null;
    confirmRespec = false;
    ensureScreen();
    render();
    ui.show('tree');
  }
  function closeScreen(){
    confirmRespec = false;
    selNodeId = null;
    ui.show(returnTo || 'scene');
  }

  /* ---------- render ---------- */
  function render(){
    var r = ensureScreen();
    // keep pan position across re-renders (buy/select)
    var oldScroll = r.querySelector ? r.querySelector('.tree-scroll') : null;
    var keepTop = oldScroll ? oldScroll.scrollTop : 0;
    var keepLeft = oldScroll ? oldScroll.scrollLeft : 0;
    ui.clear(r);
    var root = ui.el('div', 'tree-root');

    var members = (party() && party().state && party().state.members) || [];
    var nodes = selChar ? nodesOf(selChar) : [];
    var ownedIdx = selChar ? ownedIndex(selChar) : {};
    var points = selChar ? pointsOf(selChar) : 0;

    /* header */
    var head = ui.el('div', 'tree-head');
    var back = ui.el('button', 'tree-back', '‹ Back');
    back.addEventListener('click', closeScreen);
    head.appendChild(back);
    head.appendChild(ui.el('div', 'tree-title', 'Skill Tree'));

    var chars = ui.el('div', 'tree-chars');
    members.forEach(function(m){
      var def = charDef(m.id);
      var b = ui.el('button', 'tree-char' + (selChar === m.id ? ' on' : ''), (def.name || m.id));
      b.addEventListener('click', function(){
        selChar = m.id; selNodeId = null; confirmRespec = false; render();
      });
      chars.appendChild(b);
    });
    head.appendChild(chars);

    var pill = ui.el('div', 'points-pill tree-points', points + ' pts');
    pill.title = 'Unspent skill points. +1 every level.';
    head.appendChild(pill);

    var respecBtn = ui.el('button', 'tree-respec', 'Respec');
    respecBtn.disabled = !selChar;
    respecBtn.title = 'Refund every bought node for shards.';
    respecBtn.addEventListener('click', function(){ confirmRespec = true; render(); });
    head.appendChild(respecBtn);
    root.appendChild(head);

    /* canvas */
    var scroll = ui.el('div', 'tree-scroll');
    var canvas = ui.el('div', 'tree-canvas');
    if (!selChar) {
      canvas.appendChild(ui.el('div', 'menu-note tree-note', 'No band members yet.'));
    } else if (!nodes.length) {
      canvas.appendChild(ui.el('div', 'menu-note tree-note',
        'This tree hasn’t grown yet. Come back when the night feeds it.'));
    } else {
      var byId = {};
      nodes.forEach(function(n){ if (n && n.id) byId[n.id] = n; });

      /* edges (SVG lines, percent coords so they track the canvas size) */
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'tree-edges');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      nodes.forEach(function(n){
        if (!n || !n.pos) return;
        (n.requires || []).forEach(function(rid){
          var p = byId[rid];
          if (!p || !p.pos) return;
          var ln = document.createElementNS(SVG_NS, 'line');
          ln.setAttribute('x1', (p.pos.x || 0) + '%');
          ln.setAttribute('y1', (p.pos.y || 0) + '%');
          ln.setAttribute('x2', (n.pos.x || 0) + '%');
          ln.setAttribute('y2', (n.pos.y || 0) + '%');
          ln.setAttribute('stroke', branchColor(n.branch));
          var cls = 'e-dim';
          if (ownedIdx[n.id] && ownedIdx[rid]) cls = 'e-on';
          else if (ownedIdx[rid] || reachable(n, ownedIdx)) cls = 'e-avail';
          ln.setAttribute('class', cls);
          svg.appendChild(ln);
        });
      });
      canvas.appendChild(svg);

      /* nodes */
      nodes.forEach(function(n){
        if (!n || !n.id) return;
        var owned = !!ownedIdx[n.id];
        var avail = !owned && reachable(n, ownedIdx);
        var state = owned ? 'owned' : (avail ? 'avail' : 'locked');
        var b = ui.el('button', 'tree-node k-' + (n.kind || 'stat') + ' ' + state +
          (selNodeId === n.id ? ' sel' : ''));
        b.style.left = ((n.pos && n.pos.x) || 0) + '%';
        b.style.top = ((n.pos && n.pos.y) || 0) + '%';
        b.style.setProperty('--bc', branchColor(n.branch));
        b.appendChild(ui.el('span', 'glyph', KIND_GLYPH[n.kind] || '•'));
        if (!owned) b.appendChild(ui.el('span', 'ncost', String(n.cost || 1)));
        b.title = (n.name || n.id) + ' — ' + (owned ? 'owned' : (avail ? 'available' : 'locked'));
        b.addEventListener('click', function(){
          selNodeId = (selNodeId === n.id) ? null : n.id;
          confirmRespec = false;
          render();
        });
        canvas.appendChild(b);
      });
    }
    scroll.appendChild(canvas);
    root.appendChild(scroll);

    /* bottom card for the selected node */
    var selNode = null;
    for (var i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].id === selNodeId) { selNode = nodes[i]; break; }
    if (selNode) root.appendChild(buildCard(selNode, ownedIdx, points));

    /* respec confirm veil */
    if (confirmRespec && selChar) root.appendChild(buildRespecConfirm());

    r.appendChild(root);
    var newScroll = r.querySelector('.tree-scroll');
    if (newScroll) { newScroll.scrollTop = keepTop; newScroll.scrollLeft = keepLeft; }
  }

  function buildCard(node, ownedIdx, points){
    var card = ui.el('div', 'tree-card');
    card.style.setProperty('--bc', branchColor(node.branch));

    var top = ui.el('div', 'tc-top');
    top.appendChild(ui.el('span', 'tc-name', node.name || node.id));
    top.appendChild(ui.el('span', 'tc-kind', KIND_LABEL[node.kind] || node.kind || ''));
    top.appendChild(ui.el('span', 'tc-cost', (node.cost || 1) + ' pt' + ((node.cost || 1) > 1 ? 's' : '')));
    var x = ui.el('button', 'tc-x', '✕');
    x.addEventListener('click', function(){ selNodeId = null; render(); });
    top.appendChild(x);
    card.appendChild(top);

    var grant = grantSummary(node);
    if (grant) card.appendChild(ui.el('div', 'tc-grant', grant));
    if (node.desc) card.appendChild(ui.el('div', 'tc-desc', node.desc));

    if (node.requires && node.requires.length) {
      var req = ui.el('div', 'tc-req');
      req.appendChild(ui.el('span', 'tc-req-lbl', 'Requires: '));
      var nodes = nodesOf(selChar), names = {};
      nodes.forEach(function(n){ if (n && n.id) names[n.id] = n.name || n.id; });
      node.requires.forEach(function(rid, k){
        if (k) req.appendChild(ui.el('span', 'tc-req-or', ' or '));
        req.appendChild(ui.el('span', 'tc-req-n' + (ownedIdx[rid] ? ' got' : ''),
          (ownedIdx[rid] ? '✓ ' : '') + (names[rid] || rid)));
      });
      card.appendChild(req);
    }

    var foot = ui.el('div', 'tc-foot');
    if (ownedIdx[node.id]) {
      foot.appendChild(ui.el('span', 'tc-owned', '✓ Owned'));
    } else {
      var info = canBuyInfo(selChar, node, ownedIdx, points);
      if (info.reason) foot.appendChild(ui.el('span', 'tc-reason', info.reason));
      var buyB = ui.el('button', 'tc-buy', 'Buy — ' + (node.cost || 1) + ' pt' + ((node.cost || 1) > 1 ? 's' : ''));
      buyB.disabled = !info.ok;
      buyB.addEventListener('click', function(){ buy(node); });
      foot.appendChild(buyB);
    }
    card.appendChild(foot);
    return card;
  }

  function buy(node){
    var eng = engine();
    if (!eng || typeof eng.buy !== 'function') {
      ui.toast('The tree is still growing — try again soon.');
      return;
    }
    var r = null;
    try { r = eng.buy(selChar, node.id); } catch (e) { console.warn('[CHLOE] tree.buy failed', e); }
    var ok = (r === true) || (r && typeof r === 'object' && r.ok !== false && !r.error);
    if (ok) {
      ui.toast((r && r.text) || ('Bought: ' + (node.name || node.id)));
      try {
        var sv = CHLOE.engine.save;
        if (sv && sv.getCurrent && sv.getCurrent()) sv.autosave();
      } catch (e2) {}
    } else {
      ui.toast((r && (r.error || r.reason)) || 'The tree refuses. Not yet.');
    }
    render();
  }

  /* ---------- respec ---------- */
  function respecCost(charId){
    var eng = engine();
    var names = ['respecCost', 'respecPrice', 'costOfRespec'];
    if (eng) {
      for (var i = 0; i < names.length; i++) {
        if (typeof eng[names[i]] === 'function') {
          try {
            var r = eng[names[i]](charId);
            if (typeof r === 'number' && isFinite(r)) return r;
          } catch (e) {}
        }
      }
    }
    var m = party().get ? party().get(charId) : null;
    return 10 * ((m && m.level) || 1);   // spec §12: shards = 10*level
  }

  function buildRespecConfirm(){
    var veil = ui.el('div', 'tree-confirm-veil');
    var card = ui.el('div', 'tree-confirm');
    var def = charDef(selChar);
    var cost = respecCost(selChar);
    var shards = (party().state && party().state.shards) || 0;
    card.appendChild(ui.el('h3', null, 'Respec ' + (def.name || selChar) + '?'));
    card.appendChild(ui.el('div', 'tc-desc',
      'Every bought node is refunded and the skill points come back.'));
    card.appendChild(ui.el('div', 'tc-shards',
      'Cost: ' + cost + ' ◆  ·  you carry ' + shards + ' ◆'));
    var row = ui.el('div', 'tc-confirm-row');
    var yes = ui.el('button', 'tc-buy', 'Refund everything');
    yes.disabled = shards < cost && !!engine(); // engine may still have its own rules
    yes.addEventListener('click', doRespec);
    row.appendChild(yes);
    var no = ui.el('button', null, 'Cancel');
    no.addEventListener('click', function(){ confirmRespec = false; render(); });
    row.appendChild(no);
    card.appendChild(row);
    veil.appendChild(card);
    veil.addEventListener('click', function(e){
      if (e.target === veil) { confirmRespec = false; render(); }
    });
    return veil;
  }

  function doRespec(){
    confirmRespec = false;
    var eng = engine();
    if (!eng || typeof eng.respec !== 'function') {
      ui.toast('The tree is still growing — try again soon.');
      render();
      return;
    }
    var r = null;
    try { r = eng.respec(selChar); } catch (e) { console.warn('[CHLOE] tree.respec failed', e); }
    var ok = (r === true) || (r && typeof r === 'object' && r.ok !== false && !r.error);
    if (ok) {
      ui.toast((r && r.text) || 'The tree lets go. Points refunded.');
      try {
        var sv = CHLOE.engine.save;
        if (sv && sv.getCurrent && sv.getCurrent()) sv.autosave();
      } catch (e2) {}
    } else {
      ui.toast((r && (r.error || r.reason)) || 'Not enough shards.');
    }
    render();
  }

  return { open: open, close: closeScreen };
})();
