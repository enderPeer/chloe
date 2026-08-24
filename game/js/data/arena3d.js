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
  assetVersion: 3,
  models: {
    church: 'assets/3d/church.glb',
    knight: 'assets/3d/knight.glb',
    punch:  'assets/3d/punch.glb'
  },
  // image-based light for the nave (Poly Haven, CC0)
  hdri: 'assets/hdri/afrikaans_church_interior_1k.hdr',

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

  // In the aisle facing the altar (and the knight at z -1.8). Camera forward is
  // (-sin yaw, -cos yaw), so yaw 0 looks down -Z — yaw PI would face the door.
  playerSpawn: { x: 0, z: 4.2, yaw: 0 },
  knight: {
    x: 0, z: -1.8,          // before the chancel steps, altar at its back
    targetHeight: 2.15,     // model is bbox-normalized to this height
    name: 'Hollow Black Knight'
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
