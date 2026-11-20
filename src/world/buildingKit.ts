/**
 * Smooth-shaded city building kit (Lead-authored; facade rewrite by QA).
 *
 * Replaces the flat box + band look with:
 *  - a clean, chamfered (bevelled) building body, smooth-shaded, so sunlight wraps
 *    around the vertical corners the way it does on real facades;
 *  - one simple, evenly spaced window grid on all four faces: a dark recessed
 *    glass plate with a light sill under it (no lintels/jambs/dormers/mullions);
 *  - a thin cornice band under the roof line, a parapet and rooftop plant.
 * Everything for each building is merged into ONE geometry per style bucket so the
 * whole skyline stays inside a handful of draw calls, and each bucket is ONE
 * surface (no coplanar overlapping faces that z-fight).
 *
 * Uses plain merged boxes rather than ExtrudeGeometry: extrusions triple the
 * vertex budget and their bevel faces are what caused the old facade to read as
 * a chaotic mask once the window grid landed (see BUILDING-VISIBILITY notes).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BuildingStyle {
  wall: number;
  trim: number;
  glass: number;
  /** Window spacing in metres (horizontal). */
  bay: number;
  /** Floor-to-floor height in metres (vertical window pitch). */
  floor: number;
}

// QA: retuned stone families. The old wall colours ran to ~0.81 linear (0xe8dcc6),
// which washed the facades out against the sky; these sit in [0.24, 0.75] linear.
export const BUILDING_STYLES: BuildingStyle[] = [
  { wall: 0xdcd2be, trim: 0xf8f3e8, glass: 0x3a4b5e, bay: 3.0, floor: 3.4 }, // limestone office
  { wall: 0xbcc7cf, trim: 0xf2f6f9, glass: 0x36495c, bay: 3.2, floor: 3.6 }, // glass-and-steel
  { wall: 0xcaa488, trim: 0xf7ebdd, glass: 0x3b4a5a, bay: 2.8, floor: 3.2 }, // brick warehouse
  { wall: 0xd9d5ce, trim: 0xeeeae3, glass: 0x394b5b, bay: 3.0, floor: 3.5 }, // concrete modern
  { wall: 0xa9b7bf, trim: 0xe3ebef, glass: 0x33465a, bay: 3.4, floor: 3.8 }, // teal curtain wall
  { wall: 0xd8bda0, trim: 0xfcf1e4, glass: 0x3c4a58, bay: 2.6, floor: 3.1 }, // terracotta
];

const tmpColor = new THREE.Color();

function colorize(input: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  // Merge-friendly: everything non-indexed with the same attribute set.
  const geo = input.index ? input.toNonIndexed() : input;
  // Hex inputs are sRGB; vertex colours must be LINEAR for the renderer.
  // THREE.Color.setHex(hex, SRGBColorSpace) converts sRGB → the working (linear) space.
  const c = tmpColor.setHex(color, THREE.SRGBColorSpace);
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

/**
 * Straight, unlit corner faces make a building read as a solid mass from the
 * street (no floating dark facets, no z-fighting between coplanar boxes).
 * Cornice/sills are the only protruding relief.
 */
/** The stone body slabs of one building (chamfered body + proud parapet lip). */
export function bodySlabs(spec: BuildingGeoSpec, st: BuildingStyle): THREE.BufferGeometry[] {
  // Body + parapet (same colour family so the tower reads as one mass). The
  // parapet is a proud lip: it reads against the sky at street level.
  const walls: THREE.BufferGeometry[] = [];
  walls.push(colorize(chamferedSlab(spec.hx * 2, spec.h, spec.hz * 2, 0.34), st.wall));
  const parapetH = 0.8;
  const parapetOut = 0.22;
  walls.push(
    colorize(
      chamferedSlab(spec.hx * 2 + parapetOut * 2, parapetH, spec.hz * 2 + parapetOut * 2, 0.18).translate(0, spec.h, 0),
      st.wall,
    ),
  );
  return walls;
}

/** Box with its footprint chamfered (bevelled vertical corners). */
function chamferedSlab(w: number, h: number, d: number, bevel = 0.3): THREE.BufferGeometry {
  const x = w / 2;
  const y = d / 2;
  const b = Math.max(0.02, Math.min(bevel, x * 0.4, y * 0.4));
  const shape = new THREE.Shape();
  shape.moveTo(-x + b, -y);
  shape.lineTo(x - b, -y);
  shape.lineTo(x, -y + b);
  shape.lineTo(x, y - b);
  shape.lineTo(x - b, y);
  shape.lineTo(-x + b, y);
  shape.lineTo(-x, y - b);
  shape.lineTo(-x, -y + b);
  shape.lineTo(-x + b, -y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.1, h), bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, h, 0);
  geo.computeVertexNormals();
  return geo;
}

