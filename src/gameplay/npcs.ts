/**
 * PEDESTRIANS & TRAFFIC — `NPCSystemApi` implementation. Owned by: Agent 3 (Gameplay).
 *
 * Public surface (returned by `createNPCSystem`):
 *   group                THREE.Group with every ped / car mesh (also added to `scene` by the factory)
 *   update(dt, playerPos, drivenVehicle)
 *   minimapData()        downsampled { cars, peds } XZ arrays (<= 48 each, reused buffers)
 *   trafficVehicles      Vehicle[] — one per traffic car (`role: 'traffic'`), jackable by the Lead
 *   takeOver(vehicle)    detach a traffic car from AI so the Lead can drive it
 *   handBack(vehicle)    optional: give it back to the AI
 *   isAIControlled(v)    is this car currently AI driven?
 *   isWalkable(x, z)     the "sidewalk-like" predicate used for pedestrian loops
 *   pedCount / vehicleCount, dispose()
 *
 * Design notes
 * ------------
 * - Only the frozen contracts are used at runtime: `world.roadGraph`, `world.bounds`,
 *   `world.isRoad`, `world.overlapsCircle`, `world.resolveCircle`, `world.inBounds`.
 *   No imports from world/* or entities/* (only the Lead-owned layout constants are
 *   imported — they are a frozen contract of the city grid).
 * - The city is a 5x5 street grid (layout.ts) with a sidewalk ring around each block,
 *   so pedestrian loops are built analytically per block: the ring rectangle is inset
 *   (grown) until all four corners + edge midpoints are walkable, and each corner is
 *   then nudged outward while validating with the world's own point queries.
 * - Peds walk the ring rectangles (along each side, then around the corner) between
 *   SIDEWALK_WIDTH/2 and SIDEWALK_WIDTH + 1.2 m from the kerb, so they visibly drift
 *   inward/outward instead of tracing a rigid polygon.
 * - update() is O(peds + cars), allocation-free in the hot loop (all scratch objects
 *   are reused; arrays are cleared with .length = 0).
 * - No DOM: only THREE.Group / Mesh / geometries (works under Node for vitest).
 */

import * as THREE from 'three';
import type { CityWorld, NPCSystemApi, Vehicle, VehicleSpec, XZ } from '../contracts';
import { STREETS, BLOCK, X_OFFSET, Z_OFFSET, nsX, ewZ, streetHalfWidth, SIDEWALK_WIDTH } from '../world/layout';

/** Centre of block (ix, 1) horizontally — the start street's block. */
const blockRectCenterX = (ix: number): number => nsX(ix) + streetHalfWidth(ix) + (BLOCK - streetHalfWidth(ix) - streetHalfWidth(ix + 1)) / 2;
import { angleDelta, clamp, lerp, makeRng } from '../core/utils';

/* -------------------------------------------------------------------------- */
/* Tunables (exported: tests + the Lead can reason about them)                */
/* -------------------------------------------------------------------------- */

export const NPC_CONFIG = {
  pedestrians: 14,
  trafficCars: 8,
  pedSpeedMin: 1.1,
  pedSpeedMax: 1.6,
  /** A ped closer than this (behind) on the same loop eases off. */
  pedSpacing: 3,
  /** Player / driven car ahead within this distance makes a ped step aside. */
  pedAvoidRadius: 2.5,
  carSpeedMin: 9,
  carSpeedMax: 14,
  /** Cars on the same heading within this distance ahead -> slow / stop. */
  carFollowGap: 8,
  /** Player-driven car this close ahead -> brake. */
  carPlayerGap: 10,
  /** Waypoint index ahead that decides a "bend" (slow down). */
  carBendLookAhead: 4,
  carTurnRate: 2.6,
  carLen: 4.0,
  carWid: 1.8,
} as const;

export const NPC_SEED = 20261119;

const SHIRT_COLORS = [
  0xd94545, 0x3f7fdc, 0xf2b134, 0x4fbf7a, 0x9b59c9, 0xff8a3d, 0x2ec4c4,
  0xe85b9c, 0x8a6a4f, 0x5b6b8a, 0xc7d94a, 0xefefef, 0x2f3b57, 0xb44b2e,
];
const CAR_COLORS = [0xd23f3f, 0x3d6fd1, 0xe8d24a, 0x4ab26b, 0xcfd4db, 0x2c2f36, 0xe08a2e, 0x8b5cc7];
const TROUSER_COLOR = 0x22283a;
const SKIN_COLOR = 0xe0b090;

const TWO_PI = Math.PI * 2;
const STEP_DT = 1 / 60;

/* -------------------------------------------------------------------------- */
/* Pedestrian path: a ring rectangle + validated inset range                  */
/* -------------------------------------------------------------------------- */

interface PedPath {
  /** Outer (kerb-side) rectangle [minX, maxX, minZ, maxZ]. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Valid lateral inset range [inMin, inMax] (grow beyond the kerb is negative). */
  inMin: number;
  inMax: number;
  /** Perimeter of the outer rectangle. */
  total: number;
}

interface Ped {
  root: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  head: THREE.Object3D;
  path: PedPath;
  /** Along-path distance in metres (wrapped to path.total). */
  dist: number;
  baseSpeed: number;
  speed: number;
  /** Lateral inset from the outer rectangle (varies between inMin and inMax). */
  inset: number;
  insetTarget: number;
  yaw: number;
  walkPhase: number;
  x: number;
  z: number;
  /** Seconds of standing still after bumping into a wall. */
  bumpHold: number;
}

