/**
 * Unit tests — "THE DELIVERY RUN" mission (src/gameplay/mission.ts).
 * Headless: only THREE.Group / Mesh objects, no renderer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  AudioBus,
  CityWorld,
  HudApi,
  HudData,
  MissionEnv,
  MissionResultView,
  PlayerController,
  RoadGraph,
  RoadGraphEdge,
  RoadGraphNode,
  SoundName,
  Vehicle,
  VehicleSpec,
  XZ,
} from '../../src/contracts';
import { createMission, formatClock, MISSION_CONFIG } from '../../src/gameplay/mission';
import { createGameState, GameState } from '../../src/gameplay/gameState';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

const SPEC: VehicleSpec = {
  id: 'sedan',
  label: 'Sedan',
  maxSpeed: 30,
  maxReverse: 6,
  accel: 8,
  brake: 14,
  steerRate: 1.8,
  grip: 0.8,
  length: 4,
  width: 1.8,
  height: 1.5,
  color: 0x3d6fd1,
};

/** Tiny hand-built square lane loop (clockwise), all on the fake road. */
function makeRoadGraph(): RoadGraph & { pathCalls: number } {
  const nodes: RoadGraphNode[] = [
    { id: 0, x: -20, z: -20 },
    { id: 1, x: 20, z: -20 },
    { id: 2, x: 20, z: 20 },
    { id: 3, x: -20, z: 20 },
  ];
  const edges = new Map<number, RoadGraphEdge[]>();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    edges.set(a.id, [{ from: a.id, to: b.id, length: Math.hypot(b.x - a.x, b.z - a.z) }]);
  }
  const graph = {
    nodes,
    edges,
    laneWidth: 3,
    pathCalls: 0,
    nearestNode(x: number, z: number): number {
      let best = 0;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n.id;
        }
      }
      return best;
    },
    /** Walk the loop from `node` until stopDistance is covered. */
    pathFrom(node: number, stopDistance: number, _rng: () => number): XZ[] {
      graph.pathCalls++;
      const out: XZ[] = [];
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const start = byId.get(node) ?? nodes[0];
      let pos = { x: start.x, z: start.z };
      let cur = start.id;
      let travelled = 0;
      let guard = 0;
      while (travelled < stopDistance && guard++ < 64) {
        const next = edges.get(cur)![0].to;
        const t = byId.get(next)!;
        // Two intermediate points so the car has something to steer toward.
        for (let k = 1; k <= 2; k++) {
          out.push({ x: pos.x + ((t.x - pos.x) * k) / 2, z: pos.z + ((t.z - pos.z) * k) / 2 });
        }
        travelled += Math.hypot(t.x - pos.x, t.z - pos.z);
        pos = { x: t.x, z: t.z };
        cur = next;
      }
      return out;
    },
  };
  return graph as unknown as RoadGraph & { pathCalls: number };
}

class FakePlayer implements PlayerController {
  readonly object = new THREE.Group();
  position = new THREE.Vector3(0, 0, 0);
  yaw = 0;
  speed = 0;
  isGrounded = true;
  onFoot = true;
  walkPhase = 0;
  didJump = false;
  update(): void {}
  setPosition(x: number, z: number, yaw = 0): void {
    this.position.set(x, 0, z);
    this.yaw = yaw;
  }
  dispose(): void {}
}

class FakeAudio implements AudioBus {
  readonly played: Array<{ name: SoundName; volume: number | undefined }> = [];
  play(name: SoundName, volume?: number): void {
    this.played.push({ name, volume });
  }
  setEngine(): void {}
  setMuted(): void {}
  dispose(): void {}
}

class FakeHud implements HudApi {
  crosshairVisible = false;
  hitMarkers = 0;
  setCrosshair(v: boolean): void { this.crosshairVisible = v; }
  pulseHitMarker(): void { this.hitMarkers++; }
  readonly toasts: Array<{ text: string; kind: string }> = [];
  readonly results: MissionResultView[] = [];
  updates = 0;
  update(_data: HudData): void {
    this.updates++;
  }
  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    this.toasts.push({ text, kind });
  }
  showMissionResult(result: MissionResultView): void {
    this.results.push(result);
  }
  clearMissionResult(): void {}
}

