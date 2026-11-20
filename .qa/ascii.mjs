// ASCII preview: renders orthographic side / front / plan views of a vehicle and
// prints them as characters so geometry can be inspected without image input.
import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const which = process.argv[2] || 'all';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async ({ which }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { RoomEnvironment } = await import('/node_modules/three/examples/jsm/environments/RoomEnvironment.js');
  const mod = await import('/src/entities/vehicleModels.ts');
  const specs = {
    sedan: { id: 'sedan', length: 4.4, width: 1.9, height: 1.45, color: 0x2f6fb5 },
    sport: { id: 'sport', length: 4.3, width: 1.9, height: 1.22, color: 0xd8402c },
    van: { id: 'van', length: 5.2, width: 2.1, height: 2.15, color: 0xe4e2da },
  };
  const W = 150, H = 44;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(0.55, 0.62, 0.42).multiplyScalar(40); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x4b4436, 1.4));
  scene.background = new THREE.Color(0x000000);
  const ramp = ' .,:;irsXA253hMHGS#9B&@';
  const res = {};
  for (const id of (which.startsWith('all') ? Object.keys(specs) : which.replace('wire', '').split(',').filter(Boolean))) {
    const spec = specs[id];
    const mesh = mod.createVehicleMesh(spec);
    scene.add(mesh);
    const views = {
      side: { pos: [0, 0, 12], up: [0,1,0], look: [0, spec.height * 0.45, 0], w: spec.length * 1.15, h: spec.height * 1.25 },
      front: { pos: [12, 0, 0], up: [0,1,0], look: [0, 0, 0], w: spec.width * 1.5, h: spec.height * 2.4 },
      plan: { pos: [0, 12, 0.01], up: [0,0,1], look: [0, 0, 0], w: spec.width * 1.5, h: spec.length * 1.1 },
      iso: { pos: [7, 5, 9], up: [0,1,0], look: [0, spec.height * 0.4, 0], w: spec.length * 1.25, h: spec.length * 1.25 },
    };
    res[id] = {};
    const wire = which.includes('wire');
    mesh.traverse((o) => { if (o.isMesh && o.visible) o.material = new THREE.MeshNormalMaterial({ flatShading: true }); });
    for (const [vn, v] of Object.entries(views)) {
      const cam = new THREE.OrthographicCamera(-v.w/2, v.w/2, v.h/2, -v.h/2, 0.1, 100);
      cam.position.set(...v.pos); cam.up.set(...v.up); cam.lookAt(...v.look);
      renderer.render(scene, cam);
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
      const ctx = c2.getContext('2d'); ctx.drawImage(renderer.domElement, 0, 0);
      const px = ctx.getImageData(0, 0, W, H).data;
      let s = '';
      for (let y = 0; y < H; y++) {
        let line = '';
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const l = (0.2126 * px[i] + 0.7152 * px[i+1] + 0.0722 * px[i+2]) / 255;
          const idx = Math.min(ramp.length - 1, Math.floor(Math.pow(l, 0.8) * (ramp.length - 0.01)));
          line += ramp[idx];
        }
        s += line + '\n';
      }
      res[id][vn] = s;
    }
    scene.remove(mesh); mod.disposeVehicleMesh(mesh);
  }
  return res;
}, { which });
for (const [id, views] of Object.entries(out)) {
  for (const [vn, s] of Object.entries(views)) { console.log(`=== ${id} / ${vn} ===`); console.log(s); }
}
await browser.close();
