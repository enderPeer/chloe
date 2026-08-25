#!/usr/bin/env node
/* CHLOE — tools/convert-gun9mm.js
   Builds game/assets/3d/gun9mm.glb from the user-supplied 9mm FBX + PBR set,
   then VERIFIES the result. Same pipeline the church and knight went through:
   headless Blender → relink textures → downscale to 1k → Draco → GLB.

   Usage:
     node tools/convert-gun9mm.js --src <dir>            # dir holds source/ + textures/
     node tools/convert-gun9mm.js --verify-only          # just re-check the shipped GLB

   The heavy lifting is in tools/convert-gun9mm.py (Blender's Python); read its
   header for what the source FBX actually is and why each fix-up exists. This
   file exists to (a) find Blender and hand it the right paths, and (b) prove
   afterwards that what came out is loadable, because a GLB that Blender wrote
   without complaint can still be one THREE r128 refuses.

   ---------------------------------------------------------------------------
   WHAT "VERIFY" MEANS HERE, AND WHY EACH CHECK IS IN THE LIST
   ---------------------------------------------------------------------------
   * The container parses: magic/version/chunk table walked by hand, not by a
     library, so a truncated or mis-padded file is caught here and not in the
     browser at round 5.
   * Exactly one material and the expected meshes. A second material means the
     backdrop plane came along; a missing mesh means a part was dropped.
   * Every texture is EMBEDDED (bufferView, not uri). A relative uri would 404
     under GitHub Pages and the gun would render untextured but silent.
   * Draco actually applied — every primitive carries KHR_draco_mesh_compression
     and the loader is set up for it (vendor/draco is already wired in
     engine/arena3d.js).
   * The PBR set is complete: baseColour, metallicRoughness, normal, occlusion,
     emissive. This is the check that catches the relink silently failing — the
     source FBX ships six maps and wires ONE.
   * Node names are FIXED POINTS of THREE's PropertyBinding.sanitizeNodeName.
     §28 lost a feature because GLTFLoader deletes ':' from names, so a name
     that does not survive the sanitiser is a hard failure here, not a note.
   * The Muzzle/Grip anchor nodes exist, with no rotation, at sane positions —
     §29 needs the tracer to start at the barrel, and a marker that is not in
     the file is a marker the mount agent will guess at. */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'game', 'assets', '3d', 'gun9mm.glb');
const PY = path.join(__dirname, 'convert-gun9mm.py');

/* Blender is not on PATH on this machine and the §29 note records that it had
   to be reinstalled. Look where it actually lives before giving up. */
const BLENDER_CANDIDATES = [
  process.env.BLENDER,
  'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
  '/usr/bin/blender',
  '/Applications/Blender.app/Contents/MacOS/Blender',
].filter(Boolean);

function findBlender() {
  for (const c of BLENDER_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('Blender not found. Set BLENDER=<path to blender executable>.');
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : process.argv[i + 1];
}

// --------------------------------------------------------------- the build
function build() {
  const srcRoot = arg('src');
  if (!srcRoot) throw new Error('--src <dir> is required (the dir holding source/ and textures/)');
  const srcDir = path.join(srcRoot, 'source');
  const texDir = path.join(srcRoot, 'textures');
  const fbx = fs.readdirSync(srcDir).filter((f) => /\.fbx$/i.test(f))[0];
  if (!fbx) throw new Error('no .fbx under ' + srcDir);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gun9mm-'));
  const report = path.join(tmp, 'report.json');
  const out = execFileSync(findBlender(), [
    '-b', '--factory-startup', '-noaudio', '--python', PY, '--',
    '--src', path.join(srcDir, fbx),
    '--tex_dir', texDir,
    '--out', OUT,
    '--report', report,
    '--tmp', path.join(tmp, 'tex'),
    '--tex', arg('tex', '1024'),
    '--quality', arg('quality', '85'),
    '--length', arg('length', '1.0'),
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  process.stdout.write(out.split('\n').filter((l) => /convert-gun9mm|Error|Traceback/.test(l)).join('\n') + '\n');
  return JSON.parse(fs.readFileSync(report, 'utf8'));
}

// -------------------------------------------------- the GLB container walk
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  if (buf.readUInt32LE(4) !== 2) throw new Error('GLB version is not 2');
  if (buf.readUInt32LE(8) !== buf.length) {
    throw new Error(`GLB header length ${buf.readUInt32LE(8)} != file length ${buf.length}`);
  }
  let off = 12;
  let json = null;
  let binLen = 0;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) binLen = len;
    off += 8 + len;
    if (len % 4 !== 0) throw new Error('chunk length not 4-byte aligned');
  }
  if (off !== buf.length) throw new Error('chunk table overruns the file');
  if (!json) throw new Error('no JSON chunk');
  return { json, binLen, bytes: buf.length };
}