class FakeWorld implements CityWorld {
  kerbBlocking = true;
  readonly group = new THREE.Group();
  bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
  readonly roadGraph = makeRoadGraph();
  readonly pois: Record<string, XZ> = {
    spawn: { x: 0, z: 30 },
    missionStart: { x: 6, z: -10 },
    missionDrop: { x: -20, z: 20 },
    parking: { x: 28, z: 28 },
    park: { x: 0, z: 0 },
  };
  readonly colliders = [{ x: 0, z: 0, hx: 10, hz: 10 }];
  isRoad(x: number, z: number): boolean {
    return Math.abs(x) <= 20 || Math.abs(z) <= 20;
  }
  resolveCircle(x: number, z: number): XZ {
    return { x, z };
  }
  overlapsCircle(x: number, z: number, r: number): boolean {
    const c = this.colliders[0];
    return Math.abs(x - c.x) < c.hx + r && Math.abs(z - c.z) < c.hz + r;
  }
  inBounds(x: number, z: number, margin = 0): boolean {
    const b = this.bounds;
    return x >= b.minX + margin && x <= b.maxX - margin && z >= b.minZ + margin && z <= b.maxZ - margin;
  }
  groundHeight(): number {
    return 0;
  }
  update(): void {}
  stats() {
    return { buildings: 1, colliders: 1, drawCalls: 0, triangles: 0 };
  }
  dispose(): void {}
}

function makeVehicle(x: number, z: number): Vehicle {
  return {
    spec: SPEC,
    position: new THREE.Vector3(x, 0, z),
    yaw: 0,
    speed: 0,
    lateralSpeed: 0,
    mesh: new THREE.Group(),
    driven: false,
    role: 'parked',
    exitSide: () => ({ x: x + 2, z }),
  };
}

interface Rig {
  world: FakeWorld;
  player: FakePlayer;
  audio: FakeAudio;
  hud: FakeHud;
  env: MissionEnv;
  active: Vehicle | null;
  mission: ReturnType<typeof createMission>;
}

function makeRig(): Rig {
  const world = new FakeWorld();
  const player = new FakePlayer();
  const audio = new FakeAudio();
  const hud = new FakeHud();
  const rig: Rig = {
    world,
    player,
    audio,
    hud,
    active: null,
    mission: createMission(world),
    env: null as unknown as MissionEnv,
  };
  rig.env = {
    world,
    player,
    audio,
    hud,
    getActiveVehicle: () => rig.active,
  };
  return rig;
}

const STEP = 1 / 60;

function run(rig: Rig, seconds: number): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) rig.mission.update(STEP, rig.env);
}

