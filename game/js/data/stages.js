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

    /* ---- §32: the eight seats of a deathmatch ----------------------------
       Eight players at 45° on a circle of radius 10.5m, each facing the
       centre. Only the Ring has these, and that is the reason §32 is a Ring
       mode: the Ring's containment is a RADIUS over an empty disc, so a seat
       is legal if the arithmetic below says it is. The church's is a baked
       navgrid threaded between pillars (§22), where legality is a flood-fill
       question asked per cell — eight seats there would have to be verified
       one at a time against the grid, the way §22 verified its two. Do not
       add a `spawns` array to the church without doing that work.

       THE YAW, DERIVED AND THEN CHECKED. Per the convention at the top of this
       file, camera forward is (-sin yaw, -cos yaw). A seat must look at the
       centre, so forward has to be (-x, -z)/r, giving sin yaw = x/r and
       cos yaw = z/r — that is, yaw = atan2(x, z). The check is this file's own
       playerSpawn, authored by hand in §24 and untouched since:
       atan2(-6.5, 0) is exactly -PI/2, which is the yaw sitting on the line
       above. The formula reproduces the authored number to the last bit, so
       seat 0 is deliberately parked on -X too — the same view down +X at the
       lit pylon that opens a PvE round, 4m further out.

       WHY 10.5. The Ring clamps a player at arena.radius - the body radius,
       14 - 0.35 = 13.65m (see arena.radius below), so a seat at 10.5 stands
       3.15m off the wall: enough that your first step in any direction is a
       step and not a slide along the kerb. Neighbours are one chord apart,
       2 * 10.5 * sin(22.5°) = 8.04m — six times arena.knightMinDist (1.3) and
       four and a half times the brain's crowdDist (1.8), so nobody opens
       inside anyone's separation push and nobody opens in melee. Across the
       circle is 21.0m, a long look but a legible one: fog.near is 18, so the
       far seat is hazed by only ~9% toward the void colour and a body's seat
       tint still reads across the whole disc.

       THE DIAGONALS ARE 7.42, not 7.4246 (= 10.5 * cos45°). Rounding to the
       centimetre the wire rounds to anyway (data/pvp.js posDecimals) costs
       6.5mm of radius, which is nothing to a 2.15m body — and because the two
       magnitudes stay EQUAL, atan2 still returns an exact multiple of PI/4.
       An asymmetric rounding would have bought a yaw that no longer points at
       the centre in exchange for the same 6.5mm.

       INDEX ORDER WALKS THE CIRCLE: seat i and i+1 are neighbours, seat i and
       i+4 are opposite. No seat is better than another — the disc is empty and
       radially symmetric — but it is not perfectly uniform either: the four
       LIT pylons stand on the cardinals (build.pylons: 12 posts, litEvery 3,
       litPhase 0), so seats 0/2/4/6 have an orange post behind them and the
       diagonal seats sit between two. That is left alone rather than rotated
       22.5° off, because being backlit is a gift to everyone LOOKING at you,
       and because keeping seat 0 on -X is what makes the yaw check above
       something a reader can verify instead of trust.

       Do NOT hand this job to arena3d's spawnSquad fan: that is a line, not a
       circle, it is computed relative to the local player, and at n=8 it puts
       every body on one half of the disc at 1.6m spacing — inside crowdDist,
       so the separation push fires on frame one.

       Two restatements, and both are promises to change the other copy too:
       the radius is `seatRadius` in data/pvp.js, and `spawns` must be added to
       arena3d's mergeStage allow-list — it names the keys a stage may override
       one by one, so a new stage field it does not list is silently dropped. */
    spawns: [
      { x: -10.50, z:   0.00, yaw: -Math.PI / 2 },      // 0  -X, the §24 view
      { x:  -7.42, z:  -7.42, yaw: -3 * Math.PI / 4 },  // 1
      { x:   0.00, z: -10.50, yaw: Math.PI },           // 2
      { x:   7.42, z:  -7.42, yaw: 3 * Math.PI / 4 },   // 3
      { x:  10.50, z:   0.00, yaw: Math.PI / 2 },       // 4  +X, his PvE side
      { x:   7.42, z:   7.42, yaw: Math.PI / 4 },       // 5
      { x:   0.00, z:  10.50, yaw: 0 },                 // 6
      { x:  -7.42, z:   7.42, yaw: -Math.PI / 4 }       // 7
    ],

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

