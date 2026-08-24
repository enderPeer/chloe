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
