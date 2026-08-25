#!/usr/bin/env node
/* CHLOE — tools/build-knight-rig.js
   Derives a RIGID bone hierarchy for assets/3d/knight.glb and writes
   game/js/data/knightrig.js.

   Why this exists: knight.glb has skins:0, animations:0, and 103 mesh nodes
   that are all flat siblings of the scene root with zero children. There is
   no skeleton to key a clip onto. But the knight is plate armour, and plate
   does not deform — so each piece can be parented to a rigid bone and posed
   by transform alone. That is what this script produces.

   ---------------------------------------------------------------------------
   PIVOTS ARE DERIVED FROM GEOMETRY, NOT REMEMBERED (§28 B2)
   ---------------------------------------------------------------------------
   Every pivot used to be hard-coded here from "the measured layout". The sword
   proved those numbers untrustworthy: it was authored at [-0.28, 0.95, 0],
   which is 0.139m from the right hand AND 0.129m off the sword's own axis —
   the pivot was not on the sword at all. Rotating about it cones the blade
   around a point floating beside it, which is exactly the "holding the blade,
   swings and thrusts feel wrong" the player reported. A remembered number
   cannot be re-checked, so no pivot is remembered any more. Each one is
   measured from the vertices of the meshes its own bone owns:

     ground   root      the floor plane (lowest vertex in the model) under the
                        midpoint of the two boot clusters, so a yaw turns him
                        between his feet instead of about an arbitrary origin.
     waist    hips      the seam where the hips cluster (dress/belt/pants) meets
     waist    torso     the torso cluster (chest/shirt), measured from each
                        side's OWN vertices. One physical joint, two bones: the
                        pelvis turns the legs and skirt about it, the spine
                        leans about it. `hips` has no parent cluster to meet —
                        `root` owns no meshes — so it is measured against its
                        child instead.
     neck     head      the seam where the hood/mask cluster meets the shirt.
                        Not the middle of the skull: that swings the head like
                        a ball on a stick.
     shoulder armL/R    the seam where the pauldron cluster meets the torso —
                        its INBOARD end. A pivot at the middle of the shoulder
                        plate hinges the arm from inside the ribcage. Measured
                        over the UPPER HALF of the cluster only; the arm straps
                        hug the ribs lower down and are "nearest the torso" too,
                        and unrestricted they drag the pivot into the armpit
                        (armR came out at y 1.268 instead of 1.438).
     elbow    forearmL/R the seam where the forearm cluster (elbow cop, bracer,
                        glove) meets the pauldron cluster — the top of the cop.
     knee     legL/R    the top of the leg cluster. Say this out loud: the leg
                        bone owns boots and greaves ONLY — the thigh is inside
                        `Padded_Pants` and the skirt, which belong to `hips` —
                        so the highest joint it can honestly serve is the knee,
                        not a hip socket 0.26m above anything it owns. The old
                        table put legL/R at y=0.90 with the cluster topping out
                        at 0.637: a pivot outside the bbox of the meshes it
                        moves. That is now a hard error (see validate()).
     grip     sword     the right-hand glove cluster's centroid, projected onto
                        the sword's own long axis so the pivot lies ON the
                        blade line. THE headline fix — see the sword note below.

   The "seam" measurement is literal: take the 10% of a bone's own vertices
   that lie nearest the neighbouring cluster's surface and average them. That
   is where two pieces of armour physically meet, which is where the joint is.
   Because it averages a subset of the bone's own vertices, a seam pivot is
   inside its own cluster by construction — the validation below can then be a
   real test rather than a restatement.

   One qualification for the three CENTRAL bones (hips, torso, head): a seam
   gives them their joint HEIGHT honestly, but not their left-right or
   fore-aft position, because it happily reports whichever hip the belt rings
   hang on. Measured, that bias was 0.07m on `hips`, which takes a 22deg yaw in
   §22's turnInPlace — enough to swing the whole body 2.6cm sideways as he
   turns. So those two axes come from the centre of the bone's own cluster
   instead: the spine runs down the middle of the plate.

   The old table, graded by the same rules: `forearmR`, `legL` and `legR` all
   sat OUTSIDE the bbox of the meshes they move — the legs by 0.26m, hinging
   the boots from a point in mid-skirt. Those three are now hard errors, which
   is the point of deriving rather than remembering.

   ---------------------------------------------------------------------------
   WHAT THE FIVE `Merged_Sword_Sides` MESHES ACTUALLY ARE
   ---------------------------------------------------------------------------
   Their bboxes look like five unrelated objects (0.88 x 0.61 x 0.55 down to
   0.09 x 0.07 x 0.07), so they were worth distrusting. Measured: all five
   carry MAT_SWORD, and four of them share one principal axis to 4 decimal
   places while the fifth is exactly perpendicular to it — that fifth is the
   CROSSGUARD, and a crossguard is supposed to be perpendicular. Ordered along
   the shared axis they are blade, collar, crossguard, grip, pommel: one sword,
   nothing foreign, nothing to reassign. The tool re-derives and prints that
   table on every run (`printSwordAnatomy`) so it stays checked rather than
   remembered.

   The uncomfortable part, which the rig cannot fix and the animator must know:
   the fist closes around the axis at t=0, and the grip rod does not start
   until t=+0.20, on the far side of the crossguard at t=+0.175. In the shipped
   art the knight's hand is on the ricasso, below the guard — he is holding the
   blade in the MESH, not only in the pivot. Moving the sword meshes to fix
   that is a content edit, not a rig edit, so it is reported and not done here.
   What this tool can do is guarantee the sword rotates about the fist, which
   is what makes a swing sweep and a thrust drive instead of scything.

   ---------------------------------------------------------------------------
   ASSIGNMENT
   ---------------------------------------------------------------------------
   Sides are split by CENTROID, never by the name suffix. The `_low1`/`_low2`
   convention in this asset is +X/-X for shoulders, elbows and gloves but
   INVERTED for Boot_Toe. Trusting the suffix gives you backwards legs.

   Ahead of the side split runs a STRADDLE test: a mesh reaching more than
   0.12m past the centreline on BOTH sides cannot belong to one arm, because
   half of it is attached to the other one. Three meshes fail it — the chest
   rings, the chest straps and the shoulder yoke, each a single mesh spanning
   0.41-0.68m across the body — and centroid-splitting was handing all three to
   armL. That is the whole of the old 9/6 armL/armR asymmetry; with them on the
   torso where they belong the pauldrons are 6/6. The 0.12m threshold has room:
   the widest one-sided piece crosses by 0.076m (a boot), the narrowest
   straddler by 0.160m.
   forearmL 24 / forearmR 19 stays asymmetric and is CORRECT — the model has
   five `Bracer_` meshes and all five are on the left arm.

   Usage:  node tools/build-knight-rig.js [--check]
           --check  run every validation, print the tables, write nothing
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GLB = path.join(ROOT, 'game/assets/3d/knight.glb');
const OUT = path.join(ROOT, 'game/js/data/knightrig.js');

/* How close the grip must land to the hand before this is a rig, not a guess.
   The defect it replaces missed by 0.139m. */
