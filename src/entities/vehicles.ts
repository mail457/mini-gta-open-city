/**
 * VEHICLES — specs, spawning, arcade driving physics and body animation.
 * Owned by: Agent 2 (W-2). Implements `VehiclePhysicsApi` from src/contracts.ts.
 *
 * Axes / conventions (shared with Player + camera):
 *   - forward = (−sin yaw, −cos yaw); the model nose points along local +Z, so
 *     `mesh.rotation.y = yaw` (THREE Euler Y) lines the nose up with forward.
 *   - vehicle local: +Z nose, −Z tail, +X = car's left-hand side.
 *   - position.y = ground height (car centre at the contact patch).
 *
 * Integration model (per stepDriven call):
 *   1. throttle / brake / handbrake / rolling resistance → forward speed
 *   2. steering yaw rate (speed dependent, reversed in reverse)
 *   3. lateral slip velocity: the old forward vector keeps some of the car's
 *      momentum while the car rotates; grip pulls it back to zero
 *   4. integrate in sub-steps ≤ 0.5 m of travel; at each sub-step sampled as
 *      3 circles along the car's length, pushed out of `world.resolveCircle`
 *   5. clamp y to groundHeight, clamp x/z to the world bounds
 * Never touches `document`, so it is unit-testable in Node/Vitest.
 */

import * as THREE from 'three';
import type {
  CityWorld, CollisionService, InputFrame, Vehicle, VehiclePhysicsApi, VehicleSpec, VehicleTypeId, XZ } from '../contracts';
import { clamp, dampAngle } from '../core/utils';
import { createVehicleMesh, disposeVehicleMesh, getVehicleMeshData, type VehicleMeshData } from './vehicleModels';

/* -------------------------------------------------------------------------- */
/* Specs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tuning table. Human-facing numbers first, then the feel constants.
 *  sedan — the reference car: ~122 km/h, planted, forgiving.
 *  sport — ~165 km/h, launches hard, looser rear (drifty), quick but twitchy.
 *  van   — slow & heavy: ~94 km/h, very stable, strong brakes.
 */
export const VEHICLE_SPECS: Record<VehicleTypeId, VehicleSpec> = {
  sedan: {
    id: 'sedan',
    label: 'Sedan',
    maxSpeed: 34,
    maxReverse: 9,
    accel: 12,
    brake: 24,
    steerRate: 1.55,
    grip: 0.86,
    length: 4.4,
    width: 1.9,
    height: 1.45,
    color: 0x2f6fb5,
  },
  sport: {
    id: 'sport',
    label: 'Sport',
    maxSpeed: 46,
    maxReverse: 9,
    accel: 19,
    brake: 26,
    steerRate: 1.75,
    grip: 0.8,
    length: 4.3,
    width: 1.9,
    height: 1.22,
    color: 0xd8402c,
  },
  van: {
    id: 'van',
    label: 'Van',
    maxSpeed: 26,
    maxReverse: 7,
    accel: 8,
    brake: 30,
    steerRate: 1.25,
    grip: 0.93,
    length: 5.2,
    width: 2.1,
    height: 2.15,
    color: 0xe4e2da,
  },
};

/** Extra feel constants on top of the public `VehicleSpec` fields. */
export const VEHICLE_FEEL = {
  /** Rolling resistance (m/s²) applied when the car is moving under no/partial throttle. */
  rollingResistance: 1.6,
  /** Aerodynamic drag coefficient (1/m) applied at speed: a = -drag * v². */
  drag: 0.0016,
  /** Base fraction of forward speed kept as lateral momentum per radian turned (0..1). */
  driftFactor: 0.42,
  /** Extra drift kept while the handbrake is down (0..1). */
  handbrakeDriftFactor: 0.82,
  /** How quickly grip eats lateral velocity (1/s), before grip scaling. */
  lateralDamp: 7,
  /** Handbrake deceleration (m/s²). */
  handbrakeDecel: 16,
  /** Steering authority multiplier at very low speed (the car still pivots). */
  lowSpeedSteer: 0.55,
  /** Speed where steering reaches full authority (m/s). */
  steerFullSpeed: 2.5,
  /** Speed where high-speed steering stability kicks in (m/s). */
  steerFalloffSpeed: 22,
  /** Stability factor at max speed: also scaled with the spec's top speed. */
  highSpeedStability: 0.55,
  /** Max travel per collision sub-step (m). */
  subStepDistance: 0.5,
  /** Collision circle radius factor relative to width/2. */
  circleRadiusFactor: 0.95,
  /** Speed retained along the wall after a head-on impact (0..1). */
  wallSlide: 0.35,
  /** Impact speed below which no crash is reported (m/s). */
  minImpact: 0.4,
  /** Max yaw-rate multiplier from a handbrake turn. */
  handbrakeYawBoost: 1.5,
  /** Wall-scoop yaw boost factor (rad/s per unit of sideways wall push). */
  wallYawScoop: 0.0,
} as const;

