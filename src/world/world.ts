/**
 * City renderer + collision service (Lead-owned after Agent 1 failure).
 *
 * Design goals: low draw calls (merged geometry + instancing), a coherent
 * colourful low-poly look, and exact collision data for the character and
 * vehicle physics. Flat city: roads at y=0, pavements at KERB_HEIGHT.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityWorld, CollisionService, Rect, RoadGraph, WorldStats, XZ } from '../contracts';
import {
  BLOCK,
  KERB_HEIGHT,
  SIDEWALK_WIDTH,
  STREETS,
  WORLD_MAX,
  WORLD_MIN,
  X_OFFSET,
  Z_OFFSET,
  ewZ,
  nsX,
  streetHalfWidth,
} from './layout';
import {
  CITY_POIS,
  CollisionGrid,
  buildRoadGraph,
  blockRect,
  isParkBlock,
  isParkingBlock,
  laneOffset,
  poiMap,
  pushOutOfRect,
} from './cityLayout';
import { makeRng } from '../core/utils';

const BOUNDS = { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX };

const PALETTE = {
  asphalt: 0x2e323a,
  sidewalk: 0xa7a49c,
  kerb: 0x8c8a84,
  grass: 0x4f8f43,
  path: 0xc9bda3,
  lot: 0x3b3f47,
  white: 0xf2f2f2,
  yellow: 0xf0c437,
  hedge: 0x3f7a35,
  wall: 0x6f6a60,
};

const FACADES = [0xd9c8a9, 0xc4805b, 0x8fa3b8, 0x6e8f7d, 0xe0d3c0, 0x9e8fa8, 0xb75c4a, 0x7d8fa8, 0xcbb68f, 0x5f7f9f];
const GLASS = 0x34424f;
const ROOF = 0x5c5a55;

interface BuildingDef {
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
  color: number;
  roof: 'flat' | 'stepped' | 'antenna';
}

function buildBuildings(): BuildingDef[] {
  const rng = makeRng(90210);
  const out: BuildingDef[] = [];
  for (let ix = 0; ix < STREETS - 1; ix++) {
    for (let iz = 0; iz < STREETS - 1; iz++) {
      if (isParkBlock(ix, iz) || isParkingBlock(ix, iz)) continue;
      const b = blockRect(ix, iz);
      const innerX0 = b.minX + SIDEWALK_WIDTH;
      const innerX1 = b.maxX - SIDEWALK_WIDTH;
      const innerZ0 = b.minZ + SIDEWALK_WIDTH;
      const innerZ1 = b.maxZ - SIDEWALK_WIDTH;
      const w = innerX1 - innerX0;
      const d = innerZ1 - innerZ0;
      // 1–3 lots per block.
      const splitX = rng() < 0.5;
      const lots: Array<[number, number, number, number]> = [];
      if (rng() < 0.45) {
        // Single big building with a setback courtyard.
        lots.push([innerX0 + w * 0.06, innerZ0 + d * 0.06, innerX1 - w * 0.06, innerZ1 - d * 0.06]);
      } else if (splitX) {
        const m = innerX0 + w * (0.42 + rng() * 0.16);
        lots.push([innerX0, innerZ0, m - 1.5, innerZ1]);
        if (rng() < 0.45) {
          const c = innerZ0 + d * 0.5;
          lots.push([m + 1.5, innerZ0, innerX1, c - 1.5]);
          lots.push([m + 1.5, c + 1.5, innerX1, innerZ1]);
        } else lots.push([m + 1.5, innerZ0, innerX1, innerZ1]);
      } else {
        const m = innerZ0 + d * (0.42 + rng() * 0.16);
        lots.push([innerX0, innerZ0, innerX1, m - 1.5]);
        lots.push([innerX0, m + 1.5, innerX1, innerZ1]);
      }
      for (const [x0, z0, x1, z1] of lots) {
        if (x1 - x0 < 6 || z1 - z0 < 6) continue;
        // Downtown blocks (centre) get taller towers.
        const centre = Math.hypot(ix - 1.5, iz - 1.5);
        const tall = centre < 1.5;
        const h = tall ? 24 + rng() * 34 : 10 + rng() * 22;
        const roofRoll = rng();
        out.push({
          x: (x0 + x1) / 2,
          z: (z0 + z1) / 2,
          hx: (x1 - x0) / 2,
          hz: (z1 - z0) / 2,
          h,
          color: FACADES[Math.floor(rng() * FACADES.length)],
          roof: roofRoll < 0.55 ? 'flat' : roofRoll < 0.85 ? 'stepped' : 'antenna',
        });
      }
    }
  }
  return out;
}

function colorize(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, color);
}

function plane(w: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, color);
}

export class City implements CityWorld {
  readonly group = new THREE.Group();
  readonly bounds = BOUNDS;
  readonly roadGraph: RoadGraph;
  readonly pois: Record<string, XZ>;
  readonly colliders: Rect[] = [];
  private grid: CollisionGrid;
  private buildingCount = 0;
  private disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];
  private tmpIdx: number[] = [];
  private trafficLights: THREE.InstancedMesh | null = null;
  private tris = 0;

  constructor() {
    this.group.name = 'city';
    this.roadGraph = buildRoadGraph();
    this.pois = poiMap();

    const buildings = buildBuildings();
    this.buildingCount = buildings.length;
    this.buildRoads();
    this.buildSidewalksAndBlocks();
    this.buildBuildings(buildings);
    this.buildProps();
    this.buildBoundary();
    this.buildBackdrop();
    this.buildGround();

    // Colliders: buildings + props pushed by their builders.
    this.grid = new CollisionGrid(this.colliders);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering helpers                                                   */
  /* ------------------------------------------------------------------ */

  private add(geo: THREE.BufferGeometry | THREE.BufferGeometry[], material: THREE.Material, shadow = true): void {
    const list = Array.isArray(geo) ? geo : [geo];
    if (!list.length) return;
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!merged) {
      for (const g of list) g.dispose();
      return;
    }
    if (list.length > 1) list.forEach((g) => g.dispose());
    merged.computeBoundingSphere();
    this.tris += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.disposables.push(merged, material);
  }

  private buildGround(): void {
    const m = new THREE.MeshStandardMaterial({ color: 0x5d6b4e, roughness: 1 });
    const g = plane(1200, 1200, 0, -0.08, 0, 0x5d6b4e);
    this.add(g, m, false);
  }

  private buildRoads(): void {
    const strips: THREE.BufferGeometry[] = [];
    const marks: THREE.BufferGeometry[] = [];
    const rng = makeRng(4242);
    // Asphalt: for each street, long strips between intersections.
    for (let s = 0; s < STREETS; s++) {
      const half = streetHalfWidth(s);
      for (let i = 0; i < STREETS - 1; i++) {
        const a = ewZ(i);
        const b = ewZ(i + 1);
        strips.push(plane(half * 2, b - a, nsX(s), 0.01, (a + b) / 2, PALETTE.asphalt)); // N-S street segment
        strips.push(plane(b - a, half * 2, (a + b) / 2, 0.01, ewZ(s), PALETTE.asphalt)); // E-W street segment
      }
      // Intersection squares.
      for (let j = 0; j < STREETS; j++) {
        strips.push(plane(half * 2, half * 2, nsX(s), 0.012, ewZ(j), PALETTE.asphalt));
      }
    }
    this.add(strips, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), false);

    // Lane dashes + centre lines + crosswalks (all instanced-ish via merged boxes).
    const dashGeos: THREE.BufferGeometry[] = [];
    for (let s = 0; s < STREETS; s++) {
      const half = streetHalfWidth(s);
      for (let i = 0; i < STREETS - 1; i++) {
        const a = ewZ(i) + half;
        const b = ewZ(i + 1) - half;
        for (let z = a + 2; z < b - 2; z += 6) {
          // N-S street: centre line (double yellow on arterials) + dashes per lane.
          if (half >= 10) {
            dashGeos.push(box(0.18, 0.02, 3.2, nsX(s) - 0.25, 0.02, z, PALETTE.yellow));
            dashGeos.push(box(0.18, 0.02, 3.2, nsX(s) + 0.25, 0.02, z, PALETTE.yellow));
          } else dashGeos.push(box(0.22, 0.02, 3.2, nsX(s), 0.02, z, PALETTE.yellow));
          dashGeos.push(box(0.14, 0.02, 2.2, nsX(s) + half * 0.5, 0.02, z, PALETTE.white));
          dashGeos.push(box(0.14, 0.02, 2.2, nsX(s) - half * 0.5, 0.02, z, PALETTE.white));
        }
        // E-W street marks.
        for (let x = a + 2; x < b - 2; x += 6) {
          if (half >= 10) {
            dashGeos.push(box(3.2, 0.02, 0.18, x, 0.02, ewZ(s) - 0.25, PALETTE.yellow));
            dashGeos.push(box(3.2, 0.02, 0.18, x, 0.02, ewZ(s) + 0.25, PALETTE.yellow));
          } else dashGeos.push(box(3.2, 0.02, 0.22, x, 0.02, ewZ(s), PALETTE.yellow));
          dashGeos.push(box(2.2, 0.02, 0.14, x, 0.02, ewZ(s) + half * 0.5, PALETTE.white));
          dashGeos.push(box(2.2, 0.02, 0.14, x, 0.02, ewZ(s) - half * 0.5, PALETTE.white));
        }
      }
    }
    // Zebra crossings around every intersection.
    for (let i = 0; i < STREETS; i++) {
      for (let j = 0; j < STREETS; j++) {
        const cx = nsX(i);
        const cz = ewZ(j);
        const hN = streetHalfWidth(j);
        const hE = streetHalfWidth(i);
        for (let k = -4; k <= 4; k++) {
          const o = k * 1.3;
          marks.push(box(1.8, 0.02, 0.7, cx + o, 0.02, cz - hN - 1.6, PALETTE.white));
          marks.push(box(1.8, 0.02, 0.7, cx + o, 0.02, cz + hN + 1.6, PALETTE.white));
          marks.push(box(0.7, 0.02, 1.8, cx - hE - 1.6, 0.02, cz + o, PALETTE.white));
          marks.push(box(0.7, 0.02, 1.8, cx + hE + 1.6, 0.02, cz + o, PALETTE.white));
        }
      }
    }
    void rng;
    this.add([...dashGeos, ...marks], new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), false);
  }

  private buildSidewalksAndBlocks(): void {
    const kerbs: THREE.BufferGeometry[] = [];
    const inners: THREE.BufferGeometry[] = [];
    for (let ix = 0; ix < STREETS - 1; ix++) {
      for (let iz = 0; iz < STREETS - 1; iz++) {
        const b = blockRect(ix, iz);
        const w = b.maxX - b.minX;
        const d = b.maxZ - b.minZ;
        // Pavement ring (four slabs).
        const s = SIDEWALK_WIDTH;
        kerbs.push(box(w, KERB_HEIGHT, s, b.cx, KERB_HEIGHT / 2, b.minZ + s / 2, PALETTE.sidewalk));
        kerbs.push(box(w, KERB_HEIGHT, s, b.cx, KERB_HEIGHT / 2, b.maxZ - s / 2, PALETTE.sidewalk));
        kerbs.push(box(s, KERB_HEIGHT, d - s * 2, b.minX + s / 2, KERB_HEIGHT / 2, b.cz, PALETTE.sidewalk));
        kerbs.push(box(s, KERB_HEIGHT, d - s * 2, b.maxX - s / 2, KERB_HEIGHT / 2, b.cz, PALETTE.sidewalk));
        // Kerb edge strip (subtle darker lip).
        const iw = w - s * 2;
        const id = d - s * 2;
        if (isParkBlock(ix, iz)) {
          inners.push(plane(iw, id, b.cx, KERB_HEIGHT + 0.01, b.cz, PALETTE.grass));
        } else if (isParkingBlock(ix, iz)) {
          inners.push(plane(iw, id, b.cx, KERB_HEIGHT + 0.01, b.cz, PALETTE.lot));
          // Parking bay lines.
          for (let k = -3; k <= 3; k++) {
            inners.push(box(0.15, 0.02, 5, b.cx + k * 3, KERB_HEIGHT + 0.02, b.cz - id * 0.22, PALETTE.white));
          }
          inners.push(box(iw, 0.02, 0.15, b.cx, KERB_HEIGHT + 0.02, b.cz - id * 0.22 + 2.5, PALETTE.white));
        } else {
          inners.push(plane(iw, id, b.cx, KERB_HEIGHT + 0.01, b.cz, 0x7c8478));
        }
      }
    }
    this.add(kerbs, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), false);
    this.add(inners, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), false);
    // Park details.
    const park = blockRect(2, 2);
    const paths: THREE.BufferGeometry[] = [];
    paths.push(plane(park.maxX - park.minX - SIDEWALK_WIDTH * 2, 3.2, park.cx, KERB_HEIGHT + 0.02, park.cz, PALETTE.path));
    paths.push(plane(3.2, park.maxZ - park.minZ - SIDEWALK_WIDTH * 2, park.cx, KERB_HEIGHT + 0.03, park.cz, PALETTE.path));
    paths.push(plane(24, 24, park.cx, KERB_HEIGHT + 0.04, park.cz, PALETTE.path));
    // Fountain.
    paths.push(box(7, 0.5, 7, park.cx, KERB_HEIGHT + 0.25, park.cz, 0xb8b2a6));
    paths.push(box(6.4, 0.35, 6.4, park.cx, KERB_HEIGHT + 0.55, park.cz, 0x4aa3c9));
    paths.push(box(0.8, 1.8, 0.8, park.cx, KERB_HEIGHT + 1.1, park.cz, 0xd8d4cb));
    this.add(paths, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), false);
  }

  private buildBuildings(defs: BuildingDef[]): void {
    const facades: THREE.BufferGeometry[] = [];
    const windows: THREE.BufferGeometry[] = [];
    const roofGeos: THREE.BufferGeometry[] = [];
    for (const b of defs) {
      const h = b.h;
      facades.push(box(b.hx * 2, h, b.hz * 2, b.x, h / 2, b.z, b.color));
      // Window bands on the two street-facing sides (X/Z faces) — cheap emissive-ish squares.
      const floors = Math.max(2, Math.floor(h / 4));
      for (let f = 1; f < floors; f++) {
        const y = (h / floors) * f;
        windows.push(box(b.hx * 2 + 0.04, 1.1, b.hz * 2 + 0.04, b.x, y, b.z, GLASS));
      }
      // Roofline.
      roofGeos.push(box(b.hx * 2 + 0.6, 0.6, b.hz * 2 + 0.6, b.x, h + 0.3, b.z, ROOF));
      if (b.roof === 'stepped') {
        roofGeos.push(box(b.hx * 1.2, 3, b.hz * 1.2, b.x, h + 2, b.z, b.color));
      } else if (b.roof === 'antenna') {
        roofGeos.push(box(0.3, 6, 0.3, b.x, h + 3.3, b.z, 0x9aa0a6));
      } else {
        roofGeos.push(box(2.2, 1.2, 2.2, b.x + b.hx * 0.4, h + 1.2, b.z - b.hz * 0.3, 0x8a8a86));
      }
      // Collider (full footprint, from ground to roof).
      this.colliders.push({ x: b.x, z: b.z, hx: b.hx, hz: b.hz, height: h, kind: 'building' });
    }
    this.add(facades, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }), true);
    this.add(windows, new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.25,
      metalness: 0.4,
      emissive: new THREE.Color(0x0d1620),
    }), false);
    this.add(roofGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), false);
  }

  /** Place instanced meshes for repeated props. */
  private instanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    transforms: Array<{ x: number; z: number; y?: number; ry?: number; s?: number }>,
    shadow = false,
  ): THREE.InstancedMesh | null {
    if (!transforms.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    transforms.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.ry ?? 0);
      v.set(t.x, t.y ?? 0, t.z);
      const s = t.s ?? 1;
      sc.set(s, s, s);
      m.compose(v, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    this.tris += ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) * transforms.length;
    return mesh;
  }

  private sidewalkSpots(): Array<{ x: number; z: number }> {
    const spots: Array<{ x: number; z: number }> = [];
    const off = SIDEWALK_WIDTH * 0.45;
    for (let ix = 0; ix < STREETS - 1; ix++) {
      for (let iz = 0; iz < STREETS - 1; iz++) {
        const b = blockRect(ix, iz);
        // Along each edge of the block perimeter.
        for (let t = b.minX + 6; t < b.maxX - 4; t += 16) {
          spots.push({ x: t, z: b.minZ + off });
          spots.push({ x: t, z: b.maxZ - off });
        }
        for (let t = b.minZ + 6; t < b.maxZ - 4; t += 16) {
          spots.push({ x: b.minX + off, z: t });
          spots.push({ x: b.maxX - off, z: t });
        }
      }
    }
    return spots;
  }

  private buildProps(): void {
    const spots = this.sidewalkSpots();
    const lampMats = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });

    // Streetlights: pole + head
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6);
    poleGeo.translate(0, 2.6, 0);
    const headGeo = new THREE.BoxGeometry(0.5, 0.22, 1.1);
    headGeo.translate(0, 5.2, 0.35);
    const lampSpots = spots.filter((_, i) => i % 2 === 0);
    this.instanced(poleGeo, new THREE.MeshStandardMaterial({ color: 0x3c4148, roughness: 0.6 }), lampSpots);
    this.instanced(
      headGeo,
      new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffc861, emissiveIntensity: 0.6, roughness: 0.4 }),
      lampSpots,
    );
    for (const s of lampSpots) this.colliders.push({ x: s.x, z: s.z, hx: 0.18, hz: 0.18, kind: 'prop' });
    void lampMats;

    // Benches
    const benchGeo = mergeGeometries([
      box(2.2, 0.12, 0.55, 0, 0.5, 0, 0x8a5a32),
      box(2.2, 0.5, 0.1, 0, 0.75, -0.28, 0x8a5a32),
    ])!;
    const benchSpots = spots.filter((_, i) => i % 5 === 2);
    this.instanced(benchGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), benchSpots);
    for (const s of benchSpots) this.colliders.push({ x: s.x, z: s.z, hx: 1.1, hz: 0.3, kind: 'prop' });

    // Hydrants
    const hydrantGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.7, 6);
    hydrantGeo.translate(0, 0.35, 0);
    const hydrantSpots = spots.filter((_, i) => i % 9 === 4);
    this.instanced(hydrantGeo, new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 }), hydrantSpots);
    for (const s of hydrantSpots) this.colliders.push({ x: s.x, z: s.z, hx: 0.25, hz: 0.25, kind: 'prop' });

    // Park trees + sidewalk trees
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6);
    trunkGeo.translate(0, 1.2, 0);
    const canopyGeo = new THREE.IcosahedronGeometry(1.9, 0);
    canopyGeo.translate(0, 3.8, 0);
    const treeSpots: Array<{ x: number; z: number; s?: number }> = [];
    const park = blockRect(2, 2);
    const rng = makeRng(777);
    for (let i = 0; i < 26; i++) {
      const x = park.minX + SIDEWALK_WIDTH + 3 + rng() * (park.maxX - park.minX - SIDEWALK_WIDTH * 2 - 6);
      const z = park.minZ + SIDEWALK_WIDTH + 3 + rng() * (park.maxZ - park.minZ - SIDEWALK_WIDTH * 2 - 6);
      if (Math.abs(x - park.cx) < 15 || Math.abs(z - park.cz) < 15) continue;
      treeSpots.push({ x, z, s: 0.9 + rng() * 0.4 });
    }
    const sidewalkTrees = spots.filter((_, i) => i % 7 === 3);
    for (const s of sidewalkTrees) treeSpots.push({ x: s.x, z: s.z, s: 0.8 });
    this.instanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 }), treeSpots);
    this.instanced(canopyGeo, new THREE.MeshStandardMaterial({ color: 0x3f8a3a, roughness: 1, flatShading: true }), treeSpots, true);
    for (const s of treeSpots) this.colliders.push({ x: s.x, z: s.z, hx: 0.4, hz: 0.4, kind: 'prop' });

    // Traffic lights at every intersection corner (poles + heads).
    const tlGeo = new THREE.CylinderGeometry(0.1, 0.1, 4.4, 6);
    tlGeo.translate(0, 2.2, 0);
    const tlSpots: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < STREETS; i++) {
      for (let j = 0; j < STREETS; j++) {
        const hx = streetHalfWidth(i);
        const hz = streetHalfWidth(j);
        tlSpots.push({ x: nsX(i) - hx - 0.8, z: ewZ(j) - hz - 0.8 });
        tlSpots.push({ x: nsX(i) + hx + 0.8, z: ewZ(j) + hz + 0.8 });
      }
    }
    this.instanced(tlGeo, new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.6 }), tlSpots);
    const headGeo2 = new THREE.BoxGeometry(0.35, 0.9, 0.35);
    headGeo2.translate(0, 4.2, 0);
    this.trafficLights = this.instanced(
      headGeo2,
      new THREE.MeshStandardMaterial({ color: 0x1b1f24, emissive: 0xff3322, emissiveIntensity: 1.2 }),
      tlSpots,
    );
    for (const s of tlSpots) this.colliders.push({ x: s.x, z: s.z, hx: 0.2, hz: 0.2, kind: 'prop' });

    // Billboards on rooftops of a few blocks.
    const billboards: THREE.BufferGeometry[] = [];
    for (const [ix, iz, c] of [[0, 3, 0xe74c3c], [3, 0, 0x3498db], [1, 0, 0xf1c40f]] as const) {
      const b = blockRect(ix, iz);
      billboards.push(box(10, 4, 0.3, b.cx, 14, b.minZ + SIDEWALK_WIDTH + 0.5, c));
      billboards.push(box(0.3, 8, 0.3, b.cx - 4, 10, b.minZ + SIDEWALK_WIDTH + 0.5, 0x44484e));
      billboards.push(box(0.3, 8, 0.3, b.cx + 4, 10, b.minZ + SIDEWALK_WIDTH + 0.5, 0x44484e));
    }
    this.add(billboards, new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0x222222, roughness: 0.5 }), false);
  }

  private buildBoundary(): void {
    const walls: THREE.BufferGeometry[] = [];
    const t = 2.4;
    const mid = (WORLD_MIN + WORLD_MAX) / 2;
    const len = WORLD_MAX - WORLD_MIN;
    walls.push(box(len + t * 2, 2.2, t, mid, 1.1, WORLD_MIN - t / 2, PALETTE.wall));
    walls.push(box(len + t * 2, 2.2, t, mid, 1.1, WORLD_MAX + t / 2, PALETTE.wall));
    walls.push(box(t, 2.2, len, WORLD_MIN - t / 2, 1.1, mid, PALETTE.wall));
    walls.push(box(t, 2.2, len, WORLD_MAX + t / 2, 1.1, mid, PALETTE.wall));
    this.add(walls, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), true);
    // Hedge line just inside for a friendlier look.
    const hedges: THREE.BufferGeometry[] = [];
    const h = 0.9;
    hedges.push(box(len, h, 0.8, mid, h / 2, WORLD_MIN - t - 0.5, PALETTE.hedge));
    hedges.push(box(len, h, 0.8, mid, h / 2, WORLD_MAX + t + 0.5, PALETTE.hedge));
    hedges.push(box(0.8, h, len, WORLD_MIN - t - 0.5, h / 2, mid, PALETTE.hedge));
    hedges.push(box(0.8, h, len, WORLD_MAX + t + 0.5, h / 2, mid, PALETTE.hedge));
    this.add(hedges, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), false);
    // Colliders (invisible, thicker).
    const thick = 6;
    this.colliders.push({ x: mid, z: WORLD_MIN - thick / 2, hx: len, hz: thick / 2, kind: 'building' });
    this.colliders.push({ x: mid, z: WORLD_MAX + thick / 2, hx: len, hz: thick / 2, kind: 'building' });
    this.colliders.push({ x: WORLD_MIN - thick / 2, z: mid, hx: thick / 2, hz: len, kind: 'building' });
    this.colliders.push({ x: WORLD_MAX + thick / 2, z: mid, hx: thick / 2, hz: len, kind: 'building' });
  }

  /** Distant skyline silhouettes beyond the city, for horizon interest. */
  private buildBackdrop(): void {
    const rng = makeRng(31337);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2;
      const r = 230 + rng() * 160;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const w = 12 + rng() * 26;
      const d = 12 + rng() * 26;
      const h = 20 + rng() * 90;
      const c = new THREE.Color().setHSL(0.58 + rng() * 0.06, 0.18, 0.42 + rng() * 0.1).getHex();
      geos.push(box(w, h, d, x, h / 2, z, c));
    }
    this.add(geos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, fog: true }), false);
  }

  /* ------------------------------------------------------------------ */
  /* CollisionService                                                    */
  /* ------------------------------------------------------------------ */

  resolveCircle(cx: number, cz: number, r: number): XZ {
    const c = { x: cx, z: cz };
    const idx = this.tmpIdx;
    for (let iter = 0; iter < 3; iter++) {
      this.grid.candidates(c.x, c.z, r, idx);
      let hit = false;
      for (const i of idx) {
        if (pushOutOfRect(c, r, this.colliders[i])) hit = true;
      }
      if (!hit) break;
    }
    const m = r + 0.05;
    if (c.x < BOUNDS.minX + m) c.x = BOUNDS.minX + m;
    if (c.x > BOUNDS.maxX - m) c.x = BOUNDS.maxX - m;
    if (c.z < BOUNDS.minZ + m) c.z = BOUNDS.minZ + m;
    if (c.z > BOUNDS.maxZ - m) c.z = BOUNDS.maxZ - m;
    return { x: c.x, z: c.z };
  }

  overlapsCircle(cx: number, cz: number, r: number): boolean {
    const idx = this.tmpIdx;
    this.grid.candidates(cx, cz, r, idx);
    for (const i of idx) {
      const rect = this.colliders[i];
      const px = Math.max(rect.x - rect.hx, Math.min(cx, rect.x + rect.hx));
      const pz = Math.max(rect.z - rect.hz, Math.min(cz, rect.z + rect.hz));
      const dx = cx - px;
      const dz = cz - pz;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  inBounds(x: number, z: number, margin = 0.5): boolean {
    return x > BOUNDS.minX + margin && x < BOUNDS.maxX - margin && z > BOUNDS.minZ + margin && z < BOUNDS.maxZ - margin;
  }

  groundHeight(x: number, z: number): number {
    // On pavement (the sidewalk ring of any block) or park/parking interior?
    for (let ix = 0; ix < STREETS - 1; ix++) {
      if (x <= blockRect(ix, 0).minX || x >= blockRect(ix, 0).maxX) continue;
      for (let iz = 0; iz < STREETS - 1; iz++) {
        const b = blockRect(ix, iz);
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return KERB_HEIGHT;
      }
    }
    return 0;
  }

  isRoad(x: number, z: number): boolean {
    for (let s = 0; s < STREETS; s++) {
      const half = streetHalfWidth(s);
      if (Math.abs(x - nsX(s)) <= half && z >= WORLD_MIN && z <= WORLD_MAX) return true;
      if (Math.abs(z - ewZ(s)) <= half && x >= WORLD_MIN && x <= WORLD_MAX) return true;
    }
    return false;
  }

  isSidewalk(x: number, z: number): boolean {
    if (this.isRoad(x, z)) return false;
    for (let ix = 0; ix < STREETS - 1; ix++) {
      for (let iz = 0; iz < STREETS - 1; iz++) {
        const b = blockRect(ix, iz);
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
      }
    }
    return false;
  }

  nearestSidewalkPoint(x: number, z: number): XZ {
    let best: XZ = { x, z };
    let bestD = Infinity;
    for (let ix = 0; ix < STREETS - 1; ix++) {
      for (let iz = 0; iz < STREETS - 1; iz++) {
        const b = blockRect(ix, iz);
        const off = SIDEWALK_WIDTH * 0.5;
        const cands: XZ[] = [
          { x, z: b.minZ + off },
          { x, z: b.maxZ - off },
          { x: b.minX + off, z },
          { x: b.maxX - off, z },
        ];
        for (const c of cands) {
          if (c.x < b.minX || c.x > b.maxX || c.z < b.minZ || c.z > b.maxZ) continue;
          const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */

  update(_dt: number, elapsed: number): void {
    if (this.trafficLights) {
      // Toggle red/amber glow every few seconds — one material update, no allocations.
      const phase = Math.floor(elapsed / 6) % 2;
      const mat = this.trafficLights.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(phase === 0 ? 0xff3322 : 0x22ff55);
    }
  }

  stats(): WorldStats {
    return { buildings: this.buildingCount, colliders: this.colliders.length, drawCalls: 0, triangles: Math.round(this.tris) };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }
}

export function createWorld(): CityWorld {
  return new City();
}

export const CITY_POIS_EXPORT = CITY_POIS;
export type { CollisionService };
export { laneOffset, blockRect, nsX, ewZ, X_OFFSET, Z_OFFSET, BLOCK };