const GRIP_TOL = 0.06;
/* And how far it may sit from the sword's own centre LINE before it is not a
   grip at all — measured to the axis, not to the nearest vertex, because the
   blade is a merged sheet of only 103 vertices and its nearest vertex to any
   given point can be 0.07m away while the surface passes straight through.
   The defect this replaces was 0.129m off the axis: not on the sword. */
const SWORD_AXIS_TOL = 0.05;
/* A mesh must reach past the centreline by this much on BOTH sides before it
   is judged two-sided. See the header for the measured margin either way. */
const STRADDLE = 0.12;
/* Fraction of a bone's own vertices, nearest the neighbour cluster, that
   define a seam. 10% is enough to average out one stray rivet and small
   enough that it still describes an edge rather than a body. */
const SEAM_FRAC = 0.10;
/* Vertex clouds are strided down to this before any O(n*m) seam search. The
   armour is dense enough that 2500 points still resolve a 1cm seam, and it
   keeps a full run under a second. */
const SAMPLE_CAP = 2500;

/* ---------- glb -> json + bin ---------- */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  let off = 20 + jsonLen, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x004e4942) { bin = buf.slice(off + 8, off + 8 + len); break; }
    off += 8 + len;
  }
  if (!bin) throw new Error('GLB has no BIN chunk: ' + file);
  return { gltf, bin };
}

/* ---------- vertices in the corrected Y-up frame ----------
   Every node in this asset carries rotation (0.7071,0,0,0.7071) — a +90deg
   turn about X, the standard Z-up -> Y-up conversion — and uniform scale 0.01
   (centimetres -> metres). Rather than assume that holds forever, read the
   node's own TRS and apply it. The +90X case is the one that matters: it maps
   local (x,y,z) to world (x,-z,y), so the *local* Z axis is the model's
   height. Read the wrong axis and every part lands at the wrong elevation.

   The old build read accessor min/max only. That is enough to sort meshes into
   groups, but a bbox cannot tell you where a fist closes or where a pauldron
   touches a shirt, so pivots need the real points. */
