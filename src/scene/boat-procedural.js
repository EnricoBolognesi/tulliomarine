import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/*
 * Procedural approximation of a Ranieri Sauvage 34 Spider (LOA 10.30 m, beam 3.00 m).
 * Built from reference photos: light-blue deep-V hull, long dark side window forward,
 * white deck, low wraparound windshield, black-framed T-top, twin outboards.
 *
 * Contract (so a real GLB can replace this file): createBoat() returns a THREE.Group,
 * metres, origin at the static waterline amidships, +X = bow, +Y = up.
 */

export const LOA = 10.3;
const HALF_L = LOA / 2;
const GUNWALE = 0.16; // gunwale cap width
const FLOOR = 0.5; // cockpit sole height above waterline
const COCKPIT_AFT = 0.03; // t range of the recessed cockpit
const COCKPIT_FWD = 0.62;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const xOf = (t) => -HALF_L + t * LOA;
export const tOf = (x) => (x + HALF_L) / LOA;

/* ---------------- hull lines ---------------- */

/** Half-beam at the sheer. */
export function beam(t) {
  if (t < 0.5) return lerp(1.42, 1.5, smooth(0, 0.5, t));
  const u = (t - 0.5) / 0.5;
  return 1.5 * Math.pow(Math.max(0, 1 - Math.pow(u, 2.2)), 0.6);
}
/** Sheer height above waterline: rises toward the bow. */
export function sheer(t) {
  return 1.02 + 0.4 * Math.pow(t, 2.3);
}
/** Keel line: flat aft, sweeping up into a raked stem. */
function keel(t) {
  if (t < 0.6) return -0.52 + 0.04 * (1 - t / 0.6);
  const u = (t - 0.6) / 0.4;
  return -0.52 + (sheer(1) - 0.02 + 0.52) * Math.pow(u, 2.1);
}
/** Deadrise in radians: ~21° aft, sharper forward. */
function deadrise(t) {
  return THREE.MathUtils.degToRad(lerp(21, 48, smooth(0.45, 1, t)));
}
function chine(t) {
  const B = beam(t);
  const c = 0.84 * B;
  const k = keel(t);
  const s = sheer(t);
  const y = Math.min(k + Math.tan(deadrise(t)) * c, lerp(k, s, 0.55));
  return { c, y, k, s, B };
}

/** Bottom surface point: v=0 keel → v=1 chine (incl. small spray-rail ledge). */
function bottomPoint(t, v, side, out) {
  const { c, y, k } = chine(t);
  if (v < 0.85) {
    const w = v / 0.85;
    out.set(xOf(t), lerp(k, y, w) - 0.03 * Math.sin(Math.PI * w), side * c * w);
  } else {
    const w = (v - 0.85) / 0.15;
    out.set(xOf(t), y + 0.005 * w, side * (c + 0.07 * w * chine(t).B / 1.5));
  }
  return out;
}
/** Topside point: v=0 at the chine ledge → v=1 at the sheer, with flare. */
export function topsidePoint(t, v, side, out) {
  const { c, y, s, B } = chine(t);
  const z0 = c + (0.07 * B) / 1.5;
  const flare = 1 - Math.pow(1 - v, 2.2);
  out.set(xOf(t), lerp(y, s, v), side * lerp(z0, B, flare));
  return out;
}

/* ---------------- geometry helpers ---------------- */

function paramSurface(fn, nu, nv, flip = false) {
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
  const uv = new Float32Array((nu + 1) * (nv + 1) * 2);
  const p = new THREE.Vector3();
  let k = 0;
  let q = 0;
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      fn(i / nu, j / nv, p);
      pos[k++] = p.x;
      pos[k++] = p.y;
      pos[k++] = p.z;
      uv[q++] = i / nu;
      uv[q++] = j / nv;
    }
  }
  const idx = [];
  const row = nv + 1;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * row + j;
      const b = a + row;
      if (flip) idx.push(a, a + 1, b, b, a + 1, b + 1);
      else idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Station spacing: denser toward the bow where the shape changes fastest. */
const stationT = (u) => Math.pow(u, 0.85);

