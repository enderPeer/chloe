/* CHLOE — ui/loadout.js  (Combat v2 — loadout editor, spec sec 10)
   Pick a character -> five phase tabs -> grid of learned moves usable in that
   phase. Tap a move to equip/unequip, live x/5 count, cap enforced, invalid
   picks disabled. Reachable from the menu overlay (embedded as a tab) and from
   the battle screen "Moves" button (read-only overlay).
   Loadouts live in the engine/save (loadouts:{charId:{phaseId:[<=5 ids]}}).
   This module prefers engine getLoadout/setLoadout accessors and falls back to
   party state + character defaultLoadouts, so it never computes battle rules. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.loadout = (function(){
  'use strict';

  var PHASE_ORDER = ['neutral', 'aggressive', 'guarded', 'staggered', 'charged'];
  var PHASE_META = {
    neutral:    { label: 'Neutral',    tip: 'Balanced. Deals and takes normal damage.' },
    aggressive: { label: 'Aggressive', tip: 'Deals x1.25 damage, but takes x1.15.' },
    guarded:    { label: 'Guarded',    tip: 'Takes only x0.60 damage.' },
    staggered:  { label: 'Staggered',  tip: 'Deals x0.75, takes x1.25 — recovers next turn.' },
    charged:    { label: 'Charged',    tip: 'Next attack hits for x1.5.' }
  };
  var CAT_ICON = { attack: '⚔', defense: '🛡', stance: '👣', status: '✨' };
  var CAT_LABEL = { attack: 'Attack', defense: 'Defense', stance: 'Stance', status: 'Status' };
  var MAX = 5;

  /* Progression v3 display data (spec §12) */
  var OLD2NEW = { none:'physical', ember:'fire', volt:'lightning', shadow:'occult', light:'divine', frost:'magical' };
  var TYPE_LABEL = {
    physical:'Physical', magical:'Magical', lightning:'Lightning', fire:'Fire',
    occult:'Occult', blood:'Blood', poison:'Poison', divine:'Divine',
    virus:'Virus', ghost:'Ghost', biological:'Biological'
  };
  function moveTypeOf(def){
    def = def || {};
    if (def.type && TYPE_LABEL[def.type]) return def.type;
    return OLD2NEW[def.element || 'none'] || 'physical';
  }
  function typeDotFor(def){
    var t = moveTypeOf(def);
    var d = ui.el('span', 't-dot t-' + t);
    d.title = TYPE_LABEL[t] || t;
    return d;
  }
  function costChipsFor(def){
    var c = { sta: 0, mp: 0, faith: 0 };
    var raw = def.cost;
    if (raw && typeof raw === 'object') {
      c.sta = raw.sta || raw.stamina || 0;
      c.mp = raw.mp || raw.magic || 0;
      c.faith = raw.faith || 0;
    } else if (typeof raw === 'number') c.mp = raw;
    if (!c.sta && !c.mp && !c.faith && def.mpCost) c.mp = def.mpCost;
    var wrap = ui.el('span', 'cost-chips');
    if (c.sta) wrap.appendChild(ui.el('span', 'cost-chip c-sta', c.sta + ' STA'));
    if (c.mp) wrap.appendChild(ui.el('span', 'cost-chip c-mp', c.mp + ' MP'));
    if (c.faith) wrap.appendChild(ui.el('span', 'cost-chip c-faith', c.faith + ' FTH'));
    if (!wrap.firstChild) wrap.appendChild(ui.el('span', 'cost-chip free', '—'));
    return wrap;
  }

  var ui;
  var selChar = null;
  var selPhase = 'neutral';
  var readOnly = false;
  var container = null;    // node we re-render into
  var overlayMode = false;

  function party(){ return CHLOE.engine.party; }
  function moves(){ return CHLOE.data.moves || {}; }

  /* ---------- engine/data accessors ---------- */
  function findFn(name){
    var e = CHLOE.engine || {};
    var hosts = [e.loadout, e.party, e.progression, e.battle];
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (h && typeof h[name] === 'function') {
        return (function(host, fname){
          return function(){ return host[fname].apply(host, arguments); };
        })(h, name);
      }
    }
    return null;
  }

  function normalizeLo(raw){
    var out = {};
    raw = raw || {};
    for (var i = 0; i < PHASE_ORDER.length; i++) {
      var p = PHASE_ORDER[i];
      var arr = Array.isArray(raw[p]) ? raw[p] : [];
      var seen = {};
      var clean = [];
      for (var j = 0; j < arr.length && clean.length < MAX; j++) {
        var id = arr[j];
        if (typeof id === 'string' && !seen[id]) { seen[id] = 1; clean.push(id); }
      }
      out[p] = clean;
    }
    return out;
  }

  /* Full loadout map {phaseId:[ids]} for a character. */
  function getLoadouts(charId){
    var fn = findFn('getLoadout');
    if (fn) {
      try {
        var r = fn(charId);
        if (r && typeof r === 'object' && !Array.isArray(r)) return normalizeLo(r);
        // per-phase signature getLoadout(charId, phaseId) -> [ids]
        var out = {}, any = false;
        for (var i = 0; i < PHASE_ORDER.length; i++) {
          var a = fn(charId, PHASE_ORDER[i]);
          if (Array.isArray(a)) { out[PHASE_ORDER[i]] = a.slice(0, MAX); any = true; }
          else out[PHASE_ORDER[i]] = [];
        }
        if (any) return normalizeLo(out);
      } catch (e) {}
    }
    var p = party();
    var st = (p && p.state) || {};
    if (st.loadouts && st.loadouts[charId]) return normalizeLo(st.loadouts[charId]);
    var cd = (CHLOE.data.characters || {})[charId] || {};
    return normalizeLo(cd.defaultLoadouts || {});
  }

  function setPhaseList(charId, phaseId, ids){
    ids = (ids || []).slice(0, MAX);
    var fn = findFn('setLoadout');
    if (fn) {
      try {
        var r = fn(charId, phaseId, ids);
        if (r !== false) { autosave(); return true; }
      } catch (e) {}
    }
    var p = party();
    if (!p || !p.state) return false;
    var st = p.state;
    st.loadouts = st.loadouts || {};
    st.loadouts[charId] = st.loadouts[charId] || {};
    st.loadouts[charId][phaseId] = ids;
    autosave();
    return true;
  }

  function autosave(){
    var save = CHLOE.engine.save;
    if (save && save.getCurrent && save.getCurrent()) save.autosave();
  }

  /* Learned move ids for a character: learnset union + tree-granted moves
     (§12 — nodes with grant:{move} join the learned pool). */
  function learnedIds(charId, level){
    var base = baseLearnedIds(charId, level);
    var extra = treeMoveIds(charId);
    if (!extra.length) return base;
    var out = base.slice(), seen = {};
    for (var i = 0; i < out.length; i++) seen[out[i]] = 1;
    for (var j = 0; j < extra.length; j++) {
      var id = extra[j];
      if (typeof id === 'string' && !seen[id]) { seen[id] = 1; out.push(id); }
    }
    return out;
  }

  /* Tree-granted move ids — engine.tree accessor first, then owned-node scan. */
  function treeMoveIds(charId){
    var eng = (CHLOE.engine || {}).tree;
    var names = ['treeMoves', 'grantedMoves', 'movesGranted'];
    if (eng) {
      for (var i = 0; i < names.length; i++) {
        if (typeof eng[names[i]] === 'function') {
          try {
            var r = eng[names[i]](charId);
            if (Array.isArray(r)) return r;
          } catch (e) {}
        }
      }
    }
    var out = [];
    try {
      var ownedIds = null;
      if (eng && typeof eng.owned === 'function') ownedIds = eng.owned(charId);
      if (!Array.isArray(ownedIds)) {
        var st = (party() && party().state) || {};
        var tr = st.tree || st.trees || {};
        ownedIds = Array.isArray(tr[charId]) ? tr[charId] : [];
      }
      if (ownedIds.length) {
        var set = {};
        for (var k = 0; k < ownedIds.length; k++) set[ownedIds[k]] = 1;
        var t = (CHLOE.data.trees || {})[charId];
        var nodes = !t ? []
          : Array.isArray(t) ? t
          : Array.isArray(t.nodes) ? t.nodes
          : treeMapNodes(t);
        for (var n = 0; n < nodes.length; n++) {
          var node = nodes[n];
          if (node && node.id && set[node.id] && node.grant && node.grant.move) {
            out.push(node.grant.move);
          }
        }
      }
    } catch (e2) {}
    return out;
  }
  function treeMapNodes(t){
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

  function baseLearnedIds(charId, level){
    var e = CHLOE.engine || {};
    var member = { id: charId, level: level };
    try {
      if (e.party && typeof e.party.movesOf === 'function') {
        var r = e.party.movesOf(member);
        if (Array.isArray(r)) return r.slice();
      }
    } catch (err) {}
    var def = (CHLOE.data.characters || {})[charId] || {};
    try {
      if (e.progression && typeof e.progression.movesAt === 'function') {
        var r2 = e.progression.movesAt(def, level);
        if (Array.isArray(r2)) return r2.slice();
      }
    } catch (err2) {}
    // compute from learnset (or legacy skillsByLevel)
    var ls = def.learnset || def.skillsByLevel || {};
    var lvls = [];
    for (var k in ls) if (ls.hasOwnProperty(k)) lvls.push(parseInt(k, 10) || 0);
    lvls.sort(function(a, b){ return a - b; });
    var out = [], seen = {};
    for (var i = 0; i < lvls.length; i++) {
      if (lvls[i] > level) break;
      var arr = ls[lvls[i]] || ls[String(lvls[i])] || [];
      for (var j = 0; j < arr.length; j++) {
        if (!seen[arr[j]]) { seen[arr[j]] = 1; out.push(arr[j]); }
      }
    }
    return out;
  }

  /* ---------- rendering ---------- */
  function memberOf(charId){
    var p = party();
    return p && p.get ? p.get(charId) : null;
  }

  function ensureSelection(){
    var p = party();
    var members = (p && p.state && p.state.members) || [];
    if (!selChar || !memberOf(selChar)) selChar = members.length ? members[0].id : null;
    if (PHASE_ORDER.indexOf(selPhase) === -1) selPhase = 'neutral';
  }

  function render(){
    if (!container) return;
    ui = CHLOE.ui;
    ensureSelection();
    var wrap = ui.clear(container);
    var box = ui.el('div', 'loadout-wrap');

    if (readOnly) {
      box.appendChild(ui.el('div', 'lo-readonly', 'Read-only during battle — moves lock in when the lights go down.'));
    }

    var p = party();
    var members = (p && p.state && p.state.members) || [];
    if (!members.length || !selChar) {
      box.appendChild(ui.el('div', 'menu-note', 'No band members yet.'));
      wrap.appendChild(box);
      return;
    }

    // character picker
    var chars = ui.el('div', 'lo-chars');
    members.forEach(function(m){
      var def = (CHLOE.data.characters || {})[m.id] || {};
      var b = ui.el('button', 'lo-char' + (selChar === m.id ? ' on' : ''));
      var pv = ui.el('span', 'lo-char-portrait');
      pv.appendChild(ui.portraitNode(def.portraitKey || m.id, def.name || m.id));
      b.appendChild(pv);
      var meta = ui.el('span', 'lo-char-meta');
      meta.appendChild(ui.el('span', 'nm', def.name || m.id));
      meta.appendChild(ui.el('span', 'lv', 'Lv ' + m.level));
      b.appendChild(meta);
      b.addEventListener('click', function(){ selChar = m.id; render(); });
      chars.appendChild(b);
    });
    box.appendChild(chars);

    var member = memberOf(selChar);
    var lo = getLoadouts(selChar);
    var learned = learnedIds(selChar, member ? member.level : 1);

    // phase tabs
    var tabs = ui.el('div', 'lo-tabs');
    PHASE_ORDER.forEach(function(ph){
      var meta = PHASE_META[ph];
      var b = ui.el('button', 'lo-tab tab-' + ph + (selPhase === ph ? ' on' : ''));
      b.appendChild(ui.el('span', 'dot'));
      b.appendChild(ui.el('span', 'lbl', meta.label));
      b.appendChild(ui.el('span', 'cnt', String((lo[ph] || []).length)));
      b.title = meta.tip;
      b.addEventListener('click', function(){ selPhase = ph; render(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    var list = lo[selPhase] || [];

    // live count + phase tip
    var countRow = ui.el('div', 'lo-countrow');
    countRow.appendChild(ui.el('span', 'lo-count' + (list.length >= MAX ? ' full' : ''),
      'Equipped ' + list.length + ' / ' + MAX));
    countRow.appendChild(ui.el('span', 'lo-tip', PHASE_META[selPhase].tip));
    box.appendChild(countRow);

    // grid of learned moves
    var grid = ui.el('div', 'lo-grid');
    var shown = 0;
    learned.forEach(function(id){
      var def = moves()[id];
      if (!def) return; // unknown id (data not loaded / stale save) — skip quietly
      shown++;
      var usable = Array.isArray(def.usableIn) && def.usableIn.indexOf(selPhase) !== -1;
      var equipped = list.indexOf(id) !== -1;
      var full = !equipped && list.length >= MAX;

      var cell = ui.el('button', 'lo-cell' +
        (equipped ? ' on' : '') + (!usable ? ' invalid' : '') + (usable && full ? ' capped' : ''));
      if (!usable || (full && !equipped)) cell.disabled = true;

      var head = ui.el('span', 'lo-cell-head');
      var icon = ui.el('span', 'mcat', CAT_ICON[def.cat] || CAT_ICON.attack);
      icon.title = CAT_LABEL[def.cat] || def.cat || '';
      head.appendChild(icon);
      head.appendChild(typeDotFor(def));
      head.appendChild(ui.el('span', 'mname', def.name || id));
      head.appendChild(costChipsFor(def));
      cell.appendChild(head);
      cell.appendChild(ui.el('span', 'lo-cell-desc',
        usable ? (def.desc || '') : 'Not usable while ' + PHASE_META[selPhase].label + '.'));
      if (equipped) cell.appendChild(ui.el('span', 'lo-check', '✓'));
      cell.title = def.desc || '';

      if (readOnly) {
        cell.disabled = false;
        cell.addEventListener('click', function(){
          CHLOE.ui.toast('Read-only during battle.');
        });
      } else if (usable && (!full || equipped)) {
        cell.addEventListener('click', function(){ toggle(id); });
      }
      grid.appendChild(cell);
    });
    if (!shown) {
      grid.appendChild(ui.el('div', 'menu-note',
        learned.length ? 'Move data still loading in the dark...' : 'No moves learned yet.'));
    }
    box.appendChild(grid);

    wrap.appendChild(box);
  }

  function toggle(id){
    if (readOnly || !selChar) return;
    var lo = getLoadouts(selChar);
    var list = (lo[selPhase] || []).slice();
    var at = list.indexOf(id);
    if (at !== -1) {
      list.splice(at, 1);
    } else {
      if (list.length >= MAX) {
        CHLOE.ui.toast('That phase is full — unequip something first (' + MAX + ' max).');
        return;
      }
      list.push(id);
    }
    setPhaseList(selChar, selPhase, list);
    render();
  }

  /* ---------- entry points ---------- */
  /* Embedded inside the menu overlay (Moves tab). */
  function renderInto(node, opts){
    ui = CHLOE.ui;
    readOnly = !!(opts && opts.readOnly);
    overlayMode = false;
    container = node;
    render();
  }

  /* Standalone overlay (battle "Moves" button — read-only). */
  function open(opts){
    ui = CHLOE.ui;
    readOnly = !!(opts && opts.readOnly);
    overlayMode = true;
    var layer = ui.byId('overlay-menu');
    if (!layer) return;
    var l = ui.clear(layer);
    var card = ui.el('div', 'menu-card lo-card');
    var bar = ui.el('div', 'menu-tabs lo-titlebar');
    bar.appendChild(ui.el('div', 'lo-title head', readOnly ? 'Moves (read-only)' : 'Moves'));
    var x = ui.el('button', null, '✕');
    x.addEventListener('click', close);
    bar.appendChild(x);
    card.appendChild(bar);
    var body = ui.el('div', 'menu-body');
    card.appendChild(body);
    l.appendChild(card);
    layer.classList.remove('hidden');
    container = body;
    render();
  }

  function close(){
    if (!overlayMode) return;
    var layer = CHLOE.ui.byId('overlay-menu');
    if (layer) {
      layer.classList.add('hidden');
      CHLOE.ui.clear(layer);
    }
    container = null;
    overlayMode = false;
  }

  return {
    open: open,
    close: close,
    renderInto: renderInto,
    getLoadouts: getLoadouts,
    setPhaseList: setPhaseList,
    learnedIds: learnedIds,
    PHASE_ORDER: PHASE_ORDER,
    PHASE_META: PHASE_META
  };
})();
