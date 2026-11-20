// Task: emit a compact build plan (for verification the numbers must add up).
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const mesh = mod.createVehicleMesh({ id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x336699 });
  const res = [];
  mesh.traverse(o => {
    if (o.isMesh) {
      let posCount = o.geometry.attributes.position.count;
      res.push({ name: o.name, type: o.type, count: o.count ?? null, pos: posCount, instanced: !!o.isInstancedMesh,
        instanceMatrices: o.isInstancedMesh ? Array.from(o.instanceMatrix.array).map(v => +v.toFixed(2)).slice(-16) : null });
    }
  });
  return { res, version: THREE.REVISION };
});
console.log(JSON.stringify(out));
await browser.close();