function mirrored(fn, nu, nv, material, flipStarboard = false) {
  const g = new THREE.Group();
  const s = new THREE.Mesh(paramSurface((u, v, p) => fn(u, v, 1, p), nu, nv, flipStarboard), material);
  const pt = new THREE.Mesh(paramSurface((u, v, p) => fn(u, v, -1, p), nu, nv, !flipStarboard), material);
  g.add(s, pt);
  return g;
}

/** A thin decal surface laid on the topsides, defined over (t, v) bounds. */
function topsideDecal(tA, tB, vLow, vHigh, material, offset = 0.006, materialPort = material) {
  const p = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const n = new THREE.Vector3();
  const build = (side) =>
    paramSurface(
      (u, w, out) => {
        const t = lerp(tA, tB, u);
        const lo = vLow(u);
        const hi = vHigh(u);
        const v = lerp(lo, hi, w);
        topsidePoint(t, v, side, out);
        topsidePoint(t + 0.002, v, side, pt);
        topsidePoint(t, Math.min(1, v + 0.01), side, pv);
        pt.sub(out);
        pv.sub(out);
        n.crossVectors(pt, pv).normalize().multiplyScalar(side);
        out.addScaledVector(n, offset);
        p.copy(out);
      },
      48,
      4,
      side < 0
    );
  const g = new THREE.Group();
  g.add(new THREE.Mesh(build(1), material), new THREE.Mesh(build(-1), materialPort));
  return g;
}

/** Lettering drawn to a canvas, returned as [starboard, port] materials (port is mirrored back). */
function textMaterials(text, font, w, h, color) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.font = font;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2, w * 0.96);
  const make = (mirror) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (mirror) {
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.offset.x = 1;
    }
    return new THREE.MeshPhysicalMaterial({
      map: t,
      transparent: true,
      depthWrite: false,
      roughness: 0.3,
      clearcoat: 1,
      side: THREE.DoubleSide,
    });
  };
  return [make(false), make(true)];
}

/** Synthetic-teak planking: tileable canvas, planks run fore and aft. */
function teakTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#a57c55';
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    x.fillStyle = Math.random() > 0.5 ? 'rgba(255,235,200,0.05)' : 'rgba(60,35,15,0.06)';
    x.fillRect(Math.random() * 256, Math.random() * 256, 30 + Math.random() * 90, 1);
  }
  x.fillStyle = '#2a2622';
  for (let y = 0; y < 256; y += 64) x.fillRect(0, y, 256, 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Teak sole laid just above the cockpit floor. */
function buildSole(mat) {
  const geo = paramSurface(
    (u, v, out) => {
      const t = lerp(COCKPIT_AFT + 0.015, COCKPIT_FWD - 0.02, u);
      const inner = Math.max(0, beam(t) - GUNWALE - 0.01);
      out.set(xOf(t), FLOOR + 0.006, lerp(-inner, inner, v));
    },
    40,
    8,
    true
  );
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 0.34, pos.getZ(i) / 0.34);
  const m = new THREE.Mesh(geo, mat);
  return m;
}

/* ---------------- deck ---------------- */

function deckHeight(t, z) {
  const B = beam(t);
  const r = B > 0.001 ? z / B : 0;
  return sheer(t) + 0.07 * (1 - r * r);
}
/** 0 = flush deck, 1 = recessed cockpit. */
const cockpitW = (t) => smooth(COCKPIT_AFT - 0.012, COCKPIT_AFT, t) * (1 - smooth(COCKPIT_FWD - 0.012, COCKPIT_FWD, t));

