/* CHLOE — data/knighttree.js  (spec §21)
   The Hollow Black Knight walks a ladder too.

   He does not level from XP — he levels because YOU do. His level is driven by
   the round you are on, so the thing you beat at round 1 is not the thing you
   meet at round 8, and a squad that only ever grew in NUMBER eventually stops
   being a threat and starts being a chore.

   Two things climb together:
     - his STATS, as multipliers on the base def in data/enemies.js
     - his ABILITIES: the attack patterns in data/arena3d.js unlock by level,
       so early knights only know one swing and later ones have the whole book

   Row shape (all fields optional):
     { pattern:'id'   -> unlocks one of data/arena3d.js `patterns`
       life, atk, def -> MULTIPLIERS applied to the base stats (1 = unchanged)
       name, desc     -> what the room's poster shows }

   Levels 1-9 are authored to mirror the player's own ladder (§21): the rounds
   where he learns something are the rounds where you do. 10+ is generated
   growth, and honest about it. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

(function () {
  'use strict';

  var rows = {
    1: { pattern: 'slash',    life: 1.00, atk: 1.00, def: 1.00,
         name: 'Vigil',        desc: 'He only knows how to sweep you off the flagstones.' },
    2: { pattern: 'overhead',  life: 1.15, atk: 1.06, def: 1.00,
         name: 'Remembering',  desc: 'The arms remember an overhead. He starts using it.' },
    3: { life: 1.30, atk: 1.12, def: 1.05,
         name: 'Heavier',      desc: 'Whatever is holding the armour up is holding it tighter.' },
    4: { pattern: 'charge',    life: 1.45, atk: 1.18, def: 1.05,
         name: 'Hunting',      desc: 'He has learned to close the nave in one run. Move.' },
    5: { life: 1.62, atk: 1.24, def: 1.10,
         name: 'Older',        desc: 'The plate is thicker where you have been hitting it.' },
    6: { life: 1.80, atk: 1.32, def: 1.12,
         name: 'Practised',    desc: 'The wind-ups are the same. They arrive sooner.' },
    7: { life: 2.00, atk: 1.40, def: 1.16,
         name: 'Patient',      desc: 'He has stopped swinging at where you were.' },
    8: { life: 2.22, atk: 1.50, def: 1.20,
         name: 'Certain',      desc: 'Nothing about him hurries any more.' },
    9: { life: 2.46, atk: 1.60, def: 1.24,
         name: 'The Hollow',   desc: 'Whatever the armour was keeping in is all the way out.' }
  };

  /* 10-100: he keeps getting worse, on a curve that stays behind the player's
     own growth — the fight should get harder, not become arithmetic. */
  for (var L = 10; L <= 100; L++) {
    if (rows[L]) continue;
    var n = L - 9;
    rows[L] = {
      life: +(2.46 + n * 0.20).toFixed(2),
      atk:  +(1.60 + n * 0.055).toFixed(3),
      def:  +(1.24 + n * 0.030).toFixed(3),
      name: 'Deeper Still',
      desc: 'Round ' + L + '. He has been here longer than you have.'
    };
  }

  CHLOE.data.knighttree = {
    name: 'What The Armour Learns',
    maxLevel: 100,
    /* His level IS the round. Kept as a knob rather than hardcoded so the
       curve can be slowed later without touching the round counter. */
    levelPerRound: 1,
    rows: rows
  };
})();
