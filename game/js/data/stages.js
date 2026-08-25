/* CHLOE — data/stages.js  (spec §24)
   WHERE the fight happens, and what that place looks like. One entry per
   stage; the engine resolves the stage for the round and applies it BEFORE
   the arena builds.

   Division of labour, and it matters:
     - data/arena3d.js stays the source for MODELS, ATTACK PATTERNS and the
       KNIGHT BRAIN (§22). Nothing here duplicates those.
     - this file owns the PLACE: spawns, containment, light rig, fog, and —
       for a procedural stage — the pieces to build.
   The `church` entry therefore RESTATES today's real values out of
   data/arena3d.js (arena.bounds / knightMinDist / playerSpawn / knight x,z /
   lights / fog). Those numbers are MEASURED (§22 flood fill of the baked
   navgrid), not chosen, so they were copied rather than re-derived. If you
   change one file and not the other the two disagree about where the player
   stands, and that is a bug, not a preference — change both.

   Distances in meters, every stage centred on the world origin.
   Yaw convention (same as arena3d.js): camera forward is (-sin yaw, -cos yaw),
   so yaw 0 looks down -Z and yaw -PI/2 looks toward +X. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.stages = {

  /* ================= THE CHURCH — the model stage ================= */
  church: {
    id: 'church',
    name: 'The Church',
    blurb: 'Cold stone, close pillars, and nowhere clean to stand.',

    /* 'model' = load a glb and use the BAKED navgrid (data/arena-nav.js) as
       the real constraint. `model` is a key into CHLOE.data.arena3d.models —
       the path, the assetVersion cache-buster and the church placement
       transform all stay over there, because a second copy of a file path is
       a second thing to forget to bump. */
    shape: 'model',
    model: 'church',
    nav: 'baked',

    /* Restated from arena3d.js playerSpawn / knight.x,z. §22 verified both
       against the flood fill: each sits on a free cell of the ONE connected
       walkable region, each is legal under the body probe, and they are
       11.00m apart. The band they stand in runs clear from z -7.9 to z -1.2,
       which is what lets a round-6 squad fan perpendicular to the approach
       without putting the outer knights in stone. */
    playerSpawn: { x: -6.0, z: -5.4, yaw: -Math.PI / 2 },
    knightSpawn: { x: 5.0, z: -5.4 },

    /* Restated from arena3d.js `arena`. `bounds` is the bounding box of the
       measured walkable region (1563 cells, 250.1 m²) and is used ONLY as the
       fallback clamp for the path where the church — and therefore the grid —
       failed to load. `radius` is kept for code paths older than bounds. */
    arena: {
      cx: 0, cz: 0,
      radius: 9.0,
      knightMinDist: 1.3,
      bounds: { minX: -9.7, maxX: 7.9, minZ: -9.1, maxZ: 7.7 },
      colliders: []
    },

    /* Walkable area from the same flood fill, NOT the area of the bounds box
       (which is ~296 m² and counts stone). The board quotes this. */
    area: 250,

    hdri: 'assets/hdri/afrikaans_church_interior_1k.hdr',

    // Restated from arena3d.js `lights`. Lit for PLAYABILITY: you have to read
    // the wind-up and your own footing. Ambient stays NEUTRAL or the red altar
    // accent turns grey steel mauve.
    lights: {
      ambient: { color: 0x6b707c, intensity: 2.0 },
      moon:    { color: 0xc2d0e6, intensity: 3.2, x: 6, y: 12, z: -4 },
      altar:   { color: 0xe5173f, intensity: 1.4, x: 0, y: 2.4, z: -9, distance: 16, decay: 1.7 },
      knight:  { color: 0xff2038, intensity: 0.55, distance: 4.5, decay: 2 },
      key:     { color: 0xd8e2f2, intensity: 3.4, x: 0, y: 5.2, z: 1.5, distance: 26, decay: 1.4 },
      key2:    { color: 0xbfcbe0, intensity: 2.2, x: 0, y: 4.6, z: -4.5, distance: 20, decay: 1.4 },
      candles: [ { x: -3.2, z: 1.5 }, { x: 3.2, z: 1.5 } ]
    },

    // Restated from arena3d.js `fog`. The nave is long — subtle and far, or
    // the church reads as a black pit instead of a room.
    fog: { color: 0x0d1018, near: 14, far: 70 }
  },

  /* ================= THE RING — the procedural stage ================= */
  /* The church's opposite: ~615 m² of clear floor with NOTHING on it, so six
     knights are a fight instead of a scrum. Blank is the point — do not
     decorate this into a second church. Built from primitives and textures we
     already ship; no glb, no Pollinations run, no new asset. */
  ring: {
    id: 'ring',
    name: 'The Ring',
    // one line, and short enough to stay one line on the board (§24)
    blurb: 'A lit circle in the dark. Nowhere for him to hide.',

    /* 'round' means: no glb, no bake, and `nav = null`, so containment falls
       to §22's radius/bounds fallback clamp. That path is deliberately the one
       exercised here rather than bypassed — it is why the Ring needs no
       navgrid at all. */
    shape: 'round',
    model: null,
    nav: null,

    /* Opposite sides of the circle, 13.0m apart (>= the 12m the fight wants to
       open at) and 7.5m inside the rim, so a round-6 squad can fan across the
       approach and still stand well clear of the kerb.
       yaw -PI/2 looks toward +X — straight at the knight, and straight at the
       lit pylon behind him, which is what backlights him on the opening beat. */
    playerSpawn: { x: -6.5, z: 0, yaw: -Math.PI / 2 },
    knightSpawn: { x: 6.5, z: 0 },

    /* radius 14 is the clamp on BODY CENTRES, and the kerb's inner face sits
       at 14.4 (see build.kerb), so you stop with roughly a body radius (0.35)
       of air between your shoulder and the wall instead of standing in it.
       `bounds` is explicitly null: an engine that prefers bounds when present
       would otherwise square the circle. knightMinDist matches the church
       because it describes the knight's body, not the room. */
    arena: {
      cx: 0, cz: 0,
      radius: 14,
      knightMinDist: 1.3,
      bounds: null,
      colliders: []
    },

    area: 616,   // pi * 14^2, rounded — ~2.5x the church

    /* No HDRI, and null is meaningful rather than missing: a lit church
       interior probe over a void reads as a grey dome sitting on the horizon.
       The Ring is lit entirely by its own rig. */
    hdri: null,

    /* Key names are kept PARALLEL to the church rig (ambient/moon/key/knight)
       so one engine code path can apply either, and this rig simply has no
       altar/key2/candles. An engine that assumes the church's exact key set
       will throw here — read what the stage actually declares. */
    lights: {
      // near-neutral cool grey: the rim lights are orange, and a colour cast in
      // the ambient on top of that turns black armour muddy brown
      ambient: { color: 0x5f6570, intensity: 1.35 },
      // a directional is doing the work a point light cannot across 28m of
      // floor: even shape, no hot spot in the middle of an empty disc
      moon:    { color: 0xaebdd4, intensity: 1.8, x: 4, y: 14, z: -6 },
      // cool key hung high over the centre so steel still reads as steel
      key:     { color: 0xd8e2f2, intensity: 2.8, x: 0, y: 9.5, z: 0, distance: 40, decay: 1.15 },
      /* Per LIT pylon (see build.pylons.litEvery) — the engine instances this
         one template at each lit post. Orange against the cool floor separates
         a black silhouette from the ground by HUE as well as value, which is
         what carries a knight across 14m when there is no scenery behind him.
         `distance` covers the near half of the disc; it is a rim light, not a
         second key. */
      rim:     { color: 0xff7a2a, intensity: 2.4, y: 2.5, distance: 22, decay: 1.25 },
      // pools at his feet, same as the church, so you can see where he stands
      knight:  { color: 0xff2038, intensity: 0.55, distance: 4.5, decay: 2 }
    },

    /* near 18 is deliberately BEYOND the play radius: nothing inside 14m of
       you is ever hazed, so the silhouette stays hard-edged where it matters,
       and only the far side of the disc (up to 28m) softens — which is what
       sells how big the floor is. far 52 puts the void past the pylons in
       full fog colour, so the edge of the world needs no geometry. */
    fog: { color: 0x05060a, near: 18, far: 52 },

    /* ---- the procedural build: floor disc, kerb, pylons, void ----
       Textures are EXISTING paths only (§24). wall.jpg is the only broadly
       grey, grungy, tiling surface we ship — carpet reads as a rug and the
       rest are props — so the floor and the kerb both take it at different
       repeats and different tints, which is enough to keep them apart.
       Every material built here must set userData.envClamp = true (§20): if
       the player arrives from the church the env map is still resolved, and
       applyEnvIntensity will otherwise flatten this floor to white plastic. */
    build: {
      envClamp: true,
      textures: {
        floor: 'assets/gen/tex/wall.jpg',
        kerb:  'assets/gen/tex/wall.jpg'
      },
      /* Reaches past the kerb to 16.5 so the pylons stand on something. 96
         segments = 3.75° facets; at this radius that is a ~1m chord, which
         reads as a circle underfoot and costs nothing. */
      floor: { radius: 16.5, segments: 96, tex: 'floor', repeat: 10,
               color: 0x6d6a66, roughness: 0.95, metalness: 0.0 },
      /* Low enough to step over with your eyes (0.9m) and never high enough to
         hide a knight: the edge must read as a BOUNDARY, not as cover and not
         as a drop. Inner face at 14.4 — see arena.radius for why. */
      kerb:  { inner: 14.4, outer: 14.95, height: 0.9, segments: 96,
               tex: 'kerb', repeat: 24, color: 0x4a4744, roughness: 0.9 },
      /* TWELVE, and the count is the only thing giving the eye rotation and
         distance cues on an otherwise blank floor, so it is not arbitrary:
         12 is a clock face at 30° spacing, ~7.3m apart along the rim, which
         keeps two or three posts in a normal FOV at all times — one post
         alone tells you nothing about which way you have turned. They stand
         at 15.6, OUTSIDE the kerb and outside the clamp, which is how the
         Ring keeps its promise of no colliders but the perimeter: you cannot
         reach them, so they cannot be walked into.
         Only every 3rd post carries a real PointLight (4 lights, landing on
         the cardinals since phase 0 puts post 0 on +X). The other 8 are
         emissive geometry only. Twelve point lights would force three r128 to
         recompile every material in the scene for a light count that big, and
         four is already enough to say which way you are facing. */
      pylons: { count: 12, radius: 15.6, height: 2.6,
                postRadius: 0.16, capRadius: 0.26,
                color: 0x1a1a1e, emissive: 0xff6a18, emissiveIntensity: 1.6,
                litEvery: 3, litPhase: 0 },
      /* The dark plate under and beyond everything, in the fog colour so the
         two blend and the world simply stops having edges. Unlit — it must
         never catch the key, or the void turns into a grey table. */
      void: { color: 0x05060a, radius: 90 }
    }
  }
};

/* ---------------- stage selection (the pure half) ----------------
   §24 asks for `CHLOE.engine.stages` with order/forRound/current/next. The
   half that is a pure function of the round number lives HERE, so the order
   and the cycle are defined in exactly one place next to the stages they
   index. The STATEFUL half — current()/next(), reading the round off
   party.runStats, applying the stage before the arena builds and fully
   tearing the previous one down — belongs to the engine agent and should call
   into this rather than re-listing the ids.

   forRound cycles the order so the stage is deterministic and learnable:
   round 1 church, round 2 ring, round 3 church, and so on. */
CHLOE.data.stagePick = (function () {
  'use strict';

  var ORDER = ['church', 'ring'];

  function byId(id) {
    return (id && CHLOE.data.stages[id]) || null;
  }

  // 1-based rounds; anything junk or below 1 resolves to the first stage
  // rather than returning undefined, because the board paints every round.
  function forRound(n) {
    n = Math.floor(n);
    if (!(n >= 1)) { n = 1; }
    return ORDER[(n - 1) % ORDER.length];
  }

  return {
    order: ORDER,
    forRound: forRound,
    byId: byId,
    // convenience for the engine: the resolved stage object for a round
    stageForRound: function (n) { return byId(forRound(n)); }
  };
})();
