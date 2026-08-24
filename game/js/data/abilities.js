/* CHLOE — data/abilities.js  (Combat v3, spec §17)
   Real-time abilities bound to number keys 1-9.

   Schema
     id, name, icon, type            damage type (data/elements.js chart)
     desc                            one line shown in the bind screen + HUD
     cost:{sta?, mana?}              paid when the cast STARTS
     castMs                          wind-up before the hit lands (0 = instant)
     recoverMs                       locked out of other casts after the hit
     cooldownMs                      before this ability may be used again
     charges                         uses before it must recharge (1 = simple)
     rechargeMs                      per-charge refill (defaults to cooldownMs)
     range, arc                      metres / degrees of the hit test
     power                           % of atk (or mag when usesMag) per hit
     usesMag                         scale off mag instead of atk
     hits                            how many times one cast connects
     hitAtMs:[...]                   when each hit lands inside the cast
     anim                            clip in assets/3d/punch.glb etc.
     animSpeed                       playback rate multiplier
     grantedBy                       'start' = known at level 1, else a tree node

   Balance intent (§17): punch is the floor — free, spammable, weak. Everything
   the tree grants must beat it in damage-per-stamina or in reach. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.abilities = {
  punch: {
    id: 'punch', name: 'Rapid Punches', icon: '✊', type: 'physical',
    desc: 'A flurry of close-range punches. Cheap, fast, and weak — the move you always have.',
    cost: { sta: 8 },
    castMs: 260,          // wind-up before the first knuckle lands
    recoverMs: 240,
    cooldownMs: 700,
    charges: 1,
    range: 2.6, arc: 70,
    power: 45, usesMag: false,
    hits: 3,
    hitAtMs: [260, 500, 760],
    anim: 'Punch', animSpeed: 1.35,
    grantedBy: 'start'
  },

  /* Tree-granted. These reuse the punch rig with different timing, cost and
     damage type — the animation effort went into `punch` (§17). */
  hammer_fist: {
    id: 'hammer_fist', name: 'Hammer Fist', icon: '🤛', type: 'physical',
    desc: 'One committed overhand drop. Slow, expensive, hits like a dropped amp.',
    cost: { sta: 26 },
    castMs: 620, recoverMs: 420, cooldownMs: 3200, charges: 1,
    range: 2.9, arc: 55,
    power: 190, usesMag: false,
    hits: 1, hitAtMs: [620],
    anim: 'Punch', animSpeed: 0.55,
    grantedBy: 'tree'
  },
  ember_jab: {
    id: 'ember_jab', name: 'Ember Jab', icon: '🔥', type: 'fire',
    desc: 'A jab that lights on contact. Costs magic, burns what resists steel.',
    cost: { mana: 14, sta: 6 },
    castMs: 340, recoverMs: 260, cooldownMs: 2400, charges: 2, rechargeMs: 3600,
    range: 3.1, arc: 60,
    power: 130, usesMag: true,
    hits: 1, hitAtMs: [340],
    anim: 'Punch', animSpeed: 1.15,
    grantedBy: 'tree'
  },
  /* §18 signature spell: you raise a hand, a burning sigil spins up off your
     fingers, and a tornado of fire drops on the knight. Long cast, long
     cooldown, expensive — the payoff move. */
  fire_tornado: {
    id: 'fire_tornado', name: 'Fire Tornado', icon: '🌪', type: 'fire',
    desc: 'Trace the sign and drop a pillar of fire on them. Long cast, long cooldown — do not start it while he is winding up.',
    /* Priced to be castable on a base 20-magic pool — an unaffordable
       signature move is just a greyed-out button. It still empties you. */
    cost: { mana: 18, sta: 12 },
    castMs: 1250, recoverMs: 520, cooldownMs: 12000, charges: 1,
    range: 7.5, arc: 80,
    /* High power on purpose: the type chart HALVES fire against the knight's
       occult type, so a "normal" number would make the signature move worse
       than a free punch. At 0.5x this still lands ~40-48 over four ticks. */
    power: 210, usesMag: true,
    hits: 4, hitAtMs: [1250, 1600, 1950, 2300],
    cast: 'sign',            // hand-sign cast pose (§18)
    vfx: 'tornado',
    grantedBy: 'tree'
  },
  /* §21 level 3: the first thing you can throw. You point, you shove both
     hands up, and a burning rock comes down through the roof onto the spot.

     `splash` is what makes it worth a key: unlike every arc ability above,
     it damages EVERY knight within `splashRadius` of where it lands, so it is
     the answer to a round that fields six of them. One hit, no arc, no reach
     check against your own facing - the aim is where you are looking. */
  asteroid: {
    id: 'asteroid', name: 'Asteroid', icon: '☄', type: 'fire',
    desc: 'Call a burning rock down out of the roof. It falls where you aim and everything near the crater takes it.',
    /* 14, not the 24 it shipped at (§23). The ladder grants asteroid one level
       AFTER fire_tornado, so the newer spell cost MORE mana (24) than the earlier,
       stronger one (18) — and on the ~26-magic pool you actually have at level 3
       one cast left you with 2: not enough for a rock, a tornado or even an ember
       jab, so the round went back to punching while you waited on regen. At 14 you
       keep enough to still be a caster, and the second rock is affordable long
       before the 9s cooldown is up. Stamina stays 10 — the arm was never the
       problem, and it keeps evade (22 sta) competing for the same bar. */
    cost: { mana: 14, sta: 10 },
    /* Long enough to read as a real cast, short enough that you can still
       fit one in between his swings. The fall itself is the wind-up you
       watch, so the damage lands at the END of it. */
    castMs: 900, recoverMs: 460, cooldownMs: 9000, charges: 1,
    range: 14.0, arc: 360,        // aimed, not swung - the whole nave is in reach
    power: 165, usesMag: true,
    hits: 1, hitAtMs: [1750],     // 900 cast + ~850 fall from the vault
    cast: 'sign',                 // both hands up, sigil at the fingertips
    vfx: 'asteroid',
    splash: true, splashRadius: 3.4,
    /* Impact stun (§23). This is NOT a new status: it drives the §22 `stagger`
       state, so the pose, the "cannot attack / cannot move" rules and the
       staggerTakeMult damage bonus are the ones the knight already has. Every
       knight inside splashRadius at the impact frame gets it, which is the whole
       reason the rock is worth one of the nine keys against a squad — the damage
       alone loses to fire_tornado. Callers must REFRESH, not stack
       (staggerT = max(current, ms/1000)), or two rocks would lock a knight out
       of the fight for three seconds. */
    stun: { ms: 1500 },
    fallMs: 850, fallFrom: 11.0,  // metres above the floor it starts
    grantedBy: 'tree'
  },
  hollow_breaker: {
    id: 'hollow_breaker', name: 'Hollow Breaker', icon: '✨', type: 'divine',
    desc: 'A rising strike that hurts the things armour cannot protect.',
    cost: { mana: 22, sta: 14 },
    castMs: 520, recoverMs: 380, cooldownMs: 6000, charges: 1,
    range: 3.0, arc: 65,
    power: 165, usesMag: true,
    hits: 2, hitAtMs: [520, 760],
    anim: 'Punch', animSpeed: 0.85,
    grantedBy: 'tree'
  }
};

/* Number-key loadout (§17): how many of the 9 slots are unlocked.
   One slot at level 1; the tree's keybind nodes raise the cap. */
CHLOE.data.abilityConfig = {
  maxSlots: 9,
  baseSlots: 1,
  // evade is a fixed control, not a slot — listed here so the HUD can show it
  evade: {
    name: 'Evade', cost: { sta: 22 }, cooldownMs: 900,
    distance: 3.4, durationMs: 260, iframeMs: 220
  },
  sprint: { staPerSec: 12 },
  regen: { staPerSec: 9, manaPerSec: 2.5, delayAfterUseMs: 700 }
};
