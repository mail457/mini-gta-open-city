import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { ConvexGeometry } = await import('/node_modules/three/examples/jsm/geometries/ConvexGeometry.js');
  const pts = [];
  for (const y of [-1, 1]) { pts.push(new THREE.Vector3(0, y, 0)); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), y, Math.sin(a))); } }
  const g = new ConvexGeometry(pts);
  const mod = await import('/src/entities/vehicleModels.ts');
  const mesh = mod.createVehicleMesh({ id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x336699 });
  const rows = [];
  mesh.traverse(o => { if (o.isMesh) { const gg = o.geometry; rows.push([o.name, gg.index ? gg.index.count / 3 : gg.attributes.position.count / 3]); } });
  return { convexTris: g.attributes.position.count / 3, convexIndexed: !!g.index, rows };
});
console.log(JSON.stringify(out));
await browser.close();
