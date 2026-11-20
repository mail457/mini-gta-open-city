/**
 * Shooting: weapon state machine, hitscan raycasts and the friendly limits.
 * Pure logic, no DOM, no renderer.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WEAPONS, createWeaponState, rayBox, raySphere, refill, switchWeapon } from '../../src/entities/weapon';

const O = new THREE.Vector3(0, 1.5, 0);

describe('weapon state', () => {
  it('fires exactly one round per cooldown and never below zero', () => {
    const w = createWeaponState('pistol');
    expect(w.mag).toBe(WEAPONS.pistol.magSize);
    // Cooldown blocks a second instant shot.
    w.cooldown = WEAPONS.pistol.cooldown;
    expect(w.mag).toBe(WEAPONS.pistol.magSize);
    w.cooldown = 0;
    w.mag = 0;
    refill(w);
    expect(w.mag).toBe(WEAPONS.pistol.magSize);
    expect(w.reserve).toBe(WEAPONS.pistol.reserve);
  });

  it('switching to a different weapon arms a fresh magazine; same weapon is a no-op', () => {
    const w = createWeaponState('pistol');
    w.mag = 3;
    switchWeapon(w, 'pistol');
    expect(w.mag).toBe(3);
    switchWeapon(w, 'smg');
    expect(w.spec.id).toBe('smg');
    expect(w.mag).toBe(WEAPONS.smg.magSize);
  });
});

describe('hitscan geometry', () => {
  it('ray vs axis-aligned box hits the near face and misses when parallel', () => {
    const wall = { x: 0, z: -10, hx: 4, hz: 1, height: 10 };
    const t = rayBox(O.x, O.y, O.z, 0, 0, -1, wall);
    expect(t).toBeCloseTo(9, 5); // from z=0 to the near face at z=-9
    expect(rayBox(O.x, 50, O.z, 0, 1, 0, wall)).toBeNull(); // above the wall
    expect(rayBox(O.x, O.y, O.z, 1, 0, 0, wall)).toBeNull(); // parallel, never meets
  });

  it('ray vs sphere returns the near intersection only when in front', () => {
    const target = new THREE.Vector3(0, 1.5, -5);
    const t = raySphere(O, new THREE.Vector3(0, 0, -1), target, 0.5);
    expect(t).toBeCloseTo(4.5, 5);
    // Looking the other way never hits.
    expect(raySphere(O, new THREE.Vector3(0, 0, 1), target, 0.5)).toBeNull();
  });
});
