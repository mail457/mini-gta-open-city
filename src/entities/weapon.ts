/**
 * SHOOTING — a light hitscan weapon with AAA-style feedback (Lead-owned).
 *
 * Features: two weapons (pistol / SMG), spread, recoil kick returned to the
 * camera, muzzle flash, tracer streaks, impact sparks, and friendly limits
 * (damage is applied by the caller to pedestrians/NPC cars — never to the player).
 *
 * Everything is deterministic given the RNG, so it is unit-testable in Node.
 */
import * as THREE from 'three';
import type { Rect, WeaponId, WeaponSpec } from '../contracts';

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  pistol: {
    id: 'pistol',
    label: 'Pistol',
    damage: 34,
    cooldown: 0.22,
    magSize: 12,
    reserve: 72,
    spread: 0.012,
    range: 60,
    kick: 0.022,
    auto: false,
  },
  smg: {
    id: 'smg',
    label: 'SMG',
    damage: 18,
    cooldown: 0.085,
    magSize: 30,
    reserve: 120,
    spread: 0.045,
    range: 45,
    kick: 0.014,
    auto: true,
  },
};

export interface ShotTarget {
  /** Centre of the target in world space. */
  position: THREE.Vector3;
  radius: number;
  /** Applied by the caller via onHit. */
  id: number;
}

export interface ShotResult {
  fired: boolean;
  /** Where the bullet ended. */
  end: THREE.Vector3;
  /** Target id hit (or -1). */
  hitId: number;
  /** Raw damage applied to the hit target. */
  damage: number;
  /** True when the shot hit a world collider (wall/prop) instead of a target. */
  wall: boolean;
}

export interface ShotRaycast {
  /** Static world colliders as XZ boxes with height. */
  colliders: readonly Rect[];
  /** Dynamic targets (pedestrians, traffic cars). */
  targets: readonly ShotTarget[];
}

const rng = (() => {
  let s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
})();

/** Ray vs axis-aligned box (slab method). Returns distance or null. */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  rect: Rect,
): number | null {
  const x0 = rect.x - rect.hx;
  const x1 = rect.x + rect.hx;
  const z0 = rect.z - rect.hz;
  const z1 = rect.z + rect.hz;
  const y0 = 0;
  const y1 = rect.height ?? 40;
  let tmin = 0;
  let tmax = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, x0, x1],
    [oy, dy, y0, y1],
    [oz, dz, z0, z1],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Ray vs sphere; returns distance to the near intersection or null. */
export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}

export interface WeaponState {
  spec: WeaponSpec;
  mag: number;
  reserve: number;
  /** Seconds until the next shot can fire. */
  cooldown: number;
  armed: boolean;
  shots: number;
  hits: number;
}

export function createWeaponState(id: WeaponId = 'pistol'): WeaponState {
  const spec = WEAPONS[id];
  return { spec, mag: spec.magSize, reserve: spec.reserve, cooldown: 0, armed: true, shots: 0, hits: 0 };
}

export function switchWeapon(state: WeaponState, id: WeaponId): void {
  if (state.spec.id === id) return;
  // Keeping the loaded state when swapping back and forth is friendlier than
  // refilling magically; the reserve pool is per weapon. Default: fresh mag.
  state.spec = WEAPONS[id];
  state.mag = state.spec.magSize;
  state.reserve = state.spec.reserve;
}

/** Refill this weapon (e.g. every mission restart). */
export function refill(state: WeaponState): void {
  state.mag = state.spec.magSize;
  state.reserve = state.spec.reserve;
}

