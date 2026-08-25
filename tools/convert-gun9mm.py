#  CHLOE - tools/convert-gun9mm.py
#  The Blender half of the 9mm conversion. Driven by tools/convert-gun9mm.js;
#  run it through that, not by hand, so the verification pass always follows.
#
#  Turns the user-supplied FBX + 2k PBR set into game/assets/3d/gun9mm.glb the
#  same way the church and knight were done: import, RELINK the textures to the
#  PBR slots the FBX never wired, downscale to 1k, Draco, GLB.
#
#  ---------------------------------------------------------------------------
#  WHAT THE SOURCE FBX ACTUALLY IS, AND WHY EACH FIX-UP BELOW EXISTS
#  ---------------------------------------------------------------------------
#  It is a beauty-shot scene, not a game asset. Measured on import:
#
#    * 7 pistol meshes sharing one material, PLUS `Plane001` (a 20x20 backdrop
#      wearing its own `Plane_Diffuse`) and an empty called `Sky001`. Neither is
#      the pistol, so both go - along with the `Plane` material and its texture,
#      which is a third of the source PNG bytes we would otherwise ship.
#
#    * The FBX wires ONLY the normal map. Albedo, roughness, metallic, AO and
#      emissive sit unreferenced on disk. That is the "relink" step: without it
#      the gun exports as a flat grey lump with bumps.
#
#    * `Clip_low` - the magazine - is posed HALF OUT of the magwell, tilted and
#      shifted for the render. Every other pistol part shares one object
#      transform (loc 0,0.3191,0.5215 / rot 1.0725,0,0); the magazine alone
#      differs, which is the tell: the artist dragged it out, so copying the
#      shared transform onto it puts it back. It does, exactly - the reseated
#      magazine's lowest vertex lands on the frame's lowest vertex to four
#      decimals, i.e. the baseplate goes flush with the magwell - but its mesh
#      is authored in a mirrored lateral space, so it also needs recentring on
#      the frame's X midline. Both are done below, and both are DERIVED; the
#      alternative was shipping a pistol with a magazine sticking out of it.
#
#    * The whole scene is tilted ~30 degrees nose-up (the gun was propped on the
#      backdrop). Axis-aligned bounding boxes are therefore lies here - the
#      first read of them put the muzzle at the wrong end. So the barrel axis is
#      DERIVED, by PCA on the slide, and which end is the muzzle is decided by
#      the hammer: the hammer is at the back of a pistol, so the muzzle is the
#      other end. Nothing about the orientation is remembered from a note.
#
#  ---------------------------------------------------------------------------
#  THE OUTPUT CONTRACT (the mount agent depends on all four)
#  ---------------------------------------------------------------------------
#  1. Y-up, metres, barrel down -Z. That is THREE's own forward, so a gun
#     parented to the camera with an identity quaternion already points where
#     the player looks.
#  2. NORMALISED: the barrel-axis extent is exactly 1.000 m and the origin is
#     the bounding-box centre. `scale.setScalar(L)` therefore makes the pistol
#     L metres long, with no Box3 measuring pass and no magic constant.
#  3. A real `Muzzle` node at the bore, so §29's tracer starts at the barrel
#     instead of at a guess. It carries NO rotation - the fire direction is the
#     gun root's own -Z. A rotated marker is one THREE getWorldDirection()
#     sign convention away from firing backwards.
#  4. Node names that survive THREE's GLTFLoader. See sanitize_ok() below.

import bpy
import sys
import os
import json
import math
import numpy as np
from mathutils import Vector, Matrix

TEX_ROLES = [
    # (file stem,           colour space, role)
    ('GunGS_Albedo',        'sRGB',      'base'),
    ('GunGS_NormalGL',      'Non-Color', 'normal'),
    ('GunGS_Roughness',     'Non-Color', 'rough'),
    ('GunGS_Metallic',      'Non-Color', 'metal'),
    ('GunGS_AO',            'Non-Color', 'ao'),
    ('GunGS_Emissive',      'sRGB',      'emit'),
]

# Every mesh gets a name that is a FIXED POINT of THREE's sanitiser (see
# sanitize_ok). `Slide Stop_low` is the reason this table exists: THREE turns
# its space into an underscore, so the name in the file would not be the name
# in the scene graph. §28 lost a whole feature to exactly that.
RENAME = {
    'Frame_low':      'Frame',
    'Slide_low':      'Slide',
    'Clip_low':       'Magazine',
    'Trigger_low':    'Trigger',
    'Hammer_low':     'Hammer',
    'Ejector_low':    'Ejector',
    'Slide Stop_low': 'SlideStop',
}

