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

   The shape of the first nine (§29 rewrote 5-9):
     1  punch          + key 1     your hands
     2  fire_tornado   + key 2     the first spell
     3  asteroid       + key 3     the first ranged spell
     4  ally + water_wave + key 4  Ash joins, and the way out of a corner
     5  9mm gate off   the pistol's stamina cost drops 18 -> 10
     6  +1 keybind     key 5, empty and yours
     7  stat           you get harder to kill
     8  stat           the well gets deeper
     9  killer_fist    + key 6     the early kit is complete

   Abilities and their keys arrive TOGETHER on purpose. Granting a move with
   nowhere to bind it reads as a bug, not a reward.

   §29, AND THE ONE EXCEPTION TO THAT RULE. Levels 5, 6 and 8 used to be a fist,
   a fist and a fist — `hammer_fist`, `ember_jab`, `hollow_breaker`, three price
   tags on one animation (see data/abilities.js). Three of the nine authored
   levels were spent teaching arithmetic. They collapse into one survivor,
   `killer_fist` at 9, and the freed rows become the things the ladder was short
   of: a weapon that changes where you can stand, an EMPTY key, and two stats.

   The gun still arrives with somewhere to put it — it just is not a number key.
   §27B put mouseL/mouseR outside the nine, so `gun_9mm` auto-binds to mouseR
   (data/abilities.js `bindsTo`) and row 5 grants no `slot` at all. Level 6's
   keybind is therefore the first row in the game that hands you a key with
   NOTHING on it, which is deliberate: by then you own six abilities, two
   pockets and a bandage habit, and an empty key is a real choice rather than a
   place to put your reward.

   §25: level 4 carries TWO grants. Water Wave was not given a row of its own
   because the authored 1-9 ladder is referenced by level number all over the
   spec (§21's table, §23's "level 3 is already correct"), and renumbering it to
   fit one ability in would invalidate every one of those. A row may carry any
   subset of the fields, so Ash and the wave arrive on the same level.

   THE KEY ARITHMETIC, RECOUNTED FOR §29 (this bit bit §25; check it again if
   you touch a row). Before: 1 base + 6 slot grants = 7 keys by level 9, + §23's
   2 pockets = 9 = abilityConfig.maxSlots, exactly full, and the generated
   10-100 loop could never hand out another key.
   After: rows 2, 3, 4, 6 and 9 grant a slot each — FIVE, not six, because the
   gun took a mouse button instead — so it is 1 + 5 = 6 keys by level 9, + 2
   pockets = 8. One slot short of the cap, which the generated loop then hands
   out at level 12 ('Wider Grip'), reaching 7 + 2 = 9 and stopping. Nothing
   below is hardcoded to any of those numbers: `slotsSoFar` is summed from the
   rows and `keyCap` is derived from maxSlots minus the pockets, so this
   paragraph is a description of what the loop computes and never an input to
   it. That is the point — §25's bug was a literal that stopped being true. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

