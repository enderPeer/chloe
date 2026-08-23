/* CHLOE — ui/menu.js
   Menu overlay: Party / Inventory / Moves (loadout editor) / Save / How to play. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.menu = (function(){
  'use strict';
  var ui, party;
  var tab = 'party';
  var pickingItem = null; // itemId while choosing a target member

  function layer(){ return CHLOE.ui.byId('overlay-menu'); }

  function open(){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    tab = 'party'; pickingItem = null;
    render();
    layer().classList.remove('hidden');
  }
  function close(){
    layer().classList.add('hidden');
    ui.clear(layer());
    // refresh scene HUD (shards may have changed)
    if (CHLOE.ui.current() === 'scene') CHLOE.ui.scene.refresh();
  }

  function render(){
    var l = ui.clear(layer());
    l.addEventListener && l.setAttribute('data-open', '1');
    var card = ui.el('div', 'menu-card');

    var tabs = ui.el('div', 'menu-tabs');
    [['party','Party'], ['inventory','Inventory'], ['moves','Moves'], ['save','Save'], ['help','How to play'], ['close','✕']]
      .forEach(function(t){
        var b = ui.el('button', tab === t[0] ? 'on' : '', t[1]);
        b.addEventListener('click', function(){
          if (t[0] === 'close') { close(); return; }
          tab = t[0]; pickingItem = null; render();
        });
        tabs.appendChild(b);
      });
    card.appendChild(tabs);

    var body = ui.el('div', 'menu-body');
    if (tab === 'party') renderParty(body);
    else if (tab === 'inventory') renderInventory(body);
    else if (tab === 'moves') renderMoves(body);
    else if (tab === 'save') renderSave(body);
    else renderHelp(body);
    card.appendChild(body);

    l.appendChild(card);
  }

  /* ---------- Party ---------- */
  function renderParty(body){
    var prog = CHLOE.engine.progression;
    party.state.members.forEach(function(m){
      var def = (CHLOE.data.characters || {})[m.id] || {};
      var eff = party.effStats(m);
      var w = party.weaponOf(m);
      var isActive = party.state.activeId === m.id;

      var cardM = ui.el('div', 'party-card' + (isActive ? ' active-member' : ''));
      var p = ui.el('div', 'party-portrait');
      p.appendChild(ui.portraitNode(def.portraitKey || m.id, def.name || m.id));
      cardM.appendChild(p);

      var info = ui.el('div', 'party-info');
      var head = ui.el('div', 'party-head');
      head.appendChild(ui.el('span', 'nm', (def.name || m.id) + '  ·  Lv ' + m.level));
      var elLabel = (CHLOE.data.elements.labels || {})[def.element] || def.element || '';
      head.appendChild(ui.el('span', 'el', elLabel + (isActive ? ' · LEAD' : '')));
      info.appendChild(head);

      var grid = ui.el('div', 'stat-grid');
      var addStat = function(k, v){
        var s = ui.el('span');
        s.appendChild(document.createTextNode(k + ' '));
        var b = ui.el('b', null, String(v));
        s.appendChild(b);
        grid.appendChild(s);
      };
      addStat('HP', m.hp + '/' + eff.maxHp);
      addStat('MP', m.mp + '/' + eff.maxMp);
      addStat('ATK', eff.atk + (eff.weaponAtk ? '+' + eff.weaponAtk : ''));
      addStat('DEF', eff.def);
      addStat('SPD', eff.spd);
      addStat('MAG', eff.mag);
      info.appendChild(grid);

      var next = prog.xpToNext(m.level);
      var xpBar = ui.makeBar('mp');
      ui.setBar(xpBar, m.xp, next);
      info.appendChild(xpBar);
      var xt = ui.el('div', 'bar-txt');
      xt.appendChild(ui.el('span', null, 'XP ' + m.xp + ' / ' + next));
      xt.appendChild(ui.el('span', null, w ? w.name : 'Bare hands'));
      info.appendChild(xt);

      var moveIds = (CHLOE.ui.loadout && CHLOE.ui.loadout.learnedIds)
        ? CHLOE.ui.loadout.learnedIds(m.id, m.level)
        : (party.skillsOf ? party.skillsOf(m) : []);
      var moveNames = moveIds.map(function(id){
        var s = (CHLOE.data.moves || {})[id] || (CHLOE.data.skills || {})[id];
        return s ? s.name : id;
      }).join(' · ');
      var sk = ui.el('div', 'ds', 'Moves: ' + (moveNames || '—'));
      sk.style.color = 'var(--dim)';
      sk.style.fontSize = '.8rem';
      sk.style.marginTop = '.35rem';
      info.appendChild(sk);

      if (!isActive && m.hp > 0) {
        var lead = ui.el('button', null, 'Make lead');
        lead.style.marginTop = '.5rem';
        lead.addEventListener('click', function(){
          party.setActive(m.id);
          render();
        });
        info.appendChild(lead);
      }
      cardM.appendChild(info);
      body.appendChild(cardM);
    });
  }

  /* ---------- Inventory ---------- */
  function renderInventory(body){
    var inv = CHLOE.engine.inventory;
    var items = inv.list();
    if (!items.length) {
      body.appendChild(ui.el('div', 'inv-empty', 'The bag is empty. The night provides... sometimes.'));
      return;
    }
    items.forEach(function(entry){
      var def = entry.def;
      var row = ui.el('div', 'inv-row');
      row.appendChild(ui.el('div', 'inv-icon', def.icon || '▪'));
      var main = ui.el('div', 'inv-main');
      main.appendChild(ui.el('div', 'nm', def.name));
      main.appendChild(ui.el('div', 'ds', def.desc || ''));
      row.appendChild(main);
      row.appendChild(ui.el('div', 'inv-count', 'x' + entry.count));
      var use = ui.el('button', null, pickingItem === def.id ? 'Cancel' : 'Use');
      use.addEventListener('click', function(){
        pickingItem = (pickingItem === def.id) ? null : def.id;
        render();
      });
      row.appendChild(use);
      body.appendChild(row);

      if (pickingItem === def.id) {
        var picker = ui.el('div', 'picker-row');
        party.state.members.forEach(function(m){
          var cdef = (CHLOE.data.characters || {})[m.id] || {};
          var eff = party.effStats(m);
          var b = ui.el('button', null,
            (cdef.name || m.id) + ' — ' + (m.hp > 0 ? m.hp + '/' + eff.maxHp + ' HP' : 'K.O.'));
          b.addEventListener('click', function(){
            var res = inv.use(def.id, m);
            ui.toast(res.text);
            pickingItem = null;
            if (res.ok) CHLOE.engine.save.autosave();
            render();
          });
          picker.appendChild(b);
        });
        body.appendChild(picker);
      }
    });
  }

  /* ---------- Moves (loadout editor) ---------- */
  function renderMoves(body){
    if (CHLOE.ui.loadout && CHLOE.ui.loadout.renderInto) {
      CHLOE.ui.loadout.renderInto(body, { readOnly: false });
    } else {
      body.appendChild(ui.el('div', 'menu-note', 'The moves board is dark right now.'));
    }
  }

  /* ---------- Save ---------- */
  function renderSave(body){
    var save = CHLOE.engine.save;
    var acc = save.getCurrent();
    var note = ui.el('div', 'menu-note');
    if (acc) {
      var blob = save.readLocal(acc.name);
      note.textContent = 'Signed in as ' + acc.name + '. ' +
        (blob ? 'Last save: ' + new Date(blob.savedAt).toLocaleString() : 'No save yet.');
    } else {
      note.textContent = 'Not signed in.';
    }
    body.appendChild(note);
    body.appendChild(ui.el('div', 'menu-note',
      'Autosaves on every scene change and after every battle.' +
      ((CHLOE.data.config && CHLOE.data.config.apiUrl) ? ' Cloud sync: on.' : ' Cloud sync: off (local only).')));

    var row = ui.el('div', 'account-actions');
    var saveBtn = ui.el('button', null, 'Save now');
    saveBtn.disabled = !acc;
    saveBtn.addEventListener('click', function(){
      var b = save.saveNow();
      ui.toast(b ? 'Saved.' : 'Could not save.');
      render();
    });
    row.appendChild(saveBtn);

    var out = ui.el('button', null, 'Log out');
    out.addEventListener('click', function(){
      save.saveNow();
      save.logout();
      close();
      CHLOE.ui.show('title');
    });
    row.appendChild(out);
    body.appendChild(row);
  }

  /* ---------- Help ---------- */
  function renderHelp(body){
    var h = ui.el('div', 'howto');
    var add = function(html){
      var d = ui.el('div');
      d.innerHTML = html; // static help copy only — no user input
      h.appendChild(d);
    };
    add('<b>Explore.</b> Look for the small <span class="k">red glints</span> in each scene — anything that glints can be touched. Tap or hover to see what it is, click to move, talk, search, and fight what waits in the dark.');
    add('<b>Phases.</b> In battle, you and the enemy are always in one of five phases: <span class="k">Neutral</span> (normal), <span class="k">Aggressive</span> (hit harder, get hit harder), <span class="k">Guarded</span> (take much less damage), <span class="k">Staggered</span> (weak and wobbly for a turn), and <span class="k">Charged</span> (your next attack hits 1.5x). The badge next to each HP bar shows the current phase.');
    add('<b>The loop.</b> Stance moves shift your phase — step Aggressive to press, Guard when a big hit is coming, or Charge up and unload. Defense moves block certain attacks: a blocked attacker staggers, and staggered fighters hit soft and bruise easy. Hit an elemental weakness and THEY stagger while you surge Aggressive. Punish staggers, that\'s the whole dance.');
    add('<b>Moves.</b> Each phase has its own set of up to <span class="k">5 equipped moves</span> — you only see the moves of the phase you\'re in. Missing an attack staggers you; <span class="k">Struggle</span> (free hit) is always there, and <span class="k">Recover</span> appears while staggered. Edit sets any time in <span class="k">Menu → Moves</span>.');
    add('<b>Turns.</b> Order goes by <span class="k">SPD</span>. Moves cost MP; <span class="k">Items</span>, <span class="k">Switch</span> and fleeing each use your turn. You can\'t run from bosses.');
    add('<b>Elements.</b> Ember &gt; Frost &gt; Volt &gt; Ember (2x with the arrow, 0.5x against it). Shadow and Light burn each other for 2x.');
    add('<b>Falling.</b> If a bandmate drops, the other steps in. If everyone falls, you wake at the start and lose 30% of your <span class="k">◆ shards</span>.');
    add('<b>Shards ◆.</b> Splinters of the club\'s broken mirror wall — the only currency the Between respects.');
    body.appendChild(h);
  }

  return { open: open, close: close };
})();
