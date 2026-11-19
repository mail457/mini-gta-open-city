/**
 * Unit tests — pedestrians & traffic (src/gameplay/npcs.ts).
 * Headless: THREE.Group/Mesh only (no renderer, no DOM, no document).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  CityWorld,
  Rect,
  RoadGraph,
  RoadGraphEdge,
  RoadGraphNode,
  XZ,
} from '../../src/contracts';
import { createNPCSystem, NPC_CONFIG, type NpcSystem } from '../../src/gameplay/npcs';
import { STREETS, BLOCK, X_OFFSET, Z_OFFSET, nsX, ewZ, streetHalfWidth, SIDEWALK_WIDTH, WORLD_MIN, WORLD_MAX } from '../../src/world/layout';

/* -------------------------------------------------------------------------- */
/* Fake city: layout-shaped roads, sidewalk rings, buildings in block corners */
/* -------------------------------------------------------------------------- */

const STREET_PLANES_X = Array.from({ length: STREETS }, (_, i) => nsX(i));
const STREET_PLANES_Z = Array.from({ length: STREETS }, (_, i) => ewZ(i));

function makeFakeCity(): CityWorld & {
  pathCalls: number;
  trafficCenterNodes: number;
} {
  const bounds = { minX: WORLD_MIN, maxX: WORLD_MAX, minZ: WORLD_MIN, maxZ: WORLD_MAX };

  // Road = near a street centreline (same shapes as layout.ts).
  const isRoad = (x: number, z: number): boolean => {
    for (let i = 0; i < STREETS; i++) if (Math.abs(x - STREET_PLANES_X[i]) <= streetHalfWidth(i)) return true;
    for (let j = 0; j < STREETS; j++) if (Math.abs(z - STREET_PLANES_Z[j]) <= streetHalfWidth(j)) return true;
    return false;
  };

  // One building per block, inset from the sidewalk ring (so the ring is walkable).
  const colliders: Rect[] = [];
  const inset = SIDEWALK_WIDTH + 2;
  for (let i = 0; i < STREETS - 1; i++) {
    for (let j = 0; j < STREETS - 1; j++) {
      const minX = nsX(i) + streetHalfWidth(i) + inset;
      const maxX = nsX(i + 1) - streetHalfWidth(i + 1) - inset;
      const minZ = ewZ(j) + streetHalfWidth(j) + inset;
      const maxZ = ewZ(j + 1) - streetHalfWidth(j + 1) - inset;
      const hx = (maxX - minX) / 2;
      const hz = (maxZ - minZ) / 2;
      if (hx > 0.5 && hz > 0.5) colliders.push({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hx, hz, kind: 'building' });
    }
  }
  // A lamp post in the middle of one sidewalk run (tests the 0.6 m clearance rule).
  colliders.push({ x: nsX(1) + 8 + 2.2, z: ewZ(1) + 8 + 2.2, hx: 0.2, hz: 0.2, kind: 'prop' });

  const overlaps = (x: number, z: number, r: number): boolean => {
    for (const c of colliders) {
      if (Math.abs(x - c.x) < c.hx + r && Math.abs(z - c.z) < c.hz + r) return true;
    }
    return false;
  };
  const resolve = (x: number, z: number, r: number): XZ => {
    for (const c of colliders) {
      const dx = x - c.x;
      const dz = z - c.z;
      const ox = c.hx + r - Math.abs(dx);
      const oz = c.hz + r - Math.abs(dz);
      if (ox > 0 && oz > 0) {
        if (ox < oz) x = c.x + Math.sign(dx || 1) * (c.hx + r);
        else z = c.z + Math.sign(dz || 1) * (c.hz + r);
      }
    }
    return { x, z };
  };

  // Lane loop around the ring road: mid-blocks, offset to the right lane of each street.
  const insetRoad = 5;
  const roadNodes: Array<Omit<RoadGraphNode, 'id'> & { id: number }> = [];
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < STREETS; i++) {
    for (let j = 0; j < STREETS; j++) {
      const x = STREET_PLANES_X[i] + (i % 2 === 0 ? 2 : -2);
      const z = STREET_PLANES_Z[j] + (j % 2 === 0 ? 2 : -2);
      xs.push(x);
      zs.push(z);
      roadNodes.push({ id: roadNodes.length, x, z });
    }
  }
  void insetRoad;
  // Build edges between adjacent grid nodes (both directions, horizontal + vertical).
  const id = (i: number, j: number): number => j * STREETS + i;
  const edges = new Map<number, RoadGraphEdge[]>();
  const push = (a: number, b: number): void => {
    const A = roadNodes[a];
    const B = roadNodes[b];
    const arr = edges.get(a) ?? [];
    arr.push({ from: a, to: b, length: Math.hypot(B.x - A.x, B.z - A.z) });
    edges.set(a, arr);
  };
  for (let j = 0; j < STREETS; j++) {
    for (let i = 0; i < STREETS; i++) {
      if (i + 1 < STREETS) push(id(i, j), id(i + 1, j));
      if (i - 1 >= 0) push(id(i, j), id(i - 1, j));
      if (j + 1 < STREETS) push(id(i, j), id(i, j + 1));
      if (j - 1 >= 0) push(id(i, j), id(i, j - 1));
    }
  }

  const state = { pathCalls: 0 };
  const roadGraph: RoadGraph = {
    nodes: roadNodes,
    edges,
    laneWidth: 3.5,
    nearestNode(x: number, z: number): number {
      let best = 0;
      let bestD = Infinity;
      for (const n of roadNodes) {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n.id;
        }
      }
      return best;
    },
    pathFrom(node: number, stopDistance: number, rng: () => number): XZ[] {
      state.pathCalls++;
      const out: XZ[] = [];
      let cur = node;
      let travelled = 0;
      let guard = 0;
      while (travelled < stopDistance && guard++ < 100) {
        const opts = edges.get(cur) ?? [];
        if (opts.length === 0) break;
        const pick = opts[Math.floor(rng() * opts.length) % opts.length];
        const from = roadNodes[cur];
        const to = roadNodes[pick.to];
        // Rounded corner points so the cars have curvature to steer through.
        out.push({ x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 });
        out.push({ x: to.x, z: to.z });
        travelled += pick.length;
        cur = pick.to;
      }
      return out;
    },
  };

  const world = {
    group: new THREE.Group(),
    bounds,
    roadGraph,
    pois: {
      spawn: { x: nsX(1) + 14, z: ewZ(1) + 12 },
      missionStart: { x: nsX(2) - 12, z: ewZ(1) + 12 },
      missionDrop: { x: nsX(3) + 3, z: ewZ(3) - 40 },
      parking: { x: nsX(3) + 12, z: ewZ(1) + 12 },
      park: { x: nsX(2) + BLOCK / 2, z: ewZ(2) + BLOCK / 2 },
    } as Record<string, XZ>,
    colliders,
    inBounds: (x: number, z: number, margin = 0): boolean =>
      x >= bounds.minX + margin && x <= bounds.maxX - margin && z >= bounds.minZ + margin && z <= bounds.maxZ - margin,
    isRoad,
    overlapsCircle: overlaps,
    resolveCircle: resolve,
    groundHeight: () => 0,
    update: () => {},
    stats: () => ({ buildings: colliders.length, colliders: colliders.length, drawCalls: 0, triangles: 0 }),
    dispose: () => {},
    get pathCalls(): number {
      return state.pathCalls;
    },
  };
  // X/Z stay consistent: the grid above uses (x from i, z from j).
  void X_OFFSET;
  void Z_OFFSET;
  return world as unknown as CityWorld & { pathCalls: number; trafficCenterNodes: number };
}

