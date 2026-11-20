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
  const mod = await import('/src/entities/vehicleModels.ts');
  const W = 320, H = 240;
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
  r.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(new THREE.AmbientLight(0xffffff, 3));
  const out = {};
  for (const id of ['sedan', 'van']) {
    const mesh = mod.createVehicleMesh({ id, length: id === 'van' ? 5.2 : 4.4, width: id === 'van' ? 2.1 : 1.9, height: id === 'van' ? 2.15 : 1.45, color: 0xff0000 });
    scene.add(mesh);
    const cam = new THREE.PerspectiveCamera(62, W / H, 0.1, 200);
    cam.position.set(0, 3.2, 6.5); cam.lookAt(0, 0.9, 0);
    r.render(scene, cam);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    c2.getContext('2d').drawImage(r.domElement, 0, 0);
    const px = c2.getContext('2d').getImageData(0, 0, W, H).data;
    let any = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 4) any++;
    out[id] = { litPixelsPct: +((any / (W*H)) * 100).toFixed(2) };
    scene.remove(mesh); mod.disposeVehicleMesh(mesh);
  }
  return out;
})));
await browser.close();
