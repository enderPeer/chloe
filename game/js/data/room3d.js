/* CHLOE — data/room3d.js
   Room layout config for the 3D dressing room (spec section 13).
   Pure data: dims, spawns, texture paths, furniture list, light rig.
   Consumed by engine/world3d.js. All positions in meters; room is centered
   on origin: x in [-w/2, w/2], z in [-d/2, d/2]. North wall = -z, south = +z,
   west = -x, east = +x. rotY: object's front (+z local) rotated around Y.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.room3d = {
  size: { w: 8, d: 6, h: 3 },

  // yaw -0.917 rad ≈ facing from spawn toward the enemy spawn (2.2,-1.6)
  playerSpawn: { x: -2.5, z: 2, yaw: -0.917 },
  enemySpawn:  { x: 2.2,  z: -1.6 },

  // Paths relative to game/index.html (per tools/room3d-assets.json contract).
  // Missing files are fine: world3d falls back to flat colored materials.
  textures: {
    carpet:        'assets/gen/tex/carpet.jpg',
    wall:          'assets/gen/tex/wall.jpg',
    ceiling:       'assets/gen/tex/ceiling.jpg',
    couch:         'assets/gen/tex/couch.jpg',
    door:          'assets/gen/tex/door.jpg',
    mirror:        'assets/gen/tex/mirror.jpg',
    tv_static:     'assets/gen/tex/tv_static.jpg',
    poster:        'assets/gen/tex/poster.jpg',
    enemy:         'assets/gen/enemy-hollow-sprite.jpg',
    enemyFallback: 'assets/gen/enemy-the-hollow.jpg'
  },

  // kind drives the mesh composition + collidability in world3d.js.
  // Collidable kinds: vanity, couch, tv, lamp. Wall-flush planes
  // (mirror, door, poster) are covered by the wall colliders.
  furniture: [
    // north wall: vanity table with the dead mirror above it
    { kind: 'vanity', x: -1.5,  z: -2.62, w: 1.8,  d: 0.65, h: 0.92, rotY: 0,               tex: null },
    { kind: 'mirror', x: -1.5,  z: -2.96, w: 1.5,  d: 0.05, h: 1.25, rotY: 0,               tex: 'mirror' },
    // east wall: torn couch, front facing into the room (-x)
    { kind: 'couch',  x: 3.42,  z: 0.4,  w: 2.1,  d: 0.95, h: 0.8,  rotY: -Math.PI / 2,     tex: 'couch' },
    // southwest corner: CRT on a stand, angled toward the room center
    { kind: 'tv',     x: -3.45, z: 2.35, w: 1.0,  d: 0.55, h: 1.05, rotY: 2.35,             tex: 'tv_static' },
    // south wall: the red door (static prop, opens nowhere yet)
    { kind: 'door',   x: 0.8,   z: 2.96, w: 1.0,  d: 0.06, h: 2.1,  rotY: Math.PI,          tex: 'door' },
    // northwest corner: floor lamp (emits the warm point light)
    { kind: 'lamp',   x: -3.5,  z: -2.5, w: 0.4,  d: 0.4,  h: 1.65, rotY: 0,                tex: null },
    // grungy posters: one west wall, one south wall
    { kind: 'poster', x: -3.96, z: 0.6,  w: 0.85, d: 0.04, h: 1.15, rotY: Math.PI / 2,      tex: 'poster' },
    { kind: 'poster', x: -1.4,  z: 2.96, w: 0.85, d: 0.04, h: 1.15, rotY: Math.PI,          tex: 'poster' }
  ],

  lights: {
    ambient:      { color: 0x1a0a0d, intensity: 1.2 },
    // red club light, center ceiling, subtle random flicker (fraction of intensity)
    pointCeiling: { color: 0xe5173f, intensity: 1.1, y: 2.75, distance: 14, decay: 1.6, flicker: 0.18 },
    // warm lamp glow, positioned by world3d at the 'lamp' furniture piece
    lamp:         { color: 0xffb37a, intensity: 0.9, distance: 6, decay: 1.8 },
    // faint red glow that follows the enemy billboard
    enemy:        { color: 0xff2038, intensity: 0.7, distance: 5, decay: 1.8 }
  }
};
