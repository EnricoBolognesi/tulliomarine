"""Build the Sauvage 34 Spider model in Blender and export it as GLB.

Run headless:
  blender --background --python tools/blender/build_boat.py -- <out.glb> [preview_dir]

Blender axes: +X bow, +Y port/starboard, +Z up, metres, origin at the waterline
amidships. The glTF exporter converts to +Y up, which is what the site expects.
"""
import bpy
import bmesh
import math
import os
import sys
from math import sin, cos, pi, radians, tan, atan2
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.abspath('sauvage34.glb')
PREVIEW = argv[1] if len(argv) > 1 else None

LOA = 10.3
HALF = LOA / 2
GUN = 0.16        # gunwale cap width
FLOOR = 0.5       # cockpit sole above waterline
CA, CF = 0.03, 0.537  # cockpit extent in t


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(t):
    return max(0.0, min(1.0, t))


def smooth(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def x_of(t):
    return -HALF + t * LOA


def t_of(x):
    return (x + HALF) / LOA


# ---------------- hull lines ----------------
def beam(t):
    if t < 0.5:
        return lerp(1.42, 1.5, smooth(0, 0.5, t))
    u = (t - 0.5) / 0.5
    return 1.5 * max(0.0, 1 - u ** 2.6) ** 0.5


def sheer(t):
    return 1.1 + 0.42 * t ** 2.3 - 0.42 * (1 - smooth(0.0, 0.16, t)) + 0.1 * smooth(0.47, 0.55, t)


def keel(t):
    if t < 0.6:
        return -0.52 + 0.04 * (1 - t / 0.6)
    u = (t - 0.6) / 0.4
    return -0.52 + (sheer(1) - 0.02 + 0.52) * u ** 2.1


def deadrise(t):
    return radians(lerp(21, 48, smooth(0.45, 1, t)))


def chine(t):
    B = beam(t)
    c = B * lerp(0.84, 0.58, smooth(0.5, 0.95, t))
    k = keel(t)
    s = sheer(t)
    y = min(k + tan(deadrise(t)) * c, lerp(k, s, 0.55))
    return c, y, k, s, B


def flare_at(t, v):
    """Section shape of the topsides: near-vertical aft, flaring outward toward the sheer forward."""
    aft = 1 - (1 - v) ** 2.2
    fwd = 0.35 * v + 0.65 * v ** 2.4
    return lerp(aft, fwd, smooth(0.5, 0.9, t))


def bottom_pt(t, v, side):
    c, y, k, s, B = chine(t)
    if v < 0.85:
        w = v / 0.85
        return Vector((x_of(t), side * c * w, lerp(k, y, w) - 0.03 * sin(pi * w)))
    w = (v - 0.85) / 0.15
    return Vector((x_of(t), side * (c + 0.07 * w * B / 1.5), y + 0.005 * w))


def topside_pt(t, v, side):
    c, y, k, s, B = chine(t)
    z0 = c + 0.07 * B / 1.5
    return Vector((x_of(t), side * lerp(z0, B, flare_at(t, v)), lerp(y, s, v)))


def deck_h(t, yy):
    B = beam(t)
    r = yy / B if B > 0.001 else 0
    return sheer(t) + 0.07 * (1 - r * r)


def cockpit_w(t):
    return smooth(CA - 0.012, CA, t) * (1 - smooth(CF - 0.012, CF, t))


# ---------------- scene + materials ----------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def material(name, color, rough=0.5, metal=0.0, coat=0.0, alpha=1.0, double=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.06
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            m.blend_method = 'BLEND'
    m.use_backface_culling = not double
    return m


def hexc(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def teak_image():
    import random
    random.seed(4)
    n = 256
    base = (0xa8 / 255, 0x86 / 255, 0x64 / 255)
    seam = (0x3a / 255, 0x33 / 255, 0x2c / 255)
    px = [0.0] * (n * n * 4)
    for y in range(n):
        streak = 1 + (random.random() - 0.5) * 0.12
        is_seam = (y % 64) < 5
        for x in range(n):
            c = seam if is_seam else tuple(v * streak * (1 + (random.random() - 0.5) * 0.05) for v in base)
            i = (y * n + x) * 4
            px[i:i + 4] = (c[0], c[1], c[2], 1.0)
    img = bpy.data.images.new('teak', n, n)
    img.pixels = px
    img.pack()
    return img


M = {
    'hull': material('Gelcoat', hexc('#f4f5f5'), 0.1, coat=1.0, double=True),
    'antifoul': material('Antifoul', hexc('#141a22'), 0.6, double=True),
    'deck': material('Deck', hexc('#efeee8'), 0.2, coat=0.8, double=True),
    'graphite': material('Graphite', hexc('#20252b'), 0.25, coat=1.0, double=True),
    'window': material('HullWindow', hexc('#080c10'), 0.05, metal=0.2, coat=1.0, double=True),
    'black': material('BlackGloss', hexc('#0b0c0e'), 0.1, metal=0.0, coat=1.0),
    'cushion': material('Upholstery', hexc('#e6e2d6'), 0.48),
    'steel': material('Steel', hexc('#e9ecef'), 0.09, metal=1.0),
    'glass': material('Glass', hexc('#1a252d'), 0.04, metal=0.1, alpha=0.5, double=True),
    'engine': material('EngineWhite', hexc('#f2f4f5'), 0.3, coat=1.0),
    'dark': material('DarkPlastic', hexc('#23272c'), 0.45, metal=0.2),
    'screen': material('Screen', hexc('#04070a'), 0.05, coat=1.0),
    'teak': material('Teak', hexc('#a57c55'), 0.7),
    'oak': material('Oak', hexc('#d9b27c'), 0.5, coat=0.3),
}

# ---------------- procedural textures (tileable; one tile = TILE metres) ----------------
import numpy as np

TILE = 0.34
TEX = 512


def _wrap_noise(n, blur_x, blur_y, seed):
    """Seamless noise: random field low-passed in the frequency domain."""
    rng = np.random.default_rng(seed)
    f = np.fft.fft2(rng.random((n, n)).astype(np.float32))
    ky = np.fft.fftfreq(n)[:, None]
    kx = np.fft.fftfreq(n)[None, :]
    b = np.real(np.fft.ifft2(f * np.exp(-((kx * blur_x) ** 2 + (ky * blur_y) ** 2) * 20.0)))
    b -= b.min()
    return b / max(float(b.max()), 1e-6)


def _soft(h, times=2):
    for _ in range(times):
        h = (h + np.roll(h, 1, 0) + np.roll(h, -1, 0) + np.roll(h, 1, 1) + np.roll(h, -1, 1)) / 5.0
    return h


def _image(name, rgb, colorspace='sRGB'):
    n = rgb.shape[0]
    px = np.ones((n, n, 4), np.float32)
    px[..., :3] = np.clip(rgb, 0.0, 1.0)
    img = bpy.data.images.new(name, n, n)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()
    return img


def _normal_map(name, h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    ln = np.sqrt(dx * dx + dy * dy + 1.0)
    return _image(name, np.stack([-dx / ln * 0.5 + 0.5, -dy / ln * 0.5 + 0.5, 1.0 / ln * 0.5 + 0.5], -1), 'Non-Color')


def _attach(mat, color=None, normal=None, strength=1.0):
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    if color is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = color
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])


def _planks(base, caulk, seed, planks=4, caulk_px=7):
    """Planked deck: per-plank tint, grain along the plank, recessed dark caulking lines."""
    n = TEX
    grain = _wrap_noise(n, 70.0, 2.5, seed)
    fine = _wrap_noise(n, 12.0, 1.2, seed + 1)
    rows = np.arange(n)[:, None] * np.ones((1, n), np.int32)
    step = n // planks
    plank = rows // step
    rng = np.random.default_rng(seed + 2)
    tint = rng.uniform(0.93, 1.07, planks).astype(np.float32)[plank]
    is_caulk = (rows % step) < caulk_px
    shade = tint * (0.86 + 0.2 * grain + 0.08 * fine)
    rgb = np.stack([base[i] * shade for i in range(3)], -1)
    rgb[is_caulk] = caulk
    height = np.where(is_caulk, 0.0, 1.0).astype(np.float32) + 0.1 * grain
    return rgb, _soft(height, 2)


_rgb, _h = _planks((0.69, 0.55, 0.40), (0.09, 0.085, 0.08), 11)
_attach(M['teak'], _image('teak_color', _rgb), _normal_map('teak_normal', _h, 5.0), 1.0)
M['teakdark'] = material('TeakDark', hexc('#3b3d40'), 0.75)
_rgb, _h = _planks((0.27, 0.28, 0.29), (0.05, 0.05, 0.05), 23)
_attach(M['teakdark'], _image('teakdark_color', _rgb), _normal_map('teakdark_normal', _h, 5.0), 1.0)

# Upholstery: marine vinyl - fine pebbled grain with a satin sheen, slightly warm white.
_grain = 0.6 * _wrap_noise(TEX, 1.6, 1.6, 31) + 0.4 * _wrap_noise(TEX, 0.8, 0.8, 32)
_var = _wrap_noise(TEX, 9.0, 9.0, 33)
_shade = 0.97 + 0.03 * (_grain - 0.5) + 0.035 * (_var - 0.5)
_attach(M['cushion'], _image('vinyl_color', np.stack([0.915 * _shade, 0.9 * _shade, 0.86 * _shade], -1)),
        _normal_map('vinyl_normal', _grain, 1.4), 0.7)
try:
    M['cushion'].node_tree.nodes['Principled BSDF'].inputs['Sheen Weight'].default_value = 0.25
except Exception:
    pass

# Gelcoat and paint: faint "orange peel" so reflections are not mirror-perfect plastic.
_peel = _normal_map('peel_normal', _wrap_noise(TEX, 5.0, 5.0, 51), 0.5)
for _k in ('hull', 'deck', 'black'):
    _attach(M[_k], None, _peel, 0.25)

# Oak table: long grain plus fine routed grooves.
_g = _wrap_noise(TEX, 90.0, 2.0, 41)
_groove = ((np.arange(TEX)[:, None] * np.ones((1, TEX), np.int32)) % (TEX // 6)) < 3
_shade = 0.88 + 0.22 * _g
_rgb = np.stack([0.87 * _shade, 0.72 * _shade, 0.50 * _shade], -1)
_rgb[_groove] = (0.5, 0.39, 0.25)
_attach(M['oak'], _image('oak_color', _rgb), _normal_map('oak_normal', _soft(np.where(_groove, 0.0, 1.0).astype(np.float32) + 0.1 * _g, 1), 3.0), 1.0)
M['thread'] = material('Thread', hexc('#8b9096'), 0.9)
M['nonskid'] = material('NonSkid', hexc('#ecebe5'), 0.62, double=True)
_u = np.linspace(0, 1, TEX, endpoint=False)[None, :]
_v = np.linspace(0, 1, TEX, endpoint=False)[:, None]
_dots = (0.5 + 0.5 * np.cos(2 * np.pi * 14 * _u)) * (0.5 + 0.5 * np.cos(2 * np.pi * 14 * _v))
_attach(M['nonskid'], None, _normal_map('nonskid_normal', _dots ** 2, 2.2), 0.8)


# ---------------- mesh helpers ----------------
def finish(ob, sharp=35, bevel=0.0, bevel_seg=2, subsurf=0, solidify=0.0):
    me = ob.data
    for p in me.polygons:
        p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=radians(sharp))
    except Exception:
        pass
    if solidify:
        md = ob.modifiers.new('solid', 'SOLIDIFY')
        md.thickness = solidify
        md.offset = 0
    if bevel:
        md = ob.modifiers.new('bevel', 'BEVEL')
        md.width = bevel
        md.segments = bevel_seg
        md.limit_method = 'ANGLE'
        md.angle_limit = radians(40)
        md.harden_normals = False
    if subsurf:
        md = ob.modifiers.new('sub', 'SUBSURF')
        md.levels = subsurf
        md.render_levels = subsurf
    return ob


def add_mesh(name, verts, faces, mat, merge=True, **kw):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bv = [bm.verts.new(v) for v in verts]
    for f in faces:
        ids = []
        for i in f:
            if not ids or ids[-1] != i:
                ids.append(i)
        if len(ids) > 2 and ids[0] == ids[-1]:
            ids.pop()
        if len(set(ids)) < 3:
            continue
        try:
            bm.faces.new([bv[i] for i in ids])
        except ValueError:
            pass
    if merge:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    if isinstance(mat, (list, tuple)):
        for m in mat:
            me.materials.append(m)
    else:
        me.materials.append(mat)
    return finish(ob, **kw)


def loft(name, rings, mat, closed=False, **kw):
    n = len(rings[0])
    verts = [p for r in rings for p in r]
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n if closed else n - 1):
            a = i * n + j
            b = i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    return add_mesh(name, verts, faces, mat, **kw)


def box(name, sx, sy, sz, loc, mat, bevel=0.03, seg=3, rot=(0, 0, 0), taper=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        k = 1.0
        if taper and v.co.z > 0:
            k = taper
        v.co = Vector((v.co.x * sx * k, v.co.y * sy * k, v.co.z * sz))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    me.materials.append(mat)
    ob.location = loc
    ob.rotation_euler = Euler(rot)
    b = min(bevel, min(sx, sy, sz) * 0.45)
    return finish(ob, bevel=b, bevel_seg=seg)


def tube(name, pts, r, mat, res=6, cyclic=False):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.resolution_u = res
    cu.bevel_depth = r
    cu.bevel_resolution = 2
    cu.use_fill_caps = True
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    sp.use_cyclic_u = cyclic
    ob = bpy.data.objects.new(name, cu)
    col.objects.link(ob)
    cu.materials.append(mat)
    return ob


def prism(name, outline_top, outline_bot, mat, **kw):
    n = len(outline_top)
    verts = list(outline_top) + list(outline_bot)
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    return add_mesh(name, verts, faces, mat, **kw)


def uv_planar(ob, scale=0.34):
    me = ob.data
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        w = ob.matrix_world @ co if ob.location.length else co
        uv.data[loop.index].uv = ((co.x + ob.location.x) / scale, (co.y + ob.location.y) / scale)
    return ob


# ---------------- hull (one closed shell: bottom, topsides, deck, cockpit) ----------------
BV = [0, 0.14, 0.28, 0.42, 0.57, 0.71, 0.85, 1.0]
NT = 12
NSOLE = 5


def half_ring(t):
    pts = [bottom_pt(t, v, 1) for v in BV]
    pts += [topside_pt(t, i / NT, 1) for i in range(1, NT + 1)]
    B = beam(t)
    inner = max(0.0, B - GUN)
    cw = cockpit_w(t)
    top_in = lerp(sheer(t), deck_h(t, inner), 1 - cw)
    pts.append(Vector((x_of(t), lerp(B, inner, 0.5), lerp(sheer(t), top_in, 0.5) + 0.004)))
    pts.append(Vector((x_of(t), inner, top_in)))
    pts.append(Vector((x_of(t), inner, lerp(deck_h(t, inner), FLOOR, cw))))
    for i in range(1, NSOLE + 1):
        yy = inner * (1 - i / NSOLE)
        pts.append(Vector((x_of(t), yy, lerp(deck_h(t, yy), FLOOR, cw))))
    return pts


NHULL = len(BV) - 1 + NT  # segments belonging to the outer skin per side
rings = []
NST = 150
for i in range(NST + 1):
    t = (i / NST) ** 0.85 * 0.9995
    s = half_ring(t)
    port = [Vector((p.x, -p.y, p.z)) for p in reversed(s[1:-1])]
    rings.append(s + port)

n = len(rings[0])
m_half = len(half_ring(0.5)) - 1
verts = [p for r in rings for p in r]
faces = []
fmat = []
for i in range(NST):
    for j in range(n):
        a = i * n + j
        b = i * n + (j + 1) % n
        faces.append((a, b, b + n, a + n))
        seg = j if j < m_half else (n - 1 - j)
        outer = seg < NHULL
        if outer:
            zc = (verts[a].z + verts[b].z + verts[a + n].z + verts[b + n].z) / 4
            fmat.append(0)
        else:
            fmat.append(2)
faces.append(tuple(range(n - 1, -1, -1)))  # transom
fmat.append(2)

me = bpy.data.meshes.new('Hull')
me.from_pydata([tuple(v) for v in verts], [], faces)
for mat in (M['hull'], M['antifoul'], M['deck']):
    me.materials.append(mat)
for p, mi in zip(me.polygons, fmat):
    p.material_index = mi
me.update()
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(me)
bm.free()
hull = bpy.data.objects.new('Hull', me)
col.objects.link(hull)
finish(hull, sharp=28, bevel=0.012, bevel_seg=2)


# ---------------- hull graphics ----------------
def decal(name, tA, tB, v_lo, v_hi, mat, off=0.005, nu=48, nv=4):
    for side in (1, -1):
        rr = []
        for i in range(nu + 1):
            u = i / nu
            t = lerp(tA, tB, u)
            row = []
            for j in range(nv + 1):
                v = lerp(v_lo(u), v_hi(u), j / nv)
                p = topside_pt(t, v, side)
                pt = topside_pt(t + 0.002, v, side) - p
                pv = topside_pt(t, min(1, v + 0.01), side) - p
                nrm = pt.cross(pv)
                nrm.normalize()
                if nrm.y * side < 0:
                    nrm = -nrm
                row.append(p + nrm * off)
            rr.append(row)
        loft(f'{name}_{side}', rr, mat)



decal('Window', 0.74, 0.895, lambda u: 0.7 - 0.27 * sin(pi * u) ** 0.6, lambda u: 0.7, M['window'], off=0.006, nu=40, nv=6)


def hull_y(x, z):
    t = t_of(x)
    c, ych, k, sh, B = chine(t)
    v = clamp01((z - ych) / (sh - ych))
    return lerp(c + 0.07 * B / 1.5, B, flare_at(t, v))


def lettering(text, t, v, size, shear=0.0):
    for side in (1, -1):
        centre = topside_pt(t, v, side)
        cu = bpy.data.curves.new(text, 'FONT')
        cu.body = text
        cu.size = size
        cu.shear = shear
        cu.align_x = 'CENTER'
        cu.align_y = 'CENTER'
        cu.resolution_u = 3
        ob = bpy.data.objects.new(f'Text_{text}_{side}', cu)
        col.objects.link(ob)
        cu.materials.append(M['graphite'])
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.convert(target='MESH')
        ob = bpy.context.view_layer.objects.active
        # Text is drawn in XY reading +X. Seen from outside, the hull side with y<0 reads
        # toward +X and the side with y>0 toward -X.
        for vert in ob.data.vertices:
            tx, ty = vert.co.x, vert.co.y
            x = centre.x + (tx if side < 0 else -tx)
            z = centre.z + ty
            vert.co = (x, side * (hull_y(x, z) + 0.006), z)


lettering('Levante 34', 0.43, 0.72, 0.16, shear=0.35)
lettering('TULLIO MARINE', 0.21, 0.6, 0.165)
decal('LowStripeA', 0.0, 0.9, lambda u: 0.1, lambda u: 0.125, M['graphite'], off=0.004, nu=80, nv=1)
decal('LowStripeB', 0.0, 0.9, lambda u: 0.15, lambda u: 0.163, M['graphite'], off=0.004, nu=80, nv=1)
decal('Pinstripe', 0.0, 0.99, lambda u: 0.9, lambda u: 0.93, M['graphite'], off=0.004, nu=80, nv=1)

# Rubrail along the sheer.
pts = []
for i in range(31):
    t = (i / 30) ** 0.8 * 0.999
    pts.append(Vector((x_of(t), beam(t) + 0.012, sheer(t) - 0.02)))
port = [Vector((p.x, -p.y, p.z)) for p in pts]
tube('Rubrail', port + [Vector((HALF + 0.012, 0, sheer(1) - 0.02))] + list(reversed(pts)), 0.028, M['steel'], res=8)

# ---------------- teak sole ----------------
rr = []
for i in range(81):
    t = lerp(CA + 0.015, CF - 0.02, i / 80)
    inner = max(0.0, beam(t) - GUN - 0.01)
    rr.append([Vector((x_of(t), lerp(-inner, inner, j / 24), FLOOR + 0.006)) for j in range(25)])
uv_planar(loft('Sole', rr, M['teak'], merge=False))

# ---------------- console + helm ----------------
SH = -0.2      # seat-module group offset from where it was first modelled
CY = -0.3      # helm centreline (to starboard; the door is to port)
HY = 0.0       # seat module centreline
XB = x_of(CF)  # cockpit forward bulkhead = aft face of the cabin trunk
ZT = deck_h(t_of(XB + 0.2), 0.3) + 0.24  # cabin top height there
M['dashgrey'] = material('DashGrey', hexc('#4a4f55'), 0.4, coat=0.4)
# Console = a white wedge: vertical face toward the cockpit, then a top that slopes up
# forward to cabin-top height. Door on its port side, helm on the starboard side.
ZA = FLOOR + 0.86          # height of the wedge's aft edge
XW = XB - 0.15             # wedge aft face, clear of the hull's own bulkhead
SLX = 0.65                 # horizontal run of the sloped top
slope = atan2(ZT - ZA, SLX)
wedge = [(XW, FLOOR), (XB + 0.6, FLOOR), (XB + 0.6, ZT), (XW + SLX, ZT), (XW, ZA)]
prism('ConsoleWedge', [Vector((x, 0.97, z)) for x, z in wedge], [Vector((x, -0.97, z)) for x, z in wedge], M['deck'], bevel=0.035, bevel_seg=3)


def on_slope(sl, yy, lift=0.0):
    """Point on the sloped top: sl = 0 at the aft edge, 1 where it meets the cabin top."""
    return Vector((XW + SLX * sl - sin(slope) * lift, yy, ZA + (ZT - ZA) * sl + cos(slope) * lift))


# Door: big smoked-black sliding door on the port side. It rises up the vertical face and
# carries on up the slope, with a rounded head and a thick black frame.
DCY, DHW = 0.56, 0.3
prof = [(XW - 0.008, FLOOR + 0.03, 1.0), (XW - 0.008, FLOOR + 0.45, 1.0), (XW - 0.008, ZA - 0.03, 1.0)]
for i in range(1, 13):
    sl = i / 12 * 0.93
    q = on_slope(sl, 0, 0.008)
    kk = 1.0 if sl < 0.5 else (max(0.0, 1 - ((sl - 0.5) / 0.43) ** 2)) ** 0.5
    prof.append((q.x, q.z, max(kk, 0.04)))
rr = [[Vector((x, DCY + DHW * k * lerp(-1, 1, j / 6), z)) for j in range(7)] for x, z, k in prof]
loft('Door', rr, M['screen'])
edge = [Vector((x, DCY - DHW * k, z)) for x, z, k in prof] + [Vector((x, DCY + DHW * k, z)) for x, z, k in reversed(prof)]
tube('DoorFrame', edge, 0.022, M['black'], res=3)
tube('DoorHandle', [Vector((XW - 0.01, 0.92, FLOOR + 0.42)), Vector((XW - 0.05, 0.92, FLOOR + 0.5)), Vector((XW - 0.05, 0.92, FLOOR + 0.72)), Vector((XW - 0.01, 0.92, FLOOR + 0.8))], 0.011, M['black'], res=4)

# Helm: anthracite panel let into the slope, with switches and two black cup-holder plates.
pc = on_slope(0.52, CY - 0.08, 0.012)
box('DashPanel', 0.46, 1.0, 0.02, pc, M['dashgrey'], bevel=0.01, rot=(0, -slope, 0))
box('SwitchPanel', 0.2, 0.36, 0.012, on_slope(0.5, CY + 0.0, 0.03), M['screen'], bevel=0.004, rot=(0, -slope, 0))
for dy in (0.3, -0.34):
    box('CupPlate', 0.2, 0.22, 0.012, on_slope(0.45, CY + dy, 0.03), M['screen'], bevel=0.004, rot=(0, -slope, 0))
    bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.02, vertices=24, location=on_slope(0.45, CY + dy, 0.034), rotation=(0, -slope, 0))
    bpy.context.object.data.materials.append(M['dark'])
    finish(bpy.context.object)
# Instrument binnacle standing where the slope meets the cabin top.
PX = XB + SLX + 0.2
box('Pod', 0.34, 0.66, 0.3, (PX, CY + 0.08, ZT + 0.13), M['dashgrey'], bevel=0.07, seg=4)
box('PodHood', 0.26, 0.72, 0.05, (PX - 0.12, CY + 0.08, ZT + 0.3), M['dashgrey'], bevel=0.02, rot=(0, radians(8), 0))
box('PodSkirt', 0.3, 0.74, 0.08, (PX - 0.1, CY + 0.08, ZT + 0.02), M['dashgrey'], bevel=0.03, rot=(0, radians(-14), 0))
box('Plotter', 0.012, 0.3, 0.2, (PX - 0.175, CY + 0.22, ZT + 0.14), M['screen'], bevel=0.004)
for gy, gz in ((-0.04, 0.2), (-0.15, 0.2), (-0.095, 0.09)):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.047, depth=0.012, vertices=24, location=(PX - 0.175, CY + gy, ZT + gz), rotation=(0, radians(90), 0))
    bpy.context.object.data.materials.append(M['screen'])
    finish(bpy.context.object)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.047, minor_radius=0.006, major_segments=24, minor_segments=6, location=(PX - 0.182, CY + gy, ZT + gz), rotation=(0, radians(90), 0))
    bpy.context.object.data.materials.append(M['steel'])
    finish(bpy.context.object)
bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.035, vertices=24, location=(PX + 0.02, CY + 0.25, ZT + 0.3))
bpy.context.object.data.materials.append(M['deck'])
finish(bpy.context.object, bevel=0.01)
# Steering wheel at the aft edge of the wedge, tilted back: rim, hub, three spokes.
wc = Vector((XW - 0.1, CY - 0.12, ZA + 0.02))
wrot = Euler((0, radians(58), 0))
bpy.ops.mesh.primitive_torus_add(major_radius=0.19, minor_radius=0.017, major_segments=40, minor_segments=10, location=wc, rotation=wrot)
w = bpy.context.object
w.data.materials.append(M['black'])
finish(w)
bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.05, vertices=20, location=wc, rotation=wrot)
bpy.context.object.data.materials.append(M['steel'])
finish(bpy.context.object, bevel=0.006)
for k in range(3):
    a = radians(90 + k * 120)
    sp = box('Spoke', 0.03, 0.17, 0.008, wc, M['steel'], bevel=0.003)
    sp.rotation_euler = wrot
    sp.rotation_euler.rotate_axis('Z', a)
    sp.location = wc + sp.rotation_euler.to_matrix() @ Vector((0, 0.095, 0))
tube('WheelShaft', [wc, on_slope(0.12, wc.y, -0.03)], 0.03, M['dark'])
# Throttle to starboard of the wheel.
tb = on_slope(0.2, CY - 0.5, 0.03)
box('ThrottleBase', 0.14, 0.1, 0.08, tb, M['dark'], bevel=0.02, rot=(0, -slope, 0))
for dy in (0.025, -0.025):
    tube('Lever', [tb + Vector((0, dy, 0.03)), tb + Vector((-0.07, dy, 0.19))], 0.012, M['steel'])