/** Number of collision circles sampled along the car's length. */
const CIRCLES = 3;
/** Placeholder spec used by the AI `drive()` helper for traffic cars. */
const PHYSICS_EPS = 1e-6;

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export interface VehicleOptions {
  /** 'parked' (default) or 'traffic'. */
  role?: 'parked' | 'traffic';
  /** Optional tint override (defaults to spec.color). */
  color?: number;
}

/**
 * Owns every spawned vehicle. The game keeps a reference to `vehicles` and
 * drives them: `stepDriven` for the player's car, optional `physics.drive()` for
 * traffic, then `updateVisuals`, then `resolveVehicleCollisions`.
 */
export class VehicleSystem implements VehiclePhysicsApi {
  /** All vehicles in the world (parked + traffic + player's car). */
  readonly vehicles: Vehicle[] = [];
  readonly scene: THREE.Scene;
  private readonly world: CityWorld | null;

  // Scratch state for visuals (allocation-free per frame).
  /** Per-vehicle visual state; cleared when a vehicle's mesh is replaced. */
  readonly visualState = new WeakMap<Vehicle, VisualState>();
  private readonly tmp: THREE.Vector3 = new THREE.Vector3();

  /** Optional world: used to keep vehicles on the road instead of on pavements. */
  constructor(scene: THREE.Scene, world?: CityWorld) {
    this.scene = scene;
    this.world = world ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Spawning                                                               */
  /* ---------------------------------------------------------------------- */

  /** Spawn a parked car (static until entered). Returns the new Vehicle. */
  spawnParked(scene: THREE.Scene, x: number, z: number, yaw: number, type: VehicleTypeId, opts: VehicleOptions = {}): Vehicle {
    return this.spawn(scene, x, z, yaw, type, { ...opts, role: opts.role ?? 'parked' });
  }

  /** Spawn a traffic car (driven by Agent 3's AI; physics helper `physics.drive()`). */
  spawnTraffic(scene: THREE.Scene, x: number, z: number, yaw: number, type: VehicleTypeId, opts: VehicleOptions = {}): Vehicle {
    return this.spawn(scene, x, z, yaw, type, { ...opts, role: opts.role ?? 'traffic' });
  }

  /**
   * Generic spawn. The optional `world` is used to snap the car onto the ground
   * (and to tint / validate) — pass the CityWorld whenever available.
   */
  spawn(scene: THREE.Scene, x: number, z: number, yaw: number, type: VehicleTypeId, opts: VehicleOptions = {}, world?: CollisionService): Vehicle {
    const spec = VEHICLE_SPECS[type] ?? VEHICLE_SPECS.sedan;
    const mesh = createVehicleMesh(opts.color !== undefined ? { ...spec, color: opts.color } : spec);
    const role = opts.role ?? 'parked';
    let vehicle!: Vehicle;
    vehicle = {
      spec,
      position: new THREE.Vector3(x, world ? world.groundHeight(x, z) : 0, z),
      yaw,
      speed: 0,
      lateralSpeed: 0,
      mesh,
      driven: false,
      role,
      exitSide: (driverSide: 'left' | 'right') => this.exitPoint(vehicle, driverSide),
    };
    mesh.position.copy(vehicle.position);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    this.vehicles.push(vehicle);
    if (world) mesh.position.y = world.groundHeight(x, z);
    return vehicle;
  }

  /** Remove and dispose a single vehicle (also removes it from `vehicles`). */
  remove(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.visualState.delete(v);
    disposeVehicleMesh(v.mesh);
  }

  /** Remove every vehicle. */
  clear(): void {
    for (const v of [...this.vehicles]) this.remove(v);
  }

  dispose(): void {
    this.clear();
  }

  /**
   * A point ~1.8 m to the side of the car at the door, level with the front seats.
   * `driverSide` is the driver's own left/right (driver faces forward = local +Z,
   * so their left is local +X).
   */
  private exitPoint(v: Vehicle, driverSide: 'left' | 'right'): XZ {
    const lateral = (v.spec.width / 2 + 1.15) * (driverSide === 'left' ? 1 : -1);
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    // left of forward = (fz, -fx)
    const lx = fz;
    const lz = -fx;
    return { x: v.position.x + lx * lateral + fx * 0.35, z: v.position.z + lz * lateral + fz * 0.35 };
  }

  /** Axis-aligned XZ bounds of a vehicle (minimap / spawn validation). */
  getVehicleAABB(v: Vehicle): { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number } {
    const hw = v.spec.width / 2;
    const hl = v.spec.length / 2;
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    // Extent of a rotated rectangle along each world axis.
    const ex = Math.abs(fx) * hl + Math.abs(fz) * hw;
    const ez = Math.abs(fz) * hl + Math.abs(fx) * hw;
    return { minX: v.position.x - ex, maxX: v.position.x + ex, minZ: v.position.z - ez, maxZ: v.position.z + ez, cx: v.position.x, cz: v.position.z };
  }

  /* ---------------------------------------------------------------------- */
  /* World-collision helpers                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Collision circle centres along the car's length, written into `out`
   * (x,z pairs). Circle radius = width/2 * 0.95 so the car fits its lane.
   */
  private sampleCircles(v: Vehicle, out: Float32Array): void {
    const r = (v.spec.width / 2) * VEHICLE_FEEL.circleRadiusFactor;
    const total = v.spec.length - r * 2;
    const step = total / (CIRCLES - 1);
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    for (let i = 0; i < CIRCLES; i++) {
      const d = -total / 2 + i * step;
      out[i * 2] = v.position.x + fx * d;
      out[i * 2 + 1] = v.position.z + fz * d;
    }
  }

  /** Circle radius used for vehicle-vs-world and vehicle-vs-vehicle. */
  private circleRadius(v: Vehicle): number {
    return (v.spec.width / 2) * VEHICLE_FEEL.circleRadiusFactor;
  }

  /* ---------------------------------------------------------------------- */
  /* Player-driven physics                                                  */
  /* ---------------------------------------------------------------------- */

  stepDriven(v: Vehicle, input: InputFrame, world: CollisionService, dt: number): number {
    if (!(dt > 0) || !Number.isFinite(dt)) return 0;
    const spec = v.spec;
    const F = VEHICLE_FEEL;
    const throttle = clamp(input.moveY, -1, 1);
    const steer = clamp(input.moveX, -1, 1);
    const handbrake = input.handbrake;

    /* ---------------- 1. longitudinal speed ---------------- */
    let speed = v.speed;
    if (throttle > 0.01) {
      if (speed < -PHYSICS_EPS) {
        speed = Math.min(0, speed + spec.brake * throttle * dt); // brake first, then go forward
      } else {
        // Torque falls off near the top: (1 - v/vmax) keeps the top reachable & smooth.
        const headroom = clamp(1 - speed / spec.maxSpeed, 0, 1);
        speed += spec.accel * throttle * (0.25 + 0.75 * headroom) * dt;
      }
    } else if (throttle < -0.01) {
      if (speed > PHYSICS_EPS) {
        speed = Math.max(0, speed + spec.brake * throttle * dt); // brake first, then reverse
      } else {
        const headroom = clamp(1 + speed / spec.maxReverse, 0, 1);
        speed -= spec.accel * 0.7 * -throttle * (0.3 + 0.7 * headroom) * dt;
      }
    }
    // No throttle: rolling resistance + aero drag (quadratic drag caps the top speed).
    if (Math.abs(throttle) < 0.01) {
      const decel = (F.rollingResistance + F.drag * speed * speed) * dt;
      speed = Math.sign(speed) * Math.max(Math.abs(speed) - decel, 0);
    }
    if (handbrake) {
      // Handbrake slows the car quickly, but not instantly (the rear slides).
      speed = Math.sign(speed) * Math.max(Math.abs(speed) - F.handbrakeDecel * dt, 0);
    }
    speed = clamp(speed, -spec.maxReverse, spec.maxSpeed);

    /* ---------------- 2. steering ---------------- */
    const yawBefore = v.yaw;
    const absSpeed = Math.abs(speed);
    // Low speed: limited authority but never zero (the car can pivot);
    // high speed: squared falloff for stability (sport falls off harder through grip too).
    const lowFactor = F.lowSpeedSteer + (1 - F.lowSpeedSteer) * clamp(absSpeed / F.steerFullSpeed, 0, 1);
    const topRatio = clamp(absSpeed / spec.maxSpeed, 0, 1);
    const highFactor = 1 - (1 - F.highSpeedStability) * topRatio * topRatio;
    const handbrakeBoost = handbrake ? F.handbrakeYawBoost : 1;
    const reverseSign = speed < -0.05 ? -1 : 1; // steering flips in reverse, like a real car
    const yawRate = steer * spec.steerRate * lowFactor * highFactor * handbrakeBoost * reverseSign * throttleAuthority(throttle, absSpeed);
    v.yaw = yawBefore + yawRate * dt;

    /* ---------------- 3. lateral slip (drift) ---------------- */
    // Recompose the velocity vector into the NEW car frame: what was forward
    // partly becomes sideways. Grip then damps the sideways part back towards the nose.
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const lx = fz; // left of forward = (fz, -fx)
    const lz = -fx;
    const oldFx = -Math.sin(yawBefore);
    const oldFz = -Math.cos(yawBefore);
    const rotated = oldFx * fx + oldFz * fz; // cos(deltaYaw)
    const slip = (-speed * oldFx * lx - speed * oldFz * lz) + v.lateralSpeed * rotated;
    const keep = handbrake ? F.handbrakeDriftFactor : F.driftFactor;
    let lateral = slip * keep;
    // Grip pulls the lateral velocity back to 0 (lower grip = slides longer).
    const gripLambda = F.lateralDamp * spec.grip * (handbrake ? 0.3 : 1);
    lateral *= Math.exp(-gripLambda * dt);
    lateral = clamp(lateral, -spec.maxSpeed, spec.maxSpeed);

    v.speed = speed;
    v.lateralSpeed = lateral;

    /* ---------------- 4. integrate + collide (sub-stepped) ---------------- */
    const vx = fx * speed + lx * lateral;
    const vz = fz * speed + lz * lateral;
    const travel = Math.hypot(vx, vz) * dt;
    const subSteps = Math.max(1, Math.ceil(travel / F.subStepDistance));
    const impact = this.moveWithCollisions(v, world, vx, vz, dt / subSteps, subSteps);

    if (impact > 0) {
      // Head-on hit: kill most of the speed but keep a little so the car slides off the wall.
      v.speed = Math.sign(v.speed) * Math.abs(v.speed) * F.wallSlide;
      v.lateralSpeed *= 0.5;
    }
    // Never NaN, never airborne.
    if (!Number.isFinite(v.position.x) || !Number.isFinite(v.position.z) || !Number.isFinite(v.speed)) {
      v.speed = 0;
      v.lateralSpeed = 0;
    }
    v.position.y = world.groundHeight(v.position.x, v.position.z);
    return impact;
  }

  /* ---------------------------------------------------------------------- */
  /* Core movement + collision                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Move the vehicle by (vx, vz) * sdt for `subSteps` steps, resolving collisions
   * against the world at every sub-step. Returns the peak impact speed (>0) or 0.
   * On impact, `v.yaw` may be adjusted slightly so the car "scoops" along the wall.
   */
  private moveWithCollisions(v: Vehicle, world: CollisionService, vx: number, vz: number, sdt: number, subSteps: number): number {
    const F = VEHICLE_FEEL;
    const r = this.circleRadius(v);
    const centres = this.circleScratch;
    let peak = 0;
    for (let s = 0; s < subSteps; s++) {
      v.position.x += vx * sdt;
      v.position.z += vz * sdt;
      // Sample circles + push out (2 passes settle corners).
      let pushX = 0;
      let pushZ = 0;
      for (let pass = 0; pass < 2; pass++) {
        this.sampleCircles(v, centres);
        let moved = false;
        for (let i = 0; i < CIRCLES; i++) {
          const cx = centres[i * 2];
          const cz = centres[i * 2 + 1];
          const p = world.resolveCircle(cx, cz, r);
          let dx = p.x - cx;
          let dz = p.z - cz;
          // Cars do not hop kerbs: if this circle would end up on pavement, push it
          // back towards the road instead (the building colliders still stop real walls).
          if (!dx && !dz && this.world && !this.world.isRoad(p.x, p.z)) {
            const back = this.world.isRoad(v.position.x, v.position.z)
              ? { x: v.position.x - p.x, z: v.position.z - p.z }
              : { x: -vx, z: -vz };
            const bl = Math.hypot(back.x, back.z) || 1;
            dx = (back.x / bl) * 0.25;
            dz = (back.z / bl) * 0.25;
          }
          if (dx !== 0 || dz !== 0) {
            v.position.x += dx;
            v.position.z += dz;
            pushX += dx;
            pushZ += dz;
            moved = true;
          }
        }
        if (!moved) break;
      }
      if (pushX !== 0 || pushZ !== 0) {
        // Component of our velocity into the wall = impact speed.
        const pushLen = Math.hypot(pushX, pushZ);
        const intoSpeed = (vx * pushX + vz * pushZ) / Math.max(pushLen, 1e-6);
        const impact = Math.abs(intoSpeed);
        if (impact > peak) peak = impact;
        // The car leans along the wall: a glancing push rotates the nose towards
        // the wall tangent, which turns a head-on press into a slide.
        const fx = -Math.sin(v.yaw);
        const fz = -Math.cos(v.yaw);
        const cross = fx * pushZ - fz * pushX; // which side the push came from, relative to the nose
        if (Math.abs(cross) > 1e-4 && impact > F.minImpact) {
          v.yaw += (cross > 0 ? 1 : -1) * clamp(impact * sdt * 0.8, 0, 0.03);
        }
        if (impact > 0) break; // stop this step's travel after a hit
      }
    }
    return peak > F.minImpact ? peak : 0;
  }

  private readonly circleScratch = new Float32Array(CIRCLES * 2);

  /* ---------------------------------------------------------------------- */
  /* Vehicle vs vehicle                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Push `v` out of every other vehicle and transfer momentum along the contact
   * normal (both cars slow down). Returns the largest impact speed.
   */
  resolveVehicleCollisions(v: Vehicle, others: readonly Vehicle[]): number {
    const r = this.circleRadius(v);
    let maxImpact = 0;
    // Two passes: separating from one car can push into another.
    for (let pass = 0; pass < 2; pass++) {
      this.sampleCircles(v, this.circleScratch);
      for (let oi = 0; oi < others.length; oi++) {
        const o = others[oi];
        if (o === v) continue;
        const or = this.circleRadius(o);
        const minD = r + or;
        // Broad phase on centre distance.
        const bdx = o.position.x - v.position.x;
        const bdz = o.position.z - v.position.z;
        const broad = minD + v.spec.length / 2 + o.spec.length / 2;
        if (bdx * bdx + bdz * bdz > broad * broad) continue;
        this.sampleCircles(v, this.circleScratch);
        this.sampleCircles(o, this.otherScratch);
        for (let i = 0; i < CIRCLES; i++) {
          const ax = this.circleScratch[i * 2];
          const az = this.circleScratch[i * 2 + 1];
          for (let j = 0; j < CIRCLES; j++) {
            const bx = this.otherScratch[j * 2];
            const bz = this.otherScratch[j * 2 + 1];
            let dx = ax - bx;
            let dz = az - bz;
            let d2 = dx * dx + dz * dz;
            if (d2 >= minD * minD) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-5) {
              // Degenerate overlap: separate along the line of centres.
              dx = v.position.x - o.position.x || 1;
              dz = v.position.z - o.position.z;
              d = Math.hypot(dx, dz) || 1;
              d2 = 1;
            }
            const nx = dx / d;
            const nz = dz / d;
            const overlap = minD - d;
            // v takes 70% of the separation, the other car 30%.
            v.position.x += nx * overlap * 0.7;
            v.position.z += nz * overlap * 0.7;
            if (o.role !== 'parked') {
              o.position.x -= nx * overlap * 0.3;
              o.position.z -= nz * overlap * 0.3;
            } else {
              // Parked cars don't move: push v out fully instead.
              v.position.x += nx * overlap * 0.3;
              v.position.z += nz * overlap * 0.3;
            }
            // Momentum: closing speed along the normal.
            const vfx = -Math.sin(v.yaw) * v.speed;
            const vfz = -Math.cos(v.yaw) * v.speed;
            const ox = -Math.sin(o.yaw) * o.speed;
            const oz = -Math.cos(o.yaw) * o.speed;
            const closing = (vfx - ox) * -nx + (vfz - oz) * -nz;
            if (closing > 0) {
              // v loses, the other car gains a fraction of it.
              const transfer = closing * 0.55;
              v.speed = moveTowards(v.speed, v.speed * 0.25, transfer);
              v.lateralSpeed *= 0.4;
              if (o.role !== 'parked') o.speed = moveTowards(o.speed, o.speed + closing * 0.5, closing * 0.5);
              if (closing > maxImpact) maxImpact = closing;
            }
            // Re-sample v (it moved).
            this.sampleCircles(v, this.circleScratch);
          }
        }
      }
    }
    return maxImpact;
  }