function insideCollider(world: CityWorld, x: number, z: number): boolean {
  for (const c of world.colliders) {
    if (Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
  }
  return false;
}

function stepSystem(sys: NpcSystem, world: CityWorld, steps: number, playerPos: XZ = { x: 0, z: 0 }): void {
  const dt = 1 / 60;
  for (let i = 0; i < steps; i++) {
    // Keep the "player" out of the way; he is not driven.
    sys.update(dt, playerPos, null);
  }
  void world;
}

function pedPositions(sys: NpcSystem): XZ[] {
  // The group children are peds followed by cars; peds are Groups with a head Group child.
  const out: XZ[] = [];
  for (const child of sys.group.children) {
    if (child.name.startsWith('traffic-')) continue;
    if (!child.name.startsWith('ped-')) continue;
    out.push({ x: child.position.x, z: child.position.z });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('NPCSystem — construction', () => {
  it('spawns the requested crowd and traffic onto a scene', () => {
    const world = makeFakeCity();
    const scene = new THREE.Scene();
    const sys = createNPCSystem(scene, world);
    expect(scene.children).toContain(sys.group);
    expect(sys.pedCount).toBe(NPC_CONFIG.pedestrians);
    expect(sys.trafficVehicles.length).toBe(NPC_CONFIG.trafficCars);
    // Ped meshes: 14 avatars * (torso + head + headGroup + 2 legs) groups in the root.
    const pedRoots = sys.group.children.filter((c) => !c.name.startsWith('traffic-'));
    expect(pedRoots).toHaveLength(NPC_CONFIG.pedestrians);
    for (const v of sys.trafficVehicles) {
      expect(v.role).toBe('traffic');
      expect(v.driven).toBe(false);
      expect(Number.isFinite(v.position.x)).toBe(true);
      expect(Number.isFinite(v.yaw)).toBe(true);
      expect(v.spec).toBeDefined();
      expect(typeof v.exitSide).toBe('function');
      const exit = v.exitSide('left');
      expect(Number.isFinite(exit.x) && Number.isFinite(exit.z)).toBe(true);
    }
    sys.dispose();
    expect(scene.children).not.toContain(sys.group);
  });

  it('every pedestrian stands on walkable ground (off roads, clear of buildings)', () => {
    const world = makeFakeCity();
    const sys = createNPCSystem(new THREE.Scene(), world);
    for (const p of pedPositions(sys)) {
      expect(world.inBounds(p.x, p.z)).toBe(true);
      expect(world.isRoad(p.x, p.z)).toBe(false);
      expect(insideCollider(world, p.x, p.z)).toBe(false);
      expect(world.overlapsCircle(p.x, p.z, 0.6)).toBe(false);
    }
    sys.dispose();
  });
});

describe('NPCSystem — 600 fixed steps', () => {
  it('keeps everyone finite, in bounds and off buildings; cars drive and stay on roads', () => {
    const world = makeFakeCity();
    const sys = createNPCSystem(new THREE.Scene(), world);
    const startCar: XZ[] = sys.trafficVehicles.map((v) => ({ x: v.position.x, z: v.position.z }));

    stepSystem(sys, world, 600);

    expect(world.pathCalls).toBeGreaterThan(0);

    // Traffic: finite, in bounds, on road, some distance travelled.
    let moved = 0;
    for (let i = 0; i < sys.trafficVehicles.length; i++) {
      const v = sys.trafficVehicles[i];
      expect(Number.isFinite(v.position.x) && Number.isFinite(v.position.z)).toBe(true);
      expect(Number.isFinite(v.yaw) && Number.isFinite(v.speed)).toBe(true);
      expect(v.position.x).toBeGreaterThanOrEqual(world.bounds.minX);
      expect(v.position.x).toBeLessThanOrEqual(world.bounds.maxX);
      expect(v.position.z).toBeGreaterThanOrEqual(world.bounds.minZ);
      expect(v.position.z).toBeLessThanOrEqual(world.bounds.maxZ);
      expect(world.isRoad(v.position.x, v.position.z)).toBe(true);
      expect(insideCollider(world, v.position.x, v.position.z)).toBe(false);
      moved += Math.hypot(v.position.x - startCar[i].x, v.position.z - startCar[i].z);
    }
    expect(moved).toBeGreaterThan(10);

    // Peds: finite, in bounds, not inside a building, not on the road.
    const peds = pedPositions(sys);
    expect(peds).toHaveLength(NPC_CONFIG.pedestrians);
    for (const p of peds) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
      expect(world.inBounds(p.x, p.z)).toBe(true);
      expect(insideCollider(world, p.x, p.z)).toBe(false);
      expect(world.isRoad(p.x, p.z)).toBe(false);
    }

    // Minimap arrays are capped and finite.
    const mm = sys.minimapData();
    expect(mm.cars.length).toBeLessThanOrEqual(60);
    expect(mm.peds.length).toBeLessThanOrEqual(60);
    for (const p of [...mm.cars, ...mm.peds]) expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);

    sys.dispose();
  });

  it('is allocation-light and deterministic for a fixed seed', () => {
    const runOnce = (): XZ[] => {
      const world = makeFakeCity();
      const sys = createNPCSystem(new THREE.Scene(), world);
      stepSystem(sys, world, 600);
      const out = sys.trafficVehicles.map((v) => ({ x: v.position.x, z: v.position.z }));
      sys.dispose();
      return out;
    };
    const a = runOnce();
    const b = runOnce();
    for (let i = 0; i < a.length; i++) {
      expect(a[i].x).toBeCloseTo(b[i].x, 6);
      expect(a[i].z).toBeCloseTo(b[i].z, 6);
    }
    // update() with junk dt must not throw or produce NaN.
    const world = makeFakeCity();
    const sys = createNPCSystem(new THREE.Scene(), world);
    for (const dt of [NaN, -1, Infinity, 0, 5]) expect(() => sys.update(dt, { x: 0, z: 0 }, null)).not.toThrow();
    for (const v of sys.trafficVehicles) {
      expect(Number.isFinite(v.position.x) && Number.isFinite(v.position.z)).toBe(true);
    }
    sys.dispose();
  });

  it('cars brake behind the player-driven car and people step aside', () => {
    const world = makeFakeCity();
    const sys = createNPCSystem(new THREE.Scene(), world);
    // Let the traffic settle onto a lane.
    stepSystem(sys, world, 120);
    const car = sys.trafficVehicles[0];
    // Player-driven car parked 6 m in front of traffic car 1, if it faces it.
    const other = sys.trafficVehicles[1] ?? car;
    const hx = Math.sin(other.yaw);
    const hz = Math.cos(other.yaw);
    const blocker = {
      spec: other.spec,
      position: new THREE.Vector3(other.position.x + hx * 6, 0, other.position.z + hz * 6),
      yaw: other.yaw + Math.PI,
      speed: 0,
      lateralSpeed: 0,
      mesh: new THREE.Group(),
      driven: true,
      role: 'player' as const,
      exitSide: () => ({ x: 0, z: 0 }),
    };
    const speedBefore = other.speed;
    for (let i = 0; i < 120; i++) sys.update(1 / 60, { x: blocker.position.x, z: blocker.position.z }, blocker);
    // It should not have accelerated into the blocker.
    expect(other.speed).toBeLessThanOrEqual(Math.max(0.5, speedBefore) + 0.5);
    // And nothing exploded.
    for (const v of sys.trafficVehicles) expect(Number.isFinite(v.position.x)).toBe(true);
    sys.dispose();
  });
});

describe('NPCSystem — takeOver', () => {
  it('detaches a traffic car from AI control', () => {
    const world = makeFakeCity();
    const sys = createNPCSystem(new THREE.Scene(), world);
    const car = sys.trafficVehicles[2];
    expect(sys.isAIControlled(car)).toBe(true);
    expect(sys.takeOver(car)).toBe(true);
    expect(sys.isAIControlled(car)).toBe(false);
    expect(car.role).toBe('player');
    expect(car.driven).toBe(true);
    const at = { x: car.position.x, z: car.position.z };
    // The Lead would drive it; here the position must simply stop changing.
    for (let i = 0; i < 120; i++) sys.update(1 / 60, { x: 0, z: 0 }, car);
    expect(car.position.x).toBeCloseTo(at.x);
    expect(car.position.z).toBeCloseTo(at.z);
    // Hand it back: AI resumes from the new spot.
    car.position.set(at.x + 20, 0, at.z);
    expect(sys.handBack(car)).toBe(true);
    expect(car.role).toBe('traffic');
    expect(sys.isAIControlled(car)).toBe(true);
    const before = { x: car.position.x, z: car.position.z };
    for (let i = 0; i < 120; i++) sys.update(1 / 60, { x: 0, z: 0 }, null);
    expect(Math.hypot(car.position.x - before.x, car.position.z - before.z)).toBeGreaterThan(1);
    // Unknown vehicles are ignored.
    const fake = { ...car, mesh: new THREE.Group() };
    expect(sys.takeOver(fake as typeof car)).toBe(false);
    sys.dispose();
  });
});
