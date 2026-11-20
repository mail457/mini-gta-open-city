/**
 * Runtime model library (Lead-owned).
 *
 * Models are glTF/GLB files bundled locally in public/models (no runtime network
 * calls). Two sources are used:
 *  - Kenney's "City Builder" starter kit (CC0) for buildings and props. Those files
 *    reference one shared palette atlas; we bake each part's atlas tile into a tiny
 *    single-tile glTF, so every material is a clean textured PBR surface with no
 *    texture bleeding, matched by name to the model's own one-cell quads.
 *  - A rigged, animated humanoid (three.js' Soldier example asset) for pedestrians
 *    and the player avatar — real skinning and walk/run/idle animation clips.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Modern indoor-style environment used for subtle realistic reflections. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return env;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function loadGLB(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url);
    cache.set(url, p);
  }
  return p;
}

export interface Variant {
  url: string;
  /** Atlas quads referenced by the variant, in the order they appear. */
  atlas: Array<[number, number]>;
  /** Target size in metres (width, height, depth). */
  size: [number, number, number];
}

/**
 * Replace every material in `root` by the atlas tile it references.
 * The source tiles are tiny quads that must have been exported next to the model
 * as `atlas_room_city_02/quad_16x16/colormap_<x>_<y>.glb`.
 */
export async function applyAtlasMaterials(root: THREE.Object3D, size = 16): Promise<void> {
  const tiles = new Map<string, THREE.Material>();
  const jobs: Array<Promise<void>> = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const uvs = mesh.geometry.getAttribute('uv');
    if (!uvs) return;
    // Tile index from the quad's UV centroid.
    const vals = uvs.array as ArrayLike<number>;
    let u = 0;
    let v = 0;
    for (let i = 0; i < vals.length; i += 2) {
      u += vals[i];
      v += vals[i + 1];
    }
    const n = vals.length / 2;
    u /= n;
    v /= n;
    const tx = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    const ty = Math.min(size - 1, Math.max(0, Math.floor((1 - v) * size)));
    const key = `${tx}_${ty}`;
    jobs.push(
      (async () => {
        const mat = tiles.get(key);
        if (mat) {
          mesh.material = mat;
          return;
        }
        try {
          const g = await loadGLB(`models/atlas_room_city_02/quad_${size}x${size}/colormap_${tx}_${ty}.glb`);
          let found: THREE.Material | null = null;
          g.scene.traverse((c) => {
            const m = c as THREE.Mesh;
            if (m.isMesh) found = m.material as THREE.Material;
          });
          if (found) {
            tiles.set(key, found);
            mesh.material = found;
          }
        } catch {
          /* keep the original material as a fallback */
        }
      })(),
    );
  });
  await Promise.all(jobs);
}

/** Instance of a model, normalised to a target footprint and grounded at y=0. */
export async function instantiate(variant: Variant, opts: { materials?: number; shadows?: boolean } = {}): Promise<THREE.Group> {
  const gltf = await loadGLB(variant.url);
  const root = gltf.scene.clone(true);
  await applyAtlasMaterials(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const sx = variant.size[0] / Math.max(size.x, 1e-6);
  const sz = variant.size[2] / Math.max(size.z, 1e-6);
  const sy = variant.size[1] / Math.max(size.y, 1e-6);
  const wrap = new THREE.Group();
  if (opts.materials !== undefined) {
    const mats = new Map<THREE.Material, THREE.Material>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (Array.isArray(m.material)) return;
      let mm = mats.get(m.material);
      if (!mm) {
        mm = (m.material as THREE.Material).clone();
        mats.set(m.material, mm);
      }
      m.material = mm;
    });
  }
  root.scale.set(sx, Math.min(sy, sy), sz);
  root.position.set(-((box.min.x + box.max.x) / 2) * sx, -box.min.y * sy, -((box.min.z + box.max.z) / 2) * sz);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = opts.shadows ?? true;
      m.receiveShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) {
        if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = 0.7;
      }
    }
  });
  wrap.add(root);
  return wrap;
}

/** Dispose a group created by instantiate(). */
export function disposeInstance(group: THREE.Object3D): void {
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat as THREE.Material);
  });
  // Atlas materials are shared between instances — do not dispose them here.
  void mats;
}
