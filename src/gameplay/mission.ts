/**
 * "THE DELIVERY RUN" — `MissionApi` implementation. Owned by: Agent 3 (Gameplay).
 *
 * Phase machine
 * -------------
 *   idle ──start()──► meet ──(reach marker, on foot OR in a car)──► getVehicle
 *                       ▲                                            │ (active vehicle)
 *                       │                                            ▼
 *                 restart() ─────────────────────────────────────► deliver ──► complete
 *                                                                    └─(timer 0)──► failed
 *
 * Rules (as implemented)
 * ----------------------
 * meet       Talk to the courier at `world.pois.missionStart` (radius 3.5 m).
 *            Whatever the player is on / in, reaching the marker advances the mission.
 *            • On foot, at the marker            → next phase `getVehicle`
 *            • Already in a vehicle, at the marker → next phase `deliver` (skips `getVehicle`)
 * getVehicle Get into any vehicle. The HUD waypoint points at `world.pois.parking`
 *            (fallback `missionStart`); it advances the tick `env.getActiveVehicle()` is non-null.
 * deliver    Drive to `world.pois.missionDrop` (radius 5.5 m) and stop the car (< 4 m/s).
 *            The clock starts at 90 s the moment the phase begins and runs while the player
 *            is on foot too (it is a courier deadline, not a driving timer).
 *            When the clock hits 0 → `failed`.
 * complete / failed
 *            Terminal. `state.event` is set to 'completed' / 'failed' for EXACTLY ONE tick
 *            (the tick the transition happens when update() causes it; `start()`/`restart()`
 *            set it on the same tick for restarts-out-of-failure). The Lead reads it that tick.
 *            `state` (including reward) is then kept until start()/restart().
 *
 * Reward formula
 * -------------
 *   reward = 1000 (base) + floor(max(timeLeft, 0) * 5)     → max 1000 + 90*5 = 1450
 * The Lead adds it to the player's money when it sees event === 'completed'.
 *
 * The in-world marker (additive ring + beam, cheap) lives in `group`; the Lead adds it to
 * the scene. It is visible only in 'meet' / 'getVehicle' / 'deliver' and moves with the
 * HUD waypoint (missionStart → parking → missionDrop). Animated in update().
 */

import * as THREE from 'three';
import type { CityWorld, MissionApi, MissionEnv, MissionPhase, MissionState, Vehicle, XZ } from '../contracts';
import { clamp } from '../core/utils';

/** Tunables (exported for tests / docs). */
export const MISSION_CONFIG = {
  title: 'THE DELIVERY RUN',
  meetRadius: 3.5,
  dropRadius: 5.5,
  timeLimit: 90,
  /** Deliver only counts when the car is slower than this (m/s). */
  arriveMaxSpeed: 4,
  rewardBase: 1000,
  rewardPerSecond: 5,
  /** Inverse of rewardPerSecond × timeLimit: max total reward. */
  get rewardMax(): number {
    return this.rewardBase + this.timeLimit * this.rewardPerSecond;
  },
} as const;

const OBJECTIVES = {
  idle: '',
  meet: 'Meet the courier at the marked spot',
  getVehicle: 'Get into any vehicle',
  deliver: 'Deliver the package downtown',
  complete: 'Package delivered!',
  failed: 'Time ran out — the courier moved on',
} as const;

const TWO_PI = Math.PI * 2;
const ORIGIN: XZ = { x: 0, z: 0 };

const ptsEqual = (a: XZ | null, b: XZ | null): boolean =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4);

const validXZ = (p: XZ | null | undefined): p is XZ =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

export class DeliveryRunMission implements MissionApi {
  readonly state: MissionState = {
    phase: 'idle',
    title: MISSION_CONFIG.title,
    objective: '',
    waypoint: null,
    waypointRadius: 0,
    timeLeft: null,
    reward: 0,
    detail: undefined,
    event: null,
  };

  readonly group = new THREE.Group();

