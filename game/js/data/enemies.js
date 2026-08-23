/* CHLOE — data/enemies.js  (Combat v2, spec §10-11)
   moveset replaces skills (3-5 ids from CHLOE.data.moves), ai:'phased'.
   Balance: the_hollow is the first story fight — beatable by SOLO lvl-1 Chloe on
   defaultLoadouts in 3-6 exchanges (avg hit ~14-16 vs 44 HP; its shadow hits do
   ~4-7 through Chloe's def). neon_wisp still dies to a lvl-1 default loadout in
   3-5 exchanges. The Promoter is the Act 1 boss (no fleeing). */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.enemies = {
  the_hollow: {
    id: 'the_hollow', name: 'The Hollow', image: 'assets/gen/enemy-the-hollow.jpg',
    element: 'shadow', level: 1, boss: false,
    stats: { hp: 44, mp: 12, atk: 6, def: 4, spd: 7, mag: 7 },
    moveset: ['shade_touch', 'dead_air', 'hollow_stare'],
    ai: 'phased',
    rewards: { xp: 10, shards: 6, drops: [ { itemId: 'bandage', chance: 0.5 } ] },
    desc: 'A stagehand-shaped absence. It still remembers how to reach for you.'
  },
  neon_wisp: {
    id: 'neon_wisp', name: 'Neon Wisp', image: 'assets/gen/enemy-neon-wisp.jpg',
    element: 'shadow', level: 1,
    stats: { hp: 32, mp: 10, atk: 7, def: 3, spd: 8, mag: 8 },
    moveset: ['shade_touch', 'flicker', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 12, shards: 8, drops: [ { itemId: 'bandage', chance: 0.35 } ] },
    desc: 'A smear of dead signage that learned to want.'
  },
  static_ghoul: {
    id: 'static_ghoul', name: 'Static Ghoul', image: 'assets/gen/enemy-static-ghoul.jpg',
    element: 'volt', level: 2,
    stats: { hp: 55, mp: 14, atk: 11, def: 6, spd: 10, mag: 10 },
    moveset: ['static_jolt', 'dead_string', 'flicker'],
    ai: 'phased',
    rewards: { xp: 22, shards: 14, drops: [ { itemId: 'energy_drink', chance: 0.35 } ] },
    desc: 'It wears the white noise between stations like skin.'
  },
  mirror_shade: {
    id: 'mirror_shade', name: 'Mirror Shade', image: 'assets/gen/enemy-mirror-shade.jpg',
    element: 'frost', level: 3,
    stats: { hp: 82, mp: 18, atk: 14, def: 8, spd: 11, mag: 14 },
    moveset: ['frost_gaze', 'glass_skin', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 34, shards: 22, drops: [ { itemId: 'bandage', chance: 0.4 }, { itemId: 'adrenaline_shot', chance: 0.15 } ] },
    desc: 'Your reflection, three seconds late and getting closer.'
  },
  promoter: {
    id: 'promoter', name: 'The Promoter', image: 'assets/gen/enemy-promoter.jpg',
    element: 'shadow', level: 4, boss: true,
    stats: { hp: 175, mp: 40, atk: 16, def: 10, spd: 10, mag: 18 },
    moveset: ['spotlight_drain', 'dead_air', 'hollow_stare', 'glass_skin', 'dead_string'],
    ai: 'phased',
    rewards: { xp: 90, shards: 120, drops: [ { itemId: 'adrenaline_shot', chance: 1.0 } ] },
    desc: 'He books the acts. He keeps the encores. Forever.'
  }
};
