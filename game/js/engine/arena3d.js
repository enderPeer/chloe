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
    A.abilityHitsBench = function () { return false; };
    A.benchDebug = function () { return []; };
    A.nearestKnightDist = function () { return 2; };
    A.releaseLock = noop; A.allowLock = noop; A.isLocked = function () { return false; };
    A.assetsReady = function () { return true; };     // nothing to wait for
    A.assetProgress = function () { return { done: 1, total: 1, warm: true }; };
    A._renderOnce = function () { return false; };
    A._look = noop; A._tick = noop;
  }

  if (!window.THREE) { disableAPI('THREE not found'); return; }

  // ---------------------------------------------------------------- constants
  var RADIUS = 0.35;
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
      dash: 0, dashCd: 0, dashDir: { x: 0, z: 1 }
    },
    // §20 per-knight attack window (battle3d schedules these staggered)
    atk: { mode: 'idle', pattern: null, cb: null, t0: 0, strikeTimer: null,
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
      var spot = navNearest(sx, sz);
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
  function easeYaw(k, target, dt) {
    if (!k || !k.group) return;
    var d = target - k.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    k.group.rotation.y += d * alpha(9, dt);
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

  // ------------------------------------------------------- §19 church benches
  var benches = [];   // [{group, x, z, rotY, alive, vx, vz, hp}]

  /* Dark oak with real grain. A FLAT matte colour does not survive this
     scene: between the ambient, the hemisphere, two directionals and the
     candle points, the combined irradiance drives any untextured diffuse
     surface to near-white after tone mapping - dark brown benches came out
     the colour of cream. Grain gives the eye detail to read and keeps the
     average albedo low enough to stay wood. */
  var woodTex = null;
  function woodTexture() {
    if (woodTex) return woodTex;
    var c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    var g = c.getContext('2d');
    g.fillStyle = '#231810';
    g.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 220; i++) {
      var y = Math.random() * 256;
      var dark = Math.random() < 0.5;
      g.strokeStyle = dark ? 'rgba(10,6,4,0.55)' : 'rgba(64,45,30,0.35)';
      g.lineWidth = 0.6 + Math.random() * 2.2;
      g.beginPath();
      g.moveTo(0, y);
      // gently wandering grain lines rather than dead-straight stripes
      for (var x = 0; x <= 256; x += 32) {
        g.lineTo(x, y + Math.sin((x + i * 13) * 0.03) * 3.5);
      }
      g.stroke();
    }
    for (var k = 0; k < 9; k++) {           // knots
      var kx = Math.random() * 256, ky = Math.random() * 256;
      var r = 3 + Math.random() * 7;
      var rg = g.createRadialGradient(kx, ky, 1, kx, ky, r);
      rg.addColorStop(0, 'rgba(8,5,3,0.85)');
      rg.addColorStop(1, 'rgba(8,5,3,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(kx, ky, r, 0, Math.PI * 2); g.fill();
    }
    woodTex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) woodTex.encoding = THREE.sRGBEncoding;
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
    woodTex.repeat.set(2, 1);
    return woodTex;
  }

  function woodMat() {
    var m = new THREE.MeshStandardMaterial({
      color: 0x6a6a6a,          // tints the map down; the grain carries the hue
      map: woodTexture(),
      roughness: 0.98,
      metalness: 0
    });
    // the arena keys are bright; unclamped IBL turns dark oak into white plastic
    m.envMapIntensity = 0.08;
    m.userData.envClamp = 0.08;   // survives applyEnvIntensity when the HDRI lands
    return m;
  }

  function buildBenches() {
    var list = D().benches || [];
    var b = D().bench || { w: 2.0, h: 0.85, d: 0.55 };
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var g = new THREE.Group();
      var mat = woodMat();
      // seat + back + two legs — reads as a pew at fight distance
      var seat = new THREE.Mesh(new THREE.BoxGeometry(b.w, 0.1, b.d), mat);
      seat.position.y = b.h * 0.55;
      g.add(seat);
      var back = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h * 0.5, 0.08), mat);
      back.position.set(0, b.h * 0.8, -b.d * 0.45);
      g.add(back);
      var legGeo = new THREE.BoxGeometry(0.12, b.h * 0.55, b.d * 0.9);
      var l1 = new THREE.Mesh(legGeo, mat); l1.position.set(-b.w * 0.42, b.h * 0.27, 0); g.add(l1);
      var l2 = new THREE.Mesh(legGeo, mat); l2.position.set(b.w * 0.42, b.h * 0.27, 0); g.add(l2);
      g.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
      g.position.set(d.x, 0, d.z);
      g.rotation.y = d.rotY || 0;
      scene.add(g);
      benches.push({ group: g, mat: mat, x: d.x, z: d.z, rotY: d.rotY || 0,
                     alive: true, vx: 0, vz: 0, hp: (D().bench || {}).hp || 1,
                     debris: null });
    }
  }

  /* Break a bench: it collapses into a flat wood pile that stays on the floor. */
  function breakBench(bn) {
    if (!bn.alive) return;
    bn.alive = false;
    var b = D().bench || { w: 2.0, d: 0.55 };
    var pile = new THREE.Group();
    var mat = woodMat();
    for (var i = 0; i < 7; i++) {
      var len = (0.5 + Math.random() * 0.8) * (b.w / 2);
      var plank = new THREE.Mesh(new THREE.BoxGeometry(len, 0.07, 0.14), mat);
      plank.position.set((Math.random() - 0.5) * b.w * 0.7, 0.035 + Math.random() * 0.06,
                         (Math.random() - 0.5) * b.d * 1.4);
      plank.rotation.y = Math.random() * Math.PI;
      plank.rotation.z = (Math.random() - 0.5) * 0.25;
      pile.add(plank);
    }
    pile.position.set(bn.group.position.x, 0, bn.group.position.z);
    pile.rotation.y = bn.group.rotation.y;
    scene.add(pile);
    bn.debris = pile;
    scene.remove(bn.group);
  }

  /* Standing benches are soft obstacles: they slow you and slide away. Returns
     the speed multiplier to apply this frame. */
  function benchPush(nx, nz, dt) {
    var cfgB = D().bench || {};
    var b = { w: cfgB.w || 2.0, d: cfgB.d || 0.55 };
    var slow = 1;
    for (var i = 0; i < benches.length; i++) {
      var bn = benches[i];
      if (!bn.alive) continue;
      var dx = nx - bn.group.position.x, dz = nz - bn.group.position.z;
      var reach = Math.max(b.w, b.d) * 0.5 + RADIUS;
      var dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < reach && dist > 0.0001) {
        slow = Math.min(slow, cfgB.slowFactor || 0.45);
        // shove it along the contact normal
        var push = (cfgB.pushSpeed || 1.9) * dt * (1 - dist / reach);
        bn.group.position.x += (dx / dist) * push;
        bn.group.position.z += (dz / dist) * push;
        bn.group.rotation.y += push * 0.35;
        // keep shoved benches inside the nave
        var bd = D().arena && D().arena.bounds;
        if (bd) {
          bn.group.position.x = Math.max(bd.minX, Math.min(bd.maxX, bn.group.position.x));
          bn.group.position.z = Math.max(bd.minZ, Math.min(bd.maxZ, bn.group.position.z));
        }
      }
    }
    return slow;
  }

  /* Did this ability's swing catch a bench? Called alongside the knight test
     so a wild swing still breaks the furniture. */
  A.abilityHitsBench = function (ability) {
    var broke = [];
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    var halfArc = Math.cos(((ability.arc || 60) / 2) * Math.PI / 180);
    for (var i = 0; i < benches.length; i++) {
      var bn = benches[i];
      if (!bn.alive) continue;
      var dx = bn.group.position.x - pos.x, dz = bn.group.position.z - pos.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > (ability.range || 2.5) + 0.6 || dist < 0.0001) continue;
      if ((dx * fx + dz * fz) / dist < halfArc) continue;
      bn.hp -= 1;
      if (bn.hp <= 0) { breakBench(bn); broke.push(i); }
    }
    return broke.length;
  };

  A.benchDebug = function () {
    return benches.map(function (b) {
      return { alive: b.alive, x: +b.group.position.x.toFixed(2), z: +b.group.position.z.toFixed(2) };
    });
  };

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
    loadEnvironment();
    loadChurch();
    loadKnight();
    loadFirstPerson();
    buildBenches();
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
      kk.bob = 0;
      // put every pivot back at rest, or last round's chop comes back with him
      if (kk.rig) { for (var rk in kk.rig) kk.rig[rk].rotation.set(0, 0, 0); }
    }
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

  /* The model's pews are baked into merged meshes and cannot be split
     (§19), so they are scenery, not collision - the interactive benches in
     data/arena3d.js are the gameplay stand-in. Left in the navgrid they
     also break it: the rows are thinner than the 0.4m grid, so cell centres
     land half on seat and half on aisle and the floor comes out speckled. */
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

  /* Can a body of RADIUS stand centred here? Samples the disc, not a point,
     so you cannot clip a shoulder through a corner. */
  function navFree(x, z) {
    if (!nav) return true;
    var g = nav, r = RADIUS * 0.8;
    var pts = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
    for (var p = 0; p < pts.length; p++) {
      var i = Math.round((x + pts[p][0] - g.minX) / g.cell);
      var j = Math.round((z + pts[p][1] - g.minZ) / g.cell);
      if (i < 0 || i >= g.nx || j < 0 || j >= g.nz) return false;
      if (!g.data[i * g.nz + j]) return false;
    }
    return true;
  }

  /* Nearest cell a body can actually stand in, searched outward in rings.
     Spawn points in data/ were authored against the old rectangle, so some
     of them sit inside the rood screen; this walks them out to real floor. */
  function navNearest(x, z) {
    if (!nav || navFree(x, z)) return { x: x, z: z };
    var step = nav.cell;
    for (var r = 1; r <= 30; r++) {
      for (var a = -r; a <= r; a++) {
        for (var b = -r; b <= r; b++) {
          if (Math.abs(a) !== r && Math.abs(b) !== r) continue;   // ring only
          var nx2 = x + a * step, nz2 = z + b * step;
          if (navFree(nx2, nz2)) return { x: nx2, z: nz2 };
        }
      }
    }
    return { x: x, z: z };
  }


  var benchSlow = 1;   // §19: set by benchPush each frame
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
    spd *= benchSlow;
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
      if (!navFree(pos.x, prevZ)) pos.x = prevX;
      if (!navFree(pos.x, pos.z)) pos.z = prevZ;
      if (!navFree(pos.x, pos.z)) { pos.x = prevX; pos.z = prevZ; }
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
    // benches are soft: pushing through one slows you and shoves it aside
    benchSlow = benchPush(pos.x, pos.z, dt);
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
    if (atk.strikeTimer) { window.clearTimeout(atk.strikeTimer); atk.strikeTimer = null; }
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
  A.telegraph = function (pattern, cb, index) {
    if (disabled || !inited || !pattern) { if (cb) cb({ hit: false, pattern: pattern }); return; }
    var k = knights[index || 0];
    if (!k || !k.alive) { if (cb) cb({ hit: false, pattern: pattern }); return; }
    var atk = k.atk;
    clearAttack(k);
    atk.mode = 'telegraph';
    atk.pattern = pattern;
    atk.cb = cb || null;
    atk.t0 = performance.now();
    /* Arm the pose HERE rather than leaving it to a latch the frame loop
       notices. swingDur is telegraphMs EXACTLY - no 1.25 multiplier - which is
       what puts the visual impact on the damage frame. recoverDur folds in the
       strike window, because that is when strikeNow schedules mode='recover'. */
    var stA = k.anim;
    stA.swinging = true;
    stA.swingT = 0;
    stA.swingDur = (pattern.telegraphMs || 1500) / 1000;
    stA.recoverDur = ((pattern.recoverMs || 800) + 220) / 1000;
    /* charge is a lunging THRUST, not a chop. It and overhead share
       evade:'sidestep', so evade alone cannot tell them apart. */
    stA.swingKind = (pattern.id === 'charge') ? 'thrust'
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

    atk.strikeTimer = window.setTimeout(function () {
      atk.strikeTimer = null;
      strikeNow(k);
    }, pattern.telegraphMs || 1500);
  };

  function strikeNow(k) {
    var atk = k.atk;
    if (atk.mode !== 'telegraph') return;
    atk.mode = 'strike';
    var pattern = atk.pattern;
    // hidden tab: the player physically cannot dodge (rAF frozen) — mercy miss
    var hit = document.hidden ? false : hitTest(k, pattern);
    var cb = atk.cb;
    atk.cb = null;
    // brief recover, then idle
    window.setTimeout(function () {
      if (atk.mode === 'strike') { atk.mode = 'recover'; }
      window.setTimeout(function () { if (atk.mode === 'recover') clearAttack(k); },
        (pattern && pattern.recoverMs) || 800);
    }, 220);
    if (cb) {
      try { cb({ hit: hit, pattern: pattern }); } catch (e) { console.warn('[arena3d] telegraph cb failed', e); }
    }
  }

  function hitTest(k, pattern) {
    if (!pattern || !k.group) return false;
    var atk = k.atk;
    var kx = k.group.position.x, kz = k.group.position.z;
    var dx = pos.x - kx, dz = pos.z - kz;
    var dist = Math.sqrt(dx * dx + dz * dz);
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
    var knight = knights[index || 0];
    if (!knight || !knight.group) return;
    if (killed) {
      knight.alive = false;
      clearAttack(knight);
    }
    // quick emissive flash
    for (var i = 0; i < knight.mats.length; i++) {
      var m = knight.mats[i];
      if (m.emissive) { m.emissive.setHex(killed ? 0xe5173f : 0x881122); m.emissiveIntensity = 1.6; }
    }
    window.setTimeout(function () {
      for (var j = 0; j < knight.mats.length; j++) {
        var mm = knight.mats[j];
        if (mm.emissive) { mm.emissive.setHex(0x000000); mm.emissiveIntensity = 1.0; }
      }
    }, killed ? 900 : 180);
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
  function swingCh(mix, w, st2, name) { return mix >= 0 ? mix * w[name] : -mix * st2[name]; }

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

    // ---- targets, rebuilt each frame from the current state ----
    var armLx = 0, armRx = 0, armRy = 0, armRz = 0;
    var elbowLx = 0.18, elbowRx = 0.18;      // arms are never dead straight
    var legLx = 0, legRx = 0;
    var torsoX = 0, torsoY = 0, headX = 0, headY = 0, bob = 0;

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
    }

    if (st.swinging) {
      var sp = SWINGS[st.swingKind] || SWINGS.overhead;
      var w = sp.wound, sk = sp.struck;
      var mix = swingEnvelope(st.swingT / Math.max(0.05, st.swingDur));
      /* recoverMs finally drives something: once the follow-through has
         landed, settle into GUARD across the pattern's own recover window. */
      var gu = seg(st.swingT, st.swingDur * 1.06, st.swingDur * 1.06 + st.recoverDur);
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
    /* bob was assigned raw, so the frame he stopped walking - or a telegraph
       forced state='idle' - the whole body dropped up to 10cm in one frame. */
    k.bob += (bob - k.bob) * alpha(RATE_BOB, dt);
  }

  /* §18 knight brain: always face the player, close the distance on foot,
     dash when it is off cooldown and the player is far, and swing when in
     reach. The telegraph/strike windows still come from ui/battle3d.js so
     the dodge rules of §16 are untouched. */
  function updateOneKnight(k, dt) {
    var atk = k.atk;
    if (!k.group) return;
    /* Rescue: a knight that somehow starts off the navgrid can never move,
       because every candidate step reverts to an illegal position. Snap it
       back onto real floor before anything else runs. */
    if (k.alive && nav && !navFree(k.group.position.x, k.group.position.z)) {
      var fix = navNearest(k.group.position.x, k.group.position.z);
      k.group.position.x = fix.x;
      k.group.position.z = fix.z;
    }
    if (!k.alive) {
      k.group.position.y = Math.max(-2.6, k.group.position.y - dt * 0.9);
      if (k.light) k.light.intensity = Math.max(0, k.light.intensity - dt * 0.8);
      if (k.group.position.y <= -2.55) k.group.visible = false;
      return;
    }

    var st = k.anim;
    var kx = k.group.position.x, kz = k.group.position.z;
    var dx = pos.x - kx, dz = pos.z - kz;
    var dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
    var ux = dx / dist, uz = dz / dist;

    // ---- always focus the player (except mid-swing, when the lane is locked) ----
    if (atk.mode === 'telegraph' || atk.mode === 'strike') {
      easeYaw(k, atk.lockYaw, dt);           // lane locked at wind-up start
    } else {
      easeYaw(k, yawTo(k, pos.x, pos.z), dt);
    }

    st.dashCd = Math.max(0, st.dashCd - dt);

    // ---- movement ----
    var cfgK = D().knight || {};
    var keep = cfgK.keepDistance || 2.0;
    var moving = false;

    if (st.dash > 0) {
      st.dash = Math.max(0, st.dash - dt);
      var dspeed = cfgK.dashSpeed || 9.5;
      kx += st.dashDir.x * dspeed * dt;
      kz += st.dashDir.z * dspeed * dt;
      st.state = 'dash';
      moving = true;
    } else if (atk.mode === 'idle' || atk.mode === 'recover') {
      if (dist > keep) {
        // dash to close a big gap, otherwise walk
        if (dist > (cfgK.dashRange || 5.0) && st.dashCd <= 0) {
          st.dash = cfgK.dashTime || 0.42;
          st.dashCd = cfgK.dashCooldown || 6.0;
          st.dashDir = { x: ux, z: uz };
          st.state = 'dash';
        } else {
          var sp = cfgK.walkSpeed || 1.5;
          kx += ux * sp * dt;
          kz += uz * sp * dt;
          st.state = 'walk';
          moving = true;
        }
      } else {
        st.state = 'idle';
      }
    } else {
      st.state = 'idle';
    }

    // §20 keep the squad from stacking into one silhouette
    for (var oi = 0; oi < knights.length; oi++) {
      var other = knights[oi];
      if (other === k || !other.alive || !other.group) continue;
      var sx = kx - other.group.position.x, sz = kz - other.group.position.z;
      var sd = Math.sqrt(sx * sx + sz * sz);
      var want = 1.5;
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
         cannot walk through the rood screen to reach you. */
      var okx = k.group.position.x, okz = k.group.position.z;
      if (!navFree(kx, okz)) kx = okx;
      if (!navFree(kx, kz)) kz = okz;
      if (!navFree(kx, kz)) { kx = okx; kz = okz; }
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

    k.group.position.x = kx;
    k.group.position.z = kz;

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
      var p = Math.min(1, st.swingT / Math.max(0.05, st.swingDur));
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

  function updateFx(dt) {
    for (var i = 0; i < candleLights.length; i++) {
      var c = candleLights[i];
      c.intensity = c.userData.baseI * (0.75 + 0.25 * Math.sin(elapsed * 7 + c.userData.phase) + 0.1 * Math.random());
    }
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
    return { x: x, z: z, floorY: fy, down: down, up: up, navFree: navFree(x, z) };
  };

  A._nav = function () {
    if (!nav) return null;
    var open = 0;
    for (var q = 0; q < nav.data.length; q++) open += nav.data[q];
    return { cell: nav.cell, nx: nav.nx, nz: nav.nz, minX: nav.minX, minZ: nav.minZ,
             walkable: open, total: nav.data.length,
             free: function (x, z) { return navFree(x, z); } };
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
      swingP: r3(k.anim.swingT / Math.max(0.05, k.anim.swingDur)),
      knightAt: k.group ? [r3(k.group.position.x), r3(k.group.position.z)] : null,
      yaw: k.group ? r3(k.group.rotation.y) : null,
      pivots: {}, rot: {}, lever: {}
    };
    for (var key in k.rig) {
      var g = k.rig[key];
      out.pivots[key] = [r3(g.position.x), r3(g.position.y), r3(g.position.z)];
      out.rot[key] = [r3(g.rotation.x), r3(g.rotation.y), r3(g.rotation.z)];
      g.getWorldPosition(v);
      var far = 0;
      g.traverse(function (o) {
        if (!o.isMesh) return;
        o.getWorldPosition(cv);
        var d = cv.distanceTo(v);
        if (d > far) far = d;
      });
      out.lever[key] = r3(far);
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