# Black grab handles: one at the port-aft corner of the dash, one on the aft face.
h0 = on_slope(0.1, CY + 0.52, 0.0)
tube('DashHandle', [h0, h0 + Vector((0.0, 0.0, 0.06)), h0 + Vector((0.0, -0.2, 0.06)), h0 + Vector((0.0, -0.2, 0.0))], 0.012, M['black'], res=3)
tube('FaceHandle', [Vector((XW - 0.01, CY + 0.42, FLOOR + 0.4)), Vector((XW - 0.05, CY + 0.42, FLOOR + 0.44)), Vector((XW - 0.05, CY + 0.42, FLOOR + 0.62)), Vector((XW - 0.01, CY + 0.42, FLOOR + 0.66))], 0.011, M['black'], res=4)

# ---------------- windshield + hardtop ----------------
# A tall raked glass screen rises from the cabin top to a hardtop carried on dark pillars.
ROOF = FLOOR + 1.98
CR_H = 0.24  # cabin top height above the deck
M['roofgrey'] = material('RoofGrey', hexc('#9aa0a5'), 0.4, coat=0.5)


def coach_w(x):
    return max(0.15, beam(t_of(x)) - GUN - 0.42)


# Canopy = ONE surface with a single clean profile: flat over the helm, then one convex arc
# down to the deck. Aft part of that surface is the opaque roof; forward of it the middle is
# tinted glass and the two edges are the grey arms. Constant width, no camber.
M['canopy'] = material('CanopyGrey', hexc('#868d94'), 0.28, metal=0.35, coat=1.0, double=True)
M['canopyDark'] = material('CanopyDark', hexc('#24282d'), 0.12, coat=1.0, double=True)
_attach(M['canopy'], None, _peel, 0.2)
ROOF_F, ROOF_R = 0.45, -1.55      # opaque roof: from above the dash to just behind the legs
ARM_FOOT = 2.9                    # where the arms meet the deck
GLASS_X0 = 2.55                   # lower edge of the glass, just aft of the sunpad
CW = 0.9                          # canopy half width
AW = 0.1                          # arm width
CDZ = deck_h(t_of(ARM_FOOT), 0.8)


