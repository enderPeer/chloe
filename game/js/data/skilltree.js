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
     4  ally + water_wave + key 4  Ash joins, and the way out of a corner
     5  stat           you get harder to kill
     6  hammer_fist    + key 5
     7  stat           the well gets deeper
     8  ember_jab      + key 6
     9  hollow_breaker + key 7     the early kit is complete

   Abilities and their keys arrive TOGETHER on purpose. Granting a move with
   nowhere to bind it reads as a bug, not a reward.

   §25: level 4 carries TWO grants. Water Wave was not given a row of its own
   because the authored 1-9 ladder is referenced by level number all over the
   spec (§21's table, §23's "level 3 is already correct"), and renumbering it to
   fit one ability in would invalidate every one of those. A row may carry any
   subset of the fields, so Ash and the wave arrive on the same level.

   That makes the key arithmetic exact, and it is now AT the cap: 7 ability keys
   by level 9 (1 base + 6 slot grants) + §23's 2 pockets = 9 = abilityConfig
   .maxSlots. There is no room left for a "Wider Grip" row, which is why the
   generated 10-100 loop below subtracts the pockets before deciding it may hand
   out another key. */
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
    /* §25: Ash AND the wave. The row that hands you a second body is also the
       row that teaches you the fight is about space, not damage — the wave
       throws whatever it catches to the SIDES and leaves a lane down the middle
       you can actually walk out through. */
    4:  { ally: 'ash', ability: 'water_wave', slot: 1, name: 'Ash, and the Water Wave',
          desc: 'Your sister catches up — she fights at her own level, and if you fall she takes the lead. You also learn to shove a wall of water out in front of you: it throws them aside instead of back, so there is a lane to leave by. Key 4.' },
    5:  { stat: { life: 12, stamina: 6 }, name: 'Roadworn',
          desc: '+12 life, +6 stamina.' },
    6:  { ability: 'hammer_fist', slot: 1, name: 'Hammer Fist',
          desc: 'One committed overhand. Slow, heavy, expensive. Key 5.' },
    7:  { stat: { magic: 8, mag: 2 }, name: 'Open Channel',
          desc: '+8 magic, +2 magic power.' },
    8:  { ability: 'ember_jab', slot: 1, name: 'Ember Jab',
          desc: 'A jab that lights on contact. Key 6.' },
    9:  { ability: 'hollow_breaker', slot: 1, name: 'Hollow Breaker',
          desc: 'A rising strike that hurts what armour cannot protect. Key 7 — the early kit is complete.' }
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
  /* Today: 1 + 6 = 7 ability keys by level 9, + 2 pockets = 9 = maxSlots. The
     hotbar is already full, so the loop below generates no key rows at all. */

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
