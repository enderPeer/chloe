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
             mode: 'dead', churchLoaded: false, knightLoaded: false };
  }
  function disableAPI(reason) {
    if (reason) console.warn('[arena3d] disabled: ' + reason);
    A.init = noop; A.start = noop; A.stop = noop; A.resize = noop; A.reset = noop;
    A.telegraph = function (p, cb) { if (cb) window.setTimeout(function(){ cb({ hit: true, pattern: p }); }, 300); };
    A.flinch = noop; A.setKnightAlive = noop;
    A.debug = deadDebug; A._teleport = noop; A._setCrouch = noop;
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

  var knight = {
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
      swing: 0, swingDur: 1, swingKind: 'overhead', wound: false,
      dash: 0, dashCd: 0, dashDir: { x: 0, z: 1 }
    }
  };

  /* §17 first-person arms: the punch rig is parented to the camera with its
     head bone collapsed, so you see your own arms swing. */
  var fp = {
    root: null, mixer: null, clips: {}, action: null,
    loaded: false, headBone: null
  };
  var evadeMove = null;   // {dx, dz, t, dur} active dash
  var castingId = null;   // ability currently animating

  // attack playback
  var atk = {
    mode: 'idle',    // idle | telegraph | strike | recover
    pattern: null,
    cb: null,
    t0: 0,
    strikeTimer: null,
    lockDir: { x: 0, z: 1 },  // aim captured at windup start
    lunge: 0                  // charge lunge offset 0..1
  };

  function D() { return (CHLOE.data && CHLOE.data.arena3d) || {}; }
  /* Append the asset version so a rebuilt .glb is never served from cache. */
  function versioned(path) {
    if (!path) return path;
    var v = D().assetVersion;
    return v ? path + (path.indexOf('?') === -1 ? '?v=' : '&v=') + v : path;
  }

  // ---------------------------------------------------------------- loaders
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
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.church) { churchFallback = buildFallbackChurch(); return; }
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
      } catch (e) {
        console.warn('[arena3d] church setup failed — fallback nave', e);
        if (!churchFallback) churchFallback = buildFallbackChurch();
      }
    }, undefined, function () {
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

    var attach = function (model) {
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
            if ('envMapIntensity' in m) m.envMapIntensity = 0.2;
            // no self-glow at rest — flinch() flashes him on hit instead
            if (m.emissive) { m.emissive.setHex(0x000000); m.emissiveIntensity = 1.0; }
            knight.mats.push(m);
          }
        }
      });
      knight.model = model;
      knight.group.add(model);
      buildKnightRig(model);
      faceKnightTo(cfgSpawn().x, cfgSpawn().z);
      knightLoaded = true;
    };

    if (!loader || !models.knight) { attach(buildFallbackKnight()); return; }
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
    }, undefined, function () {
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
  function buildKnightRig(model) {
    var box = new THREE.Box3().setFromObject(model);
    var h = Math.max(0.01, box.max.y - box.min.y);
    var floorY = box.min.y;
    var mid = (box.min.x + box.max.x) / 2;

    var groups = {
      armL: { y: floorY + h * 0.80, x: mid + h * 0.13 },
      armR: { y: floorY + h * 0.80, x: mid - h * 0.13 },
      legL: { y: floorY + h * 0.48, x: mid + h * 0.06 },
      legR: { y: floorY + h * 0.48, x: mid - h * 0.06 },
      torso: { y: floorY + h * 0.50, x: mid },
      head: { y: floorY + h * 0.82, x: mid }
    };
    var rig = {};
    for (var key in groups) {
      var g = new THREE.Group();
      g.position.set(groups[key].x, groups[key].y, 0);
      g.userData.rest = g.position.clone();
      model.add(g);
      rig[key] = g;
    }

    // classify every piece, then attach() so its world transform survives
    var pieces = [];
    model.traverse(function (o) { if (o.isMesh) pieces.push(o); });
    var counts = { armL: 0, armR: 0, legL: 0, legR: 0, torso: 0, head: 0, none: 0 };
    var pb = new THREE.Box3(), c = new THREE.Vector3();

    pieces.forEach(function (m) {
      var n = (m.name || '') + ' ' + ((m.parent && m.parent.name) || '');
      pb.setFromObject(m); pb.getCenter(c);
      var right = c.x < mid;                     // model faces +Z after fitting
      var key = null;

      if (/Crown|Hood|Head_Mask|NeckStrap/i.test(n)) key = 'head';
      else if (/Shoulder|ArmStrap|Bracer|Glove|UnderShoulder|Sword/i.test(n)) {
        key = right ? 'armR' : 'armL';
      } else if (/Boot|Knee|Shin|Greave|Leg|Thigh/i.test(n)) {
        key = right ? 'legR' : 'legL';
      } else if (/Chest|Padded|Belt|Dress|Cover|Shirt|Pants/i.test(n)) key = 'torso';

      if (!key) { counts.none++; return; }
      rig[key].attach(m);
      counts[key]++;
    });

    knight.rig = rig;
    knight.rigInfo = counts;
    knight.height = h;
    console.log('[arena3d] knight rig:', JSON.stringify(counts));
  }

  function faceKnightTo(x, z) {
    if (!knight.group) return;
    var extra = (D().knight && D().knight.rotY) || 0;
    knight.baseRot = Math.atan2(x - knight.group.position.x, z - knight.group.position.z) + extra;
    knight.group.rotation.y = knight.baseRot;
  }

  // HDRI -> PMREM -> scene.environment. Gives the stone and glass real
  // image-based light; failure just leaves the rig lighting alone (§14 pattern).
  function loadEnvironment() {
    envMapOk = false;
    var path = D().hdri;
    if (!path || !THREE.RGBELoader || !THREE.PMREMGenerator) return;
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
      }, undefined, function () { bail(); });
    } catch (e) { bail(); }
  }

  function applyEnvIntensity() {
    scene.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        if ('envMapIntensity' in mats[i]) {
          mats[i].envMapIntensity = ENV_INTENSITY;
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
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.punch) return;
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
              if ('envMapIntensity' in mats[i]) mats[i].envMapIntensity = 0.06;
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
    }, undefined, function () {
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
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.handsign) return;
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
              if ('envMapIntensity' in mats[i]) mats[i].envMapIntensity = 0.06;
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
    }, undefined, function () { console.warn('[arena3d] handsign.glb missing'); });
  }

  function loadTornado() {
    var loader = makeLoader();
    var models = D().models || {};
    if (!loader || !models.tornado) return;
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
    }, undefined, function () { console.warn('[arena3d] firetornado.glb missing'); });
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
    var tx = knight.group ? knight.group.position.x : pos.x;
    var tz = knight.group ? knight.group.position.z : pos.z - 3;
    tornado.root.position.set(tx, 0, tz);
    tornado.root.visible = true;
    tornado.active = true;
    tornado.t = 0;
    tornado.dur = (durationMs || 2400) / 1000;
    return true;
  };

  function updateSignAndTornado(dt) {
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
    if (knight.group && knight.alive) {
      tornado.root.position.x += (knight.group.position.x - tornado.root.position.x) * Math.min(1, 3 * dt);
      tornado.root.position.z += (knight.group.position.z - tornado.root.position.z) * Math.min(1, 3 * dt);
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
  A.abilityHits = function (ability) {
    if (!knight.group || !knight.alive) return false;
    var dx = knight.group.position.x - pos.x;
    var dz = knight.group.position.z - pos.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > (ability.range || 2.5)) return false;
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // camera forward
    var dot = (dx * fx + dz * fz) / (dist || 1);
    return dot >= Math.cos(((ability.arc || 60) / 2) * Math.PI / 180);
  };

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
      var kx = pos.x - (knight.group ? knight.group.position.x : 0);
      var kz = pos.z - (knight.group ? knight.group.position.z : -1);
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
    loadHandSign();
    loadTornado();
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
    knight.alive = true;
    if (knight.group) {
      knight.group.position.y = 0;
      knight.group.visible = true;
      faceKnightTo(sp.x, sp.z);
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
  function onKeyDown(e) { keys[e.code] = true; if (PREVENT[e.code]) e.preventDefault(); }
  function onKeyUp(e) { keys[e.code] = false; }
  function onBlur() { keys = {}; }
  function isLocked() { return !!(canvas && document.pointerLockElement === canvas); }
  function onMouseMove(e) {
    if (!isLocked()) return;
    yaw -= (e.movementX || 0) * SENS;
    pitch -= (e.movementY || 0) * SENS;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    if (pitch < -PITCH_MAX) pitch = -PITCH_MAX;
  }
  function onClick() {
    if (!running || isLocked()) return;
    try { canvas.requestPointerLock(); } catch (e) {}
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

    // circular arena bound
    var ar = cfg.arena || { cx: 0, cz: 0, radius: 6 };
    var dx = pos.x - (ar.cx || 0), dz = pos.z - (ar.cz || 0);
    var d = Math.sqrt(dx * dx + dz * dz);
    var maxR = (ar.radius || 6) - RADIUS;
    if (d > maxR && d > 0) {
      pos.x = (ar.cx || 0) + dx / d * maxR;
      pos.z = (ar.cz || 0) + dz / d * maxR;
    }
    // keep out of the knight's personal space
    if (knight.group) {
      var kx = pos.x - knight.group.position.x, kz = pos.z - knight.group.position.z;
      var kd = Math.sqrt(kx * kx + kz * kz);
      var minD = (ar.knightMinDist || 1.3);
      if (kd < minD && kd > 0) {
        pos.x = knight.group.position.x + kx / kd * minD;
        pos.z = knight.group.position.z + kz / kd * minD;
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
  function clearAttack() {
    if (atk.strikeTimer) { window.clearTimeout(atk.strikeTimer); atk.strikeTimer = null; }
    atk.mode = 'idle'; atk.pattern = null; atk.cb = null; atk.lunge = 0;
    if (knight.model) {
      knight.model.rotation.x = 0;
      knight.model.rotation.z = 0;
    }
    if (knight.group) knight.group.position.y = 0;
  }

  /* Play one telegraphed attack. cb({hit, pattern}) fires at the strike
     moment (setTimeout — deterministic even when rAF is throttled). */
  A.telegraph = function (pattern, cb) {
    if (disabled || !inited || !pattern) { if (cb) cb({ hit: false, pattern: pattern }); return; }
    clearAttack();
    atk.mode = 'telegraph';
    atk.pattern = pattern;
    atk.cb = cb || null;
    atk.t0 = performance.now();
    // aim locked at windup start: dodge by MOVING after the windup begins
    var kx = knight.group ? knight.group.position.x : 0;
    var kz = knight.group ? knight.group.position.z : 0;
    var dx = pos.x - kx, dz = pos.z - kz;
    var d = Math.sqrt(dx * dx + dz * dz) || 1;
    atk.lockDir = { x: dx / d, z: dz / d };
    faceKnightTo(pos.x, pos.z);

    atk.strikeTimer = window.setTimeout(function () {
      atk.strikeTimer = null;
      strikeNow();
    }, pattern.telegraphMs || 1500);
  };

  function strikeNow() {
    if (atk.mode !== 'telegraph') return;
    atk.mode = 'strike';
    var pattern = atk.pattern;
    // hidden tab: the player physically cannot dodge (rAF frozen) — mercy miss
    var hit = document.hidden ? false : hitTest(pattern);
    var cb = atk.cb;
    atk.cb = null;
    // brief recover, then idle
    window.setTimeout(function () {
      if (atk.mode === 'strike') { atk.mode = 'recover'; }
      window.setTimeout(function () { if (atk.mode === 'recover') clearAttack(); },
        (pattern && pattern.recoverMs) || 800);
    }, 220);
    if (cb) {
      try { cb({ hit: hit, pattern: pattern }); } catch (e) { console.warn('[arena3d] telegraph cb failed', e); }
    }
  }

  function hitTest(pattern) {
    if (!pattern || !knight.group) return false;
    var kx = knight.group.position.x, kz = knight.group.position.z;
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

  A.flinch = function (dmg, killed) {
    if (!knight.group) return;
    if (killed) {
      knight.alive = false;
      clearAttack();
    }
    // quick emissive flash
    for (var i = 0; i < knight.mats.length; i++) {
      var m = knight.mats[i];
      if (m.emissive) { m.emissive.setHex(killed ? 0xe5173f : 0x881122); m.emissiveIntensity = 1.6; }
    }
    window.setTimeout(function () {
      for (var i = 0; i < knight.mats.length; i++) {
        var m = knight.mats[i];
        if (m.emissive) { m.emissive.setHex(0x000000); m.emissiveIntensity = 1.0; }
      }
    }, killed ? 900 : 180);
  };

  A.setKnightAlive = function (alive) {
    knight.alive = !!alive;
    if (knight.group) knight.group.visible = !!alive || knight.sinking;
  };

  // ---------------------------------------------------------------- animate
  /* §18: pose the limb pivots. `w` blends a pose in (0..1) so states can
     cross-fade instead of snapping. */
  function poseKnight(dt) {
    var r = knight.rig;
    if (!r) return;
    var t = elapsed;
    var st = knight.anim;

    // ---- targets, rebuilt each frame from the current state ----
    var armLx = 0, armRx = 0, armRz = 0, legLx = 0, legRx = 0;
    var torsoX = 0, torsoY = 0, headX = 0, bob = 0;

    var breathe = Math.sin(t * 1.6) * 0.03;
    armLx = breathe; armRx = -breathe;

    if (st.state === 'walk' || st.state === 'dash') {
      // alternating stride; dash doubles the cadence and the lean
      var fast = st.state === 'dash' ? 2.1 : 1;
      st.stride += dt * (st.state === 'dash' ? 13 : 7);
      var sw = Math.sin(st.stride);
      legLx = sw * 0.55 * fast;
      legRx = -sw * 0.55 * fast;
      armLx = -sw * 0.42 * fast;      // arms counter-swing
      armRx = sw * 0.34 * fast;
      bob = Math.abs(Math.cos(st.stride)) * 0.05 * fast;
      torsoX = (st.state === 'dash' ? 0.34 : 0.08);
      torsoY = sw * 0.09;
      headX = -torsoX * 0.5;
    }

    // ---- attack overrides the arm that holds the sword ----
    if (st.swing > 0) {
      st.swing = Math.max(0, st.swing - dt / Math.max(0.05, st.swingDur));
      var p = 1 - st.swing;                    // 0 -> 1 through the swing
      if (st.swingKind === 'overhead') {
        // raise high behind the head, then chop down past the hip
        armRx = (p < 0.45)
          ? -2.5 * (p / 0.45)                  // wind up
          : -2.5 + 3.9 * ((p - 0.45) / 0.55);  // chop
        armRz = (p < 0.45) ? -0.25 * (p / 0.45) : -0.25 + 0.25 * ((p - 0.45) / 0.55);
        torsoX = (p < 0.45) ? -0.28 * (p / 0.45) : -0.28 + 0.75 * ((p - 0.45) / 0.55);
        armLx = -armRx * 0.25;
        headX = torsoX * 0.4;
      } else {
        // wide horizontal sweep
        armRx = -0.9 + 0.6 * p;
        armRz = -1.5 + 3.0 * p;
        torsoY = -0.7 + 1.4 * p;
        armLx = 0.5 - 0.4 * p;
      }
    }

    // ---- ease everything toward the target so poses never snap ----
    var k = Math.min(1, 14 * dt);
    function ease(o, prop, target) { o[prop] += (target - o[prop]) * k; }
    ease(r.armL.rotation, 'x', armLx);
    ease(r.armR.rotation, 'x', armRx);
    ease(r.armR.rotation, 'z', armRz);
    ease(r.legL.rotation, 'x', legLx);
    ease(r.legR.rotation, 'x', legRx);
    ease(r.torso.rotation, 'x', torsoX);
    ease(r.torso.rotation, 'y', torsoY);
    ease(r.head.rotation, 'x', headX);
    knight.bob = bob;
  }

  /* §18 knight brain: always face the player, close the distance on foot,
     dash when it is off cooldown and the player is far, and swing when in
     reach. The telegraph/strike windows still come from ui/battle3d.js so
     the dodge rules of §16 are untouched. */
  function updateKnight(dt) {
    if (!knight.group) return;
    if (!knight.alive) {
      knight.group.position.y = Math.max(-2.6, knight.group.position.y - dt * 0.9);
      if (knight.light) knight.light.intensity = Math.max(0, knight.light.intensity - dt * 0.8);
      if (knight.group.position.y <= -2.55) knight.group.visible = false;
      return;
    }

    var st = knight.anim;
    var kx = knight.group.position.x, kz = knight.group.position.z;
    var dx = pos.x - kx, dz = pos.z - kz;
    var dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
    var ux = dx / dist, uz = dz / dist;

    // ---- always focus the player (except mid-swing, when the lane is locked) ----
    if (atk.mode === 'telegraph' || atk.mode === 'strike') {
      faceKnightTo(kx + atk.lockDir.x, kz + atk.lockDir.z);
    } else {
      faceKnightTo(pos.x, pos.z);
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

    // never walk into the player, never leave the arena
    var ar = cfg.arena || {};
    var minD = (ar.knightMinDist || 1.3);
    var ndx = pos.x - kx, ndz = pos.z - kz;
    var nd = Math.sqrt(ndx * ndx + ndz * ndz) || 1;
    if (nd < minD) {
      kx = pos.x - (ndx / nd) * minD;
      kz = pos.z - (ndz / nd) * minD;
    }
    var cxx = kx - (ar.cx || 0), czz = kz - (ar.cz || 0);
    var rad = Math.sqrt(cxx * cxx + czz * czz);
    var maxR = (ar.radius || 6) - 0.4;
    if (rad > maxR) { kx = (ar.cx || 0) + cxx / rad * maxR; kz = (ar.cz || 0) + czz / rad * maxR; }

    // charge pattern still lunges along its locked lane
    if (atk.mode === 'strike' && atk.pattern && atk.pattern.id === 'charge') {
      atk.lunge = Math.min(1, atk.lunge + dt * 6);
      kx += atk.lockDir.x * dt * 5.5;
      kz += atk.lockDir.z * dt * 5.5;
    } else {
      atk.lunge = Math.max(0, atk.lunge - dt * 3);
    }

    knight.group.position.x = kx;
    knight.group.position.z = kz;

    // ---- swing + glow driven by the telegraph state ----
    if (atk.mode === 'telegraph' && atk.pattern) {
      var p = Math.min(1, (performance.now() - atk.t0) / (atk.pattern.telegraphMs || 1500));
      if (!st.wound) {
        st.wound = true;
        st.swingKind = (atk.pattern.evade === 'crouch') ? 'sweep' : 'overhead';
        st.swing = 1; st.swingDur = ((atk.pattern.telegraphMs || 1500) / 1000) * 1.25;
      }
      if (knight.light) knight.light.intensity = (0.9 + p * 2.6) * LIGHT_SCALE;
    } else if (atk.mode === 'strike') {
      if (knight.light) knight.light.intensity = 3.2 * LIGHT_SCALE;
    } else {
      st.wound = false;
      if (knight.light) {
        knight.light.intensity = (0.55 + Math.sin(elapsed * 5.3) * 0.1) * LIGHT_SCALE;
      }
    }

    poseKnight(dt);
    var breathe = Math.sin(elapsed * 1.1) * 0.012;
    knight.group.position.y = (knight.bob || 0) + breathe;
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
    if (disabled || !inited || running) return;
    running = true;
    keys = {};
    vel.x = 0; vel.z = 0;
    addListeners();
    A.resize();
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  };

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
    var kx = knight.group ? knight.group.position.x : 0;
    var kz = knight.group ? knight.group.position.z : 0;
    var dx = pos.x - kx, dz = pos.z - kz;
    return {
      x: pos.x, z: pos.z, yaw: yaw, pitch: pitch,
      crouch: isCrouching(), eye: eyeH,
      knightDist: Math.sqrt(dx * dx + dz * dz),
      mode: atk.mode,
      knightAlive: knight.alive,
      churchLoaded: churchLoaded, knightLoaded: knightLoaded,
      envMap: envMapOk,
      knightRig: knight.rigInfo || null,
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