function buildDeck(mat) {
  const group = new THREE.Group();
  const nu = 220;
  // Gunwale cap: sheer → inner edge.
  group.add(
    mirrored(
      (u, v, side, p) => {
        const t = u;
        const B = beam(t);
        const inner = Math.max(0, B - GUNWALE);
        const z = lerp(B, inner, v);
        const yIn = lerp(sheer(t), deckHeight(t, inner), 1 - cockpitW(t));
        p.set(xOf(t), lerp(sheer(t), yIn, v), side * z);
      },
      nu,
      2,
      mat,
      true
    )
  );
  // Inner bulwark: cap inner edge down to the cockpit sole (zero height on the foredeck).
  group.add(
    mirrored(
      (u, v, side, p) => {
        const t = u;
        const inner = Math.max(0, beam(t) - GUNWALE);
        const top = lerp(sheer(t), deckHeight(t, inner), 1 - cockpitW(t));
        const bottom = lerp(deckHeight(t, inner), FLOOR, cockpitW(t));
        p.set(xOf(t), lerp(top, bottom, v), side * inner);
      },
      nu,
      1,
      mat,
      true
    )
  );
  // Sole / foredeck: inner edge → centreline.
  group.add(
    mirrored(
      (u, v, side, p) => {
        const t = u;
        const inner = Math.max(0, beam(t) - GUNWALE);
        const z = inner * (1 - v);
        const y = lerp(deckHeight(t, z), FLOOR, cockpitW(t));
        p.set(xOf(t), y, side * z);
      },
      nu,
      6,
      mat,
      true
    )
  );
  return group;
}

function buildTransom(mat) {
  // Outline at t = 0 in (z, y): hull section starboard, deck back across, hull port.
  const pts = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= 10; i++) pts.push(bottomPoint(0, i / 10, 1, p).clone());
  for (let i = 1; i <= 12; i++) pts.push(topsidePoint(0, i / 12, 1, p).clone());
  const B = beam(0);
  for (let i = 0; i <= 8; i++) {
    const z = B * (1 - i / 8);
    pts.push(new THREE.Vector3(xOf(0), deckHeight(0, z), z));
  }
  const half = pts.slice();
  for (let i = half.length - 2; i >= 1; i--) pts.push(new THREE.Vector3(half[i].x, half[i].y, -half[i].z));
  const shape2d = pts.map((q) => new THREE.Vector2(q.z, q.y));
  const tris = THREE.ShapeUtils.triangulateShape(shape2d, []);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((q, i) => pos.set([q.x, q.y, q.z], i * 3));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx = [];
  // ShapeUtils winds CCW in (z, y); facing -X needs that order reversed.
  tris.forEach(([a, b, c]) => idx.push(a, c, b));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/* ---------------- parts ---------------- */

function tube(points, radius, mat, segs = 80, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  return new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius, 8, closed), mat);
}

function rbox(w, h, d, r, mat) {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
}

function buildOutboard(m) {
  const g = new THREE.Group();
  const cowl = rbox(0.82, 0.92, 0.6, 0.2, m.engine);
  cowl.position.set(-0.05, 0.52, 0);
  const cap = rbox(0.5, 0.06, 0.42, 0.03, m.engineAccent);
  cap.position.set(-0.1, 0.99, 0);
  const shaft = rbox(0.36, 1.05, 0.2, 0.05, m.engineLower);
  shaft.position.set(0.02, -0.38, 0);
  const torpedo = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 6, 12), m.engineLower);
  torpedo.rotation.z = Math.PI / 2;
  torpedo.position.set(0.02, -0.92, 0);
  const plate = rbox(0.5, 0.025, 0.36, 0.01, m.engineLower);
  plate.position.set(0.0, -0.6, 0);
  const skeg = rbox(0.2, 0.28, 0.04, 0.015, m.engineLower);
  skeg.position.set(-0.06, -1.12, 0);
  const bracket = rbox(0.22, 0.5, 0.3, 0.04, m.engineLower);
  bracket.position.set(0.3, 0.05, 0);
  g.add(cowl, cap, shaft, torpedo, plate, skeg, bracket);
  g.rotation.z = THREE.MathUtils.degToRad(-4); // slight trim out
  return g;
}

function buildSeat(m) {
  const g = new THREE.Group();
  const cushion = rbox(0.52, 0.16, 0.5, 0.07, m.cushion);
  cushion.position.set(0, 0.08, 0);
  const back = rbox(0.14, 0.62, 0.5, 0.07, m.cushion);
  back.position.set(-0.24, 0.42, 0);
  back.rotation.z = THREE.MathUtils.degToRad(-10);
  const bolsterL = rbox(0.44, 0.22, 0.08, 0.04, m.cushion);
  bolsterL.position.set(-0.02, 0.2, 0.23);
  const bolsterR = bolsterL.clone();
  bolsterR.position.z = -0.23;
  g.add(cushion, back, bolsterL, bolsterR);
  return g;
}