def canopy_z(x):
    if x <= ROOF_F:
        return ROOF
    sx = (x - ROOF_F) / (ARM_FOOT - ROOF_F)
    return CDZ + (ROOF - CDZ) * (1 - sx ** 1.8)


def cpt(x, yy, drop=0.0):
    return Vector((x, yy, canopy_z(x) - drop))


def xs(x0, x1, n):
    return [lerp(x0, x1, i / n) for i in range(n + 1)]


for side in (1, -1):
    rr = [[cpt(x, side * lerp(CW - AW, CW, j / 2)) for j in range(3)] for x in xs(ARM_FOOT, ROOF_F, 40)]
    loft(f'Arm{side}', rr, M['canopy'], solidify=0.07, bevel=0.015)
    # Side glass: a LOW wing panel on the cabin-top edge, about half the height of the gap
    # under the arm. Forward it meets the arm; aft its top edge curves down, rounded.
    gx = xs(GLASS_X0, 1.0, 24)
    low = [Vector((x, side * lerp(0.74, 0.86, i / 24), deck_h(t_of(x), 0.75) + CR_H + 0.02)) for i, x in enumerate(gx)]
    tops = []
    for i, x in enumerate(gx):
        arm_pt = cpt(x, side * (CW - AW * 0.5), drop=0.035)
        gap = max(0.0, arm_pt.z - low[i].z)
        sx = (x - 1.0) / (GLASS_X0 - 1.0)                      # 0 at the aft end, 1 at the front
        round_aft = (1 - (1 - min(sx / 0.3, 1.0)) ** 2) ** 0.5  # quarter-circle run-out aft
        hgt = min(gap, 0.38) * round_aft
        k = hgt / gap if gap > 1e-6 else 0.0
        tops.append(low[i].lerp(arm_pt, k))
    rr = [[tops[i], low[i]] for i in range(len(gx))]
    loft(f'SideGlass{side}', rr, M['glass'])
    tube(f'SideTop{side}', tops, 0.011, M['black'], res=3)
    tube(f'SideSill{side}', low, 0.012, M['black'], res=3)
gxs = xs(GLASS_X0, ROOF_F, 30)
rr = [[cpt(x, lerp(-(CW - AW), CW - AW, j / 8), drop=0.012) for j in range(9)] for x in gxs]
loft('CanopyGlass', rr, M['glass'], solidify=0.01)
tube('GlassBase', [cpt(GLASS_X0, lerp(-(CW - AW), CW - AW, j / 8), drop=0.012) for j in range(9)], 0.014, M['black'], res=3)
ROOF_RC = 0.35   # radius of the rounded aft corners of the roof (plan view)
ROOF_BOW = 0.06  # how far the middle of the aft edge bows out aft


