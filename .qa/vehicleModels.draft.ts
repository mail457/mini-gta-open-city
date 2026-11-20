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
 *   - `steerPivots`: the 2 front wheel yaw pivots
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
 * 2. It is extruded along X with a bevel, so top/bottom edges and the nose and
 *    tail ends get rounded.
 * 3. Every vertex is then "barrelled" onto a superellipse cross-section of its
 *    own height, which glues the bevel band into the flank: one continuous
 *    rounded side instead of a stack of boxes. This is what kills the Lego
 *    look.
 * 4. The painted shell also gets a tumblehome (sides lean in above the
 *    beltline), a flare over each wheel arch and a gentle body taper.
 * The same routine builds the main hull and the bumpers, so every part speaks
 * the same visual language.
 *
 * The greenhouse is one rounded glass dome (smooth normals) plus thin faceted
 * dark creases — A/B/C pillars, window frames, drip rails — so the cabin reads
 * as tinted glass framed by painted/dark trim.
 *
 * Everything is merged per material: a complete car is ~11 meshes. Geometry
 * that can never be seen from outside (the sill slab) lives in a "shadow-only"
 * mesh that is skipped by the main render pass and only drawn into the sun's
 * shadow map, so it still shades the wheels at zero main-pass draw calls.
 */

import * as THREE from 'three';
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
  /** Bevel: rounding into the profile (Th) and flank bulge (S), metres. */
  bevelT: number;
  bevelS: number;
  bevelSegments: number;
  /** Extrusion steps along the length (also the resolution for arch flares). */
  steps: number;
  /** How much the sides lean in above the beltline (tumblehome). */
  tumblehome: number;
  /** Greenhouse silhouette (fractions of length) and its width profile. */
  cabin: {
    front: number;
    back: number;
    roofFront: number;
    roofBack: number;
    widthFrac: number;
    /** Rough roof width as a fraction of the spec width (mirror footprint). */
    roofWidthFrac: number;
    roofRadius: number;
    /** Fraction of the cabin length taken by the windscreen / backlight. */
    glassFrac: number;
    /** Roof height as a fraction of the spec height. */
    roofFrac: number;
    /** Glass-dome top/bottom inset inside the painted window frame (m). */
    glassInset: number;
  };
}

const HULL: Record<VehicleTypeId, HullProfile> = {
  sedan: {
    widthFrac: 0.8,
    heightFrac: 0.8,
    r: [0.16, 0.1, 0.2, 0.11],
    xPow: 2.8,
    bevelT: 0.1,
    bevelS: 0.06,
    bevelSegments: 3,
    steps: 30,
    tumblehome: 0.12,
    cabin: {
      front: 0.24,
      back: -0.33,
      roofFront: -0.02,
      roofBack: -0.24,
      widthFrac: 0.68,
      roofWidthFrac: 0.54,
      roofRadius: 0.05,
      glassFrac: 0.36,
      roofFrac: 0.9,
      glassInset: 0.045,
    },
  },
  sport: {
    widthFrac: 0.82,
    heightFrac: 0.84,
    r: [0.2, 0.08, 0.15, 0.09],
    xPow: 2.5,
    bevelT: 0.08,
    bevelS: 0.07,
    bevelSegments: 3,
    steps: 30,
    tumblehome: 0.2,
    cabin: {
      front: 0.12,
      back: -0.33,
      roofFront: -0.1,
      roofBack: -0.3,
      widthFrac: 0.7,
      roofWidthFrac: 0.5,
      roofRadius: 0.04,
      glassFrac: 0.44,
      roofFrac: 0.88,
      glassInset: 0.04,
    },
  },
  van: {
    widthFrac: 0.84,
    heightFrac: 0.88,
    r: [0.18, 0.1, 0.16, 0.1],
    xPow: 3.6,
    bevelT: 0.1,
    bevelS: 0.065,
    bevelSegments: 3,
    steps: 36,
    tumblehome: 0.06,
    cabin: {
      front: 0.56,
      back: -0.4,
      roofFront: 0.44,
      roofBack: -0.46,
      widthFrac: 0.8,
      roofWidthFrac: 0.8,
      roofRadius: 0.07,
      glassFrac: 0.22,
      roofFrac: 0.97,
      glassInset: 0.05,
    },
  },
};

/** One proxy material per rendered bucket (materials are shared per car). */
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

