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
     telegraph(pattern, onResult), flinch(dmg, killed), setKnightAlive(bool),
     debug(), _teleport(x, z), _setCrouch(bool)   // test hooks (§13 spirit)
   } */
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
             locked: false, squad: 0, squadAlive: 0 };
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
    A.taunt = noop;
  }

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
      turnErr: 0,                // yaw error, for the planted turnInPlace pose
      dash: 0, dashCd: 0, dashDir: { x: 0, z: 1 }
    },
    /* §22 brain: the movement state machine, its timers and this knight's
       personality. Built lazily by brainOf() because the leader is on the
       floor and walking before spawnSquad ever runs. */
    brain: null,
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

  function D() { return (CHLOE.data && CHLOE.data.arena3d) || {}; }
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

  function loadChurch() {
    assetExpect('church');
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.church) {
      churchFallback = buildFallbackChurch();
      assetDone('church', 'skipped');
      return;
    }
    // draco/network failures can stall without ever calling the error cb —
    // if nothing arrived after 12s, build the fallback nave so the arena is
    // never a void (removed again if the real church shows up late)
    var fallbackTimer = window.setTimeout(function () {
      if (!churchLoaded && !churchFallback) churchFallback = buildFallbackChurch();
    }, 12000);
    loader.load(versioned(models.church), function (gltf) {
      window.clearTimeout(fallbackTimer);
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
        scene.add(g);
        churchLoaded = true;
        if (churchFallback) { scene.remove(churchFallback); churchFallback = null; }
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
    scene.add(g);
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
      // normalize height + ground the feet, darken to "hollow black"
      var box = new THREE.Box3().setFromObject(model);
      var h = Math.max(0.01, box.max.y - box.min.y);
      var s = (kcfg.targetHeight || 2.15) / h;
      model.scale.setScalar(s);
      box.setFromObject(model);
      model.position.y -= box.min.y;
      var cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
      model.position.x -= cx; model.position.z -= cz;
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
      k.model = model;
      k.group.add(model);
      /* Take the template BEFORE rigging. knightProto used to be grabbed
         after buildKnightRig, so every clone arrived already containing a set
         of pivot groups and then had a second set bolted on - orphan groups
         nested inside orphan groups, and a rig traversal that could find the
         wrong one. */
      if (!knightProto) knightProto = model.clone(true);
      buildKnightRig(k, model);
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
        if (knight.model) { knight.group.remove(knight.model); knight.model = null; knight.mats.length = 0; }
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

  /* §18 knight rig. The model has no skeleton — it is 103 separately named
     armour pieces. Sort them into limb groups by name, split left/right by
     which side of the body they sit on, and re-parent each piece under a
     pivot placed at the matching joint. Rotating those pivots then animates
     real arms, legs and sword without any bones. */
  function buildKnightRig(k, model) {
    /* Measure in the model's OWN space, never in world.

       setFromObject() reports WORLD coordinates, but `model` is already
       parented to k.group - which sits at knight.x = 5 for the knight that
       loaded, and at the origin for a clone spawnSquad has not placed yet.
       Those world numbers were being written straight into g.position, which
       is MODEL-LOCAL. Measured: the leader's shoulder pivot ended up 5.9m
       from his own hand, so a 3.9rad overhead threw the sword across the
       nave, while a clone's landed 2.0m away and barely moved. One line, two
       opposite failures, which is why a squad looked like one windmilling
       leader and N-1 statues. */
    model.updateMatrixWorld(true);
    var toLocal = new THREE.Matrix4().copy(model.matrixWorld).invert();
    var m4 = new THREE.Matrix4(), pb = new THREE.Box3(), c = new THREE.Vector3();
    var box = new THREE.Box3();
    var bodyMinX = Infinity, bodyMaxX = -Infinity;

    /* One pass: local AABB per piece, cached with the name it gets classified
       by. Reading the name here also means a re-run on an already-rigged
       model never sees a pivot group's name in m.parent.name. */
    var pieces = [];
    model.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m4.multiplyMatrices(toLocal, o.matrixWorld);
      pb.copy(o.geometry.boundingBox).applyMatrix4(m4);
      box.union(pb);
      /* The drawn sword hangs off his right hand and drags the whole-model X
         centre across the body, which flips pieces that sit between the true
         centre and the skewed one - that is why the split came out a lopsided
         legL 9 / legR 7. Take the midline from the BODY only. */
      if (!/Sword/i.test(o.name || '')) {
        if (pb.min.x < bodyMinX) bodyMinX = pb.min.x;
        if (pb.max.x > bodyMaxX) bodyMaxX = pb.max.x;
      }
      pieces.push({ m: o, minX: pb.min.x, maxX: pb.max.x,
                    c: pb.getCenter(c).clone(),
                    n: (o.name || '') + ' ' + ((o.parent && o.parent.name) || '') });
    });
    if (!pieces.length) return;
    if (bodyMinX > bodyMaxX) { bodyMinX = box.min.x; bodyMaxX = box.max.x; }

    var h = Math.max(0.01, box.max.y - box.min.y);
    var floorY = box.min.y;
    var mid = (bodyMinX + bodyMaxX) / 2;
    var halfW = Math.max(0.02, (bodyMaxX - bodyMinX) / 2);

    /* Shoulders and hips scale off the body's own WIDTH rather than its
       height - a fraction of height put the shoulder pivots inside the chest
       on this model, which is the other half of why the arms swung like
       levers instead of hinging. */
    var groups = {
      armL:  { y: floorY + h * 0.80, x: mid + halfW * 0.72 },
      armR:  { y: floorY + h * 0.80, x: mid - halfW * 0.72 },
      legL:  { y: floorY + h * 0.48, x: mid + halfW * 0.30 },
      legR:  { y: floorY + h * 0.48, x: mid - halfW * 0.30 },
      torso: { y: floorY + h * 0.50, x: mid },
      head:  { y: floorY + h * 0.82, x: mid }
    };
    var rig = {};
    for (var key in groups) {
      var g = new THREE.Group();
      g.position.set(groups[key].x, groups[key].y, 0);
      g.userData.rest = g.position.clone();
      model.add(g);
      rig[key] = g;
    }

    var counts = { armL: 0, armR: 0, legL: 0, legR: 0, torso: 0, head: 0, none: 0 };
    pieces.forEach(function (pc) {
      var n = pc.n;
      var right = pc.c.x < mid;                  // model faces +Z, so right = -X
      var key = null;

      if (/Crown|Hood|Head_Mask|NeckStrap/i.test(n)) key = 'head';
      else if (/Shoulder|ArmStrap|Bracer|Glove|UnderShoulder|Sword/i.test(n)) {
        /* Several "arm" pieces are body harness worn ACROSS the chest - the
           shoulder yoke, the arm straps, a second sword slung over his back.
           They matched the arm regex and rode the LEFT arm, so the
           counterbalance dragged all of it through his torso on every swing.
           Anything straddling the midline is body. */
        key = (pc.minX < mid - 0.05 && pc.maxX > mid + 0.05) ? 'torso'
            : (right ? 'armR' : 'armL');
      } else if (/Boot|Knee|Shin|Greave|Leg|Thigh/i.test(n)) {
        key = right ? 'legR' : 'legL';
      } else if (/Chest|Padded|Belt|Dress|Cover|Shirt|Pants/i.test(n)) key = 'torso';

      if (!key) { counts.none++; return; }
      rig[key].attach(pc.m);
      counts[key]++;
    });

    /* Elbows. A rigid shoulder-to-blade-tip bar rotated through 3.9rad sweeps
       the tip in a circle through his own chest. The model ships an explicit
       elbow marker per side; use its centre as the joint so the blade can
       fold behind the shoulder on the wind-up and whip straight on the chop.
       Built HERE, in the rest pose - a sub-pivot created after a pose would
       bake that pose into its local matrix. */
    model.updateMatrixWorld(true);
    var FOREARM = /Elbow|ArmStrap_Rings|Bracer|Glove|Sword/i;
    ['L', 'R'].forEach(function (side) {
      var arm = rig['arm' + side];
      var elbow = new THREE.Group();
      var mark = null;
      arm.traverse(function (o) { if (o.isMesh && /Shoulder_Elbow/i.test(o.name || '')) mark = o; });
      if (mark) {
        pb.setFromObject(mark);
        pb.getCenter(c);
        arm.worldToLocal(c);
        elbow.position.copy(c);
      } else {
        elbow.position.set(0, -h * 0.16, 0);     // no marker: a forearm down
      }
      elbow.userData.rest = elbow.position.clone();
      arm.add(elbow);
      var move = [];
      arm.children.forEach(function (o) { if (o !== elbow && o.isMesh && FOREARM.test(o.name || '')) move.push(o); });
      move.forEach(function (o) { elbow.attach(o); });
      rig['elbow' + side] = elbow;
      counts['elbow' + side] = move.length;
    });

    k.rig = rig;
    k.rigInfo = counts;
    k.height = h;
    console.log('[arena3d] knight rig:', JSON.stringify(counts));
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
        k.model = clone;
        k.group.add(clone);
        buildKnightRig(k, clone);
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
      var bx = (kcfg.x || 0), bz = (kcfg.z || 5.4);
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
  function loadEnvironment() {
    assetExpect('hdri');
    envMapOk = false;
    var path = D().hdri;
    if (!path || !THREE.RGBELoader || !THREE.PMREMGenerator) { assetDone('hdri', 'skipped'); return; }
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
  function buildLights() {
    var L = D().lights || {};
    var amb = L.ambient || {};
    scene.add(new THREE.AmbientLight(amb.color != null ? amb.color : 0x5a5f6a,
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
    scene.add(moon);

    // a soft fill from the nave behind so the space reads as a room, not a pit
    var fill = L.fill || {};
    var fillLight = new THREE.HemisphereLight(
      fill.sky != null ? fill.sky : 0x8092c0,
      fill.ground != null ? fill.ground : 0x241c1e,
      (fill.intensity != null ? fill.intensity : 0.9) * LIGHT_SCALE);
    scene.add(fillLight);

    // red altar glow behind the knight
    var al = L.altar || {};
    var altar = new THREE.PointLight(al.color != null ? al.color : 0xe5173f,
      (al.intensity != null ? al.intensity : 3.2) * LIGHT_SCALE,
      al.distance || 18, al.decay || 1.5);
    altar.position.set(al.x || 0, al.y || 2.6, al.z || -5.5);
    scene.add(altar);

    // neutral keys above the arena so the knight and the aisle stay readable
    [L.key, L.key2].forEach(function (k) {
      if (!k) return;
      var kl = new THREE.PointLight(k.color != null ? k.color : 0xd8e2f2,
        (k.intensity != null ? k.intensity : 3.0) * LIGHT_SCALE,
        k.distance || 24, k.decay || 1.4);
      kl.position.set(k.x || 0, k.y || 5, k.z || 0);
      scene.add(kl);
    });

    var cands = L.candles || [];
    for (var i = 0; i < cands.length; i++) {
      var base = 1.6 * LIGHT_SCALE;
      var c = new THREE.PointLight(0xffa050, base, 8, 2);
      c.position.set(cands[i].x || 0, 1.1, cands[i].z || 0);
      c.userData.baseI = base;
      c.userData.phase = Math.random() * 10;
      scene.add(c);
      candleLights.push(c);
    }
  }
  var candleLights = [];

  function cfgSpawn() { return D().playerSpawn || { x: 0, z: 4.6, yaw: 0 }; }

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
    var fg = cfg.fog || {};
    scene.background = new THREE.Color(fg.color != null ? fg.color : 0x0d1018);
    scene.fog = new THREE.Fog(fg.color != null ? fg.color : 0x0d1018, fg.near || 14, fg.far || 70);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 200);
    camera.rotation.order = 'YXZ';

    buildLights();
    /* One shockwave ring up front so the §21 warm-up pass actually draws it.
       Built lazily it would be a new material compiled and uploaded on the
       frame of the first ground_slam, which is the exact hitch §21 exists to
       kill; the pool grows from here if two knights slam at once. */
    makeShock();
    loadEnvironment();
    loadChurch();
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
      kk.bob = 0;
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
      // put every pivot back at rest, or last round's chop comes back with him
      if (kk.rig) { for (var rk in kk.rig) kk.rig[rk].rotation.set(0, 0, 0); }
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
    if (nav) {
      /* §20: the baked stone is the arena. Resolving one axis at a time
         lets you slide along a wall or the altar instead of sticking. */
      if (!navFree(pos.x, prevZ, RADIUS)) pos.x = prevX;
      if (!navFree(pos.x, pos.z, RADIUS)) pos.z = prevZ;
      if (!navFree(pos.x, pos.z, RADIUS)) {
        /* Both axes blocked. Falling back to where you stood is only a fix
           when THAT was legal — and it often is not: the knight personal-space
           push below runs AFTER this clamp and can shove you into stone, and a
           test hook can teleport you anywhere. Then every later frame reverts
           to the same illegal cell and you are wedged for the rest of the
           fight. §22: walk out to real floor instead of freezing. */
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
    /* §20: every living knight has personal space, so a squad cannot be
       walked through and cannot all stack on the same tile. */
    var minD = (ar.knightMinDist || 1.3);
    for (var pi = 0; pi < knights.length; pi++) {
      var pk = knights[pi];
      if (!pk.alive || !pk.group) continue;
      var kx = pos.x - pk.group.position.x, kz = pos.z - pk.group.position.z;
      var kd = Math.sqrt(kx * kx + kz * kz);
      if (kd < minD && kd > 0) {
        pos.x = pk.group.position.x + kx / kd * minD;
        pos.z = pk.group.position.z + kz / kd * minD;
      }
    }

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
  function hitSchedule(pattern, holdS) {
    var out = [], i, h;
    if (pattern.hits && pattern.hits.length) {
      for (i = 0; i < pattern.hits.length; i++) {
        h = pattern.hits[i];
        out.push({ at: (h.atMs != null ? h.atMs : (pattern.telegraphMs || 1500)) / 1000,
                   power: h.power != null ? h.power : pattern.power,
                   lunge: h.lunge || 0 });
      }
    } else {
      out.push({ at: (pattern.telegraphMs || 1500) / 1000,
                 power: pattern.power, lunge: 0 });
    }
    for (i = 0; i < out.length; i++) out[i].fireAt = out[i].at + holdS;
    return out;
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
    var atk = k.atk;
    clearAttack(k);
    atk.mode = 'telegraph';
    atk.pattern = pattern;
    atk.cb = cb || null;
    atk.t0 = performance.now();
    bs.atkCd = bs.tune.attackCooldownMs / 1000;
    /* Arm the pose HERE rather than leaving it to a latch the frame loop
       notices. swingDur is telegraphMs EXACTLY - no 1.25 multiplier - which is
       what puts the visual impact on the damage frame. recoverDur folds in the
       strike window, because that is when strikeNow schedules mode='recover'. */
    var stA = k.anim;
    stA.swinging = true;
    stA.swingT = 0;
    stA.swingDur = (pattern.telegraphMs || 1500) / 1000;
    stA.recoverDur = ((pattern.recoverMs || 800) + 220) / 1000;
    var fe = pattern.feint;
    var holdS = (fe && fe.chance > 0 && Math.random() < fe.chance) ? (fe.holdMs || 0) / 1000 : 0;
    var sched = hitSchedule(pattern, holdS);
    stA.feintHold = holdS;
    stA.sched = [];
    for (var hi = 0; hi < sched.length; hi++) stA.sched.push(sched[hi].at);
    atk.hits = sched;
    /* Each pattern gets its own curve. charge is a lunging THRUST, not a chop
       (it and overhead share evade:'sidestep', so evade alone cannot tell them
       apart), and §22's two additions are named outright — falling back to the
       evade kind would have played ground_slam as an overhead chop. */
    stA.swingKind = SWINGS[pattern.id] ? pattern.id
                  : (pattern.id === 'charge') ? 'thrust'
                  : (pattern.evade === 'crouch' ? 'sweep' : 'overhead');
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
      // brief recover, then idle
      window.setTimeout(function () {
        if (atk.mode === 'strike') { atk.mode = 'recover'; }
        window.setTimeout(function () { if (atk.mode === 'recover') clearAttack(k); },
          (pattern && pattern.recoverMs) || 800);
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
      try {
        cb({ hit: hit, pattern: pattern, window: idx, windows: atk.hits.length,
             power: win.power, feint: !!k.anim.feintHold });
      } catch (e) { console.warn('[arena3d] telegraph cb failed', e); }
    }
  }

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
  function blend(o, prop, target, a) { o[prop] += (target - o[prop]) * a; }
  function lerpN(a, b, u) { return a + (b - a) * u; }
  function seg(t, a, b) { return t <= a ? 0 : (t >= b ? 1 : (t - a) / (b - a)); }
  function easeIn(u) { return u * u * u; }                      // into the hit
  function easeOut(u) { var v = 1 - u; return 1 - v * v * v; }  // into the apex

  /* Per-joint response, so the body reads as mass rather than one rigid
     object: the head LEADS (he keeps his eyes on you), the torso is heaviest,
     the legs sit between. One shared rate drove all eight channels before. */
  var RATE_ARM = 18, RATE_LEG = 16, RATE_TORSO = 10, RATE_HEAD = 22, RATE_BOB = 12;

  /* Swing shape, in fractions of telegraphMs. IMPACT IS p = 1.0 BY
     CONSTRUCTION - that is the frame the strike timer fires on, so retiming a
     pattern in data/arena3d.js retimes the picture with it.
     Returns +1 at the wound apex, -1 on the damage frame, past -1 on the
     follow-through. Anticipation (a small counter-move the wrong way), a
     decelerating wind-up, an apex you can actually READ, then the whole arc
     spent in the last 12% so the hit has a frame of its own. */
  function swingEnvelope(p) {
    if (p < 0.12) return -0.12 * easeIn(p / 0.12);                   // anticipation
    if (p < 0.78) return -0.12 + 1.12 * easeOut(seg(p, 0.12, 0.78)); // wind up
    if (p < 1.00) return (p < 0.88) ? 1                              // apex HOLD
                                    : 1 - 2 * easeIn(seg(p, 0.88, 1.00));
    if (p < 1.06) return -1 - 0.15 * seg(p, 1.00, 1.06);             // overshoot
    return -1.15;                                                     // follow-through
  }
  /* Where the envelope reaches its apex. This is a property of the CURVE
     above, not a tunable: it is the frame a feint freezes on, so if the shape
     is ever retimed this moves with it or the lie stops reading as a wind-up. */
  var SWING_APEX_P = 0.78;
  /* Amplitudes may omit a channel (nothing but ground_slam uses `bY`), and an
     undefined channel used to arrive as NaN and poison the whole pivot. */
  function swingCh(mix, w, st2, name) {
    var v = (mix >= 0) ? w[name] : st2[name];
    if (v == null) return 0;
    return mix >= 0 ? mix * v : -mix * v;
  }

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

  /* {wound} is the apex the telegraph holds, {struck} is where the blade is on
     the damage frame; the envelope owns everything between. Channels: aX/aY/aZ
     shoulder, eX elbow (RELATIVE - it is a child of the shoulder), lX off-hand,
     tX/tY torso, hX/hY head, gL/gR legs. Amplitudes are deliberately modest:
     the gambeson is ONE mesh containing both sleeves and it lives in `torso`,
     so plate travelling far from a static sleeve is the cost of a big angle. */
  var SWINGS = {
    overhead: {   // cock behind the shoulder, drive forward and down
      wound:  { aX:  1.30, aY:  0.00, aZ: -0.18, eX:  1.20, lX: -0.30, tX: -0.26, tY: -0.18, hX: -0.10, hY:  0.10, gL:  0.10, gR: -0.18 },
      struck: { aX: -0.85, aY:  0.10, aZ:  0.08, eX: -0.15, lX:  0.26, tX:  0.42, tY:  0.06, hX:  0.14, hY: -0.04, gL: -0.16, gR:  0.30 }
    },
    sweep: {      // horizontal arc at chest height - the one you CROUCH under
      wound:  { aX:  0.35, aY: -0.75, aZ: -0.55, eX:  0.85, lX: -0.25, tX: -0.10, tY: -0.55, hX: -0.04, hY:  0.30, gL:  0.08, gR: -0.14 },
      struck: { aX: -0.10, aY:  1.05, aZ: -0.30, eX: -0.10, lX:  0.35, tX:  0.18, tY:  0.60, hX:  0.06, hY: -0.25, gL: -0.12, gR:  0.22 }
    },
    thrust: {     // charge: arm cocked like a piston, body drives over the front foot
      wound:  { aX:  0.55, aY: -0.20, aZ: -0.10, eX:  1.45, lX: -0.40, tX: -0.22, tY: -0.30, hX: -0.06, hY:  0.12, gL:  0.14, gR: -0.22 },
      struck: { aX: -0.45, aY:  0.10, aZ: -0.05, eX: -0.05, lX:  0.45, tX:  0.50, tY:  0.15, hX:  0.08, hY: -0.05, gL: -0.22, gR:  0.34 }
    },
    /* §22 thrust_combo: two jabs and a step-through, ALL ON ONE CURVE — each
       hit window replays this shape inside its own slice of the schedule, so
       the jabs are the same stab played fast (300ms) and the third is the same
       stab played long. Deliberately tighter than `thrust`: a jab that winds
       up as far as a charge is not a jab, and the elbow does most of the work
       so the blade travels without the shoulder having to wheel. */
    thrust_combo: {
      wound:  { aX:  0.34, aY: -0.14, aZ: -0.06, eX:  1.60, lX: -0.20, tX: -0.14, tY: -0.24, hX: -0.03, hY:  0.09, gL:  0.10, gR: -0.15 },
      struck: { aX: -0.28, aY:  0.06, aZ: -0.03, eX: -0.12, lX:  0.28, tX:  0.36, tY:  0.12, hX:  0.05, hY: -0.03, gL: -0.18, gR:  0.28 }
    },
    /* §22 ground_slam: both hands go up on the hilt — the off-arm MIRRORS the
       sword arm (same sign, unlike every other swing here, where lX is a
       counterweight) — and the whole body comes down with it. `bY` drops the
       body itself, and both legs folding forward together is the only knee
       bend a rig with one hinge per leg can give you; without the drop he
       reads as bowing rather than smashing the floor. */
    ground_slam: {
      wound:  { aX:  1.72, aY:  0.04, aZ: -0.08, eX:  0.50, lX:  1.58, tX: -0.32, tY:  0.00, hX: -0.18, hY:  0.00, gL:  0.08, gR:  0.08, bY:  0.09 },
      struck: { aX: -1.10, aY:  0.00, aZ:  0.04, eX:  0.08, lX: -1.00, tX:  0.60, tY:  0.00, hX:  0.24, hY:  0.00, gL:  0.34, gR:  0.34, bY: -0.22 }
    }
  };
  /* Where he settles after a swing: blade up, weight back, still watching you.
     recoverMs governed NOTHING visual before - the sword arm stepped 1.4rad
     straight back to "breathe" the frame the swing clock hit zero. */
  var GUARD = { aX: 0.45, aY: -0.25, aZ: -0.35, eX: 0.75, lX: 0.15, tX: -0.08, tY: -0.20, hX: 0.02, hY: 0.10, gL: 0.02, gR: -0.06 };

  /* §18/§21: pose the limb pivots. An attack owns the whole upper body while
     it plays; walking and breathing own it otherwise. */
  function poseKnight(k, dt) {
    var r = k.rig;
    if (!r) return;
    var st = k.anim;
    var t = elapsed + st.phase;

    var b = k.brain;

    // ---- targets, rebuilt each frame from the current state ----
    var armLx = 0, armLz = 0, armRx = 0, armRy = 0, armRz = 0;
    var elbowLx = 0.18, elbowRx = 0.18;      // arms are never dead straight
    var legLx = 0, legRx = 0;
    var torsoX = 0, torsoY = 0, headX = 0, headY = 0, headZ = 0, bob = 0;

    var breathe = Math.sin(t * 1.6) * 0.03;
    armLx = breathe; armRx = -breathe;

    if (st.state === 'walk' || st.state === 'dash') {
      var fast = st.state === 'dash' ? 1.5 : 1;
      st.stride += dt * (st.state === 'dash' ? 13 : 7);
      var sw = Math.sin(st.stride);
      /* The "legs" are BOOTS - nothing above local y 0.64 is in a leg group,
         and the dress hem sits far below that, so most of the boot is behind
         a skirt that never moves. The old +/-0.55rad swung them clear of it.
         Boots peeking under a hem need very little. */
      legLx = sw * 0.28 * fast;
      legRx = -sw * 0.28 * fast;
      armLx = -sw * 0.42 * fast;
      armRx = sw * 0.34 * fast;
      elbowLx = 0.25 + sw * 0.10;
      elbowRx = 0.25 - sw * 0.10;
      bob = Math.abs(Math.cos(st.stride)) * 0.05 * fast;
      torsoX = (st.state === 'dash' ? 0.34 : 0.08);
      torsoY = sw * 0.09;
      /* headX stays 0: the pivots are SIBLINGS under `model`, not a chain, so
         the head never inherited the torso lean - the old -torsoX*0.5 was not
         counter-rotating anything, it just tipped him back while walking. */
    } else if (st.state === 'strafe') {
      /* §22 CROSSOVER SIDE GAIT. The feet go sideways and cross; the torso
         stays OPEN to you and the blade tracks you the whole way round, which
         is the difference between circling a fight and wandering off. */
      var dirS = b ? b.strafeSign : 1;
      st.stride += dt * 6;
      var sws = Math.sin(st.stride);
      legLx = sws * 0.22 + dirS * 0.10;      // the crossing foot leads
      legRx = -sws * 0.22 - dirS * 0.10;
      torsoY = -dirS * 0.26;
      torsoX = 0.04;
      armRx = 0.52 + sws * 0.06;
      armRy = -0.30 * dirS;
      armRz = -0.30;
      elbowRx = 0.85;
      armLx = 0.16; armLz = -0.12 * dirS;
      headY = dirS * 0.12;
      bob = Math.abs(Math.cos(st.stride)) * 0.03;
    } else if (st.state === 'backpedal') {
      /* §22 HEEL-FIRST RETREAT, guard high. He is giving ground on purpose,
         so the blade never leaves the space between you — a retreat with the
         sword down reads as a rout, and he is not routing. */
      st.stride += dt * 5;
      var swb = Math.sin(st.stride);
      legLx = -swb * 0.24;
      legRx = swb * 0.24;
      torsoX = -0.10;                        // weight back over the heels
      armRx = GUARD.aX + 0.35; armRy = GUARD.aY; armRz = GUARD.aZ;
      elbowRx = GUARD.eX + 0.35;
      armLx = GUARD.lX + 0.25;
      headX = -0.04;
      bob = Math.abs(Math.cos(st.stride)) * 0.025;
    } else if (st.state === 'turnInPlace') {
      /* §22 PLANT AND PIVOT past brain.turnThreshold: the feet split, the
         shoulders lead the hips round. Before this he could rotate 180° with
         his boots welded facing forward, which is why big yaw changes read as
         the whole model being spun by a hand rather than a man turning. */
      var ts = (st.turnErr > 0) ? 1 : -1;
      legLx = 0.20 * ts;
      legRx = -0.20 * ts;
      torsoY = 0.22 * ts;
      torsoX = 0.03;
      armRx = 0.40; armRz = -0.28; elbowRx = 0.70;
      armLx = 0.14;
      headY = 0.18 * ts;
    } else if (st.state === 'coil') {
      /* §22 the DASH TELL. dashTellMs of this before he launches: he drops,
         both knees fold, the blade cocks behind him — a silhouette that says
         "he is about to cross the room" from anywhere in the nave. */
      legLx = 0.30; legRx = 0.30;
      torsoX = 0.28;
      bob = -0.10;
      armRx = 0.95; armRz = -0.45; elbowRx = 1.25;
      armLx = -0.35;
      headX = -0.14;                         // eyes still up, on you
    } else if (st.state === 'taunt') {
      // §22: blade raised, off-hand open, head cocked. A beat of contempt.
      armRx = 1.45; armRy = 0.10; armRz = -0.22; elbowRx = 0.30;
      armLx = -0.28; armLz = 0.30;
      torsoX = -0.14; torsoY = 0.10;
      headX = -0.12; headZ = 0.26;
      bob = Math.sin(t * 3.1) * 0.012;
    } else if (st.state === 'idle' && b && b.state === 'press') {
      /* §22: waiting is not standing still. He shifts his weight foot to foot
         over pressSwayMs — the cheapest possible signal that he is choosing a
         moment rather than buffering. */
      var per = Math.max(0.1, b.tune.pressSwayMs / 1000);
      var sy = Math.sin(b.t * Math.PI * 2 / per);
      legLx = sy * 0.09; legRx = -sy * 0.09;
      torsoY = sy * 0.10;
      armRx = GUARD.aX * 0.6; armRz = GUARD.aZ * 0.6; elbowRx = GUARD.eX * 0.7;
      armLx = GUARD.lX;
      headY = sy * 0.06;
      bob = Math.abs(sy) * 0.012;
    }

    if (st.state === 'death' && b) {
      /* §22 DEATH, replacing the sink through the floor — which read as a
         collision bug every single time, because a body falling through stone
         is exactly what a collision bug looks like. Knees buckle, the torso
         pitches over them, the body settles; updateDeath drops the sword and
         only then starts the fade. */
      var df = Math.min(1, b.deathT / Math.max(0.1, b.tune.deathMs / 1000));
      var buckle = easeOut(seg(df, 0.00, 0.30));
      var pitchF = easeIn(seg(df, 0.22, 0.62));
      var settle = seg(df, 0.62, 0.80);
      legLx = 0.95 * buckle; legRx = 1.05 * buckle;
      torsoX = 0.55 * buckle + 0.85 * pitchF;
      torsoY = 0.12 * pitchF;
      armRx = -0.55 * buckle - 0.55 * pitchF; armRz = 0.30 * pitchF;
      elbowRx = 0.10;
      armLx = -0.30 * buckle - 0.45 * pitchF; armLz = 0.35 * pitchF;
      headX = 0.30 * buckle + 0.55 * pitchF;
      headZ = 0.18 * pitchF;
      bob = -(0.55 * buckle + 0.30 * pitchF) + 0.03 * settle;
    } else if (st.state === 'stagger' && b) {
      /* §22 STAGGER: head snapped back, arms flung wide, weight on the back
         foot. The amplitude decays with the timer so the recoil eases out
         instead of releasing him in one frame — and while this pose is up he
         is not turning, which is the whole punish window. */
      var sf = Math.max(0, Math.min(1, b.staggerT / Math.max(0.1, b.tune.staggerMs / 1000)));
      var wob = Math.sin((1 - sf) * Math.PI * 3) * 0.10 * sf;   // still finding his feet
      armLx = -0.85 * sf; armLz = 0.55 * sf;
      armRx = -0.70 * sf; armRy = 0.35 * sf; armRz = 0.60 * sf;
      elbowLx = 0.10; elbowRx = 0.15;
      torsoX = -0.42 * sf + wob;
      torsoY = 0.18 * sf;
      headX = -0.55 * sf; headZ = 0.20 * sf;
      legLx = -0.26 * sf; legRx = 0.30 * sf;
      bob = -0.05 * sf;
    } else if (st.swinging) {
      var sp = SWINGS[st.swingKind] || SWINGS.overhead;
      var w = sp.wound, sk = sp.struck;
      var mix = swingEnvelope(swingLocalP(st));
      /* recoverMs finally drives something: once the follow-through has
         landed, settle into GUARD across the pattern's own recover window.
         §22: measured off the LAST hit window, not the first, or a combo
         starts settling into guard between its own stabs. */
      var swEnd = swingEnd(st) * 1.06;
      var gu = seg(swingClock(st), swEnd, swEnd + st.recoverDur);
      armRx   = lerpN(swingCh(mix, w, sk, 'aX'), GUARD.aX, gu);
      armRy   = lerpN(swingCh(mix, w, sk, 'aY'), GUARD.aY, gu);
      armRz   = lerpN(swingCh(mix, w, sk, 'aZ'), GUARD.aZ, gu);
      elbowRx = lerpN(swingCh(mix, w, sk, 'eX'), GUARD.eX, gu);
      armLx   = lerpN(swingCh(mix, w, sk, 'lX'), GUARD.lX, gu);
      elbowLx = 0.22;
      torsoX  = lerpN(swingCh(mix, w, sk, 'tX'), GUARD.tX, gu);
      torsoY  = lerpN(swingCh(mix, w, sk, 'tY'), GUARD.tY, gu);
      headX   = lerpN(swingCh(mix, w, sk, 'hX'), GUARD.hX, gu);
      headY   = lerpN(swingCh(mix, w, sk, 'hY'), GUARD.hY, gu);
      /* Plant the front foot and roll the weight onto it through the chop.
         The legs used to be left at 0 for the whole wind-up - a stiff
         parallel stance under a winding torso. A weight shift is the cheapest
         thing there is that gives a swing mass. */
      legLx   = lerpN(swingCh(mix, w, sk, 'gL'), GUARD.gL, gu);
      legRx   = lerpN(swingCh(mix, w, sk, 'gR'), GUARD.gR, gu);
      /* `bY` is the body itself dropping. Only ground_slam uses it — a rig
         with one hinge per leg cannot bend a knee, so the smash gets its
         weight from the whole silhouette going down with the blade. */
      bob     = lerpN(swingCh(mix, w, sk, 'bY'), 0, gu);
    }

    /* §22 HIT FLASH. Every damaging blow reads, stagger or not — a hit that
       changes nothing but a number is a hit the player is not sure they
       landed. Laid OVER whatever he was doing rather than replacing it, so a
       flinch never eats a swing that is already in flight. */
    if (b && b.hitFlash > 0 && st.state !== 'stagger' && st.state !== 'death') {
      var hf = b.hitFlash / Math.max(0.02, b.tune.hitFlashMs / 1000);
      var kick = hf * hf;             // sharp on the impact frame, gone fast
      torsoX -= 0.20 * kick;
      headX -= 0.26 * kick;
      armLx -= 0.16 * kick;
      armRx -= 0.10 * kick;
      bob -= 0.03 * kick;
    }

    /* A swing curve is already shaped on a wall clock; running it through a
       ~70ms first-order lag is exactly what smeared the old impact frame
       across a fifth of the wind-up. Take it straight - but ramp INTO it over
       the first 100ms so a knight caught mid-stride does not pop - and keep
       the exponential blend for the idle/walk cross-fades it exists for. */
    var take = st.swinging ? Math.min(1, st.swingT / 0.10) : 0;
    var aUp = Math.max(alpha(RATE_ARM, dt), take);
    var aLg = Math.max(alpha(RATE_LEG, dt), take);
    var aTr = Math.max(alpha(RATE_TORSO, dt), take);
    var aHd = Math.max(alpha(RATE_HEAD, dt), take);
    blend(r.armL.rotation, 'x', armLx, aUp);
    blend(r.armL.rotation, 'z', armLz, aUp);   // §22: the off-arm flings wide
    blend(r.armR.rotation, 'x', armRx, aUp);
    blend(r.armR.rotation, 'y', armRy, aUp);
    blend(r.armR.rotation, 'z', armRz, aUp);
    if (r.elbowL) blend(r.elbowL.rotation, 'x', elbowLx, aUp);
    if (r.elbowR) blend(r.elbowR.rotation, 'x', elbowRx, aUp);
    blend(r.legL.rotation, 'x', legLx, aLg);
    blend(r.legR.rotation, 'x', legRx, aLg);
    blend(r.torso.rotation, 'x', torsoX, aTr);
    blend(r.torso.rotation, 'y', torsoY, aTr);
    blend(r.head.rotation, 'x', headX, aHd);
    blend(r.head.rotation, 'y', headY, aHd);
    blend(r.head.rotation, 'z', headZ, aHd);   // §22: the taunt's tilt, the stagger's snap
    /* bob was assigned raw, so the frame he stopped walking - or a telegraph
       forced state='idle' - the whole body dropped up to 10cm in one frame. */
    k.bob += (bob - k.bob) * alpha(RATE_BOB, dt);
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

  /* Resolve one knight's tuning ONCE, at spawn. A per-frame merge of two
     objects for every knight in a round-6 squad is pure garbage collection. */
  function buildTune(personality) {
    var src = brainCfg(), t = {}, key;
    for (key in BRAIN_DEFAULTS) t[key] = BRAIN_DEFAULTS[key];
    for (key in src) if (typeof src[key] === 'number') t[key] = src[key];
    var p = (src.personalities || {})[personality];
    for (key in p) if (typeof p[key] === 'number') t[key] = p[key];
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
      strafeSign: (Math.random() < 0.5) ? 1 : -1,
      /* stunT: the §23 slice of staggerT that came from an ability rather than
         from damage. Never longer than staggerT — it only labels it. */
      atkCd: 0, repCd: 0, staggerT: 0, stunT: 0, hitFlash: 0, deathT: 0,
      repFrom: 0, repStuck: false, comboDone: false, wantsAttack: false
    };
    k.staggerMeter = 0;
    return k.brain;
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
    if (s === 'strafe') b.strafeSign = (Math.random() < 0.5) ? 1 : -1;
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
    if (k.dropped || !k.rig || !k.rig.elbowR || !k.group) return;
    var list = [];
    k.rig.elbowR.traverse(function (o) { if (o.isMesh && /Sword/i.test(o.name || '')) list.push(o); });
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
    k.group.position.y = (k.bob || 0);
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

    var nx = kx + mvx * dt, nz = kz + mvz * dt;
    /* Circling into stone REVERSES the orbit. Without this the axis slide
       below walks him sideways into the pillar and holds him there for the
       whole strafeHoldMs, which looks exactly like a stuck AI. */
    if (b.state === 'strafe' && nav && !navFree(nx, nz, KNIGHT_RADIUS)) {
      b.strafeSign = -b.strafeSign;
      b.t = 0;
      nx = kx - mvx * dt; nz = kz - mvz * dt;
    }
    kx = nx; kz = nz;
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
    if (nav) {
      /* §20: the knight obeys the same baked stone the player does, so it
         cannot walk through the rood screen to reach you — but with his own,
         wider footprint (§22), so he does not thread gaps he plainly fills. */
      var okx = k.group.position.x, okz = k.group.position.z;
      if (!navFree(kx, okz, KNIGHT_RADIUS)) kx = okx;
      if (!navFree(kx, kz, KNIGHT_RADIUS)) kz = okz;
      if (!navFree(kx, kz, KNIGHT_RADIUS)) {
        /* §22: the old triple-revert put him back on (okx,okz) unconditionally.
           When that cell was itself illegal — squad separation shoved him into
           a pillar, the minDist push backed him into the altar — he reverted to
           it forever and stood in the wall for the rest of the fight. Revert
           only to a LEGAL previous cell; otherwise walk him out. */
        if (navFree(okx, okz, KNIGHT_RADIUS)) { kx = okx; kz = okz; }
        else {
          var kOut = navNearest(kx, kz, KNIGHT_RADIUS);
          kx = kOut.x; kz = kOut.z;
        }
      }
    } else if (ar.bounds) {
      kx = Math.max(ar.bounds.minX + 0.5, Math.min(ar.bounds.maxX - 0.5, kx));
      kz = Math.max(ar.bounds.minZ + 0.5, Math.min(ar.bounds.maxZ - 0.5, kz));
    } else {
      var cxx = kx - (ar.cx || 0), czz = kz - (ar.cz || 0);
      var rad = Math.sqrt(cxx * cxx + czz * czz);
      var maxR = (ar.radius || 6) - 0.4;
      if (rad > maxR) { kx = (ar.cx || 0) + cxx / rad * maxR; kz = (ar.cz || 0) + czz / rad * maxR; }
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

    poseKnight(k, dt);
    var breathe = Math.sin((elapsed + st.phase) * 1.1) * 0.012;
    k.group.position.y = (k.bob || 0) + breathe;
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

  function updateFx(dt) {
    for (var i = 0; i < candleLights.length; i++) {
      var c = candleLights[i];
      c.intensity = c.userData.baseI * (0.75 + 0.25 * Math.sin(elapsed * 7 + c.userData.phase) + 0.1 * Math.random());
    }
    updateShocks(dt);
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
      locked: isLocked()
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

  /* Rig geometry check: where each pivot actually sits in the world versus
     the hand/limb it is supposed to swing. A big gap means the pivot was
     measured in the wrong space and the limb swings on a lever, not a joint. */
  A._rigProbe = function (index) {
    var k = knights[index || 0];
    if (!k || !k.rig) return null;
    function r3(v) { return +v.toFixed(3); }
    var v = new THREE.Vector3(), cv = new THREE.Vector3();
    var out = {
      counts: k.rigInfo || null, mode: k.atk.mode, kind: k.anim.swingKind,
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
    for (var key in k.rig) {
      var g = k.rig[key];
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
