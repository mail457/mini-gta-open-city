import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { InputFrame } from '../../src/contracts';
import { PLAYER_TUNING, Player, createPlayer } from '../../src/entities/player';
import { FakeWorld } from './fakeWorld';

const DT = 1 / 60;

function input(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    moveX: 0,
    moveY: 0,
    sprint: false,
    jump: false,
    interact: false,
    pauseToggle: false,
    handbrake: false,
    lookX: 0,
    lookY: 0,
    ...overrides,
  };
}

/** Step the player n times with the same input. */
function run(p: Player, n: number, inp: InputFrame, cameraYaw = 0): void {
  for (let i = 0; i < n; i++) p.update(DT, inp, cameraYaw);
}

describe('Player — on-foot controller', () => {
  it('walks forward toward −Z with moveY = 1 and cameraYaw = 0', () => {
    const world = new FakeWorld();
    const scene = new THREE.Scene();
    const p = createPlayer(scene, world, 0, 0, 0);
    // Camera convention check: cameraYaw 0 looks towards −Z.
    const z0 = p.position.z;
    run(p, 60, input({ moveY: 1 }));
    expect(p.position.z).toBeLessThan(z0 - 3);
    expect(Math.abs(p.position.x)).toBeLessThan(1e-6);
    expect(p.position.z).toBeGreaterThan(z0 - PLAYER_TUNING.walkSpeed);
    // Walk speed is reached (smoothly) and capped there.
    expect(p.speed).toBeGreaterThan(PLAYER_TUNING.walkSpeed * 0.97);
    expect(p.speed).toBeLessThanOrEqual(PLAYER_TUNING.walkSpeed + 1e-6);
    // Facing follows the move direction: forward = (−sin yaw, −cos yaw) = (0, −1) ⇒ yaw ≈ 0.
    expect(Math.abs(p.yaw)).toBeLessThan(1e-6);
    expect(p.walkPhase).toBeGreaterThanOrEqual(0);
    expect(p.walkPhase).toBeLessThan(Math.PI * 2);
  });

  it('is camera-relative: moveX = 1 with cameraYaw 0 strafes toward +X', () => {
    const world = new FakeWorld();
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    run(p, 30, input({ moveX: 1 }));
    expect(p.position.x).toBeGreaterThan(1);
    expect(Math.abs(p.position.z)).toBeLessThan(1e-6);
  });

  it('normalises diagonal input (no extra speed), and sprints faster than walking', () => {
    const world = new FakeWorld();
    const scene = new THREE.Scene();
    const walker = new Player(new THREE.Scene(), world, 0, 0, 0);
    const diag = new Player(new THREE.Scene(), world, 0, 50, 0);
    const sprinter = new Player(new THREE.Scene(), world, 0, -50, 0);
    run(walker, 90, input({ moveY: 1 }));
    run(diag, 90, input({ moveY: 1, moveX: 1 }));
    run(sprinter, 90, input({ moveY: 1, sprint: true }));
    expect(diag.speed).toBeCloseTo(walker.speed, 5);
    expect(sprinter.speed).toBeGreaterThan(walker.speed * 1.5);
    expect(sprinter.speed).toBeLessThanOrEqual(PLAYER_TUNING.runSpeed + 1e-6);
    expect(sprinter.speed).toBeGreaterThan(PLAYER_TUNING.runSpeed * 0.95);
    void scene;
  });

  it('cannot pass through a building collider and slides along it', () => {
    const world = new FakeWorld();
    // Building wall at z = -5 facing the walker, 20 m wide.
    world.addBuilding(0, -5, 10, 2);
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    run(p, 180, input({ moveY: 1 }));
    // Walkable edge of the building = z_face + radius = -3 + 0.42.
    expect(p.position.z).toBeGreaterThanOrEqual(-3 + PLAYER_TUNING.radius - 1e-6);
    expect(world.overlapsCircle(p.position.x, p.position.z, PLAYER_TUNING.radius)).toBe(false);
    // Pressing diagonally into the wall slides along it.
    const zBefore = p.position.z;
    run(p, 60, input({ moveY: 1, moveX: 1 }));
    expect(p.position.z).toBeGreaterThanOrEqual(zBefore - 0.05);
    expect(p.position.x).toBeGreaterThan(1.5);
    expect(world.overlapsCircle(p.position.x, p.position.z, PLAYER_TUNING.radius)).toBe(false);
  });

  it('jumps: rises above the ground, is grounded again after landing, never sinks', () => {
    const world = new FakeWorld();
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    // Warm up on the ground for a frame.
    p.update(DT, input(), 0);
    expect(p.isGrounded).toBe(true);
    p.update(DT, input({ jump: true }), 0);
    expect(p.didJump).toBe(true);
    expect(p.isGrounded).toBe(false);
    // Jump edge is only reported on the frame the jump starts.
    p.update(DT, input({ jump: true }), 0);
    expect(p.didJump).toBe(false);

    let apex = 0;
    let minY = Infinity;
    for (let i = 0; i < 120; i++) {
      p.update(DT, input(), 0);
      apex = Math.max(apex, p.position.y);
      minY = Math.min(minY, p.position.y);
      expect(Number.isFinite(p.position.y)).toBe(true);
    }
    // v²/2g = 7.2² / 52 ≈ 1.0 m.
    expect(apex).toBeGreaterThan(0.85);
    expect(apex).toBeLessThan(1.15);
    expect(minY).toBeGreaterThanOrEqual(-1e-9);
    expect(p.isGrounded).toBe(true);
    expect(p.position.y).toBeCloseTo(0, 6);
  });

  it('steps up a kerb seamlessly and stays on top of it', () => {
    const world = new FakeWorld();
    world.addGround(0, -6, 4, 4); // raised pavement from z = -10..-2
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    run(p, 60, input({ moveY: 1 }));
    expect(p.position.z).toBeLessThan(-2); // walked onto the kerb
    expect(p.position.y).toBeCloseTo(world.kerbHeight, 6);
    expect(p.isGrounded).toBe(true);
  });

  it('is clamped to the world bounds', () => {
    const world = new FakeWorld(20);
    const p = new Player(new THREE.Scene(), world, 0, 0, Math.PI); // facing +Z
    run(p, 600, input({ moveY: 1, sprint: true }), 0); // camera-relative ⇒ −Z, hits the -Z edge
    expect(p.position.z).toBeGreaterThanOrEqual(-20);
    expect(world.inBounds(p.position.x, p.position.z, 0)).toBe(true);
    void p;
  });

  it('no-ops and stops reporting movement while onFoot = false', () => {
    const world = new FakeWorld();
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    p.onFoot = false;
    const z0 = p.position.z;
    run(p, 60, input({ moveY: 1 }));
    expect(p.position.z).toBe(z0);
    expect(p.speed).toBe(0);
    expect(p.didJump).toBe(false);
  });

  it('setPosition snaps to the ground and out of colliders', () => {
    const world = new FakeWorld();
    world.addGround(5, 5, 2, 2);
    world.addBuilding(10, 10, 3, 3);
    const p = new Player(new THREE.Scene(), world, 0, 0, 0);
    p.setPosition(5, 5, Math.PI / 2);
    expect(p.position.y).toBeCloseTo(world.kerbHeight, 6);
    expect(p.yaw).toBeCloseTo(Math.PI / 2, 6);
    p.setPosition(10, 10);
    expect(world.overlapsCircle(p.position.x, p.position.z, PLAYER_TUNING.radius)).toBe(false);
  });

  it('builds a ~1.75 m avatar and dispose() detaches it from the scene', () => {
    const world = new FakeWorld();
    const scene = new THREE.Scene();
    const p = new Player(scene, world, 0, 0, 0);
    expect(p.object.parent).toBe(scene);
    p.object.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(p.object);
    const height = bbox.max.y - bbox.min.y;
    expect(height).toBeGreaterThan(1.65);
    expect(height).toBeLessThan(2.0); // cap/hat adds a few cm above ~1.8 m
    expect(bbox.min.y).toBeGreaterThan(-0.05);
    expect(bbox.min.y).toBeLessThan(0.05);
    // Avatar mesh yaw follows the game yaw convention.
    p.object.rotation.y = 0;
    expect(p.object.position.y).toBeCloseTo(0, 6);
    p.dispose();
    expect(p.object.parent).toBeNull();
  });
});