  private readonly otherScratch = new Float32Array(CIRCLES * 2);

  /* ---------------------------------------------------------------------- */
  /* AI helper (traffic / Agent 3)                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Simple lane-following physics used by traffic cars: steer towards `targetYaw`
   * and hold `targetSpeed`, with the same world collision + sub-stepping as the
   * player so traffic can never tunnel either. Returns impact speed.
   */
  drive(v: Vehicle, targetYaw: number, targetSpeed: number, world: CollisionService, dt: number): number {
    if (!(dt > 0)) return 0;
    const spec = v.spec;
    const F = VEHICLE_FEEL;
    const absSpeed = Math.abs(v.speed);
    const lowFactor = F.lowSpeedSteer + (1 - F.lowSpeedSteer) * clamp(absSpeed / F.steerFullSpeed, 0, 1);
    const topRatio = clamp(absSpeed / spec.maxSpeed, 0, 1);
    const highFactor = 1 - (1 - F.highSpeedStability) * topRatio * topRatio;
    // Limit the yaw error turned per step so the car has a visible turning radius.
    const maxYawStep = spec.steerRate * lowFactor * highFactor * dt;
    const turned = dampAngle(v.yaw, targetYaw, 4, dt);
    v.yaw += clamp(turned - v.yaw, -maxYawStep, maxYawStep);

    const tgt = clamp(targetSpeed, -spec.maxReverse, spec.maxSpeed);
    const accel = tgt > v.speed ? spec.accel : spec.brake;
    v.speed = moveTowards(v.speed, tgt, accel * dt);
    v.lateralSpeed *= Math.exp(-F.lateralDamp * spec.grip * dt);

    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const lx = fz;
    const lz = -fx;
    const vx = fx * v.speed + lx * v.lateralSpeed;
    const vz = fz * v.speed + lz * v.lateralSpeed;
    const travel = Math.hypot(vx, vz) * dt;
    const subSteps = Math.max(1, Math.ceil(travel / F.subStepDistance));
    const impact = this.moveWithCollisions(v, world, vx, vz, dt / subSteps, subSteps);
    if (impact > 0) v.speed = Math.sign(v.speed) * Math.abs(v.speed) * F.wallSlide;
    v.position.y = world.groundHeight(v.position.x, v.position.z);
    return impact;
  }

