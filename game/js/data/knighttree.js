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
   growth, and honest about it.

   EVERY pattern in data/arena3d.js must appear on a row here, because this
   table is the only thing that unlocks them: ui/battle3d.js rolls its swing
   out of knighttree.patterns(level), so a pattern nobody's row names is
   content that ships and is never once thrown. §22's two additions took the
   free slots at 3 and 5 — the rounds that were pure stat growth — which
   leaves §21's authored 1 slash / 2 overhead / 4 charge exactly where it was. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

(function () {
  'use strict';

  var rows = {
    1: { pattern: 'slash',    life: 1.00, atk: 1.00, def: 1.00,
         name: 'Vigil',        desc: 'He only knows how to sweep you off the flagstones.' },
    2: { pattern: 'overhead',  life: 1.15, atk: 1.06, def: 1.00,
         name: 'Remembering',  desc: 'The arms remember an overhead. He starts using it.' },
    3: { pattern: 'thrust_combo', life: 1.30, atk: 1.12, def: 1.05,
         name: 'Quicker',      desc: 'Two stabs and a step through them. He has stopped swinging in one piece.' },
    4: { pattern: 'charge',    life: 1.45, atk: 1.18, def: 1.05,
         name: 'Hunting',      desc: 'He has learned to close the nave in one run. Move.' },
    5: { pattern: 'ground_slam', life: 1.62, atk: 1.24, def: 1.10,
         name: 'Heavier',      desc: 'He has worked out that you live inside his guard. The floor answers for it.' },
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

  /* §28 A — EVERY KNIGHT SPAWNS AT LEVEL 1 AND GROWS DURING THE FIGHT.
     Until now `level()` was a pure function of the round, so a round-6 squad
     was six identical level-6 knights and not one of them changed while you
     fought it. The round still sets the CEILING (see `overCap`); what a knight
     actually is at any moment is now his own number, and the floor therefore
     holds a spread.

     The trigger is seconds alive in the fight — the only clock every knight
     shares, and the one that makes "he has been standing here a while" the
     thing that makes him dangerous. Rate varies by the §22 personality he was
     dealt at spawn, because if all six start at 1 and climb at one rate they
     are identical again by construction:

       personality  seconds/level        starts at   reaches lv 6 (round 6)
       aggressive   6.0 x 0.70 =  4.2        1            21.0s
       cautious     6.0 x 1.00 =  6.0        1            30.0s
       brute        6.0 x 1.45 =  8.7        2            34.8s

     THE BRUTE IS SLOWEST FROM A HARDER BASE: he opens a level up (so he
     already knows the overhead when the others only know the slash) and then
     climbs slowest, which is exactly the §22 temperament — heavy, and not in
     a hurry. The aggressive knight overtakes him at 8.4s and is a level clear
     by 12.6s.

     BALANCE, said out loud — REWRITTEN FOR §30, because §28's version of
     this paragraph described a squad that no longer exists. §28 opened every
     knight at level 1 and let seconds alive do all the work; §30 opens him
     at his SENIORITY (index 0 has come back N times and opens at N, the
     newcomer opens at 1) and lets seconds climb from there.

     What that costs, measured on this table rather than guessed. A round-5
     squad at t=0: §28 fielded five knights at life x1.00 (5.00x total);
     the old pre-§28 game fielded five flat level-5s at x1.62 (8.10x); §30
     fields 1.62 + 1.45 + 1.30 + 1.15 + 1.00 = 6.52x. So round 5 sits BELOW
     the old flat squad and above §28's opening — which is the intent: the
     round grows in threat more slowly than it grows in number, and the
     danger is concentrated in one veteran instead of smeared over five
     equals. If a late round starts feeling thin, the knob is the veteran's
     climb (`rate`) or `overCap`, NOT the count and NOT `levelPerRound` —
     the count is the §20 contract and levelPerRound moves the whole ladder.

     The climb still matters and still separates temperaments: slowing
     `secondsPerLevel` past ~7 flattens the in-fight ramp that makes a long
     round dangerous; speeding it below ~5 skips the readable window where
     the junior half still only knows the slash, which is most of what makes
     the spread visible on the floor.

     `overCap` is what stops a long fight spiralling, and §30 changed WHAT IT
     IS MEASURED FROM. Under §28 it was two levels past the ROUND's baseline,
     which meant a long round-5 fight ended with five knights all at 7 — the
     ladder evaporated exactly when the fight had run long enough for it to
     matter. It is now two levels past THAT KNIGHT's own opening level, so
     the veteran still tops out where §28 put him (round + overCap, since his
     opening level is the round) and the newcomer tops out at 3. Verified in
     a real round-5 fight: spawn [5,5,3,2,2] climbing to [7,7,5,4,4], where
     §28's rule gave [7,7,7,7,7]. A round-1 fight you refuse to end still
     produces a level-3 knight and never a level-9 one. */
  var growth = {
    trigger: 'aliveSeconds',
    startLevel: 1,
    secondsPerLevel: 6.0,
    // multiplier on secondsPerLevel — bigger is SLOWER
    rate: { aggressive: 0.70, cautious: 1.00, brute: 1.45 },
    // levels granted at spawn on top of startLevel
    baseBonus: { aggressive: 0, cautious: 0, brute: 1 },
    overCap: 2,
    /* How long the level-up tell burns. Long enough to notice across the
       nave, short enough that a knight levelling mid-swing does not read as a
       second attack starting. */
    tellMs: 800
  };

  CHLOE.data.knighttree = {
    name: 'What The Armour Learns',
    maxLevel: 100,
    /* The ROUND BASELINE. This is no longer "his level" — it is the level the
       round is worth, which the poster and the HUD name, which `combat3`
       prices the squad off before anyone has grown, and which caps how far a
       knight may climb. Kept as a knob rather than hardcoded so the curve can
       be slowed later without touching the round counter. */
    levelPerRound: 1,
    growth: growth,
    rows: rows
  };
})();
