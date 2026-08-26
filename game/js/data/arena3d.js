/* CHLOE — data/arena3d.js
   Config for the 3D battle arena (spec §16): the old church where every
   battle happens. Pure data: model paths, spawns, bounds, light rig, and the
   knight's attack patterns (telegraph time + hit volume + how to evade).
   Consumed by engine/arena3d.js (visuals/hit tests) and ui/battle3d.js
   (prompts). Distances in meters, arena centered on origin. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.arena3d = {
  /* Bump assetVersion whenever a .glb here is rebuilt: the loaders append it
     as ?v=N so browsers that cached an older build refetch instead of
     rendering the stale one (a cached all-black church looked like "no
     textures" long after the fix shipped). */
  assetVersion: 7,
  models: {
    church: 'assets/3d/church.glb',
    knight: 'assets/3d/knight.glb',
    punch:  'assets/3d/punch.glb',
    tornado: 'assets/3d/firetornado.glb',
    handsign: 'assets/3d/handsign.glb',
    asteroid: 'assets/3d/asteroid.glb',
    /* §29. Built by tools/convert-gun9mm.js: normalised to 1.000m along its
       barrel axis, barrel down -Z, one material, Draco'd, with `Muzzle` and
       `Grip` empties the first-person rig mounts from. engine/gunrig.js reads
       this key and falls back to the same literal path if it is missing, so
       the entry exists mainly to keep every model URL in one table — and to
       stay inside versioned(), which is what makes a rebuilt GLB refetch. */
    gun: 'assets/3d/gun9mm.glb'
  },

  /* §29 THE SHOT'S PICTURES — the muzzle flash and the tracer.
     Separate from `gunProp` (engine/gunrig.js, which owns where the pistol
     sits in the hand) because these two describe the SHOT, not the weapon:
     they exist for 55 and 60 milliseconds respectively and nothing about them
     changes if the prop is re-placed.
     `flashSize` is the flash quad's width in metres AT the muzzle — 0.22 is
     about the length of the gun, which is roughly what a 9mm flash looks like
     and comfortably reads at 72° FOV without whiting out the sights.
     `tracerRadius` 12mm: a real 9mm round is 9mm across and would be a
     sub-pixel line at 20m, so this is a deliberate, stated exaggeration — the
     tracer's job is to be seen, and it is on screen for one sixteenth of a
     second. Warm on both, because they read as fire against the cool key. */
  gunFx: {
    flashSize: 0.22,
    tracerRadius: 0.012,
    tracerColor: 0xffd9a0
  },
  /* §21 Asteroid presentation. The ball is normalised to 1m in the GLB, so
     `size` is literally its diameter in metres. It tumbles as it falls and
     the impact throws a short-lived ring of embers. */
  asteroid: {
    size: 1.5,
    spin: [1.9, 2.7, -1.4],   // rad/s per axis, so the tumble never looks flat
    trailCount: 14,           // ember motes streaming off it on the way down
    impactMs: 620,            // crater glow + ember burst lifetime
    glow: 0xff6a18
  },
  /* §18 Fire Tornado presentation: the hand comes up at the camera, a rune
     spins off the fingertips, and the funnel drops on the target. */
  tornado: {
    height: 3.6,          // model is normalized to this
    spin: [2.2, -3.1, 4.4], // per-tube spin rates (rad/s) for a churning look
    riseMs: 420, holdMs: 1500, fadeMs: 500
  },
  handSign: { x: 0.30, y: -0.34, z: -0.58, scale: 1.25, rotY: -0.55, rotX: -0.25 },
  // image-based light for the nave (Poly Haven, CC0)
  hdri: 'assets/hdri/afrikaans_church_interior_1k.hdr',

  /* The fight happens in the crossing before the altar steps. The player is
     clamped by the baked navgrid (§20) and can never leave the stone or clip
     through the knight.
     Measured placement (blender probe): nave floor z=-34.04, nave strip
     y ±5, altar chancel toward +X, door at x=-55, center aisle |y|<1.2,
     pew rows from x<=-9. World transform: rotY 90° + offset below maps the
     crossing (blender -7.5,0) onto the world origin. */
  /* §22: `bounds` is MEASURED, not guessed. Flood-filling the baked navgrid
     (data/arena-nav.js, 0.4m cells) from playerSpawn gives ONE connected
     region — all 1563 walkable cells, 250.1 m², no orphan pockets at all —
     whose bounding box is the rectangle below. The old hand-authored box
     (±8.0 / -7.4..7.0) clipped 1.7m off the west aisle and 0.7m off the
     south end of floor you can actually stand on.
     Note the -9.1..-8.3 tail is a 1-2 cell doorway spur: a 0.35m body cannot
     enter it, so the *standable* region really stops at minZ -7.9. The extra
     0.8m is harmless because the navgrid, not this box, is the real
     constraint — `bounds` only clamps on the fallback path where the church
     (and therefore the grid) failed to load.
     `radius` is kept for older code paths that predate bounds entirely. */
  arena: {
    cx: 0, cz: 0, radius: 9.0, knightMinDist: 1.3,
    bounds: { minX: -9.7, maxX: 7.9, minZ: -9.1, maxZ: 7.7 },
    colliders: []      // the baked pews are scenery, and nothing else is solid
  },

  // In the aisle facing the altar (and the knight at z -1.8). Camera forward is
  // (-sin yaw, -cos yaw), so yaw 0 looks down -Z — yaw PI would face the door.
  /* §20: the baked navgrid (data/arena-nav.js) proved the nave centre is the
     ALTAR - a platform 1.75m up with a wall on it - so the old spawns had
     both sides standing inside solid stone. The arena is really a ring
     around that block, and the fight now happens in its north transept:
     ~15m of clear floor, no pew rows in the way, stained glass down one
     side. yaw -PI/2 looks toward +X, which is where the knights come from.
     §22 re-checked both against the flood fill: each sits on a free cell of
     the one connected region, each is legal under the body probe, and they
     are 11.00m apart (well over the 8m minimum), so neither moved. The band
     they stand in runs clear from z -7.9 to z -1.2, which is what lets
     spawnSquad fan a round-6 line perpendicular to the approach without
     putting the outer knights in stone. */
  playerSpawn: { x: -6.0, z: -5.4, yaw: -Math.PI / 2 },
  knight: {
    x: 5.0, z: -5.4,        // 11m across the transept, closing on foot
    targetHeight: 2.15,     // model is bbox-normalized to this height
    name: 'Hollow Black Knight',
    /* §18 movement, kept as the FALLBACK numbers: any engine path that has
       not moved onto the §22 state machine still reads these. `brain` below
       is the real tuning surface and repeats them — if you retune, retune
       both or the two paths disagree about how fast he walks. */
    walkSpeed: 1.6,
    keepDistance: 2.0,
    dashSpeed: 9.5,
    dashTime: 0.42,
    dashCooldown: 6.0,
    dashRange: 5.0,

    /* §22 THE BRAIN — every tunable of the state machine
       (stalk · press · strafe · reposition · recover · stagger), so the
       engine carries no magic numbers. Keys are deliberately FLAT: a
       personality is applied as a shallow copy over this object, and a
       nested group would need a deep merge nobody would remember to write.
       Ranges in the comments are the band that still feels like a fight;
       outside them he reads as either a statue or a homing missile. */
    brain: {
      /* --- speeds, m/s ------------------------------------------------ */
      walkSpeed: 1.6,        // stalk/press closing pace (1.2-2.0; >2.4 he outruns you)
      strafeSpeed: 1.35,     // circling pace, must be < walkSpeed or he orbits faster than he closes (1.0-1.7)
      backpedalSpeed: 1.1,   // reposition retreat, facing you the whole way (0.8-1.4)
      dashSpeed: 9.5,        // the committed lunge (8-11; below 8 the tell outlasts the dash)
      turnRate: 3.4,         // rad/s of body yaw while free (2.5-4.5)
      recoverTurnRate: 1.1,  // rad/s during `recover` — being slow to turn IS the punish window

      /* --- ranges, m -------------------------------------------------- */
      keepDistance: 2.0,     // press holds here: inside his reach, outside your body (1.8-2.4)
      dashRange: 5.0,        // further than this and the lunge is worth its wind-up (4.5-7.0)
      repositionDist: 4.5,   // how far he backs off after a combo or when crowded (3.5-5.5)
      tooCloseDist: 1.4,     // hugging him: he disengages instead of flailing (1.2-1.6)
      crowdDist: 1.8,        // squadmate this close -> reposition, so a squad fans out (1.5-2.5)

      /* --- timings, ms unless noted ----------------------------------- */
      arcHoldMs: 1400,       // how long one approach arc is held before the bias flips (900-2000)
      arcBias: 0.55,         // rad the approach vector is rotated by; SIGN FLIPS PER KNIGHT (0.35-0.8)
      strafeHoldMs: 1100,    // one circling direction; short = twitchy, long = predictable (700-1800)
      repositionMs: 900,     // cap on the backpedal so he cannot retreat forever (600-1400)
      dashTellMs: 380,       // crouch-and-coil BEFORE the lunge — this is what makes it dodgeable (300-500)
      dashCooldownMs: 6000,  // per knight, staggered at spawn so a squad never lunges in unison
      attackCooldownMs: 900, // floor between his own swings; battle3d still owns squad cadence (700-1400)
      pressSwayMs: 800,      // period of the weight shift while he waits in press (600-1100)
      turnThreshold: 0.7,    // rad of yaw error that triggers a planted turnInPlace (0.5-1.0)
      tauntChance: 0.22,     // 0-1, rolled after a kill or a whiffed player attack (0.1-0.35)
      deathMs: 1600,         // buckle -> pitch -> sword drops -> settle -> fade (1200-2200)
      hitFlashMs: 160,       // flinch on ANY damaging hit, so blows always read (120-220)

      /* --- state weights ---------------------------------------------- */
      /* Relative pull when he is free to choose (after a recover, or with the
         attack on cooldown). Not probabilities — the engine normalises. The
         intended read is "presses forward twice as often as he circles". */
      pressWeight: 4,
      strafeWeight: 2,
      repositionWeight: 1,
      stalkWeight: 2,        // only consulted when he is already out of range

      /* --- stagger: the punish window the fight has never had ---------- */
      staggerDamage: 90,     // one hit above this staggers outright (70-120: a charged move, not a jab)
      staggerBuildup: 210,   // or this much accumulated damage fills the meter (150-300)
      staggerDecay: 55,      // meter points bled per second, so chip damage never banks (40-90)
      staggerMs: 1200,       // reeling: cannot attack, cannot turn (900-1600)
      staggerTakeMult: 1.5,  // damage multiplier while reeling (1.35-1.8; 2.0 makes stunlock the only tactic)

      /* --- personalities ---------------------------------------------- */
      /* Picked per knight at spawn and shallow-merged over the defaults, so
         each entry lists ONLY what it changes. A squad that shares one brain
         moves as one organism, which is the thing §22 exists to kill. */
      personalities: {
        // in your face: short cooldowns, long presses, barely circles
        aggressive: {
          walkSpeed: 1.85, attackCooldownMs: 700, dashCooldownMs: 4500,
          keepDistance: 1.8, pressWeight: 6, strafeWeight: 1,
          repositionWeight: 0.5, tauntChance: 0.3
        },
        /* Fights at the edge of your reach: circles, backs off, waits you out.
           keepDistance was 2.4 and is now 2.1. §28 B2 measured the blade: the
           furthest any swing puts the TIP is 1.90m from his own origin, so a
           knight who holds 2.4m is standing outside his own reach and every
           swing he throws from `press` whiffs by a third of a metre. He is
           still the furthest-standing of the three; he is no longer standing
           somewhere he cannot hit you from. */
        cautious: {
          walkSpeed: 1.45, strafeSpeed: 1.5, keepDistance: 2.1,
          attackCooldownMs: 1200, strafeHoldMs: 1500, repositionDist: 5.2,
          pressWeight: 2, strafeWeight: 4, repositionWeight: 2.5
        },
        // slow, heavy, and crosses the whole nave when he does come
        brute: {
          walkSpeed: 1.3, turnRate: 2.4, dashRange: 7.0, dashSpeed: 10.5,
          dashTellMs: 480, dashCooldownMs: 5000, staggerDamage: 130,
          staggerBuildup: 300, strafeWeight: 0.5, pressWeight: 5
        }
      },

      /* --- §28 A2: FROM ROUND 5, THE KNIGHTS GET FASTER ----------------
         Levels start at 1 now (§28 A), so the round's own contribution to
         difficulty had to move somewhere the player FEELS rather than reads
         off a stat block. From `fromRound` on, every knight gains one
         multiplier that touches both halves of the fight:

           MOVEMENT  walkSpeed / strafeSpeed / backpedalSpeed / dashSpeed are
                     multiplied by it, so he closes, circles and lunges
                     faster. Applied once when the tune is resolved at spawn,
                     never per frame.
           WIND-UP   telegraphMs, every hits[].atMs and recoverMs are DIVIDED
                     by it, so the swing arrives sooner.

         ONE CLOCK (§21). The wind-up is not shortened by editing the pattern:
         the engine derives a single scalar and divides EVERY time in the
         pattern by it together, and the pose driver is stretched over the
         result. If the telegraph shortens, the picture shortens with it,
         because both read the same numbers.

           round:   1-4     5      6      7      8      9     10+
           mult:    1.00   1.06   1.12   1.18   1.24   1.30   1.35 (max)

         `telegraphFloorMs` IS THE READABILITY GUARANTEE and it is the one
         number here nobody may quietly lower. A wind-up you cannot see is not
         a hard attack, it is an unfair one. No pattern's telegraph is ever
         scaled below 900ms; the scalar for that pattern is reduced until it
         is not. Measured against the shipped patterns, only `thrust_combo`
         (1100ms) ever reaches the floor — at the 1.35 ceiling it would want
         815ms, so its own multiplier is held at 1.22 and its whole schedule
         with it, while a slash at 1500ms scales the full 1.35 to 1111ms.
         That is deliberate: the fastest attack in the set is the one that
         stops getting faster first. */
      roundSpeed: {
        fromRound: 5,
        perRound: 0.06,        // added per round past fromRound - 1
        max: 1.35,             // ceiling; reached at round 10
        telegraphFloorMs: 900  // no wind-up ever scales below this
      }
    }
  },
  church: { rotY: Math.PI / 2, x: 0, y: 34.04, z: -7.5 },

  eye: { stand: 1.6, crouch: 0.85 },

  /* §17 first-person rig placement: the punch model is parented to the camera,
     pushed down so the camera sits at its shoulders and back so the fists
     swing into view. Its head bone is collapsed by the engine. */
  firstPerson: { x: 0, y: -0.06, z: 0.12, rotY: Math.PI, height: 1.8 },

  lights: {
    /* Lit for PLAYABILITY, not mood: you have to read the knight's windup and
       your own footing. Keep ambient NEUTRAL — a purple-blue ambient plus the
       red altar accent turns grey steel mauve. */
    ambient:  { color: 0x6b707c, intensity: 2.0 },
    moon:     { color: 0xc2d0e6, intensity: 3.2, x: 6, y: 12, z: -4 }, // shafts
    // red altar glow: an accent behind the knight, far enough back that it
    // silhouettes him instead of painting his armour
    altar:    { color: 0xe5173f, intensity: 1.4, x: 0, y: 2.4, z: -9, distance: 16, decay: 1.7 },
    knight:   { color: 0xff2038, intensity: 0.55, distance: 4.5, decay: 2 }, // pools at his feet
    // cool key over the fight so steel reads as steel
    key:      { color: 0xd8e2f2, intensity: 3.4, x: 0, y: 5.2, z: 1.5, distance: 26, decay: 1.4 },
    // second key further down the aisle so the arena floor stays readable
    key2:     { color: 0xbfcbe0, intensity: 2.2, x: 0, y: 4.6, z: -4.5, distance: 20, decay: 1.4 },
    candles:  [ { x: -3.2, z: 1.5 }, { x: 3.2, z: 1.5 } ]   // warm flickers
  },
  // The nave is long — keep the haze subtle and far, or the church reads as a
  // black pit instead of a room.
  fog: { color: 0x0d1018, near: 14, far: 70 },

  /* Attack patterns. The engine (arena.js) picks WHICH one; arena3d.js plays
     the telegraph and, at strike time, tests the player against the volume.
     evade: what saves you (shown as the HUD hint).
     - slash:        horizontal arc at chest height -> CROUCH under it (or be out of reach)
     - overhead:     vertical smash on a strip ahead -> SIDESTEP out of the lane
     - charge:       lunging thrust down a long lane -> MOVE, it's aimed where you stood
     - thrust_combo: two jabs then a lunge, THREE hit windows -> SIDESTEP off the line
     - ground_slam:  radial shockwave off his boots -> BACK OFF past `radius`

     §22 optional `feint: {chance, holdMs}`: the wind-up stops at the apex,
     holds, then finishes, so reading the telegraph is no longer sufficient on
     its own. The hold MUST NOT damage — a feint that hits mid-hold is just an
     unreadable attack. No feint on ground_slam: its whole read is "get out of
     the circle", and pausing the drop only makes the ring land later.

     WEIGHT MIX (relative, out of 14) — tuned so no single answer carries a
     whole fight: slash 4 (29%) stays the bread and butter you crouch under,
     overhead 3 (21%) and thrust_combo 3 (21%) split the sidestep budget so
     the two never feel like the same move, charge 2 (14%) and ground_slam 2
     (14%) are the rarer commitments that reshape where you are standing.
     Roughly half the swings still want a sidestep, which is what keeps the
     fight mobile. Remember data/knighttree.js gates patterns by his LEVEL,
     so an early round rolls from a smaller table than this.

     ===================================================================
     §28 B2 — THE VOLUMES WERE RECONCILED AGAINST THE MEASURED BLADE
     ===================================================================
     `reach`, `length` and `radius` here are measured from the KNIGHT'S OWN
     ORIGIN to the PLAYER'S CENTRE. They were authored against §18's rig,
     whose sword pivot sat 0.129m off the blade's own centre line — nobody
     could measure what the tip did, so the numbers were set by feel, and by
     feel they were set far too long.

     They are now derived. `arena3d._rigProbe(i).tipReach` reports where the
     point of the sword actually is at the strike frame; the player's body
     radius is 0.35m; so the honest volume is tipReach + 0.35, i.e. "the
     blade touches you". Measured through the shipped engine at the impact
     frame of each pattern:

       pattern        tip reach   + body   was     now    change
       slash            1.85       2.20    3.4     2.2    -35%
       overhead         1.78       2.13    4.4     2.1    -52%
       charge           1.90       2.25    7.5     2.6    -65%
       thrust_combo     1.77       2.12    3.6     2.1    -42%
       ground_slam       n/a        n/a    4.2     4.2     none

     THE WIDTHS ARE UNCHANGED. What was wrong was the LANE LENGTH, not how
     far you must step aside — the arcs really do sweep that wide, and
     narrowing them as well would have made sidestep a free answer.

     `ground_slam` keeps 4.2 because its volume is not the blade: the ring
     spawnShock draws IS the hit test, expanding to exactly `radius`, and the
     blade only has to reach the floor to justify it. Measured, the tip
     finishes at y 0.166 — on the flags. Nothing to reconcile.

     SAY THE BALANCE OUT LOUD. The charge losing 4.9m of lane is the biggest
     single nerf in this file's history. It was also the biggest lie: he
     crossed the nave at 7.6 m/s and then hit anything within seven and a half
     metres of where he stopped, with a blade that reaches 1.9. The danger
     band against a knight who holds `keepDistance` 2.0 goes from "safe only
     past 3.4m" to "safe past 2.2m", which is about a third of a second of
     backing away — and he closes faster every round from 5 (see
     brain.roundSpeed). Combined with §28 A's level-1 spawns this is a real
     easing of round 6 at t=0 and a real escalation after ~30s; that
     crossover is documented in data/knighttree.js and is the number to
     re-measure if either half of this is retuned. */
  patterns: {
    slash: {
      id: 'slash', name: 'Wide Slash', hint: 'CROUCH!',
      telegraphMs: 1500, recoverMs: 700,
      reach: 2.2, evade: 'crouch',   // 1.84m of blade + the 0.35m body
      power: 110, weight: 4,
      feint: { chance: 0.20, holdMs: 320 }
    },
    overhead: {
      id: 'overhead', name: 'Overhead Ruin', hint: 'SIDESTEP!',
      telegraphMs: 1700, recoverMs: 900,
      width: 1.7, length: 2.1, evade: 'sidestep',   // 1.73m of blade + the body
      power: 145, weight: 3,
      // the longest, highest apex — the pose that can afford the biggest lie
      feint: { chance: 0.30, holdMs: 420 }
    },
    charge: {
      id: 'charge', name: 'Hollow Charge', hint: 'MOVE!',
      telegraphMs: 1900, recoverMs: 1100,
      width: 1.9, length: 2.6, evade: 'sidestep',   // 1.90m of blade + the body, plus the lunge he is still carrying
      power: 170, weight: 2,
      // he is already lunging in the last quarter of the wind-up (§21), so
      // keep the hold short or the feint reads as a stumble
      feint: { chance: 0.18, holdMs: 300 }
    },
    /* Two fast stabs, then he steps through with a third. `hits` is the
       schedule the engine reads: `atMs` is measured from atk.t0, the same
       stamp the strike timer counts from (§21 — the picture and the damage
       drifting apart on two clocks is exactly the bug that cost a fight).
       telegraphMs equals the FIRST hit so any path that only knows
       telegraphMs/power still lands one honest stab; `power` is the fallback
       for that path. Per-hit power is deliberately well under overhead's 145
       — three connected stabs (235) should beat one overhead, but only just,
       and only if you eat the whole combo. */
    thrust_combo: {
      id: 'thrust_combo', name: 'Hollow Thrust', hint: 'SIDESTEP!',
      telegraphMs: 1100, recoverMs: 850,
      width: 1.0, length: 2.1, reach: 2.1, evade: 'sidestep',   // 1.63m of blade + the body (`reach` is vestigial here: sidestep patterns test the lane)
      power: 70,
      hits: [
        { atMs: 1100, power: 70 },              // jab
        { atMs: 1400, power: 70 },              // jab, same lane
        { atMs: 1850, power: 95, lunge: 1.6 }   // steps 1.6m through on the third
      ],
      totalMs: 1850,          // last hit — recoverMs starts from here, not telegraphMs
      feint: { chance: 0.25, holdMs: 260 },
      weight: 3
    },
    /* Both hands overhead, then the floor. The shockwave is RADIAL: facing
       does not save you, distance does, so it is the answer to a player who
       has learned to live inside his guard. Long telegraph and a long recover
       because it is the one attack you punish by walking in afterwards. */
    ground_slam: {
      id: 'ground_slam', name: 'Ground Ruin', hint: 'GET BACK!',
      telegraphMs: 2100, recoverMs: 1300,
      radius: 4.2,            // be OUTSIDE this at the strike frame, measured from his feet
      evade: 'backoff',
      power: 190, weight: 2
    },

    /* ---- clone patterns: mirror the player's abilities ----
       Each maps to a player ability in cloneai.js PATTERN_MAP.  Range,
       timing and power match the ability's own numbers expressed as a
       knight-style pattern the telegraph/strike pipeline can drive. */

    clone_punch: {
      id: 'clone_punch', name: 'Fist', hint: 'EVADE!',
      telegraphMs: 260, recoverMs: 240,
      reach: 2.6, evade: 'crouch',
      power: 45, weight: 4,
      hits: [
        { atMs: 260, power: 45 },
        { atMs: 500, power: 45 },
        { atMs: 740, power: 45 }
      ],
      totalMs: 740, feint: { chance: 0, holdMs: 0 }
    },
    clone_gun: {
      id: 'clone_gun', name: '9mm', hint: 'SIDESTEP!',
      telegraphMs: 90, recoverMs: 130,
      length: 22.0, width: 1.1, evade: 'sidestep',
      power: 115, weight: 3
    },
    clone_tornado: {
      id: 'clone_tornado', name: 'Fire Tornado', hint: 'GET BACK!',
      telegraphMs: 1250, recoverMs: 520,
      radius: 7.5, evade: 'backoff',
      power: 210, weight: 2
    },
    clone_asteroid: {
      id: 'clone_asteroid', name: 'Asteroid', hint: 'MOVE!',
      telegraphMs: 900, recoverMs: 460,
      radius: 5.0, evade: 'backoff',
      power: 165, weight: 2
    },
    clone_wave: {
      id: 'clone_wave', name: 'Water Wave', hint: 'DODGE!',
      telegraphMs: 420, recoverMs: 240,
      length: 6.0, width: 3.0, evade: 'sidestep',
      power: 40, weight: 1
    },
    clone_killer: {
      id: 'clone_killer', name: 'Killer Fist', hint: 'EVADE!',
      telegraphMs: 520, recoverMs: 380,
      reach: 3.0, evade: 'crouch',
      power: 165, weight: 2,
      hits: [
        { atMs: 520, power: 165 },
        { atMs: 760, power: 165 }
      ],
      totalMs: 760
    }
  }
};
