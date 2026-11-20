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
  const out = {};
  for (const [id, len, wid, hgt] of [['sedan',4.4,1.9,1.45],['sport',4.3,1.9,1.22],['van',5.2,2.1,2.15]]) {
    const mesh = mod.createVehicleMesh({ id, length: len, width: wid, height: hgt, color: 0x336699 });
    const maxY = {};
    mesh.getObjectByName('body').children.forEach(c => { const a = c.geometry.attributes.position; let m = -9; for (let i=0;i<a.count;i++) m = Math.max(m, a.getY(i)); maxY[c.name] = +m.toFixed(3); });
    out[id] = maxY;
  }
  return out;
})));
await browser.close();
