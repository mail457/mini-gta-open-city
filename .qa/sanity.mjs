import { chromium } from '/Users/axel/code/mini-gta/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/qa-blank.html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/qa-blank.html', { waitUntil: 'domcontentloaded' });
console.log(await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
  r.setSize(64, 64, false);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({ color: 0xff0000 })));
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100); cam.position.set(0,0,3); cam.lookAt(0,0,0);
  r.render(scene, cam);
  const c2 = document.createElement('canvas'); c2.width = 64; c2.height = 64;
  const ctx = c2.getContext('2d'); ctx.drawImage(r.domElement, 0, 0);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  let lit = 0; for (let i = 0; i < px.length; i += 4) if (px[i] > 100) lit++;
  return 'basic box lit pixels: ' + lit;
}));
await browser.close();
