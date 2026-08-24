/* CHLOE — ui/binds.js  (Combat v3, spec §17 — the Moves screen)
   Assign known abilities to number keys 1-9 before a fight. Slots beyond the
   unlocked count are shown locked, so it is obvious the skill tree is what
   widens the hotbar. Renders into the menu overlay's Moves tab. */
window.CHLOE = window.CHLOE || {};
CHLOE.ui = CHLOE.ui || {};

CHLOE.ui.binds = (function () {
  'use strict';
  var ui, sel = { slot: 0 };

  function C3() { return CHLOE.engine.combat3; }
  function ABIL() { return CHLOE.data.abilities || {}; }
  function typeColor(t) {
    var c = (CHLOE.data.types && CHLOE.data.types.colors) || {};
    return c[t] || '#9a939c';
  }

  function activeChar() {
    var p = CHLOE.engine.party;
    var m = p.active() || p.state.members[0];
    return m ? m.id : null;
  }

  function costText(a) {
    var bits = [];
    if (a.cost && a.cost.sta) bits.push(a.cost.sta + ' STA');
    if (a.cost && a.cost.mana) bits.push(a.cost.mana + ' MAG');
    return bits.join(' · ') || 'free';
  }

  function renderInto(body, opts) {
    ui = CHLOE.ui;
    var charId = (opts && opts.charId) || activeChar();
    if (!charId || !C3()) {
      body.appendChild(ui.el('div', 'menu-note', 'No one is ready to fight.'));
      return;
    }
    var known = C3().knownAbilities(charId);
    var slots = C3().binds(charId);
    var maxSlots = (CHLOE.data.abilityConfig && CHLOE.data.abilityConfig.maxSlots) || 9;

    body.appendChild(ui.el('div', 'menu-note',
      'Bind abilities to number keys. In the fight: 1-9 to strike, SPACE to evade, ' +
      'Shift to sprint, Ctrl or C to crouch. Each level-up gives a skill point — ' +
      'spend it in the Skill Tree to unlock new abilities and more keys.'));

    // --- the 9 keys ---
    var row = ui.el('div', 'bind-slots');
    for (var i = 0; i < maxSlots; i++) {
      var unlocked = i < slots.length;
      var id = unlocked ? slots[i] : null;
      var a = id ? ABIL()[id] : null;
      var d = ui.el('div', 'bind-slot' +
        (unlocked ? '' : ' locked') + (sel.slot === i ? ' sel' : ''));
      d.appendChild(ui.el('span', 'key', String(i + 1)));
      if (!unlocked) {
        d.appendChild(ui.el('span', 'icon', '🔒'));
        d.appendChild(ui.el('span', 'nm', 'locked'));
        d.title = 'Unlock more keybinds in the Skill Tree';
      } else if (a) {
        var ic = ui.el('span', 'icon', a.icon || '•');
        ic.style.color = typeColor(a.type);
        d.appendChild(ic);
        d.appendChild(ui.el('span', 'nm', a.name));
      } else {
        d.appendChild(ui.el('span', 'icon', '·'));
        d.appendChild(ui.el('span', 'nm', 'empty'));
      }
      if (unlocked) {
        (function (idx) {
          d.addEventListener('click', function () { sel.slot = idx; rerender(body, opts); });
        })(i);
      }
      row.appendChild(d);
    }
    body.appendChild(row);

    // --- abilities you can put in the selected key ---
    body.appendChild(ui.el('div', 'bind-head',
      'Abilities — tap one to bind it to key ' + (sel.slot + 1)));
    var grid = ui.el('div', 'bind-grid');
    if (!known.length) {
      grid.appendChild(ui.el('div', 'menu-note', 'Nothing learned yet.'));
    }
    known.forEach(function (id) {
      var a = ABIL()[id];
      if (!a) return;
      var boundAt = slots.indexOf(id);
      var card = ui.el('div', 'bind-card' + (boundAt === sel.slot ? ' on' : ''));
      var head = ui.el('div', 'bind-card-head');
      var ic = ui.el('span', 'icon', a.icon || '•');
      ic.style.color = typeColor(a.type);
      head.appendChild(ic);
      head.appendChild(ui.el('span', 'nm', a.name));
      if (boundAt >= 0) head.appendChild(ui.el('span', 'at', 'key ' + (boundAt + 1)));
      card.appendChild(head);
      card.appendChild(ui.el('div', 'ds', a.desc || ''));
      var meta = ui.el('div', 'bind-meta');
      meta.appendChild(ui.el('span', null, costText(a)));
      meta.appendChild(ui.el('span', null, 'cd ' + ((a.cooldownMs || 0) / 1000).toFixed(1) + 's'));
      if ((a.charges || 1) > 1) meta.appendChild(ui.el('span', null, a.charges + ' charges'));
      meta.appendChild(ui.el('span', null, (a.hits || 1) + (a.hits > 1 ? ' hits' : ' hit')));
      card.appendChild(meta);
      card.addEventListener('click', function () {
        C3().bind(charId, sel.slot, id);
        rerender(body, opts);
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);

    var clear = ui.el('button', null, 'Clear key ' + (sel.slot + 1));
    clear.addEventListener('click', function () {
      C3().bind(charId, sel.slot, null);
      rerender(body, opts);
    });
    body.appendChild(clear);
  }

  function rerender(body, opts) {
    ui.clear(body);
    renderInto(body, opts);
  }

  return { renderInto: renderInto };
})();
