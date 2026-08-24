/* CHLOE — engine/world3d.js
   First-person 3D room (spec section 13). Owns all Three.js logic.
   API: CHLOE.engine.world3d = { init(canvas), start(), stop(), setEnemyAlive(bool),
        onEngage(cb), resize(), debug() }  (+ optional onHover(cb) hint hook for the UI).
   No DOM outside the given canvas + pointer lock. No UI/game-rule logic.
   Degrades safely: no THREE -> no-op API; missing/blocked textures -> flat colors.
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

(function () {
  'use strict';

  var W = {};
  CHLOE.engine.world3d = W;

  function noop() {}
  function deadDebug() {
    return { x: 0, z: 0, yaw: 0, pitch: 0, locked: false, enemyDist: 0, enemyAlive: false, colliders: [] };
  }
  function disableAPI(reason) {
    if (reason) console.warn('[world3d] disabled: ' + reason);
    W.init = noop; W.start = noop; W.stop = noop;
    W.setEnemyAlive = noop; W.resetPlayer = noop; W.onEngage = noop; W.onHover = noop;
    W.resize = noop; W.debug = deadDebug;
  }

  if (!window.THREE) { disableAPI('THREE not found (vendor/three.min.js missing?)'); return; }

  // ---------------------------------------------------------------- constants
  var EYE_HEIGHT = 1.6;
  var CROUCH_EYE = 0.85;      // Ctrl/C held (spec §15 controls)
  var CROUCH_MULT = 0.55;     // crouch speed factor
  var RADIUS = 0.35;
  var WALK = 3.0, SPRINT = 5.0;
  var GRAB_RANGE = 2.2;       // how far a hand can reach for a pickup
  var ACCEL_LERP = 10;                 // approach rate per second
  var TURN_RATE = 100 * Math.PI / 180; // keyboard yaw, rad/s
  var SENS = 0.0022;
  var PITCH_MAX = 80 * Math.PI / 180;
  var ENGAGE_DIST = 3.5;
  var BOB_AMP = 0.03;
  var RESPAWN_SECS = 15;
  var DISSOLVE_SECS = 0.8;

  // ---------------------------------------------------------------- state
  var inited = false, running = false, disabled = false;
  var canvas = null, renderer = null, scene = null, camera = null;
  var rafId = 0, lastTime = 0, elapsed = 0, renderFailed = false;

  var pos = { x: -2.5, z: 2 };
  var vel = { x: 0, z: 0 };
  var yaw = 0, pitch = 0, bobPhase = 0;
  var keys = {};
  var colliders = [];       // [{kind,minX,maxX,minZ,maxZ}]
  var texturedMats = [];    // materials that got a map (for strip-on-failure)
  var data = null;

  var engageCb = null, hoverCb = null, onPickupCb = null, engageCooldown = 0;
  var hovered = false, hoverGlow = 0, enemyDist = Infinity;
  var eyeH = EYE_HEIGHT;

  // first-person hands (spec §15: LMB closes the left hand, RMB the right;
  // a click near a glinting item reaches out and takes it in the motion)
  var hands = { built: false, l: null, r: null, closeL: 0, closeR: 0,
                targetL: 0, targetR: 0 };
  var pickups = [];          // [{id,itemId,label,mesh,glow,x,y,z,taken}]
  var pickupHover = null;    // {itemId,label,dist} under the crosshair
  var grab = null;           // {hand:'l'|'r', pk, t}  active grab animation

  var enemy = {
    mesh: null, mat: null, glow: null, light: null,
    alive: true, dissolving: false, dissolveT: 0, respawnTimer: 0,
    baseY: 1.0, baseScaleX: 1.1, baseScaleY: 1.9
  };
  var tvScreen = { mat: null, tex: null };
  var ceilLight = null, ceilBase = 1, ceilTarget = 1, ceilTimer = 0;
  var raycaster = null, ndc = null;
  var listeners = []; // [target, type, fn]

  // ---------------------------------------------------------------- helpers
  function texPath(key) {
    return (key && data && data.textures && data.textures[key]) || null;
  }

  function loadTexInto(path, onLoad, onError) {
    if (!path) { if (onError) onError(); return; }
    try {
      new THREE.TextureLoader().load(path, function (t) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
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

  // file:// in some browsers lets the <img> load but throws SecurityError at
  // GL upload; if render throws, strip every map back to flat colors once.
  function stripMaps() {
    for (var i = 0; i < texturedMats.length; i++) {
      var m = texturedMats[i];
      m.map = null;
      if (m.color) m.color.setHex(m.userData.fb != null ? m.userData.fb : 0x333333);
      m.needsUpdate = true;
    }
    texturedMats.length = 0;
    if (tvScreen.mat) { tvScreen.tex = null; }
    if (enemy.mat && enemy.mat.uniforms) {
      enemy.mat.uniforms.tex.value = makeFallbackEnemyTexture();
      enemy.mat.needsUpdate = true;
    }
  }

  function addCollider(kind, x, z, w, d, rotY) {
    var c = Math.abs(Math.cos(rotY || 0)), s = Math.abs(Math.sin(rotY || 0));
    var hx = c * w / 2 + s * d / 2;
    var hz = s * w / 2 + c * d / 2;
    colliders.push({ kind: kind, minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
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
    scene.add(box);

    // wall colliders (thick AABBs just outside the shell — one code path for everything)
    var hw = sz.w / 2, hd = sz.d / 2, T = 1;
    colliders.push({ kind: 'wall_w', minX: -hw - T, maxX: -hw, minZ: -hd - T, maxZ: hd + T });
    colliders.push({ kind: 'wall_e', minX: hw, maxX: hw + T, minZ: -hd - T, maxZ: hd + T });
    colliders.push({ kind: 'wall_n', minX: -hw - T, maxX: hw + T, minZ: -hd - T, maxZ: -hd });
    colliders.push({ kind: 'wall_s', minX: -hw - T, maxX: hw + T, minZ: hd, maxZ: hd + T });
  }

  function buildFurniture() {
    var list = data.furniture || [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var g = new THREE.Group();
      g.position.set(f.x, 0, f.z);
      g.rotation.y = f.rotY || 0;
      buildPiece(g, f);
      scene.add(g);
      if (f.kind === 'vanity' || f.kind === 'couch' || f.kind === 'tv' || f.kind === 'lamp') {
        addCollider(f.kind, f.x, f.z, f.w, f.d, f.rotY);
      }
    }
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
          new THREE.MeshStandardMaterial({ color: 0x171012, roughness: 0.8, metalness: 0.1 }));
        top.position.y = f.h * 0.94;
        g.add(top);
        break;

      case 'mirror':
        m = makeMat(f.tex, { fallback: 0x0b0508, emissive: 0x2a0810, emissiveIntensity: 0.55 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = 1.55;
        g.add(mesh);
        var frame = new THREE.Mesh(new THREE.BoxGeometry(f.w + 0.1, f.h + 0.1, 0.03),
          new THREE.MeshStandardMaterial({ color: 0x1c1216, roughness: 0.9 }));
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
          new THREE.MeshStandardMaterial({ color: 0x1a1216, roughness: 0.9 }));
        stand.position.y = standH / 2;
        g.add(stand);
        var body = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.78, bodyH, f.d * 0.85),
          new THREE.MeshStandardMaterial({ color: 0x232028, roughness: 0.7 }));
        body.position.y = standH + bodyH / 2;
        g.add(body);
        tvScreen.mat = makeMat(f.tex, {
          basic: true, fallback: 0x2a3038,
          onTex: function (t) { tvScreen.tex = t; t.repeat.set(1, 1); }
        });
        var screen = new THREE.Mesh(new THREE.PlaneGeometry(f.w * 0.62, bodyH * 0.72), tvScreen.mat);
        screen.position.set(0, standH + bodyH / 2, f.d * 0.85 / 2 + 0.005);
        g.add(screen);
        break;

      case 'door':
        m = makeMat(f.tex, { fallback: 0x581018 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = f.h / 2;
        g.add(mesh);
        break;

      case 'lamp':
        var poleMat = new THREE.MeshStandardMaterial({ color: 0x141114, roughness: 0.6, metalness: 0.4 });
        var foot = new THREE.Mesh(new THREE.BoxGeometry(f.w, 0.05, f.d), poleMat);
        foot.position.y = 0.025; g.add(foot);
        var pole = new THREE.Mesh(new THREE.BoxGeometry(0.05, f.h * 0.85, 0.05), poleMat);
        pole.position.y = f.h * 0.45; g.add(pole);
        var shade = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.75, f.h * 0.2, f.d * 0.75),
          new THREE.MeshStandardMaterial({
            color: 0x7a3520, roughness: 0.9,
            emissive: 0xff9a55, emissiveIntensity: 0.6
          }));
        shade.position.y = f.h * 0.88; g.add(shade);
        var lc = (data.lights && data.lights.lamp) || {};
        var lamp = new THREE.PointLight(lc.color != null ? lc.color : 0xffb37a,
          lc.intensity != null ? lc.intensity : 0.9, lc.distance || 6, lc.decay || 1.8);
        lamp.position.y = f.h * 0.9;
        g.add(lamp);
        break;

      case 'poster':
        m = makeMat(f.tex, { fallback: 0x2b2b30 });
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.h), m);
        mesh.position.y = 1.5;
        g.add(mesh);
        break;

      default: // unknown kind -> plain dark box, still placed
        mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d),
          new THREE.MeshStandardMaterial({ color: 0x221a1e, roughness: 0.95 }));
        mesh.position.y = f.h / 2;
        g.add(mesh);
    }
  }

  function buildLights() {
    var L = data.lights || {};
    var amb = L.ambient || {};
    scene.add(new THREE.AmbientLight(amb.color != null ? amb.color : 0x1a0a0d,
      amb.intensity != null ? amb.intensity : 1.2));
    var pc = L.pointCeiling || {};
    ceilBase = pc.intensity != null ? pc.intensity : 1.1;
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
      le.intensity != null ? le.intensity : 0.7, le.distance || 5, le.decay || 1.8);
    enemy.light.position.set(sp.x, enemy.baseY + 0.3, sp.z);
    scene.add(enemy.light);
  }

  // ------------------------------------------------------------- hands
  function makeHand(side){
    var g = new THREE.Group();
    var skin = new THREE.MeshStandardMaterial({ color: 0xc9a08a, roughness: 0.85 });
    var sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x1d1216, roughness: 0.9 }));
    sleeve.position.set(0, -0.015, 0.1);
    g.add(sleeve);
    var palm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.03, 0.1), skin);
    g.add(palm);
    var fingers = new THREE.Group();
    fingers.position.set(0, 0, -0.05);
    for (var i = 0; i < 4; i++) {
      var f = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.02, 0.065), skin);
      f.position.set(-0.031 + i * 0.021, 0, -0.032);
      fingers.add(f);
    }
    fingers.rotation.x = -0.15;
    g.add(fingers);
    var thumb = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.02, 0.05), skin);
    thumb.position.set(side === 'l' ? 0.05 : -0.05, 0, -0.01);
    thumb.rotation.y = side === 'l' ? -0.7 : 0.7;
    g.add(thumb);
    g.userData.fingers = fingers;
    g.userData.thumb = thumb;
    return g;
  }

  function buildHands(){
    if (hands.built) return;
    scene.add(camera); // camera children only render when the camera is in the scene
    hands.l = makeHand('l');
    hands.l.position.set(-0.28, -0.26, -0.52);
    hands.l.rotation.set(-0.5, 0.22, 0.08);
    camera.add(hands.l);
    hands.r = makeHand('r');
    hands.r.position.set(0.28, -0.26, -0.52);
    hands.r.rotation.set(-0.5, -0.22, -0.08);
    camera.add(hands.r);
    hands.built = true;
  }

  function updateHands(dt){
    if (!hands.built) return;
    var k = Math.min(1, 14 * dt);
    hands.closeL += (hands.targetL - hands.closeL) * k;
    hands.closeR += (hands.targetR - hands.closeR) * k;
    var apply = function (hand, t, side) {
      hand.userData.fingers.rotation.x = -0.15 - t * 1.25;
      hand.userData.thumb.rotation.x = -t * 0.9;
      // grabbing hand reaches forward + inward
      var g = (grab && grab.hand === side) ? Math.min(1, grab.t * 2.2) : 0;
      var baseX = side === 'l' ? -0.28 : 0.28;
      hand.position.x = baseX + (side === 'l' ? 1 : -1) * 0.14 * g;
      hand.position.z = -0.52 - 0.26 * g;
      hand.position.y = -0.26 + 0.08 * g;
    };
    apply(hands.l, hands.closeL, 'l');
    apply(hands.r, hands.closeR, 'r');
  }

  // ------------------------------------------------------------- pickups
  function disposePickup(p){
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

  function clearPickups(){
    for (var i = 0; i < pickups.length; i++) disposePickup(pickups[i]);
    pickups.length = 0;
    pickupHover = null;
    grab = null;
  }

  function buildPickups(){
    clearPickups();
    var list = (data && data.pickups) || [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.1, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x7a1020, roughness: 0.6,
          emissive: 0xe5173f, emissiveIntensity: 0.5 }));
      mesh.position.set(d.x, d.y, d.z);
      scene.add(mesh);
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeGlowTexture(), transparent: true, opacity: 0.45,
        depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(0.55, 0.55, 1);
      glow.position.set(d.x, d.y, d.z);
      scene.add(glow);
      pickups.push({ id: d.id || d.itemId, itemId: d.itemId, label: d.label || d.itemId,
        mesh: mesh, glow: glow, x: d.x, y: d.y, z: d.z, taken: false });
    }
  }

  function pickupUnderCrosshair(){
    if (!raycaster) return null;
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

  function tryGrab(side){
    if (grab) return false;
    var found = pickupUnderCrosshair();
    if (!found) return false;
    grab = { hand: side, pk: found.pk, t: 0 };
    found.pk.taken = true; // reserved — no double grabs
    return true;
  }

  function updatePickups(dt){
    // idle pulse
    for (var i = 0; i < pickups.length; i++) {
      var p = pickups[i];
      if (p.taken) continue;
      var s = 0.5 + 0.18 * Math.sin(elapsed * 3 + i * 1.7);
      p.glow.material.opacity = 0.3 + 0.25 * Math.abs(Math.sin(elapsed * 2.2 + i));
      p.glow.scale.set(s, s, 1);
      p.mesh.rotation.y += dt * 0.8;
    }
    if (grab) {
      grab.t = Math.min(1, grab.t + dt / 0.45);
      var pk = grab.pk;
      // after the hand extends, the item flies into it
      var f = Math.max(0, (grab.t - 0.35) / 0.65);
      if (f > 0 && pk.mesh) {
        var target = new THREE.Vector3(0, -0.2, -0.6).applyMatrix4(camera.matrixWorld);
        pk.mesh.position.lerpVectors(new THREE.Vector3(pk.x, pk.y, pk.z), target, f);
        var sc = 1 - f * 0.7;
        pk.mesh.scale.set(sc, sc, sc);
        if (pk.glow) pk.glow.material.opacity = 0.45 * (1 - f);
      }
      if (grab.t >= 1) finishGrab();
    }
  }

  // Deliver the grabbed item (also called from stop(): a battle starting
  // mid-grab must not eat the item).
  function finishGrab(){
    if (!grab) return;
    var pk = grab.pk;
    var done = grab;
    grab = null;
    disposePickup(pk);
    if (done.hand === 'l') hands.targetL = 0; else hands.targetR = 0;
    if (onPickupCb) {
      try { onPickupCb(pk.itemId, pk.label); } catch (e) {}
    }
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

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 2, 14);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 50);
    camera.rotation.order = 'YXZ';

    raycaster = new THREE.Raycaster();
    ndc = new THREE.Vector2();

    colliders.length = 0;
    texturedMats.length = 0;
    buildRoom();
    buildFurniture();
    buildLights();
    buildEnemy();
    buildHands();
    buildPickups();

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
    eyeH = EYE_HEIGHT;
    hands.targetL = 0; hands.targetR = 0;
    camera.position.set(pos.x, eyeH, pos.z);
    camera.rotation.set(pitch, yaw, 0);
  }

  // ---------------------------------------------------------------- input
  var PREVENT = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1 };

  function onKeyDown(e) {
    keys[e.code] = true;
    if (PREVENT[e.code]) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function onBlur() { keys = {}; }

  function isLocked() {
    return !!(canvas && document.pointerLockElement === canvas);
  }

  function onMouseMove(e) {
    if (!isLocked()) return;
    yaw -= (e.movementX || 0) * SENS;
    pitch -= (e.movementY || 0) * SENS;
    if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    if (pitch < -PITCH_MAX) pitch = -PITCH_MAX;
  }

  function onClick(e) {
    if (!running) return;
    if (isLocked()) {
      if (hovered) fireEngage();
      return;
    }
    // unlocked: allow direct click on the enemy mesh via raycast from the click point
    var r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && enemy.alive && !enemy.dissolving) {
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      camera.updateMatrixWorld();
      enemy.mesh.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      var hit = raycaster.intersectObject(enemy.mesh, false);
      if (hit.length && hit[0].distance <= ENGAGE_DIST) { fireEngage(); return; }
    }
    try { canvas.requestPointerLock(); } catch (err) {}
  }

  function fireEngage() {
    if (!enemy.alive || enemy.dissolving) return;
    if (elapsed < engageCooldown) return;
    engageCooldown = elapsed + 0.5;
    if (engageCb) engageCb();
  }

  /* LMB closes the left hand, RMB the right (spec §15). A grab starts when
     the crosshair rests on a glinting item in reach — the item is taken in
     the motion. The enemy keeps priority on plain left clicks (engage). */
  function onMouseDown(e) {
    if (!running) return;
    var side = e.button === 2 ? 'r' : (e.button === 0 ? 'l' : null);
    if (!side) return;
    if (side === 'l') hands.targetL = 1; else hands.targetR = 1;
    // grabs only while pointer-locked: unlocked clicks are aim-lock requests,
    // and the crosshair ray would not match where the user actually clicked
    if (isLocked() && !(hovered && side === 'l')) tryGrab(side); // engage wins the left hand
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

    // axis-separated AABB resolve (slide along surfaces)
    var i, c;
    var nx = pos.x + vel.x * dt;
    for (i = 0; i < colliders.length; i++) {
      c = colliders[i];
      if (nx + RADIUS > c.minX && nx - RADIUS < c.maxX &&
          pos.z + RADIUS > c.minZ && pos.z - RADIUS < c.maxZ) {
        if (vel.x > 0) nx = c.minX - RADIUS;
        else if (vel.x < 0) nx = c.maxX + RADIUS;
        else nx = (nx < (c.minX + c.maxX) / 2) ? c.minX - RADIUS : c.maxX + RADIUS;
      }
    }
    pos.x = nx;
    var nz = pos.z + vel.z * dt;
    for (i = 0; i < colliders.length; i++) {
      c = colliders[i];
      if (pos.x + RADIUS > c.minX && pos.x - RADIUS < c.maxX &&
          nz + RADIUS > c.minZ && nz - RADIUS < c.maxZ) {
        if (vel.z > 0) nz = c.minZ - RADIUS;
        else if (vel.z < 0) nz = c.maxZ + RADIUS;
        else nz = (nz < (c.minZ + c.maxZ) / 2) ? c.minZ - RADIUS : c.maxZ + RADIUS;
      }
    }
    pos.z = nz;

    // eye height (crouch lerp, spec §15) + head bob scaled by speed
    var targetEye = crouch ? CROUCH_EYE : EYE_HEIGHT;
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

  // ---------------------------------------------------------------- enemy
  function updateEnemy(dt) {
    if (enemy.dissolving) {
      enemy.dissolveT += dt / DISSOLVE_SECS;
      var t = Math.min(1, enemy.dissolveT);
      enemy.mesh.scale.set(enemy.baseScaleX * (1 - 0.55 * t), enemy.baseScaleY * (1 - 0.35 * t), 1);
      enemy.mat.uniforms.flicker.value = (1 - t) * (0.7 + 0.3 * Math.random());
      enemy.glow.material.opacity = 0.5 * (1 - t);
      enemy.light.intensity = ((data.lights && data.lights.enemy && data.lights.enemy.intensity) || 0.7) * (1 - t);
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
    enemy.light.intensity = (data.lights && data.lights.enemy && data.lights.enemy.intensity) || 0.7;
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
    var was = hovered, wasDist = enemyDist;
    enemyDist = currentEnemyDist();
    if (enemy.alive && !enemy.dissolving) {
      camera.updateMatrixWorld();
      enemy.mesh.updateMatrixWorld();
      raycaster.setFromCamera(ZERO2, camera);
      var hit = raycaster.intersectObject(enemy.mesh, false);
      hovered = !!(hit.length && hit[0].distance <= ENGAGE_DIST);
    } else {
      hovered = false;
    }
    if (hoverCb && (hovered !== was || (hovered && Math.abs(enemyDist - wasDist) > 0.05))) {
      try { hoverCb(hovered, enemyDist); } catch (e) {}
    }
    // pickup hover (for the HUD "grab" hint) — enemy hover wins
    if (!hovered && !grab) {
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
    // TV static: texture offset jitter each frame + brightness flicker
    if (tvScreen.mat) {
      if (tvScreen.tex) tvScreen.tex.offset.set(Math.random() * 0.5, Math.random() * 0.5);
      var v = 0.75 + 0.35 * Math.random();
      if (tvScreen.tex) tvScreen.mat.color.setScalar(v);
      else tvScreen.mat.color.setRGB(0.16 * v, 0.19 * v, 0.22 * v);
    }
  }

  // ---------------------------------------------------------------- loop
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000)) || 0.016;
    lastTime = now;
    elapsed += dt;
    updatePlayer(dt);
    updateEnemy(dt);
    updateHover();
    updateHands(dt);
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
    vel.x = 0; vel.z = 0;
    finishGrab();                       // an in-flight grab still delivers
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

  // Put the player back at the spawn point (used on new-run resets, spec §14).
  // Pickups respawn with the run.
  W.resetPlayer = function () {
    if (disabled || !inited) return;
    resetPlayer();
    buildPickups();
  };

  W.onEngage = function (cb) { engageCb = typeof cb === 'function' ? cb : null; };

  // Fired when a hand finishes taking an item: cb(itemId, label).
  W.onPickup = function (cb) { onPickupCb = typeof cb === 'function' ? cb : null; };

  // Optional hint hook for the UI ("click to engage" line): cb(hovering, dist)
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

  W.debug = function () {
    if (!inited) return deadDebug();
    var out = [];
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      out.push({ kind: c.kind, minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ });
    }
    return {
      x: pos.x, z: pos.z, yaw: yaw, pitch: pitch,
      locked: isLocked(),
      enemyDist: currentEnemyDist(),
      enemyAlive: enemy.alive,
      enemyHovered: hovered,
      crouch: !!(keys.ControlLeft || keys.ControlRight || keys.KeyC),
      eye: eyeH,
      pickupHover: pickupHover,
      pickupsLeft: pickups.filter(function (p) { return !p.taken; }).length,
      hands: { l: hands.closeL, r: hands.closeR, grabbing: grab ? grab.hand : null },
      colliders: out
    };
  };
})();
