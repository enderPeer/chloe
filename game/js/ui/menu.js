/* CHLOE — ui/menu.js
   Menu overlay: Party / Inventory / Moves (keybinds + the level ladder) /
   How to play.
   §21: the Skill Tree tab is gone. Since §19 progression is a LADDER -
   reaching a level grants that level's row automatically - so there was
   nothing left to spend or choose on a tree screen. What each level gives you
   now lives in the Moves tab, next to the keys it unlocks. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.menu = (function(){
  'use strict';
  var ui, party;
  var tab = 'party';
  var pickingItem = null; // itemId while choosing a target member
  var sheetChar = null;   // charId while a character sheet is open (Party tab)
  var movesChar = null;   // §21: charId the Moves tab is showing (null = leader)

  function layer(){ return CHLOE.ui.byId('overlay-menu'); }

  function open(){
    ui = CHLOE.ui; party = CHLOE.engine.party;
    tab = 'party'; pickingItem = null; sheetChar = null; movesChar = null;
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
    var strip = [['party','Party'], ['inventory','Inventory'], ['moves','Moves'], ['help','How to play']];
    /* §32: a COMMAND, not a panel — it hands the player to another screen the
       way '✕' hands them back, rather than rendering into menu-body. It sits
       here as well as on the room's top bar because M/Tab is the one control
       that is reachable from anywhere in the room, including with a match
       already running and the player watching from the hub. Present only when
       ui/lobby.js shipped, so a build without the multiplayer files keeps the
       four tabs it has today. */
    if (CHLOE.ui.lobby && typeof CHLOE.ui.lobby.open === 'function') {
      strip.push(['ring', '⚔ The Ring']);
    }
    strip.push(['close','✕']);
    strip.forEach(function(t){
        var b = ui.el('button', tab === t[0] ? 'on' : '', t[1]);
        b.addEventListener('click', function(){
          // NOTE: go through the public export — ui/room3d.js wraps
          // CHLOE.ui.menu.close() to resume the 3D world on close.
          if (t[0] === 'close') { CHLOE.ui.menu.close(); return; }
          /* Close FIRST, and through the export for the same reason: the
             wrapper is what resumes the world and releases the overlay, and
             lobby.open() then pauses it again on its own terms. Skipping the
             close would leave #overlay-menu sitting over the lobby screen. */
          if (t[0] === 'ring') {
            CHLOE.ui.menu.close();
            try { CHLOE.ui.lobby.open({ focus: 'join' }); } catch (e) {}
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

    /* Build stamp, visible from inside a run: the title screen version
       scrolls past in two seconds, and this is where someone actually checks
       what they are playing. Source is data/version.js (bumped every push). */
    var ver = CHLOE.data.version;
    if (ver) card.appendChild(ui.el('div', 'menu-version', ver.full() + ' · ' + ver.date));
    l.appendChild(card);
  }

  /* ---------- Party ---------- */
  /* Party list, or the character sheet (§12) when a member was tapped. */
  function renderPartyOrSheet(body){
    if (sheetChar && CHLOE.ui.sheet && CHLOE.ui.sheet.renderInto && party.get(sheetChar)) {
      var back = ui.el('button', 'sheet-back', '‹ Party');
      back.addEventListener('click', function(){ sheetChar = null; render(); });
      body.appendChild(back);
      /* §21: no tree to open — the sheet sends you to Moves instead, where
         the ladder for that character is shown beside their keys. */
      CHLOE.ui.sheet.renderInto(body, sheetChar, {
        onOpenLadder: function(id){
          movesChar = id; tab = 'moves'; sheetChar = null; render();
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
      CHLOE.ui.binds.renderInto(body, {
        charId: movesChar,
        onPickChar: function(id){ movesChar = id; render(); }
      });
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
    add('<b>Your keys.</b> <span class="k">1-9</span> fire the abilities you bound in <span class="k">Menu → Moves</span>. Each slot shows what it costs (green = stamina, blue = magic) and counts down its cooldown. A swing that lands nothing still costs you, so pick your moment.');
    add('<b>He hunts you.</b> The knight turns to face you, walks you down, and <span class="k">dashes</span> across the nave when you back off too far. Watch his arms: the sword going up over his head means the overhead is coming.');
    add('<b>Evade.</b> <span class="k">SPACE</span> throws you clear and makes you briefly untouchable — for stamina. When the knight winds up, the prompt says what\'s coming: <span class="k">Wide Slash</span>, crouch under it (Ctrl or C) or back out of reach; <span class="k">Overhead Ruin</span> and <span class="k">Hollow Charge</span> smash a lane aimed where you STOOD, so <span class="k">sidestep</span>. Dodge clean and you take nothing.');
    add('<b>Getting stronger.</b> You start with <span class="k">one ability on one key</span> — your fists. There is nothing to spend: <span class="k">reaching a level gives you that level’s row</span> automatically — a new ability, another number key, or a stat. See the whole ladder, and bind what it gives you, in <span class="k">Menu → Moves</span>. Everyone walks the same road, and party members level separately.');
    add('<b>Falling.</b> If the bandmate the knight is hunting drops, the other steps in as the body. If everyone falls, the run is over — for good.');
    add('<b>One night, one run.</b> CHLOE is a roguelike: nothing is saved, ever. Death starts a fresh run at level 1 with empty pockets, and so does closing or reloading the page. Make the night count.');
    add('<b>Shards ◆.</b> Splinters of the club\'s broken mirror wall — the only currency the Between respects. Yours until the run ends.');
    body.appendChild(h);
  }

  return { open: open, close: close };
})();