  /* ---------------------------------------------------------------------- */
  /* Visuals                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Per-frame body animation: wheel spin + steer angle, brake lights, pitch on
   * accel/brake, roll while turning, a little suspension squat. Allocation-free.
   */
  updateVisuals(v: Vehicle, dt: number, input?: InputFrame): void {
    const data = getVehicleMeshData(v.mesh) as VehicleMeshData;
    const mesh = v.mesh;
    // Position/yaw are authoritative on the Vehicle; the mesh follows.
    mesh.position.copy(v.position);
    mesh.rotation.y = v.yaw;

    let state = this.visualState.get(v);
    if (!state) {
      state = { roll: 0, pitch: 0, steer: 0, spin: 0, wheelAngle: 0, prevSpeed: v.speed, accelSmooth: 0 };
      this.visualState.set(v, state);
    }
    const sdt = dt > 0 && Number.isFinite(dt) ? dt : 1 / 60;

    /* wheel spin: v = ω r → ω = v / r */
    const wheelRadius = data.wheels[0]?.radius ?? 0.34;
    state.spin = (state.spin + (v.speed / wheelRadius) * sdt) % (Math.PI * 2);
    for (let i = 0; i < data.wheels.length; i++) {
      const w = data.wheels[i];
      w.spin.rotation.x = state.spin;
      if (w.front) {
        // Steering visual: input-steer angle, full lock at low speed.
        const steerTarget = (input ? clamp(input.moveX, -1, 1) : 0) * 0.5 * (1 - clamp(Math.abs(v.speed) / 60, 0, 0.6));
        state.steer += (steerTarget - state.steer) * Math.min(1, sdt * 12);
        w.steer.rotation.y = state.steer;
      }
    }

    /* body pitch from smoothed acceleration, roll from smoothed yaw rate */
    const accel = (v.speed - state.prevSpeed) / sdt;
    state.prevSpeed = v.speed;
    state.accelSmooth += (accel - state.accelSmooth) * Math.min(1, sdt * 8);
    const braking = input ? input.handbrake || (input.moveY < -0.1 && v.speed > 0.5) || (input.moveY > 0.1 && v.speed < -0.5) : false;
    // Nose dives under braking, lifts under acceleration. Clamped so it never looks broken.
    const pitchTarget = clamp(-state.accelSmooth * 0.006, -0.06, 0.05) + (braking ? 0.025 : 0);
    // Roll: leaning out of a turn is proportional to lateral slip + yaw rate.
    const yawRateVisual = clamp(v.lateralSpeed / Math.max(Math.abs(v.speed), 4), -1, 1);
    const rollTarget = clamp(yawRateVisual * 0.06 + (data.spec.id === 'sport' ? 0.01 : 0.02) * Math.sign(v.lateralSpeed), -0.08, 0.08);
    state.pitch += (pitchTarget - state.pitch) * Math.min(1, sdt * 10);
    state.roll += (rollTarget - state.roll) * Math.min(1, sdt * 8);
    data.body.rotation.x = state.pitch;
    data.body.rotation.z = state.roll;

    /* brake lights */
    const brakingNow = braking || (input ? input.moveY < -0.05 && v.speed > 0.1 : false);
    const target = brakingNow ? 2.4 : 0.18;
    for (let i = 0; i < data.brakeLights.length; i++) {
      const m = data.brakeLights[i];
      m.emissiveIntensity += (target - m.emissiveIntensity) * Math.min(1, sdt * 18);
    }

    /* shadow blob stays on the ground and fades slightly with roll */
    data.shadow.position.y = 0.02;
  }

  /** Reset the visual smoothing state (call when teleporting a car). */
  resetVisuals(v: Vehicle): void {
    this.visualState.delete(v);
  }
}

interface VisualState {
  roll: number;
  pitch: number;
  steer: number;
  spin: number;
  wheelAngle: number;
  prevSpeed: number;
  accelSmooth: number;
}

/* -------------------------------------------------------------------------- */
/* Small math helpers                                                         */
/* -------------------------------------------------------------------------- */

function moveTowards(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

/**
 * Throttle vs steering authority: a car with no throttle steers at reduced
 * authority but can still pivot, so the player can turn on the spot out of a wall.
 */
function throttleAuthority(throttle: number, absSpeed: number): number {
  if (Math.abs(throttle) > 0.05) return 1;
  // Coasting: keep steering but a bit weaker; stationary: still allow pivoting.
  return absSpeed < 0.6 ? 0.55 : 0.8;
}