def roof_rows(inset, drop):
    # Plan outline: straight sides at half width CW, then quarter-circle corners of radius
    # ROOF_RC (centred at ROOF_R + ROOF_RC, +-(CW - ROOF_RC)) into a gently bowed aft edge
    # about 60% of CW wide. `inset` shrinks the outline uniformly (for the liner).
    xc, rc = ROOF_R + ROOF_RC, ROOF_RC - inset
    rows = [(x, CW - inset) for x in xs(ROOF_F, xc, 12)[:-1]]
    for i in range(13):
        ph = (pi / 2) * i / 12
        rows.append((xc - rc * sin(ph), CW - ROOF_RC + rc * cos(ph)))
    out = []
    for i, (x, hw) in enumerate(rows):
        fade = max(0.0, (xc - x) / rc) if rc > 0 else 0.0  # 0 on straight part, 1 at aft edge
        row = []
        for j in range(13):
            yy = lerp(-hw, hw, j / 12)
            bx = x - ROOF_BOW * fade * (1 - (yy / hw) ** 2)
            row.append(cpt(bx, yy, drop=drop))
        out.append(row)
    return out


loft('CanopyRoof', roof_rows(0.0, 0.0), M['canopy'], solidify=0.09, bevel=0.035)
loft('CanopyLiner', roof_rows(0.04, 0.055), M['canopyDark'])
for _rx in xs(ROOF_F - 0.25, ROOF_R + 0.5, 4):
    box('RoofRib', 0.035, 1.5, 0.02, (_rx, 0, ROOF - 0.072), M['canopyDark'], bevel=0.006)
for _ry in (0.45, -0.45):
    box('RoofSpar', ROOF_F - ROOF_R - 0.7, 0.035, 0.02, ((ROOF_F + ROOF_R) / 2, _ry, ROOF - 0.072), M['canopyDark'], bevel=0.006)


def roof_z(x, yy, lift):
    return ROOF + lift


# Two leg frames on the outer corners of the seat module: paired bars with a plate.
for side in (1, -1):
    ly = HY + side * 0.6
    ty = side * 0.68
    tube(f'LegA{side}', [Vector((-0.9, ly, FLOOR + 0.92)), Vector((-0.92, ly, FLOOR + 1.5)), Vector((-0.72, ty, ROOF - 0.03))], 0.038, M['black'], res=10)
    tube(f'LegB{side}', [Vector((-1.1, ly, FLOOR + 0.92)), Vector((-1.12, ly, FLOOR + 1.45)), Vector((-0.8, ty, ROOF - 0.03))], 0.038, M['black'], res=10)
    box('LegPlate', 0.24, 0.05, 0.2, (-1.0, ly, FLOOR + 1.42), M['black'], bevel=0.015)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.11, segments=20, ring_count=10, location=(-1.1, 0.3, ROOF + 0.11), scale=(1, 1, 0.6))
bpy.context.object.data.materials.append(M['deck'])
finish(bpy.context.object)
tube('Mast', [Vector((-1.4, 0, ROOF + 0.06)), Vector((-1.4, 0, ROOF + 0.4))], 0.012, M['black'])

# ---------------- seating ----------------
_grp = set(col.objects)
# Helm seats on their module, dark shells behind the backrests.
box('HelmBase', 0.66, 1.3, 0.42, (-0.3, HY, FLOOR + 0.21), M['deck'], bevel=0.05)
for yy in (HY + 0.33, HY - 0.33):
    box('SeatCushion', 0.52, 0.5, 0.16, (-0.24, yy, FLOOR + 0.54), M['cushion'], bevel=0.06, seg=4)
    box('SeatBack', 0.14, 0.5, 0.66, (-0.5, yy, FLOOR + 0.86), M['cushion'], bevel=0.06, seg=4, rot=(0, radians(10), 0))
    box('HeadRest', 0.11, 0.34, 0.3, (-0.56, yy, FLOOR + 1.3), M['cushion'], bevel=0.045, seg=4, rot=(0, radians(10), 0), taper=0.72)
    box('SeatShell', 0.04, 0.52, 0.72, (-0.6, yy, FLOOR + 0.87), M['dark'], bevel=0.015, rot=(0, radians(10), 0))
    for s2 in (1, -1):
        box('Bolster', 0.44, 0.08, 0.22, (-0.26, yy + s2 * 0.23, FLOOR + 0.66), M['cushion'], bevel=0.035, seg=3)
bpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=0.05, vertices=24, location=(-0.2, HY, FLOOR + 0.47))
bpy.context.object.data.materials.append(M['dark'])
finish(bpy.context.object)
for hx in (-0.45, -0.1):
    tube('ModuleHandle', [Vector((hx - 0.12, HY + 0.66, FLOOR + 0.3)), Vector((hx - 0.1, HY + 0.7, FLOOR + 0.32)), Vector((hx + 0.1, HY + 0.7, FLOOR + 0.32)), Vector((hx + 0.12, HY + 0.66, FLOOR + 0.3))], 0.012, M['black'], res=4)
box('NetPocket', 0.3, 0.012, 0.16, (-0.3, HY + 0.657, FLOOR + 0.2), M['dark'], bevel=0.004)
# Wet bar behind the seats: black top, fridge door facing the walkway, speakers facing aft.
box('Galley', 0.5, 1.3, 0.92, (-0.86, HY, FLOOR + 0.46), M['deck'], bevel=0.045)
for dy in (0.34, -0.34):
    box('GalleyLid', 0.44, 0.56, 0.03, (-0.86, HY + dy, FLOOR + 0.935), M['screen'], bevel=0.01)
box('Fridge', 0.4, 0.014, 0.6, (-0.86, HY + 0.657, FLOOR + 0.42), M['screen'], bevel=0.005)
tube('FridgeHandle', [Vector((-0.72, HY + 0.675, FLOOR + 0.3)), Vector((-0.72, HY + 0.675, FLOOR + 0.55))], 0.008, M['steel'])
for dy in (0.4, -0.4):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.085, depth=0.014, vertices=24, location=(-1.115, HY + dy, FLOOR + 0.3), rotation=(0, radians(90), 0))
    bpy.context.object.data.materials.append(M['dark'])
    finish(bpy.context.object)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.007, major_segments=24, minor_segments=6, location=(-1.122, HY + dy, FLOOR + 0.3), rotation=(0, radians(90), 0))
    bpy.context.object.data.materials.append(M['steel'])
    finish(bpy.context.object)

for _ob in set(col.objects) - _grp:
    _ob.location.x += SH

# Dinette: a bench facing forward and one facing aft with a large table between,
# offset to starboard like the helm; the teak aft deck stays open behind.
DY = 0.0
for bx, back_dx, tilt in ((-3.2, -0.34, -6), (-1.95, 0.34, 6)):
    box('BenchBase', 0.68, 1.5, 0.36, (bx, DY, FLOOR + 0.18), M['deck'], bevel=0.04)
    box('BenchSeat', 0.64, 1.44, 0.1, (bx, DY, FLOOR + 0.41), M['cushion'], bevel=0.04, seg=4)
    box('BackPanel', 0.05, 1.42, 0.3, (bx + back_dx, DY, FLOOR + 0.6), M['deck'], bevel=0.02, rot=(0, radians(tilt), 0))
    for k in range(3):
        yy = DY + (k - 1) * 0.47
        box('BackTab', 0.075, 0.38, 0.42, (bx + back_dx * 0.9, yy, FLOOR + 0.68), M['cushion'], bevel=0.035, seg=4, rot=(0, radians(tilt), 0))
    for e in (-1, 1):
        fa = box('FlipArm', 0.42, 0.008, 0.035, (bx + back_dx * 0.45, DY + e * 0.757, FLOOR + 0.4), M['steel'], bevel=0.003)
        fa.rotation_euler = Euler((0, radians(-22 if back_dx > 0 else 22), 0))
        box('ArmPlate', 0.09, 0.01, 0.09, (bx - back_dx * 0.15, DY + e * 0.757, FLOOR + 0.3), M['steel'], bevel=0.004)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=0.012, vertices=24, location=(bx, DY + 0.755, FLOOR + 0.16), rotation=(radians(90), 0, 0))
    bpy.context.object.data.materials.append(M['steel'])
    finish(bpy.context.object)
tube('BenchRail', [Vector((-3.66, DY - 0.6, FLOOR + 0.62)), Vector((-3.66, DY + 0.6, FLOOR + 0.62))], 0.016, M['black'])
for dy in (-0.55, 0.55):
    tube('BenchRailPost', [Vector((-3.6, DY + dy, FLOOR + 0.62)), Vector((-3.66, DY + dy, FLOOR + 0.62))], 0.012, M['black'])