function buildWindshield(m) {
  // Wraparound screen: elliptical base from the port gunwale, round the bow side of the
  // console, back to the starboard gunwale, raked aft.
  const x0 = 0.25;
  const ax = 1.32;
  const tSide = tOf(x0);
  const bz = beam(tSide) - GUNWALE * 0.5;
  const base = (th, out) => {
    const x = x0 + ax * Math.cos(th);
    const z = bz * Math.sin(th);
    const t = tOf(x);
    const y = Math.max(deckHeight(t, Math.min(Math.abs(z), beam(t))), sheer(t)) + 0.01;
    return out.set(x, y, z);
  };
  const p0 = new THREE.Vector3();
  const geo = paramSurface(
    (u, v, out) => {
      const th = lerp(-Math.PI / 2, Math.PI / 2, u);
      base(th, p0);
      const h = lerp(0.5, 0.8, Math.cos(th));
      // inward (toward the console) and up
      const nx = Math.cos(th) / ax;
      const nz = Math.sin(th) / bz;
      const l = Math.hypot(nx, nz);
      out.set(p0.x - (nx / l) * h * 0.7 * v, p0.y + h * v, p0.z - (nz / l) * h * 0.7 * v);
    },
    64,
    6
  );
  const glass = new THREE.Mesh(geo, m.glass);
  glass.renderOrder = 2;

  const top = [];
  for (let i = 0; i <= 24; i++) {
    const th = lerp(-Math.PI / 2, Math.PI / 2, i / 24);
    base(th, p0);
    const h = lerp(0.5, 0.8, Math.cos(th));
    const nx = Math.cos(th) / ax;
    const nz = Math.sin(th) / bz;
    const l = Math.hypot(nx, nz);
    top.push(new THREE.Vector3(p0.x - (nx / l) * h * 0.7, p0.y + h, p0.z - (nz / l) * h * 0.7));
  }
  const g = new THREE.Group();
  g.add(glass, tube(top, 0.018, m.black, 64));
  return { group: g, topCurve: top };
}

function buildTTop(m, screenTop) {
  const g = new THREE.Group();
  const roofY = FLOOR + 2.02;
  // Roof plate: long teardrop-ish planform, sweeping forward.
  const s = new THREE.Shape();
  s.moveTo(-1.05, -0.95);
  s.bezierCurveTo(-1.25, -0.4, -1.25, 0.4, -1.05, 0.95);
  s.bezierCurveTo(0.2, 1.08, 1.2, 0.85, 1.75, 0.35);
  s.quadraticCurveTo(1.92, 0, 1.75, -0.35);
  s.bezierCurveTo(1.2, -0.85, 0.2, -1.08, -1.05, -0.95);
  const roofGeo = new THREE.ExtrudeGeometry(s, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.04,
    bevelSegments: 3,
    curveSegments: 24,
  });
  roofGeo.rotateX(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, m.roof);
  roof.position.set(0, roofY + 0.05, 0);
  roof.rotation.z = THREE.MathUtils.degToRad(-3.5);
  const under = new THREE.Mesh(roofGeo, m.black);
  under.scale.set(0.97, 0.4, 0.97);
  under.position.set(0.02, roofY - 0.035, 0);
  under.rotation.z = roof.rotation.z;
  g.add(roof, under);

  // Aft legs: sweep up from behind the helm seats and arc forward into the roof.
  for (const side of [1, -1]) {
    const pts = [
      new THREE.Vector3(-0.72, FLOOR + 0.02, side * 0.82),
      new THREE.Vector3(-0.78, FLOOR + 1.0, side * 0.86),
      new THREE.Vector3(-0.72, FLOOR + 1.75, side * 0.84),
      new THREE.Vector3(-0.35, roofY - 0.04, side * 0.8),
      new THREE.Vector3(0.6, roofY + 0.0, side * 0.72),
    ];
    g.add(tube(pts, 0.04, m.black, 48));
    // Forward strut from the screen frame up to the roof.
    const a = screenTop[side > 0 ? 18 : 6];
    g.add(tube([a.clone(), new THREE.Vector3(a.x + 0.25, (a.y + roofY) / 2 + 0.05, a.z * 0.85), new THREE.Vector3(1.05, roofY - 0.02, side * 0.55)], 0.03, m.black, 24));
  }
  // Ladder rungs on the aft legs (antenna/light mast look).
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 8), m.black);
    r.rotation.x = Math.PI / 2;
    r.position.set(-0.78, FLOOR + 0.9 + i * 0.28, 0.75);
    g.add(r);
  }
  // Nav light + antenna dome.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.deck);
  dome.position.set(-0.55, roofY + 0.12, 0);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.45, 8), m.black);
  mast.position.set(-0.85, roofY + 0.3, 0);
  g.add(dome, mast);
  return g;
}