export class WeaponSystem {
  readonly group = new THREE.Group();
  private tracerPool: Array<{ mesh: THREE.Mesh; life: number; max: number }> = [];
  private sparks: Array<{ mesh: THREE.Mesh; life: number; vel: THREE.Vector3 }> = [];
  private flash: THREE.PointLight | null = null;
  private muzzle: THREE.Mesh | null = null;
  private tracerGeo: THREE.CylinderGeometry;
  private tracerMat: THREE.MeshBasicMaterial;
  private sparkGeo: THREE.BoxGeometry;
  private sparkMat: THREE.MeshBasicMaterial;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'weapon-fx';
    this.tracerGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 6, 1, true);
    this.tracerGeo.rotateX(Math.PI / 2); // along +Z, then lookAt orients it
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    // A small muzzle flash light so the scene reacts to shots.
    this.flash = new THREE.PointLight(0xffcc88, 0, 9, 2);
    this.group.add(this.flash);
    this.muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe8a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(this.muzzle);
    scene.add(this.group);
  }

  /**
   * Fire once from `origin` along `dir` (unit). Returns what happened; the
   * caller applies `damage` to the target with `hitId`.
   */
  tryShoot(state: WeaponState, origin: THREE.Vector3, dir: THREE.Vector3, world: ShotRaycast): ShotResult {
    const none: ShotResult = { fired: false, end: origin.clone(), hitId: -1, damage: 0, wall: false };
    if (!state.armed || state.cooldown > 0) return none;
    if (state.mag <= 0) return none;

    state.cooldown = state.spec.cooldown;
    state.mag--;
    state.shots++;

    // Spread: perturb the direction inside a small cone.
    const spread = state.spec.spread;
    const d = dir.clone().normalize();
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(d, up).normalize();
    const realUp = new THREE.Vector3().crossVectors(right, d).normalize();
    const a = (rng() * 2 - 1) * spread;
    const b = (rng() * 2 - 1) * spread;
    d.addScaledVector(right, a).addScaledVector(realUp, b).normalize();

    // Nearest target along the ray.
    let bestT = state.spec.range;
    let hitId = -1;
    for (const t of world.targets) {
      const tt = raySphere(origin, d, t.position, t.radius);
      if (tt !== null && tt < bestT) {
        bestT = tt;
        hitId = t.id;
      }
    }
    // Nearest wall (only counts if closer than the target).
    let wall = false;
    for (const rect of world.colliders) {
      const tt = rayBox(origin.x, origin.y, origin.z, d.x, d.y, d.z, rect);
      if (tt !== null && tt < bestT && tt > 0.2) {
        bestT = tt;
        wall = true;
        hitId = -1;
      }
    }
    const end = origin.clone().addScaledVector(d, bestT);
    if (hitId >= 0) state.hits++;

    this.spawnTracer(origin, end);
    this.spawnFlash(origin);
    if (hitId >= 0 || wall) this.spawnSparks(end);
    return { fired: true, end, hitId, damage: state.spec.damage, wall };
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    const len = from.distanceTo(to);
    mesh.scale.set(1, 1, Math.max(0.2, len));
    mesh.position.copy(from).lerp(to, 0.5);
    mesh.lookAt(to);
    this.group.add(mesh);
    this.tracerPool.push({ mesh, life: 0.055, max: 0.055 });
  }

  private spawnFlash(at: THREE.Vector3): void {
    if (this.flash) {
      this.flash.position.copy(at);
      this.flash.intensity = 7;
    }
    if (this.muzzle) {
      this.muzzle.position.copy(at);
      (this.muzzle.material as THREE.MeshBasicMaterial).opacity = 0.95;
      this.muzzle.scale.setScalar(0.7 + rng() * 0.6);
    }
  }

  private spawnSparks(at: THREE.Vector3): void {
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
      mesh.position.copy(at);
      this.group.add(mesh);
      this.sparks.push({
        mesh,
        life: 0.25,
        vel: new THREE.Vector3((rng() - 0.5) * 5, rng() * 4 + 1, (rng() - 0.5) * 5),
      });
    }
  }

  update(dt: number): void {
    this.time += dt;
    if (this.flash) this.flash.intensity = Math.max(0, this.flash.intensity - dt * 60);
    if (this.muzzle) {
      const m = this.muzzle.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, m.opacity - dt * 14);
    }
    for (let i = this.tracerPool.length - 1; i >= 0; i--) {
      const t = this.tracerPool[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.group.remove(t.mesh);
        this.tracerPool.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      s.vel.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.life <= 0) {
        this.group.remove(s.mesh);
        this.sparks.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.tracerGeo.dispose();
    this.tracerMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.group.removeFromParent();
  }
}