box('Table', 0.62, 1.6, 0.035, (-2.575, DY, FLOOR + 0.74), M['oak'], bevel=0.015)
for dy in (-0.5, 0.5):
    box('TableSeam', 0.63, 0.006, 0.037, (-2.575, DY + dy, FLOOR + 0.74), M['dark'], bevel=0.001)
tube('TableLeg', [Vector((-2.575, DY, FLOOR)), Vector((-2.575, DY, FLOOR + 0.72))], 0.075, M['deck'])

# Cabin top (raised foredeck block) with the bow sunpad on it.
CX0, CX1 = x_of(CF) + 0.5, 4.45
N = 24
ring = [(lerp(CX0, CX1, i / N), coach_w(lerp(CX0, CX1, i / N))) for i in range(N + 1)]
ring += [(x, -w) for x, w in reversed(ring)]
top = [Vector((x, yy, deck_h(t_of(x), abs(yy)) + CR_H)) for x, yy in ring]
bot = [Vector((x, yy, deck_h(t_of(x), abs(yy)) - 0.02)) for x, yy in ring]
prism('CabinTop', top, bot, M['nonskid'], bevel=0.06, bevel_seg=4)
PX0, PX1 = 2.7, 4.35
for side in (1, -1):
    ring = [(lerp(PX0, PX1, i / 14), side * 0.012) for i in range(15)]
    ring += [(lerp(PX0, PX1, i / 14), side * (coach_w(lerp(PX0, PX1, i / 14)) - 0.08)) for i in range(14, -1, -1)]
    top = [Vector((x, yy, deck_h(t_of(x), abs(yy)) + CR_H + 0.08)) for x, yy in ring]
    bot = [Vector((x, yy, deck_h(t_of(x), abs(yy)) + CR_H - 0.01)) for x, yy in ring]
    prism(f'Sunpad{side}', top, bot, M['cushion'], bevel=0.035, bevel_seg=4)
    box('PadHead', 0.28, 0.5, 0.1, (2.85, side * 0.38, deck_h(t_of(2.85), 0.38) + CR_H + 0.13), M['cushion'], bevel=0.045, seg=4, rot=(0, radians(-10), 0))
    # Speaker and cup holders on the cabin top, beside the screen.
    bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.012, vertices=24, location=(1.6, side * 0.8, deck_h(t_of(1.6), 0.8) + CR_H + 0.006))
    bpy.context.object.data.materials.append(M['dark'])
    finish(bpy.context.object)

# Dark window band along the cabin trunk sides.
for side in (1, -1):
    rr = []
    for i in range(21):
        u = i / 20
        x = lerp(0.95, 2.5, u)
        yy = side * (coach_w(x) + 0.006)
        zb = deck_h(t_of(x), abs(yy))
        rr.append([Vector((x, yy, zb + 0.07)), Vector((x, yy, zb + 0.2 - 0.11 * u * u))])
    loft(f'TrunkWindow{side}', rr, M['window'])

# Teak side decks running from the cockpit to the bow.
for side in (1, -1):
    rr = []
    for i in range(61):
        t = lerp(CF + 0.002, 0.985, i / 60)
        x = x_of(t)
        y_out = max(0.0, beam(t) - GUN - 0.005)
        y_in = min(y_out, coach_w(x) + 0.03) if x <= CX1 + 0.04 else 0.0
        rr.append([Vector((x, side * lerp(y_in, y_out, j / 4), deck_h(t, lerp(y_in, y_out, j / 4)) + 0.006)) for j in range(5)])
    uv_planar(loft(f'SideDeck{side}', rr, M['teak'], merge=False))

# ---------------- rails, cleats ----------------
ts = [lerp(0.66, 0.985, (i / 14) ** 0.9) for i in range(15)]


def rail_at(t, side):
    return Vector((x_of(t), side * max(0.0, beam(t) - 0.06), sheer(t) + 0.32))


pts = [rail_at(t, -1) for t in ts] + [Vector((x_of(0.998) + 0.08, 0, sheer(1) + 0.3))] + [rail_at(t, 1) for t in reversed(ts)]
tube('BowRail', pts, 0.018, M['black'], res=8)
for t in (0.67, 0.75, 0.83, 0.91):
    for side in (1, -1):
        p = rail_at(t, side)
        tube('Stanchion', [Vector((p.x, p.y, p.z - 0.32)), p], 0.013, M['black'])
tube('BowStanchion', [Vector((x_of(0.99), 0, sheer(1))), Vector((x_of(0.99), 0, sheer(1) + 0.3))], 0.013, M['black'])
for t in (0.08, 0.45, 0.93):
    for side in (1, -1):
        yy = side * (beam(t) - GUN * 0.5)
        z = sheer(t) + 0.012
        tube('Cleat', [Vector((x_of(t) - 0.09, yy, z + 0.035)), Vector((x_of(t) + 0.09, yy, z + 0.035))], 0.011, M['steel'])
        box('CleatFoot', 0.06, 0.03, 0.035, (x_of(t), yy, z + 0.015), M['steel'], bevel=0.008)

# ---------------- stern: platforms + outboards ----------------
for side in (1, -1):
    po = [(-HALF + 0.03, 0.68), (-HALF + 0.03, 1.4), (-HALF - 0.4, 1.39)]
    for k in range(9):    # outer aft corner
        a = (pi / 2) * k / 8
        po.append((-HALF - 0.68 - 0.34 * sin(a), 1.02 + 0.36 * cos(a)))
    for k in range(9):    # inner aft corner
        a = (pi / 2) * k / 8
        po.append((-HALF - 0.82 - 0.2 * cos(a), 0.88 - 0.2 * sin(a)))
    PLZ = FLOOR - 0.08
    top = [Vector((x, side * yy, PLZ)) for x, yy in po]
    bot = [Vector((x, side * (yy - 0.04 if yy > 1.0 else yy), 0.16 + 0.22 * min(1.0, (-HALF - x) / 1.0))) for x, yy in po]
    prism(f'Platform{side}', top, bot, M['hull'], bevel=0.045, bevel_seg=3)
    cxp, cyp = -HALF - 0.48, 1.04
    tk = [(cxp + (x - cxp) * 0.9, cyp + (yy - cyp) * 0.86) for x, yy in po]
    uv_planar(prism(f'PlatformTeak{side}', [Vector((x, side * yy, PLZ + 0.012)) for x, yy in tk], [Vector((x, side * yy, PLZ - 0.01)) for x, yy in tk], M['teak']))
    # Teak steps from the cockpit sole up to the side deck, beside the console.
    for k in range(2):
        uv_planar(box('Step', 0.3, 0.34, 0.04, (XW - 0.5 + k * 0.32, side * 1.15, FLOOR + 0.24 + k * 0.26), M['teak'], bevel=0.01))
        box('StepRiser', 0.3, 0.34, 0.24 + k * 0.26, (XW - 0.5 + k * 0.32, side * 1.15, FLOOR + (0.24 + k * 0.26) / 2 - 0.02), M['deck'], bevel=0.02)
    # Black handrail along the cockpit side.
    hp = []
    for i in range(13):
        tt = lerp(0.17, 0.52, i / 12)
        hp.append(Vector((x_of(tt), side * (beam(tt) - GUN * 0.5), sheer(tt) + 0.09)))
    tube(f'SideRail{side}', hp, 0.014, M['black'], res=6)
    for i in (0, 3, 6, 9, 12):
        tube('RailPost', [hp[i] - Vector((0, 0, 0.09)), hp[i]], 0.011, M['black'])
    # Three small ports low on the quarter.
    for tt in (0.05, 0.075, 0.1):
        zz = 0.5
        bpy.ops.mesh.primitive_cylinder_add(radius=0.034, depth=0.01, vertices=20, location=(x_of(tt), side * (hull_y(x_of(tt), zz) + 0.003), zz), rotation=(radians(90), 0, 0))
        bpy.context.object.data.materials.append(M['window'])
        finish(bpy.context.object)


def se_ring(cx, cy, z, lx, ly, n=24, e=2.8):
    """Superellipse ring (rounded rectangle) in a horizontal plane."""
    out = []
    for i in range(n):
        a = 2 * pi * i / n
        ca, sa = cos(a), sin(a)
        out.append(Vector((cx + lx * math.copysign(abs(ca) ** (2 / e), ca), cy + ly * math.copysign(abs(sa) ** (2 / e), sa), z)))
    return out