function buildRails(m) {
  const g = new THREE.Group();
  const p = new THREE.Vector3();
  const pts = [];
  const ts = [];
  for (let i = 0; i <= 14; i++) ts.push(lerp(0.66, 0.985, Math.pow(i / 14, 0.9)));
  const at = (t, side) => {
    const B = beam(t);
    const z = side * Math.max(0, B - 0.06);
    return new THREE.Vector3(xOf(t), sheer(t) + 0.32, z);
  };
  for (let i = 0; i < ts.length; i++) pts.push(at(ts[i], -1));
  pts.push(new THREE.Vector3(xOf(0.998) + 0.08, sheer(1) + 0.3, 0));
  for (let i = ts.length - 1; i >= 0; i--) pts.push(at(ts[i], 1));
  g.add(tube(pts, 0.016, m.steel, 160));
  for (const t of [0.67, 0.75, 0.83, 0.91]) {
    for (const side of [1, -1]) {
      const top = at(t, side);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 8), m.steel);
      st.position.set(top.x, top.y - 0.16, top.z);
      g.add(st);
    }
  }
  const bowSt = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), m.steel);
  bowSt.position.set(xOf(0.99), sheer(1) + 0.15, 0);
  g.add(bowSt);
  void p;
  return g;
}

function buildRubrail(m) {
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const t = Math.pow(i / 30, 0.8) * 0.999;
    pts.push(new THREE.Vector3(xOf(t), sheer(t) - 0.02, beam(t) + 0.012));
  }
  const port = pts.map((q) => new THREE.Vector3(q.x, q.y, -q.z));
  const bowTip = new THREE.Vector3(HALF_L + 0.01, sheer(1) - 0.02, 0);
  return tube([...port, bowTip, ...pts.slice().reverse()], 0.03, m.rubrail, 240);
}

function buildSundeck(m) {
  const x0 = 2.05;
  const x1 = 3.95;
  const s = new THREE.Shape();
  const half = (x) => Math.max(0.1, beam(tOf(x)) - GUNWALE - 0.12);
  s.moveTo(x0, -half(x0));
  const N = 12;
  for (let i = 1; i <= N; i++) {
    const x = lerp(x0, x1, i / N);
    s.lineTo(x, -half(x));
  }
  for (let i = N; i >= 0; i--) {
    const x = lerp(x0, x1, i / N);
    s.lineTo(x, half(x));
  }
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.06,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 4,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  // Deck rises toward the bow: tilt the pad to match.
  const yA = deckHeight(tOf(x0), 0);
  const yB = deckHeight(tOf(x1), 0);
  const ang = Math.atan2(yB - yA, x1 - x0);
  geo.translate(-x0, 0, 0);
  const pad = new THREE.Mesh(geo, m.cushion);
  pad.position.set(x0, yA + 0.04, 0);
  pad.rotation.z = ang;
  return pad;
}

/* ---------------- assembly ---------------- */

