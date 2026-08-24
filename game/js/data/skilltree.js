/* CHLOE — data/skilltree.js  (spec §19)
   THE main skill tree: one shared 1-100 track every character walks.

   It is an UNLOCK ladder, not a point shop. Reaching a level grants that
   level's row automatically — no spending, no prerequisites to mis-click.
   Each character walks it on their OWN level, so a level-1 party member has
   only punch while a level-12 leader has the whole early kit.

   Row shape (all fields optional):
     { ability:'id'   -> adds an ability to the bindable pool
       slot:1         -> +1 usable number key (hotbar cap 9)
       stat:{...}     -> permanent stat grant (life/magic/stamina/atk/def/spd/mag)
       ally:'id'      -> a party member joins at this level
       name, desc     -> what the level screen shows }

   §21: LEVELS 1-9 ARE THE AUTHORED GAME. Each of those nine rows is a real,
   built-out thing - an ability with its own animation and VFX, the key to put
   it on, or an ally. Every one of the first nine levels hands you something
   you can feel. 10-100 are generated on a readable cadence and are honest
   about being growth: hotbar width to 9 keys, then stats.

   The shape of the first nine:
     1  punch          + key 1     your hands
     2  fire_tornado   + key 2     the first spell
     3  asteroid       + key 3     the first ranged spell
     4  ally           Ash joins, at her own level
     5  stat           you get harder to kill
     6  hammer_fist    + key 4
     7  stat           the well gets deeper
     8  ember_jab      + key 5
     9  hollow_breaker + key 6     the early kit is complete

   Abilities and their keys arrive TOGETHER on purpose. Granting a move with
   nowhere to bind it reads as a bug, not a reward. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

(function () {
  'use strict';

  var rows = {
    1:  { ability: 'punch', slot: 0, name: 'Fists',
          desc: 'You always have your hands. Weak, cheap, always ready. Key 1.' },
    2:  { ability: 'fire_tornado', slot: 1, name: 'Fire Tornado',
          desc: 'Trace the sign and drop a pillar of fire on him. Comes with key 2 to carry it, so you hold fists AND fire.' },
    /* §21: the first thing you can throw. Everything before this needed you
       to be standing next to him. */
    3:  { ability: 'asteroid', slot: 1, name: 'Asteroid',
          desc: 'Call a burning rock down out of the roof. It falls where you point and everything near the crater takes it. Key 3.' },
    4:  { ally: 'ash', name: 'Ash Finds You',
          desc: 'Your sister catches up. She fights at her own level, and if you fall she takes the lead.' },
    5:  { stat: { life: 12, stamina: 6 }, name: 'Roadworn',
          desc: '+12 life, +6 stamina.' },
    6:  { ability: 'hammer_fist', slot: 1, name: 'Hammer Fist',
          desc: 'One committed overhand. Slow, heavy, expensive. Key 4.' },
    7:  { stat: { magic: 8, mag: 2 }, name: 'Open Channel',
          desc: '+8 magic, +2 magic power.' },
    8:  { ability: 'ember_jab', slot: 1, name: 'Ember Jab',
          desc: 'A jab that lights on contact. Key 5.' },
    9:  { ability: 'hollow_breaker', slot: 1, name: 'Hollow Breaker',
          desc: 'A rising strike that hurts what armour cannot protect. Key 6 — the early kit is complete.' }
  };

  /* 10-100: growth, and honest about it. Widen the hotbar to its 9-key cap,
     then steady stats. New authored abilities drop straight into `rows`
     above and override the generated entry for that level. */
  var slotsSoFar = 6;   // keys 1-6 handed out across levels 1-9
  for (var L = 10; L <= 100; L++) {
    if (rows[L]) continue;
    if (L % 4 === 0 && slotsSoFar < 9) {
      slotsSoFar++;
      rows[L] = { slot: 1, name: 'Wider Grip', desc: '+1 ability keybind - key ' + slotsSoFar + '.' };
    } else if (L % 5 === 0) {
      rows[L] = { stat: { life: 10, stamina: 4 }, name: 'Harder to Kill', desc: '+10 life, +4 stamina.' };
    } else if (L % 5 === 2) {
      rows[L] = { stat: { magic: 5, mag: 1 }, name: 'Deeper Well', desc: '+5 magic, +1 magic power.' };
    } else {
      rows[L] = { stat: { atk: 1, def: 1, spd: 1 }, name: 'Seasoned', desc: '+1 attack, defense and speed.' };
    }
  }

  CHLOE.data.skilltree = {
    name: 'The Long Night',
    blurb: 'One road, walked by everyone. Reach the level, gain the row — nothing to spend.',
    maxLevel: 100,
    rows: rows
  };
})();