/* THREE r128, PropertyBinding.sanitizeNodeName. Reproduced rather than
   imported because that is the exact transform GLTFLoader applies to every
   node name on load, and this file must not drift from it silently. */
function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[[\]./:]/g, '');
}

const EXPECTED_MESHES = ['Ejector', 'Frame', 'Hammer', 'Magazine', 'Slide', 'SlideStop', 'Trigger'];

function verify(file) {
  const { json: g, binLen, bytes } = readGlb(file);
  const fail = [];
  const note = [];
  const ok = (cond, msg) => { if (!cond) fail.push(msg); };

  const names = (g.nodes || []).map((n) => n.name);
  const meshNodes = (g.nodes || []).filter((n) => n.mesh !== undefined).map((n) => n.name).sort();

  ok((g.materials || []).length === 1,
    `expected 1 material, found ${(g.materials || []).length}: ${(g.materials || []).map((m) => m.name)}`);
  ok(JSON.stringify(meshNodes) === JSON.stringify(EXPECTED_MESHES),
    `mesh nodes ${JSON.stringify(meshNodes)} != ${JSON.stringify(EXPECTED_MESHES)}`);
  ok(!(g.cameras || []).length, 'a camera survived into the GLB');
  ok(!(g.animations || []).length, 'unexpected animations');

  // every image embedded, none referenced by uri
  (g.images || []).forEach((im, i) => {
    ok(im.bufferView !== undefined && !im.uri, `image ${i} is not embedded (uri=${im.uri})`);
  });

  // Draco on every primitive
  let prims = 0;
  let draco = 0;
  (g.meshes || []).forEach((m) => (m.primitives || []).forEach((p) => {
    prims++;
    if (p.extensions && p.extensions.KHR_draco_mesh_compression) draco++;
  }));
  ok(prims > 0 && draco === prims, `Draco on ${draco}/${prims} primitives`);
  ok((g.extensionsRequired || []).includes('KHR_draco_mesh_compression'),
    'KHR_draco_mesh_compression missing from extensionsRequired');

  // the full PBR set — this is the check that catches a failed relink
  const m = (g.materials || [])[0] || {};
  const pbr = m.pbrMetallicRoughness || {};
  ok(pbr.baseColorTexture, 'no baseColorTexture');
  ok(pbr.metallicRoughnessTexture, 'no metallicRoughnessTexture');
  ok(m.normalTexture, 'no normalTexture');
  ok(m.occlusionTexture, 'no occlusionTexture (the AO relink did not land)');
  ok(m.emissiveTexture, 'no emissiveTexture');
  if (m.occlusionTexture && pbr.metallicRoughnessTexture
      && m.occlusionTexture.index === pbr.metallicRoughnessTexture.index) {
    note.push('AO/roughness/metallic share one ORM texture — AO costs no extra bytes');
  }

  // §28's trap: names must survive GLTFLoader untouched
  const unsafe = names.filter((n) => n && n !== sanitizeNodeName(n));
  ok(unsafe.length === 0, `node names THREE will rewrite: ${JSON.stringify(unsafe)}`);

  // the anchors §29 needs
  ['Muzzle', 'Grip'].forEach((n) => {
    const node = (g.nodes || []).find((x) => x.name === n);
    ok(node, `no ${n} node`);
    if (node) {
      ok(node.mesh === undefined, `${n} should be an empty, not a mesh`);
      ok(!node.rotation, `${n} carries a rotation; it must be axis-aligned (fire direction is the root's -Z)`);
      note.push(`${n} at [${(node.translation || [0, 0, 0]).map((v) => v.toFixed(4))}]`);
    }
  });

  return { g, bytes, binLen, fail, note, prims };
}

// --------------------------------------------------------------------- run
function main() {
  let report = null;
  if (process.argv.indexOf('--verify-only') === -1) report = build();

  const v = verify(OUT);
  console.log('\ngun9mm.glb — ' + (v.bytes / 1024).toFixed(1) + ' KiB'
    + ' (bin chunk ' + (v.binLen / 1024).toFixed(1) + ' KiB)');
  console.log('  meshes      ' + (v.g.meshes || []).length + ' / primitives ' + v.prims
    + ' / materials ' + (v.g.materials || []).length
    + ' / images ' + (v.g.images || []).length);
  console.log('  nodes       ' + (v.g.nodes || []).map((n) => n.name).join(', '));
  if (report) {
    console.log('  native size ' + JSON.stringify(report.native));
    console.log('  normalised  ' + JSON.stringify(report.normalised));
    console.log('  muzzle      ' + JSON.stringify(report.muzzle));
    console.log('  magazine    ' + JSON.stringify(report.magazine));
  }
  v.note.forEach((n) => console.log('  note        ' + n));
  if (v.fail.length) {
    v.fail.forEach((f) => console.error('  FAIL        ' + f));
    process.exit(1);
  }
  console.log('  OK          every check passed');
}

main();
