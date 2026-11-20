// Per-material-bucket polygon counts (to find the heavy parts).
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
  const mod = await import('/src/entities/vehicleModels.ts');
  const res = {};
  for (const id of ['sedan', 'sport', 'van']) {
    const mesh = mod.createVehicleMesh({ id, length: 4.4, width: 1.9, height: id === 'van' ? 2.15 : id === 'sport' ? 1.22 : 1.45, color: 0x336699 });
    res[id] = [];
    mesh.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry; const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      res[id].push([o.name, tris * (o.isInstancedMesh ? o.count : 1)]);
    });
  }
  return res;
});
for (const [id, rows] of Object.entries(out)) console.log(id.padEnd(6), rows.map(r => `${r[0]}=${r[1]}`).join('  '));
await browser.close();