interface CarWheels {
  fl: THREE.Object3D;
  fr: THREE.Object3D;
  rl: THREE.Object3D;
  rr: THREE.Object3D;
}

interface TrafficAI {
  vehicle: Vehicle;
  wheels: CarWheels;
  path: XZ[];
  next: number;
  cruise: number;
  /** Seconds until the next "did I move?" check. */
  stuckTimer: number;
  aiActive: boolean;
  lastX: number;
  lastZ: number;
  wheelSpin: number;
}

/* -------------------------------------------------------------------------- */
/* Module helpers                                                             */
/* -------------------------------------------------------------------------- */

function wrapAngle(a: number): number {
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x < -Math.PI) x += TWO_PI;
  return x;
}

/** Point (x,z) is behind the ray origin (ox,oz) heading (hx,hz)? */
const behindHeading = (ox: number, oz: number, hx: number, hz: number, x: number, z: number): boolean =>
  (x - ox) * hx + (z - oz) * hz > 0.25;

/** Lateral distance of (x,z) from the heading line through (ox,oz). */
const lateralTo = (ox: number, oz: number, hx: number, hz: number, x: number, z: number): number =>
  Math.abs((x - ox) * hz - (z - oz) * hx);

/** FORWARD = (sin yaw, cos yaw) — matches foundation.ts (`yaw = atan2(dx, dz)`). */

/* -------------------------------------------------------------------------- */
/* NpcSystem                                                                  */
/* -------------------------------------------------------------------------- */

export class NpcSystem implements NPCSystemApi {
  readonly group = new THREE.Group();
  readonly trafficVehicles: Vehicle[] = [];

  private readonly world: CityWorld;
  private readonly rng: () => number;
  private readonly peds: Ped[] = [];
  private readonly cars: TrafficAI[] = [];
  private readonly paths: PedPath[] = [];
  /** Vehicles handed to the Lead via takeOver(): AI detached. */
  private readonly handedOver = new WeakSet<object>();

  readonly pedCount: number;

  // Shared pedestrian geometry + material set (3 geometries, 16 materials for the crowd).
  private readonly pedGeos: THREE.BufferGeometry[] = [];
  private readonly pedMats: THREE.Material[] = [];
  // Shared traffic material (vertex colours) + per-colour body geometries + one wheel geometry.
  private readonly carMat: THREE.MeshStandardMaterial;
  private readonly carGeos: THREE.BufferGeometry[] = [];

  private disposed = false;
  private time = 0;

  // Scratch buffers reused by update() (never reallocated).
  private readonly carXs: number[] = [];
  private readonly carZs: number[] = [];
  private readonly carHx: number[] = [];
  private readonly carHz: number[] = [];
  private minimapCars: XZ[] = [];
  private minimapPeds: XZ[] = [];