def capped_loft(name, rings, mat, **kw):
    n = len(rings[0])
    verts = [p for r in rings for p in r]
    faces = [tuple(range(n - 1, -1, -1))]
    for i in range(len(rings) - 1):
        for j in range(n):
            a2 = i * n + j
            b2 = i * n + (j + 1) % n
            faces.append((a2, b2, b2 + n, a2 + n))
    last = (len(rings) - 1) * n
    faces.append(tuple(range(last, last + n)))
    return add_mesh(name, verts, faces, mat, **kw)


def outboard(yy):
    """Big angular V8-style outboard: faceted gloss-black cowl, flat top, raked aft face,
    chrome vent strips on the aft corners, dark-grey lower cowl. No branding."""
    ox, z0 = -HALF - 0.5, 0.55  # cowl centre x, cowl base height
    #        z     dx     half-length  half-width
    prof = [(0.00, 0.04, 0.34, 0.25), (0.10, 0.00, 0.44, 0.31), (0.42, -0.08, 0.50, 0.325),
            (0.66, -0.12, 0.47, 0.31), (0.74, -0.13, 0.42, 0.27), (0.765, -0.13, 0.36, 0.22)]
    capped_loft('Cowl', [se_ring(ox + dx, yy, z0 + z, lx, ly, n=28, e=5.0) for z, dx, lx, ly in prof], M['black'], sharp=28)
    # Top lid panel and the crease line around the shoulder.
    box('CowlLid', 0.62, 0.36, 0.012, (ox - 0.13, yy, z0 + 0.772), M['black'], bevel=0.004)
    capped_loft('CowlCrease', [se_ring(ox - 0.08, yy, z0 + 0.41, 0.503, 0.328, n=28, e=5.0), se_ring(ox - 0.085, yy, z0 + 0.435, 0.503, 0.328, n=28, e=5.0)], M['dark'], sharp=28)
    # Chrome vent strips on the two aft corners, following the rake.
    for sy in (1, -1):
        box('VentStrip', 0.018, 0.04, 0.27, (ox - 0.578, yy + sy * 0.25, z0 + 0.55), M['steel'], bevel=0.006, rot=(0, 0, radians(sy * 20)))
    # Dark-grey lower cowl, bracket, tilt tube.
    capped_loft('Apron', [se_ring(ox + 0.06, yy, z0 - 0.3, 0.26, 0.15, e=3.5), se_ring(ox + 0.05, yy, z0 - 0.1, 0.32, 0.21, e=3.5), se_ring(ox + 0.04, yy, z0 + 0.01, 0.335, 0.248, e=3.5)], M['dark'], sharp=40)
    box('Bracket', 0.26, 0.36, 0.46, (ox + 0.36, yy, z0 - 0.22), M['dark'], bevel=0.04)
    tube('TiltTube', [Vector((ox + 0.34, yy - 0.25, z0 - 0.05)), Vector((ox + 0.34, yy + 0.25, z0 - 0.05))], 0.03, M['steel'])
    # Rigging hose from the engine well to the cowl.
    tube('Hose', [Vector((-HALF + 0.02, yy * 0.45, z0 + 0.22)), Vector((-HALF - 0.12, yy * 0.7, z0 + 0.3)), Vector((ox + 0.3, yy, z0 + 0.16))], 0.035, M['dark'], res=8)
    # Midsection, anti-ventilation plate, gearcase, skeg, propeller.
    leg = [(-0.28, 0.05, 0.21, 0.105), (-0.7, 0.05, 0.17, 0.085), (-1.1, 0.04, 0.15, 0.06), (-1.36, 0.03, 0.16, 0.05)]
    capped_loft('Leg', [se_ring(ox + dx, yy, z0 + z, lx, ly, e=2.2) for z, dx, lx, ly in leg], M['dark'], sharp=60)
    box('Plate', 0.56, 0.36, 0.022, (ox - 0.02, yy, z0 - 1.12), M['dark'], bevel=0.009)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.105, segments=20, ring_count=12, location=(ox + 0.04, yy, z0 - 1.42), scale=(2.8, 1, 1))
    g = bpy.context.object
    g.data.materials.append(M['dark'])
    finish(g)
    box('Skeg', 0.22, 0.03, 0.24, (ox - 0.02, yy, z0 - 1.6), M['dark'], bevel=0.012)
    bpy.ops.mesh.primitive_cone_add(radius1=0.06, radius2=0.02, depth=0.16, vertices=16, location=(ox - 0.34, yy, z0 - 1.42), rotation=(0, radians(-90), 0))
    h = bpy.context.object
    h.data.materials.append(M['steel'])
    finish(h)
    for k in range(3):
        a3 = radians(k * 120)
        bl = box('Blade', 0.012, 0.11, 0.17, (ox - 0.31, yy + sin(a3) * 0.1, z0 - 1.42 + cos(a3) * 0.1), M['steel'], bevel=0.004)
        bl.rotation_euler = Euler((-a3, 0, radians(28)))


# Dark-grey teak mat on the aft deck behind the bench, chrome grab handles on the quarters.
box('AftMat', 0.8, 1.3, 0.012, (-HALF + 0.5, 0, FLOOR + 0.014), M['teakdark'], bevel=0.004)
for k in range(1, 9):
    box('AftMatSeam', 0.8, 0.008, 0.013, (-HALF + 0.5, -0.65 + k * 1.3 / 9, FLOOR + 0.015), M['screen'], bevel=0.001)
for side in (1, -1):
    qx = x_of(0.035)
    tube('QuarterHandle', [Vector((qx, side * (hull_y(qx, 0.62) + 0.004), 0.6)), Vector((qx - 0.02, side * (hull_y(qx, 0.72) + 0.03), 0.7)), Vector((qx - 0.04, side * (hull_y(qx, 0.82) + 0.004), 0.82))], 0.014, M['steel'], res=4)

for yy in (0.36, -0.36):
    outboard(yy)

# ---------------- fittings ----------------
# Bow roller and anchor.
bz0 = sheer(1) + 0.02
box('BowRoller', 0.5, 0.11, 0.035, (HALF - 0.12, 0, bz0 + 0.02), M['steel'], bevel=0.01)
tube('AnchorShank', [Vector((HALF - 0.3, 0, bz0 + 0.06)), Vector((HALF + 0.12, 0, bz0 + 0.03)), Vector((HALF + 0.2, 0, bz0 - 0.12))], 0.014, M['steel'])
box('AnchorFluke', 0.2, 0.17, 0.02, (HALF + 0.17, 0, bz0 - 0.16), M['steel'], bevel=0.008, rot=(0, radians(55), 0))
# Foredeck hatch.
hx = 4.4
hz = deck_h(t_of(hx), 0)
# Navigation lights at the bow (red to port, green to starboard).
M['navred'] = material('NavRed', hexc('#c0181a'), 0.3)
M['navgreen'] = material('NavGreen', hexc('#12a04a'), 0.3)
for side, mat in ((1, M['navred']), (-1, M['navgreen'])):
    tt = 0.9
    box('NavLight', 0.09, 0.03, 0.04, (x_of(tt), side * (beam(tt) + 0.02), sheer(tt) - 0.09), mat, bevel=0.01)
# Cup holders on the table and galley.
for cx, cy in ():
    bpy.ops.mesh.primitive_torus_add(major_radius=0.042, minor_radius=0.006, major_segments=20, minor_segments=6, location=(cx, cy, FLOOR + 0.762))
    bpy.context.object.data.materials.append(M['steel'])
    finish(bpy.context.object)
# Filler caps and rod holders on the aft gunwales.
for side in (1, -1):
    for tt in (0.1, 0.16):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=0.01, vertices=20, location=(x_of(tt), side * (beam(tt) - GUN * 0.5), sheer(tt) + 0.008))
        bpy.context.object.data.materials.append(M['steel'])
        finish(bpy.context.object)
    for tt in (0.22, 0.3):
        yy2 = side * (beam(tt) - GUN * 0.5)
        tube('RodHolder', [Vector((x_of(tt), yy2, sheer(tt) - 0.02)), Vector((x_of(tt) - 0.05, yy2, sheer(tt) + 0.09))], 0.02, M['steel'])
