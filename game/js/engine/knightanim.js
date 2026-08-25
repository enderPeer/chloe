/* CHLOE — engine/knightanim.js   (knight animation, rigid-plate rig)
   Poses the knight built by data/knightrig.js. Knows Three.js; knows nothing
   about damage, hit tests or the HUD — engine/arena3d.js calls in at the
   phase boundaries it already computes, and this file only moves transforms.

   WHY PROCEDURAL AND NOT CLIPS
   knight.glb has skins:0 and animations:0: 103 mesh nodes, all flat siblings
   of the scene root, no joints, nothing to key an AnimationClip onto. The
   armour is plate, and plate does not deform, so every piece rides a rigid
   bone and the whole fight can be posed by transform. If the knight is ever
   properly rigged in Blender, this file is the thing you delete.

   TIMING IS NOT DUPLICATED HERE.
   Poses are keyed at normalized phase (0..1), never in milliseconds. The
   driver stretches them over whatever data/arena3d.js says telegraphMs,
   feint.holdMs, hits[].atMs and recoverMs are. That is deliberate: §21 of the
   spec records a fight lost because the picture and the damage were counting
   on two different clocks. There is exactly one clock, and it is the data.

   §28 B2 — THE ANGLES WERE RE-DERIVED, NOT NUDGED.
   Every pose below that holds or swings a sword was authored against a pivot
   that sat 0.129m off the blade's own centre line, so the numbers were
   silently compensating for a weapon that coned around a point beside itself.
   With the grip on the fist they played wrong in ways a measurement catches
   and an eye might not: the overhead finished with its point ABOVE his head
   on the frame the floor was supposed to be hit, both thrusts drove the point
   BACKWARD along its own axis, and `guard` held the blade horizontally across
   his chest. The ten attack keys and five of the holds were re-solved against
   TIP TARGETS measured in the knight's own frame, under real joint limits.
   The numbers each one produces are recorded next to it; re-measure them
   rather than trusting them if the rig is ever regenerated.

   AND THE BLEND RUNS ON QUATERNIONS. Interpolating euler triples channel by
   channel is fine for the small deltas locomotion uses and wrong for the
   large ones an attack needs — euler space is not flat, so a lerp between two
   distant orientations walks through poses that lie nowhere near the arc
   between them. Measured on the overhead: the tip covered 8.38m to travel
   3.19m. Slerping the end orientations makes the arc the shortest rotation
   between them by construction, which is what "an arc centred on the grip"
   means. See blendPose.

   §28 C — THE §22 LIBRARY LIVES HERE NOW.
   This file used to ship only idle, the five attack pairs, a flinch and a
   static `dead`. §18/§22 had also built strafe, backpedal, turnInPlace,
   taunt, stagger and a staged collapse death against the OLD sibling pivots,
   and adopting the new hierarchy is not allowed to lose them. They are ported
   below as `LOCO` — parametric poses, because a stride, a decaying recoil and
   a three-beat collapse are curves, not single keys. They read better here
   than they did on siblings: there is a real `hips` bone, so the dress and
   belt travel with the stride (§22 had to cap boot swing at 0.28rad because
   the hem was static and the boots swung out from under it), and `torso`
   leans propagate into head and arms instead of three bones being posed to
   agree by hand. Head and arm angles are therefore RELATIVE to the parent
   they now hang off — a §22 number copied across unchanged would double up.

   API   CHLOE.engine.knightanim
     build(model, THREE)     -> rig   reparents model's meshes onto bones
     setRootRest(rig, x,y,z)          where the rig sits before any pose
     play(rig, patternId)             begin a swing
     phase(rig, name, t01, opts)      'telegraph'|'hold'|'strike'|'recover'
     pose(rig, id, opts)              any non-swing state (see poseIds())
     flinch(rig, amount)              §22 hit flinch, laid OVER the pose
     die(rig, t01, opts) / reset(rig)
     update(rig, dt)                  call every frame, last
     poseIds()                        every id pose() resolves
*/
window.CHLOE = window.CHLOE || {};
CHLOE.engine = CHLOE.engine || {};