  constructor(scene: THREE.Scene | THREE.Group, world: CityWorld, seed: number = NPC_SEED) {
    this.world = world;
    this.rng = makeRng(seed);
    this.group.name = 'npc-system';

    this.carMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12 });

    this.buildPaths();
    this.spawnPedestrians(NPC_CONFIG.pedestrians);
    this.spawnTraffic(NPC_CONFIG.trafficCars);
    this.pedCount = this.peds.length;

    // Shadows: only the car bodies cast (cheap silhouette); pedestrians don't —
    // 14 skinned-looking figures × 3 parts would double the draw calls.
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = !!(o.parent?.name?.startsWith('traffic'));
        mesh.receiveShadow = false;
      }
    });

    scene.add(this.group);
  }

  /* --------------------------- pedestrian loops -------------------------- */

  /** A pedestrian point: inside the world, off the road, clear of buildings/props. */
  isWalkable(x: number, z: number, clearance = 1.05): boolean {
    const w = this.world;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (!w.inBounds(x, z)) return false;
    if (w.isRoad(x, z)) return false;
    // 1.05 m keeps walkers clear of facades, lamps and other props without
    // rejecting pavement spots that are merely near a wall.
    if (w.overlapsCircle(x, z, clearance)) return false;
    return true;
  }

  /** Series of candidate insets for a block ring: kerb ring first, then wider arcs. */
  private ringFor(ix: number, iz: number): PedPath | null {
    if (ix < 0 || iz < 0 || ix >= STREETS - 1 || iz >= STREETS - 1) return null;
    // Kerb-side rectangle of the block interior (the sidewalk ring).
    const kerbMinX = nsX(ix) + streetHalfWidth(ix);
    const kerbMaxX = nsX(ix + 1) - streetHalfWidth(ix + 1);
    const kerbMinZ = ewZ(iz) + streetHalfWidth(iz);
    const kerbMaxZ = ewZ(iz + 1) - streetHalfWidth(iz + 1);
    const sw = SIDEWALK_WIDTH;
    // Evidence of a usable ring (a valid inset in / out of the kerb by [0, 1.2 m]).
    const INSETS = [-1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2];
    const valid: number[] = [];
    for (const d of INSETS) {
      const minX = kerbMinX + d;
      const maxX = kerbMaxX - d;
      const minZ = kerbMinZ + d;
      const maxZ = kerbMaxZ - d;
      if (maxX - minX < sw * 1.2 || maxZ - minZ < sw * 1.2) continue;
      const cx = (minX + maxX) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      if (
        this.isWalkable(minX, cz) && // W midpoint
        this.isWalkable(maxX, cz) && // E midpoint
        this.isWalkable(cx, minZ) && // N midpoint
        this.isWalkable(cx, maxZ) && // S midpoint
        this.isWalkable(minX, minZ) && // NW
        this.isWalkable(maxX, minZ) && // NE
        this.isWalkable(maxX, maxZ) && // SE
        this.isWalkable(minX, maxZ) // SW
      ) {
        valid.push(d);
      }
    }
    if (valid.length === 0) return null;
    const inMin = Math.min(...valid);
    const inMax = Math.max(...valid);
    // Outer rect: the kerb (building) edge grown OUTWARD into the pavement when the
    // probes allow it (inMin < 0). Inset insets are never applied here: the positive
    // insets exist only as "don't wander inward this far" probes.
    const grow = Math.max(0, -inMin);
    const minX = kerbMinX - grow;
    const maxX = kerbMaxX + grow;
    const minZ = kerbMinZ - grow;
    const maxZ = kerbMaxZ + grow;
    if (maxX - minX < sw || maxZ - minZ < sw) return null;
    const total = 2 * (maxX - minX + maxZ - minZ);
    return { minX, maxX, minZ, maxZ, inMin: inMax, inMax: sw + 1.2, total };
  }

  private buildPaths(): void {
    // 16 blocks exist; take the first few with a valid walkable ring, best spread first.
    const order: Array<[number, number]> = [
      [1, 1], [2, 2], [3, 2], [0, 1], [2, 0], [1, 3], [3, 3], [0, 3],
      [3, 0], [0, 0], [1, 0], [2, 1], [0, 2], [1, 2], [2, 3], [3, 1],
    ];
    for (const [ix, iz] of order) {
      if (this.paths.length >= 4) break;
      const ring = this.ringFor(ix, iz);
      if (ring) this.paths.push(ring);
    }
    if (this.paths.length === 0) {
      // Very defensive fallback (odd world): a small square around the spawn POI.
      const p = this.world.pois?.spawn ?? { x: 0, z: 0 };
      const s = 7;
      const path: PedPath = {
        minX: p.x - s, maxX: p.x + s, minZ: p.z - s, maxZ: p.z + s,
        inMin: 0, inMax: 0.4, total: 4 * 2 * s,
      };
      this.paths.push(path);
    }
  }

  /**
   * Sample the ring rectangle at along-path distance d and inset `inset`.
   * Writes into the ped (no allocation). Walking: W -> N side, N -> E, E -> S, S -> W.
   */
  private placePed(ped: Ped): void {
    const p = ped.path;
    const minX = p.minX + ped.inset;
    const maxX = p.maxX - ped.inset;
    const minZ = p.minZ + ped.inset;
    const maxZ = p.maxZ - ped.inset;
    // Normalise d into the *inset* rectangle perimeter with a monotone UV parametrisation:
    // u in [0,1) maps to a fraction of the total, consistent with the outer perimeter.
    let t = ped.dist / p.total; // 0..1 along the OUTER rectangle
    if (!Number.isFinite(t)) t = 0;
    t = ((t % 1) + 1) % 1;
    const wOut = p.maxX - p.minX;
    const dOut = p.maxZ - p.minZ;
    const wFrac = wOut / (wOut + dOut); // fraction of the perimeter on the W/E sides
    // outer walking order: W-Sw (minX,minZ)->(maxX,minZ) [north side], then east, south, west.
    if (t < wFrac * 0.5) {
      // North side, west -> east
      const f = t / (wFrac * 0.5);
      ped.x = lerp(minX, maxX, f);
      ped.z = minZ;
      ped.yaw = Math.atan2(1, 0);
    } else if (t < 0.5) {
      // East side, north -> south
      const f = (t - wFrac * 0.5) / (0.5 - wFrac * 0.5);
      ped.z = lerp(minZ, maxZ, f);
      ped.x = maxX;
      ped.yaw = Math.atan2(0, 1);
    } else if (t < 0.5 + wFrac * 0.5) {
      // South side, east -> west
      const f = (t - 0.5) / (wFrac * 0.5);
      ped.x = lerp(maxX, minX, f);
      ped.z = maxZ;
      ped.yaw = Math.atan2(-1, 0);
    } else {
      // West side, south -> north
      const f = (t - 0.5 - wFrac * 0.5) / (0.5 - wFrac * 0.5);
      ped.z = lerp(maxZ, minZ, f);
      ped.x = minX;
      ped.yaw = Math.atan2(0, -1);
    }
  }

  /* ------------------------------ peds ---------------------------------- */

  private buildPedResources(): void {
    this.pedGeos.push(
      new THREE.BoxGeometry(0.5, 0.62, 0.3), // torso
      new THREE.BoxGeometry(0.26, 0.26, 0.26), // head
      new THREE.BoxGeometry(0.16, 0.78, 0.2), // leg
    );
    for (const c of SHIRT_COLORS) this.pedMats.push(new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
    this.pedMats.push(new THREE.MeshStandardMaterial({ color: TROUSER_COLOR, roughness: 0.9 }));
    this.pedMats.push(new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.75 }));
  }

  private spawnPedestrians(count: number): void {
    if (this.paths.length === 0 || count <= 0) return;
    this.buildPedResources();
    const [torsoGeo, headGeo, legGeo] = this.pedGeos;
    const trousers = this.pedMats[SHIRT_COLORS.length];
    const skin = this.pedMats[SHIRT_COLORS.length + 1];
    const perPath = Math.ceil(count / this.paths.length);
    let made = 0;
    for (let pi = 0; pi < this.paths.length && made < count; pi++) {
      const path = this.paths[pi];
      for (let k = 0; k < perPath && made < count; k++) {
        const root = new THREE.Group();
        const torso = new THREE.Mesh(torsoGeo, this.pedMats[Math.floor(this.rng() * SHIRT_COLORS.length)]);
        torso.position.y = 1.16;
        const headGroup = new THREE.Group();
        headGroup.position.y = 1.6;
        headGroup.add(new THREE.Mesh(headGeo, skin));
        const legL = new THREE.Mesh(legGeo, trousers);
        const legR = new THREE.Mesh(legGeo, trousers);
        legL.rotation.order = 'YXZ';
        legR.rotation.order = 'YXZ';
        legL.position.set(-0.13, 0.39, 0);
        legR.position.set(0.13, 0.39, 0);
        root.add(torso, headGroup, legL, legR);
        root.scale.setScalar(0.94 + this.rng() * 0.14);
        this.group.add(root);
        root.name = `ped-${this.peds.length}`;

        const disp = Math.min(path.inMin + (path.inMax - path.inMin) * (0.35 + this.rng() * 0.5), path.inMax);
        const ped: Ped = {
          root,
          legL,
          legR,
          head: headGroup,
          path,
          dist: (((k + 0.5) / perPath) * path.total) % path.total,
          baseSpeed: lerp(NPC_CONFIG.pedSpeedMin, NPC_CONFIG.pedSpeedMax, this.rng()),
          speed: 0,
          // "inset" grows the rectangle inward; `disp` is the distance from the kerb-side rect.
          inset: disp,
          insetTarget: disp,
          yaw: 0,
          walkPhase: this.rng() * TWO_PI,
          x: path.minX,
          z: path.minZ,
          bumpHold: 0,
        };
        this.placePed(ped);
        root.position.set(ped.x, 0, ped.z);
        root.rotation.y = ped.yaw;
        this.peds.push(ped);
        made++;
      }
    }
  }

  /* ----------------------------- traffic -------------------------------- */

  private buildCarResources(): void {
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 8);
    wheel.rotateX(Math.PI / 2); // cylinder axis along Z (the car's width axis)
    this.carGeos.push(wheel);
    const paint = (geo: THREE.BufferGeometry, bodyColor: number): void => {
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      const c = new THREE.Color(bodyColor);
      for (let i = 0; i < pos.count; i++) {
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    };
    for (const c of CAR_COLORS) {
      const hull = new THREE.BoxGeometry(NPC_CONFIG.carLen * 0.9, 0.62, NPC_CONFIG.carWid);
      const cabin = new THREE.BoxGeometry(NPC_CONFIG.carLen * 0.46, 0.5, NPC_CONFIG.carWid * 0.86);
      paint(hull, c);
      paint(cabin, c);
      this.carGeos.push(hull, cabin);
    }
  }

  private makeTrafficSpec(i: number, isVan: boolean): VehicleSpec {
    return {
      id: isVan ? 'van' : i % 3 === 1 ? 'sport' : 'sedan',
      label: isVan ? 'Van' : 'Sedan',
      maxSpeed: isVan ? 26 : 30,
      maxReverse: 6,
      accel: isVan ? 6 : 8,
      brake: 14,
      steerRate: 1.8,
      grip: 0.8,
      length: isVan ? 4.6 : NPC_CONFIG.carLen,
      width: isVan ? 1.95 : NPC_CONFIG.carWid,
      height: isVan ? 2.0 : 1.5,
      color: CAR_COLORS[i % CAR_COLORS.length],
    };
  }

  private spawnTraffic(count: number): void {
    const g = this.world.roadGraph;
    if (!g || !Array.isArray(g.nodes) || g.nodes.length === 0 || count <= 0) return;
    this.buildCarResources();
    const wheelGeo = this.carGeos[0];
    const used = new Set<number>();
    for (let i = 0; i < count; i++) {
      // Distinct-ish starting nodes so the cars do not spawn on top of each other.
      let node = g.nodes[Math.floor(this.rng() * g.nodes.length) % g.nodes.length];
      for (let tries = 0; tries < 16 && used.has(node.id); tries++) {
        node = g.nodes[Math.floor(this.rng() * g.nodes.length) % g.nodes.length];
      }
      used.add(node.id);
      const path = this.safePath(node.id, 120);
      const target = path.length > 0 ? path[0] : node;
      const x = node.x;
      const z = node.z;

      const bodyGroup = new THREE.Group();
      const ci = i % CAR_COLORS.length;
      const hull = new THREE.Mesh(this.carGeos[1 + ci * 2], this.carMat);
      hull.position.y = 0.62;
      const isVan = i % 4 === 3;
      const cabin = new THREE.Mesh(this.carGeos[2 + ci * 2], this.carMat);
      cabin.position.y = 1.17;
      if (isVan) cabin.scale.set(1.2, 1.5, 1.0);
      const mk = (): THREE.Object3D => {
        const pivot = new THREE.Group();
        pivot.add(new THREE.Mesh(wheelGeo, this.carMat));
        return pivot;
      };
      const wheels: CarWheels = { fl: mk(), fr: mk(), rl: mk(), rr: mk() };
      const sx = (isVan ? 4.6 : NPC_CONFIG.carLen) * 0.32;
      const sz = NPC_CONFIG.carWid * 0.5 - 0.02;
      wheels.fl.position.set(sx, 0.34, sz);
      wheels.fr.position.set(sx, 0.34, -sz);
      wheels.rl.position.set(-sx, 0.34, sz);
      wheels.rr.position.set(-sx, 0.34, -sz);
      bodyGroup.add(hull, cabin, wheels.fl, wheels.fr, wheels.rl, wheels.rr);

      const mesh = new THREE.Group();
      mesh.name = `traffic-${i}`;
      mesh.add(bodyGroup);
      mesh.position.set(x, 0, z);
      const yaw = Math.atan2(target.x - x, target.z - z);
      mesh.rotation.y = yaw;
      this.group.add(mesh);

      const ai: TrafficAI = {
        vehicle: null as unknown as Vehicle,
        wheels,
        path,
        next: 0,
        cruise: lerp(NPC_CONFIG.carSpeedMin, NPC_CONFIG.carSpeedMax, this.rng()),
        stuckTimer: 5,
        aiActive: true,
        lastX: x,
        lastZ: z,
        wheelSpin: 0,
      };
      const vehicle: Vehicle = {
        spec: this.makeTrafficSpec(i, isVan),
        position: new THREE.Vector3(x, 0, z),
        yaw,
        speed: 0,
        lateralSpeed: 0,
        mesh,
        driven: false,
        shape: 'traffic' as const,
        role: 'traffic',
        exitSide: (driverSide: 'left' | 'right'): XZ => this.exitPoint(ai.vehicle, driverSide),
      };
      ai.vehicle = vehicle;
      this.cars.push(ai);
      this.trafficVehicles.push(vehicle);
    }
    this.spawnNearbyTraffic();
  }

  /**
   * One guaranteed traffic car rolling down the start street towards the player.
   * Deterministic (not RNG-based) so the opening seconds always have a car to
   * jack, and so automated tests can script it.
   */
  private spawnNearbyTraffic(): void {
    const g = this.world.roadGraph;
    if (!g) return;
    // Start street: E-W street index 1, north-bound? Use the lane heading east
    // (+X) on ewZ(1), 40 m east of the block centre used by the Lead's spawn.
    const laneZ = ewZ(1) + streetHalfWidth(1) * 0.6;
    const x0 = blockRectCenterX(1) + 30;
    const nodeId = g.nearestNode(x0, laneZ);
    const node = g.nodes[nodeId];
    if (!node) return;
    const path = this.safePath(nodeId, 90);
    if (!path.length) return;
    const isVan = false;
    const mesh = new THREE.Group();
    mesh.name = 'traffic-nearby';
    const hull = new THREE.Mesh(this.carGeos[1], this.carMat);
    hull.position.y = 0.62;
    const cabin = new THREE.Mesh(this.carGeos[2], this.carMat);
    cabin.position.y = 1.17;
    const wheelGeo = this.carGeos[0];
    const mk = (): THREE.Object3D => {
      const pivot = new THREE.Group();
      pivot.add(new THREE.Mesh(wheelGeo, this.carMat));
      return pivot;
    };
    const wheels: CarWheels = { fl: mk(), fr: mk(), rl: mk(), rr: mk() };
    const sx = NPC_CONFIG.carLen * 0.32;
    const sz = NPC_CONFIG.carWid * 0.5 - 0.02;
    wheels.fl.position.set(sx, 0.34, sz);
    wheels.fr.position.set(sx, 0.34, -sz);
    wheels.rl.position.set(-sx, 0.34, sz);
    wheels.rr.position.set(-sx, 0.34, -sz);
    mesh.add(hull, cabin, wheels.fl, wheels.fr, wheels.rl, wheels.rr);
    mesh.position.set(node.x, 0, node.z);
    mesh.rotation.y = 0;
    this.group.add(mesh);
    const ai: TrafficAI = {
      vehicle: null as unknown as Vehicle,
      wheels,
      path,
      next: 0,
      cruise: 10,
      stuckTimer: 5,
      aiActive: true,
      lastX: node.x,
      lastZ: node.z,
      wheelSpin: 0,
    };
    const vehicle: Vehicle = {
      spec: this.makeTrafficSpec(0, isVan),
      position: new THREE.Vector3(node.x, 0, node.z),
      yaw: 0,
      speed: 0,
      lateralSpeed: 0,
      mesh,
      driven: false,
      shape: 'traffic',
      role: 'traffic',
      exitSide: (driverSide: 'left' | 'right'): XZ => this.exitPoint(ai.vehicle, driverSide),
    };
    ai.vehicle = vehicle;
    this.cars.push(ai);
    this.trafficVehicles.push(vehicle);
  }

  /** Exit point beside a traffic car. driverSide 'left' = the driver's left of the heading. */
  private exitPoint(v: Vehicle, driverSide: 'left' | 'right'): XZ {
    const hx = Math.sin(v.yaw);
    const hz = Math.cos(v.yaw);
    const side = driverSide === 'left' ? 1 : -1;
    const half = (v.spec?.width ?? 1.8) * 0.5 + 0.9;
    // Left of heading (sin,cos) is (cos, -sin).
    return { x: v.position.x + hz * side * half, z: v.position.z - hx * side * half };
  }

  /* ------------------------------ update -------------------------------- */

  update(dt: number, playerPos: XZ, drivenVehicle: Vehicle | null): void {
    if (this.disposed) return;
    const step = !Number.isFinite(dt) || dt <= 0 ? STEP_DT : Math.min(dt, 0.25);
    this.time += step;

    const carXs = this.carXs;
    const carZs = this.carZs;
    const carHx = this.carHx;
    const carHz = this.carHz;
    carXs.length = 0;
    carZs.length = 0;
    carHx.length = 0;
    carHz.length = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const v = this.cars[i].vehicle;
      carXs.push(v.position.x);
      carZs.push(v.position.z);
      carHx.push(Math.sin(v.yaw));
      carHz.push(Math.cos(v.yaw));
    }
    const hasPlayer = !!drivenVehicle && Number.isFinite(drivenVehicle.position.x) && Number.isFinite(drivenVehicle.position.z);

    /* -------------------------------- peds -------------------------------- */
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      let target = ped.baseSpeed;
      // 1) Same-loop spacing: nearest ped behind us -> ease off (accelerate if clear).
      let nearestBehind = Infinity;
      for (let j = 0; j < this.peds.length; j++) {
        if (j === i) continue;
        const o = this.peds[j];
        if (o.path !== ped.path) continue;
        let behind = ped.dist - o.dist;
        if (behind <= 0) behind += ped.path.total;
        if (behind < nearestBehind) nearestBehind = behind;
      }
      if (nearestBehind < NPC_CONFIG.pedSpacing) {
        target *= lerp(0.3, 1, nearestBehind / NPC_CONFIG.pedSpacing);
      }
      // 2) Player / driven car just ahead -> step aside + slow down.
      const probeX = ped.x + Math.sin(ped.yaw) * 1.2;
      const probeZ = ped.z + Math.cos(ped.yaw) * 1.2;
      let dodge = 0;
      if (hasPlayer) {
        const hx = Math.sin(ped.yaw);
        const hz = Math.cos(ped.yaw);
        const gp = Math.hypot(playerPos.x - probeX, playerPos.z - probeZ);
        const gpBehind = behindHeading(playerPos.x, playerPos.z, hx, hz, probeX, probeZ);
        if (gp < NPC_CONFIG.pedAvoidRadius && gpBehind) dodge = 1;
        if (drivenVehicle) {
          const vx = drivenVehicle.position.x;
          const vz = drivenVehicle.position.z;
          const gv = Math.hypot(vx - probeX, vz - probeZ);
          const gvBehind = behindHeading(vx, vz, hx, hz, probeX, probeZ);
          if (gv < NPC_CONFIG.pedAvoidRadius + 1.6 && gvBehind) dodge = Math.max(dodge, 1);
        }
      }
      if (dodge > 0) {
        // Step toward the building side of the sidewalk (away from the kerb): that is the
        // safe side, and keeps the ped on the pavement.
        ped.insetTarget = Math.min(ped.path.inMax, ped.inset + 1.1);
        target = Math.min(target, 0.35);
      } else if (this.time - (i * 0.7) > 0) {
        // Slowly drift back toward the kerb.
        ped.insetTarget = Math.max(ped.path.inMin, ped.insetTarget - 0.25 * step);
      }
      ped.inset = lerp(ped.inset, clamp(ped.insetTarget, ped.path.inMin, ped.path.inMax), Math.min(1, step * 3));

      if (ped.bumpHold > 0) {
        ped.bumpHold = Math.max(0, ped.bumpHold - step);
        target = 0;
      }
      ped.speed = target;

      const prevX = ped.x;
      const prevZ = ped.z;
      // Advance along the loop (the corner order makes the ped "turn" the ring).
      ped.dist += target * step;
      if (ped.dist >= ped.path.total) ped.dist -= ped.path.total;
      if (ped.dist < 0) ped.dist += ped.path.total;
      this.placePed(ped);
      // Wall safety: never leave the pavement; hold still and re-try next tick.
      if (!this.isWalkable(ped.x, ped.z)) {
        ped.x = prevX;
        ped.z = prevZ;
        ped.bumpHold = 0.5;
      } else if (target > 0) {
        ped.walkPhase = (ped.walkPhase + target * step * 3.6) % TWO_PI;
      }

      // Visuals: position, facing, leg swing, small body bob + idle head turn.
      ped.root.position.set(ped.x, 0, ped.z);
      ped.root.rotation.y = ped.yaw;
      const moving = ped.speed > 0.05 ? 1 : 0;
      const swing = Math.sin(ped.walkPhase) * (0.18 + 0.45 * moving);
      ped.legL.rotation.x = swing;
      ped.legR.rotation.x = -swing;
      ped.root.position.y = Math.abs(Math.sin(ped.walkPhase)) * 0.05 * moving;
      ped.head.rotation.y = Math.sin(this.time * 0.9 + i) * 0.22 * (1 - moving * 0.6);
    }

    /* ------------------------------- traffic ------------------------------ */
    for (let ci = 0; ci < this.cars.length; ci++) {
      const ai = this.cars[ci];
      const v = ai.vehicle;
      if (!ai.aiActive || this.handedOver.has(v)) continue; // the Lead drives it
      const px = v.position.x;
      const pz = v.position.z;
      if (!Number.isFinite(px) || !Number.isFinite(pz)) {
        v.position.x = 0;
        v.position.z = 0;
        v.speed = 0;
        continue;
      }
      // Keep a waypoint to chase (re-path when the path is exhausted).
      if (ai.next >= ai.path.length) this.repath(ai, px, pz);
      // Advance past waypoints we already reached.
      let target = ai.path[ai.next];
      let dx = target.x - px;
      let dz = target.z - pz;
      let dist = Math.hypot(dx, dz);
      const passRadius = 2.4 + Math.abs(v.speed) * step;
      let guard = 0;
      while (dist < passRadius && guard++ < 8) {
        ai.next++;
        if (ai.next >= ai.path.length) {
          this.repath(ai, px, pz);
          if (ai.path.length === 0) break;
        }
        target = ai.path[ai.next];
        dx = target.x - px;
        dz = target.z - pz;
        dist = Math.hypot(dx, dz);
      }
      // Smooth steering: turn-rate limited toward the waypoint.
      const desiredYaw = Math.atan2(dx, dz);
      const dYaw = angleDelta(v.yaw, desiredYaw);
      const maxTurn = NPC_CONFIG.carTurnRate * step;
      v.yaw = wrapAngle(v.yaw + clamp(dYaw, -maxTurn, maxTurn));
      const hx = Math.sin(v.yaw);
      const hz = Math.cos(v.yaw);

      // Target speed: cruise, reduced at bends and when-avoiding.
      let targetSpeed = ai.cruise;
      if (Math.abs(dYaw) > 0.25) targetSpeed *= lerp(0.3, 1, clamp(1 - (Math.abs(dYaw) - 0.25) / 0.9, 0, 1));
      // Bend ahead (intersection-like corner) -> crawl.
      const look = ai.path[Math.min(ai.path.length - 1, ai.next + NPC_CONFIG.carBendLookAhead - 1)];
      if (look && look !== target) {
        const bend = Math.abs(angleDelta(Math.atan2(target.x - px, target.z - pz), Math.atan2(look.x - target.x, look.z - target.z)));
        if (bend > 0.35) targetSpeed *= 0.45;
      }
      // Other cars ahead in our heading.
      for (let oi = 0; oi < this.cars.length; oi++) {
        if (oi === ci) continue;
        const ox = carXs[oi];
        const oz = carZs[oi];
        const along = (ox - px) * hx + (oz - pz) * hz;
        if (along <= 0.2) continue;
        const perp = lateralTo(px, pz, hx, hz, ox, oz);
        const sameDir = hx * carHx[oi] + hz * carHz[oi] > 0.35;
        const gate = sameDir ? NPC_CONFIG.carFollowGap : 3.6;
        if (perp < (sameDir ? 2.6 : 2.4) && along < gate) {
          // Follow gap: speed proportional to free space.
          const free = Math.max(0, along - 2.6) / (gate - 2.6);
          targetSpeed = Math.min(targetSpeed, lerp(0, ai.cruise, free) * (sameDir ? 1 : 0.4));
        }
      }
      // Player-driven car right in front of our nose: brake.
      if (hasPlayer && drivenVehicle) {
        const along = (drivenVehicle.position.x - px) * hx + (drivenVehicle.position.z - pz) * hz;
        const perp = lateralTo(px, pz, hx, hz, drivenVehicle.position.x, drivenVehicle.position.z);
        if (along > 0.2 && perp < 2.7 && along < NPC_CONFIG.carPlayerGap) {
          const free = clamp((along - 2.8) / (NPC_CONFIG.carPlayerGap - 2.8), 0, 1);
          targetSpeed = Math.min(targetSpeed, lerp(0, ai.cruise, free));
        }
      }
      // Accelerate / brake toward the target speed.
      if (targetSpeed > v.speed) v.speed = Math.min(targetSpeed, v.speed + 6.5 * step);
      else v.speed = Math.max(targetSpeed, v.speed - 22 * step);
      if (v.speed < 0) v.speed = 0;

      // Integrate on the lane.
      let nx = px + hx * v.speed * step;
      let nz = pz + hz * v.speed * step;
      // Safety net: never sit inside a building (push out at 3 sample points along the car).
      const halfLen = (v.spec?.length ?? NPC_CONFIG.carLen) * 0.35;
      const noseX = nx + hx * halfLen;
      const noseZ = nz + hz * halfLen;
      const tailX = nx - hx * halfLen;
      const tailZ = nz - hz * halfLen;
      if (this.world.overlapsCircle(noseX, noseZ, 1.0) || this.world.overlapsCircle(tailX, tailZ, 1.0)) {
        const r = this.world.resolveCircle(nx, nz, 1.2);
        if (Number.isFinite(r.x) && Number.isFinite(r.z)) {
          nx = r.x;
          nz = r.z;
          v.speed *= 0.75;
        }
      }
      // Hard bound clamp (a malformed graph node can never push a car off the map).
      const b = this.world.bounds;
      if (b && Number.isFinite(b.minX)) {
        nx = clamp(nx, b.minX + 1, b.maxX - 1);
        nz = clamp(nz, b.minZ + 1, b.maxZ - 1);
      }
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) {
        nx = px;
        nz = pz;
        v.speed = 0;
      }
      v.position.set(nx, 0, nz);
      v.lateralSpeed = 0;

      // Stuck recovery: if we barely moved for ~5 s, pick a fresh path from here.
      ai.stuckTimer -= step;
      if (ai.stuckTimer <= 0) {
        const moved = Math.hypot(px - ai.lastX, pz - ai.lastZ);
        if (moved < 0.6) {
          // Nudge: continue toward the current target's *next* waypoint from a fresh path.
          ai.path = [];
          this.repath(ai, px, pz);
          v.speed = 0;
        }
        ai.lastX = px;
        ai.lastZ = pz;
        ai.stuckTimer = 5;
      }

      // Visual sync (wheels spin too).
      ai.wheelSpin = (ai.wheelSpin + v.speed * step / 0.34) % TWO_PI;
      v.mesh.position.copy(v.position);
      v.mesh.rotation.y = v.yaw;
      const w = ai.wheels;
      w.rl.rotation.x = -ai.wheelSpin;
      w.rr.rotation.x = -ai.wheelSpin;
      w.fl.rotation.x = -ai.wheelSpin;
      w.fr.rotation.x = -ai.wheelSpin;
    }
  }

  /** Choose a fresh path from the node nearest to (x,z). */
  private repath(ai: TrafficAI, x: number, z: number): void {
    const g = this.world.roadGraph;
    let nodeId = ai.next > 0 && ai.path.length > 0 ? g.nearestNode(ai.path[ai.path.length - 1].x, ai.path[ai.path.length - 1].z) : g.nearestNode(x, z);
    if (!Number.isFinite(nodeId)) nodeId = g.nearestNode(x, z);
    ai.path = this.safePath(nodeId, 120);
    ai.next = 0;
    if (ai.path.length === 0) {
      // Degenerate graph: stay put, try again in a moment.
      ai.path.push({ x, z });
      ai.next = 0;
    }
  }

  /** pathFrom() with defensive wrapping; always returns a usable XZ[]. */
  private safePath(startNode: number, stopDistance: number): XZ[] {
    const g = this.world.roadGraph;
    try {
      const raw = g.pathFrom(startNode, stopDistance, this.rng);
      if (Array.isArray(raw)) {
        const out: XZ[] = [];
        for (const p of raw) if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) out.push(p);
        return out;
      }
    } catch {
      /* fall through */
    }
    const node = g.nodes?.find((n) => n.id === startNode) ?? g.nodes?.[0];
    return node ? [{ x: node.x, z: node.z }] : [];
  }

  /* ------------------------------ public API ---------------------------- */

  /**
   * Detach a traffic car from AI control (call when the player enters/jacks it,
   * BEFORE the Lead's own vehicle system starts moving it). Idempotent.
   * Returns true when `vehicle` is one of `trafficVehicles`.
   */
  takeOver(vehicle: Vehicle): boolean {
    for (let i = 0; i < this.cars.length; i++) {
      const ai = this.cars[i];
      if (ai.vehicle !== vehicle) continue;
      ai.aiActive = false;
      this.handedOver.add(vehicle);
      vehicle.role = 'player';
      vehicle.driven = true;
      vehicle.speed = 0;
      vehicle.lateralSpeed = 0;
      return true;
    }
    return false;
  }

  /** Give a taken-over car back to the AI (e.g. the player abandons it). */
  handBack(vehicle: Vehicle): boolean {
    for (let i = 0; i < this.cars.length; i++) {
      const ai = this.cars[i];
      if (ai.vehicle !== vehicle) continue;
      this.handedOver.delete(vehicle);
      ai.aiActive = true;
      vehicle.role = 'traffic';
      vehicle.driven = false;
      vehicle.speed = 0;
      vehicle.lateralSpeed = 0;
      ai.path = [];
      this.repath(ai, vehicle.position.x, vehicle.position.z);
      ai.lastX = vehicle.position.x;
      ai.lastZ = vehicle.position.z;
      ai.stuckTimer = 5;
      return true;
    }
    return false;
  }

  /** Is the AI currently driving this vehicle (i.e. not taken over)? */
  isAIControlled(vehicle: Vehicle): boolean {
    for (let i = 0; i < this.cars.length; i++) if (this.cars[i].vehicle === vehicle) return this.cars[i].aiActive;
    return false;
  }

  vehicleCount(): number {
    return this.trafficVehicles.length;
  }

  /** Downsampled positions for the minimap (<= 48 cars, <= 48 peds; buffers reused). */
  minimapData(): { cars: XZ[]; peds: XZ[] } {
    const cars = this.minimapCars;
    cars.length = 0;
    const carStep = Math.max(1, Math.ceil(this.cars.length / 48));
    for (let i = 0; i < this.cars.length; i += carStep) {
      const v = this.cars[i].vehicle;
      if (Number.isFinite(v.position.x) && Number.isFinite(v.position.z)) cars.push({ x: v.position.x, z: v.position.z });
    }
    const peds = this.minimapPeds;
    peds.length = 0;
    const pedStep = Math.max(1, Math.ceil(this.peds.length / 48));
    for (let i = 0; i < this.peds.length; i += pedStep) peds.push({ x: this.peds[i].x, z: this.peds[i].z });
    return { cars, peds };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.parent?.remove(this.group);
    this.group.clear();
    for (const g of this.pedGeos) g.dispose();
    for (const g of this.carGeos) g.dispose();
    for (const m of this.pedMats) m.dispose();
    this.carMat.dispose();
    this.pedGeos.length = 0;
    this.carGeos.length = 0;
    this.pedMats.length = 0;
    this.peds.length = 0;
    this.cars.length = 0;
    this.paths.length = 0;
    this.trafficVehicles.length = 0;
    this.minimapCars.length = 0;
    this.minimapPeds.length = 0;
  }
}

/**
 * Factory: builds the NPC system and adds its group to `scene`.
 * (Also available as `system.group` if the Lead prefers to parent it itself.)
 */
export function createNPCSystem(scene: THREE.Scene | THREE.Group, world: CityWorld, seed?: number): NpcSystem {
  return new NpcSystem(scene, world, seed);
}
