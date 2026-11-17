import * as THREE from 'three';

// Wave field: a sum of sharpened sine waves ("exp(sin)") where each octave drags the
// sampling point of the next, which bunches crests the way real wind sea does.
// The same function runs in JS (boat buoyancy), in the vertex shader (shape) and, with
// more octaves, in the fragment shader (per-pixel normals).
const FREQ0 = 0.16; // rad/m of the longest wave (~39 m)
const GAIN = 1.18;
const DECAY = 0.83;
const DRAG = 0.38;
const AMP = 1.1; // metres
const WIND = 0.3; // prevailing direction, radians
const SPREAD = 1.15;
const VERT_ITERS = 10;

/** Water surface height at world (x, z). `travel` = distance the boat has moved along +X. */
export function waterHeight(x, z, time, travel) {
  let px = (x + travel) * FREQ0;
  let pz = z * FREQ0;
  let freq = 1;
  let w = 1;
  let sum = 0;
  let ws = 0;
  for (let i = 0; i < VERT_ITERS; i++) {
    const a = WIND + SPREAD * Math.sin(i * 2.399963);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const ph = (dx * px + dz * pz) * freq + time * Math.sqrt(9.81 * freq * FREQ0);
    const wave = Math.exp(Math.sin(ph) - 1);
    const d = -wave * Math.cos(ph);
    px += dx * d * w * DRAG;
    pz += dz * d * w * DRAG;
    sum += wave * w;
    ws += w;
    w *= DECAY;
    freq *= GAIN;
  }
  return (sum / ws - 0.45) * AMP;
}

const f = (n) => n.toFixed(6);
const waveGLSL = /* glsl */ `
  float waveH(vec2 pos, int iters) {
    vec2 p = pos * ${f(FREQ0)};
    float freq = 1.0;
    float w = 1.0;
    float sum = 0.0;
    float ws = 0.0;
    for (int i = 0; i < iters; i++) {
      float a = ${f(WIND)} + ${f(SPREAD)} * sin(float(i) * 2.399963);
      vec2 d = vec2(cos(a), sin(a));
      float ph = dot(d, p) * freq + uTime * sqrt(9.81 * freq * ${f(FREQ0)});
      float wave = exp(sin(ph) - 1.0);
      float dd = -wave * cos(ph);
      p += d * dd * w * ${f(DRAG)};
      sum += wave * w;
      ws += w;
      w *= ${f(DECAY)};
      freq *= ${f(GAIN)};
    }
    return (sum / ws - 0.45) * ${f(AMP)};
  }
`;

/** Tileable ripple normal map, generated once (no network request). */
function makeRippleNormals(size = 128) {
  const h = new Float32Array(size * size);
  const comps = [];
  // Integer frequencies keep it tileable.
  for (let i = 0; i < 24; i++) {
    const fx = Math.round((Math.random() * 2 - 1) * (3 + i * 0.9));
    const fy = Math.round((Math.random() * 2 - 1) * (3 + i * 0.9));
    if (fx === 0 && fy === 0) continue;
    comps.push({ fx, fy, p: Math.random() * Math.PI * 2, a: 1 / Math.hypot(fx, fy) });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(((c.fx * x + c.fy * y) / size) * Math.PI * 2 + c.p);
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const s = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y - 1 + size) % size) * size + x];
      const u = h[((y + 1) % size) * size + x];
      let nx = (l - r) * s;
      let ny = (d - u) * s;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Grid denser near the origin (where the boat and camera are), sparse to the horizon. */
function makeOceanGeometry(segments, radius) {
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const map = (u) => Math.sign(u) * Math.pow(Math.abs(u), 2.6) * radius;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = map((i / segments) * 2 - 1);
      pos[k + 1] = 0;
      pos[k + 2] = map((j / segments) * 2 - 1);
    }
  }
  const idx = [];
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.5);
  return g;
}

