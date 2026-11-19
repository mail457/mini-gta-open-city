/**
 * Instanced building windows.
 *
 * One unit-quad InstancedMesh draws every window in the city. A tiny procedural
 * alpha texture gives each window a frame and a lit/dark pane split, and
 * per-instance colours vary the lit windows. Cheaper than one merged quad per
 * window (which is what earlier revisions did: ~30k quads).
 */
import * as THREE from 'three';

export interface WindowSpec {
  /** Building centre + half extents (footprint). */
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
}

const FLOOR_H = 3.6;
const WIN_W = 1.5;
const WIN_H = 1.7;
const GAP = 2.4;

function paneTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#0b1016';
  g.fillRect(0, 0, 32, 32);
  // Pane inset with a brighter glass centre — reads as a window from 20 m+.
  g.fillStyle = '#ffffff';
  g.fillRect(3, 3, 26, 26);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(15, 3, 2, 26);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

export interface WindowMesh {
  mesh: THREE.InstancedMesh;
  count: number;
  dispose(): void;
}

/** Build windows only on the street-facing faces of each building. */
export function createWindows(specs: WindowSpec[], rng: () => number): WindowMesh | null {
  const items: Array<{ x: number; y: number; z: number; ry: number; color: THREE.Color }> = [];
  for (const b of specs) {
    const floors = Math.max(1, Math.floor((b.h - 2) / FLOOR_H));
    const litPalette = [0xffd787, 0xffe9b8, 0xbfe3ff, 0xffc27a];
    const faces: Array<{ ry: number; len: number; ox: number; oz: number; nx: number; nz: number }> = [
      { ry: 0, len: b.hx * 2, ox: 0, oz: b.hz, nx: 0, nz: 1 },
      { ry: Math.PI, len: b.hx * 2, ox: 0, oz: -b.hz, nx: 0, nz: -1 },
      { ry: Math.PI / 2, len: b.hz * 2, ox: b.hx, oz: 0, nx: 1, nz: 0 },
      { ry: -Math.PI / 2, len: b.hz * 2, ox: -b.hx, oz: 0, nx: -1, nz: 0 },
    ];
    for (const f of faces) {
      const cols = Math.max(1, Math.floor((f.len - 1.2) / GAP));
      for (let fl = 0; fl < floors; fl++) {
        const y = 2.2 + fl * FLOOR_H;
        for (let c = 0; c < cols; c++) {
          const along = -f.len / 2 + (f.len - (cols - 1) * GAP) / 2 + c * GAP + GAP / 2 - GAP / 2;
          const lit = rng() < 0.38;
          const col = lit ? new THREE.Color(litPalette[Math.floor(rng() * litPalette.length)]) : new THREE.Color(0x24313d);
          items.push({
            x: b.x + f.ox + (f.ry === 0 || f.ry === Math.PI ? along : 0) + f.nx * 0.06,
            y,
            z: b.z + f.oz + (f.ry === Math.PI / 2 || f.ry === -Math.PI / 2 ? along : 0) + f.nz * 0.06,
            ry: f.ry,
            color: col,
          });
        }
      }
    }
  }
  if (!items.length) return null;

  const geo = new THREE.PlaneGeometry(WIN_W, WIN_H);
  const tex = paneTexture();
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: false,
    roughness: 0.35,
    metalness: 0.15,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.22,
  });
  // Use instance colour for the pane tint.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= 0.25 + 0.75 * vColor.rgb;',
    );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  items.forEach((it, i) => {
    q.setFromAxisAngle(up, it.ry);
    v.set(it.x, it.y, it.z);
    m.compose(v, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, it.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    count: items.length,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex?.dispose();
    },
  };
}