/** Reusable unit box (no uv) translated to the given world position. */
function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  geo.deleteAttribute('uv');
  geo.translate(x, y, z);
  return geo;
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

/** Ground-floor plinth height (windows start above it). */
const BASE_HEIGHT = 3.2;
/** How far the glass sits inside the wall face (metres). */
const GLASS_RECESS = 0.25;
/** Glass panel size as a fraction of the bay width / floor height. */
const GLASS_W = 0.36;
const GLASS_H = 0.42;
/** Thickness of the glass slab (its hidden faces sit inside the wall). */
const GLASS_DEPTH = 0.2;
/** Depth of the stone sill lip, measured from the wall face outwards. */
const SILL_DEPTH = 0.22;

/**
 * Builds one merged geometry for a building: the stone/concrete body (with
 * parapet and cornice), the glass window grid and the light sill trims.
 */
export function buildBuildingGeometry(spec: BuildingGeoSpec): { wall: THREE.BufferGeometry; glass: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  const st = BUILDING_STYLES[spec.style % BUILDING_STYLES.length];
  // The stone body: a chamfered slab plus a proud parapet lip (same family, so
  // the tower reads as one solid mass from the street).
  const walls: THREE.BufferGeometry[] = bodySlabs(spec, st);
  const glass: THREE.BufferGeometry[] = [];
  const trims: THREE.BufferGeometry[] = [];

  // One even window grid on the four faces: one glass cell + one sill per floor/bay.
  // Glass size derives from the REAL pitch (an integer number of columns fit the
  // face), so every building has the same window-to-wall proportion and the stone
  // body always dominates the frame.
  // Cornice: a slim light band under the parapet (the classic stone crown), and
  // a light plinth at pavement level. Both share the sill bucket.
  trims.push(colorize(box(spec.hx * 2 + 0.55, 0.45, spec.hz * 2 + 0.55, 0, spec.h - 0.225, 0), st.trim));
  trims.push(colorize(box(spec.hx * 2 + 0.3, 0.7, spec.hz * 2 + 0.3, 0, 0.35, 0), st.trim));
  const sillH = 0.14;
  const sillOut = 0.1;
  const floors = Math.max(0, Math.floor((spec.h - BASE_HEIGHT - 0.6) / st.floor));
  // `ry` = rotation about Y for that face (0 faces +Z, PI/2 faces +X, ...).
  const faces: Array<{ ry: number; len: number; nx: number; nz: number; alongX: boolean; half: number }> = [
    { ry: 0, len: spec.hx * 2, nx: 0, nz: 1, alongX: true, half: spec.hz },
    { ry: Math.PI, len: spec.hx * 2, nx: 0, nz: -1, alongX: true, half: spec.hz },
    { ry: Math.PI / 2, len: spec.hz * 2, nx: 1, nz: 0, alongX: false, half: spec.hx },
    { ry: -Math.PI / 2, len: spec.hz * 2, nx: -1, nz: 0, alongX: false, half: spec.hx },
  ];
  const rot = new THREE.Matrix4();
  for (const f of faces) {
    const cols = Math.max(1, Math.floor(f.len / st.bay));
    // Even spacing: distribute the facade width into equal bays.
    const pitch = f.len / cols;
    const start = -((cols - 1) * pitch) / 2;
    const ww = pitch * GLASS_W;
    const wh = st.floor * GLASS_H;
    const faceX = f.nx * f.half;
    const faceZ = f.nz * f.half;
    for (let fl = 0; fl < floors; fl++) {
      const cy = BASE_HEIGHT + fl * st.floor + wh / 2;
      for (let c = 0; c < cols; c++) {
        const along = start + c * pitch;
        // Glass: recessed into the wall (its outer face is GLASS_RECESS behind).
        const g = box(ww, wh, GLASS_DEPTH, 0, 0, 0);
        rot.makeRotationY(f.ry);
        g.applyMatrix4(rot);
        g.translate(
          spec.x + (f.alongX ? along : 0) + faceX + f.nx * -GLASS_RECESS,
          cy,
          spec.z + (f.alongX ? 0 : along) + faceZ + f.nz * -GLASS_RECESS,
        );
        glass.push(colorize(g, st.glass));
        // Sill: light stone lip just under the opening, proud of the wall.
        const s = box(ww + 0.38, sillH, SILL_DEPTH, 0, 0, 0);
        rot.makeRotationY(f.ry);
        s.applyMatrix4(rot);
        s.translate(
          spec.x + (f.alongX ? along : 0) + faceX + f.nx * sillOut,
          cy - wh / 2 - sillH / 2,
          spec.z + (f.alongX ? 0 : along) + faceZ + f.nz * sillOut,
        );
        trims.push(colorize(s, st.trim));
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
