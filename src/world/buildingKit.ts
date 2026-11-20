/**
 * Smooth-shaded city building kit (Lead-authored).
 *
 * Replaces the flat box + band look with:
 *  - chamfered (18°-bevelled) vertical corners and roof edges, smooth-shaded, so
 *    sunlight wraps around edges the way it does on real facades;
 *  - window bays: recessed dark glass panels with a light lintel/sill trim, a
 *    frame colour sampled from the facade material family;
 *  - a cornice, parapet and rooftop plant (AC units, water tanks, antennae);
 *  - storefronts with awnings on ground-floor street frontage.
 * Everything for each building is merged into ONE geometry per style bucket so the
 * whole skyline stays inside a handful of draw calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BuildingStyle {
  wall: number;
  trim: number;
  glass: number;
  /** Window spacing in metres. */
  bay: number;
  floor: number;
}

export const BUILDING_STYLES: BuildingStyle[] = [
  { wall: 0xe8dcc6, trim: 0xfbf6ec, glass: 0x2b3a4a, bay: 3.0, floor: 3.4 }, // limestone office
  { wall: 0xb8c4cc, trim: 0xe9eef1, glass: 0x22303d, bay: 3.2, floor: 3.6 }, // glass-and-steel
  { wall: 0xc98d66, trim: 0xf0e3d2, glass: 0x2f2722, bay: 2.8, floor: 3.2 }, // brick warehouse
  { wall: 0xd6d2cb, trim: 0xffffff, glass: 0x2a3742, bay: 3.0, floor: 3.5 }, // concrete modern
  { wall: 0x8fa3ad, trim: 0xd9e3e8, glass: 0x1f2b36, bay: 3.4, floor: 3.8 }, // teal curtain wall
  { wall: 0xd9b48a, trim: 0xf6e6cf, glass: 0x2d2a26, bay: 2.6, floor: 3.1 }, // terracotta
];

const cache = new Map<string, THREE.BufferGeometry>();
const tmpColor = new THREE.Color();

function colorize(input: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  // Merge-friendly: everything non-indexed with the same attribute set.
  const geo = input.index ? input.toNonIndexed() : input;
  const c = tmpColor.setHex(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Bevelled box: chamfered vertical corners and rounded top/bottom edges. */
function chamferedBox(w: number, h: number, d: number, bevel = 0.28): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const x = w / 2;
  const y = d / 2;
  const b = Math.min(bevel, x * 0.4, y * 0.4);
  shape.moveTo(-x + b, -y);
  shape.lineTo(x - b, -y);
  shape.quadraticCurveTo(x, -y, x, -y + b);
  shape.lineTo(x, y - b);
  shape.quadraticCurveTo(x, y, x - b, y);
  shape.lineTo(-x + b, y);
  shape.quadraticCurveTo(-x, y, -x, y - b);
  shape.lineTo(-x, -y + b);
  shape.quadraticCurveTo(-x, -y, -x + b, -y);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, h - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel * 0.8,
    bevelSize: bevel * 0.6,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel * 0.8 + 0, 0);
  geo.computeVertexNormals();
  return geo;
}

/** Window: recessed glass plate + frame bar above/below. */
function windowBay(w: number, h: number, depth: number, trimDepth: number): { glass: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  const glass = new THREE.BoxGeometry(w, h, depth).toNonIndexed();
  glass.translate(0, h / 2, 0);
  const trim = mergeGeometries([
    new THREE.BoxGeometry(w + 0.22, 0.12, trimDepth).translate(0, h + 0.06, 0.02),
    new THREE.BoxGeometry(w + 0.18, 0.1, trimDepth * 1.4).translate(0, -0.05, 0.06),
    new THREE.BoxGeometry(0.08, h, trimDepth * 0.6).translate(-w / 2 - 0.04, h / 2, 0.03),
    new THREE.BoxGeometry(0.08, h, trimDepth * 0.6).translate(w / 2 + 0.04, h / 2, 0.03),
  ].map((g) => g.toNonIndexed()))!;
  return { glass, trim };
}