const wakeGLSL = /* glsl */ `
  // Extra surface height from the boat (at the origin, heading +X). q = world xz.
  float wakeH(vec2 q) {
    float az = abs(q.y);
    float behind = -q.x - 4.9;
    float b = max(behind, 0.0);
    float aft = smoothstep(-0.6, 1.2, behind);
    // Diverging ridges of the V wake.
    float arm = exp(-pow((az - (1.45 + b * 0.33)) / (0.45 + b * 0.07), 2.0)) * aft * exp(-b / 60.0);
    // Churned water between them, travelling aft.
    float rip = sin(b * 1.15 - uTime * 3.2 + az * 0.6) * exp(-pow(az / (1.0 + b * 0.3), 2.0)) * aft * exp(-b / 38.0);
    // Mound of water pushed aside along the forward half of the hull.
    float hw = 1.38 * sqrt(clamp(1.0 - pow(max(q.x - 0.4, 0.0) / 4.0, 2.0), 0.0, 1.0));
    float bow = exp(-pow(max(az - hw, 0.0) / 0.4, 2.0)) * smoothstep(4.9, 2.6, q.x) * smoothstep(-1.5, 1.5, q.x);
    return (0.17 * arm + 0.05 * rip + 0.13 * bow) * uSpeed;
  }
`;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uTravel;
  uniform float uSpeed;
  varying vec3 vWorld;
  ${waveGLSL}
  ${wakeGLSL}
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float att = 1.0 - smoothstep(400.0, 1600.0, length(wp.xz));
    wp.y += waveH(wp.xz + vec2(uTravel, 0.0), ${VERT_ITERS}) * att + wakeH(wp.xz);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uTravel;
  uniform samplerCube uEnv;
  uniform sampler2D uRipples;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uHorizon;
  uniform vec3 uHullColor;
  uniform float uLight;
  uniform float uSpeed;
  varying vec3 vWorld;
  ${waveGLSL}
  ${wakeGLSL}

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float cellEdge(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = vec2(hash(i + g), hash(i + g + 17.3));
        o = 0.5 + 0.4 * sin(uTime * 0.6 + 6.2831 * o);
        float d = length(g + o - f);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return f2 - f1;
  }
  // Ridged fbm: bright thin cells, like foam lacing.
  float lace(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 4; i++) {
      v += a * (1.0 - abs(2.0 * noise(p) - 1.0));
      p = p * 2.13 + 7.1;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 wpos = vWorld.xz + vec2(uTravel, 0.0);
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;

    // ---- wake masks: boat at the origin heading +X, water streams past ----
    vec2 q = vWorld.xz;
    float az = abs(q.y);
    float behind = -q.x - 4.9;
    float b = max(behind, 0.0);
    float aft = smoothstep(-0.6, 1.2, behind);
    float wash = exp(-pow(az / (0.8 + b * 0.085), 2.0)) * aft * exp(-b / 65.0);
    float trail = exp(-pow(az / (1.2 + b * 0.12), 2.0)) * aft * exp(-b / 150.0);
    float arm = exp(-pow((az - (1.45 + b * 0.33)) / (0.4 + b * 0.065), 2.0)) * aft * exp(-b / 80.0);
    float hw = 1.38 * sqrt(clamp(1.0 - pow(max(q.x - 0.4, 0.0) / 4.0, 2.0), 0.0, 1.0));
    float side = exp(-pow(max(az - hw, 0.0) / (0.16 + 0.22 * smoothstep(3.0, -2.0, q.x)), 2.0))
               * smoothstep(-5.4, -4.6, q.x) * smoothstep(3.8, 2.2, q.x) * 0.62;
    float mask = max(max(wash, arm * 0.85), side) * uSpeed;
    float churn = clamp(max(mask, trail * 0.6), 0.0, 1.0);

    // ---- per-pixel normal from the wave field; fewer octaves with distance ----
    int iters = int(mix(float(ITER_F), 7.0, smoothstep(25.0, 500.0, dist)));
    float e = 0.05 + dist * 0.003;
    float h0 = waveH(wpos, iters) + wakeH(vWorld.xz);
    float hx = waveH(wpos + vec2(e, 0.0), iters) + wakeH(vWorld.xz + vec2(e, 0.0));
    float hz = waveH(wpos + vec2(0.0, e), iters) + wakeH(vWorld.xz + vec2(0.0, e));
    vec3 N = vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e);
    // Capillary detail near the camera, turbulence inside the wake.
    vec3 r1 = texture2D(uRipples, wpos * 0.35 + vec2(uTime * 0.05, uTime * 0.03)).xyz * 2.0 - 1.0;
    vec3 r2 = texture2D(uRipples, wpos * 0.9 - vec2(uTime * 0.09, -uTime * 0.06)).xyz * 2.0 - 1.0;
    float near = 1.0 - smoothstep(10.0, 160.0, dist);
    N.xz += (r1.xy + r2.xy * 0.6) * (0.16 * near + 0.6 * churn);
    N = normalize(N);
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.8 * smoothstep(80.0, 1800.0, dist)));

    float NdV = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

    // ---- reflection: sky, plus a soft reflection of the hull ----
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.02;
    R = normalize(R);
    vec3 refl = textureCube(uEnv, R).rgb;
    vec3 er = vec3(5.4, 0.8, 1.5);
    vec3 o = (vWorld - vec3(0.0, 0.75, 0.0)) / er;
    vec3 d = R / er;
    float dd = dot(d, d);
    float bb = dot(o, d);
    float disc = bb * bb - dd * (dot(o, o) - 1.0);
    float hullHit = step(bb, 0.0) * smoothstep(0.0, 0.35, disc / dd);
    vec3 hullLit = uHullColor * (0.35 + 0.65 * max(uSunDir.y, 0.0)) * uLight * 0.9 + refl * 0.12;
    refl = mix(refl, hullLit, hullHit * 0.85);

    // ---- water body: deep blue, turquoise light scattered through crests ----
    float crest = clamp(h0 / ${f(AMP)} + 0.45, 0.0, 1.0);
    float back = pow(max(dot(V, -normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 3.0);
    vec3 body = uDeep * uLight;
    body += uShallow * uLight * (0.12 + 0.55 * crest * crest) * (0.35 + 0.65 * back);
    body += uShallow * uLight * 0.1 * max(dot(N, uSunDir), 0.0);
    // Aerated water in the trail is lighter and greener.
    body = mix(body, uShallow * uLight * 1.7, clamp(trail * 0.55 * uSpeed, 0.0, 0.55));

    vec3 col = mix(body, refl, fres);

    // ---- sun glitter ----
    float rs = max(dot(R, uSunDir), 0.0);
    float spec = pow(rs, 1400.0) * 16.0 + pow(rs, 180.0) * 0.5 + pow(rs, 24.0) * 0.02;
    col += uSunColor * spec * smoothstep(-0.02, 0.05, uSunDir.y) * (1.0 - hullHit);

    // ---- contact shadow of the boat ----
    vec2 off = -uSunDir.xz / max(uSunDir.y, 0.12) * 0.9;
    off *= min(1.0, 5.0 / max(length(off), 0.001));
    float sh = smoothstep(1.25, 0.55, length((q - off) / vec2(5.6, 1.8)));
    col *= 1.0 - 0.4 * sh * (1.0 - fres);

    // ---- foam ----
    // Coverage: thick where the water is being churned now, thinning with age down the trail.
    float patchy = 0.65 + 0.7 * noise(wpos * 0.22 + vec2(0.0, uTime * 0.05));
    float cover = max(mask * 1.2, trail * 0.7 * uSpeed) * patchy;
    cover = max(cover, smoothstep(0.72, 0.92, crest) * 0.45 * near);
    vec2 fw = wpos + (r1.xy + r2.xy) * 0.25;
    float c1 = cellEdge(fw * 1.15);
    float c2 = cellEdge(fw * 3.4 + 11.0);
    float c3 = cellEdge(fw * 9.0 + 3.0);
    float holes = c1 * 1.5 + c2 * 0.55;
    float foam = smoothstep(0.0, 0.22, cover - holes * (1.05 - cover * 0.75));
    // Fine bubbles give the solid areas a grain; thick foam is brighter than thin lace.
    float thick = smoothstep(0.25, 1.0, cover);
    foam *= mix(0.55, 1.0, thick) * (0.8 + 0.2 * smoothstep(0.02, 0.2, c3));
    float foamLit = 0.72 + 0.28 * max(dot(N, uSunDir), 0.0);
    vec3 foamCol = vec3(0.95, 0.98, 1.0) * mix(0.3, 2.6, uLight * uLight) * foamLit;
    // Thin foam lets the turquoise water show through.
    foamCol = mix(uShallow * uLight * 2.0, foamCol, 0.55 + 0.45 * thick);
    foamCol += uSunColor * 0.08 * max(uSunDir.y, 0.0);
    col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.96);

    // ---- haze into the sky at the horizon ----
    vec3 skyAtHorizon = textureCube(uEnv, normalize(vec3(-V.x, 0.03, -V.z))).rgb;
    col = mix(col, mix(uHorizon, skyAtHorizon, 0.75), smoothstep(250.0, 3600.0, dist));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createOcean({ segments = 256, envMap, fragIters = 24 }) {
  const uniforms = {
    uTime: { value: 0 },
    uTravel: { value: 0 },
    uEnv: { value: envMap },
    uRipples: { value: makeRippleNormals() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uDeep: { value: new THREE.Color('#06263f') },
    uShallow: { value: new THREE.Color('#1b8fa6') },
    uHorizon: { value: new THREE.Color('#bcd3e4') },
    uLight: { value: 1 },
    uHullColor: { value: new THREE.Color('#dfe5ea') },
    uSpeed: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    defines: { ITER_F: fragIters },
  });
  const mesh = new THREE.Mesh(makeOceanGeometry(segments, 3000), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}
