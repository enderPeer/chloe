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
    baseRot: 0
  };

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
    loader.load(models.church, function (gltf) {
      window.clearTimeout(fallbackTimer);
      try {
        var g = gltf.scene;
        var place = D().church || {};
        g.rotation.y = place.rotY != null ? place.rotY : Math.PI / 2;
        g.position.set(place.x || 0, place.y || 0, place.z || 0);
        g.traverse(function (o) {
          if (o.isMesh && o.material) {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              if (mats[i].map) mats[i].map.anisotropy = 4;
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

    var lcfg = (D().lights || {}).knight || {};
    knight.light = new THREE.PointLight(lcfg.color != null ? lcfg.color : 0xff2038,
      lcfg.intensity != null ? lcfg.intensity : 0.9, lcfg.distance || 6, lcfg.decay || 1.8);
    knight.light.position.set(0, 1.4, 0);
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
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) {
            var m = mats[i];
            if (m.color) m.color.multiplyScalar(0.38);           // blackened plate
            if (m.emissive) { m.emissive.setHex(0x1a020a); m.emissiveIntensity = 1.0; }
            knight.mats.push(m);
          }
        }
      });
      knight.model = model;
      knight.group.add(model);
      faceKnightTo(cfgSpawn().x, cfgSpawn().z);
      knightLoaded = true;
    };

    if (!loader || !models.knight) { attach(buildFallbackKnight()); return; }
    // stalled load safety: a totem after 12s keeps the fight visible
    var fallbackTimer = window.setTimeout(function () {
      if (!knight.model) attach(buildFallbackKnight());
    }, 12000);
    loader.load(models.knight, function (gltf) {
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

  function faceKnightTo(x, z) {
    if (!knight.group) return;
    var extra = (D().knight && D().knight.rotY) || 0;
    knight.baseRot = Math.atan2(x - knight.group.position.x, z - knight.group.position.z) + extra;
    knight.group.rotation.y = knight.baseRot;
  }

  // ---------------------------------------------------------------- build
  function buildLights() {
    var L = D().lights || {};
    var amb = L.ambient || {};
    scene.add(new THREE.AmbientLight(amb.color != null ? amb.color : 0x101018,
      amb.intensity != null ? amb.intensity : 1.4));
    var mn = L.moon || {};
    var moon = new THREE.DirectionalLight(mn.color != null ? mn.color : 0x8aa3cc,
      mn.intensity != null ? mn.intensity : 0.85);
    moon.position.set(mn.x || 4, mn.y || 9, mn.z || -3);
    scene.add(moon);
    var al = L.altar || {};
    var altar = new THREE.PointLight(al.color != null ? al.color : 0xe5173f,
      al.intensity != null ? al.intensity : 1.2, al.distance || 12, al.decay || 1.6);
    altar.position.set(al.x || 0, al.y || 2.6, al.z || -3.4);
    scene.add(altar);
    var cands = L.candles || [];
    for (var i = 0; i < cands.length; i++) {
      var c = new THREE.PointLight(0xffa050, 0.5, 5, 2);
      c.position.set(cands[i].x || 0, 1.1, cands[i].z || 0);
      c.userData.baseI = 0.5;
      c.userData.phase = Math.random() * 10;
      scene.add(c);
      candleLights.push(c);
    }
  }
  var candleLights = [];

  function cfgSpawn() { return D().playerSpawn || { x: 0, z: 4.6, yaw: Math.PI }; }

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

    scene = new THREE.Scene();
    var fg = cfg.fog || {};
    scene.background = new THREE.Color(fg.color != null ? fg.color : 0x05050a);
    scene.fog = new THREE.Fog(fg.color != null ? fg.color : 0x05050a, fg.near || 4, fg.far || 26);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 80);
    camera.rotation.order = 'YXZ';

    buildLights();
    loadChurch();
    loadKnight();
    A.reset();

    inited = true;
    A.resize();
    try { renderer.render(scene, camera); } catch (e) { renderFailed = true; }
  };

  A.reset = function () {
    var sp = cfgSpawn();
    pos.x = sp.x; pos.z = sp.z;
    vel.x = 0; vel.z = 0;
    yaw = sp.yaw != null ? sp.yaw : Math.PI;
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
    var spd = (keys.ShiftLeft || keys.ShiftRight) ? SPRINT : WALK;
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
        if (m.emissive) { m.emissive.setHex(0x1a020a); m.emissiveIntensity = 1.0; }
      }
    }, killed ? 900 : 180);
  };

  A.setKnightAlive = function (alive) {
    knight.alive = !!alive;
    if (knight.group) knight.group.visible = !!alive || knight.sinking;
  };

  // ---------------------------------------------------------------- animate
  function updateKnight(dt) {
    if (!knight.group) return;
    if (!knight.alive) {
      // sink into the floor and fade the light
      knight.group.position.y = Math.max(-2.6, knight.group.position.y - dt * 0.9);
      if (knight.light) knight.light.intensity = Math.max(0, knight.light.intensity - dt * 0.8);
      if (knight.group.position.y <= -2.55) knight.group.visible = false;
      return;
    }

    var t = elapsed;
    var breathe = Math.sin(t * 1.1) * 0.015;
    var base = 0;

    if (atk.mode === 'telegraph' && atk.pattern) {
      var p = Math.min(1, (performance.now() - atk.t0) / (atk.pattern.telegraphMs || 1500));
      // windup: rise + tilt back, red glow ramps
      base = p * 0.12;
      if (knight.model) {
        if (atk.pattern.evade === 'crouch') knight.model.rotation.z = -p * 0.5;   // side windup
        else knight.model.rotation.x = -p * 0.45;                                  // rear up
      }
      if (knight.light) knight.light.intensity = 0.9 + p * 2.2;
      // facing stays locked with the lane (set once at telegraph start) —
      // tracking the player here would lie about where the strike lands
    } else if (atk.mode === 'strike') {
      if (knight.model) {
        if (atk.pattern && atk.pattern.evade === 'crouch') knight.model.rotation.z = 0.65;
        else knight.model.rotation.x = 0.5;
      }
      if (atk.pattern && atk.pattern.id === 'charge') {
        atk.lunge = Math.min(1, atk.lunge + dt * 6);
      }
      if (knight.light) knight.light.intensity = 2.6;
    } else if (atk.mode === 'recover') {
      if (knight.model) {
        knight.model.rotation.x *= Math.max(0, 1 - dt * 5);
        knight.model.rotation.z *= Math.max(0, 1 - dt * 5);
      }
      atk.lunge = Math.max(0, atk.lunge - dt * 3);
      if (knight.light) knight.light.intensity = Math.max(0.9, knight.light.intensity - dt * 4);
    } else {
      if (knight.model) {
        knight.model.rotation.x *= Math.max(0, 1 - dt * 5);
        knight.model.rotation.z *= Math.max(0, 1 - dt * 5);
      }
      atk.lunge = Math.max(0, atk.lunge - dt * 3);
      if (knight.light) knight.light.intensity = 0.9 + Math.sin(t * 5.3) * 0.12;
    }

    var kcfg = D().knight || {};
    var lungeAmt = atk.lunge * 2.2;
    knight.group.position.x = (kcfg.x || 0) + atk.lockDir.x * lungeAmt;
    knight.group.position.z = (kcfg.z || 0) + atk.lockDir.z * lungeAmt;
    knight.group.position.y = base + breathe;
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
      locked: isLocked()
    };
  };

  /* test hooks (spec §13/§16: keyboard-free automated verification) */
  A._teleport = function (x, z) { pos.x = x; pos.z = z; vel.x = 0; vel.z = 0; };
  A._setCrouch = function (b) { crouchForced = !!b; };
})();
