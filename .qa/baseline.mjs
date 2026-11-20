import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto('http://127.0.0.1:5173/blank-qa', { waitUntil: 'domcontentloaded' });
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
    let meshes = 0, tris = 0;
    mesh.traverse(o => { if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    const box = new THREE.Box3().setFromObject(mesh);
    res[k] = { meshes, tris, min: box.min.toArray().map(v=>+v.toFixed(2)), max: box.max.toArray().map(v=>+v.toFixed(2)) };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
