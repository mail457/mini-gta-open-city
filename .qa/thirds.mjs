// Third-person framing metric: car size on screen from typical chase cams.
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
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.6;
  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6); sun.position.set(0.55, 0.62, 0.42); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.15));
  scene.background = new THREE.Color(0x808080);
  const res = {};
  for (const id of ['sedan', 'sport', 'van']) {
    const spec = { id, length: 4.4, width: 1.9, height: id === 'van' ? 2.15 : id === 'sport' ? 1.22 : 1.45, color: id === 'van' ? 0xe4e2da : id === 'sport' ? 0xd8402c : 0x2f6fb5 };
    const mesh = mod.createVehicleMesh(spec); scene.add(mesh);
    // chase cam (behind car, which faces +Z): cam at (0, 2.6, -7) looking at (0, 1, 0.5)
    const cam = new THREE.PerspectiveCamera(62, W / H, 0.1, 200);
    cam.position.set(0, 3.2, 6.5); cam.lookAt(0, 0.9, 0);
    r.render(scene, cam);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const ctx = c2.getContext('2d'); ctx.drawImage(r.domElement, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      sum += l; n++;
      if (Math.abs(R - G) > 4 || Math.abs(G - B) > 4) n; // colour pixels = the car
    }
    // measure colour-car pixels for saturation contrast
    let car = 0; const hist = new Array(8).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      const l = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      hist[Math.min(7, Math.floor(l * 8))]++;
      if (Math.max(R, G, B) - Math.min(R, G, B) > 12) car++;
    }
    res[id] = { meanLuminance: +(sum / n).toFixed(2), carPixelsPct: +((car / n) * 100).toFixed(2), luminanceHistogramPct: hist.map(h => +((h / n) * 100).toFixed(1)) };
    scene.remove(mesh); mod.disposeVehicleMesh(mesh);
  }
  return res;
})));
await browser.close();
