/* CHLOE — data/arena3d.js
   Config for the 3D battle arena (spec §15): the old church where every
   battle happens. Pure data: model paths, spawns, bounds, light rig, and the
   knight's attack patterns (telegraph time + hit volume + how to evade).
   Consumed by engine/arena3d.js (visuals/hit tests) and ui/battle3d.js
   (prompts). Distances in meters, arena centered on origin. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.arena3d = {
  models: {
    church: 'assets/3d/church.glb',
    knight: 'assets/3d/knight.glb'
  },

  /* The fight happens in the crossing before the altar steps. The player is
     clamped inside a circle plus pew colliders, and can never leave or clip
     through the knight.
     Measured placement (blender probe): nave floor z=-34.04, nave strip
     y ±5, altar chancel toward +X, door at x=-55, center aisle |y|<1.2,
     pew rows from x<=-9. World transform: rotY 90° + offset below maps the
     crossing (blender -7.5,0) onto the world origin. */
  arena: {
    cx: 0, cz: 0, radius: 4.8, knightMinDist: 1.3,
    // pew banks flanking the aisle (world-space AABBs)
    colliders: [
      { kind: 'pews_l', minX: -4.9, maxX: -1.25, minZ: 1.4, maxZ: 10 },
      { kind: 'pews_r', minX: 1.25, maxX: 4.9, minZ: 1.4, maxZ: 10 }
    ]
  },

  playerSpawn: { x: 0, z: 4.2, yaw: Math.PI }, // in the aisle, facing the altar
  knight: {
    x: 0, z: -1.8,          // before the chancel steps, altar at its back
    targetHeight: 2.15,     // model is bbox-normalized to this height
    name: 'Hollow Black Knight'
  },
  church: { rotY: Math.PI / 2, x: 0, y: 34.04, z: -7.5 },

  eye: { stand: 1.6, crouch: 0.85 },

  lights: {
    ambient:  { color: 0x101018, intensity: 1.4 },          // cold night nave
    moon:     { color: 0x8aa3cc, intensity: 0.85, x: 4, y: 9, z: -3 }, // shafts
    altar:    { color: 0xe5173f, intensity: 1.2, x: 0, y: 2.6, z: -5.5, distance: 12, decay: 1.6 },
    knight:   { color: 0xff2038, intensity: 0.9, distance: 6, decay: 1.8 }, // follows the knight
    candles:  [ { x: -3.2, z: 1.5 }, { x: 3.2, z: 1.5 } ]   // warm flickers
  },
  fog: { color: 0x05050a, near: 4, far: 26 },

  /* Attack patterns. The engine (arena.js) picks WHICH one; arena3d.js plays
     the telegraph and, at strike time, tests the player against the volume.
     evade: what saves you (shown as the HUD hint).
     - slash:    horizontal arc at chest height -> CROUCH under it (or be out of reach)
     - overhead: vertical smash on a strip ahead -> SIDESTEP out of the lane
     - charge:   lunging thrust down a long lane -> MOVE, it's aimed where you stood */
  patterns: {
    slash: {
      id: 'slash', name: 'Wide Slash', hint: 'CROUCH!',
      telegraphMs: 1500, recoverMs: 700,
      reach: 3.4, evade: 'crouch',
      power: 110, weight: 3
    },
    overhead: {
      id: 'overhead', name: 'Overhead Ruin', hint: 'SIDESTEP!',
      telegraphMs: 1700, recoverMs: 900,
      width: 1.7, length: 4.4, evade: 'sidestep',
      power: 145, weight: 2
    },
    charge: {
      id: 'charge', name: 'Hollow Charge', hint: 'MOVE!',
      telegraphMs: 1900, recoverMs: 1100,
      width: 1.9, length: 7.5, evade: 'sidestep',
      power: 170, weight: 1
    }
  }
};
