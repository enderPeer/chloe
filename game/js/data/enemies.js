/* CHLOE — data/enemies.js
   Balance: neon_wisp beatable by a lvl-1 party; ~3 fights to reach lvl 2-3
   (xpToNext(1)=25, xpToNext(2)=71). The Promoter is the Act 1 boss (no fleeing). */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.enemies = {
  neon_wisp: {
    id: 'neon_wisp', name: 'Neon Wisp', image: 'assets/gen/enemy-neon-wisp.jpg',
    element: 'shadow', level: 1,
    stats: { hp: 32, mp: 10, atk: 7, def: 3, spd: 8, mag: 8 },
    skills: ['shade_touch'],
    ai: 'basic',
    rewards: { xp: 12, shards: 8, drops: [ { itemId: 'bandage', chance: 0.35 } ] },
    desc: 'A smear of dead signage that learned to want.'
  },
  static_ghoul: {
    id: 'static_ghoul', name: 'Static Ghoul', image: 'assets/gen/enemy-static-ghoul.jpg',
    element: 'volt', level: 2,
    stats: { hp: 55, mp: 14, atk: 11, def: 6, spd: 10, mag: 10 },
    skills: ['static_jolt'],
    ai: 'basic',
    rewards: { xp: 22, shards: 14, drops: [ { itemId: 'energy_drink', chance: 0.35 } ] },
    desc: 'It wears the white noise between stations like skin.'
  },
  mirror_shade: {
    id: 'mirror_shade', name: 'Mirror Shade', image: 'assets/gen/enemy-mirror-shade.jpg',
    element: 'frost', level: 3,
    stats: { hp: 82, mp: 18, atk: 14, def: 8, spd: 11, mag: 14 },
    skills: ['frost_gaze'],
    ai: 'basic',
    rewards: { xp: 34, shards: 22, drops: [ { itemId: 'bandage', chance: 0.4 }, { itemId: 'adrenaline_shot', chance: 0.15 } ] },
    desc: 'Your reflection, three seconds late and getting closer.'
  },
  promoter: {
    id: 'promoter', name: 'The Promoter', image: 'assets/gen/enemy-promoter.jpg',
    element: 'shadow', level: 4, boss: true,
    stats: { hp: 175, mp: 40, atk: 16, def: 10, spd: 10, mag: 18 },
    skills: ['shade_touch', 'spotlight_drain'],
    ai: 'basic',
    rewards: { xp: 90, shards: 120, drops: [ { itemId: 'adrenaline_shot', chance: 1.0 } ] },
    desc: 'He books the acts. He keeps the encores. Forever.'
  }
};
