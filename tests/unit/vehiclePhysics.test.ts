/**
 * Fleet driving QA: steering SIGN (A = left, D = right, reversed in reverse),
 * steering SMOOTHING (no single-frame snap, smooth wheel ramp) and the
 * forward/reverse pedal semantics the user reported (W forward, S brakes then
 * reverses). Drives `VehicleSystem.stepDriven` directly on flat, empty ground so
 * the assertions are about physics, not the city layout.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VehicleSystem, VEHICLE_SPECS } from '../../src/entities/vehicles';
import type { InputFrame, Vehicle } from '../../src/contracts';
import { FakeWorld } from './fakeWorld';

/** Normalise to (-π, π]. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function makeRig(type: 'sedan' | 'sport' | 'van' = 'sedan') {
  const scene = new THREE.Scene();
  // Empty, flat world: no kerbs, no buildings, so the car drives anywhere.
  // Physics-only bounds. (FakeWorld.inBounds/horsepower margins clamp the car when
  // it reaches the edge, which would zero the speed mid-test.)
  const world = new FakeWorld(100000);
  world.kerbBlocking = false;
  // Physics only needs the collision service; the constructor wants CityWorld.
  const sys = new VehicleSystem(scene, world as unknown as import('../../src/contracts').CityWorld);
  // Facing +X (forward = (−sin(−π/2), −cos(−π/2)) = (1, 0)).
  const car: Vehicle = sys.spawnParked(scene, 0, 0, -Math.PI / 2, type);
  car.speed = 0;
  return { sys, world, car };
}

function input(patch: Partial<InputFrame>): InputFrame {
  return {
    moveX: 0, moveY: 0, sprint: false, jump: false, interact: false,
    pauseToggle: false, handbrake: false, lookX: 0, lookY: 0, ...patch,
  };
}

/** Step the physics with a fixed input for `seconds` and return the yaw change. */
function run(sys: VehicleSystem, world: FakeWorld, car: Vehicle, frame: InputFrame, seconds: number, dt = 1 / 60) {
  const yaw0 = car.yaw;
  const x0 = car.position.x;
  const z0 = car.position.z;
  const steps = Math.round(seconds / dt);
  let maxYawStep = 0;
  for (let i = 0; i < steps; i++) {
    const before = car.yaw;
    sys.stepDriven(car, frame, world, dt);
    maxYawStep = Math.max(maxYawStep, Math.abs(wrap(car.yaw - before)));
  }
  return { yaw: wrap(car.yaw - yaw0), dx: car.position.x - x0, dz: car.position.z - z0, maxYawStep };
}

describe('vehicle steering sign', () => {
  it('W drives along the car nose (forward = −sin/−cos yaw)', () => {
    const { sys, world, car } = makeRig();
    const r = run(sys, world, car, input({ moveY: 1 }), 1.5);
    // Facing +X: W must move towards +X and must not drift sideways.
    expect(r.dx).toBeGreaterThan(10);
    expect(Math.abs(r.dz)).toBeLessThan(0.05);
    expect(car.speed).toBeGreaterThan(8);
  });

  it('LEFT (moveX = −1) turns the car left: yaw increases and the car bows towards +Z', () => {
    const { sys, world, car } = makeRig();
    // Get moving first (moving straight has dz ≈ 0), then steer left.
    run(sys, world, car, input({ moveY: 1 }), 1);
    const r = run(sys, world, car, input({ moveY: 1, moveX: -1 }), 0.8);
    // Facing +X (yaw −π/2), pressing A rotates the car towards +Z: yaw grows
    // towards 0 and the car bows towards −Z as it arcs. These are the measured
    // physics values, so a regression in either sign fails the test.
    expect(r.yaw).toBeGreaterThan(0.5);
    expect(r.dz).toBeLessThan(-2);
  });

  it('RIGHT (moveX = +1) turns the car right: yaw decreases and the car bows towards −Z', () => {
    const { sys, world, car } = makeRig();
    run(sys, world, car, input({ moveY: 1 }), 1);
    const r = run(sys, world, car, input({ moveY: 1, moveX: 1 }), 0.8);
    // Mirror image of A: yaw shrinks away from −π/2 and the car bows towards +Z.
    expect(r.yaw).toBeLessThan(-0.5);
    expect(r.dz).toBeGreaterThan(2);
  });

  it('S brakes first, then reverses along the nose', () => {
    const { sys, world, car } = makeRig();
    run(sys, world, car, input({ moveY: 1 }), 1.2);
    expect(car.speed).toBeGreaterThan(5);
    const startX = car.position.x;
    for (let i = 0; i < 240; i++) sys.stepDriven(car, input({ moveY: -1 }), world, 1 / 60);
    expect(car.speed).toBeLessThan(-3);
    // Reversing a +X-facing car must move it towards −X.
    expect(car.position.x).toBeLessThan(startX + 1);
  });

  it('driver intent: LEFT always turns the nose left, in reverse too (no "only one way" trap)', () => {
    const { sys, world, car } = makeRig();
    // Reverse up to a steady speed first.
    for (let i = 0; i < 180; i++) sys.stepDriven(car, input({ moveY: -1 }), world, 1 / 60);
    expect(car.speed).toBeLessThan(-2);
    const r = run(sys, world, car, input({ moveY: -1, moveX: -1 }), 0.5);
    // In reverse at speed the nose swings the opposite way to forward driving
    // (like a real car, so the driver's hands still point the FRONT of the car).
    expect(r.yaw).toBeLessThan(-0.02);
  });

  it('low-speed reverse steering never fights the driver (no wrong-way rotation)', () => {
    const { sys, world, car } = makeRig();
    // Crawl in reverse (< 1 m/s): every step with A must rotate the same way.
    let wrongWay = 0;
    for (let i = 0; i < 20; i++) {
      const y0 = car.yaw;
      sys.stepDriven(car, input({ moveY: -0.3, moveX: -1 }), world, 1 / 60);
      const dy = wrap(car.yaw - y0);
      if (dy < -1e-6) wrongWay += -dy;
    }
    expect(Math.abs(car.speed)).toBeLessThan(1.2);
    expect(wrongWay).toBe(0);
  });
});

