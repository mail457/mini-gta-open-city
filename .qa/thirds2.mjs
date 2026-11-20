// Chase-camera readability: car coverage, contrast and luminance per type.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
console.log(JSON.stringify(await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { RoomEnvironment } = await import('/node_modules/three/examples/jsm/environments/RoomEnvironment.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const W = 320, H = 240;
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
  r.setSize(W, H, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.6;
  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6); sun.position.set(0.55, 0.62, 0.42); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.15));
  // Typical chase camera (behind + above the car); car nose faces +Z.
  const cam = new THREE.PerspectiveCamera(62, W / H, 0.1, 200);
  cam.position.set(2.4, 3.4, 7.2); cam.lookAt(0, 0.9, 0);
  const res = {};
  for (const [id, spec] of Object.entries({
    sedan: { length: 4.4, width: 1.9, height: 1.45, color: 0x2f6fb5 },
    sport: { length: 4.3, width: 1.9, height: 1.22, color: 0xd8402c },
    van: { length: 5.2, width: 2.1, height: 2.15, color: 0xe4e2da },
  })) {
    const mesh = mod.createVehicleMesh({ id, ...spec }); scene.add(mesh);
    scene.background = new THREE.Color(0x6f8aa0); // hazy street-like backdrop
    r.render(scene, cam);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const ctx = c2.getContext('2d'); ctx.drawImage(r.domElement, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    const bg = [0x6f, 0x8a, 0xa0];
    let car = 0, lum = 0, lumCar = 0, sat = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      lum += l;
      const diff = Math.abs(R - bg[0]) + Math.abs(G - bg[1]) + Math.abs(B - bg[2]);
      if (diff > 14) { car++; lumCar += l; }
      sat += Math.max(R, G, B) - Math.min(R, G, B);
    }
    const n = W * H;
    res[id] = {
      coveragePct: +((car / n) * 100).toFixed(2),
      meanLuminance: +(lum / n).toFixed(1),
      carLuminance: +(lumCar / Math.max(car, 1)).toFixed(1),
      contrastVsBg: +(Math.abs(lumCar / Math.max(car, 1) - 119)).toFixed(1),
      meanSaturation: +(sat / n).toFixed(1),
    };
    scene.remove(mesh); mod.disposeVehicleMesh(mesh);
  }
  return res;
})));
await browser.close();
