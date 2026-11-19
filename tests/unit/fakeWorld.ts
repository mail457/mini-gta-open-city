/**
 * Fake CollisionService for player / vehicle physics tests.
 * Mirrors the real contract semantics:
 *   - buildings & props are AABBs (Rect: centre + half extents) pushed out of
 *     circle queries along the axis of least penetration;
 *   - 'ground' rects are walkable (they only change groundHeight);
 *   - `inBounds` is a square world with an optional margin.
 * Deterministic, allocation-light, no THREE dependency.
 */
import type { CollisionService, Rect, XZ } from '../../src/contracts';

export class FakeWorld implements CollisionService {
  readonly colliders: Rect[] = [];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Kerb height applied inside 'ground' rects. */
  kerbHeight = 0.16;

  constructor(half = 100) {
    this.minX = -half;
    this.maxX = half;
    this.minZ = -half;
    this.maxZ = half;
  }

  /** Add a building (blocks both walking and cars). */
  addBuilding(x: number, z: number, hx: number, hz: number, height = 20): Rect {
    const r: Rect = { x, z, hx, hz, height, kind: 'building' };
    this.colliders.push(r);
    return r;
  }

  /** Add a walkable raised area (kerb / plaza). */
  addGround(x: number, z: number, hx: number, hz: number, height = this.kerbHeight): Rect {
    const r: Rect = { x, z, hx, hz, height, kind: 'ground' };
    this.colliders.push(r);
    return r;
  }

  resolveCircle(cx: number, cz: number, r: number): XZ {
    let x = cx;
    let z = cz;
    // Two passes so a circle wedged in a corner settles against both walls.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const c of this.colliders) {
        if (c.kind === 'ground') continue;
        const dx = x - c.x;
        const dz = z - c.z;
        const penX = c.hx + r - Math.abs(dx);
        const penZ = c.hz + r - Math.abs(dz);
        if (penX <= 0 || penZ <= 0) continue;
        // Push out along the axis of least penetration.
        if (penX < penZ) x += Math.sign(dx || 1) * penX;
        else z += Math.sign(dz || 1) * penZ;
        moved = true;
      }
      if (!moved) break;
    }
    return { x, z };
  }

  overlapsCircle(cx: number, cz: number, r: number): boolean {
    const p = this.resolveCircle(cx, cz, r);
    return p.x !== cx || p.z !== cz;
  }

  inBounds(x: number, z: number, margin = 0): boolean {
    return x >= this.minX + margin && x <= this.maxX - margin && z >= this.minZ + margin && z <= this.maxZ - margin;
  }

  groundHeight(x: number, z: number): number {
    let h = 0;
    for (const c of this.colliders) {
      if (c.kind !== 'ground') continue;
      if (Math.abs(x - c.x) <= c.hx && Math.abs(z - c.z) <= c.hz) h = Math.max(h, c.height ?? 0);
    }
    return h;
  }

  isRoad(x: number, z: number): boolean {
    // Horizontal strip around z = 0 of half width 8 (enough for tests).
    return Math.abs(z) < 8 && this.inBounds(x, z, 0);
  }
}
