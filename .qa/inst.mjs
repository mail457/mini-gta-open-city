import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
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
  const rows = [];
  mesh.traverse(o => { if (o.isMesh) { const g = o.geometry; rows.push([o.name, o.type, o.isInstancedMesh ? o.count : 1, g.index ? g.index.count : g.attributes.position.count]); } });
  return rows;
})));
await browser.close();
