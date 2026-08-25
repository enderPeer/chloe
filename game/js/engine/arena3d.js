/* CHLOE — engine/arena3d.js  (Arena battles, spec §16 — the 3D layer)
   Owns all Three.js for the church battle arena: loads the church + knight
   GLBs (graceful fallback to procedural geometry when loading fails, e.g.
   over file://), runs the first-person controller (WASD + mouse-look +
   keyboard fallback + Ctrl/C crouch), plays the knight's telegraphed attack
   patterns and answers the ONLY rules question this file is allowed to
   answer: "was the player inside the strike volume?" — everything else
   (damage, KO, rewards) lives in engine/arena.js.

   API: CHLOE.engine.arena3d = {
     init(canvas), start(), stop(), resize(), reset(),
     setStage(id), stageInfo(),                   // §24, call setStage BEFORE init
     telegraph(pattern, onResult), flinch(dmg, killed), setKnightAlive(bool),
     stun(i, seconds),                            // §23 the asteroid's stun
     shove(i, dirX, dirZ, distance, ms),          // §25 the Water Wave's throw
     waveTargets(ability), spawnWave(ability),    // §25 who it catches, and it
     debug(), _teleport(x, z), _setCrouch(bool)   // test hooks (§13 spirit)
   }
   Also publishes CHLOE.engine.stages (§24 stage selection) — see the block
   just below disableAPI() for why it lives in this file and not its own. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

(function () {
  'use strict';

  var A = {};
  CHLOE.engine.arena3d = A;

  function noop() {}
  function deadDebug() {
    return { x: 0, z: 0, yaw: 0, pitch: 0, crouch: false, eye: 0, knightDist: 0,
             mode: 'dead', churchLoaded: false, knightLoaded: false,
             locked: false, squad: 0, squadAlive: 0,
             /* §24: a caller reading debug().stage must not have to branch on
                whether WebGL exists, or on whether init() has run yet — answer
                the stage we WOULD build, out of its own data. Hardcoding
                shape:'model' here made the pre-init answer contradict the
                post-init one the moment the round resolved to the Ring, and
                ui/battle3d.js verifies setStage against exactly this object.
                `nav:false` is honest either way: nothing is baked until the
                stage is actually built. */
             stage: deadStage() };
  }
  function deadStage() {
    var def = stageDef, ar = (def && def.arena) || null;
    var out = { id: (def && def.id) || stageId || 'church',
                name: def ? def.name : null,
                shape: (def && def.shape) || 'model', nav: false };
    if (ar) {
      if (ar.bounds) {
        out.bounds = { minX: ar.bounds.minX, maxX: ar.bounds.maxX,
                       minZ: ar.bounds.minZ, maxZ: ar.bounds.maxZ };
      } else if (ar.radius != null) {
        out.radius = ar.radius; out.cx = ar.cx || 0; out.cz = ar.cz || 0;
      }
    }
    return out;
  }
  function disableAPI(reason) {
    if (reason) console.warn('[arena3d] disabled: ' + reason);
    A.init = noop; A.start = noop; A.stop = noop; A.resize = noop; A.reset = noop;
    A.telegraph = function (p, cb) { if (cb) window.setTimeout(function(){ cb({ hit: true, pattern: p }); }, 300); };
    A.flinch = noop; A.setKnightAlive = noop;
    A.debug = deadDebug; A._teleport = noop; A._setCrouch = noop;
    /* Everything ui/battle3d.js calls must exist here too, or a machine
       without WebGL throws its way through the fight instead of degrading.
       This list had drifted badly: stopAbility alone was already being called
       unguarded. Keep it in step whenever the public API grows. */
    A.playAbility = noop; A.stopAbility = noop; A.doEvade = noop;
    A.showSign = noop; A.spawnTornado = function () { return false; };
    A.spawnAsteroid = function (cb) { if (cb) cb(); return false; };
    A.asteroidTargets = function () { return []; };
    A.asteroidPoint = function () { return { x: 0, z: 0 }; };
    A.asteroidActive = function () { return false; };
    A.spawnSquad = noop; A.squadSize = function () { return 1; };
    A.abilityTargets = function () { return [0]; };   // headless: always connect
    A.abilityHits = function () { return true; };
    A.nearestKnightDist = function () { return 2; };
    A.releaseLock = noop; A.allowLock = noop; A.isLocked = function () { return false; };
    A.assetsReady = function () { return true; };     // nothing to wait for
    A.assetProgress = function () { return { done: 1, total: 1, warm: true }; };
    A._renderOnce = function () { return false; };
    A._look = noop; A._tick = noop;
    A._simKnight = function () { return null; };   // §22 headless AI probe
    /* §22 stagger surface. `staggerMult` is read by the damage side to price
       a punish window, so the dead API must answer 1 — a missing multiplier
       that comes back undefined multiplies damage into NaN. */
    A.staggerMult = function () { return 1; };
    A.isStaggered = function () { return false; };
    /* §23 asteroid impact stun. combat3 calls this from the damage path, so
       it must exist before init and on a machine with no WebGL at all — an
       unguarded call here is a fight that throws instead of degrading. */
    A.stun = function () { return false; };
    A.isStunned = function () { return false; };
    /* §25 Water Wave. Same reasoning as the stun above: combat3/battle3d call
       shove() from the hit path the moment the wave lands, so it has to answer
       on a machine with no WebGL — false, because a knight nobody is rendering
       was certainly not thrown anywhere. */
    A.shove = function () { return false; };
    A.isShoved = function () { return false; };
    /* §28 A per-knight levels. engine/combat3.js PULLS these every tick to
       price the squad, so on a machine with no WebGL it must answer with
       something a stat line can be built from: the round's own baseline,
       which is exactly what the pre-§28 game did for every knight. Returning
       [] here would silently reprice the whole squad to level 1. */
    A.knightLevels = function (n) {
      var kt = CHLOE.engine.knighttree;
      var L = kt ? kt.level() : 1, out = [];
      for (var i = 0; i < Math.max(1, n || 1); i++) out.push(L);
      return out;
    };
    // no knight is ever mid-swing on a dead API
    A.striker = function () { return -1; };
    A.waveTargets = function () { return []; };
    A.spawnWave = function () { return false; };
    A.taunt = noop;
    /* §24. setStage still RECORDS the choice on a dead API: the board and the
       round counter read CHLOE.engine.stages.current(), and a machine with no
       WebGL must still be able to say which stage the fight is nominally on
       rather than answering null and painting an empty poster. */
    A.setStage = function (id) { if (S.get(id)) { stageId = id; stageDef = S.get(id); } return false; };
    A.stageInfo = function () { return stageDef; };
    A._stageCount = function () { return null; };
  }

  /* ------------------------------------------------------- §24 stage state
     Declared HERE, above the THREE guard, because CHLOE.engine.stages answers
     current()/next() on a machine with no WebGL too — the room's stage board
     paints from data long before anyone loads a renderer. */
  var stageId = null;    // id of the stage the arena is standing in (or will build)
  var stageDef = null;   // its resolved data object; null = no data/stages.js, legacy church

  /* ---------------------------------------------------- §24 stage selection
     WHY THIS LIVES IN arena3d.js AND NOT engine/stages.js: index.html lists
     every script by hand, and adding a file nobody wires up is a file that
     silently never loads. §24 allows "an equivalent named export — state it in
     the code"; this is that statement. The public surface is:
       order       — the cycle (from CHLOE.data.stagePick when present)
       forRound(n) — which stage round n is fought on: deterministic, so the
                     player can learn "even rounds are the Ring"
       current()   — the id the arena is standing in RIGHT NOW
       next()      — the id after current in the order (what the board announces)
       get(id)     — the resolved stage object, or null
       apply(id)   — hand it to the engine (same as arena3d.setStage)
     Every one degrades to 'church' when data/stages.js is missing or partial,
     because a half-shipped data file must be a church, not a throw. The PURE
     half (the order and the cycle) belongs to data/stagePick and is only
     re-derived here when that is absent. */
  var S = {};
  CHLOE.engine.stages = S;

  function stagesTable() { return (CHLOE.data && CHLOE.data.stages) || null; }
  function stagePickData() { return (CHLOE.data && CHLOE.data.stagePick) || null; }

  function orderList() {
    var p = stagePickData();
    if (p && p.order && p.order.length) return p.order.slice();
    var t = stagesTable(), o = [], k;
    if (t) { for (k in t) { if (t[k] && t[k].id) o.push(k); } }
    return o.length ? o : ['church'];
  }

  S.order = orderList();
  S.get = function (id) {
    var t = stagesTable();
    return (t && id && t[id]) || null;
  };
  S.forRound = function (n) {
    S.order = orderList();
    var p = stagePickData();
    if (p && typeof p.forRound === 'function') {
      var pick = p.forRound(n);
      /* Trust data's cycle, but only if it names a stage that really exists —
         a typo'd order would otherwise resolve to undefined and setStage would
         quietly keep the previous stage for the rest of the run. */
      if (S.get(pick)) return pick;
    }
    n = Math.floor(n);
    if (!(n >= 1)) n = 1;
    return S.order[(n - 1) % S.order.length];
  };
  S.current = function () { return stageId || (stagesTable() ? S.forRound(1) : null); };
  S.next = function () {
    S.order = orderList();
    var i = S.order.indexOf(S.current());
    return S.order[(i < 0 ? 0 : i + 1) % S.order.length];
  };
  S.apply = function (id) { return A.setStage(id); };

  if (!window.THREE) { disableAPI('THREE not found'); return; }

  // ---------------------------------------------------------------- constants
  var RADIUS = 0.35;
  /* §22: the knight is a 2.15m armoured body, not a camera. He probes the
     navgrid with his OWN footprint so he cannot thread a gap the player
     barely fits through. Overridable from data (`knight.bodyRadius`) if the
     model is ever swapped; keep it under 0.6 — see navFree for why. */
  var KNIGHT_RADIUS = 0.55;
  var WALK = 3.2, SPRINT = 5.4, CROUCH_SPEED = 0.55;
  var ACCEL_LERP = 10;
  var TURN_RATE = 100 * Math.PI / 180;
  var SENS = 0.0022;
  var PITCH_MAX = 80 * Math.PI / 180;
  var BOB_AMP = 0.03;

  // ---------------------------------------------------------------- state
  var inited = false, running = false, disabled = false;
  var controlOff = false;   // §21: a panel owns input; the loop still runs
  var canvas = null, renderer = null, scene = null, camera = null;
  var rafId = 0, lastTime = 0, elapsed = 0, renderFailed = false;
  var LIGHT_SCALE = 1;       // becomes PI under physicallyCorrectLights (§14)
  var ENV_INTENSITY = 1.05;
  var envMapOk = false;

  var cfg = null;
  var pos = { x: 0, z: 4.6 };
  var vel = { x: 0, z: 0 };
  var yaw = Math.PI, pitch = 0, bobPhase = 0;
  var keys = {};
  var crouchHeld = false, crouchForced = false, eyeH = 1.6;
  var listeners = [];

  var churchLoaded = false, knightLoaded = false;

  /* §20: a SQUAD. Round N puts N knights on the floor. `knights[i]` all share
     this shape; `knight` stays pointing at the first so single-target code
     (lights, fallback totem) keeps working. */
  var knights = [];
  var knightProto = null;      // loaded gltf scene, cloned per knight
  function makeKnightState() { return {
    group: null,     // outer group at spawn (bob/lunge applied here)
    model: null,     // loaded model or fallback totem (windup tilts applied here)
    mats: [],
    light: null,
    alive: true,
    baseRot: 0,
    rig: null,       // §18 limb pivots built from the named armour pieces
    bob: 0,
    // §18 animation/AI state
    anim: {
      state: 'idle',           // idle | walk | dash
      stride: 0,
      /* Per-knight phase offset. Both breathe terms read the shared global
         `elapsed`, so without this a squad of five bobs as one organism. */
      phase: Math.random() * 10,
      /* §21: `wound` was a frame-loop latch that only cleared in the
         idle/recover branch, while telegraph() clears and re-arms in one
         synchronous tick — so a knight re-picked before his last swing
         finished played the whole telegraph out of an idle pose with NO
         wind-up. Routine once a squad is 3+. Explicit arming replaces it. */
      swinging: false, swingT: 0, swingDur: 1, recoverDur: 1,
      swingKind: 'overhead',
      /* §22: a pattern can land SEVERAL hits (thrust_combo) and can LIE about
         when (feint). `sched` is every hit time in seconds off atk.t0 on the
         UN-HELD clock, so the pose reads one window at a time and the impact
         frame of each stays p = 1.0; `feintHold` is the apex pause the strike
         timers were pushed back by. Single-hit patterns keep sched = [swingDur]
         and behave exactly as they did in §21. */
      sched: null, feintHold: 0,
      /* §28 A2: the round-speed scalar THIS swing was armed with. Held on the
         anim rather than recomputed, so the recover timer cannot end up on a
         different round's multiplier from the wind-up that preceded it. */
      speed: 1,
      turnErr: 0,                // yaw error, for the planted turnInPlace pose
      dash: 0, dashCd: 0, dashDir: { x: 0, z: 1 }
    },
    /* §22 brain: the movement state machine, its timers and this knight's
       personality. Built lazily by brainOf() because the leader is on the
       floor and walking before spawnSquad ever runs. */
    brain: null,
    /* §28 A: HIS OWN LEVEL. `levelT` is seconds alive in this fight — the
       trigger data/knighttree.js names — and `level` is what that is worth
       for his personality, capped against the round's baseline. `levelTell`
       is the burn-down on the flash that fires when it changes, because a
       knight who quietly got stronger is a knight who did not. */
    level: 1, levelT: 0, levelTell: 0,
    staggerMeter: 0,     // §22 buildup; decays at brain.staggerDecay per second
    dropped: null,       // §22 death: sword pieces taken out of his hand
    // §20 per-knight attack window (battle3d schedules these staggered)
    atk: { mode: 'idle', pattern: null, cb: null, t0: 0, timers: [], hits: null,
           lockDir: { x: 0, z: 1 }, lunge: 0 }
  }; }
  var knight = makeKnightState();
  knights.push(knight);

  /* §17 first-person arms: the punch rig is parented to the camera with its
     head bone collapsed, so you see your own arms swing. */
  var fp = {
    root: null, mixer: null, clips: {}, action: null,
    loaded: false, headBone: null
  };
  var evadeMove = null;   // {dx, dz, t, dur} active dash
  var castingId = null;   // ability currently animating

  /* Attack playback lives per knight now (§20) - see makeKnightState().
     A squad that shared one attack window would telegraph in unison and land
     every strike on the same frame. */

  /* §24: ONE accessor, made stage-aware, instead of thirty call sites made
     stage-aware. Everything in this file already asks D() for the arena box,
     the spawns, the light rig and the fog, so overlaying the active stage
     HERE reaches all of them at once — including the ones inside the §22
     fallback clamp, which is exactly the path the Ring has to exercise.
     With no data/stages.js (or no stage applied) this returns the base object
     untouched, byte for byte, so the church behaves as it did yesterday.
     The merge is cached and re-cut only when the stage or the underlying data
     object changes: D() is called inside the frame loop. */
  var mergeCache = null, mergeForStage = null, mergeForBase = null;

  function D() {
    var base = (CHLOE.data && CHLOE.data.arena3d) || {};
    if (!stageDef) return base;
    if (mergeCache && mergeForStage === stageDef && mergeForBase === base) return mergeCache;
    mergeCache = mergeStage(base, stageDef);
    mergeForStage = stageDef; mergeForBase = base;
    return mergeCache;
  }
  function invalidateCfg() {
    mergeCache = null; mergeForStage = null; mergeForBase = null;
    if (inited) cfg = D();
  }

  /* What a stage is allowed to override, and — just as important — what it is
     not. data/arena3d.js keeps MODELS, ATTACK PATTERNS and the KNIGHT BRAIN;
     a stage owns only WHERE the fight happens and WHAT IT LOOKS LIKE (§24).
     `arena` is replaced WHOLESALE rather than key-merged, and that is
     deliberate: key-merging would leave the church's `bounds` sitting under
     the Ring's `radius`, and the clamp in updatePlayer prefers bounds when
     present — the circle would come out square. Same reasoning for colliders:
     a stage that declares none must GET none. */
  function mergeStage(base, st) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    if (st.playerSpawn) out.playerSpawn = st.playerSpawn;
    if (st.arena) {
      var a = {};
      for (k in st.arena) a[k] = st.arena[k];
      // knightMinDist describes the knight's BODY, not the room, so it falls
      // back to the base value rather than to a literal in the engine
      if (a.knightMinDist == null && base.arena) a.knightMinDist = base.arena.knightMinDist;
      out.arena = a;
    }
    if (st.knightSpawn) {
      var kn = {};
      for (k in (base.knight || {})) kn[k] = base.knight[k];
      kn.x = st.knightSpawn.x; kn.z = st.knightSpawn.z;
      out.knight = kn;         // targetHeight / rotY / brain all survive
    }
    if (st.lights) out.lights = st.lights;
    if (st.fog) out.fog = st.fog;
    // `hdri: null` is a STATEMENT (the Ring is lit by its own rig), so test for
    // the key rather than for a truthy value
    if (Object.prototype.hasOwnProperty.call(st, 'hdri')) out.hdri = st.hdri;
    return out;
  }
  /* Append the asset version so a rebuilt .glb is never served from cache. */
  function versioned(path) {
    if (!path) return path;
    var v = D().assetVersion;
    return v ? path + (path.indexOf('?') === -1 ? '?v=' : '&v=') + v : path;
  }

  // ---------------------------------------------------------------- loaders
  /* ------------------------------------------------------------ asset gate
     §21. The church is 26MB and the knight 6.6MB. They used to stream in
     AFTER the fight had already begun, so you spawned into grey nothing while
     an invisible knight walked at you. Every loader now checks in here, and
     ui/battle3d.js will not start the fight until `A.assetsReady()` is true.

     Shader warm-up happens at the same gate: three compiles a material's
     program the first time it is actually drawn, so the first Fire Tornado
     cost several frames of stall mid-fight. renderer.compile() walks the whole
     scene with scene.traverse (not traverseVisible - checked against the
     vendored r128 build), so it reaches the tornado, the hand sign and the
     asteroid even though all three are hidden until cast. */
  var assets = { total: 0, done: 0, warm: false, names: {} };

  function assetExpect(name) {
    if (assets.names[name]) return;
    assets.names[name] = 'pending';
    assets.total++;
  }
  /* Settle a slot whether it loaded, failed or was skipped - a missing
     optional asset must never wedge the gate. Every path falls back. */
  function assetDone(name, how) {
    if (!assets.names[name] || assets.names[name] !== 'pending') return;
    assets.names[name] = how || 'ok';
    assets.done++;
  }
  /* §24: retire a SETTLED slot. A stage rebuild expects fresh slots for its own
     textures, and without this `total` grows by two every time the Ring is
     built — after ten rounds the loading bar is counting assets that were
     disposed nine rounds ago. Deliberately refuses to touch a slot still
     'pending': that one has an in-flight callback which will settle it, and
     forgetting it here would leave a load nobody is waiting for and a gate
     nobody can satisfy. */
  function assetForget(prefix) {
    for (var n in assets.names) {
      if (n.indexOf(prefix) !== 0) continue;
      if (assets.names[n] === 'pending') continue;
      delete assets.names[n];
      assets.total--; assets.done--;
    }
  }

  A.assetProgress = function () {
    return { done: assets.done, total: Math.max(1, assets.total), warm: assets.warm };
  };
  A.assetsReady = function () {
    if (!inited) return false;
    if (assets.done < assets.total) return false;
    // everything is in the scene: compile it before anyone gets to move
    if (!assets.warm) warmShaders();
    return assets.warm;
  };

  /* Warm everything the first cast would otherwise pay for, mid-fight.

     renderer.compile() alone is NOT enough, and measuring proved it: with the
     programs precompiled, the first Fire Tornado frame still cost 444ms
     against a 2.9ms baseline. compile() builds shader programs but never
     uploads textures - those go to the GPU lazily, on the frame a material is
     first actually drawn. The tornado, the hand sign and the asteroid all sit
     hidden until cast, so all of their texture uploads landed on one frame in
     the middle of a real-time fight.

     So: push every texture in the scene through initTexture(), then draw one
     frame with everything forced visible. Both happen behind the loading
     veil, so the flash of a tornado at the origin is never seen. */
  function warmShaders() {
    if (assets.warm || !renderer || !scene || !camera) return;

    try { renderer.compile(scene, camera); } catch (e) {
      console.warn('[arena3d] shader warm-up failed', e);
    }

    // textures: upload now rather than on the frame they are first drawn
    if (renderer.initTexture) {
      var seen = [];
      var SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
                   'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap'];
      scene.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) {
          for (var k = 0; k < SLOTS.length; k++) {
            var t = mats[i] && mats[i][SLOTS[k]];
            if (t && t.isTexture && seen.indexOf(t) === -1) {
              seen.push(t);
              try { renderer.initTexture(t); } catch (e) {}
            }
          }
        }
      });
    }

    /* One frame with the hidden VFX forced on, so their draw calls are really
       issued once. Visibility is restored before anyone sees a frame. */
    var hidden = [];
    scene.traverse(function (o) {
      if (o.visible === false) { hidden.push(o); o.visible = true; }
    });
    try { renderer.render(scene, camera); } catch (e) { renderFailed = true; }
    for (var h = 0; h < hidden.length; h++) hidden[h].visible = false;
    try { renderer.render(scene, camera); } catch (e) { renderFailed = true; }

    assets.warm = true;
  }

  function makeLoader() {
    if (typeof THREE.GLTFLoader !== 'function') return null;
    var loader = new THREE.GLTFLoader();
    try {
      if (typeof THREE.DRACOLoader === 'function') {
        var draco = new THREE.DRACOLoader();
        draco.setDecoderPath('vendor/draco/');
        loader.setDRACOLoader(draco);
      }
    } catch (e) { console.warn('[arena3d] draco unavailable', e); }
    return loader;
  }

  var churchFallback = null;
  /* §24: the parsed church is CACHED across stage switches and deliberately
     never disposed. It is a 26MB glb; re-entering the church after a round in
     the Ring must not re-download and re-parse it, and must not stall the §21
     loading gate a second time. Teardown detaches this group from the stage
     root and hands it back on the next church build — so the scene graph is
     genuinely clean between stages, while the expensive thing survives. */
  var churchGroup = null;
  var churchTimer = 0;

  function loadChurch() {
    if (churchGroup) {
      /* Already parsed this session — re-attach and re-derive everything the
         build normally derives from it. The navgrid is 400 bytes of base64,
         so re-decoding it is cheaper than trying to keep it valid across a
         teardown, and re-deriving guarantees it matches the church we just
         put back rather than the one we tore down. */
      stageRoot.add(churchGroup);
      churchLoaded = true;
      nav = loadShippedNav();
      measureArena();
      return;
    }
    assetExpect('church');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.church) {
      churchFallback = buildFallbackChurch();
      assetDone('church', 'skipped');
      return;
    }
    /* Everything below runs asynchronously, and a stage switch can land in the
       middle of it. `root`/`epoch` are captured so a late callback adds its
       geometry to the stage that ASKED for it, and bails outright if that
       stage has since been torn down — otherwise a church quietly materialises
       in the middle of the Ring several seconds after the fight started. */
    var root = stageRoot, epoch = stageEpoch;
    // draco/network failures can stall without ever calling the error cb —
    // if nothing arrived after 12s, build the fallback nave so the arena is
    // never a void (removed again if the real church shows up late)
    var fallbackTimer = window.setTimeout(function () {
      if (epoch !== stageEpoch) return;
      if (!churchLoaded && !churchFallback) churchFallback = buildFallbackChurch();
    }, 12000);
    churchTimer = fallbackTimer;
    loader.load(versioned(models.church), function (gltf) {
      window.clearTimeout(fallbackTimer);
      if (churchTimer === fallbackTimer) churchTimer = 0;
      if (epoch !== stageEpoch) {
        /* Stale: this church belongs to a stage that no longer exists. Drop it
           on the floor rather than into the scene, and settle the asset slot
           so the §21 gate does not wait forever on a load that already won. */
        assetDone('church', 'stale');
        disposeTree(gltf.scene);
        return;
      }
      try {
        var g = gltf.scene;
        var place = D().church || {};
        g.rotation.y = place.rotY != null ? place.rotY : Math.PI / 2;
        g.position.set(place.x || 0, place.y || 0, place.z || 0);
        g.traverse(function (o) {
          if (o.isMesh && o.material) {
            o.userData.isChurch = true;
            o.receiveShadow = true;
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              if (mats[i].map) mats[i].map.anisotropy = 4;
              if ('envMapIntensity' in mats[i]) mats[i].envMapIntensity = ENV_INTENSITY;
            }
          }
        });
        root.add(g);
        churchGroup = g;
        churchLoaded = true;
        if (churchFallback) {
          if (churchFallback.parent) churchFallback.parent.remove(churchFallback);
          disposeTree(churchFallback);
          churchFallback = null;
        }
        /* The walkable floor is PRECOMPUTED (data/arena-nav.js). Baking it
           live costs ~50s of frozen main thread — three r128 has no BVH, so
           every probe ray walks all 37 church meshes triangle by triangle.
           Re-bake with A._bakeExport() after moving or replacing the model. */
        nav = loadShippedNav();
        if (!nav) console.warn('[arena3d] no baked navgrid for this church — ' +
                               'falling back to the bounds rectangle. Re-run A._bakeExport().');
        /* §22: measure the open floor the moment the grid lands. One console
           line, so a bake or a probe change that shrinks the nave shows up in
           the log of the very next run instead of as "it feels cramped". */
        measureArena();
      } catch (e) {
        console.warn('[arena3d] church setup failed — fallback nave', e);
        if (!churchFallback) churchFallback = buildFallbackChurch();
      }
      assetDone('church');
    }, undefined, function () {
      assetDone('church', 'failed');
      window.clearTimeout(fallbackTimer);
      if (epoch !== stageEpoch) return;
      console.warn('[arena3d] church.glb failed to load — fallback nave');
      if (!churchFallback) churchFallback = buildFallbackChurch();
    });
  }

  // A church-shaped stand-in: stone floor disc, ring of columns, altar glow.
  // Returns the group so a late-arriving real church can replace it.
  function buildFallbackChurch() {
    var g = new THREE.Group();
    var ar = D().arena || { radius: 6 };
    var r = (ar.radius || 6) + 2;
    var floor = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.1, 36),
      new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.95 }));
    floor.position.y = -0.05;
    g.add(floor);
    var colMat = new THREE.MeshStandardMaterial({ color: 0x3a3a45, roughness: 0.9 });
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2;
      var col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 7, 10), colMat);
      col.position.set(Math.cos(a) * (r - 0.6), 3.5, Math.sin(a) * (r - 0.6));
      g.add(col);
    }
    var apse = new THREE.Mesh(new THREE.BoxGeometry(3, 2.2, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x1c1c26, roughness: 0.9,
        emissive: 0x33060e, emissiveIntensity: 0.8 }));
    apse.position.set(0, 1.1, -((ar.radius || 6) + 1.4));
    g.add(apse);
    // §24: into the STAGE root, never straight into the scene — a fallback
    // nave parented to the scene survives every teardown there is.
    (stageRoot || scene).add(g);
    return g;
  }

  function loadKnight() {
    assetExpect('knight');
    var loader = makeLoader();
    var models = D().models || {};
    knight.group = new THREE.Group();
    var kcfg = D().knight || { x: 0, z: -1.8, targetHeight: 2.15 };
    knight.group.position.set(kcfg.x || 0, 0, kcfg.z || 0);
    scene.add(knight.group);

    /* Red glow pooling at his feet, NOT inside his chest — a point light at
       body height washes the armour pink instead of rimming it. */
    var lcfg = (D().lights || {}).knight || {};
    knight.light = new THREE.PointLight(lcfg.color != null ? lcfg.color : 0xff2038,
      (lcfg.intensity != null ? lcfg.intensity : 0.55) * LIGHT_SCALE,
      lcfg.distance || 4.5, lcfg.decay || 2);
    knight.light.position.set(0, 0.25, 0);
    knight.group.add(knight.light);

    var attach = function (model, k) {
      k = k || knight;
      // darken to "hollow black"; mountKnight does the scaling and grounding
      model.traverse(function (o) {
        if (o.isMesh && o.material) {
          o.castShadow = true;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) {
            var m = mats[i];
            /* The source FBX exports a BLACK baseColorFactor over its diffuse
               map, so multiplying it (as we used to) left pure black — and a
               black metallic surface just mirrors the environment, which is
               how he ended up hot pink. Set the tint absolutely instead: a
               dark steel multiplier that still lets the armour texture read,
               with metalness/roughness kept out of mirror territory. */
            if (m.color) m.color.setRGB(0.30, 0.29, 0.33);
            if (m.map) m.map.anisotropy = 4;
            if (typeof m.metalness === 'number') m.metalness = Math.min(m.metalness, 0.3);
            if (typeof m.roughness === 'number') m.roughness = Math.max(m.roughness, 0.62);
            if ('envMapIntensity' in m) { m.envMapIntensity = 0.2; m.userData.envClamp = 0.2; }
            // no self-glow at rest — flinch() flashes him on hit instead
            if (m.emissive) { m.emissive.setHex(0x000000); m.emissiveIntensity = 1.0; }
            k.mats.push(m);
          }
        }
      });
      /* Take the template BEFORE rigging, and before the model is parented or
         scaled. knightProto used to be grabbed after the rig was built, so
         every clone arrived already containing a set of pivot groups and then
         had a second set bolted on — orphan groups nested inside orphan
         groups, and a rig traversal that could find the wrong one. */
      if (!knightProto) knightProto = model.clone(true);
      mountKnight(k, model);
      faceKnightTo(k, cfgSpawn().x, cfgSpawn().z);
      knightLoaded = true;
      if (pendingSquad > 1) { spawnSquad(pendingSquad); pendingSquad = 0; }
    };

    if (!loader || !models.knight) {
      attach(buildFallbackKnight());
      assetDone('knight', 'skipped');
      return;
    }
    // stalled load safety: a totem after 12s keeps the fight visible
    var fallbackTimer = window.setTimeout(function () {
      if (!knight.model) attach(buildFallbackKnight());
    }, 12000);
    loader.load(versioned(models.knight), function (gltf) {
      window.clearTimeout(fallbackTimer);
      try {
        /* The fallback totem got in first. Take out the RIG ROOT as well as
           the model: since §28 the meshes hang off bones under rig.root and
           removing only `model` would leave the whole totem standing inside
           the knight who just finished loading. */
        if (knight.model || knight.rig) {
          if (knight.rig && knight.rig.root) knight.group.remove(knight.rig.root);
          if (knight.model) knight.group.remove(knight.model);
          knight.model = null; knight.rig = null; knight.mats.length = 0;
        }
        attach(gltf.scene);
      }
      catch (e) { console.warn('[arena3d] knight setup failed — fallback totem', e); if (!knight.model) attach(buildFallbackKnight()); }
      assetDone('knight');
    }, undefined, function () {
      assetDone('knight', 'failed');
      window.clearTimeout(fallbackTimer);
      console.warn('[arena3d] knight.glb failed to load — fallback totem');
      if (!knight.model) attach(buildFallbackKnight());
    });
  }

  // Black armor totem stand-in (keeps every fight playable).
  function buildFallbackKnight() {
    var g = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.5, metalness: 0.7 });
    var torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.45), mat);
    torso.position.y = 1.15; g.add(torso);
    var legs = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.75, 0.4), mat);
    legs.position.y = 0.38; g.add(legs);
    var helm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.45, 0.42), mat);
    helm.position.y = 1.9; g.add(helm);
    var eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xff2038 }));
    eye.position.set(0, 1.92, 0.22); g.add(eye);
    var sword = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.7, 0.05), mat);
    sword.position.set(0.62, 1.1, 0.1); sword.rotation.z = -0.15; g.add(sword);
    return g;
  }

  /* §28 B: MOUNT THE REAL SKELETON.
     §18 built the rig here, in this file, by sorting the 103 armour pieces
     into six groups BY NAME and hanging each group off a pivot Group that was
     a SIBLING of the model rather than a link in a chain. Its own comment
     recorded the price — "the head never inherited the torso lean" — and §21
     recorded two more: the shoulder pivots were placed at a fraction of the
     model's HEIGHT (which put them inside the chest) and the name-suffix
     left/right split is INVERTED for `Boot_Toe`, so the legs came out 9/7 with
     a shin plate on the wrong side. All of that is gone. The hierarchy now
     comes from data/knightrig.js — root -> hips -> torso -> {head, armL ->
     forearmL, armR -> forearmR -> sword}, hips -> {legL, legR}, 103/103 meshes
     assigned, every pivot MEASURED from the vertices of the meshes its own
     bone owns — and engine/knightanim.js does the reparenting.

     THREE RULES THIS FUNCTION EXISTS TO KEEP:

     1. Rig the model DETACHED and UNSCALED. knightanim preserves each mesh's
        world matrix as it reparents, so whatever space the model is in at
        build time is the space the bone offsets are computed in. §21 lost a
        fight to exactly this: a rig measured in world coordinates was written
        into model-local ones, the leader's shoulder pivot ended up 5.9m from
        his own hand and a clone's 2.0m, and a squad read as one windmilling
        leader and N-1 statues. The model is therefore rigged BEFORE it is
        parented to k.group and BEFORE any scale is applied.

     2. The normalising scale goes on rig.root, never on the model. The pivots
        in data/knightrig.js are in native model metres (crown 1.832); scaling
        the meshes first would leave the bones 1.83m tall inside 2.15m of
        plate. That is the §17 "Box3 lies" bug class, so the on-screen height
        is asserted afterwards and published as _rigProbe().height.

     3. He is grounded and centred on the `root` BONE, not on a bounding box.
        The old code centred the model on its full bbox — which the drawn
        sword drags 0.11m across the body and 0.15m back, so his own group
        origin (the point every hit test and the ground_slam ring measure
        from) sat 0.19m from his actual body. The generator derives `root` as
        the floor between the two boots precisely so it can be that origin. */
  /* How tall he really stands: the highest vertex of the head bone above the
     rig's own ground plane, both in world metres. Falls back to the head
     bone's world position if the meshes carry no position attribute, because a
     missing measurement must not read as a knight of height zero. */
  function crownHeight(rig) {
    var head = rig.bones.head && rig.bones.head.group;
    if (!head) return 0;
    head.updateWorldMatrix(true, false);
    var v = new THREE.Vector3(), top = -Infinity;
    head.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      o.updateWorldMatrix(true, false);
      var p = o.geometry.attributes.position;
      for (var i = 0; i < p.count; i++) {
        v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.matrixWorld);
        if (v.y > top) top = v.y;
      }
    });
    if (top === -Infinity) { head.getWorldPosition(v); top = v.y; }
    /* The floor is where the `root` bone sits, not the lowest thing in the
       scene: a boot posed off the ground is a stride, not a shorter knight. */
    var floor = new THREE.Vector3();
    rig.bones.root.group.updateWorldMatrix(true, false);
    rig.bones.root.group.getWorldPosition(floor);
    return top - floor.y;
  }

  function mountKnight(k, model) {
    var KA = CHLOE.engine.knightanim;
    var kcfg = D().knight || {};
    var target = kcfg.targetHeight || 2.15;

    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(1);
    model.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(model);
    var nativeH = Math.max(0.01, box.max.y - box.min.y);
    var s = target / nativeH;

    var rig = KA ? KA.build(model, THREE) : null;
    if (!rig) {
      /* knightanim's own contract: no data/knightrig.js (or a fallback totem
         with no manifest names in it) means NO rig, and a knight who stands
         there is far better than one who throws exceptions every frame. Fall
         back to the pre-§28 placement so he is at least the right size, in
         the right place, and lit. */
      model.scale.setScalar(s);
      box.setFromObject(model);
      model.position.y -= box.min.y;
      model.position.x -= (box.min.x + box.max.x) / 2;
      model.position.z -= (box.min.z + box.max.z) / 2;
      k.group.add(model);
      k.model = model;
      k.rig = null;
      k.rigInfo = { rigged: false, reason: KA ? 'no meshes matched the manifest' : 'knightanim missing' };
      k.height = target;
      return;
    }

    k.group.add(rig.root);
    rig.root.scale.setScalar(s);
    var rp = rig.bones.root.def.pivot;
    KA.setRootRest(rig, -rp[0] * s, -rp[1] * s, -rp[2] * s);

    /* The model Group is now an empty husk — every mesh moved onto a bone —
       but it is kept on the knight so `mats`, the fallback path and anything
       that still expects `k.model` keep working. It is deliberately NOT added
       to the scene: adding it would put an empty, unscaled group under the
       knight and invite the next reader to parent something to it. */
    k.model = model;
    k.rig = rig;
    k.height = target;

    /* Assert the height rather than trusting the arithmetic. This is the one
       number §17 proved a Box3 will lie about, and it is cheap to check once
       per knight at spawn — but it must not be checked WITH a Box3, which is
       the joke §17 is making. `setFromObject` unions each mesh's own bounding
       box after rotating it, i.e. the AABB of a set of OBBs, and that is
       strictly larger than the body: measured on the rigged knight it read
       2.166m against a real crown of 2.146m. A 20mm inflation sits right on
       the 20mm tolerance below, so the assert could neither pass honestly nor
       catch a genuine 20mm scaling error. The crown is therefore taken from
       the VERTICES of the head bone's own meshes — the highest thing on him at
       rest, four meshes, measured once — and the floor is the `root` bone,
       which the generator derives as the plane between the boots precisely so
       it can be the origin. That is the number §28 asks a test to assert.

       It lands at 2.146, not 2.150, and the 4mm is honest: `s` above is still
       derived from the model's own Box3 (1.8329 against a true crown of
       1.8296), so the same inflation that made the assert useless makes the
       scale 0.2% small. Deriving `s` from the crown instead would make this
       read exactly 2.150 — and would also move every hit volume in
       data/arena3d.js by 4mm, which were reconciled against the blade at THIS
       scale. Four millimetres on a two-metre knight is not worth re-deriving
       that table for; the assert only has to be able to see a real error, and
       at 20mm tolerance against a 4mm bias it now can. */
    var shownH = crownHeight(rig);
    k.rigInfo = { rigged: true, moved: rig.moved, missing: rig.missing,
                  counts: rig.counts, nativeH: +nativeH.toFixed(4),
                  scale: +s.toFixed(4), height: +shownH.toFixed(3) };
    if (Math.abs(shownH - target) > 0.02) {
      console.warn('[arena3d] knight measures ' + shownH.toFixed(3) + 'm on screen, not ' +
                   target + 'm — the rig and the model are in different spaces');
    }
    if (rig.missing) {
      console.warn('[arena3d] ' + rig.missing + ' manifest mesh(es) missing from the GLB — ' +
                   'rerun tools/build-knight-rig.js');
    }
  }

  var pendingSquad = 0;

  /* §20: put `n` knights on the floor. The first is the one that loaded; the
     rest are clones of its dressed model, each with its own rig, light and
     materials so damage flashes only the one you hit. */
  function spawnSquad(n) {
    if (!knightProto) { pendingSquad = n; return; }
    // drop any extras from a previous round
    for (var d = knights.length - 1; d >= 1; d--) {
      if (knights[d].group) scene.remove(knights[d].group);
      knights.splice(d, 1);
    }
    var kcfg = D().knight || {};
    var spread = 1.6;
    for (var i = 0; i < n; i++) {
      var k = (i === 0) ? knights[0] : makeKnightState();
      if (i > 0) {
        k.group = new THREE.Group();
        scene.add(k.group);
        var clone = knightProto.clone(true);
        // clone materials so a flinch flash is per-knight, not squad-wide
        clone.traverse(function (o) {
          if (o.isMesh && o.material) {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            var copy = mats.map(function (m) { var c = m.clone(); k.mats.push(c); return c; });
            o.material = Array.isArray(o.material) ? copy : copy[0];
            o.castShadow = true;
          }
        });
        /* NOT `k.group.add(clone)` first: mountKnight rigs the model where it
           stands, and a clone already parented to a group sitting at the
           spawn would bake that offset into every bone. §21's "measured in
           the wrong space" bug, one line of setup away from coming back. */
        mountKnight(k, clone);
        var lc = (D().lights || {}).knight || {};
        k.light = new THREE.PointLight(lc.color != null ? lc.color : 0xff2038,
          (lc.intensity != null ? lc.intensity : 0.55) * LIGHT_SCALE,
          lc.distance || 4.5, lc.decay || 2);
        k.light.position.set(0, 0.25, 0);
        k.group.add(k.light);
        knights.push(k);
      }
      k.alive = true;
      /* §22: a fresh brain per knight, per round — the personality is dealt
         HERE, so a squad is a mix of fighters rather than one temperament
         wearing N bodies, and last round's stagger meter never carries over. */
      initBrain(k, i);
      restoreSword(k);
      k.anim.dashCd = i * 1.2;          // stagger their dashes
      // fan them out across the nave in front of the altar
      /* Fan the squad ACROSS the approach, not along a fixed axis, so the
         line stays abreast whichever way the spawns face. */
      /* `!= null`, not `||`. The church spawns at z -5.4 so the old default-or
         never fired, but the Ring puts him on z 0 — and `0 || 5.4` is 5.4, so
         the whole squad would have fanned 5.4m off the stage's own spawn line.
         A legitimate zero coordinate is exactly what a centred stage has. */
      var bx = (kcfg.x != null ? kcfg.x : 0), bz = (kcfg.z != null ? kcfg.z : 5.4);
      var ax = pos.x - bx, az = pos.z - bz;
      var al = Math.sqrt(ax * ax + az * az) || 1;
      var px2 = -az / al, pz2 = ax / al;          // perpendicular, unit
      var off = (i - (n - 1) / 2) * spread;
      var sx = bx + px2 * off + (ax / al) * -Math.abs(off) * 0.35;
      var sz = bz + pz2 * off + (az / al) * -Math.abs(off) * 0.35;
      var spot = navNearest(sx, sz, KNIGHT_RADIUS);
      k.group.position.set(spot.x, 0, spot.z);
      k.group.visible = true;
      faceKnightTo(k, pos.x, pos.z);
    }
  }

  function nearestKnight() {
    var best = null, bd = Infinity;
    for (var i = 0; i < knights.length; i++) {
      var k = knights[i];
      if (!k.alive || !k.group) continue;
      var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
      var d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  A.nearestKnightDist = function () {
    var k = nearestKnight();
    if (!k) return Infinity;
    var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  };

  A.spawnSquad = function (n) { spawnSquad(Math.max(1, n || 1)); };
  A.squadSize = function () { return knights.length; };

  /* §28 A: what each knight on the floor currently IS. The 3D layer owns this
     because it owns the personality, the seconds alive and the moment of
     death; engine/combat3.js pulls it every tick and reprices the squad off
     it. Pulled rather than pushed on purpose — combat3 already calls in here
     for the §23 stun, so the dependency runs one way and a no-WebGL machine
     degrades through disableAPI's version of this function instead of
     needing a second code path. `n` pads the answer for a caller with more
     entries than the arena has knights (a squad the 3D layer never got to
     spawn), so an index never comes back undefined. */
  A.knightLevels = function (n) {
    var out = [], i;
    for (i = 0; i < knights.length; i++) out.push(knights[i].level || 1);
    var kt = ktree();
    var pad = kt ? kt.level() : 1;
    for (i = out.length; i < (n || 0); i++) out.push(pad);
    return out;
  };

  function yawTo(k, x, z) {
    return Math.atan2(x - k.group.position.x, z - k.group.position.z) +
           ((D().knight && D().knight.rotY) || 0);
  }
  /* Hard snap. Spawning and resetting want a placement, not a turn. */
  function faceKnightTo(k, x, z) {
    if (!k || !k.group) return;
    k.baseRot = yawTo(k, x, z);
    k.group.rotation.y = k.baseRot;
  }
  /* §21: TURN toward a target instead of teleporting to it. His body yaw was
     hard-assigned every frame, so strafing around him snapped his whole body
     — sword mid-flight included — from one heading to the next. Shortest-angle
     wrap, or crossing +/-PI spins him the long way round. */
  /* §22: `rate` is the brain's turnRate — an exponential approach rate, not a
     hard angular cap. A cap would put a constant angular velocity back on the
     body and undo exactly what §21 bought; easing at a LOWER rate is what
     makes `recover` read as "he cannot get round in time". */
  function easeYaw(k, target, dt, rate) {
    if (!k || !k.group) return;
    var d = target - k.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    k.group.rotation.y += d * alpha(rate == null ? 9 : rate, dt);
    k.baseRot = target;
  }

  // HDRI -> PMREM -> scene.environment. Gives the stone and glass real
  // image-based light; failure just leaves the rig lighting alone (§14 pattern).
  var envPath = null;   // §24: which probe is currently resolved on the scene

  function loadEnvironment() {
    var path = D().hdri;
    /* §24. Two early outs, and both are about stage switching:
       - the same probe is already resolved: re-running the PMREM pass on a
         stage switch would cost a full HDRI decode for an identical result.
       - the stage declares `hdri: null` (the Ring): KEEP whatever is resolved
         rather than clearing it. data/stages.js counts on that — the Ring's
         materials all set userData.envClamp precisely because the church's
         probe may still be live when you walk in. Clearing it here would make
         the Ring's look depend on which stage you came from. */
    if (path && path === envPath && envMapOk) return;
    if (!path) return;
    assetExpect('hdri');
    envMapOk = false;
    if (!THREE.RGBELoader || !THREE.PMREMGenerator) { assetDone('hdri', 'skipped'); return; }
    envPath = path;
    var pmrem = null;
    function bail() { if (pmrem) { try { pmrem.dispose(); } catch (e) {} pmrem = null; } }
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      new THREE.RGBELoader().load(versioned(path), function (hdrTex) {
        try {
          if (!pmrem || renderFailed) { bail(); return; }
          scene.environment = pmrem.fromEquirectangular(hdrTex).texture;
          envMapOk = true;
          applyEnvIntensity();
        } catch (e) { envMapOk = false; }
        try { hdrTex.dispose(); } catch (e) {}
        bail();
        assetDone('hdri');
      }, undefined, function () { bail(); assetDone('hdri', 'failed'); });
    } catch (e) { bail(); assetDone('hdri', 'failed'); }
  }

  function applyEnvIntensity() {
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        if ('envMapIntensity' in mats[i]) {
          /* A material that asked to be damped keeps its own value — this
             runs when the HDRI resolves, long after the material was made,
             and used to flatten dark oak and leather into white plastic. */
          var want = mats[i].userData && mats[i].userData.envClamp;
          mats[i].envMapIntensity = (want != null) ? want : ENV_INTENSITY;
          mats[i].needsUpdate = true;
        }
      }
    });
  }

  // ---------------------------------------------------------------- build
  /* §24: every light below goes into `stageRoot`, not into the scene. A light
     parented straight to the scene survives a stage teardown, and four of
     those stacked up over three rounds is how a "clean" switch quietly ends
     up twice as bright as it started. */
  function buildLights() {
    var L = D().lights || {};
    var root = stageRoot || scene;
    var amb = L.ambient || {};
    root.add(new THREE.AmbientLight(amb.color != null ? amb.color : 0x5a5f6a,
      (amb.intensity != null ? amb.intensity : 1.0) * LIGHT_SCALE));

    // cold moonlight raking in through the stained glass
    var mn = L.moon || {};
    var moon = new THREE.DirectionalLight(mn.color != null ? mn.color : 0xaebdd6,
      (mn.intensity != null ? mn.intensity : 2.2) * LIGHT_SCALE);
    moon.position.set(mn.x || 6, mn.y || 12, mn.z || -4);
    if (renderer.shadowMap && renderer.shadowMap.enabled) {
      moon.castShadow = true;
      moon.shadow.mapSize.set(1024, 1024);
      var cam = moon.shadow.camera;
      cam.left = -12; cam.right = 12; cam.top = 12; cam.bottom = -12;
      cam.near = 0.5; cam.far = 40;
    }
    root.add(moon);

    // a soft fill from the nave behind so the space reads as a room, not a pit
    var fill = L.fill || {};
    var fillLight = new THREE.HemisphereLight(
      fill.sky != null ? fill.sky : 0x8092c0,
      fill.ground != null ? fill.ground : 0x241c1e,
      (fill.intensity != null ? fill.intensity : 0.9) * LIGHT_SCALE);
    root.add(fillLight);

    /* Red altar glow behind the knight — and now CONDITIONAL. It used to be
       built from defaults whether or not the rig asked for one, which the
       church never noticed (it always asks) but which would hang a red accent
       at z -5.5 in the middle of an empty Ring. `key`/`key2`/`candles` were
       already opt-in; ambient/moon/fill stay unconditional so the church's
       look is unchanged to the pixel. */
    if (L.altar) {
      var al = L.altar;
      var altar = new THREE.PointLight(al.color != null ? al.color : 0xe5173f,
        (al.intensity != null ? al.intensity : 3.2) * LIGHT_SCALE,
        al.distance || 18, al.decay || 1.5);
      altar.position.set(al.x || 0, al.y || 2.6, al.z || -5.5);
      root.add(altar);
    }

    // neutral keys above the arena so the knight and the aisle stay readable
    [L.key, L.key2].forEach(function (k) {
      if (!k) return;
      var kl = new THREE.PointLight(k.color != null ? k.color : 0xd8e2f2,
        (k.intensity != null ? k.intensity : 3.0) * LIGHT_SCALE,
        k.distance || 24, k.decay || 1.4);
      kl.position.set(k.x || 0, k.y || 5, k.z || 0);
      root.add(kl);
    });

    var cands = L.candles || [];
    for (var i = 0; i < cands.length; i++) {
      var base = 1.6 * LIGHT_SCALE;
      var c = new THREE.PointLight(0xffa050, base, 8, 2);
      c.position.set(cands[i].x || 0, 1.1, cands[i].z || 0);
      c.userData.baseI = base;
      c.userData.phase = Math.random() * 10;
      root.add(c);
      candleLights.push(c);
    }
  }
  /* Flickered every frame by updateFx. §24: this array is the one piece of
     light state that lives OUTSIDE the scene graph, so teardownStage has to
     empty it by hand — otherwise the Ring spends every frame setting the
     intensity of two church candles that were removed three rounds ago. */
  var candleLights = [];

  function cfgSpawn() { return D().playerSpawn || { x: 0, z: 4.6, yaw: 0 }; }

  /* ================================================================ §24 stages
     THE PLACE, built and unbuilt.

     Everything a stage puts in the world hangs off ONE group, `stageRoot`.
     That is the whole containment strategy and it is deliberate: "did I
     remember to remove the second key light" is not a question a person can
     reliably answer three rounds into a run, but "is stageRoot's parent null"
     is. Teardown removes that one node and disposes every geometry, material
     and texture underneath it.

     What must NOT be in stageRoot, and why:
       - the knight groups (added to the scene by loadKnight/spawnSquad). They
         outlive the stage; they are repositioned, not rebuilt.
       - the first-person arms, hand sign, tornado, asteroid and the pooled
         shockwave rings. All stage-independent VFX, all pre-warmed once (§21);
         rebuilding them per stage would re-pay the 444ms upload §21 exists to
         kill.
       - the parsed church glb, which is CACHED (see churchGroup) — detached
         from stageRoot on teardown, handed back on the next church build.

     Three things leak outside the scene graph and are therefore reset by hand:
     `candleLights` and `rimLights` (arrays the frame loop flickers), the
     navgrid + its measurement, and the pending church fallback timer. */
  var stageRoot = null;
  var stageEpoch = 0;     // bumped per build; async loaders carry a copy and bail if it moves
  var rimLights = [];     // §24 Ring pylon lights — flicker-free, but the array still needs emptying

  /* Free the GPU side of a subtree. Geometries, materials and every texture
     slot a material can hold, each disposed exactly once — a material shared
     by 40 pylon meshes must not be disposed 40 times.

     LIGHTS TOO, and that one is not obvious: a shadow-casting light owns a
     WebGLRenderTarget that three allocates lazily, on the first shadow pass
     after the light joins the scene. Removing the light from the graph does
     NOT free it — only light.dispose() -> shadow.dispose() does. buildLights()
     makes a fresh castShadow moon every stage build, so without this a full
     church -> Ring -> church cycle leaked exactly one shadow map, measured as
     renderer.info.memory.textures climbing +2 per cycle and never coming back
     down while the scene graph counts looked perfectly clean. Light.dispose()
     is a no-op on the ambient/hemisphere lights, so calling it on every light
     is safe. */
  var DISPOSE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
                       'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap',
                       'envMap', 'specularMap'];
  function disposeTree(root) {
    if (!root) return { geometries: 0, materials: 0, textures: 0, lights: 0 };
    var geos = [], mats = [], texs = [], lits = [];
    var n = { geometries: 0, materials: 0, textures: 0, lights: 0 };
    root.traverse(function (o) {
      if (o.isLight && lits.indexOf(o) === -1) lits.push(o);
      if (o.geometry && geos.indexOf(o.geometry) === -1) geos.push(o.geometry);
      if (!o.material) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || mats.indexOf(m) !== -1) continue;
        mats.push(m);
        for (var s = 0; s < DISPOSE_SLOTS.length; s++) {
          var t = m[DISPOSE_SLOTS[s]];
          if (t && t.isTexture && texs.indexOf(t) === -1) texs.push(t);
        }
      }
    });
    var j;
    for (j = 0; j < geos.length; j++) { try { geos[j].dispose(); n.geometries++; } catch (e) {} }
    for (j = 0; j < mats.length; j++) { try { mats[j].dispose(); n.materials++; } catch (e) {} }
    for (j = 0; j < texs.length; j++) { try { texs[j].dispose(); n.textures++; } catch (e) {} }
    for (j = 0; j < lits.length; j++) { try { lits[j].dispose(); n.lights++; } catch (e) {} }
    return n;
  }

  function teardownStage() {
    /* Bump FIRST. Every in-flight loader compares against this, so anything
       still on the wire is stale from the moment we decide to tear down —
       not from the moment we finish. */
    stageEpoch++;
    if (churchTimer) { window.clearTimeout(churchTimer); churchTimer = 0; }
    // the expensive church survives; detach it before the disposal sweep
    if (churchGroup && churchGroup.parent) churchGroup.parent.remove(churchGroup);
    if (stageRoot) {
      if (stageRoot.parent) stageRoot.parent.remove(stageRoot);
      disposeTree(stageRoot);
      stageRoot = null;
    }
    churchFallback = null;      // it lived inside stageRoot; already disposed
    churchLoaded = false;
    candleLights.length = 0;
    rimLights.length = 0;
    assetForget('stagetex@');   // those textures are disposed; stop counting them
    /* The navgrid belongs to the stone that was standing. Leaving it behind is
       the single nastiest way to get this wrong: the Ring would clamp the
       player against the church's baked floor and the radius clamp §24 asks
       for would never run at all. */
    nav = null;
    arenaArea = null;
  }

  function applyFog() {
    var fg = D().fog || {};
    var col = fg.color != null ? fg.color : 0x0d1018;
    if (scene.background && scene.background.isColor) scene.background.setHex(col);
    else scene.background = new THREE.Color(col);
    if (scene.fog) {
      scene.fog.color.setHex(col);
      scene.fog.near = fg.near || 14;
      scene.fog.far = fg.far || 70;
    } else {
      scene.fog = new THREE.Fog(col, fg.near || 14, fg.far || 70);
    }
  }

  function buildStage() {
    stageRoot = new THREE.Group();
    stageRoot.name = 'stage:' + (stageId || 'legacy');
    scene.add(stageRoot);
    applyFog();
    buildLights();
    if (stageDef && stageDef.shape === 'round') buildRing();
    else loadChurch();          // 'model', and the no-stages.js legacy path
    loadEnvironment();
    /* The new stage's materials have never been drawn, so their programs and
       texture uploads are unwarmed again. Re-arming the §21 gate here is what
       keeps the first frame in the Ring from hitching the way the first Fire
       Tornado used to. assetsReady() re-runs warmShaders() behind the veil. */
    assets.warm = false;
  }

  /* ------------------------------------------------------------- The Ring
     §24: ~615 m² of clear floor, built from primitives and textures we
     already ship. Blank is the POINT — floor, kerb, a ring of pylons for
     rotation cues, and dark void. Nothing inside the circle, no colliders but
     the perimeter, and `nav` stays null so §22's radius clamp does the
     containment. That is why the Ring needs no bake.
     Every material here sets userData.envClamp (§14/§20): arriving from the
     church leaves a lit-interior probe resolved on the scene, and without the
     clamp applyEnvIntensity renders this dark floor as white plastic. */
  function ringTexture(key, cfgBlock, build, epoch) {
    var path = (build.textures || {})[cfgBlock.tex];
    if (!path || typeof THREE.TextureLoader !== 'function') return null;
    /* One Texture per SURFACE, not per file: floor and kerb are the same jpg
       at different repeats, and repeat lives on the texture object. */
    var slot = 'stagetex@' + epoch + ':' + key;
    assetExpect(slot);
    var tex = new THREE.TextureLoader().load(path,
      function () { assetDone(slot); },
      undefined,
      function () { assetDone(slot, 'failed'); });
    if (THREE.RepeatWrapping !== undefined) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
    }
    var rep = cfgBlock.repeat || 1;
    if (tex.repeat && tex.repeat.set) tex.repeat.set(rep, rep);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    return tex;
  }

  function ringMaterial(opts) {
    var m = new THREE.MeshStandardMaterial(opts);
    /* A NUMBER, not `true`. data/stages.js says `envClamp: true` meaning "damp
       this"; applyEnvIntensity reads the value and assigns it straight to
       envMapIntensity, so a boolean would set intensity 1 — the exact
       white-plastic bug the clamp exists to prevent. §14's figure is ~0.1. */
    m.userData.envClamp = 0.1;
    m.envMapIntensity = 0.1;
    return m;
  }

  function buildRing() {
    var b = (stageDef && stageDef.build) || {};
    var epoch = stageEpoch;
    var root = stageRoot;
    var i;

    /* The void first, and UNLIT (MeshBasicMaterial) in the fog colour. A
       standard material here catches the key light and turns the edge of the
       world into a grey table; basic + fog colour means the floor simply stops
       having edges. Dropped 0.4m so it can never z-fight the disc. */
    var vd = b['void'] || { color: 0x05060a, radius: 90 };
    var voidMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(vd.radius || 90, vd.radius || 90, 0.2, 24),
      new THREE.MeshBasicMaterial({ color: vd.color != null ? vd.color : 0x05060a,
                                    fog: true, depthWrite: true }));
    voidMesh.position.y = -0.5;
    root.add(voidMesh);

    // ---- floor disc: top face at y = 0, so every hit test and every probe
    // that assumes ground level still agrees with the church.
    var fl = b.floor || { radius: 16.5, segments: 96 };
    var fr = fl.radius || 16.5;
    var floorMat = ringMaterial({
      color: fl.color != null ? fl.color : 0x6d6a66,
      roughness: fl.roughness != null ? fl.roughness : 0.95,
      metalness: fl.metalness != null ? fl.metalness : 0.0,
      map: ringTexture('floor', fl, b, epoch)
    });
    var floor = new THREE.Mesh(
      new THREE.CylinderGeometry(fr, fr, 0.2, fl.segments || 96), floorMat);
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    root.add(floor);

    /* ---- kerb: three primitives sharing one material rather than a lathe,
       because every geometry used here is one this file already builds and a
       lathe's winding is easy to get inside-out. DoubleSide because you see
       the inner face from the arena and the outer face from nowhere — cheaper
       than getting normals right on both walls. 0.9m: high enough to read as a
       boundary, never high enough to hide a knight behind. */
    var kb = b.kerb || { inner: 14.4, outer: 14.95, height: 0.9, segments: 96 };
    var ki = kb.inner || 14.4, ko = kb.outer || 14.95, kh = kb.height || 0.9;
    var kseg = kb.segments || 96;
    var kerbMat = ringMaterial({
      color: kb.color != null ? kb.color : 0x4a4744,
      roughness: kb.roughness != null ? kb.roughness : 0.9,
      map: ringTexture('kerb', kb, b, epoch),
      side: THREE.DoubleSide
    });
    var inner = new THREE.Mesh(new THREE.CylinderGeometry(ki, ki, kh, kseg, 1, true), kerbMat);
    inner.position.y = kh / 2;
    root.add(inner);
    var outer = new THREE.Mesh(new THREE.CylinderGeometry(ko, ko, kh, kseg, 1, true), kerbMat);
    outer.position.y = kh / 2;
    root.add(outer);
    var capGeo = new THREE.RingGeometry(ki, ko, kseg);
    capGeo.rotateX(-Math.PI / 2);
    var cap = new THREE.Mesh(capGeo, kerbMat);
    cap.position.y = kh;
    root.add(cap);

    /* ---- pylons. The count is the whole readability budget of a blank floor:
       they are the only thing telling you which way you have turned and how
       far away he is. They stand OUTSIDE the kerb and outside the clamp, which
       is how the Ring keeps its promise of "no colliders but the perimeter" —
       you cannot reach them, so they cannot be walked into.
       Only every `litEvery`-th post carries a real PointLight. Twelve punctual
       lights would push three r128 into recompiling every material in the
       scene, and four already says which way you are facing. */
    var py = b.pylons || {};
    var pn = py.count || 12, prad = py.radius || 15.6, ph = py.height || 2.6;
    var postR = py.postRadius || 0.16, capR = py.capRadius || 0.26;
    var every = Math.max(1, py.litEvery || 3), phase = py.litPhase || 0;
    var postMat = ringMaterial({ color: py.color != null ? py.color : 0x1a1a1e,
                                 roughness: 0.85, metalness: 0.2 });
    /* The lamp head is emissive and NOT env-clamped the same way — it is meant
       to be the brightest thing on the floor. MeshBasic would ignore fog
       falloff across 28m, so it stays standard with a strong emissive. */
    var lampMat = new THREE.MeshStandardMaterial({
      color: 0x120d08,
      emissive: py.emissive != null ? py.emissive : 0xff6a18,
      emissiveIntensity: py.emissiveIntensity != null ? py.emissiveIntensity : 1.6,
      roughness: 0.6
    });
    lampMat.userData.envClamp = 0.1;
    lampMat.envMapIntensity = 0.1;
    var postGeo = new THREE.CylinderGeometry(postR * 0.85, postR, ph, 8);
    var lampGeo = new THREE.CylinderGeometry(capR, capR * 0.45, 0.34, 10);
    var rim = (D().lights || {}).rim || null;
    for (i = 0; i < pn; i++) {
      /* phase 0 puts post 0 on +X, which is where the knight spawns — so the
         opening beat of a Ring fight has him backlit. */
      var ang = (i / pn) * Math.PI * 2;
      var px = Math.cos(ang) * prad, pz = Math.sin(ang) * prad;
      var post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, ph / 2, pz);
      root.add(post);
      var lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(px, ph + 0.12, pz);
      root.add(lamp);
      if (rim && (i % every) === (phase % every)) {
        var pl = new THREE.PointLight(rim.color != null ? rim.color : 0xff7a2a,
          (rim.intensity != null ? rim.intensity : 2.4) * LIGHT_SCALE,
          rim.distance || 22, rim.decay || 1.25);
        pl.position.set(px, rim.y != null ? rim.y : 2.5, pz);
        root.add(pl);
        rimLights.push(pl);
      }
    }

    /* nav STAYS NULL. §22's radius/bounds fallback in updatePlayer and
       updateOneKnight is the containment here, exercised rather than
       duplicated — a second clamp written next to it is a second clamp to
       keep in step, and the two would disagree the first time either moved. */
    nav = null;
    arenaArea = null;
    console.info('[arena3d] stage "' + (stageDef ? stageDef.id : '?') + '" built: round floor r=' +
                 ((D().arena || {}).radius || '?') + 'm, ' + pn + ' pylons, ' +
                 rimLights.length + ' rim lights, nav=null (radius clamp)');
  }

  /* Put the squad back on the floor of the stage that is standing now. On a
     stage switch their group positions are still the OLD stage's coordinates —
     in the Ring that is merely wrong, but going the other way it is a knight
     standing inside the rood screen. spawnSquad already fans them across the
     approach and walks each one onto legal ground, so reuse it rather than
     writing a second placement rule. */
  function placeSquad() {
    var n = knights.length;
    if (knightProto) { spawnSquad(n); return; }
    // the knight glb has not landed yet: spawnSquad would only queue, so move
    // the leader by hand and let the loader's pendingSquad path do the rest
    var kc = D().knight || {};
    for (var i = 0; i < n; i++) {
      if (!knights[i].group) continue;
      var spot = navNearest(kc.x || 0, kc.z || 0, KNIGHT_RADIUS);
      knights[i].group.position.set(spot.x, 0, spot.z);
    }
  }

  /* §24 public: choose the stage. MUST be called BEFORE init() on the first
     fight (init builds whatever is selected); after that it may be called
     between rounds and rebuilds the world in place. Returns true when the
     world changed. */
  A.setStage = function (id) {
    /* Accept the stage OBJECT as well as its id. ui/battle3d.js probes both
       forms because the argument shape is this file's to decide; answering
       "unknown stage [object Object]" to a caller holding the right entry
       would be a pointless way to fail. */
    if (id && typeof id === 'object' && typeof id.id === 'string') id = id.id;
    var def = S.get(id);
    if (id && !def) {
      console.warn('[arena3d] unknown stage "' + id + '" — staying on ' + (stageId || 'church'));
      return false;
    }
    if (stageId === id && (!inited || stageRoot)) return false;   // already standing in it
    stageId = id || null;
    stageDef = def;
    invalidateCfg();
    if (!inited) return true;      // init() will build it
    teardownStage();
    buildStage();
    /* Order matters: reset() reads the new spawn out of the refreshed cfg and
       puts the camera and every knight's pose back, THEN placeSquad walks the
       bodies onto the new floor. Doing it the other way round leaves them
       facing the old stage's player position. */
    A.reset();
    placeSquad();
    return true;
  };

  A.stageInfo = function () { return stageDef; };

  // ------------------------------------------------- first-person arms (§17)
  /* The punch rig is parented to the camera with its head bone collapsed, so
     the player sees their own arms swing. Missing asset = no arms, never a
     crash: the fight still resolves through engine/combat3.js. */
  function loadFirstPerson() {
    assetExpect('punch');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.punch) { assetDone('punch', 'skipped'); return; }
    loader.load(versioned(models.punch), function (gltf) {
      try {
        var place = D().firstPerson || {};
        var model = gltf.scene;

        /* Auto-fit instead of hand-tuned offsets: the source rig arrives
           lying along its longest axis and at an arbitrary scale, so measure
           it, stand that axis up, scale to a real body height, and drop it so
           the camera sits at eye level. Wrapped in a group so the animation
           keeps driving the model's own transform. */
        /* Fit from the SKELETON, not Box3: setFromObject on a SkinnedMesh
           reports un-posed bind bounds, which gave a wrong up-axis and scale.
           Measure inside a detached group (identity transform) so bone world
           positions ARE rig-local, then anchor the head bone to the camera so
           the player looks out of the character's own eyes. */
        fp.root = new THREE.Group();
        fp.root.add(model);
        fp.root.updateMatrixWorld(true);

        var bones = {};
        model.traverse(function (o) { if (o.isBone) bones[o.name] = o; });
        var head = bones.Head_M, foot = bones.Ankle_L || bones.Ankle_R || bones.Root_M;
        var targetH = place.height || 1.75;
        var hv = new THREE.Vector3(), fv = new THREE.Vector3();

        if (head && foot) {
          head.getWorldPosition(hv); foot.getWorldPosition(fv);
          var d = hv.clone().sub(fv);
          var ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
          if (az >= ay && az >= ax) model.rotation.x = (d.z > 0) ? -Math.PI / 2 : Math.PI / 2;
          else if (ax >= ay) model.rotation.z = (d.x > 0) ? Math.PI / 2 : -Math.PI / 2;
          /* Face the same way as the camera (-Z) so punches travel forward.
             This spin goes on the WRAPPER, not the model: composing it into
             the same Euler as the stand-up rotation flips the rig upside down. */
          fp.root.rotation.y = (place.rotY != null ? place.rotY : Math.PI);
          fp.root.updateMatrixWorld(true);

          head.getWorldPosition(hv); foot.getWorldPosition(fv);
          var span = Math.abs(hv.y - fv.y);
          // the head BONE sits at roughly 0.9 of standing height
          if (span > 0.001) model.scale.multiplyScalar((targetH * 0.9) / span);
          fp.root.updateMatrixWorld(true);

          // put the head bone exactly where the camera is, then nudge to taste
          head.getWorldPosition(hv);
          fp.root.position.set(
            (place.x || 0) - hv.x,
            (place.y || 0) - hv.y,
            (place.z || 0) - hv.z
          );
        }
        fp.model = model;
        model.traverse(function (o) {
          if (o.isMesh) {
            o.frustumCulled = false;    // it hugs the near plane
            o.renderOrder = 900;
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              if (!mats[i]) continue;
              /* Sitting right at the lens with nothing occluding them, the
                 arms take the full arena key + IBL and blow out to white.
                 Pin a flesh tone and damp the environment (same lesson as the
                 dressing-room hands). */
              if (mats[i].color) mats[i].color.setRGB(0.27, 0.18, 0.15);
              if ('envMapIntensity' in mats[i]) { mats[i].envMapIntensity = 0.06; mats[i].userData.envClamp = 0.06; }
              if (typeof mats[i].metalness === 'number') mats[i].metalness = 0;
              if (typeof mats[i].roughness === 'number') mats[i].roughness = 0.9;
            }
          }
          if (o.isBone && /^Head_M$/i.test(o.name)) fp.headBone = o;
        });
        if (fp.headBone) fp.headBone.scale.setScalar(0.001);

        fp.mixer = new THREE.AnimationMixer(model);
        (gltf.animations || []).forEach(function (clip) { fp.clips[clip.name] = clip; });
        camera.add(fp.root);
        if (scene.children.indexOf(camera) === -1) scene.add(camera);
        fp.root.visible = false;        // only while swinging
        fp.loaded = true;
      } catch (e) { console.warn('[arena3d] first-person rig failed', e); }
      assetDone('punch');
    }, undefined, function () {
      assetDone('punch', 'failed');
      console.warn('[arena3d] punch.glb failed to load — no first-person arms');
    });
  }

  // --------------------------------------------- §18 hand sign + fire tornado
  var sign = { hand: null, rune: null, t: 0, active: false };
  var tornado = { root: null, tubes: [], light: null, t: 0, active: false, dur: 2.4 };

  /* A glowing rune traced off the fingertips while a sign-cast winds up. */
  function makeRuneTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = '#ffb03a'; g.lineWidth = 7; g.shadowColor = '#ff5a1a'; g.shadowBlur = 18;
    g.beginPath(); g.arc(128, 128, 92, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4;
    g.beginPath(); g.arc(128, 128, 62, 0, Math.PI * 2); g.stroke();
    // inner triangle + spokes: reads as a sigil at any size
    g.lineWidth = 6;
    g.beginPath();
    for (var i = 0; i < 3; i++) {
      var a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
      var x = 128 + Math.cos(a) * 78, y = 128 + Math.sin(a) * 78;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath(); g.stroke();
    g.lineWidth = 3;
    for (var k = 0; k < 12; k++) {
      var ang = k * Math.PI / 6;
      g.beginPath();
      g.moveTo(128 + Math.cos(ang) * 94, 128 + Math.sin(ang) * 94);
      g.lineTo(128 + Math.cos(ang) * 116, 128 + Math.sin(ang) * 116);
      g.stroke();
    }
    var t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }

  function loadHandSign() {
    assetExpect('handsign');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.handsign) { assetDone('handsign', 'skipped'); return; }
    loader.load(versioned(models.handsign), function (gltf) {
      try {
        var p = D().handSign || {};
        var h = gltf.scene;
        h.traverse(function (o) {
          if (o.isMesh) {
            o.frustumCulled = false;
            o.renderOrder = 950;
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              if (!mats[i]) continue;
              if (mats[i].color) mats[i].color.setRGB(0.30, 0.20, 0.16);
              if ('envMapIntensity' in mats[i]) { mats[i].envMapIntensity = 0.06; mats[i].userData.envClamp = 0.06; }
              if (typeof mats[i].roughness === 'number') mats[i].roughness = 0.9;
              if (mats[i].emissive) { mats[i].emissive.setHex(0x3a1200); mats[i].emissiveIntensity = 0.0; }
            }
          }
        });
        h.position.set(p.x || 0.26, p.y != null ? p.y : -0.24, p.z != null ? p.z : -0.42);
        h.rotation.set(p.rotX || 0, p.rotY || 0, 0);
        h.scale.setScalar(p.scale || 1.5);
        h.visible = false;
        camera.add(h);
        if (scene.children.indexOf(camera) === -1) scene.add(camera);
        sign.hand = h;

        // the sigil sits just past the fingertips
        var rune = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.42),
          new THREE.MeshBasicMaterial({
            map: makeRuneTexture(), transparent: true, opacity: 0,
            depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
          }));
        rune.position.set(0.22, -0.1, -0.72);
        rune.renderOrder = 960;
        rune.frustumCulled = false;
        rune.visible = false;
        camera.add(rune);
        sign.rune = rune;
      } catch (e) { console.warn('[arena3d] hand sign failed', e); }
      assetDone('handsign');
    }, undefined, function () {
      console.warn('[arena3d] handsign.glb missing');
      assetDone('handsign', 'failed');
    });
  }

  // ------------------------------------------------------- §21 asteroid
  /* The level-3 spell: a burning rock falls out of the vault onto the spot
     you aimed at, and everything near the crater takes it. Unlike the tornado,
     which parks on one knight and chases him, this one commits to a POINT -
     which is what makes it the answer to a round fielding six knights. */
  var rock = {
    root: null, inner: null, mats: [], light: null, motes: [], ring: null,
    active: false, landed: false, t: 0, dur: 0.85, impact: 0,
    from: 11, x: 0, z: 0, onLand: null
  };

  function loadAsteroid() {
    assetExpect('asteroid');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.asteroid) { assetDone('asteroid', 'skipped'); return; }
    loader.load(versioned(models.asteroid), function (gltf) {
      try {
        var cfgA = D().asteroid || {};
        var root = gltf.scene;
        var box = new THREE.Box3().setFromObject(root);
        var d = Math.max(0.01, Math.max(box.max.x - box.min.x,
                                        box.max.y - box.min.y,
                                        box.max.z - box.min.z));
        root.scale.setScalar((cfgA.size || 1.5) / d);

        root.traverse(function (o) {
          if (!o.isMesh || !o.material) return;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) {
            var m = mats[i];
            if (!m) continue;
            /* The pack ships a molten-crack emissive map. That IS the look of
               the spell, so push it rather than trying to light the rock. */
            if (m.emissive) { m.emissive.setHex(cfgA.glow || 0xff6a18); m.emissiveIntensity = 2.4; }
            if ('envMapIntensity' in m) { m.envMapIntensity = 0.25; m.userData.envClamp = 0.25; }
            rock.mats.push(m);
          }
        });

        var wrap = new THREE.Group();
        wrap.add(root);
        wrap.visible = false;
        scene.add(wrap);
        rock.root = wrap;
        rock.inner = root;

        rock.light = new THREE.PointLight(cfgA.glow || 0xff6a18, 0, 14, 1.9);
        wrap.add(rock.light);

        // ember motes streaming off it on the way down
        var n = cfgA.trailCount || 14;
        var moteGeo = new THREE.SphereGeometry(0.06, 6, 5);
        for (var q = 0; q < n; q++) {
          var mm = new THREE.Mesh(moteGeo, new THREE.MeshBasicMaterial({
            color: 0xffa040, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false
          }));
          mm.visible = false;
          scene.add(mm);
          rock.motes.push({ mesh: mm, off: Math.random(),
                            spread: 0.35 + Math.random() * 0.5,
                            ang: Math.random() * Math.PI * 2 });
        }

        // the crater flash: a flat ring that punches outward on impact
        var ringGeo = new THREE.RingGeometry(0.2, 1.0, 28);
        ringGeo.rotateX(-Math.PI / 2);
        rock.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
          color: cfgA.glow || 0xff6a18, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.DoubleSide
        }));
        rock.ring.visible = false;
        scene.add(rock.ring);
      } catch (e) { console.warn('[arena3d] asteroid failed', e); }
      assetDone('asteroid');
    }, undefined, function () {
      console.warn('[arena3d] asteroid.glb missing');
      assetDone('asteroid', 'failed');
    });
  }

  /* Aim point: the living knight nearest to where you are LOOKING, not the
     one nearest your body - you should be able to pick which cluster eats it. */
  function asteroidAim() {
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < knights.length; i++) {
      var k = knights[i];
      if (!k.alive || !k.group) continue;
      var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
      var dot = (dx / dist) * fx + (dz / dist) * fz;   // 1 = dead ahead
      if (dot < 0.2) continue;                          // behind you: never
      var score = dot * 2.2 - dist * 0.06;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best) return { x: best.group.position.x, z: best.group.position.z };
    // nobody in front of you: drop it down your sightline anyway
    return { x: pos.x + fx * 6, z: pos.z + fz * 6 };
  }

  /* Start the fall. `onLand` fires on the frame it hits, which is what the UI
     hangs the damage on, so the number and the crater are the same moment. */
  A.spawnAsteroid = function (onLand) {
    if (!rock.root) { if (onLand) onLand(); return false; }
    var ab = (CHLOE.data.abilities || {}).asteroid || {};
    var aim = asteroidAim();
    rock.x = aim.x; rock.z = aim.z;
    rock.from = ab.fallFrom || 11;
    rock.dur = (ab.fallMs || 850) / 1000;
    rock.t = 0;
    rock.active = true;
    rock.landed = false;
    rock.onLand = onLand || null;
    rock.root.position.set(rock.x, rock.from, rock.z);
    rock.root.visible = true;
    if (rock.inner) rock.inner.rotation.set(0, 0, 0);
    return true;
  };

  /* Who is standing in the crater. Splash does not care about your facing. */
  A.asteroidTargets = function (radius) {
    var r = radius || 3.4, out = [];
    for (var i = 0; i < knights.length; i++) {
      var k = knights[i];
      if (!k.alive || !k.group) continue;
      var dx = k.group.position.x - rock.x, dz = k.group.position.z - rock.z;
      if (dx * dx + dz * dz <= r * r) out.push(i);
    }
    return out;
  };

  A.asteroidPoint = function () { return { x: rock.x, z: rock.z }; };
  A.asteroidActive = function () { return rock.active; };

  function updateAsteroid(dt) {
    var cfgA = D().asteroid || {};

    // the crater keeps burning after the rock is gone
    if (rock.ring && rock.ring.visible) {
      rock.impact += dt;
      var life = (cfgA.impactMs || 620) / 1000;
      var f = Math.min(1, rock.impact / life);
      rock.ring.scale.setScalar(0.6 + f * 3.4);
      rock.ring.material.opacity = 0.9 * (1 - f);
      if (rock.light) rock.light.intensity = (1 - f) * 16 * LIGHT_SCALE;
      if (f >= 1) {
        rock.ring.visible = false;
        if (rock.light) rock.light.intensity = 0;
        for (var z = 0; z < rock.motes.length; z++) rock.motes[z].mesh.visible = false;
      }
    }

    if (!rock.active || !rock.root) return;
    rock.t += dt;
    var p = Math.min(1, rock.t / rock.dur);
    var eased = p * p;                 // accelerating: it falls, not descends
    var y = rock.from * (1 - eased);
    rock.root.position.set(rock.x, Math.max(0, y), rock.z);

    var spin = cfgA.spin || [1.9, 2.7, -1.4];
    if (rock.inner) {
      rock.inner.rotation.x += spin[0] * dt;
      rock.inner.rotation.y += spin[1] * dt;
      rock.inner.rotation.z += spin[2] * dt;
    }
    if (rock.light) rock.light.intensity = (2 + 10 * eased) * LIGHT_SCALE;

    for (var i = 0; i < rock.motes.length; i++) {
      var mt = rock.motes[i];
      var lag = (p + mt.off) % 1;
      mt.mesh.visible = true;
      mt.mesh.position.set(
        rock.x + Math.cos(mt.ang) * mt.spread * lag,
        Math.max(0.05, y + lag * 2.6),
        rock.z + Math.sin(mt.ang) * mt.spread * lag
      );
      mt.mesh.material.opacity = 0.85 * (1 - lag);
      mt.mesh.scale.setScalar(0.6 + lag * 0.9);
    }

    if (p >= 1 && !rock.landed) {
      rock.landed = true;
      rock.active = false;
      rock.root.visible = false;
      if (rock.ring) {
        rock.ring.position.set(rock.x, 0.06, rock.z);
        rock.ring.visible = true;
        rock.ring.scale.setScalar(0.6);
        rock.ring.material.opacity = 0.9;
      }
      if (rock.light) {
        // park the glow in the crater rather than following the vanished rock
        rock.root.position.set(rock.x, 0.4, rock.z);
        rock.root.visible = false;
        rock.light.intensity = 16 * LIGHT_SCALE;
      }
      rock.impact = 0;
      if (rock.onLand) { var cb = rock.onLand; rock.onLand = null; cb(); }
    }
  }

  function loadTornado() {
    assetExpect('tornado');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.tornado) { assetDone('tornado', 'skipped'); return; }
    loader.load(versioned(models.tornado), function (gltf) {
      try {
        var cfgT = D().tornado || {};
        var root = gltf.scene;
        var box = new THREE.Box3().setFromObject(root);
        var h = Math.max(0.01, box.max.y - box.min.y);
        root.scale.setScalar((cfgT.height || 3.6) / h);
        box.setFromObject(root);
        root.position.y -= box.min.y;          // base on the floor

        root.traverse(function (o) {
          if (o.isMesh) {
            tornado.tubes.push(o);
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              var m = mats[i];
              if (!m) continue;
              m.transparent = true;
              m.depthWrite = false;
              m.blending = THREE.AdditiveBlending;
              m.side = THREE.DoubleSide;
              if (m.emissive) { m.emissive.setHex(0xff6a18); m.emissiveIntensity = 2.2; }
              if (m.color) m.color.setRGB(1.0, 0.55, 0.2);
              m.opacity = 0;
            }
          }
        });
        var wrap = new THREE.Group();
        wrap.add(root);
        wrap.visible = false;
        scene.add(wrap);
        tornado.root = wrap;
        tornado.inner = root;
        tornado.light = new THREE.PointLight(0xff7a20, 0, 12, 1.8);
        tornado.light.position.y = 1.6;
        wrap.add(tornado.light);
      } catch (e) { console.warn('[arena3d] tornado failed', e); }
      assetDone('tornado');
    }, undefined, function () {
      console.warn('[arena3d] firetornado.glb missing');
      assetDone('tornado', 'failed');
    });
  }

  /* Show the cast pose: hand up, rune spinning up off the fingers. */
  A.showSign = function (on) {
    sign.active = !!on;
    if (!on) sign.t = 0;
    if (sign.hand) sign.hand.visible = !!on;
    if (sign.rune) sign.rune.visible = !!on;
  };

  /* Drop the funnel on the knight (or straight ahead if he is gone). */
  A.spawnTornado = function (durationMs) {
    if (!tornado.root) return false;
    var target = nearestKnight();
    var tx = target ? target.group.position.x : pos.x;
    var tz = target ? target.group.position.z : pos.z - 3;
    tornado.root.position.set(tx, 0, tz);
    tornado.root.visible = true;
    tornado.active = true;
    tornado.t = 0;
    tornado.dur = (durationMs || 2400) / 1000;
    return true;
  };

  function updateSignAndTornado(dt) {
    updateAsteroid(dt);
    // hand sign: rune spins and brightens while the cast winds up
    if (sign.active) {
      sign.t += dt;
      if (sign.rune) {
        sign.rune.rotation.z += dt * 3.4;
        var f = Math.min(1, sign.t / 0.5);
        sign.rune.material.opacity = 0.35 + 0.55 * f * (0.75 + 0.25 * Math.sin(elapsed * 18));
        sign.rune.scale.setScalar(0.6 + 0.4 * f);
      }
      if (sign.hand) sign.hand.position.y = (D().handSign || {}).y - 0.02 + Math.sin(elapsed * 9) * 0.012;
    } else if (sign.rune && sign.rune.material.opacity > 0) {
      sign.rune.material.opacity = Math.max(0, sign.rune.material.opacity - dt * 4);
    }

    // tornado: rise, churn, fade
    if (!tornado.active || !tornado.root) return;
    tornado.t += dt;
    var cfgT = D().tornado || {};
    var rise = (cfgT.riseMs || 420) / 1000, fade = (cfgT.fadeMs || 500) / 1000;
    var p = tornado.t;
    var a = (p < rise) ? (p / rise)
          : (p > tornado.dur - fade ? Math.max(0, (tornado.dur - p) / fade) : 1);
    var spin = cfgT.spin || [2.2, -3.1, 4.4];
    for (var i = 0; i < tornado.tubes.length; i++) {
      tornado.tubes[i].rotation.y += (spin[i % spin.length]) * dt;
      var mats = Array.isArray(tornado.tubes[i].material)
        ? tornado.tubes[i].material : [tornado.tubes[i].material];
      for (var m = 0; m < mats.length; m++) {
        if (mats[m]) mats[m].opacity = a * 0.85;
      }
    }
    if (tornado.inner) {
      tornado.inner.scale.y = ((cfgT.height || 3.6) / (cfgT.height || 3.6)) * (0.35 + 0.65 * a);
      tornado.inner.rotation.y += dt * 1.6;
    }
    if (tornado.light) tornado.light.intensity = a * 9 * LIGHT_SCALE;
    // keep chasing the knight so it reads as "on him"
    var chase = nearestKnight();
    if (chase) {
      tornado.root.position.x += (chase.group.position.x - tornado.root.position.x) * Math.min(1, 3 * dt);
      tornado.root.position.z += (chase.group.position.z - tornado.root.position.z) * Math.min(1, 3 * dt);
    }
    if (p >= tornado.dur) {
      tornado.active = false;
      tornado.root.visible = false;
    }
  }

  /* Play an ability's clip once, fitted to its cast length so one clip can
     serve several abilities (§17). */
  A.playAbility = function (abilityId, clipName, speed, durationMs) {
    castingId = abilityId;
    if (!fp.loaded || !fp.mixer) return false;
    var clip = fp.clips[clipName] || fp.clips.Punch;
    if (!clip) return false;
    if (fp.action) fp.action.stop();
    fp.action = fp.mixer.clipAction(clip);
    fp.action.reset();
    fp.action.setLoop(THREE.LoopOnce, 1);
    fp.action.clampWhenFinished = true;
    fp.action.timeScale = (durationMs && clip.duration)
      ? (clip.duration * 1000) / durationMs
      : (speed || 1);
    fp.root.visible = true;
    fp.action.play();
    return true;
  };

  /* Live placement tuning for the first-person rig (test hook): the correct
     offset/rotation is easier to find by looking than by arithmetic. */
  A._fpPlace = function (x, y, z, rotY, scale) {
    if (!fp.root) return null;
    fp.root.position.set(x, y, z);
    fp.root.rotation.y = rotY;
    fp.root.scale.setScalar(scale || 1);
    fp.root.visible = true;
    var box = new THREE.Box3().setFromObject(fp.root);
    return { min: box.min.toArray().map(function (v) { return +v.toFixed(2); }),
             max: box.max.toArray().map(function (v) { return +v.toFixed(2); }) };
  };

  /* Scrub the current clip to an absolute time (test hook): lets automated
     checks sample the whole swing without waiting on real time. */
  A._animSeek = function (seconds) {
    if (!fp.mixer || !fp.action) return null;
    fp.action.paused = false;
    fp.action.time = Math.max(0, seconds);
    fp.mixer.setTime(Math.max(0, seconds));
    fp.mixer.update(0);
    return { time: fp.action.time, duration: fp.action.getClip().duration };
  };

  /* Bone probe (test hook): Box3 on a SkinnedMesh returns un-posed bind
     bounds, so rig fitting has to be measured from the skeleton instead. */
  A._fpBones = function (names) {
    if (!fp.model) return null;
    var want = names || ['Head_M', 'Root_M', 'Ankle_L', 'Wrist_L', 'Wrist_R', 'Chest_M'];
    var out = {};
    fp.model.updateMatrixWorld(true);
    fp.model.traverse(function (o) {
      if (!o.isBone) return;
      for (var i = 0; i < want.length; i++) {
        if (o.name === want[i]) {
          var v = new THREE.Vector3();
          o.getWorldPosition(v);
          out[o.name] = [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
        }
      }
    });
    out._modelScale = fp.model.scale.x;
    out._modelRotX = +fp.model.rotation.x.toFixed(3);
    out._camera = camera ? [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)] : null;
    return out;
  };

  A.stopAbility = function () {
    castingId = null;
    A.showSign(false);
    if (fp.action) { fp.action.stop(); fp.action = null; }
    if (fp.root) fp.root.visible = false;
  };

  /* Is the knight inside this ability's reach and arc right now? */
  /* §20: which knights does this swing catch? Returns their indices, so one
     wide arc can hit several of them at once. */
  A.abilityTargets = function (ability) {
    var out = [];
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // camera forward
    var halfArc = Math.cos(((ability.arc || 60) / 2) * Math.PI / 180);
    for (var i = 0; i < knights.length; i++) {
      var k = knights[i];
      if (!k.alive || !k.group) continue;
      var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > (ability.range || 2.5) || dist < 0.0001) continue;
      if ((dx * fx + dz * fz) / dist >= halfArc) out.push(i);
    }
    /* §22: a swing that catches nobody is the other thing he taunts at. This
       is a query with a side effect, which is not free — but the alternative
       is every caller of a hit test remembering to report the whiff, and the
       whiff is exactly what the engine already knows and the caller does not.
       The roll is brain.tauntChance and only a free knight takes it. */
    if (!out.length) {
      var near = nearestKnight();
      if (near) A.taunt(knights.indexOf(near));
    }
    return out;
  };
  A.abilityHits = function (ability) { return A.abilityTargets(ability).length > 0; };

  /* Dash for the evade: along movement input, or straight back if idle. */
  A.doEvade = function (distance, durationMs) {
    var f = ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0);
    var s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    var sy = Math.sin(yaw), cy = Math.cos(yaw);
    var dx, dz;
    if (f || s) {
      var len = Math.sqrt(f * f + s * s); f /= len; s /= len;
      dx = (-sy * f + cy * s); dz = (-cy * f - sy * s);
    } else {
      var nk = nearestKnight();
      var kx = pos.x - (nk ? nk.group.position.x : 0);
      var kz = pos.z - (nk ? nk.group.position.z : -1);
      var kl = Math.sqrt(kx * kx + kz * kz) || 1;
      dx = kx / kl; dz = kz / kl;
    }
    evadeMove = { dx: dx, dz: dz, t: 0, dur: (durationMs || 260) / 1000,
                  dist: distance || 3.4 };
    return true;
  };

  // ---------------------------------------------------------------- init/API
  A.init = function (canvasEl) {
    if (disabled || inited) return;
    if (!canvasEl) { disableAPI('init without canvas'); disabled = true; return; }
    canvas = canvasEl;
    /* §24: if nobody called setStage first, resolve the default now — but only
       when data/stages.js is actually present. With no stages table stageDef
       stays null, D() returns data/arena3d.js untouched, and this is the
       church exactly as it was before §24. */
    if (!stageId && stagesTable()) {
      stageId = S.forRound(1);
      stageDef = S.get(stageId);
      invalidateCfg();
    }
    cfg = D();
    if (cfg.knight && cfg.knight.bodyRadius) KNIGHT_RADIUS = cfg.knight.bodyRadius;

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) { disableAPI('WebGL unavailable: ' + e.message); disabled = true; return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Same PBR pipeline as the room (§14): without sRGB output the church's
    // sRGB textures render almost black.
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.4;
    }
    if ('physicallyCorrectLights' in renderer) {
      renderer.physicallyCorrectLights = true;
      LIGHT_SCALE = Math.PI;   // punctual/ambient response is divided by ~PI
    }
    if (renderer.shadowMap && THREE.PCFSoftShadowMap !== undefined) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 200);
    camera.rotation.order = 'YXZ';

    /* One shockwave ring up front so the §21 warm-up pass actually draws it.
       Built lazily it would be a new material compiled and uploaded on the
       frame of the first ground_slam, which is the exact hitch §21 exists to
       kill; the pool grows from here if two knights slam at once.
       Before buildStage, and stage-INDEPENDENT: the pool survives every switch
       so the warm-up is paid once, not once per round. */
    makeShock();
    /* §25: and the wave, for the same reason and one more — it is the ability
       you cast while a sword is already coming down, so the frame it first
       appears on is the worst frame in the fight to compile a material. */
    makeWave();
    /* §24: fog, lights, the church-or-Ring geometry and the env probe are all
       one stage build now, so the switch path and the first build are the same
       code. Anything that goes only through init() is a thing that will be
       missing the first time someone changes stage. */
    buildStage();
    loadKnight();
    loadFirstPerson();
    loadHandSign();
    loadTornado();
    loadAsteroid();
    A.reset();

    inited = true;
    A.resize();
    try { renderer.render(scene, camera); } catch (e) { renderFailed = true; }
  };

  A.reset = function () {
    var sp = cfgSpawn();
    pos.x = sp.x; pos.z = sp.z;
    vel.x = 0; vel.z = 0;
    yaw = sp.yaw != null ? sp.yaw : 0;
    pitch = 0; bobPhase = 0;
    crouchForced = false;
    eyeH = eyeStand();
    clearAttack();
    for (var ki = 0; ki < knights.length; ki++) {
      var kk = knights[ki];
      kk.alive = true;
      if (!kk.group) continue;
      kk.group.position.y = 0;
      kk.group.visible = true;
      faceKnightTo(kk, sp.x, sp.z);
      kk.anim.state = 'idle';
      kk.anim.swinging = false;
      kk.anim.swingT = 0;
      kk.anim.dash = 0;
      kk.anim.dashCd = ki * 1.2;
      kk.anim.sched = null;
      kk.anim.feintHold = 0;
      /* §22: everything death touched has to come back too — the blade out of
         his hand, the transparency the fade left on his plate, and the brain
         itself (a knight who reset while staggered would spawn reeling). */
      restoreSword(kk);
      for (var mi = 0; mi < kk.mats.length; mi++) {
        kk.mats[mi].opacity = 1;
        kk.mats[mi].transparent = false;
        kk.mats[mi].depthWrite = true;
      }
      initBrain(kk, ki);
      /* Put every BONE back at rest, or last round's chop comes back with
         him. knightanim.reset also clears the pattern it was mid-way through,
         which the old loop over pivot rotations could not: a knight killed
         inside a thrust_combo used to come back still holding stab two. */
      if (KANIM()) KANIM().reset(kk.rig);
    }
    for (var sh = 0; sh < shocks.length; sh++) shocks[sh].mesh.visible = false;
    if (camera) {
      camera.position.set(pos.x, eyeH, pos.z);
      camera.rotation.set(pitch, yaw, 0);
    }
  };

  function eyeStand() { return (cfg && cfg.eye && cfg.eye.stand) || 1.6; }
  function eyeCrouch() { return (cfg && cfg.eye && cfg.eye.crouch) || 0.85; }
  function isCrouching() {
    return crouchForced || crouchHeld ||
      !!(keys.ControlLeft || keys.ControlRight || keys.KeyC);
  }

  // ---------------------------------------------------------------- input
  var PREVENT = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1 };
  function onKeyDown(e) {
    /* Bail before preventDefault: PREVENT swallows Space, and with a result
       card up that would stop you activating its focused button. */
    if (controlOff) return;
    keys[e.code] = true;
    if (PREVENT[e.code]) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function onBlur() { keys = {}; }
  var lockSuppressed = false;   // §21: a panel is up; do not re-grab the cursor
  function isLocked() { return !!(canvas && document.pointerLockElement === canvas); }
  function onMouseMove(e) {
    // exitPointerLock is async — without controlOff a stray move lands in the
    // gap and drifts the camera behind whatever panel just opened
    if (controlOff || !isLocked()) return;
    yaw -= (e.movementX || 0) * SENS;
    pitch -= (e.movementY || 0) * SENS;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    if (pitch < -PITCH_MAX) pitch = -PITCH_MAX;
  }
  function onClick() {
    if (!running || controlOff || isLocked() || lockSuppressed) return;
    try {
      // modern Chrome returns a promise and REJECTS it inside the exit/enter
      // cooldown — an unhandled rejection is a console error
      var pl = canvas.requestPointerLock();
      if (pl && typeof pl.catch === 'function') pl.catch(function () {});
    } catch (e) {}
  }
  function addListeners() {
    /* §24 asks that a stage switch leave no doubled listeners. start() already
       guards on `running`, but that guard is one early-return away from being
       wrong; make the wiring itself idempotent so a second start() — from a
       stage rebuild, a re-entered round, anything — cannot double-bind WASD.
       `listeners` is emptied by removeListeners(), so a non-empty array means
       exactly one live set. */
    if (listeners.length) return;
    function on(t, type, fn) { t.addEventListener(type, fn); listeners.push([t, type, fn]); }
    on(canvas, 'click', onClick);
    on(document, 'mousemove', onMouseMove);
    on(window, 'keydown', onKeyDown);
    on(window, 'keyup', onKeyUp);
    on(window, 'blur', onBlur);
    on(window, 'resize', A.resize);
  }
  function removeListeners() {
    for (var i = 0; i < listeners.length; i++) {
      listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
    }
    listeners.length = 0;
  }

  // ---------------------------------------------------------------- movement
  /* ---------------------------------------------------------------- navgrid
     §20. The church is not a rectangle. It has an altar platform, steps,
     columns and side chapels, and the old `arena.bounds` box let you stroll
     straight through all of them. So at load we BAKE the real floor: sample a
     grid, keep every cell with floor near y0 and a clear head column, then
     flood-fill from the spawn so unreachable side rooms do not count.
     Movement then resolves per axis against the grid, which slides you along
     stone instead of stopping you dead. */
  var nav = null;   // {cell,minX,minZ,nx,nz,data:Uint8Array}

  /* The model's pews are baked into merged meshes and cannot be split,
     so they stay pure scenery - after §22 nothing in the nave is solid but
     stone. Left in the navgrid they also break it: the rows are thinner
     than the 0.4m grid, so cell centres land half on seat and half on aisle
     and the floor comes out speckled. */
  function isPew(o) {
    var m = o.material;
    if (!m) return false;
    var mats = Array.isArray(m) ? m : [m];
    for (var i = 0; i < mats.length; i++) {
      if (/banc/i.test(mats[i].name || '')) return true;
    }
    return false;
  }

  function buildNavGrid(cell, pad, tol) {
    var solids = [];
    scene.traverse(function (o) {
      if (o.isMesh && o.userData && o.userData.isChurch && !isPew(o)) solids.push(o);
    });
    if (!solids.length) return null;

    cell = cell || 0.4;
    var b = (cfg.arena && cfg.arena.bounds) || { minX: -8, maxX: 8, minZ: -12, maxZ: 12 };
    // sample past the declared box so the bake can find real floor the
    // hand-guessed rectangle was cutting off
    pad = pad == null ? 3.0 : pad;
    var minX = b.minX - pad, maxX = b.maxX + pad;
    var minZ = b.minZ - pad, maxZ = b.maxZ + pad;
    var nx = Math.ceil((maxX - minX) / cell) + 1;
    var nz = Math.ceil((maxZ - minZ) / cell) + 1;
    var data = new Uint8Array(nx * nz);

    var rc = new THREE.Raycaster();
    var dnV = new THREE.Vector3(0, -1, 0), upV = new THREE.Vector3(0, 1, 0);
    var org = new THREE.Vector3();
    /* Tight on purpose: the church is full of pews (`banc`) whose seats sit
       0.45-0.85m up. A loose tolerance accepts those as floor and spawns you
       standing on the furniture. Only true nave floor qualifies. */
    var FLOOR_TOL = tol == null ? 0.28 : tol;
    var HEAD = 1.7;         // standing clearance

    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < nz; j++) {
        var x = minX + i * cell, z = minZ + j * cell;
        org.set(x, 2.6, z);
        rc.set(org, dnV); rc.far = 6;
        var hit = rc.intersectObjects(solids, true);
        if (!hit.length) continue;
        var fy = 2.6 - hit[0].distance;
        if (Math.abs(fy) > FLOOR_TOL) continue;      // altar top, stairs, void
        org.set(x, fy + 0.15, z);
        rc.set(org, upV); rc.far = HEAD;
        if (rc.intersectObjects(solids, true).length) continue;  // no headroom
        data[i * nz + j] = 1;
      }
    }

    var g = { cell: cell, minX: minX, minZ: minZ, nx: nx, nz: nz, data: data };
    floodFill(g, cfg.playerSpawn ? cfg.playerSpawn.x : 0,
                 cfg.playerSpawn ? cfg.playerSpawn.z : 4.2);
    return g;
  }

  /* Keep only the region actually connected to the spawn. */
  function floodFill(g, sx, sz) {
    var si = Math.round((sx - g.minX) / g.cell), sj = Math.round((sz - g.minZ) / g.cell);
    // the spawn can sit a hair off a sample point; search outward for a seed
    var seed = -1;
    for (var r = 0; r < 8 && seed < 0; r++) {
      for (var a = -r; a <= r && seed < 0; a++) {
        for (var b2 = -r; b2 <= r && seed < 0; b2++) {
          var i = si + a, j = sj + b2;
          if (i >= 0 && i < g.nx && j >= 0 && j < g.nz && g.data[i * g.nz + j] === 1) seed = i * g.nz + j;
        }
      }
    }
    if (seed < 0) return;
    var stack = [seed];
    g.data[seed] = 2;
    while (stack.length) {
      var k = stack.pop(), ci = (k / g.nz) | 0, cj = k % g.nz;
      var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var n = 0; n < 4; n++) {
        var ai = ci + nb[n][0], aj = cj + nb[n][1];
        if (ai < 0 || ai >= g.nx || aj < 0 || aj >= g.nz) continue;
        var idx = ai * g.nz + aj;
        if (g.data[idx] === 1) { g.data[idx] = 2; stack.push(idx); }
      }
    }
    // 2 = reachable, 1 = orphaned island -> demote to blocked
    for (var m = 0; m < g.data.length; m++) g.data[m] = (g.data[m] === 2) ? 1 : 0;
  }

  /* Is one grid point open? The rounding IS containment: the grid points are
     the cell centres, so nearest-centre and "which cell am I in" agree. */
  function navPoint(g, x, z) {
    var i = Math.round((x - g.minX) / g.cell);
    var j = Math.round((z - g.minZ) / g.cell);
    if (i < 0 || i >= g.nx || j < 0 || j >= g.nz) return false;
    return !!g.data[i * g.nz + j];
  }

  /* Can a body of `radius` stand centred here? Centre must be open, plus at
     least 3 of the 4 rim points.
     §22, and the reason the nave felt like a corridor: this used to probe
     RADIUS*0.8 for EVERY body and demand all five points, so a single
     blocked rim sample - the far side of a pillar, one speckled cell in a
     doorway, the lip of the altar step - read as a wall. Doorway-width gaps
     came out impassable and a knight who brushed stone could wedge. Measured
     on the shipped grid: all-5 leaves 1319 reachable cells (211 m²),
     centre+3-of-4 leaves 1539 (246.2 m²) of the 1563 the bake found.
     Each body now passes its OWN radius, because the knight is wider than
     the player and must not squeeze through gaps he visibly cannot.
     Watch the resolution: the baked cell is 0.4m, so any radius from ~0.2 to
     ~0.59 samples the IMMEDIATE neighbour cell and the two bodies test the
     same footprint. Past 0.6 the rim rounds two cells out and would skip the
     neighbour entirely - if a body ever needs a radius that big, probe the
     intermediate ring too rather than just raising the number. */
  function navFree(x, z, radius) {
    if (!nav) return true;
    var g = nav, r = (radius == null ? RADIUS : radius);
    if (!navPoint(g, x, z)) return false;
    var open = 0;
    if (navPoint(g, x + r, z)) open++;
    if (navPoint(g, x - r, z)) open++;
    if (navPoint(g, x, z + r)) open++;
    if (navPoint(g, x, z - r)) open++;
    return open >= 3;
  }

  /* Nearest cell a body can actually stand in, searched outward in rings.
     Spawn points in data/ were authored against the old rectangle, so some
     of them sit inside the rood screen; this walks them out to real floor. */
  function navNearest(x, z, radius) {
    if (!nav || navFree(x, z, radius)) return { x: x, z: z };
    var step = nav.cell;
    for (var r = 1; r <= 30; r++) {
      for (var a = -r; a <= r; a++) {
        for (var b = -r; b <= r; b++) {
          if (Math.abs(a) !== r && Math.abs(b) !== r) continue;   // ring only
          var nx2 = x + a * step, nz2 = z + b * step;
          if (navFree(nx2, nz2, radius)) return { x: nx2, z: nz2 };
        }
      }
    }
    return { x: x, z: z };
  }

  /* §22 verification: flood the walkable region that actually contains the
     player spawn and keep the measurement, so "the nave is open" is a number
     in debug() instead of an opinion. Two readings, because they answer
     different questions:
       cells/m2/bbox - the raw baked floor connected to the spawn. This is
         what `arena.bounds` in data was authored from; if it drifts, the
         church or the bake moved and the data box is stale.
       stand{} - the cells a BODY of that radius can legally occupy under
         navFree. Always smaller than the raw region (a body cannot stand in
         a one-cell doorway spur), and it is the number that regresses if
         someone tightens the probe again. */
  var arenaArea = null;

  function floodMeasure(test) {
    var g = nav;
    var sp = cfgSpawn();
    var si = Math.round((sp.x - g.minX) / g.cell), sj = Math.round((sp.z - g.minZ) / g.cell);
    var seed = -1, r, a, b, i, j;
    for (r = 0; r < 8 && seed < 0; r++) {
      for (a = -r; a <= r && seed < 0; a++) {
        for (b = -r; b <= r && seed < 0; b++) {
          i = si + a; j = sj + b;
          if (i >= 0 && i < g.nx && j >= 0 && j < g.nz && test(i, j)) seed = i * g.nz + j;
        }
      }
    }
    if (seed < 0) return null;
    var seen = new Uint8Array(g.nx * g.nz);
    var stack = [seed];
    seen[seed] = 1;
    var cells = 0, minI = g.nx, maxI = -1, minJ = g.nz, maxJ = -1;
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (stack.length) {
      var k = stack.pop(), ci = (k / g.nz) | 0, cj = k % g.nz;
      cells++;
      if (ci < minI) minI = ci;
      if (ci > maxI) maxI = ci;
      if (cj < minJ) minJ = cj;
      if (cj > maxJ) maxJ = cj;
      for (var n = 0; n < 4; n++) {
        var ai = ci + nb[n][0], aj = cj + nb[n][1];
        if (ai < 0 || ai >= g.nx || aj < 0 || aj >= g.nz) continue;
        var idx = ai * g.nz + aj;
        if (seen[idx]) continue;
        if (!test(ai, aj)) continue;
        seen[idx] = 1;
        stack.push(idx);
      }
    }
    return { cells: cells, m2: +(cells * g.cell * g.cell).toFixed(1),
             minX: +(g.minX + minI * g.cell).toFixed(2),
             maxX: +(g.minX + maxI * g.cell).toFixed(2),
             minZ: +(g.minZ + minJ * g.cell).toFixed(2),
             maxZ: +(g.minZ + maxJ * g.cell).toFixed(2) };
  }

  function measureArena() {
    arenaArea = null;
    if (!nav) return null;
    var g = nav;
    function wx(i) { return g.minX + i * g.cell; }
    function wz(j) { return g.minZ + j * g.cell; }
    var raw = floodMeasure(function (i, j) { return !!g.data[i * g.nz + j]; });
    if (!raw) {
      console.warn('[arena3d] player spawn is not on the navgrid — arenaArea unmeasured');
      return null;
    }
    raw.stand = {
      player: floodMeasure(function (i, j) { return navFree(wx(i), wz(j), RADIUS); }),
      knight: floodMeasure(function (i, j) { return navFree(wx(i), wz(j), KNIGHT_RADIUS); })
    };
    arenaArea = raw;
    var ps = raw.stand.player, ks = raw.stand.knight;
    console.info('[arena3d] arenaArea ' + raw.cells + ' cells / ' + raw.m2 + ' m²' +
                 ' x[' + raw.minX + ',' + raw.maxX + '] z[' + raw.minZ + ',' + raw.maxZ + ']' +
                 ' — standable player ' + (ps ? ps.cells + '/' + ps.m2 + ' m²' : 'none') +
                 ', knight ' + (ks ? ks.cells + '/' + ks.m2 + ' m²' : 'none'));
    return arenaArea;
  }


  /* Put the camera back inside the arena, whatever put it outside.
     ONE function because the frame now needs it twice — once after movement,
     once after the knight push — and two copies of a containment rule is how
     a stage ends up contained on one path and not the other.
     `prevX/prevZ` is the position to fall back to: it must be a cell that was
     legal, or the nav branch has nothing to revert to and walks you out with
     navNearest instead.
     The branch order is load-bearing (§24): nav first because the baked stone
     is the real constraint where it exists, then `bounds`, then the radius —
     which is the path the Ring runs on, since its stage entry sets nav null
     and bounds null precisely so this last clause does the work. */
  function containPlayer(prevX, prevZ) {
    var ar = cfg.arena || { cx: 0, cz: 0, radius: 6 };
    if (nav) {
      /* §20: the baked stone is the arena. Resolving one axis at a time
         lets you slide along a wall or the altar instead of sticking. */
      if (!navFree(pos.x, prevZ, RADIUS)) pos.x = prevX;
      if (!navFree(pos.x, pos.z, RADIUS)) pos.z = prevZ;
      if (!navFree(pos.x, pos.z, RADIUS)) {
        /* Both axes blocked. Falling back to where you stood is only a fix
           when THAT was legal — and it often is not: a test hook can teleport
           you anywhere. Then every later frame reverts to the same illegal
           cell and you are wedged for the rest of the fight. §22: walk out to
           real floor instead of freezing. */
        if (navFree(prevX, prevZ, RADIUS)) { pos.x = prevX; pos.z = prevZ; }
        else {
          var pOut = navNearest(pos.x, pos.z, RADIUS);
          pos.x = pOut.x; pos.z = pOut.z;
        }
      }
    } else if (ar.bounds) {
      pos.x = Math.max(ar.bounds.minX + RADIUS, Math.min(ar.bounds.maxX - RADIUS, pos.x));
      pos.z = Math.max(ar.bounds.minZ + RADIUS, Math.min(ar.bounds.maxZ - RADIUS, pos.z));
    } else {
      var dx = pos.x - (ar.cx || 0), dz = pos.z - (ar.cz || 0);
      var d = Math.sqrt(dx * dx + dz * dz);
      var maxR = (ar.radius || 6) - RADIUS;
      if (d > maxR && d > 0) {
        pos.x = (ar.cx || 0) + dx / d * maxR;
        pos.z = (ar.cz || 0) + dz / d * maxR;
      }
    }
  }

  /* The knight's half of the same rule, and — §25 — the ONLY place his
     containment is decided. It was written inline in updateOneKnight until the
     Water Wave arrived: a shove is a second thing that moves him without
     asking the arena, and a containment rule that exists in two copies is a
     stage that is contained on one path and not the other (exactly the bug
     §24 found on the player side). One function, called once per frame, LAST.
     Same branch order as containPlayer for the same reason: baked stone where
     it exists, then the fallback rectangle, then the radius — which is the
     clause the Ring runs on, since its stage entry leaves nav and bounds null.
     `prevX/prevZ` must be the cell he legally occupied at the top of the frame;
     the nav branch reverts to it one axis at a time so he slides along stone
     instead of sticking, and walks him out with navNearest when even that cell
     was illegal. The 0.5/0.4 insets are his body, kept exactly as they were. */
  function containKnight(x, z, prevX, prevZ) {
    var ar = cfg.arena || {};
    if (nav) {
      /* §20: the knight obeys the same baked stone the player does, so it
         cannot walk through the rood screen to reach you — but with his own,
         wider footprint (§22), so he does not thread gaps he plainly fills. */
      if (!navFree(x, prevZ, KNIGHT_RADIUS)) x = prevX;
      if (!navFree(x, z, KNIGHT_RADIUS)) z = prevZ;
      if (!navFree(x, z, KNIGHT_RADIUS)) {
        /* §22: the old triple-revert put him back on (prevX,prevZ)
           unconditionally. When that cell was itself illegal — squad
           separation shoved him into a pillar, the minDist push backed him
           into the altar — he reverted to it forever and stood in the wall for
           the rest of the fight. Revert only to a LEGAL previous cell;
           otherwise walk him out. */
        if (navFree(prevX, prevZ, KNIGHT_RADIUS)) { x = prevX; z = prevZ; }
        else {
          var kOut = navNearest(x, z, KNIGHT_RADIUS);
          x = kOut.x; z = kOut.z;
        }
      }
    } else if (ar.bounds) {
      x = Math.max(ar.bounds.minX + 0.5, Math.min(ar.bounds.maxX - 0.5, x));
      z = Math.max(ar.bounds.minZ + 0.5, Math.min(ar.bounds.maxZ - 0.5, z));
    } else {
      var cxx = x - (ar.cx || 0), czz = z - (ar.cz || 0);
      var rad = Math.sqrt(cxx * cxx + czz * czz);
      var maxR = (ar.radius || 6) - 0.4;
      if (rad > maxR && rad > 0) {
        x = (ar.cx || 0) + cxx / rad * maxR;
        z = (ar.cz || 0) + czz / rad * maxR;
      }
    }
    return { x: x, z: z };
  }

  function updatePlayer(dt) {
    var f = ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0);
    var s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    var turn = ((keys.ArrowLeft || keys.KeyQ) ? 1 : 0) - ((keys.ArrowRight || keys.KeyE) ? 1 : 0);
    yaw += turn * TURN_RATE * dt;

    var crouch = isCrouching();
    // §17: sprinting burns stamina — the combat engine vetoes it when dry
    var wantSprint = !!(keys.ShiftLeft || keys.ShiftRight) && !crouch && (f || s);
    var sprinting = false;
    if (wantSprint) {
      var c3 = CHLOE.engine.combat3;
      sprinting = (c3 && typeof c3.spendSprint === 'function') ? c3.spendSprint(dt) : true;
    }
    var spd = sprinting ? SPRINT : WALK;
    if (crouch) spd *= CROUCH_SPEED;
    var tx = 0, tz = 0;
    if (f || s) {
      var len = Math.sqrt(f * f + s * s); f /= len; s /= len;
      var sy = Math.sin(yaw), cy = Math.cos(yaw);
      tx = (-sy * f + cy * s) * spd;
      tz = (-cy * f - sy * s) * spd;
    }
    var k = Math.min(1, ACCEL_LERP * dt);
    vel.x += (tx - vel.x) * k;
    vel.z += (tz - vel.z) * k;

    // §17 evade dash: overrides normal velocity for its short duration
    if (evadeMove) {
      evadeMove.t += dt;
      var p = Math.min(1, evadeMove.t / evadeMove.dur);
      var speedNow = (evadeMove.dist / evadeMove.dur) * (1 - p * 0.65); // ease out
      vel.x = evadeMove.dx * speedNow;
      vel.z = evadeMove.dz * speedNow;
      if (p >= 1) evadeMove = null;
    }

    // axis-separated AABB resolve vs config colliders (pew banks)
    var cols = (cfg.arena && cfg.arena.colliders) || [];
    var i, c;
    var prevX = pos.x, prevZ = pos.z;
    var nx = pos.x + vel.x * dt;
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      if (nx + RADIUS > c.minX && nx - RADIUS < c.maxX &&
          pos.z + RADIUS > c.minZ && pos.z - RADIUS < c.maxZ) {
        if (vel.x > 0) nx = c.minX - RADIUS;
        else if (vel.x < 0) nx = c.maxX + RADIUS;
      }
    }
    pos.x = nx;
    var nz = pos.z + vel.z * dt;
    for (i = 0; i < cols.length; i++) {
      c = cols[i];
      if (pos.x + RADIUS > c.minX && pos.x - RADIUS < c.maxX &&
          nz + RADIUS > c.minZ && nz - RADIUS < c.maxZ) {
        if (vel.z > 0) nz = c.minZ - RADIUS;
        else if (vel.z < 0) nz = c.maxZ + RADIUS;
      }
    }
    pos.z = nz;

    /* §19: the nave WALLS are the arena. Rectangular bounds matching the
       stone; the old circle is only a fallback for configs without them. */
    var ar = cfg.arena || { cx: 0, cz: 0, radius: 6 };
    containPlayer(prevX, prevZ);

    /* §20: every living knight has personal space, so a squad cannot be
       walked through and cannot all stack on the same tile. */
    var minD = (ar.knightMinDist || 1.3);
    var safeX = pos.x, safeZ = pos.z;   // legal: containPlayer just said so
    var pushed = false;
    for (var pi = 0; pi < knights.length; pi++) {
      var pk = knights[pi];
      if (!pk.alive || !pk.group) continue;
      var kx = pos.x - pk.group.position.x, kz = pos.z - pk.group.position.z;
      var kd = Math.sqrt(kx * kx + kz * kz);
      if (kd < minD && kd > 0) {
        pos.x = pk.group.position.x + kx / kd * minD;
        pos.z = pk.group.position.z + kz / kd * minD;
        pushed = true;
      }
    }
    /* §24: contain AGAIN, because the push above is the one thing in the frame
       that moves you without asking the arena. A knight backed against the
       edge shoves you outward from HIS centre, and he is himself clamped only
       0.05m further in than you are — measured on the Ring, that put the
       player 0.106m past the rim clamp for half a second at a time, standing
       inside the kerb. Re-running it with the pre-push position as the
       fallback is exact: that cell was legal one statement ago, so the nav
       branch has somewhere real to send you and the radius branch simply
       pulls you back onto the circle. Skipped when nothing pushed, so the
       common frame pays nothing. */
    if (pushed) containPlayer(safeX, safeZ);

    // eye height (crouch lerp) + bob
    var targetEye = crouch ? eyeCrouch() : eyeStand();
    eyeH += (targetEye - eyeH) * Math.min(1, 10 * dt);
    var speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    var bob = 0;
    if (speed > 0.15) {
      bobPhase += dt * (6 + speed * 1.7);
      bob = Math.sin(bobPhase) * BOB_AMP * (crouch ? 0.5 : 1) * Math.min(1, speed / WALK);
    }
    camera.position.set(pos.x, eyeH + bob, pos.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  // ---------------------------------------------------------------- attacks
  function clearAttack(k) {
    if (!k) { for (var i = 0; i < knights.length; i++) clearAttack(knights[i]); return; }
    var atk = k.atk;
    /* §22: a pattern can own SEVERAL strike timers now (thrust_combo's three
       windows). Dropping one and leaving the rest armed is how a knight who
       has been killed, or staggered out of his swing, still stabs you twice. */
    for (var ti = 0; ti < atk.timers.length; ti++) window.clearTimeout(atk.timers[ti]);
    atk.timers.length = 0;
    atk.hits = null;
    atk.lunge = 0;
    atk.mode = 'idle'; atk.pattern = null; atk.cb = null;
    /* Release the RIG too. This used to clear model.rotation.x/z - which
       nothing has written since the tilts moved onto the pivots - and leave
       every pivot exactly where the chop had got to, so a knight killed
       mid-swing froze mid-arc and came back next round still holding it. */
    k.anim.swinging = false;
    k.anim.swingT = 0;
    if (k.group) k.group.position.y = 0;
  }

  /* Play one telegraphed attack. cb({hit, pattern}) fires at the strike
     moment (setTimeout — deterministic even when rAF is throttled). */
  /* §22: one pattern can land several hits, and can LIE about when.
     `hits` is the schedule in data (thrust_combo: two jabs then a step-through
     at 1100/1400/1850ms off atk.t0); a `feint` roll stops the wind-up at the
     apex for holdMs and pushes every strike time back by it, which is what
     makes "a feint must never damage during the hold" true BY CONSTRUCTION
     rather than by a guard someone can forget to write.
     Times come back in seconds, on the un-held clock, plus the hold to add. */
  /* §28 A2: `speed` divides every time in the schedule. It is ONE number for
     the whole pattern (see patternSpeed) precisely so a round-scaled swing
     cannot land earlier than it looks — a per-window scalar would let jab two
     arrive on a different clock from the picture of jab two. */
  function hitSchedule(pattern, holdS, speed) {
    var out = [], i, h;
    speed = speed || 1;
    if (pattern.hits && pattern.hits.length) {
      for (i = 0; i < pattern.hits.length; i++) {
        h = pattern.hits[i];
        out.push({ at: (h.atMs != null ? h.atMs : (pattern.telegraphMs || 1500)) / 1000 / speed,
                   power: h.power != null ? h.power : pattern.power,
                   lunge: h.lunge || 0 });
      }
    } else {
      out.push({ at: (pattern.telegraphMs || 1500) / 1000 / speed,
                 power: pattern.power, lunge: 0 });
    }
    for (i = 0; i < out.length; i++) out[i].fireAt = out[i].at + holdS;
    return out;
  }

  /* §28 A: he cannot throw a swing he has not learned. ui/battle3d.js rolls
     out of the ROUND's pool (knighttree.patterns(level())), which is still
     the right pool to roll FROM — it is what the round is worth — but the
     knight handed the result has his own level, and a level-1 knight
     answering with a ground_slam would make the whole spread invisible. The
     downgrade happens HERE, the only place that knows which knight it is.

     TWO RULES, AND BOTH EXIST TO KEEP THE CALLER HONEST. ui/battle3d.js
     closes over the pattern IT rolled: it prints that pattern's evade hint
     and expects that pattern's number of hit windows. So a substitute must

       (1) SHARE THE EVADE. The hint is a promise about which way to move —
           "SIDESTEP!" over an attack that is really a crouch-under slash is
           the telegraph lying, which is the one thing §18 and §22 both refuse
           to do. Downgrading inside an evade family keeps the promise true.
       (2) HAVE NO MORE HIT WINDOWS than the request. thrust_combo is the only
           multi-window pattern; putting it in place of a single-window swing
           would fire the damage callback three times against a caller that
           warned once, i.e. triple damage off one warning. The reverse
           (thrust_combo downgraded to a single stab) is safe: the caller's
           extra warnings expire on their own windowWaitMs, and the player
           takes less, not more.

     No candidate passes both -> the request goes through UNCHANGED, because a
     knight who declines to attack reads as a bug rather than as a weak
     knight. In practice that leaves exactly one gap: ground_slam is the only
     'backoff' pattern, so a knight below level 5 handed one throws it. It can
     only be rolled from round 5 onward (it unlocks at level 5 = round 5), and
     by ~35s of a round-5 fight every temperament has climbed past level 5, so
     the gap is the opening seconds of a late round. Closing it properly means
     rolling the pattern per knight, which is ui/battle3d.js's call to make:
     `kt.patterns(a3d.knightLevels()[who])` after `who` is chosen. */
  function windowsOf(p) { return (p && p.hits && p.hits.length) ? p.hits.length : 1; }
  function patternForKnight(k, pattern) {
    var kt = ktree();
    if (!kt || !pattern || !pattern.id) return pattern;
    var known = kt.patterns(k.level || 1);
    if (known.indexOf(pattern.id) >= 0) return pattern;
    var all = D().patterns || {};
    var want = windowsOf(pattern), best = null;
    for (var i = 0; i < known.length; i++) {
      var p = all[known[i]];
      if (!p || p.evade !== pattern.evade || windowsOf(p) > want) continue;
      if (!best || (p.power || 0) > (best.power || 0)) best = p;
    }
    return best || pattern;
  }

  A.telegraph = function (pattern, cb, index) {
    if (disabled || !inited || !pattern) { if (cb) cb({ hit: false, pattern: pattern }); return; }
    var k = knights[index || 0];
    if (!k || !k.alive) { if (cb) cb({ hit: false, pattern: pattern }); return; }
    /* §22: a reeling knight cannot attack — that is what the punish window IS.
       The miss goes back immediately so ui/battle3d.js retires its warning
       instead of leaving a prompt up for a swing that will never come. */
    var bs = brainOf(k);
    if (bs.staggerT > 0) { if (cb) cb({ hit: false, pattern: pattern, staggered: true }); return; }
    /* §28 A: swap in something he actually knows BEFORE anything reads the
       pattern, so the schedule, the pose and the damage all agree about which
       swing this is. The caller is told which one it got — ui/battle3d.js
       prints the hint off `r.pattern`, and a "SIDESTEP!" over a slash is a
       telegraph that lies. */
    pattern = patternForKnight(k, pattern);
    var atk = k.atk;
    clearAttack(k);
    atk.mode = 'telegraph';
    atk.pattern = pattern;
    atk.cb = cb || null;
    atk.t0 = performance.now();
    bs.atkCd = bs.tune.attackCooldownMs / 1000;
    /* §28 A2: ONE scalar for the whole swing, held back if the full
       round multiplier would take this pattern's wind-up under the
       readability floor. Everything below divides by it — swingDur, the hit
       schedule, recoverDur and the setTimeout that fires the damage — so the
       picture and the damage shorten together or not at all (§21). The
       pattern object itself is never touched: it is shared data, and scaling
       it in place would compound every round. */
    var speed = patternSpeed(pattern);
    /* Arm the pose HERE rather than leaving it to a latch the frame loop
       notices. swingDur is telegraphMs EXACTLY - no 1.25 multiplier - which is
       what puts the visual impact on the damage frame. recoverDur folds in the
       strike window, because that is when strikeNow schedules mode='recover'. */
    var stA = k.anim;
    stA.swinging = true;
    stA.swingT = 0;
    stA.swingDur = (pattern.telegraphMs || 1500) / 1000 / speed;
    stA.recoverDur = ((pattern.recoverMs || 800) / speed + 220) / 1000;
    stA.speed = speed;
    var fe = pattern.feint;
    var holdS = (fe && fe.chance > 0 && Math.random() < fe.chance) ? (fe.holdMs || 0) / 1000 / speed : 0;
    var sched = hitSchedule(pattern, holdS, speed);
    stA.feintHold = holdS;
    stA.sched = [];
    for (var hi = 0; hi < sched.length; hi++) stA.sched.push(sched[hi].at);
    atk.hits = sched;
    /* Each pattern gets its own pose pair, named by its own id. §28 dropped
       the alias layer this used to carry (charge -> 'thrust', crouch ->
       'sweep'): knightanim keys its table on the pattern ids in
       data/arena3d.js directly, so adding a pattern there and a pose pair
       there is now the whole job. The FALLBACK still splits on evade rather
       than defaulting blind, because a crouch-evade attack played as an
       overhead chop is a telegraph that lies about which way to move. */
    var KAt = KANIM();
    stA.swingKind = (KAt && KAt._patterns[pattern.id]) ? pattern.id
                  : (pattern.evade === 'crouch' ? 'slash' : 'overhead');
    if (KAt) KAt.play(k.rig, stA.swingKind);
    // aim locked at windup start: dodge by MOVING after the windup begins
    var kx = k.group ? k.group.position.x : 0;
    var kz = k.group ? k.group.position.z : 0;
    var dx = pos.x - kx, dz = pos.z - kz;
    var d = Math.sqrt(dx * dx + dz * dz) || 1;
    atk.lockDir = { x: dx / d, z: dz / d };
    faceKnightTo(k, pos.x, pos.z);
    atk.lockYaw = k.baseRot;          // the lane is locked, and so is he
    faceKnightTo(k, pos.x, pos.z);

    /* One timer per hit window. They are held in atk.timers so clearAttack can
       disarm ALL of them — a knight killed after the first jab must not land
       the second. */
    for (var si = 0; si < sched.length; si++) {
      (function (idx) {
        atk.timers.push(window.setTimeout(function () { strikeNow(k, idx); },
                                          sched[idx].fireAt * 1000));
      })(si);
    }
  };

  function strikeNow(k, idx) {
    var atk = k.atk;
    if (atk.mode !== 'telegraph' || !atk.hits) return;
    atk.mode = 'strike';
    var pattern = atk.pattern;
    var win = atk.hits[idx] || {};
    var last = (idx >= atk.hits.length - 1);
    // hidden tab: the player physically cannot dodge (rAF frozen) — mercy miss
    var hit = document.hidden ? false : hitTest(k, pattern);
    /* §22 ground_slam: the shockwave you can SEE, thrown from his boots at the
       instant the hit test measures from them. Same frame, same origin — a
       ring that lags the damage is worse than no ring at all. */
    if (pattern && pattern.radius) spawnShock(k, pattern.radius, pattern.recoverMs || 800);
    // the step-through is paid out over the following frames, not teleported
    if (win.lunge) atk.lunge = win.lunge;
    var cb = atk.cb;
    if (last) {
      atk.cb = null;
      if (atk.hits.length > 1 && k.brain) k.brain.comboDone = true;   // §22: back off after a combo
      /* Brief recover, then idle — on the SAME round-speed scalar the
         wind-up used (k.anim.speed), or a round-9 knight would snap through
         a 1.30x wind-up and then stand in a full-length recover the pose
         driver has already finished playing. */
      var rsp = k.anim.speed || 1;
      window.setTimeout(function () {
        if (atk.mode === 'strike') { atk.mode = 'recover'; }
        window.setTimeout(function () { if (atk.mode === 'recover') clearAttack(k); },
          ((pattern && pattern.recoverMs) || 800) / rsp);
      }, 220);
    } else {
      /* Back to winding for the next stab, and the lane is re-taken from where
         you are NOW: a combo you can dodge by stepping aside once is one
         attack with three animations, not a combo. Each stab keeps §18's
         rule — facing locked for the window it belongs to. */
      atk.mode = 'telegraph';
      var kx2 = k.group ? k.group.position.x : 0, kz2 = k.group ? k.group.position.z : 0;
      var ldx = pos.x - kx2, ldz = pos.z - kz2;
      var ld = Math.sqrt(ldx * ldx + ldz * ldz) || 1;
      atk.lockDir = { x: ldx / ld, z: ldz / ld };
      faceKnightTo(k, pos.x, pos.z);
      atk.lockYaw = k.baseRot;
    }
    if (cb) {
      /* §28 A: WHICH knight this blow belongs to, for the length of the
         callback and not one frame longer. engine/combat3.js prices the
         damage off the striker's own levelled `atk`, and ui/battle3d.js —
         which is where the call comes from — does not forward an index. It
         is cleared in `finally` rather than left standing, so a caller who
         defers its takeHit() reads -1 and prices off the round baseline
         instead of silently billing the wrong knight. A stale striker would
         be invisible and permanently wrong; an absent one is merely
         approximate, and says so. */
      strikerIndex = knights.indexOf(k);
      try {
        cb({ hit: hit, pattern: pattern, window: idx, windows: atk.hits.length,
             power: win.power, feint: !!k.anim.feintHold, index: strikerIndex,
             level: k.level || 1 });
      } catch (e) { console.warn('[arena3d] telegraph cb failed', e); }
      finally { strikerIndex = -1; }
    }
  }
  /* -1 whenever no strike callback is on the stack. See the note above. */
  var strikerIndex = -1;
  A.striker = function () { return strikerIndex; };

  function hitTest(k, pattern) {
    if (!pattern || !k.group) return false;
    var atk = k.atk;
    var kx = k.group.position.x, kz = k.group.position.z;
    var dx = pos.x - kx, dz = pos.z - kz;
    var dist = Math.sqrt(dx * dx + dz * dz);
    /* §22 ground_slam: a RADIAL shockwave off his boots. Facing does not save
       you and neither does crouching — only distance does, measured from his
       FEET at the strike frame, which is why its evade is 'backoff'. It is the
       first pattern that punishes living inside his guard. */
    if (pattern.radius) return dist <= pattern.radius;
    if (pattern.evade === 'crouch') {
      // horizontal arc at chest height: duck under it or be out of reach
      return dist <= (pattern.reach || 3.4) && !isCrouching();
    }
    // strip along the locked aim direction (overhead / charge)
    var fwd = dx * atk.lockDir.x + dz * atk.lockDir.z;
    var lat = dx * -atk.lockDir.z + dz * atk.lockDir.x;
    return fwd >= 0 && fwd <= (pattern.length || 4.4) &&
           Math.abs(lat) <= (pattern.width || 1.7) / 2;
  }

  A.flinch = function (dmg, killed, index) {
    var k = knights[index || 0];
    if (!k || !k.group) return;
    var b = brainOf(k), t = b.tune;
    dmg = dmg || 0;
    if (killed) {
      k.alive = false;
      b.deathT = 0;
      b.state = 'death';
      b.staggerT = 0;
      b.stunT = 0;              // §23: dying outranks being stunned
      /* §25: and outranks being thrown. updateOneKnight hands a dead knight
         to updateDeath before the timers run, so a shove left armed here
         would never tick down — isShoved() would keep answering true over a
         corpse and debug() would show a flight that never lands. */
      b.shoveT = 0; b.shoveLeft = 0;
      k.staggerMeter = 0;
      clearAttack(k);
      k.anim.state = 'death';
    } else if (dmg > 0) {
      /* §22 the punish window the fight has never had. One heavy hit staggers
         outright; otherwise damage banks into a meter that bleeds staggerDecay
         a second, so chip damage never accumulates into a free stun and a
         charged move always buys you one. */
      b.hitFlash = t.hitFlashMs / 1000;
      k.staggerMeter += dmg;
      if (dmg >= t.staggerDamage || k.staggerMeter >= t.staggerBuildup) {
        k.staggerMeter = 0;
        /* max, not assignment: §23 stuns run off the same timer and are
           LONGER than his own staggerMs, so a plain write meant the asteroid's
           own damage-stagger cut its 1.5s stun down to 1.2s the instant it
           landed. A stagger may extend a reel, never shorten one. */
        b.staggerT = Math.max(b.staggerT, t.staggerMs / 1000);
        clearAttack(k);        // a reeling knight drops the swing he was winding
      }
    }
    // quick emissive flash
    for (var i = 0; i < k.mats.length; i++) {
      var m = k.mats[i];
      if (m.emissive) { m.emissive.setHex(killed ? 0xe5173f : 0x881122); m.emissiveIntensity = 1.6; }
    }
    window.setTimeout(function () {
      for (var j = 0; j < k.mats.length; j++) {
        var mm = k.mats[j];
        if (mm.emissive) { mm.emissive.setHex(0x000000); mm.emissiveIntensity = 1.0; }
      }
    }, killed ? 900 : 180);
  };

  /* §22: what a hit is worth right now. The damage sum lives in combat3, not
     here, so the engine can only publish the multiplier its own state implies
     — ui/battle3d.js passes it into C3.hitEnemy as the hit's mult. */
  A.staggerMult = function (index) {
    var k = knights[index || 0];
    if (!k || !k.brain || k.brain.staggerT <= 0) return 1;
    return k.brain.tune.staggerTakeMult;
  };
  A.isStaggered = function (index) {
    var k = knights[index || 0];
    return !!(k && k.brain && k.brain.staggerT > 0);
  };

  /* §23: the asteroid's impact stun. This is NOT a new status — it drives the
     §22 `stagger` state, so the reeling pose, "cannot attack, cannot turn" and
     the staggerTakeMult damage bonus are the ones he already has, and the HUD
     gets a punish window it already knows how to read.

     Deliberately separate from `flinch`, which is where a stagger is EARNED
     (one heavy hit, or a full buildup meter). This one is granted outright by
     an ability, so it must leave `staggerMeter` completely alone: banking the
     stun into the meter would hand the very next chip hit a free second
     stagger, and quietly break "chip damage never accumulates into a stun".

     REFRESH, never stack. Two rocks landing a beat apart would otherwise add
     up to three seconds of a knight standing still, which stops being a punish
     window and becomes a delete button. Taking the max also means a stun can
     never SHORTEN a longer reel already in progress.

     No-op on a dead or absent knight — index 5 of a squad of two is a normal
     call while the crater is being resolved, not a bug. */
  A.stun = function (index, seconds) {
    var k = knights[index == null ? 0 : index];
    if (!k || !k.alive || !k.group) return false;
    var s = Math.max(0, +seconds || 0);
    if (!s) return false;
    var b = brainOf(k);
    b.staggerT = Math.max(b.staggerT, s);
    /* The stun-granted portion, tracked alongside so the HUD can float
       "STUNNED" where a damage stagger reads "STAGGERED!" — same clock, two
       labels. updateKnight bleeds both together. */
    b.stunT = Math.max(b.stunT || 0, s);
    /* He drops the swing he was winding, mid-arc. Note this does NOT call the
       pending telegraph callback: it matches the flinch-stagger path exactly,
       where ui/battle3d.js retires its own prompt. Deviating here would double
       up the swing scheduler. */
    clearAttack(k);
    return true;
  };
  /* Stunned is a strict subset of staggered — check isStaggered for "is he
     open?", this for "was it the rock?". */
  A.isStunned = function (index) {
    var k = knights[index == null ? 0 : index];
    return !!(k && k.brain && (k.brain.stunT || 0) > 0);
  };

  /* §25 the Water Wave's displacement: throw ONE knight `distance` metres
     along (dirX, dirZ), paid out over `ms`, and answer whether he actually
     went anywhere. The caller decides the direction — the wave parts a line by
     throwing each knight toward the side he is already nearest, and only the
     caster's facing knows which side that is — so this end takes a vector and
     asks no questions about why.

     WHAT IT IS NOT, and this is the whole difference from A.stun above: it
     does not touch staggerT, stunT or the staggerMeter. §23's rock is the
     control tool; the wave is a mobility tool that happens to move him. He
     loses his footing, his wind-up dies with it, and he comes back — if being
     thrown also stunned, the cheapest ability in the kit would be the best
     lockdown in it and the asteroid would have no job.

     NEVER A TELEPORT. The metres are owed, not applied: the frame loop spends
     them at distance/ms and every one of them goes through containKnight with
     his own gait, so stone stops him, the rood screen stops him and the Ring's
     rim stops him — clamped and stopped SHORT, still inside the world. That is
     also why this function cannot promise the full distance and only reports
     whether he moved at all; debug().knightBrain[i].shoveMoved is where the
     metres he really covered are published.

     A fresh wave REPLACES an in-flight one rather than adding to it: two
     overlapping shoves that summed would throw him twice as far as either
     ability declares, and distance is the number data is balanced on. */
  A.shove = function (index, dirX, dirZ, distance, ms) {
    var k = knights[index == null ? 0 : index];
    /* Dead or absent is a normal call, not a bug: the wave resolves against a
       cone that was picked a frame earlier and a knight can die inside it. */
    if (!k || !k.alive || !k.group) return false;
    var len = Math.sqrt((+dirX || 0) * (+dirX || 0) + (+dirZ || 0) * (+dirZ || 0));
    if (!isFinite(len) || len < 1e-6) return false;      // no direction, no throw
    var dist = +distance || 0;
    if (!(dist > 0)) return false;
    /* A missing or zero duration is the one input that would turn this into
       the teleport it must never be, so it is clamped to a real flight time
       rather than honoured. */
    var dur = ((+ms > 0) ? +ms : 300) / 1000;
    var ux = (+dirX || 0) / len, uz = (+dirZ || 0) / len;

    /* Would he move AT ALL? Ask the arena, with the same function the frame
       uses, for the first frame's worth of travel — a knight already flat
       against a pillar on the side the wave throws him has not been thrown,
       and the caller (which floats the hit numbers) needs to know that without
       waiting 300ms to find out. Probed at 60Hz because that is the step the
       payout will really take; a full-distance probe would report "blocked"
       for a knight who in fact slides most of the way along the wall. */
    var probe = Math.min(dist, (dist / dur) / 60);
    var to = containKnight(k.group.position.x + ux * probe,
                           k.group.position.z + uz * probe,
                           k.group.position.x, k.group.position.z);
    var gx = to.x - k.group.position.x, gz = to.z - k.group.position.z;
    if ((gx * gx + gz * gz) < 1e-8) return false;

    var b = brainOf(k);
    b.shoveX = ux; b.shoveZ = uz;
    b.shoveDist = dist;
    b.shoveLeft = dist;
    b.shoveDur = dur;
    b.shoveT = dur;
    b.shoveMoved = 0;
    /* He drops the swing he was winding (§25 breaksWindup), exactly as the
       stun does and by the same route, so a feint held at the apex dies with
       every strike timer it had armed. */
    clearAttack(k);
    /* A COMMITTED lunge has to be taken off him by hand: coil and dash are the
       two states the cascade refuses to interrupt, so a knight thrown mid-coil
       would otherwise stand planted through the whole flight and then launch
       from wherever the water left him — a dash aimed at where you WERE, from
       a place he never chose. Put the lunge back on cooldown and let him
       re-decide: being thrown out of a charge should cost him the charge. */
    if (b.state === 'coil' || b.state === 'dash') {
      k.anim.dash = 0;
      k.anim.dashCd = Math.max(k.anim.dashCd, b.tune.dashCooldownMs / 1000);
      restate(k, b, 'stalk');
    }
    return true;
  };

  /* Is he in the air right now? Same shape as isStaggered/isStunned, and the
     HUD's answer to "why is he not swinging". */
  A.isShoved = function (index) {
    var k = knights[index == null ? 0 : index];
    return !!(k && k.brain && k.brain.shoveT > 0);
  };

  /* §22: roll a taunt. Called on a kill from ui/battle3d.js, and internally
     whenever a player ability catches nobody. He only gloats if he is
     otherwise free — a taunt that interrupts his own wind-up is a bug. */
  A.taunt = function (index) {
    var k = knights[index == null ? 0 : index];
    if (!k || !k.alive || !k.group) return false;
    var b = brainOf(k);
    if (b.staggerT > 0 || k.anim.swinging || b.state === 'coil' || b.state === 'dash') return false;
    if (Math.random() >= b.tune.tauntChance) return false;
    setState(k, b, 'taunt');
    return true;
  };

  A.setKnightAlive = function (alive, index) {
    var k = knights[index || 0];
    if (!k) return;
    k.alive = !!alive;
    if (k.group) k.group.visible = !!alive;
  };

  // ---------------------------------------------------------------- animate
  /* ------------------------------------------------- §21 animation kit

     Frame-rate-correct exponential approach. `Math.min(1, rate*dt)` is the
     Euler approximation of this and it errs in the direction that hurts: it
     over-closes by 12% at 60fps, 25% at 30fps and 39% at the 0.05s dt clamp,
     so the knight got SNAPPIER the worse your machine ran. */
  function alpha(rate, dt) { return 1 - Math.exp(-rate * dt); }
  /* `blend` and `lerpN` went with §28's pose rewrite: their only callers were
     the per-channel eases inside the old poseKnight, and knightanim slerps
     bone quaternions instead. `alpha` stays — the sword drop, the light and
     the yaw all still ease on it. */
  function seg(t, a, b) { return t <= a ? 0 : (t >= b ? 1 : (t - a) / (b - a)); }
  function easeIn(u) { return u * u * u; }                      // into the hit
  function easeOut(u) { var v = 1 - u; return 1 - v * v * v; }  // into the apex

  /* WHERE THE WIND-UP ENDS AND THE STRIKE BEGINS, as a fraction of the hit
     window. This survived §28's move of the pose library into knightanim.js
     because it is not a look, it is a CONTRACT between three things that must
     agree: the feint freezes here (swingClock), the telegraph pose is
     stretched over 0..this and the strike pose over this..1 (poseKnight), and
     the impact frame stays pinned to 1.0 either way. §21's envelope used to
     own it; knightanim now eases the strike in on a quartic, which keeps the
     same readable near-still apex through the first half of the window.
     Move this and all three move together — that is the point of one name. */
  var SWING_APEX_P = 0.78;

  /* ---- §22 multi-window swings and feints -------------------------------
     A pattern's `hits` schedule is stored on the anim as `sched`, in seconds
     off atk.t0 on the UN-HELD clock. The pose walks it one window at a time,
     so each stab replays the whole envelope inside its own slice and IMPACT
     STAYS p = 1.0 PER WINDOW — the §21 guarantee, generalised. A single-hit
     pattern has sched = [swingDur] and reduces exactly to the old maths.

     A feint freezes the clock at the apex for feintHold, then lets it run on.
     The strike timers were pushed back by the same hold, so the blade cannot
     land during the pause by construction — no guard to forget. */
  function swingEnd(st) {
    return (st.sched && st.sched.length) ? st.sched[st.sched.length - 1]
                                         : Math.max(0.05, st.swingDur);
  }
  function swingTotal(st) {
    return swingEnd(st) * 1.06 + st.recoverDur + (st.feintHold || 0);
  }
  // the swing clock with the feint's apex pause taken back out of it
  function swingClock(st) {
    var t = st.swingT;
    if (!st.feintHold) return t;
    var apex = Math.max(0.05, st.swingDur) * SWING_APEX_P;
    if (t <= apex) return t;
    return (t < apex + st.feintHold) ? apex : t - st.feintHold;
  }
  /* When the CURRENT hit window opened, on the same un-held clock. Only
     thrust_combo has more than one, and it is the reason this exists: see the
     `take` ramp in poseKnight. A single-window pattern always answers 0, so
     nothing else in the file changes behaviour. */
  function windowStart(st) {
    var s = st.sched;
    if (!s || s.length < 2) return 0;
    var t = swingClock(st), prev = 0;
    for (var i = 0; i < s.length; i++) {
      if (t <= s[i]) return prev;
      prev = s[i];
    }
    return prev;
  }
  // phase INSIDE the current hit window: 1.0 is its impact frame
  function swingLocalP(st) {
    var t = swingClock(st);
    var s = st.sched;
    if (!s || !s.length) return t / Math.max(0.05, st.swingDur);
    var prev = 0;
    for (var i = 0; i < s.length; i++) {
      if (t <= s[i] || i === s.length - 1) return (t - prev) / Math.max(0.05, s[i] - prev);
      prev = s[i];
    }
    return 1;
  }

  /* §28 C: THE POSE LIBRARY LIVES IN engine/knightanim.js NOW.
     What used to sit here was a second animation system: a `SWINGS` table of
     per-channel amplitudes (aX/aY/aZ/eX/lX/tX/tY/hX/hY/gL/gR/bY), a `GUARD`
     row, and a 220-line `poseKnight` that rebuilt eleven scalars every frame
     and eased them onto six sibling pivot Groups. It is gone, all of it —
     §28 B is explicit that two rigs must not end up fighting over the same
     103 meshes, and a channel table is a rig.

     What is left in this file is the part arena3d actually owns: WHICH state
     the knight is in and HOW FAR THROUGH it he is. knightanim owns what that
     looks like. The split matters because of the §21 one-clock rule — the
     phase handed over below is measured off `st.swingT`, which is the same
     `atk.t0` stamp the strike timer counts from, so the picture cannot drift
     from the damage. There is no second timer anywhere in this function:
     `swingClock`, `swingLocalP` and `swingEnd` above are the same three
     helpers the hit test and the light pulse read.

     Mapping from §22's states to the library, so the six survive the move:
       walk/dash    -> walk (amp + lean, dash is the same cycle run harder)
       strafe       -> strafe (dir from the brain's held circling sign)
       backpedal    -> backpedal            turnInPlace -> turnInPlace (dir from yaw error)
       coil         -> coil (the dash tell)  taunt      -> taunt
       press        -> press (the weight shift, on pressSwayMs)
       stagger      -> stagger, f = the punish window's own remaining fraction
       death        -> die(), t = progress through brain.deathMs
     plus the hit flinch, laid OVER whatever he was doing rather than
     replacing it, so a blow never cancels a swing already in flight. */
  var GAIT = { walk: { amp: 1, lean: 8, rate: 7 }, dash: { amp: 1.5, lean: 19, rate: 13 } };
  function KANIM() { return CHLOE.engine.knightanim; }

  /* Which hit window the swing clock is inside. thrust_combo's third stab is
     the one that steps through, and the pose has to lean into that one only —
     `sched` is already the schedule, so this is a read, not a second clock. */
  function swingWindow(st) {
    var s = st.sched;
    if (!s || !s.length) return 0;
    var t = swingClock(st);
    for (var i = 0; i < s.length; i++) if (t <= s[i]) return i;
    return s.length - 1;
  }

  function poseKnight(k, dt) {
    var rig = k.rig;
    var KA = KANIM();
    if (!rig || !KA) return;          // unrigged fallback totem: he stands there
    var st = k.anim, b = k.brain, atk = k.atk;
    /* One options object per knight, reused. A round-6 squad at 60fps would
       otherwise allocate 360 of these a second for no reason. */
    var o = k.poseOpt || (k.poseOpt = {});
    o.dt = dt; o.take = 0; o.cycle = elapsed + st.phase;
    o.dir = 1; o.amp = 1; o.lean = 0; o.f = 1; o.lunge = 0;

    if (st.state === 'death' && b) {
      KA.die(rig, b.deathT / Math.max(0.1, b.tune.deathMs / 1000), o);
    } else if (st.state === 'stagger' && b) {
      /* Amplitude decays with the timer that OWNS the punish window, so the
         recoil eases out instead of releasing him in one frame. Clamped at 1
         because §23's stun sets staggerT from the ability (1.5s) and may
         legitimately exceed his own staggerMs (1.2s). */
      o.f = Math.max(0, Math.min(1, b.staggerT / Math.max(0.1, b.tune.staggerMs / 1000)));
      KA.pose(rig, 'stagger', o);
    } else if (st.swinging) {
      /* A swing curve is already shaped on a wall clock; running it through a
         ~70ms first-order lag is what smeared §21's impact frame across a
         fifth of the wind-up. `take` is a FLOOR on the blend that makes the
         driver take the curve straight — ramped in over the first 100ms so a
         knight caught mid-stride does not pop.

         THE RAMP RESTARTS ON EVERY HIT WINDOW, not once per attack. It used
         to run off `st.swingT`, which is the clock for the WHOLE swing, so by
         the second stab of a thrust_combo it was pinned at 1 — and each new
         window opens on its own telegraph at lp 0, whose target is very near
         idle. Taken straight, that retracts the blade from full extension to
         a guard in a single frame. Measured: the sword TIP moved 2.35m
         between two consecutive frames, twice per combo, against a 0.31m
         worst case anywhere else in the pose library. Ramping from the
         window's own start gives the retraction the joint rates (~55ms) and
         cannot touch the impact frame, which is 200ms+ later at lp 1.0. */
      o.take = Math.min(1, (swingClock(st) - windowStart(st)) / 0.10);
      var clk = swingClock(st);
      var swEnd = swingEnd(st);
      var apexT = Math.max(0.05, st.swingDur) * SWING_APEX_P;
      var lp = swingLocalP(st);
      if (clk >= swEnd) {
        /* recoverMs finally drives something (§21): he settles into the guard
           over the pattern's own recover window. Measured off the LAST hit,
           not the first, or a combo starts sheathing between its own stabs. */
        KA.phase(rig, 'recover', (clk - swEnd) / Math.max(0.05, st.recoverDur), o);
      } else if (st.feintHold > 0 && st.swingT > apexT && st.swingT < apexT + st.feintHold) {
        /* THE FEINT. swingClock has already frozen, so this branch only picks
           the pose that says "held": alive, but not advancing. The strike
           timers were pushed back by the same hold, which is what makes "a
           feint must never damage during the hold" true by construction. */
        KA.phase(rig, 'hold', 1, o);
      } else if (lp <= SWING_APEX_P) {
        KA.phase(rig, 'telegraph', lp / SWING_APEX_P, o);
      } else {
        /* The last 22% of the window is the strike, and knightanim eases it in
           on a quartic, so the apex is still nearly still at p 0.88 and the
           whole arc is spent in the final frames. IMPACT IS lp = 1.0 BY
           CONSTRUCTION — that is what swingLocalP means. */
        var win = atk.hits ? atk.hits[swingWindow(st)] : null;
        /* Hand over the LEAN, never the metre count: `atk.lunge` pays the real
           displacement onto k.group where the navgrid can stop him, and a root
           that also walked the full 1.6m would be a step no stone could
           block. Capped, because the lean is a body attitude, not travel. */
        o.lunge = (win && win.lunge) ? Math.min(0.28, win.lunge * 0.18) : 0;
        KA.phase(rig, 'strike', (lp - SWING_APEX_P) / (1 - SWING_APEX_P), o);
      }
    } else if (st.state === 'walk' || st.state === 'dash') {
      /* §22 capped the boot swing at 0.28rad because the "legs" are boots and
         the dress hem above them never moved, so a real stride swung bare
         boots out from under a static skirt. `hips` carries the hem now, and
         knightanim's walk opens back up to 30deg (45 at a dash). */
      var g = GAIT[st.state];
      st.stride += dt * g.rate;
      o.cycle = st.stride; o.amp = g.amp; o.lean = g.lean;
      KA.pose(rig, 'walk', o);
    } else if (st.state === 'strafe') {
      st.stride += dt * 6;
      o.cycle = st.stride;
      o.dir = b ? b.strafeSign : 1;
      KA.pose(rig, 'strafe', o);
    } else if (st.state === 'backpedal') {
      st.stride += dt * 5;
      o.cycle = st.stride;
      KA.pose(rig, 'backpedal', o);
    } else if (st.state === 'turnInPlace') {
      o.dir = (st.turnErr > 0) ? 1 : -1;
      KA.pose(rig, 'turnInPlace', o);
    } else if (st.state === 'coil' || st.state === 'taunt') {
      KA.pose(rig, st.state, o);
    } else if (b && b.state === 'press') {
      // waiting is not standing still: the weight shift runs on pressSwayMs
      o.cycle = b.t * Math.PI * 2 / Math.max(0.1, b.tune.pressSwayMs / 1000);
      KA.pose(rig, 'press', o);
    } else {
      KA.pose(rig, 'idle', o);
    }

    /* §22 HIT FLASH: every damaging blow reads, stagger or not. Squared so it
       is sharp on the impact frame and gone fast, and additive so it never
       eats a swing in flight. */
    if (b && b.hitFlash > 0 && st.state !== 'stagger' && st.state !== 'death') {
      var hf = b.hitFlash / Math.max(0.02, b.tune.hitFlashMs / 1000);
      KA.flinch(rig, hf * hf);
    }
    /* Last, always: advances the rig's own clock and holds the breathing idle
       for anything that did not drive it this frame. */
    KA.update(rig, dt);
  }

  /* ------------------------------------------------------- §22 the brain

     §18's knight walked a straight line at you and dashed when the line got
     long, which reads as a homing missile rather than a fighter — and a squad
     of them read as ONE organism wearing N bodies. The state machine that
     replaces it:

       stalk       out of range: closes, but on an ARC, not down a rail
       press       in range and ready: holds keepDistance, waits, sways
       strafe      circles at the current range, reversing when stone stops him
       reposition  backs off after a combo, when crowded, or when hugged
       coil        the dash TELL — planted, winding up, readable
       dash        the committed lunge, aimed where you were when he launched
       attack      a telegraph is in flight (ui/battle3d.js still owns cadence)
       recover     the post-swing window: rooted, and slow to turn
       stagger     reeling: cannot attack, cannot turn, takes extra damage

     EVERY number comes from data/arena3d.js `knight.brain`. The table below is
     the floor under a stripped or half-written data file — the engine must
     degrade, not NaN its way across the nave — and it doubles as the complete
     list of keys a personality may override, because a personality is a
     SHALLOW merge (which is why the data keys are flat). */
  var BRAIN_DEFAULTS = {
    walkSpeed: 1.6, strafeSpeed: 1.35, backpedalSpeed: 1.1, dashSpeed: 9.5,
    turnRate: 3.4, recoverTurnRate: 1.1,
    keepDistance: 2.0, dashRange: 5.0, repositionDist: 4.5,
    tooCloseDist: 1.4, crowdDist: 1.8,
    arcHoldMs: 1400, arcBias: 0.55, strafeHoldMs: 1100, repositionMs: 900,
    dashTellMs: 380, dashCooldownMs: 6000, attackCooldownMs: 900,
    pressSwayMs: 800, turnThreshold: 0.7, tauntChance: 0.22,
    deathMs: 1600, hitFlashMs: 160,
    pressWeight: 4, strafeWeight: 2, repositionWeight: 1, stalkWeight: 2,
    staggerDamage: 90, staggerBuildup: 210, staggerDecay: 55,
    staggerMs: 1200, staggerTakeMult: 1.5
  };
  function brainCfg() { return (D().knight && D().knight.brain) || {}; }
  function ktree() { return CHLOE.engine.knighttree || null; }
  function roundNow() { var kt = ktree(); return kt && kt.round ? kt.round() : 1; }

  /* §28 A2: the round's contribution to difficulty, now that levels start at
     1. One scalar, read from data, capped there, and applied in exactly two
     places — the movement speeds below and the swing schedule in telegraph().
     Rounds before `fromRound` get a hard 1, so nothing about the early game
     moves at all. */
  var SPEED_DEFAULT = { fromRound: 5, perRound: 0.06, max: 1.35, telegraphFloorMs: 900 };
  function speedCfg() {
    var src = brainCfg().roundSpeed || {}, out = {}, k;
    for (k in SPEED_DEFAULT) out[k] = (typeof src[k] === 'number') ? src[k] : SPEED_DEFAULT[k];
    return out;
  }
  function roundSpeed(r) {
    var c = speedCfg();
    r = (r == null) ? roundNow() : r;
    if (r < c.fromRound) return 1;
    var m = 1 + (r - (c.fromRound - 1)) * c.perRound;
    return m > c.max ? c.max : m;
  }
  /* The same scalar, reduced for ONE pattern if the full multiplier would
     push its wind-up under the readability floor. Returning a per-pattern
     number rather than clamping telegraphMs alone is what keeps §21's one
     clock: the whole schedule — telegraph, every hit time, the recover — is
     divided by this single value, so the picture and the damage shorten by
     exactly the same factor or neither does. */
  function patternSpeed(pattern, r) {
    var m = roundSpeed(r);
    if (m <= 1) return 1;
    var floor = speedCfg().telegraphFloorMs;
    var tel = (pattern && pattern.telegraphMs) || 1500;
    if (tel / m < floor) m = tel / floor;
    return m < 1 ? 1 : m;
  }

  /* Resolve one knight's tuning ONCE, at spawn. A per-frame merge of two
     objects for every knight in a round-6 squad is pure garbage collection.
     The round-speed multiplier is baked in HERE for the same reason — and
     because a squad spawns once per round, so the round it was spawned for is
     the round it fights in. */
  var SPED_KEYS = ['walkSpeed', 'strafeSpeed', 'backpedalSpeed', 'dashSpeed'];
  function buildTune(personality) {
    var src = brainCfg(), t = {}, key;
    for (key in BRAIN_DEFAULTS) t[key] = BRAIN_DEFAULTS[key];
    for (key in src) if (typeof src[key] === 'number') t[key] = src[key];
    var p = (src.personalities || {})[personality];
    for (key in p) if (typeof p[key] === 'number') t[key] = p[key];
    var sp = roundSpeed();
    if (sp > 1) for (var i = 0; i < SPED_KEYS.length; i++) t[SPED_KEYS[i]] *= sp;
    t.roundSpeed = sp;
    return t;
  }

  /* Personalities are DEALT, not rolled: round-robin from a random start, so a
     squad of three is three different fighters instead of three coin flips
     that can all land the same way. */
  var personaSeed = Math.floor(Math.random() * 997);
  function personaFor(i) {
    var ps = brainCfg().personalities, names = [], n;
    for (n in ps) names.push(n);
    if (!names.length) return '';
    return names[(personaSeed + Math.max(0, i)) % names.length];
  }

  function initBrain(k, i) {
    var name = personaFor(i);
    k.brain = {
      state: 'stalk', prev: '', personality: name, tune: buildTune(name),
      t: 0, hold: 0, entered: 0,
      /* Neighbours arc opposite ways, so a line of them folds around you
         instead of converging on one point. */
      arcSign: (i % 2) ? 1 : -1, arcT: 0,
      /* strafeFlips: how many times stone has reversed THIS circle. The
         reversal buys a fresh hold, and without a budget a knight wedged
         between two walls buys one every other frame and never re-decides. */
      strafeSign: (Math.random() < 0.5) ? 1 : -1, strafeFlips: 0,
      /* stunT: the §23 slice of staggerT that came from an ability rather than
         from damage. Never longer than staggerT — it only labels it. */
      atkCd: 0, repCd: 0, staggerT: 0, stunT: 0, hitFlash: 0, deathT: 0,
      /* §25 Water Wave. shoveT is the flight clock, shoveLeft the metres still
         owed on it and shoveMoved the metres he ACTUALLY covered once the
         arena had its say — the three of them are what debug() publishes, so
         "the wave threw him 3.2m" and "the wall ate 1.1m of it" are both
         measurable instead of eyeballed. Reset here with the rest of the
         brain, which is what makes A.reset() end a shove that was still in
         flight when the round did. */
      shoveT: 0, shoveDur: 0, shoveDist: 0, shoveLeft: 0,
      shoveX: 0, shoveZ: 0, shoveMoved: 0,
      repFrom: 0, repStuck: false, comboDone: false, wantsAttack: false
    };
    k.staggerMeter = 0;
    /* §28 A: a fresh ladder with the fresh brain. The personality was dealt
       one line above, and it is what sets both where he starts and how fast
       he climbs — so this has to happen here, after the deal, and not at
       makeKnightState() time when he has no temperament yet. */
    var kt = ktree();
    k.level = kt ? kt.spawnLevel(name) : 1;
    k.levelT = 0;
    k.levelTell = 0;
    return k.brain;
  }

  /* Advance one knight's own ladder. ALIVE knights only — a corpse stops
     earning, which is also what stops a cleared floor from quietly climbing
     behind the victory card while the render loop keeps turning. */
  function updateLevel(k, dt) {
    var kt = ktree();
    if (!kt || !k.alive || !k.brain) return;
    k.levelT += dt;
    if (k.levelTell > 0) k.levelTell = Math.max(0, k.levelTell - dt);
    var want = kt.levelFor(k.brain.personality, k.levelT, roundNow());
    if (want === k.level) return;
    k.level = want;
    /* THE TELL. Not a pose — a pose would interrupt whatever he is doing and
       a knight who freezes to celebrate is a free hit. The armour brightens
       for tellMs and his own light swells with it, which reads across the
       nave and costs the fight nothing. */
    k.levelTell = kt.tellMs() / 1000;
    for (var m = 0; m < k.mats.length; m++) {
      var mm = k.mats[m];
      if (mm.emissive) { mm.emissive.setHex(0xffb038); mm.emissiveIntensity = 1.4; }
    }
    (function (kk) {
      window.setTimeout(function () {
        for (var j = 0; j < kk.mats.length; j++) {
          var mj = kk.mats[j];
          if (mj.emissive) { mj.emissive.setHex(0x000000); mj.emissiveIntensity = 1.0; }
        }
      }, kt.tellMs());
    })(k);
  }
  function brainOf(k) {
    if (k.brain) return k.brain;
    var i = 0;
    for (var n = 0; n < knights.length; n++) if (knights[n] === k) i = n;
    return initBrain(k, i);
  }

  /* States he does not CHOOSE to be in. The frame one of them releases him he
     re-decides immediately, rather than serving out a hold he never picked. */
  var UNCHOSEN = { stagger: 1, attack: 1, recover: 1, death: 1 };

  /* How long a chosen state is committed for — all of it from data, so
     retuning the fight never means editing this file. `recover` and `stagger`
     are absent on purpose: their clocks are the pattern's recoverMs and the
     brain's staggerMs, both counted elsewhere. */
  function stateHold(b, s) {
    var t = b.tune;
    if (s === 'strafe') return t.strafeHoldMs / 1000;
    if (s === 'reposition') return t.repositionMs / 1000;
    if (s === 'press') return t.pressSwayMs / 1000;
    if (s === 'stalk') return t.arcHoldMs / 1000;
    if (s === 'coil') return t.dashTellMs / 1000;
    if (s === 'dash') return (D().knight || {}).dashTime || 0.42;
    if (s === 'taunt') return t.attackCooldownMs / 1000;  // one swing's worth of contempt
    return 0;
  }
  function distToPlayer(k) {
    var dx = pos.x - k.group.position.x, dz = pos.z - k.group.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
  function onEnterState(k, b, s) {
    // a fresh circle picks a fresh direction, and a fresh budget of reversals
    if (s === 'strafe') { b.strafeSign = (Math.random() < 0.5) ? 1 : -1; b.strafeFlips = 0; }
    else if (s === 'reposition') b.repFrom = distToPlayer(k);
    else if (s === 'dash') {
      /* The lunge is COMMITTED: the heading is taken once, at launch, and he
         wears the consequence if you step off it. Aiming it every frame is
         what made §18's dash unloseable. */
      var g = k.group;
      var dx = pos.x - g.position.x, dz = pos.z - g.position.z;
      var d = Math.sqrt(dx * dx + dz * dz) || 1;
      k.anim.dashDir = { x: dx / d, z: dz / d };
      k.anim.dash = b.hold;
      k.anim.dashCd = b.tune.dashCooldownMs / 1000;
    }
  }
  /* Enter a DIFFERENT state. Called every frame by the owning-state cascade,
     so it must be a no-op when the name has not changed or `t` never grows. */
  function setState(k, b, s) {
    if (b.state === s) return;
    // he owes himself one attack window before he may give ground again
    if (b.state === 'reposition') b.repCd = b.tune.attackCooldownMs / 1000;
    b.prev = b.state;
    b.state = s;
    b.t = 0;
    b.hold = stateHold(b, s);
    b.entered++;
    onEnterState(k, b, s);
  }
  /* Re-decide. Unlike setState, picking the same name again is a fresh
     decision and restarts its clock (another lap of the circle, another arc). */
  function restate(k, b, s) {
    if (b.state !== s) { setState(k, b, s); return; }
    b.t = 0;
    b.hold = stateHold(b, s);
    onEnterState(k, b, s);
  }

  /* Is a squadmate close enough that these two are fighting each other for
     the same metre of floor? */
  function crowdedBy(k, d) {
    for (var i = 0; i < knights.length; i++) {
      var o = knights[i];
      if (o === k || !o.alive || !o.group) continue;
      var dx = o.group.position.x - k.group.position.x;
      var dz = o.group.position.z - k.group.position.z;
      if (dx * dx + dz * dz < d * d) return true;
    }
    return false;
  }

  /* What he does next, when he is free to choose. The weights are relative
     pulls, not probabilities (the engine normalises), so data can read as
     "presses forward twice as often as he circles" and a personality can lean
     the whole fighter by moving one number. */
  function chooseState(k, b, dist) {
    var t = b.tune;
    /* Settle whether the retreat he is being released from actually GAINED
       anything, before he is asked whether to do it again. One body radius is
       the smallest gain worth calling a retreat.
       This has to live here, at the decision point, not in setState: picking
       `reposition` a second time goes through restate(), which never changes
       the name and so never ran a leave hook — a knight re-choosing it every
       0.9s was therefore never once judged, and stayed pinned. */
    if (b.state === 'reposition') b.repStuck = (dist - b.repFrom) < KNIGHT_RADIUS;
    /* Two answers are forced, and both are about SPACE, not preference: a
       player hugging him cannot be swung at, and a combo just ended with him
       over-committed and inside your reach. */
    if (b.comboDone) { b.comboDone = false; return 'reposition'; }
    /* Two reasons to give ground, and both mean "there is no room to swing
       here": the player is hugging him, or a squadmate is fighting him for the
       same pocket. Crowding only counts INSIDE that pocket — a mate 1.7m away
       while he circles at four metres is a formation, not a jam — and `repCd`
       (one attack cooldown, set when the last retreat ended) is what stops a
       squad oscillating between backpedal and re-approach for a whole round. */
    var jam = (dist < t.tooCloseDist) ||
              (b.repCd <= 0 && crowdedBy(k, t.crowdDist) &&
               dist < t.keepDistance + t.tooCloseDist);
    if (!jam) b.repStuck = false;
    /* Backing off is only an answer if it WORKS. arena.knightMinDist (1.3)
       sits INSIDE brain.tooCloseDist (1.4), so a knight held at the minimum by
       five squadmates is permanently "too close" and can never retreat out of
       it — measured at squad 6, one knight spent 100% of a 60s run walking
       backwards. A retreat that gained nothing sets repStuck and he fights his
       way out instead: press pushes him back to keepDistance at walkSpeed,
       which is half a metre a second faster than the backpedal ever was. */
    if (jam && !b.repStuck) return 'reposition';
    // the lunge is only worth its tell across a real gap
    if (dist > t.dashRange && k.anim.dashCd <= 0) return 'coil';

    var opts = [], total = 0;
    function add(name, w) { if (w > 0) { opts.push(name); opts.push(w); total += w; } }
    if (dist > t.keepDistance) add('stalk', t.stalkWeight);
    if (dist <= t.dashRange) add('press', t.pressWeight);
    add('strafe', t.strafeWeight);
    if (dist < t.repositionDist && !b.repStuck) add('reposition', t.repositionWeight);
    if (!total) return dist > t.keepDistance ? 'stalk' : 'press';
    var r = Math.random() * total;
    for (var i = 0; i < opts.length; i += 2) {
      r -= opts[i + 1];
      if (r <= 0) return opts[i];
    }
    return 'press';
  }

  /* Take the blade out of his hand. Re-parented to his GROUP, not the scene:
     the group's floor is still y = 0 there, and reset() can put every piece
     back exactly where it was. A sword left loose in the scene would outlive
     the round it was dropped in. */
  function dropSword(k) {
    if (k.dropped || !k.rig || !k.rig.bones.sword || !k.group) return;
    /* §28: take everything on the SWORD BONE, not everything under the elbow
       whose name matches /Sword/. The bone is the manifest's own answer to
       "what is the sword" — five merged meshes, blade through pommel — so the
       drop no longer depends on a name regex agreeing with an artist. */
    var list = [];
    k.rig.bones.sword.group.traverse(function (o) { if (o.isMesh) list.push(o); });
    k.dropped = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      k.dropped.push({ obj: o, parent: o.parent, pos: o.position.clone(),
                       quat: o.quaternion.clone() });
      k.group.attach(o);
    }
  }
  function restoreSword(k) {
    if (!k.dropped) return;
    for (var i = 0; i < k.dropped.length; i++) {
      var rec = k.dropped[i];
      rec.parent.add(rec.obj);
      rec.obj.position.copy(rec.pos);
      rec.obj.quaternion.copy(rec.quat);
    }
    k.dropped = null;
  }

  /* §22 DEATH — replacing the sink through the floor, which read as a
     collision bug every single time, because a body falling through stone is
     exactly what a collision bug looks like. Over brain.deathMs: knees buckle,
     the torso pitches over them, the sword leaves his hand, the body settles,
     and ONLY then does it fade. The pose itself is in poseKnight; what lives
     here is everything that is not a joint angle. */
  function updateDeath(k, dt) {
    var b = brainOf(k);
    var life = Math.max(0.1, b.tune.deathMs / 1000);
    b.deathT += dt;
    b.state = 'death';
    var f = Math.min(1, b.deathT / life);
    k.anim.state = 'death';
    k.anim.swinging = false;
    if (f > 0.30) dropSword(k);
    if (k.dropped) {
      for (var i = 0; i < k.dropped.length; i++) {
        var o = k.dropped[i].obj;
        /* It falls, it does not teleport. The blade is held near-vertical, so
           easing z round to a quarter turn lays it on the flags — an
           approximation, but one nobody has ever caught at fight distance. */
        o.position.y += (0.06 - o.position.y) * alpha(6, dt);
        o.rotation.z += (Math.PI / 2 - o.rotation.z) * alpha(4, dt);
      }
    }
    if (k.light) k.light.intensity = k.light.intensity * (1 - alpha(2.2, dt));
    poseKnight(k, dt);
    /* The body's vertical rides the rig's own `_root` now — the death pose
       drops him as the knees buckle — so the group stays on the floor. It
       used to carry `k.bob`, which went with the sibling pivots. */
    k.group.position.y = 0;
    /* Fade LAST, and only once he has settled: a corpse that starts
       dissolving while it is still falling reads as a despawn, not a death. */
    var fade = seg(f, 0.80, 1.00);
    if (fade > 0) {
      for (var m = 0; m < k.mats.length; m++) {
        var mm = k.mats[m];
        mm.transparent = true;
        mm.opacity = 1 - fade;
        mm.depthWrite = false;
      }
    }
    if (f >= 1) k.group.visible = false;
  }

  /* §22 knight brain: the state machine above drives where he stands; the
     telegraph/strike windows still come from ui/battle3d.js, so the dodge
     rules of §16 are untouched. Facing rules are §18's: locked to the lane
     mid-swing, tracking you otherwise — and, now, genuinely sluggish while he
     recovers and frozen while he reels. */
  function updateOneKnight(k, dt) {
    var atk = k.atk;
    if (!k.group) return;
    /* Rescue: a knight that somehow starts off the navgrid can never move,
       because every candidate step reverts to an illegal position. Snap it
       back onto real floor before anything else runs. */
    if (k.alive && nav && !navFree(k.group.position.x, k.group.position.z, KNIGHT_RADIUS)) {
      var fix = navNearest(k.group.position.x, k.group.position.z, KNIGHT_RADIUS);
      k.group.position.x = fix.x;
      k.group.position.z = fix.z;
    }
    if (!k.alive) { updateDeath(k, dt); return; }

    var st = k.anim, b = brainOf(k), t = b.tune;
    updateLevel(k, dt);               // §28 A: his own ladder, on seconds alive
    var kx = k.group.position.x, kz = k.group.position.z;
    var dx = pos.x - kx, dz = pos.z - kz;
    var dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
    var ux = dx / dist, uz = dz / dist;
    var px = -uz, pz = ux;              // his right-hand side, for circling

    // ---- timers ----
    b.t += dt;
    b.arcT += dt;
    st.dashCd = Math.max(0, st.dashCd - dt);
    b.atkCd = Math.max(0, b.atkCd - dt);
    b.repCd = Math.max(0, b.repCd - dt);
    b.hitFlash = Math.max(0, b.hitFlash - dt);
    /* Chip damage must never bank into a stagger, or the punish window stops
       being something you EARN with a heavy hit and becomes a metronome. */
    if (k.staggerMeter > 0) k.staggerMeter = Math.max(0, k.staggerMeter - t.staggerDecay * dt);
    if (b.arcT >= t.arcHoldMs / 1000) { b.arcSign = -b.arcSign; b.arcT = 0; }
    /* §25 shove clock. Counted with the other timers so it bleeds on exactly
       the same dt the payout below is priced against — the two drifting apart
       is how a knight ends up owing metres he never gets, or sliding forever.
       The metres owed run out with the clock: shoveLeft can only be spent by
       the payout, and the clock hitting zero ends the shove whatever is left,
       so a knight pinned against stone stops the moment the water does rather
       than leaning on it for the rest of the round. */
    if (b.shoveT > 0) {
      b.shoveT = Math.max(0, b.shoveT - dt);
      if (b.shoveT <= 0) { b.shoveLeft = 0; b.shoveDur = 0; }
    }

    /* Safety net: `swinging` is cleared by clearAttack, which rides on the
       strike timer's setTimeout. A callback path that dies — or a headless
       test that steps dt with no timers running at all — used to leave him
       frozen in guard forever, which is also a knight who never moves again. */
    if (st.swinging && atk.mode === 'idle' && st.swingT > swingTotal(st)) {
      st.swinging = false;
      st.swingT = 0;
    }

    // ---- which state owns him this frame ----
    var swingLive = (atk.mode === 'telegraph' || atk.mode === 'strike');
    if (b.staggerT > 0) {
      b.staggerT = Math.max(0, b.staggerT - dt);
      // §23: the stun label bleeds on the same clock it was granted against
      if (b.stunT > 0) b.stunT = Math.max(0, b.stunT - dt);
      setState(k, b, 'stagger');
    } else if (swingLive) {
      setState(k, b, 'attack');
    } else if (st.swinging) {
      setState(k, b, 'recover');        // follow-through and the settle to guard
    } else if (b.state === 'coil') {
      if (b.t >= b.hold) setState(k, b, 'dash');       // the tell is spent: he commits
    } else if (b.state === 'taunt' && b.t < b.hold) {
      /* A beat of contempt is COMMITTED, like the coil. Left interruptible it
         was cut short on its first frame every time a squadmate wandered
         inside crowdDist, so the pose existed and was never once seen. */
    } else if (b.state === 'reposition' && dist >= t.repositionDist) {
      restate(k, b, chooseState(k, b, dist));          // far enough — turn and face him again
    } else if (UNCHOSEN[b.state] || b.t >= b.hold ||
               (b.state !== 'reposition' && b.state !== 'dash' &&
                crowdedBy(k, t.crowdDist))) {
      restate(k, b, chooseState(k, b, dist));
    }
    b.wantsAttack = (b.state === 'press' && b.atkCd <= 0 && dist <= t.keepDistance + t.tooCloseDist);

    // ---- movement: one step, in this state's own direction ----
    var mvx = 0, mvz = 0, radial;
    if (b.state === 'stalk') {
      /* ARC-BIASED APPROACH. Rotating the player vector by arcBias (sign held
         for arcHoldMs, and opposite for his neighbour) is the whole
         difference between closing and homing: he arrives off your centre
         line, from a side you have to turn to meet. */
      var a = t.arcBias * b.arcSign;
      var ca = Math.cos(a), sa = Math.sin(a);
      mvx = (ux * ca - uz * sa) * t.walkSpeed;
      mvz = (ux * sa + uz * ca) * t.walkSpeed;
      st.state = 'walk';
    } else if (b.state === 'press') {
      /* Hold the range and wait. A P term with a gain of 1/s, clamped to his
         own pace: metres of error in, metres per second out. */
      radial = Math.max(-t.walkSpeed, Math.min(t.walkSpeed, dist - t.keepDistance));
      mvx = ux * radial; mvz = uz * radial;
      st.state = (Math.abs(radial) > 0.06) ? 'walk' : 'idle';
    } else if (b.state === 'strafe') {
      radial = Math.max(-t.strafeSpeed, Math.min(t.strafeSpeed, dist - t.keepDistance));
      mvx = px * b.strafeSign * t.strafeSpeed + ux * radial;
      mvz = pz * b.strafeSign * t.strafeSpeed + uz * radial;
      st.state = 'strafe';
    } else if (b.state === 'reposition') {
      mvx = -ux * t.backpedalSpeed; mvz = -uz * t.backpedalSpeed;
      st.state = 'backpedal';
    } else if (b.state === 'dash') {
      st.dash = Math.max(0, st.dash - dt);
      mvx = st.dashDir.x * t.dashSpeed; mvz = st.dashDir.z * t.dashSpeed;
      st.state = 'dash';
    } else if (b.state === 'stagger') {
      // reeling back off the blow, decaying to a stop as he gets his feet
      /* Clamped at 1: §23's stun sets staggerT from the ABILITY (1.5s) and can
         legitimately exceed his own staggerMs (1.2s), which un-clamped would
         make him reel BACKWARDS faster than his own backpedal for the first
         third of a second. The pose path (poseKnight) already clamps; this one
         moves his feet, so it has to as well. */
      var reel = t.staggerMs > 0 ? Math.min(1, b.staggerT / (t.staggerMs / 1000)) : 0;
      mvx = -ux * t.backpedalSpeed * reel; mvz = -uz * t.backpedalSpeed * reel;
      st.state = 'stagger';
    } else if (b.state === 'coil') {
      st.state = 'coil';                // planted: the crouch IS the warning
    } else if (b.state === 'taunt') {
      st.state = 'taunt';
    } else {
      st.state = 'idle';                // attack / recover: the swing owns him
    }

    /* §25: while the water has him, his own feet are not his. Zeroing the
       state's movement vector (rather than inventing a `shove` STATE) is
       deliberate: §22's six states are what the HUD, the pose library and
       _simKnight all read, and a seventh one would have to be taught to every
       one of them. He keeps deciding — the clocks run, the choice he lands on
       is the one he resumes with — he simply does not get to walk while he is
       being thrown, which is also why he cannot slide on afterwards: there is
       no velocity to carry, only metres owed that expire with the clock.
       `backpedal` is the pose because it is the one in the library that reads
       as losing ground with the guard still up. NOT `stagger` — that is the
       §23 stun's pose, and the wave explicitly does not stun. */
    if (b.shoveT > 0) {
      mvx = 0; mvz = 0;
      st.state = 'backpedal';
      /* Nothing schedules a swing at a knight who is airborne: wantsAttack is
         what ui/battle3d.js reads to pick who telegraphs next. He is not
         stunned, so the swing is merely postponed by the flight time. */
      b.wantsAttack = false;
    }

    var nx = kx + mvx * dt, nz = kz + mvz * dt;
    /* Circling into stone REVERSES the orbit. Without this the axis slide
       below walks him sideways into the pillar and holds him there for the
       whole strafeHoldMs, which looks exactly like a stuck AI. */
    if (b.state === 'strafe' && nav && !navFree(nx, nz, KNIGHT_RADIUS)) {
      b.strafeSign = -b.strafeSign;
      /* The new lap gets a fresh hold — but only while there IS a new lap.
         With stone on both sides he flips and re-zeroes this clock every other
         frame, so `b.t` can never reach `b.hold`, the cascade below never
         releases him, and he is locked in `strafe` for the rest of the fight:
         orbiting a wall he cannot leave, never re-deciding, never attacking.
         Measured after a §25 shove carried a knight behind the altar block —
         strafeSign flipping every 2 frames with b.t pinned at 0.00/0.02 for
         40 seconds and pathLength climbing 85m without him moving 5cm.
         Two free reversals is more than a real corner needs and still lets the
         clock expire, which is the only thing that hands him back to
         chooseState. The budget is refilled by onEnterState, so every honest
         re-decision starts him over. */
      if ((b.strafeFlips = (b.strafeFlips || 0) + 1) <= 2) b.t = 0;
      nx = kx - mvx * dt; nz = kz - mvz * dt;
    }
    kx = nx; kz = nz;

    /* §25 shove payout. Metres owed, spent at a constant rate over the time
       the ability asked for, ONE FRAME AT A TIME — a knight who arrives 3.2m
       away in a single step has not been thrown, he has blinked, and blinking
       reads as a bug in a game whose whole fight is about reading movement.
       Deliberately placed here, in the same lane as his own gait: everything
       after this line (squad separation, the player push, containKnight) then
       treats a shoved metre exactly like a walked one, so the wave cannot
       shortcut a rule his own feet obey. */
    if (b.shoveT > 0 && b.shoveLeft > 0) {
      var rate = b.shoveDur > 0 ? (b.shoveDist / b.shoveDur) : b.shoveLeft;
      /* Capped at his own body radius per frame, and that cap is containment,
         not smoothing: navFree only samples where a step LANDS, so a step
         longer than the body it is testing can hop clean over a wall the
         0.4m grid is made of and put him in the choir. At the authored numbers
         (3.2m over 300ms) a frame is 0.18m and this never fires; it is here
         for the two cases that do reach it — a hitching frame (the loop caps
         dt at 0.05s) and a caller who asks for a far bigger throw than data
         does. When it fires he simply travels less far, which is the safe way
         to be wrong. */
      var sstep = Math.min(b.shoveLeft, rate * dt, KNIGHT_RADIUS);
      kx += b.shoveX * sstep;
      kz += b.shoveZ * sstep;
      b.shoveLeft -= sstep;
    }
    /* Is he TRAVELLING, or just adjusting? Anything slower than his slowest
       deliberate gait (the backpedal) is a shuffle, and a shuffle is exactly
       when a big yaw change has to come from the feet. Testing "moving at all"
       instead meant press — which drifts a few cm/s holding its range — never
       once planted a pivot. */
    var travelling = (mvx * mvx + mvz * mvz) >= t.backpedalSpeed * t.backpedalSpeed;

    // §20 keep the squad from stacking into one silhouette
    for (var oi = 0; oi < knights.length; oi++) {
      var other = knights[oi];
      if (other === k || !other.alive || !other.group) continue;
      var sx = kx - other.group.position.x, sz = kz - other.group.position.z;
      var sd = Math.sqrt(sx * sx + sz * sz);
      /* §22: the push target is the brain's OWN crowdDist. It used to be a
         hard 1.5 while the brain called anything under 1.8 "crowded", so the
         two rules fought each other forever: separation settled them at 1.5,
         the brain read that as crowded and ordered a reposition, and a squad
         spent half the fight backpedalling. Measured before the fix: 52% of a
         60s run in `reposition`. Push them to the distance the brain is
         actually happy with and the loop closes. */
      var want = t.crowdDist;
      if (sd < want && sd > 0.001) {
        kx += (sx / sd) * (want - sd) * 0.5;
        kz += (sz / sd) * (want - sd) * 0.5;
      }
    }

    // never walk into the player, never leave the arena
    var ar = cfg.arena || {};
    var minD = (ar.knightMinDist || 1.3);
    var ndx = pos.x - kx, ndz = pos.z - kz;
    var nd = Math.sqrt(ndx * ndx + ndz * ndz) || 1;
    if (nd < minD) {
      kx = pos.x - (ndx / nd) * minD;
      kz = pos.z - (ndz / nd) * minD;
    }

    /* §21: the charge used to start moving only AFTER the strike timer had
       already run the hit test - the picture said "he is coming at you" a
       frame after the rules had decided. Start it inside the last quarter of
       the wind-up so the lunge you SEE is the lunge you are dodging. */
    var lungeV = 0;
    if (atk.pattern && atk.pattern.id === 'charge') {
      if (atk.mode === 'telegraph') {
        lungeV = 7.6 * easeIn(seg(st.swingT / Math.max(0.05, st.swingDur), 0.75, 1.00));
      } else if (atk.mode === 'strike') {
        lungeV = 5.5;                 // follow-through
      }
    }
    if (lungeV > 0) { kx += atk.lockDir.x * dt * lungeV; kz += atk.lockDir.z * dt * lungeV; }
    /* §22 thrust_combo: the third stab STEPS THROUGH. `atk.lunge` is metres
       still owed, paid off at his lunge speed, and it is spent here rather
       than teleported at the strike so the stone below still stops him. */
    if (atk.lunge > 0) {
      var step = Math.min(atk.lunge, t.dashSpeed * dt);
      kx += atk.lockDir.x * step; kz += atk.lockDir.z * step;
      atk.lunge -= step;
    }

    /* CONTAINMENT IS THE LAST WORD (§24's finding, §25's requirement).
       It used to run above the two lunges, so the only displacements in the
       frame that were NOT arena-checked were the two that move him furthest —
       the charge and the thrust_combo step-through — which is why the comment
       above claims "the stone still stops him" while nothing was stopping him.
       Everything that moved him this frame (his own gait, squad separation,
       the player push, a §25 shove, both lunges) is now settled before the
       clamp reads the result, so there is exactly one rule and it always wins.
       The fallback is his position at the TOP of the frame: the rescue at the
       head of updateOneKnight guarantees that cell was legal. */
    var kept = containKnight(kx, kz, k.group.position.x, k.group.position.z);
    /* §25: how far the shove actually got him, measured AFTER the clamp — the
       one honest number, because a wave into a pillar moves him nothing at all
       and the difference is exactly what "clamped and stopped short" means. */
    if (b.shoveT > 0) {
      var mvdx = kept.x - k.group.position.x, mvdz = kept.z - k.group.position.z;
      b.shoveMoved += Math.sqrt(mvdx * mvdx + mvdz * mvdz);
    }
    kx = kept.x; kz = kept.z;

    k.group.position.x = kx;
    k.group.position.z = kz;

    /* ---- facing (§18's rules, with §22's costs) ----
       Locked to the lane mid-swing so the telegraph never lies about where the
       strike lands; tracking you otherwise — but at recoverTurnRate while he
       settles, and not at all while he reels. Being slow to come round IS the
       punish window; a knight who snaps back to face you the instant his blade
       passes has no back to get behind. */
    var wantYaw = yawTo(k, pos.x, pos.z);
    var yerr = wantYaw - k.group.rotation.y;
    while (yerr > Math.PI) yerr -= Math.PI * 2;
    while (yerr < -Math.PI) yerr += Math.PI * 2;
    st.turnErr = yerr;
    if (b.state !== 'stagger') {
      var turnRate = (b.state === 'recover') ? t.recoverTurnRate : t.turnRate;
      if (swingLive) easeYaw(k, atk.lockYaw, dt, turnRate);
      else easeYaw(k, wantYaw, dt, turnRate);
    }
    /* Planted pivot: past turnThreshold he stops pretending his feet are not
       there and turns with them. Only when he is not already travelling —
       a strafe is a turn with somewhere to be. */
    if (!travelling && !st.swinging && b.state !== 'stagger' && b.state !== 'taunt' &&
        Math.abs(yerr) > t.turnThreshold) st.state = 'turnInPlace';

    /* ---- swing + glow ----
       ONE clock for the picture and the damage. atk.t0 is the same
       performance.now() stamp the strike timer counts from, so a phase
       measured off it puts the impact frame ON the damage frame. The old code
       integrated dt over 1.25 * telegraphMs, parking the visual hit a
       permanent 20% late - 375-475ms, roughly TWICE the whole 220ms i-frame
       window, so a player who dodged when the blade looked like it landed was
       guaranteed to be hit. A._tick advances `elapsed` but not the wall clock,
       so take whichever has moved further: rAF snaps to the wall, the headless
       test hook scrubs by dt. */
    if (atk.mode === 'telegraph' && atk.pattern) {
      var wall = (performance.now() - atk.t0) / 1000;
      st.swingT = (wall > st.swingT) ? wall : st.swingT + dt;
      // the glow rides the CURRENT window's phase, so a combo pulses per stab
      var p = Math.min(1, swingLocalP(st));
      if (k.light) k.light.intensity = (0.9 + p * 2.6) * LIGHT_SCALE;
    } else if (st.swinging) {
      st.swingT += dt;                 // follow-through, then the settle to guard
      if (k.light) k.light.intensity = 3.2 * LIGHT_SCALE;
    } else if (k.light) {
      k.light.intensity = (0.55 + Math.sin((elapsed + st.phase) * 5.3) * 0.1) * LIGHT_SCALE;
    }
    /* §28 A: the level-up tell rides ON TOP of whatever the light was doing,
       so it reads mid-swing as well as mid-stroll — and decays with its own
       timer rather than overwriting the state the next frame restores. */
    if (k.levelTell > 0 && k.light) {
      var kt2 = ktree();
      var tf = k.levelTell / Math.max(0.05, (kt2 ? kt2.tellMs() : 800) / 1000);
      k.light.intensity += 2.6 * tf * tf * LIGHT_SCALE;
    }

    poseKnight(k, dt);
    /* No bob and no breathe here any more: both are `_root` offsets inside
       knightanim's own poses, applied to rig.root — where they move the BODY
       rather than sliding the whole group, and with it his light, his shadow
       and the origin every hit test measures from, up and down underneath
       him. `st.phase` still offsets the cycle so a squad does not breathe as
       one organism; it is passed to the pose instead of used here. */
    k.group.position.y = 0;
  }

  /* Drive every knight on the floor. */
  function updateKnight(dt) {
    for (var i = 0; i < knights.length; i++) updateOneKnight(knights[i], dt);
  }

  /* §22 ground_slam's shockwave, made visible: a flat ring thrown from his
     boots on the strike frame, expanding to exactly the pattern's `radius`.
     The ring IS the hit test drawn, so a player who learns its edge has
     learned the rule — which is the only reason a radial attack is fair.
     Pooled and pre-built at init: §21 measured what a hidden object costs the
     first frame it is really drawn (444ms for the tornado), and a ring created
     on the first slam would pay exactly that, mid-fight. */
  var shocks = [];
  function makeShock() {
    // unit ring, scaled to the pattern radius — one mesh serves every slam
    var geo = new THREE.RingGeometry(0.80, 1.0, 40);
    geo.rotateX(-Math.PI / 2);
    var lc = (D().lights || {}).knight || {};
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: lc.color != null ? lc.color : 0xff2038,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    }));
    mesh.visible = false;
    var s = { mesh: mesh, t: 0, life: 1, r: 1 };
    shocks.push(s);
    if (scene) scene.add(mesh);
    return s;
  }
  function spawnShock(k, radius, lifeMs) {
    if (!scene || !k.group) return;
    var s = null;
    for (var i = 0; i < shocks.length; i++) {
      if (!shocks[i].mesh.visible) { s = shocks[i]; break; }
    }
    if (!s) s = makeShock();
    s.t = 0;
    /* The ring lives as long as he is on the floor recovering from it: the
       dust settling and the punish window closing are the same beat. */
    s.life = Math.max(0.15, (lifeMs || 800) / 1000);
    s.r = radius;
    s.mesh.position.set(k.group.position.x, 0.05, k.group.position.z);
    s.mesh.scale.setScalar(0.05);
    s.mesh.material.opacity = 0.95;
    s.mesh.visible = true;
  }
  function updateShocks(dt) {
    for (var i = 0; i < shocks.length; i++) {
      var s = shocks[i];
      if (!s.mesh.visible) continue;
      s.t += dt;
      var f = Math.min(1, s.t / s.life);
      /* Out fast, then linger. The wave reaches full radius in the first
         third — that is the part which has to agree with the damage — and
         everything after it is dust. */
      s.mesh.scale.setScalar(Math.max(0.05, s.r * easeOut(Math.min(1, f * 3))));
      s.mesh.material.opacity = 0.95 * (1 - f) * (1 - f);
      if (f >= 1) s.mesh.visible = false;
    }
  }

  /* ------------------------------------------------- §25 Water Wave visual
     A low sheet of water thrown out along the cast direction: a flat arc,
     centred on the caster, opening to exactly the ability's `cone.reach` over
     exactly its `shove.ms`. Same principle as the ground_slam shockwave above
     — THE PICTURE IS THE HIT TEST DRAWN — which is what lets a player learn
     "the knights inside that arc get thrown" from watching it once, and is
     why every number below is read off the ability def rather than tuned here.

     Two meshes: a body wedge and a thin bright crest at its leading edge, so
     the water has a front to read the speed off. Both are unit-radius and
     SCALED, which is why one pair of geometries serves any reach.

     No PointLight, unlike the tornado and the asteroid. A punctual light that
     joins the scene mid-fight makes three r128 recompile every material that
     can receive it — the exact 444ms hitch §21 measured and built the warm-up
     pass to kill — and this is the one ability you cast BECAUSE something is
     already swinging at you. Additive geometry over the floor carries it.

     Built once at init and reused (built here, disposed nowhere, allocated
     never again): §24 leaked a shadow render target by creating GPU objects
     per build and freeing none, so the wave takes the other road and creates
     nothing after init. Its 4.5s cooldown means one instance can never be
     asked to be in two places at once. */
  var wave = { root: null, body: null, crest: null, active: false,
               t: 0, reach: 6, travel: 0.3, fade: 0.26 };

  function makeWave() {
    if (!scene || wave.root) return;
    var wc = D().wave || {};
    /* The wedge is built symmetric about local +X and the GROUP is turned to
       the cast direction, so the half-angle in data is the half-angle you see
       and nothing has to reason about RingGeometry's winding at spawn time.
       Half-angle is a build-time constant here (the geometry is baked) and is
       re-cut per cast only if the ability declares a different one — see
       spawnWave, which rebuilds the wedge rather than lying about the arc. */
    wave.half = (wc.halfAngle != null ? wc.halfAngle : 40) * Math.PI / 180;
    wave.seg = wc.segments || 36;
    wave.color = wc.color != null ? wc.color : 0x64d2ff;
    wave.crestColor = wc.crestColor != null ? wc.crestColor : 0xdff6ff;
    wave.y = wc.y != null ? wc.y : 0.12;

    wave.root = new THREE.Group();
    wave.root.visible = false;
    wave.body = new THREE.Mesh(wedgeGeo(0.28, 1.0, wave.half, wave.seg),
      new THREE.MeshBasicMaterial({ color: wave.color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    wave.crest = new THREE.Mesh(wedgeGeo(0.88, 1.0, wave.half, wave.seg),
      new THREE.MeshBasicMaterial({ color: wave.crestColor, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    wave.root.add(wave.body);
    wave.root.add(wave.crest);
    scene.add(wave.root);
  }

  /* Flat unit wedge, symmetric about local +X. RingGeometry lives in XY and
     is laid down with the same rotateX the shockwave uses, so its own angle 0
     ends up on +X and the arc opens either side of it. */
  function wedgeGeo(inner, outer, half, seg) {
    var g = new THREE.RingGeometry(inner, outer, Math.max(6, seg), 1, -half, half * 2);
    g.rotateX(-Math.PI / 2);
    return g;
  }

  /* Re-cut both wedges when an ability asks for an arc the built one does not
     have. Disposing the old geometries first is the whole point — a spell cast
     forty times in a run that left forty ring geometries on the GPU is exactly
     the leak §24 shipped and this file is not repeating it. */
  function reshapeWave(half) {
    if (!wave.root || Math.abs(half - wave.half) < 0.005) return;
    wave.body.geometry.dispose();
    wave.crest.geometry.dispose();
    wave.body.geometry = wedgeGeo(0.28, 1.0, half, wave.seg);
    wave.crest.geometry = wedgeGeo(0.88, 1.0, half, wave.seg);
    wave.half = half;
  }

  /* Throw the sheet. Everything it needs comes off the ability def (§25 data:
     `cone.reach` / `cone.halfAngle` for the shape, `shove.ms` for how long the
     water takes to cross it); the fallbacks exist only so a caller with a
     half-authored ability still sees water instead of an exception. */
  A.spawnWave = function (ability) {
    if (!wave.root) makeWave();
    if (!wave.root) return false;
    var ab = ability || {};
    var cone = ab.cone || {};
    var reach = cone.reach != null ? cone.reach : (ab.range || 6);
    /* `arc` in the schema is the FULL angle (abilityTargets halves it), so a
       def that states only `arc` still produces the right wedge. */
    var half = (cone.halfAngle != null ? cone.halfAngle : ((ab.arc || 80) / 2)) * Math.PI / 180;
    var sh = ab.shove || {};
    reshapeWave(half);

    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    wave.root.position.set(pos.x, wave.y, pos.z);
    /* Local +X onto the cast direction. atan2 rather than yaw + PI/2 because
       the mapping through rotateX is easy to get a sign wrong in, and this one
       is derived from the vector the hit test itself uses. */
    wave.root.rotation.y = Math.atan2(-fz, fx);
    wave.reach = reach;
    /* The water crosses the cone in the time the knights are being thrown, so
       the picture and the displacement are the same event. */
    wave.travel = Math.max(0.08, ((sh.ms > 0 ? sh.ms : 300) / 1000));
    wave.fade = wave.travel * 0.85;
    wave.t = 0;
    wave.active = true;
    wave.root.visible = true;
    wave.body.material.opacity = 0.0;
    wave.crest.material.opacity = 0.0;
    return true;
  };

  function updateWave(dt) {
    if (!wave.active || !wave.root) return;
    wave.t += dt;
    var life = wave.travel + wave.fade;
    var f = Math.min(1, wave.t / wave.travel);
    /* Out fast and then ease into the far edge: water shoved from the hip
       leaves quickly and runs out of push, and the eased tail is also what
       makes the crest arrive at `reach` on the frame the shove finishes. */
    var r = Math.max(0.05, wave.reach * easeOut(f));
    wave.root.scale.set(r, 1, r);
    /* Body fills in behind the crest, then both bleed out. Kept off the same
       curve so the sheet does not vanish as one flat card. */
    var out = Math.max(0, 1 - Math.max(0, wave.t - wave.travel) / wave.fade);
    wave.body.material.opacity = 0.42 * Math.min(1, f * 2.2) * out;
    wave.crest.material.opacity = 0.85 * out;
    // a hand's breadth of lift as it goes, so it reads as a sheet, not a decal
    wave.root.position.y = wave.y + 0.06 * f;
    if (wave.t >= life) {
      wave.active = false;
      wave.root.visible = false;
      wave.body.material.opacity = 0;
      wave.crest.material.opacity = 0;
    }
  }

  /* Who the wave catches, and WHICH WAY each of them goes (§25). The engine
     answers this rather than the caller because the sides are decided in the
     caster's frame — perpendicular to your facing, each knight toward the side
     he is already nearest — and yaw and the knight positions both live here.
     Hand each entry straight to A.shove(); the distance and the time come off
     the ability's own `shove` block, so retuning the throw is a data edit.
     Deliberately free of abilityTargets' taunt side effect: this is a query
     the caller may run to AIM, and a whiff it never fired must not gloat. */
  A.waveTargets = function (ability) {
    var ab = ability || {}, cone = ab.cone || {}, sh = ab.shove || {};
    var reach = cone.reach != null ? cone.reach : (ab.range || 6);
    var half = (cone.halfAngle != null ? cone.halfAngle : ((ab.arc || 80) / 2)) * Math.PI / 180;
    var cosHalf = Math.cos(half);
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);      // your right hand, in world XZ
    var dist = sh.distance != null ? sh.distance : 3.2;
    var ms = sh.ms != null ? sh.ms : 300;
    var out = [];
    for (var i = 0; i < knights.length; i++) {
      var k = knights[i];
      if (!k.alive || !k.group) continue;
      var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d > reach || d < 0.0001) continue;
      if ((dx * fx + dz * fz) / d < cosHalf) continue;
      var lat = dx * rx + dz * rz;
      /* Dead centre has no nearer side, so it is split by index instead of by
         a coin — two knights standing on your centre line must go opposite
         ways or the wave shoves them into each other and opens no lane. */
      var side = (Math.abs(lat) < 1e-4) ? ((i % 2) ? 1 : -1) : (lat > 0 ? 1 : -1);
      out.push({ index: i, dirX: rx * side, dirZ: rz * side,
                 distance: dist, ms: ms, side: side });
    }
    return out;
  };

  function updateFx(dt) {
    for (var i = 0; i < candleLights.length; i++) {
      var c = candleLights[i];
      c.intensity = c.userData.baseI * (0.75 + 0.25 * Math.sin(elapsed * 7 + c.userData.phase) + 0.1 * Math.random());
    }
    updateShocks(dt);
    updateWave(dt);
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000)) || 0.016;
    lastTime = now;
    elapsed += dt;
    updatePlayer(dt);
    updateKnight(dt);
    if (fp.mixer) fp.mixer.update(dt);
    updateSignAndTornado(dt);
    updateFx(dt);
    try { renderer.render(scene, camera); }
    catch (e) {
      if (!renderFailed) console.warn('[arena3d] render error', e);
      renderFailed = true;
    }
  }

  // ---------------------------------------------------------------- API
  A.start = function () {
    lockSuppressed = false;   // a new fight starts in movement mode
    controlOff = false;       // ...and owns the keyboard again
    if (disabled || !inited || running) return;
    running = true;
    keys = {};
    vel.x = 0; vel.z = 0;
    addListeners();
    A.resize();
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  };

  /* §21: hand the cursor back. Pointer lock hides the mouse and swallows
     every click, so any UI put on screen over the arena is unreachable until
     the lock is dropped - the player had to know to press Escape first. The
     game now does it for them whenever it puts up a panel.
     `suppressLock` keeps the canvas click handler from silently grabbing the
     lock straight back while that panel is still up. */
  A.releaseLock = function (suppress) {
    if (suppress !== false) lockSuppressed = true;
    /* Releasing the LOCK is not enough on its own: the keydown listener stays
       live, so WASD kept walking the camera behind the result card and the
       Space handler kept eating the key that would press its button. Hand
       back the whole input surface, but deliberately leave the render loop
       running - stop() would tear the arena down and leave the card sitting
       on a dead canvas, since the renderer has no preserveDrawingBuffer. */
    controlOff = true;
    keys = {};
    vel.x = 0; vel.z = 0;
    if (isLocked()) { try { document.exitPointerLock(); } catch (e) {} }
  };

  /* Let the player put themselves back in movement mode (click-to-look). */
  A.allowLock = function () { lockSuppressed = false; controlOff = false; };

  A.isLocked = function () { return isLocked(); };

  A.stop = function () {
    if (!running) return;
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    removeListeners();
    keys = {};
    vel.x = 0; vel.z = 0;
    clearAttack();
    if (isLocked()) { try { document.exitPointerLock(); } catch (e) {} }
  };

  A.resize = function () {
    if (!renderer || !camera || !canvas) return;
    var w = canvas.clientWidth || window.innerWidth || 1;
    var h = canvas.clientHeight || window.innerHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  A.debug = function () {
    if (!inited) return deadDebug();
    var nd = A.nearestKnightDist();
    return {
      x: pos.x, z: pos.z, yaw: yaw, pitch: pitch,
      crouch: isCrouching(), eye: eyeH,
      knightDist: isFinite(nd) ? nd : 0,
      mode: knight.atk.mode,
      knightAlive: knight.alive,
      churchLoaded: churchLoaded, knightLoaded: knightLoaded,
      envMap: envMapOk,
      knightRig: knight.rigInfo || null,
      /* §28 A: the SPREAD, made measurable. `knightLevels[i]` is what that
         knight is right now; `roundLevel` is the baseline the round is worth
         and what the poster/HUD still name. A verifier watching these two
         diverge over a fight is watching the whole feature work. */
      roundLevel: ktree() ? ktree().level() : 1,
      levelCap: ktree() ? ktree().capForRound(roundNow()) : 1,
      knightLevels: knights.map(function (k) { return k.level || 1; }),
      knightLevelT: knights.map(function (k) { return +(k.levelT || 0).toFixed(1); }),
      // §28 A2: the round's speed multiplier, and what it is doing to a swing
      roundSpeed: +roundSpeed().toFixed(3),
      squad: knights.length,
      squadAlive: knights.filter(function (k) { return k.alive; }).length,
      knightState: knight.anim ? knight.anim.state : null,
      knightDashCd: knight.anim ? +knight.anim.dashCd.toFixed(2) : null,
      knightPos: knight.group ? [+knight.group.position.x.toFixed(2), +knight.group.position.z.toFixed(2)] : null,
      /* §22 per-knight brain: which state he is in, whose temperament he is
         fighting with, and every timer that decides what he does next. Squad
         order, so knightBrain[i] and staggerMeter[i] line up with the indices
         ui/battle3d.js addresses knights by. */
      knightBrain: knights.map(function (k) {
        var b = k.brain;
        if (!b) return { state: k.anim ? k.anim.state : null, personality: null };
        return {
          state: b.state, anim: k.anim.state, personality: b.personality,
          alive: k.alive,
          t: +b.t.toFixed(2), hold: +b.hold.toFixed(2), entered: b.entered,
          dashCd: +k.anim.dashCd.toFixed(2), atkCd: +b.atkCd.toFixed(2),
          staggerT: +b.staggerT.toFixed(2), stunT: +(b.stunT || 0).toFixed(2),
          /* §25: the wave, measurable. shoveT > 0 says he is in the air (and
             therefore that his own movement is suspended this frame),
             shoveLeft is what the payout still owes him and shoveMoved is what
             the arena actually let him have — the gap between the last two is
             the containment clamp doing its job, which is the one thing a
             verifier cannot see from the outside. */
          shoveT: +b.shoveT.toFixed(2),
          shoveLeft: +(b.shoveLeft || 0).toFixed(2),
          shoveMoved: +(b.shoveMoved || 0).toFixed(2),
          hitFlash: +b.hitFlash.toFixed(2),
          arcSign: b.arcSign, strafeSign: b.strafeSign,
          wantsAttack: !!b.wantsAttack
        };
      }),
      /* The buildup meter itself, with the thresholds it is racing, because
         "why did he not stagger" is otherwise unanswerable from outside. */
      staggerMeter: knights.map(function (k) {
        var b = k.brain;
        return { meter: +(k.staggerMeter || 0).toFixed(1),
                 needs: b ? b.tune.staggerBuildup : null,
                 oneHit: b ? b.tune.staggerDamage : null,
                 staggered: !!(b && b.staggerT > 0),
                 /* §23: why he is reeling. `stunned` means an ability put him
                    there (the rock), so a test can tell an earned stagger from
                    a granted one without timing the two apart. */
                 stunned: !!(b && (b.stunT || 0) > 0),
                 takeMult: A.staggerMult(knights.indexOf(k)) };
      }),
      /* §22: the measured open floor. null means the navgrid never loaded and
         the fight is running on the fallback `arena.bounds` rectangle — which
         is the only state in which that rectangle matters. */
      arenaArea: arenaArea,
      /* §24: WHERE this fight is, and — the load-bearing bit — which
         containment rule is actually live. `nav:false` on a round stage is not
         a missing bake, it is the whole design: the radius clamp is doing the
         work. `nav:false` on a MODEL stage is a bug, and this is where you see
         the difference. Only the clamp in play is reported, so the field
         cannot claim a rectangle the engine is ignoring. */
      stage: stageDebug(),
      locked: isLocked()
    };
  };

  function stageDebug() {
    var ar = (cfg && cfg.arena) || {};
    var out = {
      id: stageId || (stageDef && stageDef.id) || 'church',
      name: stageDef ? stageDef.name : null,
      shape: (stageDef && stageDef.shape) || 'model',
      nav: !!nav
    };
    if (nav) out.nav = true;
    if (ar.bounds) {
      out.bounds = { minX: ar.bounds.minX, maxX: ar.bounds.maxX,
                     minZ: ar.bounds.minZ, maxZ: ar.bounds.maxZ };
    } else {
      out.radius = ar.radius != null ? ar.radius : 6;
      out.cx = ar.cx || 0; out.cz = ar.cz || 0;
    }
    return out;
  }

  /* §24 verification hook: everything a "did the switch leave anything
     behind?" test needs, counted off the live scene graph rather than
     asserted. stageObjects is the node count under stageRoot; sceneChildren
     is the top level, which must not grow by one group per round. */
  A._stageCount = function () {
    if (!inited || !scene) return null;
    var objects = 0, meshes = 0, lights = 0, stageObjects = 0, stageLights = 0;
    scene.traverse(function (o) {
      objects++;
      if (o.isMesh) meshes++;
      if (o.isLight) lights++;
    });
    if (stageRoot) stageRoot.traverse(function (o) {
      stageObjects++;
      if (o.isLight) stageLights++;
    });
    var info = (renderer && renderer.info && renderer.info.memory) || null;
    return {
      stage: stageId, epoch: stageEpoch,
      objects: objects, meshes: meshes, lights: lights,
      sceneChildren: scene.children.length,
      stageObjects: stageObjects, stageLights: stageLights,
      candles: candleLights.length, rims: rimLights.length,
      shocks: shocks.length, knights: knights.length,
      listeners: listeners.length,
      colliders: ((cfg && cfg.arena && cfg.arena.colliders) || []).length,
      nav: !!nav, navCells: nav ? nav.data.length : 0,
      churchCached: !!churchGroup, churchAttached: !!(churchGroup && churchGroup.parent),
      gpu: info ? { geometries: info.geometries, textures: info.textures } : null
    };
  };

  /* test hooks (spec §13/§16: keyboard-free automated verification) */
  A._teleport = function (x, z) { pos.x = x; pos.z = z; vel.x = 0; vel.z = 0; };
  A._setCrouch = function (b) { crouchForced = !!b; };
  A._look = function (y, p) { yaw = y; if (typeof p === 'number') pitch = p; };
  /* Advance the world by dt without waiting on rAF (test hook): lets
     automated checks watch the knight walk, dash and swing. */
  A._tick = function (dt) {
    if (!inited) return null;
    dt = dt || 0.016;
    elapsed += dt;
    updatePlayer(dt);
    updateKnight(dt);
    if (fp.mixer) fp.mixer.update(dt);
    updateSignAndTornado(dt);
    updateFx(dt);
    return A.debug();
  };

  /* Where a knight's current state name lives. The BRAIN state
     (stalk | press | strafe | reposition | coil | dash | attack | recover |
     stagger | death) is the decision he made; k.anim.state is only the pose
     that decision picked, and two different decisions can wear the same pose
     — which is why the measurement counts this one. */
  function knightStateName(k) {
    if (k.brain && k.brain.state) return k.brain.state;
    return (k.anim && k.anim.state) || 'none';
  }

  /* §22 verification hook — drive the knight AI headless and MEASURE it.
     Steps `seconds` of simulated time at a fixed `dt` with no rendering and
     no player input, then reports what he actually did:
       statesEntered  {state: entries} — counted on TRANSITION, not per frame,
                      because 600 frames of 'walk' and one entry of 'walk' are
                      the same fact and only the entry count tells you whether
                      the machine is switching at all.
       stateFrames    {state: frames} — the dwell side of the same story: a
                      state entered 40 times for one frame each is a flicker
                      bug, not variety.
       distances      {min,max,avg} to the player over the run. A beeline
                      collapses min≈max≈keepDistance; a fighter's spread is
                      wide because he circles and backs off.
       positions      [[x,z],...] sampled every `sampleMs` (default 100),
                      so a caller can measure path straightness or draw it.
     NOT a dry run: it advances the real world state, exactly like _tick.
     The player does not move, which is the point — every metre of movement in
     the result is the knight's own decision. */
  A._simKnight = function (seconds, dt, opts) {
    if (!inited) return null;
    opts = opts || {};
    dt = dt || 1 / 60;
    seconds = seconds || 6;
    var k = knights[opts.index || 0];
    if (!k || !k.group) return null;
    var sampleEvery = Math.max(1, Math.round(((opts.sampleMs || 100) / 1000) / dt));
    var steps = Math.max(1, Math.round(seconds / dt));
    /* Disarm every swing still in flight before the first step, or the
       measurement is a lottery on WHEN it was called.
       A telegraph ends on a setTimeout (§16 keeps damage off rAF). This loop
       is synchronous, so no timer can possibly fire inside it — a knight who
       was mid-wind-up when the probe started stays in `attack`, rooted, for
       the entire run. Measured: a 60s call landed on a 1.5s telegraph and came
       back {attack: 1.0}, pathLength 0, which is exactly the reading this hook
       exists to DISPROVE. Whether he swings is ui/battle3d.js's business and
       is tested there; this hook measures where he puts his feet.
       Not `opts.index` only: a squadmate frozen mid-swing is a body that never
       crowds or gives ground, which quietly changes what the probed knight
       decides. */
    clearAttack();
    var entered = {}, frames = {}, animFrames = {}, positions = [];
    var last = null, dmin = Infinity, dmax = 0, dsum = 0, moved = 0;
    var px0 = k.group.position.x, pz0 = k.group.position.z;
    /* Optional: land a hit every `hitEveryMs` for `hitDamage`, through the
       REAL A.flinch, so the stagger meter, the buildup threshold and the
       flinch are measured rather than asserted. Nothing is faked — this is
       the same call ui/battle3d.js makes when an ability connects. */
    var hitEvery = opts.hitEveryMs ? Math.max(1, Math.round((opts.hitEveryMs / 1000) / dt)) : 0;
    var hitDmg = opts.hitDamage || 0;
    var hits = 0, staggers = 0, wasStaggered = false;
    for (var s = 0; s < steps; s++) {
      elapsed += dt;
      if (hitEvery && s > 0 && s % hitEvery === 0 && k.alive) {
        A.flinch(hitDmg, false, opts.index || 0);
        hits++;
      }
      updateKnight(dt);
      var name = knightStateName(k);
      if (name !== last) { entered[name] = (entered[name] || 0) + 1; last = name; }
      frames[name] = (frames[name] || 0) + 1;
      var an = (k.anim && k.anim.state) || 'none';
      animFrames[an] = (animFrames[an] || 0) + 1;
      var nowStag = !!(k.brain && k.brain.staggerT > 0);
      if (nowStag && !wasStaggered) staggers++;
      wasStaggered = nowStag;
      var dx = k.group.position.x - pos.x, dz = k.group.position.z - pos.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
      dsum += d;
      var sx = k.group.position.x - px0, sz = k.group.position.z - pz0;
      moved += Math.sqrt(sx * sx + sz * sz);
      px0 = k.group.position.x; pz0 = k.group.position.z;
      if (s % sampleEvery === 0) {
        positions.push([+k.group.position.x.toFixed(2), +k.group.position.z.toFixed(2)]);
      }
    }
    /* The headline the spec asks for: how many DISTINCT states he visited and
       what share of the run the busiest one took. "He no longer only walks
       straight at you" is those two numbers, not an opinion. */
    var share = {}, distinct = 0, topState = null, topShare = 0, nm;
    for (nm in frames) {
      distinct++;
      share[nm] = +(frames[nm] / steps).toFixed(3);
      if (share[nm] > topShare) { topShare = share[nm]; topState = nm; }
    }
    var b = k.brain;
    return {
      seconds: seconds, dt: dt, steps: steps, index: opts.index || 0,
      personality: b ? b.personality : null,
      statesEntered: entered,
      stateFrames: frames,
      stateShare: share,
      distinctStates: distinct,
      topState: topState, topShare: +topShare.toFixed(3),
      animFrames: animFrames,
      transitions: b ? b.entered : 0,
      hitsApplied: hits, staggers: staggers,
      staggerMeter: +(k.staggerMeter || 0).toFixed(1),
      pathLength: +moved.toFixed(2),
      distances: { min: +dmin.toFixed(2), max: +dmax.toFixed(2), avg: +(dsum / steps).toFixed(2) },
      positions: positions,
      playerAt: [+pos.x.toFixed(2), +pos.z.toFixed(2)]
    };
  };

  /* Geometry probe: world bounds of the loaded church and what is directly
     under/ahead of the camera. Used to verify placement without eyeballing. */
  /* Walk-probe: raycast the real church interior so `arena.bounds` can be
     checked against geometry instead of guessed. Returns, per z-slice, the
     nearest wall east/west and whether there is floor under that point. */
  A._wallScan = function (step) {
    if (!inited) return null;
    step = step || 1.0;
    var rc = new THREE.Raycaster();
    var solids = [];
    scene.traverse(function (o) { if (o.isMesh && o.userData && o.userData.isChurch) solids.push(o); });
    function cast(x, z, dx, dz) {
      rc.set(new THREE.Vector3(x, 1.1, z), new THREE.Vector3(dx, 0, dz).normalize());
      rc.far = 40;
      var h = rc.intersectObjects(solids, true);
      return h.length ? +h[0].distance.toFixed(2) : null;
    }
    function floorAt(x, z) {
      rc.set(new THREE.Vector3(x, 3.0, z), new THREE.Vector3(0, -1, 0));
      rc.far = 12;
      var h = rc.intersectObjects(solids, true);
      return h.length ? +(3.0 - h[0].distance).toFixed(2) : null;
    }
    /* Grid probe over the declared bounds: a cell is walkable when there is
       floor at ~y0 under it and nothing solid at chest height. */
    function probe(x, z) {
      rc.set(new THREE.Vector3(x, 3.0, z), new THREE.Vector3(0, -1, 0));
      rc.far = 12;
      var down = rc.intersectObjects(solids, true);
      var fy = down.length ? +(3.0 - down[0].distance).toFixed(2) : null;
      var fname = down.length ? (down[0].object.name || '?') : null;
      rc.set(new THREE.Vector3(x, 1.15, z), new THREE.Vector3(0, 1, 0));
      rc.far = 0.6;
      var up = rc.intersectObjects(solids, true);
      return { fy: fy, fname: fname, headroom: up.length ? +up[0].distance.toFixed(2) : null };
    }
    var b = (CHLOE.data.arena3d.arena && CHLOE.data.arena3d.arena.bounds) || {};
    var out = [], bad = [], good = 0;
    for (var z = b.minZ; z <= b.maxZ; z += step) {
      for (var x = b.minX; x <= b.maxX; x += step) {
        var pr = probe(x, z);
        var walk = pr.fy !== null && Math.abs(pr.fy) < 0.45 && pr.headroom === null;
        if (walk) good++;
        else bad.push(x.toFixed(1) + ',' + z.toFixed(1) + ' fy=' + pr.fy +
                      ' hit=' + pr.fname + (pr.headroom !== null ? ' HEAD' : ''));
      }
    }
    return { bounds: b, walkable: good, blocked: bad.length, blockedSample: bad.slice(0, 40) };
  };

  /* Grid is shipped as a packed bitfield so the 2.4k cells cost ~400 bytes.
     Keyed to the church placement: if the model moves, the key stops matching
     and we refuse the stale grid rather than block open floor. */
  function navKey() {
    var pl = D().church || {};
    return [D().assetVersion || 0, pl.x || 0, pl.y || 0, pl.z || 0,
            pl.rotY != null ? +pl.rotY.toFixed(4) : +(Math.PI / 2).toFixed(4)].join('|');
  }

  function loadShippedNav() {
    var d = CHLOE.data.arenaNav;
    if (!d || !d.b64) return null;
    if (d.key !== navKey()) {
      console.warn('[arena3d] baked navgrid key mismatch (' + d.key + ' vs ' + navKey() + ')');
      return null;
    }
    var bin = atob(d.b64), n = d.nx * d.nz, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
    }
    return { cell: d.cell, minX: d.minX, minZ: d.minZ, nx: d.nx, nz: d.nz, data: out };
  }

  /* Dev tool. Freezes the tab for ~a minute, then prints the contents of
     game/js/data/arena-nav.js. */
  A._bakeExport = function (cell, pad, tol) {
    var g = buildNavGrid(cell || 0.4, pad == null ? 5.0 : pad, tol);
    if (!g) return null;
    var bytes = new Uint8Array(Math.ceil(g.data.length / 8));
    for (var i = 0; i < g.data.length; i++) {
      if (g.data[i]) bytes[i >> 3] |= (1 << (i & 7));
    }
    var bin = '';
    for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
    var open = 0;
    for (var q = 0; q < g.data.length; q++) open += g.data[q];
    return { key: navKey(), cell: g.cell, minX: +g.minX.toFixed(3), minZ: +g.minZ.toFixed(3),
             nx: g.nx, nz: g.nz, walkable: open, b64: btoa(bin) };
  };

  /* What is at this cell, and why the bake accepted or rejected it. */


  A._probeAt = function (x, z) {
    var solids = [];
    scene.traverse(function (o) { if (o.isMesh && o.userData && o.userData.isChurch) solids.push(o); });
    var rc = new THREE.Raycaster();
    function describe(h) {
      var m = h.object.material;
      if (Array.isArray(m)) m = m[0];
      return { name: h.object.name || '?', dist: +h.distance.toFixed(2),
               visible: h.object.visible, transparent: !!(m && m.transparent),
               opacity: m ? m.opacity : null, side: m ? m.side : null,
               matName: m ? (m.name || '?') : null };
    }
    rc.set(new THREE.Vector3(x, 2.6, z), new THREE.Vector3(0, -1, 0)); rc.far = 6;
    var down = rc.intersectObjects(solids, true).slice(0, 4).map(describe);
    var fy = down.length ? +(2.6 - down[0].dist).toFixed(2) : null;
    rc.set(new THREE.Vector3(x, (fy || 0) + 0.15, z), new THREE.Vector3(0, 1, 0)); rc.far = 1.7;
    var up = rc.intersectObjects(solids, true).slice(0, 4).map(describe);
    return { x: x, z: z, floorY: fy, down: down, up: up,
             navFree: navFree(x, z, RADIUS), navFreeKnight: navFree(x, z, KNIGHT_RADIUS) };
  };

  A._nav = function () {
    if (!nav) return null;
    var open = 0;
    for (var q = 0; q < nav.data.length; q++) open += nav.data[q];
    return { cell: nav.cell, nx: nav.nx, nz: nav.nz, minX: nav.minX, minZ: nav.minZ,
             walkable: open, total: nav.data.length, area: arenaArea,
             free: function (x, z, r) { return navFree(x, z, r); } };
  };

  /* Rig geometry check: where each BONE actually sits in the world versus the
     limb it is supposed to swing. A big gap means the bone was measured in the
     wrong space and the limb swings on a lever, not a joint (§21's 5.9m
     shoulder). `height` is the §28 acceptance number — the knight's real
     on-screen height, which must still be 2.15m after the reparenting. */
  A._rigProbe = function (index) {
    var k = knights[index || 0];
    if (!k || !k.rig) return null;
    function r3(v) { return +v.toFixed(3); }
    var v = new THREE.Vector3(), cv = new THREE.Vector3();
    var box = new THREE.Box3().setFromObject(k.rig.root);
    var out = {
      counts: k.rigInfo || null, mode: k.atk.mode, kind: k.anim.swingKind,
      /* TWO heights, and the difference matters. `heightAtSpawn` is the §28
         acceptance number — measured once, at rest, right after the
         reparenting — and it is the one a test asserts 2.15m against.
         `heightNow` is the live bounding box, which is NOT that number and
         must not be treated as it: it is a POSED body, so a mid-stride
         measurement legitimately reads ~1.94m (the raised boot is the lowest
         point of the box, and it is 0.08m off the floor). Reading the live
         box and expecting 2.15 is the same class of mistake as §17's "Box3
         lies", one level up. */
      heightAtSpawn: (k.rigInfo && k.rigInfo.height) || null,
      heightNow: r3(box.max.y - box.min.y),
      rootScale: r3(k.rig.root.scale.x),
      moved: k.rig.moved, missingMeshes: k.rig.missing,
      swinging: k.anim.swinging, swingT: r3(k.anim.swingT),
      swingDur: r3(k.anim.swingDur), recoverDur: r3(k.anim.recoverDur),
      /* §22: swingP is the phase inside the CURRENT hit window (1.0 is its
         impact frame), not a phase over the whole pattern — a combo has three
         of them. `sched` and `feintHold` are the schedule it is walking. */
      swingP: r3(swingLocalP(k.anim)),
      sched: k.anim.sched ? k.anim.sched.map(r3) : null,
      feintHold: r3(k.anim.feintHold || 0),
      knightAt: k.group ? [r3(k.group.position.x), r3(k.group.position.z)] : null,
      yaw: k.group ? r3(k.group.rotation.y) : null,
      /* §22: whether the blade has left his hand yet. `lever` cannot answer
         that — it is measured inside the pivot's own subtree and is therefore
         rotation-invariant, so it reads the same before and after the drop.
         The mesh COUNT is what moves. */
      dropped: k.dropped ? k.dropped.length : 0,
      pivots: {}, rot: {}, lever: {}, meshes: {}
    };
    for (var key in k.rig.bones) {
      var g = k.rig.bones[key].group;
      out.pivots[key] = [r3(g.position.x), r3(g.position.y), r3(g.position.z)];
      out.rot[key] = [r3(g.rotation.x), r3(g.rotation.y), r3(g.rotation.z)];
      g.getWorldPosition(v);
      var far = 0, n = 0;
      g.traverse(function (o) {
        if (!o.isMesh) return;
        n++;
        o.getWorldPosition(cv);
        var d = cv.distanceTo(v);
        if (d > far) far = d;
      });
      out.lever[key] = r3(far);
      out.meshes[key] = n;
    }
    /* §28's acceptance number: where the POINT of the sword actually is, in
       world metres, and how far that is from the knight's own origin across
       the floor. The blade is the furthest mesh from the grip by construction
       (the generator's sword anatomy table orders them blade, collar, guard,
       grip, pommel), so "furthest under the sword bone" is the tip without
       naming a mesh. This is the number the hit volumes in data/arena3d.js
       were reconciled against — a swing whose visible tip stops a metre short
       of its own `reach` is the defect §28 B2 asks a test to catch, and it
       cannot be seen from any of the joint angles above. */
    var sw = k.rig.bones.sword;
    if (sw) {
      sw.group.getWorldPosition(v);
      var tip = null, tipD = -1;
      sw.group.traverse(function (o) {
        if (!o.isMesh) return;
        o.getWorldPosition(cv);
        var d = cv.distanceTo(v);
        if (d > tipD) { tipD = d; tip = cv.clone(); }
      });
      if (tip) {
        var ox = k.group ? k.group.position.x : 0, oz = k.group ? k.group.position.z : 0;
        out.tip = [r3(tip.x), r3(tip.y), r3(tip.z)];
        out.tipReach = r3(Math.sqrt((tip.x - ox) * (tip.x - ox) + (tip.z - oz) * (tip.z - oz)));
        out.bladeLen = r3(tipD);
        out.gripAt = [r3(v.x), r3(v.y), r3(v.z)];
      }
    }
    return out;
  };

  A._diag = function () {
    if (!inited) return null;
    var out = { eye: eyeH, pos: { x: pos.x, z: pos.z }, meshes: 0 };
    var box = new THREE.Box3();
    var found = false;
    scene.traverse(function (o) {
      if (o.isMesh && o.userData && o.userData.isChurch) {
        out.meshes++;
        box.expandByObject(o);
        found = true;
      }
    });
    if (found) out.churchBounds = { min: box.min.toArray().map(function (v) { return +v.toFixed(2); }),
                                    max: box.max.toArray().map(function (v) { return +v.toFixed(2); }) };
    var rc = new THREE.Raycaster();
    camera.updateMatrixWorld();
    rc.set(new THREE.Vector3(pos.x, eyeH, pos.z), new THREE.Vector3(0, -1, 0));
    var down = rc.intersectObjects(scene.children, true);
    out.floorBelow = down.length ? +down[0].distance.toFixed(2) : null;
    out.floorName = down.length ? (down[0].object.name || '?') : null;
    rc.set(new THREE.Vector3(pos.x, eyeH, pos.z), new THREE.Vector3(0, 1, 0));
    var up = rc.intersectObjects(scene.children, true);
    out.ceilingAbove = up.length ? +up[0].distance.toFixed(2) : null;
    if (down.length) {
      var m = down[0].object.material;
      m = Array.isArray(m) ? m[0] : m;
      out.floorMat = m ? {
        type: m.type,
        color: m.color ? '#' + m.color.getHexString() : null,
        map: !!m.map,
        rough: m.roughness, metal: m.metalness,
        envI: m.envMapIntensity,
        vis: down[0].object.visible
      } : null;
    }
    out.envMap = envMapOk;
    out.knightMats = knight.mats.slice(0, 4).map(function (m) {
      return { type: m.type, color: m.color ? '#' + m.color.getHexString() : null,
               map: !!m.map, emissive: m.emissive ? '#' + m.emissive.getHexString() : null,
               emiMap: !!m.emissiveMap, emiI: m.emissiveIntensity, metal: m.metalness };
    });
    out.lights = [];
    scene.traverse(function (o) {
      if (o.isLight) out.lights.push(o.type + ':' + (+o.intensity.toFixed(2)));
    });
    return out;
  };
  /* Draw one frame on demand — lets automated checks grab a real screenshot
     even where requestAnimationFrame is throttled (headless/background tabs). */
  A._renderOnce = function () {
    if (disabled || !inited) return false;
    camera.position.set(pos.x, eyeH, pos.z);
    camera.rotation.set(pitch, yaw, 0);
    try { renderer.render(scene, camera); return true; } catch (e) { return false; }
  };
})();
