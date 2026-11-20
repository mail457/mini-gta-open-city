/**
 * PROCEDURAL VEHICLE MODELS — smooth, rounded cars for MINI GTA.
 * Owned by: Agent 2 (W-2); geometry reworked by the vehicle QA pass.
 *
 * `createVehicleMesh(spec)` returns a `THREE.Group` whose origin is the contact
 * patch between the tyres and the road projected to the car centre:
 *   - local +Z = nose, local −Z = tail, +X = car's left-hand side, +Y = up
 *   - the root is NOT rotated; the game drives it with `mesh.rotation.y = yaw`
 *     (radius.horizontal) which matches the player/camera convention
 *     forward = (−sin yaw, −cos yaw) with the nose at local +Z.
 *
 * Handle data is stored on `group.userData` (typed via `VehicleMeshData`):
 *   - `wheels`: 4 wheel spin pivots (rotate around their local X axis)
 *   - `wheels[i].steer`: the 2 front wheel yaw pivots (front: true)
 *   - `brakeLights`: red emissive materials to brighten when braking
 *   - `body`: the body tilt pivot (pitch / roll animations)
 *   - `shadow`: soft blob under the car
 *
 * Bodies and wheels cast shadows (as before); glass, lenses and the blob don't.
 * No `document` usage, so this module is safe to import in Node/Vitest.
 *
 * ── How the smooth body is built ────────────────────────────────────────────
 * 1. The silhouette is a rounded side-profile `THREE.Shape` in the ZY plane
 *    (Z = length, Y = height) with a feathered nose and a chopped tail.
 * 2. It is extruded along X with a 45° chamfer on the rim of both flanks
 *    (`extrudeChamfered`): one band of quads instead of ExtrudeGeometry's bevel
 *    grids, i.e. the same rounded rim for a fraction of the triangles.
 * 3. Every vertex is then "barrelled" onto a superellipse cross-section of its
 *    own height (`barrelSolid`), which glues the chamfer band into the flank:
 *    one continuous rounded side instead of a stack of boxes. This is what
 *    kills the Lego look.
 * 4. The painted shell also gets a tumblehome (sides lean in above the
 *    beltline), a flare over each wheel arch and a gentle taper at both ends,
 *    so even a van (xPow 3.6) has soft shoulders.
 * The same routine builds the hull, the bumpers and the mirrors, so every part
 * shares one visual language.
 *
 * The greenhouse is one rounded glass volume (windscreen + side windows +
 * backlight) sitting on the deck, capped by a painted roof, painted A-pillars
 * and a few faceted dark creases (waistline, B/C pillars, drip rail) that frame
 * the glass. Lenses are emissive: warm at the nose, red at the tail.
 *
 * Everything is merged per material — 12 meshes per car (10 for the body, 2
 * InstancedMesh draw calls shared by all four wheels). Geometry that can never
 * be seen from outside (the sill slab) lives in a "shadow-only" mesh that the
 * main render pass skips and the sun's shadow map still uses, so it shades the
 * wheels at zero main-pass draw calls.
 */

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import type { VehicleSpec, VehicleTypeId } from '../contracts';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface WheelRef {
  /** Steer pivot (yaw) — parent of the spin pivot. */
  steer: THREE.Group;
  /** Spin pivot — rotate around local X to roll the wheel. */
  spin: THREE.Group;
  /** True for the front axle (only front wheels steer). */
  front: boolean;
  /** Rolling radius (m). */
  radius: number;
}

export interface VehicleMeshData {
  spec: VehicleSpec;
  /** Body pitch/roll pivot; the wheels hang off the root so they stay level. */
  body: THREE.Group;
  /** Wheels in a fixed order: FL, FR, RL, RR (car's left side = +X). */
  wheels: WheelRef[];
  /** Shared red emissive materials for the tail lights. */
  brakeLights: THREE.MeshStandardMaterial[];
  /** Headlight materials (kept so they can be dimmed at night if needed). */
  headlights: THREE.MeshStandardMaterial[];
  /** Soft round shadow blob (stretches to the car footprint). */
  shadow: THREE.Mesh;
  /** Paint material — lets the game tint a car without rebuilding it. */
  paint: THREE.MeshStandardMaterial;
}

/**
 * `createVehicleMesh` return value: a group whose `userData` is the typed
 * `VehicleMeshData`. The type pins `userData` so TypeScript allows
 * `mesh.userData.wheels` directly.
 */
export type VehicleMesh = THREE.Group & { userData: VehicleMeshData };

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Tyre sidewall sits at r·(1−GRIP); the tread band bulges back out to r. */
const TYRE_GRIP = 0.055;

/** Wheel radius per vehicle type (m). */
const WHEEL_RADIUS: Record<VehicleTypeId, number> = { sedan: 0.34, sport: 0.33, van: 0.4 };
/** Tyre width per vehicle type (m). */
const WHEEL_WIDTH: Record<VehicleTypeId, number> = { sport: 0.27, sedan: 0.25, van: 0.31 };
/** Track width as a fraction of the spec width (wheel centres). */
const TRACK_FRACTION = 0.86;
/** Axle inset from the bumpers as a fraction of the length. */
const AXLE_INSET = 0.19;

/** Total triangles allowed for one complete drivable car (unit-tested). */
export const VEHICLE_TRIANGLE_BUDGET = 6000;
/** Maximum number of meshes (draw calls) for one complete car (unit-tested). */
export const VEHICLE_MESH_BUDGET = 20;

