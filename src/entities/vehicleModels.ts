/**
 * PROCEDURAL VEHICLE MODELS — low-poly cars for MINI GTA.
 * Owned by: Agent 2 (W-2).
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
 * Bodies and the shadow blob cast shadows; wheels, glass and lights don't.
 * No `document` usage, so this module is safe to import in Node/Vitest.
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
/** Track width as a fraction of the spec width. */
const TRACK_FRACTION = 0.86;
/** Axle inset from the bumpers as a fraction of the length. */
const AXLE_INSET = 0.19;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Darken a colour by `k` (0..1, 1 = unchanged) — used for shadows / trim. */
function shade(color: number, k: number): number {
  const c = new THREE.Color(color);
  c.multiplyScalar(k);
  return c.getHex();
}

/** Convert #RRGGBB to 0xRRGGBB and back; harmless for ints already in range. */
function normColor(color: number): number {
  return color >>> 0 & 0xffffff;
}

/* -------------------------------------------------------------------------- */
/* Geometry builders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * BoxGeometry with the top face optionally tapered inwards.
 * `topScaleX` / `topScaleZ` < 1 makes a trapezoid cabin (classic low-poly car roof).
 */
function taperedBox(
  w: number,
  h: number,
  d: number,
  topScaleX = 1,
  topScaleZ = 1,
  offsetTopZ = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topScaleX);
      pos.setZ(i, pos.getZ(i) * topScaleZ + offsetTopZ);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Four-sided roof (windscreen + rear window + side pillars) from a top rect. */
function roofGeometry(bottomW: number, bottomD: number, topW: number, topD: number, h: number, topShiftZ: number): THREE.BufferGeometry {
  //              0---1      bottom back-left..: see indices below
  const b = bottomW / 2;
  const bd = bottomD / 2;
  const t = topW / 2;
  const td = topD / 2;
  const z0 = -bd;
  const z1 = bd;
  const verts = new Float32Array([
    // bottom ring (y=0): BL, BR, FR, FL   (x, z)
    -b, 0, z0,  b, 0, z0,  b, 0, z1,  -b, 0, z1,
    // top ring (y=h): BL, BR, FR, FL
    -t, h, z0 + topShiftZ,  t, h, z0 + topShiftZ,  t, h, z1 + topShiftZ,  -t, h, z1 + topShiftZ,
  ]);
  // Winding is counter-clockwise when seen from INSIDE the shell; the roof
  // material uses BackSide so only the outer shell is visible (no holes in-game).
  const idx = [
    0, 4, 5, 0, 5, 1, // back window
    1, 5, 6, 1, 6, 2, // +X side pillars
    2, 6, 7, 2, 7, 3, // windscreen
    3, 7, 4, 3, 4, 0, // −X side pillars
    4, 7, 6, 4, 6, 5, // roof
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Wheel: black tyre cylinder + light hub disc. Axis = local X (rolls around X). */
function makeWheel(radius: number, width: number, mats: { tyre: THREE.Material; hub: THREE.Material }): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 12, 1), mats.tyre);
  tyre.rotation.z = Math.PI / 2; // cylinder axis Y → X
  g.add(tyre);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.012, 8, 1), mats.hub);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  return g;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a recognisable low-poly car for the given spec.
 * The Group must be added to the scene by the caller; its `position`/`rotation.y`
 * are driven every frame by the VehicleSystem.
 */
