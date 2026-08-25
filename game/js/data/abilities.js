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
  /* §25 level 4: the answer to being cornered. A wall of water shoved out in
     front of you that throws the knights standing in it to the SIDES.

     It is a MOBILITY tool that happens to do damage, not a spell. Everything
     below is priced off that: it is the cheapest thing you can cast, it comes
     back fastest, and it hits for less than a single punch. If it ever becomes
     the move you open with, the numbers are wrong.

     Type `magical`, NOT a twelfth type. The §12 chart is 11x11 and closed —
     `frost` already migrated into `magical` (elements.js OLDMAP), so a new
     `water` row would mean 11 new attack multipliers AND 11 new defence ones,
     for one ability. `magical` reads 1.0x against the knight's `occult`, which
     is a deliberate side effect worth naming: fire is chart-HALVED against him,
     so an un-halved wave would out-damage the fire kit at a third of the cost
     if its power were anywhere near theirs. That is exactly why power is 40. */
  water_wave: {
    id: 'water_wave', name: 'Water Wave', icon: '🌊', type: 'magical',
    desc: 'Shove a wall of water out in front of you. It throws whatever it catches aside and leaves you a lane to walk through.',
    /* Cheapest cast in the kit, and it has to be: an escape you cannot afford
       when you are cornered is not an escape. On the level-4 pool it arrives on
       (Chloe magic 20 + 3*(4-1) = 29, stamina 40 + 3*3 = 49, no ladder stat rows
       before level 5) that is TWO waves back to back with 9 magic to spare, or a
       wave after an asteroid (14) with 5 left. Against fire_tornado 18 / asteroid
       14 / hollow_breaker 22 it is the only spell you can cast while broke.
       Stamina 8 matches punch and is deliberately far under evade's 22: when the
       stamina bar is dry from sprinting is precisely when you need the lane, so
       the wave must not compete with evade for the same empty bar. */
    cost: { mana: 10, sta: 8 },
    /* Fast. You cast this because something is already swinging, so a
       fire_tornado-length 1250ms wind-up would get you killed mid-cast. The
       whole lock is 420 + 240 = 660ms, and the shove finishes inside it, so you
       are free to run the moment the water lands. */
    castMs: 420, recoverMs: 240,
    /* Short relative to the offensive spells (tornado 12000, asteroid 9000,
       breaker 6000) because its job is escape and a cornering happens more
       often than once every nine seconds. It is not free either: at the
       abilityConfig regen of 2.5 magic/s, 4500ms buys back 11.25 magic against
       a 10 cost — so the cooldown and the price are tuned to arrive together
       and neither one alone is the limit. */
    cooldownMs: 4500, charges: 1,
    /* The cone, stated both ways because two different consumers read it:
       `range`/`arc` are the schema fields arena3d.abilityTargets tests (it
       compares against cos(arc/2), so `arc` is the FULL angle), and `cone`
       states the same shape as the reach and HALF-angle the VFX and any future
       shove test should be authored from. arc === cone.halfAngle * 2 by
       construction — if you change one, change both. 6m of reach catches a line
       that is already closing; 40 degrees either side is wide enough to take a
       fanned squad (§20 spawns them abreast) without being a 360 nuke. */
    range: 6.0, arc: 80,
    cone: { reach: 6.0, halfAngle: 40 },
    /* Lowest power in the game, on purpose. At level 4 (mag 17, knight def 5):
       wave 17*0.40*1.0 - 2.5 = ~4 damage. One punch HIT is 22*0.45*1.0 - 2.5 =
       ~7 and punch throws three of them for 8 stamina (~22 total); ember_jab is
       ~9, asteroid ~12, one tornado tick ~15. So the wave loses to the free
       move it sits next to, and it loses per-magic to everything else — the
       damage is a courtesy, the displacement is the ability. */
    power: 40, usesMag: true,
    hits: 1, hitAtMs: [420],
    cast: 'sign',            // both hands out — same cast pose key as tornado/asteroid
    vfx: 'wave',
    /* THE DISPLACEMENT IS LATERAL, NOT BACKWARD. Each knight the cone catches is
       thrown perpendicular to YOUR facing, toward whichever side he is already
       nearest — so a knight slightly left of your look goes further left, one
       slightly right goes right, and the wave PARTS the line instead of shoving
       it back as a wall. That is the entire point: pushing them straight back
       just re-forms the same wall a few metres away and leaves you still
       cornered, whereas parting them opens a lane down the middle you can walk.
       Distance is sized off that lane: the player body is 0.35m, a knight 0.55m,
       and `arena.knightMinDist` is 1.3m, so a knight standing dead ahead has to
       end up ~2.2m off your centre line to stop blocking it. 3.2m clears that
       with ~1m of slack for the containment clamp to eat when he is thrown
       toward stone or the Ring's kerb (§24/§25: arena3d.shove clamps and stops
       SHORT, it never teleports him out of the world). 300ms of travel puts him
       at roughly evade speed — it reads as being thrown, not cutting.
       `breaksWindup` is the §25 clearAttack: a knight mid-swing drops it.
       There is deliberately NO `stun` block here — the stun is the asteroid's
       (§23) and duplicating it would make the cheap escape the best control
       tool in the kit. He loses his footing, then he comes back. */
    shove: { distance: 3.2, ms: 300, lateral: true, breaksWindup: true },
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