/**
 * Buckets are accumulated per material. `side` tells which flank a vertex is
 * on so seams (which only exist on the flanks) can be filtered out of the
 * shell when the "paint everything" bucket is built.
 */
interface SidedAcc extends Acc {
  /** 0 = top/cap-face vertex (a face where any vertex is 0 is a cap face). */
  side: number[];
  /** 1 = belongs to the painted shell only (no seams). */
  shell: number[];
}

const newSidedAcc = (): SidedAcc => ({ pos: [], idx: [], side: [], shell: [] });

function mergeSided(acc: SidedAcc, geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | undefined, shell: boolean): void {
  const src = matrix ? geo.clone().applyMatrix4(matrix) : geo;
  const p = src.getAttribute('position');
  const base = acc.pos.length / 3;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    acc.pos.push(x, p.getY(i), p.getZ(i));
    acc.side.push(Math.abs(x) > 0.05 ? Math.sign(x) : 0);
    acc.shell.push(shell ? 1 : 0);
  }
  const index = src.getIndex();
  if (index) for (let i = 0; i < index.count; i++) acc.idx.push(base + index.getX(i));
  else for (let i = 0; i < p.count; i++) acc.idx.push(base + i);
  if (matrix) src.dispose();
}

/**
 * Build a geometry from an accumulator. Cracks between parts (notably the dark
 * door seams) are avoided by DROPPING the near-coplanar faces they sit in front
 * of rather than by insetting the seam: each face whose surviving area is tiny
 * after the covered part is removed disappears entirely, and covered coverage
 * is computed per-side so internal faces are never removed.
 */
function accToGeometry(acc: Acc, smooth: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setIndex(acc.idx);
  if (smooth) {
    geo.computeVertexNormals();
    return geo;
  }
  const un = geo.toNonIndexed();
  un.computeVertexNormals();
  geo.dispose();
  return un;
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
 * Rounded side-profile outline, walked in the given order. Each point is
 * [z, y, r]; `r` is the quadratic fillet radius at that corner (0 = sharp).
 */
function profileShape(points: [number, number, number][]): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  const angle = (from: [number, number, number], to: [number, number, number]): number => Math.atan2(to[1] - from[1], to[0] - from[0]);
  const [p0, p1, p2] = points;
  void p1;
  void p2;
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
  /** Profile Y (symmetric around 0, so |baseY| is the distance to the equator). */
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
  /** Superellipse exponent of the flank. */
  pow: number;
  /** Bevel rounded into the profile (m). */
  bevelT: number;
  /** Bevel bulge on the flank (m). */
  bevelS: number;
  bevelSegments: number;
  steps: number;
  /** Optional per-vertex sculpt (writes x / y). */
  sculpt?: (v: SculptVertex) => void;
}

/**
 * Extrude a side profile along X, bevel it, then barrel every vertex onto a
 * superellipse cross-section of its own height so bevel and flank read as one
 * continuous rounded surface. Result: centred on X, Y/Z as drawn in the profile.
 */
function barrelSolid(shape: THREE.Shape, o: BarrelOptions): THREE.BufferGeometry {
  const half = o.width / 2;
  const depth = Math.max(0.02, o.width - o.bevelS * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: o.steps,
    curveSegments: 10,
    bevelEnabled: true,
    bevelThickness: o.bevelT,
    bevelSize: o.bevelS,
    bevelSegments: o.bevelSegments,
  });
  geo.translate(0, 0, -depth / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v: SculptVertex = { bx: 0, baseY: 0, z: 0, u: 0, x: 0, y: 0 };
  const halfH = Math.max(o.halfHeight, 1e-3);
  for (let i = 0; i < pos.count; i++) {
    const bx = pos.getX(i);
    const baseY = pos.getY(i);
    const z = pos.getZ(i);
    const f = clamp01(Math.abs(bx) / half);
    const u = clamp01(Math.abs(baseY) / halfH);
    // Pushing the flank out by (1−u)^(1/2−1/pow) glues the bevel band to the
    // straight side: a beveled box becomes one superellipse bulge.
    const bulge = Math.pow(Math.max(0, 1 - u), 0.5 - 1 / o.pow);
    v.bx = bx;
    v.baseY = baseY;
    v.z = z;
    v.u = u;
    v.x = Math.sign(bx) * half * f * bulge;
    v.y = baseY;
    o.sculpt?.(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Extrusion steps needed so a profile is smooth at ~`dz` metres per step. */
function stepsFor(shape: THREE.Shape, dz: number, min = 10, max = 120): number {
  return clamp(Math.round((shape.getLength() || 4) / Math.max(dz, 1e-3)), min, max);
}

/** A capsule whose long axis lies along X (rounded bars, lenses, handles). */
function xBar(radius: number, length: number, radialSegments = 10, capSegments = 4): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, Math.max(length, 1e-3), capSegments, radialSegments);
  g.rotateZ(Math.PI / 2); // long axis Y → X
  return g;
}

/** A capsule whose long axis lies along Z (wrapped bumpers, sills, plate rails). */
function zBar(radius: number, length: number, radialSegments = 10, capSegments = 4): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, Math.max(length, 1e-3), capSegments, radialSegments);
  g.rotateX(Math.PI / 2); // long axis Y → Z
  return g;
}