NOT_THE_PISTOL = ('Plane001', 'Sky001')


def argv():
    a = sys.argv[sys.argv.index('--') + 1:]
    out = {}
    for i in range(0, len(a), 2):
        out[a[i].lstrip('-')] = a[i + 1]
    return out


def sanitize_ok(name):
    """THREE r128, PropertyBinding.sanitizeNodeName: whitespace becomes '_' and
    [ ] . : / are DELETED. A name is safe only if it is unchanged by that."""
    import re
    return name == re.sub(r'[\[\]\.:/]', '', re.sub(r'\s', '_', name))


def world_verts(o):
    return np.array([(o.matrix_world @ v.co)[:] for v in o.data.vertices])


def meshes():
    return [o for o in bpy.data.objects if o.type == 'MESH']


# ---------------------------------------------------------------- 1. import
def load(src):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    dropped = []
    for o in list(bpy.data.objects):
        if o.name in NOT_THE_PISTOL or o.type in ('CAMERA', 'LIGHT', 'EMPTY'):
            kind, data = o.type, o.data   # read BOTH before the remove: the
            dropped.append('%s (%s)' % (o.name, kind))   # struct dies with it
            bpy.data.objects.remove(o, do_unlink=True)
            # Drop the datablock too, or its material keeps a user and the
            # backdrop's 5MB texture rides along into the GLB.
            if kind == 'MESH' and data and data.users == 0:
                bpy.data.meshes.remove(data)
    for m in list(bpy.data.materials):
        if m.users == 0:
            dropped.append('material %s' % m.name)
            bpy.data.materials.remove(m)
    for i in list(bpy.data.images):
        if i.users == 0:
            bpy.data.images.remove(i)
    return dropped


# ------------------------------------------------- 2. put the magazine back
def seat_magazine(report):
    clip = bpy.data.objects.get('Clip_low')
    frame = bpy.data.objects.get('Frame_low')
    if not clip or not frame:
        raise SystemExit('convert-gun9mm: expected Clip_low and Frame_low in the FBX')
    before = world_verts(clip)
    # The shared transform IS the modelling pose; the magazine was dragged off it.
    clip.matrix_world = frame.matrix_world.copy()
    bpy.context.view_layer.update()
    # ...but the magazine mesh is authored mirrored in X, so it lands beside the
    # grip rather than inside it. Recentre it on the frame's own lateral midline.
    cp, fr = world_verts(clip), world_verts(frame)
    dx = (fr[:, 0].min() + fr[:, 0].max()) / 2 - (cp[:, 0].min() + cp[:, 0].max()) / 2
    clip.matrix_world = Matrix.Translation((dx, 0, 0)) @ clip.matrix_world
    bpy.context.view_layer.update()
    after = world_verts(clip)
    fr = world_verts(frame)
    report['magazine'] = {
        'moved_by_m': round(float(np.linalg.norm(after.mean(0) - before.mean(0))), 4),
        'lateral_recentre_m': round(float(dx), 4),
        # the proof the seat is right: baseplate flush with the magwell floor
        'baseplate_vs_frame_bottom_m': round(float(after[:, 2].min() - fr[:, 2].min()), 5),
        'inside_frame_x': bool(after[:, 0].min() >= fr[:, 0].min() - 1e-4
                               and after[:, 0].max() <= fr[:, 0].max() + 1e-4),
    }


# --------------------------------- 3. derive the barrel axis, don't remember
def derive_basis(report):
    slide = bpy.data.objects['Slide_low']
    P = world_verts(slide)
    c = P.mean(axis=0)
    _, sv, vt = np.linalg.svd(P - c, full_matrices=False)
    axis, up = vt[0], vt[1]           # longest spread = barrel line, next = slide height
    # The hammer is at the BACK of a pistol. Whichever end it sits at is the rear.
    ham = world_verts(bpy.data.objects['Hammer_low']).mean(axis=0)
    if float((ham - c) @ axis) > 0:
        axis = -axis                  # make `axis` point at the muzzle
    # The trigger hangs BELOW the bore; use it to settle which way is up.
    tri = world_verts(bpy.data.objects['Trigger_low']).mean(axis=0)
    if float((tri - c) @ up) > 0:
        up = -up
    fwd = Vector(axis.tolist()).normalized()
    upv = Vector(up.tolist()).normalized()
    rgt = fwd.cross(upv).normalized()
    upv = rgt.cross(fwd).normalized()  # re-orthogonalise; PCA axes are only near-perfect
    report['basis'] = {
        'slide_singular_values': [round(float(v), 4) for v in sv],
        'muzzle_axis_world': [round(v, 5) for v in fwd],
        'up_axis_world': [round(v, 5) for v in upv],
        'hammer_side': 'rear (decides the muzzle end)',
    }
    # Blender is Z-up and the exporter maps Blender +Y -> glTF -Z, +Z -> glTF +Y.
    # So aim the muzzle at Blender +Y and the slide top at Blender +Z.
    return Matrix((rgt, fwd, upv)).to_4x4()