  private readonly world: CityWorld;
  private ring: THREE.Mesh | null = null;
  private beam: THREE.Mesh | null = null;
  private disc: THREE.Mesh | null = null;
  private ringMat: THREE.MeshBasicMaterial | null = null;
  private beamMat: THREE.MeshBasicMaterial | null = null;
  private discMat: THREE.MeshBasicMaterial | null = null;

  private elapsed = 0;
  /** Seconds spent in the delivery phase (used for the result screen). */
  get deliveryTime(): number {
    return this._deliveryTime;
  }
  private _deliveryTime = 0;
  private markerTime = 0;
  private waypointTarget: XZ | null = null;
  private disposed = false;

  constructor(world: CityWorld) {
    this.world = world;
    this.group.name = 'mission-marker';
    this.buildMarker();
    this.applyVisibility();
  }

  /* ------------------------------ lifecycle ----------------------------- */

  /** Begin the mission (from 'idle' or over any terminal / running phase). */
  start(env: MissionEnv): void {
    if (this.disposed) return;
    this._deliveryTime = 0;
    this.enterPhase('meet', env);
  }

  /** Replay after complete / failed (and a safe alias of start() while running). */
  restart(env: MissionEnv): void {
    if (this.disposed) return;
    this._deliveryTime = 0;
    this.enterPhase('meet', env);
  }

  update(dt: number, env: MissionEnv): void {
    if (this.disposed) return;
    const s = this.state;
    // A terminal event lives for exactly one tick: clear it here (the Lead reads it
    // right after update() returns), then any event set below belongs to THIS tick.
    s.event = null;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.elapsed += step;
    this.markerTime += step;
    if (s.phase === 'deliver') this._deliveryTime += step;

    switch (s.phase) {
      case 'meet':
        this.updateMeet(env);
        break;
      case 'getVehicle':
        // Entering a car may happen any tick, before or after the marker is reached.
        if (this.markerReached(env) || this.activeVehicle(env)) this.enterPhase('deliver', env);
        break;
      case 'deliver':
        this.updateDeliver(step, env);
        break;
      default:
        break;
    }

    // `state.event` was cleared above; transitions in this tick set it fresh and it will
    // survive until the *next* update() call, so the Lead sees it exactly once.
    this.animateMarker(step);
  }