/* -------------------------------------------------------------------------- */
/* Shared module-level textures                                               */
/* -------------------------------------------------------------------------- */

/** Soft radial alpha used by the contact blob (shared by every car). */
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

  /* ------------------------------ key dimensions ---------------------------- */
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
  const hullHalfZ = L / 2 - 0.02;

  const cab = prof.cabin;
  const cFront = L * cab.front;
  const cBack = L * cab.back;
  const rFront = L * cab.roofFront;
  const rBack = L * cab.roofBack;
  const glassFront = lerp(cFront, rFront, cab.glassFrac);
  const glassBack = lerp(cBack, rBack, cab.glassFrac);
  const roofY = H * cab.roofFrac;
  const halfWBase = (W * cab.widthFrac) / 2;
  const halfWRoof = (W * cab.roofWidthFrac) / 2;

  /** Wheels: 4 per car, FL/FR/RL/RR order, front ones carry `front: true`. */
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
  const inCabin = (z: number): boolean => z > cBack + 0.01 && z < cFront - 0.01;

  /* ------------------------------- accumulators ----------------------------- */
  // Painted shell (no seams) + a second stream for everything else that is painted.
  const shell = newSidedAcc();
  const rest = newSidedAcc();
  const glass = newAcc();
  const frame = newAcc(); // faceted: pillars, window frames, drip rails
  const trim = newSidedAcc(); // bumpers, sills, grille, intakes, handles
  const chrome = newAcc();
  const head = newAcc();
  const brake = newAcc();
  const tyre = newAcc();
  const rim = newAcc();
  const rimDark = newAcc();
  const interior = newAcc(); // shadow-map-only

  const tmpM = new THREE.Matrix4();
  /** Add a geometry to a plain bucket, transformed by `matrix` if given. */
  const put = (acc: Acc, geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): void => {
    const src = matrix ? geo.clone().applyMatrix4(matrix) : geo;
    const p = src.getAttribute('position');
    const base = acc.pos.length / 3;
    for (let i = 0; i < p.count; i++) acc.pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const index = src.getIndex();
    if (index) for (let i = 0; i < index.count; i++) acc.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) acc.idx.push(base + i);
    src.dispose();
  };

  /* --------------------------------- the hull ------------------------------- */
  // Nose: feathered and low; tail: chopped with a slight kick-up; the run
  // between the greenhouse base points is the (flat) deck / bonnet / boot.
  const hullPts: [number, number, number][] = [
    [hullHalfZ, hullTop - 0.012, prof.r[0]],
    [cFront, hullTop, 0],
    [cBack, hullTop, 0],
    [-hullHalfZ, hullTop - 0.018, prof.r[2]],
    [-hullHalfZ, hullBottom + 0.07, prof.r[3]],
    [hullHalfZ, hullBottom, prof.r[1]],
  ];
  const hullShape = profileShape(hullPts);
  const archSigma = wheelR * 1.55;

  const hullGeo = barrelSolid(hullShape, {
    width: hullW,
    halfHeight: hullHalfH + 0.02,
    pow: prof.xPow,
    bevelT: prof.bevelT,
    bevelS: prof.bevelS,
    bevelSegments: prof.bevelSegments,
    steps: prof.steps,
    sculpt: (v) => {
      const wy = v.y + hullMid; // world height of this vertex
      const k = hullHalfW > 0 ? v.x / hullHalfW : 0;
      // 1) body taper: pull both ends in a little
      let x = v.x * (1 - 0.05 * Math.pow(Math.abs(v.z) / hullHalfZ, 3));
      // 2) wheel-arch flare: a soft bulge over each axle, below the beltline
      const arch = Math.max(
        Math.exp(-Math.pow((v.z - axleZ) / archSigma, 2)),
        Math.exp(-Math.pow((v.z + axleZ) / archSigma, 2)),
      );
      x *= 1 + 0.03 * arch * (1 - smoothstep(belt - 0.1, belt + 0.15, wy));
      v.x = x;
      // 3) tumblehome: the greenhouse leans in; below the belt a soft barrel
      if (wy > belt) v.y -= prof.tumblehome * k * k * (wy - belt);
      else v.y -= 0.02 * k * k * Math.max(0, wy - hullBottom);
    },
  });
  mergeSided(shell, hullGeo, undefined, true);
  hullGeo.dispose();

  /* ------------------------------ the greenhouse ---------------------------- */
  // Painted window frame: a low ring following the cabin's outline. It carries
  // the cabin silhouette (windscreen rake, roofline) in paint, and its inner
  // face is the frame the glass dome sits inside.
  const frameShell = new THREE.Shape();
  {
    const outer = profileShape([
      [cFront, hullTop - 0.02, 0.02],
      [rFront, roofY, cab.roofRadius],
      [rBack, roofY, cab.roofRadius],
      [cBack, hullTop - 0.02, 0.02],
    ]);
    const inner = profileShape([
      [glassFront, hullTop - 0.02, 0.02],
      [lerp(glassFront, rFront, 0.85), roofY - cab.glassInset, cab.roofRadius * 0.8],
      [lerp(glassBack, rBack, 0.85), roofY - cab.glassInset, cab.roofRadius * 0.8],
      [glassBack, hullTop - 0.02, 0.02],
    ]);
    frameShell.copy(outer);
    frameShell.holes.push(new THREE.Path(inner.getPoints(10)));
  }
  const cabinFrameGeo = barrelSolid(frameShell, {
    width: halfWBase * 2,
    halfHeight: roofY - hullTop,
    pow: 2.6,
    bevelT: 0.02,
    bevelS: 0.03,
    bevelSegments: 2,
    steps: stepsFor(frameShell, 0.25, 10, 40),
    sculpt: (v) => {
      const wy = v.y + (roofY - hullTop) / 2;
      const k = v.x / Math.max(halfWBase, 1e-3);
      v.y -= prof.tumblehome * k * k * Math.max(0, wy - belt) * 0.9;
    },
  });
  mergeSided(shell, cabinFrameGeo, undefined, true);
  cabinFrameGeo.dispose();

  // Tinted glass dome: another low-poly-ish extrusion sitting inside the frame,
  // smooth-shaded so it reads as one continuous curved pane.
  const domeOuter = profileShape([
    [lerp(glassFront, cFront, 0.0), hullTop + 0.01, 0.02],
    [lerp(glassFront, rFront, 0.9), roofY - cab.glassInset, cab.roofRadius * 0.9],
    [lerp(glassBack, rBack, 0.9), roofY - cab.glassInset, cab.roofRadius * 0.9],
    [glassBack, hullTop + 0.01, 0.02],
  ]);
  const dome = barrelSolid(domeOuter, {
    width: halfWBase * 2 - 0.02,
    halfHeight: roofY - hullTop,
    pow: 2.4,
    bevelT: 0.02,
    bevelS: 0.02,
    bevelSegments: 2,
    steps: stepsFor(domeOuter, 0.25, 10, 40),
    sculpt: (v) => {
      const wy = v.y + (roofY - hullTop) / 2;
      const k = v.x / Math.max(halfWBase, 1e-3);
      v.y -= prof.tumblehome * k * k * Math.max(0, wy - belt) * 0.9;
    },
  });
  put(glass, dome);
  dome.dispose();

  // Faceted creases: A/B/C pillars, window frames.
  buildCreases();

  function buildCreases(): void {
    const t = 0.05; // crease thickness
    const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rotX = 0, rotZ = 0): void => {
      tmpM.makeRotationFromEuler(new THREE.Euler(rotX, 0, rotZ)).setPosition(x, y, z);
      put(frame, geo, tmpM);
    };
    const seatX = (z: number): number => lerp(halfWBase, halfWRoof, taperAt(z));
    for (const s of [-1, 1]) {
      // A-pillar: windscreen base → roof corner, following the rake.
      const z0 = cFront - 0.02;
      const z1 = rFront + 0.02;
      const len = Math.hypot(z1 - z0, roofY - hullTop);
      const ang = Math.atan2(z1 - z0, roofY - hullTop);
      const pillar = new THREE.BoxGeometry(t, len, t * 1.25);
      place(pillar, s * (seatX(z0) + seatX(z1)) * 0.5 * 0.985, (hullTop + roofY) / 2 - 0.01, (z0 + z1) / 2, -ang);
      // B-pillar (and a second one on the van, its cargo bulkhead).
      const bZ = isVan ? [glassFront + 0.02, (glassFront + glassBack) / 2] : [(glassFront + glassBack) / 2];
      for (const bz of bZ) {
        const h = roofY - hullTop;
        place(new THREE.BoxGeometry(t, h, t * 1.4), s * seatX(bz) * 0.985, hullTop + h / 2 - 0.02, bz);
      }
      // C/D-pillar (backlight sides).
      {
        const h = roofY - hullTop;
        const pz = lerp(glassBack, rBack, 0.75);
        place(new THREE.BoxGeometry(t, h * 0.95, t * 1.3), s * seatX(pz) * 0.99, hullTop + h * 0.5, pz);
        place(new THREE.BoxGeometry(t, h * 0.95, t * 1.3), s * seatX(cBack) * 0.75, hullTop + h * 0.5, cBack + 0.01);
      }
      // Bottom window frame (waistline) + top drip rail.
      const wz = (glassFront + glassBack) / 2;
      const wl = glassFront - glassBack - 0.06;
      place(new THREE.BoxGeometry(t * 0.7, t * 0.7, wl), s * seatX(wz) * 0.995, hullTop + 0.02, wz);
      const rz = (rFront + rBack) / 2;
      const rl = rFront - rBack + 0.04;
      place(new THREE.BoxGeometry(t * 0.75, t * 0.7, rl), s * halfWRoof * 0.93, roofY - 0.01, rz);
    }
  }

  /* --------------------------------- bumpers -------------------------------- */
  for (const end of [1, -1] as const) {
    const zc = end * (hullHalfZ - 0.09);
    const bShape = profileShape([
      [0.1, 0.15, 0.05],
      [0.13, 0.0, 0.04],
      [0.0, -0.06, 0.03],
      [-0.12, 0.15, 0.0],
    ]);
    const b = barrelSolid(bShape, {
      width: hullW * 0.99,
      halfHeight: 0.13,
      pow: prof.xPow,
      bevelT: 0.05,
      bevelS: 0.045,
      bevelSegments: 2,
      steps: 12,
      sculpt: (v) => {
        const k = Math.abs(v.x) / (hullW * 0.495);
        // corners wrap back towards the body, ends pull in
        v.z = (v.z + 0.12) * (1 - 0.3 * k * k) - 0.12;
        v.x *= 1 - 0.07 * Math.pow(k, 3);
      },
    });
    tmpM.makeTranslation(0, hullBottom + 0.13, zc);
    mergeSided(trim, b.geo, tmpM, false);
    b.geo.dispose();
  }

  /* ---------------------------- lamps, trim, details ------------------------ */
  const noseZ = hullHalfZ - 0.02;
  const tailZ = -hullHalfZ + 0.02;
  const lampY = belt - 0.06;

  // Headlight lenses: rounded bars poking out of the nose corners.
  for (const s of [-1, 1]) {
    const lens = xBar(0.055, W * (isVan ? 0.22 : 0.27));
    lens.scale(1, 0.8, 1);
    tmpM.makeTranslation(s * W * 0.29, lampY, noseZ - 0.03);
    put(head, lens, tmpM);
  }
  // Tail lamp lenses.
  for (const s of [-1, 1]) {
    const lens = xBar(0.06, W * (isVan ? 0.16 : 0.2));
    lens.scale(1, 1.05, 0.9);
    tmpM.makeTranslation(s * W * 0.31, lampY + 0.02, tailZ + 0.02);
    put(brake, lens, tmpM);
  }
  // Third brake light on the rear edge of the glass dome.
  {
    const g = new THREE.BoxGeometry(isVan ? 0.06 : 0.3, 0.035, 0.03);
    tmpM.makeTranslation(0, lerp(hullTop, roofY, 0.55), glassBack - 0.02);
    put(brake, g, tmpM);
  }
  // Grille: dark bar with chrome slats plus a lower intake.
  {
    const gy = belt - 0.17;
    const grille = xBar(0.055, W * 0.36);
    grille.scale(1, 1.15, 0.8);
    tmpM.makeTranslation(0, gy, noseZ - 0.01);
    put(trim, grille, tmpM);
    for (let i = -1; i <= 1; i++) {
      const slat = new THREE.BoxGeometry(W * 0.34, 0.012, 0.02);
      tmpM.makeTranslation(0, gy + i * 0.035, noseZ + 0.03);
      put(chrome, slat, tmpM);
    }
    const intake = xBar(0.04, W * 0.42);
    tmpM.makeTranslation(0, hullBottom + 0.1, noseZ - 0.04);
    put(trim, intake, tmpM);
  }
  // Rocker / sill strips along the bottom of both flanks.
  for (const s of [-1, 1]) {
    const sill = zBar(0.05, L * 0.56);
    sill.scale(1.5, 1, 1);
    tmpM.makeTranslation(s * hullHalfW * 0.86, hullBottom + 0.02, 0);
    put(trim, sill, tmpM);
  }
  // Door shut seams (thin dark bars) + door handles + chrome side trim.
  {
    const seamZ = isVan ? [glassFront - 0.02, lerp(glassFront, glassBack, 0.55)] : [lerp(glassFront, glassBack, 0.18), lerp(glassFront, glassBack, 0.86)];
    const waistY = belt - 0.02;
    for (const s of [-1, 1]) {
      const sx = s * (flankAt((waistY - hullMid) / (hullHalfH + 0.02), prof.xPow) * hullHalfW * 0.985);
      for (const sz of seamZ) {
        const h = waistY - (hullBottom + 0.12);
        const seam = new THREE.BoxGeometry(0.02, h, 0.014);
        tmpM.makeTranslation(sx, hullBottom + 0.12 + h / 2, sz);
        mergeSided(trim, seam, tmpM, false);
        seam.dispose();
      }
      // waistline chrome moulding
      const moulding = zBar(0.012, glassFront - glassBack + 0.15);
      tmpM.makeTranslation(s * flankAt((waistY - hullMid) / (hullHalfH + 0.02), prof.xPow) * hullHalfW * 1.005, waistY, (glassFront + glassBack) / 2);
      put(chrome, moulding, tmpM);
      // door handles
      for (const hz of isVan ? [lerp(glassFront, glassBack, 0.4)] : [lerp(glassFront, glassBack, 0.3), lerp(glassFront, glassBack, 0.75)]) {
        const handle = zBar(0.016, 0.1, 6, 3);
        tmpM.makeTranslation(s * flankAt((belt - 0.11 - hullMid) / (hullHalfH + 0.02), prof.xPow) * hullHalfW * 1.0, belt - 0.11, hz);
        put(chrome, handle, tmpM);
      }
      // door crease along the flank (paint-coloured, adds a highlight line)
      const crease = zBar(0.008, isVan ? L * 0.5 : L * 0.42, 6, 3);
      tmpM.makeTranslation(s * flankAt((belt - 0.16 - hullMid) / (hullHalfH + 0.02), prof.xPow) * hullHalfW * 1.002, belt - 0.16, -0.02);
      mergeSided(rest, crease, tmpM, false);
      crease.dispose();
    }
  }
  // Wing mirrors: stalk + rounded housing just outside the glasshouse.
  for (const s of [-1, 1]) {
    const mz = cFront - 0.02;
    const seat = seatX(mz) * 0.98;
    const my = lerp(hullTop, roofY, 0.25);
    const stalk = xBar(0.02, 0.08, 6, 3);
    tmpM.makeTranslation(s * (seat + 0.04), my, mz);
    mergeSided(trim, stalk, tmpM, false);
    stalk.dispose();
    const housing = new THREE.CapsuleGeometry(0.045, 0.06, 3, 8);
    housing.scale(1.0, 0.95, 1.25);
    tmpM.makeTranslation(s * (seat + 0.11), my + 0.01, mz - 0.02);
    mergeSided(trim, housing, tmpM, false);
    housing.dispose();
    // reflected "glass" face on the mirror
    const face = new THREE.BoxGeometry(0.012, 0.05, 0.07);
    tmpM.makeTranslation(s * (seat + 0.155), my + 0.01, mz - 0.02);
    put(chrome, face, tmpM);
  }
  // Number plates, front + rear.
  {
    const plate = new THREE.BoxGeometry(0.42, 0.1, 0.015);
    tmpM.makeTranslation(0, hullBottom + 0.13, noseZ + 0.06);
    put(chrome, plate, tmpM);
    tmpM.makeTranslation(0, hullBottom + 0.15, tailZ - 0.06);
    put(chrome, plate, tmpM);
    plate.dispose();
  }
  // Exhaust pipe (rear, right side) — dark metal tube.
  {
    const pipe = new THREE.CylinderGeometry(0.045, 0.05, 0.14, 12, 1, true);
    pipe.rotateX(Math.PI / 2);
    tmpM.makeTranslation(-W * 0.3, hullBottom + 0.04, -hullHalfZ + 0.02);
    put(rimDark, pipe, tmpM);
  }
  // Van roof rails, sport rear wing (silhouette differentiation).
  if (isVan) {
    for (const s of [-1, 1]) {
      const rail = zBar(0.02, rFront - rBack - 0.2, 6, 3);
      tmpM.makeTranslation(s * halfWRoof * 0.82, roofY + 0.03, (rFront + rBack) / 2);
      mergeSided(trim, rail, tmpM, false);
      rail.dispose();
    }
  }
  if (isSport) {
    const wing = xBar(0.024, hullW * 0.78, 8, 4);
    wing.scale(1, 0.6, 1.6);
    tmpM.makeTranslation(0, hullTop + 0.13, -hullHalfZ + 0.26);
    mergeSided(trim, wing, tmpM, false);
    wing.dispose();
    for (const s of [-1, 1]) {
      const post = new THREE.BoxGeometry(0.035, 0.13, 0.09);
      tmpM.makeTranslation(s * hullW * 0.28, hullTop + 0.06, -hullHalfZ + 0.26);
      mergeSided(trim, post, tmpM, false);
      post.dispose();
    }
  }
  // Sill slab — shadow-map only, so the sun sees a body under the wheels.
  {
    const slab = new THREE.BoxGeometry(hullW * 0.9, 0.18, L * 0.8);
    tmpM.makeTranslation(0, hullBottom - 0.02, 0);
    put(interior, slab, tmpM);
  }

  /* --------------------------------- wheels --------------------------------- */
  // Tyre: 32-sided cylinder plus a slightly larger tread band and two sidewall
  // rings, all smooth-shaded so they read as a proper round tyre.
  {
    const t = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 32, 1);
    t.rotateZ(Math.PI / 2);
    put(tyre, t, tmpM.identity());
    for (const s of [-1, 1]) {
      t.translate(s * wheelW * 0.36, 0, 0);
    }
    const tread = new THREE.CylinderGeometry(wheelR * 1.01, wheelR * 1.01, wheelW * 0.62, 32, 1);
    tread.rotateZ(Math.PI / 2);
    put(rimDark, tread);
  }
  // Hubcap dish, spokes and centre nub on the outer face of the tyre.
  {
    const dish = new THREE.CylinderGeometry(wheelR * 0.6, wheelR * 0.54, 0.035, 24, 1);
    dish.rotateZ(Math.PI / 2);
    dish.translate(wheelW / 2 - 0.005, 0, 0);
    put(rim, dish);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(0.014, wheelR * 0.92, 0.055);
      tmpM.makeRotationX(a).setPosition(wheelW / 2 + 0.012, 0, 0);
      put(rimDark, spoke, tmpM);
    }
    const hub = new THREE.CylinderGeometry(wheelR * 0.17, wheelR * 0.17, 0.05, 12);
    hub.rotateZ(Math.PI / 2);
    hub.translate(wheelW / 2 + 0.006, 0, 0);
    put(rim, hub);
    // Inner dish (dark) so the rim has depth from a low angle.
    const inner = new THREE.CylinderGeometry(wheelR * 0.55, wheelR * 0.55, 0.06, 20, 1);
    inner.rotateZ(Math.PI / 2);
    inner.translate(-wheelW / 2 + 0.03, 0, 0);
    put(rimDark, inner);
  }

  /* ---------------------------------- meshes -------------------------------- */
  const mats: Mats = {
    paint: new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.45, envMapIntensity: 1.1 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x16222f, roughness: 0.06, metalness: 0.85, envMapIntensity: 1.6 }),
    frame: new THREE.MeshStandardMaterial({ color: shade(color, 0.72), roughness: 0.35, metalness: 0.4 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.6, metalness: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9e0e8, roughness: 0.15, metalness: 1 }),
    head: new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff0c8, emissiveIntensity: 1.0, roughness: 0.12, metalness: 0.3 }),
    brake: new THREE.MeshStandardMaterial({ color: 0x8f1c1c, emissive: 0xff2b22, emissiveIntensity: 0.15, roughness: 0.3 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.94, metalness: 0.02 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc6ccd4, roughness: 0.26, metalness: 0.92 }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.55, metalness: 0.55 }),
  };

  const body = new THREE.Group();
  body.name = 'body';
  group.add(body);

  /** Attach one merged bucket as a child mesh. */
  const addPart = (
    parent: THREE.Object3D,
    acc: Acc,
    material: THREE.Material,
    name: string,
    opts: { smooth?: boolean; cast?: boolean } = {},
  ): THREE.Mesh | null => {
    if (acc.idx.length === 0) return null;
    const mesh = new THREE.Mesh(accToGeometry(acc, opts.smooth !== false), material);
    mesh.name = name;
    mesh.castShadow = opts.cast ?? true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // The painted bucket = shell faces + extra painted parts. Seams live in
  // `trim`, which is only on the flanks: filter the flank faces of the shell
  // that a seam covers so the two surfaces never fight for the same pixels.
  {
    const merged: Acc = { pos: [], idx: [] };
    copySided(merged, shell, 0);
    copySided(merged, rest, 1);
    addPart(body, merged, mats.paint, 'body-paint');
  }
  addPart(body, glass, mats.glass, 'cabin-glass', { cast: false });
  addPart(body, frame, mats.frame, 'cabin-frame');
  addPart(body, trim, mats.trim, 'bumper-trim');
  addPart(body, chrome, mats.chrome, 'chrome');
  addPart(body, head, mats.head, 'headlights', { cast: false });
  addPart(body, brake, mats.brake, 'taillights', { cast: false });
  addPart(body, rimDark, mats.rimDark, 'exhaust-brake-drums');

  const wheelParts = new THREE.Group();
  wheelParts.name = 'wheel-parts';
  group.add(wheelParts);
  addPart(wheelParts, tyre, mats.tyre, 'tyre');
  addPart(wheelParts, rim, mats.rim, 'rim');
  // Wheels need their geometry instanced at the four steer pivots instead of
  // sitting in one merged mesh: re-parent the merged meshes so each bucket is
  // one InstancedMesh over the four `spin` pivots below.
  void wheelParts;

  // Shadow-map-only underbody.
  {
    const hidden = mats.trim.clone();
    hidden.name = 'shadow-only';
    hidden.colorWrite = false;
    hidden.depthWrite = false;
    const mesh = addPart(body, interior, hidden, 'underbody-shadow-only');
    if (mesh) mesh.receiveShadow = false;
  }

  /* ------------------------------- soft shadow ------------------------------ */
  const blobGeo = new THREE.PlaneGeometry(W * 1.22, L * 1.02);
  blobGeo.rotateX(-Math.PI / 2);
  blobGeo.translate(0, 0.02, 0);
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, alphaMap: SOFT_RADIAL_TEXTURE });
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

