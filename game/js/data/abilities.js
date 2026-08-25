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
     magazine                        §29: `charges` is a MAGAZINE, not a trickle
     range, arc                      metres / degrees of the hit test
     hitscan                         §29: a straight ray, not an arc (see below)
     rayRadius, falloff              hitscan only — how fat the ray is, and how
                                     damage decays with distance
     power                           % of atk (or mag when usesMag) per hit
     usesMag                         scale off mag instead of atk
     hits                            how many times one cast connects
     hitAtMs:[...]                   when each hit lands inside the cast
     anim                            clip in assets/3d/punch.glb etc.
     animSpeed                       playback rate multiplier
     bindsTo:{mouse:[...]}           §29: where this auto-binds, if not a key
     grantedBy                       'start' = known at level 1, else a tree node

   `magazine` vs plain `charges`, because the two read the same and are not:
   plain charges dribble back ONE at a time, each costing `rechargeMs` — two
   charges at 3600ms means the second use is available 3.6s after the first
   empties, and full again 7.2s after that. A magazine is emptied and then
   RELOADED as a block: nothing comes back until the last round is gone, and
   then all of it does, once, `rechargeMs` later. `engine/combat3.js tick()`
   owns that split; the flag is here because it is a property of the weapon.

   Balance intent (§17): punch is the floor — free, spammable, weak. Everything
   the tree grants must beat it in damage-per-stamina or in reach. §29 adds the
   first thing that deliberately LOSES to punch per stamina and wins on reach —
   read gun_9mm's block for the arithmetic. */
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

  /* §29 DELETED HERE: `hammer_fist` and `ember_jab`.

     They and `hollow_breaker` all carried `anim: 'Punch'`, range 2.9-3.1,
     arc 55-65, one target. That is not three moves, it is one move with three
     price tags — and the authored 1-9 ladder was spending THREE of its nine
     levels handing it to you again. What each level actually taught you was
     an arithmetic difference. The survivor is `killer_fist` (below), which
     keeps the mechanics that were genuinely its own: divine damage, so it is
     the one fist the black plate does not blunt, and two hit windows.
     Do not re-add a mid-priced punch. If a fist wants a row, it has to do
     something the others cannot. */

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
       14 / killer_fist 22 it is the only spell you can cast while broke.
       Stamina 8 matches punch and is deliberately far under evade's 22: when the
       stamina bar is dry from sprinting is precisely when you need the lane, so
       the wave must not compete with evade for the same empty bar. */
    cost: { mana: 10, sta: 8 },
    /* Fast. You cast this because something is already swinging, so a
       fire_tornado-length 1250ms wind-up would get you killed mid-cast. The
       gun is faster still (90ms, §29) and that is the point of it — but the
       gun does not move anybody, so it is not this ability's competition. The
       whole lock is 420 + 240 = 660ms, and the shove finishes inside it, so you
       are free to run the moment the water lands. */
    castMs: 420, recoverMs: 240,
    /* Short relative to the offensive spells (tornado 12000, asteroid 9000,
       killer_fist 6000) because its job is escape and a cornering happens more
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
       ~7 and punch throws three of them for 8 stamina (~22 total); asteroid is
       ~12, one tornado tick ~15, and one 9mm round (level 5, §29) ~25 for no
       magic at all. So the wave loses to the free
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
  /* §29 level 5: a 9mm pistol, and the first weapon in the game that does not
     require you to be standing in his reach.

     ===================================================================
     HITSCAN, AND WHAT THAT COSTS THE REST OF THE FILE
     ===================================================================
     `hitscan: true` means engine/arena3d.js resolves this with a STRAIGHT RAY
     from the muzzle (A.hitscan), not with the reach+arc cone every other
     ability is priced by. That is not a cosmetic difference: an arc that is
     narrow enough to feel like aiming (say 8°) still spans 1.9m of floor at
     14m, so at range a "narrow arc" is a lane you cannot miss out of, and at
     point-blank it is a cone you cannot miss INTO. A ray misses by a
     centimetre and hits by a centimetre at every distance, which is the only
     honest way to make aiming the skill. `arc: 0` is stated below so anything
     that reads `arc` without noticing `hitscan` gets a cone of zero width and
     hits nothing, rather than silently inheriting a 60° default swing.

     `rayRadius` is how fat the bullet is: 0.55m, which is KNIGHT_RADIUS
     exactly — the ray is thin and the TARGET is a knight-wide vertical
     capsule, so "the line touches his body" is the whole test. It is deliberately
     not padded: the sights are the crosshair, and a bullet that lands because
     the engine widened the target by a hand's breadth teaches nothing.
     Several knights on one line: the NEAREST one eats it. A bullet does not
     pick a favourite and it does not pass through the first body.

     ===================================================================
     THE NUMBERS, AND WHY THEY ARE NOT STRICTLY BETTER THAN WALKING IN
     ===================================================================
     At the level it arrives on (5): Chloe atk 12 + 2*4 + 4 (Crimson Fret) =
     24, the knight's def 5, and `physical` reads 1.0 against him — his plate
     `resists:{physical:1.0}` overrides the chart's 2x, exactly as it does for
     your fists, so the gun buys no type advantage either.

     MEASURED through combat3.hitEnemy with the 0.9-1.1 roll pinned to 1.0 —
     these are outputs, not intentions:

       move                       dmg   sta   dmg/sta   reach    window
       punch (3 hits)              24     8      3.00    2.6m    1.00s lock
       gun, one round              25    10      2.50    22m     0.22s lock
       gun, a whole magazine (6)  150    60      2.50    22m     1.6s + 3.2s reload
       hammer_fist (§29 deleted)   43    26      1.65    2.9m    1.04s + 3.2s cd

     Read the first two rows together, because they are the design: ONE round
     is one entire punch flurry, delivered in a fifth of the time from across
     the arena — and it costs 25% MORE stamina to do it. The gun is the worst
     damage-per-stamina in the kit that is not the water wave. It buys reach
     and burst; it never buys efficiency, so closing to melee is still the way
     you actually kill things when you can afford to be there.
     Against the fist §29 deleted it is not close, and that is the argument for
     deleting it: hammer_fist asked 26 stamina to stand inside his sword for a
     number the gun beats for 10 at 22 metres.

     THE MAGAZINE IS THE GATE, NOT THE STAMINA. 10 stamina is cheap enough to
     mash — the level-5 pool is 40 + 3*4 = 52, so a full bar is five trigger
     pulls in a second and a half. `charges: 6` sets the burst at six, which is
     one more than the pool can pay for: you cannot empty a full magazine from
     a full stamina bar. Whichever runs out first, you are then standing there
     with no evade (22 sta) for 3.2 seconds. That is the price and it is the
     whole tension — the reload lands when you chose badly, not on a timer.

     A HALF-EMPTY MAGAZINE NEVER TOPS ITSELF UP. `magazine: true` reloads only
     from empty (combat3.tick), so two rounds left are two rounds left until
     you spend them. That is deliberate: it means the reload is something you
     TRIGGER by dumping the mag, at a moment of your choosing, instead of a
     background timer that quietly forgives you.

     RANGE 22m, and 14 of it is free. Full power to 14m — the Ring's own radius
     (§24: bodies clamp at r=14) — so anywhere in the church, and most of the
     Ring, a hit is a hit at face value. From 14 to 22 it falls linearly to
     0.6x, and past 22 the ray simply stops: a knight hugging the far kerb
     while you hug yours (28m apart) is out of the fight, which is the thing
     that stops the gun trivialising the biggest floor in the game. */
  gun_9mm: {
    id: 'gun_9mm', name: '9mm', icon: '🔫', type: 'physical',
    desc: 'A pistol. It hits where the crosshair is, as far as you can see, and it holds six.',
    cost: { sta: 10 },
    /* Almost no wind-up: the trigger IS the cast. 90ms is one frame of arm
       before the flash so the shot has a moment to belong to, and 130ms of
       recover so a full magazine is a stutter of six rather than one press.
       The 280ms cooldown is the FIRE RATE and it is the thing that actually
       limits the burst (220ms of lock < 280ms), which is where a fire rate
       belongs — in one number, not smeared across the lock. */
    castMs: 90, recoverMs: 130, cooldownMs: 280,
    /* Six up the pipe, and 3.2s to put six more in. See the block above for
       why 6 is one more than the stamina bar can pay for. */
    charges: 6, magazine: true, rechargeMs: 3200,
    hitscan: true,
    range: 22.0, arc: 0, rayRadius: 0.55,
    /* Full damage inside one Ring radius, then a linear slide to `min` at
       `max`. Stated as three numbers rather than a curve because the engine
       hands the result straight to combat3.hitEnemy as its `mult`, the same
       argument the §22 stagger bonus rides on — so distance and footing are
       priced by one multiplication and neither can hide inside the other. */
    falloff: { full: 14.0, max: 22.0, min: 0.6 },
    power: 115, usesMag: false,
    hits: 1, hitAtMs: [90],
    vfx: 'gunshot',
    /* §29: IT LIVES ON THE MOUSE, WHICH IS WHY THE LADDER CAN AFFORD IT.
       §27B put mouseL/mouseR outside the nine number keys, so this ability
       costs the hotbar nothing — its ladder row (data/skilltree.js level 5)
       grants no `slot`, and the arithmetic there is recounted for it.
       `mouseR` first so mouseL keeps the hands: in the ROOM the mouse still
       opens and closes them and grabs (§16), and left is the one the player's
       muscle memory has already spent on that. The list is a PREFERENCE, in
       order — engine/combat3.js takes the first free one, falls through to a
       number key if the player has filled both, and never evicts anything. */
    bindsTo: { mouse: ['mouseR', 'mouseL'] },
    grantedBy: 'tree'
  },
  /* §29: the surviving fist. This is `hollow_breaker` renamed — id AND label —
     not a new move: divine damage, two hit windows, the rising strike, all
     unchanged. The id changed with the name because there are no saves (§15)
     to migrate and a stale id is exactly how the next reader concludes the two
     were different moves. Grep proves nothing references the old one.

     It reuses the punch rig at different timing and type; the animation effort
     went into `punch` (§17). What earns it a row is the TYPE: divine reads 2.0
     against his occult, and his plate only blunts `physical`, so this is the
     one hand-to-hand option the armour does nothing about. Measured at level 9
     (mag 29, his def 6.2): 93 a hit, twice, 186 for one press — against 34 for
     one 9mm round at the same level. Closing the distance is still how you
     actually kill him; the pistol is how you survive getting there. */
  killer_fist: {
    id: 'killer_fist', name: 'Killer Fist', icon: '✨', type: 'divine',
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