const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readPositions(gltf, bin, accIndex) {
  const a = gltf.accessors[accIndex];
  if (a.componentType !== 5126 || a.type !== 'VEC3') {
    throw new Error('POSITION accessor ' + accIndex + ' is not float VEC3 — quantised mesh, teach this reader about it');
  }
  if (a.sparse) throw new Error('POSITION accessor ' + accIndex + ' is sparse — unsupported');
  const bv = gltf.bufferViews[a.bufferView];
  const bytes = COMP_BYTES[a.componentType];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || bytes * 3;
  const out = new Float64Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    const p = base + i * stride;
    out[i * 3] = bin.readFloatLE(p);
    out[i * 3 + 1] = bin.readFloatLE(p + bytes);
    out[i * 3 + 2] = bin.readFloatLE(p + bytes * 2);
  }
  return out;
}

function isPlusNinetyX(q) {
  return Math.abs(q[0] - Math.SQRT1_2) < 1e-3 && Math.abs(q[3] - Math.SQRT1_2) < 1e-3 &&
         Math.abs(q[1]) < 1e-3 && Math.abs(q[2]) < 1e-3;
}

function readNodes(gltf, bin) {
  return gltf.nodes.map((nd, i) => {
    if (nd.mesh == null) throw new Error('node ' + i + ' carries no mesh');
    const mesh = gltf.meshes[nd.mesh];
    const s = nd.scale || [1, 1, 1];
    const t = nd.translation || [0, 0, 0];
    const flip = isPlusNinetyX(nd.rotation || [0, 0, 0, 1]);
    const mats = [];
    let n = 0;
    const chunks = [];
    for (const prim of mesh.primitives) {
      if (prim.material != null) {
        const m = gltf.materials[prim.material];
        const name = (m && m.name) || ('material' + prim.material);
        if (mats.indexOf(name) < 0) mats.push(name);
      }
      const v = readPositions(gltf, bin, prim.attributes.POSITION);
      chunks.push(v);
      n += v.length / 3;
    }
    const pts = new Float64Array(n * 3);
    let w = 0;
    for (const v of chunks) {
      for (let k = 0; k < v.length; k += 3) {
        const x = v[k] * s[0] + t[0], y = v[k + 1] * s[1] + t[1], z = v[k + 2] * s[2] + t[2];
        if (flip) { pts[w++] = x; pts[w++] = -z; pts[w++] = y; }
        else { pts[w++] = x; pts[w++] = y; pts[w++] = z; }
      }
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pts.length; k += 3) {
      for (let c = 0; c < 3; c++) {
        const val = pts[k + c];
        if (val < lo[c]) lo[c] = val;
        if (val > hi[c]) hi[c] = val;
      }
    }
    return {
      index: i,
      name: nd.name || ('node' + i),
      base: (nd.name || '').split(':')[0],
      pts, lo, hi, mats,
      x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2
    };
  });
}