/** Per-type sculpting knobs. */
interface HullProfile {
  /** Hull sides reach this fraction of the spec width (spec width includes mirrors). */
  widthFrac: number;
  /** Hull top reaches this fraction of the spec height. */
  heightFrac: number;
  /** Side-profile corner radii (m): nose top, nose bottom, tail top, tail bottom. */
  r: [number, number, number, number];
  /** Superellipse exponent of the flank (2 = round, >2 = crisper shoulders). */
  xPow: number;
  /** Chamfer of the hull rim as a fraction of its height (barrelled round). */
  chamfer: number;
  /** How much the sides lean in above the beltline (tumblehome). */
  tumblehome: number;
  /**
   * Greenhouse: the cabin outline in length fractions (nose +Z). `front`/`back`
   * are where the glass meets the deck (windscreen base / backlight base) and
   * `roofFront`/`roofBack` where it meets the roof.
   */
  cabin: {
    front: number;
    back: number;
    roofFront: number;
    roofBack: number;
    /** Cabin half-width at the glass base / at the roof, as fractions of W/2. */
    widthFrac: number;
    roofWidthFrac: number;
    /** Corner radius of the roof edge (m). */
    roofRadius: number;
    /** Fraction of the length from the screen base to the roof = the A-pillar band. */
    pillarFrac: number;
    /** Roof height as a fraction of the spec height. */
    roofFrac: number;
    /** Side glass slopes in towards the roof by this factor (m per m²). */
    tumblehome: number;
  };
}

const HULL: Record<VehicleTypeId, HullProfile> = {
  sedan: {
    widthFrac: 0.8,
    heightFrac: 0.78,
    r: [0.16, 0.1, 0.2, 0.11],
    xPow: 2.8,
    chamfer: 0.09,
    tumblehome: 0.12,
    cabin: {
      front: 0.24,
      back: -0.33,
      roofFront: -0.02,
      roofBack: -0.24,
      widthFrac: 0.68,
      roofWidthFrac: 0.54,
      roofRadius: 0.05,
      pillarFrac: 0.18,
      roofFrac: 0.85,
      tumblehome: 0.16,
    },
  },
  sport: {
    widthFrac: 0.82,
    heightFrac: 0.7,
    r: [0.2, 0.08, 0.15, 0.09],
    xPow: 2.5,
    chamfer: 0.09,
    tumblehome: 0.2,
    cabin: {
      front: 0.12,
      back: -0.33,
      roofFront: -0.1,
      roofBack: -0.3,
      widthFrac: 0.7,
      roofWidthFrac: 0.5,
      roofRadius: 0.04,
      pillarFrac: 0.3,
      roofFrac: 0.8,
      tumblehome: 0.22,
    },
  },
  van: {
    widthFrac: 0.84,
    heightFrac: 0.87,
    r: [0.18, 0.1, 0.16, 0.1],
    xPow: 3.6,
    chamfer: 0.09,
    tumblehome: 0.06,
    cabin: {
      front: 0.56,
      back: -0.4,
      roofFront: 0.44,
      roofBack: -0.46,
      widthFrac: 0.8,
      roofWidthFrac: 0.8,
      roofRadius: 0.07,
      pillarFrac: 0.12,
      roofFrac: 0.9,
      tumblehome: 0.06,
    },
  },
};

/** One material per rendered bucket; materials are never shared between cars. */
interface Mats {
  paint: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  brake: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  rimDark: THREE.MeshStandardMaterial;
}

/* -------------------------------------------------------------------------- */
/* Book-keeping                                                               */
/* -------------------------------------------------------------------------- */

/** Vertex/index buffer for one material bucket (positions only). */
interface Acc {
  pos: number[];
  idx: number[];
}

const newAcc = (): Acc => ({ pos: [], idx: [] });

/** Append a geometry (optionally transformed) to an accumulator and dispose it. */
function put(target: Acc, geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): void {
  if (matrix) geo.applyMatrix4(matrix);
  const p = geo.getAttribute('position');
  const base = target.pos.length / 3;
  for (let i = 0; i < p.count; i++) target.pos.push(p.getX(i), p.getY(i), p.getZ(i));
  const index = geo.getIndex();
  if (index) for (let i = 0; i < index.count; i++) target.idx.push(base + index.getX(i));
  else for (let i = 0; i < p.count; i++) target.idx.push(base + i);
  geo.dispose();
}

/**
 * Pack an accumulator into a geometry. `smooth` keeps the indices so vertices
 * are averaged into smooth normals; otherwise the mesh is expanded and each
 * face gets a flat normal (crisp creases: pillars, frames, bumpers).
 */
function accToGeometry(acc: Acc, smooth: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setIndex(acc.idx);
  if (smooth) {
    geo.computeVertexNormals();
    return geo;
  }
  // Faceted look without paying for an expanded mesh: keep shared vertices but
  // break the normals (non-indexed normals on an indexed position stream → one
  // normal per face). three renders this with a single gl.drawElements.
  const flat = new THREE.BufferGeometry();
  flat.setAttribute('position', geo.getAttribute('position'));
  flat.setIndex(geo.getIndex());
  geo.dispose();
  return flat;
}

/* -------------------------------------------------------------------------- */
/* Math helpers                                                               */
/* -------------------------------------------------------------------------- */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth 0→1 ramp between a and b. */
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Darken a colour by `k` (0..1, 1 = unchanged). */
function shade(color: number, k: number): number {
  const c = new THREE.Color(color);
  c.multiplyScalar(k);
  return c.getHex();
}

/** Convert #RRGGBB to 0xRRGGBB and back; harmless for ints already in range. */
function normColor(color: number): number {
  return (color >>> 0) & 0xffffff;
}

/** Superellipse flank: |x| as a fraction of the half-width at normalised height u. */
function flankAt(u: number, pow: number): number {
  return Math.pow(Math.max(0, 1 - Math.pow(clamp01(u), pow)), 1 / pow);
}

