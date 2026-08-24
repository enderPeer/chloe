/* CHLOE — data/room3d.js
   Room layout config for the 3D dressing room (spec sections 13 + 14).
   Pure data: dims, spawns, texture paths, model paths, furniture list, light rig.
   Consumed by engine/world3d.js. All positions in meters; room is centered
   on origin: x in [-w/2, w/2], z in [-d/2, d/2]. North wall = -z, south = +z,
   west = -x, east = +x. rotY: object's front (+z local) rotated around Y.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.room3d = {
  size: { w: 8, d: 6, h: 3 },

  // yaw -0.885 rad ≈ facing from spawn toward the enemy spawn (2.2,-1.6).
  // x -2.2 keeps the spawn clear of the TV model's Box3 collider (its scaled
  // AABB reaches x -2.70; radius 0.35 -> anything west of -2.35 overlaps).
  playerSpawn: { x: -2.2, z: 2, yaw: -0.885 },
  enemySpawn:  { x: 2.2,  z: -1.6 },

  // §16: engaging the ghost pulls the run into the church arena vs this enemy
  enemy: { id: 'hollow_black_knight' },

  // Grabbable items (spec §16 hands): click while looking at the glint —
  // the hand closes and takes it. y = resting height (vanity top / couch seat).
  pickups: [
    { itemId: 'bandage',      label: 'Bandage',      x: -1.1, y: 1.02, z: -2.55 },
    { itemId: 'energy_drink', label: 'Energy Drink', x: 3.25, y: 0.52, z: 1.15 }
  ],

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

  /* hdri + models paths verified against tools/model-manifest.json entryFile
     values (repo paths minus the leading "game/"); all files are on disk.
     A missing/404 file is still safe: the engine falls back per item. */
  hdri: 'assets/hdri/creepy_bathroom_1k.hdr',
  models: {
    sofa:   'assets/models/sofa/Sofa_01_1k.gltf',
    tv:     'assets/models/tv/Television_01_1k.gltf',
    lamp:   'assets/models/lamp/desk_lamp_arm_01_1k.gltf',
    vanity:   'assets/models/vanity/ClassicConsole_01_1k.gltf',
    chair:    'assets/models/chair/painted_wooden_chair_01_1k.gltf',
    clutter1: 'assets/models/clutter1/cassette_player_1k.gltf',
    clutter2: 'assets/models/clutter2/wine_bottles_01_1k.gltf'
  },

  // TV screen plane, local to the TV furniture group (x right, y up from floor,
  // z toward the room = out of the tube face). w/h in meters.
  //  - model:    used when the GLTF tv model loads; offsets fit the plane over the
  //              tube face AFTER the model is scaled to targetH and floor-dropped.
  //  - fallback: matches the textured-box TV builder (stand 45% + body 50% of h).
  tvScreen: {
    model:    { x: 0, y: 0.55, z: 0.26, w: 0.42, h: 0.32 },
    fallback: { x: 0, y: 0.73, z: 0.24, w: 0.62, h: 0.38 }
  },

  // kind drives the mesh composition + collidability in world3d.js.
  // Collidable kinds: vanity, couch, tv, lamp, chair. Wall-flush planes
  // (mirror, door, poster) are covered by the wall colliders.
  // Section 14 fields: model = canonical manifest id (null = always textured-box),
  // targetH = uniform-scale target height in meters for the GLTF model.
  furniture: [
    // north wall: vanity table with the dead mirror above it
    { kind: 'vanity', x: -1.5,  z: -2.62, w: 1.8,  d: 0.65, h: 0.92, rotY: 0,               tex: null,        model: 'vanity', targetH: 0.92 },
    { kind: 'mirror', x: -1.5,  z: -2.96, w: 1.5,  d: 0.05, h: 1.25, rotY: 0,               tex: 'mirror',    model: null },
    // east wall: torn couch, front facing into the room (-x)
    { kind: 'couch',  x: 3.42,  z: 0.4,  w: 2.1,  d: 0.95, h: 0.8,  rotY: -Math.PI / 2,     tex: 'couch',     model: 'sofa',   targetH: 0.8 },
    // southwest corner: CRT on a stand, angled toward the room center
    { kind: 'tv',     x: -3.45, z: 2.35, w: 1.0,  d: 0.55, h: 1.05, rotY: 2.35,             tex: 'tv_static', model: 'tv',     targetH: 0.9 },
    // south wall: the red door (static prop, opens nowhere yet)
    { kind: 'door',   x: 0.8,   z: 2.96, w: 1.0,  d: 0.06, h: 2.1,  rotY: Math.PI,          tex: 'door',      model: null },
    // northwest corner: floor lamp (emits the warm point light, the ONE shadow caster)
    { kind: 'lamp',   x: -3.5,  z: -2.5, w: 0.4,  d: 0.4,  h: 1.65, rotY: 0,                tex: null,        model: 'lamp',   targetH: 1.65 },
    // by the vanity: chair facing it (plain dark box if the model is missing)
    { kind: 'chair',  x: -0.55, z: -2.05, w: 0.5,  d: 0.5,  h: 0.85, rotY: Math.PI,         tex: null,        model: 'chair',  targetH: 0.85 },
    // clutter props (manifest optionals, non-collidable): cassette player lying
    // by the couch, a wine bottle standing in the couch/door corner
    { kind: 'clutter', x: 2.55, z: 1.7,  w: 0.24, d: 0.14, h: 0.06, rotY: 0.55,             tex: null,        model: 'clutter1', targetH: 0.052 },
    { kind: 'clutter', x: 3.45, z: 2.3,  w: 0.09, d: 0.09, h: 0.33, rotY: 0,                tex: null,        model: 'clutter2', targetH: 0.33 },
    // grungy posters: one west wall, one south wall
    { kind: 'poster', x: -3.96, z: 0.6,  w: 0.85, d: 0.04, h: 1.15, rotY: Math.PI / 2,      tex: 'poster',    model: null },
    { kind: 'poster', x: -1.4,  z: 2.96, w: 0.85, d: 0.04, h: 1.15, rotY: Math.PI,          tex: 'poster',    model: null }
  ],

  lights: {
    ambient:      { color: 0x1a0a0d, intensity: 1.2 },
    // red club light, center ceiling, subtle random flicker (fraction of intensity)
    pointCeiling: { color: 0xe5173f, intensity: 1.1, y: 2.75, distance: 14, decay: 1.6, flicker: 0.18 },
    // warm lamp glow, positioned by world3d at the 'lamp' furniture piece.
    // This is the single shadow-casting light (PCFSoft, 1024).
    lamp:         { color: 0xffb37a, intensity: 0.9, distance: 6, decay: 1.8 },
    // faint red glow that follows the enemy billboard
    enemy:        { color: 0xff2038, intensity: 0.7, distance: 5, decay: 1.8 },
    // bluish flickering light emitted by the TV while ON (section 14)
    tv:           { color: 0x86b6ff, intensity: 0.6, distance: 4, decay: 1.8 }
  }
};
