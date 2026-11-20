// Same painter, but every top-level mesh is painted as a distinct letter so the
// cabin dome, pillars and frame show on top of the body.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const id = process.argv[2] || 'sedan';
const view = process.argv[3] || 'side';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
console.log(await page.evaluate(async ({ id, view }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const specs = { sedan: { length: 4.4, width: 1.9, height: 1.45 }, sport: { length: 4.3, width: 1.9, height: 1.22 }, van: { length: 5.2, width: 2.1, height: 2.15 } };
  const mesh = mod.createVehicleMesh({ id, ...specs[id], color: 0x336699 });
  mesh.updateMatrixWorld(true);
  const W = 156, H = 44;
  const glyph = { 'body-paint': '.', 'cabin-glass': '=', 'cabin-frame': 'k', 'bumper-trim': '#', chrome: 'o', headlights: 'H', taillights: 'T', tyres: 'O', rims: '+', 'exhaust-and-drums': 'x', 'underbody-shadow-only': ' ' };
  const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
  const box = new THREE.Box3();
  mesh.traverse((o) => { if (o.isMesh && o.name !== 'contact-blob') box.expandByObject(o); });
  const size = box.getSize(new THREE.Vector3());
  const [ww, hh] = view === 'side' ? [size.z * 1.04, size.y * 1.2] : view === 'front' ? [size.x * 1.3, size.y * 1.2] : [size.x * 1.3, size.z * 1.04];
  const project = (v) => (view === 'side' ? [v.z, v.y] : view === 'front' ? [v.x, v.y] : [v.x, v.z]);
  const depthOf = (v) => (view === 'side' ? v.x : view === 'front' ? v.z : v.y);
  const toPx = (a, b) => [((a - (view === 'side' ? 0 : 0)) / ww + 0.5) * W, (0.5 - (b - hh * 0.5)) * H];
  const parts = [];
  mesh.traverse((o) => {
    if (!o.isMesh || o.name === 'contact-blob') return;
    const g = o.geometry, p = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : p.count;
    for (let t = 0; t < n; t += 3) {
      const tri = [0, 1, 2].map((k) => { const i = idx ? idx.getX(t + k) : t + k; return new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.matrixWorld); });
      parts.push({ name: o.name, tri });
    }
  });
  parts.sort((a, b) => depthOf(a.tri[0].clone().add(a.tri[1]).add(a.tri[2])) - depthOf(b.tri[0].clone().add(b.tri[1]).add(b.tri[2])));
  for (const part of parts) {
    const xy = part.tri.map((v) => toPx(...project(v.clone())));
    const [a, b, c] = xy;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
      const w1 = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w0 + w1 <= 1 + 1e-6) grid[y][x] = glyph[part.name] ?? '?';
    }
  }
  return grid.map((r) => r.join('')).join('\n') + `\nbox y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)} x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}`;
}, { id, view }));
await browser.close();
