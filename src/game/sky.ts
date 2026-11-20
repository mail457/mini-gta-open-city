import * as THREE from 'three';
import { createSkyDome, SKY_HORIZON, SUN_DIR } from '../core/postfx';

/**
 * Sky dome, sun (directional light + shadows) and aerial fog.
 * Lead-owned. Warm late-afternoon palette to match the low-poly city.
 */
export interface SkyRig {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  update(dt: number): void;
  dispose(): void;
}

export function createSky(scene: THREE.Scene): SkyRig {
  const group = new THREE.Group();
  group.name = 'sky';

  // --- Shader sky dome (sun disk, haze, gradient) ---
  const sky = createSkyDome(480);
  group.add(sky);

  // --- Sun ----------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6);
  // Sun direction matches the sky shader's sun disk and the environment map.
  sun.position.copy(SUN_DIR).multiplyScalar(150);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 420;
  const s = 95;
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  cam.left = -s;
  cam.right = s;
  cam.top = s;
  cam.bottom = -s;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  sun.target.position.set(0, 0, 0);
  scene.add(sun.target);
  group.add(sun);
  group.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.15);
  group.add(hemi);

  scene.add(group);
  scene.background = new THREE.Color(SKY_HORIZON);
  // Aerial perspective: haze that warms toward the horizon colour.
  scene.fog = new THREE.FogExp2(new THREE.Color(SKY_HORIZON).lerp(new THREE.Color(0xbcc9d6), 0.55).getHex(), 0.0038);

  const sunBase = sun.position.clone();
  let t = 0;
  return {
    group,
    sun,
    update(dt: number) {
      // Keep shadow frustum following the action (targets set by game each frame).
      t += dt;
      // Gentle light-colour shimmer so the city doesn't feel static.
      const k = 0.97 + Math.sin(t * 0.3) * 0.03;
      sun.intensity = 2.6 * k;
      sun.position.copy(sunBase).add(sun.target.position);
    },
    dispose() {
      scene.remove(group);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
    },
  };
}
