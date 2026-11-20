import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
console.log(JSON.stringify(await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const mesh = mod.createVehicleMesh({ id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x336699 });
  mesh.updateMatrixWorld(true);
  const rows = [];
  for (const c of mesh.children) {
    const b = new THREE.Box3().expandByObject(c);
    rows.push([c.name, c.children.map(k => k.name).join(','), b.min.toArray().map(v => +v.toFixed(2)), b.max.toArray().map(v => +v.toFixed(2))]);
  }
  const bodyParts = [];
  mesh.getObjectByName('body').children.forEach(c => { const b = new THREE.Box3().setFromBufferAttribute(c.geometry.attributes.position); bodyParts.push([c.name, b.min.toArray().map(v=>+v.toFixed(2)), b.max.toArray().map(v=>+v.toFixed(2))]); });
  const paint = mesh.getObjectByName('body-paint');
  const pb = new THREE.Box3().setFromBufferAttribute(paint.geometry.attributes.position);
  return { bodyParts, parts: rows, paintLocal: [pb.min.toArray().map(v=>+v.toFixed(2)), pb.max.toArray().map(v=>+v.toFixed(2))], paintMatrix: paint.matrixWorld.elements.map(v=>+v.toFixed(3)) };
})));
await browser.close();