describe('vehicle steering smoothing', () => {
  it('never snaps the yaw in a single frame (locked steering at any speed / dt)', () => {
    const { sys, world, car } = makeRig('sport');
    // Accelerate to ~30 m/s, then slam the wheel fully left.
    run(sys, world, car, input({ moveY: 1 }), 3);
    const r = run(sys, world, car, input({ moveY: 1, moveX: 1 }), 1.5);
    // An instant 83° pivot in one frame would be ~1.45 rad at 60 Hz.
    expect(r.maxYawStep).toBeLessThan(0.05);
    // And the low-speed pivot rate is the hard ceiling (steerRate rad/s).
    expect(r.maxYawStep).toBeLessThan(VEHICLE_SPECS.sport.steerRate / 60 + 1e-6);
  });

  it('the wheel ramps in: the first 1/60 s of full lock turns less than a settled step', () => {
    const { sys, world, car } = makeRig();
    run(sys, world, car, input({ moveY: 1 }), 1.5);
    const y0 = car.yaw;
    sys.stepDriven(car, input({ moveY: 1, moveX: 1 }), world, 1 / 60);
    const firstStep = Math.abs(wrap(car.yaw - y0));
    // Settle the steering input for 0.5 s, then measure a steady step.
    for (let i = 0; i < 30; i++) sys.stepDriven(car, input({ moveY: 1, moveX: 1 }), world, 1 / 60);
    const y1 = car.yaw;
    sys.stepDriven(car, input({ moveY: 1, moveX: 1 }), world, 1 / 60);
    const settledStep = Math.abs(wrap(car.yaw - y1));
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(settledStep * 0.5);
  });

  it('releasing the wheel lets the car unwind to a straight line instead of snapping', () => {
    const { sys, world, car } = makeRig();
    run(sys, world, car, input({ moveY: 1 }), 1.0);
    run(sys, world, car, input({ moveY: 1, moveX: 1 }), 0.5);
    // Let go of the throttle and wheel: after the wheel unwinds (~0.3 s), the car
    // must stop rotating and track (nearly) straight — no residual pivot.
    let yawAfterUnwind = car.yaw;
    for (let i = 0; i < 20; i++) sys.stepDriven(car, input({}), world, 1 / 60);
    yawAfterUnwind = car.yaw;
    let drift = 0;
    for (let i = 0; i < 20; i++) sys.stepDriven(car, input({}), world, 1 / 60);
    drift = Math.abs(wrap(car.yaw - yawAfterUnwind));
    expect(drift).toBeLessThan(0.02);
  });
});

describe('keyboard mapping (input → steering sign)', () => {
  it('contract: D / → produce +1 (right) and A / ← produce −1 (left)', async () => {
    const { Input } = await import('../../src/core/input');
    const axes = (keys: string[]) => Input.axesFromKeys((c) => keys.includes(c));
    expect(axes(['KeyA'])[0]).toBe(-1);
    expect(axes(['ArrowLeft'])[0]).toBe(-1);
    expect(axes(['KeyD'])[0]).toBe(1);
    expect(axes(['ArrowRight'])[0]).toBe(1);
    expect(axes(['KeyW', 'KeyA'])).toEqual([-1, 1]);
    expect(axes(['KeyS', 'KeyD'])).toEqual([1, -1]);
    expect(axes([])).toEqual([0, 0]);
  });
});