CHLOE.engine.knightanim = (function () {
  'use strict';

  var D = Math.PI / 180;
  var ZERO = [0, 0, 0];

  /* THREE.PropertyBinding.sanitizeNodeName, restated so both sides of a
     manifest lookup can be pushed through it — see build(). Whitespace becomes
     an underscore and the four characters the animation-binding syntax
     reserves (`[ ] . : /`) are deleted. Idempotent by construction, so it is
     safe to apply to a name that has already been through the loader. */
  function nameKey(s) {
    return String(s).replace(/\s/g, '_').replace(/[\[\]\.\:\/]/g, '');
  }

  /* ---------- rig construction ---------- */

  /* Reparent every mesh in the loaded GLB onto its bone. Bones are empty
     Groups positioned at the joint centre; a mesh keeps its world transform
     by being offset against the pivot, so nothing visibly moves at build
     time — build() then play() with no update must look identical to the
     untouched model. That property is what makes this safe to ship behind a
     flag.

     CALL THIS ON THE UNSCALED MODEL. The pivots in data/knightrig.js are in
     NATIVE model metres (crown 1.78 against a measured crown of 1.832); the
     mesh offsets computed here are native too, and the two only stay in step
     if the normalising scale goes on `rig.root` afterwards. Scaling the model
     first and rigging second is the §17 "Box3 lies" bug class — the pivots
     stay 1.833m tall while the plate grows to 2.15m. */
  function build(model, THREE) {
    var def = (CHLOE.data && CHLOE.data.knightRig) || null;
    if (!def) { console.warn('[knightanim] data/knightrig.js missing — knight stays static'); return null; }

    /* The header's totem clause, CHECKED rather than merely described. When
       knight.glb is slow, engine/arena3d.js stands a box-and-sword totem in
       the fight and rigs it like anything else — and the miss report below,
       which exists to catch a stale manifest, could only see 103 lookups that
       failed and told the reader to regenerate a file that was correct. The
       totem says what it is (`buildFallbackKnight`), so this is a decline and
       not a diagnosis. No warning: nothing is wrong, the model just is not
       this manifest's model, and arena3d already falls back to the pre-§28
       placement on a null. */
    if (model && model.userData && model.userData.fallbackTotem) return null;

    var rig = { bones: {}, root: new THREE.Group(), state: null, t: 0, THREE: THREE,
                rootRest: new THREE.Vector3(0, 0, 0), drove: false };
    rig.root.name = 'knightRig';
    /* Scratch, allocated once per rig. commitPose runs over 11 bones every
       frame for every knight on the floor; a squad of six at 60fps is 4000
       Euler/Quaternion allocations a second if these are made inline. */
    rig._s = { e: new THREE.Euler(), q: new THREE.Quaternion(),
               q2: new THREE.Quaternion(), qb: new THREE.Quaternion(),
               qi: new THREE.Quaternion(), bq: {}, v: new THREE.Vector3() };

    var i, b;
    for (i = 0; i < def.bones.length; i++) {
      b = def.bones[i];
      var g = new THREE.Group();
      g.name = 'bone:' + b.id;
      g.position.set(b.pivot[0], b.pivot[1], b.pivot[2]);
      rig.bones[b.id] = { group: g, def: b, rest: null };
      rig._s.bq[b.id] = new THREE.Quaternion();
    }
    /* Express each pivot relative to its parent. Subtract the parent's PIVOT
       out of the data, never the parent group's current position: the parent
       is earlier in this same list, so by the time a child is reached the
       parent has already been made relative to ITS parent and subtracting it
       takes the grandparent out twice. Measured with that bug in: the head
       bone landed at y 2.740 against a pivot of 1.583, the crown rendered
       2.99m tall instead of 1.83, and the sword — five levels down, so the
       error compounds five times — sat 1.686m from the fist the grip was
       derived to sit ON. It is invisible at build time because the meshes are
       reparented by world matrix and therefore do not move; it only appears
       the first time a bone is ROTATED, which is the worst way to find it. */
    for (i = 0; i < def.bones.length; i++) {
      b = def.bones[i];
      var node = rig.bones[b.id].group;
      if (b.parent && rig.bones[b.parent]) {
        var pp = rig.bones[b.parent].def.pivot;
        node.position.set(b.pivot[0] - pp[0], b.pivot[1] - pp[1], b.pivot[2] - pp[2]);
        rig.bones[b.parent].group.add(node);
      } else {
        rig.root.add(node);
      }
      rig.bones[b.id].rest = node.position.clone();
    }

    /* Index the model's meshes by name once, then move them. A mesh listed in
       the manifest but absent from the GLB is a stale build, not a crash: warn
       and leave the rest of the rig working.

       MATCH ON THE SANITIZED NAME, NOT THE RAW ONE. The manifest is written by
       tools/build-knight-rig.js, which reads the .glb container directly and
       therefore records the node names EXACTLY as authored — every one of the
       103 carries a colon ("Crown:Group19458"). THREE's GLTFLoader does not:
       it runs every node name through PropertyBinding.sanitizeNodeName, which
       DELETES `[ ] . : /` outright, so the same mesh arrives in the scene as
       "CrownGroup19458". Measured before this fix: 103 of 103 lookups missed,
       build() bailed with "no meshes matched", and arena3d fell back to the
       unrigged model — §28's whole skeleton, the grip fix included, was dead
       in the browser while every offline check passed. Normalising BOTH sides
       through the same rule fixes it without teaching the generator a
       loader-specific quirk, and it is idempotent, so a manifest regenerated
       from an already-clean asset still matches. */
    var byName = {};
    model.traverse(function (o) {
      if (!o.isMesh) return;
      byName[o.name] = o;
      var k = nameKey(o.name);
      if (k !== o.name && !byName[k]) byName[k] = o;
    });
    /* Hand back the mesh AND retire both of its keys. The manifest is
       generated, but a hand-edit could list one mesh twice; `byName` would
       return the same object and the second bone.add() would silently steal it
       off the first bone. Retiring the name makes a duplicate a warning
       instead of a limb that quietly empties. */
    function takeMesh(name) {
      var o = byName[name] || byName[nameKey(name)];
      if (o) { delete byName[o.name]; delete byName[nameKey(o.name)]; }
      return o;
    }

    var moved = 0, missing = [], counts = {};
    for (var boneId in def.meshes) {
      if (!rig.bones[boneId]) continue;
      var bone = rig.bones[boneId].group;
      var list = def.meshes[boneId];
      counts[boneId] = 0;
      for (var m = 0; m < list.length; m++) {
        var mesh = takeMesh(list[m]);
        if (!mesh) { missing.push(list[m]); continue; }
        mesh.updateWorldMatrix(true, false);
        var world = mesh.matrixWorld.clone();
        bone.add(mesh);
        bone.updateWorldMatrix(true, false);
        var inv = new THREE.Matrix4().copy(bone.matrixWorld).invert();
        mesh.matrix.copy(inv.multiply(world));
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        counts[boneId]++;
        moved++;
      }
    }
    if (missing.length) {
      console.warn('[knightanim] ' + missing.length + ' mesh(es) in the manifest are not in the GLB — ' +
                   'rerun tools/build-knight-rig.js. First: ' + missing[0]);
    }
    if (!moved) { console.warn('[knightanim] no meshes matched — knight stays static'); return null; }

    rig.model = model;
    rig.counts = counts;
    rig.moved = moved;
    rig.missing = missing.length;
    snapshotRest(rig);
    reset(rig);
    return rig;
  }

  function snapshotRest(rig) {
    for (var id in rig.bones) {
      rig.bones[id].restQuat = rig.bones[id].group.quaternion.clone();
      rig.bones[id].restPos = rig.bones[id].group.position.clone();
    }
  }

  /* Where the root sits before any pose offset. arena3d puts the grounding
     and centring offset here — measured off the native bounding box and
     multiplied by the same scale it puts on rig.root — so a pose's `_root`
     stays a pure delta and nothing has to remember to add the floor back. */
  function setRootRest(rig, x, y, z) {
    if (!rig) return;
    rig.rootRest.set(x, y, z);
    rig.root.position.copy(rig.rootRest);
  }

  /* ---------- poses ----------
     A pose is euler degrees per bone, in the knight's own frame:
       +X = his left, +Y = up, +Z = forward (toward whoever he is facing).
     Anything not named returns to its rest transform. `_root` is an offset in
     metres ON TOP OF rootRest, used by the lunges and the body drop. Poses
     are intentionally exaggerated: at 3.4 m reach under fog, a readable
     silhouette beats an anatomically polite one.
     Rotation signs worth knowing before editing: an arm bone's children hang
     BELOW its pivot, so +X swings a limb backwards and -X swings it forward
     and up (overhead_wind's -158 is both arms over the head). Elbows flex
     forward on negative X. */
  var POSES = {
    idle: {
      torso: [2, 0, 0], head: [4, 0, 0],
      armR: [-14, 0, 12], forearmR: [-28, 0, 0],
      armL: [-8, 0, -10], forearmL: [-22, 0, 0],
      sword: [18, 0, 0]
    },

    /* Where he settles after a swing — blade up, weight back, still watching
       you. §21: recoverMs governed NOTHING visual before, and the sword arm
       stepped straight back to "breathe" the frame the swing clock hit zero.
       `recover` blends the strike pose into THIS, not into idle.
       §28 B2 re-tune: the shipped angles put the blade HORIZONTAL across his
       chest — measured, the tip sat at y 1.30 pointing 0.97 to his own left,
       which is a sword being carried, not a guard. It was authored against the
       old off-axis pivot, where the same wrist angle read as raised. Now the
       point sits at y 2.21 on a blade tilted 63deg up: between you and him,
       which is what a guard is for. */
    guard: {
      hips: [0, -4, 0], torso: [-5, -11, 0], head: [1, 8, 0],
      armR: [44, -4, 0], forearmR: [-34, 0, 0],
      armL: [9, 0, -10], forearmL: [-26, 0, 0],
      sword: [24, 7, 23],
      legL: [1, 0, 0], legR: [-3, 0, 0]
    },

    /* ================= THE TEN ATTACK KEYS (§28 B2 re-tune) =================
       These are NOT the §22 numbers. §22 authored them against a sword pivot
       that sat 0.129m OFF the blade's own centre line, so a rotation coned the
       weapon around a point floating beside it and the angles were quietly
       compensating for that. With the pivot now on the fist, the same numbers
       played wrong in a measurable way: the overhead finished with the tip at
       y 1.93 — ABOVE his own head, at the frame the data says the floor gets
       hit — and both drives moved the point BACKWARD along its own axis
       (117deg for thrust_combo, 145deg for charge, where 0deg is a clean stab).

       So the ten keys below were re-derived, not nudged. The `armR`/`forearmR`
       /`sword` triple of each was solved numerically against a TIP TARGET
       measured in the knight's own frame — origin between his boots, +X his
       left, +Y up, +Z at the player — under real joint limits (the elbow may
       only flex forward; the wrist is a wrist, not a second shoulder). What
       the shipped values produce, measured through this file's own driver:

         pattern       tip travel  chord   bow   reach wind->strike  impact y
         slash             3.42     2.96   0.73     1.45 -> 1.87       1.22
         overhead          3.71     3.15   0.83     0.62 -> 1.76       0.86
         charge            1.41     1.41   0.06     0.55 -> 1.91       1.37
         thrust_combo      1.10     1.09   0.03     0.89 -> 1.95       1.30
         ground_slam       3.71     2.93   0.95     0.07 -> 0.58       0.15

       Read `bow` as the acceptance test: it is the worst distance the tip
       strays from the straight line between where it starts and where it
       lands. The two DRIVES are 0.03m and 0.06m over a 1.4m stroke — a
       straight line, which is what a thrust is. The three SWINGS bow 0.7-0.95m
       off their chord, which is what an arc is, and more of that arc is the
       blade turning about the grip than the grip being carried (2.2/1.4,
       2.9/1.9, 2.6/1.3). That pair of numbers IS "swinging from the hand".

       The anatomy caps this: shoulder to grip is 0.64m fully extended and grip
       to tip is 1.227m, so 1.87m from the shoulder is the ceiling and no pose
       here can be authored past it. That is why the hit volumes in
       data/arena3d.js moved to meet these numbers rather than the reverse. */

    /* slash — wind across the body to his right, sweep horizontally through
       chest height. The read the player is given is HEIGHT: the impact frame
       sits at y 1.22, over a 0.85 crouch and under a 1.6 standing eye. */
    slash_wind:   { hips: [0, -10, 0], torso: [-6, -38, 0], head: [0, -22, 0],
                    armR: [-62, 41, -50], forearmR: [-59, 0, 0],
                    armL: [-14, -18, -14], forearmL: [-26, 0, 0],
                    sword: [-20, 36, -1],
                    legL: [6, 0, 0], legR: [-8, 0, 0], _root: [0, 0, -0.14] },
    slash_strike: { hips: [0, 14, 0], torso: [4, 44, 0], head: [0, 26, 0],
                    armR: [-70, 53, -50], forearmR: [-28, 0, 0],
                    armL: [-10, 22, -18], forearmL: [-18, 0, 0],
                    sword: [-28, 23, -29],
                    legL: [-10, 0, 0], legR: [14, 0, 0], _root: [0, -0.04, 0.42] },

    /* overhead — the highest apex in the set, so it gets the longest hold and
       the biggest lie (feint chance 0.30 in data). The apex puts the tip 2.92m
       up, a silhouette readable from the far end of the nave; the impact frame
       is a 45deg chop, not a vertical one, because a blade that finishes
       straight down finishes UNDER his own hands and reaches nobody. */
    overhead_wind:   { hips: [-6, 0, 0], torso: [-16, 0, 0], head: [-14, 0, 0],
                       armR: [-178, 58, -33], forearmR: [-87, 0, 0],
                       armL: [-150, 0, -16], forearmL: [-24, 0, 0],
                       sword: [-12, 6, -17],
                       legL: [4, 0, 0], legR: [-4, 0, 0], _root: [0, 0.06, -0.10] },
    overhead_strike: { hips: [12, 0, 0], torso: [30, 0, 0], head: [22, 0, 0],
                       armR: [-147, 52, 10], forearmR: [-21, 0, 0],
                       armL: [-8, 0, -8], forearmL: [-4, 0, 0],
                       sword: [-32, 20, -33],
                       legL: [-16, 0, 0], legR: [20, 0, 0], _root: [0, -0.12, 0.34] },

    /* charge — a DRIVE. The blade is locked pointing down the lane in BOTH
       keys, so the only thing the strike changes is how far along that line
       the point sits: the elbow is folded to 104deg at the wind and opens
       through the stroke while the body crosses the room under it. He is
       already moving in the last quarter of the wind-up (data's feint note). */
    charge_wind:   { hips: [-10, 8, 0], torso: [-22, 10, 0], head: [8, -8, 0],
                     armR: [-158, 58, 14], forearmR: [-104, 0, 0],
                     armL: [-24, -14, -18], forearmL: [-30, 0, 0],
                     sword: [36, -24, 25],
                     legL: [-14, 0, 0], legR: [16, 0, 0], _root: [0, -0.14, -0.24] },
    charge_strike: { hips: [10, 0, 0], torso: [26, 0, 0], head: [-6, 0, 0],
                     armR: [-178, 48, -4], forearmR: [-105, 0, 0],
                     armL: [-40, 0, -12], forearmL: [-14, 0, 0],
                     sword: [20, -16, 18],
                     legL: [34, 0, 0], legR: [-30, 0, 0], _root: [0, -0.04, 0.9] },

    /* thrust — the other drive, and the tightest thing in the set: it fires
       three times off this one pair, so the difference between jab 1, jab 2
       and the step-through has to come from the driver's per-hit lunge
       offset, not from three near-identical poses nobody can tell apart.
       Bow 0.03m over a 1.09m stroke — the straightest line here. */
    thrust_wind:   { hips: [0, -8, 0], torso: [-4, -16, 0], head: [0, -8, 0],
                     armR: [-51, -51, -50], forearmR: [-31, 0, 0],
                     armL: [-16, -10, -12], forearmL: [-22, 0, 0],
                     sword: [6, -19, -18],
                     legL: [-6, 0, 0], legR: [8, 0, 0], _root: [0, 0, -0.10] },
    thrust_strike: { hips: [0, 6, 0], torso: [8, 8, 0], head: [0, 4, 0],
                     armR: [-69, -58, -50], forearmR: [-3, 0, 0],
                     armL: [-20, 8, -14], forearmL: [-16, 0, 0],
                     sword: [9, -45, -41],
                     legL: [-8, 0, 0], legR: [10, 0, 0], _root: [0, 0, 0.34] },

    /* ground slam — both arms overhead, then the floor. Radial, so the pose
       must not read as directional: the torso stays square and the yaw
       channels stay at zero. The tip finishes at y 0.15, i.e. ON the flags,
       which is the whole point — the ring is thrown from where the blade
       lands, and a blade that stopped at waist height would make the
       shockwave look like it came from nothing. */
    slam_wind:   { hips: [-4, 0, 0], torso: [-20, 0, 0], head: [-18, 0, 0],
                   armR: [-155, 58, -25], forearmR: [-86, 0, 0],
                   armL: [-168, 0, -20], forearmL: [-16, 0, 0],
                   sword: [-13, 15, -15],
                   legL: [2, 0, 0], legR: [2, 0, 0], _root: [0, 0.12, 0] },
    slam_strike: { hips: [10, 0, 0], torso: [46, 0, 0], head: [30, 0, 0],
                   armR: [31, -58, 50], forearmR: [-67, 0, 0],
                   armL: [10, 0, -6], forearmL: [-2, 0, 0],
                   sword: [-16, -9, -43],
                   legL: [-20, 0, 0], legR: [-20, 0, 0], _root: [0, -0.20, 0] },

    /* Kept as a pose so a caller can hold it statically; the LIVE flinch is
       additive — see flinch(), which lays it over whatever he was doing. */
    flinch: { torso: [-14, 6, 0], head: [-18, 10, 0],
              armR: [-4, -12, 22], armL: [-4, -8, -22], _root: [0, 0, -0.14] }
  };

  /* Which pose pair each pattern id uses. Pattern ids come from
     data/arena3d.js patterns — keep this table in step with that object, and
     fall back to slash rather than freezing if a new pattern lands first. */
  var PATTERN_POSES = {
    slash:        ['slash_wind', 'slash_strike'],
    overhead:     ['overhead_wind', 'overhead_strike'],
    charge:       ['charge_wind', 'charge_strike'],
    thrust_combo: ['thrust_wind', 'thrust_strike'],
    ground_slam:  ['slam_wind', 'slam_strike']
  };

  /* ---------- §22 locomotion and reaction, ported onto the hierarchy -------
     These are functions rather than tables because every one of them is a
     curve: a stride runs off `cycle`, the stagger's amplitude decays with the
     timer that owns the punish window, the collapse walks three overlapping
     beats. arena3d supplies the parameter — it already has the clock — and
     this file supplies the shape. opts:
       cycle  stride/sway phase in radians (arena3d's st.stride, or elapsed)
       dir    +1/-1 for the side a strafe circles or a turn pivots toward
       amp    gait amplitude multiplier (dash is walk at 1.5)
       lean   forward torso lean in degrees (walk 8, dash 19)
       f      0..1 remaining/elapsed, for stagger (decaying) and death (rising)
     Every named bone angle is RELATIVE TO ITS PARENT, which is the whole
     point of §28 B: `head` only has to say how it differs from the torso. */
  function over(base, extra) {
    var out = {}, id;
    for (id in base) out[id] = base[id];
    for (id in extra) out[id] = extra[id];
    return out;
  }
  function seg(t, a, b) { return t <= a ? 0 : (t >= b ? 1 : (t - a) / (b - a)); }
  function easeIn(u) { return u * u * u; }
  function easeOut(u) { var v = 1 - u; return 1 - v * v * v; }

  var LOCO = {
    /* Breathing, and nothing else. Two slow terms at different rates so the
       loop never becomes a metronome; arena3d offsets `cycle` per knight, or
       a squad breathes as one organism. */
    idle: function (o) {
      var s = Math.sin(o.cycle * 1.6);
      return over(POSES.idle, {
        torso: [2 + s * 1.1, 0, 0],
        head: [4, Math.sin(o.cycle * 0.7) * 3.2, 0],
        armR: [-14 - s * 1.7, 0, 12],
        armL: [-8 + s * 1.7, 0, -10],
        _root: [0, s * 0.012, 0]
      });
    },

    /* WALK / DASH. §22 had to hold the boot swing at 0.28rad (16°) because
       the "legs" are boots and the dress hem above them never moved, so a
       bigger stride swung bare boots out from under a static skirt. `hips`
       carries the hem now, so the stride can be a stride: 30° at a walk, 45°
       at a dash, with the pelvis counter-rotating under the shoulders. */
    walk: function (o) {
      var amp = o.amp || 1, lean = o.lean || 0;
      var sw = Math.sin(o.cycle), cw = Math.cos(o.cycle);
      return {
        hips: [0, sw * 6 * amp, 0],
        legL: [sw * 30 * amp, 0, 0],
        legR: [-sw * 30 * amp, 0, 0],
        torso: [lean, -sw * 6 * amp, 0],
        head: [-lean * 0.5, sw * 3, 0],           // relative: his eyes stay level
        armR: [sw * 20 * amp, 0, 10],
        forearmR: [-(20 + sw * 8), 0, 0],
        armL: [-sw * 24 * amp, 0, -10],
        forearmL: [-(20 - sw * 8), 0, 0],
        sword: [14, 0, 0],
        _root: [0, Math.abs(cw) * 0.05 * amp, 0]
      };
    },

    /* STRAFE — the crossover side gait. The feet go sideways and cross, the
       pelvis turns into the direction of travel, and the torso counter-rotates
       so he stays OPEN to you with the blade tracking. On siblings §22 had to
       fake that split by yawing the torso alone; here the hips genuinely lead
       and the shoulders genuinely resist, which is the difference between
       circling a fight and wandering off. */
    strafe: function (o) {
      var d = o.dir || 1;
      var sw = Math.sin(o.cycle), cw = Math.cos(o.cycle);
      return {
        hips: [0, -d * 22, 0],
        legL: [sw * 14 + d * 7, 0, 0],
        legR: [-sw * 14 - d * 7, 0, 0],
        torso: [4, d * 12, 0],                    // net -10°: still square to you
        head: [0, d * 10, 0],                     // net 0: eyes never leave you
        /* §28 B2: "blade tracking" is now literally true — the point is aimed
           at you (blade 0.64 forward, 0.43 up) rather than lying across his
           own chest, which is where the pre-grip-fix angles left it. */
        armR: [39 + sw * 4, -32 * d, 3],
        forearmR: [-30, 0, 0],
        armL: [9, 0, -7 * d],
        forearmL: [-24, 0, 0],
        sword: [27, -15, 12],
        _root: [0, Math.abs(cw) * 0.03, 0]
      };
    },

    /* BACKPEDAL — heel-first retreat, guard high. He is giving ground on
       purpose, so the blade never leaves the space between you: a retreat with
       the sword down reads as a rout, and he is not routing. */
    backpedal: function (o) {
      var sw = Math.sin(o.cycle), cw = Math.cos(o.cycle);
      return {
        hips: [-4, 0, 0],
        legL: [-sw * 16, 0, 0],
        legR: [sw * 16, 0, 0],
        torso: [-6, -8, 0],                       // weight back over the heels
        head: [3, 6, 0],                          // relative, so he still faces you
        // §28 B2: the highest guard in the set — tip at y 2.31, covering the line
        armR: [66, 1, -3],
        forearmR: [-52, 0, 0],
        armL: [23, 0, -9],
        forearmL: [-30, 0, 0],
        sword: [26, 7, 23],
        _root: [0, Math.abs(cw) * 0.025, 0]
      };
    },

    /* TURN IN PLACE — past brain.turnThreshold he stops pretending his feet
       are not there. The feet split and the SHOULDERS lead the hips round;
       before §22 he could rotate 180° with his boots welded facing forward,
       which read as the model being spun by a hand rather than a man turning. */
    turnInPlace: function (o) {
      var d = o.dir || 1;
      return {
        hips: [0, d * 8, 0],
        legL: [d * 14, 0, 0],
        legR: [-d * 14, 0, 0],
        torso: [2, d * 16, 0],
        head: [0, d * 10, 0],
        armR: [23, 0, -16],
        forearmR: [-40, 0, 0],
        armL: [8, 0, -6],
        forearmL: [-24, 0, 0],
        sword: [10, 0, 0]
      };
    },

    /* COIL — the dash TELL. dashTellMs of this before he launches: he drops,
       both knees fold, the blade cocks behind him. A silhouette that says "he
       is about to cross the room" from anywhere in the nave — and with the
       hips dropping too, the whole body sinks instead of the boots folding
       under a skirt that stayed at standing height. */
    coil: function () {
      return {
        hips: [10, 0, 0],
        legL: [17, 0, 0], legR: [17, 0, 0],
        torso: [12, 0, 0],
        head: [-26, 0, 0],                        // net -4: eyes still up, on you
        armR: [54, 0, -26],
        forearmR: [-72, 0, 0],
        armL: [-20, 0, 8],
        forearmL: [-30, 0, 0],
        sword: [-14, 0, 0],
        _root: [0, -0.10, 0]
      };
    },

    /* TAUNT — a beat of contempt after a kill or a whiffed swing. Blade
       raised and shown to you, off-hand open, head cocked. The head tilt is
       the joke and it only works because `head` is a child of `torso` now:
       the tilt is a tilt, not a tilt plus whatever the torso happened to be. */
    taunt: function (o) {
      return {
        hips: [0, -4, 0],
        torso: [-8, 6, 0],
        head: [-4, -6, 15],
        /* §28 B2: "blade raised and SHOWN to you" was raising the HAND and
           letting the blade hang down off it — the hilt reached y 1.99 while
           the point fell to y 1.26. The point now stands at y 2.90, above his
           own crown, which is the only version of this pose that reads as
           contempt rather than as a man checking his own grip. */
        armR: [-104, -40, -24],
        forearmR: [-27, 0, 0],
        armL: [-16, 0, 22],
        forearmL: [-18, 0, 0],
        sword: [24, -45, -28],
        legL: [-6, 0, 0], legR: [4, 0, 0],
        _root: [0, Math.sin(o.cycle * 3.1) * 0.012, 0]
      };
    },

    /* PRESS — waiting is not standing still. He shifts his weight foot to
       foot over pressSwayMs: the cheapest possible signal that he is choosing
       a moment rather than buffering. */
    press: function (o) {
      var s = Math.sin(o.cycle);
      return {
        hips: [0, s * 7, 0],
        legL: [s * 6, 0, 0], legR: [-s * 6, 0, 0],
        torso: [-3, -s * 3, 0],
        head: [0, s * 5, 0],
        // §28 B2: the same raised guard as `guard`, a touch lower and lazier
        armR: [31, -5, 8],
        forearmR: [-20, 0, 0],
        armL: [9, 0, -8],
        forearmL: [-24, 0, 0],
        sword: [24, 2, 19]
      };
    },

    /* STAGGER — the §22 punish window, made visible. Head snapped back, arms
       flung wide, weight on the back foot. Amplitude decays with `f` (the
       timer's own remainder) so the recoil eases out instead of releasing him
       in one frame, and a small wobble rides the tail because he is still
       finding his feet. The head snap is HARDER than §22 could manage: the
       torso already goes back 24°, and the head now inherits that and adds
       its own 20 on top. */
    stagger: function (o) {
      var f = o.f == null ? 1 : o.f;
      var wob = Math.sin((1 - f) * Math.PI * 3) * 6 * f;
      return {
        hips: [-10 * f, 6 * f, 0],
        torso: [-24 * f + wob, 8 * f, 0],
        head: [-20 * f, 0, 11 * f],
        armR: [-40 * f, 20 * f, 34 * f],
        forearmR: [-9 * f, 0, 0],
        armL: [-49 * f, 0, -32 * f],
        forearmL: [-6 * f, 0, 0],
        sword: [-20 * f, 0, 0],
        legL: [-15 * f, 0, 0], legR: [17 * f, 0, 0],
        _root: [0, -0.05 * f, 0]
      };
    },

    /* DEATH — §22's collapse, replacing the sink through the floor that read
       as a collision bug every single time, because a body falling through
       stone is exactly what a collision bug looks like. Three overlapping
       beats over brain.deathMs: the knees buckle (0.00-0.30), the torso
       pitches over them (0.22-0.62), the body settles (0.62-0.80); arena3d
       drops the sword and starts the fade only after that. `hips` takes the
       buckle, which is what a pelvis is for — on siblings the legs folded and
       the dress stayed standing. */
    death: function (o) {
      var f = o.f == null ? 1 : o.f;
      var b = easeOut(seg(f, 0.00, 0.30));
      var p = easeIn(seg(f, 0.22, 0.62));
      var s = seg(f, 0.62, 0.80);
      return {
        hips: [22 * b + 10 * p, 0, 0],
        legL: [34 * b, 0, 0], legR: [38 * b, 0, 0],
        torso: [14 * b + 40 * p, 7 * p, 0],
        head: [-6 * b - 12 * p, 0, 10 * p],
        armR: [-31 * b - 31 * p, 0, 17 * p],
        forearmR: [-6, 0, 0],
        armL: [-17 * b - 26 * p, 0, -20 * p],
        forearmL: [-6, 0, 0],
        sword: [10 * p, 0, 0],
        _root: [0, -(0.55 * b + 0.30 * p) + 0.03 * s, -0.10 * p]
      };
    }
  };

  /* ---------- easing ----------
     Telegraph eases OUT: fast off the idle, slow into the apex, so the last
     third of the wind-up is nearly still and the player has a stable pose to
     read. Strike eases IN: the apex barely moves, then it snaps. Reversing
     these two is what makes procedural combat feel like syrup. */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInQuart(t) { return t * t * t * t; }
  function easeOutBack(t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  /* ---------- pose application ----------
     Per-joint response, so the body reads as mass rather than one rigid
     object: the head LEADS (he keeps his eyes on you), the torso is heaviest,
     legs and hips sit between. §21's rate table, unchanged, and its
     frame-rate-correct approach: `Math.min(1, rate*dt)` is the Euler
     approximation of this and it over-closes by 25% at 30fps, so the knight
     got SNAPPIER the worse your machine ran. */
  var RATE = { hips: 12, torso: 10, head: 22, armL: 18, armR: 18,
               forearmL: 18, forearmR: 18, sword: 18, legL: 16, legR: 16 };
  var RATE_DEFAULT = 14, RATE_ROOT = 12;
  function alpha(rate, dt) { return 1 - Math.exp(-rate * dt); }

  /* BLEND ON QUATERNIONS, NOT ON DEGREES.
     This used to lerp the euler triples channel by channel, which is fine for
     the small deltas the locomotion poses use and badly wrong for the big
     ones an attack needs: interpolating armR from [-143, 50, -11] to
     [-30, -2, 48] walks through orientations that lie nowhere near the arc
     between them, because euler space is not flat. Measured on the overhead
     with the corrected rig, the tip covered 8.38m to get 3.19m from wind to
     strike — a tumble, not a chop, and the same shape §28 B2 describes as
     "scything". Slerping the two end orientations instead makes the arc the
     shortest rotation between them BY CONSTRUCTION, which is what an arc
     centred on the grip is.
     The result carries pre-multiplied quaternions in `q`; commitPose takes
     either that or a raw degree pose, so POSES/LOCO stay readable tables. */
  function poseQuat(rig, pose, id, out) {
    var v = (pose && pose[id]) || ZERO;
    out.setFromEuler(rig._s.e.set(v[0] * D, v[1] * D, v[2] * D));
    return out;
  }
  function blendPose(rig, a, b, t) {
    var s = rig._s, bq = s.bq, id;
    a = a || {}; b = b || {};
    /* bq is per-rig scratch, allocated once in build(): a squad of six at
       60fps would otherwise make ~4000 Quaternions a second here. It is
       persistent, so clear it — a bone left over from the previous blend
       would keep posing a limb neither of these two poses names. */
    for (id in bq) bq[id].set(0, 0, 0, 1);
    for (id in a) if (id !== '_root' && bq[id]) poseQuat(rig, a, id, bq[id]);
    for (id in b) {
      if (id === '_root' || !bq[id]) continue;
      /* A bone named on one side only blends against ITS REST (identity), not
         against nothing — that is what lets `slash_wind` name legs the idle
         never mentions and still ease into them. */
      bq[id].slerp(poseQuat(rig, b, id, s.qb), t);
    }
    for (id in a) {
      if (id === '_root' || !bq[id] || b[id]) continue;
      bq[id].slerp(s.qb.set(0, 0, 0, 1), t);      // named by `a` only: ease to rest
    }
    var out = { q: bq };
    var ra = a._root || ZERO, rb = b._root || ZERO;
    out._root = [ra[0] + (rb[0] - ra[0]) * t,
                 ra[1] + (rb[1] - ra[1]) * t,
                 ra[2] + (rb[2] - ra[2]) * t];
    return out;
  }

  /* Write a pose onto the bones.
     `dt` null  -> snap (build, reset: the rig must not animate into place).
     `dt` given -> ease at the per-joint rates, with `take` as a FLOOR on the
     blend so a swing can take its curve straight. §21: a swing curve is
     already shaped on a wall clock, and running it through a ~70ms
     first-order lag is exactly what smeared the old impact frame across a
     fifth of the wind-up — but ramping into it over the first 100ms keeps a
     knight caught mid-stride from popping. arena3d supplies that ramp. */
  function commitPose(rig, pose, dt, take) {
    var s = rig._s;
    take = take || 0;
    var pq = pose.q || null;
    for (var id in rig.bones) {
      var bone = rig.bones[id];
      if (pq) { s.q.copy(pq[id] || s.qi); }
      else {
        var v = pose[id] || ZERO;
        s.e.set(v[0] * D, v[1] * D, v[2] * D);
        s.q.setFromEuler(s.e);
      }
      s.q2.copy(bone.restQuat).multiply(s.q);
      if (dt == null) { bone.group.quaternion.copy(s.q2); continue; }
      var a = alpha(RATE[id] || RATE_DEFAULT, dt);
      if (take > a) a = take;
      bone.group.quaternion.slerp(s.q2, a > 1 ? 1 : a);
    }
    var r = pose._root || ZERO;
    s.v.set(rig.rootRest.x + r[0], rig.rootRest.y + r[1], rig.rootRest.z + r[2]);
    if (dt == null) { rig.root.position.copy(s.v); }
    else {
      var ar = alpha(RATE_ROOT, dt);
      if (take > ar) ar = take;
      rig.root.position.lerp(s.v, ar > 1 ? 1 : ar);
    }
    rig.drove = true;
  }

  /* Add an angle to a bone that has already been committed. Used by the
     overlays — the feint's breathing sway and §22's hit flinch — which sit ON
     TOP of the pose rather than replacing it, so a flinch never eats a swing
     that is already in flight. */
  function addX(rig, id, deg) { var b = rig.bones[id]; if (b) b.group.rotateX(deg * D); }
  function addZ(rig, id, deg) { var b = rig.bones[id]; if (b) b.group.rotateZ(deg * D); }

  /* ---------- public phase driver ----------
     arena3d.js already knows which phase it is in and how far through — it
     computes that to run the hit test. Rather than re-derive it here off a
     second timer, take it as an argument. One clock.
     opts: {dt, take, lunge}. Omitting dt snaps, which is what a test wants. */
  function phase(rig, name, t01, opts) {
    if (!rig) return;
    var poses = PATTERN_POSES[rig.patternId] || PATTERN_POSES.slash;
    var t = clamp01(t01);
    opts = opts || {};
    var p;

    if (name === 'telegraph') {
      p = blendPose(rig, POSES.idle, POSES[poses[0]], easeOutCubic(t));
    } else if (name === 'hold') {
      /* Feint hold. MUST be visually alive but positionally frozen — the data
         comment is explicit that a hold which damages is an unreadable
         attack, and a hold that drifts is one the player misreads as the
         strike starting. Breathe on the torso only. */
      p = blendPose(rig, POSES.idle, POSES[poses[0]], 1);
    } else if (name === 'strike') {
      p = blendPose(rig, POSES[poses[0]], POSES[poses[1]], easeInQuart(t));
      /* thrust_combo fires this three times; nudge the root further forward on
         each successive hit so three identical stabs read as a combo. The
         step itself lives in the data as hits[i].lunge — take it from the
         caller, never hardcode it. arena3d hands over only the LEAN, not the
         whole metre count: it pays the real displacement onto the knight's
         own group, where the navgrid can stop him. A root that walked the
         full 1.6m would be a step no stone could block. */
      if (opts.lunge) p._root[2] += opts.lunge * easeInQuart(t);
    } else if (name === 'recover') {
      p = blendPose(rig, POSES[poses[1]], POSES.guard, easeOutBack(t));
    } else {
      p = POSES.idle;
    }
    commitPose(rig, p, opts.dt, opts.take);
    if (name === 'hold') addZ(rig, 'torso', Math.sin(rig.t * 7) * 1.4);
  }

  /* Any non-swing state. Resolves an id from LOCO first (the parametric §22
     states), then from POSES (the static keys), and falls back to idle rather
     than freezing if a caller invents a name. */
  function pose(rig, id, opts) {
    if (!rig) return;
    var o = opts || {};
    if (o.cycle == null) o = { cycle: rig.t, dt: o.dt, take: o.take, dir: o.dir,
                               amp: o.amp, lean: o.lean, f: o.f };
    var p = LOCO[id] ? LOCO[id](o) : (POSES[id] || LOCO.idle(o));
    commitPose(rig, p, o.dt, o.take);
  }

  function play(rig, patternId) {
    if (!rig) return;
    rig.patternId = patternId;
    rig.state = 'telegraph';
  }

  /* §22 HIT FLASH: every damaging blow reads, stagger or not — a hit that
     changes nothing but a number is a hit the player is not sure they landed.
     `amount` is 0..1 and arena3d squares its own timer to make it sharp on
     the impact frame and gone fast. Additive, deliberately: laid over
     whatever he was doing, so a flinch never cancels a swing in flight. */
  function flinch(rig, amount) {
    if (!rig || !(amount > 0)) return;
    var k = amount > 1 ? 1 : amount;
    addX(rig, 'torso', -11 * k);
    addX(rig, 'head', -15 * k);
    addX(rig, 'armL', -9 * k);
    addX(rig, 'armR', -6 * k);
    addZ(rig, 'armL', -6 * k);
    addZ(rig, 'armR', 6 * k);
    rig.root.position.y -= 0.03 * k;
  }

  /* t01 is progress through brain.deathMs, so the collapse is stretched over
     the data's own number exactly like a swing is stretched over telegraphMs. */
  function die(rig, t01, opts) {
    if (!rig) return;
    opts = opts || {};
    commitPose(rig, LOCO.death({ f: clamp01(t01) }), opts.dt, opts.take);
  }

  function reset(rig) {
    if (!rig) return;
    rig.patternId = null;
    rig.state = null;
    rig.drove = false;
    commitPose(rig, POSES.idle, null);
  }

  /* Call last, every frame. Advances the rig's own clock and, if nothing
     drove it this frame, holds the breathing idle — so the module still works
     standalone for a caller that only wants a knight standing there. */
  function update(rig, dt) {
    if (!rig) return;
    rig.t += dt;
    if (!rig.drove) commitPose(rig, LOCO.idle({ cycle: rig.t }), dt);
    rig.drove = false;
  }

  /* Every id pose() will resolve — the acceptance list §28 C asks a test to
     walk. LOCO first because it shadows POSES on a name clash. */
  function poseIds() {
    var out = [], id;
    for (id in LOCO) out.push(id);
    for (id in POSES) if (!LOCO[id]) out.push(id);
    return out;
  }

  return {
    build: build, setRootRest: setRootRest, play: play, phase: phase, pose: pose,
    flinch: flinch, die: die, reset: reset, update: update, poseIds: poseIds,
    _poses: POSES, _loco: LOCO, _patterns: PATTERN_POSES
  };
})();