def bake(mat4):
    """Fold a world matrix into the mesh data so no object transform survives."""
    done = set()
    for o in meshes():
        m = mat4 @ o.matrix_world
        if o.data.name not in done:
            o.data.transform(m)
            done.add(o.data.name)
        o.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()


def all_verts():
    return np.vstack([world_verts(o) for o in meshes()])


# ------------------------------------------------------- 4. normalise to 1 m
def normalise(report, target_len):
    P = all_verts()
    mn, mx = P.min(axis=0), P.max(axis=0)
    native = mx - mn
    report['native'] = {
        'width_x': round(float(native[0]), 5),
        'length_y': round(float(native[1]), 5),
        'height_z': round(float(native[2]), 5),
    }
    s = target_len / float(native[1])         # Y is the barrel axis after bake()
    ctr = Vector(((mn + mx) / 2).tolist())
    bake(Matrix.Scale(s, 4) @ Matrix.Translation(-ctr))
    P = all_verts()
    report['normalised'] = {
        'scale_applied': round(float(s), 6),
        'min': [round(float(v), 5) for v in P.min(axis=0)],
        'max': [round(float(v), 5) for v in P.max(axis=0)],
        'size': [round(float(v), 5) for v in (P.max(axis=0) - P.min(axis=0))],
    }
    return s


# ------------------------------------------- 5. the muzzle, and a grip anchor
def anchors(report):
    """§29 wants the tracer to leave the BARREL. The FBX has no muzzle node, so
    derive one: the barrel stub is the forward-most geometry on the frame (it
    protrudes past the slide), and its front face is a small ring. Take every
    vertex within a hair of the forward-most one and average them - that is the
    bore centre on the muzzle face, not merely 'the front of the bbox'."""
    frame = bpy.data.objects['Frame']
    F = world_verts(frame)
    ymax = F[:, 1].max()
    ring = F[F[:, 1] >= ymax - 0.01]
    muzzle = Vector((float(ring[:, 0].mean()), float(ymax), float(ring[:, 2].mean())))
    report['muzzle'] = {
        'ring_vertices': int(len(ring)),
        # a small cross-section is the proof this is a barrel and not a slab
        'ring_x_extent': round(float(ring[:, 0].max() - ring[:, 0].min()), 5),
        'ring_z_extent': round(float(ring[:, 2].max() - ring[:, 2].min()), 5),
        'blender_xyz': [round(v, 5) for v in muzzle],
    }

    # Grip: the frame behind the trigger and below the slide. Its centroid is
    # roughly the middle of a closed fist, which is what a hand rig wants.
    S = world_verts(bpy.data.objects['Slide'])
    T = world_verts(bpy.data.objects['Trigger'])
    g = F[(F[:, 1] < T[:, 1].min()) & (F[:, 2] < S[:, 2].min())]
    grip = Vector((float(g[:, 0].mean()), float(g[:, 1].mean()), float(g[:, 2].mean())))
    report['grip'] = {
        'cluster_vertices': int(len(g)),
        'blender_xyz': [round(v, 5) for v in grip],
    }

    for name, loc in (('Muzzle', muzzle), ('Grip', grip)):
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = 'PLAIN_AXES'
        e.empty_display_size = 0.05
        e.location = loc
        # No rotation, deliberately: the fire direction is the gun root's -Z.
        bpy.context.scene.collection.objects.link(e)
    bpy.context.view_layer.update()


# -------------------------------------------------- 6. relink the PBR slots
def prep_texture(src, dst, colorspace, size, quality):
    im = bpy.data.images.load(src)
    w, h = im.size
    if max(w, h) > size:
        k = size / float(max(w, h))
        im.scale(max(1, int(round(w * k))), max(1, int(round(h * k))))
    im.file_format = 'JPEG'
    im.filepath_raw = dst
    im.save(quality=quality)              # writes the raw buffer; no view transform
    bpy.data.images.remove(im)
    out = bpy.data.images.load(dst)       # reload so file and datablock agree, or
    out.colorspace_settings.name = colorspace  # the exporter may copy the 2k original
    return out


