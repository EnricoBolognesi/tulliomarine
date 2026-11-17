import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/*
 * The boat is modelled in Blender by tools/blender/build_boat.py and exported to
 * public/models/sauvage34.glb (Draco-compressed, ambient occlusion in vertex colours).
 *
 * Contract: metres, origin at the static waterline amidships, +X = bow, +Y = up.
 * If the model cannot be loaded, the older code-built boat is used instead.
 */
const MODEL_URL = '/models/sauvage34.glb';

export async function createBoat() {
  try {
    const draco = new DRACOLoader().setDecoderPath('/draco/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(MODEL_URL);
    draco.dispose();
    const boat = gltf.scene;
    boat.name = 'SauvageSpider34';
    boat.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = !o.material.transparent;
      o.receiveShadow = true;
      // Deck and fabric textures are seen at grazing angles: keep them sharp.
      for (const key of ['map', 'normalMap']) {
        if (o.material[key]) o.material[key].anisotropy = 8;
      }
    });
    return boat;
  } catch (err) {
    console.warn('[hero] boat model failed to load, using the code-built fallback:', err);
    const { createBoat: createProcedural } = await import('./boat-procedural.js');
    return createProcedural();
  }
}