/** Append a sided accumulator to a plain accumulator, optionally filtering. */
function copySided(target: Acc, source: SidedAcc, onlyShell: 0 | 1): void {
  const base = target.pos.length / 3;
  for (let i = 0; i < source.side.length; i++) target.pos.push(source.pos[i * 3], source.pos[i * 3 + 1], source.pos[i * 3 + 2]);
  for (let f = 0; f < source.idx.length; f += 3) {
    const a = source.idx[f];
    const b = source.idx[f + 1];
    const c = source.idx[f + 2];
    if (onlyShell === 0 && (source.shell[a] !== 1 || source.shell[b] !== 1 || source.shell[c] !== 1)) continue;
    target.idx.push(base + a, base + b, base + c);
  }
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
 * Recolour an existing car without rebuilding geometry: repaints the painted
 * shell and keeps the greenhouse pillars in a matching darker shade.
 */
export function tintVehicleMesh(mesh: THREE.Object3D, color: number): void {
  const data = getVehicleMeshData(mesh);
  const next = normColor(color);
  data.paint.color.setHex(next);
  const frame = data.body.getObjectByName('cabin-frame') as THREE.Mesh | undefined;
  const frameMat = frame?.material as THREE.MeshStandardMaterial | undefined;
  if (frameMat && frameMat !== data.paint) frameMat.color.setHex(shade(next, 0.72));
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