def build_material(texdir, tmpdir, size, quality, report):
    mat = bpy.data.materials.new('Gun9mm')
    mat.use_nodes = True
    # A pistol is a closed solid, and this one hugs the near plane. Backface
    # culling makes the exporter emit doubleSided:false, which halves the
    # shading on the most over-sampled object on screen and stops interior
    # faces flickering through the ejection port.
    mat.use_backface_culling = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (600, 0)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (280, 0)
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

    imgs, y = {}, 400
    for stem, cs, role in TEX_ROLES:
        src = os.path.join(texdir, stem + '.tga.png')
        if not os.path.exists(src):
            raise SystemExit('convert-gun9mm: missing texture %s' % src)
        im = prep_texture(src, os.path.join(tmpdir, stem + '.jpg'), cs, size, quality)
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = im
        node.label = role
        node.location = (-520, y)
        y -= 300
        imgs[role] = node
        report.setdefault('textures', {})[role] = {
            'source': os.path.basename(src), 'size': list(im.size), 'colorspace': cs,
        }

    nt.links.new(imgs['base'].outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(imgs['rough'].outputs['Color'], bsdf.inputs['Roughness'])
    nt.links.new(imgs['metal'].outputs['Color'], bsdf.inputs['Metallic'])

    nrm = nt.nodes.new('ShaderNodeNormalMap')
    nrm.location = (-180, -200)
    nt.links.new(imgs['normal'].outputs['Color'], nrm.inputs['Color'])
    nt.links.new(nrm.outputs['Normal'], bsdf.inputs['Normal'])
    # NormalGL is the OpenGL green convention, which is glTF's convention too -
    # no channel flip. A DirectX map here would light every dent inside out.

    emit_in = 'Emission Color' if 'Emission Color' in bsdf.inputs else 'Emission'
    nt.links.new(imgs['emit'].outputs['Color'], bsdf.inputs[emit_in])
    if 'Emission Strength' in bsdf.inputs:
        bsdf.inputs['Emission Strength'].default_value = 1.0

    # AO has no Principled slot. glTF takes it through the exporter's own group
    # node; the name changed across Blender versions, so try both and let the
    # verifier in convert-gun9mm.js confirm an occlusionTexture actually landed.
    grp = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    try:
        grp.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    except AttributeError:
        grp.inputs.new('NodeSocketFloat', 'Occlusion')
    gn = nt.nodes.new('ShaderNodeGroup')
    gn.node_tree = grp
    gn.location = (280, -520)
    nt.links.new(imgs['ao'].outputs['Color'], gn.inputs['Occlusion'])

    for o in meshes():
        o.data.materials.clear()
        o.data.materials.append(mat)
    return mat


# --------------------------------------------------------------- 7. export
def export(path, quality):
    want = dict(
        filepath=path,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        export_tangents=False,
        export_image_format='JPEG',
        export_jpeg_quality=quality,
        export_image_quality=quality,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
    )
    # Blender renames exporter properties between releases (export_jpeg_quality
    # became export_image_quality in 4.x). Pass only what THIS build accepts
    # rather than pinning a version.
    known = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kwargs = {k: v for k, v in want.items() if k in known}
    bpy.ops.export_scene.gltf(**kwargs)
    return sorted(set(want) - known)


def main():
    a = argv()
    size = int(a.get('tex', 1024))
    quality = int(a.get('quality', 90))
    tmpdir = a['tmp']
    os.makedirs(tmpdir, exist_ok=True)
    report = {}

    report['dropped'] = load(a['src'])
    seat_magazine(report)
    bake(derive_basis(report))
    normalise(report, float(a.get('length', 1.0)))

    for o in meshes():
        if o.name in RENAME:
            o.data.name = RENAME[o.name]
            o.name = RENAME[o.name]
    anchors(report)
    build_material(a['tex_dir'], tmpdir, size, quality, report)

    report['skipped_export_options'] = export(a['out'], quality)
    report['nodes'] = sorted(o.name for o in bpy.data.objects)
    report['unsafe_node_names'] = [n for n in report['nodes'] if not sanitize_ok(n)]
    report['tris'] = int(sum(len(p.vertices) - 2
                             for o in meshes() for p in o.data.polygons))
    report['verts'] = int(sum(len(o.data.vertices) for o in meshes()))
    report['bytes'] = os.path.getsize(a['out'])
    with open(a['report'], 'w') as f:
        json.dump(report, f, indent=2)
    print('convert-gun9mm: wrote %s (%d bytes)' % (a['out'], report['bytes']))


main()
