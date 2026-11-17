import * as THREE from 'three';

/*
 * A high, distant coastline on one side of the scene: cliffs rising from the sea into
 * ridged hills, about two kilometres away. It is there for scale and depth, so it is kept
 * soft: lit by the sun, then faded toward the sky's own horizon colour with distance and
 * with low altitude (sea haze). The far side of the scene stays open water.
 */

// --- small deterministic value noise (no dependencies) ---
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let v = 0;
  let amp = 0.5;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x, y);
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 5.3;
    amp *= 0.5;
  }
  return v;
}
function ridged(x, y, oct = 5) {
  let v = 0;
  let amp = 0.5;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(2 * vnoise(x, y) - 1);
    v += amp * n * n;
    x = x * 2.1 + 3.1;
    y = y * 2.1 + 7.9;
    amp *= 0.5;
  }
  return v;
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const vertexShader = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vColor = color;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform samplerCube uEnv;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uLight;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;

  void main() {
    vec3 N = normalize(vNormal);
    float diff = max(dot(N, uSunDir), 0.0);
    // Sky light from above, a little bounce from the sea below.
    float sky = 0.5 + 0.5 * N.y;
    vec3 lit = vColor * (uSunColor * diff * 0.55 + vec3(0.55, 0.66, 0.85) * sky * 0.5 * uLight);

    // Aerial perspective: fade to the sky colour at the horizon in this direction.
    vec3 toP = vWorld - cameraPosition;
    float dist = length(toP);
    vec3 dir = toP / dist;
    vec3 haze = textureCube(uEnv, normalize(vec3(dir.x, 0.03, dir.z))).rgb;
    float f = 1.0 - exp(-dist / 6500.0);
    f = clamp(f + 0.16 * exp(-max(vWorld.y, 0.0) / 40.0), 0.0, 0.9);
    vec3 col = mix(lit, haze, f);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createCoast({ envMap, segments = 220, rows = 26 } = {}) {
  const R = 2100; // distance of the shoreline from the boat
  const DEPTH = 1700; // how far inland the terrain runs
  const SPAN = THREE.MathUtils.degToRad(150);
  const CENTER = THREE.MathUtils.degToRad(-128); // direction of the middle of the coast

  const nu = segments + 1;
  const nv = rows + 1;
  const pos = new Float32Array(nu * nv * 3);
  const col = new Float32Array(nu * nv * 3);
  const rock = new THREE.Color('#b59a7c');
  const rockDark = new THREE.Color('#7d6b58');
  const green = new THREE.Color('#4f5f3c');
  const greenDark = new THREE.Color('#33432b');
  const tmp = new THREE.Color();

  for (let i = 0; i < nu; i++) {
    const s = i / segments; // 0..1 along the coast
    const a = CENTER + (s - 0.5) * SPAN;
    // The land tapers into the sea at both ends, as two headlands.
    const taper = Math.pow(Math.sin(Math.PI * s), 0.7);
    // Bays and capes move the shoreline in and out.
    const shore = R + 320 * (fbm(s * 7.0, 1.3, 4) - 0.5) + 260 * (1 - taper);
    const cliff = (35 + 70 * fbm(s * 9.0, 4.2, 3)) * taper;
    for (let j = 0; j < nv; j++) {
      const t = j / rows; // 0 at the waterline, 1 far inland
      const r = shore + DEPTH * Math.pow(t, 1.25);
      const hills = ridged(s * 6.5, t * 2.2 + 3.0, 5);
      const big = fbm(s * 2.2 + 9.0, t * 1.1, 3);
      let h = cliff * smooth(0.0, 0.06, t);
      h += (140 + 330 * big) * (0.35 + 0.9 * hills) * smooth(0.03, 0.7, t) * taper;
      h *= 1 - 0.55 * smooth(0.8, 1.0, t); // fall away at the back so no hard top edge shows
      if (j === 0) h = 0;
      const k = (i * nv + j) * 3;
      pos[k] = Math.cos(a) * r;
      pos[k + 1] = h;
      pos[k + 2] = Math.sin(a) * r;

      // Bare ochre rock on the cliffs and steep ground, Mediterranean scrub higher up.
      const scrub = smooth(40, 150, h) * (0.55 + 0.45 * fbm(s * 40, t * 14, 3));
      tmp.copy(rock).lerp(rockDark, fbm(s * 60, t * 30, 2));
      tmp.lerp(greenDark.clone().lerp(green, fbm(s * 25 + 4, t * 9, 3)), scrub);
      col[k] = tmp.r;
      col[k + 1] = tmp.g;
      col[k + 2] = tmp.b;
    }
  }
  const idx = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < rows; j++) {
      const p0 = i * nv + j;
      const p1 = p0 + nv;
      idx.push(p0, p0 + 1, p1, p1, p0 + 1, p1 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const uniforms = {
    uEnv: { value: envMap },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uLight: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.name = 'Coast';
  return { mesh, uniforms };
}
