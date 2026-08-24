/* CHLOE — data/enemies.js  (Combat v2 + Progression v3, spec §10-12)
   moveset replaces skills (3-5 ids from CHLOE.data.moves), ai:'phased'.
   v3: `type` is the damage type (old `element` kept as back-compat alias),
   `resists:{type:mult}` are thematic overrides on top of the 11x11 chart,
   `statusImmune:[...]` blocks those statuses' buildup entirely.
   stats use the 4 resources: life (was hp), magic (was mp), stamina flat 99
   (enemies are not stamina-limited in v3), faith 3 (5 for the boss).

   Balance (v3 recheck): the_hollow is the first story fight — beatable by SOLO
   lvl-1 Chloe on defaultLoadouts in 3-6 exchanges. As type 'ghost' it now
   RESISTS physical 0.5 (chart), so dead_string (atk 12 + weapon 4, power 100)
   drops to ~5-7 per hit — but Chloe's main damage is power_chord (fire, mag 11,
   power 160), NEUTRAL 1.0 vs ghost: 11*1.6*rand(0.85-1.15) - def4*0.5 =
   ~13-18, avg ~15.6 vs 44 life => 3 hits avg, 4 worst-case; magic 20 funds 4
   casts. Charged (stage_presence, x1.5) ~20-28 but costs the stance turn, so
   the fight stays inside the 3-6 band. Life kept at 44 — no compensation
   needed. Its shadow hits still do ~4-7 through Chloe's def.
   neon_wisp still dies to a lvl-1 default loadout in 3-5 exchanges.
   The Promoter is the Act 1 boss (no fleeing). */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.enemies = {
  the_hollow: {
    id: 'the_hollow', name: 'The Hollow', image: 'assets/gen/enemy-the-hollow.jpg',
    type: 'ghost', element: 'shadow', level: 1, boss: false,
    stats: { life: 44, stamina: 99, magic: 12, faith: 3, atk: 6, def: 4, spd: 7, mag: 7 },
    resists: { occult: 0.5 },                 // it IS the dark between stage lights
    statusImmune: ['haunt', 'bleed'],         // can't haunt an absence; nothing in it bleeds
    moveset: ['shade_touch', 'dead_air', 'hollow_stare'],
    ai: 'phased',
    // sage_smoke cures the curse its own shade_touch builds up
    rewards: { xp: 10, shards: 6, drops: [ { itemId: 'bandage', chance: 0.5 }, { itemId: 'sage_smoke', chance: 0.25 } ] },
    desc: 'A stagehand-shaped absence. It still remembers how to reach for you.'
  },
  hollow_black_knight: {
    id: 'hollow_black_knight', name: 'Hollow Black Knight', image: 'assets/gen/enemy-the-hollow.jpg',
    type: 'occult', element: 'shadow', level: 2, boss: false,
    /* §16 balance: the chart makes occult take 2x physical — but the black
       plate blunts that back to neutral (resists override the chart), so a
       solo lvl-1 Chloe who dodges kills it in 4-5 rounds (life 48 / ~12 per
       dead_string); face-tanking its 10-atk patterns (110-170% power) loses.
       Fire stays chart-halved; divine (Voice tree) still burns it 2x. */
    stats: { life: 48, stamina: 99, magic: 10, faith: 3, atk: 10, def: 5, spd: 6, mag: 6 },
    resists: { physical: 1.0 },               // plate armor: no 2x punching the ghost
    statusImmune: ['bleed', 'poisoned'],      // there is nothing inside the armor
    moveset: ['shade_touch', 'dead_air', 'hollow_stare'], // legacy 2D-battle compat
    ai: 'phased',
    /* §16: in the arena its real offense is the pattern set in data/arena3d.js
       (slash/overhead/charge) — dodge or eat pattern.power% of atk. */
    rewards: { xp: 16, shards: 12, drops: [ { itemId: 'bandage', chance: 0.5 }, { itemId: 'tourniquet', chance: 0.25 } ] },
    desc: 'Empty plate armor that still keeps its vigil. The church remembers who it buried.'
  },
  neon_wisp: {
    id: 'neon_wisp', name: 'Neon Wisp', image: 'assets/gen/enemy-neon-wisp.jpg',
    type: 'occult', element: 'shadow', level: 1,
    stats: { life: 32, stamina: 99, magic: 10, faith: 3, atk: 7, def: 3, spd: 8, mag: 8 },
    resists: { lightning: 0.5 },              // dead signage — it drinks current
    statusImmune: ['bleed'],                  // light has no blood
    moveset: ['shade_touch', 'flicker', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 12, shards: 8, drops: [ { itemId: 'bandage', chance: 0.35 } ] },
    desc: 'A smear of dead signage that learned to want.'
  },
  static_ghoul: {
    id: 'static_ghoul', name: 'Static Ghoul', image: 'assets/gen/enemy-static-ghoul.jpg',
    type: 'lightning', element: 'volt', level: 2,
    stats: { life: 55, stamina: 99, magic: 14, faith: 3, atk: 11, def: 6, spd: 10, mag: 10 },
    resists: { lightning: 0.5 },              // it lives in the white noise
    statusImmune: ['shock'],                  // you can't jolt a creature of jolt
    moveset: ['static_jolt', 'dead_string', 'flicker'],
    ai: 'phased',
    rewards: { xp: 22, shards: 14, drops: [ { itemId: 'energy_drink', chance: 0.35 } ] },
    desc: 'It wears the white noise between stations like skin.'
  },
  mirror_shade: {
    id: 'mirror_shade', name: 'Mirror Shade', image: 'assets/gen/enemy-mirror-shade.jpg',
    type: 'magical', element: 'frost', level: 3,
    stats: { life: 82, stamina: 99, magic: 18, faith: 3, atk: 14, def: 8, spd: 11, mag: 14 },
    resists: { magical: 0.5, poison: 0.5 },   // glass reflects spellwork; venom finds no veins
    statusImmune: ['bleed', 'poisoned'],      // nothing circulates behind the glass
    moveset: ['frost_gaze', 'glass_skin', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 34, shards: 22, drops: [ { itemId: 'bandage', chance: 0.4 }, { itemId: 'adrenaline_shot', chance: 0.15 } ] },
    desc: 'Your reflection, three seconds late and getting closer.'
  },
  promoter: {
    id: 'promoter', name: 'The Promoter', image: 'assets/gen/enemy-promoter.jpg',
    type: 'occult', element: 'shadow', level: 4, boss: true,
    stats: { life: 175, stamina: 99, magic: 40, faith: 5, atk: 16, def: 10, spd: 10, mag: 18 },
    resists: { occult: 0.5, physical: 0.5 },  // contracts don't tear; takes 2x divine via the chart anyway
    statusImmune: ['curse', 'haunt'],         // he wrote the curse; the ghosts work for him
    moveset: ['spotlight_drain', 'dead_air', 'hollow_stare', 'glass_skin', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 90, shards: 120, drops: [ { itemId: 'adrenaline_shot', chance: 1.0 } ] },
    desc: 'He books the acts. He keeps the encores. Forever.'
  }
};
