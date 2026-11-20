// QA harness: renders each vehicle type alone on a neutral background, writes
// PNGs + prints luminance/brightness numbers per model.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || '/Users/axel/code/mini-gta/.qa/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') {
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  }
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { RoomEnvironment } = await import('/node_modules/three/examples/jsm/environments/RoomEnvironment.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const specs = {
    sedan: { id: 'sedan', label: 'Sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x2f6fb5 },
    sport: { id: 'sport', label: 'Sport', length: 4.3, width: 1.9, height: 1.22, color: 0xd8402c },
    van: { id: 'van', label: 'Van', length: 5.2, width: 2.1, height: 2.15, color: 0xe4e2da },
  };
  const SIZE = 480;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
  } catch {}
  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6);
  sun.position.set(0.55, 0.62, 0.42).normalize().multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 140;
  const sc = sun.shadow.camera; sc.left = -8; sc.right = 8; sc.top = 8; sc.bottom = -8;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.15));

  const out = {};
  const views = { hero: [6.2, 3.0, 8.0], side: [0.01, 1.2, 9.5], front34: [5.5, 1.4, 6.5], rear34: [-5.0, 2.2, -6.8] };
  for (const [id, spec] of Object.entries(specs)) {
    const mesh = mod.createVehicleMesh(spec);
    scene.add(mesh);
    // stats
    let meshes = 0, tris = 0, shadowCasters = 0;
    mesh.traverse(o => { if (o.isMesh) { meshes++; if (o.castShadow) shadowCasters++;
      const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    // Bounding box of the CAR only (the contact blob is a ground decal).
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const c of mesh.children) {
      if (c.name === 'contact-blob') continue;
      box.expandByObject(c);
    }
    const size = box.getSize(new THREE.Vector3());
    const data = mod.getVehicleMeshData(mesh);
    out[id] = {
      meshes, tris, shadowCasters,
      bbox: { min: box.min.toArray().map(v=>+v.toFixed(3)), max: box.max.toArray().map(v=>+v.toFixed(3)) },
      size: size.toArray().map(v=>+v.toFixed(3)),
      sizeVsSpec: { length: +(size.z / spec.length).toFixed(3), width: +(size.x / spec.width).toFixed(3), height: +(size.y / spec.height).toFixed(3) },
      widthWithoutMirrorsPct: +(((size.x - 0.22) / spec.width) * 100).toFixed(1),
      widthWithoutMirrorsPct: +(((size.x - 2 * 0.11) / spec.width) * 100).toFixed(1),
      wheels: data.wheels.length, frontSteer: data.wheels.filter(w => w.front).length,
    };
    for (const [viewName, pos] of Object.entries(views)) {
      // Neutral studio: mid-grey backdrop, no car-coloured content.
      scene.background = new THREE.Color(0x808080);
      const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
      cam.position.set(pos[0], pos[1], pos[2]);
      cam.lookAt(0, spec.height * 0.42, 0);
      renderer.render(scene, cam);
      const url = renderer.domElement.toDataURL('image/png');
      // pixels via 2D canvas for luminance
      const c2 = document.createElement('canvas'); c2.width = SIZE; c2.height = SIZE;
      const ctx = c2.getContext('2d'); ctx.drawImage(renderer.domElement, 0, 0);
      const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
      let sum = 0, sumBg = 0, nCar = 0, nBg = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i+1], b = px[i+2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += l;
        // neutral bg is 0x808080 (±2 after tone mapping); anything else is car/shadow
        if (Math.abs(r - g) > 4 || Math.abs(g - b) > 4 || l < 112 || l > 146) { sumBg += l; nCar++; } else nBg++;
      }
      const total = SIZE * SIZE;
      (out[id].views ||= {})[viewName] = {
        meanLuminance: +(sum / total).toFixed(2),
        carPixelLuminance: nCar ? +(sumBg / nCar).toFixed(2) : null,
        coverage: +(nCar / total).toFixed(3),
      };
      out[id].views[viewName].png = url;
      // Front/rear 3/4 coverage = how much of the frame the car fills (readability proxy).
      out[id].views[viewName].coveragePct = +(nCar / total * 100).toFixed(2);
    }
    scene.remove(mesh);
    mod.disposeVehicleMesh(mesh);
  }
  return out;
});

const summary = {};
for (const [id, v] of Object.entries(result)) {
  summary[id] = { meshes: v.meshes, tris: v.tris, shadowCasters: v.shadowCasters, bbox: v.bbox, size: v.size, sizeVsSpec: v.sizeVsSpec, widthWithoutMirrorsPct: v.widthWithoutMirrorsPct, wheels: v.wheels, frontSteer: v.frontSteer, views: {} };
  for (const [vn, view] of Object.entries(v.views)) {
    const file = `${OUT}/${id}-${vn}.png`;
    writeFileSync(file, Buffer.from(view.png.split(',')[1], 'base64'));
    summary[id].views[vn] = { meanLuminance: view.meanLuminance, carPixelLuminance: view.carPixelLuminance, coverage: view.coverage, screenshot: file };
  }
}
console.log(JSON.stringify(summary, null, 2));
await browser.close();
