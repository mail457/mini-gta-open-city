import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
const sel = process.argv[2] || 'body-paint';
console.log(await page.evaluate(async (sel) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const W = 160, H = 44;
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
  r.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  scene.add(new THREE.DirectionalLight(0xffffff, 2));
  const bb = new THREE.Box3();
  const mesh = mod.createVehicleMesh({ id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x336699 });
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  if (sel === 'all') mesh.traverse(o => { if (o.isMesh) o.visible = true; });
  let box=null;
  mesh.traverse(o => { if (o.isMesh) { if (o.name !== sel) o.visible = false; else { const b = new THREE.Box3().setFromObject(o); box = {min:b.min.toArray(), max:b.max.toArray(), n:o.geometry.attributes.position.count}; } } });
  const dbg = JSON.stringify(box);
  var cam = new THREE.OrthographicCamera(-2.6, 2.6, 0.72, -0.72, 0.1, 100);
  cam.position.set(0, 0.7, 20); cam.lookAt(0, 0.7, 0);
  cam.layers.enableAll(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshBasicMaterial({color:0x00ff00})));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  r.render(scene, cam);
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const ctx = c2.getContext('2d'); ctx.drawImage(r.domElement, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  let s = '';
  const ramp = ' .:-=+*#%@';
  for (let y = 0; y < H; y++) { let line = ''; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4;
    const l = (0.2126 * px[i] + 0.7152 * px[i+1] + 0.0722 * px[i+2]) / 255;
    // background is 0.13 grey → map l<0.2 to space
    line += l < 0.2 ? ' ' : ramp[Math.min(9, Math.floor((l - 0.2) / 0.8 * 9.99))]; } s += line + '\n'; }
  let mx=0, cnt=0; for (let i=0;i<px.length;i+=4){ mx=Math.max(mx,px[i]); if(px[i]>40)cnt++; }
  return dbg + ' maxR=' + mx + ' lit=' + cnt + '\n' + s;
}, sel));
await browser.close();