  /** Public fade-out helper for the Lead (e.g. on mission result screen). */
  hideMarker(): void {
    this.applyVisibility(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.parent?.remove(this.group);
    this.ring?.geometry.dispose();
    this.beam?.geometry.dispose();
    this.disc?.geometry.dispose();
    this.ringMat?.dispose();
    this.beamMat?.dispose();
    this.discMat?.dispose();
    this.ring = null;
    this.beam = null;
    this.disc = null;
    this.ringMat = null;
    this.beamMat = null;
    this.discMat = null;
    this.group.clear();
    this.state.phase = 'idle';
    this.state.waypoint = null;
    this.state.timeLeft = null;
    this.state.event = null;
  }

  /* ------------------------------ phases -------------------------------- */

  private updateMeet(env: MissionEnv): void {
    const reached = this.markerReached(env);
    if (!reached) return;
    // Reach the marker on foot → fetch a car; in a car → straight to the drop-off.
    if (this.activeVehicle(env)) this.enterPhase('deliver', env);
    else this.enterPhase('getVehicle', env);
  }

  private updateDeliver(step: number, env: MissionEnv): void {
    const s = this.state;
    const v = this.activeVehicle(env);
    // Countdown (runs even if the player steps out — the deadline does not pause).
    if (s.timeLeft !== null) {
      s.timeLeft = Math.max(0, s.timeLeft - step);
      s.detail = `Time left ${formatClock(s.timeLeft)}`;
    }
    // Arrival: the driven car is inside the drop radius and crawling.
    if (v) {
      const drop = this.poi('missionDrop', [env.world.pois.missionStart ?? { x: 0, z: 0 }]);
      if (drop) {
        const d = Math.hypot(v.position.x - drop.x, v.position.z - drop.z);
        const speed = Math.abs(v.speed);
        if (d <= MISSION_CONFIG.dropRadius && speed < MISSION_CONFIG.arriveMaxSpeed) {
          this.complete(env);
          return;
        }
      }
    }
    if (s.timeLeft !== null && s.timeLeft <= 0) this.fail(env);
  }

  private complete(env: MissionEnv): void {
    const s = this.state;
    const timeLeft = s.timeLeft ?? 0;
    s.phase = 'complete';
    s.reward = Math.round(MISSION_CONFIG.rewardBase + Math.floor(Math.max(0, timeLeft) * MISSION_CONFIG.rewardPerSecond));
    s.timeLeft = Math.max(0, timeLeft);
    s.objective = OBJECTIVES.complete;
    s.detail = `Earned $${s.reward}`;
    s.event = 'completed';
    this.setWaypoint(null, 0);
    this.applyVisibility(false);
    try {
      env.audio?.play('missionComplete');
    } catch {
      /* audio is optional in tests */
    }
    try {
      env.hud?.toast(`MISSION COMPLETE +$${s.reward}`, 'good', 3.5);
    } catch {
      /* hud is optional in tests */
    }
  }

  private fail(env: MissionEnv): void {
    const s = this.state;
    s.phase = 'failed';
    s.timeLeft = 0;
    s.objective = OBJECTIVES.failed;
    s.detail = 'Time up';
    s.event = 'failed';
    this.setWaypoint(null, 0);
    this.applyVisibility(false);
    try {
      env.audio?.play('ui');
    } catch {
      /* ignore */
    }
    try {
      env.hud?.toast('MISSION FAILED — out of time', 'bad', 3.5);
    } catch {
      /* ignore */
    }
  }

  /** Move to a fresh phase and reset everything phase-specific. */
  private enterPhase(phase: MissionPhase, env: MissionEnv): void {
    const s = this.state;
    const start = this.poi('missionStart', [env.world.pois.spawn ?? { x: 0, z: 0 }]) ?? ORIGIN;
    s.phase = phase;
    s.title = MISSION_CONFIG.title;
    s.event = null;
    s.reward = 0;
    this.markerTime = 0;
    switch (phase) {
      case 'meet': {
        s.objective = OBJECTIVES.meet;
        s.timeLeft = null;
        s.detail = 'On foot — talk to the courier';
        this.setWaypoint(start, MISSION_CONFIG.meetRadius);
        this.applyVisibility(true);
        try {
          env.audio?.play('missionStart');
        } catch {
          /* ignore */
        }
        break;
      }
      case 'getVehicle': {
        const park = this.poi('parking', [start]) ?? start;
        s.objective = OBJECTIVES.getVehicle;
        s.timeLeft = null;
        s.detail = 'Any car will do';
        this.setWaypoint(park, MISSION_CONFIG.meetRadius);
        this.applyVisibility(true);
        try {
          env.hud?.toast('Courier: "Grab a car — fast!"', 'info', 2.5);
        } catch {
          /* ignore */
        }
        break;
      }
      case 'deliver': {
        const dropPoint = this.poi('missionDrop', [start]) ?? start;
        s.objective = OBJECTIVES.deliver;
        s.timeLeft = MISSION_CONFIG.timeLimit;
        s.detail = `Time left ${formatClock(MISSION_CONFIG.timeLimit)}`;
        this.setWaypoint(dropPoint, MISSION_CONFIG.dropRadius);
        this.applyVisibility(true);
        try {
          env.audio?.play('missionStart', 0.6);
        } catch {
          /* ignore */
        }
        try {
          env.hud?.toast(`Deliver downtown — ${MISSION_CONFIG.timeLimit}s`, 'info', 2.5);
        } catch {
          /* ignore */
        }
        break;
      }
      default:
        break;
    }
  }

  /* ----------------------------- helpers -------------------------------- */

  private activeVehicle(env: MissionEnv): Vehicle | null {
    try {
      const v = env.getActiveVehicle?.() ?? null;
      return v ?? null;
    } catch {
      return null;
    }
  }

  /** Is the player at the current marker? In a car we use the car; on foot the player. */
  private markerReached(env: MissionEnv): boolean {
    const s = this.state;
    const wp = s.waypoint;
    if (!validXZ(wp)) return false;
    const v = this.activeVehicle(env);
    if (v) {
      const d = Math.hypot(v.position.x - wp.x, v.position.z - wp.z);
      return d <= MISSION_CONFIG.meetRadius;
    }
    const p = env.player?.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
    return Math.hypot(p.x - wp.x, p.z - wp.z) <= MISSION_CONFIG.meetRadius;
  }

  /** Read a POI with fallbacks; returns a stable object when it is our own scratch. */
  private poi(name: string, fallbacks: XZ[]): XZ | null {
    const pois = this.world?.pois;
    const raw = pois ? pois[name] : undefined;
    if (validXZ(raw)) return raw;
    for (const f of fallbacks) if (validXZ(f)) return f;
    return null;
  }

  /** Assign the waypoint; reuses one object so React-style renderers can diff cheaply. */
  private setWaypoint(target: XZ | null, radius: number): void {
    const s = this.state;
    if (!validXZ(target)) {
      if (s.waypoint !== null) s.waypoint = null;
      s.waypointRadius = 0;
      this.waypointTarget = null;
      return;
    }
    // Always a fresh object: callers (HUD, debug API) snapshot waypoints, and the
    // shared scratch object would mutate while snapshots still referenced it.
    s.waypoint = { x: target.x, z: target.z };
    s.waypointRadius = radius;
    this.waypointTarget = target;
    this.positionMarker(target, radius);
  }

  /* ------------------------------ marker -------------------------------- */

  private buildMarker(): void {
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.renderOrder = 2;

    this.discMat = new THREE.MeshBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.82, 32), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.045;

    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 9, 18, 1, true), this.beamMat);
    this.beam.position.y = 4.5;
    this.beam.renderOrder = 1;

    this.ring.frustumCulled = false;
    this.beam.frustumCulled = false;
    this.disc.frustumCulled = false;
    this.group.add(this.ring, this.disc, this.beam);
    this.group.visible = false;
  }

  private applyVisibility(visible?: boolean): void {
    const phase = this.state.phase;
    const active = phase === 'meet' || phase === 'getVehicle' || phase === 'deliver';
    this.group.visible = visible === undefined ? active : visible;
  }

  private positionMarker(at: XZ, radius: number): void {
    const r = Math.max(0.6, radius);
    if (this.ring) {
      this.ring.scale.setScalar(r);
      this.ring.position.x = at.x;
      this.ring.position.z = at.z;
    }
    if (this.disc) {
      this.disc.scale.setScalar(r);
      this.disc.position.x = at.x;
      this.disc.position.z = at.z;
    }
    if (this.beam) {
      this.beam.position.x = at.x;
      this.beam.position.z = at.z;
      this.beam.scale.setScalar(clamp(r / 3.5, 0.6, 1.8));
    }
  }

  private animateMarker(dt: number): void {
    if (!this.group.visible) return;
    const t = this.markerTime;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    if (this.ring) {
      this.ring.rotation.z = t * 0.8;
      const base = clamp((this.state.waypointRadius || 3.5) / 3.5, 0.6, 1.8);
      this.ring.scale.setScalar(base * (1 + pulse * 0.08));
    }
    if (this.ringMat) this.ringMat.opacity = 0.55 + pulse * 0.4;
    if (this.beamMat) this.beamMat.opacity = 0.12 + pulse * 0.16;
    if (this.discMat) this.discMat.opacity = 0.1 + pulse * 0.12;
    if (this.beam) this.beam.rotation.y = t * 0.5;
    void dt;
  }
}

/** "Time left 0:42" style clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Factory used by the Lead: `const mission = createMission(world)`. */
export function createMission(world: CityWorld): DeliveryRunMission {
  return new DeliveryRunMission(world);
}

/* Keep the phase constants discoverable for tests. */
export const MISSION_PHASES: readonly MissionPhase[] = ['idle', 'meet', 'getVehicle', 'deliver', 'complete', 'failed'] as const;
