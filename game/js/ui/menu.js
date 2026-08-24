/* CHLOE — ui/menu.js
   Menu overlay: Party / Inventory / Moves (loadout editor) / Skill Tree / How to play. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.menu = (function(){
  'use strict';
  var ui, party;
  var tab = 'party';
  var pickingItem = null; // itemId while choosing a target member
  var sheetChar = null;   // charId while a character sheet is open (Party tab)

  function layer(){ return CHLOE.ui.byId('overlay-menu'); }

  function open(){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    tab = 'party'; pickingItem = null; sheetChar = null;
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
    var card = ui.el('div', 'menu-card');

    var tabs = ui.el('div', 'menu-tabs');
    [['party','Party'], ['inventory','Inventory'], ['moves','Moves'], ['tree','Skill Tree'], ['help','How to play'], ['close','✕']]
      .forEach(function(t){
        var b = ui.el('button', tab === t[0] ? 'on' : '', t[1]);
        b.addEventListener('click', function(){
          // NOTE: go through the public export — ui/room3d.js wraps
          // CHLOE.ui.menu.close() to resume the 3D world on close.
          if (t[0] === 'close') { CHLOE.ui.menu.close(); return; }
          if (t[0] === 'tree') {   // §12: skill tree is its own screen
            CHLOE.ui.menu.close();
            if (CHLOE.ui.tree && CHLOE.ui.tree.open) CHLOE.ui.tree.open();
            else ui.toast('The tree is still growing in the dark.');
            return;
          }
          tab = t[0]; pickingItem = null; sheetChar = null; render();
        });
        tabs.appendChild(b);
      });
    card.appendChild(tabs);

    var body = ui.el('div', 'menu-body');
    if (tab === 'party') renderPartyOrSheet(body);
    else if (tab === 'inventory') renderInventory(body);
    else if (tab === 'moves') renderMoves(body);
    else renderHelp(body);
    card.appendChild(body);

    l.appendChild(card);
  }

  /* ---------- Party ---------- */
  /* Party list, or the character sheet (§12) when a member was tapped. */
  function renderPartyOrSheet(body){
    if (sheetChar && CHLOE.ui.sheet && CHLOE.ui.sheet.renderInto && party.get(sheetChar)) {
      var back = ui.el('button', 'sheet-back', '‹ Party');
      back.addEventListener('click', function(){ sheetChar = null; render(); });
      body.appendChild(back);
      CHLOE.ui.sheet.renderInto(body, sheetChar, {
        onOpenTree: function(id){
          CHLOE.ui.menu.close(); // public export — see note in render()
          if (CHLOE.ui.tree && CHLOE.ui.tree.open) CHLOE.ui.tree.open(id);
        }
      });
      return;
    }
    sheetChar = null;
    renderParty(body);
  }

  function openSheet(charId){
    sheetChar = charId;
    render();
  }

  function renderParty(body){
    var prog = CHLOE.engine.progression;
    party.state.members.forEach(function(m){
      var def = (CHLOE.data.characters || {})[m.id] || {};
      var eff = party.effStats(m);
      var w = party.weaponOf(m);
      var isActive = party.state.activeId === m.id;

      var cardM = ui.el('div', 'party-card' + (isActive ? ' active-member' : ''));
      var p = ui.el('div', 'party-portrait clickable');
      p.title = 'Open character sheet';
      p.appendChild(ui.portraitNode(def.portraitKey || m.id, def.name || m.id));
      p.addEventListener('click', function(){ openSheet(m.id); });
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

      var actions = ui.el('div', 'party-actions');
      var sheetB = ui.el('button', null, 'Sheet');
      sheetB.title = 'Stats, resistances and skill points';
      sheetB.addEventListener('click', function(){ openSheet(m.id); });
      actions.appendChild(sheetB);
      if (!isActive && m.hp > 0) {
        var lead = ui.el('button', null, 'Make lead');
        lead.addEventListener('click', function(){
          party.setActive(m.id);
          render();
        });
        actions.appendChild(lead);
      }
      info.appendChild(actions);
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
            render();
          });
          picker.appendChild(b);
        });
        body.appendChild(picker);
      }
    });
  }

  /* ---------- Moves (§17 ability keybinds; falls back to the v2 editor) ---------- */
  function renderMoves(body){
    if (CHLOE.ui.binds && CHLOE.ui.binds.renderInto) {
      CHLOE.ui.binds.renderInto(body, {});
    } else if (CHLOE.ui.loadout && CHLOE.ui.loadout.renderInto) {
      CHLOE.ui.loadout.renderInto(body, { readOnly: false });
    } else {
      body.appendChild(ui.el('div', 'menu-note', 'The moves board is dark right now.'));
    }
  }

  /* ---------- Help ---------- */
  function renderHelp(body){
    var h = ui.el('div', 'howto');
    var add = function(html){
      var d = ui.el('div');
      d.innerHTML = html; // static help copy only — no user input
      h.appendChild(d);
    };
    add('<b>Explore.</b> You\'re in the room in first person: <span class="k">WASD</span> to move, mouse to look (click the room to lock the view, ESC to release), <span class="k">Ctrl or C</span> to crouch, <span class="k">Shift</span> to sprint. No mouse? Arrows move, <span class="k">Q/E</span> turn.');
    add('<b>Your hands.</b> <span class="k">Left click</span> closes your left hand, <span class="k">right click</span> your right. See something glinting red? Look at it, click, and your hand reaches out and takes it in the motion. Walk up to what haunts the room — when the crosshair lights up, click to engage.');
    add('<b>Battle.</b> The fight drags you into an <span class="k">old church</span> — and it is <span class="k">real time</span>. You keep walking, sprinting and crouching while the <span class="k">Hollow Black Knight</span> hunts you. Nothing waits for a turn.');
    add('<b>Your keys.</b> <span class="k">1-9</span> fire the abilities you bound in <span class="k">Menu → Moves</span>. Each one costs <span class="k">stamina</span> or <span class="k">magic</span>, takes a moment to wind up, and then needs to cool down. Get close — a punch that lands nothing still costs you.');
    add('<b>Evade.</b> <span class="k">SPACE</span> throws you clear and makes you briefly untouchable — for stamina. When the knight winds up, the prompt says what\'s coming: <span class="k">Wide Slash</span>, crouch under it (Ctrl or C) or back out of reach; <span class="k">Overhead Ruin</span> and <span class="k">Hollow Charge</span> smash a lane aimed where you STOOD, so <span class="k">sidestep</span>. Dodge clean and you take nothing.');
    add('<b>Getting stronger.</b> You start with <span class="k">one ability on one key</span> — your fists. Every level-up is a skill point: spend it in the <span class="k">Skill Tree</span> to learn a new ability or unlock another number key, then bind it in <span class="k">Moves</span>.');
    add('<b>Falling.</b> If the bandmate the knight is hunting drops, the other steps in as the body. If everyone falls, the run is over — for good.');
    add('<b>One night, one run.</b> CHLOE is a roguelike: nothing is saved, ever. Death starts a fresh run at level 1 with empty pockets, and so does closing or reloading the page. Make the night count.');
    add('<b>Shards ◆.</b> Splinters of the club\'s broken mirror wall — the only currency the Between respects. Yours until the run ends.');
    body.appendChild(h);
  }

  return { open: open, close: close };
})();