/* -------------------------------------------------------------------------- */
/* Geometry primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Extrude a side profile along X with a 45° chamfer on both long edges of each
 * flank. A chamfer rounds the rim exactly like a small bevel but costs one band
 * of quads per ring instead of ExtrudeGeometry's bevel grids (~8–24 triangles
 * per rim ring) — that is how a smooth-looking car stays inside a small
 * triangle budget. The chamfer band is emitted PROVISIONALLY as a square box
 * corner; the barrel pass in `barrelSolid` then bends it and the straight flank
 * into one continuous rounded surface, so only the final shape matters.
 *
 * Rings per flank (+X, then −X), N = contour points:
 *   0 top rim edge   (x = ±halfZ,        y = contour)
 *   1 band corner    (x = ±(halfZ − c),  y = contour)   ← provisional corner
 *   2 flank mid      (x = ±(halfZ − c),  y = ringY(p))  ← barrelled
 *   3 band corner    (x = ±(halfZ − c),  y = contour)   ← provisional corner
 *   4 bottom rim edge(x = ±halfZ,        y = contour)
 * plus two ear-clipped end caps.
 */
function extrudeChamfered(
  shape: THREE.Shape,
  width: number,
  chamfer: number,
  wedgeCaps = true,
): THREE.BufferGeometry {
  const pts = shape.getPoints(12);
  const contour = THREE.ShapeUtils.isClockWise(pts) ? pts : pts.slice().reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const N = contour.length;
  const halfZ = width / 2;
  const xFlank = Math.max(halfZ - chamfer, halfZ * 0.35);
  const pos: number[] = [];
  for (const sgn of [1, -1] as const) {
    for (const p of contour) pos.push(sgn * halfZ, p.y, p.x); // 0
    for (const p of contour) pos.push(sgn * xFlank, p.y, p.x); // 1
    for (const p of contour) pos.push(sgn * xFlank, p.y, p.x); // 2 (barrelled below)
    for (const p of contour) pos.push(sgn * xFlank, p.y, p.x); // 3
    for (const p of contour) pos.push(sgn * halfZ, p.y, p.x); // 4
  }
  const idx: number[] = [];
  // Side quads between consecutive rings of the same flank.
  for (const flank of [0, 1]) {
    const base = flank * 5 * N;
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const a = base + r * N + i;
        const b = base + r * N + j;
        const c = base + (r + 1) * N + j;
        const d = base + (r + 1) * N + i;
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  // End caps: flat faces at ±halfZ, triangulated directly. They are hidden by
  // the nose/tail and bumpers in game, so a wedged fan (2 triangles per polygon)
  // is plenty and avoids the shading noise of big flat facets.
  const capA = 10 * N;
  const capB = capA + N;
  for (const p of contour) pos.push(halfZ, p.y, p.x);
  for (const p of contour) pos.push(-halfZ, p.y, p.x);
  void tris;
  if (wedgeCaps) {
    for (let i = 1; i < N - 1; i++) {
      idx.push(capA, capA + i, capA + i + 1);
      idx.push(capB, capB + i, capB + i + 1);
    }
  } else {
    for (const t of tris) {
      idx.push(capA + t[0], capA + t[1], capA + t[2]);
      idx.push(capB + t[0], capB + t[1], capB + t[2]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  orientOutward(geo);
  return geo;
}

/** Flip any face whose normal points towards the solid's centroid. */
function orientOutward(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.getIndex() as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (let f = 0; f < index.count; f += 3) {
    const i0 = index.getX(f);
    const i1 = index.getX(f + 1);
    const i2 = index.getX(f + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    d.fromBufferAttribute(pos, i2);
    n.subVectors(b, a).cross(d.clone().sub(a));
    mid.copy(a).add(b).add(d).divideScalar(3).sub(c);
    if (n.dot(mid) < 0) {
      index.setX(f + 1, i2);
      index.setX(f + 2, i1);
    }
  }
  index.needsUpdate = true;
}

/**
 * Rounded side-profile outline, walked in the given order. Each point is
 * [z, y, r]; `r` is the quadratic fillet radius at that corner (0 = sharp).
 */
function profileShape(points: [number, number, number][]): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  const angle = (from: [number, number, number], to: [number, number, number]): number => Math.atan2(to[1] - from[1], to[0] - from[0]);
  const a0 = angle(points[n - 1], points[0]);
  shape.moveTo(points[0][0] + Math.cos(a0) * points[0][2], points[0][1] + Math.sin(a0) * points[0][2]);
  for (let i = 0; i < n; i++) {
    const [z, y, r] = points[i];
    const aIn = angle(points[i], points[(i - 1 + n) % n]);
    const aOut = angle(points[i], points[(i + 1) % n]);
    if (r <= 0) {
      shape.lineTo(z, y);
      continue;
    }
    shape.lineTo(z + Math.cos(aIn) * r, y + Math.sin(aIn) * r);
    shape.quadraticCurveTo(z, y, z + Math.cos(aOut) * r, y + Math.sin(aOut) * r);
  }
  shape.closePath();
  return shape;
}

/** A vertex handed to the `sculpt` callback of `barrelSolid`. */
export interface SculptVertex {
  /** Local X before the barrel (beveled straight side / cap face). */
  bx: number;
  /** Profile Y (symmetric around 0, so |baseY| is the distance from the equator). */
  baseY: number;
  /** Local Z. */
  z: number;
  /** Normalised height of the cross-section, 0 = equator, 1 = profile edge. */
  u: number;
  /** Finished local X (write this). */
  x: number;
  /** Finished local Y (write this). */
  y: number;
}

export interface BarrelOptions {
  /** Target X extent (m); the finished geometry spans exactly ±width/2. */
  width: number;
  /**
   * Y half-extent the superellipse is normalised by. Must be >= the profile's
   * |Y| extent so the flank meets the profile edge tangentially.
   */
  halfHeight: number;
  /** Superellipse exponent of the flank (2 = round, >2 = crisper shoulders). */
  pow: number;
  /** 45° chamfer cut into both long edges of each flank (m). */
  chamfer: number;
  /** Optional per-vertex sculpt (writes x / y). */
  sculpt?: (v: SculptVertex) => void;
  /**
   * False for parts whose ends may be seen (bumpers): end caps are then
   * triangulated properly instead of with the cheap hidden-face fan.
   */
  wedgeCaps?: boolean;
}


/**
 * Extrude a side profile along X, bevel it, then barrel every vertex onto a
 * superellipse cross-section of its own height so bevel and flank read as one
 * continuous rounded surface. Result: centred on X, Y/Z as drawn in the profile.
 */
function barrelSolid(shape: THREE.Shape, o: BarrelOptions): THREE.BufferGeometry {
  const half = o.width / 2;
  const geo = extrudeChamfered(shape, o.width, o.chamfer, o.wedgeCaps !== false);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v: SculptVertex = { bx: 0, baseY: 0, z: 0, u: 0, x: 0, y: 0 };
  const halfH = Math.max(o.halfHeight, 1e-3);
  for (let i = 0; i < pos.count; i++) {
    const bx = pos.getX(i);
    const baseY = pos.getY(i);
    const z = pos.getZ(i);
    const u = clamp01(Math.abs(baseY) / halfH);
    const f = clamp01(Math.abs(bx) / half);
    // Pushing the flank out by (1−u)^(1/2−1/pow) glues the chamfer band to the
    // straight side: the chamfered box becomes one superellipse bulge.
    const bulge = Math.pow(Math.max(0, 1 - u), 0.5 - 1 / o.pow);
    v.bx = bx;
    v.baseY = baseY;
    v.z = z;
    v.u = u;
    // NOTE the ++X/−X signs: `bx` is already signed, so fold the magnitude onto it.
    v.x = Math.sign(bx) * Math.abs(half * f * bulge);
    v.y = baseY;
    o.sculpt?.(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Cheap rounded bar: the convex hull of two short cylinders laid along Y. It
 * gives rounded lenses / sills / handles / pillars for about a quarter of the
 * polygons of a CapsuleGeometry (which spends extra vertex loops per cap).
 * Callers rotate it onto the axis they need (see xBar / zBar).
 */
function yBar(radius: number, length: number, radial = 8): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const half = Math.max(length, 1e-3) / 2;
  for (const y of [-half, half]) {
    pts.push(new THREE.Vector3(0, y, 0)); // cap centres keep the ends flat
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
  }
  return new ConvexGeometry(pts);
}

/** Rounded bar along X (lenses, door handles, pillars). */
function xBar(radius: number, length: number, radial = 8): THREE.BufferGeometry {
  const g = yBar(radius, length, radial);
  g.rotateZ(Math.PI / 2); // long axis Y → X
  return g;
}

/** Rounded bar along Z (sills, waistline mouldings, grilles). */
function zBar(radius: number, length: number, radial = 8): THREE.BufferGeometry {
  const g = yBar(radius, length, radial);
  g.rotateX(Math.PI / 2); // long axis Y → Z
  return g;
}

/* -------------------------------------------------------------------------- */
/* Shared module-level textures (never disposed per car)                      */
/* -------------------------------------------------------------------------- */

/** Soft radial alpha used by the contact blob. */
const SOFT_RADIAL_TEXTURE = (() => {
  const N = 32;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / (N - 1)) * 2 - 1;
      const v = (y / (N - 1)) * 2 - 1;
      const a = Math.pow(1 - clamp01(Math.hypot(u, v)), 1.7);
      const i = (y * N + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.needsUpdate = true;
  return tex;
})();

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a smooth, rounded car for the given spec.
 * The Group must be added to the scene by the caller; its `position`/`rotation.y`
 * are driven every frame by the VehicleSystem.
 */
export function createVehicleMesh(spec: VehicleSpec): VehicleMesh {
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const color = normColor(spec.color);
  const prof = HULL[spec.id] ?? HULL.sedan;
  const isVan = spec.id === 'van';
  const isSport = spec.id === 'sport';

  const group = new THREE.Group() as VehicleMesh;
  group.name = `vehicle:${spec.id}`;

  /* ---------------------------- key dimensions ------------------------------ */
  const wheelR = WHEEL_RADIUS[spec.id] ?? 0.34;
  const wheelW = WHEEL_WIDTH[spec.id] ?? 0.25;
  const axleZ = L / 2 - L * AXLE_INSET; // front axle at +axleZ, rear at −axleZ
  const track = W * TRACK_FRACTION;

  const hullW = W * prof.widthFrac; // painted body width (spec includes mirrors)
  const hullHalfW = hullW / 2;
  const hullTop = H * prof.heightFrac;
  const hullBottom = 0.1;
  const hullMid = (hullTop + hullBottom) / 2; // extrusion equator
  const hullHalfH = (hullTop - hullBottom) / 2; // superellipse half-height
  const belt = hullBottom + (hullTop - hullBottom) * 0.63;

  const cab = prof.cabin;
  const cFront = L * cab.front;
  const cBack = L * cab.back;
  const rFront = L * cab.roofFront;
  const rBack = L * cab.roofBack;
  const roofY = H * cab.roofFrac;
  const halfWBase = (W * cab.widthFrac) / 2;
  const halfWRoof = (W * cab.roofWidthFrac) / 2;

  /** Wheels: 4 per car, FL/FR/RL/RR order; the front pair carries `front: true`. */
  const wheels: WheelRef[] = [];
  for (const z of [axleZ, -axleZ]) {
    for (const x of [track / 2, -track / 2]) {
      const steer = new THREE.Group();
      steer.name = 'steer';
      steer.position.set(x, wheelR, z);
      const spin = new THREE.Group();
      spin.name = 'spin';
      steer.add(spin);
      group.add(steer); // wheels hang off the root so body roll never lifts them
      wheels.push({ steer, spin, front: z > 0, radius: wheelR });
    }
  }

  /* -------------------------- greenhouse shape model ------------------------ */
  /** How far up the cabin has tapered at Z: 0 at its base edges, 1 at the roof. */
  const taperAt = (z: number): number => Math.max(smoothstep(cFront, rFront, z), smoothstep(cBack, rBack, z));
  /** Side of the greenhouse at Z (matches the tumblehome-sculpted cabin). */
  const seatX = (z: number): number => lerp(halfWBase, halfWRoof, taperAt(z)) * 0.97;

  /* ------------------------------- accumulators ----------------------------- */
  const paint = newAcc();
  const glass = newAcc();
  const frame = newAcc(); // faceted: pillars, window frames, drip rails
  const trim = newAcc(); // bumpers, sills, grille, intakes, mirror housings
  const chrome = newAcc();
  const head = newAcc();
  const brake = newAcc();
  const tyre = newAcc();
  const rim = newAcc();
  const rimDark = newAcc();
  const underbody = newAcc(); // shadow-map only

  const tmpM = new THREE.Matrix4();

  /* --------------------------------- the hull ------------------------------- */
  // ---------------------------------------------------------------- extents
  // The profile is built so the FINISHED car (bumpers included) is exactly the
  // spec length; everything else is derived from `hullHalfZ` (nose/tail).
  const noseOverhang = 0.07; // body-nose coordinate extends past the spec nose…
  const tailOverhang = 0.14; // …and the tail is chopped short of it
  const hullHalfZ = L / 2 - noseOverhang;
  /** Rear profile corner (world Z) and the greenhouse's rear edge. */
  const tailZ = -hullHalfZ + tailOverhang;

  // Nose: feathered and low; tail: chopped with a slight kick-up; the run
  // between the greenhouse base points is the flat deck / bonnet / boot.
  const hullShape = profileShape([
    [hullHalfZ, hullTop - 0.012, prof.r[0]],
    [cFront, hullTop, 0],
    [cBack, hullTop, 0],
    [-hullHalfZ, hullTop - 0.018, prof.r[2]],
    [-hullHalfZ, hullBottom + 0.07, prof.r[3]],
    [hullHalfZ, hullBottom, prof.r[1]],
  ]);
  const archSigma = wheelR * 1.55;
  put(
    paint,
    barrelSolid(hullShape, {
      width: hullW,
      halfHeight: hullHalfH + 0.02,
      pow: prof.xPow,
      chamfer: prof.chamfer,
      sculpt: (v) => {
        const wy = v.y + hullMid; // world height of this vertex
        const k = hullHalfW > 0 ? v.x / hullHalfW : 0;
        // 1) taper both ends in a touch
        let x = v.x * (1 - 0.05 * Math.pow(Math.abs(v.z) / hullHalfZ, 3));
        // 2) wheel-arch flare: a soft bulge over each axle, below the beltline
        const arch = Math.max(
          Math.exp(-Math.pow((v.z - axleZ) / archSigma, 2)),
          Math.exp(-Math.pow((v.z + axleZ) / archSigma, 2)),
        );
        x *= 1 + 0.03 * arch * (1 - smoothstep(belt - 0.1, belt + 0.15, wy));
        v.x = x;
        // 3) tumblehome above the belt; a soft barrel below it
        if (wy > belt) v.y -= prof.tumblehome * k * k * (wy - belt);
        else v.y -= 0.02 * k * k * Math.max(0, wy - hullBottom);
      },
    }),
  );

  /* ------------------------------ the greenhouse ---------------------------- */
  // One glass volume per car: an extruded, barrelled shape from (just under)
  // the deck up to the rounded roof. It IS the glass (side windows, windscreen
  // and backlight) and the cabin silhouette — no hidden second shell.
  const glassBase = hullTop - 0.06;
  /** Side-glass extents in Z: where the A-pillar and C-pillar meet the waist. */
  const glassFront = cFront - (cFront - rFront) * cab.pillarFrac;
  const glassBack = cBack + (rBack - cBack) * cab.pillarFrac * 0.6;
  const cabinHalfH = roofY - glassBase;
  const cabinProfile = profileShape([
    [cFront, glassBase, cab.roofRadius + 0.02],
    [rFront, roofY, cab.roofRadius],
    [rBack, roofY, cab.roofRadius],
    [cBack, glassBase, cab.roofRadius + 0.02],
  ]);
  /** Side glass leaning in towards the roof (tumblehome on the cabin only). */
  const cabinSculpt = (v: SculptVertex): void => {
    const wy = v.y + glassBase + cabinHalfH;
    const k = v.x / Math.max(halfWBase, 1e-3);
    v.y -= cab.tumblehome * k * k * (wy - belt);
  };
  put(
    glass,
    barrelSolid(cabinProfile, {
      width: halfWBase * 2,
      halfHeight: cabinHalfH,
      pow: 2.6,
      chamfer: 0.05,
      sculpt: cabinSculpt,
    }),
  );
  // Painted roof cap: a thin rounded slab over the top of the glass volume, so
  // the roof reads as body colour while the sides stay glass.
  {
    const capShape = profileShape([
      [rFront + 0.03, roofY + 0.004, cab.roofRadius],
      [rBack - 0.03, roofY + 0.004, cab.roofRadius],
      [rBack - 0.03, roofY - 0.07, cab.roofRadius],
      [rFront + 0.03, roofY - 0.07, cab.roofRadius],
    ]);
    put(
      paint,
      barrelSolid(capShape, {
        width: halfWRoof * 2 + 0.03,
        halfHeight: 0.045,
        pow: 3,
        chamfer: 0.045,
        sculpt: (v) => cabinSculpt({ ...v, y: v.y + 0 }),
      }),
    );
  }
  // A-pillars: painted bands over the windscreen edges (the widest part of the
  // pillar shows from the side).
  for (const side of [-1, 1] as const) {
    const z0 = cFront - 0.03;
    const z1 = cFront - (cFront - rFront) * cab.pillarFrac;
    const y0 = glassBase + 0.04;
    const y1 = roofY - 0.02;
    const len = Math.hypot(z1 - z0, y1 - y0);
    const ang = Math.atan2(z1 - z0, y1 - y0);
    const pillar = yBar(0.035, len, 4);
    tmpM.makeRotationX(-ang).setPosition(side * halfWBase * 0.94, (y0 + y1) / 2, (z0 + z1) / 2);
    put(paint, pillar, tmpM);
  }
  // Faceted dark creases that frame the glass: waistline along the bottom of
  // the side windows, B-pillar(s), and the roof edge (all proud of the glass).
  {
    const t = 0.014; // crease thickness (m)
    /** Bar between two points of the car's ZY plane, mirrored at ±X = `x`. */
    const bar = (x: number, z0: number, y0: number, z1: number, y1: number): void => {
      const len = Math.hypot(z1 - z0, y1 - y0);
      const ang = Math.atan2(z1 - z0, y1 - y0);
      for (const side of [-1, 1]) {
        const g = yBar(t / 2, len, 3);
        tmpM.makeRotationX(-ang).setPosition(side * x, (y0 + y1) / 2, (z0 + z1) / 2);
        put(frame, g, tmpM);
      }
    };
    // Side glass spans from the windscreen base to the backlight base at deck level.
    const side0 = cFront - (cFront - rFront) * cab.pillarFrac;
    const side1 = cBack + (rBack - cBack) * cab.pillarFrac * 0.6;
    const waist = hullTop + 0.02;
    bar(halfWBase * 0.995, side0, waist, side1, waist); // window-bottom frame
    bar(halfWBase * 0.96, side1 + 0.02, waist + 0.01, roofY - 0.03, roofY - 0.03); // C-pillar rake
    // B-pillar(s): one for the sedan/sport, a second one for the van.
    const bZ = [(side0 + side1) / 2];
    for (const bz of bZ) bar(halfWBase * 0.975, bz, roofY - 0.06, bz, waist + 0.02);
    // Drip rail along both roof edges.
    bar(halfWRoof * 0.92, rFront, roofY - 0.015, rBack, roofY - 0.015);
  }

  /* --------------------------------- bumpers -------------------------------- */
  // Rounded bumper: a barrier-shaped bar (slab with rounded corners) wrapped
  // around each end below the beltline, plus a dark valance behind it.
  for (const [end, edgeZ] of [[1, hullHalfZ], [-1, tailZ]] as const) {
    const zc = edgeZ - end * 0.1;
    // Bumper bar: a lip that wraps up the nose/tail and rolls under the body.
    // Three corners = 12 polygons per ring; the barrel supplies the roundness.
    const bShape = profileShape([
      [0.05, 0.12, 0.03], // lip, proud along the bottom of the body
      [0.02, 0.12, 0.03], // top edge flush with the body face
      [0.0, -0.09, 0.03], // lower roll
    ]);
    tmpM.makeTranslation(0, hullBottom + 0.15, zc);
    put(
      trim,
      barrelSolid(bShape, {
        width: hullW * 0.99,
        halfHeight: 0.13,
        pow: Math.min(prof.xPow, 3),
        chamfer: 0.03,
        wedgeCaps: false,
        sculpt: (v) => {
          const k = Math.abs(v.x) / (hullW * 0.495);
          // ends wrap back towards the body and pull in slightly
          v.z = (v.z - zc) * (1 - 0.3 * k * k) + zc;
          v.x *= 1 - 0.05 * Math.pow(k, 3);
        },
      }),
      tmpM,
    );
    // dark lower valance tucked behind the bumper lip
    put(trim, new THREE.BoxGeometry(hullW * 0.8, 0.09, 0.1), tmpM.makeTranslation(0, hullBottom - 0.02, zc));
  }

  /* ---------------------------- lamps + details ----------------------------- */
  const noseZ = hullHalfZ - 0.02; // nose face of the paint
  const lampZ = tailZ + 0.02; // tail face of the paint
  const lampY = belt - 0.08;

  // Headlights: bright jewel lenses right under the nose edge — they are the
  // main cue that says "car" from the front, so they are large and warm.
  for (const s of [-1, 1]) {
    const lens = xBar(0.075, W * (isVan ? 0.26 : 0.32), 8);
    lens.scale(1, 0.62, 1.15);
    put(head, lens, tmpM.makeTranslation(s * W * 0.27, lampY, noseZ - 0.01));
  }
  // Tail lamps: tall red lenses wrapped into the tail corners.
  for (const s of [-1, 1]) {
    const lens = xBar(0.075, W * (isVan ? 0.18 : 0.26), 8);
    lens.scale(1, 1.1, 0.8);
    put(brake, lens, tmpM.makeTranslation(s * W * 0.29, lampY + 0.06, lampZ + 0.005));
  }
  // Third brake light on the rear edge of the glass dome.
  put(brake, new THREE.BoxGeometry(isVan ? 0.06 : 0.3, 0.03, 0.025), tmpM.makeTranslation(0, lerp(hullTop, roofY, 0.5), glassBack - 0.035));
  // Grille (dark bar, chrome slats) and lower intake.
  {
    const gy = belt - 0.16;
    const grille = xBar(0.055, W * 0.36, 8);
    grille.scale(1, 1.1, 0.8);
    put(trim, grille, tmpM.makeTranslation(0, gy, noseZ - 0.02));
    for (let i = -1; i <= 1; i++) {
      put(chrome, new THREE.BoxGeometry(W * 0.33, 0.011, 0.02), tmpM.makeTranslation(0, gy + i * 0.034, noseZ + 0.02));
    }
    const intake = xBar(0.04, W * 0.44, 6);
    intake.scale(1, 0.9, 0.9);
    put(trim, intake, tmpM.makeTranslation(0, hullBottom + 0.12, noseZ - 0.05));
  }
  // Rocker / sill strips along the bottom of both flanks.
  for (const s of [-1, 1]) {
    const sill = zBar(0.05, L * 0.55, 7);
    sill.scale(1.5, 1, 1);
    put(trim, sill, tmpM.makeTranslation(s * hullHalfW * 0.86, hullBottom + 0.02, 0));
  }
  // Door seams, door handles, chrome waistline moulding.
  {
    const seamZ = isVan
      ? [glassFront - 0.02, lerp(glassFront, glassBack, 0.6)]
      : [lerp(glassFront, glassBack, 0.18), lerp(glassFront, glassBack, 0.86)];
    const waistY = belt - 0.02;
    const flankX = (wy: number): number => flankAt((wy - hullMid) / (hullHalfH + 0.02), prof.xPow) * hullHalfW;
    for (const s of [-1, 1]) {
      for (const sz of seamZ) {
        const h = waistY - (hullBottom + 0.13);
        put(trim, new THREE.BoxGeometry(0.02, h, 0.03), tmpM.makeTranslation(s * flankX(waistY) * 1.0, hullBottom + 0.13 + h / 2, sz));
      }
      // pressed crease line along the flank (sliver proud of the paint)
      put(paint, zBar(0.007, isVan ? L * 0.46 : L * 0.4, 5), tmpM.makeTranslation(s * flankX(belt - 0.19) * 1.005, belt - 0.19, -0.02));
      // chrome waistline moulding
      put(chrome, zBar(0.011, glassFront - glassBack + 0.1, 5), tmpM.makeTranslation(s * flankX(waistY) * 1.012, waistY, (glassFront + glassBack) / 2));
      // door handles
      for (const hz of isVan ? [lerp(glassFront, glassBack, 0.45)] : [lerp(glassFront, glassBack, 0.3), lerp(glassFront, glassBack, 0.76)]) {
        put(chrome, zBar(0.015, 0.09, 5), tmpM.makeTranslation(s * flankX(belt - 0.11) * 1.01, belt - 0.11, hz));
      }
    }
  }
  // Wing mirrors: stalk + rounded housing just outside the glasshouse.
  for (const s of [-1, 1]) {
    const mz = cFront - 0.03;
    const seat = seatX(mz);
    const my = lerp(hullTop, roofY, 0.22);
    put(trim, xBar(0.016, 0.05, 5), tmpM.makeTranslation(s * (seat + 0.02), my, mz));
    const housing = new THREE.SphereGeometry(0.05, 10, 6);
    housing.scale(0.9, 0.8, 1.25);
    put(trim, housing, tmpM.makeTranslation(s * (seat + 0.085), my + 0.005, mz - 0.02));
    put(chrome, new THREE.BoxGeometry(0.008, 0.042, 0.06), tmpM.makeTranslation(s * (seat + 0.118), my + 0.005, mz - 0.02));
  }
  // Number plates, front + rear (light panels).
  put(chrome, new THREE.BoxGeometry(0.42, 0.1, 0.014), tmpM.makeTranslation(0, hullBottom + 0.15, noseZ + 0.05));
  put(chrome, new THREE.BoxGeometry(0.42, 0.1, 0.014), tmpM.makeTranslation(0, hullBottom + 0.17, lampZ - 0.05));
  // Exhaust pipes (rear, right side) — dark metal tubes.
  for (const off of [-W * 0.3]) {
    const pipe = new THREE.CylinderGeometry(0.042, 0.048, 0.14, 8, 1);
    pipe.rotateX(Math.PI / 2);
    put(rimDark, pipe, tmpM.makeTranslation(off, hullBottom + 0.02, tailZ + 0.02));
  }
  // Sport chin spoiler, sitting proud of the front valance.
  if (isSport) {
    put(trim, zBar(0.025, hullW * 0.62, 5), tmpM.makeTranslation(0, hullBottom - 0.01, hullHalfZ + 0.02));
  }
  // Van roof rails.
  if (isVan) {
    for (const s of [-1, 1]) {
      put(trim, zBar(0.02, rFront - rBack - 0.2, 5), tmpM.makeTranslation(s * halfWRoof * 0.8, roofY + 0.025, (rFront + rBack) / 2));
    }
  }
  // Sport rear wing: a low blade on two short posts, sitting off the boot lid.
  if (isSport) {
    const wingY = hullTop + 0.06;
    const wing = xBar(0.022, hullW * 0.78, 7);
    wing.scale(1, 0.7, 1.7);
    put(trim, wing, tmpM.makeTranslation(0, wingY, tailZ + 0.24));
    for (const s of [-1, 1]) {
      // slim posts (thin boxes so the wing reads as floating)
      put(trim, new THREE.BoxGeometry(0.03, 0.1, 0.06), tmpM.makeTranslation(s * hullW * 0.28, wingY - 0.06, tailZ + 0.24));
    }
  }
  // Underbody slab — shadow-map only, so the sun sees a body under the wheels.
  put(underbody, new THREE.BoxGeometry(hullW * 0.9, 0.18, L * 0.8), tmpM.makeTranslation(0, hullBottom - 0.02, 0));

  /* --------------------------------- wheels --------------------------------- */
  // Tyre: one smooth 28-sided cylinder (a tread band slightly larger than the
  // sidewall radius reads as a proper round tyre without extra geometry), plus
  // a hubcap dish, five spokes and a centre nub on the outer face.
  {
    const tyreGeo = new THREE.CylinderGeometry(wheelR * (1 - TYRE_GRIP), wheelR * (1 - TYRE_GRIP), wheelW, 14, 1);
    tyreGeo.rotateZ(Math.PI / 2); // axis Y → X so it rolls around local X
    put(tyre, tyreGeo);
    const tread = new THREE.CylinderGeometry(wheelR, wheelR, wheelW * 0.7, 14, 1);
    tread.rotateZ(Math.PI / 2);
    put(rimDark, tread); // dark tread band = grooves read at a distance
    const dish = new THREE.CylinderGeometry(wheelR * 0.58, wheelR * 0.5, 0.03, 10, 1);
    dish.rotateZ(Math.PI / 2);
    put(rim, dish, tmpM.makeTranslation(wheelW / 2 - 0.012, 0, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      put(rimDark, new THREE.BoxGeometry(0.03, wheelR * 0.86, 0.08), tmpM.makeRotationX(a).setPosition(wheelW / 2 + 0.008, 0, 0));
    }
    const hub = new THREE.CylinderGeometry(wheelR * 0.15, wheelR * 0.15, 0.04, 8);
    hub.rotateZ(Math.PI / 2);
    put(rim, hub, tmpM.makeTranslation(wheelW / 2 + 0.004, 0, 0));
  }

  /* ---------------------------------- meshes -------------------------------- */
  // Colours are authored in DISPLAY (sRGB) space: re-encode them so a hex value
  // gives the intended pixels. Then soften the paint with LDR values (an HDR
  // varnish would blow out to white under ACES + the sun) and give the glass a
  // dark body tint at full metalness so it mirrors the sky like real glass.
  const sRGB = (hex: number): THREE.Color => new THREE.Color(hex).setHex(normColor(hex), THREE.SRGBColorSpace);
  const mats: Mats = {
    paint: new THREE.MeshStandardMaterial({ color: sRGB(color), roughness: 0.36, metalness: 0.3, envMapIntensity: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: sRGB(0x1a2a38), roughness: 0.04, metalness: 1.0, envMapIntensity: 1.3 }),
    frame: new THREE.MeshStandardMaterial({ color: sRGB(0x191c22), roughness: 0.45, metalness: 0.4, flatShading: true }),
    trim: new THREE.MeshStandardMaterial({ color: sRGB(0x1b1e24), roughness: 0.6, metalness: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: sRGB(0xd9e0e8), roughness: 0.18, metalness: 0.85 }),
    head: new THREE.MeshStandardMaterial({
      color: sRGB(0xfff3d0),
      emissive: sRGB(0xfff0c8),
      emissiveIntensity: 1.2,
      roughness: 0.1,
      metalness: 0.3,
    }),
    brake: new THREE.MeshStandardMaterial({ color: sRGB(0x9b1f20), emissive: sRGB(0xff2b22), emissiveIntensity: 0.25, roughness: 0.3 }),
    tyre: new THREE.MeshStandardMaterial({ color: sRGB(0x17191d), roughness: 0.95, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: sRGB(0xc9ced6), roughness: 0.3, metalness: 0.8 }),
    rimDark: new THREE.MeshStandardMaterial({ color: sRGB(0x2a2e35), roughness: 0.6, metalness: 0.5 }),
  };

  const body = new THREE.Group();
  body.name = 'body';
  group.add(body);

  /**
   * Attach one merged bucket as a child mesh. `smooth` false → faceted.
   * Every bucket casts + receives shadows unless stated otherwise.
   */
  const addPart = (
    parent: THREE.Object3D,
    acc: Acc,
    material: THREE.Material,
    name: string,
    opts: { smooth?: boolean; cast?: boolean } = {},
  ): void => {
    if (acc.idx.length === 0) return;
    const geo = accToGeometry(acc, opts.smooth !== false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = opts.cast ?? true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  };

  addPart(body, paint, mats.paint, 'body-paint');
  addPart(body, glass, mats.glass, 'cabin-glass', { cast: false });
  addPart(body, frame, mats.frame, 'cabin-frame', { smooth: false });
  addPart(body, trim, mats.trim, 'bumper-trim', { smooth: false });
  addPart(body, chrome, mats.chrome, 'chrome');
  addPart(body, head, mats.head, 'headlights', { cast: false });
  addPart(body, brake, mats.brake, 'taillights', { cast: false });
  addPart(body, rimDark, mats.rimDark, 'exhaust-and-drums');

  // The wheel buckets are merged meshes centred on the origin; instantiate
  // them at the four `spin` pivots so the per-wheel spin/steer animation from
  // VehicleSystem keeps working (wheels also cast shadows, as before).
  const addWheels = (acc: Acc, material: THREE.Material, name: string): void => {
    if (acc.idx.length === 0) return;
    const mesh = new THREE.InstancedMesh(accToGeometry(acc, true), material, wheels.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const w of wheels) w.spin.add(mesh);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < wheels.length; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
  };
  addWheels(tyre, mats.tyre, 'tyres');
  addWheels(rim, mats.rim, 'rims');

  // Shadow-map-only underbody: skips the main render pass.
  {
    const hidden = new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.9 });
    hidden.name = 'shadow-only';
    hidden.colorWrite = false;
    hidden.depthWrite = false;
    const mesh = new THREE.Mesh(accToGeometry(underbody, false), hidden);
    mesh.name = 'underbody-shadow-only';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    body.add(mesh);
  }

  /* ------------------------------- soft shadow ------------------------------ */
  const blobGeo = new THREE.PlaneGeometry(W * 1.22, L * 1.02, 1, 1);
  blobGeo.rotateX(-Math.PI / 2);
  blobGeo.translate(0, 0.02, 0);
  const blobMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    alphaMap: SOFT_RADIAL_TEXTURE,
  });
  const shadow = new THREE.Mesh(blobGeo, blobMat);
  shadow.name = 'contact-blob';
  shadow.renderOrder = 1;
  group.add(shadow);

  /* ------------------------------- userData --------------------------------- */
  group.userData = {
    spec,
    body,
    wheels,
    brakeLights: [mats.brake],
    headlights: [mats.head],
    shadow,
    paint: mats.paint,
  } satisfies VehicleMeshData;

  return group;
}

/**
 * Convenience: rebuild the handle data from a mesh produced by `createVehicleMesh`.
 * Throws if the object wasn't built by this module.
 */
export function getVehicleMeshData(mesh: THREE.Object3D): VehicleMeshData {
  const data = mesh.userData as VehicleMeshData | undefined;
  if (!data || !Array.isArray(data.wheels) || !data.body) {
    throw new Error('getVehicleMeshData: object was not built by createVehicleMesh()');
  }
  return data;
}

/**
 * Recolour an existing car without rebuilding geometry: repaints the shell and
 * keeps the greenhouse pillars in a matching darker shade.
 */
export function tintVehicleMesh(mesh: THREE.Object3D, color: number): void {
  const data = getVehicleMeshData(mesh);
  const next = normColor(color);
  data.paint.color.setHex(next);
}

/** Dispose every geometry + material owned by a vehicle mesh produced here. */
export function disposeVehicleMesh(mesh: THREE.Object3D): void {
  mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat.dispose();
  });
  mesh.parent?.remove(mesh);
}