/** Advance one tick and return the event the Lead would observe. */
function tick(rig: Rig): string | null | undefined {
  rig.mission.update(STEP, rig.env);
  return rig.mission.state.event;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('DeliveryRunMission', () => {
  it('starts in idle with no waypoint and a hidden marker', () => {
    const rig = makeRig();
    const s = rig.mission.state;
    expect(s.phase).toBe('idle');
    expect(s.waypoint).toBeNull();
    expect(s.timeLeft).toBeNull();
    expect(s.title).toBe(MISSION_CONFIG.title);
    expect(rig.mission.group.visible).toBe(false);
  });

  it('start() enters meet with the missionStart waypoint and plays missionStart', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const s = rig.mission.state;
    expect(s.phase).toBe('meet');
    expect(s.waypoint).toEqual(rig.world.pois.missionStart);
    expect(s.waypointRadius).toBe(MISSION_CONFIG.meetRadius);
    expect(s.objective.toLowerCase()).toContain('courier');
    expect(rig.audio.played.map((p) => p.name)).toContain('missionStart');
    expect(rig.mission.group.visible).toBe(true);
    // Marker follows the waypoint.
    const ring = rig.mission.group.children[0] as THREE.Mesh;
    expect(ring.position.x).toBeCloseTo(rig.world.pois.missionStart.x);
    expect(ring.position.z).toBeCloseTo(rig.world.pois.missionStart.z);
  });

  it('reaching the marker ON FOOT advances to getVehicle (A-button not needed)', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    rig.player.setPosition(rig.world.pois.missionStart.x + 1, rig.world.pois.missionStart.z);
    tick(rig);
    const s = rig.mission.state;
    expect(s.phase).toBe('getVehicle');
    expect(s.objective.toLowerCase()).toContain('vehicle');
    // Waypoint now points at the parking lot.
    expect(s.waypoint).toEqual(rig.world.pois.parking);
  });

  it('does not advance while outside the marker radius', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    rig.player.setPosition(rig.world.pois.missionStart.x + 3.4, rig.world.pois.missionStart.z);
    tick(rig);
    expect(rig.mission.state.phase).toBe('getVehicle'); // 3.4 m is still inside 3.5 m
    // Far away is a miss:
    const rig2 = makeRig();
    rig2.mission.start(rig2.env);
    rig2.player.setPosition(rig2.world.pois.missionStart.x + 3.6, rig2.world.pois.missionStart.z);
    tick(rig2);
    expect(rig2.mission.state.phase).toBe('meet');
  });

  it('driving to the marker advances straight to deliver, starting the 90 s clock', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z + 0.5);
    rig.active = car;
    tick(rig);
    const s = rig.mission.state;
    expect(s.phase).toBe('deliver');
    expect(s.timeLeft).toBe(MISSION_CONFIG.timeLimit);
    expect(s.objective.toLowerCase()).toContain('deliver');
    expect(s.waypoint).toEqual(rig.world.pois.missionDrop);
    expect(s.waypointRadius).toBe(MISSION_CONFIG.dropRadius);
  });

  it('getVehicle advances to deliver as soon as any vehicle is active', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    rig.player.setPosition(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    tick(rig);
    expect(rig.mission.state.phase).toBe('getVehicle');
    rig.active = makeVehicle(rig.world.pois.parking.x, rig.world.pois.parking.z);
    tick(rig);
    expect(rig.mission.state.phase).toBe('deliver');
  });

  it('delivers when slow at the drop-off: reward 1000 + floor(timeLeft*5), event once', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    rig.active = car;
    tick(rig); // meet -> deliver
    expect(rig.mission.state.phase).toBe('deliver');
    // 20 s of driving (timer running, car on the street).
    car.position.set(0, 0, 20);
    run(rig, 20);
    expect(rig.mission.state.phase).toBe('deliver');
    const leftBefore = rig.mission.state.timeLeft!;
    expect(leftBefore).toBeLessThan(MISSION_CONFIG.timeLimit);
    // Arrive fast -> no completion yet.
    car.position.set(rig.world.pois.missionDrop.x, 0, rig.world.pois.missionDrop.z);
    car.speed = 10;
    tick(rig);
    expect(rig.mission.state.phase).toBe('deliver');
    // Arrive slowly -> complete.
    car.speed = 2;
    const event = tick(rig);
    const s = rig.mission.state;
    expect(event).toBe('completed');
    expect(s.phase).toBe('complete');
    expect(s.event).toBe('completed');
    const expected = 1000 + Math.floor(Math.max(0, s.timeLeft ?? 0) * 5);
    expect(s.reward).toBe(expected);
    expect(s.reward).toBeGreaterThan(0);
    expect(s.reward).toBeLessThanOrEqual(MISSION_CONFIG.rewardMax);
    expect(rig.audio.played.map((p) => p.name)).toContain('missionComplete');
    expect(rig.hud.toasts.some((t) => t.kind === 'good')).toBe(true);
    expect(rig.mission.group.visible).toBe(false);
    // The event is one-tick-only: the next update clears it but keeps 'complete'.
    rig.mission.update(STEP, rig.env);
    expect(rig.mission.state.event).toBeNull();
    expect(rig.mission.state.phase).toBe('complete');
    expect(rig.mission.state.reward).toBe(expected);
  });

  it('cannot deliver while outside the drop radius', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    rig.active = car;
    tick(rig);
    car.position.set(rig.world.pois.missionDrop.x + MISSION_CONFIG.dropRadius + 1, 0, rig.world.pois.missionDrop.z);
    car.speed = 0;
    tick(rig);
    expect(rig.mission.state.phase).toBe('deliver');
  });

  it('fails when the timer expires and reports event failed once', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    rig.active = car;
    tick(rig);
    expect(rig.mission.state.phase).toBe('deliver');
    const seen = new Set<string>();
    let failedTick = -1;
    for (let i = 0; i < 100 * 60; i++) {
      rig.mission.update(STEP, rig.env);
      if (rig.mission.state.event) seen.add(rig.mission.state.event);
      if (rig.mission.state.phase === 'failed' && failedTick < 0) failedTick = i;
    }
    expect(failedTick).toBeGreaterThan(89 * 60);
    expect(failedTick).toBeLessThan(91 * 60);
    expect([...seen]).toEqual(['failed']);
    expect(rig.mission.state.phase).toBe('failed');
    expect(rig.mission.state.timeLeft).toBe(0);
    expect(rig.hud.toasts.some((t) => t.text.includes('FAILED'))).toBe(true);
  });

  it('timer keeps running while the player is on foot during deliver', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    rig.active = car;
    tick(rig);
    rig.active = null; // player stepped out
    run(rig, 5);
    expect(rig.mission.state.phase).toBe('deliver');
    expect(rig.mission.state.timeLeft!).toBeCloseTo(MISSION_CONFIG.timeLimit - 5, 1);
  });

  it('restart() returns to meet from complete and from failed, resetting reward/clock', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const car = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    rig.active = car;
    tick(rig);
    car.position.set(rig.world.pois.missionDrop.x, 0, rig.world.pois.missionDrop.z);
    car.speed = 0;
    tick(rig);
    expect(rig.mission.state.phase).toBe('complete');
    rig.audio.played.length = 0;
    rig.mission.restart(rig.env);
    let s = rig.mission.state;
    expect(s.phase).toBe('meet');
    expect(s.reward).toBe(0);
    expect(s.timeLeft).toBeNull();
    expect(s.event).toBeNull();
    expect(s.waypoint).toEqual(rig.world.pois.missionStart);
    expect(rig.audio.played[0]?.name).toBe('missionStart');

    // Failed -> restart too.
    const rig2 = makeRig();
    rig2.mission.start(rig2.env);
    rig2.active = makeVehicle(rig2.world.pois.missionStart.x, rig2.world.pois.missionStart.z);
    tick(rig2);
    run(rig2, MISSION_CONFIG.timeLimit + 2);
    expect(rig2.mission.state.phase).toBe('failed');
    rig2.mission.restart(rig2.env);
    s = rig2.mission.state;
    expect(s.phase).toBe('meet');
    expect(s.timeLeft).toBeNull();
    expect(s.event).toBeNull();
  });

  it('is deterministic and never throws for garbage input', () => {
    const rig = makeRig();
    for (const dt of [NaN, Infinity, -1, 0, 1e9, 0.016]) {
      expect(() => rig.mission.update(dt, rig.env)).not.toThrow();
    }
    rig.mission.start(rig.env);
    for (let i = 0; i < 600; i++) rig.mission.update(STEP, rig.env);
    const s = rig.mission.state;
    expect(Number.isFinite(s.waypoint!.x)).toBe(true);
    expect(Number.isFinite(s.waypoint!.z)).toBe(true);
    // Two identical runs produce identical states.
    const a = makeRig();
    const b = makeRig();
    for (const r of [a, b]) {
      r.mission.start(r.env);
      r.player.setPosition(r.world.pois.missionStart.x, r.world.pois.missionStart.z);
      r.active = makeVehicle(r.world.pois.parking.x, r.world.pois.parking.z);
      run(r, 10);
    }
    expect(a.mission.state).toEqual(b.mission.state);
  });

  it('formatClock renders "Time left" style strings', () => {
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(42.2)).toBe('0:43');
    expect(formatClock(-3)).toBe('0:00');
    const rig = makeRig();
    rig.mission.start(rig.env);
    rig.active = makeVehicle(rig.world.pois.missionStart.x, rig.world.pois.missionStart.z);
    tick(rig);
    run(rig, 48);
    expect(rig.mission.state.detail).toBe('Time left 0:43'); // ceil(41.2s)
  });

  it('dispose() frees the marker and resets the state', () => {
    const rig = makeRig();
    rig.mission.start(rig.env);
    const ring = rig.mission.group.children[0] as THREE.Mesh;
    const geo = ring.geometry;
    let disposed = false;
    geo.addEventListener('dispose', () => (disposed = true));
    rig.mission.dispose();
    expect(disposed).toBe(true);
    expect(rig.mission.state.phase).toBe('idle');
    expect(() => rig.mission.update(STEP, rig.env)).not.toThrow();
  });
});

describe('GameState', () => {
  it('tracks money, damage, healing and reset', () => {
    const gs = createGameState();
    expect(gs.money).toBe(0);
    expect(gs.health).toBe(100);
    expect(gs.addMoney(1250)).toBe(1250);
    expect(gs.trySpend(300)).toBe(true);
    expect(gs.money).toBe(950);
    expect(gs.trySpend(99999)).toBe(false);
    expect(gs.money).toBe(950);
    expect(gs.damage(30)).toBe(false);
    expect(gs.health).toBe(70);
    expect(gs.heal(10)).toBe(10);
    expect(gs.health).toBe(80);
    expect(gs.damage(1000)).toBe(true);
    expect(gs.health).toBe(0);
    expect(gs.alive).toBe(false);
    expect(gs.stats.deaths).toBe(1);
    gs.reset();
    expect(gs.money).toBe(0);
    expect(gs.health).toBe(100);
    expect(gs.alive).toBe(true);
    // Money never negative; junk ignored.
    trigger: {
      gs.addMoney(-9999);
      expect(gs.money).toBe(0);
      gs.addMoney(NaN);
      expect(gs.money).toBe(0);
    }
    expect(GameState).toBeTypeOf('function');
  });
});
