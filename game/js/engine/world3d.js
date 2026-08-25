/* CHLOE — engine/world3d.js
   First-person 3D room (spec sections 13 + 14). Owns all Three.js logic.
   API: CHLOE.engine.world3d = { init(canvas), start(), stop(), setEnemyAlive(bool),
        onEngage(cb), resize(), debug() }  (+ optional onHover(cb) hint hook for the UI:
        cb(enemyHovered, enemyDist, tvHovered)).
   Section 14: PBR pipeline (sRGB + ACES + physicallyCorrectLights + PCFSoft shadows),
   HDRI environment via RGBELoader+PMREM, GLTF furniture with per-item textured-box
   fallback, jump, first-person hands rig, interactive TV.
   No DOM outside the given canvas + pointer lock. No UI/game-rule logic.
   Degrades safely: no THREE -> no-op API; missing/blocked textures/models/HDR ->
   flat colors / box furniture / no env map. Never crashes on asset failure.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

(function () {
  'use strict';

  var W = {};
  CHLOE.engine.world3d = W;

  function noop() {}
  function deadDebug() {
    return {
      x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0, locked: false, grounded: true,
      enemyDist: 0, enemyAlive: false, tvOn: false, envMap: false,
      handsVisible: false, stageBoard: null, stageArrow: null,
      modelsLoaded: {}, colliders: []
    };
  }
  function disableAPI(reason) {
    if (reason) console.warn('[world3d] disabled: ' + reason);
    W.init = noop; W.start = noop; W.stop = noop;
    W.setEnemyAlive = noop; W.onEngage = noop; W.onHover = noop;
    W.resetPlayer = noop; W.onPickup = noop; W.onGiftHover = noop;
    W.resize = noop; W.debug = deadDebug;
  }

  if (!window.THREE) { disableAPI('THREE not found (vendor/three.min.js missing?)'); return; }

  // ---------------------------------------------------------------- constants
  var EYE_HEIGHT = 1.6;
  var CROUCH_EYE = 0.85;      // Ctrl/C held (spec §16 controls)
  var CROUCH_MULT = 0.55;     // crouch speed factor
  var GRAB_RANGE = 2.2;       // how far a hand can reach for a pickup
  var RADIUS = 0.35;
  var WALK = 3.0, SPRINT = 5.0;
  var ACCEL_LERP = 10;                 // approach rate per second
  var TURN_RATE = 100 * Math.PI / 180; // keyboard yaw, rad/s
  var SENS = 0.0022;
  var PITCH_MAX = 80 * Math.PI / 180;
  var ENGAGE_DIST = 3.5;
  var TV_DIST = 2.5;
  /* §26: how close you must stand to work the stage board's arrows. Same
     reach as the TV, and for the same reason — a wall panel you can press
     from the far side of the room is a panel you press by accident while
     turning around. */
  var BOARD_DIST = 2.5;
  var BOB_AMP = 0.03;
  var RESPAWN_SECS = 15;
  var DISSOLVE_SECS = 0.8;
  // section 14
  var JUMP_V = 4.8, GRAVITY = -14;
  var DIP_TIME = 0.15, DIP_AMP = 0.05; // landing dip (camera + hands)
  var ENV_INTENSITY = 0.6;
  var ANISO = 4;
  // physicallyCorrectLights divides punctual/ambient response by ~PI vs the
  // legacy pipeline this room was tuned in; scale data intensities back up so
  // the room keeps its pre-v2 brightness. 1 if the flag can't be enabled.
  var LIGHT_SCALE = 1;

  // ---------------------------------------------------------------- state
  var inited = false, running = false, disabled = false;
  var canvas = null, renderer = null, scene = null, camera = null;
  var rafId = 0, lastTime = 0, elapsed = 0, renderFailed = false;
  var maxAniso = ANISO;

  var pos = { x: -2.5, z: 2 };
  var vel = { x: 0, z: 0 };
  var yaw = 0, pitch = 0, bobPhase = 0;
  // vertical / jump state (section 14)
  var yOff = 0, vy = 0, grounded = true, jumpQueued = false, dipTimer = 0;
  var keys = {};
  var colliders = [];       // [{kind,minX,maxX,minZ,maxZ}]
  var texturedMats = [];    // materials that got a map (for strip-on-failure)
  var data = null;

  var engageCb = null, hoverCb = null, engageCooldown = 0, tvCooldown = 0;
  var hovered = false, tvHovered = false, hoverGlow = 0, enemyDist = Infinity;

  var mouseNdc = null; // last unlocked mouse pos over the canvas, NDC

  var enemy = {
    mesh: null, mat: null, glow: null, light: null,
    alive: true, dissolving: false, dissolveT: 0, respawnTimer: 0,
    baseY: 1.0, baseScaleX: 1.1, baseScaleY: 1.9
  };
  // interactive TV (section 14). onMat is the animated-static ON material,
  // offMat the near-black glossy OFF material. Default OFF.
  var tv = { screenMesh: null, onMat: null, offMat: null, tex: null, light: null,
             lightBase: 0.6, on: false };
  /* §26 the stage board on the south wall. `mesh` is kept so the arrows can
     be raycast; `hover` is the arrow under the crosshair right now ('left',
     'right' or null) and `target` the stage that arrow would pick, which is
     what the HUD names before you commit to it. */
  var stageBoard = { mesh: null, hover: null, target: null };
  var stageCooldown = 0;
  var ceilLight = null, ceilBase = 1, ceilTarget = 1, ceilTimer = 0;
  var raycaster = null, ndc = null;
  var listeners = []; // [target, type, fn]

  // section 14: env map + models + hands state
  var envMapOk = false;
  var modelsLoaded = {}; // canonical id -> bool (false while loading / failed)

  /* §21 asset gate. modelsLoaded cannot answer "are we done?" - it stores
     false for BOTH still-loading and failed. This counts settled slots
     instead, so ui/room3d.js can hold the room behind a loading screen and
     warm the shaders before you are allowed to walk. */
  var roomAssets = { total: 0, done: 0, warm: false };
  function roomExpect() { roomAssets.total++; }
  function roomSettle() { roomAssets.done++; }
  var hands = { group: null, visible: false, lag: null, tmpQ: null, jumpY: 0,
                // §16: LMB closes the left hand, RMB the right
                l: null, r: null, closeL: 0, closeR: 0, targetL: 0, targetR: 0 };
  var eyeH = EYE_HEIGHT;     // lerped stand/crouch eye height (§16)
  var pickups = [];          // [{itemId,label,mesh,glow,x,y,z,taken}]
  var pickupHover = null;    // {itemId,label,dist} under the crosshair
  var grab = null;           // {hand:'l'|'r', pk, t} active grab animation
  var onPickupCb = null;

  // ---------------------------------------------------------------- helpers
  function texPath(key) {
    return (key && data && data.textures && data.textures[key]) || null;
  }

  function loadTexInto(path, onLoad, onError) {
    if (!path) { if (onError) onError(); return; }
    try {
      new THREE.TextureLoader().load(path, function (t) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
        t.anisotropy = maxAniso;
        if (onLoad) onLoad(t);
      }, undefined, function () { if (onError) onError(); });
    } catch (e) { if (onError) onError(); }
  }

  // Material with immediate flat-color fallback; texture swapped in if it loads.
  function makeMat(texKey, opts) {
    opts = opts || {};
    var fb = opts.fallback != null ? opts.fallback : 0x333333;
    var m;
    if (opts.basic) {
      m = new THREE.MeshBasicMaterial({ color: fb });
    } else {
      m = new THREE.MeshStandardMaterial({ color: fb, roughness: 0.95, metalness: 0.0 });
      m.envMapIntensity = ENV_INTENSITY;
      if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity || 0.3; }
    }
    m.userData.fb = fb;
    loadTexInto(texPath(texKey), function (t) {
      if (renderFailed) return; // GL rejected textures (file://) — stay on flat colors
      if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
      m.map = t; m.color.set(0xffffff); m.needsUpdate = true;
      texturedMats.push(m);
      if (opts.onTex) opts.onTex(t);
    });
    return m;
  }

  // Plain PBR material for untextured parts (all get the env-map intensity).
  function stdMat(params) {
    var m = new THREE.MeshStandardMaterial(params);
    m.envMapIntensity = ENV_INTENSITY;
    return m;
  }

  // file:// in some browsers lets the <img> load but throws SecurityError at
  // GL upload; if render throws, strip every map back to flat colors once.
  // Also traverses the scene so late-loading GLTF textures get stripped too.
  function stripMaps() {
    for (var i = 0; i < texturedMats.length; i++) {
      var m = texturedMats[i];
      m.map = null;
      if (m.color) m.color.setHex(m.userData.fb != null ? m.userData.fb : 0x333333);
      m.needsUpdate = true;
    }
    texturedMats.length = 0;
    if (scene) {
      scene.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var j = 0; j < mats.length; j++) {
          var mm = mats[j];
          if (!mm || mm === enemy.mat) continue;
          var changed = false;
          var slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
          for (var k = 0; k < slots.length; k++) {
            if (mm[slots[k]]) { mm[slots[k]] = null; changed = true; }
          }
          if (changed) mm.needsUpdate = true;
        }
      });
    }
    if (tv.onMat) { tv.tex = null; tv.onMat.map = null; tv.onMat.needsUpdate = true; }
    if (enemy.mat && enemy.mat.uniforms) {
      enemy.mat.uniforms.tex.value = makeFallbackEnemyTexture();
      enemy.mat.needsUpdate = true;
    }
  }

  function addCollider(kind, x, z, w, d, rotY) {
    var c = Math.abs(Math.cos(rotY || 0)), s = Math.abs(Math.sin(rotY || 0));
    var hx = c * w / 2 + s * d / 2;
    var hz = s * w / 2 + c * d / 2;
    var col = { kind: kind, minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
    colliders.push(col);
    return col;
  }

  // Shadow flags for a furniture group: solid meshes cast+receive, wall-flush
  // planes only receive (flush casters cause acne). castOK=false for the lamp:
  // its own shade/pole surrounds the shadow light and would blacken the room.
  function enableShadows(root, castOK) {
    root.traverse(function (o) {
      if (!o.isMesh) return;
      var plane = o.geometry && /Plane/.test(o.geometry.type || '');
      o.receiveShadow = true;
      o.castShadow = !!castOK && !plane;
    });
  }

  // -------------------------------------------------------- canvas textures
  function makeGlowTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,40,64,0.55)');
    gr.addColorStop(0.5, 'rgba(180,20,45,0.22)');
    gr.addColorStop(1, 'rgba(120,10,30,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  // Vague grey figure on black — keeps the luminance-key shader working when
  // the sprite jpg is missing or blocked.
  function makeFallbackEnemyTexture() {
    var c = document.createElement('canvas'); c.width = 128; c.height = 256;
    var g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 128, 256);
    var body = g.createRadialGradient(64, 130, 8, 64, 130, 60);
    body.addColorStop(0, '#8a8090'); body.addColorStop(0.7, '#3a3340'); body.addColorStop(1, '#000');
    g.fillStyle = body;
    g.beginPath(); g.ellipse(64, 140, 34, 95, 0, 0, Math.PI * 2); g.fill();
    var head = g.createRadialGradient(64, 46, 4, 64, 46, 26);
    head.addColorStop(0, '#a89aa8'); head.addColorStop(1, '#000');
    g.fillStyle = head;
    g.beginPath(); g.arc(64, 46, 24, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#100507';
    g.beginPath(); g.arc(56, 42, 4, 0, Math.PI * 2); g.arc(72, 42, 4, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  }

  // ------------------------------------------------------- photoreal pipeline
  function setupPipeline() {
    try {
      if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
      if (THREE.ACESFilmicToneMapping !== undefined) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
      }
      if ('physicallyCorrectLights' in renderer) {
        renderer.physicallyCorrectLights = true;
        LIGHT_SCALE = Math.PI;
      }
      if (renderer.shadowMap && THREE.PCFSoftShadowMap !== undefined) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
      if (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
        maxAniso = Math.min(ANISO, renderer.capabilities.getMaxAnisotropy() || 1);
      }
    } catch (e) { console.warn('[world3d] pipeline setup partial: ' + e.message); }
  }

  // HDRI -> PMREM -> scene.environment (NOT background; the room is enclosed).
  // Any failure leaves envMapOk=false and the room lit by the light rig alone.
  function loadEnvironment() {
    envMapOk = false;
    var path = data && data.hdri;
    if (!path || !THREE.RGBELoader || !THREE.PMREMGenerator) return;
    var pmrem = null;
    function bail() { if (pmrem) { try { pmrem.dispose(); } catch (e) {} pmrem = null; } }
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      new THREE.RGBELoader().load(path, function (hdrTex) {
        try {
          if (!pmrem || renderFailed) { bail(); return; }
          var rt = pmrem.fromEquirectangular(hdrTex);
          scene.environment = rt.texture;
          envMapOk = true;
        } catch (e) {
          console.warn('[world3d] env map failed: ' + e.message);
          envMapOk = false;
        }
        try { hdrTex.dispose(); } catch (e) {}
        bail();
      }, undefined, function () { bail(); }); // 404 / file:// — silent, envMap:false
    } catch (e) { bail(); }
  }

  // ---------------------------------------------------------------- build
  function buildRoom() {
    var sz = data.size;
    var wallOpts = { repeat: [2, 1], fallback: 0x3a1016 };
    var mats = [
      makeMat('wall', wallOpts),                                   // +x
      makeMat('wall', wallOpts),                                   // -x
      makeMat('ceiling', { repeat: [3, 2], fallback: 0x141317 }),  // +y
      makeMat('carpet', { repeat: [4, 3], fallback: 0x401014 }),   // -y
      makeMat('wall', wallOpts),                                   // +z
      makeMat('wall', wallOpts)                                    // -z
    ];
    for (var i = 0; i < mats.length; i++) mats[i].side = THREE.BackSide;
    var box = new THREE.Mesh(new THREE.BoxGeometry(sz.w, sz.h, sz.d), mats);
    box.position.set(0, sz.h / 2, 0);
    box.receiveShadow = true; // floor (and walls) receive the lamp shadow
    scene.add(box);

    // wall colliders (thick AABBs just outside the shell — one code path for everything)
    var hw = sz.w / 2, hd = sz.d / 2, T = 1;
    colliders.push({ kind: 'wall_w', minX: -hw - T, maxX: -hw, minZ: -hd - T, maxZ: hd + T });
    colliders.push({ kind: 'wall_e', minX: hw, maxX: hw + T, minZ: -hd - T, maxZ: hd + T });
    colliders.push({ kind: 'wall_n', minX: -hw - T, maxX: hw + T, minZ: -hd - T, maxZ: -hd });
    colliders.push({ kind: 'wall_s', minX: -hw - T, maxX: hw + T, minZ: hd, maxZ: hd + T });
  }

  // §27D: the giftbox is a solid object standing in the open floor, so it
  // collides like the furniture does — walking through the shop would read
  // as a bug long before anyone tried to click it.
  var COLLIDABLE = { vanity: 1, couch: 1, tv: 1, lamp: 1, chair: 1, giftbox: 1 };

  function buildFurniture() {
    var list = data.furniture || [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var g = new THREE.Group();
      g.position.set(f.x, 0, f.z);
      g.rotation.y = f.rotY || 0;
      scene.add(g);

      var col = null;
      if (COLLIDABLE[f.kind]) col = addCollider(f.kind, f.x, f.z, f.w, f.d, f.rotY);

      // the lamp light lives on the group regardless of model vs fallback —
      // it is the single shadow-casting light of the scene.
      if (f.kind === 'lamp') addLampLight(g, f);

      var modelPath = f.model && data.models && data.models[f.model];
      if (modelPath && THREE.GLTFLoader) {
        modelsLoaded[f.model] = false;
        roomExpect();
        loadFurnitureModel(f, g, col, modelPath);
      } else {
        if (f.model) modelsLoaded[f.model] = false;
        buildPiece(g, f);
        enableShadows(g, f.kind !== 'lamp');
      }
    }
  }

  // GLTF path (section 14): uniform-scale to targetH, floor-drop + recenter via
  // Box3, AABB collider from the scaled world Box3 (replaces the placeholder),
  // per-item fallback to the textured-box builder on ANY failure.
  function loadFurnitureModel(f, g, col, path) {
    var done = false;
    function fail() {
      if (done) return; done = true;
      modelsLoaded[f.model] = false;
      buildPiece(g, f);
      enableShadows(g, f.kind !== 'lamp');
      roomSettle();          // a failed model is still a settled one
    }
    try {
      new THREE.GLTFLoader().load(path, function (gltf) {
        if (done) return;
        try {
          var obj = (gltf && gltf.scene) || (gltf && gltf.scenes && gltf.scenes[0]);
          if (!obj) { fail(); return; }
          var box = new THREE.Box3().setFromObject(obj);
          var size = box.getSize(new THREE.Vector3());
          var s = (f.targetH || f.h || 1) / Math.max(size.y, 0.001);
          obj.scale.setScalar(s);
          box.setFromObject(obj);
          obj.position.x -= (box.min.x + box.max.x) / 2;
          obj.position.z -= (box.min.z + box.max.z) / 2;
          obj.position.y -= box.min.y; // drop to floor
          obj.traverse(function (o) {
            if (!o.isMesh) return;
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var j = 0; j < mats.length; j++) {
              var m = mats[j];
              if (!m) continue;
              if ('envMapIntensity' in m) m.envMapIntensity = ENV_INTENSITY;
              if (m.map) m.map.anisotropy = maxAniso;
            }
          });
          g.add(obj);
          enableShadows(g, f.kind !== 'lamp');
          // world AABB collider from the scaled Box3 (rotation baked in)
          g.updateMatrixWorld(true);
          var wb = new THREE.Box3().setFromObject(obj);
          if (col && isFinite(wb.min.x)) {
            col.minX = wb.min.x; col.maxX = wb.max.x;
            col.minZ = wb.min.z; col.maxZ = wb.max.z;
          }
          if (f.kind === 'tv') {
            addTvScreen(g, (data.tvScreen && data.tvScreen.model) || null, f);
          }
          done = true;
          modelsLoaded[f.model] = true;
          roomSettle();
        } catch (e) {
          console.warn('[world3d] model "' + f.model + '" setup failed: ' + e.message);
          fail();
        }
      }, undefined, fail); // 404 / file:// / parse error
    } catch (e) { fail(); }
  }

  function addLampLight(g, f) {
    var lc = (data.lights && data.lights.lamp) || {};
    var lamp = new THREE.PointLight(lc.color != null ? lc.color : 0xffb37a,
      (lc.intensity != null ? lc.intensity : 0.9) * LIGHT_SCALE,
      lc.distance || 6, lc.decay || 1.8);
    lamp.position.y = (f.targetH || f.h) * 0.9;
    if (renderer.shadowMap && renderer.shadowMap.enabled) {
      lamp.castShadow = true;
      lamp.shadow.mapSize.set(1024, 1024);
      lamp.shadow.bias = -0.005;
      lamp.shadow.camera.near = 0.1;
      lamp.shadow.camera.far = lc.distance || 6;
    }
    g.add(lamp);
  }

  // TV screen plane fitted over the tube face; cfg = {x,y,z,w,h} local to the
  // TV group ({model} block for GLTF, {fallback} block for the box TV).
  // Also creates the ON/OFF materials + the bluish flicker light. Default OFF.

  /* §19 information surfaces: the mirror shows YOU, the WEST poster shows the
     knight, the TV plays a chaptered how-to. §24 gave the SOUTH poster a job
     of its own — it is the stage board, and it announces where the next fight
     happens. Each is a CanvasTexture painted by engine/displays.js and
     refreshed when the room is entered (or, for the TV, when you click it).

     Panels are keyed by the prop's `kind` out of data/room3d.js, NEVER by its
     position in the furniture list: the two posters are the same size on the
     same kind of wall, so matching on array order would silently swap the
     dossier and the board the first time somebody reorders that list, and
     both would still look perfectly plausible hanging there. */
  var PANEL_KINDS = ['mirror', 'poster', 'poster_stage'];
  var panels = { mirror: null, poster: null, poster_stage: null,
                 stagePlan: null, tvChapter: 0, tvMat: null };

  /* forRound()/stageForRound() may hand back an id or the entry itself. */
  function stageEntry(v) {
    if (!v) return null;
    if (typeof v === 'string') return ((CHLOE.data && CHLOE.data.stages) || {})[v] || null;
    return v.id ? v : null;
  }

  /* §24: which stage the NEXT fight will use, and how many are waiting on it.
     KEEP THIS IN STEP with ui/battle3d.js resolveStage() — that is what
     actually applies the stage before the arena builds, and a board naming a
     different floor than the one you land on is the single failure that makes
     this whole feature worthless. The rules, in order:
       1. CHLOE.engine.stages.forRound(n) — the stateful selector, if it is
          there. Once it exists it owns the cycle.
       2. CHLOE.data.stagePick — the pure round -> stage half that lives in data.
       3. neither -> the church, i.e. exactly what every fight was before §24.
     All of it is gated on arena3d.setStage EXISTING, because that is the only
     thing that can move the fight: on a build without it every round is still
     in the church, and a board promising the Ring would simply be lying. */
  function nextStagePlan() {
    var round = 1, def = null;
    var pt = CHLOE.engine.party;
    var rs = pt && pt.state && pt.state.runStats;
    // combat3 bumps runStats.round the moment a round is cleared, so by the
    // time you walk back in this is already the round the board must announce.
    if (rs && rs.round > 0) round = Math.floor(rs.round);
    var a3d = CHLOE.engine.arena3d;
    if (a3d && typeof a3d.setStage === 'function') {
      var sel = CHLOE.engine.stages;
      if (sel && typeof sel.forRound === 'function') def = stageEntry(sel.forRound(round));
      var pick = !def && CHLOE.data && CHLOE.data.stagePick;
      if (pick && typeof pick.stageForRound === 'function') def = stageEntry(pick.stageForRound(round));
      else if (pick && typeof pick.forRound === 'function') def = stageEntry(pick.forRound(round));
    }
    if (!def) def = ((CHLOE.data && CHLOE.data.stages) || {}).church || null;
    return { def: def, round: round, knights: round };  // round N fields N knights (§20)
  }

  /* The canvas a panel kind paints. displays.stage() is the newest of these
     and may not be in this build's displays.js at all, so its presence is
     checked rather than assumed: with no stage() — or with nothing able to
     tell us which stage is coming — the south sheet falls back to the knight
     dossier. A redundant second poster is what hung there before §24 and it
     beats a board that says nothing, or worse, says the wrong thing. */
  function panelCanvas(D2, kind) {
    if (kind === 'mirror') return D2.mirror();
    if (kind === 'poster_stage') {
      var plan = (typeof D2.stage === 'function') ? nextStagePlan() : null;
      if (plan && plan.def) {
        try {
          var c = D2.stage(plan.def, plan.round, plan.knights);
          if (c) { panels.stagePlan = plan; return c; }
        } catch (e) {
          console.warn('[world3d] displays.stage() failed: ' + e.message);
        }
      }
      panels.stagePlan = null;   // the board is showing the dossier instead
    }
    return D2.poster();
  }

  /* --------------------------------------------------- §26 the stage picker
     The board stopped being a notice and became a CONTROL: two arrows on the
     sheet, and the floor named between them is the one the next fight uses.
     A click resolves nothing itself — it steps CHLOE.data.stagePick, which is
     the same question nextStagePlan() and ui/battle3d.resolveStage() already
     ask, so the board cannot end up promising a floor you do not land on no
     matter which of the three repaints last. */
  function stagePickData() { return (CHLOE.data && CHLOE.data.stagePick) || null; }

  /* Which arrow a ray landed on, from the poster's own UV. displays owns the
     hot-spot table because displays PAINTS the arrows; v is flipped because
     a PlaneGeometry's uv.y grows upward and a canvas' y grows down. */
  function arrowAt(hit) {
    var D2 = CHLOE.engine.displays;
    if (!hit || !hit.uv || !D2 || typeof D2.stageArrows !== 'function') return null;
    if (!panels.stagePlan) return null;   // the board fell back to the dossier
    var rects = D2.stageArrows(), u = hit.uv.x, v = 1 - hit.uv.y, k;
    for (k in rects) {
      if (!Object.prototype.hasOwnProperty.call(rects, k)) continue;
      var r = rects[k];
      if (u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1) return k;
    }
    return null;
  }

  // a ray -> {which, target} for an arrow within reach, else null
  function boardUnder(ray) {
    if (!stageBoard.mesh) return null;
    stageBoard.mesh.updateMatrixWorld();
    var hit = ray.intersectObject(stageBoard.mesh, false);
    if (!hit.length || hit[0].distance > BOARD_DIST) return null;
    var which = arrowAt(hit[0]);
    return which ? { which: which, target: arrowTarget(which) } : null;
  }

  /* The stage this arrow WOULD pick, so the HUD can name it before the click
     lands. null when data cannot say — the arrow then does nothing at all,
     rather than the room inventing a floor of its own. */
  function arrowTarget(which) {
    var pick = stagePickData();
    if (!pick || typeof pick.peek !== 'function') return null;
    var id = pick.peek(which === 'left' ? -1 : 1, nextStagePlan().round);
    var def = stageEntry(id);
    return def ? { id: def.id, name: def.name || def.id } : null;
  }

  /* Take the step and repaint the wall in the same breath: the board is the
     only feedback this click has, so a pick that does not show up on the
     sheet immediately reads as a dead button. */
  function stepStage(which) {
    var pick = stagePickData();
    if (!pick || typeof pick.cycle !== 'function') return;
    if (elapsed < stageCooldown) return;
    stageCooldown = elapsed + 0.25;
    pick.cycle(which === 'left' ? -1 : 1, nextStagePlan().round);
    if (A_refreshPanels) A_refreshPanels();
    stageBoard.target = arrowTarget(which);   // the NEXT step, off the new pick
  }

  function displayMat(kind) {
    var D2 = CHLOE.engine.displays;
    if (!D2) return null;
    var canvas = panelCanvas(D2, kind);
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    var mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.userData.kind = kind;
    mat.userData.canvas = canvas;
    panels[kind] = mat;
    return mat;
  }

  /* Repaint mirror/poster (stats change as you level) AND the stage board (the
     round moved on while you were out, so the next fight may be somewhere
     else). Redrawing into the existing canvas keeps the material and texture
     the mesh already holds — the panels must never blink out between rounds. */
  A_refreshPanels = function () {
    var D2 = CHLOE.engine.displays;
    if (!D2) return;
    PANEL_KINDS.forEach(function (k) {
      var mat = panels[k];
      if (!mat || !mat.map) return;
      var fresh = panelCanvas(D2, k);
      var ctx = mat.userData.canvas.getContext('2d');
      ctx.clearRect(0, 0, mat.userData.canvas.width, mat.userData.canvas.height);
      ctx.drawImage(fresh, 0, 0);
      mat.map.needsUpdate = true;
    });
  };
  var A_refreshPanels;

  function paintTv() {
    var D2 = CHLOE.engine.displays;
    if (!D2 || !tv.onMat) return;
    var canvas = D2.tv(panels.tvChapter);
    if (!panels.tvMat) {
      var tex = new THREE.CanvasTexture(canvas);
      if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
      panels.tvMat = tex;
      panels.tvCanvas = canvas;
      tv.onMat.map = tex;
      tv.onMat.color.setHex(0xffffff);
      tv.onMat.needsUpdate = true;
      tv.tex = null;                    // stop the static-jitter animation
    } else {
      var c2 = panels.tvCanvas.getContext('2d');
      c2.clearRect(0, 0, panels.tvCanvas.width, panels.tvCanvas.height);
      c2.drawImage(canvas, 0, 0);
      panels.tvMat.needsUpdate = true;
    }
  }

  function addTvScreen(g, cfg, f) {
    cfg = cfg || { x: 0, y: (f.h || 1) * 0.7, z: (f.d || 0.5) / 2 + 0.01, w: (f.w || 1) * 0.6, h: (f.h || 1) * 0.36 };
    tv.onMat = makeMat(f.tex || 'tv_static', {
      basic: true, fallback: 0x2a3038,
      onTex: function (t) { tv.tex = t; t.repeat.set(1, 1); }
    });
    tv.offMat = stdMat({ color: 0x050607, roughness: 0.08, metalness: 0.85 });
    tv.offMat.envMapIntensity = 0.9; // glossy dead tube catches the env map
    paintTv();
    tv.screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(cfg.w, cfg.h), tv.on ? tv.onMat : tv.offMat);
    tv.screenMesh.position.set(cfg.x, cfg.y, cfg.z);
    g.add(tv.screenMesh);

    var tc = (data.lights && data.lights.tv) || {};
    tv.lightBase = (tc.intensity != null ? tc.intensity : 0.6) * LIGHT_SCALE;
    tv.light = new THREE.PointLight(tc.color != null ? tc.color : 0x86b6ff,
      tv.lightBase, tc.distance || 4, tc.decay || 1.8);
    tv.light.position.set(cfg.x, cfg.y, cfg.z + 0.35);
    tv.light.visible = tv.on;
    g.add(tv.light);
  }

  /* §19: the TV is a programme, not a toggle. Off -> on starts at chapter 1;
     each further click turns the page; after the last chapter it switches off
     again, so one control cycles the whole guide. */
  function toggleTv() {
    if (!tv.screenMesh) return;
    if (elapsed < tvCooldown) return;
    tvCooldown = elapsed + 0.25;
    var D2 = CHLOE.engine.displays;
    var total = (D2 && D2.chapterCount) || 1;

    if (!tv.on) {
      tv.on = true;
      panels.tvChapter = 0;
    } else {
      panels.tvChapter++;
      if (panels.tvChapter >= total) { tv.on = false; panels.tvChapter = 0; }
    }
    if (tv.on) paintTv();
    tv.screenMesh.material = tv.on ? tv.onMat : tv.offMat;
    if (tv.light) tv.light.visible = tv.on;
  }

  function buildPiece(g, f) {
    var m, mesh;
    switch (f.kind) {
      case 'vanity':
        m = makeMat(f.tex, { fallback: 0x241712 });
        mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h * 0.9, f.d), m);
        mesh.position.y = f.h * 0.45;
        g.add(mesh);
        var top = new THREE.Mesh(new THREE.BoxGeometry(f.w * 1.04, f.h * 0.08, f.d * 1.08),
          stdMat({ color: 0x171012, roughness: 0.8, metalness: 0.1 }));
        top.position.y = f.h * 0.94;
        g.add(top);
        break;

      case 'mirror':
        m = displayMat('mirror') ||
            makeMat(f.tex, { fallback: 0x0b0508, emissive: 0x2a0810, emissiveIntensity: 0.55 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = 1.55;
        g.add(mesh);
        var frame = new THREE.Mesh(new THREE.BoxGeometry(f.w + 0.1, f.h + 0.1, 0.03),
          stdMat({ color: 0x1c1216, roughness: 0.9 }));
        frame.position.set(0, 1.55, -0.02);
        g.add(frame);
        break;

      case 'couch':
        m = makeMat(f.tex, { repeat: [2, 1], fallback: 0x5a1220 });
        var base = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h * 0.5, f.d), m);
        base.position.y = f.h * 0.25;
        g.add(base);
        var back = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d * 0.28), m);
        back.position.set(0, f.h * 0.5, -f.d * 0.36);
        g.add(back);
        var armGeo = new THREE.BoxGeometry(f.w * 0.12, f.h * 0.72, f.d);
        var armL = new THREE.Mesh(armGeo, m); armL.position.set(-f.w * 0.44, f.h * 0.36, 0); g.add(armL);
        var armR = new THREE.Mesh(armGeo, m); armR.position.set(f.w * 0.44, f.h * 0.36, 0); g.add(armR);
        break;

      case 'tv':
        var standH = f.h * 0.45, bodyH = f.h * 0.5;
        var stand = new THREE.Mesh(new THREE.BoxGeometry(f.w, standH, f.d),
          stdMat({ color: 0x1a1216, roughness: 0.9 }));
        stand.position.y = standH / 2;
        g.add(stand);
        var body = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.78, bodyH, f.d * 0.85),
          stdMat({ color: 0x232028, roughness: 0.7 }));
        body.position.y = standH + bodyH / 2;
        g.add(body);
        addTvScreen(g, (data.tvScreen && data.tvScreen.fallback) || null, f);
        break;

      case 'door':
        m = makeMat(f.tex, { fallback: 0x581018 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = f.h / 2;
        g.add(mesh);
        break;

      case 'lamp':
        var poleMat = stdMat({ color: 0x141114, roughness: 0.6, metalness: 0.4 });
        var foot = new THREE.Mesh(new THREE.BoxGeometry(f.w, 0.05, f.d), poleMat);
        foot.position.y = 0.025; g.add(foot);
        var pole = new THREE.Mesh(new THREE.BoxGeometry(0.05, f.h * 0.85, 0.05), poleMat);
        pole.position.y = f.h * 0.45; g.add(pole);
        var shade = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.75, f.h * 0.2, f.d * 0.75),
          stdMat({
            color: 0x7a3520, roughness: 0.9,
            emissive: 0xff9a55, emissiveIntensity: 0.6
          }));
        shade.position.y = f.h * 0.88; g.add(shade);
        // (the lamp point light is added by buildFurniture/addLampLight)
        break;

      /* Two identical sheets, two different jobs (§24): 'poster' is the knight
         dossier on the west wall, 'poster_stage' the board on the south. Same
         mesh, and the KIND — not the list position — decides what is painted
         on it, so the pair cannot be swapped by an edit to data/room3d.js. */
      case 'poster':
      case 'poster_stage':
        m = displayMat(f.kind) || makeMat(f.tex, { fallback: 0x2b2b30 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = 1.5;
        g.add(mesh);
        // §26: only the board carries arrows, so only the board is clickable
        if (f.kind === 'poster_stage') stageBoard.mesh = mesh;
        break;

      /* §27D. Primitives on purpose — no new asset, and the silhouette has to
         say "openable" from across the room: body, proud lid, a ribbon
         crossing it, a bow. The glint sprite is the one the §16 pickups wear,
         because that is the language this room already uses for "this one you
         can touch", and it brightens while you look at it (see updateHover):
         the engine may not draw DOM, so that glow IS the hint until
         ui/room3d.js — another session's file — renders one. */
      case 'giftbox':
        var giftPaper = stdMat({ color: 0x7d1230, roughness: 0.55, metalness: 0.05 });
        var giftRibbon = stdMat({ color: 0xd9c9a3, roughness: 0.35, metalness: 0.45,
                                  emissive: 0x6a5a30, emissiveIntensity: 0.35 });
        var giftBody = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h * 0.74, f.d), giftPaper);
        giftBody.position.y = f.h * 0.37;
        g.add(giftBody);
        var giftLid = new THREE.Mesh(new THREE.BoxGeometry(f.w * 1.07, f.h * 0.2, f.d * 1.07), giftPaper);
        giftLid.position.y = f.h * 0.84;
        g.add(giftLid);
        var bandX = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.13, f.h * 0.97, f.d * 1.1), giftRibbon);
        bandX.position.y = f.h * 0.48; g.add(bandX);
        var bandZ = new THREE.Mesh(new THREE.BoxGeometry(f.w * 1.1, f.h * 0.97, f.d * 0.13), giftRibbon);
        bandZ.position.y = f.h * 0.48; g.add(bandZ);
        var bowGeo = new THREE.BoxGeometry(f.w * 0.34, f.h * 0.1, f.d * 0.14);
        var bowL = new THREE.Mesh(bowGeo, giftRibbon);
        bowL.position.set(-f.w * 0.15, f.h * 0.98, 0); bowL.rotation.z = 0.55; g.add(bowL);
        var bowR = new THREE.Mesh(bowGeo, giftRibbon);
        bowR.position.set(f.w * 0.15, f.h * 0.98, 0); bowR.rotation.z = -0.55; g.add(bowR);
        var giftGlow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: makeGlowTexture(), transparent: true, opacity: 0.3,
          depthWrite: false, blending: THREE.AdditiveBlending }));
        giftGlow.scale.set(0.8, 0.8, 1);
        giftGlow.position.y = f.h * 0.62;
        g.add(giftGlow);
        // Aim targets are the real meshes (body + lid): an invisible proxy box
        // would still be walked by the shadow pass and by any future traverse.
        gift.group = g; gift.targets = [giftBody, giftLid];
        gift.glow = giftGlow; gift.ribbonMat = giftRibbon;
        break;

      /* §27E. A picture frame carrying the record board. Same construction as
         the §20 round picture (frame box, canvas floated a hair proud of it),
         so the two read as a matched pair on the wall rather than as two
         unrelated experiments. Hangs at the data-authored y. */
      case 'frame_records':
        var recY = (typeof f.y === 'number') ? f.y : 1.5;
        var recFrame = new THREE.Mesh(
          new THREE.BoxGeometry(f.w + 0.1, f.h + 0.1, 0.045),
          stdMat({ color: 0x4a3a1e, roughness: 0.8, metalness: 0.15 }));
        recFrame.position.set(0, recY, 0);
        g.add(recFrame);
        var recPic = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), recordsMaterial());
        recPic.position.set(0, recY, 0.026);
        g.add(recPic);
        break;

      default: // unknown kind (incl. chair fallback) -> plain dark box, still placed
        mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d),
          stdMat({ color: 0x221a1e, roughness: 0.95 }));
        mesh.position.y = f.h / 2;
        g.add(mesh);
    }
  }

  /* --------------------------------------------------------- round picture
     §20. ONE framed picture on the dressing-room wall, and it always shows
     the round you are standing in. It is repainted between fights rather
     than joined by a second frame — a row of pictures accumulating down the
     wall buried the number that actually matters. The record of what you
     have already put down lives in small print underneath it.

     Hung on the east wall above the couch, at eye height, big enough to read
     from the middle of the room. Run-scoped like everything else (§15). */
  var trophyGroup = null;
  var trophyMat = null;    // kept so the canvas can be repainted in place

  var TROPHY_SPOT = { x: 3.93, y: 1.72, z: 0.4, rotY: -Math.PI / 2 };

  function buildTrophies() {
    var D2 = CHLOE.engine.displays;
    if (!D2 || !D2.trophy) return;

    // already built: repaint the canvas instead of rebuilding the mesh, so
    // the frame never flickers out and back between rounds
    if (trophyGroup && trophyMat && trophyMat.userData.canvas) {
      var fresh = D2.trophy();
      var ctx = trophyMat.userData.canvas.getContext('2d');
      ctx.clearRect(0, 0, trophyMat.userData.canvas.width, trophyMat.userData.canvas.height);
      ctx.drawImage(fresh, 0, 0);
      trophyMat.map.needsUpdate = true;
      return;
    }

    trophyGroup = new THREE.Group();
    trophyGroup.position.set(TROPHY_SPOT.x, TROPHY_SPOT.y, TROPHY_SPOT.z);
    trophyGroup.rotation.y = TROPHY_SPOT.rotY;

    var PW = 0.86, PH = 1.15;   // 3:4, matching the 384x512 canvas

    // frame first, picture floated a hair proud of it
    var frame = new THREE.Mesh(
      new THREE.BoxGeometry(PW + 0.09, PH + 0.09, 0.04),
      stdMat({ color: 0x3a2a1c, roughness: 0.85, metalness: 0.05 }));
    frame.position.z = 0.02;
    trophyGroup.add(frame);

    var canvas = D2.trophy();
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    trophyMat = new THREE.MeshBasicMaterial({ map: tex });
    trophyMat.userData.canvas = canvas;
    var pic = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), trophyMat);
    pic.position.z = 0.043;
    trophyGroup.add(pic);

    scene.add(trophyGroup);
  }

  /* ------------------------------------------- §27D/E giftbox + record board
     Two props that front two modules written in PARALLEL with this file:
     ui/shop.js (the counter) and engine/records.js (the top-10 canvas).
     Neither is allowed to be assumed present. A build without them must still
     get a box and a framed picture on the wall — inert, but there — because
     an exception thrown out of buildFurniture takes the whole room down with
     it, and a missing prop is a feature that silently never shipped (§24's
     lesson). Both are matched by KIND out of data/room3d.js, never by their
     position in the furniture list, for the same reason the two posters are.

     The pause/resume of the room on open is NOT this file's business: the
     overlay drives ui/room3d.js's _pause/_resume itself. world3d must never
     stop() its own loop here — nothing in this file would start it again, and
     a stopped room with no resume path is exactly the §22 freeze. */
  var GIFT_DIST = 3.0;          // crosshair range at which the box is clickable
  var gift = { group: null, targets: null, glow: null, ribbonMat: null,
               hovered: false, warned: false };
  var giftCooldown = 0;
  var giftHover = null;         // {label, dist} while the box is under the aim
  var giftHoverCb = null;
  var recBoard = { mat: null, canvas: null, live: false };

  function openShop() {
    if (elapsed < giftCooldown) return;    // one open per click, not per frame
    giftCooldown = elapsed + 0.4;
    var S = CHLOE.ui && CHLOE.ui.shop;
    if (!S || typeof S.open !== 'function') {
      if (!gift.warned) {
        gift.warned = true;
        console.warn('[world3d] ui/shop.js not loaded — the giftbox stays shut.');
      }
      return;
    }
    try { S.open(); } catch (e) {
      console.warn('[world3d] shop.open() failed: ' + e.message);
    }
  }

  // The records canvas, or null on a build without engine/records.js.
  function recordsCanvas() {
    var R = CHLOE.engine && CHLOE.engine.records;
    if (!R || typeof R.board !== 'function') return null;
    try { return R.board(); } catch (e) {
      console.warn('[world3d] records.board() failed: ' + e.message);
      return null;
    }
  }

  /* Draw the board into the canvas the material ALREADY holds — same rule as
     the wall panels: the picture must never blink out between rounds. We own
     that canvas rather than adopting records.board()'s, so a frame that was
     hung inert (module absent, or absent at build time) upgrades itself the
     first time a repaint finds the module, instead of staying dead forever. */
  function paintRecords() {
    if (!recBoard.mat || !recBoard.canvas) return;
    var fresh = recordsCanvas();
    if (!fresh) return;                    // inert: keep the dark ground
    var ctx = recBoard.canvas.getContext('2d');
    ctx.clearRect(0, 0, recBoard.canvas.width, recBoard.canvas.height);
    ctx.drawImage(fresh, 0, 0, recBoard.canvas.width, recBoard.canvas.height);
    if (recBoard.mat.map) recBoard.mat.map.needsUpdate = true;
    recBoard.live = true;
  }

  function recordsMaterial() {
    // 512x700 is records.board()'s own size and the posters' portrait shape.
    var c = document.createElement('canvas');
    c.width = 512; c.height = 700;
    var g2 = c.getContext('2d');
    g2.fillStyle = '#0a0a0c'; g2.fillRect(0, 0, c.width, c.height);
    recBoard.canvas = c;
    var tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    recBoard.mat = new THREE.MeshBasicMaterial({ map: tex });
    paintRecords();                        // fills it in when records.js is here
    return recBoard.mat;
  }

  function buildLights() {
    var L = data.lights || {};
    var amb = L.ambient || {};
    scene.add(new THREE.AmbientLight(amb.color != null ? amb.color : 0x1a0a0d,
      (amb.intensity != null ? amb.intensity : 1.2) * LIGHT_SCALE));
    var pc = L.pointCeiling || {};
    ceilBase = (pc.intensity != null ? pc.intensity : 1.1) * LIGHT_SCALE;
    ceilLight = new THREE.PointLight(pc.color != null ? pc.color : 0xe5173f,
      ceilBase, pc.distance || 14, pc.decay || 1.6);
    ceilLight.position.set(pc.x || 0, pc.y || (data.size.h - 0.25), pc.z || 0);
    scene.add(ceilLight);
  }

  function buildEnemy() {
    var sp = data.enemySpawn;
    enemy.mat = new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: makeFallbackEnemyTexture() },
        flicker: { value: 1.0 },
        hoverGlow: { value: 0.0 }
      },
      vertexShader:
        'varying vec2 vUv;\n' +
        'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform sampler2D tex;\n' +
        'uniform float flicker;\n' +
        'uniform float hoverGlow;\n' +
        'varying vec2 vUv;\n' +
        'void main(){\n' +
        '  vec4 c = texture2D(tex, vUv);\n' +
        '  float lum = dot(c.rgb, vec3(0.299,0.587,0.114));\n' +
        '  if (lum < 0.09) discard;\n' +
        '  float a = smoothstep(0.09, 0.25, lum);\n' +
        '  vec3 col = c.rgb + vec3(0.9,0.12,0.22) * hoverGlow * 0.55;\n' +
        '  gl_FragColor = vec4(col, a * flicker);\n' +
        '}',
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });

    enemy.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), enemy.mat);
    enemy.mesh.scale.set(enemy.baseScaleX, enemy.baseScaleY, 1);
    enemy.mesh.position.set(sp.x, enemy.baseY, sp.z);
    scene.add(enemy.mesh);

    // sprite jpg, else the existing battle image, else keep the canvas figure
    var applyTex = function (t) {
      if (renderFailed) return;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      enemy.mat.uniforms.tex.value = t;
      if (t.image && t.image.width && t.image.height) {
        var ar = t.image.width / t.image.height;
        enemy.baseScaleX = Math.max(0.7, Math.min(1.7, 1.9 * ar));
        if (!enemy.dissolving) enemy.mesh.scale.x = enemy.baseScaleX;
      }
    };
    loadTexInto(texPath('enemy'), applyTex, function () {
      loadTexInto(texPath('enemyFallback'), applyTex);
    });

    // faint red glow sprite behind + point light at the enemy
    enemy.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), color: 0xffffff, transparent: true,
      opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    enemy.glow.scale.set(2.6, 2.6, 1);
    enemy.glow.position.set(sp.x, enemy.baseY, sp.z);
    scene.add(enemy.glow);

    var le = (data.lights && data.lights.enemy) || {};
    enemy.light = new THREE.PointLight(le.color != null ? le.color : 0xff2038,
      enemyLightBase(), le.distance || 5, le.decay || 1.8);
    enemy.light.position.set(sp.x, enemy.baseY + 0.3, sp.z);
    scene.add(enemy.light);
  }

  function enemyLightBase() {
    return ((data.lights && data.lights.enemy && data.lights.enemy.intensity) || 0.7) * LIGHT_SCALE;
  }

  // ------------------------------------------------------ first-person hands
  // Primitive gloved hands (dark worn leather, subtle red rim) parented to the
  // camera. renderOrder high + near plane 0.05 keep them on top of the room.
  function buildHands() {
    hands.group = new THREE.Group();
    var glove = stdMat({
      color: 0x201417, roughness: 0.58, metalness: 0.08,
      emissive: 0x2a070c, emissiveIntensity: 0.22
    });
    // The hands sit right at the camera with nothing occluding them, so full
    // environment IBL washes the dark leather out to a pale grey. Damp the
    // env contribution so they read as gloves instead of putty.
    glove.envMapIntensity = 0.12;

    // Fingers/thumb live in their own groups so they can curl closed (§16).
    function fingerRow(hand, dir) {
      var fingers = new THREE.Group();
      for (var i = 0; i < 4; i++) {
        var fx = -0.033 + i * 0.022;
        for (var seg = 0; seg < 2; seg++) {
          var fl = seg === 0 ? 0.045 : 0.032;
          var fseg = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, fl), glove);
          fseg.position.set(fx, seg * -0.006, -0.055 - seg * 0.038);
          fseg.rotation.x = seg * 0.35;
          fingers.add(fseg);
        }
      }
      hand.add(fingers);
      // thumb on the inner side
      var thumb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.05), glove);
      thumb.position.set(dir * 0.055, 0.005, -0.02);
      thumb.rotation.y = dir * 0.7;
      hand.add(thumb);
      hand.userData.fingers = fingers;
      hand.userData.thumb = thumb;
      hand.userData.thumbYaw = dir * 0.7;
    }

    function makeHand(side) { // side: -1 left, +1 right
      var hand = new THREE.Group();
      // rounded palm: squashed sphere
      var palm = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), glove);
      palm.scale.set(0.95, 0.5, 1.1);
      hand.add(palm);
      // cuff / wrist
      var cuff = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.05, 0.06), glove);
      cuff.position.set(0, 0, 0.075);
      hand.add(cuff);
      fingerRow(hand, -side);
      hand.position.set(side * 0.28, -0.25, -0.55);
      hand.rotation.set(0.35, -side * 0.3, side * 0.12); // angled inward
      hand.userData.home = hand.position.clone();
      hand.userData.side = side;
      return hand;
    }

    hands.l = makeHand(-1);
    hands.r = makeHand(1);
    hands.group.add(hands.l);
    hands.group.add(hands.r);
    hands.group.traverse(function (o) {
      if (o.isMesh) { o.renderOrder = 999; o.frustumCulled = false; }
    });
    camera.add(hands.group);
    scene.add(camera); // camera must be in the scene graph for its children to render
    hands.lag = camera.quaternion.clone();
    hands.tmpQ = new THREE.Quaternion();
    hands.visible = true;
  }

  function updateHands(dt) {
    if (!hands.group) return;
    var speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    var sprinting = (keys.ShiftLeft || keys.ShiftRight) && speed > WALK * 0.9;
    var mul = sprinting ? 1.5 : 1;
    var sx = 0, sy = 0;
    if (grounded && speed > 0.15) {          // sway synced to the head-bob phase
      sx = Math.sin(bobPhase) * 0.02 * mul;
      sy = Math.abs(Math.cos(bobPhase)) * 0.015 * mul;
    }
    var breathe = Math.sin(elapsed * 1.7) * 0.004; // idle breath
    // jump raise (lerped), landing dip shared with the camera
    var raise = grounded ? 0 : 0.045;
    hands.jumpY += (raise - hands.jumpY) * Math.min(1, 10 * dt);
    var dip = dipTimer > 0 ? -DIP_AMP * Math.sin(Math.PI * (dipTimer / DIP_TIME)) : 0;
    hands.group.position.set(sx, breathe + sy + hands.jumpY + dip, 0);
    // rotational lag: a world-space quaternion chases the camera at ~12/s;
    // the group's local rotation is the remaining delta.
    hands.lag.slerp(camera.quaternion, Math.min(1, 12 * dt));
    hands.tmpQ.copy(camera.quaternion).invert();
    hands.group.quaternion.multiplyQuaternions(hands.tmpQ, hands.lag);

    // §16: fists close on mouse buttons; the grabbing hand reaches out
    var k = Math.min(1, 14 * dt);
    hands.closeL += (hands.targetL - hands.closeL) * k;
    hands.closeR += (hands.targetR - hands.closeR) * k;
    applyGrip(hands.l, hands.closeL, 'l');
    applyGrip(hands.r, hands.closeR, 'r');
  }

  function applyGrip(hand, t, sideKey) {
    if (!hand || !hand.userData.fingers) return;
    hand.userData.fingers.rotation.x = t * 1.15;                 // curl closed
    hand.userData.thumb.rotation.y = hand.userData.thumbYaw * (1 - t * 0.55);
    var home = hand.userData.home;
    var reach = (grab && grab.hand === sideKey) ? Math.min(1, grab.t * 2.2) : 0;
    hand.position.set(
      home.x - hand.userData.side * 0.14 * reach,  // inward toward center
      home.y + 0.08 * reach,
      home.z - 0.26 * reach                        // forward
    );
  }

  // ------------------------------------------------------------- pickups
  // Small glinting items you take with your hands (spec §16). Config lives in
  // data/room3d.js `pickups:[{itemId,label,x,y,z}]`.
  function disposePickup(p) {
    if (p.mesh) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      if (p.mesh.material) p.mesh.material.dispose();
    }
    if (p.glow) {
      if (p.glow.parent) p.glow.parent.remove(p.glow);
      if (p.glow.material) {
        if (p.glow.material.map) p.glow.material.map.dispose();
        p.glow.material.dispose();
      }
    }
  }

  function clearPickups() {
    for (var i = 0; i < pickups.length; i++) disposePickup(pickups[i]);
    pickups.length = 0;
    pickupHover = null;
    grab = null;
  }

  function buildPickups() {
    clearPickups();
    var list = (data && data.pickups) || [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.1, 0.12),
        stdMat({ color: 0x7a1020, roughness: 0.6,
                 emissive: 0xe5173f, emissiveIntensity: 0.5 }));
      mesh.position.set(d.x, d.y, d.z);
      mesh.castShadow = false;
      scene.add(mesh);
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeGlowTexture(), transparent: true, opacity: 0.45,
        depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(0.55, 0.55, 1);
      glow.position.set(d.x, d.y, d.z);
      scene.add(glow);
      pickups.push({ itemId: d.itemId, label: d.label || d.itemId,
        mesh: mesh, glow: glow, x: d.x, y: d.y, z: d.z, taken: false });
    }
  }

  function pickupUnderCrosshair() {
    if (!raycaster || !pickups.length) return null;
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ZERO2, camera);
    var best = null;
    for (var i = 0; i < pickups.length; i++) {
      var p = pickups[i];
      if (p.taken) continue;
      var hit = raycaster.intersectObject(p.mesh, false);
      if (hit.length && hit[0].distance <= GRAB_RANGE) {
        if (!best || hit[0].distance < best.dist) best = { pk: p, dist: hit[0].distance };
      }
    }
    return best;
  }

  function tryGrab(side) {
    if (grab) return false;
    var found = pickupUnderCrosshair();
    if (!found) return false;
    grab = { hand: side, pk: found.pk, t: 0 };
    found.pk.taken = true; // reserved — no double grabs
    return true;
  }

  // Deliver the grabbed item (also called from stop(): a battle starting
  // mid-grab must not eat the item).
  function finishGrab() {
    if (!grab) return;
    var pk = grab.pk, done = grab;
    grab = null;
    disposePickup(pk);
    if (done.hand === 'l') hands.targetL = 0; else hands.targetR = 0;
    if (onPickupCb) {
      try { onPickupCb(pk.itemId, pk.label); } catch (e) {}
    }
  }

  var GRAB_TARGET = null;
  function updatePickups(dt) {
    for (var i = 0; i < pickups.length; i++) {
      var p = pickups[i];
      if (p.taken) continue;
      var s = 0.5 + 0.18 * Math.sin(elapsed * 3 + i * 1.7);
      p.glow.material.opacity = 0.3 + 0.25 * Math.abs(Math.sin(elapsed * 2.2 + i));
      p.glow.scale.set(s, s, 1);
      p.mesh.rotation.y += dt * 0.8;
    }
    if (!grab) return;
    grab.t = Math.min(1, grab.t + dt / 0.45);
    var pk = grab.pk;
    var f = Math.max(0, (grab.t - 0.35) / 0.65); // item flies to the hand
    if (f > 0 && pk.mesh) {
      if (!GRAB_TARGET) GRAB_TARGET = new THREE.Vector3();
      GRAB_TARGET.set(0, -0.2, -0.6).applyMatrix4(camera.matrixWorld);
      pk.mesh.position.lerpVectors(new THREE.Vector3(pk.x, pk.y, pk.z), GRAB_TARGET, f);
      var sc = 1 - f * 0.7;
      pk.mesh.scale.set(sc, sc, sc);
      if (pk.glow) pk.glow.material.opacity = 0.45 * (1 - f);
    }
    if (grab.t >= 1) finishGrab();
  }

  // ---------------------------------------------------------------- init
  W.init = function (canvasEl) {
    if (disabled) return;
    if (inited) return; // idempotent — restart via start()/stop()
    if (!canvasEl) { disableAPI('init called without a canvas'); disabled = true; return; }
    canvas = canvasEl;
    data = (CHLOE.data && CHLOE.data.room3d) || {
      size: { w: 8, d: 6, h: 3 },
      playerSpawn: { x: -2.5, z: 2, yaw: -0.917 },
      enemySpawn: { x: 2.2, z: -1.6 },
      textures: {}, furniture: [], lights: {}
    };

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) {
      disableAPI('WebGL unavailable: ' + e.message); disabled = true; return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    setupPipeline();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 2, 14);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 50);
    camera.rotation.order = 'YXZ';

    raycaster = new THREE.Raycaster();
    ndc = new THREE.Vector2();

    colliders.length = 0;
    texturedMats.length = 0;
    // the scene is new, so the old frame's mesh and material are gone with it
    trophyGroup = null; trophyMat = null;
    stageBoard.mesh = null; stageBoard.hover = null; stageBoard.target = null;
    roomAssets.total = 0; roomAssets.done = 0; roomAssets.warm = false;
    buildRoom();
    buildFurniture();
    buildTrophies();
    buildLights();
    buildEnemy();
    buildHands();
    buildPickups();
    loadEnvironment();

    resetPlayer();
    inited = true;
    W.resize();
    try { renderer.render(scene, camera); } catch (e) { renderFailed = true; stripMaps(); }
  };

  function resetPlayer() {
    var sp = data.playerSpawn;
    pos.x = sp.x; pos.z = sp.z;
    vel.x = 0; vel.z = 0;
    yaw = sp.yaw || 0; pitch = 0; bobPhase = 0;
    yOff = 0; vy = 0; grounded = true; jumpQueued = false; dipTimer = 0;
    eyeH = EYE_HEIGHT;
    hands.targetL = 0; hands.targetR = 0;
    camera.position.set(pos.x, eyeH, pos.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  // ---------------------------------------------------------------- input
  var PREVENT = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1 };

  function onKeyDown(e) {
    if (e.code === 'Space' && !keys.Space) jumpQueued = true; // edge, no auto-repeat hop
    keys[e.code] = true;
    if (PREVENT[e.code]) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function onBlur() { keys = {}; }

  function isLocked() {
    return !!(canvas && document.pointerLockElement === canvas);
  }

  function onMouseMove(e) {
    if (!isLocked()) {
      // unlocked: remember the mouse point so hover matches the unlocked-click
      // raycast rule (spec: "on click, the mouse point if unlocked")
      var r = canvas ? canvas.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0 &&
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) {
        if (!mouseNdc) mouseNdc = new THREE.Vector2();
        mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1,
                     -((e.clientY - r.top) / r.height) * 2 + 1);
      } else {
        mouseNdc = null;
      }
      return;
    }
    mouseNdc = null;
    yaw -= (e.movementX || 0) * SENS;
    pitch -= (e.movementY || 0) * SENS;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    if (pitch < -PITCH_MAX) pitch = -PITCH_MAX;
  }

  function onClick(e) {
    if (!running) return;
    if (isLocked()) {
      if (hovered) fireEngage();       // enemy engage takes priority
      else if (tvHovered) toggleTv();
      else if (stageBoard.hover) stepStage(stageBoard.hover);
      else if (giftHover) openShop();  // §27D: the box under the crosshair
      return;
    }
    // unlocked: allow direct clicks via raycast from the click point —
    // enemy first (priority), then the TV screen, else request pointer lock
    var r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      if (enemy.alive && !enemy.dissolving) {
        enemy.mesh.updateMatrixWorld();
        var hit = raycaster.intersectObject(enemy.mesh, false);
        if (hit.length && hit[0].distance <= ENGAGE_DIST) { fireEngage(); return; }
      }
      if (tv.screenMesh) {
        tv.screenMesh.updateMatrixWorld();
        var th = raycaster.intersectObject(tv.screenMesh, false);
        if (th.length && th[0].distance <= TV_DIST) { toggleTv(); return; }
      }
      var arrow = boardUnder(raycaster);   // §26 the stage board's arrows
      if (arrow) { stepStage(arrow.which); return; }
      // §27D: same rule for the giftbox, so the shop opens with the pointer
      // unlocked too — that is the state you are in the first time you click
      // anything in this room.
      if (gift.targets) {
        gift.group.updateMatrixWorld();
        var gih = raycaster.intersectObjects(gift.targets, false);
        if (gih.length && gih[0].distance <= GIFT_DIST) { openShop(); return; }
      }
    }
    try {
      // modern Chrome returns a promise; swallow rejection (e.g. iframe/test docs)
      var pl = canvas.requestPointerLock();
      if (pl && typeof pl.catch === 'function') pl.catch(function () {});
    } catch (err) {}
  }

  function fireEngage() {
    if (!enemy.alive || enemy.dissolving) return;
    if (elapsed < engageCooldown) return;
    engageCooldown = elapsed + 0.5;
    if (engageCb) engageCb();
  }

  /* §16: LMB closes the left hand, RMB the right. While pointer-locked, a
     click with a glinting item under the crosshair reaches out and takes it —
     the enemy and the TV keep priority on the left hand (handled in onClick). */
  function onMouseDown(e) {
    if (!running) return;
    var side = e.button === 2 ? 'r' : (e.button === 0 ? 'l' : null);
    if (!side) return;
    if (side === 'l') hands.targetL = 1; else hands.targetR = 1;
    // grabs only while locked: unlocked clicks are aim-lock/raycast requests
    // and the crosshair ray would not match where the user actually clicked
    if (isLocked() &&
        !(side === 'l' && (hovered || tvHovered || stageBoard.hover || giftHover))) {
      tryGrab(side);
    }
  }
  function onMouseUp(e) {
    var side = e.button === 2 ? 'r' : (e.button === 0 ? 'l' : null);
    if (!side) return;
    if (grab && grab.hand === side) return; // stays closed until the item lands
    if (side === 'l') hands.targetL = 0; else hands.targetR = 0;
  }
  function onContextMenu(e) { e.preventDefault(); }

  function addListeners() {
    function on(t, type, fn, opts) { t.addEventListener(type, fn, opts); listeners.push([t, type, fn, opts]); }
    on(canvas, 'click', onClick);
    on(canvas, 'mousedown', onMouseDown);
    on(canvas, 'contextmenu', onContextMenu);
    on(document, 'mouseup', onMouseUp);
    on(document, 'mousemove', onMouseMove);
    on(window, 'keydown', onKeyDown);
    on(window, 'keyup', onKeyUp);
    on(window, 'blur', onBlur);
    on(window, 'resize', W.resize);
  }
  function removeListeners() {
    for (var i = 0; i < listeners.length; i++) {
      listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
    }
    listeners.length = 0;
  }

  // ---------------------------------------------------------------- movement
  function updatePlayer(dt) {
    var f = ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0);
    var s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    var turn = ((keys.ArrowLeft || keys.KeyQ) ? 1 : 0) - ((keys.ArrowRight || keys.KeyE) ? 1 : 0);
    yaw += turn * TURN_RATE * dt;

    var crouch = !!(keys.ControlLeft || keys.ControlRight || keys.KeyC);
    var spd = (keys.ShiftLeft || keys.ShiftRight) ? SPRINT : WALK;
    if (crouch) spd *= CROUCH_MULT;
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

    /* Axis-separated AABB resolve (slide along surfaces).
       TWO subtleties, both exposed for the first time by the §27 giftbox — the
       first collidable prop you can walk into head-on:
       (1) EPS. The X pass parks the body exactly against a face, and floating
           point leaves `pos.x - RADIUS` a hair UNDER maxX, so the Z pass still
           read the box as overlapping and re-resolved a contact already resolved.
       (2) Resolve by SMALLEST PENETRATION, never by which half the centre is in.
           Walking due west gives vel.z ~ 0, so the old `else` compared centres and
           could pick the FAR face — a 0.72m sideways snap, and on a corner
           approach it threw the body clean out of the room (x = 5.35). Nearest
           face out is the only choice that cannot teleport. */
    var i, c, EPS = 1e-4, penLo, penHi;
    var nx = pos.x + vel.x * dt;
    for (i = 0; i < colliders.length; i++) {
      c = colliders[i];
      if (nx + RADIUS > c.minX + EPS && nx - RADIUS < c.maxX - EPS &&
          pos.z + RADIUS > c.minZ + EPS && pos.z - RADIUS < c.maxZ - EPS) {
        if (vel.x > 0) nx = c.minX - RADIUS;
        else if (vel.x < 0) nx = c.maxX + RADIUS;
        else {
          penLo = (nx + RADIUS) - c.minX;
          penHi = c.maxX - (nx - RADIUS);
          nx = (penLo < penHi) ? c.minX - RADIUS : c.maxX + RADIUS;
        }
      }
    }
    pos.x = nx;
    var nz = pos.z + vel.z * dt;
    for (i = 0; i < colliders.length; i++) {
      c = colliders[i];
      if (pos.x + RADIUS > c.minX + EPS && pos.x - RADIUS < c.maxX - EPS &&
          nz + RADIUS > c.minZ + EPS && nz - RADIUS < c.maxZ - EPS) {
        if (vel.z > 0) nz = c.minZ - RADIUS;
        else if (vel.z < 0) nz = c.maxZ + RADIUS;
        else {
          penLo = (nz + RADIUS) - c.minZ;
          penHi = c.maxZ - (nz - RADIUS);
          nz = (penLo < penHi) ? c.minZ - RADIUS : c.maxZ + RADIUS;
        }
      }
    }
    pos.z = nz;

    // jump / gravity (section 14): Space while grounded only, no double-jump
    if (jumpQueued) {
      jumpQueued = false;
      if (grounded) { vy = JUMP_V; grounded = false; }
    }
    if (!grounded) {
      vy += GRAVITY * dt;
      yOff += vy * dt;
      if (yOff <= 0) {                 // landed back at eye height
        yOff = 0; vy = 0; grounded = true;
        dipTimer = DIP_TIME;           // landing dip (camera + hands)
      }
    }
    if (dipTimer > 0) dipTimer = Math.max(0, dipTimer - dt);

    // head bob (eye 1.6, amp scales with speed) — only while grounded
    var speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    var bob = 0;
    if (grounded && speed > 0.15) {
      bobPhase += dt * (6 + speed * 1.7);
      bob = Math.sin(bobPhase) * BOB_AMP * (crouch ? 0.5 : 1) * Math.min(1, speed / WALK);
    }
    // §16 crouch: eye height lerps between standing and crouched
    var targetEye = crouch ? CROUCH_EYE : EYE_HEIGHT;
    eyeH += (targetEye - eyeH) * Math.min(1, 10 * dt);
    var dip = dipTimer > 0 ? -DIP_AMP * Math.sin(Math.PI * (dipTimer / DIP_TIME)) : 0;
    camera.position.set(pos.x, eyeH + yOff + bob + dip, pos.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  // ---------------------------------------------------------------- enemy
  function updateEnemy(dt) {
    if (enemy.dissolving) {
      enemy.dissolveT += dt / DISSOLVE_SECS;
      var t = Math.min(1, enemy.dissolveT);
      enemy.mesh.scale.set(enemy.baseScaleX * (1 - 0.55 * t), enemy.baseScaleY * (1 - 0.35 * t), 1);
      enemy.mat.uniforms.flicker.value = (1 - t) * (0.7 + 0.3 * Math.random());
      enemy.glow.material.opacity = 0.5 * (1 - t);
      enemy.light.intensity = enemyLightBase() * (1 - t);
      if (t >= 1) {
        enemy.dissolving = false;
        enemy.mesh.visible = false; enemy.glow.visible = false; enemy.light.visible = false;
        enemy.respawnTimer = RESPAWN_SECS;
      }
      return;
    }
    if (!enemy.alive) {
      if (enemy.respawnTimer > 0) {
        enemy.respawnTimer -= dt;
        if (enemy.respawnTimer <= 0) respawnEnemy();
      }
      return;
    }
    // alive: float bob, billboard yaw, flicker
    var sp = data.enemySpawn;
    var y = enemy.baseY + Math.sin(elapsed * 1.3) * 0.07;
    enemy.mesh.position.set(sp.x, y, sp.z);
    enemy.glow.position.set(sp.x, y, sp.z);
    enemy.light.position.set(sp.x, y + 0.3, sp.z);
    enemy.mesh.rotation.y = Math.atan2(camera.position.x - sp.x, camera.position.z - sp.z);
    enemy.mat.uniforms.flicker.value =
      0.82 + 0.13 * Math.sin(elapsed * 9.3) + 0.05 * Math.random();
    // hover emissive pulse
    var target = hovered ? 1 : 0;
    hoverGlow += (target - hoverGlow) * Math.min(1, 8 * dt);
    enemy.mat.uniforms.hoverGlow.value = hoverGlow * (0.55 + 0.45 * Math.sin(elapsed * 6));
  }

  function respawnEnemy() {
    var sp = data.enemySpawn;
    enemy.alive = true; enemy.dissolving = false; enemy.dissolveT = 0; enemy.respawnTimer = 0;
    enemy.mesh.visible = true; enemy.glow.visible = true; enemy.light.visible = true;
    enemy.mesh.scale.set(enemy.baseScaleX, enemy.baseScaleY, 1);
    enemy.mesh.position.set(sp.x, enemy.baseY, sp.z);
    enemy.glow.material.opacity = 0.5;
    enemy.light.intensity = enemyLightBase();
  }

  function currentEnemyDist() {
    var ex, ez;
    if (enemy.mesh && (enemy.alive || enemy.dissolving)) {
      ex = enemy.mesh.position.x; ez = enemy.mesh.position.z;
    } else {
      ex = data.enemySpawn.x; ez = data.enemySpawn.z;
    }
    var dx = ex - pos.x, dz = ez - pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  function updateHover() {
    var was = hovered, wasTv = tvHovered, wasDist = enemyDist;
    enemyDist = currentEnemyDist();
    camera.updateMatrixWorld();
    // locked: center crosshair ray; unlocked: the mouse point (same rule as
    // unlocked clicks), falling back to center when the mouse is off-canvas
    raycaster.setFromCamera(isLocked() ? ZERO2 : (mouseNdc || ZERO2), camera);
    if (enemy.alive && !enemy.dissolving) {
      enemy.mesh.updateMatrixWorld();
      var hit = raycaster.intersectObject(enemy.mesh, false);
      hovered = !!(hit.length && hit[0].distance <= ENGAGE_DIST);
    } else {
      hovered = false;
    }
    // TV hover (section 14) — enemy hover always wins when both would hit
    tvHovered = false;
    if (!hovered && tv.screenMesh) {
      tv.screenMesh.updateMatrixWorld();
      var th = raycaster.intersectObject(tv.screenMesh, false);
      tvHovered = !!(th.length && th[0].distance <= TV_DIST);
    }
    /* §27D giftbox hover — the enemy and the TV keep priority, so the box can
       never swallow a click meant to start a fight. Kept OUT of hoverCb's
       (enemy, dist, tv) signature on purpose: ui/room3d.js belongs to another
       session and must not have its callback shape changed under it. It reads
       debug().giftHover instead, which is the same {label, dist} shape as
       pickupHover, so its hint line is one branch when it wants one. */
    var wasGift = giftHover;
    giftHover = null;
    if (!hovered && !tvHovered && gift.targets) {
      gift.group.updateMatrixWorld();
      var gh = raycaster.intersectObjects(gift.targets, false);
      if (gh.length && gh[0].distance <= GIFT_DIST) {
        giftHover = { label: 'the giftbox', dist: gh[0].distance };
      }
    }
    gift.hovered = !!giftHover;
    if (gift.glow) {
      // idle breath vs. a hard pulse while aimed at — the in-world hint
      gift.glow.material.opacity = gift.hovered
        ? 0.6 + 0.16 * Math.sin(elapsed * 7)
        : 0.26 + 0.1 * Math.sin(elapsed * 2.2);
      var gs = gift.hovered ? 1.05 : 0.8;
      gift.glow.scale.set(gs, gs, 1);
      if (gift.ribbonMat) gift.ribbonMat.emissiveIntensity = gift.hovered ? 1.1 : 0.35;
    }
    if (giftHoverCb && !!giftHover !== !!wasGift) {
      try { giftHoverCb(!!giftHover, giftHover ? giftHover.dist : Infinity); } catch (e) {}
    }
    if (hoverCb && (hovered !== was || tvHovered !== wasTv ||
        (hovered && Math.abs(enemyDist - wasDist) > 0.05))) {
      try { hoverCb(hovered, enemyDist, tvHovered); } catch (e) {}
    }
    /* §26 the board's arrows — behind the enemy and the TV, ahead of the
       pickups: a poster on the wall and an item on the floor can both be
       under the crosshair, and the one you are standing at arm's length
       from is the one you meant. */
    var arrowHit = (!hovered && !tvHovered) ? boardUnder(raycaster) : null;
    stageBoard.hover = arrowHit ? arrowHit.which : null;
    stageBoard.target = arrowHit ? arrowHit.target : null;

    /* §16 pickup hover for the HUD hint — enemy, TV, the board and the
       §27D giftbox all win. The box was added to both click chains but not to
       this one, so a pickup behind it stayed "hoverable": the HUD could offer
       an item that the click would never take, because onClick stops at the
       box. One list, one order. */
    if (!hovered && !tvHovered && !stageBoard.hover && !giftHover && !grab) {
      var found = pickupUnderCrosshair();
      pickupHover = found ? { itemId: found.pk.itemId, label: found.pk.label, dist: found.dist } : null;
    } else {
      pickupHover = null;
    }
  }
  var ZERO2 = new THREE.Vector2(0, 0);

  // ---------------------------------------------------------------- fx
  function updateFx(dt) {
    // ceiling light: subtle random flicker
    if (ceilLight) {
      ceilTimer -= dt;
      if (ceilTimer <= 0) {
        ceilTimer = 0.06 + Math.random() * 0.2;
        var fl = (data.lights && data.lights.pointCeiling && data.lights.pointCeiling.flicker) || 0.18;
        ceilTarget = 1 - Math.random() * fl * 2;
      }
      ceilLight.intensity += (ceilBase * ceilTarget - ceilLight.intensity) * Math.min(1, 12 * dt);
    }
    // TV: animated static + bluish flicker + light flicker while ON;
    // OFF is the static near-black glossy material (nothing to animate)
    if (tv.on && tv.onMat) {
      var v = 0.75 + 0.35 * Math.random();
      if (tv.tex) {
        tv.tex.offset.set(Math.random() * 0.5, Math.random() * 0.5);
        tv.onMat.color.setRGB(0.8 * v, 0.88 * v, 1.0 * v);  // bluish cast over the static
      } else {
        tv.onMat.color.setRGB(0.16 * v, 0.19 * v, 0.24 * v); // no texture: bluish glow flicker
      }
      if (tv.light) tv.light.intensity = tv.lightBase * (0.65 + 0.55 * Math.random());
    }
  }

  // ---------------------------------------------------------------- loop
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000)) || 0.016;
    lastTime = now;
    elapsed += dt;
    updatePlayer(dt);
    updateHands(dt);
    updateEnemy(dt);
    updateHover();
    updatePickups(dt);
    updateFx(dt);
    try {
      renderer.render(scene, camera);
    } catch (e) {
      if (!renderFailed) console.warn('[world3d] render error — falling back to flat materials', e);
      renderFailed = true;
      stripMaps(); // idempotent; also catches textures that finished loading late
    }
  }

  // ---------------------------------------------------------------- API
  W.start = function () {
    if (disabled || !inited || running) return;
    running = true;
    keys = {};
    jumpQueued = false;
    vel.x = 0; vel.z = 0;
    addListeners();
    W.resize();
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  };

  W.stop = function () {
    if (!running) return;
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    removeListeners();
    keys = {};
    jumpQueued = false;
    vel.x = 0; vel.z = 0;
    finishGrab();                         // an in-flight grab still delivers
    hands.targetL = 0; hands.targetR = 0; // no fists frozen shut across battles
    if (isLocked()) { try { document.exitPointerLock(); } catch (e) {} }
  };

  W.setEnemyAlive = function (alive) {
    if (disabled || !inited) return;
    if (alive) {
      respawnEnemy();
    } else if (enemy.alive && !enemy.dissolving) {
      enemy.alive = false;
      enemy.dissolving = true;
      enemy.dissolveT = 0;
      hovered = false;
    }
  };

  // Put the player back at the spawn point; pickups respawn with the run (§15).
  W.resetPlayer = function () {
    if (disabled || !inited) return;
    resetPlayer();
    buildPickups();
  };

  W.onEngage = function (cb) { engageCb = typeof cb === 'function' ? cb : null; };

  // Fired when a hand finishes taking an item: cb(itemId, label).
  W.onPickup = function (cb) { onPickupCb = typeof cb === 'function' ? cb : null; };

  // Optional hint hook for the UI: cb(enemyHovered, enemyDist, tvHovered).
  // enemyHovered -> "click to engage"; tvHovered -> "TV — click to turn on/off".
  W.onHover = function (cb) { hoverCb = typeof cb === 'function' ? cb : null; };

  W.resize = function () {
    if (!renderer || !camera || !canvas) return;
    var w = canvas.clientWidth || window.innerWidth || 1;
    var h = canvas.clientHeight || window.innerHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  /* Draw one frame on demand — lets automated checks grab a real screenshot
     even where requestAnimationFrame is throttled (headless/background tabs). */
  W._renderOnce = function () {
    if (disabled || !inited) return false;
    camera.position.set(pos.x, eyeH + yOff, pos.z);
    camera.rotation.set(pitch, yaw, 0);
    try { renderer.render(scene, camera); return true; } catch (e) { return false; }
  };
  W._look = function (y, p) { yaw = y; if (typeof p === 'number') pitch = p; };
  W._teleport = function (x, z) { pos.x = x; pos.z = z; vel.x = vel.z = 0; };

  W.assetProgress = function () {
    return { done: roomAssets.done, total: Math.max(1, roomAssets.total), warm: roomAssets.warm };
  };
  W.assetsReady = function () {
    if (!inited) return false;
    if (roomAssets.done < roomAssets.total) return false;
    if (!roomAssets.warm) {
      /* Compile every program, then draw one frame so the driver has really
         uploaded them - otherwise the first look around the room stutters as
         each material is compiled on the frame it first becomes visible. */
      try { if (renderer) renderer.compile(scene, camera); }
      catch (e) { console.warn('[world3d] shader warm-up failed', e); }
      try { if (renderer) renderer.render(scene, camera); } catch (e) {}
      roomAssets.warm = true;
    }
    return roomAssets.warm;
  };
  /* §21: same handle the arena exposes, so callers never special-case which
     3D scene is up when they need the cursor back for a panel. */
  W.releaseLock = function () {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
  };
  W.isLocked = function () { return !!document.pointerLockElement; };
  /* Repaint mirror/poster — levels and stats change between visits — refresh
     the §24 stage board, since the round moved on and the next fight may be on
     a different floor, and rehang the gallery, since a round may have been
     cleared since you left. The room router calls this on every entry. */
  W.refreshPanels = function () {
    if (A_refreshPanels) A_refreshPanels();
    if (inited) buildTrophies();
    // §27E: the record board hangs off the SAME hook — a run may have ended
    // and put a name on the wall while you were out, and the frame is only
    // ever honest if it repaints exactly when the other panels do.
    if (inited) paintRecords();
  };

  /* §27D optional hint hook for the UI: cb(giftHovered, dist). Separate from
     onHover() because that callback's (enemy, dist, tv) signature belongs to
     ui/room3d.js, which another session owns — a fourth argument bolted onto
     it would be a silent contract change in someone else's file. */
  W.onGiftHover = function (cb) { giftHoverCb = typeof cb === 'function' ? cb : null; };
  W.tvChapter = function () { return panels.tvChapter; };

  W.debug = function () {
    if (!inited) return deadDebug();
    var out = [];
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      out.push({ kind: c.kind, minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ });
    }
    var ml = {};
    for (var id in modelsLoaded) {
      if (Object.prototype.hasOwnProperty.call(modelsLoaded, id)) ml[id] = modelsLoaded[id];
    }
    return {
      x: pos.x, y: eyeH + yOff, z: pos.z, yaw: yaw, pitch: pitch,
      locked: isLocked(),
      grounded: grounded,
      enemyDist: currentEnemyDist(),
      enemyAlive: enemy.alive,
      enemyHovered: hovered,
      tvOn: tv.on,
      tvHover: tvHovered,
      /* §26: the arrow under the crosshair and the floor it would pick, so
         the HUD can offer "▶ THE CHURCH" instead of a bare "click". */
      stageArrow: stageBoard.hover
        ? { which: stageBoard.hover,
            id: stageBoard.target ? stageBoard.target.id : null,
            name: stageBoard.target ? stageBoard.target.name : null }
        : null,
      /* §24 verification hook: what the south board is ACTUALLY announcing
         right now, straight off the last paint rather than re-resolved — a
         test proving the board names the stage the next fight uses has to read
         the wall, not ask the question a second time. null = the board fell
         back to the knight dossier (no stages data, or no displays.stage). */
      stageBoard: panels.stagePlan
        ? { id: panels.stagePlan.def.id, name: panels.stagePlan.def.name,
            round: panels.stagePlan.round, knights: panels.stagePlan.knights }
        : null,
      envMap: envMapOk,
      handsVisible: hands.visible,
      crouch: !!(keys.ControlLeft || keys.ControlRight || keys.KeyC),
      eye: eyeH,
      pickupHover: pickupHover,
      /* §27D/E verification hooks. giftHover mirrors pickupHover's shape so a
         hint line can consume either; recordBoard says whether the frame is
         showing a real board ('live') or is still the inert dark panel
         ('inert', i.e. engine/records.js was not in the build), and null when
         the prop is not in data/room3d.js at all. */
      giftHover: giftHover,
      shopReady: !!(CHLOE.ui && CHLOE.ui.shop && typeof CHLOE.ui.shop.open === 'function'),
      recordBoard: recBoard.mat ? (recBoard.live ? 'live' : 'inert') : null,
      pickupsLeft: pickups.filter(function (p) { return !p.taken; }).length,
      hands: { l: hands.closeL, r: hands.closeR, grabbing: grab ? grab.hand : null },
      modelsLoaded: ml,
      colliders: out
    };
  };
})();