export function createBoat() {
  const m = {
    hull: new THREE.MeshPhysicalMaterial({
      color: '#f3f4f2',
      roughness: 0.3,
      metalness: 0.0,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
    bottom: new THREE.MeshPhysicalMaterial({ color: '#eef0ee', roughness: 0.35, clearcoat: 0.8 }),
    deck: new THREE.MeshPhysicalMaterial({ color: '#f2f2ef', roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
    stripe: new THREE.MeshPhysicalMaterial({ color: '#20252b', roughness: 0.25, clearcoat: 1 }),
    window: new THREE.MeshPhysicalMaterial({ color: '#0b1218', roughness: 0.06, metalness: 0.2, clearcoat: 1 }),
    cushion: new THREE.MeshStandardMaterial({ color: '#ecebe6', roughness: 0.75 }),
    roof: new THREE.MeshPhysicalMaterial({ color: '#17191d', roughness: 0.3, clearcoat: 0.8 }),
    black: new THREE.MeshPhysicalMaterial({ color: '#15181c', roughness: 0.35, metalness: 0.4, clearcoat: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: '#e6e9ec', roughness: 0.15, metalness: 1 }),
    rubrail: new THREE.MeshStandardMaterial({ color: '#d9dde0', roughness: 0.3, metalness: 0.6 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: '#0d161d',
      roughness: 0.04,
      metalness: 0.1,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    engine: new THREE.MeshPhysicalMaterial({ color: '#f2f4f5', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
    engineAccent: new THREE.MeshStandardMaterial({ color: '#23272c', roughness: 0.35, metalness: 0.5 }),
    engineLower: new THREE.MeshStandardMaterial({ color: '#e6e9eb', roughness: 0.45, metalness: 0.1 }),
    teak: new THREE.MeshStandardMaterial({ map: teakTexture(), roughness: 0.7 }),
    teakPlain: new THREE.MeshStandardMaterial({ color: '#a57c55', roughness: 0.6 }),
    screen: new THREE.MeshPhysicalMaterial({ color: '#05080b', roughness: 0.05, clearcoat: 1 }),
  };

  const boat = new THREE.Group();
  boat.name = 'SauvageSpider34';

  // Hull shell.
  boat.add(mirrored((u, v, side, p) => bottomPoint(stationT(u), v, side, p), 120, 10, m.bottom));
  boat.add(mirrored((u, v, side, p) => topsidePoint(stationT(u), v, side, p), 120, 14, m.hull));
  boat.add(buildTransom(m.deck));
  boat.add(buildDeck(m.deck));
  boat.add(buildRubrail(m));

  // White sweep stripe low on the topsides, rising toward the bow.
  boat.add(
    topsideDecal(
      0.0,
      0.8,
      (u) => lerp(0.2, 0.4, Math.pow(u, 1.5)),
      (u) => lerp(0.23, 0.42, Math.pow(u, 1.5)) + 0.02 * Math.sin(Math.PI * u),
      m.stripe
    )
  );
  // Long dark hull window forward, tapering toward the bow.
  boat.add(
    topsideDecal(
      0.5,
      0.86,
      (u) => lerp(0.5, 0.52, u) + 0.06 * Math.pow(u, 2),
      (u) => lerp(0.6, 0.88, Math.pow(u, 0.7)) - 0.16 * Math.pow(u, 4),
      m.window
    )
  );
  const [nameS, nameP] = textMaterials('Sauvage 34', 'italic 600 150px "Segoe Script", "Brush Script MT", cursive', 1024, 200, '#1c2026');
  boat.add(topsideDecal(0.24, 0.45, () => 0.5, () => 0.9, nameS, 0.008, nameP));
  const [brandS, brandP] = textMaterials('RANIERI', '700 96px Georgia, serif', 640, 128, '#1c2026');
  boat.add(topsideDecal(0.05, 0.16, () => 0.56, () => 0.76, brandS, 0.008, brandP));
  boat.add(buildSole(m.teak));

  // Console with sloped dash.
  const prof = new THREE.Shape();
  prof.moveTo(0.42, 0);
  prof.lineTo(1.18, 0);
  prof.lineTo(1.18, 0.88);
  prof.lineTo(0.82, 1.08);
  prof.lineTo(0.42, 0.9);
  prof.lineTo(0.42, 0);
  const consoleGeo = new THREE.ExtrudeGeometry(prof, {
    depth: 1.1,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 3,
  });
  consoleGeo.translate(0, 0, -0.55);
  const consoleMesh = new THREE.Mesh(consoleGeo, m.deck);
  consoleMesh.position.y = FLOOR;
  boat.add(consoleMesh);
  const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.95), m.screen);
  const dashAng = Math.atan2(1.08 - 0.9, 0.82 - 0.42);
  dash.position.set(0.62, FLOOR + 0.995 + 0.045, 0);
  dash.rotation.set(0, -Math.PI / 2, 0);
  dash.rotateX(-(Math.PI / 2 - dashAng));
  boat.add(dash);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 10, 36), m.black);
  wheel.position.set(0.32, FLOOR + 0.95, 0.24);
  wheel.rotation.set(0, Math.PI / 2, 0);
  wheel.rotateX(THREE.MathUtils.degToRad(25));
  boat.add(wheel);

  const ws = buildWindshield(m);
  boat.add(ws.group);
  boat.add(buildTTop(m, ws.topCurve));

  // Helm seat module + two buckets.
  const helmBase = rbox(0.66, 0.42, 1.72, 0.06, m.deck);
  helmBase.position.set(-0.3, FLOOR + 0.21, 0);
  boat.add(helmBase);
  for (const z of [0.42, -0.42]) {
    const seat = buildSeat(m);
    seat.position.set(-0.24, FLOOR + 0.42, z);
    boat.add(seat);
  }
  // Aft galley/back module behind the seats.
  const galley = rbox(0.5, 0.92, 1.9, 0.05, m.deck);
  galley.position.set(-0.86, FLOOR + 0.46, 0);
  boat.add(galley);
  const galleyTop = rbox(0.52, 0.03, 1.92, 0.012, m.teakPlain);
  galleyTop.position.set(-0.86, FLOOR + 0.935, 0);
  boat.add(galleyTop);

  // Aft U-settee + table.
  const aftBench = rbox(0.55, 0.42, 2.3, 0.08, m.cushion);
  aftBench.position.set(-4.62, FLOOR + 0.21, 0);
  const aftBack = rbox(0.16, 0.42, 2.3, 0.07, m.cushion);
  aftBack.position.set(-4.92, FLOOR + 0.62, 0);
  boat.add(aftBench, aftBack);
  for (const side of [1, -1]) {
    const sideBench = rbox(1.6, 0.42, 0.48, 0.08, m.cushion);
    sideBench.position.set(-3.6, FLOOR + 0.21, side * 1.03);
    const sideBack = rbox(1.6, 0.36, 0.12, 0.06, m.cushion);
    sideBack.position.set(-3.6, FLOOR + 0.58, side * 1.24);
    boat.add(sideBench, sideBack);
  }
  const table = rbox(1.0, 0.04, 0.85, 0.02, m.teakPlain);
  table.position.set(-3.6, FLOOR + 0.72, 0);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 10), m.steel);
  leg.position.set(-3.6, FLOOR + 0.36, 0);
  boat.add(table, leg);

  boat.add(buildSundeck(m));
  for (const z of [0.5, -0.5]) {
    const head = rbox(0.3, 0.12, 0.6, 0.05, m.cushion);
    head.position.set(2.32, deckHeight(tOf(2.32), 0) + 0.2, z);
    head.rotation.z = THREE.MathUtils.degToRad(12);
    boat.add(head);
  }
  boat.add(buildRails(m));

  // Swim platforms either side of the engines.
  for (const side of [1, -1]) {
    const plat = rbox(0.62, 0.1, 0.68, 0.04, m.deck);
    plat.position.set(-HALF_L - 0.28, 0.32, side * 1.02);
    const pTeak = rbox(0.56, 0.02, 0.62, 0.01, m.teakPlain);
    pTeak.position.set(-HALF_L - 0.28, 0.375, side * 1.02);
    boat.add(plat, pTeak);
  }
  for (const z of [0.36, -0.36]) {
    const ob = buildOutboard(m);
    ob.position.set(-HALF_L - 0.42, 0.62, z);
    boat.add(ob);
  }

  // Lofted surfaces: render both faces so winding can never punch holes; three.js flips
  // the normal on back faces, so lighting stays correct either way.
  for (const k of ['hull', 'bottom', 'deck', 'stripe', 'window']) m[k].side = THREE.DoubleSide;

  boat.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  ws.group.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
  return boat;
}
