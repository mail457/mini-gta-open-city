// One-shot QA: mesh count / triangles / bbox per car type on a stub page.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const BASE = process.env.QA_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto(BASE + '/qa-blank.html', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const specs = {
    sedan: { id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x2f6fb5 },
    sport: { id: 'sport', length: 4.3, width: 1.9, height: 1.22, color: 0xd8402c },
    van: { id: 'van', length: 5.2, width: 2.1, height: 2.15, color: 0xe4e2da },
  };
  const res = {};
  for (const [k, s] of Object.entries(specs)) {
    const mesh = mod.createVehicleMesh(s);
    let meshes = 0, tris = 0, casters = 0, receivers = 0;
    mesh.traverse(o => { if (o.isMesh) { meshes++; if (o.castShadow) casters++; if (o.receiveShadow) receivers++;
      const g = o.geometry; const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
      tris += t * (o.isInstancedMesh ? o.count : 1); } });
    // bbox of the CAR only (the contact blob is a ground decal, not part of it)
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3();
    mesh.traverse(o => {
      if (!o.isMesh) return;
      if (o.parent === mesh && o.name === 'contact-blob') return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      box.union(b);
    });
    const size = box.getSize(new THREE.Vector3());
    res[k] = { meshes, tris, casters, receivers,
      sizeVsSpec: { L: +(size.z / s.length).toFixed(3), W: +(size.x / s.width).toFixed(3), H: +(size.y / s.height).toFixed(3) },
      bbox: { min: box.min.toArray().map(v => +v.toFixed(2)), max: box.max.toArray().map(v => +v.toFixed(2)) } };
    mod.disposeVehicleMesh(mesh);
  }
  return res;
});
console.log(JSON.stringify(out));
await browser.close();
