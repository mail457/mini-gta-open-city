// Orthographic silhouette sheet: every mesh of one car, projected and rasterised
// with a 2D painter (woo: no GPU state to get wrong), printed as ASCII.
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

const out = await page.evaluate(async ({ id, view }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const specs = {
    sedan: { length: 4.4, width: 1.9, height: 1.45 },
    sport: { length: 4.3, width: 1.9, height: 1.22 },
    van: { length: 5.2, width: 2.1, height: 2.15 },
  };
  const mesh = mod.createVehicleMesh({ id, ...specs[id], color: 0x336699 });
  mesh.updateMatrixWorld(true);
  const W = 156, H = 40;
  // ASCII painter: later meshes overwrite earlier ones; colour by material class.
  const glyph = { 'body-paint': '@', 'cabin-glass': '=', 'cabin-frame': '|', 'bumper-trim': '#', chrome: 'o', headlights: 'H', taillights: 'T', tyres: 'O', rims: '+', 'exhaust-and-drums': 'x', 'underbody-shadow-only': '.', 'contact-blob': ' ' };
  const grid = Array.from({ length: H }, () => new Array(W).fill(' '));
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const [ww, hh] = view === 'side' ? [size.z * 1.06, size.y * 1.3] : view === 'front' ? [size.x * 1.35, size.y * 1.3] : [size.x * 1.35, size.z * 1.06];
  const toPx = (a, b) => [(a / ww + 0.5) * W, (0.5 - b / hh - 0.06) * H];
  const project = (v) => (view === 'side' ? [v.z, v.y - 0.1] : view === 'front' ? [v.x, v.y - 0.1] : [v.x, v.z]);
  // depth key: larger = nearer to the viewer
  const depthOf = (v) => (view === 'side' ? v.x : view === 'front' ? v.z : v.y);
  const parts = [];
  mesh.traverse((o) => {
    if (!o.isMesh || o.name === 'contact-blob') return;
    const g = o.geometry;
    const p = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    const v = new THREE.Vector3();
    for (let t = 0; t < n; t += 3) {
      const tri = [0, 1, 2].map((k) => {
        const i = idx ? idx.getX(t + k) : t + k;
        return new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.matrixWorld);
      });
      parts.push({ name: o.name, tri });
    }
  });
  // painter's algorithm on average depth
  parts.sort((a, b) => depthOf(a.tri[0].clone().add(a.tri[1]).add(a.tri[2])) - depthOf(b.tri[0].clone().add(b.tri[1]).add(b.tri[2])));
  for (const part of parts) {
    const pts = part.tri.map((v) => project(v.clone()));
    if (view === 'side') { /* +Z nose should be on the right */ }
    const xy = pts.map(([a, b]) => toPx(a, b));
    const minX = Math.max(0, Math.floor(Math.min(...xy.map((q) => q[0]))));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(...xy.map((q) => q[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...xy.map((q) => q[1]))));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(...xy.map((q) => q[1]))));
    const [a, b, c] = xy;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
        const w1 = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w0 + w1 <= 1 + 1e-6) grid[y][x] = glyph[part.name] ?? '?';
      }
    }
  }
  return grid.map((r) => r.join('')).join('\n');
}, { id, view });

console.log(out);
await browser.close();
