import * as THREE from 'three';

/*
 * Spray: droplets and mist thrown up by the boat. Stateless GPU particles — every particle's
 * whole flight is a function of time and a per-particle seed, so there is no per-frame CPU work.
 * The boat sits at the origin heading +X; the water streams past toward -X.
 *
 * Emitters (attribute aKind): 0 = bow wave, port/starboard; 1 = hull sides; 2 = propeller wash.
 */
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixel;
  attribute vec4 aSeed;   // four random numbers in [0, 1)
  attribute float aKind;
  varying float vAlpha;

  void main() {
    float side = aSeed.w < 0.5 ? -1.0 : 1.0;
    float life = mix(0.7, 1.3, aSeed.y);
    float t = fract(uTime / life + aSeed.x);
    float age = t * life;

    vec3 p0;
    vec3 v0;
    float size;
    if (aKind < 0.5) {
      // Bow wave: thrown outward and up from where the stem cuts the water.
      p0 = vec3(mix(2.4, 4.3, aSeed.z), side * mix(0.25, 1.15, 1.0 - aSeed.z), 0.05);
      v0 = vec3(-mix(2.5, 4.2, aSeed.y), side * mix(1.4, 3.2, aSeed.x), mix(1.3, 2.9, fract(aSeed.z * 7.3)));
      size = mix(0.05, 0.16, aSeed.y);
    } else if (aKind < 1.5) {
      // Along the hull: low mist peeling off the chine.
      p0 = vec3(mix(-4.5, 2.4, aSeed.z), side * mix(1.25, 1.45, aSeed.y), 0.03);
      v0 = vec3(-mix(3.0, 4.2, aSeed.x), side * mix(0.5, 1.6, aSeed.y), mix(0.4, 1.3, fract(aSeed.z * 5.1)));
      size = mix(0.06, 0.2, aSeed.x);
    } else {
      // Propeller wash: boiling water and a low rooster tail behind the engines.
      p0 = vec3(mix(-6.6, -5.9, aSeed.z), side * 0.36 + (aSeed.y - 0.5) * 0.5, 0.0);
      v0 = vec3(-mix(3.2, 5.0, aSeed.x), (aSeed.z - 0.5) * 1.6, mix(0.7, 2.1, fract(aSeed.y * 3.7)));
      size = mix(0.08, 0.26, aSeed.z);
    }
    vec3 pos = p0 + v0 * age + vec3(0.0, 0.0, -4.9 * age * age);
    // Scene is Y-up: the emitter maths above uses (x fwd, y lateral, z up).
    vec3 world = vec3(pos.x, max(pos.z, -0.05), pos.y);

    // Fade in fast, fade out as it falls back; drop it once under the surface.
    vAlpha = smoothstep(0.0, 0.08, t) * pow(1.0 - t, 1.6) * step(-0.04, pos.z);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * (1.0 + t * 2.2) * uPixel / max(-mv.z, 0.1);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uLight;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = dot(c, c) * 4.0;
    float a = smoothstep(1.0, 0.0, r);
    a = pow(a, 1.5);
    vec3 col = vec3(0.95, 0.98, 1.0) * mix(0.25, 2.4, uLight * uLight * uLight);
    gl_FragColor = vec4(col, a * vAlpha * 0.6);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSpray({ count = 1500 }) {
  const seeds = new Float32Array(count * 4);
  const kinds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = Math.random();
    const r = i / count;
    kinds[i] = r < 0.45 ? 0 : r < 0.7 ? 1 : 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(-2, 1, 0), 30);

  const uniforms = {
    uTime: { value: 0 },
    uLight: { value: 1 },
    uPixel: { value: 2600 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return { points, uniforms };
}
