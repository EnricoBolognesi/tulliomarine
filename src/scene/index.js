import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createOcean, waterHeight } from './ocean.js';
import { createSpray } from './spray.js';
import { createCoast } from './coast.js';
import { createSky, PRESETS, lerpPreset, normalizePreset } from './sky.js';
import { createBoat } from './boat.js';

const BOAT_SPEED = 4.2; // m/s ≈ 8 knots, relaxed cruise

const yieldToMain = () =>
  globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0));

function qualityTier() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 8;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const low = coarse || cores <= 4 || small;
  return low
    ? { name: 'low', segments: 170, maxDpr: 1.5, shadows: false, cube: 128, fragIters: 14 }
    : { name: 'high', segments: 300, maxDpr: 2, shadows: true, cube: 256, fragIters: 24 };
}

export async function startScene({ container, hero, initial = 'giorno' }) {
  // Dev-only timing of the start-up phases (read with performance.getEntriesByType('measure')).
  let _t = performance.now();
  const phase = (name) => {
    const now = performance.now();
    if (import.meta.env.DEV) performance.measure('hero:' + name, { start: _t, end: now });
    _t = now;
  };
  const tier = qualityTier();
  const renderer = new THREE.WebGLRenderer({
    antialias: tier.name === 'high',
    powerPreference: 'high-performance',
    preserveDrawingBuffer: import.meta.env.DEV, // lets dev tooling grab a poster frame
  });
  let dpr = Math.min(window.devicePixelRatio || 1, tier.maxDpr);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = tier.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 12000);

  // Setup is split into short tasks so it never blocks input for long.
  await yieldToMain();
  const sky = createSky({ renderer, cubeSize: tier.cube });
  scene.add(sky.sky);
  phase('sky');

  await yieldToMain();
  const ocean = createOcean({ segments: tier.segments, envMap: sky.cubeTexture, fragIters: tier.fragIters });
  ocean.uniforms.uSpeed.value = 0.8;
  scene.add(ocean.mesh);
  phase('ocean');
  const coast = createCoast({ envMap: sky.cubeTexture, segments: tier.name === 'high' ? 220 : 120 });
  scene.add(coast.mesh);
  const spray = createSpray({ count: tier.name === 'high' ? 2200 : 800 });
  scene.add(spray.points);

  await yieldToMain();
  phase('coast+spray');
  const boat = await createBoat();
  phase('boat-load');
  const boatRoot = new THREE.Group();
  boatRoot.add(boat);
  scene.add(boatRoot);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = tier.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -7.5, right: 7.5, top: 7.5, bottom: -7.5, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // ---------- time of day ----------
  let current = normalizePreset(PRESETS[initial]);
  let tween = null;

  function applyPreset(p, { pmrem = true } = {}) {
    const dir = sky.apply(p);
    renderer.toneMappingExposure = p.exposure;
    sun.color.copy(p.sun);
    sun.intensity = p.sunIntensity;
    const env = sky.bake({ pmremToo: pmrem });
    if (env) scene.environment = env;
    scene.environmentIntensity = p.ambient;
    const u = ocean.uniforms;
    u.uSunDir.value.copy(dir);
    u.uSunColor.value.copy(p.sun).multiplyScalar(p.sunIntensity * 0.5);
    u.uDeep.value.copy(p.deep);
    u.uShallow.value.copy(p.shallow);
    u.uHorizon.value.copy(p.horizon).multiplyScalar(p.light * 0.9 + 0.1);
    u.uLight.value = p.light;
    spray.uniforms.uLight.value = p.light;
    coast.uniforms.uSunDir.value.copy(dir);
    coast.uniforms.uSunColor.value.copy(p.sun).multiplyScalar(p.sunIntensity * 0.5);
    coast.uniforms.uLight.value = p.light;
  }
  await yieldToMain();
  phase('lights');
  // Two short tasks instead of one long one: sky cube first, then the filtered environment.
  applyPreset(current, { pmrem: false });
  phase('preset');
  await yieldToMain();
  scene.environment = sky.bake({ pmremToo: true });
  phase('env');
  await yieldToMain();

  function setTimeOfDay(name) {
    const target = PRESETS[name];
    if (!target) return;
    tween = { from: current, to: normalizePreset(target), t: 0, frame: 0 };
  }

  // ---------- camera + controls ----------
  camera.position.set(11, 2.3, 10.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.1, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45;
  controls.minPolarAngle = THREE.MathUtils.degToRad(73);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
  controls.autoRotate = true;
  controls.autoRotateSpeed = -0.35;
  controls.update();
  // OrbitControls sets touch-action:none; restore vertical page scrolling on touch screens.
  renderer.domElement.style.touchAction = 'pan-y';

  let resumeTimer = 0;
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
  });
  controls.addEventListener('end', () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => (controls.autoRotate = true), 6000);
  });

  // ---------- sizing / framing ----------
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Frame the boat right of the headline on wide screens, above it on tall ones.
    const wide = w / h > 1.1;
    if (wide) {
      camera.setViewOffset(w, h, -w * 0.19, h * 0.09, w, h);
      camera.fov = 30;
    } else {
      camera.setViewOffset(w, h, 0, h * 0.24, w, h);
      camera.fov = 40;
    }
    camera.updateProjectionMatrix();
    // Keep the whole boat (~11 m with engines) across the frame on narrow screens.
    const halfH = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfW = Math.atan(Math.tan(halfH) * camera.aspect);
    const dist = Math.max(15.5, (wide ? 7.4 : 6.4) / Math.tan(halfW));
    camera.position.sub(controls.target).setLength(dist).add(controls.target);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---------- boat motion ----------
  let travel = 0;
  const state = { y: 0.1, pitch: 0, roll: 0 };
  function updateBoat(time, dt) {
    const hb = waterHeight(3.4, 0, time, travel);
    const hs = waterHeight(-4.2, 0, time, travel);
    const hp = waterHeight(-0.5, -1.3, time, travel);
    const hsb = waterHeight(-0.5, 1.3, time, travel);
    const targetY = (hb + hs + hp + hsb) * 0.2 + 0.12;
    const targetPitch = Math.atan2(hb - hs, 7.6) * 0.8 + THREE.MathUtils.degToRad(2.2);
    const targetRoll = Math.atan2(hp - hsb, 2.6) * 0.7;
    const k = 1 - Math.exp(-dt * 2.2);
    state.y += (targetY - state.y) * k;
    state.pitch += (targetPitch - state.pitch) * k;
    state.roll += (targetRoll - state.roll) * k;
    boatRoot.position.y = state.y;
    boatRoot.rotation.set(state.roll, 0, state.pitch);
    controls.target.y = 1.1 + state.y * 0.5;
  }

  // ---------- loop ----------
  let last = performance.now();
  let elapsed = 0;
  let frames = 0;
  let frameAccum = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;
    travel += BOAT_SPEED * dt;

    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.6);
      tween.frame++;
      const e = tween.t * tween.t * (3 - 2 * tween.t);
      current = lerpPreset(tween.from, tween.to, e);
      const done = tween.t >= 1;
      applyPreset(current, { pmrem: done || tween.frame % 3 === 0 });
      if (done) tween = null;
    }

    sky.uniforms.time.value = elapsed;
    ocean.uniforms.uTime.value = elapsed;
    spray.uniforms.uTime.value = elapsed;
    spray.points.position.y = boatRoot.position.y * 0.6;
    ocean.uniforms.uTravel.value = travel;
    updateBoat(elapsed, dt);

    sun.position.copy(sky.sunDir).multiplyScalar(30).add(boatRoot.position);
    sun.target.position.copy(boatRoot.position);

    controls.update(dt);
    renderer.render(scene, camera);

    // Adaptive resolution: back off when frames run long.
    frames++;
    frameAccum += dt;
    if (frameAccum > 2) {
      const avg = frameAccum / frames;
      if (avg > 1 / 40 && dpr > 0.8) {
        dpr = Math.max(0.8, dpr - 0.25);
        renderer.setPixelRatio(dpr);
        resize();
      }
      frames = 0;
      frameAccum = 0;
    }
  }

  // ---------- run only when visible ----------
  let inView = true;
  let running = false;
  function sync() {
    const should = inView && document.visibilityState === 'visible';
    if (should === running) return;
    running = should;
    last = performance.now();
    renderer.setAnimationLoop(running ? frame : null);
  }
  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  });
  io.observe(hero);
  document.addEventListener('visibilitychange', sync);

  // Compile shaders off the critical path, then show.
  phase('controls');
  await renderer.compileAsync(scene, camera);
  phase('compile');
  await yieldToMain();
  updateBoat(0, 1);
  renderer.render(scene, camera);
  sync();

  const api = {
    setTimeOfDay,
    renderer,
    dispose() {
      renderer.setAnimationLoop(null);
      io.disconnect();
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
  if (import.meta.env.DEV) window.__hero = { ...api, scene, camera, controls, tier, sky, applyPreset, PRESETS };
  return api;
}