/* ---------- point-cloud helpers ---------- */
function cloud(nodes) {                       /* one strided sample over a cluster */
  let total = 0;
  for (const n of nodes) total += n.pts.length / 3;
  const step = Math.max(1, Math.ceil(total / SAMPLE_CAP));
  const out = [];
  let i = 0;
  for (const n of nodes) {
    for (let k = 0; k < n.pts.length; k += 3, i++) {
      if (i % step === 0) out.push([n.pts[k], n.pts[k + 1], n.pts[k + 2]]);
    }
  }
  return out;
}
function centroidOf(nodes) {                  /* every vertex, not the bboxes */
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const nd of nodes) {
    for (let k = 0; k < nd.pts.length; k += 3) { sx += nd.pts[k]; sy += nd.pts[k + 1]; sz += nd.pts[k + 2]; n++; }
  }
  return [sx / n, sy / n, sz / n];
}
function bboxOf(nodes) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) for (let c = 0; c < 3; c++) {
    if (n.lo[c] < lo[c]) lo[c] = n.lo[c];
    if (n.hi[c] > hi[c]) hi[c] = n.hi[c];
  }
  return { lo, hi };
}
function meanOf(pts) {
  const m = [0, 0, 0];
  for (const p of pts) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
  return m.map(v => v / pts.length);
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/* ---------- the three derivation rules ---------- */

/* SEAM: the centroid of the SEAM_FRAC of `own` that lies nearest `neighbour`.
   Where two pieces of plate meet is where the joint under them is.

   `upperHalf` exists for the shoulders and is not optional there. An arm
   cluster's nearest points to the torso are not only the pauldron's inboard
   edge — the arm straps wrap the ribs and are nearer still, and they drag the
   pivot down into the armpit (measured: armR came out at y 1.268 against a
   shoulder that sits at 1.49). Looking only at the top half of the pauldron
   asks the question that was meant: where does the ARM meet the body. */
function seamPivot(own, neighbour, upperHalf) {
  let A = cloud(own);
  const B = cloud(neighbour);
  if (upperHalf) {
    const box = bboxOf(own);
    const mid = (box.lo[1] + box.hi[1]) / 2;
    const top = A.filter(p => p[1] >= mid);
    if (top.length >= 16) A = top;
  }
  const scored = A.map(a => {
    let best = Infinity;
    for (let i = 0; i < B.length; i++) {
      const dx = a[0] - B[i][0], dy = a[1] - B[i][1], dz = a[2] - B[i][2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return { p: a, d: best };
  });
  scored.sort((u, v) => u.d - v.d);
  const take = Math.max(8, Math.round(scored.length * SEAM_FRAC));
  return meanOf(scored.slice(0, take).map(s => s.p));
}

/* PROXIMAL: the far end of the cluster along `axis` — the end the parent is
   on. Used where a seam cannot be measured because the parent's cloth wraps
   the whole child: the skirt hangs to the ankle, so every point on the boot is
   "near" the hips and a seam search returns noise.
   The end SLAB gives the lateral position (the leg's own line), but the pivot
   is placed at the slab's outer FACE, not its middle — a joint belongs at the
   top of the plate stack, not a hand's breadth down inside it. */
function proximalPivot(own, axis) {
  const A = cloud(own);
  const scored = A.map(p => ({ p, t: p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2] }));
  scored.sort((u, v) => v.t - u.t);
  const take = Math.max(8, Math.round(scored.length * SEAM_FRAC));
  const slab = scored.slice(0, take);
  const m = meanOf(slab.map(s => s.p));
  const mT = m[0] * axis[0] + m[1] * axis[1] + m[2] * axis[2];
  /* 98th percentile rather than the single highest vertex, so one spike of
     geometry cannot define a joint. */
  const faceT = scored[Math.floor(scored.length * 0.02)].t;
  return [0, 1, 2].map(c => m[c] + axis[c] * (faceT - mT));
}

/* CENTRAL: for the bones that ARE the body's axis — hips, torso, head. Their
   joint HEIGHT is a seam like any other, but their horizontal position is not:
   the spine runs down the middle of the plate, and a seam sample happily
   reports whichever hip the belt rings happen to hang on. Measured, that bias
   was 0.07m on `hips`, and `hips` takes a 22deg yaw in §22's turnInPlace —
   enough off-axis to swing the whole body 2.6cm sideways as he turns. So X and
   Z come from the centre of the bone's own cluster instead. */
function centralPivot(own, neighbour) {
  const seam = seamPivot(own, neighbour);
  const box = bboxOf(own);
  return [(box.lo[0] + box.hi[0]) / 2, seam[1], (box.lo[2] + box.hi[2]) / 2];
}

/* GRIP: the hand's centroid, slid onto the sword's own axis so the pivot sits
   on the blade line. Both halves matter — coincident with the fist so the
   sword stays in the hand through a pose, and on the axis so a roll spins the
   blade about itself instead of wobbling it. */
function gripPivot(handNodes, swordNodes) {
  const hand = centroidOf(handNodes);
  const axis = longestChordAxis(cloud(swordNodes));
  const o = axis.a;
  const t = (hand[0] - o[0]) * axis.u[0] + (hand[1] - o[1]) * axis.u[1] + (hand[2] - o[2]) * axis.u[2];
  const onAxis = [o[0] + axis.u[0] * t, o[1] + axis.u[1] * t, o[2] + axis.u[2] * t];
  return { pivot: onAxis, hand, axis, offAxis: dist(hand, onAxis) };
}

/* The sword's long axis by its longest chord, NOT by PCA. PCA weights by
   vertex count, and the crossguard carries 666 of the sword's 1492 vertices
   while the blade carries 103 — a principal axis would be dragged toward the
   guard. Two passes of "farthest point" find the tip and the pommel, which
   are 1.69m apart against the guard's 0.55m span, so the chord is unambiguous. */
function longestChordAxis(pts) {
  const c = meanOf(pts);
  let a = pts[0], best = -1;
  for (const p of pts) { const d = dist(p, c); if (d > best) { best = d; a = p; } }
  let b = pts[0]; best = -1;
  for (const p of pts) { const d = dist(p, a); if (d > best) { best = d; b = p; } }
  const len = dist(a, b);
  return { a, b, len, u: [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len] };
}

/* ---------- bones ----------
   No pivots here any more, only which rule measures each one. `seamWith` names
   the cluster on the far side of the joint; it is the PARENT everywhere except
   `hips`, whose parent `root` owns no meshes, so it meets its child instead. */
const BONES = [
  { id: 'root',      parent: null,       rule: 'ground' },
  { id: 'hips',      parent: 'root',     rule: 'waist',    seamWith: 'torso' },
  { id: 'torso',     parent: 'hips',     rule: 'waist',    seamWith: 'hips' },
  { id: 'head',      parent: 'torso',    rule: 'neck',     seamWith: 'torso' },
  { id: 'armL',      parent: 'torso',    rule: 'shoulder', seamWith: 'torso' },
  { id: 'forearmL',  parent: 'armL',     rule: 'elbow',    seamWith: 'armL' },
  { id: 'armR',      parent: 'torso',    rule: 'shoulder', seamWith: 'torso' },
  { id: 'forearmR',  parent: 'armR',     rule: 'elbow',    seamWith: 'armR' },
  { id: 'sword',     parent: 'forearmR', rule: 'grip' },
  { id: 'legL',      parent: 'hips',     rule: 'knee',     axis: [0, 1, 0] },
  { id: 'legR',      parent: 'hips',     rule: 'knee',     axis: [0, 1, 0] }
];

/* The numbers this file used to hard-code. They are kept for ONE reason: so
   every run prints derived-vs-authored side by side and the diff is arguable
   instead of asserted. Nothing reads them. */
const LEGACY_PIVOTS = {
  root: [0.00, 0.00, 0], hips: [0.00, 0.95, 0], torso: [0.00, 1.20, 0],
  head: [0.00, 1.62, 0], armL: [0.22, 1.49, 0], forearmL: [0.34, 1.22, 0],
  armR: [-0.19, 1.49, 0], forearmR: [-0.25, 1.22, 0], sword: [-0.28, 0.95, 0],
  legL: [0.15, 0.90, 0], legR: [-0.16, 0.90, 0]
};

/* The bones that exist in a left and a right copy. Only these can be wrong
   about which side a mesh is on, so only these are straddle-tested — the
   centred bones and the sword are two-sided by nature (the chest plate spans
   0.38m across the body, the blade 0.88m, and neither is a mistake). */
const SIDED = new Set(['armL', 'armR', 'forearmL', 'forearmR', 'legL', 'legR']);

/* Rules run in order; first match wins. `side` means: pick the L/R variant by
   the sign of the centroid X. */
const RULES = [
  { test: n => /^Crown|^Head_Mask|^Hood_|^Padded_Cover/.test(n.base),          bone: 'head' },
  { test: n => /^Merged_Sword/.test(n.base),                                   bone: 'sword' },
  { test: n => /^Boot_Toe/.test(n.base),          bone: n => n.x >= 0 ? 'legL' : 'legR' },
  { test: n => /^Bracer_|^Gloves_|^Glove_MainPlate/.test(n.base),
                                                  bone: n => n.x >= 0 ? 'forearmL' : 'forearmR' },
  { test: n => /^Shoulder_Elbow/.test(n.base),    bone: n => n.x >= 0 ? 'forearmL' : 'forearmR' },
  { test: n => /^Shoulder_|^ArmStrap_|^UnderShoulder/.test(n.base),
                                                  bone: n => n.x >= 0 ? 'armL' : 'armR' },
  { test: n => /^Dress_|^Belt_|^Padded_Pants/.test(n.base),                    bone: 'hips' },
  { test: n => /^Chest_|^Padded_/.test(n.base),                                bone: 'torso' }
];

function assign(nodes) {
  const map = {}, byBone = {}, unassigned = [], straddlers = [];
  for (const n of nodes) {
    const rule = RULES.find(r => r.test(n));
    if (!rule) { unassigned.push(n); continue; }
    let bone = typeof rule.bone === 'function' ? rule.bone(n) : rule.bone;
    /* A mesh cannot swing with one arm if the other end of it is bolted to
       the other arm. Send it up the chain to the body part it spans. */
    if (SIDED.has(bone) && n.lo[0] < -STRADDLE && n.hi[0] > STRADDLE) {
      const to = n.y >= 1.0 ? 'torso' : 'hips';
      straddlers.push({ n, from: bone, to });
      bone = to;
    }
    (map[bone] || (map[bone] = [])).push(n.name);
    (byBone[bone] || (byBone[bone] = [])).push(n);
  }
  return { map, byBone, unassigned, straddlers };
}

/* ---------- sword anatomy ----------
   Re-derived every run rather than remembered, because the whole point of §28
   B2 is that remembered geometry drifts. Ordered along the sword's own axis
   with the fist at t=0, a sword reads blade | guard | grip | pommel. */
function printSwordAnatomy(swordNodes, grip) {
  const u = grip.axis.u, o = grip.pivot;
  const t = p => (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2];
  const radius = p => {
    const k = t(p);
    return Math.hypot(p[0] - o[0] - u[0] * k, p[1] - o[1] - u[1] * k, p[2] - o[2] - u[2] * k);
  };
  const parts = swordNodes.map(n => {
    let lo = Infinity, hi = -Infinity, rmax = 0;
    for (let k = 0; k < n.pts.length; k += 3) {
      const p = [n.pts[k], n.pts[k + 1], n.pts[k + 2]];
      const tt = t(p); if (tt < lo) lo = tt; if (tt > hi) hi = tt;
      const r = radius(p); if (r > rmax) rmax = r;
    }
    return { n, lo, hi, rmax, mid: (lo + hi) / 2, span: hi - lo };
  });
  /* The guard is the piece that is wide across the axis and thin along it —
     nothing else on a sword has that shape. */
  const guard = parts.slice().sort((a, b) => (b.rmax / b.span) - (a.rmax / a.span))[0];
  const hilt = parts.filter(p => p !== guard && p.mid > guard.mid).sort((a, b) => a.mid - b.mid);
  const blade = parts.filter(p => p !== guard && p.mid <= guard.mid).sort((a, b) => b.span - a.span);
  const label = new Map();
  label.set(guard, 'crossguard');
  if (blade[0]) label.set(blade[0], 'blade');
  blade.slice(1).forEach(p => label.set(p, 'collar/ricasso'));
  if (hilt[0]) label.set(hilt[0], 'GRIP rod');
  hilt.slice(1).forEach(p => label.set(p, 'pommel'));

  console.log('\nsword anatomy (t measured along the sword axis, 0 = the derived grip):');
  console.log('  %s %s %s %s %s', 'part'.padEnd(15), 't span'.padEnd(17), 'max r'.padEnd(8), 'material'.padEnd(11), 'mesh');
  for (const p of parts.slice().sort((a, b) => a.mid - b.mid)) {
    console.log('  %s %s %s %s %s',
      (label.get(p) || '?').padEnd(15),
      (p.lo.toFixed(3) + ' .. ' + p.hi.toFixed(3)).padEnd(17),
      p.rmax.toFixed(3).padEnd(8), p.n.mats.join('/').padEnd(11), p.n.name);
  }
  const foreign = parts.filter(p => p.n.mats.indexOf('MAT_SWORD') < 0);
  console.log('  all five carry MAT_SWORD  : ' + (foreign.length === 0));
  console.log('  chord tip->pommel         : ' + grip.axis.len.toFixed(3) + 'm');
  const rod = hilt[0];
  if (rod && rod.lo > 0.02) {
    console.log('  NOTE the fist sits at t=0 but the grip rod starts at t=+' + rod.lo.toFixed(3) +
                ', past the crossguard at t=+' + guard.mid.toFixed(3) + ':');
    console.log('       the shipped ART has the hand on the ricasso, below the guard. A rig');
    console.log('       cannot move meshes; fixing that is a content edit. See the header.');
  }
  return foreign;
}

/* ---------- validation ----------
   Every check that would have caught the defect this rewrite exists to fix. */
function validate(bones, byBone, grip) {
  const errs = [];
  const boxes = {};
  for (const b of bones) {
    if (b.id === 'root') continue;                    /* root owns no meshes */
    const nodes = byBone[b.id] || [];
    if (!nodes.length) { errs.push(b.id + ': no meshes assigned'); continue; }
    const box = boxes[b.id] = bboxOf(nodes);
    for (let c = 0; c < 3; c++) {
      if (b.pivot[c] < box.lo[c] - 1e-6 || b.pivot[c] > box.hi[c] + 1e-6) {
        errs.push(b.id + ': pivot ' + fmt(b.pivot) + ' is outside the bbox of the meshes it moves ' +
                  fmt(box.lo) + '..' + fmt(box.hi) + ' on ' + 'xyz'[c]);
      }
    }
  }
  if (grip.toHand > GRIP_TOL) {
    errs.push('sword: grip is ' + grip.toHand.toFixed(3) + 'm from the right-hand centre (limit ' + GRIP_TOL + 'm)');
  }
  /* The bbox test cannot catch a bad sword pivot: the sword's bbox is 1.25m
     across and the defect this rewrite exists to fix sat comfortably inside
     it while being 0.129m off the blade's own line. So ask the sharper
     question — is the pivot actually ON the sword. */
  if (grip.toAxis > SWORD_AXIS_TOL) {
    errs.push('sword: grip is ' + grip.toAxis.toFixed(3) + 'm off the sword\'s own axis — ' +
              'it is not on the sword (limit ' + SWORD_AXIS_TOL + 'm)');
  }
  if (grip.t < grip.tMin || grip.t > grip.tMax) {
    errs.push('sword: grip is off the end of the sword (t=' + grip.t.toFixed(3) +
              ' outside ' + grip.tMin.toFixed(3) + '..' + grip.tMax.toFixed(3) + ')');
  }
  const ids = new Set(bones.map(b => b.id));
  for (const b of bones) {
    if (b.parent && !ids.has(b.parent)) errs.push(b.id + ': parent "' + b.parent + '" does not exist');
  }
  return errs;
}

function fmt(v) { return '[' + v.map(x => x.toFixed(3)).join(', ') + ']'; }
function round4(v) { return v.map(x => Math.round(x * 1e4) / 1e4); }

/* ---------- main ---------- */
const { gltf, bin } = readGlb(GLB);
const nodes = readNodes(gltf, bin);
const { map, byBone, unassigned, straddlers } = assign(nodes);

const counted = Object.values(map).reduce((a, v) => a + v.length, 0);
console.log('nodes in glb      : ' + gltf.nodes.length);
console.log('nodes assigned    : ' + counted);
console.log('nodes unassigned  : ' + unassigned.length);
for (const b of BONES) {
  if (map[b.id]) console.log('  %s%s', b.id.padEnd(10), map[b.id].length);
}
if (straddlers.length) {
  console.log('\ntwo-sided meshes pulled off a limb and onto the body:');
  for (const s of straddlers) {
    console.log('  %s %s -> %s   spans x %s .. %s', s.n.name.padEnd(42),
      s.from.padEnd(8), s.to, s.n.lo[0].toFixed(3), s.n.hi[0].toFixed(3));
  }
}
if (unassigned.length) {
  console.error('\nUNASSIGNED (add a rule for these):');
  for (const n of unassigned) console.error('  %s  x=%s y=%s', n.name, n.x.toFixed(2), n.y.toFixed(2));
  process.exitCode = 1;
}

/* Derive. Nothing below reads a remembered coordinate. */
const swordNodes = byBone.sword || [];
const handNodes = (byBone.forearmR || []).filter(n => /^Glove/.test(n.base));
if (!swordNodes.length) { console.error('\nno sword meshes — cannot derive a grip'); process.exit(1); }
if (!handNodes.length) { console.error('\nno right-hand glove meshes — cannot derive a grip'); process.exit(1); }

const gripInfo = gripPivot(handNodes, swordNodes);
const derived = {};
for (const b of BONES) {
  if (b.rule === 'grip') { derived[b.id] = gripInfo.pivot; continue; }
  if (b.rule === 'ground') {
    /* Between the boots, on the floor the model actually stands on. */
    const l = centroidOf(byBone.legL), r = centroidOf(byBone.legR);
    let floor = Infinity;
    for (const n of nodes) if (n.lo[1] < floor) floor = n.lo[1];
    derived[b.id] = [(l[0] + r[0]) / 2, floor, (l[2] + r[2]) / 2];
    continue;
  }
  if (b.rule === 'knee') { derived[b.id] = proximalPivot(byBone[b.id], b.axis); continue; }
  if (b.rule === 'waist' || b.rule === 'neck') {
    derived[b.id] = centralPivot(byBone[b.id], byBone[b.seamWith]);
    continue;
  }
  derived[b.id] = seamPivot(byBone[b.id], byBone[b.seamWith], b.rule === 'shoulder');
}

const bones = BONES.map(b => ({ id: b.id, parent: b.parent, pivot: round4(derived[b.id]), from: b.rule }));

function alongAxis(p, axis) {
  const o = axis.a, u = axis.u;
  return (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2];
}
function offAxisOf(p, axis) {
  const o = axis.a, u = axis.u, t = alongAxis(p, axis);
  return Math.hypot(p[0] - o[0] - u[0] * t, p[1] - o[1] - u[1] * t, p[2] - o[2] - u[2] * t);
}
/* How far the sword's own vertices run along that axis, so a grip that has
   slid off the end of the blade is an error rather than a curiosity. */
let swordTMin = Infinity, swordTMax = -Infinity;
for (const n of swordNodes) {
  for (let k = 0; k < n.pts.length; k += 3) {
    const t = alongAxis([n.pts[k], n.pts[k + 1], n.pts[k + 2]], gripInfo.axis);
    if (t < swordTMin) swordTMin = t;
    if (t > swordTMax) swordTMax = t;
  }
}

const gripCheck = {
  toHand: dist(gripInfo.pivot, gripInfo.hand),
  toAxis: offAxisOf(gripInfo.pivot, gripInfo.axis),
  t: alongAxis(gripInfo.pivot, gripInfo.axis),
  tMin: swordTMin, tMax: swordTMax
};
console.log('\nderived pivots (rule | DERIVED | was hand-authored | moved):');
for (const b of bones) {
  const old = LEGACY_PIVOTS[b.id];
  console.log('  %s %s %s  was %s  %sm',
    b.id.padEnd(10), b.from.padEnd(9), fmt(b.pivot), fmt(old), dist(b.pivot, old).toFixed(3));
}

const foreignSword = printSwordAnatomy(swordNodes, gripInfo);
if (foreignSword.length) {
  console.error('  a Merged_Sword mesh does not carry MAT_SWORD — check whether it belongs to the sword at all:');
  for (const p of foreignSword) console.error('    ' + p.n.name + '  ' + p.n.mats.join('/'));
  process.exitCode = 1;
}

console.log('\ngrip:');
console.log('  right-hand cluster centroid : ' + fmt(gripInfo.hand) + '  (' + handNodes.length + ' meshes)');
console.log('  derived grip pivot          : ' + fmt(gripInfo.pivot));
console.log('  offset grip -> hand centre  : ' + gripCheck.toHand.toFixed(4) + 'm   (limit ' + GRIP_TOL + 'm)');
console.log('  offset grip -> sword axis   : ' + gripCheck.toAxis.toFixed(4) + 'm   (limit ' + SWORD_AXIS_TOL + 'm)');
console.log('  the pivot it replaces was   : ' + fmt(LEGACY_PIVOTS.sword) +
            '  ' + dist(LEGACY_PIVOTS.sword, gripInfo.hand).toFixed(3) + 'm from the hand, ' +
            offAxisOf(LEGACY_PIVOTS.sword, gripInfo.axis).toFixed(3) + 'm off the sword axis');

/* The pivots are in NATIVE model metres and arena3d normalises the knight by
   scaling rig.root. Print the number that relationship depends on, so a
   re-exported GLB that changed height cannot go unnoticed — that is the §17
   "Box3 lies" trap the whole rig is built to avoid. */
let crown = -Infinity;
for (const n of nodes) if (n.hi[1] > crown) crown = n.hi[1];
console.log('\nnative height (crown y)       : ' + crown.toFixed(3) + 'm' +
            '   -> uniform scale for 2.15m: ' + (2.15 / crown).toFixed(4) + 'x on rig.root');

const errs = validate(bones, byBone, gripCheck);
console.log('\nvalidation:');
console.log('  every node assigned         : ' + (unassigned.length === 0));
console.log('  every pivot inside its own cluster bbox, grip within tolerance, tree intact : ' + (errs.length === 0));
for (const e of errs) console.error('  FAIL ' + e);
if (errs.length) process.exitCode = 1;

if (process.argv.includes('--check')) process.exit(process.exitCode || 0);
if (unassigned.length || errs.length) { console.error('\nrefusing to write an incomplete or invalid rig'); process.exit(1); }

const boneLines = bones.map(b =>
  '    { "id": ' + JSON.stringify(b.id) + ', "parent": ' + JSON.stringify(b.parent) +
  ', "pivot": [' + b.pivot.join(', ') + '], "from": ' + JSON.stringify(b.from) + ' }'
).join(',\n');

const body =
`/* CHLOE — data/knightrig.js   GENERATED by tools/build-knight-rig.js — do not hand-edit.
   Rigid bone hierarchy for assets/3d/knight.glb (skins:0 — see the tool header).
   source: knight.glb, ${gltf.nodes.length} mesh nodes, all assigned.

   Every pivot below is MEASURED from the vertices of the meshes its own bone
   owns — none is remembered. \`from\` records which rule measured it:
     ground   the floor between the boots        knee   the top of the boot cluster
     waist    where skirt and shirt meet         grip   the right fist, on the sword's axis
     neck / shoulder / elbow   where the two plate groups meet
   The grip is the §28 B2 fix: the old hand-authored [-0.28, 0.95, 0] sat
   ${dist(LEGACY_PIVOTS.sword, gripInfo.hand).toFixed(3)}m from the fist and ${offAxisOf(LEGACY_PIVOTS.sword, gripInfo.axis).toFixed(3)}m off the sword's own axis, so the blade
   coned around a point beside itself. It is now ${gripCheck.toHand.toFixed(4)}m from the fist centroid. */
window.CHLOE = window.CHLOE || {};
CHLOE.data = CHLOE.data || {};

CHLOE.data.knightRig = {
  bones: [
${boneLines}
  ],
  meshes: ${JSON.stringify(map, null, 2).replace(/\n/g, '\n  ')}
};
`;
fs.writeFileSync(OUT, body);
console.log('\nwrote ' + path.relative(ROOT, OUT));
