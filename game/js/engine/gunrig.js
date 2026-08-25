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
  function buildHand(L) {
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
    thumb.position.set(-0.030 * s, 0.012 * s, -0.008 * s);
    thumb.rotation.z = 0.45;
    g.add(thumb);

    /* Forearm receding toward the bottom-right of the frame. Ends at camera
       z = -0.135 with the default placement — the near plane is 0.05, and the
       margin is deliberate because recoil pulls this end another 20mm back. */
    var arm = new THREE.Mesh(new THREE.BoxGeometry(0.072 * s, 0.072 * s, 0.140 * s), mat);
    arm.position.set(0.020 * s, -0.075 * s, 0.095 * s);
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

    rig.root = new THREE.Group();
    rig.root.name = 'GunRig';
    rig.recoil = new THREE.Group();
    rig.recoil.name = 'GunRecoil';
    /* The grip goes where the hand is. Everything else — muzzle included —
       falls out of the model's own geometry from there, which is the only
       reason the muzzle offset never needs hand-tuning. */
    rig.recoil.position.set(cfg.x, cfg.y, cfg.z);
    rig.recoil.rotation.z = cfg.roll || 0;
    rig.root.add(rig.recoil);
    rig.root.visible = false;
    camera.add(rig.root);
    if (scene.children.indexOf(camera) === -1) scene.add(camera);

    if (cfg.hand) { rig.hand = buildHand(cfg.length); rig.recoil.add(rig.hand); }

    rig.mounted = true;
    rig.requested = true;

    var loader = opts.loader;
    if (!loader || !opts.url) {
      /* No GLTFLoader, or no path in data/arena3d.js: keep the fist and the
         muzzle maths, skip the pistol. The fallback muzzle below is still
         exact for the tracer, which is what §29 actually needs. */
      if (typeof opts.onDone === 'function') opts.onDone('skipped');
      return true;
    }

    loader.load(opts.url, function (gltf) {
      try {
        var model = gltf.scene;
        model.scale.setScalar(cfg.length);   // the GLB is normalised to 1m
        var grip = findNode(model, 'Grip');
        var gl = grip ? grip.position.clone() : new THREE.Vector3().fromArray(cfg.gripLocal);
        /* Shift the model so its GRIP lands on the recoil group's origin. Read
           from the node when it is there; the numbers in DEFAULTS are only the
           net if a re-export drops the empties. */
        rig.gripLocal = [gl.x, gl.y, gl.z];   // kept so _place() can re-scale
        model.position.set(-gl.x * cfg.length, -gl.y * cfg.length, -gl.z * cfg.length);
        model.traverse(dress);
        rig.recoil.add(model);
        rig.model = model;
        rig.muzzleNode = findNode(model, 'Muzzle');
        if (rig.muzzleNode) {
          /* Adopt the ASSET's numbers over the authored ones, for both halves
             that use them: the fallback path stays right if the node is ever
             detached, and debug().muzzleCam stops describing a gun we are no
             longer drawing. */
          cfg.muzzleLocal = rig.muzzleNode.position.toArray();
          cfg.gripLocal = [gl.x, gl.y, gl.z];
        } else {
          console.warn('[gunrig] no Muzzle node in the GLB — tracer falls back to the authored offset');
        }
        rig.loaded = true;
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
  /* One impulse into the recoil spring. Idempotent inside REFIRE_MS: the cast
     hook in arena3d calls this for you, and a tracer author who also calls it
     by hand should get one kick, not two. A real double-tap is slower than
     30ms — the gun's own cooldownMs is the fire rate, and it is far longer. */
  G.fire = function () {
    if (lastFireT >= 0 && (clock - lastFireT) * 1000 < REFIRE_MS) return false;
    lastFireT = clock;
    kickV += KICK_IMPULSE;
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

    // re-ask combat3 four times a second; it walks arrays, and nothing here
    // changes between frames
    if (equipped === null) {
      equipCheckT -= dt;
      if (equipCheckT <= 0) { equipCheckT = 0.25; rig.equipCache = askEquipped(); }
    }
    var want = (equipped === null) ? !!rig.equipCache : equipped;
    visible = want && !state.armsBusy;
    rig.root.visible = visible;

    // recoil spring — integrated even while hidden so re-showing is never mid-kick
    kickV += (-KICK_STIFF * kick - KICK_DAMP * kickV) * dt;
    kick += kickV * dt;
    if (Math.abs(kick) < 1e-4 && Math.abs(kickV) < 1e-3) { kick = 0; kickV = 0; }

    if (!visible) return;

    /* Walk sway, synced to the camera's bob phase and damped by `swayAmp`.
       Same discipline as the dressing-room hands: the prop must breathe when
       you stand still and swing when you run, or it looks painted on the
       glass. Sprint widens it; crouch halves it. */
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

    /* Rotational lag: a world-space quaternion chases the camera at ~11/s and
       the group's LOCAL rotation is whatever delta is left over. This is the
       one trick that stops a camera-parented prop feeling welded to the
       screen — the gun swings a little wide when you whip the mouse and
       catches up after. */
    _lag.slerp(camera.quaternion, Math.min(1, 11 * dt));
    _q.copy(camera.quaternion).invert();
    rig.root.quaternion.multiplyQuaternions(_q, _lag);

    /* The kick itself, about the GRIP: back into the hand, up a little, and a
       muzzle rise. Positive rotation.x lifts the -Z axis, so this is the
       barrel climbing — and muzzleDir() reports it, which is why that function
       carries a warning. */
    rig.recoil.position.set(cfg.x, cfg.y + kick * 0.016, cfg.z + kick * 0.042);
    rig.recoil.rotation.set(kick * 0.16, 0, (cfg.roll || 0) - kick * 0.05);

    /* Publish the muzzle. updateWorldMatrix walks ancestors then this subtree
       only — the renderer's own pass has not run yet this frame, and calling
       camera.updateMatrixWorld(true) here would re-walk the punch rig's 147
       bones for nothing. */
    camera.updateWorldMatrix(true, false);
    rig.root.updateWorldMatrix(false, true);
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
    if (rig.muzzleNode) { rig.muzzleNode.getWorldPosition(out); return out; }
    var L = cfg.length, m = cfg.muzzleLocal, g = cfg.gripLocal;
    /* Case 2 goes through the SAME group the pistol would hang off, not
       straight off the camera. The grip carries a few degrees of cant and the
       recoil kick, and measured against case 1 that is 4mm of horizontal
       difference at rest and more mid-kick — small, but it is the difference
       between "the tracer leaves the barrel" and "the tracer leaves roughly
       where the barrel is", which is the distinction §29 is about. */
    if (rig.recoil) {
      out.set((m[0] - g[0]) * L, (m[1] - g[1]) * L, (m[2] - g[2]) * L);
      camera.updateWorldMatrix(true, false);
      rig.root.updateWorldMatrix(false, true);
      return rig.recoil.localToWorld(out);
    }
    if (!camera) return out.set(0, 0, 0);   // not mounted at all
    out.set(cfg.x + (m[0] - g[0]) * L, cfg.y + (m[1] - g[1]) * L, cfg.z + (m[2] - g[2]) * L);
    camera.updateWorldMatrix(true, false);
    return out.applyMatrix4(camera.matrixWorld);
  };

  /* The barrel's world -Z, recoil included. For orienting a flash — NOT for
     deciding hits; see the header. */
  G.muzzleDir = function (out) {
    out = out || V3();
    var src = rig.muzzleNode || rig.recoil || camera;
    if (!src) return out.set(0, 0, -1);
    src.getWorldDirection(out);
    /* getWorldDirection returns +Z in r128; the barrel is -Z by the asset
       contract, so flip it. Getting this sign wrong fires backwards, which is
       exactly the failure the converter refused to leave to a note. */
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
      loaded: !!rig.loaded,          // false = degraded to no pistol, by design
      hand: !!rig.hand,
      muzzleNode: !!rig.muzzleNode,  // false = muzzle() is the authored fallback
      visible: visible,
      equipped: (equipped === null) ? !!rig.equipCache : equipped,
      forced: equipped !== null,
      length: cfg.length,
      grip: [cfg.x, cfg.y, cfg.z],
      kick: +kick.toFixed(4),
      muzzle: [m.x, m.y, m.z],
      /* The nominal camera-space muzzle, WITHOUT the cant or the kick — it is
         here to answer "is the barrel in front of the near plane?" and to be
         comparable frame to frame, which the live number deliberately is not. */
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
             hand: rig.hand, muzzle: rig.muzzleNode, camera: camera };
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
      /* The grip offset is in the SAME metres, so re-scaling the model without
         re-scaling this slides the pistol out of the fist — the fist would
         stay put and the gun would drift forward. */
      var g = rig.gripLocal || cfg.gripLocal;
      rig.model.position.set(-g[0] * length, -g[1] * length, -g[2] * length);
      if (rig.hand) {
        rig.recoil.remove(rig.hand);
        rig.hand = buildHand(length);
        rig.recoil.add(rig.hand);
      }
    }
    rig.recoil.position.set(x, y, z);
    rig.recoil.rotation.z = cfg.roll || 0;
    rig.root.visible = true;
    visible = true;
    return G.debug();
  };

  return G;
})();