(function () {
  'use strict';

  var rows = {
    /* §31: the night opens with BOTH hands full — the fist seeded onto the
       left mouse button, the 9mm claiming the right through its own `bindsTo`
       preference (data/abilities.js). Two abilities on one row is new and the
       engine takes an array; row 1 is the only row that does it, because a
       mouse with one button bound is not a hotbar.
       ORDER MATTERS: the fist is first because known[0] is what combat3's
       key-1 default reaches for, and a player whose key 1 held a pistol they
       cannot aim with the keyboard would have been handed a joke.
       The gun was §29's row 5. It moved here on the player's instruction; what
       row 5 was really protecting was its UPTIME, and that is preserved by the
       18-stamina price it now arrives with. See row 5. */
    1:  { ability: 'gun_9mm', slot: 0, name: 'Akimbo',
          desc: 'Two pistols, one in each hand. Left click and right click to fire — six shots, then a reload. Aim for the head.' },
    2:  { ability: 'fire_tornado', slot: 1, name: 'Fire Tornado',
          desc: 'Trace the sign and drop a pillar of fire on him. Comes with key 2.' },
    /* §21: the first thing you can throw. Everything before this needed you
       to be standing next to him. */
    3:  { ability: 'asteroid', slot: 1, name: 'Asteroid',
          desc: 'Call a burning rock down out of the roof. It falls where you point and everything near the crater takes it. Key 3.' },
    /* §25: Ash AND the wave. The row that hands you a second body is also the
       row that teaches you the fight is about space, not damage — the wave
       throws whatever it catches to the SIDES and leaves a lane down the middle
       you can actually walk out through. */
    4:  { ally: 'ash', ability: 'water_wave', slot: 1, name: 'Ash, and the Water Wave',
          desc: 'Your sister catches up — she fights at her own level, and if you fall she takes the lead. You also learn to shove a wall of water out in front of you: it throws them aside instead of back, so there is a lane to leave by. Key 4.' },
    /* §29: NO `slot`. The gun binds itself to a mouse button, which is why
       this row is affordable at all — see the arithmetic in the header. Say
       so in the desc, because a row that grants a move and no key would
       otherwise read as the bug §21 warns about. */
    /* §31: the gun arrived at row 1, so row 5 now sells what row 5 was really
       protecting — its UPTIME. 18 -> 10 stamina a shot.

       WHY STAMINA IS THE ONLY KNOB THAT WORKS. The magazine is not the
       constraint (six rounds, but a 40-point bar at 18 funds two) and the
       reload only bites if you empty a magazine, which stamina stops you
       doing. Damage is the wrong lever in the other direction: a weak pistol
       reads as a bad gun rather than an early one.

       AND WHY 18 IS PRICED ON THE CLOCK RATHER THAN AS A BUDGET. Stamina
       regenerates at 9/s (combat3), so 18 is refunded in 2.0 seconds — against
       knight telegraphs of 1500ms (slash) to 2100ms (ground slam). Firing once
       leaves exactly one evade intact (40 - 18 = 22, and an evade costs 22);
       firing twice empties you, and climbing back to evade cost takes almost
       exactly one wind-up. The second shot is a bet that his swing outlasts
       your stamina. At 10 that bet stops existing, which is what this row
       sells. (§29 authored the weapon and the 10; §31 moved the row and priced
       the 18.) */
    5:  { costMod: { gun_9mm: { sta: 8 } }, name: 'Trigger Discipline',
          desc: 'The 9mm costs 8 stamina a shot instead of 10. Same guns, less breath — and you keep a dodge in the bank while you use them.' },
    6:  { slot: 1, name: 'Wider Grip',
          desc: '+1 ability keybind — key 5, and it arrives EMPTY. Put a bandage on it, or the move you keep forgetting you own.' },
    7:  { stat: { life: 12, stamina: 6 }, name: 'Roadworn',
          desc: '+12 life, +6 stamina.' },
    8:  { stat: { magic: 8, mag: 2 }, name: 'Open Channel',
          desc: '+8 magic, +2 magic power.' },
    9:  { ability: 'killer_fist', slot: 1, name: 'Killer Fist',
          desc: 'A rising strike that hurts what armour cannot protect. Key 6 — the early kit is complete.' }
  };

  /* 10-100: growth, and honest about it. Widen the hotbar toward its cap,
     then steady stats. New authored abilities drop straight into `rows`
     above and override the generated entry for that level. */

  /* §25: this counter used to be the literal 6 and the gate used to be the
     literal 9, and both were wrong the moment level 4 started granting a key.

     Counted, not written down: adding an authored row must never require
     remembering to bump a number down here, because the failure mode is silent
     — the ladder just quietly hands out a tenth key.

     The cap is maxSlots MINUS the pockets. §23 gives every character
     `config.pocketSlots` generic keys from level 1 that the ladder never grants,
     and combat3.slotCount adds them on top of what we hand out here before
     clamping to maxSlots. So a ladder that counts only its own ability keys and
     stops at 9 is really asking for 9 + pockets = 11, and the clamp would eat
     the difference: two "Wider Grip" rows that promise a key and deliver
     nothing. Read the real constants — a literal 2 here would be a second place
     for the pocket count to live and disagree from.

     Degrading to 0 pockets when config is absent matches combat3.pocketSlots()
     exactly, so the two halves agree about the cap even when they are wrong. */
  var ACFG = CHLOE.data.abilityConfig || {};
  var GCFG = CHLOE.data.config || {};
  var maxSlots = ACFG.maxSlots || 9;
  var pockets = (typeof GCFG.pocketSlots === 'number' && GCFG.pocketSlots > 0) ? GCFG.pocketSlots : 0;
  var keyCap = Math.max(1, maxSlots - pockets);   // ability keys the ladder may grant

  var slotsSoFar = ACFG.baseSlots || 1;           // key 1 comes free, before any row
  for (var A = 1; A <= 9; A++) {
    if (rows[A]) slotsSoFar += rows[A].slot || 0;
  }
  /* §29: 1 + 5 = 6 ability keys by level 9, + 2 pockets = 8, one under the cap
     — the gun rides a mouse button and asked for none. The loop below is what
     spends that last slot, at level 12, and then stops: 7 + 2 = 9 = maxSlots.
     Recount here rather than trusting this comment if you add or remove a row;
     the sum above is the live one. */

  for (var L = 10; L <= 100; L++) {
    if (rows[L]) continue;
    if (L % 4 === 0 && slotsSoFar < keyCap) {
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