/* ---------------- stage selection ----------------
   §24 asks for `CHLOE.engine.stages` with order/forRound/current/next. The
   half that is a pure function of the round number lives HERE, so the order
   and the cycle are defined in exactly one place next to the stages they
   index. The STATEFUL half — current()/next(), reading the round off
   party.runStats, applying the stage before the arena builds and fully
   tearing the previous one down — belongs to the engine agent and should call
   into this rather than re-listing the ids.

   cycleForRound cycles the order so a night nobody interferes with is
   deterministic and learnable: round 1 the Ring, round 2 the church, round 3
   the Ring, and so on. The run OPENS on the Ring deliberately (§26) — a lit
   blank circle with nothing to snag on is where the fight is legible, and the
   church, with its pillars and its baked navgrid, is the complication you
   walk into second, not the thing that has to teach you.

   §26 also put ARROWS on the room's stage board, so the player can simply
   pick. That choice lives here, not in the engine, for one reason: forRound()
   is the single question both the board (world3d.nextStagePlan) and the fight
   (ui/battle3d.resolveStage) already ask, so an override answered here reaches
   both of them and CANNOT drift into a board promising a floor you do not
   land on. A pick sticks until it is changed — you set the stage, it stays
   set — and the round cycle only decides while nobody has. */
CHLOE.data.stagePick = (function () {
  'use strict';

  var ORDER = ['ring', 'church'];

  // the floor the player chose at the board; null = the round cycle decides
  var chosenId = null;

  function byId(id) {
    return (id && CHLOE.data.stages[id]) || null;
  }

  // 1-based rounds; anything junk or below 1 resolves to the first stage
  // rather than returning undefined, because the board paints every round.
  function cycleForRound(n) {
    n = Math.floor(n);
    if (!(n >= 1)) { n = 1; }
    return ORDER[(n - 1) % ORDER.length];
  }

  /* A pick is honoured only while it names a stage that really exists: a
     stale id — a stage renamed out from under it — must fall back to the
     cycle rather than freeze the run on a floor nothing can build. */
  function chosen() {
    return byId(chosenId) ? chosenId : null;
  }

  function forRound(n) {
    return chosen() || cycleForRound(n);
  }

  /* What an arrow WOULD give you, without taking it — the room names the
     floor under the crosshair before you commit to it. Steps from what the
     board is CURRENTLY announcing, so the first click always moves you one
     off the stage you are looking at, whether that was your pick or the
     cycle's. */
  function peek(dir, n) {
    var i = ORDER.indexOf(forRound(n));
    if (i < 0) { i = 0; }
    var len = ORDER.length;
    return ORDER[((i + (dir < 0 ? -1 : 1)) % len + len) % len];
  }

  function choose(id) {
    if (byId(id)) { chosenId = id; }
    return chosen();
  }

  // back to the deterministic cycle. Nothing in the UI hangs off this today;
  // it is what a new run calls if picks are ever made run-scoped.
  function clear() { chosenId = null; }

  return {
    order: ORDER,
    forRound: forRound,
    cycleForRound: cycleForRound,
    byId: byId,
    chosen: chosen,
    choose: choose,
    peek: peek,
    // one arrow click: take what peek() named, and answer with the new pick
    cycle: function (dir, n) { return choose(peek(dir, n)); },
    clear: clear,
    // convenience for the engine: the resolved stage object for a round
    stageForRound: function (n) { return byId(forRound(n)); }
  };
})();