# Swim ladder folded on the port platform.
ly0 = 1.06
lz = FLOOR - 0.05
tube('Ladder', [Vector((-HALF - 0.05, ly0 - 0.15, lz)), Vector((-HALF - 0.5, ly0 - 0.15, lz)), Vector((-HALF - 0.5, ly0 + 0.15, lz)), Vector((-HALF - 0.05, ly0 + 0.15, lz))], 0.013, M['steel'], res=4)
for k in range(3):
    xx = -HALF - 0.14 - k * 0.13
    tube('Rung', [Vector((xx, ly0 - 0.15, lz)), Vector((xx, ly0 + 0.15, lz))], 0.011, M['steel'])
# T-top: light liner underneath with four downlights, plus a stern light.
for lx2, ly2 in ((0.1, 0.35), (0.1, -0.35), (-1.2, 0.45), (-1.2, -0.45)):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.045, depth=0.012, vertices=20, location=(lx2, ly2, roof_z(lx2, ly2, -0.065)))
    bpy.context.object.data.materials.append(M['steel'])
    finish(bpy.context.object)
box('SternLight', 0.05, 0.05, 0.05, (-1.4, 0, ROOF + 0.43), M['engine'], bevel=0.015)
# Helm seat pedestals showing under the cushions.
for yy in (HY + 0.33, HY - 0.33):
    tube('SeatPost', [Vector((-0.24 + SH, yy, FLOOR + 0.42)), Vector((-0.24 + SH, yy, FLOOR + 0.5))], 0.07, M['steel'])

# ---------------- upholstery piping ----------------
M['piping'] = material('Piping', hexc('#bfbcb2'), 0.6)


def piping_rect(name, cx, cy, hx, hy, z, r=0.05):
    pts = [(cx - hx + r, cy - hy), (cx + hx - r, cy - hy), (cx + hx, cy - hy + r), (cx + hx, cy + hy - r),
           (cx + hx - r, cy + hy), (cx - hx + r, cy + hy), (cx - hx, cy + hy - r), (cx - hx, cy - hy + r)]
    tube(name, [Vector((x, y, z)) for x, y in pts], 0.006, M['piping'], res=4, cyclic=True)


for _bx in (-3.2, -1.95):
    piping_rect('BenchPiping', _bx, DY, 0.3, 0.7, FLOOR + 0.455)
    piping_rect('BenchPipingLow', _bx, DY, 0.315, 0.715, FLOOR + 0.385)
for _yy in (HY + 0.33, HY - 0.33):
    piping_rect('SeatPiping', -0.24 + SH, _yy, 0.235, 0.225, FLOOR + 0.615, r=0.05)

# ---------------- invented branding ("MAREA") ----------------
def label(text, loc, facing, size, mat, shear=0.0):
    """Flat lettering standing upright, readable from outside the surface it faces."""
    cu = bpy.data.curves.new(text, 'FONT')
    cu.body = text
    cu.size = size
    cu.shear = shear
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.extrude = 0.0015
    cu.resolution_u = 3
    ob = bpy.data.objects.new('Label_' + text, cu)
    col.objects.link(ob)
    cu.materials.append(mat)
    ob.rotation_euler = Euler((radians(90), 0, radians({'-y': 0, '+y': 180, '+x': 90, '-x': -90}[facing])))
    ob.location = loc


_ox, _z0 = -HALF - 0.5, 0.55
for yy in (0.36, -0.36):
    label('MAREA', (_ox - 0.06, yy + 0.333, _z0 + 0.27), '+y', 0.1, M['steel'], shear=0.2)
    label('MAREA', (_ox - 0.06, yy - 0.333, _z0 + 0.27), '-y', 0.1, M['steel'], shear=0.2)
    label('300', (_ox - 0.605, yy, _z0 + 0.56), '-x', 0.1, M['steel'], shear=0.2)
for yy in (HY + 0.33, HY - 0.33):
    label('MAREA', (-0.56 + SH + 0.066, yy, FLOOR + 1.31), '+x', 0.042, M['thread'])
label('MAREA', (-3.2 - 0.34 * 0.9 + 0.045, DY, FLOOR + 0.8), '+x', 0.045, M['thread'])
label('MAREA', (-1.95 + 0.34 * 0.9 - 0.045, DY, FLOOR + 0.8), '-x', 0.045, M['thread'])
label('MAREA', (-0.86 + SH - 0.256, HY, FLOOR + 0.72), '-x', 0.06, M['steel'], shear=0.2)

# ---------------- convert, join, bake AO into vertex colours ----------------
bpy.ops.object.select_all(action='DESELECT')
for ob in list(col.objects):
    ob.select_set(True)
bpy.context.view_layer.objects.active = hull
bpy.ops.object.convert(target='MESH')
bpy.ops.object.join()
boat = bpy.context.view_layer.objects.active
boat.name = 'SauvageSpider34'
me = boat.data
print('VERTS', len(me.vertices), 'FACES', len(me.polygons))
uvl = me.uv_layers.get('UVMap') or me.uv_layers.new(name='UVMap')
me.uv_layers.active = uvl
for poly in me.polygons:
    nrm = poly.normal
    ax = max(range(3), key=lambda i: abs(nrm[i]))
    for li in poly.loop_indices:
        co = me.vertices[me.loops[li].vertex_index].co
        uvp = (co.x, co.y) if ax == 2 else ((co.y, co.z) if ax == 0 else (co.x, co.z))
        uvl.data[li].uv = (uvp[0] / TILE, uvp[1] / TILE)

try:
    ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    scene.render.bake.target = 'VERTEX_COLORS'
    bpy.ops.object.bake(type='AO')
    # Lift the floor so shaded areas darken without going black.
    for d in ca.data:
        c = d.color
        k = 0.42 + 0.58 * c[0] ** 1.3
        d.color = (k, k, k, 1.0)
    print('AO baked')
    HAS_AO = True
except Exception as e:  # noqa
    print('AO bake skipped:', e)
    HAS_AO = False

# ---------------- export ----------------
os.makedirs(os.path.dirname(OUT), exist_ok=True)
kw = dict(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True, export_image_format='JPEG',
          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
if HAS_AO:
    kw.update(export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
try:
    bpy.ops.export_scene.gltf(**kw)
except TypeError as e:
    print('export fallback:', e)
    kw.pop('export_vertex_color', None)
    kw.pop('export_active_vertex_color_when_no_material', None)
    bpy.ops.export_scene.gltf(**kw)
print('EXPORTED', OUT, os.path.getsize(OUT))

# ---------------- previews ----------------
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 620
    world = bpy.data.worlds.new('W')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.55, 0.72, 0.95, 1)
    bg.inputs[1].default_value = 1.0
    try:
        sky = world.node_tree.nodes.new('ShaderNodeTexSky')
        for attr, val in (('sun_disc', False), ('sun_elevation', radians(38)), ('sun_rotation', radians(140))):
            if hasattr(sky, attr):
                setattr(sky, attr, val)
        world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
        bg.inputs[1].default_value = 0.09
    except Exception as e:  # noqa
        print('sky fallback:', e)
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = 4
    so = bpy.data.objects.new('Sun', sun)
    so.rotation_euler = Euler((radians(50), 0, radians(130)))
    col.objects.link(so)
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
    sea = bpy.context.object
    sea.data.materials.append(material('Sea', (0.02, 0.09, 0.16), 0.08))
    cam = bpy.data.cameras.new('Cam')
    cam.lens = 55
    co = bpy.data.objects.new('Cam', cam)
    col.objects.link(co)
    scene.camera = co
    views = {'front_quarter': (13, -12, 4.2), 'stern_quarter': (-13, 10, 5.5), 'side': (0, -19, 2.2), 'top': (-3, -6, 15), 'helm': (-2.4, 3.0, 3.6), 'stern': (-10.5, 3.6, 4.0)}
    for name, pos in views.items():
        co.location = pos
        tgt = Vector((0.5, 0.1, 1.45)) if name == 'helm' else (Vector((-5.0, 0.2, 0.8)) if name == 'stern' else Vector((0, 0, 1.0)))
        d = tgt - Vector(pos)
        co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(PREVIEW, name + '.png')
        bpy.ops.render.render(write_still=True)
    print('PREVIEWS DONE')
