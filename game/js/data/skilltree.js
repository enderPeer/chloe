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

   Levels 1-12 are authored. 13-100 are generated on a readable cadence so the
   ladder is complete and honest about what is filler: every 3rd level widens
   the hotbar until 9 keys, the rest are stat growth. New abilities get slotted
   into this table as they are built (§19 "each level built out separately"). */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

(function () {
  'use strict';

  var rows = {
    1:  { ability: 'punch',        name: 'Fists',          desc: 'You always have your hands. Weak, cheap, always ready.' },
    /* Level 2 grants the spell AND the key to put it on, so you can actually
       hold BOTH punch and Fire Tornado from the moment you earn it. */
    2:  { ability: 'fire_tornado', slot: 1, name: 'Fire Tornado', desc: 'Trace the sign and drop a pillar of fire — and a second keybind to carry it. Both fists and fire from here.' },
    3:  { ally: 'ash',             name: 'Ash Finds You',  desc: 'Your sister catches up. She fights at her own level.' },
    4:  { slot: 1,                 name: 'Second Nature',  desc: '+1 ability keybind — key 3.' },
    5:  { stat: { life: 12, stamina: 6 }, name: 'Roadworn', desc: '+12 life, +6 stamina.' },
    6:  { ability: 'hammer_fist',  name: 'Hammer Fist',    desc: 'One committed overhand. Slow, heavy, expensive.' },
    7:  { slot: 1,                 name: 'Quick Hands',    desc: '+1 ability keybind — key 4.' },
    8:  { stat: { magic: 8, mag: 2 },    name: 'Open Channel', desc: '+8 magic, +2 magic power.' },
    9:  { ability: 'ember_jab',    name: 'Ember Jab',      desc: 'A jab that lights on contact.' },
    10: { slot: 1,                 name: 'Third Hand',     desc: '+1 ability keybind — key 5.' },
    11: { stat: { atk: 3, def: 2 },      name: 'Callused',  desc: '+3 attack, +2 defense.' },
    12: { ability: 'hollow_breaker', name: 'Hollow Breaker', desc: 'A rising strike that hurts what armour cannot protect.' }
  };

  // 13-100: keep widening the hotbar to 9 keys, otherwise steady stat growth.
  var slotsSoFar = 4;   // granted at 2, 4, 7, 10
  for (var L = 13; L <= 100; L++) {
    if (L % 3 === 0 && slotsSoFar < 8) {
      slotsSoFar++;
      rows[L] = { slot: 1, name: 'Wider Grip', desc: '+1 ability keybind — key ' + (slotsSoFar + 1) + '.' };
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