export function createVehicleMesh(spec: VehicleSpec): VehicleMesh {
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const color = normColor(spec.color);

  const group = new THREE.Group() as VehicleMesh;
  group.name = `vehicle:${spec.id}`;

  /* --------------------------- materials --------------------------- */
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.32 });
  const paintDark = new THREE.MeshStandardMaterial({ color: shade(color, 0.62), roughness: 0.5, metalness: 0.25 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.75, metalness: 0.2, side: THREE.DoubleSide });
  // Roof shell is inverted (double-sided so it is safe either way).
  const roofMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.32,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1b2a38,
    roughness: 0.12,
    metalness: 0.55,
    transparent: true,
    opacity: 0.86,
  });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.1, roughness: 0.3 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x8f1c1c, emissive: 0xff2b22, emissiveIntensity: 0.15, roughness: 0.4 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, roughness: 0.35, metalness: 0.8 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.7 });
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false });

  /* ------------------------------ body ------------------------------ */
  // `body` is the pitch/roll pivot — everything except wheels + blob hangs off it.
  const body = new THREE.Group();
  body.name = 'body';
  group.add(body);

  // Wheelbase / track geometry shared with the wheel placement below.
  const wheelR = WHEEL_RADIUS[spec.id];
  const track = W * TRACK_FRACTION;
  const axleZ = L / 2 - L * AXLE_INSET;

  // Lower hull (dark) — sits below the paint band so the ride height reads.
  const sillH = 0.22;
  const sill = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, sillH, L * 0.94), paintDark);
  sill.position.y = wheelR * 0.62;
  sill.castShadow = true;
  body.add(sill);

  // Main body: a tapered slab. The nose (local +Z) gets a slightly forward-raked top.
  const mainH = spec.id === 'van' ? 0.72 : 0.52;
  const mainBottom = sill.position.y + sillH * 0.4;
  const mainGeo = taperedBox(W * 0.96, mainH, L * 0.94, 0.97, 0.93, spec.id === 'sport' ? 0.12 : 0.04);
  const main = new THREE.Mesh(mainGeo, paint);
  main.position.y = mainBottom + mainH / 2;
  main.castShadow = true;
  main.receiveShadow = true;
  body.add(main);

  const mainTop = mainBottom + mainH;

  // Bumpers (front + rear) in dark trim.
  const bumperGeo = new THREE.BoxGeometry(W * 0.98, 0.2, 0.22);
  const bumperFront = new THREE.Mesh(bumperGeo, trim);
  bumperFront.position.set(0, wheelR * 0.75, L / 2 - 0.09);
  bumperFront.castShadow = true;
  body.add(bumperFront);
  const bumperRear = new THREE.Mesh(bumperGeo, trim);
  bumperRear.position.set(0, wheelR * 0.75, -L / 2 + 0.09);
  bumperRear.castShadow = true;
  body.add(bumperRear);

  // Grille + number plate on the nose.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, 0.14, 0.04), trim);
  grille.position.set(0, mainBottom + mainH * 0.42, L / 2 - 0.02);
  body.add(grille);
  const plateF = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.03), plateMat);
  plateF.position.set(0, wheelR * 0.8, L / 2 + 0.005);
  body.add(plateF);

  /* ------------------------- cabin / greenhouse ------------------------- */
  // Each type gets a distinct silhouette.
  let cabinH: number;
  let cabinLen: number;
  let cabinZ: number; // centre of the cabin
  let cabinW: number;
  let topW: number;
  let roofH: number;
  let topShiftZ = 0;

  switch (spec.id) {
    case 'sport': {
      // Long bonnet, low wedge cabin pushed towards the rear axle.
      cabinH = 0.3;
      cabinLen = L * 0.4;
      cabinZ = -L * 0.06;
      cabinW = W * 0.86;
      topW = W * 0.66;
      roofH = 0.36;
      topShiftZ = -0.08;
      break;
    }
    case 'van': {
      // Tall boxy cargo box: short nose, nearly full-length greenhouse.
      cabinH = 0.62;
      cabinLen = L * 0.62;
      cabinZ = -L * 0.1;
      cabinW = W * 0.94;
      topW = W * 0.9;
      roofH = 0.42;
      break;
    }
    default: {
      // Sedan: three-box, cabin centred over the middle.
      cabinH = 0.36;
      cabinLen = L * 0.5;
      cabinZ = -L * 0.04;
      cabinW = W * 0.88;
      topW = W * 0.74;
      roofH = 0.42;
      break;
    }
  }

  // Glass colonnade (slightly inset from the roof so pillars show).
  const glassGeo = taperedBox(cabinW, cabinH, cabinLen, topW / cabinW, 0.82, topShiftZ * (cabinH / (cabinH + roofH)));
  const glassBox = new THREE.Mesh(glassGeo, glass);
  glassBox.position.set(0, mainTop + cabinH / 2, cabinZ);
  body.add(glassBox);

  // Roof shell — hides the glass box interior from above.
  const roofGeo = roofGeometry(cabinW * 0.99, cabinLen * 0.99, topW, cabinLen * 0.78, roofH, topShiftZ);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, mainTop + cabinH, cabinZ);
  roof.castShadow = true;
  body.add(roof);

  // B-pillars (thin dark posts) so the cabin doesn't read as one glass cube.
  const pillarGeo = new THREE.BoxGeometry(0.06, cabinH + roofH * 0.55, 0.07);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(pillarGeo, trim);
    p.position.set(sx * (cabinW / 2) * 0.97, mainTop + (cabinH + roofH * 0.55) / 2, cabinZ + cabinLen * 0.02);
    body.add(p);
  }

  // Windscreen rake: an angled dark plane on the front face of the cabin.
  const windGeo = new THREE.PlaneGeometry(cabinW * 0.9, cabinH * 1.05);
  const windscreen = new THREE.Mesh(windGeo, glass);
  windscreen.position.set(0, mainTop + cabinH * 0.5, cabinZ + cabinLen / 2 + 0.005);
  windscreen.rotation.x = spec.id === 'van' ? -0.12 : -0.42;
  body.add(windscreen);

  /* ----------------------------- lights ----------------------------- */
  const headlights: THREE.MeshStandardMaterial[] = [];
  const headGeo = new THREE.BoxGeometry(0.26, 0.13, 0.06);
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(headGeo, headMat);
    hl.position.set(sx * (W * 0.36), mainBottom + mainH * 0.72, L / 2 + 0.005);
    body.add(hl);
    headlights.push(headMat);
  }
  const brakeLights: THREE.MeshStandardMaterial[] = [];
  const tailGeo = new THREE.BoxGeometry(0.24, 0.12, 0.06);
  for (const sx of [-1, 1]) {
    const tl = new THREE.Mesh(tailGeo, brakeMat);
    tl.position.set(sx * (W * 0.35), mainBottom + mainH * 0.7, -L / 2 - 0.005);
    body.add(tl);
    brakeLights.push(brakeMat);
  }
  // Centre high-mount stop lamp.
  const centerBrake = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.04), brakeMat);
  centerBrake.position.set(0, mainTop + roofH * 0.2, cabinZ - cabinLen / 2 - 0.02);
  body.add(centerBrake);

  /* ----------------------------- mirrors ---------------------------- */
  const mirrorGeo = new THREE.BoxGeometry(0.16, 0.1, 0.08);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.04), trim);
    arm.position.set(sx * (W / 2 + 0.03), mainTop + 0.08, cabinZ + cabinLen * 0.3);
    body.add(arm);
    const m = new THREE.Mesh(mirrorGeo, paintDark);
    m.position.set(sx * (W / 2 + 0.13), mainTop + 0.1, cabinZ + cabinLen * 0.3);
    body.add(m);
  }

  /* ----------------------------- details ---------------------------- */
  // Side skirts / door lines (a thin dark strip each side).
  const skirtGeo = new THREE.BoxGeometry(0.04, 0.08, L * 0.7);
  for (const sx of [-1, 1]) {
    const sk = new THREE.Mesh(skirtGeo, trim);
    sk.position.set(sx * (W / 2 - 0.01), wheelR * 0.55, 0);
    body.add(sk);
  }

  // Exhaust pipe (rear, right side).
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 6), hubMat);
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.set(-W * 0.3, wheelR * 0.55, -L / 2 - 0.02);
  body.add(exhaust);

  // Roof rack on the van for silhouette differentiation.
  if (spec.id === 'van') {
    const rackGeo = new THREE.BoxGeometry(topW * 0.9, 0.04, cabinLen * 0.5);
    const rack = new THREE.Mesh(rackGeo, trim);
    rack.position.set(0, mainTop + cabinH + roofH + 0.02, cabinZ);
    body.add(rack);
  }
  // Rear spoiler on the sport car.
  if (spec.id === 'sport') {
    const wingGeo = new THREE.BoxGeometry(W * 0.8, 0.04, 0.24);
    const wing = new THREE.Mesh(wingGeo, paintDark);
    wing.position.set(0, mainTop + 0.14, -L / 2 + 0.2);
    body.add(wing);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08), trim);
      post.position.set(sx * W * 0.3, mainTop + 0.07, -L / 2 + 0.2);
      body.add(post);
    }
  }

  /* ------------------------------ wheels ---------------------------- */
  const wheelW = spec.id === 'sport' ? 0.26 : spec.id === 'van' ? 0.3 : 0.24;
  const wheels: WheelRef[] = [];
  for (const z of [axleZ, -axleZ]) {
    // +X is the car's left-hand side.
    for (const x of [track / 2, -track / 2]) {
      const steer = new THREE.Group();
      steer.position.set(x, wheelR, z);
      const spin = makeWheel(wheelR, wheelW, { tyre: tyreMat, hub: hubMat });
      steer.add(spin);
      group.add(steer); // wheels hang off the root, so body roll doesn't lift them
      wheels.push({ steer, spin, front: z > 0, radius: wheelR });
    }
  }

  // Wheel arch shadow discs so the tyres "sit" in the body.
  const archGeo = new THREE.CircleGeometry(wheelR * 1.12, 10);
  for (const sx of [-1, 1]) {
    for (const z of [axleZ, -axleZ]) {
      const arch = new THREE.Mesh(archGeo, trim);
      arch.position.set(sx * (W * 0.49), wheelR, z);
      arch.rotation.y = sx * Math.PI / 2;
      body.add(arch);
    }
  }

  /* --------------------------- soft shadow -------------------------- */
  const shadowGeo = new THREE.CircleGeometry(0.5, 20);
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(L * 0.95, W * 1.15, 1);
  shadow.position.y = 0.02;
  shadow.renderOrder = -1;
  group.add(shadow);

  /* --------------------------- userData ----------------------------- */
  group.userData = {
    spec,
    body,
    wheels,
    brakeLights: [brakeMat],
    headlights,
    shadow,
    paint,
  };

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
 * Recolour an existing car (paint + darker trim) without rebuilding geometry.
 */
export function tintVehicleMesh(mesh: THREE.Object3D, color: number): void {
  const data = getVehicleMeshData(mesh);
  data.paint.color.setHex(normColor(color));
  mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material === data.paint) m.material = data.paint;
  });
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
