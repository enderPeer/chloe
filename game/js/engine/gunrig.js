/* CHLOE — engine/gunrig.js
   The 9mm as a first-person prop (§29). Mounted on the ARENA camera the way
   §17 mounts the punch rig, and owning exactly three jobs: hold the pistol
   where a hand would hold it, kick it when it fires, and — the load-bearing
   one — publish the MUZZLE's world position every frame so the tracer and the
   flash start at the barrel instead of at the middle of the screen.

   Why its own file rather than more of engine/arena3d.js: arena3d is 240KB and
   its ability/hit-test half is being worked on in parallel. Everything here is
   presentation, so it costs arena3d four call sites and nothing else.

   API — CHLOE.engine.gunrig
     mount(opts)          {camera, scene, url, loader, place?} → true if it took
     unmount()            drop the prop and forget the camera
     tick(dt, state)      once per frame, AFTER the camera has been placed
     fire()               one recoil impulse
     noteCast(abilityId)  the cast hook; kicks only for a gun ability
     muzzleWorld(out)     THREE.Vector3 world position of the bore — SEE BELOW
     muzzleDir(out)       the barrel's world -Z, recoil included
     muzzle()             the same point as a plain {x,y,z}, for tests/JSON
     setEquipped(v)       true / false / null = decide it from combat3
     debug()              one object with every number a verifier wants

   THE MUZZLE CONTRACT, because getting this wrong is the whole point of §29:
     * `muzzleWorld()` ALWAYS returns a usable point. With the GLB loaded it is
       the `Muzzle` node the converter derived from the bore ring; without it,
       it is the same offset computed from the numbers below. A tracer that
       cannot find the barrel must still leave the right part of the screen.
     * The tracer should be drawn muzzleWorld() → impact point. The HIT TEST is
       not ours: it belongs to the camera's own aim ray, which is where the
       crosshair is. The barrel sits right and below the lens, so those two
       lines converge — that is correct, and it is how the shot reads as coming
       from the gun rather than from the player's forehead.
     * `muzzleDir()` is the barrel's axis WITH recoil in it, so it drifts up
       for ~0.3s after a shot. Use it to orient a flash sprite; do not decide
       hits with it, or a fast second shot lands above what you aimed at. */
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.gunrig = (function () {
  'use strict';

  var G = {};

  /* ------------------------------------------------------------- placement
     The converter (tools/convert-gun9mm.py) hands us a very specific asset,
     and every number here leans on that contract:
       * Y-up, metres, barrel down -Z — THREE's own forward, so an identity
         quaternion already points where the player looks.
       * NORMALISED: the barrel-axis extent is exactly 1.000m and the origin is
         the bbox centre. `scale.setScalar(L)` therefore makes the pistol L
         metres long with no Box3 pass and no magic constant — which is why
         `length` below is in real metres and means what it says.
       * `Muzzle` and `Grip` empties, no rotation, at the bore and in the fist.

     `length` 0.22m against a real Glock's 0.186m: first-person props are drawn
     a touch large or they read as a toy at 72° FOV. The rest is where the GRIP
     goes in camera space — not where the model's centre goes — because the
     grip is what a hand is holding and what recoil rotates about.

     Near plane is 0.05 (arena3d). The rearmost geometry sits 0.167×L = 0.037m
     behind the grip, i.e. camera z = -0.263, and the forearm stub stops at
     -0.135. Nothing here comes within 0.08m of the lens. */
  var DEFAULTS = {
    length: 0.22,          // metres, muzzle to backstrap
    x: 0.17,               // grip position, camera space (+x right)
    y: -0.19,              // ...below the eye
    z: -0.30,              // ...and out in front
    roll: -0.05,           // a few degrees of cant, so it is not a diagram
    hand: true,            // draw a fist round the grip (see buildHand)
    swayAmp: 1,            // multiplier on the walk sway; 0 welds it to the screen
    abilityId: 'gun_9mm',  // which cast makes it kick, and what "equipped" means

    /* Fallbacks ONLY. The `Muzzle`/`Grip` nodes in the GLB win whenever they
       are there; these are the converter's reported values, kept so a missing
       or renamed node degrades to a close-enough point instead of to (0,0,0)
       — a tracer from the player's chest is worse than one from 3mm off. */
    muzzleLocal: [-0.0003, 0.2514, -0.5],
    gripLocal: [-0.0001, -0.1312, 0.3331]
  };

  function place() {
    var d = (CHLOE.data && CHLOE.data.arena3d && CHLOE.data.arena3d.gunProp) || {};
    var out = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) {
      out[k] = (d[k] !== undefined) ? d[k] : DEFAULTS[k];
    }
    return out;
  }

  /* ------------------------------------------------------- §28's name trap
     THREE's GLTFLoader runs every node name through PropertyBinding
     .sanitizeNodeName, which turns whitespace into '_' and DELETES '[ ] . / :'.
     §28 lost a whole feature to a lookup that compared the name in the file
     against the name in the scene graph. The converter asserts its names are
     fixed points of this, so today `Muzzle` is `Muzzle` — but the assertion
     lives in another repo half, so normalise BOTH sides here and the day
     someone re-exports from a DCC that prefixes `Armature:Muzzle` we keep
     finding it instead of silently falling back. */
  function sanitize(name) {
    return String(name || '').replace(/\s/g, '_').replace(/[[\]./:]/g, '');
  }
  function findNode(root, want) {
    var target = sanitize(want), exact = null, tail = null;
    root.traverse(function (o) {
      var n = sanitize(o.name);
      if (!exact && n === target) exact = o;
      /* Second chance, and the reason the trap bites twice: a DCC that exports
         `Armature:Muzzle` loses the colon here too, leaving `ArmatureMuzzle` —
         which is not the name we asked for and is not a name anyone would
         think to ask for. Sanitising both sides catches the case where WE hold
         the qualified name; this catches the case where the FILE does. Only
         for a distinctive token like Muzzle or Grip, where a tail match cannot
         reasonably mean something else. */
      if (!tail && n.length > target.length && n.slice(-target.length) === target) tail = o;
    });
    return exact || tail;
  }

  // ------------------------------------------------------------------ state
  var camera = null, scene = null;
  var rig = {
    root: null,      // sway + rotational lag live here
    recoil: null,    // sits AT THE GRIP, so the kick rotates about the fist
    model: null,     // the GLB, offset so its Grip lands on recoil's origin
    hand: null,
    muzzleNode: null,
    gripLocal: null,      // the Grip node's own position, in normalised units
    equipCache: false,    // last answer from askEquipped(); re-asked 4x/second
    loaded: false, mounted: false, requested: false
  };
  /* Akimbo: a second pistol mirrored on the left hand.  Shares the loaded
     GLB (cloned at mount time) and the same recoil spring constants but has
     its own kick state so the two guns alternate independently. */
  var rigL = {
    root: null, recoil: null, model: null, hand: null,
    muzzleNode: null, gripLocal: null,
    loaded: false
  };
  var kickL = 0, kickVL = 0;
  var lastGun = 0;       // 0 = right, 1 = left — alternates on each fire

  var cfg = place();
  var visible = false;
  var equipped = null;        // null = ask combat3; true/false = forced
  var equipCheckT = 0;

  // recoil as a damped spring: an impulse, an overshoot, a settle
  var kick = 0, kickV = 0;
  var lastFireT = -1, clock = 0;
  /* Measured, not guessed (headless harness, 60Hz): impulse 22 peaks the
     spring at 0.56 about 0.09s in, which the transforms in tick() turn into
     ~5.1° of muzzle rise, 23mm of travel back into the hand and 9mm up. It
     crosses zero at ~0.28s, dips 0.17° under, and is gone by ~0.5s — a kick
     you read and a settle you feel, comfortably inside the gun's own fire rate
     rather than fighting it. */
  var KICK_IMPULSE = 22;      // rad/s into the spring
  var KICK_STIFF = 180;       // ω ≈ 13.4 rad/s
  var KICK_DAMP = 18;         // ζ ≈ 0.67 — one visible overshoot, settled ~0.35s
  var REFIRE_MS = 30;         // see fire(): two notifies of one shot is not two shots

  // scratch, allocated once — this runs every frame
  var _v = null, _q = null, _lag = null;

  function V3() { return new THREE.Vector3(); }

  // ------------------------------------------------------------------ build
  /* A bare fist, not a glove: the arena's punch rig is bare-armed skin at
     (0.27,0.18,0.15), and a leather glove appearing only when the gun is out
     would read as a costume change. Deliberately crude — it is 40 pixels of
     screen behind a pistol, and its whole job is that the gun is HELD rather
     than hovering. The forearm stub is the part that does that work: without
     something receding off the bottom of the frame, a hand alone floats too. */
  function buildHand(L, mirror) {
    /* Albedo measured, not picked. The punch arms' (0.27,0.18,0.15) is right
       for something on screen for 700ms; on a prop that is up the whole fight
       it rendered at mean luminance 0.76 against a 0.20 background — a glowing
       hand holding a black gun, which is the wrong way round. 0.08 puts it at
       0.47 in the Ring and 0.59 in the church: brighter than the room, dimmer
       than the pistol's highlights, and no longer the thing your eye goes to.
       Damping the environment on top is the same lesson as the punch arms and
       the dressing-room hands — skin at the lens takes the full key + IBL. */
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.08, 0.053, 0.044), roughness: 0.9, metalness: 0
    });
    if ('envMapIntensity' in mat) { mat.envMapIntensity = 0.06; mat.userData.envClamp = 0.06; }

    var g = new THREE.Group();
    var s = L / 0.22;   // everything below was eyeballed at length 0.22

    var palm = new THREE.Mesh(new THREE.SphereGeometry(0.045 * s, 10, 8), mat);
    palm.scale.set(0.85, 1.15, 0.7);
    palm.position.set(0, 0, 0.012 * s);
    g.add(palm);

    // four fingers curled onto the FRONT of the grip (-z is downrange)
    for (var i = 0; i < 4; i++) {
      var f = new THREE.Mesh(new THREE.BoxGeometry(0.052 * s, 0.016 * s, 0.028 * s), mat);
      f.position.set(0, (0.020 - i * 0.019) * s, -0.030 * s);
      f.rotation.x = -0.12;
      g.add(f);
    }
    // thumb across the inner face, toward the screen centre
    var thumb = new THREE.Mesh(new THREE.BoxGeometry(0.018 * s, 0.050 * s, 0.020 * s), mat);
    thumb.position.set((mirror ? 0.030 : -0.030) * s, 0.012 * s, -0.008 * s);
    thumb.rotation.z = mirror ? -0.45 : 0.45;
    g.add(thumb);

    /* Forearm receding toward the bottom-right of the frame (or bottom-left
       for the mirrored left hand). Ends at camera z = -0.135 with the default
       placement — the near plane is 0.05, and the margin is deliberate because
       recoil pulls this end another 20mm back. */
    var arm = new THREE.Mesh(new THREE.BoxGeometry(0.072 * s, 0.072 * s, 0.140 * s), mat);
    arm.position.set((mirror ? -0.020 : 0.020) * s, -0.075 * s, 0.095 * s);
    arm.rotation.x = -0.45;
    g.add(arm);

    /* Dressed here rather than through dress() below, which exists for the
       PISTOL and would push this material's envMapIntensity back up to the
       steel setting — the arms would then blow out to white exactly as §17's
       did before it damped them. */
    g.traverse(function (o) {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      o.renderOrder = 900;   // behind the pistol, so fingers never z-fight the grip
    });
    return g;
  }

  function dress(o) {
    if (!o.isMesh) return;
    o.frustumCulled = false;    // it hugs the near plane; culling it is a flicker
    o.renderOrder = 901;        // just after the punch arms' 900
    var mats = Array.isArray(o.material) ? o.material : [o.material];
    for (var i = 0; i < mats.length; i++) {
      var m = mats[i];
      if (!m) continue;
      /* THE RING SHIPS NO ENV PROBE, and that is what these two numbers are
         about. data/stages.js gives the Ring `hdri: null`, so a fully metallic
         material — which is what the 9mm's metallic map makes it — has nothing
         to reflect and renders at mean luminance 0.13 against a 0.20 room: a
         black cut-out, in the stage the run STARTS in (§26). Damping metalness
         to 0.7 lets the arena's own key lights put a diffuse floor under it,
         which measures 0.23 in the Ring and 0.50 in the church, against
         backgrounds of 0.20 and 0.29 — dark steel with live highlights either
         way, rather than steel in one stage and a hole in the other.
         The honest alternative was baking the prop its own PMREM probe so it
         could stay metalness 1; that is more machinery for a 3% slice of the
         screen, and it would still need a fallback for a renderer that refuses
         the PMREM pass. `envClamp` is the flag arena3d's env pass honours, so
         the church resolving its HDRI mid-fight will not undo any of this. */
      if (typeof m.metalness === 'number' && m.metalness > 0.7) m.metalness = 0.7;
      if ('envMapIntensity' in m) { m.envMapIntensity = 0.35; m.userData.envClamp = 0.35; }
    }
  }

  // ------------------------------------------------------------------ mount
  /* opts: { camera, scene, url, loader, place? }
     Returns false and stays quiet for every missing precondition — §29's rule
     is that a missing asset costs the PROP, never the shot. */
  G.mount = function (opts) {
    opts = opts || {};
    if (typeof THREE === 'undefined') return false;
    if (!opts.camera || !opts.scene) return false;
    if (rig.requested) return rig.mounted;

    camera = opts.camera;
    scene = opts.scene;
    cfg = place();
    if (opts.place) for (var k in opts.place) if (opts.place.hasOwnProperty(k)) cfg[k] = opts.place[k];

    _v = V3(); _q = new THREE.Quaternion(); _lag = camera.quaternion.clone();

    /* --- right gun (original) --- */
    rig.root = new THREE.Group();
    rig.root.name = 'GunRig';
    rig.recoil = new THREE.Group();
    rig.recoil.name = 'GunRecoil';
    rig.recoil.position.set(cfg.x, cfg.y, cfg.z);
    rig.recoil.rotation.z = cfg.roll || 0;
    rig.root.add(rig.recoil);
    rig.root.visible = false;
    camera.add(rig.root);
    if (scene.children.indexOf(camera) === -1) scene.add(camera);

    if (cfg.hand) { rig.hand = buildHand(cfg.length, false); rig.recoil.add(rig.hand); }

    /* --- left gun (akimbo mirror) --- */
    rigL.root = new THREE.Group();
    rigL.root.name = 'GunRigL';
    rigL.recoil = new THREE.Group();
    rigL.recoil.name = 'GunRecoilL';
    rigL.recoil.position.set(-cfg.x, cfg.y, cfg.z);
    rigL.recoil.rotation.z = -(cfg.roll || 0);
    rigL.root.add(rigL.recoil);
    rigL.root.visible = false;
    camera.add(rigL.root);

    if (cfg.hand) { rigL.hand = buildHand(cfg.length, true); rigL.recoil.add(rigL.hand); }

    rig.mounted = true;
    rig.requested = true;

    var loader = opts.loader;
    if (!loader || !opts.url) {
      if (typeof opts.onDone === 'function') opts.onDone('skipped');
      return true;
    }

    loader.load(opts.url, function (gltf) {
      try {
        var model = gltf.scene;
        model.scale.setScalar(cfg.length);
        var grip = findNode(model, 'Grip');
        var gl = grip ? grip.position.clone() : new THREE.Vector3().fromArray(cfg.gripLocal);
        rig.gripLocal = [gl.x, gl.y, gl.z];
        model.position.set(-gl.x * cfg.length, -gl.y * cfg.length, -gl.z * cfg.length);
        model.traverse(dress);
        rig.recoil.add(model);
        rig.model = model;
        rig.muzzleNode = findNode(model, 'Muzzle');
        if (rig.muzzleNode) {
          cfg.muzzleLocal = rig.muzzleNode.position.toArray();
          cfg.gripLocal = [gl.x, gl.y, gl.z];
        } else {
          console.warn('[gunrig] no Muzzle node in the GLB — tracer falls back to the authored offset');
        }
        rig.loaded = true;

        /* Clone for the left (akimbo) hand — same model, mirrored grip offset. */
        var modelL = gltf.scene.clone();
        modelL.scale.setScalar(cfg.length);
        modelL.position.set(gl.x * cfg.length, -gl.y * cfg.length, -gl.z * cfg.length);
        modelL.traverse(dress);
        rigL.recoil.add(modelL);
        rigL.model = modelL;
        rigL.muzzleNode = findNode(modelL, 'Muzzle');
        rigL.gripLocal = rig.gripLocal;
        rigL.loaded = true;
      } catch (e) {
        console.warn('[gunrig] mount failed — no visible pistol', e);
      }
      if (typeof opts.onDone === 'function') opts.onDone(rig.loaded ? 'ok' : 'failed');
    }, undefined, function () {
      console.warn('[gunrig] gun9mm.glb failed to load — no visible pistol, the shot still fires');
      if (typeof opts.onDone === 'function') opts.onDone('failed');
    });
    return true;
  };

  G.unmount = function () {
    if (rig.root && rig.root.parent) rig.root.parent.remove(rig.root);
    rig.root = rig.recoil = rig.model = rig.hand = rig.muzzleNode = null;
    rig.loaded = rig.mounted = rig.requested = false;
    if (rigL.root && rigL.root.parent) rigL.root.parent.remove(rigL.root);
    rigL.root = rigL.recoil = rigL.model = rigL.hand = rigL.muzzleNode = null;
    rigL.loaded = false;
    kickL = kickVL = 0; lastGun = 0;
    camera = scene = null;
    visible = false;
    kick = kickV = 0;
  };

  /* Which cast is OURS. arena3d asks so it can tell "the arms are swinging a
     fist" (hide the pistol) from "the arms are swinging because the pistol
     just went off" (do not hide the thing that fired). */
  G.abilityId = function () { return cfg.abilityId; };

  G.isMounted = function () { return !!rig.mounted; };
  G.isLoaded = function () { return !!rig.loaded; };
  G.visible = function () { return visible; };

  // -------------------------------------------------------------- equipped?
  /* "Is the pistol in your hand right now" is a question about the RUN, not
     about the asset: the gun unlocks at level 5 and auto-binds to a mouse
     button (§29). Every lookup below is optional-chained by hand, so a build
     without abilities.js, without combat3, or before a fight starts answers
     "no" rather than throwing into the frame loop. */
  function askEquipped() {
    var id = cfg.abilityId;
    var abilities = (CHLOE.data && CHLOE.data.abilities) || null;
    if (!abilities || !abilities[id]) return false;   // the ability does not exist yet
    var c3 = (CHLOE.engine && CHLOE.engine.combat3) || null;
    if (!c3) return false;

    /* BOUND somewhere is the honest test, not merely known: unbinding the gun
       should take it out of your hand. Both lists have to be read, because
       combat3 deliberately keeps the mouse slots OUT of `slots()` (§27B — the
       hotbar presses by array index, so appending two buttons to it would turn
       them into press(9) and press(10)), and the mouse is exactly where §29
       puts this ability. */
    function bound(list) {
      for (var i = 0; i < (list || []).length; i++) {
        var e = list[i];
        if (e && (e.id === id || e.entry === id || e.ability === id)) return true;
      }
      return false;
    }
    try {
      var keySlots = (typeof c3.slots === 'function') ? (c3.slots() || []) : [];
      var mouse = (typeof c3.mouseSlots === 'function') ? (c3.mouseSlots() || []) : [];
      /* Both lists are empty outside a fight — they price readiness against
         live pools, which only exist while one is running. So an empty pair is
         "no fight", not "not bound", and only then do we fall back to what the
         character KNOWS. Inside a fight the slots are authoritative, which is
         what makes an unbind visible. */
      if (keySlots.length || mouse.length) return bound(keySlots) || bound(mouse);
    } catch (e1) {}
    try {
      var p = CHLOE.engine.party;
      var m = p && typeof p.active === 'function' ? p.active() : null;
      if (m && typeof c3.knownAbilities === 'function') {
        return c3.knownAbilities(m.id).indexOf(id) !== -1;
      }
    } catch (e2) {}
    return false;
  }

  /* true / false pins it; null hands the decision back to combat3. */
  G.setEquipped = function (v) {
    equipped = (v === null || v === undefined) ? null : !!v;
    equipCheckT = 0;
  };

  // ------------------------------------------------------------------- fire
  /* One impulse into the recoil spring of whichever hand is next.  Alternates
     left/right on each pull so the player sees both guns kicking. */
  G.fire = function () {
    if (lastFireT >= 0 && (clock - lastFireT) * 1000 < REFIRE_MS) return false;
    lastFireT = clock;
    lastGun = lastGun ? 0 : 1;
    if (lastGun === 0) { kickV += KICK_IMPULSE; }
    else               { kickVL += KICK_IMPULSE; }
    return true;
  };

  /* The hook arena3d's cast path calls. Only OUR ability kicks — the punch and
     the spells drive the §17 arms, and a pistol jumping when you throw a rock
     is the kind of wrong that is hard to name and impossible to unsee. */
  G.noteCast = function (abilityId) {
    if (!abilityId || abilityId !== cfg.abilityId) return false;
    return G.fire();
  };

  // ------------------------------------------------------------------- tick
  /* Call once per frame AFTER the camera has been moved for this frame, or the
     muzzle published below is one frame stale — which on a hitscan weapon is a
     tracer that starts where you were, not where you are.

     state: { speed, bobPhase, elapsed, crouch, sprinting, armsBusy }
       speed/bobPhase   the walk sway rides the camera's OWN bob phase, so the
                        gun and the head move as one body (§14's hands rule)
       armsBusy         the punch rig is mid-swing — hide the pistol, because
                        fists and a drawn gun on screen together read as a bug */
  G.tick = function (dt, state) {
    if (!rig.root || !camera) return;
    dt = (typeof dt === 'number' && dt > 0) ? Math.min(0.05, dt) : 0.016;
    state = state || {};
    clock += dt;

    if (equipped === null) {
      equipCheckT -= dt;
      if (equipCheckT <= 0) { equipCheckT = 0.25; rig.equipCache = askEquipped(); }
    }
    var want = (equipped === null) ? !!rig.equipCache : equipped;
    visible = want && !state.armsBusy;
    rig.root.visible = visible;
    if (rigL.root) rigL.root.visible = visible;

    // recoil springs — both integrated even while hidden
    kickV += (-KICK_STIFF * kick - KICK_DAMP * kickV) * dt;
    kick += kickV * dt;
    if (Math.abs(kick) < 1e-4 && Math.abs(kickV) < 1e-3) { kick = 0; kickV = 0; }
    kickVL += (-KICK_STIFF * kickL - KICK_DAMP * kickVL) * dt;
    kickL += kickVL * dt;
    if (Math.abs(kickL) < 1e-4 && Math.abs(kickVL) < 1e-3) { kickL = 0; kickVL = 0; }

    if (!visible) return;

    var speed = state.speed || 0;
    var mul = (state.sprinting ? 1.5 : 1) * (state.crouch ? 0.5 : 1) * (cfg.swayAmp != null ? cfg.swayAmp : 1);
    var sx = 0, sy = 0;
    if (speed > 0.15) {
      var ph = state.bobPhase || 0;
      sx = Math.sin(ph) * 0.016 * mul;
      sy = Math.abs(Math.cos(ph)) * 0.012 * mul;
    }
    var breathe = Math.sin((state.elapsed || clock) * 1.7) * 0.0035 * (cfg.swayAmp != null ? cfg.swayAmp : 1);
    rig.root.position.set(sx, breathe + sy, 0);
    if (rigL.root) rigL.root.position.set(sx, breathe + sy, 0);

    _lag.slerp(camera.quaternion, Math.min(1, 11 * dt));
    _q.copy(camera.quaternion).invert();
    rig.root.quaternion.multiplyQuaternions(_q, _lag);
    if (rigL.root) rigL.root.quaternion.copy(rig.root.quaternion);

    // right gun kick
    rig.recoil.position.set(cfg.x, cfg.y + kick * 0.016, cfg.z + kick * 0.042);
    rig.recoil.rotation.set(kick * 0.16, 0, (cfg.roll || 0) - kick * 0.05);
    // left gun kick (mirrored x, negated roll)
    if (rigL.recoil) {
      rigL.recoil.position.set(-cfg.x, cfg.y + kickL * 0.016, cfg.z + kickL * 0.042);
      rigL.recoil.rotation.set(kickL * 0.16, 0, -(cfg.roll || 0) + kickL * 0.05);
    }

    camera.updateWorldMatrix(true, false);
    rig.root.updateWorldMatrix(false, true);
    if (rigL.root) rigL.root.updateWorldMatrix(false, true);
  };

  // ------------------------------------------------------------- the muzzle
  /* Where the bore is, in WORLD space. Never null, never (0,0,0):
       1. the `Muzzle` node, when the GLB gave us one — the converter derived
          it from the bore ring, not from the front of the bounding box;
       2. otherwise the authored offset, transformed off the live camera.
     Case 2 is the whole reason this returns a value at all when the asset is
     missing: the flash and the tracer still have somewhere honest to start. */
  G.muzzleWorld = function (out) {
    out = out || V3();
    /* Akimbo: return the muzzle of whichever gun last fired, so the tracer
       originates from the correct barrel. */
    var r = (lastGun === 0) ? rig : rigL;
    if (r.muzzleNode) { r.muzzleNode.getWorldPosition(out); return out; }
    var L = cfg.length, m = cfg.muzzleLocal, g = cfg.gripLocal;
    var signX = (lastGun === 0) ? 1 : -1;
    if (r.recoil) {
      out.set(signX * (m[0] - g[0]) * L, (m[1] - g[1]) * L, (m[2] - g[2]) * L);
      camera.updateWorldMatrix(true, false);
      r.root.updateWorldMatrix(false, true);
      return r.recoil.localToWorld(out);
    }
    if (!camera) return out.set(0, 0, 0);
    out.set(signX * cfg.x + signX * (m[0] - g[0]) * L, cfg.y + (m[1] - g[1]) * L, cfg.z + (m[2] - g[2]) * L);
    camera.updateWorldMatrix(true, false);
    return out.applyMatrix4(camera.matrixWorld);
  };

  /* The barrel's world -Z, recoil included. For orienting a flash — NOT for
     deciding hits; see the header. */
  G.muzzleDir = function (out) {
    out = out || V3();
    var r = (lastGun === 0) ? rig : rigL;
    var src = r.muzzleNode || r.recoil || camera;
    if (!src) return out.set(0, 0, -1);
    src.getWorldDirection(out);
    return out.multiplyScalar(-1);
  };

  /* The same point, plain, so a test can print it without importing THREE. */
  G.muzzle = function () {
    var v = G.muzzleWorld(_v || V3());
    return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
  };

  G.debug = function () {
    var m = G.muzzle();
    return {
      mounted: !!rig.mounted,
      loaded: !!rig.loaded,
      hand: !!rig.hand,
      muzzleNode: !!rig.muzzleNode,
      visible: visible,
      equipped: (equipped === null) ? !!rig.equipCache : equipped,
      forced: equipped !== null,
      length: cfg.length,
      grip: [cfg.x, cfg.y, cfg.z],
      kick: +kick.toFixed(4),
      kickL: +kickL.toFixed(4),
      lastGun: lastGun,
      muzzle: [m.x, m.y, m.z],
      muzzleCam: (function () {
        if (!camera) return null;
        var L = cfg.length, a = cfg.muzzleLocal, b = cfg.gripLocal;
        return [+(cfg.x + (a[0] - b[0]) * L).toFixed(4),
                +(cfg.y + (a[1] - b[1]) * L).toFixed(4),
                +(cfg.z + (a[2] - b[2]) * L).toFixed(4)];
      })()
    };
  };

  /* The live scene-graph nodes (test hook). The arena does not hand its camera
     out, so without this there is no way to measure the prop's on-screen box
     or its distance to the near plane from outside — which are exactly the two
     numbers §29's "sized and positioned so it reads as held, not clipping the
     camera near plane" is a claim about. */
  G._nodes = function () {
    return { root: rig.root, recoil: rig.recoil, model: rig.model,
             hand: rig.hand, muzzle: rig.muzzleNode, camera: camera,
             rootL: rigL.root, recoilL: rigL.recoil, modelL: rigL.model,
             handL: rigL.hand, muzzleL: rigL.muzzleNode };
  };

  /* The live materials, pistol first then fist (test hook). Sibling of
     `_place` and there for the same reason — the balance between a dark steel
     slide and a lit hand is a thing you measure off a rendered frame, not a
     thing you reason about, and re-deriving it should not need a reload. */
  G._materials = function () {
    var out = { gun: [], hand: [] };
    function walk(root, into) {
      if (!root) return;
      root.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) if (mats[i] && into.indexOf(mats[i]) === -1) into.push(mats[i]);
      });
    }
    walk(rig.model, out.gun);
    walk(rig.hand, out.hand);
    walk(rigL.model, out.gun);
    walk(rigL.hand, out.hand);
    return out;
  };

  /* Live placement tuning, the same test hook the punch rig got (§17's
     `_fpPlace`) and for the same reason: the right offset is much easier to
     find by looking than by arithmetic. */
  G._place = function (x, y, z, roll, length) {
    if (!rig.recoil) return null;
    cfg.x = x; cfg.y = y; cfg.z = z;
    if (roll != null) cfg.roll = roll;
    if (length != null && rig.model) {
      cfg.length = length;
      rig.model.scale.setScalar(length);
      var g = rig.gripLocal || cfg.gripLocal;
      rig.model.position.set(-g[0] * length, -g[1] * length, -g[2] * length);
      if (rig.hand) {
        rig.recoil.remove(rig.hand);
        rig.hand = buildHand(length, false);
        rig.recoil.add(rig.hand);
      }
      if (rigL.model) {
        rigL.model.scale.setScalar(length);
        rigL.model.position.set(g[0] * length, -g[1] * length, -g[2] * length);
      }
      if (rigL.hand) {
        rigL.recoil.remove(rigL.hand);
        rigL.hand = buildHand(length, true);
        rigL.recoil.add(rigL.hand);
      }
    }
    rig.recoil.position.set(x, y, z);
    rig.recoil.rotation.z = cfg.roll || 0;
    if (rigL.recoil) {
      rigL.recoil.position.set(-x, y, z);
      rigL.recoil.rotation.z = -(cfg.roll || 0);
    }
    rig.root.visible = true;
    if (rigL.root) rigL.root.visible = true;
    visible = true;
    return G.debug();
  };

  return G;
})();