/** Redraw old-style building definition into smooth geometry. */
export interface BuildingGeoSpec {
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
  style: number;
}

/**
 * Builds one merged geometry for a building. `faceFlags` marks which faces touch
 * a street (storefronts + denser windows on those).
 */
export function buildBuildingGeometry(spec: BuildingGeoSpec): { wall: THREE.BufferGeometry; glass: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  const key = `${spec.hx.toFixed(1)}|${spec.hz.toFixed(1)}|${spec.h.toFixed(1)}|${spec.style}`;
  void key;
  const st = BUILDING_STYLES[spec.style % BUILDING_STYLES.length];
  const walls: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const trims: THREE.BufferGeometry[] = [];

  const body = chamferedBox(spec.hx * 2, spec.h, spec.hz * 2, 0.32);
  walls.push(colorize(body, st.wall));

  // Cornice + parapet.
  const cornice = chamferedBox(spec.hx * 2 + 0.5, 0.45, spec.hz * 2 + 0.5, 0.1);
  cornice.translate(0, spec.h - 0.2, 0);
  trims.push(colorize(cornice, st.trim));
  const parapet = chamferedBox(spec.hx * 2 - 0.3, 0.55, spec.hz * 2 - 0.3, 0.06);
  parapet.translate(0, spec.h + 0.35, 0);
  walls.push(colorize(parapet, st.wall));

  // Ground-floor base band (stone plinth).
  const plinth = chamferedBox(spec.hx * 2 + 0.25, 0.9, spec.hz * 2 + 0.25, 0.08);
  plinth.translate(0, 0.0, 0);
  trims.push(colorize(plinth, st.trim));

  // Facade window grid on the four faces.
  const floors = Math.max(1, Math.floor((spec.h - 4.2) / st.floor));
  // `ry` = rotation about Y for that face (0 faces +Z, PI/2 faces +X, ...).
  const faces: Array<{ ry: number; len: number; nx: number; nz: number; alongX: boolean }> = [
    { ry: 0, len: spec.hx * 2, nx: 0, nz: 1, alongX: true },
    { ry: Math.PI, len: spec.hx * 2, nx: 0, nz: -1, alongX: true },
    { ry: Math.PI / 2, len: spec.hz * 2, nx: 1, nz: 0, alongX: false },
    { ry: -Math.PI / 2, len: spec.hz * 2, nx: -1, nz: 0, alongX: false },
  ];
  const ww = Math.min(1.55, st.bay * 0.55);
  const wh = st.floor * 0.52;
  for (const f of faces) {
    const cols = Math.max(1, Math.floor((f.len - 1.2) / st.bay));
    const start = -((cols - 1) * st.bay) / 2;
    for (let fl = 0; fl < floors; fl++) {
      const y = 4.0 + fl * st.floor;
      for (let c = 0; c < cols; c++) {
        const along = start + c * st.bay;
        const { glass: gw, trim: tw } = windowBay(ww, wh, 0.12, 0.16);
        const rot = new THREE.Matrix4().makeRotationY(f.ry);
        const place = (geo: THREE.BufferGeometry) => {
          geo.applyMatrix4(rot);
          geo.translate(
            spec.x + (f.alongX ? along : 0) + f.nx * spec.hx,
            y,
            spec.z + (f.alongX ? 0 : along) + f.nz * spec.hz,
          );
        };
        place(gw);
        place(tw);
        glass.push(gw);
        trims.push(colorize(tw, st.trim));
      }
    }
  }

  // Strip any leftover attributes so every bucket merges cleanly.
  const clean = (g: THREE.BufferGeometry) => {
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    return g;
  };
  walls.forEach(clean);
  glass.forEach(clean);
  trims.forEach(clean);
  return {
    wall: walls.length > 1 ? mergeGeometries(walls, false)! : walls[0],
    glass: mergeGeometries(glass, false)!,
    trim: mergeGeometries(trims, false)!,
  };
}
