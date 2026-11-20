// Front cross-section: sample the body-paint mesh's silhouette at several Z.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
const id = process.argv[2] || 'sedan';
console.log(JSON.stringify(await page.evaluate(async (id) => {
  const mod = await import('/src/entities/vehicleModels.ts');
  const mesh = mod.createVehicleMesh({ id, length: 4.4, width: 1.9, height: id === 'van' ? 2.15 : id === 'sport' ? 1.22 : 1.45, color: 0x336699 });
  const out = {};
  mesh.traverse(o => {
    if (!o.isMesh || !['body-paint', 'bumper-trim', 'tyres'].includes(o.name)) return;
    const p = o.geometry.attributes.position;
    const zs = [0.0, 0.5, 1.0, 1.5];
    out[o.name] = zs.map(z => {
      let maxX = 0, minY = 99, maxY = -99, n = 0;
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getZ(i) - z) < 0.06) { maxX = Math.max(maxX, p.getX(i)); minY = Math.min(minY, p.getY(i)); maxY = Math.max(maxY, p.getY(i)); n++; }
      }
      return { z, halfWidth: +maxX.toFixed(3), yMin: +minY.toFixed(3), yMax: +maxY.toFixed(3), n };
    });
  });
  return out;
}, id)));
await browser.close();
