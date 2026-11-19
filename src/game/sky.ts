import * as THREE from 'three';

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

  // --- Gradient sky dome (vertex colours, single draw call) ---------------
  const skyGeo = new THREE.SphereGeometry(450, 24, 16);
  const colors: number[] = [];
  const top = new THREE.Color(0x2f6fb5);
  const horizon = new THREE.Color(0xf4c98a);
  const pos = skyGeo.attributes.position;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 450; // -1..1
    const t = Math.pow(Math.max(0, y), 0.55);
    c.copy(horizon).lerp(top, t);
    colors.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const skyMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1000;
  sky.name = 'skyDome';
  group.add(sky);

  // --- Sun ----------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6);
  sun.position.set(90, 120, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 420;
  const s = 95;
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  cam.left = -s;
  cam.right = s;
  cam.top = s;
  cam.bottom = -s;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  sun.target.position.set(0, 0, 0);
  scene.add(sun.target);
  group.add(sun);
  group.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.15);
  group.add(hemi);

  scene.add(group);
  scene.background = new THREE.Color(0x9ab9d9);
  scene.fog = new THREE.Fog(0xbcc9d6, 120, 330);

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
      skyGeo.dispose();
      skyMat.dispose();
    },
  };
}
