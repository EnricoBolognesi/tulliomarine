import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Time-of-day presets. Angles in degrees.
export const PRESETS = {
  mattino: {
    elevation: 11, azimuth: 105, turbidity: 2.6, rayleigh: 1.1, mie: 0.004, mieG: 0.86,
    clouds: 0.3, exposure: 0.44, sun: '#ffd2a1', sunIntensity: 2.8, ambient: 0.6,
    deep: '#08304a', shallow: '#2a8fa0', horizon: '#e7d6c8', light: 0.75,
  },
  giorno: {
    elevation: 42, azimuth: 140, turbidity: 2.0, rayleigh: 0.85, mie: 0.002, mieG: 0.8,
    clouds: 0.3, exposure: 0.4, sun: '#fff5e6', sunIntensity: 3.3, ambient: 0.62,
    deep: '#05304f', shallow: '#159bb2', horizon: '#c6dbea', light: 1.0,
  },
  tramonto: {
    elevation: 4, azimuth: 248, turbidity: 6, rayleigh: 2.6, mie: 0.007, mieG: 0.92,
    clouds: 0.42, exposure: 0.95, sun: '#ff9a52', sunIntensity: 2.4, ambient: 0.55,
    deep: '#0b2236', shallow: '#3a7389', horizon: '#e6a27a', light: 0.62,
  },
};

const NUM_KEYS = ['elevation', 'azimuth', 'turbidity', 'rayleigh', 'mie', 'mieG', 'clouds', 'exposure', 'sunIntensity', 'ambient', 'light'];
const COL_KEYS = ['sun', 'deep', 'shallow', 'horizon'];

export function lerpPreset(a, b, t) {
  const out = {};
  for (const k of NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of COL_KEYS) out[k] = new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
  return out;
}

export function normalizePreset(p) {
  const out = { ...p };
  for (const k of COL_KEYS) out[k] = new THREE.Color(p[k]);
  return out;
}

export function createSky({ renderer, cubeSize = 256 }) {
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.cloudScale.value = 0.00025;
  u.cloudSpeed.value = 0.00003;
  u.cloudDensity.value = 0.5;
  u.cloudElevation.value = 0.55;

  // Sky-only scene rendered into a cube map: water reflections + PMREM lighting for the boat.
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(10000);
  envSky.material.uniforms = u; // share uniforms
  envScene.add(envSky);

  const cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(1, 20000, cubeRT);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  const sunDir = new THREE.Vector3();

  function apply(p) {
    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mie;
    u.mieDirectionalG.value = p.mieG;
    u.cloudCoverage.value = p.clouds;
    return sunDir;
  }

  function bake({ pmremToo = true } = {}) {
    u.showSunDisc.value = 0;
    cubeCam.update(renderer, envScene);
    u.showSunDisc.value = 1;
    if (pmremToo) {
      const next = pmrem.fromCubemap(cubeRT.texture);
      if (envRT) envRT.dispose();
      envRT = next;
    }
    return envRT ? envRT.texture : null;
  }

  return { sky, apply, bake, sunDir, cubeTexture: cubeRT.texture, uniforms: u };
}
